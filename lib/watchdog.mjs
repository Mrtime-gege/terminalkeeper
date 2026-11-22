#!/usr/bin/env node
/**
 * 孤儿看门狗（owner socket 版）。
 *
 * 职责只有一件事：某个 tmux socket 的 owner 已经不存在、且没有新 owner 接管时，
 * 收掉这个服务端。**不落盘任何状态**：没有 lease/pid 文件；身份来自
 * owner socket 的握手 + 平台身份提供者（Linux `/proc/<pid>/stat` starttime；
 * macOS/无 proc 用 `ps -p <pid> -o lstart=`）。
 *
 * 判定（kill 的唯一条件，全部满足才动手）：
 *   owner socket 连续不可用 ≥ grace
 *   **且身份提供者能证明** harness PID/starttime 已不存在（无法证明 = 不 kill）
 *   **且**临 kill 前最后一次 owner 探活仍失败
 *   **且** tmux 服务端的 @terminalkeeper_owner 标记存在并与本实例一致
 *   且 没有新 owner 握手接管
 *
 * 冻结/Doze：owner socket connect 仍成功（内核 accept），视为存活，绝不 kill。
 * 无可用身份提供者（既无 /proc 也无 ps）：**不 kill，只报告**（fail-safe）。
 * 同用户进程不是防线：他们本来就能 kill tmux 或伪造 socket；本程序只防崩溃孤儿。
 */
import { spawn } from 'node:child_process'
import { chmodSync, lstatSync, unlinkSync } from 'node:fs'
import { createServer, connect } from 'node:net'
import { dirname } from 'node:path'
import {
  WATCHDOG_MAGIC, WATCHDOG_ABI, checkSocketFile, createIdentityProvider, ensurePrivateDir,
  probeOwner, readServerOwner, serverOwnerToken, verifyServerOwnerToken,
} from './watchdog-runtime.mjs'

export const DEFAULT_GRACE_MS = 300000
export const DEFAULT_INTERVAL_MS = 5000

