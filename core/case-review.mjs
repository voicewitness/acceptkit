// 用例评审（docs/case-review.md）：工具收事实、给标准、定上限、核对复述；模型（盲审）按标准逐项打 0–3 分。
// 纯函数，不调模型、不读写文件：项目相关的事实（界面字查得到没有、同一段文字在别的用例出现几次、触发来源、改动面）由调用方算好放进 ctx。
//
// 两类事实：
//   硬事实（hard）：代码能确定判出的 → 给这一项一个分数上限，模型不能越过，也不能申诉（要改就改数据：clarify / ops set）
//   软信号（signal）：正则、相似度这类可能误报的 → 不定上限，模型逐条 accept / dismiss；dismiss 要引用一条本项范围内的事实
// 复述（extract）：打分前把被评对象复述成固定字段，工具逐项核对复述的值确实出现在原文里 —— 编不出来就说明写得不具体
import { createHash } from 'node:crypto';
import { stepInput, INPUTS } from './input-source.mjs';
import { expandHuman, fillHuman, STRUCT_IN_TEXT, RAW_COMMAND, emptySlots, CONCRETE_STEP, vagueNav } from './clarity.mjs';
import { uiNames } from './trigger-consult.mjs';
import { grams } from './ask-gate.mjs';
import { chainConfigIds } from './configsets.mjs';

export const RUBRIC_VERSION = 2;
export const EXTRACTOR_VERSION = 1;
export const GATE_MIN = 2;

// 每个维度：人话名、评谁、问什么、各分含义、复述格式。标准写在这里随评审包下发，不靠提示词
export const DIMS = {
  A1: { label: '能照着做', on: 'action', question: '不熟业务的人能不能照着做：在哪、做什么、输入什么',
    levels: { 0: '没有动作（是一句结论 / 说明），或塞着机器的计划（JSON、空值）', 1: '要猜在哪一页、做什么或输入什么（例：「执行注入计划 X」）', 2: '在哪、做什么、输入什么都有，只缺手势 / 等待 / 文案这类不改变路径的细节（例：按钮要滑动才看得到）', 3: '照着做不会走错，界面字核对得上' },
    restate: '{ where: "<在哪>" | { app: true }, do: "<做什么>", input: "<输入什么>" | { none: true, why } }。三项都要逐字摘自这一步的文字、参数（名=值）、操作的人看步骤或配置集项（见 facts 的 step_text / param / op_human / config_set），不要自己概括；步骤只写了「在 app 里」没写哪一页的，where 写 { app: true }（这本身说明在哪写得不具体，分数照实给）' },
  A2: { label: '该不该是操作集', on: 'action', question: '这段做法该引用已有操作、新建操作，还是就地写',
    levels: { 0: '照抄了别处已有的多步做法，又写得不全', 1: '库里有同样的做法却没引用，或引用的操作不能用（观测类 / 本平台没有人看步骤）', 2: '判断合理但引用的操作还缺一点（例：缺参数说明）', 3: '成熟做法引用了操作集，一次性的就地写清' },
    restate: '{ decision: "ref:<操作 id>" | "new-op" | "inline", why }：decision 写这一步「应该」怎样；它实际引用了什么、哪里不对写进 why / reason' },
  A3: { label: '触发说清了', on: 'action', question: '这一步怎么让被测系统收到输入，说清了没有（真不真实由 Q32 / Q33 管）',
    levels: { 0: '来源不明，或注入没写为什么造不出真实输入', 1: '声明了来源，理由没说为什么不能真实触发', 2: '声明了来源并写了理由', 3: '真实触发，或注入写了调研（research）' },
    restate: '{ from: "real" | "mock-global" | "injected" | "unknown", why }' },
  A4: { label: '一步一事', on: 'action', question: '一步只做一件事；配置 / mock 进配置集，不塞进步骤',
    levels: { 0: '一步里塞了好几件互不相干的事，或按业务结果分叉（「若命中则…否则…」）', 1: '一步里有两件以上要分别确认的事，或把配置 / mock 写在步骤里', 2: '一件主动作，带一个防御性的小前提（例：「已登录就先退出」）或顺手的小动作', 3: '一件事' },
    restate: '{ actions: ["<数出来的每个动作，原文里的字>", …] }：只数动作，进哪一页的那串点击（长按 → 搜 → 点进某页）算「在哪」不算动作；数出 2 个（主动作 + 一个小前提）最多 2 分，3 个以上最多 1 分' },
  A5: { label: '可复现', on: 'action', question: '换个人、换一天照着做，结果一样吗：不依赖自然发生的事件、历史读数、按编号引用别的步骤',
    levels: { 0: '依赖自然发生的事件、某天的读数，或只存在于临时文件里的内容', 1: '依赖没写明怎么拿 / 怎么确认的东西：按「第 N 步」引用别的步骤、要一个用掉就没的资源（没注册过的号）却没说从哪来、取决于 AB 分组却没说怎么确认分组', 2: '有一处小依赖（例：等一会儿、消耗型资源）但写了从哪来 / 怎么确认', 3: '不依赖' },
    restate: '{ deps: ["<依赖了什么>", …] }（没有写 []）' },
  E1: { label: '结果由哪步产生', on: 'expect', question: '前面哪一步的什么输入产生了这条预期要看的结果；一上来就看状态的（启动链路）是不是真的在验启动后的状态',
    levels: { 0: '前面没有能产生这个结果的动作（例：要判某个事件的决策，却一上来就打开诊断台）', 1: '有动作但说不清它的哪个输入导致这个结果', 2: '因果清楚，输入写得略粗', 3: '因果清楚，输入逐字对得上' },
    restate: '{ because: <原样复述用例里的 because> }。注意：because 指向的那一步「能照着做」低于 2 分时，这一项也不能 ≥ 2（那一步做不出来，结果就产生不了）' },
  E2: { label: '照着看得出', on: 'expect', question: '照 see 能不能看出结论：哪页、哪一行、哪个字、怎样算对',
    levels: { 0: '没写怎么看', 1: '要猜进哪页 / 看哪一行；或者看「某个 trigger 的最近一条」，而这个 trigger 后台也在不停产生（共用的网络 / 埋点 trigger），没说怎么认出是这一步产生的那条', 2: '页面和行有，怎样算对略粗', 3: '页面、行、字、怎样算对都有' },
    restate: '{ page, row, pass_when }：三项都逐字摘自 see 或观测操作的人看步骤（facts 的 see / observe_human），不要概括' },
  E3: { label: '判据对得上', on: 'expect', question: '机器判据（checks）和人话结论（assert / say）验的是不是同一件事',
    levels: { 0: '没有判据', 1: '判据和结论说的不是一件事（例：结论写真实请求、判据读注入结果）', 2: '对得上，个别主张没有判据', 3: '每个主张都有判据' },
    restate: '{ map: [{ claim: "<assert 里的原文>", check: <checks 序号> | null }], same: true | false }：没有判据的主张 check 写 null（有 null 最多 2 分）' },
  C1: { label: '结构', on: 'struct', question: '分组只做标题；没有空分组、没有走不到的空分支',
    levels: { 0: '有空分组或空分支', 1: '分组标题其实是动作 / 动作其实是分组', 2: '结构对，个别节点该合并或拆开', 3: '结构清楚' },
    restate: '分组：{ is_title: true | false }；整条用例：{ issues: ["…"] }（没有写 []）' },
  C2: { label: '前置可建立', on: 'case', question: '每条前置条件要么有操作能建立，要么写明人工确认的理由',
    levels: { 0: '步骤依赖的前提一条都没登记成前置（全藏在步骤里）', 1: '登记了，但只有一句话、没写怎么建立，或引用的操作不存在；或有依赖的前提没登记（写进 missing）', 2: '每条都写了怎么建立，有一条人工确认的理由写得粗', 3: '每条都能建立' },
    restate: '{ pre: [{ how: "op:<操作 id>" | "manual", why }], missing: ["<步骤里用到、却没登记成前置的条件，原文里的字>"] }（pre 和登记的前置一一对应，没有写 []；missing 有内容时 C2 照实给低分）；改法：acceptkit clarify <用例> --precondition-set <序号|new> --text … --how op:<操作>|manual --why …' },
  R1: { label: '验到需求', on: 'case', question: '需求里每一句主张，有没有一条 role=claim 的预期在验它',
    levels: { 0: '只有对照和前置检查，没有验需求本身的预期', 1: '有主张没被任何预期验到', 2: '都验到了，个别预期验得间接', 3: '每个主张都有直接的预期' },
    restate: '{ map: [{ surface: "<改动面 / 需求主张>", expect: "<预期 id>" | null }] }：没有任何预期在验的改动面 expect 写 null（有 null 最多 1 分）' },
};
const ACTION_DIMS = ['A1', 'A2', 'A3', 'A4', 'A5'], EXPECT_DIMS = ['E1', 'E2', 'E3'];
export const DIM_LABEL = Object.fromEntries(Object.entries(DIMS).map(([k, d]) => [k, d.label]));

