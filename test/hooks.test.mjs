// 宿主钩子：要验收就走 acceptkit（core/hooks.mjs）。用临时项目回放宿主发来的 JSON，看各家拿到的回话。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { saveLeases } from '../core/store/db.mjs';

const BIN = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'bin', 'acceptkit.mjs');
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'acceptkit-hook-home-'));
  const dir = mkdtempSync(join(tmpdir(), 'acceptkit-hook-proj-'));
  for (const d of ['cases', 'runs', 'state/plans', 'knowledge', 'ops']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'acceptkit.project.json'), JSON.stringify({ name: 'demo', gate: { allow: [{ value: 'avd:Demo_API33', kind: 'device', note: '验收用的模拟器' }] } }));
  writeFileSync(join(dir, 'cases', 'c1.case.json'), JSON.stringify({ case: 'c1', title: '首页问候', platform: 'web', classifications: { carrier: ['page'] },
    tree: [{ op: '打开首页', tags: { carrier: 'page' }, expect: [{ id: 'E1', assert: '顶部显示你好' }] }] }));
  mkdirSync(join(home, '.config', 'acceptkit'), { recursive: true });
  writeFileSync(join(home, '.config', 'acceptkit', 'config.json'), JSON.stringify({ projects: [dir] }));
  // PATH 里不放 adb：测试不碰真设备
  const env = { ...process.env, HOME: home, ACCEPTKIT_PROJECT: dir, PATH: '/usr/bin:/bin', CLAUDE_CODE_SESSION_ID: 'sess-1' };
  const ak = (args, input) => spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: 'utf8', env, input });
  const hook = (id, raw, host = 'claude-code') => { const r = ak(['hook', 'run', '--host', host, '--id', id], JSON.stringify(raw)); assert.equal(r.status, 0, r.stderr); return r.stdout.trim() ? JSON.parse(r.stdout) : null; };
  return { dir, ak, hook, home };
}
const bash = command => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: '/tmp', session_id: 'sess-1' });

test('H1：动验收设备的命令被拦，指给 acceptkit 的命令；别的设备、不动设备的命令放行', () => {
  const { hook } = setup();
  for (const c of ['nohup ~/Library/Android/sdk/emulator/emulator -avd Demo_API33 &', 'rm -rf ~/.android/avd/Demo_API33.avd/hardware-qemu.ini.lock', 'cp $A/Demo_API33.avd/config.ini $A/copy.avd/config.ini']) {
    const r = hook('H1', bash(c));
    assert.equal(r.hookSpecificOutput.permissionDecision, 'deny', c);
    assert.match(r.hookSpecificOutput.permissionDecisionReason, /device acquire/);
    assert.equal(r.decision, 'block', 'bypassPermissions 档下只认顶层 decision');
  }
  // 起 / 建设备：哪台都拦（不在白名单里的也是）
  for (const c of ['emulator -avd Personal_Phone &', 'avdmanager create avd -n New_One -k "system-images;android-33;google_apis;arm64-v8a"'])
    assert.equal(hook('H1', bash(c)).hookSpecificOutput.permissionDecision, 'deny', c);
  // 装包 / 清数据：只拦验收设备
  assert.equal(hook('H1', bash('adb -s R58N1234 install x.apk')), null, '装包到不是验收设备的真机：放行');
  // heredoc 正文是数据：改一份提到起模拟器的文档放行；喂给 shell 的照拦
  const doc = 'node - <<' + "'EOF'" + '\nfs.writeFileSync(f, "emulator -avd Demo_API33 &")\nEOF';
  assert.equal(hook('H1', bash(doc)), null, '改文档');
  assert.equal(hook('H1', bash('bash <<EOF\nemulator -avd Demo_API33 &\nEOF')).hookSpecificOutput.permissionDecision, 'deny', '喂给 shell');
  assert.equal(hook('H1', bash('ls ~/.android/avd')), null);
  // 其他宿主的回话形状
  const g = hook('H1', { hook_event_name: 'BeforeTool', tool_name: 'run_shell_command', tool_input: { command: 'emulator -avd Demo_API33' }, cwd: '/tmp' }, 'gemini-cli');
  assert.equal(g.decision, 'deny');
});

