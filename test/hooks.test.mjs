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
  return { dir, ak, hook };
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
  saveLeases(dir, { [U]: { run: 'R1', holder: 't', platform: 'android', since: now, heartbeat: now } });
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
