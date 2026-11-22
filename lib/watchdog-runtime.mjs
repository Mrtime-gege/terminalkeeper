/**
 * 看门狗运行时：owner socket + control socket。
 *
 * 设计目标：
 *   - **不落盘任何状态**：没有 lease/pid 文件；看门狗的身份、harness 身份只在进程内存 + socket 握手里；
 *   - owner socket 由 harness（或 supervisor daemon）持有，内核维护生命周期：进程死 → 连接立即失败；
 *   - control socket 由 watchdog 持有，供插件查询状态 / adopt / disarm；
 *   - 目录 0700、socket 0600，拒绝符号链接、非 socket、非本人 UID。
 *
 * 注意：同一用户下的其它进程本来就能 kill tmux / 伪造 socket，因此这不是防恶意本机的安全边界；
 * 这里做的是**防误杀 + 防误判 + 防意外暴露**。
 */
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { createServer, connect } from 'node:net'
import { dirname, join } from 'node:path'

export const OWNER_MAGIC = 'terminalkeeper-owner-v1'
export const WATCHDOG_MAGIC = 'terminalkeeper-watchdog-v1'
/** 看门狗行为 ABI：改动判定/控制语义时递增，插件会替换旧进程而不是继续收养。 */
export const WATCHDOG_ABI = 3

/** 旧 watchdog（无 abi 或 abi 不匹配）需要 disarm 后重新 spawn。 */
export function watchdogCompatible (status) {
  return status !== null && status !== undefined && Number(status.abi) === WATCHDOG_ABI
}

export function runtimePaths (runtimeDir, socket) {
  return {
    dir: runtimeDir,
    owner: join(runtimeDir, `${socket}.owner.sock`),
    control: join(runtimeDir, `${socket}.watchdog.sock`),
  }
}

export function readProcStart (pid) {
  if (!/^\d+$/.test(String(pid ?? ''))) return ''
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // comm 可含空格/括号；取最后一个 ')' 之后的字段：第 22 个字段是 starttime
    const after = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
    return after[19] ?? ''
  } catch { return '' }
}

// ── 进程身份提供者（SUP-03） ─────────────────────────────────────────────────
//
// 「这个 pid 还是不是原来那个进程」必须由**平台提供者**回答：
//   · Linux：`/proc/<pid>/stat` 的 starttime（不会因 PID 复用而误判）；
//   · macOS / 无 /proc：`ps -p <pid> -o lstart=`（并额外用 kill(pid,0) 校验存活）；
//   · 两者都不可用：**没有提供者**。此时 alive() 一律 null（未知），调用方必须
//     fail-safe —— 只报告、绝不 kill（旧实现把 null 当成「死」，正是 macOS 误杀的根因）。
export const IDENTITY_PROVIDER = Object.freeze({
  PROC: 'proc-starttime',
  PS: 'ps-lstart',
  NONE: 'none',
})

/** macOS/BSD `ps -o lstart=` 与 Linux procps 的输出都归一成单空格形式再比较。 */
export function normalizePsStart (text) {
  return String(text ?? '').trim().replace(/\s+/g, ' ')
}

function defaultKill0 (pid) {
  try {
    process.kill(Number(pid), 0)
    return true
  } catch (error) {
    // EPERM = 进程存在但无权发信号（本场景同用户，通常不会走到）。
    return error?.code === 'EPERM'
  }
}

function defaultRunPs (pid) {
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8', timeout: 2000, env: { ...process.env, LC_ALL: 'C' },
    })
    return normalizePsStart(out)
  } catch { return '' }
}

/**
 * 构造身份提供者。
 *
 * @param {object} [options]
 * @param {string} [options.mode]       'auto'（默认）| 'proc' | 'ps' | 'none'
 * @param {string} [options.platform]   process.platform 的覆盖（测试用）
 * @param {boolean} [options.procReadable] false = 禁止用 /proc（沿用旧的 --proc-readable=0 语义）
 * @param {string} [options.probePid]   可用性探测用的**活进程** pid（默认自身）
 * @param {(pid: string) => string} [options.readProc]
 * @param {(pid: string) => string} [options.runPs]
 * @param {(pid: string) => boolean} [options.kill0]
 */
