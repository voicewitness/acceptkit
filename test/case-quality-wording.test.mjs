// 检查者不说行话：质量规则、评审问题、标准文档里的文字过同一份行话清单。
// 规则文字自己用「两臂 / 反臂」时，对用例的行话检查补上了也不会把它标红 —— 两边说的是同一种话。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RULES, QUESTIONS, JARGON, jargonHits, checkCase } from '../core/case-quality.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('内核规则、评审问题、标准文档不用行话', () => {
  const texts = [...RULES.flatMap(r => [`${r.id}.title`, r.title, `${r.id}.why`, r.why, `${r.id}.fix`, r.fix]), ...QUESTIONS.flatMap((q, i) => [`Q?${i}`, q])];
  const bad = [];
  for (let i = 0; i < texts.length; i += 2) for (const h of jargonHits(texts[i + 1])) bad.push(`${texts[i]}「${h.term}」`);
  for (const f of ['docs/case-quality.md', 'core/evidence-gate.mjs']) readFileSync(join(ROOT, f), 'utf8').split('\n').forEach((l, n) => {
    if (/JARGON|jargon|行话/.test(l)) return;   // 讲行话清单本身的句子要举例
    for (const h of jargonHits(l)) bad.push(`${f}:${n + 1}「${h.term}」`);
  });
  assert.deepEqual(bad, []);
});

test('Q16：用例正文里的行话按字段报出；项目自己的行话从配置追加', () => {
  const c = { case: 'x', title: '两臂对照', platform: 'ios', tree: [{ op: '臂 A：默认冷启动（featureX = true）', expect: [{ id: 'E1', assert: '走旧流程' }] }] };
  const f = checkCase(c, { cfg: { jargon: [{ match: '旧流程', say: '写清是哪条调用路径' }] } }).filter(x => x.rule === 'Q16');
  assert.deepEqual(f.map(x => x.at), ['用例', '节点 1', 'E1']);
  assert.match(f[1].msg, /臂 A/);
  assert.equal(checkCase({ ...c, title: '手臂', tree: [{ op: '默认冷启动', expect: [] }] }).filter(x => x.rule === 'Q16').length, 0);
  assert.ok(JARGON.length);
});

test('晚于基线加的规则：存量用例只提示，新用例照常拦', async () => {
  const { classify } = await import('../core/case-quality.mjs');
  const f = [{ rule: 'Q16', level: 'block', since: '2026-10-29', at: 'E1' }];
  assert.equal(classify(f, { keys: [] }, '2026-10-27T00:00:00Z').block.length, 0, '基线里有这条用例 = 存量');
  assert.equal(classify(f, undefined, '2026-10-27T00:00:00Z').block.length, 1, '基线里没有 = 新用例');
  assert.equal(classify(f, { keys: [] }, '2026-11-01T00:00:00Z').block.length, 1, '基线晚于规则：规则当时就在');
});

test('Q20：写了 via 却没写 why_not_ui 拦下；via 写错拦下；不写 via（默认界面）不拦', async () => {
  const { RULES } = await import('../core/case-quality.mjs');
  const q = RULES.find(r => r.id === 'Q20');
  const c = expect => ({ case: 'x', tree: [{ op: '打开', expect }] });
  assert.equal(q.check({ c: c([{ id: 'E1', assert: '页面显示你好' }]) }).length, 0);
  assert.match(q.check({ c: c([{ id: 'E1', assert: '日志里有 x', via: 'log' }]) })[0].msg, /why_not_ui/);
  assert.match(q.check({ c: c([{ id: 'E1', assert: 'x', via: 'grep' }]) })[0].msg, /via 只能是/);
  assert.equal(q.check({ c: c([{ id: 'E1', assert: 'x', via: 'log', why_not_ui: '只进日志' }]) }).length, 0);
});
