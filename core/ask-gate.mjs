// 提问闸：要 owner 回答的事只有一个入口（acceptkit ask，plan finding / blockers --ask 也过同一道检查），入口先判该不该问。
// 起因：执行者在聊天里反复问 owner「能不能在共享模拟器上登录测试账号」，项目知识里早写了「测试账号登录由执行者自己做，不问 owner」——
// 聊天里的提问不经过任何闸、也不查知识，每轮还重复问。owner：「这种问题不应该问我」。
//
// 判法（只按形状和项目自己写的规则，不认业务词）：
//   1. 项目知识里写着「不问 owner」性质的规则（knowledge/*.md 里带 #executor-owns，或写着不问 owner / 别问我 / 由执行者自己…的行），和问题说的是一件事 → 拒收，给规则原文和出处
//   2. 同一件事答过（评审单里定了的 finding、答过的阻塞、答过的提问）→ 拒收，给原答复
//   3. 通用的「执行者自己的活」：登录已登记的测试账号、本 run 占着的设备上的操作、app 自带调试页的 mock、重试 / 换取证手段、自己工具的毛病 → 拒收；
//      执行者确认这件事真不是自己能定的，写 --not-mine 说清为什么（记下来，owner 看得到）
//   4. 只放行四类：改产品行为或验收范围 / 动别人的资源或排期 / 对外发布或不可逆操作 / 接受风险。放行的要带上下文、选项和后果、推荐
// 台账在项目数据目录 state/asks/<需求>.json。
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const ASK_KINDS = { behavior: '改产品行为或验收范围', others: '动别人的资源或排期', irreversible: '对外发布或不可逆的操作', risk: '接受一个风险' };
export const EXECUTOR_OWNS = [
  { id: 'account', match: /登录|登陆/, unless: /(给|申请|开通|新建|没有|缺)[^，。]{0,6}(账号|帐号|测试号)|本人身份|单点登录|SSO/i, say: '登录已登记的测试账号是你的活：acceptkit account get 取值自己登，不问 owner；只有必须本人身份（如员工单点登录）才问' },
  { id: 'device', match: /模拟器|真机|设备|装包|安装包|卸载|重启|冷启|清(缓存|数据)/, say: '本 run 占着的设备上的操作是你的活；装卸包、清数据走 acceptkit gate 过闸（闸会告诉你哪种要问人）' },
  { id: 'debug-mock', match: /调试页|debug|mock|\bAB\b|开关值|下发值/i, say: 'app 自带调试页上 mock 全局信号 / AB 是你的活：登记成配置集（acceptkit configset set … --kind mock --why …）后自己做' },
  { id: 'retry', match: /重试|重跑|再跑一|换(个|一种)?(方法|手段|观测|取证|读法)/, say: '重试、换取证手段是你的活：照 acceptkit next / consult 做' },
  { id: 'tool', match: /(acceptkit|工具|脚本).{0,8}(bug|坏了|报错|有问题|不好使)/i, say: '自己工具的毛病是你的活：修掉或登记成装置故障（acceptkit apparatus），不问 owner' },
];
// 项目知识里「不问 owner」性质的规则
const OWNS_LINE = /#executor-owns|不问\s*owner|不要问\s*owner|不用问\s*owner|别问我|不应该问我|由执行者自己|执行者自己做/i;

