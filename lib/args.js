/**
 * 工具参数规范 —— **操作是操作，参数是参数**。
 *
 * 核心约束（本轮重构的起因）：
 *   1. **不允许用参数里的特殊字符串编码操作**。例如旧的 `wait.for = "match:<正则>"`、
 *      `"exit:0"`、`"file:<路径>"` 把「做什么」和「参数」压进一个字符串 —— 这是老项目里
 *      最典型的参数腐化。现在一律写成 `wait: { kind: "match", pattern: "…" }`。
 *   2. **一个 kind 只认它自己的载荷**：`kind` 是操作，其余字段是参数；传别的 kind 的字段
 *      会被直接拒绝并指出"该字段属于哪个 kind"，而不是静默忽略。
 *   3. **每个工具的块白名单是硬的**：未列出的块、未列出的字段一律拒绝，错误里列出允许项。
 *   4. **参数只增不改不删**：语义变更 = 新增字段；废弃 = 保留解析并标注，不沉默改变行为。
 *
 * 解析是**纯函数**（可离线单测）；工具实现只读 IR（见 emptyIR 的形状）。
 */

/** 五类固定块。新增块必须所有工具同时支持（否则不许加）。 */
export const BLOCKS = ['target', 'action', 'wait', 'output', 'safety']

/**
 * 每个工具**实际消费**的块。未列出的块一旦传入就**直接拒绝**（不静默忽略）。
 *   shell_run / shell_send    → target / action / wait / output / safety
 *   shell_read                → target / action / wait / output
 *   shell_audit               → target / action / output
 *   shell_manage              → target / action
 *   shell_open                → action
 */
export const TOOL_BLOCKS = {
  shell_open: ['action'],
  shell_run: ['target', 'action', 'wait', 'output', 'safety'],
  shell_send: ['target', 'action', 'wait', 'output', 'safety'],
  shell_read: ['target', 'action', 'wait', 'output'],
  shell_manage: ['target', 'action', 'safety'],
  shell_audit: ['target', 'action', 'output'],
}

/** 并发模型：任务之间并行；任务内会话之间并行；同一会话的写操作由会话锁串行。 */
export const DEFAULT_CONCURRENCY = 4
export const MAX_CONCURRENCY = 8
export const MAX_TASKS = 16
export const MAX_UNITS = 32

/** target.sessions 的保留选择器。 */
export const SESSION_SELECTORS = new Set(['mine', '*'])

/**
 * 等待/预期条件的**操作表**：`kind` 是操作，`payload` 是它的参数。
 *
 * 注意：这里只列**实现里真的有分支**的 kind。`grep`（正则扫描）从未实现，
 * 旧的 `"grep:…"` 写法只在解析层被接受 —— 属于"看起来能用其实没用"，因此不再列入。
 */
export const WAIT_KINDS = {
  idle: { payload: {}, required: [], note: '等到屏幕稳定（默认）' },
  none: { payload: {}, required: [], note: '立即返回，不等命令结束（命令继续在后台跑）；这就是“异步启动”' },
  bell: { payload: {}, required: [], note: '等响铃（程序 printf 提示音 / 完成响铃）' },
  match: { payload: { pattern: 'string' }, required: ['pattern'], note: '新输出匹配正则' },
  exit: { payload: { code: 'number' }, required: [], note: '命令结束；给 code 时同时校验退出码 0–255' },
  file: { payload: { path: 'string' }, required: ['path'], note: '文件出现（路径支持 ~ 展开）' },
  noproc: { payload: { proc: 'string' }, required: ['proc'], note: '进程从窗格进程树消失' },
  cpu: { payload: { threshold: 'number' }, required: ['threshold'], note: '窗格前台进程 CPU 占用低于阈值（0–100）' },
  foreground: { payload: { proc: 'string' }, required: ['proc'], note: '前台命令变成指定进程（如 vim）' },
}

/** 每个工具支持的等待操作（不是每个工具都能等所有条件）。 */
export const WAIT_KIND_ALLOWED = {
  shell_run: ['none', 'idle', 'bell', 'match', 'exit', 'file', 'noproc', 'cpu'],
  // 2026-10-24：read 也支持 exit —— 对“已经异步启动”的命令等结束并取回退出码（盲测致命缺口）
  shell_read: ['idle', 'bell', 'match', 'exit', 'foreground'],
}

