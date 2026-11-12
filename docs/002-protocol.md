# 002 协议：工具怎么和执行者说话

状态：部分实现（按 [003 改造](design/003-changes.md) 的 A–G）。本篇建立在 [000 理念](000-philosophy.md) 和 [001 角色与概念](001-domain.md) 之上。

- **已实现**：`protocol` 命令清单、循环命令的 `--json` 卡片返回与 `{"refused"}`、`read` 分页（一节）；
  手册 `skill/SKILL.md` 改成循环契约（二节）；`next` 和第三节的卡片，`app_not_ready` 除外；
  `context`（四节）；第五节的「选设备」（`device acquire` / `device reject`）、「下一步做什么」、
  「收尾」（断言后来记成 pass / fail / na 时阻塞项由工具关闭；`report_due`）、「中断恢复」（`stalled`）；
  截图那一刻的检测（纯色画面、和上一张几乎一样、节点 `shows`、读不到层级时 OCR 查遮蔽层）。
  「问人」里 finding 拍板这一种：`plan_decide` / `plan_settle` 进了命令清单；一次可记几条、可记选中的选项；
  `--by` 不能是执行者自己；`settle --kind answered` 要指出事实在哪（运行，或一条 Owner 定过的），Owner 的回答只能走 decide；
  每次拍板另记一条进 SQLite 审批表。
  等回答的 attention 卡片都带 `on_reply`（用户回了要跑的那条命令，填好了），`plan_approve` / `plan_bounce` 也进了命令清单。
- **还没做**：`app_not_ready` 卡片和「把 app 起到能测的状态」；危险动作在命令内部过闸并记录确认；统一待人处理（finding 之外的批准、解除阻塞、危险确认还各记各的）；
  手记判定改成「引文 + 逐条判断，代码重算」；代码变了自动给出受影响断言和重跑范围（现在只出 `round_stale`）；
  运行里记下手册和协议版本；MCP 通道。

acceptkit 不在任何 agent 框架里面：我们不能往执行者的工具列表里注册工具，也没有自己的循环。
所以要解决三件事：

1. 让各家 agent 都看得懂「有哪些命令、怎么调」—— **模仿各家通用的工具调用格式**；
2. 让执行者在循环里照我们的流程走 —— **循环写在提示里，「下一步」由工具算**；
3. 让我们管的经验（操作、用例、执行建议、finding 标准、证据审核规则）被执行者充分取用和检查 —— **按需拉取，由工具校验**。

## 一、模仿工具调用

各家 agent 框架描述工具的方式基本一致：名字、一段说明、一份 JSON Schema 描述参数。

| 框架 | 工具定义 | 工具结果 |
|---|---|---|
| Anthropic Messages API | `{name, description, input_schema}` | `tool_result`，出错时 `is_error` |
| OpenAI | `{type:"function", function:{name, description, parameters}}` | 函数返回的字符串 |
| MCP | `{name, description, inputSchema}` | `{content, structuredContent, isError}` |
| 某开源 agent 框架 | 名字 + 说明 + 严格参数格式，字段说明里写规则 | 各工具自己的小结构；被拒是一项里的 `refused` 字段 |

acceptkit 照这个形状出一本**命令清单**：

```
acceptkit protocol --json
```

```json
{"name":"record","description":"手记一条断言的结论。能用 observe 的断言不要手记。",
 "input_schema":{"type":"object","additionalProperties":false,
   "required":["run","expect","status"],
   "properties":{
     "run":{"type":"string"},
     "expect":{"type":"string","description":"断言 id，如 E3"},
     "status":{"enum":["pass","fail","blocked","skip","na","todo"]},
     "quote":{"type":"array","items":{"type":"string"},
              "description":"证据原文里的片段，工具会去证据里找；找不到就拒收"}}},
 "argv":"acceptkit record {run} --expect {expect} --status {status} [--quote {quote}...]",
 "returns":"expect 卡片"}
```

- 清单从命令行解析用的同一份参数定义生成，两边不会对不上。
- 命令本身照旧接命令行参数，执行者照 `argv` 拼出命令来执行。不要求每个命令都接收 JSON。
- 宿主支持 MCP 的话，同一本清单可以原样挂成 MCP 工具，命令本身不用改。

命令加 `--json` 时返回卡片，规矩参照那个开源 agent 框架：

- 返回被改动的那张卡片（最新的完整状态），不返回「从什么变成什么」；
- 批量命令一项一个结果，被拒的那项带 `refused`，内容是一句能照着改的话，其余项照常执行；
- 整条命令没执行时退出码非 0，输出 `{"refused":"…"}`；
- 长内容只给预览和 `read` 指针，执行者需要时用 `acceptkit read <资源> --offset N --limit M` 分页取。

