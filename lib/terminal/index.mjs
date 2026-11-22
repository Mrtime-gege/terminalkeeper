/**
 * 终端服务入口：core 和 supervisor 只从这里取后端。
 *
 * 内置 tmux（Linux/WSL2/macOS）与 pty（Windows 原生，预期测试阶段）。
 * 选择逻辑故意保持很小；未来 wsl / external 后端在这里注册，不在 core 里散落平台分支。
 */

import { TERMINAL_CONTRACT_VERSION } from './contract.mjs'
import { createTmuxBackend, isShellForeground, sanitizeSocketName } from './backends/tmux.mjs'
import { createPtyBackend } from './backends/pty.mjs'

export { TERMINAL_CONTRACT_VERSION, isShellForeground, sanitizeSocketName }
export { TERMINAL_CAPABILITIES, TERMINAL_METHODS, assertTerminalBackend, TerminalContractError } from './contract.mjs'

export const SUPPORTED_BACKENDS = Object.freeze(['tmux', 'pty'])

/** 平台默认后端：Windows 原生走 pty；Linux/WSL2/macOS 继续 tmux。 */
export function defaultTerminalBackend (platform = process.platform) {
  return platform === 'win32' ? 'pty' : 'tmux'
}

/**
 * 选择后端。默认按平台：win32 → pty，其余 → tmux；显式 backend/env 优先。
 * @param {{backend?: string}} [options]
 * @returns {'tmux'|'pty'}
 */
export function selectTerminalBackend (options = {}) {
  const requested = String(
    options.backend ?? process.env.DSH_TERMINALKEEPER_TERMINAL_BACKEND ?? defaultTerminalBackend(options.platform),
  )
  if (!SUPPORTED_BACKENDS.includes(requested)) {
    throw new Error(
      `不支持的终端后端：${requested}（当前可用：${SUPPORTED_BACKENDS.join(', ')}）`,
    )
  }
  return /** @type {'tmux'|'pty'} */ (requested)
}

/**
 * 创建 core/supervisor 使用的终端服务。
 * @param {object} options TmuxDriver 选项，另可带 backend
 */
export function createTerminalService (options = {}) {
  const backend = selectTerminalBackend(options)
  if (backend === 'tmux') return createTmuxBackend(options)
  if (backend === 'pty') return createPtyBackend(options)
  throw new Error(`终端后端 ${backend} 尚未实现`)
}
