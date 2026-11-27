// 提问闸：要 owner 回答的事只有一个入口；项目知识里写过不问的、答过的、执行者自己的活都拒收；放行的要能拍板；待答的汇总成一张卡；聊天里直接问会被停钩子打回
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { askCheck, WAIT_OWNER, HAS_ASK_ID } from '../core/ask-gate.mjs';

const BIN = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'bin', 'acceptkit.mjs');
function proj() {
  const dir = mkdtempSync(join(tmpdir(), 'acceptkit-test-'));
  for (const d of ['cases', 'runs', 'state/plans', 'knowledge', 'ops']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'acceptkit.project.json'), JSON.stringify({ name: 't', gate: { allow: [] } }));
  writeFileSync(join(dir, 'knowledge', 'notes.md'), '## 账号\n\n- 测试账号登录（normal / km2 等 account 里登记的号）由执行者自己做：account get 取值直接喂给设备，不问 owner\n');
  writeFileSync(join(dir, 'state', 'plans', 'D1.json'), JSON.stringify({ demand: 'D1', title: '测', platform: 'android', revision: 1, surfaces: [], history: [],
    findings: [{ id: 'F1', what: '线下审计工具会拆掉在跑的引擎', decide: '这次修还是记为已知限制', decision: '记为已知限制', decided_by: 'owner' }] }));
  return dir;
}

test('该不该问：项目知识写过的、答过的、执行者自己的活拒收；要新账号、改行为放行', () => {
  const dir = proj(), plan = JSON.parse(spawnSync('cat', [join(dir, 'state/plans/D1.json')], { encoding: 'utf8' }).stdout);
  const r1 = askCheck(dir, 'D1', '能不能在共享模拟器上登录 km2 测试账号？', { plan });
  assert.equal(r1.why, 'project_rule'); assert.match(r1.msg, /knowledge\/notes\.md:3/);
  assert.equal(askCheck(dir, 'D1', '线下审计工具会拆掉在跑的引擎，这次修还是记为已知限制？', { plan }).why, 'answered');
  assert.equal(askCheck(dir, 'D1', '要不要重跑一遍这条用例？', { plan }).why, 'executor_owns');
  assert.equal(askCheck(dir, 'D1', '要不要重跑一遍这条用例？', { plan, notMine: '重跑要占用 QA 共享设备一整天，排期是 QA 的' }).ok, true);
  assert.equal(askCheck(dir, 'D1', '测试账号是你给一个，还是这条先不测？', { plan }).ok, true);
  assert.equal(askCheck(dir, 'D1', '内置策略在老链上不生效，是改产品还是缩验收范围？', { plan }).ok, true);
  // 规则管的是「登录」：问的是要不要找业务方要账号类策略的真实入口，不是一件事
  assert.equal(askCheck(dir, 'D1', '这 7 条账号类策略用 km2 测试账号也触发不了，要不要去找业务方要真实触发入口？', { plan }).ok, true);
  // 命中了项目规则、执行者确认不是：写理由放行，记下越过的是哪条
  const o = askCheck(dir, 'D1', '能不能在共享模拟器上登录 km2 测试账号？', { plan, notMine: '这台是 QA 共享机，登录会顶掉 QA 正在用的号' });
  assert.equal(o.ok, true); assert.match(o.overrode, /notes\.md:3/);
});

test('ask 命令：放行的要能拍板；拿到编号；待答汇总成一张卡；答复只认本人', () => {
  const dir = proj();
  const ak = (...a) => spawnSync(process.execPath, [BIN, ...a], { cwd: dir, encoding: 'utf8', env: { ...process.env, ACCEPTKIT_PROJECT: dir, HOME: dir } });
  assert.match(ak('ask', 'D1', '--question', '能不能登录 km2 测试账号？', '--kind', 'risk', '--context', 'x').stderr, /不该问 owner.*不问 owner/);
  assert.match(ak('ask', 'D1', '--question', '内置策略在老链上不生效，改产品还是缩范围？', '--kind', 'behavior').stderr, /--context[\s\S]*--option/);
  const ok = ak('ask', 'D1', '--question', '内置策略在老链上不生效，改产品还是缩范围？', '--kind', 'behavior', '--context', '调度关时老链不执行内置策略，三轮复现',
    '--why-you', '要不要修是产品范围', '--option', '修 => 本版本延期两天', '--option', '缩范围 => 报告写明老链不覆盖', '--recommend', '修：老链是降级兜底');
  assert.equal(ok.status, 0, ok.stderr); assert.match(ok.stdout, /Q1/);
  const cards = JSON.parse(ak('next', 'D1', '--json').stdout).cards.filter(c => c.subject === 'asks');
  assert.equal(cards.length, 1); assert.match(cards[0].title, /待 owner 答 1 条（Q1）/); assert.match(cards[0].question, /1\. 修 => 本版本延期两天/);
  assert.notEqual(ak('ask', 'answer', 'D1', 'Q1', '--quote', '修').status, 0);
  assert.equal(ak('ask', 'answer', 'D1', 'Q1', '--by', 'owner', '--quote', '修吧').status, 0);
  assert.ok(!JSON.parse(ak('next', 'D1', '--json').stdout).cards.some(c => c.subject === 'asks'));
  // 同一件事答过：再问拒收
  assert.match(ak('ask', 'D1', '--question', '内置策略在老链上不生效，改产品还是缩范围？', '--kind', 'behavior', '--context', '调度关时老链不执行内置策略',
    '--why-you', 'x', '--option', 'a => b', '--option', 'c => d', '--recommend', '修吧').stderr, /Q1 已经答过/);
});

test('回复里在等 owner、没带编号：认得出', () => {
  assert.ok(WAIT_OWNER.test('KM 账号要不要我登录？等你确认'));
  assert.ok(!HAS_ASK_ID.test('等你确认'));
  assert.ok(HAS_ASK_ID.test('待答 1 条（Q1）'));
  assert.ok(!WAIT_OWNER.test('已完成 3 条，继续跑下一条'));
});
