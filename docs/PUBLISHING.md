---
title: 发布指南
---

# 发布指南

> **文档状态（2026-10-21）**：公开版本 **0.1.0**（内部迭代线 0.3/0.4 为历史编号）；当前行为以 `docs/项目文档.md` 与代码为准。



## 0.4.1 起：公开面规则与「重建仓库」流程

> 起因：GitHub 仓库**没有白名单** —— 提交即公开（与 npm 包相反，后者是 `package.json` 的 `files` 白名单）。
> 为避免再次出现「非必要/内部资料被公开」与「历史里残留开发机信息」，采用**删库重建 + 单提交干净历史**。

### 一、公开面白名单（由门禁强制）

- **规则**：公开仓库 = 提交即公开 ⇒ `docs/` 下**只允许** `scripts/test-public-surface.mjs` 的 `ALLOWED_DOCS`
  里**登记过**的文件；任何新增 docs 文件必须显式登记 ⇒ 每次扩公开面都是一次**有意识的决定**。
- **内部资料不进公开仓库**（本地保留、不跟踪；已写入 `.gitignore`）：
  `内部开发记录（已移除）` · `README 的「当前版本」` · `长任务测试.md` · `引用库安全模型.md` ·
  `功能方案-待办.md` · `archive/` 内的设计稿。
- 确需公开某份内部资料时：**先逐行确认**无个人标识/主机名/内网地址/密钥键名/内部决策，**再**登记进白名单。
- 三道互补门禁：`test-public-surface`（公开面白名单）· `test-leak`（个人标识/运行期数据）·
  `test-pack`（npm 包内容）；另加 `release-check`（结构与隐私）。

### 二、重建仓库（删库重建）流程

1. **先准备干净的单提交历史**（旧历史不带过去 —— 这正是重建的意义）：
   ```
   git checkout --orphan clean-init
   git add -A && git commit -m "初始提交"
   ```
2. **新仓库地址确定后**（由用户创建空仓库）：
   ```
   git remote set-url origin <新仓库地址>
   git push -u origin clean-init:main --force
   git branch -f main clean-init && git checkout main
   ```
3. **打 tag 与 npm 发布**：
   - **npm 由维护者新建并发布**，版本**从 `0.1.0` 重新开始**（旧包 0.4.x 的版本号与发布记录一概沿用）。
   - 改版本时**必须同步两处**：`package.json` 的 `version` 与 `lib/client.js` 的 `PKG_VERSION`
     （`release-check` 会拦住不一致；`test-docs` 还会要求 README 里出现该版本号）。
   - 顺序：**门禁全绿** → `git tag -a vX.Y.Z` → 推送 main 与 tag → 维护者 `npm publish` → 复核。
4. **发布前必须**：**首次可用盲测通过**（见 `docs/首次可用标准.md`；静态部分已接入 `npm test` 的 `test-first-use`，人工盲测每次发布跑一次）与 `npm test`（含公开面门禁 / 泄露门禁 / 文档门禁 / 发布包门禁 / 若干静态断言）与
   `node scripts/release-check.mjs` **全绿**；`node scripts/test-pack.mjs` 打印的清单人工过一眼。
5. **发布后**：`git push backup <branch>`（私有备份仓）保留完整历史 ✓ —— 公开仓只留干净历史。

### 三、兼容政策（0.1.0 起）

**自首次公开版本（0.1.0）起，不提供对内部迭代版本的任何兼容**：不做旧数据迁移、不保留旧配置键与旧 UI 机制。

- 引用库只认 **v2** 格式；读到旧的 v1 扁平表 ⇒ **拒绝**并提示备份后重建（不静默迁移、不覆盖）。
- 旧配置键与旧面板提示机制一律删除；所有提示统一走提示系统（右上角提示条 + 详情「提示信息」历史）。
- 任何「为了不破坏旧数据」而写的兼容分支都不再接受 —— 宁可明确报错，也不要静默采用旧语义。

### 四、两条不再变的纪律

- **报告/内部文档不随发布走**：长任务测试报告（历史报告已按用户要求清理）、内部设计规范只留本地与备份仓。
- **密码与真值永不入库**：引用库真值在 `~/.dsh/terminalkeeper/`（仓库外）；仓库里只允许出现**键名**，
  且键名也建议用占位写法（本仓三道门禁都会检查）。


## 发布包内容：白名单 + 可执行门禁

`package.json` 的 `files` 是**白名单**（只列运行时必需项），因此测试与开发文件**默认不进包**：

| 类别 | 是否进包 | 例子 |
|---|---|---|
| 运行时 | ✅ | `lib/`（index / args / pure / client / tmux / audit / consent / env / watchdog / config-local）、`bin/`、`locale/*.json`、`cordis.patch.yml`、`icon.svg` |
| 用户文档 | ✅ | `README.md` / `README.en.md` / `LICENSE` / `docs/SECURITY.md` |
| **测试夹具与开发脚本** | ❌ | `scripts/**`（含 test-client / test-pure / test-args / test-tool-scope / test-disjoint / test-nonce / test-summary / test-pack …） |
| **测试报告** | ❌ | `docs/*报告*.md`、`docs/长任务测试.md` |
| **开发文档** | ❌ | 更新记录 / CHANGELOG / PUBLISHING / 工具参数手册 / 使用细节 / 设计与实现 / CONTRIBUTING |
| **调试残留** | ❌ | `*.new` / `*.bak` / `*.log` / `*.tgz` / `*.map` |

**门禁**：`node scripts/test-pack.mjs`（已接入 `npm test`）调用 `npm pack --dry-run --json` 取**真实清单**，
逐条断言「必须排除的已排除」+「必须包含的仍在」—— 白名单被改宽、或运行时文件漏列，都会立刻失败。
当前清单 **21 个文件**（包大小约 385kB / 解包约 1.1MB）。

## 发布前检查清单（按序执行，缺一不可）

1. **断言测试**：`npm test` 全绿（含**发布包门禁**、六道静态断言、pure/client/args 等）—— 每次改动/提交前必跑，**不过即阻断**
2. `npm run release:check` 通过
3. **长任务测试跑两次**（每轮 ≥10 分钟，含五层嵌套与故障注入）：第一遍发现问题，第二遍**在最终待发布提交上**确认修复后仍正常；两遍都要有报告且**无未解释的失败项**
4. `npm pack --dry-run` 复核清单（测试/调试文件不在其中；运行时文件齐全）
5. 版本号一致：`package.json` / `lib/client.js` 的 `PKG_VERSION` / README / 更新记录
6. 提交并推送，确认工作树干净；`git tag` 记版本

