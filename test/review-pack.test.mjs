// 盲审包带上截图的附带记录：盲审看图时同时看到工具记下的设备、包、进程、时刻、遮蔽层和事中检测结果；
// 没有记录的图写明不是工具截的；记录变了，复核结论作废重审。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const BIN = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'bin', 'acceptkit.mjs');
const ak = (dir, ...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, ACCEPTKIT_PROJECT: dir, HOME: dir } });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'acceptkit-test-'));
  for (const d of ['cases', 'runs', 'state/plans', 'knowledge', 'ops']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'acceptkit.project.json'), JSON.stringify({ name: 't', gate: { allow: [] } }));
  writeFileSync(join(dir, 'cases', 'c1.case.json'), JSON.stringify({ case: 'c1', title: 't', platform: 'android',
    tree: [{ nodeId: 'n1', op: '打开首页' }, { nodeId: 'n2', op: '打开列表' }, { nodeId: 'n3', op: '打开设置' }] }));
  const r0 = ak(dir, 'run', 'c1', '--demand', 'D1', '--skip-plan-gate');
  assert.equal(r0.status, 0, r0.stderr);
  const id = readdirSync(join(dir, 'runs'))[0];
  const rd = join(dir, 'runs', id);
  mkdirSync(join(rd, 'shots'), { recursive: true });
  // Android 的记录叫 <图>.json，iOS / Web 的叫 <去扩展名>.json，两种都要认
  writeFileSync(join(rd, 'shots', 'app-01-home.png'), Buffer.alloc(2048, 1));
  writeFileSync(join(rd, 'shots', 'app-01-home.png.json'), JSON.stringify({
    kind: 'process_shot', platform: 'android', udid: 'emulator-5554', bundle: 'com.example.app', pid: '4321',
    at: '2026-01-02T03:04:05.000Z', file: 'shots/app-01-home.png', page_title_on_screen: '首页',
    obscuring_check: { ok: true, focus: 'com.example.app/.MainActivity', scanned_nodes: 12 },
    allow_obscured_reason: '要验的就是这个弹窗',
    checks: { blank: { ratio: 0.98, color: '#ffffff' }, similar_to: 'shots/app-00-start.png', screen_text_source: 'hierarchy',
              shows_missing: [], screen_text_excerpt: '首页 推荐 我的' } }));
  writeFileSync(join(rd, 'shots', 'app-02-list.png'), Buffer.alloc(2048, 2));
  writeFileSync(join(rd, 'shots', 'app-02-list.json'), JSON.stringify({
    kind: 'process_shot', platform: 'ios', udid: 'SIM-0001', bundle: 'com.example.app', pid: 99, at: '2026-01-02T03:05:00.000Z',
    obscuring_check: { ok: false, unknown: true, reason: '没有 UI 调试端口' },
    checks: { blank: { ratio: 0.4, color: '#202020' }, similar_to: null, screen_text_source: 'ocr', shows_missing: ['列表'], screen_text_excerpt: '' } }));
  writeFileSync(join(rd, 'shots', 'manual.png'), Buffer.alloc(2048, 3));
  for (const [n, f] of [['n1', 'app-01-home'], ['n2', 'app-02-list'], ['n3', 'manual']]) {
    const x = ak(dir, 'record', id, '--step', n, '--evidence', `shots/${f}.png`);
    assert.equal(x.status, 0, x.stderr);
  }
  return { dir, id, rd };
}

const packetOf = (all, key) => all.split('════ 证据复核 ').find(p => p.startsWith(key)) || '';

test('图片的盲审包带上附带记录；没有记录的写明不是工具截的', () => {
  const { dir, id } = setup();
  const out = ak(dir, 'review', id, '--all');
  assert.equal(out.status, 0, out.stderr);
  const p1 = packetOf(out.stdout, 'step:n1::shots/app-01-home.png');
  assert.match(p1, /── 工具记录（shots\/app-01-home\.png\.json）──/);
  assert.match(p1, /不是结论；仍必须打开图片看/);
  assert.match(p1, /设备：emulator-5554 · android · 包 com\.example\.app · 进程 4321/);
  assert.match(p1, /时刻：2026-01-02T03:04:05\.000Z/);
  assert.match(p1, /前台窗口：com\.example\.app\/\.MainActivity/);
  assert.match(p1, /画面标题：首页/);
  assert.match(p1, /遮蔽层检查：无遮蔽层（查了 12 个节点）/);
  assert.match(p1, /放行理由（执行者用 --allow-obscured 写的）：要验的就是这个弹窗/);
  assert.match(p1, /事中检测：大部分是纯色 #ffffff（占 98%）；和 shots\/app-00-start\.png 几乎一样；画面文字来自 画面层级/);
  assert.match(p1, /画面文字摘录：首页 推荐 我的/);

  const p2 = packetOf(out.stdout, 'step:n2::shots/app-02-list.png');
  assert.match(p2, /工具记录（shots\/app-02-list\.json）/);
  assert.match(p2, /遮蔽层检查：没查成：没有 UI 调试端口/);
  assert.match(p2, /不是纯色画面（主色占 40%）；这一步应该出现的字没找到：「列表」；画面文字来自 OCR/);
  assert.doesNotMatch(p2, /放行理由/);

  const p3 = packetOf(out.stdout, 'step:n3::shots/manual.png');
  assert.match(p3, /没有工具记录：这张图不是工具截的/);
  assert.doesNotMatch(p3, /设备：/);

  // 跨运行的 reviewq --pack 出的是同一份包
  const pk = ak(dir, 'reviewq', '--run', id, '--pack');
  assert.equal(pk.status, 0, pk.stderr);
  const pdir = join(dir, 'state', 'review', 'packets', id);
  const f = readdirSync(pdir).find(x => x.startsWith('step_n1__'));
  assert.match(readFileSync(join(pdir, f), 'utf8'), /设备：emulator-5554/);
});

test('附带记录算进指纹：记录变了复核作废；升级前只记图指纹的复核照旧有效', () => {
  const { dir, id, rd } = setup();
  const key = 'step:n1::shots/app-01-home.png';
  const count = () => JSON.parse(ak(dir, 'review', id, '--count').stdout.trim().split('\n').pop()).pending;
  assert.equal(count(), 3);
  ak(dir, 'review', id, '--next');   // 记下复核人看到的版本
  const ok = ak(dir, 'review', id, '--item', key, '--verdict', 'ok', '--by', 'blind');
  assert.equal(ok.status, 0, ok.stderr);
  const res = () => JSON.parse(readFileSync(join(rd, 'result.json'), 'utf8'));
  assert.match(res().reviews[key].fp, /^[0-9a-f]{12}\.[0-9a-f]{8}$/);
  assert.equal(count(), 2);

  const sc = join(rd, 'shots', 'app-01-home.png.json');
  writeFileSync(sc, readFileSync(sc, 'utf8').replace('"4321"', '"9999"'));
  assert.equal(count(), 3, '记录改过，旧结论作废');

  // 升级前的复核只记了图本身的指纹：图没变就继续有效
  const r = res();
  r.reviews[key].fp = createHash('sha1').update(readFileSync(join(rd, 'shots', 'app-01-home.png'))).digest('hex').slice(0, 12);
  writeFileSync(join(rd, 'result.json'), JSON.stringify(r, null, 2));
  assert.equal(count(), 2);
});
