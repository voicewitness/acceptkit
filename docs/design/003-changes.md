# 003 改造：按 000 / 001 / 002 落地

本篇把 [000 理念](../000-philosophy.md)、[001 角色与概念](../001-domain.md)、[002 协议](../002-protocol.md) 拆成七个可以独立验收的改动。
每个改动写清：要什么、为什么符合前三篇、怎么做、碰哪些文件、怎么测、做完的标准。

## 共同约束（每个改动都要满足）

| 约束 | 来源 |
|---|---|
| 工具层不调用模型；能算出来的由代码算，模型只判断意思 | 000「代码定，模型判」 |
| 不新增概念，业务需要先变成已有概念的属性；新增字段要说清属于 001 里哪个概念 | 000「概念少」、001 |
| 拒收写成一句能照着改的话；加 `--json` 时输出 `{"refused":"…"}`，退出码非 0 | 002 一节 |
| 机械检查放在事中（当场拒或当场提示），语义判断留给执行者和盲审 | 000「证据由工具产出」 |
| 不带任何内部信息：公司、产品、项目名、内部路径只能出现在项目目录，不能进本仓库 | 开源边界 |
| 只增改本改动需要的地方，用精确替换编辑；不回滚、不重写别人改过的代码 | 工作区里有尚未提交的改动 |
| 测试不碰真实设备、真实浏览器；需要设备时用可注入的数据 | — |
| 每个改动做完 `node --test test/*.test.mjs` 全过、`node scripts/leakscan.mjs` 通过 | — |

## A. 事中截图检测

**要什么**：截图那一刻就查出明显无效的画面并拒绝或提示，不等到盲审。

**符合**：000「证据由工具产出」「代码定」；001「证据：由工具产出才算数」；002「refused 写成能照着改的话」。

**怎么做**：新建 `core/shot-check.mjs`，只放纯函数，供 `shot`（iOS / Android / Web 三条分支）和 observe 的 UI 通道截图共用：

1. **解码 PNG**：用 `node:zlib` 解出像素（支持 8 位 RGB / RGBA / 灰度、五种行过滤），不引第三方依赖。
2. **纯色画面**：去掉顶部 6%（状态栏）和底部 8%（导航条），统计主色占比（各通道差 ≤ 12 视为同色）。
   - 占比 ≥ 99.5%：**拒收**，「画面几乎是纯白 / 纯黑 / 纯色，多半还在加载、白屏或黑屏：等画面出来再截」。
   - 97%–99.5%：**提示**，不拒。
   - 阈值按一个真实项目的上千张截图定：97% 会拒掉只有几行字的列表页、一屏 JSON 这类有效证据；
     90% 的提示会在近四分之一的正常截图上响。99.5% 以上的抽查下来都是白屏、加载圈、启动黑屏。
3. **和上一张几乎一样**：算 64 位差值哈希（dHash），和本 run 上一张 app 截图比，汉明距离 ≤ 3 时**提示**「和上一张几乎一样：上一步的动作可能没生效，或挂错了图」。
4. **读不到画面层级时用 OCR 补位**：画面层级读取失败（iOS 无调试端口、Android dump 失败）时，对截好的图跑 OCR（复用 engine 里已有的 `ocrText`），用同一份遮蔽层关键词（`OBSCURING`）匹配。命中：拒收，并给出关法。OCR 也不可用：照旧提示「打开图看一眼」。
5. **这一步画面上应该出现的字**：用例的操作节点可以写 `shows: ["已退出登录"]`（节点的属性，不是新概念）。`shot --step nN` 时：
   - 画面层级读得到：在层级文字里找，缺了就**拒收**；
   - 只能靠 OCR：缺了就**提示**（OCR 会漏认，不拿它拒收）。
