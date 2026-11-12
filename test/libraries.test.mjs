// 用例库是通用能力：任何项目都能在配置 libraries 里挂自己的库，看板按通用格式出一栏（core/dashboard.mjs renderLibrary）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const ROOT = join(import.meta.dirname, '..');
test('libraries：挂两份库，各出一栏；证据字段按 labels 显示，没给的用字段名；配置写错被拒', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acceptkit-lib-'));
  for (const d of ['cases', 'runs', 'state', 'knowledge', 'evidence/smoke']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'acceptkit.project.json'), JSON.stringify({ name: 'demo' }));
  writeFileSync(join(dir, 'smoke.json'), JSON.stringify({ tree: [{ layer: '首页', cases: [
    { id: 's1', name: '首页能打开', status: 'pass', evidence: 'smoke/s1.json' }, { id: 's2', name: '搜索有结果', status: 'fail' }] }] }));
  writeFileSync(join(dir, 'evidence/smoke/s1.json'), JSON.stringify({ request: { path: '/' }, http_status: 200 }));
  writeFileSync(join(dir, 'perf.json'), JSON.stringify({ tree: [{ layer: '启动', cases: [{ id: 'p1', name: '冷启动', status: 'pass' }] }] }));
  const env = { ...process.env, ACCEPTKIT_PROJECT: dir };
  const ak = (...a) => spawnSync(process.execPath, [join(ROOT, 'bin', 'acceptkit.mjs'), ...a], { cwd: dir, encoding: 'utf8', env });
  assert.equal(ak('config', 'add', 'libraries', '--json', JSON.stringify({ id: 'smoke', file: 'smoke.json', title: '冒烟库', labels: { http_status: '状态码' } })).status, 0);
  assert.equal(ak('config', 'add', 'libraries', '--json', JSON.stringify({ id: 'perf', file: 'perf.json', title: '性能库' })).status, 0);
  assert.notEqual(ak('config', 'add', 'libraries', '--json', JSON.stringify({ id: 'Bad ID', file: 'x.json' })).status, 0, 'id 不合规被拒');
  const out = join(dir, 'board.html');
  const r = spawnSync(process.execPath, [join(ROOT, 'core', 'dashboard.mjs'), out], { cwd: dir, encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  const html = readFileSync(out, 'utf8');
  assert.match(html, /data-k="lib-smoke"[\s\S]*冒烟库[\s\S]*1\/2 常备用例/);
  assert.match(html, /data-k="lib-perf"[\s\S]*性能库/);
  assert.match(html, /状态码/, 'labels 给的显示名');
  assert.match(html, />request</, '没给 label 的字段用字段名');
});