## 发版前必跑：长任务稳定性测试（硬门禁）

**每次发布（`npm publish` / 打 tag / 交付）之前，必须完整执行 [`docs/长任务测试.md`](./长任务测试.md)，
并按其中的报告模板给出报告。未跑、或报告里有未解释的失败项 ⇒ 不得发布。**

理由：单元测试（`test-client` / `test-pure` / `test-args` / `release-check`）覆盖不到"真实交互 + 并发 + 嵌套"；
本插件历史上的**三个运行时 bug**（对象字面量作用域、裸 `args`、`...args` 被正则漏掉）与**两个实测缺陷**
（`wait.for` 收空、`submit` 无人消费）全部是该长测抓出来的。

该长测覆盖：10 壳并发、任务间并行/同壳串行、六种 `wait` 条件、vim/top/python 交互、死循环与中断、
sudo 与 ssh 密码链路（引用库）、`ssh→wsl` 单层绕行与**五层嵌套**、`shell_state` 过滤矩阵、
`shell_manage` 全 18 个 kind、`shell_audit` 参数、负向参数规则、稳定性取证与收尾纪律。

本文件是 `terminalkeeper` 的完整发布教程：**发到 GitHub** 与 **发到 npm** 的全流程，
包含版本策略、自动化检查、provenance、回滚，以及会踩的坑。

