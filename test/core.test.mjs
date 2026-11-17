// 内核行为测试：每个测试在临时目录里建一个最小项目，以子进程方式调 CLI（与真实使用同一条路径）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(REPO, 'bin', 'acceptkit.mjs');

function project(cfg = {}, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'acceptkit-test-'));
  for (const d of ['cases', 'runs', 'state', 'knowledge', 'ops']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'acceptkit.project.json'), JSON.stringify({ name: 't', gate: { allow: [] }, ...cfg }));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  }
  return dir;
}
// HOME 指到临时目录：命令会写用户配置（登记项目、管理页面状态），测试不能碰真的那份
const ak = (dir, ...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, ACCEPTKIT_PROJECT: dir, HOME: dir } });

const CASE = {
  case: 'c1', title: '示例', platform: 'web', classifications: { carrier: ['web'] },
  tree: [{ op: '读产物', tags: { carrier: 'web' }, expect: [
    { id: 'E1', assert: '产物里 ok 为 true', observe: { op: 'read-json', params: { file: 'evidence/out.json' }, checks: [{ pick: 'ok', predicate: { eq: true } }] } },
    { id: 'E2', assert: '主通道缺失时降级', observe: { op: 'missing-diag', params: {}, fallback: [{ op: 'read-json', params: { file: 'evidence/out.json' } }], checks: [{ pick: 'ok', predicate: { eq: true } }] } },
    { id: 'E3', assert: '要求 S1 时降级到 S2 不能记通过', observe: { op: 'missing-diag', params: {}, fallback: [{ op: 'read-json', params: { file: 'evidence/out.json' } }], checks: [{ pick: 'ok', predicate: { eq: true } }], min_strength: 'S1' } },
  ] }],
};
const OPS = { ops: {
  'read-json': { kind: 'observe', title: '读产物', platforms: { web: { exec: 'json-file', strength: 'S2' } } },
  'missing-diag': { kind: 'observe', title: '项目没提供的诊断通道', platforms: { web: { exec: 'nonexistent-diag', strength: 'S1' } } },
} };
const PLAN = (approved) => ({ demand: 'D1', title: '测', platform: 'web', revision: 1, surfaces: [{ id: 'S1', change: 'x', reuse: ['c1'], new: [], ops: [] }],
  not_covered: [], history: [], approved_by: approved ? 'tester' : null, approved_at: approved ? new Date().toISOString() : null, created_at: new Date().toISOString() });

test('找不到项目时明确报错', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acceptkit-none-'));
  const r = spawnSync(process.execPath, [BIN, 'cases'], { cwd: dir, encoding: 'utf8', env: { ...process.env, ACCEPTKIT_PROJECT: '' , HOME: dir } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /找不到项目/);
});

test('未知参数一律拒绝', () => {
  const dir = project({}, { 'cases/c1.case.json': CASE, 'ops/registry.json': OPS, 'state/plans/D1.json': PLAN(true) });
  const run = ak(dir, 'run', 'c1', '--demand', 'D1');
  assert.equal(run.status, 0, run.stderr);
  const id = readdirSync(join(dir, 'runs'))[0];
  const r = ak(dir, 'record', id, '--expect', 'E1', '--status', 'pass', '--bogus-flag', 'x');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /不认识这些参数/);
});

test('目标闸：识别不出目标拒绝(3)、白名单外拒绝(2)、白名单内放行', () => {
  const dir = project({ gate: { allow: [{ value: 'emulator-5554', kind: 'device' }, { value: 'com.example.app', kind: 'bundle' }, { value: 'com.example.dual', kind: 'bundle', onlyOn: 'android' }] } });
  assert.equal(ak(dir, 'gate', '--action', 'x').status, 3);
  assert.equal(ak(dir, 'gate', '--action', 'x', '--bundle', 'com.other.app').status, 2);
  assert.equal(ak(dir, 'gate', '--action', 'x', '--bundle', 'com.example.app').status, 0);
  // 平台限定条目：没有 Android 设备同行时不放行
  assert.equal(ak(dir, 'gate', '--action', 'x', '--bundle', 'com.example.dual').status, 2);
});

