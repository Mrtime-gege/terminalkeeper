/**
 * Windows 原生 PTY 后端（0.2.x 内部，预期测试阶段）。
 *
 * 设计约束：
 *   · 只用显式 argv spawn shell，不拼 shell 字符串；
 *   · node-pty / @xterm/headless 由外部提供或懒加载，缺失时明确报错，绝不自动安装；
 *   · 屏幕/历史由终端仿真器维护，PTY 字节流本身不直接当屏幕；
 *   · 持久化需要单独的 session host，当前 `persistent:false`，不假装能跨 DSH 重启。
 *
 * 这里实现的是 backend 契约与 Windows shell（pwsh/cmd）启动路径；core 的主机适配在后续
 * 小步接入，避免在 Windows 真实环境验证前改变 Linux 默认行为。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { appendOutputRing, drainOutputRing, isSafeSessionName, shouldWrapExit, wrapExitCommand, looksLikePrompt, looksLikeInteractivePrompt } from '../../pure.mjs'
import { TERMINAL_CONTRACT_VERSION, assertTerminalBackend } from '../contract.mjs'
import { defaultShellArgs, selectWindowsShell, shellKindOf } from './windows-shell.mjs'

const OUTPUT_RING_CHARS = 524288
const DEFAULT_COLS = 120
const DEFAULT_ROWS = 32

/** 与 tmux OutputRingBus 语义一致的最小输出环（订阅前零缓存）。 */
class PtyOutputBus {
  constructor (capChars = OUTPUT_RING_CHARS) {
    this.capChars = capChars
    this.rings = new Map()
    this.watched = new Set()
  }

  watch (name) {
    const key = String(name)
    this.watched.add(key)
    if (this.rings.has(key) === false) this.rings.set(key, { text: '', appended: 0, dropped: 0 })
    return true
  }

  unwatch (name) {
    const key = String(name)
    this.watched.delete(key)
    this.rings.delete(key)
    return true
  }

  append (name, text) {
    const key = String(name)
    if (this.watched.has(key) === false) return false
    let chunk = String(text ?? '')
    if (chunk === '') return false
    const ring = this.rings.get(key)
    if (ring !== undefined && String(ring.text ?? '') !== '' && String(ring.text).endsWith('\n') === false) {
      chunk = '\n' + chunk
    }
    this.rings.set(key, appendOutputRing(ring, chunk, this.capChars))
    return true
  }

  drain (name, cursor) {
    return drainOutputRing(this.rings.get(String(name)), cursor)
  }
}

/** 统一键名 → VT/PTY 字节。只覆盖插件实际会发的键；未知键原样写入。 */
const KEY_SEQUENCES = Object.freeze({
  // 名字同时接受 VT 习惯名和 tmux 键名：面板/工具面历史上发送的是 BSpace/DC/IC/NPage/PPage。
  Enter: '\r',
  Tab: '\t',
  BTab: '\x1b[Z',
  Space: ' ',
  Escape: '\x1b',
  Backspace: '\x7f',
  BSpace: '\x7f',
  Delete: '\x1b[3~',
  DC: '\x1b[3~',
  Insert: '\x1b[2~',
  IC: '\x1b[2~',
  Up: '\x1b[A',
  Down: '\x1b[B',
  Right: '\x1b[C',
  Left: '\x1b[D',
  Home: '\x1b[H',
  End: '\x1b[F',
  PageUp: '\x1b[5~',
  PPage: '\x1b[5~',
  PageDown: '\x1b[6~',
  NPage: '\x1b[6~',
  Cc: '\x03',
  Cd: '\x04',
  Cz: '\x1a',
})

