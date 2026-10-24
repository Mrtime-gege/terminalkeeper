/**
 * 审计链的**签名检查点链**（方案 1）。
 *
 * 目标：把「锚点」从同盘、未签名的 anchor.json，换成：
 *   · 只追加的 checkpoints.jsonl（每条 = 对当天链头的承诺）；
 *   · Ed25519 签名（密钥 0600，首次自动生成）；
 *   · 检查点自身串成链（prevCheckpointHash + 严格递增 seq）；
 *   · 可选**镜像**（另一块盘 / Windows 路径 / 任意目录），验证时比对两侧。
 *
 * 威胁模型（如实写）：
 *   ✓ 能发现：改/删单条审计记录、尾部截断、删整天文件（检查点仍在）、回滚检查点文件（镜像发现）、
 *            伪造检查点（签名验证失败）。
 *   ✗ 不能发现：同时删掉「整天文件 + 所有本地检查点 + 无镜像」；有同用户私钥者可伪造签名。
 *   结论：签名检查点把"可检测"范围扩大到本机同信任域之外；要防整盘清空，必须配镜像或外部时间戳。
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { verifyChain } from './audit.js'

const GENESIS = 'genesis'

export const CHECKPOINT_FILE = 'checkpoints.jsonl'
export const SIGNING_KEY_FILE = 'audit-signing.key'
export const SIGNING_PUB_FILE = 'audit-signing.pub'
const ALG = 'ed25519'
const V = 1

const sha256 = (text) => createHash('sha256').update(text).digest('hex')
const canonical = (cp) => JSON.stringify({
  v: V, seq: cp.seq, day: cp.day, head: cp.head,
  prevCheckpointHash: cp.prevCheckpointHash, ts: cp.ts, keyId: cp.keyId, note: cp.note ?? '',
})
export const checkpointHashOf = (cp) => sha256(canonical(cp) + '|' + String(cp.sig ?? ''))

const keyCache = new Map()

/** 读取/生成签名密钥（每个审计目录一把；0600，首次生成）。 */
export async function ensureSigningKey (dir) {
  const cached = keyCache.get(dir)
  if (cached !== undefined) return cached
  const keyPath = join(dir, SIGNING_KEY_FILE)
  const pubPath = join(dir, SIGNING_PUB_FILE)
  let privatePem = ''
  try { privatePem = await readFile(keyPath, 'utf8') } catch { /* 生成 */ }
  if (privatePem.trim() === '') {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const pair = generateKeyPairSync('ed25519')
    privatePem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' })
    const publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' })
    await writeFile(keyPath, privatePem, { mode: 0o600 })
    await writeFile(pubPath, publicPem, { mode: 0o644 })
  }
  const privateKey = createPrivateKey(privatePem)
  const publicKey = createPublicKey(privateKey)
  const keyId = sha256(publicKey.export({ type: 'spki', format: 'der' })).slice(0, 16)
  const info = {
    keyId,
    sign: (payload) => cryptoSign(null, Buffer.from(payload), privateKey).toString('base64'),
    verify: (payload, signature) => {
      try { return cryptoVerify(null, Buffer.from(payload), publicKey, Buffer.from(String(signature), 'base64')) } catch { return false }
    },
  }
  keyCache.set(dir, info)
  return info
}

/** 读取当前公钥（验证用；没有就返回 null）。 */
export async function readPublicVerifier (dir) {
  try {
    const pem = await readFile(join(dir, SIGNING_PUB_FILE), 'utf8')
    const publicKey = createPublicKey(pem)
    const keyId = sha256(publicKey.export({ type: 'spki', format: 'der' })).slice(0, 16)
    return {
      keyId,
      verify: (payload, signature) => {
        try { return cryptoVerify(null, Buffer.from(payload), publicKey, Buffer.from(String(signature), 'base64')) } catch { return false }
      },
    }
  } catch { return null }
}

/** 签名密钥信息（keyId + 文件路径 + 私钥权限），供面板如实展示。 */
export async function signingKeyInfo (dir) {
  const info = {
    keyFile: join(dir, SIGNING_KEY_FILE),
    pubFile: join(dir, SIGNING_PUB_FILE),
    keyId: '',
    keyMode: '',
    pubMode: '',
  }
  try { info.keyMode = ((await stat(info.keyFile)).mode & 0o777).toString(8) } catch { info.keyMode = '' }
  try { info.pubMode = ((await stat(info.pubFile)).mode & 0o777).toString(8) } catch { info.pubMode = '' }
  const verifier = await readPublicVerifier(dir)
  if (verifier !== null) info.keyId = verifier.keyId
  return info
}

