// 冒烟闸：项目声明冒烟项；评审单批过后，这一轮冒烟没过就不派用例运行；新一轮要重冒烟。环境检查拦残留覆盖配置、没登记的装包、包不对。
// 起因：一个端上需求头 4 天在没装配起来的包上首跑了 41 条用例，结论大多后来重置重跑。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { androidChecks, hostChecks, smokeState } from '../core/smoke.mjs';

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'acceptkit.mjs');
const ak = (dir, ...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, ACCEPTKIT_PROJECT: dir, HOME: dir } });
const ok = (dir, ...args) => { const r = ak(dir, ...args); assert.equal(r.status, 0, `${args.join(' ')}\n${r.stdout}\n${r.stderr}`); return r; };
const cards = dir => JSON.parse(ok(dir, 'next', 'D1', '--json').stdout).cards;
const kinds = dir => cards(dir).map(c => c.kind);

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'acceptkit-smoke-'));
  for (const d of ['cases', 'runs', 'state/plans', 'knowledge', 'ops']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'acceptkit.project.json'), JSON.stringify({ name: 't', gate: { allow: [] }, smoke: { android: {
    env: { override_files: ['/data/local/tmp/mock.json'] },
    items: [{ id: 'S1', assert: '装配结果读到 assembled=true', observe: { op: 'diag-read', checks: [{ pick: 'assembled', predicate: { eq: true } }] } },
            { id: 'S2', assert: '冷启后决策数大于 0', observe: { op: 'diag-read', checks: [{ pick: 'decisions', predicate: { gt: 0 } }] } }] } } }));
  writeFileSync(join(dir, 'ops', 'registry.json'), JSON.stringify({ ops: { 'diag-read': { kind: 'observe', title: '读诊断产物', platforms: { android: { exec: 'json-file', strength: 'S2' } } } } }));
  writeFileSync(join(dir, 'cases', 'c1.case.json'), JSON.stringify({ case: 'c1', title: '首页问候语', platform: 'android',
    classifications: { carrier: ['page'] },
    tree: [{ op: '打开首页', tags: { carrier: 'page' }, expect: [{ id: 'E1', assert: '页面顶部显示「你好」' }] }] }));
  ok(dir, 'plan', 'new', 'D1', '--title', '首页问候', '--platform', 'android');
  ok(dir, 'plan', 'add-case', 'D1', '--surface', 'S1', '--change', '首页加了问候语', '--reuse', 'c1', '--risk', '看不到问候', '--uncovered', '其他页');
  ok(dir, 'plan', 'approve', 'D1', '--by', 'owner', '--quote', '可以');
  return dir;
}
const setSmoke = (dir, run, patch) => { const f = join(dir, 'runs', run, 'result.json'); const r = JSON.parse(readFileSync(f, 'utf8')); patch(r); writeFileSync(f, JSON.stringify(r)); };

test('冒烟没过不派用例运行；过了才派；新一轮重冒烟', () => {
  const dir = project();
  let cs = cards(dir);
  assert.ok(cs.some(c => c.kind === 'smoke_needed'), '还没冒烟：出 smoke_needed');
  assert.ok(!cs.some(c => c.kind === 'run_needed'), '冒烟前不派用例运行');
  assert.deepEqual(cs.find(c => c.kind === 'smoke_needed').held.map(h => h.case), ['c1'], '卡片上看得见被挡住的用例');
  const s = JSON.parse(ok(dir, 'smoke', 'D1', '--json').stdout);
  assert.deepEqual(s.items, ['S1', 'S2']);
  const run = s.run;
  assert.ok(!kinds(dir).includes('run_needed'), '冒烟进行中也不派');
  // S2 读数不对：冒烟没过，卡片写清哪一项、读到什么
  setSmoke(dir, run, r => { r.device = { key: 'avd:x' }; r.results.S1 = { status: 'pass', actual: 'assembled=true', evidence: [] };
    r.results.S2 = { status: 'fail', actual: 'decisions=0', evidence: [] }; r.smoke_env = { checks: [{ id: 'host_swap', ok: true }] }; });
  cs = cards(dir);
  const f = cs.find(c => c.kind === 'smoke_failed');
  assert.ok(f && /S2/.test(f.title) && f.detail.some(d => /decisions=0/.test(d)), JSON.stringify(f));
  assert.ok(!cs.some(c => c.kind === 'run_needed'));
  // 看板：本轮冒烟没过和用例失败分开说
  const out = join(dir, 'board.html');
  const b = spawnSync(process.execPath, [join(dirname(BIN), '..', 'core', 'dashboard.mjs'), out], { cwd: dir, encoding: 'utf8', env: { ...process.env, ACCEPTKIT_PROJECT: dir, HOME: dir } });
  assert.equal(b.status, 0, b.stderr);
  assert.match(readFileSync(out, 'utf8'), /本轮的包冒烟没过.*S2 冷启后决策数大于 0：decisions=0/);
  // 环境有残留覆盖配置：同样挡
  setSmoke(dir, run, r => { r.results.S2 = { status: 'pass', actual: 'decisions=12', evidence: [] }; r.smoke_env = { checks: [{ id: 'override:/data/local/tmp/mock.json', title: '没有残留的覆盖配置', ok: false }] }; });
  assert.ok(kinds(dir).includes('smoke_failed'), '环境不干净也算没过');
  // 都过了：派用例运行
  setSmoke(dir, run, r => { r.smoke_env = { checks: [{ id: 'host_swap', ok: true }] }; });
  cs = cards(dir);
  assert.ok(cs.some(c => c.kind === 'run_needed' && c.case === 'c1'), cs.map(c => c.kind).join());
  assert.ok(!cs.some(c => /^smoke_/.test(c.kind)));
  // 新一轮（出了新包）：上一轮的冒烟不算，重冒烟
  const rf = join(dir, 'state', 'rounds', 'D1.json'); const j = JSON.parse(readFileSync(rf, 'utf8'));
  j.rounds.push({ id: 'R-next', seq: j.rounds.length + 1, opened_at: new Date(Date.now() + 1000).toISOString(), code: {} }); writeFileSync(rf, JSON.stringify(j));
  cs = cards(dir);
  assert.ok(cs.some(c => c.kind === 'smoke_needed') && !cs.some(c => c.kind === 'run_needed'), cs.map(c => c.kind).join());
});

