// 用例结构：配置是有名字的一份（配置集）；一步一件事；配置值不写在步骤里；配置集里 mock 的全局信号算进触发方式
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkCase } from '../core/case-quality.mjs';
import { caseInputs } from '../core/input-source.mjs';

const SETS = { off: { title: '开关关', items: [{ key: 'feature_x', value: 'false', kind: 'mock', why: '测试机上只能本地 mock' }] } };
const rules = (c, id, cfgSets = SETS) => checkCase(c, { ops: {}, cfgSets }).filter(f => f.rule === id);

test('一步一件事、配置值不写在步骤里、引用的配置集要存在', () => {
  const bad = { case: 'c', title: 't', platform: 'android', tree: [{ op: 'feature_x = false 时冷启；确认新链没装配，然后打开设置页', expect: [] }] };
  assert.match(rules(bad, 'Q35')[0].msg, /连着写了几个动作/);
  assert.match(rules(bad, 'Q36')[0].msg, /feature_x=false/);
  const good = { case: 'c', title: 't', platform: 'android', config: ['off'], tree: [{ op: '冷启动', note: '确认新链没装配', children: [{ op: '打开设置页', params: { tab: 'privacy' } }] }] };
  assert.equal(rules(good, 'Q35').length + rules(good, 'Q36').length, 0);
  assert.match(rules({ ...good, config: ['nope'] }, 'Q36')[0].msg, /配置集 nope 不存在/);
});

test('配置集里 mock 的全局信号：下面的真实步骤只算「只 mock 全局信号」，仍算真实对照', () => {
  const c = { case: 'c', title: 't', platform: 'android', tree: [{ op: '冷启动', config: ['off'], input: { from: 'real', why: '走启动器' }, expect: [{ id: 'E1', assert: 'a', observe: { op: 'x', checks: [] } }] }] };
  const [x] = caseInputs(c, {}, SETS);
  assert.equal(x.from, 'mock-global');
  assert.deepEqual(x.mocks.map(m => [m.field, m.scope]), [['feature_x', 'global']]);
  assert.equal(caseInputs(c, {}, null)[0].from, 'real', '不给配置集就不算');
});

test('configset 命令：mock 项要写 why；按项名合并；diff 只列不同的', () => {
  const BIN = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'bin', 'acceptkit.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'acceptkit-test-'));
  for (const d of ['cases', 'runs', 'state', 'ops']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'acceptkit.project.json'), JSON.stringify({ name: 't', gate: { allow: [] } }));
  const ak = (...a) => spawnSync(process.execPath, [BIN, ...a], { cwd: dir, encoding: 'utf8', env: { ...process.env, ACCEPTKIT_PROJECT: dir, HOME: dir } });
  assert.match(ak('configset', 'set', 'off', '--title', '开关关', '--item', 'feature_x=false', '--kind', 'mock').stderr, /要写 why/);
  assert.equal(ak('configset', 'set', 'off', '--title', '开关关', '--item', 'feature_x=false', '--kind', 'mock', '--why', '本地 mock').status, 0);
  assert.equal(ak('configset', 'set', 'on', '--title', '开关开', '--item', 'feature_x=true', '--item', 'region=SG', '--kind', 'env').status, 0);
  assert.equal(ak('configset', 'set', 'off', '--item', 'region=SG', '--kind', 'env').status, 0);
  const sets = JSON.parse(readFileSync(join(dir, 'ops', 'configs.json'), 'utf8')).configs;
  assert.deepEqual(sets.off.items.map(x => x.key), ['feature_x', 'region']);
  const d = JSON.parse(ak('configset', 'diff', 'on', 'off', '--json').stdout);
  assert.deepEqual(d.diff, [{ key: 'feature_x', a: 'true', b: 'false' }]);
});

