// next：从记录推出这个需求还剩的每件事，按顺序列成卡片（docs/002-protocol.md 第二、三节）。
// 小项目依次走过「评审单未批 → 批了没跑 → 跑了有 todo → 证据待审 → 全部完成」，每一步断言卡片种类和顺序。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, readFileSync, utimesSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'bin', 'acceptkit.mjs');
const ak = (dir, ...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, ACCEPTKIT_PROJECT: dir, HOME: dir } });
const ok = (dir, ...args) => { const r = ak(dir, ...args); assert.equal(r.status, 0, `${args.join(' ')}\n${r.stderr}`); return r; };
const cards = (dir, D = 'D1') => { const r = ok(dir, 'next', D, '--json'); return JSON.parse(r.stdout).cards; };
const kinds = (dir, D) => cards(dir, D).map(c => c.kind);

function project(platform = 'web') {
  const dir = mkdtempSync(join(tmpdir(), 'acceptkit-test-'));
  for (const d of ['cases', 'runs', 'state/plans', 'knowledge', 'ops']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'acceptkit.project.json'), JSON.stringify({ name: 't', gate: { allow: [] } }));
  writeFileSync(join(dir, 'cases', 'c1.case.json'), JSON.stringify({ case: 'c1', title: '首页问候语', platform, input: 'real',
    classifications: { carrier: ['page'] },
    tree: [{ op: '打开「首页」', tags: { carrier: 'page' }, shows: ['你好'], expect: [{ id: 'E1', assert: '页面顶部显示「你好」' }] }] }));
  return dir;
}
const runId = dir => readdirSync(join(dir, 'runs'))[0];
// 测试里不碰浏览器：放一张带工具记录的过程截图，当作 shot 截的
function fakeShot(dir, run) {
  mkdirSync(join(dir, 'runs', run, 'shots'), { recursive: true });
  writeFileSync(join(dir, 'runs', run, 'shots', 'app-01-home.png'), Buffer.alloc(512, 1));
  writeFileSync(join(dir, 'runs', run, 'shots', 'app-01-home.json'), JSON.stringify({ kind: 'process_shot', platform: 'web', at: new Date().toISOString() }));
  ok(dir, 'record', run, '--step', 'n1', '--evidence', 'shots/app-01-home.png');
}
function applyVerdicts(dir, run, verdict) {
  ok(dir, 'reviewq', '--pack', '--run', run);
  const f = join(dir, 'verdicts.jsonl');
  writeFileSync(f, ['step:n1::shots/app-01-home.png', 'E1::evidence/page.txt', 'E1::shots/E1-read.png']
    .map(key => JSON.stringify({ run, key, verdict: key.startsWith('E1') ? verdict : 'ok', note: '看了包' })).join('\n') + '\n');
  ok(dir, 'reviewq', '--apply', f, '--by', 'blind');
}

test('需求不存在：拒收是一句能照着改的话，--json 输出 refused 且退出码非 0', () => {
  const dir = project();
  const r = ak(dir, 'next', 'D9', '--json');
  assert.notEqual(r.status, 0);
  assert.match(JSON.parse(r.stdout).refused, /plan new D9/);
  assert.match(ak(dir, 'next', 'D9').stderr, /没有需求 D9/);
});

