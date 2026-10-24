#!/usr/bin/env node
/**
 * 孤儿看门狗 —— 独立 Node 程序（C 流，替代"自生成 sh 巡逻脚本"）。
 *
 * 为什么换成 Node：
 *   · 程序化 setsid（`detached:true` + `unref`）= 全类 Unix 一致，消解整条 setsid 探测链；
 *   · 判定逻辑（双条件）可以导成纯函数单测 —— sh 版本没法测，只能靠真机炖；
 *   · 与插件的常量/纯函数同一份代码，没有"JS+sh 双实现"的漂移税。
 *
 * 通信 = **租约文件**（不开 socket）：
 *   `<socket>-watchdog.lease` 由 harness 每 ~8s 原子重写；本程序只读它。
 *   判定（双条件，防 Doze 冻结误杀）：
 *     · lease 过期（refreshedAt 距今 > graceMs）
 *     · ∧ （读不到 /proc 的情况直接相信租约；能读但进程还在 → 只是被冻结 → **不杀**）
 *   → 执行 kill-server（tmux -L <socket> kill-server，参数化、不拼字符串）+ 清 pid/lease → 自退。
 *
 * 收到 SIGTERM → 直接清 pid 文件自退（正常 dispose 路径）。
 *
 * 触发方式由 armWatchdog 用 `process.execPath` 重入、`detached:true` + `unref` spawn ——
 * 不依赖 `setsid` 二进制，Termux/macOS 同一路径。
 */

import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * 双条件判定（纯函数，可单测）：
 * lease 过期 且（读不到进程 → 收；进程还在 → 不收）。
 * @param {{lease: object, now: number, procReadable: boolean, graceMs: number, harness: string}} o
 * @param {function} [alive] 注入的存活判定（测试用；默认走 /proc）
 */
export function shouldReap({ lease, now, procReadable, graceMs, harness }, alive) {
  const refreshed = typeof lease?.refreshedAt === 'number' ? lease.refreshedAt : 0
  if (now - refreshed <= graceMs) return false          // 租约新鲜 → 不动手
  if (procReadable === false) return true               // 读不到 /proc → 只能相信租约（lease-only）
  const isAlive = typeof alive === 'function' ? alive(lease.harnessPid ?? harness) : procAlive(lease.harnessPid ?? harness)
  return !isAlive                                        // 进程还在 → 只是被冻结 → 不杀
}

/** 真实 /proc 存活判定：读得到 stat 即活（读不到 = 不活）。 */
export function procAlive(pid) {
  if (!/^[0-9]+$/.test(String(pid ?? ''))) return false
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8').length > 0
  } catch { return false }
}

/* ── CLI 入口 ─────────────────────────────────────────────────────────────── */

function main() {
  const argv = {}
  for (const raw of process.argv.slice(2)) {
    const eq = raw.indexOf('=')
    if (eq === -1) continue
    argv[raw.slice(2, eq)] = raw.slice(eq + 1)
  }
  const leasePath = argv.lease
  const pidFile = argv.pidfile
  const socket = argv.socket                    // tmux -L 的名称（不是路径）
  const harness = argv.harness ?? ''
  const graceMs = Math.max(1000, Number(argv.grace ?? '30000'))
  const intervalMs = Math.max(500, Number(argv.interval ?? '5000'))
  const procReadable = argv['proc-readable'] === '1'
  const tmuxBin = argv.tmux ?? 'tmux'

  // pid 文件两字段格式与旧 sh 看门狗一致：`<watchdogPid> <harnessPid>`（C4 契约不变）
  try { writeFileSync(pidFile, `${process.pid} ${harness}`) } catch { /* 写不了 pid 文件也要继续守望 */ }

  const reap = () => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      try { unlinkSync(pidFile) } catch { /* 可能已被删 */ }
      try { unlinkSync(leasePath) } catch { /* 可能已被删 */ }
      process.exit(0)
    }
    try {
      const child = spawn(tmuxBin, ['-L', socket, 'kill-server'], { stdio: 'ignore' })
      child.on('error', finish)
      child.on('close', finish)
      setTimeout(finish, 2000)   // 不能因为 kill-server 挂住而死等
    } catch { finish() }
  }

  const tick = () => {
    let lease = null
    try { lease = JSON.parse(readFileSync(leasePath, 'utf8')) } catch { lease = null }
    if (lease === null) return   // lease 缺失（还没写/正要写）→ 不判，下一轮再说
    // 动态策略：grace 与 procReadable 以**租约里的 policy 为准**（harness 重写 lease 即生效，
    // 无需重启 watchdog）；租约里没带才回退到启动参数。
    const leaseGrace = Number(lease?.policy?.graceMs)
    const effectiveGrace = Number.isFinite(leaseGrace) && leaseGrace > 0 ? leaseGrace : graceMs
    const effectiveProcReadable = typeof lease?.policy?.procReadable === 'boolean' ? lease.policy.procReadable : procReadable
    if (shouldReap({ lease, now: Date.now(), procReadable: effectiveProcReadable, graceMs: effectiveGrace, harness })) reap()
  }

  process.on('SIGTERM', () => {
    // 正常 dispose：清 pid 文件后退出；不着手杀服务端（那是新的 armWatchdog 的事）
    try { unlinkSync(pidFile) } catch { /* 已经没了 */ }
    process.exit(0)
  })

  tick()
  setInterval(tick, intervalMs)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}