test('smoke.<平台>.demands 只闸列出的需求（试用）', () => {
  const dir = project();
  const cfg = JSON.parse(readFileSync(join(dir, 'acceptkit.project.json'), 'utf8')); cfg.smoke.android.demands = ['D7'];
  writeFileSync(join(dir, 'acceptkit.project.json'), JSON.stringify(cfg));
  const ks = kinds(dir);
  assert.ok(ks.includes('run_needed') && !ks.some(k => /^smoke_/.test(k)), ks.join());
});

test('没声明冒烟项的项目照旧：不出冒烟卡片', () => {
  const dir = project();
  const cfg = JSON.parse(readFileSync(join(dir, 'acceptkit.project.json'), 'utf8')); delete cfg.smoke;
  writeFileSync(join(dir, 'acceptkit.project.json'), JSON.stringify(cfg));
  const ks = kinds(dir);
  assert.ok(ks.includes('run_needed') && !ks.some(k => /^smoke_/.test(k)), ks.join());
  assert.match(ak(dir, 'smoke', 'D1').stderr, /没声明 android 的冒烟项/);
});

test('环境检查：包对不上、残留覆盖配置、没登记的装包都判没过，并写明上一次谁占着；读不到不算过', () => {
  const dev = { 'pm path': 'package:/data/app/x/base.apk', sha256sum: 'aaa  /data/app/x/base.apk', 'ls -l /data/local/tmp/mock.json': '-rw-r--r-- 1 shell shell 40 mock.json\n{"fuse":true}',
    'dumpsys package': 'lastUpdateTime=2026-11-16 15:00:00', date: '+0900' };
  const adb = args => { const k = Object.keys(dev).find(x => args.join(' ').includes(x)); return { ok: !!k, out: k ? dev[k] : '' }; };
  const apk = join(mkdtempSync(join(tmpdir(), 'ak-apk-')), 'app.apk'); writeFileSync(apk, 'not the same');
  const reg = Date.parse('2026-11-16T14:00:00+09:00');
  const cs = androidChecks({ adb, pkg: 'com.x', apk, overrideFiles: ['/data/local/tmp/mock.json'], installs: [reg], lastRun: { run: 'r9', demand: 'D2', at: '2026-11-16T05:00:00Z' } });
  const by = id => cs.find(c => c.id === id);
  assert.equal(by('pkg_sha').ok, false);
  assert.equal(by('override:/data/local/tmp/mock.json').ok, false);
  assert.match(by('override:/data/local/tmp/mock.json').reading, /fuse/, '原始读数留着');
  assert.equal(by('install_registered').ok, false, '15:00 装的、最后登记是 14:00');
  assert.match(by('install_registered').reading, /r9.*D2/);
  const withOps = androidChecks({ adb, pkg: 'com.x', apk, installs: [reg], ops: [{ at: '2026-11-16T06:01:00Z', session: 'abcdef123456', project: 'p', cmd: 'adb -s emulator-5554 install -r app.apk' }] });
  assert.match(withOps.find(c => c.id === 'install_registered').why, /会话 abcdef12 · p/, '账本查得到是哪个会话装的');
  const ok2 = androidChecks({ adb, pkg: 'com.x', apk: null, overrideFiles: [], installs: [Date.parse('2026-11-16T15:00:30+09:00')] });
  assert.equal(ok2.find(c => c.id === 'pkg_sha').ok, null, '没给被测包：读不到，不算过');
  assert.equal(ok2.find(c => c.id === 'install_registered').ok, true);
  const h = hostChecks({ maxSwapPct: 80, maxLoadPerCore: 1.5 }, { swap: () => 'vm.swapusage: total = 32768.00M  used = 31500.00M  free = 1268.00M', load: () => 4, cores: () => 8 });
  assert.equal(h.find(c => c.id === 'host_swap').ok, false);
  assert.equal(h.find(c => c.id === 'host_load').ok, true);
  assert.equal(smokeState([{ id: 'r', r: { results: { S1: { status: 'pass' } }, smoke_env: { checks: [{ id: 'pkg_sha', ok: null }] } } }], { items: [{ id: 'S1' }] }).state, 'fail',
    '读不到的环境项也不算过');
});
