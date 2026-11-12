import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeParallel } from '../core/parallel.mjs';

const fits = { key: 'avd:A', run: 'r4', unfit: [] };
const lacks = { key: 'avd:A', run: 'r4', unfit: ['能力不满足：ram_mb=8192（要 12288）'] };
const why = '这一轮要 12G 内存跑全量链路';

test('一个需求一台设备：要第二台得给理由，工具核对', () => {
  // 没理由 / 理由太短 / 不认识的类型：拒，并告诉怎么接过原来那台
  for (const o of [{}, { kind: 'capability', why: '要' }, { kind: 'speed', why }]) {
    const j = judgeParallel({ ...o, current: lacks });
    assert.equal(j.ok, false);
    assert.match(j.why.join('\n'), /接过 avd:A/);
  }
  // capability：那台确实不满足才算
  assert.equal(judgeParallel({ kind: 'capability', why, current: fits }).ok, false);
  const ok = judgeParallel({ kind: 'capability', why, current: lacks });
  assert.equal(ok.ok, true);
  assert.equal(ok.record.with, 'avd:A');
  // case：用例里写了 parallel_devices.why 才算
  assert.equal(judgeParallel({ kind: 'case', why, current: fits, caseDecl: null }).ok, false);
  assert.equal(judgeParallel({ kind: 'case', why, current: fits, caseDecl: { why: '对比两种内存档位下的降级表现' } }).ok, true);
  // owner：要人和原话
  assert.equal(judgeParallel({ kind: 'owner', why, current: fits, approvedBy: 'owner' }).ok, false);
  assert.equal(judgeParallel({ kind: 'owner', why, current: fits, approvedBy: 'owner', quote: '两台一起跑' }).ok, true);
});
