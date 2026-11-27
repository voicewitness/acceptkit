// protocol — 命令清单：循环里用到的命令，照各家 agent 通用的工具定义格式写成数据（docs/002-protocol.md 第一节）。
//
// 每条：name（只含字母数字下划线，各家工具名都收）+ description（用途、什么时候用、什么时候别用）
//      + input_schema（JSON Schema，字段说明里写规则）+ argv（执行者照它拼命令行）+ returns（加 --json 时返回什么）。
// 引擎按同一份定义查参数：argv 里没出现的参数一律拒收。清单和命令行解析共用这一份，两边对不上就是这里错了。
// 只收循环用到的命令（000「概念少」）；其余命令照旧用 acceptkit <命令> 看用法。

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const list = (description) => ({ type: 'array', items: { type: 'string' }, description });
const flag = (description) => ({ type: 'boolean', description });
const int = (description) => ({ type: 'integer', minimum: 0, description });
const obj = (required, properties) => ({ type: 'object', additionalProperties: false, required, properties });

const RUN = str('运行 id（acceptkit run 建的那个目录名）');
const DEMAND = str('需求 id，如 D1');

export const COMMANDS = [
  { name: 'next',
    description: '这个需求还剩什么：工具从磁盘上的记录推出卡片，按顺序列出。每一轮先调它，取第一张你能做的卡片照 note 做，做完再调。'
      + '只剩 attention 卡片时把 question 原样交给用户，停下等回答；用户回了，先照那张卡片的 on_reply 记下原话（一句话回了几张就记几张），再调 next；清单为空时报告都出完了（要出报告的会是 report_due 卡片），用 link 把报告地址给用户。别自己记「做到哪了」。',
    input_schema: obj(['demand'], { demand: DEMAND }),
    argv: 'acceptkit next {demand} --json',
    returns: '{demand, cards:[卡片]}；卡片的 kind 见 cards' },

  { name: 'device_acquire',
    description: '给运行选一台设备并占上：平台、宿主、能力要求从用例推出，按「复用 → 启动」选。一个需求同一平台只用一台：同需求别的运行占着的那台直接接过来；要第二台得 --parallel 给理由、工具核对。拿到 device 卡片后核对代码看不出的东西（登录的账号、页面能不能测），不对就 device_reject。'
      + 'web 运行不占设备，别调。',
    input_schema: obj(['run'], {
      run: RUN,
      need: list('额外的能力要求，每项 k=v（如 locale=zh-CN）；和用例上声明的合并，同名以这里为准'),
      holder: str('占用记在谁名下；不给就用运行的执行归属'),
      parallel: str('同一需求已经占着一台、这一轮还要第二台时的理由类型（工具核对）。不给就接过需求原来那台', { enum: ['capability', 'case', 'owner'] }),
      why: str('配 --parallel：为什么非要第二台'),
      'approved-by': str('配 --parallel owner：谁要求的双跑'),
      quote: str('配 --parallel owner：他的原话'),
    }),
    argv: 'acceptkit device acquire --run {run} [--need {need}...] [--holder {holder}] [--parallel {parallel} --why {why} [--approved-by {approved-by} --quote {quote}]] --json',
    returns: 'device 卡片（已占上）；现有设备都不能用时是 attention 卡片；启动没成时是 device_needed 卡片' },

  { name: 'device_reject',
    description: '核对后否决这台设备（账号不对、页面不能测……）：记进运行、释放占用，再自动选下一台。已经在这台上留了证据的运行不能换机，要重开一个运行。',
    input_schema: obj(['device', 'run', 'why'], {
      device: str('设备身份（iOS UDID / Android avd:<AVD名>），取 device 卡片上的 device'),
      run: RUN,
      why: str('哪里不对，一句话；工具看不出来，下一台选得对不对就靠这句'),
    }),
    argv: 'acceptkit device reject {device} --run {run} --why {why} --json',
    returns: '和 device_acquire 一样：再选一台的结果' },

  { name: 'device_sweep',
    description: '回收空闲设备：占着却超过空闲阈值（缺省 60 分钟，用户配置 devices.idle_minutes）没续期的，放掉占用并关机；没人占、acceptkit 用过且超过阈值没碰的，关机。'
      + '白名单条目写了 keep_on 的、不在白名单的、acceptkit 从没用过的不动。关机不丢数据，下一轮 acquire 重新起同一台。看板服务每 10 分钟自动跑一次。',
    input_schema: obj([], { 'dry-run': flag('只说会怎么做，不放不关') }),
    argv: 'acceptkit device sweep [--dry-run] --json',
    returns: '{ idle_minutes, dry_run, devices: [{ device, action: keep|reclaim|stop, why, run?, shutdown? }] }' },

  { name: 'device_verify',
    description: '重新核对运行占着的设备：身份对得上、占用在本运行、记下这一次开机的编号。设备停过 / 重启过之后，acceptkit 动这台设备的命令（observe / shot / adb）一律拒收，直到核对过；'
      + '核对时发现上次核对之后重启过，那之后记的结论退回待测（读数可能不在这台、或期间被人动过）。',
    input_schema: obj(['run'], { run: str('运行') }),
    argv: 'acceptkit device verify --run {run} --json',
    returns: '{ kind: "device_verified", run, device, address, rebooted, voided: [断言] }' },

  { name: 'adb',
    description: '对运行占着的 Android 设备执行 adb：每次按设备身份现查地址（不要在脚本里写死 emulator-NNNN）、核对开机号、占用在本运行且在本会话名下；装 / 卸 / 清数据还要新鲜的 gate。每次调用记进 ~/.config/acceptkit/device-ops.jsonl。',
    input_schema: obj(['run', 'args'], { run: str('运行'), args: { type: 'array', items: { type: 'string' }, description: '-- 之后的 adb 参数（不要带 -s）' } }),
    argv: 'acceptkit adb --run {run} -- {args}',
    returns: 'adb 的输出原样透传，退出码同 adb' },

  { name: 'device_rename',
    description: '给设备起个看得懂的名字（模拟器窗口标题就是设备名）。iOS 开着也能改，切到 Simulator 时标题刷新；被需求占着时 acceptkit 自动在名字后面加「 ▸ <需求号> <标题>」、放掉时去掉。'
      + 'Android 的标题是 AVD 名，只能关机且没人占时改，改完把所有登记项目白名单里的 avd:<旧名> 一起换掉；AVD 名只能用英文字母、数字和 . _ -。',
    input_schema: obj(['device', 'to'], { device: str('UDID 或 avd:<AVD 名>'), to: str('新名字') }),
    argv: 'acceptkit device rename {device} --to {to} --json',
    returns: '{ device, name? | from, dir, whitelists }' },

  { name: 'smoke',
    description: '冒烟闸：按项目声明（acceptkit.project.json 的 smoke.<平台>.items，每项 { id, assert, observe }）生成冒烟用例，为需求开一次冒烟运行（不过评审闸，要过轮次闸）。'
      + '评审单批过后，这一轮的冒烟没过，next 不出 run_needed，只出冒烟卡片。冒烟项的读数用 observe 取、原文落盘、照样盲审。',
    input_schema: obj(['demand'], { demand: str('需求'), platform: str('ios | android；评审单只有一个端时可省') }),
    argv: 'acceptkit smoke {demand} [--platform {platform}] --json',
    returns: '{ kind: "smoke", demand, platform, run, items, note }' },

  { name: 'smoke_env',
    description: '冒烟前查环境，结果记进运行（smoke_env），原始读数落 evidence/smoke-env.json：宿主机 swap / 负载；Android 再查设备上的包是不是被测包（--apk 本地包的 sha256 对设备 base.apk）、'
      + '项目声明的覆盖配置文件（smoke.<平台>.env.override_files）有没有残留、包的 lastUpdateTime 是否晚于 acceptkit 登记过的最后一次装包（过了目标闸的装包），并写明这台设备上一次被哪个运行占着。读不到也算没过。',
    input_schema: obj(['run'], { run: str('冒烟运行'), apk: str('本地被测包路径（Android）') }),
    argv: 'acceptkit smoke env {run} [--apk {apk}] --json',
    returns: '{ kind: "smoke_env", run, ok, checks: [{ id, title, ok, reading, why? }], evidence }' },

  { name: 'browser_sweep',
    description: '回收空闲浏览器：acceptkit 起的调试 Chrome（台账在 ~/.config/acceptkit/browsers）超过空闲阈值（缺省 60 分钟，用户配置 browsers.idle_minutes）没用就关；'
      + '用户目录在登记过的项目下、但没登记的先收进台账。用户自己的 Chrome、别的工具起的不动。只关窗口，用户目录（登录态）留着。看板服务每 10 分钟自动跑一次。browser list 只看不动。',
    input_schema: obj([], { 'dry-run': flag('只说会怎么做，不关') }),
    argv: 'acceptkit browser sweep [--dry-run] --json',
    returns: '{ idle_minutes, dry_run, browsers: [{ port, profile, action: keep|close|gone|adopt|foreign, why, result? }] }' },

  { name: 'shot',
    description: '过程截图：证明 app 在跑、停在哪页。截之前查遮蔽层（被挡住拒截并给出关法），截完查纯色画面、和上一张是否一样、节点 shows 的字。'
      + '做完一个操作节点就截并挂上 --step。过程截图不挂断言：断言的图由 observe 产出。',
    input_schema: obj(['run'], {
      run: RUN,
      sim: str('设备地址；运行已经占上设备时不用给'),
      web: flag('web 运行：连项目的调试浏览器截'),
      step: str('挂到哪个操作节点，如 n1.2；给了就顺手 record --step'),
      label: str('图名里的标签，如 home'),
      note: str('这一步的说明，进附带记录'),
      bundle: str('被测包名；不给就用宿主登记的'),
      host: str('宿主名（项目里有多个 App 时）'),
      port: str('调试端口；不给就用宿主登记的'),
      tab: str('web：截哪个标签页（网址里含这段字）'),
      'allow-obscured': str('被验的就是这个遮蔽层时才用：写理由，理由会进盲审。不放行纯色画面（那个只认节点 shows 在画面上读到）'),
    }),
    argv: 'acceptkit shot {run} [--sim {sim}] [--web] [--step {step}] [--label {label}] [--note {note}] [--bundle {bundle}] [--host {host}] [--port {port}] [--tab {tab}] [--allow-obscured {allow-obscured}] --json',
    returns: 'shot 卡片（图、事中检测 checks）；带 --step 时是 step 卡片，图在它的 shot 字段' },

  { name: 'observe',
    description: '按断言自带的观测规格观测：工具执行、原文落盘、按谓词判、写回结论。断言有 observe 规格时一律用它，别手记。'
      + '观测没拿到判据时不改记录，这一项带 refused：修通道再观测。',
    input_schema: obj(['run'], {
      run: RUN,
      expect: list('只观测这些断言（如 E3）；不给就观测全部带规格的'),
      todo: flag('只观测现在是 todo 的（含被盲审驳回退回的）'),
      'from-file': str('离线复判：读已采集的原始输出文件，不碰设备'),
      set: list('覆盖规格里的参数，每项 k=v'),
      'dry-run': flag('只列计划，不执行'),
      try: flag('试跑：真执行（推测的配方也行），打印判定，不写回结论；核对后 ops verify 再正式观测'),
      'record-channel-failure': flag('通道失败也照记（记成 blocked）；只在确认是被测物让通道走不通时用'),
    }),
    argv: 'acceptkit observe {run} [--expect {expect}...] [--todo] [--from-file {from-file}] [--set {set}...] [--dry-run] [--try] [--record-channel-failure] --json',
    returns: '{results:[expect 卡片 | {expect, refused} | {expect, tried}]}' },

  { name: 'refile',
    description: '运行挂错了需求时改挂回去（例：用 --skip-plan-gate 开在了别的需求名下）。用例在原需求评审单里的不能挪；目标需求要认这条用例（出处是它或它的评审单里有）；'
      + '必须写理由，改挂记录留在运行里，原需求台账上没解决的阻塞转到目标需求。',
    input_schema: obj(['run', 'demand', 'why'], { run: RUN, demand: str('目标需求 id'), why: str('为什么挂错了，一句话') }),
    argv: 'acceptkit refile {run} --demand {demand} --why {why} --json',
    returns: '{ run, from, to, why, blockers: ["B旧→B新"] }' },

  { name: 'record',
    description: '手记一条断言的结论。只用于没有观测规格、observe 做不了的断言。pass/fail 要带证据；--quote 的原文必须能在证据里逐字找到，找不到就拒收。'
      + '端上运行记 pass 之前，运行里至少要有一张 shot 截的 app 画面。',
    input_schema: obj(['run', 'expect', 'status'], {
      run: RUN,
      expect: str('断言 id，如 E3'),
      status: str('结论；na 只用于版本不适用（要 --since），平台不适用由 observe 自动记', { enum: ['pass', 'fail', 'blocked', 'skip', 'na', 'todo'] }),
      actual: str('实际看到了什么（人话）'),
      'actual-file': str('从文件读 actual：内容里有反引号、引号时用它，免得 shell 吃掉'),
      evidence: list('证据，运行目录里的相对路径（如 evidence/out.txt）；过程截图不能挂断言'),
      quote: list('证据原文里的片段，逐字；工具会去证据里找'),
      'reset-quotes': flag('清空旧的 quote（证据换过时）'),
      supersede: list('撤下这些挂错或被取代的证据（文件留盘）'),
      finding: str('关联的 finding，如 F2'),
      build: str('被测包版本，组件@版本'),
      since: str('status=na 时：从哪个版本起不适用，组件@版本'),
      'blocked-kind': str('status=blocked 时必填：capability = 我的能力缺口，dependency = 外部依赖挡住', { enum: ['capability', 'dependency'] }),
      unlock: str('status=blocked：解锁条件。capability 写「我要做什么」，不写「请谁同意」'),
      'failure-of': str('说法里命中装置故障词时必填：subject = 被测物真的这样，apparatus = 取证手段自己坏了', { enum: ['subject', 'apparatus'] }),
      'allow-no-shot': str('status=fail 且确实拍不了 app 画面（如 app 起不来）：写为什么。pass 没有这个口子'),
      'allow-literal': str('读数确实是字面量时放行，写理由'),
    }),
    argv: 'acceptkit record {run} --expect {expect} --status {status} [--actual {actual}] [--actual-file {actual-file}] [--evidence {evidence}...] [--quote {quote}...] [--reset-quotes] [--supersede {supersede}...] [--finding {finding}] [--build {build}] [--since {since}] [--blocked-kind {blocked-kind}] [--unlock {unlock}] [--failure-of {failure-of}] [--allow-no-shot {allow-no-shot}] [--allow-literal {allow-literal}] --json',
    returns: 'expect 卡片（这条断言现在的完整状态）' },

  { name: 'record_step',
    select: 'step',
    description: '把过程证据挂到操作节点上（不是断言）。shot --step 会自动做这一步；证据是机器产物（evidence/*.json）时手动挂。',
    input_schema: obj(['run', 'step', 'evidence'], {
      run: RUN,
      step: str('操作节点编号，如 n1.2（acceptkit steps <用例> 看编号）'),
      evidence: list('证据，运行目录里的相对路径'),
      note: str('这一步做了什么、停在哪'),
      capture: list('这一步真实产生的值，名=值（例：room_id=7301…）；判据里写 {step.<这一步>.<名>} 引用，不写死'),
      supersede: list('撤下这些挂错的证据'),
      'failure-of': str('note 里命中装置故障词时必填', { enum: ['subject', 'apparatus'] }),
      'allow-literal': str('读数确实是字面量时放行，写理由'),
    }),
    argv: 'acceptkit record {run} --step {step} --evidence {evidence}... [--note {note}] [--capture {capture}...] [--supersede {supersede}...] [--failure-of {failure-of}] [--allow-literal {allow-literal}] --json',
    returns: 'step 卡片' },

  { name: 'assess_pack',
    select: 'pack',
    description: '用例评审：打评审包。每条用例的事实（带 id）、各维度标准（0–3 分各什么样、要复述什么）、每项的分数上限和必答信号；交给新上下文的子 agent 盲审，结果写成 jsonl 再 --apply。',
    input_schema: obj([], {
      pack: { type: 'boolean', description: '打评审包' },
      plan: str('需求：打包评审单里的全部用例'),
      case: str('或者指定用例，逗号分隔'),
      changed: { type: 'boolean', description: '只打包没盲审过或内容变了的项' },
      limit: { type: 'integer', description: '最多几条用例' },
    }),
    argv: 'acceptkit assess --pack [--plan {plan}] [--case {case}] [--changed] [--limit {limit}] --json',
    returns: '评审包 { card, rubric, how, cases: [{ case, facts, signals, items: [{ key, dim, at, cap, cap_facts, signals, fp }] }] }' },

  { name: 'assess_apply',
    select: 'apply',
    description: '用例评审：提交盲审结果（jsonl，一行一项）。逐行核对：分数不越上限、复述的值是原文里的字、信号都回答、引用的事实在本项范围内、不到 3 分有能执行的 fix；考题打高了整批拒收。门槛只认 --by blind。',
    input_schema: obj(['apply'], {
      apply: str('jsonl 文件路径（- 读标准输入）'),
      by: str('谁评的：blind = 新上下文的子 agent 只看评审包；self = 自评，只算草稿', { enum: ['blind', 'self'] }),
    }),
    argv: 'acceptkit assess --apply {apply} [--by {by}] --json',
    returns: '{ accepted, refused, results: [{ line, key, ok | refused }] }' },

  { name: 'assess_canary',
    select: 'canary-add',
    description: '登记一道考题：owner 判过不合格的步骤原文。打评审包时排在内置考题前面，盲审打得高过 max 整批拒收。',
    input_schema: obj(['canary-add'], {
      'canary-add': str('步骤原文（照抄 owner 判过不合格的那一句）'),
      max: { type: 'integer', description: '这道题「能照着做」最多能给几分（0–2）' },
      source: str('出处（例：哪个需求、哪次评审）'),
      quote: str('owner 的原话'),
    }),
    argv: 'acceptkit assess --canary-add {canary-add} [--max {max}] [--source {source}] [--quote {quote}] --json',
    returns: '{ id, text, max }' },

  { name: 'assess_walk',
    select: 'walk',
    description: '逐节点走查：每条用例按树的顺序列出每一步（人话、操作展开、配置、触发来源）和每条预期（结论、因果、怎么看、判据），每个节点旁是评审分数，低于门槛的带理由；末尾核对看到的节点数。人或主 agent 按节点审一遍用。',
    input_schema: obj([], {
      walk: { type: 'boolean', description: '逐节点走查' },
      plan: str('需求'),
      case: str('或者指定用例，逗号分隔'),
    }),
    argv: 'acceptkit assess --walk [--plan {plan}] [--case {case}] --json',
    returns: '{ cases: [{ case, status, nodes, text }] }' },

  { name: 'assess_walk_done',
    select: 'walk-done',
    description: '逐节点走查签收：列出这条用例全部节点 nid 和预期 id（--seen，一个不缺），写走查结论。用例之后再改签收作废。接入评审门槛的项目，没签收不能批准、不能开跑。',
    input_schema: obj(['walk-done', 'by', 'seen', 'notes'], {
      'walk-done': str('用例'), by: str('走查的人'), seen: str('全部节点 nid 和预期 id，逗号分隔'), notes: str('看出了什么、改了什么'),
    }),
    argv: 'acceptkit assess --walk-done {walk-done} --by {by} --seen {seen} --notes {notes} --json',
    returns: '{ case, fp, by, at, nodes, notes }' },

  { name: 'assess_status',
    select: 'status',
    description: '用例评审状态：每条用例评审通过 / 未过 / 过期 / 只有自评 / 不完整，以及低于门槛的项（理由、fix）。',
    input_schema: obj([], {
      status: { type: 'boolean', description: '看评审状态' },
      plan: str('需求'),
      case: str('或者指定用例，逗号分隔'),
    }),
    argv: 'acceptkit assess --status [--plan {plan}] [--case {case}] --json',
    returns: '{ cases: [{ case, status, counts, low: [{ key, dim, at, state, score, reason, fix }] }] }' },

  { name: 'reviewq',
    description: '盲审队列。--pack 出证据包，交给新上下文的子 agent 只看包下结论；它的结论原样写成 jsonl 再 --apply。执行者不复核自己。'
      + '不带 --pack / --apply / --reopen / --prune 时列出队列。',
    input_schema: obj([], {
      demand: DEMAND,
      run: RUN,
      pack: flag('出证据包'),
      limit: int('这次最多出几份包'),
      apply: str('回写盲审结论：jsonl 文件，每行 {"run","key","verdict","note"}；包里列了主张清单的，判 ok 那行还要带 "claims":[{"id":"C1","where":"证据第几行"},…]，每条都要有，有一条找不到就判 insufficient；- 表示从标准输入读'),
      by: str('回写时记谁判的，默认 blind'),
      reopen: str('重开一条复核（证据没变、被判的上下文变了）：复核键 <断言或 step:节点>::<证据>，要配 --run 和 --why'),
      why: str('--reopen 的理由'),
      prune: flag('清掉已不在队列里的旧包'),
      'dry-run': flag('配 --prune：只列出要清的'),
    }),
    argv: 'acceptkit reviewq [--demand {demand}] [--run {run}] [--pack] [--limit {limit}] [--apply {apply}] [--by {by}] [--reopen {reopen}] [--why {why}] [--prune] [--dry-run] --json',
    returns: '--pack：review_pack 卡片；--apply：{results:[expect/step 卡片 | {line, refused}]}；--reopen：expect/step 卡片；--prune：{pruned, kept}；列队列：{results:[review_due / rejected 卡片]}' },

  { name: 'report',
    description: '出报告（run.md + run.json）并给出报告地址。还有 todo、或有没提给用户的阻塞时拒出：先照 next 的卡片做完。',
    input_schema: obj(['run'], { run: RUN, force: flag('旧引擎产生的运行按现在的规则重出') }),
    argv: 'acceptkit report {run} [--force] --json',
    returns: 'report 卡片（结论、计数、报告文件、地址）' },

  { name: 'plan_finding',
    description: '记一条要 Owner 拍板的 finding（产品该怎么表现），或用 --finding 改写已有的一条。性质、影响、为什么、至少两个选项和后果、推荐缺一样就拒收；人话区不许夹代码标识，原文放 --detail。'
      + '执行者自己能定的事别记成 finding。',
    input_schema: obj(['demand'], {
      demand: DEMAND,
      finding: str('改写已有的那条，如 F3；不给就新开一条'),
      what: str('一句话（≤80 字，人话）'),
      kind: str('性质', { enum: ['product_bug', 'design_gap', 'spec_unclear', 'test_defect', 'env'] }),
      impact: str('影响范围：谁会碰到、线上用户受不受影响、多大面'),
      why: str('读懂这条要知道的那一件事，用人话讲'),
      option: list('选项，每项「做法 => 选它的后果」，至少两项（「不处理」也是一项）'),
      recommend: str('执行者推荐选哪个、为什么'),
      decide: str('要 Owner 定什么，一句问句；新开时必填'),
      detail: str('技术细节：代码标识、断言原文、文件路径放这里'),
    }),
    argv: 'acceptkit plan finding {demand} [--finding {finding}] [--what {what}] [--kind {kind}] [--impact {impact}] [--why {why}] [--option {option}...] [--recommend {recommend}] [--decide {decide}] [--detail {detail}] --json',
    returns: 'finding 卡片' },

  { name: 'plan_approve',
    description: '记下用户本人对评审单的批准。attention 卡片（subject=plan_approval）的 on_reply 就是它：用户回了同意的话，先调它记原话，再开跑。'
      + '只记用户本人的批准：--by 写执行者自己会被拒；评审单有硬错时拒收。',
    input_schema: obj(['demand', 'by', 'quote'], {
      demand: DEMAND,
      by: str('谁批的（用户本人）'),
      quote: str('他的原话，照抄，别复述'),
    }),
    argv: 'acceptkit plan approve {demand} --by {by} --quote {quote} --json',
    returns: 'plan 卡片' },

  { name: 'plan_recheck',
    description: '批准后改过的用例按自动批准标准记下，不找 owner（他批的是验什么，批过就作数）。只加不删、只换取证办法的直接通过；'
      + '判法改了（删改判据 / 前提、改成人判）的通过，最新一轮里这几条的旧结论作废、按新判法重测；验的范围变了（删断言、改断言原文、改适用范围、去平台）的写理由后通过，需求页列给 owner 看。',
    input_schema: obj(['demand', 'why'], { demand: DEMAND, why: str('为什么改'), case: str('只处理这几条用例（逗号分隔）') }),
    argv: 'acceptkit plan recheck {demand} --why {why} [--case {case}] --json',
    returns: '文本' },

  { name: 'plan_return',
    description: 'owner 看了评审单不同意、要改：记下他的意见，退回给执行者。不是批准；已批过的用例照常测。attention 卡片（plan_approval）的 on_reject 就是它。--by 写执行者自己会被拒。',
    input_schema: obj(['demand', 'by', 'quote'], { demand: DEMAND, by: str('谁退回的（用户本人）'), quote: str('他的意见，原话照抄') }),
    argv: 'acceptkit plan return {demand} --by {by} --quote {quote} --json',
    returns: 'plan 卡片' },

  { name: 'plan_bounce',
    description: 'Owner 看了 finding 说看不懂：退回执行者重写（不是拍板）。之后照他说的哪里看不懂，用 plan_finding --finding 改写原条。--by 写执行者自己会被拒。',
    input_schema: obj(['demand', 'finding', 'by', 'quote'], {
      demand: DEMAND,
      finding: str('哪一条，如 F3'),
      by: str('谁退回的（用户本人）'),
      quote: str('他哪里看不懂，原话'),
    }),
    argv: 'acceptkit plan bounce {demand} --finding {finding} --by {by} --quote {quote} --json',
    returns: 'finding 卡片' },

  { name: 'plan_decide',
    description: '记下 Owner 对 finding 的拍板。用户回复里回答了某张 finding 卡片，先调它记原话，再做别的 —— 照着做了却没记，下次又会问一遍。'
      + '一句话回了几条就 --finding F1,F2；他选的是某个选项（或说「按你建议」）就带 --option，选项连同后果原样存下。'
      + '只记用户本人的回答：--by 写执行者自己会被拒；Owner 也可以在看板上直接定，那样不用你转述。',
    input_schema: obj(['demand', 'finding', 'by', 'quote'], {
      demand: DEMAND,
      finding: str('哪几条，如 F3 或 F3,F4'),
      by: str('谁定的（用户本人）'),
      quote: str('他的原话，照抄，别复述'),
      option: str('他选的是第几个选项（1 起），或 recommend（按你的推荐）；只配一条 finding'),
      note: str('补充说明（不是原话）'),
    }),
    argv: 'acceptkit plan decide {demand} --finding {finding} --by {by} --quote {quote} [--option {option}] [--note {note}] --json',
    returns: 'finding 卡片（每条一张）' },

  { name: 'plan_settle',
    description: '执行者把「其实不用 Owner 定」的 finding 收口：被后来的条目取代（superseded，--ref 接手那条）、被查实的事实回答（answered，--evidence 运行或 --ref 一条 Owner 定过的）、执行者自己的活（executor）。'
      + 'Owner 的回答不是事实，用 plan_decide 记原话，别用 answered。',
    input_schema: obj(['demand', 'finding'], {
      demand: DEMAND,
      finding: str('哪一条，如 F3'),
      kind: str('收口的理由', { enum: ['superseded', 'answered', 'executor'] }),
      ref: str('接手的那条 / 已定的那条 Fxx'),
      evidence: str('answered：事实在哪个运行里'),
      note: str('为什么不用 Owner 定，Owner 要能复核'),
      undo: flag('放回「等 Owner 定」'),
    }),
    argv: 'acceptkit plan settle {demand} --finding {finding} [--kind {kind}] [--ref {ref}] [--evidence {evidence}] [--note {note}] [--undo] --json',
    returns: 'finding 卡片' },

  { name: 'blockers',
    description: '阻塞台账。record / observe 记 blocked 时自动登记；--raise 生成要交给用户的话并标记已提（原样交给用户）；用户回了 --ack；自己补上了能力 --resolve。断言后来记成 pass / fail / na 时，工具自动关掉它的阻塞，不用手动关。'
      + '有没提的阻塞时 report 出不来。不带动作参数时列出台账。',
    input_schema: obj(['demand'], {
      demand: DEMAND,
      raise: flag('把待提的阻塞生成话术并标记已提'),
      ack: str('记用户答复的那条，如 B2；同一个问题卡住的一组用逗号一次答：B2,B3,B4'),
      answer: str('配 --ack：用户怎么说的，原话'),
      by: str('配 --ack：谁答的（用户本人；写成执行者自己会被拒）'),
      source: str('配 --ack：原话出处（例：答复当时记在了别处，这里补记，写清在哪、何时）'),
      ask: str('配 --set：要 owner 定什么，写成一句问句（解锁条件是给执行者的，不是问题）'),
      'why-you': str('配 --set：执行者自己为什么解决不了'),
      option: list('配 --set：「做法 => 选它的后果」，至少两个'),
      recommend: str('配 --set：执行者推荐选哪个、为什么'),
      set: str('补写哪一条，如 B2；同一个问题卡住几条就 B2,B3 一次写'),
      unlock: str('配 --set：解锁条件'),
      'review-note': str('配 --set：评审时为什么没发现（capability 阻塞提之前必填）'),
      kind: str('配 --set：改归类', { enum: ['capability', 'dependency'] }),
      text: str('配 --set：改说明'),
      resolve: str('自己补上能力、解掉的那条，如 B2'),
      'by-me': str('配 --resolve：做了什么、证据在哪'),
      backfill: str('把这个运行里没进台账的 blocked 补登记'),
    }),
    argv: 'acceptkit blockers {demand} [--raise] [--ack {ack} --answer {answer} [--by {by}] [--source {source}]] [--set {set} [--unlock {unlock}] [--review-note {review-note}] [--kind {kind}] [--text {text}] [--ask {ask}] [--why-you {why-you}] [--option {option}...] [--recommend {recommend}]] [--resolve {resolve} --by-me {by-me}] [--backfill {backfill}] --json',
    returns: '--ack / --set / --resolve：blocker 卡片；--raise / --backfill / 列台账：{results:[blocker 卡片], message}，message 是要原样交给用户的话' },

  { name: 'consult',
    description: '一条断言拿不出证据（evidence_gap 缺读值截图 / 不知道去哪看，或 blocked 造不出输入）时，按通识标准问清业务知识：'
      + '判据面类别（界面 / 上报 / 网络 / 内部判定 / 配置存储 / 性能 / 对照）→ 常见取证入口和每个入口要问清的业务问题、对任何断言都成立的通识问题、'
      + '项目里已有的相关知识，以及一条能直接交给 owner 拍板的问题草稿（blockers --set --ask 的现成命令）。先自己照着查，查不到才问人。只读，不改记录。',
    input_schema: obj(['run', 'expect'], {
      run: RUN,
      expect: str('断言编号，如 E3；取 evidence_gap / blocker_own 卡片上的 expect'),
    }),
    argv: 'acceptkit consult {run} --expect {expect} --json',
    returns: 'consult 卡片（faces / surfaces[{where, ask}] / questions / knowledge / owner_ask{question, why, options} / next）' },

  { name: 'consult_trigger',
    description: '用例评审时（不用等开跑）查一条用例里不是真实触发的步骤（直接注入 / 说不清）：工具在被测仓里找手写字段在哪算出来、调试 / 工具代码和项目脚本里哪里碰到它们，'
      + '执行者顺着往上追到真实情况下产生这个输入的入口，写成测法建议（--propose）交 owner 定改不改。被测仓用 round repos 登记的，或这次 --repo 临时给。',
    input_schema: obj(['case'], {
      case: str('用例名'),
      node: str('只看这一步，如 n1.2；不给就列出所有不是真实触发的步骤'),
      demand: str('哪个需求（读它登记的被测仓；不给按评审单里引用了这条用例的需求找）'),
      repo: str('临时给被测仓：<名>=<路径>，可给多个'),
      propose: { type: 'boolean', description: '记一份测法建议（配 --node --real --evidence --how --catches [--prep]）' },
      steps: { type: 'boolean', description: '步骤咨询：从提测内容 + 项目操作集推出每处不清晰的步骤 / 预期该挂哪个操作、怎么看' },
      apply: { type: 'boolean', description: '配 --steps：把明确的候选写回用例（记下来源）' },
      real: str('配 --propose：真实情况下，是什么产生了这一步的输入'),
      evidence: str('配 --propose：代码依据「文件:行 这里是什么」，可给多个'),
      how: str('配 --propose：换成真实触发后这一步具体怎么做'),
      catches: str('配 --propose：换过去以后多验到的是哪一段'),
      prep: str('配 --propose：开测前要先补的东西和工作量（现在就能测的不写）'),
    }),
    argv: 'acceptkit consult {case} [--steps [--apply]] [--node {node}] [--demand {demand}] [--repo {repo}...] [--propose --real {real} --evidence {evidence}... --how {how} --catches {catches} [--prep {prep}]] --json',
    returns: '不带 --propose：consult_trigger 卡片（steps[{node, from, fields, anchors, leads{assembly, tools, tests}, scripts, real_ops, proposals}] / research / next）；带 --propose：记下的测法建议' },

  { name: 'configset',
    description: '配置集：一组用例跑之前被测端要处在什么配置下（开关、AB / 下发值、mock 的全局信号、账号、地区、包）。有名字、能复用，用例或某一支节点写 config: [<id>] 引用。'
      + '每项说清是 mock（只 mock 全局信号，要写 why）还是 env（真实环境的选择）。set 新增 / 改（按项名合并），show 看，diff 看两份差在哪',
    input_schema: obj(['id'], {
      id: str('配置集名（小写字母、数字、连字符）'),
      title: str('配置集是什么场景，一句话'),
      item: str('一项：名=值，可给多个'),
      kind: str('这几项是哪种', { enum: ['mock', 'env'] }),
      why: str('mock 的要写：为什么不用真值'),
      apply: { type: 'string', description: '这些项用哪个已登记操作施加（例：配置页 AB mock、全局特征 mock 页）；步骤里就不用再写 mock' },
      replace: { type: 'boolean', description: '整份替换（不给就按项名合并）' },
    }),
    argv: 'acceptkit configset set {id} [--title {title}] --item {item}... --kind {kind} [--why {why}] [--apply {apply}] [--replace] --json',
    returns: '配置集 { id, title, items[{ key, value, kind, why }] }' },

  { name: 'configset_show', description: '看配置集：每项的名、值、是 mock 还是环境、为什么',
    input_schema: obj([], { id: str('只看这一份') }),
    argv: 'acceptkit configset show [{id}] --json', returns: '{ <id>: { title, items } }' },

  { name: 'configset_diff', description: '两份配置集差在哪：只列取值不同的项（两组用例结果不一样，先看这个）',
    input_schema: obj(['a', 'b'], { a: str('配置集'), b: str('另一份配置集') }),
    argv: 'acceptkit configset diff {a} {b} --json', returns: '{ a, b, diff[{ key, a, b }] }' },

  { name: 'clarify',
    description: '跑过的用例改清晰（AI 写的用例跑过一次后，必须清晰或判不可执行，否则不能再开跑）。不带写回参数：列出哪里不清晰，以及那次执行的事实（这一步跑过的命令、截的图、观测打开的页和读到的值）当候选；'
      + '带 --node / --expect / --unexecutable：写回用例，工具核对够不够具体、有没有空值，不够就拒收；每次写回记下来源运行和改前的样子',
    input_schema: obj(['case'], {
      case: str('用例名'),
      run: str('事实取自哪次运行（不给取最近一次）'),
      node: str('改哪一步，如 n1.2'),
      op: str('配 --node：这一步写成「动作 + 对象」：进入「…」页、点击「…」、在「…」输入 …，命令写在反引号里'),
      param: str('配 --node：要填的值 名=值，可给多个'),
      'op-id': str('配 --node：挂一个带人看步骤的操作'),
      'to-op': str('配 --node：把这一步文字里的命令提成一个操作（这个名字），命令作机器步骤，配 --human'),
      human: str('配 --to-op：这个操作的人话步骤（打开「…」页 / 点击「…」），可给多个'),
      expect: str('写哪条预期的看法，如 E1'),
      see: str('配 --expect：人怎么看，一步一个，可给多个；至少一步说得出具体对象（「」里的页 / 行 / 按钮）'),
      say: str('配 --expect：判据的人话，按判据顺序一句对一条（例：「did assembly succeed」这一行是 yes）'),
      unexecutable: { type: 'boolean', description: '整条判不可执行（配 --why）' },
      kind: str('配 --node：节点种类（分组只是标题，不能带操作 / 参数 / 触发声明）', { enum: ['action', 'group'] }),
      config: str('配 --node：给这一步挂配置集（可给多个）'),
      'no-config': str('配 --node：摘掉这一步的配置集'),
      'add-expect': str('配 --node：在这一步下加一条断言（这个编号），配 --assert --observe-op --checks [--param --see --detail --twin-of]'),
      assert: str('配 --add-expect：一句话'),
      detail: str('配 --add-expect：依据 / 细节'),
      'observe-op': str('配 --add-expect 或 --expect：观测操作（--expect 时原地换观测，改前的样子留底）'),
      checks: str('判据 JSON 数组：[{"pick":"read.x","predicate":{"eq":"y"},"say":"人话"}]'),
      'twin-of': str('配 --add-expect：新断言作为哪条（注入的）断言的真实对照'),
      input: str('配 --expect：改这条预期声明的触发来源（不是 real 要配 --why）', { enum: ['real', 'mock-global', 'injected'] }),
      'move-under': str('配 --node：把这一支挪到另一步下面（成为它的最后一个子节点），例：分组标题挪到产生结果的那一步下面'),
      'because-from': str('配 --expect：这条预期的结果从哪来（step 链上某一步 / state 启动或配置后的状态 / artifact 静态产物），配 --why', { enum: ['step', 'state', 'artifact'] }),
      'because-step': str('配 --because-from step：链上哪一步（nX 或 nid）'),
      'because-input': str('配 --because-from step：那一步输入了什么（原文里的字）'),
      role: str('配 --expect：claim 验需求本身 / control 对照 / precondition 前置检查', { enum: ['claim', 'control', 'precondition'] }),
      'demand-ref': str('配 --role claim：对应评审单的哪个改动面'),
      'add-node': str('加一步：挂在哪一步下面（nX / nid，或 root 加在最外层），配 --op [--op-id --param]'),
      'config-unset': list('配 --node：从这一步起撤掉沿链继承来的配置集（配 --why）'),
      'no-config-unset': list('配 --node：取消撤掉'),
      'precondition-set': str('改第几条前置（从 0 数），new = 加一条；配 --text --how op:<操作>|manual --why'),
      'precondition-rm': str('删第几条前置（从 0 数），配 --why'),
      text: str('配 --precondition-set：这条前置是什么'),
      how: str('配 --precondition-set：op:<操作 id>（能建立它的操作）或 manual（人工确认，--why 写理由）'),
      'remove-node': str('删一个空节点（它和子孙都没有预期；配 --why），例：走不到的分支'),
      'remove-expect': str('删一条断言（配 --why）；别的断言 real_twin 指向它的一并清掉，删前的样子留底'),
      via: str('读取通道（单独配 --expect，或跟 --add-expect / --observe-op 一起）', { enum: ['ui', 'log', 'diag', 'debugger', 'cli'] }),
      'why-not-ui': str('配 --via（不是 ui 时必填）：界面上为什么看不到'),
      why: str('配 --unexecutable：为什么做不了，至少 10 字'),
    }),
    argv: 'acceptkit clarify {case} [--run {run}] [--node {node} [--op {op}] [--param {param}...] [--op-id {op-id}] [--to-op {to-op} --human {human}...]] [--expect {expect} --see {see}... [--say {say}...]] [--unexecutable --why {why}] [--kind {kind}] [--config {config}...] [--no-config {no-config}...] [--add-expect {add-expect} --assert {assert} [--detail {detail}] --observe-op {observe-op} --checks {checks} [--twin-of {twin-of}]] [--via {via} [--why-not-ui {why-not-ui}]] [--remove-expect {remove-expect} --why {why}] [--remove-node {remove-node} --why {why}] [--node {node} --move-under {move-under}] [--expect {expect} --because-from {because-from} [--because-step {because-step} --because-input {because-input}] --why {why}] [--expect {expect} --role {role} [--demand-ref {demand-ref}]] [--precondition-set {precondition-set} [--text {text}] --how {how} --why {why}] [--precondition-rm {precondition-rm} --why {why}] [--add-node {add-node} --op {op} [--op-id {op-id}] [--param {param}...]] [--node {node} --config-unset {config-unset}... [--no-config-unset {no-config-unset}...] --why {why}] [--expect {expect} --input {input} [--why {why}]] --json',
    returns: '不带写回参数：{ kind: clarify, status, items[{ at, type, msg, facts, fix }], did_in_run }；写回后：{ kind: clarify, status, left[] }' },

  { name: 'ask',
    description: '要 owner 回答的事只有这一个入口（plan finding、blockers --ask 也过同一道检查）。先判该不该问：项目知识里写过不问 owner 的、同一件事答过的、属于执行者自己的活（登录测试账号、本 run 设备上的操作、调试页 mock、重试 / 换取证手段、自己工具的毛病）一律拒收并说明；'
      + '只放行改产品行为或验收范围 / 动别人的资源或排期 / 对外发布或不可逆操作 / 接受风险四类，且要带上下文、选项和后果、推荐。记下拿到编号 Qn；回复和状态汇报里只写编号和待答几条',
    input_schema: obj(['demand', 'question', 'kind', 'context', 'why-you', 'option', 'recommend'], {
      demand: DEMAND,
      question: str('要 owner 定什么，一句问句'),
      kind: str('哪一类', { enum: ['behavior', 'others', 'irreversible', 'risk'] }),
      context: str('来龙去脉：他不看别的也能懂'),
      'why-you': str('为什么只有他能定'),
      option: str('选项「做法 => 后果」，至少两个'),
      recommend: str('你推荐哪个、为什么'),
      'not-mine': str('通用清单判成你的活、但你确认真不是：写为什么只有 owner 能定（会给 owner 看）'),
    }),
    argv: 'acceptkit ask {demand} --question {question} --kind {kind} --context {context} --why-you {why-you} --option {option}... --recommend {recommend} [--not-mine {not-mine}] --json',
    returns: '记下的提问 { id: Qn, … }；不该问时 { kind: ask_refused, why, ref, text, message }' },

  { name: 'ask_answer', description: 'owner 答了一条提问：记他本人的名字和原话。只在用户回答了 ask 汇总卡之后用',
    input_schema: obj(['demand', 'id', 'by', 'quote'], { demand: DEMAND, id: str('提问编号 Qn'), by: str('owner 本人'), quote: str('他的原话'), option: str('他选了第几个') }),
    argv: 'acceptkit ask answer {demand} {id} --by {by} --quote {quote} [--option {option}] --json', returns: '更新后的提问' },

  { name: 'ask_withdraw', description: '撤回一条提问（例：查到是自己的活、或已经不用问了），写理由',
    input_schema: obj(['demand', 'id', 'why'], { demand: DEMAND, id: str('提问编号 Qn'), why: str('为什么撤回') }),
    argv: 'acceptkit ask withdraw {demand} {id} --why {why} --json', returns: '更新后的提问' },

  { name: 'ask_list', description: '这个需求提过的问：待答 / 已答 / 已撤回',
    input_schema: obj(['demand'], { demand: DEMAND }),
    argv: 'acceptkit ask list {demand} --json', returns: '{ demand, asks[] }' },

  { name: 'consult_decide',
    description: 'owner 对一份测法建议的决定：改（--adopt）或不改（--reject），记他本人的原话。只在用户回答了 trigger_proposal 卡片后用',
    input_schema: obj(['proposal', 'by', 'quote'], {
      proposal: str('测法建议编号，如 T1'),
      adopt: { type: 'boolean', description: '改成真实触发' },
      reject: { type: 'boolean', description: '不改' },
      by: str('谁定的（owner 本人）'),
      quote: str('他的原话'),
    }),
    argv: 'acceptkit consult decide {proposal} [--adopt] [--reject] --by {by} --quote {quote} --json',
    returns: '更新后的测法建议' },

  { name: 'context',
    description: '做一个操作节点之前，一次取这一步的经验：操作做法（推测的不执行）、画面上应该出现的字（shows）、危险等级（danger）、相关知识、可能遇到的遮蔽层和关法、'
      + '这个节点以往失败 / 取证手段故障 / 盲审驳回的情况、截图做法。step_todo 卡片要做的那一步不熟、或上次在这一步栽过时调它；不用为它通读项目手册。只读，不改记录。',
    input_schema: obj(['run', 'node'], {
      run: RUN,
      node: str('操作节点编号，如 n1.2；取 step_todo 卡片上的 node，或 acceptkit steps <用例> 看'),
    }),
    argv: 'acceptkit context {run} --node {node} --json',
    returns: 'context 卡片（op / shows / danger / knowledge / obscuring / history / shot）；长内容截到 300 字，全文 read 卡片上的 read 指针' },

  { name: 'read',
    description: '分页读卡片 read 指针指向的长内容。资源：plan/D、finding/D/F3、blocker/D/B2、case/C、case/C#n1.2、run/R、run/R/E1、run/R/step/n1、run/R/file/<相对路径>、context/R/n1。'
      + '文本按字符分页，列表按项分页；next_offset 不是 null 就还有下一页。图片不读：直接打开文件看。',
    input_schema: obj(['resource'], {
      resource: str('资源名，照卡片上的 read 原样填'),
      offset: int('从第几个字符 / 第几项开始，默认 0；取上一页返回的 next_offset'),
      limit: int('这一页多少：文本默认 4000、最多 8000 字；列表默认 20、最多 50 项'),
    }),
    argv: 'acceptkit read {resource} [--offset {offset}] [--limit {limit}] --json',
    returns: '{resource, type:"text"|"list", total, offset, limit, next_offset, text | items}' },
];

