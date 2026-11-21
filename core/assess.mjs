// 用例评价：事前（评审 / 开跑前）、事后（运行后）按维度打分，结果落库（assessments / assessment_items / suggestions），
// 卡口从库里取，不靠提示词里写「要检查 XXX」。产品规则：事前 / 事后的评价维度都进库、综合打分；
//   卡口读状态而不是靠提示词提醒；评价内容、给没给建议、用户采纳与否、批准记录都是数据模型的一部分；
//   旧用例不豁免。
//
// 这里只有通识维度（不含任何项目知识）。规则的判定来自 case-quality（Q 规则）与 evidence-gate（证据缺口），
// 本模块只做三件事：把它们归到维度、算分、生成建议并沿用旧建议的决定。
//
// 和 case-quality 的分级（基线 / since）不同：评价**不豁免存量**。存量的问题照样出 block 项；
// 是否放行由「有没有处置」决定 —— 采纳并改掉（下一次评价里这一项消失）、或 owner 明确接受现状 / 判建议不成立。
// 「没登记处置」才拦，「登记了接受现状」不拦 —— 存量能渐进处理，而不是一夜全红。
import { consultFor } from './evidence-consult.mjs';
import { scopesOf, judge } from './version-scope.mjs';
import { expectPlatforms } from './platform.mjs';

export const RUBRIC_VERSION = 1;

// 维度：id、阶段、权重（同阶段合计 100）、人话
export const DIMENSIONS = {
  pre: [
    { id: 'decidable', label: '可判定', weight: 25, ask: '断言有没有机判规格、判一件事、预期有出处' },
    { id: 'observable', label: '可观测', weight: 25, ask: '结论在哪看得到、用什么通道读、读法验证过没有' },
    { id: 'input', label: '输入可造', weight: 15, ask: '要的输入 / 动作在操作库里有没有做法' },
    { id: 'control', label: '对照与前提', weight: 15, ask: '阴性有前提、对照两臂预期不同、写了前置状态、提交后回读' },
    { id: 'safety', label: '安全', weight: 10, ask: '危险操作有结构化标记' },
    { id: 'clarity', label: '表述', weight: 10, ask: '说人话、不写执行状态、不自造字段、主张有断言撑' },
  ],
  post: [
    { id: 'evidence', label: '证据充分', weight: 40, ask: '每条 pass / fail 都有按规矩采的证据' },
    { id: 'consistency', label: '读法一致', weight: 15, ask: '实际用的观测配方与用例登记的一致' },
    { id: 'trust', label: '结论可信', weight: 25, ask: '盲审通过、没有被驳回' },
    { id: 'noise', label: '装置噪音', weight: 10, ask: '取证手段自身的故障次数' },
    { id: 'escape', label: '事前漏网', weight: 10, ask: '事后发现的问题事前评价有没有提出来' },
  ],
};
export const DIM_LABEL = Object.fromEntries([...DIMENSIONS.pre, ...DIMENSIONS.post].map(d => [d.id, d.label]));

// case-quality 规则 → 维度。没列到的规则（项目 pack 自带的）归「表述」。
const RULE_DIM = {
  Q01: 'decidable', Q02: 'decidable', Q03: 'decidable', Q13: 'decidable', Q14: 'decidable',
  Q20: 'observable', Q21: 'observable', Q22: 'observable', Q26: 'observable', Q27: 'observable',
  Q04: 'control', Q05: 'control', Q23: 'control', Q24: 'control', Q08: 'control', Q11: 'control', Q07: 'control',
  Q06: 'safety',
  Q09: 'clarity', Q10: 'clarity', Q12: 'clarity', Q15: 'clarity', Q16: 'clarity',
};
export const dimOfRule = r => RULE_DIM[r] || 'clarity';

const UI_EXECS = new Set(['ui', 'web']);
const recipeOf = (ops, op, pf) => {
  const ps = ops?.[op]?.platforms || {};
  return ps[pf] || Object.entries(ps).find(([k]) => k.split('@')[0] === pf)?.[1] || null;
};
const walkExpects = (tree, out = []) => { for (const n of tree || []) { for (const e of n.expect || []) out.push({ e, n }); walkExpects(n.children, out); } return out; };
// 关键词：英文标识符（≥4）与 2-4 字中文片段；去掉到处都有的泛词
const STOP = new Set(['页面', '上报口', '断言', '读到', '那一', '一刻', '截图', '诊断', '观测', '界面', '调试', '记录', 'app', 'with', 'from']);
export const keyTerms = t => [...new Set((String(t).toLowerCase().match(/[a-z_][a-z0-9_]{3,}|[一-龥]{2,4}/g) || []).filter(w => !STOP.has(w)))];
const walkOps = (tree, out = []) => { for (const n of tree || []) { if (n.op_id) out.push(n.op_id); walkOps(n.children, out); } return out; };