function parseArgs (argv) {
  const out = {
    owner: '', control: '', socket: 'terminalkeeper', harness: '', harnessStart: '',
    grace: DEFAULT_GRACE_MS, interval: DEFAULT_INTERVAL_MS, procReadable: true,
    identity: 'auto', serverOwner: '', requireServerOwner: true,
  }
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
    else if (key === 'identity-provider') out.identity = value
    else if (key === 'server-owner') out.serverOwner = value
    else if (key === 'require-server-owner') out.requireServerOwner = value !== '0'
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (args.owner === '' || args.control === '' || args.socket === '' || !/^\d+$/.test(String(args.harness))) {
  process.stderr.write('[watchdog] missing/invalid --owner/--control/--socket/--harness\n')
  process.exit(2)
}

// SUP-03：身份判定交给平台提供者。可用性用**自身**（活进程）探测，不能用被监视 pid
// （它可能已经死了，会让我们误以为「没有提供者」）。
const identity = createIdentityProvider({
  mode: args.identity,
  procReadable: args.procReadable,
  probePid: String(process.pid),
})

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
// 身份 starttime 缺失时（例如 macOS 上 harness 侧只有 ps，或旧调用方传空）由提供者自己补读：
// 少了它，PID 复用就可能被判成「还是原进程」。
if (watchedStart === '' && identity.available) watchedStart = identity.readStart(watchedPid)
const expectedServerOwner = String(args.serverOwner ?? '').trim() !== ''
  ? String(args.serverOwner).trim()
  : serverOwnerToken({ runtimeDir: dirname(args.owner), socket: args.socket })
let lastServerOwner = { ok: false, token: '', reason: '' }
let ownerPath = args.owner
let controlPath = args.control
let reaping = false

function log (msg) { try { process.stderr.write('[watchdog] ' + msg + '\n') } catch { /* 忽略 */ } }

function identityAlive (pid, start) {
  return identity.alive(pid, start)
}

function cleanupAndExit (code) {
  if (stopping) return
  stopping = true
  try { if (controlServer !== null) controlServer.close() } catch { /* 忽略 */ }
  try { unlinkSync(controlPath) } catch { /* 不存在 */ }
  process.exit(code)
}

/**
 * 收尸。每一步都是**否证式**的：任何一步不能确认，就只报告、不 kill。
 * @returns {Promise<boolean>} 是否真的发起 kill
 */
async function reap () {
  if (stopping || reaping) return false
  reaping = true
  try {
    // ① 必须能证明 harness 已死（null = 无法证明 → 不 kill）
    const alive = identityAlive(watchedPid, watchedStart)
    if (alive !== false) {
      lastState = alive === true ? 'harness-alive' : 'identity-unknown'
      failures = 0
      return false
    }
    // ② kill 前最后一次 owner 探活：owner 恰好回来（重新布防/接管）就放弃
    const last = await probeOwner(ownerPath, args.socket, 800)
    if (last.ok === true) {
      lastState = 'owner-returned'
      failures = 0
      return false
    }
    // ③ 服务端归属：必须存在且与本次实例一致（SUP-02）。缺失/不一致一律不 kill。
    if (args.requireServerOwner) {
      lastServerOwner = await readServerOwner({ socket: args.socket, timeoutMs: 2000 })
      if (lastServerOwner.ok !== true) {
        lastState = 'server-owner-unreadable'
        log(`refusing to kill tmux server ${args.socket}: ownership marker unreadable (${lastServerOwner.reason}); not killing`)
        return false
      }
      if (verifyServerOwnerToken(args.serverOwner !== '' ? args.serverOwner : expectedServerOwner, lastServerOwner.token) !== true) {
        lastState = 'server-owner-mismatch'
        log(`refusing to kill tmux server ${args.socket}: ownership marker mismatch (another instance owns it); not killing`)
        return false
      }
    }
    log(`owner gone for >= ${args.grace}ms, harness identity ${watchedPid} proven dead, server owner verified; killing tmux server ${args.socket}`)
    const child = spawn('tmux', ['-L', args.socket, 'kill-server'], { stdio: 'ignore' })
    let done = false
    const finish = () => { if (done) return; done = true; cleanupAndExit(0) }
    child.on('error', finish)
    child.on('close', finish)
    setTimeout(finish, 2000)
    return true
  } finally {
    reaping = false
  }
}

function statusPayload () {
  return {
    magic: WATCHDOG_MAGIC, version: 1, abi: WATCHDOG_ABI, pid: String(process.pid),
    socket: args.socket, harnessPid: watchedPid, harnessStart: watchedStart,
    state: lastState, failures, grace: args.grace, interval: args.interval,
    procReadable: args.procReadable, owner: ownerPath,
    identityProvider: identity.name, identityAvailable: identity.available,
    identity: identity.describe(),
    serverOwnerRequired: args.requireServerOwner, serverOwner: expectedServerOwner,
    lastServerOwner,
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
            watchedStart = start !== '' ? start : (identity.available ? identity.readStart(pid) : '')
            failures = 0
            lastState = 'adopted'
            lastOwner = 'adopt'
            log(`adopted harness ${pid} (${identity.name})`)
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
  // SUP-03 fail-safe：没有可用身份提供者时绝不进入 kill 路径，只把状态报给控制面。
  if (identity.available !== true) {
    lastState = 'identity-unavailable'
    failures = 0
    return
  }
  const probe = await probeOwner(ownerPath, args.socket, 800)
  if (probe.ok === true) {
    const h = probe.handshake ?? {}
    const pid = String(h.harnessPid ?? '')
    const rawStart = String(h.harnessStart ?? '')
    const currentAlive = identityAlive(watchedPid, watchedStart)
    // owner 握手可能不带 starttime（macOS 上 harness 侧读不到 /proc）：用提供者补读，
    // 只比较 pid，不因为「start 缺失」把合法接管判成冲突。
    const start = rawStart !== '' ? rawStart : (intraHandshakeStart(pid))
    // owner socket 可以被同用户替换；若当前 harness 还活着，绝不允许握手把它改绑到
    // 另一个 pid/starttime（否则伪造 owner + 让假 pid 退出就能误杀）。
    if (currentAlive === true && (pid !== watchedPid || (start !== '' && start !== watchedStart))) {
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
    // 握手没带 start 时，不把「未知」写成基线（否则下次比对会把未知当不同 → 误判冲突）。
    if (start !== '') watchedStart = start
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
  // 关键 fail-safe：alive === null 表示「无法证明死亡」。旧实现把它当死而 kill，
  // 正是 macOS/无 /proc 误杀的原因。这里只报告，不累计 failures。
  if (alive === null) {
    lastState = 'identity-unknown'
    failures = 0
    return
  }
  failures += 1
  lastState = 'owner-missing'
  if (failures * args.interval >= args.grace) await reap()
}

/** 握手没带 starttime 时，用身份提供者补读（失败返回空串）。 */
function intraHandshakeStart (pid) {
  if (!identity.available) return ''
  return identity.readStart(pid)
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
