---
name: acceptkit
description: |
  本机验收 Agent 工具箱：在真实的 App / 浏览器 / 模拟器上执行验收，留下可复核的证据。
  用例是一棵「操作树 + 人话断言」，断言自带观测规格，由工具执行、原文落盘、按规则判定；工具层不调用模型，判断由你（宿主 agent）做，闸门由工具强制。
  何时使用：(1) 用户要验收一个需求 / 复现一个 bug / 回归一批用例；(2) 要把旧用例整理成可执行的格式；(3) 要知道某个项目「怎么连、能看到什么、哪些操作危险」。
  不要使用：纯代码 review 或单元测试（那是白盒）；写业务代码。
  验收的入口只有这一个 skill。项目特有的知识（地图、判读陷阱、账号、构建）在项目目录的 knowledge/ 和 ref/ 里，用 know find / context 取，不另起项目专属的验收 skill。
---

# acceptkit

所有命令：`node <本 skill 所在目录的上一级>/bin/acceptkit.mjs <命令>`（下面简写 `acceptkit`；本 skill 目录通常是符号链接，用 realpath 找到仓库）。不带参数看帮助。

## 铁律

1. **要测哪个项目由用户决定。** 一台电脑上项目很多，不要猜。从项目目录启动时，把它作为默认选项让用户确认。
2. **能发现的不问。** 设备、浏览器、工具链、占用情况、登录态先自己查；要问时先说你试过什么。
3. **Agent 不能替用户批准任何东西。** 评审单批准、危险动作确认，都要用户本人点头，记下原话。
4. **结论只认证据。** 结果性证据走 `observe`（工具执行、原文落盘、谓词判定）；你手工 `record` 时要 `--quote` 证据原文里的片段。
5. **说话不超出证据。** 证据只证明一部分，就只写那一部分；判不了就记 `blocked` 并写清卡在哪、怎么解锁。
   「判定里有 alert 这个动作」不等于「弹窗出来了」，「动作名里有 report」不等于「上报发出去了」：断言说的效果要有读到那一层的观测（用例检查 Q22），否则收窄说法。
6. **复核者 ≠ 执行者。** 有证据就交给一个新上下文的子 agent 盲审（`review --all` / `reviewq --pack`），按它的结论回写。
   包里列了主张清单的，判 ok 要逐条写出每条在证据哪里（回写带 `claims:[{"id":"C1","where":"…"}]`），有一条找不到就判 insufficient。
   图片的包里附上截图时工具记下的设备、包、进程、时刻、遮蔽层和事中检测结果；没有这份记录的图，包里写明「不是工具截的」。
6a. **装置坏了不是发现。** 「超时 / 进程不在 / 连错设备 / 找不到符号 / 抓到上一轮的日志 / 落了空文件 / 装了好几次」
   都是**取证手段自己**的失败：归类 `--failure-of apparatus`（判给装置就不能记 `fail`），
   其余折腾用 `apparatus <run> --what … --fix …` 记台账。它不改判定，但报告会单列次数 —— 别把它当汇报内容。
   分不清就先跑**阳性对照**：拿必然成立的那一个走同一条取证路径，对照也挂了 = 装置坏了。
6b. **读数要看得出是读出来的。** 探针打印「表达式原样 → 它的值」，不要 `say("installed", true)` 这种写死的字面量
   —— 盲审只看得到证据里的 `installed=true`，看不到你的脚本。
7. **危险动作先过闸。** 装包、清数据、发布、删除、任何「会清空」的确认：都先 `acceptkit gate`。
   在本 run `device acquire` 占着的设备上装包 / 覆盖安装：过了闸就做，不问用户 —— 设备是你的，白名单和闸已经替用户把过关。
   什么情况必须先卸载再装，是这个人、这台机器的经验：判断过一次就存进他的用户知识（铁律 8b），下次照着做。
   卸载、清数据要给理由，由 acceptkit 评估：`gate --action "卸载 …" --reason <id> --why "<现场>" [--evidence <原始输出>]`。
   理由由你按经验登记（项目配置 `gate.reasons`：什么情况、为什么必须、为了什么、现场证据特征），不要拿去让 owner 逐条批 —— 他要的是你自己清楚为什么；
   acceptkit 替他核对：登记时理由要写全、证据特征不能什么都匹配，过闸时现场要对得上；理由和每次用它的现场都进运行记录，owner 事后看得到。
   用例写了 `requires_uninstall` 的用 `--reason case`。先找不卸载的办法（只要某个状态就在 app 里改再冷启）；说不出理由、拿不准会丢什么，才问 owner。
   发布、删除仍要用户点头。
