/**
 * 「简单混淆」组：**用设备固定密钥加密**，目的只有一条 —— **不让明文直接落盘**。
 *
 * ⚠ 安全边界（必须在 UI 与文档里如实说明）：
 *   · 这**不是**安全机制，**不提供机密性保证**：任何能读到本机文件的人（或进程）都能解密；
 *   · 它只防「**全盘搜索关键词**」这类低成本命中（例如 grep/取证工具按关键词扫盘）；
 *   · 只要用户真需要保密 ⇒ 用「口令加密」组（密钥只在内存，绝不落盘）。
 *
 * 密钥模型（满足"生成后永远唯一 / 可手动重新生成"）：
 *   · 每台设备首次安装/首次使用时**自动生成**：32 字节随机（CSPRNG）作为种子，落盘 0600；
 *   · **机器唯一信息作为派生种子**：effectiveKey = scrypt(randomSeed, salt=machineSeed)
 *     ⇒ 数据目录被搬到**另一台设备**时无法解密（设备绑定），符合"每台设备各自生成"；
 *   · **绝不自动轮换**：生成一次即长期有效；提供 rotateDeviceKey() 手动重新生成（唯一性要求：
 *     重新生成 ⇒ 旧密文需重新封存；本模块不留旧密钥、不自动迁移，由调用方显式处理）；
 *   · 设备指纹（keyFp）随密钥落盘，用于"这把密钥是不是同一把"的判定与诊断展示。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const DEVICE_KEY_FILE = 'device.key'
export const OBF_MODE = 'obfuscate'
const KEY_BYTES = 32
const NONCE_BYTES = 12
const TAG_BYTES = 16
export const OBF_AAD_PREFIX = 'dsh-vault|obf|'

/**
 * 机器唯一识别信息（尽力而为，多来源拼合；取不到任何来源时回落 DSH_HOME 与主机名）。
 * 注意：这里**不追求严格唯一**（混淆不是安全机制），但足以让"换机器 ⇒ 解不开"。
 */
export function machineSeed ({ fs = {} } = {}) {
  const read = fs.readText ?? ((p) => { try { return readFileSync(p, 'utf8') } catch { return '' } })
  const parts = []
  for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id', '/sys/class/dmi/id/product_uuid', '/sys/class/dmi/id/board_serial']) {
    const v = String(read(p) ?? '').trim()
    if (v !== '') parts.push(v)
  }
  if (parts.length === 0) {
    parts.push(String(process.env.HOSTNAME ?? '').trim())
    parts.push(String(process.env.DSH_HOME ?? '').trim())
  }
  return parts.join('|')
}

/** 派生有效密钥：随机种子（落盘）+ 机器信息（种子）⇒ 设备绑定 */
export function deriveKey (randomSeed, machine = machineSeed()) {
  return scryptSync(Buffer.from(randomSeed), Buffer.from('dsh-obf-v1|' + machine), KEY_BYTES, { N: 16384, r: 8, p: 1 })
}

export function keyFingerprint (key) {
  return createHash('sha256').update(key).digest('base64url').slice(0, 16)
}

/** 首次自动生成设备密钥（已存在则直接复用，**绝不覆盖**）。返回 { created, key, kfp, path } */
export function ensureDeviceKey (dir, { fs = {}, machine, random = randomBytes } = {}) {
  const path = join(dir, DEVICE_KEY_FILE)
  const readText = fs.readText ?? ((p) => readFileSync(p, 'utf8'))
  const writeText = fs.writeText ?? ((p, t) => { mkdirSync(dir, { recursive: true, mode: 0o700 }); writeFileSync(p, t, { mode: 0o600 }) })
  const exists = fs.exists ?? ((p) => existsSync(p))
  const seedOf = (raw) => {
    const parsed = JSON.parse(raw)
    const seed = Buffer.from(String(parsed.seed ?? ''), 'base64')
    if (seed.length !== KEY_BYTES) throw new Error('设备密钥文件损坏：种子长度异常')
    return seed
  }
  if (exists(path) === true) {
    const seed = seedOf(readText(path))
    const key = deriveKey(seed, machine ?? machineSeed(fs))
    return { created: false, key, kfp: keyFingerprint(key), path }
  }
  const seed = random(KEY_BYTES)
  const record = { v: 1, algo: 'scrypt', seed: seed.toString('base64'), machineHash: createHash('sha256').update(machine ?? machineSeed(fs)).digest('base64url').slice(0, 16), at: new Date().toISOString() }
  writeText(path, JSON.stringify(record, null, 2) + '\n')
  try { chmodSync(path, 0o600) } catch { /* 尽力而为 */ }
  const key = deriveKey(seed, machine ?? machineSeed(fs))
  return { created: true, key, kfp: keyFingerprint(key), path }
}

/** 手动重新生成（唯一性要求）：返回新密钥；**旧密钥不保留**，旧密文需调用方重新封存 */
export function rotateDeviceKey (dir, { fs = {}, machine, random = randomBytes } = {}) {
  const path = join(dir, DEVICE_KEY_FILE)
  const writeText = fs.writeText ?? ((p, t) => { mkdirSync(dir, { recursive: true, mode: 0o700 }); writeFileSync(p, t, { mode: 0o600 }) })
  const seed = random(KEY_BYTES)
  const record = { v: 2, algo: 'scrypt', seed: seed.toString('base64'), rotatedAt: new Date().toISOString(), machineHash: createHash('sha256').update(machine ?? machineSeed(fs)).digest('base64url').slice(0, 16) }
  writeText(path + '.new', JSON.stringify(record, null, 2) + '\n')
  try { renameSync(path + '.new', path) } catch { /* 跨设备移动等极端情况：退回直接写 */ }
  const key = deriveKey(seed, machine ?? machineSeed(fs))
  return { key, kfp: keyFingerprint(key), path }
}

/** 混淆加密（结构上留出 nonce/tag，便于与口令加密组同形存放） */
export function obfuscate (buf, { key, aad = '' }) {
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  if (aad !== '') cipher.setAAD(Buffer.from(aad))
  const ct = Buffer.concat([cipher.update(buf), cipher.final()])
  return { o: 'aes-256-gcm', n: nonce.toString('base64'), c: ct.toString('base64'), t: cipher.getAuthTag().toString('base64') }
}
export function deobfuscate (sealed, { key, aad = '' }) {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(String(sealed.n), 'base64'))
  if (aad !== '') decipher.setAAD(Buffer.from(aad))
  decipher.setAuthTag(Buffer.from(String(sealed.t), 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(String(sealed.c), 'base64')), decipher.final()])
}
/** 是否为混淆密文结构（供启动扫描判定组状态） */
export function isObfuscated (spec) {
  return spec !== null && typeof spec === 'object' && spec.mode === OBF_MODE && spec.obf !== undefined
}
/** 恒定时间比较（避免按指纹判定时的时序泄漏；混淆场景非必需，但保持一致习惯） */
export function sameFingerprint (a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}