test('目标闸：租户号从 --url 与多层编码的 JSON 里识别', () => {
  const dir = project({ gate: { allow: [{ value: '1001', kind: 'tenant' }], targetKeys: '^(tenant_id|project_id)$', embeddedKeys: 'tenant_id|project_id', numericOnly: true } });
  assert.equal(ak(dir, 'gate', '--action', 'x', '--url', 'https://h.example.com/p?project_id=1001').status, 0);
  assert.equal(ak(dir, 'gate', '--action', 'x', '--url', 'https://h.example.com/p?project_id=2002').status, 2);
  const nested = JSON.stringify({ a: JSON.stringify({ b: JSON.stringify({ tenant_id: 2002 }) }) });
  assert.equal(ak(dir, 'gate', '--action', 'x', '--payload', nested).status, 2);
  // --json 是「返回 JSON」的开关，不再传载荷：带了就拒收并指向 --payload
  assert.match(ak(dir, 'gate', '--action', 'x', '--json', nested).stderr, /--payload/);
});

test('评审单：未批准不能运行；批准必须带原话并进审批记录', () => {
  const dir = project({}, { 'cases/c1.case.json': CASE, 'ops/registry.json': OPS, 'state/plans/D1.json': PLAN(false) });
  const r1 = ak(dir, 'run', 'c1', '--demand', 'D1');
  assert.notEqual(r1.status, 0);
  const r2 = ak(dir, 'plan', 'approve', 'D1', '--by', 'tester');
  assert.notEqual(r2.status, 0);
  assert.match(r2.stderr, /--quote/);
  const r3 = ak(dir, 'plan', 'approve', 'D1', '--by', 'tester', '--quote', '可以跑');
  assert.equal(r3.status, 0, r3.stderr + r3.stdout);
  const q = ak(dir, 'query', 'select kind, subject, by, quote from approvals', '--json');
  assert.deepEqual(JSON.parse(q.stdout).map(x => [x.subject, x.quote]), [['D1', '可以跑']]);
  assert.equal(ak(dir, 'run', 'c1', '--demand', 'D1').status, 0);
});

test('观测：内置通道判定、缺失通道按 fallback 降级、低于最低强度记阻塞', () => {
  const dir = project({}, { 'cases/c1.case.json': CASE, 'ops/registry.json': OPS, 'state/plans/D1.json': PLAN(true) });
  assert.equal(ak(dir, 'run', 'c1', '--demand', 'D1').status, 0);
  const id = readdirSync(join(dir, 'runs'))[0];
  mkdirSync(join(dir, 'runs', id, 'evidence'), { recursive: true });
  writeFileSync(join(dir, 'runs', id, 'evidence', 'out.json'), JSON.stringify({ ok: true }));
  // 没有一张 app 截图时 observe 不落结论（与 record 同一道闸）
  const bare = ak(dir, 'observe', id);
  assert.notEqual(bare.status, 0); assert.match(bare.stderr, /没有一张 app 操作截图/);
  // 不能先打「✅ = pass」再退回：输出里要说判定出来了但没记，也不写证据文件
  assert.doesNotMatch(bare.stdout, /✅/);
  assert.match(bare.stdout, /E1 判定成立（pass）但没记：本运行还没有 app 截图/);
  const obsDir = join(dir, 'runs', id, 'evidence', 'obs');
  assert.ok(!(existsSync(obsDir) ? readdirSync(obsDir) : []).some(f => /^obs-E1-/.test(f)), '没记的观测不该留证据文件');
  assert.equal(JSON.parse(readFileSync(join(dir, 'runs', id, 'result.json'), 'utf8')).results.E1.status, 'todo');
  // --json 同样：每条带 refused，退出码非零
  const bj = ak(dir, 'observe', id, '--expect', 'E1', '--json');
  assert.notEqual(bj.status, 0);
  assert.match(JSON.parse(bj.stdout).results[0].refused, /没记：本运行还没有 app 截图/);
  mkdirSync(join(dir, 'runs', id, 'shots'), { recursive: true });
  writeFileSync(join(dir, 'runs', id, 'shots', 'app-01-home.png'), Buffer.alloc(2048));
  writeFileSync(join(dir, 'runs', id, 'shots', 'app-01-home.png.json'), JSON.stringify({ kind: 'process_shot', file: 'shots/app-01-home.png' }));
  const o = ak(dir, 'observe', id);
  assert.equal(o.status, 0, o.stderr + o.stdout);
  const r = JSON.parse(readFileSync(join(dir, 'runs', id, 'result.json'), 'utf8'));
  assert.equal(r.results.E1.status, 'pass');
  assert.equal(r.results.E1.observed.strength, 'S2');
  assert.equal(r.results.E2.status, 'pass');
  assert.equal(r.results.E2.observed.op, 'read-json');
  assert.equal(r.results.E2.observed.ladder[0].ok, false);
  assert.match(r.results.E2.observed.ladder[0].error, /缺少观测扩展/);
  assert.equal(r.results.E3.status, 'blocked');
  assert.match(r.results.E3.actual, /证据强度不够/);
});

