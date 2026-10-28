/**
 * 引用库安全模型（0.4.1）—— 纯实现层。
 *
 * 规范：`docs/引用库安全模型.md`（整段密文模型 / AAD / 分桶 / 计数三处取 max / 烧伤标记 / 状态头）。
 *
 * **本模块刻意只依赖 `node:crypto`**，不 import 本模块之外的任何东西：
 *   ① 它可以被**离线夹具完整覆盖**（不需要 tmux / 不需要宿主）；
 *   ② 它不可能弄坏既有路径（index.js 尚未接它之前，改这个文件对外零影响）。
 *
 * 安全要点（实现时必须保持）：
 *   · 键名、值、maxUses、uses、epoch **全部**在密文内 ⇒ 解密前不可知；
 *   · AAD 绑定 `组名 + epoch + schema 版本` ⇒ 合法密文**不能被搬到别的组/版本**；
 *   · 解密前先**分桶填充** ⇒ 长度与条目数都不可知（残余：桶档位可推断）；
 *   · 全链路以 `Buffer` 承载明文，**不产生中间 string 副本**（Node 无法擦除字符串）；
 *   · 计数读取取**两处最大值** ⇒ 单侧回滚只能让数字变小，另一处保住高值；
 *   · 烧伤标记只存 `entryId` 与**名字 HMAC**，绝不存明文键名。
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync } from 'node:crypto'

export const SCHEMA_V = 2
export const IV_LEN = 12
export const TAG_LEN = 16
export const KEY_LEN = 32
/** 分桶档位：加密前把整组填到"不小于自身的最小档位"⇒ 同桶长度完全一致。 */
export const BUCKETS = [1024, 4096, 16384, 65536]
/** 分桶头：末 4 字节写真实长度（在密文内，解密后才可见）。 */
const LEN_FIELD = 4

/* ── 分桶填充 ─────────────────────────────────────────────────────────── */

export function bucketSizeFor (n) {
  const need = Math.max(0, Math.floor(Number(n) || 0)) + LEN_FIELD
  for (const b of BUCKETS) if (need <= b) return b
  return Math.ceil(need / BUCKETS[BUCKETS.length - 1]) * BUCKETS[BUCKETS.length - 1]
}

/** 明文 → 定长桶缓冲（真实长度写进桶尾）。**返回 Buffer，不返回 string。** */
export function padBucket (buf) {
  const src = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  const size = bucketSizeFor(src.length)
  const out = Buffer.alloc(size)          // 全零底：填充内容不含信息
  src.copy(out, 0)
  out.writeUInt32BE(src.length, size - LEN_FIELD)
  return out
}

/** 桶缓冲 → 明文（还原真实长度）。 */
export function unpadBucket (bucket) {
  const size = bucket.length
  if (size < LEN_FIELD) throw new Error('分桶缓冲过短')
  const n = bucket.readUInt32BE(size - LEN_FIELD)
  if (n > size - LEN_FIELD) throw new Error('分桶长度字段非法（可能被篡改）')
  return bucket.subarray(0, n)
}

/* ── 组序列化：键名 / 值 / 次数 / epoch 全部进 Buffer ──────────────────── */

const enc = (s) => Buffer.from(String(s), 'utf8')

/**
 * `{ group, epoch, keys: { 名: { value, maxUses, uses } } }` → Buffer。
 * 自制分隔序列化：避免 `JSON.stringify` 产生字符串副本（那是不可擦除的）。
 */
