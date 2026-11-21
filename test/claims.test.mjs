// 断言的主张与观测层（core/claims.mjs）：断言说「拦截 + 弹窗」、观测只读了判定里的动作名时，
// 用例检查要报（Q22）、机判不许自己关复核、证据缺口要列出来、盲审判 ok 要逐条答主张。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { effectClaims, uncoveredClaims, claimList } from '../core/claims.mjs';
import { checkCase } from '../core/case-quality.mjs';
import { assertionGaps, reviewClaims } from '../core/evidence-gate.mjs';
import { opProblems } from '../core/ops.mjs';

const BLOCK_POPUP = '**拦截**：data_transfer 命中，产出拦截 + 弹窗。\n依据：域名在下发的名单里';
const ring = (observes, read = [{ key: 'actions', pattern: '{param.unit}\\s+actions=\\[([^\\]]*)\\]' }, { key: 'evaluated', pattern: 'evaluated: (.*)' }, { key: 'units_on_page', pattern: 'evaluated \\((\\d+)\\)' }]) =>
  ({ kind: 'observe', title: '读判定环', why: 'w', ...(observes ? { observes } : {}), platforms: { android: { exec: 'ui', read, state: 'confirmed' } } });
const caseOf = (assert, observe, extra = {}) => ({ case: 'c', title: 't', platform: 'android', tree: [{ op: '注入', ...(extra.node || {}), expect: [{ id: 'E1', assert, observe }] }], ...(extra.case || {}) });

test('效果词：认出拦截、弹窗；判定里的动作名、acceptkit 的状态词不算', () => {
  assert.deepEqual(effectClaims(BLOCK_POPUP).map(x => x.word).sort(), ['弹窗', '拦截']);
  assert.deepEqual(effectClaims('判定产出 fuse、alert 两个动作'), []);
  assert.deepEqual(effectClaims('actions 含 report；上报动作在名单里'), []);
  assert.deepEqual(effectClaims('不存在就记 blocked/capability'), []);
  assert.deepEqual(effectClaims('冷启动不崩').map(x => x.word), ['不崩']);
  const list = claimList(BLOCK_POPUP);
  assert.ok(list.some(x => /弹窗（要在被测 app/.test(x)) && list.some(x => /拦截（要在网络出口/.test(x)), list.join(' | '));
  assert.ok(!list.some(x => /依据/.test(x)), '依据那段不是主张');
});

test('Q22：说了弹窗 / 拦截、观测只读判定层 → 报；收窄说法或观测读到那一层 → 不报', () => {
  const observe = { op: 'ring', checks: [{ pick: 'read.actions', predicate: { any_match: 'fuse' } }] };
  const q22 = (c, ops) => checkCase(c, { ops }).filter(f => f.rule === 'Q22');
  const wide = q22(caseOf(BLOCK_POPUP, observe), { ring: ring('decision') });
  assert.equal(wide.length, 1);
  assert.match(wide[0].msg, /「拦截」要在网络出口/); assert.match(wide[0].msg, /「弹窗」要在被测 app/);
  assert.deepEqual(q22(caseOf('判定产出 fuse、alert 两个动作', observe), { ring: ring('decision') }), []);
  assert.match(q22(caseOf(BLOCK_POPUP, observe), { ring: ring(null) })[0].msg, /没登记读的是哪一层/);
  // 读到界面层的观测盖得住「弹窗」，盖不住「拦截」
  const ui = q22(caseOf('点保存后弹窗提示已保存', observe), { ring: ring('ui') });
  assert.deepEqual(ui, []);
  // 用例级主张也核：proved_by 的断言都只读判定层
  const c = caseOf('判定产出 fuse', observe, { case: { claims: [{ text: '名单里的域名被拦截', proved_by: ['E1'] }] } });
  assert.match(q22(c, { ring: ring('decision') }).find(f => f.at === '主张 1').msg, /proved_by 里没有读这一层/);
});

