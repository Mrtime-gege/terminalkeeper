/**
 * terminalkeeper —— supervisor 线协议
 *
 * 独立于 DSH 插件 fiber 的监督域使用这份协议与插件核心通信。
 * 设计约束：
 *   - 只走本机 Unix socket（0600）；不做网络监听。
 *   - 一行一个 JSON 帧（NDJSON）；请求/响应都带 id。
 *   - 协议版本独立于插件版本；不兼容必须显式拒绝，不能静默降级。
 *   - 协议层不导入 DSH 包；daemon 可单独启动、单独测试。
 */

import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const PROTOCOL_VERSION = 1
export const DAEMON_VERSION = '0.3.0'
export const DAEMON_BUILD = 'c102'
export const DEFAULT_DIR = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'terminalkeeper')

/** socket/token/pid 的稳定路径；测试可传自定义目录。 */
export function supervisorPaths (dir = DEFAULT_DIR) {
  const base = String(dir)
  return {
    dir: base,
    socket: join(base, 'supervisor.sock'),
    token: join(base, 'supervisor.token'),
    pid: join(base, 'supervisor.pid'),
    lock: join(base, 'supervisor.lock'),
  }
}

/** 创建目录（0700）并确保 token 存在（0600）。返回 token 字符串。 */
export function ensureToken (dir = DEFAULT_DIR) {
  const paths = supervisorPaths(dir)
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 })
  try { chmodSync(paths.dir, 0o700) } catch { /* 非 POSIX 忽略 */ }
  if (existsSync(paths.token)) {
    const token = readFileSync(paths.token, 'utf8').trim()
    if (token.length >= 16) return token
  }
  const token = randomBytes(24).toString('hex')
  writeFileSync(paths.token, token + '\n', { mode: 0o600 })
  try { chmodSync(paths.token, 0o600) } catch { /* 非 POSIX 忽略 */ }
  return token
}

export function readToken (dir = DEFAULT_DIR) {
  const p = supervisorPaths(dir).token
  if (!existsSync(p)) return ''
  return readFileSync(p, 'utf8').trim()
}

/** token 的短指纹，仅用于日志/诊断，不泄露原值。 */
export function tokenFingerprint (token) {
  return createHash('sha256').update(String(token)).digest('hex').slice(0, 12)
}

export function encodeFrame (value) {
  return JSON.stringify(value) + '\n'
}

/** 从 NDJSON 缓冲中切出完整帧；返回 [frames, rest]。坏帧由调用方拒绝。 */
export function takeFrames (buffer) {
  const text = String(buffer)
  const lines = text.split('\n')
  const rest = lines.pop() ?? ''
  const frames = []
  for (const line of lines) {
    if (line.trim() === '') continue
    frames.push(line)
  }
  return [frames, rest]
}

export function validateRequest (value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'request must be an object'
  if (typeof value.id !== 'string' || value.id === '') return 'request.id must be a non-empty string'
  if (typeof value.method !== 'string' || value.method === '') return 'request.method must be a non-empty string'
  if (value.params !== undefined && (value.params === null || typeof value.params !== 'object' || Array.isArray(value.params))) {
    return 'request.params must be an object'
  }
  return ''
}

export function ok (id, result, extra = {}) {
  return { id, ok: true, result, ...extra }
}

export function fail (id, code, message, extra = {}) {
  return { id, ok: false, error: { code, message }, ...extra }
}

// ── 位置参数归一化（SUP-01） ─────────────────────────────────────────────────
//
// JSON 线格式没有 `undefined`：core 的 Proxy 把缺省实参连续列化成 `null`（即便删掉
// 那行 map，`JSON.stringify` 也会这么干）。daemon 若原样 `driver()[method](...args)`，
// `captureWithMeta(name, null)` 就会命中 `lines === undefined ? 全量 : -S -null` 的
// 错误分支，整条读屏链路失败。这里按方法声明哪些**尾部位置参数是可选的**，把可选位上
// 的 `null` 还原成 `undefined`，使 daemon 侧语义与直接调用 driver 完全一致。
//
// 只归一化**可选位**：必选参数上的 null 仍然原样传下去（让 driver 报错），不做猜测。
const OPTIONAL_FROM = Object.freeze({
  // captureWithMeta(name, lines?, options?)
  captureWithMeta: 1,
  // screen(name, lines?, options?)
  screen: 1,
  // paneCpu(name, sampleMs?)
  paneCpu: 1,
  // bootstrap(options?)
  bootstrap: 0,
  // send(name, text, keys, options?)
  send: 3,
})

export function normalizeTmuxCallArgs (method, args) {
  if (!Array.isArray(args)) return []
  const from = OPTIONAL_FROM[String(method ?? '')]
  if (from === undefined) return args.slice()
  return args.map((value, index) => (index >= from && value === null ? undefined : value))
}