6. 检测结果写进截图的附带记录（sidecar）的 `checks` 字段：`{blank:{ratio,color}, similar_to, screen_text_source:"hierarchy|ocr|none", shows_missing:[…], screen_text_excerpt}`。`screen_text_excerpt` 取画面文字的前 300 字。
7. `--allow-obscured "<理由>"` 只放行遮蔽层，不放行纯色画面。纯色画面的放行口只有一个，而且是正面证据：节点写了 `shows`、并且全在这张图上读到了（画面层级或 OCR），
   说明页面本来就几乎是空的（空状态、只有一行提示），拒收改成提示，sidecar 记 `checks.blank.released_by:"shows"`。
   observe 的 UI / Web 通道同一道闸：读到的值在截图上 OCR 认得出才放行；拒收的话要写明白屏本身就是被测物问题时怎么记 fail（`--failure-of subject`），不记成取证手段的缺口。
8. `validate` / 用例质量检查认识 `shows`：必须是非空字符串数组。

**文件**：新建 `core/shot-check.mjs`；改 `core/engine.mjs`（三条 shot 分支、observe UI 通道截图处、validate）、`core/case-quality.mjs`（如需）。

**测试**：`test/shot-check.test.mjs`：测试里自己生成 PNG（纯白、纯黑、杂色、两张只差几个像素的图），断言纯函数的结果；`shows` 的校验走 CLI。

**做完的标准**：纯色图被拒、相近图被提示、`shows` 生效、sidecar 有 `checks`；不碰设备的测试全过。

## B. 盲审包带上截图的附带记录

**要什么**：盲审看图时同时看到工具记下的事实：哪台设备、哪个包、哪个进程、什么时刻、前台窗口、画面标题、遮蔽层检查、事中检测结果、放行理由、画面文字摘录。

**为什么**：真实数据里盲审多次驳回「看不出构建 / 时间标识」，而这些信息就在截图旁边的附带记录里，只是没放进包。

**符合**：001「盲审只看证据包」——附带记录本身是证据的一部分；000「执行者不复核自己」——包里写明「这是工具记录的事实，不是结论；仍必须打开图片看」。

**怎么做**：`core/evidence-gate.mjs` 的送审包：证据是图片时，读同名 `.json` 附带记录，渲染成几行固定格式；没有附带记录时写明「没有工具记录：这张图不是工具截的」。包的内容指纹要把附带记录算进去（附带记录变了要重审）。

**文件**：`core/evidence-gate.mjs`。

**测试**：给一张带附带记录的图和一张不带的图，检查包文本。

## C. `next` 与卡片

**要什么**：`acceptkit next <需求> [--json]` 从记录推出这个需求还剩的每件事，按顺序列成卡片（002 第三节的表）。

**符合**：000「代码定：现在该做哪一步」；002「循环写在提示里，下一步由工具算」；001 不新增概念：卡片是已有状态的投影，不存盘。

**怎么做**：

- 新建 `core/cards.mjs`（各概念的卡片构造：评审单、运行、断言、步骤、finding、阻塞项、设备）和 `core/next.mjs`（`nextCards(root, demand)`，只读文件，不写）。
- 卡片顺序：`attention`（批准评审单、待拍板 finding、待提 / 已提未答的阻塞项）→ `plan_draft` → `round_stale` → 每个运行内：`device_needed` → `step_todo` → `expect_todo` → `rejected` → `review_due` → `report_due`；最后 `stalled`（运行 2 小时以上无任何变化且还有待测项）。
- 评审单里点名、但从没开跑的用例：出 `run_needed` 卡片（这是 002 表里缺的一类，补上）。
- UI 节点的断言都到了不用再截的终态（na / skip / fail / 进了阻塞台账的 blocked），或这一步登记了取证手段的问题（`apparatus --where step:nN`），就不再出 `step_todo`：截不了图的节点不能让运行永远到不了 `report_due`（000：判不了是正当终点；缺口由报告列出）。
- 每张卡片带 `note`（一条可照抄的命令，或一句话），长内容给 `read` 指针。
- 文本模式打印编号清单；清单为空时打印「这个需求没有剩下的事，报告都出完了：link」（要出报告时清单里是 `report_due`）。
- 和看板的「等你定」口径一致：未写清的 finding 不算 attention，算执行者待办（`finding_unclear`）。

