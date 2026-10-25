/**
 * 环境能力探测与降级决议（0.2.2 / B 流）。
 *
 * 原则（来自设计公理）：**探测能力，不探测平台**。平台名会骗人（WSL 有无 systemd、Termux 的
 * process.platform 是 'linux' 还是 'android'、macOS 的变体……），而且枚举不完；能力信号
 * （有/无、支持/不支持）是穷的、可以直接查表。所以本文件只回答：tmux 能不能用、systemd 用户
 * 会话在不在、/proc 读不读得到 —— 然后把答案交给 {@link planFor} 决议成一张表。
 *
 * 刻意**不**探测：`setsid`（C 流用 `detached:true` 程序化等价，无需探测）、平台名、包管理器。
 *
 * 全部 IO 都可注入（`io`），因此可离线单测（scripts/test-env.mjs 用 mock 跑四种组合）。
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { parseTmuxVersion } from './pure.mjs'

const defaultExec = (cmd, args, timeoutMs = 4000) => new Promise((resolve) => {
  try {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      const code = error === null || error === undefined
        ? 0
        : (typeof error.code === 'number' ? error.code : 1)
      resolve({ code, out: String(stdout ?? ''), err: String(stderr ?? '') })
    })
  } catch (error) {
    resolve({ code: 1, out: '', err: String(error?.message ?? error) })
  }
})

/**
 * 一次真实探测。任何探测失败都向"能力少"保守降级（探测不到 = 当作没有）。
 *
 * @param {object} [io] 可注入的 IO 桩（测试用）：{ env, exists, read, exec, tmp, pid }
 */
export async function detectEnv(io = {}) {
  const env = io.env ?? process.env
  const exists = io.exists ?? existsSync
  const read = io.read ?? ((p) => readFile(p, 'utf8'))
  const exec = io.exec ?? defaultExec
  const tmp = io.tmp ?? tmpdir
  const pid = io.pid ?? String(process.ppid)

  const preset = io.tmux
  // `io.tmux = 'skip'`：调用方自己会用更可靠的路（driver 的 subprocess 探测）补上，这里
  // **不浪费一次 exec**（直连探测结果反正会被覆盖），结果保守置空，稍后由调用方补齐。
  const skipProbe = preset === 'skip'
  const probe = skipProbe ? { code: 1, out: '', err: '' } : await exec('tmux', ['-V'])
  const text = `${probe.out}${probe.err}`.trim()
  const okText = probe.code === 0 && /^tmux /i.test(text)
  // 宿主预置结果（io.tmux: { ok, version }）优先 —— 真实运行环境里 driver 的 tmux 探测走
  // subprocess 服务（可靠），本模块直连 execFile 在部分受限 harness 里会失败、误判"没有 tmux"
  // （实测：dsh web 沙箱里 tmux -V 直连失败，而 driver 探测正常）。直连结果只作兜底。
  const hasTmux = skipProbe
    ? false
    : (preset !== undefined && preset !== null
      ? preset.ok === true
      : okText)
  const tmuxVer = skipProbe
    ? null
    : (preset !== undefined && preset !== null
      ? (preset.ok === true ? parseTmuxVersion(preset.version) : null)
      : (okText ? parseTmuxVersion(text) : null))

  const commandExists = async (bin) => {
    const r = await exec('sh', ['-c', `command -v ${bin} >/dev/null 2>&1 && echo yes || echo no`])
    return r.out.trim() === 'yes'
  }

  // 0.3.3：`systemd-run` 在不在 PATH 是这台机器上几乎恒定的事实（装/卸 systemd 才会变），
  // 却是 detectEnv 里唯一一次子进程 spawn。宿主可预置结果（io.systemdRun）跳过探测；
  // 没有预置才真探一次，并把结论回吐（systemdRunPresent）供宿主缓存。
  // 注意：这只缓存「二进制在不在」；`/run/systemd/system` 与 XDG_RUNTIME_DIR 仍**每次实检**
  // （它们是 fs/env 直读、不 spawn，且更可能因环境变化而失真）。
  const systemdRunPresent = typeof io.systemdRun === 'boolean'
    ? io.systemdRun
    : await commandExists('systemd-run')
  const runtimeDir = typeof env.XDG_RUNTIME_DIR === 'string' ? env.XDG_RUNTIME_DIR : ''
  // 仅有 XDG_RUNTIME_DIR 不代表用户管理器还活着：会话总线（/run/user/<uid>/bus）才是
  // systemd-run --user 能连上的前提。总线消失时保守降级到 plain-detach，否则新建
  // tmux 服务端会直接失败。
  const hasUserBus = typeof io.hasUserBus === 'boolean'
    ? io.hasUserBus
    : (runtimeDir !== '' && exists(runtimeDir + '/bus'))
  const hasSystemdUser = systemdRunPresent &&
    exists('/run/systemd/system') &&
    runtimeDir !== '' && hasUserBus

  let procReadable = false
  try {
    await read(`/proc/${pid}/stat`)
    procReadable = true
  } catch { procReadable = false }

  return {
    hasTmux,
    tmuxVer,                       // [major, minor] | null
    hasSystemdUser,
    systemdRunPresent,             // 0.3.3：宿主据此写缓存（缓存这一项就能省掉本轮唯一 spawn）
    procReadable,
    tmpDir: tmp(),
    isTermux: String(env.PREFIX ?? '').includes('com.termux'),
  }
}

