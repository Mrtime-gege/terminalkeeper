/**
 * 审计：**输入流水** + **终端输出留痕**。
 *
 * 为什么这两个面合起来才叫"可审计"：
 *
 *   * 进入终端的**每一个字节**都只经过两个入口 —— 工具 `shell_send` 与面板的 HTTP `/keys`
 *     （没有第三条路）。所以在这两个入口记账，输入面就是**完整**的：谁、什么时间、往哪个
 *     shell、发了什么、有没有被护栏拦下、结果如何。
 *   * 但输入不等于现场。`pipe-pane` 记的是窗格**输出**（含回显的命令、程序输出、
 *     TUI 画面），它回答"实际发生了什么"，而且在会话被关掉之后**文件依然在** ——
 *     这正是"关闭会话后依然可见"。
 *
 * 本文件只放**纯函数与落盘原语**，不含任何 Cordis/宿主依赖，因此可以离线测试：
 * 行格式、轮转计划、上限判定、记录裁剪都在这里定死。
 *
 * @module terminalkeeper/audit
 */

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { appendFile, mkdir, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { appendCheckpoint } from './audit-checkpoints.mjs'
import { existsSync, cpSync } from 'node:fs'
import { join, dirname } from 'node:path'

const execFileAsync = promisify(execFile)

/** 单条记录里 `text` 字段的落盘上限：超过就截断并标记，避免一条 heredoc 撑爆日志。 */
export const TEXT_LIMIT = 16 * 1024

/** 哈希链的创世前驱：第一条封链记录的 `prevHash` 就是它。 */
export const GENESIS = 'genesis'

/** 链上使用的摘要算法（纯 JS，跨平台一致；不依赖任何外部工具）。 */
export const HASH_ALGO = 'sha256'

/** 审计目录：`${DSH_HOME:-~/.dsh}/terminalkeeper`。 */
export function auditDirFor(env = {}, home = '') {
  const base = typeof env.DSH_HOME === 'string' && env.DSH_HOME !== ''
    ? env.DSH_HOME
    : join(home === '' ? '.' : home, '.dsh')
  return join(base, 'terminalkeeper')
}

/** 旧数据目录名（改名前的 `agent-shell`）：仅用于一次性迁移，不再写入。 */
export const LEGACY_DIR_NAME = 'agent-shell'

/**
 * 改名迁移（terminalkeeper ↔ agent-shell）：新目录**不存在**而旧目录存在时，把旧目录
 * 复制到新位置（cpSync，保留时间戳/权限），旧目录原样保留作回退。目录已存在则跳过。
 * 复制是幂等的：中途失败下次再跑（目标目录可能半成品，失败时清掉重来由调用方决定）。
 */
export function migrateLegacyDataDir (dir) {
  try {
    if (typeof dir !== 'string' || dir === '') return false
    const legacy = join(dirname(dir), LEGACY_DIR_NAME)
    if (existsSync(dir) || !existsSync(legacy)) return false
    cpSync(legacy, dir, { recursive: true, force: true, preserveTimestamps: true })
    console.warn(`terminalkeeper: 已把旧数据目录 ${legacy} 复制到 ${dir}（旧目录保留，可回退）`)
    return true
  } catch (error) {
    console.warn('terminalkeeper: 旧数据目录迁移失败（可手动运行 scripts/migrate-data.mjs）：' + String(error?.message ?? error))
    return false
  }
}

/** 审计目录下的固定布局。 */
export function auditPaths(dir) {
  return {
    dir,
    input: (day) => join(dir, `audit-${day}.jsonl`),
    owners: join(dir, 'sessions.json'),
    consent: join(dir, 'consent.json'),
    outputDir: join(dir, 'output'),
  }
}

/** `YYYY-MM-DD`（本地时区：人看日志时按本地日记事最自然）。 */
export function dayKey(ms) {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * 把一条记录裁剪到可安全落盘的大小。
 *
 * `text` 可能是一整段 heredoc，原样写进去会让日志迅速膨胀且难以阅读；截断后仍保留
 * 字节数与 `truncated` 标记 —— **删掉信息要留痕**，否则审计本身就在撒谎。
 */
export function trimRecord(record, limit = TEXT_LIMIT) {
  const out = { ...record }
  for (const key of ['text', 'newName']) {
    const value = out[key]
    if (typeof value === 'string' && value.length > limit) {
      out[key] = value.slice(0, limit)
      out[key + 'Truncated'] = true
      out[key + 'Bytes'] = Buffer.byteLength(value, 'utf8')
    }
  }
  if (typeof out.text === 'string' && out.textBytes === undefined) {
    out.textBytes = Buffer.byteLength(out.text, 'utf8')
  }
  return out
}

/** 一行 JSONL。序列化失败绝不抛 —— 审计不能反过来把 shell 弄坏。 */
export function formatAuditLine(record) {
  try {
    return JSON.stringify(trimRecord(record)) + '\n'
  } catch {
    return JSON.stringify({ ts: Date.now(), event: 'audit-serialize-failed' }) + '\n'
  }
}

/* ── 哈希链（审计不可篡改的地基）─────────────────────────────────────────────
 *
 * 目标（维护者定）：**审计可审计且不可篡改**。做法不是在写入路径上做权限（同用户模型下
 * 拦不住），而是让"改动过"这件事**无法隐藏**：
 *
 *   · 每条记录携带 `prevHash`（前一条的摘要）与 `hash`（自身的摘要）；
 *   · 摘要覆盖整条记录（键排序后的规范化 JSON），并链上前一条的摘要；
 *   · 删一条、改一个字节、调换顺序 —— 都会让后续所有 `prevHash`/`hash` 对不上。
 *
 * 校验只读、纯函数、零依赖（node:crypto 内建），因此可离线单测。
 * 没有 `hash`/`prevHash` 的历史记录视为"未封链"，跳过而不判为断链（老日志仍可读）。
 */

/** 规范化值：对象按键排序，数组保序；`undefined`/函数等不可序列化值统一成 null。 */
function stableValue(value) {
  if (value === null || value === undefined) return null
  if (Array.isArray(value)) return value.map(stableValue)
  if (typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) {
      // ⚠ undefined 键必须**丢弃**而不是变 null：落盘走 JSON.stringify（undefined 键被省略），
      // 校验方 parse 回来的对象里没有这个键 —— 若哈希时当 null，写入方与校验方的规范化
      // 就不同口径 → 链从该记录起全部失验（0.3.0 实测：open 带 idleMinutes:undefined
      // 时"断链于第 4 条"）。数组元素里的 undefined 仍按 JSON 语义成 null。
      if (value[key] === undefined) continue
      out[key] = stableValue(value[key])
    }
    return out
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value)
  if (typeof value === 'bigint') return String(value)
  return value
}

/**
 * 规范化 JSON（不含 `hash` 与 `prevHash`）：**同一记录在任何环境下得到同一字符串**，这是摘要可复算的前提。
 * 键排序保证对象字面量顺序不影响结果；`undefined` 键**丢弃**（与落盘的 JSON.stringify 同口径：
 * 写出去的行里就没有这个键，校验方 parse 回来也没有 —— 两边必须一致，否则链从该条起全断，
 * 0.3.0 实测踩过：open 记录带 idleMinutes:undefined 时"断链于第 4 条"）。
 * `prevHash` 不参与摘要：它是**链接参数**（连接前一条），写进记录里只是为了校验时能复算；
 * 若把它规范进内容，排序/别名会影响摘要，反而失去"仅凭内容可复算"的性质。
 */
export function canonicalize(record) {
  const clean = {}
  for (const key of Object.keys(record ?? {}).sort()) {
    if (key === 'hash' || key === 'prevHash') continue
    if (record[key] === undefined) continue
    clean[key] = stableValue(record[key])
  }
  return JSON.stringify(clean)
}

/** 计算一条记录的摘要：`H(prevHash + '\n' + canonical(record))`。 */
export function hashRecord(prevHash, record) {
  return createHash(HASH_ALGO)
    .update(String(prevHash) + '\n' + canonicalize(record), 'utf8')
    .digest('hex')
}

/** 封链：补上 `prevHash` 与 `hash`，返回可直接落盘的新对象（不改原对象）。 */
export function sealRecord(prevHash, record) {
  const trimmed = trimRecord(record)
  const withPrev = { ...trimmed, prevHash: String(prevHash) }
  return { ...withPrev, hash: hashRecord(withPrev.prevHash, withPrev) }
}

/**
 * 校验一条链（按时间顺序的记录数组）。
 *
 * @param {Array<object>} records
 * @param {{startHead?: string, allowLegacy?: boolean}} [options]
 * @returns {{ok: boolean, brokenAt: null|{index:number, ts?:number, reason:string}, sealed:number,
 *            startUnknown:boolean, head:string, checked:number}}
 */
export function verifyChain(records, options = {}) {
  const list = Array.isArray(records) ? records : []
  const startHead = typeof options.startHead === 'string' && options.startHead !== '' ? options.startHead : GENESIS
  let head = startHead
  let sealed = 0
  let startUnknown = false
  let broken = null

  // 0.2.2 起**不向前兼容**：每条记录都必须带 prevHash/hash（链路封死），
  // 缺一半的直接判断链（unsealed）—— 历史未封链记录已在升级时清空，不存在"旧格式要容忍"。
  for (let i = 0; i < list.length; i += 1) {
    const rec = list[i]
    const hasHash = rec !== null && typeof rec === 'object' && typeof rec.hash === 'string' && rec.hash !== ''
    const hasPrev = rec !== null && typeof rec === 'object' && typeof rec.prevHash === 'string' && rec.prevHash !== ''
    if (!hasHash || !hasPrev) {
      broken = { index: i, ts: typeof rec?.ts === 'number' ? rec.ts : undefined, reason: 'unsealed' }
      break
    }
    // 起点未知：更早的文件没读到（被删/超范围），第一条 prevHash 对不上创世 ——
    // 这本身值得提示，但不应冒充"断链"（我们无法证明它断）。
    if (sealed === 0 && head === GENESIS && rec.prevHash !== GENESIS) {
      // ⚠ 安全修复（BUG-1）：起点未知 ≠ **免检**。
      // 以前这里直接信任 rec.hash 就往下走 —— 删掉最旧一天的文件后，新的首条记录内容可以被
      // 任意改写而验证依旧 ok（实测：删首文件 + 改新首条 → ok:true / brokenAt:null）。
      // 首条记录同样必须用**它自己声明的 prevHash** 复算摘要：这样"改字段但没重算 hash"
      // 一定会被抓到。（对手若连 hash 一起重算，在没有链外锚的前提下无法证明 —— 那正是
      // anchor.json 存在的意义，见 readSealedChain 的锚比对。）
      if (hashRecord(rec.prevHash, rec) !== rec.hash) {
        broken = {
          index: i,
          ts: typeof rec.ts === 'number' ? rec.ts : undefined,
          reason: 'hash-mismatch',
          hint: 'chain-head',
        }
        break
      }
      startUnknown = true
      head = rec.hash
      sealed += 1
      continue
    }
    if (rec.prevHash !== head) {
      // 诊断而非只报"断了"：新实例（进程重启 / **配置热重载**）的链头是异步从磁盘读回的，
      // 读回完成前到达的记录会封在创世前驱上 —— 表现就是"某条记录的 prevHash=genesis 而前一条
      // 并非 genesis"。0.2.3 真机实测（第 467 条）：热重载后面板 consent 抢跑。
      // 这不是篡改迹象（篡改会改 hash 或删行），但仍如实报为断链 + 给出提示。
      const coldStart = i > 0 && rec.prevHash === GENESIS
      broken = {
        index: i,
        ts: typeof rec.ts === 'number' ? rec.ts : undefined,
        reason: 'prev-mismatch',
        hint: coldStart ? 'cold-start-genesis' : '',
      }
      break
    }
    const expected = hashRecord(rec.prevHash, rec)
    if (expected !== rec.hash) {
      broken = { index: i, ts: typeof rec.ts === 'number' ? rec.ts : undefined, reason: 'hash-mismatch' }
      break
    }
    head = rec.hash
    sealed += 1
  }

  return { ok: broken === null, brokenAt: broken, sealed, startUnknown, head, checked: list.length }
}
/** 链外锚文件名（与链文件同目录）。 */
export const ANCHOR_FILE = 'anchor.json'

/**
 * 链外锚（BUG-2）：链式结构只能证明"中间没被改"，**尾部截断天然检不出来**
 * （删掉最后一条记录，剩下仍然自洽）。锚把每日的 head + 记录数留在链外，验证时比对。
 *
 * 注意这只是**提高门槛**：锚与链同机同盘，能改链的人通常也能改锚。它把"静默截断"
 * 变成"必须再改一个文件"，并且让 verify 能报出来。
 *
 * @param {{dir: string}} paths - 审计目录。
 * @returns {Promise<{v: number, days: Record<string, {head: string, records: number, bytes: number}>} | null>}
 */
export async function readAnchor(paths) {
  try {
    const raw = await readFile(join(paths.dir, ANCHOR_FILE), 'utf8')
    const obj = JSON.parse(raw)
    if (obj === null || typeof obj !== 'object') return null
    if (obj.days === null || typeof obj.days !== 'object') return null
    return obj
  } catch {
    return null
  }
}

/** 写锚（0o600，与链文件同级）。失败不抛：审计写入不该因为锚失败而失败。 */
export async function writeAnchor(paths, anchor) {
  try {
    await writeFile(join(paths.dir, ANCHOR_FILE), JSON.stringify(anchor), { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

/**
 * 追加封链记录**之后**更新当日锚：head 用刚封好的摘要，记录数在首次统计当日文件、
 * 之后逐条 +1（校验时只比对"锚 > 实际"，所以锚短暂滞后不会误报）。
 *
 * @param {{dir: string, input: (day: string) => string}} paths - 审计路径。
 * @param {string} day - 当日键。
 * @param {string} head - 刚封好的链头。
 * @returns {Promise<boolean>} 是否写入成功。
 */
export async function updateAnchor(paths, day, head) {
  const anchor = (await readAnchor(paths)) ?? { v: 1, days: {} }
  const prev = anchor.days[day]
  if (prev === undefined || typeof prev.records !== 'number') {
    const raw = await readFile(paths.input(day), 'utf8').catch(() => '')
    anchor.days[day] = {
      head,
      records: raw.split('\n').filter((l) => l.trim() !== '').length,
      bytes: Buffer.byteLength(raw, 'utf8'),
    }
  } else {
    anchor.days[day] = { head, records: prev.records + 1, bytes: prev.bytes }
  }
  return writeAnchor(paths, anchor)
}

/** 解析一行 JSONL；坏行返回 null（日志里可能有半截写入）。 */
export function parseAuditLine(line) {
  const trimmed = String(line).trim()
  if (trimmed === '') return null
  try {
    const parsed = JSON.parse(trimmed)
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * 该保留哪些按天划分的审计文件。
 *
 * 输入的纯函数：给定文件名列表与"今天"，算出要删哪些。保留期外的删掉；
 * 文件名不符合 `audit-YYYY-MM-DD.jsonl` 的一律保留（不认识的别乱删）。
 */
export function prunePlan(files, todayKey, retentionDays) {
  const keep = []
  const remove = []
  const cutoff = Date.parse(todayKey + 'T00:00:00Z') - (retentionDays - 1) * 86400000
  for (const name of files) {
    const match = /^audit-(\d{4})-(\d{2})-(\d{2})\.jsonl$/.exec(name)
    if (match === null) { keep.push(name); continue }
    const stamp = Date.parse(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`)
    if (!Number.isFinite(stamp)) { keep.push(name); continue }
    if (stamp < cutoff) remove.push(name)
    else keep.push(name)
  }
  return { keep, remove }
}

/** 输出留痕的会话文件名：`<shell>-<起始时间戳>.log`（时间戳让同一名字的复用不互相覆盖）。 */
export function outputFileFor(shell, startedAtMs) {
  const safe = String(shell).replace(/[^A-Za-z0-9._-]/g, '')
  return `${safe === '' ? 'shell' : safe}-${String(startedAtMs)}.log`
}

/** 供查询结果里展示的一行摘要（纯函数，面板与工具共用同一份措辞）。 */
export function summarizeRecord(record) {
  const time = new Date(record.ts ?? 0).toISOString().replace('T', ' ').slice(0, 19) + 'Z'   // Z = UTC，避免被误读成本地时间
  const event = String(record.event ?? '?')
  const shell = String(record.shell ?? '-')
  const actor = String(record.actor ?? '-')
  const source = String(record.source ?? '-')
  let detail = ''
  if (event === 'input') {
    const parts = []
    if (typeof record.text === 'string' && record.text !== '') parts.push(JSON.stringify(record.text.length > 80 ? record.text.slice(0, 80) + '…' : record.text))
    if (Array.isArray(record.keys) && record.keys.length > 0) parts.push('keys=' + record.keys.join(','))
    if (Array.isArray(record.preKeys) && record.preKeys.length > 0) parts.push('preKeys=' + record.preKeys.join(','))
    detail = parts.join(' ') || '(空输入)'
    if (record.guard !== undefined && record.guard !== 'allowed') detail += ` [护栏:${record.guard}]`
  } else if (event === 'open' || event === 'close' || event === 'rename') {
    detail = event === 'rename' ? `→ ${String(record.newName ?? '-')}` : String(record.result ?? '')
  } else if (event === 'tool-call') {
    // 工具名是这条记录的全部价值所在（"AI 调过哪些工具"），必须打出来
    detail = String(record.tool ?? '?') + (record.session !== undefined && String(record.session) !== '' ? ' session=' + String(record.session) : '')
  } else if (event === 'consent' || event === 'panel-lock') {
    detail = [record.decision, record.result].filter((x) => x !== undefined && x !== '').map(String).join(' ')
  } else if (event === 'config' || event === 'env-degraded') {
    detail = [record.key, record.capability, record.fallback, record.result].filter((x) => x !== undefined && x !== '').map(String).join(' ')
  } else if (event === 'capture' || event === 'replay') {
    // 留痕/回放录制：结论 + 文件名（面板与 CLI 摘要行里一眼看到写到哪、停没停）
    detail = [record.result, record.file === undefined ? '' : String(record.file).split('/').pop()].filter((x) => x !== '' && x !== undefined).join(' ')
  }
  return `${time} ${event.padEnd(6)} ${shell.padEnd(16)} ${source.padEnd(6)} ${actor.padEnd(18)} ${detail}`
}

/* ── 以下是有副作用的最小原语：全部 best-effort，失败绝不冒泡到 shell 操作 ─────────── */

/** 创建审计目录（0700：审计内容可能含敏感信息，不给同机其它用户读）。 */
export async function ensureAuditDir(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  return dir
}

/**
 * 追加一条审计记录。**绝不抛**：写失败（磁盘满、权限、只读）只回报 false ——
 * 让"记不下来"变成一个可观测的事实，而不是把用户正在做的事情弄失败。
 *
 * @param {object} paths 审计目录布局
 * @param {string} day 日期键
 * @param {object} record 记录
 * @param {{head?: string, seq?: number}|null} [chain] 传入则封链（写入 `prevHash`/`hash` 并推进链头）。
 *   **先落盘成功再推进链头** —— 否则内存链头会与磁盘不一致，之后每条都会"断链"。
 */
// 封链写入必须**串行**：并发调用若都读取同一个旧 chain.head，两条记录会都从该头起算，
// 后写的那条 prevHash 对不上前一条 → 断链（0.2.2 真机实测：插件自动留痕的 capture 与 open
// 并发，3ms 内两条 prevHash 都是 genesis → prev-mismatch）。用模块级 promise 队列把
// 「读头 → seal → append → 推进头」整段排队执行。
let sealQueue = Promise.resolve()

/**
 * 读取某天审计文件的**最后一条**记录的 hash —— 这就是跨进程的"真实链头"。
 * 只读文件尾部 16KB（当天文件可能上 MB，而每次封链都会调用它）。
 * 返回 '' 表示文件不存在/为空/读不到（调用方回落到内存链头）。
 */
async function lastHashOf (file) {
  try {
    const st = await stat(file)
    if (!Number.isFinite(st.size) || st.size === 0) return ''
    const len = Math.min(16384, st.size)
    const fh = await open(file, 'r')
    try {
      const buf = Buffer.alloc(len)
      await fh.read(buf, 0, len, st.size - len)
      const lines = buf.toString('utf8').split('\n').filter((l) => l.trim() !== '')
      const last = lines[lines.length - 1]
      if (last === undefined) return ''
      try { const o = JSON.parse(last); return typeof o?.hash === 'string' ? o.hash : '' } catch { return '' }
    } finally { await fh.close() }
  } catch { return '' }
}

/**
 * 跨进程互斥（无第三方依赖）：用 `O_EXCL` 锁文件把"读链头 + 追加一行"包成临界区。
 * 为什么需要：appendAudit 已改为以磁盘末条为 prev，但两个进程若在**同一瞬间**读+写，
 * 仍有一个极窄的竞态窗口（读到的末条可能马上被对方追加覆盖）。锁把它关死。
 * 取舍：**拿不到锁也照写**（宁可写入、绝不丢审计）；锁文件过旧（>10s）视为陈锁回收。
 */
async function withChainLock (paths, fn) {
  const lock = join(paths.dir, '.chain.lock')
  const deadline = Date.now() + 5000
  let held = false
  while (held !== true) {
    try {
      const fh = await open(lock, 'wx')
      await fh.writeFile(String(process.pid))
      await fh.close()
      held = true
    } catch (e) {
      if (e && e.code === 'EEXIST') {
        try {
          const st = await stat(lock)
          if (Date.now() - st.mtimeMs > 10000) { await rm(lock, { force: true }); continue }
        } catch { /* 忽略 */ }
        if (Date.now() > deadline) return fn()          // 超时：不阻塞审计写入
        await new Promise((r) => setTimeout(r, 25))
        continue
      }
      return fn()                                        // 锁不可用（只读 fs 等）⇒ 退化为无锁
    }
  }
  try { return await fn() } finally { await rm(lock, { force: true }).catch(() => {}) }
}

export function appendAudit(paths, day, record, chain = null) {
  const task = async () => {
    try {
      // 目录由这里保证：调用方（工具/HTTP/授权）不该为了记一笔日志先关心 mkdir 顺序。
      // 实测踩到过：目录还没建就写 consent/owners，静默失败 → 新实例读不到授权、重复问用户。
      await ensureAuditDir(paths.dir)
      if (chain !== null && typeof chain === 'object') {
        return await withChainLock(paths, async () => {
        // 链头就绪闸门：`chain.head` 在进程/插件实例启动时是 'genesis'，真正的链头要等
        // 异步从磁盘读回（index.js 的 state.ready 里）。在此之前到达的写入（面板请求、
        // 工具调用、甚至启动流程自己的 env-degraded）如果直接封链，就会把新实例的第一条
        // 封在创世前驱上 → 整条链从那里断掉（0.2.3 真机实测：热重载后第 467 条
        // prev-mismatch，prevHash=genesis）。这里排队等它就位再封。
        if (chain.ready !== undefined && chain.ready !== null && typeof chain.ready.then === 'function') {
          try { await chain.ready } catch { /* 读盘失败：按当前头继续，至少不阻塞审计写入 */ }
        }
        // 追加前**从磁盘重读该天文件最后一条的 hash** 作为 prev（而不是只用内存链头）。
        // 为什么（2026-10 用户实测到链分叉）：链头曾只存在内存里 ⇒ 另一个进程（purge-audit CLI）
        // 直接追加两条 purge 见证后，本进程仍按旧头续写 ⇒ 链并行成两条分支 ⇒ verify 报
        // prev-mismatch（第 1887 条）。现在每次封链前以磁盘为准 ⇒ CLI/面板/工具/多实例都不再分叉。
        // 每天各自成链（2026-10 用户提议，采纳）：新的一天**从创世开始**，不再继承前一天的链头。
        // 这样"链头被删/跨日断裂"这类问题不再存在——单天文件自身闭合即可证明完整性；
        // 跨天篡改由 anchor.json 里的**逐天** head 承诺拦住（本来就已经按天存）。
        const onDiskHead = await lastHashOf(paths.input(day))
        const prevHead = onDiskHead !== '' ? onDiskHead : GENESIS
        const sealed = sealRecord(prevHead, record)
        await appendFile(paths.input(day), JSON.stringify(sealed) + '\n', { mode: 0o600 })
        chain.head = sealed.hash
        chain.seq = (Number.isFinite(chain.seq) ? chain.seq : 0) + 1
        // 方案 1：写入后追加**签名检查点**（Ed25519 + 检查点链）。
        // 失败不阻塞审计写入本身，但会在 verify 里显示"未签检查点"。
        await appendCheckpoint(paths, {
          day, head: sealed.hash,
          mirror: typeof chain.mirror === 'string' ? chain.mirror : '',
        }).catch(() => {})
        return true
        })
      }
      await appendFile(paths.input(day), formatAuditLine(record), { mode: 0o600 })
      return true
    } catch {
      return false
    }
  }
  sealQueue = sealQueue.then(task, task)
  return sealQueue
}

/**
 * 逐天校验：**每天一个独立链**（首条 prevHash = 创世）。
 *
 * 历史遗留：切换前的旧文件是跨天相连的（某天首条的 prevHash = 前一天末条）⇒ 这种情况按
 * "起点未知但自证"处理（verifyChain 会用它自己声明的 prevHash 复算摘要，改字段必被抓），
 * 并如实标注 legacyLinked，不冒充断链、也不免检。
 */
export async function verifyAuditDays (paths) {
  // 两种入参都接受：完整的 paths 对象（宿主用），或 { dir } / 目录字符串（CLI 用）。
  // ⚠ 这正是本轮踩到的坑：CLI 传 { dir }，而内部用 paths.input(day) 读文件 ⇒ 抛错被 catch
  //   吞掉 ⇒ 逐天结果全是 0 条（看起来"每天都没记录"）。
  const p = (paths !== null && typeof paths === 'object' && typeof paths.input === 'function')
    ? paths
    : auditPaths(String(paths?.dir ?? paths ?? ''))
  const names = await auditFileNames(p)
  const out = []
  let sealedAll = 0
  let totalAll = 0
  let okAll = true
  for (const name of names) {
    const dayKeyOfName = name.replace(/^audit-/, '').replace(/\.jsonl$/, '')
    const records = await readAudit(p, dayKeyOfName, { limit: Number.MAX_SAFE_INTEGER })
    const res = verifyChain(records, { startHead: GENESIS })
    const first = records.length > 0 ? records[0] : null
    const legacyLinked = records.length > 0 && first !== null && typeof first === 'object' && first.prevHash !== GENESIS
    out.push({
      day: dayKeyOfName,     // ⚠ 必须是**日键**（此前写成文件名，调用方按日键找不到）
      file: name,
      ok: res.ok,
      brokenAt: res.brokenAt === null ? null : res.brokenAt.index + 1,
      reason: res.brokenAt === null ? '' : String(res.brokenAt.reason ?? ''),
      sealed: res.sealed,
      total: records.length,
      startUnknown: res.startUnknown,
      legacyLinked,
      head: res.head,
    })
    sealedAll += res.sealed
    totalAll += records.length
    if (!res.ok) okAll = false
  }
  return { ok: okAll, days: out, sealed: sealedAll, total: totalAll }
}

/**
 * 修复断链：从**断点**起把该天余下的记录重新封链（只改 prevHash/hash，不动记录内容），
 * 再追加一条 `chain-heal` 记录如实写明位置与方式，并刷新该天的锚承诺。
 *
 * 为什么要它：每天各自成链之后，历史遗留的断点（切换前的旧进程按旧头续写造成的分叉）
 * 会让那一天永远合不拢。修法是**重新封链**而不是删记录 —— 内容一条不动，哈希按新的前驱重算。
 * 安全前提：调用方必须先在 apply 之前跑一次 dry-run（CLI 的 --dry-run 默认关闭写入）。
 */
export async function repairAuditDays (paths, { apply = false, lock = true } = {}) {
  const p = (paths !== null && typeof paths === 'object' && typeof paths.input === 'function')
    ? paths
    : auditPaths(String(paths?.dir ?? paths ?? ''))
  const before = await verifyAuditDays(p)
  const broken = before.days.filter((d) => d.ok !== true)
  if (broken.length === 0) return { ok: true, changed: [], plan: [], note: '没有断链' }
  const plan = []
  for (const d of broken) {
    const recs = await readAudit(p, d.day, { limit: Number.MAX_SAFE_INTEGER })
    const at = Math.max(0, (d.brokenAt ?? 1) - 1)      // 首个坏记录的 0-based 下标
    plan.push({ day: d.day, file: d.file, at: at + 1, records: recs.length, rebuild: recs.length - at, reason: d.reason })
  }
  if (apply !== true) return { ok: true, dryRun: true, changed: [], plan }

  const run = async () => {
    const changed = []
    for (const item of plan) {
      const recs = await readAudit(p, item.day, { limit: Number.MAX_SAFE_INTEGER })
      const at = item.at - 1
      // 先留一份原文件（同目录 .bak），便于事后核对
      try {
        const raw = await readFile(p.input(item.day), 'utf8')
        await writeFile(p.input(item.day) + '.bak', raw, { mode: 0o600 })
      } catch { /* 备份失败不阻塞修复，但记录在返回里 */ }
      let head = at === 0 ? GENESIS : String(recs[at - 1].hash ?? GENESIS)
      const lines = recs.slice(0, at).map((r) => JSON.stringify(r))
      for (let i = at; i < recs.length; i += 1) {
        const sealed = sealRecord(head, recs[i])
        head = sealed.hash
        lines.push(JSON.stringify(sealed))
      }
      // 修复记录：写明"何处断了、怎么修的"，不掩盖
      const heal = sealRecord(head, {
        event: 'chain-heal', ts: Date.now(), shell: '', actor: 'cli', source: 'cli',
        result: `重封 ${item.day} 第 ${item.at} 条起的 ${item.rebuild} 条（${item.reason}）；原文件已备份为 ${item.file}.bak`,
      })
      lines.push(JSON.stringify(heal))
      await writeFile(p.input(item.day), lines.join('\n') + '\n', { mode: 0o600 })
      await appendCheckpoint(p, { day: item.day, head: heal.hash, note: 'heal' }).catch(() => {})
      changed.push({ ...item, head: heal.hash })
    }
    return changed
  }
  const changed = lock ? await withChainLock(p, run) : await run()
  const after = await verifyAuditDays(p)
  return { ok: after.ok, dryRun: false, changed, after: { ok: after.ok, days: after.days.length, sealed: after.sealed } }
}

/** 读取某天的审计记录（按天，缺文件返回空数组）。 */
export async function readAudit(paths, day, { shell = '', actor = '', source = '', limit = 200 } = {}) {
  let raw
  try {
    raw = await readFile(paths.input(day), 'utf8')
  } catch {
    return []
  }
  const out = []
  for (const line of raw.split('\n')) {
    const record = parseAuditLine(line)
    if (record === null) continue
    if (shell !== '' && String(record.shell ?? '') !== shell) continue
    if (actor !== '' && String(record.actor ?? '') !== actor) continue
    if (source !== '' && String(record.source ?? '') !== source) continue
    out.push(record)
  }
  return limit > 0 && out.length > limit ? out.slice(-limit) : out
}


/**
 * 用户主动 purge/轮换后，把对应日期的锚点承诺删掉（文件已不在目录里，锚不再有对照意义）。
 * 这不是"洗掉证据"：purge 事件本身会作为**新文件的第一条记录**留痕，链完整可查。
 */
export async function resetAnchorDays (paths, days) {
  const list = Array.isArray(days) ? days.filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) : []
  if (list.length === 0) return { ok: true, changed: [] }
  const anchor = await readAnchor(paths)
  if (anchor === null || anchor.days === null || typeof anchor.days !== 'object') return { ok: true, changed: [] }
  const changed = []
  for (const day of list) { if (Object.hasOwn(anchor.days, day)) { delete anchor.days[day]; changed.push(day) } }
  if (changed.length === 0) return { ok: true, changed: [] }
  await writeAnchor(paths, anchor)
  return { ok: true, changed }
}

/** 按保留期清理旧审计文件（只删自己认识的文件名）。 */
export async function pruneAuditFiles(paths, todayKey, retentionDays) {
  let files = []
  try { files = await readdir(paths.dir) } catch { return [] }
  const { remove } = prunePlan(files, todayKey, retentionDays)
  const removed = []
  for (const name of remove) {
    try { await rm(join(paths.dir, name), { force: true }); removed.push(name) } catch { /* 忽略 */ }
  }
  return removed
}

/** 目录里按日期升序的审计文件名（只认 `audit-YYYY-MM-DD.jsonl`，不认识的别乱读）。 */
export async function auditFileNames(paths) {
  let files = []
  try { files = await readdir(paths.dir) } catch { return [] }
  return files.filter((name) => /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort()
}

/**
 * 读回**整条链**并校验（跨天连续：昨天的最后一条今天接着）。
 *
 * 这是"篡改可见"的读取口：返回的 `verify` 里带上断链位置与已校验条数，调用方必须把它
 * 显示出来 —— 校验结论不展示，等于没做。
 */
export async function readSealedChain(paths) {
  const names = await auditFileNames(paths)
  const records = []
  const perDay = {}
  for (const name of names) {
    const day = name.slice('audit-'.length, -'.jsonl'.length)
    try {
      const raw = await readFile(join(paths.dir, name), 'utf8')
      let n = 0
      for (const line of raw.split('\n')) {
        const record = parseAuditLine(line)
        if (record !== null) { records.push(record); n += 1 }
      }
      perDay[day] = n
    } catch { /* 单个文件读失败不拖垮整链 */ }
  }
  const verify = verifyChain(records)
  // 锚定由 checkpoints.jsonl（签名检查点链）负责；anchor.json 已废弃（方案 1，不做兼容）。
  return {
    days: names.map((name) => name.slice('audit-'.length, -'.jsonl'.length)),
    records,
    verify,
  }
}

/** 链头（最后一条封链记录的摘要），用于宿主重启后继续接链；没有则返回 GENESIS。 */
export function chainHeadOf(records) {
  for (let i = (Array.isArray(records) ? records.length : 0) - 1; i >= 0; i -= 1) {
    const rec = records[i]
    if (rec !== null && typeof rec === 'object' && typeof rec.hash === 'string' && rec.hash !== '') return rec.hash
  }
  return GENESIS
}

/**
 * 快速链头读回（0.3.3 启动瘦身）：只读**最新审计文件的尾 64KB**，取最后一条可解析的
 * 封链记录的 hash；没有就逐日往前退。新记录只需要知道"接在谁后面"—— 整链校验
 * （{@link readSealedChain}）是 O(全部记录) 的读盘+哈希，不该挡在启动窗口里。
 * 尾窗起点可能落在半行上：解析失败自然跳过，不构成漏判（我们要的是最后一条完整行）。
 */
export async function readChainHeadFast(paths) {
  const names = await auditFileNames(paths)
  for (let i = names.length - 1; i >= 0; i -= 1) {
    try {
      const file = join(paths.dir, names[i])
      const { size } = await stat(file)
      if (size === 0) continue
      const len = Math.min(size, 64 * 1024)
      const fh = await open(file, 'r')
      let text = ''
      try {
        const buf = Buffer.alloc(len)
        await fh.read(buf, 0, len, size - len)
        text = buf.toString('utf8')
      } finally {
        await fh.close()
      }
      const lines = text.split('\n')
      for (let j = lines.length - 1; j >= 0; j -= 1) {
        const rec = parseAuditLine(lines[j])
        if (rec !== null && typeof rec.hash === 'string' && rec.hash !== '') return rec.hash
      }
    } catch { /* 单日读失败：往前一日退，与 readSealedChain 同口径 */ }
  }
  return GENESIS
}

/**
 * 尽力检测审计目录是否已加锁（内核级 append-only，`chattr +a`）。
 *
 * 只读诊断：`lsattr` 不存在 / 非 Linux / 无权限一律返回 `'unknown'`，绝不猜。
 * 返回 `'append-only'`（已锁）| `'writable'`（未锁）| `'unknown'`。
 */
export async function detectAppendOnly(dir) {
  try {
    const { stdout } = await execFileAsync('lsattr', ['-d', dir], { timeout: 4000 })
    const flags = String(stdout).trim().split(/\s+/)[0] ?? ''
    if (flags === '' || !/^[-a-zA-Z]+$/.test(flags)) return 'unknown'
    return flags.includes('a') ? 'append-only' : 'writable'
  } catch {
    return 'unknown'
  }
}

/** 会话归属表（D1：只标注，不做拦截）—— 存盘以便宿主重启后仍能回答"谁开的"。 */
export async function readOwners(paths) {
  try {
    const parsed = JSON.parse(await readFile(paths.owners, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export async function writeConsent(paths, consent) {
  try {
    await ensureAuditDir(paths.dir)
    await writeFile(paths.consent, JSON.stringify(consent, null, 2) + '\n', { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

export async function readConsent(paths) {
  try {
    const parsed = JSON.parse(await readFile(paths.consent, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export async function writeOwners(paths, owners) {
  try {
    await ensureAuditDir(paths.dir)
    await writeFile(paths.owners, JSON.stringify(owners, null, 2) + '\n', { mode: 0o600 })
    return true
  } catch (error) {
    // 归属表落盘失败必须可见：内存仍生效，但重启后会丢归属记录（静默 false 曾让稳定压测
    // 里的"并发开壳丢条目"完全没有痕迹）
    console.warn(`terminalkeeper: 归属表落盘失败（内存仍有效，重启后会丢归属）：${String(error?.message ?? error)}`)
    return false
  }
}

/** 输出留痕文件当前的字节数（文件不存在算 0）。 */
export async function outputSize(path) {
  try {
    const info = await stat(path)
    return Number.isFinite(info.size) ? info.size : 0
  } catch {
    return 0
  }
}

/** 列出输出留痕文件（时间倒序），供面板/工具查看"关掉的会话留下了什么"。 */
export async function listOutputFiles(paths) {
  try {
    const files = await readdir(paths.outputDir)
    const withStat = await Promise.all(files.map(async (name) => {
      const info = await stat(join(paths.outputDir, name)).catch(() => null)
      return { name, bytes: info === null ? 0 : info.size, mtimeMs: info === null ? 0 : info.mtimeMs }
    }))
    return withStat.sort((a, b) => b.mtimeMs - a.mtimeMs)
  } catch {
    return []
  }
}