export const checkpointsPathOf = (paths) => join(paths.dir, CHECKPOINT_FILE)
/** 兼容 { dir } 与 auditPaths() 两种入参。 */
const inputOf = (paths, day) => (typeof paths.input === 'function' ? paths.input(day) : join(String(paths.dir), 'audit-' + day + '.jsonl'))

/** 读检查点（解析失败的行原样记为 badLine，作为验证错误）。 */
export async function readCheckpoints (paths) {
  let raw = ''
  try { raw = await readFile(checkpointsPathOf(paths), 'utf8') } catch { return { list: [], bad: [] } }
  const list = []
  const bad = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    try {
      const cp = JSON.parse(line)
      if (cp === null || typeof cp !== 'object') throw new Error('not object')
      list.push(cp)
    } catch { bad.push(line.slice(0, 120)) }
  }
  return { list, bad }
}

/** 以当前审计文件状态建立基线（每个已有天一条检查点）。只在没有检查点时执行。 */
export async function ensureCheckpointBaseline (paths, { mirror = '', excludeDay = '' } = {}) {
  const current = await readCheckpoints(paths)
  if (current.list.length > 0) return { ok: true, created: 0 }
  let files = []
  try { files = await readdir(paths.dir) } catch { return { ok: true, created: 0 } }
  const days = files.filter((n) => /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort()
    .filter((n) => excludeDay === '' || !n.includes(String(excludeDay)))
  let created = 0
  for (const name of days) {
    const day = name.slice('audit-'.length, -'.jsonl'.length)
    const head = await lastHeadOf(paths, day)
    await appendCheckpoint(paths, { day, head, note: 'baseline', mirror })
    created += 1
  }
  return { ok: true, created }
}

async function lastHeadOf (paths, day) {
  try {
    const raw = await readFile(inputOf(paths, day), 'utf8')
    let head = GENESIS
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      try { const r = JSON.parse(line); if (typeof r.hash === 'string' && r.hash !== '') head = r.hash } catch { /* 跳过坏行 */ }
    }
    return head
  } catch { return GENESIS }
}

/**
 * 追加一个签名检查点。
 * @returns {{ok: boolean, cp: object|null, mirror: {configured: boolean, written: boolean, target: string, error: string}}}
 */
export async function appendCheckpoint (paths, { day, head, note = '', mirror = '' } = {}) {
  await mkdir(paths.dir, { recursive: true, mode: 0o700 })
  // 没有检查点但已有审计文件：先建基线（避免把历史天永久置于"无检查点"状态）
  const before = await readCheckpoints(paths)
  if (before.list.length === 0) {
    let files = []
    try { files = await readdir(paths.dir) } catch { files = [] }
    const history = files.filter((n) => /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))
    // 只对**其它**历史天建基线；当天由本次 appendCheckpoint 负责（否则同一天会出现两条重复承诺）
    if (history.some((n) => !n.includes(String(day)))) {
      await ensureCheckpointBaseline(paths, { mirror, excludeDay: day })
    }
  }
  const current = await readCheckpoints(paths)
  const last = current.list.length > 0 ? current.list[current.list.length - 1] : null
  const info = await ensureSigningKey(paths.dir)
  const cp = {
    v: V,
    seq: last === null ? 1 : Number(last.seq) + 1,
    day: String(day),
    head: String(head ?? GENESIS),
    prevCheckpointHash: last === null ? GENESIS : checkpointHashOf(last),
    ts: Date.now(),
    keyId: info.keyId,
    note: String(note ?? ''),
  }
  cp.sig = info.sign(canonical(cp))
  const line = JSON.stringify(cp)
  await appendFile(checkpointsPathOf(paths), line + '\n', { mode: 0o600 })
  const mirrorResult = { configured: mirror !== '', written: false, target: '', error: '' }
  if (mirror !== '') {
    try {
      const target = mirror.endsWith('.jsonl') ? mirror : join(mirror, CHECKPOINT_FILE)
      await mkdir(dirname(target), { recursive: true })
      await appendFile(target, line + '\n', { mode: 0o600 })
      mirrorResult.written = true
      mirrorResult.target = target
    } catch (error) {
      mirrorResult.error = String(error?.message ?? error)
    }
  }
  return { ok: true, cp, mirror: mirrorResult }
}

