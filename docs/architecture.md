# 架构

## 1. 三层

```
 入口                Skill（一期）：宿主编码 agent 读 SKILL.md，调用 CLI
                     内置 Agent（二期）：产品自带对话循环，调用模型 API
                          │  两者共用同一份「验收手册」（skill/ 下的文档）
                          ▼
 工具层（不调模型）   acceptkit CLI：用例 · 运行 · 记录 · 观测 · 复核 · 报告 ·
                     评审单 · 回归轮 · 闸门 · 设备租约 · 知识 · 环境 · 索引
                          ▼
 存储                项目目录（文件）+ SQLite（租约、审批、环境快照、索引）
                          ▼
 管理页面            acceptkit serve：本机网站（项目列表 + 各项目看板），读同一份存储
```

- 工具层**不调用任何模型**。判定由观测规格 + 谓词完成，结论原文落盘。
- 闸门（白名单、危险动作确认、评审单批准、卸载审批）在工具层强制执行，不依赖 agent 遵守提示词。
- 所有状态写进存储，不留在对话里。换入口、换会话都能接着做。

## 2. 目录

```
acceptkit/
  bin/acceptkit.mjs      CLI 入口
  core/                  引擎：用例模型、运行、证据闸、评审单、回归轮、版本范围、平台适用性、报告、看板
  core/project.mjs       找项目、读配置、加载 pack.mjs
  core/knowledge.mjs     知识（Markdown + 标签）；core/secrets.mjs：#secret 遮蔽
  core/phase1.mjs        sut / import / select
  core/case-quality.mjs  用例质量标准：规则、存量基线、豁免（见 case-quality.md）
  core/hosts.mjs         被测 App（宿主）登记：一个项目多个 App 时，这一步用哪个 App
  core/settings.mjs      设置：流程各步要用的设置项（构建、驱动），按宿主 / 平台的固定路径读写、借鉴与执行
  core/ops.mjs           操作库：读写、校验、旧写法迁移；推测的配方不执行
  core/config-edit.mjs   项目配置的写口：每个键登记类型，写入与 doctor 按它校验
  core/server.mjs        管理页面（acceptkit serve）：项目列表、各项目看板、按需出图
  core/links.mjs         报告链接：按上下文定位到看板面板
  core/store/            SQLite 访问（node:sqlite）
  adapters/              内置载体：ios-sim（simctl）、android（adb）、web（CDP，独立浏览器实例）
  skill/                 通用 SKILL.md 与验收手册
  examples/web-demo/     公开示例项目（零私有扩展可跑通）
  scripts/               检查脚本（泄漏扫描等）
  test/                  测试
```

项目数据**不在仓库里**。一个「项目」是一个目录：

```
<project>/
  acceptkit.project.json   项目配置：名称、扩展包、闸门白名单、被测 App（hosts）
  pack.mjs                 （可选）扩展钩子：私有观测器、目标解析、领域命令
  knowledge/               知识：Markdown，可带标签；账号也写在这里
  cases/                   用例（JSON，人可读）
  runs/<run>/              运行：result.json、证据、截图、报告
  state/                   评审单、回归轮、复核包、阻塞台账……
  .acceptkit/acceptkit.db  SQLite：设备租约、审批记录、环境快照、索引
```

CLI 找项目的顺序：`--project <dir>` → 环境变量 `ACCEPTKIT_PROJECT` → 从当前目录向上找 `acceptkit.project.json` → 用户配置 `~/.config/acceptkit/config.json` 的 `defaultProject`。

## 3. 存储

| 实体 | 正本 | 原因 |
|---|---|---|
| 用例、运行结果、评审单、回归轮、阻塞台账 | 文件（JSON） | 人可读、可 diff；项目自带的脚本可能直接读写这些文件 |
| 设备租约、审批记录、环境快照 | SQLite | 只由 CLI 写，需要事务，避免并发读改写竞争 |
| 用例 / 运行 / 结论索引 | SQLite（派生，可重建） | `acceptkit index` 按文件哈希增量重建；`acceptkit query` 用 SQL 管理大量用例 |
| 证据（截图、日志、抓包） | 文件 | 产物，库里只存路径与哈希 |
| 知识 | Markdown 文件 | 用户可以直接编辑 |

索引是**派生数据**：每个实体只有一条写入路径（文件），索引任何时候都能从文件重建，不存在双写。当项目里直接读写文件的脚本都迁移为调用 CLI 后，该实体再切换为 SQLite 正本、文件降为导入导出格式。

## 4. 扩展模型

内核零领域知识。项目通过 `pack.mjs` 导出钩子接入私有能力，内置能力走同一套钩子：