test('Q23：判「没有」读的是某个对象，要有前提先证明这个对象在；整页非空不算', () => {
  const neg = { op: 'ring', params: { unit: 'data_transfer' }, checks: [{ pick: 'read.actions', predicate: { none_match: '\\S' } }] };
  const q23 = o => checkCase(caseOf('判定放行：data_transfer 没有动作', o), { ops: { ring: ring('decision') } }).filter(f => f.rule === 'Q23');
  assert.equal(q23({ ...neg, guards: [{ pick: 'read.units_on_page', predicate: { gt: 0 } }] }).length, 1, '整页评估了几项不算');
  const bound = { op: 'ring', params: { unit: 'data_transfer' }, guards: [{ pick: 'read.actions_row', predicate: { nonempty: true } }], checks: neg.checks };
  const withRow = { ring: ring('decision', [...ring().platforms.android.read, { key: 'actions_row', pattern: '({param.unit}\\s+actions=)' }]) };
  assert.deepEqual(checkCase(caseOf('判定放行', bound), { ops: withRow }).filter(f => f.rule === 'Q23'), []);
});

test('Q24：开关类用例里只判「有没有」的断言，没写 flips_in 就提示', () => {
  const o = { op: 'ring', checks: [{ pick: 'read.steps', predicate: { gt: 0 } }] };
  const lever = { node: { tags: { lever: 'ab_gate' } } };
  assert.equal(checkCase(caseOf('新链跑了', o, lever), { ops: { ring: ring('decision') } }).filter(f => f.rule === 'Q24').length, 1);
  assert.equal(checkCase(caseOf('新链跑了', { ...o, flips_in: '节点 2（开关关）' }, lever), { ops: { ring: ring('decision') } }).filter(f => f.rule === 'Q24').length, 0);
  assert.equal(checkCase(caseOf('新链跑了', o), { ops: { ring: ring('decision') } }).filter(f => f.rule === 'Q24').length, 0, '不是开关类用例不提示');
});

test('操作登记的层只能是认得的那几个', () => {
  assert.ok(opProblems('ring', ring('popup')).some(p => /observes 只能是/.test(p.msg)));
  assert.ok(!opProblems('ring', ring(['decision', 'diag'])).some(p => /observes/.test(p.msg)));
});

test('证据缺口：主张宽于观测的 pass，机判 ok 不算数；盲审逐条核过才算', () => {
  const e = { id: 'E1', assert: BLOCK_POPUP, observe: { op: 'ring', checks: [] } };
  const ops = { ring: ring('decision') };
  const res = (rv) => ({ platform: 'android', results: { E1: { status: 'pass', evidence: ['evidence/obs-E1.txt'], observed: { op: 'ring' } } }, reviews: { 'E1::evidence/obs-E1.txt': rv } });
  assert.deepEqual(assertionGaps('/nope', res({ state: 'ok', by: 'machine' }), { expects: [e], ops }).E1?.filter(g => g === 'claims_uncovered'), ['claims_uncovered']);
  assert.equal(assertionGaps('/nope', res({ state: 'ok', by: 'blind', claims_checked: true }), { expects: [e], ops }).E1?.includes('claims_uncovered') || false, false);
  assert.equal(uncoveredClaims(e, { ops: { ring: ring(['decision', 'ui', 'network']) }, platform: 'android' }).missing.length, 0);
});

