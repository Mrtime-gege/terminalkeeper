/**
 * 参数定义表 —— **单一事实源**（2026-10-24 起）。
 *
 * 为什么要有这个文件：盲测反复暴露同一类问题 —— 参数的含义、单位、默认值散落在
 * 代码、工具说明、参数手册三处，改一处漏两处，于是「文档说 30s、代码是 3s」「一个
 * offset 两种含义」这类矛盾反复出现。现在：
 *
 *   1. **先定义**：每个参数的类型 / 单位 / 默认值 / 范围 / 必填 / 作用域 / 含义写在这里；
 *   2. 代码与文档都引用它（`scripts/gen-param-doc.mjs` 生成 `docs/参数定义.md`）；
 *   3. `scripts/test-param-spec.mjs` 反向核对：代码里接受的参数必须在这里有定义，
 *      这里定义的参数也必须在代码里真的被接受（防止“写了但没实现”）。
 *
 * 约定：
 *   - `type`：string / number / boolean / array / object / enum
 *   - `unit`：只对数字有意义（ms / 行 / 字符 / 个 / 分钟 / 天 / px）
 *   - `default`：`undefined` 表示“必填/无默认”；字符串原样展示
 *   - `range`：[min, max] 或枚举数组（与 type=enum 搭配）
 *   - `where`：这条定义适用于哪些位置（tool / block / action / filter）
 */

/** 通用：任务数组与并发。 */
const TOOL = {
  tasks: {
    type: 'array',
    unit: '个',
    default: undefined,
    range: [1, 16],
    required: true,
    where: 'tool',
    meaning: '一次调用里的任务列表；任务之间并行执行，同一 shell 在一次调用里只能出现一次。',
    note: '超过 16 个直接拒绝；重复出现同一个 shell 会整次调用被拒。',
  },
  concurrency: {
    type: 'number',
    unit: '个',
    default: 4,
    range: [1, 8],
    required: false,
    where: 'tool',
    meaning: '任务之间、任务内各会话之间的最大并行数。',
    note: '超过上限夹到 8；1 = 完全串行。',
  },
}

/** target 块：唯一的字段是 sessions。 */
const TARGET = {
  sessions: {
    type: 'string',
    unit: '',
    default: 'mine',
    range: ['mine', '*', '逗号分隔的 shell id'],
    required: false,
    where: 'block:target',
    meaning: '操作目标：mine = 本对话创建的**全部** shell（默认；只有一个会话时即该会话，多个时必须用 id 精确指定）；* = 全部存活 shell；或显式 id（如 dsh-ab12cd,dsh-cd34）。',
    note: '同一个 shell 在一次调用里只能出现在一个任务中。',
  },
}

/** wait 块：条件 + 通用超时/轮询。 */
const WAIT = {
  kind: {
    type: 'enum',
    unit: '',
    default: 'idle',
    range: ['none', 'idle', 'bell', 'match', 'exit', 'file', 'noproc', 'cpu', 'foreground'],
    required: false,
    where: 'block:wait',
    meaning: '等待条件：none = 立即返回（异步启动）；idle = 等回到空闲/提示符；bell = 等响铃；match = 新输出匹配正则；exit = 命令结束（可校验退出码）；file = 文件出现；noproc = 进程消失；cpu = 前台进程 CPU 低于阈值；foreground = 前台变成指定进程。',
    note: 'shell_run 支持 none/idle/bell/match/exit/file/noproc/cpu；shell_read 支持 idle/bell/match/exit/foreground；shell_send 只有 pollMs。',
  },
  timeoutMs: {
    type: 'number',
    unit: 'ms',
    default: 30000,
    range: [0, 86400000],
    required: false,
    where: 'block:wait',
    meaning: '等待条件最多等多久；超时只回报“超时”，不杀进程。',
    note: '上限 24 小时；两分钟以上的命令请显式给值。shell_run / shell_read 支持。',
  },
  pollMs: {
    type: 'number',
    unit: 'ms',
    default: 150,
    range: [20, 100000],
    required: false,
    where: 'block:wait',
    meaning: '轮询间隔（shell_run 检查条件、shell_send 等屏幕稳定的间隔）。',
    note: 'shell_run / shell_send 支持；shell_read 不支持。',
  },
  code: {
    type: 'number',
    unit: '退出码',
    default: undefined,
    range: [0, 255],
    required: false,
    where: 'block:wait',
    meaning: 'kind=exit 时同时校验退出码；不符会立即回报 `exit=N ≠ 期望`。',
    note: '仅 kind=exit 有意义。',
  },
  runId: {
    type: 'string',
    unit: '',
    default: undefined,
    range: 'shell_run 返回的 run=<id>',
    required: false,
    where: 'block:wait',
    meaning: 'kind=exit 时绑定到某一次具体的 shell_run（多命令先后跑时不会认错退出码）。',
    note: '仅 shell_read 支持；不传则绑定本 shell 最近一次 shell_run。',
  },
  pattern: {
    type: 'string',
    unit: '',
    default: undefined,
    range: 'JS 正则',
    required: false,
    where: 'block:wait',
    meaning: 'kind=match 时要匹配的正则（区分大小写，只匹配等待开始后新出现的输出）。',
    note: '仅 kind=match；正则非法会直接拒绝。',
  },
  path: {
    type: 'string',
    unit: '',
    default: undefined,
    range: '文件路径（支持 ~）',
    required: false,
    where: 'block:wait',
    meaning: 'kind=file 时要等的文件。',
    note: '仅 kind=file。',
  },
  proc: {
    type: 'string',
    unit: '',
    default: undefined,
    range: '进程名',
    required: false,
    where: 'block:wait',
    meaning: 'kind=noproc 等该进程从窗格进程树消失；kind=foreground 等前台变成该进程。',
    note: 'noproc 仅 shell_run；foreground 仅 shell_read。',
  },
  threshold: {
    type: 'number',
    unit: '%',
    default: undefined,
    range: [0, 100],
    required: false,
    where: 'block:wait',
    meaning: 'kind=cpu 时前台进程 CPU 占用低于该阈值即到达。',
    note: '仅 shell_run。',
  },
}

