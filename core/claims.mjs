// 断言的主张与观测层：一条断言说了几件事、每件事要在哪一层看到才算数、它的观测实际看的是哪一层。
//
// 为什么要有：断言写「拦截 + 弹窗」，观测只读了引擎判定记录里的动作名（含 fuse、alert）。工具按谓词机判通过，
// 盲审也把「决策里有 alert」当成了「弹窗出现了」—— 弹窗有没有弹、请求有没有被拦、上报有没有发，从头到尾没人看过。
// 「决策里有这个动作名」≠「执行器执行了」≠「用户看到了」≠「上报发出去了」，这几件事在不同的层上，
// 只有读到那一层的观测才证明得了那一层的主张。
//
// 这里只做能算出来的事：从断言原文里认出效果词（弹窗 / 拦截 / 上报 / 不崩 / 生效……）、查观测用的操作登记的是哪一层、
// 列出没有同层观测的主张。用例检查（Q22）、observe 机判要不要交盲审、证据缺口（claims_uncovered）、盲审包的主张清单都调这一份。

/** 观测层：操作登记 observes 时只能用这些。层的名字是固定的；每层在本项目里具体指什么、在哪看，项目在配置 quality.observePoints 里写
 *  （「真正发出的上报」在哪看、业务自己的崩溃收集口在哪，是被测系统的知识，内核猜不出来） */
export const LAYERS = {
  decision: '引擎的判定记录（命中了哪条、产出哪些动作名）',
  diag: '调试 / 诊断页、诊断命令上的读数',
  ui: '被测 app 自己的画面（用户看得到的）',
  network: '网络出口（请求发没发出去、带了什么）',
  report: '真正发出的上报 / 埋点载荷',
  crash: '崩溃记录',
  state: '运行时状态回读（配置、开关、存储、下游消费方）',
  log: '日志',
  source: '源码 / 构建产物',
  perf: '性能计量',
};