// ---- 从 argv 模板读出命令名、位置参数、旗标 ----
// --json 是所有清单命令共有的输出开关，不是参数，不进 input_schema。
export function argvParts(def) {
  const toks = def.argv.split(/\s+/).slice(1);
  const words = [];
  for (const t of toks) { if (!/^[a-z][a-z-]*$/.test(t)) break; words.push(t); }
  const flags = new Set([...def.argv.matchAll(/--([a-z][a-z-]*)/g)].map(m => m[1]).filter(f => f !== 'json'));
  const holes = new Set([...def.argv.matchAll(/\{([a-z][a-z-]*)\}/g)].map(m => m[1]));
  const positionals = [...holes].filter(h => !flags.has(h));
  return { words, flags, positionals };
}

/** 命令行 → 它的定义；不在清单里的命令返回 null（照旧走全局参数白名单）。 */
export function findDef(cmd, pos = [], opt = {}) {
  const hits = COMMANDS.filter(d => {
    const w = argvParts(d).words;
    return w[0] === cmd && (w.length === 1 || w[1] === pos[0]);
  });
  // 同一个命令词有几种用法（例：consult 按运行问取证、按用例问触发方式）：挑认得全这些参数的那种，都不全就取第一种（报错时给它的用法）
  const fits = d => Object.keys(opt).every(k => k === 'json' || argvParts(d).flags.has(k));
  return hits.find(d => d.select && opt[d.select] !== undefined) || hits.find(d => !d.select && fits(d)) || hits.find(d => !d.select) || null;
}