/** 所有 kind 的参数并集（用于白名单与"这个字段属于哪个 kind"的错误提示）。 */
const WAIT_PAYLOAD_FIELDS = new Set(Object.values(WAIT_KINDS).flatMap((spec) => Object.keys(spec.payload)))

/** 每个工具在 wait 块里还允许的通用字段（除 kind 与各 kind 载荷之外）。 */
export const WAIT_EXTRA_FIELDS = {
  shell_run: ['timeoutMs', 'pollMs'],
  shell_read: ['timeoutMs', 'runId'],
  shell_send: ['pollMs'],
}

/** output 块的字段白名单（按工具）。 */
export const OUTPUT_FIELDS = {
  shell_run: ['lines', 'showing', 'structured'],
  shell_send: ['lines'],
  shell_read: ['lines'],
  shell_audit: ['lines'],
}

/** safety 块的字段白名单（只有 shell_run / shell_send 有 safety 块）。 */
export const SAFETY_FIELDS = ['bypassGuard', 'dryrun', 'lock', 'reason', 'force']

export const SHOWINGS = new Set(['tail', 'screen', 'diff', 'since', 'summary'])
export const LOCKS = new Set(['require', 'ignore'])
export const READ_MODES = new Set(['tail', 'screen', 'history', 'since', 'diff', 'summary'])

/**
 * 每个工具的 **kind → 参数** 表。
 * kind 是**操作**（不可能用参数"暗示"某种操作）；payload 是这个操作自己的参数。
 */
export const ACTION_SPECS = {
  shell_open: {
    open: {
      payload: {
        count: 'number',       // 一次创建几个（1–64，默认 1）
        cwd: 'string',         // 起始目录（默认继承部署配置）
        label: 'string',       // 命名基名：生成 <label>-1…N；也是显示名
        cols: 'number',        // 初始列数（收敛到配置允许范围）
        rows: 'number',        // 初始行数
        idleMinutes: 'number', // 闲置自动关闭分钟数（0 = 永久）
        watch: 'boolean',      // 创建后顺便订阅新输出（TUI 不要订阅）
        from: 'string',        // 从快照复活：快照名（创建时使用）
      },
      required: [],
    },
  },
  shell_run: {
    run: {
      payload: { command: 'string' },
      required: ['command'],
    },
    steps: {
      payload: { steps: 'array' },
      required: ['steps'],
      validate: (payload) => validateSteps(payload.steps),
    },
    retry: {
      payload: { mode: 'string' },
      required: ['mode'],
      enums: { mode: ['last', 'last-failed'] },
    },
  },
  shell_send: {
    send: {
      payload: { text: 'string', keys: 'array', preKeys: 'array' },
      required: ['text'],
      validate: (payload) => {
        // 长测 P38：text 里的 \n/\r 会被 tmux 当成提交，导致“只发一段文本”实际执行多行命令。
        // 明确拒绝（而不是静默只消费第一行），多行请拆成多次 send 或用 shell_run steps。
        if (/[\r\n]/.test(String(payload.text ?? ''))) {
          fail('shell_send.action.text 不能包含换行/回车（会被终端当成提交，执行多行）；多行请拆成多次 send，或用 shell_run 的 steps')
        }
      },
    },
  },
  shell_read: {
    read: {
      payload: { search: 'string', context: 'number', matchOffset: 'number', mode: 'string', ifChanged: 'boolean' },
      required: [],
      enums: { mode: [...READ_MODES] },
    },
    // 动作名：subscribe / unsubscribe（watch 已删除 —— 不再考虑兼容，避免一名三用）
    subscribe: { payload: {}, required: [] },
    unsubscribe: { payload: {}, required: [] },
  },
  shell_manage: {
    rename: { payload: { newName: 'string' }, required: ['newName'] },
    resize: { payload: { cols: 'number', rows: 'number' }, required: [] },
    respawn: { payload: {}, required: [] },
    close: { payload: {}, required: [] },
    reap: { payload: {}, required: [] },
    idle: { payload: { idleMinutes: 'number' }, required: ['idleMinutes'] },
    snapshot: { payload: {}, required: [] },
    'snapshot-list': { payload: {}, required: [] },
    doctor: { payload: { note: 'string' }, required: [] },
    'macro-set': { payload: { name: 'string', text: 'string', scope: 'string', submit: 'boolean', note: 'string' }, required: ['name', 'text'] },
    'macro-rm': { payload: { name: 'string' }, required: ['name'] },
    'macro-list': { payload: {}, required: [] },
    'vault-list': { payload: {}, required: [] },
    'macro-history': { payload: { name: 'string', days: 'number' }, required: ['name'] },
    'macro-restore': { payload: { name: 'string', at: 'number' }, required: ['name', 'at'] },
    'workspace-save': { payload: { name: 'string' }, required: ['name'] },
    'workspace-list': { payload: {}, required: [] },
    'workspace-restore': { payload: { name: 'string' }, required: ['name'] },
    'workspace-delete': { payload: { name: 'string' }, required: ['name'] },
  },
  shell_audit: {
    audit: {
      payload: { actor: 'string', source: 'string', days: 'number', export: 'boolean' },
      required: [],
    },
  },
}

