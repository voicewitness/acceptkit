// 从历史用例里自动提操作集：同样的操作只留一份，操作可以嵌套（A 的步骤里引用 B）。
// 只按形状认，不认业务词：
//   一步的「身份」= 挂了操作的用它的 op_id；写着命令的用规整后的命令（去空白）；写成「动作 + 对象」的用规整后的文字（去空白和标点）。
//   说不清的步骤、没填的模板、在构造输入的（手写了字段）不提 —— 那些要先 clarify / 改成真实触发，提成操作只会把垃圾固化
//   同一个身份出现在 2 条以上用例里 → 一个操作。操作库里已经有同样做法的（命令或标题一样）就复用，不新建
//   父子两步在 2 条以上用例里都连着出现 → 一个组合操作，步骤是对这两个操作的引用（{ use: <操作> }）
// --apply：新操作写进操作库，用例里这些步骤挂上 op_id（原文不动），每处记下是从哪提的。
import { createHash } from 'node:crypto';
import { CONCRETE_STEP, emptySlots, commandOf } from './clarity.mjs';
export { expandHuman } from './clarity.mjs';
import { literalFields } from './input-source.mjs';

const normText = t => String(t || '').replace(/\s+/g, '').replace(/[，。；、:：()（）,.;]/g, '');
const normCmd = c => String(c).replace(/\s+/g, ' ').trim().replace(/\s(-s|--serial)\s+\S+/g, '');
const hash = s => createHash('sha1').update(s).digest('hex').slice(0, 6);
// 操作名：取文字里的英文 / 拼音词，没有就用哈希 —— 不替项目起业务名字，标题用原文
const slug = (t, k) => { const w = (String(t).match(/[A-Za-z][A-Za-z0-9]+/g) || []).slice(0, 3).join('-').toLowerCase(); return `step-${w ? w + '-' : ''}${hash(k)}`; };

/** 一步的身份 → { key, kind: op|cmd|text, text, cmd? } | { skip: why } */
export function stepKey(n, ops = {}) {
  if (n.op_id) return { key: `op:${n.op_id}`, kind: 'op', op: n.op_id, text: n.op };
  if (ops[String(n.op || '').trim()]) return { key: `op:${String(n.op).trim()}`, kind: 'named', op: String(n.op).trim(), text: n.op };
  const t = String(n.op || '');
  if (emptySlots(n)) return { skip: 'template' };
  const cmd = commandOf(t);
  if (cmd) return { key: `cmd:${normCmd(cmd)}`, kind: 'cmd', cmd: normCmd(cmd), text: t };
  if (literalFields(t).length || /\{\s*["']?[^\s{}"']+["']?\s*[:=：]/.test(t)) return { skip: 'literal' };
  if (!CONCRETE_STEP.test(t)) return { skip: 'vague' };
  return { key: `text:${normText(t)}`, kind: 'text', text: t };
}

/** 历史用例 → 候选：{ leaves: [...], combos: [...], skipped: { vague, template, literal }, vagueRepeats: [...] } */
export function extractOps(cases, ops = {}, { min = 2 } = {}) {
  const groups = new Map(), pairs = new Map(), skipped = { vague: 0, template: 0, literal: 0 }, vague = new Map();
  for (const c of cases) {
    const walk = (ns, prefix, parent) => (ns || []).forEach((n, i) => {
      const id = `${prefix}${i + 1}`, k = stepKey(n, ops);
      if (k.skip) { skipped[k.skip]++; if (k.skip === 'vague') { const v = normText(n.op); if (v) (vague.get(v) || vague.set(v, { text: n.op, cases: new Set() }).get(v)).cases.add(c.case); } }
      else {
        const g = groups.get(k.key) || groups.set(k.key, { ...k, at: [], texts: new Map() }).get(k.key);
        g.at.push({ case: c.case, node: id }); g.texts.set(k.text, (g.texts.get(k.text) || 0) + 1);
        if (parent) { const pk = `${parent.key} ⟶ ${k.key}`; (pairs.get(pk) || pairs.set(pk, { a: parent.key, b: k.key, cases: new Set() }).get(pk)).cases.add(c.case); }
      }
      walk(n.children, `${id}.`, k.skip ? null : k);
    });
    walk(c.tree, 'n', null);
  }
  // 操作库里已有同样做法的：命令一样、或标题规整后一样 → 复用
  const reuse = k => Object.entries(ops).find(([, o]) => k.kind === 'cmd' ? JSON.stringify(o.platforms || {}).includes(k.cmd)
    : normText(o.title) === k.key.slice(5) || [].concat(o.human || []).some(h => normText(h) === k.key.slice(5)))?.[0] || null;
  // 文字就是操作名、却没挂 op_id 的：直接挂上那个操作（不论出现几次）
  const named = [...groups.values()].filter(g => g.kind === 'named').map(g => ({ key: g.key, kind: 'named', id: g.op, existing: true, title: ops[g.op]?.title || g.op, human: [], cmd: null, at: g.at }));
  const leaves = [...named, ...[...groups.values()].filter(g => g.kind !== 'op' && g.kind !== 'named' && new Set(g.at.map(x => x.case)).size >= min).map(g => {
    const title = [...g.texts].sort((a, b) => b[1] - a[1])[0][0];
    const human = g.kind === 'cmd' ? title.replace(/`[^`]*`/g, '').replace(/(执行|运行)\s*[，,]?\s*/, '').replace(/^[，,\s]+/, '').trim() : title;
    const id = reuse(g) || slug(title, g.key);
    return { key: g.key, kind: g.kind, id, existing: !!ops[id], title: human || title, human: human && CONCRETE_STEP.test(human) ? [human] : [], cmd: g.cmd || null, at: g.at };
  })];
  const idOf = key => key.startsWith('op:') ? key.slice(3) : leaves.find(l => l.key === key)?.id || null;
  const combos = [...pairs.values()].filter(p => p.cases.size >= min).map(p => ({ a: idOf(p.a), b: idOf(p.b), cases: [...p.cases] }))
    .filter(p => p.a && p.b && p.a !== p.b).map(p => ({ ...p, id: `flow-${hash(p.a + '>' + p.b)}` }));
  const vagueRepeats = [...vague.values()].filter(v => v.cases.size >= min).map(v => ({ text: v.text, cases: [...v.cases] })).sort((a, b) => b.cases.length - a.cases.length);
  return { leaves, combos, skipped, vagueRepeats };
}

