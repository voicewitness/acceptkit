// 设备名跟着占用走（窗口标题 = 设备名）：占着的改成「原名 ▸ 需求」，放掉改回原名，别的设备不碰；AVD 只改 ini 文件名
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncIosNames, nameFor, renameAvd } from '../core/device-names.mjs';

test('占着的加需求，放掉的去掉，没被 acceptkit 改过的不碰', () => {
  const devs = [
    { udid: 'A', name: 'sim-acc' },
    { udid: 'B', name: 'iPhone 17 ▸ D14 旧需求' },
    { udid: 'C', name: '用户自己的机器' },
  ];
  const renamed = [];
  const done = syncIosNames({ A: { run: 'r1' } }, () => ({ id: 'D1', title: '首页问候语验收：窄屏和平板两种布局都要完整' }),
    { list: () => devs, rename: (u, n) => (renamed.push([u, n]), true) });
  assert.deepEqual(renamed, [['A', 'sim-acc ▸ D1'], ['B', 'iPhone 17']]);
  assert.equal(done.length, 2);
  assert.equal(nameFor('sim-acc ▸ D1 x', null), 'sim-acc');
  // 设备名会进 Bonjour 服务名（≤63 字节）：放不下需求号就不标
  assert.equal(nameFor('一台名字起得非常非常长的模拟器机器', { id: 'D14', title: 't' }), '一台名字起得非常非常长的模拟器机器');
  assert.ok(Buffer.byteLength(nameFor('iPhone 17 Pro Max', { id: 'checkout-flow-regression-suite', title: '很长的标题' })) <= 40);
});

test('AVD 改名：只改 ini 文件名；名字不合法、目标已有、path 指空都拒', () => {
  const home = mkdtempSync(join(tmpdir(), 'ak-avd-')); const dir = join(home, 'Old.avd'); mkdirSync(dir);
  writeFileSync(join(home, 'Old.ini'), `avd.ini.encoding=UTF-8\npath=${dir}\npath.rel=avd/Old.avd\ntarget=android-33\n`);
  assert.throws(() => renameAvd('Old', '中文名', home), /英文字母/);
  writeFileSync(join(home, 'Taken.ini'), 'path=/x\n');
  assert.throws(() => renameAvd('Old', 'Taken', home), /已经有/);
  const r = renameAvd('Old', 'acc_big_device', home);
  assert.equal(r.dir, dir);
  assert.ok(existsSync(join(home, 'acc_big_device.ini')) && !existsSync(join(home, 'Old.ini')) && existsSync(dir));
  writeFileSync(join(home, 'Broken.ini'), 'path=/nope\n');
  assert.throws(() => renameAvd('Broken', 'Fine', home), /指不到/);
});