export function serializeGroup (g) {
  const name = String(g?.group ?? '')
  const epoch = Number(g?.epoch ?? 0)
  const keys = g?.keys && typeof g.keys === 'object' ? g.keys : {}
  const names = Object.keys(keys)
  const parts = [enc(`V${SCHEMA_V}|G${name}|E${epoch}|N${names.length}`)]
  for (const k of names) {
    const e = keys[k] ?? {}
    const v = Buffer.isBuffer(e.value) ? e.value : enc(e.value ?? '')
    const kb = enc(k)
    parts.push(enc(`|K${kb.length}:`), kb)
    parts.push(enc(`|L${v.length}:`), v)
    // uses 用 JSON 编码：真实条目是数字（0,1,2…）；**假条目是字符串「无效」**（结构上看起来仍是一个字段）
    parts.push(enc(`|M${Number.isFinite(e.maxUses) ? Math.floor(e.maxUses) : -1}|U${JSON.stringify(e.uses ?? 0)}`))
    // 附加字段（kind/note/ttlDays/createdAt/updatedAt…）**必须一起进密文**，否则加密组会静默丢字段
    const xb = enc(JSON.stringify(extrasOf(e)))
    parts.push(enc(`|X${xb.length}:`), xb)
  }
  return Buffer.concat(parts)
}

/** `serializeGroup` 的逆。任何结构异常都抛（上层据此 fail-closed）。 */
/** 条目里"除值/次数/身份之外"的字段（这些不是秘密，允许以 JSON 形式进密文）。 */
/** 真实条目判据：uses 必须是非负整数，且剩余次数 > 0（**剩余 0 是非法值**）。 */
export function isRealEntry (e) {
  // ⚠ 关键：uses **缺失**按 0 计（真实条目，历史数据/调用方可能不写这个字段）；
  //   只有"非数字"（假条目的字符串标记「无效」）才算假条目 —— 否则写盘会静默丢真实数据。
  const uses = e?.uses === undefined || e?.uses === null ? 0 : e.uses
  if (!Number.isInteger(uses) || uses < 0) return false
  const max = e?.maxUses
  if (!Number.isFinite(max)) return true                 // 无限次（-1 或未设）⇒ 只要 uses 合法即可
  if (max < 0) return true
  return max - uses > 0
}

/**
 * 生成**假条目**：混进加密前的明文里，使密文中"条目数量与分布"不再等于真实秘密的数量。
 * 结构上必须与真实条目一致（同样的字段、键名形态、值形态），唯一区别是 `uses` 写的是字符串「无效」
 * —— 这正是显示过滤的判据（真实条目的 uses 永远是非负整数）。
 */
export function makeDecoys (count, rnd = randomBytes) {
  const n = Math.max(0, Math.floor(Number(count) || 0))
  const out = {}
  for (let i = 0; i < n; i++) {
    const kb = rnd(6).toString('base64url').slice(0, 8)
    const vb = rnd(18).toString('base64')
    out['k' + kb] = {
      value: vb,
      uses: '无效',                                        // ← 假条目标记（字符串，非数字）
      maxUses: -1,
      updatedAt: Date.now() - Math.floor(Math.random() * 86400000)
    }
  }
  return out
}

export function extrasOf (e) {
  const x = { ...(e ?? {}) }
  for (const k of ['value', 'maxUses', 'uses', 'group', 'remaining', 'oneShot']) delete x[k]
  return x
}

