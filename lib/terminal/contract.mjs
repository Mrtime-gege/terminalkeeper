/**
 * 终端后端契约（0.2.1 基础层）。
 *
 * 目标：核心只依赖这一层，不再直接依赖 tmux。当前只有 tmux 一个实现；
 * 未来的 pty / wsl / 远程后端按同一份契约接入。
 *
 * 设计原则：
 *   · 能力先于平台：后端声明 capabilities，core 按能力降级，不写 process.platform 分支。
 *   · 屏幕先于字节：capture/history/screen 是面板与快照的基础；只提供原始字节流的后端
 *     必须自己在 adapter 里补终端仿真。
 *   · 安全策略留在 core：锁、归属、审计、vault、工具参数都不属于 backend。
 */

export const TERMINAL_CONTRACT_VERSION = 1

/** 后端必须声明的能力键；未知键允许作为扩展，但 core 只依赖这些。 */
export const TERMINAL_CAPABILITIES = Object.freeze([
  'sessions',
  'persistent',
  'detached',
  'screen',
  'history',
  'subscribe',
  'keys',
  'mouse',
  'bell',
  'foreground',
  'processTree',
  'cpu',
  'exitCode',
  'resize',
  'rename',
  'snapshot',
  'watchdog',
  'extendedKeys',
])

/**
 * core 真正依赖的最小方法集。后续新增操作先加到这里，再考虑 backend 是否需要实现。
 * 当前 tmux adapter 通过继承 TmuxDriver 提供全部方法；未来后端实现这组即可接入。
 */
export const TERMINAL_METHODS = Object.freeze([
  'list',
  'has',
  'create',
  'kill',
  'send',
  'sendBytes',
  'captureWithMeta',
  'screen',
  'foregroundOf',
  'resolveForeground',
  'resize',
  'setLabel',
  'respawn',
  'watchOutput',
  'unwatchOutput',
  'drainOutput',
  'appendWatchedOutput',
  'probe',
])

export class TerminalContractError extends Error {
  constructor (message) {
    super(String(message))
    this.name = 'TerminalContractError'
  }
}

/** 校验一个后端实例是否满足当前契约；失败时给出具体缺项。 */
export function assertTerminalBackend (backend) {
  if (backend === null || typeof backend !== 'object') {
    throw new TerminalContractError('terminal backend must be an object')
  }
  if (typeof backend.backendName !== 'string' || backend.backendName === '') {
    throw new TerminalContractError('terminal backend must expose backendName')
  }
  if (backend.contractVersion !== TERMINAL_CONTRACT_VERSION) {
    throw new TerminalContractError(
      `terminal backend contractVersion ${String(backend.contractVersion)} != ${TERMINAL_CONTRACT_VERSION}`,
    )
  }
  const capabilities = backend.capabilities
  if (capabilities === null || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
    throw new TerminalContractError('terminal backend must expose a capabilities object')
  }
  for (const key of TERMINAL_CAPABILITIES) {
    if (typeof capabilities[key] !== 'boolean') {
      throw new TerminalContractError(`terminal backend capability ${key} must be boolean`)
    }
  }
  for (const method of TERMINAL_METHODS) {
    if (typeof backend[method] !== 'function') {
      throw new TerminalContractError(`terminal backend is missing method ${method}()`)
    }
  }
  return backend
}
