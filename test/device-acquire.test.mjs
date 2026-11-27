// device acquire / reject：代码选一台并占上，执行者核对后可以否决，代码换下一台（docs/design/003-changes.md D）。
// 不碰真实设备：设备列表、状态、启动都由项目扩展钩子（listDevices / simState / bootDevice）从一份快照文件读写。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'bin', 'acceptkit.mjs');
const ak = (dir, ...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, ACCEPTKIT_PROJECT: dir, HOME: dir } });
const ok = (dir, ...args) => { const r = ak(dir, ...args); assert.equal(r.status, 0, `${args.join(' ')}\n${r.stdout}\n${r.stderr}`); return r; };
const json = (dir, ...args) => JSON.parse(ok(dir, ...args, '--json').stdout);

// iOS 模拟器身份是 UDID 形状；运行时拼出来，免得仓库里出现像真设备号的串
const udid = d => [8, 4, 4, 4, 12].map(n => d.repeat(n)).join('-');
const SMALL = udid('1');   // 开着，但内存不够
const BIG = udid('2');     // 开着，够
const COLD = udid('3');    // 够，没开机
const PACK = `import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const f = H => join(H.ROOT, 'devices.snapshot.json');
const read = H => JSON.parse(readFileSync(f(H), 'utf8'));
export const listDevices = (platform, H) => Object.entries(read(H)).filter(([, s]) => s.platform === platform && s.state === 'Booted').map(([k]) => k);
export const simState = (ref, H) => read(H)[ref] || { state: '不存在', connected: false };
export const bootDevice = (ref, H) => { const m = read(H); m[ref].state = 'Booted'; writeFileSync(f(H), JSON.stringify(m)); return { ok: true, address: ref }; };
`;

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'acceptkit-test-'));
  for (const d of ['cases', 'runs', 'state/plans', 'knowledge', 'ops']) mkdirSync(join(dir, d), { recursive: true });
  const allow = [[SMALL, 4096], [BIG, 16384], [COLD, 16384]].map(([value, ram]) => ({ value, kind: 'device', note: '测试机', profile: { ram_mb: ram } }));
  writeFileSync(join(dir, 'acceptkit.project.json'), JSON.stringify({ name: 't', gate: { allow } }));
  writeFileSync(join(dir, 'pack.mjs'), PACK);
  writeFileSync(join(dir, 'devices.snapshot.json'), JSON.stringify({
    [SMALL]: { platform: 'ios', name: 'phone-small', state: 'Booted' },
    [BIG]: { platform: 'ios', name: 'phone-big', state: 'Booted', app: { bundle: 'com.example.app', version: '1.2.3' }, running: 'pid 42' },
    [COLD]: { platform: 'ios', name: 'phone-cold', state: 'Shutdown' },
  }));
  writeFileSync(join(dir, 'cases', 'c1.case.json'), JSON.stringify({ case: 'c1', title: '首页问候语', platform: 'ios', input: 'real',
    device_need: { ram_mb: '>=8192' }, classifications: { carrier: ['app_ui'] },
    tree: [{ op: '打开「首页」', tags: { carrier: 'app_ui' }, expect: [{ id: 'E1', assert: '首页顶部显示「你好」' }] }] }));
  ok(dir, 'plan', 'new', 'D1', '--title', '首页问候', '--platform', 'ios');
  ok(dir, 'plan', 'add-case', 'D1', '--surface', 'S1', '--change', '首页加了问候语', '--reuse', 'c1', '--risk', '看不到问候', '--uncovered', '其他页');
  ok(dir, 'plan', 'approve', 'D1', '--by', 'owner', '--quote', '可以');
  ok(dir, 'run', 'c1', '--demand', 'D1');
  return { dir, run: readdirSync(join(dir, 'runs'))[0] };
}
const result = (dir, run) => JSON.parse(readFileSync(join(dir, 'runs', run, 'result.json'), 'utf8'));
const leases = dir => JSON.parse(ok(dir, 'query', 'SELECT * FROM device_leases', '--json').stdout);
const heldBy = (dir, run) => leases(dir).filter(l => JSON.stringify(l).includes(run));

