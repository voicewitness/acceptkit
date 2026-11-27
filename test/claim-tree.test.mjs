// 给人读的那一层：断言一句话（Q28）、结论树盖住全部断言（Q29）、结论树每层写结论（Q30）；
// 修订记录机械挪进 history 不改一个字，批准后这样挪只算事后通知
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkCase, splitAssert, codeTokens } from '../core/case-quality.mjs';
import { claimGaps } from '../core/evidence-gate.mjs';
import { classifyCaseEdit } from '../core/plan-gate.mjs';

const rules = (c, id) => checkCase(c).filter(f => f.rule === id);
const four = (asserts = ['a 显示', 'b 显示', 'c 显示', 'd 显示']) => ({ case: 'c', title: 't', platform: 'web',
  tree: [{ op: '打开页面', expect: asserts.map((a, i) => ({ id: `E${i + 1}`, assert: a })) }] });

test('Q28：断言超长、分段、夹多个代码名 → 拦；一句人话不拦', () => {
  assert.equal(rules(four(), 'Q28').length, 0);
  const c = four(['x'.repeat(81), '第一段\n第二段', '读 engine.GetX 的 unit_id 字段', '开关打开后页面顶部出现提示']);
  assert.deepEqual(rules(c, 'Q28').map(f => f.at), ['E1', 'E2', 'E3']);
  assert.deepEqual(codeTokens('读 engine.GetX 的 unit_id 和 fooBar，config={"a":1}').length, 4);
});

test('Q29：四条以上断言要有结论树，没挂上的点名；Q30：每层写结论、别挂太多', () => {
  assert.match(rules(four(), 'Q29')[0].msg, /没有结论树/);
  const c = { ...four(), claims: [{ text: '首页文案都对', children: [{ text: '上半屏', proved_by: ['E1', 'E2'] }, { text: '下半屏', proved_by: ['E3'] }] }] };
  assert.match(rules(c, 'Q29')[0].msg, /1 条断言没挂到任何结论上：E4/);
  c.claims[0].children[1].proved_by.push('E4');
  assert.equal(rules(c, 'Q29').length, 0);
  assert.equal(rules(c, 'Q30').length, 0);
  c.claims[0].children[0].text = '① 读 engine.GetX 的返回';
  assert.match(rules(c, 'Q30')[0].msg, /代码名.*写成了步骤|写成了步骤/);
  const wide = four(Array.from({ length: 9 }, (_, i) => `第 ${i} 项显示`));
  wide.claims = [{ text: '全都显示', proved_by: wide.tree[0].expect.map(e => e.id) }];
  assert.ok(rules(wide, 'Q30').some(f => /直接挂了 9 条/.test(f.msg)));
});

test('结论树的证实状态往上汇总：下面任何一条没过，上层也没证实', () => {
  const c = { claims: [{ text: '根', children: [{ text: '甲', proved_by: ['E1'] }, { text: '乙', proved_by: ['E2'] }] }] };
  const ok = { status: 'pass', evidence: [] };
  assert.deepEqual(claimGaps(c, { results: { E1: ok, E2: ok } }), []);
  const g = claimGaps(c, { results: { E1: ok, E2: { status: 'fail' } } });
  assert.ok(g.some(x => x.startsWith('「根」未被证实：E2=fail')) && g.some(x => x.startsWith('「乙」')));
  assert.ok(!g.some(x => x.startsWith('「甲」')));
});

const LONG = '开关打开后页面顶部出现提示。\n    ⚠️ 2026-09-21 修订：原写「立即出现」，实测有 1 秒延迟。\n    补充说明：延迟来自动画。';
test('修订记录机械挪进 history，一字不改 → 批准后直接通过；从中间挑一句当断言 → 算验的范围变了', () => {
  const e = { id: 'E1', assert: LONG };
  const x = splitAssert(e);
  assert.equal(x.assert, '开关打开后页面顶部出现提示。');
  assert.equal(x.history.length, 2);
  assert.equal(x.history[0].at, '2026-09-21');
  assert.equal(splitAssert({ id: 'E1', assert: '一句话' }), null);
  const before = four([LONG, 'b', 'c', 'd']), after = JSON.parse(JSON.stringify(before));
  after.tree[0].expect[0] = x;
  assert.equal(classifyCaseEdit(before, after).tier, 'notify');
  const pick = JSON.parse(JSON.stringify(after)); pick.tree[0].expect[0].assert = '原写「立即出现」';
  pick.tree[0].expect[0].detail = '开关打开后页面顶部出现提示。';
  assert.equal(classifyCaseEdit(before, pick).tier, 'scope', '拿撤回的旧说法当断言');
  const reword = JSON.parse(JSON.stringify(before)); reword.tree[0].expect[0] = { id: 'E1', assert: '开关打开后能看到提示', detail: LONG };
  assert.equal(classifyCaseEdit(before, reword).tier, 'scope', '改写成新的一句话：验的范围变了，旧结论作废');
});

const BIN = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'bin', 'acceptkit.mjs');
test('tidy：不加 --write 只报告；加了写回，validate 认 detail / history 和多层结论树', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acceptkit-test-'));
  for (const d of ['cases', 'runs', 'state/plans', 'knowledge', 'ops']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'acceptkit.project.json'), JSON.stringify({ name: 't', gate: { allow: [] } }));
  const cf = join(dir, 'cases', 'c1.case.json');
  const c = four([LONG, '问候语是黑色', '问候语在顶部', '问候语不换行']);
  c.claims = [{ text: '问候语显示对', children: [{ text: '出现', proved_by: ['E1'] }, { text: '样式', proved_by: ['E2', 'E3', 'E4'] }] }];
  writeFileSync(cf, JSON.stringify({ ...c, case: 'c1' }, null, 1));
  const ak = (...a) => spawnSync(process.execPath, [BIN, ...a], { cwd: dir, encoding: 'utf8', env: { ...process.env, ACCEPTKIT_PROJECT: dir, HOME: dir } });
  const dry = ak('tidy', 'c1');
  assert.match(dry.stdout, /1 条的修订记录挪进了 history/);
  assert.match(dry.stdout, /没写文件/);
  assert.equal(JSON.parse(readFileSync(cf, 'utf8')).tree[0].expect[0].assert, LONG);
  assert.equal(ak('tidy', 'c1', '--write').status, 0);
  const w = JSON.parse(readFileSync(cf, 'utf8'));
  assert.equal(w.tree[0].expect[0].assert, '开关打开后页面顶部出现提示。');
  const v = ak('validate', 'c1');
  assert.equal(v.status, 0, v.stdout + v.stderr);
  assert.doesNotMatch(v.stdout, /Q2[89]|字段 (detail|history) 不认识/);
  // 看板：结论树按层显示，叶子只显示一句话；修订记录折叠在断言下面
  const out = join(dir, "board.html");
  const b = spawnSync(process.execPath, [join(dirname(BIN), "..", "core", "dashboard.mjs"), out], { cwd: dir, encoding: "utf8", env: { ...process.env, ACCEPTKIT_PROJECT: dir, HOME: dir } });
  assert.equal(b.status, 0, b.stderr);
  const html = readFileSync(out, "utf8");
  assert.match(html, /结论树[\s\S]*问候语显示对[\s\S]*出现[\s\S]*E1<\/code> 开关打开后页面顶部出现提示。<\/li>/);
  assert.match(html, /修订记录 2 条/);
});
