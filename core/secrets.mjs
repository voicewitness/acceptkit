// 机密遮蔽：知识里标了 #secret 的条目、acceptkit account 登记的账号机密字段，其值在证据、报告、日志里一律替换成 ***。
//
// 取值规则：条目文本里最后一个「：」或「:」之后、到第一个 #标签之前的部分；
// 没有冒号时取去掉标签后的整段。值太短（< 4 个字符）不遮，避免把常见词整篇替换掉。
import { allEntries } from './knowledge.mjs';
import { accountSecretValues } from './accounts.mjs';

const MIN_LEN = 4;
const cache = new Map();

export function secretValues(root) {
  if (!root) return [];
  if (cache.has(root)) return cache.get(root);
  const vals = new Set();
  for (const e of allEntries(root)) {
    if (!e.secret) continue;
    for (const raw of e.text.split('\n')) {
      if (!/#secret\b/.test(raw) && e.text.split('\n').length > 1) continue;
      const noTags = raw.replace(/(^|\s)#[\p{L}\p{N}_-]+/gu, ' ').trim();
      const idx = Math.max(noTags.lastIndexOf('：'), noTags.lastIndexOf(':'));
      const v = (idx >= 0 ? noTags.slice(idx + 1) : noTags).replace(/[（(]来源[^）)]*[）)]/g, '').trim();
      if (v.length >= MIN_LEN) vals.add(v);
    }
  }
  for (const v of accountSecretValues(root)) vals.add(v);   // acceptkit account 登记的机密字段
  const list = [...vals].sort((a, b) => b.length - a.length);
  cache.set(root, list);
  return list;
}

export function mask(root, text) {
  if (text === null || text === undefined) return text;
  let s = String(text);
  for (const v of secretValues(root)) if (s.includes(v)) s = s.split(v).join('***');
  return s;
}

/** 深度遮蔽 JSON 值（证据里的结构化数据）。 */
export function maskDeep(root, v) {
  if (typeof v === 'string') return mask(root, v);
  if (Array.isArray(v)) return v.map(x => maskDeep(root, x));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskDeep(root, x)]));
  return v;
}
