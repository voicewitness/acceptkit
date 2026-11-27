// 触发方式：一条结论是被什么输入触发出来的。这是操作树上「做了什么」的属性，不是证据的属性 ——
// 输入是假的，判得再准也只证明「输入对了判定就对」，跟单测没有区别。
//   real        经真实用户 / app 路径触发（包括 app 自带工具发出的真实请求）：输入由被测系统自己组装
//   mock-global 只 mock 全局信号（全局特征、AB / 配置值），输入仍由被测系统自己组装；要写为什么
//   injected    把构造好的事件 / 输入直接交给判定入口，绕过了被测系统自己组装输入的那一段
// 组装那一段恰恰常出缺陷（实测：注入的事件里直接写好了一个调用点字段，三轮全过；真实流量里这个字段算不出来，整条链路不生效）。
//
// 一条断言的触发方式 = 从根到它所在节点的每一步，加上观测用的操作（有的观测操作自己就喂输入）、断言自己的声明，取最假的。
// 不知道就不算真实（fail-closed）：某一步说不清怎么触发，这条断言就是「说不清」，不能拿来证明真实路径。
// 每一步怎么触发，按顺序认：节点上写的 input → 节点 op_id 在操作库里登记的 input → 节点文字 / 数据里手写了输入字段（{k=v} / {"k":…}）就是在构造输入，算注入
// → 用例上整体写的 input（只补说不清的）→ 说不清。
// 基建只认形状：哪个操作喂哪种输入由项目登记（ops set <op> --input …），字段名、入口名一概不认。
export const INPUTS = { real: '真实路径触发', 'mock-global': '只 mock 全局信号', injected: '构造好的输入直接交给判定入口' };
// 说不清排在 mock-global 和 injected 之间：比只 mock 全局更不可信，但没有证据说它是注入
const RANK = { real: 0, 'mock-global': 1, unknown: 2, injected: 3 };
// tool = 操作自己的参数（打到哪个入口、用哪个编号），不进被测系统的输入：不算 mock，但要写清为什么不是输入的一部分
const MOCK_SCOPES = ['global', 'call-site', 'tool'];

const declaredOf = x => typeof x?.input === 'string' ? { from: x.input } : (x?.input && typeof x.input === 'object' ? x.input : null);
const bindingOps = o => !o ? [] : o.by ? Object.values(o.by).map(b => b?.op).filter(Boolean) : o.op ? [o.op] : [];
const worst = xs => xs.reduce((a, b) => RANK[b] > RANK[a] ? b : a, 'real');