**文件**：新建 `core/cards.mjs`、`core/next.mjs`；`core/engine.mjs` 注册命令和帮助。

**测试**：`test/next.test.mjs`：搭一个小项目，依次让它处在「评审单未批 → 批了没跑 → 跑了有 todo → 证据待审 → 全部完成」各状态，断言卡片种类和顺序。

## D. `device acquire` / `device reject`

**要什么**：选设备由代码完成并占上，执行者只核对代码看不出的东西，不对就否决，代码换下一台。

**符合**：000「代码先给候选，模型确认或否决，否决了代码给下一个」；001「设备租约」的规则不变；002 卡片返回。

**怎么做**：

- 把 `cmdDevicePick` 的候选计算抽成纯函数 `pickDevice({platform, need, run, exclude})`，`device pick` 继续用它打印。
- `device acquire --run R [--need k=v …]`：
  - 平台和宿主从 run 和用例推出，不用执行者传；`need` 合并用例上声明的能力要求和命令行传入的。
  - 排除本 run 里被否决过的设备（`r.device_rejects`）。
  - 选中「复用」档：直接 claim（holder 记为本 run 的执行归属），记一次 `device_picks`。
  - 选中「启动」档：调用适配器的启动能力（有就启动并等开机完成，带超时；没有就返回卡片说明怎么启动），启动后 claim。
  - 都不行：不 claim，返回 `attention` 卡片：为什么都不行、建议新建什么样的。只有每台都是配置层面的原因（不在白名单、能力不满足、宿主不对、本 run 否决过）才问人；
    有一台只是被别的 run 占着，就返回 `device_needed` 写明在等谁，`next` 也照旧出 `device_needed`，等它放出来再 acquire。
  - 返回设备卡片：设备身份、地址、平台、能力、被测 app 是否在跑及版本（能读到就读）。
- `device reject <设备> --run R --why "…"`：记进 `r.device_rejects`（时间、理由），如果是本 run 占着的就释放，然后自动再 acquire 一次并返回结果。
- `next` 的 `device_needed` 卡片的 note 改成 `device acquire --run R`。
- iOS：已连接、已开机的模拟器也进候选（`xcrun simctl list devices booted`，取不到就按现状）。

**文件**：`core/engine.mjs`、`adapters/android/device.mjs`（如需启动能力）、`core/next.mjs`。

**测试**：设备列表要能注入（例如适配器读一个由测试设置的设备快照来源），断言：复用档被选中并占上；否决后换下一台；全部不可用时返回 attention 且没有占用。

## E. 命令清单、`--json` 返回与 `read`

**要什么**：002 第一节：一本能被各家 agent 读懂的命令清单；循环里用到的命令能返回卡片；长内容分页读。

**符合**：002 全部；000「概念少」——清单只覆盖循环用到的命令，其余命令以后再补。

**怎么做**：

- 新建 `core/protocol.mjs`：循环命令的声明式定义——`next`、`device acquire`、`device reject`、`shot`、`observe`、`record`、`reviewq`、`report`、`plan finding`、`blockers`、`context`、`read`。每条：`name`、`description`（用途 + 什么时候用 + 什么时候别用）、`input_schema`（JSON Schema，`additionalProperties:false`，字段说明写规则）、`argv` 模板、`returns`（卡片种类）。
- `acceptkit protocol [--json]`：打印清单。
- 这些命令的参数检查改为按各自的定义拒绝不认识的参数（替代全局白名单对它们的作用）。
- `--json`：上面这些命令改动后返回 `core/cards.mjs` 的卡片；批量（`observe` 多条、`reviewq --apply`）返回 `{"results":[…]}`，被拒的项带 `refused`；整条失败时 stdout 输出 `{"refused":"…"}`、退出码非 0。人话输出保持不变（不加 `--json` 时行为不变）。
- `gate` 原来用 `--json` 传载荷，改名 `--payload`，同时更新调用它的地方和文档。
- `acceptkit read <资源> [--offset N] [--limit M]`：资源名 `plan/D`、`finding/D/F3`、`blocker/D/B2`、`case/C`、`case/C#n1.2`、`run/R`、`run/R/E1`、`run/R/step/n1`、`run/R/file/<相对路径>`；文本按字符分页（默认 4000、最多 8000），列表按项分页（默认 20、最多 50），返回 `next_offset`。
- 清单内容要和真实命令一致：测试里对每条定义检查 `argv` 模板里的参数都在 `input_schema` 里。

