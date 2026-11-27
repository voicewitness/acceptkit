// 用户设置进来的东西（操作库、项目配置、知识）都有写口：写入时校验，手改的文件过同一道检查。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
const freePort = () => new Promise(ok => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });

const BIN = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'bin', 'acceptkit.mjs');
function project(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'acceptkit-test-'));
  for (const d of ['cases', 'runs', 'state', 'knowledge']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'acceptkit.project.json'), JSON.stringify({ name: 't', gate: { allow: [] }, hosts: {} }));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  }
  return dir;
}
const ak = (dir, ...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, ACCEPTKIT_PROJECT: dir, HOME: dir } });
const ops = dir => JSON.parse(readFileSync(join(dir, 'ops', 'registry.json'), 'utf8')).ops;

test('ops set：新增要有 title / why，平台只能是内核认的，推测的配方不执行', async () => {
  const dir = project();
  assert.equal(ak(dir, 'ops', 'set', 'skip-login', '--platform', 'android', '--how', '连点 logo').status, 1);
  let r = ak(dir, 'ops', 'set', 'skip-login', '--platform', 'ios', '--title', '跳过登录', '--why', '用例卡在登录页', '--how', '点 Skip', '--guess');
  assert.equal(r.status, 0, r.stderr);
  r = ak(dir, 'ops', 'set', 'skip-login', '--platform', 'android', '--how', '连点三次左上角 logo', '--steps', 'a', '--steps', 'b', '--verified', '本机实测');
  assert.equal(r.status, 0, r.stderr);
  const o = ops(dir)['skip-login'];
  assert.equal(o.platforms.ios.state, 'guess');
  assert.deepEqual(o.platforms.android.steps, ['a', 'b']);
  assert.equal(o.platforms.android.state, 'verified');
  assert.equal(ak(dir, 'ops', 'set', 'skip-login', '--platform', 'harmony', '--how', 'x').status, 1);
  assert.equal(ak(dir, 'ops', 'set', 'skip-login', '--platform', 'ios', '--bogus', 'x').status, 1);
  const { opRecipe } = await import('../core/ops.mjs');
  assert.match(opRecipe(dir, 'skip-login', 'ios').error, /推测/);
  assert.equal(ak(dir, 'ops', 'confirm', 'skip-login', '--platform', 'ios').status, 0);
  assert.equal(opRecipe(dir, 'skip-login', 'ios').how, '点 Skip');
  // 合并：只改给出的字段
  ak(dir, 'ops', 'set', 'skip-login', '--platform', 'android', '--entry', 'SignUpActivity');
  assert.deepEqual(ops(dir)['skip-login'].platforms.android.steps, ['a', 'b']);
  assert.equal(ak(dir, 'ops', 'set', 'skip-login', '--platform', 'web', '--absent', '没有网页端').status, 0);
  assert.equal(ops(dir)['skip-login'].platforms.web.blocker, '没有网页端');
});

test('ops rm：还被用例引用就拒绝', () => {
  const dir = project({ 'cases/c1.case.json': { case: 'c1', title: 't', platform: 'ios', tree: [{ op: '登录', op_id: 'skip-login', expect: [] }] } });
  ak(dir, 'ops', 'set', 'skip-login', '--platform', 'ios', '--title', 't', '--why', 'w', '--how', 'h');
  const r = ak(dir, 'ops', 'rm', 'skip-login');
  assert.equal(r.status, 1); assert.match(r.stderr, /c1/);
});

test('手改的操作库：ops check 报结构错误，doctor --fix 迁移旧写法', () => {
  const dir = project({ 'ops/registry.json': { ops: {
    a: { title: 't', why: 'w', platforms: { ios: { how: 'h', tested: '2026-10-01 实测' }, android: { absent: true, how: '没有通道' } } },
    b: { title: 't', why: 'w', platforms: { ios: { how: 'h', verified: '未验证（新增）' }, android_host: { how: 'h' } } },
  } } });
  let r = ak(dir, 'ops', 'check');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /absent 要写 blocker/); assert.match(r.stdout, /android_host/);
  ak(dir, 'doctor', '--fix');
  const o = ops(dir);
  assert.equal(o.a.platforms.android.blocker, '没有通道');
  assert.equal(o.a.platforms.ios.state, 'verified');
  assert.equal(o.b.platforms.ios.state, 'confirmed');   // 写着「未验证」的不能迁成已验证
  r = ak(dir, 'ops', 'check');
  assert.equal(r.status, 1); assert.doesNotMatch(r.stdout, /blocker/);   // 只剩宿主混进平台轴那一处，改不了的留给人
});