/** output 块。 */
const OUTPUT = {
  lines: {
    type: 'number',
    unit: '行',
    default: 20,
    range: [0, 2000],
    required: false,
    where: 'block:output',
    meaning: '返回多少行；tail 保留**最后** N 行；since 的新增超过 2000 行会保留最后 2000 行并标注丢弃量。',
    note: '上限 2000；history 模式另有更大的读法。',
  },
  showing: {
    type: 'enum',
    unit: '',
    default: 'tail',
    range: ['tail', 'screen', 'diff', 'summary'],
    required: false,
    where: 'block:output',
    meaning: '返回形状：tail 末尾 / screen 当前可见屏 / diff 与上次读取相比 / summary 末尾若干行并标注总行数。',
    note: '仅 shell_run 支持；shell_read 用 action.mode。',
  },
  structured: {
    type: 'boolean',
    unit: '',
    default: true,
    range: [true, false],
    required: false,
    where: 'block:output',
    meaning: 'true = 按块结构化返回（汇总头 + 每任务一段）；false = 一段纯文本。',
    note: '仅 shell_run。',
  },
}

/** safety 块。 */
const SAFETY = {
  bypassGuard: {
    type: 'boolean',
    unit: '',
    default: false,
    range: [true, false],
    required: false,
    where: 'block:safety',
    meaning: '跳过危险命令守卫（必须同时给非空 reason；审计记 bypass-guard）。',
    note: '只在用户明确要求时用；无 reason 会被拒绝。shell_run / shell_send 支持。',
  },
  dryrun: {
    type: 'boolean',
    unit: '',
    default: false,
    range: [true, false],
    required: false,
    where: 'block:safety',
    meaning: '只回报将要执行什么，不真正执行。',
    note: 'shell_run / shell_send / shell_manage（仅破坏性动作）支持。',
  },
  lock: {
    type: 'enum',
    unit: '',
    default: 'require',
    range: ['require', 'ignore'],
    required: false,
    where: 'block:safety',
    meaning: 'require = 同一 shell 的写操作串行（默认，无单独超时）；ignore = 不等待会话锁。',
    note: '人工锁定与它无关：被人工锁定的 shell 会立刻 REFUSED。',
  },
  reason: {
    type: 'string',
    unit: '',
    default: '',
    range: '任意文本',
    required: false,
    where: 'block:safety',
    meaning: '写进审计的原因（bypassGuard 时必填）。',
    note: '会进审计记录。',
  },
  force: {
    type: 'boolean',
    unit: '',
    default: false,
    range: [true, false],
    required: false,
    where: 'block:safety',
    meaning: '引用库未解密时是否强制继续（口令加密的组仍会被拒绝）。',
    note: '只影响引用展开路径。',
  },
}