test('复用档被选中并占上；否决后换下一台（启动档先启动再占）；都不行时出 attention 且不占任何设备', () => {
  const { dir, run } = project();

  // 平台、能力要求从用例推出：小内存那台被淘汰，开着的大内存那台复用
  let card = json(dir, 'device', 'acquire', '--run', run);
  assert.equal(card.kind, 'device');
  assert.equal(card.device, BIG);
  assert.match(card.detail.join('\n'), /com\.example\.app：在跑（pid 42） · 版本 1\.2\.3/);
  assert.match(card.note, new RegExp(`device reject ${BIG} --run ${run}`));
  let r = result(dir, run);
  assert.equal(r.device.key, BIG);
  assert.equal(r.device.holder, r.session, '占用归属记成本 run 的执行');
  const pick = r.device_picks.at(-1);
  assert.equal(pick.via, 'acquire');
  assert.equal(pick.decision, 'reuse');
  assert.match(pick.candidates.find(c => c.key === SMALL).why_not.join(''), /能力不满足：ram_mb=4096/);
  assert.equal(heldBy(dir, run).length, 1);

  // 再要一次：已经占着就原样返回，不换机
  assert.equal(json(dir, 'device', 'acquire', '--run', run).device, BIG);

  // 执行者核对：账号不对 → 否决，释放，自动再选：剩下没开机的那台，先启动再占
  card = json(dir, 'device', 'reject', BIG, '--run', run, '--why', '登录的不是测试账号');
  assert.equal(card.kind, 'device');
  assert.equal(card.device, COLD);
  assert.match(card.title, /刚启动/);
  r = result(dir, run);
  assert.deepEqual(r.device_rejects.map(x => [x.key, x.why]), [[BIG, '登录的不是测试账号']]);
  assert.equal(r.device.key, COLD);
  assert.equal(heldBy(dir, run).length, 1);
  assert.ok(!JSON.stringify(heldBy(dir, run)).includes(BIG), '否决的那台已释放');

  // 再否决：都不行 → attention，不占任何设备，原因逐台写清
  card = json(dir, 'device', 'reject', COLD, '--run', run, '--why', '页面打不开');
  assert.equal(card.kind, 'attention');
  assert.equal(card.subject, 'device');
  assert.match(card.question, /现有的都不能用/);
  assert.match(card.detail.join('\n'), /本 run 否决过：登录的不是测试账号/);
  assert.equal(heldBy(dir, run).length, 0);
  assert.equal(result(dir, run).device, undefined);

  // next 记得这次结论：出 attention（等人加设备），不再让执行者反复 acquire
  const cs = JSON.parse(ok(dir, 'next', 'D1', '--json').stdout).cards;
  assert.equal(cs[0].kind, 'attention');
  assert.equal(cs[0].subject, 'device');
  assert.ok(!cs.some(c => c.kind === 'device_needed'));
});

test('唯一能用的那台被别的 run 占着：不问人，出 device_needed 写明在等谁；放出来后再 acquire 就占上', () => {
  const { dir, run } = project();
  ok(dir, 'device', 'claim', BIG, '--run', 'other-run', '--holder', '另一轮验收');
  // 没开机的那台先被选中启动；执行者否决它，剩下的只有被占着的 BIG（和能力不够的 SMALL）
  assert.equal(json(dir, 'device', 'acquire', '--run', run).device, COLD);
  const card = json(dir, 'device', 'reject', COLD, '--run', run, '--why', '页面打不开');
  assert.equal(card.kind, 'device_needed');
  assert.match(card.detail.join(''), new RegExp(`${BIG}（被 run=other-run`));
  assert.equal(heldBy(dir, run).length, 0);
  let cs = JSON.parse(ok(dir, 'next', 'D1', '--json').stdout).cards;
  assert.ok(!cs.some(c => c.kind === 'attention'), '等别的 run 放手不是人的判断');
  assert.equal(cs[0].kind, 'device_needed');
  assert.match(cs[0].detail.join(''), /等占着的 run 放出来/);

  ok(dir, 'device', 'release', BIG, '--run', 'other-run');
  assert.equal(json(dir, 'device', 'acquire', '--run', run).device, BIG);
  cs = JSON.parse(ok(dir, 'next', 'D1', '--json').stdout).cards;
  assert.ok(!cs.some(c => c.kind === 'device_needed' || c.kind === 'attention'));
});

