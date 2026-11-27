// 执行缓存：跑通一次自动建缓存 → 下次回放、跟上次一致 → 被测物变了时回放差别大，自己作废缓存、退回待测 →
// 正常流程重判完核对（被测物真变了 / 缓存的毛病），并用这次正常跑的重建缓存。不改用例、不改操作配方
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'bin', 'acceptkit.mjs');

test('执行缓存：建、回放、差别大自己作废并核对、重建', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acceptkit-test-'));
  for (const d of ['cases', 'runs', 'state/plans', 'knowledge', 'ops']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'acceptkit.project.json'), JSON.stringify({ name: 't', gate: { allow: [] } }));
  const obs = { op: 'read-json', params: { file: 'evidence/out.json' }, checks: [{ pick: 'ok', predicate: { eq: true } }] };
  writeFileSync(join(dir, 'cases', 'c1.case.json'), JSON.stringify({ case: 'c1', title: '保存', platform: 'web', classifications: { carrier: ['web'] },
    tree: [{ op: '打开「evidence/out.json」', tags: { carrier: 'web' }, expect: [{ id: 'E1', assert: '产物里 ok 为 true', via: 'cli', why_not_ui: '示例', observe: obs, see: ['打开「evidence/out.json」，看「ok」是不是 true'] }] }] }));
  writeFileSync(join(dir, 'ops', 'registry.json'), JSON.stringify({ ops: { 'read-json': { kind: 'observe', title: '读产物', why: 'w', observes: 'state', platforms: { web: { exec: 'json-file', strength: 'S2', state: 'confirmed' } } } } }));
  writeFileSync(join(dir, 'state', 'plans', 'D1.json'), JSON.stringify({ demand: 'D1', title: '测', platform: 'web', revision: 1,
    surfaces: [{ id: 'S1', change: 'x', reuse: ['c1'], new: [], ops: [] }], not_covered: [], history: [],
    approved_by: 'tester', approved_at: new Date().toISOString(), created_at: new Date().toISOString() }));
  const ak = (...a) => spawnSync(process.execPath, [BIN, ...a], { cwd: dir, encoding: 'utf8', env: { ...process.env, ACCEPTKIT_PROJECT: dir, HOME: dir } });
  const newRun = ok => { const before = new Set(readdirSync(join(dir, 'runs'))); const x = ak('run', 'c1', '--demand', 'D1'); assert.equal(x.status, 0, x.stderr);
    const run = readdirSync(join(dir, 'runs')).find(d => !before.has(d));
    mkdirSync(join(dir, 'runs', run, 'evidence'), { recursive: true });
    writeFileSync(join(dir, 'runs', run, 'evidence', 'out.json'), JSON.stringify({ ok }));
    mkdirSync(join(dir, 'runs', run, 'shots'), { recursive: true });
    writeFileSync(join(dir, 'runs', run, 'shots', 'app-01-home.png'), Buffer.alloc(512, 1));
    writeFileSync(join(dir, 'runs', run, 'shots', 'app-01-home.json'), JSON.stringify({ kind: 'process_shot', platform: 'web', at: '2026-01-01T00:00:00Z' }));
    return run; };
  const res = run => JSON.parse(readFileSync(join(dir, 'runs', run, 'result.json'), 'utf8'));
  const cards = () => JSON.parse(ak('next', 'D1', '--json').stdout).cards;

  // 第一次：正常跑通 → 执行日志里有这条 observe → 自动建缓存
  const r1 = newRun(true);
  const o1 = ak('observe', r1);
  assert.match(o1.stderr, /执行缓存已更新/);
  const cache = JSON.parse(readFileSync(join(dir, 'state', 'cache', 'c1.json'), 'utf8'));
  assert.equal(cache.from_run, r1); assert.deepEqual(cache.path, ['observe']);
  assert.equal(cache.steps[0].argv[0], 'observe');

  // 第二次：next 先让回放；回放跟上次一致，结论由工具判出来，时间线标成回放
  const r2 = newRun(true);
  assert.ok(cards().some(c => c.kind === 'replay_due' && c.run === r2));
  const p2 = ak('replay', r2);
  assert.equal(p2.status, 0, p2.stderr); assert.match(p2.stdout, /回放完，跟上次一致/);
  assert.equal(res(r2).results.E1.status, 'pass');
  assert.equal(res(r2).replay.ok, true);
  assert.ok(res(r2).timeline.some(e => e.id === 'E1' && e.how === 'replay'));
  assert.notEqual(ak('replay', r2).status, 0, '同一个运行不回放两次');

  // 第三次：被测物变了（ok=false）→ 回放判出 fail，跟上次不一样 → 作废缓存、回放判出的结论退回待测
  const r3 = newRun(false);
  const p3 = ak('replay', r3);
  assert.match(p3.stdout, /跟上次差别大，缓存已作废[\s\S]*E1 pass→fail/);
  assert.equal(res(r3).results.E1.status, 'todo', '回放判出的不算数');
  assert.ok(!existsSync(join(dir, 'state', 'cache', 'c1.json')), '缓存作废');
  assert.ok(readdirSync(join(dir, 'state', 'cache')).some(f => f.startsWith('c1.dropped-')), '留档不删');
  assert.ok(!cards().some(c => c.kind === 'replay_due'), '作废了就不再让回放');
  // 正常流程重判：还是 fail → 核对结论「被测物真变了」，并用这次正常跑的重建缓存
  const o3 = ak('observe', r3);
  assert.match(o3.stderr, /执行缓存核对（c1）：正常跑出来跟回放一样：差别是被测物真变了/);
  assert.match(o3.stderr, /执行缓存已更新/);
  const log = readFileSync(join(dir, 'state', 'cache', 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.deepEqual(log.map(x => x.kind), ['replayed', 'dropped', 'checked']);
  assert.equal(log[2].verdict, 'real_change');

  // 第四次：回放判出的跟正常重判的不一样 → 记成缓存的毛病（例：回放时读到的是上一轮残留的状态）
  const r4 = newRun(true);
  assert.match(ak('replay', r4).stdout, /E1 fail→pass/);
  writeFileSync(join(dir, 'runs', r4, 'evidence', 'out.json'), JSON.stringify({ ok: false }));
  assert.match(ak('observe', r4).stderr, /正常跑出来跟回放不一样：E1 回放 pass \/ 正常 fail/);
  const last = readFileSync(join(dir, 'state', 'cache', 'log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).at(-1);
  assert.equal(last.verdict, 'cache_bug');
  // 日志机制之前开的运行（没有开跑时刻）：日志只有后半段，不拿来建缓存
  const { cacheable } = await import('../core/replay.mjs');
  const old = res(r1); delete old.created_at; old.timeline = old.timeline.filter(e => e.kind !== 'created');
  assert.equal(cacheable(dir, r1, old), null);
});