8. **设备先复用，再启动，最后才新建；一次 run 只打一台。** 选和占由 `device acquire --run R` 做，你只核对工具看不出的（账号、页面），不对就 `device reject`。设备的身份不是它的 adb serial（模拟器的端口按启动顺序分配，会漂）。「空闲」必须观测得到，查不出来就记「不确定」。详见 `skill/devices.md`。
8a. **端上验收要有 app 操作截图，用 `acceptkit shot` 截。** 进到要验的页面、每个触发动作之后、出结果那一刻各一张，挂到步骤（`--step`）。
   截之前先清场：登录页、权限弹窗、隐私协议、无响应 / 崩溃对话框、启动页、别的 app 盖在上面，都要先关掉或等过去；
   `shot` 查到会拒绝，并列出画面上能点的按钮和坐标。截完打开图看一眼。一张都没有的 run 记不了 pass。
   截完 `shot` 还会当场查：几乎纯色（白屏 / 黑屏 / 加载中）直接拒收，只有节点的 `shows` 全在画面上读到了（空状态、一行提示的页面）才改成提示；和上一张几乎一样会提示「动作可能没生效」；
   节点写了 `shows: ["<这一步画面上应该出现的字>"]` 时，读得到画面层级就核对，缺了拒收（只有 OCR 时只提示）。
8b. **知识先判层再写。** 用户说「记一下」「我这边还要 …」「我习惯 …」时，先问这条对谁成立：
   只对他本人 / 这台电脑（代理规则、显示器、个人步骤）→ `prefs set`；只对这个项目（账号、构建、危险操作）→ `know add`；
   对所有用户都成立 → 才改 acceptkit 自己的代码和手册（那是改开源工具，要用户点头）。拿不准就当用户层，别往工具里写。
8c. **像 QA 一样验：结论默认在界面上看，命令行是例外。** 每条断言默认在界面上验，证据是读到结论那一刻的 app 截图（`observe` 的 UI 通道截；app 自带的调试页也算界面）——
   先找界面上的验法，找过确实看不到，才在用例里给那条断言写 `via`（log / diag / debugger / cli）和 `why_not_ui`（为什么界面上看不到），评审单会把这几条和理由列给用户过目。
   用命令行验的，证据也要 `observe` 亲自采：把取日志的命令、调试器脚本登记成操作库配方，由 observe 去跑；你自己跑完交来的文件只能参考，不算证据齐。
   **缺证据不是验不了。** 界面上的断言没有那张截图、命令行断言不是 observe 采的，`next` 会出 `evidence_gap`：照它重试补齐，不要改记 `blocked`；
   截图或采集本身失败是取证手段的问题（`apparatus` 记一笔再重试），同一条连续 3 次补不上才 `blockers --raise` 问用户。缺证据的结论在看板上显示「证据不全」，不算通过。
9. **机密不外流。** 测试账号用 `acceptkit account` 管：要账号先 `account list`（别去问用户再要一遍），脚本取值 `account get <id> <字段>` 直接喂给设备；
   用户给了新账号 `account set <id> … --field 字段=值 --by <他>`。值只存在这台机器上（不进项目目录），证据、报告、日志里自动换成 `***`。
   其他机密写进知识时标 `#secret`，同样会被遮蔽。

## 冷启动（第一次在一个项目里用）

