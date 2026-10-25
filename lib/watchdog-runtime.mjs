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
import { chmodSync, lstatSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { createServer, connect } from 'node:net'
import { dirname, join } from 'node:path'

export const OWNER_MAGIC = 'terminalkeeper-owner-v1'
export const WATCHDOG_MAGIC = 'terminalkeeper-watchdog-v1'
/** 看门狗行为 ABI：改动判定/控制语义时递增，插件会替换旧进程而不是继续收养。 */
export const WATCHDOG_ABI = 2

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
