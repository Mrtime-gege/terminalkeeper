/**
 * 卸载处置（disposition）：把"保留还是清理"的选择**提前存下来**，卸载时按它执行。
 *
 * 为什么需要：卸载由宿主发起、插件无法弹窗询问；但卸载时 Cordis 会调用插件的 dispose 钩子
 * （本插件已在用 ctx.effect）。因此在 dispose 时：
 *   ① 总是写一份醒目说明（README-SECURITY.txt）—— 讲清这里有哪些敏感数据、如何删除；
 *   ② 若用户事先选了「清理」⇒ 执行**白名单式**删除（只删已知数据文件，绝不递归删目录）；
 *   ③ 若存在**口令加密组**而用户没明确允许 ⇒ 保留密文并大声提示（避免不可恢复的误删）。
 *
 * 默认处置 = **保留**（保守）——因为误删不可恢复，而"留着"至少可用本仓库的
 * npx -y terminalkeeper purge-data --yes 清掉（先 --dry-run 预览）。
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'


/**
 * ── 按文件类别的清理策略 ──────────────────────────────────────────────
 * 重要概念区分（设置页必须讲清楚）：
 *   · **关闭插件（disable）≠ 卸载（uninstall）**：关闭常常只是"临时不用"，
 *     数据必须原样保留、以便随时再打开；卸载才是"不再需要"。
 *   · 因此**清理策略是独立于开关状态的**：关不关、卸不卸，都由这里每类文件的策略决定。
 * 每类策略取值：
 *   keep    —— 保留（默认）：不自动清理
 *   rotate  —— 按天轮转：保留最近 days 天，更早的归档/截尾（审计链需保留链头校验语义）
 *   purge   —— 卸载时清理（仅在**卸载**时执行，关闭时绝不执行）
 */
export const CATEGORIES = [
  { key: 'audit', label: '审计链（执行的命令与输入 —— 最可能夹带秘密）', default: 'keep', days: 30, sensitive: true },
  { key: 'output', label: '终端捕获输出 output/（可能夹带秘密）', default: 'keep', days: 7, sensitive: true },
  { key: 'snapshots', label: '快照索引与回放帧（可能含屏幕内容）', default: 'keep', days: 7, sensitive: true },
  { key: 'sessions', label: '会话台账 sessions.json（面板状态）', default: 'keep', days: 30, sensitive: false },
  { key: 'notices', label: '提示信息历史 notices.json', default: 'keep', days: 30, sensitive: false },
  { key: 'vault', label: '引用库 vault.*（不加密组为明文；口令加密组为密文）', default: 'keep', days: 0, sensitive: true },
  { key: 'prefs', label: '偏好与自定义配置（偏好、宏、授权规则、工作区、配置覆盖）', default: 'keep', days: 0, sensitive: false },
]
export const POLICIES = ['keep', 'wipe', 'rotate']
/** 策略的中文名义（设置页直接显示；保持与用户约定一致）：
 *   1 保持不变 keep    —— 不清理、不改动本类文件
 *   2 彻底删除 wipe    —— 删除本类文件（卸载时执行；也可在设置页点「立即彻底删除本类」）
 *   3 按天轮转 rotate  —— 进阶：只保留最近 days 天（适用于审计/输出这类按天增长的文件）
 */
export const POLICY_LABELS = { keep: '保持不变', wipe: '彻底删除', rotate: '按天轮转（进阶）' }

/** 读取每类策略；缺失/损坏一律回落该类默认（保守 = keep） */
export function readPolicies (dir) {
  let raw = {}
  try { raw = JSON.parse(readFileSync(join(dir, DISPOSITION_FILE), 'utf8'))?.policies ?? {} } catch { raw = {} }
  const out = {}
  for (const c of CATEGORIES) {
    const v = raw?.[c.key]
    const policy = POLICIES.includes(v?.policy) ? v.policy : c.default
    const days = Number.isFinite(Number(v?.days)) && Number(v.days) > 0 ? Number(v.days) : c.days
    out[c.key] = { policy, days }
  }
  return out
}

