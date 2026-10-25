/**
 * 授权模型（纯函数，零依赖）—— 时间 × 能力两个维度。
 *
 * 为什么要单独一个模块：这套判定同时被宿主（工具门、路由）与前端（授权浮层）需要，
 * 而且它包含大量"边界必须一致"的规则（时间档位、能力映射、过期语义）。
 * 把它写成纯函数，就能在**不启动 tmux、不启动 DSH** 的情况下逐一断言 ——
 * 权限模型的边界搞错会直接变成安全问题，不能只靠手工点。
 *
 * 设计定稿见 docs/设计与实现.md「权限模型」一节。
 */

/** 能力三档。deny = 完全禁止接触插件功能。 */
export const SCOPES = ['full', 'read', 'deny']

/**
 * 插件出厂默认授权规则 —— **直接跟随 DSH 的权限模式**（0.4.0，用户拍板）：
 *
 *   * `danger-full-access`（完全控制）→ `full`：这个模式下用户已经把整个会话交给 AI 了，
 *     插件自然"可以任意使用"，**不再询问**；
 *   * 其它模式（`workspace-write` / `read-only` / 未知）→ `deny`：首次使用时由授权门
 *     发起一次 **DSH 原生审批**问用户（见 index.js 的 requestNativeApproval）。
 *
 * 注意后者有个平台事实（docs/SECURITY.md §3 实测）：非 `danger-full-access` 时沙箱会挡住
 * tmux 服务端（`error connecting to /tmp/tmux-1000/...`），也就是**批准了 shell 也起不来**。
 * 所以审批理由里会如实写明这一点，让用户批准之前就知道结果。
 *
 * @param {string} [permissionMode] - `process.env.DSH_PERMISSION_MODE` 的值。
 * @returns {{scope: string, ttlSeconds: null}} 默认规则。
 */
export function defaultRuleOf (permissionMode = '') {
  return String(permissionMode) === 'danger-full-access'
    ? { scope: 'full', ttlSeconds: null }
    : { scope: 'deny', ttlSeconds: null }
}

/** 从一条规则复制出会话自己的授权（值拷贝 —— 之后改默认规则不影响已建会话）。 */
export function copyRuleToSession (rule, now, title = '') {
  const base = rule !== null && typeof rule === 'object' ? rule : defaultRuleOf()
  const scope = normalizeScope(base.scope) ?? 'deny'
  const ttl = normalizeTtl(base.ttlSeconds)
  return {
    scope,
    ttlSeconds: ttl,
    at: now,
    by: 'copy',
    source: 'default-copy',
    expiresAt: ttl === null ? null : expiresAtFor(ttl, now),
    uses: 0,
    lastUsedAt: now,
    title,
  }
}

/** 会话授权是否仍然有效（复用 isActive 的语义；copied 条目同样按 scope/expiresAt 判）。 */
export function isActive (entry, now) {
  if (entry === null || typeof entry !== 'object') return false
  // 旧格式（本模型之前的 consent.json）没有 scope 字段：那时授权就等于"完全控制"，
  // 所以按 full 解读是**兼容读法**而不是放宽 —— 否则升级后所有旧授权会突然失效、人被重新问一遍。
  // 而"有 scope 但值非法"则一律拒绝（fail closed）。
  const scope = entry.scope === undefined ? 'full' : normalizeScope(entry.scope)
  if (scope === null) return false
  if (typeof entry.expiresAt === 'number' && entry.expiresAt <= now) return false
  return true
}

/** 由档位算出 expiresAt（null = 永久）。 */
export function expiresAtFor (seconds, now) {
  return seconds === null ? null : now + seconds * 1000
}

/** 时间五档。seconds = null 表示永久。 */
export const TIME_LEVELS = [
  { key: '10m', seconds: 600, label: '10 分钟' },
  { key: '30m', seconds: 1800, label: '30 分钟' },
  { key: '2h', seconds: 7200, label: '2 小时' },
  { key: 'forever', seconds: null, label: '永久' },
  { key: 'custom', seconds: null, label: '自定义' },
]

/** 自定义时间的允许范围：1 分钟 – 30 天（用户拍板）。 */
export const CUSTOM_TTL_RANGE = [60, 30 * 86400]