test('知识：#secret 的值不进结果文件与报告', () => {
  const dir = project({}, {
    'cases/c1.case.json': CASE, 'ops/registry.json': OPS, 'state/plans/D1.json': PLAN(true),
    'knowledge/accounts.md': '# 账号\n\n- 测试账号密码：s3cr3t-value-42 #account #secret\n',
  });
  assert.equal(ak(dir, 'run', 'c1', '--demand', 'D1').status, 0);
  const id = readdirSync(join(dir, 'runs'))[0];
  const r = ak(dir, 'record', id, '--expect', 'E1', '--status', 'blocked', '--blocked-kind', 'dependency', '--actual', '登录时用了 s3cr3t-value-42 仍失败', '--unlock', '等环境恢复');
  assert.equal(r.status, 0, r.stderr);
  const res = readFileSync(join(dir, 'runs', id, 'result.json'), 'utf8');
  assert.ok(!res.includes('s3cr3t-value-42'));
  assert.ok(res.includes('***'));
  const f = ak(dir, 'know', 'find', '#account');
  assert.ok(!f.stdout.includes('s3cr3t-value-42'));
});

test('索引：条数守恒、文件改了能察觉', () => {
  const dir = project({}, { 'cases/c1.case.json': CASE, 'ops/registry.json': OPS, 'state/plans/D1.json': PLAN(true) });
  assert.equal(ak(dir, 'run', 'c1', '--demand', 'D1').status, 0);
  const v = ak(dir, 'index', '--verify');
  assert.equal(v.status, 0, v.stdout);
  const q = JSON.parse(ak(dir, 'query', 'select id, platform, expects from cases', '--json').stdout);
  assert.deepEqual(q, [{ id: 'c1', platform: 'web', expects: 3 }]);
  assert.notEqual(ak(dir, 'query', 'delete from cases').status, 0);
});

test('平台必填：没写平台的用例校验不过', () => {
  const bad = { ...CASE }; delete bad.platform;
  const dir = project({}, { 'cases/c1.case.json': bad, 'ops/registry.json': OPS });
  const r = ak(dir, 'validate', 'c1');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /缺 platform/);
});

test('扩展钩子：领域命令可用、不能覆盖内核命令', () => {
  const dir = project({}, { 'pack.mjs': "export const commands = { hello: () => console.log('hello-from-pack'), run: () => console.log('HIJACK') };\n" });
  assert.match(ak(dir, 'hello').stdout, /hello-from-pack/);
  assert.doesNotMatch(ak(dir, 'run').stdout + ak(dir, 'run').stderr, /HIJACK/);
});

test('import：条数守恒、判定不了的预期标出来、平台必须给', () => {
  const dir = project();
  const csv = join(dir, 'old.csv');
  writeFileSync(csv, '模块,步骤,预期\n购物车,加一件 98.99 元商品,"显示「再买 0.01 元包邮」"\n购物车,打开结算页,显示正常\n首页,冷启动,\n');
  assert.notEqual(ak(dir, 'import', csv, '--case', 'old').status, 0);
  const r = ak(dir, 'import', csv, '--case', 'old', '--platform', 'web');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /导入 3 行 → 3 条断言/);
  const c = JSON.parse(readFileSync(join(dir, 'cases', 'old.case.json'), 'utf8'));
  assert.deepEqual(c.tree.map(n => !!n.expect[0].needs_clarify), [false, true, true]);
  assert.equal(ak(dir, 'validate', 'old').status, 0);
});

