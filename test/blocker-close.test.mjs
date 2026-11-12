// 阻塞项自动关 + 帮助文本收口（docs/design/003-changes.md G）。
// 断言后来记成 pass / fail / na：卡它的阻塞项由工具关闭，写清是哪个运行的哪条结论关的；next 不再显示它。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { closeBlockersFor, readBlockers, writeBlockers } from '../core/plan-gate.mjs';

const BIN = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'bin', 'acceptkit.mjs');
const ak = (dir, ...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, ACCEPTKIT_PROJECT: dir, HOME: dir } });
const ok = (dir, ...args) => { const r = ak(dir, ...args); assert.equal(r.status, 0, `${args.join(' ')}\n${r.stderr}`); return r; };
const cards = dir => JSON.parse(ok(dir, 'next', 'D1', '--json').stdout).cards;
const ledger = dir => readFileSync(join(dir, 'state/blockers/D1.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'acceptkit-test-'));
  for (const d of ['cases', 'runs', 'state/plans', 'knowledge', 'ops']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'acceptkit.project.json'), JSON.stringify({ name: 't', gate: { allow: [] } }));
  writeFileSync(join(dir, 'cases', 'c1.case.json'), JSON.stringify({ case: 'c1', title: '首页问候语', platform: 'web',
    classifications: { carrier: ['page'] },
    tree: [{ op: '打开首页', tags: { carrier: 'page' }, expect: [{ id: 'E1', assert: '页面顶部显示「你好」' }] }] }));
  ok(dir, 'plan', 'new', 'D1', '--title', '首页问候', '--platform', 'web');
  ok(dir, 'plan', 'add-case', 'D1', '--surface', 'S1', '--change', '首页加了问候语', '--reuse', 'c1', '--risk', '看不到问候', '--uncovered', '其他页');
  ok(dir, 'plan', 'approve', 'D1', '--by', 'owner', '--quote', '可以');
  return dir;
}
const newRun = dir => { const before = new Set(readdirSync(join(dir, 'runs'))); ok(dir, 'run', 'c1', '--demand', 'D1'); return readdirSync(join(dir, 'runs')).find(x => !before.has(x)); };
const block = (dir, run) => ok(dir, 'record', run, '--expect', 'E1', '--status', 'blocked', '--blocked-kind', 'dependency', '--actual', '测试环境挂了', '--unlock', '等测试环境恢复');
// 测试里不碰浏览器：放一张带工具记录的过程截图，当作 shot 截的（记 pass 要有 app 截图）
function pass(dir, run, status = 'pass') {
  mkdirSync(join(dir, 'runs', run, 'shots'), { recursive: true });
  writeFileSync(join(dir, 'runs', run, 'shots', 'app-01-home.png'), Buffer.alloc(512, 1));
  writeFileSync(join(dir, 'runs', run, 'shots', 'app-01-home.json'), JSON.stringify({ kind: 'process_shot', platform: 'web', at: '2026-01-01T00:00:00Z' }));
  ok(dir, 'record', run, '--step', 'n1', '--evidence', 'shots/app-01-home.png');
  mkdirSync(join(dir, 'runs', run, 'evidence'), { recursive: true });
  writeFileSync(join(dir, 'runs', run, 'evidence', 'page.txt'), '页面顶部：你好\n');
  return ok(dir, 'record', run, '--expect', 'E1', '--status', status, '--evidence', 'evidence/page.txt', '--quote', '你好');
}

test('同一运行里断言后来记成 pass：已提未答的阻塞项由工具关闭，next 和台账都不再把它当阻塞', () => {
  const dir = project();
  const run = newRun(dir);
  block(dir, run);
  ok(dir, 'blockers', 'D1', '--set', 'B1', '--ask', '测试环境什么时候能恢复，要不要先跳过？', '--why-you', '环境归测试平台组管，我没有权限', '--option', '等恢复再测 => 晚一天出结论', '--option', '本轮跳过 => 报告里写明没测', '--recommend', '等恢复：只差一天');
  ok(dir, 'blockers', 'D1', '--raise');
  assert.ok(cards(dir).some(c => c.kind === 'attention' && c.subject === 'blocker'));

  const r = pass(dir, run);
  assert.match(r.stderr, /B1 已由工具关闭/);
  const [b] = ledger(dir);
  assert.equal(b.resolved, true);
  assert.equal(b.resolved_by, 'tool');
  assert.equal(b.resolved_how, `工具关闭：运行 ${run} 的 E1 记成了 pass`);
  assert.ok(!cards(dir).some(c => c.subject === 'blocker' || c.blocker), 'next 不再显示它');
  assert.match(ok(dir, 'blockers', 'D1').stdout, /工具关闭（1）[\s\S]*运行 .* 的 E1 记成了 pass/);
  // --json 列台账：卡片状态是 resolved，note 写明怎么关的
  const listed = JSON.parse(ok(dir, 'blockers', 'D1', '--json').stdout).results;
  assert.equal(listed[0].status, 'resolved');
  assert.match(listed[0].note, /工具关闭/);

  // 又记回 blocked：重开同一条，不再带着「工具关闭」的痕迹
  block(dir, run);
  const [again] = ledger(dir);
  assert.equal(again.resolved, false);
  assert.equal(again.resolved_by, null);
  assert.ok(cards(dir).some(c => c.kind === 'attention' && c.subject === 'blocker'));
});