test('用例要清晰：步骤挂带人看步骤的操作、或写成「动作 + 对象」/ 命令；预期说得出人怎么看；判了不可执行不催', () => {
  const st = op => checkCase({ case: 'c', title: 't', platform: 'android', tree: [{ op, expect: [] }] }, { ops: {}, cfgSets: SETS }).filter(f => ['Q37', 'Q38'].includes(f.rule));
  assert.equal(st('对照组：同一份配置、同一条 trigger，拿掉 cpp 执行器件再冷启动一次').length, 1);
  assert.equal(st('带 cpp 执行器件冷启（SharedVM backend 在场），发一条会路由到 TTM 策略的 trigger').length, 1);
  assert.equal(st('进入「网络调试」页，点击「发送」').length, 0);
  assert.match(st('运行 `adb shell am force-stop com.x`')[0].msg, /命令是机器做法，进操作集/, '步骤里写命令：要提成操作集');
  assert.equal(st('冷启动').length, 0);
  const viaOp = checkCase({ case: 'c', title: 't', platform: 'android', tree: [{ op: '随便写', op_id: 'send-req', expect: [] }] }, { ops: { 'send-req': { title: '发请求', human: ['进入「网络调试」页', '点击「发送」'] } }, cfgSets: SETS }).filter(f => ['Q37', 'Q38'].includes(f.rule));
  assert.equal(viaOp.length, 0, '挂了带人看步骤的操作 = 引用，做法在操作里');
  const noHuman = checkCase({ case: 'c', title: 't', platform: 'android', tree: [{ op: '随便写', op_id: 'send-req', expect: [] }] }, { ops: { 'send-req': { title: '发请求' } }, cfgSets: SETS }).filter(f => ['Q37', 'Q38'].includes(f.rule));
  assert.match(noHuman[0].msg, /也没写人看的步骤/);
  // 预期：机判的要说得出人怎么看（see），或观测操作带人看的步骤
  const ex = see => checkCase({ case: 'c', title: 't', platform: 'android', tree: [{ op: '冷启动', expect: [{ id: 'E1', assert: 'a', observe: { op: 'diag', checks: [] }, ...(see ? { see } : {}) }] }] }, { ops: { diag: { title: '读诊断页' } }, cfgSets: SETS }).filter(f => ['Q37', 'Q38'].includes(f.rule));
  assert.match(ex()[0].msg, /没写操作步骤/); assert.equal(ex()[0].rule, 'Q37', '一条预期连操作步骤都没有：写的时候就拦');
  assert.equal(ex(['看一下上报'])[0].rule, 'Q38', '写了但不准：只提示，跑过后要改准');
  assert.equal(ex(['在调试面板搜「Engine」，点击「Engine Diagnostics」', '点击「启动链路」', '看「did assembly succeed」是不是 yes']).length, 0);
  // 「打开 / 进入「X」页」却没说怎么进去：不准；写成 @<操作> 引用（那个操作知道怎么打开）就准
  assert.match(ex(['打开诊断台', '进入「启动链路」页', '看「did assembly succeed」是不是 yes'])[0].msg, /没说怎么进到这一页/);
  assert.equal(ex(['@open-diag', '点击「启动链路」', '看「did assembly succeed」是不是 yes']).length, 0);
  // 要看的那一项不是页面上的原字（「执行路径」页面上没有这几个字）：不准
  assert.equal(ex(['@open-diag', '点击「Decisions」', '看这一行末尾的「path=」是不是「1.T#」']).length, 0);
  assert.equal(checkCase({ case: 'c', title: 't', platform: 'android', unexecutable: { why: '没有真实入口' }, tree: [{ op: '随便写', expect: [] }] }, { ops: {}, cfgSets: SETS }).filter(f => ['Q37', 'Q38'].includes(f.rule)).length, 0, '判了不可执行就不催');
});

