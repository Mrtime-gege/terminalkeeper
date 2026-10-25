/**
 * 构建通道标记。
 *
 * 开发仓始终是 'dev'；scripts/build-release.mjs 在发布副本里把它替换为 'release'。
 * 发布版据此关闭仅开发用的诊断面（例如 /debugctl），开发版保留。
 */
export const CHANNEL = 'dev'
export const IS_RELEASE = CHANNEL === 'release'
