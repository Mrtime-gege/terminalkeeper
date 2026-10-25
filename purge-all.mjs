#!/usr/bin/env node
/**
 * 彻底清理 terminalkeeper 可能遗留的文件/进程（默认 dry-run）。
 *
 * 清理范围（只限本插件）：
 *   · 数据目录 ~/.dsh/terminalkeeper（审计、引用库、快照、回放、配置、supervisor）
 *   · supervisor daemon / watchdog 进程（仅当 cmdline 确属本插件）
 *   · 私有 tmux server（默认 socket terminalkeeper）及其会话
 *   · /tmp/<socket>-watchdog.{pid,lease}、<socket>-tmux.conf
 *   · 当前 profile 里本插件的依赖/bundle 行与 node_modules 包
 *
 * 用法：
 *   node purge-all.mjs                 # 只打印将删什么
 *   node purge-all.mjs --yes           # 真正执行
 *   node purge-all.mjs --data-dir DIR --profile web --socket terminalkeeper --yes
 *   node purge-all.mjs --mirror /path  # 额外清理自定义审计镜像目录（危险：仅你确认的目录）
 *
 * 注意：不删除其他插件/其他 profile；不自动删除未知自定义镜像（必须显式 --mirror）。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const has = (name) => args.includes(`--${name}`)
const valueOf = (name, fallback = undefined) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const yes = has('yes')
const dryRun = !yes
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const dataDir = valueOf('data-dir', join(dshHome, 'terminalkeeper'))
const profileName = valueOf('profile', process.env.DSH_PROFILE || 'web')
const profileDir = valueOf('profile-dir', process.env.DSH_PROFILE_DIR || join(dshHome, 'profiles', profileName))
const socket = valueOf('socket', 'terminalkeeper')
const mirror = valueOf('mirror', '')
const actions = []
const warnings = []

const add = (label, fn) => actions.push({ label, fn })
const rel = (p) => p.replace(homedir(), '~')

function readPid (file) {
  try { return Number.parseInt(readFileSync(file, 'utf8').trim(), 10) || 0 } catch { return 0 }
}
function cmdline (pid) {
  try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ') } catch { return '' }
}
function alive (pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch { return false }
}
function stopPluginProcess (pid, kind) {
  if (!alive(pid)) return
  const cmd = cmdline(pid)
  if (!/terminalkeeper|supervisor\/daemon\.mjs|watchdog\.mjs/.test(cmd)) {
    warnings.push(`${kind} pid ${pid} 的 cmdline 不像本插件，跳过：${cmd.slice(0, 160)}`)
    return
  }
  add(`停止 ${kind} pid ${pid}（${cmd.slice(0, 80)}）`, () => {
    try { process.kill(pid, 'SIGTERM') } catch { /* 已退出 */ }
    const end = Date.now() + 3000
    while (Date.now() < end && alive(pid)) {
      try { execFileSync('sleep', ['0.1']) } catch { /* 忽略 */ }
    }
    if (alive(pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* 忽略 */ } }
  })
}
function killTmuxServer () {
  add(`关闭私有 tmux server（tmux -L ${socket}）`, () => {
    try { execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }) } catch { /* 已无服务端 */ }
  })
}
function removePath (label, path) {
  if (!existsSync(path)) return
  add(`${label}：${rel(path)}`, () => {
    try { rmSync(path, { recursive: true, force: true }) } catch (error) { warnings.push(`${path} 删除失败：${String(error?.message ?? error)}`) }
  })
}
function removeProfileEntry () {
  const pkgFile = join(profileDir, 'package.json')
  if (!existsSync(pkgFile)) { warnings.push(`profile 不存在或没有 package.json：${rel(profileDir)}`); return }
  let json = null
  try { json = JSON.parse(readFileSync(pkgFile, 'utf8')) } catch { warnings.push(`profile package.json 无法解析：${rel(pkgFile)}`); return }
  const hasDep = json?.dependencies?.['terminalkeeper'] !== undefined
  const bundles = Array.isArray(json?.dsh?.profile?.bundles) ? json.dsh.profile.bundles : []
  const hasBundle = bundles.includes('terminalkeeper')
  if (!hasDep && !hasBundle) return
  add(`从 profile「${profileName}」移除依赖/bundle 行`, () => {
    if (hasDep) delete json.dependencies['terminalkeeper']
    if (hasBundle) json.dsh.profile.bundles = bundles.filter((b) => b !== 'terminalkeeper')
    writeFileSync(pkgFile, JSON.stringify(json, null, 2) + '\n')
  })
  removePath('profile node_modules 包', join(profileDir, 'node_modules', 'terminalkeeper'))
  const pnpm = join(profileDir, 'node_modules', '.pnpm')
  if (existsSync(pnpm)) {
    for (const name of readdirSync(pnpm)) {
      if (name.startsWith('terminalkeeper@')) removePath('profile pnpm 包', join(pnpm, name))
    }
  }
}

// 1) 进程：supervisor → watchdog（顺序避免 daemon 重新拉起/续租）
const supervisorPid = readPid(join(dataDir, 'supervisor', 'supervisor.pid')) || readPid(join(dataDir, 'supervisor.pid'))
stopPluginProcess(supervisorPid, 'supervisor')
stopPluginProcess(readPid(join(tmpdir(), `${socket}-watchdog.pid`)), 'watchdog')
// 2) tmux 私有服务端
killTmuxServer()
// 3) 临时文件
removePath('watchdog pid', join(tmpdir(), `${socket}-watchdog.pid`))
removePath('watchdog lease', join(tmpdir(), `${socket}-watchdog.lease`))
removePath('tmux 配置', join(tmpdir(), `${socket}-tmux.conf`))
// 4) 数据目录（整个插件数据域；这是“全部文件”的核心）
removePath('插件数据目录', dataDir)
// 5) profile 依赖/bundle 与包文件
removeProfileEntry()
// 6) 可选自定义镜像（绝不猜测）
if (mirror !== '') removePath('自定义审计镜像', mirror)

console.log(`${dryRun ? '[dry-run] 将' : '将'}清理 terminalkeeper 遗留：`)
for (const a of actions) console.log(`  · ${a.label}`)
if (actions.length === 0) console.log('  （没有发现需要清理的遗留）')
for (const w of warnings) console.log(`  ! ${w}`)
if (dryRun) {
  console.log('\n这是 dry-run，未删除任何东西。确认后加 --yes。')
  process.exit(0)
}
let failed = 0
for (const a of actions) {
  try { a.fn() } catch (error) {
    failed += 1
    console.error(`  ✗ ${a.label}：${String(error?.message ?? error)}`)
  }
}
console.log(failed === 0 ? '\n清理完成 ✓' : `\n清理完成，${failed} 项失败（见上）`)
process.exit(failed === 0 ? 0 : 1)