| 钩子 | 作用 | 缺失时 |
|---|---|---|
| `observers` / `observerStrength` | 观测执行器：`recipe.exec` → 函数，及其证据强度 | 断言按 fallback 降级；都不可用时记阻塞（「缺少观测扩展 <名字>」） |
| `resolvePort(recipe, udid)` / `appPortForPid(pid, udid)` | 找到被测 App 的调试端口 | 用 `ACCEPTKIT_APP_PORT`、配方里的 `port` 或配置 `app.port` |
| `appPid(udid, bundle)` / `simState(udid)` | 模拟器上被测 App 的进程与状态 | 按 bundle 在 launchctl 列表里找；只报模拟器开关机与是否安装 |
| `listDevices(platform)` / `bootDevice(ref)` | 选设备时「实际连着哪些」（身份列表）与「启动这一台」（返回 `{ ok, address }` 或 `{ ok:false, how }`）：自家设备池、测试里注入设备快照 | Android 读 adb、用 emulator 启动；iOS 读 `simctl list devices booted`、用 `simctl boot` 启动 |
| `uiHierarchy(port)` | 解析驱动工具的 UI 层级产物（含可见性），命令来自驱动设置的 `ui-tree` 动作 | 直接用 `ui-tree` 输出的文本行，命中即算遮蔽；没有设置则记为「无法确认」 |
| `obscurers` | 项目特有的遮蔽层（追加在内置的系统弹窗 / 隐私页 / Loading 之后） | 只查内置的几类 |
| `webObscuring(page)` | Web 截图前的遮蔽层检查 | 查页面上可见的对话框 |
| `ocr(png)` | 截图文字识别 | macOS 系统 Vision；其他系统不可用 |
| `commands` | 领域命令，挂在 `acceptkit <命令>` 下，不能覆盖内核命令 | 命令不存在 |
| `qualityRules` | 项目特有的用例质量规则，追加在通用规则之后 | 只用通用规则 |
| `newCaseTemplate` | 新建用例的骨架（切面分类） | 内核通用骨架（或配置 `newCase.classifications`） |
| `dashboard` | 用项目自己的看板生成器（相对路径） | 内核看板 |

闸门白名单是**数据**，写在 `acceptkit.project.json` 的 `gate` 段：允许的设备、包名、租户，以及「仅在某平台放行」的条件项。识别不出目标 = 拒绝。

## 5. 观测降级

断言的观测规格可以声明后备：

```json
"observe": { "op": "diag-query", "pick": "...", "pass": { "eq": "block" },
             "fallback": [ { "op": "log-grep", "pattern": "action=block" } ],
             "min_strength": "S2" }
```

| 强度 | 通道 | 判定 |
|---|---|---|
| S1 | 被测对象主动暴露的诊断接口 | 机判 |
| S2 | 日志、网络、页面内容、产物文件 | 机判，间接证据 |
| S3 | 截图 → 文字识别 → 谓词 | 机判，可能被界面误导 |
| S4 | 人工检查 | 人判 |

每条结论记录实际使用的通道与强度；低于 `min_strength` 不记通过，记阻塞。

## 6. 知识与账号

知识是 `knowledge/*.md` 里的普通文本，可以带标签（`#account #android`）。账号不定制结构，就写在知识里。标了 `#secret` 的值，工具层在写证据、报告、日志时统一替换成 `***`。知识条目可以标状态：推测 / 已确认 / 已验证。

## 7. 被测 App（宿主）与设置：构建与驱动

### 宿主

一个项目可以在多个 App 里验同一个被测物（同一个引擎嵌在主 App 和示例 App 里），新 App 也会随时加进来。所以「每个 App 一份」的东西都按**宿主 id** 存，不按平台存：按平台存时同一平台只能放一个 App，第二个 App 进来只能覆盖第一个。

```json
"hosts": {
  "main": { "title": "主 App", "ios": { "bundle": "com.example.main" }, "android": { "package": "com.example.main" } },
  "shop": { "title": "商城 App", "android": { "package": "com.example.shop" } }
}
```

| 按宿主存的 | 位置 |
|---|---|
| 包名 / bundle / 调试端口 | 项目配置 `hosts.<宿主>.<平台>` |
| 构建做法 | `knowledge/settings/<平台>/<宿主>/build.md`（每个 App 一份） |
| 驱动做法 | `knowledge/settings/<平台>/driver.md` 同平台共用；某个 App 用不了时写它自己的 `…/<平台>/<宿主>/driver.md`，优先于共用的 |
| 只在某个 App 上成立的操作配方 | 操作库的 `<平台>@<宿主>` 键，优先于通用的 `<平台>`；写 `absent` 表示这个 App 上做不了，通用做法也不套用 |

用例的 `host`、白名单设备的 `profile.host` 引用的都是这里的 id，没登记的报错。用例两端不是同一个 App 时写成 `{"ios": "…", "android": "…"}`。

**这一步用哪个宿主**：显式指定（`--host`、用例的 `host`、设备声明）→ 该平台只登记了一个宿主时就是它 → 有多个又没指定时报错，不挑第一个。同平台登记了多个宿主而用例没写 `host`，质量规则 Q15 会提示；此时只能用通用配方，宿主专属的配方、包名、构建都取不到。

