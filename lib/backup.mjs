/**
 * 引用库备份 / 导出 / 迁移（0.5.x，2026-10 加）。
 *
 * 为什么需要：秘密域是这个插件的全部价值，但此前**没有任何备份/迁移入口** ——
 * 机器挂了 = 永久丢；换机器 = 没有迁移路径（vault.json 还受 device.key 绑定）。
 *
 * 设计要点（安全默认优先）：
 *   · 备份包**默认不含 device.key**（密钥留在原机器；换机可直接用需要显式 --include-device-key）；
 *   · 支持 `--passphrase` 把整包用 scrypt + AES-256-GCM 加密（不含口令时包内秘密的暴露程度
 *     与 vault.json 本身一致 —— none 模式组本就是明文，CLI 会明确警告并要求确认）；
 *   · 每个文件带 sha256，整包带 payloadSha256：**篡改/损坏一律拒绝**，绝不"带伤恢复"；
 *   · restore 默认**不覆盖**（返回 plan 供调用方确认）；覆盖前把现有文件改名成
 *     `<名>.pre-restore-<时间戳>.bak`，可回退；
 *   · 绝不打印任何文件内容（任何错误信息也不带内容片段）。
 */
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto'

export const BACKUP_VERSION = 1
export const BACKUP_KIND = 'terminalkeeper-backup'
/** 默认纳入备份的数据文件（相对数据目录）。device.key 只在显式要求时纳入。 */
export const DEFAULT_FILES = [
  'vault.json', 'vault.head.json', 'vault.uses.json',
  'macros.json', 'workspaces.json', 'consent.json', 'config-local.json',
]
export const DEVICE_KEY_FILE = 'device.key'
const MAX_BACKUP_BYTES = 64 * 1024 * 1024

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
/** 稳定序列化（键排序）—— 校验和必须与 JSON 键序无关 */
function canonical (value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}'
  }
  return JSON.stringify(value === undefined ? null : value)
}

/**
 * 生成备份包（返回 { ok, text, summary, error }）。
 * text 是要落盘的字符串（加密或不加密）。
 */
export function createBackup (dir, {
  files = DEFAULT_FILES,
  includeDeviceKey = false,
  passphrase = '',
  pluginVersion = '',
  createdAt = Date.now(),
} = {}) {
  try {
    const want = includeDeviceKey === true ? [...files, DEVICE_KEY_FILE] : [...files]
    const map = {}
    const missing = []
    for (const name of want) {
      const p = join(dir, name)
      if (existsSync(p) !== true) { missing.push(name); continue }
      const buf = readFileSync(p)
      map[name] = { bytes: buf.length, sha256: sha256(buf), data: buf.toString('base64') }
    }
    if (Object.keys(map).length === 0) return { ok: false, error: '数据目录里没有可备份的文件（是不是路径不对？）' }
    const envelope = {
      v: BACKUP_VERSION,
      kind: BACKUP_KIND,
      createdAt,
      pluginVersion: String(pluginVersion ?? ''),
      includeDeviceKey: includeDeviceKey === true,
      missing,
      files: map,
      payloadSha256: sha256(Buffer.from(canonical(map), 'utf8')),
    }
    const plain = JSON.stringify(envelope)
    if (typeof passphrase === 'string' && passphrase !== '') {
      const salt = randomBytes(16); const iv = randomBytes(12)
      const key = scryptSync(passphrase, salt, 32)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const enc = Buffer.concat([cipher.update(Buffer.from(plain, 'utf8')), cipher.final()])
      const text = JSON.stringify({
        v: BACKUP_VERSION, kind: BACKUP_KIND, enc: 'scrypt-aes-256-gcm',
        salt: salt.toString('base64'), iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'), data: enc.toString('base64'),
      })
      return { ok: true, text, summary: { encrypted: true, files: Object.keys(map).length, missing, includeDeviceKey: includeDeviceKey === true } }
    }
    return { ok: true, text: plain, summary: { encrypted: false, files: Object.keys(map).length, missing, includeDeviceKey: includeDeviceKey === true } }
  } catch (error) {
    return { ok: false, error: '生成备份失败：' + String(error && error.message ? error.message : error) }
  }
}

