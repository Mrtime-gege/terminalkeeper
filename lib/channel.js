/**
 * 发布通道标记。
 *
 * 仅用于控制是否暴露诊断接口；默认值保持现状，不影响普通用户功能。
 */
export const CHANNEL = 'release'
export const IS_RELEASE = CHANNEL === 'release'