test('select：按平台与改动面推荐，排除项带理由', () => {
  const a = { ...CASE, case: 'a', tree: [{ ...CASE.tree[0], tags: { carrier: 'web', surface: 'cart' } }], classifications: { carrier: ['web'], surface: ['cart', 'pay'] } };
  const b = { ...CASE, case: 'b', tree: [{ ...CASE.tree[0], tags: { carrier: 'web', surface: 'pay' } }], classifications: { carrier: ['web'], surface: ['cart', 'pay'] } };
  const i = { ...CASE, case: 'i', platform: 'ios' };
  const dir = project({}, { 'cases/a.case.json': a, 'cases/b.case.json': b, 'cases/i.case.json': i, 'ops/registry.json': OPS });
  const r = JSON.parse(ak(dir, 'select', '--platform', 'web', '--surface', 'cart', '--json').stdout);
  assert.deepEqual(r.keep.map(x => x.case), ['a']);
  assert.deepEqual(r.drop.map(x => x.case).sort(), ['b', 'i']);
  assert.ok(r.drop.every(x => x.why));
});

// 拿本仓库当 git 仓的样本：从压缩包 / npm 包拿到的副本没有 .git，跳过而不是报红
test('sut：记录 git 仓身份；非 git 目录如实写明', { skip: !existsSync(join(REPO, '.git')) && '本仓库不是 git 检出' }, () => {
  const dir = project({}, { 'cases/c1.case.json': CASE, 'ops/registry.json': OPS, 'state/plans/D1.json': PLAN(true) });
  assert.equal(ak(dir, 'run', 'c1', '--demand', 'D1').status, 0);
  const id = readdirSync(join(dir, 'runs'))[0];
  const r = ak(dir, 'sut', id, '--target', '示例', '--repo', `self=${REPO}`, '--repo', `plain=${dir}`);
  assert.equal(r.status, 0, r.stderr);
  const p = JSON.parse(readFileSync(join(dir, 'runs', id, 'evidence', 'provenance.json'), 'utf8'));
  assert.match(p.repos.self.commit, /^[0-9a-f]{40}$/);
  assert.match(p.repos.plain.error, /不是 git 仓库/);
});

test('设置：按固定路径读取；缺必需动作拒写、推测不执行、参数转义、doctor 报缺口', () => {
  const dir = project({ hosts: { app: { ios: { bundle: 'com.example.app' } } } });
  let r = ak(dir, 'build');
  assert.notEqual(r.status, 0); assert.match(r.stderr, /还没有app 的 iOS 构建设置（knowledge\/settings\/ios\/app\/build\.md）/);
  assert.match(ak(dir, 'doctor').stdout, /缺 app · iOS · 构建 设置/);
  assert.match(ak(dir, 'setting', 'set', 'driver', '--platform', 'ios', '--tap', 'true').stderr, /缺必需动作：--ui-tree/);
  assert.equal(ak(dir, 'setting', 'set', 'build', '--platform', 'ios', '--run', 'echo old').status, 0);
  assert.equal(ak(dir, 'setting', 'set', 'build', '--platform', 'ios', '--run', 'echo built {bundle} > out.txt', '--note', '用项目脚本').status, 0);
  r = ak(dir, 'build');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(dir, 'out.txt'), 'utf8').trim(), 'built com.example.app', '覆盖写 + 占位符从项目配置填');
  // 别处的知识里写了「构建」也不读：流程只认固定路径
  writeFileSync(join(dir, 'knowledge', 'notes.md'), '- 构建 #build #ios run: `echo wrong > out.txt`\n');
  ak(dir, 'build'); assert.equal(readFileSync(join(dir, 'out.txt'), 'utf8').trim(), 'built com.example.app');
  ak(dir, 'setting', 'set', 'driver', '--platform', 'ios', '--ui-tree', 'echo 允许', '--tap', 'printf %s {text}');
  r = ak(dir, 'drive', 'tap', '--text', "it's ok; rm -rf x");
  assert.equal(r.stdout, "it's ok; rm -rf x", '参数整体作为一个值传给命令，不被 shell 解释');
  assert.match(ak(dir, 'drive', 'swipe').stderr, /没有「swipe」动作；有：ui-tree \/ tap/);
  ak(dir, 'setting', 'set', 'driver', '--platform', 'ios', '--ui-tree', 'true', '--guess');
  assert.match(ak(dir, 'drive', 'ui-tree').stderr, /还是推测/);
  assert.equal(ak(dir, 'setting', 'confirm', 'driver', '--platform', 'ios').status, 0);
  assert.equal(ak(dir, 'drive', 'ui-tree').status, 0);
  assert.match(ak(dir, 'setting', 'show').stdout, /已确认\s+app · iOS · 构建/);
});