**文件**：新建 `core/protocol.mjs`；改 `core/engine.mjs`、`bin/acceptkit.mjs`（如命令在那里注册）、引用 `gate --json` 的文档和测试。

**测试**：`test/protocol.test.mjs`：清单自洽；`record --json` 返回断言卡片；被拒时 `{"refused"}` 加非 0 退出码；`read` 分页。

## F. `context`

**要什么**：002 第四节：执行到某个节点时，一次拿到这一步需要的经验。

**符合**：000「经验是数据，执行到那一步时由工具递给 agent」；001「操作」「知识」。

**怎么做**：`acceptkit context <run> --node nN [--json]` 返回：

- 节点的操作和这个平台、宿主上的做法（含推测 / 已确认 / 已验证状态；推测的标明「不执行」）；
- 节点的 `shows`、危险等级（`danger`）；
- 相关知识：按操作 id、操作标题里的词、节点标签检索 `knowledge/`，最多 8 条，每条带出处和状态；
- 可能遇到的遮蔽层和关法（`OBSCURING`，含项目扩展追加的）；
- 这个用例同一节点在以往运行里的情况：失败几次、取证手段故障几次、盲审驳回的理由（最多 5 条）；
- 截图做法（`shot-guide.mjs` 的那几行）。

长内容只给前 300 字和 `read` 指针。`next` 的 `step_todo` 卡片 note 后面加「需要经验：acceptkit context R --node nN」。

**文件**：新建 `core/context.mjs`；改 `core/engine.mjs`、`core/next.mjs`、`core/protocol.mjs`。

**测试**：搭一个带操作库、知识和一次失败历史的小项目，断言返回各段都在。

## G. 手册改成循环契约，顺手收口

**要什么**：`skill/SKILL.md` 按 002 第二节改成「拉 next → 照卡片做 → 核对返回 → 再拉 next」；修掉梳理时发现的不一致。

**符合**：000「手册只讲循环和几条铁律」；002 第二节。

**怎么做**：

- `SKILL.md`：「日常」表里被 `next` 覆盖的流程改写成循环契约（停止条件：只剩 attention 就停下问人；清单为空就 link 给报告地址）；保留铁律；写明 `protocol`、`context`、`read`、`device acquire/reject` 和事中截图检测。`skill/devices.md` 的命令一节改用 `device acquire`。
- `engine-help`：plan 子命令列表补上 `decide|bounce|settle|review`；去掉指向已废弃子命令的提示。
- 阻塞项自动关：同一断言后来记成 pass / fail / na 时，对应未关的阻塞项记为「工具关闭」（关闭方式写清是哪个 run 的哪条结论），看板和 `next` 不再显示它。
- 更新 `docs/002-protocol.md` 的状态行：写明哪些已实现。

**文件**：`skill/SKILL.md`、`skill/devices.md`、`core/engine.mjs`、`core/plan-gate.mjs`、`docs/002-protocol.md`。

**测试**：阻塞项自动关闭的测试；帮助文本里不再出现已废弃的子命令。

## 暂不做（记下来，后面再排）

- 统一「待人处理」，危险动作在命令内部过闸并记录确认。
- 手记判定改成「引文 + 逐条判断，代码重算」。
- 代码变了自动给出受影响断言和重跑范围。
- MCP 通道。