/**
 * 读取/解包并**校验完整性**（返回 { ok, envelope, files, error }）。
 * 篡改、口令错误、结构不符一律 ok:false —— 绝不带伤恢复。
 */
export function readBackup (text, { passphrase = '' } = {}) {
  let obj
  try { obj = JSON.parse(String(text ?? '')) } catch { return { ok: false, error: '不是合法的备份文件（JSON 解析失败）' } }
  if (obj === null || typeof obj !== 'object') return { ok: false, error: '备份文件结构不符' }
  if (obj.enc === 'scrypt-aes-256-gcm') {
    if (typeof passphrase !== 'string' || passphrase === '') return { ok: false, error: '该备份已加密：请用 --passphrase 提供口令' }
    try {
      const salt = Buffer.from(String(obj.salt ?? ''), 'base64')
      const iv = Buffer.from(String(obj.iv ?? ''), 'base64')
      const tag = Buffer.from(String(obj.tag ?? ''), 'base64')
      const data = Buffer.from(String(obj.data ?? ''), 'base64')
      if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16) return { ok: false, error: '备份文件结构不符（加密头损坏）' }
      const decipher = createDecipheriv('aes-256-gcm', scryptSync(passphrase, salt, 32), iv)
      decipher.setAuthTag(tag)
      const plain = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
      obj = JSON.parse(plain)
    } catch { return { ok: false, error: '口令错误或文件损坏（解密失败）' } }
  }
  if (obj.kind !== BACKUP_KIND || Number(obj.v) !== BACKUP_VERSION) return { ok: false, error: '不是本插件的备份包（kind/版本不符）' }
  const map = obj.files
  if (map === null || typeof map !== 'object') return { ok: false, error: '备份文件结构不符（缺少 files）' }
  const total = Object.values(map).reduce((n, f) => n + Number(f?.bytes ?? 0), 0)
  if (total > MAX_BACKUP_BYTES) return { ok: false, error: '备份包过大（超过 64MB 上限）' }
  if (obj.payloadSha256 !== sha256(Buffer.from(canonical(map), 'utf8'))) {
    return { ok: false, error: '校验和不符：备份文件可能被篡改或损坏' }
  }
  const files = {}
  for (const [name, f] of Object.entries(map)) {
    if (f === null || typeof f !== 'object' || typeof f.data !== 'string') return { ok: false, error: `备份内 ${name} 条目损坏` }
    const buf = Buffer.from(f.data, 'base64')
    if (buf.length !== Number(f.bytes) || sha256(buf) !== String(f.sha256 ?? '')) {
      return { ok: false, error: `备份内 ${name} 校验失败（内容与记录不符）` }
    }
    files[name] = buf
  }
  return { ok: true, envelope: obj, files }
}

/** 允许恢复的文件白名单（防备份包夹带任意路径） */
const RESTORABLE = new Set([...DEFAULT_FILES, DEVICE_KEY_FILE])

/**
 * 恢复。默认**不覆盖**：yes!==true 时只返回 plan（供 CLI 打印确认）。
 * 覆盖前把现有文件改名 <名>.pre-restore-<ts>.bak。
 */
export function restoreBackup (dir, { files, yes = false } = {}) {
  const names = Object.keys(files ?? {})
  for (const n of names) if (RESTORABLE.has(n) !== true) return { ok: false, error: `备份包里有不允许恢复的条目：${n}` }
  const plan = names.map((n) => ({ name: n, bytes: files[n].length, overwrite: existsSync(join(dir, n)) }))
  if (yes !== true) return { ok: true, refused: true, plan, written: [], backedUp: [] }
  const ts = Date.now()
  const written = []; const backedUp = []
  for (const n of names) {
    const target = join(dir, n)
    try {
      if (existsSync(target)) { const bak = `${target}.pre-restore-${ts}.bak`; renameSync(target, bak); backedUp.push(bak.split('/').pop()) }
      writeFileSync(target, files[n], { mode: 0o600 })
      written.push(n)
    } catch (error) {
      return { ok: false, error: `写入 ${n} 失败：` + String(error && error.message ? error.message : error), written, backedUp }
    }
  }
  return { ok: true, refused: false, plan, written, backedUp }
}
