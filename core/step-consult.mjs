// 步骤咨询：对业务不熟的执行者，也能从「提测内容」（评审单里这条用例所在改动面的说明）和「项目操作集」推出明确的操作步骤。
// 工具层不调模型：只按形状给候选 —— 不清晰的那一步 / 那条预期的文字（连同用例标题、改动面说明）和操作库里每个操作的
// 标题、人看步骤、为什么、做法原文比重合的词，带人看步骤的操作才算候选（没有人看步骤的引用了也说不清）。
// 候选明确（最高分够高、和第二名拉得开）的可以直接写回；拿不准的列出前几名，由执行者挑、或照提测内容自己写。
import { grams } from './ask-gate.mjs';
import { caseClarity, expandHuman, fillHuman } from './clarity.mjs';

const opText = (o, id) => [id, o.title, o.why, [].concat(o.human || []).join(' '), JSON.stringify(o.platforms || {})].join(' ');
const score = (q, t) => { const T = grams(t); return [...grams(q)].filter(g => T.has(g)).length; };

/** 一条用例里每处不清晰 → [{ at, type, level, msg, query, candidates: [{ op, title, human, input, score }], pick }] */
export function stepCandidates(c, ops, { surface = '', platform = null, top = 3 } = {}) {
  const plat = platform || String(c.platform || '').split(/[,/]/)[0] || null;
  const k = caseClarity(c, ops), out = [];
  const nodes = new Map(), exps = new Map();
  (function w(ns, p) { (ns || []).forEach((n, i) => { const id = `${p}${i + 1}`; nodes.set(id, n); (n.expect || []).forEach(e => exps.set(e.id, { e, n })); w(n.children, `${id}.`); }); })(c.tree, 'n');
  const usable = Object.entries(ops).map(([id, o]) => ({ id, o, human: expandHuman(ops, id, new Set(), plat) })).filter(x => x.human.length);
  for (const it of [...k.steps.map(x => ({ ...x, type: 'step' })), ...k.expects.map(x => ({ ...x, type: 'expect' }))]) {
    const own = it.type === 'step' ? nodes.get(it.at) : exps.get(it.at)?.e;
    const params = it.type === 'step' ? (own?.params || {}) : (own?.observe?.params || {});
    // 这一处自己的文字最要紧；用例标题、提测内容只当背景 —— 只靠背景配上的（例：标题里有「开关」就配 mock 开关的操作）不算明确
    const self = it.type === 'step' ? String(own?.op || '') : `${own?.assert || ''} ${String(own?.detail || '').slice(0, 300)}`;
    const ctx = [c.title, surface].join(' '), query = self;
    // 预期只配观测类操作；步骤配动作类的（没标 kind 的算动作）
    const pool = usable.filter(x => it.type === 'expect' ? x.o.kind === 'observe' : x.o.kind !== 'observe');
    const ranked = pool.map(x => { const t = opText(x.o, x.id), own = score(self, t); return { op: x.id, title: x.o.title, human: fillHuman(x.human, params), input: x.o.input || null, own, score: own * 2 + score(ctx, t) }; })
      .filter(x => x.score >= 2).sort((a, b) => b.score - a.score || (a.input === 'injected') - (b.input === 'injected')).slice(0, top);
    // 明确：最高分至少 4，且比第二名高出一半以上
    const pick = ranked[0] && ranked[0].own >= 3 && (!ranked[1] || ranked[0].score >= ranked[1].score * 1.5) ? ranked[0].op : null;
    out.push({ ...it, query: self.slice(0, 200), candidates: ranked, pick });
  }
  return out;
}
