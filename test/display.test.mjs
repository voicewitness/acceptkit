// 用户偏好：设备窗口开在哪块显示器（core/display.mjs、adapters/android/device.mjs placeWindow）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { toTopLeft, pickScreen, placeOn } from '../core/display.mjs';
import { placeWindow } from '../adapters/android/device.mjs';

// 三块屏：主屏 1728×1117、右边一块 1920×1080、左边一块竖屏 1080×1920（AppKit 坐标，第一项是主屏）
const RAW = [[0, 0, 1728, 1117], [1728, 37, 1920, 1080], [-1080, 0, 1080, 1920]];

test('显示器坐标换成左上角原点，按偏好挑出那一块', () => {
  const list = toTopLeft(RAW);
  assert.deepEqual(list[2], { x: -1080, y: -803, w: 1080, h: 1920, main: false }, '左边竖屏比主屏高，顶边在主屏顶边上方');
  assert.equal(pickScreen('leftmost', list).x, -1080);
  assert.equal(pickScreen('rightmost', list).x, 1728);
  assert.equal(pickScreen('main', list).main, true);
  assert.equal(pickScreen('2', list).x, 0, '从左往右第 2 块是主屏');
  assert.equal(pickScreen('9', list), null);
  assert.deepEqual(placeOn(pickScreen('leftmost', list)), { x: -1040, y: -763 });
});

test('窗口位置写进 emulator-user.ini：只换 window.x / window.y，其余照旧', () => {
  const ini = join(mkdtempSync(join(tmpdir(), 'acceptkit-avd-')), 'emulator-user.ini');
  writeFileSync(ini, 'window.x = 100\nwindow.y = 100\nwindow.scale = -1.000000\nuuid = 42\n');
  placeWindow(ini, { x: -1040, y: -763 });
  assert.equal(readFileSync(ini, 'utf8'), 'window.x = -1040\nwindow.y = -763\nwindow.scale = -1.000000\nuuid = 42\n');
  const fresh = join(mkdtempSync(join(tmpdir(), 'acceptkit-avd-')), 'emulator-user.ini');
  placeWindow(fresh, { x: 1, y: 2 });
  assert.equal(readFileSync(fresh, 'utf8'), 'window.x = 1\nwindow.y = 2\n', '第一次起：新建');
});

test('新增设备时用户自己的那一步：只来自用户配置（prefs devices.new_device），工具不内置', async () => {
  const { mkdirSync, readdirSync } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const BIN = join(import.meta.dirname, '..', 'bin', 'acceptkit.mjs');
  const home = mkdtempSync(join(tmpdir(), 'acceptkit-pref-home-'));
  const dir = mkdtempSync(join(tmpdir(), 'acceptkit-pref-proj-'));
  for (const d of ['cases', 'runs', 'state/plans', 'knowledge', 'ops']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'acceptkit.project.json'), JSON.stringify({ name: 'demo' }));
  writeFileSync(join(dir, 'cases', 'c1.case.json'), JSON.stringify({ case: 'c1', title: '开机', platform: 'android', classifications: { carrier: ['page'] },
    tree: [{ op: '开机', tags: { carrier: 'page' }, expect: [{ id: 'E1', assert: '看到桌面' }] }] }));
  const env = { ...process.env, HOME: home, ACCEPTKIT_PROJECT: dir, PATH: '/usr/bin:/bin' };   // HOME 换掉：读不到本机 SDK，不碰真设备
  const ak = (...a) => spawnSync(process.execPath, [BIN, ...a], { cwd: dir, encoding: 'utf8', env });
  ak('plan', 'new', 'D1', '--title', '开机', '--platform', 'android');
  ak('plan', 'add-case', 'D1', '--surface', 'S1', '--change', '开机', '--reuse', 'c1', '--risk', '看不到', '--uncovered', '无');
  ak('plan', 'approve', 'D1', '--by', '测试', '--quote', '测试夹具');
  ak('run', 'c1', '--demand', 'D1');
  const ask = () => JSON.stringify(JSON.parse(ak('device', 'acquire', '--run', readdirSync(join(dir, 'runs'))[0], '--json').stdout));
  assert.doesNotMatch(ask(), /代理/, '没配就不提');
  assert.equal(ak('prefs', 'set', 'devices.new_device', '给它配好进程级的代理规则').status, 0);
  assert.match(ask(), /新增设备的话，你说过还要：给它配好进程级的代理规则/);
});
