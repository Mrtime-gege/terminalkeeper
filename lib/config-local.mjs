/**
 * 本地运行时配置覆盖层。
 *
 * 作用：settings 服务缺席的组合配置部署里，面板「设置」页保存的改动**也能即时生效**，
 * 不必等宿主 settings 服务挂载、也不必改组合配置后重启 dsh。实现就是一份持久化的
 * 覆盖 JSON（`config-local.json`，0600），取值时「组合配置 ⊕ 本地覆盖」，覆盖优先。
 *
 * 语义与既有机制一致：
 *   · 安全键（auditDir/guard）与 RESTART_REQUIRED_KEYS 里的键**仍不可热改**
 *     —— 由 index.js 的 applyResolved 统一裁决，本层只负责存取；
 *   · 写覆盖本身进审计（event:'config', source:'local'），"改过什么"可追溯；
 *   · 清空某键用 `{ key: null }`（删除该覆盖，回落组合值）。
 *
 * 文件位置：所在目录与审计目录一致（auditDir 为空时取默认），键名与 Config 一致。
 */
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'

const FILENAME = 'config-local.json'

/** 读取本地覆盖。文件不存在/损坏返回 {}（损坏时如实告警，不静默吞）。 */
export async function readLocalOverrides(dir) {
  try {
    const raw = await fs.readFile(join(dir, FILENAME), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed
  } catch (error) {
    if (error?.code === 'ENOENT') return {}
    // 损坏文件：宁可回落空覆盖也不能用坏数据 —— 并让调用方看到原因
    return { __corrupt: String(error?.message ?? error) }
  }
}

/** 合并一条 patch 到本地覆盖并落盘。patch 里值为 null 的键会被删除（回落组合值）。 */
export async function writeLocalOverrides(dir, patch) {
  const current = await readLocalOverrides(dir)
  const merged = { ...(current.__corrupt !== undefined ? {} : current) }
  delete merged.__corrupt
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value === null || value === undefined) delete merged[key]
    else merged[key] = value
  }
  const target = join(dir, FILENAME)
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  await fs.writeFile(target, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 })
  return merged
}

/** 覆盖文件路径（暴露给诊断/面板显示用）。 */
export function localOverridesFile(dir) {
  return join(dir, FILENAME)
}

/** 仅测试用：取默认文件名。 */
export const configLocalFileName = FILENAME