/**
 * 清理策略执行器（按文件类别）：把 disposition 里的策略真正落到磁盘上。
 *
 * 策略语义（与设置页一致）
 *   keep   保持不变   —— 不动作
 *   rotate 按天轮转   —— 只保留最近 days 天；更早的**归档**到 archive/（不删除 ⇒ 审计链仍可回溯校验）
 *   wipe   彻底删除   —— 删除该类文件（不可恢复；含引用库时会受"口令加密组保护"约束）
 *
 * 重要边界
 *   · 只处理**本插件数据目录**内的已知类别，绝不递归删除目录本身；
 *   · 审计链：轮转采用**移动归档**，因为链是按天文件 + anchor.json 每日链头组织的，
 *     直接删除会破坏"可校验"语义；真要彻底删除请显式选 wipe。
 *   · 单文件类（sessions/snapshots/notices/prefs/vault）不支持 rotate（没有按天结构）：
 *     执行器会如实报告"该类不支持轮转"，绝不会用猜测的方式改写它们的内部结构。
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { CATEGORIES, readPolicies, hasPassphraseGroup } from './disposition.mjs'

export const ARCHIVE_DIR = 'archive'
/** 有"按天结构"因而支持轮转的类别 */
export const ROTATABLE = ['audit', 'output']
/** 目录型类别：这一类不是"顶层按天文件"，而是**一个目录里一堆按时间命名的文件**（output/） */
const DIR_OF = { output: 'output' }
/** 类别的文件名匹配（前缀以 - 结尾表示前缀匹配） */
const MATCH = {
  audit: ['audit-'],
  output: ['output'],
  snapshots: ['snapshots.json'],
  sessions: ['sessions.json'],
  notices: ['notices.json'],
  prefs: ['macros.json', 'consent.json', 'config-local.json', 'workspaces.json', 'user-config.json', 'disposition.json'],
  vault: ['vault.json', 'vault.head.json', 'vault.uses.json'],
}

function daysAgoOf (mtime, days) {
  return mtime.getTime() < Date.now() - days * 86400000
}
function statIsFile (p) {
  try { return statSync(p).isFile() } catch { return false }
}
function filesOf (dir, key) {
  const pats = MATCH[key] ?? []
  return readdirSync(dir).filter((n) => pats.some((p) => (p.endsWith('-') ? n.startsWith(p) : n === p)))
}

/** 执行一轮保留策略。返回 { applied, moved, removed, skipped, notes } */
export function applyRetention (dir, { dryRun = false, only = null, onlyRotate = false, now = () => Date.now() } = {}) {
  // onlyRotate：启动时的自动应用**只做轮转**（保守）—— wipe 必须由用户显式触发，绝不自动删数据
  const out = { applied: [], moved: [], removed: [], skipped: [], notes: [] }
  if (existsSync(dir) !== true) { out.notes.push('数据目录不存在'); return out }
  const policies = readPolicies(dir)
  for (const cat of CATEGORIES) {
    const key = cat.key
    if (only !== null && only !== key) continue
    const p = policies[key]
    if (p.policy === 'keep') { out.skipped.push(`${key}:keep`); continue }
    if (p.policy === 'rotate') {
      if (ROTATABLE.includes(key) !== true) { out.notes.push(`${key}：该类没有按天结构，不支持轮转（保持原样）`); continue }
      const archive = join(dir, ARCHIVE_DIR)
      // 目录型（output/）：枚举**目录内的文件**，逐个按 mtime 判新旧 ⇒ 旧文件归档（不删）。
      // 2026-10 补：此前 ROTATABLE 只有 audit，output 虽有 days=7 却无法轮转 ⇒ 留痕只能按名手删
      // （实测清了 412 个文件，全靠临时脚本筛）。归档名加 `类别-` 前缀，避免与顶层审计文件重名。
      const sub = DIR_OF[key]
      const base = sub === undefined ? dir : join(dir, sub)
      const names = sub === undefined
        ? filesOf(dir, key)
        : (existsSync(base) ? readdirSync(base).filter((n) => statIsFile(join(base, n))) : [])
      const stale = names.filter((n) => {
        try { return daysAgoOf(statSync(join(base, n)).mtime, p.days) } catch { return false }
      })
      for (const n of stale) {
        const archName = sub === undefined ? n : `${sub}-${n}`
        if (dryRun !== true) {
          if (existsSync(archive) !== true) mkdirSync(archive, { recursive: true, mode: 0o700 })
          try { renameSync(join(base, n), join(archive, archName)); out.moved.push(archName) } catch { out.notes.push(`${n}：归档失败，已保留`) }
        } else out.moved.push(archName)
      }
      out.applied.push(`${key}:rotate(${p.days}d)`)
      continue
    }
    if (p.policy === 'wipe') {
      if (onlyRotate === true) { out.skipped.push(`${key}:wipe-skipped(onlyRotate)`); continue }
      if (key === 'vault' && hasPassphraseGroup(dir) === true) {
        out.notes.push(`${key}：存在口令加密组 ⇒ 拒绝删除 vault.*（密文删了无法恢复）`)
        out.skipped.push(`${key}:wipe-refused`)
        continue
      }
      for (const n of filesOf(dir, key)) {
        if (dryRun !== true) {
          try {
            if (n === 'output') rmSync(join(dir, n), { recursive: true, force: true })
            else unlinkSync(join(dir, n))
            out.removed.push(n)
          } catch { out.notes.push(`${n}：删除失败，已保留`) }
        } else out.removed.push(n)
      }
      out.applied.push(`${key}:wipe`)
    }
  }
  void now
  return out
}
