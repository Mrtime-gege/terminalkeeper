/**
 * 引用库安全模型（0.4.1）—— 持久化层：原子 I/O + 状态头 + 计数/烧伤存储。
 *
 * 规范：`docs/引用库安全模型.md` §3（计数三处取 max）、§4（状态头 B 方案）、§5（擦除）。
 *
 * 设计要点：
 *   · **O(1) 读取**：判定只需「读一次 vault + 读一次状态头 + 读一次计数小文件」，与历史长度无关；
 *   · **顺序不变式**：写 vault **先**、写状态头**后**（颠倒会制造"假拒绝"）；
 *   · **崩溃自愈**：vault 比状态头新（`heal`）⇒ 接受 vault 并补写头；
 *   · **计数偏安全侧**：计数文件允许比密文新（多记一次消耗），因此这两处不需要定死先后；
 *   · **零增长**：状态头恒定体积、计数文件只随**条目数**增长（不随使用次数）；
 *   · 全流程 `0600` + 同目录临时文件 + `fsync` + `rename` 原子替换。
 */
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync,
  unlinkSync, writeSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { headFp, judgeHead, shortFp, verdictText } from './vault.mjs'

// 便于上层与夹具直接复用（避免各处重复 import vault.mjs）
export { headFp, shortFp, verdictText }

export const HEAD_V = 1
export const USES_V = 1

/* ── 原子 I/O ─────────────────────────────────────────────────────────── */

/** 同目录临时文件 → 写入 → fsync → rename；可选对旧文件做**多轮覆写**（§5 最佳努力擦除）。 */
export function writeAtomicSync (path, buf, { mode = 0o600, wipeOld = false, passes = 3 } = {}) {
  const dir = dirname(path)
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }) } catch { /* 已存在 */ }
  const tmp = join(dir, `.${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.tmp`)
  const fd = openSync(tmp, 'w', mode)
  try {
    const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
    let off = 0
    while (off < data.length) off += writeSync(fd, data, off, data.length - off)
    fsyncSync(fd)
  } finally { closeSync(fd) }
  if (wipeOld && existsSync(path)) wipeFileSync(path, passes)          // 旧文件先覆写再交给 rename 覆盖
  renameSync(tmp, path)
  try { const dfd = openSync(dir, 'r'); fsyncSync(dfd); closeSync(dfd) } catch { /* 尽力 */ }
  return { path, bytes: (Buffer.isBuffer(buf) ? buf : Buffer.from(buf)).length }
}

/** 最佳努力擦除：多轮覆写文件内容后删除。**不等于物理擦除**（见规范 §5 诚实边界）。 */
export function wipeFileSync (path, passes = 3, chunk = 64 * 1024) {
  if (!existsSync(path)) return false
  let size = 0
  try { size = statSync(path).size } catch { return false }
  if (size === 0) { try { unlinkSync(path) } catch { /* 忽略 */ } return true }
  for (let p = 0; p < Math.max(1, passes); p++) {
    const fd = openSync(path, 'r+')
    try {
      const block = Buffer.alloc(Math.min(chunk, size), p % 2 === 0 ? 0x00 : 0xff)
      let off = 0
      while (off < size) {
        const n = Math.min(block.length, size - off)
        writeSync(fd, block, 0, n, off)
        off += n
      }
      fsyncSync(fd)
    } finally { closeSync(fd) }
  }
  try { unlinkSync(path) } catch { /* 忽略 */ }
  return true
}

export function readMaybe (path) {
  try { return existsSync(path) ? readFileSync(path) : null } catch { return null }
}

/* ── 状态头（恒定体积、零增长）──────────────────────────────────────────── */

export function headBytes ({ seq, fp }) {
  return Buffer.from(JSON.stringify({ v: HEAD_V, seq: Math.floor(Number(seq) || 0), fp: String(fp ?? '') }), 'utf8')
}

export function readHead (path) {
  const b = readMaybe(path)
  if (b === null) return null
  try {
    const o = JSON.parse(b.toString('utf8'))
    if (Number(o?.v) !== HEAD_V || !Number.isFinite(Number(o?.seq)) || typeof o?.fp !== 'string') return null
    return { seq: Math.floor(Number(o.seq)), fp: o.fp }
  } catch { return null }                                            // 损坏 ⇒ 视同缺失（fail-closed）
}

export function writeHead (path, { seq, fp }) {
  return writeAtomicSync(path, headBytes({ seq, fp }), { wipeOld: true })
}

/* ── 计数小文件（只随条目数增长；就地覆盖）────────────────────────────── */

export function usesBytes (state) {
  const uses = state?.uses && typeof state.uses === 'object' ? state.uses : {}
  const burned = Array.isArray(state?.burned) ? state.burned : []
  return Buffer.from(JSON.stringify({ v: USES_V, uses, burned }), 'utf8')
}

export function readUses (path) {
  const b = readMaybe(path)
  if (b === null) return { uses: {}, burned: [] }
  try {
    const o = JSON.parse(b.toString('utf8'))
    return {
      uses: o?.uses && typeof o.uses === 'object' ? o.uses : {},
      burned: Array.isArray(o?.burned) ? o.burned : []
    }
  } catch { return { uses: {}, burned: [] } }
}

export function writeUses (path, state) {
  return writeAtomicSync(path, usesBytes(state), { wipeOld: true })
}

/* ── vault 外壳（seq 是明文头部；密文组在 groups 内）──────────────────── */

/** 从 vault 字节里取 `seq`（明文头部；**不含任何秘密**，仅用于与状态头比对）。 */
export function vaultSeqOf (bytes) {
  if (bytes === null || bytes === undefined) return 0
  try {
    const o = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes))
    return Math.floor(Number(o?.seq) || 0)
  } catch { return 0 }
}

/* ── 高层：O(1) 加载 + 顺序不变式提交 ─────────────────────────────────── */

/**
 * 读 vault + 状态头 + 计数文件，给出判定。**成本 O(1)**（不遍历历史、不扫日志）。
 * 返回 `{ verdict, text, seq, fp, uses, burned, bytes, ok }`；`ok=false` 时上层必须 fail-closed。
 */
export function loadState ({ vaultPath, headPath, usesPath }) {
  const bytes = readMaybe(vaultPath)
  const head = readHead(headPath)
  const { uses, burned } = readUses(usesPath)
  if (bytes === null) {                                              // 首次运行：无文件 ⇒ 视为初始态
    return { ok: true, verdict: 'fresh', text: '', seq: 0, fp: '', uses, burned, bytes: null }
  }
  const seq = vaultSeqOf(bytes)
  const fp = headFp(bytes)
  const verdict = judgeHead({ vaultSeq: seq, vaultFp: fp, head })
  return { ok: verdict === 'ok' || verdict === 'heal', verdict, text: verdictText(verdict), seq, fp, uses, burned, head, bytes }
}

/**
 * 提交：**vault 先、状态头后**（顺序不变式）。`heal` 场景由调用方直接用现有 vault + 新头提交。
 * 返回 `{ seq, fp, shortFp }` 供通知/审计显示。
 */
export function commitState ({ vaultPath, headPath, bytes, seq }) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? '')
  const n = Math.floor(Number(seq) || 0)
  writeAtomicSync(vaultPath, buf, { wipeOld: true })                 // ① vault
  const fp = headFp(buf)
  writeHead(headPath, { seq: n, fp })                                // ② 头
  return { seq: n, fp, shortFp: shortFp(fp) }
}