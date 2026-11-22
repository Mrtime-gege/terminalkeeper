/**
 * tmux 后端：当前唯一实现，包住已有的 TmuxDriver。
 *
 * 这里只做三件事：
 *   1. 给 TmuxDriver 加 backendName / contractVersion / capabilities；
 *   2. 保持对 core 的方法形态不变（继承全部已有方法）；
 *   3. 把 tmux 相关工具函数从 core 的 import 路径里收进来。
 *
 * 平台事实（Linux / WSL2）通过 capabilities 如实暴露：
 *   persistent 仅 systemd user scope 为 true；plain-detach 为 false。
 *   processTree / cpu 依赖 /proc，非 Linux 为 false。
 */

import { TmuxDriver, isShellForeground, sanitizeSocketName } from '../../tmux.js'
import { TERMINAL_CONTRACT_VERSION, assertTerminalBackend } from '../contract.mjs'

export class TmuxBackend extends TmuxDriver {
  get backendName () {
    return 'tmux'
  }

  get contractVersion () {
    return TERMINAL_CONTRACT_VERSION
  }

  get capabilities () {
    return Object.freeze({
      backend: 'tmux',
      sessions: true,
      persistent: this.serverLaunch === 'systemd-scope',
      detached: true,
      screen: true,
      history: true,
      subscribe: true,
      keys: true,
      mouse: true,
      bell: true,
      foreground: true,
      processTree: this.procMode === 'proc' || this.procMode === 'ps',
      cpu: this.procMode === 'proc' || this.procMode === 'ps',
      exitCode: true,
      resize: true,
      rename: true,
      snapshot: true,
      watchdog: true,
      extendedKeys: this.useExtendedKeys() === true,
    })
  }
}

export function createTmuxBackend (options = {}) {
  const backend = new TmuxBackend(options)
  return assertTerminalBackend(backend)
}

export { isShellForeground, sanitizeSocketName }