test('拒收是一句能照着改的话：缺 --run、缺 --why、已经在这台上留了证据', () => {
  const { dir, run } = project();
  let r = ak(dir, 'device', 'acquire', '--json');
  assert.notEqual(r.status, 0);
  assert.match(JSON.parse(r.stdout).refused, /device acquire --run R/);

  json(dir, 'device', 'acquire', '--run', run);
  r = ak(dir, 'device', 'reject', BIG, '--run', run, '--json');
  assert.notEqual(r.status, 0);
  assert.match(JSON.parse(r.stdout).refused, /--why/);

  // 已经在这台上截过图：换机会让证据来自两台，要重开 run
  mkdirSync(join(dir, 'runs', run, 'shots'), { recursive: true });
  writeFileSync(join(dir, 'runs', run, 'shots', 'app-01.png'), Buffer.alloc(64, 1));
  ok(dir, 'record', run, '--step', 'n1', '--evidence', 'shots/app-01.png');
  r = ak(dir, 'device', 'reject', BIG, '--run', run, '--why', '账号不对', '--json');
  assert.notEqual(r.status, 0);
  assert.match(JSON.parse(r.stdout).refused, /重开一个 run/);
  assert.equal(result(dir, run).device.key, BIG);
});

test('validate：device_need 必须是 { 能力: 要求 }', () => {
  const { dir } = project();
  const f = join(dir, 'cases', 'c1.case.json');
  const c = JSON.parse(readFileSync(f, 'utf8'));
  writeFileSync(f, JSON.stringify({ ...c, device_need: ['ram_mb>=8192'] }));
  const r = ak(dir, 'validate', 'c1');
  assert.match(r.stdout + r.stderr, /device_need 要写成/);
});

test('加不加 --json 只换输出：用例文件不在了，两种模式都按 run 里记的平台照常选', () => {
  const { dir, run } = project();
  unlinkSync(join(dir, 'cases', 'c1.case.json'));
  const human = ak(dir, 'device', 'acquire', '--run', run);
  assert.equal(human.status, 0, human.stderr);
  const card = json(dir, 'device', 'acquire', '--run', run);
  assert.equal(card.kind, 'device');
  assert.equal(card.device, result(dir, run).device.key);
});

test('一个需求同一平台只用一台：下一轮接过上一轮那台，不另起；回去接着做会接回来；要第二台得给理由、工具核对', () => {
  const { dir, run } = project();
  assert.equal(json(dir, 'device', 'acquire', '--run', run).device, BIG);
  ok(dir, 'run', 'c1', '--demand', 'D1');
  const run2 = readdirSync(join(dir, 'runs')).find(x => x !== run);
  // 上一轮没收尾、还占着 BIG：不启动 COLD，直接接过来
  let card = json(dir, 'device', 'acquire', '--run', run2);
  assert.equal(card.device, BIG);
  assert.match(result(dir, run2).device_picks.at(-1).took_over, new RegExp(`从 run ${run} 接过来`));
  assert.equal(heldBy(dir, run2).length, 1);
  // 上一轮回来接着做：接回来，不算「别人占着」
  assert.equal(json(dir, 'device', 'acquire', '--run', run).device, BIG);
  // 已经绑了一台的运行不能靠 --parallel 换机
  let r = ak(dir, 'device', 'acquire', '--run', run2, '--parallel', 'owner', '--why', '想换一台再跑一遍', '--json');
  assert.match(JSON.parse(r.stdout).refused, /一次 run 只打一台/);
  // 新一轮要第二台：capability（BIG 满足要求）拒
  ok(dir, 'run', 'c1', '--demand', 'D1');
  const run3 = readdirSync(join(dir, 'runs')).find(x => ![run, run2].includes(x));
  r = ak(dir, 'device', 'acquire', '--run', run3, '--parallel', 'capability', '--why', '想并行快点跑完这两轮', '--json');
  assert.notEqual(r.status, 0);
  assert.match(JSON.parse(r.stdout).refused, /满足这一轮的能力和宿主要求/);
  // owner 明确要求双跑：带人和原话才放行，另选一台并记进运行
  card = json(dir, 'device', 'acquire', '--run', run3, '--parallel', 'owner', '--why', 'owner 要两台同时对比冷启耗时', '--approved-by', 'owner', '--quote', '两台一起跑');
  assert.equal(card.device, COLD);
  const p = result(dir, run3).parallel_devices.at(-1);
  assert.equal(p.kind, 'owner');
  assert.equal(p.with, BIG);
  // 手动 claim 也守同一条
  ok(dir, 'run', 'c1', '--demand', 'D1');
  const run4 = readdirSync(join(dir, 'runs')).find(x => ![run, run2, run3].includes(x));
  r = ak(dir, 'device', 'claim', SMALL, '--run', run4, '--holder', 'x');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /一个需求同一平台只用一台/);
});

