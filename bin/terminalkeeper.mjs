#!/usr/bin/env node
/**
 * terminalkeeper 命令行（0.2.2）：一条命令安装/卸载/体检。
 *
 * 用法：
 *   npx -y terminalkeeper install   [--profile <name>] [--dry-run] [--yes]
 *   npx -y terminalkeeper uninstall [--profile <name>] [--dry-run]
 *   terminalkeeper doctor
 *   terminalkeeper verify-audit [<审计目录>] [--json]
 *   terminalkeeper chain-repair [<审计目录>] [--json] [--yes]   （默认干跑）
 *   terminalkeeper --version | --help
 *
 * install 做什么（全部可 --dry-run 预览）：
 *   1. 在 DSH profile（默认 web）的 package.json 里登记依赖与 bundle；
 *   2. 按 profile 的包管理器（pnpm/npm/yarn）安装插件包依赖（不会安装系统程序）；
 *   3. 检查 tmux（跑包的 install-deps.sh --check 同款逻辑）；
 *   4. 提示重启 `dsh web` 生效。
 *
 * 零外部依赖（只用 Node 内建），可离线跑。
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, renameSync, lstatSync, statSync, chmodSync, openSync, closeSync, fchmodSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { inspectSecretStrength, parseDomainFile } from '../lib/pure.mjs'
import { applyDisposition, hasPassphraseGroup, PURGE_WHITELIST } from '../lib/disposition.mjs'

const PKG = 'terminalkeeper'
// 版本来自包自身（npx 装下来的就是它）
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const flagValue = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

/**
 * 需要「后面跟一个值」的选项。位置参数解析必须跳过这些值 ——
 * 否则 `purge-audit --days 7` 会把 7 当成目录（REL-03/REL-13 的根因）。
 */
const VALUE_FLAGS = new Set([
  '--profile', '--out', '--passphrase', '--days', '--names', '--kind',
  '--audit-dir', '--scope', '--note', '--at', '--ttl-days',
  '--mirror', '--retention-days', '--base',
])
/** 首个非选项位置参数 = 子命令（REL-05：不要用 args.includes() 猜命令）。 */
function nonOptionArgs () {
  const out = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--') { out.push(...args.slice(i + 1)); break }
    if (arg.startsWith('--')) {
      if (arg.includes('=')) continue
      if (VALUE_FLAGS.has(arg) && i + 1 < args.length) i += 1
      continue
    }
    if (arg.startsWith('-') && arg !== '-') continue
    out.push(arg)
  }
  return out
}
function commandName () {
  return nonOptionArgs()[0]
}
/** 去掉子命令后的位置参数（例如 purge-data 的目录、restore 的 文件/目录）。 */
function positionalAfter (command, extraSkip = []) {
  const pos = nonOptionArgs().filter((a) => a !== command && !extraSkip.includes(a))
  return pos
}

const echo = (text = '') => console.log(text)
const fail = (text) => { console.error(`\n✗ ${text}`); process.exit(1) }
const ok = (text) => console.log(`✓ ${text}`)

function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}
function profilesDir() {
  return join(dshHome(), 'profiles')
}
function pickProfile(want) {
  const dir = profilesDir()
  if (!existsSync(dir)) fail(`找不到 DSH profiles 目录：${dir}（${PKG} 需要 DSH 运行环境）`)
  const available = readdirSync(dir).filter((n) => existsSync(join(dir, n, 'package.json'))).sort()
  if (available.length === 0) fail(`profiles 目录里没有可用 profile：${dir}`)
  const chosen = want !== undefined && want !== '' ? want
    : (available.length === 1 ? available[0] : (available.includes('web') ? 'web' : available[0]))
  if (!available.includes(chosen)) {
    fail(`profile「${chosen}」不存在；可用的：${available.join(', ')}（用 --profile 指定）`)
  }
  return { dir, name: chosen, root: join(dir, chosen) }
}

function readProfileJson(root) {
  const p = join(root, 'package.json')
  if (!existsSync(p)) fail(`没有 ${p}（这不是一个 DSH profile？）`)
  return JSON.parse(readFileSync(p, 'utf8'))
}

function packageManagerOf(root) {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(root, 'package-lock.json'))) return 'npm'
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn'
  return 'npm'
}

function tmuxCheck() {
  const r = spawnSync('sh', ['-c', 'command -v tmux >/dev/null 2>&1 && tmux -V || echo MISSING'], { encoding: 'utf8' })
  const out = (r.stdout ?? '').trim()
  return out === 'MISSING' ? '' : out
}

function install() {
  const dryRun = flag('dry-run')
  const profile = pickProfile(flagValue('profile', undefined))
  const root = profile.root

  const json = readProfileJson(root)
  const dependencies = json.dependencies ?? {}
  const bundles = (json.dsh?.profile?.bundles ?? []).filter((b) => b !== PKG)
  const semver = VERSION.startsWith('0.') ? VERSION : VERSION
  echo(`\n${PKG}@${VERSION} → profile「${profile.name}」（${dryRun ? 'DRY-RUN，只预览不动手' : '实装'}）\n`)

  const before = JSON.stringify(json, null, 2)
  dependencies[PKG] = `^${semver}`
  json.dependencies = dependencies
  json.dsh = json.dsh ?? { profile: {} }
  json.dsh.profile = json.dsh.profile ?? {}
  json.dsh.profile.bundles = [...bundles, PKG]
  const after = JSON.stringify(json, null, 2)

  // 安装前先确认 npm 上确实有这个版本，避免包管理器给出难懂的 No matching version。
  const probe = spawnSync('npm', ['view', `${PKG}@${semver}`, 'version'], { encoding: 'utf8', timeout: 20000 })
  const remoteHas = probe.status === 0 && String(probe.stdout ?? '').split(/\s+/).filter(Boolean).length > 0
  if (dryRun) {
    echo(remoteHas ? `（npm 上已有 ${PKG}@${semver}）` : `⚠ npm 上还没有 ${PKG}@${semver}，请确认版本号或稍后再试`)
  } else if (!remoteHas) {
    fail(`${PKG}@${semver} 还没有发布到 npm，请确认版本号或稍后再试`)
  }

  const pm = packageManagerOf(root)
  echo(`1) 登记依赖与 bundle`)
  echo(`   dependencies.${PKG} = ^${semver}；dsh.profile.bundles += ${PKG}`)
  if (dryRun) {
    echo(`2) 将按 ${pm} 在 ${root} 安装插件包依赖（不会安装 tmux 等系统程序）`)
    echo(`3) tmux 检查：${tmuxCheck() || '缺 tmux（按 install-deps.sh 的指引由用户安装）'}`)
    echo(`\n（未做任何修改 —— --dry-run）`)
    return
  }
  if (before !== after) writeFileSync(join(root, 'package.json'), after + '\n')
  ok('package.json 已登记依赖与 bundle')

  echo(`2) 安装插件包依赖（${pm} install …；不会安装 tmux 等系统程序）`)
  const r = spawnSync(pm, ['install'], { cwd: root, stdio: 'inherit', shell: false })
  if (r.status !== 0) fail(`${pm} install 失败（exit ${r.status}）`)
  ok(`${pm} install 完成`)

  echo(`3) tmux 检查`)
  const tmux = tmuxCheck()
  if (tmux === '') {
    echo('   ⚠ 缺 tmux —— 插件本体需要它：')
    echo('     Debian/Ubuntu: sudo apt-get install -y tmux')
    echo('     macOS:         brew install tmux')
    echo('     Termux:        pkg install -y tmux')
  } else {
    ok(`tmux ${tmux} 在位`)
  }

  echo(`\n4) 完成。最后一步：重启 dsh web（DSH 插件列表里启用后生效）。`)
  echo(`   首次用时授权门会问你一次（同一个对话只问一次）。`)
  echo(`   体检：terminalkeeper doctor`)
}

