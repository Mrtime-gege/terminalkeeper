/**
 * terminalkeeper —— supervisor 客户端（插件核心侧）
 *
 * 这个对象**随插件 fiber 创建/销毁**，不持有 tmux 或 watchdog。
 * 它只负责连接独立 supervisor；dispose 时 close() 即完成退场。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { connect } from 'node:net'
import { fileURLToPath } from 'node:url'
import {
  PROTOCOL_VERSION, DAEMON_BUILD, encodeFrame, ensureToken, readToken, supervisorPaths, takeFrames,
} from './protocol.mjs'

const DAEMON_ENTRY = fileURLToPath(new URL('./daemon.mjs', import.meta.url))

/**
 * 请求预算（2026-10-24 长任务实测修正）。
 *
 * 原来所有 RPC 共用一个 1500ms 预算，结果：并发写同一个 shell 时，排在后面的
 * `tmux.call` 因为要等前一个请求（比如一条 2 秒的 sleep）而被判超时——命令其实执行了，
 * 调用方却拿到 "supervisor request timeout"，属于“假失败”。
 *
 * 这些方法本来就可能等真实命令（tmux 写入/回放/校验），给 30s；控制面小请求仍用 1.5s，
 * 保持“进程卡死能很快发现”。
 */
export const SLOW_RPC_METHODS = new Set([
  'tmux.call', 'tmux.write', 'replay.start', 'replay.stop',
  'audit.verify', 'watch.subscribe', 'watch.drain', 'watchdog.ensure',
])
export function requestTimeoutFor (method, { fast = 1500, slow = 30000 } = {}) {
  return SLOW_RPC_METHODS.has(String(method ?? '')) ? slow : fast
}

export class SupervisorClient {
  constructor (options = {}) {
    this.dir = options.dir
    this.tmuxSocket = options.tmuxSocket ?? 'terminalkeeper'
    this.skipSocketCheck = false
    this.auditDir = options.auditDir ?? ''
    this.auditMirror = options.auditMirror ?? ''
    this.requiredCapabilities = Array.isArray(options.requiredCapabilities) ? options.requiredCapabilities.map(String) : []
    this.requiredDaemonBuild = options.requiredDaemonBuild === undefined ? DAEMON_BUILD : (options.requiredDaemonBuild === null ? null : String(options.requiredDaemonBuild))
    this.auditRetentionDays = Number.isFinite(options.auditRetentionDays) ? options.auditRetentionDays : 0
    this.driverOptions = options.driverOptions !== null && typeof options.driverOptions === 'object' ? options.driverOptions : {}
    this.timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 1500
    // 会等真实命令的方法单独给更宽的预算（见 requestTimeoutFor）
    this.slowTimeoutMs = Number.isFinite(options.slowTimeoutMs) ? options.slowTimeoutMs : 30000
    this.spawnDaemon = options.spawnDaemon !== false
    // SUP-17：协议版本不匹配时，forceShutdownOld 需要一条「跳过版本校验」的连接
    // 才能把旧 daemon 关掉（否则旧 daemon 永远下线不了、新 daemon 抢不到 socket）。
    this.skipVersionCheck = options.skipVersionCheck === true
    this.paths = supervisorPaths(this.dir)
    this.socket = null
    this.pending = new Map()
    this.nextId = 1
    this.buffer = ''
    this.helloInfo = null
    this.eventHandler = null
    this.reconnectHandler = null
  }

  /** 订阅 supervisor 推送事件（watch.output）；插件 fiber 必须自己清理回调。 */
  setEventHandler (handler) {
    this.eventHandler = typeof handler === 'function' ? handler : null
  }

  /** supervisor 断线后自动重连成功时调用（用于恢复 watch 订阅）。 */
  setReconnectHandler (handler) {
    this.reconnectHandler = typeof handler === 'function' ? handler : null
  }