export function createIdentityProvider (options = {}) {
  const mode = ['auto', 'proc', 'ps', 'none'].includes(String(options.mode)) ? String(options.mode) : 'auto'
  const allowProc = options.procReadable !== false
  const readProc = typeof options.readProc === 'function' ? options.readProc : readProcStart
  const runPs = typeof options.runPs === 'function' ? options.runPs : defaultRunPs
  const kill0 = typeof options.kill0 === 'function' ? options.kill0 : defaultKill0
  const probePid = String(options.probePid ?? process.pid)

  let name = IDENTITY_PROVIDER.NONE
  if (mode === 'none') {
    name = IDENTITY_PROVIDER.NONE
  } else if (mode === 'proc') {
    name = allowProc && String(readProc(probePid) ?? '') !== '' ? IDENTITY_PROVIDER.PROC : IDENTITY_PROVIDER.NONE
  } else if (mode === 'ps') {
    name = normalizePsStart(runPs(probePid)) !== '' ? IDENTITY_PROVIDER.PS : IDENTITY_PROVIDER.NONE
  } else {
    const procUsable = allowProc && String(readProc(probePid) ?? '') !== ''
    if (procUsable) name = IDENTITY_PROVIDER.PROC
    else if (normalizePsStart(runPs(probePid)) !== '') name = IDENTITY_PROVIDER.PS
  }
  const available = name !== IDENTITY_PROVIDER.NONE

  function readStart (pid) {
    if (name === IDENTITY_PROVIDER.PROC) return String(readProc(String(pid ?? '')) ?? '')
    if (name === IDENTITY_PROVIDER.PS) return normalizePsStart(runPs(String(pid ?? '')))
    return ''
  }

  /**
   * 三值判定：true=仍是原进程；false=**可证明已死**；null=无法判定（绝不据此 kill）。
   */
  function alive (pid, start) {
    const p = String(pid ?? '')
    const s = String(start ?? '')
    if (!/^\d+$/.test(p)) return null   // 非法 pid 不能当成“可证明已死”
    if (name === IDENTITY_PROVIDER.NONE) return null
    if (name === IDENTITY_PROVIDER.PROC) {
      const current = String(readProc(p) ?? '')
      if (current !== '') {
        if (s === '') return true
        // starttime 必须是 /proc 语义的数字；拿别家提供者的格式来比只会造成永久误判。
        if (!/^\d+$/.test(s)) return null
        return current === s
      }
      // /proc 读不到：可能是进程已死，也可能是 /proc 不可读 —— 用 kill(pid,0) 区分。
      return kill0(p) === false ? false : null
    }
    // ps 提供者：先证明 pid 还活着，再比对 lstart。
    if (kill0(p) === false) return false
    const current = normalizePsStart(runPs(p))
    if (current === '') return null            // ps 读不到 → 不能证明死亡
    if (s === '') return true
    if (/^\d+$/.test(s)) return null           // 数字 starttime 不是 ps 语义 → 未知
    return current === normalizePsStart(s)
  }

  return {
    name,
    platform: String(options.platform ?? process.platform),
    available,
    allowsProc: allowProc,
    readStart,
    alive,
    describe () {
      if (name === IDENTITY_PROVIDER.PROC) return '身份源：/proc/<pid>/stat starttime'
      if (name === IDENTITY_PROVIDER.PS) return '身份源：ps -p <pid> -o lstart=（并校验 pid 存活）'
      return '身份源：不可用（读不到 /proc，ps 也不可用）—— 只报告，不 kill'
    },
  }
}