function uninstall() {
  const dryRun = flag('dry-run')
  const profile = pickProfile(flagValue('profile', undefined))
  const root = profile.root
  const json = readProfileJson(root)
  const deps = json.dependencies ?? {}
  const bundles = json.dsh?.profile?.bundles ?? []
  if (deps[PKG] === undefined && !bundles.includes(PKG)) {
    echo(`${PKG} 不在 profile「${profile.name}」里（无需卸载）`)
    return
  }
  const before = JSON.stringify(json, null, 2)
  delete deps[PKG]
  json.dependencies = deps
  json.dsh.profile.bundles = bundles.filter((b) => b !== PKG)
  echo(`将从 profile「${profile.name}」移除 ${PKG} 的依赖与 bundle${dryRun ? '（DRY-RUN）' : ''}`)
  if (dryRun) return
  writeFileSync(join(root, 'package.json'), JSON.stringify(json, null, 2) + '\n')
  ok('已移除（重启 dsh web 后不再加载）')
  if (flag('purge')) {
    if (!flag('yes') && !dryRun) fail('uninstall --purge 会删除数据；确认请加 --yes（先用 --dry-run 预览）')
    purgeData(join(dshHome(), 'terminalkeeper'), { dryRun, yes: flag('yes') })
  } else {
    echo('数据目录保留（默认；彻底清理请用 uninstall --purge --yes 或 purge-data --yes）')
  }
}

/* ── purge-data 安全底座（REL-01）──────────────────────────────────────────────
 * 1) dry-run 必须在任何写盘之前返回，且不得改 disposition.json（用户策略就存在它的 policies 段）；
 * 2) disposition 写入必须**合并**，不能整体覆盖；
 * 3) 目录必须能被确认是「本插件的数据目录」，否则按名字删文件/递归删 output/ 太危险；
 * 4) 删除 output 前拒绝符号链接，绝不顺着链接删到数据目录之外。
 */
const DATA_MARKERS = [
  'vault.json', 'vault.head.json', 'vault.uses.json', 'vault.pepper',
  'sessions.json', 'notices.json', 'macros.json', 'config-local.json',
  'snapshots.json', 'workspaces.json', 'checkpoints.jsonl', 'README-SECURITY.txt',
  'disposition.json', 'output',
]
const VAULT_ENTRIES = ['vault.json', 'vault.head.json', 'vault.uses.json', 'vault.pepper']

function lstatOrNull (p) {
  try { return lstatSync(p) } catch { return null }
}

/** 只接受 $DSH_HOME/…/terminalkeeper 且含本插件特征文件；否则退回码 2，绝不猜测。 */
function assertOwnDataDir (dir) {
  const abs = resolve(dir)
  const st = lstatOrNull(abs)
  if (st === null) return { ok: false, error: `数据目录不存在：${abs}` }
  if (st.isSymbolicLink()) return { ok: false, error: `拒绝符号链接数据目录：${abs}（请传真实目录）` }
  if (st.isDirectory() !== true) return { ok: false, error: `不是目录：${abs}` }
  const home = resolve(dshHome())
  const allowed = abs === join(home, 'terminalkeeper') ||
    (abs.startsWith(home + sep) && basename(abs) === 'terminalkeeper')
  if (allowed !== true) {
    return {
      ok: false,
      error: `拒绝清理：${abs} 不在 DSH_HOME 之下或目录名不是 terminalkeeper（本工具只处理本插件数据目录；可用 DSH_HOME 指向临时根做预览）`,
    }
  }
  let names = []
  try { names = readdirSync(abs) } catch (error) {
    return { ok: false, error: `无法读取数据目录：${String(error?.message ?? error)}` }
  }
  const hit = names.filter((n) => DATA_MARKERS.includes(n) || /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))
  if (hit.length === 0) {
    return { ok: false, error: `拒绝清理：${abs} 里没有本插件的数据特征文件（${DATA_MARKERS.slice(0, 6).join(' / ')} …），无法确认归属` }
  }
  return { ok: true, resolved: abs, hit }
}

/** 原子写 0600（临时文件 + rename，避免半截写与跟随目标符号链接）。 */
function writePrivateAtomic (dir, name, data) {
  const target = join(dir, name)
  const tmp = join(dir, `.${name}.tmp-${process.pid}-${Date.now()}`)
  let fd
  try {
    fd = openSync(tmp, 'wx', 0o600)
    fchmodSync(fd, 0o600)
    writeFileSync(fd, data)
    closeSync(fd)
    fd = undefined
    renameSync(tmp, target)
  } catch (error) {
    if (fd !== undefined) { try { closeSync(fd) } catch { /* 已关 */ } }
    try { unlinkSync(tmp) } catch { /* 没建成就没有 */ }
    throw error
  }
}

/** 合并写 disposition：保留 policies 等用户配置，只更新 disposition/at。 */
function writeDispositionMerged (dir, value) {
  let current = {}
  try {
    const parsed = JSON.parse(readFileSync(join(dir, 'disposition.json'), 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed) !== true) current = parsed
  } catch { /* 没有/损坏：按空对象合并 */ }
  const next = { ...current, disposition: value, at: new Date().toISOString() }
  writePrivateAtomic(dir, 'disposition.json', JSON.stringify(next, null, 2) + '\n')
}

