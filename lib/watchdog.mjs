#!/usr/bin/env node
/**
 * 孤儿看门狗（owner socket 版）。
 *
 * 职责只有一件事：某个 tmux socket 的 owner 已经不存在、且没有新 owner 接管时，
 * 收掉这个服务端。**不落盘任何状态**：没有 lease/pid 文件；身份来自
 * owner socket 的握手 + `/proc/<pid>/stat` 的 starttime。
 *
 * 判定（kill 的唯一条件）：
 *   owner socket 连续不可用 ≥ grace
 *   且 harness PID/starttime 已不存在
 *   且 没有新 owner 握手接管
 *
 * 冻结/Doze：owner socket connect 仍成功（内核 accept），视为存活，绝不 kill。
 * 同用户进程不是防线：他们本来就能 kill tmux 或伪造 socket；本程序只防崩溃孤儿。
 */
import { spawn } from 'node:child_process'
import { chmodSync, lstatSync, unlinkSync } from 'node:fs'
import { createServer, connect } from 'node:net'
import { dirname } from 'node:path'
import {
  WATCHDOG_MAGIC, WATCHDOG_ABI, checkSocketFile, ensurePrivateDir, procIdentity, probeOwner, readProcStart,
} from './watchdog-runtime.mjs'

export const DEFAULT_GRACE_MS = 300000
export const DEFAULT_INTERVAL_MS = 5000

