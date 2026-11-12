// 一个项目多个被测 App（宿主）：每个 App 的包名、构建做法、只在它身上成立的操作配方各存各的，
// 新 App 可以借鉴别的 App，但最后落在它自己那份上 —— 不会出现「A 的做法和 B 的做法只能留一个」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'bin', 'acceptkit.mjs');
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
const ak = (dir, ...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, ACCEPTKIT_PROJECT: dir, HOME: dir } });
const read = (dir, rel) => readFileSync(join(dir, rel), 'utf8');
const TWO = { hosts: { main: { android: { package: 'com.example.main' } }, shop: { android: { package: 'com.example.shop' } } } };

test('两个 App 的构建做法各存一份，互不覆盖；没指定宿主时报错而不是挑一个', () => {
  const dir = project(TWO);
  assert.equal(ak(dir, 'setting', 'set', 'build', '--platform', 'android', '--run', 'echo x').status, 1, '多个宿主时写构建要说清写给谁');
  assert.equal(ak(dir, 'setting', 'set', 'build', '--platform', 'android', '--host', 'main', '--run', 'echo main {bundle} > out.txt').status, 0);
  assert.equal(ak(dir, 'setting', 'set', 'build', '--platform', 'android', '--host', 'shop', '--run', 'echo shop {bundle} > out.txt').status, 0);
  assert.match(ak(dir, 'build', '--platform', 'android').stderr, /多个 android 宿主（main \/ shop）/);
  assert.equal(ak(dir, 'build', '--platform', 'android', '--host', 'main').status, 0);
  assert.equal(read(dir, 'out.txt').trim(), 'main com.example.main');
  assert.equal(ak(dir, 'build', '--platform', 'android', '--host', 'shop').status, 0);
  assert.equal(read(dir, 'out.txt').trim(), 'shop com.example.shop');
});

test('新 App 借鉴别的 App（本项目 / 别的项目）：拷成自己的推测；试跑通过也不自动升级；走不通改自己那份不影响源头', () => {
  const other = project({ hosts: { origin: { android: { package: 'com.example.origin' } } } });
  ak(other, 'setting', 'set', 'build', '--platform', 'android', '--run', 'echo borrowed {bundle} > out.txt', '--note', '源宿主的坑');
  const dir = project({ hosts: { shop: { android: { package: 'com.example.shop' } } } });
  assert.match(ak(dir, 'build', '--platform', 'android').stderr, /setting borrow build/);
  let r = ak(dir, 'setting', 'borrow', 'build', '--platform', 'android', '--host', 'shop', '--from', `${other}:origin`);
  assert.equal(r.status, 0, r.stderr);
  const own = read(dir, 'knowledge/settings/android/shop/build.md');
  assert.match(own, /状态：推测/); assert.match(own, /借鉴自/); assert.match(own, /源宿主的坑/);
  assert.match(ak(dir, 'build', '--platform', 'android').stderr, /还是推测/, '推测不直接执行');
  r = ak(dir, 'build', '--platform', 'android', '--try');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(dir, 'out.txt').trim(), 'borrowed com.example.shop', '占位符按新 App 填');
  assert.match(read(dir, 'knowledge/settings/android/shop/build.md'), /状态：推测/, '退出码 0 不等于产物是这个 App 的包');
  assert.equal(ak(dir, 'setting', 'verify', 'build', '--platform', 'android', '--host', 'shop').status, 1, '升级要写核对了什么');
  assert.equal(ak(dir, 'setting', 'verify', 'build', '--platform', 'android', '--host', 'shop', '--evidence', '产物包名是 com.example.shop').status, 0);
  // 已有自己的那份就不再借鉴（不覆盖自己试出来的）
  assert.equal(ak(dir, 'setting', 'borrow', 'build', '--platform', 'android', '--host', 'shop', '--from', `${other}:origin`).status, 1);
  ak(dir, 'setting', 'set', 'build', '--platform', 'android', '--host', 'shop', '--run', 'echo own > out.txt');
  assert.match(read(other, 'knowledge/settings/android/origin/build.md'), /echo borrowed/, '源头不受影响');
});

