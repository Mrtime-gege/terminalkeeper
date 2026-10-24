/**
 * 设置数据注册层。
 *
 * 各模块只声明“设置项是什么”：key / 人类标签 / 控件 / 范围 / 单位 / 分组。
 * 渲染层（lib/client.js）只按 control 选择控件，不硬编码某个 key 长什么样。
 * 这样新增参数不需要改设置页 JSX，只需要在这里（或模块自己的 setup 里）注册。
 */

const ITEMS = new Map()

/** 注册一组设置项。重复 key 后者覆盖前者（便于模块内覆盖默认文案）。 */
export function registerSettings (moduleName, items) {
  for (const [key, meta] of Object.entries(items ?? {})) {
    ITEMS.set(key, { key, module: moduleName, ...meta })
  }
}

export function settingsMeta (key) {
  return ITEMS.get(key) ?? null
}

export function listRegisteredSettings () {
  return [...ITEMS.values()]
}

/** 设置页分区（顺序即导航顺序）。 */
export const SETTINGS_SECTIONS = [
  { id: 'features', label: '功能开关', description: '按模块开关。关掉只是不用它，不会改你的配置，随时能再打开。' },
  { id: 'terminal', label: '终端与会话', description: '用哪个终端程序（shell）、窗口多大、保留多少历史，以及启动时的参数。' },
  { id: 'appearance', label: '界面与外观', description: '面板、菜单、终端和提示消息长什么样。' },
  { id: 'panel', label: '面板与显示', description: '多久刷新一次（轮询）、哪些内容要打码（脱敏）、订阅最多留多少输出（缓冲预算）。' },
  { id: 'audit', label: '审计与留痕', description: '操作记录（审计链）、终端输出存档（留痕）、屏幕回放，以及提示历史。' },
  { id: 'security', label: '安全与授权', description: '谁能让 AI 执行命令（授权）、危险命令提醒（护栏），以及允许访问的地址。' },
  { id: 'server', label: '服务端与集成', description: '本地通道（socket）、网页接口（HTTP）、给 AI 的工具（tools），以及自动清理进程（watchdog）。' },
]

/** 注册内建 UI 参数：这是“模块注册设置项”的示例。 */
registerSettings('appearance', {
  panelOpacity: { label: '面板不透明度', control: 'range', min: 0, max: 100, step: 1, unit: '%', section: 'appearance' },
  menuOpacity: { label: '会话/菜单不透明度', control: 'range', min: 0, max: 100, step: 1, unit: '%', section: 'appearance' },
  terminalBackground: { label: '终端背景色', control: 'color', section: 'appearance' },
  panelRadius: { label: '面板圆角', control: 'range', min: 0, max: 24, step: 1, unit: 'px', section: 'appearance' },
  panelFontSize: { label: '终端字号', control: 'range', min: 10, max: 18, step: 1, unit: 'px', section: 'appearance' },
  panelBlur: { label: '背景模糊', control: 'range', min: 0, max: 20, step: 1, unit: 'px', section: 'appearance' },
  toastDurationMs: { label: '消息停留', control: 'range', min: 2000, max: 15000, step: 100, unit: 'ms', section: 'appearance' },
  toastMax: { label: '最大消息条数', control: 'range', min: 1, max: 10, step: 1, unit: '条', section: 'appearance' },
})

/** 功能开关的标签（布尔控件统一由渲染层处理）。 */
registerSettings('features', {
  featurePanel: { label: '持久 Shell 面板', control: 'switch', section: 'features' },
  featureTools: { label: 'shell_* 工具', control: 'switch', section: 'features' },
  featureWatch: { label: '订阅与流式通知', control: 'switch', section: 'features' },
  featureAudit: { label: '审计链', control: 'switch', section: 'features' },
  featureCapture: { label: '终端输出留痕', control: 'switch', section: 'features' },
  featureReplay: { label: '屏幕回放录制', control: 'switch', section: 'features' },
  featureVault: { label: '引用库', control: 'switch', section: 'features' },
  featureMacros: { label: '宏', control: 'switch', section: 'features' },
  featureWorkspaces: { label: '工作区', control: 'switch', section: 'features' },
  featureSnapshots: { label: '会话快照/复活', control: 'switch', section: 'features' },
  featureWatchdog: { label: '遗留终端自动清理（看门狗）', control: 'switch', section: 'features' },
  featureGuard: { label: '危险命令护栏', control: 'switch', section: 'features' },
  featureConsent: { label: '授权确认', control: 'switch', section: 'features' },
  featureRedact: { label: '敏感信息脱敏', control: 'switch', section: 'features' },
})

export function registerAll (modules = {}) {
  for (const [name, items] of Object.entries(modules)) registerSettings(name, items)
}