```
acceptkit env                                  # ① 检查本机：设备、浏览器、工具链、启动目录
acceptkit project init <dir> --name <名字>      # ② 用户确认要验的项目后新建（已有项目跳过）
acceptkit doctor                               #    体检；有迁移项用 --fix
#  ③ 读取并核对被测对象身份：包名 / 版本 / 构建来源 / 宿主，写进知识
acceptkit know add "被测对象：… #推测" --heading 被测对象 --source "<哪条命令/哪个文件>"
#  ④ 读用户给的材料（仓库 / 安装包 / 文档 / 旧用例），把发现写进知识：关联系统、危险操作、观测通道及前提
#     被测 App 可以有多个，每个登记成一个宿主；构建每个 App 一份，驱动同平台共用（某个 App 例外时写它自己的）。
#     自己发现的一律 --guess，交给用户确认；用户说的直接写（已确认）。不要自己拼构建命令。
acceptkit host add <宿主> --platform ios --bundle <bundle id>      # 每个被测 App 一条（Android 用 --package，Web 用 --port）
acceptkit setting set build  --platform ios --host <宿主> --run "cd {repo} && <仓库官方构建命令>" --source "<哪个文件>" --guess
#     新 App 没有构建做法时，先借鉴已有 App 的（拷成它自己的一份，推测）；--try 试跑，核对产物是这个 App 的包后 verify：
acceptkit setting borrow build --platform ios --host <新宿主> --from [<项目目录>:]<已有宿主>
acceptkit setting set driver --platform ios --ui-tree "<取 UI 层级>" --tap "<按文字点 {text}>" --source "…" --guess
acceptkit setting show                         #    缺口 / 推测 / 已确认，一并交给用户
#     允许操作的目标写进项目配置（不手改 JSON）：
acceptkit config add gate.allow <设备号|包名|租户号> --kind device|bundle|tenant --note "<是什么、谁允许的>"
#  ⑤ 把允许操作的设备 / 包名 / 租户写进 acceptkit.project.json 的 gate.allow；被占用的设备先问
acceptkit login web <网址>                      # ⑥ 需要登录的网页：在独立浏览器实例里让用户登录一次
acceptkit browser --run <运行> <网址>           # Web 验收：在这个运行自己的标签页里打开要验的页面（observe / shot 只连它，别的运行的页面截不进来）
#  ⑦ 冒烟：建一条最小用例跑通（见下）
acceptkit know profile                         # ⑧ 环境画像 + 缺口清单，交给用户
```

## 循环：验收一个需求时，每一轮都这样做

用户说「开始验收」「接着验」，或你不确定做到哪了，就进这个循环。做到哪了不用你记，每一轮都从磁盘重新算。会话断了、换了一个 agent，从第 1 步接着做；也可以挂在宿主的定时循环、目标模式上跑。

```
0. 用户刚说了话：对照上一轮交给他的 attention 卡片，他回答了哪几张，就照那几张的 on_reply 先记下原话
   （命令已经填好，只换 <他> <原话> 这几个空）；记完再往下。他说的是新要求、不是回答：照「循环之外」处理
   开工第一次：acceptkit loop start <需求>   # 告诉宿主这个会话在验收它：没做完宿主不让你停；做完自动解绑；还有活要停：acceptkit loop stop --why "<为什么；用户让停就抄原话>"（理由摆在看板上）
1. acceptkit next <需求> --json          # 工具从记录推出还剩什么，列成卡片（顺序已排好）
2. 取第一张你能做的卡片，照它的 note 做；
   这一步不熟、或上次在这一步栽过：acceptkit context <运行> --node <节点> --json
3. 读命令返回的卡片，核对是不是你预期的状态；
   被拒（refused）：照那句话改了再做；同一张卡片连续被拒 3 次，记成取证手段的问题（apparatus），换下一张
4. 回到 1。
```

**停止条件由工具给，不由你判断：**

- 清单里只剩 `attention` 卡片：把卡片上的 question 原样交给用户（不改写、不替他答），停下等回答。
- 清单为空：报告都出完了（要出报告时清单里有 `report_due`），用 `link <需求>` 把报告地址给用户。别再 `report` 一遍。
- `attention` 和别的卡片并存：attention 照样问，与它无关的卡片照常做。
- **用户一回复，先记再做（第 0 步）。** 用户的话只在聊天里，工具看不到；你照着做了却没记，下一轮会把定过的事再问一遍。所以每张等回答的 attention 卡片都带 `on_reply`：
  评审单批准 → `plan approve`；finding 拍板 → `plan decide`（一句话回了几条就 `--finding F1,F2`，选了某个选项带 `--option`，看不懂 → `plan bounce`）；阻塞答复 → `blockers --ack`；放行设备 → `config add gate.allow` 再 `device acquire`。
  `--by` 写他、`--quote` 照抄他的话；写成执行者自己会被拒。他的回答不要用 `plan settle --kind answered` 收：那是给查实的事实用的，会丢原话。

