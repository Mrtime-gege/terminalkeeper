# 变更日志

这里记录用户能看到的变化。版本号遵循语义化版本；`0.x` 阶段的破坏性改动会明确标注。
本文件从 0.1.0 开始记录。

## [0.3.0] - 2026-11-22

> 跨平台终端后端版本：Windows 原生 PTY、软键盘重做，以及审计链 / 引用库 / 发布门禁的一轮安全加固。发布由 GitHub tag 触发 CI 自动完成。

### 安全与可靠性加固（2026-11-16）

- 模式闸门改为 fail-closed：读不到会话沙箱模式时拒绝写工具。无会话/headless 部署如确需使用，必须显式设置 `DSH_TERMINALKEEPER_ALLOW_UNKNOWN_MODE=1`，并在审计中记录 `mode-unknown-allowed`。
- `safety.bypassGuard` 不再接受模型自证理由：危险命令需要部署级 `DSH_TERMINALKEEPER_ALLOW_BYPASS_GUARD=1`；非危险命令不受影响。
- 工具通道的 `keys`/`preKeys` 只接受键位，拒绝单个可打印字符与 `S-字母`（部分终端会忽略 Shift），并补充 `C-j` 提交识别与分片命令合并扫描，避免逐字符绕过危险命令护栏。面板软键盘仍可逐字符输入。
- 退出码等待要求“本次运行标记 + 回到发送前的提示符”，并对长输出使用完整滚动缓冲兜底；隐藏的伪提示符或后台延时标记不再被当作完成。标记是正确性信号，不是安全边界，相关限制已写入文档。
- PTY 后端使用最小环境变量，`sessionEnv` 同时接受对象与 `K=V` 数组；空闲判定绑定本次运行的 nonce，并排除命令回显行，避免安静命令被误判结束。
- 修复子 shell/嵌套 shell/后台任务下 `wait.exit` 被进程树判忙而超时的问题；`shell_run` 与 `shell_send` 的会话锁、宏读改写锁、审计链锁在异常路径上改为 fail-closed。
- Windows PTY respawn 后重新建立输出留痕；设备密钥轮换、清理策略、引用组操作失败时返回服务端错误详情。
- 面板锁定后 Ctrl+W/T/N 只拦截浏览器默认行为、不向终端发送；解锁先等待 `/busy` 成功，并用意图序号防止迟到响应覆盖后续上锁。重命名优先使用服务端返回的 label，避免误判为切换 shell。
- 发布前检查拆成“版本与文档”和“构建产物”两道：从源码目录直接发布会被拒绝，构建产物保留 release 通道自检；发布编排增加文件哈希、文档一致性与发布模式互斥检查。
- `engines.dsh` 与 peer 范围显式加入 `0.2.2-rc.3`；CI 测试 peer 升到 cordis 4.1.0 / schemastery 3.19.0。
- 稳定性测试改为等待真实命令输出，CDP 桌面刷新失败会中止；UI live 的软键盘断言默认必须执行，`DSH_UI_ALLOW_SKIP=1` 才允许降级。
- 审计签名检查点的校验结果并入链结论：尾部截断、删除整天文件即使哈希链本身自洽，也会在 `/audit`/`/chain` 报错并显示检查点错误；截断/删除/改记录的回归用例已加入 HTTP 套件。
- 引用库：嵌套花括号不再把已展开的明文拼进错误/审计；值里的花括号不二次展开；长于窗宽的单行秘密在 `shell_read` 中按 `-J` 合并后遮罩；跨组同名键、缺失 vault.json、全零 KEK 空壳改为 fail-closed。
- 审计：缺少签名检查点时不再显示“链完整”；追加前修复撕裂末行并 fsync；保留期只匹配 `audit-YYYY-MM-DD.jsonl`，不再误伤签名密钥/outbox。
- tmux：`-t` 目标改为精确匹配；控制模式帧内 `%end` 不能提前关帧，兼容 `%end <ts> <num> <flags>`；capture 使用 `-J`。
- 看门狗：Linux 用 `/proc`、macOS/无 proc 用 `ps` 校验进程身份；kill 前校验 tmux 服务端归属标记；无法证明时不杀。
- 面板：编辑秘密会预填当前引用组，只有显式改下拉并二次确认才迁移；`/busy` 加序号与 abort；收起路径统一上锁。
- 发布前门禁：`prepack`/`prepublishOnly` 跑完整检查，开发树发布被拒绝；CI 严格失败 SKIP；泄露扫描的占位符只放行占位符本身。
- 文档复审修复：审计文件路径改为 `<数据目录>/audit-YYYY-MM-DD.jsonl`；参数手册的 `steps` 上限回到 32、`macro-history.days` 默认 3/最多 30、`shell_audit.source` 补 `tk/settings`、宏正文标注 8000 字符上限；`reap` 描述改为“回收闲置 >10 分钟的存活空闲壳”。
- 复审修复：`terminalkeeper vault list|set|rm` 在 v2 分组库上直接拒绝（旧 CLI 只懂扁平表，改写会毁分组/密文）；`safety.lock:ignore` 真正跳过会话锁；`safety.reason`、`doctor.note`、`macro-set.note` 都写入审计；安全项热改口径与代码一致。
- 复审修复：引用库跨行遮罩不再拿屏幕内容和秘密值做子串比较（那会变成成员预言机，AI 可逐字符探出秘密）；改为几何窗口 + 整窗切片哈希（只认整行，不认短候选）。
- 复审修复：`purge-audit --days N` 之前会连今天一起删（cutoff 算错），现在只删超出保留窗口的天；新增 CLI 回归。
- 复审修复：保存无关设置不再把面板已设的清理策略重置为 keep（只同步显式配置项）。
- 复审修复：tmux 控制模式可见屏分支的 `screenStart` 偏移、`/busy` 旧 rev 由 200 改为 409 并让客户端自愈重试、supervisor 只为一次性命令保留 grace 超时、`/tk settings` 与官方设置共用同一数据目录、非法 `defaultTerminal` 收敛为默认值而不是让插件激活失败。
- 窄窗格（如 20 列）下退出码标记会被终端折行，`wait for exit` 现在按逻辑行 + 去换行兜底解析，并按历史窗口读取（不再只看 5 行可见屏）：以前 1 秒命令会等满 15 秒并报超时，现在正常返回退出码。
- 引用库长值遮罩改为跨物理行：记录注入行号与列宽，按窗口起点拼回逻辑行整段替换；起点滚出窗口、窄屏重绘产生多段副本时也全部遮掉（tmux 与 Windows PTY 均验证）。
- 引用库冲突恢复通道：跨组同名键被拒后，面板列出冲突键与所在组，可指定“从某一组删除”并原子重写状态头；锁定组需先解锁，删组在冲突态被拒。
- `purge-audit` 筛选语义修正：`--names` 不再被默认天数覆盖；`--days 0` 真正清空（含当天）；两者同时给出明确报错。
- 签名检查点首次封链：多天历史时基线不再与追加互相递归（会导致 CLI 挂死）；追加带 fsync 与撕裂末行修复。
- 发布编排在计划阶段就校验将要发布的 tarball：文件清单等于白名单、内容哈希与构建产物一致、通道为 release；`npm view` 只有明确 404 才算“版本不存在”。
- `/busy` 增加单调 rev：晚到的旧请求被宿主丢弃，不再反向覆盖“人在操作”状态；面板关闭功能后保留低频探测，重新开启可自动接回。
- 数据清理策略覆盖全部 7 类；`rotate` 与 `auditRetentionDays` 统一时钟，避免按 30 天归档却被 60 天保留期判成“被删”。
- 面板设置页会读取已保存的清理策略；关闭引用库同时清掉迁移确认态；确认只对同一次（键→组）有效，换键或换目标组必须重新确认。
- `.gitignore` 补齐运行期数据（`vault.*`、`device.key`、`audit-*.jsonl`、`output/`）；README 与三平台流程图改为与实现一致（快照不含屏面/进程、macOS watchdog 用 ps 身份源）。

