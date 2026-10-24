/**
 * terminalkeeper —— 客户端侧（browser half）
 *
 * 只往 list 槽位加法注册一处 UI：`shell.overlay` 悬浮面板。
 *
 * 为什么用 `shell.overlay`：它是 root 作用域的整框浮层，**不绑定任何会话** ——
 * 切会话、开着别的会话、乃至没有会话时，面板都在。这就是「与对话解耦」在 UI 侧
 * 的落点。
 *
 * 数据不走 package-private RPC，而是同源 HTTP 直连宿主：
 *   GET  <base>/list              会话列表 + 服务端信息
 *   GET  <base>/screen?name=&lines=  可见屏 + 向上 lines 行历史 + 该会话指标
 *       ⚠️ `lines` 必须显式传：缺省时宿主只返回**可见屏**（capture-pane 不带 -S），
 *          也就是窗格高度那么多行 —— 历史一直在 tmux 里，只是没人去取。
 *   POST <base>/keys  /new  /kill  /resize
 * 因此浏览器不经过任何会话即可操作后台 shell。
 *
 * 拖动：胶囊与面板共用**同一个位置锚点**（胶囊的左上角）。拖胶囊用偏移量跟手；
 * 拖面板标题栏用位移量整体平移。位置存 localStorage，跨刷新保留。
 * 拖动与点击靠位移阈值（4px）区分，拖动结束后抑制随之而来的 click。
 *
 * 输入模型（重要）：**真终端模型，没有任何本地缓冲** —— 每个按键都直接送进 shell。
 * 分两条路：
 *   * 特殊键（Tab/↑↓←→/Backspace/Home End/Ctrl-X/Esc）在 keydown 里翻译成 tmux 键名；
 *   * 可打印字符**不拦**，交给浏览器与输入法，再由 `input` 事件交付。
 *
 * 第二条是**中文/日文输入（IME）能用的前提**：输入法的组字由浏览器对按键的默认处理
 * 驱动，一旦把所有字母都 preventDefault 掉，IME 就起不来。组字中间态（isComposing）
 * 必须跳过，否则 "n"/"ni"/"nih" 会被逐个送进终端而不是等"你好"整段提交。
 *
 * 注意：`shell.overlay` 整层默认点击穿透，条目必须显式 opt-in 指针事件。
 */
/**
 * Ctrl+字母白名单：交给终端 readline。
 *
 * 其余组合键放行给浏览器：V/X 是粘贴剪切，W/T/N 关标签开标签等系统快捷键 ——
 * 在输入框里抢这些键会很难用。
 */
/**
 * 客户端构建号（**模块级**：面板内外都要能读；内层的 BUILD 引用它，保持单一来源）。
 * 与宿主 lib/index.js 的 HOST_BUILD 必须同值（由 scripts/test-config.mjs 断言）。
 */
var CLIENT_BUILD = 'c90'

/**
 * 界面错误码（2026-10-24）：简化的提示语必须能快速定位问题。
 *
 * 约定：**人话在前，错误码在后**，统一格式「…（错误码 X）」。用户报问题时贴一句话，
 * 维护者就能对上类型；文档里也按同一套码索引。宿主返回的错误（TMUX_FAILED / REFUSED 等）
 * 原样保留，不再包一层。
 */
var UI_ERR = {
  UNREACHABLE: 'DSH_UNREACHABLE',   // 连不上 DSH（网络/服务挂了）
  TOO_OLD: 'DSH_TOO_OLD',           // 接口不存在：插件比 DSH 新，需要重启
  ACTION: 'ACTION_FAILED',          // 操作被服务端拒绝或异常
  RENDER: 'PANEL_RENDER',           // 面板自身显示出错
  VAULT: 'VAULT_IO',                // 引用库读写失败
  CLIPBOARD: 'CLIPBOARD',           // 复制到剪贴板失败
  AUTH: 'AUTH_STATE',               // 授权状态读写失败
  SOFT_KEYBOARD: 'SOFT_KEYBOARD',   // 软键盘构建失败（不影响面板）
  SHORTCUT: 'SHORTCUT_REGISTER',    // 快捷键注册失败（已回退）
  SETTINGS_CARD: 'SETTINGS_CARD',   // 设置卡片没注册上
  SSE: 'SSE_FALLBACK',              // 屏幕推送断开，已退化为轮询
  MOUSE: 'MOUSE_GRID',              // 鼠标坐标换算失败
}
/** 给提示语补上错误码：`…（错误码 CODE）`。已经带码的（宿主错误）不要重复包。 */
function withCode (message, code) {
  return String(message) + '（错误码 ' + code + '）'
}

var CTRL_KEYS = {
  a: 'C-a', b: 'C-b', c: 'C-c', d: 'C-d', e: 'C-e', f: 'C-f', h: 'C-h', i: 'C-i',
  k: 'C-k', l: 'C-l', m: 'C-m', n: 'C-n', p: 'C-p', r: 'C-r', t: 'C-t', u: 'C-u',
  w: 'C-w', y: 'C-y', z: 'C-z',
}

/**
 * ── 软键盘（2026-10，用户要求：输入行右侧按钮 → 全尺寸键盘，支持按键组合）──────────────
 * 这里只放**纯逻辑**（布局 + 组合键编码），UI 只管画与点；可离线穷举验证（见 __softKeyToken）。
 *
 * 组合键怎么送：tmux 键名本身带修饰前缀（`C-` / `M-` / `S-`），宿主白名单是 `/^[A-Za-z0-9_-]+$/`
 * ⇒ `C-a` / `M-x` / `C-M-x` / `S-Tab` 全部合法 ⇒ **一个组合就是一个键名**，前端不必拼多步。
 * 反过来：`;` `!` `|` 这类字符不在白名单里 ⇒ 只能走**文本**通道，也**不能**参与组合
 * （UI 如实置灰，而不是发出去让宿主拒绝）。
 */
/**
 * 鼠标支持（2026-10）—— 面板侧**纯换算**，与"对齐尺寸"共用同一套网格度量
 * （cellWidthRef / lineHeightRef / SCREEN_PAD_X / SCREEN_PAD_Y）。
 * 换算成终端单元坐标（**1-based**）后交给宿主，由宿主用 buildMouseSeq 构造字节序列。
 * 扩展点：协议/按钮/动作/修饰键都在纯函数层的表里（lib/pure.mjs），这里只负责"点到哪一格"。
 */
/**
 * 把点击位置换算成**终端视口相对**的单元坐标（1-based）。
 * ⚠ 关键（用户实测"点列头无反应"的根因）：面板显示的是「历史 + 可见屏」这段文本，
 * 而程序要的是**它自己视口内**的坐标 —— 拿整段文本的行号当 y，会被历史行数顶出范围，
 * 程序直接忽略（看起来就是"点了没反应"）。所以 y 要减去 `totalLines - rows`（即历史行数）。
 */
/**
 * 把点击位置换算成**终端视口内**的单元坐标（1-based）。
 *
 * ⚠ 这里只做两件不依赖推测的事：
 *   ① 横向：用**实测文字块**的左边当原点（padding 都含在里面）；
 *   ② 纵向：用**可视框**的顶边当原点 —— 可视框就是窗格视口，点在第几行就是第几行。
 * 历史/总行数一概不推算（`/screen` 文本行数与窗格行数不必相等，推算出来的偏移会整体差一行，
 * 实测表现就是"点上去偏下一行"或误报"落在可见屏之外"）。
 */
/**
 * 把面板上的点击换算成**窗格视口内**的单元坐标（1-based）。
 *
 * ⚠ 关键（2026-10 用户实测"纵向向下相差 7 行"）：面板的屏幕区通常**比窗格高** ——
 * 它会多抓一些历史行来显示，所以**可视框的顶部并不是窗格的第 1 行** ✗。
 * 正确做法是按**面板自己的滚动几何**换算：
 *   textRows  = scrollHeight / lineHeight      （文本总行数，含历史）
 *   paneRows  = 窗格的 rows（宿主上报；没有就用可见行数）
 *   hist      = max(0, textRows - paneRows)    （顶部有多少行属于历史）
 *   textRow   = floor((scrollTop + 点击内的 y) / lineHeight) + 1
 *   y         = textRow - hist                 ⇒ 落到窗格视口；落在 [1, paneRows] 之外就拒绝
 * 这样不论面板滚到哪里都对；滚到历史里时点出的行会算出 <1 ⇒ 如实拒绝（不猜）。
 */
/**
 * 把面板上的点击换算成**窗格视口内**的单元坐标（1-based）。
 *
 * ⚠ 关键（2026-10 用户两次实测"偏一行"，最后一次提出"用别的办法拿准确坐标"）：
 * 面板里**本来就有权威换算** —— 画光标用的那一套（见光标定位处）：
 *     paneHeight = meta.paneHeight            （窗格高度，**不是** meta.rows —— 后者含状态行，
 *                                              用了就正好偏一行）
 *     lineIndex  = 文本总行数 - paneHeight + 光标在窗格内的行
 * ⇒ 鼠标换算必须**复用它**，而不是自己拿 scrollHeight/行高另算一套（两套必然差一行）。
 * 所以这里只做：① 点击落在面板文本的第几行（用面板自己的滚动几何）；
 *              ② 再按同一公式映射到窗格行，落在 [1, paneHeight] 之外就拒绝。
 */
/**
   * 用浏览器 caret API 取“点在渲染文本的第几行”（1-based）。
   * 比用 clientY / lineHeight 推更准：padding、行高、字体缩放都不参与计算。
   * 返回 null 时调用方回退到像素公式。
   */
/**
 * 用 DOM 每行的 Range 包围盒定位点击行（1-based，全文绝对行）。
 * 比 caretRangeFromPoint 稳：不受 CSS 滚动/行高换算/文本节点拆分影响。
 */
function textRowFromPoint (el, x, y) {
  if (el === null || typeof el !== 'object' || typeof document === 'undefined') return null
  const text = typeof el.textContent === 'string' ? el.textContent : ''
  if (text === '') return null
  const starts = [0]
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) starts.push(i + 1)
  const nodeAt = (offset) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null)
    let at = 0
    while (walker.nextNode()) {
      const n = walker.currentNode
      const len = n.nodeValue.length
      if (offset <= at + len) return { node: n, offset: Math.max(0, Math.min(offset - at, len)) }
      at += len
    }
    return null
  }
  let best = null
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i]
    const end = i + 1 < starts.length ? starts[i + 1] - 1 : text.length
    const a = nodeAt(start); const b = nodeAt(end)
    if (a === null || b === null) continue
    const range = document.createRange()
    try { range.setStart(a.node, a.offset); range.setEnd(b.node, b.offset) } catch { continue }
    const rect = range.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) continue
    if (y >= rect.top - 1 && y <= rect.bottom + 1) {
      const dist = Math.abs(y - (rect.top + rect.height / 2))
      if (best === null || dist < best.dist) best = { row: i + 1, dist }
    }
  }
  return best === null ? null : best.row
}
function caretRowFromPoint (el, x, y) {
  if (el === null || typeof el !== 'object' || typeof document === 'undefined') return null
  let node = null
  let offset = 0
  try {
    if (typeof document.caretRangeFromPoint === 'function') {
      const r = document.caretRangeFromPoint(x, y)
      if (r !== null && r !== undefined) { node = r.startContainer; offset = r.startOffset }
    } else if (typeof document.caretPositionFromPoint === 'function') {
      const p = document.caretPositionFromPoint(x, y)
      if (p !== null && p !== undefined) { node = p.offsetNode; offset = p.offset }
    }
  } catch { return null }
  if (node === null || typeof el.contains !== 'function' || el.contains(node) !== true) return null
  let abs = 0
  try {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null)
    while (walker.nextNode()) {
      const n = walker.currentNode
      if (n === node) { abs += Math.max(0, Math.min(offset, n.nodeValue.length)); break }
      abs += n.nodeValue.length
    }
  } catch { return null }
  const text = typeof el.textContent === 'string' ? el.textContent : ''
  let row = 1
  for (let i = 0; i < abs && i < text.length; i += 1) if (text.charCodeAt(i) === 10) row += 1
  return row
}
function mouseCellFromPanel (point, geom) {
  const cw = Number(geom?.cell?.w); const lh = Number(geom?.cell?.h)
  if (!(cw > 0) || !(lh > 0)) return null
  const box = geom?.box ?? {}
  const clientHeight = Number(box.clientHeight)
  const scrollTop = Number(box.scrollTop) || 0
  const scrollLeft = Number(box.scrollLeft) || 0
  const top = Number(box.top); const textLeft = Number(geom?.textLeft)
  const paneHeight = Number(geom?.paneHeight)          // 权威：meta.paneHeight（缺则退回可见行数）
  const textLines = Number(geom?.textLines)            // 面板渲染的文本总行数（与光标换算同源）
  if (!Number.isFinite(clientHeight) || !Number.isFinite(top) || !Number.isFinite(textLeft)) return null
  const px = Number(point?.x) - textLeft + scrollLeft
  const py = Number(point?.y) - top
  if (!Number.isFinite(px) || !Number.isFinite(py)) return null
  if (py < 0 || py >= clientHeight) return null                     // 点在可视框之外
  const x = Math.floor(px / cw) + 1
  if (x < 1) return null
  const visRows = Math.max(1, Math.round(clientHeight / lh))
  const paneRows = Number.isFinite(paneHeight) && paneHeight > 0 ? Math.round(paneHeight) : visRows
  const rendered = Number.isFinite(textLines) && textLines > 0 ? Math.round(textLines) : paneRows
  const exactRow = Number(geom?.textRow)
  const textRow = Number.isFinite(exactRow) && exactRow > 0 ? Math.round(exactRow) : Math.floor((scrollTop + py) / lh) + 1
  // 历史行数优先用宿主上报的 meta.historySize（权威）；缺省才回退 textLines - paneHeight。
  const historySize = Number(geom?.historySize)
  const hist = Number.isFinite(historySize) && historySize >= 0
    ? Math.round(historySize)
    : Math.max(0, rendered - paneRows)
  const y = textRow - hist
  if (y < 1 || y > paneRows) return null                            // 落在窗格视口之外（如面板停在历史里）
  return { x, y }
}
function mouseCellFromPoint (point, rect, cell, pad, scroll) {
  const cw = Number(cell?.w); const lh = Number(cell?.h)
  if (!(cw > 0) || !(lh > 0)) return null
  const px = Number(point?.x) - Number(rect?.left) - Number(pad?.x ?? 0) + Number(scroll?.left ?? 0)
  const py = Number(point?.y) - Number(rect?.top) - Number(pad?.y ?? 0) + Number(scroll?.top ?? 0)
  if (!Number.isFinite(px) || !Number.isFinite(py)) return null
  const x = Math.floor(px / cw) + 1
  const y = Math.floor(py / lh) + 1
  if (x < 1 || y < 1) return null
  return { x, y }
}
/** 滚轮方向 → 按钮名（表驱动：以后加"水平滚轮"只是往表里加一行）。 */
/** 指针事件按钮号 → 终端按钮名（0 左 / 1 中 / 2 右）。纯函数，便于离线断言。 */
var MOUSE_BUTTON_NAMES = { 0: 'left', 1: 'middle', 2: 'right' }
function mouseButtonName (button) {
  return MOUSE_BUTTON_NAMES[Number(button)] ?? 'left'
}
var MOUSE_WHEEL_BUTTONS = { up: 'wheelUp', down: 'wheelDown', left: 'wheelLeft', right: 'wheelRight' }
function mouseWheelButton (deltaX, deltaY) {
  const dx = Number(deltaX) || 0; const dy = Number(deltaY) || 0
  if (Math.abs(dy) >= Math.abs(dx)) return dy < 0 ? MOUSE_WHEEL_BUTTONS.up : MOUSE_WHEEL_BUTTONS.down
  return dx < 0 ? MOUSE_WHEEL_BUTTONS.left : MOUSE_WHEEL_BUTTONS.right
}

var SOFT_MODS = [
  { id: 'C', label: 'Ctrl', token: 'C' },
  { id: 'M', label: 'Alt', token: 'M' },
  { id: 'S', label: 'Shift', token: 'S' },
]
/**
 * 108 键全键盘布局（用户要求）：分四个区块并排，键宽用"单位宽度"（span）表达，
 * 键面用 CSS Grid + fr 渲染 ⇒ **长宽都随浮窗自适应**（不再有固定 26px 高、不再被压扁）。
 * `t` 字段 = 键面文字；`w` = 占几个单位宽；`mod` = 三个修饰键；`no` = 终端无法发送（置灰并说明）。
 */
var SOFT_BLOCKS = [
  {
    id: 'main', label: '主键区', cols: 15,
    rows: [
      [{ t: 'Esc', w: 1.5 }, { t: 'F1' }, { t: 'F2' }, { t: 'F3' }, { t: 'F4' }, { t: 'F5' }, { t: 'F6' }, { t: 'F7' }, { t: 'F8' }, { t: 'F9' }, { t: 'F10' }, { t: 'F11' }, { t: 'F12' }],
      [{ t: '`' }, { t: '1' }, { t: '2' }, { t: '3' }, { t: '4' }, { t: '5' }, { t: '6' }, { t: '7' }, { t: '8' }, { t: '9' }, { t: '0' }, { t: '-' }, { t: '=' }, { t: 'Backspace', w: 2 }],
      [{ t: 'Tab', w: 1.5 }, { t: 'q' }, { t: 'w' }, { t: 'e' }, { t: 'r' }, { t: 't' }, { t: 'y' }, { t: 'u' }, { t: 'i' }, { t: 'o' }, { t: 'p' }, { t: '[' }, { t: ']' }, { t: '\\', w: 1.5 }],
      [{ t: 'Caps', w: 1.75, no: true }, { t: 'a' }, { t: 's' }, { t: 'd' }, { t: 'f' }, { t: 'g' }, { t: 'h' }, { t: 'j' }, { t: 'k' }, { t: 'l' }, { t: ';' }, { t: "'" }, { t: 'Enter', w: 2.25 }],
      [{ t: 'Shift', w: 2.25, mod: 'S' }, { t: 'z' }, { t: 'x' }, { t: 'c' }, { t: 'v' }, { t: 'b' }, { t: 'n' }, { t: 'm' }, { t: ',' }, { t: '.' }, { t: '/' }, { t: 'Shift', w: 2.75, mod: 'S' }],
      [{ t: 'Ctrl', w: 1.25, mod: 'C' }, { t: 'Win', w: 1.25, no: true }, { t: 'Alt', w: 1.25, mod: 'M' }, { t: 'Space', w: 6.25 }, { t: 'Alt', w: 1.25, mod: 'M' }, { t: 'Win', w: 1.25, no: true }, { t: 'Menu', w: 1.25, no: true }, { t: 'Ctrl', w: 1.25, mod: 'C' }],
    ],
  },
  {
    id: 'nav', label: '导航区', cols: 3,
    rows: [
      [{ t: 'PrtSc', no: true }, { t: 'ScrLk', no: true }, { t: 'Pause', no: true }],
      [{ t: 'Ins' }, { t: 'Home' }, { t: 'PgUp' }],
      [{ t: 'Del' }, { t: 'End' }, { t: 'PgDn' }],
      [null, { t: 'Up' }, null],
      [{ t: 'Left' }, { t: 'Down' }, { t: 'Right' }],
    ],
  },
  {
    id: 'pad', label: '数字键盘', cols: 4,
    rows: [
      [{ t: 'NumLock', no: true }, { t: '/' }, { t: '*' }, { t: '-' }],
      [{ t: '7' }, { t: '8' }, { t: '9' }, { t: '+', w: 1, h: 2 }],
      [{ t: '4' }, { t: '5' }, { t: '6' }],
      [{ t: '1' }, { t: '2' }, { t: '3' }, { t: 'Enter', h: 2 }],
      [{ t: '0', w: 2 }, { t: '.' }],
    ],
  },
  {
    id: 'media', label: '媒体键', cols: 1,
    rows: [[{ t: 'Mute', no: true }], [{ t: 'Vol-', no: true }], [{ t: 'Vol+', no: true }], [{ t: 'Calc', no: true }]],
  },
]
/**
 * 键面文字 → **tmux 实测认识**的键名（2026-10 用隔离 socket + cat 逐个人工验证）。
 * ⚠ 血泪教训：tmux 对**不认识的键名不报错**，而是把它**当字面量打进终端** ——
 * 用户实测到 `Shift_LControl_LaaaaaaBackspaceBackspace` 就是这么来的。
 * 实测：`BSpace`/`Escape`/`Enter`/`Tab`/`Space`/`DC`/`NPage`/`PPage`/方向键/F1–F12 认识；
 * `Backspace`/`Esc`/`Control_L`/`Shift_L`/`Alt_L` **不认识**。
 */
var SOFT_KEY_ALIAS = {
  'Backspace': 'BSpace', 'Delete': 'DC', 'Del': 'DC', 'Ins': 'IC',
  'PageDown': 'NPage', 'PgDn': 'NPage', 'PageUp': 'PPage', 'PgUp': 'PPage',
  'Esc': 'Escape', 'Space': 'Space',
}
/** 只有字母数字可以参与组合：`C-;` 这类不在实测白名单里，UI 会如实置灰。 */
var SOFT_ALNUM = /^[A-Za-z0-9]$/
/** 实测认识的特殊键名（可与 C-/M-/S- 组成组合，如 C-DC、S-Tab）。 */
var SOFT_SPECIAL = /^(?:BSpace|Escape|Enter|Tab|BTab|Space|DC|IC|Home|End|Up|Down|Left|Right|NPage|PPage|F(?:[1-9]|1[0-2]))$/
/** 与宿主 isSafeKeyName 同口径（字母数字 _ -）；不合法者只能走文本通道、不能组组合。 */
var SOFT_SENDABLE = /^[A-Za-z0-9_-]+$/
/**
 * 组合键 → 单个 tmux 键名（mods 为 ['C','M','S'] 子集）。
 * 返回 '' 有两种含义，UI 用 printable 再区分：
 *   · 无修饰 + 可打印字符 ⇒ `''`（**走文本通道**，字符原样进终端，不受键名表影响）；
 *   · 组合里基键不是字母数字/实测特殊键 ⇒ `''`（发出去只会被宿主拒绝，UI 置灰）。
 */
function softKeyToken (mods, face) {
  const raw = String(face)
  const base = SOFT_KEY_ALIAS[raw] ?? raw
  const list = Array.isArray(mods) ? mods : []
  const pre = SOFT_MODS.map((m) => m.token).filter((t) => list.includes(t))
  if (pre.length === 0) {
    // 单个可打印字符走文本通道（不用键名）；其余必须是实测认识的特殊键名
    if (raw.length === 1) return ''
    return SOFT_SPECIAL.test(base) ? base : ''
  }
  if (!(SOFT_ALNUM.test(base) || SOFT_SPECIAL.test(base))) return ''
  return pre.join('-') + '-' + base
}

/**
 * 单独发送修饰键：**做不到**（2026-10 实测）。
 * tty 里一个裸修饰键没有对应字节；tmux 也不认识 `Control_L`/`Shift_L`/`Alt_L`
 * ⇒ 发过去只会被**当字面量打印**（用户实测到 `Shift_LControl_L…` 的来源）。
 * 所以独立模式对这三个键**不发任何东西**，UI 置灰并写明原因，绝不制造"打字面量"的假象。
 */
var SOFT_MOD_STANDALONE = { C: '', M: '', S: '' }
/**
 * 点了修饰键该做什么（纯函数，可离线穷举）：
 *   comboMode=true  ⇒ { mode:'toggle' } 粘滞切换，等下一个键组成组合；
 *   comboMode=false ⇒ { mode:'send', key:'Control_L' } **立即把这个修饰键本身发出去**。
 */
function softModAction (token, comboMode) {
  if (comboMode === true) return { mode: 'toggle', key: '' }
  return { mode: 'none', key: SOFT_MOD_STANDALONE[String(token)] ?? '' }
}

/** 显示用标签（Ctrl + Alt + X），纯给人看。 */
function softKeyLabel (mods, face) {
  const list = Array.isArray(mods) ? mods : []
  const names = SOFT_MODS.filter((m) => list.includes(m.token)).map((m) => m.label)
  return names.concat([String(face)]).join(' + ')
}

/**
 * 一次 keydown 该怎么处理（纯函数，便于脱离浏览器验证）。
 *
 * **最重要的规则：可打印字符一律放行给浏览器，绝不在 keydown 里 preventDefault。**
 * 输入法（IME）的组字是由浏览器对按键的**默认处理**驱动的 —— 抢掉按键会让中文/日文
 * 输入直接失效。字符最终由 `input` 事件交付（组字状态见 {@link decideComposition}）。
 *
 * @param {object} e - `{ key, ctrlKey, metaKey, altKey, shiftKey, isComposing, keyCode, hasSelection }`
 * @returns {{ action: 'key', key: string } | { action: 'pass' }}
 */
/**
 * 组装 ⓘ 详情层要显示的分组键值行 —— **纯函数**，因此可以脱离浏览器单测。
 *
 * 之所以单独抽出来：面板里最容易出错的不是样式而是「某个字段没拿到就直接读」，
 * 而这类错误只有打开面板那一刻才会暴露。纯函数可以在测试里把所有缺字段的组合喂一遍。
 *
 * @param {object} input - { server, meta, sessions, historyWindow, maxWindow, pkgVersion, build, locked }
 * @returns {Array<{group: string, rows: Array<{k: string, v: string, tone?: string, title?: string}>}>}
 */
/**
 * 人类可读的字节数。**放在模块顶层**：`buildInfoRows` 也要用，
 * 而它定义在组件之外 —— 留在组件里会变成「打开面板才报 ReferenceError」的隐藏 bug
 * （这类问题已经被 buildInfoRows 的离线测试抓到过一次）。
 */
/**
 * 绝对路径 → 可展示形态（2026-10-24 隐私修正）。
 *
 * 为什么：详情页是**会被截图贴给别人排查**的面板，`/home/<真实用户名>/…` 属于不该随图外泄的
 * 信息。这里只做展示层收口，不改数据；真正的脱敏不靠它（审计/输出有独立的 redact）。
 *
 * 规则：Linux/macOS 的家目录收成 `~`；Windows 用户目录（含 WSL 挂载进来的 C 盘）
 * 把用户名换成 `<user>`。只动展示，不动数据。
 */
function prettyPath (value) {
  let out = String(value === undefined || value === null ? '' : value)
  if (out === '') return out
  out = out.replace(/^\/(?:home|Users)\/[^/]+\/?/, (m) => (m.slice(-1) === '/' ? '~/' : '~'))
  out = out.replace(/^\/mnt\/([a-z])\/Users\/[^/]+(\/.*)?$/i, (_, drive, rest) => String(drive).toUpperCase() + ':' + '\\' + 'Users' + '\\' + '<user>' + String(rest === undefined ? '' : rest).replace(/\//g, '\\'))
  return out
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '-'
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / 1024 / 1024).toFixed(2) + ' MB'
}

/**
 * 把 {@link buildInfoRows} 的结果拍成**纯文本**，用于「复制诊断信息」。
 *
 * 报障时最烦的就是来回问「你什么版本、什么配置、看门狗在不在」——一键复制这整段，
 * 对方一眼就能看出环境。纯函数，因此格式与边界都能单测。
 *
 * @param {Array<{group: string, rows: Array<{k: string, v: string}>}>} sections
 * @param {string} [header] - 首行（版本/构建/时间）
 * @returns {string}
 */
function infoRowsToText(sections, header) {
  const lines = []
  if (typeof header === 'string' && header.length > 0) lines.push(header)
  for (const section of Array.isArray(sections) ? sections : []) {
    if (section === null || typeof section !== 'object') continue
    lines.push('')
    lines.push('## ' + String(section.group === undefined ? '?' : section.group))
    for (const row of Array.isArray(section.rows) ? section.rows : []) {
      if (row === null || typeof row !== 'object') continue
      lines.push(String(row.k === undefined ? '?' : row.k) + ': ' + String(row.v === undefined ? '-' : row.v))
    }
  }
  return lines.join('\n') + '\n'
}

/**
 * 写剪贴板：优先 `navigator.clipboard`（localhost 属于安全上下文，一般可用），
 * 失败再退到「临时 textarea + execCommand」—— 某些浏览器/权限设置会拒绝前者。
 * 两条都失败就把错误交给调用方显示，**不静默失败**。
 *
 * @param {string} text
 * @param {() => void} onDone
 * @param {(message: string) => void} onError
 */
function writeClipboard(text, onDone, onError) {
  const fallback = () => {
    try {
      const area = document.createElement('textarea')
      area.value = text
      area.setAttribute('readonly', '')
      area.style.position = 'fixed'
      area.style.left = '-9999px'
      document.body.appendChild(area)
      area.select()
      const ok = document.execCommand !== undefined && document.execCommand('copy')
      document.body.removeChild(area)
      if (ok) onDone()
      else onError('复制失败：浏览器拒绝了剪贴板访问，请手动选中内容后复制')
    } catch (error) {
      onError('复制失败：' + String(error && error.message ? error.message : error))
    }
  }
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined &&
        typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).then(onDone, fallback)
      return
    }
  } catch (error) { /* 落到 fallback */ }
  fallback()
}

/**
 * 某个会话是否**正在前台跑东西**（前台进程不是 shell 自己）。
 *
 * 抽出来是为了让面板与折叠胶囊用同一套判定 —— 之前胶囊那边把 shell 名写死成 `'bash'`，
 * 配置成 zsh 或登录 shell（`-bash`）时会把空闲误判成忙碌。
 */
/** 判定「贴底」的容差（像素）：轮询与滚动事件之间的小误差不该把跟随状态抖掉。 */
var AT_BOTTOM_PX = 24

/**
 * 屏幕区上下内边距之和（像素）。样式与滚动补偿共用它：
 * 补偿要按「行高 × 位移行数」算，而行高只能由 (scrollHeight - padding) / 行数 得到，
 * 两边分头写死必然会漂。
 */
var SCREEN_PAD_Y = 20

/** 屏幕区左右内边距（单侧）。光标是绝对定位的，偏移量必须把它算进去。 */
var SCREEN_PAD_X = 12

/**
 * 屏幕轮询的三档节奏（毫秒）。
 *
 * 为什么是自适应而不是一个固定值：每次请求在宿主侧都是**一次真实 tmux 调用**（经 DSH 的
 * subprocess 服务起进程实测约 60–70ms，裸调 tmux 只要 4.5ms），所以"调快"是有成本的；
 * 但固定慢档又会让跑命令时的输出滞后到肉眼可见（用户报的"不跟手"）。
 *
 * 于是：屏幕内容一变（或刚发过按键）就切到快档，静满 {@link SCREEN_FAST_WINDOW_MS} 后退回慢档。
 * 快档 200ms 的取值依据是"一次请求 ~80ms（合并 tmux 调用后）+ 一点余量"，不会让请求首尾相接。
 */
var SCREEN_IDLE_MS = 800      // 兜底（宿主设置里可调 panelPollMs；快档自动取它的 1/4）
var SCREEN_FAST_WINDOW_MS = 1500

/** 比较两个行数组的区间是否逐行相同（内部工具）。 */
function linesEqual(a, ai, b, bi, count) {
  if (count <= 0) return false
  for (let i = 0; i < count; i += 1) {
    if (a[ai + i] !== b[bi + i]) return false
  }
  return true
}

/**
 * 旧内容在新文档坐标里**整体位移了几行**（正数=下移，负数=上移）。
 *
 * 为什么需要它：面板显示的是「最后 N 行」的窗口，新输出会把**最上面的行挤掉**，
 * 于是同样的文字在新文档里整体上移了 K 行。scrollTop 不变 ≠ 阅读位置不变。
 *
 * 只处理两种可靠可辨的形态，判不准就返回 0（宁可不补偿，也不要乱跳）：
 *   A. 前面插入了行（例如点了「更多历史」把窗口翻倍）→ 整段旧内容成为新内容的后缀；
 *   B. 顶部被挤掉（窗口向下滑动 K 行）→ 新内容的第一行等于旧内容的第 K 行。
 */
function contentShift(prevLines, nextLines) {
  const m = prevLines.length
  const n = nextLines.length
  if (m === 0 || n === 0) return 0

  // A. 前面插入：旧内容整体落在新内容的末尾
  if (n > m && linesEqual(nextLines, n - m, prevLines, 0, m)) return n - m

  // B. 顶部被挤掉：新内容的首行在旧内容里的位置就是滑动量。
  //    验证时多比几行，避免内容里重复行导致的巧合误判；
  //    单次轮询不可能滑掉几百行，所以扫描范围有上限（也保证 700ms 轮询下开销可忽略）。
  const probe = Math.min(48, m, n)
  const limit = Math.min(m - 1, 600)
  // 重叠不足 3 行就没法把「窗口滑动」和「内容被换掉」区分开（例如整屏都是同一字符的进度条），
  // 此时不补偿更安全。
  const minOverlap = Math.min(3, m, n)
  for (let k = 0; k <= limit; k += 1) {
    if (m - k < minOverlap) break
    if (prevLines[k] !== nextLines[0]) continue
    if (linesEqual(prevLines, k, nextLines, 0, Math.min(probe, m - k, n))) return -k
  }
  return 0
}

/**
 * 新内容到达后该怎么滚 —— **纯函数**，因此「读历史时被顶上去」这类问题可以离线复现。
 *
 * 规则就是用户要的那两条：**贴底则跟随，否则保持阅读位置不动**。
 * 「保持不动」不是什么都不做，而是按 {@link contentShift} 补偿内容位移。
 *
 * @param {string} prevText - 上一次渲染的屏幕文本
 * @param {string} nextText - 本次拿到的屏幕文本
 * @param {{scrollTop: number, scrollHeight: number, clientHeight: number, pinned?: boolean,
 *          padding?: number}} view - `padding` 是屏幕区上下内边距之和（默认 0）
 * @returns {{scrollTop: number, pinned: boolean, shift: number, reason: 'follow'|'anchor'}}
 */
function scrollAnchor(prevText, nextText, view) {
  const prevLines = String(prevText ?? '').split('\n')
  const nextLines = String(nextText ?? '').split('\n')
  const scrollTop = Number.isFinite(view?.scrollTop) ? view.scrollTop : 0
  const scrollHeight = Number.isFinite(view?.scrollHeight) ? view.scrollHeight : 0
  const clientHeight = Number.isFinite(view?.clientHeight) ? view.clientHeight : 0
  const maxScroll = Math.max(0, scrollHeight - clientHeight)

  // 贴底（显式跟随，或数值上已经在底部容差内）→ 跟随到底
  const atBottom = view?.pinned === true || scrollTop >= maxScroll - AT_BOTTOM_PX
  if (atBottom) return { scrollTop: maxScroll, pinned: true, shift: 0, reason: 'follow' }

  // 行高必须扣掉上下内边距：scrollHeight 含 padding，直接除会每行略大一点（几十行一趟下来就偏几像素）
  const padY = Number.isFinite(view?.padding) ? view.padding : 0
  // 首选调用方量出来的行高；没有才退回旧推导（旧推导在"内容比视口矮"时会高估，见 resolveLineHeight）
  const measured = Number.isFinite(view?.lineHeight) && view.lineHeight > 0 ? view.lineHeight : 0
  const lineHeight = measured > 0
    ? measured
    : (nextLines.length > 0 ? Math.max(0, scrollHeight - padY) / nextLines.length : 0)
  const shift = contentShift(prevLines, nextLines)
  const wanted = Math.max(0, Math.min(maxScroll, scrollTop + shift * lineHeight))
  return { scrollTop: wanted, pinned: false, shift, reason: 'anchor' }
}

function sessionBusy(session, shellName) {
  if (session === null || typeof session !== 'object') return false
  const foreground = typeof session.foreground === 'string' ? session.foreground : ''
  if (foreground === '') return false
  const shell = typeof shellName === 'string' && shellName !== '' ? shellName : 'bash'
  return foreground !== shell && foreground !== '-' + shell
}

/**
 * 相对时间（授权目录的「最近使用」提示）：毫秒时间戳 → 「刚刚 / N 分钟前 / N 小时前 / N 天前」。
 * 非有限值返回空串（未知时间就不显示，别写一个吓人的 NaN）。
 */
function timeAgoText(ts) {
  if (!Number.isFinite(ts)) return ''
  const diff = Date.now() - ts
  if (diff < 60 * 1000) return '刚刚'
  if (diff < 3600 * 1000) return Math.floor(diff / 60000) + ' 分钟前'
  if (diff < 86400 * 1000) return Math.floor(diff / 3600000) + ' 小时前'
  return Math.floor(diff / 86400000) + ' 天前'
}

/**
 * 折叠态胶囊的显示模型 —— **纯函数**，因此显示逻辑可以脱离浏览器单测。
 *
 * 原来的胶囊是 `>_ 3 🔒`：那个 3 没说是什么、看不到在跑什么，而且**颜色语义反了** ——
 * 锁定（安全默认）被标成琥珀色警告，解锁（每个按键直接进终端）反而是绿色。
 *
 * 这里定死四件事：
 *   1. 显示**当前 shell 的名字**（去掉统一的 `dsh-` 前缀省宽度，超长截断），而不是一个裸数字；
 *   2. 只有一个 shell 时不显示 `1/1`（没有信息量的角标是噪音）；
 *   3. **锁：锁定时安静（tertiary），解锁时才用注意色**（warn）；
 *   4. 状态点反映「当前 shell 在不在跑」，工具提示里再给出「共几个在跑」。
 *
 * @param {{sessions?: Array, currentName?: string, locked?: boolean, shellName?: string}} input
 */
function pillModel(input) {
  const sessions = Array.isArray(input?.sessions) ? input.sessions.filter((s) => s !== null && typeof s === 'object') : []
  const currentName = String(input?.currentName || '')

  const shellName = typeof input?.shellName === 'string' && input.shellName !== '' ? input.shellName : 'bash'
  const locked = input?.locked === true

  const current = sessions.find((s) => s.name === currentName) ?? null
  const index = current === null ? 0 : sessions.indexOf(current) + 1
  const total = sessions.length
  const busy = sessionBusy(current, shellName)
  const running = sessions.filter((s) => sessionBusy(s, shellName)).length

  const fullName = current === null ? '' : String(current.name)
  // 显示名优先用户起的 label（@dsh-label，可改名）；没起名才回退稳定 id（去掉 dsh- 前缀）
  const labelName = current !== null && typeof current.label === 'string' && current.label.trim() !== ''
    ? current.label.trim()
    : fullName
  const withoutPrefix = labelName.startsWith('dsh-') ? labelName.slice(4) : labelName
  const label = current === null ? '无 shell' : (withoutPrefix.length > 16 ? withoutPrefix.slice(0, 15) + '…' : withoutPrefix)
  const counter = total > 1 && current !== null ? index + '/' + total : ''

  const lines = []
  if (current === null) {
    lines.push('还没有 shell —— 点击展开面板，用 ＋ 新建一个')
  } else {
    lines.push(fullName + (counter === '' ? '' : '（' + counter + '）'))
    lines.push(busy ? '有命令在前台运行：' + String(current.foreground) : '停在提示符（空闲）')
    if (running > 1) lines.push('全部 ' + String(total) + ' 个 shell 里有 ' + String(running) + ' 个在运行')
  }
  lines.push(locked ? '输入已锁定（点锁图标解锁；解锁后每个按键都会直接进终端）' : '⚠ 输入已解锁：每个按键都会直接进终端')
  lines.push('本插件未接入官方审批：模型的命令不会弹任何询问')
  lines.push('点击展开面板 · 按住拖动可移动')

  return {
    empty: current === null,
    label,
    fullName,
    counter,
    busy,
    running,
    total,
    /** 锁的颜色语义：锁定=安静，解锁=注意。 */
    lockTone: locked ? 'dim' : 'warn',
    dotTone: current === null ? 'none' : (busy ? 'busy' : 'idle'),
    title: lines.join('\n'),
  }
}

/**
 * 设置页在详情层里的显示值。
 *
 * 三种状态必须分开：**注册成功**才叫「已接入」；服务挂了但注册被拒是「未注册」并带上原因；
 * 老宿主（0.1.2 之前）压根不上报 `settings` —— 那就写「未知」，不能猜成「已接入」。
 */
function settingsRowValue(server) {
  const s = server?.settings
  if (s === undefined || s === null) return '未知（DSH 还没上报这个信息；重启 dsh web 后再看）'
  if (s.registered === true || (s.registered === undefined && s.live === true)) return '已接入（DSH 设置 → 插件里改）'
  return '未注册：' + String(s.note ?? '原因未上报')
}

/** 设置页那一行鼠标悬停的说明；没有额外信息时返回空串（不编造）。 */
function settingsRowTitle(server) {
  const s = server?.settings
  if (s === undefined || s === null || s.registered === true) return ''
  return String(s.note ?? '')
}

/**
 * 闸门那一行的显示值。
 *
 * 闸门是这组 HTTP 路由的唯一防线（它们没有鉴权），所以状态必须**如实**展示：
 * 谁在把关、被拒过几次、有没有降级成「Host 无法判定」。老宿主不上报就写「未知」。
 */
function fenceRowValue(server) {
  const fence = server?.fence
  if (fence === null || fence === undefined) return '未知（DSH 还没上报这个信息；重启 dsh web 后再看）'
  const authority = fence.authority === 'dsh-connection' ? 'DSH connection 服务' : '本地围栏'
  const blocked = Array.isArray(server.fenceBlocked) ? server.fenceBlocked.length : 0
  const base = authority + ' · ' + String(fence.boundHost ?? '?') + (fence.port === null || fence.port === undefined ? '' : ':' + String(fence.port))
  if (String(fence.note ?? '').startsWith('⚠')) return '⚠ ' + base + '（Host 围栏不可用）'
  return base + (blocked > 0 ? ' · 已拒 ' + String(blocked) + ' 次' : '')
}

/** 闸门行的悬停说明：降级原因或被拒记录，没有就返回空串（不编造）。 */
function fenceRowTitle(server) {
  const fence = server?.fence
  if (fence === null || fence === undefined) return ''
  const blocked = Array.isArray(server.fenceBlocked) ? server.fenceBlocked : []
  const parts = [String(fence.note ?? '')]
  if (blocked.length > 0) {
    const last = blocked[blocked.length - 1]
    parts.push('最近一次拒绝：' + String(last?.path ?? '?') + ' —— ' + String(last?.why ?? '?'))
  }
  return parts.filter((p) => p !== '').join('\n')
}

/** 审计那一行：开/关、保留多少天、目录在哪、链完整性、加锁状态、有没有写失败。 */
function auditRowValue(server) {
  const audit = server?.audit
  if (audit === null || audit === undefined) return '未知（DSH 还没上报这个信息；重启 dsh web 后再看）'
  if (audit.enabled !== true) return '已关闭（config.audit=false）'
  const note = String(audit.note ?? '')
  const base = `开 · 保留 ${String(audit.retentionDays ?? '?')} 天 · ${prettyPath(audit.dir ?? '?')}`
  // 链完整性：必须展示（校验结论不展示 = 没做）。null = 还没校验（启动未完成）。
  const chain = audit.chain ?? null
  const chainTag = chain === null ? '链未校验'
    : chain.ok ? `链✓(${String(chain.sealed)}条)`
      : '链⚠断(' + String(chain.brokenAt === null ? '?' : chain.brokenAt.index + 1) + '条)'
  const lockTag = audit.locked === 'append-only' ? '🔒已加锁'
    : audit.locked === 'writable' ? '未加锁' : '锁未知'
  let value = base + ' · ' + chainTag + ' · ' + lockTag
  if (note !== '') value = '⚠ ' + value + ' · ' + note
  return value
}

function auditRowTitle(server) {
  const audit = server?.audit
  if (audit === null || audit === undefined || audit.enabled !== true) return ''
  const lines = []
  lines.push('所有进入终端的输入都会记在这里（模型发起的 shell_send 与面板里人敲的键），含来源、发起会话与护栏决策。')
  const chain = audit?.chain ?? null
  if (chain !== null) {
    if (chain.ok) {
      lines.push(`哈希链校验通过：${String(chain.sealed)} 条封链${chain.startUnknown ? '（起点未知：更早的文件没读到）' : ''}；头 ${String(chain.head ?? '')}`)
    } else {
      lines.push('⚠ 哈希链断链于第 ' + String(chain.brokenAt === null ? '?' : chain.brokenAt.index + 1) + ' 条（' + String(chain.brokenAt?.reason ?? '?') + '）—— 审计可能被篡改或写坏。')
    }
  }
  const lock = audit?.locked ?? 'unknown'
  if (lock === 'append-only') lines.push('📦 目录已加锁（chattr +a）：内核级只追加，任何人都不能删/改 —— 过期日志需人工 sudo 归档。')
  else if (lock === 'writable') lines.push('📦 目录未加锁：篡改可检测（哈希链），但物理上可改。要不可篡改，跑 install-deps.sh --audit-lock 加锁。')
  else lines.push('📦 目录锁定状态未知（lsattr 不可用）。')
  return lines.join('\n')
}

/** 审计链校验那一行：通过/断链/未校验 —— 篡改可见的结论必须展示。 */
function chainRowValue(server) {
  const chain = server?.audit?.chain ?? null
  if (chain === null) return chainUnknownText(server)
  if (chain.ok === true) {
    const extra = []

    if (chain.startUnknown === true) extra.push('起点未知')
    return '✓ 通过 · ' + String(chain.sealed) + ' 条封链' + (extra.length > 0 ? '（' + extra.join('，') + '）' : '')
  }
  const at = chain.brokenAt === null || chain.brokenAt === undefined ? '?' : String(chain.brokenAt.index + 1)
  return '⚠ 断链 · 第 ' + at + ' 条（' + String(chain.brokenAt?.reason ?? '?') + '）'
}

function chainUnknownText(server) {
  const audit = server?.audit
  if (audit === null || audit === undefined) return '未知（DSH 还没上报这个信息；重启 dsh web 后再看）'
  if (audit.enabled !== true) return '未启用（config.audit=false）'
  return '还没核对（DSH 还没跑完校验）；记录链本身由每条记录的前后指纹保证'
}

function chainRowTitle(server) {
  const chain = server?.audit?.chain ?? null
  if (chain !== null && chain.ok === false) {
    return '审计哈希链出现断点：第 ' + String((chain.brokenAt?.index ?? 0) + 1) + ' 条记录与前一条对不上 —— '
      + '可能被人改过、删过或写坏了。请核对 shell_audit 与审计目录。'
  }
  return '每条审计记录都携带前一条的摘要（SHA-256 哈希链）：删一条、改一个字节、调换顺序都会断链。'
    + '这里显示的就是最近一次整链校验的结论' + (chain !== null && chain.checkedAt ? '（检查于 ' + new Date(chain.checkedAt).toLocaleString() + '）' : '') + '。'
}

/** 审计目录锁定那一行：内核级只追加（chattr +a）还是仅可检测。 */
function lockRowValue(server) {
  const audit = server?.audit
  if (audit === null || audit === undefined) return '未知（DSH 还没上报这个信息；重启 dsh web 后再看）'
  if (audit.enabled !== true) return '未启用（config.audit=false）'
  const locked = audit.locked
  if (locked === 'append-only') return '🔒 已加锁（chattr +a）· 不可删/改，只能追加'
  if (locked === 'writable') return '未加锁 · 篡改可检测但物理可改'
  return '未知（lsattr 不可用）；加锁方法见 install-deps.sh --audit-lock'
}

function lockRowTitle(server) {
  const locked = server?.audit?.locked
  if (locked === 'append-only') {
    return '审计目录是内核级 append-only（chattr +a）：任何人都不能在其中删除/改名文件，只能追加。'
      + '代价：插件无法自动清理过期日志，需要人工用 sudo 归档。解除：sudo chattr -a <审计目录>。'
  }
  if (locked === 'writable') {
    return '审计目录是普通目录：篡改会被哈希链发现（可检测），但物理上仍可改。'
      + '要升级为「不可篡改」，跑 ./install-deps.sh --audit-lock（需要一次 sudo）。'
  }
  return '无法判断目录锁定状态（lsattr 不可用）。加锁是可选项，见 install-deps.sh --audit-lock。'
}

/** 输出留痕那一行：开关、上限、以及触顶被停掉的会话（停掉这件事本身也是信息）。 */
function captureRowValue(server) {
  const audit = server?.audit
  if (audit === null || audit === undefined) return '未知（DSH 还没上报这个信息；重启 dsh web 后再看）'
  if (audit.capture !== true) return '已关闭（config.captureOutput=false）'
  const mb = Number.isFinite(audit.captureMaxBytes) ? Math.round(audit.captureMaxBytes / (1024 * 1024)) + ' MiB' : '?'
  const stopped = Array.isArray(audit.captureStopped) ? audit.captureStopped : []
  const base = `开 · 单会话上限 ${mb} · output/`
  return stopped.length === 0 ? base : `⚠ ${base} · 已停 ${stopped.length} 个会话（触顶）`
}

function captureRowTitle(server) {
  const audit = server?.audit
  if (audit === null || audit === undefined || audit.capture !== true) return ''
  return '终端输出（含回显的命令与程序输出）原样写到 audit 目录的 output/ 下，会话关掉后文件仍在。注意：终端里出现过的敏感内容也会被一起记下来。'
}

/** tmux 那一行：版本，或者「缺什么、怎么装」。 */
function tmuxRowValue(server) {
  const tmux = server?.tmux
  if (tmux === null || tmux === undefined) return '未知（DSH 还没上报，或自检还没跑完）'
  if (tmux.ok === true) return String(tmux.version ?? 'available')
  return '⚠ 不可用：' + String(tmux.error ?? '未知原因') + '（需安装 tmux；Windows 请在 WSL 里运行）'
}

/**
 * 「关闭 shell」为什么要两步。
 *
 * 它紧挨着「收起」按钮，而两者后果完全不同：收起只是把面板变回胶囊，关闭会**连同里面
 * 正在跑的进程一起结束**（不可撤销）。相邻 + 一步执行 = 误触就丢工作。所以：第一次点
 * 只是**进入待确认**（按钮变红并提示"再点一次"），第二次才真的关；3 秒内没有第二次就自动复位。
 */
/**
 * 头部要不要进入紧凑模式。
 *
 * 起因是一个真实的 UI bug：面板最小宽度（MIN_W=360）小于头部固定内容之和，横向缩到最小时
 * 关闭/收起按钮会被挤到浮窗外面。宁可先隐藏次要信息（计数、标题文字、抓手、分隔线），
 * 也不能让按钮跑出面板。阈值是实测估的：9 个按钮 ×26px + 名称 + 间隔 + 内边距。
 */
var HEAD_FULL_W = 470
/** 0.3.4 (C)：批量选择的摘要（纯函数，供 UI 与测试共用）。 */
function batchSummary(all, selected) {
  const list = Array.isArray(all) ? all.map((s) => (typeof s === 'string' ? s : s && s.name)).filter((n) => typeof n === 'string') : []
  const sel = Array.isArray(selected) ? selected.filter((n) => list.includes(n)) : []
  return { total: list.length, count: sel.length, allSelected: list.length > 0 && sel.length === list.length, selected: sel }
}

/**
 * 0.3.4：把「带 ANSI 的屏文本」解析成「纯文本 + 样式段」。
 *
 * 背景：capture-pane 加 `-e` 后 tmux 把颜色（SGR 转义）带进屏幕文本。前端要**像真终端
 * 一样**呈现颜色/背景/粗细/下划线/反显，但搜索/光标换算/`<pre>` 文本结构仍需要纯文本。
 * 所以这里一次性完成两件事：
 *   * 剥掉所有 ANSI 控制序列，得到逐字符对应的纯文本（下标可直接用于搜索与光标换算）；
 *   * 按 SGR 状态切出 `segments: [{from, to, style}]`（from/to 是**纯文本**下标区间），
 *     渲染层据此给每段套 `style={{color, backgroundColor, fontWeight, ...}}`。
 *
 * 支持的 SGR：前景 30–37 / 亮色 90–97 / 256 色 38;5;n / 真彩 38;2;r;g;b，背景同理
 * (40–47 / 100–107 / 48;5;n / 48;2;r;g;b)，0 重置、1 加粗、3 斜体、4 下划线、7 反显、
 * 22/23/24/27 逐一关闭。其余控制序列（光标移动等 tmux 通常不产生）按"跳过并保持
 * 文本连续"处理 —— 屏幕上不该出现 `^[[…m` 之类乱码。
 *
 * @param {string} raw - 可能含 ANSI 的屏文本
 * @returns {{text: string, segments: Array<{from: number, to: number, style: object}>}}
 */
function parseAnsi (raw) {
  const src = String(raw ?? '')
  let text = ''
  const segments = []
  // 当前 SGR 状态（null 表示"与默认一致"，渲染层不显式覆盖）
  let fg = null; let bg = null; let bold = false; let italic = false; let underline = false; let reverse = false
  let curStart = 0
  const emit = () => {
    if (text.length - curStart > 0) {
      segments.push({ from: curStart, to: text.length, style: { fg, bg, bold, italic, underline, reverse } })
    }
  }
  const setState = (fg2, bg2, bold2, italic2, underline2, reverse2) => {
    emit()
    fg = fg2; bg = bg2; bold = bold2; italic = italic2; underline = underline2; reverse = reverse2
    curStart = text.length
  }
  const reset = () => setState(null, null, false, false, false, false)
  const SGR_RE = /^\x1b\[([0-9;]*)m/
  let i = 0
  while (i < src.length) {
    const ch = src.charCodeAt(i)
    if (ch === 0x1b) {
      const m = SGR_RE.exec(src.slice(i))
      if (m !== null) {
        const params = m[1] === '' ? ['0'] : m[1].split(';')
        let f = fg; let b = bg; let bo = bold; let it = italic; let un = underline; let rv = reverse
        const apply = (p) => {
          const n = Number.parseInt(p, 10)
          switch (n) {
            case 0: f = null; b = null; bo = false; it = false; un = false; rv = false; break
            case 1: bo = true; break
            case 3: it = true; break
            case 4: un = true; break
            case 7: rv = true; break
            case 22: bo = false; break
            case 23: it = false; break
            case 24: un = false; break
            case 27: rv = false; break
            case 30: case 31: case 32: case 33: case 34: case 35: case 36: case 37:
              f = n - 30; break
            case 90: case 91: case 92: case 93: case 94: case 95: case 96: case 97:
              f = n - 90 + 8; break
            case 40: case 41: case 42: case 43: case 44: case 45: case 46: case 47:
              b = n - 40; break
            case 100: case 101: case 102: case 103: case 104: case 105: case 106: case 107:
              b = n - 100 + 8; break
            default:
              if (p === '38' || p === '48') {
                // 38;5;n 或 38;2;r;g;b —— 由调用方把后续参数组吃进来（这里只管 flag）
              }
          }
        }
        // 解析参数序列：38/48 后面可跟 5;n 或 2;r;g;b（可能是同一串里，也可能跨分号）
        const queue = params.slice()
        let next = 0
        while (next < queue.length) {
          const p = queue[next]
          if (p === '38' && queue[next + 1] === '5') {
            const n = Number.parseInt(queue[next + 2], 10)
            if (Number.isFinite(n) && n >= 0 && n <= 255) f = n
            next += 3
          } else if (p === '38' && queue[next + 1] === '2') {
            const r = Number.parseInt(queue[next + 2], 10); const g = Number.parseInt(queue[next + 3], 10); const b2 = Number.parseInt(queue[next + 4], 10)
            if ([r, g, b2].every((v) => Number.isFinite(v) && v >= 0 && v <= 255)) f = { r, g, b: b2 }
            next += 5
          } else if (p === '48' && queue[next + 1] === '5') {
            const n = Number.parseInt(queue[next + 2], 10)
            if (Number.isFinite(n) && n >= 0 && n <= 255) b = n
            next += 3
          } else if (p === '48' && queue[next + 1] === '2') {
            const r = Number.parseInt(queue[next + 2], 10); const g = Number.parseInt(queue[next + 3], 10); const b2 = Number.parseInt(queue[next + 4], 10)
            if ([r, g, b2].every((v) => Number.isFinite(v) && v >= 0 && v <= 255)) b = { r, g, b: b2 }
            next += 5
          } else {
            apply(p)
            next += 1
          }
        }
        setState(f, b, bo, it, un, rv)
        i += m[0].length
        continue
      }
      // 非 SGR 的 ESC 序列（CSI 其它 / OSC）：跳到下一个可打印字符，文本保持连续
      let j = i + 1
      if (src[j] === '[') {
        j += 1
        while (j < src.length && !(src.charCodeAt(j) >= 0x40 && src.charCodeAt(j) <= 0x7e)) j += 1
        i = Math.min(src.length, j + 1)
      } else if (src[j] === ']') {
        j += 1
        while (j < src.length && src[j] !== '\u0007' && !(src[j] === '\u001b' && src[j + 1] === '\\')) j += 1
        i = Math.min(src.length, j + (src[j] === '\u0007' ? 1 : 2))
      } else {
        i += 2
      }
      continue
    }
    // C0 控制：换行/制表保留（它们就是文本结构），其余（如 \r）并入文本流让行结构稳定
    if (ch === 0x0d) { i += 1; continue }
    if (ch < 0x20 && ch !== 0x0a && ch !== 0x09) { i += 1; continue }
    text += src[i]
    i += 1
  }
  emit()
  return { text, segments }
}

/**
 * 0.3.4 (A)：屏幕文本查找（大小写不敏感）。返回命中行号（0-based）与总命中数。
 * 纯函数：面板高亮/跳转与测试共用一条判定。
 */
function searchMatches(text, query) {
  const q = String(query ?? '')
  const lines = String(text ?? '').split('\n')
  if (q === '') return { count: 0, lineHits: [] }
  const needle = q.toLowerCase()
  const lineHits = []
  let count = 0
  for (let i = 0; i < lines.length; i += 1) {
    const hay = lines[i].toLowerCase()
    let at = hay.indexOf(needle)
    let n = 0
    while (at >= 0) { n += 1; at = hay.indexOf(needle, at + needle.length) }
    if (n > 0) { lineHits.push(i); count += n }
  }
  return { count, lineHits }
}

/** 0.3.4 (A)：把一行按关键字切成 [{text, hit}] 片段，供高亮渲染。 */
function splitHighlight(line, query) {
  const q = String(query ?? '')
  const src = String(line ?? '')
  if (q === '') return [{ text: src, hit: false }]
  const hay = src.toLowerCase()
  const needle = q.toLowerCase()
  const out = []
  let at = 0
  for (;;) {
    const i = hay.indexOf(needle, at)
    if (i < 0) { if (at < src.length) out.push({ text: src.slice(at), hit: false }); break }
    if (i > at) out.push({ text: src.slice(at, i), hit: false })
    out.push({ text: src.slice(i, i + needle.length), hit: true })
    at = i + needle.length
  }
  if (out.length === 0) out.push({ text: src, hit: false })
  return out
}

/** SGR style 对象 → React style（reverse 反显时前景/背景互换 = 终端反显语义）。 */
function sgrStyleToCss(style) {
  const css = {}
  const fg = style?.fg
  const bg = style?.bg
  const reverse = style?.reverse === true
  const f = reverse ? (bg === null || bg === undefined ? null : bg) : fg
  const b = reverse ? (fg === null || fg === undefined ? null : fg) : bg
  if (f !== null && f !== undefined) css.color = colorValue(f)
  if (b !== null && b !== undefined) css.backgroundColor = colorValue(b)
  if (style?.bold === true) css.fontWeight = 'bold'
  if (style?.italic === true) css.fontStyle = 'italic'
  if (style?.underline === true) css.textDecoration = 'underline'
  return css
}

/** 颜色值（数字=16 色/256 色索引表，对象=真彩）→ CSS。拿不到就回退白/黑，不让渲染崩。 */
function colorValue(v) {
  if (v === null || v === undefined) return null
  if (typeof v === 'object' && Number.isFinite(v.r) && Number.isFinite(v.g) && Number.isFinite(v.b)) {
    return `rgb(${Math.max(0, Math.min(255, v.r))},${Math.max(0, Math.min(255, v.g))},${Math.max(0, Math.min(255, v.b))})`
  }
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  // 16 色基础表（0–15，含亮色 8–15）—— 与终端色板语义对齐（常见主题近似）
  const TABLE = [
    '#000000', '#cc0000', '#4e9a06', '#c4a000', '#3465a4', '#75507b', '#06989a', '#d3d7cf',
    '#555753', '#ef2929', '#8ae234', '#fce94f', '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec',
  ]
  if (n < 16) return TABLE[n]
  // 256 色：16–231 是 6×6×6 色阶，232–255 是灰度
  if (n <= 231) {
    const idx = n - 16
    const r = Math.round((Math.floor(idx / 36) % 6) * 255 / 5)
    const g = Math.round((Math.floor(idx / 6) % 6) * 255 / 5)
    const b = Math.round((idx % 6) * 255 / 5)
    return `rgb(${r},${g},${b})`
  }
  const gray = Math.round(((n - 232) * 255 + 11) / 22)
  return `rgb(${gray},${gray},${gray})`
}

/**
 * 0.3.4：把「带 ANSI 的屏文本」渲染成 React 节点数组 —— 颜色/粗细/反显（parseAnsi
 * 的样式段）与搜索高亮（splitHighlight 的命中段）**正交合并**：
 * 样式切在**纯文本**下标上，高亮也切在纯文本下标上，两者按边界并集切成最终段。
 *
 * 纯函数（不产生元素，只返回描述对象），测试与渲染共用：
 *   [{ text, style?: css, hit?: boolean }]
 *
 * @param {string} raw - 带 ANSI 的屏文本（整屏，多行交由调用方按行处理）
 * @param {object} search - { query, lineHits? }；query 非空时对本行做命中切分
 * @returns {{ lines: Array<Array<{text, style?, hit?}>>, plain: string }}
 */
function renderScreenLines(raw, search) {
  const { text, segments } = parseAnsi(String(raw ?? ''))
  const q = String(search?.query ?? '').trim()
  const lines = []
  const lineStarts = []
  // 每行的起始下标（纯文本）
  let at = 0
  const parts = text.split('\n')
  for (let idx = 0; idx < parts.length; idx += 1) { lineStarts.push(at); at += parts[idx].length + 1 }
  for (let idx = 0; idx < parts.length; idx += 1) {
    const lineText = parts[idx]
    const segsInLine = segments
      .filter((s) => s.to > lineStarts[idx] && s.from < lineStarts[idx] + lineText.length + ((idx + 1 < parts.length) ? 1 : 0))
      .map((s) => ({
        from: Math.max(s.from, lineStarts[idx]),
        to: Math.min(s.to, lineStarts[idx] + lineText.length),
        style: s.style,
      }))
      .filter((s) => s.to > s.from)
    // 搜索命中段（本行内）
    const hits = q === '' ? [] : splitHighlight(lineText, q).map((seg) => ({ ...seg, hit: seg.hit }))
    // 合并：把样式段与命中段都投影到"行内下标"，按边界并集切分
    const bounds = new Set([0, lineText.length])
    for (const s of segsInLine) { bounds.add(s.from - lineStarts[idx]); bounds.add(s.to - lineStarts[idx]) }
    // 命中段线性扫描（低命中率场景足够）
    const hitList = []
    {
      let rel = 0
      for (const h of hits) {
        if (!h.hit) { rel += h.text.length; continue }
        hitList.push({ at: rel, len: h.text.length })
        rel += h.text.length
      }
    }
    for (const h of hitList) { bounds.add(h.at); bounds.add(h.at + h.len) }
    const sorted = [...bounds].filter((v) => v >= 0 && v <= lineText.length).sort((a, b) => a - b)
    const nodes = []
    for (let bi = 0; bi < sorted.length - 1; bi += 1) {
      const from = sorted[bi]; const to = sorted[bi + 1]
      if (to <= from) continue
      const piece = lineText.slice(from, to)
      if (piece === '') continue
      const seg = segsInLine.find((s) => s.from - lineStarts[idx] <= from && s.to - lineStarts[idx] >= to)
      const hit = hitList.find((h) => h.at <= from && h.at + h.len >= to)
      const css = seg === undefined ? null : sgrStyleToCss(seg.style)
      nodes.push({
        text: piece,
        // 无样式段显式给 null（渲染层走纯文本，不包 span）
        style: css === null || (Object.keys(css).length === 0) ? null : css,
        hit: hit !== undefined,
      })
    }
    if (nodes.length === 0 && lineText === '') nodes.push({ text: '', style: null, hit: false })
    lines.push(nodes)
  }
  return { lines, plain: text }
}

/**
 * 0.3.4：粘贴模式判定 —— 多行或超长文本整块走 paste-buffer（逐键会放大出错面）。
 * 纯函数：面板 (client) 与测试共用同一条判定。
 */
function needsPaste(text) {
  return String(text).includes('\n') || String(text).length > 256
}

function headCompact(width) {
  return !(typeof width === 'number' && Number.isFinite(width) && width >= HEAD_FULL_W)
}

/**
 * 授权按钮的状态模型（纯函数，便于离线测）。
 *
 * 语义：面板是在浏览器侧跑的，它不知道「当前是哪个对话」，所以面板能表达的主动授权就是
 * 「所有对话都放行」；撤销则同时清掉通配与逐对话授权（面板是唯一能表达这个意图的地方）。
 */
/**
 * 授权按钮模型（0.3.4 新模型：默认规则 + 每会话复制，无全局授权）。
 *
 * 语义：按钮反映「默认授权规则」= 新会话复制的那条。
 *   · 默认规则非 deny（full/read）→ 新会话默认可用，按钮亮绿；
 *   · 默认规则 deny（出厂默认）→ 新会话默认被禁，按钮灰。
 * count = 已单独设置（非 deny）的会话数；active = 授权浮层打开（按下态）。
 */
function consentButtonModel(consent, active) {
  const known = consent !== null && typeof consent === 'object' ? consent : {}
  const def = known.defaultRule !== null && typeof known.defaultRule === 'object' ? known.defaultRule : {}
  const defScope = def.scope
  const allowed = defScope === 'full' || defScope === 'read'
  const count = Array.isArray(known.granted) ? known.granted.length : 0
  return {
    enabled: true,
    allowAll: allowed,   // 兼容字段：语义 = 默认规则放行
    count,
    icon: 'shield',
    // 与头部其它按钮（详情/日志/引用库）**完全同构**：className 只给基础类，
    // "我这个浮层开着"由渲染处统一加 on。常驻的"默认放行"状态不再占用 class ——
    // 它此前也写成 on，于是关掉浮层后按钮依然是绿的，看起来像"关闭没生效"（用户实报）。
    className: 'dshsh-btn',
    label: allowed ? '默认放行' : '默认禁止',
    title: allowed
      ? '默认授权规则：新会话复制「' + (CONSENT_SCOPE_LABELS[defScope] ?? defScope) + '」——新建的 shell 默认可用（另有 ' + String(count) + ' 个会话单独设过）。点击进入授权页改规则'
      : '默认授权规则：禁止（出厂默认）——新会话复制它，新建的 shell 默认不可用。点击进入授权页把它设为允许',
  }
}

/** 档位的中文名（宿主也会给目录，这里只是渲染与测试用的兜底）。 */
var CONSENT_SCOPE_LABELS = { full: '完全控制', read: '只读', deny: '完全禁止' }

/**
 * 每个档位的**后果**一句话（成熟授权界面的共同点：不只给名字，还讲清"同意之后会发生什么"）。
 * 这三句与宿主侧 SECURITY 口径一致，改文案时两边一起改。
 */
var CONSENT_SCOPE_HINTS = {
  full: 'AI 以你的用户权限执行任意命令：读写文件、装软件、发网络请求，包括删除',
  read: '只能看：列会话、读屏、查审计。不能发送输入、不能开关或改会话',
  deny: '拒绝这个对话使用本插件；之后不再询问（撤销可恢复）',
}

/** 授权复核句：把"给谁 · 什么档位 · 多久"合成一句，点按钮前一眼看清。 */
function consentReviewText (who, scope, ttlLabel) {
  const name = String(who ?? '').trim() || '(未选择)'
  const s = CONSENT_SCOPE_LABELS[scope] ?? String(scope ?? '?')
  return `将授权「${name}」· ${s} · ${String(ttlLabel ?? '')}`
}

/** 授权浮层顶部的状态徽标（当前全局档位）。tone: 'on' | 'off' | 'warn'。 */
function consentStatusChip (defaultRule) {
  const def = defaultRule !== null && typeof defaultRule === 'object' ? defaultRule : {}
  const scope = CONSENT_SCOPE_LABELS[def.scope] ?? (def.scope === undefined ? '未设置' : String(def.scope ?? '?'))
  if (def.scope === undefined || def.scope === null) return { label: '默认规则：未设置（按禁止处理）', tone: 'off' }
  const ttl = typeof def.ttlSeconds === 'number' && def.ttlSeconds > 0
    ? '限期' : '永久'
  return { label: `默认规则：${scope} · ${ttl}`, tone: def.scope === 'deny' ? 'warn' : 'on' }
}

/**
 * 0.3.4 授权页人性化：把「当前全局档 + 单独授权数」合成一行概览文案。
 * 借鉴系统权限面板：进页面第一眼看到「现在是什么状态」，而不是从选项里猜。
 * @param {object|null} consent - server.consent
 * @returns {{primary: string, detail: string, dotTone: string}} primary=主状态行 / detail=补充
 */
function consentOverviewModel(consent) {
  const known = consent !== null && typeof consent === 'object' ? consent : {}
  const def = known.defaultRule !== null && typeof known.defaultRule === 'object' ? known.defaultRule : {}
  const defScope = def.scope
  const grantedCount = Array.isArray(known.granted) ? known.granted.length : 0
  const allowed = defScope === 'full' || defScope === 'read'
  const label = CONSENT_SCOPE_LABELS[defScope] ?? (defScope === null ? '未设置' : defScope)
  const primary = allowed
    ? '默认放行：新会话复制「' + label + '」'
    : '默认禁止：新会话复制「' + label + '」（出厂默认）'
  const detail = grantedCount > 0
    ? grantedCount + ' 个会话单独设过规则（不受默认影响）'
    : '还没有会话单独设过规则'
  // 0.4.0：模式决定"改动类工具能不能用" —— 面板第一眼要看到它。
  // 会话自己的模式优先（服务端在判定时记在 entry.mode 上），读不到才退回部署默认。
  const mode = typeof known.mode === 'string'
    ? known.mode
    : (typeof known.permissionMode === 'string' ? known.permissionMode : null)
  const modeLabel = mode === 'danger-full-access'
    ? '完全控制'
    : (mode === 'workspace-write'
      ? '工作区（只可查）'
      : (mode === 'read-only' ? '只读（只可查）' : '未读到'))
  // 改动类工具（shell_open/run/send/manage）只在完全控制下可用；只查类（state/read/audit）恒可用。
  const fullUsable = mode === null || mode === 'danger-full-access'
  // 快照里的 defaultRule.derived = 这个默认档是按模式推导出来的（用户没在面板里显式设过）。
  // 不显示这个标记，面板就会出现"写着默认禁止、行为却是完全控制"的矛盾（子 agent 实测到过）。
  const defaultDerived = known.defaultRule !== null && typeof known.defaultRule === 'object'
    && known.defaultRule.derived === true
  return {
    primary, detail, dotTone: allowed ? 'ok' : 'warn',
    modeLabel, modeKnown: mode !== null, fullUsable, defaultDerived,
    // 紧凑短标（浮层顶部一行放得下）；完整说明放 capabilityLong 供 hover 显示
    capability: '只查 ✓ · 改动 ' + (fullUsable ? '✓' : '✗'),
    capabilityLong: '只查（shell_state / shell_read / shell_audit）始终可用；'
      + '改动类（shell_open / shell_run / shell_send / shell_manage）'
      + (fullUsable ? '在完全控制模式下可用。' : '在当前模式下不可用 —— 用它会绕过文件沙箱，所以被禁用。'),
    modeShort: mode === 'danger-full-access' ? '完全控制'
      : (mode === 'workspace-write' ? '工作区（只可查）'
        : (mode === 'read-only' ? '只读（只可查）' : '未读到')),
  }
}

/**
 * 详情页的卡片归属（方案 A）：把 buildInfoRows 的**逻辑分组**映射到 6 张**可折叠卡片**。
 *
 * 为什么在渲染层映射而不是改 buildInfoRows：分组是数据语义（测试也按它断言），
 * 卡片是展示结构 —— 两者分开后，改动展示不必动数据、也不会破坏既有断言。
 * 2026-09-22 整理（信息数量不变）：原来「系统」卡把服务端+运行参数+启动+看门狗
 * 塞成一卡（30+ 行），观感杂乱。重排为 6 张主题聚焦卡，每张一主题、默认只开
 * 高频两张，其余按需展开 —— 该看的都在，不用在长列表里翻：
 *   · 会话 —— 当前会话 + 缓冲（最常看的）
 *   · 服务端 —— 连接/默认值/系统依赖/能力（这台机器上插件长什么样）
 *   · 运行参数 —— 生效配置一览（设置页改了立刻看得见）
 *   · 插件状态 —— 启动全流程（读宿主 /status）+ 孤儿看门狗
 *   · 安全审批状态 —— 审计链/加锁/留痕/护栏 + 官方审批（"可信"相关的都在这）
 *   · 关于 —— 版本 + 键位表
 */
/** 详情页签（0.4.0 重新整理：10 个分组 → 5 个页签，样式复用统一的 .dshsh-u-tabs）。 */
/**
 * 组的加密模式 → 界面文案（**唯一映射点**）。
 * 背景：加第三种模式（obfuscate）时，分组表那列只写了"none / 其它"两路判断
 * ⇒ 简单混淆组被显示成「口令加密」，与磁盘上的实际模式完全对不上（用户报的就是这个）。
 * 现在所有模式文案都走这里；**未知模式原样回显**，绝不猜成某一种。
 */
/** 列的最小宽度（px）：拖动与双击自适应都引用它 —— 用户要求「更小的固定最低值」。 */
var MIN_COL_PX = 28
/** 列宽拖拽抑制：在列分隔线上按下后，浏览器仍会在 mouseup 时派发 click，
 *  那会落到表头的排序回调上（实测：拖列宽会改变排序）。用一个短时效标记抑制它。
 *  放在模块级是因为 UI.Table 是普通函数，每次渲染都会重建内部闭包。 */
var COLDRAG = { at: 0, key: '' }
/** 列表可用宽度（px）：由面板在渲染时写入（面板宽度 - 内边距）。
 *  这是「纯计算默认填充」的输入之一 —— 单个数，无 hook、无测量、无 setState。 */
var LIST_AVAIL = 0

/**
 * 列表默认填充策略（用户规格，纯函数便于测试）：
 *   ① 先按**内容自适应**得到每列的期望宽度；
 *   ② 若总宽**不足**父容器 ⇒ 剩余空间**每列平分**；
 *   ③ 若总宽**超出**父容器 ⇒ 只压缩 flex === true 的“可压缩列”（如宏命令的内容列、备注列），
 *      按期望宽度等比压缩，最低 MIN_COL_PX；仍不够就整体溢出（交给横向滚动）。
 * 返回：列名 → 百分比字符串（占父容器）。
 */
function planColumnWidths (items, avail) {
  // 返回「列名 → 整数像素」，总和**恰为** avail。
  // 余数（像素不能被整除时）按用户规则：给**最前面的几列**每列 +1px。
  const list = Array.isArray(items) ? items : []
  const n = list.length
  if (n === 0 || !(avail > 0)) return {}
  const total = Math.max(n, Math.floor(avail))
  const want = (it) => Math.max(MIN_COL_PX, Math.ceil(Number(it?.content) || 0))
  let contentSum = 0
  for (const it of list) contentSum += want(it)
  const raw = {}
  if (contentSum <= total) {
    // ② 富余按内容宽度**按比例**分配（2026-10-24 改：原先平分会把「键数」这种两位数窄列撑宽）。
    //    等宽列（内容相同）仍得到等分 —— 与原有 201/200 的断言一致。
    const extra = total - contentSum
    for (const it of list) raw[it.key] = want(it) + extra * (want(it) / contentSum)
  } else {
    const flex = list.filter((it) => it !== null && it !== undefined && it.flex === true)
    const rigid = list.filter((it) => it === null || it === undefined || it.flex !== true)
    let rigidSum = 0
    for (const it of rigid) rigidSum += want(it)
    const budget = Math.max(0, total - rigidSum)
    let flexWant = 0
    for (const it of flex) flexWant += want(it)
    const scale = flexWant > 0 ? Math.min(1, budget / flexWant) : 1       // ③ 只压可压缩列
    for (const it of rigid) raw[it.key] = want(it)
    for (const it of flex) raw[it.key] = Math.max(MIN_COL_PX, want(it) * scale)
  }
  // ④ 上限：内容天生很窄的列（例如「键值对」只有一两位数）不该被“富余平分”撑宽。
  //    超过上限的部分按其它列的可增空间比例分回去；只做一轮，足够收敛。
  const capped = list.filter((it) => Number.isFinite(Number(it.max)) && Number(it.max) > 0)
  if (capped.length > 0) {
    let freed = 0
    for (const it of capped) {
      const cap = Number(it.max)
      if (raw[it.key] > cap) { freed += raw[it.key] - cap; raw[it.key] = cap }
    }
    if (freed > 0) {
      const open = list.filter((it) => raw[it.key] !== undefined
        && (!Number.isFinite(Number(it.max)) || raw[it.key] < Number(it.max)))
      const base = open.reduce((acc, it) => acc + raw[it.key], 0)
      if (base > 0) for (const it of open) raw[it.key] += freed * (raw[it.key] / base)
      else if (open.length > 0) for (const it of open) raw[it.key] += freed / open.length
    }
  }
  let sumRaw = 0
  for (const k of Object.keys(raw)) sumRaw += raw[k]
  if (!(sumRaw > 0)) return {}
  const out = {}
  let used = 0
  for (const it of list) {
    const v = Math.max(1, Math.floor(raw[it.key] / sumRaw * total))
    out[it.key] = v
    used += v
  }
  let rest = total - used
  for (let i2 = 0; i2 < list.length && rest > 0; i2 += 1) { out[list[i2].key] += 1; rest -= 1 }
  if (rest < 0) { for (let i2 = list.length - 1; i2 >= 0 && rest < 0; i2 -= 1) { if (out[list[i2].key] > 1) { out[list[i2].key] -= 1; rest += 1 } } }
  return out
}

function modeLabel (mode) {
  if (mode === 'none') return '不加密'
  if (mode === 'obfuscate') return '简单混淆'
  if (mode === 'passphrase') return '口令加密'
  if (mode === 'keychain') return '系统钥匙串（未启用）'
  return mode === undefined || mode === null || mode === '' ? '不加密' : String(mode)
}

var INFO_TAB_OF = {
  // 2026-10-24 收拢：11 个页签 → 8 个。**条目本身一个没删**，只是换了归属容器：
  //   概览 = 当前会话 + 会话台账 + 订阅表（订阅不再是独立页签，它本来就是一张表）
  //   运行 = 服务端 / 运行参数 / 启动 / 启动流程 / 孤儿看门狗 / 版本
  //   安全 = 审计与镜像 / 审批与安全 / 官方审批
  当前会话与取景: '概览', 当前会话: '概览', 缓冲与取景: '概览',
  会话台账与策略: '概览', 会话台账: '概览', 会话策略: '概览',
  订阅列表: '概览',
  审计与镜像: '安全', 审批与安全: '安全', 官方审批: '安全',
  服务端: '运行', 运行参数: '运行',
  启动: '运行', 孤儿看门狗: '运行', 启动流程: '运行', 版本: '运行',
  生命周期: '运行',      // 独立说明页已并入「帮助」的折叠卡；这行只防未来新增同名数据组
  面板提示记录: '事件记录',
  键事件: '引用库事件',   // 子视图：从「事件记录」进入
  键位表: '键位帮助', 面板快捷键: '键位帮助',
}
/**
 * 详情页三层可见页签（2026-10-24 重新整理：11 → 8）：
 *   状态 = 总览 / 概览 / 运行 / 安全；
 *   记录 = 事件记录 / 引用库事件 / 日志审计；
 *   帮助 = 键位帮助（内含可折叠的「生命周期与资源归属」）。
 * 收拢原则：**只合并容器，不动条目** —— 每个数据组仍然原样渲染，只是不再各占一个页签。
 *   · 订阅表并进「概览」（它本来就是一张表，不值得单开一页）
 *   · 服务端/运行参数/启动/启动流程/看门狗/版本 并成「运行」
 *   · 审计与镜像/审批与安全/官方审批 并成「安全」
 *   · 原来的「生命周期」独立页收进「帮助」里的折叠卡
 * 「总览」仍是落地页，不承载数据组，因此不参与 INFO_TAB_OF 映射。
 */
var INFO_LAYERS = [
  { key: 'status', label: '状态', hint: '这一刻的运行状态', tabs: ['总览', '概览', '运行', '安全'] },
  { key: 'history', label: '记录', hint: '发生过的事', tabs: ['事件记录', '引用库事件', '日志审计'] },
  { key: 'help', label: '帮助', hint: '键位与原理说明', tabs: ['键位帮助'] },
]
var INFO_TABS = INFO_LAYERS.reduce((acc, l) => acc.concat(l.tabs), [])
  /** 功能开关文案（服务端 features 键 → 人话）。 */
  var FEATURE_LABELS = {
    panel: '面板', tools: '工具', watch: '订阅', audit: '审计', capture: '输出留痕',
    replay: '回放', vault: '引用库', macros: '宏', workspaces: '工作区', snapshots: '快照',
    watchdog: '孤儿看门狗', guard: '危险命令护栏', consent: '授权确认', redact: '敏感信息脱敏',
  }
  /** 统一提示入口：所有组件把提示投到面板已有的 notify（消息条 + /notice 历史）。 */
  var NOTICE_BUS = null
  var NOTICE_QUEUE = []
  function postNotice (level, brief, detail, shell) {
    try {
      if (typeof NOTICE_BUS === 'function') { NOTICE_BUS(level, brief, detail, shell); return }
      NOTICE_QUEUE.push([level, brief, detail, shell])
      if (NOTICE_QUEUE.length > 20) NOTICE_QUEUE.shift()
    } catch { /* 提示失败不影响主流程 */ }
  }

var INFO_CARD_OF = INFO_TAB_OF
/** 时间档的兜底目录（宿主 GET /consent 会带 catalogs，优先用它，避免两边不一致）。 */
var CONSENT_TTL_FALLBACK = [
  { key: '10m', seconds: 600, label: '10 分钟' },
  { key: '30m', seconds: 1800, label: '30 分钟' },
  { key: '2h', seconds: 7200, label: '2 小时' },
  { key: 'forever', seconds: null, label: '永久' },
  { key: 'custom', seconds: null, label: '自定义' },
]

/** 到期时间的可读描述。永久 = null。 */
function consentRemainingLabel (expiresAt, now) {
  if (expiresAt === null || expiresAt === undefined) return '永久'
  const left = expiresAt - now
  if (left <= 0) return '已过期'
  const minutes = Math.ceil(left / 60000)
  if (minutes < 60) return '剩 ' + String(minutes) + ' 分'
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return '剩 ' + String(hours) + ' 小时'
  return '剩 ' + String(Math.round(hours / 24)) + ' 天'
}

/**
 * 已授权会话列表的行模型（纯函数）。
 *
 * 两个刻意的显示决定：
 *   * 按**最近使用**倒序 —— 用户最常见的困惑是"会话多了找不到当前那个"，
 *     而当前对话几乎总是最近用过的那个，排第一最好找；
 *   * 没有任何条目时给一句明确的空状态，而不是渲染一片空白。
 */
function consentEntryRows (entries, now) {
  const list = Array.isArray(entries) ? entries : []
  return list.map((entry, index) => {
    const title = typeof entry.title === 'string' && entry.title !== '' ? entry.title : ''
    const shortId = String(entry.actor ?? '').slice(0, 8)
    return {
      actor: String(entry.actor ?? ''),
      // 没标题就退化成短 id：不编造名字，但也不能显示空白
      label: title !== '' ? title : '会话 ' + shortId,
      hasTitle: title !== '',
      shortId,
      scope: entry.scope,
      scopeLabel: CONSENT_SCOPE_LABELS[entry.scope] ?? String(entry.scope ?? '?'),
      remaining: consentRemainingLabel(entry.expiresAt, now),
      uses: Number.isFinite(entry.uses) ? entry.uses : 0,
      lastUsedAt: entry.lastUsedAt ?? null,
      // 第一行（最近使用）标注出来：那就是用户最可能想操作的那个
      isRecent: index === 0,
    }
  })
}

/**
 * 「按对话授权」候选列表的**显示模型**（纯函数，0.3.4 收敛）。
 *
 * 输入是宿主 /actors 的全量列表（search 要能覆盖历史会话），输出是面板**默认平铺**
 * 的那部分：最近活跃 + 已授权。用户抱怨「webui 根本不需要显示这么多会话」—— 授权管理
 * 要找的是"最近用过的 / 已经放过权的"，冷门历史会话只在搜索词出现时才在完整列表里现身。
 *
 * 两个刻意的取舍：
 *   * **已授权恒在**：即便它排在 recentLimit 之外（用户很久没碰它），也必须出现在默认
 *     视图里 —— 否则想撤销一条冷门授权时找不到它；
 *   * **搜索时全量**：query 非空不再收敛，按标题 / id / 子代理过滤整列表。
 *
 * @param {Array} actors - /actors 返回的完整列表。
 * @param {object} groups - /actors 返回的分组目录 { recentIds, grantedIds }。
 * @param {string} query - 面板搜索词（trim 后小写比较）。
 * @returns {{ visible: Array, hiddenCount: number, grantedCount: number, totalCount: number }}
 */
function actorListModel (actors, groups, query, options = {}) {
  const list = Array.isArray(actors) ? actors : []
  const q = String(query ?? '').trim().toLowerCase()
  const showAll = options.showAll === true
  const recent = new Set(Array.isArray(groups?.recentIds) ? groups.recentIds : [])
  const granted = new Set(Array.isArray(groups?.grantedIds) ? groups.grantedIds : [])
  if (q !== '') {
    const matched = list.filter((a) => String(a.title ?? a.id ?? '').toLowerCase().includes(q)
      || String(a.id ?? '').toLowerCase().includes(q)
      // 子 agent 不再无条件命中：只在标题/id 真的匹配时出现（否则一搜索就把几十个子 agent 全捞出来）
      || (a.origin === 'subagent' && q.length >= 4 && String(a.title ?? '').toLowerCase().includes(q)))
    return { visible: matched, hiddenCount: Math.max(0, list.length - matched.length), grantedCount: granted.size, totalCount: list.length }
  }
  // 0.4.0（用户反馈"授权页能看到全部的 agent，包括子 agent 和大量已归档"）：
  // 默认**排除子 agent** —— 它们从不单独授权（规则由创建它们的对话继承），
  // 而每个子 agent 首次使用插件都会写一条 consent 记录，于是全部挤进"已授权"，
  // 把这一页彻底淹掉。已授权的子 agent 不丢：它们落进 hiddenCount，搜索时仍能找到、可撤销。
  // （0.4.0 已改为：已归档会话一律不进默认视图，但它们在「更多」里照常出现 —— 撤销冷门授权仍然找得到。）复的初衷）。
  // showAll（"显示更多"）：列出全部（含子 agent 与已归档），并按**谱系**排成树 —— 父先于子、
  // 子按深度缩进，这样"谁是谁的子代理"一眼可见；树里的节点照样能选中、改权限、撤销。
  // 默认视图：排除子代理（从不单独授权）**与已归档会话**（用户反馈"能看到大量已归档"）。
  // 归档会话并不丢：它们在「更多」里照常出现，所以撤销冷门授权仍然找得到。
  const candidates = list.filter((a) => a.origin !== 'subagent' && a.live === true)
  const picked = candidates.filter((a) => granted.has(a.id) || recent.has(a.id))
  // 兜底：宿主给的 recentIds 若被归档会话占满（老版本就是这样），上面会一条都挑不出来 ——
  // 那时退回"按最近活跃排序的活跃会话前 N 个"，保证默认视图不会是空的。
  const visible = showAll
    ? list
    : (picked.length > 0 ? picked : candidates.slice()
      .sort((a, b) => (Number(b.updated ?? b.created ?? 0)) - (Number(a.updated ?? a.created ?? 0)))
      .slice(0, 10))
  const withDepth = showAll ? actorTreeOrder(visible) : visible
  // 已授权的排前面（granted 优先于 recent 里的未授权项：管理意图 > 最近活跃）
  const byGrantedFirst = (a, b) => (Number(granted.has(b.id)) - Number(granted.has(a.id)))
  // 用 id 集合算隐藏数：visible 在树模式下是**新对象**（walk 时 { ...node }），
  // 用 includes 做对象身份比较会全部判定为"未包含"，hiddenCount 恒等于 list.length 之前的 0。
  const visibleIds = new Set(visible.map((a) => a.id))
  const hiddenCount = Math.max(0, list.filter((a) => !visibleIds.has(a.id)).length)
  return {
    visible: showAll ? withDepth : [...visible].sort(byGrantedFirst),
    hiddenCount,
    grantedCount: granted.size,
    totalCount: list.length,
    hint: showAll
      ? '正在显示全部 ' + String(list.length) + ' 个对话（含子代理与已归档，按谱系缩进）'
      : '默认只列相关的 ' + String(visible.length) + ' 个（共 ' + String(list.length) + ' 个，其余藏起来）',
  }
}

/**
 * 日志与留痕的总体统计（0.4.0 用户要求）。
 *
 * 只用**文件清单里已有的字段**（name / bytes），不读文件内容 —— 统计要在打开浮层时瞬时给出，
 * 不能为了算记录数把几十兆留痕读一遍。
 *
 * @param {object|null} data - /audit-files 的响应 `{ auditFiles, outputFiles, chain }`。
 * @returns {{auditText: string, outputText: string, chainText: string}} 三段紧凑文案。
 */
function logStatsModel (data) {
  const d = data !== null && typeof data === 'object' ? data : {}
  const rows = (v) => (Array.isArray(v) ? v : [])
  const audit = rows(d.auditFiles)
  const output = rows(d.outputFiles)
  const totalBytes = (list) => list.reduce((n, f) => n + (Number.isFinite(f?.bytes) ? Number(f.bytes) : 0), 0)
  const dayRange = (list) => {
    const ds = list.map((f) => {
      const m = /(\d{4}-\d{2}-\d{2})/.exec(String(f?.name ?? ''))
      return m === null ? '' : m[1]
    }).filter((v) => v !== '').sort()
    if (ds.length === 0) return ''
    const a = ds[0]
    const b = ds[ds.length - 1]
    return a === b ? a : (a + ' → ' + b)
  }
  const auditRange = dayRange(audit)
  const auditText = audit.length === 0
    ? '暂无文件'
    : (String(audit.length) + ' 个 · ' + fmtBytes(totalBytes(audit)) + (auditRange === '' ? '' : ' · ' + auditRange))
  const outputText = output.length === 0
    ? '暂无文件'
    : (String(output.length) + ' 个 · ' + fmtBytes(totalBytes(output)))
  const chain = d.chain
  const chainText = chain === null || chain === undefined
    ? '未校验'
    : (chain.ok === true ? '链完整' : '链异常')
  return { auditText, outputText, chainText }
}

/**
 * 按谱系把演员列表排成树（父先于子，子带 `__depth` 供缩进）。
 * 父不在列表里的（例如父会话已归档未展开）就当作根，不影响显示。
 * @param {Array} list - 演员行。
 * @returns {Array} 带 `__depth` 的行（父先于子）。
 */
function actorTreeOrder (list) {
  const byId = new Map(list.map((a) => [a.id, a]))
  const childrenOf = new Map()
  const roots = []
  for (const a of list) {
    const p = typeof a.parent === 'string' && a.parent !== '' && byId.has(a.parent) ? a.parent : null
    if (p === null) { roots.push(a); continue }
    if (!childrenOf.has(p)) childrenOf.set(p, [])
    childrenOf.get(p).push(a)
  }
  const out = []
  const walk = (node, depth) => {
    out.push({ ...node, __depth: depth })
    for (const kid of childrenOf.get(node.id) ?? []) walk(kid, depth + 1)
  }
  for (const r of roots) walk(r, 0)
  const hasParentInfo = list.some((a) => typeof a.parent === 'string' && a.parent !== '')
  // 兜底（parent 缺失 —— 例如服务端还没重启加载 parentSession）：
  // 退化为「按 delegationDepth 稳定排序」，浅层在前。否则所有子代理都会变成根节点排到最前，
  // 于是出现"第一行就是子 agent"（用户实测到的现象）。
  const ordered = hasParentInfo
    ? out
    : [...out].sort((a, b) => (Number(a.depth) || 0) - (Number(b.depth) || 0))
  return ordered.map((a) => (a.__depth === 0 && Number.isFinite(a.depth) && a.depth > 0
    ? { ...a, __depth: a.depth }
    : a))
}

/**
 * 0.3.4 通用表格数据模型（纯函数，数据层与渲染分离，可离线断言）。
 *
 * 表格/列表的「排序 + 筛选 + 计数」统一收敛到这里：列定义（columns）描述每列
 * 怎么取值（key / getter / sortable / searchable），一行数据 + 当前查询 + 排序键
 * 进去，出来的是可直接渲染的 visible 行与统计。渲染层（UI.Table）只做搬运，
 * 不参与排序逻辑 —— 多个表格（secrets 表、日志列表、会话列表）共用同一套。
 *
 * 排序语义：默认稳定排序（同值保序）；数字按数值、字符串按 localeCompare、
 * 时间戳按数值（数字）。筛选语义：大小写不敏感的包含匹配，命中任一
 * searchable 列即保留；查询为空不过滤。
 *
 * @param {Array} rows - 数据行数组
 * @param {Array} columns - [{key, get(row)?, sortable?, searchable?, label}]
 * @param {string} query - 筛选词（空 = 不过滤）
 * @param {string} sortKey - 排序列的 key（''=不排序，保持原始顺序）
 * @param {string} sortDir - 'asc' | 'desc'
 * @returns {{visible: Array, totalCount: number, filteredCount: number, sortKey, sortDir}}
 */
var TABLE_STORE_PREFIX = 'terminalkeeper:table:'
function loadTableStore (kind) {
  try {
    if (typeof localStorage === 'undefined') return {}
    const raw = localStorage.getItem(TABLE_STORE_PREFIX + kind)
    const v = raw === null ? null : JSON.parse(raw)
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch { return {} }
}
function saveTableStore (kind, value) {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(TABLE_STORE_PREFIX + kind, JSON.stringify(value))
  } catch { /* 无存储权限时静默（列宽只是体验优化） */ }
}

function tableModel(rows, columns, query, sortKey, sortDir, filterValues) {
  const list = Array.isArray(rows) ? rows : []
  const cols = Array.isArray(columns) ? columns : []
  /** 取一行的列值：优先 getter，否则读 key 字段；文本化给筛选用。 */
  const cellOf = (row, col) => {
    if (typeof col?.get === 'function') return col.get(row)
    const v = row === null || row === undefined ? undefined : row[col?.key]
    return v
  }
  let out = list
  // 列筛选（筛选行左侧的「键」）：每列一个精确值，空值/未设 = 不过滤
  const fv = filterValues !== null && typeof filterValues === 'object' ? filterValues : null
  if (fv !== null) {
    out = out.filter((row) => cols.every((col) => {
      const want = col?.key === undefined ? undefined : fv[col.key]
      if (want === undefined || want === null || want === '') return true
      if (typeof col?.filterMatch === 'function') return col.filterMatch(row, want) === true
      return String(cellOf(row, col) ?? '') === String(want)
    }))
  }
  const q = String(query ?? '').trim().toLowerCase()
  if (q !== '') {
    const searchCols = cols.filter((c) => c?.searchable !== false && c?.key !== undefined)
    out = list.filter((row) => searchCols.some((col) => {
      const v = cellOf(row, col)
      return String(v ?? '').toLowerCase().includes(q)
    }))
  }
  const filteredCount = out.length
  const sk = cols.some((c) => c?.key === sortKey && c?.sortable !== false) ? sortKey : ''
  const dir = sortDir === 'desc' ? -1 : 1
  if (sk !== '') {
    const col = cols.find((c) => c?.key === sk)
    out = [...out].sort((aa, bb) => {
      const a = cellOf(aa, col)
      const b = cellOf(bb, col)
      if (typeof a === 'number' && typeof b === 'number') return dir * (a - b)
      if (a === null || a === undefined) return 1
      if (b === null || b === undefined) return -1
      return dir * String(a).localeCompare(String(b), undefined, { numeric: true })
    })
  }
  return { visible: out, totalCount: list.length, filteredCount, sortKey: sk, sortDir: sk === '' ? '' : sortDir }
}

/**
 * 0.3.4 日志管理：文件列表的**排序 + 搜索**模型（纯函数）。
 *
 * 输入是 /audit-files 的文件数组（{name, bytes, mtimeMs}），输出按当前排序键排好、
 * 搜索词过滤后的可见列表。排序键：name（名字）/ size（大小）/ time（修改时间）；
 * dir = asc | desc。文件多了找不到时靠它：输入半个文件名就能筛出来。
 *
 * @param {Array} files - {name, bytes, mtimeMs} 数组
 * @param {string} query - 搜索词（对文件名做大小写不敏感包含匹配）
 * @param {string} key - 排序键 name|size|time
 * @param {string} dir - asc|desc
 * @returns {{visible: Array, totalCount: number, hiddenCount: number}}
 */
function logFileModel (files, query, key, dir) {
  const list = Array.isArray(files) ? files.filter((f) => f !== null && typeof f === 'object') : []
  const q = String(query ?? '').trim().toLowerCase()
  const filtered = q === ''
    ? list
    : list.filter((f) => String(f.name ?? '').toLowerCase().includes(q))
  const sortKey = key === 'size' ? 'bytes' : (key === 'time' ? 'mtimeMs' : 'name')
  const sign = dir === 'desc' ? -1 : 1
  const visible = [...filtered].sort((aa, bb) => {
    const a = aa[sortKey] ?? 0
    const b = bb[sortKey] ?? 0
    if (typeof a === 'string' && typeof b === 'string') return sign * a.localeCompare(b)
    return sign * (Number(a) - Number(b))
  })
  return { visible, totalCount: list.length, hiddenCount: Math.max(0, list.length - filtered.length) }
}

/** 授权按钮的悬浮提示：一句话说清当前档位与全局默认。 */
function consentSummaryText (wildcard) {
  if (wildcard === null || wildcard === undefined) return '当前没有全局授权：每个对话各自确认'
  const scope = CONSENT_SCOPE_LABELS[wildcard.scope] ?? String(wildcard.scope)
  return '全局默认：' + scope + ' · ' + consentRemainingLabel(wildcard.expiresAt, Date.now())
}

/** 时间档 → 秒数。自定义档用输入框的分钟数（越界交给宿主拒绝并回报，不在这里偷偷夹取）。 */
function consentTtlSeconds (key, customMinutes) {
  if (key === 'forever') return null
  if (key === 'custom') {
    const minutes = Number(customMinutes)
    if (!Number.isFinite(minutes) || minutes <= 0) return null
    return Math.floor(minutes * 60)
  }
  const hit = CONSENT_TTL_FALLBACK.find((level) => level.key === key)
  return hit === undefined ? null : hit.seconds
}

function closeActionFor(armed) {
  return armed === true ? 'close' : 'arm'
}

/** 关闭按钮在两种状态下的外观（纯函数，便于离线断言文案与配色令牌）。 */
function closeButtonModel(armed) {
  return armed === true
    ? { className: 'dshsh-btn danger armed', icon: 'x', size: 15, label: '确认关闭',
        title: '再点一次即关闭（会连同其中运行的进程一起结束）' }
    : { className: 'dshsh-btn danger', icon: 'x', size: 14, label: '关闭',
        title: '关闭当前 shell（需再点一次确认；会连同其中运行的进程一起结束）' }
}

/**
 * 画「真实光标」前必须解决的一件事：tmux 给的是**单元格列**，不是字符下标。
 *
 * 中文/日文/emoji 占 2 格、组合符占 0 格 —— 直接拿 `cursor_x` 当字符下标去切字符串，
 * 中文行里光标必然偏。所以这里先把单元格坐标映射成字符下标（纯函数、可离线断言）。
 */

/**
 * 行高必须**量**出来，不能从 `scrollHeight` 推。
 *
 * 踩过的坑：`scrollHeight` 取的是「内容高度」与「可视高度」中的**较大者** —— 文本少时
 * （内容比视口矮）它等于视口高度，拿它除行数会得到一个大得离谱的"行高"，光标就被画到下面去了；
 * 文本多时内容高于视口才是真值，所以"文本多了反而正常"。行高只能来自计算样式。
 *
 * @param {{lineHeight?: string, fontSize?: string}} computed - `getComputedStyle(el)` 的取值
 * @returns {number} 像素行高；解析不出来返回 0（调用方据此**不画**）
 */
function resolveLineHeight(computed) {
  const raw = computed === null || computed === undefined ? undefined : computed.lineHeight
  const parsed = Number.parseFloat(String(raw ?? ''))
  if (Number.isFinite(parsed) && parsed > 0) return parsed
  // `line-height: normal` 时浏览器不给数值：按字号的常规比例（1.2）估一个
  const fontSize = Number.parseFloat(String(computed?.fontSize ?? ''))
  if (Number.isFinite(fontSize) && fontSize > 0) return fontSize * 1.2
  return 0
}

/** 一个字符占几个终端单元格。 */
function charCellWidth(ch) {
  const code = ch.codePointAt(0)
  if (code === undefined) return 0
  // 组合符（含变体选择符、零宽连接符）不占格
  if ((code >= 0x0300 && code <= 0x036f) || (code >= 0xfe00 && code <= 0xfe0f) ||
      (code >= 0x1ab0 && code <= 0x1aff) || code === 0x200d || code === 0x200b) return 0
  // 东亚宽/全角、假名、谚文、CJK 符号与汉字、常见 emoji 区间
  if ((code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0x303e) ||
      (code >= 0x3041 && code <= 0x33ff) || (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) || (code >= 0xa000 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1f64f) || (code >= 0x1f900 && code <= 0x1f9ff) ||
      (code >= 0x20000 && code <= 0x3fffd)) return 2
  return 1
}

/** 整行文本占几个终端单元格（不含行尾被剥掉的空格）。 */
function charCellsOf(line) {
  let cells = 0
  for (const ch of String(line ?? '')) cells += charCellWidth(ch)
  return cells
}

/** 含 `cell` 这一格的那个字符的下标；超出整行宽度则返回行尾（光标停在行尾空白处的情形）。 */
function cellsToCharIndex(line, cell) {
  const text = String(line ?? '')
  if (cell <= 0) return 0
  let cells = 0
  let index = 0
  for (const ch of text) {
    const width = charCellWidth(ch)
    if (cell < cells + width) return index
    cells += width
    index += ch.length   // 代理对占两个 code unit
  }
  return text.length
}

/**
 * 光标所在行被 tmux 剥掉的行尾空格数。
 *
 * 实测：`capture-pane -e` 会把每行**行尾空格剥掉**（`printf "abc   "` → 屏上 `abc\n`），
 * 但 tmux 的 `cursor_x` 仍按**满宽 pane**（含空格）给 → 光标停在空格列上时，文本里
 * 根本没有对应字符，`cellsToCharIndex` 直接落到行尾 —— 视觉光标贴到最后一个字符上
 * （用户实报：「空白字符显示到前一个字符」）。这里把“被剥掉多少格”算出来，
 * caret 的横向位置 = 行文本宽度 + 空格数 × 单元格宽，让光标落在真实的空格列上。
 *
 * @param {string} line 当前行文本（无行尾空格）
 * @param {number} paneColumns pane 总列数（meta.cols）
 * @returns {number} 行尾被剥掉的空格格数（≥0）
 */
function trailingCellGap(line, paneColumns) {
  const text = String(line ?? '')
  if (!Number.isFinite(paneColumns) || paneColumns <= 0) return 0
  let lineCells = 0
  for (const ch of text) lineCells += charCellWidth(ch)
  const gap = Math.floor(paneColumns) - lineCells
  return Number.isFinite(gap) ? Math.max(0, gap) : 0
}

/**
 * 把 tmux 的光标坐标换算成「在我们渲染的这份文本里」的位置。
 *
 * 关键点：`cursor_y` 是相对**可见窗格**的，而我们的文本是「历史 + 可见窗格」，且可见窗格
 * 永远贴底 —— 所以行下标 = 总行数 − paneHeight + cursor_y。算不出来就返回 null（**不画**），
 * 宁可没有光标，也不要画在错误的位置。
 */
function caretPlacement(input) {
  const screen = typeof input?.screen === 'string' ? input.screen : ''
  const meta = input?.meta ?? null
  if (screen === '' || meta === null) return null
  const paneHeight = Number.isFinite(meta.paneHeight) ? meta.paneHeight : 0
  const cursorY = Number.isFinite(meta.cursorY) ? meta.cursorY : 0
  const cursorX = Number.isFinite(meta.cursorX) ? meta.cursorX : 0
  if (paneHeight <= 0) return null
  const lines = screen.split('\n')
  const lineIndex = lines.length - paneHeight + cursorY
  if (lineIndex < 0 || lineIndex >= lines.length) return null
  const line = lines[lineIndex]
  if (line === undefined) return null
  const charIndex = cellsToCharIndex(line, cursorX)
  // 0.3.4 行尾空格修正：tmux 剥掉行尾空格但 cursor_x 按满宽 pane 给。光标停在
  // 被剥掉的空格区时，charIndex 只能落在文本末尾；把“文本实际占多少格 + 剥了多少格”
  // 一起带回，caret 在文本宽度之外再补空格宽度 —— 视觉位置回到真实的空格列上。
  const textCells = charCellsOf(line)
  const gapCells = trailingCellGap(line, Number.isFinite(meta.cols) ? meta.cols : 0)
  // 绝对下标：插入点要直接**切在文本里**（见 caretSplit），所以要的是整段文本里的位置，
  // 不只是行内位置。行长度用行自身算，换行符各占 1。
  let offset = 0
  for (let i = 0; i < lineIndex; i += 1) offset += lines[i].length + 1
  offset += charIndex
  return { lineIndex, cell: cursorX, charIndex, offset, textCells, gapCells }
}

/**
 * 实测前缀宽度时，Range 应该覆盖哪一段。**纯函数**（便于离线断言）。
 *
 * 关键：只覆盖**光标所在的那一行**（行首 → 光标），而不是"屏幕开头 → 光标"。
 *
 * 踩过的坑（用户报的"光标被渲染到了本行的最后"就是这个）：多行区间的
 * `getBoundingClientRect()` 返回的是**并集包围盒** —— 从屏幕第一行一直拉到光标处时，
 * 那个 `width` 约等于最宽的一行（通常就是整屏宽），于是插入点被推到行尾。
 * 单行区间的包围盒才等于该行前缀的真实宽度；光标在行首时区间折叠、宽度天然是 0，
 * 也没有 `getClientRects()` 在行首处"最后一片其实属于上一行"的歧义。
 *
 * @param {{offset?: number, charIndex?: number}|null} placement - {@link caretPlacement} 的结果
 * @returns {{from: number, to: number}|null} 数据不自洽时返回 null（调用方退回估算或不画）
 */
function prefixRangeOffsets(placement) {
  if (placement === null || placement === undefined) return null
  const to = Number(placement.offset)
  const charIndex = Number(placement.charIndex)
  if (!Number.isFinite(to) || !Number.isFinite(charIndex)) return null
  // offset 是"整段文本里的绝对下标"，charIndex 是"行内下标"，两者相减就是本行行首
  const from = to - charIndex
  if (from < 0 || from > to) return null
  return { from, to }
}

/**
 * 实测「某一行上、光标前那段文本」的渲染宽度。
 *
 * 这是横向定位的正解：用 `Range` 量真实排版结果 —— 中文由回退字体渲染时 advance 与
 * 等宽 ASCII 不同，任何"单元格 × 字符宽度"的算法都会偏；而 `Range` 直接给出浏览器的答案。
 *
 * 关键：**不改动 DOM 结构**（早先用"把插入点插进文本流"的办法，空白字符处会出问题）——
 * 这里只是在**已有文本节点**上取一个区间，量完即弃。区间由 {@link prefixRangeOffsets} 给出，
 * 必须限定在光标所在的那一行（原因见那里）。
 *
 * @param {*} scope - 含 `.dshsh-screen-text` 的容器元素
 * @param {number} from - 行首在整段文本里的下标
 * @param {number} to - 光标在整段文本里的下标
 * @returns {number} 像素宽度；量不出来返回 NaN（调用方退回单元格估算，再不行就不画）
 */
function measurePrefixWidth(scope, from, to) {
  try {
    if (scope === null || scope === undefined || typeof scope.querySelector !== 'function') return Number.NaN
    const node = scope.querySelector('.dshsh-screen-text')
    if (node === null || node === undefined) return Number.NaN
    if (typeof window === 'undefined' || typeof window.document === 'undefined' ||
        typeof window.document.createRange !== 'function') return Number.NaN
    // 0.3.4：`.dshsh-screen-text` 里现在是**多个文本节点**（SGR 样式段拆成 span 树），
    // 早先只取 firstChild 的做法在无颜色时刚巧能用、有颜色时量到的是最前面一段。
    // 这里遍历全部后代文本节点、按文档序累计长度，把 [from,to]（plain 文本下标）
    // 映射到「节点 + 节点内偏移」。区间跨段（光标落在不同颜色段交界处）时取并集包围盒。
    // 不用 NodeFilter（jsdom/旧浏览器可能没有）：递归自己找文本节点。
    const textNodes = []
    const collect = (el) => {
      if (el.nodeType === 3) { textNodes.push(el); return }
      if (el.childNodes !== undefined) {
        for (const child of el.childNodes) { if (child !== null && child !== undefined) collect(child) }
      }
    }
    collect(node)
    const spans = []
    let total = 0
    for (const tn of textNodes) {
      const len = tn.textContent === null ? 0 : tn.textContent.length
      spans.push({ node: tn, start: total, end: total + len })
      total += len
    }
    if (spans.length === 0) return Number.NaN
    const start = Math.max(0, Math.min(total, Number(from)))
    const end = Math.max(start, Math.min(total, Number(to)))
    const range = window.document.createRange()
    const locate = (pos) => {
      let lo = 0; let hi = spans.length - 1
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (spans[mid].end < pos) lo = mid + 1
        else hi = mid
      }
      const seg = spans[lo]
      return { node: seg.node, offset: Math.max(0, pos - seg.start) }
    }
    const a = locate(start)
    const b = locate(end)
    range.setStart(a.node, a.offset)
    range.setEnd(b.node, b.offset)
    const rect = range.getBoundingClientRect()
    return Number.isFinite(rect?.width) ? rect.width : Number.NaN
  } catch {
    return Number.NaN
  }
}

/**
 * 光标在内容坐标里的位置。
 *
 * 横向优先用**实测**的前缀宽度（`measuredLeft`，见 measurePrefixWidth），量不到才退回
 * 「单元格列 × 实测 ASCII 字符宽」的估算；两者都没有就返回 null（**不画**，不画偏的）。
 * 纵向用实测行高 —— 它绝不能从 `scrollHeight` 推（内容比视口矮时那个值是视口高度）。
 */
function caretStyle(placement, lineHeight, cellWidth, padX, padY, measuredLeft) {
  if (placement === null || !Number.isFinite(lineHeight) || lineHeight <= 0) return null
  let left = Number.NaN
  if (Number.isFinite(measuredLeft)) left = padX + measuredLeft
  else if (Number.isFinite(cellWidth) && cellWidth > 0) left = padX + placement.cell * cellWidth
  if (!Number.isFinite(left)) return null
  return {
    position: 'absolute',
    top: padY + placement.lineIndex * lineHeight,
    left,
    width: 2,
    height: lineHeight,
    background: 'currentColor',
    opacity: .8,
    pointerEvents: 'none',
    borderRadius: 1,
  }
}

/**
 * 该不该画光标。
 *
 * 只在**用户手动输入**（解锁）时画：锁定状态代表按键不会进终端，屏幕上那个位置并不代表
 * "下一个字符会出现在这"；AI 通过工具发输入时同理不该画。程序自己隐藏了光标（TUI）也不画。
 */
function shouldShowCaret(input) {
  // 0.3.4：锁定/解锁都画（真实终端的光标常显；锁定时人正在读那块屏，指示器应该还在）。
  // 唯一不画的：程序自己隐藏了光标（TUI 全屏模式 cursorVisible=false）、坐标换算失败、
  // 或 tmux 指示光标不可见。注释里早先的「只在解锁画」是"输入会进终端"的语义，
  // 但用户要的是"完全复刻真实 shell"——真终端没有"锁定就不画光标"这回事。
  if (input?.meta === null || input?.meta === undefined) return false
  if (input.meta.cursorVisible !== true) return false
  return input?.placement !== null && input?.placement !== undefined
}

// tmux/driver 的时间字段有的是秒（createdAt），有的是毫秒（activityAt）；统一归一化，避免 1970。
function timeMs (v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return null
  return n < 1e12 ? n * 1000 : n
}

function buildInfoRows(input) {
  const server = input.server !== null && typeof input.server === 'object' ? input.server : {};
  const meta = input.meta !== null && typeof input.meta === 'object' ? input.meta : null;
  const sessions = Array.isArray(input.sessions) ? input.sessions : []
  const subscriptions = Array.isArray(input.subscriptions) ? input.subscriptions : [];
  const approval = server.approval !== null && typeof server.approval === 'object' ? server.approval : null;
  const bytes = (n) => (typeof n === 'number' && n >= 0 ? fmtBytes(n) : '-');
  const text = (v, fallback) => (v === undefined || v === null || v === '' ? (fallback === undefined ? '-' : fallback) : String(v));

  // 环境能力与降级（host envNotes = describeEnv 的人话承诺；旧宿主没这个字段显示 —）
  const envNotesValue = (server) => {
    const notes = Array.isArray(server.envNotes) && server.envNotes.length > 0 ? server.envNotes : null
    if (notes === null) return '—'
    return notes.join(' · ')
  }
  const envNotesTitle = (server) => Array.isArray(server.envNotes) && server.envNotes.length > 0
    ? server.envNotes.join('\n')
    : 'DSH 还没上报（插件版本旧；重启 dsh web 后再看）'
  const envNotesNeedsWarn = (notes) => Array.isArray(notes) && notes.some((n) => /降级|压制|不存活|不准|关闭/.test(String(n)))

  // 注意：meta 可能是 `null`，也可能是「存在但字段不全」的对象（旧宿主/请求失败）。
  // 因此每个字段都单独判有无 —— 只判断 `meta === null` 会渲染出 `undefined × undefined`。
  const num = (v) => (Number.isFinite(v) ? String(v) : '')
  const pair = (a, b, suffix) => {
    const left = num(a)
    const right = num(b)
    if (left === '' && right === '') return '-'
    return (left === '' ? '?' : left) + ' / ' + (right === '' ? '?' : right) + (suffix === undefined ? '' : suffix)
  }

  const current = sessions.find((x) => x !== null && typeof x === 'object'
    && meta !== null && meta !== undefined && x.name === meta.name) ?? null
  const session = [
    { k: '名称', v: text(meta && meta.name, '(无 shell)') },
    { k: 'PID', v: current !== null && Number.isFinite(current.pid) ? String(current.pid)
        : (meta !== null && Number.isFinite(meta.pid) ? String(meta.pid) : '无法检测（DSH 还没上报）') },
    { k: '尺寸', v: meta && Number.isFinite(meta.cols) && Number.isFinite(meta.rows) ? String(meta.cols) + ' × ' + String(meta.rows) : '-' },
    { k: '前台进程', v: text(meta && meta.foreground, '(空闲)') },
    { k: '有人接入', v: meta && typeof meta.attached === 'boolean' ? (meta.attached ? '是（有外部终端在看）' : '否') : '-' },
    { k: '创建时间', v: timeMs(meta?.createdAt) !== null
        ? new Date(timeMs(meta.createdAt)).toLocaleString('zh-CN') : '无法检测（DSH 没给创建时间）' },
    { k: '最后活动', v: timeMs(meta?.activityAt) !== null
        ? new Date(timeMs(meta.activityAt)).toLocaleString('zh-CN')
        : (current !== null && timeMs(current.activityAt) !== null
          ? new Date(timeMs(current.activityAt)).toLocaleString('zh-CN') : '无法检测（DSH 没给最近活动时间）') },
    { k: '帧录制', v: current !== null && current.recording === true
        ? '录制中' : (current !== null && typeof current.framesFile === 'string' && current.framesFile !== '' ? '有帧文件（未在录）' : '无') },
    { k: '锁定备注', v: current !== null && (current.lockNote !== undefined || current.lockKind !== undefined)
        ? (String(current.lockNote ?? '') || String(current.lockKind ?? '') || '无')
        : '无' },
    { k: '输入', v: input.locked === true ? '已锁定' : '已解锁（按键直接进终端）', tone: input.locked === true ? 'dim' : 'ok' },
  ]

  const buffer = [
    { k: '已用行数', v: pair(meta && meta.historySize, meta && meta.historyLimit, ' 行') },
    { k: '已用字节', v: bytes(meta && meta.historyBytes) },
    { k: '取景窗口', v: String(input.historyWindow === undefined ? 200 : input.historyWindow) + ' 行（上限 ' + String(input.maxWindow === undefined ? 5000 : input.maxWindow) + '）' },
  ]

  const serverRows = [
    { k: '本地通道', v: '-L ' + text(server.socket, '?'), title: '本插件私有的 tmux 服务端（socket）：与你自己开的 tmux 隔离，互不影响' },
    { k: '会话数', v: String(sessions.length) + ' / ' + text(server.maxSessions, '?') },
    // 这是**回退**值：由工具新建的会话默认落在当前对话的工作目录，只有拿不到对话时（面板建的）
    // 才用它。不写清的话用户会以为新 shell 都在这里。
    { k: '起始目录', v: prettyPath(text(server.defaultCwd)) + '（只在没有对话信息时使用）',
      title: 'AI 通过工具新建的 shell 默认在当前对话的工作目录；这一项只在没有对话信息时（例如你在面板里点＋新建）生效。' },
    { k: '默认 shell', v: text(server.shell) },
    { k: 'TERM', v: text(server.defaultTerminal) },
    { k: '滚动缓冲上限', v: text(server.historyLimit) + ' 行' },
    // 设置页是否真的能用：三态如实分开（已接入 / 未注册并给出原因 / 旧宿主未上报）。
    // 「服务挂载了但注册失败」绝不能显示成「已接入」—— 那样用户会去设置页找不到卡片。
    { k: '参数设置', v: settingsRowValue(server), title: settingsRowTitle(server),
      tone: server.settings !== undefined && server.settings.registered === false ? 'warn' : 'dim' },
    // tmux 是系统依赖，装没装决定了整个插件能用不能用 —— 缺了要在这里直接说清怎么装
    { k: 'tmux', v: tmuxRowValue(server), tone: tmuxRowValue(server).startsWith('⚠') ? 'warn' : 'dim' },
    { k: '控制模式', v: (() => {
        // 只读宿主收口的 caps；翻成人话（代码留在这里，便于排查时对照）
        const launch = String(server.caps?.serverLaunch ?? server.plan?.serverLaunch ?? '')
        if (launch === 'systemd-scope') return '系统级独立进程（重启 dsh 后终端还在）'
        if (launch === 'plain-detach') return '普通后台进程（重启 dsh 后终端会结束）'
        return launch === '' ? '无法检测（DSH 没给启动方式）' : launch
      })(),
      title: '来自一次环境探测：有没有 systemd 用户作用域。代码值 systemd-scope / plain-detach。' },
    { k: '面板轮询', v: Number.isFinite(server.ui?.pollMs) ? String(server.ui.pollMs) + ' ms' : '无法检测（DSH 还没上报）' },
    { k: '闸门拒绝', v: Array.isArray(server.fenceBlocked) && server.fenceBlocked.length > 0
        ? String(server.fenceBlocked.length) + ' 条（详见「审计与安全」）' : '无记录' },
    // 浏览器面闸门：这组路由**没有鉴权**，用户有权知道现在是谁在把关、有没有降级。
    { k: '浏览器面闸门', v: fenceRowValue(server), title: fenceRowTitle(server),
      tone: fenceRowValue(server).startsWith('⚠') ? 'warn' : 'dim' },
    // 这三个字段是 0.1.2 才加进 /list 的：旧宿主不会上报。
    // 缺了就如实写「未知」—— 不能把「没上报」显示成「关」，那是编造状态。
    // extended-keys 行显示**实际生效**状态：配置开了但被版本压制（<3.2）时如实说，
    // 别让用户以为"我开了怎么没反应"（压制状态由宿主探测后写进 server.tmux.extKeys）。
    { k: 'extended-keys', v: (() => {
        // 口径统一（2026-10-24）：**以宿主算好的最终状态为准**（server.tmux.extKeys），
        // 客户端只负责翻译，不再自己拿「配置项 + 版本」二次推断 —— 那份推断正是和
        // 「能力与受限项」的说法打架的来源。
        //   宿主可能给三个值：'on' / 'off (config)' / 'suppressed (tmux X < 3.2)'
        const eff = String(server.tmux?.extKeys ?? '')
        if (eff === 'on') return '开（tmux ≥ 3.2，Shift+Enter 等可用）'
        if (eff === 'off (config)') return '关（配置里没开；需要时在设置里打开）'
        if (eff.startsWith('suppressed')) return '关（配置开了，但 tmux 版本低于 3.2，已自动压制）'
        if (server.extendedKeys === false) return '关（配置里没开；需要时在设置里打开）'
        return '未知（DSH 还没上报这个信息；重启 dsh web 后再看）'
      })(),
      title: '最终状态由 DSH 判定：配置项 extendedKeys + tmux 版本（≥ 3.2）。下面「能力与受限项」说的是环境支不支持，两者是不同的问题。' },
    // 环境能力与降级（0.2.2）：每台机器能力不同，降级必须说人话（describeEnv 的承诺句）
    { k: '能力与受限项', v: envNotesValue(server), title: envNotesTitle(server),
      tone: envNotesNeedsWarn(server.envNotes) ? 'warn' : 'dim' },
  ]

  // 安全与审计：审计/留痕/护栏/链完整性/加锁状态 —— 这些是「可信」相关的行，集中在一组
  // （从服务端组搬来，详情页按卡片展示时整组进「安全」卡，不必在系统卡里找）。
  const securityRows = [
    // 审计链/锁定/留痕统一归「审计与镜像」组，本组只留安全边界，避免同页重复。
    { k: '危险命令护栏', v: server.guardDangerousCommands === false ? '已关闭'
        : server.guardDangerousCommands === true ? '开（启发式减速带，不是沙箱）' : '未知（DSH 还没上报）',
      tone: server.guardDangerousCommands === false ? 'warn' : 'dim' },
  ]

  const watchdog = [
    { k: '自动清理进程', title: '自动清理进程（看门狗 / watchdog）：DSH 意外退出时由它收尾', v: server.watchdogEnabled === false ? '未启用'
        : text(server.watchdogPid, '') !== '' ? 'pid ' + String(server.watchdogPid)
        : '未布防（下一次操作会自动重布防）',
      tone: text(server.watchdogPid, '') === '' ? 'warn' : 'ok' },
    { k: '被监视', v: text(server.watchedPid, '(未知)') + '（DSH 主进程）' },
    { k: '接管方式', v: server.adoptedWatchdog === true ? '复用了已经在跑的清理进程' : '这次重新部署' },
    { k: '启动时保住', v: Array.isArray(server.keptAtBoot) && server.keptAtBoot.length > 0
      ? server.keptAtBoot.join(', ') + (Number(server.keptPhantoms) > 0 ? `（另有 ${Number(server.keptPhantoms)} 个 tmux 内部幻影会话，不占界面，启动时已回收）` : '')
      : (Number(server.keptPhantoms) > 0 ? `无真壳（回收了 ${Number(server.keptPhantoms)} 个 tmux 内部幻影会话）` : '无（启动时没有会话）') },
  ]

  const approvalRows = [
    { k: '官方审批', v: '未接入 —— 模型的命令不会弹任何询问', tone: 'warn', title: approval ? String(approval.warning || '') : '' },
    { k: '审批缝', v: approval ? text(approval.seam) : '-' },
    { k: '会话策略', v: approval ? text(approval.policy) + '（来源：' + text(approval.policySource) + '）' : '-', tone: 'warn' },
    { k: '部署默认', v: approval ? text(approval.deploymentPolicy) + '（DSH_PERMISSION_MODE=' + text(approval.permissionMode) + '）' : '-' },
  ]

  // 0.3.3：运行参数卡 —— /list 的 server.params 直读（宿主侧给的是**解析后的生效值**，
  // 与 shell_state verbose 的 ◈ JSON 同源不同形：这里是人话，那里是给 AI 的紧凑串）。
  const yn = (v) => (v === true ? '✓' : v === false ? '✗' : text(v))
  const p = server.params !== null && typeof server.params === 'object' ? server.params : null
  const paramRows = p === null
    ? [{ k: '运行参数', v: 'DSH 没提供（插件版本旧）', tone: 'dim' }]
    : [
      { k: 'shell', v: text(p.shell) + (Array.isArray(p.shellArgs) && p.shellArgs.length > 0 ? ' ' + p.shellArgs.join(' ') : '') },
      { k: '新建尺寸', v: text(p.cols) + '×' + text(p.rows) },
      { k: '闲置回收', v: text(p.idle) },
      { k: '高危护栏', v: yn(p.guard) },
      { k: '输出脱敏', v: yn(p.redact) },
      { k: '首次授权门', v: yn(p.requireConsent) },
      { k: '死态定格', v: text(p.deadCapture), title: 'remain-on-exit：shell 退出后屏面保留 2 分钟供回看（pending=等服务端重建生效）' },
      { k: '响铃旗标', v: yn(p.monitorBell) },
      { k: '帧回放', v: yn(p.replay) },
      { k: '启动延迟', v: text(p.startupDeferMs) + ' ms' },
      ...(Array.isArray(p.sessionEnv) && p.sessionEnv.length > 0 ? [{ k: '会话环境变量', v: p.sessionEnv.join(' ') }] : []),
    ]

  // 0.3.3：启动状态段（数据来自 /list.server.startup）+ 流程图
  const su = server.startup !== null && typeof server.startup === 'object' ? server.startup : null
  const startupRows = su === null
    ? [{ k: '启动状态', v: 'DSH 没提供（插件版本旧）', tone: 'dim' }]
    : [
      {
        k: '当前阶段',
        v: su.phase === 'ready' ? '✓ 就绪'
          : su.phase === 'running' ? '启动链执行中（探测/配置/清点）'
            : '等待延迟门（' + String(text(su.deferMs)) + 'ms 后自动继续；任何一次使用都会立刻唤醒它）',
      },
      ...(typeof su.note === 'string' && su.note !== '' ? [{ k: '注意', v: su.note, tone: 'warn' }] : []),
      { k: '幻影回收', v: Number(su.reaped) > 0 ? '本次开机清掉 ' + String(Number(su.reaped)) + ' 个 control 重连残留的内部会话' : '无' },
    ]

  const version = [
    { k: '插件版本', v: text(input.pkgVersion, '?') },
    { k: '客户端构建', v: text(input.build, '?') },
    { k: 'DSH 构建号', v: typeof server.hostBuild === 'string' && server.hostBuild !== ''
        ? server.hostBuild + (server.hostBuild === input.build ? ' ✓ 一致' : ' ⚠ 需重启 dsh web')
        : '无法检测（DSH 还没上报）' },
    { k: '来源', v: '本插件由 AI 开发，未经人工安全审计', tone: 'dim' },
  ]

  const keys = [
    { k: '可打印字符（含中文）', v: '交给输入法 → 由 input 事件整段送进终端；组字中不抢任何键' },
    { k: 'Enter', v: '回车' },
    { k: 'Tab / Shift+Tab', v: '补全 / 反向补全' },
    { k: '↑ ↓', v: '历史上一句 / 下一句' },
    { k: '← →', v: '行内左移 / 右移一字符（Ctrl+F 归面板搜索时用这个）' },
    { k: 'Home / End', v: '行首 / 行尾' },
    { k: 'Backspace / Delete', v: '退格 / 删除' },
    { k: 'PageUp / PageDown', v: '翻页' },
    { k: 'Alt+B / Alt+F', v: '按词左移 / 右移（readline）' },
    { k: 'Ctrl-A / Ctrl-E', v: '行首 / 行尾' },
    { k: 'Ctrl-B / Ctrl-F', v: '左移 / 右移一字符' },
    { k: 'Ctrl-K / Ctrl-U', v: '删到行尾 / 删到行首' },
    { k: 'Ctrl-W', v: '删前一个词 —— 必须接管，否则浏览器拿它关标签页' },
    { k: 'Ctrl-R', v: '反向搜索历史（bash / PSReadLine 同款）' },
    { k: 'Ctrl-P / Ctrl-N', v: '历史上一条 / 下一条 —— N 必须接管，否则浏览器开新窗口' },
    { k: 'Ctrl-T', v: '交换光标前后两字符 —— 必须接管，否则浏览器开新标签页' },
    { k: 'Ctrl-H / Ctrl-I / Ctrl-M', v: '退格 / Tab / 回车（readline 别名）' },
    { k: 'Ctrl-L', v: '清屏' },
    { k: 'Ctrl-C / Ctrl-D / Ctrl-Z', v: '中断 / EOF / 挂起' },
    { k: 'Ctrl-Y', v: '粘贴（readline yank）' },
    { k: 'Ctrl-V / Ctrl-X', v: '放行给浏览器：粘贴 / 剪切' },
    { k: 'Ctrl+C（有选中文本）', v: '让浏览器复制，不会误发 SIGINT' },
    { k: 'Esc', v: '送终端（退出选单 / vim）；面板有浮层时先关浮层' },
    { k: 'F7', v: 'PowerShell 的历史列表（我们不抢）' },
  ]
  // 0.4.0 面板快捷键：**只留高频动作**（用户拍板）——新建/关闭/详情/授权/引用库/日志/锁定
  // 都是低频操作，点击更快，不做快捷键；面板开合是唯一需要"焦点不在面板也能用"的动作。
  const panelKeys = [
    { k: shellPanelShortcutLive ? shellPanelShortcutKeys() : '（现在不生效）',
      v: shellPanelShortcutLive
        ? '开合面板 —— 已经在 DSH 的快捷键设置里登记，可以自己改：设置 → 通用 → 快捷键'
        : '开合面板 —— 已经登记，但 DSH 现在没有启用这个组合（可能被别的功能占了，或设置还没加载完）；'
          + '去「设置 → 通用 → 快捷键」里找到「开合 shell 面板」，可以改成别的键' },
    { k: 'Ctrl+Shift+↑ / ↓', v: '上一个 / 下一个终端（鼠标焦点在面板里时才生效）' },
    { k: 'F2', v: '给当前终端改名（tmux 里这个键是逗号）' },
    { k: 'Ctrl+F', v: '在面板里搜索（接管了浏览器自带的查找；终端里想“右移一个字符”请改用 → 键）' },
    { k: 'Esc', v: '关掉当前浮层；没有浮层时按键照常送给终端（vim 和菜单要用）' },
  ]
  // DSH 宿主自己的键位：我们一个都不抢，列在这里是为了说明"为什么不冲突"
  const hostKeys = [
    { k: 'Ctrl+/', v: '打开 DSH 的快捷键设置（DSH 自己占用，我们主动避开）' },
    { k: 'Ctrl+, / Ctrl+Alt+,', v: '打开设置 —— 网页版由 DSH 占用 Ctrl+Alt+,，把 Ctrl+, 留给浏览器' },
    { k: 'Ctrl+P', v: '工作区的文件面板（桌面版默认；网页版没有绑定）' },
    { k: 'Ctrl+B / Ctrl+Shift+B', v: '左右侧栏（桌面版默认；网页版都没有绑定，所以 Ctrl+B 可以让给 tmux 当命令前缀）' },
    { k: 'Ctrl+T / Ctrl+`', v: '新浏览器标签 / 新终端（桌面版默认；网页版没有绑定）' },
    { k: 'Enter / Shift+Enter', v: '对话输入：发送 / 换行' },
    { k: 'Ctrl+Enter', v: '对话输入：排队等待 / 立刻插话' },
    { k: '@  /  /', v: '引用菜单 / 命令菜单' },
    { k: 'Esc Esc', v: '停止生成（连按两次，默认 500 毫秒内有效）—— 所以我们的 Esc 只在有浮层时才拦截' },
    { k: 'Enter / Esc（审批区）', v: '审批：允许 / 拒绝（DSH 固定键）' },
  ]
  // tmux 原生能力：C-b 是 tmux 前缀，我们把它原样送进终端 —— 下面这些都是 tmux 自带的
  const tmuxKeys = [
    { k: 'Ctrl+B "', v: '上下分割窗格（tmux 原生）' },
    { k: 'Ctrl+B %', v: '左右分割窗格' },
    { k: 'Ctrl+B c / n / p / 0…9', v: '新建窗口 / 下一个 / 上一个 / 直达第 N 个窗口' },
    { k: 'Ctrl+B z', v: '当前窗格最大化（再按还原）' },
    { k: 'Ctrl+B o（或方向键）', v: '轮换窗格 / 切换焦点' },
    { k: 'Ctrl+B [ / ]', v: '复制模式 / 粘贴' },
    { k: 'Ctrl+B x / &', v: '关闭窗格 / 关闭窗口' },
    { k: 'Ctrl+B d', v: 'detach —— 会话继续在后台跑，面板照旧读得到它的屏' },
    { k: 'Ctrl+B ? / :', v: 'tmux 键位表 / 命令提示符' },
  ]

  const subscriptionTable = []
  return [
    // 「会话」页的子类细分（用户要求：尽量展示全部信息）。台账逐 shell 一行，
    // 概览放在 v 里，完整明细放在 title（悬停可见），缺失字段统一显示 '-'。
    // 「插件状态」页签的核心：启动全流程（真信号来自宿主 GET /status）
    { group: '启动流程', rows: (function () {
      const ps = input.pluginStatus !== null && input.pluginStatus !== undefined ? input.pluginStatus : null
      if (ps === null) {
        const err = String(input.pluginStatusError ?? '')
        return [err === ''
          ? { k: '状态', v: '读取中…', tone: 'dim', title: '正在向 DSH 请求启动状态（GET /status）；通常一眨眼就好' }
          : { k: '状态', v: '读取失败：' + err, tone: 'warn', title: '需要较新的 DSH（带 /status 接口）；若刚更新代码，请重启一次 web 服务再打开本页' }]
      }
      const out = [
        { k: '结论', v: text(ps.conclusion, '未知'), tone: ps.level === 'ok' ? 'strong' : 'warn',
          title: '全部阶段通过=可正常工作；有未通过但阶段机已 ready=部分功能受限；否则=尚未就绪' },
      ]
      const stages = Array.isArray(ps.stages) ? ps.stages : []
      for (const s of stages) {
        out.push({
          k: (s.ok === true ? '✓ ' : s.ok === false ? '✗ ' : '？ ') + text(s.key, '(未命名)'),
          v: text(s.detail, '-'),
          tone: s.ok === true ? undefined : 'warn',
          title: [
            '阶段：' + text(s.key),
            '结果：' + (s.ok === true ? '通过' : s.ok === false ? '未通过' : '未知'),
            s.at !== null && s.at !== undefined && Number.isFinite(s.at) ? '时刻：' + new Date(s.at).toLocaleString('zh-CN') : '',
            '详情：' + text(s.detail, '-'),
          ].filter((x) => x !== '').join('\n'),
        })
      }
      out.push({ k: '检查时刻', v: ps.checkedAt !== undefined && Number.isFinite(ps.checkedAt) ? new Date(ps.checkedAt).toLocaleString('zh-CN') : '-',
        title: '每次打开本页重新读取一次（实时值）' })
      out.push({ k: '进程存活', v: ps.uptimeMs !== undefined && Number.isFinite(ps.uptimeMs) ? String(Math.round(ps.uptimeMs / 1000)) + ' 秒' : '-' })
      return out
    })() },
    { group: '当前会话与取景', rows: session },
    { group: '当前会话与取景', rows: buffer },   // 与上一段同名 ⇒ 渲染时合并为一段
    // 「审计与镜像」页：链/检查点/镜像/私钥/加锁/保留期；不知道的明确写"无法检测"及原因
    { group: '审计与镜像', rows: (function () {
      const a = server.audit !== null && typeof server.audit === 'object' ? server.audit : null
      if (a === null) return [{ k: '审计', v: '无法检测（DSH 没上报审计信息；可能插件版本旧，或审计没开）' }]
      const cp = a.checkpoints !== null && typeof a.checkpoints === 'object' ? a.checkpoints : null
      const checkedAt = Number.isFinite(cp?.checkedAt) ? cp.checkedAt : (Number.isFinite(a.chain?.checkedAt) ? a.chain.checkedAt : NaN)
      const out = [
        ...(server.auditLockReminder === true && a.locked !== 'append-only'
          ? [{ k: '审计加锁提醒', v: '未加锁：篡改可检测、物理可改；要“不可篡改”见 README「审计加锁」', tone: 'warn' }]
          : []),
        { k: '审计', v: auditRowValue(server), title: auditRowTitle(server),
          tone: auditRowValue(server).startsWith('⚠') ? 'warn' : 'dim' },
        { k: '输出留痕', v: captureRowValue(server), title: captureRowTitle(server),
          tone: captureRowValue(server).startsWith('⚠') ? 'warn' : 'dim' },
        { k: '审计目录', v: prettyPath(text(a.dir, '未上报')) },
        { k: '保留期', v: Number.isFinite(a.retentionDays) ? String(a.retentionDays) + ' 天' : '无法检测（DSH 还没上报）' },
        { k: '审计链', v: chainRowValue(server), title: chainRowTitle(server),
          tone: chainRowValue(server).startsWith('⚠') ? 'warn' : 'dim' },
        { k: '签名检查点', v: cp === null
          ? '无法检测（DSH 还没核对签名）'
          : (cp.ok === true
            ? `✓ ${cp.count} 个（seq 1…${cp.lastSeq}；key ${String(cp.keyId).slice(0, 8)}）`
            : `⚠ ${cp.errors?.[0] ?? '校验失败'}`),
          tone: cp !== null && cp.ok === false ? 'warn' : undefined,
          title: Array.isArray(cp?.errors) && cp.errors.length > 0 ? cp.errors.join('\n') : '' },
        { k: '检查点镜像', v: cp?.mirror?.configured !== true
          ? '未配置（设置页 auditMirror；未配置时无法发现「整文件+检查点同时删除」）'
          : String(cp.mirror.detail ?? ''),
          tone: cp?.mirror?.ok === false ? 'warn' : undefined },
        { k: '签名私钥', v: a.signing?.keyMode === '600'
          ? '0600 ✓'
          : (a.signing?.keyMode ? '⚠ 权限 ' + a.signing.keyMode : '无法检测（DSH 没给签名钥匙信息）'),
          title: a.signing?.keyFile ?? '' },
        { k: '审计锁定', v: lockRowValue(server), title: lockRowTitle(server),
          tone: lockRowValue(server).startsWith('⚠') ? 'warn' : 'dim' },
        { k: '最近校验', v: Number.isFinite(checkedAt) ? new Date(checkedAt).toLocaleString('zh-CN') : '无法检测（DSH 没记核对时间）' },
        { k: '外部时间戳', v: '未启用（Phase 2：OpenTimestamps/TSA；当前仅本地 + 镜像）' },
      ]
      for (const w of (Array.isArray(cp?.warnings) ? cp.warnings : []).slice(0, 3)) out.push({ k: '检查点提示', v: w, tone: 'warn' })
      return out
    })() },
    // 会话台账在前（用户 2026-10-24：台账比订阅更重要，概览先看到它）
    { group: '会话台账与策略', rows: [   // 与台账同名 ⇒ 合并为一段
      { k: '会话上限', v: String(sessions.length) + ' 个在用 / 上限 ' + text(server.maxSessions, '?'),
        title: '达到上限后新建会被拒绝；先关闭不再用的 shell 再新建' },
      { k: '空闲回收', v: server.idleClose === false
          ? '关（会话永久保留；只有显式设过 idleMinutes 的 shell 才回收）'
          : (typeof server.idleCloseMinutes === 'number' ? String(server.idleCloseMinutes) + ' 分钟（无输入且无前台命令才算闲置）' : '未上报'),
        title: '总开关在设置页；关着时不按全局兜底回收，开着的会话只在 idleMinutes 显式指定时按各自时长回收' },
      { k: '退出后保留屏面', v: text(server.remainOnExit, '(未上报)'),
        title: 'shell 退出后屏面保留一段时间供回看（remain-on-exit）' },
      { k: '自动清理进程', v: text(server.watchdog, '(未上报)'),
        title: '自动清理进程（看门狗 / watchdog）：回收“失去 DSH 后没人管”的终端' },
    ] },
    // 「订阅」页：谁订阅了哪个 shell、待读多少、注入过几次、最近一次何时（数据来自 /list）
    { group: '订阅列表', rows: (function () {
      const out = []
      for (const conv of subscriptions) {
        const who = typeof conv.conversationName === 'string' && conv.conversationName !== ''
          ? conv.conversationName
          : '会话 ' + String(conv.conversation ?? '').slice(0, 8)
        for (const sh of (Array.isArray(conv.shells) ? conv.shells : [])) {
          const label = typeof sh.label === 'string' && sh.label !== '' ? sh.label.replace(/^dsh-/, '') : ''
          const name = label !== '' ? label : String(sh.name ?? '?')
          const since = Number.isFinite(sh.since) && sh.since > 0 ? new Date(sh.since).toLocaleString('zh-CN') : '-'
          const last = Number.isFinite(sh.lastAt) && sh.lastAt > 0 ? new Date(sh.lastAt).toLocaleTimeString('zh-CN') : '-'
        const sinceShort = Number.isFinite(sh.since) && sh.since > 0
          ? new Date(sh.since).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
          : '-'
        out.push({
            k: who + ' → ' + name,
            v: (sh.alive === false ? '⚠ 壳已不在 · ' : '')
              + '待读 ' + String(sh.pending ?? 0) + ' 字符 · 已投送 ' + String(sh.count ?? 0) + ' 次 · 最近 ' + last
              + ' · 订阅于 ' + since,
            title: [
              '订阅者会话：' + who + '（' + String(conv.conversation ?? '') + '）',
              'shell：' + String(sh.name ?? '?') + (label !== '' ? '（' + label + '）' : ''),
              '订阅开始：' + since,
              '待读字符：' + String(sh.pending ?? 0) + ' · 读到第几个字（游标）：' + String(sh.cursor ?? 0),
              '已投送：' + String(sh.count ?? 0) + ' 次（最近 ' + last + '，' + String(sh.lastChars ?? 0) + ' 字符）',
              '环内被丢弃（更早）：' + String(sh.missed ?? 0) + ' 字符',
              '壳是否还在：' + (sh.alive === false ? '已不在' : '在'),
              '数据来源：DSH 每 400 毫秒抓一次屏幕变化（只对已订阅的终端）',
            ].join('\n'),
          })
          subscriptionTable.push({
            who,
            shell: name,
            pending: Number(sh.pending ?? 0),
            count: Number(sh.count ?? 0),
            last,
            since,
            sinceShort,
            lastChars: Number(sh.lastChars ?? 0),
            cursor: Number(sh.cursor ?? 0),
            missed: Number(sh.missed ?? 0),
            alive: sh.alive !== false,
          })
        }
      }
      return out.length > 0 ? out : [{ k: '订阅', v: '（当前没有订阅）', title: '在 shell_read 里用 action.kind="watch" 订阅后，这里会列出每个订阅的详情' }]
    })(), tableRows: subscriptionTable },
    { group: '服务端', rows: serverRows },
    { group: '运行参数', rows: paramRows },
    { group: '启动', rows: startupRows, flow: startupFlowModel(su) },
    { group: '孤儿看门狗', rows: watchdog },
    { group: '审批与安全', rows: securityRows },
    { group: '官方审批', rows: approvalRows, dismissable: true },
    { group: '版本', rows: version },
    // 0.4.0 简化（用户要求）：原本 4 张键位卡信息重复、扫视慢 → 合并成 2 张。
    // 只保留**我们自己**的面板快捷键（用户要求）。tmux 原生键与宿主机键属于 tmux/DSH 的文档，
    // 与本插件功能无关，移出面板界面。
    { group: '面板快捷键', rows: panelKeys },
  ]
}

/**
 * 面板级快捷键（纯函数，可离线断言）：一次 keydown 该触发哪个面板动作。
 *
 * **为什么不抢终端的键**：bash/readline 与 PowerShell(PSReadLine) 把 Ctrl 单字符用满了
 * （C-a/e/b/f/k/u/w/r/l/p/n/c/d/z、Alt-b/f、F7 历史），tmux 的前缀也是 C-b ——
 * 这些一律照原样送进终端（见 {@link decideKey}）。面板自己的快捷键统一走
 * **Ctrl+Shift+\***（Windows Terminal 的约定：Ctrl+Shift+T 新建、Ctrl+Shift+W 关闭、
 * Ctrl+Shift+数字 切标签），再加一个 F2（tmux 用 `,` 重命名，F2 是终端里的通用习惯）。
 *
 * @param {object} e - `{ key, ctrlKey, metaKey, altKey, shiftKey, isComposing, keyCode }`
 * @returns {string|null} 动作 id（null = 不拦，交给输入框/终端）
 */
function decidePanelKey(e) {
  if (e.isComposing === true || e.keyCode === 229) return null
  const mod = e.ctrlKey === true || e.metaKey === true
  if (e.key === 'Escape') return 'close-overlays'
  if (e.key === 'F2') return 'rename'
  if (mod !== true || e.altKey === true) return null
  const k = typeof e.key === 'string' ? e.key.toLowerCase() : ''
  if (e.shiftKey === true) {
    // 0.4.0 最终范围（用户拍板）：只保留"切换 shell"与"开合面板"这两个高频动作，
    // 其余（新建/关闭/详情/授权/引用库/日志/锁定）是低频操作，点击更快，不做快捷键。
    // 开合面板**不再有自研键位**：它只走官方快捷键系统（注册进 ctx.shortcuts）。
    // 官方那条如果不生效，就在详情页里如实说明，而不是再塞一个"降级的第二套键"。
    const map = {
      arrowup: 'prev', arrowdown: 'next',
    }
    return map[k] !== undefined ? map[k] : null
  }
  return null
}

/**
 * 0.4.0 面板开合命令：**优先接入官方快捷键系统**（`ctx.shortcuts`）。
 *
 * 为什么走官方而不是自己监听键盘：
 *   · 注册时会与官方命令做冲突检测（重叠直接抛错，不会"两方都被吞掉"）；
 *   · 它自动出现在 DSH 设置 → 通用 → 快捷键里，**用户可自己改**、可重置、有冲突提示；
 *   · `regions` / `modals` 的语义由宿主统一处理，不用我们自己判断焦点与模态。
 *
 * 默认键位按用户拍板：优先 `Ctrl+Alt+/`（`primary+alt+Slash`，官方推荐的 Mod+Alt 形态、
 * 与官方 10 个命令无重叠）；若实测在浏览器上投递不了再退到 `Ctrl+Alt+S`。
 * 六个 profile 全给同一组合（`primary` 在 macOS 展开为 Command）。
 *
 * @param {() => void} run - 动作（切换面板展开态）；由组件挂载时挂上，卸载时摘下。
 * @returns {object} 官方 `ctx.shortcuts.register` 需要的命令定义（纯数据 + resolve）。
 */
function shellPanelShortcut(run) {
  const binding = { code: 'Slash', modifiers: ['primary', 'alt'] }
  return {
    id: 'terminalkeeper.panel.toggle',
    label: () => '开合 shell 面板',
    aliases: ['toggle shell panel', 'shell panel', '开合面板', '面板'],
    defaults: {
      'web:windows': binding,
      'web:macos': binding,
      'web:linux': binding,
      'desktop:windows': binding,
      'desktop:macos': binding,
      'desktop:linux': binding,
    },
    // 全局语义：焦点在页面 / 可编辑元素 / 终端里都能开合（这是唯一需要全局的动作）
    regions: ['page', 'editable', 'terminal'],
    // 不在任何模态里生效（设置页等自有自己的键盘处理）
    modals: [],
    resolve: (context) => {
      if (typeof run !== 'function') return { status: 'pass' }
      return {
        status: 'handled',
        run: () => {
          // 动作失败不该让宿主的 dispatch 崩：owner 自己负责错误
          try { run() } catch { /* 忽略：面板可能尚未挂载 */ }
        },
      }
    },
  }
}

/** 组件挂载时挂上"切换面板展开态"的动作（apply 阶段拿不到 React state）。 */
var shellPanelToggle = null
/** 官方快捷键是否注册成功：成功时自研的 Ctrl+Shift+S 降级路径让位，避免两套键位并存。 */
var shellPanelShortcutLive = false
/** 订阅"官方快捷键是否已就绪 / 当前键位文本"的监听者（详情页键位表据此显示真实键位）。 */
var shellShortcutListeners = new Set()

function notifyShellShortcut() {
  for (const fn of shellShortcutListeners) {
    try { fn() } catch { /* 单个监听者出错不影响其它 */ }
  }
}

/** 从 catalog 读到的"官方此刻生效的键位"；null = 官方那条还没生效（或还没读出来）。 */
var shellPanelShortcutKeysText = null

/**
 * 键位在界面上的显示文本。
 * 优先用 **catalog 里的真实键位**（用户改过键、或官方判定了冲突都会反映在这里），
 * 拿不到时回退到我们声明的默认值（按平台给修饰符名）。
 */
/** 日志详情缓存：key = kind:name → 详情对象（含统计）。上限 24 条，超出丢最早的。 */
var logDetailCacheMap = new Map()

function shellPanelShortcutKeys() {
  if (typeof shellPanelShortcutKeysText === 'string' && shellPanelShortcutKeysText !== '') return shellPanelShortcutKeysText
  const isMac = typeof navigator !== 'undefined' && typeof navigator.platform === 'string' && /mac/i.test(navigator.platform)
  return isMac ? '⌘+⌥+/' : 'Ctrl+Alt+/'
}

function decideKey(e) {
  // 组字中：回车/空格/Tab/方向键都在给输入法选词，一个都不能抢。
  if (e.isComposing === true || e.keyCode === 229) return { action: 'pass' }

  if (e.ctrlKey === true || e.metaKey === true || e.altKey === true) {
    if (e.ctrlKey !== true || e.altKey === true || e.metaKey === true) return { action: 'pass' }
    // 带 Shift 的 Ctrl 组合是**面板快捷键**（Ctrl+Shift+*，Windows Terminal 的约定），
    // 不能当终端键送下去 —— 否则 Ctrl+Shift+P 会变成 C-p（bash 的历史上一条）。
    if (e.shiftKey === true) return { action: 'pass' }
    if (typeof e.key !== 'string' || e.key.length !== 1) return { action: 'pass' }
    const mapped = CTRL_KEYS[e.key.toLowerCase()]
    if (mapped === undefined) return { action: 'pass' }
    // 有选中文本时 Ctrl+C 让浏览器复制，而不是往终端送 SIGINT 打断正在跑的命令
    if (mapped === 'C-c' && e.hasSelection === true) return { action: 'pass' }
    return { action: 'key', key: mapped }
  }

  const named = {
    Tab: e.shiftKey === true ? 'BTab' : 'Tab',
    Enter: 'Enter',
    Backspace: 'BSpace',
    Delete: 'Delete',
    Escape: 'Escape',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
  }
  const hit = named[e.key]
  if (hit !== undefined) return { action: 'key', key: hit }
  return { action: 'pass' }
}

/**
 * 组字状态机（纯函数，便于脱离浏览器验证）。
 *
 * **为什么不用事件的 `isComposing` 判断**：Chrome 在组字提交时补的那个 `input` 事件里
 * `isComposing` 常常仍是 `true`（已知的浏览器不一致），而且各浏览器的 `input` /
 * `compositionend` **顺序也不同**（Chrome 多为 input 先、Safari 多为 compositionend 先）。
 * 只按事件字段判断会漏掉整次提交，表现就是「提交的汉字滞留在输入框里，直到敲下一个字符
 * 才和后面的字一起被送走」。
 *
 * 所以改成自己维护状态：`compositionstart` 置位、`compositionend` 清位，
 * `input` **只看自己这个标志**。对三种顺序都成立，且「谁先读到谁清空」避免重复发送。
 *
 * @param {string} kind - `'compositionstart'` | `'compositionend'` | `'input'` | `'keydown'`
 * @param {{ composing: boolean, value?: string, eventIsComposing?: boolean }} state
 * @returns {{ composing: boolean, commit: string }} 新状态，以及本次要送进终端的文本
 */
function decideComposition(kind, state) {
  if (kind === 'compositionstart') return { composing: true, commit: '' }
  if (kind === 'compositionend') {
    return { composing: false, commit: typeof state.value === 'string' ? state.value : '' }
  }
  if (kind === 'keydown') {
    // 非组字的按键说明组字已经结束：顺手清位，避免标志被卡住
    return { composing: state.eventIsComposing === true, commit: '' }
  }
  // input：
  //  * 事件明确说「非组字」（isComposing === false）时以它为准 —— 万一 compositionend
  //    没触发，也不至于让标志永久卡住、把之后所有输入都吞掉；
  //  * 否则只信自己维护的标志。
  const value = typeof state.value === 'string' ? state.value : ''
  if (state.eventIsComposing !== false && state.composing === true) return { composing: true, commit: '' }
  return { composing: false, commit: value }
}

/** 图标路径（24×24 视口，描边式）。用 SVG 而不是 emoji —— emoji 在各平台渲染差异太大。 */
var ICON_PATHS = {
  prev: 'M15 18l-6-6 6-6',
  next: 'M9 18l6-6-6-6',
  down: 'M6 9l6 6 6-6',
  right: 'M9 6l6 6-6 6',
  key: 'M14.5 6a4.5 4.5 0 11-1.3 3.2L10 12.4l-1-1-2 2-1-1-1.5 1.5M14.5 6a3 3 0 100 6 3 3 0 000-6zM10 12.4L8.5 13.9',
  lock: 'M8 11V7a4 4 0 018 0v4M6 11h12v9H6z',
  unlock: 'M8 11V7a4 4 0 017.5-2M6 11h12v9H6z',
  plus: 'M12 5v14M5 12h14',
  x: 'M6 6l12 12M18 6L6 18',
  min: 'M5 12h14',
  push: 'M12 19V5M5 12l7-7 7 7',
  more: 'M12 5v14M7 10l5-5 5 5',
  latest: 'M12 5v14M7 14l5 5 5-5',
  grip: 'M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01',
  pencil: 'M4 20h4L19 9a2.1 2.1 0 00-3-3L5 17zM14 6l3 3',
  info: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 11v5M12 7.6h.01',
  play: 'M8 5.4v13.2L19 12z',
  pause: 'M9 5.5v13M15 5.5v13',
  film: 'M4 5h16v14H4zM4 10h16M4 14h16M9 5v14M15 5v14',
  log: 'M8 8h8M8 12h8M8 16h4M5 4h14v16H5zM17 4v16',
  search: 'M11 4a7 7 0 100 14 7 7 0 000-14zM15.5 15.5L21 21',
  replay: 'M19 12a7 7 0 11-2.05-4.95M19 3v5h-5',
  shield: 'M12 3l7 3v5.2c0 4.1-2.9 7.6-7 9-4.1-1.4-7-4.9-7-9V6zM9.2 12.2l2 2 3.6-3.8',
  cog: 'M12 8.5a3.5 3.5 0 100 7 3.5 3.5 0 000-7zM4 12h2M18 12h2M12 4v2M12 18v2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M17.7 6.3l-1.4 1.4M7.7 16.3l-1.4 1.4',
}

/**
 * 0.3.3：启动阶段流程图模型（纯函数）。deferred 模式下用户该能一眼看到插件此刻活在哪一步：
 * 注册（同步段，恒 done）→ 延迟门（等 startupDeferMs/唤醒）→ 就绪链（探测/配置/清点）→ 就绪。
 */
function startupFlowModel (startup) {
  const phase = startup !== null && startup !== undefined && typeof startup === 'object' ? String(startup.phase || '') : ''
  return [
    { label: '注册', state: 'done' },
    { label: '延迟门', state: phase === 'deferred' ? 'now' : 'done' },
    { label: '就绪链', state: phase === 'running' ? 'now' : (phase === 'ready' ? 'done' : 'wait') },
    { label: '就绪', state: phase === 'ready' ? 'done' : 'wait' },
  ]
}

/**
 * 0.3.3 #3：回放纯逻辑（面板侧独立实现，宿主 playDelayMs/seekFrameIndex 的等价形）。
 * 面板不 import 宿主模块（浏览器隔离），所以这里**重写一遍**并用 test-client 的
 * `__replayDelay/__seekFrame` 钩子钉住等价 —— 两边漂移到不一致会被测试抓到。
 */
function replayDelay (prevT, nextT, speed) {
  const gap = Math.max(0, Number(nextT) - Number(prevT))
  if (!Number.isFinite(gap)) return 0
  const s = Number.isFinite(speed) ? Math.min(8, Math.max(0.5, speed)) : 1
  return Math.min(3000, gap / s)
}
/** 时间轴 ms → `m:ss`（面板计时标签）。 */
function replayClock (ms) {
  const n = Math.max(0, Math.floor(Number(ms) / 1000))
  if (!Number.isFinite(n)) return '0:00'
  return String(Math.floor(n / 60)) + ':' + String(n % 60).padStart(2, '0')
}

/**
 * 面板样式。
 *
 * 为什么要注入 <style>：内联样式表达不了 `:hover` / `:active` / 过渡，而这些正是
 * 「按钮看着不丑」的关键。`apply()` 里插一次并在 `ctx.effect` 的清理里移除。
 */
var PANEL_CSS = `
/* 兜底：宿主未定义 --dsw-specific-menu 时，弹层/菜单/表头会拿到**空值** ⇒ 背景透明 ⇒ 文字压在页面内容上。
   在这里给一次默认值，覆盖全部 9 处引用（不改各处写法，避免遗漏）。 */
:root{--dsw-specific-menu:var(--dsw-alias-bg-layer-2))}

/* 带文字的按钮变体：基础 .dshsh-btn 是 31×31 的图标按钮（固定宽），
   文字变体必须宽度自适应且不换行，否则『确认删除』这类较长文案会溢出并被压在一起。 */
/* 文字按钮（自适应宽度）：
   · .txt  —— 原生按钮显式标注；
   · .text —— 按钮工厂在 props.text 存在时**自动**加的标记（本次补上样式）。
   基础 .dshsh-btn 是 31×31 图标按钮，固定宽度对文字不够用（『确认删除』曾溢出重叠）。 */
.dshsh-btn.text,.dshsh-btn.txt{width:auto;min-width:31px;padding:0 9px;white-space:nowrap;gap:4px}
.dshsh-btn{display:inline-flex;align-items:center;justify-content:center;width:31px;height:31px;padding:0;
  border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;
  color:var(--dsw-alias-label-secondary);cursor:pointer;flex:0 0 auto;
  transition:background .12s ease,color .12s ease,border-color .12s ease,transform .06s ease}
.dshsh-btn:hover:not(:disabled){background:var(--dsw-alias-button-tool-bar-hover);color:var(--dsw-alias-label-primary)}
.dshsh-btn:active:not(:disabled){transform:translateY(1px)}
.dshsh-btn:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:1px}
.dshsh-btn:disabled{opacity:.3;cursor:not-allowed}
.dshsh-btn.on{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-button-ghost-active-fill)}
.dshsh-btn.active{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}
.dshsh-btn.locked{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-button-ghost-active-fill)}
/* 关闭与收起之间的分隔：两者代价不同，视觉上也要分开 */
.dshsh-sep{width:1px;height:16px;flex:0 0 auto;margin:0 7px;background:var(--dsw-alias-border-l2)}
.dshsh-ck{flex:0 0 auto;width:22px;height:22px;margin-left:4px;border:0;border-radius:6px;
  background:transparent;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1;cursor:pointer}
.dshsh-ck:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshsh-ck.on{color:var(--dsw-alias-brand-primary)}
.dshsh-row-lock{margin-left:5px;font-size:11px;line-height:1;flex:0 0 auto}
.dshsh-batch-row{display:flex;align-items:center;gap:5px;flex-wrap:wrap;width:100%}
.dshsh-batch-row + .dshsh-batch-row{margin-top:5px}
.dshsh-batch{display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin:4px 6px 2px;padding:6px 6px;
  border:.5px dashed var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}
.dshsh-batch-n{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-tertiary);font-size:10.5px;font-variant-numeric:tabular-nums}
.dshsh-stat-btn.danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dshsh-searchbar{display:flex;align-items:center;gap:6px;padding:5px 8px;
  border-top:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}
.dshsh-search-icon{flex:0 0 auto;font-size:11px;opacity:.7}
.dshsh-search-in{flex:1 1 auto;min-width:0;height:24px;padding:0 8px;border-radius:7px;
  border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);
  color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;font-family:var(--ds-font-family-code)}
.dshsh-search-in:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.dshsh-search-cnt{flex:0 0 auto;color:var(--dsw-alias-label-tertiary);font-size:10.5px;font-variant-numeric:tabular-nums}
.dshsh-hit{background:var(--dsw-alias-button-ghost-active-fill);color:var(--dsw-alias-label-primary);
  border-radius:2px;outline:.5px solid var(--dsw-alias-state-warn-primary)}
.dshsh-hit.current{background:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-label-primary-inverted)}
.dshsh-robar{display:flex;align-items:center;justify-content:center;gap:6px;min-height:38px;padding:0 10px;
  font-size:11.5px;color:var(--dsw-alias-label-tertiary);border-top:.5px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-interactive-bg-hover);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshsh-stat-hint{max-width:180px;padding:1px 8px;border-radius:999px;font-size:10.5px;
  color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-button-ghost-active-fill);
  border:.5px solid var(--dsw-alias-state-success-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* ── 设置卡片（渲染在 DSH 设置页 →「插件配置」标签页里）──────────────────────
 *
 * 每一项取值都照**官方编译产物**抄（@deepseek-ai/dsh-client-ui-settings-plugins
 * 的 PluginCard.module.css / fields.module.css / PluginsSettingsSection.module.css，
 * 它们以字符串形式内联在该包 client.js 顶部，可直接读到）：
 *   card      边框 .5px border-l4、圆角 16px、关闭 layer-3 / 展开 layer-2
 *   name      15px/600/1.4；description 13px/1.5
 *   body      border-top .5px border-l2、margin 0 16px、padding-bottom 8px
 *   field     纵向 flex、gap 6px、padding 12px 0，相邻 field 之间 .5px 上边框
 *   input     高 34px、padding 0 12px、13px、圆角 8px、边框 .5px border-l4
 *   footer    在 body **内部**，border-top .5px、右对齐、gap 8px、padding 12px 0 4px
 *   按钮      padding 5px 14px、13px、圆角 8px、disabled opacity .4
 *
 * 踩过的坑（这次修的就是它）：早前是"凭印象对齐"—— 12px 圆角、14px 标题、1px
 * border-l2、三列网格 minmax(140px,200px) / minmax(150px,220px) / minmax(0,1fr)、
 * 页脚放在 body 外面。三处后果：① 网格有 ~342px 的最小宽度，面板窄时溢出卡片边框；
 * ② 错误/只读提示是网格子项却没有 grid-column:1/-1，它挤进第 1 列并把**其后每一行
 * 都推移一格** → 整张卡片错位；③ 页脚不在 body 的 16px 内缩里，宽度和上面对不齐。
 * 纵向堆叠（官方做法）没有列宽概念，任何宽度都不会错位。
 */
.dshsh-cfg-card{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-2);
  border-radius:16px;list-style:none;transition:border-color .16s,background .16s}
.dshsh-cfg-card:hover{border-color:var(--dsw-alias-label-dimmed)}
.dshsh-cfg-card-open{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.dshsh-cfg-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;
  background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}
.dshsh-cfg-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dshsh-cfg-headtext{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.dshsh-cfg-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}
.dshsh-cfg-desc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.dshsh-cfg-demo{margin-top:8px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l4);overflow:auto}
.dshsh-cfg-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}
.dshsh-cfg-chevron-open{transform:rotate(180deg)}
/* 官方用 Tag primitive 显示"未保存"；我们不引额外依赖，用同尺寸的静态标签 */
.dshsh-cfg-pending{flex:none;align-self:center;border:.5px solid var(--dsw-alias-border-l4);border-radius:6px;
  padding:1px 6px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.5;white-space:nowrap}
.dshsh-cfg-body{border-top:.5px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}
.dshsh-cfg-readonly{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:12px;line-height:1.5}
/* 分组标题：独占一行，并且**打断** .field + .field 的相邻关系，
   所以每组第一项不会带上分隔线（新分组从头开始，视觉上是干净的） */
.dshsh-settings-sticky{position:sticky;top:0;z-index:4;background:var(--dsw-alias-bg-layer-2);padding:2px 16px 4px 0;margin:0 0 2px;box-sizing:border-box}
.dshsh-settings-sticky .dshsh-settings-search{margin:0 0 4px}
.dshsh-cfg-panel-body .dshsh-settings-sticky{background:var(--dsw-alias-bg-layer-2);padding-top:0}
.dshsh-cfg-panel .dshsh-cfg-body{border-top:0;margin:0;padding-bottom:0}
.dshsh-settings-nav{display:flex;flex-wrap:wrap;gap:2px;margin:0;padding:3px;background:var(--dsw-alias-bg-layer-1);border-radius:10px;border:.5px solid var(--dsw-alias-border-l2)}
.dshsh-settings-nav .dshsh-u-tab{font-size:11px;padding:3px 8px}
.dshsh-u-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dshsh-u-search-in:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:4px}
.dshsh-settings-search{width:calc(100% - 18px);max-width:calc(100% - 18px);font-size:12px!important;box-sizing:border-box}
.dshsh-cfg-group{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600;line-height:1.5;
  margin:0;padding:14px 0 0}
.dshsh-cfg-field{flex-direction:column;gap:6px;padding:12px 0;display:flex;background:var(--dsw-alias-bg-layer-2)}
.dshsh-range-field{flex-direction:column;gap:6px;padding:12px 0;display:flex;background:var(--dsw-alias-bg-layer-2)}
.dshsh-range-head{justify-content:space-between;align-items:center;gap:8px;display:flex}
.dshsh-range-head label{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500}
.dshsh-range-val{color:var(--dsw-alias-label-tertiary);font-size:12px;font-variant-numeric:tabular-nums}
.dshsh-range-row{align-items:center;gap:8px;display:flex}
.dshsh-range-slider{flex:1 1 auto;min-width:0;accent-color:var(--dsw-alias-brand-primary)}
.dshsh-range-num{box-sizing:border-box;width:72px;height:30px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l3);border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;text-align:right}
.dshsh-range-num:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.dshsh-range-unit{color:var(--dsw-alias-label-tertiary);font-size:12px}
.dshsh-color-field{flex-direction:column;gap:6px;padding:12px 0;display:flex;background:var(--dsw-alias-bg-layer-2)}
.dshsh-color-swatch{width:38px;height:32px;padding:2px;border:.5px solid var(--dsw-alias-border-l3);border-radius:7px;background:var(--dsw-alias-bg-layer-1);cursor:pointer}
.dshsh-color-text{flex:1 1 auto;min-width:0}
.dshsh-demo{display:flex;flex-direction:column;gap:12px;padding:2px 0 8px}
.dshsh-demo-hero{border:.5px solid var(--dsw-alias-border-l3);border-radius:14px;padding:14px 16px;background:linear-gradient(135deg,color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent),transparent 70%),var(--dsw-alias-bg-layer-2)}
.dshsh-demo-hero h2{margin:0 0 4px;font-size:16px;line-height:1.4;color:var(--dsw-alias-label-primary)}
.dshsh-demo-hero p{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.dshsh-demo-badge{display:inline-flex;align-items:center;gap:5px;margin-bottom:8px;padding:2px 8px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font-size:10.5px;letter-spacing:.04em}
.dshsh-demo-tabs{display:flex;gap:4px;padding:3px;border:.5px solid var(--dsw-alias-border-l3);border-radius:10px;background:var(--dsw-alias-bg-layer-2);align-self:flex-start}
.dshsh-demo-tab{appearance:none;border:0;border-radius:7px;padding:5px 10px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;cursor:pointer}
.dshsh-demo-tab.on{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px var(--dsw-alias-bg-mask-1)}
.dshsh-demo-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:10px}
.dshsh-demo-card{display:flex;flex-direction:column;gap:9px;min-width:0;padding:12px;border:.5px solid var(--dsw-alias-border-l3);border-radius:12px;background:var(--dsw-alias-bg-layer-2)}
.dshsh-demo-card h3{margin:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);letter-spacing:.02em}
.dshsh-demo-row{display:flex;align-items:center;flex-wrap:wrap;gap:8px;min-width:0}
.dshsh-demo-btn{appearance:none;border:.5px solid var(--dsw-alias-border-l3);border-radius:8px;padding:6px 11px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}
.dshsh-demo-btn:hover:not(:disabled){border-color:var(--dsw-alias-label-dimmed);background:var(--dsw-alias-bg-layer-3)}
.dshsh-demo-btn.primary{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-inverted)}
.dshsh-demo-btn.danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dshsh-demo-btn.ghost{border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary)}
.dshsh-demo-btn:disabled{opacity:.45;cursor:default}
.dshsh-demo-chip{display:inline-flex;align-items:center;gap:4px;border-radius:999px;padding:2px 8px;border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font-size:10.5px}
.dshsh-demo-chip.ok{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent)}
.dshsh-demo-chip.warn{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 45%,transparent)}
.dshsh-demo-stat{display:flex;flex-direction:column;gap:2px;padding:9px 10px;border-radius:9px;background:var(--dsw-alias-bg-layer-3);min-width:0}
.dshsh-demo-stat b{font-size:18px;line-height:1.2;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.dshsh-demo-stat span{font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.dshsh-demo-alert{display:flex;gap:8px;align-items:flex-start;padding:9px 10px;border-radius:9px;border-left:3px solid var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:1.55}
.dshsh-demo-alert b{color:var(--dsw-alias-label-primary)}
/* ── 新版设置页：左导航 + 右内容 ───────────────────────────────────────── */
.dshsh-set-hero{border:.5px solid var(--dsw-alias-border-l3);border-radius:14px;padding:13px 14px;background:linear-gradient(135deg,color-mix(in srgb,var(--dsw-alias-brand-primary) 9%,transparent),transparent 72%),var(--dsw-alias-bg-layer-1)}
.dshsh-set-hero-title h2{margin:0 0 3px;font-size:16px;line-height:1.35;color:var(--dsw-alias-label-primary)}
.dshsh-set-hero-title p{margin:0 0 10px;font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-secondary)}
.dshsh-settings-search{width:100%;max-width:none;box-sizing:border-box;font-size:12px!important}
.dshsh-set-shell{display:grid;grid-template-columns:118px minmax(0,1fr);gap:10px;align-items:start}
.dshsh-set-rail{display:flex;flex-direction:column;gap:3px;min-width:0;padding:3px 0}
.dshsh-set-nav-item{appearance:none;display:flex;align-items:center;justify-content:space-between;gap:4px;width:100%;padding:7px 8px;border:.5px solid transparent;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;text-align:left;cursor:pointer;white-space:nowrap;overflow:hidden}
.dshsh-set-nav-item:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dshsh-set-nav-item.on{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,var(--dsw-alias-bg-layer-2));border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 38%,transparent);color:var(--dsw-alias-label-primary);font-weight:600}
.dshsh-set-nav-label{overflow:hidden;text-overflow:ellipsis}
.dshsh-set-nav-count{flex:none;min-width:16px;padding:1px 5px;border-radius:999px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-tertiary);font-size:10px;text-align:center}
.dshsh-set-main{display:flex;flex-direction:column;gap:8px;min-width:0}
.dshsh-set-section-head{display:flex;align-items:baseline;gap:7px;flex-wrap:wrap;padding:3px 1px 0}
.dshsh-set-section-head h3{margin:0;font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dshsh-set-section-head>span{font-size:10px;color:var(--dsw-alias-label-tertiary);border:.5px solid var(--dsw-alias-border-l3);border-radius:999px;padding:0 6px}
.dshsh-set-section-head p{flex:1 1 100%;margin:0;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.dshsh-set-field{display:flex;flex-direction:column;gap:8px;padding:11px 12px;border:.5px solid var(--dsw-alias-border-l3);border-radius:11px;background:var(--dsw-alias-bg-layer-2)}
.dshsh-set-field+.dshsh-set-field{border-top:.5px solid var(--dsw-alias-border-l3)}
.dshsh-set-field-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;min-width:0}
.dshsh-set-field-title{display:flex;flex-direction:column;gap:2px;min-width:0}
.dshsh-set-field-label{color:var(--dsw-alias-label-primary);font-size:12.5px;font-weight:500;line-height:1.4}
.dshsh-set-field-key{color:var(--dsw-alias-label-tertiary);font-size:10px;font-family:var(--ds-font-family-code);line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshsh-set-field .dshsh-cfg-hint{margin:0;font-size:11px}
.dshsh-set-field .dshsh-range-field,.dshsh-set-field .dshsh-color-field{background:transparent;padding:0;border:0}
.dshsh-set-field .dshsh-range-head label,.dshsh-set-field .dshsh-color-field label{font-size:11.5px}
.dshsh-set-switch{display:flex;align-items:center;justify-content:space-between;gap:10px;cursor:pointer}
.dshsh-set-switch-label{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dshsh-set-input{height:32px}
.dshsh-set-footer{display:flex;align-items:center;gap:7px;padding-top:4px;flex-wrap:wrap}
.dshsh-set-save-state{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5}
.dshsh-set-save-state.dirty{color:var(--dsw-alias-state-warn-primary)}
/* 面板内宽度只有 ~540px：导航改为顶部分段条，内容独占宽度（比左栏更易读）。 */
.dshsh-cfg-panel .dshsh-set-shell{grid-template-columns:1fr}
.dshsh-cfg-panel .dshsh-set-rail{flex-direction:row;overflow-x:auto;padding:2px 0 4px;border-bottom:.5px solid var(--dsw-alias-border-l3)}
.dshsh-cfg-panel .dshsh-set-nav-item{width:auto;flex:none;padding:5px 8px}
@media (max-width: 430px){.dshsh-set-shell{grid-template-columns:1fr}.dshsh-set-rail{flex-direction:row;overflow:auto;padding-bottom:2px}.dshsh-set-nav-item{width:auto;flex:none}}




.dshsh-cfg-field+.dshsh-cfg-field{border-top:.5px solid var(--dsw-alias-border-l2)}
.dshsh-cfg-head{align-items:center;gap:8px;display:flex}
/* 字段名就是配置键（historyLimit 这种），等宽字体更好认；字号/字重照官方 label */
.dshsh-cfg-label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;
  line-height:1.5;font-family:var(--ds-font-family-code);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshsh-cfg-badges{align-items:center;gap:8px;display:inline-flex;flex:none}
.dshsh-cfg-badge{border:.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-secondary);
  border-radius:6px;padding:1px 6px;font-size:11px;line-height:1.5;white-space:nowrap}
.dshsh-cfg-input{box-sizing:border-box;width:100%;height:34px;padding:0 12px;font:inherit;font-size:13px;
  line-height:1.5;font-family:var(--ds-font-family-code);color:var(--dsw-alias-label-primary);
  background:var(--dsw-alias-bg-layer-3);border:.5px solid var(--dsw-alias-border-l4);border-radius:8px}
.dshsh-cfg-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.dshsh-cfg-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
/* 布尔项：官方 SubagentModelSelectionCard 的 toggleRow —— 标签在左、开关在右、两端对齐 */
.dshsh-cfg-togglerow{color:var(--dsw-alias-label-primary);justify-content:space-between;align-items:flex-start;
  gap:16px;font-size:13px;line-height:1.5;display:flex}
.dshsh-cfg-togglelabel{flex:1;min-width:0;align-items:center;gap:8px;display:flex}
.dshsh-cfg-togglelabel code{min-width:0;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;
  font-family:var(--ds-font-family-code);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshsh-cfg-check{flex:none;width:16px;height:16px;margin:1px 0 0;cursor:pointer;
  accent-color:var(--dsw-alias-label-primary)}
.dshsh-cfg-check:disabled{cursor:default}
.dshsh-cfg-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}
.dshsh-cfg-footer{border-top:.5px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;
  gap:8px;padding:12px 0 4px;display:flex}
.dshsh-cfg-note{min-width:0;color:var(--dsw-alias-label-tertiary);flex:1;margin:0;font-size:12px;line-height:1.5}
/* 官方 .failed 用的是 --dsw-alias-label-error，但那个令牌在部分皮肤里**没有定义**
   （实测 blue-fantasy 的皮肤样式表里查不到，官方那条颜色其实是失效的）。
   这里改用本部署确实存在的 --dsw-alias-state-error-primary，浅色/深色主题都跟着走。 */
.dshsh-cfg-failed{min-width:0;color:var(--dsw-alias-state-error-primary);
  flex:1;margin:0;font-size:12px;line-height:1.5}
.dshsh-cfg-discard,.dshsh-cfg-save{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;
  border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}
.dshsh-cfg-discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}
.dshsh-cfg-discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.dshsh-cfg-save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.dshsh-cfg-discard:disabled,.dshsh-cfg-save:disabled{opacity:.4;cursor:default}
.dshsh-cfg-discard:focus-visible,.dshsh-cfg-save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
/* 真实光标：绝对定位在 <pre> 的内容坐标里（随内容滚动，无需同步），
   横向宽度由 Range 实测（见 measurePrefixWidth），纵向用实测行高。 */
/* 屏幕文本：MeasurePrefixWidth 靠这个类拿到文本节点（量前缀宽度用）；
   样式本身与 <pre> 一致，保持列的严格对齐。 */
.dshsh-screen-text{white-space:pre}
.dshsh-player{flex-direction:column;flex:1;min-height:0;gap:2px;display:flex}
.dshsh-player-screen{flex:1;min-height:120px}
.dshsh-player-bar{align-items:center;gap:6px;padding:2px 6px;font-size:11px;flex:none;display:flex}
.dshsh-player-scrub{flex:1;min-width:0}
.dshsh-player-speed{appearance:auto;color:inherit;border:1px solid transparent;border-radius:6px;padding:1px 3px;font-size:11px}
.dshsh-player-clock{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dshsh-flow{margin-left:6px;display:inline-flex;gap:4px;font-weight:normal;font-size:9.5px}
.dshsh-flowstep{border-radius:7px;padding:1px 5px;color:var(--dsw-alias-label-tertiary);font-style:normal}
.dshsh-flowstep.done{color:var(--dsw-alias-state-success-primary)}
.dshsh-flowstep.now{color:var(--dsw-alias-state-warn-primary)}
.dshsh-gx{margin-left:auto;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:10px;cursor:pointer;padding:0 4px}
.dshsh-gx:hover{color:var(--dsw-alias-label-primary)}
.dshsh-player-file{max-width:32%;color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;font-size:10px;overflow:hidden}
.dshsh-caret{display:block;z-index:1;animation:dshsh-blink 1.1s step-end infinite}
@keyframes dshsh-blink{0%,55%{opacity:.8}56%,100%{opacity:.15}}
@media (prefers-reduced-motion: reduce){.dshsh-caret{animation:none}}
/* 待确认态：实心红，明确"再点一次就真关了" */
.dshsh-btn.danger.armed{border-color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-inverted)}
.dshsh-btn.danger:hover:not(:disabled){border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger)}
.dshsh-btn.accent{background:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-border-inverted);color:var(--dsw-alias-label-primary-inverted)}
.dshsh-btn.accent:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);color:var(--dsw-alias-label-primary-inverted)}
.dshsh-btn.hot{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-button-ghost-active-fill)}

.dshsh-grip{color:var(--dsw-alias-label-tertiary);cursor:grab;display:inline-flex;align-items:center;
  padding:0 2px;flex:0 0 auto;letter-spacing:-1px;user-select:none}

.dshsh-name{display:inline-flex;align-items:center;gap:5px;max-width:280px;min-width:0;overflow:hidden;padding:2px 7px 2px 10px;
  border:1px solid transparent;border-radius:7px;background:transparent;cursor:pointer;flex:0 1 auto;
  color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;
  font-family:var(--ds-font-family-code);
  transition:background .12s ease,border-color .12s ease}
.dshsh-name:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l2)}
.dshsh-name-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 触发器两排（与下拉菜单行一致）：第一排 名字+创建者，第二排 稳定 id+尺寸 */
.dshsh-name-cell{display:flex;flex-direction:column;gap:1px;flex:1 1 auto;min-width:0;overflow:hidden}
/* 触发器里的单元格同受"可收缩 + 不换行"约束；创建者徽标收得更紧（给名字留位置） */
.dshsh-name .dshsh-cell{overflow:hidden}
.dshsh-name .dshsh-row-owner{max-width:46%}

.dshsh-name .dshsh-row-name,.dshsh-name .dshsh-row-id,.dshsh-name .dshsh-row-meta{min-width:0}
.dshsh-name-top{display:flex;align-items:center;gap:6px;min-width:0}
.dshsh-name-label{flex:0 1 auto;min-width:0;color:var(--dsw-alias-label-primary);font-weight:600;
  font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshsh-name-owner{flex:0 0 auto;max-width:55%;margin-left:auto;padding:0 5px;border-radius:999px;
  border:.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-tertiary);
  font-size:9.5px;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshsh-name-sub{display:flex;align-items:baseline;gap:6px;min-width:0;font-size:10px;
  color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}

.dshsh-count{font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;flex:0 0 auto}
.dshsh-spacer{flex:1 1 auto;display:flex;align-items:center;justify-content:center;min-width:0}
.dshsh-busybar{flex:0 0 auto;max-width:100%;padding:2px 10px;border-radius:999px;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-button-ghost-active-fill);border:.5px solid var(--dsw-alias-state-warn-primary)}
.dshsh-head{min-width:0}
.dshsh-name{min-width:0}
/* 宽度不足时先隐藏次要信息，保证按钮不会被挤出浮窗（真实 bug）。
   0.2.3：触发器改用共用的 .dshsh-row-* 之后，这里要跟着换选择器 —— 否则窄面板下
   创建者/副行不会被隐藏，头部按钮仍会被挤出（旧类名已不再渲染）。 */
.dshsh-compact .dshsh-grip,.dshsh-compact .dshsh-count,
.dshsh-compact .dshsh-sep,.dshsh-compact .dshsh-name-text,
.dshsh-compact .dshsh-name-owner,.dshsh-compact .dshsh-name-sub,
.dshsh-compact .dshsh-name .dshsh-row-owner,.dshsh-compact .dshsh-name .dshsh-row-sub{display:none}

.dshsh-info{position:absolute;top:38px;right:8px;z-index:41;width:min(676px,calc(100vw - 24px));
  max-height:calc(100% - 103px);height:auto;overflow:auto;overscroll-behavior:contain;padding:4px;
  border:0;border-radius:20px;background:var(--dsw-specific-menu);box-shadow:var(--dsw-elevation-prominent);
  --dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);
  font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-primary)}
/* 头部条吸顶：滚长列表时「复制/关闭」始终在手边 */
/* ── 折叠态胶囊 ───────────────────────────────────────────────────────────── */
.dshsh-pill{transition:background .12s ease,border-color .12s ease,transform .06s ease}
.dshsh-pill:hover{background:var(--dsw-alias-button-floating-hover)}
.dshsh-pill:active{transform:translateY(1px)}
.dshsh-pill:focus-visible{outline:2px solid var(--dsw-alias-border-l4);outline-offset:2px}
  /* 功能开关关闭时的右上角常驻提示（不挡设置页；面板关闭也保留） */
.dshsh-pill-dot{width:6px;height:6px;border-radius:50%;flex:0 0 auto;display:inline-block}
/* 有命令在跑时轻微脉冲，余光能注意到，但不打扰 */
.dshsh-pill.busy .dshsh-pill-dot{animation:dshsh-pulse 1.6s ease-in-out infinite}
@keyframes dshsh-pulse{0%,100%{opacity:1}50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){.dshsh-pill.busy .dshsh-pill-dot{animation:none}}
.dshsh-pill-mark{color:var(--dsw-alias-label-tertiary);letter-spacing:-.5px}
.dshsh-pill-name{color:var(--dsw-alias-label-primary);max-width:132px;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.dshsh-pill-lock{display:inline-flex;align-items:center;flex:0 0 auto}
/* 拖动提示：悬停才出现，免得常态多一个装饰 */
.dshsh-pill .dshsh-grip{opacity:0;transition:opacity .12s ease;margin-right:-2px}
.dshsh-pill:hover .dshsh-grip{opacity:.6}
.dshsh-info-bar{display:flex;align-items:center;gap:8px;padding:8px 10px 6px;margin:0 -4px 2px;
  border-bottom:.5px solid var(--dsw-alias-border-l2);position:sticky;top:0;z-index:2;
  background:var(--dsw-specific-menu)}
.dshsh-info-bar>t{flex:1 1 auto;font-size:12.5px;font-weight:600;letter-spacing:.01em}
/* 详情页折叠卡片（2026-09-22 整理后：10 组 → 6 卡）。标题行可点，展开/收起带箭头。 */
.dshsh-card{border:.5px solid var(--dsw-alias-border-l2);border-radius:14px;margin:2px 4px 6px;
  background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.dshsh-card.open{background:var(--dsw-alias-bg-layer-3)}
.dshsh-card-h{display:flex;align-items:center;gap:8px;width:100%;padding:9px 10px;
  border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;
  font-size:12.5px;font-weight:600;text-align:left;cursor:pointer}
.dshsh-card-h:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshsh-card-h:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dshsh-card-h svg{color:var(--dsw-alias-label-caption);flex:0 0 auto;transition:transform .12s ease}
.dshsh-card-name{flex:1 1 auto;min-width:0}
.dshsh-card-sub{flex:0 0 auto;color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:400;
  font-variant-numeric:tabular-nums}
.dshsh-card-body{padding:0 2px 6px}
/* 帮助页里可折叠的「生命周期」卡：summary 复用卡片标题行，去掉原生三角 */
.dshsh-lifecycle{margin:2px 4px 8px}
.dshsh-lifecycle>summary{list-style:none;cursor:pointer}
.dshsh-lifecycle>summary::-webkit-details-marker{display:none}
.dshsh-lifecycle>summary::before{content:'▸';color:var(--dsw-alias-label-tertiary);font-size:11px;margin-right:2px}
.dshsh-lifecycle[open]>summary::before{content:'▾'}
.dshsh-lifecycle .dshsh-card-body{padding:2px 10px 10px}
.dshsh-lc-row{display:flex;gap:8px;align-items:flex-start;margin:6px 0;font-size:11px;
  line-height:1.65;color:var(--dsw-alias-label-tertiary)}
.dshsh-lc-row>b{flex:0 0 68px;font-weight:600;color:var(--dsw-alias-label-secondary);letter-spacing:.02em;white-space:nowrap}
.dshsh-lc-row>span{flex:1 1 auto;min-width:0}
.dshsh-lifecycle .dshsh-info-group{margin-top:10px}
/* 风险横幅：最要紧的一条放在最上面，而不是埋进第 N 组 */
.dshsh-info-alert{display:flex;gap:7px;align-items:flex-start;margin:2px 4px 8px;padding:8px 10px;border-radius:10px;
  background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);font-size:11.5px;line-height:1.6}
.dshsh-info-alert b{color:var(--dsw-alias-state-error-primary)}
/* 总览页（2026-10-24）：详情层落地页 —— 状态头 + 关键事实 + 指标网格 + 快捷跳转。
   只复用现有设计令牌（bg-layer / border-l / label / state-*），不引入新配色体系。 */
.dshsh-ov{display:flex;flex-direction:column;gap:9px;padding:0 2px 6px}
.dshsh-ov-hero{position:relative;display:flex;align-items:flex-start;justify-content:space-between;gap:10px;
  padding:11px 13px 10px;border-radius:12px;overflow:hidden;border:.5px solid var(--dsw-alias-border-l3);
  background:linear-gradient(135deg,var(--dsw-alias-bg-layer-3),var(--dsw-alias-bg-layer-2) 72%)}
.dshsh-ov-hero::after{content:'';position:absolute;right:-34px;bottom:-64px;width:180px;height:180px;border-radius:50%;
  background:radial-gradient(circle,var(--dsw-alias-brand-primary),transparent 68%);opacity:.13;pointer-events:none}
.dshsh-ov-hero-l{display:flex;flex-direction:column;gap:5px;min-width:0;position:relative;z-index:1}
.dshsh-ov-eyebrow{font-size:9.5px;letter-spacing:.14em;color:var(--dsw-alias-label-tertiary);text-transform:uppercase}
.dshsh-ov-hero-t{display:flex;align-items:center;flex-wrap:wrap;gap:6px}
.dshsh-ov-hero-t b{font-size:15px;font-weight:600;letter-spacing:-.01em;color:var(--dsw-alias-label-primary)}
.dshsh-ov-chip{font-style:normal;font-size:10px;font-variant-numeric:tabular-nums;padding:1px 6px;border-radius:999px;
  color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-button-ghost-active-fill);
  border:.5px solid var(--dsw-alias-border-l3)}
.dshsh-ov-chip.dim{color:var(--dsw-alias-label-tertiary);background:transparent}
.dshsh-ov-hero-sub{margin:0;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);max-width:30em}
.dshsh-ov-pill{flex:none;position:relative;z-index:1;display:inline-flex;align-items:center;gap:5px;padding:3px 9px;
  border-radius:999px;font-size:10.5px;font-weight:600;border:.5px solid;white-space:nowrap;background:transparent}
.dshsh-ov-pill i{width:6px;height:6px;border-radius:50%;background:currentColor}
.dshsh-ov-pill.ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.dshsh-ov-pill.warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.dshsh-ov-facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}
.dshsh-ov-fact{display:flex;flex-direction:column;gap:1px;padding:6px 8px;border-radius:9px;min-width:0;
  border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}
.dshsh-ov-fact span{font-size:10px;color:var(--dsw-alias-label-tertiary)}
.dshsh-ov-fact b{font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-primary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshsh-ov-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(108px,1fr));gap:7px}
.dshsh-ov-card{display:flex;flex-direction:column;gap:2px;align-items:flex-start;padding:8px 9px;border-radius:10px;
  border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);cursor:pointer;
  font:inherit;color:inherit;text-align:left;transition:border-color .12s ease,background .12s ease,transform .12s ease}
.dshsh-ov-card:hover{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-3);transform:translateY(-1px)}
.dshsh-ov-card:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dshsh-ov-card.warn{border-color:var(--dsw-alias-state-warn-primary)}
.dshsh-ov-k{font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.dshsh-ov-v{font-size:17px;font-weight:600;line-height:1.15;color:var(--dsw-alias-label-primary);
  font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.dshsh-ov-s{font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.dshsh-ov-note{display:flex;gap:7px;align-items:flex-start;padding:7px 9px;border-radius:9px;font-size:10.5px;
  line-height:1.55;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover);
  border:.5px solid var(--dsw-alias-border-l2)}
.dshsh-ov-note>span:last-child{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.dshsh-ov-note.warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.dshsh-ov-jump{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding-top:2px}
.dshsh-ov-jump-l{font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.dshsh-ov-jump-b{font:inherit;font-size:11px;padding:3px 9px;border-radius:999px;cursor:pointer;
  color:var(--dsw-alias-label-secondary);background:transparent;border:.5px solid var(--dsw-alias-border-l3)}
.dshsh-ov-jump-b:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary);
  background:var(--dsw-alias-interactive-bg-hover)}
.dshsh-notice-list{display:flex;flex-direction:column;gap:4px}
.dshsh-notice-row{padding:5px 7px;border-radius:7px;border:.5px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-interactive-bg-hover)}
.dshsh-notice-row.lv-warn{border-color:var(--dsw-alias-state-warn-primary)}
.dshsh-notice-row.lv-error{border-color:var(--dsw-alias-state-error-primary)}
.dshsh-notice-hd{display:flex;align-items:center;gap:6px}
.dshsh-notice-lv{flex:0 0 auto;font-size:10.5px;padding:0 5px;border-radius:6px;
  border:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary)}
.dshsh-notice-row.lv-warn .dshsh-notice-lv{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.dshsh-notice-row.lv-error .dshsh-notice-lv{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dshsh-notice-b{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px}
.dshsh-notice-t{flex:0 0 auto;font-size:10.5px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dshsh-notice-d{margin-top:2px;font-size:10.5px;color:var(--dsw-alias-label-secondary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 小标题（分组名）与条目要明显区分（用户反馈区分度不够）：加粗 + 主题色 + 上方留白 + 细分隔线 */
/* 详情页「会话台账」表格容器（与分组标题同宽，稍留上下间距）。 */
.dshsh-info-ledger{margin:4px 0 10px;min-width:0}
.dshsh-info-group{font-weight:600;color:var(--dsw-alias-label-primary);letter-spacing:.3px;
  padding-top:6px;border-top:.5px solid var(--dsw-alias-border-l2);margin-top:2px}
.dshsh-info-group-old{display:flex;align-items:baseline;gap:6px;margin:8px -4px 2px;padding:5px 10px 3px;
  color:var(--dsw-alias-label-tertiary);font-size:11.5px;font-weight:500;line-height:18px}
.dshsh-info-group:first-of-type{margin-top:2px}
.dshsh-info-group>c{margin-left:auto;font-size:10.5px;color:var(--dsw-alias-label-tertiary);letter-spacing:0;text-transform:none;font-weight:400;font-variant-numeric:tabular-nums}
.dshsh-kv{display:flex;gap:10px;align-items:baseline;padding:3px 10px;border-radius:8px;cursor:default}
.dshsh-kv:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshsh-kv>k{flex:0 0 104px;color:var(--dsw-alias-label-tertiary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}
/* 值用等宽：路径、pid、版本号这类东西对齐了才好读 */
.dshsh-kv>v{flex:1 1 auto;min-width:0;font-family:var(--ds-font-family-code);
  font-size:11px;word-break:break-word;font-variant-numeric:tabular-nums}
.dshsh-kv>v.dim{color:var(--dsw-alias-label-tertiary)}
.dshsh-kv>v.warn{color:var(--dsw-alias-state-error-primary)}
.dshsh-kv>v.ok{color:var(--dsw-alias-state-success-primary)}
.dshsh-kv[data-copy]{cursor:pointer}
.dshsh-kv[data-copy]:hover>v{text-decoration:underline dotted;text-underline-offset:2px}
.dshsh-kv>v>i{font-style:normal;opacity:.55;margin-left:6px;font-size:10px}
.dshsh-badge{display:inline-flex;align-items:center;height:16px;padding:0 6px;border-radius:999px;
  border:.5px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);font-size:10px}
.dshsh-native{font-family:inherit;font-size:11px;color:inherit;background:transparent;border:0;padding:0;cursor:pointer;
  text-decoration:underline dotted;text-underline-offset:2px}
.dshsh-native:hover{color:var(--dsw-alias-label-primary)}
.dshsh-err{display:flex;gap:7px;align-items:flex-start;margin:0 10px 8px;padding:6px 8px;border-radius:7px;
  border-left:3px solid var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:1.5}
.dshsh-err span:last-child{overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
/* 「不是错误，但必须让你知道」—— 与 .dshsh-err 同款几何、中性配色：
   操作确实成功了（例如改名被净化改写），用红色报错是误导，用沉默则是静默改写。 */
/* ── 提示信息浮层（0.4.0）：右上角默认；右侧有菜单时移到左上角 ───────────────── */
.dshsh-toasts{position:absolute;right:10px;top:64px;z-index:70;display:flex;flex-direction:column;gap:6px;
  width:min(360px,72%);pointer-events:none}
.dshsh-toasts.at-left{right:auto;left:10px}
.dshsh-toast{position:relative;overflow:hidden;pointer-events:auto;padding:7px 10px 9px;border-radius:9px;
  border:.5px solid var(--dsw-alias-border-l3);box-shadow:var(--dsw-elevation-prominent);
  backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
  background-image:linear-gradient(var(--dsw-alias-bg-layer-1),var(--dsw-alias-bg-layer-1)),
    linear-gradient(var(--dsw-alias-bg-layer-1),var(--dsw-alias-bg-layer-1));
  animation:dshsh-toast-in .2s ease both, dshsh-toast-out 1s ease var(--dshsh-toast-ms, 6s) forwards}
.dshsh-toast:hover{animation-play-state:paused}
.dshsh-toast-hd{display:flex;align-items:center;gap:6px}
.dshsh-toast-dot{flex:0 0 auto;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-secondary)}
.dshsh-toast-brief{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:12px;color:var(--dsw-alias-label-primary)}
.dshsh-toast-time{flex:0 0 auto;font-size:10.5px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
/* 详细：不管多长都只占一行，超出省略（悬停看全文） */
.dshsh-toast-detail{margin-top:2px;font-size:11px;color:var(--dsw-alias-label-secondary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 三级配色：提示=灰 / 警告=黄 / 错误=红 */
.dshsh-toast.lv-warn{border-color:var(--dsw-alias-state-warn-primary)}
.dshsh-toast.lv-warn .dshsh-toast-dot{background:var(--dsw-alias-state-warn-primary)}
.dshsh-toast.lv-error{border-color:var(--dsw-alias-state-error-primary)}
.dshsh-toast.lv-error .dshsh-toast-dot{background:var(--dsw-alias-state-error-primary)}
/* 倒计时横条：宽度从 100% 走完即表示即将消失 */
.dshsh-toast-bar{position:absolute;left:0;bottom:0;height:2px;width:100%;display:block;
  background:var(--dsw-alias-label-tertiary);opacity:.5;transform-origin:left center;
  animation:dshsh-toast-bar 6s linear forwards}
.dshsh-toast:hover .dshsh-toast-bar{animation-play-state:paused}
@keyframes dshsh-toast-bar{from{transform:scaleX(1)}to{transform:scaleX(0)}}
@keyframes dshsh-toast-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
@keyframes dshsh-toast-out{from{opacity:1}to{opacity:0}}
/* 操作反馈浮层（用户反馈：原来贴在输入框下方，位置不好）——改成面板头部下方的浮动提示：
   不参与布局、不挤压任何内容，几秒后自动消失。 */
.dshsh-note{position:absolute;right:10px;top:36px;z-index:60;max-width:min(430px,72%);
  display:flex;gap:7px;align-items:flex-start;margin:0;padding:7px 10px;border-radius:8px;
  box-shadow:var(--dsw-elevation-prominent);backdrop-filter:var(--dsw-menu-backdrop-filter, blur(6px));-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter, blur(6px));
  background-image:linear-gradient(var(--dsw-alias-bg-layer-1),var(--dsw-alias-bg-layer-1)),
    linear-gradient(var(--dsw-alias-bg-layer-1),var(--dsw-alias-bg-layer-1));
  border:.5px solid var(--dsw-alias-border-l3);
  border-left:3px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-button-tool-bar-hover);
  color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.5}
.dshsh-note span:last-child{overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.dshsh-fmenu{position:relative;display:inline-block}/* 菜单表面（按钮 / 面板 / 子面板）**单一来源**：与宿主 MenuSurface 同一 token 与模糊，
   三者外观必然一致；改这里即三处同时生效。 */
.dshsh-fmenu-btn,.dshsh-fmenu-panel,.dshsh-fmenu-sub{/* 菜单表面：宿主的半透明填充 **叠在不透明底色上** —— 每层自己就足够不透明，因此面板与子面板无论浮在什么之上，观感完全一致（此前只给半透明填充，面板浮在页面、子面板浮在面板上，叠出的颜色自然不同）。 */background-image:linear-gradient(var(--dsw-menu-surface-fill, var(--dsw-alias-bg-layer-2)),var(--dsw-menu-surface-fill, var(--dsw-alias-bg-layer-2))),linear-gradient(var(--dsw-alias-bg-base, var(--dsw-alias-bg-layer-1)),var(--dsw-alias-bg-base, var(--dsw-alias-bg-layer-1)));background-color:var(--dsw-alias-bg-base, var(--dsw-alias-bg-layer-1));backdrop-filter:var(--dsw-menu-backdrop-filter, blur(10px));-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter, blur(10px))}
.dshsh-fmenu-btn{display:inline-flex;align-items:center;height:26px;padding:0 9px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l4);color:inherit;font-size:11px;line-height:1;cursor:pointer;white-space:nowrap}.dshsh-fmenu-panel{isolation:isolate;display:none;position:absolute;top:100%;left:0;z-index:60;min-width:154px;margin-top:3px;padding:4px;border-radius:10px;border:.5px solid var(--dsw-alias-border-l4);box-shadow:var(--dsw-elevation-prominent)}/* 展开只由点击态 .open 驱动（曾同时有 :hover 规则 => 悬浮展开 + 点击展开会同时生效 => 面板重叠） */
.dshsh-fmenu.open .dshsh-fmenu-panel{display:block}.dshsh-fmenu-item{position:relative;display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:7px;font-size:11px;cursor:default;white-space:nowrap}.dshsh-fmenu-item:hover{background:var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-3))}.dshsh-fmenu-item.on .dshsh-fmenu-l{font-weight:600}.dshsh-fmenu-l{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis}.dshsh-fmenu-a{opacity:.55}.dshsh-fmenu-sub{display:none;position:absolute;left:100%;top:-4px;z-index:61;min-width:132px;max-height:260px;overflow-y:auto;overflow-x:hidden;padding:4px;border-radius:10px;border:.5px solid var(--dsw-alias-border-l4);box-shadow:var(--dsw-elevation-prominent)}/* 子面板同理：只由行上的 .open 驱动（悬停只作视觉高亮，不再展开） */
.dshsh-fmenu-item.open .dshsh-fmenu-sub{display:block}/* box-sizing 必须有：width:100% + 左右 padding 若不 border-box ⇒ 每项宽出 16px ⇒ 子面板溢出 ⇒ 横向滚动条。 */
.dshsh-fmenu-opt{display:block;box-sizing:border-box;width:100%;text-align:left;height:24px;padding:0 8px;border:0;border-radius:6px;background:transparent;color:inherit;font-size:11px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.dshsh-fmenu-opt:hover{background:var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-3))}.dshsh-fmenu-opt.on{font-weight:600}.dshsh-cmenu{position:absolute;top:38px;right:8px;z-index:42;width:min(676px,calc(100vw - 24px));
  overflow:hidden;overscroll-behavior:contain;padding:4px;
  display:flex;flex-direction:column;
  border:0;border-radius:20px;background-image:linear-gradient(var(--dsw-specific-menu),var(--dsw-specific-menu)),linear-gradient(var(--dsw-specific-menu),var(--dsw-specific-menu)),linear-gradient(var(--dsw-specific-menu),var(--dsw-specific-menu));backdrop-filter:var(--dsw-menu-backdrop-filter, blur(6px));-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter, blur(6px));box-shadow:var(--dsw-elevation-prominent);
  --dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);
  font-size:12px;color:var(--dsw-alias-label-primary)}
.dshsh-cmenu-h{margin:6px -4px 1px;padding:6px 10px 3px;
  background:var(--dsw-specific-menu);font-size:11.5px;font-weight:500;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dshsh-cmenu-h:first-child{margin-top:2px}
/* 分段选择：整组一个平台色底槽，选中项浮起（DSH 分段的做法） */
.dshsh-cmenu-seg{display:flex;align-items:center;gap:2px;margin:0 6px 8px;padding:3px;
  border-radius:12px;background:var(--dsw-alias-bg-module-platform)}
.dshsh-cmenu-seg-btn{flex:1 1 0;min-width:0;height:28px;border:0;border-radius:9px;
  background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;
  line-height:1;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  transition:background .12s ease,color .12s ease}
.dshsh-cmenu-seg-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshsh-cmenu-seg-btn.on{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);
  box-shadow:var(--dsw-elevation-soft);font-weight:600}
.dshsh-cmenu-row{display:flex;align-items:center;gap:8px;margin:0 6px;padding:7px 2px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dshsh-cmenu-row:last-child{border-bottom:0}
.dshsh-cmenu-row>span:first-child{flex:1 1 auto;font-size:12.5px}
.dshsh-cmenu-in{width:76px;height:28px;padding:0 9px;border:.5px solid var(--dsw-alias-border-l4);
  border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);
  font:inherit;font-size:12px;font-family:var(--ds-font-family-code)}
.dshsh-cmenu-in:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.dshsh-cmenu-sub{font-size:11px;color:var(--dsw-alias-label-tertiary)}
 .dshsh-cmenu-sub.warn{color:var(--dsw-alias-state-warn-primary)}
 /* 0.3.4 日志管理：排序工具条 + 详情面板（上半列表下半详情） */
 .dshsh-log-tool{display:flex;align-items:center;gap:4px;margin:0 6px 6px;padding:4px 6px;
   border-radius:10px;background:var(--dsw-alias-button-ghost-active-fill)}
 .dshsh-log-tool .dshsh-cmenu-tab{flex:0 0 auto;padding:4px 8px;font-size:11px}
 .dshsh-log-detail{margin:0 6px 6px;padding:8px 10px;border-radius:10px;
   background:var(--dsw-alias-button-ghost-active-fill);max-height:150px;overflow:auto}
 .dshsh-log-line{font-size:10.5px;color:var(--dsw-alias-label-secondary);
   font-family:var(--ds-font-family-code);line-height:1.5;overflow-wrap:anywhere;
   white-space:pre-wrap;word-break:break-all}
/* 应用 / 全部撤销：主按钮与危险幽灵按钮（同 DSH settings 的 primary/danger 形状） */
.dshsh-cmenu-actions{display:flex;align-items:center;justify-content:flex-start;gap:6px;
  margin:0 6px 6px;padding-top:6px;border-top:.5px solid var(--dsw-alias-border-l2)}
.dshsh-cmenu-go{height:30px;padding:0 16px;border:0;border-radius:15px;
  background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);
  font:inherit;font-size:12.5px;font-weight:500;cursor:pointer;display:inline-flex;align-items:center;gap:4px}
.dshsh-cmenu-go:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dshsh-cmenu-clear{height:30px;padding:0 12px;border:0;border-radius:15px;background:transparent;
  color:var(--dsw-alias-state-error-primary);font:inherit;font-size:12.5px;cursor:pointer;
  display:inline-flex;align-items:center;gap:4px}
.dshsh-cmenu-clear:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}

.dshsh-cmenu-list{margin:0 2px}
/* 授权浮层重做（0.2.3）：标题条 + 状态徽标 + 页签 + 后果卡片 + 复核句 */
.dshsh-cmenu-bar{display:flex;align-items:center;gap:8px;padding:2px 2px 6px}
.dshsh-cmenu-title{flex:1 1 auto;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dshsh-cmenu-chip{flex:0 0 auto;max-width:60%;padding:1px 8px;border-radius:999px;font-size:10.5px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:.5px solid var(--dsw-alias-border-l4);
  color:var(--dsw-alias-label-tertiary)}
.dshsh-cmenu-chip.on{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-button-ghost-active-fill)}
.dshsh-cmenu-chip.warn{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.dshsh-cmenu-tabsbar{position:sticky;top:0;z-index:3;margin:0 -4px 8px;padding:6px 6px 4px;
  background:var(--dsw-specific-menu);border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dshsh-cmenu-tabs{display:flex;gap:4px;padding:2px;border-radius:10px;background:var(--dsw-alias-button-ghost-active-fill)}
.dshsh-cmenu-tab{flex:1 1 0;min-width:0;padding:5px 2px;border:0;border-radius:8px;background:transparent;
  color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshsh-cmenu-tab.on{background:var(--dsw-special-fill-primary-fg);color:var(--dsw-label-color));
  background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted)}
.dshsh-cmenu-body{display:flex;flex-direction:column;gap:6px}
.dshsh-opt{display:flex;align-items:center;gap:10px;width:100%;padding:8px 8px;border:0;
  border-bottom:.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);
  font:inherit;text-align:left;cursor:pointer}
.dshsh-opt:last-child{border-bottom:0}
.dshsh-opt:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dshsh-opt-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px}
.dshsh-opt-label{font-size:12.5px;font-weight:600}
.dshsh-opt.on .dshsh-opt-label{color:var(--dsw-alias-brand-primary)}
.dshsh-opt-hint{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.45}
.dshsh-opt-radio{flex:0 0 auto;width:15px;height:15px;border-radius:50%;
  border:1.5px solid var(--dsw-alias-border-l4);display:flex;align-items:center;justify-content:center}
.dshsh-opt.on .dshsh-opt-radio{border-color:var(--dsw-alias-brand-primary)}
.dshsh-opt.on .dshsh-opt-radio::after{content:'';width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-brand-primary)}
.dshsh-cmenu-review{margin:2px 6px 0;padding:6px 10px;border-radius:8px;font-size:11.5px;
  background:var(--dsw-alias-button-ghost-active-fill);color:var(--dsw-alias-label-secondary);
  font-variant-numeric:tabular-nums}

/* 按对话授权：搜索 + 候选列表 + 选中后的档位/有效期（沿用 DSH 菜单项观感） */
.dshsh-actors{margin:0 6px}
.dshsh-actor-list{display:flex;flex-direction:column;gap:2px}
.dshsh-actor-item{display:flex;align-items:center;gap:6px;min-width:0;min-height:30px;padding:3px 8px;
  border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);
  font:inherit;font-size:12px;text-align:left;cursor:pointer}
.dshsh-actor-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshsh-actor-item.granted{color:var(--dsw-alias-state-success-primary)}
.dshsh-actor-item.granted::before{content:'';width:6px;height:6px;border-radius:50%;flex:0 0 auto;
  background:var(--dsw-alias-state-success-primary)}
.dshsh-actor-item.on{background:var(--dsw-alias-interactive-bg-active)}
.dshsh-actor-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshsh-actor-when{flex:0 0 auto;font-size:10px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dshsh-actor-id{flex:0 0 auto;color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code);font-size:10.5px}
.dshsh-actor-tag{flex:0 0 auto;padding:0 6px;border-radius:999px;font-size:10px;
  border:.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-tertiary)}
.dshsh-actor-tag.ok{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.dshsh-actor-pick{margin:6px 0 2px;padding-top:6px;border-top:.5px solid var(--dsw-alias-border-l2)}
.dshsh-cmenu-item{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:10px;
  min-height:36px}
.dshsh-cmenu-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshsh-cmenu-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-family:var(--ds-font-family-code);font-size:11.5px}
.dshsh-stable{width:100%;border-collapse:collapse;font-size:11.5px;table-layout:fixed}
.dshsh-stable th{text-align:left;font-weight:600;color:var(--dsw-alias-label-tertiary);padding:2px 6px;
  border-bottom:.5px solid var(--dsw-alias-border-l4)}
.dshsh-stable td{padding:4px 6px;border-bottom:.5px solid var(--dsw-alias-border-l2);vertical-align:top;
  overflow-wrap:anywhere;color:var(--dsw-alias-label-primary)}
.dshsh-stable tr:last-child td{border-bottom:0}
.dshsh-stable .k{font-weight:600}
.dshsh-stable .sub{color:var(--dsw-alias-label-tertiary);font-size:10.5px}
.dshsh-cmenu-badge{flex:0 0 auto;padding:1px 7px;border-radius:999px;font-size:10px;
  border:.5px solid var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary);
  background:var(--dsw-alias-state-success-tertiary)}
.dshsh-picker{position:absolute;top:38px;left:10px;z-index:40;width:min(416px,calc(100vw - 24px));
  max-height:320px;overflow:auto;padding:4px;border:0;border-radius:20px;
  background-image:linear-gradient(var(--dsw-specific-menu),var(--dsw-specific-menu)),linear-gradient(var(--dsw-specific-menu),var(--dsw-specific-menu)),linear-gradient(var(--dsw-specific-menu),var(--dsw-specific-menu));backdrop-filter:var(--dsw-menu-backdrop-filter, blur(6px));-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter, blur(6px));box-shadow:var(--dsw-elevation-prominent);
  --dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}
.dshsh-row{display:flex;align-items:center;gap:4px;border-radius:10px}
.dshsh-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshsh-row.current{background:var(--dsw-alias-interactive-bg-active)}
.dshsh-item{display:flex;align-items:center;gap:8px;flex:1 1 auto;min-width:0;padding:6px 4px 6px 8px;
  border:0;border-radius:10px;background:transparent;color:var(--dsw-alias-label-primary);
  font:inherit;font-size:12px;font-family:var(--ds-font-family-code);
  text-align:left;cursor:pointer}
.dshsh-item span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 下拉一行两排：第一排「名字 + 创建者」、第二排「id + 尺寸/前台/字节」。
   覆盖上面的 .dshsh-item span 通用截断规则（cell 自身需要换行排列、不截断） */
.dshsh-item .dshsh-cell,.dshsh-name .dshsh-cell{display:flex;flex-direction:column;gap:2px;flex:1 1 auto;min-width:0;
  white-space:normal;overflow:visible}
.dshsh-item .dshsh-row-top,.dshsh-name .dshsh-row-top{display:flex;align-items:center;gap:6px;min-width:0}
.dshsh-row-name{flex:0 1 auto;min-width:0;color:var(--dsw-alias-label-primary);
  font-weight:600;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* 创建者：**永不换行**，过长就省略号截断（完整名字在 title 悬停提示里）。
   早先这里没有 nowrap/ellipsis —— 在触发器里没有 .dshsh-item 那条截断规则兜底，
   长会话标题会把标题栏撑宽/撑成两行（用户反馈）。 */
.dshsh-row-owner{flex:0 1 auto;min-width:0;max-width:55%;margin-left:auto;padding:0 5px;
  border-radius:999px;border:.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-tertiary);
  font-size:10px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshsh-item .dshsh-row-sub,.dshsh-name .dshsh-row-sub{display:flex;align-items:baseline;gap:8px;min-width:0;font-size:10.5px;
  color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;
  /* 0.3.4：第二行整行禁止换行 —— 内容超宽时交给 meta 的省略号，绝不撑成三排 */
  white-space:nowrap;overflow:hidden}
.dshsh-row-id{flex:0 0 auto;color:var(--dsw-alias-label-secondary)}
.dshsh-row-meta{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshsh-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto}
/* 通知 A：刚跑完（busy→idle）时闪几下，3 秒后自动停（类名由面板摘掉） */
.dshsh-dot.done{animation:dshsh-flash .45s ease-in-out 4}
@keyframes dshsh-flash{0%{box-shadow:0 0 0 0 currentColor;opacity:1}60%{box-shadow:0 0 0 5px transparent;opacity:.55}100%{box-shadow:0 0 0 0 transparent;opacity:1}}
@media (prefers-reduced-motion:reduce){.dshsh-dot.done{animation:none}}
/* 行操作菜单：窄版浮层（它不是整页面板，只是"一行的小菜单"） */
/* 复合选择器提高优先级：单类写法会被后面同优先级的 .dshsh-u-sheet 覆盖（实测 549px） */
.dshsh-batch-form{display:flex;align-items:center;gap:6px;flex:1 1 100%;margin-top:4px}
.dshsh-consent-sizein{width:52px;height:22px;padding:0 4px;border-radius:6px;font:inherit;font-size:11.5px;
  border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}
.dshsh-consent-sizedim{font-size:11px;color:var(--dsw-alias-label-tertiary)}
/* 已勾选的行：明显底色 + 左侧强调条（多选是主要交互，勾选必须有反馈） */
.dshsh-row.sel{background:var(--dsw-alias-interactive-bg-active);
  box-shadow:inset 2px 0 0 0 var(--dsw-alias-label-primary)}
.dshsh-row-x{opacity:0;margin-right:3px;width:22px;height:22px;transition:opacity .12s ease}
.dshsh-row:hover .dshsh-row-x{opacity:1}
.dshsh-new{display:flex;align-items:center;gap:7px;width:100%;margin-top:4px;padding:6px 8px;
  border:1px dashed var(--dsw-alias-border-l2);border-radius:7px;background:transparent;
  color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;
  transition:background .12s ease,color .12s ease,border-color .12s ease}
.dshsh-new:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-primary)}
.dshsh-stat-btn{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 11px;border-radius:8px;
  border:.5px solid var(--dsw-alias-border-l2);background:transparent;
  color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;
  transition:background .12s ease,color .12s ease,border-color .12s ease}
.dshsh-stat-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshsh-stat-btn:disabled{opacity:.35;cursor:not-allowed}
.dshsh-stat-btn.go{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-button-ghost-active-fill)}
.dshsh-picker::-webkit-scrollbar,.dshsh-screen::-webkit-scrollbar{width:9px;height:9px}
.dshsh-picker::-webkit-scrollbar-thumb,.dshsh-screen::-webkit-scrollbar-thumb{
  background:var(--dsw-alias-label-tertiary);opacity:.45;border-radius:9px}
.dshsh-picker::-webkit-scrollbar-thumb:hover,.dshsh-screen::-webkit-scrollbar-thumb:hover{
  background:var(--dsw-alias-label-tertiary);opacity:.8}

/* 八向缩放手柄：贴边而略微外扩，鼠标容易抓 */
.dshsh-rs{position:absolute;z-index:20;touch-action:none}
.dshsh-rs-n{top:-3px;left:12px;right:12px;height:7px;cursor:ns-resize}
.dshsh-rs-s{bottom:-3px;left:12px;right:12px;height:7px;cursor:ns-resize}
.dshsh-rs-w{left:-3px;top:12px;bottom:12px;width:7px;cursor:ew-resize}
.dshsh-rs-e{right:-3px;top:12px;bottom:12px;width:7px;cursor:ew-resize}
.dshsh-rs-nw{top:-3px;left:-3px;width:14px;height:14px;cursor:nwse-resize}
.dshsh-rs-ne{top:-3px;right:-3px;width:14px;height:14px;cursor:nesw-resize}
.dshsh-rs-sw{bottom:-3px;left:-3px;width:14px;height:14px;cursor:nesw-resize}
.dshsh-rs-se{bottom:-3px;right:-3px;width:15px;height:15px;cursor:nwse-resize}
/* 右下角画一个小斜线作为「可缩放」的视觉提示 */
.dshsh-rs-se::after{content:'';position:absolute;right:4px;bottom:4px;width:7px;height:7px;
  border-right:2px solid var(--dsw-alias-label-tertiary);
  border-bottom:2px solid var(--dsw-alias-label-tertiary);
  border-radius:0 0 2px 0;opacity:.75}

.dshsh-rename{display:flex;align-items:center;gap:5px;flex:1 1 auto;min-width:0;padding:3px 6px}
.dshsh-rename input{flex:1 1 auto;min-width:0;height:24px;padding:0 7px;border-radius:6px;
  border:1px solid var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary);
  font:inherit;font-size:12px;font-family:var(--ds-font-family-code);outline:none}
/* ══ 0.3.4 UI 组件库：统一视觉（方案 A）══
   原则：一套尺寸/圆角/间距/主次/危险色；浮层共用一个壳；列表/键值/徽标统一形状。
   迁移过渡期与旧类并存（dshsh-u-* 新类），接口只认组件，不认具体类。 */
.dshsh-u-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;
  width:31px;height:31px;padding:0;border-radius:8px;font-size:12px;line-height:1;
  border:1px solid transparent;background:var(--dsw-alias-button-tool-bar-fill);
  color:var(--dsw-alias-label-secondary);cursor:pointer;transition:filter .12s,background .12s,transform .05s}
.dshsh-u-btn.text{width:auto;padding:0 10px}
.dshsh-u-btn:hover:not(:disabled){background:var(--dsw-alias-button-tool-bar-hover);color:var(--dsw-alias-label-primary)}
.dshsh-u-btn:active:not(:disabled){transform:translateY(1px)}
.dshsh-u-btn:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:1px}
.dshsh-u-btn:disabled{opacity:.35;cursor:not-allowed}
.dshsh-u-btn.primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-button-primary-hover)}
.dshsh-u-btn.primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);color:var(--dsw-alias-button-primary-dimmed)}
.dshsh-u-btn.danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-secondary)}
.dshsh-u-btn.danger:hover:not(:disabled){background:var(--dsw-alias-state-error-secondary);color:var(--dsw-alias-label-primary)}
.dshsh-u-btn.warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-secondary)}
.dshsh-u-btn.warn:hover:not(:disabled){background:var(--dsw-alias-state-warn-secondary);color:var(--dsw-alias-label-primary)}
.dshsh-u-btn.tool{width:31px;padding:0}
.dshsh-u-btn.on{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary);
  background:var(--dsw-alias-button-ghost-active-fill)}
.dshsh-u-btn.locked{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary);
  background:var(--dsw-alias-button-ghost-active-fill)}
/* 浮层壳：**下拉菜单样式**（用户指定：保持之前 dshsh-cmenu 的观感，不要大卡片）。
   结构组件化（bar/tabs/body 由组件产出），视觉与旧下拉菜单一致：absolute 靠右、
   525px 宽、圆角 20、--dsw-specific-menu 背景、elevation 阴影。 */
.dshsh-u-sheet{position:absolute;top:38px;right:8px;z-index:42;width:min(541px,calc(100vw - 24px));
  overflow:hidden;overscroll-behavior:contain;padding:4px;
  --dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);
  border:0;border-radius:20px;background-image:linear-gradient(color-mix(in srgb, var(--dsw-specific-menu) var(--dshsh-menu-opacity, 70%), transparent),color-mix(in srgb, var(--dsw-specific-menu) var(--dshsh-menu-opacity, 70%), transparent)),linear-gradient(color-mix(in srgb, var(--dsw-specific-menu) var(--dshsh-menu-opacity, 70%), transparent),color-mix(in srgb, var(--dsw-specific-menu) var(--dshsh-menu-opacity, 70%), transparent)),linear-gradient(color-mix(in srgb, var(--dsw-specific-menu) var(--dshsh-menu-opacity, 70%), transparent),color-mix(in srgb, var(--dsw-specific-menu) var(--dshsh-menu-opacity, 70%), transparent));backdrop-filter:var(--dsw-menu-backdrop-filter, blur(6px));-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter, blur(6px));box-shadow:var(--dsw-elevation-prominent);
  font-size:12px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column}
.dshsh-u-sheet-left{left:10px;right:auto;width:min(442px,calc(100vw - 24px))}   /* 会话选择：贴左且更窄（内容是名字+id，不需要 520） */

.dshsh-u-sheet-half{width:min(470px,calc(100vw - 24px))}   /* 半宽弹层 */
.dshsh-u-sheet-detail{width:min(541px,calc(100vw - 24px))}   /* 详情：与其它页面同宽级别，容纳更多列 */
.dshsh-u-sheet-bar{display:flex;align-items:center;gap:8px;padding:6px 8px 6px}
.dshsh-u-sheet-title{flex:1 1 auto;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dshsh-u-sheet-actions{display:inline-flex;align-items:center;gap:6px}
.dshsh-u-sheet-body{display:flex;flex-direction:column;gap:6px;padding:0 4px 4px;flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain}
.dshsh-u-sheet-body.noscroll{overflow:visible}
.dshsh-u-sheet-body::-webkit-scrollbar{width:9px;height:9px}
.dshsh-u-sheet-body::-webkit-scrollbar-thumb{background:var(--dsw-alias-label-tertiary);opacity:.45;border-radius:9px}
.dshsh-u-sheet-body::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-label-tertiary);opacity:.8}
/* ⚠ flex column 里的直接子项默认 flex-shrink:1 —— 内容超高时会被「压扁」而不是溢出滚动
   （详情页卡片被挤成一团、滚不动就是这个原因）。子项一律不许收缩，超出交给滚动。 */
.dshsh-u-sheet-body > *{flex-shrink:0}
.dshsh-cmenu-body > *{flex-shrink:0}
/* 页签：内联小药丸（不独占一行、不带下划线 —— 与旧 cmenu-tabs 观感一致） */
/* 详情页第二行（大层下的小标签）：同一视觉语言，仅更矮更轻。 */
/* 二级页签：下划线形态（详细覆盖见下方 .dshsh-u-tabs.dshsh-u-tabs2） */
/* ── 软键盘（2026-10）：全尺寸键面 + 粘滞修饰键；配色全部走已存在的语义令牌 ── */
/* 独立浮动窗（用户要求）：position:fixed ⇒ 不受面板布局约束，可任意拖动/改大小；
   左右上下位置与宽高由内联 style 下发（localStorage 持久化），把手复用 .dshsh-rs。 */
/* 默认状态 = **自适应**（用户实测反馈）：宽度跟视口、高度跟内容、最高 78vh、位置居中偏下。
   用户一旦手动拖动/缩放，内联 px 会覆盖这里的 left/top/width/height（并显式清掉 transform/bottom）；
   点「复位」或双击右下角 ⇒ 回到这一条（即"最合适大小"）。 */
.dshsh-sk{position:fixed;z-index:60;left:50%;bottom:132px;transform:translateX(-50%);
  display:flex;flex-direction:column;box-sizing:border-box;
  width:min(1180px,94vw);max-height:84vh;
  padding:8px 10px 10px;border-radius:10px;
  border:1px solid var(--dsw-alias-border-l2);background-color:var(--dsw-alias-bg-base);
  font-size:12px;color:var(--dsw-alias-label-primary)}
.dshsh-sk-grip{cursor:move;touch-action:none;user-select:none}
.dshsh-sk-head{display:flex;align-items:center;gap:8px;margin:0 2px 6px}
.dshsh-sk-title{font-weight:600;white-space:nowrap}
.dshsh-sk-preview{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-secondary);font-size:11px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 键面容器：flex 纵向伸展，区块自己滚动（小窗不出界） */
.dshsh-sk-body{flex:1 1 auto;min-height:0;display:flex;min-width:0}
/* 四区块并排；min-height:100% + 各块 height:100% 才能给下面的 1fr 行"分配空间"——
   否则 1fr 无空间可分，行高恒定 ⇒ 纵向不随浮窗变化（用户实测反馈）。 */
.dshsh-sk-blocks{flex:1 1 auto;display:flex;gap:8px;align-items:stretch;min-width:0;
  min-height:100%;overflow:auto}
.dshsh-sk-block{display:grid;height:100%;gap:4px;min-width:0;
  grid-template-columns:repeat(var(--sk-cols,12),1fr);
  grid-auto-rows:minmax(26px,1fr)}
.dshsh-sk-block.main{flex:15 1 0}
.dshsh-sk-block.nav{flex:3 1 0}
.dshsh-sk-block.pad{flex:4 1 0}
.dshsh-sk-block.media{flex:1 1 0}
/* 键：宽高都填满所在单元格 ⇒ 横向随列宽、纵向随行高 */
.dshsh-sk-key{min-width:0;min-height:0;height:100%;width:100%;padding:0 2px;border-radius:6px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l2);background-color:var(--dsw-alias-bg-layer-2);
  color:inherit;line-height:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:clamp(9px,1.05vw,12px)}
.dshsh-sk-key:hover:enabled{background-color:var(--dsw-alias-bg-layer-3)}
.dshsh-follow{font-size:11px;color:var(--dsw-alias-label-secondary);opacity:.85;white-space:nowrap}
.dshsh-hintbar{display:flex;align-items:center;gap:8px;font-size:11px;line-height:1.4;padding:3px 8px;
  margin:2px 6px;border-radius:6px;background-color:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.dshsh-hintbar-x{margin-left:auto;font-size:11px;padding:1px 6px;cursor:pointer;border-radius:4px}
.dshsh-boundary{margin:6px;padding:10px 12px;border-radius:8px;font-size:12px;line-height:1.5;
  border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary);
  background-color:var(--dsw-alias-bg-layer-2)}
.dshsh-boundary-title{font-weight:600;margin-bottom:6px}
.dshsh-boundary-msg{margin:0 0 8px;max-height:120px;overflow:auto;white-space:pre-wrap;word-break:break-all;
  color:var(--dsw-alias-label-secondary);font-size:11px}
.dshsh-sk-fail{padding:10px 12px;font-size:12px;line-height:1.5;max-width:480px}
.dshsh-sk-key.mod{font-weight:600}
.dshsh-sk-key.on{border-color:var(--dsw-alias-label-primary);background-color:var(--dsw-alias-bg-layer-3)}
.dshsh-sk-key:disabled{opacity:.36;cursor:not-allowed}
.dshsh-sk-head{display:flex;align-items:center;gap:8px;margin:0 2px 6px}
.dshsh-sk-title{font-weight:600;white-space:nowrap}
.dshsh-sk-preview{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-secondary);font-size:11px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshsh-sk-key{min-width:0;min-height:0;height:100%;width:100%;padding:0 2px;border-radius:6px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l2);background-color:var(--dsw-alias-bg-layer-2);
  color:inherit;line-height:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:clamp(9px,1.05vw,12px)}
.dshsh-sk-key:hover:enabled{background-color:var(--dsw-alias-bg-layer-3)}


.dshsh-sk-key.on{border-color:var(--dsw-alias-label-primary);background-color:var(--dsw-alias-bg-layer-3)}
.dshsh-sk-key:disabled{opacity:.36;cursor:not-allowed}
.dshsh-btn.on{border-color:var(--dsw-alias-label-primary)}
/* 页签层级（2026-10-24 重做，用户要求：一级/二级/三级必须一眼区分）：
   一级 .dshsh-u-tabs  = 分段控件：外轨道 + 选中实底（视觉最重，如 状态/记录/帮助、秘密域/宏命令）
   二级 .dshsh-u-tabs2 = 下划线页签：无底无框，选中项底部绿线（如 总览/概览、键值对/引用组）
   三级 .dshsh-u-tabs3 = 纯文字 chip：最小最轻（如 审计文件/输出留痕） */
.dshsh-u-tabs{display:flex;gap:2px;padding:3px;margin:0 8px 8px;flex-wrap:wrap;
  background:var(--dsw-alias-bg-layer-1);border-radius:10px;border:.5px solid var(--dsw-alias-border-l2)}
.dshsh-u-tab{padding:4px 10px;border-radius:7px;font-size:12px;color:var(--dsw-alias-label-secondary);
  background:var(--dsw-alias-interactive-bg-hover);border:1px solid var(--dsw-alias-border-l3);cursor:pointer;
  transition:color .12s,background-color .12s,border-color .12s}
.dshsh-u-tab:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l4)}
.dshsh-u-tab.on{color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-button-ghost-active-fill);
  border-color:var(--dsw-alias-state-success-primary);font-weight:600;
  box-shadow:inset 0 0 0 1px var(--dsw-alias-state-success-primary)}
/* 二级：下划线（覆盖一级的轨道/实底/圆角） */
.dshsh-u-tabs.dshsh-u-tabs2{display:flex;flex-wrap:wrap;gap:2px;padding:0 8px;margin:0 0 8px;
  background:transparent;border:0;border-radius:0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dshsh-u-tabs2 .dshsh-u-tab{padding:4px 9px 6px;border-radius:0;border:0;border-bottom:2px solid transparent;
  background:transparent;font-size:11.5px;color:var(--dsw-alias-label-tertiary);margin-bottom:-1px;cursor:pointer}
.dshsh-u-tabs2 .dshsh-u-tab:hover{color:var(--dsw-alias-label-primary);background:transparent;border-bottom-color:var(--dsw-alias-border-l4)}
.dshsh-u-tabs2 .dshsh-u-tab.on{color:var(--dsw-alias-state-success-primary);background:transparent;
  border-bottom:2px solid var(--dsw-alias-state-success-primary);box-shadow:none;font-weight:600}
/* 三级：纯文字 chip（最轻） */
.dshsh-u-tabs.dshsh-u-tabs3{display:flex;flex-wrap:wrap;gap:2px;padding:0;margin:0 0 8px;background:transparent;border:0;align-items:center}
.dshsh-u-tabs3 .dshsh-u-tab{padding:4px 9px;border:0;border-radius:6px;background:transparent;font-size:11px;line-height:1.2;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dshsh-u-tabs3 .dshsh-u-tab:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshsh-u-tabs3 .dshsh-u-tab.on{background:var(--dsw-alias-button-ghost-active-fill);border:0;color:var(--dsw-alias-label-primary);box-shadow:none;font-weight:600}
/* 列表行 */
.dshsh-u-row{display:flex;align-items:center;gap:8px;padding:7px 9px;border-radius:9px;
  background:var(--dsw-alias-button-ghost-active-fill);cursor:default}
.dshsh-u-row.clickable{cursor:pointer}
.dshsh-u-row.clickable:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshsh-u-row.on{border:1px solid var(--dsw-alias-state-success-primary)}
.dshsh-u-row-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-family:var(--ds-font-family-code);font-size:11.5px;color:var(--dsw-alias-label-primary)}
.dshsh-u-row-sub{font-size:10.5px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.dshsh-u-row-id{font-size:10px;color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code)}
.dshsh-u-row-trailing{display:inline-flex;align-items:center;gap:4px}
/* 键值行 */
.dshsh-u-kv{display:flex;align-items:baseline;gap:8px;padding:3px 2px;font-size:11.5px}
.dshsh-u-kv-k{flex:0 0 88px;color:var(--dsw-alias-label-tertiary)}
.dshsh-u-kv-v{flex:1 1 auto;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
/* 小节标题 */
.dshsh-u-section{display:flex;align-items:center;gap:6px;padding:8px 2px 4px;font-size:11px;
  color:var(--dsw-alias-label-tertiary);text-transform:uppercase;letter-spacing:.4px}
.dshsh-u-section-count{font-size:10px;padding:1px 6px;border-radius:8px;background:var(--dsw-alias-button-ghost-active-fill);
  color:var(--dsw-alias-label-secondary)}
.dshsh-u-section-sub{margin-left:auto;text-transform:none;letter-spacing:0}
/* 状态徽标 */
.dshsh-u-badge{display:inline-flex;align-items:center;gap:4px;height:19px;padding:0 8px;border-radius:10px;
  font-size:10.5px;line-height:1;background:var(--dsw-alias-button-ghost-active-fill);color:var(--dsw-alias-label-secondary)}
.dshsh-u-badge.ok{color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-state-success-tertiary)}
.dshsh-u-badge.warn{color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-state-warn-secondary)}
.dshsh-u-badge.err{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-state-error-secondary)}
.dshsh-u-badge.dim{color:var(--dsw-alias-label-tertiary)}
/* 浮层头栏小标签 */
.dshsh-u-chip{display:inline-flex;align-items:center;height:19px;padding:0 8px;border-radius:10px;
  font-size:10.5px;line-height:1;color:var(--dsw-alias-state-success-primary);
  background:var(--dsw-alias-state-success-tertiary);white-space:nowrap}
/* 搜索条 */
.dshsh-u-search{display:flex;align-items:center;gap:6px;padding:5px 9px;border-radius:9px;
  background:var(--dsw-alias-interactive-bg-hover)}
.dshsh-u-search-in{flex:1 1 auto;min-width:0;border:none;outline:none;background:transparent;
  color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}
.dshsh-u-search-cnt{font-size:10.5px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
/* 授权页人性化：状态概览行 + 已授权会话分组 */
.dshsh-consent-overview{display:flex;align-items:center;gap:8px;margin:2px 4px 6px;padding:8px 10px;
  border-radius:10px;background:var(--dsw-alias-button-ghost-active-fill)}
.dshsh-consent-overview-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto}
.dshsh-consent-overview-dot.ok{background:var(--dsw-alias-state-success-primary)}
.dshsh-consent-overview-dot.warn{background:var(--dsw-alias-state-warn-primary)}
.dshsh-consent-overview-dot.dim{background:var(--dsw-alias-label-tertiary)}
.dshsh-consent-overview-main{flex:1 1 auto;font-size:12.5px;font-weight:500;color:var(--dsw-alias-label-primary)}
.dshsh-consent-overview-sub{font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
/* 0.4.0：模式行 —— 权限浮层里第一眼该看到的信息（它决定哪些工具可用） */
.dshsh-consent-mode{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:4px 10px;margin:0 0 4px;
  border-radius:6px;background:var(--dsw-alias-interactive-bg-hover);font-size:11.5px}
.dshsh-consent-mode-label{color:var(--dsw-alias-label-tertiary)}
.dshsh-consent-mode-value{font-weight:600}
.dshsh-consent-mode-value.ok{color:var(--dsw-alias-state-success-primary)}
.dshsh-consent-mode-value.warn{color:var(--dsw-alias-state-warn-primary)}
.dshsh-consent-mode-cap{color:var(--dsw-alias-label-secondary)}
/* "显示更多" 行 + 谱系树缩进（0.4.0） */
.dshsh-consent-mode-grow{margin-left:auto}
.dshsh-consent-morebtn{font-size:11px;padding:1px 6px;border-radius:4px;cursor:pointer;
  color:var(--dsw-alias-label-secondary);background:transparent;
  border:1px solid var(--dsw-alias-border-l3)}
.dshsh-consent-morebtn:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l4)}
.dshsh-consent-morebtn:disabled{opacity:.5;cursor:default}
.dshsh-consent-pickmode{font-size:11px;color:var(--dsw-alias-label-tertiary);padding:2px 0}
/* 日志总体统计条（0.4.0） */
.dshsh-logstats{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:4px 10px;margin:0 0 4px;
  border-radius:6px;background:var(--dsw-alias-interactive-bg-hover);font-size:11px;
  color:var(--dsw-alias-label-secondary)}
.dshsh-logstats-item{display:inline-flex;align-items:center;gap:4px}
.dshsh-logstats-k{color:var(--dsw-alias-label-tertiary)}
/* 子代理在谱系树里的缩进行（配合 │ └─ 前缀） */
.dshsh-actor-title.sub{color:var(--dsw-alias-label-secondary)}
.dshsh-actor-group{margin:2px 4px;padding:6px 8px;font-size:10.5px;color:var(--dsw-alias-label-tertiary);
  display:flex;align-items:center;gap:6px;text-transform:uppercase;letter-spacing:.4px}
.dshsh-actor-group .cnt{font-size:10px;padding:0 6px;border-radius:8px;background:var(--dsw-alias-button-ghost-active-fill)}
/* 授权页两栏：左选人 / 右控制 —— 右栏常驻，选中只换内容不挤动布局；
   0.3.4 列表撑满父组件：split 在浮层内占满剩余高度，左栏列表 flex 滚动。 */
/* 上下分区（用户：左侧菜单到上方、右侧菜单到下方）：原左栏=上区、原右栏=下区，各自滚动 */
.dshsh-consent-split{display:flex;flex-direction:column;gap:8px;align-items:stretch;margin:0 2px;flex:1 1 auto;min-height:0}
.dshsh-consent-left{flex:1 1 auto;min-width:0;width:100%;display:flex;flex-direction:column;gap:6px;min-height:0}
.dshsh-consent-left-inner{display:flex;flex-direction:column;gap:6px;flex:1 1 auto;min-height:0}
.dshsh-consent-q{max-height:26px;height:26px;padding:0 8px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover);
  color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;outline:none;border:none}
.dshsh-consent-list{flex:1 1 auto;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:2px}
.dshsh-consent-right{flex:1 1 auto;min-width:0;width:100%;display:flex;flex-direction:column;gap:6px;min-height:0;overflow:auto;
  border-left:0;border-top:.5px solid var(--dsw-alias-border-l2);padding-left:0;padding-top:8px;padding-bottom:2px}
.dshsh-consent-who{font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.dshsh-consent-actions{flex-wrap:wrap}
/* 授权页左栏：默认授权规则块（常驻；新会话复制它） */
.dshsh-consent-def{display:flex;flex-direction:column;gap:6px;padding:8px 10px;margin-bottom:6px;
  border-radius:10px;background:var(--dsw-alias-button-ghost-active-fill);
  border:1px solid var(--dsw-alias-border-l1)}
/* ── 主按钮（dshsh-cmenu-go）：各状态与面板现有主按钮设计（.dshsh-btn.accent）对齐 ──
   基准：品牌主色填充 + 反色描边 + 反色文字（高对比，明暗主题都成立）
   hover：换更亮一档 primary-hover，文字仍为反色；active：下压 1px；focus-visible：清晰外描边
   disabled：交给下方统一禁用规则（中性底 + 次要文字），不使用整体透明度 */
.dshsh-cmenu-go{height:30px;padding:0 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-inverted);
  background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted);
  font-size:12.5px;cursor:pointer}
.dshsh-cmenu-go:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);color:var(--dsw-alias-label-primary-inverted)}
/* 加密/解密切换：橘黄色**仅作提示**、不过分凸显 —— 只描边+变字色，不加底色填充；
   悬停才给一层很淡的 ghost 底（与面板 .dshsh-btn.locked 的克制口径一致） */
/* 解密小浮层：独立的一层（点背景任意位置即关）。刻意不借用 .dshsh-fmenu-panel ——
   它的规则（背景图/最小宽度等）会让这个小窗在面板里显得占满整片。 */
/* 小窗：**不要背景层**（inset:0 的透明层会盖住整片 UI；若面板带 transform，fixed 还会被它包含）。
   关闭改为文档级点击监听：点在小窗之外即关。尺寸写死上限，避免被任何继承规则撑开。 */
.dshsh-unlock-pop{position:fixed;z-index:89;width:208px;max-width:208px;height:auto;max-height:132px;
  padding:10px;border-radius:10px;box-sizing:border-box;
  border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-2);
  box-shadow:var(--dsw-elevation-prominent)}
.dshsh-mode-toggle{
  background:transparent;
  color:var(--dsw-alias-state-warn-primary);
  border:1px solid var(--dsw-alias-state-warn-primary);
  border-radius:8px;height:20px;padding:0 6px;font-size:11px;cursor:pointer
}
.dshsh-mode-toggle:hover:not(:disabled){background:var(--dsw-alias-button-ghost-active-fill)}
.dshsh-mode-toggle:disabled{color:var(--dsw-alias-label-tertiary);border-color:var(--dsw-alias-border-l4);cursor:not-allowed}
.dshsh-mode-toggle:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:1px}
/* 口令组在操作列里的小口令框（与整体字段风格一致） */
.dshsh-row-pass{
  box-sizing:border-box;width:110px;height:20px;padding:0 6px;font:inherit;font-size:11px;
  border-radius:6px;border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)
}
.dshsh-row-pass:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:1px}
.dshsh-cmenu-go:active:not(:disabled){transform:translateY(1px)}
.dshsh-cmenu-go:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:1px}
/* 统一修正：禁用态不再用整体透明度（那会把前景与背景一起压淡，看起来颜色太近），
   改为「中性底 + 次要文字 + 明确边框」；按钮尺寸与形状不变 */
/* 眼睛按钮（显示/隐藏说明文字）：低调配色 —— 默认用次要文字色，悬停才轻微提亮，
   避免沿用 cmenu-clear 的告警色（那样看起来像报错）。放在 cmenu-clear 之后以便覆盖。*/
.dshsh-eye{color:var(--dsw-alias-label-tertiary);border:1px solid transparent;background:transparent}
.dshsh-eye:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-button-ghost-active-fill)}
.dshsh-eye:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:1px}
.dshsh-cmenu-go:disabled, .dshsh-cmenu-clear:disabled, .dshsh-btn:disabled {
  opacity:1;cursor:not-allowed;
  background:var(--dsw-alias-bg-layer-3);
  color:var(--dsw-alias-label-tertiary);
  border-color:var(--dsw-alias-border-l4)
}
/* 通用表格：紧凑、表头可排序列悬停提示、选中行浅色底、空态弱化 */
.dshsh-u-table{width:100%;border-collapse:collapse;font-size:11.5px}
.dshsh-u-table th{padding:5px 8px;text-align:left;font-weight:500;color:var(--dsw-alias-label-tertiary);
  border-bottom:.5px solid var(--dsw-alias-border-l2);white-space:nowrap}
.dshsh-u-table td{padding:5px 8px;border-bottom:.5px solid var(--dsw-alias-border-l1);
  color:var(--dsw-alias-label-secondary);vertical-align:middle}
.dshsh-u-table tbody tr{transition:background .1s}
.dshsh-u-table tbody tr:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshsh-u-table tbody tr.on{background:var(--dsw-alias-button-ghost-active-fill)}
.dshsh-u-table-empty{color:var(--dsw-alias-label-tertiary);text-align:center;padding:14px 8px}
/* 通用筛选工具条 */
.dshsh-u-fbar{display:flex;align-items:center;gap:6px;margin:0 2px 6px;flex-wrap:wrap}
.dshsh-u-fbar .dshsh-u-search{flex:1 1 auto;min-width:120px}
.dshsh-u-fbar-select{height:26px;padding:0 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;outline:none}
/* ── 下拉（select）统一配色 ───────────────────────────────────────────────
   背景：这些 select 此前完全没有自己的底色/字色（formField 里的甚至没有 className）
   ⇒ 浏览器用默认白底 + 主题浅色文字 ⇒ 暗色主题下"文字与背景色太近"、几乎看不清。
   规则只作用在**本面板的容器**内（form-field / cmenu-row）与已知下拉类，
   绝不写裸 select ⇒ 不会影响宿主自己的下拉。 */
.dshsh-form-field select, .dshsh-cmenu-row select, .dshsh-cfg-select, .dshsh-u-fbar-select, .dshsh-player-speed {
  background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary);
  border:1px solid var(--dsw-alias-border-l2)
}
/* 展开后的选项列表也要上色（部分浏览器/主题下 option 单独取色） */
.dshsh-form-field select option, .dshsh-cmenu-row select option, .dshsh-cfg-select option, .dshsh-player-speed option {
  background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary)
}
/* 禁用态：中性底 + 次要文字（与按钮禁用态同一套口径） */
.dshsh-form-field select:disabled, .dshsh-cmenu-row select:disabled, .dshsh-cfg-select:disabled {
  background:var(--dsw-alias-bg-layer-3);
  color:var(--dsw-alias-label-tertiary);
  border-color:var(--dsw-alias-border-l4)
}
/* 键盘可达：清晰外描边（与按钮同款） */
.dshsh-form-field select:focus-visible, .dshsh-cmenu-row select:focus-visible, .dshsh-cfg-select:focus-visible {
  outline:2px solid var(--dsw-alias-label-primary);
  outline-offset:1px
}
/* 0.3.4 统一列表（UI.List）：头部工具条 + 表体撑满滚动；split 两栏（左列表/右详情） */
.dshsh-u-list{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;gap:4px}
.dshsh-u-list-head{flex:0 0 auto}
/* 列表体：flex 列容器，自身不滚动（滚动交给内部 .dshsh-u-scroll），
   这样横向滚动条会停在**可见区域底部**，而不是被很多行推到列表最下面。 */
.dshsh-u-list-body{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.dshsh-u-list-rows{display:flex;flex-direction:column;gap:2px}
.dshsh-u-list-slot{flex:0 0 auto}
/* 列表模式（会话选择/授权/引用库等）必须有独立滚动容器：
   直接塞进 overflow:hidden 的 list-body 会让第 N 行之后的 shell 永远不可见（用户实报）。 */
.dshsh-u-list-scroll{overflow-y:auto;overflow-x:hidden;scrollbar-width:thin;scrollbar-color:var(--dsh-scrollbar-thumb) transparent;overscroll-behavior:contain}
.dshsh-u-list-scroll::-webkit-scrollbar{width:9px;height:9px}
.dshsh-u-list-scroll::-webkit-scrollbar-thumb{background:var(--dsh-scrollbar-thumb);opacity:.6;border-radius:9px}
.dshsh-u-list-scroll::-webkit-scrollbar-thumb:hover{background:var(--dsh-scrollbar-thumb-hover);opacity:.9}
.dshsh-u-list-empty{padding:10px 8px;color:var(--dsw-alias-label-secondary);font-size:12px}
.dshsh-u-list:focus-visible,.dshsh-u-list-split:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
/* ── 0.3.4 列表三部分（用户规格）──────────────────────────────────────────
   ① 筛选行：一行平铺不换行，左侧=所有可筛选的键，右侧=搜索框
   ② 表头：显示全部相关信息（键名/类型/备注…），末尾可带操作列；列宽自适应 + 可拖
   ③ 显示区：一行一条，不换行不简写，放不下用省略号标记；行高固定且与表头一致 */
.dshsh-form-card{display:flex;flex-direction:column;gap:8px;padding:10px;border-radius:10px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.dshsh-form-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.dshsh-form-title{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dshsh-form-note{font-size:11px;color:var(--dsw-alias-label-tertiary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshsh-form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:8px}
/* 键值对卡片：段内子网格用**等分相对宽度** ⇒ 每个字段框宽度一致（不用固定 px —— 历史两次错位事故根源）*/
.dshsh-form-grid-sec{grid-template-columns:repeat(3,minmax(0,1fr))}
.dshsh-form-field{display:flex;flex-direction:column;gap:3px;min-width:0}
.dshsh-form-label{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dshsh-form-field input,.dshsh-form-field select,.dshsh-form-field textarea{height:28px;padding:0 8px;border-radius:6px;
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-interactive-bg-hover);
  color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;outline:none;min-width:0;box-sizing:border-box}
.dshsh-form-field textarea{height:auto;min-height:58px;padding:6px 8px;resize:vertical;line-height:1.5}
.dshsh-form-field input:focus,.dshsh-form-field select:focus,.dshsh-form-field textarea:focus{border-color:var(--dsw-alias-brand-primary)}
.dshsh-form-wide{grid-column:1 / -1}
.dshsh-form-actions{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.dshsh-form-check{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dshsh-form-btns{display:inline-flex;align-items:center;gap:6px}
.dshsh-u-rowbar{display:flex;align-items:center;gap:6px;flex-wrap:nowrap;padding:0 2px 4px}
/* 横向滚动条治理（引用库实测：列表容器 clientWidth 520 / scrollWidth 524 —— 多出 4px 的横向滚动条）：
   ① 统一盒模型：筛选行 / 工具条 / 标题这类子项带 padding，content-box 下会宽出 padding 那么多；
   ② 兜底：分区容器横向裁剪 —— 几像素的累积误差不该变成一条给用户看的滚动条。
      （真正的横向滚动只该发生在表格本体需要时，而列宽已经用百分比归一化保证不超宽。） */
.dshsh-u-list > *,.dshsh-consent-split > *,.dshsh-consent-left > *,.dshsh-consent-right > *,
.dshsh-u-list-split > *,.dshsh-u-list-left > *,.dshsh-u-list-right > *,.dshsh-u-sheet-body > *{box-sizing:border-box}
.dshsh-consent-left,.dshsh-consent-right,.dshsh-u-list-left,.dshsh-u-list-right{overflow-x:clip}
.dshsh-u-frow{display:flex;align-items:center;gap:6px;flex-wrap:nowrap;padding:0 2px 6px;min-width:0}
.dshsh-u-frow-keys{display:flex;align-items:center;gap:4px;flex:1 1 auto;min-width:0;overflow-x:auto;overflow-y:hidden;
  scrollbar-width:thin}
.dshsh-u-frow-keys select{flex:0 0 auto;height:26px;max-width:132px;padding:0 6px;border-radius:6px;
  border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-3);
  color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;outline:none;cursor:pointer}
.dshsh-u-frow-keys select:hover{border-color:var(--dsw-alias-border-l4)}
/* ⚠ 原生下拉弹层里的 option 默认是**透明背景**：只有浅色文字，遇到浅色弹层就「字看不见」。
   显式给每个选项自己的底色与文字色（跟随主题令牌），弹层在任何主题下都可读。 */
.dshsh-u-frow-keys option,.dshsh-u-fbar-select option{
  background-color:var(--dsw-specific-menu);color:var(--dsw-alias-label-primary)}
.dshsh-u-frow-keys select.on{
  border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-button-ghost-active-fill);font-weight:600}
.dshsh-u-frow-search{flex:0 0 auto;width:210px}
.dshsh-u-table2{table-layout:fixed;width:100%;border-collapse:separate;border-spacing:0;font-size:11.5px}
.dshsh-u-table2 th,.dshsh-u-table2 td{height:var(--dshsh-row-h,30px);padding:0 8px;
  border-bottom:.5px solid var(--dsw-alias-border-l2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  vertical-align:middle;box-sizing:border-box}
/* A1：表格自带滚动容器 —— sticky 的锚定对象会变成它自己，不再串到外层浮层/面板 tabbar。 */
/* 滚动区：既滚动又**有高度上界**（flex:1 1 auto + min-height:0）⇒
   行数再多，横向滚动条也固定在可视区底部。 */
.dshsh-u-scroll{overflow:auto;position:relative;flex:1 1 auto;min-height:0;max-height:100%}
/* 滚动区内的表头必须 sticky 且**不透明**：
   否则纵向滚动时表头会随内容滚走、或被子行覆盖（用户实报：表头被表格内容盖住）。
   z-index 保证表头始终压住行；不透明背景保证行不会透上来。 */
.dshsh-u-scroll .dshsh-u-table2 thead th{position:sticky;top:0;z-index:3;background:var(--dsw-alias-bg-layer-2)}
/* 固定表头容器同样给不透明底色，避免与滚动内容视觉粘连 */
.dshsh-u-headbox{position:relative;z-index:4;background:var(--dsw-alias-bg-layer-2)}
.dshsh-u-scroll>table{width:100%}
.dshsh-u-table2 th{position:sticky;top:0;z-index:2;font-weight:600;color:var(--dsw-alias-label-tertiary);text-align:left;
  user-select:none;background:var(--dsw-specific-menu);cursor:default}
.dshsh-u-table2 th.sortable{cursor:pointer}
.dshsh-u-table2 th.sortable:hover{color:var(--dsw-alias-label-primary)}
.dshsh-u-table2 td{color:var(--dsw-alias-label-primary)}
/* 行高必须与表头严格一致（用户规格）：单元格里的按钮/标签不许把它撑高 */
.dshsh-u-table2 td button,.dshsh-u-table2 td .dshsh-actor-tag,.dshsh-u-table2 td .dshsh-btn{
  max-height:calc(var(--dshsh-row-h,30px) - 8px);padding-top:0;padding-bottom:0;line-height:1;
  display:inline-flex;align-items:center;box-sizing:border-box}
.dshsh-u-table2 td button{font-size:11px;height:calc(var(--dshsh-row-h,30px) - 8px)}
.dshsh-u-table2 tbody tr:hover td{background:var(--dsw-alias-interactive-bg-hover)}
.dshsh-u-table2 tbody tr.on td{background:var(--dsw-alias-button-ghost-active-fill)}
.dshsh-u-table2 .dshsh-u-colfix{position:absolute;top:0;right:0;width:7px;height:100%;cursor:col-resize;z-index:3;
  border-right:1px solid transparent}
.dshsh-u-table2 .dshsh-u-colfix:hover{border-right-color:var(--dsw-alias-brand-primary)}
.dshsh-u-table2-empty{padding:10px 8px;color:var(--dsw-alias-label-secondary);font-size:12px}
.dshsh-u-list-split{display:flex;flex-direction:column;gap:8px;flex:1 1 auto;min-height:0;margin:0 2px}
/* 下区按内容完整显示（不压缩、不滚动），上区吃剩余空间（授权管理：下方配置全显示） */
.dshsh-u-list-split.fit > .dshsh-u-list-right{flex:0 0 auto;overflow:visible}
.dshsh-u-list-split.fit > .dshsh-u-list-left{flex:1 1 auto;min-height:0}
.dshsh-u-list-left{flex:1 1 auto;min-width:0;width:100%;display:flex;flex-direction:column;min-height:0;gap:4px}
.dshsh-u-list-right{flex:1 1 auto;min-width:0;width:100%;display:flex;flex-direction:column;min-height:0;gap:6px;overflow:auto;
  border-left:0;border-top:.5px solid var(--dsw-alias-border-l2);padding-left:0;padding-top:8px}
/* ── 0.3.4 美学统一层：全部浮动 UI 收敛到同一套阶梯 ─────────────────────
   字号：标题 13.5 / 正文 12.5 / 次级 11.5 / 辅助 10.5
   圆角：块 8（按钮/行/分段）/ 控件 6（输入框）/ 胶囊 999（徽标）
   高度：分段/输入 28，主按钮 30 —— 旧类逐个对齐，消除「各是各的」。
   覆写放在模板末尾（后加载即覆盖同优先级旧规则）。 */
.dshsh-cmenu, .dshsh-info, .dshsh-u-sheet, .dshsh-picker { font-size: 12.5px }
.dshsh-cmenu-title, .dshsh-info-title { font-size: 13.5px }
.dshsh-cmenu-sub, .dshsh-cmenu-h, .dshsh-cmenu-chip { font-size: 11.5px }
.dshsh-cmenu-seg-btn, .dshsh-cmenu-tab, .dshsh-cmenu-row, .dshsh-actor-item,
.dshsh-actor-title, .dshsh-cmenu-name, .dshsh-cmenu-badge { font-size: 12.5px }
.dshsh-cmenu-seg-btn, .dshsh-cmenu-tab, .dshsh-cmenu-in, .dshsh-actor-item,
.dshsh-cmenu-go, .dshsh-cfg-input, .dshsh-cfg-select { border-radius: 8px }
.dshsh-cmenu-row, .dshsh-actor-item { border-radius: 8px }
.dshsh-cmenu-actions { gap: 8px }
.dshsh-log-tool, .dshsh-cmenu-tabs { gap: 6px }
.dshsh-stable th, .dshsh-stable td { padding: 5px 8px }   /* 旧表格对齐新表格（dshsh-u-table）间距 */
`
window.__ModuleLoader__.load({
  id: 'terminalkeeper',
  factory: (require) => {
    const react = require('react')
    const h = react.createElement
    /**
     * 稳定宿主（2026-10-24）：把“父级渲染结束后才构造好的 VDOM”延迟到子级渲染时求值。
     * 组件类型只定义一次 ⇒ React 不会把整棵子树卸载重建（在渲染里新建组件函数会导致
     * 每次父级渲染都 remount：hover 闪烁、点击丢事件）。render 闭包在子级渲染时才调用，
     * 此时父级的 const 均已初始化（TDZ 安全）。
     */
    function DeferredRegion (props) { return h('div', { key: props.regionKey === undefined ? 'deferred' : props.regionKey }, props.render()) }

    /** 描边式 SVG 图标。用 SVG 而不是 emoji —— emoji 在各平台渲染差异太大。 */
    function Icon(props) {
      const size = props.size !== undefined ? props.size : 15
      const path = ICON_PATHS[props.name] !== undefined ? ICON_PATHS[props.name] : ''
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: props.weight !== undefined ? props.weight : 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      }, h('path', { d: path }))
    }

    /**
     * 0.3.4 UI 组件库（方案 A：先抽象统一组件，再迁移全部界面）。
     *
     * 目标：把散落在各浮层里的「按钮/浮层壳/页签/列表行/键值行」收拢成一组签名一致的
     * 组件 —— 视觉（尺寸/圆角/间距/主次/危险/状态色）只定义一遍，界面只负责组合。
     * 全部是纯函数（h() 拼装），可离线断言；类名前缀 `dshsh-u-`，与旧类并存，
     * 迁移一个浮层就换一组，不用一次全改。
     */
    const UI = {
      /** 统一按钮：variant=primary|ghost|danger|tool；icon=图标名（与 text 二选一或并存）。 */
      Btn (props) {
        const cls = 'dshsh-u-btn' +
          (props.variant === 'primary' ? ' primary' : props.variant === 'danger' ? ' danger'
            : props.variant === 'warn' ? ' warn' : props.variant === 'tool' ? ' tool' : '') +
          (props.active === true ? ' on' : '') +
          (props.locked === true ? ' locked' : '') +
          (props.text !== undefined && props.text !== '' ? ' text' : '') +
          (props.className !== undefined ? ' ' + props.className : '')
        const child = props.icon !== undefined
          ? [h(Icon, { name: props.icon, size: props.iconSize !== undefined ? props.iconSize : 15 }), props.text !== undefined && props.text !== '' ? h('span', { key: 't' }, props.text) : null]
          : props.text
        return h('button', {
          key: props.key,
          type: props.type !== undefined ? props.type : 'button',
          className: cls,
          disabled: props.disabled === true,
          onClick: props.onClick,
          title: props.title,
          'aria-expanded': props['aria-expanded'],
          'aria-label': props['aria-label'],
          style: props.style,
        }, child)
      },

      /** 浮层壳：统一的卡片式弹层（头栏 + 内容），替代各浮层各自拼的 cmenu/info 头。
       * children 兼容两种形态：`h(UI.Sheet, props, kid)`（rest 落到 kids）与
       * `props.children`（React 原生会把 rest 归并进 props）—— 测试 stub 不归并，
       * 所以显式兼容。 */
      Sheet (props, ...kids) {
        const bodyKids = props.children !== undefined ? props.children : kids
        const children = []
        if (props.title !== undefined || props.chip !== undefined) {
          children.push(h('div', { key: 'bar', className: 'dshsh-u-sheet-bar' }, [
            props.title !== undefined ? h('span', { key: 't', className: 'dshsh-u-sheet-title' }, props.title) : null,
            props.chip !== undefined ? h('span', { key: 'c', className: 'dshsh-u-chip', title: props.chipTitle }, props.chip) : null,
            props.actions !== undefined ? h('span', { key: 'a', className: 'dshsh-u-sheet-actions' }, props.actions) : null,
          ]))
        }
        if (props.tabs !== undefined) {
          children.push(h('div', { key: 'tabs', className: 'dshsh-u-tabs' }, props.tabs.map((tab) => h('button', {
            key: tab.id,
            type: 'button',
            className: 'dshsh-u-tab' + (tab.active === true ? ' on' : ''),
            onClick: tab.onClick,
            title: tab.title,
          }, tab.label)).concat(props.tabsExtra !== undefined ? [props.tabsExtra] : [])))
        // tabs2：**独立的第二行**（与 tabsExtra 不同 —— 后者会被拼进同一行）。
        // 详情页用它做「两大层 → 小标签」的第二行，避免 2+3 个挤成一排。
        if (props.tabs2 !== undefined) {
          children.push(h('div', { key: 'tabs2', className: 'dshsh-u-tabs dshsh-u-tabs2' }, props.tabs2))
        }
        }
        children.push(h('div', { key: 'body', className: 'dshsh-u-sheet-body' + (props.scroll === false ? ' noscroll' : '') }, bodyKids))
        return h('div', {
          key: props.key,
          className: 'dshsh-u-sheet' + (props.className !== undefined ? ' ' + props.className : ''),
          style: (props.height !== undefined || props.maxHeight !== undefined || props.top !== undefined)
            ? { top: props.top, height: props.height, maxHeight: props.maxHeight } : undefined,
        }, children)
      },

      /** 统一列表行：主名 + 次文本 + 序号 + 右侧操作区；可选中（单击触发 onClick）。 */
      Row (props) {
        return h('div', {
          key: props.key,
          className: 'dshsh-u-row' + (props.selected === true ? ' on' : '') + (props.onClick !== undefined ? ' clickable' : ''),
          onClick: props.onClick,
          title: props.title,
        }, [
          h('span', { key: 'n', className: 'dshsh-u-row-name', style: props.nameStyle }, props.name),
          props.sub !== undefined ? h('span', { key: 's', className: 'dshsh-u-row-sub' }, props.sub) : null,
          props.id !== undefined ? h('span', { key: 'i', className: 'dshsh-u-row-id' }, props.id) : null,
          props.trailing !== undefined ? h('span', { key: 'tr', className: 'dshsh-u-row-trailing' }, props.trailing) : null,
        ])
      },

      /** 键值行（详情/信息区通用）。 */
      Kv (props) {
        return h('div', { key: props.key, className: 'dshsh-u-kv' }, [
          h('span', { key: 'k', className: 'dshsh-u-kv-k' }, props.k),
          h('span', { key: 'v', className: 'dshsh-u-kv-v', title: props.title }, props.v),
        ])
      },

      /** 小节标题（列表/信息区分组）。 */
      Section (props) {
        const parts = [h('span', { key: 't' }, props.title)]
        if (props.count !== undefined) parts.push(h('span', { key: 'c', className: 'dshsh-u-section-count' }, String(props.count)))
        if (props.sub !== undefined) parts.push(h('span', { key: 's', className: 'dshsh-u-section-sub' }, props.sub))
        return h('div', { key: props.key, className: 'dshsh-u-section' }, parts)
      },

      /** 状态徽标。tone=ok|warn|err|dim。 */
      Badge (props) {
        return h('span', {
          key: props.key,
          className: 'dshsh-u-badge' + (props.tone !== undefined ? ' ' + props.tone : ''),
          title: props.title,
        }, props.children ?? props.text)
      },

      /** 搜索输入条。 */
      Search (props) {
        return h('div', { key: props.key, className: 'dshsh-u-search' }, [
          h(Icon, { name: 'search', size: 13 }),
          h('input', {
            key: 'in', type: 'text', className: 'dshsh-u-search-in',
            placeholder: props.placeholder,
            value: props.value,
            onChange: props.onChange,
          }),
          props.count !== undefined ? h('span', { key: 'cnt', className: 'dshsh-u-search-cnt' }, props.count) : null,
          props.onClear !== undefined ? UI.Btn({ key: 'x', variant: 'tool', icon: 'x', size: 13, onClick: props.onClear, title: '清空' }) : null,
        ])
      },

      /**
       * 0.3.4 通用表格组件：列定义驱动渲染，排序/筛选交给 tableModel（纯函数）。
       *
       * 列定义（columns）：[{ key, label, get?(row), render?(value, row), sortable?, searchable?,
       *                    width?, align? }]。排序由 props.sortKey/sortDir/onSort 三件套驱动
       * （表头点击 toggle 交给调用方的 onSort）；数据已由 tableModel 算好可见行，组件只渲染。
       * 支持：表头（可排序列带 ↓/↑ 指示）、行点击（onRowClick）、空态（emptyText）、
       * 操作列（columns 里 render 返回按钮即可）。
       */
      Table (props) {
        // hidden 列只参与筛选/排序（表格里不出现）：如日志的「时间范围」辅助列
        const cols = (Array.isArray(props.columns) ? props.columns : []).filter((c) => c.hidden !== true)
        const rows = Array.isArray(props.rows) ? props.rows : []
        const sortKey = props.sortKey ?? ''
        const sortDir = props.sortDir ?? ''
        const widths = props.widths !== null && typeof props.widths === 'object' ? props.widths : {}
        const rowH = props.rowHeight !== undefined ? props.rowHeight : 30
        /** 拖动列宽：按下表头右缘 → 跟随鼠标更新宽度（返回 px，交给调用方存 state）。 */
        /**
         * 双击列分隔线 ⇒ 该列**按内容自适应**（用户要求加入）。
         * 量的是「表头 + 该列全部单元格」的原始文本宽度（内容带省略号，故不能直接量 DOM 宽度），
         * 用同字体的隐藏 span 逐条量取最大值，再加上左右内边距与拖拽手柄的余量。
         * 列宽仍按"表宽百分比"写回（与拖动一致）⇒ 面板变窄时不会溢出。
         */
        const autoFitCol = (event, colKey) => {
          if (typeof props.onResize !== 'function') return
          COLDRAG.at = Date.now(); COLDRAG.key = colKey       // 抑制随后落到表头的 click（排序）
          event.preventDefault()
          event.stopPropagation()
          const th = event.currentTarget !== null && event.currentTarget !== undefined ? event.currentTarget.parentElement : null
          if (th === null || th === undefined) return
          const ci = typeof th.cellIndex === 'number' ? th.cellIndex : -1
          const tableEl = typeof th.closest === 'function' ? th.closest('.dshsh-u-table2') : null
          // 分母用**列表容器**宽度：表格宽度会随各列之和增大（可能 >100%），
          // 用表格自身宽度会把百分比算小。
          const listBody = typeof event.currentTarget.closest === 'function' ? event.currentTarget.closest('.dshsh-u-list-body') : null
          const tableW = listBody !== null && listBody !== undefined && typeof listBody.getBoundingClientRect === 'function'
            ? listBody.getBoundingClientRect().width
            : (tableEl !== null && tableEl !== undefined && typeof tableEl.getBoundingClientRect === 'function' ? tableEl.getBoundingClientRect().width : 0)
          const body = typeof th.closest === 'function' ? th.closest('.dshsh-u-list-body') : null
          const scrollTable = body !== null && body !== undefined && typeof body.querySelector === 'function'
            ? body.querySelector('.dshsh-u-scroll table') : null
          const texts = []
          if (th.textContent !== undefined && th.textContent !== '') texts.push(String(th.textContent).trim())
          if (scrollTable !== null && scrollTable !== undefined && ci >= 0 && typeof scrollTable.querySelectorAll === 'function') {
            for (const tr of scrollTable.querySelectorAll('tbody tr')) {
              const c = tr.children !== undefined ? tr.children[ci] : null
              const t = c !== null && c !== undefined && c.textContent !== undefined ? String(c.textContent).trim() : ''
              if (t !== '') texts.push(t)
            }
          }
          let maxW = 0
          if (typeof document !== 'undefined' && texts.length > 0) {
            const probe = document.createElement('span')
            probe.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;white-space:nowrap;font:inherit;font-size:12px'
            document.body.appendChild(probe)
            for (const t of texts) {
              probe.textContent = t
              const w = probe.getBoundingClientRect().width
              if (w > maxW) maxW = w
            }
            probe.remove()
          }
          const px = Math.max(MIN_COL_PX, Math.ceil(maxW) + 30)   // 30px ≈ 左右内边距 + 拖拽手柄；下限用统一常量
          if (tableW > 0) props.onResize(colKey, (px / tableW * 100).toFixed(2) + '%')
          else props.onResize(colKey, px)
        }

        const startResize = (event, colKey) => {
          if (typeof props.onResize !== 'function') return
          COLDRAG.at = Date.now(); COLDRAG.key = colKey       // 抑制随后落到表头的 click（排序）
          event.preventDefault()
          event.stopPropagation()
          const startX = event.clientX
          const th = event.currentTarget !== null && event.currentTarget !== undefined ? event.currentTarget.parentElement : null
          const startW = th !== null && th !== undefined && typeof th.getBoundingClientRect === 'function' ? th.getBoundingClientRect().width : 0
          // 表宽：列宽一律换算成"表宽的百分比"，而不是像素 ——
          // 像素会跟着面板变窄而溢出容器（表现就是表格下方多出一条横向滚动条）。
          const tableEl = event.currentTarget !== null && event.currentTarget !== undefined
            && typeof event.currentTarget.closest === 'function' ? event.currentTarget.closest('.dshsh-u-table2') : null
          // 分母用**列表容器**宽度（表格宽度会随各列之和增大，可能 >100%）
          const listBody = typeof event.currentTarget.closest === 'function' ? event.currentTarget.closest('.dshsh-u-list-body') : null
          const tableW = listBody !== null && listBody !== undefined && typeof listBody.getBoundingClientRect === 'function'
            ? listBody.getBoundingClientRect().width
            : (tableEl !== null && tableEl !== undefined && typeof tableEl.getBoundingClientRect === 'function' ? tableEl.getBoundingClientRect().width : 0)
          const onMove = (ev) => {
            const w = Math.max(MIN_COL_PX, Math.round(startW + (ev.clientX - startX)))
            if (tableW > 0) props.onResize(colKey, (w / tableW * 100).toFixed(2) + '%')
            else props.onResize(colKey, w)
          }
          const onUp = () => {
            if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
              window.removeEventListener('mousemove', onMove)
              window.removeEventListener('mouseup', onUp)
            }
          }
          if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            window.addEventListener('mousemove', onMove)
            window.addEventListener('mouseup', onUp)
          }
        }
        // ── 宽度模型（唯一，2026-10 重构：旧模型已删除，不做兼容）─────────────
        // 列宽**只**由 UI.List 计算，产出「列 key → 百分比」：
        //   内容自适应 → 富余平分 → 超出只压 flex 列 → 与手动拖拽值合并（手动列覆盖，其余保持规划值）。
        // UI.Table 不再做任何宽度决策；旧模型（declW/baseW 归一化、像素-百分比双模式、表格宽度推算）
        // 已全部删除 —— "两套模型切换"正是刷新后首次拖动列宽跳变的根因。
        const rawW = props.widths !== null && typeof props.widths === 'object' ? props.widths : {}
        const normW = {}
        let sumW = 0
        for (const c of cols) {
          const k = c.key ?? c.label
          const v = rawW[k]
          const num = typeof v === 'number' ? v : (typeof v === 'string' ? Number.parseFloat(v) : Number.NaN)
          if (Number.isFinite(num) && num > 0) { normW[k] = num.toFixed(2) + '%'; sumW += num }
        }
        // 表格宽度 = 各列之和：正好铺满即 100%；拖宽某列后 >100% ⇒ 横向滚动（设计如此）。
        const tableW = sumW > 0 ? sumW.toFixed(2) + '%' : '100%'
        const colgroup = h('colgroup', { key: 'cg' }, cols.map((col) => {
          const k = col.key ?? col.label
          const w = normW[k]
          return h('col', { key: 'col-' + k, style: w !== undefined ? { width: w } : undefined })
        }))
        const head = h('tr', { key: 'head' }, cols.map((col) => {
          const k = col.key ?? col.label
          const sortable = col.sortable !== false && col.key !== undefined
          const label = col.label + (sortKey === col.key && sortable ? (sortDir === 'desc' ? ' ↓' : ' ↑') : '')
          const canDrag = props.onResize !== undefined && col.resizable !== false
          const tip = [
            col.title !== undefined ? col.title : '',
            sortable && props.onSort !== undefined ? '点击切换排序' : '',
            canDrag ? '拖动右侧边缘调整列宽，或双击该边缘按内容自适应' : '',
          ].filter((x) => x !== '').join(' · ')
          return h('th', {
            key: k,
            className: sortable && props.onSort !== undefined ? 'sortable' : '',
            style: { textAlign: col.align ?? 'left' },
            onClick: sortable && props.onSort !== undefined
              ? (e) => {
                  // 刚在列分隔线上按下/双击过（≤600ms）⇒ 这是拖拽带出来的 click，不排序
                  if (COLDRAG.key === k && Date.now() - COLDRAG.at < 600) {
                    if (e !== undefined && e !== null && typeof e.stopPropagation === 'function') e.stopPropagation()
                    return
                  }
                  props.onSort(col.key)
                }
              : undefined,
            title: tip,
          }, [
            label,
            canDrag ? h('span', { key: 'rz', className: 'dshsh-u-colfix', title: '拖动改宽 / 双击按内容自适应',
            onMouseDown: (e) => startResize(e, col.key), onDoubleClick: (e) => autoFitCol(e, col.key),
            onClick: (e) => { e.stopPropagation() } }) : null,
          ])
        }))
        // noEmpty：表头表（rows: []）不应渲染"空态"行，否则每张表都会多出一条 dshsh-u-table2-empty
        const body = (rows.length === 0 && props.noEmpty !== true)
          ? h('tr', { key: 'empty' }, h('td', { key: 'e', colSpan: Math.max(1, cols.length), className: 'dshsh-u-table2-empty' },
            props.emptyText !== undefined ? props.emptyText : '（空）'))
          : rows.map((row, ri) => h('tr', {
            key: row?.__key !== undefined ? row.__key : ri,
            className: props.selectedKey !== undefined && row?.__key !== undefined && row.__key === props.selectedKey ? 'on' : '',
            onClick: props.onRowClick !== undefined ? () => props.onRowClick(row) : undefined,
          }, cols.map((col) => {
            const value = typeof col?.get === 'function' ? col.get(row) : row?.[col?.key]
            const cell = typeof col?.render === 'function' ? col.render(value, row) : String(value ?? '')
            const full = typeof col?.cellTitle === 'function' ? col.cellTitle(row, value)
              : (typeof value === 'string' || typeof value === 'number' ? String(value) : undefined)
            return h('td', {
              key: col.key ?? col.label,
              style: { textAlign: col.align ?? 'left' },
              title: full,
            }, cell)
          })))
        return h('table', {
          key: props.key, className: 'dshsh-u-table2',
          // 表格总宽（用户要求：改一列不应挤压其它列）：各列之和 >100% 时表格整体加宽，
          // 于是只出现横向滚动；列宽已按 max(100, 总和) 归一化 ⇒ 每列仍是占面板的绝对比例。
          style: { '--dshsh-row-h': String(rowH) + 'px', width: tableW },
        }, [colgroup,
          // 0.4.1：表头/正文分离时，正文表用 noHead 跳过 thead（否则出现「两行表头 + 正文」）
          props.noHead === true ? null : h('thead', { key: 'thead' }, head),
          h('tbody', { key: 'tbody' }, body)])
      },

      /**
       * 0.3.4 筛选行（列表三部分之①）：一行平铺、不换行 ——
       * 左侧 = 所有可筛选的键（每个键一个下拉），右侧 = 搜索框。
       * props: filters[{ key, label, options:[{value,label}], title }]、
       * filterValues{key:value}/onFilterChange(key,value)、query/onQueryChange/placeholder/count。
       */
      FilterRow (props) {
        // 展开状态必须由 React 状态驱动：之前用 DOM classList 切换，面板任何重渲染都会重建节点 ⇒ 立即丢失
        const [openKey, setOpenKey] = react.useState('')
        const filters = Array.isArray(props.filters) ? props.filters : []
        // 展开状态一律用 React 状态（DOM classList 会被重渲染冲掉，表现为「点了没反应」）
        const [menuOpen, setMenuOpen] = react.useState(false)   // 一级菜单是否展开
        const [menuCat, setMenuCat] = react.useState('')       // 右侧子菜单对应的筛选项 key
        const fmenuRootRef = react.useRef(null)
        // 与常见 UI 一致：点击菜单外的任何地方 ⇒ 关闭全部菜单；Esc 同样关闭（避免额外的学习成本）
        react.useEffect(() => {
          if (menuOpen !== true) return undefined
          const closeAll = () => { setMenuOpen(false); setMenuCat('') }
          const onDown = (ev) => {
            const root = fmenuRootRef.current
            if (root !== null && root !== undefined && typeof root.contains === 'function' && ev.target !== null
              && ev.target !== undefined && root.contains(ev.target) === true) return
            closeAll()
          }
          const onKey = (ev) => { if (ev.key === 'Escape') closeAll() }
          if (typeof document !== 'undefined' && document !== null && typeof document.addEventListener === 'function') {
            document.addEventListener('mousedown', onDown)
            document.addEventListener('keydown', onKey)
          }
          return () => {
            if (typeof document !== 'undefined' && document !== null && typeof document.removeEventListener === 'function') {
              document.removeEventListener('mousedown', onDown)
              document.removeEventListener('keydown', onKey)
            }
          }
        }, [menuOpen])
        const values = props.filterValues !== null && typeof props.filterValues === 'object' ? props.filterValues : {}
        // 0.4.1 用户要求：筛选项多时（键事件 / 键值对）改为「一级下拉 + 右侧二级子菜单」，消除横向滚动条。
        // 纯 CSS :hover 展开 —— FilterRow 是普通函数组件，不能安全用 hooks，所以不引入组件状态。
        const activeCount = filters.filter((f) => { const v = values[f.key]; return v !== undefined && v !== null && String(v) !== '' }).length
        // 用户要求：**点击式两级级联菜单**（原生 select 只能单选，无法复合）
        //   点「筛选 ▾」→ 一级菜单列出各筛选项 → 点某项 → 右侧弹出该项的具体条件
        //   选中条件后**不收起**菜单，可继续叠加 ⇒ 复合筛选；另有「清空全部筛选」
        // 结构拆成命名小函数，每段各自配平（手写深层嵌套曾两次栽在括号平衡上）
        const optsOf = (f) => [{ value: '', label: '全部' }].concat(
          (Array.isArray(f.options) ? f.options : []).map((o) => ({ value: String(o.value), label: String(o.label) })))
        const valOf = (f) => (values[f.key] === undefined || values[f.key] === null ? '' : String(values[f.key]))
        const fmenuSub = (f) => {
          const cur = valOf(f)
          return h('div', { key: 'sub', className: 'dshsh-fmenu-sub open' }, optsOf(f).map((o) => h('button', {
            key: o.value, type: 'button',
            className: 'dshsh-fmenu-opt' + (cur === o.value ? ' on' : ''),
            onClick: (e) => {
              e.stopPropagation()                       // 选完不收起 ⇒ 可叠加其它条件
              if (typeof props.onFilterChange === 'function') props.onFilterChange(f.key, o.value)
            },
          }, o.label)))
        }
        const fmenuRow = (f) => {
          const cur = valOf(f)
          const isOpen = menuCat === f.key
          return h('div', {
            key: 'c-' + f.key,
            className: 'dshsh-fmenu-item' + (cur !== '' ? ' on' : '') + (isOpen ? ' open' : ''),
            title: '点击查看该筛选项的具体条件',
            onClick: (e) => { e.stopPropagation(); setMenuCat(isOpen ? '' : f.key) },
          }, [
            h('span', { key: 'l', className: 'dshsh-fmenu-l' }, f.label + (cur !== '' ? '：' + cur : '')),
            h('span', { key: 'a', className: 'dshsh-fmenu-a' }, '\u203a'),
            isOpen ? fmenuSub(f) : null,
          ])
        }
        const fmenuKeys = () => h('div', { key: 'keys', ref: fmenuRootRef, className: 'dshsh-u-frow-keys', style: { overflow: 'visible' } }, [
          // 复用 UI.FMenu（多级筛选菜单展示组件；状态仍由本组件持有，组件本身无 hook）。
          UI.FMenu({
            key: 'fmenu',
            open: menuOpen,
            onToggle: () => { setMenuOpen((v) => !v); setMenuCat('') },
            cat: menuCat,
            onCat: setMenuCat,
            items: filters.map((f1) => ({
              key: f1.key,
              label: f1.label,
              value: values[f1.key],
              tip: f1.title !== undefined ? f1.title : ('按「' + f1.label + '」筛选' + (f1.hint !== undefined ? '（' + f1.hint + '）' : '')),
              options: [{ v: '', l: '全部' }].concat((Array.isArray(f1.options) ? f1.options : []).map((o) => ({ v: String(o.value), l: String(o.label) }))),
              onPick: (v) => { if (typeof props.onFilterChange === 'function') props.onFilterChange(f1.key, v) },
              onClear: () => { if (typeof props.onFilterChange === 'function') props.onFilterChange(f1.key, '') },
            })),
          }),
        ])
        // 统一使用新的筛选菜单样式（fmenu）：原生 <select> 分支已按用户要求删除，
        // 于是「会话选择」等所有列表的筛选按钮都是同一个「筛选 ▾ + 面板」外观。
        const keys = fmenuKeys()
        const right = h('div', { key: 's', className: 'dshsh-u-frow-search' }, [
          UI.Search({
            key: 'q',
            placeholder: props.placeholder !== undefined ? props.placeholder : '搜索…',
            value: props.query !== undefined ? props.query : '',
            onChange: props.onQueryChange,
            count: props.count,
          }),
        ])
        return h('div', { key: props.key, className: 'dshsh-u-frow' }, [keys, right])
      },

      /**
       * FMenu — 多级筛选菜单（一级按钮 + 二级面板 + 三级子面板）的**展示组件**，可复用。
       * 刻意**不含任何 hook**：UI.* 都是普通函数、调用位置可能不固定（历史上在 UI.List 里加 hook
       * 触发过 React 的"更新深度超限"错误，整棵浮层崩掉）。展开状态一律由调用方持有并用 props 传入。
       * props:
       *   key, label（按钮文案，缺省「筛选 ▾」）, open（一级面板展开）, onToggle(),
       *   cat（右侧子面板展开的项 key）, onCat(key),
       *   items: [{ key, label, value, tip, options:[{v,l}], onPick(v), onClear() }]
       */
      FMenu (props) {
        const items = Array.isArray(props.items) ? props.items : []
        const rawOf = (it) => String(it.value === undefined || it.value === null ? '' : it.value)
        const labelOf = (it) => {
          const list = Array.isArray(it.options) ? it.options : []
          const hit = list.filter((o) => String(o.v) === rawOf(it))[0]
          return hit !== undefined && hit !== null ? String(hit.l) : ''
        }
        const activeCount = items.filter((it) => rawOf(it) !== '').length
        const panel = [
          h('div', {
            key: 'clr', className: 'dshsh-fmenu-item', title: '清空所有筛选项',
            onClick: () => {
              for (const it of items) if (typeof it.onClear === 'function') it.onClear()
              if (typeof props.onCat === 'function') props.onCat('')
            },
          }, '清空全部筛选'),
        ].concat(items.map((it) => h('div', {
          key: it.key,
          className: 'dshsh-fmenu-item' + (props.cat === it.key ? ' open' : ''),
          title: '点击查看该筛选项的具体条件',
          onClick: () => { if (typeof props.onCat === 'function') props.onCat(props.cat === it.key ? '' : it.key) },
        }, [
          h('span', { key: 'l', className: 'dshsh-fmenu-l' }, it.label),
          h('span', { key: 'a', className: 'dshsh-fmenu-a' }, labelOf(it) === '' ? '>' : labelOf(it) + ' >'),
          h('div', { key: 'sub', className: 'dshsh-fmenu-sub' },
            (Array.isArray(it.options) ? it.options : []).map((o) => h('div', {
              key: 'o-' + String(o.v),
              className: 'dshsh-fmenu-opt' + (String(o.v) === rawOf(it) ? ' on' : ''),
              title: it.tip,
              onClick: (e) => { e.stopPropagation(); if (typeof it.onPick === 'function') it.onPick(o.v) },
            }, o.l))),
        ])))
        return h('div', {
          key: props.key !== undefined ? props.key : 'fmenu',
          className: 'dshsh-fmenu' + (props.open === true ? ' open' : ''),
        }, [
          h('button', {
            key: 'b', type: 'button',
            className: 'dshsh-fmenu-btn' + (activeCount > 0 ? ' on' : ''),
            title: '筛选：点击展开筛选项；再点某一项，右侧弹出该项的具体条件（可多条件叠加）',
            onClick: (e) => { e.stopPropagation(); if (typeof props.onToggle === 'function') props.onToggle() },
          }, String(props.label !== undefined ? props.label : ('筛选' + (activeCount > 0 ? '（已选 ' + String(activeCount) + '）' : '') + ' ▾'))),
          h('div', { key: 'p', className: 'dshsh-fmenu-panel' }, panel),
        ])
      },

      /** 通用筛选工具条：搜索框 + 排序下拉 + 可选重置按钮（与表格/列表搭配）。 */
      FilterBar (props) {
        const parts = []
        if (props.query !== undefined) {
          parts.push(UI.Search({
            key: 'q',
            placeholder: props.placeholder !== undefined ? props.placeholder : '筛选…',
            value: props.query,
            onChange: props.onQueryChange,
            count: props.count !== undefined ? props.count : undefined,
          }))
        }
        if (props.sortOptions !== undefined && Array.isArray(props.sortOptions) && props.sortOptions.length > 0) {
          parts.push(h('select', {
            key: 'sort', className: 'dshsh-u-fbar-select',
            value: props.sortValue !== undefined ? props.sortValue : '',
            onChange: (e) => props.onSortChange !== undefined ? props.onSortChange(e.target.value) : undefined,
            title: '排序方式',
          }, props.sortOptions.map((opt) => h('option', { key: opt.value, value: opt.value }, opt.label))))
        }
        if (props.onReset !== undefined) {
          parts.push(UI.Btn({ key: 'r', variant: 'tool', icon: 'x', size: 12, onClick: props.onReset, title: '重置筛选' }))
        }
        return h('div', { key: props.key, className: 'dshsh-u-fbar' }, parts)
      },

      /**
       * 0.3.4 统一列表：一行声明「有排序 + 搜索能力」的列表（数据进、渲染出）。
       *
       * props: columns（Table 列定义，可排序列加 sortable）、rows（原始行，内部过
       * tableModel 排序/筛选）、query/sortKey/sortDir（受控排序搜索状态）、
       * onQueryChange/onSort（状态回调）、sortOptions（下拉排序选项）、selectedKey/
       * onRowClick（行选中）、emptyText、key、right（可选右侧详情区 → 自动两栏）。
       * 排序状态切换逻辑内建：点表头切换升降序，选下拉直接设键。
       */
      List (props) {
        const cols = Array.isArray(props.columns) ? props.columns : []
        const rows = Array.isArray(props.rows) ? props.rows : []
        const q = String(props.query ?? '')
        const sk = props.sortKey ?? ''
        const sd = props.sortDir === 'desc' ? 'desc' : 'asc'
        // 自定义行渲染（renderRow）时可只给 searchText：造一个伪列供 tableModel 过滤/排序用
        const effCols = cols.length > 0
          ? cols
          : [{ key: '__q', sortable: false, get: (r) => (typeof props.searchText === 'function' ? props.searchText(r) : '') }]
        const model = tableModel(rows, effCols, q, sk, sd, props.filterValues)
        const visible = model.visible
        const rowKeyOf = (row, i) => (typeof props.rowKey === 'function' ? props.rowKey(row, i) : (row?.__key !== undefined ? row.__key : i))
        const toggleSort = (key) => {
          if (typeof props.onSort !== 'function') return
          if (sk === key) props.onSort(key, sd === 'asc' ? 'desc' : 'asc')
          else props.onSort(key, 'asc')
        }
        const emptyText = props.emptyText !== undefined ? props.emptyText : (q.trim() !== '' ? '没有匹配项' : '（空）')
        // ① 筛选行：筛选键自动来自列定义（col.filter）——调用方不必手写筛选条；
        //    filter.options 可显式给，filter.auto 则从当前数据去重推导。
        const autoFilters = Array.isArray(props.filters)
          ? props.filters
          : cols.filter((c) => c.key !== undefined && c.filter !== undefined).map((c) => {
              let options = Array.isArray(c.filter.options) ? c.filter.options : []
              if (options.length === 0 && c.filter.auto === true) {
                const seen = new Map()
                for (const row of rows) {
                  const v = typeof c.get === 'function' ? c.get(row) : row?.[c.key]
                  const key = String(v ?? '')
                  if (key === '' || seen.has(key)) continue
                  seen.set(key, { value: key, label: key })
                  if (seen.size >= 12) break
                }
                options = [...seen.values()]
              }
              return {
                key: c.key, label: c.label, options,
                title: c.filter.title !== undefined ? c.filter.title : c.title,
                hint: c.filter.hint,
              }
            })
        const hasFilterBar = autoFilters.length > 0 || props.query !== undefined
        const isFiltered = q.trim() !== '' || autoFilters.some((f) => {
          const v = props.filterValues !== null && typeof props.filterValues === 'object' ? props.filterValues[f.key] : undefined
          return v !== undefined && v !== null && v !== ''
        })
        const head = hasFilterBar
          ? h(UI.FilterRow, {
              key: 'fh',
              filters: autoFilters,
              filterValues: props.filterValues,
            filterMenu: props.filterMenu === true,
              onFilterChange: props.onFilterChange,
              query: q,
              onQueryChange: props.onQueryChange,
              placeholder: props.placeholder,
              count: isFiltered || props.alwaysCount === true
                ? String(model.filteredCount) + '/' + String(model.totalCount) : undefined,
            })
          : null
        // 统一默认填充（用户要求：逻辑放共用组件里，各列表自动一致）——
        // 纯计算：由「列定义 + 数据 + LIST_AVAIL」推出列宽；无 hook、无测量、无 setState。
        // 手动调整过该表的列宽（props.widths 非空）时一律以手动值为准。
        const effWidths = (() => {
          const manual = props.widths
          const manualHad = manual !== null && manual !== undefined && Object.keys(manual).length > 0
          // 隐藏列（hidden: true，例如日志页的『时间范围』width:0% ）不参与宽度规划：
          // 否则它会占掉一份分配，把可见列的比例带偏（实测：可见列之和只有 86.56%）。
          const list = (Array.isArray(cols) ? cols : []).filter((c) => c === null || c === undefined || c.hidden !== true)
          if (list.length === 0) return manual
          const cjk = /[\u3000-\u9fff\uff00-\uffef]/
          const px = (t) => { let w = 0; for (const ch of String(t ?? '')) w += cjk.test(ch) ? 12.2 : 6.6; return w }
          const data = Array.isArray(props.rows) ? props.rows.slice(0, 200) : []
          const items = []
          for (const c of list) {
            const key = c.key !== undefined ? c.key : c.label
            let max = px(c.label)
            for (const r of data) {
              const v = typeof c.get === 'function' ? c.get(r) : (r !== null && r !== undefined ? r[c.key] : '')
              const w = px(v)
              if (w > max) max = w
            }
            const floor = Number.isFinite(Number(c.minContent)) ? Number(c.minContent) : 0
            items.push({ key, content: Math.max(Math.min(260, max), floor) + 30, flex: c.flex === true, max: c.max })
          }
          // 分配基准（仅用于"富余平分"的数学）；最终输出是百分比 ⇒ 基准偏差不会造成溢出。
          const avail = Math.max(240, LIST_AVAIL > 0 ? LIST_AVAIL : 900)
          const planned = planColumnWidths(items, avail)
          if (Object.keys(planned).length === 0) return manual
          // 输出**百分比**（永远相对容器 ⇒ 不需要知道容器真实宽度，也就不会出现
          // "按面板宽算、却比列表容器宽"的错误）；像素分配仍走整数 + 余数给最前列的规则，
          // 最后按实际总和换算成百分比并修正四舍五入残差。
          let sumPx = 0
          for (const k of Object.keys(planned)) sumPx += planned[k]
          if (!(sumPx > 0)) return manual
          const pct = {}
          let sumPct = 0
          for (const k of Object.keys(planned)) {
            const v = Number.parseFloat((planned[k] / sumPx * 100).toFixed(2))
            pct[k] = v
            sumPct += v
          }
          const widest = Object.keys(pct).reduce((a, k) => (a === null || pct[k] > pct[a] ? k : a), null)
          if (widest !== null) {
            const fix = Math.round((100 - sumPct) * 100) / 100
            if (fix !== 0) pct[widest] = Number.parseFloat((pct[widest] + fix).toFixed(2))
          }
          const outPct = {}
          for (const k of Object.keys(pct)) outPct[k] = pct[k].toFixed(2) + '%'
          // 关键修正：手动值只覆盖它自己那几列，**其余列保持本次规划值**。
          // 此前"有手动值就整体改用手动值" ⇒ 第一次拖动某一列时，其余列立刻从规划值退回
          // 列声明默认宽度（表现：刷新后首次拖动，某些列瞬间跳成另一个宽度）。
          const merged = manualHad ? Object.assign({}, outPct, manual) : outPct
          // 隐藏列也给出宽度（否则列无宽度，在 fixed 布局下会吃掉剩余空间）：用其列声明宽度。
          for (const c of (Array.isArray(cols) ? cols : [])) {
            if (c === null || c === undefined || c.hidden !== true) continue
            const k = c.key !== undefined ? c.key : c.label
            if (merged[k] === undefined) merged[k] = typeof c.width === 'string' ? c.width : '0%'
          }
          return merged
          return outPct
        })()
        // ②③ 表头 + 显示区（固定行高、不换行、溢出省略号由 .dshsh-u-table2 统一给）
        const body = h('div', { key: 'body', className: 'dshsh-u-list-body' }, [
          typeof props.renderRow === 'function'
            ? h('div', {
                key: 'listbox', className: 'dshsh-u-scroll dshsh-u-list-scroll',
                style: { flex: '1 1 auto', minHeight: 0, overflow: 'auto', position: 'relative' },
              }, [
                visible.length === 0
                  ? h('div', { key: 'empty', className: 'dshsh-u-list-empty' }, emptyText)
                  : h('div', { key: 'rows', className: 'dshsh-u-list-rows' }, visible.map((row, i) => h('div', {
                      key: rowKeyOf(row, i), className: 'dshsh-u-list-slot',
                    }, props.renderRow(row, { index: i, key: rowKeyOf(row, i), selected: props.selectedKey !== undefined && rowKeyOf(row, i) === props.selectedKey })))),
              ])
            : h('div', { key: 'tablebox', style: { display: 'flex', flexDirection: 'column', minHeight: 0 } }, [
          // 用户方案：表头从表格中剔除 —— 表头单独一张固定不滚的表，滚动区里只有正文表。
          // 两张表用同一批 columns 生成 colgroup ⇒ 列宽天然对齐；不再需要 sticky，也就没有重叠问题。
          h('div', { key: 'headbox', className: 'dshsh-u-headbox', style: { flex: '0 0 auto', overflow: 'hidden' } }, [UI.Table(Object.assign({}, Object.assign({}, {
                key: 't', columns: cols, rows: visible,
                sortKey: sk, sortDir: sd, onSort: props.onSort !== undefined ? toggleSort : undefined,
                selectedKey: props.selectedKey, onRowClick: props.onRowClick,
                widths: effWidths, onResize: props.onResize, rowHeight: props.rowHeight,
                emptyText,
              }, { rows: [], noEmpty: true }), { noHead: false }))]),   // noHead:false ⇒ 表头区**渲染** thead（它是独立的不滚动表头区）
          h('div', { key: 'bodybox', className: 'dshsh-u-scroll', style: { flex: '1 1 auto', minHeight: 0, overflow: 'auto', position: 'relative' },
            // 表头与表体是两张表 ⇒ 横向滚动时把表头同步位移，保持列对齐。
            onScroll: (ev) => {
              const el = ev.currentTarget
              if (el === null || el === undefined || typeof el.querySelector !== 'function') return
              const box = el.parentElement
              const head = box !== null && box !== undefined && typeof box.querySelector === 'function' ? box.querySelector('.dshsh-u-table2') : null
              if (head !== null && head !== undefined && head.style !== undefined) head.style.transform = 'translateX(' + String(-el.scrollLeft) + 'px)'
            } }, [UI.Table({
                key: 't', columns: cols, rows: visible,
                sortKey: sk, sortDir: sd, onSort: props.onSort !== undefined ? toggleSort : undefined,
                selectedKey: props.selectedKey, onRowClick: props.onRowClick,
                widths: effWidths, onResize: props.onResize, rowHeight: props.rowHeight,
                emptyText,
                noHead: true,   // 正文滚动区跳过 thead（表头在独立表头区）⇒ 结构上不可能重叠
              })]),
        ]),
        ])
        // 键盘：↑↓ 移动选中（走 onRowClick）、Esc 清空搜索
        const onKeyDown = (e) => {
          if (props.keyboard === false) return
          if (e.key === 'Escape' && q !== '') {
            e.preventDefault()
            if (props.onQueryChange !== undefined) props.onQueryChange({ target: { value: '' } })
            return
          }
          if (typeof props.onRowClick !== 'function' || visible.length === 0) return
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            const cur = visible.findIndex((r, i) => rowKeyOf(r, i) === props.selectedKey)
            const next = e.key === 'ArrowDown'
              ? Math.min(visible.length - 1, cur < 0 ? 0 : cur + 1)
              : Math.max(0, cur < 0 ? 0 : cur - 1)
            props.onRowClick(visible[next])
          }
        }
        const inner = head !== null ? [head, body] : [body]
        // right 未给或为 null → 单栏：全部高度都给表格（默认全部区域显示表格）
        if (props.right !== undefined && props.right !== null) {
          return h('div', { key: props.key, className: 'dshsh-u-list-split' + (props.rightFit === true ? ' fit' : ''), tabIndex: props.keyboard === false ? undefined : 0, onKeyDown }, [
            h('div', { key: 'l', className: 'dshsh-u-list-left' }, inner),
            h('div', { key: 'r', className: 'dshsh-u-list-right' }, props.right),
          ])
        }
        return h('div', { key: props.key, className: 'dshsh-u-list', tabIndex: props.keyboard === false ? undefined : 0, onKeyDown }, inner)
      },

      /** 0.3.4 统一下拉菜单：所有浮层同一只壳（title + chip + tabs + 统一边界）。 */
      Menu (props, ...kids) {
        const { key, top, height, maxHeight, title, chip, chipTitle, actions, tabs, tabsExtra, tabs2, scroll, className } = props
        const body = props.children !== undefined ? props.children : (kids.length === 1 ? kids[0] : kids)
        return UI.Sheet({
          key, top, height, maxHeight, title, chip, chipTitle, actions, tabs, tabsExtra, tabs2, scroll, className,
        }, body)
      },
    }

    const BASE = '/plugins/shell'
    const POS_KEY = 'terminalkeeper:pos'
    const SELECTED_KEY = 'terminalkeeper:selected'
    const RECT_KEY = 'terminalkeeper:rect'
    /** 面板尺寸下限。 */
    const MIN_W = 360
    const MIN_H = 220

    /**
     * 构建标识。每次改客户端就 +1 —— 面板指标行会显示它。
     *
     * 存在的理由：客户端 bundle 的 URL 带 `&rev=<hash>`，只有**重新加载页面**才会取到新版；
     * 没有这个可见标记，根本分不清「修复没生效」和「浏览器跑的还是旧代码」。
     */
    var BUILD = CLIENT_BUILD
    /**
     * 包版本号，必须与 package.json 的 `version` 完全一致。
     *
     * 这里刻意冗余一次：面板指标行会把版本显示出来，用户报障时不必去翻
     * `node_modules/terminalkeeper/package.json` 就能说清跑的是哪一版。
     * 两边一旦漂移，`npm run release:check` 会直接失败，所以不会长期不同步。
     */
    const PKG_VERSION = '0.1.0'
    /** 注入样式表的元素 id（卸载时按它精确移除）。 */
    const CSS_ID = 'terminalkeeper-style'

    /** 胶囊尺寸（与样式保持一致，用于定位与夹取）。 */
    const PILL_W = 132
    const PILL_H = 34
    /** 面板尺寸（与样式保持一致）。 */
    const PANEL_W = 760
    const PANEL_H = 460
    /** 距视口边缘的留白。 */
    const MARGIN = 8
    /** 超过这个位移就算拖动而不是点击。 */
    const DRAG_THRESHOLD = 4
    /** 面板一次最多向上取多少行历史（宿主侧上限是 100000）。 */
    const MAX_WINDOW = 5000
    // 0.3.4 (A)：高亮渲染上限 —— 命中过多（如搜单字母）时关闭高亮避免上万 <mark> 节点卡死面板
    const MAX_RENDER_HITS = 1500

    const S = {
      /** 折叠态胶囊里的名字：等宽没必要，但要截断（宽度靠它吸收）。 */
      pillName: {
        maxWidth: '132px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      pill: {
        position: 'fixed',
        pointerEvents: 'auto',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        height: PILL_H + 'px',
        padding: '0 10px 0 8px',
        borderRadius: '17px',
        border: '.5px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-button-floating-fill)',
        color: 'var(--dsw-alias-label-primary)',
        boxShadow: '0 4px 14px var(--dsw-alias-bg-mask-1)',
        fontSize: '12px',
        cursor: 'grab',
        userSelect: 'none',
        touchAction: 'none',
        zIndex: 9998,
      },
      panel: {
        position: 'fixed',
        width: PANEL_W + 'px',
        maxWidth: 'calc(100vw - 16px)',
        height: PANEL_H + 'px',
        maxHeight: 'calc(100vh - 16px)',
        pointerEvents: 'auto',
        display: 'flex',
        flexDirection: 'column',
        borderRadius: '12px',
        border: '.5px solid var(--dsw-alias-border-l2)',
        background: 'color-mix(in srgb, var(--dsw-alias-bg-layer-1) 70%, transparent)',
        boxShadow: '0 6px 20px var(--dsw-alias-bg-mask-1)',
        overflow: 'hidden',
        zIndex: 9999,
      },
      head: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '8px 10px',
        borderBottom: '.5px solid var(--dsw-alias-border-l2)',
        fontSize: '12px',
        cursor: 'grab',
        userSelect: 'none',
        touchAction: 'none',
        // 面板 overflow 是 visible（选择器不能被裁掉），所以圆角要自己补
        borderRadius: '11px 11px 0 0',
      },
      btn: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: '26px',
        height: '26px',
        padding: '0 7px',
        borderRadius: '6px',
        border: '.5px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '12px',
        cursor: 'pointer',
        lineHeight: 1,
      },
      btnOff: {
        opacity: 0.4,
        cursor: 'not-allowed',
      },
      /** 指标行里的迷你按钮。 */
      miniBtn: {
        display: 'inline-flex',
        alignItems: 'center',
        height: '18px',
        padding: '0 6px',
        borderRadius: '5px',
        border: '.5px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        fontFamily: 'inherit',
        fontSize: '11px',
        lineHeight: 1,
        cursor: 'pointer',
      },
      lockOn: {
        borderColor: 'var(--dsw-alias-state-warn-primary)',
        color: 'var(--dsw-alias-state-warn-primary)',
      },
      lockOff: {
        borderColor: 'var(--dsw-alias-state-success-primary)',
        color: 'var(--dsw-alias-state-success-primary)',
      },
      grip: {
        color: 'var(--dsw-alias-label-tertiary)',
        fontSize: '11px',
        letterSpacing: '-1px',
      },
      name: {
        flex: 1,
        textAlign: 'center',
        fontFamily: 'var(--ds-font-family-code)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      screen: {
        flex: 1,
        // 光标是绝对定位的子元素：包含块是 padding box，所以偏移量要自己加上内边距
        position: 'relative',
        margin: 0,
        padding: (SCREEN_PAD_Y / 2) + 'px ' + String(SCREEN_PAD_X) + 'px',
        overflow: 'auto',
        fontFamily: 'var(--ds-font-family-code)',
        fontSize: 'var(--dshsh-panel-font, 12px)',
        lineHeight: 1.35,
        whiteSpace: 'pre',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dshsh-terminal-bg, var(--dsw-alias-markdown-code-segment-unselected))',
        tabSize: 4,
      },
      /** 状态行里的分隔符与数字（数字要 tabular-nums，否则刷新时宽度会抖）。 */
      sep: {
        opacity: 0.35,
      },
      num: {
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
      },
      stats: {
        display: 'flex',
        // 方案 B 要求「永远一行」：不换行，靠名字省略号吸收宽度变化
        flexWrap: 'nowrap',
        overflow: 'hidden',
        alignItems: 'center',
        gap: '6px',
        padding: '5px 10px',
        borderTop: '.5px solid var(--dsw-alias-border-l2)',
        fontSize: '11px',
        color: 'var(--dsw-alias-label-secondary)',
        fontFamily: 'var(--ds-font-family-code)',
      },
      inputRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '8px 10px',
        borderTop: '.5px solid var(--dsw-alias-border-l2)',
        borderRadius: '0 0 11px 11px',
      },
      input: {
        flex: 1,
        height: '30px',
        padding: '0 9px',
        borderRadius: '6px',
        border: '.5px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'var(--ds-font-family-code)',
        fontSize: '12px',
        outline: 'none',
      },
      inputLocked: {
        opacity: 0.55,
        cursor: 'not-allowed',
      },
    }

    function clamp(value, lo, hi) {
      if (hi < lo) return lo
      return value < lo ? lo : value > hi ? hi : value
    }

    /** 视口尺寸（对非浏览器环境也安全）。 */
    function viewport() {
      const w = typeof window !== 'undefined' && Number.isFinite(window.innerWidth) ? window.innerWidth : 1280
      const h = typeof window !== 'undefined' && Number.isFinite(window.innerHeight) ? window.innerHeight : 800
      return { w: w, h: h }
    }

    /** 把胶囊左上角夹进视口。 */
    function clampPoint(x, y) {
      const vp = viewport()
      return {
        x: clamp(Math.round(x), MARGIN, Math.max(MARGIN, vp.w - PILL_W - MARGIN)),
        y: clamp(Math.round(y), MARGIN, Math.max(MARGIN, vp.h - PILL_H - MARGIN)),
      }
    }

    /** 默认位置：右下角。 */
    function defaultPos() {
      const vp = viewport()
      return clampPoint(vp.w - PILL_W - 18, vp.h - PILL_H - 18)
    }

    function loadPos() {
      try {
        if (typeof localStorage === 'undefined') return null
        const raw = localStorage.getItem(POS_KEY)
        if (raw === null) return null
        const parsed = JSON.parse(raw)
        if (!Number.isFinite(parsed?.x) || !Number.isFinite(parsed?.y)) return null
        return clampPoint(parsed.x, parsed.y)
      } catch {
        return null
      }
    }

    function savePos(pos) {
      try {
        if (typeof localStorage === 'undefined') return
        localStorage.setItem(POS_KEY, JSON.stringify(pos))
      } catch {
        /* 隐私模式等场景下忽略 */
      }
    }

    /** 把面板矩形夹进视口，并保证不小于最小尺寸。 */
    function clampRect(rect) {
      const vp = viewport()
      const w = clamp(rect.w, MIN_W, Math.max(MIN_W, vp.w - MARGIN * 2))
      const h = clamp(rect.h, MIN_H, Math.max(MIN_H, vp.h - MARGIN * 2))
      return {
        w,
        h,
        left: clamp(rect.left, MARGIN, Math.max(MARGIN, vp.w - w - MARGIN)),
        top: clamp(rect.top, MARGIN, Math.max(MARGIN, vp.h - h - MARGIN)),
      }
    }

    /**
     * 按拖动方向计算新矩形。
     *
     * 从西/北侧缩小时，左上角必须跟着挪，且到达最小尺寸后要停止跟随 —— 否则面板会
     * 「一边缩小一边跑」，手感很怪。
     */
    function applyResize(base, dir, dx, dy) {
      let left = base.left
      let top = base.top
      let w = base.w
      let h = base.h
      if (dir.indexOf('e') >= 0) w = base.w + dx
      if (dir.indexOf('s') >= 0) h = base.h + dy
      if (dir.indexOf('w') >= 0) { w = base.w - dx; left = base.left + dx }
      if (dir.indexOf('n') >= 0) { h = base.h - dy; top = base.top + dy }
      if (w < MIN_W) {
        if (dir.indexOf('w') >= 0) left = base.left + base.w - MIN_W
        w = MIN_W
      }
      if (h < MIN_H) {
        if (dir.indexOf('n') >= 0) top = base.top + base.h - MIN_H
        h = MIN_H
      }
      return clampRect({ left, top, w, h })
    }

    function loadRect() {
      try {
        if (typeof localStorage === 'undefined') return null
        const raw = localStorage.getItem(RECT_KEY)
        if (raw === null) return null
        const parsed = JSON.parse(raw)
        if (![parsed?.left, parsed?.top, parsed?.w, parsed?.h].every(Number.isFinite)) return null
        return clampRect(parsed)
      } catch {
        return null
      }
    }

    function saveRect(rect) {
      try {
        if (typeof localStorage === 'undefined') return
        localStorage.setItem(RECT_KEY, JSON.stringify(rect))
      } catch {
        /* 忽略 */
      }
    }

    async function api(path, options) {
      const response = await fetch(BASE + path, options)
      const text = await response.text()
      let body
      try { body = JSON.parse(text) } catch { body = { error: text } }
      return { ok: response.ok, status: response.status, body }
    }

    /**
     * 浮层错误边界（2026-10）：任何渲染崩溃都变成**可见提示**，而不是"胶囊在、面板消失"。
     * 起因：三次同类事故（钩子位置/变量遮蔽）都表现为面板整棵消失，用户只能刷新页面、
     * 也看不到原因。有了这道边界，出了问题至少能读到一行原因。
     */
    class PanelBoundary extends react.Component {
      constructor (props) { super(props); this.state = { error: '' } }
      static getDerivedStateFromError (error) { return { error: String(error && error.message ? error.message : error) } }
      componentDidCatch (error) {
    try { console.error('[terminalkeeper] 面板显示失败：', error) } catch { /* 忽略 */ }
    // 统一消息系统：边界错误也要能被用户看到、被 /notice 记录（便于报问题）
    postNotice('error', '面板显示出错（插件本身没坏）· 错误码 ' + UI_ERR.RENDER, String(error && error.message ? error.message : error))
  }
      render () {
        if (this.state.error !== '') {
          return h('div', { className: 'dshsh-boundary' }, [
            h('div', { key: 't', className: 'dshsh-boundary-title' }, '⚠ 面板显示出错（插件本身没坏）· 错误码 PANEL_RENDER'),
            h('pre', { key: 'm', className: 'dshsh-boundary-msg' }, this.state.error),
            h('button', {
              key: 'c', type: 'button', className: 'dshsh-btn',
              onClick: () => {
                const text = 'terminalkeeper 面板显示错误：' + this.state.error
                try {
                  if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) void navigator.clipboard.writeText(text)
                  else if (typeof window !== 'undefined') window.prompt('复制下面这行发给作者：', text)
                } catch { /* 忽略 */ }
              },
            }, '复制错误'),
            h('button', {
              key: 'r', type: 'button', className: 'dshsh-btn',
              onClick: () => this.setState({ error: '' }),
            }, '重试'),
            h('button', {
              key: 'l', type: 'button', className: 'dshsh-btn',
              onClick: () => { try { window.location.reload() } catch { /* 忽略 */ } },
            }, '重载页面'),
          ])
        }
        return this.props.children
      }
    }
    /** 注册到 UI 的入口：包一层边界，内部仍是 ShellPanel。 */
    function PanelSurface () { return h(PanelBoundary, null, h(ShellPanel, null)) }

    function ShellPanel() {
      const [expanded, setExpanded] = react.useState(false)
      const [sessions, setSessions] = react.useState([])
      // 订阅列表（详情页「订阅」）：谁订阅了哪个 shell / 待读 / 注入统计（宿主 /list 下发）
      const [subscriptions, setSubscriptions] = react.useState([])
      const [server, setServer] = react.useState(null)
      const serverFeatures = server !== null && typeof server === 'object' && server.features !== null && typeof server.features === 'object' ? server.features : null
      const uiPrefs = server !== null && typeof server === 'object' && server.ui !== null && typeof server.ui === 'object' ? server.ui : {}
      const uiNumber = (key, fallback) => { const n = Number(uiPrefs[key]); return Number.isFinite(n) ? n : fallback }
      const uiPanelOpacity = uiNumber('panelOpacity', 70)
      const uiMenuOpacity = uiNumber('menuOpacity', 70)
      const uiTerminalBackground = typeof uiPrefs.terminalBackground === 'string' && uiPrefs.terminalBackground.trim() !== '' ? uiPrefs.terminalBackground.trim() : 'var(--dsw-alias-markdown-code-segment-unselected)'
      const uiPanelRadius = uiNumber('panelRadius', 12)
      const uiPanelFontSize = uiNumber('panelFontSize', 12)
      const uiPanelBlur = uiNumber('panelBlur', 6)
      const uiToastDuration = uiNumber('toastDurationMs', 6000)
      const uiToastMax = uiNumber('toastMax', 6)
      // 用**名字**而不是下标标记当前 shell：改名或增删都会让列表重排，
      // 下标一旦错位，面板就会莫名其妙跳到另一个 shell 上。
      const [selected, setSelected] = react.useState(() => {
        try {
          if (typeof localStorage === 'undefined') return ''
          return String(localStorage.getItem('terminalkeeper:selected') ?? '')
        } catch { return '' }
      })
      const [renaming, setRenaming] = react.useState('')
      // 手动锁（层级 2，只有人能设/解）：lockEditFor = 正在填原因的那一行
      const [lockEditFor, setLockEditFor] = react.useState('')
      // 操作统一走多选条（用户拍板：不再保留行内 ⋮ —— 选一个也能操作，前端只留一套面）
      const [batchToolsOpen, setBatchToolsOpen] = react.useState('')
      const [batchSizeDraft, setBatchSizeDraft] = react.useState({ cols: '120', rows: '32' })
      const [batchLockNote, setBatchLockNote] = react.useState('')
      const [lockNote, setLockNote] = react.useState('')
      // 面板开合：把动作交给官方快捷键系统（apply 阶段拿不到 React state，所以挂在这里）。
      // 同时订阅快捷键状态，让详情页键位表显示**当前实际生效**的键位（含用户在设置里的自定义）。
      react.useEffect(() => {
        shellPanelToggle = () => setExpanded((v) => !v)
        const onChange = () => setShortcutTick((t) => t + 1)
        shellShortcutListeners.add(onChange)
        setShortcutTick((t) => t + 1)   // 挂载时对齐一次（注册可能先于组件挂载）
        return () => {
          if (shellPanelToggle !== null) shellPanelToggle = null
          shellShortcutListeners.delete(onChange)
        }
      }, [])
      // 0.3.4 会话选择器统一：搜索 + 排序（默认最近活跃；搜索含名称/ID/创建者）
      const [pickerQuery, setPickerQuery] = react.useState('')
      // 创建者筛选（放在搜索行左侧，与搜索同一行 —— 用户要求“空间利用更合理”）
      const [pickerOwnerFilter, setPickerOwnerFilter] = react.useState('')
      const [pickerSortKey, setPickerSortKey] = react.useState('updated')
      const [pickerSortDir, setPickerSortDir] = react.useState('desc')
      // 关闭按钮的待确认态：3 秒内没有第二次点击就自动复位
      const [closeArmed, setCloseArmed] = react.useState(false)
      const closeArmTimer = react.useRef(null)
      // 授权按钮：主动授权是两下（第二下才真的授权），撤销是一下（安全方向无需确认）
      const [consentArmed, setConsentArmed] = react.useState(false)
      const consentArmTimer = react.useRef(null)
      const [consentBusy, setConsentBusy] = react.useState(false)
      // 授权浮层：档位 × 时间两个维度 + 已授权会话列表
      const [consentMenuOpen, setConsentMenuOpen] = react.useState(false)
      // 授权浮层两个页签：'actor'（会话授权，最常用）| 'secrets'（引用库）
      const [consentTab, setConsentTab] = react.useState('actor')
      // 默认授权规则草稿（新模型：出厂 = deny；保存即 set-default）
      const [draftScope, setDraftScope] = react.useState('deny')
      const [draftTtl, setDraftTtl] = react.useState('10m')
      const [customMinutes, setCustomMinutes] = react.useState('30')
      // 「按对话授权」：候选对话列表（/actors）+ 搜索词 + 选中项 + 该项的档位/有效期草稿
      const [actors, setActors] = react.useState(null)          // null = 还没拉
      const [actorQuery, setActorQuery] = react.useState('')     // 搜索词（按 id / 标题 / 子代理）
      // "显示更多"：默认只列相关的（本对话/最近/已授权，且不含子 agent）；展开后按谱系树列出全部
      const [actorShowAll, setActorShowAll] = react.useState(false)
      // 0.3.4 会话列表统一 UI.List：排序键 name|updated|granted
      const [actorSortKey, setActorSortKey] = react.useState('updated')
      const [actorSortDir, setActorSortDir] = react.useState('desc')
      const [actorPick, setActorPick] = react.useState(null)     // 选中的 { id, title }
      const [actorScope, setActorScope] = react.useState('read')
      const [actorTtl, setActorTtl] = react.useState('10m')
      // 宿主没有对话目录时的「手工填 id」草稿；有目录时的搜索词在 actorQuery
      const [actorManual, setActorManual] = react.useState('')
      // 0.3.0「引用库」页签：vault 人写（AI 只见键名）；宏人+AI 可写（全量入封链）
      const [secretsTab, setSecretsTab] = react.useState('vault')  // 'vault' | 'macros'
      // 0.3.4：secrets 表格排序（组件化后表头点击驱动）
      const [secretsSortKey, setSecretsSortKey] = react.useState('key')
      const [secretsSortDir, setSecretsSortDir] = react.useState('asc')
      // 0.3.4 列表三部分：秘密域 / 宏 各自的搜索词（排序走表头）
      const [vaultQuery, setVaultQuery] = react.useState('')
      const [macroQuery, setMacroQuery] = react.useState('')
      // 0.3.4：默认全部高度给表格；点「＋ 新增」或列表为空时，下方才弹出录入表单
      const [vaultFormOpen, setVaultFormOpen] = react.useState(false)
      const [macroFormOpen, setMacroFormOpen] = react.useState(false)
      const [macroSortKey, setMacroSortKey] = react.useState('name')
      const [macroSortDir, setMacroSortDir] = react.useState('asc')
      const [secretsData, setSecretsData] = react.useState(null)   // {vault:[],macros:[]}
      const [secretsBusy, setSecretsBusy] = react.useState(false)
      const [secretsDelConfirm, setSecretsDelConfirm] = react.useState('')   // 键值对删除：二次确认（与日志页文件删除同模式）
      const [groupDelConfirm, setGroupDelConfirm] = react.useState('')       // 引用组删除：同一套两步确认
      const [groupDelForce, setGroupDelForce] = react.useState('')   // 组非空时的第三次确认（连键销毁）
      const [vKey, setVKey] = react.useState('')
      const [vVal, setVVal] = react.useState('')
      // 0.4.1：不再有「一次性」与「有效期（天）」；有效期改为绝对时间点
      const [vExp, setVExp] = react.useState('')            // 有效期至（datetime-local，秒级）
      // 0.4.1 信息架构：秘密域分「键值对」与「引用组」两个子页；键值对必须归属某个引用组
      const [vaultSub, setVaultSub] = react.useState('keys')
      // 引用组表格（复用 UI.List ⇒ 自带搜索/排序/筛选）
      const [groupQuery, setGroupQuery] = react.useState('')
      const [groupSortKey, setGroupSortKey] = react.useState('')
      const [groupSortDir, setGroupSortDir] = react.useState('')   // 'keys' | 'groups'
      const [vGroup, setVGroup] = react.useState('')           // '' = 默认引用组
      const [vNote, setVNote] = react.useState('')
      const [copiedKey, setCopiedKey] = react.useState('')  // 0.3.2：键名点击复制的瞬时反馈
      const [secretsWarn, setSecretsWarn] = react.useState([])  // 0.3.2 ②：弱形状黄条（录入后回显）
      // 0.4.1 引用组：口令（**掩码输入，永远不写进配置、不进审计**）/ 剩余次数上限 / 提权开关 / 同名重建确认
      const [vPass, setVPass] = react.useState('')          // 组口令（仅加密组用；只在内存）
      const [vNewGroup, setVNewGroup] = react.useState('')   // 新组名（与口令分开：原先误用同一个 state，
      // 新建组时的加密方式：none（不加密，默认）| passphrase（口令加密）
      const [vNewMode, setVNewMode] = react.useState('none')
      // 落盘开关（仅创建时可选）：勾选＝写盘（默认）；取消＝只在本次运行内存里，重启即消失。
      const [vPersist, setVPersist] = react.useState(true)
      // 操作列里每个口令组的小口令框内容（按组名索引）。刻意用 null 初始化：
      // 客户端夹具用「唯一的空普通对象」定位 draft 单元，再放一个 {} 会带偏它。
      const [rowPass, setRowPass] = react.useState(null)
      // 解密小菜单：{ group, pass } 或 null（用户要求：操作列不再挤输入框，点「解密」弹出小菜单）
      const [unlockMenu, setUnlockMenu] = react.useState(null)
      const unlockRef = react.useRef(null)   // 指向 <dialog>（顶级层，不受祖先 transform/overflow 影响）
      // 编辑态：vEditFrom 非空 = 正在修改某个已有组，保存即覆盖（改名 + 改加密方式）
      const [vEditFrom, setVEditFrom] = react.useState('')
      const [vEditMode0, setVEditMode0] = react.useState('none')   // 进入编辑时的原始模式（判断要不要改模式）

      /** 输入的名字是否已存在于现有引用组（用户要求：据此显示「修改」或「新建」，而不是写死编辑态）。 */
      const nameTyped = vNewGroup.trim()
      const nameExists = nameTyped !== '' && (Array.isArray(secretsData?.groups) ? secretsData.groups : []).some((g) => g.group === nameTyped)
      /** 覆盖保存时的「来源组名」：非空＝这次是修改（会覆盖），空＝新建。 */
      const saveFrom = nameExists === true ? '' : vEditFrom

      /**
       * 保存引用组（用户要求：操作栏只留「修改/删除」，加密方式在**表单**里选，未来扩展只动表单）。
       *   · vEditFrom 为空 ⇒ 新建（一次性带 mode/passphrase，服务端同批落盘）
       *   · vEditFrom 非空 ⇒ **覆盖保存**：名字变了先改名、模式变了再改模式；任一失败都报错，
       *     绝不静默跳过（这正是之前"选了加密方式却仍是不加密"的根因形态）
       */
      const saveGroup = async () => {
        const name = vNewGroup.trim()
        if (name === '') { setError('请先在上面填写组名'); return }
        if (vNewMode === 'passphrase' && vPass === '') { setError('选择了「口令加密」就必须填写组口令（口令只在内存，不会落盘）'); return }
        setSecretsBusy(true)
        try {
          let ok = true
          if (nameExists === true) {
            // 输入的名字**已有组** ⇒ 这就是一次「修改」：绝不新建，只按需改加密方式
            // （填了口令＝同时解锁：/vault-mode 会把 KEK 装进内存）
            if (vNewMode !== vEditMode0 || vPass !== '') {
              ok = await secretsPost('/vault-mode', { group: name, mode: vNewMode, passphrase: vPass }, '已修改「' + name + '」的加密方式：' + vNewMode)
            }
          } else if (saveFrom === '') {
            ok = await secretsPost('/vault-group-set', { action: 'create', name, mode: vNewMode, passphrase: vPass, persist: vPersist }, '已创建引用组 ' + name)
          } else {
            if (name !== saveFrom) {
              ok = await secretsPost('/vault-group-set', { action: 'rename', name: saveFrom, to: name }, '已把组改名为 ' + name)
            }
            if (ok === true && (vNewMode !== vEditMode0 || vPass !== '')) {
              ok = await secretsPost('/vault-mode', { group: name, mode: vNewMode, passphrase: vPass }, '已保存加密方式：' + vNewMode)
            }
          }
          if (ok === true) { setVNewGroup(''); setVPass(''); setVEditFrom(''); setVEditMode0('none'); loadSecrets() }
        } finally { setSecretsBusy(false) }
      }

      /** 小浮层：打开时 showModal()（进顶级层）；注入透明 ::backdrop（不依赖面板样式表）；关闭时 close()。 */
      react.useEffect(() => {
        const d = unlockRef.current
        if (unlockMenu === null || d === null || d === undefined) return undefined
        if (typeof d.showModal === 'function') {
          if (d.open !== true) { try { d.showModal() } catch (e2) { d.setAttribute('open', '') } }
        } else if (typeof d.setAttribute === 'function') d.setAttribute('open', '')
        if (typeof document !== 'undefined') {
          let st = document.getElementById('dshsh-unlock-style')
          if (st === null) {
            st = document.createElement('style'); st.id = 'dshsh-unlock-style'
            st.textContent = 'dialog.dshsh-unlock-pop::backdrop{background:transparent}'
            document.head.appendChild(st)
          }
        }
        return () => { if (d !== null && d !== undefined && typeof d.close === 'function' && d.open === true) { try { d.close() } catch (e2) {} } }
      }, [unlockMenu !== null])

      /** 小浮层打开时：Esc 关闭（dialog 的 cancel 也会触发）。关闭后自动注销监听。 */
      react.useEffect(() => {
        if (unlockMenu === null) return undefined
        const onKey = (e2) => { if (e2.key === 'Escape') setUnlockMenu(null) }
        // 点在小窗**之外**的任意位置即关闭（用文档级监听，而非铺满屏幕的透明层 —— 后者会把 UI 盖住）
        const onDown = (e2) => {
          const el = unlockRef.current
          if (el !== null && el !== undefined && typeof el.contains === 'function' && e2.target !== null && e2.target !== undefined && el.contains(e2.target) === true) return
          setUnlockMenu(null)
        }
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
          document.addEventListener('keydown', onKey)
          document.addEventListener('mousedown', onDown)
        }
        return () => {
          if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
            document.removeEventListener('keydown', onKey)
            document.removeEventListener('mousedown', onDown)
          }
        }
      }, [unlockMenu !== null])

      /** 解密小菜单的「确定」：用菜单里的口令解锁；成功后关菜单并重拉列表（Enter 也可提交）。 */
      const doUnlock = async () => {
        if (unlockMenu === null) return
        const p = String(unlockMenu.pass ?? '')
        if (p === '') { setError('请输入该组口令再点确定'); return }
        const ok = await secretsPost('/vault-unlock', { group: unlockMenu.group, passphrase: p })
        if (ok === true) { setUnlockMenu(null); loadSecrets() }
      }

      /** 切换说明文字：写用户偏好（localStorage，不入链）；存不上也不影响切换本身 */
      const toggleHints = () => setHintsOn((prev) => {
        const next = prev !== true
        try {
          const pref = loadTableStore('prefs')
          saveTableStore('prefs', Object.assign({}, pref !== null && typeof pref === 'object' ? pref : {}, { hintsOn: next }))
        } catch { /* 忽略：偏好写失败不影响当前会话内的切换 */ }
        return next
      })
      // 用户要求：右上角眼睛图标切换「说明文本」—— 开 = 现详细说明；关 = 只显示输入框名称
      // 用户要求：说明/仅名称作为**用户偏好**持久化（存 localStorage，与列宽/筛选同一套机制，不入审计链）
      const [hintsOn, setHintsOn] = react.useState(() => {
        const pref = loadTableStore('prefs')
        return pref !== null && typeof pref === 'object' && pref.hintsOn === false ? false : true
      })
                                                             // 导致在任一框输入时两处同时显示）
      const [vMax, setVMax] = react.useState('')
      const [vReuseOk, setVReuseOk] = react.useState(false)
      const [secretsExtra, setSecretsExtra] = react.useState(null) // 0.3.2 ④⑪：{history, chain}
      const [mName, setMName] = react.useState('')
      const [mText, setMText] = react.useState('')
      const [mScope, setMScope] = react.useState('global')
      const [mSubmit, setMSubmit] = react.useState(true)
      const [mNote, setMNote] = react.useState('')
      const [renameDraft, setRenameDraft] = react.useState('')
      const [screen, setScreen] = react.useState('')
      const [meta, setMeta] = react.useState(null)
      const [locked, setLocked] = react.useState(true)
      const [error, setErrorRaw] = react.useState('')
      // 0.4.1 用户要求：**所有提示信息都走新的提示系统**（右上角提示条 / 详情「提示信息」历史），
      // 输入框下方那套旧提示区域一律弃用 ⇒ setError 变成向 notify 投递（空串表示清除，不投递）。
      const setError = (msg) => {
        const text = String(msg ?? '')
        if (text === '') { setErrorRaw(''); return }
        setErrorRaw('')
        notify(/失败|错误|出错|不可|拒绝|REFUSED|非法|未找到|不能/.test(text) ? 'error' : 'warn', text)
      }
      /**
       * 读屏失败的处理（2026-10，修用户实测的“警告刷屏”）：面板停在一个**已被回收**的壳上时
       * 每次轮询都失败 ⇒ 旧的 setError 每次都 notify('warn') ⇒ 一天 16 条同类警告（实测间隔
       * 0.35–1.14s，涉及 2 个死壳）。现在：缺会话是**状态**不是错误 —— 静默切走 + 只提示一次；
       * 真错误按 key 去重（60 秒内同一条只提示一次），错误条本体仍然显示。
       */
      const GONE_RE = /can't find (session|pane|window)|no such (session|pane|window)|session not found|pane not found|会话已不存在/i
      const screenFailRef = react.useRef({ gone: '', key: '', at: 0 })
      /** 标记"这个壳是我们自己正在关的"（15 秒内收到 gone 就静默处理）。 */
      const markClosing = (name) => {
        const key = String(name ?? '')
        if (key !== '') closingRef.current.set(key, Date.now() + 15000)
      }
      const isClosing = (name) => {
        const key = String(name ?? '')
        const until = closingRef.current.get(key)
        if (until === undefined) return false
        if (Date.now() > until) { closingRef.current.delete(key); return false }
        return true
      }

      const handleScreenFailure = (body, fallback) => {
        const o = (body !== null && typeof body === 'object') ? body : {}
        const raw = typeof o.error === 'string' && o.error !== '' ? o.error : String(fallback ?? '')
        if (o.gone === true || GONE_RE.test(raw)) {
          setErrorRaw('')
          const goneName = String(o.name ?? currentName ?? '')
          // 我们自己刚关掉的壳：静默（不提示"可能已被回收"，也不写历史）
          if (isClosing(goneName)) { if (selected !== '') setSelected(''); return }
          const gkey = 'gone:' + goneName
          if (screenFailRef.current.gone !== gkey) {
            screenFailRef.current.gone = gkey
            notify('info', '会话已不存在', '该会话可能已被回收，已自动切换到可用会话')
          }
          if (selected !== '') setSelected('')
          return
        }
        if (raw === '') return
        setErrorRaw(raw)
        const key = 'error:' + raw.slice(0, 80)
        const now = Date.now()
        const st = screenFailRef.current
        if (st.key === key && now - st.at < 60000) return
        screenFailRef.current = { gone: '', key, at: now }
        notify(/失败|错误|出错|不可|拒绝|REFUSED|非法|未找到|不能/.test(raw) ? 'error' : 'warn', raw)
      }
      // 「不是错误，但必须让你知道」的消息 —— 例如改名时净化改写了你输入的名字。
      // 与 error 分开：那种情况用红色报错是误导（操作确实成功了），但不说就等于静默改写。
      // 0.4.1：旧「输入框下方提示」机制**整体弃用** —— 统一走 notify（右上角提示条 + 提示信息历史）。
      // 保留同名兼容壳：空串=清除（无操作），非空=投递到提示系统，故既有调用点无需改写。
      const setNotice = (msg) => { const tx = String(msg ?? ''); if (tx !== '') notify('warn', tx) }
      /**
       * 提示信息缓冲池（0.4.0 用户要求）：最多同屏 6 条，按时间从上到下排列，
       * 每条含 时间 / 等级 / 简述 / 详细；由 CSS 动画负责倒计时条、淡出与悬停暂停。
       */
      const [toasts, setToasts] = react.useState([])
      // 0.4.1 用户要求：启动/切换会话时终端画面可能等待较久 ⇒ 加**正计时**，把加载耗时显式暴露出来。
      // 语义：从「开始等待当前会话首帧」计时；首帧到达即冻结（首帧 X.Xs），否则持续累加（已等待 X.Xs）。
      const [screenSince, setScreenSince] = react.useState(() => Date.now())
      const [screenFirstAt, setScreenFirstAt] = react.useState(null)
      const [screenTick, setScreenTick] = react.useState(0)
      const [visibilityTick, setVisibilityTick] = react.useState(0)

      const toastSeq = react.useRef(0)
      const notifyRef = react.useRef(null)
      const featureNoticeSigRef = react.useRef('')
      const TOAST_MAX = 6
      const TOAST_MS = 6000          // 兜底；实际停留由 ui.toastDurationMs 下发
      const toastMaxCount = Number.isFinite(uiToastMax) ? uiToastMax : TOAST_MAX
      // 报错时**主动带上相关 shell 的 id**（用户要求）：第 4 参可显式给，缺省用当前会话。
      const lastToastSigRef = react.useRef({ sig: '', at: 0 })
      const notify = (level, brief, detail, shell) => {
        const briefText = String(brief ?? '')
        const detailText = String(detail ?? '')
        // 去重：同一条（等级+标题+详情）在 1.2s 内重复触发只弹一次。
        // 多入口（setError / 组件 / 同一操作发两次请求）都可能撞车，这里兜底。
        const sig = String(level) + '\u0000' + briefText + '\u0000' + detailText
        const nowMs = Date.now()
        if (lastToastSigRef.current.sig === sig && nowMs - lastToastSigRef.current.at < 1200) return
        lastToastSigRef.current = { sig, at: nowMs }
        const id = ++toastSeq.current
        const at = nowMs
        setToasts((prev) => (Array.isArray(prev) ? prev : []).concat([{
          id, at, level, brief: briefText, detail: detailText,
          shell: String(shell ?? selected ?? ''),
        }]).slice(-toastMaxCount))
        // 落盘以便复盘（best-effort：写失败只是少一条历史，绝不影响提示本身）
        void api('/notice', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ at, level, brief: briefText, detail: detailText, shell: String(shell ?? selected ?? '') }),
        }).catch(() => {})
      }
      notifyRef.current = notify
      react.useEffect(() => {
        const sink = (level, brief, detail, shell) => { notifyRef.current?.(level, brief, detail, shell) }
        NOTICE_BUS = sink
        const queued = NOTICE_QUEUE.splice(0)
        for (const item of queued) sink(...item)
        return () => { if (NOTICE_BUS === sink) NOTICE_BUS = null }
      }, [])
      /** 旧的 setNotice 文案自动升级成 toast（按内容猜等级），无需逐个改调用点。 */

      const [busy, setBusy] = react.useState(false)
      // 输入框里是否有残留文本（正常情况下它应始终为空；有残留说明自动提交漏了一次）
      const [residual, setResidual] = react.useState(false)
      // shell 选择器（多 shell 时用来直接跳转，而不是一次次点箭头）
      const [pickerOpen, setPickerOpen] = react.useState(false)
      // ⓘ 详情层：与选择器互斥（两个浮层同时开着会叠在一起）
      // 0.3.4 列表三部分：列宽（可手动拖动）与筛选值按「表 id」各自保存，localStorage 持久化
      // —— 手动调过列宽/筛选项，下次打开还在（符合"表可以手动调整"的预期）。
      // 用户要求：手动调整的列宽**只在本次运行内有效**（重启后回到默认填充策略）⇒
      // 初始为空对象，且不再从 localStorage 恢复。
      const [tableWidths, setTableWidths] = react.useState({})
      const [tableFilters, setTableFilters] = react.useState(() => loadTableStore('filter'))
      /**
       * 读某张表保存的列宽，并**归一化到 100%**。
       * 只接受百分比（旧版存的是像素：在窄面板下会把表格撑出横向滚动条 → 忽略，交回自适应布局）。
       * 归一化的意义：拖宽某一列时，其余列按比例让位，总和恒为 100% —— 表格永远不会溢出容器。
       */

      const widthsOf = (tableId) => {
        const raw = tableWidths[tableId]
        if (raw === null || typeof raw !== 'object') return {}
        // 不把各列归一化到 100%（用户要求：改一列不得挤压其它列）——原样返回，允许各列之和 >100%，
        // 由 UI.Table 把表格整体加宽、交给滚动容器出现横向滚动条。旧版像素值忽略（交回自适应）。
        const out = {}
        for (const key of Object.keys(raw)) {
          const v = raw[key]
          const n = typeof v === 'string' && v.slice(-1) === '%' ? Number.parseFloat(v) : Number.NaN
          if (Number.isFinite(n) && n > 0) out[key] = String(n) + '%'
        }
        return out
      }
      const filtersOf = (tableId) => (tableFilters[tableId] !== null && typeof tableFilters[tableId] === 'object' ? tableFilters[tableId] : {})
      // 注意：value 现在是 'x%'（表宽百分比），不是像素 —— 见 widthsOf 的归一化
      const onColResize = (tableId) => (colKey, px) => setTableWidths((prev) => {
        const next = { ...prev, [tableId]: { ...(prev[tableId] ?? {}), [colKey]: px } }
        // 不再持久化列宽（用户要求：仅本次运行内有效，重启即回到默认填充策略）
        return next
      })
      const onColFilter = (tableId) => (colKey, value) => setTableFilters((prev) => {
        const next = { ...prev, [tableId]: { ...(prev[tableId] ?? {}), [colKey]: value } }
        saveTableStore('filter', next)
        return next
      })
      const [infoOpen, setInfoOpen] = react.useState(false)
      // 插件内设置页：与 DSH 设置页共用同一个 SettingsCard + /settings 后端。
      const [settingsOpen, setSettingsOpen] = react.useState(false)
      // 0.3.4 引用库独立浮层（与授权管理分开：授权=权限，引用库=秘密/宏）
      const [secretsOpen, setSecretsOpen] = react.useState(false)
      // 用户要求：**关闭引用库界面时清空本页所有输入框**（含两个子页的表单与搜索框）。
      //   理由：口令 / 键名 / 值这类敏感输入不该在关闭后仍留在界面上；下次打开应是干净的新建态。
      //   注意 vEditFrom / vEditMode0 也要复位 —— 否则下次打开会莫名其妙处于「修改」态。
      const vaultWasOpenRef = react.useRef(false)
      react.useEffect(() => {
        if (secretsOpen === true) { vaultWasOpenRef.current = true; return }
        if (vaultWasOpenRef.current !== true) return          // 只在「打开 → 关闭」这一次清空
        vaultWasOpenRef.current = false
        setVKey(''); setVVal(''); setVNote(''); setVExp(''); setVGroup(''); setVMax('')
        setVPass(''); setVNewGroup(''); setVNewMode('none'); setVEditFrom(''); setVEditMode0('none'); setVReuseOk(false)
        // 只清**引用库界面自己的**搜索框：vaultQuery（键值对）/ macroQuery（宏）/ groupQuery（引用组）；
        // pickerQuery / actorQuery 属于 shell 选择器与授权对象，不在本页，**不能**顺手清掉
        setVaultQuery(''); setMacroQuery(''); setGroupQuery('')
      }, [secretsOpen])
      // 0.3.4 日志管理浮层：列审计/留痕文件 + 删除（先入链见证再删）
      const [logOpen, setLogOpen] = react.useState(false)
      const [logData, setLogData] = react.useState(null)        // { auditFiles, outputFiles, chain }
      const [logBusy, setLogBusy] = react.useState(false)
      const [logConfirm, setLogConfirm] = react.useState('')    // 待二次确认的文件名（''=无）
      // 0.3.4 升级：子页签 + 排序 + 搜索 + 选中详情
      const [logTab, setLogTab] = react.useState('audit')       // 'audit' | 'output'
      const [logQuery, setLogQuery] = react.useState('')        // 文件名搜索
      const [logSortKey, setLogSortKey] = react.useState('name')
      const [logSortDir, setLogSortDir] = react.useState('asc')
      const [logSelected, setLogSelected] = react.useState(null) // 选中的 {kind, name}
      const [logDetail, setLogDetail] = react.useState(null)    // 详情 {lines, bytes, events?, head, tail}
      /** 当前正在查看的文件名：慢请求回来时用它判竞态（用户可能已经点了别的文件）。 */
      var logDetailNameRef = react.useRef('')
      const loadLogDetail = react.useCallback(async (kind, name) => {
        if (name === '') return
        logDetailNameRef.current = name
        setLogSelected({ kind, name })
        // 同一文件看第二次：直接用缓存，不再往返（用户来回点列表时最明显）
        const cacheKey = kind + ':' + name
        const hit = logDetailCacheMap.get(cacheKey)
        if (hit !== undefined) { setLogDetail(hit); return }
        setLogDetail(null)
        const base = '/audit-files?detail=' + encodeURIComponent(name) + '&kind=' + kind
        try {
          // 先拿"快的那一半"：服务端只读文件头尾各 8KB → 开头/结尾/字节数立刻可见
          const quick = await api(base)
          if (!quick.ok) { setLogDetail({ error: quick.body?.error ?? '读取失败' }); return }
          setLogDetail(quick.body)
          const pending = quick.body !== null && typeof quick.body === 'object' && quick.body.statsPending === true
          if (!pending) { logDetailCacheMap.set(cacheKey, quick.body); return }
          // 慢的那一半（行数 + 事件统计）后台补：界面已经可读，不必再干等"读取详情…"
          const full = await api(base + '&stats=1')
          if (!full.ok) return
          if (logDetailNameRef.current !== name) return   // 用户已经切到别的文件，别用旧结果覆盖
          const merged = { ...quick.body, ...full.body, statsPending: false }
          logDetailCacheMap.set(cacheKey, merged)
          setLogDetail(merged)
        } catch {
          if (logDetailNameRef.current === name) setLogDetail({ error: withCode('连不上 DSH', UI_ERR.UNREACHABLE) })
        }
      }, [])
      const logLoadedRef = react.useRef(false)
      const logLastRef = react.useRef(0)
      const loadLogs = react.useCallback(async (force) => {
        const now = Date.now()
        if (force !== true && now - logLastRef.current < 20000) return
        logLastRef.current = now
        // 有缓存就不显示「读取中」——先用旧列表渲染，后台静默刷新（stale-while-revalidate）
        if (!logLoadedRef.current) setLogBusy(true)
        try {
          const result = await api('/audit-files')
          setLogData(result.ok ? result.body : { error: result.body?.error ?? '读取失败', auditFiles: [], outputFiles: [] })
          logLoadedRef.current = true
        } catch {
          setLogData({ error: withCode('连不上 DSH', UI_ERR.UNREACHABLE), auditFiles: [], outputFiles: [] })
        } finally {
          setLogBusy(false)
        }
      }, [])
      react.useEffect(() => {
        if (!logOpen) return undefined
        setLogConfirm('')
        void loadLogs()
        return undefined
      }, [logOpen, loadLogs])
      react.useEffect(() => {
        if (!logOpen) return undefined
        setLogConfirm('')
        void loadLogs()
        return undefined
      }, [logOpen, loadLogs])
      const purgeFile = async (kind, name) => {
        setLogBusy(true)
        try {
          const result = await api('/audit-files', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'purge', kind, names: [name] }),
          })
          postNotice(result.ok ? 'info' : 'warn', result.ok ? '已删除并写入见证（event:purge）' : '删除失败', result.ok ? '' : String(result.body?.error ?? ''))
          setLogConfirm('')
          void loadLogs(true)
        } catch (err) {
          postNotice('error', '删除失败', String(err && err.message ? err.message : err))
          setLogConfirm('')
        } finally {
          setLogBusy(false)
        }
      }
      // 0.3.3 #3 播放器：null=关；{file, frames, idx, playing, speed, loading, error}。
      // 打开时整个屏幕区换成回放帧（直播的 screen 状态照常活着，退出即回）。
      const [replay, setReplay] = react.useState(null)
      /**
       * 详情页的折叠卡片状态（2026-09-22 整理后：10 个逻辑分组 → 6 张卡片）。
       * 默认只展开高频的两张（会话 / 安全），系统与关于折起来 —— 37 行平铺缩到首屏 8 行左右。
       * 键是卡片名；缺省（undefined）按 DEFAULT_OPEN 处理。
       */
      const [pluginStatus, setPluginStatus] = react.useState(null)
      const [pluginStatusError, setPluginStatusError] = react.useState('')
      const [infoLayer, setInfoLayer] = react.useState('status')
      const [infoTab, setInfoTab] = react.useState('总览')
      const visibleInfoLayers = INFO_LAYERS.map((layer) => ({
        ...layer,
        tabs: layer.tabs.filter((tab) => {
          if (tab === '安全' || tab === '日志审计') return serverFeatures === null || serverFeatures.audit !== false
          if (tab === '引用库事件') return serverFeatures === null || serverFeatures.vault !== false
          return true
        }),
      })).filter((layer) => layer.tabs.length > 0)
      react.useEffect(() => {
        const allowed = visibleInfoLayers.flatMap((layer) => layer.tabs)
        if (allowed.includes(infoTab) !== true) {
          const first = visibleInfoLayers[0]
          setInfoLayer(first !== undefined ? first.key : 'status')
          setInfoTab(first !== undefined && first.tabs.length > 0 ? first.tabs[0] : '概览')
        }
      }, [infoTab, serverFeatures])
      // 日志页移入详情后，切到「历史记录 → 日志审计」时按需加载（不占独立浮层）。
      react.useEffect(() => {
        if (infoOpen && infoTab === '日志审计') void loadLogs()
      }, [infoOpen, infoTab, loadLogs])
      const [auditScan, setAuditScan] = react.useState(null)
      // 提示信息历史（磁盘 /notice）：null=未加载 / 数组=记录 / {error}=失败

      react.useEffect(() => {
        // 用户反馈：提示信息打开太慢 ⇒ 打开详情即预取（不再等切到该页签才发请求）；已加载则不重复拉
        if (!infoOpen) return undefined
        if (noticesLoadedRef.current === true) return undefined
        let alive = true
        void (async () => {
          try {
            const result = await api('/notice?limit=200')
            if (alive !== true) return
            noticesLoadedRef.current = true
            setNotices(result.ok === true
              ? (Array.isArray(result.body.items) ? result.body.items : [])
              : { error: String(result.body?.error ?? '读取失败') })
          } catch (error) {
            if (alive === true) setNotices({ error: String(error?.message ?? error) })
          }
        })()
        return () => { alive = false }
      }, [infoOpen, infoTab])
      // 「插件状态」页签：读宿主 /status（启动全流程真信号）；失败保持 null，不刷屏报错
      react.useEffect(() => {
        // 2026-10-24：页签收拢后「插件状态」并入「运行」；这里若仍判断旧的「插件」页签，
        // /status 永远不会被请求 ⇒ 该段永远停在「读取中」。
        if (!infoOpen || infoTab !== '运行') return undefined
        let alive = true
        void (async () => {
          try {
            const r = await api('/status')
            // api() returns { ok, status, body }; data lives in body. Using the whole
            // envelope made stages/conclusion/checkedAt undefined (page showed unknown/-/-).
            const payload = r !== null && typeof r === 'object' && r.body !== null && typeof r.body === 'object' ? r.body : null
            if (alive) {
              setPluginStatus(payload === null ? null : (r.ok === true ? payload : Object.assign({}, payload, { __httpStatus: r.status })))
              setPluginStatusError(payload === null ? withCode('DSH 没有返回启动状态', UI_ERR.TOO_OLD) : '')
            }
          } catch (error) { if (alive) { setPluginStatus(null); setPluginStatusError(withCode(String(error && error.message ? error.message : error), UI_ERR.UNREACHABLE)) } }
        })()
        return () => { alive = false }
      }, [infoOpen, infoTab])

      // 键事件页签取数（0.4.1）：宿主 /vault-history 返回 { items: [...] }（与 loadSecrets 里一致）；
      // 兼容 history / 裸数组形态，避免结构变化时页签静默停在「读取中」
      react.useEffect(() => {
        if (!infoOpen) return undefined
        if (vaultHistoryLoadedRef.current === true) return undefined
        let alive = true
        void (async () => {
          try {
            const result = await api('/vault-history')
            if (alive !== true) return
            const body = result.ok === true ? result.body : null
            const list = Array.isArray(body?.items) ? body.items
              : Array.isArray(body?.history) ? body.history
                : Array.isArray(body) ? body : null
            vaultHistoryLoadedRef.current = true
            setVaultHistory(list !== null ? list : { error: String(body?.error ?? '读取失败') })
          } catch (error) {
            if (alive === true) setVaultHistory({ error: String(error?.message ?? error) })
          }
        })()
        return () => { alive = false }
      }, [infoOpen, infoTab])
      // 0.4.1：提示信息界面加**搜索 + 三个筛选项**（等级 / 会话 / 时间）
      // 键事件（详情新页签）：null=未加载 / 数组=记录 / {error}=失败
      const [vaultHistory, setVaultHistory] = react.useState(null)
      const [vaultEventQuery, setVaultEventQuery] = react.useState('')
      const [vaultEventSortKey, setVaultEventSortKey] = react.useState('')
      const [vaultEventSortDir, setVaultEventSortDir] = react.useState('')
      const noticesLoadedRef = react.useRef(false)      // 已加载过就不再重复请求（切页签不重拉）
      const vaultHistoryLoadedRef = react.useRef(false)
      const [noticeQuery, setNoticeQuery] = react.useState('')
      const [noticeLevel, setNoticeLevel] = react.useState('')
      const [noticeMenu, setNoticeMenu] = react.useState('')   // 提示信息页：筛选菜单当前展开项
      const [noticeMenuCat, setNoticeMenuCat] = react.useState('')   // 提示信息页：右侧子面板展开哪个筛选项
      // 提示信息页的筛选菜单：点击页面其它位置即关闭（列表页 FilterRow 自带同样逻辑；
      // 此前该页没有 ⇒ 用户反映点了别处菜单不消失）。捕获阶段监听，图标/选项点击不受影响。
      react.useEffect(() => {
        if (noticeMenu === '') return undefined
        const onDown = (ev) => {
          const t = ev !== null && ev !== undefined ? ev.target : null
          if (t !== null && t !== undefined && typeof t.closest === 'function' && t.closest('.dshsh-fmenu') !== null) return
          setNoticeMenu('')
          setNoticeMenuCat('')
        }
        document.addEventListener('mousedown', onDown, true)
        return () => document.removeEventListener('mousedown', onDown, true)
      }, [noticeMenu])
      const [noticeShell, setNoticeShell] = react.useState('')
      const [noticeAge, setNoticeAge] = react.useState('')
      const NOTICE_AGES = [
        { v: '', l: '全部时间' }, { v: '10m', l: '最近 10 分钟' }, { v: '1h', l: '最近 1 小时' },
        { v: '24h', l: '最近 24 小时' }, { v: '7d', l: '最近 7 天' },
      ]
      const [notices, setNotices] = react.useState(null)

      /** 官方快捷键状态变化时 +1，用来重渲染键位表（它显示的是"你此刻在用的键"）。 */
      const [shortcutTick, setShortcutTick] = react.useState(0)
      // 0.3.3：详情里可关闭的段（如「官方审批」提示）——关闭选择记在本机 localStorage
      const [hiddenSections, setHiddenSections] = react.useState(() => {
        try {
          const v = JSON.parse(String(localStorage.getItem('dshsh-hidden-sections') || '{}'))
          return v !== null && typeof v === 'object' ? v : {}
        } catch { return {} }
      })
      const hideSection = (group) => {
        const next = { ...hiddenSections, [group]: true }
        setHiddenSections(next)
        try { localStorage.setItem('dshsh-hidden-sections', JSON.stringify(next)) } catch { /* 无痕模式忽略 */ }
      }
      // 「复制全部」的短暂反馈；定时器要清掉，否则收起面板后还会 setState
      const [copied, setCopied] = react.useState(false)
      // 单值复制的行内反馈（"已复制"），与整段复制的按钮反馈分开
      const [copiedValue, setCopiedValue] = react.useState('')
      const copiedTimer = react.useRef(null)
      react.useEffect(() => () => {
        if (copiedTimer.current !== null) clearTimeout(copiedTimer.current)
        if (closeArmTimer.current !== null) clearTimeout(closeArmTimer.current)
        if (notifyTimer.current !== null) clearTimeout(notifyTimer.current)
      }, [])
      // 取多少行：面板必须显式要历史，否则宿主只回可见屏（等于窗格高度）
      const [historyWindow, setHistoryWindow] = react.useState(200)
      // 0.3.4：面板粘贴模式与只读回看
      const [hint, setHint] = react.useState('')
      const [readonly, setReadonly] = react.useState(false)
      // 每个 shell 上一次的响铃状态（用于"由没响变响"时提醒，而不是每次都提醒）
      const prevBellsRef = react.useRef(new Map())
      // 0.3.4 (A)：面板内搜索（Ctrl+F / 🔍）——高亮 + 上一个/下一个跳转
      const [batch, setBatch] = react.useState([])
      const [searchOpen, setSearchOpen] = react.useState(false)
      const [searchQuery, setSearchQuery] = react.useState('')
      const [searchHit, setSearchHit] = react.useState(0)
      const searchRef = react.useRef(null)
      const hintTimerRef = react.useRef(null)
      // 软键盘（用户要求）：状态全部放**组件顶层** —— 钩子绝不能出现在下面的 JSX 构建段里
      // （2026-10 真事故：钩子写在 JSX 段里 ⇒ 整棵浮层崩掉、胶囊消失、面板打不开）。
      const [softOpen, setSoftOpen] = react.useState(false)
      // 鼠标支持（用户要求）：mouseMode = 面板进入"点击发给终端"模式；appMouse = 该程序是否已启用鼠标
      const [mouseMode, setMouseMode] = react.useState(false)
      const [appMouse, setAppMouse] = react.useState(null)
      // 宿主构建号（来自 /list 的 server.hostBuild）：与客户端 BUILD 不一致 ⇒ 提示需重启宿主
      const [hostBuild, setHostBuild] = react.useState('')
      // 首次使用提示条：看过就落 localStorage，不再出现（不打扰老用户）
      // 推送健康状态（诊断用：悬停标题就能看到"是推送还是轮询在支撑画面"）
      const [sseOk, setSseOk] = react.useState(null)
      const [hintsSeen, setHintsSeen] = react.useState(() => {
        try { return window.localStorage.getItem('terminalkeeper:hints-seen') === '1' } catch { return true }
      })
      // ⚠ 这个 useRef 必须在**组件顶层**：收起态（胶囊）会提前返回、根本不执行下面的 JSX 构建段，
      // 一旦 hook 写在那里，收起/展开的 hook 数量就会不同 ⇒ React 抛错 ⇒ 表现为
      // 「胶囊还在、点开后面板不显示」（2026-10 用户实测，同类问题第二次）。
      // 按住/拖动/松开的状态（顶层 hook；写在 JSX 段里会让收起/展开的 hook 数不同 ⇒ 面板打不开）
      // 我们自己正在关闭的壳：关闭后轮询会立刻收到 404 gone —— 那是**预期**的，不该弹
      // "会话可能已被回收"（用户实测：批量关闭时弹了两条无意义提示）。
      const closingRef = react.useRef(new Map())
      const mouseDragRef = react.useRef({ active: false, pending: null, flushTimer: null })
      const mouseNoticeRef = react.useRef({ key: '', at: 0 })
      const [softMods, setSoftMods] = react.useState([])
      const [softLast, setSoftLast] = react.useState('')
      // 浮窗几何 + 组合开关（用户要求：可任意拖动、任意改大小、可独立发送修饰键）。
      // 持久化到 localStorage（与面板的 pos/rect 同一套思路），值变化后夹回视口内。
      const SOFT_RECT_KEY = 'terminalkeeper:softkb'
      // null 有**明确语义**：还没读盘 / 用户没手动拖过 ⇒ 交给 CSS 自适应（见 .dshsh-sk）。
      const [softRect, setSoftRect] = react.useState(null)
      const softDragRef = react.useRef(null)
      // ⚠ 这两个必须是**组件顶层** hook：写在下面的 JSX 构建段里会让整棵浮层崩掉
      // （2026-10 真事故：胶囊消失、面板打不开 —— 同类错误不再犯）。
      const softRef = react.useRef(null)

      const softSeRef = react.useRef(0)
      react.useEffect(() => {
        try {
          const raw = localStorage.getItem(SOFT_RECT_KEY)
          if (raw !== null) {
            const v = JSON.parse(raw)
            if (v !== null && typeof v === 'object') {
              const w = Number(v.w); const h = Number(v.h)
              // ⚠ 旧格式（还带 combo 字段）或 0 尺寸的残值一律**当作没存过** ⇒ 用 CSS 自适应。
              // 否则会进"显式像素"分支：不仅尺寸为 0，而且那条分支曾引用过已删除的标识符
              // （2026-10 事故：用户点 ⌨ 后面板整棵消失 —— softWin 未定义 ⇒ ReferenceError）。
              if (Number.isFinite(w) && Number.isFinite(h) && w >= 320 && h >= 168) {
                setSoftRect({ x: Number(v.x) || 0, y: Number(v.y) || 0, w, h })
                return
              }
            }
          }
        } catch { /* 无痕模式/坏值：用默认值 */ }
        setSoftRect(null)                       // 没存过 ⇒ 保持"自适应"
      }, [])
      react.useEffect(() => {
        if (softRect === null) return
        try {
          const v = softRect === null ? null : { x: softRect.x, y: softRect.y, w: softRect.w, h: softRect.h }
          if (v === null) localStorage.removeItem(SOFT_RECT_KEY)
          else localStorage.setItem(SOFT_RECT_KEY, JSON.stringify(v))
        } catch { /* 忽略 */ }
      }, [softRect])
      // 面板右下角双击判定（两次 pointerdown <320ms）：必须放在**组件顶层**，
      // 不能放在下面的 JSX 构建段里 —— 钩子出现在条件/非组件路径会直接崩掉整棵浮层
      // （症状：胶囊消失、面板打不开；此前在 UI.List 里加 hook 也是这样崩的）。
      const lastSeDownRef = react.useRef(0)
      const flashHint = (msg) => {
        setHint(msg)
        if (hintTimerRef.current !== null) clearTimeout(hintTimerRef.current)
        hintTimerRef.current = setTimeout(() => { setHint('') }, 2200)
      }
      // ── 0.3.4 (C)：批量操作 ────────────────────────────────────────────────
      // 勾选多个 shell 后一起：锁定（人在操作 → AI 让路）/ 解锁 / 重开 / 关闭 / 统一尺寸。
      // 逐个走既有 HTTP 路由（/busy /respawn /kill /resize），与单壳操作同一条路。
      const batchInfo = batchSummary(sessions, batch)
      const toggleBatch = (name) => {
        setBatch((prev) => (Array.isArray(prev) && prev.includes(name) ? prev.filter((n) => n !== name) : [...(Array.isArray(prev) ? prev : []), name]))
      }
      const batchCall = async (path, body) => {
        await api(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      }
      const runBatch = async (label, fn) => {
        const names = batchInfo.selected
        if (names.length === 0) return
        let ok = 0
        for (const name of names) {
          try { await fn(name); ok += 1 } catch { /* 单个失败不拖累其余 */ }
        }
        flashHint(label + ' ' + String(ok) + '/' + String(names.length))
      }
      const batchLock = (active) => runBatch(active ? '已锁定' : '已解锁', (name) => batchCall('/busy', { session: name, active }))
      const batchRespawn = () => runBatch('已重开', (name) => batchCall('/respawn', { name }))
      const batchKill = () => {
        const targets = batchInfo.selected.slice()
        for (const n of targets) markClosing(n)                 // 关闭前标记 ⇒ 随后的 gone 不再弹提示
        return runBatch('已关闭', (name) => { markClosing(name); return batchCall('/kill', { name }) })
      }
      // 用户拍板：不再保留行内「⋮」，所有操作统一走多选条（选一个也能用）
      /** 反选：当前筛选下，已勾的取消、未勾的选上。 */
      /**
       * 就地补丁会话列表：操作完成后立刻反映到界面，**不等 2.5 秒轮询**
       * （用户反馈：上锁/解锁/重命名/改尺寸都有“慢一步”的延迟）。
       */
      const patchSessions = (names, patch) => {
        const set = new Set(Array.isArray(names) ? names : [names])
        setSessions((prev) => (Array.isArray(prev) ? prev : []).map((s) => (set.has(s.name) ? { ...s, ...patch } : s)))
      }
      const batchInvert = () => {
        const all = (sessions ?? []).map((s) => s.name)
        const cur = batchInfo.selected
        return all.filter((n) => cur.indexOf(n) < 0)
      }
      const batchRename = () => {
        const names = batchInfo.selected
        if (names.length === 0) return
        // 多选也允许：输入一个基名，应用时自动编号 1、2、3…（用户要求）
        setRenaming(names[0])
        setRenameDraft(names[0].startsWith('dsh-') ? names[0].slice(4) : names[0])
        setBatchToolsOpen('rename')
      }
      const batchDoctor = () => {
        const names = batchInfo.selected
        if (names.length === 0) return
        void (async () => {
          const out = []
          for (const n of names.slice(0, 5)) {
            const result = await api('/diagnose', {
              method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: n }),
            })
            out.push('[' + n + '] ' + String(result.ok
              ? (result.body?.text ?? result.body?.advice ?? '正常')
              : (result.body?.error ?? '失败')))
          }
          if (names.length > 5) out.push('（只列前 5 个）')
          notify('info', '自检完成（' + String(names.length) + ' 个 shell）', out.join(' ｜ '))
        })()
      }
      /** 所选 shell 按“当前是否已被手动锁定”分组（上锁/解锁前必须判断现状）。 */
      const batchLockState = () => {
        const picked = new Set(batchInfo.selected)
        const already = []
        const free = []
        for (const s of (Array.isArray(sessions) ? sessions : [])) {
          if (!picked.has(s.name)) continue
          if (s.lockKind === 'manual') already.push(s.name)
          else free.push(s.name)
        }
        return { already, free }
      }
      const batchManualLock = (locked, note) => {
        const names = batchInfo.selected
        if (names.length === 0) return
        // 先看现状再动手（用户要求）：重复上锁 / 对没锁的解 —— 都要拒绝并说清楚
        const state = batchLockState()
        if (locked === true && state.already.length > 0) {
          notify('warn', '上锁被拒绝：所选 shell 里已有手动锁定',
            '已锁定：' + state.already.join(', ')
              + ' ｜ 它们本来就是锁定状态，重复上锁没有意义；若要改锁定原因，请先解锁再上锁'
              + (state.free.length > 0 ? ' ｜ 未锁定的：' + state.free.join(', ') : ''))
          return
        }
        // 注意：**只**对「上锁」做前置判断（用户明确要求的那一侧）。解锁不在这里拦 ——
        // 客户端列表可能与真实锁状态不同步，一旦误判就会把合法解锁挡掉（实报问题）。
        // 解锁直接交给服务端，以它的答复为准。
        void (async () => {
          let ok = 0
          for (const n of names) {
            const result = await api('/lock', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name: n, locked, note }),
            })
            if (result.ok) ok += 1
          }
          patchSessions(names, locked
            ? { lockKind: 'manual', lockNote: note, lockAt: Date.now() }
            : { lockKind: null, lockNote: '', lockAt: null })
          const failed = names.length - ok
          notify(
            failed === 0 ? 'info' : 'warn',
            (locked ? '已手动锁定 ' : '已解除手动锁 ') + String(ok) + ' / ' + String(names.length) + ' 个 shell',
            '会话：' + names.join(', ')
              + (locked && note !== '' ? ' ｜ 锁定原因：' + note : '')
              + (locked ? ' ｜ 影响：AI 写 / 改 / 关都会被拒，只能由你在面板解锁' : ' ｜ 影响：AI 可以再次操作')
              + (failed > 0 ? ' ｜ 失败 ' + String(failed) + ' 个（可能已不存在）' : ''))
          setBatchToolsOpen('')
          setBatchLockNote('')
        })()
      }
      const batchSizeApply = () => {
        const c = Math.max(20, Math.min(500, Math.round(Number(batchSizeDraft.cols))))
        const r = Math.max(5, Math.min(200, Math.round(Number(batchSizeDraft.rows))))
        if (!Number.isFinite(c) || !Number.isFinite(r)) { notify('warn', '尺寸必须是数字', '解析结果：cols=' + String(c) + ', rows=' + String(r) + '（范围：cols 20–500 / rows 5–200）'); return }
        patchSessions(batchInfo.selected, { cols: c, rows: r })
        notify('info', '尺寸已调整为 ' + String(c) + '×' + String(r),
          '会话：' + batchInfo.selected.join(', ') + ' ｜ 目标：cols=' + String(c) + ', rows=' + String(r))
        void runBatch('已调整为 ' + String(c) + '×' + String(r), (name) => batchCall('/resize', { name, cols: c, rows: r }))
        setBatchToolsOpen('')
      }
      const batchResize = () => {
        const cols = meta !== null && Number.isFinite(meta.cols) ? meta.cols : 120
        const rows = meta !== null && Number.isFinite(meta.rows) ? meta.rows : 32
        return runBatch('已统一尺寸 ' + String(cols) + '×' + String(rows), (name) => batchCall('/resize', { name, cols, rows }))
      }

      // 0.3.4：搜索在**纯文本**上跑（screen 现在带 ANSI 颜色，剥掉控制序列再匹配，
      // 否则关键字被颜色打断/夹着 `\x1b[…m` 会漏）。行号与渲染行一一对应
      // （renderScreenLines 的 plain 就是这份 text）。
      const screenPlain = react.useMemo(() => parseAnsi(screen).text, [screen])
      const searchModel = react.useMemo(() => searchMatches(screenPlain, searchOpen ? searchQuery : ''), [screenPlain, searchQuery, searchOpen])
      const jumpToHit = (idx) => {
        const total = searchModel.lineHits.length
        if (total === 0) return
        const norm = ((idx % total) + total) % total
        setSearchHit(norm)
        setPinned(false)
        const el = screenRef.current
        if (el === null) return
        const lineTop = SCREEN_PAD_Y + searchModel.lineHits[norm] * lineHeightRef.current
        el.scrollTop = Math.max(0, lineTop - el.clientHeight / 2)
      }
      const closeSearch = () => {
        setSearchOpen(false)
        setSearchQuery('')
        setSearchHit(0)
      }
      const exitReadonly = () => {
        setReadonly(false)
        setPinned(true)
        const el = screenRef.current
        if (el !== null) el.scrollTop = el.scrollHeight
      }

      // Esc 退出只读回看：只读模式本来就不往终端发按键 ⇒ Esc 在这里是空闲的，
      // 不会和 vim/less 争 Esc（那才是把它留给程序的原因）。
      react.useEffect(() => {
        if (readonly !== true) return undefined
        const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); exitReadonly() } }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [readonly])

      // 是否贴着底部；用户往上翻时不要把他拽回来
      const [pinned, setPinned] = react.useState(true)
      const [pos, setPos] = react.useState(() => loadPos() ?? defaultPos())
      const [dragging, setDragging] = react.useState(false)

      // ── 通知 A（面板内视觉，不打扰）：当前 shell 刚跑完 / 有新输出 ──────────
      // busy→idle 时状态点闪 3 秒「刚结束」；屏幕行数增长时出现「+N 行」徽标 3 秒。
      // ⚠ 跟随旧口径：只做面板内视觉，不弹系统通知、不出声。
      const [justIdle, setJustIdle] = react.useState(false)
      const notifyTimer = react.useRef(null)
      const prevIdleRef = react.useRef(null)   // 上一轮 /list 里当前 shell 的空闲判定（null=还没采过）
      const pulseDone = () => {
        setJustIdle(true)
        if (notifyTimer.current !== null) clearTimeout(notifyTimer.current)
        notifyTimer.current = setTimeout(() => {
          setJustIdle(false)
        }, 3000)
      }

      const panelRef = react.useRef(null)
      const screenRef = react.useRef(null)
      /** 0.3.4 浮层下边界：量「状态栏 + 输入行」实际占用，浮层 max-height 用它精确回避（不盖住输入区）。 */
      const [bottomReserve, setBottomReserve] = react.useState(66)
      /** 0.3.4 浮层上边界：量 head 实际高度，浮层 top 用它对齐（内容上边界，不随按钮位置动）。 */
      const [topInset, setTopInset] = react.useState(38)
      const lastInset = react.useRef({ top: -1, bottom: -1 })
      /** 量一次头部 / 状态栏+输入行的真实高度（值没变就不 setState，免一次重渲染）。 */
      const measureInsets = react.useCallback(() => {
        const p = panelRef.current
        if (p === null || typeof p.querySelectorAll !== 'function') return
        try {
          let total = 0
          for (const sel of ['[data-dshsh-stats]', '[data-dshsh-input]']) {
            const n = p.querySelector(sel)
            if (n !== null && typeof n.getBoundingClientRect === 'function') total += n.getBoundingClientRect().height
          }
          if (total > 0) {
            const next = Math.min(220, Math.max(42, Math.ceil(total + 6)))
            if (next !== lastInset.current.bottom) { lastInset.current.bottom = next; setBottomReserve(next) }
          }
          const h = p.querySelector('[data-dshsh-head]')
          if (h !== null && typeof h.getBoundingClientRect === 'function') {
            const hh = Math.ceil(h.getBoundingClientRect().height)
            if (hh > 0 && hh !== lastInset.current.top) { lastInset.current.top = hh; setTopInset(hh) }
          }
        } catch { /* 测量失败用默认值 */ }
      }, [])
      // ⚠ 为什么不能只靠一次挂载测量 + ResizeObserver：面板挂载时可能还是**折叠态**（只有胶囊，
      // 没有 head/stats/input）→ 那时一个观察目标都挂不上，展开后 ResizeObserver 永远不会触发，
      // 上下边界就一直停在默认值 38/66（用户实报「上下边界问题又复发了」）。
      // 所以：在「展开态变化 / 任意浮层打开」这些时机强制测一次，并重建观察目标。
      react.useEffect(() => {
        measureInsets()
        const t0 = setTimeout(measureInsets, 80)
        const t1 = setTimeout(measureInsets, 400)
        let ro = null
        try {
          if (typeof ResizeObserver !== 'undefined' && panelRef.current !== null) {
            ro = new ResizeObserver(() => { measureInsets() })
            const p = panelRef.current
            ro.observe(p)
            for (const sel of ['[data-dshsh-head]', '[data-dshsh-stats]', '[data-dshsh-input]']) {
              const n = p.querySelector(sel)
              if (n !== null) ro.observe(n)
            }
          }
        } catch { /* 无 ResizeObserver：靠上面的时机测量 + 默认值 */ }
        return () => { clearTimeout(t0); clearTimeout(t1); if (ro !== null) ro.disconnect() }
      }, [expanded, pickerOpen, consentMenuOpen, infoOpen, secretsOpen, logOpen, measureInsets])
      /** 量字符宽度的隐藏样本（横向实测失败时的退路） */
      const measureRef = react.useRef(null)
      /** 量一次字符网格（宽/行高）；原来只在 effect 里内联，现在鼠标换算需要能按需重测。 */
      const measureGrid = () => {
        const el = screenRef.current
        if (el === null || typeof el.querySelector !== 'function') return
        try {
          const sample = el.querySelector('.dshsh-screen-text') ?? el
          const rect = sample.getBoundingClientRect()
          const line = String(screen ?? '').split('\n').find((l) => l.length > 0) ?? ''
          const n = Math.max(1, line.length)
          cellWidthRef.current = rect.width > 0 && n > 0 ? rect.width / n : 0
        } catch { /* 忽略 */ }
        try {
          const computed = typeof window !== 'undefined' && typeof window.getComputedStyle === 'function'
            ? window.getComputedStyle(el) : null
          lineHeightRef.current = resolveLineHeight({ lineHeight: computed?.lineHeight, fontSize: computed?.fontSize })
        } catch { /* 忽略 */ }
      }
      const cellWidthRef = react.useRef(0)
      /** 量出来的行高（像素）。**不能**从 scrollHeight 推 —— 内容比视口矮时它会等于视口高度。 */
      const lineHeightRef = react.useRef(0)
      react.useEffect(() => {
        const node = measureRef.current
        if (node === null || typeof node.getBoundingClientRect !== 'function') return
        try {
          const width = node.getBoundingClientRect().width
          cellWidthRef.current = Number.isFinite(width) && width > 0 ? width / 40 : 0
        } catch { cellWidthRef.current = 0 }
      })
      react.useEffect(() => {
        const el = screenRef.current
        if (el === null || typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return
        try {
          const computed = window.getComputedStyle(el)
          lineHeightRef.current = resolveLineHeight({ lineHeight: computed?.lineHeight, fontSize: computed?.fontSize })
        } catch { lineHeightRef.current = 0 }
      })
      const prevScreenRef = react.useRef('')
      const inputRef = react.useRef(null)
      const dragRef = react.useRef(null)
      const suppressClickRef = react.useRef(false)
      /** 当前那次「读屏幕」的函数；按键后立即调它，不然自己打的字要等最多 0.7s 才显示。 */
      const screenFetchRef = react.useRef(null)
      /** 立即刷新的去抖计时器：连打时合并成最多约 14 次/秒。 */
      const fastRefreshRef = react.useRef(null)
      /**
       * 组字状态（自己维护，不信事件的 `isComposing`）。
       *
       * Chrome 在组字提交时补的 `input` 事件里 `isComposing` 常仍是 true，各浏览器的
       * `input` / `compositionend` 顺序也不一致 —— 只按事件字段判断会漏掉整次提交，
       * 汉字就会滞留在输入框里。详见 {@link decideComposition}。
       */
      const composingRef = react.useRef(false)

      const current = sessions.length === 0
        ? null
        : (sessions.find((s) => s.name === selected) || sessions[0])
      const currentName = current === null ? '' : current.name

      // 选中记忆：重开面板/刷新后回到上次选中的 shell；只有它已不存在才回第一个。
      react.useEffect(() => {
        if (sessions.length === 0) return
        if (selected !== '' && sessions.some((s) => s.name === selected)) return
        let saved = ''
        try {
          if (typeof localStorage !== 'undefined') saved = String(localStorage.getItem(SELECTED_KEY) ?? '')
        } catch { /* 忽略 */ }
        const next = sessions.some((s) => s.name === saved) ? saved : sessions[0].name
        if (next !== selected) setSelected(next)
      }, [sessions, selected])

      react.useEffect(() => {
        if (selected === '') return
        try {
          if (typeof localStorage !== 'undefined') localStorage.setItem(SELECTED_KEY, selected)
        } catch { /* 忽略 */ }
      }, [selected])

      // 滚轮：React 的 onWheel 是**被动监听**，阻止不了浏览器默认滚动 ⇒ 用原生监听 + preventDefault。
      // 鼠标模式下滚轮属于终端，不能同时把面板滚走（用户实测反馈）。
      react.useEffect(() => {
        const el = screenRef.current
        if (el === null || typeof el.addEventListener !== 'function') return undefined
        const onWheelNative = (e) => {
          if (mouseMode !== true) return
          e.preventDefault()
          sendMouseAt(e, 'wheel')
        }
        el.addEventListener('wheel', onWheelNative, { passive: false })
        return () => { try { el.removeEventListener('wheel', onWheelNative) } catch { /* 忽略 */ } }
      }, [mouseMode, currentName, appMouse])
      // 切换会话 ⇒ 重新计时（每个会话各算一次首帧耗时）
      react.useEffect(() => { setScreenSince(Date.now()); setScreenFirstAt(null) }, [currentName])
      // 首帧到达（屏幕文本非空）⇒ 冻结耗时
      react.useEffect(() => {
        if (screenFirstAt === null && typeof screen === 'string' && screen !== '') setScreenFirstAt(Date.now())
      }, [screen, screenFirstAt])
      // 等待期间每 200ms 触发一次重渲染，让"已等待 X.Xs"持续走表
      react.useEffect(() => {
        if (screenFirstAt !== null) return undefined
        const id = setInterval(() => setScreenTick((n) => n + 1), 200)
        return () => clearInterval(id)
      }, [screenFirstAt])

      // ── 面板矩形（位置 + 尺寸）：持久化 + 视口变化时夹回 ───────────────────
      //
      // 面板一旦被拖动或缩放，就**完全由 rect 决定**，不再跟着胶囊锚点走；否则你调好的
      // 位置会在下次拖胶囊时被打乱。rect 为 null 时按胶囊锚点推导初始矩形。
      const [rect, setRect] = react.useState(() => loadRect())
      react.useEffect(() => {
        if (rect !== null) saveRect(rect)
      }, [rect])

      const anchorRect = clampRect({
        w: PANEL_W,
        h: PANEL_H,
        left: pos.x + PILL_W - PANEL_W,
        top: pos.y + PILL_H - PANEL_H,
      })
      const panelRect = rect === null ? anchorRect : rect

      react.useEffect(() => { savePos(pos) }, [pos])

      react.useEffect(() => {
        const onResize = () => {
          setPos((prev) => clampPoint(prev.x, prev.y))
          setRect((prev) => (prev === null ? prev : clampRect(prev)))
        }
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [])

      // 卸载时清掉去抖计时器，避免回调打在已卸载的组件上。
      react.useEffect(() => () => {
        if (fastRefreshRef.current !== null) clearTimeout(fastRefreshRef.current)
      }, [])

      // ── 拖动与缩放 ────────────────────────────────────────────────────────
      // 胶囊用「偏移量」跟手：指针始终抓住按下时的那一点。
      const beginPillDrag = (event) => {
        if (event.button !== 0) return
        dragRef.current = {
          mode: 'offset',
          pointerId: event.pointerId,
          offsetX: event.clientX - pos.x,
          offsetY: event.clientY - pos.y,
          startX: event.clientX,
          startY: event.clientY,
          moved: false,
        }
        try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* 忽略 */ }
        event.preventDefault()
      }

      // 面板标题栏：平移整个面板矩形（首次拖动会把锚点推导值「落实」成显式矩形）。
      const beginPanelDrag = (event) => {
        if (event.button !== 0) return
        if (event.target !== null && typeof event.target.closest === 'function' && event.target.closest('button') !== null) return
        dragRef.current = {
          mode: 'move',
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          base: panelRect,
          moved: false,
        }
        try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* 忽略 */ }
        event.preventDefault()
      }

      /** 八个方向的缩放手柄共用一套拖动逻辑，用方向字符串区分。 */
      /**
       * 双击右下角拖拽标记：把面板调到**刚好容纳当前 shell 的 cols × rows**。
       *
       * 做法：实测"面板外框"与"屏幕区"的尺寸差（头部 + 状态栏 + 输入行 + 内边距 = chrome），
       * 再用实测的字符宽 / 行高换算出屏幕区需要的像素，加上 chrome 就是目标面板尺寸。
       * 这样 120×32 的 shell 不会再出现横向滚动条，周围的按钮也跟着一起排好。
       */
      /** 双击对齐用的 chrome 差量（只测一次；窗口尺寸变化时重置重新测）。 */
      const fitChromeRef = react.useRef(null)

      const fitToShell = () => {
        const p = panelRef.current
        const screenEl = p !== null && typeof p.querySelector === 'function' ? p.querySelector('.dshsh-screen') : null
        // ⚠ 必须用 /screen 回来的 meta.cols / meta.rows（tmux 的**真实**行列数）。
        // current.cols 是面板按当前宽度算出来的可见列数 —— 拿它对齐只会原地打转（实测只宽了 4px）。
        const cols = Number(meta !== null && meta !== undefined && Number.isFinite(meta.cols) ? meta.cols : 0)
        const rows = Number(meta !== null && meta !== undefined && Number.isFinite(meta.rows) ? meta.rows : 0)
        const cw = cellWidthRef.current
        const lh = lineHeightRef.current
        if (!(cols > 0) || !(rows > 0)) { notify('warn', '暂时无法对齐尺寸', '原因：面板还没量到当前会话的 cols/rows（先等屏幕刷出来，或先打开一次终端）'); return }
        if (!(cw > 0) || !(lh > 0) || screenEl === null || typeof p.getBoundingClientRect !== 'function') {
          notify('warn', '量不到字符尺寸，无法对齐', '原因：字体度量未就绪（切一次页签或稍后重试）')
          return
        }
        try {
          const pr = p.getBoundingClientRect()
          // ⚠ chrome 差量（头部 + 状态栏 + 输入行 + 边框）**只测一次并固化**。
          // 之前每次都实时测：屏幕区一旦出现滚动条，sr.width 就变小 → chromeW 变大 →
          // 算出来的目标更宽 → 又更容易出滚动条 …… 于是"频繁双击面板一点点变大"（用户实测复现）。
          // 固化后这个计算是**幂等**的：双击多少次结果都一样。
          if (fitChromeRef.current === null) {
            const sr = screenEl.getBoundingClientRect()
            fitChromeRef.current = { w: pr.width - sr.width, h: pr.height - sr.height }
          }
          const chromeW = fitChromeRef.current.w
          const chromeH = fitChromeRef.current.h
          // 宽度留 12px 余量：容下竖向滚动条与取整误差 —— 否则"刚好放下"会差一两像素，
          // 显示区下方又冒出一条横向滚动条（用户实测反馈）。
          const needW = Math.ceil(cols * cw + SCREEN_PAD_X * 2 + chromeW) + 12
          const needH = Math.ceil(rows * lh + SCREEN_PAD_Y + chromeH)
          // 只增不减：双击的目的是"别再挤"，绝不把已经够用的显示区缩小
          const w = Math.max(Math.round(pr.width), needW)
          const h = Math.max(Math.round(pr.height), needH)
          if (w !== Math.round(pr.width) || h !== Math.round(pr.height)) setRect((prev) => ({ ...prev, w, h }))

          // 字符宽是"实测"的，难免偏小（实测 6.13px vs 真实 7.4px）→ 算出来的宽度仍差一截，
          // 显示区下方会继续挂着横向滚动条。用**真实结果**做迭代补偿：量 scrollWidth 与
          // clientWidth 的差，把差值补进面板宽度，最多两轮（收敛即停 → 双击多次结果一致）。
          // 只补宽度：竖向滚动是正常功能（历史输出远超视口），不能拿 scrollHeight 撑高面板。
          const compensate = (round) => {
            if (round > 2) return
            const box = panelRef.current
            const area = box !== null && typeof box.querySelector === 'function' ? box.querySelector('.dshsh-screen') : null
            if (area === null || typeof area.scrollWidth !== 'number') return
            const over = area.scrollWidth - area.clientWidth
            if (over <= 0) return
            setRect((prev) => ({ ...prev, w: prev.w + over + 2 }))
            setTimeout(() => { compensate(round + 1) }, 90)
          }
          setTimeout(() => { compensate(0) }, 90)
        } catch (err) { notify('error', '对齐失败', withCode('原因：量取字符尺寸失败 ｜ DSH 错误：' + String(err && err.message ? err.message : err), UI_ERR.ACTION)) }
      }

      const beginResize = (dir) => (event) => {
        if (event.button !== 0) return
        event.preventDefault()
        // 手柄在标题栏之外，但保险起见别让其它拖动接手这次指针
        event.stopPropagation()
        dragRef.current = {
          mode: 'resize',
          dir,
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          base: panelRect,
          moved: false,
        }
        try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* 忽略 */ }
      }

      const moveDrag = (event) => {
        const d = dragRef.current
        if (d === null || d.pointerId !== event.pointerId) return
        if (!d.moved) {
          const distance = Math.abs(event.clientX - d.startX) + Math.abs(event.clientY - d.startY)
          if (distance <= DRAG_THRESHOLD) return
          d.moved = true
          setDragging(true)
        }
        const dx = event.clientX - d.startX
        const dy = event.clientY - d.startY
        if (d.mode === 'offset') {
          setPos(clampPoint(event.clientX - d.offsetX, event.clientY - d.offsetY))
          return
        }
        if (d.mode === 'resize') {
          setRect(applyResize(d.base, d.dir, dx, dy))
          return
        }
        setRect(clampRect({ w: d.base.w, h: d.base.h, left: d.base.left + dx, top: d.base.top + dy }))
      }

      const endDrag = (event) => {
        const d = dragRef.current
        if (d === null || d.pointerId !== event.pointerId) return
        dragRef.current = null
        setDragging(false)
        try { event.currentTarget.releasePointerCapture(event.pointerId) } catch { /* 忽略 */ }
        if (d.moved) {
          // 拖动结束后的那次 click 要吞掉，否则会被当成「点击展开」
          suppressClickRef.current = true
          setTimeout(() => { suppressClickRef.current = false }, 0)
        }
      }

      // 反馈浮层自动消失（4 秒）——它是瞬时提示，不该长期占着视野


      // 会话选择菜单关闭后默认取下全部勾选（用户要求：下次打开是干净状态）
      react.useEffect(() => {
        if (!pickerOpen) { setBatch([]); setBatchToolsOpen('') }
      }, [pickerOpen])

      // DSH 侧就绪阈值：宿主进程运行满这么久才算「DSH 完全启动」（插件 ready 通常在 ~40s 处到达）。
      const DSH_READY_MIN_MS = 20000

      // 启动就绪提示（用户要求）：插件完全启动、能正常工作时提示一次。
      // 结论来自宿主 /status（与「详情 › 插件状态」同一份真信号，7 个阶段 + 结论）；降级时明确说出原因。
      // 每个标签页会话只提示一次（sessionStorage 标记）—— 刷新不再重复打扰。
      react.useEffect(() => {
        const READY_KEY = 'terminalkeeper:startup-notified'
        try { if (window.sessionStorage.getItem(READY_KEY) === '1') return undefined } catch { /* 无 storage 也照常提示 */ }
        let alive = true
        let tries = 0
        let timer = 0
        const probe = async () => {
          tries += 1
          try {
            const r = await api('/status')
            const body = r !== null && typeof r === 'object' && r.body !== null && typeof r.body === 'object' ? r.body : null
            if (!alive) return
            // 触发条件（用户要求：插件完全启动**且** DSH 完全启动，才提示）——
            //   ① 插件侧：phase === 'ready'（宿主启动状态机走完，7 个阶段各自报 ok/✗）；
            //   ② DSH 侧：window.__DSH_BOOT__ 已注入（GUI 由 dsh web 引导完成）
            //      且宿主进程已运行 >= DSH_READY_MIN_MS —— uptimeMs 取自 /status 的
            //      Math.round(process.uptime()*1000)，是 DSH 宿主进程的真实运行时长，
            //      因此它既是「DSH 起没起完」的判据，也顺带排除「宿主刚起、首包抖动」的假就绪。
            const dshBooted = typeof window !== 'undefined' && window.__DSH_BOOT__ !== undefined && window.__DSH_BOOT__ !== null
            const upMs = Number(body === null ? NaN : body.uptimeMs)
            const pluginReady = String(body.phase ?? '') === 'ready'
            const dshReady = dshBooted && Number.isFinite(upMs) && upMs >= DSH_READY_MIN_MS
            if (r.ok === true && body !== null && pluginReady && dshReady) {
              const stages = Array.isArray(body.stages) ? body.stages : []
              const bad = stages.filter((s) => s !== null && s !== undefined && s.ok !== true)
              const up = Number(body.uptimeMs)
              const upText = Number.isFinite(up) && up > 0 ? ' · 已运行 ' + String(Math.max(1, Math.round(up / 1000))) + ' 秒' : ''
              if (bad.length === 0) {
                notify('info', '插件已就绪（DSH 也已就绪）',
                  'DSH 已运行 ' + String(Math.max(1, Math.round(upMs / 1000))) + ' 秒 ✓ · 插件启动流程 '
                  + String(stages.length) + ' 项全部通过 ✓ · ' + String(body.conclusion ?? '') + upText)
              } else {
                notify('warn', '插件已启动，但有 ' + String(bad.length) + ' 项未通过',
                  bad.map((s) => String(s.label ?? '') + '：' + String(s.detail ?? '')).join('；')
                  + '（详情 › 状态查询 › 插件状态）' + upText)
              }
              try { window.sessionStorage.setItem(READY_KEY, '1') } catch { /* 忽略 */ }
              return
            }
          } catch { /* 宿主暂时不可达：继续重试 */ }
          if (alive && tries < 12) timer = window.setTimeout(probe, 1200)
        }
        void probe()
        return () => { alive = false; if (timer !== 0) window.clearTimeout(timer) }
      }, [])

      // ── 会话列表：折叠时也轮询，用于胶囊上的数量 ──────────────────────────
      react.useEffect(() => {
        let alive = true
        const tick = async () => {
          try {
            const result = await api(expanded ? '/list' : '/list?lite=1')
            if (!alive) return
            if (result.ok) {
              const nextSessions = result.body.sessions || []
              // 响铃提醒：当前 shell 由"没响"→"响" 时提示一次（长命令跑完 / 程序在等输入）。
              // 只报当前 shell：别的 shell 的响铃已在会话列表用 🔔 标出，不刷屏。
              try {
                const me = String(latestName.current ?? '')
                const prevBells = prevBellsRef.current
                const mine = nextSessions.find((x) => String(x?.name ?? '') === me)
                if (mine !== undefined && me !== '' && mine.bell === true && prevBells.get(me) !== true) {
                  flashHint('🔔 当前 shell 响铃了（可能有命令跑完或需要输入）')
                }
                prevBellsRef.current = new Map(nextSessions.map((x) => [String(x?.name ?? ''), x?.bell === true]))
              } catch { /* 提醒失败不影响列表刷新 */ }
              setSessions(nextSessions)
              setSubscriptions(Array.isArray(result.body.subscriptions) ? result.body.subscriptions : [])
              const nextServer = result.body.server || null
              setServer(nextServer)
              // 功能开关禁用提示：直接走 notify（右上角消息条 + /notice 历史），不另造 UI。
              // 在轮询回调里投递，避免依赖 effect 时序；同一禁用集合只发一次。
              try {
                const nextFeatures = nextServer !== null && typeof nextServer === 'object' && nextServer.features !== null && typeof nextServer.features === 'object' ? nextServer.features : null
                if (nextFeatures !== null) {
                  const disabled = Object.keys(nextFeatures).filter((key) => nextFeatures[key] === false)
                  const sig = disabled.join(',')
                  if (sig !== featureNoticeSigRef.current) {
                    featureNoticeSigRef.current = sig
                    if (disabled.length > 0) {
                      notify('warn', '功能已禁用：' + disabled.map((key) => FEATURE_LABELS[key] ?? key).join('、'), '配置仍可在设置页修改；重新开启后恢复。')
                    }
                  }
                }
              } catch { /* 提示失败不影响列表 */ }
              // 客户端与宿主的构建号一比就知道"是不是该重启宿主"了。
              // 这是本次会话反复踩的坑（改完面板没变、其实是宿主还跑着旧代码）⇒ 明说。
              if (nextServer !== null && typeof nextServer.hostBuild === 'string' && nextServer.hostBuild !== '') {
                setHostBuild(nextServer.hostBuild)
                if (nextServer.hostBuild !== BUILD) {
                  notifyOnce('host-stale', 'warn', withCode('DSH 的代码比面板旧：需要重启 dsh web', UI_ERR.TOO_OLD),
                    '面板 ' + BUILD + ' · DSH ' + nextServer.hostBuild + ' —— DSH 侧的改动（推送、审计、设置、鼠标通道）必须重启才生效')
                }
              }
              // 通知 A：当前 shell 从「有命令在跑」回到空闲 → 状态点闪 3 秒「刚结束」
              const cur = (result.body.sessions || []).find((s) => s.name === currentName)
              if (cur !== undefined) {
                const idleNow = !sessionBusy(cur, shellNameOf())
                if (prevIdleRef.current === false && idleNow) pulseDone()
                prevIdleRef.current = idleNow
              }
            }
          } catch { /* 宿主暂时不可达 */ }
        }
        tick()
        // 发布性能：展开 2.5s；收起 5s；页签隐藏时暂停（visibilitychange 恢复时立刻补一次）。
        let id = 0
        const schedule = () => {
          if (id !== 0) { clearInterval(id); id = 0 }
          if (typeof document !== 'undefined' && document.hidden) return
          id = setInterval(tick, expanded ? 2500 : 5000)
        }
        const onVisibility = () => {
          if (typeof document !== 'undefined' && document.hidden) { schedule(); return }
          void tick()
          schedule()
        }
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
        schedule()
        return () => {
          alive = false
          if (id !== 0) clearInterval(id)
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [expanded])

      // ── 「按对话授权」的候选对话目录（/actors）──────────────────────────────
      //
      // 0.3.4：**挂载即预取**（面板一出现，/actors 就在路上了），打开授权浮层时
      // 首帧直接有数据 —— 用户报的「首次打开授权管理页面要等加载」就是打开才拉造成的：
      // 打开动作要等到 listSessions 全扫 + 批量读标题返回才有第一帧。
      // 预取之后：打开浮层时再拉一次（宿主 5s 缓存通常正好命中，零成本），保证展示的是
      // 最新目录；授权/撤销之后也重拉，否则 `granted` 徽标与「已授权的会话」列表会停在旧值。
      // ⚠ 曾经的 bug：这里完全没有 effect，`actors` 永远是 null —— 菜单永久卡在
      // 「正在读取对话列表…」，界面承诺的功能实际是死的。0.2.1 装机后在真浏览器里
      // 点开授权菜单才发现（/actors 接口本身一直有数据，是没人去取）。
      const loadActors = react.useCallback(async () => {
        try {
          const result = await api('/actors')
          setActors(result.ok ? result.body : { supported: false, note: result.body?.error, actors: [] })
        } catch {
          setActors({ supported: false, note: '连不上 DSH', actors: [] })
        }
      }, [])
      // 挂载即预取（幂等：无论面板何时打开，目录都已在路上 / 已就位）
      react.useEffect(() => {
        void loadActors()
        return undefined
      }, [loadActors])
      // 空闲预热：面板挂载后（延迟 + 浏览器空闲时）静默预取「引用库 / 日志」列表。
      // 用户点开菜单时直接命中缓存 —— 实测首次打开从 ~964ms（引用库）/ >2s（日志）降到 ~30ms。
      // 用 requestIdleCallback + 延迟，避免抢面板首屏的带宽与主线程。
      react.useEffect(() => {
        // 发布性能：面板收起时不做后台预取；展开后才空闲预热（点菜单仍有按需加载兜底）。
        if (!expanded) return undefined
        const warm = () => {
          void loadSecrets()
          void loadLogs()
        }
        const timer = setTimeout(() => {
          try {
            if (typeof requestIdleCallback === 'function') requestIdleCallback(warm, { timeout: 2500 })
            else warm()
          } catch { warm() }
        }, 1200)
        return () => clearTimeout(timer)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [expanded])
      // 打开浮层时刷新一次：宿主 5s 缓存兜底，几乎瞬时返回
      react.useEffect(() => {
        if (!consentMenuOpen) return undefined
        void loadActors()
        return undefined
      }, [consentMenuOpen, loadActors])

      // 预热：宿主侧 /actors 可能要几十秒（会话多时 listSessions + 逐 id 读标题快照）。
      // 面板一展开就空闲预热，用户真去点"授权管理"时通常已命中服务端 60 秒缓存 ——
      // 那一次冷启动发生在他没看的地方，而不是点了之后干等。
      react.useEffect(() => {
        if (!expanded) return undefined
        const warm = () => { void loadActors() }
        if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
          const handle = window.requestIdleCallback(warm, { timeout: 4000 })
          return () => { try { window.cancelIdleCallback(handle) } catch { /* 忽略 */ } }
        }
        const timer = setTimeout(warm, 1500)
        return () => clearTimeout(timer)
      }, [expanded, loadActors])

      // 页签隐藏时暂停屏幕轮询；可见时触发一次恢复（发布性能）。
      react.useEffect(() => {
        if (typeof document === 'undefined') return undefined
        const onVisibility = () => setVisibilityTick((n) => n + 1)
        document.addEventListener('visibilitychange', onVisibility)
        return () => document.removeEventListener('visibilitychange', onVisibility)
      }, [])

      // ── 当前屏 + 历史：展开时按**自适应**节奏轮询 ──────────────────────────
      //
      // 必须显式带上 `lines`：宿主侧的读取在缺省时返回**可见屏**（capture-pane 不带 -S），
      // 那只有窗格高度那么多行。历史一直存在 tmux 里（historyLimit 10 万行），只是没人去取。
      //
      // 为什么不用固定 setInterval：固定 700ms 意味着"跑命令时输出最多滞后 0.7 秒"（用户报的
      // "不跟手"），而一味调快又会在空闲时白跑 —— 每次请求在宿主侧都是一次真实 tmux 调用。
      // 所以改成：屏幕**在变**（或刚发过按键）时走快档，静下来退回慢档。"在变"用文本比对判定，
      // 顺带也让内容没变时 React 不必重渲染（setScreen 传同值它自己会跳过）。
      // 轮询节奏可由宿主设置下发（panelPollMs = 空闲档；快档取它的 1/4）—— 用**数值**做依赖，
      // 否则 server 对象每 2.5s 换新会把轮询 effect 反复重启。
      const pollMs = server !== null && Number.isFinite(server?.ui?.pollMs)
        ? Math.max(200, Math.floor(server.ui.pollMs))
        : SCREEN_IDLE_MS
      // 快档：原来取 pollMs/4（pollMs=800 ⇒ 200ms ⇒ 只有 5 帧/秒，TUI 里的动画看起来像慢动作）。
      // 现在收紧到 120ms（≈8 帧/秒）并设 70ms 下限：一次 /screen 约 80ms（宿主侧一次真实 tmux 调用），
      // 再快就会首尾相接把宿主压满，反而更慢。
      const fastMs = Math.max(70, Math.min(120, Math.floor(pollMs / 4)))
      // 用户实测反馈：切换会话后，新会话首帧到达前屏幕上仍是**上一个会话**的画面，会被误认。
      // 用 ref 记住"当前屏幕属于哪个会话"，只在**真的换了会话**时立刻清空 —— 轮询节奏、
      // 历史窗口等依赖变化不会白屏（那不是切换）。另配 latestName 做迟到帧的第二道闸。
      const screenFor = react.useRef('')
      const latestName = react.useRef(currentName)
      latestName.current = currentName
      react.useEffect(() => {
        if (!expanded || currentName === '' || (typeof document !== 'undefined' && document.hidden)) {
          if (!expanded || currentName === '') { setScreen(''); setMeta(null) }
          return undefined
        }
        if (screenFor.current !== currentName) {
          screenFor.current = currentName
          setScreen('')
          setMeta(null)
        }
        const forName = currentName
        let alive = true
        let timer = null
        let lastText = null
        let lastChange = 0
        let lastCount = null   // 上一帧屏幕行数（null = 还没采过，首帧不报「+N」）
        let sseLive = false    // 0.3.3 #1：推送流是否健康（true 时轮询降为低频兜底）
        let es = null
        // 一帧数据来自 SSE 推送还是兜底轮询，走**同一段**处理逻辑：显示/指标/脉冲语义零漂移。
        const applyFrame = (body) => {
          if (!alive) return
          // 第二道闸：帧必须属于**当前**会话（effect 切换时 alive 会置 false，这里是纵深防御：
          // 万一有极窄的时序窗口让旧帧漏进来，也不能画在新会话名下）。
          if (forName !== latestName.current) return
          if (typeof body?.error === 'string' && body.screen === undefined) { handleScreenFailure(body, ''); return }
          const next = body.screen || ''
          if (next !== lastText) {
            lastText = next
            lastChange = Date.now()
            // 通知 A：屏幕行数增长 = 有新输出 → 亮 3 秒圆点脉冲（「+N 行」徽标已按维护者
            // 反馈移除：触发器里换行会撑高标题栏，且信息价值不如一次闪点）
            const count = next === '' ? 0 : next.split('\n').length
            if (lastCount !== null && count > lastCount) {
              if (notifyTimer.current !== null) clearTimeout(notifyTimer.current)
              notifyTimer.current = setTimeout(() => { setJustIdle(false) }, 3000)
              setJustIdle(true)
            }
            lastCount = count
          }
          setScreen(next)
          setMeta(body.meta || null)
          if (body.mouse !== undefined) setAppMouse(body.mouse)
          setError('')
        }
        // 0.3.3 #1：推送流健康时快轮询没有存在必要 —— 只保留**低频兜底**（5×pollMs），
        // 专抓"静默丢帧"（窗格重建致 %output 失配、中间层掐流等罕见路径）；流一断
        // sseLive=false，立刻回到全速自适应轮询（=旧行为）。推送是加速通道，不是依赖。
        const schedule = () => {
          if (!alive) return
          const fast = Date.now() - lastChange < SCREEN_FAST_WINDOW_MS
          const ms = sseLive ? pollMs * 5 : (fast ? fastMs : pollMs)
          timer = setTimeout(() => { timer = null; void tick() }, ms)
        }
        const tick = async () => {
          try {
            const result = await api('/screen?name=' + encodeURIComponent(currentName) + '&lines=' + String(historyWindow))
            if (!alive) return
            if (result.ok) applyFrame(result.body)
            else handleScreenFailure(result.body, 'read failed')
          } catch (e) {
            if (alive) handleScreenFailure(null, String(e && e.message ? e.message : e))
          }
          schedule()
        }
        void tick()
        // 主通道：EventSource 可用就订 /stream —— 服务端在本插件输入时**当刻**推帧、
        // 外部变化按自适应节拍推，且**内容没变不推**（与 /screen 同形的成品屏）。
        // EventSource 原生带断线自动重连（retry 由服务端 `retry:1500` 指定）。
        if (typeof EventSource === 'function') {
          try {
            es = new EventSource(BASE + '/stream?name=' + encodeURIComponent(currentName) + '&lines=' + String(historyWindow))
            es.onopen = () => {
            sseLive = true
            setSseOk(true)
            try { console.debug('[terminalkeeper] 屏幕推送已连上（动画依赖它）') } catch { /* 忽略 */ } sseLive = true }
            es.onmessage = (ev) => {
              sseLive = true
              try { applyFrame(JSON.parse(String(ev.data))) } catch { /* 坏帧：丢弃，兜底轮询接管 */ }
            }
            es.onerror = () => {
              sseLive = false                        // 重连空窗由全速轮询顶着
              setSseOk(false)
              // 推送是"动画流畅"的主力（宿主在窗格有输出后 40ms 内推一帧）；
              // 它断了就只剩轮询，观感会明显变差 —— 必须说出来，而不是让用户觉得"就是卡"。
              notifyOnce('sse-down', 'warn', withCode('屏幕推送未连上，已改用快速轮询', UI_ERR.SSE),
                '推送断开后只能靠轮询取屏（当前 ' + String(fastMs) + 'ms 一帧）；若持续如此请重启 dsh web')
            }
          } catch { es = null }
        }
        // 发完按键后的"立刻拉一次"（见 scheduleFastRefresh）：顺带把节奏切到快档，
        // 并取消已排定的那一次，避免同一时刻并发两个请求。推送流正常时这一发多半多余，
        // 但它保证了**没有推送**的环境（旧服务端/control 退避）手感不退化。
        screenFetchRef.current = () => {
          if (!alive) return
          lastChange = Date.now()
          if (timer !== null) { clearTimeout(timer); timer = null }
          void tick()
        }
        return () => {
          alive = false
          if (timer !== null) { clearTimeout(timer); timer = null }
          if (es !== null) { try { es.close() } catch { /* 忽略 */ } es = null }
          screenFetchRef.current = null
        }
      }, [expanded, currentName, historyWindow, pollMs, fastMs, visibilityTick])

      // ── 0.3.3 #3：回放播放器 ──────────────────────────────────────────────
      // 打开：拉 /replay（服务端挑当前/最近录制）。从第一帧起自动播。
      const openReplay = async () => {
        closeAllMenus()
        setReplay({ file: '', frames: [], idx: 0, playing: false, speed: 1, loading: true, error: '' })
        const result = await api('/replay?name=' + encodeURIComponent(currentName))
        if (result.ok && Array.isArray(result.body.frames)) {
          setReplay({
            file: String(result.body.file ?? ''), frames: result.body.frames,
            idx: 0, playing: result.body.frames.length > 1, speed: 1, loading: false, error: '',
          })
        } else {
          setReplay({ file: '', frames: [], idx: 0, playing: false, speed: 1, loading: false, error: String(result.body.error ?? '读取回放失败') })
        }
      }
      // 播放节拍：每帧按原始间隔/speed 推进（3s 封顶）；到末帧自动停。
      react.useEffect(() => {
        if (replay === null || !replay.playing) return undefined
        if (replay.idx >= replay.frames.length - 1) { setReplay((r) => (r === null ? r : { ...r, playing: false })); return undefined }
        const ms = replayDelay(replay.frames[replay.idx].t, replay.frames[replay.idx + 1].t, replay.speed)
        const timer = setTimeout(() => setReplay((r) => (r === null || !r.playing ? r : { ...r, idx: r.idx + 1 })), ms)
        return () => clearTimeout(timer)
      }, [replay])

      // 切换 shell（或收起再展开）时回到「跟随」：新会话应当看到最新输出，
      // 而不是沿用上一个会话的阅读位置。与下面的滚动 effect 收敛在同一帧之后。
      const viewKeyRef = react.useRef('')
      react.useEffect(() => {
        const key = (expanded ? '1' : '0') + '|' + currentName
        if (viewKeyRef.current === key) return
        viewKeyRef.current = key
        setPinned(true)
        setReplay(null)   // 0.3.3 #3：回放不跨会话 —— 切换/收起即关播放器（帧文件还在盘上，可再开）
      }, [expanded, currentName])

      // 新内容到达后的滚动：贴底则跟随，否则**保持阅读位置不动**。
      // 「不动」不是什么都不做：窗口是「最后 N 行」，新输出会把最上面的行挤掉，
      // 不补偿 scrollTop 的话，正在读的那几行依然会被顶上去。补偿交给纯函数 scrollAnchor。
      react.useEffect(() => {
        const el = screenRef.current
        if (el === null) return
        const plan = scrollAnchor(prevScreenRef.current, screen, {
          scrollTop: el.scrollTop,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          padding: SCREEN_PAD_Y,
          lineHeight: lineHeightRef.current,
          pinned,
        })
        prevScreenRef.current = screen
        // 补偿位移（jsdom/无输出时 clientHeight 为 0，此时只在跟随状态下有意义）
        if (Math.abs(plan.scrollTop - el.scrollTop) >= 1) el.scrollTop = plan.scrollTop
        if (plan.pinned !== pinned) setPinned(plan.pinned)
      }, [screen, pinned, historyWindow])

      // 光标：只在**用户手动输入**（解锁）且程序没有隐藏光标时画；坐标换算失败就不画。
      // 它是 <pre> 的绝对定位子元素，所以随内容一起滚动，不需要监听滚动去同步。
      // 0.3.4：坐标换算用**剥离 ANSI 后的纯文本**（screen 带颜色后行内容含 `\x1b[…m`，
      // 直接算行/列会偏 —— 行号和单元格映射都必须对 plain 文本做）。
      const caret = react.useMemo(() => {
        const placement = caretPlacement({ screen: screenPlain, meta })
        if (!shouldShowCaret({ locked, meta, placement })) return null
        // 横向：先问浏览器要「光标前那段文本」的真实宽度（Range 实测，DOM 不动）；
        // 量不到才退回「单元格 × ASCII 字符宽」的估算；都不行就不画。
        // 横向：先问浏览器要「光标那一行上、光标前那段文本」的真实宽度（Range 实测，DOM 不动）；
        // 区间必须限定在**本行**（见 prefixRangeOffsets —— 跨行区间的包围盒会把光标推到行尾）。
        // 量不到才退回「单元格 × ASCII 字符宽」的估算；都不行就不画。
        const span = prefixRangeOffsets(placement)
        const measured = span === null ? Number.NaN
          : measurePrefixWidth(screenRef.current, span.from, span.to)
        // 0.3.4 行尾空格修正：光标落在被 tmux 剥掉的空格列上时，Range 只量得到
        // 文本末尾；把空格区按「空格数 × 单元格宽」补进去，光标才不会贴到前一个字符。
        const inGap = Number.isFinite(placement.gapCells) && placement.gapCells > 0
          && Number.isFinite(placement.cell) && placement.cell > (placement.textCells ?? 0)
        const gapPx = inGap && Number.isFinite(cellWidthRef.current) && cellWidthRef.current > 0
          ? (placement.cell - (placement.textCells ?? 0)) * cellWidthRef.current
          : 0
        const style = caretStyle(
          placement, lineHeightRef.current, cellWidthRef.current,
          SCREEN_PAD_X, SCREEN_PAD_Y / 2,
          Number.isFinite(measured) ? measured + gapPx : measured,
        )
        return style === null ? null : { placement, style }
      }, [screenPlain, meta, locked])

      const onScreenScroll = (event) => {
        const el = event.currentTarget
        setPinned(el.scrollTop + el.clientHeight >= el.scrollHeight - AT_BOTTOM_PX)
      }

      const switchBy = (delta) => {
        if (sessions.length === 0) return
        const at = sessions.findIndex((s) => s.name === currentName)
        const from = at < 0 ? 0 : at
        const next = sessions[(from + delta + sessions.length) % sessions.length]
        setSelected(next.name)
      }

      // ── 发送：串行化，避免逐键发送与其它请求互相插队 ──────────────────────
      const queueRef = react.useRef(Promise.resolve())
      const enqueue = (task) => {
        const next = queueRef.current.then(task, task)
        queueRef.current = next.then(() => undefined, () => undefined)
        return next
      }

      /** 把授权状态写回宿主；成功后用返回值就地更新面板状态，不必等下一次轮询。 */
      const postConsent = async (action, extra = {}) => {
        setConsentBusy(true)
        try {
          const result = await api('/consent', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action, ...extra }),
          })
          if (result.ok) {
            // 0.3.4：就地更新用**宿主返回的完整快照**（含 entries/wildcard/catalogs，
            // /consent POST 的响应与 /list 同构）。早先只回写三字段 —— 「已授权的会话」
            // 列表数据源（consent.entries）被就地覆盖成 undefined，列表要么闪空、要么
            // 拖到下一轮 /list 轮询才回来；现在授权/撤销后浮层内容立刻、完整地刷新。
            const next = result.body
            setServer((prev) => prev === null ? prev : { ...prev, consent: { ...next } })
            // 就地更新那份目录 —— **不再调用 loadActors()**。
            // 宿主侧 /actors 实测要 43 秒（其中 listSessions 占 ~40 秒），期间面板会被拖住、
            // 用户看到的就是"改完要等一会儿才生效，而且点不动"。而我们其实**知道**刚刚改了什么。
            setActors((prev) => {
              if (prev === null || !Array.isArray(prev.actors) || typeof extra.actor !== 'string') return prev
              const ttl = typeof extra.ttlSeconds === 'number' && Number.isFinite(extra.ttlSeconds) ? extra.ttlSeconds : null
              const expiresAt = ttl === null ? null : Date.now() + ttl * 1000
              const rows = prev.actors.map((a) => {
                if (a.id !== extra.actor) return a
                if (action === 'revoke-one') return { ...a, granted: false, scope: null, expiresAt: null }
                return { ...a, granted: true, scope: typeof extra.scope === 'string' ? extra.scope : a.scope, expiresAt }
              })
              return { ...prev, actors: rows }
            })
          } else if (result.body && result.body.error) {
            setError(String(result.body.error))
          }
        } catch (err) {
          setError(withCode('授权状态写入失败：' + String(err && err.message ? err.message : err), UI_ERR.AUTH))
        } finally {
          setConsentBusy(false)
        }
      }

      /* ── 0.3.0 引用库（面板 = 人这一侧）──────────────────────────────────
       * vault 只有这里（和 CLI）能写：AI 的工具面没有写入口，只见键名。
       * 值输入框 type=password；列表**不回显值**（共享屏幕友好），改值 = 重新录入。 */
      const secretsLoadedRef = react.useRef(false)
      const secretsLastRef = react.useRef(0)
      /**
       * 引用库数据：快慢分离 + 缓存优先。
       * 以前是 4 个请求一起 await（其中 /chain 要校验整条哈希链、/vault-history 要读历史）——
       * 两个慢请求把整个列表挡在「读取中」后面。现在列表（vault/macro）一到就放行，
       * 历史与链在后台补；已有缓存时连「读取中」都不显示（stale-while-revalidate）。
       */
      const loadSecrets = async (force) => {
        const now = Date.now()
        if (force !== true && now - secretsLastRef.current < 20000) return   // 4s 内重复开关菜单不重复拉
        secretsLastRef.current = now
        const hasCache = secretsLoadedRef.current
        if (!hasCache) setSecretsBusy(true)
        try {
          const [v, m] = await Promise.all([api('/vault-list'), api('/macro-list')])
          setSecretsData({
            vault: v.ok && Array.isArray(v.body.items) ? v.body.items : [],
            macros: m.ok && Array.isArray(m.body.items) ? m.body.items : [],
            vaultCorrupt: v.ok ? String(v.body.corrupt ?? '') : '',
            groups: v.ok && Array.isArray(v.body.groups) ? v.body.groups : [],
            vaultNote: v.ok ? String(v.body.note ?? '') : '',
            vaultRefused: v.ok ? v.body.refused === true : false,
            reuseCandidates: v.ok && Array.isArray(v.body.reuseCandidates) ? v.body.reuseCandidates.map(String) : [],
            macrosCorrupt: m.ok ? String(m.body.corrupt ?? '') : '',
          })
          secretsLoadedRef.current = true
        } catch (err) {
          setError(withCode('读取引用库失败：' + String(err && err.message ? err.message : err), UI_ERR.VAULT))
        } finally {
          setSecretsBusy(false)
        }
        // 慢请求（历史 / 链校验）：后台补，失败不影响列表
        try {
          const [his, ch] = await Promise.all([api('/vault-history'), api('/chain')])
          setSecretsExtra({
            history: his.ok && Array.isArray(his.body.items) ? his.body.items : [],
            chain: ch.ok ? ch.body : null,
          })
        } catch { /* 慢请求失败静默：列表已可用 */ }
      }
      const secretsPost = async (path, payload, okMsg) => {
        setSecretsBusy(true)
        try {
          const result = await api(path, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          })
          if (!result.ok) {
            const why = String((result.body && result.body.error) || path + ' 失败')
            setError(why)
            // 0.4.1 起 setError 本身就走 notify（消息条 + /notice 历史）——
            // 这里再 notify 一次就是**同一件事弹两条**（用户实报“删除组时大量重复提示”）。
            // 锁定类失败顺手刷新一次组列表：面板上的“已解密”可能是重启前的旧状态。
            if (/锁定|加密态|解密/.test(why)) void loadSecrets(true)
          }
          else {
            setError('')
            // 0.3.2 ②：vault-set 的成功响应带弱形状警告 → 黄条回显（不阻断，强度是人的决定）
            setSecretsWarn(path === '/vault-set' && Array.isArray(result.body.warn) ? result.body.warn : [])
            void loadSecrets(true)
          }
          return result.ok
        } catch (err) {
          setError(path + ' 失败：' + String(err && err.message ? err.message : err))
          return false
        } finally {
          setSecretsBusy(false)
        }
      }

      // 0.3.2：点键名复制**引用形态**（{{v:键}} / {{m:名}}），粘给 AI 或写命令直接用
      const copyRef = (text) => {
        writeClipboard(text, () => {
          setCopiedKey(text)
          setTimeout(() => { setCopiedKey('') }, 1400)
        }, (msg) => setError(withCode('复制失败：' + msg, UI_ERR.CLIPBOARD)))
      }
      const sendKeys = async (payload) => {
        if (currentName === '') return
        const result = await api('/keys', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: currentName, ...payload }),
        })
        if (result.body && result.body.refused === true) {
          setError(result.body.message || '操作被拒绝')
          return
        }
        if (!result.ok) setError(String((result.body && result.body.error) || 'send failed'))
        else setError('')
      }

      /** 是否在屏幕上有选中文本（决定 Ctrl+C 是复制还是 SIGINT）。 */
      const hasSelection = () => {
        if (typeof window === 'undefined' || typeof window.getSelection !== 'function') return false
        const selection = window.getSelection()
        return selection !== null && String(selection).length > 0
      }

      /** 按键后立刻把屏幕拉一次：否则自己打的字要等轮询（最多 0.7s）才出现。 */
      const scheduleFastRefresh = () => {
        if (fastRefreshRef.current !== null) return
        fastRefreshRef.current = setTimeout(() => {
          fastRefreshRef.current = null
          if (screenFetchRef.current !== null) void screenFetchRef.current()
        }, 70)
      }

      /** 排队发送；发完立刻刷新屏幕（去抖）。 */
      const send = (payload) => {
        void enqueue(async () => {
          await sendKeys(payload)
          scheduleFastRefresh()
        })
      }

      /**
       * 人机互斥上报：解锁 = 告诉宿主「人正在操作这根终端」，上锁/切走 = 解除。
       * 宿主据此把 AI 的**写**（shell_send / shell_run 的发送）挡在门外，避免人机混合输入。
       *
       * 口径（与宿主 userBusy 的注释一致）：
       *   · 只针对**当前前台显示的这个 shell**，其它 shell 不受影响；
       *   · 切走的 shell 自动上锁（这里随之解除），切过来的新 shell 默认也是锁着的；
       *   · 解锁后没有超时、不会自动释放 —— 只有人自己上锁才算结束。
       *
       * 上报失败必须让用户看得见：如果 /busy 没生效，AI 根本不会被拦（危险方向）。
       * 404/405 = 宿主还是旧代码，这种端点是重启才生效的，理由要直接说清楚（参照改名的做法）。
       */
      const setUserBusy = (name, active) => {
        if (name === '') return
        void api('/busy', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ session: name, active }),
        }).then((result) => {
          if (result.ok) return
          if (result.status === 404 || result.status === 405) {
            setError(withCode('人机互斥需要重启 dsh web：/plugins/shell/busy 是新接口，DSH 侧的改动必须重启才生效', UI_ERR.TOO_OLD))
          } else {
            setError('人机互斥状态上报失败（HTTP ' + String(result.status) + '）：AI 写暂停可能未生效')
          }
        }).catch(() => { /* 网络失败不阻断输入 */ })
      }

      /**
       * 按键处理：**真·终端模型，没有任何本地缓冲**。
       *
       * 分两条路：
       *  * **特殊键**（Tab/↑↓←→/Backspace/Home/End/Ctrl-X/Esc…）在 keydown 里就地翻译成
       *    tmux 键名送走 —— 补全、历史、行内光标、Ctrl-R 全部由 shell 自己的 readline 处理；
       *  * **可打印字符**一律不拦，交给浏览器与输入法，再由 `input` 事件交付（见
       *    {@link onInputChanged}）。这一条是中文/日文输入能用的前提：输入法的组字依赖
       *    浏览器对按键的默认处理，抢掉按键 IME 就起不来。
       *
       * 代价与配套：每次按键是一次 HTTP 往返（队列串行化，顺序不会乱），而屏幕靠轮询
       * 更新，所以每次发送后额外触发一次立即刷新（去抖到约 14 次/秒）。
       */
      /**
       * 兜底：把输入框里任何残留文本立刻送走。
       *
       * 为什么需要：这套模型假设输入框在两次事件之间**始终是空的**（字符一进来就被送走）。
       * 一旦有文本留在这里，说明「提交时刻」没被识别到 —— 而 `compositionend` 正是那个
       * 可能不来的信号（实测遇到过：提交的汉字滞留在输入框，直到敲下一个字符才被一起送走）。
       * 所以把「输入框里有残留」本身当作异常，在每次非组字的 keydown 时清一次。
       *
       * 位置很重要：必须在发送这个键**之前**调用，否则执行顺序会反过来（先回车、后正文）。
       */
      const commitPending = () => {
        const element = inputRef.current
        if (element === null) return
        if (element.value === '') return
        const text = element.value
        element.value = ''
        setResidual(false)
        const byPaste = needsPaste(text)
        send({ text, paste: byPaste === true })
        if (byPaste) flashHint('已按粘贴发送')
      }

      /** 轮询输入框是否有残留，用于给「主动推送」按钮加提示状态。 */
      react.useEffect(() => {
        const id = setInterval(() => {
          const element = inputRef.current
          const has = element !== null && element.value.length > 0
          setResidual((prev) => (prev === has ? prev : has))
        }, 400)
        return () => clearInterval(id)
      }, [])

      const onInputKeyDown = (event) => {
        const native = event.nativeEvent !== undefined ? event.nativeEvent : {}
        const eventComposing = native.isComposing === true
        if (!eventComposing) {
          // 非组字的按键说明组字已经结束：清标志 + 把可能滞留的正文送走（顺序：正文先、键后）
          composingRef.current = false
          commitPending()
        }
        if (locked) return
        const decision = decideKey({
          key: event.key,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          isComposing: eventComposing,
          keyCode: event.keyCode,
          hasSelection: hasSelection(),
        })
        if (decision.action !== 'key') return
        event.preventDefault()
        send({ keys: [decision.key] })
      }

      /**
       * 把输入框里的内容读走送进终端，并清空它。
       *
       * 「谁先读到谁清空、后到者看到空值即返回」是这里的防重发机制：提交时
       * `compositionend` 与 `input` 往往会各来一次，两边共用这个函数即可只发一次。
       */
      const commitInputText = (element) => {
        if (element === null || element === undefined) return
        const next = decideComposition('input', { composing: false, value: element.value })
        if (next.commit === '') return
        element.value = ''
        send({ text: next.commit })
      }

      /**
       * 文本通道：普通按键、输入法提交、粘贴等最终都在这里落进终端。
       *
       * **关键**：这里只信自己维护的组字标志，不看事件的 `isComposing` —— Chrome 在提交
       * 时补的那个 `input` 事件的 `isComposing` 常常仍是 `true`，信它就会漏掉整次提交，
       * 汉字会滞留在输入框里、直到敲下一个字符才被一起送走。
       */
      const onInputChanged = (event) => {
        if (locked) return
        const native = event.nativeEvent !== undefined ? event.nativeEvent : {}
        const next = decideComposition('input', {
          composing: composingRef.current,
          value: typeof event.currentTarget?.value === 'string' ? event.currentTarget.value : '',
          eventIsComposing: native.isComposing === true,
        })
        composingRef.current = next.composing
        if (next.commit === '') return
        event.currentTarget.value = ''
        send({ text: next.commit })
      }
      const onCompositionStart = () => {
        composingRef.current = decideComposition('compositionstart', { composing: composingRef.current }).composing
      }

      /**
       * 输入法提交。
       *
       * 顺序在各浏览器并不一致（有的 `input` 先、有的 `compositionend` 先），而且有的
       * `compositionend` 触发时输入框的值**还没写进来**。所以这里做的只有两件事：清掉组字
       * 标志、把当前已有的内容送走；真正的正文无论哪一次事件先到，都会被
       * 「谁先读到谁清空」的机制恰好送一次。
       */
      const onCompositionEnd = (event) => {
        composingRef.current = decideComposition('compositionend', {
          composing: composingRef.current,
          value: typeof event.currentTarget?.value === 'string' ? event.currentTarget.value : '',
        }).composing
        if (locked) return
        commitInputText(event.currentTarget)
      }

      /**
       * 原生 `compositionend` 兜底。
       *
       * React 的合成 composition 事件在部分浏览器/输入法组合下并不可靠，而漏掉这次提交的
       * 后果很显眼：提交的汉字会滞留在输入框里。这里挂在 **document 的捕获阶段**，比挂在
       * 元素上更能兜住（不受 React 委托机制与元素重挂影响），但必须过滤事件源 —— 页面里
       * 别的输入框（比如聊天输入框）也会组字，不能被我们接管。
       */
      react.useEffect(() => {
        const handler = (event) => {
          const element = inputRef.current
          if (element === null) return
          if (event.target !== element) return
          composingRef.current = false
          if (locked) return
          commitInputText(element)
        }
        document.addEventListener('compositionend', handler, true)
        return () => document.removeEventListener('compositionend', handler, true)
      }, [expanded, currentName, locked])

      /** 粘贴：直接送剪贴板文本，保留换行（多行粘贴＝逐行执行，与真终端一致）。 */
      const onInputPaste = (event) => {
        if (locked) return
        const clipboard = event.clipboardData
        if (clipboard === null || clipboard === undefined) return
        const text = clipboard.getData('text')
        if (text.length === 0) return
        event.preventDefault()
        if (inputRef.current !== null) inputRef.current.value = ''
        const byPaste = needsPaste(text)
        send({ text, paste: byPaste === true })
        if (byPaste) flashHint('已按粘贴发送')
      }

      /**
       * 右键粘贴：读剪贴板再走与输入框粘贴**同一条**通道（保留换行、多行走 paste-buffer）。
       * 浏览器可能拒绝读取（没权限 / 需要授权）⇒ 如实提示，不装作没发生。
       */
      const pasteFromClipboard = async () => {
        if (locked) return
        const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
        if (clip === undefined || typeof clip.readText !== 'function') {
          notifyOnce('paste-api', 'warn', withCode('右键粘贴不可用', UI_ERR.CLIPBOARD), '这个浏览器/环境不提供剪贴板读取接口，请用 Ctrl+V')
          return
        }
        let text = ''
        try {
          text = String(await clip.readText() ?? '')
        } catch (error) {
          notifyOnce('paste-denied', 'warn', '右键粘贴被浏览器拒绝',
            '需要剪贴板读取权限（' + String(error && error.message ? error.message : error) + '）；可改用 Ctrl+V')
          return
        }
        if (text.length === 0) return
        const byPaste = needsPaste(text)
        send({ text, paste: byPaste === true })
        flashHint(byPaste ? '已按粘贴发送' : '已粘贴')
      }

      const onPanelBlur = (event) => {
        const next = event.relatedTarget
        if (next !== null && panelRef.current !== null && panelRef.current.contains(next)) return
        setLocked(true)
        setUserBusy(currentName, false)   // 失焦即上锁：人的操作随之结束
      }

      /**
       * 面板内点击：**点开着的浮层以外的地方就关掉所有浮层**。
       *
       * 两条边界（都是明确要求）：
       *   · 点在浮层内部 → 不关（浮层里的交互各自处理，比如切 shell / 撤销 / 展开卡片）；
       *   · 点在头部按钮条 → 不关（头部按钮自己管开合与互斥；若这里也关，会把刚点开的菜单立刻关掉）；
       *   · 点在**面板之外**（DSH 页面其它地方）→ 事件根本不会到这里，所以不会误关。
       */
      const onPanelClick = (event) => {
        const target = event.target
        if (target === null || target === undefined || typeof target.closest !== 'function') return
        // 0.3.4 UI 组件库：浮层壳现在是 dshsh-u-sheet（组件化后类名变了），漏掉它 =
        // 点浮层内任何按钮都触发 closeAllMenus（用户实报「日志页按下任意按钮就关」）。
        if (target.closest('.dshsh-picker,.dshsh-info,.dshsh-cmenu,.dshsh-u-sheet,.dshsh-head')) return
        closeAllMenus()
      }

      const toggleLock = async () => {
        const next = !locked
        setLocked(next)
        // 解锁 = 报告宿主「人正在操作这根终端」；上锁 = 解除（AI 的写恢复可用）
        setUserBusy(currentName, !next)
        if (next) { setError(''); return }
        await Promise.resolve()
        if (inputRef.current !== null) inputRef.current.focus()
      }

      // ── 切 shell / 改名的「人机互斥」兜底 ───────────────────────────────────
      // 口径：切走的 shell 自动上锁（busy 解除），切过来的新 shell 默认也是锁着的。
      // 统一收在这里处理，比 selectShell / switchBy / submitRename 各写一份更不容易漏。
      // submitRename 是例外：改名只是同一根终端换了个名字，「人正在操作」要跟着搬过去，
      // 不能当作「切走」把 busy 清掉（那是危险方向——人还在操作，AI 却以为可以插进来）。
      const prevNameRef = react.useRef('')
      const renamedFromRef = react.useRef(null)
      react.useEffect(() => {
        const prev = prevNameRef.current
        prevNameRef.current = currentName
        if (prev === currentName) return
        if (renamedFromRef.current === prev) {
          renamedFromRef.current = null
          // 保持当前 locked：改名前后的操作状态不该被这次改名打断
          if (!locked) setUserBusy(currentName, true)
          return
        }
        if (prev !== '') setUserBusy(prev, false)   // 切走的 shell：自动上锁 + 解除「人在操作」
        setLocked(true)                              // 切过来的新 shell：默认也是锁着的
      }, [currentName, locked])

      const newShell = async () => {
        setBusy(true)
        try {
          const result = await api('/new', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
          })
          if (!result.ok) setError(String((result.body && result.body.error) || 'failed to open a shell'))
          else setError('')
        } finally {
          setBusy(false)
        }
      }

      /** 改名：成功后把选中项也跟着换到新名字，否则面板会掉回第一个 shell。 */
      /**
       * 手动锁定 / 解锁（**只有人能调用** —— AI 的工具里已无任何锁动词）。
       * 锁定原因会原样进入 AI 被拒时的提示，所以这里不做任何加工，只截长度。
       */
      const submitManualLock = async (name, locked, note) => {
        setLockEditFor('')
        try {
          const result = await api('/lock', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name, locked, note }),
          })
          if (result.ok) {
            setLockNote('')
            notify('info', locked
              ? '已手动锁定 ' + name + ' —— AI 的写与改动都会被拒（只有你能解除）'
              : '已解除手动锁 ' + name + ' —— AI 可以再次操作它')
            // 不手动刷新：面板本身在轮询 /list，徽标会在下一轮自己出现（与重命名同一策略）
          } else {
            notify('error', '命名失败', withCode('会话：' + from + ' ｜ 服务端：' + String(result.body?.error ?? '未知错误'), UI_ERR.ACTION))
          }
        } catch (err) {
          notify('error', '锁定请求失败', withCode('会话：' + name + ' ｜ DSH 或网络错误：' + String(err && err.message ? err.message : err), UI_ERR.ACTION))
        }
      }

      /** 调整终端尺寸（POST /resize）。失败把服务端的原话显示出来，不吞错。 */
      const submitResize = async (name, cols, rows) => {
        const c = Math.max(20, Math.min(500, Math.round(Number(cols))))
        const r = Math.max(5, Math.min(200, Math.round(Number(rows))))
        if (!Number.isFinite(c) || !Number.isFinite(r)) { notify('warn', '尺寸必须是数字', '解析结果：cols=' + String(c) + ', rows=' + String(r) + '（范围：cols 20–500 / rows 5–200）'); return }
        try {
          const result = await api('/resize', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name, cols: c, rows: r }),
          })
          notify('info', result.ok
            ? '已把 ' + name + ' 调整为 ' + String(c) + '×' + String(r)
            : String(result.body?.error ?? '调整失败'))
        } catch (err) {
          notify('error', '调整尺寸失败', withCode('会话：' + name + ' ｜ DSH 或网络错误：' + String(err && err.message ? err.message : err), UI_ERR.ACTION))
        }
      }

      const submitRename = async (from) => {
        const base = renameDraft.trim()
        setRenaming('')
        if (base === '') { setNotice(''); return }
        const targets = (Array.isArray(batchInfo.selected) && batchInfo.selected.length > 0)
          ? batchInfo.selected.slice()
          : [from]
        const multi = targets.length > 1
        let changed = 0
        for (let i = 0; i < targets.length; i += 1) {
          const target = targets[i]
          const to = multi ? base + String(i + 1) : base
          const bare = target.startsWith('dsh-') ? target.slice(4) : target
          if (to === bare || to === target) continue
          try {
            const result = await api('/rename', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name: target, newName: to }),
            })
            if (!result.ok) {
              if (result.status === 404 || result.status === 405) {
                setError(withCode('改名需要重启 dsh web：/plugins/shell/rename 是新接口，DSH 侧的改动必须重启才生效', UI_ERR.TOO_OLD))
                return
              }
              notify('error', '重命名失败', withCode(target + '：' + String(result.body?.error ?? '未知错误'), UI_ERR.ACTION))
              continue
            }
            changed += 1
            patchSessions([target], { label: String(result.body.name) })
            if (target === from) {
              renamedFromRef.current = from
              setSelected(String(result.body.name))
            }
          } catch (e) {
            notify('error', '重命名失败', withCode(target + '：' + String(e && e.message ? e.message : e), UI_ERR.ACTION))
          }
        }
        setError('')
        if (changed > 0 && multi) notify('info', '已重命名 ' + String(changed) + '/' + String(targets.length) + ' 个（编号 1…' + String(targets.length) + '）')
      }

      const dragHandlers = {
        onPointerDown: beginPillDrag,
        onPointerMove: moveDrag,
        onPointerUp: endDrag,
        onPointerCancel: endDrag,
      }

      const panelDragHandlers = {
        onPointerDown: beginPanelDrag,
        onPointerMove: moveDrag,
        onPointerUp: endDrag,
        onPointerCancel: endDrag,
      }

      /** 状态点：前台还是 shell 本体＝空闲（绿），否则说明有东西在跑（琥珀）。 */
      /** 复制单个值（点 ⓘ 里任意一行）。复用同一套剪贴板降级逻辑。 */
      const copyOne = (value) => {
        const write = (text) => writeClipboard(text, () => {
          setCopiedValue(String(value))
          if (copiedTimer.current !== null) clearTimeout(copiedTimer.current)
          copiedTimer.current = setTimeout(() => setCopiedValue(''), 1400)
        }, setError)
        write(String(value))
      }

      /**
       * 复制整段诊断信息到剪贴板。
       *
       * 优先用 `navigator.clipboard`（localhost 属于安全上下文，正常可用）；
       * 失败时退回到「临时 textarea + execCommand」—— 某些浏览器/权限设置下前者会被拒。
       * 两条路都失败就把错误显示在面板里，而不是静默什么都不做。
       */
      /**
       * 审计目录体积按需扫描：会遍历目录，按钮必须给出「扫描中」反馈；
       * 成功/失败都落到「日志审计」页顶部的占用条，不静默。
       */
      const scanAudit = () => {
        if (auditScan !== null && auditScan.phase === 'scanning') return
        const startedAt = Date.now()
        setAuditScan({ phase: 'scanning', startedAt })
        void (async () => {
          // 小目录几十毫秒就扫完；强制至少展示 600ms，避免「扫描中」一闪而过。
          const finish = (state) => {
            const wait = Math.max(0, 600 - (Date.now() - startedAt))
            if (wait > 0) setTimeout(() => setAuditScan(state), wait)
            else setAuditScan(state)
          }
          try {
            const r = await api('/audit-size')
            const body = r !== null && typeof r === 'object' && r.body !== null && typeof r.body === 'object' ? r.body : null
            if (r.ok !== true || body === null || body.ok !== true) {
              finish({ phase: 'error', error: String(body?.error ?? ('HTTP ' + String(r.status))), ms: Date.now() - startedAt })
              return
            }
            finish({ phase: 'done', ...body, ms: Number(body.ms) || (Date.now() - startedAt) })
          } catch (error) {
            finish({ phase: 'error', error: String(error?.message ?? error), ms: Date.now() - startedAt })
          }
        })()
      }

      const copyInfo = () => {
        const header = 'terminalkeeper ' + PKG_VERSION + ' · 客户端构建 ' + BUILD + ' · ' + new Date().toLocaleString()
        writeClipboard(infoRowsToText(infoSections, header), () => {
          setCopied(true)
          setError('')
          if (copiedTimer.current !== null) clearTimeout(copiedTimer.current)
          copiedTimer.current = setTimeout(() => setCopied(false), 1600)
        }, setError)
      }

      /** 本部署配置的 shell 名（服务端上报优先；旧宿主没有这个字段时退回 bash）。 */
      const shellNameOf = () => (server !== null && typeof server.shell === 'string' && server.shell !== ''
        ? server.shell
        : 'bash')

      // 忙闲判定统一走 sessionBusy（见文件顶部），避免两处逻辑漂移
      const dotColor = (session) => {
        if (session === null) return 'var(--dsw-alias-label-tertiary)'
        // 0.3.3 (a)：死壳（remain-on-exit 定格）用灰点 —— 不再"活着"，warn/success 都误导
        if (session.dead === true) return 'var(--dsw-alias-label-tertiary)'
        return sessionBusy(session, shellNameOf()) ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-state-success-primary)'
      }

      const selectShell = (name) => {
        setSelected(name)
        setPickerOpen(false)
        setConsentMenuOpen(false)
        setInfoOpen(false)
      }

      // ── 四个浮层（shell 下拉 / 详情 / 授权 / 日志管理）互斥：任何时候只开一个 ──────
      // 每次打开都要把另外几个关掉；自己若已开则关闭（toggle）。面板收起时全部复位。
      const closeAllMenus = () => {
        setPickerOpen(false)
        setConsentMenuOpen(false)
        setInfoOpen(false)
        setLogOpen(false)
        setSecretsOpen(false)
        setSettingsOpen(false)
      }
      // 面板收起 = 所有浮层在视觉上都不存在了，状态必须跟着归零；否则"浮层已关闭但状态仍是
      // 打开"，头部按钮会一直带着打开标记（这正是用户报的"页面关闭时 class 不被修改"）。
      react.useEffect(() => {
        if (!expanded) closeAllMenus()
        // 只在展开态变化时跑一次：closeAllMenus 每次渲染都是新函数，放进依赖会每帧触发
      }, [expanded])
      const toggleMenu = (which) => {
        const open = which === 'picker' ? pickerOpen
          : which === 'consent' ? consentMenuOpen
            : which === 'secrets' ? secretsOpen
              : which === 'log' ? logOpen
                  : which === 'settings' ? settingsOpen : infoOpen
        closeAllMenus()
        if (!open) {
          if (which === 'picker') setPickerOpen(true)
          if (which === 'secrets') { setSecretsOpen(true); void loadSecrets() }
          if (which === 'consent') {
            // 打开授权页时同步默认规则草稿（事件处理器里做，避免渲染期 hooks 数量问题）
            const def = server?.consent?.defaultRule
            if (def !== null && typeof def === 'object' && typeof def.scope === 'string') {
              setDraftScope(def.scope)
              const ttlKey = ttlLevels.find((l) => l.key !== 'custom'
                && ((l.seconds === null && (def.ttlSeconds === null || def.ttlSeconds === undefined))
                  || (typeof def.ttlSeconds === 'number' && l.seconds !== null && def.ttlSeconds === l.seconds)))?.key
              if (ttlKey !== undefined) setDraftTtl(ttlKey)
            }
            setConsentMenuOpen(true)
          }
            if (which === 'settings') setSettingsOpen(true)
          if (which === 'info') setInfoOpen(true)
          if (which === 'log') setLogOpen(true)
        }
      }

      // 下拉行显示名：优先用户起的 label（存于 @dsh-label），没有才退回稳定 id
      const rowDisplayName = (session) => {
        const label = typeof session?.label === 'string' && session.label.trim() !== '' ? session.label.trim() : ''
        // 标签存储时可能带 dsh- 前缀（旧数据/服务端规范化），展示时去掉，避免出现「dsh-测试1」。
        if (label !== '') {
          const bare = label.startsWith('dsh-') && label.length > 4 ? label.slice(4) : label
          return bare !== '' ? bare : label
        }
        const id = String(session?.name ?? '')
        return id.startsWith('dsh-') ? id.slice(4) : id
      }
      // 创建它的会话（owner）：宿主下发 ownerName（DSH 左侧列表里的会话标题 / 「面板」），
      // 拿不到才退回 owner 字段；未知写「未知」。
      const rowOwnerText = (session) => {
        const name = typeof session?.ownerName === 'string' && session.ownerName.trim() !== '' ? session.ownerName.trim() : ''
        if (name !== '') return name
        const owner = typeof session?.owner === 'string' && session.owner.trim() !== '' ? session.owner.trim() : ''
        if (owner === '' || owner === 'unknown') return '未知'
        return owner
      }

      // 会话单元格（两排：名字+创建者 / 稳定id+状态+前台+缓冲）：**触发器与下拉行共用同一个**
      // 渲染函数与同一套类 —— 表头与表内不一致的问题就从根上消失了。
      // 0.3.4 重设计第二行：**不再放长宽**（cols×rows 在详情/设置里都有，放这里既占位、
      // 又会在窄面板下把第二行断成两行 → 两排变三排破坏布局）；改为 id + 状态 + 前台
      // + 缓冲，整行 nowrap + 收缩省略，悬停 title 看全量。
      const sessionCell = (session, prefix, extraSub) => {
        if (session === null || session === undefined) {
          // 空态：与有 shell 的两排结构一致（父容器高度不会「有/无」跳变）
          return h('span', { key: prefix + 'cell', className: 'dshsh-cell' }, [
            h('span', { key: prefix + 'top', className: 'dshsh-row-top' }, [
              h('span', { key: prefix + 'n', className: 'dshsh-row-name' }, '(无 shell)'),
            ]),
            h('span', { key: prefix + 'sub', className: 'dshsh-row-sub' }, [
              h('span', { key: prefix + 'hint', className: 'dshsh-row-id' }, '点 ＋ 新建'),
            ]),
          ])
        }
        const subBits = []
        if (session.dead === true) subBits.push('⚰ 已退出(' + String(session.deadStatus ?? '?') + ')')
        else if (session.bell === true) subBits.push('🔔')
        if (typeof session.foreground === 'string' && session.foreground.trim() !== '') subBits.push(session.foreground)
        else if (subBits.length === 0) subBits.push('?')
        if (typeof session.historyBytes === 'number' && Number.isFinite(session.historyBytes)) subBits.push(fmtBytes(session.historyBytes))
        const metaText = subBits.join(' · ')
        return h('span', { key: prefix + 'cell', className: 'dshsh-cell' }, [
          h('span', { key: prefix + 'top', className: 'dshsh-row-top' }, [
            h('span', { key: prefix + 'n', className: 'dshsh-row-name', title: rowDisplayName(session) }, rowDisplayName(session)),
            h('span', {
              key: prefix + 'ow',
              className: 'dshsh-row-owner',
              // 截断后要能看全：悬停提示给完整名字
              title: '创建这个 shell 的会话：' + rowOwnerText(session),
            }, '创建者：' + rowOwnerText(session)),
          ]),
          h('span', { key: prefix + 'sub', className: 'dshsh-row-sub' }, [
            // 手动锁定标记：放在第二行**行首**（用户要求）—— 一眼扫左边缘即可发现被锁的壳
            session.lockKind === 'manual'
              ? h('span', {
                key: prefix + 'lk', className: 'dshsh-row-lock',
                title: '手动锁定' + (session.lockNote ? '（原因：' + session.lockNote + '）' : '')
                  + ' —— AI 不可操作它（写 / 改 / 关都被拒），只有你能在功能区里解锁',
              }, '🔒')
              : null,
            h('span', { key: prefix + 'id', className: 'dshsh-row-id', title: '稳定会话 id' }, session.name),
            h('span', { key: prefix + 'm', className: 'dshsh-row-meta', title: metaText }, metaText),
            extraSub === null || extraSub === undefined ? null : extraSub,
          ]),
        ])
      }

      // ── 折叠态：可拖动的悬浮胶囊 ──────────────────────────────────────────
      if (!expanded) {
        const pill = pillModel({ sessions, currentName, locked, shellName: shellNameOf() })
        const tone = {
          idle: 'var(--dsw-alias-state-success-primary)',
          busy: 'var(--dsw-alias-state-warn-primary)',
          none: 'var(--dsw-alias-label-tertiary)',
        }[pill.dotTone]
        return h('button', {
          key: 'pill',
          type: 'button',
          className: 'dshsh-pill' + (pill.busy ? ' busy' : ''),
          'aria-label': (pill.empty ? '后台 shell' : pill.fullName + (pill.counter === '' ? '' : '，第 ' + pill.counter))
            + (pill.busy ? '，有命令在运行' : '，空闲')
            + (locked ? '，输入已锁定' : '，输入已解锁')
            + '。点击展开面板，按住可拖动。',
          'aria-expanded': false,
          style: {
            ...S.pill,
            left: pos.x + 'px',
            top: pos.y + 'px',
            cursor: dragging ? 'grabbing' : 'grab',
          },
          title: pill.title,
          ...dragHandlers,
          onClick: () => {
            if (suppressClickRef.current) return
            setExpanded(true)
          },
        }, [
          // 拖动把手放最左：与面板标题栏的抓取点位置一致，右手拇指也更容易按到
          h('span', { key: 'grip', className: 'dshsh-grip' }, h(Icon, { name: 'grip', size: 14 })),
          // 状态点：一眼看出当前 shell 在不在跑东西
          h('span', { key: 'dot', className: 'dshsh-pill-dot', style: { background: tone } }),
          h('span', { key: 'i', className: 'dshsh-pill-mark' }, '>_'),
          h('span', { key: 'n', className: 'dshsh-pill-name' }, pill.label),
          pill.counter === '' ? null : h('span', { key: 'c', className: 'dshsh-count' }, pill.counter),
          h('span', {
            key: 'l',
            className: 'dshsh-pill-lock',
            // 锁定 = 安全默认，安静显示；解锁才需要注意（颜色语义修正）
            style: { color: pill.lockTone === 'warn' ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-label-tertiary)' },
          }, h(Icon, { name: locked ? 'lock' : 'unlock', size: 13 })),
        ].filter(Boolean))
      }

      // ── 展开态：锚定在胶囊位置（夹进视口），标题栏也可拖 ──────────────────
      const position = current === null ? 0 : sessions.findIndex((s) => s.name === currentName) + 1

      // 授权状态来自 /list 的 server.consent（面板本来就在轮询，不必额外请求）
      const consentModel = consentButtonModel(server === null ? null : server.consent, consentMenuOpen)

      const head = h('div', {
        key: 'head',
        className: 'dshsh-head' + (headCompact(panelRect.w) ? ' dshsh-compact' : ''),
        // 悬停看诊断：两端构建号 + 画面靠推送还是轮询（不用开 DevTools）
        title: '面板 ' + CLIENT_BUILD + ' · DSH ' + (hostBuild === '' ? '未上报' : hostBuild)
          + (hostBuild !== '' && hostBuild !== CLIENT_BUILD ? '（⚠ 需重启 dsh web）' : '')
          + ' · 画面：' + (sseOk === true ? '推送已连 ✓' : sseOk === false ? '推送断开，走轮询' : '连接中…'),
        'data-dshsh-head': true,
        style: { ...S.head, cursor: dragging ? 'grabbing' : 'grab' },
        ...panelDragHandlers,
      }, [
        // 名字＝下拉（多 shell 切换的唯一入口：左右箭头语义不明，弃用）
        // 显示内容与下拉菜单的行一致：名字 + 创建者 + 稳定 id（紧凑两排）
        h('button', {
          key: 'name',
          type: 'button',
          className: 'dshsh-name',
          onClick: () => toggleMenu('picker'),
          title: sessions.length > 1 ? '点击选择 shell（共 ' + String(sessions.length) + ' 个）' : '新建 shell 后在这里切换',
        }, [
          h('span', { key: 'dot', className: 'dshsh-dot' + (justIdle ? ' done' : ''), style: { background: dotColor(current) } }),
          current === null ? sessionCell(null, 'h-') : sessionCell(current, 'h-'),
          h(Icon, { key: 'c', name: 'down', size: 14 }),
        ]),
        // 锁与新建：紧随下拉（都在左侧叙事里，锁=输入态、新建=扩展）
        h('button', {
          key: 'lock',
          type: 'button',
          className: 'dshsh-btn ' + (locked ? 'locked' : 'on'),
          onClick: toggleLock,
          title: locked ? '已锁定：输入无效。点击解锁' : '已解锁：每个按键都会直接进终端。点击上锁',
        }, h(Icon, { name: locked ? 'lock' : 'unlock', size: 16 })),
        h('button', {
          key: 'new',
          type: 'button',
          className: 'dshsh-btn accent',
          onClick: newShell,
          disabled: busy,
          title: '新建 shell',
        }, h(Icon, { name: 'plus', size: 16 })),
        h('span', { key: 'count', className: 'dshsh-count' },
          sessions.length === 0 ? '0 / 0' : String(position) + ' / ' + String(sessions.length)),
        h('span', { key: 'sp', className: 'dshsh-spacer' },
          // 解锁 = 人正在操作：AI 的写已被宿主暂停。放在头部中间这片空白里居中显示，
          // **不碰 🔒 按钮**（按钮承担「锁定状态」的语义，加东西会搅乱它）。
          locked || currentName === ''
            ? null
            : h('span', { key: 'busybar', className: 'dshsh-busybar' }, '🤖 AI 写操作已暂停 · 你正在操作这台终端')),
        // ── 右侧按钮排（原样恢复）：授权｜回放｜日志｜详情｜缩小 ──────────────────
        // 仅缩小按钮保留警示色（用户指定）；其余按钮全部恢复最初的 h('button') 样式与顺序。
        serverFeatures !== null && serverFeatures.consent === false ? null : h('button', {
          key: 'consent',
          type: 'button',
          // 陈年老 bug：这里以前只有 consentModel.className（状态色），**没有"菜单是否打开"的标记** ——
          // 于是点开授权页头部按钮不会像详情/日志那样出现绿色包裹，看着像"点了没生效"。
          // 统一约定（与 详情/日志/引用库 三个按钮一致）：on = "这个浮层正开着"，
          // 其余状态一律不进 class（默认放行改由 title 与浮层内容表达）。
          className: consentModel.className + (consentMenuOpen ? ' on' : ''),
          onClick: () => {
            // 点开授权浮层：档位（完全控制 / 只读 / 完全禁止）× 时间（10 分钟 … 永久 / 自定义）
            // + 已授权会话列表。撤销在浮层里逐条做，比"点两下就全撤"更可控。
            toggleMenu('consent')
            if (consentArmTimer.current !== null) { clearTimeout(consentArmTimer.current); consentArmTimer.current = null }
            setConsentArmed(false)
          },
          disabled: consentBusy || !consentModel.enabled,
          title: consentModel.title + ' · ' + consentSummaryText(server === null ? null : server.consent?.wildcard),
          'aria-label': consentModel.label,
        }, h(Icon, { name: consentModel.icon, size: 16 })),
        serverFeatures !== null && serverFeatures.vault === false && serverFeatures.macros === false ? null : h('button', {
          key: 'secrets',
          type: 'button',
          className: 'dshsh-btn' + (secretsOpen ? ' on' : ''),
          onClick: () => toggleMenu('secrets'),
          title: '引用库：秘密域（人录入的 {{v:键}}，AI 只见键名）+ 宏命令（可复用片段 {{m:名}}，写入全入审计封链）',
        }, h(Icon, { name: 'key', size: 15 })),
        serverFeatures !== null && serverFeatures.replay === false ? null : h('button', {
          key: 'replay',
          type: 'button',
          className: 'dshsh-btn' + (replay !== null ? ' on' : ''),
          onClick: () => { if (replay !== null) { setReplay(null) } else { void openReplay() } },
          disabled: current === null || String(current.framesFile ?? '') === '',
          title: current !== null && String(current.framesFile ?? '') !== ''
            ? (replay !== null ? '关闭回放' : '回放这个 shell（逐帧·可拖动/倍速）')
            : '回放：此会话无帧录制（在设置里开 replayCapture，之后新建的会话才会记帧）',
        }, h(Icon, { name: 'film', size: 15 })),
        h('button', {
          key: 'settings',
          type: 'button',
          className: 'dshsh-btn' + (settingsOpen ? ' on' : ''),
          onClick: () => toggleMenu('settings'),
          title: '设置：与 DSH 设置同一份 Config / 同一个后端（插件内的备用入口）',
        }, h(Icon, { name: 'cog', size: 15 })),
        h('button', {
          key: 'info',
          type: 'button',
          className: 'dshsh-btn' + (infoOpen ? ' on' : ''),
          onClick: () => toggleMenu('info'),
          title: '详情：会话 / 缓冲 / 服务端 / 自动清理 / 审批 / 版本 / 键位表',
        }, h(Icon, { name: 'info', size: 15 })),
        UI.Btn({
          key: 'hide',
          variant: 'warn',
          icon: 'min',
          iconSize: 15,
          // 收起时顺手复位：别把"没执行的关闭意图"留在按钮上；人的操作也一并结束（人机互斥解除）
          onClick: () => { setLocked(true); setUserBusy(currentName, false); closeAllMenus(); setCloseArmed(false); setExpanded(false) },
          title: '收起（会自动上锁）',
        }),
      ])

      // ── shell 选择器：多 shell 时直接跳转，而不是一次次点箭头 ─────────────
      const picker = pickerOpen ? UI.Menu({
        key: 'picker',
        className: 'dshsh-u-sheet-left',   // 会话选择贴左侧（其余浮层靠右）
        top: String(topInset) + 'px',
        height: 'max(140px, calc(100% - ' + String((topInset + bottomReserve)) + 'px))',
        maxHeight: 'calc(100% - ' + String((topInset + bottomReserve)) + 'px)',
        title: '会话选择',
        chip: sessions.length > 0 ? String(sessions.length) + ' 个 shell' : undefined,
      }, [
        // 0.3.4：改用统一列表抽象（UI.List）——搜索/排序/空态/键盘都在组件里，
        // 行本身用 renderRow 自定义（保留内联改名、勾选、重命名、关闭）。
        UI.List({
          key: 'picker-list',
          placeholder: '搜索：名称 / 会话 id / 创建者',
          columns: [
            { key: 'updated', get: (s) => s.activityAt ?? s.createdAt ?? 0 },
            { key: 'name', get: (s) => rowDisplayName(s) + ' ' + s.name },
            { key: 'owner', get: (s) => rowOwnerText(s) },
          ],
          // 创建者筛选：选项从**当前真实出现的创建者**自动生成（面板 / 各对话标题），
          // 与搜索共用同一行 —— 左边选“谁建的”，右边打字找名字。
          filters: [{
            key: 'owner',
            label: '创建者',
            title: '按创建者筛选：只看某个人或某个对话建的 shell',
            options: (() => {
              const seen = []
              for (const s of (sessions ?? [])) {
                const who = rowOwnerText(s)
                if (who === '' || seen.some((o) => o.value === who)) continue
                seen.push({ value: who, label: who })
                if (seen.length >= 12) break
              }
              return seen
            })(),
          }],
          filterValues: { owner: pickerOwnerFilter },
          onFilterChange: (key, value) => { if (key === 'owner') setPickerOwnerFilter(String(value ?? '')) },
          rows: (sessions ?? [])
            .filter((s) => pickerOwnerFilter === '' || rowOwnerText(s) === pickerOwnerFilter)
            .map((s) => ({ ...s, __key: s.name })),
          query: pickerQuery,
          onQueryChange: (ev) => setPickerQuery(ev.target.value),
          sortKey: pickerSortKey,
          sortDir: pickerSortDir,
          onSort: (key, dir) => { setPickerSortKey(key); setPickerSortDir(dir) },
          sortOptions: [
            { value: 'updated', label: '最近活跃' },
            { value: 'name', label: '名称' },
            { value: 'owner', label: '创建者' },
          ],
          selectedKey: currentName,
          onRowClick: (s) => selectShell(s.name),
          emptyText: pickerQuery.trim() !== '' ? '没有匹配的 shell（清空搜索或按 Esc）' : '还没有 shell',
          renderRow: (session) => {
            const isCurrent = session.name === currentName
            // 改名中：就地把这一行换成输入框（回车/失焦确认，Esc 取消）
            // 手动锁：就地填原因（回车确认 / Esc 取消）。原因会写进 AI 的拒绝提示。
            if (lockEditFor === session.name) {
              return h('div', { key: 'lk-' + session.name, className: 'dshsh-row current' }, [
                h('div', { key: 'edit', className: 'dshsh-rename' }, [
                  h('span', { key: 'd', className: 'dshsh-dot', style: { background: dotColor(session) } }),
                  h('input', {
                    key: 'in',
                    type: 'text',
                    autoFocus: true,
                    value: lockNote,
                    placeholder: '锁定原因（可选，会写进 AI 被拒时的提示）',
                    onChange: (event) => { setLockNote(event.target.value); setNotice('') },
                    onKeyDown: (event) => {
                      if (event.key === 'Enter') { event.preventDefault(); void submitManualLock(session.name, true, lockNote) }
                      if (event.key === 'Escape') { event.preventDefault(); setLockEditFor(''); setNotice('') }
                    },
                  }),
                  h('button', {
                    key: 'ok', type: 'button', className: 'dshsh-btn dshsh-row-x', style: { opacity: 1 },
                    title: '确认锁定（此后 AI 写它、改它、关它都会被拒）',
                    onClick: () => { void submitManualLock(session.name, true, lockNote) },
                  }, '🔒 锁定'),
                  h('button', {
                    key: 'no', type: 'button', className: 'dshsh-btn dshsh-row-x', style: { opacity: 1 },
                    title: '取消（不锁定）',
                    onClick: () => { setLockEditFor(''); setNotice('') },
                  }, '取消'),
                ]),
              ])
            }
            return h('div', {
              key: 'r-' + session.name,
              // 勾选反馈：多选是主要交互，已勾的行必须有明显底色（只靠小方框不够）
              className: 'dshsh-row' + (isCurrent ? ' current' : '') + (batch.includes(session.name) ? ' sel' : ''),
            }, [
              h('button', {
                key: 'ck',
                type: 'button',
                className: 'dshsh-ck' + ((Array.isArray(batch) && batch.includes(session.name)) ? ' on' : ''),
                onClick: () => toggleBatch(session.name),
                title: ((Array.isArray(batch) && batch.includes(session.name)) ? '取消选中 ' : '选中 ') + session.name + '（用于批量操作）',
                'aria-pressed': Array.isArray(batch) && batch.includes(session.name),
              }, (Array.isArray(batch) && batch.includes(session.name)) ? '☑' : '☐'),
              h('button', {
                key: 'it',
                type: 'button',
                className: 'dshsh-item',
                onClick: () => selectShell(session.name),
                title: '切到「' + rowDisplayName(session) + '」（' + session.name + '）',
              }, [
                h('span', { key: 'd', className: 'dshsh-dot', style: { background: dotColor(session) } }),
                sessionCell(session, 'r-'),
              ]),
              h('button', {
                key: 'rn',
                type: 'button',
                className: 'dshsh-btn dshsh-row-x',
                onClick: () => {
                  // 重命名不再就地编辑：选中这一行，让功能区弹出重命名表单
                  setBatch([session.name])
                  setRenaming(session.name)
                  setRenameDraft(session.name.startsWith('dsh-') ? session.name.slice(4) : session.name)
                  setBatchToolsOpen('rename')
                },
                title: '重命名 ' + session.name + '（在下方功能区里改）',
              }, h(Icon, { name: 'pencil', size: 13 })),
              h('button', {
                key: 'x',
                type: 'button',
                className: 'dshsh-btn danger dshsh-row-x',
                onClick: () => {
                  markClosing(session.name)   // 自己关的：随后的 gone 静默，不再弹“可能已被回收”
                  void api('/kill', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ name: session.name }),
                  })
                },
                title: '关闭 ' + session.name,
              }, h(Icon, { name: 'x', size: 13 })),
            ])
          },
        }),
        // 用户拍板：勾选后由功能区占这块位置 —— 有选中项时隐藏「新建 shell」
        batchInfo.count === 0
          ? h('button', {
            key: 'mk',
            type: 'button',
            className: 'dshsh-new',
            onClick: () => { setPickerOpen(false); void newShell() },
            disabled: busy,
          }, [h(Icon, { key: 'p', name: 'plus', size: 13 }), h('span', { key: 't' }, '新建 shell')])
          : null,
        // 0.3.4 (C)：批量操作条（选中 ≥1 时出现）
        batchInfo.count === 0
          ? null
          : h('div', { key: 'batch', className: 'dshsh-batch' }, [
              // 第一行：选择相关（用户规格：全选 / 反选 / ✕ 关闭功能区）
              h('div', { key: 'r1', className: 'dshsh-batch-row' }, [
                h('span', { key: 'n', className: 'dshsh-batch-n' },
                  '已选 ' + String(batchInfo.count) + ' / ' + String(batchInfo.total)),
                h('button', {
                  key: 'all', type: 'button', className: 'dshsh-stat-btn',
                  onClick: () => setBatch((sessions ?? []).map((s) => s.name)),
                  title: '全选（当前列表里的全部）',
                }, '全选'),
                h('button', {
                  key: 'inv', type: 'button', className: 'dshsh-stat-btn',
                  onClick: () => setBatch(batchInvert()),
                  title: '反选：已勾的取消、未勾的选上',
                }, '反选'),
                h('button', {
                  key: 'clr', type: 'button', className: 'dshsh-stat-btn',
                  onClick: () => { setBatch([]); setBatchToolsOpen('') },
                  title: '关闭功能区（本质就是取消全部勾选）',
                }, '✕'),
              ]),
              // 第二行：操作（打开尺寸/上锁表单时就地替换这一行，功能区始终保持两行）
              h('div', { key: 'r2', className: 'dshsh-batch-row' }, batchToolsOpen === ''
                ? [
                  h('button', {
                    key: 'ren', type: 'button', className: 'dshsh-stat-btn',
                    onClick: () => { batchRename() }, title: '重命名（可多选：输入基名后自动编号 1、2、3…；默认名=当前 shell 的 id）',
                  }, '重命名'),
                  h('button', {
                    key: 'sz', type: 'button', className: 'dshsh-stat-btn',
                    onClick: () => setBatchToolsOpen('size'), title: '修改尺寸：改所选 shell 的 cols×rows',
                  }, '修改尺寸'),
                  h('button', {
                    key: 'ml', type: 'button', className: 'dshsh-stat-btn',
                    onClick: () => { setBatchLockNote(''); setBatchToolsOpen('lock') },
                    title: '上锁（手动锁）：锁定后 AI 不可操作它 —— 写 / 改 / 关一律被拒，只能由你手动解锁；若所选里已有锁定项会拒绝并说明',
                  }, '上锁'),
                  h('button', {
                    key: 'mu', type: 'button', className: 'dshsh-stat-btn',
                    onClick: () => { batchManualLock(false, '') }, title: '解锁：解除手动锁，AI 可以再次操作；若所选都没有锁会拒绝并说明',
                  }, '解锁'),
                  h('button', {
                    key: 'doc', type: 'button', className: 'dshsh-stat-btn',
                    onClick: () => { batchDoctor() }, title: '自检：前台卡否 / 空闲多久 / 缓冲用量 / 留痕是否停了 → 建议',
                  }, '自检'),
                  h('button', {
                    key: 'kill', type: 'button', className: 'dshsh-stat-btn danger',
                    onClick: () => { batchKill() }, title: '关闭这些 shell（连同其中运行的进程）',
                  }, '关闭 shell'),
                ]
                : (batchToolsOpen === 'rename'
                  ? [
                    h('span', { key: 'l', className: 'dshsh-batch-n' }, '重命名'),
                    h('input', {
                      key: 'rn', type: 'text', className: 'dshsh-consent-sizein', style: { width: '180px' },
                      autoFocus: true, value: renameDraft, placeholder: '新名字（可用中文）',
                      onChange: (event) => setRenameDraft(event.target.value),
                      onKeyDown: (event) => {
                        if (event.key === 'Enter') { event.preventDefault(); void submitRename(renaming).then(() => setBatchToolsOpen('')) }
                        if (event.key === 'Escape') { event.preventDefault(); setRenaming(''); setBatchToolsOpen('') }
                      },
                    }),
                    h('button', {
                      key: 'go', type: 'button', className: 'dshsh-stat-btn',
                      onClick: () => { void submitRename(renaming).then(() => setBatchToolsOpen('')) },
                    }, '应用'),
                    h('button', {
                      key: 'no', type: 'button', className: 'dshsh-stat-btn',
                      onClick: () => { setRenaming(''); setBatchToolsOpen('') },
                    }, '取消'),
                  ]
                  : (batchToolsOpen === 'size'
                  ? [
                    h('span', { key: 'l', className: 'dshsh-batch-n' }, '尺寸'),
                    h('input', {
                      key: 'c', type: 'number', className: 'dshsh-consent-sizein', value: batchSizeDraft.cols,
                      title: '列数 cols（20–500）',
                      onChange: (event) => setBatchSizeDraft((p) => ({ ...p, cols: event.target.value })),
                    }),
                    h('span', { key: 'x', className: 'dshsh-consent-sizedim' }, '×'),
                    h('input', {
                      key: 'rw', type: 'number', className: 'dshsh-consent-sizein', value: batchSizeDraft.rows,
                      title: '行数 rows（5–200）',
                      onChange: (event) => setBatchSizeDraft((p) => ({ ...p, rows: event.target.value })),
                    }),
                    h('button', { key: 'go', type: 'button', className: 'dshsh-stat-btn', onClick: () => batchSizeApply() }, '应用'),
                    h('button', { key: 'no', type: 'button', className: 'dshsh-stat-btn', onClick: () => setBatchToolsOpen('') }, '取消'),
                  ]
                  : [
                    h('span', { key: 'l', className: 'dshsh-batch-n' }, '上锁原因'),
                    h('input', {
                      key: 'note', type: 'text', className: 'dshsh-consent-sizein', style: { width: '190px' },
                      value: batchLockNote, placeholder: '可选，会写进 AI 被拒时的提示',
                      onChange: (event) => setBatchLockNote(event.target.value),
                    }),
                    h('button', {
                      key: 'go', type: 'button', className: 'dshsh-stat-btn',
                      onClick: () => batchManualLock(true, batchLockNote.trim()),
                    }, '锁定'),
                    h('button', { key: 'no', type: 'button', className: 'dshsh-stat-btn', onClick: () => setBatchToolsOpen('') }, '取消'),
                  ]))),
            ]),
      ]) : null

      // 0.3.3：插件还没跑完启动链时屏幕当然是空的 —— 但那不是「没有输出」，是「还没开始」
      const su2 = server !== null && typeof server === 'object' && server.startup !== null && typeof server.startup === 'object'
        && server.startup.phase !== undefined && server.startup.phase !== 'ready'
      const body = h('pre', {
        key: 'screen',
        ref: screenRef,
        className: 'dshsh-screen',
        style: { ...S.screen, ...(mouseMode ? { cursor: 'crosshair' } : {}) },
        onScroll: onScreenScroll,
        // 鼠标模式：按下 / 拖动 / 松开 / 滚轮都交给终端（关闭时不拦截，保持可选中文本）
        onPointerDown: (e) => {
          if (mouseMode !== true) return
          e.preventDefault()
          mouseDragRef.current.active = true
          if (typeof e.currentTarget.setPointerCapture === 'function' && e.pointerId !== undefined) {
            try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* 忽略 */ }
          }
          sendMouseAt(e, 'down')
        },
        onPointerMove: (e) => { if (mouseDragRef.current.active === true) sendMouseAt(e, 'drag') },
        onPointerUp: (e) => {
          if (mouseDragRef.current.active !== true) return
          mouseDragRef.current.active = false
          sendMouseAt(e, 'up')
        },
        onPointerCancel: () => { mouseDragRef.current.active = false },
        // 右键：鼠标模式下发给程序；否则按终端惯例**粘贴**（不再弹浏览器菜单）
        onContextMenu: (e) => {
          e.preventDefault()
          if (mouseMode !== true) void pasteFromClipboard()
        },
      }, [
        h('span', { key: 'text', className: 'dshsh-screen-text' },
          screen === ''
            ? (su2 === true
              ? '(插件启动中…)'
              // 用户实测反馈：面板还没拿到服务端状态时（server === null）也是 su2 === false，
              // 于是把“还在连插件”误报成“(无输出)”，并在首屏 `/list` 回来前一直这么写（实测约 1 分钟）。
              // 三种情形分开说：未就绪 / 正在连 / 正在加载某会话 —— 只有确实无输出才说无输出。
              : (server === null
                ? '(正在连接插件…)'
                : (currentName !== ''
                  ? `(正在加载 ${(sessions.find((s) => s.name === currentName) || {}).label || currentName} 的屏幕…)`
                  : '(无输出)')))
            : (() => {
                // 0.3.4：SGR 渲染 —— 颜色/背景/粗细/反显逐段套样式；搜索高亮在
                // **纯文本**上与样式段正交合并（renderScreenLines 一次算好）。
                const showSearch = searchOpen && searchQuery !== '' && searchModel.count <= MAX_RENDER_HITS
                const { lines } = renderScreenLines(screen, { query: showSearch ? searchQuery : '' })
                return lines.map((row, li) => {
                  const active = showSearch && searchModel.lineHits[searchHit] === li
                  const kids = row.map((seg, si) => {
                    if (seg.hit) {
                      return h('mark', {
                        key: 'm' + li + '-' + si,
                        className: 'dshsh-hit' + (active ? ' current' : ''),
                        style: seg.style === null ? undefined : seg.style,
                      }, seg.text)
                    }
                    return seg.style === null
                      ? seg.text
                      : h('span', { key: 's' + li + '-' + si, style: seg.style }, seg.text)
                  })
                  return [...kids, '\n']
                })
              })()),
        // 隐藏样本：横向实测失败时用于估算单元格宽度
        h('span', {
          key: 'measure', ref: measureRef, 'aria-hidden': 'true',
          style: { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre', pointerEvents: 'none' },
        }, 'M'.repeat(40)),
        caret === null ? null : h('span', { key: 'caret', className: 'dshsh-caret', 'aria-hidden': 'true', style: caret.style }),
      ])

      // ── ⓘ 详情层：把 README 里那些「说明书级」信息搬到面板内 ──────────────
      // 性能：详情页关闭时完全不构建详情行（此前每次轮询都白算全部页签/审计/捕获行）。
      const infoSections = infoOpen ? buildInfoRows({
        server,
        meta,
        sessions,
        subscriptions,
        historyWindow,
        maxWindow: MAX_WINDOW,
        pkgVersion: PKG_VERSION,
        build: BUILD,
        pluginStatus,
        pluginStatusError,
        locked,
        auditScan,
      }) : []
      // 卡片归属 + 折叠状态（2026-09-22 整理后：10 个逻辑分组 → 6 张卡）
      // 页签内容：该页签下的分组（隐藏段落照旧过滤）；组标题行 + 键值行沿用原渲染
      /** 同名分组**合并为一段**（用户要求：当前会话+缓冲取景、会话台账+会话策略 各合成一个）。 */
      const groupSections = (list) => {
        const out = []
        const at = {}
        for (const s2 of list) {
          const g = String(s2.group)
          if (at[g] === undefined) { at[g] = out.length; out.push({ group: s2.group, rows: [].concat(s2.rows ?? []), tableRows: Array.isArray(s2.tableRows) ? s2.tableRows.slice() : undefined, flow: s2.flow, dismissable: s2.dismissable }) }
          else {
            out[at[g]].rows = out[at[g]].rows.concat(s2.rows ?? [])
            if (Array.isArray(s2.tableRows)) {
              out[at[g]].tableRows = (Array.isArray(out[at[g]].tableRows) ? out[at[g]].tableRows : []).concat(s2.tableRows)
            }
            if (out[at[g]].flow === undefined) out[at[g]].flow = s2.flow
          }
        }
        return out
      }
      const infoTabGroups = groupSections(infoSections.filter((section) => {
        // 订阅表并进「概览」后，能力关闭时按**分组**过滤（原先靠页签整体隐藏）
        if (section.group === '订阅列表' && serverFeatures !== null && serverFeatures.watch === false) return false
        return (INFO_TAB_OF[section.group] ?? '概览') === infoTab && hiddenSections[section.group] !== true
      }))
      const infoCapabilityRows = [
        { k: '菜单壳', v: '统一（标题 / 徽标 / 页签 / 实测上下边界）', title: '上边界=内容上边界、下边界=状态栏上方（实测驱动）' },
        { k: '菜单宽度', v: '676px · 会话选择 442 · 详情 406', title: '按视口约束，可比面板宽' },
        { k: '分区方式', v: '上下分区（表格在上，详情/表单在下方按需出现）', title: '默认全部高度给表格；选中一项或点新增后下方弹出' },
        { k: '列表三部分', v: '筛选行（左键筛选 + 右搜索）｜表头（全列 + 操作列）｜显示区', title: '显示区：一行一条、不换行、溢出省略、行高与表头一致（30px）' },
        { k: '列宽', v: '自适应 + 拖表头右缘调整（按表持久化）', title: '写在 localStorage：terminalkeeper:table:colw' },
        { k: '排序', v: '点表头切换升/降序', title: '不再有额外的排序下拉' },
        { k: '数据加载', v: '空闲预热 + 缓存优先 + 20s 节流', title: '打开菜单命中缓存（实测首次 964ms → 29ms）；慢请求后台补' },
        { k: '尺寸测量', v: 'ResizeObserver（不再每秒轮询）', title: '展开/开浮层时会强制测一次' },
        { k: '快捷键', v: shellPanelShortcutLive
            ? '开合面板已注册进官方快捷键系统（' + shellPanelShortcutKeys() + '，可在 DSH 设置里自定义）'
            : '开合面板用内置的备用键位（DSH 没有提供快捷键功能）',
          title: '官方服务负责冲突检测与用户偏好持久化；终端键（bash / PowerShell / tmux）一律不抢' },
        { k: '授权模型', v: '默认规则（出厂禁止）+ 新会话复制一份', title: '复制是值拷贝；改默认不影响已建会话' },
        { k: '引用库', v: '秘密域（人写、AI 只见键名）｜宏（写入全入审计封链）', title: '秘密支持一次性 / TTL；宏可嵌 {{v:键}}' },
        { k: '审计', v: '删除先写入链见证（event:purge + 文件名 + 哈希）', title: '销毁过什么永远可证' },
      ]
      // 跨层跳转：目标 tab 可能在另一层（如总览卡指向「日志审计」）——必须同时切层，
      // 否则会出现“内容换了、页签还停在旧层”的错位（实测：点审计占用后页签仍是「状态」层）。
      const jumpToTab = (tab) => {
        const target = (Array.isArray(visibleInfoLayers) ? visibleInfoLayers : []).find((l) => Array.isArray(l.tabs) && l.tabs.includes(tab))
        if (target !== undefined && target.key !== infoLayer) setInfoLayer(target.key)
        setInfoTab(tab)
      }

      const info = infoOpen ? UI.Menu({
        key: 'info',
        className: 'dshsh-u-sheet dshsh-u-sheet-detail',
        top: String(topInset) + 'px',
        height: 'max(140px, calc(100% - ' + String((topInset + bottomReserve)) + 'px))',
        maxHeight: 'calc(100% - ' + String((topInset + bottomReserve)) + 'px)',
        title: '详情',
        // 第一行：两个大层
        tabs: visibleInfoLayers.map((layer) => ({
          id: layer.key, label: layer.label, active: infoLayer === layer.key,
          onClick: () => { setInfoLayer(layer.key); setInfoTab(layer.tabs[0]) },
          title: layer.label + '：' + layer.hint,
        })),
        // 第二行：当前大层的小标签（复用同一套页签样式 ⇒ 「两大层 → 小标签」两行结构）
        tabs2: (
          (visibleInfoLayers.filter((l) => l.key === infoLayer)[0] || visibleInfoLayers[0]).tabs.map((tab) => h('button', {
            key: tab, type: 'button',
            className: 'dshsh-u-tab' + (infoTab === tab ? ' on' : ''),
            onClick: () => jumpToTab(tab),
            title: '查看「' + tab + '」相关全部信息',
          }, tab))),
        actions: [
          // 2026-10-24：磁盘占用统计移进「日志审计」页（用户指出与日志页重合）
          h('button', {
            key: 'copy', type: 'button',
            className: 'dshsh-stat-btn' + (copied ? ' go' : ''),
            onClick: copyInfo,
            title: '复制全部信息（所有页签）到剪贴板，粘贴给他人即可排查',
          }, copied ? '已复制' : '复制全部'),
          h('button', {
            key: 'close', type: 'button',
            className: 'dshsh-btn',
            style: { minWidth: '22px', height: '22px' },
            onClick: () => setInfoOpen(false),
            title: '关闭详情',
          }, '✕'),
        ],
      }, [
        infoTab === '总览'
          ? (() => {
              // 总览（2026-10-24）：详情层的落地页。只放「一眼要看清」的基本信息，
              // 密集数据仍留在原来各页签；所有数字都取自面板已有的轮询状态（不新增请求），
              // 指标卡点击直达对应页签 —— 详情页因此从「十页签平铺」变成「先总览再下钻」。
              const online = server !== null && typeof server === 'object'
              const sess = Array.isArray(sessions) ? sessions : []
              const lockedN = sess.filter((s) => String((s || {}).lockKind ?? '') !== '').length
              const subsN = Array.isArray(subscriptions) ? subscriptions.length : 0
              const featureKeys = Object.keys(FEATURE_LABELS)
              const featureOn = serverFeatures === null
                ? null
                : featureKeys.filter((k) => serverFeatures[k] === true).length
              const m = meta !== null && typeof meta === 'object' ? meta : {}
              const curName = String(m.name ?? '')
              const curCwd = prettyPath(String(m.cwd ?? ''))
              const sizeText = Number.isFinite(m.cols) && Number.isFinite(m.rows)
                ? String(m.cols) + '×' + String(m.rows)
                : '—'
              const notes = online && Array.isArray(server.envNotes) ? server.envNotes : []
              const noteWarn = notes.some((n) => /降级|压制|不存活|不准|关闭/.test(String(n)))
              const card = (key, label, value, sub, tab, tone) => h('button', {
                key,
                type: 'button',
                className: 'dshsh-ov-card' + (tone === undefined ? '' : ' ' + tone),
                onClick: () => jumpToTab(tab),
                title: '查看「' + tab + '」页签',
              }, [
                h('span', { key: 'k', className: 'dshsh-ov-k' }, label),
                h('span', { key: 'v', className: 'dshsh-ov-v' }, value),
                h('span', { key: 's', className: 'dshsh-ov-s' }, sub),
              ])
              return h('div', { key: 'overview', className: 'dshsh-ov' }, [
                h('div', { key: 'hero', className: 'dshsh-ov-hero' }, [
                  h('div', { key: 'l', className: 'dshsh-ov-hero-l' }, [
                    h('span', { key: 'e', className: 'dshsh-ov-eyebrow' }, 'AGENT SHELL · 面板插件'),
                    h('div', { key: 't', className: 'dshsh-ov-hero-t' }, [
                      h('b', { key: 'n' }, 'Agent Shell'),
                      h('em', { key: 'v', className: 'dshsh-ov-chip' }, 'v' + String(PKG_VERSION)),
                      featureOn === null
                        ? null
                        : h('em', { key: 'c', className: 'dshsh-ov-chip dim' }, String(featureOn) + '/' + String(featureKeys.length) + ' 能力'),
                    ]),
                    h('p', { key: 'd', className: 'dshsh-ov-hero-sub' },
                      '长期存活的终端壳：会话、订阅、审计、引用库都收在这个面板里。'),
                  ]),
                  h('span', { key: 's', className: 'dshsh-ov-pill ' + (online ? 'ok' : 'warn') }, [
                    h('i', { key: 'd' }),
                    online ? '已连接' : '连接中',
                  ]),
                ]),
                h('div', { key: 'facts', className: 'dshsh-ov-facts' }, [
                  { k: '当前会话', v: curName === '' ? '未选择' : curName, t: '面板正在查看的 shell' },
                  { k: '尺寸', v: sizeText, t: 'cols × rows' },
                  { k: '工作目录', v: curCwd === '' ? '—' : curCwd, t: curCwd },
                ].map((f) => h('div', { key: f.k, className: 'dshsh-ov-fact', title: f.t }, [
                  h('span', { key: 'k' }, f.k),
                  h('b', { key: 'v' }, f.v),
                ]))),
                h('div', { key: 'grid', className: 'dshsh-ov-grid' }, [
                  card('sess', '会话', String(sess.length), lockedN > 0 ? String(lockedN) + ' 个已锁定' : '未锁定', '概览', ''),
                  card('subs', '订阅', String(subsN), subsN > 0 ? '个订阅在跑' : '暂无订阅（看「概览」底部）', '概览', ''),
                  card('feat', '能力', featureOn === null ? '—' : String(featureOn), featureOn === null ? 'DSH 还没上报' : '共 ' + String(featureKeys.length) + ' 项', '运行', ''),
                ]),
                notes.length === 0
                  ? null
                  : h('div', { key: 'note', className: 'dshsh-ov-note' + (noteWarn ? ' warn' : '') }, [
                    h('span', { key: 'i' }, noteWarn ? '⚠' : 'ℹ'),
                    h('span', { key: 't' }, notes.join(' · ')),
                  ]),
                h('div', { key: 'jump', className: 'dshsh-ov-jump' }, [
                  h('span', { key: 'l', className: 'dshsh-ov-jump-l' }, '其它层'),
                  ...['事件记录', '日志审计', '键位帮助'].map((tab) => h('button', {
                    key: tab,
                    type: 'button',
                    className: 'dshsh-ov-jump-b',
                    onClick: () => jumpToTab(tab),
                    title: '跳到「' + tab + '」',
                  }, tab)),
                ]),
              ])
            })()
          : infoTab === '键位帮助'
          ? (() => {
              // 每条能力统一按「为什么 / 怎么做 / 归谁管」三段写，且**只用日常词**：
              // 插件面向的是用 DSH 干活的人，不一定写过程序。专业词一律在括号里给一次，
              // 或者在最后的「术语对照」表里翻译（用户 2026-10-24 的明确要求）。
              const lcRow = (key, k, v) => h('div', { key, className: 'dshsh-lc-row' }, [
                h('b', { key: 'k' }, k),
                h('span', { key: 'v' }, v),
              ])
              const lcSection = (key, title, rows) => h('div', { key, className: 'dshsh-info-group' }, [
                h('span', { key: 'n' }, title),
                ...rows.map((r, ri) => lcRow('r' + String(ri), r[0], r[1])),
              ])
              const lcSocket = String((server && server.socket) || 'terminalkeeper')
              const lcDir = prettyPath(String((server && server.audit && server.audit.dir) || '~/.dsh/terminalkeeper'))
              return h('details', { key: 'lifecycle-box', className: 'dshsh-card dshsh-lifecycle' }, [
                h('summary', { key: 'lc-h', className: 'dshsh-card-h' }, '它是怎么工作的、数据放在哪（点开看）'),
                h('div', { key: 'lc-b', className: 'dshsh-card-body' }, [
                  lcSection('lc-why', '先说清楚：为什么做成这样', [
                    ['为什么', '插件本身住在 DSH 里面。DSH 一重启、插件一重载，插件里开出来的东西（工具、页面入口、定时器、子进程）都会被一起收走。可终端会话不能跟着没 —— 不然每次改插件、每次重启，正在跑的编译和服务全断。'],
                    ['怎么做', '拆成三层：DSH 里只留薄薄一层（负责登记和转达）；中间一个独立的后台小程序（负责排队执行，也只有它写记录）；最下面是 tmux，真正跑终端的地方。DSH 怎么重启都碰不到最下面这层。'],
                    ['代价', '多两个后台小程序、多一个数据目录。换来的是：改插件不掉会话、重启能接回原来的终端。'],
                  ]),
                  lcSection('lc-session', '1 · 终端会话（tmux）', [
                    ['为什么', '一条命令跑完，进程就结束了。但你需要的是“一直开着”：编译、本地服务、交互式命令都是这样；而且人和 AI 得能看同一块屏幕。'],
                    ['怎么做', '每个终端 = 一个 tmux 会话（关掉状态栏和鼠标、按键延迟降到 10 毫秒、保留 10 万行历史）。第一次开时优先交给系统的用户服务托管，这样 DSH 重启后它还活着；系统不提供这个能力，就退成普通后台进程，并在本页和日志里直说。'],
                    ['归谁管', '不在 DSH 里。禁用或卸载都保留；DSH 意外死掉由第 3 条的清理进程收尾。'],
                  ]),
                  lcSection('lc-supervisor', '2 · 后台监督进程', [
                    ['为什么', 'tmux 同一时刻只接受一个写入者。面板、工具、清理进程一起操作会打架，典型症状是“刚建完就读不到”。记录也需要“只有一个人写”，否则顺序会乱。'],
                    ['怎么做', '单独一个后台进程，走本机专用通道 + 口令校验；握手时比对版本和能力清单，对不上就换掉它；只接受清单里写明的操作。'],
                    ['换代码', '版本号变了会自动换一个新的，不用重启 DSH。会话不在它肚子里，换掉也不丢。'],
                  ]),
                  lcSection('lc-watchdog', '3 · 自动清理进程（看门狗）', [
                    ['为什么', 'DSH 被强杀时没人收尾，tmux 会一直挂着占内存，还会留下“看着活着、其实没人管”的会话。'],
                    ['怎么做', '单独一个小进程，隔一会儿确认 DSH 还在不在。确认死了再等一小会儿，把 tmux 关掉；DSH 正常退出时它自己退出，不添乱。'],
                    ['归谁管', '不在 DSH 里。连“禁用插件”都不该杀它 —— 它是会话的保镖。'],
                  ]),
                  lcSection('lc-tools', '4 · 给 AI 用的工具（7 个）', [
                    ['为什么', '让 AI 能开终端、跑命令、看屏幕、按键、管生命周期、查记录。它不是“再包一层命令行”，而是带状态和记录的终端操作。'],
                    ['怎么做', '开 / 跑 / 读 / 发 / 管 / 查 这七件事各一个工具，全部交给第 2 条的后台进程落到 tmux。看屏幕只取新增部分，按键按“键名”发而不是拼字符串（避免被特殊字符骗到）。'],
                    ['归谁管', 'DSH 内，跟着插件注册。禁用后 AI 就看不到这些工具了。'],
                  ]),
                  lcSection('lc-panel', '5 · 你看到的这个面板', [
                    ['为什么', 'AI 在跑长任务时，人要能看、能打断、能自己敲。只有 AI 的视角不够用。'],
                    ['怎么做', '挂在 DSH 界面右侧的浮层，分列表 / 终端 / 详情三层；快捷键走 DSH 自己的快捷键设置，可改、会查冲突；面板只调第 2 条的后台进程，不直接碰 tmux。'],
                    ['归谁管', 'DSH 内。禁用插件就消失，会话不受影响。'],
                  ]),
                  lcSection('lc-watch', '6 · 订阅（有新输出就叫你）', [
                    ['为什么', '等长任务时反复把整屏读一遍，又慢又费 token。真正想要的是：有新输出时通知我。'],
                    ['怎么做', '每人记住“读到哪了”，只保留最近一段输出；新内容按增量交给 AI。缓冲区放不下的部分会明确标成“丢了多少字”，不假装没丢。'],
                    ['归谁管', '订阅关系存在后台进程里，终端在 tmux 里。禁用后订阅失效，终端还在。'],
                  ]),
                  lcSection('lc-audit', '7 · 操作记录（审计）', [
                    ['为什么', '人和 AI 用的是同一套入口。事后必须能说清：谁、什么时候、对哪个终端、做了什么 —— 而且不能只靠“相信日志没被改”。'],
                    ['怎么做', '每天一条首尾相扣的记录链，改掉中间任何一条都会对不上；再定期给链尾盖一个数字签名（别人无法伪造）。删除前先记下“删了什么文件、内容指纹是多少”，所以“销毁过什么”也留得住。保留多久可以按天设置。'],
                    ['归谁管', '不在 DSH 里（' + lcDir + '）。禁用/卸载都保留；彻底清理见第 10 条。'],
                  ]),
                  lcSection('lc-vault', '8 · 引用库（放密码的地方）', [
                    ['为什么', 'AI 不该看到你的明文密码，但又必须能用。另一面：如果防篡改只靠“文件里写着版本号”，删掉那个标记就能悄悄回滚。'],
                    ['怎么做', '磁盘上是“分组 + 密文 + 一个防回滚的校验标记 + 使用次数记录”。三种保护方式：不加密（明文）/ 简单混淆（用本机固定钥匙，只防明文被全盘搜到）/ 口令加密（用你的口令推导钥匙，钥匙只在内存里）。AI 只看得见键名，命令里写 {{v:键名}} 才会替换成真值。'],
                    ['改模式', '加密组换模式前必须先解开旧内容（锁着就先输口令），否则旧内容解不开、会被重新封成空的 —— 所以面板会先要求解锁。'],
                  ]),
                  lcSection('lc-misc', '9 · 宏 / 工作区 / 快照 / 回放', [
                    ['为什么', '重复命令想复用；多终端布局想一键还原；危险操作前想要一个回滚点；出问题时想倒回去看屏幕怎么变的。'],
                    ['怎么做', '宏 = 可复用的命令片段（命令里写 {{m:名字}}，存进去的过程也进记录链）；工作区 = 一组终端的命名存档，恢复时按名字重建；快照 = 终端和布局的存档；回放 = 可选的屏幕录像 + 标记点，默认关闭（拿硬盘空间换可查性，设置里开）。'],
                    ['归谁管', '不在 DSH 里（数据目录）。禁用/卸载保留。'],
                  ]),
                  lcSection('lc-safety', '10 · 授权 / 危险命令提醒 / 打码', [
                    ['为什么', 'AI 能执行命令，就得有一道闸门；屏幕输出里可能混着密码和令牌，转发给 AI 前得挡住。'],
                    ['怎么做', '授权规则默认拒绝、可按会话单独放宽，有官方审批就用官方的，没有时页面会直接写“没有官方审批”而不是假装有。危险命令提醒只是“减速带”，不是隔离墙。打码会按规则把像密钥的内容替换掉。'],
                    ['归谁管', '规则跟着会话走（DSH 内）；判断与留痕在 DSH 外。'],
                  ]),
                  lcSection('lc-own', '11 · 归谁管：DSH 内 vs DSH 外', [
                    ['DSH 管理内', '工具注册、网页入口、面板和设置卡、给 AI 的系统提示词、设置项定义，以及当前这次运行的轮询/订阅/录像定时器。这些插件一卸载就停。'],
                    ['DSH 管理外', 'tmux（' + lcSocket + '）和里面的终端；后台监督进程（本地通道/进程号/口令）；清理进程和临时租约文件；数据目录 ' + lcDir + '（记录/密码库/快照/回放/配置）。'],
                    ['彻底清理', '在仓库目录运行 node purge-all.mjs --dry-run 先看清单，再 --yes 执行；或 npx -y terminalkeeper purge-data --yes。'],
                  ]),
                  lcSection('lc-disable', '12 · 禁用 / 热重载 / 卸载', [
                    ['禁用', '暂时不用：数据、会话、清理进程全部保留，重新启用就接着用，什么都不用恢复。'],
                    ['热重载', '等于“禁用 + 重启插件”：界面和工具重建，终端在 tmux 里不受影响（这也是为什么改插件代码不用重启 DSH）。'],
                    ['卸载', 'DSH 没有“卸载”回调，插件分不清你是卸载、禁用还是热重载，所以一律不删数据。确认不要了，请显式执行 purge-data --yes。'],
                  ]),
                  lcSection('lc-err', '14 · 出错时看这个码（报问题时贴这一句就够）', [
                    ['DSH_UNREACHABLE', '连不上 DSH。先看 dsh web 还在不在跑、端口通不通、SSH 隧道断没断。'],
                    ['DSH_TOO_OLD', '插件比 DSH 新，接口还不存在。重启 dsh web，让两边版本对上。'],
                    ['ACTION_FAILED', '操作被拒绝或执行失败。后面跟的是服务端原话，通常已经写了原因。'],
                    ['PANEL_RENDER', '面板自己显示出错（插件本身没坏）。点「重试」；反复出现就带上控制台日志。'],
                    ['VAULT_IO', '引用库读写失败。多为文件权限、磁盘满，或 vault.json 被手工改坏。'],
                    ['CLIPBOARD', '复制到剪贴板被浏览器拒绝。手动选中复制即可。'],
                    ['AUTH_STATE', '授权状态没写进去。检查数据目录是否可写。'],
                    ['TMUX_FAILED / REFUSED', '宿主直接返回的码，原样保留不翻译：前者是 tmux 操作失败，后者是安全判定拒绝。'],
                  ]),
                  lcSection('lc-glossary', '13 · 术语对照：听到这些词不用慌', [
                    ['宿主', '就是 DSH 主程序本身。'],
                    ['会话 / shell', '一个一直开着的终端窗口。'],
                    ['tmux', '让终端在后台活着、关掉页面也能接回来的工具。'],
                    ['后台监督进程（supervisor）', '中间那层小程序，负责排队执行，也只有它写记录。'],
                    ['看门狗', '自动清理进程：DSH 死了它负责收尾。'],
                    ['落盘', '保存到硬盘上（重启还在）。'],
                    ['加密钥匙 / KEK', '用来加密和解密的那把“钥匙”。'],
                    ['记录链 / 哈希链', '一环扣一环的记录，改动任何一条都对不上。'],
                    ['数字签名', '给记录盖章；改一个字就验不过。'],
                    ['降级 / 熔断', '出问题时自动退到更简单的做法，而不是直接坏掉。'],
                    ['幂等', '同样的操作做两次，结果和做一次一样，不会坏事。'],
                  ]),
                ]),
              ])
            })()
          : infoTab === '事件记录'
          ? (() => {
              if (notices === null) return h('div', { key: 'n-load', className: 'dshsh-cmenu-sub' }, '读取中…')
              if (Array.isArray(notices) !== true) {
                return h('div', { key: 'n-err', className: 'dshsh-cmenu-sub' },
                  String(notices.error ?? '读取失败')
                  + ' —— 提示历史由 DSH 的 /notice 接口提供：插件刚更新过的话，重启 dsh 后这一页才可用')
              }
              if (notices.length === 0) {
                return h('div', { key: 'n-empty', className: 'dshsh-cmenu-sub' },
                  '还没有提示信息 —— 面板上每次操作反馈都会记在这里（含详细参数），便于复盘')
              }
              // —— 搜索 + 三筛（等级 / 会话 / 时间）——
              const q = noticeQuery.trim().toLowerCase()
              const ageMs = noticeAge === '10m' ? 600000 : noticeAge === '1h' ? 3600000
                : noticeAge === '24h' ? 86400000 : noticeAge === '7d' ? 604800000 : 0
              const nowTs = Date.now()
              const shellOptions = [...new Set(notices.map((n) => String(n.shell ?? '')).filter((s) => s !== ''))]
              const shown = notices.filter((n) => {
                if (noticeLevel !== '' && String(n.level ?? 'info') !== noticeLevel) return false
                if (noticeShell !== '' && String(n.shell ?? '') !== noticeShell) return false
                if (ageMs > 0 && nowTs - (Number(n.at) || 0) > ageMs) return false
                if (q !== '' && !(String(n.brief ?? '') + ' ' + String(n.detail ?? '')).toLowerCase().includes(q)) return false
                return true
              })
              // 用户要求：容器与横向分割比例都保持原样，只把**筛选与搜索对调** —— 筛选在左、搜索在右
              const bar = h('div', { key: 'n-bar', className: 'dshsh-cmenu-row', style: { gap: '6px', flexWrap: 'wrap', marginBottom: '6px' } }, [
                // 复用抽象出来的 UI.FMenu（多级菜单展示组件；状态在面板里，组件本身无 hook）。
                UI.FMenu({
                  key: 'fm',
                  open: noticeMenu !== '',
                  onToggle: () => { setNoticeMenu(noticeMenu === '' ? 'open' : ''); setNoticeMenuCat('') },
                  cat: noticeMenuCat,
                  onCat: setNoticeMenuCat,
                  items: [
                    { key: 'lv', label: '等级', value: noticeLevel, tip: '点击查看该筛选项的具体条件', onPick: setNoticeLevel, onClear: () => setNoticeLevel(''),
                      options: [{ v: '', l: '全部等级' }, { v: 'info', l: '提示' }, { v: 'warn', l: '警告' }, { v: 'error', l: '错误' }] },
                    { key: 'sh', label: '会话', value: noticeShell, tip: '按会话筛选（报错时会带上相关 shell 的 id）', onPick: setNoticeShell, onClear: () => setNoticeShell(''),
                      options: [{ v: '', l: '全部会话' }].concat(shellOptions.map((s2) => ({ v: s2, l: String(s2).replace(/^dsh-/, '') }))) },
                    { key: 'ag', label: '时间', value: noticeAge, tip: '按时间筛选', onPick: setNoticeAge, onClear: () => setNoticeAge(''),
                      options: NOTICE_AGES.map((o) => ({ v: o.v, l: o.l })) },
                  ],
                }),
                h('span', { key: 'cnt', className: 'dshsh-cmenu-sub', style: { alignSelf: 'center' } }, String(shown.length) + ' / ' + String(notices.length)),
                h('input', {
                  key: 'q', type: 'text', placeholder: '搜索简述 / 详细…', value: noticeQuery,
                  onChange: (e2) => setNoticeQuery(e2.target.value), style: { height: '24px', fontSize: '11px', flex: '1 1 160px' },
                }),
              ])
              if (shown.length === 0) {
                return h('div', { key: 'n-filtered' }, [bar,
                  h('div', { key: 'e', className: 'dshsh-cmenu-sub' }, '没有符合条件的提示信息（换个关键词或筛选条件）')])
              }
              return h('div', { key: 'n-wrap' }, [bar, h('div', { key: 'n-list', className: 'dshsh-notice-list' }, shown.slice().reverse().map((n, i) => h('div', {
                key: 'n-' + String(i),
                className: 'dshsh-notice-row lv-' + String(n.level ?? 'info'),
              }, [
                h('div', { key: 'hd', className: 'dshsh-notice-hd' }, [
                  h('span', { key: 'lv', className: 'dshsh-notice-lv' },
                    n.level === 'error' ? '错误' : (n.level === 'warn' ? '警告' : '提示')),
                  h('span', { key: 'b', className: 'dshsh-notice-b', title: String(n.brief ?? '') }, String(n.brief ?? '')),
                  String(n.shell ?? '') !== '' ? h('span', { key: 'sh', className: 'dshsh-notice-t', title: '相关会话' }, String(n.shell).replace(/^dsh-/, '')) : null,
                  h('span', { key: 't', className: 'dshsh-notice-t' },
                    new Date(Number(n.at) || 0).toTimeString().slice(0, 8)),
                ]),
                n.detail === undefined || String(n.detail) === ''
                  ? null
                  : h('div', { key: 'd', className: 'dshsh-notice-d', title: String(n.detail) }, String(n.detail)),
              ])))])
            })()
          : infoTab === '引用库事件'
          ? (() => {
              if (vaultHistory === null) return h('div', { key: 'vh-load', className: 'dshsh-cmenu-sub' }, '读取中…')
              if (Array.isArray(vaultHistory) !== true) {
                return h('div', { key: 'vh-err', className: 'dshsh-cmenu-sub' }, String(vaultHistory.error ?? '读取失败'))
              }
              if (vaultHistory.length === 0) {
                return h('div', { key: 'vh-empty', className: 'dshsh-cmenu-sub' },
                  '还没有键事件 —— 引用库里每次录入/删除/引用/有效期到都会记在这里（只显示键名与说明，值永不显示）')
              }
              const KIND_LABEL = { consume: '送出即焚', set: '录入/更新', rm: '删除（留烧伤）', expire: '有效期到',
                ref: '被引用', refused: '引用被拒', 'ref-error': '引用被拒', 'user-busy': '让位于人', released: '已交还拒写',
                unlock: '解锁组', lock: '锁定组', 'set-mode': '设置加密模式', move: '跨组迁移',
                'migrate-v1-to-v2': '迁移为引用组', 'spend-race': '并发消耗中止' }
              const SOURCE_LABEL = { panel: '面板', auto: '自动', tool: 'AI' }
              // 写入列表可用宽度（默认填充用；纯赋值，不触发渲染）
              LIST_AVAIL = rect !== null && rect !== undefined && Number.isFinite(rect.w) ? Math.max(360, rect.w - 34) : 900
              return UI.List({
                key: 'vaulthistory',
                filterMenu: true,
                placeholder: '搜索：键名 / 事件 / 详情',
                alwaysCount: true,
                widths: widthsOf('vaultevents'),
                onResize: onColResize('vaultevents'),
                filterValues: filtersOf('vaultevents'),
                onFilterChange: onColFilter('vaultevents'),
                rows: vaultHistory.map((ev, i) => ({
                  ...ev,
                  __key: String(ev.ts) + '-' + String(i),
                  __kind: KIND_LABEL[String(ev.kind)] ?? String(ev.kind ?? ''),
                  __shell: String(ev.shell ?? '') === '' ? '全局' : '@' + String(ev.shell).replace(/^dsh-/, ''),
                  __source: (SOURCE_LABEL[String(ev.source)] ?? String(ev.source ?? ''))
                    + (String(ev.actor ?? '') !== '' && ev.actor !== 'panel' && ev.actor !== 'sweeper' ? '(' + ev.actor + ')' : ''),
                })),
                query: vaultEventQuery,
                onQueryChange: (e) => setVaultEventQuery(e.target.value),
                sortKey: vaultEventSortKey,
                sortDir: vaultEventSortDir,
                onSort: (kk, dd) => { setVaultEventSortKey(kk); setVaultEventSortDir(dd) },
                emptyText: '没有匹配的键事件（换个关键词或筛选条件）',
                columns: [
                  { key: 'ts', label: '时间', width: '18%', sortable: true, title: '事件发生时间',
                    render: (v) => new Date(Number(v) || 0).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) },
                  { key: '__kind', label: '事件', width: '15%', sortable: true, filter: { auto: true, title: '按事件类型筛选' } },
                  { key: 'key', label: '键名', width: '16%', title: '只显示键名，值永不显示' },
                  { key: '__shell', label: '会话', width: '14%', filter: { auto: true, title: '按会话筛选' } },
                  { key: '__source', label: '来源', width: '13%', filter: { auto: true, title: '按来源筛选' } },
                  { key: 'detail', label: '详情', width: '24%', flex: true, title: '与事件相关的说明（不含任何值）' },
                ],
              })
            })()
          : infoTab === '日志审计'
            ? h(DeferredRegion, {
                key: 'logpage',
                regionKey: 'logpage',
                render: () => h('div', { key: 'logpage' }, [logTabBar, logScanBar, logContent]),
              })
            : infoTab === '安全'
          ? h('div', { key: 'warn', className: 'dshsh-info-alert' }, [
              h('span', { key: 'i' }, '⚠'),
              h('span', { key: 't' }, [
                h('b', { key: 'b' }, '没有官方审批：'),
                '模型的命令会直接执行，不会弹「允许 / 拒绝」。护栏只是启发式减速带，不是沙箱。',
              ]),
            ])
          : null,
        ...infoTabGroups.flatMap((section) => [

          h('div', { key: 'g-' + section.group, className: 'dshsh-info-group' }, [
            h('span', { key: 'n' }, section.group),
            h('c', { key: 'c' }, String(Array.isArray(section.tableRows) ? section.tableRows.length : section.rows.length)),
            Array.isArray(section.flow) ? h('span', { key: 'f', className: 'dshsh-flow' }, section.flow.map((step, si) => h('i', {
              key: si, className: 'dshsh-flowstep ' + step.state,
              title: step.label + '：' + (step.state === 'done' ? '已完成' : step.state === 'now' ? '进行中' : '未开始'),
            }, step.label + (step.state === 'done' ? ' ✓' : step.state === 'now' ? '…' : '')))) : null,
            section.dismissable === true ? h('button', {
              key: 'x', type: 'button', className: 'dshsh-gx', title: '收起这一段（本机记住；清浏览器站点数据可恢复）',
              onClick: (e) => { e.stopPropagation(); hideSection(section.group) },
            }, '× 收起') : null,
          ]),
                    // 用户要求：首帧耗时放在「当前会话」标题**下**，并复用现有行渲染（自带点击复制等行为）
          // 会话台账：以**表格**呈现（用户要求），支持多种筛选（创建者 / 锁定 / 前台状态）。
          section.group === '会话台账与策略' ? h('div', { key: 'ledger', className: 'dshsh-info-ledger', style: { overflow: 'visible' } }, [
            UI.List({
              key: 'ledger-list',
              tableId: 'info-ledger',
              columns: [
                { key: 'name', label: '名称', sortable: true, width: '26%',
                  get: (s) => (s !== null && s !== undefined && s.name === (meta !== null && meta !== undefined ? meta.name : '') ? '● ' : '')
                    + String((s || {}).name ?? '')
                    + (String((s || {}).lockKind ?? '') !== '' ? ' 🔒' : ''),
                  cellTitle: (s) => '名称：' + String((s || {}).name ?? '')
                    + (String((s || {}).lockKind ?? '') !== '' ? '\n锁定：' + String((s || {}).lockKind) + (String((s || {}).lockNote ?? '') !== '' ? '（' + String(s.lockNote) + '）' : '') : '')
                    + (s !== null && s !== undefined && s.name === (meta !== null && meta !== undefined ? meta.name : '') ? '\n（当前面板查看的 shell）' : '') },
                { key: 'owner', label: '创建者', sortable: true, width: '16%',
                  get: (s) => String((s || {}).ownerName ?? (s || {}).owner ?? (s || {}).actor ?? '未知'),
                  cellTitle: (s) => '创建者：' + String((s || {}).ownerName ?? (s || {}).owner ?? (s || {}).actor ?? '未知') + '（来源：' + String((s || {}).ownerSource ?? '未知') + '）' },
                { key: 'pid', label: 'PID', sortable: true, width: '8%',
                  get: (s) => Number.isFinite((s || {}).pid) ? String(s.pid) : '—',
                  cellTitle: () => 'tmux 窗格进程（DSH 上报的进程号）' },
                { key: 'createdAt', label: '创建', sortable: true, width: '11%',
                  get: (s) => timeMs((s || {}).createdAt) !== null
                    ? new Date(timeMs(s.createdAt)).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
                    : '无法检测',
                  cellTitle: (s) => timeMs((s || {}).createdAt) !== null ? '创建时间：' + new Date(timeMs(s.createdAt)).toLocaleString('zh-CN') : '宿主未上报 createdAt' },
                { key: 'size', label: '尺寸', sortable: false, width: '10%', get: (s) => Number.isFinite((s || {}).cols) && Number.isFinite((s || {}).rows) ? String(s.cols) + '×' + String(s.rows) : '-' },
                { key: 'foreground', label: '前台进程', sortable: false, width: '14%', get: (s) => String((s || {}).foreground ?? '（空闲）') },
                { key: 'cwd', label: '工作目录', sortable: false, width: '15%', get: (s) => prettyPath(String((s || {}).cwd ?? '-')), cellTitle: (s) => prettyPath(String((s || {}).cwd ?? '-')) },
              ],
              rows: sessions,
              filterMenu: true,
              filters: [
                { key: 'actor', label: '创建者', title: '按创建者筛选：只看某个人或某个对话建的 shell',
                  options: [...new Set((sessions || []).map((s) => String((s || {}).actor ?? '')).filter((x) => x !== ''))].map((x) => ({ value: x, label: x.slice(0, 12) })) },
                { key: 'lockKind', label: '锁定', title: '按锁定状态筛选',
                  options: [{ value: 'manual', label: '手动锁定' }, { value: 'auto', label: '自动锁定' }, { value: '__none', label: '未锁定' }] },
                { key: 'foreground', label: '前台', title: '按是否有前台进程筛选',
                  options: [...new Set((sessions || []).map((s) => String((s || {}).foreground ?? '')).filter((x) => x !== ''))].map((x) => ({ value: x, label: x })) },
              ],
              filterValues: filtersOf('info-ledger'),
              onFilterChange: onColFilter('info-ledger'),
              widths: widthsOf('info-ledger'),
              onResize: onColResize('info-ledger'),
              emptyText: '（无 shell）',
            }),
          ]) : null,
          section.group === '订阅列表' ? h('div', { key: 'subtable', className: 'dshsh-info-ledger', style: { overflow: 'visible' } }, [
            UI.List({
              key: 'info-subscriptions',
              tableId: 'info-subscriptions',
              columns: [
                { key: 'target', label: '订阅者 → shell', sortable: true, width: '30%',
                  get: (r) => String(r.who ?? '-') + ' → ' + String(r.shell ?? '-') + (r.alive === false ? ' ⚠' : ''),
                  cellTitle: (r) => '订阅者：' + String(r.who ?? '-') + '\nshell：' + String(r.shell ?? '-') + '\n存活：' + (r.alive === false ? '已不在' : '在') },
                { key: 'pending', label: '待读', sortable: true, width: '14%',
                  get: (r) => String(r.pending ?? 0) + ' 字符',
                  cellTitle: (r) => '待读：' + String(r.pending ?? 0) + ' 字符\n读取位置：' + String(r.cursor ?? 0) + '\n缓冲区丢弃：' + String(r.missed ?? 0) + ' 字符' },
                { key: 'count', label: '已投送', sortable: true, width: '16%',
                  get: (r) => String(r.count ?? 0) + ' 次',
                  cellTitle: (r) => '已投送（注入次数）：' + String(r.count ?? 0) + ' 次\n最近一次：' + String(r.last ?? '-') + '（' + String(r.lastChars ?? 0) + ' 字符）' },
                { key: 'last', label: '最近投送', sortable: true, width: '18%', get: (r) => String(r.last ?? '-') },
                { key: 'since', label: '订阅开始', sortable: true, width: '22%',
                  get: (r) => String(r.sinceShort ?? r.since ?? '-'),
                  cellTitle: (r) => '订阅开始：' + String(r.since ?? '-') },
              ],
              rows: Array.isArray(section.tableRows) ? section.tableRows : [],
              filterMenu: false,
              widths: widthsOf('info-subscriptions'),
              onResize: onColResize('info-subscriptions'),
              emptyText: '（当前没有订阅）',
            }),
          ]) : null,
          ...(section.group === '订阅列表'
            ? []
            : section.group === '当前会话'
            ? section.rows.concat([{
                k: '首帧耗时',
                v: screenFirstAt === null
                  ? '已等待 ' + ((Date.now() - screenSince) / 1000).toFixed(1) + 's…'
                  : ((screenFirstAt - screenSince) / 1000).toFixed(1) + 's',
                title: '从打开面板 / 切换会话开始，到画面第一次出来为止的耗时；点击可复制这个数字',
                tone: '',
              }])
            : section.rows).map((row) => h('div', {
            key: section.group + '-' + row.k,
            className: 'dshsh-kv',
            'data-copy': row.v === '-' || row.v === '' ? undefined : 'v',
            onClick: row.v === '-' || row.v === '' ? undefined : () => copyOne(row.v),
            title: row.title === undefined || row.title === '' ? '点击复制：' + row.v : row.title,
          }, [
            h('k', { key: 'k' }, row.k),
            h('v', { key: 'v', className: row.tone === undefined ? '' : row.tone }, [
              row.v,
              copiedValue === row.v ? h('i', { key: 'c' }, '已复制') : null,
            ]),
          ])),
        ]),
      ]) : null

      // ── 状态行（方案 B：永远一行）──────────────────────────────────────────
      //
      // 只放「一眼要看」的：状态点、名字、尺寸、前台、缓冲、已用字节、审批徽章，
      // 右侧是操作按钮。其余（接入/取景/cwd/版本/服务端/看门狗/键位表）全部进 ⓘ ——
      // 之前 13 项平级混装会折成 2–3 行，折行位置还随名字长度变化。
      // 忙闲判定复用 sessionBusy（与胶囊、选择器一致）
      const running = sessionBusy(meta, shellNameOf())
      const stats = h('div', { key: 'stats', 'data-dshsh-stats': true, style: S.stats }, [
        h('span', { key: 'dot', className: 'dshsh-dot', style: { background: dotColor(current) }, title: running ? '有进程在前台运行' : '停在提示符（空闲）' }),
        h('span', { key: 'n', style: { color: 'var(--dsw-alias-label-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
          currentName === '' ? '(无 shell)' : currentName),
        meta === null ? null : h('span', { key: 'sep1', style: S.sep }, '·'),
        meta === null ? null : h('span', { key: 's', style: S.num }, String(meta.cols) + '×' + String(meta.rows)),
        meta === null ? null : h('span', { key: 'sep2', style: S.sep }, '·'),
        meta === null ? null : h('span', { key: 'f', style: { whiteSpace: 'nowrap' } }, meta.foreground === '' ? '空闲' : meta.foreground),
        meta === null ? null : h('span', { key: 'sep3', style: S.sep }, '·'),
        meta === null ? null : h('span', { key: 'b', style: S.num, title: '滚动缓冲：已用 / 上限（行）' },
          String(meta.historySize) + '/' + String(meta.historyLimit)),
        meta === null ? null : h('span', { key: 'sep4', style: S.sep }, '·'),
        meta === null ? null : h('span', { key: 'by', style: S.num }, fmtBytes(meta.historyBytes)),
        server !== null && server.approval !== undefined
          ? h('span', {
            key: 'ap',
            className: 'dshsh-badge',
            style: { marginLeft: '2px' },
            title: '⚠ 本插件未接入官方审批：模型执行的命令不会弹出「允许 / 拒绝」询问。'
              + '审批缝：' + String(server.approval.seam)
              + '；部署默认策略：' + String(server.approval.deploymentPolicy)
              + '（DSH_PERMISSION_MODE=' + String(server.approval.permissionMode) + '，单会话可覆盖）。'
              + ' ' + String(server.approval.warning || ''),
          }, '无审批')
          : null,
        h('span', { key: 'sp', style: { flex: '1 1 auto' } }),
        // 复制屏幕：把当前屏（去颜色）整体复制走 —— 报错、日志片段想发给别人时的刚需
        h('button', {
          key: 'copy-screen',
          type: 'button',
          className: 'dshsh-stat-btn',
          onClick: async () => {
            try {
              await navigator.clipboard.writeText(String(screenPlain ?? ''))
              flashHint('已复制屏幕内容')
            } catch (error) {
              notifyOnce('copy-screen', 'warn', withCode('复制失败', UI_ERR.CLIPBOARD), '浏览器拒绝了剪贴板写入（' + String(error && error.message ? error.message : error) + '），请手动选中复制')
            }
          },
          title: '复制当前屏幕的全部文本（已去颜色）',
        }, '复制屏幕'),
        // 跟随状态：**跟随中也显示**（否则用户不知道是跟随还是停了）；暂停时变成"回到最新"
        pinned
          ? h('span', { key: 'follow', className: 'dshsh-follow', title: '正在跟随最新输出' }, '跟随中')
          : h('button', {
            key: 'latest',
            type: 'button',
            className: 'dshsh-stat-btn go',
            onClick: () => {
              setPinned(true)
              const el = screenRef.current
              if (el !== null) el.scrollTop = el.scrollHeight
            },
            title: '已暂停跟随（翻到历史里了）· 点这里回到最新',
          }, '已暂停 · 回到最新'),
        h('button', {
          key: 'more',
          type: 'button',
          className: 'dshsh-stat-btn',
          onClick: () => setHistoryWindow((prev) => Math.min(MAX_WINDOW, prev * 2)),
          disabled: historyWindow >= MAX_WINDOW,
          title: '向上多取一倍历史（当前 ' + String(historyWindow) + ' 行，上限 ' + String(MAX_WINDOW) + ' 行）',
        }, '更多历史'),
        // 0.3.4：只读回看 —— 冻结跟随、隐藏输入行，专用来回翻历史（与「回到最新」互斥）
        h('button', {
          key: 'ro',
          type: 'button',
          className: 'dshsh-stat-btn' + (readonly ? ' go' : ''),
          onClick: () => {
            if (readonly) { exitReadonly() } else { setReadonly(true); setPinned(false) }
          },
          title: readonly ? '退出只读回看，回到最新并恢复输入' : '只读回看：冻结跟随、隐藏输入，滚轮翻历史；再点一次退出',
        }, readonly ? '退出回看' : '回看'),
        h('button', {
          key: 'find',
          type: 'button',
          className: 'dshsh-stat-btn' + (searchOpen ? ' go' : ''),
          onClick: () => setSearchOpen((prev) => !prev),
          title: searchOpen ? '关闭搜索（Esc）' : '在屏幕历史里搜索（Ctrl+F）——点开关按钮或按 Ctrl+F 打开',
        }, searchOpen ? '✕ 关闭搜索' : '🔍 搜索'),
        hint === '' ? null : h('span', {
          key: 'hint',
          className: 'dshsh-stat-hint',
          role: 'status',
          title: hint,
        }, hint),
      ].filter(Boolean))

      const searchBar = !searchOpen ? null : h('div', { key: 'search', className: 'dshsh-searchbar' }, [
        h('span', { key: 'icon', className: 'dshsh-search-icon' }, '🔍'),
        h('input', {
          key: 'q',
          ref: searchRef,
          className: 'dshsh-search-in',
          value: searchQuery,
          placeholder: '在屏幕历史里查找（Enter 下一个 · Shift+Enter 上一个 · Esc 关闭）',
          autoFocus: true,
          onChange: (e) => { setSearchQuery(e.target.value); setSearchHit(0) },
          onKeyDown: (e) => {
            if (e.key === 'Enter') { e.preventDefault(); jumpToHit(searchHit + (e.shiftKey === true ? -1 : 1)) }
            else if (e.key === 'Escape') { e.preventDefault(); closeSearch() }
          },
        }),
        h('span', { key: 'cnt', className: 'dshsh-search-cnt', title: searchModel.count > MAX_RENDER_HITS ? '命中过多，已自动关闭高亮以保持流畅（跳转仍可用）' : '显示当前命中序号/命中行数' },
          searchQuery === '' ? '—' : (searchModel.count === 0 ? '无命中' : String(searchHit + 1) + '/' + String(searchModel.lineHits.length)
            + (searchModel.count > MAX_RENDER_HITS ? ' · ' + String(searchModel.count) + ' 处(高亮已关)' : ''))),
        h('button', {
          key: 'prev', type: 'button', className: 'dshsh-stat-btn',
          disabled: searchModel.lineHits.length === 0,
          onClick: () => jumpToHit(searchHit - 1), title: '上一个命中（Shift+Enter）',
        }, '↑'),
        h('button', {
          key: 'next', type: 'button', className: 'dshsh-stat-btn',
          disabled: searchModel.lineHits.length === 0,
          onClick: () => jumpToHit(searchHit + 1), title: '下一个命中（Enter）',
        }, '↓'),
        h('button', {
          key: 'x', type: 'button', className: 'dshsh-stat-btn',
          onClick: closeSearch, title: '关闭搜索（Esc）',
        }, '✕'),
      ])

      /** 软键盘发送一个键面。modToken 非空 = 修饰键（按模式：粘滞 / 或无事可做）。 */
      const softPress = (face, modToken) => {
        if (modToken !== '') {
          // 修饰键恒定**粘滞**：再点一个键就组成组合。
          // （"独立发送修饰键"经实测在 tty 里做不到 —— 裸修饰键没有字节，tmux 会把 Control_L
          //  这类键名当字面量打进终端 ⇒ 该选项已撤除，见 __softModAction。）
          setSoftMods((prev) => (prev.includes(modToken) ? prev.filter((x) => x !== modToken) : prev.concat([modToken])))
          return
        }
        const token = softKeyToken(softMods, face)
        const printable = String(face).length === 1
        if (token !== '') {
          send({ keys: [token] })
          setSoftLast(softKeyLabel(softMods, face) + ' → ' + token)
          setSoftMods([])
          return
        }
        if (printable === true) {
          // 单个可打印字符走**文本**通道：字符原样进终端，不依赖键名表（`;` `!` 都安全）
          send({ text: String(face) })
          setSoftLast('文本输入 ' + String(face))
          return
        }
        // 组合里基键不合法（如 Ctrl+;）⇒ 不发，UI 已置灰
      }
      /** 输入行右侧的入口按钮（与「推送」并列，锁定时一起禁用）。 */
      const softKeyBtn = h('button', {
        key: 'softkb',
        type: 'button',
        className: 'dshsh-btn' + (softOpen ? ' on' : ''),
        disabled: locked || currentName === '',
        onClick: () => {
          const opening = softOpen !== true
          setSoftOpen(opening); setSoftMods([])
          // 打开即处于自适应状态（softRect=null），无需测量 —— 见 .dshsh-sk 的 CSS 规则
        },
        title: '软键盘：点击弹出全尺寸键盘，支持 Ctrl / Alt / Shift 组合键',
      }, '⌨')
      /**
       * 浮窗几何（2026-10 二次返工，用户实测"横纵自适应还没解决"）：
       *   · softRect === null ⇒ **交给 CSS 自适应**（宽度 min(920px,92vw)、高度随内容、最大 78vh）
       *     —— 不再依赖"渲染后测量"的时序（那种做法在 React 提交前拿到 null 就静默失效）；
       *   · softRect 非 null ⇒ 用户手动拖/缩过 ⇒ 用像素定位（内联 style 覆盖 CSS）；
       *   · 双击右下角 / 「复位」⇒ 清回 null = **回到最合适的自适应大小**。
       */
      /** 把"点上哪一格"变成宿主认识的鼠标事件（点击 = 按下 + 松开；滚轮 = 一次按下）。 */
      const sendMouseAt = (event, kind) => {
        if (mouseMode !== true || locked === true) return
        const el = screenRef.current
        if (el === null || typeof el.getBoundingClientRect !== 'function') return
        if (!(cellWidthRef.current > 0) || !(lineHeightRef.current > 0)) measureGrid()
        const textEl = typeof el.querySelector === 'function' ? el.querySelector('.dshsh-screen-text') : null
        const textRect = (textEl !== null && typeof textEl.getBoundingClientRect === 'function')
          ? textEl.getBoundingClientRect() : null
        const box = el.getBoundingClientRect()
        const paneHeight = meta !== null && Number.isFinite(meta.paneHeight) ? Number(meta.paneHeight) : undefined
        const plain = parseAnsi(String(screen ?? '')).text
        // 尾部空行不是“历史”：captureWithMeta(trim:false) 会带回结尾空行，
        // 若计入 textLines，会整体多减几行（用户实测点 30 行落到 28 行）。
        const textLines = plain.replace(/[ \t]+$/gm, '').replace(/\n+$/, '').split('\n').length
        const caretRow = textRowFromPoint(textEl, event.clientX, event.clientY)
        const caretAbs = caretRow
        const cell = mouseCellFromPanel(
          { x: event.clientX, y: event.clientY },
          {
            box: { top: textRect !== null ? Math.max(box.top, textRect.top) : box.top, clientHeight: el.clientHeight, scrollTop: el.scrollTop, scrollLeft: el.scrollLeft },
            textLeft: textRect !== null ? textRect.left : box.left,
            paneHeight,
            textLines,
            textRow: caretAbs === null ? undefined : caretAbs,
              historySize: meta !== null && Number.isFinite(meta.historySize) ? meta.historySize : undefined,
            cell: { w: cellWidthRef.current, h: lineHeightRef.current },
          })
        if (cell === null) {
          if (!(cellWidthRef.current > 0) || !(lineHeightRef.current > 0)) {
            notifyOnce('mouse-grid', 'warn', withCode('鼠标：量不到字符网格', UI_ERR.MOUSE), '字体度量未就绪，稍后重试（或先点一次「双击右下角对齐」）')
          } else {
            notifyOnce('mouse-outside', 'warn', '鼠标：点击落在面板可视区之外', '请点在屏幕文字区域内（滚到最新再点）')
          }
          return
        }
        const protocol = appMouse !== null && appMouse.known === true && appMouse.sgr !== true && appMouse.standard === true ? 'x10' : 'sgr'
        // 用真实按钮：左键 0 / 中键 1 / 右键 2（纯函数层本来就支持三种，之前面板只发左键）
        const btn = mouseButtonName(event.button)
        const drag = mouseDragRef.current
        if (kind === 'drag') {
          // 按住不放产生的移动：**合并式**发送 —— 只记住最新位置，按固定节拍冲刷一次。
          // 为什么不能"限速直发"：宿主每发一次字节就是一次真实 tmux 调用（实测 ~65ms），
          // 拖动时每 50ms 直发一次 = 20 次/秒 ≈ 每秒 1.3 秒的活 ⇒ 宿主被压满，
          // 表现就是"所有动画像慢动作"（用户实测）。合并后每秒最多 5 次，且只发最新位置。
          drag.pending = { x: cell.x, y: cell.y, protocol, button: btn }
          if (drag.flushTimer !== null) return
          drag.flushTimer = window.setTimeout(() => {
            drag.flushTimer = null
            const p = drag.pending
            drag.pending = null
            if (p === null || mouseDragRef.current.active !== true) return
            send({ mouse: { protocol: p.protocol, button: p.button, action: 'move', x: p.x, y: p.y } })
          }, 200)
          return
        }
        if (kind === 'wheel') {
          send({ mouse: { protocol, button: mouseWheelButton(event.deltaX, event.deltaY), action: 'press', x: cell.x, y: cell.y } })
          scheduleFastRefresh()
          return
        }
        if (kind === 'up') {
          // 松开前把还没冲刷的拖动位置丢掉（否则会"松手之后再动一下"）
          drag.pending = null
          if (drag.flushTimer !== null) { try { window.clearTimeout(drag.flushTimer) } catch { /* 忽略 */ } drag.flushTimer = null }
          send({ mouse: { protocol, button: btn, action: 'release', x: cell.x, y: cell.y } })
          scheduleFastRefresh()
          return
        }
        // kind === 'down'：**先移动再按下**（依赖悬停位置判定点中谁的 TUI 会慢一拍，实测 Textual）
        // 移动事件的 SGR 按钮码 = base 32 + 无按键(3) = 35。
        drag.lastCell = String(cell.x) + ',' + String(cell.y)
        drag.lastAt = Date.now()
        send({ mouse: { protocol, button: btn, action: 'move', x: cell.x, y: cell.y } })
        send({ mouse: { protocol, button: btn, action: 'press', x: cell.x, y: cell.y } })
      }
      /** 鼠标模式开关：开启后屏幕区的点击/滚轮发给终端，而不是选中文本。 */
      /** 同一 key 的提示在 60 秒内只提示一次（避免每点一次都刷）。 */
      const notifyOnce = (key, level, brief, detail) => {
        const now = Date.now()
        if (mouseNoticeRef.current.key === key && now - mouseNoticeRef.current.at < 60000) return
        mouseNoticeRef.current = { key, at: now }
        notify(level, brief, detail)
      }
      const mouseBtn = h('button', {
        key: 'mouse',
        type: 'button',
        className: 'dshsh-btn' + (mouseMode ? ' on' : ''),
        disabled: locked || currentName === '',
        onClick: () => setMouseMode((v) => v !== true),
        title: mouseMode
          ? ('鼠标模式已开：点击/滚轮发给终端（点击不再选中文本）'
            + (appMouse !== null && appMouse.known === true
              ? (appMouse.any === true ? '；当前程序已启用鼠标 ✓' : '；当前程序未启用鼠标，点击可能无反应')
              : ''))
          : '鼠标模式：把屏幕区的点击/滚轮作为鼠标事件发给终端（供 htop / vim / lazygit 等 TUI 使用）',
      }, mouseMode ? '🖱✓' : '🖱')
      /** 最小尺寸：键面一行 14 个键 × 36px 起 ⇒ 再小就会被压扁（用户实测反馈）。 */
      const softMinW = () => 720
      const softMinH = () => 280
      const softAuto = softRect === null
      const softBoxPx = () => {
        const el = softRef.current
        if (el !== null && typeof el.getBoundingClientRect === 'function') {
          const r = el.getBoundingClientRect()
          return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
        }
        const vw = typeof window !== 'undefined' ? window.innerWidth : 1280
        const vh = typeof window !== 'undefined' ? window.innerHeight : 800
        const w = Math.max(softMinW(), Math.min(920, Math.round(vw * 0.62)))
        const h = Math.max(softMinH(), 300)
        return { x: Math.round((vw - w) / 2), y: Math.max(8, vh - h - 140), w, h }
      }
      const softApply = (next) => {
        const vw = typeof window !== 'undefined' ? window.innerWidth : 1280
        const vh = typeof window !== 'undefined' ? window.innerHeight : 800
        setSoftRect({
          x: Math.max(0, Math.min(Math.round(next.x), Math.max(0, vw - 80))),
          y: Math.max(0, Math.min(Math.round(next.y), Math.max(0, vh - 48))),
          w: Math.max(softMinW(), Math.round(next.w)),
          h: Math.max(softMinH(), Math.round(next.h)),
        })
      }
      /** 回到"最合适大小"：清掉像素定位 ⇒ CSS 自适应接管（宽度跟视口、高度跟内容）。 */
      const softFit = () => setSoftRect(null)
      /** 拖动：按住浮窗标题栏。用 window 上的 pointermove，指针移出浮窗也不断。 */
      const softDragStart = (e) => {
        e.preventDefault()
        const sx = e.clientX; const sy = e.clientY
        const b0 = softBoxPx()
        const x0 = b0.x; const y0 = b0.y; const w0 = b0.w; const h0 = b0.h
        const move = (ev) => softApply({ x: x0 + (ev.clientX - sx), y: y0 + (ev.clientY - sy), w: w0, h: h0 })
        const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
        window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
      }
      /** 缩放：8 个方向（复用面板那套 .dshsh-rs 把手样式）。 */
      const softResizeStart = (dir) => (e) => {
        // 右下角双击 ⇒ 自动贴合到最合适大小。用 pointerdown 自判双击：pointerdown 被
        // preventDefault 后浏览器不再派发合成 dblclick（面板右下角那次实测就是这么失效的）。
        if (dir === 'se') {
          const now = Date.now()
          if (now - softSeRef.current < 320) {
            softSeRef.current = 0
            e.preventDefault(); e.stopPropagation(); softFit()
            return
          }
          softSeRef.current = now
        }
        e.preventDefault(); e.stopPropagation()
        const sx = e.clientX; const sy = e.clientY
        const b0 = softBoxPx()
        const x0 = b0.x; const y0 = b0.y; const w0 = b0.w; const h0 = b0.h
        const move = (ev) => {
          const dx = ev.clientX - sx; const dy = ev.clientY - sy
          let x = x0; let y = y0; let w = w0; let h = h0
          if (dir.includes('e')) w = w0 + dx
          if (dir.includes('s')) h = h0 + dy
          if (dir.includes('w')) { w = w0 - dx; x = x0 + dx }
          if (dir.includes('n')) { h = h0 - dy; y = y0 + dy }
          if (w < 320) { if (dir.includes('w')) x = x0 + (w0 - 320); w = 320 }
          if (h < 168) { if (dir.includes('n')) y = y0 + (h0 - 168); h = 168 }
          softApply({ x, y, w, h })
        }
        const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
        window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
      }
      /** 独立浮动窗（用户要求）：可任意拖动、任意改大小；不再受面板布局约束。 */
      /**
       * 108 键键面：四个区块并排，每块一个 CSS Grid；键用 span 表达单位宽/高
       * ⇒ **长宽都随浮窗自适应**（用户要求），放大时行高列宽一起长。
       */
      /**
       * 108 键键面：四个区块并排，每块一个 CSS Grid。
       *
       * ⚠ 关键（2026-10 用户实测"1 跑到上一行末尾"）：**每个键必须显式定位** ——
       * 只给 `grid-column: span N` 的话，网格会**自动流式摆放**：一行凑不满单位宽时，
       * 下一个键就被挤到别处（Esc+F1..F12 只占 13.5 单位，剩 1.5 ⇒ `1` 就被推到上一行末尾）。
       * 现在按行累加列号，写死 `grid-column: 起点 / span 宽` 与 `grid-row: 行号`。
       * 又因为**网格线只能是整数**，而键宽有 1.25/1.5/6.25 这类小数 ⇒ 统一放大 4 倍
       * （1 单位 = 4 格，列数同步 ×4）⇒ 既保住比例，又能用整数定位。
       */
      const SOFT_UNIT = 4
      const softBlocks = () => h('div', { key: 'blocks', className: 'dshsh-sk-blocks' },
        SOFT_BLOCKS.map((blk) => {
          const cells = []
          const rows = Array.isArray(blk.rows) ? blk.rows : []
          for (let ri = 0; ri < rows.length; ri += 1) {
            const row = rows[ri]
            let col = 1
            for (let ci = 0; ci < row.length; ci += 1) {
              const cell = row[ci]
              const units = cell === null ? 1 : (cell.w === undefined ? 1 : cell.w)
              const w = Math.max(1, Math.round(units * SOFT_UNIT))
              if (cell === null) { col += w; continue }
              // ⚠ 变量名不能叫 h：它是 createElement 的别名（外层作用域）—— 这里一旦遮蔽，
              //   下面的 h('button', …) 就会抛 "h is not a function"，而浮层护栏会把它吞掉，
              //   表现为"点 ⌨ 不弹出、面板也不报错"（2026-10 用户实测，夹具覆盖渲染路径后抓到）。
              const rowSpan = cell.h === undefined ? 1 : cell.h
              const kk = blk.id + '-' + String(ri) + '-' + String(ci)
              const face = String(cell.t)
              const isMod = typeof cell.mod === 'string'
              const modToken = isMod ? cell.mod : ''
              const active = isMod === true && softMods.includes(modToken)
              const token = isMod === true ? '' : softKeyToken(softMods, face)
              const printable = isMod !== true && face.length === 1
              const disabled = cell.no === true || (isMod !== true && token === '' && printable !== true)
              cells.push(h('button', {
                key: kk,
                type: 'button',
                disabled,
                className: 'dshsh-sk-key' + (isMod === true ? ' mod' : '') + (active === true ? ' on' : ''),
                style: {
                  gridColumn: String(col) + ' / span ' + String(w),
                  gridRow: String(ri + 1) + ' / span ' + String(rowSpan),
                },
                title: cell.no === true
                  ? (face + '：终端里没有对应可发送的键名（tmux 会把不认识的键名当字面量打进终端），故置灰')
                  : (isMod === true
                    ? ('粘滞修饰键：再点一个键组成组合（' + face + '）')
                    : (token !== '' ? ('发送 ' + token) : (printable === true ? ('文本输入 ' + face) : '该键无法作为按键发送'))),
                onClick: () => softPress(face, modToken),
              }, face))
              col += w
            }
          }
          return h('div', {
            key: blk.id,
            className: 'dshsh-sk-block ' + blk.id,
            // 列数同步放大 4 倍；列宽仍是 fr 等分 ⇒ 键宽随浮窗变化
            style: { '--sk-cols': String(Math.round(Number(blk.cols) * SOFT_UNIT)) },
          }, cells)
        }))

      // ⚠ 护栏：浮层构建里任何异常都**只丢键盘**，绝不让整棵面板崩掉
      //（2026-10 事故：softWin 未定义 ⇒ ReferenceError ⇒ 面板消失，用户只能刷新页面）。
      const softBuild = (fn) => {
        try { return fn() } catch (error) {
          try {
    console.error('[terminalkeeper] 软键盘显示出错（已忽略，面板不受影响）：', error)
    postNotice('warn', '软键盘显示出错（面板不受影响）· 错误码 ' + UI_ERR.SOFT_KEYBOARD, String(error && error.message ? error.message : error))
  } catch { /* 忽略 */ }
          return null
        }
      }
      const softOverlay = softOpen !== true ? null : (softBuild(() => h('div', {
        key: 'softkb',
        ref: softRef,
        className: 'dshsh-sk',
        style: softAuto
          ? undefined                                  // 自适应：完全交给 CSS（宽度/高度/位置都由样式表决定）
          : { left: softRect.x + 'px', top: softRect.y + 'px', width: softRect.w + 'px', height: softRect.h + 'px', maxHeight: 'none', transform: 'none', bottom: 'auto' },
        onKeyDown: (e) => { if (e.key === 'Escape') { setSoftOpen(false); setSoftMods([]) } },
      }, [
        h('div', {
          key: 'head',
          className: 'dshsh-sk-head dshsh-sk-grip',
          onPointerDown: softDragStart,
          title: '按住这里拖动浮窗；右下角/四边可改大小',
        }, [
          h('span', { key: 't', className: 'dshsh-sk-title' }, '⌨ 软键盘'),
          h('span', { key: 'p', className: 'dshsh-sk-preview', title: softLast },
            softMods.length > 0 ? ('待组合：' + softKeyLabel(softMods, '…')) : (softLast !== '' ? softLast : '点键即发送')),
          h('button', {
            key: 'c', type: 'button', className: 'dshsh-sk-key mod',
            disabled: softMods.length === 0,
            onClick: () => setSoftMods([]),
          }, '清空修饰'),
          h('button', {
            key: 'r', type: 'button', className: 'dshsh-sk-key mod',
            title: '回到自适应大小与默认位置（等同于双击右下角）', onClick: () => softFit(),
          }, '复位'),
          h('button', { key: 'x', type: 'button', className: 'dshsh-sk-key mod', onClick: () => { setSoftOpen(false); setSoftMods([]) } }, '关闭'),
        ]),
        h('div', { key: 'body', className: 'dshsh-sk-body' }, softBlocks()),
        // 8 个缩放把手（复用面板的 .dshsh-rs 样式；浮窗自身是定位祖先）
        ['n','s','e','w','nw','ne','sw','se'].map((dir) => h('div', {
          key: 'rs-' + dir,
          className: 'dshsh-rs dshsh-rs-' + dir,
          onPointerDown: softResizeStart(dir),
        })),
      ])) ?? h('div', {
        // 兜底可见提示：构建失败不再"静默不弹"（用户至少能看到原因，不用开 DevTools）
        key: 'softkb-fail',
        className: 'dshsh-sk dshsh-sk-fail',
        style: { left: '50%', bottom: '132px', transform: 'translateX(-50%)', width: '420px', height: 'auto' },
      }, '⌨ 软键盘显示出错（面板不受影响）—— 详情见控制台 [terminalkeeper] 日志'))
      /** 首次使用提示条：一行把"能干什么"说清，看完可永久关闭。 */
      const hintBar = hintsSeen === true ? null : h('div', { key: 'hintbar', className: 'dshsh-hintbar' }, [
        h('span', { key: 't' }, '⌨ 软键盘 · 🖱 鼠标模式（可点击/拖动/滚轮）· 右键粘贴 · 双击右下角对齐到 shell 尺寸'),
        h('button', {
          key: 'x', type: 'button', className: 'dshsh-hintbar-x',
          onClick: () => {
            setHintsSeen(true)
            try { window.localStorage.setItem('terminalkeeper:hints-seen', '1') } catch { /* 忽略 */ }
          },
        }, '知道了'),
      ])
      const inputRow = readonly
        ? h('div', { key: 'input', 'data-dshsh-input': true, className: 'dshsh-robar' }, '🔒 只读回看中 · Esc 退出 · 滚轮翻阅历史 · 点上方「退出回看」回到最新并恢复输入')
        : h('div', { key: 'input', 'data-dshsh-input': true, style: S.inputRow }, [
        h('input', {
          key: 'field',
          ref: inputRef,
          type: 'text',
          // 非受控：这里只是**按键捕获面**，不持有任何文本（真·终端模型）。
          // 你打的字直接进 shell，显示在上方屏幕里。
          defaultValue: '',
          autoComplete: 'off',
          autoCorrect: 'off',
          autoCapitalize: 'off',
          spellCheck: false,
          style: { ...S.input, ...(locked ? S.inputLocked : {}) },
          disabled: locked || currentName === '',
          placeholder: locked
            ? '🔒 已锁定 —— 点左上角锁图标解锁'
            : '输入即进终端 · Tab 补全 · ↑↓ 历史 · Ctrl-R 搜索（完整键位见 ⓘ）',
          onKeyDown: onInputKeyDown,
          onInput: onInputChanged,
          onCompositionStart: onCompositionStart,
          onCompositionEnd: onCompositionEnd,
          onPaste: onInputPaste,
        }),
        h('button', {
          key: 'push',
          type: 'button',
          className: 'dshsh-btn ' + (residual ? 'hot' : 'accent'),
          // 锁定时不放行：这个按钮的作用正是「往终端里送东西」，与锁的语义冲突
          disabled: locked || currentName === '',
          onClick: () => { commitPending(); scheduleFastRefresh() },
          title: residual
            ? '输入框里有残留文本 —— 点击主动推送到终端（正常情况下它应始终为空）'
            : '主动推送输入框里的内容到终端（当前为空，点了也没事）',
        }, h(Icon, { name: 'push', size: 14 })),
        softKeyBtn,
        mouseBtn,
      ])

      // ── 授权浮层：档位 × 时间 + 按对话授权 + 已授权会话列表 ────────────────
      // 数据来自 /list 的 server.consent（面板本来就在轮询，不必再开轮询）。
      const consentInfo = server === null ? null : server.consent
      const consentCatalog = consentInfo?.catalogs ?? null
      const consentRows = consentEntryRows(consentInfo?.entries, Date.now())
      const scopeKeys = Array.isArray(consentCatalog?.scopes) && consentCatalog.scopes.length > 0
        ? consentCatalog.scopes : ['full', 'read', 'deny']
      const ttlLevels = Array.isArray(consentCatalog?.timeLevels) && consentCatalog.timeLevels.length > 0
        ? consentCatalog.timeLevels : CONSENT_TTL_FALLBACK
      const seg = (key, label, active, onClick) => h('button', {
        key,
        type: 'button',
        className: 'dshsh-cmenu-seg-btn' + (active ? ' on' : ''),
        onClick,
        disabled: consentBusy,
      }, label)
      const chip = consentStatusChip(consentInfo === null || consentInfo === undefined ? null : (consentInfo.defaultRule ?? null))
      const customMinutesRow = (value, setValue) => h('div', { key: 'custom', className: 'dshsh-cmenu-row' }, [
        h('span', { key: 'l' }, '分钟数'),
        h('input', {
          key: 'in', type: 'number', min: 1, max: 43200, className: 'dshsh-cmenu-in',
          value, onChange: (event) => setValue(event.target.value),
        }),
        h('span', { key: 'hint', className: 'dshsh-cmenu-sub' }, '1 分钟 – 30 天'),
      ])
      // 档位卡片（每个都要讲清后果，不是只给个名字 —— 成熟授权界面的共同点）
      // 档位选择行 —— 官方设置页的字段列表语言：整行「名称 + 后果」两行结构，右侧单选圆点，行间细线
      const scopeCards = (prefix, value, setValue) => scopeKeys.map((key) => h('button', {
        key: prefix + key,
        type: 'button',
        className: 'dshsh-opt' + (value === key ? ' on' : ''),
        onClick: () => setValue(key),
        disabled: consentBusy,
        title: CONSENT_SCOPE_HINTS[key] ?? '',
      }, [
        h('span', { key: 'm', className: 'dshsh-opt-main' }, [
          h('span', { key: 't', className: 'dshsh-opt-label' }, CONSENT_SCOPE_LABELS[key] ?? key),
          h('span', { key: 'h', className: 'dshsh-opt-hint' }, CONSENT_SCOPE_HINTS[key] ?? ''),
        ]),
        h('span', { key: 'r', className: 'dshsh-opt-radio' }),
      ]))
      /** 表单字段：标签在上、控件在下（与列表的键值行观感一致）；hint 进 title。 */
      /** epoch ms → `<input type="datetime-local" step="1">` 的值（本地时区，秒级）。 */
      const toLocalInput = (ms) => {
        const nn = Number(ms)
        if (!Number.isFinite(nn) || nn <= 0) return ''
        const d = new Date(nn)
        const p = (x) => String(x).padStart(2, '0')
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
      }
      // 0.4.1 筛选档位：剩余次数 / 剩余时间（用户指定）；组显示名统一走 groupLabelOf
      const REMAINING_BUCKETS = ['<5', '<10', '<50', '<100', '≥100', '无限']
      const TIME_BUCKETS = ['<30分钟', '<4小时', '<24小时', '<48小时', '≥48小时', '永不过期']
      const groupLabelOf = (g) => {
        const hit = (Array.isArray(secretsData?.groups) ? secretsData.groups : []).find((x) => x.group === (g ?? 'default'))
        return hit !== undefined ? (hit.label ?? hit.group) : (g ?? '默认引用组')
      }
      const groupFilterOptions = (groups) => (Array.isArray(groups) ? groups : [])
        .map((g) => ({ value: (g.label ?? g.group), label: (g.label ?? g.group) + (g.locked === true ? '（锁定）' : '') }))
      const remainingBucketOf = (row) => {
        const r = Number(row?.remaining)
        if (!Number.isFinite(r) || r < 0) return '无限'
        if (r < 5) return '<5'
        if (r < 10) return '<10'
        if (r < 50) return '<50'
        if (r < 100) return '<100'
        return '≥100'
      }
      const remainingTimeBucketOf = (row) => {
        const at = Number(row?.expiresAt)
        if (!Number.isFinite(at) || at <= 0) return '永不过期'
        const left = at - Date.now()
        if (left < 30 * 60 * 1000) return '<30分钟'
        if (left < 4 * 3600 * 1000) return '<4小时'
        if (left < 24 * 3600 * 1000) return '<24小时'
        if (left < 48 * 3600 * 1000) return '<48小时'
        return '≥48小时'
      }
      // hintsOn 关闭：不设 title 说明，并把字段名里的「（可选）」这类括注去掉 ⇒ 只留输入框名称
      const formField = (label, control, hint) => h('label', {
        key: 'f-' + label, className: 'dshsh-form-field',
        title: hintsOn === true ? hint : undefined,
      }, [h('span', { key: 'l', className: 'dshsh-form-label' }, label), control])
      // ── 0.3.0「引用库」本体：vault（人写，AI 只引用键名）/ macros（人+AI，写入全入封链）──
      const secretsBody = h('div', { key: 'secrets', className: 'dshsh-cmenu-body' }, [
        secretsData === null
          ? h('div', { key: 'ld', className: 'dshsh-cmenu-sub' }, '正在读取…')
          : secretsTab === 'vault' ? [
              hintsOn === true ? h('div', { key: 'vn', className: 'dshsh-cmenu-sub' },
                '引用库按「组」组织，每组独立加密：不加密（明文存在硬盘上，默认引用组即是）/ '
                + '简单混淆（用设备固定密钥加密后存在硬盘上 —— 只防明文被全盘搜索命中，不等于保密：能读到本机文件的人都能解密）/ '
                + '口令加密（加密后的密文（AES-256-GCM），口令只在内存、绝不写进文件，重启后需重新解锁）。组有加密态/解密态两种状态。 '
                + '值只存在 DSH 的数据目录里（文件权限 0600：vault.json / vault.head.json / vault.uses.json）；AI 只能引用 {{v:键名}}，'
                + '且只许整条裸引用喂密码提示（echo/管道形态被拒，防转换外泄）。一次性 = 送出即焚（烧伤表只存不透明 id，不含明文键名）。 '
                + '边界：output/ 留痕是原始字节流（见 SECURITY）。') : null,
              // 0.4.1：一次性提示（迁移 / 回滚 / 锁定警告）—— 迁移只提示一次，回滚是 REFUSED
              (String(secretsData?.vaultNote ?? '') !== '') ? h('div', {
                key: 'vn0', className: 'dshsh-cmenu-sub',
                style: {
                  color: secretsData?.vaultRefused === true ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-warn-primary)',
                  background: 'var(--dsw-alias-button-ghost-active-fill)', borderRadius: '8px', padding: '6px 10px', lineHeight: '1.5',
                },
              }, (secretsData?.vaultRefused === true ? '⛔ ' : 'ℹ ') + String(secretsData?.vaultNote ?? '')) : null,
              (secretsData?.vaultCorrupt ?? '') !== '' ? h('div', {
                key: 'vc', className: 'dshsh-cmenu-sub',
                style: { color: 'var(--dsw-alias-state-warn-primary)', background: 'var(--dsw-alias-button-ghost-active-fill)', borderRadius: '8px', padding: '6px 10px', lineHeight: '1.5' },
              }, '⚠ ' + (secretsData?.vaultCorrupt ?? '')) : null,
              (Array.isArray(secretsWarn) ? secretsWarn : []).length > 0 ? h('div', {
                key: 'w', className: 'dshsh-cmenu-sub',
                style: { color: 'var(--dsw-alias-state-warn-primary)', background: 'var(--dsw-alias-button-ghost-active-fill)', borderRadius: '8px', padding: '6px 10px', lineHeight: '1.5' },
              }, '弱形状提醒（已保存，是否更换由你定）：' + (Array.isArray(secretsWarn) ? secretsWarn.join('；') : '')) : null,
// —— 秘密域子页标签：引用组（组级加密/建组/改名/删除） | 键值对（新增/更新 + 现有列表）——
// 与详情页第二行**同一套容器**（dshsh-u-tabs dshsh-u-tabs2）：左对齐、页签高度/间距/字号完全一致。
// 此前用的是 dshsh-cmenu-row（margin:0 6px + padding:7px 2px + 下边框）⇒ 左边缘与详情不齐（用户实报）。
h('div', { key: 'vsubtabs', className: 'dshsh-u-tabs dshsh-u-tabs2', style: { marginBottom: '6px' } }, [
  h('button', {
    key: 'st-k', type: 'button', className: 'dshsh-u-tab' + (vaultSub === 'keys' ? ' on' : ''),
    title: '处理键值对（新增 / 更新 / 删除 / 迁移）',
    onClick: () => setVaultSub('keys'),
  }, '键值对'),
  h('button', {
    key: 'st-g', type: 'button', className: 'dshsh-u-tab' + (vaultSub === 'groups' ? ' on' : ''),
    title: '处理引用组（新建 / 改名 / 删除 / 加密模式 / 解锁锁定）—— 加密是组级的',
    onClick: () => setVaultSub('groups'),
  }, '引用组（' + (Array.isArray(secretsData?.groups) ? secretsData.groups.length : 0) + '）'),
]),
// —— 引用组子页：建组 / 改名 / 删除 / 加密模式 / 解锁锁定 ——
vaultSub === 'groups' ? h('div', { key: 'grppage', className: 'dshsh-cmenu-sub' }, [
              // 优化（用户要求）：与键值对页面统一观感 —— 用表单卡片 + 分区标题包裹既有控件
              h('div', { key: 'grp-card', className: 'dshsh-form-card' }, [
                // 与键值对页**逐字同构**：head[标题 + 眼睛] → 说明 → form-grid[段容器 + 子网格(formField)] → 按钮独立行
                h('div', { key: 'gh', className: 'dshsh-form-head' }, [
                  h('span', { key: 't', className: 'dshsh-form-title' }, '新建引用组'),
              
                ]),
                h('span', { key: 'n', className: 'dshsh-form-note', style: { display: hintsOn === true ? undefined : 'none', whiteSpace: 'normal', overflow: 'visible', textOverflow: 'clip' } }, '引用组（引用库 › 秘密域 › 引用组；每个键值对只属于一个组，加密按组生效） · 组名 ≤32 字符（可用中文）；只有「口令加密」组需要填组口令'),
                h('div', { key: 'gg', className: 'dshsh-form-grid' }, [
                  h('div', { key: 'secbox-newg', style: { gridColumn: '1 / -1', minWidth: 0 } }, [
                    h('div', { key: 'sub-newg', className: 'dshsh-form-grid dshsh-form-grid-sec' }, [
                      formField('新组名', h('input', {
                        key: 'newg', type: 'text', placeholder: '新组名（≤32 字符，可用中文）', value: vNewGroup,
                        onChange: (e) => setVNewGroup(e.target.value),
                      }), '组名 ≤32 字符，可用中文；不选组时新键会进默认引用组'),
                      // 用户要求：加密方式（下拉）—— 选「口令加密」才启用下面的组口令输入框
                      formField('加密方式', h('select', {
                        key: 'newmode', value: vNewMode,
                        onChange: (e) => setVNewMode(e.target.value),
                        title: '不加密：明文存在硬盘上（默认引用组同款）；简单混淆：用设备固定密钥加密后存在硬盘上（只防明文被全盘搜索命中 —— 能读到本机文件的人都能解密，不等于保密）；口令加密：落盘为密文，需要口令解锁后才能读写',
                      }, [
                        h('option', { key: 'n1', value: 'none' }, '不加密'),
                        h('option', { key: 'n3', value: 'obfuscate' }, '简单混淆（仅防明文存在硬盘上，不保密）'),
                        h('option', { key: 'n2', value: 'passphrase' }, '口令加密'),
                      ]), '三种加密方式都在这里选（未来还会扩展）。选「口令加密」后组口令输入框才会启用；选「简单混淆」不需要口令',),
                      // 口令框的启用条件有两个：
                      //   ① 目标模式是「口令加密」（设置新口令）；
                      //   ② 原组就是口令加密、现在要改成别的模式 —— 必须先解锁才能读出旧密文里的条目，
                      //      否则服务端会把整组按新 KEK 重封成空（静默丢条目）。
                      formField('组口令', h('input', {
                        key: 'pass2', type: 'password',
                        disabled: vNewMode !== 'passphrase' && vEditMode0 !== 'passphrase',
                        autoComplete: 'off',
                        placeholder: vNewMode === 'passphrase' ? '组口令（仅加密组用；只在内存）' : '原组口令（改加密方式前用于解锁）',
                        value: vPass, onChange: (e) => setVPass(e.target.value),
                      }), vNewMode === 'passphrase'
                        ? '只有「口令加密」组需要；口令只在内存，绝不写进文件/入审计'
                        : '把口令加密改成别的模式时，这里填当前口令：服务端要先解开旧密文，才能把条目迁到新模式下'),
                    ]),
                  ]),
                ]),
                // 与「保存秘密」同款布局：.dshsh-form-actions > .dshsh-form-btns > 按钮
                // 落盘行：复用面板自绘的 .dshsh-cfg-check（appearance 自绘、与整体美术一致）
                h('div', { key: 'persist-row', className: 'dshsh-cmenu-row', style: { gap: '8px', alignItems: 'flex-start', marginTop: '8px' } }, [
                  h('input', {
                    key: 'p', id: 'vg-persist', type: 'checkbox', className: 'dshsh-cfg-check',
                    checked: vPersist === true,
                    disabled: secretsBusy || nameExists === true || vEditFrom !== '',
                    onChange: (e) => setVPersist(e.target.checked),
                  }),
                  h('label', { key: 'l', htmlFor: 'vg-persist', style: { display: 'flex', flexDirection: 'column', gap: '2px', cursor: 'pointer' } }, [
                    h('span', { key: 'a', className: 'dshsh-form-label' }, '保存到硬盘'),
      hintsOn === true ? h('span', { key: 'b', className: 'dshsh-form-note', style: { whiteSpace: 'normal', overflow: 'visible', textOverflow: 'clip' } },
                      '勾选（默认）：这个组和里面的键值会写进 DSH 的数据目录（文件权限 0600），重启 dsh 后还在 —— 默认引用组固定如此，不能改。'
                      + '取消勾选：只在本次运行的内存里，重启即消失（适合临时秘密）。'
                      + '要不要保存到硬盘和加密方式无关：三种方式都可以选保存或不保存。') : null,
                  ]),
                ]),
                h('div', { key: 'mk-actions', className: 'dshsh-form-actions' }, [
                  h('div', { key: 'mk-btns', className: 'dshsh-form-btns' }, [
            h('button', {
              key: 'mk', type: 'button', className: 'dshsh-cmenu-go', disabled: secretsBusy,
              title: nameExists === true
                ? '修改：用上面的加密方式覆盖已有组「' + nameTyped + '」（口令加密时填口令即同时解锁）'
                : (vEditFrom === '' ? '新建一个空引用组（按上面选择的加密方式）' : '保存（覆盖「' + vEditFrom + '」：改过名字或加密方式才会写回）'),
              onClick: () => void saveGroup(),
              }, nameExists === true ? '修改' : (vEditFrom === '' ? '新建组' : '保存（覆盖）')),

                  ]),
                ]),
              ]),
              // 引用组列表：**复用 UI.List**（与键值对列表同一组件）⇒ 自动获得搜索 / 排序 / 筛选
              h('div', { key: 'grp-sec', className: 'dshsh-form-note',
                style: { fontWeight: '600', margin: '10px 0 4px' } },
                hintsOn === true ? '现有引用组 —— 点击组名展开操作；默认引用组属性不可修改' : '现有引用组'),
              // 解密小菜单：复用面板已有的浮层类 .dshsh-fmenu-panel；position:fixed 不会被表格
              // 滚动容器（overflow:auto）裁掉 —— 这是筛选菜单被裁掉那次学到的
              // 用 <dialog> + showModal()：进入浏览器**顶级层（top layer）**⇒ 不受任何祖先的
              // transform / overflow / z-index 影响（此前 position:fixed 在这个宿主里不可靠）
              unlockMenu !== null ? h('dialog', {
                key: 'unlock-pop', ref: unlockRef, className: 'dshsh-unlock-pop',
                onCancel: (e2) => { e2.preventDefault(); setUnlockMenu(null) },
                // 关闭判定：仅当点击坐标落在小窗矩形之外才算点背景（此前 target===dialog 会把
                // dialog 自身的 padding/空白也算成点外面 ⇒ 点窗内也会误关）
                onClick: (e2) => {
                  const el = unlockRef.current
                  if (el !== null && el !== undefined && typeof el.getBoundingClientRect === 'function') {
                    const r = el.getBoundingClientRect()
                    const inside = e2.clientX >= r.left && e2.clientX <= r.right && e2.clientY >= r.top && e2.clientY <= r.bottom
                    if (inside !== true) setUnlockMenu(null)
                  }
                },
                // 关键属性**全部内联**：不再依赖样式表 —— 实测在旧样式表下 class 规则会整条不生效，
                // 元素退化成 static 块级（left 无效）就会以整行宽度盖住面板，这就是"覆盖整片 UI"的机制。
                style: {
                  // dialog 默认 margin:auto + inset:0 —— 必须清掉，left/top 才生效
                  margin: 0, inset: 'auto',
                  position: 'fixed', zIndex: 2147483000, pointerEvents: 'auto',
                  width: '208px', maxWidth: '208px', height: 'auto', maxHeight: '140px',
                  boxSizing: 'border-box', padding: '10px', borderRadius: '10px',
                  // 颜色/边框/阴影都带**回退值**：即使主题令牌取不到，也绝不透明
                  border: '0.5px solid var(--dsw-alias-border-l4))',
                  background: 'var(--dsw-alias-bg-layer-2)',
                  color: 'var(--dsw-alias-label-primary)',
                  boxShadow: 'var(--dsw-elevation-prominent))',
                  left: String(Math.max(8, Math.min(unlockMenu.x ?? 200, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 224))) + 'px',
                  top: String(Math.max(8, Math.min(unlockMenu.y ?? 120, (typeof window !== 'undefined' ? window.innerHeight : 800) - 156))) + 'px',
                },
              }, [
                h('div', { key: 't', className: 'dshsh-form-label', style: { marginBottom: '6px', display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, '输入组口令：' + unlockMenu.group),
                h('input', {
                  key: 'p', type: 'password', autoComplete: 'off', className: 'dshsh-row-pass', style: { width: '100%' },
                  placeholder: '组口令', value: unlockMenu.pass, autoFocus: true,
                  onChange: (e2) => setUnlockMenu((prev) => prev === null ? null : Object.assign({}, prev, { pass: e2.target.value })),
                  onKeyDown: (e2) => { if (e2.key === 'Enter') void doUnlock() },
                }),
                h('div', { key: 'b', className: 'dshsh-form-btns', style: { marginTop: '8px', justifyContent: 'flex-end' } }, [
                  h('button', {
                    key: 'c', type: 'button',
                    style: { height: '26px', padding: '0 14px', borderRadius: '8px', fontSize: '12px', boxSizing: 'border-box',
                      cursor: 'pointer', background: 'transparent',
                      color: 'var(--dsw-alias-label-secondary)',
                      border: '1px solid var(--dsw-alias-border-l2))' },
                    onClick: () => setUnlockMenu(null),
                  }, '取消'),
                  h('button', {
                    key: 'o', type: 'button', disabled: secretsBusy,
                    style: { height: '26px', padding: '0 14px', borderRadius: '8px', fontSize: '12px', boxSizing: 'border-box',
                      cursor: secretsBusy === true ? 'not-allowed' : 'pointer',
                      background: 'var(--dsw-alias-button-primary-fill)',
                      color: 'var(--dsw-alias-label-primary-inverted)',
                      border: '1px solid var(--dsw-alias-border-inverted))',
                      opacity: secretsBusy === true ? 0.6 : 1 },
                    onClick: () => void doUnlock(),
                  }, '确定'),
                ]),
              ]) : null,
              UI.List({
                key: 'grouplist',
                placeholder: '搜索：引用组名',
                alwaysCount: true,
                widths: widthsOf('vaultgroups'),
                onResize: onColResize('vaultgroups'),
                filterValues: filtersOf('vaultgroups'),
                onFilterChange: onColFilter('vaultgroups'),
                rows: (Array.isArray(secretsData?.groups) ? secretsData.groups : []).map((g) => ({
                  ...g,
                  __key: g.group,
                  __name: String(g.label ?? g.group),   // 用户要求：不再追加「（默认）」（太宽）
                  __mode: modeLabel(g.mode),   // 三种模式各自显示；未知模式原样回显（不再一律显示口令加密）
                  // 状态列（用户要求：不加密的组不显示加密相关信息）：
                  // · 默认组 ⇒ 属性不可修改；
                  // · 简单混淆 / 口令加密 ⇒ 已锁定 / 已解锁；
                  // · 不加密 ⇒ 不谈加密态，只留落盘信息。
                  // （原先这里写了两遍 __state，前一行被覆盖、且漏了落盘后缀。）
                  __state: (() => {
                    // 不加密组不显示加密态 ⇒ 前缀为空时不要再拼「 · 」，否则出现孤立的「· 落盘」（用户实报）。
                    const base = g.immutable === true ? '属性不可修改'
                      : (String(g.mode) === 'none' ? '' : (g.locked === true ? '已锁定' : '已解锁'))
                    const disk = g.persist === false ? '不保存' : '保存到硬盘'
                    return base === '' ? disk : base + ' · ' + disk
                  })(),
                  __count: (Array.isArray(secretsData?.vault) ? secretsData.vault : [])
                    .filter((it) => String(it.group ?? 'default') === g.group).length,
                })),
                query: groupQuery,
                onQueryChange: (e) => setGroupQuery(e.target.value),
                sortKey: groupSortKey,
                sortDir: groupSortDir,
                onSort: (kk, dd) => { setGroupSortKey(kk); setGroupSortDir(dd) },
                emptyText: groupQuery.trim() !== '' ? '没有匹配的引用组' : '（还没有引用组）',
                columns: [
                  { key: '__name', label: '引用组', width: '22%', sortable: true, title: '点击组名可看到它的默认归属；默认引用组属性不可修改' },
                  { key: '__mode', label: '加密模式', width: '12%', sortable: true, filter: { auto: true, title: '按加密模式筛选' } },
                  { key: '__state', label: '状态', width: '14%', filter: { auto: true, title: '按状态筛选' } },
                  { key: '__count', label: '键数', width: '6%', minContent: 28, flex: true, sortable: true, title: '组内键值对数量（一般只有一两位数；锁定组的键不可见，故可能不完整）' },
                  { key: '__act', label: '操作', width: '32%', minContent: 200,
                    render: (v, gr) => gr.immutable === true
                      ? h('span', { key: 'im', className: 'dshsh-cmenu-sub' }, '不加密后存在硬盘上 · 属性不可修改')
                      : h('span', { key: 'acts', style: { display: 'inline-flex', gap: '4px', flexWrap: 'nowrap', whiteSpace: 'nowrap' } }, [
                          // 用户要求：按加密类型给操作 —— 混淆组/口令组都给「解密 ⇄ 加密」切换；
                          // 口令组额外给一个小口令输入框（解密时用它解锁）。
                          (gr.mode === 'obfuscate' || gr.mode === 'passphrase') ? h('span', {
                            key: 'mt', style: { display: 'inline-flex', gap: '4px', alignItems: 'center' },
                          }, [
                            h('button', {
                              key: 'mtb', type: 'button', className: 'dshsh-mode-toggle', disabled: secretsBusy,
                              title: gr.locked === true
                                ? (gr.mode === 'obfuscate'
                                  ? '解密：用设备密钥在本会话里解开该组（简单混淆只防明文存在硬盘上，不是安全机制）'
                                  : '解密：用左侧口令解锁该组（口令只在内存）')
                                : '加密：清掉本会话的内存密钥 ⇒ 该组内容重新隐藏（磁盘上的密文/混淆态不变）',
                              onClick: (ev) => {
                                if (gr.locked === true) {
                                  if (gr.mode === 'passphrase') {
                                    // 用户要求：弹框正好出现在鼠标所在位置（记下点击坐标）
                                    setUnlockMenu({ group: gr.group, pass: '', x: ev.clientX, y: ev.clientY }); return
                                  }
                                  void secretsPost('/vault-unlock', { group: gr.group, passphrase: '' }).then((ok) => { if (ok === true) loadSecrets() })
                                } else {
                                  void secretsPost('/vault-lock', { group: gr.group }).then((ok) => { if (ok === true) loadSecrets() })
                                }
                              },
                            }, (gr.locked === true ? '🔓 ' : '🔒 ') + (gr.locked === true ? '解密' : '加密')),
                          ]) : null,
                          // 用户要求：操作栏只保留两个 —— 1 修改（把组名与加密方式填回上方表单，保存即覆盖）
                          //            2 删除。加密方式一律在**上方表单**里选（未来扩展也只动表单）。
                          h('button', {
                            key: 'r', type: 'button', className: 'dshsh-cmenu-clear', disabled: secretsBusy,
                            style: { height: '20px', padding: '0 6px', fontSize: '11px' },
                            title: '修改：把该组的名字与加密方式填到上方表单；再点「保存（覆盖）」即写回',
                            onClick: () => {
                              const m0 = gr.mode === 'obfuscate' ? 'obfuscate' : (gr.mode === 'passphrase' ? 'passphrase' : 'none')
                              setVNewGroup(gr.group); setVNewMode(m0); setVEditMode0(m0); setVEditFrom(gr.group); setVPass('')
                            },
                          }, '修改'),
                          h('button', {
                            key: 'd', type: 'button', className: 'dshsh-cmenu-clear', disabled: secretsBusy,
                            style: Object.assign({ height: '20px', padding: '0 6px', fontSize: '11px' },
                              groupDelConfirm === String(gr.group)
                                ? { borderColor: 'var(--dsw-alias-state-error-primary)', color: 'var(--dsw-alias-state-error-primary)', fontWeight: 600 }
                                : null),
                            title: groupDelConfirm === String(gr.group)
                              ? (groupDelForce === String(gr.group) ? '再点一次：连组内的键值对一起销毁（不可恢复，会留烧伤标记）' : '再点一次确认删除该组')
                              : '删除该组（第一次点击只是进入确认态；只允许删空组）',
                            onClick: () => {
                              // 两步确认（与键值对删除、日志页文件删除同一模式）。
                              // 原先用 window.confirm —— GUI 里该对话框不显示/被拦 ⇒ 点了没反应，
                              // 表现为"引用组删除功能异常、删不掉组"（用户实报）。
                              if (groupDelConfirm !== String(gr.group)) { setGroupDelConfirm(String(gr.group)); setGroupDelForce(''); return }
                              const gcCount = Number(gr.__count ?? 0)
                              if (gcCount > 0 && groupDelForce !== String(gr.group)) {
                                setGroupDelForce(String(gr.group))
                                notify('warn', '这个组里还有 ' + String(gcCount) + ' 个键值对',
                                  '再点一次「确认销毁组+键」将把它们一并删除（每个键都会留下烧伤标记，旧密文回滚也无法复活）。')
                                return
                              }
                              setGroupDelConfirm(''); setGroupDelForce('')
                              // 只发一次：之前同时发了「cascade」和「普通」两条，失败时会弹两组一样的提示，
                              // 成功时更是竞态（第二条可能把刚删完的组再删一次）。
                              void secretsPost('/vault-group-set', { action: 'delete', name: gr.group, cascade: gcCount > 0 })
                            },
                          }, groupDelForce === String(gr.group) ? '确认销毁组+键' : (groupDelConfirm === String(gr.group) ? '确认删除' : '删除')),
                        ]) },
                ],
              }),
]) : null,
h('div', { key: 'vsplit', className: 'dshsh-consent-split', style: vaultSub === 'groups' ? { display: 'none' } : undefined }, [
              // 默认：列表占满全部高度；点「＋ 新增」或还没有数据时，下方才弹出录入表单
              h('div', { key: 'vform', className: 'dshsh-consent-left', style: { flex: '0 0 auto' } }, [
                h('div', { key: 'vf', className: 'dshsh-form-card' }, [
                  h('div', { key: 'h', className: 'dshsh-form-head' }, [
                    h('span', { key: 't', className: 'dshsh-form-title' }, '新增 / 更新秘密'),
                  ]),
                    h('span', { key: 'n', className: 'dshsh-form-note', style: { display: hintsOn === true ? undefined : 'none' } }, '值只存在 DSH 的数据目录里（权限 0600）；AI 只能引用 {{v:键名}}，看不到具体值'),
                  h('div', { key: 'crumb', className: 'dshsh-form-note', style: { display: hintsOn === true ? undefined : 'none',  margin: '2px 0 7px' } },
                    '引用库 › 秘密域 › 引用组「' + (vGroup === '' ? '默认引用组' : vGroup) + '」› 键值对（本次要写入的一条）'),
                  h('div', { key: 'g', className: 'dshsh-form-grid' }, [
                    // 方案 A：每段一个整行容器（gridColumn 1/-1）+ 段内子网格 ⇒
                    // 关闭说明时仅收起标题行，段内字段的排布不随网格重排而改变
                    h('div', { key: 'secbox1', style: { gridColumn: '1 / -1', minWidth: 0 } }, [
                      h('div', { key: 'sec1', className: 'dshsh-form-note', style: { display: hintsOn === true ? undefined : 'none',  gridColumn: '1 / -1', fontWeight: '600', margin: '4px 0 0' } }, '① 归属 —— 这条键值对放进哪个引用组（一个键值对只属于一个组；加密按组生效）'),
                      h('div', { key: 'sub1', className: 'dshsh-form-grid dshsh-form-grid-sec' }, [
                    formField('引用组', h('select', {
        key: 'grp', value: vGroup, onChange: (e) => setVGroup(e.target.value),
        title: '这个键值对归属哪个引用组 —— 每个键值对只属于一个组；加密按组生效',
        style: { height: '26px' },
      }, [
        h('option', { key: 'dft2', value: '' }, '默认引用组'),
        ...(Array.isArray(secretsData?.groups) ? secretsData.groups.filter((g) => g.isDefault !== true).map((g) => h('option', { key: 'go-' + g.group, value: g.group }, (g.label ?? g.group) + (g.locked === true ? '（锁定）' : ''))) : []),
      ]), '不选则进「默认引用组」（新装插件即存在，保证功能直接可用）'),
                      ]),
                    ]),
                    // 方案 A：每段一个整行容器（gridColumn 1/-1）+ 段内子网格 ⇒
                    // 关闭说明时仅收起标题行，段内字段的排布不随网格重排而改变
                    h('div', { key: 'secbox2', style: { gridColumn: '1 / -1', minWidth: 0 } }, [
                      h('div', { key: 'sec2', className: 'dshsh-form-note', style: { display: hintsOn === true ? undefined : 'none',  gridColumn: '1 / -1', fontWeight: '600', margin: '4px 0 0' } }, '② 内容 —— 键名与值（键名 = AI 引用时用的名字；值只在宿主，AI 永不可见）'),
                      h('div', { key: 'sub2', className: 'dshsh-form-grid dshsh-form-grid-sec' }, [
                    formField('键名', h('input', {
                        key: 'k', type: 'text', placeholder: '字母数字 . _ -',
                        value: vKey, onChange: (e) => setVKey(e.target.value),
                      }), '键名 = AI 引用时用的名字（{{v:键名}}）'),
                      formField('值', h('input', {
                        key: 'v', type: 'password', placeholder: '留空 = 不改（编辑时只填要改的字段）',
                        value: vVal, onChange: (e) => setVVal(e.target.value),
                      }), '留空 = 不改这个键的值。值只存在 DSH 的 vault.json 里（权限 0600），永远不会出现在 AI 上下文或日志里'),
                      ]),
                    ]),
                    // 方案 A：每段一个整行容器（gridColumn 1/-1）+ 段内子网格 ⇒
                    // 关闭说明时仅收起标题行，段内字段的排布不随网格重排而改变
                    h('div', { key: 'secbox3', style: { gridColumn: '1 / -1', minWidth: 0 } }, [
                      h('div', { key: 'sec3', className: 'dshsh-form-note', style: { display: hintsOn === true ? undefined : 'none',  gridColumn: '1 / -1', fontWeight: '600', margin: '4px 0 0' } }, '③ 策略（可选）—— 备注 / 剩余次数 / 有效期至，留空即不限制'),
                      h('div', { key: 'sub3', className: 'dshsh-form-grid dshsh-form-grid-sec' }, [
                    formField('备注（可选）', h('input', {
                        key: 'n', type: 'text', placeholder: '给人看的说明',
                        value: vNote, onChange: (e) => setVNote(e.target.value),
                      }), '备注对 AI 侧列表可见'),
                      formField('剩余可用次数（可选）', h('input', {
                        key: 'm', type: 'number', min: '0', max: '9999', placeholder: '留空 = 无限次',
                        value: vMax, onChange: (e) => setVMax(e.target.value),
                      }), '填 N = 还能再用 N 次（1 = 一次性，用掉即焚）；留空 = 不限。已用次数不重置 —— 只能在这个基础上追加额度'),
                      formField('有效期至（可选）', h('input', {
                        key: 'e2', type: 'datetime-local', step: '1',
                        value: vExp, onChange: (e) => setVExp(e.target.value),
                      }), '有效期至：到这个时间点自动焚毁（浏览器原生选择器，精确到秒）；留空 = 永不过期'),
                      ]),
                    ]),
                  ]),
                  h('div', { key: 'a', className: 'dshsh-form-actions' }, [
                    h('div', { key: 'b', className: 'dshsh-form-btns' }, [
                      (Array.isArray(secretsWarn) ? secretsWarn : []).length > 0 ? h('button', {
                        key: 'dw', type: 'button', className: 'dshsh-cmenu-clear',
                        onClick: () => setSecretsWarn([]),
                      }, '知道了') : null,
                      h('button', {
                        key: 'go', type: 'button', className: 'dshsh-cmenu-go',
                        disabled: secretsBusy || vKey.trim() === '' || (vVal === '' && !(Array.isArray(secretsData?.vault) && secretsData.vault.some((i) => i.key === vKey.trim()))),
                        onClick: () => {
                          const maxN = Number(vMax)
                          const expMs = vExp === '' ? undefined : new Date(vExp).getTime()
                          const reuseHit = (Array.isArray(secretsData?.reuseCandidates) ? secretsData.reuseCandidates : []).includes(vKey.trim())
                          if (reuseHit && !vReuseOk) {
                                // 不再用 window.confirm（GUI 里对话框不显示/被拦 ⇒ 条件恒假 ⇒ 烧毁过的键无法重建）。
                                // 下方 setVReuseOk(true) + 「再点一次即写入」本身就是两步确认。
                            setVReuseOk(true)
                            setError('已确认「重建同名键」：再点一次「保存秘密」即写入（本条提示只针对这一次操作）')
                            return
                          }
                          // 面板填的是**剩余次数**：提交时换算成总次数（已用 + 剩余），服务端只认 maxUses
                          const existing = (Array.isArray(secretsData?.vault) ? secretsData.vault : []).find((i) => i.key === vKey.trim())
                          const usedBefore = Math.max(0, Number(existing?.uses ?? 0) || 0)
                          const totalMax = Number.isFinite(maxN) && maxN > 0 ? Math.floor(maxN) + usedBefore : undefined
                          void secretsPost('/vault-set', {
                            key: vKey.trim(), value: vVal, note: vNote.trim(), group: vGroup === '' ? undefined : vGroup,
                            maxUses: totalMax,
                            expiresAt: Number.isFinite(expMs) ? expMs : undefined,
                            reuseName: reuseHit === true && vReuseOk === true ? true : undefined,
                          }).then((ok) => {
                            if (ok) {
                              setVKey(''); setVVal(''); setVNote(''); setVExp('')
                              setVMax(''); setVReuseOk(false); setSecretsWarn([])
                            }
                          })

                        },
                      }, '保存秘密'),
                    ]),
                  ]),
                  (Array.isArray(secretsWarn) ? secretsWarn : []).length > 0 ? h('div', {
                    key: 'w', className: 'dshsh-cmenu-sub',
                  }, '弱形状提醒（已保存，是否更换由你定）：' + secretsWarn.join('；')) : null,
                ]),
              ]),
              h('div', { key: 'vlist', className: 'dshsh-consent-right' }, [
                h('div', { key: 'lh', className: 'dshsh-cmenu-h' }, '现有秘密（' + (Array.isArray(secretsData?.vault) ? secretsData.vault.length : 0) + '）'),
              // 0.3.4 三段式列表（规格）：筛选行（可筛选键 + 搜索）/ 表头（键名·类型·次·TTL·创建·备注·操作）/ 显示区
              UI.List({
                key: 'vault-list',
                placeholder: '搜索：键名 / 备注',
                alwaysCount: true,
                widths: widthsOf('vault'),
                filterMenu: true,
                onResize: onColResize('vault'),
                filterValues: filtersOf('vault'),
                onFilterChange: onColFilter('vault'),
                rows: (Array.isArray(secretsData?.vault) ? secretsData.vault : []).map((item) => ({ ...item, __key: item.key })),
                query: vaultQuery,
                onQueryChange: (e) => setVaultQuery(e.target.value),
                sortKey: secretsSortKey,
                sortDir: secretsSortDir,
                onSort: (key, dir) => { setSecretsSortKey(key); setSecretsSortDir(dir) },
                emptyText: vaultQuery.trim() !== '' ? '没有匹配的键' : '（还没有键）',
                columns: [
                  { key: 'key', label: '键名', sortable: true, width: '22%',
                    title: '点键名即复制引用形态 {{v:键名}}；值永远不可复制、不可见',
                    cellTitle: (row) => String(row.key),
render: (value, row) => h('span', { key: 'k', style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } }, [
                      h('span', { key: 'nm', style: { cursor: 'pointer' }, title: '点击复制键名本身（不含 {{v:}} 括号）',
                        onClick: () => copyRef(String(value)) },
                        value + '  ' + (copiedKey === '{{v:' + value + '}}' ? '✓ 已复制' : '⧉')),
                    ]),
                  },
                  // 0.4.1：显示所属组，并可**按组筛选**（加密按组生效；一个键值对只属于一个组）
                  { key: 'group', label: '所属组', width: '12%', sortable: true,
                    title: '这个键值对所属的引用组（一个键只属于一个组）',
                    get: (row) => groupLabelOf(row.group),
                    filter: { options: groupFilterOptions(secretsData?.groups), title: '按所属组筛选' },
                    // 说明按**该行的组模式**给：不加密的组只说所属组，完全不提加密/解锁
                    // （用户要求：不加密的键值对不该显示加密相关信息）。
                    cellTitle: (row) => {
                      const label = groupLabelOf(row.group)
                      const def = (Array.isArray(secretsData?.groups) ? secretsData.groups : []).filter((g) => String(g?.group) === String(row.group))[0]
                      if (def === undefined || String(def.mode) === 'none') return '所属组：' + label
                      return '所属组：' + label + '（' + modeLabel(def.mode) + '）· 取值与迁移需先解锁该组'
                    },
                    render: (v) => v },
                  // 剩余次数：-1 = 无限；筛选按档位
                  // 用量（用户要求：更通用的名字；显示「已用/可用」，悬停给完整说明）
                  { key: 'remainingBucket', label: '用量', width: '15%', sortable: true,
                    title: '用量：已用次数 / 可用总次数（∞ = 不限）。筛选档位：<5 / <10 / <50 / <100 / ≥100',
                    get: (row) => remainingBucketOf(row),
                    filter: { options: REMAINING_BUCKETS.map((b) => ({ value: b, label: b })), title: '按用量档位筛选' },
                    cellTitle: (row) => {
                      const used = Math.max(0, Number(row?.uses ?? 0) || 0)
                      const max = Number(row?.maxUses)
                      const rem = Number(row?.remaining)
                      const unlimited = (rem === -1 || row?.remaining === null || row?.remaining === undefined)
                      if (!Number.isFinite(max) || max < 0) return '已用 ' + used + ' 次；可用次数不限'
                      const left = unlimited ? (max - used) : Math.max(0, rem)
                      return '已用 ' + used + ' 次；可用总次数 ' + max + ' 次；剩余 ' + left + ' 次'
                        + (left <= 0 ? '（已用尽：引用处会报「次数已用完」）' : '')
                    },
                    render: (v, row) => {
                      const used = Math.max(0, Number(row?.uses ?? 0) || 0)
                      const max = Number(row?.maxUses)
                      return used + '/' + ((Number.isFinite(max) && max >= 0) ? String(max) : '∞')
                    },
                  },
                  // 剩余时间：按有效期至与当前时间的差分档
                  { key: 'timeBucket', label: '时间', width: '16%', sortable: true,
                    title: '距有效期至还剩多久。筛选档位：<30分钟 / <4小时 / <24小时 / <48小时 / ≥48小时',
                    get: (row) => remainingTimeBucketOf(row),
                    filter: { options: TIME_BUCKETS.map((b) => ({ value: b, label: b })), title: '按剩余时间筛选' },
render: (v, row) => (Number(row?.expiresAt) > 0
                      ? new Date(Number(row.expiresAt)).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
                      : '不过期'),
                  },
                  { key: 'note', label: '备注', width: '18%', flex: true,
                    title: '给人看的备注（AI 侧列表也可见）',
                    cellTitle: (row) => String(row.note ?? ''),
                    render: (v) => (v || '—') },
                  { key: '__act', label: '操作', width: '17%', minContent: 156, title: '修改 / 删除该键；迁移需源组与目标组同时解锁（不加密的组无需解锁）；删除会写烧伤标记',
                    render: (v, row) => h('span', { key: 'act', style: { display: 'inline-flex', gap: '4px', alignItems: 'center' } }, [
                      h('button', {
                        key: 'ed', type: 'button', className: 'dshsh-cmenu-clear', disabled: secretsBusy,
                        style: { height: '22px', padding: '0 8px', fontSize: '11px' },
                        title: '把这行的键名 / 归属组 / 备注 / 次数 / 有效期至填入表单（值留空 = 不改值）；把「引用组」改成别的组即迁移（目标组需已解锁）',
                        onClick: () => {
                          setVKey(String(row.key)); setVVal(''); setVNote(String(row.note ?? ''))
                          // 输入框语义是**剩余次数**：预填 maxUses - uses（-1/空 = 不限）
                          const totalMax = Number(row.maxUses)
                          const usedNow = Math.max(0, Number(row.uses ?? 0) || 0)
                          setVMax(Number.isFinite(totalMax) && totalMax > 0 ? String(Math.max(0, totalMax - usedNow)) : '')
                          setVExp(toLocalInput(row.expiresAt))
                          setVReuseOk(false)
                        },
                      }, '修改'),
                      h('button', {
                        key: 'a', type: 'button', className: 'dshsh-cmenu-clear', disabled: secretsBusy,
                        style: Object.assign({ height: '22px', padding: '0 8px', fontSize: '11px' },
                          secretsDelConfirm === String(row.key)
                            ? { borderColor: 'var(--dsw-alias-state-error-primary)', color: 'var(--dsw-alias-state-error-primary)', fontWeight: 600 }
                            : null),
                        onClick: () => {
                          // 两步确认（与日志页的文件删除同一模式）：删除会写**烧伤标记**，
                          // 旧密文回滚也无法复活 ⇒ 不能单击即删。
                          if (secretsDelConfirm !== String(row.key)) { setSecretsDelConfirm(String(row.key)); return }
                          setSecretsDelConfirm('')
                          void secretsPost('/vault-rm', { key: row.key })
                        },
                        title: secretsDelConfirm === String(row.key)
                          ? '再点一次确认删除（会留烧伤标记：旧密文回滚也复活不了）'
                          : '删除该键（第一次点击只是进入确认态；引用处会明确报「没有该键」）',
                      }, secretsDelConfirm === String(row.key) ? '确认删除' : '删除'),
                    ]) },
                ],
              }),
              secretsExtra !== null && secretsExtra.chain !== null ? h('div', { key: 'cc', className: 'dshsh-cmenu-row' }, [
                h('span', { key: 'l', className: 'dshsh-cmenu-sub' }, '审计链：' + (secretsExtra.chain.ok === true
                  ? '✓ ' + secretsExtra.chain.sealed + ' 条封链 · 留痕 ' + secretsExtra.chain.transcripts + ' 份'
                  : secretsExtra.chain.ok === false ? '⚠ 断链于第 ' + ((secretsExtra.chain.brokenAt?.index ?? 0) + 1) + ' 条' : '未启用')),
                h('button', {
                  key: 'r', type: 'button', className: 'dshsh-cmenu-clear', disabled: secretsBusy,
                  onClick: () => void loadSecrets(true),
                  title: '重新复验整条哈希链（新鲜计算）',
                }, '复验'),
              ]) : null,
              ]),
              ]),
            ] : [
              hintsOn === true ? h('div', { key: 'mn', className: 'dshsh-cmenu-sub' },
                '宏 = 可复用命令片段：人与 AI 都可写，而每一次写入（新增/更新/删除）都全量进审计封链（防偷渡）。'
                + '可嵌 {{v:键名}}，且只在发送那一刻展开 ⇒ 宏文本本身不含秘密；不可嵌宏（禁止宏套宏）。'
                + 'AI 使用时写 {{m:名字}}；点宏名即可复制该引用形态。宏名可用字母数字与 . _ - 。'
                + '注意：宏是文本不是秘密 —— 需要保密的内容请放进【秘密域】的键值对，再用 {{v:键名}} 在宏里引用。') : null,
              (secretsData?.macrosCorrupt ?? '') !== '' ? h('div', {
                key: 'mc', className: 'dshsh-cmenu-sub',
                style: { color: 'var(--dsw-alias-state-warn-primary)', background: 'var(--dsw-alias-button-ghost-active-fill)', borderRadius: '8px', padding: '6px 10px', lineHeight: '1.5' },
              }, '⚠ ' + (secretsData?.macrosCorrupt ?? '')) : null,
              h('div', { key: 'msplit', className: 'dshsh-consent-split' }, [
              // 默认：列表占满全部高度；点「＋ 新增」或还没有数据时，下方才弹出录入表单
              h('div', { key: 'mform', className: 'dshsh-consent-left', style: { flex: '0 0 auto' } }, [
                h('div', { key: 'mf', className: 'dshsh-form-card' }, [
                  h('div', { key: 'h', className: 'dshsh-form-head' }, [
                    h('span', { key: 't', className: 'dshsh-form-title' }, '新增 / 更新宏'),
                    h('span', { key: 'n', className: 'dshsh-form-note', style: { display: hintsOn === true ? undefined : 'none' } }, '可复用命令片段；人与 AI 都可写，写入全量进审计封链'),
                  ]),
                  h('div', { key: 'g', className: 'dshsh-form-grid' }, [
                    formField('宏名', h('input', {
                      key: 'n', type: 'text', placeholder: '字母数字 . _ -',
                      value: mName, onChange: (e) => setMName(e.target.value),
                    }), 'AI 引用时写 {{m:宏名}}'),
                    formField('作用域', h('select', {
                      key: 's', value: mScope, onChange: (e) => setMScope(e.target.value),
                    }, [
                      h('option', { key: 'g', value: 'global' }, 'global（所有对话可用）'),
                      h('option', { key: 'c', value: 'conversation' }, 'conversation（仅本对话）'),
                    ]), 'conversation 宏只在归属对话里能引用'),
                    formField('备注（可选）', h('input', {
                      key: 'nt', type: 'text', placeholder: '给人看的说明',
                      value: mNote, onChange: (e) => setMNote(e.target.value),
                    }), '备注进入宏列表与审计记录'),
                    h('label', { key: 'tex', className: 'dshsh-form-field dshsh-form-wide' }, [
                      h('span', { key: 'l', className: 'dshsh-form-label' }, '内容（发送时才展开；可含换行）'),
                      h('textarea', {
                        key: 't', rows: 3, placeholder: '例如：ls -la {{v:工作目录}}',
                        value: mText, onChange: (e) => setMText(e.target.value),
                      }),
                    ]),
                  ]),
                  h('div', { key: 'a', className: 'dshsh-form-actions' }, [
                    h('label', { key: 'sb', className: 'dshsh-form-check', title: '勾选 = 引用宏后末尾自动回车（不勾只填输入行，留给人确认）' }, [
                      h('input', { key: 'sc', type: 'checkbox', checked: mSubmit, onChange: (e) => setMSubmit(e.target.checked) }),
                      ' submit（末尾自动 Enter）',
                    ]),
                    h('div', { key: 'b', className: 'dshsh-form-btns' }, [
                      h('button', {
                        key: 'go', type: 'button', className: 'dshsh-cmenu-go',
                        disabled: secretsBusy || mName.trim() === '' || mText.trim() === '',
                        onClick: () => { void secretsPost('/macro-set', { name: mName.trim(), text: mText, scope: mScope, submit: mSubmit, note: mNote.trim() }).then((ok) => { if (ok) { setMName(''); setMText(''); setMNote('') } }) },
                      }, '保存宏'),
                    ]),
                  ]),
                ]),
              ]),
              h('div', { key: 'mlist', className: 'dshsh-consent-right' }, [
              h('div', { key: 'lmh', className: 'dshsh-cmenu-h' }, '现有宏（' + (Array.isArray(secretsData?.macros) ? secretsData.macros.length : 0) + '）'),
              // 0.3.4 三段式列表（规格）：筛选行 / 表头（宏名·域·归属·内容·备注·操作）/ 显示区
              UI.List({
                key: 'macro-list',
                placeholder: '搜索：宏名 / 内容 / 备注',
                alwaysCount: true,
                widths: widthsOf('macros'),
                onResize: onColResize('macros'),
                filterValues: filtersOf('macros'),
                onFilterChange: onColFilter('macros'),
                rows: (Array.isArray(secretsData?.macros) ? secretsData.macros : []).map((item) => ({ ...item, __key: item.name })),
                query: macroQuery,
                onQueryChange: (e) => setMacroQuery(e.target.value),
                sortKey: macroSortKey,
                sortDir: macroSortDir,
                onSort: (key, dir) => { setMacroSortKey(key); setMacroSortDir(dir) },
                emptyText: macroQuery.trim() !== '' ? '没有匹配的宏' : '（还没有宏）',
                columns: [
                  { key: 'name', label: '宏名', sortable: true, width: '20%',
                    title: '点宏名即复制引用形态 {{m:宏名}}',
                    cellTitle: (row) => '{{m:' + String(row.name) + '}}',
                    render: (value) => h('span', {
                      key: 'k', style: { cursor: 'pointer' },
                      title: '点击复制 {{m:' + value + '}}',
                      onClick: () => copyRef('{{m:' + value + '}}'),
                    }, value + '  ' + (copiedKey === '{{m:' + value + '}}' ? '✓ 已复制' : '⧉')) },
                  { key: 'scope', label: '域', width: '14%', sortable: true,
                    title: 'global=所有对话可用；conversation=仅归属对话；「·不提交」= 引用时只填输入行不自动按 Enter（此类宏禁止嵌 {{v:}} 秘密）',
                    get: (row) => String(row.scope ?? '') + (row.submit === false ? '·不提交' : ''),
                    filter: { auto: true, title: '按作用域筛选' },
                    cellTitle: (row) => String(row.scope ?? '') + (row.submit === false ? '·不提交' : '') },
                  // 可压缩列（用户规格：空间不足时优先压这类『不太重要』的列，例如宏的内容列）
                  { key: 'text', label: '内容', width: '30%', flex: true,
                    title: '发送时才展开成真实命令；可嵌 {{v:键名}}；换行整体走粘贴通道',
                    cellTitle: (row) => String(row.text ?? ''),
                    render: (v) => h('span', { key: 'x', className: 'dshsh-cmenu-sub' }, String(v ?? '').replace(/\n/g, '⏎')) },
                  { key: 'owner', label: '归属', width: '11%', sortable: true,
                    title: '创建者/归属会话（global 宏对所有人可用）',
                    cellTitle: (row) => String(row.owner ?? ''),
                    filter: { auto: true, title: '按归属筛选' },
                    render: (v) => (String(v ?? '') === '' ? '—' : h('span', { key: 'o', className: 'dshsh-cmenu-sub' }, String(v))) },
                  { key: 'note', label: '备注', width: '15%',
                    cellTitle: (row) => String(row.note ?? ''),
                    render: (v) => (v || '—') },
                  { key: '__act', label: '操作', width: '10%', minContent: 176, title: '删除会记入审计封链',
                    render: (v, row) => h('button', {
                      key: 'a', type: 'button', className: 'dshsh-cmenu-clear', disabled: secretsBusy,
                      style: { height: '22px', padding: '0 8px', fontSize: '11px' },
                      onClick: () => void secretsPost('/macro-rm', { name: row.name }),
                    }, '删除') },
                ],
              }),
              ]),
              ]),
            ],
      ])
      // 下拉排序：与草稿顺序一致（actor 标签在前）
      // 0.3.4 引用库独立浮层（与授权管理分开）：秘密域 {{v:键}} + 宏 {{m:名}}
      // 同一渲染器：面板内设置页直接挂 SettingsCard（与 DSH 设置页同一组件、同一后端）。
      const settingsPage = settingsOpen ? UI.Menu({
        key: 'settings-page',
        className: 'dshsh-u-sheet-detail',
        top: String(topInset) + 'px',
        height: 'max(140px, calc(100% - ' + String((topInset + bottomReserve)) + 'px))',
        maxHeight: 'calc(100% - ' + String((topInset + bottomReserve)) + 'px)',
        title: '设置',
        chip: '与 DSH 设置同源',
        actions: [
          h('button', {
            key: 'close', type: 'button', className: 'dshsh-btn',
            onClick: () => setSettingsOpen(false), title: '关闭设置',
          }, '✕'),
        ],
      }, [h(SettingsCard, { key: 'panel-settings', view: 'page', surface: 'panel' })]) : null

      const secretsMenu = secretsOpen ? UI.Menu({
        key: 'smenu',
        top: String(topInset) + 'px',
        height: 'max(140px, calc(100% - ' + String((topInset + bottomReserve)) + 'px))',
        maxHeight: 'calc(100% - ' + String((topInset + bottomReserve)) + 'px)',
        title: '引用库',
        chip: '秘密域 + 宏',
        chipTitle: '值只存在 DSH 里（AI 只看得到键名）；写入宏会记进操作记录链',
        tabs: [
          { id: 'vault', label: '秘密域', active: secretsTab === 'vault', onClick: () => { setSecretsTab('vault'); void loadSecrets() }, title: '人录入的 {{v:键}}，AI 只能引用键名' },
          { id: 'macros', label: '宏命令', active: secretsTab === 'macros', onClick: () => { setSecretsTab('macros'); void loadSecrets() }, title: '可复用片段 {{m:名}}，写入全入审计封链' },
        ],
        // 用户要求：说明按钮（👁）挪到标签行最右侧；「仅名称」时隐藏页顶说明。
        tabsExtra: h('button', {
          key: 'eye-tabs', type: 'button', className: 'dshsh-cmenu-clear dshsh-eye',
          style: { marginLeft: 'auto', height: '20px', padding: '0 8px', fontSize: '11px' },
          title: hintsOn === true ? '切换到「仅名称」：隐藏说明文字' : '切换到「说明」：显示说明文字',
          onClick: () => toggleHints(),
        }, hintsOn === true ? '👁 仅名称' : '👁 说明'),
      }, [secretsBody]) : null

      const consentMenu = consentMenuOpen ? UI.Menu({
        key: 'cmenu',
        top: String(topInset) + 'px',
        height: 'max(140px, calc(100% - ' + String((topInset + bottomReserve)) + 'px))',
        maxHeight: 'calc(100% - ' + String((topInset + bottomReserve)) + 'px)',
        title: '授权管理',
        chip: chip.label,
        chipTitle: '默认授权规则控制新会话（复制一份到自己名下）；已建会话各自独立',
        tabs: [
          { id: 'actor', label: '会话授权', active: consentTab === 'actor', onClick: () => setConsentTab('actor'),
            title: '逐个看/改每个会话自己的授权规则（新建时从默认规则复制一份）' },
          { id: 'global', label: '默认授权', active: consentTab === 'global', onClick: () => setConsentTab('global'),
            title: '默认授权规则：新建会话复制它（复制一份到自己名下；改它只影响之后新建的会话）' },
        ],
      }, [
        // 状态概览行 —— 进页面先看到「现在什么状态」，再决定改什么
        (() => {
          const ov = consentOverviewModel(consentInfo)
          return h('div', { key: 'ov', className: 'dshsh-consent-overview' }, [
            h('span', { key: 'dot', className: 'dshsh-consent-overview-dot ' + ov.dotTone }),
            h('span', { key: 'main', className: 'dshsh-consent-overview-main' }, ov.primary),
            h('span', { key: 'sub', className: 'dshsh-consent-overview-sub' }, ov.detail),
          ])
        })(),
        // 0.4.0：模式行 —— 它决定一切（工作区模式只可查不可用；完全控制默认可直接控制一切）
        (() => {
          const ov = consentOverviewModel(consentInfo)
          return h('div', { key: 'mode', className: 'dshsh-consent-mode' }, [
            h('span', { key: 'l', className: 'dshsh-consent-mode-label' }, '沙箱'),
            h('span', {
              key: 'v',
              className: 'dshsh-consent-mode-value ' + (ov.fullUsable ? 'ok' : 'warn'),
              title: '来自会话真实生效的沙箱模式（不是部署环境变量）；完全控制下改动类工具默认可直接使用',
            }, ov.modeShort),
            h('span', { key: 'c', className: 'dshsh-consent-mode-cap', title: ov.capabilityLong }, ov.capability),
            h('span', {
              key: 'd',
              className: 'dshsh-consent-mode-cap',
              title: ov.defaultDerived
                ? '默认档是按会话的沙箱模式推导出来的（没有人在面板里显式设过它）'
                : '默认档是用户在面板里显式设置的',
            }, ov.defaultDerived ? '默认跟随' : '默认已设'),
            // 谱系树入口：默认只列相关的；点开后含子代理与已归档、按谱系缩进（可选中修改）
            (() => {
              if (consentTab !== 'actor') return null
              const m = actorListModel(
                actors !== null && Array.isArray(actors.actors) ? actors.actors : [],
                actors === null ? null : actors.groups,
                actorQuery,
                { showAll: actorShowAll },
              )
              return h('span', { key: 'grow', className: 'dshsh-consent-mode-grow' },
                actorShowAll
                  ? h('button', {
                      key: 'less', type: 'button', className: 'dshsh-consent-morebtn',
                      onClick: () => setActorShowAll(false),
                      title: '收起，只看与本对话相关的那些会话',
                    }, '收起')
                  : h('button', {
                      key: 'more', type: 'button', className: 'dshsh-consent-morebtn',
                      disabled: m.hiddenCount === 0,
                      onClick: () => setActorShowAll(true),
                      title: '展开：包含子代理与已归档会话，按谱系缩进排列（父会话在前，子代理在下）',
                    }, '更多 ' + String(m.hiddenCount)))
            })(),
          ])
        })(),
        // 谱系树的入口（按钮已并入上面的模式行，这里不再占一行 —— 用户反馈顶部太占地方）。
        // 长说明也收进按钮的 title，不再铺在页面上。
        consentTab === 'global'
          ? h('div', { key: 'global', className: 'dshsh-u-sheet-body' }, [
              h('div', { key: 'note', className: 'dshsh-cmenu-sub' },
                '默认授权规则：新建的会话在第一次被用到时会把这份规则复制一份到自己名下（值拷贝，不是继承）——之后改这里不影响已建会话。'),
              h('div', { key: 'ds', className: 'dshsh-cmenu-seg' }, scopeKeys.map((key) => seg(
                'd-' + key, CONSENT_SCOPE_LABELS[key] ?? key, draftScope === key, () => setDraftScope(key)))),
              h('div', { key: 't2', className: 'dshsh-cmenu-h' }, '有效期'),
              h('div', { key: 'dt', className: 'dshsh-cmenu-seg' }, ttlLevels.map((level) => seg(
                'dt-' + level.key, level.label, draftTtl === level.key, () => setDraftTtl(level.key)))),
              draftTtl === 'custom' ? customMinutesRow(customMinutes, setCustomMinutes) : null,
              h('div', { key: 'da', className: 'dshsh-cmenu-actions' }, [
                h('button', {
                  key: 'go', type: 'button', className: 'dshsh-cmenu-go', disabled: consentBusy,
                  onClick: () => { void postConsent('set-default', { scope: draftScope, ttlSeconds: consentTtlSeconds(draftTtl, customMinutes) }) },
                  title: '更新默认规则：之后新建的会话会把这份规则复制到自己的配置上（已建会话不受影响）',
                }, '保存默认规则'),
              ]),
            ])
          : actors !== null && actors.supported !== true
            ? h('div', { key: 'act-manual', className: 'dshsh-u-sheet-body' }, [
                h('div', { key: 'note', className: 'dshsh-cmenu-sub' },
                  (actors.note ?? 'DSH 没有提供对话目录') + '。可以手工填会话 id：'),
                h('input', {
                  key: 'm', type: 'text', className: 'dshsh-cmenu-in',
                  style: { width: '100%' },
                  placeholder: '会话 id，例如 session-…',
                  value: actorManual,
                  onChange: (event) => setActorManual(event.target.value),
                }),
                h('div', { key: 'mg', className: 'dshsh-cmenu-actions' }, [
                  h('button', {
                    key: 'go', type: 'button', className: 'dshsh-cmenu-go',
                    disabled: actorManual.trim() === '' || consentBusy,
                    onClick: () => setActorPick({ id: actorManual.trim(), title: '手工填写' }),
                  }, '选定这个 id'),
                ]),
              ])
            : UI.List({
                key: 'actor-list',
                placeholder: '搜索：标题 / 会话 id / 创建者',
                alwaysCount: true,
                widths: widthsOf('actors'),
                onResize: onColResize('actors'),
                filterValues: filtersOf('actors'),
                onFilterChange: onColFilter('actors'),
                columns: [
                  { key: 'title', label: '会话', sortable: true, width: '34%',
                    title: 'DSH 的对话目录：点一行选中，右边配置权限',
                    get: (a) => a.title || a.id,
                    cellTitle: (a) => (a.title || '(无标题)') + '（' + a.id + '）',
                    render: (v, a) => {
                      const d = Number.isFinite(a.__depth) ? a.__depth : 0
                      // 层级视觉：缩进 + 「│ 」竖线 + 「└─」拐角，比单纯空格缩进明确得多
                      const prefix = d === 0 ? '' : '│  '.repeat(Math.max(0, d - 1)) + '└─ '
                      return h('span', {
                        key: 't',
                        className: 'dshsh-actor-title' + (d > 0 ? ' sub' : ''),
                        style: d > 0 ? { paddingLeft: String(d * 16) + 'px' } : undefined,
                        title: (d > 0 ? '第 ' + String(d) + ' 层 · ' : '')
                          + (a.parent !== null && a.parent !== undefined ? '创建者：' + String(a.parent) : '顶层对话'),
                      }, prefix + (a.title || '(无标题)'))
                    } },
                  { key: 'owner', label: '创建者', sortable: true, width: '16%',
                    title: '会话的创建者（子代理会标出来）',
                    get: (a) => (a.origin === 'subagent' ? '子代理' : String(a.creator ?? a.owner ?? '')),
                    filter: { auto: true, title: '按创建者筛选' },
                    render: (v) => (String(v ?? '') === '' ? '—' : String(v)) },
                  { key: 'updated', label: '活跃', sortable: true, width: '14%',
                    // 活跃时间无法用"值相等"筛选（值是时间戳）⇒ 用档位 + filterMatch
                    filter: { options: [{ value: 'today', label: '今天' }, { value: '7d', label: '近 7 天' }, { value: 'older', label: '更早' }], title: '按活跃时间筛选（分档）' },
                    filterMatch: (a, want) => {
                      const t = Number((a || {}).updated ?? (a || {}).created ?? 0)
                      if (!Number.isFinite(t) || t <= 0) return want === 'older'
                      const age = Date.now() - t
                      if (want === 'today') return age < 86400000
                      if (want === '7d') return age < 7 * 86400000
                      if (want === 'older') return age >= 7 * 86400000
                      return true
                    },
                    title: '最近活跃时间（相对现在）',
                    get: (a) => a.updated ?? a.created ?? 0,
                    cellTitle: (a) => new Date(Number(a.updated ?? a.created ?? 0)).toLocaleString('zh-CN'),
                    render: (v) => h('span', { key: 'w', className: 'dshsh-actor-when' }, timeAgoText(typeof v === 'number' ? v : 0)) },
                  { key: 'granted', label: '授权状态', sortable: true, width: '20%',
                    title: '该会话当前是否已有自己的规则',
                    get: (a) => (a.granted ? '已授权' : (a.origin === 'subagent' ? '子代理' : (a.isRecent ? '最近使用' : '未授权'))),
                    filter: { auto: true, title: '按授权状态筛选' },
                    render: (v) => h('span', { key: 'g', className: 'dshsh-actor-tag' + (v === '已授权' ? ' ok' : '') }, v) },
                  // 层级：既是信息（是顶层对话还是子代理/子层），也带一个自动筛选项
                  { key: 'depth', label: '层级', sortable: true, width: '8%',
                    filter: { auto: true, title: '按层级筛选' },
                    get: (a) => { const d = Number.isFinite((a || {}).__depth) ? a.__depth : 0; return d === 0 ? '顶层' : '子层 ' + String(d) },
                    cellTitle: (a) => { const d = Number.isFinite((a || {}).__depth) ? a.__depth : 0; return d === 0 ? '顶层对话（没有父对话）' : '第 ' + String(d) + ' 层（有父对话）' } },
                ],
              // ⚠ 必须走 actorListModel：上一版把过滤写在模型里、渲染却直接读 actors.actors，
              // 于是那套过滤是死代码（默认仍然列全部，含子 agent）。
              rows: actorListModel(
                actors !== null && Array.isArray(actors.actors) ? actors.actors : [],
                actors === null ? null : actors.groups,
                actorQuery,
                { showAll: actorShowAll },
              ).visible.map((a) => ({ ...a, __key: a.id, __depth: Number.isFinite(a.__depth) ? a.__depth : 0 })),
              query: actorQuery, onQueryChange: (ev) => setActorQuery(ev.target.value),
              sortKey: actorSortKey, sortDir: actorSortDir,
              onSort: (key, dir) => { setActorSortKey(key); setActorSortDir(dir) },
              selectedKey: actorPick !== null ? actorPick.id : undefined,
              onRowClick: (a) => setActorPick({
                id: a.id,
                title: a.title || a.id,
                // 该会话自己的沙箱模式（服务端判定时记在 entry.mode 上）—— 面板唯一能给出的
                // "它在什么模式下"的准确答案；没有记录的会话就是"未判定过"。
                mode: typeof a.mode === 'string' ? a.mode : null,
                origin: a.origin === 'subagent' ? 'subagent' : 'session',
                depth: Number.isFinite(a.depth) ? a.depth : 0,
              }),
              emptyText: actors === null ? '正在读取对话列表…' : (actors.supported !== true ? 'DSH 没有提供对话目录' : '没有匹配的会话'),
              // 默认：不给下区 → 表格占满；点选会话后下方弹出权限配置（下区按内容完整显示，上区吃剩余空间）
              rightFit: true,
              right: actorPick === null ? null : [
                h('div', { key: 'who', className: 'dshsh-cmenu-sub dshsh-consent-who' }, '授予：' + (actorPick.title || actorPick.id)),
                h('div', { key: 'pickmode', className: 'dshsh-consent-pickmode' },
                  (actorPick.origin === 'subagent' ? '子代理 · ' : '')
                  + '沙箱模式：' + (actorPick.mode === 'danger-full-access'
                    ? '完全控制'
                    : (actorPick.mode === 'workspace-write'
                      ? '工作区（只可查）'
                      : (actorPick.mode === 'read-only' ? '只读（只可查）' : '未判定过（尚未用过插件）')))),
                ...scopeCards('a-', actorScope, setActorScope),
                h('div', { key: 'ttls', className: 'dshsh-cmenu-seg' }, ttlLevels.map((level) => seg(
                  'at-' + level.key, level.label, actorTtl === level.key, () => setActorTtl(level.key)))),
                actorTtl === 'custom' ? customMinutesRow(customMinutes, setCustomMinutes) : null,
                h('div', { key: 'row', className: 'dshsh-cmenu-actions dshsh-consent-actions' }, [
                  h('button', {
                    key: 'go2', type: 'button', className: 'dshsh-cmenu-go', disabled: consentBusy,
                    onClick: () => {
                      void postConsent('set-session', { actor: actorPick.id, scope: actorScope, ttlSeconds: consentTtlSeconds(actorTtl, customMinutes) })
                    },
                    title: '给这个对话单独授权（不影响其它对话）',
                  }, consentRows.some((row) => row.actor === actorPick.id) ? '更新授权' : '授权此对话'),
                  consentRows.some((row) => row.actor === actorPick.id)
                    ? h('button', {
                        key: 'rv', type: 'button', className: 'dshsh-cmenu-clear', disabled: consentBusy,
                        onClick: () => {
                          void postConsent('revoke-one', { actor: actorPick.id })
                        },
                        title: '撤销这个会话现有的授权',
                      }, '撤销此对话')
                    : null,
                  h('button', {
                    key: 'drop2', type: 'button', className: 'dshsh-btn txt', disabled: consentBusy,
                    onClick: () => setActorPick(null),
                  }, '取消'),
                ]),
              ],
            }),
      ]) : null

      // 0.3.3 #3：播放器 —— 接管屏幕区，且**替换掉**状态条与输入行（回放中不发送，杜绝"边看边打"）。
      const frameAt = (r) => (r === null || !Array.isArray(r?.frames) || r.frames.length === 0 ? null : r.frames[Math.min(r.idx, r.frames.length - 1)])
      const pframes = replay !== null && Array.isArray(replay.frames) ? replay.frames : []
      const pidx = replay !== null && Number.isFinite(replay.idx) ? Math.min(replay.idx, Math.max(0, pframes.length - 1)) : 0
      const player = replay === null ? null : h('div', { key: 'player', className: 'dshsh-player' }, [
        h('pre', { key: 'p-screen', className: 'dshsh-screen dshsh-player-screen', style: S.screen },
          h('span', { className: 'dshsh-screen-text' },
            replay.loading ? '(回放读取中…)'
              : replay.error !== '' ? '(' + replay.error + ')'
                : (() => {
                    // 0.3.4：回放帧与 /screen 同构（含 ANSI），走同一 SGR 渲染（颜色复刻）
                    const raw = String(frameAt(replay)?.s ?? '(无帧)')
                    const { lines } = renderScreenLines(raw, { query: '' })
                    return lines.map((row, li) => [...row.map((seg, si) => seg.style === null
                      ? seg.text
                      : h('span', { key: 's' + li + '-' + si, style: seg.style }, seg.text)), '\n'])
                  })())),
        h('div', { key: 'p-bar', className: 'dshsh-player-bar' }, [
          h('button', {
            key: 'p-play', type: 'button', className: 'dshsh-btn', title: replay.playing ? '暂停' : '播放',
            disabled: !Array.isArray(pframes) || pframes.length < 2,
            onClick: () => setReplay((r) => (r === null ? r : { ...r, playing: !r.playing, idx: !r.playing && r.idx >= r.frames.length - 1 ? 0 : r.idx })),
          }, h(Icon, { name: replay.playing ? 'pause' : 'play', size: 14 })),
          h('select', {
            key: 'p-speed', className: 'dshsh-player-speed', value: String(replay.speed), title: '倍速',
            onChange: (e) => setReplay((r) => (r === null ? r : { ...r, speed: Number(e.target.value) })),
          }, [0.5, 1, 2, 4, 8].map((s) => h('option', { key: String(s), value: String(s) }, String(s) + '×'))),
          h('input', {
            key: 'p-scrub', type: 'range', className: 'dshsh-player-scrub',
            min: 0, max: Math.max(0, pframes.length - 1), value: Math.min(replay.idx, Math.max(0, pframes.length - 1)),
            title: '时间轴（拖动即暂停）',
            onChange: (e) => setReplay((r) => (r === null ? r : { ...r, idx: Number(e.target.value) || 0, playing: false })),
          }),
          h('span', { key: 'p-clock', className: 'dshsh-player-clock' },
            replayClock(frameAt(replay)?.t ?? 0) + ' / ' + replayClock(pframes.length === 0 ? 0 : pframes[pframes.length - 1].t ?? 0)),
          h('span', { key: 'p-file', className: 'dshsh-player-file', title: '帧文件（output/ 下，会话关了也在）' }, replay.file),
          h('button', { key: 'p-close', type: 'button', className: 'dshsh-btn', title: '关闭回放（回到直播）',
            onClick: () => setReplay(null) }, h(Icon, { name: 'x', size: 13 })),
        ]),
      ])

      // ── 0.3.4 日志与审计管理浮层：两页签（审计/留痕）+ 上半列表（排序/搜索）+ 下半详情 ──
      // 顶部工具条：排序键 + 方向 + 搜索框（文件多了靠它筛）
      const logFiles = logTab === 'output' ? logData?.outputFiles : logData?.auditFiles
      const logDetailBody = logSelected === null
        ? null
        : (logDetail === null
          ? h('div', { key: 'dl', className: 'dshsh-cmenu-sub' }, '读取详情…')
          : (logDetail.error !== undefined
            ? h('div', { key: 'de', className: 'dshsh-cmenu-sub warn' }, String(logDetail.error))
            : h('div', { key: 'det', className: 'dshsh-log-detail' }, [
                h('div', { key: 'm', className: 'dshsh-cmenu-sub' },
                  String(logDetail.name) + ' · ' + (Number.isFinite(logDetail.lines) ? String(logDetail.lines) + ' 行' : '行数统计中…') + ' · ' + fmtBytes(logDetail.bytes ?? 0)),
                logDetail.events !== undefined
                  ? h('div', { key: 'ev', className: 'dshsh-cmenu-sub' },
                    '事件：' + Object.entries(logDetail.events).map(([k, v]) => `${k}×${v}`).join('  ') + (Object.keys(logDetail.events).length === 0 ? '（无）' : ''))
                  : null,
                h('div', { key: 'hs', className: 'dshsh-cmenu-h' }, '开头'),
                ...(Array.isArray(logDetail.head) && logDetail.head.length > 0
                  ? logDetail.head.map((l, i) => h('div', { key: 'h' + i, className: 'dshsh-log-line' }, l))
                  : [h('div', { key: 'he', className: 'dshsh-cmenu-sub' }, '（空）')]),
                h('div', { key: 'ts', className: 'dshsh-cmenu-h' }, '结尾'),
                ...(Array.isArray(logDetail.tail) && logDetail.tail.length > 0
                  ? logDetail.tail.map((l, i) => h('div', { key: 't' + i, className: 'dshsh-log-line' }, l))
                  : [h('div', { key: 'te', className: 'dshsh-cmenu-sub' }, '（空）')]),
              ])))
            // 日志与审计内容：详情「历史记录 → 日志审计」直接复用；不再单独占一个浮层。
      const logContent = logBusy
      ? h('div', { key: 'loading', className: 'dshsh-cmenu-sub' }, '读取中…')
      : (logData === null || logData.error !== undefined
        ? h('div', { key: 'err', className: 'dshsh-cmenu-sub' },
          logData?.error ?? withCode('读取失败：连不上 DSH，或者审计没开', UI_ERR.UNREACHABLE))
        : [
            // 总体统计（只用文件清单的字节数，不读内容 → 打开即出）
            (() => {
              const s = logStatsModel(logData)
              return h('div', { key: 'logstats', className: 'dshsh-logstats' }, [
                h('span', { key: 'a', className: 'dshsh-logstats-item' },
                  h('span', { key: 'k', className: 'dshsh-logstats-k' }, '审计'), s.auditText),
                h('span', { key: 'o', className: 'dshsh-logstats-item' },
                  h('span', { key: 'k', className: 'dshsh-logstats-k' }, '留痕'), s.outputText),
                h('span', { key: 'c', className: 'dshsh-logstats-item' },
                  h('span', { key: 'k', className: 'dshsh-logstats-k' }, '链'), s.chainText),
              ])
            })(),
            // 0.3.4：统一列表抽象——筛选条（搜索 + 排序下拉）由 UI.List 内置，
            // 行用 renderRow 自定义（保留两击删除确认），右侧为详情（right 参数）。
            UI.List({
              key: 'loglist',
              placeholder: '搜索文件名…',
              alwaysCount: true,
              widths: widthsOf('log-' + logTab),
              onResize: onColResize('log-' + logTab),
              filterValues: filtersOf('log-' + logTab),
              onFilterChange: onColFilter('log-' + logTab),
              // 三段式：① 筛选行（时间范围 + 搜索）② 表头（文件名·大小·时间·操作）③ 显示区
              columns: [
                { key: 'name', label: '文件名', sortable: true, width: '46%',
                  title: '点行查看详情；文件名即审计/留痕文件',
                  cellTitle: (f) => String(f.name),
                  render: (v) => h('span', { key: 'n', style: { fontFamily: 'var(--ds-font-family-code)', fontSize: '11px' } }, String(v)) },
                { key: 'bytes', label: '大小', sortable: true, width: '14%',
                  title: '文件字节数',
                  get: (f) => f.bytes ?? 0,
                  render: (v) => (Number.isFinite(v) ? fmtBytes(v) : '?') },
                { key: 'mtimeMs', label: '时间', sortable: true, width: '22%',
                  title: '最后修改时间（相对现在）',
                  get: (f) => f.mtimeMs ?? 0,
                  cellTitle: (f) => (Number.isFinite(f.mtimeMs) && f.mtimeMs > 0 ? new Date(f.mtimeMs).toLocaleString('zh-CN') : '—'),
                  render: (v) => (Number.isFinite(v) && v > 0 ? timeAgoText(v) : '—') },
                { key: '__age', label: '时间范围', sortable: false, width: '0%', hidden: true,
                  get: (f) => (Number.isFinite(f.mtimeMs) && f.mtimeMs > 0 ? 'ok' : ''),
                  filter: {
                    title: '按文件年龄筛选',
                    options: [
                      { value: '1', label: '近 1 天' },
                      { value: '7', label: '近 7 天' },
                      { value: '30', label: '近 30 天' },
                    ],
                    hint: '按最后修改时间',
                  },
                  filterMatch: (f, want) => {
                    const days = Number(want)
                    if (!Number.isFinite(days) || days <= 0) return true
                    const ms = Number(f?.mtimeMs ?? 0)
                    if (!Number.isFinite(ms) || ms <= 0) return false
                    return Date.now() - ms <= days * 86400000
                  } },
                { key: '__act', label: '操作', width: '18%', minContent: 176, title: '删除会先写入审计链见证（event:purge）',
                  render: (v, f) => {
                    const kind = logTab === 'output' ? 'output' : 'audit'
                    const name = String(f.name)
                    return h('button', {
                      key: 'x', type: 'button', className: 'dshsh-btn txt' + (logConfirm === name ? ' danger armed' : ' danger hot'),
                      disabled: logBusy,
                      onClick: (e) => {
                        e.stopPropagation()
                        if (logConfirm !== name) { setLogConfirm(name); return }
                        void purgeFile(kind, name)
                      },
                      title: logConfirm === name ? '再点一次确认删除（先入链见证）' : '删除这个文件（先入链见证）',
                    }, logConfirm === name ? '确认删除' : '删除')
                  } },
              ],
              rows: (logFiles ?? []).map((f) => ({ ...f, __key: f.name })),
              query: logQuery,
              onQueryChange: (e) => setLogQuery(e.target.value),
              sortKey: logSortKey === 'time' ? 'mtimeMs' : (logSortKey === 'size' ? 'bytes' : logSortKey),
              sortDir: logSortDir,
              onSort: (k, d) => { setLogSortKey(k); setLogSortDir(d) },
              selectedKey: logSelected !== null ? logSelected.name : undefined,
              onRowClick: (f) => { void loadLogDetail(logTab === 'output' ? 'output' : 'audit', f.name) },
              emptyText: logQuery.trim() !== '' ? '没有匹配的文件' : '（无）',
              // 默认：表格占满；点选一个文件后下方才弹出详情。
              // rightFit：下区按内容**全量显示**（不压缩、不出自己的滚动条），上区吃剩余空间 ——
              // 用户反馈"两个子页面显示比例不合适、详情应全量显示"。
              rightFit: true,
              right: logSelected === null ? null : [logDetailBody],
            }),
            h('div', { key: 'note', className: 'dshsh-cmenu-sub' },
              '删除不可逆：点「删除」第一下进入确认、再点一次才删；删除动作写入审计链见证（event:purge + 文件名 + 哈希）。'),
          ])

      const logTabBar = h('div', { key: 'logtabs', className: 'dshsh-u-tabs dshsh-u-tabs3', style: { margin: '2px 0 8px' } }, [
        h('button', { key: 'audit', type: 'button', className: 'dshsh-u-tab' + (logTab === 'audit' ? ' on' : ''),
          onClick: () => { setLogTab('audit'); setLogSelected(null); setLogDetail(null); setLogConfirm('') } }, '审计文件'),
        h('button', { key: 'output', type: 'button', className: 'dshsh-u-tab' + (logTab === 'output' ? ' on' : ''),
          onClick: () => { setLogTab('output'); setLogSelected(null); setLogDetail(null); setLogConfirm('') } }, '输出留痕'),
      ])


      // 内容节点就绪后写入 ref：稳定组件在 React 渲染子节点时读取（见上方 logPageNodes 注释）。
      // 日志审计页的磁盘占用统计条：把原来详情头部的「扫描占用」并进来（同一件事只留一个入口）。
      const logScan = auditScan === null || auditScan === undefined ? null : auditScan
      const logScanText = logScan === null
        ? '占用未统计'
        : logScan.phase === 'scanning'
          ? '统计中…'
          : logScan.phase === 'error'
            ? '统计失败：' + String(logScan.error ?? '未知')
            : '占用 ' + fmtBytes(Number(logScan.bytes) || 0) + ' · ' + String(logScan.files ?? 0) + ' 个文件'
              + (logScan.days !== null && typeof logScan.days === 'object' ? ' · ' + String(Object.keys(logScan.days).length) + ' 天' : '')
              + (logScan.mirror ? ' · 镜像 ' + fmtBytes(Number(logScan.mirror.bytes) || 0) : '')
              + (Number.isFinite(logScan.ms) ? '（' + String(logScan.ms) + 'ms）' : '')
      const logScanBar = h('div', { key: 'logscan', className: 'dshsh-cmenu-row', style: { gap: '8px', margin: '0 0 8px', alignItems: 'center' } }, [
        h('span', { key: 't', className: 'dshsh-cmenu-sub', style: { flex: '1', minWidth: '0' } }, logScanText),
        h('button', {
          key: 'b', type: 'button', className: 'dshsh-stat-btn' + (logScan?.phase === 'scanning' ? ' on' : ''),
          disabled: logScan?.phase === 'scanning',
          onClick: scanAudit,
          title: '遍历审计目录统计磁盘占用（只在点击后执行）',
        }, logScan?.phase === 'scanning' ? '统计中…' : '刷新统计'),
      ])

      // 内容节点（logTabBar / logScanBar / logContent）在下面定义；DeferredRegion 在子级渲染时读取，见其注释。

            const children = [picker, consentMenu, info, settingsPage, secretsMenu, head]
      if (player !== null) children.push(player)
      else children.push(searchBar, body, stats, hintBar, inputRow)
      if (error !== '') {
      }
      // 与 error 分开渲染：这类消息代表"操作成功了，但结果与你输入的不完全一样"，
      // 用红色报错是误导，用沉默则是静默改写。
      // 提示信息浮层：默认右上角；右侧任意菜单打开时移到左上角（否则会被引用库/授权等挡住）
      const rightMenuOpen = consentMenuOpen || secretsOpen || logOpen || infoOpen || settingsOpen
      if (toasts.length > 0) {
        children.push(h('div', {
          key: 'toasts',
          className: 'dshsh-toasts' + (rightMenuOpen ? ' at-left' : ''),
          style: { '--dshsh-toast-ms': String(uiToastDuration) + 'ms' },
        }, toasts.map((t) => {
          const time = new Date(t.at).toTimeString().slice(0, 8)
          return h('div', {
            key: 't' + String(t.id),
            className: 'dshsh-toast lv-' + t.level,
            // 停留结束 → 淡出动画结束 → 移除（悬停时动画暂停，因此也不会被移除）
            onAnimationEnd: (event) => {
              if (String(event.animationName ?? '').indexOf('dshsh-toast-out') < 0) return
              setToasts((prev) => prev.filter((x2) => x2.id !== t.id))
            },
          }, [
            h('div', { key: 'hd', className: 'dshsh-toast-hd' }, [
              h('span', { key: 'd', className: 'dshsh-toast-dot' }),
              h('span', { key: 'b', className: 'dshsh-toast-brief', title: t.brief }, t.brief),
              h('span', { key: 't', className: 'dshsh-toast-time' }, time),
            ]),
            t.detail === ''
              ? null
              : h('div', { key: 'dt', className: 'dshsh-toast-detail', title: t.detail }, t.detail),
            // 倒计时横条：宽度由 keyframes 从 100% → 0，悬停时由 CSS 暂停
            h('span', { key: 'bar', className: 'dshsh-toast-bar' }),
          ])
        })))
      }

      const RESIZE_DIRS = ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se']
      const resizeHandles = RESIZE_DIRS.map((dir) => h('div', {
        key: 'rs-' + dir,
        className: 'dshsh-rs dshsh-rs-' + dir,
        onPointerDown: (e) => {
          // pointerdown 会 preventDefault ⇒ 浏览器不再派发 click/dblclick，挂在同一把手上的
          // onDoubleClick 永远收不到（用户实报：双击右下角自动对齐失效且无提示）⇒ 在这里自判双击。
          if (dir === 'se') {
            const now = Date.now()
            if (now - lastSeDownRef.current < 320) {
              lastSeDownRef.current = 0
              try { e.preventDefault(); e.stopPropagation() } catch { /* 忽略 */ }
              fitToShell()
              return
            }
            lastSeDownRef.current = now
          }
          const start = beginResize(dir)
          if (typeof start === 'function') start(e)
        },
        onPointerMove: moveDrag,
        onPointerUp: endDrag,
        onPointerCancel: endDrag,
        // 右下角：双击把面板对齐到当前 shell 的 cols × rows（不出现横向滚动条）
        title: dir === 'se' ? '拖动改大小 · 双击对齐到当前 shell 尺寸' : undefined,
      }))

      // featurePanel 关闭：整个面板/胶囊不渲染；禁用提示仍会进 /notice 历史（面板消息条为其展示面）。
      if (serverFeatures !== null && serverFeatures.panel === false) return null

      return h('div', {
        key: 'panel',
        ref: panelRef,
        // overflow 必须可见，否则选择器与缩放手柄会被面板裁掉
        style: {
          ...S.panel,
          overflow: 'hidden',
          left: panelRect.left + 'px',
          top: panelRect.top + 'px',
          width: panelRect.w + 'px',
          height: panelRect.h + 'px',
          background: 'color-mix(in srgb, var(--dsw-alias-bg-layer-1) ' + String(uiPanelOpacity) + '%, transparent)',
          borderRadius: String(uiPanelRadius) + 'px',
          backdropFilter: 'blur(' + String(uiPanelBlur) + 'px)',
          WebkitBackdropFilter: 'blur(' + String(uiPanelBlur) + 'px)',
          '--dshsh-panel-font': String(uiPanelFontSize) + 'px',
          '--dshsh-menu-opacity': String(uiMenuOpacity) + '%',
          '--dshsh-terminal-bg': uiTerminalBackground,
        },
        tabIndex: -1,
        onBlur: onPanelBlur,
        onClick: onPanelClick,
        onKeyDownCapture: (e) => {
          // 0.3.4 (A)：Ctrl/Cmd+F 在面板内打开搜索（不会弹浏览器查找）
          if ((e.ctrlKey === true || e.metaKey === true) && (e.key === 'f' || e.key === 'F') && e.shiftKey !== true) {
            e.preventDefault()
            e.stopPropagation()
            setSearchOpen(true)
            return
          }
          // ── 面板快捷键（0.4.0）───────────────────────────────────────────
          // 终端自己的键一个都不抢：bash/PSReadLine 的 Ctrl 单字符、Alt-*、F7 都照旧送进终端
          // （tmux 的 C-b 前缀也在其中，所以 tmux 原生能力直接可用）。面板统一用 Ctrl+Shift+*。
          const act = decidePanelKey(e)
          if (act === null) {
            // ── 终端"浏览器危险键"兜底（0.4.0 bug 修复）──────────────────────
            // Ctrl+W / Ctrl+T / Ctrl+N 是 readline 的常用键（删词 / 交换字符 / 历史下一条），
            // 但浏览器把它们当"关闭标签页 / 新标签页 / 新窗口"。
            // 以前只有**输入框自己的 keydown** 会接管它们 —— 而输入框在无会话 / 锁定 /
            // 回看态是 disabled 的（React 对 disabled 元素根本不触发 handler），焦点也可能
            // 不在输入框（刚点过按钮、在看输出）→ 那时浏览器就把键抢走。
            // 所以这里在**面板级捕获**再兜一次：只要焦点在面板内、且不在可编辑元素上
            // （可编辑元素交给它自己的 handler，避免重复发送），这三个键一律送进终端。
            const box = panelRef.current
            const target = e.target
            const inPanel = box !== null && typeof box.contains === 'function' && target !== null && box.contains(target)
            const onEditable = target !== null && typeof target.closest === 'function'
              && target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]') !== null
            if (inPanel && !onEditable) {
              const danger = decideKey({
                key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey,
                shiftKey: e.shiftKey, keyCode: e.keyCode, isComposing: e.isComposing, hasSelection: false,
              })
              if (danger.action === 'key' && (danger.key === 'C-w' || danger.key === 'C-t' || danger.key === 'C-n')) {
                e.preventDefault()
                e.stopPropagation()
                send({ keys: [danger.key] })
                return
              }
            }
            return
          }
          const anyOverlay = searchOpen || pickerOpen || consentMenuOpen || secretsOpen || logOpen || infoOpen || settingsOpen
          if (act === 'close-overlays') {
            // Esc：有浮层才拦（关浮层）；没浮层时放行给终端（vim/选单要用 Esc）
            if (anyOverlay) { e.preventDefault(); e.stopPropagation(); closeAllMenus(); setSearchOpen(false) }
            else if (renaming !== '') { e.preventDefault(); e.stopPropagation(); setRenaming('') }
            return
          }
          e.preventDefault()
          e.stopPropagation()
          if (act === 'prev' || act === 'next') {
            const list = Array.isArray(sessions) ? sessions : []
            if (list.length === 0) return
            const at = list.findIndex((s) => s.name === currentName)
            const step = act === 'next' ? 1 : -1
            const next = list[((at < 0 ? 0 : at) + step + list.length) % list.length]
            if (next !== undefined) selectShell(next.name)
            return
          }
          if (act === 'rename') { if (currentName !== '') setRenaming(currentName); return }
        },
      }, softOverlay === null ? children.concat(resizeHandles) : children.concat([softOverlay]).concat(resizeHandles))
    }

    /* ── 设置卡片 ──────────────────────────────────────────────────────────
     *
     * 为什么必须有这个：DSH 的设置页渲染的是**两份账本的交集** —— 宿主提供的 settings
     * namespace，以及注册进 `settings.plugin.item` 插槽的卡片。只注册 namespace 是**不够**的：
     * 原文是 "A served namespace no card claims renders nothing"。而且插槽是 keyed 的，
     * **key 必须与宿主注册的 namespace 完全一致**，否则卡片静默不渲染（连报错都没有）。
     * 这就是"宿主日志说注册成功、设置里却什么都没有"的全部原因。
     *
     * 读写都走本插件自己的同源路由（宿主侧再走官方 settings 服务），所以校验、持久化与
     * 「已立即生效 / 需重启」的结论都与宿主保持一致，卡片只负责显示。
     */
    const CARD_GROUP = [
      ['功能开关', ['featurePanel', 'featureTools', 'featureWatch', 'featureAudit', 'featureCapture',
        'featureReplay', 'featureVault', 'featureMacros', 'featureWorkspaces', 'featureSnapshots',
        'featureWatchdog', 'featureGuard', 'featureConsent', 'featureRedact']],
      // 0.4.0：分组必须覆盖**全部** Config 字段 —— 渲染循环只遍历本表，
      // 没列进来的字段在设置页里根本不会出现（实测曾漏掉 18/39 项）。
      ['终端与会话', ['shell', 'shellArgs', 'defaultTerminal', 'cols', 'rows', 'historyLimit',
        'maxSessions', 'idleClose', 'idleCloseMinutes', 'defaultCwd', 'sessionEnv',
        'remainOnExit', 'monitorBell', 'extendedKeys']],
      ['界面与外观', ['panelOpacity', 'menuOpacity', 'terminalBackground', 'panelRadius', 'panelFontSize', 'panelBlur', 'toastDurationMs', 'toastMax']],
      ['面板与显示', ['panelPollMs', 'redactSecrets']],
      ['审计与留痕', ['audit', 'auditRetentionDays', 'captureOutput', 'captureMaxBytes', 'auditDir',
        'replayCapture', 'auditLockReminder', 'noticeRetention']],
      ['安全与授权', ['requireConsent', 'consentTimeoutSeconds', 'consentRetryCooldownSeconds',
        'guardDangerousCommands', 'allowedHosts']],
      ['服务端与集成', ['socket', 'httpBase', 'exposeHttp', 'exposeTools', 'watchdog',
        'watchdogStrategy', 'watchdogGraceMs', 'watchdogRenewMs', 'startupDeferMs',
        'actorsCacheSeconds']],
    ]

    /* 卡片外观全部走 PANEL_CSS 里的 `.dshsh-cfg-*` 类（取值照官方编译产物，见那段 CSS 的注释）。
     * 为什么不再用内联 style 对象：内联写不了 `:hover` / `:focus-visible` / `+` 相邻选择器 /
     * 媒体查询，而官方卡片的观感恰恰依赖它们（悬停描边、字段之间的 .5px 分隔线、键盘焦点环）。
     * 顺带也消除了"每个字段一套内联尺寸"这种最容易和同页原生卡片对不齐的写法。 */

    /**
     * 可复用数字滑块设置组件。
     * - 横向 range + 末尾 number 输入框；
     * - 手动输入在 blur / Enter 时提交；不 clamp，越界只提示并拒绝（提示里写范围）；
     * - 任何数字型 UI 参数都可复用，只需传 min/max/step/unit/onCommit。
     */
    function NumberSliderField (props) {
      const { id, label, value, min, max, step = 1, unit = '', description, onCommit, disabled = false } = props
      const [draft, setDraft] = react.useState(String(value))
      react.useEffect(() => { setDraft(String(value)) }, [value])
      const commit = (raw) => {
        const text = String(raw).trim()
        const n = Number(text)
        if (text === '' || !Number.isFinite(n) || n < min || n > max) {
          postNotice('warn', label + ' 未修改', '允许范围 ' + String(min) + '–' + String(max) + unit + '；输入 ' + (text === '' ? '(空)' : text) + ' 超出范围，已拒绝。')
          setDraft(String(value))
          return
        }
        onCommit(n)
      }
      return h('div', { key: id, className: 'dshsh-range-field' }, [
        h('div', { key: 'hd', className: 'dshsh-range-head' }, [
          h('label', { key: 'l', htmlFor: id }, label),
          h('span', { key: 'v', className: 'dshsh-range-val' }, String(value) + unit),
        ]),
        h('div', { key: 'row', className: 'dshsh-range-row' }, [
          h('input', {
            key: 'r', id, type: 'range', min, max, step, value: draft,
            className: 'dshsh-range-slider',
            'aria-label': label,
            disabled,
            onChange: (event) => setDraft(event.target.value),
            onPointerUp: () => commit(draft),
            onKeyUp: (event) => {
              if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) commit(draft)
            },
          }),
          h('input', {
            key: 'n', type: 'number', value: draft, className: 'dshsh-range-num',
            'aria-label': label + ' 手动输入',
            onChange: (event) => setDraft(event.target.value),
            onBlur: () => commit(draft),
            onKeyDown: (event) => {
              if (event.key === 'Enter') { event.preventDefault(); commit(draft) }
              if (event.key === 'Escape') setDraft(String(value))
            },
          }),
          unit === '' ? null : h('span', { key: 'u', className: 'dshsh-range-unit' }, unit),
        ]),
        description === '' || description === undefined ? null : h('p', { key: 'd', className: 'dshsh-cfg-hint' }, description),
      ])
    }

    /** 终端背景色：色板 + 文本输入；提交规则与数字滑块一致（失焦/Enter，非法拒绝并提示）。 */
    function ColorSettingField (props) {
      const { id, label, value, description, onCommit, disabled = false } = props
      const [draft, setDraft] = react.useState(String(value ?? ''))
      react.useEffect(() => { setDraft(String(value ?? '')) }, [value])
      const commit = (raw) => {
        const text = String(raw).trim()
        if (text !== '' && !/^(#[0-9a-fA-F]{3,8}|rgba?\([^;]{1,80}\)|hsla?\([^;]{1,80}\))$/.test(text)) {
          postNotice('warn', label + ' 未修改', '支持空（跟随主题）、#RRGGBB，或 rgb/hsl 的括号写法；输入 ' + text + ' 不合法，已拒绝。')
          setDraft(String(value ?? ''))
          return
        }
        onCommit(text)
      }
      const swatch = /^#[0-9a-fA-F]{6}$/.test(draft) ? draft : '#000000'
      return h('div', { key: id, className: 'dshsh-color-field' }, [
        h('div', { key: 'hd', className: 'dshsh-range-head' }, [
          h('label', { key: 'l', htmlFor: id }, label),
          h('span', { key: 'v', className: 'dshsh-range-val' }, draft === '' ? '跟随主题' : draft),
        ]),
        h('div', { key: 'row', className: 'dshsh-range-row' }, [
          h('input', {
            key: 'c', type: 'color', value: swatch, className: 'dshsh-color-swatch',
            'aria-label': label + ' 色板', disabled,
            onChange: (event) => { setDraft(event.target.value); commit(event.target.value) },
          }),
          h('input', {
            key: 't', id, type: 'text', value: draft, className: 'dshsh-cfg-input dshsh-color-text',
            placeholder: '留空跟随主题，例如 #RRGGBB',
            disabled,
            onChange: (event) => setDraft(event.target.value),
            onBlur: () => commit(draft),
            onKeyDown: (event) => {
              if (event.key === 'Enter') { event.preventDefault(); commit(draft) }
              if (event.key === 'Escape') setDraft(String(value ?? ''))
            },
          }),
          h('button', {
            key: 'r', type: 'button', className: 'dshsh-btn txt', disabled,
            onClick: () => { setDraft(''); commit('') },
          }, '跟随主题'),
        ]),
        description === '' || description === undefined ? null : h('p', { key: 'd', className: 'dshsh-cfg-hint' }, description),
      ])
    }

    /** 组件演示页：数据与渲染分离后的组件候选，先用同一套 token 展示出来供 review。 */
    function UiDemoPage () {
      const [slider, setSlider] = react.useState(42)
      const [color, setColor] = react.useState('')
      const [toggle, setToggle] = react.useState(true)
      const [tab, setTab] = react.useState('基础')
      const [text, setText] = react.useState('terminalkeeper')
      const [select, setSelect] = react.useState('comfortable')
      const card = (title, children) => h('section', { key: title, className: 'dshsh-demo-card' }, [
        h('h3', { key: 'h' }, title),
        ...children,
      ])
      return h('div', { key: 'ui-demo', className: 'dshsh-demo' }, [
        h('div', { key: 'hero', className: 'dshsh-demo-hero' }, [
          h('span', { key: 'b', className: 'dshsh-demo-badge' }, 'UI KIT · PREVIEW'),
          h('h2', { key: 't' }, '组件演示'),
          h('p', { key: 'd' }, '统一使用主题 token：按钮 / 输入 / 滑块 / 颜色 / 开关 / 标签 / 卡片 / 消息。先看外观与交互，再决定重做设置页的最终组件。'),
        ]),
        h('div', { key: 'tabs', className: 'dshsh-demo-tabs', role: 'tablist' },
          ['基础', '表单', '反馈'].map((name) => h('button', {
            key: name, type: 'button', role: 'tab', 'aria-selected': tab === name ? 'true' : 'false',
            className: 'dshsh-demo-tab' + (tab === name ? ' on' : ''),
            onClick: () => setTab(name),
          }, name))),
        h('div', { key: 'grid', className: 'dshsh-demo-grid' }, [
          card('按钮', [
            h('div', { key: 'r1', className: 'dshsh-demo-row' }, [
              h('button', { key: 'p', type: 'button', className: 'dshsh-demo-btn primary', onClick: () => postNotice('info', '主按钮', '这是一个 primary 按钮') }, '主要操作'),
              h('button', { key: 's', type: 'button', className: 'dshsh-demo-btn', onClick: () => postNotice('info', '次按钮', '这是一个 secondary 按钮') }, '次要操作'),
              h('button', { key: 'd', type: 'button', className: 'dshsh-demo-btn danger', onClick: () => postNotice('warn', '危险操作', '演示用，不会删除任何东西') }, '危险操作'),
            ]),
            h('div', { key: 'r2', className: 'dshsh-demo-row' }, [
              h('button', { key: 'g', type: 'button', className: 'dshsh-demo-btn ghost' }, '幽灵按钮'),
              h('button', { key: 'x', type: 'button', className: 'dshsh-demo-btn', disabled: true }, '禁用'),
            ]),
          ]),
          card('文本输入', [
            h('input', { key: 'i', type: 'text', className: 'dshsh-cfg-input', value: text, onChange: (e) => setText(e.target.value), placeholder: '输入文本…' }),
            h('textarea', { key: 'ta', className: 'dshsh-cfg-input', rows: 2, placeholder: '多行输入…', style: { height: '52px', paddingTop: '6px' } }),
            h('select', { key: 's', className: 'dshsh-cfg-select', value: select, onChange: (e) => setSelect(e.target.value) }, [
              h('option', { key: 'a', value: 'compact' }, '紧凑'),
              h('option', { key: 'b', value: 'comfortable' }, '舒适'),
            ]),
          ]),
          card('滑块 + 数字输入', [
            h(NumberSliderField, {
              key: 'slider', id: 'demo-slider', label: '演示数值', value: slider,
              min: 0, max: 100, step: 1, unit: '%',
              description: '拖动滑块或输入数字；越界会拒绝并提示范围。',
              onCommit: (v) => setSlider(v),
            }),
          ]),
          card('颜色', [
            h(ColorSettingField, {
              key: 'color', id: 'demo-color', label: '演示颜色', value: color,
              description: '色板或手动输入；留空表示跟随主题。',
              onCommit: (v) => setColor(v),
            }),
          ]),
          card('开关与标签', [
            h('label', { key: 't', className: 'dshsh-cfg-togglerow' }, [
              h('span', { key: 'l', className: 'dshsh-cfg-togglelabel' }, '启用演示开关'),
              h('input', { key: 'c', type: 'checkbox', className: 'dshsh-cfg-check', checked: toggle, onChange: (e) => setToggle(e.target.checked) }),
            ]),
            h('div', { key: 'chips', className: 'dshsh-demo-row' }, [
              h('span', { key: 'a', className: 'dshsh-demo-chip' }, '默认'),
              h('span', { key: 'b', className: 'dshsh-demo-chip ok' }, '● 正常'),
              h('span', { key: 'c', className: 'dshsh-demo-chip warn' }, '● 注意'),
            ]),
          ]),
          card('卡片与指标', [
            h('div', { key: 'stats', className: 'dshsh-demo-row' }, [
              h('div', { key: 'a', className: 'dshsh-demo-stat' }, [h('b', { key: 'v' }, '2'), h('span', { key: 'l' }, '活跃会话')]),
              h('div', { key: 'b', className: 'dshsh-demo-stat' }, [h('b', { key: 'v' }, '70%'), h('span', { key: 'l' }, '面板不透明度')]),
            ]),
            h('div', { key: 'alert', className: 'dshsh-demo-alert' }, [h('span', { key: 'i' }, 'ⓘ'), h('span', { key: 't' }, [h('b', { key: 'b' }, '提示卡片：'), '用于说明状态或风险']) ]),
          ]),
          card('消息反馈', [
            h('div', { key: 'r', className: 'dshsh-demo-row' }, [
              h('button', { key: 'i', type: 'button', className: 'dshsh-demo-btn', onClick: () => postNotice('info', '信息提示', '消息统一进入右上角提示系统') }, '信息'),
              h('button', { key: 'w', type: 'button', className: 'dshsh-demo-btn', onClick: () => postNotice('warn', '警告提示', '同样进入 /notice 历史') }, '警告'),
              h('button', { key: 'e', type: 'button', className: 'dshsh-demo-btn danger', onClick: () => postNotice('error', '错误提示', '错误也走同一套系统') }, '错误'),
            ]),
            h('span', { key: 'note', className: 'dshsh-cfg-hint' }, '所有提示都会出现在消息条与详情 → 事件记录。'),
          ]),
        ]),
      ])
    }

    function SettingsCard({ view, surface = 'dsh' } = {}) {
      // 用户要求：合成一张设置卡。这里承载「数据清理策略」与「设备密钥」两节。
      // ⚠ 状态初始化刻意用 null 而非 {} —— 客户端夹具用「唯一的空普通对象」定位 draft 单元，
      //    再放一个 {} 会把夹具的启发式定位带偏（这正是上一版三条草稿断言变红的原因）。
      const CATS = [
        { key: 'audit', label: '审计链（执行的命令与输入）' },
        { key: 'output', label: '终端捕获输出 output/' },
        { key: 'snapshots', label: '快照与回放' },
        { key: 'sessions', label: '会话台账' },
        { key: 'notices', label: '提示信息历史' },
        { key: 'vault', label: '引用库 vault.*' },
        { key: 'prefs', label: '偏好与自定义配置' },
      ]
      const retentionIdOf = (key) => 'rc-' + key
      const [retentionPick, setRetentionPick] = react.useState(null)
      const setRetentionPolicy = async (key, policy) => {
        setRetentionPick((prev) => Object.assign({}, prev !== null && typeof prev === 'object' ? prev : {}, { [key]: policy }))
        const ok = await secretsPost('/panel-retention', { action: 'set-policy', key, policy }, '已保存清理策略：' + key + ' → ' + policy)
        if (ok !== true) postNotice('warn', '保存失败：' + key, '数据清理策略未被修改')
      }
      const runRetention = async (action) => {
        const ok = await secretsPost('/panel-retention', { action }, action === 'dry-run' ? '演练完成（未改动任何文件）' : '已按策略执行清理')
        postNotice(ok === true ? 'info' : 'warn', ok === true ? '已执行：' + action : '执行失败', '数据清理策略操作')
      }

      // dsh 0.2.0 的 plugins.row.config 有两种视图：summary = 一行简介；page = 配置表单
      if (view === 'summary') {
        return h('span', null, '终端面板：多会话 / 复用同一 shell / 锁与归属 / 提示与审计复盘')
      }
      const [open, setOpen] = react.useState(true)
      const [settingsGroup, setSettingsGroup] = react.useState('')
      const [settingsQuery, setSettingsQuery] = react.useState('')
      const [state, setState] = react.useState({ status: 'loading', fields: [], note: '', writable: true, error: '' })
      const [draft, setDraft] = react.useState({})
      const [saving, setSaving] = react.useState(false)
      const draftRef = react.useRef({})
      const settingsChannelRef = react.useRef(null)

      const load = react.useCallback(async () => {
        try {
          const response = await fetch(BASE + '/settings')
          const body = await response.json()
          if (body === null || typeof body !== 'object' || !Array.isArray(body.fields)) {
            setState({ status: 'ready', fields: [], note: '', writable: false, error: '设置接口返回异常' })
            postNotice('error', '设置读取失败', '设置接口返回异常')
            return
          }
          setState({ status: 'ready', fields: body.fields, note: String(body.note ?? ''), writable: body.writable === true, error: '' })
          setDraft({})
        } catch (error) {
          setState({ status: 'ready', fields: [], note: '', writable: false, error: String(error && error.message ? error.message : error) })
        }
      }, [])

      react.useEffect(() => { void load() }, [load])

      // 两个前端壳共享后端；保存后通过同页事件 + BroadcastChannel 互相同步。

      react.useEffect(() => {

        const reload = () => { if (Object.keys(draftRef.current).length === 0) void load() }

        let channel = null

        if (typeof BroadcastChannel === 'function') {

          channel = new BroadcastChannel('terminalkeeper:settings')

          channel.onmessage = reload

          settingsChannelRef.current = channel

        }

        window.addEventListener('terminalkeeper:settings-changed', reload)

        return () => {

          window.removeEventListener('terminalkeeper:settings-changed', reload)

          if (channel !== null) channel.close()

          settingsChannelRef.current = null

        }

      }, [load])

      react.useEffect(() => { draftRef.current = draft }, [draft])


      const valueOf = (field) => (Object.prototype.hasOwnProperty.call(draft, field.key) ? draft[field.key] : field.value)
      const mark = (key, value) => {
        setDraft((previous) => ({ ...previous, [key]: value }))
        if (state.error !== '') setState((p) => ({ ...p, error: '' }))
      }
      const dirty = Object.keys(draft).length > 0

      const save = react.useCallback(async () => {
        setSaving(true)
        try {
          const patch = {}
          for (const field of state.fields) {
            if (!Object.prototype.hasOwnProperty.call(draft, field.key)) continue
            const raw = draft[field.key]
            if (field.type === 'boolean') patch[field.key] = raw === true
            else if (field.type === 'number') patch[field.key] = Number(raw)
            else if (field.type === 'array') patch[field.key] = String(raw).split(/[\s,]+/).filter((x) => x !== '')
            else patch[field.key] = String(raw)
          }
          if (Object.keys(patch).length === 0) return
          const response = await fetch(BASE + '/settings', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ patch }),
          })
          const body = await response.json()
          if (response.ok && body?.ok === true) {
            setState((p) => ({ ...p, fields: Array.isArray(body.fields) ? body.fields : p.fields, note: String(body.note ?? '已保存'), error: '' }))
            setDraft({})

            try {

              window.dispatchEvent(new CustomEvent('terminalkeeper:settings-changed', { detail: { source: 'settings-card' } }))

              if (settingsChannelRef.current !== null) settingsChannelRef.current.postMessage({ type: 'changed' })

            } catch { /* 跨窗口同步失败不影响保存 */ }
          } else {
            setState((p) => ({ ...p, error: String(body?.error ?? '保存失败'), note: '' }))
            postNotice('error', '设置保存失败', String(body?.error ?? '保存失败'))
          }
        } catch (error) {
          setState((p) => ({ ...p, error: String(error && error.message ? error.message : error) }))
          postNotice('error', '设置保存失败', String(error && error.message ? error.message : error))
        } finally {
          setSaving(false)
        }
      }, [draft, state.fields])

      // 修改即自动回写：600ms 防抖；失败保留草稿，用户可手动重试。
      react.useEffect(() => {
        if (!dirty || saving || state.status !== 'ready' || state.writable !== true || state.error !== '') return undefined
        const timer = setTimeout(() => { void save() }, 600)
        return () => clearTimeout(timer)
      }, [draft, dirty, saving, state.status, state.writable, state.error, save])

      // 旋转 chevron：与官方 PluginCard 同款（同一个 16×16 路径 + .16s 过渡）
      const chevron = h('svg', {
        className: open ? 'dshsh-cfg-chevron dshsh-cfg-chevron-open' : 'dshsh-cfg-chevron',
        width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': 'true',
      }, h('path', { d: 'M4 6l4 4 4-4', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }))

      const byKey = new Map(state.fields.map((f) => [f.key, f]))
      // 后端下发 group/groupLabel/order；旧宿主没元数据时退回 CARD_GROUP。
      const grouping = (() => {
        const grouped = state.fields.filter((f) => f.custom !== true && typeof f.group === 'string')
        if (grouped.length === 0) return CARD_GROUP
        const order = []
        const map = new Map()
        for (const f of grouped.slice().sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0))) {
          if (!map.has(f.group)) { map.set(f.group, { label: String(f.groupLabel ?? f.group), keys: [] }); order.push(f.group) }
          map.get(f.group).keys.push(f.key)
        }
        return order.map((id) => [map.get(id).label, map.get(id).keys])
      })()
      const groups = grouping.map(([title, keys]) => ({ id: title, label: title, keys }))
      const customGroups = [
        { id: 'demo', label: '组件演示', keys: [] },
        { id: 'retention', label: '数据清理策略', keys: [] },
        { id: 'devkey', label: '设备密钥', keys: [] },
      ]
      const q = settingsQuery.trim().toLowerCase()
      const fieldMatches = (f) => q === '' || (String(f.key) + ' ' + String(f.description ?? '')).toLowerCase().includes(q)
      const groupMatches = (g) => q === '' || String(g.label).toLowerCase().includes(q)
      const customSelected = settingsGroup === 'demo' || settingsGroup === 'retention' || settingsGroup === 'devkey'
      const activeGroup = customSelected ? null : (groups.find((g) => g.id === settingsGroup) ?? groups[0] ?? null)
      const selectedId = customSelected ? settingsGroup : (activeGroup?.id ?? '')
      const visibleGroups = q !== ''
        ? groups.map((g) => ({ ...g, keys: g.keys.filter((k) => { const f = byKey.get(k); return f !== undefined && fieldMatches(f) }) })).filter((g) => g.keys.length > 0 || groupMatches(g))
        : (activeGroup === null ? [] : [{ ...activeGroup, keys: activeGroup.keys.filter((k) => byKey.get(k) !== undefined) }])
      const showRetention = q !== ''
        ? (q.includes('清理') || q.includes('retention') || '数据清理策略'.toLowerCase().includes(q))
        : settingsGroup === 'retention'
      const showDevkey = q !== ''
        ? (q.includes('密钥') || q.includes('devkey') || '设备密钥'.toLowerCase().includes(q))
        : settingsGroup === 'devkey'
      const showDemo = q !== '' ? (q.includes('组件') || q.includes('演示') || q.includes('ui')) : settingsGroup === 'demo'
      const rows = []
      const allGroups = groups.concat(customGroups)
      const moveGroup = (event, index, activate) => {
        const key = event.key
        if (key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'Home' && key !== 'End') return
        event.preventDefault()
        let next = index
        if (key === 'ArrowLeft') next = (index - 1 + allGroups.length) % allGroups.length
        if (key === 'ArrowRight') next = (index + 1) % allGroups.length
        if (key === 'Home') next = 0
        if (key === 'End') next = allGroups.length - 1
        const target = allGroups[next]
        if (target === undefined) return
        activate(target.id)
        const buttons = event.currentTarget?.parentElement?.querySelectorAll('button')
        if (buttons !== undefined) { const el = buttons[next]; if (el !== undefined && typeof el.focus === 'function') el.focus() }
      }
      const settingsTotal = state.fields.filter((f) => f.custom !== true).length
      const shownCount = visibleGroups.reduce((n, g) => n + g.keys.length, 0)
      const settingsSearch = h('div', { key: 'search', className: 'dshsh-u-search dshsh-settings-search' }, [
        h('svg', {
          key: 'i', width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
          strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false',
        }, h('path', { d: 'M11 4a7 7 0 100 14 7 7 0 000-14zM15.5 15.5L21 21' })),
        h('input', {
          key: 'in', type: 'text', className: 'dshsh-u-search-in',
          placeholder: '搜索设置：键名 / 说明 / 分组…', value: settingsQuery,
          onChange: (event) => setSettingsQuery(event.target.value),
          'aria-label': '搜索设置项', autoFocus: surface === 'panel',
        }),
        h('span', { key: 'cnt', className: 'dshsh-u-search-cnt' }, String(shownCount) + '/' + String(settingsTotal)),
      ])
      const settingsNav = h('nav', { key: 'nav', className: 'dshsh-settings-nav dshsh-set-rail', role: 'tablist', 'aria-label': '设置分组' }, allGroups.map((g, gi) =>
        h('button', {
          key: 'g-' + g.id, type: 'button', role: 'tab',
          'aria-selected': selectedId === g.id ? 'true' : 'false',
          tabIndex: selectedId === g.id ? 0 : -1,
          className: 'dshsh-set-nav-item' + (q === '' && selectedId === g.id ? ' on' : ''),
          onClick: () => { setSettingsGroup(g.id); setSettingsQuery('') },
          onKeyDown: (event) => moveGroup(event, gi, (id) => { setSettingsGroup(id); setSettingsQuery('') }),
        }, [
          h('span', { key: 'l', className: 'dshsh-set-nav-label' }, g.label),
          g.keys.length > 0 ? h('span', { key: 'c', className: 'dshsh-set-nav-count' }, String(g.keys.length)) : null,
        ])))
      if (visibleGroups.length === 0 && !showRetention && !showDevkey) {
        rows.push(h('p', { key: 'settings-empty', className: 'dshsh-cfg-hint' }, '没有匹配的设置项（换个关键词）'))
      }
      const renderField = (field) => {
        const value = valueOf(field)
        const fieldId = 'dshsh-cfg-' + field.key
        const label = String(field.label ?? field.key)
        const restart = field.restartRequired !== true ? null : h('span', { key: 'r', className: 'dshsh-cfg-badge' }, '需重启')
        const control = field.control ?? (field.type === 'boolean' ? 'switch' : field.type === 'number' ? 'number' : 'text')
        let input = null
        if (control === 'switch' || field.type === 'boolean') {
          input = h('label', { key: 'v', className: 'dshsh-cfg-togglerow dshsh-set-switch' }, [
            h('span', { key: 's', className: 'dshsh-set-switch-label' }, value === true ? '已开启' : '已关闭'),
            h('input', {
              key: 'c', id: fieldId, type: 'checkbox', className: 'dshsh-cfg-check',
              checked: value === true, disabled: !state.writable,
              onChange: (event) => mark(field.key, event.target.checked),
            }),
          ])
        } else if (control === 'range') {
          const raw = Number(value)
          input = h(NumberSliderField, {
            key: 'v', id: fieldId, label,
            value: Number.isFinite(raw) ? raw : Number(field.min ?? 0),
            min: Number(field.min ?? 0), max: Number(field.max ?? 100),
            step: Number(field.step ?? 1), unit: String(field.unit ?? ''),
            description: String(field.description ?? ''),
            disabled: !state.writable,
            onCommit: (next) => mark(field.key, next),
          })
        } else if (control === 'color') {
          input = h(ColorSettingField, {
            key: 'v', id: fieldId, label, value: value ?? '',
            description: String(field.description ?? ''),
            disabled: !state.writable,
            onCommit: (next) => mark(field.key, next),
          })
        } else {
          input = h('input', {
            key: 'v', id: fieldId, className: 'dshsh-cfg-input dshsh-set-input',
            type: field.type === 'number' ? 'number' : 'text',
            value: value === null || value === undefined ? '' : String(value),
            disabled: !state.writable,
            onChange: (event) => mark(field.key, event.target.value),
          })
        }
        return h('div', { key: field.key, className: 'dshsh-cfg-field dshsh-set-field' }, [
          h('div', { key: 'head', className: 'dshsh-set-field-head' }, [
            h('div', { key: 'title', className: 'dshsh-set-field-title' }, [
              h('label', { key: 'l', className: 'dshsh-cfg-label dshsh-set-field-label', htmlFor: fieldId }, label),
              h('code', { key: 'k', className: 'dshsh-set-field-key' }, field.key),
            ]),
            restart,
          ]),
          input,
          (control === 'range' || control === 'color') ? null : h('p', { key: 'd', className: 'dshsh-cfg-hint' }, String(field.description ?? '')),
        ])
      }
      for (const g of visibleGroups) {
        const fields = g.keys.map((k) => byKey.get(k)).filter((f) => f !== undefined)
        if (fields.length === 0) continue
        rows.push(h('div', { key: 'sec-' + g.label, className: 'dshsh-set-section-head' }, [
          h('h3', { key: 'h' }, g.label),
          h('span', { key: 'c' }, String(fields.length) + ' 项'),
          h('p', { key: 'd' }, String(fields[0]?.sectionDescription ?? '')),
        ]))
        for (const field of fields) rows.push(renderField(field))
      }
      if (showDemo) rows.push(h('div', { key: 'demo', className: 'dshsh-cfg-demo' }, [h(UiDemoPage, { key: 'ui-demo' })]))
      if (showRetention) {
      // ── 数据清理策略（按文件类别）─────────────────────────────────────────────
      //   「关闭插件 ≠ 卸载」：关闭常只是临时不用 ⇒ 数据原样保留、不触发清理；卸载才执行彻底删除。
      rows.push(h('div', { key: 'retention', className: 'dshsh-form-field' }, [
        h('div', { key: 'h', className: 'dshsh-cfg-head' }, [
          h('label', { key: 'l', className: 'dshsh-form-label', htmlFor: retentionIdOf('audit') }, '数据清理策略（按文件类别）'),
        ]),
        h('p', { key: 'note', className: 'dshsh-form-note' },
          '关闭插件 ≠ 卸载：关闭常常只是临时不用 ⇒ 数据原样保留、不触发任何清理；卸载时才执行「彻底删除」策略。按天轮转目前只对审计链生效（更早的按天文件归档到 archive/，不删除）。'),
        ...CATS.map((c) => h('div', {
          key: 'rc-' + c.key, className: 'dshsh-cmenu-row', style: { gap: '8px', alignItems: 'center', marginBottom: '4px' },
        }, [
          h('label', { key: 'l', className: 'dshsh-form-label', htmlFor: retentionIdOf(c.key), style: { flex: '1 1 auto', fontSize: '12px' } }, c.label),
          h('select', {
            key: 's', id: retentionIdOf(c.key), className: 'dshsh-cfg-select', style: { width: '170px', height: '28px' },
            disabled: !state.writable,
            value: (retentionPick !== null && retentionPick[c.key] !== undefined) ? retentionPick[c.key] : 'keep',
            onChange: (event) => void setRetentionPolicy(c.key, event.target.value),
          }, [
            h('option', { key: 'k', value: 'keep' }, '1 保持不变'),
            h('option', { key: 'w', value: 'wipe' }, '2 彻底删除'),
            h('option', { key: 'r', value: 'rotate' }, '3 按天轮转'),
          ]),
        ])),
        h('div', { key: 'btns', className: 'dshsh-form-actions' }, [
          h('div', { key: 'b', className: 'dshsh-form-btns' }, [
            h('button', { key: 'dry', type: 'button', className: 'dshsh-btn txt', disabled: saving || !state.writable, onClick: () => void runRetention('dry-run') }, '演练（不删任何文件）'),
            h('button', { key: 'go', type: 'button', className: 'dshsh-cmenu-go', disabled: saving || !state.writable, onClick: () => void runRetention('apply') }, '立即执行'),
          ]),
          
        ]),
      ]))

      }
      if (showDevkey) {
      // ── 设备密钥（简单混淆用）────────────────────────────────────────────────
      rows.push(h('div', { key: 'devkey', className: 'dshsh-form-field' }, [
        h('div', { key: 'h', className: 'dshsh-cfg-head' }, [
          h('span', { key: 'l', className: 'dshsh-form-label' }, '设备密钥（简单混淆）'),
        ]),
        h('p', { key: 'note', className: 'dshsh-form-note' },
          '每台设备首次使用时自动生成（随机种子 + 机器信息派生），生成后保持唯一、不会自动轮换。手动重新生成时会先用新密钥重新封存所有「简单混淆」组，所以数据不会丢；口令加密组不受影响。⚠ 简单混淆不是安全机制 —— 能读到本机文件的人都能解密，需要保密请用口令加密。'),
        h('div', { key: 'btns', className: 'dshsh-form-actions' }, [
          h('div', { key: 'b', className: 'dshsh-form-btns' }, [
            h('button', {
              key: 'rot', type: 'button', className: 'dshsh-cmenu-go', disabled: saving || !state.writable,
              title: '重新生成设备密钥，并用新密钥重新封存所有「简单混淆」组',
              onClick: () => void secretsPost('/vault-devkey', { action: 'rotate' }, '已重新生成设备密钥（并用新密钥重新封存所有混淆组）').then((ok) => { postNotice(ok === true ? 'info' : 'warn', ok === true ? '已重新生成设备密钥' : '重新生成失败', '设备密钥（简单混淆）'); if (ok === true) loadSecrets() }),
            }, '重新生成设备密钥'),
          ]),
          
        ]),
      ]))

      }
      const summary = state.status === 'loading' ? '正在读取…'
        : state.fields.length + ' 项设置' + (state.writable ? '' : '（只读）')

      const footer = h('div', { key: 'footer', className: 'dshsh-cfg-footer dshsh-set-footer' }, [
        h('p', { key: 'status', className: 'dshsh-cfg-note dshsh-set-save-state' + (dirty ? ' dirty' : '') },
          saving ? '自动保存中…' : (dirty ? '有未保存的改动' : (state.note || '所有改动已保存'))),
        h('button', {
          key: 'discard', type: 'button', className: 'dshsh-cfg-discard dshsh-demo-btn', disabled: !dirty || saving,
          onClick: () => setDraft({}),
        }, '放弃改动'),
        h('button', {
          key: 'save', type: 'button', className: 'dshsh-cfg-save dshsh-demo-btn primary',
          disabled: !dirty || saving || !state.writable,
          onClick: () => { void save() },
        }, saving ? '保存中…' : (dirty ? '立即保存' : '已保存')),
      ])
      const hero = h('div', { key: 'hero', className: 'dshsh-set-hero' }, [
        h('div', { key: 'title', className: 'dshsh-set-hero-title' }, [
          h('h2', { key: 'h' }, '设置'),
          h('p', { key: 'd' }, '所有设置项由各模块登记，统一由这一层显示；改完会自动保存。'),
        ]),
        settingsSearch,
      ])
      const bodyChildren = [
        state.writable ? null : h('p', { key: 'ro', className: 'dshsh-cfg-readonly', role: 'status' },
          '这个部署没有提供设置服务：只能看，不能在这里改（请改用 cordis.patch.yml 的 config）。'),
        hero,
        h('div', { key: 'shell', className: 'dshsh-set-shell' }, [
          settingsNav,
          h('div', { key: 'main', className: 'dshsh-set-main' }, [
            ...rows,
            footer,
          ]),
        ]),
      ]
      if (surface === 'panel') {
        // 面板已有「设置」标题与关闭按钮：去掉折叠卡片头，只保留表体，节省垂直空间。
        return h('div', { key: 'panel-settings', className: 'dshsh-cfg-panel' },
          [h('div', { key: 'body', className: 'dshsh-cfg-body dshsh-cfg-panel-body' }, bodyChildren)])
      }
      // 官方设置页：保留可折叠卡片头（与宿主卡片列表一致）。
      return h('li', {
        className: open ? 'dshsh-cfg-card dshsh-cfg-card-open' : 'dshsh-cfg-card',
      }, [
        h('button', {
          key: 'header', type: 'button', className: 'dshsh-cfg-header', 'aria-expanded': open,
          'aria-label': (open ? '收起' : '展开') + '：持久化 shell',
          onClick: () => setOpen((previous) => !previous),
        }, [
          h('span', { key: 't', className: 'dshsh-cfg-headtext' }, [
            h('span', { key: 'name', className: 'dshsh-cfg-name' }, '持久化 shell'),
            h('span', { key: 'desc', className: 'dshsh-cfg-desc' }, summary),
          ]),
          dirty ? h('span', { key: 'pending', className: 'dshsh-cfg-pending' }, saving ? '自动保存中…' : '未保存') : null,
          chevron,
        ]),
        open ? h('div', { key: 'body', className: 'dshsh-cfg-body' }, bodyChildren) : null,
      ])
    }

    const inject = ['slots']

    function apply(ctx) {
      // 注入面板样式；随插件卸载一并移除
      ctx.effect(() => {
        const existing = document.getElementById(CSS_ID)
        if (existing !== null) existing.remove()
        const style = document.createElement('style')
        style.id = CSS_ID
        style.textContent = PANEL_CSS
        document.head.appendChild(style)
        return () => {
          const mine = document.getElementById(CSS_ID)
          if (mine !== null) mine.remove()
        }
      }, 'terminalkeeper: panel stylesheet')

      // ── 官方快捷键系统（0.4.0：优先接入官方，而不是自己监听键盘）──────────────
      // 用 Cordis 的**按需注入**：宿主没有 shortcuts 服务时这段直接不激活，
      // 面板其余功能不受影响（自研的 Ctrl+Shift+S 降级路径继续可用）。
      try {
        if (typeof ctx.inject === 'function') {
          ctx.inject(['shortcuts'], (scoped) => {
            scoped.effect(() => {
              let disposeCmd = null
              try {
                disposeCmd = scoped.shortcuts.register(shellPanelShortcut(() => {
                  if (typeof shellPanelToggle === 'function') shellPanelToggle()
                }))
              } catch (err) {
                // 注册失败通常是"与官方命令的默认值重叠"或"该组合被保留"—— 打出来便于定位；
                // 同时保持 live=false，自研的 Ctrl+Shift+S 继续兜底（面板始终能开合）。
                postNotice('warn', '快捷键注册失败，已回退内置键位 · 错误码 ' + UI_ERR.SHORTCUT, String(error && error.message ? error.message : error))
        console.warn('[terminalkeeper] 快捷键注册失败（已回退内置键位）：',
                  err && err.message ? err.message : String(err))
              }
              // ⚠ 注册成功 ≠ 生效：宿主还要看偏好是否读完、组合有没有 issue/冲突
              // （catalog 行的 binding 为 null 或 issue/conflicts 非空时，这个键是不响应的）。
              // 所以订阅 catalog，只有**官方这条真的可用**时才让自研的 Ctrl+Shift+S 让位 ——
              // 否则会出现"两边都不响应"（实测踩到过）。
              const sync = () => {
                const rows = scoped.shortcuts.catalog !== undefined ? scoped.shortcuts.catalog.getSnapshot() : []
                const row = Array.isArray(rows) ? rows.find((r) => r.id === 'terminalkeeper.panel.toggle') : undefined
                const live = row !== undefined && row.binding !== null && row.issue === null
                  && Array.isArray(row.conflicts) && row.conflicts.length === 0
                shellPanelShortcutLive = live
                shellPanelShortcutKeysText = live && Array.isArray(row.keys) && row.keys.length > 0 ? row.keys.join('+') : null
                notifyShellShortcut()
              }
              sync()
              let unsubscribe = null
              try {
                if (scoped.shortcuts.catalog !== undefined && typeof scoped.shortcuts.catalog.subscribe === 'function') {
                  unsubscribe = scoped.shortcuts.catalog.subscribe(sync)
                }
              } catch { /* 订阅失败：至少注册当时同步过一次 */ }
              return () => {
                if (typeof unsubscribe === 'function') unsubscribe()
                shellPanelShortcutLive = false
                shellPanelShortcutKeysText = null
                notifyShellShortcut()
                if (typeof disposeCmd === 'function') disposeCmd()
              }
            }, 'terminalkeeper: panel toggle shortcut')
            return undefined
          })
        }
      } catch { /* 宿主不支持按需注入 → 保留自研降级路径 */ }

      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'terminalkeeper-panel',
        order: 20,
      }, PanelSurface))


      // 设置卡片：不注册它，设置页里就永远没有这一项（见 SettingsCard 上方的注释）。
      // 插槽不存在时安静跳过 —— 老版本 DSH 没有这个插槽，不该因此让整个客户端插件失败。
      try {
        // 只挂 bundle 层（与官方 bundle 的布局一致）：row 层再挂一份会出现两个自绘设置菜单（用户反馈重复）。
        // bundle 层配置入口（DOM 实测：宿主用 entryKey = pkg.name 渲染该槽位，
        // 因此 key 取包名即可；之前并列注册 include:<行id> 是探索期的冗余，已删）。
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register(
          { name: 'plugins.bundle.config', id: 'terminalkeeper', key: 'terminalkeeper' },
          SettingsCard,
        ))
      } catch (error) {
        postNotice('error', '设置卡片没注册上 · 错误码 ' + UI_ERR.SETTINGS_CARD, String(error && error.message ? error.message : error))
    console.error('terminalkeeper: settings card not registered: ' + String(error && error.message ? error.message : error))
      }
    }

    // `__decideKey` / `__decideComposition` 是**纯函数**，只为离线验证暴露（浏览器不使用）：
    // 输入法的分支没法在无 DOM 的环境里真跑，只能靠对这两个纯函数做断言来覆盖。
    return {
      apply,
      inject,
      name: 'terminalkeeper',
      __decideKey: decideKey,
      __softKeyToken: softKeyToken,
      __mouseCellFromPoint: mouseCellFromPoint,
      __mouseCellFromPanel: mouseCellFromPanel,
      __mouseButtonName: mouseButtonName,
      __mouseWheelButton: mouseWheelButton,
      __softModAction: softModAction,
      __softKeyLabel: softKeyLabel,
      __decideComposition: decideComposition,
      __timeAgoText: timeAgoText,
      __consentStatusChip: consentStatusChip,
      __consentReviewText: consentReviewText,
      // ⓘ 详情层的内容组装与文本导出都是纯函数 —— 缺字段的组合可以在测试里穷举
      // 组件本身也暴露出来：测试里用「假 React」把它渲染一遍并调用每个事件处理器，
      // 这是唯一能抓住「某个 helper 忘了定义 / 某处读了 null」这类只在打开面板时才炸的错误的手段。
      __ShellPanel: ShellPanel,
      __settingsRowValue: settingsRowValue,
      __auditRowValue: auditRowValue,
      __captureRowValue: captureRowValue,
      __tmuxRowValue: tmuxRowValue,
      __modeLabel: modeLabel,
      __prettyPath: prettyPath,
      __planColumnWidths: planColumnWidths,
      __resolveLineHeight: resolveLineHeight,
      __charCellWidth: charCellWidth,
      __cellsToCharIndex: cellsToCharIndex,
      __caretPlacement: caretPlacement,
      __shouldShowCaret: shouldShowCaret,
      __measurePrefixWidth: measurePrefixWidth,
      __trailingCellGap: trailingCellGap,
      __charCellsOf: charCellsOf,
      __cellsToCharIndex: cellsToCharIndex,
      __UI: UI,
      __prefixRangeOffsets: prefixRangeOffsets,
      __caretStyle: caretStyle,
      __SettingsCard: SettingsCard,
      __CARD_GROUP: CARD_GROUP,
      __closeActionFor: closeActionFor,
      __headCompact: headCompact,
      __needsPaste: needsPaste,
      __searchMatches: searchMatches,
      __batchSummary: batchSummary,
      __splitHighlight: splitHighlight,
      __consentButtonModel: consentButtonModel,
      // 权限浮层的模式/能力模型（可行为测试）
      __consentOverviewModel: consentOverviewModel,
      // 授权页候选列表的过滤模型（子 agent 默认排除）
      __actorListModel: actorListModel,
      // 日志总体统计模型（可行为测试）
      __logStatsModel: logStatsModel,
      __consentOverviewModel: consentOverviewModel,
      __actorListModel: actorListModel,
      __logFileModel: logFileModel,
      __tableModel: tableModel,
      __consentEntryRows: consentEntryRows,
      __consentRemainingLabel: consentRemainingLabel,
      __consentTtlSeconds: consentTtlSeconds,
      __consentSummaryText: consentSummaryText,
      __closeButtonModel: closeButtonModel,
      __fenceRowValue: fenceRowValue,
      __fenceRowTitle: fenceRowTitle,
      __settingsRowTitle: settingsRowTitle,
      __scrollAnchor: scrollAnchor,
      __contentShift: contentShift,
      __pillModel: pillModel,
      __sessionBusy: sessionBusy,
      __infoRows: buildInfoRows,
      __infoText: infoRowsToText,
      __shellPanelShortcut: shellPanelShortcut,
      __shellPanelShortcutKeys: shellPanelShortcutKeys,
      __shellPanelShortcutLive: () => shellPanelShortcutLive,
      __decidePanelKey: decidePanelKey,
      __decideKey: decideKey,
      __infoCardOf: INFO_TAB_OF,
      __infoTabs: INFO_TABS,
      __writeClipboard: writeClipboard,
      __startupFlowModel: startupFlowModel,
      __replayDelay: replayDelay,
      __replayClock: replayClock,
      __parseAnsi: parseAnsi,
      __renderScreenLines: renderScreenLines,
      __sgrStyleToCss: sgrStyleToCss,
      __colorValue: colorValue,
    }
  },
})