// ── tmux 服务端归属标记（SUP-02） ───────────────────────────────────────────
//
// owner socket 只能证明「本数据目录的 harness 还在不在」，不能证明「这个 tmux 服务端
// 属于本数据目录」。数据目录迁移 / 多实例共用 socket 名时，旧 watchdog 会在 grace 后
// kill 掉新实例刚收养的服务端。因此 harness 在服务端上写一个 server option：
//     set-option -s @terminalkeeper_owner <token>
// token 由 (runtimeDir, socket) 确定性派生：同一实例重启后仍能对上（不影响正常收尸），
// 不同数据目录天然不同（旧 watchdog 会拒绝 kill）。
export const SERVER_OWNER_OPTION = '@terminalkeeper_owner'

export function serverOwnerToken ({ runtimeDir = '', socket = '', salt = '' } = {}) {
  return createHash('sha256')
    .update(`terminalkeeper-server-owner-v1\u0000${String(runtimeDir)}\u0000${String(socket)}\u0000${String(salt)}`, 'utf8')
    .digest('hex')
    .slice(0, 32)
}

/** 写标记的 argv（不含 `tmux -L <socket>` 前缀，供 driver.probe 直接使用）。 */
export function serverOwnerSetArgs (token) {
  return ['set-option', '-s', SERVER_OWNER_OPTION, String(token)]
}

/** 读标记的 argv（`-v` = 只输出值）。 */
export function serverOwnerShowArgs () {
  return ['show-options', '-s', '-v', SERVER_OWNER_OPTION]
}

/** 解析 `show-options -s -v` 的输出：空串 = 标记缺失。 */
export function parseServerOwner (stdout) {
  const text = String(stdout ?? '').trim()
  if (text === '') return ''
  return text.split('\n')[0].trim()
}

/** 标记值是否匹配期望；缺失或不一致都返回 false。 */
export function verifyServerOwnerToken (expected, actual) {
  const want = String(expected ?? '').trim()
  const got = String(actual ?? '').trim()
  return want !== '' && got !== '' && want === got
}

function execTmux (argv, timeoutMs) {
  return new Promise((resolve) => {
    try {
      execFile('tmux', argv, {
        timeout: timeoutMs, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' },
      }, (error, stdout, stderr) => {
        resolve({ error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      })
    } catch (error) {
      resolve({ error, stdout: '', stderr: String(error?.message ?? error) })
    }
  })
}

/**
 * 读取 `-L <socket>` 服务端的归属标记。
 * @returns {Promise<{ok: boolean, token: string, reason: string}>}
 */
export async function readServerOwner ({ socket, timeoutMs = 2000 } = {}) {
  const name = String(socket ?? '')
  if (name === '') return { ok: false, token: '', reason: 'no-socket' }
  const result = await execTmux(['-L', name, ...serverOwnerShowArgs()], timeoutMs)
  if (result.error !== null && result.error !== undefined) {
    const text = `${String(result.stderr ?? '')} ${String(result.stdout ?? '')}`.trim()
    const reason = /no server running|error connecting|no such|can't find|connection refused/i.test(text)
      ? 'no-server'
      : 'exec-error'
    return { ok: false, token: '', reason }
  }
  const token = parseServerOwner(result.stdout)
  if (token === '') return { ok: false, token: '', reason: 'missing' }
  return { ok: true, token, reason: '' }
}

/**
 * 写入归属标记（供 index/tmux/daemon 在服务端启动后调用）。
 *
 * @param {object} options
 * @param {string} options.socket
 * @param {string} [options.runtimeDir]
 * @param {string} [options.token]    显式 token；缺省按 (runtimeDir, socket) 派生
 * @param {(argv: string[]) => Promise<{code:number}>} [options.run]  调用方的 tmux 运行器
 */
export async function markServerOwner ({ socket, runtimeDir = '', token = '', run = null } = {}) {
  const name = String(socket ?? '')
  if (name === '') return { ok: false, token: '', error: 'no-socket' }
  const value = String(token ?? '').trim() !== '' ? String(token).trim() : serverOwnerToken({ runtimeDir, socket: name })
  const argv = serverOwnerSetArgs(value)
  let result
  if (typeof run === 'function') {
    try { result = await run(argv) } catch (error) { return { ok: false, token: value, error: String(error?.message ?? error) } }
  } else {
    result = await execTmux(['-L', name, ...argv], 3000)
    if (result.error !== null && result.error !== undefined) {
      return { ok: false, token: value, error: String(result.stderr || result.error?.message || 'tmux set-option failed').trim().slice(0, 200) }
    }
  }
  const code = Number(result?.code ?? result?.exitCode ?? 0)
  return { ok: !Number.isFinite(code) || code === 0, token: value, error: code === 0 || !Number.isFinite(code) ? '' : `tmux exit ${code}` }
}

export function procIdentity (pid) {
  if (!/^\d+$/.test(String(pid ?? ''))) return null
  const start = readProcStart(pid)
  return start === '' ? null : { pid: String(pid), start }
}

export function sameIdentity (a, b) {
  if (a === null || b === null || a === undefined || b === undefined) return false
  return String(a.pid) === String(b.pid) && String(a.start) === String(b.start)
}

/** 私有运行目录：必须 0700、本人所有、不能是符号链接。 */
export function ensurePrivateDir (dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const st = lstatSync(dir)
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`runtime dir is not a private directory: ${dir}`)
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error(`runtime dir owner mismatch: ${dir}`)
  chmodSync(dir, 0o700)
  return dir
}

/** socket 文件校验：必须是 socket、本人所有；同目录必须 0700。 */
export function checkSocketFile (path) {
  try {
    const st = lstatSync(path)
    if (!st.isSocket()) return { ok: false, reason: 'not-socket' }
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return { ok: false, reason: 'wrong-uid' }
    const d = lstatSync(dirname(path))
    if (!d.isDirectory() || d.isSymbolicLink()) return { ok: false, reason: 'bad-dir' }
    if (typeof process.getuid === 'function' && d.uid !== process.getuid()) return { ok: false, reason: 'dir-uid' }
    if ((d.mode & 0o077) !== 0) return { ok: false, reason: 'dir-perm' }
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: error?.code === 'ENOENT' ? 'missing' : 'stat-error' }
  }
}