// 内核自带的通用效果词。只收中文说法：英文的 report / block 多半是判定里的动作名或 acceptkit 自己的状态词（blocked），认成效果词全是误报。
// covers = 读到哪几层算看到了这件事。项目自己的词写在配置 quality.claimWords（同形状）追加。
export const DEFAULT_CLAIM_WORDS = [
  { word: '弹窗', match: '弹窗|弹框|弹出|对话框|提示框|浮层|toast|popup|dialog|(页面|界面|画面)上?(出现|显示)', covers: ['ui'] },
  { word: '拦截', match: '拦截|拦下|熔断|阻断|丢弃|(没有?|未|不)发出', covers: ['network'] },
  { word: '上报', match: '上报|埋点|打点', covers: ['report'] },
  { word: '不崩', match: '不崩|没崩|未崩|崩溃|闪退', covers: ['crash'] },
  { word: '生效', match: '生效', covers: ['state', 'ui', 'network', 'report'] },
];
// 效果词紧挨着这些字时，说的是「判定里的动作名 / 字段」，不是效果本身（「上报动作」「action=report」「拦截名单」）
const DECISION_AFTER = /^\s{0,1}(动作|action|名单|列表|策略|决策|字段|标记|开关|配置|=|:|：|\]|」)/i;
// 效果词后面跟着这些字时，说的是一个部件（「上报环」「上报出口」「上报路径」「拦截模块」），断言在讲这个部件里的东西。
// 同一句里后面再出现这个词，也是在讲这个部件里的（「诊断上报环里每条引擎上报只记一次」），一并不算效果主张
const PART_AFTER = /^\s{0,1}(环|出口|入口|路径|链路|通道|队列|缓冲|记录|页|模块|组件|工具|类|接口|方法|函数|钩子|SDK|tap|ring|sink)/i;
// 断言自己声明不判的部分（「……这条不判」「本条不读实际上传」）：那一句里的效果词不算主张
const SELF_SCOPE = /(这条|本条|此条)(不判|不验|不管|不核|不读|不看)|不在(这条|本条)(里|中)?(判|验)/;
const DECISION_BEFORE = /(动作名?|actions?|决策(里|中)?的?|名单里?的?|=|\[|「)\s{0,1}$/i;

/** 内核自带的效果词 + 项目配置的。项目写了同名的词（word 相同）就整条换掉内核的（项目可以改它的 match / covers，或加 except） */
export function claimWordsOf(config) {
  const extra = (config?.quality?.claimWords || []).filter(w => w && w.match && Array.isArray(w.covers));
  const own = new Set(extra.map(w => w.word));
  return [...DEFAULT_CLAIM_WORDS.filter(w => !own.has(w.word)), ...extra];
}

/** 项目对每一层的说法：{ report: '经 EventReporter.reportEvent 交给上报 SDK 的那一下', … }；没写的层用内核的通用说法 */
export function observePointsOf(config) {
  const out = {};
  for (const x of config?.quality?.observePoints || []) if (x?.layer && x.means) out[x.layer] = String(x.means);
  return out;
}

/** 本项目在这一端有没有登记过读这一层的操作（观测口）。没有 = 用例写了这个效果，项目里却没人知道该去哪看 */
export function projectHasLayer(ops, layer, platform, host = null) {
  for (const id of Object.keys(ops || {})) { const l = opLayers(ops, id, platform, host); if (l?.includes(layer)) return true; }
  return false;
}

/** 用例自己补的做法（acceptkit 给调用方 AI 的通用指示）：缺观测口 / 缺内容判据时，回被测系统里查清楚、沉淀成操作，再回填用例 */
export const RESEARCH_STEPS = [
  '回到被测系统里查：这一层的出口在哪（源码里搜上报 / 拦截 / 崩溃收集的入口），什么情况下会走到，带哪些字段',
  '写成能读到它的操作，登记它读的是哪一层：acceptkit ops set <操作> --observes <层>；项目对这一层的说法写进配置：acceptkit config add quality.observePoints \'{"layer":"<层>","means":"本项目里指什么、在哪看"}\'',
  '回填用例：观测换成这个操作，判据写到字段和取值（不只「有没有」）',
  '查到的事实记进知识：acceptkit know add --heading 取证 …；用例改完 acceptkit plan recheck <需求> --why "…"（只加判据、换观测口的事后通知 owner；改了断言原文、删了判据的要 owner 认）',
];

/** 原文里的效果主张 → [{ word, covers, at }]，同一个词只报一次。off = 断言自己声明不主张的词（expect.claims_off） */
export function effectClaims(text, words = DEFAULT_CLAIM_WORDS, off = []) {
  const s = String(text || '');
  const offWords = new Set([].concat(off || []).map(x => typeof x === 'string' ? x : x?.word).filter(Boolean));
  // 按句切（。；换行）：部件说法和「这条不判」只管它所在的那一句
  const sentences = []; let at = 0;
  for (const part of s.split(/(?<=[。；;\n])/)) { sentences.push({ from: at, to: at + part.length, text: part }); at += part.length; }
  const sentenceOf = i => sentences.find(x => i >= x.from && i < x.to) || { from: 0, to: s.length, text: s };
  const out = [];
  for (const w of words) {
    if (offWords.has(w.word)) continue;
    const re = new RegExp(w.match, 'giu'), except = w.except ? new RegExp(w.except, 'iu') : null;
    const partIn = new Set();   // 这一句里这个词已经当部件讲过
    for (const m of s.matchAll(re)) {
      const sen = sentenceOf(m.index);
      const before = s.slice(Math.max(0, m.index - 6), m.index), after = s.slice(m.index + m[0].length, m.index + m[0].length + 6);
      if (PART_AFTER.test(after)) { partIn.add(sen.from); continue; }
      if (partIn.has(sen.from) || SELF_SCOPE.test(sen.text)) continue;
      if (DECISION_AFTER.test(after) || DECISION_BEFORE.test(before)) continue;
      if (except && except.test(s.slice(Math.max(0, m.index - 8), m.index + m[0].length + 8))) continue;
      out.push({ word: w.word || m[0], covers: w.covers, at: m[0] });
      break;
    }
  }
  return out;
}

/** 某个操作在某端（宿主）上观测的是哪几层；配方上写的 observes 优先于操作上的。没登记 → null */
export function opLayers(ops, opId, platform, host = null) {
  const o = ops?.[opId];
  if (!o) return null;
  // 与 ops.mjs 的 recipeFor 同口径（宿主自己的配方优先）；不 import 它：ops.mjs 要从这里取 LAYERS 校验登记
  const ps = o.platforms || {};
  const r = (host && ps[`${platform}@${host}`]) || ps[platform];
  const v = r?.observes ?? o.observes;
  if (!v) return null;
  return [].concat(v).map(String);
}

// observe 规格在某端用哪个操作（与 evidence-gate 的 bindingOf 同口径；evidence-gate 要从这里取主张清单，不反向 import）
const opOf = (o, platform) => (o?.by ? o.by[platform]?.op : o?.op) || null;

/**
 * 断言的效果主张里，有哪些没有同层的观测 → { missing: [{ word, covers }], op, layers }。
 * layers = null 表示观测用的操作没登记 observes —— 有效果主张时，这本身就是缺口（不知道它看的是哪一层）。
 * usedOp：observe 实际用到的操作（后备通道时和规格里的不同）；不给就按规格。
 */
export function uncoveredClaims(e, { ops, platform, host = null, words = DEFAULT_CLAIM_WORDS, usedOp = null } = {}) {
  const claims = effectClaims(e?.assert, words, e?.claims_off);
  if (!claims.length) return { missing: [], op: null, layers: null };
  const op = usedOp || opOf(e?.observe, platform);
  const layers = op ? opLayers(ops, op, platform, host) : null;
  const missing = claims.filter(c => !layers || !c.covers.some(l => layers.includes(l)));
  return { missing, op, layers };
}

const fmtCovers = (covers, points = {}) => covers.map(l => points[l] ? `${LAYERS[l] || l}（本项目：${points[l]}）` : LAYERS[l] || l).join(' 或 ');
/** 给人看的一句：「弹窗」要在 被测 app 自己的画面 上看到。points = 项目对各层的说法（observePointsOf） */
export const fmtMissing = (m, points = {}) => `「${m.word}」要在${fmtCovers(m.covers, points)}上看到`;

/**
 * 盲审逐条核的主张清单：原文按子句拆开，效果主张单列出来（写明要在哪一层看到）。
 * 只有一个子句、又没有效果主张的断言返回一条 —— 盲审照旧整体判。
 */
export function claimList(text, words = DEFAULT_CLAIM_WORDS, off = [], points = {}) {
  const s = String(text || '').replace(/\*\*/g, '').split(/\n依据[:：]|\n来源[:：]/)[0];
  const parts = s.split(/[；;。\n]|，且|并且|同时|以及|\s\+\s/).map(x => x.trim()).filter(x => x.length >= 2);
  const fx = effectClaims(s, words, off).map(c => `${c.word}（要在${fmtCovers(c.covers, points)}上看到）`);
  const words0 = new Set(effectClaims(s, words, off).map(c => c.at));
  return [...new Set([...(parts.length ? parts : [s.trim()]).filter(x => !words0.has(x)), ...fx])].filter(Boolean);
}
