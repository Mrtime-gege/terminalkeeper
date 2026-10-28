/**
 * 引用库安全模型（0.4.1）—— **适配层**：磁盘 v2 外壳 ⇄ 内存扁平 map。
 *
 * 规范：`docs/引用库安全模型.md`。本模块是「加密只插在 readVault/writeVault 之下」的落点。
 *
 * **为什么是独立模块 + 注入式文件操作**：
 *   · 上层（`expandForSend` / `applyRefs` / `maskVaultLine` / 面板 / 记账）不需要任何改动 ——
 *     它们看到的一直是**扁平 map** `{键: {value, oneShot, uses, maxUses, group}}`；
 *   · 注入 `fs` 后可以在**临时目录**上离线跑完整夹具（不碰真实 vault ✓）。
 *
 * **磁盘布局**（`dir` 下）：
 *   · `vault.json`        v2 外壳：`{version:2, seq, groups:{组:{mode, epoch, kdf?, plain?|sealed?}}}`
 *                         老版本是**扁平 map**（v1），读到即**内存迁移**，首次写入才落成 v2；
 *   · `vault.head.json`   状态头（§4）：恒定体积 `{v,seq,fp}` —— **不复用 `anchor.json`**，
 *                         因为后者已属于审计链的每日链头，混写会互相覆盖；
 *   · `vault.uses.json`   计数 + 烧伤（§3）：`{v, uses:{entryId:次数}, burned:[…]}`
 *
 * **安全不变式（实现必须保持）**：
 *   ① 锁定组（mode≠none 且未解锁）的键**绝不出现在 map 里** ⇒ 引用自然 fail-closed，且不泄露键名；
 *   ② **锁定组写回时若拿不到 KEK ⇒ 拒绝写该组**，保留旧密文（绝不能因为"看不见"就把数据抹掉）；
 *   ③ 判定不通过（rollback/tamper/nohead）⇒ 一律拒绝（返回空 map + 提示），绝不静默降级；
 *   ④ 老库（v1）默认迁移为 `mode:'none'`（**落盘不加密**，行为不变），并只发**一条通知**。
 */
import { deserializeGroup, aadOf, deriveKek, mixPepper, isRealEntry, makeDecoys, newSalt, openGroup, padBucket, sealGroup, serializeGroup, shortFp, burnedOf, nameHmac, remainingOf, usesOf } from './vault.mjs'
import { ensureDeviceKey, rotateDeviceKey, OBF_MODE } from './obfuscate.mjs'
import { ensureVaultPepper, PEPPER_FILE } from './vault-pepper.mjs'
import { commitState, headFp, loadState, readUses, writeHead, writeUses, wipeFileSync } from './statehead.mjs'
import { renameSync as require$renameSync, writeFileSync as require$writeFileSync } from 'node:fs'

// 内部 id 固定为 'default'（**不做数据迁移**）；面板显示名用 DEFAULT_GROUP_LABEL。
// 「默认引用组」**始终存在**（新装插件即可用；用户不选组时新键值对进这里）。
const DEFAULT_GROUP = 'default'
const DEFAULT_GROUP_LABEL = '默认引用组'
// **默认引用组也是一个引用组**，但是一个**属性不可修改**的特殊组：
//   它的本质 = 「不加密 + 落盘」的引用组（mode: none, persist: true），且不可改名/改模式/删除。
// 这样即使 UI 有漏洞，数据层也拦得住；其它组仍可自由选择「不加密 / 口令加密」。
const DEFAULT_GROUP_ATTRS = { mode: 'none', persist: true, immutable: true }
function isDefaultGroup (g) { return String(g ?? '') === DEFAULT_GROUP }