/** steps 数组里每一项的形状：send（要输入的内容）/ expect（等待条件，结构化）/ timeoutMs。 */
export const STEP_FIELDS = ['label', 'send', 'expect', 'timeoutMs']

function fail(message) {
  const error = new Error(message)
  error.argError = true
  throw error
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && Array.isArray(value) === false
}

/** 严格校验：出现未知字段直接拒绝 —— 参数不再变乱的第一道闸。 */
function rejectUnknown(where, raw, allowed) {
  const extra = Object.keys(raw).filter((key) => allowed.has(key) === false)
  if (extra.length > 0) {
    fail(`${where} 不认识的字段：${extra.join(', ')}。允许的字段：${[...allowed].join(', ') || '(无)'}`)
  }
}

function pickType(where, key, value, type) {
  if (value === undefined) return undefined
  if (type === 'string') {
    if (typeof value !== 'string') fail(`${where}.${key} 应为字符串`)
    return value
  }
  if (type === 'number') {
    if (typeof value !== 'number' || Number.isFinite(value) === false) fail(`${where}.${key} 应为数字`)
    return value
  }
  if (type === 'boolean') {
    if (typeof value !== 'boolean') fail(`${where}.${key} 应为布尔值（true / false）`)
    return value
  }
  if (type === 'array') {
    if (Array.isArray(value) === false) fail(`${where}.${key} 应为数组`)
    return value
  }
  fail(`${where}.${key} 的类型声明未知：${type}`)
}

/** target：唯一的目标选择入口。只认 sessions（"a,b" / "mine" / "*"，数组也行）。 */
export function parseTarget(raw) {
  if (raw === undefined || raw === null) return { sessions: 'mine' }
  if (isPlainObject(raw) === false) fail('target 应为对象，如 { sessions: "mine" }')
  rejectUnknown('target', raw, new Set(['sessions']))
  let sessions = raw.sessions ?? 'mine'
  if (Array.isArray(sessions)) {
    if (sessions.some((s) => typeof s !== 'string')) fail('target.sessions 数组元素必须是字符串')
    sessions = sessions.join(',')
  }
  if (typeof sessions !== 'string' || sessions.trim() === '') {
    fail('target.sessions 必须是非空字符串（"a,b" / "mine" / "*"）')
  }
  return { sessions: sessions.trim() }
}

/**
 * 等待条件（结构化）：`{ kind, ...该 kind 的参数 }`。
 * 绝不接受 "match:xxx" 这类把操作编码进字符串的写法。
 */
export function parseCondition(raw, where) {
  if (raw === undefined || raw === null) return { kind: 'idle' }
  if (isPlainObject(raw) === false) fail(`${where} 应为对象，如 { kind: "match", pattern: "done" }`)
  const kind = raw.kind === undefined ? 'idle' : raw.kind
  if (typeof kind !== 'string' || Object.prototype.hasOwnProperty.call(WAIT_KINDS, kind) === false) {
    fail(`${where}.kind 必须是：${Object.keys(WAIT_KINDS).join(' / ')}`)
  }
  const spec = WAIT_KINDS[kind]
  rejectUnknown(where, raw, new Set(['kind', ...Object.keys(spec.payload)]))
  const values = {}
  for (const [key, type] of Object.entries(spec.payload)) {
    const value = pickType(where, key, raw[key], type)
    if (value !== undefined) values[key] = value
  }
  for (const key of spec.required) {
    if (values[key] === undefined) fail(`${where}.${key} 在 kind=${kind} 时必填（${spec.note}）`)
  }
  if (kind === 'cpu' && values.threshold !== undefined && (values.threshold < 0 || values.threshold > 100)) {
    fail(`${where}.threshold 需要 0–100 的百分比`)
  }
  if (kind === 'exit' && values.code !== undefined && (Number.isInteger(values.code) === false || values.code < 0 || values.code > 255)) {
    fail(`${where}.code 需要 0–255 的退出码`)
  }
  return { kind, ...values }
}