export function deserializeGroup (buf) {
  const s = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  const kAt = s.indexOf(Buffer.from('|K'))
  if (kAt < 0) throw new Error('组缓冲缺少键段')
  const header = s.subarray(0, kAt).toString('latin1')            // 头部不含秘密，转字符串安全
  const m = /^V(\d+)\|G([^|]*)\|E(\d+)\|N(\d+)$/.exec(header)
  if (m === null) throw new Error('组缓冲头部非法')
  const out = { group: m[2], epoch: Number(m[3]), keys: {} }
  const readToken = (from, re) => {
    const probe = s.subarray(from, Math.min(s.length, from + 64)).toString('latin1')
    const mm = re.exec(probe)
    if (mm === null) throw new Error('组缓冲字段非法（可能被篡改）')
    return { m: mm, next: from + Buffer.byteLength(mm[0], 'latin1') }
  }
  let at = kAt
  for (let i = 0; i < Number(m[4]); i++) {
    const k = readToken(at, /^\|K(\d+):/)
    at = k.next
    const klen = Number(k.m[1])
    const name = s.subarray(at, at + klen).toString('utf8')       // 键名需要可当字符串用（见诚实边界）
    at += klen
    const l = readToken(at, /^\|L(\d+):/)
    at = l.next
    const vlen = Number(l.m[1])
    const value = Buffer.from(s.subarray(at, at + vlen))          // 独立拷贝，便于后续覆写
    at += vlen
    const mu = readToken(at, /^\|M(-?\d+)\|U((-?\d+)|("(?:[^"\\]|\\.){0,40}"))/)
    at = mu.next
    const maxUses = Number(mu.m[1])          // -1 = 无限次（约定值，不从 0 区分）
    let extras = {}
    if (s[at] === 0x7c && s[at + 1] === 0x58) {              // '|X' 可选（向后兼容）
      const x = readToken(at, /^\|X(\d+):/)
      at = x.next
      const xlen = Number(x.m[1])
      try { extras = JSON.parse(s.subarray(at, at + xlen).toString('utf8')) ?? {} } catch { extras = {} }
      at += xlen
    }
    let uses = 0
    try { uses = JSON.parse(mu.m[2]) } catch { uses = 0 }
    out.keys[name] = { value, maxUses, uses, ...extras }
  }
  if (at > s.length) throw new Error('组缓冲越界')
  return out
}

/* ── AAD：上下文绑定 ───────────────────────────────────────────────────── */

/** 绑定 `组名 + epoch + schema 版本` ⇒ 防跨组/跨版本搬运合法密文。 */
export function aadOf (group, epoch) {
  return enc(`dsh-vault|v${SCHEMA_V}|${String(group ?? '')}|${Number(epoch ?? 0)}`)
}

/* ── KEK 派生（只在解锁时跑一次；不要 per-send 派生）──────────────────── */

export function newSalt () { return randomBytes(16).toString('base64') }
export function deriveKek (passphrase, saltB64, { N = 16384, r = 8, p = 1, keylen = KEY_LEN, pepper = null } = {}) {
  const pw = Buffer.isBuffer(passphrase) ? passphrase : enc(passphrase ?? '')
  const base = scryptSync(pw, Buffer.from(String(saltB64), 'base64'), keylen, { N, r, p })
  if (pepper === null || pepper === undefined) return base
  return mixPepper(base, pepper).subarray(0, keylen)
}

/** 已派生的口令 KEK 再与设备 pepper 组合（用于旧组迁移，无需重新输入口令）。 */
export function mixPepper (kek, pepper) {
  if (!Buffer.isBuffer(kek) || kek.length !== KEY_LEN) throw new Error('KEK 长度必须 32 字节')
  if (!Buffer.isBuffer(pepper) || pepper.length !== KEY_LEN) throw new Error('vault pepper 长度必须 32 字节')
  // 组合而非替换：口令段熵不足时，未知的 pepper 仍让“只拿到 vault.json”的爆破不可行。
  return createHmac('sha256', pepper).update(kek).digest()
}

/* ── 封 / 开（AES-256-GCM）─────────────────────────────────────────────── */

/** 明文 Buffer（调用方应先 `padBucket`）→ `{ ciphertext, iv, tag }`（全 b64）。 */
export function sealGroup (plainBuf, kek, aad, iv = randomBytes(IV_LEN)) {
  if (!Buffer.isBuffer(kek) || kek.length !== KEY_LEN) throw new Error('KEK 长度必须 32 字节')
  const c = createCipheriv('aes-256-gcm', kek, iv)
  if (aad) c.setAAD(Buffer.isBuffer(aad) ? aad : enc(aad))
  const ct = Buffer.concat([c.update(Buffer.isBuffer(plainBuf) ? plainBuf : Buffer.from(plainBuf)), c.final()])
  return { ciphertext: ct.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64') }
}

/**
 * 解封。**任何一位被改（密文/IV/tag）或 AAD 不符 ⇒ 抛错**（不是返回乱码）。
 * 上层据此 fail-closed：拒绝引用/编辑。
 */
export function openGroup (sealed, kek, aad) {
  if (!Buffer.isBuffer(kek) || kek.length !== KEY_LEN) throw new Error('KEK 长度必须 32 字节')
  const d = createDecipheriv('aes-256-gcm', kek, Buffer.from(String(sealed?.iv ?? ''), 'base64'))
  if (aad) d.setAAD(Buffer.isBuffer(aad) ? aad : enc(aad))
  d.setAuthTag(Buffer.from(String(sealed?.tag ?? ''), 'base64'))
  const pt = Buffer.concat([d.update(Buffer.from(String(sealed?.ciphertext ?? ''), 'base64')), d.final()])
  return unpadBucket(pt)
}

/* ── 计数：三处结构取最大值 ───────────────────────────────────────────── */

/** `uses = max(密文内, 计数文件内)` ⇒ 单侧回滚只能变小，另一侧保住高值。 */
export function usesOf (ctUses, fileUses) {
  return Math.max(Math.max(0, Math.floor(Number(ctUses) || 0)), Math.max(0, Math.floor(Number(fileUses) || 0)))
}
/** 剩余次数；`maxUses` 缺省（undefined/负数）⇒ 无限次，返回 null。 */
export function remainingOf (maxUses, uses) {
  if (!Number.isFinite(maxUses) || Number(maxUses) < 0) return null
  return Math.max(0, Math.floor(Number(maxUses)) - Math.max(0, Math.floor(Number(uses) || 0)))
}

/* ── 烧伤标记（不含明文键名）───────────────────────────────────────────── */

/** 名字指纹：带密钥、不可逆 ⇒ 既能提示"这个名字曾被销毁"，又不泄露名字。 */
export function nameHmac (kfp, name) {
  return createHmac('sha256', Buffer.isBuffer(kfp) ? kfp : enc(kfp ?? ''))
    .update(enc(name ?? '')).digest('base64')
}

/** 是否命中烧伤表（按 entryId **或** 名字指纹命中）。 */
export function burnedOf (burnedList, { entryId, nameH } = {}) {
  const list = Array.isArray(burnedList) ? burnedList : []
  return list.find((b) => (entryId !== undefined && b?.entryId === entryId) ||
    (nameH !== undefined && b?.nameHmac === nameH)) ?? null
}

/* ── 状态头（B 方案）：恒定体积、O(1)、零增长、可自愈 ──────────────────── */

export function headFp (vaultBytes) {
  const b = Buffer.isBuffer(vaultBytes) ? vaultBytes : Buffer.from(vaultBytes ?? '')
  return createHash('sha256').update(b).digest('base64')
}

/**
 * 判定（规范 §4 三分表）。返回值：
 *   'ok'       一致 ⇒ 正常
 *   'heal'     vault 更新（崩溃窗口）⇒ 接受并补写头
 *   'rollback' vault 更旧 ⇒ **拒绝**
 *   'tamper'   同序号不同内容 ⇒ **拒绝**
 *   'nohead'   状态头缺失/损坏 ⇒ **fail-closed 拒绝**
 */
export function judgeHead ({ vaultSeq, vaultFp, head }) {
  if (head === null || head === undefined || !Number.isFinite(Number(head?.seq))) return 'nohead'
  const seq = Math.floor(Number(vaultSeq) || 0)
  const headSeq = Math.floor(Number(head.seq))
  if (seq === headSeq) return String(vaultFp) === String(head.fp) ? 'ok' : 'tamper'
  return seq > headSeq ? 'heal' : 'rollback'
}

/** fail-closed 文案：**一律不含键名/值**，且**不提供"是否继续"**。 */
export function verdictText (v) {
  switch (v) {
    case 'ok': return ''
    case 'heal': return '引用库状态头已补写（上次写入未完成，已自动恢复）'
    case 'rollback': return 'REFUSED — 引用库文件比状态头更旧（可能被回滚），已拒绝使用；请人工确认'
    case 'tamper': return 'REFUSED — 引用库内容与状态头不一致（可能被篡改），已拒绝使用；请人工确认'
    case 'nohead': return 'REFUSED — 引用库状态头缺失或损坏，无法判断是否被回滚；请人工确认'
    default: return 'REFUSED — 引用库状态未知'
  }
}

/** 供 UI/审计显示：短指纹（8–16 字符），不含任何秘密。 */
export function shortFp (fp, n = 12) { return String(fp ?? '').slice(0, Math.max(8, Math.min(16, n))) }