/** action：每个工具每个 kind 的参数。 */
const ACTIONS = {
  shell_open: {
    open: {
      count: {
        type: 'number', unit: '个', default: 1, range: [1, 64], required: false, where: 'action:shell_open.open',
        meaning: '一次创建几个 shell（预检：现有 + count 超上限就整批拒绝）。',
        note: '任务内部并发创建，上限默认 8（设置项 maxSessions）。',
      },
      cwd: {
        type: 'string', unit: '', default: '继承部署配置', range: '目录路径', required: false, where: 'action:shell_open.open',
        meaning: '起始工作目录；省略则继承部署配置（有对话信息时用对话目录）。',
      },
      label: {
        type: 'string', unit: '', default: '', range: '≤32 字符', required: false, where: 'action:shell_open.open',
        meaning: '会话命名基名，同时是面板显示名。',
        note: '任务级 label 是分块名，两者不同。',
      },
      cols: {
        type: 'number', unit: '列', default: 120, range: [20, 1000], required: false, where: 'action:shell_open.open',
        meaning: '初始列数（tmux 宽度）。',
      },
      rows: {
        type: 'number', unit: '行', default: 32, range: [5, 500], required: false, where: 'action:shell_open.open',
        meaning: '初始行数（tmux 高度）。',
      },
      idleMinutes: {
        type: 'number', unit: '分钟', default: 0, range: [0, 1440], required: false, where: 'action:shell_open.open',
        meaning: '闲置多少分钟自动关闭；0 = 永不自动关闭；省略 = 跟随全局设置（总开关关时永不回收，开启时按 idleCloseMinutes 兜底）。',
        note: '闲置 = 无输入且前台无命令；只读屏不算活动。',
      },
      watch: {
        type: 'boolean', unit: '', default: false, range: [true, false], required: false, where: 'action:shell_open.open',
        meaning: '创建后顺便订阅新输出（等价于再调一次 shell_read 的 subscribe；重复订阅幂等）。',
        note: 'TUI 程序不要订阅。',
      },
      from: {
        type: 'string', unit: '', default: '', range: '旧会话 id', required: false, where: 'action:shell_open.open',
        meaning: '从快照复活：传旧会话 id（取该会话最近一次快照）。',
        note: 'close / 空闲回收 / resize / rename 会自动留快照。',
      },
    },
  },
  shell_run: {
    run: {
      command: {
        type: 'string', unit: '', default: undefined, range: '任意命令', required: true, where: 'action:shell_run.run',
        meaning: '要执行的命令；可用 {{v:键名}} 引用引用库的值。',
        note: '命令会被包装以注入退出码标记；不可包装的命令在 wait=exit 时发送前拒绝。',
      },
    },
    steps: {
      steps: {
        type: 'array', unit: '步', default: undefined, range: [1, 50], required: true, where: 'action:shell_run.steps',
        meaning: '步骤序列：每步 { label?, send?, expect?, timeoutMs? }；send 自动回车，expect 是等待条件。',
        note: '适合短交互流程；steps 不注入退出码标记。',
      },
    },
    retry: {
      mode: {
        type: 'enum', unit: '', default: undefined, range: ['last', 'last-failed'], required: true, where: 'action:shell_run.retry',
        meaning: 'last = 直接重跑本 shell 最近一条命令；last-failed = 只有上一条失败时才重跑。',
      },
    },
  },
  shell_send: {
    send: {
      text: {
        type: 'string', unit: '', default: undefined, range: '不含换行', required: true, where: 'action:shell_send.send',
        meaning: '要输入的文本；不含回车（提交要另外给 keys:["Enter"]）。只发控制键时传空串 ""。',
        note: '含 \\n / \\r 会被拒绝（会被终端当成提交）。',
      },
      keys: {
        type: 'array', unit: '', default: [], range: 'tmux 键名数组', required: false, where: 'action:shell_send.send',
        meaning: '文本之后要按的键，如 ["Enter"]、["C-c"]、["Tab"]。',
        note: '只有 shell_run 注入的命令才有退出码标记。',
      },
      preKeys: {
        type: 'array', unit: '', default: [], range: 'tmux 键名数组', required: false, where: 'action:shell_send.send',
        meaning: '文本之前要按的键，常用于先 Ctrl-C 清场。',
      },
    },
  },
  shell_read: {
    read: {
      search: {
        type: 'string', unit: '', default: undefined, range: 'JS 正则', required: false, where: 'action:shell_read.read',
        meaning: '在缓冲里搜索（区分大小写）；命中返回「共 N 处，本页 M 处，从第 K 条起」。',
        note: '给 search 时忽略 mode。',
      },
      context: {
        type: 'number', unit: '行', default: 0, range: [0, 8], required: false, where: 'action:shell_read.read',
        meaning: '搜索命中行前后各取几行上下文。',
      },
      matchOffset: {
        type: 'number', unit: '条', default: 0, range: [0, 100000], required: false, where: 'action:shell_read.read',
        meaning: '搜索分页：跳过前 N 个命中；续翻用返回里的 `matchOffset=K`。',
      },
      mode: {
        type: 'enum', unit: '', default: 'tail', range: ['tail', 'screen', 'history', 'since', 'diff', 'summary'], required: false, where: 'action:shell_read.read',
        meaning: '读哪里：tail 末尾 / screen 当前可见屏 / history 历史缓冲 / since 自上次读以来 / diff 与上次相比 / summary 摘要。',
        note: '读取形状用 mode，不用 output.showing。',
      },
      ifChanged: {
        type: 'boolean', unit: '', default: false, range: [true, false], required: false, where: 'action:shell_read.read',
        meaning: 'true 时只有屏幕变化才返回内容（没变化只回 unchanged）。',
      },
    },
    subscribe: {},
    unsubscribe: {},
  },
  shell_manage: {
    rename: {
      newName: {
        type: 'string', unit: '', default: undefined, range: '≤32 字符', required: true, where: 'action:shell_manage.rename',
        meaning: '新的显示名。',
      },
    },
    resize: {
      cols: {
        type: 'number', unit: '列', default: '保持当前', range: [20, 1000], required: false, where: 'action:shell_manage.resize',
        meaning: '新列数（不传则保持）。',
      },
      rows: {
        type: 'number', unit: '行', default: '保持当前', range: [5, 500], required: false, where: 'action:shell_manage.resize',
        meaning: '新行数（不传则保持）。',
      },
    },
    respawn: {},
    close: {},
    reap: {},
    idle: {
      idleMinutes: {
        type: 'number', unit: '分钟', default: 0, range: [0, 1440], required: false, where: 'action:shell_manage.idle',
        meaning: '闲置多少分钟自动关闭；0 = 永不自动关闭。',
      },
    },
    snapshot: {},
    'snapshot-list': {},
    doctor: {
      note: {
        type: 'string', unit: '', default: '', range: '任意文本', required: false, where: 'action:shell_manage.doctor',
        meaning: '自检备注（写进审计）。',
      },
    },
    'macro-set': {
      name: { type: 'string', unit: '', default: undefined, range: '≤64 字符', required: true, where: 'action:shell_manage.macro-set', meaning: '宏名。' },
      text: { type: 'string', unit: '', default: undefined, range: '任意文本', required: true, where: 'action:shell_manage.macro-set', meaning: '宏内容（命令片段）。' },
      scope: { type: 'enum', unit: '', default: 'conversation', range: ['global', 'conversation', 'shell'], required: false, where: 'action:shell_manage.macro-set', meaning: '宏的可见范围。' },
      submit: { type: 'boolean', unit: '', default: true, range: [true, false], required: false, where: 'action:shell_manage.macro-set', meaning: '展开后是否自动回车。' },
      note: { type: 'string', unit: '', default: '', range: '任意文本', required: false, where: 'action:shell_manage.macro-set', meaning: '备注（写进审计）。' },
    },
    'macro-rm': {
      name: { type: 'string', unit: '', default: undefined, range: '宏名', required: true, where: 'action:shell_manage.macro-rm', meaning: '要删除的宏名。' },
    },
    'macro-list': {},
    'vault-list': {},
    'macro-history': {
      name: { type: 'string', unit: '', default: undefined, range: '宏名', required: true, where: 'action:shell_manage.macro-history', meaning: '要回看历史的宏名。' },
      days: { type: 'number', unit: '天', default: 7, range: [1, 3650], required: false, where: 'action:shell_manage.macro-history', meaning: '回看最近几天。' },
    },
    'macro-restore': {
      name: { type: 'string', unit: '', default: undefined, range: '宏名', required: true, where: 'action:shell_manage.macro-restore', meaning: '要还原的宏名。' },
      at: { type: 'number', unit: 'ms（epoch）', default: undefined, range: '历史时间戳', required: true, where: 'action:shell_manage.macro-restore', meaning: '要还原到的历史时间戳（用 macro-history 查）。' },
    },
    'workspace-save': {
      name: { type: 'string', unit: '', default: undefined, range: '≤64 字符', required: true, where: 'action:shell_manage.workspace-save', meaning: '工作区名。' },
    },
    'workspace-list': {},
    'workspace-restore': {
      name: { type: 'string', unit: '', default: undefined, range: '工作区名', required: true, where: 'action:shell_manage.workspace-restore', meaning: '要恢复的工作区名（会新开 shell，不是原地恢复）。' },
    },
    'workspace-delete': {
      name: { type: 'string', unit: '', default: undefined, range: '工作区名', required: true, where: 'action:shell_manage.workspace-delete', meaning: '要删除的工作区名。' },
    },
  },
  shell_audit: {
    audit: {
      actor: { type: 'string', unit: '', default: '', range: '操作者 id 或 panel', required: false, where: 'action:shell_audit.audit', meaning: '按操作者过滤。' },
      source: { type: 'enum', unit: '', default: '', range: ['tool', 'panel', 'host', 'cli'], required: false, where: 'action:shell_audit.audit', meaning: '按来源过滤。' },
      days: { type: 'number', unit: '天', default: 1, range: [1, 3650], required: false, where: 'action:shell_audit.audit', meaning: '回看最近几天。' },
      export: { type: 'boolean', unit: '', default: false, range: [true, false], required: false, where: 'action:shell_audit.audit', meaning: '导出原始 JSONL（配合 days；最多 output.lines 条）。' },
    },
  },
}