test('device stop：只关 acceptkit 启动的、现在没人占着的机器', () => {
  const { dir, run } = project();
  ok(dir, 'device', 'claim', BIG, '--run', 'other-run', '--holder', '另一轮验收');
  assert.equal(json(dir, 'device', 'acquire', '--run', run).device, COLD);   // COLD 是 acquire 启动的
  // 还占着：让占着的 run 自己 release --shutdown
  let r = ak(dir, 'device', 'stop', COLD);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /release .* --shutdown/);
  // 不是 acceptkit 启动的：不关
  ok(dir, 'device', 'release', BIG, '--run', 'other-run');
  r = ak(dir, 'device', 'stop', BIG);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /不是 acceptkit 启动的/);
  // 无关的坏运行（老目录没有 result.json）不挡关机
  mkdirSync(join(dir, 'runs', '0000-legacy'), { recursive: true });
  // 放掉之后能关（快照里的假设备真关不了，只看放行和说明）
  ok(dir, 'device', 'release', COLD, '--run', run);
  r = ak(dir, 'device', 'stop', COLD);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`选设备时启动的`));
});

test('用例写 both、run 还没定平台：按需求的平台选机，Android 需求不拿开着的 iOS 机', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acceptkit-test-'));
  for (const d of ['cases', 'runs', 'state/plans', 'knowledge', 'ops']) mkdirSync(join(dir, d), { recursive: true });
  const DROID = 'droid01';   // 真机式的 adb 序列号形状，走钩子快照（avd: 走 emulator 自己的探测）
  writeFileSync(join(dir, 'acceptkit.project.json'), JSON.stringify({ name: 't', gate: { allow: [
    { value: BIG, kind: 'device', note: '测试 iOS 机' }, { value: DROID, kind: 'device', note: '测试 Android 机' }] } }));
  // Android 的状态走 androidDeviceState 钩子（不碰 adb）
  writeFileSync(join(dir, 'pack.mjs'), PACK + "export const androidDeviceState = (ref, H) => { const s = read(H)[ref]; return s ? { platform: 'android', identity: ref, address: ref, connected: true, name: s.name, state: s.state === 'Booted' ? '已开机' : '未启动' } : { state: '不存在', connected: false }; };\n");
  writeFileSync(join(dir, 'devices.snapshot.json'), JSON.stringify({
    [BIG]: { platform: 'ios', name: 'phone-big', state: 'Booted' },
    [DROID]: { platform: 'android', name: 'droid', state: 'Booted' },
  }));
  writeFileSync(join(dir, 'cases', 'c2.case.json'), JSON.stringify({ case: 'c2', title: '两端都有的上报', platform: 'both',
    classifications: { carrier: ['app_ui'] },
    tree: [{ op: '冷启动', tags: { carrier: 'app_ui' }, expect: [{ id: 'E1', assert: '上报页能看到装配耗时' }] }] }));
  ok(dir, 'plan', 'new', 'D2', '--title', 'Android 链路', '--platform', 'android');
  ok(dir, 'plan', 'add-case', 'D2', '--surface', 'S1', '--change', '装配上报', '--reuse', 'c2', '--risk', '看不到耗时', '--uncovered', '无');
  ok(dir, 'plan', 'approve', 'D2', '--by', 'owner', '--quote', '可以');
  ok(dir, 'run', 'c2', '--demand', 'D2');
  const run = readdirSync(join(dir, 'runs'))[0];
  const card = json(dir, 'device', 'acquire', '--run', run);
  assert.equal(card.device, DROID, 'iOS 机开着且排在前面也不能拿：这是 Android 需求');
  assert.equal(result(dir, run).device.platform, 'android');
});