  async connect () {
    if (this.socket !== null && !this.socket.destroyed) return this.helloInfo
    this.socket = await this.#open()
    this.socket.setEncoding('utf8')
    this.socket.on('data', (chunk) => this.#onData(chunk))
    this.socket.on('close', () => { this.socket = null; this.#rejectAll(new Error('supervisor connection closed')) })
    this.socket.on('error', (error) => this.#rejectAll(error))
    const info = await this.request('hello', {})
    const version = Number(info?.protocolVersion)
    if (this.skipVersionCheck !== true && version !== PROTOCOL_VERSION) {
      this.close()
      throw new Error(`supervisor protocol mismatch: got ${String(version)}, expected ${PROTOCOL_VERSION}`)
    }
    const caps = Array.isArray(info?.capabilities) ? info.capabilities.map(String) : []
    const missing = this.requiredCapabilities.filter((cap) => !caps.includes(cap))
    if (missing.length > 0) {
      this.close()
      throw new Error('supervisor is missing required capabilities: ' + missing.join(', '))
    }
    if (this.requiredDaemonBuild !== null && info?.daemonBuild !== this.requiredDaemonBuild) {
      this.close()
      throw new Error(`supervisor daemon build mismatch: got ${String(info?.daemonBuild)}, expected ${this.requiredDaemonBuild}`)
    }
    // 审计加固（2026-11-16）：daemon 的 tmux socket 必须与本实例一致。否则（改了 socket
    // 未重启 / 多个 profile 共用数据目录）会连到旧 daemon，RPC 落到**另一个 tmux 服务端**，
    // 读到/杀掉别的实例的 shell，审计也写进旧目录。
    if (this.skipSocketCheck !== true && typeof this.tmuxSocket === 'string' && this.tmuxSocket !== '' &&
        typeof info?.tmuxSocket === 'string' && info.tmuxSocket !== this.tmuxSocket) {
      this.close()
      throw new Error(`supervisor tmux socket mismatch: got ${JSON.stringify(info.tmuxSocket)}, expected ${JSON.stringify(this.tmuxSocket)}`)
    }
    const reconnected = this.helloInfo !== null
    this.helloInfo = info
    if (reconnected) {
      const handler = this.reconnectHandler
      if (handler !== null) queueMicrotask(() => { try { handler(info) } catch { /* 重订阅失败由下一次操作重试 */ } })
    }
    return info
  }

  async ensureStarted () {
    try {
      return await this.connect()
    } catch (firstError) {
      if (!this.spawnDaemon) throw firstError
      const message = String(firstError?.message ?? firstError)
      if (/capabilities|protocol mismatch|daemon build mismatch|socket mismatch|DAEMON_BUILD|INTERNAL/.test(message)) {
        try { await this.#forceShutdownOld() } catch { /* 已退出 */ }
      }
      ensureToken(this.dir)
      await this.#spawn()
      const deadline = Date.now() + 4000
      let lastError = firstError
      while (Date.now() < deadline) {
        try {
          return await this.connect()
        } catch (error) {
          lastError = error
          await new Promise((resolve) => setTimeout(resolve, 80))
        }
      }
      throw new Error('supervisor did not start: ' + String(lastError?.message ?? lastError))
    }
  }

  async request (method, params = {}, timeoutMs) {
    if (this.socket === null || this.socket.destroyed) {
      // supervisor 崩溃/重启后自动重连；失败则让调用方按 fail-closed 处理。
      await this.ensureStarted()
    }
    return await this.#send(method, params, timeoutMs)
  }

  async #send (method, params = {}, timeoutMs) {
    if (this.socket === null || this.socket.destroyed) throw new Error('supervisor not connected')
    const id = String(this.nextId++)
    const token = readToken(this.dir)
    if (token === '') throw new Error('supervisor token missing')
    const payload = encodeFrame({ id, method, params, token })
    return await new Promise((resolve, reject) => {
      const budget = Number.isFinite(timeoutMs)
        ? timeoutMs
        : requestTimeoutFor(method, { fast: this.timeoutMs, slow: this.slowTimeoutMs })
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`supervisor request timeout: ${method}（超过 ${budget}ms）`))
      }, budget)
      this.pending.set(id, { resolve, reject, timer, method })
      try {
        this.socket.write(payload)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  async health () {
    await this.ensureStarted()
    return await this.request('health', {})
  }

  async sessions () {
    await this.ensureStarted()
    return await this.request('sessions.list', {})
  }

  async #forceShutdownOld () {
    const caps = this.requiredCapabilities
    const build = this.requiredDaemonBuild
    const skipVersion = this.skipVersionCheck
    this.requiredCapabilities = []
    this.requiredDaemonBuild = null
    // 审计复审修复：为发 shutdown 而 connect() 时，socket 不一致检查又会被触发，
    // 于是旧 daemon 永远关不掉。这里走“跳过 socket 校验”的专用连接路径。
    // SUP-17：**版本校验也必须跳过** —— 旧 daemon 的协议版本正是我们想下线的理由，
    // 不跳过就永远连不上它，所谓“自愈”变成死循环。
    this.skipSocketCheck = true
    this.skipVersionCheck = true
    this.close()
    try {
      await this.connect()
      await this.#send('shutdown', {})
    } finally {
      this.skipSocketCheck = false
      this.skipVersionCheck = skipVersion
      this.requiredCapabilities = caps
      this.requiredDaemonBuild = build
      this.close()
    }
  }

  close () {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error('supervisor client closed'))
    }
    this.pending.clear()
    if (this.socket !== null) {
      try { this.socket.destroy() } catch { /* 忽略 */ }
      this.socket = null
    }
  }

  #onData (chunk) {
    this.buffer += chunk
    const [frames, rest] = takeFrames(this.buffer)
    this.buffer = rest
    for (const frame of frames) {
      let response
      try {
        response = JSON.parse(frame)
      } catch {
        continue
      }
      if (response?.event !== undefined && response.id === undefined) {
        try { this.eventHandler?.(response) } catch { /* 事件回调失败不能打断 RPC */ }
        continue
      }
      const entry = this.pending.get(String(response?.id ?? ''))
      if (entry === undefined) continue
      this.pending.delete(String(response.id))
      clearTimeout(entry.timer)
      if (response.ok === true) entry.resolve(response.result)
      else entry.reject(new Error(`${entry.method}: ${response?.error?.code ?? 'ERROR'} ${response?.error?.message ?? ''}`.trim()))
    }
  }

