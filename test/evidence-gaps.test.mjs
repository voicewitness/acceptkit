// 「这条 pass 证据齐不齐」只有一份判据（evidence-gate assertionGaps）：报告缺口、看板「证据不全」、next 的 evidence_gap 都调它
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertionGaps } from '../core/evidence-gate.mjs';

test('assertionGaps：没证据、只有文本没有读值截图都算缺；有 ui_observe 截图的不缺；迁移前的运行不追溯截图要求', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acceptkit-gap-'));
  mkdirSync(join(dir, 'shots'), { recursive: true }); mkdirSync(join(dir, 'evidence'), { recursive: true });
  writeFileSync(join(dir, 'evidence', 'log.txt'), 'x');
  writeFileSync(join(dir, 'shots', 'read.png'), Buffer.alloc(64, 1));
  writeFileSync(join(dir, 'shots', 'read.png.json'), JSON.stringify({ kind: 'ui_observe' }));
  const res = { results: {
    E1: { status: 'pass', evidence: [] },
    E2: { status: 'pass', evidence: ['evidence/log.txt'] },
    E3: { status: 'pass', evidence: ['evidence/log.txt', 'shots/read.png'] },
    E4: { status: 'blocked', evidence: [] },
    E5: { status: 'fail', evidence: ['evidence/log.txt'] } } };
  assert.deepEqual(assertionGaps(dir, res), { E1: ['no_evidence'], E2: ['no_ui_shot'], E5: ['no_ui_shot'] });
  assert.deepEqual(assertionGaps(dir, { ...res, demand: { migrated: true } }), { E1: ['no_evidence'] });
});

test('像 QA 一样验：声明了 via 的断言不要求截图，但证据要 observe 亲自采；只读执行者交来的文件不算', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acceptkit-via-'));
  mkdirSync(join(dir, 'evidence', 'obs'), { recursive: true });
  writeFileSync(join(dir, 'evidence', 'obs', 'o.txt'), 'x');
  const ops = { 'read-file': { platforms: { ios: { exec: 'json-file' } } }, 'read-log': { platforms: { ios: { exec: 'shell' } } } };
  const expects = [{ id: 'L1', via: 'log', why_not_ui: '上报只进日志，app 里没有页面显示' }, { id: 'L2', via: 'debugger', why_not_ui: '运行时开关值界面上看不到' },
    { id: 'L3', via: 'log', why_not_ui: '同上' }, { id: 'U1' }];
  const ev = ['evidence/obs/o.txt'];
  const res = { results: {
    L1: { status: 'pass', evidence: ev, observed: { op: 'read-log', exec: 'shell' } },          // observe 亲自跑命令采的：齐
    L2: { status: 'pass', evidence: ev, observed: { op: 'read-file' } },                         // 只读现成文件（从操作库认出 exec）：不齐
    L3: { status: 'pass', evidence: ev },                                                         // 手记：不齐
    U1: { status: 'pass', evidence: ev, observed: { op: 'read-log', exec: 'shell' } } } };        // 界面断言缺截图：不齐
  assert.deepEqual(assertionGaps(dir, res, { expects, ops }), { L2: ['not_tool_collected'], L3: ['not_tool_collected'], U1: ['no_ui_shot'] });
});

test('卡片：缺证据让执行者重试、不许改记 blocked；评审单批准卡列出几条在界面上验、几条用命令行验及理由', async () => {
  const C = await import('../core/cards.mjs');
  const g = C.evidenceGapCard('r1', ['E1', 'L2'], { E1: ['no_ui_shot'], L2: ['not_tool_collected'] });
  assert.equal(g.kind, 'evidence_gap');
  assert.match(g.note, /observe r1 --expect E1/);
  const d = g.detail.join('\n');
  assert.match(d, /重跑 observe，它会进到能看到结论的页面/);
  assert.match(d, /登记成操作库配方/);
  assert.match(d, /缺证据不是验不了：不要改记 blocked/);
  const a = C.planApprovalCard('D1', { revision: 1, title: 't' }, null, 0, { ui: 5, cli: [{ case: 'c1', id: 'L1', via: 'log', why: '上报只进日志' }] });
  assert.deepEqual(a.via, { ui: 5, cli: 1 });
  assert.match(a.detail.join('\n'), /5 条在界面上验[\s\S]*1 条用命令行验[\s\S]*c1 L1 用日志验：上报只进日志/);
});