/** shell_state 的扁平过滤条件（没有 tasks/action）。 */
const STATE_FILTERS = {
  scope: { type: 'enum', unit: '', default: 'mine', range: ['mine', '*'], required: false, where: 'filter:shell_state', meaning: 'mine = 本对话创建的（默认）；* = 全部存活 shell（必须显式传）。' },
  sessions: { type: 'string', unit: '', default: '', range: 'id 或逗号分隔', required: false, where: 'filter:shell_state', meaning: '按 shell id 过滤。' },
  label: { type: 'string', unit: '', default: '', range: '子串', required: false, where: 'filter:shell_state', meaning: '按显示名子串过滤。' },
  fg: { type: 'string', unit: '', default: '', range: '子串', required: false, where: 'filter:shell_state', meaning: '按前台命令子串过滤。' },
  cwd: { type: 'string', unit: '', default: '', range: '子串', required: false, where: 'filter:shell_state', meaning: '按工作目录子串过滤。' },
  state: { type: 'enum', unit: '', default: '', range: ['idle', 'busy', 'user-busy', 'ai-busy', 'locked', 'unlocked', 'attached'], required: false, where: 'filter:shell_state', meaning: '按状态过滤（逗号分隔可多选，取并集）。' },
  owner: { type: 'enum', unit: '', default: '', range: ['mine', 'others', 'panel', 'unknown'], required: false, where: 'filter:shell_state', meaning: '按创建者过滤。' },
  withGit: { type: 'boolean', unit: '', default: false, range: [true, false], required: false, where: 'filter:shell_state', meaning: '附带 git 分支（每行一次 git 调用）。' },
  verbose: { type: 'boolean', unit: '', default: false, range: [true, false], required: false, where: 'filter:shell_state', meaning: '附带诊断尾（服务端/宿主/看门狗/配置等）。' },
}

/** 对外导出：按「作用域 → 参数」组织的完整定义。 */
export const PARAM_SPEC = {
  tool: TOOL,
  target: TARGET,
  wait: WAIT,
  output: OUTPUT,
  safety: SAFETY,
  actions: ACTIONS,
  stateFilters: STATE_FILTERS,
}

/** 展平成 [{ scope, path, key, ...def }]，供测试与文档生成使用。 */
export function flattenSpec (spec = PARAM_SPEC) {
  const rows = []
  const push = (scope, path, table) => {
    for (const [key, def] of Object.entries(table ?? {})) rows.push({ scope, path, key, ...def })
  }
  push('tool', '', spec.tool)
  push('block', 'target', spec.target)
  push('block', 'wait', spec.wait)
  push('block', 'output', spec.output)
  push('block', 'safety', spec.safety)
  for (const [tool, kinds] of Object.entries(spec.actions)) {
    for (const [kind, table] of Object.entries(kinds)) {
      push('action', `${tool}.${kind}`, table)
    }
  }
  push('filter', 'shell_state', spec.stateFilters)
  return rows
}