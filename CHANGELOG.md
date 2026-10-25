# 变更日志

本文件记录用户可见的变化。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)；`0.x` 阶段破坏性改动会在条目里**显式标注**。

发布规则：`package.json` 的版本必须在本文件里有对应段落（`npm run release:check` 会拦）。
条目面向**使用者**写「改了什么、怎么改的」，不复述实现细节。

## [0.1.1] - 2026-10-25

### 变更

- **npm 包移除未使用的 `locale/*.json`**（代码从未读取，属于历史遗留），发布白名单收窄到 36 个文件；`package.json` 的 `exports` 同步去掉 `./locale/*.json`。
- **新增自动发布工作流** `.github/workflows/publish.yml`：创建 GitHub Release 时由 CI 用 Trusted Publishing（OIDC）发布 npm，无需长期 token；tag 与 `package.json` 版本不一致会直接失败。
- **发布白名单改为显式文件级**（`release/publish-files.json`）：新增文件默认不发布，必须手动登记；`npm test` 会拦住未分类文件。

## [0.1.2] - 2026-10-25

0.1.2 是面向发布准备的本地版本：看门狗不再落盘状态并支持 DSH 重启接管；`shell_run` 的退出码/等待语义
经过对抗加固；公开文档收敛为 6 篇；适配 DSH 0.2.1-rc.2，并合入此前的本地安全与界面改动。

### 主要变更

- **看门狗改为 owner/control socket**：watchdog 状态带 `abi`，插件发现旧 ABI 会自动 disarm 后替换，不继续收养；DSH 重启后自动升级。harness 持有 `<数据目录>/run/<socket>.owner.sock`，
  watchdog 持有 `<socket>.watchdog.sock`；状态只在进程内存，不再写 lease/pid 文件。目录 0700、
  socket 0600，拒绝符号链接、非 socket、非本人 UID。
- **DSH 重启保留会话**：判据改为 owner socket 连续不可用 ≥ grace（默认 **5 分钟**）且 harness
  PID/starttime 消失；新 owner 在 grace 内出现时 watchdog 握手接管新 harness，不杀 tmux。
- **公开文档 11 → 6 篇**：根 `README.md` + `docs/` 5 篇正文（使用指南、工具与参数、安全与引用库、
  架构与实现、贡献与发布）；统一 3 行元信息、编号 H2、显式目录锚点与“回到目录/回到顶部”；
  删除旧文档，README 与文档站索引改为指向实际发布的页面，新增死链/锚点门禁。
- **参数定义单一事实源**：`lib/param-spec.mjs` 生成 `docs/工具与参数.md` 的 PARAMS 区块；
  `test-param-spec` 双向核对，修改参数定义却忘记同步文档会失败。
- **DSH 0.2.1-rc.2 适配**：`peerDependencies` 增加 `^0.2.1-rc.2`；README 兼容范围更新到
  `0.1.5-rc.1`–`0.2.1-rc.2`，已跑 `npm test` + 真机开壳/执行/关壳/看门狗接管/面板加载。
- **跨对话访问口径**：工具层允许用具体 id 操作其它对话的 shell（设计如此）；`*` 仅用于查看，
  写操作拒绝 `*`；工具说明明确“无用户明确要求不要操作非自己创建的 shell”。

### 安全加固

- **`shell_run` 退出码伪造面收窄**：命令可从 history/屏幕读到自己的 nonce 并提前打印假标记。
  忙时只对 ssh/sudo 等包装进程接受标记；exit 等待要求空闲 300ms 并二次确认；结尾未引用的 `#`
  （会注释掉 wrapper）与 `exec` 不再包装；`shell_read` 只接受本 shell 最近一次 `runId`。
- **`steps` 先校验再执行**：执行任何一步前校验全部 `expect`；exit/noproc/cpu 明确报不支持并指路
  `run + wait`，非法 expect 不再产生前置副作用。
- **`target.sessions:"*"` 写操作拒绝**：防止 run/send/生命周期 manage 扇出到其它对话/面板的 shell。
- **看门狗对抗加固**：当前 harness 仍活着时，伪造 control `adopt` 被拒绝，伪造 owner 握手标记
  `owner-conflict` 并忽略；旧 lease watchdog 仅在 cmdline 匹配本 socket 时迁移清理。
- **宏 × 引用库越权**：AI 创建正文含 `{{v:键}}` 的宏直接拒绝；展开已有宏时递归检查并拒绝。
  人（面板）创建的宏不受影响。
- **引用库同源边界方案 B**：`GET /vault-list` 不再返回值；新增单键 `POST /vault-get`（每次读取写
  `read-value` 审计）；面板“复制值”按需取单键，不在屏幕显示。
- **引用库写入/解锁**：锁定组写入改为 409（不再 200 假成功）；同组 60 秒 5 次失败后 429；
  总量/单值上限（2000 键、每组 500、明文 5 MiB、单值 16 KiB）；多行值在裸引用注入路径拒绝。
- **`/settings` 数组 patch 污染**：只接受纯对象、校验已知键、限制 16KB，数组不再被展开成数字键。
- **`/panel-retention` 误删**：未知 action 不再落入执行；`apply` 必须 `confirm:true`（409 needConfirm），
  面板“立即执行”改为两步确认。
- **`/audit-files purge` 路径穿越**：名字必须是纯文件名且字符集收紧为 `[A-Za-z0-9._-]`，
  修复 `dsh-x/../../…` 可删 output 目录外文件的问题。