// 手写的输入字段：{…} 里的 key=value / "key": value。只按形状认
const BRACE = /\{[^{}]{3,400}\}/g, KEY = /(?<![A-Za-z0-9_.\-])["']?([A-Za-z_][A-Za-z0-9_.\-]*)["']?\s*[=:]/g;
export function literalFields(text) {
  const out = new Set();
  for (const b of String(text || '').match(BRACE) || []) { if (/\{param\./.test(b)) continue; for (const m of b.matchAll(KEY)) out.add(m[1]); }
  return [...out];
}
const objOf = v => { if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  if (typeof v === 'string' && /^\s*\{/.test(v) && !/\{param\./.test(v)) { try { const o = JSON.parse(v); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch { return null; } } return null; };
const observeFields = e => (!e.observe ? [] : e.observe.by ? Object.values(e.observe.by) : [e.observe]).flatMap(b => Object.values(b?.params || {}).flatMap(v => Object.keys(objOf(v) || {})));

/** 一步怎么触发 → { from: real|mock-global|injected|unknown, by: declared|op|literal|none, fields, decl } */
export function stepInput(n, ops = {}, caseDefault = null) {
  // 参数单列（params）以后，手写的字段多半在参数里：非真实步骤的参数键就是替系统填的字段
  const d = declaredOf(n), fields = [...new Set([...literalFields(`${n.op || ''}\n${n.data ? JSON.stringify(n.data) : ''}`), ...Object.keys(n.params || {})])];
  if (d?.from && INPUTS[d.from]) return { from: d.from, by: 'declared', fields, decl: d };
  const o = n.op_id && ops?.[n.op_id]?.input;
  if (INPUTS[o]) return { from: o, by: 'op', op: n.op_id, fields, decl: d };
  if (fields.length) return { from: 'injected', by: 'literal', fields, decl: d };
  // 用例上整体声明的（例：整条用例都在真实界面上点）：只补说不清的步骤，压不过登记成注入的操作和手写字段
  if (caseDefault?.from && INPUTS[caseDefault.from]) return { from: caseDefault.from, by: 'case', fields, decl: d };
  return { from: 'unknown', by: 'none', fields, decl: d };
}

/** 操作树上每一步（带编号 n1 / n1.2）和它所在的链 */
export function walkSteps(tree, cb, prefix = 'n', chain = []) {
  (tree || []).forEach((n, i) => { const id = `${prefix}${i + 1}`, ch = [...chain, { id, n }]; cb({ id, n, chain: ch }); walkSteps(n.children, cb, `${id}.`, ch); });
}

/** 一条断言的触发方式。chain = 从根到它所在节点的 [{ id, n }] */
export function inputOfExpect(e, chain, ops = {}, caseDefault = null, cfgMocks = []) {
  const d = declaredOf(e);
  // 分组标题（group）不是一步操作，只是把几条预期归到一个标题下：不算进链，否则挂在分组下的预期永远「说不清」
  const steps = chain.filter(({ n }) => n.kind !== 'group').map(({ id, n }) => ({ id, op: String(n.op || '').slice(0, 60), ...stepInput(n, ops, caseDefault) }));
  const opIn = bindingOps(e.observe).map(op => ({ op, input: ops?.[op]?.input })).filter(x => INPUTS[x.input]);
  // 断言自己声明了，替它链上说不清的那几步作答（声明是写在用例里、评审时看得到的）；手写字段 / 登记成注入的步骤压不过去
  const stepFroms = steps.map(s => s.from === 'unknown' && d?.from && INPUTS[d.from] ? d.from : s.from);
  // 配置集里 mock 的全局信号：整条链至少是「只 mock 全局信号」（配置集登记时已逐项写了 why）
  const from = worst([...stepFroms, ...opIn.map(x => x.input), ...(d?.from && INPUTS[d.from] ? [d.from] : []), ...(cfgMocks.length ? ['mock-global'] : [])]);
  const mocks = [...cfgMocks.map(x => ({ field: x.key, scope: 'global', why: x.why })), ...steps.flatMap(s => [].concat(s.decl?.mocks || [])), ...[].concat(d?.mocks || [])];
  const research = d?.research || [...steps].reverse().find(s => s.decl?.research)?.decl.research || null;
  const twin = d?.real_twin || [...steps].reverse().find(s => s.decl?.real_twin)?.decl.real_twin || null;
  // 只 mock 全局信号的步骤（例：调试页 mock 一个开关），参数就是「mock 哪个全局信号、成什么值」，本来就是全局的，不算替系统填的调用点字段
  // 真实触发的步骤里写的是这次真实请求 / 操作自己的内容（选哪个网址、带什么请求头），由真实链路组装进系统，不是替系统填的字段：不要求说清 scope
  // 观测参数同理：整条链是真实触发（或只 mock 全局信号）、观测操作也没登记成注入时，参数是这次真实请求自己的内容
  const realChain = from === 'real' || from === 'mock-global';
  const obsFields = observeFields(e), fields = [...new Set([...steps.filter(s => s.from === 'injected' || s.from === 'unknown').flatMap(s => s.fields), ...(realChain ? [] : obsFields)])];
  // 自己声明「真实」却没写 why、又带着字段的：一句声明不能把字段全放过
  const realLiteral = steps.filter(s => s.from === 'real' && s.by === 'declared' && !String(s.decl?.why || '').trim())
    .map(s => ({ id: s.id, fields: [...s.fields, ...(realChain ? obsFields : [])] })).filter(s => s.fields.length);
  return { from, steps, realLiteral, ops: opIn, declared: d?.from || null, why: String(d?.why || steps.find(s => s.decl?.why)?.decl.why || (cfgMocks.length ? `配置集里 mock 了 ${cfgMocks.map(x => x.key).join('、')}` : '')).trim(), mocks, research, twin, fields };
}

/** 用例里每条断言的触发方式 → [{ id, assert, node, ...inputOfExpect }]。sets = 配置集（ops/configs.json），不给就不算配置 */
import { chainConfigIds } from './configsets.mjs';
export function caseInputs(c, ops = {}, sets = null) {
  const out = [];
  walkSteps(c.tree, ({ id, n, chain }) => {
    const cfgMocks = !sets ? [] : chainConfigIds(c.config, chain.map(x => x.n)).flatMap(k => (sets[k]?.items || []).filter(it => it.kind === 'mock'));
    (n.expect || []).forEach(e => out.push({ id: e.id, assert: e.assert, node: id, e, ...inputOfExpect(e, chain, ops, declaredOf(c), cfgMocks) }));
  });
  return out;
}
/** 只看一条断言（engine 的 allExpects 拿不到链时）：在用例里找到它 */
export const inputOf = (c, eid, ops) => caseInputs(c, ops).find(x => x.id === eid) || null;

/** 真实对照：real，或只 mock 了全局信号的 mock-global（例：某一档开关在测试设备上只能靠配置切过去） */
export const countsAsReal = x => !!x && (x.from === 'real' || (x.from === 'mock-global' && !x.mocks.some(m => m.scope === 'call-site')));

/** input 字段的形状问题（写错了就跟没写一样）；x = 断言或节点 */
export function inputShapeProblems(x, ids, where = 'input') {
  const d = declaredOf(x); if (!d) return [];
  const out = [];
  if (d.from && !INPUTS[d.from]) out.push(`${where}.from 只能是 ${Object.keys(INPUTS).join(' / ')}（写了 ${d.from}）`);
  for (const m of [].concat(d.mocks || [])) {
    if (!m?.field) out.push(`${where}.mocks 每项要写 field（mock 了哪个字段）`);
    else if (!MOCK_SCOPES.includes(m.scope)) out.push(`${where}.mocks「${m.field}」的 scope 只能是 global（全局信号）/ call-site（调用点上的字段）/ tool（操作自己的参数，不进被测系统的输入）`);
  }
  if (d.real_twin && ids && !ids.has(d.real_twin)) out.push(`${where}.real_twin 指向的 ${d.real_twin} 不在这条用例里`);
  return out;
}

// consult 的查法（用例评审时就查）：要回答的是「真实世界里这个输入从哪来、怎么让它真的发生」。工具给代码线索，执行者往上追、写测法建议，owner 定改不改
export const RESEARCH_REAL = [
  '这一步在真实世界里对应什么：用户的哪个动作、app 发出的哪类请求 / 事件，会产生这里手写的输入',
  '顺着 consult 列出的代码线索往上追：手写的字段在生产代码里哪里算出来 → 谁调了那里 → 一直追到用户动作、真实请求，或调试 / 工具代码、项目脚本里能碰到的入口。追到的入口就是真实触发这一步的办法',
  '分清手写的字段：哪些是全局信号（可以 mock，写理由），哪些是调用点上本该由系统自己算出来的（不能 mock —— 正是要验的那一段）',
  '追到了：写成测法建议交 owner 定 —— 真实情况下什么产生这个输入、代码依据、换成怎么测、能多验到哪一段；入口还不存在但能补（例：调试页里加一个走真实组装的按钮），补什么、多大工作量也写上',
  '追不到任何入口、也补不出来：在这一步写 input.research = { tried, alt, verdict: "none" }，登记 finding 交 owner 定要不要接受只验判定那一段的风险',
];
