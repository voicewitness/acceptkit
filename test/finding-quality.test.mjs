// finding 要写到 owner 读得懂、能拍板：性质 · 影响范围 · 为什么 · 选项+后果 · 推荐，人话区不夹代码标识。
// owner 看不懂可以退回（不算拍板），执行者改写同一条后才回到「等你定」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findingProblems } from '../core/finding-quality.mjs';

const BIN = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'bin', 'acceptkit.mjs');
function project() {
  const dir = mkdtempSync(join(tmpdir(), 'acceptkit-test-'));
  for (const d of ['cases', 'runs', 'state/plans', 'knowledge', 'ops']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'acceptkit.project.json'), JSON.stringify({ name: 't', gate: { allow: [] } }));
  writeFileSync(join(dir, 'state/plans/D1.json'), JSON.stringify({ demand: 'D1', title: 't', surfaces: [], revision: 1, history: [],
    findings: [{ id: 'F1', what: '旧写法', detail: '', decide: '要不要修', decided_by: null, decision: null, at: '2026-10-01T00:00:00Z' }] }));
  return dir;
}
const ak = (dir, ...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, ACCEPTKIT_PROJECT: dir, HOME: dir } });
const findings = dir => JSON.parse(readFileSync(join(dir, 'state/plans/D1.json'), 'utf8')).findings;
const GOOD = ['--what', '20 条断言测的是一条不存在的分支，永远过不了', '--kind', 'test_defect',
  '--impact', '只影响验收的通过率，线上用户不受影响',
  '--why', '这些规则是无条件执行的，所以「不执行」那一支不存在',
  '--option', '删掉这 20 条 => 通过率如实，评审单要改一版', '--option', '保留并标不适用 => 留痕，但列表里一直挂着',
  '--recommend', '删掉：它们测不出任何东西', '--decide', '这 20 条删掉还是标不适用？', '--detail', 'node_mode=3 ALWAYS'];

test('缺性质 / 影响 / 选项，或人话区夹代码标识，就不收', () => {
  const dir = project();
  const r = ak(dir, 'plan', 'finding', 'D1', '--what', 'x', '--decide', '要不要修');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /性质/); assert.match(r.stderr, /影响范围/); assert.match(r.stderr, /选项/);
  const j = [...GOOD]; j[j.indexOf('--impact') + 1] = '所有 node_mode=3 的节点';
  assert.match(ak(dir, 'plan', 'finding', 'D1', ...j).stderr, /影响范围」里有字段=值/);
  const ok = ak(dir, 'plan', 'finding', 'D1', ...GOOD);
  assert.equal(ok.status, 0, ok.stderr);
  const f = findings(dir)[1];
  assert.deepEqual(f.options[0], { label: '删掉这 20 条', effect: '通过率如实，评审单要改一版' });
  assert.deepEqual(findingProblems(f), []);
  assert.match(f.detail, /node_mode=3/, '技术细节照收');
});

test('看不懂就退回；改写同一条后才算合格', () => {
  const dir = project();
  assert.equal(ak(dir, 'plan', 'finding', 'D1', '--finding', 'F1', ...GOOD).status, 0);
  assert.deepEqual(findingProblems(findings(dir)[0]), []);
  assert.equal(ak(dir, 'plan', 'bounce', 'D1', '--finding', 'F1', '--by', 'owner', '--quote', '为什么一定不命中？').status, 0);
  const f = findings(dir)[0];
  assert.equal(f.decided_by, null, '退回不是拍板');
  assert.match(findingProblems(f)[0], /为什么一定不命中/);
  assert.equal(ak(dir, 'plan', 'finding', 'D1', '--finding', 'F1', '--why', '规则配成了「总是执行」，引擎不会判它为假').status, 0);
  assert.deepEqual(findingProblems(findings(dir)[0]), []);
  assert.equal(findings(dir).length, 1, '改写不另开一条');
});