### 平台

- 新增 `lib/terminal/` 后端契约；tmux 收口为 `TmuxBackend`，core/supervisor 不再直接 import `tmux.js`。
- Windows 原生 PTY 后端：ConPTY / node-pty、xterm-headless 屏幕；`cmd.exe`、`powershell.exe` 和 `pwsh.exe`（PowerShell 7.6.9）的真实 Windows ConPTY 全链路、Ctrl-C、UTF-8 已验证。
- 0.3.0 npm tarball 在 Windows 上实际安装（可选依赖生效），安装后的包对 cmd/powershell/pwsh 的 PTY 后端均通过。
- macOS 实验支持：`os` 包含 `darwin`；无 `/proc` 时进程表走 `ps`；没有 systemd/chattr 时按能力降级。**尚未在真实 Mac 上测试。**
- Linux / WSL2 继续走 tmux；真实 WSL2 环境已验证 `/proc/version`、tmux 3.7c 与 systemd-scope。
- Windows 默认选择 pty，Linux/macOS 默认 tmux；终端能力按后端声明降级。

### 安装边界

- 插件/安装器不自动安装 tmux、PowerShell、node-pty 或任何系统程序。
- `install-deps.sh` 默认只读；`install-deps.ps1` 只检查并打印命令；`--yes` 只能由用户本人执行。
- `node-pty` / `@xterm/headless` 是 optionalDependencies；缺失时 PTY 后端明确报错，不自动安装。