test('H1：刚过闸的设备放行；闸按身份认（--sim 给 serial 时 gate 记下身份），认不出时说清为什么', () => {
  const { dir, hook } = setup();
  const now = new Date().toISOString();
  const U = ['0A1B2C3D', '0000', '4000', '8000', '00000000AAAA'].join('-'); // 拼出来，免得被泄漏扫描当成真设备号
  // 测试不碰 adb：用 iOS UDID 当身份，--sim 给的是别名（Android 上是 serial），gate 记下反解出的身份
  saveLeases(dir, { [U]: { run: 'R1', holder: 't', platform: 'android', since: now, heartbeat: now, session: 'sess-1' } });
  mkdirSync(join(dir, 'runs', 'R1'), { recursive: true });
  const gate = checked => writeFileSync(join(dir, 'runs', 'R1', 'result.json'), JSON.stringify({ case: 'c1', platform: 'android',
    gates: [{ action: '装包', verdict: 'pass', at: now, checked: [{ key: '--sim', where: 'flag', ...checked }] }] }));
  const cmd = bash(`xcrun simctl install ${U} x.app`);
  gate({ val: 'emulator-5554', device: U });
  assert.equal(hook('H1', cmd), null, 'gate 记了身份：放行');
  gate({ val: 'emulator-5554' });
  const r = hook('H1', cmd).hookSpecificOutput;
  assert.equal(r.permissionDecision, 'deny');
  assert.match(r.permissionDecisionReason, new RegExp(`有闸但不算.*emulator-5554.*不是 ${U}`));
});

test('H1 强制管控：验收设备只有本会话占着才能动（没人占也拦、别的会话占着拦、旧占用要重新占）；脚本里的调用也算；字样不算', () => {
  const { dir, hook } = setup();
  const U = ['0A1B2C3D', '0000', '4000', '8000', '00000000BBBB'].join('-');
  const cfg = JSON.parse(readFileSync(join(dir, 'acceptkit.project.json'), 'utf8')); cfg.gate.allow.push({ value: U, kind: 'device' });
  writeFileSync(join(dir, 'acceptkit.project.json'), JSON.stringify(cfg));
  const now = new Date().toISOString();
  const deny = (c, re, why) => { const r = hook('H1', bash(c)); assert.equal(r?.hookSpecificOutput?.permissionDecision, 'deny', why); assert.match(r.hookSpecificOutput.permissionDecisionReason, re, why); };
  const launch = `xcrun simctl launch ${U} com.x`;
  deny(launch, /没人占着.*device acquire/, '没人占：不再默认放行');
  saveLeases(dir, { [U]: { run: 'R9', holder: '别的需求', platform: 'ios', since: now, heartbeat: now, session: 'sess-2' } });
  deny(launch, /另一个会话占着.*R9/, '别的会话占着');
  saveLeases(dir, { [U]: { run: 'R9', holder: 'x', platform: 'ios', since: now, heartbeat: now } });
  deny(launch, /还没绑会话.*device acquire --run R9/, '旧占用没有会话');
  saveLeases(dir, { [U]: { run: 'R1', holder: 'x', platform: 'ios', since: now, heartbeat: now, session: 'sess-1' } });
  assert.equal(hook('H1', bash(launch)), null, '本会话占着：放行');
  // 脚本：跑一个脚本文件，脚本里调 simctl 打这台 —— 别的会话占着时拦
  saveLeases(dir, { [U]: { run: 'R9', holder: 'x', platform: 'ios', since: now, heartbeat: now, session: 'sess-2' } });
  const f = join(dir, 'probe.mjs');
  writeFileSync(f, `import { spawnSync } from 'node:child_process';\nspawnSync('xcrun', ['simctl', 'launch', '${U}', 'com.x']);\n`);
  deny(`node ${f}`, /脚本 .*probe\.mjs.*另一个会话/, '脚本里的调用也算');
  // 只是提到这个词：不算
  writeFileSync(f, `// 先用 simctl 和 adb 看一下设备（${U}）\nconsole.log(1)\n`);
  assert.equal(hook('H1', bash(`node ${f}`)), null, '注释里提到不算调用');
  assert.equal(hook('H1', bash('grep -n adb notes.md')), null, 'grep 的字样不算');
  assert.equal(hook('H1', bash('xcrun simctl list devices')), null, '只读列表不拦');
});