/** wait 块：条件 + 超时/轮询。按工具白名单收字段。 */
export function parseWait(tool, raw) {
  const extra = WAIT_EXTRA_FIELDS[tool] ?? []
  if (raw === undefined || raw === null) {
    return { ...parseCondition(undefined, 'wait'), timeoutMs: 30000, pollMs: 150, explicit: false }
  }
  if (isPlainObject(raw) === false) fail('wait 应为对象，如 { kind: "match", pattern: "done", timeoutMs: 60000 }')
  // 白名单 = 本工具真正消费的字段：
  //   shell_run / shell_read 支持等待条件（kind + 各 kind 参数）；
  //   shell_send 只支持 pollMs（它是"投递后等屏幕稳定"，不是等待条件）。
  const allowsCondition = extra.includes('timeoutMs')
  const allowed = allowsCondition
    ? new Set(['kind', ...WAIT_PAYLOAD_FIELDS, ...extra])
    : new Set(extra)
  rejectUnknown('wait', raw, allowed)
  // 只允许当前工具支持的通用字段
  const conditionRaw = {}
  if (allowsCondition) {
    for (const key of ['kind', ...WAIT_PAYLOAD_FIELDS]) {
      if (raw[key] !== undefined) conditionRaw[key] = raw[key]
    }
  }
  if (allowsCondition) {
    const allowedKinds = WAIT_KIND_ALLOWED[tool] ?? Object.keys(WAIT_KINDS)
    if (conditionRaw.kind !== undefined && allowedKinds.includes(conditionRaw.kind) === false) {
      fail(`${tool} 的 wait.kind 只支持：${allowedKinds.join(' / ')}`)
    }
  }
  const condition = parseCondition(conditionRaw, 'wait')
  if (extra.includes('timeoutMs') === false && raw.timeoutMs !== undefined) {
    fail(`wait.timeoutMs 不适用于 ${tool}（该工具没有超时语义）`)
  }
  if (extra.includes('pollMs') === false && raw.pollMs !== undefined) {
    fail(`wait.pollMs 不适用于 ${tool}（该工具不支持轮询间隔）`)
  }
  // 上限 24h：长任务要显式给值，但不允许“传个天文数字把调用挂死”。
  const timeoutMs = extra.includes('timeoutMs')
    ? Math.min(86400000, Math.max(0, Math.floor(pickType('wait', 'timeoutMs', raw.timeoutMs, 'number') ?? 30000)))
    : 30000
  const pollMs = extra.includes('pollMs')
    ? Math.max(20, Math.floor(pickType('wait', 'pollMs', raw.pollMs, 'number') ?? 150))
    : 150
  // runId：把 exit 等待绑定到**某一次具体的** shell_run（多命令先后跑时不会认错）
  const runId = extra.includes('runId') && raw.runId !== undefined
    ? pickType('wait', 'runId', raw.runId, 'string')
    : ''
  if (runId !== '' && condition.kind !== 'exit') fail('wait.runId 只能与 kind="exit" 一起用')
  return { ...condition, timeoutMs, pollMs, runId: runId === '' ? undefined : runId, explicit: true }
}

/** output 块：只管输出形状，字段按工具白名单收。 */
export function parseOutput(tool, raw) {
  const fields = new Set(OUTPUT_FIELDS[tool] ?? [])
  if (raw === undefined || raw === null) {
    return { lines: 20, showing: 'since', structured: true }
  }
  if (isPlainObject(raw) === false) fail('output 应为对象，如 { lines: 40 }')
  rejectUnknown('output', raw, fields)
  // 上限 2000 行：再大的输出应该用 history / search，而不是把整屏塞回上下文（盲测 #4）。
  const lines = Math.min(2000, Math.max(0, Math.floor(pickType('output', 'lines', raw.lines, 'number') ?? 20)))
  let showing = 'since'
  if (fields.has('showing') && raw.showing !== undefined) {
    showing = pickType('output', 'showing', raw.showing, 'string')
    if (SHOWINGS.has(showing) === false) fail(`output.showing 必须是：${[...SHOWINGS].join(' / ')}`)
  }
  const structured = fields.has('structured') && raw.structured !== undefined
    ? pickType('output', 'structured', raw.structured, 'boolean')
    : true
  return { lines, showing, structured }
}

