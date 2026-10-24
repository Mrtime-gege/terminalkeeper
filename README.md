# terminalkeeper

> **文档状态（2026-10-21）**：公开版本 **0.1.0**；当前行为以 `docs/项目文档.md` 与代码为准。


> **📖 当前权威文档（2026-10 重写）**：[`docs/项目文档.md`](https://github.com/Mrtime-gege/terminalkeeper/blob/main/docs/项目文档.md) —— 架构、工具参数、面板、审计与镜像、安全边界、**已知限制/无法检测项**。
> 参数逐项参考：[`docs/工具参数手册.md`](https://github.com/Mrtime-gege/terminalkeeper/blob/main/docs/工具参数手册.md)；发布门禁：[`docs/PUBLISHING.md`](https://github.com/Mrtime-gege/terminalkeeper/blob/main/docs/PUBLISHING.md)；首次可用标准：[`docs/首次可用标准.md`](https://github.com/Mrtime-gege/terminalkeeper/blob/main/docs/首次可用标准.md)。

> **公开版本 0.1.0**（全新公开身份，从 0.1.0 开始，不保留历史版本线）。

## 🙋 作者的话

**一个人的业余项目，与任何官方无关。** 节奏受现实约束（主业/健康/费用），**没有 SLA、没有付费支持**。所以：① 关键场景自备回退；② 升版前扫一眼 [CHANGELOG](https://github.com/Mrtime-gege/terminalkeeper/blob/main/README 的「当前版本」)；③ MIT，风险自负（下面风险清单务必读完）。帮到你了的话，一个 star 就是最实在的支持。

## ⚠️ 风险，先读清楚再决定装不装

**这工具能把你的机器交给 AI。** 它不是玩具，也不是"受限执行环境"。

1. **由 AI 开发，无人审计**——自动化测试 + 真机验证有，人工安全审计没有。
2. **授权 = 任意命令**——一个对话被授权后，它的 AI 以**你自己的用户权限**读写一切；本插件**没有任何审批防护**，不会逐条问你。彻底关审批需显式 `requireConsent:false`（等于放弃防线）。
3. **不负责后果**——误删、提示词注入带偏、凭据被读到终端里，后果自负。
4. **唯一防线只是启发式护栏**——`guardDangerousCommands` 关键词匹配（`rm -rf /`、`mkfs`、`dd of=/dev/*` 等）；可被变量/脚本/拼接轻易绕过，也会误报。**它是减速带，不是防护。**
5. **审计 =「可检测篡改」不是「不可篡改」**（默认）——哈希链能发现删/改/调序，但同权限的 AI 本就能改审计文件；要内核级防删改跑 `./install-deps.sh --audit-lock`（`chattr +a`）。
6. **ssh/远程只有「录像级」审计**——记的是进出隧道的键与屏，不是远端实际执行了什么。
7. **闲置回收默认关**（0.3.0 起 = 会话永久保留）——只在显式启用 `idleClose` 或单会话 `idleMinutes` 后才到点关闭并记审计；只读屏/查询不算活动。
8. **整机重启会丢会话**——`dsh` 自身重启存活（systemd scope），但整机/WSL2 虚机关机连 tmux 一起带走。重要工作先落盘。
9. **不要放进生产/多用户/有不可替代数据的机器**；平台**仅 Linux**（Windows 用 WSL2，macOS 不支持）。

> 别在终端里长期输入真凭据——留痕是**如实记录**的（密码提示会自动脱敏，但其它明文输出不保证）。

## 一条命令安装

先决条件：**Linux**（含 WSL2/容器）、Node ≥ 20、运行的 DSH（0.1.5+）。

```sh
npx -y terminalkeeper install [--profile web]
```

依次：登记进 profile → 装依赖 → 检查 tmux → 提示重启 `dsh web`。配套：`--dry-run` 预览；`doctor` 体检；`uninstall` 反向移除。

## 它是什么

- 私有 tmux 服务端持有多个**持久 shell**：关页面、换对话、热重载、重启 DSH 都不丢。
- **7 个模型工具**：`shell_open / shell_run / shell_send / shell_read / shell_manage / shell_state / shell_audit`；等待用 `wait`（`none/idle/match/exit/file/noproc/cpu`），护栏跳过用 `safety.bypassGuard`、预演用 `safety.dryrun`，寻址用**稳定 id**（名字只是可改的 label）。
- 面板（右下角胶囊）= 真终端：`sudo` 提示、`vim` 全屏、REPL、补全、历史全都通。**0.3.4 起显示完全复刻真实终端**——颜色/背景/加粗/反显/真彩（SGR 渲染）逐段呈现、光标常显（坐标来自 tmux 实测，中文/emoji 单元格换算正确）；0.3.3 起的抓屏 SSE 推送（输入当刻回显，断线退回轮询）、🎬 帧回放（`replayCapture` 默认开（设置页可关），逐帧回看"刚才实际发生了什么"）。0.3.4 面板内搜索（Ctrl+F 高亮跳转）+ 批量操作（勾选多壳重开/统一尺寸/锁定/关闭）。
- **审计一条链管全部**：工具调用/输入键/开关改名/授权/锁定/接管/宏与秘密操作/闲置/设置变更/手动删除（purge）……全部事件在 `audit-YYYY-MM-DD.jsonl` 逐条封链（SHA-256 串接），删一条/改一字节/调顺序 → 断链即报警（事件全表见 SECURITY）。**0.3.4 起用户可手动管理日志与审计文件**（面板 🪵 日志管理浮层 / CLI `purge-audit` / `POST /audit-files`）——删除动作本身先入链见证（`event:purge` + 文件名 + sha256），"销毁过什么"永远可证。

## 什么时候值得用它

**交互式程序**（`sudo`/`ssh`/`vim`/`gdb`/REPL——真 TTY 全通）· **长任务**（shell 常驻，路径/历史/环境一直在，不用反复起进程）· **要查账**（谁在什么时候让 shell 干了什么：审计链封链 + 🎬 帧回放，断链即报警）。

## 快速上手

> 规则提醒：同一 shell 在一次调用里只能被操作一次（多任务需拆成多次调用）。

装好重启 → 右下角出现胶囊 **`>_ N 🔒`**；点 **＋** 新建 shell（或让 AI `shell_open`）。面板点锁即直接打字；AI 用 `shell_run` 发命令、`shell_state` 看会话。每个对话**首次**用工具会请你授权一次，之后正常用。

## 人机双接管（一句话版）

AI 的终端就是普通 tmux 会话（私有 socket `-L terminalkeeper`）：**你** `tmux -L terminalkeeper attach -t dsh-xxxx` 随时进去接手，想让 AI 彻底放手就说「release」；**你在同一 socket 建的壳**（务必 `-s 带名字`），AI 可读可写；想让它接手就明确说“操作 dsh-xxxx”。**秘密**（vault）值不过 AI 之手——AI 只能做**整条裸引用** `{{v:键}}`（喂 stdin 提示的形态，嵌进命令会被拒）；面板里按「剩余可用次数」定额度，1 = 一次性；**宏**（`{{m:名}}`）沉淀重复命令、写入全量入链。完整操作与规则见 [docs/使用细节.md「人机双接管完全指南」](https://github.com/Mrtime-gege/terminalkeeper/blob/main/docs/使用细节.md)。

## 功能开关与彻底清理

- 设置页「功能开关」默认全开；关闭只停用能力/页面，不改配置，详情页对应页签隐藏，右上角显示「功能已禁用」。
- 详情 → 状态 → 运行 → **它是怎么工作的**：说明 DSH 内/外资源与禁用/卸载边界。
- 彻底清理：`node purge-all.mjs`（默认 dry-run）→ 确认后 `--yes`。会清除本插件数据目录、私有 tmux、supervisor/watchdog 与 profile 包；自定义审计镜像需显式 `--mirror`。

## 安全边界（能挡什么、挡不住什么）

- 确认门一次过后**不再问**：防手滑与静默启动，不防蓄意 agent——**原生 bash 能绕过本插件做它想做的一切**，任何"只在插件通道内生效"的防护都只是对这条通道的礼貌。
- **人机互斥**：面板解锁 = 人在操作，AI 对该 shell 的修改一律让路（只读不受影响）；解锁/上锁记审计。
- **能力降级如实说**：无 systemd → 会话不随 `dsh` 重启存活；无 `/proc` → 嵌套 tmux 忙闲判定退化——每句人话，`shell_state`/面板 ⓘ/`/diagnose` 可查。
- 完整安全模型以 [docs/SECURITY.md](https://github.com/Mrtime-gege/terminalkeeper/blob/main/docs/SECURITY.md) 为准（随包发布）。

## 宿主版本现状（dsh，明确说明）

> 发布门禁：发版前按 `docs/长任务测试.md` 跑真实环境长任务测试。

本插件的宿主是 DeepSeek Harness（`dsh`），两者版本需放在一起看：

- **当前兼容范围**：dsh **`0.1.5-rc.1` 至 `0.2.0-rc.2`**。本插件在这两档上均完成回归（`npm test` + 长任务套件全绿）。
- **0.2.0 适配结论（2026-10-02 实测，10-04 复检）**：宿主升级到 0.2.x **无需重新安装插件**——peer（`dsh-tools`/`cordis`/`schemastery`）由宿主进程注入、不走 npm 安装校验；运行时实测 `defineTool` 导出与契约不变、Cordis `ctx.get/inject/slots` 注入面未变、schemastery settings 注册兼容。实机 dsh web 日志确认插件 `startup ready` + 看门狗接管，无加载错误。
- **0.2.0 曾踩的坑（已修）**：10-04 宿主升 0.2.0 后插件一度**不加载**（面板胶囊消失、shell_* 工具全无）——根因是 0.2.0 新增的**兼容闸**（`dsh-app-boot#evaluatePluginCompatibility`）装配时检查 peerDependencies 里的 `@deepseek-ai/dsh-*` 是否 `semver.satisfies(运行时)`，旧声明 `dsh-tools ^0.1.2-rc.1` ✗ 不含 `0.2.0-rc.2` → 静默跳过插件。修法：plugin peer 放宽为 `^0.1.2-rc.1 || ^0.2.0-rc.2`（同时满足 0.1.2/0.1.5/0.2.0）+ profile `compatibility.json` 补 `terminalkeeper@0.4.x → [0.2.0-rc.2]` 豁免。**升级 dsh 后插件消失时先查这个**。
- **升级核对动作（任何时候升 dsh 都该做）**：重跑 `scripts/test-longrun.mjs`（真实 tmux 长任务/并发/工具链；规范见 `docs/项目文档.md` §9）+ 面板实机回归（挂载/参数设置/授权浮层/日志管理），以套件绿灯为准。

## 当前版本（0.1.0）

- **审计防篡改**：逐天哈希链 + Ed25519 签名检查点链 `checkpoints.jsonl`；可选镜像（`auditMirror`）。
- **面板详情**：8 个页签（总览 / 概览 / 运行 / 安全 / 事件记录 / 引用库事件 / 日志审计 / 键位帮助）。
- **订阅注入**：多壳 `本轮 N 个 shell` + `━━━ [i/N] 壳名 · +行数 ━━━` 强分隔。
- **近期修复**：会话选择滚动条；`wait.kind=exit` 不可包装命令发送前拒绝；嵌套 ssh 退出标记兜底；CLI 自动读 `auditMirror`；`bypassGuard` 必须带 reason、`count` 1–64、`shell_send.text` 拒绝换行。
- **文档**：从 0.1.0 重新开始，不再保留历史版本/踩坑文档。

## 界面设计（0.1.0）

面板这一轮的界面约定，都写在下面——想改哪一处，先看这里的规则。

### 菜单（下拉浮层）

- **统一壳**：所有菜单共用同一只壳（标题 / 徽标 / 页签 / 操作按钮），观感一致。
- **宽度**：详情 **406px** · 会话选择 **442px** · 授权管理 / 引用库 / 日志 **541px**；都按视口约束，允许比面板宽。
- **上下边界实测对齐**：上边界 = 面板内容上边界（实测头部高度），下边界 = 状态栏上方（实测状态栏 + 输入行高度）；内容不足按实际高度显示，超出则内部滚动（滚动条可见）。
- **子页签**：授权管理（会话授权 / 默认授权）、引用库（秘密域 / 宏命令）、日志（审计文件 / 输出留痕）、详情（会话 / 订阅 / 审计与镜像 / tmux 服务端 / 插件状态 / 安全审批状态 / 提示信息 / 键事件）行状态 / 安全与审批 / 提示信息）。

### 列表（所有需要排序/筛选的地方）

固定**三部分**，自上而下：

1. **筛选行**：一行平铺不换行——**左侧是所有可筛选的键**（每个键一个下拉，选中即过滤），**右侧是搜索框**；筛选键由列定义自动生成。
2. **表头**：列出全部相关列（键名 / 类型 / 备注 / 时间 / 归属…），**末尾是操作列**（删除等）；点表头切换升 / 降序。
3. **显示区**：一行一条数据，**不换行、不简写**，放不下用省略号标记（悬停看完整值）；**行高固定 30px 且与表头严格一致**。

**列宽**：自适应分配，并可**拖动表头右缘**手动调整；按表记住（刷新仍在）。筛选值同样持久化。

### 分区与显示策略

- **默认整块高度给表格**；点选一项后，下方才弹出详情 / 配置（授权管理、日志）。
- **引用库**：**上方是新增 / 更新表单**（常驻平铺的卡片，自适应网格），**下方是已有键值表格**。
- **详情**：页签式（会话 / 订阅 / 审计与镜像 / tmux 服务端 / 插件状态 / 安全审批状态 / 提示信息 / 键事件）。版本与构建信息在「服务端」，**面板自己的快捷键**在「会话」——0.4.0 起不再单独设「界面与能力」页（tmux 原生键与宿主机键属 tmux/DSH 文档，不占面板）

### 视觉层级与窗口对齐

- **页签**：未选中也有**可见的底与边框**（弱），选中是**绿色描边 + 实底 + 加粗** —— 一眼看出"我在哪一页"。
- **头部按钮**：浮层打开时按钮带绿色包裹（详情 / 日志 / 引用库 / **授权管理**都一样；授权管理此前漏了这个标记）。
- **双击右下角的拖拽标记**：把面板尺寸对齐到**当前 shell 的真实 `cols × rows`**（来自 `/screen` 的 `meta`），
  目的是**不再出现横向滚动条**、周围按钮跟着排好；尺寸**只增不减**，绝不会把已经够用的显示区缩小。

### 视觉层级与窗口对齐（续）

- **页签**：未选中也有**可见的底与边框**（弱），选中是**绿色描边 + 实底 + 加粗**。
- **表头吸顶**：列表滚动时表头固定在顶部（`position: sticky`），不会跟着内容滚走。
- **表格列宽永不溢出**：拖动列宽存的是**表宽百分比**并归一化到 100%（拖宽一列，其余列按比例让位），
  旧版存的像素值直接忽略 —— 面板变窄也不会冒出横向滚动条。
- **双击右下角的拖拽标记**：把面板对齐到当前 shell 的真实 `cols × rows`（不再弹提示）。
  对齐是**幂等**的：chrome 差量只测一次并固化，连点多次尺寸不变；宽度再按**真实溢出**迭代补偿一次，
  确保显示区下方不再挂横向滚动条。

### 日志审计

- **两个子页面（审计文件 / 输出留痕）** 都是「上列表、下详情」：**默认整块高度给列表**，点选一项后下方弹出详情；
  详情用 `rightFit` **按内容全量显示**（不压缩、不出自己的滚动条），列表吃剩余空间。
- **详情加载分两段**：先取"快的那一半"（服务端只读文件**头尾各 8KB** → 开头 / 结尾 / 字节数立刻可见），
  行数与事件统计随后用 `?stats=1` 在后台补齐（结果按 `size+mtime` 缓存，同一文件再看秒回；
  客户端也缓存，来回点列表不再往返）。不再出现十几秒的「读取详情…」。

### 快捷键

- **面板内**（焦点在面板里才生效，不抢 DSH 与终端的键）：`Ctrl+F` 面板内搜索 · `F2` 重命名当前 shell ·
  `Esc` 关浮层（无浮层时照旧送终端）· `Ctrl+Shift+↑/↓` 上一个 / 下一个 shell ·
  `Ctrl+Alt+/` 开合面板（**已注册进官方快捷键系统**，可在「设置 → 通用 → 快捷键」里改）。
- **开合面板没有内置降级键**：它只走官方系统；官方那条若不生效（被占用 / 偏好未就绪），
  详情页会**如实说明**并给出改键位置，不会再塞一套"第二键位"。
- **详情页只记录面板自己的快捷键**（详情 → **会话**）：切换 shell / 重命名 / 面板内搜索 / 关浮层 共 4 条。终端键位、tmux 原生键、DSH 宿主机键**不再列在面板里**（属 tmux 与 DSH 文档，0.4.0 移出界面）。
  **tmux 直通** · **DSH 宿主键位（我们避让的）** 四组，共 60+ 条。
- **终端键一律不抢**：bash / PowerShell(PSReadLine) 的 Ctrl 组合、Alt 组合、`F7`，以及 tmux 的 `Ctrl+B` 前缀
  都原样送进终端；其中 `Ctrl+W/T/N` 做了面板级兜底（否则会被浏览器当成关标签页 / 新标签页 / 新窗口）。
- **tmux 原生能力直接可用**：`Ctrl+B` 后接 `"` `%` `c` `z` `[` `?` 等（属 tmux 自身文档；面板 0.1.0 起不再重复列出）。

### 性能约定

- 打开菜单：**空闲预热**列表数据 + **缓存优先**（有缓存就立即渲染，后台静默刷新）→ 首次打开从秒级降到 ~30ms。
- 面板尺寸测量走 **ResizeObserver**（不再每秒轮询），只在展开 / 开浮层等时机强制测一次。

### 主题

全部颜色走 DSH 主题令牌（`--dsw-alias-*` / `--dsw-specific-menu` / `--dsw-elevation-*`），跟随宿主明暗主题，无硬编码 UI 色。

## 出错时先看错误码

界面提示统一按「人话（错误码 X）」展示：人话解释发生了什么，错误码用来快速定位与检索。
所有提示（成功 / 警告 / 错误）都走同一套自制消息系统 —— 右上角消息条 + 详情「事件记录」里的 `/notice` 历史，
不使用原生 `alert`/`confirm` 弹窗；表单里的即时错误也通过同一入口（`setError → notify`），不会再出现“两个出口”。
宿主返回的码（`TMUX_FAILED`、`REFUSED`、`BAD_METHOD` 等）**原样保留**，不翻译。

| 错误码 | 含义 | 常见处置 |
|---|---|---|
| `DSH_UNREACHABLE` | 连不上 DSH | 看 `dsh web` 是否在跑、端口是否通、SSH 隧道是否断开 |
| `DSH_TOO_OLD` | 插件比 DSH 新，接口不存在 | 重启 `dsh web`，让插件与宿主版本对齐 |
| `ACTION_FAILED` | 操作被拒绝或异常 | 提示后面跟的是服务端原话，按它说的处理 |
| `PANEL_RENDER` | 面板自身渲染出错（插件未失效） | 点「重试」；反复出现请附控制台日志 |
| `VAULT_IO` | 引用库读写失败 | 检查数据目录权限、磁盘空间，或恢复 `vault.json` |
| `CLIPBOARD` | 复制到剪贴板失败 | 浏览器权限限制，手动选中复制 |
| `AUTH_STATE` | 授权状态写入失败 | 检查数据目录可写性 |
| `SOFT_KEYBOARD` | 软键盘构建失败（面板不受影响） | 忽略即可；反复出现请附日志 |
| `SHORTCUT_REGISTER` | 快捷键注册失败，已回退内置键位 | 检查是否有别的插件占用同一组合 |
| `SETTINGS_CARD` | 设置卡片没注册上 | 重启 `dsh web`；仍失败请附日志 |
| `SSE_FALLBACK` | 屏幕推送断开，已退化为轮询 | 网络抖动常见；持续出现检查连接 |
| `MOUSE_GRID` | 鼠标坐标换算失败（字体未就绪） | 等字体加载完或点一次「双击右下角对齐」 |
| `TMUX_FAILED` / `REFUSED` / `BAD_METHOD` | 宿主侧错误（tmux 操作 / 安全拒绝 / 方法不允许） | 按提示里的原因处理；`REFUSED` 一律不可绕过 |

## 详细文档

| 文档 | 内容 |
|---|---|
| [docs/项目文档.md](https://github.com/Mrtime-gege/terminalkeeper/blob/main/docs/项目文档.md) | **权威文档**：架构/工具/面板/审计/限制/文档索引 |
| [docs/使用细节.md](https://github.com/Mrtime-gege/terminalkeeper/blob/main/docs/使用细节.md) | **人机双接管完全指南**、面板/工具用法、配置项、HTTP API |
| [docs/工具参数手册.md](https://github.com/Mrtime-gege/terminalkeeper/blob/main/docs/工具参数手册.md) | 每个工具的每个参数（五块模型） |
| [docs/SECURITY.md](https://github.com/Mrtime-gege/terminalkeeper/blob/main/docs/SECURITY.md) | 安全模型、审计边界、已知限制 |
| [docs/引用库安全模型.md](https://github.com/Mrtime-gege/terminalkeeper/blob/main/docs/引用库安全模型.md) | 引用库威胁模型 |
| [docs/快捷键方案.md](https://github.com/Mrtime-gege/terminalkeeper/blob/main/docs/快捷键方案.md) | 面板/tmux 键位 |
| [docs/首次可用标准.md](https://github.com/Mrtime-gege/terminalkeeper/blob/main/docs/首次可用标准.md) | 首次可用盲测标准 |
| [docs/CONTRIBUTING.md](https://github.com/Mrtime-gege/terminalkeeper/blob/main/docs/CONTRIBUTING.md) / [docs/PUBLISHING.md](https://github.com/Mrtime-gege/terminalkeeper/blob/main/docs/PUBLISHING.md) | 开发约定 / 发布流程 |

## 给 AI 助手的操作卡

> 写给**正在读这份 README 的 AI**：用户让你装/验收本插件，或问"这是干什么的"，照下面执行。

**A. 安装**（装前把上方风险清单要点给用户看一眼）：`npx -y terminalkeeper install` → `npx -y terminalkeeper doctor`（三行都 ✓）→ **提醒用户重启 `dsh web`**（不是刷新页面）。

**B. 验收**（按序，全过才算装好）：① `shell_state` 返回 `server: running (socket -L …)`；找不到工具 = 没挂载；② `shell_open {name:"verify"}` → 对返回 id `shell_run {command:"echo ok-$((6*7))"}` → 屏上必须出现 `ok-42` → `shell_manage action=close` 收尾；③ `shell_audit {days:1,lines:5}` 头部 `chain: ✓`；④ 让用户看右下角悬浮胶囊，没有就刷新页面；⑤ 无 systemd 环境（如 WSL2 旧版）`capability` 行显示降级属正常。

**C. 答疑口径**：它给 DSH 加装**真实、持久、可审计**的终端——AI 用 7 个 `shell_*` 工具驱动多个后台 tmux 会话（长任务、vim/ssh、跨对话接管），人用右下角面板随时旁观或上手打字，可互相接管/交还；每次输入进哈希链审计，vault 让密码值不过 AI 之手。必须同时讲清：① 这是把真 shell 交给 AI，护栏是减速带不是沙箱；② 不是受限执行环境、不弹审批；③ 默认"可检测篡改"，内核级防删改需 `--audit-lock`。排障细节见 [docs/使用细节.md](https://github.com/Mrtime-gege/terminalkeeper/blob/main/docs/使用细节.md)；安全边界以 [docs/SECURITY.md](https://github.com/Mrtime-gege/terminalkeeper/blob/main/docs/SECURITY.md) 为准。

## 许可证

MIT（见 [LICENSE](https://github.com/Mrtime-gege/terminalkeeper/blob/main/LICENSE)）。
