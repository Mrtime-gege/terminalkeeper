/**
 * 模式闸门（保留）：只拦"能执行/改动"的工具，防止受限沙箱下的写操作。
 * 这是 DSH 沙箱模式闸门，不是用户授权系统。
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

export function capabilityForTool (name) {
  return Object.prototype.hasOwnProperty.call(TOOL_CAPABILITY, name) ? TOOL_CAPABILITY[name] : 'full'
}

/**
 * 审计加固（2026-11-16）：读不到模式时对 full 能力改为 **fail-closed**（此前放行）。
 * 理由：插件 shell 不受 DSH 文件沙箱约束，"模式未知"不等于"完全控制"；默认拒绝，
 * 只有显式设置 DSH_TERMINALKEEPER_ALLOW_UNKNOWN_MODE=1 才按未知放行（并记审计）。
 * 只读/查询类能力始终豁免。
 */
export function modeGateDenies (mode, capability, { allowUnknown = false } = {}) {
  if (capability !== 'full') return false
  if (mode === null || mode === undefined) return allowUnknown !== true
  return mode !== 'danger-full-access'
}
