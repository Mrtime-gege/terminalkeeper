/**
 * terminalkeeper —— tmux 驱动
 *
 * 一个**私有** tmux 服务端（`-L <socket>`），上面挂多个命名会话，与用户自己的
 * tmux（默认 socket）完全隔离，互不干扰。
 *
 * 所有外部命令都经 `ctx.subprocess` 发出，因此沿用调用时的沙箱模式。受限模式下
 * 每次调用各自一个 bwrap、私有 PID 命名空间，tmux 服务端无法跨调用共享，所以这套
 * 能力需要 danger-full-access；`diagnose()` 会实测并报告这一点。
 *
 * 生命周期：`armWatchdog()` 布防一个**脱离进程树**的 Node 看门狗；它通过 owner socket
 * 探活，在 harness 消失且无人接管后杀掉本服务端 —— 覆盖 `kill -9` / 崩溃。
 */

import { readFile, unlink } from 'node:fs/promises'
import { writeFileSync, renameSync, readFileSync, unlinkSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isSafeSessionName, isSafeKeyName, parseTmuxVersion, isKnownTmuxKey, unescapeTmuxOutput, appendOutputRing, drainOutputRing } from './pure.mjs'
import { acquireOwnerServer, releaseOwnerServer, controlCall, readProcStart, runtimePaths, WATCHDOG_MAGIC, watchdogCompatible } from './watchdog-runtime.mjs'

/**
 * 会话目标的**白名单校验**（注入修复）：control 路径把命令拼成一行字符串插进 tmux，
 * 名字含 `;`/换行/引号/`$()` 会变成第二条命令执行（V-1/V-2 注入面，实测可直连）。
 * 因此任何要拼进 control 命令的目标名必须先过 `isSafeSessionName`；不合法直接抛错，
 * **绝不转义后放行**（tmux 转义反语义的坑太多，白名单收窄到插件 id 形状最可靠）。
 */
function safeTarget(name) {
  if (!isSafeSessionName(name)) {
    throw new Error(`unsafe session name: ${JSON.stringify(String(name ?? '').slice(0, 40))}`)
  }
  return name
}

/** list-panes 的字段分隔符。tab 不会出现在会话名或命令名里。 */

/**
 * 控制模式回复**归一化**：tmux 在格式参数带引号等情形下会把回复写成
 * `"....\t...."` 的转义形（外层引号 + 字面 `\t`），而解析方只认真实 tab ——
 * 不还原时字段解析会整体错位（嵌套 tmux 取证时实测到这类形态）。
 * 统一在这里还原：剥外层引号、`\t → TAB`、`\n → 换行`、`\\ → \`，其余原样。
 */
export function normalizeReply(raw) {
  let s = String(raw ?? '')
  const trimmed = s.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    s = trimmed.slice(1, -1)
  }
  if (s.includes('\\t') || s.includes('\\n') || s.includes('\\\\')) {
    s = s.replace(/\\t/g, '\t').replace(/\\n/g, '\n').replace(/\\\\/g, '\\')
  }
  return s
}
const SEP = '\t'

/**
 * 孤儿看门狗的存活判定窗口：每 {@link WATCHDOG_PROBE_SECONDS} 秒探一次 harness，
 * 连续 {@link WATCHDOG_MISS_LIMIT} 次探不到才判定它消失（6 × 10s = **60 秒**）。
 *
 * 为什么是 60 秒而不是 6 秒（旧旧值 3 × 2s）：这两个常量决定的是「重启 `dsh web` 时
 * 会不会把用户的 shell 全杀掉」。`systemctl restart` 期间存在一段**没有任何 dsh 进程**
 * 的真空期，脚本末尾那道 `pgrep -f "dsh web"` 守卫只能挡住"新宿主已经起来"的情形，
 * 挡不住"恰好落在真空期里"的那一次 —— 一旦落在里面，kill-server 就会连带清掉所有会话
 * （实测：面板里那个攒了 1832 行回滚缓冲的会话就是这么没的）。6 秒的窗口太窄，
 * 一次稍慢的重启就会踩中；60 秒足以覆盖冷启动。
 *
 * 为什么探头定为 10 秒（用户两次点名后的定稿）：看门狗是**长驻的 `sh` 循环**，
 * 每 2 秒探一次意味着每小时 1800 次 /proc+grep 唤醒；10 秒一次是 360 次（省 80%），
 * 判定粒度仍细（10 秒就感知一次 harness 状态，不比原方案的"探测频率"差一个数量级）。
 * 判定语义：连续 6 次（约 60 秒）失败视为消失；一次偶发的读取失败只 +1，不会误杀。
 * 代价是"真正死掉后的反应时间"最坏约 60 秒 —— 与总窗口一致，之前也如此。
 *
 * 代价（如实记下）：harness 被 `kill -9` 或崩溃之后，孤儿 tmux 服务端会**多活约 60 秒**
 * 才被收掉。这是"重启不误杀"与"孤儿尽快收"之间的取舍，选前者 —— 误杀丢的是用户数据，
 * 晚收 60 秒只多占一点内存。
 */
export const WATCHDOG_PROBE_SECONDS = 10
export const WATCHDOG_MISS_LIMIT = 6
/** 租约驱动的独立 Node 看门狗入口（C 流）：与本文件同目录，spawn 时用 process.execPath 重入。 */
export const WATCHDOG_MAIN = new URL('./watchdog.mjs', import.meta.url).pathname
/** 租约过期判定：正常（能读 /proc）30s；lease-only（读不到 /proc）放宽到 60s 防 Doze 误杀。 */

/** 每个被订阅会话的输出环上限（字符）。超出丢最早的 —— 并如实上报丢弃量。 */
export const OUTPUT_RING_CHARS = 524288

/**
 * 订阅用的输出环总线（按会话、有界、多消费者各自游标）。
 *
 * 数据来源**不是** tmux 控制模式的 `%output`：实测（2026-10-20）控制模式只推它自己那个
 * 隐式会话 pane 的输出，用户会话的输出根本收不到 ⇒ 改为宿主侧"抓屏差分"喂进来
 * （见 index.js 的 watch pump，复用 pure.diffSince）。这样跨 TUI/普通命令都成立。
 */
export class OutputRingBus {
  constructor (capChars = OUTPUT_RING_CHARS) {
    this.capChars = capChars
    this.rings = new Map()
    this.watched = new Set()
  }

  /** 登记订阅（幂等）。 */
  watch (name) {
    const key = String(name)
    this.watched.add(key)
    if (this.rings.has(key) === false) this.rings.set(key, { text: '', appended: 0, dropped: 0 })
    return true
  }

  /** 取消订阅并丢掉缓存（下次订阅不会"看起来像新输出"）。 */
  unwatch (name) {
    const key = String(name)
    this.watched.delete(key)
    this.rings.delete(key)
    return true
  }

  /** 喂一段新文本；未订阅的会话不存任何字节（零开销）。 */
  append (name, text) {
    const key = String(name)
    if (this.watched.has(key) === false) return false
    let chunk = String(text ?? '')
    if (chunk === '') return false
    const ring = this.rings.get(key)
    // ⚠ 抓屏差分每次给的是"若干整行"（末尾通常没有换行）；上一段如果也没以换行结尾，
    // 直接拼会把两段粘成一条超长行 ⇒ 行数被严重低估 ⇒ 噪音阈值（<3 行）永久推迟注入。
    // 这里补一个换行边界（只影响"追加"的边界，不改变段内内容）。
    if (ring !== undefined && String(ring.text ?? '') !== '' && String(ring.text).endsWith('\n') === false) {
      chunk = '\n' + chunk
    }
    this.rings.set(key, appendOutputRing(ring, chunk, this.capChars))
    return true
  }

  /** 按游标取增量（不触发任何 tmux 调用）。 */
  drain (name, cursor) {
    return drainOutputRing(this.rings.get(String(name)), cursor)
  }
}

/** list-panes 的格式串：一行一个会话（本插件每个会话只有一个 pane）。 */
const LIST_FORMAT = [
  '#{session_name}',
  '#{window_width}',
  '#{window_height}',
  '#{session_windows}',
  '#{session_attached}',
  '#{pane_current_command}',
  '#{pane_pid}',
  '#{history_size}',
  '#{history_limit}',
  '#{history_bytes}',
  '#{session_created}',
  // 光标（画插入点用）：tmux 自己就知道光标在哪，之前只是没取。
  // `cursor_flag` 为 0 表示程序把光标藏了 —— 那种情况下我们也不该画（不画终端不会画的东西）。
  '#{cursor_x}',
  '#{cursor_y}',
  '#{cursor_flag}',
  '#{pane_height}',
  // 0.3.0 态势快照：pane 的当前目录（tmux≥3.1 有；老版本这里给空串，调用方按缺失处理）
  '#{pane_current_path}',
  // 用户可见名（label）：显示用；可被改名，**不许**当寻址。会话名（session_name）
  // 才是稳定 id，永远不变 —— 改名只改这里，tmux 会话名不动（身份即寻址）。
  '#{@dsh-label}',
  // 0.3.3 (a)：remain-on-exit 打开后 pane 死亡时的状态与退出码（shell 本身 exit/崩溃；
  // 单条命令的退出码仍走 shell_run 的回显包装 —— 互补，见 pure#shouldWrapExit）。
  '#{pane_dead}',
  '#{pane_dead_status}',
  // 0.3.3 (b/c)：最后一次输出的时刻（epoch 秒）与 bell 旗标（3.6b 实测：flag 粘滞
  // 无法清除，只可信 0→1 沿变 + activity 时间戳做"新响"判定 —— 见 README/手册的边界）。
  '#{window_activity}',
  '#{window_bell_flag}',
  // pane id：控制模式的 %output 通知按 pane 寻址 —— 订阅功能靠它把字节流归到会话名。
  '#{pane_id}',
].join(SEP)

/** 一个 shell 会话在 UI 侧需要的全部标量。 */
function toSession(row) {
  const f = row.split(SEP)
  const num = (v) => {
    const n = Number.parseInt(v ?? '', 10)
    return Number.isFinite(n) ? n : 0
  }
  return {
    name: f[0] ?? '',
    cols: num(f[1]),
    rows: num(f[2]),
    windows: num(f[3]),
    attached: num(f[4]) > 0,
    foreground: f[5] ?? '',
    pid: num(f[6]),
    historySize: num(f[7]),
    historyLimit: num(f[8]),
    historyBytes: num(f[9]),
    createdAt: num(f[10]),
    // 光标在**可见窗格**里的单元格坐标（不是字符下标：中文占 2 格，映射交给客户端）
    cursorX: num(f[11]),
    cursorY: num(f[12]),
    cursorVisible: num(f[13]) !== 0,
    paneHeight: num(f[14]),
    cwd: String(f[15] ?? '').trim(),
    label: f[16] ?? '',
    // 0.3.3 (a/b/c)：追加字段（老服务端/未开选项时是 0/空串，语义=「无信息」而不是坏数据）
    dead: num(f[17]) > 0,
    // 实测：活着时 pane_dead_status 渲染为**空串**；死亡后渲染真退出码（'0' 是合法值=干净退出）。
    deadStatus: String(f[18] ?? '').trim() === '' ? null : num(f[18]),
    activityAt: num(f[19]) > 0 ? num(f[19]) * 1000 : 0,   // 最后一次输出的 epoch 毫秒（0=未知）
    bell: num(f[20]) > 0,                                  // 响过铃且未被"看过"清掉（见 index 侧沿变判定）
    paneId: String(f[21] ?? '').trim(),                    // %output 的寻址键（订阅用）
  }
}

/**
 * POSIX shell 单引号转义。
 *
 * 存在的理由很具体：本文件里有 6 处把**配置派生的值**（socket 名 → pid/conf 文件路径）
 * 拼进 `sh -c` 字符串，而 `socket` 来自用户配置 —— 拼不对就是命令注入。即使上层已经
 * 校验过，这里也必须再引一次（纵深防御；顺带修好带空格的路径）。
 */
export function shQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'"
}

/**
 * 把 socket 名收敛到安全字符集。
 *
 * socket 决定 `-L <name>`、`/tmp/<name>-tmux.conf`、`/tmp/<name>-watchdog.pid` —— 后两个会被
 * 拼进 shell 命令，所以它**不能**是任意字符串。非法字符直接剔除；全被剔除或过长时退回
 * 默认名 `terminalkeeper`（宁可换一个干净的服务端，也不要执行注入）。
 */
