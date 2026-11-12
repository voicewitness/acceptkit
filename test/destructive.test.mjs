import { test } from 'node:test';
import assert from 'node:assert/strict';
import { destructiveKind, judgeDestructive } from '../core/destructive.mjs';
import { configProblems } from '../core/config-edit.mjs';

const reasons = [{ id: 'sig-mismatch', actions: ['uninstall'], when: '覆盖安装报签名不一致', why: '签名不同的包装不上，只能先卸', purpose: '装上本轮要验的包',
  evidence: 'INSTALL_FAILED_UPDATE_INCOMPATIBLE', approved_by: 'owner', quote: '签名不一致就卸了重装' }];

test('卸载 / 清数据：要点名一条业务登记的理由并写清现场，理由要的证据要在；装包不算', () => {
  assert.equal(destructiveKind('覆盖安装 v0.0.3'), null);
  assert.equal(destructiveKind('卸载旧包后重装'), 'uninstall');
  assert.equal(destructiveKind('pm clear 清数据'), 'clear');
  // 否定的说法不算卸载 / 清数据
  for (const t of ['install -r CI 新包，覆盖安装不卸载', '覆盖安装，无需清数据', 'reinstall without uninstall', 'install -r, no clear data']) assert.equal(destructiveKind(t), null, t);
  assert.equal(destructiveKind('签名不一致装不上，先卸载再重装'), 'uninstall');
  const sig = 'adb: failed to install: Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: ...]';
  const why = '覆盖安装失败，签名和机上旧包不同';
  // 没给理由 / 现场太短 / 理由不存在 / 不覆盖这个动作 / 证据不对：都拒，并列出能用的理由
  for (const opt of [{}, { reason: 'sig-mismatch', why: '要卸' }, { reason: 'nope', why }, { reason: 'sig-mismatch', why, evidenceText: 'Success' }]) {
    const j = judgeDestructive('uninstall', { reasons, opt });
    assert.equal(j.ok, false, JSON.stringify(opt));
    assert.match(j.why.join('\n'), /sig-mismatch：覆盖安装报签名不一致/);
  }
  assert.match(judgeDestructive('clear', { reasons, opt: { reason: 'sig-mismatch', why } }).why.join('\n'), /不覆盖清数据/);
  const ok = judgeDestructive('uninstall', { reasons, opt: { reason: 'sig-mismatch', why, evidenceText: sig } });
  assert.equal(ok.ok, true);
  assert.equal(ok.record.reason, 'sig-mismatch');
  // 用例要求全新安装：用例经评审单批过，算理由；没写的用例不能拿来当理由
  assert.equal(judgeDestructive('uninstall', { caseNeeds: [{ id: 'E1', why: '验首次安装引导' }], opt: { reason: 'case', why: '这条用例要验首次安装引导' } }).ok, true);
  assert.equal(judgeDestructive('uninstall', { opt: { reason: 'case', why: '这条用例要验首次安装引导' } }).ok, false);
  // 都不覆盖时 owner 当场同意：要原话
  assert.equal(judgeDestructive('clear', { opt: { approvedBy: 'owner' } }).ok, false);
  assert.equal(judgeDestructive('clear', { opt: { approvedBy: 'owner', quote: '清吧' } }).ok, true);
});

test('登记理由要写全：什么情况、为什么必须、为了什么；证据特征不能什么都匹配；不用 owner 逐条批', () => {
  const probs = cfg => configProblems({ gate: { allow: [], reasons: cfg } }).map(p => p.msg || p).join('\n');
  assert.equal(probs(reasons), '');
  assert.match(probs([{ ...reasons[0], purpose: '' }]), /缺 purpose/);
  assert.equal(probs([{ ...reasons[0], quote: undefined, approved_by: undefined, by: 'executor' }]), '');
  assert.match(probs([{ ...reasons[0], evidence: '.+' }]), /什么都能匹配/);
  assert.match(probs([{ ...reasons[0], when: '需要时' }]), /具体情况/);
  assert.match(probs([{ ...reasons[0], id: 'case' }]), /case 留给用例/);
});
