# terminalkeeper

> **给 AI 用的持久终端。** 一个 DSH 插件：私有 tmux 服务端托管多个长期存活的 shell，AI 用工具驱动，人用右下角面板随时接手，所有输入进哈希链审计。

[![npm](https://img.shields.io/npm/v/terminalkeeper?color=2ea44f)](https://www.npmjs.com/package/terminalkeeper)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![docs](https://img.shields.io/badge/docs-GitHub%20Pages-2ea44f)](https://mrtime-gege.github.io/terminalkeeper/)
[![node](https://img.shields.io/badge/node-%E2%89%A520-339933)](https://nodejs.org/)

**当前版本 0.1.2**（全新公开身份，从 0.1.0 开始计数）。文档站：<https://mrtime-gege.github.io/terminalkeeper/>

## 它解决什么问题

普通命令执行是「起进程 → 拿输出 → 进程结束」。但很多真实任务是**有状态的交互**：`sudo` 要等密码、`ssh` 要过二次验证、`vim` 要按键、长任务要中途看进度、换一个对话还想接着用同一个环境。

terminalkeeper 让 AI 拥有**真正持久的终端**：

- **7 个模型工具**：`shell_open / shell_run / shell_send / shell_read / shell_manage / shell_state / shell_audit`（同一个 shell 在一次调用里只能被操作一次，多任务请拆成多次调用）
- **等待是一等公民**：`wait.kind = none / idle / bell / match / exit / file / noproc / cpu`（异步启动 → 读增量 → 用 `runId` 回取退出码）
- **人的面板**：真终端（颜色、光标、全屏 TUI、`sudo`、REPL 全通），可锁定、可搜索、可帧回放
- **审计链**：每次输入、会话开关、授权、改名、宏与引用库操作都进 SHA-256 封链；删除动作本身也先入链
- **引用库**：值只在宿主与本机，AI 只能做**整条裸引用**喂 stdin 提示，按「剩余可用次数」限额
- **宏 / 工作区 / 快照**：可复用的命令片段、会话布局一键恢复、屏面与历史快照
- 桌面应用无关：`dsh` 重启会话不丢（systemd scope），关页面/换对话/热重载都不影响

## ⚠️ 先读风险，再决定装不装

**这工具能把你的机器交给 AI。** 它不是受限执行环境。

1. **由 AI 开发、无人审计**——自动化测试与真机验证有，人工安全审计没有。
2. **授权 = 任意命令**——对话被授权后，AI 以**你自己的用户权限**读写一切；默认没有逐条审批。
3. **护栏是启发式减速带**——`rm -rf /`、`mkfs`、`dd of=/dev/*`、`curl|sh` 等会被拦，但变量/脚本/拼接能绕过，也会误报。不要把它当沙箱。
4. **审计 = 可检测篡改，不是不可篡改**（默认）——同权限的 AI 能改审计文件；要内核级防删改跑 `./install-deps.sh --audit-lock`（`chattr +a`）。
5. **整机重启会丢会话**——`dsh` 重启存活，整机/WSL2 关机连 tmux 一起带走；重要工作先落盘。
6. **平台仅 Linux**（含 WSL2/容器），Node ≥ 20，macOS 不支持。
7. **不要放进生产/多用户/有不可替代数据的机器。**

> 别在终端里长期输入真凭据——留痕是如实记录的（密码提示会脱敏，其它明文输出不保证）。

## 安装

```sh
npx -y terminalkeeper install [--profile web]   # 登记进 profile、装依赖、检查 tmux
npx -y terminalkeeper doctor                    # 体检
```

装完**重启一次 `dsh web`**（不是刷新页面）。其它命令：`--dry-run` 预览、`uninstall` 反向移除、`purge-data` 清理数据。

## 快速上手

1. 重启后右下角出现胶囊 **`>_ N 🔒`**；点 **＋** 新建 shell，或让 AI `shell_open`。
2. 每个对话**第一次**用工具时会请你授权一次，之后正常使用。
3. 面板点锁即可直接打字；AI 用 `shell_run` 发命令、`shell_state` 看会话。
4. 详情面板有 8 个页签：总览 / 概览 / 运行 / 安全 / 事件记录 / 引用库事件 / 日志审计 / 键位帮助；**三级页签视觉分级**（分段控件 → 下划线 → 文字 chip）。
5. 想彻底清理：`node purge-all.mjs`（默认 dry-run，确认后加 `--yes`）。

## 人机双接管

AI 的终端就是普通 tmux 会话（私有 socket `-L terminalkeeper`）：

```sh
tmux -L terminalkeeper attach -t dsh-xxxx     # 人随时进去接手
```

- **人在面板解锁** = 人在操作，AI 对该 shell 的写操作一律让位（只读不受影响）。
- **秘密（vault）不直接进 AI 的命令**：AI 只能做整条裸引用 `{{v:键}}`（喂 `read -s` / `sudo -S` 这类 stdin 提示）；嵌进命令、管道或宏会被拒。注意：**裸引用不是保密边界**——把值喂给会回显的程序（如 `cat`）仍会让值出现在屏幕上；打码只覆盖“引用注入产生的行”。
- **宏**：`{{m:名}}` 在命令里展开；写入全量入审计链。
- **完整操作指南**：[使用指南](https://github.com/Mrtime-gege/terminalkeeper/blob/main/docs/使用指南.md)。

## 安全边界（能挡什么、挡不住什么）

- 确认门只在**首次**使用某个对话时问一次，防手滑与静默启动，**不防蓄意 agent**。
- 人机互斥、能力降级如实上报（无 systemd / 无 `/proc` 会明说）。
- 审计链 + 签名检查点：删一条、改一字节、调顺序都会断链；可选镜像异地保存。
- 完整威胁模型见 [安全与引用库](https://github.com/Mrtime-gege/terminalkeeper/blob/main/docs/安全与引用库.md)。

## 兼容性

- 宿主：DeepSeek Harness（`dsh`）**`0.1.5-rc.1` 到 `0.2.1-rc.2`**；0.2.1-rc.2 已跑 `npm test` + 真机冒烟（开壳/执行/关壳/看门狗接管）。
- 升级 `dsh` 后插件消失：先看 [架构与实现](https://github.com/Mrtime-gege/terminalkeeper/blob/main/docs/架构与实现.md) 的兼容闸一节。
- 本插件 0.1.0 起用新包名与新数据目录 `~/.dsh/terminalkeeper`（从旧 `agent-shell` 自动复制迁移，旧目录保留可回退）。

## 文档

| 文档 | 内容 |
|---|---|
| [文档站](https://mrtime-gege.github.io/terminalkeeper/) | 全部文档的网页版（目录即索引） |
| [使用指南](https://github.com/Mrtime-gege/terminalkeeper/blob/main/docs/使用指南.md) | 安装、配置、面板、工具、引用库、宏、审计、键位 |
| [工具与参数](https://github.com/Mrtime-gege/terminalkeeper/blob/main/docs/工具与参数.md) | 五块模型、action.kind、等待条件、参数权威定义（生成表） |
| [安全与引用库](https://github.com/Mrtime-gege/terminalkeeper/blob/main/docs/安全与引用库.md) | 围栏、授权与锁、威胁模型、引用库信任边界 |
| [架构与实现](https://github.com/Mrtime-gege/terminalkeeper/blob/main/docs/架构与实现.md) | 架构、数据布局、HMR、已知限制、首次可用标准 |
| [贡献与发布](https://github.com/Mrtime-gege/terminalkeeper/blob/main/docs/贡献与发布.md) | 贡献、分支/提交规范、发布流程与回滚 |

> 正文文档是 5 篇 + 本 README；文档站首页是目录页。内部测试文档不随发布提供。

## 给 AI 助手的操作卡

> 写给正在读 README 的 AI：用户让你安装/验收时照此执行。

**安装**：`npx -y terminalkeeper install` → `npx -y terminalkeeper doctor`（三行都 ✓）→ 提醒用户**重启 `dsh web`**。

**验收**（全过才算装好）：

1. `shell_state` 返回 `server: running (socket -L terminalkeeper)`；找不到工具 = 没挂载。
2. `shell_open { tasks: [{ action: { kind: "open", label: "verify" } }] }` 拿到 id。
3. `shell_run { tasks: [{ target: { sessions: "<id>" }, action: { kind: "run", command: "echo ok-$((6*7))" } }] }` → 屏上出现 `ok-42`。
4. `shell_manage { tasks: [{ target: { sessions: "<id>" }, action: { kind: "close" } }] }` 收尾。
5. `shell_audit { tasks: [{ action: { kind: "audit" }, output: { lines: 5 } }] }` 头部 `chain: ✓`。

**答疑口径**：它给 DSH 加装真实、持久、可审计的终端——AI 用 7 个工具驱动多个后台 tmux 会话，人用面板旁观或上手，可互相接管；每次输入进哈希链，vault 让密码值不过 AI 之手。必须同时讲清：① 这是把真 shell 交给 AI，护栏是减速带不是沙箱；② 不是受限执行环境、默认不弹逐条审批；③ 默认「可检测篡改」。

## 开发与贡献

想读代码、提 PR 或自己构建，先看 [贡献与发布](https://github.com/Mrtime-gege/terminalkeeper/blob/main/docs/贡献与发布.md)；发布前的长任务测试、发布目录门禁与推送步骤都在规范里。

本地快速自检一条命令：`npm test`（约 1500 条断言：纯函数 + 客户端 + 文档 / 泄露 / 发布白名单门禁）。

## 许可证

MIT（见 [LICENSE](./LICENSE)）。
