/**
 * Windows 原生后的 shell 选择（纯逻辑，可在 Linux/macOS 上做预期测试）。
 *
 * PTY backend 需要明确启动哪一个 shell；这里只负责：
 *   - 用户显式配置优先；
 *   - 否则按 pwsh → powershell → %ComSpec%/cmd 的顺序探测；
 *   - 给出各 shell 的安全默认参数；
 *   - 不在 PATH 上时返回空，不安装任何东西。
 *
 * 不调用 `where.exe`，也不执行候选 shell；只做文件存在性检查，便于注入 fake。
 */

import { existsSync } from 'node:fs'
import { join, basename, isAbsolute } from 'node:path'

export const WINDOWS_SHELL_KINDS = Object.freeze(['pwsh', 'powershell', 'cmd', 'other'])

/** 从路径/命令名判断 shell 类型（不执行它）。 */
export function shellKindOf(shell) {
  // 在 Linux/macOS 上做预期测试时也要能识别 Windows 反斜杠路径，不能只靠 POSIX basename。
  const normalized = String(shell ?? '').trim().replace(/\\/g, '/')
  const name = basename(normalized).toLowerCase().replace(/\.exe$/i, '')
  if (name === 'pwsh') return 'pwsh'
  if (name === 'powershell') return 'powershell'
  if (name === 'cmd') return 'cmd'
  return 'other'
}

/** 各 shell 的默认参数：只做非交互启动，不改用户的 profile。 */
export function defaultShellArgs(kind) {
  if (kind === 'pwsh' || kind === 'powershell') return ['-NoLogo']
  if (kind === 'cmd') return ['/Q', '/V:ON']
  return []
}

function pathEntries(env, delimiter) {
  const raw = String(env?.PATH ?? env?.Path ?? '')
  return raw.split(delimiter).map((entry) => entry.trim()).filter((entry) => entry !== '')
}

function looksLikePath(name) {
  return isAbsolute(name) || name.includes('/') || name.includes('\\') || /^[A-Za-z]:/.test(name)
}

/**
 * 在 PATH 里找可执行文件。`exists` 可注入，测试不需要真实 Windows。
 * @param {string} name
 * @param {{env?: object, exists?: (p: string) => boolean, pathDelimiter?: string, appendExe?: boolean}} [options]
 * @returns {string} 找到的完整路径；找不到返回空串
 */
export function findOnPath(name, options = {}) {
  const env = options.env ?? process.env
  const exists = options.exists ?? existsSync
  const delimiter = options.pathDelimiter ?? (process.platform === 'win32' ? ';' : ':')
  const appendExe = options.appendExe ?? process.platform === 'win32'
  const raw = String(name ?? '').trim()
  if (raw === '') return ''
  const names = appendExe && /\.exe$/i.test(raw) === false ? [`${raw}.exe`, raw] : [raw]
  if (looksLikePath(raw)) {
    for (const candidate of names) {
      if (exists(candidate)) return candidate
    }
    return ''
  }
  for (const entry of pathEntries(env, delimiter)) {
    for (const candidate of names) {
      const full = join(entry, candidate)
      if (exists(full)) return full
    }
  }
  return ''
}

/**
 * 选择 Windows shell。显式 shell 即使不在 PATH 也保留（用户可能给绝对路径或稍后创建）；
 * 自动探测失败返回 `{shell:'',kind:'other',args:[]}`，由上层降级，不安装任何东西。
 *
 * @param {{shell?: string, shellArgs?: string[], env?: object, exists?: (p:string)=>boolean, pathDelimiter?: string, appendExe?: boolean}} [options]
 */
export function selectWindowsShell(options = {}) {
  const env = options.env ?? process.env
  const exists = options.exists ?? existsSync
  const pathDelimiter = options.pathDelimiter ?? (process.platform === 'win32' ? ';' : ':')
  const appendExe = options.appendExe ?? process.platform === 'win32'
  const explicitArgs = Array.isArray(options.shellArgs) && options.shellArgs.length > 0 ? options.shellArgs.slice() : null

  if (typeof options.shell === 'string' && options.shell.trim() !== '') {
    const shell = options.shell.trim()
    const kind = shellKindOf(shell)
    return { shell, kind, args: explicitArgs ?? defaultShellArgs(kind) }
  }

  const standardPwsh = []
  const programFiles = env.ProgramFiles ?? env.PROGRAMFILES ?? env.ProgramW6432
  if (typeof programFiles === 'string' && programFiles.trim() !== '') {
    standardPwsh.push(join(programFiles, 'PowerShell', '7', 'pwsh.exe'))
    standardPwsh.push(join(programFiles, 'PowerShell', '7-preview', 'pwsh.exe'))
  }
  if (typeof env.LOCALAPPDATA === 'string' && env.LOCALAPPDATA.trim() !== '') {
    standardPwsh.push(join(env.LOCALAPPDATA, 'Microsoft', 'PowerShell', '7', 'pwsh.exe'))
  }
  // PowerShell 7 的 MSI/Store 安装不一定把 pwsh.exe 放进 PATH；先看标准目录，
  // 再退回 PATH。所有路径都只做 exists 检查，不执行、不安装。
  const candidates = [...standardPwsh, 'pwsh.exe', 'powershell.exe', env.ComSpec, 'cmd.exe']
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.trim() === '') continue
    const shell = findOnPath(candidate.trim(), { env, exists, pathDelimiter, appendExe })
    if (shell === '') continue
    const kind = shellKindOf(shell)
    return { shell, kind, args: explicitArgs ?? defaultShellArgs(kind) }
  }
  return { shell: '', kind: 'other', args: [] }
}