/** 写入某类策略（非法值拒绝） */
export function writePolicy (dir, key, patch) {
  const cat = CATEGORIES.find((c) => c.key === key)
  if (cat === undefined) return { ok: false, note: `未知类别：${key}（允许：${CATEGORIES.map((c) => c.key).join(' / ')}）` }
  const policy = patch?.policy
  if (POLICIES.includes(policy) !== true) return { ok: false, note: `未知策略：${String(policy)}（允许：${POLICIES.join(' / ')}）` }
  const cur = {}
  try { Object.assign(cur, JSON.parse(readFileSync(join(dir, DISPOSITION_FILE), 'utf8'))) } catch { /* 新建 */ }
  const policies = { ...(cur.policies ?? {}) }
  policies[key] = { policy, days: Number.isFinite(Number(patch?.days)) && Number(patch.days) > 0 ? Number(patch.days) : cat.days }
  const next = { ...cur, policies }
  writeFileSync(join(dir, DISPOSITION_FILE), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  return { ok: true, key, value: policies[key] }
}

/** 把策略摘要写到数据目录（设置页/运维都能离线看到当前策略） */
export function writePolicyFile (dir) {
  const target = join(dir, 'CLEANUP-POLICY.txt')
  writeFileSync(target, policySummary(dir) + '\n\n（本文件由 terminalkeeper 生成；策略存于 disposition.json 的 policies 段）\n', { mode: 0o600 })
  return target
}

/** 设置页用的摘要（含"关闭≠卸载"的说明） */
export function policySummary (dir) {
  const policies = readPolicies(dir)
  const lines = [
    '清理策略（按文件类别）——**关闭插件不等于卸载**：',
    '  · 关闭（disable）：通常只是临时不用 ⇒ 数据原样保留，随时可再打开，**不触发任何清理**',
    '  · 卸载（uninstall）：确认不再需要 ⇒ 此时才会执行各文件的 purge 策略',
    '',
  ]
  for (const c of CATEGORIES) {
    const p = policies[c.key]
    const when = p.policy === 'keep' ? '保持不变（不清理、不改动）'
      : p.policy === 'wipe' ? '彻底删除（卸载时执行；亦可在设置页立即执行本类）'
        : `按天轮转：只保留最近 ${p.days} 天`
    lines.push(`  · ${c.label}\n      → ${when}`)
  }
  return lines.join('\n')
}

export const DISPOSITION_FILE = 'disposition.json'
/** 处置偏好：keep（默认，保留）| purge（卸载时清理敏感数据） */
export const DISPOSITIONS = ['keep', 'purge']
/** 说明文件名（写在数据目录里，任何人找到这些文件都能看懂） */
export const SECURITY_README = 'README-SECURITY.txt'
/**
 * 允许被"清理"删除的条目（**白名单**）：只删这些，绝不按目录整体递归。
 * 注意：vault.* 属"秘密库"，只有在没有口令加密组时才允许一并删除。
 */
export const PURGE_WHITELIST = [
  'audit-',          // 前缀：按天审计（命令文本/输入，最可能夹带秘密）
  'anchor.json',
  'output',          // 目录：终端捕获输出
  'snapshots.json',
  'sessions.json',
  'notices.json',
  'macros.json',
  'consent.json',
  'config-local.json',
  'workspaces.json',
  'tmux-cache.json',
  'env-cache.json',
  'user-config.json',
]
const VAULT_ENTRIES = ['vault.json', 'vault.head.json', 'vault.uses.json']

/** 读取处置偏好；缺失/损坏一律按 keep（保守） */
export function readDisposition (dir) {
  try {
    const obj = JSON.parse(readFileSync(join(dir, DISPOSITION_FILE), 'utf8'))
    const value = String(obj?.disposition ?? '')
    return DISPOSITIONS.includes(value) ? value : 'keep'
  } catch { return 'keep' }
}

/** 写入处置偏好（面板或命令行可调用）；非法值拒绝 */
export function writeDisposition (dir, value) {
  if (DISPOSITIONS.includes(value) !== true) return { ok: false, note: `未知处置：${value}（允许：${DISPOSITIONS.join(' / ')}）` }
  writeFileSync(join(dir, DISPOSITION_FILE), JSON.stringify({ disposition: value, at: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 })
  return { ok: true, disposition: value }
}

/** 目录里是否存在口令加密组（决定 vault.* 能否一起删） */
export function hasPassphraseGroup (dir) {
  try {
    const v = JSON.parse(readFileSync(join(dir, 'vault.json'), 'utf8'))
    const groups = v?.groups ?? {}
    return Object.keys(groups).some((g) => groups[g]?.mode === 'passphrase')
  } catch { return false }
}

/** 醒目说明：讲清这里有什么、卸载不会删、怎么删 */
export function securityReadme (dir) {
  return [
    'terminalkeeper —— 数据目录说明（卸载后仍会保留在这里）',
    '',
    `目录：${dir}`,
    '',
    '【关闭 ≠ 卸载】关闭插件（临时不用）**不会**删除本目录；卸载也**不会**自动删除。',
    '要按类别清理，见设置页的「清理策略」（或 disposition.json 的 policies 段）。',
    '因此以下内容会继续留在磁盘上：',
    '  · audit-YYYY-MM-DD.jsonl  审计链：记录执行的命令与输入（**可能夹带秘密**）',
    '  · anchor.json             审计链每日链头',
    '  · output/                 终端捕获输出（**可能夹带秘密**）',
    '  · snapshots.json / sessions.json  会话台账与快照索引（**可能含屏幕内容**）',
    '  · vault.json / vault.head.json / vault.uses.json  引用库：不加密组为明文，口令加密组为密文',
    '  · consent.json / macros.json / config-local.json / workspaces.json  授权规则、宏、配置覆盖、工作区',
    '',
    '要彻底清理（不可恢复）：',
    `  npx -y terminalkeeper purge-data --yes`,
    `  或 rm -rf "${dir}"`,
    '',
    '若存在口令加密的引用组，删除 vault.* 将导致**密文永久无法解开**；',
    '清理工具因此要求额外确认（--force）。',
    '',
  ].join('\n')
}

/**
 * dispose/unload 时的安全处置：**只读偏好 + 写说明/待清理标记，绝不删除数据**。
 *
 * Cordis 的 dispose 同时用于热重载、禁用和卸载，插件无法可靠区分；因此这里永远不执行
 * purge 删除。真正的清理只由用户显式运行 uninstall-clean / purge 工具完成。
 */
export function markUnloadDisposition (dir) {
  const result = { disposition: readDisposition(dir), pending: false, notes: [] }
  if (existsSync(dir) !== true) {
    result.notes.push('数据目录不存在，无需处置')
    return result
  }
  try { writeFileSync(join(dir, SECURITY_README), securityReadme(dir), { mode: 0o600 }) } catch { /* 说明写不上不影响 */ }
  if (result.disposition === 'purge') {
    try {
      writeFileSync(join(dir, 'PURGE-PENDING.txt'),
        '本插件被卸载时，用户选择的是「清理数据」，但插件**不会**在 unload 时自动删除（热重载也会触发 unload）。\n' +
        '请运行：npx -y terminalkeeper purge-data --yes（先 --dry-run 预览）\n', { mode: 0o600 })
      result.pending = true
    } catch { /* 标记写不上不影响 */ }
  }
  return result
}

/** 在 dispose 时执行：写说明；purge 偏好 ⇒ 白名单删除（锁定组存在则拒删 vault.*） */
export function applyDisposition (dir, { dryRun = false } = {}) {
  const result = { disposition: readDisposition(dir), removed: [], kept: [], notes: [] }
  if (existsSync(dir) !== true) { result.notes.push('数据目录不存在，无需处置'); return result }
  if (dryRun !== true) {
    try { writeFileSync(join(dir, SECURITY_README), securityReadme(dir), { mode: 0o600 }) } catch { /* 说明写不上不影响处置 */ }
  }
  if (result.disposition !== 'purge') {
    result.notes.push('处置=保留（默认）：不删除任何内容，仅留下说明文件')
    return result
  }
  const locked = hasPassphraseGroup(dir)
  const entries = readdirSync(dir)
  for (const name of entries) {
    const hit = PURGE_WHITELIST.some((w) => (w.endsWith('-') ? name.startsWith(w) : name === w))
    const isVault = VAULT_ENTRIES.includes(name)
    if (isVault === true) {
      if (locked === true) { result.kept.push(name); continue }
      if (dryRun === true) { result.removed.push(name); continue }
      try { unlinkSync(join(dir, name)); result.removed.push(name) } catch { result.kept.push(name) }
      continue
    }
    if (hit !== true) { result.kept.push(name); continue }        // 白名单外的条目**一律保留**
    if (dryRun === true) { result.removed.push(name); continue }
    try {
      if (name === 'output') rmSync(join(dir, name), { recursive: true, force: true })
      else unlinkSync(join(dir, name))
      result.removed.push(name)
    } catch { result.kept.push(name) }
  }
  if (locked === true) result.notes.push('存在口令加密组 ⇒ 保留 vault.*（密文删了就无法恢复）；如需一并删除请手动处理')
  return result
}