test('一个需求从评审单到报告，每一步的卡片种类和顺序（报告由工具自动出）', () => {
  const dir = project();
  ok(dir, 'plan', 'new', 'D1', '--title', '首页问候', '--platform', 'web');
  assert.deepEqual(kinds(dir), ['plan_draft']);

  ok(dir, 'plan', 'add-case', 'D1', '--surface', 'S1', '--change', '首页加了问候语', '--reuse', 'c1', '--risk', '看不到问候', '--uncovered', '其他页');
  // 一条写清了的 finding（等 owner）、一条没写清的（执行者补写）
  const pf = join(dir, 'state/plans/D1.json');
  const plan = JSON.parse(readFileSync(pf, 'utf8'));
  plan.findings = [
    { id: 'F1', what: '问候语在窄屏上被截断', kind: 'design_gap', impact: '小屏手机用户', why: '标题区宽度是固定的',
      options: [{ label: '改成自动换行', effect: '高度会变' }, { label: '不处理', effect: '小屏看不全' }], recommend: '改成自动换行',
      decide: '窄屏上要不要换行？', at: '2026-01-01T00:00:00Z', decided_by: null },
    { id: 'F2', what: '有个地方不对', decide: '怎么办？', at: '2026-01-02T00:00:00Z', decided_by: null },
  ];
  writeFileSync(pf, JSON.stringify(plan));
  let cs = cards(dir);
  assert.deepEqual(cs.map(c => c.kind), ['attention', 'attention', 'finding_unclear']);
  assert.deepEqual(cs.map(c => c.subject || c.finding), ['plan_approval', 'finding', 'F2']);
  // 等回答的卡片带上「用户回了跑哪条」：命令在清单里，argv 已经填好需求和条目
  assert.deepEqual(cs.slice(0, 2).map(c => c.on_reply.command), ['plan_approve', 'plan_decide']);
  assert.match(cs[0].on_reply.argv, /^acceptkit plan approve D1 --by <他> --quote "<原话>" --json$/);
  assert.match(cs[1].on_reply.argv, /plan decide D1 --finding F1 --by <他>/);
  assert.equal(cs[1].question, '窄屏上要不要换行？');
  assert.equal(cs[1].read, 'finding/D1/F1');
  // 文本模式：编号清单
  assert.match(ok(dir, 'next', 'D1').stdout, /1\. \[attention\][\s\S]*问用户：[\s\S]*用户回了：acceptkit plan approve D1/);

  // 批准只能记用户本人的：执行者自签拒收，--json 返回 plan 卡片
  const self = ak(dir, 'plan', 'approve', 'D1', '--by', 'executor', '--quote', '可以', '--json');
  assert.notEqual(self.status, 0);
  assert.match(JSON.parse(self.stdout).refused, /用户本人/);
  const pc = JSON.parse(ok(dir, 'plan', 'approve', 'D1', '--by', 'owner', '--quote', '可以', '--json').stdout);
  assert.equal(pc.kind, 'plan'); assert.equal(pc.approved, true); assert.equal(pc.quote, '可以');
  ok(dir, 'plan', 'decide', 'D1', '--finding', 'F1', '--by', 'owner', '--quote', '换行');
  ok(dir, 'plan', 'settle', 'D1', '--finding', 'F2', '--kind', 'executor', '--note', '自己查清了');
  cs = cards(dir);
  assert.deepEqual(cs.map(c => c.kind), ['run_needed']);
  assert.equal(cs[0].note, 'acceptkit run c1 --demand D1');

  ok(dir, 'run', 'c1', '--demand', 'D1');
  const run = runId(dir);
  cs = cards(dir);
  assert.deepEqual(cs.map(c => c.kind), ['step_todo', 'expect_todo']);
  assert.equal(cs[0].node, 'n1');
  assert.match(cs[0].note, new RegExp(`shot ${run} --web --step n1`));
  assert.match(cs[0].note, /你好/, 'step_todo 带上节点的 shows');
  assert.equal(cs[1].assert, '页面顶部显示「你好」');
  assert.equal(cs[1].read, `run/${run}/E1`);

  // 很久没动静、还有待办：最后多一张 stalled
  const old = (Date.now() - 3 * 3600e3) / 1000;
  utimesSync(join(dir, 'runs', run, 'result.json'), old, old);
  assert.deepEqual(kinds(dir), ['step_todo', 'expect_todo', 'stalled']);

  fakeShot(dir, run);
  mkdirSync(join(dir, 'runs', run, 'evidence'), { recursive: true });
  writeFileSync(join(dir, 'runs', run, 'evidence', 'page.txt'), '页面顶部：你好\n');
  ok(dir, 'record', run, '--expect', 'E1', '--status', 'pass', '--evidence', 'evidence/page.txt', '--quote', '你好');
  // 只有文本证据的 pass：证据不全（与报告缺口、看板「证据不全」同一份判据），先补读值那一刻的截图
  cs = cards(dir);
  assert.equal(cs[0].kind, 'evidence_gap');
  assert.match(cs[0].title, /E1/);
  writeFileSync(join(dir, 'runs', run, 'shots', 'E1-read.png'), Buffer.alloc(512, 2));
  writeFileSync(join(dir, 'runs', run, 'shots', 'E1-read.png.json'), JSON.stringify({ kind: 'ui_observe', platform: 'web', at: new Date().toISOString() }));
  ok(dir, 'record', run, '--expect', 'E1', '--status', 'pass', '--evidence', 'evidence/page.txt', '--evidence', 'shots/E1-read.png', '--quote', '你好');
  cs = cards(dir);
  assert.deepEqual(cs.map(c => c.kind), ['review_due']);
  assert.equal(cs[0].count, 3);

  // 盲审驳回：断言退回待测，驳回理由上卡片
  applyVerdicts(dir, run, 'insufficient');
  cs = cards(dir);
  assert.deepEqual(cs.map(c => c.kind), ['expect_todo', 'rejected', 'rejected'], 'E1 的文本证据和读值截图各被驳回一次');
  assert.equal(cs[1].expect, 'E1');
  assert.match(cs[1].detail.join(''), /看了包/);

  // 补证据（内容变了 → 回到待审），重判，再审通过 → 出报告 → 清单为空
  writeFileSync(join(dir, 'runs', run, 'evidence', 'page.txt'), '页面顶部：你好（标题区第一行，完整可见）\n');
  ok(dir, 'record', run, '--expect', 'E1', '--status', 'pass', '--evidence', 'evidence/page.txt', '--evidence', 'shots/E1-read.png', '--quote', '完整可见');
  assert.deepEqual(kinds(dir), ['review_due']);
  // 最后一份复核落下：报告由工具当场出（engine autoReport），不再是执行者的一张卡片
  applyVerdicts(dir, run, 'ok');
  assert.ok(existsSync(join(dir, 'runs', run, 'run.md')), '复核写回后报告已自动生成');
  assert.deepEqual(kinds(dir), []);
  // 清单为空 = 报告已经出完：只剩把地址给用户，不再让执行者重出一遍报告
  assert.match(ok(dir, 'next', 'D1').stdout, /没有剩下的事，报告都出完了：acceptkit link D1/);
});