test('H2：手改验收记录被拦；项目外的同名文件放行', () => {
  const { dir, hook } = setup();
  const write = file_path => ({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path }, cwd: dir, session_id: 'sess-1' });
  for (const f of [join(dir, 'runs', 'r1', 'result.json'), join(dir, 'state', 'plans', 'D1.json'), join(dir, 'acceptkit.project.json')]) {
    const r = hook('H2', write(f));
    assert.equal(r.hookSpecificOutput.permissionDecision, 'deny', f);
    assert.match(r.hookSpecificOutput.permissionDecisionReason, /只由命令写/);
  }
  assert.equal(hook('H2', write('/tmp/somewhere/runs/r1/result.json')), null, '不在 acceptkit 项目里：放行');
});

test('H3 / H4：绑定了验收的会话没做完不让停，做完解绑；没绑定的会话不受影响', () => {
  const { dir, ak, hook } = setup();
  const stop = (session = 'sess-1') => hook('H3', { hook_event_name: 'Stop', session_id: session, cwd: '/tmp', stop_hook_active: false });
  assert.equal(stop(), null, '没绑定：放行');
  assert.match(hook('H4', { hook_event_name: 'UserPromptSubmit', prompt: '帮我验收一下首页', session_id: 'sess-1', cwd: '/tmp' }).hookSpecificOutput.additionalContext, /acceptkit loop start/);
  assert.equal(ak(['plan', 'new', 'D1', '--title', '首页问候', '--platform', 'web']).status, 0);
  assert.match(ak(['loop', 'start', 'D1']).stdout, /这个会话在验收 D1/);
  const r = stop();
  assert.equal(r.decision, 'block');
  assert.match(r.reason, /验收 D1 还没做完[\s\S]*下一张/);
  assert.equal(stop('another-session'), null, '别的会话不受影响');
  // 只剩等人的事：停之前拦一次，要它先把要问的记进 acceptkit；第二次放行
  const p = join(dir, 'state', 'plans', 'D1.json');
  const plan = JSON.parse(readFileSync(p, 'utf8'));
  assert.equal(ak(['plan', 'add-case', 'D1', '--surface', 'S1', '--change', '首页加问候', '--reuse', 'c1', '--risk', '看不到', '--uncovered', '其他页']).status, 0);
  const once = stop();
  assert.equal(once.decision, 'block'); assert.match(once.reason, /停下等用户之前[\s\S]*plan finding D1/);
  assert.equal(stop(), null, '同一批等人的事第二次放行');
  void plan;
  assert.equal(ak(['loop', 'stop']).status, 0);
  assert.equal(stop(), null, '解绑后放行');
});

test('hook install --print：生成各家配置片段，命令指向本仓库的 acceptkit', () => {
  const { ak } = setup();
  const r = ak(['hook', 'install', '--host', 'claude-code', '--print']);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(j.snippet.hooks).sort(), ['PreToolUse', 'Stop', 'UserPromptSubmit']);
  assert.match(JSON.stringify(j.snippet), /acceptkit\.mjs\\" hook run --host claude-code --id H1/);
  void readFileSync;
});

test('H1 认「调用」不认字样：只有处在命令位置的 adb / xcrun simctl 算发往设备', async () => {
  const { deviceTargets } = await import('../core/hooks.mjs');
  for (const c of ['grep -c "adb" devices.md', 'echo use adb later', 'cat notes/adb.md', 'rg simctl docs/'])
    assert.equal(deviceTargets(c), null, c);
  assert.deepEqual(deviceTargets('adb -s R58N1234 shell ls').ids, ['R58N1234']);
  assert.equal(deviceTargets('X=1 timeout 5 /opt/sdk/platform-tools/adb shell ls').any, true, '没写 -s：连着的全算');
  assert.equal(deviceTargets('ls && adb devices'), null, '只读的身份查询不算');
  assert.equal(deviceTargets('acceptkit adb --run R -- shell ls'), null, '走封装：封装自己核对');
  // 子命令之后的 -s 是子命令自己的（logcat 过滤），不是设备：没写全局 -s 就算连着的全部
  const lc = deviceTargets('adb logcat -d -s MyTag:*');
  assert.deepEqual(lc.ids, []); assert.equal(lc.any, true);
  assert.deepEqual(deviceTargets('adb -s R58N1234 logcat -d -s TAG:*').ids, ['R58N1234']);
  // 别的工具自己调 adb、只把地址当参数：按参数认设备
  assert.deepEqual(deviceTargets('some-tool load --serial R58N1234 x.dex').ids, ['R58N1234']);
  assert.deepEqual(deviceTargets('ANDROID_SERIAL=R58N1234 ./run.sh').ids, ['R58N1234']);
});