| 卡片 | 你做什么 |
|---|---|
| `attention` | 有事等人（批准评审单、拍板 finding、解除阻塞、加设备）：question 原样问用户；没有 question 的（还没提的阻塞）照 note 先 `blockers --raise`，把输出原样交给用户；用户回了，先跑 `on_reply` 记下他的原话 |
| `plan_draft` / `finding_unclear` | 评审单没写完 / finding 写得 owner 定不了：照 detail 补，`plan check` |
| `blocker_own` | 自己的能力缺口：补上后 `blockers --resolve`，或按 note 补登记、补上报。不知道输入从哪来、结果在哪看：先 `consult <运行> --expect E` |
| `blocker_unasked` | 要用户答的阻塞，先写成他能拍板的问题再提：`blockers <D> --set B1,B2 --ask "<问句？>" --why-you "<你为什么解决不了>" --option "做法 => 后果" --option "…" --recommend "<选哪个、为什么>"`。解锁条件（下发侧要做什么、判据是什么）是给你自己看的，不是问题；同一件事卡住几条就一次写一组 |
| `smoke_needed` / `smoke_env` / `smoke_failed` | 冒烟闸（项目在 `acceptkit.project.json` 声明了 `smoke.<平台>.items` 才有）：这一轮的包冒烟没过，用例运行不开。`smoke <D> --platform p` 开冒烟运行 → `device acquire` → 装好这一轮的被测包（过 `gate`）→ `smoke env <run> --apk <本地包>` 查环境 → `observe <run> <冒烟项>` 逐项读数。包的问题记 finding 告诉 owner，出新包开新一轮再冒烟；环境的问题（残留覆盖配置、没登记的装包、swap 打满）处理掉重查。读不到也算没过 |
| `run_needed` | 评审单点名的用例还没开跑：`run <case> --demand <D>` |
| `device_changed` | 运行占着的设备停了 / 重启过：没开就 `device acquire --run R` 重新起同一台，再 `device verify --run R` 核对（重启之后记的结论会退回待测）。核对之前动这台设备的命令都会被拒 |
| `device_needed` | `device acquire --run R`：工具按复用 → 启动选一台并占上（记到本会话名下：只有本会话能动它，之后的 adb 用 `acceptkit adb --run R -- …`，别写死 emulator-NNNN），返回设备卡片；你只核对账号、页面这些工具看不出的，不对就 `device reject <身份> --run R --why "…"`，工具换下一台 |
| `evidence_gap` | 记了结论但证据不全（铁律 8c）：**重试，不是验不了**。界面上的断言重跑 `observe` 走 UI 通道，在能看到结论的页面读值并截图；命令行断言把采集命令登记成配方、由 observe 去跑。别改记 blocked。不知道去哪看：`consult <运行> --expect E` 按判据面给常见取证入口、要问清的业务问题和问 owner 的草稿；查到的业务事实 `know add --heading 取证` |
| `step_todo` | 做这一步，`shot <run> --step nN` 留过程截图（截图当场检测见铁律 8a）；会改状态的动作先 `gate` |
| `expect_todo` | `observe`；observe 做不了的才 `record --quote` 手记。判不了就 `record --status blocked --blocked-kind capability\|dependency --actual "…" --unlock "…"`，再 `blockers <D> --raise`，把 message 原样交给用户 |
| `review_due` / `rejected` | `reviewq --pack` 交给新上下文的子 agent，结论原样 `reviewq --apply`；驳回的照理由补证据重新判 |
| `round_stale` | 被测代码变了：`round new <D> --assess "…"`，逐条确认继承或重置 |
| `stalled` | 运行很久没动静：先查实际状态，别重复已经做过的外部动作 |
| `report_due` | `report <run>` |