export function createVaultIo ({ dir, fs }) {
  // 读到旧格式（v1 扁平表）后置位：此后**一切写回都拒绝** —— 不静默迁移、不覆盖旧数据（彻底去兼容）
  let legacySeen = false
  const { readText, writeText, rename, unlink, exists } = fs
  const paths = {
    vault: `${dir}/vault.json`,
    head: `${dir}/vault.head.json`,
    uses: `${dir}/vault.uses.json`,
    pepper: `${dir}/${PEPPER_FILE}`
  }
  /** 组名 → KEK（**只在内存**；锁定即删除；进程退出即消失）。 */
  const keks = new Map()
  /** 混淆组被**显式加密（隐藏）**的集合：只在内存。
   *  为什么需要它：混淆组默认会自动解开（设备密钥本地可得），若只用 keks 做锁定标记，
   *  下一次 loadFlat 会立刻重新解开 ⇒ 操作列的「加密」按钮形同虚设（夹具已抓到这点）。 */
  const obfHidden = new Set()
  /** 「不落盘」组的内存态：定义与键值对只活在本次运行里（重启即消失）。
   *  必须自己存：loadFlat 会 defs.clear() 并按磁盘重建，不另存就【连本次运行内都读不到】
   *  （夹具 ⑱ 抓到过这一点）。 */
  const memDefs = new Map()
  // 已删除组的墓碑（goneGroups）：写入与刷新都必须跳过它。
  // 缺了它：storeFlat 会从旧文件把组"保留"回来、refreshDefs 又会从磁盘把它导回 defs
  // ⇒ 已落盘的组永远删不掉（用户实报：删除后刷新依旧显示）。
  const goneGroups = new Set()
  const memKeys = new Map()
  /** 组名 → { mode, kdf }（已从磁盘读到的组定义）。 */
  const defs = new Map()
  let note = ''
  let notified = false
  let lastSeq = 0
  /** 口令组的设备 pepper（第二密钥）；只防“只泄露 vault.json”的离线爆破。
   *  同权限读数据目录仍可拿到它 —— 文档必须如实说明，不能当成对抗 AI 的边界。 */
  let pepperCache = null

  async function vaultPepper ({ create = true } = {}) {
    if (pepperCache !== null) return pepperCache
    pepperCache = ensureVaultPepper(dir, { create }).key
    return pepperCache
  }

  /** 按 kdf 记录派生 KEK；pepper 缺失/损坏时抛错（fail-closed，绝不回退到弱 KEK）。 */
  async function kekFor (passphrase, kdf, { createPepper = false } = {}) {
    const pepper = kdf?.pepper === true ? await vaultPepper({ create: createPepper }) : null
    return deriveKek(passphrase, kdf?.salt ?? '', {
      N: Number(kdf?.N) || 16384,
      r: Number(kdf?.r) || 8,
      p: Number(kdf?.p) || 1,
      pepper,
    })
  }

  function newPassphraseKdf (prevKdf) {
    return {
      algo: 'scrypt', N: 16384, r: 8, p: 1,
      salt: prevKdf?.salt ?? newSalt(),
      pepper: true,
    }
  }

  const setNote = (t) => { note = String(t ?? '') }
  const readMaybe = async (p) => { try { return await readText(p, 'utf8') } catch { return null } }
  const writeAtomic = async (p, text) => {
    const tmp = p + '.' + process.pid + '.tmp'
    try { await writeText(tmp, text, { mode: 0o600 }); await rename(tmp, p) } catch (e) {
      try { await unlink(tmp) } catch { /* 清理失败忽略 */ }
      throw e
    }
  }

  function flattenGroup (keys, group) {
    const flat = {}
    for (const [k, e] of Object.entries(keys)) {
      if (isRealEntry(e) !== true) continue                           // **显示过滤**：假条目与"剩余 0"非法值一律不显示
      const maxUses = Number.isFinite(Number(e.maxUses)) ? Number(e.maxUses) : (e.oneShot === true ? 1 : -1)
      const uses = Math.max(0, Number(e.uses ?? 0) || 0)
      flat[k] = {
        ...e,                                                  // **保留附加字段**（kind/note/ttlDays/createdAt…）
        value: typeof e.value === 'string' ? e.value : Buffer.isBuffer(e.value) ? e.value.toString('utf8') : String(e.value ?? ''),
        oneShot: maxUses === 1,
        maxUses,
        uses,
        remaining: (maxUses === -1 || !Number.isFinite(maxUses)) ? -1 : remainingOf(maxUses, uses),   // -1 = 无限
        group
      }
    }
    return flat
  }

  /* ── 读：磁盘 → 扁平 map（fail-closed）────────────────────────────────── */

  async function loadFlat () {
    const raw = await readMaybe(paths.vault)
    if (raw === null) { setNote(''); return { flat: {}, verdict: 'fresh', seq: 0, groupInfo: [] } }
    const st = loadState({ vaultPath: paths.vault, headPath: paths.head, usesPath: paths.uses })
    lastSeq = st.seq
    if (st.ok !== true) {
      // 老库（v1 扁平 map）**天然没有状态头** ⇒ 视为首次迁移：接受并初始化状态头 ✓
      // 但 **v2 缺头/回滚/篡改** ⇒ 一律 fail-closed 拒绝（绝不静默降级），否则"删掉头"就能绕过防护。
      const isV1 = (() => { try { const o = JSON.parse(raw); return o?.version !== 2 || o.groups === null || typeof o.groups !== 'object' } catch { return false } })()
      if (!(st.verdict === 'nohead' && isV1)) {
        setNote(st.text)
        return { flat: {}, verdict: st.verdict, seq: st.seq, groupInfo: groups() }
      }
      // v1 + 缺头：补写初始状态头后继续（这就是规范 §4 的"首个快照之前"）
      try { await writeHead(paths.head, { seq: st.seq, fp: st.fp }) } catch { /* 下次再补 */ }
    }
    if (st.verdict === 'heal') {                              // 崩溃窗口 ⇒ 顺手补写状态头（自愈）
      try { await writeHead(paths.head, { seq: st.seq, fp: st.fp }) } catch { /* 下次再补 */ }
    }
    let obj = null
    try { obj = JSON.parse(raw) } catch { setNote('REFUSED — 引用库文件不是合法 JSON，已拒绝使用；请人工确认'); return { flat: {}, verdict: 'badjson', seq: st.seq, groupInfo: [] } }
    if (obj === null || typeof obj !== 'object') return { flat: {}, verdict: 'badshape', seq: st.seq, groupInfo: [] }
    if (obj.version !== 2 || obj.groups === null || typeof obj.groups !== 'object') {
      legacySeen = true                       // 之后一律拒绝写回（不迁移、不覆盖旧数据）
      setNote('REFUSED：此引用库是旧格式（v1 扁平表），本版本起不再兼容。请备份 ~/.dsh/terminalkeeper/vault.json 后删除它，再重新录入。')
      return { flat: {}, verdict: 'legacy', seq: 0, groupInfo: groups() }
    }
    defs.clear()
    const flat = {}
    for (const [g, spec] of Object.entries(obj.groups)) {
      const mode = modeOf(spec)
      if (goneGroups.has(g) !== true) defs.set(g, { mode, kdf: spec?.kdf })   // 墓碑组不回填
      if (mode === 'none') {
        Object.assign(flat, flattenGroup(spec?.plain?.keys ?? {}, g))
        continue
      }
      let kek = keks.get(g)
      if (kek === undefined && mode === OBF_MODE && obfHidden.has(g) !== true) { kek = await obfKey(); keks.set(g, kek) }   // 混淆组：设备密钥本地可得 ⇒ 启动即解密
      if (kek === undefined) continue                         // ①锁定 ⇒ 键不出现（fail-closed）
      try {
        const pt = openGroup(spec.sealed, kek, aadOf(g, Number(spec.epoch ?? 0)))
        Object.assign(flat, flattenGroup(deserializeGroup(pt).keys, g))
      } catch {
        setNote(`REFUSED — ${g} 组解密失败（内容被改或口令不对），已拒绝该组；请人工确认`)
      }
    }
    for (const [g, d] of memDefs.entries()) if (goneGroups.has(g) !== true) defs.set(g, d)
    for (const [g, keys] of memKeys.entries()) Object.assign(flat, flattenGroup(keys, g))
    setNote('')
    return { flat, verdict: 'ok', seq: st.seq, groupInfo: groups() }
  }

  /** 引用组模式：none（明文落盘）/ obfuscate（简单混淆：设备固定密钥）/ passphrase（口令加密）*/
  const MODES = ['none', OBF_MODE, 'passphrase', 'keychain']
  function modeOf (spec) { return MODES.includes(spec?.mode) ? spec.mode : 'none' }

  /** 设备密钥（惰性生成一次；只在内存缓存）。⚠ 混淆不是安全机制，只防明文落盘与全盘关键词命中。
   *  这里用真实 fs（不是注入的异步 fs）：device.key 是插件自有产物，写在数据目录里即可。 */
  let obfKeyCache = null
  async function obfKey () {
    if (obfKeyCache !== null) return obfKeyCache
    obfKeyCache = ensureDeviceKey(dir).key
    return obfKeyCache
  }

  /**
   * 手动重新生成设备密钥（满足"密钥生成后永远唯一 / 可手动重生成"）：
   * 先按当前内存 KEK 读出所有**混淆组**的键值对，再轮换密钥，然后用新密钥重新封存并落盘。
   * 安全边界：口令加密组若处于锁定态，storeFlat 会原样保留其密文（不会因轮换而损坏）。
   */
  async function rotateObfKey () {
    const st = await loadFlat()
    // 只对**硬拒绝**（旧格式/坏 JSON/坏结构）拒绝轮换；nohead/heal 属可自愈状态，不应阻塞
    if (['legacy', 'badjson', 'badshape'].includes(st.verdict)) {
      return { ok: false, note: '引用库当前不可用（' + st.verdict + '），已拒绝轮换以策安全' }
    }
    const obfGroups = [...defs.entries()].filter(([, d]) => d?.mode === OBF_MODE).map(([g]) => g)
    if (obfGroups.length === 0) return { ok: false, note: '当前没有「简单混淆」组，无需重新生成设备密钥' }
    const rotated = rotateDeviceKey(dir)
    obfKeyCache = rotated.key
    for (const g of obfGroups) keks.set(g, rotated.key)
    const saved = await storeFlat(st.flat)
    if (saved.ok !== true) return { ok: false, note: '重新封存失败：' + String(saved.note ?? '') }
    return { ok: true, keyFp: rotated.kfp, groups: obfGroups, note: `已重新生成设备密钥并用新密钥重新封存 ${obfGroups.length} 个混淆组（指纹 ${rotated.kfp}）` }
  }

  /** 设备密钥指纹（诊断展示用） */
  async function deviceKeyFingerprint () {
    const k = await obfKey()
    const { keyFingerprint } = await import('./obfuscate.mjs')
    return keyFingerprint(k)
  }

  /** 组状态（用户模型）：加密态 locked / 解密态 unlocked；none 与 obfuscate 恒为 unlocked */
  async function groupStates () {
    const out = {}
    for (const [g, d] of defs.entries()) {
      const mode = d?.mode ?? 'none'
      const locked = mode === 'passphrase' ? !keks.has(g) : (mode === OBF_MODE ? obfHidden.has(g) : false)
      out[g] = { mode, state: locked ? 'locked' : 'unlocked' }
    }
    return out
  }

  /* ── 写：扁平 map → 磁盘 v2（锁定组拒绝覆写）──────────────────────────── */

  async function storeFlat (flat) {

  if (legacySeen) {

    // 旧格式库：拒绝任何写入（否则会用新 v2 覆盖用户旧数据 —— 既不迁移也不破坏）

    return { ok: false, note: 'REFUSED：此引用库为旧格式（v1 扁平表），本版本起不再兼容；请备份 vault.json 后删除它再重新录入' }

  }

    const noPersist = new Set([...defs.entries()].filter(([, d]) => d?.persist === false).map(([g]) => g))
    const byGroup = new Map()
    for (const [k, e] of Object.entries(flat ?? {})) {
      const gOf = typeof e?.group === 'string' && e.group !== '' ? e.group : DEFAULT_GROUP
      if (noPersist.has(gOf)) {
        if (isRealEntry(e) === true) {
          const bucket = memKeys.get(gOf) ?? {}
          const maxUses = Number.isFinite(Number(e?.maxUses)) ? Number(e.maxUses) : (e?.oneShot === true ? 1 : undefined)
          bucket[k] = { ...(e ?? {}), value: String(e?.value ?? ''), maxUses, uses: Math.max(0, Number(e?.uses ?? 0) || 0) }
          delete bucket[k].remaining; delete bucket[k].group
          memKeys.set(gOf, bucket)
        }
        continue
      }
      const g = typeof e?.group === 'string' && e.group !== '' ? e.group : DEFAULT_GROUP
      if (!byGroup.has(g)) byGroup.set(g, {})
      const keys = byGroup.get(g)
      const maxUses = Number.isFinite(Number(e?.maxUses)) ? Number(e.maxUses) : (e?.oneShot === true ? 1 : undefined)
      if (isRealEntry(e) !== true) continue                          // 假条目/非法条目（剩余 0）不参与落盘
      keys[k] = {
        ...(e ?? {}),                                          // **保留附加字段**，否则加密组会静默丢字段
        value: String(e?.value ?? ''),
        maxUses,
        uses: Math.max(0, Number(e?.uses ?? 0) || 0)
      }
      delete keys[k].remaining                                 // 派生字段不落盘
      delete keys[k].group
    }
    const prev = await readVaultEnvelope()                     // 保留未在 map 里出现的组（尤其锁定组）
    const groups = {}
    const epochOf = {}
    for (const [g, spec] of prev.groups) {
      if (goneGroups.has(g)) continue   // 已删除的组：不要再从旧文件保留回来
      const mode = defs.get(g)?.mode ?? spec.mode ?? 'none'
      const keys = byGroup.get(g)
      if (mode !== 'none') {
        const kek = keks.get(g)
        if (kek === undefined) {                               // ②拿不到 KEK ⇒ 原样保留旧密文，绝不抹掉
          groups[g] = spec
          epochOf[g] = Number(spec.epoch ?? 0)
          setNote(`⚠ ${g} 组处于锁定态，本次未改动它的内容（保留原密文）`)
          continue
        }
        const epoch = Number(spec.epoch ?? 0) + 1
        let nextKek = kek
        let kdf = defs.get(g)?.kdf ?? spec.kdf
        if (mode === 'passphrase' && kdf?.pepper !== true) {
          const pepper = await vaultPepper({ create: true })
          nextKek = mixPepper(kek, pepper)
          kdf = { ...(kdf ?? newPassphraseKdf()), salt: kdf?.salt ?? '', pepper: true }
          keks.set(g, nextKek)
          defs.set(g, { ...(defs.get(g) ?? {}), kdf })
        }
        groups[g] = { mode, epoch, kdf, sealed: sealFromKeys(keys ?? {}, nextKek, aadOf(g, epoch), g, epoch) }
        epochOf[g] = epoch
        continue
      }
      const epoch = Number(spec.epoch ?? 0) + 1
      // 不加密组**始终可见** ⇒ 内存 map 就是权威：未提到该组（key 为 undefined）= 组内已无键值对 ⇒ 写空。
      // （只有加密/锁定组才需要保留旧内容 —— 那是因为它们的键值对根本没进 map。）
      groups[g] = { mode: 'none', epoch, plain: { keys: keys ?? {} } }
      epochOf[g] = epoch
    }
    for (const g of defs.keys()) {                             // 空组也要落盘（否则建完组刷新就丢）
      if (goneGroups.has(g)) continue                      // 已删除的组不得再写回磁盘
      if (groups[g] !== undefined) continue
      if (byGroup.has(g)) continue                             // **有键值对的组交给下面的循环**，否则会把密文写成空
      if (defs.get(g)?.mode !== 'none') {
        const kek = keks.get(g)
        if (kek === undefined) { groups[g] = { mode: defs.get(g)?.mode ?? 'none', epoch: 1, kdf: defs.get(g)?.kdf ?? newPassphraseKdf(), sealed: sealFromKeys({}, kek ?? Buffer.alloc(32), aadOf(g, 1), g, 1) }; epochOf[g] = 1; continue }
        groups[g] = { mode: defs.get(g)?.mode ?? 'passphrase', epoch: 1, kdf: defs.get(g)?.kdf ?? newPassphraseKdf(), sealed: sealFromKeys({}, kek, aadOf(g, 1), g, 1) }
        epochOf[g] = 1
        continue
      }
      groups[g] = { mode: 'none', epoch: 1, plain: { keys: {} } }
      epochOf[g] = 1
    }
    for (const [g, keys] of byGroup) {                         // 新组（带键值对）
      if (groups[g] !== undefined) continue
      const mode = defs.get(g)?.mode ?? 'none'
      if (mode !== 'none') {
        const kek = keks.get(g)
        if (kek === undefined) { setNote(`REFUSED — ${g} 组未解锁，无法写入；请先解锁`); return { ok: false, note } }
        const epoch = 1
        groups[g] = { mode, epoch, kdf: defs.get(g)?.kdf ?? newPassphraseKdf(), sealed: sealFromKeys(keys, kek, aadOf(g, epoch), g, epoch) }
        epochOf[g] = epoch
        continue
      }
      groups[g] = { mode: 'none', epoch: 1, plain: { keys } }
      epochOf[g] = 1
    }
    for (const g of noPersist) { const d = defs.get(g); if (d !== undefined) memDefs.set(g, d); delete groups[g]; delete epochOf[g] }
    const seq = (await currentSeq()) + 1
    const envelope = Buffer.from(JSON.stringify({ version: 2, seq, epochOf, groups }), 'utf8')
    const r = commitState({ vaultPath: paths.vault, headPath: paths.head, bytes: envelope, seq })   // **vault 先、头后**
    await syncUses(flat)
    return { ok: true, seq: r.seq, shortFp: r.shortFp, note }
  }

  /** 组 → 分桶填充 → AEAD 封。`group`/`epoch` 会写进明文内部，解密后据此还原。 */
  function sealFromKeys (keys, kek, aad, group, epoch) {
    // **加密前**混入随机数量的假条目：密文里"条目数量"不再等于真实秘密数量（抗结构分析）。
    // 数量取 [0, max(3, 真实数)] 的随机值 ⇒ 同一组每次落盘都不同 ⇒ 无法靠比较密文推断是否改过秘密。
    const real = Object.keys(keys ?? {}).length
    const decoyCount = Math.floor(Math.random() * (Math.max(3, real) + 1))
    const merged = { ...(keys ?? {}), ...makeDecoys(decoyCount) }
    const plain = padBucket(serializeGroup({ group, epoch, keys: merged }))
    return sealGroup(plain, kek, aad)
  }

  async function readVaultEnvelope () {
    const raw = await readMaybe(paths.vault)
    if (raw === null) return { groups: new Map() }
    try {
      const o = JSON.parse(raw)
      if (o?.version === 2 && o.groups !== null && typeof o.groups === 'object') return { groups: new Map(Object.entries(o.groups)) }
      // 旧格式不再兼容（读取路径已拒绝；写回时同样拒绝，避免把 v1 内容当 v2 覆盖）
      const keys = {}
      for (const [k, e] of Object.entries(m.flat)) keys[k] = { value: e.value, maxUses: e.maxUses, uses: e.uses }
      return { groups: new Map([[DEFAULT_GROUP, { mode: 'none', epoch: 1, plain: { keys } }]]) }
    } catch { return { groups: new Map() } }
  }

  async function currentSeq () {
    const raw = await readMaybe(paths.vault)
    if (raw === null) return 0
    try { return Math.floor(Number(JSON.parse(raw)?.seq) || 0) } catch { return 0 }
  }

  /* ── 计数 / 烧伤 ─────────────────────────────────────────────────────── */

  async function syncUses (flat) {
    const cur = readUses(paths.uses)
    const uses = { ...cur.uses }
    for (const [k, e] of Object.entries(flat ?? {})) {
      const id = idOf(e?.group ?? DEFAULT_GROUP, k)                     // 不透明 id（不含明文键名）
      uses[id] = usesOf(e?.uses, uses[id])
    }
    try { await writeUses(paths.uses, { uses, burned: cur.burned }) } catch { /* 容错 */ }
    return uses
  }

  function usesState () { return readUses(paths.uses) }

  /**
   * **不透明条目 id**（计数与烧伤表都用它）—— `'e:' + HMAC(kfp, 组\0键)[0:22]`。
   * 绝不把明文键名写进 `vault.uses.json`（规范 §6 硬要求：烧伤表不含明文键名）。
   * `kfp` 是持久随机键（首次使用时生成，存在 uses 文件里）；诚实边界：拿到整个文件的人
   * 仍可对候选键名做字典尝试 —— 这只能靠"文件本身也是秘密"或加密组来兜底。
   */
  function idOf (group, key) {
    const st = readUses(paths.uses)
    let kfp = st.kfp
    if (typeof kfp !== 'string' || kfp.length < 16) {
      kfp = newSalt()
      try { writeUsesSync({ ...st, kfp }) } catch { /* 尽力 */ }
    }
    return 'e:' + nameHmac(Buffer.from(kfp, 'base64'), `${group ?? DEFAULT_GROUP}\u0000${key}`).slice(0, 22)
  }
  function writeUsesSync (state) { writeFileSyncSync(paths.uses, JSON.stringify({ v: 1, ...state })) }
  function writeFileSyncSync (p, text) {
    const tmp = p + '.' + process.pid + '.tmp'
    require$writeFileSync(tmp, text, { mode: 0o600 })
    require$renameSync(tmp, p)
  }

  /** 合并两处计数（§3 的 max 规则）—— 供上层读取"权威次数"。 */
  function authoritativeUses (key, group, ctUses) {
    const cur = readUses(paths.uses)
    return usesOf(ctUses, cur.uses[idOf(group, key)])
  }

  /** 烧毁后留**烧伤标记**（只存 entryId + 名字 HMAC，不含明文键名）§6。 */
  async function burn ({ key, groupName = DEFAULT_GROUP, hmacKey, reason = 'destroyed' }) {
    const cur = readUses(paths.uses)
    const nameH = hmacKey ? nameHmac(hmacKey, key) : undefined
    cur.burned.push({ entryId: idOf(groupName, key), nameHmac: nameH, burnedAtSeq: await currentSeq(), reason })
    await writeUses(paths.uses, cur)
    return cur.burned.length
  }

  /* ── 组与解锁（KEK 只在内存）─────────────────────────────────────────── */

  function groups () {
    if (!defs.has(DEFAULT_GROUP)) defs.set(DEFAULT_GROUP, { mode: 'none' })      // 默认组恒在
    const list = [...defs.entries()].map(([group, d]) => {
      const isDefault = isDefaultGroup(group)
      return {
        // 默认组强制为「不加密落盘」，且属性不可修改（无论磁盘上写了什么）
        group,
        mode: isDefault ? DEFAULT_GROUP_ATTRS.mode : d.mode,
        // 状态语义（用户模型）：只有「口令加密」且没有内存 KEK 才是**加密态**；
        // 「不加密」与「简单混淆」都是**解密态**（混淆用设备密钥，本地可得、启动即解开）
        // 统一判态（曾只认口令组 ⇒ 混淆组点了「加密」状态也不变）：
        // 口令组看 keks；混淆组看 obfHidden；不加密恒为解密态
        locked: isDefault ? false : (d.mode !== 'none' && isUnlocked(group) !== true),
        label: isDefault ? DEFAULT_GROUP_LABEL : group,
        isDefault,
        persist: isDefault ? true : (d.persist !== false),   // 落盘 / 不落盘（设置页与状态列都会显示）
        immutable: isDefault,                           // 属性不可修改
        // 与 groups() 同口径：口令组看 keks，混淆组看 obfHidden，不加密恒为 unlocked
        state: isDefault ? 'unlocked' : (d.mode === 'passphrase' ? (!keks.has(group) ? 'locked' : 'unlocked') : (d.mode === OBF_MODE ? (obfHidden.has(group) ? 'locked' : 'unlocked') : 'unlocked')),   // 加密态/解密态
        // 三态文案：曾经只判 none/其它 两路 ⇒ 简单混淆组被显示成「口令加密」
        attrs: isDefault ? '不加密落盘' : (d.mode === 'none' ? '不加密' : (d.mode === OBF_MODE ? '简单混淆' : '口令加密'))
      }
    })
    list.sort((a, b) => (a.isDefault === b.isDefault ? a.group.localeCompare(b.group) : (a.isDefault ? -1 : 1)))
    return list
  }

  /** 建组（内部 id 与显示名一致，默认组除外）。 */
  async function createGroup (name) {
    const g = String(name ?? '').trim()
    if (typeof g !== 'string' || g.length === 0 || g.length > 32 || /[\s'"\\/\u0000-\u001f]/.test(g)) return { ok: false, note: '组名 ≤32 字符，且不能含空白、引号、斜杠' }
    if (isDefaultGroup(g) || g === DEFAULT_GROUP_LABEL) return { ok: false, note: '不能与默认引用组同名' }
    await refreshDefs()
    if (defs.has(g)) return { ok: false, note: `组已存在：${g}` }
    defs.set(g, { mode: 'none' })
    return { ok: true, note: `已创建引用组 ${g}（默认不加密；可在该组上启用口令加密）` }
  }

  /**
   * 「落盘」开关（仅创建时可选）：persist=false 的组只在内存里，定义与键值对都不写盘、重启即消失。
   * 默认引用组恒为「不加密 + 落盘」，属性不可修改。
   */
  async function setGroupPersist (group, persist) {
    if (isDefaultGroup(group)) return { ok: false, note: '默认引用组恒为「不加密 + 落盘」，属性不可修改' }
    const d = defs.get(group)
    if (d === undefined) return { ok: false, note: `组不存在：${group}` }
    const next = persist !== false
    defs.set(group, { ...d, persist: next })
    if (next === false) memDefs.set(group, { ...d, persist: false })
    else memDefs.delete(group)
    return { ok: true, persist: next }
  }

  /** 删组：**只允许删空组**（有键值对时必须先迁移或删除，避免误删秘密）。 */
  async function deleteGroup (name) {
    const g = String(name ?? '').trim()
    if (isDefaultGroup(g)) return { ok: false, note: '默认引用组不可删除（属性不可修改；它保证功能开箱可用）' }
    await refreshDefs()
    if (!defs.has(g)) return { ok: false, note: `组不存在：${g}` }
    const raw = await loadFlat()
    // 必须先解密：锁定时 loadFlat() 看不到该组内容 ⇒ 会数出 0 个键 ⇒ 把"其实有键的组"删掉，
    // 键的密文仍留在 vault.json 里而组定义已消失 ⇒ 永久失联（真实数据丢失路径）。
    const delMode = defs.get(g)?.mode
    if (delMode !== 'none' && isUnlocked(g) !== true) {
      return { ok: false, note: `组 ${g} 处于锁定状态（本次会话还没有解锁）—— 先在它那一行的操作列点「解密」并输入口令，再点删除。锁定时读不到组内键值，直接删会把有键的组误判成空组。` }
    }
    const owned = Object.entries(raw.flat ?? {}).filter(([, e]) => String(e?.group ?? DEFAULT_GROUP) === g)
    if (owned.length > 0) return { ok: false, note: `组 ${g} 内还有 ${owned.length} 个键值对 —— 请先迁移或删除` }
    defs.delete(g)
    goneGroups.add(g)          // 立墓碑：此后写入与刷新都不再带它回来
    keks.delete(g)
    return { ok: true, note: `已删除空组 ${g}` }
  }

  async function setGroupMode (group, mode, { passphrase } = {}) {
    if (isDefaultGroup(group)) {
      return { ok: false, note: '默认引用组的属性不可修改：它本质是「不加密 + 落盘」的引用组（如需加密请新建一个组）' }
    }
    const prev = defs.get(group) ?? { mode: 'none' }
    if (mode === 'none') { defs.set(group, { mode: 'none' }); keks.delete(group); return { ok: true } }
    if (mode === 'passphrase') {
      if (typeof passphrase !== 'string' || passphrase.length === 0) return { ok: false, note: '设置口令加密需要提供口令' }
      const kdf = newPassphraseKdf(prev.kdf)
      let kek
      try {
        kek = await kekFor(passphrase, kdf, { createPepper: true })
      } catch (error) {
        return { ok: false, note: `设备 pepper 不可用，已拒绝创建口令组：${String(error?.message ?? error)}` }
      }
      keks.set(group, kek)
      defs.set(group, { mode: 'passphrase', kdf })
      return { ok: true, note: `${group} 组已启用口令加密（口令不落盘；设备 pepper 与 vault.json 分开保护，重启即失效）` }
    }
    if (mode === OBF_MODE) {
      const key = await obfKey()
      keks.set(group, key)
      defs.set(group, { mode: OBF_MODE })
      return { ok: true, note: `${group} 组已启用简单混淆（设备固定密钥；⚠ 只防明文落盘，不等于保密）` }
    }
    if (mode === 'keychain') return { ok: false, note: '引用组有三种模式：不加密 / 简单混淆 / 口令加密（系统服务模式未启用）' }
    return { ok: false, note: `未知加密模式：${mode}` }
  }

  /**
   * 只读外壳、填充组定义（**不解密**）—— 让 `unlock` / 组列表在"还没 loadFlat"时也能工作。
   * 面板的真实调用顺序就是"先解锁再加载"，所以这是必须的（否则会误报"组不存在"）。
   */
  async function refreshDefs () {
    const raw = await readMaybe(paths.vault)
    if (raw === null) return
    try {
      const o = JSON.parse(raw)
      if (o?.version !== 2 || o.groups === null || typeof o.groups !== 'object') {          // 旧格式 ⇒ 默认组
        if (!defs.has(DEFAULT_GROUP)) defs.set(DEFAULT_GROUP, { mode: 'none' })
        return
      }
      for (const [g, spec] of Object.entries(o.groups)) {
        const mode = modeOf(spec)
        if (!defs.has(g) && goneGroups.has(g) !== true) {
          if (goneGroups.has(g) !== true) defs.set(g, { mode, kdf: spec?.kdf })   // 墓碑组不回填
          // 简单混淆：首次发现时标为隐藏（用户要求：不再自动解密，需手动点「解密」）。
          // 只对"首次发现"的组做 —— 否则 unlock() 内那次惰性 refreshDefs 会把刚解开的组又藏回去。
          if (mode === OBF_MODE) obfHidden.add(g)
        }
      }
    } catch { /* 保持现状（上层会用 loadFlat 报 REFUSED） */ }
    for (const [g, d] of memDefs.entries()) if (!defs.has(g)) defs.set(g, d)
  }

  /**
   * 把旧格式（无 pepper）的口令组在**成功解锁后**就地迁移到 pepper。
   * 只动目标组，保留其它组（含锁定组）原样；epoch+1 防旧密文被搬回。
   */
  async function migrateGroupToPepper (group, oldKek) {
    try {
      const raw = await readMaybe(paths.vault)
      if (raw === null) return { ok: false, note: 'vault.json 不存在' }
      const o = JSON.parse(raw)
      const spec = o?.groups?.[group]
      if (spec === undefined) return { ok: false, note: `组不存在：${group}` }
      const epoch = Number(spec.epoch ?? 0)
      const pt = openGroup(spec.sealed, oldKek, aadOf(group, epoch))
      const obj = deserializeGroup(pt)
      const nextEpoch = epoch + 1
      obj.epoch = nextEpoch
      const kdf = { ...newPassphraseKdf(spec.kdf), salt: spec.kdf?.salt ?? '', pepper: true }
      const pepper = await vaultPepper()
      const nextKek = mixPepper(oldKek, pepper)
      const nextPt = padBucket(serializeGroup(obj))
      o.groups[group] = {
        ...spec,
        epoch: nextEpoch,
        kdf,
        sealed: sealGroup(nextPt, nextKek, aadOf(group, nextEpoch)),
      }
      if (o.epochOf !== null && typeof o.epochOf === 'object') o.epochOf[group] = nextEpoch
      const seq = (await currentSeq()) + 1
      o.seq = seq
      const committed = commitState({
        vaultPath: paths.vault,
        headPath: paths.head,
        bytes: Buffer.from(JSON.stringify(o), 'utf8'),
        seq,
      })
      lastSeq = committed.seq
      defs.set(group, { ...(defs.get(group) ?? {}), kdf })
      return { ok: true, kek: nextKek, note: `已把 ${group} 组迁移到设备 pepper（epoch ${nextEpoch}）` }
    } catch (error) {
      return { ok: false, note: `pepper 迁移失败（保留旧密文）：${String(error?.message ?? error)}` }
    }
  }

  async function unlock (group, passphrase) {
    if (!defs.has(group)) await refreshDefs()                  // 惰性发现组定义（面板先解锁后加载）
    const d = defs.get(group)
    if (d === undefined) return { ok: false, note: `组不存在：${group}` }
    if (d.mode === 'none') return { ok: true, note: '' }
    // 简单混淆组：用**设备密钥**即可解开 ⇒ 不需要口令（这就是操作列「解密」按钮的依据：
    // 混淆只防明文落盘、不是安全机制）。同时清掉显式隐藏标记，否则下次 loadFlat 又会隐藏它。
    if (d.mode === OBF_MODE) {
      obfHidden.delete(group)
      keks.set(group, await obfKey())
      return { ok: true, note: '' }
    }
    if (typeof passphrase !== 'string' || passphrase.length === 0) return { ok: false, note: '需要口令' }
    let kek
    try {
      kek = await kekFor(passphrase, d.kdf, { createPepper: false })
    } catch (error) {
      return { ok: false, note: `口令组需要的设备 pepper 不可用：${String(error?.message ?? error)}` }
    }
    const st = await loadFlatWith(kek, group)                  // 用候选 KEK 试解该组
    if (st === false) return { ok: false, note: '口令不对（解密失败）' }
    let note = ''
    if (d.kdf?.pepper !== true) {
      const migrated = await migrateGroupToPepper(group, kek)
      if (migrated.ok === true) { kek = migrated.kek; note = migrated.note } else note = migrated.note
    }
    keks.set(group, kek)
    return { ok: true, note }
  }

  /** 用候选 KEK 试解某组：成功 true，失败 false（不改动内存状态）。 */
  async function loadFlatWith (kek, group) {
    const raw = await readMaybe(paths.vault)
    if (raw === null) return false
    try {
      const o = JSON.parse(raw)
      const spec = o?.groups?.[group]
      if (spec === undefined) return false
      if (spec.mode === 'none') return true
      openGroup(spec.sealed, kek, aadOf(group, Number(spec.epoch ?? 0)))
      return true
    } catch { return false }
  }

  function lock (group) {
    keks.delete(group)
    if (defs.get(group)?.mode === OBF_MODE) obfHidden.add(group)
  }
  function lockAll () {
    keks.clear()
    for (const [g, d] of defs.entries()) if (d?.mode === OBF_MODE) obfHidden.add(g)
  }
  function isUnlocked (group) {
    const m = defs.get(group)?.mode ?? 'none'
    if (m === 'none') return true
    if (m === OBF_MODE) return obfHidden.has(group) !== true
    return keks.has(group)
  }

  /** 该键名是否命中烧伤表（按不透明 id）—— 用于"重建同名键需确认"。 */
  function nameBurned (group, key) {
    const st = readUses(paths.uses)
    const id = idOf(group, key)
    return (Array.isArray(st.burned) ? st.burned : []).find((b) => b?.entryId === id) ?? null
  }

  /** 安全擦除一个文件（多轮覆写后删除）—— 供删除密码/重建时使用。 */
  function wipe (path) { try { return wipeFileSync(path) } catch { return false } }

  return {
    loadFlat, storeFlat, groups, refreshDefs, createGroup, deleteGroup, setGroupMode, unlock, lock, lockAll, isUnlocked, groupStates, rotateObfKey, deviceKeyFingerprint, setGroupPersist,
    isDefaultGroup, defaultGroupAttrs: DEFAULT_GROUP_ATTRS,
    usesState, authoritativeUses, burn, nameBurned, idOf, note: () => note, wipe,
    paths, defaultGroup: DEFAULT_GROUP, defaultGroupLabel: DEFAULT_GROUP_LABEL, headFp, burnedOf
  }
}

export const VAULT_IO_FILES = { head: 'vault.head.json', uses: 'vault.uses.json', pepper: 'vault.pepper' }
export { shortFp, headFp }