test('用例质量：新增用例不达标不能批准、不能开跑；存量问题记债不拦；改出来的新问题要拦；豁免要写理由', () => {
  const BAD = { ...CASE, case: 'c2', tree: [{ op: '读产物', tags: { carrier: 'web' }, expect: [
    { id: 'E1', assert: '产物里 ok 为 true', observe: CASE.tree[0].expect[0].observe, via: 'cli', why_not_ui: '产物是一个文件，页面上不显示' },
    { id: 'E2', assert: '正常' }] }] };
  // 存量项目：c1 有问题（E2/E3 都是降级判定，没问题；这里给它加一条没有判定方式的断言作为存量债）
  const LEGACY = { ...CASE, tree: [{ ...CASE.tree[0], expect: [...CASE.tree[0].expect, { id: 'E9', assert: '人看一下页面上的提示文案对不对' }] }] };
  const dir = project({}, { 'cases/c1.case.json': LEGACY, 'ops/registry.json': OPS, 'state/plans/D1.json': PLAN(false) });
  assert.equal(ak(dir, 'validate', 'c1').status, 0, '没登记基线时只提示不拦');
  assert.match(ak(dir, 'doctor', '--fix').stdout, /已登记用例质量基线：1 条存量用例/);
  let r = ak(dir, 'validate', 'c1');
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /存量质量债 4 处/);
  // 改存量用例：新加一条没有判定方式的断言 → 只拦新问题
  LEGACY.tree[0].expect.push({ id: 'E10', assert: '另一条人工看的断言' });
  writeFileSync(join(dir, 'cases', 'c1.case.json'), JSON.stringify(LEGACY));
  r = ak(dir, 'validate', 'c1');
  assert.equal(r.status, 1); assert.match(r.stdout, /Q01 断言要有判定方式 · E10/); assert.doesNotMatch(r.stdout, /· E9：/);
  assert.match(ak(dir, 'plan', 'approve', 'D1', '--by', 't', '--quote', '可以').stderr, /硬错/, '评审单里有不达标用例不能批');
  assert.notEqual(ak(dir, 'run', 'c1', '--demand', 'D1', '--skip-plan-gate').status, 0, '不达标不能开跑');
  // 人工判定要写为什么机器判不了；写了就达标
  LEGACY.tree[0].expect[4] = { id: 'E10', assert: '另一条人工看的断言', judge: 'human', human_why: '文案由运营每周调整，没有固定基准' };
  writeFileSync(join(dir, 'cases', 'c1.case.json'), JSON.stringify(LEGACY));
  assert.equal(ak(dir, 'validate', 'c1').status, 0);
  // 新用例：模糊断言被拦；豁免必须带理由
  writeFileSync(join(dir, 'cases', 'c2.case.json'), JSON.stringify(BAD));
  r = ak(dir, 'validate', 'c2');
  assert.equal(r.status, 1); assert.match(r.stdout, /Q02 断言必须可判定 · E2：只有「正常」/); assert.match(r.stdout, /教训：/);
  BAD.tree[0].expect[1] = { id: 'E2', assert: '正常', judge: 'human', human_why: '示例', quality_waive: [{ rule: 'Q02', why: '演示豁免' }] };
  writeFileSync(join(dir, 'cases', 'c2.case.json'), JSON.stringify(BAD));
  r = ak(dir, 'validate', 'c2');
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /Q02 · E2 已豁免：演示豁免/);
  assert.match(ak(dir, 'quality', '--standard').stdout, /被测改动不存在时，这条断言还会成立吗/);
});

