/**
 * 引用库口令组的设备 pepper（第二密钥）。
 *
 * 用途：把 `scrypt(口令)` 再与设备本地的 32 字节随机 pepper 组合，避免**只拿到 vault.json**
 * 的离线爆破。它不改变“同用户可读整个数据目录”的事实：pepper 落在数据目录里，同权限 AI
 * 仍能读；边界是“只泄露了 vault.json / 备份里的单个密文文件”。
 *
 * 设计约束：
 *   · 生成一次即固定，不自动轮换；丢失 = 该 pepper 保护的口令组永久无法解密；
 *   · 已存在但损坏时 **fail-closed**，绝不覆盖原文件（覆盖会让所有口令组永久失联）；
 *   · 文件 0600 + 原子写；不写进 vault.json，不写进配置/审计。
 */
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const PEPPER_FILE = 'vault.pepper'
const KEY_BYTES = 32

export function pepperFingerprint (key) {
  return createHash('sha256').update(key).digest('base64url').slice(0, 16)
}

/**
 * 读取已有 pepper；不存在则生成。损坏/权限失败一律抛错（调用方 fail-closed）。
 * @returns {{created:boolean,key:Buffer,kfp:string,path:string}}
 */
export function ensureVaultPepper (dir, { random = randomBytes, path, create = true } = {}) {
  const file = path ?? join(dir, PEPPER_FILE)
  if (existsSync(file)) {
    let parsed
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      throw new Error(`${PEPPER_FILE} 无法读取或不是合法 JSON；为避免覆盖后口令组永久失联，已拒绝继续`)
    }
    const key = Buffer.from(String(parsed?.key ?? ''), 'base64')
    if (key.length !== KEY_BYTES) {
      throw new Error(`${PEPPER_FILE} 损坏（密钥长度不是 ${KEY_BYTES} 字节）；已拒绝继续，请从备份恢复`)
    }
    return { created: false, key, kfp: pepperFingerprint(key), path: file }
  }
  if (create !== true) {
    throw new Error(`${PEPPER_FILE} 缺失；该口令组需要原来的 pepper 才能解密，请从备份恢复`)
  }
  const key = random(KEY_BYTES)
  const record = {
    v: 1,
    key: key.toString('base64'),
    kfp: pepperFingerprint(key),
    createdAt: new Date().toISOString(),
  }
  const tmp = `${file}.${process.pid}.tmp`
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, file)
    try { chmodSync(file, 0o600) } catch { /* 尽力而为 */ }
  } catch (error) {
    try { unlinkSync(tmp) } catch { /* ignore */ }
    throw new Error(`创建 ${PEPPER_FILE} 失败：${String(error?.message ?? error)}`)
  }
  return { created: true, key, kfp: pepperFingerprint(key), path: file }
}