export function sanitizeSocketName(value) {
  const cleaned = String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '')
  if (cleaned === '' || /^\.+$/.test(cleaned)) return 'terminalkeeper'   // 纯点号（含 .. / ...）一律退回默认名
  return cleaned.slice(0, 64)
}

/**
 * 会把终端**交给子进程**的包装器。
 *
 * 为什么需要这张表：`sudo -i` 之后，tmux 的 `#{pane_current_command}` 报的是 **sudo**
 * 而不是那个 root shell —— Debian/Kali 默认开 `use_pty`，sudo 自己在中间转发 I/O，
 * 于是窗格的前台进程组始终是它。后果是"提示符就绪"的判定整段失效：整个 root 会话里
 * 每次 `shell_send` / `shell_read` 都被报成 `foreground: sudo - not the shell`，
 * 明明 root shell 早就在等输入了（实测确认）。只有钻穿这类包装器才看得到真正的 shell。
 *
 * ⚠ 刻意**不含** `ssh` / `wsl` / `docker exec` / `kubectl exec`：它们的子进程在别的
 * 机器或别的命名空间里，本地进程树中根本没有那个 shell —— 报成 `ssh` 才是如实的
 * （我们确实无法判定远端的提示符状态），钻进去反而会给出假的"就绪"。
 */
const FOREGROUND_WRAPPERS = new Set(['sudo', 'sudoedit', 'su', 'doas', 'pkexec', 'runuser', 'setpriv'])

/** 认作 shell 的命令名 —— 已经是 shell 就不必下钻，热路径上一次 /proc 都不读。 */
const SHELL_NAMES = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'ash', 'nu', 'elvish'])

/** 归一化命令名：登录 shell 在进程表里是 `-bash` 这种形态。 */
function baseCommandName(comm) {
  const raw = String(comm ?? '').trim()
  return raw.startsWith('-') ? raw.slice(1) : raw
}

/**
 * 前台命令名是否**就是 shell 本身**（不做下钻）。
 *
 * 这个判断决定了一件安全相关的事：屏幕上最后一个非空行能不能被当成"将要提交的命令"来扫。
 * 前台是 shell 时能（那就是 readline 的输入行）；前台是密码提示、TUI、REPL 时**不能** ——
 * 那种场景下输入不回显，最后一行是程序的提示语，扫它只会产生误报（实测：`[sudo] password
 * for <用户>:` 被提权规则匹配上，导致"输入密码"这个动作被守卫拒绝）。
 */
export function isShellForeground(command) {
  return SHELL_NAMES.has(baseCommandName(command))
}

/**
 * 从 pane 的前台进程往下钻，返回**真正持有终端**的那个命令名。**纯函数**（进程表由调用方读好传进来）。
 *
 * 规则分两步：
 *   1. 在 `panePid` 的后代里找与 `paneCommand` 同名的节点；有多个就取**最深**的那个
 *      （离终端最近）。找不到就用 `panePid` 本身（进程可能刚好退出）。
 *   2. 从该节点沿**独子**链往下走：只要当前节点是包装器就继续钻，遇到第一个非包装器就返回它。
 *
 * 为什么第 2 步只走独子链：包装器有多个子进程时（例如 `sudo bash -c 'a | b'`），
 * "谁持有终端"并不确定 —— 这时保守地退回 `paneCommand`（等于改动前的行为），不猜。
 *
 * @param {string} paneCommand - tmux 报的 `#{pane_current_command}`
 * @param {string} panePid - tmux 报的 `#{pane_pid}`（pane 里最初那个 shell 的 pid）
 * @param {Map<string,{comm:string,children:string[]}>|null} procs - 进程表；空/缺失表示读不到
 * @returns {string} 钻不出结果时原样返回 `paneCommand` —— **退化到改动前的行为，不会更糟**
 */
export function drillForeground(paneCommand, panePid, procs) {
  const fallback = String(paneCommand ?? '').trim()
  if (fallback === '') return ''
  if (procs === null || procs === undefined || typeof procs.get !== 'function' || procs.size === 0) return fallback
  const root = String(panePid ?? '')
  if (!procs.has(root)) return fallback
  const kidsOf = (pid) => {
    const kids = procs.get(pid)?.children
    return Array.isArray(kids) ? kids.filter((k) => procs.has(k)) : []
  }
  const nameOf = (pid) => baseCommandName(procs.get(pid)?.comm)

  // 1) 找同名后代，多个取最深（BFS 保证深度可比，seen 保证进程表里有环也不会转不出来）
  let start = ''
  let startDepth = -1
  const queue = [[root, 0]]
  const seen = new Set([root])
  while (queue.length > 0) {
    const [pid, depth] = queue.shift()
    if (nameOf(pid) === baseCommandName(fallback) && depth > startDepth) { start = pid; startDepth = depth }
    for (const child of kidsOf(pid)) {
      if (seen.has(child)) continue
      seen.add(child)
      queue.push([child, depth + 1])
    }
  }
  if (start === '') start = root

  // 2) 沿独子链钻穿包装器
  let current = start
  for (let hop = 0; hop < 8; hop += 1) {
    if (!FOREGROUND_WRAPPERS.has(nameOf(current))) {
      const comm = String(procs.get(current)?.comm ?? '').trim()
      return comm === '' ? fallback : comm
    }
    const kids = kidsOf(current)
    if (kids.length !== 1) return fallback   // 无子或多子：不确定，保守停住
    current = kids[0]
  }
  return fallback
}

/**
 * 读 `rootPid` 的**后代**进程表：走 `/proc`，不 spawn 任何进程。
 *
 * 为什么不用 `ps`：`foregroundOf()` 在每次 `shell_send` / `shell_read` 都会被调用，
 * 而经 DSH subprocess 服务起一个进程实测约 60–70ms（裸调 tmux 只要 4.5ms）——
 * 用 `ps` 等于给每个工具调用再加一拍。读 `/proc` 是进程内文件读，整棵子树通常 2–5 个文件。
 *
 * 用 `/proc/<pid>/task/<pid>/children` 直接拿子进程，避免"扫全表再筛父子关系"
 * （机器上进程多时那是几百次读）。非 Linux（没有 `/proc`）或读失败时返回空 Map，
 * 由 `drillForeground` 退化成原样返回 —— 不会比改动前更糟。
 *
 * @param {string} rootPid - pane 的初始 shell pid
 * @param {number} [limit=24] - 最多收集多少个进程（防止异常进程树把读取放大）
 * @returns {Promise<Map<string,{comm:string,children:string[]}>>}
 */
