# 变更日志

本文件记录用户可见的变化。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)；`0.x` 阶段破坏性改动会在条目里**显式标注**。

发布规则：`package.json` 的版本必须在本文件里有对应段落（`npm run release:check` 会拦）。
条目面向**使用者**写「改了什么、怎么改的」，不复述实现细节。

## [Unreleased]

### 文档

- **全文重写 `docs/使用细节.md`**（旧版仍写扁平参数，已整体过时）与 `docs/工具参数手册.md`（改为结构/规则/常见错误，参数表指向自动生成的 `docs/参数定义.md`）。
- 全量核对 `README.md`、`SECURITY.md`、`项目文档.md`、`引用库安全模型.md`：修掉 `until`、`claim`、`watch/unwatch`、`confirm`、`offset`、`shell_close`、`oneShot` 等已删除的旧 API 与旧术语。
- 引用库文档改为现行「剩余可用次数（`maxUses`/`uses`/`remaining`）」模型：面板是**输入框**不是复选框，1 = 一次性，用尽自动销毁并留烧伤标记。
- 面板「剩余可用次数」输入框与服务端语义对齐：输入 N = 还能再用 N 次（提交时换算 `maxUses = 已用 + N`），改值不重置已用次数。

### 新增

- **参数定义单一事实源**：`lib/param-spec.mjs` 定义每个参数的类型/单位/默认值/范围/必填/含义；
  `docs/参数定义.md` 由它生成（`npm run docs:params`），`npm run test:params` 双向核对代码与定义，
  改了定义却忘了同步文档会直接失败。


- 面板详情页新增「总览」：一眼看到运行状态、版本、终端数量与关键指标。
- 统一能力探测快照（`state.caps`）：环境能力只探测一次，面板 / `/diagnose` / `/list` 都读同一份结果；
  新增 `POST /probe` 可按需重探。设置页「能力与受限项」与控制模式不再各说各话。
- 错误码体系：界面提示统一为「人话（错误码 X）」；`README` 与帮助页新增错误码对照表。
- `docs/PUBLISHING.md` 新增发布检查单；新增夜间长任务工作流。
- `CHANGELOG.md`（本文件）。

### 变更

- 详情页页签从 11 个收拢为 8 个（状态 / 记录 / 帮助三层），条目内容不变。
- 面板与设置页文案改为「人话 + 括号里的技术词」；帮助页新增术语对照表。
- 表格列宽：富余宽度按内容比例分配（窄列不再被撑宽），并支持单列上限。
- 引用组列表「键值对」列改名为「键数」并收窄；操作列按钮不再换行。
- `test-env` / `bench-runtime` / `test-longrun` 迁移到新的 `tasks` 工具参数结构（共享兼容层）。

### 工具说明与命名

- `shell_run` 的返回里带 `run=<id>`；`shell_read` 的 `wait.kind=exit` 新增 `runId`，可把退出码等待绑定到**某一次具体的运行**（同一 shell 先后跑多条命令时不会认错）。
### 工具说明与命名

- `shell_read` 的 `watch` / `unwatch` 增加正名 `subscribe` / `unsubscribe`（旧名保留为别名，不破坏现有调用）。
- `safety.confirm` 增加正名 `bypassGuard`（它的行为是“跳过守卫”，原名易误解；`confirm` 仍可用，两者冲突会被拒）。
- 工具说明补充：`shell_open` / `shell_state` 的返回结构、4 段端到端示例（长命令的异步跑 + 增量读 + 回读退出码）。
- 修正文档自相矛盾：`idle` 的含义（“等回到空闲”，不是“不等待”）、单位约定（`Ms` 后缀才是毫秒）。

### 破坏性变更（不再保留别名）

- `shell_read` 的 `watch` / `unwatch` 动作删除，统一为 `subscribe` / `unsubscribe`。
- `safety.confirm` 删除，统一为 `safety.bypassGuard`（原名与行为相反）。
- `shell_read` 的 `offset` 删除，搜索分页统一为 `matchOffset`。
- `shell_manage` 的 `snapshot` 不再接受 `name`（实现本来就按会话 id 存）。
- `shell_manage` 的 `idle` 参数 `minutes` 改名 `idleMinutes`（与 `shell_open` 一致）。

### 变更

- 详情头部的「扫描占用」按钮并入「日志审计」页（顶部「刷新统计」+ 占用摘要），同一件事只留一个入口；
  总览的「审计占用」卡改为跳转「日志审计」，安全页只保留一行指向。
- 修跨层跳转错位：总览卡指向「日志审计」时同时切换大层，不再出现“内容换了、页签还停在状态层”。

### 修复

- **三级页签悬停闪烁、点击常失效**：`LogPage` 在渲染里新建组件函数 ⇒ 每次父级渲染整棵日志页
  remount（hover 状态丢失、mousedown/up 跨重建导致 click 不派发）。改为稳定的 `DeferredRegion`
  宿主（类型只定义一次，内容延迟到子级渲染求值），DOM 节点跨渲染复用。
- **二级页签绿条闪一下就没**：选中态 `border:0` 把 2px 下划线宽也清零。改为 `border-bottom:2px solid`
  常显，并加大点击热区（二级 27px / 三级 21px，间隙 2px）。

- **提示历史（事件记录页）永远为空**：`notices.json` 尾部损坏后，旧逻辑读回空表且拒绝写回，
  该页从此不再记录任何提示。现在 `notices` 损坏会被隔离为 `notices.json.corrupt-<时间戳>`
  并从空表重建（可再生的界面历史）；vault / macros / consent 等关键域仍保持 fail-closed。
  新增 `test-notices` 覆盖“隔离—重建—写入—读回”与“关键域不被覆盖”。

- 引用组删除会同时发出两条删除请求，导致同一错误提示弹两次（并构成竞态）。
- 表单失败时 `setError` 与额外 `notify` 各弹一次，同一件事显示两条提示。
- 「插件状态」取数条件仍指向已合并的旧页签，导致该段永远停在「读取中」。
- supervisor 所有 RPC 共用 1500ms 预算，并发写同一 shell 时 2 秒命令被误判超时（命令实际已执行）；
  慢方法改为 30s 预算。构建号 c85。
- 信息泄露门禁规则过旧：补 WSL/Windows 绝对路径、真实邮箱、私网网段、Bearer、手机号/身份证；
  修正 Windows 路径正则永远匹配不到的问题；新增 12 条规则自检。

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