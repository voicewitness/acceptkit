# 参与贡献

## 跑起来

需要 Node 22.5+（用到内置的 `node:sqlite`），没有第三方依赖。

```bash
npm test                      # 全部测试
node bin/acceptkit.mjs --help
```

## 改之前先读

- [docs/constraints.md](docs/constraints.md)：每条约束都对应一次真实发生过的误判。改代码不能弱化它们；要改，先在 issue 里说清楚那次误判为什么不会再发生。
- [docs/001-domain.md](docs/001-domain.md)：代码、命令、文档共用的词。新概念先写进这里。
- 红线：**不许假通过**。没有证据不能记通过，没有本人原话不能记批准。新加的写路径都要过这两条。

## 代码地图

| 文件 | 管什么 |
|---|---|
| `bin/acceptkit.mjs` | 入口：项目定位、`doctor`、`serve` / `link`，其余转给 engine |
| `core/engine.mjs` | 大部分命令的实现（用例、运行、观测、记录、设备、评审单、阻塞、报告） |
| `core/protocol.mjs` | 命令清单：参数、说明、各家工具格式的导出 |
| `core/next.mjs` · `core/cards.mjs` | 从磁盘推出「还剩什么」，排成卡片 |
| `core/plan-gate.mjs` | 评审单与阻塞台账 |
| `core/evidence-gate.mjs` · `core/visual-gate.mjs` · `core/shot-check.mjs` | 证据闸：通过要有什么证据 |
| `core/case-quality.mjs` · `core/assess.mjs` | 用例质量规则与评价 |
| `core/host-hooks.mjs` · `core/hooks.mjs` | 宿主钩子：各家 agent 的配置格式，拦什么 |
| `core/store/db.mjs` | SQLite：租约、审批、评价 |
| `core/server.mjs` · `core/dashboard.mjs` | 本机看板 |
| `adapters/` | 载体：web（CDP）、android（adb）、ocr（macOS Vision） |

`core/engine.mjs` 很大，后续会按命令拆开。新命令优先放进独立模块，在 engine 里只留转发。

## 内核还是 pack

只对某一个项目有用的东西（私有诊断通道、目标解析、领域命令、项目特有的质量规则）放进那个项目的 `pack.mjs`，不进内核。示例见 `examples/web-demo/pack.mjs`，接口见 [docs/architecture.md](docs/architecture.md)。

## 提交前

```bash
npm test
node scripts/leakscan.mjs      # 查绝对路径、内网地址、密钥这类不该进公开仓库的东西
```

`leakscan` 还可以读两个只在你本机的词表：`ACCEPTKIT_DENYLIST`（一个文件，每行一个不许出现的正则）和 `ACCEPTKIT_PRIVATE_PROJECTS`（你的私有项目目录，冒号分隔；会自动收集其中的用例 id、操作 id、包名、需求号等，出现在仓库里就报）。想每次提交自动跑，执行 `git config core.hooksPath .githooks`。

提交信息用英文，`type(scope): 做了什么`，例如 `fix(blockers): keep owner answers on concurrent writes`。