// ── 装置故障（取证手段自己坏了）：盲审原来只审「证据↔断言」，这一类噪音整轮不显形 ──
function runWithEvidence(dir) {
  assert.equal(ak(dir, 'run', 'c1', '--demand', 'D1').status, 0);
  const id = readdirSync(join(dir, 'runs'))[0];
  mkdirSync(join(dir, 'runs', id, 'evidence'), { recursive: true });
  writeFileSync(join(dir, 'runs', id, 'evidence', 'out.json'), JSON.stringify({ ok: true }));
  // 有效截图规则：端上 run 记 pass/fail 前要有一张工具截的 app 画面（这里放一张带 sidecar 的过程截图）
  mkdirSync(join(dir, 'runs', id, 'shots'), { recursive: true });
  writeFileSync(join(dir, 'runs', id, 'shots', 'app-01-home.png'), Buffer.alloc(2048));
  writeFileSync(join(dir, 'runs', id, 'shots', 'app-01-home.png.json'), JSON.stringify({ kind: 'process_shot', file: 'shots/app-01-home.png' }));
  return id;
}

test('装置故障：命中词必须分类；判成装置就不许记 fail；分类绑在那段说法上', () => {
  const dir = project({}, { 'cases/c1.case.json': CASE, 'ops/registry.json': OPS, 'state/plans/D1.json': PLAN(true) });
  const id = runWithEvidence(dir);
  // 不分类 → 拒绝写入，并把命中的词和两种读法摆出来
  const a = ak(dir, 'record', id, '--expect', 'E1', '--status', 'fail', '--actual', '探了 10 个类全是 ClassNotFound，app is not running');
  assert.notEqual(a.status, 0);
  assert.match(a.stderr, /装置故障词/);
  assert.match(a.stderr, /ClassNotFound/);
  assert.match(a.stderr, /阳性对照/);
  // 判给装置 + fail = 矛盾：装置坏了 ⇒ 被测物没被证伪过
  const b = ak(dir, 'record', id, '--expect', 'E1', '--status', 'fail', '--actual', 'app is not running', '--failure-of', 'apparatus');
  assert.notEqual(b.status, 0);
  assert.match(b.stderr, /没被证伪/);
  // 判给装置 + blocked：放行，并进台账
  const c = ak(dir, 'record', id, '--expect', 'E1', '--status', 'blocked', '--blocked-kind', 'capability',
    '--actual', 'app is not running（两台在线，默认去了另一台）', '--failure-of', 'apparatus', '--unlock', '我要给取证命令显式指定设备');
  assert.equal(c.status, 0, c.stderr);
  let r = JSON.parse(readFileSync(join(dir, 'runs', id, 'result.json'), 'utf8'));
  assert.equal(r.apparatus.length, 1);
  assert.equal(r.apparatus[0].where, 'E1');
  assert.ok(r.apparatus[0].markers.includes('not running'));
  assert.equal(r.results.E1.failure_of, 'apparatus');
  // 同一句话重记不重复登记
  assert.equal(ak(dir, 'record', id, '--expect', 'E1', '--status', 'blocked', '--blocked-kind', 'capability',
    '--actual', 'app is not running（两台在线，默认去了另一台）', '--unlock', '我要给取证命令显式指定设备').status, 0);
  r = JSON.parse(readFileSync(join(dir, 'runs', id, 'result.json'), 'utf8'));
  assert.equal(r.apparatus.length, 1);
  // 换了一段新说法 ⇒ 旧分类不再背书，必须重新分类
  const d = ak(dir, 'record', id, '--expect', 'E1', '--status', 'blocked', '--blocked-kind', 'capability',
    '--actual', '抓到的 logcat 是上一轮的缓冲区，证据落了 0 字节', '--unlock', '我要改成跟随模式再抓');
  assert.notEqual(d.status, 0);
  assert.match(d.stderr, /装置故障词/);
  // 判给被测物：照常写入，归类留痕供盲审对照
  const e = ak(dir, 'record', id, '--expect', 'E2', '--status', 'fail', '--evidence', 'evidence/out.json',
    '--actual', '被测物自己打出 permission denied', '--failure-of', 'subject');
  assert.equal(e.status, 0, e.stderr);
  r = JSON.parse(readFileSync(join(dir, 'runs', id, 'result.json'), 'utf8'));
  assert.equal(r.results.E2.failure_of, 'subject');
  assert.equal(r.apparatus.length, 1);
});