// ── probe 的完整 argv 白名单（SUP-06） ──────────────────────────────────────
//
// 只校验 args[0] 属于几个「只读 verb」是不够的：tmux 允许用**独立的 `;` 参数**
// 串联多条命令，`['display-message', '-p', ';', 'kill-server']` 因此能绕过白名单。
// 这里按 verb 做完整的 argv 校验：只允许固定 flag/位置参数集合，拒绝任何 `;`、
// 换行、NUL 与未列入白名单的 flag/参数。合法调用点见 index.js 的 driver.probe：
//   ['display', '-p', '-t', name, '-F', fmt]
//   ['show-options', '-gw', 'remain-on-exit']
//   ['list-sessions', '-F', '#{session_name}']
export const PROBE_VERBS = Object.freeze([
  'display', 'display-message', 'show-options', 'show-option',
  'list-sessions', 'ls', 'list-windows', 'list-panes',
])

const PROBE_SPECS = Object.freeze({
  display: { flags: 'pFt', valueFlags: 'Ft', positional: 0 },
  'display-message': { flags: 'pFt', valueFlags: 'Ft', positional: 0 },
  'show-options': { flags: 'gwsvqt', valueFlags: 't', positional: 1 },
  'show-option': { flags: 'gwsvqt', valueFlags: 't', positional: 1 },
  'list-sessions': { flags: 'Ft', valueFlags: 'Ft', positional: 0 },
  ls: { flags: 'Ft', valueFlags: 'Ft', positional: 0 },
  'list-windows': { flags: 'aFt', valueFlags: 'Ft', positional: 0 },
  'list-panes': { flags: 'aFt', valueFlags: 'Ft', positional: 0 },
})

const MAX_PROBE_ARGS = 64
const MAX_PROBE_ARG_LEN = 512
const SAFE_TARGET = /^[A-Za-z0-9_=:@.\-]{1,64}$/
const SAFE_OPTION_NAME = /^[A-Za-z0-9@._\-]{1,64}$/

function hasControlOrSeparator (value) {
  return value.includes(';') || value.includes('\n') || value.includes('\r') || value.includes('\0')
}

function validateTarget (value) {
  if (!SAFE_TARGET.test(value)) return `probe target is not a safe session name: ${JSON.stringify(value.slice(0, 40))}`
  return ''
}

function validateFormat (value) {
  // 格式串只用于输出（display-message -F / list-panes -F），不参与命令解析；
  // 但仍拒绝控制字符与分号，避免未来任何「拼回命令行」的用法把它变成注入面。
  if (value.length > MAX_PROBE_ARG_LEN) return 'probe format is too long'
  if (hasControlOrSeparator(value)) return 'probe format contains a control character or command separator'
  return ''
}

/** 校验一次 probe 的完整 argv（不含 `tmux -L ...` 前缀）。返回错误字符串，空串 = 通过。 */
export function validateProbeArgv (argv) {
  if (!Array.isArray(argv) || argv.length === 0) return 'probe argv is empty'
  if (argv.length > MAX_PROBE_ARGS) return `probe argv has too many arguments (${argv.length} > ${MAX_PROBE_ARGS})`
  for (const value of argv) {
    if (typeof value !== 'string') return 'probe argv must contain strings only'
    if (value.length > MAX_PROBE_ARG_LEN) return 'probe argument is too long'
    if (value === '') return 'probe argument must not be empty'
    if (hasControlOrSeparator(value)) return 'probe argument contains a control character or command separator'
  }
  const verb = argv[0]
  const spec = PROBE_SPECS[verb]
  if (spec === undefined) return `probe verb ${JSON.stringify(verb.slice(0, 40))} is not read-only`
  const rest = argv.slice(1)
  let positionalLeft = spec.positional
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]
    if (arg.startsWith('-') && arg.length > 1) {
      if (/^-[A-Za-z]+$/.test(arg) === false) return `probe flag ${JSON.stringify(arg)} is not allowed`
      const letters = arg.slice(1)
      for (const letter of letters) {
        if (!spec.flags.includes(letter)) return `probe flag -${letter} is not allowed for ${verb}`
      }
      // 值型 flag（-F/-t）可以聚簇，但值必须紧跟其后；聚簇里出现多个值型 flag 直接拒绝。
      const valueFlags = [...letters].filter((letter) => spec.valueFlags.includes(letter))
      if (valueFlags.length > 1) return `probe flag ${JSON.stringify(arg)} mixes value flags`
      if (valueFlags.length === 1) {
        const value = rest[i + 1]
        if (value === undefined) return `probe flag -${valueFlags[0]} requires a value`
        const reason = valueFlags[0] === 't' ? validateTarget(value) : validateFormat(value)
        if (reason !== '') return reason
        i += 1
      }
      continue
    }
    if (positionalLeft <= 0) return `probe argument ${JSON.stringify(arg.slice(0, 40))} is not allowed for ${verb}`
    positionalLeft -= 1
    if (verb.startsWith('show-option') && SAFE_OPTION_NAME.test(arg) === false) {
      return `probe option name is not allowed: ${JSON.stringify(arg.slice(0, 40))}`
    }
  }
  return ''
}