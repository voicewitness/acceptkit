// cards — 「下一步做什么」的卡片：每张是某个已有概念（评审单 / 运行 / 断言 / 步骤 / finding / 阻塞项 / 设备）
// 当前状态的投影，不存盘、不是新概念（docs/002-protocol.md 第三节）。
//
// 每张卡片：kind + title（一句话：是什么）+ note（怎么做：一条可照抄的命令，或一句话）+ read（长内容的指针）。
// attention 卡片另带 question：执行者原样交给用户，不改写 —— 复述会在传递中走样。
// 要等回答的 attention 卡片还带 on_reply：用户回了之后要跑的那条命令（protocol 里的名字 + 填好的 argv）。
// 用户的回答只在聊天里，工具看不到；没有这条，执行者照着做了却没记，下一轮会把定过的事再问一遍。
// 这里只构造卡片，不读文件、不判断该不该出（那是 next.mjs 的事），所以每个函数都是纯的。

import { blockerAskProblems } from './finding-quality.mjs';

const ak = s => `acceptkit ${s}`;
const reply = (command, argv) => ({ command, argv: ak(argv) });
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };

/** 卡片种类与顺序：next 按这个顺序排；看板 / 手册引用同一份 */
export const CARD_KINDS = {
  attention: '有事等人：原样交给用户，与它无关的卡片照常做；用户回了先跑 on_reply 记下原话',
  plan_draft: '评审单还没写完或没过检查',
  finding_unclear: '待定 finding 写得 owner 定不了：执行者先补写',
  blocker_own: '自己的能力缺口：补上，或写清后告知用户（不用等回答）',
  blocker_unasked: '要用户答的阻塞还没写成他能拍板的问题：执行者先补写',
  round_stale: '被测代码变了：先评估影响开新轮',
  device_needed: '运行还没有设备',
  step_todo: '操作节点还没留过程截图',
  expect_todo: '断言还没有结论',
  rejected: '盲审驳回：照理由补证据，重新判',
  review_due: '有证据还没盲审',
  report_due: '断言都有结论、证据都审过：出报告',
  shot_missing: '结论来自一张 app 截图都没有的运行：开新运行重测、截图',
  evidence_gap: '记了 pass / fail 但证据不全（报告列成缺口，看板显示「证据不全」，不算通过）：缺证据不是验不了 —— 照 note 重试，补齐证据',
  run_needed: '有断言还没测上（没开跑过，或轮次重置了旧结论）：开新运行',
  stalled: '运行很久没动静：先查实际状态',
  // 不进 next 的清单：device acquire / reject 返回的那张
  device: '设备已占上：核对代码看不出的东西，不对就 reject',
  // 不进 next 的清单：命令加 --json 时返回被改动的那张（最新的完整状态，docs/002-protocol.md 第一节）
  expect: '一条断言现在的结论、证据和复核状态',
  step: '一个操作节点现在的过程证据',
  shot: '刚截的过程截图和事中检测结果',
  finding: '一条 finding 现在的状态',
  plan: '评审单现在的批准状态',
  blocker: '一条阻塞项现在的状态',
  report: '刚出的报告',
  review_pack: '刚出的盲审包',
  // 不进 next 的清单：context 返回的那张（core/context.mjs 构造，只读）
  context: '做这一步之前要的经验：做法、shows、danger、知识、遮蔽层、以往情况、截图做法',
};