test('看的步骤要说出页面上看哪里：括号里只有参数值（要找的对象）不算；有读法操作就指过去', () => {
  // 2026-11-25 回归样例：「看「app2app_report」的执行路径是不是 1.T」—— 括起来的是 unit 名，页面上叫 path= 没人说
  const P = { trigger: '10087', unit: 'app2app_report' };
  const ops = {
    diag: { title: '读决策详情', human: ['@open-diag', '在详情里找到「{param.unit}」，看它的执行路径和产出'] },
    'open-diag': { title: '打开诊断台', human: ['点击「Engine Diagnostics」'] },
    'read-row-field': { title: '看 unit 的执行路径', platforms: { android: { human: ['在「units:」一节找以「{param.unit}」开头的那一行', '看这一行的「path=」字段，.T = 条件为真那一支'] } } },
  };
  const q = see => checkCase({ case: 'c', title: 't', platform: 'android', tree: [{ op: '冷启动', expect: [{ id: 'E1', assert: 'a', observe: { op: 'diag', params: P, checks: [] }, ...(see ? { see } : {}) }] }] }, { ops, cfgSets: SETS }).filter(f => f.rule === 'Q38');
  const bad = q(['@open-diag', '找到 trigger「10087」最新一条决策并点开', '看「app2app_report」的执行路径是不是 1.T']);
  assert.equal(bad.length, 1, '原句要被拦下');
  assert.match(bad[0].msg, /要找的对象（参数 unit）/); assert.match(bad[0].msg, /@read-row-field/, '已有读法操作就指过去');
  assert.equal(q(['@open-diag', '找到 trigger「10087」最新一条决策并点开', '@read-row-field', '「path=」里要有「1.T#」']).length, 0, '引用读法操作 + 这条的判据：清晰');
  assert.equal(q(['@open-diag', '看「app2app_report」那一行的 path= 是不是含 1.T#']).length, 0, '写出了页面上的字段：清晰');
  // 没写 see、用观测操作的人看步骤：操作里那句一样要被拦，并指明改操作
  const viaOp = q(null);
  assert.equal(viaOp.length, 1); assert.match(viaOp[0].msg, /来自操作 diag 的人看步骤/);
  // 什么都没括的「看」也算没说看哪里
  assert.equal(q(['@open-diag', '看结果第一行，确认是在调度关这一臂']).length, 1);
  // 上一步已经定位到那一行，这一步说「看这一行 …」：算说了看哪里
  assert.equal(q(['@open-diag', '找到「did assembly succeed」这一行', '对照通过条件看这一行右侧的值']).length, 0);
});

test('clarify：没填的模板算不清晰；写回要具体，不够拒收；写回记来源；判不可执行要理由', () => {
  const BIN = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'bin', 'acceptkit.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'acceptkit-test-'));
  for (const d of ['cases', 'runs', 'state', 'ops']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'acceptkit.project.json'), JSON.stringify({ name: 't', gate: { allow: [] } }));
  writeFileSync(join(dir, 'ops', 'registry.json'), JSON.stringify({ ops: { diag: { title: '读诊断页', why: 'w', kind: 'observe', platforms: { android: { exec: 'ui', state: 'confirmed' } } } } }));
  writeFileSync(join(dir, 'cases', 'c.case.json'), JSON.stringify({ case: 'c', title: 't', platform: 'android', input: 'real',
    tree: [{ op: '冷启动', children: [{ op: '输入：{"需满足的 CEL": ""}', expect: [{ id: 'E1', assert: 'a', observe: { op: 'diag', checks: [] } }] }] }] }));
  const ak = (...a) => spawnSync(process.execPath, [BIN, ...a], { cwd: dir, encoding: 'utf8', env: { ...process.env, ACCEPTKIT_PROJECT: dir, HOME: dir } });
  const k = JSON.parse(ak('clarify', 'c', '--json').stdout);
  assert.equal(k.status, 'unclear');
  assert.match(k.items.find(x => x.at === 'n1.1').msg, /没填的值|塞着一段 JSON/);
  assert.ok(k.items.find(x => x.at === 'E1').fix.includes('--see'));
  assert.match(ak('clarify', 'c', '--node', 'n1.1', '--op', '发一条请求').stderr, /还是不清晰/);
  assert.equal(ak('clarify', 'c', '--node', 'n1.1', '--op', '进入「网络调试」页，点击「发送」').status, 0);
  assert.match(ak('clarify', 'c', '--expect', 'E1', '--see', '看一下结果').stderr, /说得出具体看哪里/);
  const done = JSON.parse(ak('clarify', 'c', '--expect', 'E1', '--see', '在调试面板搜「Engine」，点击「Engine Diagnostics」', '--see', '点击「启动链路」', '--see', '看「did assembly succeed」这一行是不是 yes', '--json').stdout);
  assert.equal(done.status, 'clear');
  const saved = JSON.parse(readFileSync(join(dir, 'cases', 'c.case.json'), 'utf8'));
  assert.deepEqual(saved.clarified.map(x => x.what), ['node n1.1', 'expect E1']);
  assert.equal(saved.clarified[0].before.op, '输入：{"需满足的 CEL": ""}', '改前的样子留着');
  assert.match(ak('clarify', 'c', '--unexecutable', '--why', '太短').stderr, /至少 10 字/);
});

