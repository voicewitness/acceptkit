// 阻塞台账的并发写与答复留存（实测：owner 同一个问题被问了很多轮）。
// 三个病根各一条测试：① 拿旧副本整份写回会抹掉别人刚写的答复；② 新运行里同一条断言再卡住时当成新问题；
// ③ 同一个问题卡住一组断言，却只能逐条答。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GATE = join(REPO, 'core', 'plan-gate.mjs');
const BIN = join(REPO, 'bin', 'acceptkit.mjs');

function root() {
  const dir = mkdtempSync(join(tmpdir(), 'acceptkit-ledger-'));
  for (const d of ['cases', 'runs', 'state/blockers', 'knowledge', 'ops']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'acceptkit.project.json'), JSON.stringify({ name: 't', gate: { allow: [] } }));
  return dir;
}
const node = (code, cwd) => spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd, encoding: 'utf8' });
const rows = dir => readFileSync(join(dir, 'state/blockers/D1.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

function seed(dir, list) {
  writeFileSync(join(dir, 'state/blockers/D1.jsonl'), list.map(x => JSON.stringify(x)).join('\n') + '\n');
}
const B = (id, extra = {}) => ({ id, at: '2026-11-01T00:00:00Z', demand: 'D1', run: 'r1', case: 'c', expect: 'E' + id.slice(1),
  kind: 'dependency', text: 't', unlock: 'u', reported: true, raised_at: '2026-11-01T00:00:00Z', answer: null, answered_at: null, ...extra });

test('a stale copy written back does not erase an answer another process just recorded', () => {
  const dir = root(); seed(dir, [B('B1'), B('B2')]);
  // 进程 A 先读（拿到旧副本），进程 B 记下 owner 的答复，A 再改另一行并写回
  const r = node(`
    import { readBlockers, writeBlockers } from ${JSON.stringify(GATE)};
    import { spawnSync } from 'node:child_process';
    const all = readBlockers(${JSON.stringify(dir)}, 'D1');
    const other = spawnSync(process.execPath, ['--input-type=module', '-e', \`
      import { readBlockers, writeBlockers } from ${JSON.stringify(GATE)};
      const a = readBlockers(${JSON.stringify(dir)}, 'D1'); a.find(x => x.id === 'B1').answer = 'owner said skip'; writeBlockers(${JSON.stringify(dir)}, 'D1', a);\`]);
    if (other.status !== 0) throw new Error(String(other.stderr));
    all.find(x => x.id === 'B2').unlock = 'changed by A';
    writeBlockers(${JSON.stringify(dir)}, 'D1', all);`, dir);
  assert.equal(r.status, 0, r.stderr);
  const got = rows(dir);
  assert.equal(got.find(x => x.id === 'B1').answer, 'owner said skip', 'the answer must survive A writing its stale copy');
  assert.equal(got.find(x => x.id === 'B2').unlock, 'changed by A');
});

test('a new run blocked on the same case/expect inherits the owner answer instead of asking again', () => {
  const dir = root(); seed(dir, [B('B1', { answer: 'not rolled out, do not test', answered_at: '2026-10-30T07:14:00Z', answered_by: 'owner' })]);
  const r = node(`
    import { raiseBlocker } from ${JSON.stringify(GATE)};
    const b = raiseBlocker(${JSON.stringify(dir)}, { demand: 'D1', run: 'r2', caseName: 'c', expect: 'E1', kind: 'dependency', text: 't', unlock: 'u' });
    console.log(JSON.stringify(b));`, dir);
  assert.equal(r.status, 0, r.stderr);
  const b = JSON.parse(r.stdout);
  assert.equal(b.id, 'B2');
  assert.equal(b.answer, 'not rolled out, do not test');
  assert.equal(b.answer_inherited_from, 'B1');
  assert.equal(b.reported, true);
});

test('a new run blocked on the same expect for a different reason is a new question, not the old answer', () => {
  const dir = root(); seed(dir, [B('B1', { answer: 'not rolled out, do not test', answered_at: '2026-10-30T07:14:00Z', answered_by: 'owner' })]);
  const r = node(`
    import { raiseBlocker } from ${JSON.stringify(GATE)};
    const other = raiseBlocker(${JSON.stringify(dir)}, { demand: 'D1', run: 'r2', caseName: 'c', expect: 'E1', kind: 'dependency', text: 'backend is down', unlock: 'u' });
    const kind = raiseBlocker(${JSON.stringify(dir)}, { demand: 'D1', run: 'r3', caseName: 'c', expect: 'E1', kind: 'capability', text: 't', unlock: 'u' });
    console.log(JSON.stringify([other, kind]));`, dir);
  assert.equal(r.status, 0, r.stderr);
  for (const b of JSON.parse(r.stdout)) {
    assert.equal(b.answer, null, `${b.id} must not reuse an answer to a different question`);
    assert.equal(b.answer_inherited_from, undefined);
    assert.equal(b.reported, false, 'it still has to be raised to the owner');
  }
});

test('blockers --ack takes a comma list and confirms by reading back', () => {
  const dir = root(); seed(dir, [B('B1'), B('B2'), B('B3')]);
  const r = spawnSync(process.execPath, [BIN, 'blockers', 'D1', '--ack', 'B1,B2', '--answer', 'skip these', '--by', 'owner'],
    { cwd: dir, encoding: 'utf8', env: { ...process.env, ACCEPTKIT_PROJECT: dir } });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const got = rows(dir);
  assert.equal(got.find(x => x.id === 'B1').answer, 'skip these');
  assert.equal(got.find(x => x.id === 'B2').answer, 'skip these');
  assert.equal(got.find(x => x.id === 'B3').answer, null);
});