// 说的是不是一件事：英文词（2 字以上）+ 中文两字组合的重合数。只看形状
const STOP2 = new Set(['执行', '问题', '是否', '可以', '能不', '不能', '一下', '这个', '那个', '我们', '你们', '需要', '要不', '不要', '自己', '用户', '确认', '的话', '现在', '时候']);
export function grams(t) {
  const s = String(t || '').toLowerCase(), out = new Set();
  for (const w of s.match(/[a-z][a-z0-9_]{1,}/g) || []) out.add(w);
  for (const run of s.match(/[一-龥]+/g) || []) for (let i = 0; i + 1 < run.length; i++) { const g = run.slice(i, i + 2); if (!STOP2.has(g)) out.add(g); }
  return out;
}
const shared = (a, b) => { const B = grams(b); return [...grams(a)].filter(g => B.has(g)); };
// 规则管的是哪个动作：规则里写了动作词，问题里也得是这个动作才算一件事（「测试账号登录由执行者做」管登录，不管「要不要找业务方要账号类策略的入口」）
const ACTIONS = ['登录', '登陆', '安装', '装包', '卸载', '重启', '冷启', '重试', '重跑', '截图', '录屏', '切换', '注入', 'mock', '下发', '清数据', '清缓存', '授权', '开通', '申请', '抓包', '编译', '构建', '打包', '发布', '回滚'];
const actionsOf = t => ACTIONS.filter(a => String(t).toLowerCase().includes(a));

/** 项目知识里的「不问 owner」规则 → [{ text, ref }] */
export function ownsRules(root) {
  const dir = join(root, 'knowledge'), out = [];
  let fs = []; try { fs = readdirSync(dir).filter(f => f.endsWith('.md')); } catch { return out; }
  for (const f of fs) { let L = []; try { L = readFileSync(join(dir, f), 'utf8').split('\n'); } catch { continue; }
    L.forEach((l, i) => { if (OWNS_LINE.test(l)) out.push({ text: l.replace(/^\s*[-*]\s*/, '').trim(), ref: `knowledge/${f}:${i + 1}` }); }); }
  return out;
}

// ── 台账 ──
const askPath = (root, D) => join(root, 'state', 'asks', `${D}.json`);
export const loadAsks = (root, D) => { try { return JSON.parse(readFileSync(askPath(root, D), 'utf8')); } catch { return []; } };
const saveAsks = (root, D, xs) => { mkdirSync(join(root, 'state', 'asks'), { recursive: true }); writeFileSync(askPath(root, D), JSON.stringify(xs, null, 1) + '\n'); };

/** 答过的：评审单里定了的 finding、答过的阻塞、答过的提问 → [{ ref, q, a }] */
function answered(root, D, plan, blockers) {
  return [
    ...(plan?.findings || []).filter(f => f.decision).map(f => ({ ref: f.id, q: `${f.what || ''} ${f.decide || ''}`, a: `${f.decision}（${f.decided_by || ''}）` })),
    ...(blockers || []).filter(b => b.answer).map(b => ({ ref: b.id, q: `${b.ask?.question || ''} ${b.text || ''} ${b.unlock || ''}`, a: `${b.answer}（${b.answered_by || ''}）` })),
    ...loadAsks(root, D).filter(x => x.status === 'answered').map(x => ({ ref: x.id, q: x.question, a: `${x.answer?.quote || ''}（${x.answer?.by || ''}）` })),
  ];
}

/**
 * 该不该问 → { ok: true } | { ok: false, why, ref?, text? }。
 * notMine = 执行者说这件事真不是自己能定的理由（只能越过通用清单，越不过项目规则和已答）
 */
export function askCheck(root, D, question, { plan = null, blockers = [], notMine = '' } = {}) {
  const mine = String(notMine || '').trim().length >= 8;
  // 说的是一件事：重合 4 个词以上，或 3 个且占问题的三成（只重合「测试账号」这种泛词的不算 —— 要新账号和登录已有账号是两回事）
  const qn = grams(question).size || 1;
  for (const r of ownsRules(root)) {
    const s = shared(question, r.text);
    if (!(s.length >= 4 || (s.length >= 3 && s.length / qn >= 0.3))) continue;
    const acts = actionsOf(r.text); if (acts.length && !acts.some(a => actionsOf(question).includes(a))) continue;
    // 执行者确认不是这条规则管的事：写理由放行，理由连同越过的规则一起给 owner 看
    if (mine) return { ok: true, overrode: r.ref, overrode_text: r.text };
    return { ok: false, why: 'project_rule', ref: r.ref, text: r.text, msg: `这是你的活，项目里写过不问 owner：「${r.text}」（${r.ref}）。真不是这条规则管的事，加 --not-mine "<为什么不是>" 再提（理由和这条规则会一起给 owner 看）` };
  }
  const qg = grams(question).size || 1;
  for (const x of answered(root, D, plan, blockers)) {
    const s = shared(question, x.q);
    if (s.length >= 3 && s.length / qg >= 0.4) return { ok: false, why: 'answered', ref: x.ref, text: x.a, msg: `这件事 ${x.ref} 已经答过：${x.a}。照答复做；情况真变了，在 ${x.ref} 上说清变了什么` };
  }
  // 要一个还没有的账号、要本人身份登录：不是执行者的活（unless）
  const own = EXECUTOR_OWNS.find(o => o.match.test(question) && !(o.unless && o.unless.test(question)));
  if (own && !mine)
    return { ok: false, why: 'executor_owns', ref: own.id, text: own.say, msg: `${own.say}。这件事真不是你能定的，加 --not-mine "<为什么只有 owner 能定>" 再提（理由会给 owner 看）` };
  return { ok: true, ...(own ? { overrode: own.id } : {}) };
}

