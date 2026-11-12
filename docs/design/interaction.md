# 用户交互

可点击原型：[prototype/agent.html](prototype/agent.html)（浏览器直接打开，顶部可切换四种用户环境）。原型演示的是二期的「内置 Agent」界面；一期的 Skill 入口在宿主编码 agent 的对话里完成同样的流程，界面只读展示。

## 冷启动

```
① 检查环境：设备、浏览器、工具链、设备占用、启动目录          acceptkit env
② 用户决定验收哪个项目                                          acceptkit project init / show（或 --project）
   · 从某个项目目录启动：问「这次验收这个项目吗？」
   · 否则：用户给代码目录 / 安装包 / 设备上已装的 App / 网址
③ 读取并核对被测对象身份：版本、构建来源、宿主                  acceptkit sut <run> / know add
④ 读用户给的材料，发现：关联系统、危险操作、观测通道及前提、
   旧用例                                                       acceptkit know add
   每端的构建方式、驱动 App 的工具：发现的写成推测设置，你确认   acceptkit setting set … --guess / setting confirm
⑤ 划定可动范围：白名单、危险动作；占用冲突先问                  acceptkit device acquire / gate
⑥ 带到可测状态：安装、启动服务、登录（独立浏览器实例）          acceptkit gate / login web / browser
⑦ 冒烟：走真实路径，每条结论写依据                              acceptkit run / observe / report
⑧ 交接：环境画像 + 缺口清单                                     acceptkit know profile
```

## 日常使用

| 用户怎么说 | Agent 做什么 | 命令 |
|---|---|---|
| 贴需求 / bug 单 / 一句话 | 登记需求，拆改动面，复用 / 新建 | `plan new`、`plan add-case`、`plan finding` |
| 「加一条用例」 | 新建骨架并给出质量标准；写完检查，不达标的逐条说明教训和修法；机器判断不了的问题逐条问作者 | `new`、`validate`、`quality` |
| 「批准」 | 用户批准后才能运行；记录原话 | `plan approve` |
| 「开始验收」 | 建运行，占用设备，逐步记证据，按观测规格判定 | `run`、`device acquire`、`record`、`observe` |
| 遇到危险动作 | 停下来问 | `gate` |
| 「回归一下」 | 评审单点名的全部用例各跑一轮 | `regress`、`round` |
| 「出报告」 | 报告是结果的投影 | `report` |
| 「报告地址发我一下」 | 按上下文定位（说了哪次运行 / 哪个需求 / 哪条用例；没说就是刚跑的那次），给打开就停在那份报告上的网址；网址是 acceptkit 自己的管理页面；看板另外嵌在别的页面里时网址形状由配置 `dashboard.url` 定 | `link` |
| 「提个 bug」 | 从失败断言生成缺陷单 | `bug` |
| 「这条以前跑过吗」 | 历史链 | `history` |
| 「记一下：……」 | 写进知识，来源记「用户说的」 | `know add` |
| 「用 #restricted 账号登录」 | 按标签找知识 | `know find` |
| 「Android 上连点三次 logo 能进调试菜单」 | 写回操作库：这个平台的配方；Agent 自己推测的标推测，实测跑通的标已验证 | `ops set`、`ops confirm` |
| 「允许这台模拟器」 | 写进项目配置，写入时校验 | `config add gate.allow` |
| 「还要在 xx App 上验」「被测包是 xx」 | 登记成一个宿主；它的构建做法先借鉴已有 App 的，试通再升级，走不通改它自己的那份 | `host add`、`setting borrow`、`build --try` |
| 「iOS 用这个脚本构建」「用 xx 驱动 App」 | 写进固定位置的设置（同平台覆盖旧的），之后流程按设置执行 | `setting set`、`setting show`、`build`、`drive` |
| 「有多少用例在 Android 上能跑」 | SQL 查询索引 | `index`、`query` |
| 「导入这份旧用例」 | 条数守恒地导入，判定不了的标出来 | `import` |
| 「这次改动该跑哪些」 | 按平台 / 改动面 / 版本推荐复用，带理由 | `select` |
| 「打开看板」 | 本地静态页面 | `open` |

## 四种用户环境

| 环境 | 冷启动要点 |
|---|---|
| 只有代码 | 用户确认项目 → Agent 用项目脚本起服务（能读服务端日志）→ 发现第三方调用并标危险 → 征得同意后只读查本地数据库 |
| 只有安装包 | 用户选安装包 → 读出版本，与设备上的版本比对 → 只用模拟器，不碰个人真机 → 如实说明拿不到 App 内部状态 |
| 大仓 + 多宿主 | 默认不构建，只用仓库官方构建脚本 → 问清验引擎还是验宿主集成 → 发现设备被占用先问 → 采集开关必须启动前打开，记为判读陷阱 |
| 内网配置后台 | 独立浏览器实例登录 SSO → 只允许测试租户 → 识别发布 / 删除 / 清空并逐次确认 → 接口只用来回读，操作必须走页面 |