/** safety 块：授权/审计语义统一；reason 自动进审计。 */
export function parseSafety(tool, raw) {
  if (raw === undefined || raw === null) return { confirm: false, dryrun: false, lock: 'require', reason: '', force: false }
  if (isPlainObject(raw) === false) fail('safety 应为对象，如 { confirm: true }')
  // 每个工具只收它真正消费的 safety 字段：manage 只支持 dryrun（其余会静默无效，必须拒绝）。
  if (tool === 'shell_manage') {
    rejectUnknown('safety', raw, new Set(['dryrun']))
    return { confirm: false, dryrun: pickType('safety', 'dryrun', raw.dryrun ?? false, 'boolean'), lock: 'require', reason: '', force: false }
  }
  rejectUnknown('safety', raw, new Set(SAFETY_FIELDS))
  // confirm 已删除：它的字面意思与行为相反（true = 跳过守卫），只保留 bypassGuard（2026-10-24）
  const confirm = raw.bypassGuard === undefined ? false : pickType('safety', 'bypassGuard', raw.bypassGuard, 'boolean')
  const dryrun = raw.dryrun === undefined ? false : pickType('safety', 'dryrun', raw.dryrun, 'boolean')
  const lock = raw.lock === undefined ? 'require' : pickType('safety', 'lock', raw.lock, 'string')
  if (LOCKS.has(lock) === false) fail(`safety.lock 必须是：${[...LOCKS].join(' / ')}`)
  const reason = raw.reason === undefined ? '' : pickType('safety', 'reason', raw.reason, 'string')
  const force = raw.force === undefined ? false : pickType('safety', 'force', raw.force, 'boolean')
  // 长测 P16：confirm=true 是“调用方声称用户已批准”，审计必须能回答“谁批准/为什么”。
  // 没有 reason 的 confirm 直接拒绝，避免变成无凭证的静默放行。
  if (confirm === true && String(reason).trim() === '') {
    fail('safety.confirm=true 时必须同时给非空 safety.reason（会写进审计，说明谁批准/为什么）；否则请用 dryrun，或让用户操作')
  }
  return { confirm, dryrun, lock, reason, force }
}

/** steps 数组逐项校验：操作（send / expect）与参数分离，未知字段直接拒。 */
export function validateSteps(steps) {
  if (Array.isArray(steps) === false || steps.length === 0) {
    fail('action.steps 必须是非空数组（每一项一次输入或一次等待）')
  }
  if (steps.length > 32) fail(`action.steps 最多 32 步，收到 ${steps.length}`)
  return steps.map((step, index) => {
    const where = `action.steps[${index}]`
    if (isPlainObject(step) === false) fail(`${where} 应为对象`)
    rejectUnknown(where, step, new Set(STEP_FIELDS))
    if (step.send !== undefined) pickType(where, 'send', step.send, 'string')
    if (step.timeoutMs !== undefined) {
      const ms = pickType(where, 'timeoutMs', step.timeoutMs, 'number')
      if (ms < 200) fail(`${where}.timeoutMs 最小 200 毫秒`)
    }
    if (step.expect !== undefined) parseCondition(step.expect, `${where}.expect`)
    if (step.send === undefined && step.expect === undefined) {
      fail(`${where} 至少要给 send（输入）或 expect（等待条件）`)
    }
    return step
  })
}

