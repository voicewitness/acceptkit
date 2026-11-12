// 取证咨询：断言拿不出证据时，工具要按通识标准给出「去哪看、要问清什么业务知识」，
// 而不是只说缺什么（产品规则：工具有义务给出通识标准，帮执行者问清业务知识、补上证据）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { facesOf, consultFor, GENERIC, INPUT } from '../core/evidence-consult.mjs';
import { evidenceGapCard } from '../core/cards.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(REPO, 'bin', 'acceptkit.mjs');

test('faces: picks the claim surface from the assertion wording, at most the two strongest', () => {
  assert.deepEqual(facesOf('覆盖率上报事件里带 request_id').map(f => f.id)[0], 'telemetry');
  assert.deepEqual(facesOf('请求被拦截，不出现在抓包里').map(f => f.id)[0], 'network');
  assert.deepEqual(facesOf('改造前后事件条数不掉，与基线一致').map(f => f.id)[0], 'compare');
  assert.ok(facesOf('策略命中，走 T 分支，下发配置里有它').length <= 2);
  assert.deepEqual(facesOf('完全不相干的一句话').map(f => f.id), ['screen'], 'falls back to the screen (UI is the default way to verify)');
});

test('consultFor: every surface carries a business question; blocked adds the input questions and an owner-ready draft', () => {
  const gap = consultFor({ assert: '覆盖率上报事件里带 request_id', situation: 'gap', gaps: ['no_ui_shot'] });
  assert.ok(gap.surfaces.length >= 3 && gap.surfaces.every(s => s.where && /？$/.test(s.ask)));
  assert.deepEqual(gap.questions, GENERIC);
  const blk = consultFor({ assert: '策略命中，走 T 分支', situation: 'blocked', unlock: 'needs cal_path' });
  assert.deepEqual(blk.questions, [...GENERIC, ...INPUT]);
  assert.match(blk.owner_ask.question, /？$/);
  assert.ok(blk.owner_ask.options.length >= 2 && blk.owner_ask.options.every(o => o.includes('=>')), 'options carry consequences, like any owner question');
  assert.ok(blk.owner_ask.options.some(o => /观测点/.test(o)), 'always offers the "nothing exists, add an observation point" exit');
});

test('evidence_gap card points the executor at consult', () => {
  const c = evidenceGapCard('r1', ['E1'], { E1: ['no_ui_shot'] });
  assert.ok(c.detail.some(d => d.includes('consult r1 --expect E1')));
});

test('consult command: reads the run and case, returns the card with surfaces, questions and the owner draft', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acceptkit-consult-'));
  for (const d of ['cases', 'runs/r1', 'state/blockers', 'knowledge', 'ops']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'acceptkit.project.json'), JSON.stringify({ name: 't', gate: { allow: [] } }));
  writeFileSync(join(dir, 'cases/c.case.json'), JSON.stringify({ case: 'c', title: 't', platform: 'android',
    tree: [{ op: 'inject', expect: [{ id: 'E1', assert: '覆盖率上报事件里带 request_id' }] }] }));
  writeFileSync(join(dir, 'runs/r1/result.json'), JSON.stringify({ case: 'c', run: 'r1', demand: 'D1', platform: 'android', results: { E1: { status: 'blocked' } }, steps: {} }));
  writeFileSync(join(dir, 'knowledge/notes.md'), '## 取证\n- c 的覆盖率上报能在线下工具「上报记录」页按事件名筛到\n- 无关的一条：构建要 JDK 17\n');
  const r = spawnSync(process.execPath, [BIN, 'consult', 'r1', '--expect', 'E1', '--json'], { cwd: dir, encoding: 'utf8', env: { ...process.env, ACCEPTKIT_PROJECT: dir } });
  assert.equal(r.status, 0, r.stderr);
  const k = JSON.parse(r.stdout);
  assert.equal(k.kind, 'consult');
  assert.equal(k.situation, 'blocked');
  assert.equal(k.faces[0].id, 'telemetry');
  assert.ok(k.questions.length > GENERIC.length, 'blocked: input questions included');
  assert.equal(k.knowledge.length, 1, 'only the knowledge that names this case comes back');
  assert.match(k.knowledge[0].text, /上报记录/);
  assert.ok(k.next.some(n => n.includes('blockers D1 --set')), 'gives a ready-made owner question command');
});