test('写死的读数：探针脚本把结论写成字面量 → 拒收；确属常量要写理由', () => {
  const dir = project({}, { 'cases/c1.case.json': CASE, 'ops/registry.json': OPS, 'state/plans/D1.json': PLAN(true) });
  const id = runWithEvidence(dir);
  writeFileSync(join(dir, 'runs', id, 'evidence', 'probe.js'), 'function probe() {\n  say("installed", true);\n}\n');
  const a = ak(dir, 'record', id, '--expect', 'E1', '--status', 'pass', '--evidence', 'evidence/probe.js');
  assert.notEqual(a.status, 0);
  assert.match(a.stderr, /把读数写死了/);
  assert.match(a.stderr, /installed/);
  const b = ak(dir, 'record', id, '--expect', 'E1', '--status', 'pass', '--evidence', 'evidence/probe.js',
    '--allow-literal', '这是传给探针的开关入参，不是读数');
  assert.equal(b.status, 0, b.stderr);
  assert.match(b.stderr, /已 --allow-literal 放行/);
});

test('盲审：apparatus_failure 退回 todo 并自动进台账', () => {
  const dir = project({}, { 'cases/c1.case.json': CASE, 'ops/registry.json': OPS, 'state/plans/D1.json': PLAN(true) });
  const id = runWithEvidence(dir);
  assert.equal(ak(dir, 'record', id, '--expect', 'E1', '--status', 'pass', '--evidence', 'evidence/out.json').status, 0);
  const pkt = ak(dir, 'review', id, '--next');
  assert.match(pkt.stdout, /apparatus_failure/);
  assert.match(pkt.stdout, /是\*\*被测物\*\*的失败，还是/);
  assert.match(pkt.stdout, /读出来的.*还是.*写进去的/s);
  const w = ak(dir, 'review', id, '--item', 'E1::evidence/out.json', '--verdict', 'apparatus_failure',
    '--note', '这份读数是探针超时后重连前取的，反映的是取证通道，不是被测物', '--by', 'blind');
  assert.equal(w.status, 0, w.stderr);
  const r = JSON.parse(readFileSync(join(dir, 'runs', id, 'result.json'), 'utf8'));
  assert.equal(r.results.E1.status, 'todo');
  assert.equal(r.apparatus.length, 1);
  assert.equal(r.apparatus[0].source, 'review');
  assert.equal(r.apparatus[0].verdict, 'apparatus_failure');
  assert.match(ak(dir, 'apparatus', id).stdout, /盲审 apparatus_failure/);
});