test('判据上补人话（say）不算改判法：指纹不变、旧结论不作废', async () => {
  const { judgeSpec, classifyCaseEdit } = await import('../core/plan-gate.mjs');
  const e = { id: 'E1', assert: 'a', observe: { op: 'diag', checks: [{ pick: 'read.r1', predicate: { any_match: '^yes' } }] } };
  const e2 = structuredClone(e); e2.observe.checks[0].say = '「did assembly succeed」这一行是 yes'; e2.see = ['进入「启动链路」页'];
  assert.equal(judgeSpec(e), judgeSpec(e2));
  const mk = x => ({ case: 'c', tree: [{ op: '冷启动', expect: [x] }] });
  assert.notEqual(classifyCaseEdit(mk(e), mk(e2)).tier, 'judge');
});

test('步骤文字里塞着一段 JSON（机器的计划）：写的时候就拦', () => {
  const c = { case: 'c', title: 't', platform: 'android', tree: [{ op: '输入：{"做法": "单发", "本节点条件": "x == True", "命令": "engine.EmitMockDecision …"}', expect: [] }] };
  const f = checkCase(c, { ops: {}, cfgSets: SETS }).filter(x => x.rule === 'Q37');
  assert.equal(f.length, 1); assert.match(f[0].msg, /塞着一段 JSON/);
});

test('clarify：跑完核对截图上的字；挂配置集；补真实对照；原地换观测（改前留底）', () => {
  const BIN = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'bin', 'acceptkit.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'acceptkit-test-'));
  for (const d of ['cases', 'runs/r1/shots', 'state', 'ops']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'acceptkit.project.json'), JSON.stringify({ name: 't', gate: { allow: [] } }));
  writeFileSync(join(dir, 'ops', 'registry.json'), JSON.stringify({ ops: {
    inj: { title: '注入', why: 'w', kind: 'observe', input: 'injected', human: ['进入「设置」页后点击「注入」'], platforms: { android: { exec: 'ui', state: 'confirmed' } } },
    real: { title: '真实请求', why: 'w', kind: 'observe', input: 'real', human: ['点击「发送」'], platforms: { android: { exec: 'ui', state: 'confirmed' } } } } }));
  writeFileSync(join(dir, 'ops', 'configs.json'), JSON.stringify({ configs: { rel: { title: 'release 包', items: [{ key: 'build', value: 'release', kind: 'env' }] } } }));
  writeFileSync(join(dir, 'cases', 'c.case.json'), JSON.stringify({ case: 'c', title: 't', platform: 'android', input: 'real',
    tree: [{ op: '点击「网络调试」', expect: [{ id: 'E1', assert: 'a', observe: { op: 'inj', checks: [{ pick: 'read.x', predicate: { eq: 'y' } }] } }] }] }));
  // 跑过：那一步截了图，当时画面上没有「网络调试」这几个字
  writeFileSync(join(dir, 'runs', 'r1', 'result.json'), JSON.stringify({ run: 'r1', case: 'c', results: {}, steps: { n1: { evidence: ['shots/app-01-x.png'] } } }));
  writeFileSync(join(dir, 'runs', 'r1', 'shots', 'app-01-x.png.json'), JSON.stringify({ kind: 'process_shot', screen_texts: ['首页', '设置'] }));
  const ak = (...a) => spawnSync(process.execPath, [BIN, ...a], { cwd: dir, encoding: 'utf8', env: { ...process.env, ACCEPTKIT_PROJECT: dir, HOME: dir } });
  const k = JSON.parse(ak('clarify', 'c', '--json').stdout);
  assert.match(k.items.find(x => x.at === 'n1').msg, /截图上没出现「网络调试」/);
  assert.equal(ak('clarify', 'c', '--node', 'n1', '--config', 'rel').status, 0);
  assert.notEqual(ak('clarify', 'c', '--node', 'n1', '--config', 'nope').status, 0);
  const add = ak('clarify', 'c', '--node', 'n1', '--add-expect', 'R1', '--assert', '真实请求也被拦', '--observe-op', 'real', '--param', 'url=x', '--checks', '[{"pick":"read.x","predicate":{"eq":"y"}}]', '--twin-of', 'E1');
  assert.equal(add.status, 0, add.stderr);
  assert.equal(ak('clarify', 'c', '--expect', 'E1', '--observe-op', 'real').status, 0);
  const saved = JSON.parse(readFileSync(join(dir, 'cases', 'c.case.json'), 'utf8'));
  assert.deepEqual(saved.tree[0].config, ['rel']);
  const [e1, r1] = saved.tree[0].expect;
  assert.equal(r1.id, 'R1'); assert.equal(r1.observe.op, 'real'); assert.equal(r1.input.from, 'real');
  assert.equal(e1.input.real_twin, 'R1');
  assert.equal(e1.observe.op, 'real'); assert.equal(e1.input.from, 'real');
  assert.ok(saved.clarified.some(x => /换观测/.test(x.what) && x.before.observe.op === 'inj'), '改前的观测留底');
});