function keySequence (key) {
  const name = String(key ?? '')
  if (Object.prototype.hasOwnProperty.call(KEY_SEQUENCES, name)) return KEY_SEQUENCES[name]
  // shell_send 允许使用 tmux 风格组合键；PTY 没有 tmux 的键名解析器，必须自己转义。
  const ctrl = /^C-(.)$/i.exec(name)
  if (ctrl !== null) {
    const ch = ctrl[1]
    if (ch === '?') return '\x7f'
    return String.fromCharCode(ch.toUpperCase().charCodeAt(0) & 0x1f)
  }
  const alt = /^M-(.)$/i.exec(name)
  if (alt !== null) return '\x1b' + alt[1]
  const ctrlAlt = /^C-M-(.)$/i.exec(name)
  if (ctrlAlt !== null) return '\x1b' + String.fromCharCode(ctrlAlt[1].toUpperCase().charCodeAt(0) & 0x1f)
  if (name === 'S-Tab') return '\x1b[Z'
  const match = /^F([1-9]|1[0-2])$/.exec(name)
  if (match !== null) {
    const n = Number(match[1])
    const codes = { 1: 'OP', 2: 'OQ', 3: 'OR', 4: 'OS', 5: '[15~', 6: '[17~', 7: '[18~', 8: '[19~', 9: '[20~', 10: '[21~', 11: '[23~', 12: '[24~' }
    return '\x1b' + codes[n]
  }
  // P2：命名键的组合修饰（Ctrl+Enter / Alt+Up / Ctrl+Space / Alt+F1…）。
  // 终端没有统一的修饰编码；这里采用最常见的 xterm 约定：Alt = ESC 前缀，Ctrl+Enter=CR，
  // Ctrl+Space=NUL，其余命名键保留基础序列（Ctrl+方向键在多数终端与方向键同码）。
  const namedMod = /^(C-M|C|M)-(Enter|Space|Tab|Up|Down|Left|Right|Home|End|Delete|PageUp|PageDown|F([1-9]|1[0-2]))$/.exec(name)
  if (namedMod !== null) {
    const baseName = namedMod[2]
    const seq = keySequence(baseName)
    if (namedMod[1] === 'C-M') return '\x1b' + seq
    if (namedMod[1] === 'M') return '\x1b' + seq
    if (baseName === 'Enter') return '\r'
    if (baseName === 'Space') return '\x00'
    return seq
  }
  // 单个可打印 ASCII 字符 = 字面键入（面板逐键路径依赖它）。
  if (name.length === 1 && name >= '\x20' && name <= '\x7e') return name
  // 审计加固（2026-11-16）：未知键名**必须抛错**。此前原样返回，导致
  // shell_send {text:"", keys:["Remove-Item …","Enter"]} 把整行命令当输入执行 ——
  // 绕过了 text 的换行校验与危险命令守卫。键位由 lib/args.js 白名单先拦一道，
  // 这里作为后端最后一道，绝不把任意文本写进终端。
  throw new Error(`PTY 不认识的键名：${JSON.stringify(name.slice(0, 40))}（只接受 Enter/Tab/方向键/DC/NPage/F1-12/C-x/M-x 等键位或单个字符）`)
}