- 断言后来记成 pass / fail / na 时，工具会自动关掉卡它的阻塞项（台账写明是哪个运行的哪条结论关的），不用手动关。
- **命令怎么调**：`protocol --json` 列出循环用到的命令，每条有说明、参数 schema、`argv` 模板。照 `argv` 拼命令；加 `--json` 时 stdout 只有一份 JSON：被改动的那张卡片；批量命令一项一个结果，被拒的项带 `refused`；整条拒收是 `{"refused":"…"}` 且退出码非 0。
- **长内容**：卡片只给预览和 `read` 指针，要全文用 `read <资源> [--offset N] [--limit M]` 分页取。

## 宿主钩子（要验收就走 acceptkit）

`acceptkit hook install --host claude-code|codex|gemini-cli|cursor [--scope project|user]` 装到宿主（`--print` 先看片段，`hook list` 看有哪几条）：

- 动验收设备（白名单里的、正被运行占着的）—— 起 / 关 / 克隆模拟器、删 AVD 锁文件、装卸包、清数据 —— 会被拦，改用 `device acquire` / `gate`；
- 手改运行结果、评审单、阻塞台账、项目配置会被拦，改用对应命令；
- `loop start` 绑定了验收的会话，`next` 里还有你能做的卡片时宿主不让停，把下一张交回给你；只剩等人的卡片就放你停。

钩子出错一律放行；不是验收设备、不在 acceptkit 项目里的文件、没绑定验收的会话都不受影响。

**用例自己补，别卡着等人。** 观测卡住（证据不全、盲审说主张没看到、Q22 说项目还没有这个观测口）时，多半是用例缺东西，不是验不了：
回被测系统里查清楚那一层的出口（谁发、什么情况下发、带哪些字段）→ 写成操作并登记它读的层（`ops set <op> --observes <层>`，项目对这一层的说法 `config add quality.observePoints …`）→ 回填用例，判据写到字段和取值 → 查到的事实 `know add --heading 取证`。
改完 `plan recheck <D> --why "…"`：只加不删的改动（加断言 / 判据 / 前提、换观测用的操作、改步骤）直接记下、照常跑，事后通知 owner；
会改结论或范围的（删断言、改断言原文、删改判据、改适用范围、`claims_off`）要 owner 本人认，认之前这条用例开不了跑（`next` 出 case_edit 卡片）。

**跟 owner 说话不用黑话。** 「有牙 / 没牙」一律不说：直接讲「功能坏了这条会不会失败」——会失败就说「能抓出问题」，不会就说「功能坏了也照样通过」。用例正文和 finding 里出现会被检查拦下。

## 循环之外

