/**
 * 模型可见的工具说明（单一事实源）。
 *
 * 三条硬规则（本轮用户要求）：
 *   1. **操作是操作，参数是参数**：每个可执行动作都是显式的 `action.kind`；参数里
 *   2. **每个参数都要解释**；取值有限的参数（kind / mode / showing / lock / state …）
 *      必须逐个取值解释它做什么，而不是只列名字。
 *   3. 说明要能被机器核对：文档中的事实必须能从代码这里得到验证。
 */

/** 公共块说明（按工具裁剪后拼进 tasks 的 description）。 */
const TARGET_DOC = 'target：操作目标。唯一字段 sessions：'
  + '默认只操作本对话创建的 shell；**无用户明确要求不要操作其它对话创建的 shell**（判据：用户在消息里给出具体 id）。'
  + '「mine」= 本对话创建的**全部** shell（默认；只有一个会话时即该会话，多个时用 id 精确指定某一个）；'
  + '「*」= 全部存活 shell（想看全部必须显式写它；**写操作 shell_run / shell_send / shell_manage 的生命周期动作不允许 *，会直接拒绝**）；'
  + '或显式 id（单个或逗号分隔，如 "dsh-ab12,dsh-cd34"）。'
  + '同一个 shell 在一次调用里只能出现在一个任务中。'

const WAIT_DOC = 'wait：等待条件 + 超时（结构化：kind 是操作，其余是它的参数）。'
  + 'kind 取值：'
  + 'none = 立即返回，不等命令结束（命令继续在后台跑）= 异步启动；'
  + 'idle = 用默认行为：等命令回到空闲（默认，最多等 timeoutMs；不是“不等待”）；'
  + 'bell = 等到响铃；'
  + 'match = 新输出匹配正则（配 pattern）；'
  + 'exit = 命令结束（可选 code 0–255，同时校验退出码；码不符或命令无法注入退出码标记时会立即报告原因，不等满超时）；'
  + 'file = 文件出现（配 path，支持 ~）；'
  + 'noproc = 进程从窗格进程树消失（配 proc）；'
  + 'cpu = 前台进程 CPU 占用低于阈值（配 threshold，0–100）。'
  + '通用字段：timeoutMs = 最多等多久（默认 30000）；pollMs = 检查间隔（默认 150）。'

const WAIT_READ_DOC = 'wait：等待条件 + 超时（结构化：kind 是操作，其余是它的参数）。'
  + 'kind 取值：'
  + 'idle = 等回到提示符；'
  + 'bell = 等到响铃（BEL）；'
  + 'match = 等待开始后**新出现**的输出匹配正则（配 pattern；JS 正则、区分大小写，屏上历史不算）；'
  + 'exit = 等命令结束（**同一次调用里可直接用**；也可先 wait.none 异步启动、之后用 runId 绑定到某次具体的 shell_run —— shell_run 的返回里会带 `run=<id>`，runId 只能与 exit 搭配）：缓冲里出现**本 shell 最近一次 shell_run** 的退出码标记（`__DSH_EXIT_<nonce>__=N`，宿主自动绑定，调用方无需知道 nonce）即到达 —— 等待开始前就已结束、标记已在缓冲里也算命中（读屏不会消耗它）；'
  + '配 code（0–255）时同时校验，码不符会立刻回报 `exit=N ≠ 期望`。这条专门解决“先后台跑、之后取退出码”。绑定到**本 shell 最近一次 shell_run**：如果中途又跑了别的命令，绑定的就是新的那条 —— 严格绑定请在同一次 run 里用 wait.kind=exit；'
  + 'foreground = 前台命令变成指定进程（配 proc，如 vim）。'
  + '通用字段：timeoutMs = 最多等多久（默认 30000，**上限 24 小时**；两分钟以上的命令请显式给值）；超时只回报“超时”，不杀进程。\n'
  + 'read 的 exit 等待返回样例：`[dsh-ab12cd] 已到达 wait exit(0) exit=0 (12.4s, fg=bash)` + 尾部输出；超时是 `[dsh-ab12cd] 超时 wait exit (30.0s, fg=make)` + 当前尾部。'

const WAIT_SEND_DOC = 'wait：只有一个字段 pollMs = 投递后检查屏幕是否稳定的间隔（默认 150，最小 20）。'

