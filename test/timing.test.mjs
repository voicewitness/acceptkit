// 用时有数据：存结论就记时间线；timing 按需求 / 用例 / 断言汇总；优化包自带上下文，处理完要写怎么处理的
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runTimes } from '../core/timing.mjs';

const BIN = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'bin', 'acceptkit.mjs');

test('用时：两件事隔得太久不算进下一条；没有时间线的老运行按证据时间估算', () => {
  const t0 = Date.parse('2026-11-24T00:00:00Z'), at = m => new Date(t0 + m * 60e3).toISOString();
  const r = { created_at: at(0), timeline: [{ at: at(0), kind: 'created' }, { at: at(5), id: 'E1', status: 'pass', how: 'observe' },
    { at: at(8), id: 'E2', status: 'fail', how: 'record' }, { at: at(200), id: 'E3', status: 'pass', how: 'record' }] };
  const x = runTimes('/nonexistent', r);
  assert.equal(x.estimated, false);
  assert.deepEqual(x.items.map(i => [i.id, i.dt && i.dt / 60e3]), [['E1', 5], ['E2', 3], ['E3', null]], '隔了三个多小时的不算');
});

test('timing / tune：记结论就有时间线；按用例汇总；优化包打出来，处理完要写 --note', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acceptkit-test-'));
  for (const d of ['cases', 'runs', 'state/plans', 'knowledge', 'ops']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'acceptkit.project.json'), JSON.stringify({ name: 't', gate: { allow: [] } }));
  writeFileSync(join(dir, 'cases', 'c1.case.json'), JSON.stringify({ case: 'c1', title: '首页问候语', platform: 'web', classifications: { carrier: ['page'] },
    tree: [{ op: '打开「首页」', tags: { carrier: 'page' }, shows: ['你好'], expect: [{ id: 'E1', assert: '页面顶部显示「你好」', judge: 'human', human_why: '人看' }] }] }));
  const ak = (...a) => spawnSync(process.execPath, [BIN, ...a], { cwd: dir, encoding: 'utf8', env: { ...process.env, ACCEPTKIT_PROJECT: dir, HOME: dir } });
  const ok = (...a) => { const r = ak(...a); assert.equal(r.status, 0, a.join(' ') + '\n' + r.stderr); return r; };
  ok('plan', 'new', 'D1', '--title', '首页问候', '--platform', 'web');
  ok('plan', 'add-case', 'D1', '--surface', 'S1', '--change', '首页加了问候语', '--reuse', 'c1', '--risk', '看不到问候', '--uncovered', '其他页');
  ok('plan', 'approve', 'D1', '--by', 'owner', '--quote', '可以');
  ok('run', 'c1', '--demand', 'D1');
  const run = readdirSync(join(dir, 'runs'))[0];
  ok('record', run, '--expect', 'E1', '--status', 'fail', '--actual', '没看到问候语', '--allow-no-shot', '测试里没有浏览器');
  const r = JSON.parse(readFileSync(join(dir, 'runs', run, 'result.json'), 'utf8'));
  assert.ok(r.created_at, '运行记了开始时间');
  assert.ok(r.timeline.some(e => e.id === 'E1' && e.status === 'fail' && e.how === 'record'), '结论变化记进时间线');
  assert.ok(r.results.E1.at, '结论带时间');
  assert.match(ok('timing', 'D1').stdout, /需求 D1：1 个运行[\s\S]*c1  跑 1 次[\s\S]*c1 E1  判了 1 次 · .*手记 1/);
  assert.match(ok('tune', 'build').stdout, /优化包 \d{4}-\d{2}-\d{2}/);
  const id = readdirSync(join(dir, 'state', 'tune')).find(f => f.endsWith('.json')).replace('.json', '');
  const pack = JSON.parse(readFileSync(join(dir, 'state', 'tune', `${id}.json`), 'utf8'));
  assert.ok(pack.how_to_use && pack.sections.every(s => s.ask), '每节自带要判断什么');
  assert.equal(ak('tune', 'build', '--if-due').stdout, '', '没到期不重打');
  assert.notEqual(ak('tune', 'done', id).status, 0, '没写怎么处理的不收');
  ok('tune', 'done', id, '--note', '补了 c1 E1 的机判');
  assert.match(ok('tune').stdout, /✓ .*处理完：补了 c1 E1 的机判/);
  assert.ok(existsSync(join(dir, 'state', 'tune', `${id}.md`)));
});