// ---- 评审单 ----
export function planMissingCard(D) {
  return { kind: 'plan_draft', demand: D, title: `需求 ${D} 还没有评审单`,
    note: ak(`plan new ${D} --title "<一句话说清要验什么>" --platform ios|android|web`) + '，再逐条 plan add-case 填改动面',
    read: `plan/${D}` };
}
export function planDraftCard(D, plan, errs) {
  return { kind: 'plan_draft', demand: D, title: `评审单 v${plan.revision} 还有 ${errs.length} 处硬错`,
    detail: errs.slice(0, 5).map(e => clip(e, 200)),
    note: `照 detail 改完再 ${ak(`plan check ${D}`)}`, read: `plan/${D}` };
}
// delta / approvedN：评审单批过之后又改了（planDelta）—— 只问这次的变化，并说清已批过的照常在测，
// 否则 Owner 读到的是「整张单子等批准」，以为全部停着
export function planReturnedCard(D, plan) {
  return { kind: 'plan_draft', demand: D, title: `owner 退回了评审单 v${plan.revision}`, detail: [`他的意见：${clip(plan.returned.quote, 300)}`],
    note: `照意见改评审单（${ak(`plan add-case ${D} …`)} 等；改了会升版本），再请他批。意见里有要回答的问题，先回答他`, read: `plan/${D}` };
}
export function planApprovalCard(D, plan, delta = null, approvedN = 0, via = null) {
  const change = delta && approvedN ? [delta.added.length && `新加 ${delta.added.length} 条用例（${delta.added.slice(0, 6).join('、')}${delta.added.length > 6 ? ' 等' : ''}）`,
    delta.removed.length && `摘掉 ${delta.removed.length} 条（${delta.removed.slice(0, 6).join('、')}）`].filter(Boolean).join('，') : '';
  return { kind: 'attention', subject: 'plan_approval', demand: D,
    title: approvedN ? `评审单 v${plan.revision} 有改动等批准（已批过的 ${approvedN} 条照常在测）` : `评审单 v${plan.revision} 自检通过，等批准`,
    ...(delta && approvedN ? { added: delta.added, removed: delta.removed } : {}),
    ...(via ? { via: { ui: via.ui, cli: via.cli.length }, detail: [`这次要批的断言：${via.ui} 条在界面上验（看读到结论那一刻的 app 截图）${via.cli.length ? `，${via.cli.length} 条用命令行验` : '，全部在界面上验'}`,
      ...via.cli.slice(0, 12).map(x => `${x.case} ${x.id} 用${({ log: '日志', diag: '诊断命令', debugger: '调试器', cli: '命令行' })[x.via] || x.via}验：${clip(x.why, 120)}`)] } : {}),
    question: approvedN
      ? `需求 ${D}「${clip(plan.title, 60)}」的用例评审单改到了 v${plan.revision}：${change || '用例没变'}。已批过的 ${approvedN} 条照常在测，只有这次的改动等你看；同意的话回一句批准的话。`
      : `需求 ${D}「${clip(plan.title, 60)}」的用例评审单 v${plan.revision} 已经自检通过，请你看一下要测的范围，同意的话回一句批准的话。`,
    note: `把 ${ak(`plan review ${D}`)} 的评审稿交给用户；用户本人同意后先跑 on_reply 记下原话。你不能替他批`,
    on_reply: reply('plan_approve', `plan approve ${D} --by <他> --quote "<原话>" --json`),
    // 他不同意、要改：plan return 记下他的意见，执行者照着改
    on_reject: reply('plan_return', `plan return ${D} --by <他> --quote "<他的意见>" --json`),
    read: `plan/${D}` };
}

// ---- finding ----
export function findingCard(D, f) {
  return { kind: 'attention', subject: 'finding', demand: D, finding: f.id, title: `${f.id} 等 owner 拍板：${clip(f.what, 60)}`,
    question: clip(f.decide || f.what, 300),
    ...(f.options?.length ? { options: f.options.map((o, i) => `${i + 1}. ${o.label} => ${o.effect}`) } : {}),
    ...(f.recommend ? { recommend: clip(f.recommend, 200) } : {}),
    // 漏存最常见的样子：用户在聊天里回了，执行者照着做了却没记。所以 note 把「先记再做」放在最前。
    note: `把 question 和 options 原样交给用户（也可以请他在看板上直接定）。他一回复，先跑 on_reply 记下原话再做别的`
      + `（一句话回了几条就 --finding F1,F2）；他说看不懂：${ak(`plan bounce ${D} --finding ${f.id} --by <他> --quote "<哪里看不懂>" --json`)}`,
    on_reply: reply('plan_decide', `plan decide ${D} --finding ${f.id} --by <他> --quote "<原话>" [--option <序号|recommend>] --json`),
    read: `finding/${D}/${f.id}` };
}
export function findingUnclearCard(D, f, problems) {
  return { kind: 'finding_unclear', demand: D, finding: f.id, title: `${f.id} 写得 owner 定不了：${clip(f.what, 60)}`,
    detail: problems.slice(0, 5),
    note: `补写原条（不另开）：${ak(`plan finding ${D} --finding ${f.id} …`)}；其实不用 owner 定的：${ak(`plan settle ${D} --finding ${f.id} --kind superseded|answered|executor --note "…"`)}`,
    read: `finding/${D}/${f.id}` };
}