const OUTPUT_DOC = 'output：返回形状。'
  + 'lines = 只返回末尾多少行（默认 20，最大 2000，严格截断；行是**终端缓冲行**，含提示符/空行，退出码包装器还会多插空行 —— 想稳拿回显请多读几行或用 since）；'
  + 'showing = since 本次 shell_run 发送后新增的输出（默认，不重复旧屏/回显）；显式 tail 才返回末尾缓冲（含旧屏/回显）/ screen 当前可见屏 / diff 与上次读取相比 / '
  + 'summary 末尾若干行并在首行标注总行数（since/diff 没有新内容时明确返回"(无新输出)"）；'
  + 'structured = true（默认）按块结构化返回 / false 返回一段纯文本。'
  + '结构化形态：第一行是汇总头 `[工具] 关键量`（如 `[shell_run] tasks=1 · concurrency=4`，这是**返回头**、不是入参）；每个任务一段，段首 `[<id>] 结果摘要`（如 `[dsh-ab12cd] ✅ 条件达成 exit · 0.0s`），随后是该任务的输出；多任务时每段前加 `【任务名】`。'

const OUTPUT_LINES_DOC = 'output：返回形状。lines = 返回多少行（默认 20，最大 2000；tail 保留**最后** N 行；行是终端缓冲行，含提示符/空行，退出码包装器还会多插空行；since 的新增超过 2000 行会保留最后 2000 行并标注丢了多少）。'

const SAFETY_DOC = 'safety：执行前保护。'
  + 'bypassGuard = true 时跳过危险命令守卫（只在用户明确要求时用；**必须同时给非空 reason**，审计会记 bypass-guard）；无 reason 会被拒绝；守卫拦的是这些模式：递归删根/家目录/通配、find -delete、mkfs、dd 写块设备、fork bomb、chmod 777 /、关机重启、curl|sh、tmux kill-server/kill-session、pkill tmux/node、npm publish、git push --force；**普通清理（如 rm -rf /tmp/x）不会被拦**，别把它当成沙箱；'
  + 'dryrun = true 时只回报将要执行什么，不真正执行；'
  + 'lock = require（默认，同一 shell 的写操作串行，**没有单独超时**）/ ignore（不等待会话锁）；人工锁定（面板里的锁）与它无关：被人工锁定的 shell 会**立刻 REFUSED**，不会等；'
  + 'reason = 写进审计的原因；'
  + 'force = 引用库未解密时是否强制继续（口令加密的组仍会被拒绝）。'

const BLOCK_RULE = '传该工具不消费的块会被直接拒绝并列出允许的块。'

/** 组装 tasks 的 description：块规则 + 每个块的逐字段说明 + 操作（kind）说明。 */
function tasksDoc (blocks, actionDoc) {
  const parts = ['任务数组。每项：{ label?, ' + blocks.join('?, ') + ' }。label = 任务名（默认「任务N」，多任务时用于区分输出）；action 必填（缺了会直接报错，没有“只带 wait 等上一个命令”的用法）。']
  if (blocks.includes('target')) parts.push(TARGET_DOC)
  if (blocks.includes('wait')) parts.push(actionDoc.waitDoc ?? WAIT_DOC)
  if (blocks.includes('output')) parts.push(actionDoc.outputDoc ?? OUTPUT_DOC)
  if (blocks.includes('safety')) parts.push(actionDoc.safetyDoc ?? SAFETY_DOC)
  parts.push(actionDoc.text)
  // 盲测指出：全篇没有统一的单位约定（ms/行/字符混着说）
  parts.push('单位约定：带 Ms 后缀的字段是毫秒；idleMinutes 是分钟；days 是天；行数用 lines。')
  parts.push(BLOCK_RULE)
  return parts.join('\n')
}