/** 杀掉 PTY 主进程及其子进程树；Windows 的 node-pty.kill() 不保证清理子进程。 */
function killProcessTree (pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return
  if (process.platform === 'win32') {
    try {
      const child = spawn('taskkill', ['/PID', String(n), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      child.unref?.()
    } catch { /* 尽力而为 */ }
    return
  }
  try { process.kill(-n, 'SIGKILL') } catch {
    try { process.kill(n, 'SIGKILL') } catch { /* 已退出 */ }
  }
}

function toStringBuffer (bytes) {
  if (typeof bytes === 'string') return bytes
  // TK-07：数组/字节缓冲按 UTF-8 解码（latin1 会把多字节字符二次编码成乱码）。
  if (Array.isArray(bytes)) return Buffer.from(bytes.map((b) => Number(b) & 0xff)).toString('utf8')
  if (bytes instanceof Uint8Array) return Buffer.from(bytes).toString('utf8')
  return ''
}

/** 用 xterm-headless 的 buffer API 读出屏幕/历史；测试可注入 FakeTerminal。 */
function readTerminalScreen (term, lines, options = {}) {
  const buffer = term?.buffer?.active
  if (buffer === undefined || typeof buffer.getLine !== 'function') {
    return { screen: '', length: 0, cursorX: 0, cursorY: 0 }
  }
  const total = Math.max(0, Number(buffer.length) || 0)
  const rows = Math.max(1, Number(term.rows) || DEFAULT_ROWS)
  const extra = Number.isFinite(lines) ? Math.max(0, Math.min(100000, Math.floor(lines))) : 0
  const start = Math.max(0, total - rows - extra)
  const out = []
  const joined = []
  for (let i = start; i < total; i += 1) {
    const line = buffer.getLine(i)
    const text = typeof line?.translateToString === 'function' ? line.translateToString(true) : ''
    out.push(text)
    // 逻辑行视图：把终端折行拼回去（xterm 的 isWrapped 标记）。
    // 退出码标记/长秘密被窄屏折断时，解析必须用这一份；展示仍用物理行。
    if (line?.isWrapped === true && joined.length > 0) joined[joined.length - 1] += text
    else joined.push(text)
  }
  let screen = out.join('\n')
  if (options.trim !== false) screen = screen.replace(/\n+$/, '')
  return {
    screen,
    screenJoined: joined.join('\n'),
    length: total,
    cursorX: Number(buffer.cursorX) || 0,
    cursorY: Number(buffer.cursorY) || 0,
    start,
    viewportY: Number(buffer.viewportY) || 0,
    baseY: Number(buffer.baseY) || 0,
  }
}

// 审计加固（2026-11-16）：Windows PTY 不再整份继承 `process.env`。
// 此前 DSH/智能体的 API Key、token、插件变量会出现在用户 shell 里，AI 一条
// `Get-ChildItem Env:` 就能读走；与 tmux 路径的"最小环境"语义也不一致。
// 只保留启动 shell 必需的系统变量；业务变量通过 profile 的 sessionEnv 显式 opt-in。
const PTY_ENV_KEEP = new Set([
  'PATH', 'Path', 'PATHEXT', 'ComSpec', 'COMSPEC', 'SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'SystemDrive',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'ProgramData',
  'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'CommonProgramFiles(x86)',
  'ALLUSERSPROFILE', 'PUBLIC', 'PSModulePath', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'SESSIONNAME',
  'TEMP', 'TMP', 'TMPDIR', 'NUMBER_OF_PROCESSORS', 'OS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER',
  'LANG', 'LC_ALL', 'LANGUAGE', 'SHELL', 'USER', 'LOGNAME', 'DISPLAY', 'XDG_RUNTIME_DIR', 'TERM',
])
function defaultEnv (extra) {
  const env = {}
  for (const key of PTY_ENV_KEEP) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  env.TERM = 'xterm-256color'
  // sessionEnv 在 profile 里是 `K=V` 字符串数组（不是对象）；两种形态都要支持，
  // 否则数组会被 Object.entries 拆成 "0"/"1" 而被静默丢弃（复审实测）。
  const applyPair = (key, value) => {
    const k = String(key ?? '')
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && value !== undefined && value !== null) env[k] = String(value)
  }
  if (Array.isArray(extra)) {
    for (const item of extra) {
      if (typeof item !== 'string') continue
      const at = item.indexOf('=')
      if (at > 0) applyPair(item.slice(0, at), item.slice(at + 1))
    }
  } else if (extra !== null && typeof extra === 'object') {
    for (const [key, value] of Object.entries(extra)) applyPair(key, value)
  }
  return env
}

export class PtyBackend {
  /**
   * @param {object} options
   * @param {object} [options.ptyModule] node-pty 兼容模块（测试注入）
   * @param {Function} [options.Terminal] xterm-headless Terminal 构造器（测试注入）
   * @param {string} [options.shell] 显式 shell；缺省按 pwsh → powershell → cmd 探测
   * @param {string[]} [options.shellArgs]
   * @param {string} [options.cwd]
   * @param {number} [options.cols]
   * @param {number} [options.rows]
   * @param {number} [options.historyLimit]
   * @param {number} [options.outputRingChars]
   */
  constructor (options = {}) {
    this.options = options
    this.ptyModule = options.ptyModule ?? null
    this.Terminal = options.Terminal ?? null
    this.sessions = new Map()
    this.outputBus = new PtyOutputBus(Number.isFinite(options.outputRingChars) ? options.outputRingChars : OUTPUT_RING_CHARS)
    this.cwd = typeof options.cwd === 'string' && options.cwd.trim() !== '' ? options.cwd : homedir()
    this.cols = Number.isFinite(options.cols) && options.cols > 0 ? Math.floor(options.cols) : DEFAULT_COLS
    this.rows = Number.isFinite(options.rows) && options.rows > 0 ? Math.floor(options.rows) : DEFAULT_ROWS
    this.historyLimit = Number.isFinite(options.historyLimit) && options.historyLimit > 0 ? Math.floor(options.historyLimit) : 100000
    this.shell = typeof options.shell === 'string' ? options.shell : ''
    this.shellArgs = Array.isArray(options.shellArgs) ? options.shellArgs.slice() : null
    this.shellKind = this.shell === '' ? 'auto' : shellKindOf(this.shell)
    this.serverLaunch = 'plain-detach'
    this.foregroundStrategy = 'raw'
    this.watchdogGraceMs = 300000
    this.watchdogProcReadable = false
    this.ver = 'pty'
    this.activityListeners = new Set()
    this.disposed = false
    this.loadPromise = null
  }

  get backendName () { return 'pty' }
  get contractVersion () { return TERMINAL_CONTRACT_VERSION }

  get capabilities () {
    return Object.freeze({
      backend: 'pty',
      sessions: true,
      persistent: false,
      detached: false,
      screen: true,
      history: true,
      subscribe: true,
      keys: true,
      mouse: false,
      bell: true,
      foreground: false,
      processTree: false,
      cpu: false,
      exitCode: true,
      resize: true,
      rename: true,
      snapshot: true,
      watchdog: false,
      extendedKeys: false,
    })
  }

  /** 懒加载 node-pty / @xterm/headless；缺失时给出明确错误，不安装。 */
  async ensureLoaded () {
    if (this.ptyModule !== null && this.Terminal !== null) return
    if (this.loadPromise === null) {
      this.loadPromise = (async () => {
        if (this.ptyModule === null) {
          let mod
          try {
            mod = await import('node-pty')
          } catch (error) {
            throw new Error(`PTY backend 缺少 node-pty（${String(error?.message ?? error)}）；请由用户自行安装，插件不会自动安装`)
          }
          this.ptyModule = mod.default ?? mod
        }
        if (this.Terminal === null) {
          let mod
          try {
            mod = await import('@xterm/headless')
          } catch (error) {
            throw new Error(`PTY backend 缺少 @xterm/headless（${String(error?.message ?? error)}）；请由用户自行安装，插件不会自动安装`)
          }
          this.Terminal = mod.Terminal ?? mod.default?.Terminal
        }
        if (typeof this.ptyModule?.spawn !== 'function' || typeof this.Terminal !== 'function') {
          throw new Error('PTY backend 依赖形状不对：需要 node-pty.spawn 与 Terminal 构造器')
        }
      })()
    }
    return this.loadPromise
  }

  resolveShell () {
    const selected = selectWindowsShell({
      shell: this.shell === '' ? undefined : this.shell,
      shellArgs: this.shellArgs ?? undefined,
      env: this.options.env ?? process.env,
      exists: this.options.exists,
      pathDelimiter: this.options.pathDelimiter,
      appendExe: this.options.appendExe,
    })
    if (selected.shell === '') {
      throw new Error('找不到可用的 Windows shell（pwsh / powershell / cmd）；用户可显式配置 shell 或自行安装')
    }
    this.shell = selected.shell
    this.shellArgs = selected.args
    this.shellKind = selected.kind
    return selected
  }

  async create ({ name, cols, rows, cwd, label = '', register = true } = {}) {
    await this.ensureLoaded()
    const id = String(name ?? '')
    if (isSafeSessionName(id) === false) throw new Error(`unsafe session name: ${JSON.stringify(id.slice(0, 40))}`)
    if (register === true && this.sessions.has(id)) throw new Error(`session already exists: ${id}`)
    const profile = this.resolveShell()
    const sizeCols = Number.isFinite(cols) && cols > 0 ? Math.floor(cols) : this.cols
    const sizeRows = Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : this.rows
    const dir = typeof cwd === 'string' && cwd.trim() !== '' ? cwd : this.cwd
    const pty = this.ptyModule.spawn(profile.shell, profile.args, {
      name: 'xterm-256color',
      cols: sizeCols,
      rows: sizeRows,
      cwd: dir,
      env: defaultEnv(this.options.sessionEnv),
      useConpty: true,
    })
    let term
    try {
      term = new this.Terminal({
        cols: sizeCols,
        rows: sizeRows,
        scrollback: this.historyLimit,
        allowProposedApi: true,
        convertEol: false,
      })
    } catch (error) {
      // PTY 已 spawn 而仿真器构造失败：不能留下未注册的子进程。
      try { pty.kill() } catch { /* 已退出 */ }
      throw error
    }
    const idleName = profile.kind === 'other' ? basename(profile.shell) : profile.kind
    const session = {
      name: id,
      label: String(label ?? '').slice(0, 60),
      cols: sizeCols,
      rows: sizeRows,
      cwd: dir,
      shell: profile.shell,
      shellKind: profile.kind,
      idleName,
      foreground: idleName,
      lastOutputAt: Date.now(),
      pid: pty.pid,
      createdAt: Date.now(),
      term,
      pty,
      alive: true,
      exitCode: null,
      outputAt: Date.now(),
      bell: false,
      capture: null,
      disposeData: null,
      disposeExit: null,
    }
    session.disposeData = pty.onData((data) => {
      const text = String(data ?? '')
      if (text === '') return
      session.outputAt = Date.now()
      session.lastOutputAt = Date.now()
      if (text.includes('\u0007')) session.bell = true   // TK-08：BEL 沿变供 wait.kind=bell 使用
      try { term.write(text) } catch { /* 仿真器异常不阻断 PTY */ }
      this.outputBus.append(id, text)
      if (session.capture !== null) {
        try { session.capture.write(text) } catch { /* 文件被删/磁盘满：留痕失败不影响会话 */ }
      }
      this.notifyActivity()
    })
    session.disposeExit = pty.onExit(({ exitCode }) => {
      session.alive = false
      session.exitCode = Number.isFinite(exitCode) ? exitCode : null
      session.foreground = session.idleName
      try { term.write(`\r\n[process exited with code ${exitCode ?? '?'}]\r\n`) } catch { /* 忽略 */ }
    })
    session.name = id
    if (register === true) {
      this.sessions.set(id, session)
    }
    this.notifyActivity()
    if (register === false) return session
  }

  async list () {
    return [...this.sessions.values()].map((session) => ({
      name: session.name,
      cols: session.cols,
      rows: session.rows,
      windows: 1,
      attached: false,
      foreground: this.currentForeground(session),
      pid: session.pid,
      historySize: Math.max(0, Number(session.term?.buffer?.active?.length ?? 0) - session.rows),
      historyLimit: this.historyLimit,
      historyBytes: 0,
      createdAt: Math.floor(session.createdAt / 1000),
      cursorX: Number(session.term?.buffer?.active?.cursorX ?? 0),
      cursorY: Number(session.term?.buffer?.active?.cursorY ?? 0),
      cursorVisible: true,
      paneHeight: session.rows,
      cwd: session.cwd,
      label: session.label,
      dead: session.alive === false,
      deadStatus: session.alive === false ? session.exitCode : null,
      activityAt: session.outputAt,
      bell: session.bell === true,
      paneId: `pty-${session.name}`,
    }))
  }

  async has (name) {
    return this.sessions.has(String(name))
  }

  async screen (name, lines, options = {}) {
    const captured = await this.captureWithMeta(name, lines, options)
    return captured.screen
  }

  async captureWithMeta (name, lines, options = {}) {
    const session = this.sessions.get(String(name))
    if (session === undefined) throw new Error(`cannot read session "${String(name)}": not found`)
    const view = readTerminalScreen(session.term, lines, options)
    return {
      meta: {
        name: session.name,
        cols: session.cols,
        rows: session.rows,
        screenCols: session.cols,
        // 绝对行号：注入登记与捕获窗口用同一坐标系换算遮罩范围。
        screenStart: view.start,
        historySize: Math.max(0, Number(view.length) - session.rows),
        // 绝对行号 = 视口顶行 + 光标行；baseY 是 xterm 的滚动偏移（length-rows 只在缓冲填满后相等）。
        absoluteCursorRow: Math.max(0, Number(view.baseY ?? (Number(view.length) - session.rows))) + (Number(view.cursorY) || 0),
        foreground: this.currentForeground(session),
        pid: session.pid,
        cursorX: view.cursorX,
        cursorY: view.cursorY,
        paneHeight: session.rows,
        cwd: session.cwd,
        label: session.label,
      },
      screen: view.screen,
      screenJoined: view.screenJoined ?? view.screen,
    }
  }

  currentForeground (session) {
    if (session === undefined) return ''
    if (session.alive === false) return session.idleName
    // 审计加固（2026-11-16）：此前只要 250ms 没有新输出就把前台改回 shell ——
    // `shell_send` 启动 `sleep 10` 后，wait.idle 约 250ms 就假报"已到达"。
    // ConPTY 没有前台进程 API，只能看屏幕：只有**最后一行像提示符**时才认为命令结束；
    // 命令回显行（`PS C:\\> sleep 10`）不以提示符结尾，因此不会提前放行。
    if (session.foreground === 'command' && Date.now() - session.lastOutputAt > 250) {
      // 提示符识别是主判据；但自定义/超长提示符（Windows cmd 深路径）认不出时不能永久“忙”。
      // 兜底：屏幕出现退出码标记，或已安静 3 秒 —— 交给 wait.exit 的 marker/超时语义裁决。
      const quietMs = Date.now() - session.lastOutputAt
      // 复审修复：有时间兜底仅用于**未包装**命令（没有本次 marker 可等）；
      // 包装命令必须等本次 nonce 的 marker 或回到提示符，否则安静 3 秒会把仍在跑的命令判空闲。
      const canFallback = (session.expectedNonce ?? '') === ''
      if (this.screenEndsAtPrompt(session) || this.screenHasExitMark(session) || (canFallback && quietMs > 3000)) {
        session.foreground = session.idleName
      }
    }
    return session.foreground ?? session.idleName
  }

  /** 屏幕最近若干**逻辑行**（按 isWrapped 合并）：窄屏折行不会把标记/提示符拆散。 */
  logicalTail (session, limit) {
    const buffer = session?.term?.buffer?.active
    if (buffer === undefined || typeof buffer.getLine !== 'function') return []
    const total = Math.max(0, Number(buffer.length) || 0)
    const from = Math.max(0, total - (Number(limit) || 60))
    const out = []
    for (let i = from; i < total; i += 1) {
      const line = buffer.getLine(i)
      const text = typeof line?.translateToString === 'function' ? line.translateToString(true) : ''
      if (line?.isWrapped === true && out.length > 0) out[out.length - 1] += text
      else out.push(text)
    }
    return out
  }

  /** 屏幕最近若干行是否已有本次/最近一次包装命令的退出码标记（PTY 兜底）。 */
  screenHasExitMark (session) {
    const nonce = String(session?.expectedNonce ?? '')
    if (nonce === '') return false
    // 窄屏（20 列）下标记会被终端折成两条物理行；必须按逻辑行匹配，否则 wait.exit 永远超时。
    const re = new RegExp('^__DSH_EXIT_' + nonce + '__=-?\\d+\\s*$')
    for (const text of this.logicalTail(session, 80)) {
      if (re.test(String(text).trim())) return true
    }
    return false
  }

  /** 屏幕最后一条非空行是否像 shell 提示符（用于 PTY 的忙闲判定）。 */
  screenEndsAtPrompt (session) {
    const buffer = session?.term?.buffer?.active
    if (buffer === undefined || typeof buffer.getLine !== 'function') return false
    const total = Math.max(0, Number(buffer.length) || 0)
    const sent = String(session?.lastSentText ?? '')
    for (let i = total - 1; i >= Math.max(0, total - 40); i -= 1) {
      const line = buffer.getLine(i)
      const text = typeof line?.translateToString === 'function' ? line.translateToString(true) : ''
      if (String(text).trim() === '') continue
      // 命令回显行（含刚发送的文本）不是提示符：否则 `PS C:\…> sleep 10` 会被误判空闲。
      if (sent !== '' && String(text).includes(sent.trim().split('\n')[0])) return false
      return looksLikeInteractivePrompt(text)
    }
    return false
  }

  async foregroundOf (name) {
    return this.currentForeground(this.sessions.get(String(name)))
  }

  async resolveForeground (command) {
    return String(command ?? '')
  }

  async send (name, text, keys, options = {}) {
    const session = this.sessions.get(String(name))
    if (session === undefined) throw new Error(`session not found: ${String(name)}`)
    if (session.alive === false) throw new Error(`session is not alive: ${String(name)}`)
    let payload = String(text ?? '')
    const keyList = Array.isArray(keys) ? keys : []
    for (const key of keyList) payload += keySequence(key)
    if (payload !== '') {
      session.foreground = 'command'
      session.lastOutputAt = Date.now()
      session.lastSentText = payload
      // 只认本次包装命令的 nonce：旧 marker 留在屏上不能让下一条命令提前“空闲”。
      const m = /__DSH_EXIT_([a-z0-9]+)__/.exec(payload)
      session.expectedNonce = m === null ? '' : m[1]
      session.pty.write(payload)
    }
    return { sent: payload.length }
  }

  async sendBytes (name, bytes) {
    const session = this.sessions.get(String(name))
    if (session === undefined) throw new Error(`session not found: ${String(name)}`)
    if (session.alive === false) throw new Error(`session is not alive: ${String(name)}`)
    const text = toStringBuffer(bytes)
    if (text !== '') {
      session.foreground = 'command'
      session.lastOutputAt = Date.now()
      session.pty.write(text)
    }
    return { sent: text.length }
  }

  async resize (name, cols, rows) {
    const session = this.sessions.get(String(name))
    if (session === undefined) throw new Error(`session not found: ${String(name)}`)
    const c = Number.isFinite(cols) && cols > 0 ? Math.floor(cols) : session.cols
    const r = Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : session.rows
    session.cols = c
    session.rows = r
    session.pty.resize(c, r)
    if (typeof session.term?.resize === 'function') session.term.resize(c, r)
  }

  async kill (name) {
    const id = String(name)
    const session = this.sessions.get(id)
    if (session === undefined) return { closed: false, reason: 'not-found' }
    this.sessions.delete(id)
    try { session.disposeData?.dispose?.() } catch { /* 忽略 */ }
    try { session.disposeExit?.dispose?.() } catch { /* 忽略 */ }
    try { void session.capture?.close?.().catch?.(() => {}) } catch { /* 忽略 */ }
    try { session.term?.dispose?.() } catch { /* 忽略 */ }
    try { session.pty?.kill?.() } catch { /* 已退出 */ }
    killProcessTree(session.pid)
    this.outputBus.unwatch(id)
    this.notifyActivity()
    return { closed: true }
  }

  async setLabel (name, label) {
    const session = this.sessions.get(String(name))
    if (session !== undefined) session.label = String(label ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
  }

  async respawn (name, cwd) {
    const id = String(name)
    const session = this.sessions.get(id)
    if (session === undefined) throw new Error(`session not found: ${id}`)
    const { cols, rows, label } = session
    const nextCwd = typeof cwd === 'string' && cwd.trim() !== '' ? cwd : session.cwd
    // 先验证 cwd/shell，再**先 spawn 新窗格**；只有新窗格成功后才销毁旧窗格。
    // 这样 spawn 失败不会把非破坏性 respawn 变成销毁性操作。
    if (typeof nextCwd === 'string' && nextCwd !== '' && existsSync(nextCwd) === false) {
      throw new Error(`no such directory: ${nextCwd}`)
    }
    this.resolveShell()
    const fresh = await this.create({ name: id, cols, rows, cwd: nextCwd, label, register: false })
    try { session.disposeData?.dispose?.() } catch { /* 忽略 */ }
    try { session.disposeExit?.dispose?.() } catch { /* 忽略 */ }
    try { session.capture?.close?.().catch(() => {}) } catch { /* 忽略 */ }
    try { session.term?.dispose?.() } catch { /* 忽略 */ }
    try { session.pty?.kill?.() } catch { /* 已退出 */ }
    killProcessTree(session.pid)
    this.sessions.set(id, fresh)
    this.notifyActivity()
    return { respawned: true }
  }

  watchOutput (name) { return this.outputBus.watch(name) }
  unwatchOutput (name) { return this.outputBus.unwatch(name) }
  appendWatchedOutput (name, text) { return this.outputBus.append(name, text) }
  drainOutput (name, cursor) { return this.outputBus.drain(name, cursor) }

  async probe () {
    await this.ensureLoaded()
    return { code: 0, out: 'pty\n', err: '' }
  }

  async probeTmux () {
    return { ok: true, version: 'pty', major: 1, minor: 0, error: '' }
  }

  useExtendedKeys () { return false }

  /** backend 自有的退出码包装：cmd 用 `!ERRORLEVEL!`（shell 以 /V:ON 启动），
   *  PowerShell 用 `$LASTEXITCODE` / `$?`，其它 shell 继续用 POSIX 包装。 */
  shouldWrapExit (command) {
    const text = String(command ?? '')
    if (text.trim() === '' || text.includes('\n')) return { wrap: false, reason: 'unsupported' }
    if (this.shellKind === 'cmd' || this.shellKind === 'pwsh' || this.shellKind === 'powershell') {
      // 审计加固（2026-11-16）：cmd/pwsh 不再无条件包装。此前对**所有单行命令**都追加
      // 退出码包装，绕过了 pure 的交互程序白名单、尾随注释、后台化与 `exit` 判断：
      // `vim`/`python` 被注入命令、`echo x #` 把包装注释掉、`exit` 直接结束 shell。
      const base = shouldWrapExit(text)
      // cmd 里 `#` 不是注释（echo #tag 是普通输出）；不要套 POSIX 的 trailing-comment 规则。
      if (base.wrap !== true && !(this.shellKind === 'cmd' && base.reason === 'trailing-comment')) {
        return { wrap: false, reason: `pty:${base.reason ?? 'unsupported'}` }
      }
      return { wrap: true, reason: 'pty-shell' }
    }
    return shouldWrapExit(text)
  }

  wrapExitCommand (command, nonce) {
    const tag = String(nonce ?? '').replace(/[^a-z0-9]/gi, '')
    const mark = tag === '' ? '__DSH_EXIT__' : `__DSH_EXIT_${tag}__`
    const text = String(command ?? '').trimEnd()
    if (this.shellKind === 'cmd') {
      return `${text} & echo ${mark}=!ERRORLEVEL!`
    }
    if (this.shellKind === 'pwsh' || this.shellKind === 'powershell') {
      // 不能直接信任 $LASTEXITCODE：PowerShell 自身报错时它可能仍是上一条外部命令的旧值。
      // 执行前把它清成 $null：外部命令会重新赋值，失败 cmdlet 保持不变。
      //   · 清空后仍为 $null → 没有外部命令（或 cmdlet 报错）→ 失败看 $? 给 1，成功给 0；
      //   · 清空后变成 7 → 外部命令真实退出码 7，即使上一条也是 7 也不会被折叠成 1。
      return `$global:LASTEXITCODE = $null; $__dsh_err_before = $global:Error.Count; ${text}; $__dsh_ok = $?; $__dsh_after = $global:LASTEXITCODE; $__dsh_err_after = $global:Error.Count; `
        + `$__dsh_failed = (-not $__dsh_ok) -or ($__dsh_err_after -gt $__dsh_err_before); `
        + `$__dsh_x = if ($__dsh_failed) { if ($null -ne $__dsh_after) { $__dsh_after } else { 1 } } elseif ($null -ne $__dsh_after) { $__dsh_after } else { 0 }; `
        + `Write-Output "${mark}=$__dsh_x"`
    }
    return wrapExitCommand(text, nonce)
  }
  bellFlag (name) {
    const session = this.sessions.get(String(name))
    const value = session?.bell === true
    if (session !== undefined) session.bell = false
    return value
  }

  mouseFlags () { return null }
  rawReply () { return '' }
  async paneProcs () { return [] }
  async paneCpu () { return [] }

  async run (argv, options = {}) {
    const args = Array.isArray(argv) ? argv.map(String) : []
    if (args.length === 0) return { code: 1, out: '', err: 'empty argv' }
    return await new Promise((resolve) => {
      const stdout = []
      const stderr = []
      let bytes = 0
      const cap = Number.isFinite(options.cap) ? Math.max(1024, Math.floor(options.cap)) : 4 * 1024 * 1024
      let settled = false
      const finish = (code, error = '') => {
        if (settled) return
        settled = true
        resolve({ code, out: stdout.join(''), err: stderr.join('') || error })
      }
      let child
      try {
        child = spawn(args[0], args.slice(1), {
          cwd: options.cwd ?? this.cwd,
          env: defaultEnv(this.options.sessionEnv),
          shell: false,
          windowsHide: true,
        })
      } catch (error) {
        finish(1, String(error?.message ?? error))
        return
      }
      child.stdout?.on('data', (chunk) => {
        bytes += chunk.length
        if (bytes <= cap) stdout.push(chunk.toString('utf8'))
      })
      child.stderr?.on('data', (chunk) => {
        bytes += chunk.length
        if (bytes <= cap) stderr.push(chunk.toString('utf8'))
      })
      child.on('error', (error) => finish(1, String(error?.message ?? error)))
      child.on('close', (code) => finish(Number.isFinite(code) ? code : 1))
      if (options.input !== undefined) child.stdin?.end(String(options.input))
    })
  }

  async isDirectory (path) {
    try {
      return (await stat(String(path))).isDirectory()
    } catch {
      return false
    }
  }

  async startCapture (name, file) {
    const session = this.sessions.get(String(name))
    if (session === undefined) return
    if (session.capture !== null) return
    session.capture = await open(String(file), 'a', 0o600)
  }

  async stopCapture (name) {
    const session = this.sessions.get(String(name))
    if (session === undefined || session.capture === null) return
    try { await session.capture.close() } catch { /* 忽略 */ }
    session.capture = null
  }

  async bootstrap () {
    return { harnessPid: '', watchdogPid: '', adopted: false, kept: [...this.sessions.keys()] }
  }

  async writeServerConfig () {}
  async armWatchdog () { return { watchdogPid: '', harnessPid: '' } }
  async disarmWatchdog () {}
  async replaceWatchdog () { return { watchdogPid: '', harnessPid: '' } }
  async harnessPid () { return '' }
  async currentCwd (name) {
    const session = this.sessions.get(String(name))
    return typeof session?.cwd === 'string' ? session.cwd : ''
  }
  async watchdogPid () { return '' }
  watchdogStatus () { return { armed: false, pid: '' } }
  watchdogStatusCurrent () { return { armed: false, pid: '' } }
  closeOwnerSocket () {}
  async reapPhantomOrphans () {}
  async pause (ms) { await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0))) }

  onActivity (listener) {
    if (typeof listener !== 'function') return () => {}
    this.activityListeners.add(listener)
    return () => this.activityListeners.delete(listener)
  }

  notifyActivity () {
    for (const listener of this.activityListeners) {
      try { listener() } catch { /* 单个监听器失败不影响会话 */ }
    }
  }

  async dispose () {
    if (this.disposed) return
    this.disposed = true
    for (const name of [...this.sessions.keys()]) await this.kill(name)
    this.activityListeners.clear()
  }
}

export function createPtyBackend (options = {}) {
  const backend = new PtyBackend(options)
  return assertTerminalBackend(backend)
}

export { selectWindowsShell, shellKindOf, defaultShellArgs }