/** 读镜像检查点（没有/不可读就返回 null）。 */
async function readMirrorCheckpoints (mirror) {
  if (mirror === '') return null
  const target = mirror.endsWith('.jsonl') ? mirror : join(mirror, CHECKPOINT_FILE)
  try {
    const raw = await readFile(target, 'utf8')
    const list = []
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      try { list.push(JSON.parse(line)) } catch { /* 跳过坏行 */ }
    }
    return { target, list }
  } catch { return { target, list: null } }
}

/**
 * 验证检查点链 + 审计文件状态 + 镜像。
 * @returns {{ok: boolean, count: number, lastSeq: number, lastDay: string, keyId: string,
 *   errors: string[], warnings: string[], mirror: object}}
 */
export async function verifyCheckpoints (paths, { mirror = '', retentionDays = 30 } = {}) {
  const errors = []
  const warnings = []
  const { list, bad } = await readCheckpoints(paths)
  for (const line of bad) errors.push(`检查点行不可解析：${line}`)
  const verifier = await readPublicVerifier(paths.dir)
  if (list.length === 0) {
    let files = []
    try { files = await readdir(paths.dir) } catch { files = [] }
    const auditFiles = files.filter((n) => /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))
    const mirrorState = { configured: mirror !== '', ok: null, detail: mirror === '' ? '未配置' : '' }
    // ⚠ 关键：本地检查点被删光时**必须**看镜像 —— 否则"删掉本地检查点"就能逃过检测。
    const mirrored = await readMirrorCheckpoints(mirror)
    if (mirrored !== null && mirrored.list !== null && mirrored.list.length > 0) {
      errors.push(`本地检查点文件缺失或为空，但镜像有 ${mirrored.list.length} 个检查点（本地被清空/回滚？）`)
      mirrorState.ok = false
      mirrorState.detail = `镜像有 ${mirrored.list.length} 个检查点，本地 0 个`
    } else if (mirrored !== null && mirrored.list === null) {
      mirrorState.ok = false
      mirrorState.detail = `镜像不可读：${mirrored.target}`
      warnings.push(`镜像不可读（${mirrored.target}）`)
      if (auditFiles.length === 0) {
        warnings.push('目录与镜像里都没有可验证记录（全新安装，或已被完全清空 —— 无法区分）')
      }
    } else if (mirror !== '') {
      mirrorState.ok = true
      mirrorState.detail = '镜像也没有检查点'
      warnings.push('镜像目录里没有检查点（可能还没写入过）')
    }
    if (auditFiles.length > 0) {
      warnings.push('还没有签名检查点（可运行 verify-audit --baseline 立即建立；否则新写入会自动建立）')
    } else if (mirrored === null || (mirrored.list !== null && mirrored.list.length === 0)) {
      warnings.push('目录与镜像里都没有可验证记录（全新安装，或已被完全清空 —— 这种情况无法区分）')
    }
    return { ok: errors.length === 0, count: 0, lastSeq: 0, lastDay: '', keyId: '', errors, warnings, mirror: mirrorState }
  }
  if (verifier === null) errors.push('缺少验签公钥（audit-signing.pub）：无法验证检查点签名')
  let expectedSeq = 1
  let expectedPrev = GENESIS
  let last = null
  for (const cp of list) {
    if (Number(cp.seq) !== expectedSeq) errors.push(`检查点 seq 不连续：期望 ${expectedSeq}，实际 ${cp.seq}`)
    if (String(cp.prevCheckpointHash ?? '') !== expectedPrev) errors.push(`检查点 #${cp.seq} 的前驱哈希不匹配（检查点链被改/被删）`)
    if (cp.keyId !== (verifier === null ? cp.keyId : verifier.keyId)) errors.push(`检查点 #${cp.seq} 的 keyId 与当前公钥不一致（换了密钥或伪造）`)
    if (verifier !== null && verifier.verify(canonical(cp), cp.sig) !== true) errors.push(`检查点 #${cp.seq} 签名无效（内容被改或非本机私钥签发）`)
    expectedSeq += 1
    expectedPrev = checkpointHashOf(cp)
    last = cp
  }
  // 每天最新检查点 vs 当前文件
  const latestByDay = new Map()
  for (const cp of list) latestByDay.set(String(cp.day), cp)
  for (const [day, cp] of latestByDay) {
    const file = inputOf(paths, day)
    let lines = []
    try {
      const raw = await readFile(file, 'utf8')
      lines = raw.split('\n').filter((l) => l.trim() !== '')
    } catch {
      // 保留期内的文件缺失 = 值得追（可能是删证据）；早于保留期的天按策略轮转/清理属正常。
      const ageDays = Math.floor((Date.now() - Date.parse(day + 'T00:00:00')) / 86400000)
      if (Number.isFinite(ageDays) && ageDays > retentionDays) {
        warnings.push(`${day}：已超出保留期（${retentionDays} 天），文件按策略清理（检查点仍保留历史承诺）`)
      } else {
        errors.push(`${day}：文件不存在，但检查点承诺了 head ${String(cp.head).slice(0, 12)}…（被删/被轮换后没有重新记录）`)
      }
      continue
    }
    // ① 先验哈希链本身（中间记录被改/删/重排，head 可能不变，必须逐条验）
    const records = []
    for (const line of lines) {
      try { records.push(JSON.parse(line)) } catch { /* 坏行在下面计数里体现 */ }
    }
    const chainCheck = verifyChain(records, { startHead: GENESIS })
    if (chainCheck.ok !== true) {
      errors.push(`${day}：哈希链断裂于第 ${(chainCheck.brokenAt?.index ?? -1) + 1} 条（${chainCheck.brokenAt?.reason ?? '?'}）`)
    }
    let lastHash = ''
    let idx = -1
    for (let i = 0; i < lines.length; i += 1) {
      try { const r = JSON.parse(lines[i]); if (typeof r.hash === 'string' && r.hash !== '') { lastHash = r.hash; if (r.hash === cp.head) idx = i } } catch { /* 跳过坏行 */ }
    }
    if (lastHash === cp.head) continue
    if (idx < 0) errors.push(`${day}：检查点的 head 不在当前文件里（尾部被截断/替换）`)
    else warnings.push(`${day}：检查点之后还有 ${lines.length - idx - 1} 条记录（可能是崩溃窗口；下次写入会补检查点）`)
  }
  // 镜像
  const mirrorState = { configured: mirror !== '', ok: null, detail: mirror === '' ? '未配置' : '' }
  if (mirror !== '') {
    const mirrored = await readMirrorCheckpoints(mirror)
    if (mirrored === null) {
      mirrorState.detail = '未配置'
    } else if (mirrored.list === null) {
      mirrorState.ok = false
      mirrorState.detail = `镜像不可读：${mirrored.target}`
      warnings.push(`镜像不可读（${mirrored.target}）`)
    } else {
      const localBySeq = new Map(list.map((cp) => [Number(cp.seq), cp]))
      const mirrorBySeq = new Map(mirrored.list.map((cp) => [Number(cp.seq), cp]))
      let missingLocal = 0
      let different = 0
      for (const [seq, mcp] of mirrorBySeq) {
        const lcp = localBySeq.get(seq)
        if (lcp === undefined) { missingLocal += 1; continue }
        if (checkpointHashOf(lcp) !== checkpointHashOf(mcp)) different += 1
      }
      if (missingLocal > 0) {
        mirrorState.ok = false
        mirrorState.detail = `镜像有 ${missingLocal} 个本地没有的检查点（本地被回滚/截断？）`
        errors.push(mirrorState.detail)
      } else if (different > 0) {
        mirrorState.ok = false
        mirrorState.detail = `镜像与本地有 ${different} 个同序号检查点内容不同`
        errors.push(mirrorState.detail)
      } else if (mirrored.list.length < list.length) {
        mirrorState.ok = true
        mirrorState.detail = `镜像落后 ${list.length - mirrored.list.length} 个检查点`
        warnings.push(mirrorState.detail)
      } else {
        mirrorState.ok = true
        mirrorState.detail = `一致（${mirrored.list.length} 个）`
      }
    }
  }
  return {
    ok: errors.length === 0,
    count: list.length,
    lastSeq: last === null ? 0 : Number(last.seq),
    lastDay: last === null ? '' : String(last.day),
    keyId: verifier === null ? '' : verifier.keyId,
    errors,
    warnings,
    mirror: mirrorState,
  }
}