### 软键盘

- 软键盘改为页面级 portal：不再作为终端面板子节点渲染，也不再被面板 `overflow` 或定位上下文裁切。
- 保留原有 108 键布局（主键区、导航区、数字键盘、媒体键）；新增真实 Shift 语义：Shift+字母输入大写字母，Shift+数字/符号输入对应符号。
- 修饰键保持粘滞，但完成一次组合后清空；不可发送的键继续置灰并显示原因。
- 软键盘测试补充 portal、宽度、顶部按钮尺寸、Shift+字母、锁定禁用和关闭路径。
- 软键盘顶部“清空修饰 / 复位 / 关闭”按钮与键面行高对齐；说明文字明确“只对 terminalkeeper 终端生效”。
- 点击软键盘不再让面板失焦自动锁定；整个软键盘区域（含空白处）的点击都不再触发上锁；终端锁定后软键盘键面禁用并拒绝发送。
- 特殊键（功能键、导航键、Enter/Backspace、修饰键）使用区分底色与描边，普通字符键保持中性；粘滞修饰键点亮时变色。

### 修复

- 修复 Windows Desktop 点击“回放”时面板报 `pframes is not defined` / `frameAt is not defined`：播放器现在显式定义帧数组与当前帧读取器，并加回归断言。

### Windows 桌面真实测试修复（2026-11-10）

- 修复 PTY `shell_state` 因 `harnessPid` 字符串属性遮蔽同名方法而报 `driver.harnessPid is not a function`。
- PTY 快照 cwd 不再记录 `pty` 字面量；优先使用后端实时 cwd，`shell_open { from }` 可正常复活。
- `respawn` 先验证 cwd/shell 再销毁旧窗格，避免非法 cwd 把非破坏操作变成销毁操作；spawn 失败回滚仍是后续项。
- PTY `shell_send` 支持 `C-c`、`M-x`、`C-M-x`、`S-Tab` 等组合键转义，不再按字面发送。
- 修复 `shell_read matchOffset` 在工具执行层被漏传的问题，搜索分页恢复。
- PowerShell 退出码包装比较执行前后 `$LASTEXITCODE`、`$?` 与 `$Error.Count`，避免 PS 报错后沿用旧 0。
- 修复 `wait exit` 在等待前已有标记且码不符时仍空等超时的问题。

- 审计链读尾不再固定 16KB：超大记录会从 16KB 起倍增到 1MB，避免末行被截断后误回 genesis 造成假断链。

### 决策落地的行为调整（2026-11-10）

- `shell_run` 的 `run` 动作新增可选 `submit`（默认 true）。run 是执行入口，默认自动补 Enter；显式 `submit:false` 才只填不提交。宏自身的 `submit:false` 不再覆盖 run 的默认执行，需要只填时显式传 `submit:false`。
- `shell_read wait.exit` 改为幂等 + runId 绑定：显式 runId 的标记无论等待前后都认；无 runId 只认等待后新增；超时前补一次兜底扫描。
- 手动锁/解锁审计改为明确的 `lock` / `unlock` 事件，保留 `decision` 字段；自动 busy 仍走 `panel-lock`。