  #open () {
    return new Promise((resolve, reject) => {
      const socket = connect(this.paths.socket)
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error('supervisor connect timeout'))
      }, this.timeoutMs)
      socket.once('connect', () => {
        clearTimeout(timer)
        socket.removeListener('error', onError)
        resolve(socket)
      })
      const onError = (error) => {
        clearTimeout(timer)
        socket.destroy()
        reject(error)
      }
      socket.once('error', onError)
    })
  }

  async #spawn () {
    if (!existsSync(DAEMON_ENTRY)) throw new Error('supervisor daemon entry missing: ' + DAEMON_ENTRY)
    const args = [DAEMON_ENTRY, '--dir', this.paths.dir, '--tmux-socket', this.tmuxSocket, '--parent-pid', String(process.pid)]
    if (this.auditDir !== '') args.push('--audit-dir', this.auditDir)
    if (this.auditMirror !== '') args.push('--audit-mirror', this.auditMirror)
    if (this.auditRetentionDays > 0) args.push('--audit-retention-days', String(this.auditRetentionDays))
    const opts = this.driverOptions
    if (typeof opts.shell === 'string' && opts.shell !== '') args.push('--shell', opts.shell)
    if (typeof opts.defaultTerminal === 'string' && opts.defaultTerminal !== '') args.push('--default-terminal', opts.defaultTerminal)
    if (Number.isFinite(opts.historyLimit)) args.push('--history-limit', String(opts.historyLimit))
    if (opts.extendedKeys === true) args.push('--extended-keys', '1')
    if (opts.remainOnExit === true) args.push('--remain-on-exit', '1')
    if (opts.monitorBell === true) args.push('--monitor-bell', '1')
    if (Array.isArray(opts.shellArgs) && opts.shellArgs.length > 0) args.push('--shell-args', JSON.stringify(opts.shellArgs))
    // SUP-07：这些配置以前根本没传给 daemon —— supervisor 模式下 sessionEnv / grace /
    // watch 环 / proc-readable 全部静默失效（daemon 用硬编码默认值）。
    if (Array.isArray(opts.sessionEnv) && opts.sessionEnv.length > 0) args.push('--session-env', JSON.stringify(opts.sessionEnv.map(String)))
    if (Number.isFinite(opts.watchdogGraceMs)) args.push('--watchdog-grace-ms', String(Math.max(2000, Math.floor(opts.watchdogGraceMs))))
    if (Number.isFinite(opts.watchRingChars)) args.push('--watch-ring-chars', String(Math.floor(opts.watchRingChars)))
    if (opts.watchdogProcReadable === true) args.push('--proc-readable', '1')
    else if (opts.watchdogProcReadable === false) args.push('--proc-readable', '0')
    if (typeof opts.identityProvider === 'string' && ['auto', 'proc', 'ps', 'none'].includes(opts.identityProvider)) {
      args.push('--identity-provider', opts.identityProvider)
    }
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    })
    child.unref()
  }

  #rejectAll (error) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }
}