/** 放行的问题要能拍板：上下文、为什么只有 owner 能定、至少两个选项（做法 => 后果）、推荐 */
export function askShapeProblems(a) {
  const out = [];
  if (!ASK_KINDS[a.kind]) out.push(`--kind 只能是 ${Object.entries(ASK_KINDS).map(([k, v]) => `${k}（${v}）`).join(' / ')}；不属于这四类的不问 owner`);
  if (String(a.question || '').trim().length < 6) out.push('--question 写清要他定什么');
  if (String(a.context || '').trim().length < 10) out.push('--context 写清来龙去脉：他不看别的也能懂');
  if (String(a.why_you || '').trim().length < 6) out.push('--why-you 写清为什么只有他能定');
  const opts = [].concat(a.options || []);
  if (opts.length < 2 || opts.some(o => !/=>/.test(o))) out.push('--option 至少两个，写成「做法 => 后果」');
  if (String(a.recommend || '').trim().length < 4) out.push('--recommend 写你推荐哪个、为什么');
  return out;
}

export function addAsk(root, D, a) {
  const xs = loadAsks(root, D), id = `Q${xs.length + 1}`;
  xs.push({ id, status: 'open', at: new Date().toISOString(), ...a });
  saveAsks(root, D, xs); return xs.at(-1);
}
export function answerAsk(root, D, id, { by, quote, option = null }) {
  if (!by || !String(quote || '').trim()) throw new Error('答复只认 owner 本人：要 --by <他> --quote "<原话>"');
  const xs = loadAsks(root, D), x = xs.find(y => y.id === id); if (!x) throw new Error(`${D} 里没有提问 ${id}`);
  Object.assign(x, { status: 'answered', answer: { by: String(by), quote: String(quote), ...(option ? { option: String(option) } : {}), at: new Date().toISOString() } });
  saveAsks(root, D, xs); return x;
}
export function withdrawAsk(root, D, id, why) {
  if (String(why || '').trim().length < 4) throw new Error('撤回要写 --why（例：查到项目知识里写过，这是我的活）');
  const xs = loadAsks(root, D), x = xs.find(y => y.id === id); if (!x) throw new Error(`${D} 里没有提问 ${id}`);
  Object.assign(x, { status: 'withdrawn', withdrawn: { why: String(why), at: new Date().toISOString() } });
  saveAsks(root, D, xs); return x;
}

// 回复里的「等 owner」句子（宿主停钩子用）：带了提问编号（Q / F / B + 数字）的算已走入口
export const WAIT_OWNER = /(等你|要你|需要你|请你|麻烦你)(确认|定|决定|拍板|回复|答复|选|批)|你(看|觉得)(要不要|行不行|可不可以|是否)|要不要我[^。\n]{0,20}[？?]|(可以|行)吗[？?]|能不能[^。\n]{0,16}[？?]/;
export const HAS_ASK_ID = /\b[QFB]\d+\b/;
export { existsSync as _exists };