## 二、循环写在提示里

我们没有循环，所以把循环写成手册里的一条契约。执行者照着跑，也可以挂在宿主的自驱动能力上（定时循环、目标模式之类），
**停止条件由工具给**：

```
0. 用户刚说了话：他回答了哪几张 attention 卡片，先照那几张的 on_reply 记下原话
1. acceptkit next <需求> --json            # 工具从记录推出还剩什么，列成卡片
2. 取第一张你能做的卡片，照它的 note 做；
   需要经验时：acceptkit context <运行> --node <节点> --json
3. 读命令返回的卡片，核对是不是你预期的状态；
   被拒：照 refused 的话改了再做；同一张卡片连续被拒 3 次，记成取证手段的问题（apparatus），换下一张
4. 回到 1。
   清单里只剩 attention 卡片：把问题原样交给用户，停下等回答
   清单为空：报告都出完了（要出报告时会有 report_due 卡片），link 把报告地址给用户
```

这样做的效果：

- 「做到哪了」不靠执行者记，每一轮都从磁盘重新算；会话中断、换一个 agent，从第 1 步接着做。
- 手册不用再写「先做 A 再做 B」的长表，顺序在 `next` 里。
- 执行者问人的时机由卡片决定：只有出现 attention 卡片才问，问的内容就是卡片上的问题。
- 用户怎么回答，工具看不到（只在聊天里）。所以卡片把「回了之后跑哪条命令」也带上（`on_reply`）：
  用例状态靠工具从记录算，人的回答也要先变成记录，下一轮 `next` 才算得出它已经答过。第 0 步就是为这个。

## 三、卡片

每张卡片有 `kind`，带 `note` 说明这一步怎么做，长内容给 `read` 指针。

| kind | 什么时候出现 | note 大意 |
|---|---|---|
| `plan_draft` | 评审单还没写完或没过检查 | 补改动面 / 用例，`plan check` |
| `attention` | 有事等人：批准评审单、拍板 finding、解除阻塞、确认危险动作、补信息 | 把 question 原样交给用户；与它无关的卡片照常做；用户回了先跑 `on_reply` |
| `device_needed` | 运行还没有设备 | `device acquire --run R` |
| `app_not_ready` | app 没起来、不在前台、被挡住 | 先让工具处理已知情况，处理不了的按画面上的字判断怎么关 |
| `step_todo` | 操作节点还没留过程证据 | 做这一步，`shot --step` |
| `expect_todo` | 断言还没有结论 | `observe`；observe 做不了的才手记 |
| `review_due` | 有证据还没盲审 | `reviewq --pack`，交给新上下文的子 agent，结论原样 `reviewq --apply` |
| `rejected` | 盲审驳回 | 照驳回理由补证据，重新判 |
| `round_stale` | 被测代码变了 | 看工具给出的受影响断言，逐条确认继承或重置 |
| `stalled` | 一个运行长时间没动静 | 先查实际状态，别重复已经做过的外部动作 |
| `report_due` | 一条用例的断言都有结论、证据都审过 | `report` |

```json
{"kind":"expect_todo","run":"R","expect":"E3","assert":"…前 160 字","read":"run/R/E3",
 "note":"acceptkit observe R --expect E3"}
```

**评审单改了一版。** 批过的单子又加了用例，`plan_approval` 卡片只问这次的变化（`added` / `removed`），
`held` 里只有新加的用例；已批过的用例照常出 `run_needed` / `expect_todo`，`run` 也放行（`gateRun` 同口径）。
「批过哪些」就是批准时钉了指纹的那些用例（`plan.fingerprints` 的键），不另存；每次批准在审批表里记下 `{revision, added, removed}`。

**局部重跑。** 新一轮只重置了几条断言，为它们开的新运行里其余断言是空的：结论继承自更早一轮的，不出 `expect_todo`，
只有被重置的和从没测过的才是待办（与看板「本轮状态」同一份计算，`rounds.mjs resolveState`）。同一轮里再开一个运行仍按全部重测算。

**每条用例在哪一步。** 不另存状态，从卡片推出（`next.mjs caseStages`）：用例身上最靠前的那张卡片定它的阶段 ——
挂在批准 / 草稿卡片 `held` 里 → 用例评审；`run_needed` / `device_needed` / `step_todo` / `expect_todo` / `rejected` / 阻塞 → 执行；
`review_due` → 盲审；`report_due` → 报告；没有卡片 → 完成。看板最新一轮按这个分布显示，finding 等拍板是需求级的，不挡用例往下走。

```json
{"kind":"attention","subject":"finding","demand":"D1","finding":"F3","question":"…",
 "options":["1. 改 => …","2. 不改 => …"],"recommend":"…",
 "on_reply":{"command":"plan_decide",
   "argv":"acceptkit plan decide D1 --finding F3 --by <他> --quote \"<原话>\" [--option <序号|recommend>] --json"}}
```