test('device sweep：占着却不动的放掉并关机，没人占且 acceptkit 用过的关机；keep_on 和没用过的不动', () => {
  const { dir, run } = project();
  writeFileSync(join(dir, 'pack.mjs'), PACK + "export const shutdownDevice = (ref, H) => { const m = read(H); m[ref].state = 'Shutdown'; writeFileSync(f(H), JSON.stringify(m)); return { ok: true }; };\n");
  const idle = min => { mkdirSync(join(dir, '.config', 'acceptkit'), { recursive: true }); writeFileSync(join(dir, '.config', 'acceptkit', 'config.json'), JSON.stringify({ prefs: { devices: { idle_minutes: min } } })); };
  const snap = () => JSON.parse(readFileSync(join(dir, 'devices.snapshot.json'), 'utf8'));
  const row = (out, d) => out.devices.find(x => x.device === d);
  assert.equal(json(dir, 'device', 'acquire', '--run', run).device, BIG);

  // 刚用过：都留着；SMALL 开着但 acceptkit 从没用过（可能是用户自己开的），不动
  let out = json(dir, 'device', 'sweep');
  assert.equal(row(out, BIG).action, 'keep');
  assert.match(row(out, SMALL).why, /没用过/);

  // 阈值压到几乎为零：占着的 BIG 被放掉并关机，记进运行；--dry-run 只说不动
  idle(0.0001);
  out = json(dir, 'device', 'sweep', '--dry-run');
  assert.equal(row(out, BIG).action, 'reclaim');
  assert.equal(snap()[BIG].state, 'Booted');
  out = json(dir, 'device', 'sweep');
  assert.equal(row(out, BIG).action, 'reclaim');
  assert.equal(row(out, SMALL).action, 'keep');
  assert.equal(snap()[BIG].state, 'Shutdown');
  assert.equal(heldBy(dir, run).length, 0);
  assert.equal(result(dir, run).device_reclaims.at(-1).by, 'sweep');

  // 运行回来接着做：acquire 重新起同一台
  idle(60);
  assert.equal(json(dir, 'device', 'acquire', '--run', run).device, BIG);
  assert.equal(snap()[BIG].state, 'Booted');
  ok(dir, 'device', 'release', BIG, '--run', run);

  // 白名单写了 keep_on：常开；去掉之后，没人占、过了阈值就关
  idle(0.0001);
  const cfg = JSON.parse(readFileSync(join(dir, 'acceptkit.project.json'), 'utf8'));
  cfg.gate.allow.find(a => a.value === BIG).keep_on = true;
  writeFileSync(join(dir, 'acceptkit.project.json'), JSON.stringify(cfg));
  assert.match(row(json(dir, 'device', 'sweep'), BIG).why, /keep_on/);
  delete cfg.gate.allow.find(a => a.value === BIG).keep_on;
  writeFileSync(join(dir, 'acceptkit.project.json'), JSON.stringify(cfg));
  assert.equal(row(json(dir, 'device', 'sweep'), BIG).action, 'stop');
  assert.equal(snap()[BIG].state, 'Shutdown');
});

test('占用跨项目：别的项目占着的机器，本项目不选、不能占、回收不关、状态里写明是谁', () => {
  const A = project(), B = project();
  const home = A.dir;   // 同一台机器：两个项目共用一份用户配置
  const run = (dir, ...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, ACCEPTKIT_PROJECT: dir, HOME: home } });
  const okH = (dir, ...args) => { const r = run(dir, ...args); assert.equal(r.status, 0, `${args.join(' ')}\n${r.stdout}\n${r.stderr}`); return r; };
  mkdirSync(join(home, '.config', 'acceptkit'), { recursive: true });
  writeFileSync(join(home, '.config', 'acceptkit', 'config.json'), JSON.stringify({ projects: [A.dir, B.dir], prefs: { devices: { idle_minutes: 0.0001 } } }));
  writeFileSync(join(A.dir, 'pack.mjs'), PACK + "export const shutdownDevice = (ref, H) => { const m = read(H); m[ref].state = 'Shutdown'; writeFileSync(f(H), JSON.stringify(m)); return { ok: true }; };\n");

  okH(B.dir, 'device', 'claim', BIG, '--run', B.run, '--holder', 'B 的执行者');
  // A 以前用过 BIG（有选机记录），现在没登记 —— 修之前回收会把它当「没人占」关掉
  const r = JSON.parse(readFileSync(join(A.dir, 'runs', A.run, 'result.json'), 'utf8'));
  r.device_picks = [{ chosen: BIG, at: '2020-01-01T00:00:00Z' }];
  writeFileSync(join(A.dir, 'runs', A.run, 'result.json'), JSON.stringify(r));
  writeFileSync(join(home, '.config', 'acceptkit', 'device-ops.jsonl'), '');   // 账本清空：只靠跨项目占用挡住
  const sweep = JSON.parse(okH(A.dir, 'device', 'sweep', '--json').stdout);
  const row = sweep.devices.find(x => x.device === BIG);
  assert.equal(row.action, 'keep');
  assert.match(row.why, new RegExp(`${B.run}`));
  assert.equal(JSON.parse(readFileSync(join(A.dir, 'devices.snapshot.json'), 'utf8'))[BIG].state, 'Booted');

  const c = run(A.dir, 'device', 'claim', BIG, '--run', A.run, '--holder', 'A');
  assert.notEqual(c.status, 0);
  assert.match(c.stderr + c.stdout, /跨项目不能抢占/);
  assert.notEqual(JSON.parse(okH(A.dir, 'device', 'acquire', '--run', A.run, '--json').stdout).device, BIG);
  assert.match(okH(A.dir, 'device', 'status').stdout, /别的项目登记的/);
});