### 2026-11-10 后续修复

- PTY `respawn` 改为先 spawn 新窗格、成功后才替换旧窗格；spawn 失败不再销毁原会话。
- PTY `kill` 清理进程树（Windows `taskkill /T`；Unix 进程组），capture FileHandle 改用 `close()`。
- 审计安全设置（audit/featureAudit/capture/redact/guard 等）统一加入不可热改名单；`auditMirror` 必须绝对路径、无 `..`、二次确认且不可热改。
- 引用库 `maxUses:null/''` 不再折算成 0；组名拒绝竖线；HTTP/TK 拒绝 `__proto__` 等保留键名。
- 面板支持 Alt+单字符 → `M-x`（Alt+B/F 等）；F2 与行内铅笔共用 `openRenameFor` 进入重命名表单。
- 新增 HTTP、vault-policy、PTY key/respawn/state 回归。

### DSH 0.2.2-rc.3 兼容适配（2026-11-15）

- 在 WSL、Windows Web（npm 全局安装）、Windows Desktop（安装包版）三个环境完成 rc.3 回归；`engines.dsh` / peer 范围已显式加入 `0.2.2-rc.3`（npm 默认 semver 不把预发布算进 `>=0.2.1-rc.2 <0.3.0`）。UI live 三环境全部通过（断言数随用例增删变化，以运行输出为准）。
- 软键盘浮层 `z-index` 从 9999 降到 900：rc.3 的模态遮罩使用 1000，浮层不再压住宿主引导/设置弹窗。
- UI 测试新增宿主模态兜底（`dismissHostOverlays()`）：rc.3 新 profile 的「Get started」遮罩会盖住终端胶囊，测试会先关闭再操作。
- 软键盘位置改为渲染时按视口夹取，不再把临时窄窗口（UI 测试的 390 宽用例）夹出来的值写回存盘；窄窗口恢复后不会留下一条「细缝键盘」。
- UI 测试支持 `DSH_UI_CDP` 直连桌面版 Electron 窗口；真实坐标点击前会先把目标滚进可滚动祖先的可见区。
- 新增三环境稳定性测试脚本：真实浏览器驱动多个宿主，重复执行新建/发送/读屏/改尺寸/改名/关闭并验证回收；rc.3 三环境各 3 轮全部通过（断言数以运行输出为准；命令断言已改为“输出与输入不同”的真实执行检查）。
- 文档补充 rc.3 的内置终端栈（侧栏终端）、plan mode 与 `dsh-tmux-context` 的兼容边界。

### 复杂长任务三环境验收（2026-11-15）

- 设计并执行两阶段复杂任务：无源码 C 程序逆向（静态 XOR 推导 + gdb 断点验证）、交互式登录、180 秒 compute 长任务 + 轮询、后台 watch + Ctrl-C、并发 rename/resize/snapshot/复活、审计链与清理。
- WSL（headless DSH）、Windows Web、Windows Desktop 三个环境均完成两阶段；关键值一致：password `<测试口令>`、stage2 `0x6fcab03a`、checksum `0x32c85cb0`、K2 `0x5d02ec8a`、FLAG1/FLAG2 正确、compute ≈180–185s、watch 35–158 ticks、shell 全部回到基线且无残留进程。
- 发现交互式 TUI 前台时误用 `shell_run` 会把退出码包装行当作 TUI 输入（出现 unknown，runId 永不产生 marker）；正确做法是 `shell_send`。本轮以实际行为记录，未改运行时语义。
- Windows gdb 在 PE ASLR 下不能直接按静态地址下断点；夹具改用运行时映像基址推导，静态符号断点仍可用。

### 真实智能体验收（2026-11-15）

- Windows Web 与 Windows Desktop 各启动一个真实智能体，仅用 `shell_*` 工具完成 12 项全功能验收：生命周期、默认自动回车、`submit:false` 只填不提交、`shell_send` 组合键与 Ctrl-C、resize/改名/快照/复活、非零退出码与 `wait.exit` code 校验、审计链、引用库/宏只读、清理回收。
- 两个环境均 **12/12 通过、0 失败**（Web 5m22s / Desktop 2m26s）。
- 修复 Windows PTY PowerShell 退出码包装：执行前把 `$LASTEXITCODE` 清空，重复相同退出码（如连续两次 `cmd /c exit 7`）不再被折叠成 1；`wait:{kind:"exit",runId,code:7}` 现在能如实命中 7。