/** 按定义查不认识的参数：返回一句能照着改的话，没问题返回 null。 */
export function unknownFlags(def, opt) {
  const { flags } = argvParts(def);
  const bad = Object.keys(opt).filter(k => k !== 'json' && !flags.has(k));
  if (!bad.length) return null;
  return `不认识这些参数：${bad.map(x => '--' + x).join(' ')}\n   ${def.name} 的用法：${def.argv}\n`
    + `   （静默忽略未知参数会让「更新」变成看不出来的空操作，所以一律拒绝。）`;
}

/** 定义自洽：argv 里的参数都在 input_schema 里，反过来也是；必填的不在方括号里；开关不带值。 */
export function defProblems(def) {
  const out = [];
  const props = def.input_schema?.properties || {};
  const { flags, positionals } = argvParts(def);
  const used = new Set([...flags, ...positionals]);
  if (!/^[a-z][a-z0-9_]*$/.test(def.name)) out.push(`${def.name}：name 只能是小写字母、数字、下划线`);
  if (def.input_schema?.additionalProperties !== false) out.push(`${def.name}：input_schema 要 additionalProperties:false`);
  for (const k of used) if (!props[k]) out.push(`${def.name}：argv 里的 ${k} 不在 input_schema`);
  for (const k of Object.keys(props)) if (!used.has(k)) out.push(`${def.name}：input_schema 的 ${k} 不在 argv`);
  for (const [k, p] of Object.entries(props)) {
    if (!p.description) out.push(`${def.name}.${k}：缺字段说明`);
    const valued = def.argv.includes(`--${k} {${k}}`);
    if (flags.has(k) && p.type === 'boolean' && valued) out.push(`${def.name}.${k}：开关不该带值`);
    if (flags.has(k) && p.type !== 'boolean' && !valued) out.push(`${def.name}.${k}：带值的参数要写成 --${k} {${k}}`);
  }
  const bare = def.argv.replace(/\[[^\[\]]*(\[[^\[\]]*\][^\[\]]*)*\]/g, '');
  for (const k of def.input_schema?.required || []) if (!bare.includes(`{${k}}`)) out.push(`${def.name}：必填的 ${k} 不能在方括号里`);
  for (const k of ['description', 'argv', 'returns']) if (!def[k]) out.push(`${def.name}：缺 ${k}`);
  return out;
}

