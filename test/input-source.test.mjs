// 触发方式：操作树上每一步怎么触发被测系统。说不清就不算真实；一条用例 / 一个改动面有注入、没有真实触发就不通过；
// 手写的输入字段要说清全局还是调用点；用例评审时 consult 读被测代码给线索，执行者写测法建议，owner 定改不改
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkCase } from '../core/case-quality.mjs';
import { caseInputs, literalFields } from '../core/input-source.mjs';
import { score, assessCasePre } from '../core/assess.mjs';

const OPS = {
  'inject-x': { title: '注入', why: 'w', input: 'injected', platforms: { android: { how: 'h', state: 'confirmed' } } },
  'real-x': { title: '真实', why: 'w', input: 'real', platforms: { android: { how: 'h', state: 'confirmed' } } },
  'read-x': { title: '读', why: 'w', kind: 'observe', platforms: { android: { exec: 'ui', state: 'confirmed' } } },
};
const ob = { op: 'read-x', checks: [{ pick: 'a', predicate: { eq: 'b' } }] };
const mk = (tree, extra = {}) => ({ case: 'c', title: 't', platform: 'android', tree, ...extra });
const node = (op, expect, more = {}) => ({ op, expect, ...more });
const rules = (c, id) => checkCase(c, { ops: OPS }).filter(f => f.rule === id);
const from = c => Object.fromEntries(caseInputs(c, OPS).map(x => [x.id, x.from]));

test('触发方式看操作：挂的操作登记了什么、节点上写了什么、文字里手写了输入字段就是在构造输入；说不清不算真实', () => {
  assert.deepEqual(literalFields('喂命中事件：{event_key=login、is_new=0}'), ['event_key', 'is_new']);
  assert.deepEqual(literalFields('注入 params {"kind":"first","path":"x"}'), ['kind', 'path']);
  assert.deepEqual(literalFields('点「登录」按钮'), []);
  const c = mk([
    node('冷启动', [], { op_id: 'real-x', children: [
      node('点「登录」', [{ id: 'E1', assert: 'a', observe: ob }]),
      node('喂事件 {event_key=login}', [{ id: 'E2', assert: 'b', observe: ob }]),
      node('走真实界面', [{ id: 'E3', assert: 'c', observe: ob }], { input: 'real' }),
      node('经入口注入', [{ id: 'E4', assert: 'd', observe: ob }], { op_id: 'inject-x' }),
    ] }),
  ]);
  assert.deepEqual(from(c), { E1: 'unknown', E2: 'injected', E3: 'real', E4: 'injected' });
  // 观测用的操作不喂输入，不登记不影响；断言自己声明 real 补不了手写字段那一步
  c.tree[0].children[1].expect[0].input = 'real';
  assert.equal(from(c).E2, 'injected');
  assert.ok(rules(c, 'Q31').some(f => f.at === 'E2' && /按更假的算/.test(f.msg)));
  // 说不清的那一步：Q31 点名是哪一步
  assert.ok(rules(c, 'Q31').some(f => f.at === 'n1.1' && /没说怎么触发/.test(f.msg)));
  // 用例整体声明 real：只补说不清的那几步，压不过手写字段和登记成注入的操作
  assert.deepEqual(from({ ...c, input: 'real' }), { E1: 'real', E2: 'injected', E3: 'real', E4: 'injected' });
});

test('有注入、没有一条真实触发的用例不通过；注入的断言（人判也算）是低分证据', () => {
  const inj = mk([node('经入口注入', [{ id: 'E1', assert: 'a', observe: ob }, { id: 'E2', assert: 'b', judge: 'human' }], { op_id: 'inject-x' })]);
  assert.equal(rules(inj, 'Q32')[0]?.level, 'block');
  assert.equal(rules(inj, 'Q33').length, 2, '人判的注入断言一样只验了判定那一段');
  // 说不清的不算真实：注入 + 说不清 照样拦
  const mixU = mk([node('经入口注入', [{ id: 'E1', assert: 'a', observe: ob }], { op_id: 'inject-x' }), node('某一步', [{ id: 'E2', assert: 'b', observe: ob }])]);
  assert.equal(rules(mixU, 'Q32').length, 1);
  const mixR = mk([node('经入口注入', [{ id: 'E1', assert: 'a', observe: ob }], { op_id: 'inject-x' }), node('真实', [{ id: 'E2', assert: 'b', observe: ob }], { op_id: 'real-x' })]);
  assert.equal(rules(mixR, 'Q32').length, 0);
  assert.equal(rules({ ...inj, kind: 'probe' }, 'Q32').length, 0, '冒烟 / 探针不套');
  const pre = c => score(assessCasePre(c, { findings: checkCase(c, { ops: OPS }), ops: OPS, platforms: ['android'] }), 'pre');
  assert.ok(pre(mixR).per.input <= 3);
  const s = pre(inj); assert.equal(s.gate, 'block'); assert.ok(s.total <= 59);
});