### 兼容性与修复补充

- 本地 DSH `0.2.2-rc.1` 完整回归通过：52/55，0 失败；3 项为 P10 人工产物/Windows 平台 SKIP。Windows 测试 Web 也已升级到 0.2.2-rc.1，UI 90 项通过。
- 修复 Windows PTY 输入退格被写成字面量 `BSpace`：PTY 现在识别 tmux 键名 `BSpace/DC/IC/NPage/PPage/BTab` 并转换为 VT 字节。
- 修复自定义 shell 名改回 id 裸名时被误判为“未变化”而静默跳过；重命名按当前显示 label 判断。
- 真实 UI 测试补充 2560×1440、引用组增删、终端重命名/恢复、拖拽改尺寸/恢复、Windows 退格回归。

### 已知限制

- macOS 只有预期/契约测试，没有实机证据；watchdog 用 `ps -p <pid> -o lstart=` 校验进程身份，没有可用身份源时只报告、不布防，崩溃后的孤儿 tmux 清理不保证。
- Windows Web（npm 全局安装，3090）已在 Windows 宿主完成真实验收；Desktop 安装包内的 Web 预览未单独验收。Windows 宿主 pwsh 未安装，pwsh 7 语法在 Linux/便携 Node 上用真实 ConPTY 验证。
- Windows PTY 是宿主进程内会话，不承诺 DSH 重启后存活。
- `node-pty` 在测试环境仍会打印 `AttachConsole failed`，需在干净 Windows 宿主复核。

## [0.2.4] - 2026-11-08（内部里程碑，不发布）

> Windows 原生 PTY 后端骨架与 pwsh/cmd 预期测试；仍不单独发布，稳定版统一在 0.3.0。

### Windows

- 新增 `PtyBackend`，支持显式 shell 启动、ConPTY、PTY 写入/resize、xterm-headless 屏幕、输出订阅与关闭。
- shell 选择按 `pwsh.exe` → `powershell.exe` → `%ComSpec%`/`cmd.exe`；pwsh/powershell 默认 `-NoLogo`，cmd 默认 `/Q`。
- 使用 fake pty/terminal 做预期测试，不依赖真实 Windows；node-pty / xterm-headless 缺失时明确降级，不自动安装。
- 环境探测通过 `/proc/version` 标记 WSL2；在真实 WSL2 内验证了 tmux 3.7c 与能力快照；WSL2 仍走 Linux/tmux，不切换后端。
- pwsh 探测覆盖 PATH、Program Files\PowerShell\7 和用户目录标准路径，避免 MSI/Store 安装不在 PATH 时漏选。
- win32 默认选择 pty；core 对非 tmux 后端跳过 tmux probe/watchdog/control，按 plain-detach + raw 降级。
- 新增 `install-deps.ps1`：只检查 pwsh/cmd 与 node-pty/xterm，缺失时打印命令，不自动安装。
- Linux 上用真实 node-pty/@xterm/headless 跑通 create/send/screen/resize/kill 冒烟，以及 core 的 shell_open → shell_run → shell_read → close 全链路。
- Linux 上用 PowerShell 7.6.6 真实 PTY 跑通 backend 与 core（pwsh 包装语法）；Windows 的 pwsh 仍未安装。
- 用 Windows 便携 Node + ConPTY 实测 `cmd.exe` / `powershell.exe` 的真实 PTY 输出；`pwsh.exe` 本机未安装，仍待宿主验收。
- Windows 真实 PTY 上 cmd/powershell 的 Ctrl-C 与 UTF-8 输出通过（cmd 需 `chcp 65001`）。
- Windows core 全链路（shell_open → shell_run → shell_read → close）在真实 cmd/powershell 上通过；cmd 使用 `/V:ON` + `!ERRORLEVEL!`，PowerShell 使用 `$LASTEXITCODE`/`$?` 退出码包装。
- Linux/WSL2/macOS 仍默认 tmux；Windows 原生仍是内部实验，0.3.0 才发布。