// ---- 阻塞项 ----
// 待提的先 --raise（缺解锁条件 / 复盘的 --raise 会拒，先 --set 补）；已提的等回答。
// 待提的不带 question：要交给用户的是 --raise 的输出（它按「要你定 / 我自己的」分好栏），两样都给会让执行者转述两遍。
// 已提的 question 是用户已经收到的那一条（--raise 每条就是「解锁条件 + 影响哪条」），好让他对上号。
export function blockerCard(D, b, ids = [b.id]) {
  const raised = !!b.reported;
  const many = ids.length > 1;
  return { kind: 'attention', subject: 'blocker', demand: D, run: b.run, expect: b.expect, blocker: b.id, blockers: ids,
    title: many ? `${b.case} 的 ${ids.length} 条阻塞（同一个问题）${raised ? '已提给用户，等答复' : '还没提给用户'}：${ids[0]}…${ids[ids.length - 1]}`
      : `${b.id} ${raised ? '已提给用户，等答复' : '卡住了，还没提给用户'}：${b.case}/${b.expect}`,
    ...(raised ? { question: clip(b.ask?.question || b.unlock || b.text || '卡住了', 300),
      ...(b.ask?.why ? { why: clip(b.ask.why, 300) } : {}),
      ...(b.ask?.options?.length ? { options: b.ask.options.map((o, i) => `${i + 1}. ${o.label} => ${o.effect}`) } : {}),
      ...(b.ask?.recommend ? { recommend: clip(b.ask.recommend, 200) } : {}) } : {}),
    note: raised
      ? '等用户答复；回了先跑 on_reply 记下原话'
      : `${ak(`blockers ${D} --raise`)}，把输出原样交给用户（没写解锁条件的先 ${ak(`blockers ${D} --set ${b.id} --unlock "…"`)}）`,
    // 还没提的先提，提了下一轮才是等回答的那张，on_reply 跟着它出
    ...(raised ? { on_reply: reply('blockers', `blockers ${D} --ack ${ids.join(',')} --answer "<原话>" --by <他> --json`) } : {}),
    read: `blocker/${D}/${b.id}` };
}
// 要 owner 答的阻塞还没写成问题：执行者先补写（一组同一个解锁条件的一次写完）
export function blockerUnaskedCard(D, b, ids) {
  return { kind: 'blocker_unasked', demand: D, run: b.run, case: b.case, expect: b.expect, blocker: b.id, blockers: ids,
    title: `${b.case} 卡住了 ${ids.length} 条，还没写成 owner 能拍板的问题`, detail: [`解锁条件（给你看的）：${clip(b.unlock || b.text, 200)}`, ...blockerAskProblems(b).slice(0, 4),
      `问题写不出来、不知道该问 owner 哪块业务：${ak(`consult ${b.run} --expect ${b.expect}`)} 给出通识问题和一条现成的问题草稿`],
    note: ak(`blockers ${D} --set ${ids.join(',')} --ask "<问句？>" --why-you "<你为什么解决不了>" --option "做法 => 后果" --option "…" --recommend "<选哪个、为什么>"`),
    read: `blocker/${D}/${b.id}` };
}
export function blockerOwnCard(D, b) {
  return { kind: 'blocker_own', demand: D, run: b.run, expect: b.expect, blocker: b.id,
    title: `${b.id} 是你自己的能力缺口：${b.case}/${b.expect}`,
    note: `不知道输入从哪来、结果在哪看：先 ${ak(`consult ${b.run} --expect ${b.expect}`)}（通识问题 + 常见取证入口）。补上能力后 ${ak(`blockers ${D} --resolve ${b.id} --by-me "<做了什么、证据在哪>"`)}；补不了就 ${ak(`blockers ${D} --set ${b.id} --unlock "…" --review-note "…"`)} 后 ${ak(`blockers ${D} --raise`)}（只是告知进度，不用等回答）`,
    read: `blocker/${D}/${b.id}` };
}
// 断言后来有了结论，阻塞项却还挂着没提：报告会因它拒出，而它已经不用问人了
export function blockerStaleCard(D, b, status) {
  return { kind: 'blocker_own', demand: D, run: b.run, expect: b.expect, blocker: b.id,
    title: `${b.id} 对应的 ${b.expect} 后来记成了 ${status}，阻塞项还没关`,
    note: ak(`blockers ${D} --resolve ${b.id} --by-me "${b.expect} 后来记成 ${status}"`),
    read: `blocker/${D}/${b.id}` };
}
// 解锁条件 / 说明里已经引着 owner 的原话（「owner MM-DD：…」）却没记成答复：他已经答过了，再问就是重复问。
// 这是执行者的活：把那句原话用 --ack 记下并写清出处，别再出成「等你」
export function blockerQuotedAnswerCard(D, b, ids, quote) {
  return { kind: 'blocker_own', demand: D, run: b.run, expect: b.expect, blocker: b.id, blockers: ids,
    title: `${ids.length > 1 ? `${ids[0]}…${ids[ids.length - 1]}（${ids.length} 条）` : b.id} 的说明里已有 owner 原话，却没记成答复`,
    detail: { quoted: quote },
    note: `owner 已经答过（${quote}），别再问他：${ak(`blockers ${D} --ack ${ids.join(',')} --answer "<他的原话，逐字>" --by "<他>" --source "<哪天、在哪说的>"`)}`,
    read: `blocker/${D}/${b.id}` };
}
export function blockerBackfillCard(D, run, ids) {
  return { kind: 'blocker_own', demand: D, run, title: `运行 ${run} 有 ${ids.length} 条 blocked 没进阻塞台账：${ids.slice(0, 8).join(' ')}`,
    note: `${ak(`blockers ${D} --backfill ${run}`)}，逐条补解锁条件后 ${ak(`blockers ${D} --raise`)}`, read: `run/${run}` };
}