test('没提过的阻塞，断言记成 fail 也关（不会再出 blocker_own 让执行者 --resolve）；skip 不关', () => {
  const dir = project();
  const run = newRun(dir);
  block(dir, run);
  ok(dir, 'record', run, '--expect', 'E1', '--status', 'skip', '--actual', '这轮先不测');
  assert.ok(!ledger(dir)[0].resolved, 'skip 不是结论，不关');
  assert.ok(cards(dir).some(c => c.kind === 'blocker_own'), '关之前：没提过的旧阻塞要执行者处理');
  pass(dir, run, 'fail');
  const [b] = ledger(dir);
  assert.equal(b.resolved_by, 'tool');
  assert.match(b.resolved_how, /E1 记成了 fail/);
  assert.ok(!cards(dir).some(c => c.kind === 'blocker_own'));
});

test('closeBlockersFor：na 也关；只关同一条断言；todo / blocked / skip 不关', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acceptkit-test-'));
  writeBlockers(dir, 'D1', [
    { id: 'B1', run: 'R1', case: 'c1', expect: 'E1', kind: 'dependency', reported: true },
    { id: 'B2', run: 'R1', case: 'c1', expect: 'E2', kind: 'dependency', reported: false },
  ]);
  for (const status of ['todo', 'blocked', 'skip'])
    assert.deepEqual(closeBlockersFor(dir, { demand: 'D1', run: 'R1', caseName: 'c1', expect: 'E1', status }), []);
  const hit = closeBlockersFor(dir, { demand: 'D1', run: 'R1', caseName: 'c1', expect: 'E1', status: 'na' });
  assert.deepEqual(hit.map(b => b.id), ['B1']);
  const now = readBlockers(dir, 'D1');
  assert.equal(now[0].resolved_how, '工具关闭：运行 R1 的 E1 记成了 na');
  assert.ok(!now[1].resolved, '别的断言上的阻塞不动');
});

test('同一用例的新运行记成 pass：更早运行上的阻塞也关；新运行上的阻塞不被旧运行的结论关掉', () => {
  const dir = project();
  const r1 = newRun(dir);
  block(dir, r1);
  const r2 = newRun(dir);
  pass(dir, r2);
  const [b1] = ledger(dir);
  assert.equal(b1.run, r1);
  assert.equal(b1.resolved_by, 'tool');
  assert.equal(b1.resolved_how, `工具关闭：运行 ${r2} 的 E1 记成了 pass`);

  // 反过来：新运行 r3 阻塞，回头给旧运行 r1 记结论，不关 r3 的
  const r3 = newRun(dir);
  block(dir, r3);
  pass(dir, r1);
  const b3 = ledger(dir).find(b => b.run === r3);
  assert.ok(!b3.resolved);
});

test('帮助文本：plan 子命令列全，不再指向已废弃的子命令', () => {
  const dir = project();
  const help = ok(dir, 'engine-help').stdout;
  assert.match(help, /plan <new\|show\|review\|check\|approve\|return\|add-case\|finding\|decide\|bounce\|settle\|recheck>/);
  assert.doesNotMatch(help, /not-covered|set-pending|不覆盖/);
  assert.match(help, /工具自动关闭/);
  const bad = ak(dir, 'plan', 'nope', 'D1');
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /decide\|bounce\|settle/);
  // 已有评审单时 plan new 的提示不再指向 not-covered
  assert.doesNotMatch(ak(dir, 'plan', 'new', 'D1').stderr, /not-covered/);
});