## [0.2.3] - 2026-11-08（内部里程碑，不发布）

> macOS 进程能力补齐；**尚未在真实 Mac 上测试**，仍不单独发布，跨平台稳定版统一在 0.3.0。

### macOS

- 没有 `/proc` 时改用 `ps -axo pid=,ppid=,comm=,pcpu=` 的进程表，`wait.noproc` / `wait.cpu` 从“拒绝”恢复为可用。
- 解析器支持含空格的命令名；新增纯函数测试，不依赖 macOS 实机。
- foreground 仍按 raw 降级（不做 `/proc` 钻穿）；systemd / chattr 的限制不变。

## [0.2.2] - 2026-11-08（内部里程碑，不发布）

> macOS 实验支持；仍不单独发布，跨平台稳定版统一在 0.3.0。

### 平台

- `os` 增加 `darwin`；macOS 可通过 Homebrew 安装 tmux 后运行，仍不承诺与 Linux 完全等价。
- macOS 没有 systemd / `/proc` / `chattr` 时按能力降级：plain-detach、进程类等待受限、审计目录不可加锁。
- `wait.noproc` / `wait.cpu` 在缺少进程树/CPU 能力的后端上明确拒绝，不再静默误判。
- CLI 安装提示补充 Homebrew 的 tmux 安装方式；README 补 macOS 实验范围。

## [0.2.1] - 2026-11-08（内部里程碑，不发布）

> 这一版只用于内部验证终端后端抽象；npm/GitHub 不单独发布，跨平台稳定版统一在 0.3.0 发布。

### 兼容性与分发

- `package.json` 增加 `engines.dsh: ">=0.2.1-rc.2 <0.3.0"` 与 `dsh.manifestVersion: 1`，让 DSH 插件市场和插件管理器能正确判断兼容范围。
- 声明 `os: ["linux"]`，与 README 的 Linux / WSL2 限制一致；原生 macOS / Windows 不再允许安装。
- 面向 DSH 插件目录补齐分发元数据；终端功能本身无变化。

### 终端后端基础

- 新增 `lib/terminal/` 契约层：后端声明能力（屏幕/历史/订阅/进程树/持久化等），core 只通过 `createTerminalService` 取服务。
- 现有 tmux 实现收口为 `TmuxBackend`；`lib/index.js` 与 supervisor 不再直接 import `tmux.js`。
- 为后续 macOS / WSL2 / 原生 Windows 后端留出接入口；本版本仍只有 tmux backend，用户可见行为不变。

## [0.2.0] - 2026-11-08

### 输入栏 `/tk`

- `/tk` 收敛为唯一的宿主命令：删除所有 `/tk-*` 客户端入口和自接 Tab 补全；命令与结果只走会话文本流，不打开 Web 结果面板。
- README 与使用指南明确：**日常操作优先面板，`/tk` 仅作备用**；如实列出菜单只读、不填草稿、新会话草稿不执行、命令进入上下文、秘密只能走 0600 文件、功能为面板子集等限制。
- 裸 `/tk` 的官方 `commandUi` 菜单改为**只读语法目录**：首屏安全提示，按域列出命令和可选参数，并动态追加引用组、键名和 shell；选中只发 composer 语法提示，不执行、不填草稿、不打开面板；选择后需照提示手输完整命令。
- `/tk help` 补齐全部域、子命令与可选参数；文本命令覆盖引用库组与键、shell 生命周期、看门狗、设置、审计、宏、工作区与状态。
- 解析加固：命令上限 4096 字符/128 词，保留空引号参数，拒绝把 `--` 当参数值；秘密值、口令和宏内容只接受 0600 文件。
- 修复 `--no-submit` 布尔选项解析（宏设置“只填不提交”）。
- 菜单提示通过官方 composer notice 显示，面板收起时也能看到。

### 安全

- 引用库组：默认组不可改名、删除、改加密方式或落盘属性；默认组级联删除会先拒绝，不会先删键。
- 锁定组拒绝改加密方式、改落盘属性、改名和移入/移出键；加密/混淆组禁止切换落盘，改名仅限不加密且落盘组。
- `key set` 在写锁内复检组锁定状态；`key get --to-file` 先确认审计可用；导出文件使用 0600 且拒绝覆盖已有文件。
- shell `close` 只用精确 id；`snapshot` 等待落盘并在失败时报错；`burn` 的名字指纹在 `uses` / `readUses` / `syncUses` 路径中保持稳定。
- 解锁失败限速在文本命令与面板之间共用同一计数（60 秒 5 次）。

