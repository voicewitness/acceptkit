// 空闲浏览器回收：台账里超时的关、新近用过的留、项目目录里没登记的收进台账、别人的不动。
// 起因：acceptkit 起的调试 Chrome 起了就不管，几天下来本机堆了一串没人用的窗口（2026-11-16）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const LEDGER = mkdtempSync(join(tmpdir(), 'ak-browsers-'));
process.env.ACCEPTKIT_BROWSERS = LEDGER;
const { sweepBrowsers, touchBrowser, debugChromes } = await import('../adapters/web/cdp.mjs');

// 假 Chrome：名字带 chrome 的 node 进程，命令行带调试端口和用户目录，和真的一样能被 ps 看到
const bin = join(mkdtempSync(join(tmpdir(), 'ak-fake-')), 'fake-chrome');
symlinkSync(process.execPath, bin);
const fake = (port, profile) => { const c = spawn(bin, ['-e', 'setInterval(()=>{},1000)', '--', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`], { stdio: 'ignore' }); return c; };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('超时的关、刚用过的留、项目目录里的收进台账、别人的不动', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ak-proj-'));
  const idle = fake(19801, '/tmp/ak-test-idle'), busy = fake(19802, '/tmp/ak-test-busy'), proj = fake(19803, join(root, '.acceptkit', 'browser-19803')), other = fake(19804, '/tmp/ak-test-other');
  try {
    await sleep(500);
    assert.equal(debugChromes().filter(p => p.port >= 19801 && p.port <= 19804).length, 4, '四个假实例都要被认出来');
    touchBrowser(19801, '/tmp/ak-test-idle', new Date(Date.now() - 3 * 3600e3).toISOString());
    touchBrowser(19802, '/tmp/ak-test-busy');
    const r = await sweepBrowsers({ idleMin: 60, roots: [root] });
    const by = port => r.browsers.find(x => x.port === port);
    assert.equal(by(19801).action, 'close'); assert.equal(by(19801).result, '已关');
    assert.equal(by(19802).action, 'keep');
    assert.equal(by(19803).action, 'adopt');
    assert.equal(by(19804).action, 'foreign');
    await sleep(300);
    assert.ok(!alive(idle.pid), '空闲的要被关掉');
    assert.ok(alive(busy.pid) && alive(proj.pid) && alive(other.pid), '其余三个不能动');
    const left = readdirSync(LEDGER).map(f => JSON.parse(readFileSync(join(LEDGER, f), 'utf8')).port).sort();
    assert.deepEqual(left, [19802, 19803], '关掉的从台账删掉，收进来的记上');
    // 只给端口的续期（Page 连上时）只续台账里已有的，不认领别人的端口
    touchBrowser(19804);
    assert.equal(readdirSync(LEDGER).length, 2);
  } finally { for (const c of [idle, busy, proj, other]) try { c.kill('SIGKILL'); } catch {} }
});

test('进程没了，台账删掉', async () => {
  touchBrowser(19805, '/tmp/ak-test-gone');
  const r = await sweepBrowsers({ idleMin: 60, roots: [] });
  assert.equal(r.browsers.find(x => x.port === 19805).action, 'gone');
  assert.ok(!readdirSync(LEDGER).some(f => f.startsWith('19805-')));
});