test('手写的输入字段要说清全局还是调用点；调用点字段要有真实对照（real，或只 mock 了全局信号的）', () => {
  const tw = (twinIn, extra = {}) => mk([
    node('喂事件 {kind=first、region=x}', [{ id: 'E1', assert: 'a', observe: ob }], { input: { from: 'injected', mocks: [{ field: 'kind', scope: 'call-site', why: 'w' }, { field: 'region', scope: 'global', why: 'w' }], real_twin: 'E2', ...extra } }),
    node('真实', [{ id: 'E2', assert: 'b', observe: ob }], { input: twinIn }),
  ]);
  assert.equal(rules(tw('real'), 'Q34').length, 0);
  assert.equal(rules(tw({ from: 'mock-global', why: '这一档只能靠配置切', mocks: [{ field: 'g', scope: 'global', why: 'w' }] }), 'Q34').length, 0);
  assert.match(rules(tw({ from: 'mock-global', why: 'w', mocks: [{ field: 'h', scope: 'call-site', why: 'w' }] }), 'Q34').find(f => f.at === 'E1').msg, /本身不是真实触发/);
  const bare = mk([node('喂事件 {kind=first}', [{ id: 'E1', assert: 'a', observe: ob }])]);
  assert.match(rules(bare, 'Q34')[0].msg, /手写了 kind/);
  assert.match(rules(mk([node('x', [{ id: 'E1', assert: 'a', observe: ob }], { input: { from: 'mock-global' } })]), 'Q34')[0].msg, /没写为什么不用真值/);
  const bad = mk([node('x', [{ id: 'E1', assert: 'a', observe: ob }], { input: { from: 'nope', mocks: [{ field: 'f', scope: 'x' }], real_twin: 'E9' } })]);
  const msgs = rules(bad, 'Q31').map(f => f.msg).join('\n');
  assert.match(msgs, /from 只能是/); assert.match(msgs, /scope 只能是/); assert.match(msgs, /E9 不在这条用例里/);
});