// ---- 轮次 ----
export function roundStaleCard(D, last, moved) {
  return { kind: 'round_stale', demand: D, round: last?.id || null, title: `被测代码相对 ${last?.id || '当前轮'} 变了`,
    detail: moved.slice(0, 5),
    note: `看改了哪些文件，逐条决定继承或重置：${ak(`round new ${D} --assess "<评估结论>" [--reset case::E] [--reset-why "…"] | [--inherit-all]`)}` };
}

// ---- 运行 ----
// left：还没测上的断言（next.mjs untested）；ran：这条用例跑过 —— 那些断言的旧结论被轮次重置了，要开新运行
export function runNeededCard(D, name, exists, surface, left = [], ran = false) {
  const reset = left.filter(e => e.source === 'reset'), never = left.filter(e => e.source !== 'reset');
  const why = [...new Set(reset.map(e => `${e.round}：${e.why || '未写原因'}`))];
  return { kind: 'run_needed', demand: D, case: name,
    title: ran ? `用例 ${name} 有 ${left.length} 条断言没测上，要开新运行` : `用例 ${name} 还没开跑${left.length ? `（${left.length} 条断言）` : ''}`,
    ...(left.length ? { expects: left.map(e => e.id), detail: [
      ...(never.length ? [`从没测过：${never.map(e => e.id).join(' ')}`] : []),
      ...(reset.length ? [`轮次重置了旧结论：${reset.map(e => e.id).join(' ')}（${why.join('；')}）`] : []),
    ] } : {}),
    note: exists ? ak(`run ${name} --demand ${D}`)
      : `用例文件还不存在：${ak(`new ${name} --demand ${D} --surface ${surface || '<S>'} --platform …`)}，写好后 ${ak(`run ${name} --demand ${D}`)}`,
    read: `case/${name}` };
}
// 评审单没批，这些用例开不了跑：并进批准 / 草稿卡片，问的人才知道批了能接着测什么
export function heldByPlan(card, held) {
  const n = held.reduce((s, c) => s + (c.expects?.length || 0), 0);
  const line = `批了才能接着测：${held.length} 条用例${n ? `、${n} 条断言` : ''}（${held.map(c => c.case).slice(0, 6).join('、')}${held.length > 6 ? ' 等' : ''}）`;
  return { held: held.map(c => ({ case: c.case, expects: c.expects || [], detail: c.detail || [] })),
    detail: [...(card.detail || []), line],
    ...(card.question ? { question: `${card.question}${line}。` } : {}) };
}
// how：上一次 acquire 选中了可启动的机器却没能起来时，说明怎么手动启动
export function deviceNeededCard(run, how = null) {
  return { kind: 'device_needed', run, title: `运行 ${run} 还没有设备`,
    ...(how ? { detail: [clip(how, 300)] } : {}),
    note: `${ak(`device acquire --run ${run}`)}：工具按复用 → 启动的顺序选一台并占上`,
    read: `run/${run}` };
}
// device acquire 选中并占上之后的设备卡片：代码看得出的都写上，看不出的（账号、页面能不能测）留给执行者核对
export function deviceCard(run, d) {
  const app = d.app || {};
  const appLine = !d.app_id ? '被测 app：没登记宿主包名，读不到'
    : `被测 app ${d.app_id}：${d.running ? `在跑（${d.running}）` : '没在跑'}${app.version ? ` · 版本 ${app.version}` : ' · 版本读不到'}`;
  return { kind: 'device', run, device: d.key, title: `运行 ${run} 已占上 ${d.key}${d.name ? ` ${d.name}` : ''}（${d.how}）`,
    detail: [
      `身份 ${d.key} · 地址 ${d.address || '（没连上）'} · ${d.platform}${d.host ? ` · 宿主 ${d.host}` : ''}`,
      d.profile && Object.keys(d.profile).length ? `能力 ${Object.entries(d.profile).map(([k, v]) => `${k}=${v}`).join(' · ')}` : '能力：没声明也没读到',
      appLine,
      ...(d.warnings || []),
    ],
    note: `核对代码看不出的：登录的账号对不对、页面能不能测。不对：${ak(`device reject ${d.key} --run ${run} --why "<哪里不对>"`)}，工具会换下一台`,
    read: `run/${run}` };
}
// 现有设备都不能用：要人加一台（白名单只能人改），不占任何设备
export function deviceAttentionCard(run, question, detail = []) {
  return { kind: 'attention', subject: 'device', run, title: `运行 ${run} 没有能用的设备`,
    question: clip(question, 600), detail: detail.slice(0, 8).map(x => clip(x, 200)),
    note: '把 question 原样交给用户；他放行了哪台，先照 on_reply 写进白名单（note 里写谁允许的、原话），再重选',
    on_reply: reply('device_acquire', `config add gate.allow <设备> --kind device --note "<谁允许的：原话>" && acceptkit device acquire --run ${run} --json`),
    read: `run/${run}` };
}
export function stepTodoCard(run, node, web) {
  return { kind: 'step_todo', run, node: node.nodeId, title: `${node.nodeId} 还没有过程截图：${clip(node.op, 60)}`,
    note: `做这一步，再 ${ak(`shot ${run} ${web ? '--web ' : ''}--step ${node.nodeId}`)}${(node.shows || []).length ? `（画面上应该出现：${node.shows.join('、')}）` : ''}`
      + `；需要经验：${ak(`context ${run} --node ${node.nodeId}`)}`,
    read: `run/${run}/step/${node.nodeId}` };
}
export function expectTodoCard(run, e, answer = null) {
  return { kind: 'expect_todo', run, expect: e.id, assert: clip(e.assert || e.title, 160),
    title: `${e.id} 还没有结论${answer ? '（阻塞项用户已答复）' : ''}`,
    ...(answer ? { detail: [`用户答复：${clip(answer, 200)}`] } : {}),
    note: e.observe ? ak(`observe ${run} --expect ${e.id}`)
      : `这条没有观测规格，只能手记：${ak(`record ${run} --expect ${e.id} --status pass|fail|blocked --evidence <证据> --quote "<证据原文片段>"`)}`,
    read: `run/${run}/${e.id}` };
}
export function rejectedCard(run, it) {
  const scope = it.scope;
  return { kind: 'rejected', run, ...(scope.startsWith('step:') ? { node: scope.slice(5) } : { expect: scope }), evidence: it.ev,
    title: `盲审驳回 ${scope} 的 ${it.ev}（${it.rv.state}）`,
    detail: [clip(it.rv.note, 300)].filter(Boolean),
    note: `照驳回理由补证据（证据内容变了会自动回到待审），再重新判；证据确实没错而是上下文变了：${ak(`reviewq --reopen "${it.key}" --run ${run} --why "…"`)}`,
    read: scope.startsWith('step:') ? `run/${run}/step/${scope.slice(5)}` : `run/${run}/${scope}` };
}
export function reviewDueCard(run, items) {
  return { kind: 'review_due', run, count: items.length, title: `${items.length} 份证据还没盲审`,
    detail: items.slice(0, 5).map(i => i.key),
    note: `${ak(`reviewq --pack --run ${run}`)}，交给新上下文的子 agent 只看包下结论，结论原样 ${ak(`reviewq --apply <verdicts.jsonl> --by blind`)}`,
    read: `run/${run}` };
}
export function shotMissingCard(D, run, name, n) {
  return { kind: 'shot_missing', demand: D, run, case: name, title: `${name} 的 ${n} 条结论没有一张 app 画面佐证（运行 ${run}）`,
    detail: ['端上验收要有工具截的 app 画面，证明这轮真在 app 上跑过、停在哪一页；这个运行是规则加上之前记的', '现在补截的图证明不了当时，所以开新运行重测：每一步 shot --step，断言照旧 observe / record'],
    note: ak(`run ${name} --demand ${D}`), read: `run/${run}` };
}
/** 记了结论、证据不全：与报告缺口、看板「证据不全」同一份判据（evidence-gate assertionGaps） */
export function evidenceGapCard(run, ids, gaps, nonUi = {}) {
  const of = k => ids.filter(id => gaps[id].includes(k));
  const shot = of('no_ui_shot').filter(id => !nonUi[id]), reroute = of('no_ui_shot').filter(id => nonUi[id]);
  const none = of('no_evidence'), file = of('not_tool_collected');
  return { kind: 'evidence_gap', run, expect: ids[0], title: `运行 ${run} 有 ${ids.length} 条记了结论、证据不全（${ids.join(' ')}）：缺证据，重试补齐`,
    detail: [
      ...(shot.length ? [`${shot.join(' ')} 是界面上的断言，缺读到结论那一刻的 app 截图：先把画面清干净（登录页、弹窗、Loading 关掉），重跑 observe，它会进到能看到结论的页面、读到判据的同一刻截图`] : []),
      ...reroute.map(id => `${id} 是界面上的断言，可它的读法 ${nonUi[id].op} 走的是 ${nonUi[id].exec} 通道，不截图 —— 重跑也补不上。给它登记一个在 app 页面上读值的配方（ops set，写清进哪一页、读画面上哪几个字；app 自带的调试页也算），把用例的 observe.op 换过去再 observe`),
      ...(file.length ? [`${file.join(' ')} 声明了命令行验证，证据却是你交来的文件：把采集命令（日志命令、调试器脚本）登记成操作库配方（ops set … --platform P --how …），由 observe 亲自去跑`] : []),
      ...(none.length ? [`${none.join(' ')} 一份证据都没有：重跑 observe`] : []),
      `不知道去哪看、找不到能看到结论的入口：${ak(`consult ${run} --expect ${ids[0]}`)} 按判据面给出常见取证入口和要问清的业务问题，先照着查，查不到再拿它的问题草稿问人`,
      '缺证据不是验不了：不要改记 blocked。截图 / 采集本身失败是取证手段的问题，记 apparatus 再重试；同一条连续 3 次还补不上，才 blockers --raise 问用户',
      ...(shot.length || reroute.length ? ['界面上确实看不到（找过 app 自带的调试页也没有）：改用例，给它写 via 和 why_not_ui，下一版评审单会让用户过目'] : [])],
    note: ak(`observe ${run} --expect ${ids[0]}`), read: `run/${run}/${ids[0]}` };
}
export function reportDueCard(run) {
  return { kind: 'report_due', run, title: `运行 ${run} 的断言都有结论、证据都审过`, note: ak(`report ${run}`), read: `run/${run}` };
}
export function stalledCard(run, hours) {
  return { kind: 'stalled', run, title: `运行 ${run} 已经 ${hours} 小时没有动静，还有没做完的`,
    note: `先查实际状态（${ak(`device status`)}、看最后一张截图），别重复已经做过的外部动作；确实放弃就 record blocked 写清原因`,
    read: `run/${run}` };
}