## 四、经验：既是提示，也是可以调的函数

我们管的经验分两种用法：

| 经验 | 变成代码的部分（工具检查） | 留在提示里的部分（执行者按需取用） |
|---|---|---|
| 操作库 | 推测的做法不执行；被引用的操作不能删 | 每个平台、宿主上怎么做，`context` 递给执行者 |
| 用例质量标准 | 不达标不能批准、不能开跑 | 机器判断不了的几问，评审时逐条回答 |
| 执行建议（例如截图怎么截） | 没有 app 截图不能记通过；画面被挡住拒截 | 什么时候截、遮蔽层怎么关 |
| finding 标准 | 缺性质、影响、选项的不收；人话区夹代码标识的不收 | 怎么写得让 Owner 能拍板 |
| 证据审核 | 证据变了要重审；回写时内容必须和送审时一致 | 盲审逐条问的那几问 |
| 项目知识 | 机密值遮蔽 | 账号、坑、做法 |

`context` 一次返回执行这一步需要的经验：这个节点的操作做法、可能遇到的遮蔽层和关法、危险等级、
这里上次失败过几次和原因、相关的知识条目。执行者不必一次读完整本项目手册。

**一条经验能变成检查，就变成检查，并删掉手册里那段原文；变不成的，才留在提示里。**

## 五、代码定，模型判

依据 [000 理念](000-philosophy.md)。下表是每个环节的分工，参照那个开源 agent 框架的做法（谁、何时、在哪、几个、什么状态由代码定）。

| 环节 | 现在 | 改成：代码定 → 模型判 → 失败怎么办 |
|---|---|---|
| **选设备** | `device pick` 算出了一台，但只打印建议；平台和能力要求要执行者从用例里读出来传进去；claim、启动都要执行者自己做；iOS 不列已连接设备 | `device acquire --run R`：代码从用例和宿主推出平台、能力要求，按「复用 → 启动 → 新建」选一台，白名单内的直接启动并占上，记下被测物身份，返回设备卡片。模型只核对代码看不出的东西（登录的账号对不对、页面能不能测）。不对就 `device reject <设备> --why "…"`，代码排除它再选下一台；没有可用的，出一张 attention 卡片 |
| **下一步做什么** | 执行者按手册自己拼 | `next`：代码从记录推出 |
| **危险动作** | 要执行者记得先调 `gate`；「用户点过头」不留记录 | 装包、构建、驱动、项目扩展的操作在命令内部自己过闸；要人确认的出 attention 卡片，确认记进审批表（谁、原话、经由命令行还是看板） |
| **把 app 起到能测的状态** | 执行者自己起 app、自己关弹窗 | 代码先起 app、拉到前台、按项目登记的关法处理已知遮蔽层；处理不了的，返回画面上的字和按钮坐标，由模型判断怎么关，关完再交给代码检查 |
| **判定** | `observe` 由工具判；手记时执行者直接写结论 | 手记时模型交出引文和逐条判断，结论由代码按断言的谓词重算；引文必须在证据原文里找得到 |
| **盲审** | 执行者自己决定什么时候送审 | 代码决定哪些证据要审、什么时候打包；模型负责派新上下文的子 agent，并把结论原样带回；回写时核对证据没变过（已有） |
| **代码变了** | 执行者自己发现、自己评估 | 代码发现提交变了，算出受影响的断言，给出建议的重跑范围；模型逐条确认或否决并写理由 |
| **评审单选用例** | `select` 推荐 | 不变：代码给候选和理由，模型判断改动面，Owner 批 |
| **问人** | 四种问法，记录各不一样 | 统一成待人处理：种类固定，id 由内容算（同一问题只发一次），回答从看板进来时记成本人回答。值不值得问，由模型判断 |
| **收尾** | 执行者自己出报告、放设备 | 断言过了，对应的阻塞项自动关；`next` 出 `report_due`；报告出完释放设备（已有） |
| **中断恢复** | 无 | 设备租约有心跳（已有）；运行长时间没动静出 `stalled` 卡片 |
| **手册版本** | 无 | 运行里记下当时用的手册和协议版本 |

## 六、顺序

1. `next` 和卡片；`device acquire` / `device reject`，做成第一个「代码给候选、模型确认」的样板。
2. 危险动作在命令内部过闸并记录确认；统一待人处理。
3. 手记判定改成「引文加逐条判断，代码重算」；代码变了自动给重跑范围；`context`。
4. `protocol` 命令清单、`--json` 返回、`read` 分页；手册缩成循环契约，项目手册的铁律逐条归类。