test('用例评审时：改动面没有真实触发 plan check 不通过；consult 读被测代码给线索；测法建议交 owner 定改不改', () => {
  const BIN = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'bin', 'acceptkit.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'acceptkit-test-'));
  for (const d of ['cases', 'runs', 'state/plans', 'state/rounds', 'knowledge', 'ops']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'acceptkit.project.json'), JSON.stringify({ name: 't', gate: { allow: [] } }));
  writeFileSync(join(dir, 'ops', 'registry.json'), JSON.stringify({ ops: OPS }));
  // 被测仓：字段在生产代码里组装，调试页里有个入口碰到它，单测里也有（不列）
  const repo = join(dir, 'repo');
  for (const d of ['src/net', 'src/debug', 'src/test']) mkdirSync(join(repo, d), { recursive: true });
  writeFileSync(join(repo, 'src/net/Assembler.kt'), 'fun build(req) {\n  event["region_kind"] = classify(req.host)\n}\n');
  writeFileSync(join(repo, 'src/debug/NetPanel.kt'), 'button("send") { http.get(url) }  // region_kind 由真实请求算出\n');
  writeFileSync(join(repo, 'src/test/AssemblerTest.kt'), 'assert(event["region_kind"] == "a")\n');
  spawnSync('git', ['init', '-q'], { cwd: repo }); spawnSync('git', ['add', '-A'], { cwd: repo });
  writeFileSync(join(dir, 'state', 'rounds', 'D1.json'), JSON.stringify({ demand: 'D1', repos: [{ name: 'app', path: repo }], rounds: [] }));
  const c = mk([node('冷启动', [], { op_id: 'real-x', children: [node('经入口注入 {region_kind=a}', [{ id: 'E1', assert: '判定给出拦截', observe: ob }], { op_id: 'inject-x' })] })]);
  writeFileSync(join(dir, 'cases', 'c.case.json'), JSON.stringify({ ...c, classifications: { carrier: ['android'] } }));
  writeFileSync(join(dir, 'state', 'plans', 'D1.json'), JSON.stringify({ demand: 'D1', title: '测', platform: 'android', revision: 1,
    surfaces: [{ id: 'S1', change: '网络拦截', risk: 'r', uncovered: 'u', reuse: ['c'], new: [], ops: [] }], not_covered: [], history: [], created_at: new Date().toISOString() }));
  const ak = (...a) => spawnSync(process.execPath, [BIN, ...a], { cwd: dir, encoding: 'utf8', env: { ...process.env, ACCEPTKIT_PROJECT: dir, HOME: dir } });
  const chk = ak('plan', 'check', 'D1');
  assert.notEqual(chk.status, 0); assert.match(chk.stdout + chk.stderr, /S1「网络拦截」.*没有一条经真实路径触发/);
  const cards = () => JSON.parse(ak('next', 'D1', '--json').stdout).cards;
  const tc = cards().find(x => x.kind === 'trigger_consult');
  assert.ok(tc, '评审时就出卡'); assert.match(tc.detail[0], /c n1\.1.*直接注入/);
  // consult 读代码：组装点在生产代码，调试页是入口候选，单测只计数
  const k = JSON.parse(ak('consult', 'c', '--json').stdout);
  const s = k.steps.find(x => x.node === 'n1.1');
  assert.deepEqual(s.fields, ['region_kind']);
  assert.ok(s.leads.assembly.some(f => f.file === 'src/net/Assembler.kt'));
  assert.ok(s.leads.tools.some(f => f.file === 'src/debug/NetPanel.kt'));
  assert.equal(s.leads.tests, 1);
  // 测法建议缺一项不收
  assert.match(ak('consult', 'c', '--node', 'n1.1', '--propose', '--real', '用户打开任意网页', '--how', '调试页发真实请求').stderr, /还缺.*--evidence.*--catches/);
  const ok = ak('consult', 'c', '--node', 'n1.1', '--propose', '--demand', 'D1', '--real', '用户打开任意网页，app 发出请求',
    '--evidence', 'src/net/Assembler.kt:2 这个字段按请求的域名算出来', '--evidence', 'src/debug/NetPanel.kt:1 调试页按钮发真实请求',
    '--how', '在调试页点发送，发一条真实请求', '--catches', '字段按真实请求算得对不对');
  assert.equal(ok.status, 0, ok.stderr);
  // 研究卡收掉，owner 卡片是一份他不看代码也能定的说明
  const att = cards().find(x => x.subject === 'trigger_proposal');
  assert.ok(!cards().some(x => x.kind === 'trigger_consult' && x.title.includes('不是真实触发')));
  assert.match(att.question, /真实情况下：用户打开任意网页[\s\S]*代码依据：src\/net\/Assembler\.kt:2[\s\S]*建议改成：在调试页点发送[\s\S]*不用先补东西[\s\S]*能多验到：字段按真实请求算得对不对[\s\S]*要不要改/);
  // 改不改只认 owner 原话
  assert.notEqual(ak('consult', 'decide', 'T1', '--adopt').status, 0);
  assert.equal(ak('consult', 'decide', 'T1', '--adopt', '--by', 'owner', '--quote', '改吧').status, 0);
  assert.match(cards().find(x => x.kind === 'trigger_consult').title, /同意改成真实触发的 1 处，用例还没改/);
  // ops set --input 写进操作库，写错拒收
  assert.equal(ak('ops', 'set', 'read-x', '--input', 'real').status, 0);
  assert.equal(JSON.parse(readFileSync(join(dir, 'ops', 'registry.json'), 'utf8')).ops['read-x'].input, 'real');
  assert.notEqual(ak('ops', 'set', 'read-x', '--input', 'fake').status, 0);
});

test('带连字符的字段名不截断；真实触发的步骤里写的是请求自己的内容，不当手写字段，但自己声明的要写 why', () => {
  assert.deepEqual(literalFields('header {"x-sec-bypass-log":"1", "x-a":"2"}'), ['x-sec-bypass-log', 'x-a']);
  const viaOp = mk([node('网络调试页发请求 {"x-sec-bypass":"1"}', [{ id: 'E1', assert: 'a', observe: ob }], { op_id: 'real-x' })]);
  assert.equal(rules(viaOp, 'Q34').length, 0);
  const declared = why => mk([node('网络调试页发请求 {"x-sec-bypass":"1"}', [{ id: 'E1', assert: 'a', observe: ob }], { input: { from: 'real', ...(why ? { why } : {}) } })]);
  assert.match(rules(declared(), 'Q34')[0].msg, /声明是真实触发，文字里却写着 x-sec-bypass/);
  assert.equal(rules(declared('这是请求头，随真实请求经网络栈进引擎'), 'Q34').length, 0);
});