function readLine (socket, timeoutMs) {
  return new Promise((resolve) => {
    let buf = ''
    let done = false
    const finish = (value) => { if (!done) { done = true; try { socket.destroy() } catch { /* 忽略 */ } resolve(value) } }
    socket.setEncoding('utf8')
    socket.setTimeout(timeoutMs, () => finish(null))
    socket.on('data', (chunk) => {
      buf += chunk
      const idx = buf.indexOf('\n')
      if (idx >= 0) finish(buf.slice(0, idx))
      if (buf.length > 8192) finish(null)
    })
    socket.once('error', () => finish(null))
    socket.once('close', () => { if (!done) finish(null) })
  })
}

/** 探测 owner socket：connect + 握手验证；返回 { ok, handshake } 或 { ok:false, reason }。 */
export async function probeOwner (path, socketName, timeoutMs = 800) {
  const file = checkSocketFile(path)
  if (file.ok !== true) return { ok: false, reason: file.reason }
  return await new Promise((resolve) => {
    const sock = connect(path)
    const timer = setTimeout(() => { try { sock.destroy() } catch { /* 忽略 */ } resolve({ ok: false, reason: 'timeout' }) }, timeoutMs)
    sock.once('connect', async () => {
      const line = await readLine(sock, timeoutMs)
      clearTimeout(timer)
      if (line === null) { resolve({ ok: false, reason: 'no-handshake' }); return }
      try {
        const h = JSON.parse(line)
        if (h?.magic !== OWNER_MAGIC || h?.version !== 1 || String(h?.socket ?? '') !== String(socketName)) {
          resolve({ ok: false, reason: 'bad-handshake' }); return
        }
        resolve({ ok: true, handshake: h })
      } catch { resolve({ ok: false, reason: 'bad-json' }) }
    })
    sock.once('error', (error) => { clearTimeout(timer); resolve({ ok: false, reason: String(error?.code ?? 'connect-error') }) })
  })
}