/**
 * 评价里「可观测」「输入可造」两维的额外检查（Q 规则之外）。
 * seen_at（可选字段，人话）= 这条结论的消费方在哪看得到。写了界面入口、读法却不走界面 = 「知道在哪看却没去看」。
 */
export function observabilityFindings(c, ops, platforms) {
  const out = [];
  for (const { e } of walkExpects(c.tree)) {
    const op = e.observe?.op;
    for (const pf of platforms) {
      if (!op) continue;
      const r = recipeOf(ops, op, pf);
      if (!r) { out.push({ rule: 'O2', dimension: 'observable', level: 'block', at: e.id, msg: `${pf} 上的观测操作 ${op} 在操作库里没有配方`, fix: `ops set ${op} --platform ${pf} …，试通后 ops verify` }); continue; }
      if (r.absent) continue;
      if (r.state === 'guess') out.push({ rule: 'O2', dimension: 'observable', level: 'warn', at: e.id, msg: `${pf} 上的观测操作 ${op} 还是推测的配方，没实测过`, fix: `observe --try 试通后 ops confirm ${op} --platform ${pf}` });
      const ui = UI_EXECS.has(r.exec);
      if (e.seen_at && !ui && (!e.via || e.via === 'ui'))
        out.push({ rule: 'O1', dimension: 'observable', level: 'block', at: e.id, msg: `写了结论在「${e.seen_at}」看得到，读法 ${op}（exec=${r.exec}）却不走界面`, fix: '把 observe.op 换成在那个界面上读值的配方；界面上确实读不到，就写 via + why_not_ui' });
    }
    // O4：「界面上看不到」是带日期的事实，被测产品加了观测入口它就过期了（实例：几条断言写着「事件日志分不出
    //     交没交出去」，后来观测台加了投递留痕，这句话就不再成立，却没人回头复核）。
    //     判据：不走界面的断言，操作库里有界面通道的配方与它说的是同一件事（关键词有交集）⇒ 提示复核 why_not_ui。
    //     关键词重合只是「可能」，判不了「读得到」：只提示、不拦（实测一个需求 101 条断言被它拦下，why_not_ui 早写明了原因）。
    //     核过某个界面读法确实读不到的，记在断言的 why_not_ui_checked: [{ op, at: "YYYY-MM-DD", why }]，那个读法不再点名。
    if (e.via && e.via !== 'ui') {
      const words = keyTerms(`${e.assert} ${e.why_not_ui || ''}`);
      const checked = new Set((e.why_not_ui_checked || []).filter(x => x?.op && x.at).map(x => String(x.op)));
      const hits = Object.entries(ops || {}).filter(([id, o]) => id !== op && !checked.has(id) && Object.entries(o.platforms || {}).some(([k, r]) => platforms.includes(k.split('@')[0]) && UI_EXECS.has(r?.exec) && !r.absent))
        .map(([id, o]) => ({ id, n: keyTerms(`${id} ${o.title || ''} ${o.why || ''}`).filter(w => words.includes(w)).length })).filter(x => x.n >= 2).sort((a, b) => b.n - a.n);
      if (hits.length) out.push({ rule: 'O4', dimension: 'observable', level: 'warn', at: e.id,
        msg: `写的是「界面上看不到」（via=${e.via}），但操作库里已有界面读法可能读得到：${hits.slice(0, 3).map(h => h.id).join('、')}`,
        fix: `复核 why_not_ui：用 ${hits[0].id} 试读（observe --try）；读得到就改成界面读法（走评审单修订）；读不到就在断言上记 why_not_ui_checked: [{"op":"${hits[0].id}","at":"<日期>","why":"<为什么读不到>"}]` });
    }
    if (e.observe && !e.seen_at && (!e.via || e.via === 'ui'))
      out.push({ rule: 'O3', dimension: 'observable', level: 'warn', at: e.id, msg: '没写这条结论的消费方在哪看得到（seen_at）', fix: '写 seen_at：用户 / QA 在哪个页面、工具、平台能看到这个结论' });
  }
  for (const id of walkOps(c.tree)) for (const pf of platforms) {
    if (!ops?.[id]) { out.push({ rule: 'I1', dimension: 'input', level: 'block', at: '用例', msg: `操作 ${id} 不在操作库里`, fix: `ops set ${id} --platform ${pf} --how … 并试通` }); break; }
    if (!recipeOf(ops, id, pf)) out.push({ rule: 'I1', dimension: 'input', level: 'warn', at: '用例', msg: `操作 ${id} 在 ${pf} 上没有做法`, fix: `ops set ${id} --platform ${pf} --how …` });
  }
  return out;
}