| 用户说 | 你做 |
|---|---|
| 贴需求 / bug / 一句话 | `plan new <D> --title "…" --platform …`，拆改动面：`plan add-case <D> --surface S1 --change "…" --reuse a,b --new c`，要产品定的行为变更写 `plan finding`（必须写清性质 / 影响 / 为什么 / 选项+后果 / 推荐，人话；同一件事有进展就 `--finding Fxx` 改写原条，不另开。见 `docs/finding-quality.md`） |
| 「批准」 | 用户本人说的才算：`plan approve <D> --by <他> --quote "<他的原话>"`（attention 卡片的 on_reply 就是这条）。你不能自己批 |
| 取证手段自己坏了 | 挂在断言上的：`record … --failure-of apparatus`（不能记 fail）；整轮的折腾：`apparatus <run> --what "…" --fix "…" [--cost N]`。看一眼本轮噪音量：`apparatus <run>` |
| 「回归一下」 | `regress <D>`；代码变了先 `round new <D> --assess "…"`，评估要如实（看了多少就写多少） |
| 「出报告」 | `report <run>`；`bug <run> --expect E` 出缺陷单 |
| 「报告地址」「发我链接」 | `link [<运行|需求|用例>]`：直接给停在那份报告上的网址；没点名就是最近一次运行，需求停在最新一轮。不要让用户自己去看板里找 |
| 「加一条用例」 | `new <case> …` 后照打印的质量标准写；`validate <case>` 不达标就按「修法」改，确属例外才写 `quality_waive`（带理由）；「机器判断不了」的问题由你逐条写出答案和依据给用户看，判断留给用户（评审单批准时） |
| 「记一下」 | 先判层（铁律 8b）：项目的 `know add "…"`，他个人的 `prefs set`；找：`know find #标签 关键词`；改 / 删：`know edit|rm <文件>:<行号>` |
| 发现某操作在某平台的做法（或某平台做不了） | 写回操作库：`ops set <id> --platform P --how … --source "…"`，自己推测的加 `--guess`，实测跑通的加 `--verified "<何时在哪跑通>"`；做不了写 `--absent "<原因>"`。新操作要带 `--title`（平台中立）和 `--why`。推测的配方先 `observe <run> --expect <id> --try` 试跑（真执行、不记结论），核对读值和截图后 `ops verify`，再正式观测。不手改 `ops/registry.json` |
| 「允许这台设备 / 这个租户」 | `config add gate.allow …`（用户说了才加，note 写清是谁允许的） |
| 「iOS 用 xx 构建」「用 xx 驱动 App」 | `setting set build\|driver --platform P --<动作> "<命令>"`（覆盖旧设置）；之后 `build`、`drive <动作> --参数 值` 照设置执行；缺设置就问，不自己拼 |
| 「有多少用例在 Android 上能跑」 | `query "select … from cases …"`（表：cases expects runs verdicts plans device_leases approvals） |
| 「把我们的回归库挂上来」「挂一份常备用例库」 | `config add libraries --json '{"id":"<小写id>","file":"<库文件，相对项目目录>","title":"…","intro":"…","labels":{"<证据字段>":"<显示名>"}}'`；库文件格式 `{ tree: [ { layer, cases: [ { id, name, status, evidence } ] } ] }`，看板侧栏每份库一栏 |
| 「测试账号是 …」「换个号」 | `account set <id> --kind … --platform … --login … --field 字段=值 --by <他>`；查有哪些：`account list` |
| 「新增设备时我还要配 …」这类只属于用户自己的步骤 | `prefs set devices.new_device "<他的原话>"`（不写进项目、不写进工具） |
| 「设备开在我左边那块屏上」这类个人偏好 | `prefs set devices.display leftmost\|rightmost\|main\|<第几块>`（只存用户自己的配置，不进项目；`prefs` 看本机有几块屏）。目前只管 acceptkit 起的 Android 模拟器 |
| 「打开看板」 | `open`：打开 acceptkit 自己的管理页面（本机网站，项目列表 + 各项目看板；没在跑就后台起一个） |

## 用例怎么写

```json
{ "case": "cart-free-shipping", "title": "…", "platform": "web",
  "classifications": { "carrier": ["web"] },
  "tree": [ { "op": "打开购物车页，合计 98.99 元", "tags": { "carrier": "web" },
    "expect": [ { "id": "E1", "assert": "页面提示「再买 0.01 元包邮」",
      "observe": { "op": "page-text", "params": { "url": "…", "eval": "…" },
                   "checks": [ { "pick": "tip", "predicate": { "eq": "再买 0.01 元包邮" } } ],
                   "fallback": [ … ], "min_strength": "S2" } } ] } ] }
```

- 断言默认在界面上验（铁律 8c）。界面上确实看不到的，给断言写 `"via": "log|diag|debugger|cli"` 和 `"why_not_ui": "<为什么界面上看不到，找过哪些页面>"`；写了 via 没写理由，质量检查（Q20）拦下。
  界面上验的断言，`observe.op` 要用界面通道的配方（`exec: ui` / `web`，在 app 页面上读值、同一刻截图）；用诊断 / 日志配方读的，重跑也截不到那张图，质量检查（Q21）拦下。
  过程截图（`shot`）证明做了哪些步骤，结论那张图由 `observe` 截 —— 两种图各管各的，不能互相顶替。
- `op` 引用项目操作库 `ops/registry.json` 里的操作，操作按平台写配方（`exec`：内置 `web` / `ui` / `file-grep` / `json-file`，或项目扩展提供的）。
- 观测通道不可用时按 `fallback` 降级，结论记下实际用的通道与强度（S1 诊断接口 / S2 日志·页面·产物 / S3 截图识别 / S4 人工）；低于 `min_strength` 记阻塞。
- `applies`：断言的适用版本范围；`platform`：必填。

完整示例：`examples/web-demo/`。设计说明：`docs/`。设备怎么选、怎么占、怎么保证一轮只打一台：`skill/devices.md`。