function parseArgs (argv) {
  const out = { owner: '', control: '', socket: 'terminalkeeper', harness: '', harnessStart: '', grace: DEFAULT_GRACE_MS, interval: DEFAULT_INTERVAL_MS, procReadable: true }
  for (const raw of argv) {
    const i = raw.indexOf('=')
    if (i < 0) continue
    const key = raw.slice(2, i)
    const value = raw.slice(i + 1)
    if (key === 'owner') out.owner = value
    else if (key === 'control') out.control = value
    else if (key === 'socket') out.socket = value
    else if (key === 'harness') out.harness = value
    else if (key === 'harness-start') out.harnessStart = value
    else if (key === 'grace') out.grace = Math.max(1000, Number(value) || DEFAULT_GRACE_MS)
    else if (key === 'interval') out.interval = Math.max(500, Number(value) || DEFAULT_INTERVAL_MS)
    else if (key === 'proc-readable') out.procReadable = value === '1'
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (args.owner === '' || args.control === '' || args.socket === '') {
  process.stderr.write('[watchdog] missing --owner/--control/--socket\n')
  process.exit(2)
}

let stopping = false
let controlServer = null
let controlListenerReady = false
let failures = 0
let lastState = 'starting'
const startedAt = Date.now()
let lastProbeAt = 0
let lastOwner = ''
let watchedPid = String(args.harness ?? '')
let watchedStart = String(args.harnessStart ?? '')
let ownerPath = args.owner
let controlPath = args.control

function log (msg) { try { process.stderr.write('[watchdog] ' + msg + '\n') } catch { /* 忽略 */ } }

function identityAlive (pid, start) {
  if (!args.procReadable) return null   // 不可读 /proc：交给 socket + grace
  const cur = readProcStart(pid)
  if (cur === '') return false
  if (start === '') return true
  return String(cur) === String(start)
}

function cleanupAndExit (code) {
  if (stopping) return
  stopping = true
  try { if (controlServer !== null) controlServer.close() } catch { /* 忽略 */ }
  try { unlinkSync(controlPath) } catch { /* 不存在 */ }
  process.exit(code)
}

function reap () {
  if (stopping) return
  log(`owner gone for >= ${args.grace}ms; killing tmux server ${args.socket}`)
  const child = spawn('tmux', ['-L', args.socket, 'kill-server'], { stdio: 'ignore' })
  let done = false
  const finish = () => { if (done) return; done = true; cleanupAndExit(0) }
  child.on('error', finish)
  child.on('close', finish)
  setTimeout(finish, 2000)
}

function statusPayload () {
  return {
    magic: WATCHDOG_MAGIC, version: 1, abi: WATCHDOG_ABI, pid: String(process.pid),
    socket: args.socket, harnessPid: watchedPid, harnessStart: watchedStart,
    state: lastState, failures, grace: args.grace, interval: args.interval,
    procReadable: args.procReadable, owner: ownerPath,
    startedAt, lastProbeAt, uptimeMs: startedAt === 0 ? 0 : Date.now() - startedAt,
  }
}

function startControl () {
  return new Promise((resolve) => {
    ensurePrivateDir(dirname(controlPath))
    try {
      const st = lstatSync(controlPath)
      if (!st.isSocket()) { log('control path exists but is not a socket; refusing'); process.exit(2) }
      // 已有 watchdog？用 status 探测；可连则退出，让旧实例工作。
      const probe = connect(controlPath)
      let settled = false
      const done = (alive) => {
        if (settled) return
        settled = true
        try { probe.destroy() } catch { /* 忽略 */ }
        if (alive) { log('another watchdog already owns the control socket'); process.exit(0) }
        try { unlinkSync(controlPath) } catch { /* 忽略 */ }
        listen()
      }
      probe.setTimeout(700, () => done(false))
      probe.once('connect', () => {
        probe.write(JSON.stringify({ magic: WATCHDOG_MAGIC, cmd: 'status' }) + '\n')
      })
      probe.on('data', () => done(true))
      probe.once('error', () => done(false))
    } catch (error) {
      if (error?.code !== 'ENOENT') { log('control stat failed: ' + String(error?.message ?? error)); process.exit(2) }
      listen()
    }

    function listen () {
      const server = createServer((sock) => {
        let buf = ''
        sock.setEncoding('utf8')
        sock.on('data', (chunk) => {
          buf += chunk
          const idx = buf.indexOf('\n')
          if (idx < 0 || buf.length > 8192) return
          const line = buf.slice(0, idx)
          let msg = null
          try { msg = JSON.parse(line) } catch { msg = null }
          if (msg?.magic !== WATCHDOG_MAGIC) { try { sock.end(JSON.stringify({ magic: WATCHDOG_MAGIC, ok: false, error: 'bad magic' }) + '\n') } catch { /* 忽略 */ } return }
          if (msg.cmd === 'status') {
            try { sock.end(JSON.stringify(statusPayload()) + '\n') } catch { /* 忽略 */ }
          } else if (msg.cmd === 'adopt') {
            const pid = String(msg.harnessPid ?? '')
            const start = String(msg.harnessStart ?? '')
            if (!/^\d+$/.test(pid)) { try { sock.end(JSON.stringify({ magic: WATCHDOG_MAGIC, ok: false, error: 'bad harnessPid' }) + '\n') } catch { /* 忽略 */ } return }
            // 控制面不能把“仍活着的当前 harness”替换成别的目标：否则同用户伪造一条 adopt
            // 就能让 watchdog 改盯一个会死的 pid，进而误杀 tmux。
            const currentAlive = identityAlive(watchedPid, watchedStart)
            if (currentAlive === true && (pid !== watchedPid || start !== watchedStart)) {
              try { sock.end(JSON.stringify({ magic: WATCHDOG_MAGIC, ok: false, error: 'current harness still alive; adopt refused' }) + '\n') } catch { /* 忽略 */ }
              return
            }
            watchedPid = pid
            watchedStart = start
            failures = 0
            lastState = 'adopted'
            lastOwner = 'adopt'
            log(`adopted harness ${pid}`)
            try { sock.end(JSON.stringify({ magic: WATCHDOG_MAGIC, ok: true, ...statusPayload() }) + '\n') } catch { /* 忽略 */ }
          } else if (msg.cmd === 'disarm') {
            try { sock.end(JSON.stringify({ magic: WATCHDOG_MAGIC, ok: true, disarm: true }) + '\n') } catch { /* 忽略 */ }
            setTimeout(() => cleanupAndExit(0), 50)
          } else {
            try { sock.end(JSON.stringify({ magic: WATCHDOG_MAGIC, ok: false, error: 'unknown cmd' }) + '\n') } catch { /* 忽略 */ }
          }
        })
        sock.on('error', () => { /* 忽略 */ })
      })
      server.once('error', (error) => { log('control listen failed: ' + String(error?.message ?? error)); process.exit(2) })
      server.listen(controlPath, () => {
        try { chmodSync(controlPath, 0o600) } catch { /* 忽略 */ }
        controlServer = server
        controlListenerReady = true
        resolve()
      })
    }
  })
}

async function tick () {
  if (stopping || controlListenerReady !== true) return
  lastProbeAt = Date.now()
  const probe = await probeOwner(ownerPath, args.socket, 800)
  if (probe.ok === true) {
    const h = probe.handshake ?? {}
    const pid = String(h.harnessPid ?? '')
    const start = String(h.harnessStart ?? '')
    const currentAlive = identityAlive(watchedPid, watchedStart)
    // owner socket 可以被同用户替换；若当前 harness 还活着，绝不允许握手把它改绑到
    // 另一个 pid/starttime（否则伪造 owner + 让假 pid 退出就能误杀）。
    if (currentAlive === true && (pid !== watchedPid || start !== watchedStart)) {
      lastState = 'owner-conflict'
      failures = 0
      return
    }
    const alive = identityAlive(pid, start)
    if (alive === false) {
      lastState = 'invalid-owner'
      failures += 1
      // 假冒 owner：不据此 kill（宁可留孤儿，不误杀）；连续异常则退出让插件重布防。
      if (failures * args.interval >= args.grace) { log('owner handshake failed identity check too long; exiting'); cleanupAndExit(2) }
      return
    }
    watchedPid = pid
    watchedStart = start
    lastOwner = ownerPath
    failures = 0
    lastState = 'owner-alive'
    return
  }
  if (['not-socket', 'wrong-uid', 'bad-dir', 'dir-uid', 'dir-perm', 'stat-error'].includes(String(probe.reason))) {
    log(`owner socket unsafe (${probe.reason}); not killing, exiting for re-arm`)
    cleanupAndExit(2)
    return
  }
  const alive = identityAlive(watchedPid, watchedStart)
  if (alive === true) {
    lastState = 'harness-alive-socket-missing'
    failures = 0
    return
  }
  failures += 1
  lastState = 'owner-missing'
  if (failures * args.interval >= args.grace) reap()
}

process.on('SIGTERM', () => cleanupAndExit(0))
process.on('SIGINT', () => cleanupAndExit(0))

startControl().then(() => {
  tick()
  setInterval(tick, args.interval).unref()
}).catch((error) => {
  log('startup failed: ' + String(error?.message ?? error))
  cleanupAndExit(2)
})