test('config：白名单、被测 App 按登记的类型写入；手改写错的项 doctor 报出来', () => {
  const dir = project();
  assert.equal(ak(dir, 'host', 'add', 'demo', '--platform', 'web', '--port', 'abc').status, 1);
  assert.equal(ak(dir, 'host', 'add', 'demo', '--platform', 'web', '--port', '9300').status, 0);
  assert.equal(ak(dir, 'config', 'add', 'gate.allow', 'emu-1', '--kind', 'device', '--note', '测试机', '--profile', 'host=demo').status, 0);
  assert.equal(ak(dir, 'config', 'add', 'gate.allow', 'x', '--kind', 'phone', '--note', 'n').status, 1);
  assert.equal(ak(dir, 'config', 'add', 'gate.allow', 'y', '--kind', 'device').status, 1);
  assert.equal(ak(dir, 'config', 'set', 'quality.dangerOps', '触发(').status, 1);
  assert.equal(ak(dir, 'config', 'set', 'no.such', '1').status, 1);
  ak(dir, 'config', 'add', 'gate.allow', 'emu-1', '--kind', 'device', '--note', '改了备注');
  let cfg = JSON.parse(readFileSync(join(dir, 'acceptkit.project.json'), 'utf8'));
  assert.equal(cfg.gate.allow.length, 1); assert.equal(cfg.gate.allow[0].note, '改了备注');
  assert.equal(cfg.hosts.demo.web.port, 9300);
  cfg.gate.allow.push({ value: 'z', type: 'device' }); cfg.hosts.demo.web.port = '9300';
  writeFileSync(join(dir, 'acceptkit.project.json'), JSON.stringify(cfg));
  const r = ak(dir, 'doctor');
  assert.match(r.stdout, /gate\.allow 第 2 项/); assert.match(r.stdout, /hosts\.demo\.web\.port 要写成正整数/);
  assert.equal(ak(dir, 'config', 'check').status, 1);
});

test('know edit / rm：机密条目改写后仍是机密，旧值不回显', () => {
  const dir = project({ 'knowledge/acc.md': '# 账号\n\n- 账号 kid1 密码 hunter2 #account #secret\n- 另一条\n  续行\n- 第三条\n' });
  let r = ak(dir, 'know', 'edit', 'acc.md:3', '账号 kid1 密码 newpass #account');
  assert.equal(r.status, 0, r.stderr); assert.doesNotMatch(r.stdout, /hunter2/);
  r = ak(dir, 'know', 'rm', 'acc.md:4');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(dir, 'knowledge', 'acc.md'), 'utf8'), '# 账号\n\n- 账号 kid1 密码 newpass #account #secret\n- 第三条\n');
});

test('--project 写在命令前面也认', () => {
  const dir = project();
  const r = spawnSync(process.execPath, [BIN, '--project', dir, 'config', 'show'], { cwd: tmpdir(), encoding: 'utf8', env: { ...process.env, ACCEPTKIT_PROJECT: '', HOME: dir } });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /gate\.allow/);
});

test('link：按上下文给报告地址 —— 不给就是最近一次运行，打开自己的管理页面；需求落到需求页；网址模板来自配置', async () => {
  const dir = project({
    'runs/r1/result.json': { case: 'c1', run: 'r1', session: 's-D1', demand: { id: 'D1' } },
    'runs/r1/run.md': '# 报告',
    'runs/r1/evidence/out.json': { ok: true },
    'knowledge/acc.md': '- 密码 x #secret',
    'state/rounds/D1.json': { rounds: [{ id: 'R1' }, { id: 'R2' }] },
    'cases/c2.case.json': { case: 'c2' },
  });
  // 缺省指向 acceptkit 自己的管理页面（没在跑就后台起一个）；测试用随机端口，跑完停掉
  const port = await freePort();
  mkdirSync(join(dir, '.config', 'acceptkit'), { recursive: true });
  writeFileSync(join(dir, '.config', 'acceptkit', 'config.json'), JSON.stringify({ serve: { port } }));
  let r = ak(dir, 'link', '--json');
  try {
    let j = JSON.parse(r.stdout);
    assert.equal(j.url, `http://127.0.0.1:${port}/p/t/#run=s-D1`); assert.match(j.report, /runs\/r1\/run\.md$/);
    const page = await fetch(j.url.split('#')[0]);
    assert.equal(page.status, 200); assert.match(await page.text(), /data-k="s-D1"/, '看板上有这个面板');
    assert.equal((await fetch(`http://127.0.0.1:${port}/p/t/asset?f=../../etc/passwd`)).status, 400, '不出项目目录外的文件');
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/p/t/evidence?f=runs%2Fr1%2Fevidence%2Fout.json`)).json(), { text: '{\n "ok": true\n}', truncated: false }, '证据点开时再取');
    assert.equal((await fetch(`http://127.0.0.1:${port}/p/t/evidence?f=knowledge%2Facc.md`)).status, 400, '证据接口只出运行证据，不出知识');
    const index = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.match(index, /href="\/p\/t\/"/);
  } finally { ak(dir, 'serve', 'stop'); }
  assert.equal(ak(dir, 'config', 'set', 'dashboard.url', 'http://h/boards?run={key}').status, 0);
  assert.equal(ak(dir, 'config', 'set', 'dashboard.url', 'h/boards').status, 1);
  assert.equal(JSON.parse(ak(dir, 'link', 'D1', '--json').stdout).url, 'http://h/boards?run=D1');   // 需求只有一个地址：需求页
  assert.equal(JSON.parse(ak(dir, 'link', 'c2', '--json').stdout).url, 'http://h/boards?run=case%3Ac2');
  ak(dir, 'config', 'set', 'dashboard.url', 'http://h/b?run={run}');
  assert.equal(JSON.parse(ak(dir, 'link', 'D1', '--json').stdout).url, 'http://h/b?run=r1', '按运行定位的看板：需求取它最近一次运行');
  assert.match(ak(dir, 'link', 'c2').stderr, /还没有运行/);
  assert.match(ak(dir, 'link', 'nope').stderr, /不是运行、需求，也不是用例/);
});
