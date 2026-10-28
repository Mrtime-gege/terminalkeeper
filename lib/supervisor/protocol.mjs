/**
 * terminalkeeper —— supervisor 线协议
 *
 * 独立于 DSH 插件 fiber 的监督域使用这份协议与插件核心通信。
 * 设计约束：
 *   - 只走本机 Unix socket（0600）；不做网络监听。
 *   - 一行一个 JSON 帧（NDJSON）；请求/响应都带 id。
 *   - 协议版本独立于插件版本；不兼容必须显式拒绝，不能静默降级。
 *   - 协议层不导入 DSH 包；daemon 可单独启动、单独测试。
 */

import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const PROTOCOL_VERSION = 1
export const DAEMON_VERSION = '0.1.0'
export const DAEMON_BUILD = 'c91'
export const DEFAULT_DIR = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'terminalkeeper')

/** socket/token/pid 的稳定路径；测试可传自定义目录。 */
export function supervisorPaths (dir = DEFAULT_DIR) {
  const base = String(dir)
  return {
    dir: base,
    socket: join(base, 'supervisor.sock'),
    token: join(base, 'supervisor.token'),
    pid: join(base, 'supervisor.pid'),
    lock: join(base, 'supervisor.lock'),
  }
}

/** 创建目录（0700）并确保 token 存在（0600）。返回 token 字符串。 */
export function ensureToken (dir = DEFAULT_DIR) {
  const paths = supervisorPaths(dir)
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 })
  try { chmodSync(paths.dir, 0o700) } catch { /* 非 POSIX 忽略 */ }
  if (existsSync(paths.token)) {
    const token = readFileSync(paths.token, 'utf8').trim()
    if (token.length >= 16) return token
  }
  const token = randomBytes(24).toString('hex')
  writeFileSync(paths.token, token + '\n', { mode: 0o600 })
  try { chmodSync(paths.token, 0o600) } catch { /* 非 POSIX 忽略 */ }
  return token
}

export function readToken (dir = DEFAULT_DIR) {
  const p = supervisorPaths(dir).token
  if (!existsSync(p)) return ''
  return readFileSync(p, 'utf8').trim()
}

/** token 的短指纹，仅用于日志/诊断，不泄露原值。 */
export function tokenFingerprint (token) {
  return createHash('sha256').update(String(token)).digest('hex').slice(0, 12)
}

export function encodeFrame (value) {
  return JSON.stringify(value) + '\n'
}

/** 从 NDJSON 缓冲中切出完整帧；返回 [frames, rest]。坏帧由调用方拒绝。 */
export function takeFrames (buffer) {
  const text = String(buffer)
  const lines = text.split('\n')
  const rest = lines.pop() ?? ''
  const frames = []
  for (const line of lines) {
    if (line.trim() === '') continue
    frames.push(line)
  }
  return [frames, rest]
}

export function validateRequest (value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'request must be an object'
  if (typeof value.id !== 'string' || value.id === '') return 'request.id must be a non-empty string'
  if (typeof value.method !== 'string' || value.method === '') return 'request.method must be a non-empty string'
  if (value.params !== undefined && (value.params === null || typeof value.params !== 'object' || Array.isArray(value.params))) {
    return 'request.params must be an object'
  }
  return ''
}

export function ok (id, result, extra = {}) {
  return { id, ok: true, result, ...extra }
}

export function fail (id, code, message, extra = {}) {
  return { id, ok: false, error: { code, message }, ...extra }
}