export async function readDescendantProcs(rootPid, limit = 24) {
  const procs = new Map()
  const root = String(rootPid ?? '').trim()
  if (!/^[0-9]+$/.test(root)) return procs
  const queue = [root]
  const seen = new Set([root])
  while (queue.length > 0 && procs.size < limit) {
    const pid = queue.shift()
    let comm = ''
    try {
      comm = (await readFile(`/proc/${pid}/comm`, 'utf8')).trim()
    } catch {
      continue   // 进程刚好退出：跳过它，但它的兄弟/父链仍然照走
    }
    let children = []
    try {
      children = (await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8'))
        .trim().split(/\s+/).filter((x) => /^[0-9]+$/.test(x))
    } catch {
      children = []   // 内核没开 CONFIG_PROC_CHILDREN：拿不到子进程就到此为止
    }
    procs.set(pid, { comm, children })
    for (const child of children) {
      if (seen.has(child)) continue
      seen.add(child)
      queue.push(child)
    }
  }
  return procs
}

/**
 * 把一段文本包成 tmux 命令行里的双引号参数。
 *
 * 实测（tmux 3.6b）语义：双引号内空格与 `#` 原样保留；`\\` → `\`、`\"` → `"`、
 * `\$` → `$`（tmux 命令行**不是** shell，`$` 不发生展开，转义只是为了保险）。
 */
function tmuxQuote(value) {
  return '"' + String(value).replace(/[\\"$]/g, (ch) => '\\' + ch) + '"'
}

/**
 * tmux control-mode 长驻客户端 —— "复用同一个进程"的答案。
 *
 * 背景：插件每个操作（读屏、发键、列会话…）都经 subprocess 服务**新 spawn 一个** `tmux`
 * 客户端，实测每次有 ~100ms 固定开销（systemd-run 建 scope + systemctl 确认 + 收尾），
 * 而裸 `tmux capture-pane` 只要 4.5ms。合并调用（captureWithMeta）只省掉追加的 spawn，
 * 大头仍在 —— 合并后 /screen 实测仍 ~140ms。
 *
 * control mode（`tmux -C`）把一个"客户端"变成**一个长驻进程**：命令写在它的 stdin 上、
 * 回复在 stdout 上按 `%begin/%end` 分帧，窗格输出以 `%output` 通知即时到达。每个操作从
 * "spawn 一个进程 ≈100ms" 变成 "往管道写一行 ≈1ms"。它照样是 subprocess 服务管理的
 * scope 子进程：dispose/超时/资源上限一条不丢；tmux 服务端没了，它会收到 `%exit`
 * 自己退出，上层据此重生。
 *
 * ⚠ 用 `tmux -C` 而**不是** `-C attach`：实测 `attach` 会把 `session_attached` 置 1，
 * 污染面板的"有人接入"；不带 attach 一样能收 `%output`、能对任意会话发命令。
 */
/** 控制模式客户端。导出供测试直接驱动 SSoutput 解析（不需要真 tmux）。 */
export class ControlClient {
  constructor(driver) {
    this.driver = driver
    this.handle = null
    this.chunks = ''
    this.frame = null
    this.queue = Promise.resolve()
    this.waiters = []
    this.alive = true
    this.outputListeners = new Set()
    this.primePending = false        // 接入噪声屏障状态（见 acquire 的注释）
    this.primeResolve = null
    this.primeTimer = null
  }

  get ready() { return this.alive && this.handle !== null }

  /** 起一个长驻 `tmux -C` 客户端；失败或已停用时返回 false（调用方回退一次性路径）。 */
  async acquire() {
    if (this.ready) return true
    if (!this.alive) return false
    try {
      // 用 `tmux -C`（**不带 attach**）：tmux 会给客户端自建一个纯数字名的默认会话
      // （"1"、"2"…，每次连接多一个），那是它的"当前会话"。
      // 两个实测约束决定设计：
      //   · 那个幻影**不能杀** —— 杀了客户端会连它一起退出（%exit），此后 %output
      //     中继归零（它唯一 的会话没了）；
      //   · **不能 attach** 到别的会话 —— 控制模式只给"attach 的窗格"发 %output，
      //     实测 attach 到隐藏会话后，其它窗格的输出就收不到了（最早那条"5 条
      //     %output"的验证是错的——那 5 条来自隐藏会话自己）。
      // 所以：无 attach、幻影留着但**永远不出现在用户列表**（sessionsFromRaw 过滤
      // 纯数字名），真实会话的 session_attached 保持 0（客户端没有 attach 它们）。
      // 幻影每次重连会 +1，可接受（重连场景极少，且随服务端销毁一起消失）。
      this.handle = this.driver.subprocess.spawn({
        // 幽灵根治（方案 A）：给 control 客户端**带上目标会话**，让 tmux 不必自建纯数字默认会话。
        // 用 new-session -A -s <隐藏名>：已存在则复用、不存在才创建 —— 于是**重连不再累积**，
        // 数字幻影从产生源消失（此前每次重连 +1，一天能攒 40+ 个）。
        // 安全性：客户端仍然只 attached 到一个非用户会话，与「attached 到幻影」形态等价；
        // 该名字早已在 sessionsFromRaw 里被排除（见其注释），不会出现在用户列表，也不计入上限。
        argv: ['tmux', '-L', this.driver.socket, '-f', this.driver.confFile, '-C',
          'new-session', '-A', '-s', this.driver.hiddenSessionName()],
        cwd: this.driver.cwd,
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 65536 } },
        graceMs: 5000,
      })
      const handle = this.handle
      if (handle.stdin === undefined || handle.stdout === undefined) {
        this.teardown('missing pipes')
        return false
      }
      handle.stdin.on('error', () => { /* EPIPE：服务端消失时是预期的 */ })
      handle.stdout.setEncoding('utf8')
      handle.stdout.on('data', (chunk) => this.feed(String(chunk)))
      handle.done.then(() => this.teardown('exit'), () => this.teardown('provider-failure'))
      // 接入噪声屏障：tmux 在控制客户端连上时会先发一组**无输出**的 %begin/%end
      // （外加 %window-add / %session-changed 等通知）。若那个 %end 配上了第一条命令的
      // waiter，首条响应就会被偷走 —— 实测首条命令拿到空 payload（表现为起始时序错位）。
      // 这里等"无 waiter 的 %end"（即接入噪声收完）再放行，2 秒收不到也放行（老 tmux）。
      this.primePending = true
      const primed = new Promise((resolve) => { this.primeResolve = resolve })
      this.primeTimer = setTimeout(() => { if (this.primePending) { this.primePending = false; this.primeResolve?.() } }, 2000)
      await primed
      clearTimeout(this.primeTimer)
      return true
    } catch {
      this.teardown('spawn-error')
      return false
    }
  }

  /**
   * 执行一条 tmux 命令，取回 `%begin/%end` 帧里的输出。
   *
   * 命令**串行化**（一次只发一条）：回复就是下一条完整的 begin/end 对。`%output` 之类
   * 的通知不带 begin/end，不会参与配对。超时（默认 4s）视为控制客户端卡死：
   * 终止并按失败收场，调用方回退一次性路径，下一次操作重新 spawn。
   */
  command(text, options = {}) {
    const timeoutMs = options.timeoutMs ?? 4000
    const task = async () => {
      if (!(await this.acquire())) throw new Error('control mode unavailable')
      // ⚠ 必须 return：async 函数里光 `await` 是语句，不 return 就永远返回 undefined
      // （实测首条命令一直拿到空 payload，正是漏了这个 return）。
      return await new Promise((resolve, reject) => {
          const waiter = { resolve, reject, timer: null }
        waiter.timer = setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter)
          try { this.handle?.terminate() } catch { /* 忽略 */ }
          this.teardown('command-timeout')
          reject(new Error(`control command timed out: ${String(text).slice(0, 60)}`))
        }, timeoutMs)
        this.waiters.push(waiter)
        try {
          this.handle.stdin.write(text + '\n')
        } catch (error) {
          clearTimeout(waiter.timer)
          this.waiters = this.waiters.filter((w) => w !== waiter)
          this.teardown('stdin-error')
          reject(error)
        }
      })
    }
    const next = this.queue.then(task, task)
    this.queue = next.then(() => undefined, () => undefined)
    return next
  }

  /** 订阅 `%output` 通知（返回取消函数）。测试与"订阅通知"都用它。 */
  onOutput(listener) {
    this.outputListeners.add(listener)
    return () => this.outputListeners.delete(listener)
  }

  feed(text) {
    this.chunks += text
    let at = this.chunks.indexOf('\n')
    while (at >= 0) {
      const line = this.chunks.slice(0, at).replace(/\r$/, '')
      this.chunks = this.chunks.slice(at + 1)
      this.handleLine(line)
      at = this.chunks.indexOf('\n')
    }
  }

  handleLine(line) {
    // %output 必须**无条件先处理**：`send-keys Enter` 的帧还没关、命令输出就先以 %output
    // 到达（Enter 执行产生的输出与帧的 %end 是竞态的）。若先检查 frame，这类输出会被吞进
    // 命令帧 —— 实测表现为监听者收不到任何变更通知（面板的推送信号失效）。
    // %output 是通知行，前缀 `%output ` 足够区分；命令输出以该字样开头几乎不可能。
    if (line.startsWith('%output ')) {
      for (const listener of this.outputListeners) {
        try { listener(line) } catch { /* 订阅者的错误不拖垮解析 */ }
      }
      return
    }
    if (line.startsWith('%begin')) { this.frame = []; return }
    if (line.startsWith('%error')) {
      // tmux 命令失败：`%begin` 之后的说明行 + `%error`（**没有** %end，如
      // `has-session -t 不存在` → "can't find session: x" + %error）。
      // 不等超时：立刻把错误交给当前 waiter —— 调用方据此区分"预期失败"（会话
      // 不存在 = has() 的 false）与"客户端故障"（才退避重连）。
      const payload = (this.frame ?? []).join('\n').trim()
      this.frame = null
      if (this.primePending) {
        this.primePending = false
        this.primeResolve?.()
        return
      }
      const waiter = this.waiters.shift()
      if (waiter === undefined) return
      clearTimeout(waiter.timer)
      waiter.reject(new Error(payload || 'tmux command errored'))
      return
    }
    if (line.startsWith('%end')) {
      const payload = (this.frame ?? []).join('\n')
      this.frame = null
      // 接入噪声（无 waiter 的 begin/end 对）：作为屏障信号消化掉，不配给任何命令
      if (this.primePending) {
        this.primePending = false
        this.primeResolve?.()
        return
      }
      const waiter = this.waiters.shift()
      if (waiter === undefined) return
      clearTimeout(waiter.timer)
      waiter.resolve(payload)
      if (process.env.DDEBUG === '1') {
        console.error('[dsh-ctl] %end payload:', JSON.stringify(payload.slice(0, 300)))
      }
      return
    }
    if (this.frame !== null) { this.frame.push(line); return }
    // 其它通知（%session-changed / %window-* / %exit / %error…）当前不关心
  }

  teardown(reason) {
    // 屏障若还挂着，立刻放行，别让 acquire 的 await 悬到 2 秒超时
    if (this.primePending) { this.primePending = false; this.primeResolve?.() }
    if (this.primeTimer !== null) { clearTimeout(this.primeTimer); this.primeTimer = null }
    this.handle = null
    this.chunks = ''
    this.frame = null
    const waiters = this.waiters
    this.waiters = []
    for (const waiter of waiters) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error(`control mode ended: ${reason}`))
    }
  }

  stop() {
    this.alive = false
    try { this.handle?.terminate() } catch { /* 忽略 */ }
    this.teardown('stopped')
  }
}

export class TmuxDriver {
  /**
   * @param {object} options - subprocess/timer 服务与本插件的配置。
   */
  constructor(options) {
    this.subprocess = options.subprocess
    this.timer = options.timer
    // socket 决定 conf/pid 文件路径，而那两个会被拼进 shell 命令 —— 在这里一次性收敛，
    // 后续派生值（confFile / 运行时 socket）自然安全。被改写过时记下原值，由上层如实提示用户。
    this.socket = sanitizeSocketName(options.socket)
    this.socketRewrittenFrom = String(options.socket ?? '') !== this.socket ? String(options.socket ?? '') : ''
    this.historyLimit = options.historyLimit
    this.shell = options.shell
    this.cwd = options.cwd
    // 用 os.tmpdir() 而不是硬编码 /tmp：Android/Termux 没有 /tmp（macOS 上 /tmp 只是 /private/tmp
    // 的软链，也走 TMPDIR 更正确）。这是正确性修复，Linux 上 os.tmpdir() 默认就是 /tmp，行为不变。
    this.confFile = join(tmpdir(), `${this.socket}-tmux.conf`)
    this.defaultTerminal = options.defaultTerminal ?? 'tmux-256color'
    /** 是否在服务端配置里加 `extended-keys on`（需要 tmux ≥ 3.2，默认关，见 index.js 的注释）。 */
    this.extendedKeys = options.extendedKeys === true
    /** 0.3.3 (a)：`remain-on-exit on` —— shell 退出后 pane 保留（死亡态+退出码可读、屏面定格）。
     *  ⚠ 显式 opt-in：只有插件 apply() 按配置传入；独立构造的 driver（kit/ctl 测试）不默认开启，
     *  否则死 pane 残留会改变"会话计数/前台判定"等一整套既有语义。 */
    this.remainOnExit = options.remainOnExit === true
    /** 0.3.3 (b)：`monitor-bell on` —— 让 tmux 记 window_bell_flag（轮询侧可见）。同上显式 opt-in。 */
    this.monitorBell = options.monitorBell === true
    /** 探测到的 tmux 版本 [major, minor]（probeTmux 填充；用于 extendedKeys 的 ≥3.2 压制）。 */
    this.ver = null
    /** 服务端启动路径（env.mjs 的 plan）：'systemd-scope'（默认，重启存活）| 'plain-detach'（能力降级）。 */
    this.serverLaunch = options.serverLaunch === 'plain-detach' ? 'plain-detach' : 'systemd-scope'
    /** 前台判定策略：'drill'（读 /proc 钻穿，默认）| 'raw'（读不到 /proc，原值显示）。 */
    this.foregroundStrategy = options.foregroundStrategy === 'raw' ? 'raw' : 'drill'
    /** 会话启动参数（追加在 shell 之后，如 --norc）：只影响新会话。 */
    this.shellArgs = Array.isArray(options.shellArgs) ? options.shellArgs : []
    /** 会话额外环境变量（"K=V" 数组）：注入到干净环境里，只影响新会话。 */
    this.sessionEnv = Array.isArray(options.sessionEnv) ? options.sessionEnv : []
    /** 看门狗实现：'owner-socket'（默认，owner socket 探活）| 'sh-lowmem'（已废弃，映射为 owner-socket）。 */
    this.watchdogStrategy = 'owner-socket'
    /** 本机能否读 /proc/harnessPid（决定是否能用 PID/starttime 做第二重身份校验）。 */
    this.watchdogProcReadable = options.watchdogProcReadable !== false
    /** 显式指定被监视的 harness pid（supervisor 模式：daemon 自身 cmdline 含 dsh，不能自认）。 */
    this.harnessPidOverride = typeof options.harnessPid === 'string' && /^[0-9]+$/.test(options.harnessPid) ? options.harnessPid : ''
    /** 看门狗轮询间隔（测试可拨小；默认 5s）。 */
    this.watchdogIntervalMs = options.watchdogIntervalMs ?? 5000
    /** 孤儿判定窗口（ms）：socket 连续不可用且 harness 身份消失超过这么久才收尸。默认 5 分钟。 */
    this.watchdogGraceMs = Number.isFinite(options.watchdogGraceMs) ? Math.max(2000, Math.floor(options.watchdogGraceMs)) : 300000
    /** 运行时目录：只放 owner/control socket，不落盘状态。 */
    this.runtimeDir = options.runtimeDir ?? join(tmpdir(), 'terminalkeeper-run', this.socket)
    this.ownerSocket = runtimePaths(this.runtimeDir, this.socket).owner
    this.controlSocket = runtimePaths(this.runtimeDir, this.socket).control
    this.ownerServer = null
    /** control-mode 长驻客户端（懒加载，见 controlClient/controlUsable/markControlDown）。 */
    this.control = null
    /** 0.3.3 #1：活动总线订阅者（Set<name=>void>）；见 onActivity/noteActivity。 */
    this.activityListeners = new Set()
    /** 订阅输出总线（宿主侧抓屏差分喂入；见 OutputRingBus 注释）。 */
    this.outputBus = new OutputRingBus(Number.isFinite(options.outputRingChars) ? options.outputRingChars : OUTPUT_RING_CHARS)
    this.controlRetryAfter = 0
    /** 0.3.0 指数退避：连续失败计数（5s→10s→20s→40s→60s 封顶），任一成功即清零。 */
    this.controlFailStreak = 0
    /** 服务端确认存在过（一次 create / list 成功即置位）—— 防止 `tmux -C` 自己把服务端拉起来。 */
    this.serverConfirmed = false
  }

  /** control 客户端 attach 用的隐藏会话名。它在用户列表里永远不可见（见 sessionsFromRaw）。 */
  hiddenSessionName() {
    return 'dsh-ctl-' + this.socket
  }

  /**
   * 插件 fiber 退场：停控制客户端、清活动监听与输出环。
   * **不杀 tmux 服务端/会话**——这些属于监督域，重载后要保留。
   */
  dispose () {
    try { this.control?.stop() } catch { /* 忽略 */ }
    this.control = null
    this.activityListeners.clear()
    try { this.outputBus.watched.clear() } catch { /* 忽略 */ }
    try { this.outputBus.rings.clear() } catch { /* 忽略 */ }
  }

  /** 懒加载 control 客户端（一个驱动一个，最长驻一次）。 */
  controlClient() {
    if (this.control === null) this.control = new ControlClient(this)
    return this.control
  }