export const itemKey = (subject, i) => `${subject}|${i.rule}|${i.at}`;

/** 维度分（0-5）与综合分（0-100）。block 未处置 ⇒ 综合分封顶 59、卡口 block。 */
export function score(items, phase, decided = () => false) {
  const dims = DIMENSIONS[phase];
  const per = {};
  for (const d of dims) {
    const mine = items.filter(i => i.dimension === d.id && i.level !== 'ok');
    const open = mine.filter(i => !decided(i));
    per[d.id] = open.some(i => i.level === 'block') ? 1 : open.length ? 3 : mine.length ? 4 : 5;
  }
  let total = Math.round(dims.reduce((s, d) => s + d.weight * per[d.id] / 5, 0));
  const openBlock = items.filter(i => i.level === 'block' && !decided(i));
  const openWarn = items.filter(i => i.level === 'warn' && !decided(i));
  if (openBlock.length) total = Math.min(total, 59);
  return { per, total, gate: openBlock.length ? 'block' : openWarn.length ? 'warn' : 'pass', open_block: openBlock.length, open_warn: openWarn.length };
}

/**
 * 事前评价一条用例（纯函数，不读写库）。
 * findings = case-quality checkCase 的原始结果（不按基线 / since 分级）。
 */
export function assessCasePre(c, { findings = [], ops = {}, platforms = [], build = null } = {}) {
  const items = [];
  // 评审单记了被测包（plan --build）：落在不适用范围里的断言不评 —— 被删掉的那一支本来就不在这个包里，评它只会拦住评审单
  const na = new Set();
  if (build && Object.keys(build).length) for (const [id, sc] of Object.entries(scopesOf(c.tree))) if (judge(sc, build).state === 'na') na.add(id);
  // 评审单是单平台（plan.platform）：断言声明了只在别的端跑的，不评 —— 与 applies 对称。同一条用例换到那一端的评审单照常评
  const naPlat = new Set();
  if (platforms.length) for (const { e } of walkExpects(c.tree)) { const ps = expectPlatforms(e); if (e.id && ps && !ps.some(p => platforms.includes(p))) naPlat.add(e.id); }
  for (const id of naPlat) na.add(id);
  if (na.size) { findings = findings.filter(f => !na.has(f.at)); }
  for (const f of findings) {
    const decidedByWaiver = !!f.waived;
    items.push({ dimension: dimOfRule(f.rule), rule: f.rule, at: f.at, level: f.level === 'block' ? 'block' : 'warn',
      finding: `${f.title}：${f.msg}`, evidence: f.why || '', fix: f.fix || '', waived: decidedByWaiver ? f.waived : null });
  }
  for (const f of observabilityFindings(c, ops, platforms).filter(f => !na.has(f.at)))
    items.push({ dimension: f.dimension, rule: f.rule, at: f.at, level: f.level, finding: f.msg, evidence: '', fix: f.fix });
  const naBuild = [...na].filter(id => !naPlat.has(id));
  if (naBuild.length) items.push({ dimension: 'clarity', rule: 'NA', at: '用例', level: 'ok', finding: `${naBuild.join(' ')} 在评审单记的被测包上不适用（applies），不参与评价`, evidence: '', fix: '' });
  if (naPlat.size) items.push({ dimension: 'clarity', rule: 'NA', at: '用例', level: 'ok', finding: `${[...naPlat].join(' ')} 只在别的端跑，本评审单（${platforms.join(', ')}）不评`, evidence: '', fix: '' });
  for (const d of DIMENSIONS.pre) if (!items.some(i => i.dimension === d.id))
    items.push({ dimension: d.id, rule: '-', at: '用例', level: 'ok', finding: `${d.label}：没有发现问题（${d.ask}）`, evidence: '', fix: '' });
  return items;
}