test('clarify：删断言要理由、清掉指向它的 real_twin；读取通道要写为什么界面上看不到', () => {
  const BIN = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'bin', 'acceptkit.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'acceptkit-test-'));
  for (const d of ['cases', 'state', 'ops']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'acceptkit.project.json'), JSON.stringify({ name: 't', gate: { allow: [] } }));
  writeFileSync(join(dir, 'ops', 'registry.json'), JSON.stringify({ ops: {} }));
  writeFileSync(join(dir, 'cases', 'c.case.json'), JSON.stringify({ case: 'c', title: 't', platform: 'android', input: 'real',
    tree: [{ op: '点击「发送」', expect: [{ id: 'E1', assert: 'a', input: { from: 'injected', real_twin: 'R1' } }, { id: 'R1', assert: 'b' }] }] }));
  const ak = (...a) => spawnSync(process.execPath, [BIN, ...a], { cwd: dir, encoding: 'utf8', env: { ...process.env, ACCEPTKIT_PROJECT: dir, HOME: dir } });
  assert.match(ak('clarify', 'c', '--remove-expect', 'R1').stderr, /要写 --why/);
  assert.equal(ak('clarify', 'c', '--remove-expect', 'R1', '--why', '并排留了两份，改成原地换').status, 0);
  assert.match(ak('clarify', 'c', '--expect', 'E1', '--via', 'log').stderr, /why-not-ui/);
  assert.equal(ak('clarify', 'c', '--expect', 'E1', '--via', 'log', '--why-not-ui', '判定只在系统日志里，没有页面逐条显示').status, 0);
  const s2 = JSON.parse(readFileSync(join(dir, 'cases', 'c.case.json'), 'utf8')), e1 = s2.tree[0].expect[0];
  assert.equal(s2.tree[0].expect.length, 1); assert.equal(e1.input.real_twin, undefined); assert.equal(e1.via, 'log');
  assert.ok(s2.clarified.some(x => /删断言 R1/.test(x.what) && x.before.expect.id === 'R1'));
});

test('clarify --remove-node：只删空节点，要理由', () => {
  const BIN = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'bin', 'acceptkit.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'acceptkit-test-'));
  for (const d of ['cases', 'state', 'ops']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'acceptkit.project.json'), JSON.stringify({ name: 't', gate: { allow: [] } }));
  writeFileSync(join(dir, 'ops', 'registry.json'), JSON.stringify({ ops: {} }));
  writeFileSync(join(dir, 'cases', 'c.case.json'), JSON.stringify({ case: 'c', title: 't', platform: 'android', input: 'real',
    tree: [{ op: '点击「发送」', expect: [{ id: 'E1', assert: 'a' }] }, { op: '走不到的 F 支' }] }));
  const ak = (...a) => spawnSync(process.execPath, [BIN, ...a], { cwd: dir, encoding: 'utf8', env: { ...process.env, ACCEPTKIT_PROJECT: dir, HOME: dir } });
  assert.match(ak('clarify', 'c', '--remove-node', 'n1', '--why', '条件恒真走不到').stderr, /还有预期 E1/);
  assert.match(ak('clarify', 'c', '--remove-node', 'n2').stderr, /要写 --why/);
  assert.equal(ak('clarify', 'c', '--remove-node', 'n2', '--why', '条件恒真，F 支走不到').status, 0);
  const s2 = JSON.parse(readFileSync(join(dir, 'cases', 'c.case.json'), 'utf8'));
  assert.equal(s2.tree.length, 1); assert.ok(s2.clarified.some(x => /删节点 n2/.test(x.what)));
});