// ---- 命令行：盲审包列主张清单，判 ok 不逐条答就拒收 ----
const BIN = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'bin', 'acceptkit.mjs');
const ak = (dir, ...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, ACCEPTKIT_PROJECT: dir, HOME: dir } });
test('盲审：包里有主张清单；判 ok 不逐条写出在哪就拒收，写全了才记下', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acceptkit-claims-'));
  for (const d of ['cases', 'runs', 'state/plans', 'knowledge', 'ops']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'acceptkit.project.json'), JSON.stringify({ name: 't', gate: { allow: [] } }));
  writeFileSync(join(dir, 'cases', 'c1.case.json'), JSON.stringify({ case: 'c1', title: '保存', platform: 'web', classifications: { carrier: ['web'] },
    tree: [{ op: '点保存', tags: { carrier: 'web' }, expect: [{ id: 'E1', assert: '保存后弹窗提示「已保存」；列表里多出这一条', judge: 'human', human_why: '示例' }] }] }));
  writeFileSync(join(dir, 'ops', 'registry.json'), JSON.stringify({ ops: {} }));
  writeFileSync(join(dir, 'state', 'plans', 'D1.json'), JSON.stringify({ demand: 'D1', title: '测', platform: 'web', revision: 1,
    surfaces: [{ id: 'S1', change: 'x', reuse: ['c1'], new: [], ops: [] }], not_covered: [], history: [],
    approved_by: 'tester', approved_at: new Date().toISOString(), created_at: new Date().toISOString() }));
  { const x = ak(dir, 'run', 'c1', '--demand', 'D1'); assert.equal(x.status, 0, x.stderr); }
  const run = readdirSync(join(dir, 'runs'))[0];
  mkdirSync(join(dir, 'runs', run, 'evidence'), { recursive: true }); mkdirSync(join(dir, 'runs', run, 'shots'), { recursive: true });
  writeFileSync(join(dir, 'runs', run, 'evidence', 'page.txt'), '第1行 弹窗：已保存\n第2行 列表：共 3 条');
  writeFileSync(join(dir, 'runs', run, 'shots', 'app-01-home.png'), Buffer.alloc(512, 1));
  writeFileSync(join(dir, 'runs', run, 'shots', 'app-01-home.json'), JSON.stringify({ kind: 'process_shot', platform: 'web', at: '2026-01-01T00:00:00Z' }));
  { const x = ak(dir, 'record', run, '--expect', 'E1', '--status', 'pass', '--evidence', 'evidence/page.txt', '--quote', '已保存'); assert.equal(x.status, 0, x.stderr); }
  { const x = ak(dir, 'reviewq', '--pack', '--run', run); assert.equal(x.status, 0, x.stderr); }
  const pdir = join(dir, 'state', 'review', 'packets', run);
  const packet = readFileSync(join(pdir, readdirSync(pdir)[0]), 'utf8');
  assert.match(packet, /主张清单/); assert.match(packet, /C1 {2}保存后弹窗提示/); assert.match(packet, /弹窗（要在被测 app/);
  const key = 'E1::evidence/page.txt', f = join(dir, 'v.jsonl');
  writeFileSync(f, JSON.stringify({ run, key, verdict: 'ok', note: '' }) + '\n');
  const bad = ak(dir, 'reviewq', '--apply', f, '--by', 'blind');
  assert.notEqual(bad.status, 0); assert.match(bad.stdout, /判 ok 要逐条写出每条主张在证据哪里/);
  const n = reviewClaims({ assert: '保存后弹窗提示「已保存」；列表里多出这一条' }).length;
  writeFileSync(f, JSON.stringify({ run, key, verdict: 'ok', note: '', claims: Array.from({ length: n }, (_, i) => ({ id: `C${i + 1}`, where: i === 1 ? '找不到' : '第1行' })) }) + '\n');
  assert.match(ak(dir, 'reviewq', '--apply', f, '--by', 'blind').stdout, /C2.*找不到就判 insufficient/);
  writeFileSync(f, JSON.stringify({ run, key, verdict: 'ok', note: '', claims: Array.from({ length: n }, (_, i) => ({ id: `C${i + 1}`, where: `第${i % 2 + 1}行` })) }) + '\n');
  const good = ak(dir, 'reviewq', '--apply', f, '--by', 'blind');
  assert.equal(good.status, 0, good.stdout + good.stderr);
  const rv = JSON.parse(readFileSync(join(dir, 'runs', run, 'result.json'), 'utf8')).reviews[key];
  assert.equal(rv.state, 'ok'); assert.equal(rv.claims_checked, true); assert.equal(rv.claims.length, n);
});

