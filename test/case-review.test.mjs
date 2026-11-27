// 用例评审：打包 → 盲审提交 → 核对（上限、复述、考题、信号）→ 状态与门槛
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'bin', 'acceptkit.mjs');
function project() {
  const dir = mkdtempSync(join(tmpdir(), 'acceptkit-review-'));
  for (const d of ['cases', 'state', 'ops']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'acceptkit.project.json'), JSON.stringify({ name: 't', gate: { allow: [] } }));
  writeFileSync(join(dir, 'ops', 'registry.json'), JSON.stringify({ ops: {
    'read-x': { title: '读结果页', kind: 'observe', why: 'w', reads: 'per-event', human: ['进入「结果」页', '看「状态」这一行'], platforms: { android: { how: 'h', state: 'confirmed' } } } } }));
  const c = { case: 'c', title: 't', platform: 'android', input: 'real',
    tree: [{ op: '在「设置」页点击「发送」', input: { from: 'real', why: '真实点击' },
      expect: [{ id: 'E1', assert: '状态是成功', because: { from: 'step', step: 'n1', input: '发送', why: '点了发送才会出结果' },
        see: ['进入「结果」页', '看「状态」这一行', '是「成功」'], observe: { op: 'read-x', checks: [{ pick: 'read.x', predicate: { eq: '成功' } }] } }] }] };
  writeFileSync(join(dir, 'cases', 'c.case.json'), JSON.stringify(c));
  const ak = (...a) => { const r = spawnSync(process.execPath, [BIN, ...a], { cwd: dir, encoding: 'utf8', env: { ...process.env, ACCEPTKIT_PROJECT: dir, HOME: dir } }); return { ...r, json: (() => { try { return JSON.parse(r.stdout); } catch { return null; } })() }; };
  return { dir, ak };
}
const EX = {
  A1: { where: '设置', do: '点击', input: '发送' }, A2: { decision: 'inline', why: '一次性的一步' }, A3: { from: 'real', why: '真实点击' },
  A4: { actions: ['点击「发送」'] }, A5: { deps: [] }, E1: { because: { from: 'step', step: 'n1', input: '发送', why: '点了发送才会出结果' } },
  E2: { page: '结果', row: '状态', pass_when: '成功' }, E3: { map: [{ claim: '状态是成功', check: 0 }], same: true },
  C1: { issues: [] }, C2: { pre: [] }, R1: { map: [{ surface: '发送', expect: 'E1' }] },
};
function answer(pack, over = {}) {
  const lines = [];
  for (const cd of pack.cases) for (const it of cd.items) {
    const ev = cd.facts.find(f => f.at === it.at || f.at === 'case');
    const isExam = !!pack.__canary?.has(it.key);
    const score = isExam ? 0 : Math.min(it.cap, 3);
    lines.push({ card: pack.card, key: it.key, fp: it.fp, score, extract: isExam ? { where: { app: true }, do: 'x', input: { none: true, why: 'x' } } : EX[it.dim],
      rulings: it.signals.map(s => ({ signal: s, ruling: 'accept', why: 'ok', evidence: [ev.id] })), reason: '照标准', evidence: [ev.id],
      ...(score < 3 ? { fix: `acceptkit clarify c --node n1 --op "进入「设置」页，点击「发送」"` } : {}), ...(isExam ? {} : over[it.dim] || {}) });
  }
  return lines;
}