test('报告：装置故障单列一节、进 run.json，但不改判定', () => {
  const dir = project({}, { 'cases/c1.case.json': CASE, 'ops/registry.json': OPS, 'state/plans/D1.json': PLAN(true) });
  const id = runWithEvidence(dir);
  assert.equal(ak(dir, 'record', id, '--expect', 'E1', '--status', 'pass', '--evidence', 'evidence/out.json').status, 0);
  for (const e of ['E2', 'E3']) assert.equal(ak(dir, 'record', id, '--expect', e, '--status', 'skip').status, 0);
  assert.equal(ak(dir, 'report', id).status, 0);
  const before = JSON.parse(readFileSync(join(dir, 'runs', id, 'result.json'), 'utf8')).verdict;
  assert.equal(ak(dir, 'apparatus', id, '--what', '诊断包装了 7 次才稳，期间读数是上一个包的', '--fix', '装完比对安装时间戳再取数', '--cost', '7').status, 0);
  assert.equal(ak(dir, 'report', id).status, 0);
  const md = readFileSync(join(dir, 'runs', id, 'run.md'), 'utf8');
  assert.match(md, /## 本轮装置故障（1 次）/);
  assert.match(md, /装完比对安装时间戳再取数/);
  assert.match(md, /折腾 7 轮/);
  assert.match(md, /不计入结论、不改判定/);
  const after = JSON.parse(readFileSync(join(dir, 'runs', id, 'result.json'), 'utf8'));
  assert.equal(after.verdict, before);
  assert.equal(JSON.parse(readFileSync(join(dir, 'runs', id, 'run.json'), 'utf8')).apparatus, 1);
  assert.match(md, /"apparatus_failures"/);
});

test('平台不适用：observe 没有本端读法记 na 且落盘；断言 platforms 不含本端只能记 na', () => {
  const PCASE = {
    case: 'c1', title: '示例', platform: 'web', classifications: { carrier: ['web'] },
    tree: [{ op: '读产物', tags: { carrier: 'web' }, expect: [
      { id: 'E1', assert: '只有 iOS 的读法', observe: { intent: '只在 iOS 上有', by: { ios: { op: 'read-json', params: { file: 'evidence/out.json' }, checks: [{ pick: 'ok', predicate: { eq: true } }] } } } },
      { id: 'E2', assert: '只适用 iOS 的手工断言', platforms: ['ios'] },
      { id: 'E3', assert: '本端适用的手工断言' },
    ] }],
  };
  const dir = project({}, { 'cases/c1.case.json': PCASE, 'ops/registry.json': OPS, 'state/plans/D1.json': PLAN(true) });
  assert.equal(ak(dir, 'run', 'c1', '--demand', 'D1').status, 0);
  const id = readdirSync(join(dir, 'runs'))[0];
  const o = ak(dir, 'observe', id, '--expect', 'E1');
  assert.equal(o.status, 0, o.stderr + o.stdout);
  const read = () => JSON.parse(readFileSync(join(dir, 'runs', id, 'result.json'), 'utf8')).results;
  // observe 末尾的 saveResult 曾拿旧的内存结果把这条 na 覆盖回 todo
  assert.equal(read().E1.status, 'na');
  assert.equal(read().E1.na_platform, 'web');
  assert.notEqual(ak(dir, 'record', id, '--expect', 'E2', '--status', 'pass', '--actual', 'x').status, 0);
  assert.equal(ak(dir, 'record', id, '--expect', 'E2', '--status', 'na', '--actual', '只适用 iOS').status, 0);
  assert.equal(read().E2.status, 'na');
  // 对照：没声明平台范围、也没声明版本范围的断言不能记 na；命令行也伪造不了内部的平台 na
  assert.notEqual(ak(dir, 'record', id, '--expect', 'E3', '--status', 'na', '--actual', 'x').status, 0);
  assert.notEqual(ak(dir, 'record', id, '--expect', 'E3', '--status', 'na', '--actual', 'x', '--platform-na', 'web').status, 0);
});

test('断言声明 platforms 不含本轮平台：建 run 预填 na；observe 不跑另一端的配方，把记错的（假 blocked）改成 na', () => {
  const C = { case: 'c1', title: '只在 iOS 有的读值', platform: 'android', classifications: { carrier: ['web'] },
    tree: [{ op: '读产物', tags: { carrier: 'web' }, expect: [
      { id: 'E1', assert: 'iOS 才有的启动判定', platforms: ['ios'], observe: { op: 'read-json', params: { file: 'evidence/ios-only.json' }, checks: [{ pick: 'ok', predicate: { eq: true } }] } },
      { id: 'E2', assert: '两端都有', observe: { op: 'read-json', params: { file: 'evidence/out.json' }, checks: [{ pick: 'ok', predicate: { eq: true } }] } }] }] };
  const ops = { ops: { 'read-json': { kind: 'observe', title: '读产物', platforms: { android: { exec: 'json-file', strength: 'S2' } } } } };
  const dir = project({}, { 'cases/c1.case.json': C, 'ops/registry.json': ops, 'state/plans/D1.json': { ...PLAN(true), platform: 'android' } });
  const run = ak(dir, 'run', 'c1', '--demand', 'D1');
  assert.equal(run.status, 0, run.stderr);
  const id = readdirSync(join(dir, 'runs'))[0];
  const res = () => JSON.parse(readFileSync(join(dir, 'runs', id, 'result.json'), 'utf8'));
  assert.equal(res().results.E1.status, 'na');
  assert.equal(res().results.E1.na_platform, 'android');
  assert.match(res().results.E1.actual, /platforms=\[ios\]/);
  assert.equal(res().results.E2.status, 'todo');
  // 早先被另一端的配方记成了假 blocked：重跑 observe 改成 na，且不去读 iOS 那份产物
  const r = res(); r.results.E1 = { status: 'blocked', actual: '前提不成立，无从判定', evidence: [] };
  writeFileSync(join(dir, 'runs', id, 'result.json'), JSON.stringify(r));
  const o = ak(dir, 'observe', id, '--expect', 'E1');
  assert.equal(o.status, 0, o.stderr + o.stdout);
  assert.match(o.stderr, /平台不适用：断言声明 platforms=\[ios\]/);
  assert.equal(res().results.E1.status, 'na');
  assert.ok(!existsSync(join(dir, 'runs', id, 'evidence', 'obs')), '不该跑任何观测配方');
});