按顺序做完即可。第一次发布约 20 分钟，后续每次发版约 3 分钟（见[第 5 节](#5-每个版本的发布清单)）。

> ## ⚠️ 铁律：发布必须由维护者明确要求
>
> 「推 tag」是唯一的发布扳机，而**只有人类维护者可以按它**。AI 助手在任何情况下都不得自行
> `npm publish`、推 tag、撤销已发布版本、或改动 dist-tags —— 即使测试全绿、即使文档读起来
> 「就差这一步」。要做这些事时，正确动作是**说明理由，然后等明确指令**。
>
> 同理，`git push --force`（历史改写）这类不可逆操作也只在维护者明确要求时执行。

---

## 0.0 发布白名单（默认不发布）

npm 包与 GitHub 发布目录都**只发布显式登记的文件**：

- `release/publish-files.json` —— npm 运行文件的唯一白名单（38 个）。**新增文件默认不发布**，要发布必须手动加进这个文件；
- `docsInclude`（`release/manifest.json`）—— 公开文档白名单；
- 新增运行文件后 `npm test` 会失败（`test-publish-manifest`），提示你先做决定：加白名单，或写进 `release/internal-runtime.json` 豁免（内部文件，不发布）。

发布前依次跑：

```sh
npm test                 # 含白名单门禁
npm run release:tree     # 生成 GitHub 发布目录（只复制白名单）
npm run release:check    # 禁止项 / npm 包 == 白名单 / 泄露 / 元数据
```

## 0. 一次性准备

| 项 | 要求 | 检查命令 |
|---|---|---|
| Node / npm | ≥ 20（实测 Node 24 / npm 12） | `node -v && npm -v` |
| npm 账号 | 已注册 + **已验邮箱** + 已开 2FA | `npm whoami` |
| 包名 | **`terminalkeeper` 在公共 npm 上无人占用**（已核实） | `npm view terminalkeeper version` → 期望 `E404` |
| git 身份 | 用于 commit 署名 | `git config user.name && git config user.email` |
| GitHub | 账号；有 `gh` CLI 更省事 | `gh auth status` |

> npm 现在对发布强制要求 **2FA**：手工 `npm publish` 会要一次性验证码（OTP）。
> **本仓库已改用 Trusted Publisher**（见 [4.1](#41-路线-atrusted-publisher--oidc--本仓库已配置默认路线)）：
> 推 tag 由 CI 用 OIDC 身份发布，既不需要 OTP，也不需要长期 token。

**npm 与 GitHub 的关系**：两者互相独立。GitHub 放源码，npm 放可分发的包。
本指南两条都做，npm 上的 `repository` 字段会让 npm 页面显示「源码在 GitHub」。

---

## 1. 发布前自检（已自动化，务必跑）

```sh
npm run check           # 语法：node --check 三个入口文件
npm run release:check   # 发版不变量（见下）
npm pack --dry-run      # 真实打包清单，看有没有漏文件/多文件
```

`release:check` 会机械地卡住这几类事故：

| 检查 | 不通过会怎样 |
|---|---|
| `package.json` 版本号是合法 semver、且**不是 `private`** | 发不出去 / 发出去了也装不上 |
| `README 的「当前版本」` 里有 `## <当前版本>` 段落 | 版本记不住改了什么 |
| `files` 白名单**恰好等于**「必要文件」集合（见 [5.1](#51-只发必要文件files-白名单)） | 少发 → 装完插件起不来；多发 → 把仓库内部文件搬上公开注册表 |
| 两份 README 里没有相对链接，仓库绝对链接指向真实文件 | 相对链接在 npm 页面上必然断（且天然指向仓库内部文件） |
| 九份文档的**首行标题与身份一致、且互不重复** | 整份文档被别的内容覆盖却没人发现（真实事故，见 §8） |
| `main` / `exports` 指向的文件**存在且在白名单内** | 用户 `import` 直接 404 |
| `peerDependencies` 覆盖 `@deepseek-ai/cordis`、`dsh-tools`、`schemastery`、`react` | 用户在别的 DSH 版本上炸 |
| `lib/client.js` 仍是 **classic script**（没有 `import`/`export`） | 面板在浏览器里整体崩掉 |
| `lib/client.js` 的 `PKG_VERSION` 与 `package.json` **一致** | 用户报障时报错版本 |
| 源码里没有泄漏 `/home/<user>/` 路径、私钥、npm/GitHub token | 隐私与凭据事故 |
| `cordis.patch.yml` 仍在 insert `id: terminalkeeper` | 装了但什么也不做 |

`npm publish` 会自动先跑一遍（`prepublishOnly`），所以这一步是双保险；
但**在打 tag 之前**手动跑一次，能避免打出「代码有问题」的 tag。

---

## 2. 决定版本号（版本策略）

### 2.1 语义

当前处于 **`0.x`**：

| 变更 | 版本 | 例子 |
|---|---|---|
| 修 bug、文档、不影响行为的重构 | **patch** `0.1.0 → 0.1.1` | 修 IME 提交时序 |
| 新功能、**`0.x` 下允许的破坏性改动**（改工具名/参数、改 UI 结构、改 HTTP 路由、提高 peer 下限） | **minor** `0.1.1 → 0.2.0` | 新增 `shell_rename` |
| 预发布 | `0.2.0-rc.1` / `0.2.0-beta.2` | 先让少数人试 |

> `1.0.0` 之后语义反转：破坏性改动才升 major。在 `0.x` 阶段请把**破坏性改动写进 CHANGELOG 的醒目位置**。

### 2.2 一次发版必须同步三处（不要漏）

```sh
# 1) 版本号（会顺带打 git tag，见 3.3）
npm version patch --no-git-tag-version     # 或 minor / major，或 npm version 0.2.0-rc.1

# 2) README 的「当前版本」 —— 手工加一段，标题必须是 "## <版本>"

# 3) lib/client.js 里的版本戳记（面板会显示给用户看）
```

第 3 步是唯一需要手工改代码的地方，`release:check` 会强制它与 `package.json` 一致：

```sh
grep -n "PKG_VERSION = " lib/client.js     # 改完再跑一次 npm run release:check
```

面板指标行显示 `v0.1.0 · c541` —— 用户报障时直接报这一行，你就能判断他跑的是哪一版。

### 2.3 预发布不要污染 `latest`

```sh
npm version 0.2.0-rc.1 --no-git-tag-version
npm publish --tag next        # 装到 next 上；latest 仍是 0.1.x
# 转正式：改回 0.2.0、更新 CHANGELOG，然后 npm publish
```

---

## 3. 发布到 GitHub

### 3.1 首次：建立仓库

这台机器上**已经**执行过 `git init -b main` 与 `git add -A`（24 个文件已暂存，未提交），
所以下面第 1 步之后可以直接提交。

```sh
cd ~/terminalkeeper

# 1) 先配提交署名 —— 没配过身份时 git 会直接拒绝提交（"Please tell me who you are"）。
#    只在没配过的时候需要；配过就跳过。
git config --global user.name  "你的名字"
git config --global user.email "you@example.com"

# 2) 首次提交
git commit -m "feat: terminalkeeper 0.1.0 — 持久化多 shell 终端面板"
```

> 想用不同身份提交这个仓库，把 `--global` 换成不带参数（只写入本仓库的 `.git/config`）。
> 提交之后再改身份不会改历史，改历史要 `git commit --amend --reset-author`（未推送时可用）。

用 `gh` CLI（最省事）：

```sh
gh auth status
gh repo create terminalkeeper --public --source=. --push
```

> 本机**没有装 `gh`**（`command -v gh` 无输出）。要装：`sudo apt install gh` 后 `gh auth login`；
> 不想装就走下面的手工路线，效果一样。

或者手工：在 GitHub 上新建一个**空仓库**（**不要**勾选 README / .gitignore / LICENSE，
否则会和本地已有的冲突，push 会被拒），然后：

```sh
git remote add origin git@github.com:Mrtime-gege/terminalkeeper.git
git push -u origin main
```

### 3.2 仓库专属的占位内容（本仓库已填好）

本仓库的地址已经按实际归属 **`Mrtime-gege/terminalkeeper`** 填进去了，这一步通常**不用再做**，
只在换用户/组织名时才需要复查一遍：

```sh
grep -rn "OWNER\|<你的用户名>" . --include="*.md" --include="*.yml"   # 应当只剩 PUBLISHING.md 自己
```

已经就位的位置：

* `README.md` / `README.en.md` 顶部的 **CI 徽章**（指向 `github.com/Mrtime-gege/...`）；
* `.github/ISSUE_TEMPLATE/config.yml` 里的 Discussions 与私有漏洞报告链接；
* `package.json` 的 `author` / `repository` / `homepage` / `bugs`
  —— 用的是 GitHub 的 **noreply 邮箱**（`<数字ID>+<用户名>@users.noreply.github.com`），
  不把真实邮箱写进公开的包元数据与提交历史。数字 ID 可以用
  `curl -s https://api.github.com/users/<用户名> | grep '"id"'` 取到（本项目是 `327958341`）；
* `LICENSE` 的版权行 `Copyright (c) 2026 Mrtime-gege`
  （MIT 保留年份与版权人即可，改这一行不影响其余条款）。

改完 `npm run release:check` 再跑一次，然后提交：

```sh
git add -A && git commit -m "chore: 填上仓库地址与作者元数据"
```

### 3.3 打标签（tag 是「发布」的扳机）

```sh
git tag -a v0.1.0 -m "terminalkeeper 0.1.0"
git push origin v0.1.0
```

tag 名必须是 **`v<package.json 里的 version>`**：`release.yml` 会校验两者一致，不一致直接失败 ——
这样能挡住「tag 打了 v0.2.0 但包还是 0.1.0」这种最常见的事故。

打了 tag 会触发 GitHub Actions 的发布工作流：它跑检查 → `npm publish --provenance` →
用对应版本的 CHANGELOG 段落创建 GitHub Release。
**这需要先在仓库里配置 `NPM_TOKEN`**（见 4.1）；没配的话工作流会失败，但 tag 本身没坏，
按 [4.2 本地发布](#42-手工发布本地-npm-publish) 补发即可。

---

## 4. 发布到 npm

有两条路：CI 自动发（推荐，带 provenance）和本地手工发（第一次最直观）。
**任选一条**，不要对同一个版本两条都跑（会撞 `E403: cannot publish over existing version`）。

### 4.1 路线 A：Trusted Publisher / OIDC —— **本仓库已配置，默认路线**

**推一个 tag 就完事了**，CI 用 OIDC 身份发布，仓库里**不需要任何长期密钥**（没有
`NPM_TOKEN` 可泄漏），并且**自动带 provenance 签名**。

本仓库当前状态（2026-09 配置）：

```
package: terminalkeeper
type: github   file: release.yml   repository: Mrtime-gege/terminalkeeper
permissions: publish, stage publish
id: 075d17aa-972e-4d5e-a421-8d7fda9ce481
```

本仓库**没有**配 `NPM_TOKEN` secret —— 这正是信任发布生效的证明（工作流会打印
「未配置 NPM_TOKEN，改走 Trusted Publisher（OIDC）发布」）。所以：**不要**为了「图省事」
再手工 `npm publish` 一个已经推过 tag 的版本，那样会绕过签名。

配置命令（npm ≥ 11.6 提供 `npm trust`，一次配置长期有效，需要一次 2FA 授权）：

```sh
npm trust github terminalkeeper \
  --file release.yml \
  --repo Mrtime-gege/terminalkeeper \
  --allow-publish

npm trust list terminalkeeper          # 查看现有信任关系
npm trust revoke terminalkeeper --id=<trust-id>   # 撤销
```

> 为什么值得切过来：`release.yml` 的 OIDC 步骤会先写一份**干净的 userconfig**（只留 registry，
> 不出现任何 `_authToken` 行）—— `actions/setup-node` 生成的 `_authToken=${NODE_AUTH_TOKEN}`
> 占位符会让 npm 以为要用 token 认证，那是 OIDC 发布最常见的坑。

### 4.2 路线 B：手工发布（本地 `npm publish`，仅在 CI 不可用时兜底）

本账号是**写入强制 2FA**，所以本地发布会弹一次浏览器授权（npm 会打印一个
`https://www.npmjs.com/auth/cli/<id>` 链接）。0.1.0 / 0.1.1 都是这样发的 ——
代价是**没有 provenance 签名**，所以现在只当作兜底路径。

```sh
npm login            # 浏览器/OTP 流程；npm 12 默认走 web 登录
npm whoami           # 必须打印出你的用户名，否则后面必然 401

npm run release:check    # 最后一次自检
npm publish              # package.json 里 publishConfig.access=public，不用再加 --access

# 预发布则用：npm publish --tag next
```

发布成功后会打印 `+ terminalkeeper@0.1.0`。

### 4.3 发布后立刻验证（不要只看「成功」两个字）

```sh
V=0.1.3
npm view terminalkeeper version                  # 期望就是 $V
npm view terminalkeeper dist-tags                # latest 指向 $V（预发布则看 next）
npm view terminalkeeper files --json             # 期望看到 lib/ 与 cordis.patch.yml

# OIDC 发布的**关键证据**：必须有 attestations（手工发布是「无」）
npm view terminalkeeper@$V dist.attestations --json
npm audit signatures                              # 本地校验签名链

mkdir -p /tmp/pkgcheck && cd /tmp/pkgcheck
npm pack terminalkeeper@$V && tar -tzf terminalkeeper-$V.tgz | head -20
```

**一条命令分辨「这次是谁发的」**：`dist.attestations` 为「有」= CI 通过 Trusted Publisher
发的（带 provenance）；为「无」= 有人手工发的。发版后顺手看一眼，等于确认自动化没有退化成手工。

最后做一次**真实安装**验证（这是唯一能证明 patch 与客户端产物都在包里的办法）：

```sh
dsh plugin --profile web add terminalkeeper@0.1.0
# 重启 dsh web，确认：右下角出现胶囊；面板指标行显示 v0.1.0
```

### 4.4 Trusted Publisher 也可以从网页配（等价做法）

命令行不方便时，用网页等价操作：npm 包页面 → **Settings → Trusted Publisher** → 选
**GitHub Actions** → 填组织/用户名、仓库名 `terminalkeeper`、workflow 文件名 `release.yml`
→ 保存。两种方式改的是同一份配置。

> 两处必须一致：**workflow 文件名**（`release.yml`）与**仓库全名**（`Mrtime-gege/terminalkeeper`）。
> 名字对不上时 CI 会以 `403`/`404` 失败，报错不会点名是这里配错了 —— 而路线 B 的手工发布
> 完全不受影响，所以这种错很容易被误判成「npm 抽风」。改过工作流文件名的话，记得同步这里。

---

## 5. 每个版本的发布清单

> **发布模型（维护者要求）：公开仓库只看到版本级的提交。**
>
> * 平时开发在本地 commit，**不推公开仓库**；粒度提交持续备份到**私有**远端（`scripts/backup-push.sh`），
>   供开发中随时回滚。
> * 发版时把「自上个 tag 以来的全部提交」**压成一个** `release: <版本>` 提交再推 —— 外人只看到每个版本一个
>   提交，中间怎么改、改了几次、commit message、半成品状态都不可见。
> * 推 `v<版本>` tag 就是发布扳机（一次推送 = 一个版本）。
>
> 落地成一条命令：`bash scripts/release-prepare.sh <版本>`（默认**预演**，只打印会做什么；
> 加 `--push` 才真的执行，而 `--push` 等于发布 —— 按铁律只有维护者本人能下这个决定）。
>
> 压缩**不改变工作树内容**：脚本会校验发布提交的树与开发树逐字节相同，不一致就中止且不推送。

**现在只有「推 tag」这一步是必须人工触发的**，其余全自动。日常改动写进 CHANGELOG 的
`## 未发布` 一节、`内部开发记录（已移除）`（完整根因）与 README 的「最近更新」；发版时把它变成版本号。
**版本日期一律按北京时间（UTC+8）记**（取日期用 `TZ=Asia/Shanghai date +%F`），不要混用 UTC：

```sh
V=0.1.4
# 1. 改代码 → 日常自查
npm run check && npm run release:check

# 2. 定版本：三处必须同步（package.json / README 的「当前版本」 / lib/client.js 的 PKG_VERSION）
#    release:check 会机械校验这三者一致，漏了会直接 fail
npm version "$V" --no-git-tag-version
sed -i "s/const PKG_VERSION = '[^']*'/const PKG_VERSION = '$V'/" lib/client.js
$EDITOR README 的「当前版本」             # 「## 未发布」→「## $V — 标题」
$EDITOR README.md                # 「### 未发布（下一个版本）」→「### $V — 标题」
npm run release:check            # 必须通过

# 3. 提交到本地（不要推公开仓库）
git add -A && git commit -m "wip: …"

# 4. 备份粒度历史到私有远端（随时可回滚）
bash scripts/backup-push.sh

# 5. 发版：把自上个 tag 以来的提交压成一个 + 打 tag + 推公开仓库
bash scripts/release-prepare.sh "$V"          # 先预演
bash scripts/release-prepare.sh "$V" --push   # 等于发布：推 main（力推）与 v$V tag

# 5. 验证（等 CI 跑完，绿灯即已发布）
npm view "terminalkeeper@$V" dist.attestations --json   # 期望：有
```

### 5.1 发布前检查单（勾完再打 tag）

机器能判的走脚本，人才能判的留空给人。**任何一项没勾，不要推 tag**。

**自动（必须全绿）**

- [ ] `npm run check` —— 语法
- [ ] `npm test` —— 含泄露 / 文档 / 公开面 / 打包 / 工具作用域等门禁
- [ ] `npm run release:check` —— 含「版本三处一致」与「CHANGELOG 有本版段落」（0.1.0 起强制）
- [ ] `npm run test:longrun` —— 长任务 + 5 路并行；或确认最近一次夜间 `Long run` 为绿
- [ ] `npm run test:matrix` —— 工具 × 参数矩阵
- [ ] `git tag` 与 `package.json` 版本一致（release.yml 会再拦一次）

**人工（机器判不了）**

- [ ] 首次可用盲测：空白上下文的模型只读 README + 工具说明，能独立完成
      「开终端 → 跑命令 → 读回输出 → 关终端」（标准见 `docs/首次可用标准.md`）
- [ ] 面板在真实浏览器过一遍：亮/暗主题、中英输入、锁定态、多 shell 切换
- [ ] 破坏性改动已在 CHANGELOG 里**显式标注**（`0.x` 阶段尤其重要）
- [ ] 卸载可走通：`node purge-all.mjs --dry-run` 清单正确、不误删用户数据

**发布后**

- [ ] `npm view terminalkeeper@$V version` 与新 tag 一致（OIDC 发布时顺带确认 attestations）
- [ ] GitHub Release 正文取自 CHANGELOG 的对应段落（不要另写一份）
- [ ] CHANGELOG 的 `## [Unreleased]` 重新留空并保留标题

> 工作流是**幂等**的：同一个 tag 重跑、或某个版本恰好在 npm 上已存在时，它会跳过发布，
> 只补建 GitHub Release。所以「重推 tag」是安全的补救手段，而**不是**重发版本。

---

### 5.1 只发必要文件（`files` 白名单）

npm 包里**只允许**出现运行与安装真正需要的条目：

| 条目 | 为什么必须发 |
|---|---|
| `lib/` | 插件本体（宿主半 + 客户端半） |
| `cordis.patch.yml` | 装包的人靠它把插件挂进 composition |
| `install-deps.sh` | 依赖（tmux）自检与安装 |
| `README.md` / `README.en.md` | npm 页面正文 |
| `LICENSE` | 法务 |

其余一律**只留在仓库**：`README 的「当前版本」`、`SECURITY.md`、`PUBLISHING.md`、`CONTRIBUTING.md`、`docs/`。
两条理由，第二条更重要：

1. 装包的人不需要它们 —— npm 页面只渲染 README，多带文件只增加体积与困惑；
2. **每一次发布都是把开发机信息往公开注册表上搬的一次机会**。注册表上的版本几乎不可收回
   （72 小时内可撤销，且版本号永久烧掉），而仓库里的文件随时能改。发得越少，将来要清理的面越小。

`release:check` 把这条政策变成机械检查：**白名单之外多带任何文件**、缺必要文件、README 里出现相对
链接、绝对链接指向不存在的文件 —— 四种情况都直接 fail。相对链接之所以也拦，是因为它天然指向仓库
内部文件（正是「非必要发布」的那些），而且在 npm 页面上必然断。

**公开仓与 README 推送纪律（2026-09-19 定，维护者拍板，优先级最高）**：

1. 公开仓（origin main）的 README **只在发布时更新**——由 release-prepare 压进发布提交；
   开发中的 README 改动**不随时推公开仓**。例外仅限维护者明确要求的紧急公告（如当时的
   "0.3.0 勿用"公告），且下个发布按本纪律回收。
2. README 的「最近更新」只反映**最近一个真实已发布版本**；未发布内容一律不写入。私有开发备份仓的中文 README 可保留「开发中」段作为进度快照（2026-09-19 维护者指定）——但**公开仓与 npm 发布物**在本段转正前不得出现它。
   版本号（package.json / PKG_VERSION）同样只在发布动作时 bump——开发中间态的 HEAD
   始终携带"当前已发布版本号"，release:check 因此永远校验的是发布态一致性。
3. 开发中版本的材料只进两处：`README 的「当前版本」` 顶部"（尚未发布）"段、
   `内部开发记录（已移除）` 纪实段。发布那一刻转正、README 重写、版本号 bump、tag 触发 CI。

**多语文档政策（2026-09-18 定）**：中文 `README.md` 是唯一权威文档，随版本更新；
`README.en.md` **冻结于 0.3.1**（文件顶部已注明），此后不再跟进更新——发布时它照旧随包
（给英语用户留一份诚实的历史参考），但新功能、安全公告、版本记录**都不回写英文**，
双语长期同步的成本与漂移就此止损。release:check 对英文 README 只要求存在与链接合法。

---

## 6. 出问题怎么办（回滚与补救）

| 情况 | 做法 | 注意 |
|---|---|---|
| 刚发的版本有 bug | **发一个 patch**（`0.1.1`），这是最正常的路径 | 用户会按 semver 自动升级到它 |
| 严重问题，必须撤下 | `npm unpublish terminalkeeper@0.1.0`（**只能维护者本机**：登录态 + 2FA OTP。实测 2026-09-18：workflow_dispatch 的撤销 job 走 OIDC 短期 token 会被 registry 拒绝——`E400 OIDC publish authorize: Invalid request`，OIDC 只授权 publish；该 job 保留仅供 token 政策未来变化时重试） | **72 小时内**才允许，且**同一版本号再也发不了**；有依赖者会直接装不上，慎用（0.3.0 的处置决定即为：不撤，README 公告劝退） |
| 想劝退但保留可安装 | `npm deprecate terminalkeeper@0.1.0 "严重 bug，请升到 0.1.1"` | 首选，代价最小 |
| `latest` 指错了版本 | `npm dist-tag add terminalkeeper@0.1.1 latest` | 只动标签，不动包内容 |
| tag 打错了 | `git push --delete origin v0.1.0 && git tag -d v0.1.0` | 若 CI 已经发布成功，删 tag 不能让 npm 回滚 |
| GitHub Release 有误 | `gh release delete v0.1.0` | 与 npm 无关 |
| 包内容缺文件 | 修 `files` 白名单 → 升 patch → 重新发布 | 已发布的版本无法原地修改 |

### 常见报错对照

| 报错 | 原因 | 处理 |
|---|---|---|
| `E401 Unauthorized` / `ENEEDAUTH` | 没登录或 token 失效 | `npm login` / `npm whoami` |
| `E403 cannot publish over existing version` | 该版本号已存在 | 升版本号，**不要**重复发同一版本 |
| `E403 ... 2FA` | 没提供 OTP | 交互式发布，或用带 `--otp=123456` / automation token |
| `E402 Payment Required` | registry 配成了私有源 | `npm config get registry` 应为 `https://registry.npmjs.org/` |
| `EPUBLISHCONFLICT` | 包名被别人占了 | `npm view terminalkeeper` 确认 |
| `E422` / `EOTP` | 2FA / OTP 相关 | 检查账号 2FA 设置 |
| CI 里 `npm publish` 401 | `NPM_TOKEN` 没配或过期 | 重新生成 granular token；或改用 Trusted Publisher |
| 启动报 `duplicate loader entry id: terminalkeeper` | 同时用了 bundle 和手工 patch 行 | 见 `docs/使用细节.md`「两条路只能选一条」 |

---

## 7. 关于「第一次发布」的特别提醒

* **第一次发布不可逆的只有包名**：`terminalkeeper` 一旦发布就是你的（同名后来者无法发布）。
  版本号可以不断加，所以**不要**为了「完美」推迟——0.1.0 有瑕疵，发 0.1.1 就好。
* **先发 GitHub、再发 npm**：npm 页面需要仓库地址才有意义，而仓库先建好还能让 CI 路线一次跑通。
* **元数据可以后补**：`author` / `repository` 缺失只是 npm 页面难看，不影响安装；
  补完之后升一个 patch 版本即可生效（npm 页面上的元数据以最新版本为准）。
* **发布前最后一道人工检查**：`git status` 干净、`npm pack --dry-run` 的文件清单符合预期、
  `README 的「当前版本」` 读起来像人写的（用户就是靠它决定要不要升级）。

---

## 8. 清理已经进了历史的开发机信息

**什么时候需要**：发现某个提交、文档或脚本里带了开发机路径、内网地址、真实邮箱、token —— 而仓库
是公开的。**「工作树里修好」不等于修好**：历史提交、旧标签、以及已发布的 npm 包里仍是旧内容
（实测：工作树修好之后，`raw.githubusercontent.com/<repo>/v0.1.4/PUBLISHING.md` 依然 HTTP 200）。

**步骤**（本仓库 0.1.5 之后做过一次真实清理）：

```sh
# 0) 备份：改写是破坏性的，先留一个本地镜像（不要推到任何远端）
git clone --mirror . ../terminalkeeper-BACKUP-$(date +%Y%m%d-%H%M%S).git

# 1) 全历史扫描 —— 只看工作树是上次事故的根因（扫描范围漏了 docs 与 scripts）
npm run leak:history                      # 扫全部历史 blob + 全部标签，报出 sha/路径/行号/文本
npm run leak:history /path/to/BACKUP.git  # 也可以扫旧镜像做对照：能扫出泄露，才证明规则真的有效

# 2) 改写全部提交与标签（--tag-name-filter cat 让标签跟着一起走）
cat > /tmp/rewrite-tree.sh <<'SH'
for f in $(grep -rlI -e '/home/<用户>' -e '<内网IP>' . 2>/dev/null); do
  sed -i -e 's#/home/<用户>/<项目>#~/<项目>#g' \
         -e 's#/home/<用户>#/home/u#g' \
         -e 's#<内网IP>#192.0.2.9#g' "$f"
done
SH
FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f \
  --tree-filter 'bash /tmp/rewrite-tree.sh' --tag-name-filter cat -- --all

# 3) 清掉备份引用与旧对象 —— 否则它们在本地仍可被扫到（扫描器会报"还有残留"，那是假信号）
git for-each-ref --format='%(refname)' refs/original | while read r; do git update-ref -d "$r"; done
git reflog expire --expire=now --all && git gc --prune=now

# 4) 强推（改写历史必然需要 force）
git push --force origin main
git push --force --tags origin

# 5) 验证远端 —— 本地干净不等于远端干净
git ls-remote origin | grep -E 'refs/(heads|tags)'            # SHA 应与本地逐一一致
curl -sL "https://raw.githubusercontent.com/<repo>/<旧tag>/<文件>" | grep -n '<敏感串>'   # 期望无命中
```

**残留（必须如实告知）**：GitHub 对**不再被任何引用指向**的旧对象，仍会按 commit SHA 直接返回内容
（实测：改写后旧提交依旧可取到那句路径，GitHub API 也返回 200）。改写历史只能让旧内容不再沿任何
正常路径暴露。**彻底**清除需要向 GitHub Support 申请清除无引用对象与缓存视图：

> 主题：Request to purge unreferenced objects containing sensitive data
>
> 仓库：`<owner>/<repo>`（public）
>
> 我们已把泄漏的开发机绝对路径从全部提交与标签中改写并强推（UTC 时间：`<...>`）。这些旧 commit
> 现在不被任何分支或标签引用，但仍能按 SHA 直接取到，例如 `<旧 SHA>` → `<文件路径>`。
>
> 请求：清除这些无引用对象及其缓存视图（含 `raw.githubusercontent.com` 上的缓存）。

**别忘了 npm 那一侧**：已发布版本里的同一份内容要撤销（见 [9.3](#93-撤销已发布的版本)），撤销窗口
是发布后 **72 小时**内，且包不能有下游依赖。顺序永远是**先发新版本、再撤旧版本**。

> **两条防再犯的经验**（都很便宜，但都是这次踩出来的）：
>
> 1. 这次能发现「历史里还有」，是因为把泄露扫描从 `lib/*` + `package.json` 扩到**整个仓库**。
>    **校验的覆盖范围本身就是最容易出错的地方** —— 加检查时先问一句「哪些文件不在这个检查范围内」。
> 2. 规则本身也会漏。最早那版要求路径**结尾带斜杠**，于是历史里「测试夹具中一行裸路径」这一整类
>    被漏掉（拿旧镜像跑一遍才看出来）。规则与工作树扫描共用 `scripts/lib/leak-rules.mjs`：
>    **验证规则是否有效的方法，是拿改写前的镜像跑一遍** —— 扫不出已知存在的泄露，就说明有洞。

---

## 9. npm 登录与网络问题排查（含撤销版本）

### 9.1 症状：`npm login` 卡在 spinner 上

按这个顺序判，**不要**一上来就怀疑 DNS 或去改 hosts：

| 检查 | 命令 | 读法 |
|---|---|---|
| DNS 是否被污染 | 本地解析 vs 阿里 DoH（`https://dns.alidns.com/resolve?name=www.npmjs.com&type=A`） | 两边地址一致 → DNS 干净，别在 DNS 上耗时间 |
| 注册表是否通 | `curl -s -o /dev/null -w '%{http_code}' https://registry.npmjs.org/` | 200 → 发布/撤销这条路是通的 |
| 官网是否通 | 同上换成 `https://www.npmjs.com/` | 403/000 → 官网被拦；**只影响 web 登录** |
| 换个客户端 | 用 `curl` 或 Node 原生 `https` 发同一个请求 | 3 秒内返回 → 问题在 npm 的 HTTP 栈或网络抖动，不在网络本身 |

`www.npmjs.com` 与 `registry.npmjs.org` 是两条不同的路：前者不通只让 **web 登录**（`npm login` 的
默认方式）不可用，不影响发布与撤销。所以官网打不开时改用 **legacy 登录**：

```sh
npm login --auth-type=legacy     # 只访问 registry：用户名 + 密码 + OTP
```

这条不是野路子：npm 12 的 `lib/pure.mjs` 里 `auth-type !== 'web'` 就走 CouchDB 用户名/密码
路径（`loginCouch`），OTP 提示同样来自注册表。注册表要求 OTP 是**正常的 2FA 步骤**，不是错误。

### 9.2 症状：`read ETIMEDOUT`（连上了但读不到响应）

npm 自己的请求偶发 `ETIMEDOUT`，而同一时刻 `curl` 与 Node 原生 `https` 都在 3 秒内返回 —— 这是
网络抖动，**不是**配置错误（npm 的报错文案会把人往 proxy 上带，别被它带走）。

npm 默认 `fetch-retries=2`、`fetch-timeout=300000`，所以它**可能正在重试**：先等满 5 分钟再判断
卡死；中途 Ctrl-C 只会得到「取消」，而不是真实错误。要更快看到结论就显式压短：

```sh
npm login --auth-type=legacy --fetch-timeout=40000 --fetch-retries=0
```

### 9.3 撤销已发布的版本

`npm unpublish` 需要**账号级 2FA**（Trusted Publisher / OIDC 只用于发布，不能撤销）。两条硬规则：

* **同一个 `package@version` 撤销后不能再用** —— 版本号永久烧掉；
* **把全部版本都撤光会让这个包 24 小时内不能再发新版本** —— 所以顺序是**先发新版本，再撤旧版本**。

```sh
npm unpublish terminalkeeper@0.1.0    # 逐条执行：先输入 y 确认，再输入当次的 6 位 OTP
```

**不依赖 npm 登录的等价做法**（`www.npmjs.com` 打不开、或 npm 的 HTTP 栈不稳定时）：直接用注册表
API，也就是 npm 自己 `npm unpublish` 的内部调用序列（照搬 `libnpmpublish/lib/unpublish.js`，
不要凭记忆改字段）：

```sh
# 1) 取 packument（带 _rev），记下 dist.tarball 与 dist-tags
curl -sS -H 'accept: application/json' \
  "https://registry.npmjs.org/terminalkeeper?write=true" -o pkg.json

# 2) 从 versions 里删掉目标版本、清掉指向它的 dist-tag、必要时把 latest 指到剩下的最高版本，
#    删掉 _revisions / _attachments 后 PUT 回去（-rev 用上一步的 _rev）
curl -sS -X PUT -H "Authorization: Bearer $TOKEN" -H "npm-otp: $OTP" \
  -H 'content-type: application/json' --data-binary @pkg-edited.json \
  "https://registry.npmjs.org/terminalkeeper/-rev/<_rev>"

# 3) 再取一次 packument 拿新的 _rev，然后删掉 tarball 本体
curl -sS -X DELETE -H "Authorization: Bearer $TOKEN" -H "npm-otp: $OTP" \
  "https://registry.npmjs.org/terminalkeeper/-/terminalkeeper-0.1.0.tgz/-rev/<新 _rev>"
```

### 9.4 账号的 2FA 是**通行密钥（WebAuthn）**时怎么撤销版本

这是本仓库真实遇到的情况：`npm login` 走 web 方式没问题（浏览器里有通行密钥），但任何**账号级写入**
（`npm unpublish`、`npm trust`）都会要 OTP，而 CLI 的 `--otp` 只认 6 位 TOTP 动态码 —— 通行密钥没有码
可读，于是本机永远过不去。

**npm 12 其实支持浏览器授权代替 OTP**（`lib/utils/auth.js`（**npm 自身源码内的路径**）的 `otplease`）：当写入请求返回 `EOTP`
且响应体带 `authUrl` / `doneUrl` 时，npm 让你在浏览器里授权，再把拿到的 token 当 OTP 重试。实测要点：

| 事实 | 说明 |
|---|---|
| 需要真实 TTY | 非交互环境下 `otplease` 直接抛错，不会等待；且必须 `BROWSER=true`，否则 npm 在"打开浏览器"这步就退出 |
| 一次授权 = 一个版本 | 同一个版本的两次写入（PUT packument + DELETE tarball）共用一个 OTP ✓；换下一个版本会失效 ✗ |
| 挑战藏在响应体里 | 光带 `authorization` 时，401 只回一句 "You must provide a one-time pass…"，浏览器链接只出现在 `npm-notice` 响应头（那是给安全密钥用的 `/login/<uuid>`，脚本用不了） |
| 解锁条件是一组请求头 | `npm-command` + `npm-auth-type: web` + 一个 `user-agent: npm/…` + `npm-session`，带上之后 401 的 body 才会给出 `authUrl` + `doneUrl` |

`scripts/npm-unpublish-webotp.py` 就是按这套实现的（自己轮询 `doneUrl`、自己拿 OTP、不需要 npm 自己的
HTTP 栈，因为后者在某些网络上会 `read ETIMEDOUT`）：

```sh
python3 scripts/npm-unpublish-webotp.py 0.1.0        # 撤销一个版本（会打印授权链接，自己去浏览器打开）
python3 scripts/npm-unpublish-webotp.py --dry-run 0.1.0   # 只读预演
```

它**不自动打开浏览器** —— 把链接打给人，人在**自己的物理机**上授权（虚拟机里往往没有通行密钥）。

---

## 10. 生态收录（上架到第三方插件商店）

**DSH 官方没有插件商店**，生态由社区目录/雷达自动抓取；两家的入口几乎都是 **GitHub 仓库的
`dsh-plugin` topic**。本仓库一度 `topics: []`、description 为空 —— 那等于"装了没人知道"：
抓取方根本没有发现它的途径（2026-09 实测确认）。package 侧的字段（`name` / `main` / `exports` /
`dsh.bundle.patch` → `./cordis.patch.yml`）已经满足两家校验，缺的只是**仓库元数据**。

### 10.1 必做：仓库 topic + description（一次性，人工）

GitHub 仓库页 → About 右侧 ⚙️：

* **Topics** 至少加 **`dsh-plugin`**（两家都按它发现），建议再加
  `deepseek-harness`、`dsh`、`tmux`、`terminal`、`ai-agent`。
* **Description**（抓取方会当摘要读）建议：
  `Persistent interactive tmux shells for DeepSeek Harness (DSH) — 7 model tools, floating panel, hash-chained audit, consent gate.`

装了 `gh` 并 `gh auth login` 后也可以一行搞定：

```sh
gh repo edit Mrtime-gege/terminalkeeper \
  --add-topic dsh-plugin --add-topic deepseek-harness --add-topic dsh --add-topic tmux --add-topic terminal \
  --description "Persistent interactive tmux shells for DeepSeek Harness (DSH) — 7 model tools, floating panel, hash-chained audit, consent gate."
```

> ⚠️ 用 SSH key 只能推代码，**改不了 topic/description**（那是仓库 API，需要 token）。
> 本机没有 `gh` 也没有 token 时，这一步只能人工在网页上点。

### 10.2 两家的抓取与校验规则（照做即可被收录）

| 抓取方 | 发现方式 | 频率 | 校验（关键） | 收录后自查 |
|---|---|---|---|---|
| **DSH 1024Store**<br>`deepseek1024.com` + [awesome-deepseek-harness-plugins](https://github.com/imsai-sh/awesome-deepseek-harness-plugins) | 带 `dsh-plugin` topic 的 GitHub 仓；另有 PR 收录流水线 | 定时增量抓取 + 定期全量对账（掉 topic 只在一次成功对账后下架） | **只读**默认分支 Git tree：`package.json`、`dsh.bundle.patch` 字段、且 patch 文件**在同一棵 tree 里**；**绝不装依赖、绝不执行代码** | `curl 'https://api.deepseek1024.com/v1/plugins/search?q=terminalkeeper'`（匿名 50 次/天、10 次/分；登录后 500/天、30/分） |
| **DSH Plugin Radar**<br>[AdamPlatin123/dsh-plugin-radar](https://github.com/AdamPlatin123/dsh-plugin-radar) | GitHub Search：topic ×2 + keyword ×3 | 每 6 小时一轮发现；15 分钟机器可读快照 | 静态：`package.json` 有 `name` + `main`/`exports`/`dsh`；再上 **k8s 运行级实测**（一插件一 pod） | 看其 `PLUGINS-ALL.md` 与兼容矩阵（runtime OK / 待测 / 需适配） |

* **加 topic 之后**：Radar 约 **8 小时**内自动收录；1024Store 等下一轮同步（两者都是自动的，**不需要提 PR**）。
* **安装排行只认包装 CLI**：`dsh1024 plugin --profile web add <包>`（匿名安装遥测）才计入 1024Store 排行；
  官方 `dsh plugin` 与本包自带的 `npx -y terminalkeeper install` **都不计入**。
* 两家都明确声明：**收录 ≠ 兼容，静态校验 ≠ 运行可用，运行可用 ≠ 安全审计** —— 我们 README 顶部的
  风险声明因此不受影响，也不应被"已收录"稀释。

### 10.3 可选：主动提交 PR

想更快/更稳地进目录，可向 awesome 清单提 PR（其 `CONTRIBUTING.md` 提供 `submit-dsh-plugin` skill）。
**提 PR 是公开动作**（会在公开仓库留痕 + 需要 fork），发布纪律第 6 节那条"公开动作只由维护者决定"
同样适用：默认走 topic 自动收录，PR 由维护者决定是否发。

---

## 附录：从 README 拆入的章节（2026-09，README 瘦身）

### 版本与发布

* **公开历史只保留版本级节点**：每个版本对应**一个提交**与一个 `v<版本>` tag —— 中间改动的过程、粒度与
  提交信息不在公开历史里。
* **发版由维护者决定**：推 `v<版本>` tag 是唯一的发布扳机。CI（GitHub Actions）用 npm 的
  Trusted Publisher（OIDC）发布到 npm，并自动创建对应的 GitHub Release，附带 provenance 签名证明
  （`npm audit signatures` 可验证）。
* **README 只保留最近一次更新**，完整历史（每个版本改了什么、**根因**是什么、怎么验证的）在
  [内部开发记录（已移除）](https://github.com/Mrtime-gege/terminalkeeper/blob/main/内部开发记录（已移除）)；
  逐版本的简短发布说明在 [README 的「当前版本」](https://github.com/Mrtime-gege/terminalkeeper/blob/main/README 的「当前版本」)。
* **只发布必要文件**：npm 包里只有运行与安装需要的条目（`lib/`、`cordis.patch.yml`、`install-deps.sh`、
  两份 README、`LICENSE`）—— 文档类内容留在仓库，不随包发布。

## 两轮通过规则（强制）

任何**代码或配置变更**后，受影响的验证必须**连续两轮全部通过**才可判定通过/发布；两轮之间不得再改代码；中途修改则计数清零。只跑一轮不得判定通过，也不得发布。