/** 七个工具的说明。改这里就等于改模型看到的一切（文档门禁会核对）。 */
export const TOOL_DOCS = {
  shell_open: {
    description: '创建持久交互 shell（真实 TTY，跨调用甚至跨对话存活；本文的 shell / 会话 / 终端指同一个东西，窗格是其实现细节）。'
      + 'tasks 之间**串行**执行（每个任务内部可按 count 并发创建）。'
      + '创建前会预检会话上限（默认 8，可在设置页改到 1–64；作用域是全局存活数）：现有 + count 超过上限就整批拒绝、一个都不建。'
      + '操作只有一种：action.kind = "open"。',
    parameters: {
      tasks: {
        type: 'array',
        required: true,
        description: '任务数组（1–16 个，串行执行）。每项：{ label?, action }。任务级 label 只是**本次调用的分块名**（多任务时区分输出，不参与会话命名）；会话命名用 action.label；shell_state 的 label 是**过滤子串**。三者同名不同义。\n'
          + 'action.kind = "open"（唯一操作），其参数：\n'
          + 'count = 一次创建几个，1–64（默认 1）；\n'
          + 'cwd = 起始工作目录（默认继承部署配置）；\n'
          + 'label = 命名基名（显示名会自动加 `dsh-` 前缀；**target.sessions 必须用返回的 session id，不是 label**；tmux 会话名保持稳定不变）；\n'
          + 'cols / rows = 初始宽高（默认 120×32，收敛到配置允许范围 20–1000 × 5–500）；\n'
          + 'idleMinutes = 闲置多少分钟自动关闭（0 = 永不自动关闭；省略 = 跟随全局：总开关关时永不回收，开启时按 idleCloseMinutes 默认 60 分钟兜底；闲置 = 无输入且前台无命令，只读屏不算活动）；\n'
          + 'watch = true 时创建后顺便订阅新输出（等价于再调一次 shell_read 的 subscribe；重复订阅幂等，不会重复登记；TUI 程序不要订阅）；\n'
          + 'from = 从快照复活：传**旧会话 id**（不是快照名；取该会话最近一次快照，复活成新会话）。\n'
          + '本工具不接受 target / wait / output / safety 块（它创建会话，没有目标）。\n'
          + '返回形态（每开一个一段）：`session <id> (<label>) | <cols>x<rows> | cwd <目录> (<来源>) | idle=<状态>`（`永久(未指定)` 表示全局空闲回收开关关着；开关打开时未显式给值的会话按 idleCloseMinutes 兜底），下一行是首屏快照。后续所有工具用这个 <id> 填 `target.sessions`。',
      },
    },
  },

  shell_run: {
    description: '默认只操作本对话创建的 shell；要操作其它对话创建的 shell，必须**用户明确要求**（unless the user explicitly asks）—— 判据是用户在消息里给出具体 shell id（如 dsh-ab12cd），只说“那个 shell”不算。在 shell 里执行并返回结果：输出末尾会带一行退出码标记。终端缓冲里它是原始形态 `__DSH_EXIT_<nonce>__=N`；等待结果行会写 ✅/❌（如 `✅ 条件达成 exit · 0.0s` / `❌ 等待超时 exit(0)`），原始标记仍留在缓冲里（读缓冲时认原始标记）。该标记**同时留在终端缓冲里**，事后再用 shell_read（tail 或 since）也能看到 —— 所以“先异步启动、期间读增量、结束后回读退出码”是可行的，不必为了让调用阻塞而牺牲增量读。命令仍在跑时明确写“仍未确认结束”，不会假装成功。**含 {{v:…}} / {{m:…}} 展开的命令：安全形态下也会被包装并注入退出码标记；多行/后台/交互程序等不可包装时，wait.kind=exit 会在发送前拒绝。****⚠ 命令里不要写 `exit`** —— 它会结束 shell 本身（不是只结束这条命令），退出码标记就永远不会出现；需要“提前返回”请用子 shell `( … )` 或 `return`。每个任务**只做一个操作**（action.kind）：'
      + 'run = 执行一条命令；steps = 按步骤序列逐条输入/等待；retry = 重跑上一条命令（作用域＝本 shell 最近注入的那一条）。'
      + '默认最多等 30000ms（上限 24 小时；两分钟以上的命令请显式给 timeoutMs）；超时**不杀命令**，只如实回报“仍未确认结束”（要精确等结束用 wait.kind = exit，可带 code 与 timeoutMs）。'
      + '任务之间并行；同一个 shell 在一次调用里只能出现一次（重复出现会**整次调用被拒**并提示合并成一个任务）。'
      + '示例：steps: [{ send: "make -j8" }, { expect: { kind: "match", pattern: "ALL-DONE" } }]（send 会自动回车；keys 用 tmux 键名，如 Enter / C-c / Tab）。'
      + '常见流程（照抄即可）：\n'
      + '① 开：shell_open { tasks: [{ action: { kind:"open", label:"build", cwd:"/repo" } }] } → `session dsh-ab12cd (dsh-build) | 120x32 | cwd /repo (explicit) | idle=永久(未指定)`\n'
      + '② 跑并等结束：shell_run { tasks: [{ target:{sessions:"dsh-ab12cd"}, action:{kind:"run",command:"make -j8"}, wait:{kind:"exit",timeoutMs:180000}, output:{lines:40} }] } → `[dsh-ab12cd] ✅ 条件达成 exit · 0.0s` + 末尾 40 行；失败是 `❌ 等待超时 exit(0)` 或 `❌ exit code ≠ 期望`（run= 是本次命令的 id，可用于 read 的 wait.runId）\n'
      + '③ 异步跑 + 期间读增量：wait:{kind:"none"} → `[dsh-ab12cd] 已发送（未等待）—— 命令在后台继续运行 … 且 wait.runId="ab12cd34"`，调用立刻返回（run= 是该次运行的 id）；随后反复 shell_read { tasks: [{ target:{sessions:"dsh-ab12cd"}, action:{kind:"read", mode:"since"} }] } 取新增；结束后用 shell_read { tasks: [{ target:{sessions:"dsh-ab12cd"}, action:{kind:"read"}, wait:{kind:"exit", runId:"ab12cd34", timeoutMs:180000} }] } 取退出码（或读 tail 看到原始标记 `__DSH_EXIT_<nonce>__=N`）。不带 wait 时默认会等最多 30s 再回“未确认结束”\n'
      + '④ 关：shell_manage { tasks: [{ target:{sessions:"dsh-ab12cd"}, action:{kind:"close"} }] } → `[dsh-ab12cd] 已关闭`',
    parameters: {
      concurrency: {
        type: 'number',
        description: '并发度（默认 4，上限 8）：任务之间、任务内各会话之间的最大并行数。',
      },
      tasks: {
        type: 'array',
        required: true,
        description: tasksDoc(['target', 'action', 'wait', 'output', 'safety'], {
          text: 'action：操作 + 它自己的参数。kind 取值：\n'
            + 'run = 执行命令（配 command：要执行的命令；可用 {{v:键名}} 引用引用库的值）；\n'
            + 'steps = 步骤序列（配 steps：数组，每步 { label?, send?, expect?, timeoutMs? }；适合**短**交互流程，每步默认只等 15000ms —— 分钟级长任务请用 run + wait kind none 配 read 轮询。steps 走交互式输入、**不注入退出码标记**，要退出码请用 run；'
            + 'send = 要输入的内容（自动回车），expect = 等待条件（**只支持 idle / match / file / bell**；不含 timeoutMs / pollMs，这一步的超时用 timeoutMs；exit/noproc/cpu 请用 run + wait），'
            + 'timeoutMs = 这一步最多等多久（默认 15000，最小 200）；每步至少要给 send 或 expect）；\n'
            + 'retry = 重跑上一条命令（配 mode：last = 直接重跑；last-failed = 只有上一条失败时才重跑）。\n'
            + '其它操作没有的参数传进来会被拒绝。',
        }),
      },
    },
  },

  shell_send: {
    description: '默认只操作本对话创建的 shell；要操作其它对话创建的 shell，必须**用户明确要求**（unless the user explicitly asks）—— 判据是用户在消息里给出具体 shell id（如 dsh-ab12cd），只说“那个 shell”不算。像人一样向 shell 输入：先 preKeys，再 text，最后 keys。'
      + 'text 不会自动提交 —— 要执行命令必须给 keys: ["Enter"]。操作只有一种：action.kind = "send"。**只有 shell_run 注入的命令才有退出码标记**；用 send 手工敲的命令取不到退出码（需要码就自己 `echo $?`，或改用 shell_run）。',
    parameters: {
      concurrency: {
        type: 'number',
        description: '并发度（默认 4，上限 8）：任务之间、任务内各会话之间的最大并行数。',
      },
      tasks: {
        type: 'array',
        required: true,
        description: tasksDoc(['target', 'action', 'wait', 'output', 'safety'], {
          waitDoc: WAIT_SEND_DOC,
          outputDoc: OUTPUT_LINES_DOC + '；lines 也是**返回记录条数**（默认 50、最大 500，取最后 N 条；更早记录仍在链上，可调大 lines 或用 export 导出）。审计时间戳为 UTC（末尾 Z）。',
          text: 'action：操作 + 参数。kind = "send"（唯一操作），其参数：\n'
            + 'text = 要输入的文本（必填；不含回车）；\n'
            + 'keys = 文本之后要按的键（数组，如 ["Enter"]、["C-c"]；必须是 tmux 认识的键名）；\n'
            + 'preKeys = 文本之前要按的键（数组，常用于先 Ctrl-C 清场）。\n'
            + '要提交就给 keys: ["Enter"]（文本本身不会自动回车）。只发控制键（如 "C-c"）时，text 传空串 "" 即可。',
        }),
      },
    },
  },

  shell_read: {
    description: '默认只操作本对话创建的 shell；要操作其它对话创建的 shell，必须**用户明确要求**（unless the user explicitly asks）—— 判据是用户在消息里给出具体 shell id（如 dsh-ab12cd），只说“那个 shell”不算。只读取 shell 屏幕/历史，不向 shell 写入任何字符。省略 wait 时**立即返回当前内容**（不等任何条件）；加了 wait 才等。每个任务做一个操作（action.kind）：'
      + 'read = 读取屏幕/历史；subscribe = 订阅这些 shell 的新输出（每轮工具调用结束自动附上（只是“搭车”：不会主动唤醒，长任务仍需在下一轮调用里读；不必反复轮询）；'
      + '只把新输出附在**下一次工具调用**的结果后面（不会主动唤醒；长任务期间请用 since 轮询或 wait.match）；注入按行数/字符预算截断并标注，预算**只能改设置页、不开放给工具调用**，默认 watchMinLines=0 / watchMaxLines=120 / watchMaxChars=12000 / watchTotalChars=24000）；'
      + 'unsubscribe = 取消订阅。'
      + '**订阅只适合行式输出**（命令、编译、日志、进度）；'
      + '**top / htop / vim 这类全屏 TUI 不要订阅** —— 它们持续重绘，订阅只会得到光标噪音；'
      + '看这类程序用 kind=read 读当前屏幕。',
    parameters: {
      concurrency: {
        type: 'number',
        description: '并发度（默认 4，上限 8）：任务之间、任务内各会话之间的最大并行数。',
      },
      tasks: {
        type: 'array',
        required: true,
        description: tasksDoc(['target', 'action', 'wait', 'output'], {
          waitDoc: WAIT_READ_DOC,
          outputDoc: OUTPUT_LINES_DOC,
          text: 'action：操作 + 参数。kind 取值：\n'
            + 'read = 读取（读取形状用 mode，不用 output.showing —— showing 只属于 shell_run；参数：search = 正则（JS 方言、区分大小写）；context = 命中前后各取几行（默认 0）；'
            + 'matchOffset = 搜索分页：跳过前 N 个命中（默认 0，续翻用返回里的 `matchOffset=K`）；'
            + '搜索返回会写清「共 N 处，本页 M 处，从第 K 条起」，不用猜是否被截断；'
            + 'mode = 读哪里 —— tail 末尾（默认）/ screen 当前可见屏 / history 历史缓冲 / '
            + 'since 自上次读以来（**不受 output.lines 限制**，但有 2000 行硬上限：超出时保留最后 2000 行并标注丢了多少）/ diff 与上次相比 / summary 摘要（读取基线 = 该 shell 最近一次被读走的**当前屏面 + 可读滚动区**；滚出历史缓冲的内容不会补发；**任何读屏动作都会推进它**：read 的任意 mode、shell_run/shell_send 的等待与返回、订阅注入。所以 run(wait:none) 之后用 since 读到的是“启动之后”的全部新输出；如果命令刚启动还没输出，第一次 since 会返回「无新输出」，稍等再读即可 —— 不建议用 tail 兜底，那会重复旧内容）；'
            + 'ifChanged = true 时只有屏幕变化才返回内容）；\n'
            + 'subscribe = 订阅这些 shell 的新输出（无参数；不要用 TUI 程序）；\n'
            + 'unsubscribe = 取消订阅（无参数）。\n'
            + 'watch / unwatch 只用 target，不接受 read 的参数。',
        }),
      },
    },
  },

  shell_manage: {
    description: '管理 shell 的生命周期与插件内资源。默认只操作本对话创建的 shell；要操作其它对话创建的 shell，必须**用户明确要求**（unless the user explicitly asks）—— 判据是用户在消息里给出具体 shell id（如 dsh-ab12cd），只说“那个 shell”不算。'
      + 'action.kind 就是动作名，每个动作只接受它自己需要的参数。',
    parameters: {
      concurrency: {
        type: 'number',
        description: '并发度（默认 4，上限 8）：任务之间、任务内各会话之间的最大并行数。',
      },
      tasks: {
        type: 'array',
        required: true,
        description: tasksDoc(['target', 'action', 'safety'], {
          safetyDoc: 'safety：本工具只支持 dryrun（预演破坏性动作：close / reap / macro-rm / workspace-delete 返回“会做什么”，不执行）。传 confirm / lock / reason / force 会被拒绝（它们对生命周期管理没有意义）。',
          text: 'action：操作 + 参数。kind 取值（括号里是该操作自己的参数）：\n'
            + 'rename（newName = 新显示名）· resize（cols / rows = 新宽高）· respawn（无参数，重建窗格）· '
            + 'close（无参数，关闭会话；前台还在跑的命令会一起结束、不可恢复，但会话会留快照，可用 shell_open.from 复活屏面与历史）· reap（无参数，清理僵尸会话：DSH 早已丢失、记录还留在列表里的 shell）· idle（idleMinutes = 闲置多少分钟自动关闭，0 = 永不自动关闭）· '
            + 'snapshot（无参数；按会话 id 存，复活时把这个 id 填进 shell_open.from。**close / 空闲回收 / resize / rename 也会自动留快照**，reason 字段会注明；想更保险可先手动 snapshot）· snapshot-list（无参数，列出已有快照的会话 id / cwd / 时间；复活时把 id 填进 shell_open.from）· doctor（note = 备注，自检）· '
            + 'macro-set（name = 宏名，text = 宏内容，scope = global / conversation / shell，submit = 展开后是否自动回车，note = 备注；**展开方式：在 shell_run 的命令里写 {{m:宏名}}** —— 直接把宏名当命令敲不会执行）· '
            + 'macro-rm（name）· macro-list（无参数）· vault-list（无参数，只列键名不显示值）· '
            + 'macro-history（name，days = 回看天数）· macro-restore（name，at = 要还原的历史时间戳）· '
            + 'workspace-save（name）· workspace-list（无参数）· workspace-restore（name；**会新开 shell**，不是原地恢复）· workspace-delete（name）。\n'
            + '没有 lock / unlock / claim / release：锁只能由人在面板操作。\n'
            + '本工具不接受 wait / output 块；safety 只支持 dryrun（预演破坏性动作：close / reap / macro-rm / workspace-delete 会返回“会做什么”，不真做）。',
        }),
      },
    },
  },

  shell_state: {
    description: '查看所有 shell 的状态与归属（只读）。查到的 shell 里可能有别的对话创建的：除非用户明确要求，不要对它们执行操作（unless the user explicitly asks）。所有参数都是**过滤条件**（多个参数之间取交集；'
      + '同一个参数内逗号分隔的值取并集）；不带参数时只看本对话创建的 shell。'
      + '想看全部必须显式传 scope: "*"。不设显示上限 —— 想少看就自己加过滤。'
      + '可用字段：scope（mine / *）、sessions（id 或逗号分隔）、label（子串）、fg（前台命令子串）、cwd（子串）、state（idle / busy / user-busy / ai-busy / locked / unlocked / attached）、owner（mine / others / panel / unknown）、withGit、verbose。'
      + '返回：每行一个 shell，形如 `id=dsh-ab12cd  label=build  120x32  fg=make  attached=no  buffer=1200/100000  owner=... 归属=... 锁=... 写=...`，末尾附归属说明。id 就是填进 `tasks[].target.sessions` 的值（与 workspace 功能无关）。',
    parameters: {
      scope: {
        type: 'string',
        description: '范围：「mine」= 本对话创建的（默认）；「*」= 全部存活 shell（看全部必须显式写它）。',
      },
      sessions: { type: 'string', description: '按稳定 id 过滤：单个 id 或逗号分隔列表（与 scope 取交集）。' },
      label: { type: 'string', description: '按显示名子串过滤（忽略大小写）。' },
      fg: { type: 'string', description: '按前台命令子串过滤（如 fg="vim" 只看正在跑 vim 的壳）。' },
      cwd: { type: 'string', description: '按工作目录子串过滤。' },
      state: {
        type: 'string',
        description: '按状态过滤（逗号分隔 = 其中任一命中）：'
          + 'idle = 空闲（前台是 shell 且窗格安静）；'
          + 'busy = 忙碌（非空闲）；'
          + 'user-busy = 人正在操作（AI 写入会被拒）；'
          + 'ai-busy = 本对话正在操作；'
          + 'locked = 已锁定（手动锁或他人占用）；'
          + 'unlocked = 未锁定；'
          + 'attached = 有客户端附着（面板/终端已连上）。',
      },
      owner: {
        type: 'string',
        description: '按创建者过滤（逗号分隔 = 其中任一）：mine = 本对话；others = 别的对话；panel = 人在面板创建；unknown = 未登记。',
      },
      withGit: { type: 'boolean', description: 'true 时每行附带 git 分支（对每个 shell 的 cwd 跑一次 git，尽力而为）。' },
      verbose: { type: 'boolean', description: 'true 时追加诊断尾（服务端/宿主/看门狗/配置/审批/浏览器面闸门）与常用参数。' },
    },
  },

  shell_audit: {
    description: '读审计哈希链（每天一个文件：`<数据目录>/audit/audit-YYYY-MM-DD.jsonl`，默认看最近 1 天；target.sessions 可按 shell 过滤（不传 = 只看本对话创建的 shell；看全部传 target.sessions: "*"））：工具调用、每次送进 shell 的输入、会话生命周期、'
      + '设置变更、授权决定、宏写入等都在里面。操作只有一种：action.kind = "audit"。',
    parameters: {
      concurrency: { type: 'number', description: '并发度（默认 4，上限 8）。' },
      tasks: {
        type: 'array',
        required: true,
        description: tasksDoc(['target', 'action', 'output'], {
          outputDoc: OUTPUT_LINES_DOC,
          text: 'action：操作 + 参数。kind = "audit"（唯一操作），其参数：\n'
            + 'actor = 按操作者过滤（如 "panel"、具体会话 id）；\n'
            + 'source = 按来源过滤（tool / panel / host / cli）；\n'
            + 'days = 回看最近几天（默认 1）；\n'
            + 'export = true 时导出原始 JSONL（配合 days；最多 output.lines 条，完整文件路径见返回）。',
        }),
      },
    },
  },
}

