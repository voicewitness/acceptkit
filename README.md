# acceptkit

[English](README.en.md)

**让编码 agent 做的验收，结论能信、能复核。**

编码 agent 已经能自己点 App、开浏览器、读日志，让它「去验收一下」，几分钟就回一句「验过了，通过」。难的是这句「通过」能不能信：点的是不是被测的那个包、那台设备？截图里是结果页还是登录弹窗？「没看到报错」是真没有，还是没去看？

acceptkit 是一套本机运行的验收工具。你的编码 agent（Claude Code、Codex、Cursor、Gemini CLI……）加载 `skill/SKILL.md` 后，通过它在真实的 App、浏览器、模拟器上执行验收。工具层**不调用任何模型**，它只做能算出来的事：

- **没证据记不了通过。** 观测由工具执行、原文落盘、按规则判定；agent 手工记录时引用的原文，必须在证据里找得到。
- **执行者不复核自己。** 每份证据交给一个只看证据包、没参与执行的新上下文盲审。
- **批准主体如实记录。** 测哪些用例默认由人批准；用户明确授权的范围内可由执行者批准评审单，须同时记录用户授权原话、范围和本次批准理由。未批准不能开跑；其他需要用户决定的问题仍只认用户原话。
- **手册守不住的交给钩子。** 绕开 acceptkit 直接起关设备、装卸包、改验收记录，会被宿主钩子拦下。
- **下一步由工具算。** agent 每一轮先问 `next`「还剩什么」，照返回的卡片做一步再问。状态全在磁盘上，换个会话、换个 agent 都能接着做。

## 和其他做法比

| 做法 | 擅长 | 留下的问题 | acceptkit 怎么补 |
|---|---|---|---|
| 脚本化 E2E（Appium、Espresso、XCUITest、Playwright、Maestro） | 确定、可重复 | 写和维护都贵，界面一改就断；新需求要先写脚本 | 用例是人话操作 + 断言，由 agent 对到当下的界面上；判定规则仍由工具执行 |
| 让模型直接操作界面并给结论的 AI 测试 agent | 灵活，不用写脚本 | 结论是模型说的，没有可复核的证据，经验留在一次对话里 | 结论只能由证据推出，证据落盘可复核；踩过的坑沉淀成项目知识和检查 |
| 用例管理平台 | 管用例、管状态 | 用例是一句抽象的话，执行和判断全靠人 | 用例自带观测规格和适用范围，人和机器读同一份 |

acceptkit 不替代上面的驱动工具。它可以调用它们：项目里登记「怎么构建、怎么点」的命令，acceptkit 负责用例、证据、闸门和记录。

## 快速开始

需要 Node 22.5+ 和本机的 Chrome。下面用仓库自带的示例项目 `examples/web-demo`（一个「满 99 包邮」的购物车静态页）从头走到一份报告，十分钟左右。

```bash
git clone https://github.com/voicewitness/acceptkit.git && cd acceptkit/examples/web-demo
node ../../bin/acceptkit.mjs env          # 看看本机有什么（Chrome / 模拟器 / adb）
```

#### 1. 体检

```bash
node ../../bin/acceptkit.mjs doctor --fix
```

第一次打开一个项目时用 `--fix`：它会登记「用例质量基线」（以后新写的用例按它卡质量），并把 `knowledge/` 的文件权限收紧到只有你能读（知识里可能写着账号；git 检出的文件默认别人也能读）。最后一行是「全部通过」就可以往下走。没有 adb / 模拟器只会打一行提示，不影响这个示例。

#### 2. 打开被测页面

```bash
node ../../bin/acceptkit.mjs browser "file://$PWD/site/index.html"
```

会起一个**独立的** Chrome 窗口（调试端口 9360，用户目录在 `.acceptkit/` 里），和你日常用的浏览器互不影响。后面的观测都在这个窗口里读页面。端口被占用时它会拒绝并告诉你。

#### 3. 写评审单，并由人批准

验收先说清这次改了什么、打算用哪些用例验，由人批准后才能跑：

```bash
node ../../bin/acceptkit.mjs plan new DEMO-1 --title "示例需求：满 99 包邮" --platform web
node ../../bin/acceptkit.mjs plan add-case DEMO-1 --surface S1 --change "购物车包邮提示" \
  --risk "门槛算错：差一点的用户被收运费，或满额的用户没有免运费" \
  --uncovered "优惠券、多件商品叠加" --reuse cart-free-shipping
node ../../bin/acceptkit.mjs plan check DEMO-1
node ../../bin/acceptkit.mjs plan approve DEMO-1 --by "<你的名字>" --quote "<你批准时的原话>"
```

`plan approve` 默认由人批准。用户明确授权执行者批准特定范围的用例时，可填写实际执行者、批准理由、授权用户、授权原话及适用范围；工具会把代理授权写入审批记录。没有明确授权时，agent 会停下来把评审单给你看，等你的原话。

#### 4. 开跑、观测

```bash
node ../../bin/acceptkit.mjs run cart-free-shipping --demand DEMO-1
RUN=<上一步打印的 run id，形如 2026-11-12-cart-free-shipping-r1>
node ../../bin/acceptkit.mjs observe $RUN
```

`run` 会打印截图的做法（真实验收里每一步都要用 `acceptkit shot` 留过程截图）；这个示例的结论图由 `observe` 读页面的同一刻自己截，可以先不截。

`observe` 逐条读页面、按断言判定，预期结果是：

