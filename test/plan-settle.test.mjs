// 「等你定」只该剩 owner 真要拍板的：执行者把更正链、已有答案、自己的活用 plan settle 收口 ——
// 带理由、不冒充 owner（不写 decided_by），owner 可以直接改判或放回。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'bin', 'acceptkit.mjs');
function project() {
  const dir = mkdtempSync(join(tmpdir(), 'acceptkit-test-'));
  for (const d of ['cases', 'runs', 'state/plans', 'knowledge', 'ops']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'acceptkit.project.json'), JSON.stringify({ name: 't', gate: { allow: [] } }));
  const F = (id, at) => ({ id, what: `${id} 的事`, detail: '', decide: `${id} 要不要修`, decided_by: null, decision: null, at });
  writeFileSync(join(dir, 'state/plans/D1.json'), JSON.stringify({ demand: 'D1', title: 't', surfaces: [], revision: 1, history: [],
    findings: [F('F1', '2026-10-01T00:00:00Z'), F('F2', '2026-10-02T00:00:00Z'), F('F3', '2026-10-03T00:00:00Z')] }));
  return dir;
}
const ak = (dir, ...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, ACCEPTKIT_PROJECT: dir, HOME: dir } });
const findings = dir => JSON.parse(readFileSync(join(dir, 'state/plans/D1.json'), 'utf8')).findings;

test('收口要说清去读哪条、为什么；不写 decided_by；能放回', () => {
  const dir = project();
  assert.match(ak(dir, 'plan', 'settle', 'D1', '--finding', 'F1', '--kind', 'superseded', '--note', 'x').stderr, /--ref/);
  assert.match(ak(dir, 'plan', 'settle', 'D1', '--finding', 'F2', '--kind', 'superseded', '--ref', 'F1', '--note', 'x').stderr, /早/);
  assert.match(ak(dir, 'plan', 'settle', 'D1', '--finding', 'F1', '--kind', 'superseded', '--ref', 'F2').stderr, /--note/);
  assert.match(ak(dir, 'plan', 'settle', 'D1', '--finding', 'F1', '--kind', 'guess', '--note', 'x').stderr, /--kind/);
  const r = ak(dir, 'plan', 'settle', 'D1', '--finding', 'F1', '--kind', 'superseded', '--ref', 'F2', '--note', 'F2 重写了同一个问题');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /还有 2 条等 owner 定/);
  const f1 = findings(dir)[0];
  assert.equal(f1.decided_by, null, '收口不是 owner 拍板');
  assert.deepEqual([f1.settled.kind, f1.settled.ref], ['superseded', 'F2']);
  assert.equal(ak(dir, 'plan', 'settle', 'D1', '--finding', 'F1', '--undo').status, 0);
  assert.equal(findings(dir)[0].settled, undefined);
});

test('owner 定过的不能再被执行者收口', () => {
  const dir = project();
  assert.equal(ak(dir, 'plan', 'decide', 'D1', '--finding', 'F3', '--by', 'owner', '--quote', '不修').status, 0);
  assert.match(ak(dir, 'plan', 'settle', 'D1', '--finding', 'F3', '--kind', 'executor', '--note', 'x').stderr, /已经定过/);
});

// owner 的拍板漏存的几种样子：聊天里回了没记、记成执行者收口丢了原话、一句话回几条只记一条、
// 「按你建议」对不上当时的推荐、执行者自己 --by executor 落定。
test('owner 拍板：一次记几条、记下选中的选项、执行者不能自签；进审批表', async () => {
  const dir = project();
  const p = join(dir, 'state/plans/D1.json'), plan = JSON.parse(readFileSync(p, 'utf8'));
  plan.findings[0].options = [{ label: '修', effect: '多一轮' }, { label: '不修', effect: '报告里写明' }];
  plan.findings[0].recommend = '不修：不是本次改动引入的';
  writeFileSync(p, JSON.stringify(plan));
  assert.match(ak(dir, 'plan', 'decide', 'D1', '--finding', 'F1', '--by', 'executor（按默认）', '--quote', 'x').stderr, /执行者自己/);
  assert.match(ak(dir, 'plan', 'decide', 'D1', '--finding', 'F1', '--by', '执行者', '--quote', 'x').stderr, /执行者自己/);
  assert.match(ak(dir, 'plan', 'bounce', 'D1', '--finding', 'F1', '--by', 'agent', '--quote', 'x').stderr, /执行者自己/);
  assert.match(ak(dir, 'plan', 'decide', 'D1', '--finding', 'F1', '--by', 'owner', '--quote', 'x', '--option', '3').stderr, /1\.\.2/);
  const r = ak(dir, 'plan', 'decide', 'D1', '--finding', 'F1', '--by', 'owner', '--quote', '按你建议来', '--option', '2', '--json');
  assert.equal(r.status, 0, r.stdout);
  assert.equal(JSON.parse(r.stdout).chosen, '2. 不修 => 报告里写明');
  assert.deepEqual(findings(dir)[0].decision_option, { index: 2, label: '不修', effect: '报告里写明' });
  // 一句话回了两条
  const two = JSON.parse(ak(dir, 'plan', 'decide', 'D1', '--finding', 'F2,F3', '--by', 'owner', '--quote', '两条都不修', '--json').stdout);
  assert.deepEqual(two.results.map(c => c.status), ['decided', 'decided']);
  assert.deepEqual(findings(dir)[1].decision_with, ['F3']);
  const { listApprovals } = await import('../core/store/db.mjs');
  assert.deepEqual(listApprovals(dir, 'D1').map(a => [a.kind, a.quote]), [['finding', '按你建议来'], ['finding', '两条都不修']]);
});

test('owner 的回答不能当「查实的事实」收口：answered 要指出事实在哪', () => {
  const dir = project();
  const r = ak(dir, 'plan', 'settle', 'D1', '--finding', 'F1', '--kind', 'answered', '--note', 'owner 说不用合了');
  assert.notEqual(r.status, 0); assert.match(r.stderr, /plan decide D1 --finding F1/);
  assert.match(ak(dir, 'plan', 'settle', 'D1', '--finding', 'F1', '--kind', 'answered', '--evidence', 'nope', '--note', 'x').stderr, /不是一个运行/);
  mkdirSync(join(dir, 'runs', 'r1'));
  assert.equal(ak(dir, 'plan', 'settle', 'D1', '--finding', 'F1', '--kind', 'answered', '--evidence', 'r1', '--note', 'r1 读到开关是开的').status, 0);
  assert.equal(ak(dir, 'plan', 'decide', 'D1', '--finding', 'F3', '--by', 'owner', '--quote', '不修').status, 0);
  assert.equal(ak(dir, 'plan', 'settle', 'D1', '--finding', 'F2', '--kind', 'answered', '--ref', 'F3', '--note', '同 F3').status, 0);
  // owner 后来亲自定了，盖过执行者的收口
  assert.equal(ak(dir, 'plan', 'decide', 'D1', '--finding', 'F1', '--by', 'owner', '--quote', '还是修吧').status, 0);
  assert.equal(findings(dir)[0].settled, undefined);
});
