// owner 的答复被写进阻塞项的解锁条件（「owner MM-DD：…」），却没用 --ack 记成答复，于是它又出现在「等你」里。
// 实例：owner 当面答过「这两组先记进附录收口」，几天后看板上仍在问他。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ownerQuoteIn } from '../core/next.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(REPO, 'bin', 'acceptkit.mjs');

test('ownerQuoteIn finds a dated or verbatim owner quote and ignores a bare mention of owner', () => {
  assert.equal(ownerQuoteIn('retest on the staging build; owner 1-2：暂缺两组先记入设计文档附录'), 'owner 1-2：暂缺两组先记入设计文档附录');
  assert.equal(ownerQuoteIn('owner 2000-1-2 说：没有就没有'), 'owner 2000-1-2 说：没有就没有');
  assert.equal(ownerQuoteIn('owner 原话：没有路由的就不用测'), 'owner 原话：没有路由的就不用测');
  assert.equal(ownerQuoteIn('补它要改用例资产的判据面，归 owner 定 —— 见 finding F76'), null);
  assert.equal(ownerQuoteIn('问 owner 要不要'), null);
  assert.equal(ownerQuoteIn(''), null);
});

function project(unlock) {
  const dir = mkdtempSync(join(tmpdir(), 'acceptkit-oq-'));
  for (const d of ['cases', 'runs/r1', 'state/blockers', 'state/plans', 'knowledge', 'ops']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'acceptkit.project.json'), JSON.stringify({ name: 't', gate: { allow: [] } }));
  writeFileSync(join(dir, 'runs/r1/result.json'), JSON.stringify({ case: 'c', run: 'r1', demand: 'D1', results: { E1: { status: 'blocked' } }, steps: {} }));
  writeFileSync(join(dir, 'state/blockers/D1.jsonl'), JSON.stringify({ id: 'B1', at: '2026-11-04T00:00:00Z', demand: 'D1', run: 'r1', case: 'c', expect: 'E1',
    kind: 'dependency', text: 'two groups only on the staging build', unlock, reported: true, raised_at: '2026-11-06T00:00:00Z', answer: null,
    ask: { question: 'Close it via the design-doc appendix as you said earlier?', why: 'host routing is not this change',
      options: [{ label: 'close via appendix', effect: 'closed' }, { label: 'measure on device', effect: 'retest' }], recommend: 'first' } }) + '\n');
  const made = spawnSync(process.execPath, [BIN, 'plan', 'new', 'D1', '--title', 't', '--platform', 'android'], { cwd: dir, encoding: 'utf8', env: { ...process.env, ACCEPTKIT_PROJECT: dir } });
  assert.equal(made.status, 0, made.stderr);
  return dir;
}
const cards = dir => {
  const r = spawnSync(process.execPath, [BIN, 'next', 'D1', '--json'], { cwd: dir, encoding: 'utf8', env: { ...process.env, ACCEPTKIT_PROJECT: dir } });
  const d = JSON.parse(r.stdout || '{}');
  return (Array.isArray(d) ? d : d.cards || []);
};
const mentionsB1 = c => JSON.stringify(c).includes('"B1"');

test('a blocker whose unlock already quotes the owner is not asked again; it becomes an executor to-do', () => {
  const got = cards(project('retest on the staging build; owner 1-2：暂缺两组先记入设计文档附录'));
  assert.ok(!got.some(c => c.kind === 'attention' && mentionsB1(c)), 'must not ask the owner a question he already answered');
  const own = got.find(c => c.kind === 'blocker_own' && mentionsB1(c));
  assert.ok(own, 'the executor gets a card to record the quoted answer');
  assert.match(own.note, /--ack B1/);
});

test('control: without an owner quote the same blocker is still asked', () => {
  const got = cards(project('route to Pro then retest'));
  assert.ok(got.some(c => c.kind === 'attention' && mentionsB1(c)), 'positive control: the question still reaches the owner');
});
