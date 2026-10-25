#!/usr/bin/env node
/**
 * terminalkeeper —— 独立监督进程（Phase 1 骨架）
 *
 * 它不导入 DSH/Cordis，也不由插件 fiber 拥有。当前提供：
 *   hello / health / sessions.list / shutdown
 *
 * 后续 Phase 2 会把 watch 泵、回放录制、会话审计写入迁进来；tmux 会话与看门狗
 * 最终归这里持有，插件核心只做 RPC 客户端。
 *
 * 启动：
 *   node lib/supervisor/daemon.mjs --dir ~/.dsh/terminalkeeper --tmux-socket terminalkeeper
 */

import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { appendFile, mkdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, createServer } from 'node:net'
import {
  DAEMON_BUILD, DAEMON_VERSION, PROTOCOL_VERSION, encodeFrame, ensureToken, fail, ok,
  readToken, supervisorPaths, takeFrames, validateRequest,
} from './protocol.mjs'
import { TmuxDriver, isShellForeground } from '../tmux.js'
import { diffSince, isSafeSessionName, maskVaultLine, redactSecrets, stripAnsi } from '../pure.mjs'
import { createSubprocess, createTimer } from './tmux-adapter.mjs'
import { appendAudit, auditPaths as buildAuditPaths, dayKey, detectAppendOnly, pruneAuditFiles, readChainHeadFast, readSealedChain, verifyAuditDays } from '../audit.js'
import { verifyCheckpoints } from '../audit-checkpoints.mjs'
import { firstBadDayVerdict } from '../audit-verdict.mjs'

