/**
 * 模式闸门（保留）：只拦"能执行/改动"的工具，防止受限沙箱下的写操作。
 * 这不是用户授权系统；授权/ACL 已移除。
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

export function modeGateDenies (mode, capability) {
  return capability === 'full' && mode !== null && mode !== 'danger-full-access'
}