test('驱动：同平台共用一份，某个 App 例外时用它自己的那份', () => {
  const dir = project(TWO);
  ak(dir, 'setting', 'set', 'driver', '--platform', 'android', '--ui-tree', 'echo shared');
  ak(dir, 'setting', 'set', 'driver', '--platform', 'android', '--host', 'shop', '--ui-tree', 'echo shop-own');
  assert.equal(ak(dir, 'drive', 'ui-tree', '--host', 'main').stdout.trim(), 'shared');
  assert.equal(ak(dir, 'drive', 'ui-tree', '--host', 'shop').stdout.trim(), 'shop-own');
  assert.match(ak(dir, 'setting', 'show').stdout, /main · Android · 驱动 App\s+knowledge\/settings\/android\/driver\.md（同平台共用）/);
});

test('操作配方：平台@宿主 优先于通用；宿主上写 absent 就不套用通用做法；适用性按用例的宿主算', () => {
  const OPS = { ops: { 'skip-login': { title: '跳过登录', why: 'w', platforms: {
    android: { how: '通用', state: 'confirmed' },
    'android@shop': { absent: true, blocker: 'shop 没有登录页' },
  } } } };
  const node = { op: '跳过登录', op_id: 'skip-login', tags: {}, expect: [{ id: 'E1', assert: '进到首页' }] };
  const dir = project(TWO, { 'ops/registry.json': OPS,
    'cases/a.case.json': { case: 'a', title: 'a', platform: 'android', host: 'main', classifications: {}, tree: [node] },
    'cases/b.case.json': { case: 'b', title: 'b', platform: 'android', host: 'shop', classifications: {}, tree: [node] },
    'cases/c.case.json': { case: 'c', title: 'c', platform: 'android', classifications: {}, tree: [node] },
    'cases/d.case.json': { case: 'd', title: 'd', platform: 'android', host: 'nope', classifications: {}, tree: [node] } });
  assert.doesNotMatch(ak(dir, 'validate', 'a').stdout + ak(dir, 'validate', 'a').stderr, /没有配方/);
  assert.match(ak(dir, 'validate', 'b').stdout + ak(dir, 'validate', 'b').stderr, /没有配方：skip-login/);
  assert.match(ak(dir, 'quality', 'c').stdout, /Q15 .*android 上登记了 main \/ shop，用例没写 host/);
  assert.match(ak(dir, 'validate', 'd').stdout + ak(dir, 'validate', 'd').stderr, /host=nope 没有登记/);
  // 写口：--host 写的是 平台@宿主 那份；没登记的宿主拒写
  assert.equal(ak(dir, 'ops', 'set', 'skip-login', '--platform', 'android', '--host', 'ghost', '--how', 'x').status, 1);
  assert.equal(ak(dir, 'ops', 'set', 'skip-login', '--platform', 'android', '--host', 'shop', '--how', '点跳过', '--replace').status, 0);
  const o = JSON.parse(read(dir, 'ops/registry.json')).ops['skip-login'].platforms;
  assert.equal(o['android@shop'].how, '点跳过'); assert.equal(o.android.how, '通用');
});

test('doctor --fix：只有一个宿主时旧写法自动迁；多个宿主时不猜，报出来让人拆', () => {
  const one = project({ app: { ios: { bundle: 'com.example.app' } } }, { 'knowledge/settings/ios/build.md': '# iOS · 构建\n\n- 状态：已确认\n\n## 命令\n\n- run: `true`\n',
    'ops/registry.json': { ops: { x: { title: 't', why: 'w', platforms: { ios_main: { how: 'h', state: 'confirmed' }, ios: { how: 'h', host: '仅主 App', state: 'confirmed' } } } } } });
  let r = ak(one, 'doctor', '--fix');
  assert.match(r.stdout, /app → hosts\.main/);
  const cfg = JSON.parse(read(one, 'acceptkit.project.json'));
  assert.equal(cfg.hosts.main.ios.bundle, 'com.example.app'); assert.equal(cfg.app, undefined);
  assert.ok(existsSync(join(one, 'knowledge/settings/ios/main/build.md')));
  const ps = JSON.parse(read(one, 'ops/registry.json')).ops.x.platforms;
  assert.ok(ps['ios@main']); assert.deepEqual(ps.ios.caveats, ['限定宿主：仅主 App']);
  const two = project({ app: { android: { package: 'com.example.a' } } }, {
    'cases/a.case.json': { case: 'a', platform: 'android', host: 'a' }, 'cases/b.case.json': { case: 'b', platform: 'android', host: 'b' } });
  r = ak(two, 'doctor', '--fix');
  assert.match(r.stdout, /没有迁移：用例里写到了 2 个宿主/);
  assert.ok(JSON.parse(read(two, 'acceptkit.project.json')).app, '不迁就原样留着');
  assert.equal(ak(two, 'config', 'check').status, 1);
});