test('H1 触发条件包含 --serial 这类参数：别的工具带着验收设备地址也过钩子', () => {
  const { dir, hook, home } = setup();
  const U = ['0A1B2C3D', '0000', '4000', '8000', '00000000CCCC'].join('-');
  const cfg = JSON.parse(readFileSync(join(dir, 'acceptkit.project.json'), 'utf8')); cfg.gate.allow.push({ value: U, kind: 'device' });
  writeFileSync(join(dir, 'acceptkit.project.json'), JSON.stringify(cfg));
  const r = hook('H1', bash(`some-tool load --udid ${U} probe.dex`));
  assert.equal(r?.hookSpecificOutput?.permissionDecision, 'deny');
  assert.match(r.hookSpecificOutput.permissionDecisionReason, /没人占着/);
  // 拦下的也记账：选设备靠账本认出谁刚动过哪台
  const ops = readFileSync(join(home, ".config", "acceptkit", "device-ops.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
  assert.equal(ops.at(-1).via, "hook"); assert.equal(ops.at(-1).denied, true); assert.deepEqual(ops.at(-1).devices, [U]);
});

test('loop stop：还有能做的事就要写理由；理由和剩下的件数记下来，看板摆给 owner', async () => {
  const { dir, ak, hook } = setup();
  assert.equal(ak(['plan', 'new', 'D1', '--title', '首页问候', '--platform', 'web']).status, 0);
  assert.equal(ak(['loop', 'start', 'D1']).status, 0);
  const bare = ak(['loop', 'stop']);
  assert.notEqual(bare.status, 0);
  assert.match(bare.stderr, /还有 \d+ 件你能做的事[\s\S]*--why/);
  assert.equal(hook('H3', { hook_event_name: 'Stop', session_id: 'sess-1', cwd: '/tmp', stop_hook_active: false }).decision, 'block', '没停成：照样拦');
  const ok = ak(['loop', 'stop', '--why', '用户说先停：「今天先到这」']);
  assert.equal(ok.status, 0, ok.stderr);
  const { lastLoopStop } = await import('../core/store/db.mjs');
  const st = lastLoopStop(dir, 'D1');
  assert.equal(st.session, 'sess-1'); assert.match(st.why, /今天先到这/); assert.ok(st.left > 0);
});


test('设备守卫不扫 acceptkit 自己的参数：gate 动作描述里写了设备名不算动设备；同一行别的命令照样扫', async () => {
  const { withoutAcceptkit } = await import('../core/hooks.mjs');
  assert.equal(withoutAcceptkit('acceptkit gate --action "装包到 emulator -avd Demo_API33" --sim avd:x').trim(), '');
  assert.equal(withoutAcceptkit('node bin/acceptkit.mjs observe R; emulator -avd Demo_API33').includes('emulator -avd Demo_API33'), true);
  const { hook } = setup();
  assert.notEqual(hook('H1', bash('acceptkit gate --action "emulator -avd Demo_API33 上装包" --sim avd:Demo_API33 --bundle com.a'))?.hookSpecificOutput?.permissionDecision, 'deny');
  assert.equal(hook('H1', bash('acceptkit observe R && emulator -avd Demo_API33 &')).hookSpecificOutput.permissionDecision, 'deny');
});

test('设备号先赋给变量再用：代进去认出是哪台；simctl 认不出目标时不算 Android 设备', async () => {
  const { deviceTargets } = await import('../core/hooks.mjs');
  const U = ['0A1B2C3D', '0000', '4000', '8000', '00000000DDDD'].join('-');
  const d = deviceTargets(`U=${U}; xcrun simctl get_app_container $U com.example.app.ep 2>&1`);
  assert.deepEqual(d.ids, [U]); assert.equal(d.any, false);
  const b = deviceTargets('xcrun simctl launch booted com.example.app');
  assert.equal(b.any, false, '不算连着的 Android 设备'); assert.equal(b.anyIos, true);
  // 别的会话占着这台模拟器：拦，点名的是它
  const { dir, hook } = setup();
  const now = new Date().toISOString();
  saveLeases(dir, { [U]: { run: 'R9', holder: 'x', platform: 'ios', since: now, heartbeat: now, session: 'sess-2' } });
  const r = hook('H1', bash(`U=${U}; P=$(xcrun simctl get_app_container $U com.example.app.ep 2>&1); echo "$P"`));
  assert.equal(r.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(r.hookSpecificOutput.permissionDecisionReason, new RegExp(U));
});