### 功能

- `shell_manage` 增加 `action.kind=help` 与 `view`：按生命周期/快照/宏/工作区/引用库分组显示说明，`view=all` 显示全部。
- 引用库口令组增加闲置自动锁定：默认最后一次解锁/取值后 10 分钟锁定，设置项 `vaultAutoLockMinutes` 可改（0–2880，0 = 关闭）。
- 后台维护扫描统一到同一节拍：死壳回收、闲置关闭、引用库过期与自动锁定一起跑，默认 10 秒，设置项 `maintenanceIntervalSeconds` 可改（1–60 秒）。

### 文档

- README、使用指南、工具与参数、安全与引用库按统一 `/tk`、只读官方菜单、审计来源和当前参数上限更新。
- 新增 `SECURITY.md` 安全策略，补报告渠道、支持范围和安全模型摘要；README 文档索引同步。

### 清理

- 删除 consent/ACL 遗留样式、注释和旧兼容分支；文档只保留当前行为。

## [0.1.4] - 2026-10-28

### 文档

- 重写安全与引用库说明：明确同用户边界、模式闸门/锁/护栏/审计各自能做什么。
- 明确引用库只防敏感信息直接进入模型上下文，不防 AI 主动读取；补充口令加密在未解锁/解锁后的边界。
- 文档中删除过时的配置、路由、兼容迁移和工具错误说明；只描述当前实现。

## [0.1.3] - 2026-10-28

### 权限

- 工具可用性由 DSH 沙箱模式决定；插件不提供对话授权页面或按会话规则。

### 安全

- **口令组增加设备 pepper**：口令组用 `HMAC-SHA256(pepper, scrypt(口令, salt))` 派生密钥；
  pepper 是 32 字节随机值，存在 `vault.pepper`，和 `vault.json` 分文件。只泄露 `vault.json` 时
  无法离线猜口令；旧口令组会在解锁或下次写回时自动迁移。pepper 丢失会让口令组不可解，
  备份时必须和 `vault.json` 一起保存。
- **封住改加密方式的猜口令侧门**：改模式前的解锁现在和正常解锁共用“60 秒 5 次失败”限速，
  不会再出现一条可以无限尝试的口令路径。

## [0.1.2] - 2026-10-25

### 主要变化

- 看门狗改为 owner/control socket 连接；DSH 重启后能接管已有会话，不再依赖 pid/lease 文件。
- `shell_run` 的退出码和等待语义做了加固：异步启动也能取退出码，退出码不符和超时分开报。
- 工具参数统一为 `target / action / wait / output / safety` 五块；`action.kind` 就是操作。
- 引用库支持引用组、三种加密方式、剩余次数、有效期和烧伤标记。
- 面板增加引用库、宏、工作区和快照；详情页有运行、安全、事件记录、日志审计和键位帮助。
- 适配 DeepSeek Harness `0.1.5-rc.1`–`0.2.1-rc.2`。

### 安全

- 历史退出码伪造面收窄；只接受本 shell 最近一次运行的标记。
- 引用库锁定组拒绝写入；连续错误口令有次数限制；单值和总量有上限。
- 面板和 HTTP 接口增加 Host/Origin、JSON、路径和输入长度检查。
- 引用库列表不返回值，单键读取进审计。

### 体验

- 状态行、搜索、回放和面板窄屏布局整理。
- 首次提示、错误提示统一到消息条和事件记录。
- 文档按用户任务重新整理，只保留安装、工具、安全三部分。

## [0.1.1] - 2026-10-25

### 变化

- 精简安装包，移除从未使用的语言文件。
- 引用库和面板的若干小问题修复。
- 文档链接和版本信息更新。

## [0.1.0]

### 首个公开版本

- 持久 tmux shell、七个 AI 工具、人机双接管面板、哈希链审计、引用库、宏、工作区、快照。
- 支持 Linux（含 WSL2），Node ≥ 20。