test('clarify --expect --input：步骤换成真实触发后改预期的来源；观测参数值里的逗号不拆', () => {
  const BIN = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'bin', 'acceptkit.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'acceptkit-test-'));
  for (const d of ['cases', 'state', 'ops']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'acceptkit.project.json'), JSON.stringify({ name: 't', gate: { allow: [] } }));
  writeFileSync(join(dir, 'ops', 'registry.json'), JSON.stringify({ ops: { 'read-x': { title: 'r', kind: 'observe', why: 'w', platforms: { android: { how: 'h', state: 'confirmed' } } } } }));
  writeFileSync(join(dir, 'cases', 'c.case.json'), JSON.stringify({ case: 'c', title: 't', platform: 'android', input: 'real',
    tree: [{ op: '点击「发送」', expect: [{ id: 'E1', assert: 'a', input: { from: 'injected', real_twin: 'R1' } }] }] }));
  const ak = (...a) => spawnSync(process.execPath, [BIN, ...a], { cwd: dir, encoding: 'utf8', env: { ...process.env, ACCEPTKIT_PROJECT: dir, HOME: dir } });
  assert.match(ak('clarify', 'c', '--expect', 'E1', '--input', 'injected').stderr, /--why/);
  assert.equal(ak('clarify', 'c', '--expect', 'E1', '--input', 'real').status, 0);
  assert.equal(ak('clarify', 'c', '--expect', 'E1', '--observe-op', 'read-x', '--param', 'fields={"a":1,"b":2}', '--checks', '[{"pick":"read.x","predicate":{"eq":"1"}}]').status, 0);
  const e = JSON.parse(readFileSync(join(dir, 'cases', 'c.case.json'), 'utf8')).tree[0].expect[0];
  assert.deepEqual(e.input, { from: 'real' }); assert.equal(e.observe.params.fields, '{"a":1,"b":2}');
});

test('预期前面没有任何动作（全是分组标题）算不清晰；--move-under 挪到产生结果的那一步下面', async () => {
  const { caseClarity } = await import('../core/clarity.mjs');
  const exp = { id: 'C1', assert: 'a', observe: { op: 'x' }, see: ['在「决策」页看「upc」那一行'] };
  const c = { case: 'c', platform: 'ios', tree: [{ op: '点击「发送」', expect: [] }, { op: 'C1 正向', kind: 'group', expect: [exp] }] };
  assert.ok(caseClarity(c, {}).expects.some(x => x.at === 'C1' && /没有任何动作/.test(x.msg)));
  const BIN = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'bin', 'acceptkit.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'acceptkit-test-'));
  for (const d of ['cases', 'state', 'ops']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'acceptkit.project.json'), JSON.stringify({ name: 't', gate: { allow: [] } }));
  writeFileSync(join(dir, 'ops', 'registry.json'), JSON.stringify({ ops: {} }));
  writeFileSync(join(dir, 'cases', 'c.case.json'), JSON.stringify({ ...c, title: 't', input: 'real' }));
  const ak = (...a) => spawnSync(process.execPath, [BIN, ...a], { cwd: dir, encoding: 'utf8', env: { ...process.env, ACCEPTKIT_PROJECT: dir, HOME: dir } });
  assert.match(ak('clarify', 'c', '--node', 'n1', '--move-under', 'n1').stderr, /自己下面/);
  assert.equal(ak('clarify', 'c', '--node', 'n2', '--move-under', 'n1').status, 0);
  const s2 = JSON.parse(readFileSync(join(dir, 'cases', 'c.case.json'), 'utf8'));
  assert.equal(s2.tree.length, 1); assert.equal(s2.tree[0].children[0].expect[0].id, 'C1');
  assert.ok(!caseClarity(s2, {}).expects.some(x => /没有任何动作/.test(x.msg)));
});

test('节点迁移：group → kind，分配稳定 nid，可重复执行', async () => {
  const { migrateCase } = await import('../core/migrate-nodes.mjs');
  const c = { case: 'm', tree: [{ op: 'a', children: [{ op: 'g', group: true, expect: [{ id: 'E1' }] }] }, { op: 'b', id: 'n9' }] };
  assert.ok(migrateCase(c) > 0);
  assert.equal(c.tree[0].children[0].kind, 'group'); assert.equal('group' in c.tree[0].children[0], false);
  assert.equal(c.tree[1].nid, 'n9'); assert.equal(c.tree[1].id, undefined);
  const ids = [c.tree[0].nid, c.tree[0].children[0].nid, c.tree[1].nid]; assert.equal(new Set(ids).size, 3);
  assert.equal(migrateCase(c), 0);
});