  /** control 路径可用的前提：服务端已确认存在，且不在退避期内（失败后指数退避，见 markControlDown）。 */
  controlUsable() {
    if (!this.serverConfirmed) return false
    if (Date.now() < this.controlRetryAfter) return false
    this.controlClient()   // 懒创建：第一次需要时再建（另一个客户端最多驻留一个）
    return true
  }

  /**
   * 记录一次 control 失败：收掉当前客户端 + **指数退避**（0.3.0）。
   * 旧版一刀切停用 60 秒 —— 一次瞬时抖动（服务端重启、管道忙）就把快路径掐一分钟，
   * 面板手感断崖；现在 5s 起步、翻倍、60s 封顶，任何一次成功立即清零。
   */
  markControlDown() {
    this.controlFailStreak += 1
    const backoff = Math.min(60000, 5000 * 2 ** (this.controlFailStreak - 1))
    this.controlRetryAfter = Date.now() + backoff
    this.control?.teardown('mark-down')
    // ⚠ 0.3.3 收尾实测修复：teardown 后**必须置空** —— 否则退避期结束 controlUsable()
    // 重新放行时，复用的是一个 handle 已死的旧客户端（acquire 拿到 null handle，
    // command() 抛 TypeError → 每次都掉进 CLI 回退；longrun vim 全周期断言因此
    // 偶发红：cat 走了降级路径，-S -N 锚点回到脆弱形态）。置空后下一次用才重建。
    this.control = null
  }

  /** control 调用成功：清零退避状态（下一次偶发失败重新从 5 秒起步）。 */
  noteControlOk() {
    if (this.controlFailStreak === 0) return
    this.controlFailStreak = 0
    this.controlRetryAfter = 0
  }

  /**
   * 0.3.3 #1：驱动内活动总线 —— 对某会话的**输入**动作（send/paste）每发生一次就发一帧。
   * SSE 流靠它做即时推送（按键跟手）；纯进程内回调表，无定时器无 IO，订阅者错误不拖垮操作。
   */
  onActivity(cb) {
    this.activityListeners.add(cb)
    return () => { this.activityListeners.delete(cb) }
  }

  /** supervisor 广播的输入活动：通知本实例注册的 onActivity 监听者。 */
  notifyActivity(name) {
    for (const cb of [...this.activityListeners]) {
      try { cb(String(name)) } catch { /* 忽略 */ }
    }
  }

  noteActivity(name) {
    if (this.activityListeners.size === 0) return
    for (const cb of [...this.activityListeners]) {
      try { cb(String(name ?? '')) } catch { /* 订阅者的错误不拖垮发送 */ }
    }
  }

  /** list-panes 裸输出 → 会话数组 + 前台命令统一钻穿包装器（两个路径共用）。 */
  async sessionsFromRaw(raw) {
    const sessions = raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map(toSession)
      // 两类会话必须从列表消失：① tmux 给**无目标**的 control 客户端自建的纯数字默认会话
      // （"1"、"2"…，实测每次连接 +1；它们**不能删** —— 删了客户端会连它一起退出，
      // %output 中继随之归零，见 ControlClient.acquire 的注释）；② 防御性地排除
      // `dsh-ctl-<socket>` 前缀（早期设计给客户端专用隐藏会话时留下的，现在不会创建，
      // 留着只是不让这个前缀的名字透出来）。插件自己的用户会话一律带 dsh- 前缀但**不是**
      // dsh-ctl-，不受影响。缺了这层过滤，openShell 的 maxSessions 判定会恒多 1
      // （实测踩过：2 个 shell 就被上限拦下）。
      .filter((session) =>
        !/^[0-9]+$/.test(session.name) && session.name !== this.hiddenSessionName())
    // 前台命令名统一**钻穿包装器**后再交出去：`sudo -i` 里 tmux 报的是 sudo，而所有消费方
    // （面板的忙碌判定、shell_list 的 fg=、守卫"能不能扫屏"的前提）要的都是"真正持有终端的
    // 那个进程"。在这一处做，消费方才不会各说各话。已经是 shell 时直接返回，不读 /proc。
    // 并发解析：每次 resolveForeground 都要钻 /proc（嵌套 tmux 时要多层），
    // 会话一多（实测 20+）串行就是面板每次轮询的最大开销。有上限并发，顺序无关。
    {
      const conc = Math.max(1, Math.min(16, sessions.length))
      let cursor = 0
      const worker = async () => {
        for (;;) {
          const i = cursor
          cursor += 1
          if (i >= sessions.length) return
          try {
            sessions[i].foreground = await this.resolveForeground(sessions[i].foreground, sessions[i].pid)
          } catch { /* 单个会话解析失败不拖垮列表 */ }
        }
      }
      await Promise.all(Array.from({ length: conc }, () => worker()))
    }
    return sessions
  }

  /** 跑一条命令并收回完整输出。 */
  async run(argv, options = {}) {
    const handle = this.subprocess.spawn({
      argv,
      cwd: options.cwd ?? this.cwd,
      stdio: {
        stdin: options.stdin ?? 'ignore',
        stdout: { maxBytes: options.cap ?? 4 * 1024 * 1024 },
        stderr: { maxBytes: options.cap ?? 1024 * 1024 },
      },
      graceMs: options.graceMs ?? 15000,
    })
    const outcome = await handle.done
    const out = handle.collected.stdout === undefined ? '' : handle.collected.stdout.readFrom(0).text
    const err = handle.collected.stderr === undefined ? '' : handle.collected.stderr.readFrom(0).text
    return { code: outcome.exitCode, out, err }
  }

  /**
   * 所有 tmux 调用的公共前缀。
   *
   * 同时带上 `-L <socket>`（私有服务端）与 `-f <conf>`。`-f` **必须**出现在每条
   * 命令上：服务端是被第一条命令启动的，而启动期才会读这个配置文件 —— 只有把
   * `history-limit` 放进这里，新建窗口才会采用它（实测：事后 `set-option -w` 改不动
   * 已存在窗格的上限，仍是 2000）。
   */
  tmuxArgv(args) {
    return ['tmux', '-L', this.socket, '-f', this.confFile, ...args]
  }

  /** 带公共前缀的 tmux 调用；非零退出抛错。 */
  async tmux(args, options) {
    const result = await this.run(this.tmuxArgv(args), options)
    if (result.code !== 0) {
      const detail = (result.err || result.out || '').trim()
      throw new Error(`tmux ${args[0]} failed: ${detail}`)
    }
    return result.out
  }

  /**
   * 开工前的体检：tmux 在不在、版本多少。
   *
   * tmux 是**系统依赖**，不在 package.json 里，包管理器一句话都不会说。装了插件却没有 tmux 的
   * 机器（Windows 原生、精简容器、刚装好的 Mac）会一路"装成功"，然后在第一次开会话时抛一个
   * 谁也看不懂的 spawn 错误。所以这里探一次，把结论如实交给上层去显示 —— 开箱即用首先要能
   * **说清缺什么**。
   *
   * @returns {Promise<{ok: boolean, version: string, error: string}>}
   */
  async probeTmux() {
    try {
      const result = await this.run(['tmux', '-V'], { cap: 1024, graceMs: 10000 })
      const text = `${result.out}${result.err}`.trim()
      if (result.code === 0 && /^tmux /i.test(text)) {
        // 版本号决定若干行为（extended-keys 需要 ≥3.2；更老的版本用法也可能不同）
        const ver = parseTmuxVersion(text)
        this.ver = ver
        return { ok: true, version: text, major: ver?.[0] ?? null, minor: ver?.[1] ?? null, error: '' }
      }
      this.ver = null
      return { ok: false, version: '', major: null, minor: null, error: text === '' ? `exit code ${String(result.code)}` : text.slice(0, 200) }
    } catch (error) {
      // ENOENT 会以异常形式出现（可执行文件不存在时 spawn 直接失败）
      this.ver = null
      return { ok: false, version: '', major: null, minor: null, error: String(error?.message ?? error).slice(0, 200) }
    }
  }

  /** extended-keys 需要 tmux ≥3.2：低于（或版本未知）自动压制 —— 避免"一开服务端起不来"。 */
  useExtendedKeys() {
    if (this.extendedKeys !== true) return false
    if (this.ver === null) return false
    return this.ver[0] > 3 || (this.ver[0] === 3 && this.ver[1] >= 2)
  }

  /** 同 `tmux()`，但不因非零退出抛错 —— 用于探测。 */
  probe(args, options) {
    return this.run(this.tmuxArgv(args), options)
  }

  /** 等待若干毫秒（计时器服务缺失时退化为立即返回）。 */
  async pause(ms) {
    if (this.timer === undefined || ms <= 0) return
    await this.timer.timeout(ms)
  }

  // ── 服务端选项 ─────────────────────────────────────────────────────────────