// evidence-gate 的缺口 → 事后维度；这几类在事前属于哪一维（用来判「事前漏网」）
const GAP_PRE_DIM = { no_ui_shot: 'observable', not_tool_collected: 'observable', no_evidence: 'observable' };
const GAP_TEXT = {
  no_evidence: '没有任何证据', no_ui_shot: '界面上的断言没有读到结论那一刻的 app 截图',
  not_tool_collected: '声明了命令行验证，证据却不是 observe 亲自采的',
};

/**
 * 事后评价一次运行（纯函数）。
 * gaps = evidence-gate assertionGaps 的结果；reviews = result.reviews；apparatus = 装置故障次数；
 * expectOps = { E: 用例登记的 observe.op }；preItems = 运行时那条事前评价的明细（判漏网用）。
 */
export function assessRunPost(r, { gaps = {}, apparatus = 0, expectOps = {}, preItems = [] } = {}) {
  const items = [];
  for (const [eid, gs] of Object.entries(gaps)) for (const g of gs) {
    items.push({ dimension: 'evidence', rule: `G:${g}`, at: eid, level: 'block', finding: `${eid}：${GAP_TEXT[g] || g}`, evidence: '', fix: `acceptkit consult ${r.run || '<run>'} --expect ${eid}：先问清结论在哪看得到，再补证据` });
    const preDim = GAP_PRE_DIM[g];
    if (preDim && !preItems.some(p => p.at === eid && p.dimension === preDim && p.level !== 'ok'))
      items.push({ dimension: 'escape', rule: `X:${g}`, at: eid, level: 'warn', finding: `${eid}：事后发现「${GAP_TEXT[g] || g}」，事前评价的「${DIM_LABEL[preDim]}」没提出来`, evidence: '', fix: '写 retro：事前为什么没发现（规则缺口 / 用例当时没写 seen_at / 规则豁免了存量…）', needs_retro: true });
  }
  for (const [eid, v] of Object.entries(r.results || {})) {
    const want = expectOps[eid];
    const got = v?.observed?.op;
    if (want && got && want !== got && ['pass', 'fail'].includes(v.status))
      items.push({ dimension: 'consistency', rule: 'C1', at: eid, level: 'warn', finding: `${eid}：用例登记用 ${want} 读，实际用的是 ${got}`, evidence: '', fix: '读法变了就改用例（走评审单修订），别在执行时换' });
  }
  for (const [k, rv] of Object.entries(r.reviews || {})) {
    const eid = k.split('::')[0];
    if (rv?.state === 'rejected') items.push({ dimension: 'trust', rule: 'T1', at: eid, level: 'block', finding: `${eid}：盲审驳回 —— ${String(rv.why || rv.reason || '').slice(0, 120)}`, evidence: k, fix: '照驳回理由补证据重新判' });
  }
  if (apparatus >= 3) items.push({ dimension: 'noise', rule: 'N1', at: '运行', level: 'warn', finding: `取证手段自身出了 ${apparatus} 次故障`, evidence: '', fix: '把反复出问题的取证步骤沉淀成稳定的操作配方' });
  for (const d of DIMENSIONS.post) if (!items.some(i => i.dimension === d.id))
    items.push({ dimension: d.id, rule: '-', at: '运行', level: 'ok', finding: `${d.label}：没有发现问题（${d.ask}）`, evidence: '', fix: '' });
  return items;
}

/** 一条非 ok 明细 → 建议草稿（可观测 / 证据维度附取证咨询的问题清单） */
export function suggestionFor(item, { assertText = '' } = {}) {
  const consult = ['observable', 'evidence', 'escape'].includes(item.dimension)
    ? consultFor({ assert: assertText || item.finding, situation: 'gap', gaps: [item.rule] }) : null;
  return {
    kind: 'fix', text: item.fix || '按发现修改',
    options: [
      { choice: 'adopt', label: '采纳：照建议改', effect: '改完重新评价，这一项消失即落地' },
      { choice: 'accept', label: '接受现状', effect: '不改；放行，记下你的原话（断言上应补 via + why_not_ui 之类的说明）' },
      { choice: 'reject', label: '建议不成立', effect: '工具判错了；放行，并记为评价规则的反例' },
    ],
    consult: consult ? { questions: consult.questions, surfaces: consult.surfaces.slice(0, 6) } : null,
    needs_retro: !!item.needs_retro,
  };
}

export const DECISIONS = new Set(['adopt', 'accept', 'reject']);
/** 建议的决定是否让这一项不再拦（采纳了还要等改掉 —— 改掉了这一项就不在新评价里了） */
export const clearsGate = s => s && (s.status === 'accepted' || s.status === 'rejected');
