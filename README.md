# terminalkeeper

> 给 AI 用的持久终端，也是人能随时接手的真终端面板。  
> 一个 DeepSeek Harness（DSH）插件：多个长期存活的 shell、7 个模型工具、一块可操作的面板、一条可校验的审计链。

[![npm](https://img.shields.io/npm/v/terminalkeeper?color=2ea44f)](https://www.npmjs.com/package/terminalkeeper)
[![license](https://img.shields.io/badge/license-MIT-blue)](https://github.com/Mrtime-gege/terminalkeeper/blob/main/LICENSE)
[![docs](https://img.shields.io/badge/docs-GitHub%20Pages-2ea44f)](https://mrtime-gege.github.io/terminalkeeper/)
[![node](https://img.shields.io/badge/node-%E2%89%A520-339933)](https://nodejs.org/)

## 当前版本

当前发布版本是 **0.3.0**（打 tag 后由 CI 自动发布到 npm；上一版为 0.2.0）。本版包含跨平台终端后端、Windows 原生 PTY、软键盘重做，以及审计链、引用库与发布门禁的一轮安全加固。详细变化见 [CHANGELOG](https://github.com/Mrtime-gege/terminalkeeper/blob/main/CHANGELOG.md)。

## 这是什么

普通的命令执行通常是“启动进程 → 拿输出 → 进程结束”。但真实工作经常是**有状态的交互**：`sudo` 要等密码、`ssh` 要过验证、`vim` 要按键、构建要中途看进度、换一个对话还想回到同一个环境。

terminalkeeper 把这些终端交给 DSH 管理：

- **多个 shell 长期存活**：Linux/WSL2（tmux）下关闭页面、切换对话、重启 DSH 都不会结束正在运行的 shell；原生 Windows PTY 的会话在宿主进程内，重启 DSH 会一起结束；
- **AI 用工具操作**：`shell_open`、`shell_run`、`shell_send`、`shell_read`、`shell_manage`、`shell_state`、`shell_audit`；同一个 shell 在一次调用里只能被操作一次，多任务请拆开调用；
- **人用面板接手**：右下角的真终端面板支持颜色、光标、全屏 TUI、`sudo`、REPL、搜索、锁定、回放和拖拽缩放；
- **软键盘**：面板输入区可以打开一套完整的 108 键键盘；它是独立的页面浮层，不会被终端画面裁切，支持 Ctrl / Alt / Shift 组合；
- **审计链**：输入、会话开关、改名、宏和引用库操作都会记录到可校验的审计链；
- **引用库**：AI 默认只看到键名，值由宿主在发送时注入终端；跨组同名键会 fail-closed 拒绝写入，面板可列出冲突并选择保留哪一组；
- **宏、工作区、快照**：重复命令、会话布局可复用；快照保存 cwd、名字、尺寸与闲置策略（不含屏面/进程）。

## 先读风险

**terminalkeeper 会把一台真实的 shell 交给 AI。** 它不是受限执行环境，也不是经过认证的安全产品。

1. **本插件由 AI 开发**，未经独立人工安全审计；插件和 AI 的 shell 运行在同一个操作系统用户下，AI 能做的事基本等于你的用户权限能做的事。
2. **没有任何审批防护**：插件没有对话级授权页面。是否允许写操作由 DSH 的沙箱模式决定；完全控制模式下，AI 可以直接执行命令。
3. **启发式护栏不是沙箱**：危险命令拦截能绕过，也会误报，不能替代系统级隔离。
4. 审计链能发现删改，但默认不能阻止同一权限的用户/AI 修改审计文件。
5. 整机重启会连 tmux 一起结束；重要工作请先落盘。
6. Linux / WSL2 是正式支持；macOS 和原生 Windows 仍是实验支持。macOS 的 watchdog 使用 `ps` 校验进程身份；没有可用身份源时只报告、不布防。
7. 不要把插件放进生产环境、多用户机器或有不可替代数据的机器。

> 不要长期在终端里输入真实密码或令牌。密码提示会被脱敏，但终端的其他明文输出不保证。

## 安装

```sh
npx -y terminalkeeper install [--profile web]
npx -y terminalkeeper doctor
```

安装后**重启一次 `dsh web`**，不是只刷新页面。

- 插件安装器不会自动安装 tmux、PowerShell、node-pty 等系统程序。
- Linux/macOS 可先运行 `./install-deps.sh --check` 查看需要的系统依赖；真正安装由你本人执行。
- macOS 需要 Homebrew tmux。
- Windows 原生的 PowerShell / cmd 终端使用 PTY 后端；可先运行 `install-deps.ps1` 只做检查。

## 快速开始

1. 重启 DSH 后，右下角会出现终端胶囊。点 **＋** 新建一个 shell。
2. 点输入框旁的锁图标解锁，直接输入命令；或者让 AI 调用 `shell_open` / `shell_run`。
3. 面板上的 **⌨** 打开软键盘。键盘是整页浮层，可以拖动、缩放和复位；按 Shift 后再按字母会输入大写字母。
4. 输入区上方的终端内容可以搜索、回看、复制；高级操作在面板的详情页里。
5. 面板不可用或需要排障时，使用输入栏 `/tk`（见使用指南）。

## 备用入口 `/tk`

`/tk` 是面板之外的纯文本入口，适合面板打不开、远程环境、CLI/TUI 和恢复排障。它不是面板的等价替代：

- 输入裸 `/tk` 只会打开只读语法菜单，不会执行命令；
- 菜单只提示语法，不填草稿、不执行；
- 命令和结果会进入当前对话的文本流；
- 秘密值不能写在命令行里，只能通过权限为 0600 的文件传入。

常用命令：`/tk status`、`/tk shell list`、`/tk audit chain`。完整语法见[使用指南](https://github.com/Mrtime-gege/terminalkeeper/blob/main/docs/使用指南.md)。

## 安全边界

- **模式闸门**：只有 DSH 的完全控制模式允许写工具；工作区/只读模式下插件拒绝写操作。读不到会话模式时默认拒绝；无会话/headless 部署如确需使用，显式设置 `DSH_TERMINALKEEPER_ALLOW_UNKNOWN_MODE=1`。
- **手动锁**：人锁住某个 shell 后，AI 对它的写入和修改会被拒绝；只读查询不受影响。
- **危险命令护栏**：拦截明显危险的命令模式，但不是沙箱。危险命令的 `bypassGuard` 需要部署级 `DSH_TERMINALKEEPER_ALLOW_BYPASS_GUARD=1`，模型自己填写的理由不构成用户批准。
- **输入通道**：工具通道的 `keys` 只接受键位，不接受单个可打印字符或 `S-字母`；文本请走 `action.text`，避免逐字符拼命令绕过护栏。
- **审计链**：记录操作并检测删改；不能证明同权限进程没有改过。
- **引用库**：避免秘密直接进入模型上下文；不阻止 AI 在 shell 里主动读取文件或调用会回显的程序。
- **跨对话 shell**：插件不强制隔离不同对话创建的 shell；“不要动别人的 shell”是使用约定，不是权限边界。

完整威胁模型见[安全与引用库](https://github.com/Mrtime-gege/terminalkeeper/blob/main/docs/安全与引用库.md)。

## 兼容性

- DSH：`>=0.2.1-rc.2 <0.3.0 || >=0.2.2-rc.3 <0.3.0`（默认 semver 不含预发布，所以 0.2.2 的 rc 必须显式列出）；`0.2.2-rc.3` 已在 WSL、Windows Web、Windows Desktop 完成回归。
- Linux / WSL2：正式支持，使用 tmux。
- macOS：实验支持，需要 Homebrew tmux；无真实 Mac 实机验证。watchdog 用 `ps -p <pid> -o lstart=` 校验身份，无可用身份源时不布防。
- 原生 Windows：实验支持，使用 ConPTY / node-pty；PowerShell、cmd、pwsh 7 已做真实 PTY 验证。
- npm 当前发布版本是 `0.3.0`；上一版为 `0.2.0`。

## 文档

| 文档 | 内容 |
|---|---|
| [使用指南](https://github.com/Mrtime-gege/terminalkeeper/blob/main/docs/使用指南.md) | 安装、面板、软键盘、输入、引用库、宏、审计与限制 |
| [工具与参数](https://github.com/Mrtime-gege/terminalkeeper/blob/main/docs/工具与参数.md) | 7 个模型工具的完整参数与等待条件 |
| [安全与引用库](https://github.com/Mrtime-gege/terminalkeeper/blob/main/docs/安全与引用库.md#p1-3) | 威胁模型、锁、模式闸门、输入通道与引用库边界 |
| [三平台流程图](https://github.com/Mrtime-gege/terminalkeeper/blob/main/docs/三平台流程图.md) | Linux / Windows / macOS 的运行时结构 |
| [安全策略](https://github.com/Mrtime-gege/terminalkeeper/blob/main/SECURITY.md) | 安全问题报告方式与支持范围 |

## 给 AI 助手的操作卡

> 写给**正在读 README 的 AI**：用户让你安装、验收或解释本插件时，照下面执行；任何一步失败都如实报告，不要用“应该没问题”代替结果。

**A. 安装**

1. `npx -y terminalkeeper install [--profile web]`
2. `npx -y terminalkeeper doctor`：按输出逐项确认（缺少 tmux / node-pty 会明确写出降级项，不要当成全部通过）。
3. 提醒用户**重启 `dsh web`**（不是刷新页面）；重启后请用户确认右下角出现终端胶囊。

**B. 验收（按序）**

1. `shell_state`（不带参数 = 只看本对话创建的 shell）：能返回状态行即可，例如首行 `◍ server ✓ (socket -L terminalkeeper) …`。找不到这个工具 = 插件没挂载或没重启。Windows 原生 PTY 后端没有 tmux，行里 tmux 显示不可用是正常的。
2. 在 headless / 无法判定会话模式的环境里，写工具会按 fail-closed 拒绝——这是设计不是故障；确需使用时由用户显式设置 `DSH_TERMINALKEEPER_ALLOW_UNKNOWN_MODE=1`（会写审计），不要自己替用户加。
3. `shell_open { tasks: [{ action: { kind: "open", label: "verify" } }] }` → 记下返回的 session id（`dsh-…`）；后续 `target.sessions` 用这个 id，不是 label。
4. `shell_run { tasks: [{ target: { sessions: "<id>" }, action: { kind: "run", command: "echo ok-42" }, wait: { kind: "exit" } }] }` → 输出出现 `ok-42`，状态是 `✅ 条件达成 exit`；Windows 上同样走 PTY 后端。
5. `shell_read { tasks: [{ target: { sessions: "<id>" }, action: { kind: "read" } }] }` 能读回屏幕内容。
6. `shell_manage { tasks: [{ target: { sessions: "<id>" }, action: { kind: "close" } }] }` 收尾，再 `shell_state` 确认已回收。
7. `shell_audit { tasks: [{ action: { kind: "audit" }, output: { lines: 5 } }] }` → 头部应出现 `chain: ✓ 校验通过`；若显示 `(未校验)` 或报错，如实报告并让用户检查审计目录。
8. 可选：请用户在**已有会话**的输入栏执行 `/tk status`，应返回 `terminalkeeper=on` 等文本；`/tk` 只是面板打不开时的备用入口。

**C. 向用户解释时的口径**

- 它给 DSH 加装真实、持久、可审计的终端：AI 用 7 个 `shell_*` 工具驱动多个后台 shell（Linux/WSL2 用 tmux，重启 DSH 后会话仍在；Windows 原生用 PTY，会话随宿主进程结束），人用右下角面板旁观或直接接手。
- 每次送进 shell 的输入、会话生命周期和设置变更都会进哈希链；`{{v:键名}}` 只允许整条裸引用，值默认不进模型上下文；跨组同名键会 fail-closed，面板里可列出冲突并选择保留哪一组。
- 必须同时讲清：① 这是把真 shell 交给 AI，危险命令守卫是减速带不是沙箱；② 没有逐条审批，写权限由 DSH 的沙箱模式决定；③ 审计默认是“可检测篡改”，不是不可篡改。
- 不要承诺：macOS 有实机验证（只有契约与模拟验证）、桌面端 UI 全自动化（CDP 截图会超时）、引用库能让 AI 读不到值（同权限仍可主动读取）。

## 许可证

MIT。见 [LICENSE](https://github.com/Mrtime-gege/terminalkeeper/blob/main/LICENSE)。