  /**
   * 写服务端启动期配置文件。
   *
   * 这些选项在**服务端启动时**生效，因此必须放进 `-f` 读到的文件里，而不是事后
   * `set-option -g`（那时服务端还没起来，`set-option` 会失败 —— 实测踩过，
   * 结果是会话上限停在默认 2000）。
   *
   * 注意 `window-size` **不能**放在这里：放在启动期配置里会让服务端起不来
   * （tmux 直接 "server exited unexpectedly"，已逐项二分确认）。它在运行期设置
   * 没问题，所以归 `applyRuntimeOptions()`。
   */
  async writeServerConfig() {
    const lines = [
      `set -g history-limit ${this.historyLimit}`,
      `set -g default-terminal ${this.defaultTerminal}`,
      'set -g status off',
      'set -g mouse off',
      'set -g escape-time 10',
      // 必须在 `-f` 读的这份配置里：服务端启动后 `set -g` 也能改，但选项本身要在这里就位。
      // 实测（tmux 3.6b）加上它不影响建会话与按键投递；老版本 tmux 不认这个选项，故默认关闭；
      // **开了配置但版本 <3.2（或探测不到）时自动压制**（useExtendedKeys），不做"一开服务端起不来"。
      ...(this.useExtendedKeys() ? ['set -g extended-keys on'] : []),
      // 0.3.3 (a)：shell 退出后窗格保留为"死态"（pane_dead=1 + pane_dead_status=退出码），
      // 让"谁把 shell 关了/崩了、退出码多少"变成**可查**，而不是会话凭空消失。死壳由闲置清扫宽限回收。
      ...(this.remainOnExit ? ['set -g remain-on-exit on'] : []),
      // 0.3.3 (b)：开 monitor-bell 才有 window_bell_flag 可读（响铃旗标，面板 🔔 用）。
      ...(this.monitorBell ? ['set -g monitor-bell on'] : []),
    ]
    // `umask 077`：临时文件写在 /tmp，默认 644（同机其他用户可读）；内容不敏感，但
    // "能不能被别人读"不该由 umask 决定。
    const script = `umask 077; printf '%s\\n' ${lines.map((l) => `'${l.replace(/'/g, "'\\''")}'`).join(' ')} > ${shQuote(this.confFile)}`
    await this.run(['sh', '-c', script], { cap: 4096 })
  }

  /*
   * ⚠️ 切勿设置 `window-size manual`。
   *
   * 实测（tmux 3.6b）：把该全局会话选项设为 `manual` 之后，**服务端会在随后退出** ——
   * 下一条 `new-session` 报 `server exited unexpectedly`，其上的全部会话一并消失。
   * 逐项二分确认过：`status` / `mouse` / `escape-time` / `window-size latest` 都无害，
   * 只有 `manual` 致命；放进 `-f` 配置文件里同样会让服务端起不来。
   *
   * 代价与取舍：不设它，窗口就沿用 tmux 默认的 `window-size latest` —— detached 时
   * 保持创建时的尺寸；一旦有人 `tmux attach` 围观，窗格会跟随对方的终端尺寸。
   * 这可以接受（围观者能看到完整画面），需要时用 `shell_resize` 改回来。
   */

  // ── 会话 ───────────────────────────────────────────────────────────────────

  /** 全部会话及其指标。 */
  async list() {
    if (this.controlUsable()) {
      try {
        const out = await this.control.command(`list-panes -a -F ${tmuxQuote(LIST_FORMAT)}`)
        this.serverConfirmed = true
        const sessions = await this.sessionsFromRaw(out)
        return sessions
      } catch {
        this.markControlDown()   // 回退下面的临时路径，60 秒后再试 control
      }
    }
    const result = await this.probe(['list-panes', '-a', '-F', LIST_FORMAT])
    if (result.code !== 0) return []
    this.serverConfirmed = true
    return this.sessionsFromRaw(result.out)
  }

  /** 订阅某会话的新输出（数据由宿主侧抓屏泵喂入，见 index.js 的 watch pump）。 */
  watchOutput (name) {
    this.outputBus.watch(name)
    return true
  }

  /** 取消订阅（丢掉该会话缓存）。 */
  unwatchOutput (name) {
    this.outputBus.unwatch(name)
    return true
  }

  /** 喂一段"新输出"给环（宿主侧抓屏差分调用）。 */
  appendWatchedOutput (name, text) {
    return this.outputBus.append(name, text)
  }

  /** 取某会话自 cursor 以来的新输出（零 tmux 调用）。 */
  drainOutput (name, cursor) {
    return this.outputBus.drain(name, cursor)
  }

  /** 会话名列表。 */
  async liveNames() {
    const result = await this.probe(['list-sessions', '-F', '#{session_name}'])
    if (result.code !== 0) return []
    return result.out.split('\n').filter((line) => line.length > 0)
  }

  /**
   * 0.3.3：回收**积累的**幻影会话 —— tmux 给每个 control 客户端自建的纯数字默认会话，
   * 客户端活着时 attached=1 不能删（删了客户端连它一起退出，%output/推送全断）；
   * 但历次重连留下的旧幻影 attached=0，是纯垃圾（实测跑一天能攒 40+ 个，全部列表都在放大）。
   * 只杀「纯数字名 + attached 恰为 0」的，真会话（dsh- 前缀）与活客户端的幻影一律不碰。
   */
  async reapPhantomOrphans() {
    const result = await this.probe(['list-sessions', '-F', '#{session_name} #{session_attached}'])
    if (result.code !== 0) return 0
    const names = []
    for (const line of String(result.out ?? '').split('\n')) {
      const m = line.trim().match(/^(\d+) 0$/)   // 纯数字名 + attached=0
      if (m !== null) names.push(m[1])
    }
    if (names.length === 0) return 0
    // 一次 tmux 调用干掉全部：此前每个幽灵单独 spawn 一个 tmux 客户端且串行，
    // 实测 52 个幽灵让启动多花约 60 秒（startup ready in 64537ms 的主因）。
    // tmux 用 `;` 在一个客户端里串联命令，单个失败不影响其它。
    const args = []
    for (const name of names) {
      if (args.length > 0) args.push(';')
      // ⚠ `-t :N` 的语义是「会话:窗口」—— `:1` 指的是**默认会话的窗口 1**，
      // 不是「名字叫 1 的会话」，实测报 `can't find window: 1` 后什么都没杀，
      // 于是幽灵每次启动都“回收 0 个”（这才是幽灵长期堆积的真因，方案 A 只挡住了新增）。
      // `=N` 才是按名字精确匹配。批量串联调用实测一次清掉 70 个。
      args.push('kill-session', '-t', '=' + name)
    }
    try { await this.probe(args) } catch { /* 尽力而为 */ }
    // 复核：确认真没了，避免把“命令没生效”记成“已回收”
    const after = await this.probe(['list-sessions', '-F', '#{session_name} #{session_attached}'])
    if (after.code !== 0) return 0
    let left = 0
    for (const line of String(after.out ?? '').split('\n')) {
      if (/^\d+ 0$/.test(line.trim())) left += 1
    }
    return Math.max(0, names.length - left)
  }

  /** 单会话的 bell 旗标（true=已响过且未清）。control 可用走 control.command，否则一次性 probe。 */
  async bellFlag(name) {
    if (this.controlUsable()) {
      try {
        const out = await this.control.command(`list-panes -t ${safeTarget(String(name))} -F '#{window_bell_flag}'`)
        return String(out ?? '').trim().split('\n')[0].trim() === '1'
      } catch {
        this.markControlDown()   // 落到下面一次性路
      }
    }
    const result = await this.probe(['list-panes', '-t', name, '-F', '#{window_bell_flag}'])
    if (result.code !== 0) return false
    return String(result.out).trim().split('\n')[0].trim() === '1'
  }

  async has(name) {
    if (this.controlUsable()) {
      try {
        await this.control.command(`has-session -t ${safeTarget(name)}`, { timeoutMs: 2000 })
        return true
      } catch (error) {
        const message = String(error?.message ?? '')
        // tmux 报"找不到会话"是**预期结果**（has() 的 false），不是 control 故障 ——
        // 绝不能触发 60 秒退避（否则每次打错会话名就把 control 停用一分钟）。
        if (/\bcan't find session\b|no such session/i.test(message)) return false
        this.markControlDown()
      }
    }
    const result = await this.probe(['has-session', '-t', name])
    return result.code === 0
  }

  /**
   * 读取可见屏（`lines` 给定时从可见屏顶部再向上回溯这么多行）。
   */
  /**
   * 读屏幕。
   *
   * @param options.trim - 是否去掉**结尾空行**（默认 true）。
   *   面板必须传 `false`：它要靠「行数」把 tmux 的光标坐标 `cursorY` 换算成文本行号，
   *   而 `行号 = 总行数 − paneHeight + cursorY` —— 结尾空行被吃掉时总行数不够，
   *   算出来是负数，于是**文本少时（窗格下方是空的）光标干脆不显示**（实测踩到）。
   *   工具路径要的是干净文本，所以保持默认裁剪。
   */
  async screen(name, lines, options = {}) {
    // 0.3.4 `-e`：保留 ANSI 转义（颜色/粗细/反显）。面板前端有 SGR 渲染器，
    // 工具路径的纯文本消费者（redact/分词）对转义序列免疫（ASCII ESC + 参数，
    // 不匹配任何秘密模式）；resolveForeground 等解析只看行首结构不受影响。
    // tmux 的 `-e` 早在 2.0 就有，老服务端也不会拒绝这个标志。
    const args = lines === undefined
      ? ['capture-pane', '-e', '-p', '-t', name]
      : ['capture-pane', '-e', '-p', '-S', `-${lines}`, '-t', name]
    const result = await this.probe(args, { cap: lines === undefined ? 4 * 1024 * 1024 : 16 * 1024 * 1024 })
    if (result.code !== 0) {
      const detail = (result.err || result.out || '').trim()
      throw new Error(`cannot read session "${name}": ${detail}`)
    }
    const raw = options.trim === false ? result.out.replace(/\n$/, '') : result.out.replace(/\n+$/, '')
    return raw
  }

  /** 建一个新会话并启动交互式 shell。 */
  /**
   * 服务端是否已存在。`tmux ls` 在服务端不存在时**不会**创建它（返回非零 + 提示语）。
   *
   * 为什么需要这个检查：见 {@link createServerDirect} —— 服务端绝不能由
   * subprocess 服务的命令顺手拉起（那样它会住在会被 dispose 清算的 scope 里）。
   */
  async serverExists() {
    const result = await this.probe(['ls'])
    return result.code === 0
  }

  /**
   * 在**独立的 user scope** 里创建 tmux 服务端 —— 关键路径，绕开 subprocess 服务。
   *
   * 事故（实测，13:44 那次带会话重启）：`new-session` 若经 `ctx.subprocess` 执行，
   * tmux 服务端（setsid 后仍是该命令的 scope 成员）就住在
   * `dsh-subprocess-<harness>-<hash>.scope` 里。DSH 宿主退出时的同步最终清理会终止
   * 每个受管 scope（subprocess-local README 明示"scope 会拥有 setsid 的后代"、
   * "正常 dispose 终止每个仍在运行的受管范围"）→ **干净重启（systemctl restart）会
   * 连带杀掉服务端、丢掉全部会话**。60 秒看门狗只管崩溃/kill -9 那种"清理执行不到"
   * 的场景，救不了干净重启。
   *
   * 修法：创建服务端时**不经 subprocess 服务**，直接用 `systemd-run --user --scope`
   * （Node 直连 spawn，经 `env -i` 显式给干净最小环境）—— tmux 服务端因此落在用户会话
   * 里的**独立 scope**：subprocess 服务不追踪它（所以 dispose 碰不到）、dsh-web.service
   * 单元停止也不碰 user slice（所以重启碰不到）。命令级隔离不受影响（只有服务端这一个
   * daemon 走这里），看门狗继续负责崩溃场景的孤儿回收，bootstrap 在重启后收养既有会话。
   */
  /**
   * 普通 detach 启动服务端：**不依赖 user bus** —— tmux 自己 fork 并 reparent。
   * 降级承诺写在 describeEnv() 里：`systemctl restart dsh-web` 会连带终止它。
   * @returns {Promise<number>} 退出码（0 = 成功）
   */
  async spawnServerDetached({ name, cols, rows, cwd }) {
    const minimalEnv = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      TERM: this.defaultTerminal,
      ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
    }
    for (const kv of this.sessionEnv) {
      const eq = kv.indexOf('=')
      if (eq > 0) minimalEnv[kv.slice(0, eq)] = kv.slice(eq + 1)
    }
    const child = spawn('tmux', ['-L', this.socket, '-f', this.confFile, 'new-session', '-d', '-s', name,
      '-x', String(cols), '-y', String(rows), '-c', cwd, this.shell, ...this.shellArgs],
    { stdio: 'ignore', detached: true, env: minimalEnv })
    const code = await new Promise((resolve) => {
      child.on('error', () => resolve(-1))
      child.on('close', (exit) => resolve(exit ?? -1))
    })
    if (code === 0) child.unref()
    return code
  }

  async createServerDirect({ name, cols, rows, cwd }) {
    const env = [
      `PATH=${process.env.PATH ?? ''}`,
      `HOME=${process.env.HOME ?? ''}`,
      `TERM=${this.defaultTerminal}`,
      ...(process.env.LANG ? [`LANG=${process.env.LANG}`] : []),
      // 用户在设置里加的环境变量（sessionEnv，已过滤成合法 K=V）：追加在默认之后，可覆盖默认
      ...this.sessionEnv,
    ]
    const tmuxArgv = [
      'tmux', '-L', this.socket, '-f', this.confFile,
      'new-session', '-d', '-s', name,
      '-x', String(cols), '-y', String(rows), '-c', cwd,
      this.shell, ...this.shellArgs,
    ]
    // 能力决议（env.mjs）：有 systemd 用户会话才走独立 scope（重启后存活）。
    // 没有时退回普通 detach —— tmux 服务端自己 fork 并 reparent，同样独立存活于**当前**进程树，
    // 但**承诺收缩**：`systemctl restart dsh-web` 会连带终止它（dsh 干净重启后会话不保）。
    // 这条降级由 describeEnv() 明写给人看，不静默。
    if (this.serverLaunch !== 'systemd-scope') {
      const code = await this.spawnServerDetached({ name, cols, rows, cwd })
      if (code !== 0) throw new Error(`cannot create tmux server (tmux exit ${code}; plain-detach 路径)`)
      return
    }
    // 顺序必须如此：env -i 清空 → 显式变量 → tmux …（tmux 新会话的窗格 shell 继承这份环境）
    const argv = [
      '--user', '--scope', '--quiet',
      'env', '-i', ...env,
      ...tmuxArgv,
    ]
    const child = spawn('systemd-run', argv, { stdio: 'ignore' })
    const code = await new Promise((resolve) => {
      child.on('error', () => resolve(-1))
      child.on('close', (exit) => resolve(exit ?? -1))
    })
    if (code === 0) return
    // 降级（2026-10-24）：user bus 会在使用者不知情时消失 —— 典型是 WSL 里 user@1000 停掉，
    // 整个 /run/user/<uid> 目录跟着没了，systemd-run 立刻 exit 1
    //（"Failed to connect to user scope bus via local transport: No such file or directory"）。
    // 这时退回 plain-detach：代价只是「dsh 干净重启不保会话」，总比开不出 shell 好。
    // 两条都失败才算真失败，错误里带上两个退出码便于排查。
    const fallback = await this.spawnServerDetached({ name, cols, rows, cwd })
    if (fallback !== 0) {
      throw new Error(`cannot create tmux server (systemd-run exit ${code}；plain-detach 也失败 exit ${fallback})`)
    }
    console.warn(`terminalkeeper: systemd-run 启动服务端失败（exit ${code}），已退回 plain-detach`)
  }

  async create({ name, cols, rows, cwd, label = '' }) {
    // 竞态重试：服务端刚被 kill（或最后一个会话结束、服务端自行退出）时，紧接着的
    // `new-session` 有约一半概率返回 `server exited unexpectedly` —— 实测无延迟时
    // 8 次里失败 4 次，加 300ms 延迟后 0 次失败。用户可见路径就是「关掉最后一个 shell
    // 再开一个新的」，所以这里必须自己退避重试，而不是把这个错误丢给用户。
    const RETRIES = 3
    for (let attempt = 1; ; attempt += 1) {
      try {
        if (await this.serverExists()) {
          // 服务端已在：普通路径（经 subprocess 服务，每次调用是瞬态 scope，无碍）
          await this.tmux(['new-session', '-d', '-s', name,
            '-x', String(cols), '-y', String(rows), '-c', cwd, this.shell, ...this.shellArgs])
        } else {
          // 服务端不存在：**必须**走独立 scope 创建（见 createServerDirect 的事故说明），
          // 否则服务端会住进会被 dispose 清算的托管 scope，干净重启即丢全部会话。
          await this.createServerDirect({ name, cols, rows, cwd })
        }
        // 稳定 id 之外的显示名：label 是会话选项，可随时改名，与寻址无关
        if (label !== '') await this.setLabel(name, label)
        this.serverConfirmed = true   // 服务端确认存在，control 客户端可以安全启动（见控制模式的注释）
        return
      } catch (error) {
        const message = String(error?.message ?? error)
        const transient = /server exited unexpectedly|no server running|error connecting to/i.test(message)
        if (!transient || attempt >= RETRIES) throw error
        await this.pause(300 * attempt)
      }
    }
  }

  /**
   * 开始给一个会话做**输出留痕**：tmux 的 `pipe-pane` 把该窗格收到的字节实时追加到文件。
   *
   * 记的是窗格**输出**（含回显的命令、程序输出、TUI 画面），因此它回答的是"实际发生了什么"，
   * 与输入流水（谁发了什么）互补。会话被关掉后文件**依然在** —— 这就是"关闭会话后依然可见"。
   *
   * 两点注意：
   *   * `-o` 表示"已经开着就不再开"，重复调用安全；
   *   * 命令由 tmux 交给 `sh -c` 执行，所以路径必须引用（`shQuote`）——否则就是个注入点。
   */
  async startCapture(name, file) {
    // `umask 077`：留痕文件里是终端全文（可能含密码/令牌），不该依赖目录权限兜底
    await this.tmux(['pipe-pane', '-o', '-t', name, `umask 077; cat >> ${shQuote(file)}`])
  }

  /** 停止输出留痕（不传命令即关闭管道）。会话已消失时静默忽略。 */
  async stopCapture(name) {
    try {
      await this.tmux(['pipe-pane', '-t', name])
    } catch { /* 会话已不在：管道随会话一起消失了 */ }
  }

  async resize(name, cols, rows) {
    await this.tmux(['resize-window', '-t', name, '-x', String(cols), '-y', String(rows)])
  }

  /**
   * 关闭一个会话。**幂等**：会话已经不在（或服务端已经自行退出）不算错误。
   *
   * 理由很实在：面板的列表可能比现实旧一点，用户点 ✕ 时那个 shell 可能刚好自己结束了；
   * 最后一个会话结束时 tmux 服务端还会**自行退出**，于是 `kill-session` 直接报
   * `no server running on …`。把这种情况当失败抛给用户毫无意义 —— 他要的结果
   * （这个 shell 没了）已经达成。
   *
   * @returns {Promise<{closed: boolean, reason?: string}>}
   */
  async kill(name) {
    if (!(await this.has(name))) return { closed: false, reason: 'not-found' }
    try {
      await this.tmux(['kill-session', '-t', name])
      return { closed: true }
    } catch (error) {
      const message = String(error?.message ?? error)
      // 检查与关闭之间会话可能刚好结束（TOCTOU），同样是「已经没了」
      if (/can't find session|no server running|error connecting to/i.test(message)) {
        return { closed: false, reason: 'not-found' }
      }
      throw error
    }
  }

  /**
   * 重命名会话。
   *
   * tmux 会自作主张地把名字里的 `.` 和 `:` 换成 `_`，所以调用方必须**先净化**名字，
   * 否则 UI 显示的名字会和 tmux 里的真实名字不一致（之后按名字操作就会找不到）。
   */
  /** 改**显示名**（label）：只写会话选项，tmux 会话名（稳定 id）不动。 */
  async setLabel(name, label) {
    const value = String(label ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
    await this.tmux(['set-option', '-t', name, '@dsh-label', value])
  }

  /**
   * 控制客户端对某会话跑一次 display-message 的**原始回复**（未解析）。
   *
   * 诊断用：嵌套 tmux 等场景下"插件客户端 vs 其它客户端"读出的 pane_current_command
   * 不一致，源码已证回调无状态 —— 差异只能在'收到的回复形态/我方解析'这条链。
   * 此接口把插件自己客户端**亲口收到的那一行**原样交出来，一次实锤（也是
   * 面板诊断抽屉里'control 原始回复'查看器的后端）。
   */
  async rawReply(name) {
    if (!this.controlUsable()) throw new Error('control not usable')
    const metaOut = await this.control.command(
      `display-message -p -t ${safeTarget(name)} ${tmuxQuote(LIST_FORMAT)}`, { timeoutMs: 4000 })
    return metaOut
  }

  /**
   * 前台进程名 —— 用来判断 shell 是空闲还是仍在跑东西。
   *
   * 一次 `display-message` 同时取命令名与 `pane_pid`（**不多花一次 spawn** —— 经 subprocess
   * 服务起进程实测约 60–70ms，而这条路径每次 send/read 都会走），再交给
   * {@link TmuxDriver#resolveForeground} 钻穿 sudo/su 这类包装器。
   */
  async foregroundOf(name) {
    if (this.controlUsable()) {
      try {
        const out = await this.control.command(
          `display-message -p -t ${safeTarget(name)} "#{pane_current_command}\t#{pane_pid}"`, { timeoutMs: 3000 })
        const [command, pid] = out.split(SEP)
        return this.resolveForeground(command, pid)
      } catch {
        this.markControlDown()
      }
    }
    const result = await this.probe(['display-message', '-p', '-t', name, `#{pane_current_command}${SEP}#{pane_pid}`])
    if (result.code !== 0) return ''
    const [command, pid] = result.out.trim().split(SEP)
    return this.resolveForeground(command, pid)
  }

  /**
   * 发文本与按键。优先走 control 长驻客户端（面板逐键、工具逐行都是这里）——
   * 只有含换行（shell_send 的多行文本）或过长时退回一次性 spawn，因为换行会截断命令行的
   * 行语义，而过长文本不值得在控制通道里赌引号。文本经 `-l` 按字面发送、
   * 双引号包裹并转义 `\` `"` `$`（语义已实测，见 tmuxQuote）。
   */
  /**
   * 发送**原始字节**。这是插件里唯一能下发任意字节的原子 —— 因此**不接受外部字节**：
   * 只允许由插件自己按结构化参数（鼠标事件等具名能力）构造出来的序列走到这里。
   * 实测：`send-keys -H <hex…>` 能把字节完整送达窗格里的程序。
   */
  async sendBytes (name, bytes) {
    const list = Array.isArray(bytes) ? bytes : []
    if (list.length === 0 || list.length > 64) throw new Error('字节序列长度非法（1–64）')
    for (const b of list) {
      if (!Number.isInteger(b) || b < 0 || b > 255) throw new Error('字节取值非法（0–255 整数）')
    }
    const hex = list.map((b) => b.toString(16).padStart(2, '0'))
    await this.tmux(['send-keys', '-H', '-t', name, ...hex])
  }

  /**
   * 窗格里的应用是否请求了鼠标（tmux 自己的标志位，比解析屏上序列可靠）。
   * 依据：鼠标上报是 app 写给**终端**的控制序列，tmux 会消费掉、一般不会出现在窗格内容里。
   */
  async mouseFlags (name) {
    try {
      const out = await this.tmux(['display-message', '-p', '-t', name,
        '#{mouse_any_flag} #{mouse_sgr_flag} #{mouse_standard_flag} #{mouse_button_flag}'])
      const p = String(out ?? '').trim().split(/\s+/)
      return { known: true, any: p[0] === '1', sgr: p[1] === '1', standard: p[2] === '1', button: p[3] === '1' }
    } catch {
      return { known: false, any: false, sgr: false, standard: false, button: false }
    }
  }

  async send(name, text, keys, options = {}) {
    this.noteActivity(name)   // 0.3.3 #1：本插件的一切输入都经这扇门 —— SSE 流据此**当刻**跟手推帧
    // 注入修复：名字与键名都是 control 命令的字符串插值，先白名单校验再进命令；
    // 非法键名**抛错**（与 safeTarget 对称），不静默丢弃 —— 参数错了要让调用方看见。
    const target = safeTarget(name)
    const rawText = typeof text === 'string' ? text : ''
    const forcePaste = options === true || (typeof options === 'object' && options.forcePaste === true)
    const keyList = Array.isArray(keys)
      ? keys.map((key) => { if (!isSafeKeyName(key)) throw new Error(`unsafe tmux key: ${JSON.stringify(String(key).slice(0, 40))}`); if (!isKnownTmuxKey(key)) throw new Error(`tmux 不认识这个键名（会被当字面量打进终端）：${JSON.stringify(String(key).slice(0, 40))}；请用 BSpace/Escape/Enter/Tab/DC/NPage 这类实测键名，或 C-x/M-x 组合`); return key })
      : []
    // 0.3.0 双域系统：多行文本**不走** send-keys —— 每个 \n 都是隐性 Enter，等于逐行提交，
    // 危险的默认。一律 load-buffer + paste-buffer -p（readline 类 shell 整块接收），
    // 要不要再敲 Enter 由调用方的 keys（宏的 submit 语义）决定。
    // 0.3.4：面板粘贴模式经 forcePaste 把**单行长文本**也走同一条 paste-buffer 通道
    // （超长粘贴逐键会放大出错面；load-buffer 对整块内容一次到位）。
    if (forcePaste || rawText.indexOf('\n') >= 0) {
      await this.pasteText(name, rawText)
      for (const key of keyList) {
        await this.tmux(['send-keys', '-t', name, key])
      }
      return
    }
    if (this.controlUsable() && rawText.indexOf('\n') < 0 && rawText.length <= 512) {
      try {
        if (rawText.length > 0) {
          await this.control.command(`send-keys -l -t ${target} ${tmuxQuote(rawText)}`, { timeoutMs: 3000 })
        }
        if (keyList.length > 0) {
          await this.control.command(`send-keys -t ${target} ${keyList.join(' ')}`, { timeoutMs: 3000 })
        }
        this.serverConfirmed = true
        this.noteControlOk()
        return
      } catch {
        this.markControlDown()   // 回退下面的临时路径，指数退避后再试 control（5s 起步，60s 封顶）
      }
    }
    if (rawText.length > 0) {
      await this.tmux(['send-keys', '-l', '-t', name, rawText])
    }
    for (const key of keyList) {
      await this.tmux(['send-keys', '-t', name, key])
    }
  }

  /**
   * 0.3.0 多行注入通道：临时文件（0600）→ load-buffer → paste-buffer -p（bracketed）→
   * delete-buffer → 删除文件。宏展开后含换行的内容走这里；值进终端前的最后一次"我们可控"的形态。
   * ⚠ 不支持 bracketed-paste 的程序（部分 TUI）会把整块当逐行输入 —— 宏文档里写明。
   */
  async pasteText(name, text) {
    const target = safeTarget(name)
    const buf = `dsh-p-${name}`
    const file = join(tmpdir(), `dsh-paste-${name}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.tmp`)
    try {
      writeFileSync(file, String(text), { mode: 0o600 })
      await this.tmux(['load-buffer', '-b', buf, file])
      try {
        await this.tmux(['paste-buffer', '-p', '-b', buf, '-t', target])
      } finally {
        await this.probe(['delete-buffer', '-b', buf])
      }
    } finally {
      try { await unlink(file) } catch { /* 已删/没建成 */ }
    }
  }

  /**
   * 已知前台命令名与 pane_pid 时，钻穿包装器得到**真正持有终端**的命令名。
   *
   * 与 {@link foregroundOf} 的区别：不再多花一次 tmux 调用 —— 调用方（例如
   * {@link TmuxDriver#captureWithMeta}）往往已经顺手拿到了这两个字段。
   * 已经是 shell 时直接返回，一次 /proc 都不读（这是绝大多数调用的情形）。
   */
  async resolveForeground(command, pid) {
    const current = String(command ?? '').trim()
    if (current === '') return ''
    // 能力降级（env.mjs 的 plan.foreground === 'raw'）：读不到 /proc 时不钻穿，原值返回。
    // 代价如实：嵌套 tmux 的忙闲判定会退化（可能把 tmux 误当空闲 shell）——describeEnv 已写明。
    if (this.foregroundStrategy !== 'drill') return current
    const panePid = String(pid ?? '').trim()
    const procs = await readDescendantProcs(panePid)
    // 嵌套 tmux 判定 **先于一切**：窗格进程树里挂着 tmux 客户端/服务器（comm 实机为
    // `tmux: client` / `tmux: server`）→ 前台组在 bash 与嵌套客户端之间**真·赛跑**，
    // pane_current_command 只是随机采样（bash/tmux 都会采到，实测同一客户端同一命令
    // 同时刻给出两个值）。此时**不管采到什么**都按嵌套 tmux(busy) 处理 —— 否则按采样
    // 分流再解析会把两种采样都解析**反**（bash→嵌套✓、tmux→drill 到 pane_pid(bash)
    // 又反转回 bash✗，实测铁证）。
    let nested = false
    for (const entry of procs.values()) {
      if (entry.comm === 'tmux: client' || entry.comm === 'tmux: server' || entry.comm === 'tmux') {
        nested = true
        break
      }
    }
    if (nested) return 'tmux'
    if (isShellForeground(current)) return current
    return drillForeground(current, panePid, procs)
  }

  /**
   * 一次 spawn 同时取「会话指标（含前台命令名与 pane_pid）」与屏幕文本。
   *
   * 为什么要合并：经 DSH subprocess 服务起一个进程实测约 60–70ms（裸调 tmux 只要 4.5ms）。
   * 面板每 700ms 轮询一次 `/screen`，守卫在每次提交前也要读屏 —— 这些路径上**每多一次
   * tmux 调用就是整整一拍延迟**（实测 `/screen` 从 capture+list 两次调用合并成一次后，
   * 单请求 ~150ms → ~80ms）。tmux 支持在一次调用里用 `;` 串多条命令、输出按顺序拼接，
   * 于是 meta 走首行、屏幕走其余。
   *
   * 切分是**无歧义**的：meta 是一行 tab 分隔的定长字段（会话名与命令名里都不含换行），
   * 屏幕从第二行起原样保留（含前导/尾随空行，光标行号依赖"总行数 = 历史 + paneHeight"）。
   *
   * @param {string} name - 会话名
   * @param {number} [lines] - 额外向上取多少行历史；缺省只取可见屏
   * @param {{trim?: boolean}} [options] - `trim: false` 保留结尾空行（面板必须传 false）
   * @returns {Promise<{meta: object|null, screen: string}>} meta 解析不出来时为 null
   */
  /**
   * 0.3.4 (C)：原地重开窗格里的 shell（tmux 原生 respawn-pane）。
   * **会话名不变** —— 归属、审计链、面板位置、其他人对它的引用全都续得上；
   * 死壳（remain-on-exit 定格）或 shell 自己 exit 之后，用这个把终端接回来。
   */
  async respawn(name, cwd) {
    const target = safeTarget(name)
    const args = ['respawn-pane', '-k', '-t', target]
    const dir = String(cwd ?? '').trim()
    if (dir !== '') args.push('-c', dir)
    args.push(this.shell, ...this.shellArgs)
    await this.tmux(args)
    this.noteActivity(name)
  }

  /**
   * 0.3.4 (E)：窗格里的进程树（pid + comm 列表）。
   * 供 waitFor `noproc:<名称>` 判定"某进程是否已消失"——走 /proc，不 spawn。
   */
  async paneProcs(name) {
    const pid = await this.panePid(name)
    const procs = await readDescendantProcs(pid)
    return [...procs.entries()].map(([p, v]) => ({ pid: p, comm: v.comm }))
  }

  /** 0.3.4 (E)：窗格初始 shell 的 pid（读不到 → 空串）。 */
  async panePid(name) {
    try {
      const out = await this.probe(['list-panes', '-t', name, '-F', '#{pane_pid}'])
      return String(out.out ?? '').trim().split('\n')[0].trim()
    } catch {
      return ''
    }
  }

  /**
   * 0.3.4 (E)：采样窗格进程树的 CPU 占用（%）。
   * 两次读 /proc/<pid>/stat 的 utime+stime（clock ticks）差分，换算成区间内的平均占用。
   * 读不到 /proc 的进程按 0 计 —— 结果只用于"是否安静"的粗判，不精确也无妨。
   */
  async paneCpu(name, sampleMs = 250) {
    const first = await this.sampleProcTicks(name)
    await this.timer.timeout(Math.max(50, Math.min(2000, sampleMs)))
    const second = await this.sampleProcTicks(name)
    const procs = []
    for (const [pid, t1] of second) {
      const t0 = first.get(pid)
      if (t0 === undefined) continue
      const delta = t1 - t0
      const pct = delta <= 0 ? 0 : (delta * 1000 / Math.max(1, sampleMs))   // HZ=100 → ticks/10ms
      procs.push({ pid, cpu: pct })
    }
    return procs
  }

  /** 读窗格进程树每个 pid 的 utime+stime（clock ticks）。 */
  async sampleProcTicks(name) {
    const out = new Map()
    const pid = await this.panePid(name)
    if (!/^[0-9]+$/.test(pid)) return out
    const procs = await readDescendantProcs(pid)
    for (const p of procs.keys()) {
      try {
        const stat = await readFile(`/proc/${p}/stat`, 'utf8')
        // 字段 14/15 = utime/stime；comm 可能含空格与括号 → 取最后一个 ')' 之后切分
        const tail = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
        const utime = Number(tail[11])
        const stime = Number(tail[12])
        if (Number.isFinite(utime) && Number.isFinite(stime)) out.set(p, utime + stime)
      } catch { /* 进程刚好退出：跳过 */ }
    }
    return out
  }

  async captureWithMeta(name, lines, options = {}) {
    if (this.controlUsable()) {
      try {
        return await this.captureWithMetaViaControl(name, lines, options)
      } catch {
        this.markControlDown()   // 回退下面的临时路径，60 秒后再试 control
      }
    }
    const capture = lines === undefined
      ? ['capture-pane', '-e', '-p', '-t', name]
      : ['capture-pane', '-e', '-p', '-S', `-${lines}`, '-t', name]
    // `;` 作为独立 argv 元素传给 tmux 即为命令分隔符（不经 shell，所以不需要转义）
    const result = await this.probe(['display-message', '-p', '-t', name, LIST_FORMAT, ';', ...capture], {
      cap: lines === undefined ? 4 * 1024 * 1024 : 16 * 1024 * 1024,
    })
    if (result.code !== 0) {
      const detail = (result.err || result.out || '').trim()
      throw new Error(`cannot read session "${name}": ${detail}`)
    }
    const out = result.out
    const cut = out.indexOf('\n')
    const head = cut < 0 ? out : out.slice(0, cut)
    const rest = cut < 0 ? '' : out.slice(cut + 1)
    const meta = head.includes(SEP) ? toSession(head) : null
    return { meta, screen: options.trim === false ? rest.replace(/\n$/, '') : rest.replace(/\n+$/, '') }
  }

  /** control 路径的 captureWithMeta：meta 与屏幕分开两条命令（~1ms 级管道往返，零 spawn）。 */
  async captureWithMetaViaControl(name, lines, options = {}) {
    // ⚠ 不能像一次性路径那样用 `;` 串联：control mode 里每条 `;` 分隔的命令**各自成帧**
    // （display-message 一帧、capture-pane 再一帧）。若一次只等一帧，首条命令会在第一帧
    // 结束后提前返回（屏幕=1 行）；第二帧的 %end 还会偷走下一条命令的 waiter，并把
    // %output 通知吞进残留帧（实测四条症状同源）。分开发、各自配对。
    const metaOut = await this.control.command(
      `display-message -p -t ${safeTarget(name)} ${tmuxQuote(LIST_FORMAT)}`, { timeoutMs: 4000 })
    if (process.env.DDEBUG === '1') {
      console.error('[dsh-ctl] metaOut:', JSON.stringify(metaOut.slice(0, 400)))
    }
    const metaNorm = normalizeReply(metaOut)
    const cut = metaNorm.indexOf('\n')
    const head = cut < 0 ? metaNorm : metaNorm.slice(0, cut)
    const meta = head.includes(SEP) ? toSession(head) : null
    // lines 由调用方 parseInt + 有限性校验过；这里再落一次白名单之外的底线（负数/越界直接按全量）
    const linesSafe = Number.isFinite(lines) && lines > 0 ? Math.floor(lines) : undefined
    const paneH = meta !== null && Number.isFinite(meta.paneHeight) && meta.paneHeight > 0 ? meta.paneHeight : 0
    // 0.3.3 收尾 + 0.3.4 回归：按「要不要历史」分流，两个语义各走各的可靠路径：
    //   · 尾读（lines ≤ 可见屏高度，工具 tail / 回显尾部）：control `-S -N` 的锚点
    //     在本插件「共享 control + 高频 capture + 并发流」下不可靠（返回历史顶部 →
    //     假 ✅ exit 0），改**全量捕获 + 底部切片**（服务端屏幕模型永远新鲜）。
    //   · 历史读（lines > 可见屏高度 = 明确要 scrollback：面板 /screen 与 /stream
    //     每帧带 lines=historyWindow(默认 200) 供滚轮回看）——必须**恢复 `-S -N`**
    //     拉滚动缓冲；上一轮"全量 + slice(-max(lines, 屏高))"只返回可见屏，
    //     把面板滚轮历史整个砍掉了（实测回归：常规模式滚轮翻不到历史）。
    //     面板轮询节奏（500ms~2s）下 control `-S -N` 一直可靠，历史场景不受那个
    //     高压 corner case 影响；CLI 一次性路径本就可靠（保留在 captureWithMeta 回退）。
    let screenOut
    if (linesSafe !== undefined && paneH > 0 && linesSafe > paneH) {
      screenOut = String(await this.control.command(`capture-pane -e -p -S -${linesSafe} -t ${safeTarget(name)}`, { timeoutMs: 4000 }))
    } else {
      screenOut = String(await this.control.command(`capture-pane -e -p -t ${safeTarget(name)}`, { timeoutMs: 4000 }))
    }
    const rawLines = screenOut.split('\n')
    const take = linesSafe !== undefined && !(paneH > 0 && linesSafe > paneH) ? Math.max(linesSafe, paneH) : undefined
    const screenOutTail = take === undefined
      ? screenOut
      : rawLines.slice(-Math.max(take, 1)).join('\n')

    this.serverConfirmed = true
    this.noteControlOk()
    // meta 帧一般没有残留行；万一带了（防御），拼回屏幕不破坏行数语义
    const extra = cut < 0 ? '' : metaNorm.slice(cut + 1)
    const screen = options.trim === false ? extra + screenOutTail : (extra + screenOutTail).replace(/\n+$/, '')
    return { meta, screen }
  }

  // ── 服务端生命周期 ─────────────────────────────────────────────────────────

  /** 杀掉整个服务端（含其上全部会话）。 */
  async killServer() {
    await this.probe(['kill-server'])
  }

  /** 清理残留会话（孤儿兜底）。 */
  async cleanupOrphans() {
    const names = await this.liveNames()
    for (const name of names) await this.probe(['kill-session', '-t', name])
    return names
  }

  /**
   * 某个 pid 的命令行里是否出现某个子串（读不到就当作「不是」）。
   *
   * 读 `/proc/<pid>/cmdline`（NUL 分隔）后交给 `grep -qa`，这样不必在 JS 里处理编码。
   */
  async cmdlineMentions (pid, needle) {
    if (!/^[0-9]+$/.test(String(pid))) return false
    const result = await this.run(
      ['sh', '-c', `[ -r "/proc/${pid}/cmdline" ] && grep -qa -- ${JSON.stringify(needle)} "/proc/${pid}/cmdline" && echo yes || echo no`],
      { cap: 4096 },
    )
    return result.out.trim() === 'yes'
  }

  /**
   * 定位 harness 进程自身的 pid。
   *
   * **首选本进程**：插件作为 profile bundle 挂在 host 平面上，与 harness 同进程，
   * 所以 `process.pid` 就是答案 —— 只要确认它看起来确实是 harness（cmdline 含 `dsh`）。
   *
   * 为什么不再直接向上遍历：那条路靠「祖先 cmdline 里出现 `dsh` 字样」认人，实测会被
   * **任何**命令行里提到 dsh 的中间进程骗到。真实踩到的一次是：一条内容里含 "dsh"
   * 字样的 `bash -c "…"` 命令，让探针把那个 shell 的 pid 当成了 harness。
   * 认错的代价很大 —— `bootstrap()` 会因此走「非收养」分支，把用户正在用的会话清掉。
   *
   * 只有当本进程不像 harness（插件被放进子进程的非常规部署）时，才退回到向上遍历；
   * 遍历时取**最上层**的那个匹配项（harness 通常是整条链的最外层 dsh 进程），
   * 这比取最近的一个更不容易被中间包装进程误导。
   */
  async harnessPid () {
    if (this.harnessPidOverride !== '') return this.harnessPidOverride
    if (await this.cmdlineMentions(process.pid, 'dsh')) return String(process.pid)

    const script = [
      'p=$PPID',
      'found=""',
      'while [ -n "$p" ] && [ "$p" != "1" ] && [ "$p" != "0" ]; do',
      '  if [ -r "/proc/$p/cmdline" ] && grep -qa dsh "/proc/$p/cmdline"; then',
      // 跳过 shell：一条内容里提到 dsh 的 `bash -c "…"` 同样「cmdline 含 dsh」，
      // 但它显然不是 harness（实测就是这么被骗到过）。harness 是 node 之类的长驻进程。
      '    case "$(cat "/proc/$p/comm" 2>/dev/null)" in',
      '      sh|bash|dash|zsh|fish|setsid) ;;',
      '      *) found="$p" ;;',
      '    esac',
      '  fi',
      '  p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d " ")',
      'done',
      'echo "$found"',
    ].join('\n')
    const result = await this.run(['sh', '-c', script], { cap: 4096 })
    if (result.code !== 0) return ''
    const pid = result.out.trim()
    return /^[0-9]+$/.test(pid) ? pid : ''
  }

  /**
   * 布防孤儿看门狗。
   *
   * tmux 服务端会 setsid 并 reparent，harness 退出时的托管进程清理**够不到它**，
   * 所以需要一个刻意脱离进程树的守护进程：harness 进程消失后杀掉本服务端。
   * `setsid -f` 让它进入新的 session/进程组，从而在被调用方被清理时幸存。
   *
   * @returns {Promise<string>} 被监视的 harness pid，未布防时为空串。
   */
  /** 当前 harness 的 pid + /proc starttime（身份校验用）。 */
  async harnessIdentity () {
    const pid = await this.harnessPid()
    if (pid === '') return null
    return { pid: String(pid), start: readProcStart(pid) }
  }

  /**
   * 一次性迁移：清掉旧版 lease-node 看门狗（pid/lease 文件）。
   * 新方案不落盘状态，但旧进程会继续按旧逻辑在 harness 消失后杀服务端；
   * 这里只认 cmdline 里同时含 watchdog.mjs 与 --socket=<本 socket> 的进程，避免误杀。
   */
  async disarmLegacyLeaseWatchdog () {
    const pidFile = join(tmpdir(), `${this.socket}-watchdog.pid`)
    const leaseFile = join(tmpdir(), `${this.socket}-watchdog.lease`)
    try {
      const parts = readFileSync(pidFile, 'utf8').trim().split(/\s+/)
      const pid = parts[0] ?? ''
      if (/^\d+$/.test(pid)) {
        const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim()
        if (cmdline.includes('watchdog.mjs') && cmdline.includes(`--socket=${this.socket}`)) {
          try { process.kill(Number(pid), 'SIGTERM') } catch { /* 已退出 */ }
        }
      }
    } catch { /* 没有旧文件 */ }
    try { unlinkSync(pidFile) } catch { /* 不存在 */ }
    try { unlinkSync(leaseFile) } catch { /* 不存在 */ }
  }

  /** 绑定 owner socket；同一个 driver 只 bind 一次。 */
  async ensureOwnerSocket () {
    if (this.ownerServer !== null) return this.ownerServer
    const identity = await this.harnessIdentity()
    if (identity === null) throw new Error('cannot find harness pid; refusing to bind owner socket')
    const server = await acquireOwnerServer({
      runtimeDir: this.runtimeDir,
      socket: this.socket,
      harnessPid: identity.pid,
      harnessStart: identity.start,
    })
    this.ownerServer = server
    return server
  }

  /** 关闭 owner socket（插件卸载/禁用时调用；不杀 tmux）。 */
  closeOwnerSocket () {
    if (this.ownerServer !== null) {
      try { releaseOwnerServer(this.ownerServer) } catch { /* 忽略 */ }
      this.ownerServer = null
    }
  }

  /** watchdog 控制面状态；没有 watchdog 返回 null。 */
  async watchdogStatus () {
    const status = await controlCall(this.controlSocket, { magic: WATCHDOG_MAGIC, cmd: 'status' })
    return status?.magic === WATCHDOG_MAGIC ? status : null
  }

  /**
   * 布防孤儿看门狗（owner socket 版）。
   * 服务端会 setsid/reparent，harness 退出时进程树清理够不到它；
   * watchdog 只持有 control socket，状态全部在内存，不写 lease/pid 文件。
   *
   * @returns {Promise<string>} 被监视的 harness pid，未布防时为空串。
   */
  async armWatchdog () {
    const identity = await this.harnessIdentity()
    if (identity === null) return ''
    await this.disarmLegacyLeaseWatchdog()
    await this.ensureOwnerSocket()
    const args = [
      `--owner=${this.ownerSocket}`,
      `--control=${this.controlSocket}`,
      `--socket=${this.socket}`,
      `--harness=${identity.pid}`,
      `--harness-start=${identity.start}`,
      `--grace=${String(this.watchdogGraceMs)}`,
      `--interval=${String(this.watchdogIntervalMs)}`,
      `--proc-readable=${this.watchdogProcReadable ? '1' : '0'}`,
    ]
    const child = spawn(process.execPath, [WATCHDOG_MAIN, ...args], { stdio: 'ignore', detached: true })
    child.unref()
    // 等 control socket 出现（最多 2s）；已有 watchdog 会直接返回其状态
    for (let i = 0; i < 20; i += 1) {
      const status = await this.watchdogStatus()
      if (status !== null) return identity.pid
      await this.pause(100)
    }
    return identity.pid
  }

  /** 只返回与当前代码 ABI 匹配的 watchdog 状态；旧进程需要通过 replaceWatchdog 替换。 */
  async watchdogStatusCurrent () {
    const status = await this.watchdogStatus()
    return watchdogCompatible(status) ? status : null
  }

  /**
   * 替换旧 watchdog：control 发 disarm，等它退出，再按当前代码 ABI spawn。
   * 只替换 watchdog 进程，不动 tmux 会话/owner socket。
   */
  async replaceWatchdog () {
    const prior = await this.watchdogStatus()
    if (prior !== null) {
      await this.disarmWatchdog()
      for (let i = 0; i < 30; i += 1) {
        if (await this.watchdogStatus() === null) break
        await this.pause(100)
      }
    }
    return this.armWatchdog()
  }

  /** 读回 watchdog 状态（兼容旧调用点）。 */
  async readWatchdogState () {
    const status = await this.watchdogStatus()
    return {
      watchdogPid: typeof status?.pid === 'string' ? status.pid : '',
      harnessPid: typeof status?.harnessPid === 'string' ? status.harnessPid : '',
      harnessStart: typeof status?.harnessStart === 'string' ? status.harnessStart : '',
    }
  }

  /** 读回看门狗 pid（没有则为空串）。 */
  async watchdogPid () {
    const status = await this.watchdogStatus()
    return typeof status?.pid === 'string' ? status.pid : ''
  }

  /**
   * 停掉看门狗：通过 control socket 发 disarm；没有 control 就什么都不做。
   * 不删 owner socket —— 是否保留 owner 由调用方的启用/禁用语义决定。
   */
  async disarmWatchdog () {
    await controlCall(this.controlSocket, { magic: WATCHDOG_MAGIC, cmd: 'disarm' }, 1200)
  }

  /**
   * 启动时的收养/重布防：先绑定新 owner socket，再通过 control socket 收养旧 watchdog；
   * 没有 watchdog 才 spawn。绝不清理会话。
   */
  async bootstrap (options = {}) {
    await this.writeServerConfig()
    if (options.armWatchdog === false) {
      return { adopted: false, kept: await this.liveNames(), cleaned: [], watchdogPid: '', harnessPid: '' }
    }
    const identity = await this.harnessIdentity()
    if (identity === null) return { adopted: false, kept: await this.liveNames(), cleaned: [], watchdogPid: '', harnessPid: '' }
    await this.disarmLegacyLeaseWatchdog()
    await this.ensureOwnerSocket()
    const prior = await this.watchdogStatus()
    if (prior !== null && watchdogCompatible(prior)) {
      // 旧 watchdog 可能还在监视旧 harness；用 adopt 立即切换到新 owner。
      await controlCall(this.controlSocket, { magic: WATCHDOG_MAGIC, cmd: 'adopt', harnessPid: identity.pid, harnessStart: identity.start }, 1200)
      return { adopted: true, kept: [], cleaned: [], watchdogPid: String(prior.pid ?? ''), harnessPid: identity.pid }
    }
    if (prior !== null) {
      // 无 abi / abi 不匹配（例如旧版 guard 之前的进程）：替换，不继续收养。
      await this.replaceWatchdog()
      return { adopted: false, kept: [], cleaned: [], watchdogPid: await this.watchdogPid(), harnessPid: identity.pid }
    }
    const kept = await this.liveNames()
    const watched = await this.armWatchdog()
    return {
      adopted: false,
      kept,
      cleaned: [],
      watchdogPid: watched === '' ? '' : await this.watchdogPid(),
      harnessPid: identity.pid,
    }
  }

  /**
   * 某个路径是否是**存在的目录**。
   *
   * 必须有这一道检查：`new-session -c <不存在的目录>` **不会报错**，tmux 会静默回落到
   * 用户 home 起一个 shell —— 而插件会把请求的路径当作实际 cwd 报回去，等于对调用方说谎
   * （实测确认：`-c /nonexistent` 建的会话里 `pwd` 是 /home/<user>）。
   */
  async isDirectory (path) {
    if (typeof path !== 'string' || path.length === 0) return false
    const result = await this.run(['sh', '-c', 'test -d "$1"', 'sh', path], { cap: 4096 })
    return result.code === 0
  }

  /** 某个 pid 是否还活着。 */
  async isAlive(pid) {
    const result = await this.run(['sh', '-c', `kill -0 ${pid} 2>/dev/null && echo yes || echo no`], { cap: 4096 })
    return result.out.trim() === 'yes'
  }

  /**
   * 卸载时的行为：**什么都不做**。
   *
   * 这是刻意的。dispose 会在每一次配置热重载时执行，若在这里 kill-server，用户
   * 每次改配置都会丢掉全部 shell。会话本该在热重载中存活 —— 真正需要收尾的时刻是
   * harness 进程结束，那是看门狗的职责（它在 harness 消失后杀服务端）。
   *
   * 于是：想清空全部 shell 请显式调用 killServer()（或逐个 kill），移除插件后
   * 残留的会话也会在 harness 退出时由看门狗收掉。
   */
  async shutdown() {
    // 收掉 control 长驻客户端：它是 subprocess 服务管理的 scope 子进程，
    // terminate 会连同其 range 一起停稳（服务端不是本插件的，不在这里 kill）。
    this.control?.stop()
    this.control = null
    // owner socket 随插件卸载关闭；watchdog 会看到 socket 消失，但 harness 进程仍活着，
    // 因此不会误杀；新实例会重新 bind。
    this.closeOwnerSocket()
    return undefined
  }
}
