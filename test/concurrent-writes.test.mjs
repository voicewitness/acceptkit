// 并发写不丢别人的改动：阻塞台账按字段合并，设备租约只写本进程改了的条目、换了主人就拒绝。
// 两个模块实例（不同查询串）各有自己的读快照与库连接，模拟两个进程。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const tmp = () => mkdtempSync(join(tmpdir(), 'acceptkit-conc-'));

test('阻塞台账：一个进程拿旧副本关掉阻塞，不抹掉另一个进程刚写的答复', async () => {
  const A = await import('../core/plan-gate.mjs?a');
  const B = await import('../core/plan-gate.mjs?b');
  const root = tmp(); mkdirSync(join(root, 'state', 'blockers'), { recursive: true });
  A.raiseBlocker(root, { demand: 'D1', run: 'r1', caseName: 'c1', expect: 'E1', kind: 'dependency', text: '等配置', unlock: '' });
  const stale = A.readBlockers(root, 'D1');                 // 进程 A 读到：没有答复
  const fresh = B.readBlockers(root, 'D1');                 // 进程 B 写进 owner 的答复
  Object.assign(fresh[0], { answer: '先按旧配置测', answered_by: 'alice', answered_at: 'now' });
  B.writeBlockers(root, 'D1', fresh);
  Object.assign(stale[0], { resolved: true, resolved_by: 'tool' });   // 进程 A 拿旧副本关掉它
  A.writeBlockers(root, 'D1', stale);
  const [row] = B.readBlockers(root, 'D1');
  assert.equal(row.resolved, true);
  assert.equal(row.answer, '先按旧配置测');
  assert.equal(row.answered_by, 'alice');
});

test('设备租约：一个进程写回不抹掉另一个进程刚占的机器；读到后机器换了主人就拒绝', async () => {
  const A = await import('../core/store/db.mjs?a');
  const B = await import('../core/store/db.mjs?b');
  const root = tmp();
  const lease = run => ({ run, holder: 'h', platform: 'android', since: 't', heartbeat: 't', note: '' });
  const a = A.loadLeases(root);                 // A 读到空表
  const b = B.loadLeases(root);
  b['emulator-5554'] = lease('r2'); B.saveLeases(root, b);     // B 占了 5554
  a['emulator-5556'] = lease('r1'); A.saveLeases(root, a);     // A 拿旧快照占 5556
  assert.deepEqual(Object.keys(B.loadLeases(root)).sort(), ['emulator-5554', 'emulator-5556']);

  const a2 = A.loadLeases(root);
  const b2 = B.loadLeases(root);
  delete b2['emulator-5554']; B.saveLeases(root, b2);          // B 放掉 5554
  b2['emulator-5554'] = lease('r3'); B.saveLeases(root, b2);   // 别的 run 又占上
  a2['emulator-5554'] = lease('r1');                           // A 以为它还是 r2 的 / 空的
  assert.throws(() => A.saveLeases(root, a2), A.LeaseConflict);
  assert.equal(B.loadLeases(root)['emulator-5554'].run, 'r3');

  const a3 = A.loadLeases(root);
  B.saveLeases(root, { ...B.loadLeases(root), 'emulator-5554': lease('r4') });   // 换了主人
  delete a3['emulator-5554']; A.saveLeases(root, a3);          // A 想放掉的是旧主人那条：不动新主人的
  assert.equal(B.loadLeases(root)['emulator-5554'].run, 'r4');
});