/** 纯只读预览：不写 disposition、不写说明文件、不删任何东西。 */
function previewDisposition (dir) {
  const result = { removed: [], kept: [], notes: [] }
  const locked = hasPassphraseGroup(dir)
  for (const name of readdirSync(dir).sort()) {
    const isVault = VAULT_ENTRIES.includes(name)
    if (isVault === true) {
      if (locked === true) result.kept.push(name)
      else result.removed.push(name)
      continue
    }
    const hit = PURGE_WHITELIST.some((w) => (w.endsWith('-') ? name.startsWith(w) : name === w))
    if (hit !== true) { result.kept.push(name); continue }
    if (name === 'output') {
      const st = lstatOrNull(join(dir, name))
      if (st !== null && st.isSymbolicLink()) {
        result.kept.push(name)
        result.notes.push('output/ 是符号链接：拒绝递归删除（保留）')
        continue
      }
    }
    result.removed.push(name)
  }
  if (locked === true) result.notes.push('存在口令加密组 ⇒ 保留 vault.*（密文删了就无法恢复）；如需一并删除请手动处理')
  return result
}

function purgeData(dirArg = undefined, opts = {}) {
  const dryRun = opts.dryRun ?? flag('dry-run')
  const yes = opts.yes ?? flag('yes')
  const dir = resolve(dirArg ?? positionalAfter('purge-data')[0] ?? join(dshHome(), 'terminalkeeper'))
  if (existsSync(dir) !== true) { echo(`数据目录不存在：${dir}`); return }
  const own = assertOwnDataDir(dir)
  if (own.ok !== true) { console.error(`\n✗ ${own.error}`); process.exit(2) }
  if (!yes && !dryRun) fail('purge-data 会删除审计/留痕/引用库等数据；确认请加 --yes（先 --dry-run 预览）')

  const outputPath = join(dir, 'output')
  const outputStat = lstatOrNull(outputPath)
  if (outputStat !== null && outputStat.isSymbolicLink()) {
    if (dryRun !== true) {
      console.error(`\n✗ 拒绝清理：${outputPath} 是符号链接，递归删除可能波及数据目录之外（请先手动处理该链接）`)
      process.exit(2)
    }
  }

  if (dryRun === true) {
    const preview = previewDisposition(dir)
    echo(`数据目录：${dir}`)
    echo('处置：DRY-RUN（只读预览；未写入 disposition/未删除任何内容）')
    if (preview.removed.length > 0) echo('将删除：' + preview.removed.join(', '))
    if (preview.kept.length > 0) echo('保留：' + preview.kept.join(', '))
    for (const note of preview.notes) echo('说明：' + note)
    return
  }

  // 真正的清理：先保存原 disposition 字节，合并写 purge，执行后原样恢复（含 policies）。
  let priorBytes = null
  try { priorBytes = readFileSync(join(dir, 'disposition.json')) } catch { priorBytes = null }
  let result
  let failure = null
  try {
    writeDispositionMerged(dir, 'purge')
    result = applyDisposition(dir, { dryRun: false })
  } catch (error) {
    failure = error
  } finally {
    try {
      if (priorBytes !== null) writePrivateAtomic(dir, 'disposition.json', priorBytes)
      else { try { unlinkSync(join(dir, 'disposition.json')) } catch { /* 本来就没有 */ } }
    } catch (error) {
      console.error(`⚠ 恢复 disposition.json 失败：${String(error?.message ?? error)}（policies 可能仍在临时文件里）`)
    }
  }
  if (failure !== null) fail(`清理失败：${String(failure?.message ?? failure)}`)
  echo(`数据目录：${dir}`)
  echo('处置：purge（按白名单删除；锁定组 vault.* 会保留）')
  if (result.removed.length > 0) echo('删除：' + result.removed.join(', '))
  if (result.kept.length > 0) echo('保留：' + result.kept.join(', '))
  for (const note of result.notes) echo('说明：' + note)
}

function doctor() {
  echo(`\nterminalkeeper@${VERSION} 体检\n`)
  const tmux = tmuxCheck()
  tmux === '' ? fail('✗ 缺 tmux（apt / brew / pacman / apk / pkg 装一下）') : ok(`tmux ${tmux}`)

  const dir = profilesDir()
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).sort()) {
      const nm = join(dir, name, 'node_modules', PKG)
      if (existsSync(join(dir, name, 'package.json'))) {
        ok(`profile「${name}」：${existsSync(nm) ? '已安装 ' + (JSON.parse(readFileSync(join(nm, 'package.json'), 'utf8')).version ?? '?') : '未安装'}${existsSync(join(dir, name, 'cordis.patch.yml')) && readFileSync(join(dir, name, 'cordis.patch.yml'), 'utf8').includes(PKG) ? ' · patch 里已登记' : ''}`)
      }
    }
  }
  const auditFile = join(dshHome(), 'terminalkeeper')
  ok(`数据目录：${auditFile}${existsSync(auditFile) ? '（存在）' : '（未创建——首次使用时生成）'}`)
  echo('\n（打开页面 → 右下角胶囊即可用；详情 ⓘ 里有能力/降级/审计链状态）')
}

if (args.includes('--version') || args.includes('-V')) {
  echo(VERSION)
  process.exit(0)
}
if (args.includes('--help') || args.includes('-h') || args.length === 0) {
  echo(`terminalkeeper v${VERSION} —— 一个命令装好 DSH 持久化 shell 插件

用法:
  terminalkeeper install [--profile <name>] [--dry-run]   安装到 DSH profile（--dry-run 只预览）
  terminalkeeper uninstall [--profile <name>] [--dry-run] [--purge --yes]  从 profile 移除；--purge 清理数据
  terminalkeeper purge-data [<数据目录>] [--dry-run] [--yes]     显式清理本插件数据（白名单；锁定 vault 保留）
  terminalkeeper doctor                                           体检：tmux / 安装状态 / 数据目录
  terminalkeeper verify-audit [<审计目录>] [--json]               离线复验审计哈希链（默认 ~/.dsh/terminalkeeper）
  terminalkeeper purge-audit [<审计目录>] [--kind audit|output] [--days N | --names a,b] [--yes]
                                                                 手动删除审计/留痕文件（**先入链 purge 见证再删**）
  terminalkeeper backup [<数据目录>] [--out <文件>] [--passphrase <口令>] [--include-device-key] [--yes] [--force]
  terminalkeeper restore <备份文件> <数据目录> [--passphrase <口令>] [--yes]   # 数据目录必须显式给出（不猜）
  terminalkeeper --version | --help
`)
  process.exit(0)
}
/**
 * 离线复验审计哈希链（E 流）。
 *
 * 与插件内 `shell_audit` 的链状态是同一份实现（lib/audit.js 的 readSealedChain + verifyChain），
 * 但**不依赖运行中的 DSH**：拿导出/备份的目录就能验。退出码 0 = 链完整，1 = 断链，2 = 用法错误。
 * 这样"可验证的不可篡改记录"不只是一句承诺：用户/CI 可以自己复算。
 */