/**
 * 工具 → 所需能力。**这是权限模型的边界，改动必须同步 SECURITY.md 与测试。**
 *
 * 注意两个刻意的决定（都由用户拍板）：
 *   * `shell_close` 需要 full —— 关闭会杀掉里面的进程，不算"只看看"；
 *   * `shell_state` 任何档位都允许 —— 它吸收了 shell_consent 的职责（授权状态一并在其中汇报），
 *     与"完全禁止也能查授权状态"同一个理由：被挡住的对话也得能问出"为什么被挡"。
 *
 * 0.2.3 精简合并：shell_wait → shell_read(mode wait)，shell_check → shell_run/shell_send(dryrun)，
 * shell_consent → shell_state（不再单列，避免能力表与实际工具脱节）。
 */
export const TOOL_CAPABILITY = {
  shell_state: 'none',
  shell_read: 'read',
  shell_audit: 'read',
  shell_open: 'full',
  shell_run: 'full',
  shell_send: 'full',
  shell_manage: 'full',
}

/** 某个工具需要的能力（未知工具按最严格处理：full）。 */
export function capabilityForTool (name) {
  return Object.prototype.hasOwnProperty.call(TOOL_CAPABILITY, name) ? TOOL_CAPABILITY[name] : 'full'
}

/**
 * 模式闸门的纯决策（0.4.0 用户拍板 + 子 agent 实测修正）。
 *
 * 只拦**能执行/改动**的工具（能力档 `full`）—— 它们才是"绕过文件沙箱"的通道；
 * 只读查询（`shell_read` / `shell_audit`，能力档 `read`）不执行任何命令，予以豁免，
 * 这样被挡住时 AI 还能问出"为什么"。
 *
 * `mode` 为 `null` 表示读不到会话模式 → **不拦**（fail-open）：部署环境的
 * `DSH_PERMISSION_MODE` 常常没设，拿默认值当真相会把完全控制的会话误判成受限模式
 * （实测过：插件被整体打死）。真正的权限由 DSH 强制，这道闸门只是附加保护。
 *
 * @param {string|null} mode - 会话真实沙箱模式（read-only / workspace-write / danger-full-access）。
 * @param {string} capability - 该工具需要的能力档。
 * @returns {boolean} true = 拦下。
 */
export function modeGateDenies (mode, capability) {
  return capability === 'full' && mode !== null && mode !== 'danger-full-access'
}

/** 该能力档是否允许做要求 cap 的操作。 */
export function scopeAllows (scope, cap) {
  // 用户明确要求：查询授权状态（shell_state）不受任何档位影响 —— 被完全禁止时也要能问"为什么"。
  if (cap === 'none') return true
  if (scope === 'full') return true
  if (scope === 'read') return cap === 'read'
  return false   // deny 与未知档位一律拒绝（fail closed）
}

export function normalizeScope (value) {
  return SCOPES.includes(value) ? value : null
}

/** 把秒数收敛到合法范围；null / undefined 表示永久（自定义档由调用方显式给秒数）。 */
export function normalizeTtl (seconds) {
  if (seconds === null || seconds === undefined) return null
  const n = Number(seconds)
  if (!Number.isFinite(n)) return null
  const rounded = Math.floor(n)
  if (rounded < CUSTOM_TTL_RANGE[0] || rounded > CUSTOM_TTL_RANGE[1]) return null
  return rounded
}

/**
 * 列表用：把授权记录整理成前端要的行（按最近使用倒序）。
 * @param {Record<string, object>} consent 授权表（sessions 对象；'*' 通配在旧格式里存在，跳过）
 * @param {number} now 当前时间（注入以便测试）
 * @param {(actor: string) => string} titleOf 取会话标题（可为空串）
 */
export function summarizeEntries (consent, now, titleOf = () => '') {
  const rows = []
  for (const [actor, entry] of Object.entries(consent ?? {})) {
    if (actor === '*') continue
    if (!isActive(entry, now)) continue
    rows.push({
      actor,
      title: typeof entry.title === 'string' ? entry.title : '',
      scope: normalizeScope(entry.scope),
      expiresAt: typeof entry.expiresAt === 'number' ? entry.expiresAt : null,
      lastUsedAt: typeof entry.lastUsedAt === 'number' ? entry.lastUsedAt : (entry.at ?? null),
      uses: Number.isFinite(entry.uses) ? entry.uses : 0,
      // 0.4.0：这个会话最近一次判定时读到的沙箱模式（面板据此显示"它在什么模式下"）
      mode: typeof entry.mode === 'string' ? entry.mode : null,
      source: entry.source === 'panel' ? 'panel' : (entry.source === 'default-copy' ? 'default-copy' : (entry.source === 'legacy' ? 'legacy' : 'prompt')),
    })
  }
  return rows.sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
}