**新 App 借鉴别的 App**：`setting borrow build --platform P --host 新 --from [<项目目录>:]<宿主>` 把对方当前生效的那份拷成新 App 自己的文件，状态「推测」，说明里注明借鉴自哪里。`build --try` 试跑推测的做法；试跑通过**不自动升级**（退出码 0 不说明产物是这个 App 的包），核对后 `setting verify … --evidence "<核对了什么>"`。走不通就改新 App 自己的那份，被借鉴的一方不受影响。不做运行时继承：继承时源头一改，借用方跟着悄悄变，也说不清当前生效的是谁的做法。

旧写法（`app: { ios, android, web }` 每平台一个 App、`settings/<平台>/build.md`、操作库 `<平台>_<宿主>` 键）由 `doctor --fix` 迁移，但只在能确定归属时迁：用例里写到的宿主超过一个时，旧配置里各平台属于哪个 App 机器猜不出来，报出来让人拆。

### 设置

流程是确定的，所以流程要用的设置位置也是固定的（见上表）。设置项、必需动作与作用范围（每个宿主一份 / 同平台共用）登记在 `core/settings.mjs` 的 `SLOTS`。不在其他知识里按标签或关键词搜：流程能用什么命令，只由这个位置的文件决定。

```markdown
# iOS · 驱动 App

- 状态：已确认
- 来源：被测 App 仓库里的 docs/debug.md

## 命令

- ui-tree: `mytool fetch --json -p {port}`
- tap: `mytool tap -p {port} --text {text}`

## 说明

（注意事项、踩过的坑：给人和 agent 读，不参与执行）
```

- `## 命令` 下每行一个动作；占位符 `{port}` `{udid}` `{bundle}` `{repo}` `{text}` 由调用方填，值按 shell 转义，不会被当成命令解释。
- 写入（`setting set`）时检查必需动作；状态为推测的设置不执行（`setting confirm` 后才用，或 `--try` 显式试跑一次）。
- `acceptkit build` / `drive <动作>` 照设置执行，`{bundle}` 按这一步的宿主填；扩展包通过 `helpers.drive(动作, 参数, 平台, 宿主)` 调用，代码里不出现工具名。内核读 UI 层级时，如果没有扩展解析器，就直接用 `ui-tree` 动作的输出。
- 每个登记的宿主 × 它的平台都要有设置；`doctor`、`setting show`、`host`、`know profile` 列出缺口，缺的那项会列出本项目里可以借鉴的宿主。

## 8. 管理页面

acceptkit 有自己的本机网站（`acceptkit serve`，缺省 `http://127.0.0.1:9470/`），不依赖别的页面嵌入：

- `/` 列出登记过的项目（`project init` / `project use` 登记，`project list` / `project forget` 管理）：用例数、最近一次运行。
- `/p/<项目>/` 是该项目的看板，`#run=<面板键>` 直接停在某份报告上（键的规则见 `core/links.mjs`）。项目数据有变化才重新生成，否则用缓存。
- 截图按需出（`/p/<项目>/asset?f=…`，只出项目目录里的图片），不内联进页面：大项目内联后页面会超出字符串上限。
- 只听本机。看板里是被测系统的内部数据，要对外开放得显式 `--host`，并会提示。
- `open`、`link` 缺省指向它，没在跑就在后台起一个（日志在 `~/.config/acceptkit/serve.log`）。看板另外嵌在别的页面里、要给那个页面的地址时，才配 `dashboard.url`。项目自己的看板生成器（`pack.dashboard`）按运行 id 定位时，配 `dashboard.locateBy = "run"`。
- 改了内核代码后 `acceptkit serve stop`，下次 `open` / `link` 会用新代码重新起。

## 9. 用户设置的其他东西：写口与校验

操作库（`ops/registry.json`）、项目配置（`acceptkit.project.json`）、知识都是用户设置进来的。规则一样：

- **有写口**：`ops set|confirm|verify|rm`、`config set|unset|add|rm`、`host add|rm`、`know add|edit|rm`、`project use`。
- **写入时校验，不合格不落盘**：操作要有平台中立的 `title` 与 `why`；配方键只能是 `ios` / `android` / `web` 或 `<平台>@<登记过的宿主>`（`ops set … --host H`）；`absent` 配方要写 `blocker`；配置键按 `CONFIG_KEYS` 登记的类型检查（白名单项要有 `kind` 与 `note`，端口是正整数，正则能编译）。未登记的参数直接拒绝，不静默收下。
- **手改的文件过同一道检查**：`ops check`、`config check`、`doctor`。问题分两级：结构错误（读的一方会用错，比如白名单项 kind 写错会让它静默失效）和不认识的字段（没有读者，写了等于没写）。
- **配方有状态**：`guess` / `confirmed` / `verified`，推测的配方在执行时返回错误（「确认后才用」），观测记为阻塞。旧写法（absent 原因写在 note、`tested`、没有状态）由 `doctor --fix` 迁移。

## 10. 演进

| 阶段 | 内容 |
|---|---|
| 一期 | 本机 + Skill 入口；文件正本 + SQLite 租约/审批/快照/索引 |
| 二期 | 内置 Agent（需要配模型）；脚本迁移后实体切换为 SQLite 正本；多端对比 |
| 之后 | 团队共享（服务端数据库）、执行机注册、托管 |