/** action：kind 是操作，其余按该 kind 自己的参数表校验。 */
export function parseAction(tool, raw) {
  const kinds = ACTION_SPECS[tool]
  if (kinds === undefined) fail(`未知工具：${tool}`)
  if (isPlainObject(raw) === false) fail('action 应为对象，如 { kind: "run", command: "ls" }')
  const kind = raw.kind
  if (typeof kind !== 'string' || Object.prototype.hasOwnProperty.call(kinds, kind) === false) {
    fail(`${tool}.action.kind 必须是：${Object.keys(kinds).join(' / ')}`)
  }
  const spec = kinds[kind]
  rejectUnknown('action', raw, new Set(['kind', ...Object.keys(spec.payload)]))
  const payload = {}
  for (const [key, type] of Object.entries(spec.payload)) {
    const value = pickType('action', key, raw[key], type)
    if (value !== undefined) payload[key] = value
  }
  for (const key of spec.required) {
    if (payload[key] === undefined) fail(`${tool}.action.${key} 在 kind=${kind} 时必填`)
  }
  for (const [key, values] of Object.entries(spec.enums ?? {})) {
    if (payload[key] !== undefined && values.includes(payload[key]) === false) {
      fail(`${tool}.action.${key} 必须是：${values.join(' / ')}`)
    }
  }
  if (typeof spec.validate === 'function') spec.validate(payload)
  return { kind, ...payload }
}

/** 一个任务 = 该工具允许的块。 */
export function parseTask(tool, raw, index) {
  const where = `tasks[${index}]`
  if (isPlainObject(raw) === false) fail(`${where} 应为对象`)
  const blocks = new Set(TOOL_BLOCKS[tool] ?? BLOCKS)
  rejectUnknown(where, raw, new Set(['label', ...blocks]))
  const label = raw.label === undefined ? `任务${index + 1}` : pickType(where, 'label', raw.label, 'string')
  return {
    label,
    target: parseTarget(raw.target),
    action: parseAction(tool, raw.action),
    // 未列出的块也填默认值（包装读取时不会炸）；一旦**传入**，上面的 rejectUnknown 已拒绝。
    wait: parseWait(tool, blocks.has('wait') ? raw.wait : undefined),
    output: parseOutput(tool, blocks.has('output') ? raw.output : undefined),
    safety: parseSafety(tool, blocks.has('safety') ? raw.safety : undefined),
  }
}

/** 用户规则：单次调用里一个 shell 只能被操作一次（静态可见的部分在这里判）。 */
export function checkTasksDisjoint(tool, tasks) {
  const seen = new Map()
  for (let i = 0; i < tasks.length; i++) {
    const sel = String(tasks[i]?.target?.sessions ?? '')
    if (sel === '' || SESSION_SELECTORS.has(sel)) continue
    for (const id of sel.split(',').map((x) => x.trim()).filter((x) => x !== '')) {
      if (seen.has(id)) {
        fail(`${tool}：同一个 shell 在一次调用里只能被操作一次 —— ${id} 同时出现在任务 ${seen.get(id) + 1} 与任务 ${i + 1}（请合并成一个任务，或拆成两次调用）`)
      }
      seen.set(id, i)
    }
  }
}

/** IR：工具实现只读这个形状。 */
export function emptyIR(tool) {
  return { tool, concurrency: DEFAULT_CONCURRENCY, tasks: [] }
}

export function parseArgs(tool, raw) {
  if (isPlainObject(raw) === false) fail('参数应为对象')
  rejectUnknown('参数', raw, new Set(['tasks', 'concurrency']))
  const tasks = raw.tasks
  if (Array.isArray(tasks) === false || tasks.length === 0) fail('必须提供 tasks 数组（至少一个任务）')
  if (tasks.length > MAX_TASKS) fail(`任务数上限 ${MAX_TASKS}，收到 ${tasks.length}`)
  const ir = emptyIR(tool)
  if (raw.concurrency !== undefined) {
    ir.concurrency = Math.max(1, Math.min(MAX_CONCURRENCY, Math.floor(pickType('参数', 'concurrency', raw.concurrency, 'number'))))
  }
  ir.tasks = tasks.map((task, index) => parseTask(tool, task, index))
  return ir
}

/** 供调用方在把 target.sessions 解析成具体 id 之后复核上限。 */
export function checkUnits(units) {
  if (units.length > MAX_UNITS) {
    fail(`一次调用的执行单元上限 ${MAX_UNITS}，收到 ${units.length}（请拆成多次调用）`)
  }
  return units
}


/** 供文档/校验复用：把一个工具的 kind 表渲染成人话。 */
export function describeSpec(tool) {
  const kinds = ACTION_SPECS[tool] ?? {}
  return Object.entries(kinds)
    .map(([kind, spec]) => {
      const payload = Object.keys(spec.payload)
      return `${kind}${payload.length > 0 ? '（' + payload.join(', ') + '）' : ''}`
    })
    .join(' / ')
}