// ---- 命令返回的状态卡片：note 说下一步，核对它是不是你预期的状态 ----
// reviews：{证据: {state, note}}，只放这条（或这个节点）的证据
const reviewDetail = reviews => Object.entries(reviews).filter(([, v]) => v.state !== 'ok' && v.state !== 'pending')
  .map(([ev, v]) => clip(`${ev} 被驳回（${v.state}）：${v.note || ''}`, 300));
const reviewNote = (run, reviews) => {
  const states = Object.values(reviews).map(v => v.state);
  if (states.some(s => s !== 'ok' && s !== 'pending')) return '盲审驳回了：照 detail 的理由补证据，再重新判';
  if (states.includes('pending')) return `${states.filter(s => s === 'pending').length} 份证据待盲审：${ak(`reviewq --pack --run ${run}`)}`;
  return null;
};
export function expectCard(run, e, res = {}, reviews = {}, D = null) {
  const status = res.status || 'todo';
  const back = D ? `回到 ${ak(`next ${D} --json`)}` : '回到 next';
  const note = status === 'todo' ? expectTodoCard(run, e).note
    : reviewNote(run, reviews) || (status === 'blocked' ? `阻塞已登记：${D ? ak(`blockers ${D} --raise`) : 'blockers --raise'}，把输出原样交给用户` : `这条有结论了：${back}`);
  return { kind: 'expect', run, expect: e.id, status, assert: clip(e.assert || e.title, 160),
    title: `${e.id} = ${status}`,
    ...(res.actual ? { actual: clip(res.actual, 300) } : {}),
    evidence: res.evidence || [], reviews: Object.fromEntries(Object.entries(reviews).map(([k, v]) => [k, v.state])),
    ...(res.blocked_kind ? { blocked_kind: res.blocked_kind } : {}), ...(res.finding ? { finding: res.finding } : {}),
    ...(reviewDetail(reviews).length ? { detail: reviewDetail(reviews) } : {}),
    note, read: `run/${run}/${e.id}` };
}
export function stepCard(run, node, step = {}, reviews = {}, shot = null) {
  const ev = step.evidence || [];
  return { kind: 'step', run, node: node.nodeId, title: `${node.nodeId} 过程证据×${ev.length}：${clip(node.op, 60)}`,
    evidence: ev, reviews: Object.fromEntries(Object.entries(reviews).map(([k, v]) => [k, v.state])),
    ...(step.note ? { step_note: clip(step.note, 200) } : {}),
    ...(shot ? { shot } : {}),
    ...(reviewDetail(reviews).length ? { detail: reviewDetail(reviews) } : {}),
    note: !ev.length ? `还没有证据：做这一步，再 ${ak(`shot ${run} --step ${node.nodeId}`)}`
      : reviewNote(run, reviews) || '这一步有证据了：做下一步',
    read: `run/${run}/step/${node.nodeId}` };
}
// 截图的事中检测（blank / similar_to / shows_missing）只提示时也写进卡片：执行者要看图核对
export function shotSummary(meta) {
  const ch = meta.checks || {};
  return { file: meta.file, at: meta.at, page_title: meta.page_title_on_screen || null, checks: ch,
    ...(meta.allow_obscured_reason ? { allow_obscured: meta.allow_obscured_reason } : {}) };
}
export function shotCard(run, meta) {
  return { kind: 'shot', run, title: `截了 ${meta.file}`, shot: shotSummary(meta),
    note: `打开图看一眼是不是要证明的那一页；挂到步骤：${ak(`record ${run} --step <nN> --evidence ${meta.file}`)}`,
    read: `run/${run}/file/${meta.file}.json` };
}
export function findingStateCard(D, f, problems = []) {
  const status = f.decided_by ? 'decided' : f.settled ? 'settled' : problems.length ? 'unclear' : 'pending';
  const note = {
    decided: `Owner 已定（${f.decided_by}）：照决定做，回到 ${ak(`next ${D} --json`)}`,
    settled: `执行者已收口（${f.settled?.kind || ''}）：Owner 可推翻`,
    unclear: `照 detail 补写原条：${ak(`plan finding ${D} --finding ${f.id} …`)}`,
    pending: `等 Owner 拍板：next 会出 attention 卡片，把 question 原样交给用户`,
  }[status];
  return { kind: 'finding', demand: D, finding: f.id, status, nature: f.kind || null,
    title: `${f.id}（${status}）：${clip(f.what, 60)}`,
    ...(f.decide ? { question: clip(f.decide, 300) } : {}),
    ...(f.decision ? { decision: clip(f.decision, 300) } : {}),
    ...(f.decision_option ? { chosen: f.decision_option.label ? `${f.decision_option.index}. ${f.decision_option.label} => ${f.decision_option.effect}` : `推荐：${clip(f.decision_option.recommend, 200)}` } : {}),
    ...(problems.length ? { detail: problems.slice(0, 5) } : {}),
    note, read: `finding/${D}/${f.id}` };
}
export function planStateCard(D, plan) {
  return { kind: 'plan', demand: D, revision: plan.revision, approved: !!plan.approved_at,
    title: `评审单 v${plan.revision}${plan.approved_at ? `已批准（${plan.approved_by}）` : '未批准'}`,
    ...(plan.approved_quote ? { quote: clip(plan.approved_quote, 300) } : {}),
    note: plan.approved_at ? `回到 ${ak(`next ${D} --json`)}` : '等用户本人批准', read: `plan/${D}` };
}
export function blockerStateCard(D, b) {
  const status = b.resolved ? 'resolved' : b.answer ? 'answered' : b.reported ? 'raised' : 'unraised';
  const note = {
    resolved: `已解掉（${clip(b.resolved_how, 80)}）`,
    answered: `用户答复了：照答复处理 ${b.expect}，回到 ${ak(`next ${D} --json`)}`,
    raised: `等用户答复；回了之后 ${ak(`blockers ${D} --ack ${b.id} --answer "<他怎么说的>" --by "<他>"`)}`,
    unraised: b.unlock ? `${ak(`blockers ${D} --raise`)}，把 message 原样交给用户` : `先写解锁条件：${ak(`blockers ${D} --set ${b.id} --unlock "…"`)}`,
  }[status];
  return { kind: 'blocker', demand: D, blocker: b.id, status, run: b.run, case: b.case, expect: b.expect, blocked_kind: b.kind,
    title: `${b.id}（${status}）：${b.case}/${b.expect}`,
    ...(b.unlock ? { unlock: clip(b.unlock, 300) } : {}), ...(b.answer ? { answer: clip(b.answer, 300) } : {}),
    note, read: `blocker/${D}/${b.id}` };
}
export function reportCard(run, rep) {
  return { kind: 'report', run, verdict: rep.verdict, tally: rep.tally, title: `运行 ${run} 的报告：${rep.verdict}`,
    files: { md: rep.md, json: rep.json }, url: rep.url || null,
    ...(rep.gaps ? { detail: [`证据缺口 ${rep.gaps} 处：见报告`] } : {}),
    note: rep.url ? `把报告地址交给用户：${rep.url}` : `报告地址没取到：${ak(`link ${run}`)}`,
    read: `run/${run}/file/run.md` };
}
export function reviewPackCard(p) {
  return { kind: 'review_pack', count: p.packets.length, title: `盲审包 ${p.packets.length} 份（新写 ${p.made} · 命中缓存 ${p.cached}）`,
    index: p.index, packets: p.packets.slice(0, 20), ...(p.packets.length > 20 ? { more: p.packets.length - 20 } : {}),
    note: `把包交给新上下文的子 agent，只看包下结论；结论每行 {"run","key","verdict","note"} 写进 jsonl，原样 ${ak('reviewq --apply <文件> --by blind')}` };
}

/** 文本模式：编号清单。空清单的那句话是循环的停止条件（docs/002-protocol.md 第二节）。 */
export function formatCards(D, cards) {
  if (!cards.length) return `需求 ${D}：这个需求没有剩下的事，报告都出完了：acceptkit link ${D} 把报告地址给用户`;
  const onlyAsk = cards.every(c => c.kind === 'attention');
  const L = [`需求 ${D} 还剩 ${cards.length} 件事（从上往下做；attention 要原样问用户${onlyAsk ? '，现在只剩这些：问完停下等回答' : '，与它无关的照常做'}）：`];
  cards.forEach((c, i) => {
    L.push(`${String(i + 1).padStart(3)}. [${c.kind}] ${c.title}`);
    if (c.question) L.push(`       问用户：${c.question}`);
    if (c.assert) L.push(`       断言：${c.assert}`);
    for (const d of c.detail || []) L.push(`       · ${d}`);
    L.push(`       → ${c.note}`);
    if (c.on_reply) L.push(`       用户回了：${c.on_reply.argv}`);
  });
  return L.join('\n');
}
