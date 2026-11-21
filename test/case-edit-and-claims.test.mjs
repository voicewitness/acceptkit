// 用例自己补的两件事：
//   ① 主张识别不冤判：效果词讲的是某个部件（「上报环」「上报出口」）或断言自己声明不判时不算主张；项目能改效果词、说清每层在本项目指什么
//   ② 批准后的用例改动分级：只加不删的事后通知（照常跑），会改结论 / 范围的要 owner 认
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { effectClaims, claimWordsOf, uncoveredClaims, fmtMissing, observePointsOf } from '../core/claims.mjs';
import { checkCase } from '../core/case-quality.mjs';
import { classifyCaseEdit } from '../core/plan-gate.mjs';

const words = t => effectClaims(t).map(c => c.word);

test('主张：讲部件、断言自己声明不判的不算；真说了效果的照样认（实测冤判过的样本）', () => {
  assert.deepEqual(words('诊断上报环里每条引擎上报只应记一次（report tap 只挂一个观察者）'), [], '上报环里的记录');
  assert.deepEqual(words('两类事件都经同一个上报出口（ReportUtil）产出——否则调试工具会漏采某一类'), [], '上报出口是部件');
  assert.deepEqual(words('进入引擎上报路径的 scene 行，category=engine（本条读的是进入上报路径的记录，不读实际上传）'), []);
  assert.deepEqual(words('同样注入 30 次，新链写 60 条同步行；这几行是重复上报还是分开的几次执行，这条不判'), [], '这条不判');
  assert.deepEqual(words('drop_request 熔断不在放行名单的路径（fuse）'), ['拦截'], '说了熔断：真主张');
  assert.deepEqual(words('统计上报按设计字段落地'), ['上报']);
  assert.deepEqual(words('命中后弹窗出现；上报环里有一条记录；上报发出'), ['弹窗', '上报'], '部件只管它那一句');
});

test('主张：claims_off 去掉作者声明的词；项目同名效果词整条替换；项目对层的说法进提示', () => {
  const e = { assert: '统计上报按设计字段落地', claims_off: [{ word: '上报', why: '读的是进入上报 SDK 前的那一下' }], observe: { op: 'p' } };
  const ops = { p: { platforms: { android: { observes: ['diag'] } } } };
  assert.equal(uncoveredClaims(e, { ops, platform: 'android' }).missing.length, 0);
  const cfg = { quality: { claimWords: [{ word: '上报', match: '上报', covers: ['report'], except: '上报(SDK)' }], observePoints: [{ layer: 'report', means: '交给上报 SDK 的那一下' }] } };
  const ws = claimWordsOf(cfg);
  assert.equal(ws.filter(w => w.word === '上报').length, 1, '同名替换，不重复');
  assert.deepEqual(effectClaims('交给上报SDK', ws), [], 'except 命中不算');
  assert.match(fmtMissing({ word: '上报', covers: ['report'] }, observePointsOf(cfg)), /本项目：交给上报 SDK 的那一下/);
});

const ring = observes => ({ kind: 'observe', title: '读', why: 'w', observes, platforms: { android: { exec: 'adb', read: [{ key: 'row', pattern: '(.*)' }], state: 'confirmed' } } });
const caseOf = (expect, extra = {}) => ({ case: 'c', title: 't', platform: 'android', tree: [{ op: '注入', expect: [{ id: 'E1', ...expect }] }], ...extra });

test('Q22：项目里根本没有读这一层的操作 → 说成「先补观测口」并给出用例自己补的做法；claims_off 要写 why', () => {
  const r = checkCase(caseOf({ assert: '命中后上报发出', observe: { op: 'ring', checks: [{ pick: 'read.row', predicate: { any_match: 'x' } }] } }), { ops: { ring: ring(['diag']) } }).filter(f => f.rule === 'Q22');
  assert.match(r[0].msg, /项目里还没有任何操作读「上报」/);
  const bad = checkCase(caseOf({ assert: '上报发出', claims_off: [{ word: '上报' }], observe: { op: 'ring', checks: [] } }), { ops: { ring: ring(['diag']) } }).filter(f => f.rule === 'Q22');
  assert.ok(bad.some(f => /没写 why/.test(f.msg)));
});

test('Q26：说了上报的断言判据全只看有没有 → 拦；有一条判内容或写了 why_presence_only → 不拦', () => {
  const presence = { op: 'ring', checks: [{ pick: 'read.row', predicate: { nonempty: true } }] };
  const content = { op: 'ring', checks: [{ pick: 'read.row', predicate: { any_match: '"store_region":"[A-Z]{2}"' } }] };
  const q = (e, rule = 'Q26') => checkCase(caseOf(e), { ops: { ring: ring(['report']) } }).filter(f => f.rule === rule);
  assert.equal(q({ assert: '统计上报发出', observe: presence }).length, 1);
  assert.equal(q({ assert: '统计上报发出', observe: content }).length, 0);
  assert.equal(q({ assert: '统计上报发出', observe: presence, why_presence_only: '业务只关心发没发' }).length, 0);
  assert.equal(q({ assert: '统计上报发出', observe: presence }, 'Q27').length, 1, '逐条提示');
});