function parseArgs (argv) {
  const out = { dir: '', tmuxSocket: 'terminalkeeper', serverLaunch: 'systemd-scope', auditDir: '', auditMirror: '', auditRetentionDays: 30, idleExitMs: 120000, parentPid: 0, shell: 'bash', defaultTerminal: 'tmux-256color', historyLimit: 100000, extendedKeys: false, remainOnExit: false, monitorBell: true, shellArgs: [], verbose: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dir') out.dir = argv[++i] ?? ''
    else if (a === '--tmux-socket') out.tmuxSocket = argv[++i] ?? 'terminalkeeper'
    else if (a === '--server-launch') out.serverLaunch = argv[++i] === 'plain-detach' ? 'plain-detach' : 'systemd-scope'
    else if (a === '--audit-dir') out.auditDir = argv[++i] ?? ''
    else if (a === '--audit-mirror') out.auditMirror = argv[++i] ?? ''
    else if (a === '--audit-retention-days') out.auditRetentionDays = Math.max(1, Number(argv[++i]) || 30)
    else if (a === '--idle-exit-ms') out.idleExitMs = Math.max(0, Number(argv[++i]) || 0)
    else if (a === '--parent-pid') out.parentPid = Math.max(0, Number(argv[++i]) || 0)
    else if (a === '--shell') out.shell = String(argv[++i] ?? 'bash') || 'bash'
    else if (a === '--default-terminal') out.defaultTerminal = String(argv[++i] ?? 'tmux-256color') || 'tmux-256color'
    else if (a === '--history-limit') out.historyLimit = Math.max(100, Number(argv[++i]) || 100000)
    else if (a === '--extended-keys') out.extendedKeys = argv[++i] === '1'
    else if (a === '--remain-on-exit') out.remainOnExit = argv[++i] === '1'
    else if (a === '--monitor-bell') out.monitorBell = argv[++i] === '1'
    else if (a === '--shell-args') { try { const parsed = JSON.parse(String(argv[++i] ?? '[]')); if (Array.isArray(parsed)) out.shellArgs = parsed.map(String) } catch { /* 忽略非法参数 */ } }
    else if (a === '--verbose') out.verbose = true
    else if (a === '--help' || a === '-h') {
      process.stdout.write('usage: daemon.mjs [--dir DIR] [--tmux-socket NAME] [--verbose]\n')
      process.exit(0)
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const paths = supervisorPaths(args.dir || undefined)
ensureToken(paths.dir)
const expectedToken = readToken(paths.dir)
const audit = buildAuditPaths(args.auditDir || paths.dir)
const auditChain = { head: 'genesis', seq: 0, mirror: args.auditMirror, ready: null }
auditChain.ready = (async () => {
  try { mkdirSync(audit.dir, { recursive: true, mode: 0o700 }) } catch { /* 写入时再报 */ }
  try { auditChain.head = await readChainHeadFast(audit) } catch { /* 读失败按 genesis */ }
})()
const startedAt = Date.now()
let stopping = false
let connections = 0
const clients = new Set()
let idleTimer = null
let parentTimer = null
let prunedDay = ''
let auditVerifyCache = null
let auditVerifyTimer = null
let watchdogDriverInstance = null
let watchdogLast = { pid: '', harnessPid: '', at: 0 }
const replayRecorders = new Map()
const REPLAY_CAP = 8 * 1024 * 1024
const REPLAY_BUSY_MS = 1000
const REPLAY_IDLE_MS = 5000

function log (message) {
  if (!args.verbose) return
  process.stderr.write(`[supervisor] ${message}\n`)
}

function monitorParent () {
  if (args.parentPid <= 0 || parentTimer !== null) return
  parentTimer = setInterval(() => {
    try {
      process.kill(args.parentPid, 0)
    } catch (error) {
      if (error?.code === 'ESRCH') shutdown('parent process gone')
    }
  }, 5000)
  if (typeof parentTimer.unref === 'function') parentTimer.unref()
}

function scheduleIdleExit () {
  if (idleTimer !== null) { clearTimeout(idleTimer); idleTimer = null }
  if (args.idleExitMs <= 0 || clients.size > 0) return
  idleTimer = setTimeout(() => {
    idleTimer = null
    if (clients.size === 0) shutdown('idle: no core connected')
  }, args.idleExitMs)
  if (typeof idleTimer.unref === 'function') idleTimer.unref()
}

function broadcast (event) {
  const frame = encodeFrame(event)
  for (const socket of clients) {
    if (socket.destroyed) { clients.delete(socket); continue }
    try { socket.write(frame) } catch { try { socket.destroy() } catch {} ; clients.delete(socket) }
  }
}

function canConnect (path, timeoutMs = 250) {
  return new Promise((resolve) => {
    const socket = connect(path)
    let settled = false
    const done = (value) => { if (settled) return; settled = true; try { socket.destroy() } catch {} ; resolve(value) }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    setTimeout(() => done(false), timeoutMs)
  })
}

function run (command, argv, timeout = 5000) {
  return new Promise((resolve) => {
    execFile(command, argv, { timeout, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }, (error, stdout, stderr) => {
      resolve({ ok: error === null, code: error?.code ?? 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

async function tmux (subcommand, argv = []) {
  return run('tmux', ['-L', args.tmuxSocket, subcommand, ...argv])
}

async function tmuxVersion () {
  const r = await run('tmux', ['-V'])
  return r.ok ? r.stdout.trim() : ''
}

async function sessionList () {
  const r = await tmux('list-sessions', ['-F', '#{session_name}\t#{session_created}\t#{session_attached}\t#{session_windows}'])
  if (!r.ok) {
    const text = (r.stderr + r.stdout).trim()
    if (/no server running|error connecting/i.test(text)) return { ok: true, sessions: [], server: false }
    return { ok: false, error: text.slice(0, 300), sessions: [] }
  }
  const sessions = r.stdout.split('\n').filter(Boolean).map((line) => {
    const [name, created, attached, windows] = line.split('\t')
    return { name, createdAt: Number(created) || 0, attached: attached === '1', windows: Number(windows) || 0 }
  })
  return { ok: true, sessions, server: true }
}

// ── watch 域（Phase 2a）：订阅、输出环、400ms 抓屏泵都在 supervisor ──────────
// 注意：这里不导入 DSH；TmuxDriver 只依赖最小 subprocess/timer 适配。
let watchDriver = null
const watchSubs = new Map()        // identity -> Map(shell -> cursor)
const watchBaseline = new Map()    // shell -> screen
let watchPumpTimer = null
let watchPumping = false

function driver () {
  if (watchDriver !== null) return watchDriver
  watchDriver = new TmuxDriver({
    subprocess: createSubprocess(),
    timer: createTimer(),
    socket: args.tmuxSocket,
    serverLaunch: args.serverLaunch,
    historyLimit: args.historyLimit,
    shell: args.shell,
    defaultTerminal: args.defaultTerminal,
    extendedKeys: args.extendedKeys,
    remainOnExit: args.remainOnExit,
    monitorBell: args.monitorBell,
    shellArgs: args.shellArgs,
    cwd: '/',
    runtimeDir: join(args.auditDir || args.dir || paths.dir, 'run'),
    watchdogStrategy: 'owner-socket',
    watchdogGraceMs: 300000,
    harnessPid: args.parentPid > 0 ? String(args.parentPid) : '',
  })
  return watchDriver
}

function watchNames () {
  const names = new Set()
  for (const subs of watchSubs.values()) for (const name of subs.keys()) names.add(name)
  return names
}

async function screenOf (name) {
  try {
    const captured = await driver().captureWithMeta(name, undefined, { trim: false })
    return stripAnsi(String(captured?.screen ?? ''))
  } catch { return null }
}

async function pumpWatchOnce () {
  if (watchPumping) return
  watchPumping = true
  try {
    for (const name of watchNames()) {
      const screen = await screenOf(name)
      if (screen === null) continue
      const previous = watchBaseline.get(name)
      watchBaseline.set(name, screen)
      if (previous === undefined) continue
      const delta = diffSince(previous, screen)
      if (delta !== '') {
        driver().appendWatchedOutput(name, delta)
        broadcast({ event: 'watch.output', name, text: delta, at: Date.now() })
      }
    }
  } finally { watchPumping = false }
}

function startWatchPump () {
  if (watchPumpTimer !== null) return
  watchPumpTimer = setInterval(() => { void pumpWatchOnce() }, 400)
  if (typeof watchPumpTimer.unref === 'function') watchPumpTimer.unref()
}

function stopWatchPumpIfIdle () {
  const any = [...watchSubs.values()].some((subs) => subs.size > 0)
  if (any) return
  if (watchPumpTimer !== null) { clearInterval(watchPumpTimer); watchPumpTimer = null }
  watchBaseline.clear()
}

function watchRows () {
  return [...watchSubs.entries()].map(([identity, subs]) => ({
    identity,
    shells: [...subs.entries()].map(([name, cursor]) => ({ name, cursor })),
  }))
}

async function refreshAuditVerify () {
  if (auditVerifyTimer !== null) { clearTimeout(auditVerifyTimer); auditVerifyTimer = null }
  try {
    await auditChain.ready
    const chain = await readSealedChain(audit)
    const perDay = await verifyAuditDays(audit)
    const badDays = perDay.days.filter((day) => day.ok !== true)
    const verify = firstBadDayVerdict(chain.verify, perDay, badDays)
    const checkpoints = await verifyCheckpoints(audit, {
      mirror: args.auditMirror,
      retentionDays: args.auditRetentionDays,
    }).catch(() => null)
    const locked = await detectAppendOnly(audit.dir).catch(() => 'unknown')
    auditVerifyCache = {
      verify,
      checkpoints,
      locked,
      checkedAt: Date.now(),
      head: auditChain.head,
      seq: auditChain.seq,
    }
  } catch (error) {
    auditVerifyCache = {
      verify: { ok: false, error: String(error?.message ?? error) },
      checkpoints: null,
      locked: 'unknown',
      checkedAt: Date.now(),
      head: auditChain.head,
      seq: auditChain.seq,
    }
  }
}

function scheduleAuditVerify () {
  if (auditVerifyTimer !== null) return
  auditVerifyTimer = setTimeout(() => { auditVerifyTimer = null; void refreshAuditVerify() }, 1200)
  if (typeof auditVerifyTimer.unref === 'function') auditVerifyTimer.unref()
}

function watchdogDriver () {
  if (watchdogDriverInstance !== null) return watchdogDriverInstance
  watchdogDriverInstance = new TmuxDriver({
    subprocess: createSubprocess(),
    timer: createTimer(),
    socket: args.tmuxSocket,
    serverLaunch: args.serverLaunch,
    historyLimit: 1000,
    shell: 'bash',
    cwd: '/',
    runtimeDir: join(args.auditDir || args.dir || paths.dir, 'run'),
    watchdogStrategy: 'owner-socket',
    watchdogGraceMs: 300000,
    harnessPid: args.parentPid > 0 ? String(args.parentPid) : '',
  })
  return watchdogDriverInstance
}

async function ensureWatchdog () {
  try {
    const d = watchdogDriver()
    await d.ensureOwnerSocket()
    const current = await d.watchdogStatusCurrent()
    if (current !== null) {
      watchdogLast = { pid: String(current.pid ?? ''), harnessPid: String(current.harnessPid ?? ''), at: Date.now() }
      return { ok: true, adopted: true, watchdogPid: watchdogLast.pid, harnessPid: watchdogLast.harnessPid }
    }
    const raw = await d.watchdogStatus()
    if (raw !== null) await d.replaceWatchdog()
    else await d.armWatchdog()
    const harness = await d.harnessPid()
    const fresh = await d.watchdogStatus()
    watchdogLast = {
      pid: String(fresh?.pid ?? ''),
      harnessPid: String(fresh?.harnessPid ?? harness ?? ''),
      at: Date.now(),
    }
    return { ok: true, adopted: false, watchdogPid: watchdogLast.pid, harnessPid: watchdogLast.harnessPid }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error), watchdogPid: '' }
  }
}

const TMUX_READ_METHODS = new Set([
  'list', 'has', 'screen', 'captureWithMeta', 'foregroundOf', 'paneCpu', 'bellFlag', 'rawReply', 'resolveForeground',
  'probe', 'probeTmux', 'mouseFlags', 'paneProcs',
])
const TMUX_WRITE_METHODS = new Set([
  'create', 'send', 'sendBytes', 'kill', 'respawn', 'resize', 'setLabel', 'startCapture', 'stopCapture', 'reapPhantomOrphans',
  'bootstrap', 'writeServerConfig',
])

function replayFrameLine (rec, captured) {
  const text = String(captured?.screen ?? '')
  const masked = rec.marks.length > 0 ? text.split('\n').map((line) => maskVaultLine(line, rec.marks)).join('\n') : text
  const shown = rec.redact ? redactSecrets(masked) : masked
  const meta = captured?.meta ?? {}
  const fg = String(meta.foreground ?? '')
  const fingerprint = shown + '\u0000' + fg + '\u0000' + String(meta.cols) + 'x' + String(meta.rows)
  return { shown, meta, fg, fingerprint }
}

async function snapReplay (name) {
  const rec = replayRecorders.get(name)
  if (rec === undefined || rec.stopped) return
  let captured
  try {
    captured = await driver().captureWithMeta(name, undefined, { trim: false })
    rec.misses = 0
  } catch {
    rec.misses += 1
    if (rec.misses >= 2) stopReplay(name, 'stopped: session gone')
    return
  }
  const { shown, meta, fg, fingerprint } = replayFrameLine(rec, captured)
  if (rec.lastFp === fingerprint) {
    scheduleReplaySnap(name, fg !== '' && !isShellForeground(fg) ? REPLAY_BUSY_MS : REPLAY_IDLE_MS)
    return
  }
  rec.lastFp = fingerprint
  const line = JSON.stringify({
    t: Date.now() - rec.startedAt,
    w: meta.cols ?? 0, h: meta.rows ?? 0,
    x: meta.cursorX ?? 0, y: meta.cursorY ?? 0,
    fg, s: shown,
  }) + '\n'
  if (rec.bytes + line.length > REPLAY_CAP) { stopReplay(name, `stopped: size cap reached (${REPLAY_CAP} bytes)`); return }
  rec.bytes += line.length
  rec.frames += 1
  try { await appendFile(rec.file, line, { mode: 0o600 }) } catch { stopReplay(name, 'stopped: write failed'); return }
  scheduleReplaySnap(name, fg !== '' && !isShellForeground(fg) ? REPLAY_BUSY_MS : REPLAY_IDLE_MS)
}

function scheduleReplaySnap (name, ms) {
  const rec = replayRecorders.get(name)
  if (rec === undefined || rec.stopped) return
  clearTimeout(rec.timer)
  rec.timer = setTimeout(() => { rec.timer = null; void snapReplay(name) }, ms)
  if (typeof rec.timer.unref === 'function') rec.timer.unref()
}

function stopReplay (name, why) {
  const rec = replayRecorders.get(name)
  if (rec === undefined) return null
  replayRecorders.delete(name)
  rec.stopped = true
  clearTimeout(rec.timer)
  try { rec.off?.() } catch { /* 忽略 */ }
  return { name, file: rec.file, startedAt: rec.startedAt, frames: rec.frames, bytes: rec.bytes, why }
}

async function startReplay (params) {
  const name = String(params?.name ?? '')
  if (!isSafeSessionName(name)) return { ok: false, error: 'bad shell name' }
  if (replayRecorders.has(name)) {
    const rec = replayRecorders.get(name)
    return { ok: true, existing: true, file: rec.file, startedAt: rec.startedAt }
  }
  const file = String(params?.file ?? '')
  const startedAt = Number(params?.startedAt)
  if (file === '' || !Number.isFinite(startedAt)) return { ok: false, error: 'bad replay file/startedAt' }
  const outputRoot = audit.outputDir.endsWith('/') ? audit.outputDir : audit.outputDir + '/'
  if (!file.startsWith(outputRoot) || !/frames-[A-Za-z0-9._-]+\.jsonl$/.test(file)) return { ok: false, error: 'replay file outside output dir' }
  const rec = {
    file, startedAt,
    lastFp: null, frames: 0, bytes: 0, stopped: false, off: null, timer: null, misses: 0,
    marks: Array.isArray(params?.marks) ? params.marks : [],
    redact: params?.redact === true,
  }
  try {
    await mkdir(audit.outputDir, { recursive: true, mode: 0o700 })
    let exists = false
    try { await stat(file); exists = true } catch { /* 新文件 */ }
    if (!exists) await appendFile(file, JSON.stringify({ header: true, t: 0, startedAt, socket: args.tmuxSocket }) + '\n', { mode: 0o600 })
    else rec.bytes = (await stat(file)).size
    replayRecorders.set(name, rec)
    rec.off = driver().onActivity((mutated) => {
      if (mutated !== name || rec.stopped) return
      scheduleReplaySnap(name, 150)
    })
    await snapReplay(name)
    return { ok: true, existing: false, file, startedAt, frames: rec.frames, bytes: rec.bytes }
  } catch (error) {
    replayRecorders.delete(name)
    rec.stopped = true
    return { ok: false, error: String(error?.message ?? error) }
  }
}

async function handle (request) {
  if (request.token !== expectedToken) {
    return fail(request.id, 'UNAUTHORIZED', 'invalid supervisor token')
  }
  switch (request.method) {
    case 'hello':
      return ok(request.id, {
        protocolVersion: PROTOCOL_VERSION,
        daemonVersion: DAEMON_VERSION,
        daemonBuild: DAEMON_BUILD,
        pid: process.pid,
        tmuxSocket: args.tmuxSocket,
        startedAt,
        capabilities: ['hello', 'health', 'sessions.list', 'watch.subscribe', 'watch.unsubscribe', 'watch.drain', 'watch.status', 'audit.append', 'audit.status', 'audit.verify', 'watchdog.ensure', 'watchdog.status', 'watchdog.disarm', 'tmux.read', 'tmux.write', 'replay.start', 'replay.stop', 'replay.marks', 'replay.status', 'shutdown'],
      })
    case 'health': {
      const version = await tmuxVersion()
      const list = await sessionList()
      return ok(request.id, {
        ok: list.ok,
        protocolVersion: PROTOCOL_VERSION,
        daemonVersion: DAEMON_VERSION,
        daemonBuild: DAEMON_BUILD,
        pid: process.pid,
        tmuxSocket: args.tmuxSocket,
        uptimeMs: Date.now() - startedAt,
        tmux: { ok: version !== '', version, sessions: list.sessions.length, server: list.server === true },
        connections,
        watch: { identities: watchSubs.size, shells: watchNames().size, pumping: watchPumpTimer !== null },
        watchdog: { pid: watchdogLast.pid, harnessPid: watchdogLast.harnessPid, at: watchdogLast.at },
        audit: { dir: audit.dir, head: auditChain.head, seq: auditChain.seq },
      })
    }
    case 'sessions.list':
      return ok(request.id, await sessionList())
    case 'watch.subscribe': {
      const identity = String(request.params?.identity ?? '')
      const names = Array.isArray(request.params?.names) ? request.params.names.map(String) : []
      if (identity === '') return fail(request.id, 'BAD_REQUEST', 'watch.subscribe requires identity')
      if (names.length > 32) return fail(request.id, 'BAD_REQUEST', 'too many names')
      for (const name of names) if (!isSafeSessionName(name)) return fail(request.id, 'BAD_REQUEST', 'unsafe session name')
      let subs = watchSubs.get(identity)
      if (subs === undefined) { subs = new Map(); watchSubs.set(identity, subs) }
      const added = []
      const cursors = {}
      for (const name of names) {
        if (subs.has(name)) { cursors[name] = subs.get(name); continue }
        driver().watchOutput(name)
        const screen = (await screenOf(name)) ?? ''
        watchBaseline.set(name, screen)
        const cursor = driver().drainOutput(name, 0).cursor
        subs.set(name, cursor)
        cursors[name] = cursor
        added.push(name)
      }
      if (added.length > 0) startWatchPump()
      return ok(request.id, { added, cursors })
    }
    case 'watch.unsubscribe': {
      const identity = String(request.params?.identity ?? '')
      const names = Array.isArray(request.params?.names) ? request.params.names.map(String) : []
      const subs = watchSubs.get(identity)
      const removed = []
      if (subs !== undefined) {
        for (const name of names) {
          if (!subs.has(name)) continue
          subs.delete(name)
          removed.push(name)
          const stillWatched = [...watchSubs.values()].some((m) => m.has(name))
          if (!stillWatched) {
            driver().unwatchOutput(name)
            watchBaseline.delete(name)
          }
        }
        if (subs.size === 0) watchSubs.delete(identity)
      }
      stopWatchPumpIfIdle()
      return ok(request.id, { removed })
    }
    case 'watch.drain': {
      const name = String(request.params?.name ?? '')
      if (!isSafeSessionName(name)) return fail(request.id, 'BAD_REQUEST', 'unsafe session name')
      const cursor = Number(request.params?.cursor)
      const drained = driver().drainOutput(name, Number.isFinite(cursor) ? cursor : 0)
      return ok(request.id, drained)
    }
    case 'watch.status':
      return ok(request.id, { rows: watchRows(), pumping: watchPumpTimer !== null })
    case 'audit.append': {
      const record = request.params?.record
      if (record === null || typeof record !== 'object' || Array.isArray(record)) {
        return fail(request.id, 'BAD_REQUEST', 'audit.append requires record object')
      }
      await auditChain.ready
      const day = dayKey(Date.now())
      if (prunedDay !== day) {
        prunedDay = day
        await pruneAuditFiles(audit, day, args.auditRetentionDays).catch(() => {})
      }
      const written = await appendAudit(audit, day, { ts: Date.now(), ...record }, auditChain)
      if (written !== true) return fail(request.id, 'AUDIT_WRITE_FAILED', 'audit append failed')
      scheduleAuditVerify()
      return ok(request.id, { ok: true, day, head: auditChain.head, seq: auditChain.seq })
    }
    case 'audit.verify':
      await refreshAuditVerify()
      return ok(request.id, { ok: true, dir: audit.dir, ...auditVerifyCache })
    case 'audit.status':
      await auditChain.ready
      return ok(request.id, { ok: true, dir: audit.dir, head: auditChain.head, seq: auditChain.seq, cached: auditVerifyCache })
    case 'watchdog.ensure':
      return ok(request.id, await ensureWatchdog())
    case 'watchdog.disarm':
      await watchdogDriver().disarmWatchdog()
      watchdogDriver().closeOwnerSocket()
      watchdogLast = { pid: '', harnessPid: '', at: Date.now() }
      return ok(request.id, { ok: true })
    case 'watchdog.status':
      return ok(request.id, { ok: true, ...watchdogLast, current: await watchdogDriver().watchdogPid().catch(() => '') })
    case 'tmux.call': {
      const method = String(request.params?.method ?? '')
      if (!TMUX_READ_METHODS.has(method) && !TMUX_WRITE_METHODS.has(method)) return fail(request.id, 'BAD_METHOD', 'tmux method is not allowed')
      let args = Array.isArray(request.params?.args) ? request.params.args : []
      // core 的 driver.probe(argvArray) 经 Proxy 序列化成 [argvArray]；展平后按 tmux argv 处理。
      if (method === 'probe' && args.length === 1 && Array.isArray(args[0])) args = args[0]
      if (method === 'probe') {
        const verb = String(args[0] ?? '')
        if (!new Set(['display', 'show-options', 'list-sessions', 'list-windows', 'list-panes']).has(verb)) return fail(request.id, 'BAD_METHOD', 'probe verb is not read-only')
      }
      try {
        // probe 的入参是**一个 argv 数组**（TmuxDriver.probe(argv)），不能展开成多个参数。
        const result = method === 'probe' ? await driver().probe(args) : await driver()[method](...args)
        if (method === 'send' || method === 'sendBytes') broadcast({ event: 'tmux.activity', name: String(args[0] ?? '') })
        return ok(request.id, { ok: true, result })
      } catch (error) {
        return fail(request.id, 'TMUX_FAILED', String(error?.message ?? error))
      }
    }
    case 'replay.start':
      return ok(request.id, await startReplay(request.params ?? {}))
    case 'replay.stop':
      return ok(request.id, { ok: true, ...(stopReplay(String(request.params?.name ?? ''), String(request.params?.why ?? 'stopped')) ?? {}) })
    case 'replay.marks': {
      const name = String(request.params?.name ?? '')
      const rec = replayRecorders.get(name)
      if (rec === undefined) return fail(request.id, 'NO_REPLAY', 'replay is not active')
      if (Array.isArray(request.params?.marks)) rec.marks = request.params.marks
      return ok(request.id, { ok: true, marks: rec.marks.length })
    }
    case 'replay.status':
      return ok(request.id, {
        ok: true,
        items: [...replayRecorders].map(([name, rec]) => ({ name, file: rec.file, startedAt: rec.startedAt, frames: rec.frames, bytes: rec.bytes })),
      })
    case 'shutdown':
      queueMicrotask(() => shutdown('rpc'))
      return ok(request.id, { stopping: true })
    default:
      return fail(request.id, 'UNKNOWN_METHOD', `unknown method: ${request.method}`)
  }
}

// 防护：单帧上限与并发连接上限（都可环境变量调整，便于测试）。恶意客户端可以
// 不换行地灌数据把 buffered 撑爆，或开大量连接耗尽 fd —— 两者都不需要 token 就能做。
const MAX_FRAME_BYTES = Math.max(256, Number(process.env.DSH_TERMINALKEEPER_SUPERVISOR_MAX_FRAME ?? 1024 * 1024) || 1024 * 1024)
const MAX_CONNECTIONS = Math.max(1, Number(process.env.DSH_TERMINALKEEPER_SUPERVISOR_MAX_CONNECTIONS ?? 64) || 64)

const server = createServer((socket) => {
  if (connections >= MAX_CONNECTIONS) { socket.destroy(); return }
  connections++
  clients.add(socket)
  if (idleTimer !== null) { clearTimeout(idleTimer); idleTimer = null }
  let buffered = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk) => {
    buffered += chunk
    if (buffered.length > MAX_FRAME_BYTES) {
      try { socket.write(encodeFrame(fail('oversized', 'FRAME_TOO_LARGE', `frame exceeds ${MAX_FRAME_BYTES} bytes`))) } catch { /* 忽略 */ }
      socket.destroy()
      return
    }
    const [frames, rest] = takeFrames(buffered)
    buffered = rest
    for (const frame of frames) {
      let request
      try {
        request = JSON.parse(frame)
      } catch {
        socket.write(encodeFrame(fail('invalid', 'BAD_JSON', 'frame is not valid JSON')))
        continue
      }
      const bad = validateRequest(request)
      if (bad !== '') {
        socket.write(encodeFrame(fail(request?.id ?? 'invalid', 'BAD_REQUEST', bad)))
        continue
      }
      void handle(request).then((response) => {
        if (!socket.destroyed) socket.write(encodeFrame(response))
      }).catch((error) => {
        if (!socket.destroyed) socket.write(encodeFrame(fail(request.id, 'INTERNAL', String(error?.message ?? error).slice(0, 400))))
      })
    }
  })
  socket.on('close', () => {
    clients.delete(socket)
    connections = Math.max(0, connections - 1)
    if (clients.size === 0) scheduleIdleExit()
  })
  socket.on('error', (error) => { log('socket error: ' + String(error?.message ?? error)) })
})

server.on('error', (error) => {
  if (error?.code === 'EADDRINUSE') {
    // 已有实例：让客户端连它；不要抢 socket。
    process.stderr.write('[supervisor] already running (socket in use)\n')
    process.exit(0)
  }
  process.stderr.write('[supervisor] listen failed: ' + String(error?.message ?? error) + '\n')
  process.exit(1)
})

function cleanup () {
  try { if (existsSync(paths.pid)) unlinkSync(paths.pid) } catch { /* 忽略 */ }
  try { if (existsSync(paths.socket)) unlinkSync(paths.socket) } catch { /* 忽略 */ }
}

function shutdown (reason) {
  for (const name of [...replayRecorders.keys()]) stopReplay(name, 'daemon shutdown')
  if (auditVerifyTimer !== null) { clearTimeout(auditVerifyTimer); auditVerifyTimer = null }
  if (parentTimer !== null) { clearInterval(parentTimer); parentTimer = null }
  if (idleTimer !== null) { clearTimeout(idleTimer); idleTimer = null }
  try { watchdogDriverInstance?.closeOwnerSocket?.() } catch { /* 忽略 */ }
  // 让已排队的 RPC 响应先写出，再断连接（shutdown 请求本身也要收到 ok）。
  setTimeout(() => {
    for (const socket of clients) { try { socket.destroy() } catch { /* 忽略 */ } }
    clients.clear()
  }, 50).unref()
  if (watchPumpTimer !== null) { clearInterval(watchPumpTimer); watchPumpTimer = null }
  try { if (watchDriver?.control !== null && typeof watchDriver?.control?.close === 'function') watchDriver.control.close() } catch { /* 忽略 */ }
  if (stopping) return
  stopping = true
  log('shutdown: ' + reason)
  try { server.close() } catch { /* 忽略 */ }
  cleanup()
  setTimeout(() => process.exit(0), 120).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

// 单实例：socket 存在且能连通 → 已有 supervisor，直接退出，绝不删它的 socket。
// 只有残留的不可连接 socket 才清理（否则会 split-brain）。
if (existsSync(paths.socket)) {
  if (await canConnect(paths.socket)) {
    process.stderr.write('[supervisor] already running (socket is alive)\n')
    process.exit(0)
  }
  try { unlinkSync(paths.socket) } catch { /* 忽略 */ }
}

server.listen(paths.socket, () => {
  try { chmodSync(paths.socket, 0o600) } catch { /* 非 POSIX 忽略 */ }
  writeFileSync(paths.pid, String(process.pid) + '\n', { mode: 0o600 })
  log(`listening on ${paths.socket} (tmux -L ${args.tmuxSocket})`)
  scheduleIdleExit()
  monitorParent()
  scheduleAuditVerify()
})

// 未捕获异常：清理 socket 后退出，让 watchdog/上层重启。
process.on('uncaughtException', (error) => {
  process.stderr.write('[supervisor] uncaught: ' + String(error?.stack ?? error) + '\n')
  cleanup()
  process.exit(1)
})