test('评审：考题评高了整批拒收；越过上限 / 复述不是原文拒收；盲审才过门槛；改了用例就过期', async () => {
  const { dir, ak } = project();
  const pack = ak('assess', '--pack', '--case', 'c', '--json').json;
  assert.ok(pack.card); const cd = pack.cases[0];
  // 考题伪装成普通动作项：测试从库里读出哪些是考题（盲审看不到这张表）
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(dir, '.acceptkit', 'acceptkit.db'));
  const can = JSON.parse(db.prepare('SELECT canaries FROM review_cards WHERE id = ?').get(pack.card).canaries); db.close();
  pack.__canary = new Set(can.map(x => x.key));
  assert.ok(cd.items.filter(i => pack.__canary.has(i.key)).every(i => i.pos && /^[0-9a-f]{16}$/.test(i.fp)), '考题有位置编号和 16 位指纹，和真的动作项一样');
  assert.equal(cd.items.find(i => i.dim === 'A1' && !pack.__canary.has(i.key)).cap, 2, '界面字查不了（没登记被测仓）上限 2');
  // 考题打高：整批拒收
  const bad = answer(pack).map(l => pack.__canary.has(l.key) && /\|A1\|/.test(l.key) ? { ...l, score: 3 } : l);
  writeFileSync(join(dir, 'a.jsonl'), bad.map(l => JSON.stringify(l)).join('\n'));
  let r = ak('assess', '--apply', join(dir, 'a.jsonl'), '--by', 'blind', '--json').json;
  assert.equal(r.accepted, 0);
  // 越过上限、复述编造
  const lines = answer(pack, { A1: { score: 3 }, E2: { extract: { page: '首页', row: '状态', pass_when: '成功' } } });
  writeFileSync(join(dir, 'b.jsonl'), lines.map(l => JSON.stringify(l)).join('\n'));
  r = ak('assess', '--apply', join(dir, 'b.jsonl'), '--by', 'blind', '--json').json;
  const refused = r.results.filter(x => x.refused).map(x => x.refused).join('\n');
  assert.match(refused, /高过上限 2/); assert.match(refused, /page 要是 see/);
  // 自评：只算草稿
  writeFileSync(join(dir, 'c.jsonl'), answer(pack).map(l => JSON.stringify(l)).join('\n'));
  ak('assess', '--apply', join(dir, 'c.jsonl'), '--by', 'self', '--json');
  assert.equal(ak('assess', '--status', '--case', 'c', '--json').json.cases[0].status, 'draft');
  // 盲审全对：通过
  r = ak('assess', '--apply', join(dir, 'c.jsonl'), '--by', 'blind', '--json').json;
  assert.equal(r.refused, 0, JSON.stringify(r.results.filter(x => x.refused)));
  assert.equal(ak('assess', '--status', '--case', 'c', '--json').json.cases[0].status, 'pass');
  // 改了步骤：那一步的项过期
  const c = JSON.parse(readFileSync(join(dir, 'cases', 'c.case.json'), 'utf8')); c.tree[0].op = '在「设置」页点击「发送」两次'; writeFileSync(join(dir, 'cases', 'c.case.json'), JSON.stringify(c));
  const st = ak('assess', '--status', '--case', 'c', '--json').json.cases[0];
  assert.equal(st.status, 'stale'); assert.ok(st.low.some(x => x.dim === 'A1' && x.state === 'stale'));
});

test('评审事实：分组挂着操作、预期前没有能产生事件的动作、because 指向链外 —— 都是硬上限', async () => {
  const { caseCard } = await import('../core/case-review.mjs');
  const ops = { 'read-x': { title: 'r', kind: 'observe', reads: 'per-event', human: ['看「状态」'] }, 'plan-x': { title: 'p', kind: 'observe' } };
  const c = { case: 'c', tree: [
    { op: '执行注入计划「plan-x」（文件 probes/plan-x.json）', op_id: 'plan-x', children: [] },
    { op: 'D3 生成了第二段事件', kind: 'group', expect: [{ id: 'E1', assert: 'a', because: { from: 'step', step: 'n1', input: 'x', why: 'w' }, observe: { op: 'read-x', checks: [{ pick: 'read.x', predicate: { eq: '1' } }] } }] }] };
  const cd = caseCard(c, { ops, platform: 'android' });
  const cap = (dim, at) => cd.items.find(i => i.dim === dim && i.at === at).cap;
  assert.equal(cap('A1', 'n1'), 1, '动作挂了观测类操作');
  assert.equal(cap('E1', 'E1'), 0, 'because.step 不在这条预期的链上 / 前面没有产生事件的动作');
  assert.equal(cap('C1', 'case'), 0, '没有预期也没有下一步的动作');
  assert.ok(!cd.items.some(i => i.at === 'n2' && i.dim.startsWith('A')), '分组不评动作维度');
});