| 断言 | 结果 | 演示的是什么 |
|---|---|---|
| E1、E3 | ✅ pass | 读页面上的文字，同一刻截图 |
| E2 | ✅ pass | 项目扩展：`pack.mjs` 提供的 `demo-diag` 诊断通道，直接读页面报告的「是否包邮」，证据强度 S1 |
| E4 | ⛔ blocked | 断言要求后台直接证实运费（至少 S1），示例没有后台：诊断通道报「读不到」，降级去读页面文字（S2），强度不够，**记为阻塞 B1** |

#### 5. 卡住了 → 告诉 owner

这时出报告会被拒绝：

```bash
node ../../bin/acceptkit.mjs report $RUN
# 报告不出 —— 这一轮还有没提给 owner 的阻塞
```

这是有意的：「因为什么没测完」应该在执行时就告诉 owner，而不是让他在报告里才读到。所以先把阻塞写清楚、提出去：

```bash
node ../../bin/acceptkit.mjs blockers DEMO-1                     # 看阻塞台账
node ../../bin/acceptkit.mjs blockers DEMO-1 --set B1 \
  --unlock "接入订单后台的查询接口（在 pack.mjs 里加一个观测通道），让结算运费能直接读到" \
  --review-note "评审时漏了：示例站点没有订单后台，要求的读法从一开始就拿不到"
node ../../bin/acceptkit.mjs blockers DEMO-1 --raise
```

- `--unlock`：要做什么才解得开。
- `--review-note`：复盘。这类「能力缺口」本该在评审单阶段就发现，执行时才撞上，就要写下评审时为什么没发现。
- `--raise`：生成一段可以直接发给 owner 的话，并把这条标记为「已提」。

#### 6. 出报告

```bash
node ../../bin/acceptkit.mjs report $RUN
```

报告写在 `runs/<run id>/run.md`（和机器可读的 `run.json`），结论是 PARTIAL：3 条通过、1 条阻塞。它还会提醒你这轮没有记录被测物（`acceptkit sut`：在验哪个分支 / 哪个版本），真实项目里开跑前记一下。

做完把第 2 步打开的那个浏览器窗口关掉即可。想重来一遍：删掉示例目录下的 `.acceptkit/`、`runs/`、`state/`（都是运行时生成的，不进仓库）。

示例里还有什么可以看：

- `cases/cart-free-shipping.case.json`：用例 = 操作树 + 人话断言 + 观测规格（含后备通道、最低证据强度）。
- `ops/registry.json`：操作库，用例只说做什么，这里说各平台怎么做。
- `pack.mjs`：项目扩展钩子的最小样例（一个私有观测通道）；约定见 `docs/architecture.md`「扩展模型」。

## 几个词

| 词 | 意思 |
|---|---|
| 需求（demand） | 一次要验收的改动，比如「满 99 包邮」 |
| 用例 / 断言 | 用例是一棵操作树；每一步上挂断言，断言写明怎么观测、什么算通过 |
| 评审单（plan） | 这次需求跑哪些用例。人批准之前不能开跑 |
| 运行（run） | 一条用例的一次执行，证据都放在它的目录里 |
| 盲审 | 另起一个只看证据包的上下文，判证据够不够 |
| 阻塞（blocker） | 执行中卡住、要人回答或要外部条件的问题 |
| 闸门 | 工具在动设备、记结论之前做的强制检查 |
| 卡片 | `next` 返回的「下一步做什么」 |
| owner | 需求负责人，拍板的人；执行者是 agent |
| pack | 项目私有的扩展：私有观测通道、目标解析、领域命令 |

完整的概念见 [001 角色与概念](docs/001-domain.md)。

## 支持什么

| | 说明 |
|---|---|
| Web | Chrome（CDP），在独立的调试实例里跑，不碰你的主浏览器。非 macOS 默认找 `google-chrome`，可用 `CHROME_BIN` 指定 |
| Android | 真机或模拟器，需要 `adb` |
| iOS | 模拟器，需要 Xcode（`xcrun simctl`） |
| 截图文字识别 | 仅 macOS（Vision） |
| 宿主钩子 | Claude Code、Codex、Gemini CLI、Cursor（`acceptkit hook install --host …`） |
| 运行环境 | Node 22.5+，无第三方依赖。目前只在 macOS 上验证过 |

0.x 阶段，命令和文件格式还可能变。

## 接入你自己的项目

一个项目是一个目录，不放在本仓库里：

- `acceptkit.project.json`：允许操作的设备 / 包 / 租户（白名单外一律拒绝）、被测 App 信息
- `cases/`：用例
- `ops/registry.json`：操作库（每个观测怎么做）
- `knowledge/`：项目知识，普通 Markdown；带 `#secret` 标签的值不会出现在证据和报告里
- `pack.mjs`（可选）：项目私有扩展，写法见 `examples/web-demo/pack.mjs`

`node bin/acceptkit.mjs project init <目录>` 新建一个。详见 [架构](docs/architecture.md)。

## 文档

按顺序读，每篇只用到前面讲过的概念：

1. [000 理念](docs/000-philosophy.md)：要解决什么问题，为什么是工具箱而不是又一个 agent
2. [001 角色与概念](docs/001-domain.md)
3. [002 协议](docs/002-protocol.md)：工具怎么和 agent 说话，循环怎么跑
4. [架构](docs/architecture.md) · [模块约束](docs/constraints.md) · [用例质量标准](docs/case-quality.md) · [finding 怎么写](docs/finding-quality.md)

`docs/design/` 下是设计过程中的文档，不代表当前行为。

## 参与

见 [CONTRIBUTING](CONTRIBUTING.md)。安全问题见 [SECURITY](SECURITY.md)。

## 许可

Apache-2.0