test('界面断言的读法不是界面通道：用例检查 Q21 拦下，缺口卡片指出要换配方而不是空转重跑', async () => {
  const Q = await import('../core/case-quality.mjs');
  const C = await import('../core/cards.mjs');
  const ops = { 'read-diag': { platforms: { android: { exec: 'diag' } } }, 'read-page': { platforms: { android: { exec: 'ui' } } } };
  const c = { case: 'c1', platform: 'android', tree: [{ id: 'n1', op: '打开', expect: [
    { id: 'E1', assert: '开关值为 true', observe: { op: 'read-diag', checks: [] } },                       // 默认界面验，却用诊断读：拦
    { id: 'E2', assert: '页面显示已开启', observe: { op: 'read-page', checks: [] } },                     // 界面读：过
    { id: 'E3', assert: '上报一次', via: 'log', why_not_ui: '只进日志', observe: { op: 'read-diag', checks: [] } }] }] };   // 声明了命令行：过
  const hits = Q.checkCase(c, { ops }).filter(x => x.rule === 'Q21');
  assert.deepEqual(hits.map(x => x.at), ['E1']);
  assert.match(hits[0].msg, /read-diag 读（exec=diag）/);
  assert.deepEqual(Q.checkCase(c, {}).filter(x => x.rule === 'Q21'), []);   // 没给操作库就不判
  const g = C.evidenceGapCard('r1', ['E1', 'E2'], { E1: ['no_ui_shot'], E2: ['no_ui_shot'] }, { E1: { op: 'read-diag', exec: 'diag' } });
  const d = g.detail.join('\n');
  assert.match(d, /E1 是界面上的断言，可它的读法 read-diag 走的是 diag 通道，不截图 —— 重跑也补不上/);
  assert.match(d, /^E2 是界面上的断言，缺读到结论那一刻的 app 截图/m);
});

test('validate 命令也跑 Q21：命令行这条路径以前不传操作库，界面断言配着诊断配方从来没人提示', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { join, dirname, resolve } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const BIN = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'bin', 'acceptkit.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'acceptkit-q21-'));
  for (const d of ['cases', 'runs', 'state/plans', 'knowledge', 'ops']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'acceptkit.project.json'), JSON.stringify({ name: 't', gate: { allow: [] } }));
  writeFileSync(join(dir, 'ops', 'registry.json'), JSON.stringify({ ops: {
    'read-ring': { kind: 'observe', title: '读决策环', why: 't', platforms: { android: { exec: 'shell', steps: [{ do: 'x', cmd: 'true' }] } } } } }));
  writeFileSync(join(dir, 'cases', 'c1.case.json'), JSON.stringify({ case: 'c1', title: '拦截', platform: 'android',
    classifications: { carrier: ['app'] },
    tree: [{ op: '注入请求', tags: { carrier: 'app' }, expect: [{ id: 'E1', assert: '请求被拦截，产出拦截动作', observe: { op: 'read-ring', checks: [{ pick: 'read.x', predicate: { nonempty: true } }] } }] }] }));
  const r = spawnSync(process.execPath, [BIN, 'validate', 'c1'], { cwd: dir, encoding: 'utf8', env: { ...process.env, ACCEPTKIT_PROJECT: dir, HOME: dir } });
  assert.match(r.stdout + r.stderr, /Q21[^\n]*E1[^\n]*read-ring/);
});