test('observe 机判：断言说的比观测读到的宽，复核不由工具关掉，排进盲审', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acceptkit-claims-obs-'));
  for (const d of ['cases', 'runs', 'state/plans', 'knowledge', 'ops']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'acceptkit.project.json'), JSON.stringify({ name: 't', gate: { allow: [] } }));
  const obs = { op: 'read-json', params: { file: 'evidence/out.json' }, checks: [{ pick: 'ok', predicate: { eq: true } }] };
  writeFileSync(join(dir, 'cases', 'c1.case.json'), JSON.stringify({ case: 'c1', title: '保存', platform: 'web', classifications: { carrier: ['web'] },
    tree: [{ op: '读产物', tags: { carrier: 'web' }, expect: [
      { id: 'E1', assert: '保存成功并弹窗提示已保存', via: 'cli', why_not_ui: '示例', observe: obs },
      { id: 'E2', assert: '产物里 ok 为 true', via: 'cli', why_not_ui: '示例', observe: obs }] }] }));
  writeFileSync(join(dir, 'ops', 'registry.json'), JSON.stringify({ ops: { 'read-json': { kind: 'observe', title: '读产物', why: 'w', observes: 'state', platforms: { web: { exec: 'json-file', strength: 'S2', state: 'confirmed' } } } } }));
  writeFileSync(join(dir, 'state', 'plans', 'D1.json'), JSON.stringify({ demand: 'D1', title: '测', platform: 'web', revision: 1,
    surfaces: [{ id: 'S1', change: 'x', reuse: ['c1'], new: [], ops: [] }], not_covered: [], history: [],
    approved_by: 'tester', approved_at: new Date().toISOString(), created_at: new Date().toISOString() }));
  { const x = ak(dir, 'run', 'c1', '--demand', 'D1'); assert.equal(x.status, 0, x.stderr); }
  const run = readdirSync(join(dir, 'runs'))[0];
  mkdirSync(join(dir, 'runs', run, 'evidence'), { recursive: true }); mkdirSync(join(dir, 'runs', run, 'shots'), { recursive: true });
  writeFileSync(join(dir, 'runs', run, 'evidence', 'out.json'), JSON.stringify({ ok: true }));
  writeFileSync(join(dir, 'runs', run, 'shots', 'app-01-home.png'), Buffer.alloc(512, 1));
  writeFileSync(join(dir, 'runs', run, 'shots', 'app-01-home.json'), JSON.stringify({ kind: 'process_shot', platform: 'web', at: '2026-01-01T00:00:00Z' }));
  const o = ak(dir, 'observe', run);
  assert.match(o.stderr, /E1：断言说的比观测读到的宽/);
  const r = JSON.parse(readFileSync(join(dir, 'runs', run, 'result.json'), 'utf8'));
  const rv = id => Object.entries(r.reviews).find(([k]) => k.startsWith(id + '::'))[1];
  assert.equal(r.results.E1.status, 'pass');
  assert.equal(rv('E1').state, 'pending', '宽的那条交盲审'); assert.match(rv('E1').note, /「弹窗」要在被测 app/);
  assert.equal(rv('E2').state, 'ok'); assert.equal(rv('E2').by, 'machine', '只说读到的那一层，机判照旧');
});

test('ops set 只登记 observes：配方的状态、出处一个字不动，配方里的老字段也不挡', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acceptkit-ops-observes-'));
  mkdirSync(join(dir, 'ops'), { recursive: true });
  writeFileSync(join(dir, 'acceptkit.project.json'), JSON.stringify({ name: 't', gate: { allow: [] } }));
  const recipe = { exec: 'cmd', state: 'guess', source: '2026-11-12 新建，未实测', capture: { x: 'y' } };
  writeFileSync(join(dir, 'ops', 'registry.json'), JSON.stringify({ ops: {
    probe: { kind: 'observe', title: '读', why: 'w', platforms: { android: recipe, ios: { exec: 'cmd', state: 'verified', source: 'tools/x.sh' } } } } }));
  const x = ak(dir, 'ops', 'set', 'probe', '--platform', 'android', '--observes', 'decision,diag');
  assert.equal(x.status, 0, x.stdout + x.stderr); assert.match(x.stdout, /配方没动/);
  const o = JSON.parse(readFileSync(join(dir, 'ops', 'registry.json'), 'utf8')).ops.probe;
  assert.deepEqual(o.observes, ['decision', 'diag']);
  assert.deepEqual(o.platforms.android, recipe, '推测没被抬成已确认、出处没被抹掉');
  assert.equal(o.platforms.ios.state, 'verified');
  // 只补说明：状态和出处照旧；改了做法：记已确认，出处有就留着
  assert.equal(ak(dir, 'ops', 'set', 'probe', '--platform', 'ios', '--caveats', '要先登录').status, 0);
  let ios = JSON.parse(readFileSync(join(dir, 'ops', 'registry.json'), 'utf8')).ops.probe.platforms.ios;
  assert.equal(ios.state, 'verified'); assert.equal(ios.source, 'tools/x.sh');
  assert.equal(ak(dir, 'ops', 'set', 'probe', '--platform', 'ios', '--how', '换了个读法').status, 0);
  ios = JSON.parse(readFileSync(join(dir, 'ops', 'registry.json'), 'utf8')).ops.probe.platforms.ios;
  assert.equal(ios.state, 'confirmed'); assert.equal(ios.source, 'tools/x.sh');
});