/** 逐天修复断链：默认只干跑（--yes 才写入）。修法见 lib/audit.js 的 repairAuditDays。 */
async function repairChain () {
  const dir = resolve(positionalAfter('chain-repair')[0] ?? join(dshHome(), 'terminalkeeper'))
  if (!existsSync(dir)) { console.error(`✗ 审计目录不存在：${dir}`); process.exit(2) }
  const { repairAuditDays } = await import('../lib/audit.js')
  const apply = flag('yes')
  const r = await repairAuditDays(dir, { apply })
  if (flag('json')) { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1) }
  console.log(`审计目录：${dir}`)
  if (r.plan.length === 0) { console.log('✓ 没有断链，无需修复'); process.exit(0) }
  for (const it of r.plan) {
    console.log(`  ${it.day}：从第 ${it.at} 条起重封 ${it.rebuild} 条（${it.reason}）`)
  }
  if (apply !== true) {
    console.log('（干跑：还没有写入。确认无误后加 --yes 执行；执行前会备份该天文件为 .bak）')
    process.exit(0)
  }
  console.log(`✓ 已修复 ${r.changed.length} 天；复验：${r.after.ok ? '链内一致' : '仍有断链'}（已封链 ${r.after.sealed}）`)
  process.exit(r.ok ? 0 : 1)
}

async function verifyAudit () {
  const dir = resolve(positionalAfter('verify-audit')[0] ?? join(dshHome(), 'terminalkeeper'))
  if (!existsSync(dir)) {
    console.error(`✗ 审计目录不存在：${dir}`)
    process.exit(2)
  }
  const { readSealedChain, verifyAuditDays } = await import('../lib/audit.js')
    const { ensureCheckpointBaseline, verifyCheckpoints } = await import('../lib/audit-checkpoints.mjs')
    let mirrorArg = args.find((a) => a.startsWith('--mirror='))?.slice('--mirror='.length)
      ?? process.env.DSH_TERMINALKEEPER_AUDIT_MIRROR ?? ''
    // F7：CLI 没显式给镜像时，读插件的本地配置（与宿主 /list 同一来源），避免“工具说一致、CLI 说未配置”。
    if (mirrorArg === '') {
      try {
        const local = JSON.parse(readFileSync(join(dir, 'config-local.json'), 'utf8'))
        if (typeof local.auditMirror === 'string') mirrorArg = local.auditMirror
      } catch { /* 没有本地配置就按未配置 */ }
    }
  const chain = await readSealedChain({ dir })
  // 每天各自成链（2026-10 采纳）：以**逐天**结果为准 —— 跨天相连的旧文件不该被报成断链。
  const perDay = await verifyAuditDays({ dir })
    if (args.includes('--baseline')) {
      const created = await ensureCheckpointBaseline({ dir }, { mirror: mirrorArg })
      console.log(`已建立检查点基线：${created.created} 个（此后每次写入自动追加签名检查点）`)
    }
    const retentionDays = Number(args.find((a) => a.startsWith('--retention-days='))?.slice('--retention-days='.length)) || 30
    const checkpoints = await verifyCheckpoints({ dir }, { mirror: mirrorArg, retentionDays })
  const badDays = perDay.days.filter((d) => d.ok !== true)
  const firstBad = badDays[0]
  const v = {
    ...chain.verify,
    ok: perDay.ok,
    sealed: perDay.sealed,
    brokenAt: firstBad === undefined ? null : { index: (firstBad.brokenAt ?? 1) - 1, reason: firstBad.reason },
  }
  if (flag('json')) {
    console.log(JSON.stringify({
      dir, days: chain.days, records: chain.records.length, ...v, brokenAt: v.brokenAt,
        // 方案 1：签名检查点链（Ed25519 + 镜像）
        checkpoints: { ok: checkpoints.ok, count: checkpoints.count, lastSeq: checkpoints.lastSeq, errors: checkpoints.errors, warnings: checkpoints.warnings, mirror: checkpoints.mirror },
    }, null, 2))
  } else {
    console.log(`审计目录：${dir}`)
    console.log(`按天文件：${chain.days.length} 个（${chain.days.join(', ') || '（无）'}）`)
    console.log(`记录数：${chain.records.length}（已封链 ${v.sealed}）`)
    for (const d of perDay.days) {
      const tag = d.ok === true
        ? (d.legacyLinked === true ? '✓（旧格式：与前一天相连，已按"起点未知但自证"处理）' : '✓（独立链）')
        : `✗ 断链于第 ${d.brokenAt} 条（${d.reason}）`
      console.log(`  ${d.day}：${d.sealed}/${d.total}  ${tag}`)
    }
    console.log(checkpoints.ok === true
      ? `签名检查点：✓ ${checkpoints.count} 个（seq 1…${checkpoints.lastSeq}；key ${String(checkpoints.keyId).slice(0, 8)}；镜像 ${checkpoints.mirror?.detail ?? '未配置'}）`
      : `签名检查点：⚠ ${checkpoints.errors.join('；')}`)
    for (const warning of (checkpoints.warnings ?? []).slice(0, 5)) console.log(`  ⚠ ${warning}`)
    const noRecords = checkpoints.count === 0 && (checkpoints.warnings ?? []).some((w) => /没有任何审计记录|没有可验证记录|镜像不可读/.test(w))
    if (v.ok && checkpoints.ok === true && noRecords) {
      console.log('⚠ 无法验证：目录与镜像里都没有可验证记录（全新安装，或已被完全清空 —— 无法区分）')
    } else if (v.ok && checkpoints.ok === true) {
      // 安全修复：起点未知时不要再说"属正常" ——
      // 更早的文件不在目录里既可能是正常轮转，也可能是**删证据**。措辞必须让 CI/人分得清。
      console.log(v.startUnknown
        ? `⚠ 链内一致，但**起点未知**：本目录缺少更早的审计文件，链首完整性无法保证（正常轮转与被删证据外观相同）· 头 ${String(v.head).slice(0, 16)}`
        : `✓ 链完整 · 头 ${String(v.head).slice(0, 16)}`)
    } else {
      if (v.ok === true && checkpoints.errors.length > 0) {
        console.log(`✗ 检查点校验失败：${checkpoints.errors[0]}`)
      } else {
        const ba = v.brokenAt ?? {}
        const idx = typeof ba.index === 'number' ? ba.index + 1 : '?'
        const hint = ba.hint === 'cold-start-genesis'
          ? '—— 冷启动/热重载竞态（旧版本缺陷），非篡改迹象'
          : '—— 审计可能被篡改或写坏'
        console.log(`✗ 断链于第 ${idx} 条（${ba.reason ?? '?'}）${hint}`)
      }
    }
  }
  process.exit(v.ok && checkpoints.ok === true ? 0 : 1)
}