/** 供门禁核对：所有枚举参数及其取值（逐个值必须在文档里出现）。 */
export const ENUM_FACTS = {
  'shell_run.wait.kind': ['none', 'idle', 'bell', 'match', 'exit', 'file', 'noproc', 'cpu'],
  'shell_read.wait.kind': ['idle', 'bell', 'match', 'exit', 'foreground'],
  'shell_read.action.kind': ['read', 'subscribe', 'unsubscribe'],
  'shell_read.read.mode': ['tail', 'screen', 'history', 'since', 'diff', 'summary'],
  'output.showing': ['tail', 'screen', 'diff', 'since', 'summary'],
  'safety.lock': ['require', 'ignore'],
  'target.sessions': ['mine', '*'],
  'shell_state.state': ['idle', 'busy', 'user-busy', 'ai-busy', 'locked', 'unlocked', 'attached'],
  'shell_state.owner': ['mine', 'others', 'panel', 'unknown'],
  'shell_run.retry.mode': ['last', 'last-failed'],
  'shell_run.action.kind': ['run', 'steps', 'retry'],
  'shell_send.action.kind': ['send'],
  'shell_manage.action.kind': ['rename', 'resize', 'respawn', 'close', 'reap', 'idle', 'snapshot', 'doctor',
    'macro-set', 'macro-rm', 'macro-list', 'vault-list', 'macro-history', 'macro-restore',
    'workspace-save', 'workspace-list', 'workspace-restore', 'workspace-delete'],
}
