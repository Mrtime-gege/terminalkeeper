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
 *   2. 按 profile 的包管理器（pnpm/npm/yarn）装依赖；
 *   3. 检查 tmux（跑包的 install-deps.sh --check 同款逻辑）；
 *   4. 提示重启 `dsh web` 生效。
 *
 * 零外部依赖（只用 Node 内建），可离线跑。
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { inspectSecretStrength, parseDomainFile } from '../lib/pure.mjs'
import { applyDisposition, readDisposition, writeDisposition } from '../lib/disposition.mjs'

const PKG = 'terminalkeeper'
// 版本来自包自身（npx 装下来的就是它）
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const flagValue = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback
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

  // 发布前置校验：远程版本存在才装（否则 pnpm 对 ^0.2.2 报 No matching version，用户看不懂）。
  // 本地开发（file: 依赖 / dev-sync）不经过本命令，所以这里放心检查 registry。
  const probe = spawnSync('npm', ['view', `${PKG}@${semver}`, 'version'], { encoding: 'utf8', timeout: 20000 })
  const remoteHas = probe.status === 0 && String(probe.stdout ?? '').split(/\s+/).filter(Boolean).length > 0
  if (dryRun) {
    echo(remoteHas ? `（npm 上已有 ${PKG}@${semver}）` : `⚠ npm 上还没有 ${PKG}@${semver} —— 推 v${semver} tag 后 CI 会自动发布`)
  } else if (!remoteHas) {
    fail(`${PKG}@${semver} 还没有发布到 npm。发布由 GitHub 自动完成：git tag v${semver} && git push origin v${semver}
    · 本地开发请用 profile 的 file: 依赖（不走本命令）`)
  }

  const pm = packageManagerOf(root)
  echo(`1) 登记依赖与 bundle`)
  echo(`   dependencies.${PKG} = ^${semver}；dsh.profile.bundles += ${PKG}`)
  if (dryRun) {
    echo(`2) 将按 ${pm} 在 ${root} 安装依赖`)
    echo(`3) tmux 检查：${tmuxCheck() || '缺 tmux（按 install-deps.sh 的指引装）'}`)
    echo(`\n（未做任何修改 —— --dry-run）`)
    return
  }
  if (before !== after) writeFileSync(join(root, 'package.json'), after + '\n')
  ok('package.json 已登记依赖与 bundle')

  echo(`2) 安装依赖（${pm} install …）`)
  const r = spawnSync(pm, ['install'], { cwd: root, stdio: 'inherit', shell: false })
  if (r.status !== 0) fail(`${pm} install 失败（exit ${r.status}）`)
  ok(`${pm} install 完成`)

  echo(`3) tmux 检查`)
  const tmux = tmuxCheck()
  if (tmux === '') {
    echo('   ⚠ 缺 tmux —— 插件本体需要它：')
    echo('     Debian/Ubuntu: sudo apt-get install -y tmux')
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

function purgeData(dirArg = undefined, opts = {}) {
  const dryRun = opts.dryRun ?? flag('dry-run')
  const yes = opts.yes ?? flag('yes')
  const dir = dirArg ?? args.find((a) => !a.startsWith('--') && a !== 'purge-data') ?? join(dshHome(), 'terminalkeeper')
  if (existsSync(dir) !== true) { echo(`数据目录不存在：${dir}`); return }
  if (!yes && !dryRun) fail('purge-data 会删除审计/留痕/引用库等数据；确认请加 --yes（先 --dry-run 预览）')
  const prior = readDisposition(dir)
  writeDisposition(dir, 'purge')
  const result = applyDisposition(dir, { dryRun })
  writeDisposition(dir, prior)
  echo(`数据目录：${dir}`)
  echo(`处置：${dryRun ? 'DRY-RUN' : 'purge'}${dryRun ? '' : '（按白名单删除；锁定组 vault.* 会保留）'}`)
  if (result.removed.length > 0) echo('删除：' + result.removed.join(', '))
  if (result.kept.length > 0) echo('保留：' + result.kept.join(', '))
  for (const note of result.notes) echo('说明：' + note)
}

function doctor() {
  echo(`\nterminalkeeper@${VERSION} 体检\n`)
  const tmux = tmuxCheck()
  tmux === '' ? fail('✗ 缺 tmux（apt/pacman/apk/pkg 装一下）') : ok(`tmux ${tmux}`)

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
  terminalkeeper uninstall [--profile <name>] [--dry-run] [--purge --yes]  从 profile 移除；--purge 清理数据         从 profile 移除
  terminalkeeper purge-data [<数据目录>] [--dry-run] [--yes]     显式清理本插件数据（白名单；锁定 vault 保留）
  terminalkeeper doctor                                           体检：tmux / 安装状态 / 数据目录
  terminalkeeper verify-audit [<审计目录>] [--json]               离线复验审计哈希链（默认 ~/.dsh/terminalkeeper）
  terminalkeeper purge-audit [<审计目录>] [--kind audit|output] 手动删除审计/留痕文件（**先入链 purge 见证再删**；
      [--days N | --names a,b] [--yes]
 *   terminalkeeper backup [<数据目录>] [--out <文件>] [--passphrase <口令>] [--include-device-key] [--yes]
 *   terminalkeeper restore <备份文件> <数据目录> [--passphrase <口令>] [--yes]   # 数据目录必须显式给出（不猜）                                --days 删 N 天前的审计文件；--names 精确删指定文件；--yes 跳过确认）
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
  const dir = args.find((a) => !a.startsWith('--') && a !== 'chain-repair') ??
    join(homedir(), '.dsh', 'terminalkeeper')
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
  const dir = args.find((a) => !a.startsWith('--') && a !== 'verify-audit' && a !== 'doctor' && a !== 'install' && a !== 'uninstall') ??
    join(homedir(), '.dsh', 'terminalkeeper')
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
  return args.filter((a) => !a.startsWith('--') && !skip.includes(a))
}

function vaultCli() {
  const sub = positional(['vault'])[0] ?? 'list'
  const dir = auditDirOf()
  const file = join(dir, 'vault.json')
  const vault = readDomainStrict(file, 'vault')
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
function dataDirArg (flagNames, skip = []) {
  return args.filter((a, i) => {
    if (a.startsWith('--')) return false
    const prev = args[i - 1]
    return !(typeof prev === 'string' && flagNames.includes(prev))
  }).find((a) => !skip.includes(a) && !['backup', 'restore', 'purge-audit', 'doctor', 'install', 'uninstall', 'verify-audit'].includes(a))
    ?? join(homedir(), '.dsh', 'terminalkeeper')
}

/** 数据目录必须是**目录** —— 否则极可能有人把备份文件当成了目录（实测踩到：restore 写成 ENOTDIR）。 */
function requireDataDir (dir) {
  try {
    if (existsSync(dir) === true && statSync(dir).isDirectory() !== true) {
      fail(`数据目录不是目录：${dir}（是不是把**备份文件**当成了数据目录？用法：restore <备份文件> [<数据目录>]）`)
    }
  } catch { /* 不存在则交给后续流程创建 */ }
  return dir
}

async function backupCli () {
  const { createBackup } = await import('../lib/backup.mjs')
  const dir = requireDataDir(dataDirArg(['--out', '--passphrase']))
  // 默认写到 $HOME，**绝不落在当前目录**：刚才实测默认落点正好在仓库里 —— 一份含秘密的备份
  // 若被 `git add -A` 带进提交就完了。想放别处请显式 --out。
  const out = flagValue('out', join(homedir(), 'terminalkeeper-backup-' + Date.now() + '.json'))
  const includeDeviceKey = flag('include-device-key')
  const passphrase = flagValue('passphrase', '')
  const r = createBackup(dir, {
    includeDeviceKey, passphrase,
    pluginVersion: (() => { try { return JSON.parse(readFileSync(join(new URL('..', import.meta.url).pathname, 'package.json'), 'utf8')).version } catch { return '' } })(),
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
  writeFileSync(out, r.text, { mode: 0o600 })
  ok(`备份已写入 ${out}（${Buffer.byteLength(r.text)} 字节，权限 600）`)
}

async function restoreCli () {
  const { readBackup, restoreBackup } = await import('../lib/backup.mjs')
  // ⚠ restore **绝不猜**数据目录：实测把参数传错时（同一路径给两次）它会回落到默认目录，
  //   于是准备写入真实数据目录 —— 覆盖式恢复绝不能有这种"猜"。目录必须显式给。
  const pos = args.filter((a, i) => !a.startsWith('--') && a !== 'restore' && args[i - 1] !== '--passphrase')
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
  // ⚠ 目录探测必须跳过 **flag 的值**：args.find 会把 `--days 7` 里的 "7" 当成目录
  //   （实测：不显式给目录时，purge-audit 去 ./7 找文件 ⇒ 永远报"没有可删除的目标"）。
  const flagNames = ['--kind', '--days', '--names']
  const dirCand = args.filter((a, i) => {
    if (a.startsWith('--')) return false
    const prev = args[i - 1]
    return !(typeof prev === 'string' && flagNames.includes(prev))
  }).find((a) => a !== 'purge-audit' && a !== 'doctor' && a !== 'install' && a !== 'uninstall' && a !== 'verify-audit' && a !== 'vault' && a !== 'macros') ??
    join(homedir(), '.dsh', 'terminalkeeper')
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
    const daysNum = Number.parseInt(flagValue('days', '3650'), 10)
    if (Number.isFinite(daysNum) && daysNum >= 0) {
      // --days N = 保留最近 N 天（与插件 auditRetentionDays 同语义）：删除更早的文件。
      //   --days 0  → 全删（cutoff = 昨天零点）
      //   --days 30 → 保留最近 30 天，更早的删
      const cutoff = Date.now() - (daysNum + 1) * 86400000
      const dayStamp = (n) => {
        const m = /^audit-(\d{4})-(\d{2})-(\d{2})\.jsonl$/.exec(n)
        return m === null ? Number.NaN : Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`)
      }
      targets.push(...files.filter((n) => Number.isFinite(dayStamp(n)) && dayStamp(n) < cutoff))
    } else if (namesArg !== '') {
      const want = namesArg.split(',').map((s) => s.trim()).filter(Boolean)
      targets.push(...files.filter((n) => want.includes(n)))
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

if (args.includes('install')) { install(); process.exit(0) }
if (args.includes('uninstall')) { uninstall(); process.exit(0) }
if (args.includes('doctor')) { doctor(); process.exit(0) }
if (args.includes('vault')) { vaultCli(); process.exit(0) }
if (args.includes('macros')) { macrosCli(); process.exit(0) }
if (args.includes('chain-repair')) { await repairChain() }
if (args.includes('verify-audit')) { await verifyAudit() }
if (args.includes('purge-data')) { purgeData(); process.exit(0) }
if (args.includes('purge-audit')) { await purgeAudit() }
if (args[0] === 'backup') await backupCli()
else if (args[0] === 'restore') await restoreCli()
else fail(`未知命令：${args[0] ?? ''}（用 --help 看用法）`)