test('观测操作自己发真实请求：整条链真实时，它的参数是请求内容；观测操作登记成注入时照样要说清', () => {
  const obsP = (op = 'read-x') => ({ op, params: { headers: '{"x-sec":"1"}' }, checks: [{ pick: 'a', predicate: { eq: 'b' } }] });
  assert.equal(rules(mk([node('真实', [{ id: 'E1', assert: 'a', observe: obsP() }], { input: { from: 'real', why: '调试页真发请求' } })]), 'Q34').length, 0);
  assert.match(rules(mk([node('真实', [{ id: 'E1', assert: 'a', observe: obsP() }], { input: 'real' })]), 'Q34')[0].msg, /声明是真实触发，文字里却写着 x-sec/);
  assert.match(rules(mk([node('真实', [{ id: 'E1', assert: 'a', observe: obsP('inject-x') }], { op_id: 'real-x' })]), 'Q34')[0].msg, /手写了 x-sec/);
});

test('consult 从真实代码里产生同样取值的地方往上追，追到界面 / 入口类代码', async () => {
  const TC = await import('../core/trigger-consult.mjs');
  const repo = mkdtempSync(join(tmpdir(), 'acceptkit-repo-'));
  for (const d of ['src/track', 'src/ui', 'src/test']) mkdirSync(join(repo, d), { recursive: true });
  writeFileSync(join(repo, 'src/track/LiveTracker.kt'), 'class LiveTracker {\n  fun reportLivePlay(room: String) {\n    track("live_play_start", room)\n  }\n}\n');
  writeFileSync(join(repo, 'src/ui/LiveRoomActivity.kt'), 'class LiveRoomActivity {\n  fun onPlayClicked() {\n    tracker.reportLivePlay(roomId)\n  }\n}\n');
  writeFileSync(join(repo, 'src/test/LiveTrackerTest.kt'), 'assert(sent == "live_play_start")\n');
  spawnSync('git', ['init', '-q'], { cwd: repo }); spawnSync('git', ['add', '-A'], { cwd: repo });
  const vals = TC.literalValues({ op: '喂事件 {event_key=live_play_start}' });
  assert.deepEqual(vals, ['live_play_start']);
  const [x] = TC.traceSources([{ name: 'app', path: repo }], vals);
  assert.deepEqual(x.chain.map(c => `${c.file}:${c.line}`), ['src/track/LiveTracker.kt:3', 'src/ui/LiveRoomActivity.kt:3']);
  assert.equal(x.chain[0].fn, 'reportLivePlay');
  assert.equal(x.chain.at(-1).entry, true, '追到界面类代码：真实触发就在这');
});

test('操作自己的参数（打到哪个入口）标 tool：要写 why，不要真实对照', () => {
  const c = why => mk([node('经入口注入', [{ id: 'E1', assert: 'a', observe: ob }], { op_id: 'inject-x', params: { route: 'lite' }, input: { from: 'injected', mocks: [{ field: 'route', scope: 'tool', ...(why ? { why } : {}) }] } }), node('真实', [{ id: 'E2', assert: 'b', observe: ob }], { op_id: 'real-x' })]);
  assert.match(rules(c(), 'Q34')[0].msg, /操作自己的参数，没写 why/);
  assert.equal(rules(c('选哪个判定入口，事件里没有这个字段'), 'Q34').length, 0);
});

test('只 mock 全局信号的步骤：参数（mock 哪个开关、成什么值）不当手写字段查', () => {
  const ops = { ...OPS, 'ab-mock': { title: '调试页 mock 开关', why: 'w', input: 'mock-global', platforms: { android: { how: 'h', state: 'confirmed' } } } };
  const c = mk([node('在调试页把开关 mock 成关', [{ id: 'E1', assert: 'a', observe: ob }], { op_id: 'ab-mock', params: { key: 'feature_x', value: 'false' } }), node('真实', [{ id: 'E2', assert: 'b', observe: ob }], { op_id: 'real-x' })]);
  assert.equal(checkCase(c, { ops }).filter(f => f.rule === 'Q34' && /手写了/.test(f.msg)).length, 0);
});

test('分组标题不算一步：挂在分组下的预期按上面那一步的触发方式算', () => {
  const c = mk([{ op: '真实', op_id: 'real-x', expect: [], children: [{ op: 'C1 正向', kind: 'group', expect: [{ id: 'E1', assert: 'a', observe: ob }] }] }]);
  assert.equal(checkCase(c, { ops: OPS }).filter(f => f.rule === 'Q32').length, 0);
});
