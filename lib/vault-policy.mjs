/**
 * 引用库策略判定（0.4.1）—— 从 HTTP 路由里抽出来的**纯决策**，便于离线夹具覆盖。
 *
 * 规范：`docs/引用库安全模型.md` §3（剩余次数 / 提权）、§6（同名重建确认）。
 * 抽出来的原因：路由里混着请求/响应，离线测不到；而这两条恰恰是**规范里的硬要求** ——
 *   · 改值**不重置**已用次数；重置属**提权**，必须显式 `elevate:true`；
 *   · 重建**同名**键（命中烧伤表）必须显式 `reuseName:true`，否则拒绝。
 */

/** 重建同名键是否需要（且尚未）确认。 */
export function needsReuseConfirm ({ reuseHit = false, reuseName = false } = {}) {
  return reuseHit === true && reuseName !== true
}


/** 新的 `maxUses`：显式给值优先；否则一次性=1；否则沿用旧值（undefined=无限次）。 */
export function maxUsesOf ({ body = {}, prev } = {}) {
  const n = Number(body.maxUses)
  if (n === -1) return -1                                  // 显式 -1 = 不限（与存储约定一致）
  if (Number.isFinite(n)) return Math.max(0, Math.floor(n))
  if (body.oneShot === true) return 1
  if (Number(prev) === -1) return -1                                  // -1 = 无限次（约定值）
  return Number.isFinite(Number(prev)) ? Number(prev) : -1
}


/** 一次性键被消耗后是否需要写烧伤标记（reason 区分「额度用尽」与「主动销毁」）。 */
export function burnReasonOnConsume ({ consume = false, reason = 'destroyed' } = {}) {
  return consume === true ? 'exhausted' : String(reason)
}