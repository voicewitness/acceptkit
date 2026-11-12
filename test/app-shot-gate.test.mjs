// 有效截图规则在写结论时就查：端上 run 没有任何一张工具截的 app 画面，不许记 pass；
// fail 拍不了要写理由。以前只在 report 里查，不出报告的 run 全是文本证据也显示通过。
// 执行者照着命令输出干活，所以怎么截、被挡住怎么关，在开跑、记步骤、被拒时都由工具说出来。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'bin', 'acceptkit.mjs');
const ak = (dir, ...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, ACCEPTKIT_PROJECT: dir, HOME: dir } });

test('端上 run 没有 app 截图：pass 拒收，fail 要写拍不了的理由；截了就收', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acceptkit-test-'));
  for (const d of ['cases', 'runs', 'state/plans', 'knowledge', 'ops']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'acceptkit.project.json'), JSON.stringify({ name: 't', gate: { allow: [] } }));
  writeFileSync(join(dir, 'cases', 'c1.case.json'), JSON.stringify({ case: 'c1', title: 't', platform: 'android',
    tree: [{ nodeId: 'n1', op: '打开 app', expect: [{ id: 'E1', assert: '首页出现推荐流', judge: 'human', human_why: '示例' }, { id: 'E2', assert: '首页出现底栏', judge: 'human', human_why: '示例' }] }] }));
  const r0 = ak(dir, 'run', 'c1', '--demand', 'D1', '--skip-plan-gate');
  assert.equal(r0.status, 0, r0.stderr);
  assert.match(r0.stdout, /acceptkit shot/); assert.match(r0.stdout, /先关掉再截/); assert.match(r0.stdout, /keyevent 4/);
  const id = readdirSync(join(dir, 'runs'))[0];
  const res = () => JSON.parse(readFileSync(join(dir, 'runs', id, 'result.json'), 'utf8'));
  assert.equal(res().platform, 'android');
  mkdirSync(join(dir, 'runs', id, 'evidence'), { recursive: true });
  writeFileSync(join(dir, 'runs', id, 'evidence', 'out.txt'), 'recommend feed visible');
  assert.match(ak(dir, 'record', id, '--step', 'n1', '--evidence', 'evidence/out.txt').stderr, /还没有一张 app 操作截图.*acceptkit shot/);
  const refused = ak(dir, 'record', id, '--expect', 'E1', '--status', 'pass', '--evidence', 'evidence/out.txt').stderr;
  assert.match(refused, /还没有一张 app 操作截图/); assert.match(refused, /先关掉再截/);
  assert.match(ak(dir, 'record', id, '--expect', 'E2', '--status', 'fail', '--actual', 'x').stderr, /--allow-no-shot/);
  assert.equal(ak(dir, 'record', id, '--expect', 'E2', '--status', 'fail', '--actual', '启动即崩', '--allow-no-shot', 'app 起不来').status, 0);
  assert.equal(res().results.E2.no_shot_reason, 'app 起不来');
  mkdirSync(join(dir, 'runs', id, 'shots'), { recursive: true });
  writeFileSync(join(dir, 'runs', id, 'shots', 'app-01-home.png'), Buffer.alloc(2048));
  writeFileSync(join(dir, 'runs', id, 'shots', 'app-01-home.png.json'), JSON.stringify({ kind: 'process_shot' }));
  const ok = ak(dir, 'record', id, '--expect', 'E1', '--status', 'pass', '--evidence', 'evidence/out.txt');
  assert.equal(ok.status, 0, ok.stderr);
});