/** 能力 → 决议表。每项都是"用哪条路"，不是"什么平台"。 */
/**
 * 把一次探测的结论收口成**统一的能力快照**（2026-10-24）。
 *
 * 约定：新增一个探测项时，只在这里加字段；消费方（面板 / /diagnose / /status）一律读
 * 这份快照，不再各自拿 env/plan/tmux 的原始字段二次推断 —— 二次推断正是口径打架的根源。
 * **持续探测**（屏幕差分、订阅、会话列表）不走这里，它们本来就是流式的。
 *
 * @param {object} env  detectEnv 的结果
 * @param {object} tmux tmux 探针结果 { ok, version, extKeys }
 * @param {object} plan planFor 的决议
 */
export function buildCaps (env = {}, tmux = null, plan = {}) {
  return {
    tmux: {
      ok: tmux?.ok === true,
      version: String(tmux?.version ?? ''),
      extKeys: String(tmux?.extKeys ?? '—'),
    },
    serverLaunch: String(plan.serverLaunch ?? ''),
    systemdUser: plan.serverLaunch === 'systemd-scope',
    procReadable: plan.harnessPid === 'proc-chain',
    foregroundDrill: plan.foreground === 'drill',
    watchdog: String(plan.watchdog ?? ''),
    tmpDir: String(env.tmpDir ?? ''),
    isTermux: env.isTermux === true,
    at: Date.now(),
  }
}

export const planFor = (env) => ({
  // 有 systemd 用户会话 → 独立 scope（dsh 干净重启后会话存活）；否则普通 detach
  serverLaunch: env.hasSystemdUser ? 'systemd-scope' : 'plain-detach',
  // 看门狗由租约驱动的独立 Node 进程承担（C 流）；没有 tmux 就没有会话可守
  watchdog: env.hasTmux ? 'owner-socket' : 'off',
  // 能读 /proc 就爬进程链找 harness；否则只看自身（C 流里由 lease 兜底）
  harnessPid: env.procReadable ? 'proc-chain' : 'self-only',
  // extended-keys 需要 tmux ≥ 3.2（未知一律压制）
  extendedKeys: env.tmuxVer !== null && (env.tmuxVer[0] > 3 || (env.tmuxVer[0] === 3 && env.tmuxVer[1] >= 2)),
  // 前台判定：能读 /proc 就钻穿包装器；否则原值显示（嵌套 tmux 的忙闲判定退化）
  foreground: env.procReadable ? 'drill' : 'raw',
})

/**
 * 人话列表：每条降级都必须有一句**明确收缩的承诺**（供 /diagnose、面板 ⓘ 显示），
 * 而不是含糊的"可能受限"。
 */
export const describeEnv = (env, plan) => {
  const lines = []
  lines.push(plan.serverLaunch === 'systemd-scope'
    ? '服务器启动：系统级独立进程（systemd 用户作用域）—— 重启 dsh 后终端还在'
    : '服务器启动：普通后台进程（plain detach）—— 重启 dsh 后本插件的终端会结束')
  lines.push(plan.harnessPid === 'proc-chain'
    ? 'harness 定位：/proc 进程链'
    : 'harness 定位：self-only（读不到 /proc）—— 看门狗退化为租约单条件判定')
  lines.push(plan.foreground === 'drill'
    ? '前台判定：/proc 钻穿（嵌套 tmux 的忙闲判定准确）'
    : '前台判定：原值显示（读不到 /proc）—— 嵌套 tmux 下忙闲状态可能判不准')
  // 口径：这里只说**环境支不支持**，不说“有没有开”（那是配置项，最终生效状态由宿主另报）
  lines.push(plan.extendedKeys
    ? 'extended-keys：环境支持（tmux ≥ 3.2）'
    : `extended-keys：环境不支持（tmux ${env.tmuxVer === null ? '版本未知' : env.tmuxVer.join('.')} < 3.2）`)
  lines.push(plan.watchdog === 'off'
    ? '看门狗：关闭（没有 tmux）'
    : '看门狗：owner socket 探活的独立 Node 进程')
  if (env.isTermux) lines.push('检测到 Termux（$PREFIX 命中）—— 依赖安装走 pkg，不要求 root')
  return lines
}