/* ── 0.3.0 vault / macros：人这一侧的录入通道（面板「引用库」的 CLI 等价物）──────
 * vault 只有人与面板能写 —— AI 的工具面没有写入口，只能 {{v:键名}} 引用。
 * 用法：
 *   terminalkeeper vault list
 *   terminalkeeper vault set <键> <值> [--one-shot] [--note 备注] [--audit-dir 目录]
 *   terminalkeeper vault rm <键>
 *   terminalkeeper macros list | set <名> <内容> [--scope global|conversation] [--no-submit] [--note 备注] | rm <名>
 *   terminalkeeper macros history <名> [--days 3] | restore <名> --at <ts>     # 0.3.3 (e)：读审计封链
 */
function auditDirOf() {
  return flagValue('audit-dir', join(dshHome(), 'terminalkeeper'))
}
function readJsonFile(p) { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return {} } }
// 0.3.2 ①：vault/macros 走严格读——"文件坏了"与"还没建文件"必须分开；损坏时拒绝继续，
// 绝不让 set/rm 的整表写回把可能可抢救的原文件覆盖掉。
function readDomainStrict(p, domain) {
  let raw = ''
  try { raw = readFileSync(p, 'utf8') } catch { raw = '' }
  const r = parseDomainFile(raw, domain)
  if (r.ok !== true) fail(String(r.error))
  return r.data
}
function writeJson0600(p, obj) {
  // 0.3.2 原子写：tmp+rename（与插件侧同纪）。跨进程锁不共享——文件至多旧一版，不会半截。
  const tmp = p + '.tmp-' + process.pid
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, p)
}
function positional(skip) {
  return nonOptionArgs().filter((a) => !skip.includes(a))
}

function vaultCli() {
  const sub = positional(['vault'])[0] ?? 'list'
  const dir = auditDirOf()
  const file = join(dir, 'vault.json')
  const vault = readDomainStrict(file, 'vault')
  // 0.3.0 起的 v2 是 {version:2, groups:{…}}（含密文/状态头协同）。命令行只懂旧的扁平表，
  // 直接改写会抹掉分组与密文 —— 宁可拒绝，让用户用面板或 /tk。
  if (vault !== null && typeof vault === 'object' && (Number(vault.version) === 2 || vault.groups !== undefined)) {
    fail('此 vault.json 是 v2 分组格式；命令行 vault 子命令只支持旧版扁平表。请用面板「引用库」或 /tk vault …，不要用 CLI 改写（会破坏分组/密文）')
  }
  if (sub === 'list') {
    const items = Object.entries(vault)
    if (items.length === 0) { echo('(vault 为空 —— 用 vault set <键> <值> 录入)'); return }
    for (const [k, e] of items) {
      echo(`{{v:${k}}}  ${e.oneShot === true ? '一次性' : '可重复'}  用过 ${e.uses ?? 0} 次${Number(e.ttlDays) > 0 ? `  ${Number(e.ttlDays)} 天未用自动焚` : ''}${e.note ? '  — ' + e.note : ''}`)
    }
    return
  }
  if (sub === 'set') {
    const [key, value] = positional(['vault', 'set'])
    if (!key || !/^[A-Za-z0-9_.-]{1,64}$/.test(key)) fail('键名须为字母数字._-（≤64 字符）')
    if (value === undefined) fail('用法：vault set <键> <值> [--one-shot] [--note 备注]')
    if (Buffer.byteLength(String(value), 'utf8') > 16384) fail('值过大——上限 16 KiB；更大的内容请存成文件并用路径引用')
    {
      const maxKeys = Number(process.env.DSH_TERMINALKEEPER_VAULT_MAX_KEYS ?? 2000) || 2000
      const maxBytes = Number(process.env.DSH_TERMINALKEEPER_VAULT_MAX_BYTES ?? 5 * 1024 * 1024) || 5 * 1024 * 1024
      const keysNow = Object.keys(vault).length
      if (!(key in vault) && keysNow >= maxKeys) fail(`引用库已达总键数上限 ${maxKeys}；请先删除不用的键`)
      const bytesNow = Object.values(vault).reduce((n, it) => n + Buffer.byteLength(String(it?.value ?? ''), 'utf8') + 128, 0)
      if (bytesNow + Buffer.byteLength(String(value), 'utf8') > maxBytes) fail('引用库明文总量将超过 5 MiB 上限；更大的内容请落文件')
    }
    vault[key] = {
      value, kind: flagValue('kind', 'secret'), oneShot: flag('one-shot'),
      note: flagValue('note', '').slice(0, 120),
      uses: Number(vault[key]?.uses ?? 0),
      createdAt: Number(vault[key]?.createdAt ?? Date.now()), updatedAt: Date.now(),
    }
    // 0.3.2 ③：可选 TTL（天）：N 天未被使用即自动焚毁（sweeper 执行，入账 expire 事件）
    const ttl = Number(flagValue('ttl-days', '0'))
    if (Number.isFinite(ttl) && ttl > 0) vault[key].ttlDays = Math.floor(ttl)
    mkdirSync(dir, { recursive: true })
    writeJson0600(file, vault)
    ok(`{{v:${key}}} 已保存（${vault[key].oneShot ? '一次性：注入成功即焚' : '可重复'}${ttl > 0 ? `，${Math.floor(ttl)} 天未用自动焚` : ''}）→ ${file}（0600）`)
    // 0.3.2 ②：弱形状黄条（不阻断——强度是人的决定；这里只保证"不是没人告诉你"）
    for (const w of inspectSecretStrength(value, { username: String(process.env.USER ?? process.env.LOGNAME ?? '') })) {
      echo(`  ⚠ 弱形状：${w}（仍然保存了；是否更换由你定）`)
    }
    echo('  边界：AI 只见键名，值不上屏不进账；但 output/ 留痕是原始字节流（值进过 pane 就在里面）—— 详见 SECURITY。')
    return
  }
  if (sub === 'rm') {
    const [key] = positional(['vault', 'rm'])
    if (vault[key] === undefined) fail(`没有键 ${key ?? '(缺参数)'}`)
    delete vault[key]
    writeJson0600(file, vault)
    ok(`{{v:${key}}} 已删除`)
    return
  }
  fail(`未知 vault 子命令：${sub}（list / set / rm）`)
}

