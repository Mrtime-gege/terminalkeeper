---
title: 贡献指南
---

# 贡献指南

> **文档状态（2026-10-21）**：公开版本 **0.1.0**（内部迭代线 0.3/0.4 为历史编号）；当前行为以 `docs/项目文档.md` 与代码为准。


感谢你愿意改进 `terminalkeeper`。这是一个**零构建、零运行期依赖**的小插件：源码就是发布物，
没有编译步骤，也没有测试框架。正因如此，几条约定必须严格遵守，否则改动会在用户机器上静默失效。

## 提 issue 之前

先确认这几件事，能省掉一轮往返：

* **`terminalkeeper` 需要会话模式为 `danger-full-access`**。在 `workspace-write` 下建 shell 会失败
  （报 `error connecting to /tmp/tmux-1000/...`），这是沙箱挡住了 tmux 服务端，不是插件 bug。
* **宿主半改代码后必须重启 `dsh web`**（ESM 模块缓存），**客户端半改代码后必须刷新页面**。
  面板行为异常时先做这两件事，再判断是不是真 bug。
* 报 Shell / 面板问题时，请附上 `shell_diagnose` 的 JSON 输出、`tmux -V`、以及 DSH 版本。
  涉及崩溃或「工具没反应」时，再附宿主日志。
* 报高危命令拦截问题（漏报 / 误报）时，请给出**完整的输入字符串**。拦截是纯文本正则匹配，
  上下文影响结果（例如正文里提到 `sudo` 也会被拦）。

## 环境要求

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | `>=20` | 与 `package.json` 的 `engines` 一致 |
| tmux | 3.x | 本插件在 tmux 3.6b 上开发并验证 |
| DSH 部署 | 带 `cordis` 4 | 宿主半依赖 `@deepseek-ai/cordis`（peerDependency） |

## 仓库结构

```
lib/index.js           宿主半：9 个模型工具、8 个 HTTP 路由、生命周期与看门狗布防
lib/tmux.js            驱动层：tmux 调用、服务端配置、看门狗布防/收养
lib/client.js          浏览器半：classic script，悬浮面板（插槽 shell.overlay）
cordis.patch.yml       bundle 补丁：往宿主 composition 里插入插件行
docs/使用细节.md       配置项全表、面板/输入法细节、工具与 HTTP 参数
docs/项目文档.md     解耦设计、生命周期与孤儿治理、踩坑注记、测试与发布策略
README.md / README.en.md   中文 / 英文说明
README 的「当前版本」           版本记录（发布时按版本段落抽取 Release 说明）
PUBLISHING.md          发布指南：一次性准备、版本策略、两条发布路线、排错
SECURITY.md            安全政策与安全模型（部署前请读）
.github/               CI 与发布工作流、issue 表单、PR 模板
scripts/dev-sync.sh    把源码同步到 profile 的安装位置
scripts/release-check.mjs  发布前不变量检查（npm run release:check）
```

## 本地开发

```sh
# 1. 以 file: 依赖装进一个 profile
dsh plugin --profile web add file:$PWD

# 2. 每次改完源码同步过去（pnpm 对 file: 是拷贝，不是符号链接）
scripts/dev-sync.sh

# 3. 宿主半改动 —— 重启 dsh web
#    客户端半改动 —— 刷新页面
```

`dev-sync.sh` 存在的理由见脚本头部注释：pnpm 会**拷贝** `file:` 依赖，而符号链接又行不通，
因为 Node 的 ESM 解析走 realpath，链到本包目录后插件自己的 `@deepseek-ai/*` 依赖就解析不到了。

## 代码约定

* **纯 JavaScript，没有 TypeScript、没有编译步骤。** 宿主半是 ESM（`import` / `export`），
  客户端半是 **classic script**：`lib/client.js` 里出现任何 `import` / `export` 都会让浏览器端整体崩掉
  （`release:check` 会拦住这种改动）。React 用 `require('react')` 取，元素用 `React.createElement`
  而不是 JSX。
* **不新增运行期依赖。** 仓库没有 `devDependencies`，也不提交 lockfile：只用 Node 标准库和
  `peerDependencies` 里声明的宿主包。确实需要新宿主包时，必须同时加进 `peerDependencies` 并更新
  `scripts/release-check.mjs` 里的检查表。
* **所有副作用必须可回收。** 定时器、监听器、工具、HTTP 路由、样式都要挂在当前 Fiber 上
  （用 `ctx.effect()` / `ctx.on()` 返回的 disposer），保证 stop / update / 卸载时干净退出。
* **不要 `JSON.stringify` 宿主活对象**（Service、Session、Cordis 对象）。只读需要的叶子字段，
  自己拼一个最小的普通对象。
* **改行为就改文档。** 新增或改名配置项、工具、HTTP 路由时，同一次提交里更新
  `README.md` 首页与 `docs/使用细节.md` 的对应表格，以及 `cordis.patch.yml` 里的配置样例。

