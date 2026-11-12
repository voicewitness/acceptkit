// 知识：项目目录 knowledge/*.md 里的普通文本。不定制结构，可以带标签（#account #android）。
//
// 一条知识 = 一个以「- 」开头的列表项（可跨行缩进续写），或一个段落。标签就是行内的 #word。
// 约定的状态标签：#推测 / #已确认 / #已验证（也认 #guess #confirmed #verified）。推测不用来做决定。
// #secret：这一行冒号后面的值是机密 —— 写证据、报告、日志时由工具层统一替换成 ***（见 secrets.mjs）。
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, statSync, chmodSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

export const STATES = { '推测': 'guess', guess: 'guess', '已确认': 'confirmed', confirmed: 'confirmed', '已验证': 'verified', verified: 'verified' };
const TAG_RE = /(^|\s)#([\p{L}\p{N}_-]+)/gu;

export const knowledgeDir = root => join(root, 'knowledge');

export function listFiles(root) {
  const d = knowledgeDir(root);
  if (!existsSync(d)) return [];
  return readdirSync(d).filter(f => f.endsWith('.md')).sort().map(f => join(d, f));
}

/** 把一份 Markdown 切成条目：列表项（含缩进续行）与段落；记下所在标题。 */
export function parseEntries(text, file) {
  const out = []; let heading = ''; let cur = null; let n = 0;
  const flush = () => { if (cur) { cur.text = cur.lines.join('\n').trim(); delete cur.lines; if (cur.text) out.push(cur); cur = null; } };
  for (const line of text.split('\n')) {
    n++;
    if (/^#{1,6}\s/.test(line)) { flush(); heading = line.replace(/^#+\s*/, '').trim(); continue; }
    if (/^\s*[-*]\s+/.test(line) && !/^\s{2,}/.test(line)) { flush(); cur = { file, line: n, heading, lines: [line.replace(/^\s*[-*]\s+/, '')] }; continue; }
    if (!line.trim()) { flush(); continue; }
    if (cur) { cur.lines.push(line.trim()); continue; }
    cur = { file, line: n, heading, lines: [line.trim()] };
  }
  flush();
  for (const e of out) {
    e.tags = [...new Set([...e.text.matchAll(TAG_RE)].map(m => m[2]))];
    e.state = e.tags.map(t => STATES[t]).find(Boolean) || null;
    e.secret = e.tags.includes('secret');
  }
  return out;
}

export function allEntries(root) {
  return listFiles(root).flatMap(f => parseEntries(readFileSync(f, 'utf8'), f));
}

/** 按标签（#x，全部命中）与关键词（全部包含）找知识。 */
export function find(root, terms) {
  const tags = terms.filter(t => t.startsWith('#')).map(t => t.slice(1));
  const words = terms.filter(t => !t.startsWith('#')).map(t => t.toLowerCase());
  return allEntries(root).filter(e => tags.every(t => e.tags.includes(t)) && words.every(w => e.text.toLowerCase().includes(w) || e.heading.toLowerCase().includes(w)));
}

/** 追加一条知识。来源写进条目本身，权限收紧到 600（知识里可能有账号）。 */
export function add(root, { text, file = 'notes.md', heading, source }) {
  const d = knowledgeDir(root);
  mkdirSync(d, { recursive: true });
  const f = join(d, file.endsWith('.md') ? file : `${file}.md`);
  const fresh = !existsSync(f);
  let body = '';
  if (fresh) body += `# ${heading || '笔记'}\n\n`;
  else if (heading && !readFileSync(f, 'utf8').includes(`\n## ${heading}\n`)) body += `\n## ${heading}\n\n`;
  body += `- ${text}${source ? `（来源：${source}）` : ''}\n`;
  appendFileSync(f, body);
  try { chmodSync(f, 0o600); } catch { /* 非 POSIX 文件系统 */ }
  return f;
}

/** 把某条知识的状态标签改掉（按 文件:行号 定位）。 */
export function setState(root, ref, state) {
  const m = /^(.+):(\d+)$/.exec(ref);
  if (!m) throw new Error('用 <文件>:<行号> 指定条目（know find 的输出里有）');
  const f = m[1].includes('/') ? m[1] : join(knowledgeDir(root), m[1]);
  const lines = readFileSync(f, 'utf8').split('\n');
  const i = Number(m[2]) - 1;
  if (!lines[i]) throw new Error(`${f} 没有第 ${m[2]} 行`);
  const label = { guess: '#推测', confirmed: '#已确认', verified: '#已验证' }[state];
  if (!label) throw new Error('状态只能是 guess | confirmed | verified');
  lines[i] = lines[i].replace(/\s#(推测|已确认|已验证|guess|confirmed|verified)\b/gu, '').replace(/\s*$/, '') + ` ${label}`;
  writeFileSync(f, lines.join('\n'));
  return { file: f, line: i + 1, text: lines[i] };
}

/**
 * 改写或删掉一条知识（按 文件:行号 定位，整条连同续行一起换）。text 为 null 即删除。
 * 旧条目标了 #secret 的，新内容自动带上 #secret —— 改密码时漏写标签，新密码就会原样进报告。
 */
export function replaceEntry(root, ref, text) {
  const m = /^(.+):(\d+)$/.exec(ref);
  if (!m) throw new Error('用 <文件>:<行号> 指定条目（know find 的输出里有）');
  const f = m[1].includes('/') ? m[1] : join(knowledgeDir(root), m[1]);
  if (!existsSync(f)) throw new Error(`没有 ${f}`);
  const lines = readFileSync(f, 'utf8').split('\n');
  const i = Number(m[2]) - 1;
  const old = parseEntries(lines.join('\n'), f).find(e => e.line === i + 1);
  if (!old) throw new Error(`${f}:${m[2]} 不是一条知识的开头（know find 的输出里有行号）`);
  let j = i + 1;
  while (j < lines.length && lines[j].trim() && !/^#{1,6}\s/.test(lines[j]) && !(/^\s*[-*]\s+/.test(lines[j]) && !/^\s{2,}/.test(lines[j]))) j++;
  let next = [];
  if (text != null) {
    const t = old.secret && !/#secret\b/.test(text) ? `${text} #secret` : text;
    next = [/^\s*[-*]\s+/.test(lines[i]) ? `- ${t}` : t];
  }
  lines.splice(i, j - i, ...next);
  writeFileSync(f, lines.join('\n'));
  // 旧值改写后就不在知识里了，遮蔽认不出它：机密条目的旧内容不回显
  return { file: f, line: i + 1, old: old.text, oldSecret: old.secret, secretKept: old.secret && text != null && !/#secret\b/.test(text) };
}

/** 文件权限检查：知识里可能有账号，组/其他人可读就报出来。 */
export function permissionProblems(root) {
  const out = [];
  for (const f of listFiles(root)) {
    try { const mode = statSync(f).mode & 0o777; if (mode & 0o077) out.push({ file: f, mode: mode.toString(8) }); } catch { /* skip */ }
  }
  return out;
}
