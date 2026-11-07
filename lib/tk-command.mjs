/**
 * `/tk` 命令语法（宿主命令 / CLI/TUI）的纯解析层。
 *
 * 设计：**名词 + 动词 + 长选项**，不使用短选项或位置歧义。
 *   tk vault group list
 *   tk vault key set KEY --group G --value-file PATH
 * 秘密值/口令**不得**出现在命令行；只接受文件路径，避免进入会话日志与审批文本。
 * 这里只解析，不执行任何 I/O。
 */

const BOOLEAN_OPTIONS = new Set(['yes', 'no-persist', 'no-submit', 'reuse', 'cascade'])

export const TK_USAGE = [
  'terminalkeeper 命令（/tk）',
  '',
  '  tk help',
  '  tk status',
  '',
  '  tk vault group list',
  '  tk vault group create <name> [--mode none|obfuscate|passphrase] [--passphrase-file PATH] [--no-persist]',
  '  tk vault group mode <name> none|obfuscate|passphrase [--passphrase-file PATH]',
  '  tk vault group persist <name> on|off',
  '  tk vault group rename <old> <new>',
  '  tk vault group delete <name> [--cascade] --yes',
  '  tk vault group unlock <name> [--passphrase-file PATH]',
  '  tk vault group lock <name>',
  '  tk vault key list [--group NAME]',
  '  tk vault key get <key> [--group NAME] [--to-file PATH --yes]',
  '  tk vault key set <key> [--group NAME] --value-file PATH [--note TEXT] [--max-uses N] [--expires-at ISO] [--kind TYPE] [--reuse]',
  '  tk vault key move <key> --from <group> --to <group>',
  '  tk vault key delete <key> [--group NAME] --yes',
  '',
  '  tk shell list',
  '  tk shell show <id>',
  '  tk shell new [--label NAME] [--cwd PATH] [--cols N] [--rows N] [--idle-minutes N] [--from ID]',
  '  tk shell rename <id> <new-label>',
  '  tk shell resize <id> <cols> <rows>',
  '  tk shell close <id> --yes',
  '  tk shell lock <id> [--note TEXT]',
  '  tk shell unlock <id>',
  '  tk shell snapshot <id>',
  '  tk shell snapshot-list',
  '',
  '  tk watchdog status',
  '  tk watchdog set [--enabled on|off] [--grace-ms N] [--renew-ms N] --yes',
  '  tk watchdog start|stop|restart --yes',
  '',
  '  tk settings list',
  '  tk settings get <key>',
  '  tk settings set <key> <value> [--yes]',
  '',
  '  tk audit files',
  '  tk audit chain',
  '  tk audit notices [--limit N]',
  '',
  '  tk macro list',
  '  tk macro set <key> --text-file PATH [--scope conversation|global|shell] [--session ID] [--no-submit] [--note TEXT]',
  '  tk macro remove <key> --yes',
  '',
  '  tk workspace list',
  '  tk workspace save <name> [--sessions id1,id2|*]',
  '  tk workspace restore <name>',
  '  tk workspace delete <name> --yes',
  '',
  '安全：value/passphrase 只通过 --value-file / --passphrase-file 读取，绝不接收为位置参数；\n命令和参数本身会进入会话/模型上下文，秘密值不要写在命令行。',
].join('\n')

export function parseTkCommand (input) {
  if (String(input ?? '').length > 4096) return { ok: false, error: '命令过长（>4096 字符）' }
  const tokens = tokenize(String(input ?? ''))
  if (!tokens.ok) return { ok: false, error: tokens.error }
  const words = tokens.words
  if (words.length > 128) return { ok: false, error: '参数过多（>128 个词）' }
  if (words.length === 0) return { ok: true, path: [], args: [], options: {}, error: '' }
  const opts = {}
  const args = []
  let endOptions = false
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i]
    if (!endOptions && w === '--') { endOptions = true; continue }
    if (!endOptions && w.startsWith('--')) {
      const eq = w.indexOf('=')
      const name = eq >= 0 ? w.slice(2, eq) : w.slice(2)
      if (name === '') return { ok: false, error: '空选项名' }
      if (!/^[a-z][a-z0-9-]*$/.test(name)) return { ok: false, error: '非法选项：--' + name }
      let value
      if (eq >= 0) value = w.slice(eq + 1)
      else if (BOOLEAN_OPTIONS.has(name)) value = true
      else {
        const next = words[i + 1]
        if (next === undefined || next.startsWith('--')) return { ok: false, error: '选项 --' + name + ' 缺少值' }
        value = next
        i += 1
      }
      if (Object.prototype.hasOwnProperty.call(opts, name)) return { ok: false, error: '选项重复：--' + name }
      opts[name] = value
      continue
    }
    args.push(w)
  }
  const domain = args.shift() ?? ''
  const verb = args.shift() ?? ''
  return { ok: true, domain, verb, args, options: opts, error: '' }
}

/** Shell-like tokenizer：双引号/单引号/反斜杠；不做变量展开。 */
export function tokenize (input) {
  const words = []
  let cur = ''
  let quote = ''
  let escaped = false
  let started = false
  const text = String(input ?? '')
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (escaped) { cur += ch; escaped = false; started = true; continue }
    if (ch === '\\' && quote !== "'") { escaped = true; started = true; continue }
    if (quote !== '') {
      if (ch === quote) { quote = ''; continue }
      cur += ch; continue
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue }
    if (/\s/.test(ch)) {
      if (started === true) { words.push(cur); cur = ''; started = false }
      continue
    }
    cur += ch; started = true
  }
  if (escaped) return { ok: false, error: '命令以反斜杠结尾' }
  if (quote !== '') return { ok: false, error: '引号未闭合' }
  if (started === true) words.push(cur)
  return { ok: true, words }
}

export function intOption (value) {
  if (!/^[0-9]+$/.test(String(value ?? ''))) return null
  const n = Number(value)
  return Number.isSafeInteger(n) ? n : null
}

export function flagOption (value) {
  const v = String(value ?? '').toLowerCase()
  if (v === 'on' || v === 'true' || v === '1') return true
  if (v === 'off' || v === 'false' || v === '0') return false
  return null
}