test('端上运行先要设备；阻塞项：等外部的问人，自己的能力缺口不问人', () => {
  const dir = project('ios');
  ok(dir, 'plan', 'new', 'D1', '--title', '首页问候', '--platform', 'ios');
  ok(dir, 'plan', 'add-case', 'D1', '--surface', 'S1', '--change', '首页加了问候语', '--reuse', 'c1', '--risk', '看不到问候', '--uncovered', '其他页');
  ok(dir, 'plan', 'approve', 'D1', '--by', 'owner', '--quote', '可以');
  ok(dir, 'run', 'c1', '--demand', 'D1');
  const run = runId(dir);
  let cs = cards(dir);
  assert.deepEqual(cs.map(c => c.kind), ['device_needed', 'step_todo', 'expect_todo']);
  assert.match(cs[0].note, new RegExp(`device acquire --run ${run}`));

  ok(dir, 'record', run, '--expect', 'E1', '--status', 'blocked', '--blocked-kind', 'dependency', '--actual', '测试环境挂了', '--unlock', '等测试环境恢复');
  cs = cards(dir);
  // 要用户答的阻塞先写成他能拍板的问题：只有解锁条件时是执行者的活，不问人
  assert.equal(cs[0].kind, 'blocker_unasked');
  assert.match(cs[0].note, /blockers D1 --set B1 --ask/);
  assert.match(ak(dir, 'blockers', 'D1', '--raise').stderr, /还没写成他能拍板的问题/);
  ok(dir, 'blockers', 'D1', '--set', 'B1', '--ask', '测试环境什么时候能恢复，要不要先跳过？', '--why-you', '环境归测试平台组管，我没有权限', '--option', '等恢复再测 => 晚一天出结论', '--option', '本轮跳过 => 报告里写明没测', '--recommend', '等恢复：只差一天');
  cs = cards(dir);
  assert.equal(cs[0].kind, 'attention');
  assert.equal(cs[0].subject, 'blocker');
  // 还没提：不带 question，要交给用户的是 --raise 的输出（只给一样东西让执行者原样转交）
  assert.equal(cs[0].question, undefined);
  assert.match(cs[0].note, /blockers D1 --raise/);
  ok(dir, 'blockers', 'D1', '--raise');
  cs = cards(dir);
  assert.equal(cs[0].kind, 'attention');
  assert.equal(cs[0].question, '测试环境什么时候能恢复，要不要先跳过？', '已提：question 是写成问句的那一条，不是解锁条件');
  assert.deepEqual(cs[0].options, ['1. 等恢复再测 => 晚一天出结论', '2. 本轮跳过 => 报告里写明没测']);
  assert.ok(!cs.some(c => c.kind === 'expect_todo'), 'blocked 是结论，不算待测');

  // 改判成自己的能力缺口：不问人，排在执行者待办里
  const bf = join(dir, 'state/blockers/D1.jsonl');
  const b = JSON.parse(readFileSync(bf, 'utf8').trim());
  writeFileSync(bf, JSON.stringify({ ...b, kind: 'capability', reported: false, raised_at: null }) + '\n');
  cs = cards(dir);
  assert.ok(!cs.some(c => c.kind === 'attention'));
  assert.equal(cs[0].kind, 'blocker_own');
  assert.match(cs[0].note, /--resolve B1/);

  // 用户答复了（等外部的那类）：落回断言卡片，照答复重测
  writeFileSync(bf, JSON.stringify({ ...b, reported: true, answer: '环境已恢复' }) + '\n');
  cs = cards(dir);
  const e = cs.find(c => c.kind === 'expect_todo');
  assert.ok(e && /环境已恢复/.test(e.detail.join('')));
  assert.ok(!cs.some(c => c.kind === 'attention'));
});