test('改动分级：加判据 / 换观测 → 事后通知；删判据、改断言原文、声明不算效果 → 要 owner 认', () => {
  const base = caseOf({ assert: '上报发出', observe: { op: 'a', checks: [{ pick: 'read.x', predicate: { nonempty: true } }] } });
  const clone = () => JSON.parse(JSON.stringify(base));
  const more = clone(); more.tree[0].expect[0].observe.checks.push({ pick: 'read.y', predicate: { eq: 'US' } }); more.tree[0].expect[0].observe.op = 'b';
  assert.equal(classifyCaseEdit(base, more).tier, 'notify');
  const fewer = clone(); fewer.tree[0].expect[0].observe.checks = [];
  assert.equal(classifyCaseEdit(base, fewer).tier, 'ack');
  const reword = clone(); reword.tree[0].expect[0].assert = '判定产出 report 动作';
  assert.equal(classifyCaseEdit(base, reword).tier, 'ack');
  const off = clone(); off.tree[0].expect[0].claims_off = [{ word: '上报', why: 'w' }];
  assert.equal(classifyCaseEdit(base, off).tier, 'ack');
  assert.equal(classifyCaseEdit(base, clone()).tier, 'same');
});

const BIN = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'bin', 'acceptkit.mjs');
const ak = (dir, ...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, ACCEPTKIT_PROJECT: dir, HOME: dir } });
const ok = (dir, ...args) => { const r = ak(dir, ...args); assert.equal(r.status, 0, `${args.join(' ')}\n${r.stderr}`); return r; };

test('改动分级（命令行）：只加不删的照常跑并留通知；改了断言原文的拦跑、出卡等 owner 认，认了才放', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acceptkit-test-'));
  for (const d of ['cases', 'runs', 'state/plans', 'knowledge', 'ops']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'acceptkit.project.json'), JSON.stringify({ name: 't', gate: { allow: [] } }));
  const cf = join(dir, 'cases', 'c1.case.json');
  writeFileSync(cf, JSON.stringify({ case: 'c1', title: '首页问候语', platform: 'web', classifications: { carrier: ['page'] },
    tree: [{ op: '打开首页', tags: { carrier: 'page' }, shows: ['你好'], expect: [{ id: 'E1', assert: '页面顶部显示「你好」' }] }] }));
  ok(dir, 'plan', 'new', 'D1', '--title', '首页问候', '--platform', 'web');
  ok(dir, 'plan', 'add-case', 'D1', '--surface', 'S1', '--change', '首页加了问候语', '--reuse', 'c1', '--risk', '看不到问候', '--uncovered', '其他页');
  ok(dir, 'plan', 'approve', 'D1', '--by', 'owner', '--quote', '可以');

  // 只加一条断言：照常跑，recheck 记成事后通知
  const c = JSON.parse(readFileSync(cf, 'utf8'));
  c.tree[0].expect.push({ id: 'E2', assert: '问候语是黑色' }); writeFileSync(cf, JSON.stringify(c));
  ok(dir, 'run', 'c1', '--demand', 'D1');
  assert.match(ok(dir, 'plan', 'recheck', 'D1', '--why', '补颜色').stdout, /事后通知/);

  // 改断言原文：拦跑、出卡
  c.tree[0].expect[0].assert = '页面顶部显示问候语'; writeFileSync(cf, JSON.stringify(c));
  assert.match(ak(dir, 'run', 'c1', '--demand', 'D1').stderr, /owner 认了才能跑：E1 的断言原文改了/);
  const held = ok(dir, 'plan', 'recheck', 'D1', '--why', '放宽');
  assert.match(held.stdout, /owner 认了才能跑/);
  const card = JSON.parse(ok(dir, 'next', 'D1', '--json').stdout).cards.find(x => x.subject === 'case_edit');
  assert.ok(card && /plan recheck D1 --case c1 --by <他>/.test(card.on_reply.argv || JSON.stringify(card.on_reply)));
  assert.notEqual(ak(dir, 'plan', 'recheck', 'D1', '--why', 'x', '--by', 'agent', '--quote', '我觉得行').status, 0, '执行者不能自己认');
  ok(dir, 'plan', 'recheck', 'D1', '--why', '放宽', '--by', 'owner', '--quote', '可以这么改');
  ok(dir, 'run', 'c1', '--demand', 'D1');
  assert.match(ok(dir, 'plan', 'show', 'D1').stdout, /owner 认了|（owner 认了）/);
});
