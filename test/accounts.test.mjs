// 测试账号：acceptkit account（core/accounts.mjs）—— 值只在用户目录、list 不打印值、机密字段在报告里被遮
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const BIN = join(import.meta.dirname, '..', 'bin', 'acceptkit.mjs');
test('account：登记、列出不带值、取值、导入时把值后面的说明剥掉、值在用户目录 600', () => {
  const home = mkdtempSync(join(tmpdir(), 'acceptkit-acc-home-'));
  const dir = mkdtempSync(join(tmpdir(), 'acceptkit-acc-proj-'));
  for (const d of ['cases', 'runs', 'state', 'knowledge']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'acceptkit.project.json'), JSON.stringify({ name: 'demo' }));
  const env = { ...process.env, HOME: home, ACCEPTKIT_PROJECT: dir };
  const ak = (...a) => spawnSync(process.execPath, [BIN, ...a], { cwd: dir, encoding: 'utf8', env });
  assert.equal(ak('account', 'set', 'normal', '--kind', 'normal', '--login', 'phone_sms', '--field', 'phone=13800001111', '--field', 'sms_code=000000', '--by', '测试').status, 0);
  const list = ak('account', 'list').stdout;
  assert.match(list, /normal[\s\S]*字段：phone, sms_code/);
  assert.doesNotMatch(list, /13800001111|000000/, 'list 不打印值');
  assert.equal(ak('account', 'get', 'normal', 'phone').stdout, '13800001111');
  const f = join(home, '.config', 'acceptkit', 'accounts', 'demo.json');
  assert.equal(statSync(f).mode & 0o777, 0o600);
  const old = join(home, 'old.json');
  writeFileSync(old, JSON.stringify({ accounts: [{ id: 'kid', kind: 'restricted', exit_pin: '1357   # 某人某天给的：退出时输入' }] }));
  assert.equal(ak('account', 'import', old).status, 0);
  assert.equal(ak('account', 'get', 'kid', 'exit_pin').stdout, '1357', '值后面的说明剥掉');
  assert.match(ak('account', 'list').stdout, /kid[\s\S]*exit_pin：某人某天给的/);
  assert.notEqual(ak('account', 'get', 'nobody', 'x').status, 0);
});