test('clarify --because-from step：按 nid 或位置编号指链上的动作；input 写进去；链外的拒收', () => {
  const { dir, ak } = project();
  const c = JSON.parse(readFileSync(join(dir, 'cases', 'c.case.json'), 'utf8')); delete c.tree[0].expect[0].because; c.tree[0].nid = 's1a2b';
  writeFileSync(join(dir, 'cases', 'c.case.json'), JSON.stringify(c));
  assert.match(ak('clarify', 'c', '--expect', 'E1', '--because-from', 'step', '--because-step', 'n9', '--because-input', '发送', '--why', 'w').stderr, /不是 E1 链上的动作/);
  assert.equal(ak('clarify', 'c', '--expect', 'E1', '--because-from', 'step', '--because-step', 's1a2b', '--because-input', '发送', '--why', '点了才有结果', '--role', 'claim').status, 0);
  const e = JSON.parse(readFileSync(join(dir, 'cases', 'c.case.json'), 'utf8')).tree[0].expect[0];
  assert.deepEqual(e.because, { from: 'step', step: 's1a2b', input: '发送', why: '点了才有结果' });
});

test('clarify --node --input：步骤自己声明触发来源（要理由），分组不收', () => {
  const { dir, ak } = project();
  assert.match(ak('clarify', 'c', '--node', 'n1', '--input', 'injected').stderr, /--why/);
  assert.equal(ak('clarify', 'c', '--node', 'n1', '--input', 'injected', '--why', '注入由观测操作代做，界面上没有输入入口').status, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'cases', 'c.case.json'), 'utf8')).tree[0].input, { from: 'injected', why: '注入由观测操作代做，界面上没有输入入口' });
});

test('clarify 前置条件：加 / 改 / 删，how 只能是 op:<操作> 或 manual，改前留底', () => {
  const { dir, ak } = project();
  const c = JSON.parse(readFileSync(join(dir, 'cases', 'c.case.json'), 'utf8')); c.preconditions = ['注入只喂字段']; writeFileSync(join(dir, 'cases', 'c.case.json'), JSON.stringify(c));
  assert.match(ak('clarify', 'c', '--precondition-set', 'new', '--text', '装包', '--how', 'op:nope', '--why', 'w').stderr, /不存在/);
  assert.equal(ak('clarify', 'c', '--precondition-set', 'new', '--text', '名单到达后再测', '--how', 'manual', '--why', '新装后名单到达前不命中').status, 0);
  assert.equal(ak('clarify', 'c', '--precondition-rm', '0', '--why', '步骤已全部换成真实请求').status, 0);
  const c2 = JSON.parse(readFileSync(join(dir, 'cases', 'c.case.json'), 'utf8'));
  assert.deepEqual(c2.preconditions, [{ text: '名单到达后再测', manual: { why: '新装后名单到达前不命中' } }]);
  assert.ok(c2.clarified.some(x => /删前置 #0/.test(x.what) && x.before.precondition.text === '注入只喂字段'));
});

test('子节点撤掉继承的配置集：沿链生效的配置去掉它，触发来源不再算 mock', async () => {
  const { chainConfigIds } = await import('../core/configsets.mjs');
  assert.deepEqual(chainConfigIds(['base'], [{ config: ['off'] }, { config_unset: ['off'] }]), ['base']);
  assert.deepEqual(chainConfigIds([], [{ config: ['off'] }, { config_unset: ['off'], config: ['on'] }]), ['on']);
});

test('clarify --add-node 加一步（新 nid），换观测操作时同一个操作的前提沿用', () => {
  const { dir, ak } = project();
  assert.equal(ak('clarify', 'c', '--add-node', 'n1', '--op', '点击「返回」回到首页').status, 0);
  const c = JSON.parse(readFileSync(join(dir, 'cases', 'c.case.json'), 'utf8'));
  const added = c.tree[0].children[0]; assert.equal(added.kind, 'action'); assert.match(added.nid, /^s[0-9a-f]{4}$/);
  c.tree[0].expect[0].observe.guards = [{ pick: 'read.ok', predicate: { eq: '1' } }]; writeFileSync(join(dir, 'cases', 'c.case.json'), JSON.stringify(c));
  assert.equal(ak('clarify', 'c', '--expect', 'E1', '--observe-op', 'read-x', '--checks', '[{"pick":"read.x","predicate":{"eq":"成功"}}]').status, 0);
  assert.ok(JSON.parse(readFileSync(join(dir, 'cases', 'c.case.json'), 'utf8')).tree[0].expect[0].observe.guards, '同一个观测操作，前提不丢');
});