/** 向 watchdog control socket 发一条命令；失败返回 null。 */
export async function controlCall (path, message, timeoutMs = 1000) {
  const file = checkSocketFile(path)
  if (file.ok !== true) return null
  return await new Promise((resolve) => {
    const sock = connect(path)
    let settled = false
    const finish = (v) => { if (!settled) { settled = true; try { sock.destroy() } catch { /* 忽略 */ } resolve(v) } }
    const timer = setTimeout(() => finish(null), timeoutMs)
    sock.once('connect', () => {
      try { sock.write(JSON.stringify(message) + '\n') } catch { finish(null) }
    })
    readLine(sock, timeoutMs).then((line) => {
      clearTimeout(timer)
      if (line === null) { finish(null); return }
      try { finish(JSON.parse(line)) } catch { finish(null) }
    })
    sock.once('error', () => { clearTimeout(timer); finish(null) })
  })
}

/**
 * 进程级 owner server 注册表：同一 runtime/socket 在 HMR 前后共享同一个 listener。
 * 插件 dispose 只减引用；最后一个引用释放才 unlink，避免旧实例 close 掉新实例刚绑的 socket。
 * 只用 globalThis（不落盘），进程退出时内核自动回收。
 */
const OWNER_REGISTRY_KEY = '__terminalkeeperOwnerServers'
function ownerRegistry () {
  if (globalThis[OWNER_REGISTRY_KEY] === undefined) globalThis[OWNER_REGISTRY_KEY] = new Map()
  return globalThis[OWNER_REGISTRY_KEY]
}
function ownerKey (runtimeDir, socket) { return `${runtimeDir}\u0000${socket}` }

export async function acquireOwnerServer (options) {
  const key = ownerKey(options.runtimeDir, options.socket)
  const registry = ownerRegistry()
  const existing = registry.get(key)
  if (existing !== undefined && existing !== null) {
    existing.refs = (existing.refs ?? 1) + 1
    return existing
  }
  const server = new OwnerServer(options)
  await server.start()
  server.refs = 1
  server.registryKey = key
  registry.set(key, server)
  return server
}

export function releaseOwnerServer (server) {
  if (server === null || server === undefined) return
  server.refs = (server.refs ?? 1) - 1
  if (server.refs > 0) return
  try { ownerRegistry().delete(server.registryKey) } catch { /* 忽略 */ }
  server.close()
}

/** owner server：harness 侧持有，回复握手；关掉即代表 owner 消失。 */
export class OwnerServer {
  constructor ({ runtimeDir, socket, harnessPid, harnessStart, onError = null }) {
    this.runtimeDir = runtimeDir
    this.socket = socket
    this.harnessPid = String(harnessPid ?? '')
    this.harnessStart = String(harnessStart ?? '')
    this.onError = onError
    this.path = runtimePaths(runtimeDir, socket).owner
    this.server = null
  }

  handshake () {
    return {
      magic: OWNER_MAGIC, version: 1, socket: this.socket,
      harnessPid: this.harnessPid, harnessStart: this.harnessStart,
      ownerPid: String(process.pid), at: Date.now(),
    }
  }

  async start () {
    ensurePrivateDir(this.runtimeDir)
    try {
      const st = lstatSync(this.path)
      if (st.isSocket()) {
        const probe = await probeOwner(this.path, this.socket)
        if (probe.ok === true) throw new Error(`owner socket already active: ${this.path}`)
        unlinkSync(this.path)
      } else {
        throw new Error(`refusing to replace non-socket path: ${this.path}`)
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    await new Promise((resolve, reject) => {
      const server = createServer((sock) => {
        sock.on('error', () => { /* 忽略 */ })
        try { sock.end(JSON.stringify(this.handshake()) + '\n') } catch { /* 忽略 */ }
      })
      server.once('error', reject)
      server.listen(this.path, () => {
        try { chmodSync(this.path, 0o600) } catch { /* 忽略 */ }
        this.server = server
        resolve()
      })
    })
    return this
  }

  close () {
    const server = this.server
    this.server = null
    if (server !== null) { try { server.close() } catch { /* 忽略 */ } }
    try { unlinkSync(this.path) } catch { /* 不存在 */ }
  }
}