## 提交与推送

* **公开仓库只放版本级提交。** 平时在本地 commit（粒度随意），**不推公开仓库**；粒度历史用
  `bash scripts/backup-push.sh` 备份到**私有**远端 —— 那是开发中随时回滚的依靠。
* **发版才动公开仓库**：`bash scripts/release-prepare.sh <版本>` 把自上个 tag 以来的全部提交压成**一个**
  发布提交再推，并打 tag 触发发布。`--push` 等于发布，按铁律只有维护者本人能下这个决定。
* 在**公开**仓库开 `wip`/`dev` 分支是没用的 —— 分支一样公开可见，所以粒度历史只能进私有远端。
* 提交信息写**为什么**，不只是改了什么；根因与验证方式写进 `内部开发记录（已移除）`。

## 提交前必须跑

```sh
npm run check          # node --check 三个源文件（语法）
npm run release:check  # 发布不变量：版本/CHANGELOG、只发必要文件、README 链接、文档身份、入口可达、客户端形态、凭据泄漏
npm run leak:history   # 全历史泄露扫描（含所有标签）—— 往公开仓库推之前值得跑一次
python3 scripts/npm-unpublish-webotp.py --dry-run 0.1.0   # 撤销已发布版本：只读预演（真跑见 PUBLISHING.md §9.4）
npm run test:longrun   # 长任务/并发/工具链（真 tmux；真实环境测试只保留这一套）
```

前两条都必须通过。`release:check` 故意做得很啰嗦，它拦住的问题（客户端半被写成 ESM、
`files` 白名单里多带或少带文件、README 里出现会在 npm 页面上断掉的相对链接、**整份文档被别的内容
覆盖**、源码里留下开发机绝对路径）在发布后才发现会很难受。

> `release:check` 只扫**工作树**，它拦不住「工作树修好了、历史提交里还留着」—— 那正是发生过的事。
> 所以另配了 `npm run leak:history`（两者共用 `scripts/lib/leak-rules.mjs`，避免规则漂移）。
> 两款扫描都**不要改窄**：扫描范围本身就出过一次事故，处理流程见 `PUBLISHING.md` 第 8 节。

`npm run test:longrun` 针对的是**真实 tmux 环境**（长任务/并发/工具链/提权链路）；打包产物一致性由 `npm test` 里的 test-pack 覆盖。smoke/test-edge 已于 2026-10 移除，真实环境测试只保留这一套。

## 怎么验证

本仓库没有测试框架，用下面两种方式替代，**请在 PR 描述里写清你实际跑了哪种**：

1. **宿主半脱离 DSH 验证。** 构造一个假 `ctx`（包一层 `child_process.spawn` 当 `subprocess`、
   假 timer、假 `webServer`），直接调 `apply()`，把工具注册、HTTP 路由、生命周期、看门狗都走一遍。
   注意 `ctx.effect` 的语义：必须**立即调用**回调并保存它返回的 disposer。
2. **纯函数离线验证。** `lib/client.js` 里的 `decideKey(e)` 与 `decideComposition(kind, state)` 是
   模块级纯函数，并挂在 `__decideKey` / `__decideComposition` 上，可以不启浏览器直接断言按键与
   输入法提交的判定结果 —— 输入法相关的回归正是靠它守住的。

改了面板交互（按键、锁定、输入法、持久化位置）时，请在真实浏览器里至少手工过一遍：
英文输入、中文输入法上屏、锁定时误触、多 shell 切换、拖拽缩放。

## 发布

发布由维护者执行，不要在 PR 里改版本号。完整流程（一次性准备、版本策略、NPM_TOKEN 与
Trusted Publisher 两条路线、发布后验证、出问题怎么补救）见 **[PUBLISHING.md](PUBLISHING.md)**；
下面只是贡献者需要知道的最小版本：

1. **三处同步**：`package.json` 的 `version`、`README 的「当前版本」` 顶部新增 `## <version> — <标题>`
   段落（格式与现有段落一致）、以及 `lib/client.js` 里的 `PKG_VERSION` 戳记 ——
   `release:check` 会校验三者互相一致；
2. `npm run release:check`；
3. 提交并打 tag `v<version>` 推上去 —— `.github/workflows/release.yml` 会校验 tag 与
   `package.json` 版本一致，然后 `npm publish --provenance --access public`，
   并用 CHANGELOG 里对应段落作为 Release 说明。

## Pull Request

* 一档改动做一件事，便于审阅与回滚。
* 描述里写清：**动机**（解决什么实际问题）、**行为变化**（用户可见的部分）、**验证方式**。
* 有破坏性变更（改配置项语义、改工具参数名、改 HTTP 路由）时，明确写出迁移步骤。
* 涉及面板视觉的改动请附截图或录屏。

## 许可

提交贡献即表示你同意以本仓库的 [MIT 许可证](LICENSE) 授权你的贡献。