- **HTTP/面板输入**：`/screen` 拒绝 NUL/控制字符；`/resize` 未知会话 404、非数字 400；
  `/new` 快照/目录错误 400；`/vault-set` 拒绝非法 `maxUses` 与路径穿越组名；`/audit` 90 天/读够即停。
- **supervisor 恶意帧**：单帧默认 1 MiB、并发连接默认 64；超限回 `FRAME_TOO_LARGE` 后断开，
  坏 JSON 回 `BAD_JSON` 且 daemon 不崩。
- **授权与设置**：“允许所有”默认档需二次确认；`/consent` actor 键拒绝 `*`/原型键/超长；
  `guardDangerousCommands`、`requireConsent`、`audit`、`auditDir`、`shellArgs` 等安全项变化需确认；
  `auditDir` 禁止相对路径/`..`。
- **面板注入面**：BroadcastChannel 只处理 `{type:'changed'}`；客户端禁止 `innerHTML`/`eval`/
  `new Function`；鼠标坐标/协议/按钮组合非法均拒绝；`/stream` 限制连接数、订阅数与 `lines`。
- **tmux 键名/发送失败**：面板非法键名 400、会话不存在 404；`shell_send` 含非法键名不再静默成功，
  返回 `REFUSED — nothing sent` 与原因。

### 界面与体验

- 状态行：会话 id 可点击复制；体积并入缓冲 title；按钮顺序固定为“回到最新/跟随中 → 更多历史 →
  回看 → 复制屏幕 → 搜索”，窄面板逐级隐藏尺寸/前台/缓冲，360px 仍保留全部按钮。
- 搜索：支持 `Aa` 区分大小写、`.*` 正则（非法正则显示“正则错误”且不崩）、按文字/背景颜色筛选；
  文本与颜色可组合；搜索条紧凑化。
- 修复面板 React #310（hook 在提前 return 之后导致收起/展开 hook 数不同）。
- 详情页「孤儿看门狗」卡片补全运行信息：pid/后端、owner-alive 状态、失败计数、判定窗口、探测间隔与最近探测、协议 ABI、被监视 harness 的 starttime、owner/control socket 与启动时间。
- 首次提示、软键盘失败提示、安全页警示统一走右上角消息条 + 事件记录，不再自建横幅。

### 修复

- **异步启动拿不到退出码**：`shell_run wait.kind=none` 现在也会在安全形态下包装，`read wait.exit`
  可绑定 `runId` 取退出码。
- **退出码不符文案**：不再写“等待超时”又附“命令已结束”，改为“条件不符 / 退出码 N ≠ 期望 M”。
- **工具说明与实测对齐**：`shell_open.action.label` 自动加 `dsh-` 前缀、target 用 session id；
  `wait.exit` 可在同一次调用使用；`output.lines` 含提示符/空行；`shell_audit.lines` 是记录条数、
  时间戳为 UTC（末尾 `Z`）；`output.lines` 不再混用 `chars`/`minutes` 等旧单位。
- 开发与发布文档逐篇清理：移除内部构建号、会话 id、测试记录与未发布脚本引用；修正文档站链接与
  “5 篇正文 + README”的准确数量。

### 兼容性与升级注意

- 宿主：DeepSeek Harness `0.1.5-rc.1` 到 `0.2.1-rc.2`；0.2.1-rc.2 已跑完整 `npm test` 与真机冒烟。
- `watchdogStrategy` 只保留 `owner-socket`；旧配置 `lease-node`/`sh-lowmem` 自动按 `owner-socket` 处理。
- `watchdogGraceMs` 默认改为 `300000`（5 分钟）；`watchdogRenewMs` 已废弃（保留字段兼容，不再续租）。
- 升级时旧 `/tmp/<socket>-watchdog.pid|lease` 会被一次性识别并清理；新方案不再生成这些文件。
  看门狗后端/配置改动需重启 `dsh web` 才生效；DSH 重启期间会话由 systemd scope 保留。
- 跨对话用具体 id 操作是设计；`*` 仅查看，写操作会拒绝。无用户明确要求不要操作非自己创建的 shell。

### 测试与发布

- 新增 `test-watchdog-socket`：无落盘状态、伪造 adopt/owner、接管不杀、真死收尸；`test-watchdog`
  覆盖目录权限、HMR 共享 listener、默认 grace/策略。
- `test-http-hardening` 69 项、`test-pure` 343 项、`test-watchdog` 26 项、`test-client` 1131 项；`npm test` 全绿。
- npm 包 36 个文件（移除仅用于文档生成/测试的 `lib/param-spec.mjs`）；公开 release tree 53 个文件（含 CHANGELOG，CHANGELOG 不进 npm）；`release:check` 通过；本地 `v0.1.2`，未推送、未发布 npm。

## [0.4.0]

锁模型重构、提示信息系统、工具参数体系（五块 + 单壳单次）、引用库重构、发布门禁。

### 新增

- 工具参数统一为 `{ tasks: [{ target, action, wait, output, safety }] }` 结构。
- 引用库：分组 + 不加密 / 简单混淆 / 口令加密三种模式，烧伤标记与使用计数。
- 提示信息系统：消息条 + `/notice` 历史，表单错误也走同一入口。

### 变更

- **破坏性**：`shell_*` 工具参数从扁平字段改为 `tasks` 数组（旧写法会被拒绝并给出允许字段）。
- 锁模型：加密态 / 解密态两态语义统一。

## 更早版本

`v0.1.0` – `v0.3.4` 的条目见 git tag（`git tag -n`）；本仓库在 0.1.0 时重置过一次历史，
更早的变更记录不再追溯。