// 内置考题：owner 判过不合格的写法（通用化，不带项目名）。项目可以在 review_canaries 里加自己的原题
export const BUILTIN_CANARIES = [
  { dim: 'A1', text: '执行注入计划「plan-x」（文件 probes/plan-x.json）：把事件按顺序喂给引擎，结果写进本次运行的 evidence/results.json', max: 1, source: 'builtin' },
  { dim: 'A1', text: '引擎内生成了第二段事件', max: 0, source: 'builtin' },
];

// ---------- 用例结构 ----------
/** 评审按哪个平台展开操作步骤：打包、核对、状态（含 next 看板）必须用同一个，否则指纹对不上 */
export const reviewPlatform = c => String(c.platform || '').toLowerCase().split(/[,/\s]+/).find(p => ['ios', 'android', 'web'].includes(p)) || null;
export const kindOf = n => n.kind === 'group' ? 'group' : 'action';
/** 树上每个节点：{ n, pos: n1.2, ref: nid 或 pos, chain: [祖先] } */
export function walk(c) {
  const out = [];
  (function w(ns, pos, chain) { (ns || []).forEach((n, i) => { const p = `${pos}${i + 1}`, me = { n, pos: p, ref: n.nid || p, chain }; out.push(me); w(n.children, `${p}.`, [...chain, me]); }); })(c.tree, 'n', []);
  return out;
}
export const roleOf = e => e.role || 'claim';
const stripVol = o => { const { result, evidence, clarified, notes, note, tags, history, revisions, revision, ...rest } = o || {}; return rest; };
const canon = v => JSON.stringify(v, (k, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(y => [y, x[y]])) : x);
const sha = v => createHash('sha256').update(canon(v)).digest('hex').slice(0, 16);
const nodeProj = n => ({ kind: kindOf(n), op: n.op || '', op_id: n.op_id || null, params: n.params || null, input: n.input || null, config: n.config || null, ...(n.config_unset ? { config_unset: n.config_unset } : {}) });
const norm = s => String(s ?? '').replace(/[「」『』“”"'\s]/g, '').toLowerCase();
// 复述值要逐字出现在某一条原文里；长原文可以用「…」省略中间，各段按顺序都在同一条里就算
const inSrc = (v, srcs) => { const parts = String(v ?? '').split(/…|\.\.\./).map(norm).filter(Boolean); if (!parts.length) return false;
  return srcs.some(s => { const t = norm(s); let at = 0; for (const p of parts) { const i = t.indexOf(p, at); if (i < 0) return false; at = i + p.length; } return true; }); };
const obsOf = e => e.observe?.by ? Object.values(e.observe.by)[0] : e.observe;

/** 评审项：每个动作 A1–A5、每个分组 C1、每条预期 E1–E3、整条用例 C1 / C2 / R1。key = case:<用例>|<维度>|<nid 或预期 id 或 case> */
export function itemsOf(c) {
  const out = [], key = (dim, at) => `case:${c.case}|${dim}|${at}`;
  for (const x of walk(c)) {
    if (kindOf(x.n) === 'action') for (const d of ACTION_DIMS) out.push({ key: key(d, x.ref), dim: d, at: x.ref, pos: x.pos, on: 'action' });
    else out.push({ key: key('C1', x.ref), dim: 'C1', at: x.ref, pos: x.pos, on: 'group' });
    for (const e of x.n.expect || []) for (const d of EXPECT_DIMS) out.push({ key: key(d, e.id), dim: d, at: e.id, pos: x.pos, on: 'expect', role: roleOf(e) });
  }
  for (const d of ['C1', 'C2', 'R1']) out.push({ key: key(d, 'case'), dim: d, at: 'case', on: 'case' });
  return out;
}

// ---------- 事实与信号 ----------
/**
 * ctx：{ ops, platform, sets（配置集）, nameState(name) → 'found'|'missing'|'unknown', dupOf(text) → [别的用例],
 *        inputs: Map(预期 id → 触发来源 from), surfaces: [改动面 { id, change }] }
 * → { facts: [{ id, at, type, text, hard?: { dim, max } }], signals: [{ id, at, dim, type, text }] }
 */
export function collectFacts(c, ctx) {
  const { ops = {}, platform = null, sets = {}, nameState = () => 'unknown', dupOf = () => [], inputs = new Map(), surfaces = [] } = ctx;
  const facts = [], signals = [];
  const F = (at, type, text, hard) => { const id = `f${facts.length + 1}`; facts.push({ id, at, type, text: String(text).slice(0, 3000), ...(hard ? { hard } : {}) }); return id; };
  const S = (at, dim, type, text) => signals.push({ id: `g${signals.length + 1}`, at, dim, type, text: String(text).slice(0, 300) });
  const nodes = walk(c);
  for (const x of nodes) {
    const n = x.n, text = String(n.op || ''), at = x.ref;
    if (kindOf(n) === 'group') {
      F(at, 'group_title', text);
      if (!(n.children || []).length && !(n.expect || []).length) F(at, 'empty_group', '分组下面既没有子节点也没有预期', { dim: 'C1', max: 0 });
      if (n.op_id || n.params || n.input) F(at, 'group_with_action', `分组挂着操作 / 参数 / 触发声明（${n.op_id || ''}）：它其实是一步动作`, { dim: 'C1', max: 1 });
      if (CONCRETE_STEP.test(text)) S(at, 'C1', 'group_looks_action', `分组标题像一个动作：「${text.slice(0, 60)}」`);
      continue;
    }
    const reg = n.op_id ? ops[n.op_id] : null, human = n.op_id ? expandHuman(ops, n.op_id, new Set(), platform) : [];
    F(at, 'step_text', text || '（空）');
    // 这一步生效的配置集（用例级 + 祖先 + 本节点）：mock 的理由写在配置集里，评审要看得到
    const cfgIds = chainConfigIds(c.config, [...x.chain.map(y => y.n), n]);
    for (const id of cfgIds) { const set = sets[id]; F(at, 'config_set', set ? `配置集 ${id}「${set.title || ''}」：${(set.items || []).map(i => `${i.key}=${i.value}（${i.kind === 'mock' ? 'mock' : '真实环境'}${i.why ? `，理由：${i.why}` : ''}${i.apply ? `，用 @${i.apply} 施加` : ''}）`).join('；')}` : `配置集 ${id} 没有登记`); }
    // 参数逐个给（复述时摘单个值或「名=值」都认）
    for (const [k, v] of Object.entries(n.params || {})) F(at, 'param', `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
    if (human.length) F(at, 'op_human', `${n.op_id}：${fillHuman(human, n.params || {}).join(' → ')}`);
    if (!text.trim() && !n.op_id) F(at, 'op_missing', '这一步没有文字也没有引用操作', { dim: 'A1', max: 0 });
    if (STRUCT_IN_TEXT.test(text)) F(at, 'struct_in_text', '步骤文字里塞着 JSON（机器的计划，不是人能照做的一步）', { dim: 'A1', max: 0 });
    if (emptySlots(n)) F(at, 'empty_slot', '步骤里有没填的值（空字符串 / 空参数）', { dim: 'A1', max: 0 });
    if (/�/.test(text + JSON.stringify(n.params || {}))) F(at, 'garbled', '步骤文字里有乱码（U+FFFD），填的值丢了', { dim: 'A1', max: 0 });
    if (n.op_id && !reg) { F(at, 'op_unknown', `引用的操作 ${n.op_id} 不存在`, { dim: 'A1', max: 1 }); F(at, 'op_unknown', `引用的操作 ${n.op_id} 不存在`, { dim: 'A2', max: 1 }); }
    if (reg?.kind === 'observe') { F(at, 'op_kind_mismatch', `动作步骤挂的是观测类操作 ${n.op_id}`, { dim: 'A1', max: 1 }); F(at, 'op_kind_mismatch', `动作步骤挂的是观测类操作 ${n.op_id}`, { dim: 'A2', max: 1 }); }
    if (reg && !human.length) { F(at, 'op_no_human', `操作 ${n.op_id} 在 ${platform || '本平台'} 没有人看的步骤`, { dim: 'A1', max: 1 }); F(at, 'op_no_human', `操作 ${n.op_id} 在 ${platform || '本平台'} 没有人看的步骤`, { dim: 'A2', max: 1 }); }
    // 界面字三态：查不了（没登记被测仓 / 搜出错）不算找到
    const names = uiNames([text, ...human]);
    if (!names.length) F(at, 'no_ui_name', '这一步没有一个可核对的界面字（「」里的页面 / 按钮名）');
    for (const nm of names) { const st = nameState(nm);
      F(at, `ui_name_${st}`, `界面字「${nm}」：${{ found: '被测代码里找得到', missing: '被测代码里逐字找不到', unknown: '查不了（没登记被测仓或搜索出错）' }[st]}`, st === 'missing' ? { dim: 'A1', max: 1 } : st === 'unknown' ? { dim: 'A1', max: 2 } : null); }
    const si = stepInput(n, ops);
    F(at, 'step_input', `触发来源（工具算的）：${si.from}${si.by !== 'none' ? `（依据：${si.by}${si.op ? ' ' + si.op : ''}）` : ''}`,
      si.from === 'unknown' ? { dim: 'A3', max: 1 } : si.from === 'injected' && !String(si.decl?.why || reg?.why || '').trim() ? { dim: 'A3', max: 0 } : null);
    if (!n.op_id && text.trim()) { const dup = dupOf(text); if (dup.length) F(at, 'dup_inline', `同一段文字在 ${dup.length} 条别的用例里也有（${dup.slice(0, 4).join('、')}）却没做成操作`, { dim: 'A2', max: 1 }); }
    if (!(n.children || []).length && !(n.expect || []).length) F('case', 'action_dead_end', `${x.pos}「${text.slice(0, 40)}」下面既没有预期也没有下一步`, { dim: 'C1', max: 0 });
    // 软信号
    if (!n.op_id && RAW_COMMAND.test(text)) S(at, 'A2', 'raw_command', '步骤里直接写着命令：命令是机器做法，常用的该做成操作、步骤只写人话');
    if (!n.op_id && !CONCRETE_STEP.test(text)) S(at, 'A1', 'vague_step', '没有「动作 + 界面字」的形状（可能是结论句或说明）');
    for (const m of text.matchAll(/「([^」]{2,80})」/g)) if (/[\\/]|\.[a-z]{2,5}$|^[\w.-]+\.(json|py|sh|mjs)$|^[a-z0-9_-]{12,}$/i.test(m[1])) S(at, 'A1', 'quoted_not_ui', `「${m[1]}」像文件名 / 路径 / id，不像界面上的字`);
    if (!n.op_id) { const best = similarOp(text, ops, platform); if (best) S(at, 'A2', 'similar_op', `操作库里有相似的操作 ${best.id}（${best.title}）`); }
    if (/mock|setprop|设成|设为|开关|=\s*(true|false)\b/i.test(text) && !cfgIds.length) S(at, 'A4', 'config_in_step', '步骤里描述了配置 / mock，链上没挂配置集');
    if (/若|如果|否则|不然/.test(text)) S(at, 'A4', 'branch_in_step', '一步里有条件分支');
    if (/自然发生|自然触发|等它|约\s*\d+\s*分钟/.test(text)) S(at, 'A5', 'natural_wait', '依赖自然发生的事件或等待');
    if (/第\s*\d+\s*步/.test(text)) S(at, 'A5', 'step_ref_by_index', '按「第 N 步」引用别的步骤');
    if ((n.children || []).length && !(n.expect || []).length && !n.op_id && !CONCRETE_STEP.test(text)) S(at, 'A1', 'kind_unconfirmed', `「${text.slice(0, 40)}」下面有子步骤、自己没有动作：可能其实是分组标题`);
  }
  // 预期
  for (const x of nodes) for (const e of x.n.expect || []) {
    const at = e.id, chain = [...x.chain, x].filter(y => kindOf(y.n) === 'action'), b = obsOf(e), oreg = b?.op ? ops[b.op] : null;
    const ohuman = b?.op ? expandHuman(ops, b.op, new Set(), platform) : [], see = [].concat(e.see || []);
    F(at, 'assert', e.assert || '');
    F(at, 'chain', chain.length ? chain.map(y => `${y.pos}「${String(y.n.op || '').slice(0, 60)}」${y.n.op_id ? `（@${y.n.op_id}）` : ''}`).join(' → ') : '（这条预期前面没有任何动作）');
    if (b?.op) F(at, 'observe', `观测 ${b.op}${oreg?.title ? `：${oreg.title}` : ''}${oreg?.reads ? `（读：${oreg.reads}）` : '（没登记读的是逐事件还是启动后状态）'}`);
    if (ohuman.length) F(at, 'observe_human', fillHuman(ohuman, b?.params || {}).join(' → '));
    if (see.length) F(at, 'see', see.join(' → '));
    F(at, 'input_from', `这条预期的触发来源（工具算的）：${inputs.get(at) || 'unknown'}`);
    // E1：因果
    const bc = e.because;
    if (!bc || typeof bc !== 'object') F(at, 'because_missing', '没写 because（前面哪一步的什么输入产生这个结果）', { dim: 'E1', max: 0 });
    else {
      F(at, 'because', JSON.stringify(bc));
      if (bc.from === 'step') {
        const st = chain.find(y => y.ref === bc.step || y.pos === bc.step);
        if (!st) F(at, 'because_step_off_chain', `because.step ${bc.step} 不是这条预期链上的动作`, { dim: 'E1', max: 0 });
        else { const src = [st.n.op || '', ...Object.values(st.n.params || {}).map(String), ...(st.n.op_id ? expandHuman(ops, st.n.op_id, new Set(), platform) : [])];
          if (!inSrc(bc.input, src)) F(at, 'because_input_absent', `because.input「${String(bc.input || '').slice(0, 40)}」在那一步的文字 / 参数 / 操作步骤里找不到`, { dim: 'E1', max: 1 }); }
        if (oreg?.reads === 'startup-state') S(at, 'E1', 'reads_state_from_step', '观测读的是启动后状态，because 却说是某一步产生的');
      } else if (bc.from === 'state') {
        if (oreg?.reads === 'per-event') F(at, 'state_but_per_event', '观测读的是某次事件的结果，because 却说验的是启动后状态', { dim: 'E1', max: 0 });
        // 父步骤本身就是冷启动 / 启动：状态预期挂在它下面是对的，不提示
        if (chain.length && kindOf(x.n) === 'action' && !/cold-start|launch/.test(x.n.op_id || '') && !/冷启|启动/.test(x.n.op || '')) S(at, 'E1', 'state_expect_under_action', '验启动后状态的预期挂在一个动作下面（该放到前置检查）');
      } else if (bc.from !== 'artifact') F(at, 'because_bad_from', `because.from 只能是 step / state / artifact（写了 ${bc.from}）`, { dim: 'E1', max: 0 });
    }
    if (oreg?.reads === 'per-event' && !chain.length) F(at, 'per_event_no_action', '观测读的是某次事件的结果，前面却没有任何动作产生事件', { dim: 'E1', max: 0 });
    if (b?.op && !oreg?.reads) F(at, 'reads_missing', `观测操作 ${b.op} 没登记读的是什么（ops set ${b.op} --reads per-event|startup-state|config|artifact）`, { dim: 'E1', max: 2 });
    // E2：怎么看
    if (!see.length && !ohuman.length) F(at, 'no_see', '没写怎么看（see 为空，观测操作也没有人看步骤）', { dim: 'E2', max: 0 });
    if (/�/.test(see.join(''))) F(at, 'garbled', '怎么看里有乱码（U+FFFD）', { dim: 'E2', max: 0 });
    if (vagueNav(see.length ? see : ohuman)) S(at, 'E2', 'vague_nav', '说了进某页，没说怎么进');
    // E3：判据
    const checks = b?.checks || [];
    if (e.judge !== 'human') { if (!checks.length) F(at, 'no_checks', '没有机器判据', { dim: 'E3', max: 0 });
      else F(at, 'checks', checks.map((ch, i) => `#${i} ${ch.pick || ''} ${JSON.stringify(ch.predicate || {})}${ch.say ? `（${ch.say}）` : ''}`).join('；')); }
    if (oreg?.input === 'real' && inputs.get(at) === 'injected') F(at, 'observe_trigger_conflict', `观测 ${b.op} 读的是真实事件，这条预期链上却是注入`, { dim: 'E3', max: 1 });
    { const lit = JSON.stringify(checks.map(ch => ch.predicate || {})).match(/\d{12,}/);
      if (lit && inputs.get(at) !== 'injected') S(at, 'E3', 'fixed_id', `判据里写死了 ${lit[0]}：真实操作每次产生的 id 不一样，用 {step.<那一步>.<名>} 引用这次运行里记下的值`); }
    if (/★/.test(e.assert || '')) S(at, 'E3', 'star_in_assert', 'assert 里用「★」标核心断言：改成 role');
    if (/\d{1,2}-\d{1,2}\s*读数|读数\s*\d+/.test(`${e.assert || ''} ${see.join(' ')}`)) S(at, 'E3', 'dated_value', '判据写死了某一次的读数');
  }
  // 整条用例
  const pres = [].concat(c.preconditions || []);
  pres.forEach((p, i) => { const t = typeof p === 'string' ? p : (p.text || ''); F('case', 'precondition', `#${i} ${t}${p?.op_id ? `（@${p.op_id}）` : ''}`);
    if (!(p && typeof p === 'object' && (p.op_id || p.manual))) F('case', 'pre_no_how', `前置 #${i} 只有一句话，没写用哪个操作建立、也没写人工怎么确认`, { dim: 'C2', max: 1 });
    if (p?.op_id && !ops[p.op_id]) F('case', 'pre_op_unknown', `前置 #${i} 引用的操作 ${p.op_id} 不存在`, { dim: 'C2', max: 1 }); });
  const claims = nodes.flatMap(x => (x.n.expect || []).filter(e => roleOf(e) === 'claim').map(e => e.id));
  if (!claims.length) F('case', 'no_claim', '没有 role=claim 的预期：只有对照和前置检查', { dim: 'R1', max: 0 });
  F('case', 'claims', `验需求的预期：${claims.join('、') || '（无）'}`);
  for (const s of surfaces) F('case', 'surface', `改动面 ${s.id}：${String(s.change || '').slice(0, 200)}`);
  return { facts, signals };
}

/** 操作库里和这段文字最像的一个（带人看步骤的才算）—— 只作信号 */
function similarOp(text, ops, platform) {
  const q = grams(text); if (!q.size) return null;
  let best = null;
  for (const [id, o] of Object.entries(ops)) { if (o.kind === 'observe') continue;
    if (!expandHuman(ops, id, new Set(), platform).length) continue;
    const T = grams([id, o.title, o.why, [].concat(o.human || []).join(' ')].join(' '));
    const s = [...q].filter(g => T.has(g)).length; if (s >= 4 && (!best || s > best.s)) best = { id, title: o.title || '', s }; }
  return best;
}

// ---------- 项指纹、上限、评审包 ----------
/** 一项依赖的内容：变了这一项就过期（只作废它，不连坐别的项） */
export function itemFp(c, item, ctx) {
  const { ops = {}, platform = null, sets = {}, nameState = () => 'unknown', inputs = new Map(), surfaces = [] } = ctx;
  const ver = { r: RUBRIC_VERSION, x: EXTRACTOR_VERSION, dim: item.dim };
  const nodes = walk(c), x = nodes.find(y => y.ref === item.at || (item.on === 'expect' && (y.n.expect || []).some(e => e.id === item.at)));
  if (item.on === 'action' || item.on === 'group') {
    const n = x.n, human = n.op_id ? expandHuman(ops, n.op_id, new Set(), platform) : [];
    return sha({ ver, node: nodeProj(n), human, reg: n.op_id ? { kind: ops[n.op_id]?.kind || null, input: ops[n.op_id]?.input || null } : null,
      // 界面字查得到没有不进指纹（看板 / next 不搜代码）：被测代码变了让上限掉下来的，状态比对「分数 > 现在的上限」算过期
      cfg: (n.config || []).map(id => sets[id] || null),
      kids: item.on === 'group' ? [(n.children || []).length, (n.expect || []).map(e => e.id)] : null });
  }
  if (item.on === 'expect') {
    const e = x.n.expect.find(y => y.id === item.at), b = obsOf(e), o = b?.op ? ops[b.op] : null;
    return sha({ ver, chain: [...x.chain, x].map(y => nodeProj(y.n)), e: stripVol(e), oreg: o ? { reads: o.reads || null, input: o.input || null, human: expandHuman(ops, b.op, new Set(), platform) } : null, from: inputs.get(item.at) || null });
  }
  if (item.dim === 'C1') return sha({ ver, skel: nodes.map(y => [y.pos, kindOf(y.n), (y.n.children || []).length, (y.n.expect || []).map(e => e.id)]) });
  if (item.dim === 'C2') return sha({ ver, pre: c.preconditions || [] });
  return sha({ ver, roles: nodes.flatMap(y => (y.n.expect || []).map(e => [e.id, roleOf(e), e.demand_ref || null])), surfaces: surfaces.map(s => s.id) });
}
export const capOf = (item, facts) => Math.min(3, ...facts.filter(f => f.hard && f.hard.dim === item.dim && (f.at === item.at || (f.at === 'case' && item.at === 'case'))).map(f => f.hard.max));

/** 一条用例的评审包内容：每项带上限、决定上限的事实、必答信号、指纹 */
export function caseCard(c, ctx) {
  const { facts, signals } = collectFacts(c, ctx);
  const items = itemsOf(c).map(it => {
    const capFacts = facts.filter(f => f.hard && f.hard.dim === it.dim && f.at === it.at).map(f => f.id);
    return { ...it, cap: capOf(it, facts), cap_facts: capFacts, signals: signals.filter(s => s.at === it.at && s.dim === it.dim).map(s => s.id), fp: itemFp(c, it, ctx) };
  });
  return { case: c.case, title: c.title || '', platform: ctx.platform || null, rubric: RUBRIC_VERSION, facts, signals, items };
}
export const rubricForCard = () => Object.fromEntries(Object.entries(DIMS).map(([k, d]) => [k, { name: d.label, question: d.question, levels: d.levels, restate: d.restate }]));

// ---------- 核对一行提交 ----------
const RANK = { real: 0, 'mock-global': 1, unknown: 2, injected: 3 };
/** 一行提交 → null（通过）或拒收的一句话。card：caseCard 的结果；c：当前用例；ctx 同 collectFacts */
export function checkLine(line, card, c, ctx) {
  const { ops = {}, platform = null } = ctx;
  const it = card.items.find(x => x.key === line.key);
  if (!it) return `评审包里没有这一项 ${line.key}`;
  if (line.fp !== it.fp) return '这一项的内容在出包之后变了：先重新打包（assess --pack）再评';
  const sc = line.score;
  if (!Number.isInteger(sc) || sc < 0 || sc > 3) return 'score 要是 0–3 的整数';
  if (sc > it.cap) return `score ${sc} 高过上限 ${it.cap}（${it.cap_facts.map(id => card.facts.find(f => f.id === id)?.text).filter(Boolean).join('；')}）：上限由事实定，不能越过；觉得事实错了就改数据（clarify / ops set）`;
  if (!String(line.reason || '').trim()) return '缺 reason（为什么给这个分）';
  const scope = new Set(card.facts.filter(f => it.on === 'case' || f.at === it.at || f.at === 'case' || (it.on === 'expect' && f.at === it.pos)).map(f => f.id));
  // 预期可以引用链上动作的事实（因果要看那一步）
  if (it.on === 'expect') { const x = walk(c).find(y => (y.n.expect || []).some(e => e.id === it.at)); for (const y of [...x.chain, x]) for (const f of card.facts) if (f.at === y.ref) scope.add(f.id); }
  const ev = [].concat(line.evidence || []);
  if (!ev.length) return 'evidence 至少引用一条事实 id（f…）';
  const off = ev.filter(id => !scope.has(id)); if (off.length) return `evidence 里 ${off.join('、')} 不是这一项范围内的事实`;
  const sigs = it.signals, rul = new Map([].concat(line.rulings || []).map(r => [r.signal, r]));
  for (const sid of sigs) { const r = rul.get(sid); const s = card.signals.find(y => y.id === sid);
    if (!r || !['accept', 'dismiss'].includes(r.ruling)) return `信号 ${sid}（${s?.text}）没回答：给 { signal, ruling: accept|dismiss, why, evidence }`;
    if (r.ruling === 'dismiss' && !([].concat(r.evidence || []).some(id => scope.has(id)) && String(r.why || '').trim())) return `驳回信号 ${sid} 要写 why，并引用一条本项范围内的反证事实`; }
  if (sc < 3) { const fx = String(line.fix || '').trim();
    if (!/^acceptkit (clarify|ops set|configset set) \S+/.test(fx)) return '不到 3 分要写 fix：一条能执行的 acceptkit clarify / ops set / configset set 命令';
    if (/^acceptkit clarify /.test(fx) && !fx.startsWith(`acceptkit clarify ${c.case} `) && fx !== `acceptkit clarify ${c.case}`) return `fix 里 clarify 的用例名要是 ${c.case}`;
    if (fx.startsWith(`acceptkit configset set ${c.case} `)) return `configset set 的第一个参数是配置集 id，不是用例名；改前置条件用 acceptkit clarify ${c.case} --precondition-set <序号|new> --text … --how op:<操作>|manual --why …`; }
  const bad = checkExtract(it, line.extract, c, ctx);
  if (bad) return `复述不过：${bad}`;
  // 复述出来的事实也约束分数
  // 一件主动作 + 一个防御性小前提（2 分档）是两项；三项以上才是塞了好几件事
  if (it.dim === 'A4' && [].concat(line.extract?.actions || []).length > 2 && sc > 1) return `你数出 ${line.extract.actions.length} 个动作：一步一事最多 1 分`;
  if (it.dim === 'A4' && [].concat(line.extract?.actions || []).length === 2 && sc > 2) return '你数出 2 个动作：一步一事最多 2 分';
  if (it.dim === 'A3' && line.extract?.from === 'unknown' && sc > 1) return '来源说不清最多 1 分';
  if (it.dim === 'E3' && [].concat(line.extract?.map || []).some(m => m.check === null) && sc > 2) return '有主张没有判据：判据对得上最多 2 分';
  if (it.dim === 'R1' && [].concat(line.extract?.map || []).some(m => m.expect === null) && sc > 1) return '有改动面没有预期在验：验到需求最多 1 分';
  if (it.dim === 'C2' && [].concat(line.extract?.missing || []).length && sc > 1) return '有依赖的前提没登记：前置可建立最多 1 分';
  return null;
}

/** 复述核对：值要出现在规定的原文里（压掉空白和「」后逐字包含） */
export function checkExtract(it, x, c, ctx) {
  const { ops = {}, platform = null, sets = {}, inputs = new Map() } = ctx;
  if (!x || typeof x !== 'object') return '缺 extract';
  const nodes = walk(c);
  if (it.on === 'action') {
    const n = nodes.find(y => y.ref === it.at).n, human = n.op_id ? expandHuman(ops, n.op_id, new Set(), platform) : [];
    const src = [n.op || '', ...human, ...fillHuman(human, n.params || {}), ...Object.entries(n.params || {}).flatMap(([k, v]) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return [s, `${k}=${s}`]; }), JSON.stringify(n.params || {}), ...(n.config || []).flatMap(id => (sets[id]?.items || []).map(i => `${i.key}=${i.value}`))];
    if (it.dim === 'A1') {
      if (!(x.where && (x.where.app === true || inSrc(x.where, src)))) return 'where 要是原文（步骤 / 操作步骤 / 参数）里的字，或 { app: true }';
      if (!inSrc(x.do, src)) return 'do 要是原文里的字';
      if (!(x.input && ((x.input.none === true && String(x.input.why || '').trim()) || inSrc(x.input, src)))) return 'input 要是原文里的字，或 { none: true, why }';
      return null;
    }
    if (it.dim === 'A2') {
      const d = String(x.decision || ''); if (!String(x.why || '').trim()) return 'A2 要写 why';
      const m = d.match(/^ref:(.+)$/);
      if (m) { const o = ops[m[1]]; if (!o) return `ref 的操作 ${m[1]} 不存在`; if (o.kind === 'observe') return `ref 的 ${m[1]} 是观测类操作`; if (!expandHuman(ops, m[1], new Set(), platform).length) return `ref 的 ${m[1]} 在本平台没有人看步骤`; return null; }
      return d === 'new-op' || d === 'inline' ? null : 'decision 只能是 ref:<操作> / new-op / inline';
    }
    if (it.dim === 'A3') {
      const si = stepInput(n, ops); if (!(x.from in RANK)) return 'from 只能是 real / mock-global / injected / unknown';
      if (RANK[x.from] < RANK[si.from]) return `from 不能比工具算的（${si.from}）更好`;
      return String(x.why || '').trim() ? null : 'A3 要写 why';
    }
    if (it.dim === 'A4') { const a = [].concat(x.actions || []); if (!a.length) return 'actions 至少一项'; const off = a.find(v => !inSrc(v, src)); return off ? `actions 里「${off}」不是原文里的字` : null; }
    if (it.dim === 'A5') return Array.isArray(x.deps) ? null : 'deps 要是数组（没有依赖写 []）';
  }
  if (it.on === 'expect') {
    const x0 = nodes.find(y => (y.n.expect || []).some(e => e.id === it.at)), e = x0.n.expect.find(y => y.id === it.at), b = obsOf(e);
    if (it.dim === 'E1') return canon(x.because) === canon(e.because) ? null : 'because 要原样复述用例里的 because（用例里没有就先 clarify 写进去）';
    if (it.dim === 'E2') { const oh = b?.op ? expandHuman(ops, b.op, new Set(), platform) : [], see = [].concat(e.see || []), src = [...see, see.join(' → '), ...oh, ...fillHuman(oh, b?.params || {}), fillHuman(oh, b?.params || {}).join(' → ')];
      for (const k of ['page', 'row', 'pass_when']) if (!inSrc(x[k], src)) return `${k} 要是 see 或观测操作步骤里的字`; return null; }
    if (it.dim === 'E3') { const checks = b?.checks || [], map = [].concat(x.map || []);
      if (e.judge === 'human') return null;
      if (!map.length) return 'map 至少一项：assert 里的主张对应哪条 check';
      for (const m of map) { if (!inSrc(m.claim, [e.assert || '', e.detail || ''])) return `claim「${String(m.claim).slice(0, 30)}」不是 assert 里的字`;
        if (m.check === null) continue;   // 这个主张没有判据
        if (!Number.isInteger(m.check) || m.check < 0 || m.check >= checks.length) return `check 序号 ${m.check} 不存在（共 ${checks.length} 条；这个主张没有判据就写 null）`; }
      return typeof x.same === 'boolean' ? null : 'same 要写 true / false'; }
  }
  if (it.on === 'group') return typeof x.is_title === 'boolean' ? null : 'is_title 要写 true / false';
  if (it.dim === 'C1') return Array.isArray(x.issues) ? null : 'issues 要是数组（没有写 []）';
  if (it.dim === 'C2') { const pre = [].concat(c.preconditions || []), a = [].concat(x.pre || []);
    if (x.missing != null && !Array.isArray(x.missing)) return 'missing 要是数组';
    if (a.length !== pre.length) return `pre 要和前置条件一一对应（${pre.length} 条）`;
    for (const p of a) { const m = String(p.how || '').match(/^op:(.+)$/); if (!(m || p.how === 'manual')) return 'how 只能是 op:<操作> / manual'; if (m && !ops[m[1]]) return `操作 ${m[1]} 不存在`; if (!String(p.why || '').trim()) return 'pre 每项要写 why'; }
    return null; }
  if (it.dim === 'R1') { const ids = new Set(nodes.flatMap(y => (y.n.expect || []).filter(e => roleOf(e) === 'claim').map(e => e.id)));
    const m = [].concat(x.map || []); if (!m.length) return 'map 至少一项'; const off = m.find(v => v.expect !== null && !ids.has(v.expect)); return off ? `${off.expect} 不是 role=claim 的预期（改动面没有预期在验就写 expect: null）` : null; }
  return null;
}

// ---------- 状态与门槛 ----------
/**
 * 当前项 + 库里的记录 → 状态。records：[{ ikey, score, item_fp, by, at }]（每个 ikey 各 by 取最新）
 * lastRunAt：这条用例最近一次执行的时间（跑过之后 A1 / E2 为 2 的项要补到 3）
 */
export function reviewState(card, records, { lastRunAt = null, mode = 'run', liveCaps = true } = {}) {
  const want = mode === 'probe' ? card.items.filter(i => i.dim === 'A1' || i.dim === 'E2') : card.items;
  const out = want.map(it => {
    const blind = records.find(r => r.ikey === it.key && r.by === 'blind'), self = records.find(r => r.ikey === it.key && r.by !== 'blind');
    const rec = blind || self;
    if (!rec) return { ...it, state: 'missing' };
    if (rec.item_fp !== it.fp) return { ...it, state: 'stale', score: rec.score, reason: rec.reason, fix: rec.fix };
    if (liveCaps && rec.score > it.cap) return { ...it, state: 'stale', score: rec.score, reason: `上限变了（现在 ${it.cap}）：${rec.reason || ''}`, fix: rec.fix };
    if (!blind) return { ...it, state: 'draft', score: rec.score, reason: rec.reason, fix: rec.fix };
    const base = { ...it, score: blind.score, reason: blind.reason, fix: blind.fix, by: blind.by };
    if (lastRunAt && (it.dim === 'A1' || it.dim === 'E2') && blind.score === 2 && blind.at < lastRunAt) return { ...base, state: 'ran' };
    const soft = it.on === 'expect' && (it.dim === 'E2' || it.dim === 'E3') && it.role === 'control';
    if (blind.score < GATE_MIN) return { ...base, state: soft && blind.score >= 1 ? 'warn' : 'low' };
    return { ...base, state: 'ok' };
  });
  const n = s => out.filter(x => x.state === s).length;
  const status = n('missing') ? 'incomplete' : n('stale') ? 'stale' : n('low') || n('ran') ? 'fail' : n('draft') ? 'draft' : 'pass';
  return { status, items: out, counts: { missing: n('missing'), stale: n('stale'), draft: n('draft'), low: n('low'), ran: n('ran'), warn: n('warn'), ok: n('ok') } };
}
export const STATUS_LABEL = { pass: '评审通过', fail: '评审未过', stale: '评审过期（用例改过）', draft: '只有自评、没有盲审', incomplete: '评审不完整' };