test('被测代码变了：出 round_stale，且只读不写轮次文件', () => {
  const dir = project();
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  const git = (...a) => spawnSync('git', ['-C', repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
  git('init', '-q'); writeFileSync(join(repo, 'a.txt'), '1'); git('add', '.'); git('commit', '-qm', 'first');
  ok(dir, 'plan', 'new', 'D1', '--title', '首页问候', '--platform', 'web');
  ok(dir, 'plan', 'add-case', 'D1', '--surface', 'S1', '--change', '首页加了问候语', '--reuse', 'c1', '--risk', '看不到问候', '--uncovered', '其他页');
  ok(dir, 'plan', 'approve', 'D1', '--by', 'owner', '--quote', '可以');
  mkdirSync(join(dir, 'state/rounds'), { recursive: true });
  const rf = join(dir, 'state/rounds/D1.json');
  const body = JSON.stringify({ demand: 'D1', repos: [{ name: 'app', path: repo }], rounds: [{ id: 'R1', seq: 1, code: { app: { commit: '0'.repeat(40) } } }] });
  writeFileSync(rf, body);
  const cs = cards(dir);
  assert.deepEqual(cs.map(c => c.kind), ['round_stale', 'run_needed']);
  assert.match(cs[0].note, /round new D1 --assess/);
  assert.equal(readFileSync(rf, 'utf8'), body);
});

test('截不了图的 UI 节点：断言判不了且进了台账，或这一步登记了取证手段的问题，就不再要过程截图，能出 report_due', () => {
  const dir = project();
  ok(dir, 'plan', 'new', 'D1', '--title', '首页问候', '--platform', 'web');
  ok(dir, 'plan', 'add-case', 'D1', '--surface', 'S1', '--change', '首页加了问候语', '--reuse', 'c1', '--risk', '看不到问候', '--uncovered', '其他页');
  ok(dir, 'plan', 'approve', 'D1', '--by', 'owner', '--quote', '可以');
  ok(dir, 'run', 'c1', '--demand', 'D1');
  const run = runId(dir);
  // 页面起不来：唯一的断言记成自己的能力缺口，写清复盘后告知用户
  ok(dir, 'record', run, '--expect', 'E1', '--status', 'blocked', '--blocked-kind', 'capability', '--actual', '页面打不开', '--unlock', '我要先把本地服务起起来');
  ok(dir, 'blockers', 'D1', '--set', 'B1', '--review-note', '评审后才出现：本地服务换了端口');
  ok(dir, 'blockers', 'D1', '--raise');
  // 自己的能力缺口提过也还是执行者的活：一直出 blocker_own，直到 --resolve 或断言有了结论
  assert.deepEqual(kinds(dir), ['blocker_own', 'report_due']);

  // 没有断言结论、但执行者把这一步登记成取证手段的问题：也不再出 step_todo
  const dir2 = project();
  ok(dir2, 'plan', 'new', 'D1', '--title', '首页问候', '--platform', 'web');
  ok(dir2, 'plan', 'add-case', 'D1', '--surface', 'S1', '--change', '首页加了问候语', '--reuse', 'c1', '--risk', '看不到问候', '--uncovered', '其他页');
  ok(dir2, 'plan', 'approve', 'D1', '--by', 'owner', '--quote', '可以');
  ok(dir2, 'run', 'c1', '--demand', 'D1');
  const run2 = runId(dir2);
  assert.deepEqual(kinds(dir2), ['step_todo', 'expect_todo']);
  ok(dir2, 'apparatus', run2, '--what', '截图连续三次超时', '--fix', '换一个调试端口', '--where', 'step:n1');
  assert.deepEqual(kinds(dir2), ['expect_todo']);
});

test('看板上「待测」的断言，next 都要有卡片：轮次重置了旧结论要开新运行；评审单没批时挂到批准卡片上', () => {
  const dir = project();
  ok(dir, 'plan', 'new', 'D1', '--title', '首页问候', '--platform', 'web');
  ok(dir, 'plan', 'add-case', 'D1', '--surface', 'S1', '--change', '首页加了问候语', '--reuse', 'c1', '--risk', '看不到问候', '--uncovered', '其他页');
  // 一条跑过、记了 pass 的运行（证据时刻 2026-01-01）
  const rd = join(dir, 'runs', 'r1');
  mkdirSync(join(rd, 'evidence'), { recursive: true });
  writeFileSync(join(rd, 'evidence', 'page.txt'), '你好');
  utimesSync(join(rd, 'evidence', 'page.txt'), new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
  writeFileSync(join(rd, 'result.json'), JSON.stringify({ run: 'r1', case: 'c1', run_seq: 1, demand: { id: 'D1' }, platform: 'web',
    results: { E1: { status: 'pass', evidence: ['evidence/page.txt'] } } }));
  // 之后开了第 2 轮，评估时把 E1 重置了
  mkdirSync(join(dir, 'state/rounds'), { recursive: true });
  writeFileSync(join(dir, 'state/rounds/D1.json'), JSON.stringify({ demand: 'D1', repos: [], rounds: [
    { id: 'R1', seq: 1, opened_at: '2025-12-01T00:00:00Z' },
    { id: 'R2', seq: 2, opened_at: '2026-02-01T00:00:00Z', impact: { reset: [{ key: 'c1::E1', why: '问候语组件重写' }] } }] }));

  let cs = cards(dir);
  const ask = cs.find(c => c.subject === 'plan_approval');
  assert.ok(!cs.some(c => c.kind === 'run_needed'), '没批开不了跑：不单独出卡片');
  assert.deepEqual(ask.held, [{ case: 'c1', expects: ['E1'], detail: ['轮次重置了旧结论：E1（R2：问候语组件重写）'] }]);
  assert.match(ask.question, /批了才能接着测：1 条用例、1 条断言（c1）/);

  ok(dir, 'plan', 'approve', 'D1', '--by', 'owner', '--quote', '可以');
  cs = cards(dir).filter(c => c.kind === 'run_needed');
  assert.equal(cs.length, 1);
  assert.match(cs[0].title, /c1 有 1 条断言没测上，要开新运行/);
  assert.equal(cs[0].note, 'acceptkit run c1 --demand D1');
});

// 评审单批过之后又加了用例：只有新加的那条回到「用例评审」，已批过的照常往下走（run 闸、next、阶段三处同口径）
test('评审单中途加用例：只挡新加的那条；阶段按用例算；批准记下这次批了哪些', async () => {
  const { nextCards, caseStages } = await import('../core/next.mjs');
  const dir = project();
  writeFileSync(join(dir, 'cases', 'c2.case.json'), JSON.stringify({ case: 'c2', title: '首页副标题', platform: 'web',
    classifications: { carrier: ['page'] },
    tree: [{ op: '打开「首页」', tags: { carrier: 'page' }, shows: ['欢迎'], expect: [{ id: 'E1', assert: '问候语下面显示「欢迎回来」' }] }] }));
  ok(dir, 'plan', 'new', 'D1', '--title', '首页问候', '--platform', 'web');
  ok(dir, 'plan', 'add-case', 'D1', '--surface', 'S1', '--change', '首页加了问候语', '--reuse', 'c1', '--risk', '看不到问候', '--uncovered', '其他页');
  ok(dir, 'plan', 'approve', 'D1', '--by', 'owner', '--quote', '可以');
  ok(dir, 'run', 'c1', '--demand', 'D1');

  const add = ok(dir, 'plan', 'add-case', 'D1', '--surface', 'S2', '--change', '首页加了副标题', '--new', 'c2', '--risk', '副标题不显示', '--uncovered', '其他页', '--why', '评审漏了副标题');
  assert.match(add.stdout, /新加的 c2 等 Owner 批准，已批过的 1 条照常跑/);
  // 内容漂移重钉指纹不等于替 Owner 批了新加的用例
  const cf = join(dir, 'cases', 'c1.case.json');
  writeFileSync(cf, readFileSync(cf, 'utf8').replace('页面顶部显示「你好」', '页面顶部第一行显示「你好」'));
  // 改了断言原文：按自动批准标准记下（写理由），不找 owner
  ok(dir, 'plan', 'recheck', 'D1', '--why', '断言写得更具体');

  let cs = cards(dir);
  const ask = cs.find(c => c.subject === 'plan_approval');
  assert.match(ask.title, /已批过的 1 条照常在测/);
  assert.deepEqual(ask.added, ['c2']);
  assert.deepEqual(ask.held.map(h => h.case), ['c2'], '只挡新加的');
  assert.match(ask.question, /新加 1 条用例（c2）/);
  assert.ok(cs.some(c => c.kind === 'expect_todo'), '已批过的 c1 照常有待办');
  const stages = caseStages(dir, nextCards(dir, 'D1'));
  assert.equal(stages.get('c2').stage, 'review');
  assert.equal(stages.get('c1').stage, 'exec');

  assert.match(ak(dir, 'run', 'c2', '--demand', 'D1').stderr, /c2 是评审单 v3 新加的，Owner 还没批/);
  ok(dir, 'run', 'c1', '--demand', 'D1');

  const ap = ok(dir, 'plan', 'approve', 'D1', '--by', 'owner', '--quote', '副标题也要测');
  assert.match(ap.stdout, /这次放行：c2/);
  const rows = JSON.parse(ok(dir, 'query', 'SELECT detail FROM approvals ORDER BY id', '--json').stdout);
  const det = JSON.parse(rows.at(-1).detail);
  assert.deepEqual({ revision: det.revision, added: det.added, removed: det.removed }, { revision: 3, added: ['c2'], removed: [] });
  // 批准记录里带着批的是哪一次事前评价、当时多少分（core/assess.mjs）
  assert.deepEqual(Object.keys(det.assessments).sort(), ['c1', 'c2']);
  assert.ok(Number.isInteger(det.assessments.c2.score));
  cs = cards(dir);
  assert.ok(!cs.some(c => c.subject === 'plan_approval'));
  assert.ok(cs.some(c => c.kind === 'run_needed' && c.case === 'c2'));
});

// 局部重跑：新一轮只重置了 E2，新开的运行里 E1 是空的 —— 它的结论继承自上一轮，不是待办（与看板同一份计算）
test('局部重跑：继承自更早一轮的断言不出 expect_todo，只有被重置的要测', () => {
  const dir = project();
  const cf = join(dir, 'cases', 'c1.case.json');
  const c = JSON.parse(readFileSync(cf, 'utf8'));
  c.tree[0].expect.push({ id: 'E2', assert: '问候语用的是用户的昵称' });
  writeFileSync(cf, JSON.stringify(c));
  ok(dir, 'plan', 'new', 'D1', '--title', '首页问候', '--platform', 'web');
  ok(dir, 'plan', 'add-case', 'D1', '--surface', 'S1', '--change', '首页加了问候语', '--reuse', 'c1', '--risk', '看不到问候', '--uncovered', '其他页');
  ok(dir, 'plan', 'approve', 'D1', '--by', 'owner', '--quote', '可以');
  const old = new Date('2026-01-01T00:00:00Z');
  for (const [id, seq, results] of [['r1', 1, { E1: { status: 'pass', evidence: ['evidence/page.txt'] }, E2: { status: 'pass', evidence: ['evidence/page.txt'] } }],
                                    ['r2', 2, { E1: { status: 'todo' }, E2: { status: 'todo' } }]]) {
    const rd = join(dir, 'runs', id);
    mkdirSync(join(rd, 'evidence'), { recursive: true });
    writeFileSync(join(rd, 'evidence', 'page.txt'), '你好，小明');
    utimesSync(join(rd, 'evidence', 'page.txt'), old, old);
    writeFileSync(join(rd, 'result.json'), JSON.stringify({ run: id, case: 'c1', run_seq: seq, demand: { id: 'D1' }, platform: 'web', results }));
  }
  mkdirSync(join(dir, 'state/rounds'), { recursive: true });
  writeFileSync(join(dir, 'state/rounds/D1.json'), JSON.stringify({ demand: 'D1', repos: [], rounds: [
    { id: 'R1', seq: 1, opened_at: '2025-12-01T00:00:00Z' },
    { id: 'R2', seq: 2, opened_at: '2026-02-01T00:00:00Z', impact: { reset: [{ key: 'c1::E2', why: '昵称取值改了' }] } }] }));
  const todo = cards(dir).filter(x => x.kind === 'expect_todo');
  assert.deepEqual(todo.map(x => [x.run, x.expect]), [['r2', 'E2']]);
});

test('owner 退回评审单：执行者拿到「照意见改」的卡片，退回只对那一版有效，批准后清掉', () => {
  const dir = project();
  ok(dir, 'plan', 'new', 'D1', '--title', '首页问候', '--platform', 'web');
  ok(dir, 'plan', 'add-case', 'D1', '--surface', 'S1', '--change', '首页加了问候语', '--reuse', 'c1', '--risk', '看不到问候', '--uncovered', '其他页');
  assert.equal(cards(dir)[0].on_reject.command, 'plan_return');
  assert.match(ak(dir, 'plan', 'return', 'D1', '--by', 'agent', '--quote', '不行').stderr, /执行者自己/);
  const r = JSON.parse(ok(dir, 'plan', 'return', 'D1', '--by', 'owner', '--quote', '先别测窄屏，范围太大', '--json').stdout);
  assert.equal(r.kind, 'plan'); assert.equal(r.approved, false);
  let cs = cards(dir);
  assert.ok(!cs.some(c => c.subject === 'plan_approval'), '退回后不再问 owner，轮到执行者');
  const back = cs.find(c => c.kind === 'plan_draft');
  assert.match(back.title, /退回了评审单 v1/); assert.match(back.detail[0], /先别测窄屏/);
  assert.deepEqual(back.held.map(h => h.case), ['c1'], '新加的用例仍挂在它上面：看板上还是「等批准」');
  // 照意见改了（升版本）→ 又是等 owner 批
  ok(dir, 'plan', 'add-case', 'D1', '--surface', 'S2', '--change', '只测宽屏', '--reuse', 'c1', '--risk', '宽屏没问候', '--uncovered', '窄屏');
  assert.ok(cards(dir).some(c => c.subject === 'plan_approval'));
  ok(dir, 'plan', 'approve', 'D1', '--by', 'owner', '--quote', '可以');
  assert.equal(JSON.parse(readFileSync(join(dir, 'state/plans/D1.json'), 'utf8')).returned, undefined);
});

test('结论来自一张 app 截图都没有的运行：不出 report_due，出 shot_missing（开新运行重测），用例停在「执行」', async () => {
  const dir = project('android');
  ok(dir, 'plan', 'new', 'D1', '--title', '首页问候', '--platform', 'android');
  ok(dir, 'plan', 'add-case', 'D1', '--surface', 'S1', '--change', '首页加了问候语', '--reuse', 'c1', '--risk', '看不到问候', '--uncovered', '其他页');
  ok(dir, 'plan', 'approve', 'D1', '--by', 'owner', '--quote', '可以');
  // 规则加上之前记的：pass、证据是文本、复核过、运行里一张图都没有
  const rd = join(dir, 'runs', 'r1');
  mkdirSync(join(rd, 'evidence'), { recursive: true });
  writeFileSync(join(rd, 'evidence', 'page.txt'), '你好');
  writeFileSync(join(rd, 'result.json'), JSON.stringify({ run: 'r1', case: 'c1', run_seq: 1, demand: { id: 'D1' }, platform: 'android', device: { udid: 'x' },
    results: { E1: { status: 'pass', evidence: ['evidence/page.txt'] } }, steps: { n1: { evidence: [] } }, apparatus: [{ where: 'step:n1', what: '截不了', fix: '-' }],
    reviews: { 'E1::evidence/page.txt': { state: 'ok', by: 'blind' } } }));
  const cs = cards(dir);
  assert.ok(!cs.some(c => c.kind === 'report_due'));
  const m = cs.find(c => c.kind === 'shot_missing');
  assert.ok(m, JSON.stringify(cs.map(c => c.kind)));
  assert.equal(m.note, 'acceptkit run c1 --demand D1');
  const { caseStages } = await import('../core/next.mjs');
  assert.equal(caseStages(dir, cs).get('c1').stage, 'exec');
});

test('看板最新一轮能完整生成：能信几成、等你（待批的用例、阻塞问题原文）、六栏泳道', () => {
  const dir = project('android');
  ok(dir, 'plan', 'new', 'D1', '--title', '首页问候', '--platform', 'android');
  ok(dir, 'plan', 'add-case', 'D1', '--surface', 'S1', '--change', '首页加了问候语（窄屏也要完整）', '--reuse', 'c1', '--risk', '看不到问候', '--uncovered', '其他页');
  ok(dir, 'plan', 'approve', 'D1', '--by', 'owner', '--quote', '可以');
  // 批准之后中途加一条：只有它等批准
  writeFileSync(join(dir, 'cases', 'c2.case.json'), JSON.stringify({ case: 'c2', title: '窄屏问候', platform: 'android', classifications: { carrier: ['page'] }, tree: [{ op: '打开「首页」', tags: { carrier: 'page' }, expect: [{ id: 'E1', assert: '窄屏上问候语完整' }] }] }));
  ok(dir, 'plan', 'add-case', 'D1', '--surface', 'S2', '--change', '窄屏适配', '--reuse', 'c2', '--risk', '被截断', '--uncovered', '平板', '--why', '评审漏了窄屏');
  const rd = join(dir, 'runs', 'r1');
  mkdirSync(join(rd, 'evidence'), { recursive: true });
  writeFileSync(join(rd, 'evidence', 'page.txt'), '你好');
  writeFileSync(join(rd, 'result.json'), JSON.stringify({ run: 'r1', case: 'c1', run_seq: 1, session: 's1', demand: { id: 'D1' }, platform: 'android', device: { udid: 'x' },
    results: { E1: { status: 'blocked', actual: '缺测试账号', evidence: [] } } }));
  mkdirSync(join(dir, 'state', 'blockers'), { recursive: true });
  writeFileSync(join(dir, 'state', 'blockers', 'D1.jsonl'), JSON.stringify({ id: 'B1', run: 'r1', case: 'c1', expect: 'E1', kind: 'dependency', unlock: '给一个能登录的测试账号', reported: true, raised_at: '2026-01-01T00:00:00Z' }) + '\n');
  const out = join(dir, 'board.html');
  const r = spawnSync(process.execPath, [join(dirname(BIN), '..', 'core', 'dashboard.mjs'), out], { cwd: dir, encoding: 'utf8', env: { ...process.env, ACCEPTKIT_PROJECT: dir, HOME: dir } });
  assert.equal(r.status, 0, r.stderr);
  const html = readFileSync(out, 'utf8');
  assert.match(html, /条断言能信几成/);
  // 链接直接带运行号（#run=r1）也要落到它那一轮，不能掉到第一个需求上
  assert.match(html, /const RUN2K=\{"r1":"round:D1:[^"]+"/);
  assert.match(html, /同不同意把 1 条用例加进这次验收/);
  // 只有解锁条件、没写成问题的阻塞不摆给 owner，只说一声
  assert.match(html, /另有 1 个阻塞（卡住 1 条断言）执行者还在写成你能拍板的问题/);
  assert.doesNotMatch(html, /答 1 个问题/);
  ok(dir, 'blockers', 'D1', '--set', 'B1', '--ask', '测试账号是你给一个，还是这条先不测？', '--why-you', '账号只有你能申请', '--option', '给账号 => 今天能测完', '--option', '先不测 => 报告里写明缺账号', '--recommend', '给账号');
  const r2 = spawnSync(process.execPath, [join(dirname(BIN), '..', 'core', 'dashboard.mjs'), out], { cwd: dir, encoding: 'utf8', env: { ...process.env, ACCEPTKIT_PROJECT: dir, HOME: dir } });
  assert.equal(r2.status, 0, r2.stderr);
  const html2 = readFileSync(out, 'utf8');
  assert.match(html2, /答 1 个问题/); assert.match(html2, /测试账号是你给一个，还是这条先不测？/);
  assert.match(html2, /为什么问你：账号只有你能申请/); assert.match(html2, /1\. 给账号 =&gt; 今天能测完/); assert.match(html2, /执行者推荐：给账号/);
  for (const col of ['等你批准', '待开跑', '正在测', '待复核', '验不了', '完成']) assert.match(html, new RegExp(col));
  assert.match(html, /<b>首页加了问候语<\/b>/, '泳道名只留一句人话');
  // 答阻塞：执行者签不了；用户的答复进审批表
  assert.match(ak(dir, 'blockers', 'D1', '--ack', 'B1', '--answer', '给你', '--by', 'agent').stderr, /执行者自己/);
  ok(dir, 'blockers', 'D1', '--ack', 'B1', '--answer', '账号在知识库里', '--by', 'owner');
  const db = spawnSync(process.execPath, ['-e', `import('${join(dirname(BIN), '..', 'core', 'store', 'db.mjs')}').then(m => console.log(JSON.stringify(m.listApprovals(process.argv[1], 'D1').map(a => [a.kind, a.by, a.quote]))))`, dir], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(db.stdout.trim().split('\n').pop()).at(-1), ['blocker_answer', 'owner', '账号在知识库里']);
});

test('shot_missing 与看板红条同一口径：按当前结论出自哪个运行；被后来运行覆盖的不出；早几轮截的图不算本轮的', async () => {
  const dir = project('android');
  writeFileSync(join(dir, 'cases', 'c2.case.json'), JSON.stringify({ case: 'c2', title: '设置页', platform: 'android',
    classifications: { carrier: ['page'] }, tree: [{ op: '打开设置', tags: { carrier: 'page' }, expect: [{ id: 'E1', assert: '设置页有开关' }, { id: 'E2', assert: '开关默认关' }] }] }));
  ok(dir, 'plan', 'new', 'D1', '--title', '问候与设置', '--platform', 'android');
  ok(dir, 'plan', 'add-case', 'D1', '--surface', 'S1', '--change', '首页加了问候语', '--reuse', 'c1', '--risk', '看不到问候', '--uncovered', '其他页');
  ok(dir, 'plan', 'add-case', 'D1', '--surface', 'S2', '--change', '设置页加了开关', '--reuse', 'c2', '--risk', '开关不对', '--uncovered', '其他页');
  ok(dir, 'plan', 'approve', 'D1', '--by', 'owner', '--quote', '可以');
  mkdirSync(join(dir, 'state/rounds'), { recursive: true });
  writeFileSync(join(dir, 'state/rounds/D1.json'), JSON.stringify({ demand: 'D1', repos: [], rounds: [
    { id: 'R1', seq: 1, opened_at: '2025-12-01T00:00:00Z' }, { id: 'R2', seq: 2, opened_at: '2026-02-01T00:00:00Z' }] }));
  // 写一个运行：results 的证据文件时刻决定结论归哪一轮、谁覆盖谁；shotAt 给了就放一张那个时刻的 app 截图
  const mk = (run, cs, seq, results, at, shotAt) => {
    const rd = join(dir, 'runs', run); mkdirSync(join(rd, 'evidence'), { recursive: true });
    writeFileSync(join(rd, 'evidence', 'page.txt'), 'x'); utimesSync(join(rd, 'evidence', 'page.txt'), at, at);
    if (shotAt) { mkdirSync(join(rd, 'shots'), { recursive: true }); writeFileSync(join(rd, 'shots', 'app-01-x.json'), JSON.stringify({ kind: 'process_shot', platform: 'android', at: shotAt })); }
    writeFileSync(join(rd, 'result.json'), JSON.stringify({ run, case: cs, run_seq: seq, demand: { id: 'D1' }, platform: 'android', device: { udid: 'x' },
      results: Object.fromEntries(Object.entries(results).map(([e, s]) => [e, { status: s, evidence: s === 'todo' ? [] : ['evidence/page.txt'] }])) }));
  };
  const t = s => new Date(s);
  // c1：r1 没截图的 pass，后来 r2 带本轮截图重测覆盖了 → r1 不出卡
  mk('r1', 'c1', 1, { E1: 'pass' }, t('2026-03-01'), null);
  mk('r2', 'c1', 2, { E1: 'pass' }, t('2026-03-02'), '2026-03-02T00:00:00Z');
  // c2：r3 的 E1、E2 记在 R2，图却是 R1 截的；最新的 r4 只重测了 E2 → E1 还出自 r3，出卡只列 E1
  mk('r3', 'c2', 1, { E1: 'pass', E2: 'pass' }, t('2026-03-01'), '2025-12-15T00:00:00Z');
  mk('r4', 'c2', 2, { E1: 'todo', E2: 'pass' }, t('2026-03-02'), '2026-03-02T00:00:00Z');
  const sm = cards(dir).filter(c => c.kind === 'shot_missing');
  assert.deepEqual(sm.map(c => c.run), ['r3'], JSON.stringify(sm));
  assert.deepEqual(sm[0].expects, ['E1']);
  assert.equal(sm[0].note, 'acceptkit run c2 --demand D1');
  assert.doesNotMatch(JSON.stringify(sm[0]), /blockers --raise|标 blocked/);
  // 看板红条数的是同一批运行
  ok(dir, 'open', '--file', '--no-open');
  const html = readFileSync(join(dir, 'dashboard.html'), 'utf8');
  const line = html.match(/个 run 一张都没有：[^<]*(?:<code>[^<]*<\/code>[^<]*)*/)?.[0] || '';
  assert.match(line, /<code>r3<\/code>/);
  assert.doesNotMatch(line, /<code>r1<\/code>/);
});

test('挂错需求的运行：next 只出改挂卡；refile 有护栏（评审单里的不能挪、目标要认这条用例、要理由），阻塞跟着转过去', () => {
  const dir = project('web');
  writeFileSync(join(dir, 'cases', 'c9.case.json'), JSON.stringify({ case: 'c9', title: '别的需求的用例', platform: 'web', origin: { id: 'D2' },
    classifications: { carrier: ['page'] }, tree: [{ op: '打开', tags: { carrier: 'page' }, expect: [{ id: 'E1', assert: '页面打开' }] }] }));
  ok(dir, 'plan', 'new', 'D1', '--title', '首页问候', '--platform', 'web');
  ok(dir, 'plan', 'add-case', 'D1', '--surface', 'S1', '--change', '首页加了问候语', '--reuse', 'c1', '--risk', '看不到问候', '--uncovered', '其他页');
  ok(dir, 'plan', 'approve', 'D1', '--by', 'owner', '--quote', '可以');
  ok(dir, 'plan', 'new', 'D2', '--title', '别的需求', '--platform', 'web');
  ok(dir, 'plan', 'new', 'D3', '--title', '不相干的需求', '--platform', 'web');
  ok(dir, 'run', 'c1', '--demand', 'D1');
  const r1 = runId(dir);
  // 当初绕过评审闸开在 D1 名下的 c9 运行，上面挂着一条阻塞
  mkdirSync(join(dir, 'runs', 'r9'), { recursive: true });
  writeFileSync(join(dir, 'runs', 'r9', 'result.json'), JSON.stringify({ run: 'r9', case: 'c9', run_seq: 1, session: '2026-01-01-D1', demand: { id: 'D1' }, platform: 'web',
    results: { E1: { status: 'blocked', actual: '装置坏了', evidence: [] } } }));
  mkdirSync(join(dir, 'state', 'blockers'), { recursive: true });
  writeFileSync(join(dir, 'state', 'blockers', 'D1.jsonl'), JSON.stringify({ id: 'B1', run: 'r9', case: 'c9', expect: 'E1', kind: 'capability', text: '装置坏了', unlock: '修装置', reported: false }) + '\n');

  let cs = cards(dir);
  const mis = cs.filter(c => c.kind === 'run_misfiled');
  assert.deepEqual(mis.map(c => c.run), ['r9']);
  assert.match(mis[0].note, /refile r9 --demand D2/);
  assert.ok(!cs.some(c => c.run === 'r9' && c.kind !== 'run_misfiled'), JSON.stringify(cs.map(c => [c.kind, c.run])));
  assert.ok(!cs.some(c => JSON.stringify(c).includes('B1') && c.kind !== 'run_misfiled'));

  // 护栏
  assert.match(ak(dir, 'refile', 'r9', '--demand', 'D2').stderr, /--why/);
  assert.match(ak(dir, 'refile', r1, '--demand', 'D2', '--why', 'x').stderr, /在 D1 的评审单里/);
  assert.match(ak(dir, 'refile', 'r9', '--demand', 'D3', '--why', 'x').stderr, /D3 不认用例 c9/);
  assert.notEqual(ak(dir, 'refile', 'r9', '--demand', 'D9', '--why', 'x').status, 0);

  ok(dir, 'refile', 'r9', '--demand', 'D2', '--why', '当初用 --skip-plan-gate 开错了需求');
  const r = JSON.parse(readFileSync(join(dir, 'runs', 'r9', 'result.json'), 'utf8'));
  assert.equal(r.demand.id, 'D2');
  assert.equal(r.session, '2026-01-01-D2');
  assert.equal(r.refiled.at(-1).from, 'D1');
  const d1 = readFileSync(join(dir, 'state', 'blockers', 'D1.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.equal(d1[0].resolved, true);
  assert.match(d1[0].resolved_how, /改挂到 D2/);
  const d2 = readFileSync(join(dir, 'state', 'blockers', 'D2.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.deepEqual(d2.map(b => [b.run, b.expect, !!b.resolved]), [['r9', 'E1', false]]);
  assert.ok(!cards(dir).some(c => c.kind === 'run_misfiled'));
});