function macrosCli() {
  const sub = positional(['macros'])[0] ?? 'list'
  const dir = auditDirOf()
  const file = join(dir, 'macros.json')
  const macros = readDomainStrict(file, 'macros')
  if (sub === 'list') {
    const items = Object.entries(macros)
    if (items.length === 0) { echo('(还没有宏 —— 用 macros set <名> <内容> 创建)'); return }
    for (const [k, m] of items) {
      echo(`{{m:${k}}}  scope=${m.scope ?? 'global'}  submit=${m.submit !== false}${m.note ? '  — ' + m.note : ''}\n    ${String(m.text ?? '').replace(/\n/g, '⏎').slice(0, 120)}`)
    }
    return
  }
  if (sub === 'set') {
    const [name, text] = positional(['macros', 'set'])
    if (!name || !/^[A-Za-z0-9_.-]{1,64}$/.test(name)) fail('宏名须为字母数字._-（≤64 字符）')
    if (text === undefined || text.trim() === '') fail('用法：macros set <名> <内容> [--scope global|conversation] [--no-submit] [--note 备注]')
    if (text.length > 8000) fail('宏内容超过 8000 字符')
    if (/\{\{/.test(text.replace(/\{\{\s*v:[^}]*\}\}/g, ''))) fail('宏里只准嵌 {{v:键名}}（不能嵌宏/裸键：只展开一层）')
    const scope = flagValue('scope', 'global')
    if (!['global', 'conversation'].includes(scope)) fail('--scope 只接受 global / conversation（shell 域请用面板或工具）')
    macros[name] = {
      text, scope, owner: 'cli', submit: !flag('no-submit'),
      note: flagValue('note', '').slice(0, 120),
      createdAt: Number(macros[name]?.createdAt ?? Date.now()), updatedAt: Date.now(), updatedBy: 'cli',
    }
    mkdirSync(dir, { recursive: true })
    writeJson0600(file, macros)
    ok(`{{m:${name}}} 已保存（scope=${scope}, submit=${macros[name].submit}）`)
    echo('  提示：面板/工具侧的写入会进审计封链；CLI 直写不进链 —— 重要宏建议走面板。')
    return
  }
  if (sub === 'rm') {
    const [name] = positional(['macros', 'rm'])
    if (macros[name] === undefined) fail(`没有宏 ${name ?? '(缺参数)'}`)
    delete macros[name]
    writeJson0600(file, macros)
    ok(`{{m:${name}}} 已删除`)
    return
  }
  // 0.3.3 (e)：宏历史与还原。数据源 = 审计封链（面板/工具写入都全文入链；
  // **CLI 直写不进链**，所以 CLI 写的宏没有历史 —— 如实提示，不假装能还原）。
  if (sub === 'history' || sub === 'restore') {
    const [name] = positional(['macros', sub])
    if (!name || !/^[A-Za-z0-9_.-]{1,64}$/.test(name)) fail('宏名须为字母数字._-（≤64 字符）')
    const days = Math.min(30, Math.max(1, Number(flagValue('days', '3')) || 3))
    const records = []
    const pad = (n) => String(n).padStart(2, '0')
    for (let i = 0; i < days; i += 1) {
      const d = new Date(Date.now() - i * 86400000)
      const day = `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
      try {
        for (const line of readFileSync(join(dir, `audit-${day}.jsonl`), 'utf8').split('\n')) {
          if (line === '') continue
          try {
            const r = JSON.parse(line)
            if (r?.event === 'macro' && r.decision === 'set' && r.key === name) records.push(r)
          } catch { /* 坏行跳过 */ }
        }
      } catch { /* 该天没文件 */ }
    }
    records.sort((a, b) => Number(a.ts) - Number(b.ts))
    if (records.length === 0) fail(`宏 "${name}" 最近 ${days} 天封链里没有写入记录（CLI 直写的宏不进链；面板/工具写的可用 --days 放宽）`)
    if (sub === 'history') {
      for (const r of records) {
        echo(`at=${Number(r.ts)}  ${new Date(Number(r.ts)).toISOString()}  by=${String(r.actor || r.source || '?')}  ${String(r.result ?? '')}`)
        echo(`    ${String(r.text ?? '（无内容）').replace(/\n/g, '⏎').slice(0, 200)}`)
      }
      echo(`\n还原：terminalkeeper macros restore ${name} --at <上面某个 at>`)
      return
    }
    const at = Number(flagValue('at', ''))
    if (!Number.isFinite(at)) fail('restore 需要 --at=<history 里的 ts>')
    const hit = records.find((r) => Number(r.ts) === at)
    if (hit === undefined) fail(`没有 at=${at} 的记录（先 macros history ${name} 核对）`)
    macros[name] = {
      text: String(hit.text ?? ''),
      scope: String(hit.result ?? '').split('/')[0] === 'conversation' ? 'conversation' : 'global',
      owner: 'cli', submit: !/submit=false/.test(String(hit.result ?? '')),
      note: `restore@${at}`.slice(0, 120),
      createdAt: Number(macros[name]?.createdAt ?? Date.now()), updatedAt: Date.now(), updatedBy: 'cli',
    }
    mkdirSync(dir, { recursive: true })
    writeJson0600(file, macros)
    ok(`{{m:${name}}} 已还原到 at=${at}（${new Date(at).toISOString()}）版本`)
    echo('  提示：CLI 还原是直写，不进审计封链（原版本仍在链上，随时可再还原回去）。')
    return
  }
  fail(`未知 macros 子命令：${sub}（list / set / rm / history / restore）`)
}

/**
 * 手动删除审计/留痕文件（0.3.4 功能1）。
 *
 * 与插件内部的 POST /audit-files 同一语义：**先入链一条 purge 见证，再物理删除** ——
 * 允许销毁痕迹，但"销毁动作本身"留痕。CLI 是离线工具（不依赖运行中的 DSH），
 * 链状态自己维护：读回当前 head → 追加 purge 记录 → unlink 目标文件。
 *
 *   terminalkeeper purge-audit [<审计目录>] [--kind audit|output] [--days N | --names a,b]
 *
 * 退出码：0 = 完成；2 = 用法/路径错误。
 */
/* ── 引用库备份 / 恢复（0.5.x，2026-10）────────────────────────────────────────── */
/** 数据目录探测：**跳过 flag 的值**（`--days 7` 里的 7 不是目录 —— purge-audit 踩过这个坑）。 */
function dataDirArg (_flagNames, skip = []) {
  return positionalAfter('backup', skip)[0] ?? join(dshHome(), 'terminalkeeper')
}

/** 数据目录必须是**目录** —— 否则极可能有人把备份文件当成了目录（实测踩到：restore 写成 ENOTDIR）。 */
function requireDataDir (dir) {
  try {
    if (existsSync(dir) === true && statSync(dir).isDirectory() !== true) {
      fail(`数据目录不是目录：${dir}（是不是把**备份文件**当成了数据目录？用法：restore <备份文件> [<数据目录>]）`)
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  return dir
}

/** 默认备份名已被占用时追加 -1/-2…（绝不静默覆盖）；显式 --out 则要求 --force。 */
function uniqueBackupPath (base) {
  const suffix = base.endsWith('.json') ? '.json' : ''
  const stem = suffix === '' ? base : base.slice(0, -suffix.length)
  for (let i = 1; i < 1000; i += 1) {
    const candidate = `${stem}-${i}${suffix}`
    if (existsSync(candidate) !== true) return candidate
  }
  fail(`找不到可用的备份文件名（${base} 附近已有太多同名文件）`)
}

/** 写入备份：新文件用 wx 原子创建（存在即失败）；--force 用临时文件 + rename 覆盖并保证 0600。 */
function writeBackupFile (out, text, { force = false } = {}) {
  if (force !== true) {
    let fd
    let created = false
    try {
      fd = openSync(out, 'wx', 0o600)
      created = true
      fchmodSync(fd, 0o600)
      writeFileSync(fd, text)
      closeSync(fd)
      fd = undefined
    } catch (error) {
      if (fd !== undefined) { try { closeSync(fd) } catch { /* 已关 */ } }
      if (created === true) { try { unlinkSync(out) } catch { /* 清理失败不掩盖原错误 */ } }
      if (error?.code === 'EEXIST') fail(`备份文件已存在：${out}（**不会覆盖**；请换路径，或确认后加 --force）`)
      fail(`写入备份失败：${String(error?.message ?? error)}`)
    }
  } else {
    try {
      writePrivateAtomic(dirname(out), basename(out), text)
    } catch (error) {
      fail(`写入备份失败：${String(error?.message ?? error)}`)
    }
  }
  chmodSync(out, 0o600)
}

async function backupCli () {
  const { createBackup } = await import('../lib/backup.mjs')
  const dir = requireDataDir(dataDirArg())
  // 默认写到 $HOME，绝不落在当前目录：备份可能含秘密，避免被误收进项目或同步目录。
  // 想放别处请显式 --out。
  const explicitOut = flagValue('out', undefined) !== undefined
  let out = flagValue('out', join(homedir(), 'terminalkeeper-backup-' + Date.now() + '.json'))
  const force = flag('force')
  if (existsSync(out) && force !== true) {
    if (explicitOut === true) fail(`备份文件已存在：${out}（**不会覆盖**；请换路径，或确认后加 --force）`)
    out = uniqueBackupPath(out)
  }
  const includeDeviceKey = flag('include-device-key')
  const passphrase = flagValue('passphrase', '')
  const r = createBackup(dir, {
    includeDeviceKey, passphrase,
    pluginVersion: (() => { try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version } catch { return '' } })(),
  })
  if (r.ok !== true) fail(r.error)
  const summary = r.summary
  echo(`将写入备份：${out}`)
  echo(`  数据目录：${dir}`)
  echo(`  文件数：${summary.files}${summary.missing.length > 0 ? `（缺失跳过：${summary.missing.join(', ')}）` : ''}`)
  echo(`  整包加密：${summary.encrypted ? '✓（scrypt + AES-256-GCM）' : '✗ **未加密**'}`)
  if (summary.encrypted !== true) {
    echo('  ⚠ 未加密的备份包含与 vault.json 同级的秘密（none 模式组本就是明文）——')
    echo('    请用 --passphrase <口令> 加密后再放到机器之外，或确认后加 --yes 落盘。')
  }
  if (includeDeviceKey === true) {
    echo('  ⚠ 已包含 device.key：该备份可直接在别的机器恢复**设备绑定**的组，但整包本身即为高危凭据，务必加密保管。')
  }
  if (flag('yes') !== true) { echo('确认请加 --yes。'); process.exit(0) }
  writeBackupFile(out, r.text, { force })
  ok(`备份已写入 ${out}（${Buffer.byteLength(r.text)} 字节，权限 600${force ? '，已覆盖' : ''}）`)
}

async function restoreCli () {
  const { readBackup, restoreBackup } = await import('../lib/backup.mjs')
  // ⚠ restore **绝不猜**数据目录：实测把参数传错时（同一路径给两次）它会回落到默认目录，
  //   于是准备写入真实数据目录 —— 覆盖式恢复绝不能有这种"猜"。目录必须显式给。
  const pos = positionalAfter('restore')
  const file = pos[0]
  const dir = pos[1]
  if (file === undefined) fail('用法：terminalkeeper restore <备份文件> <数据目录> [--passphrase <口令>] [--yes]')
  if (dir === undefined) fail('缺少数据目录：为避免恢复写错地方，这里**不猜**默认目录 —— 请显式给出 restore <备份文件> <数据目录>')
  requireDataDir(dir)
  if (existsSync(file) !== true) fail(`备份文件不存在：${file}`)
  const r = readBackup(readFileSync(file, 'utf8'), { passphrase: flagValue('passphrase', '') })
  if (r.ok !== true) fail(r.error)
  if (r.envelope.includeDeviceKey === true) echo('⚠ 该备份包含 device.key：恢复会覆盖本机的设备密钥（影响设备绑定组）。')
  const plan = restoreBackup(dir, { files: r.files })
  echo(`将从备份恢复到：${dir}`)
  for (const p of plan.plan) echo(`  - ${p.name}（${p.bytes} 字节${p.overwrite ? '，**将覆盖**（先改名 .pre-restore-*.bak）' : ''}）`)
  if (flag('yes') !== true) { echo('确认请加 --yes。这是**覆盖式**写入（现有文件会先改名为 .pre-restore-<时间戳>.bak）。'); process.exit(0) }
  const w = restoreBackup(dir, { files: r.files, yes: true })
  if (w.ok !== true) fail(w.error)
  ok(`已恢复 ${w.written.length} 个文件${w.backedUp.length > 0 ? `，原有 ${w.backedUp.length} 个已改名为 .pre-restore-*.bak` : ''}`)
  echo('提示：口令加密组在恢复后仍需原口令解锁；none 模式组恢复即可用。')
}

async function purgeAudit () {
  // REL-03：这里原先只有 dirCand（从未声明 dir），--yes 分支必崩 ReferenceError。
  // 目录探测统一走 nonOptionArgs（跳过 --days 7 这类 flag 的值）。
  const dir = resolve(positionalAfter('purge-audit')[0] ?? join(dshHome(), 'terminalkeeper'))
  if (existsSync(dir) !== true) { console.error(`✗ 审计目录不存在：${dir}`); process.exit(2) }
  const kind = flagValue('kind', 'audit')
  if (!['audit', 'output'].includes(kind)) { fail('--kind 只能取 audit / output'); process.exit(2) }
  const { readSealedChain, chainHeadOf, appendAudit, auditPaths, dayKey, listOutputFiles, auditFileNames } = await import('../lib/audit.js')
  const paths = auditPaths(dir)
  const { createHash } = await import('node:crypto')
  const shasum = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16)
  const namesArg = flagValue('names', '')
  const targetDir = kind === 'audit' ? dir : paths.outputDir
  const targets = []
  if (kind === 'audit') {
    const files = await auditFileNames(paths)
    const daysRaw = flagValue('days', '')
    const daysNum = daysRaw === '' ? null : Number.parseInt(daysRaw, 10)
    if (namesArg !== '' && daysNum !== null) {
      // 两个筛选条件同时给会让“到底删哪个”变成隐式优先级；宁可报错让调用方明确意图。
      console.error('✗ --days 与 --names 只能给一个（前者按保留天数，后者按文件名）')
      process.exit(2)
    }
    if (namesArg !== '') {
      const want = namesArg.split(',').map((s) => s.trim()).filter(Boolean)
      targets.push(...files.filter((n) => want.includes(n)))
    } else if (daysNum !== null && Number.isFinite(daysNum) && daysNum >= 0) {
      // --days N = 保留最近 N 天（含今天），删除更早的文件；N=0 = 全删（含今天）。
      // cutoff 是“保留窗口的起点”：日期 < cutoff 才会被删。
      //   旧写法 cutoff = 今天+(N+1) 天且用 `<` ⇒ 任何 N 都会命中全部文件（复审实测会清空审计）。
      const now = new Date()
      const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
      const cutoff = daysNum === 0 ? todayUtc + 86400000 : todayUtc - (daysNum - 1) * 86400000
      const dayStamp = (n) => {
        const m = /^audit-(\d{4})-(\d{2})-(\d{2})\.jsonl$/.exec(n)
        return m === null ? Number.NaN : Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`)
      }
      targets.push(...files.filter((n) => Number.isFinite(dayStamp(n)) && dayStamp(n) < cutoff))
    }
  } else {
    const files = await listOutputFiles(paths)
    const want = namesArg.split(',').map((s) => s.trim()).filter(Boolean)
    targets.push(...files.map((f) => f.name).filter((n) => want.includes(n)))
  }
  // 白名单（与插件内同一套）：审计文件 / dsh-*.log 与 frames-*.jsonl 留痕
  const allow = (n) => kind === 'audit'
    ? /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)
    : /^(dsh-|frames-).+(\.log|\.jsonl)$/.test(n)
  const target = [...new Set(targets)].filter((n) => n !== '' && allow(n))
  if (target.length === 0) { console.error('✗ 没有可删除的目标（--days/--names 没匹配到白名单内文件）'); process.exit(2) }
  if (!flag('yes')) {
    echo(`将删除 ${target.length} 个${kind === 'audit' ? '审计' : '留痕'}文件（先入链 purge 见证再删）:`)
    for (const n of target) echo(`  - ${n}`)
    echo('这是**不可逆**操作。确认请加 --yes。')
    process.exit(0)
  }
  // ① 先取哈希（删除前文件还在）；② 物理删除；③ 事后入链见证
  //   （见证必须写在删除**之后**：若先写再删，见证会落进被删的同一天文件里一起消失）
  const header = await readSealedChain(paths)
  const hashes = {}
  const { readFileSync } = await import('node:fs')
  for (const n of target) {
    try { hashes[n] = shasum(readFileSync(join(targetDir, n))) } catch { hashes[n] = 'unreadable' }
  }
  const { unlinkSync } = await import('node:fs')
  let removed = 0
  const failed = []
  for (const n of target) {
    try { unlinkSync(join(targetDir, n)); removed += 1; echo(`  ✓ 已删 ${n}`) }
    catch (e) { failed.push(n); echo(`  ✗ 删除失败 ${n}：${String(e?.message ?? e)}`) }
  }
  if (removed > 0) {
    const today = dayKey(Date.now())
    const chain = { head: chainHeadOf(header.records), seq: 0 }
    await appendAudit(paths, today, {
      ts: Date.now(), event: 'purge', shell: '', source: 'cli', actor: 'user',
      decision: 'user-initiated', kind,
      files: removed === target.length
        ? target.map((n) => `${n} sha256:${hashes[n] ?? '?'}`)
        : target.filter((n) => !failed.includes(n)).map((n) => `${n} sha256:${hashes[n] ?? '?'}`),
      result: `${removed}/${target.length} 个文件`,
    }, chain)
  }
  echo(`完成：删除 ${removed}/${target.length}，purge 见证已封链（审计目录 ${dir}）`)
  process.exit(0)
}

// REL-05：子命令只认**首个非选项位置参数**。此前 `args.includes('install')` 会把
// `backup ./install` 的目录参数当成 install 子命令，进而改 profile、跑包管理器。
const command = commandName()
switch (command) {
  case 'install': install(); break
  case 'uninstall': uninstall(); break
  case 'doctor': doctor(); break
  case 'vault': vaultCli(); break
  case 'macros': macrosCli(); break
  case 'chain-repair': await repairChain(); break
  case 'verify-audit': await verifyAudit(); break
  case 'purge-data': purgeData(); break
  case 'purge-audit': await purgeAudit(); break
  case 'backup': await backupCli(); break
  case 'restore': await restoreCli(); break
  case undefined:
    fail('缺少子命令（用 --help 看用法）')
    break
  default:
    fail(`未知命令：${command}（用 --help 看用法）`)
}