/** acceptkit protocol --json 的内容：照工具定义的形状，只放执行者要的字段（select 是引擎内部用的）。 */
export function manifest() {
  return {
    protocol: 1,
    json: '每条命令照 argv 拼出来执行；加了 --json 时 stdout 只有一份 JSON：返回 returns 里写的卡片；整条命令没执行时是 {"refused":"…"}，退出码非 0；批量命令一项一个结果，被拒的项带 refused',
    commands: COMMANDS.map(({ name, description, input_schema, argv, returns }) => ({ name, description, input_schema, argv, returns })),
  };
}
export function formatManifest() {
  const L = ['acceptkit 命令清单（循环里用到的命令；--json 看机器可读的完整定义）', ''];
  for (const d of COMMANDS) {
    L.push(`${d.name}`, `  ${d.argv}`, `  ${d.description}`, `  返回：${d.returns}`, '');
  }
  L.push(manifest().json);
  return L.join('\n');
}

// ---- read 的分页 ----
export const PAGE = { text: { limit: 4000, max: 8000 }, list: { limit: 20, max: 50 } };
function pageWindow(total, type, { offset, limit } = {}) {
  const o = Math.max(0, Number.parseInt(offset ?? 0, 10) || 0);
  const want = limit === undefined || limit === true ? PAGE[type].limit : Number.parseInt(limit, 10);
  const l = Math.min(PAGE[type].max, Math.max(1, Number.isFinite(want) ? want : PAGE[type].limit));
  return { offset: o, limit: l, next_offset: o + l < total ? o + l : null };
}
export function pageText(resource, text, opts) {
  const s = String(text ?? '');
  const w = pageWindow(s.length, 'text', opts);
  return { resource, type: 'text', total: s.length, ...w, text: s.slice(w.offset, w.offset + w.limit) };
}
export function pageList(resource, items, opts, extra = {}) {
  const w = pageWindow(items.length, 'list', opts);
  return { resource, type: 'list', total: items.length, ...extra, ...w, items: items.slice(w.offset, w.offset + w.limit) };
}
