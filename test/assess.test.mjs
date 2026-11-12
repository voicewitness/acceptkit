// 评价（core/assess.mjs）：维度归类、打分与卡口、O1/O4 观测检查、事后漏网
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessCasePre, assessRunPost, score, observabilityFindings, itemKey, clearsGate } from '../core/assess.mjs';

const ops = {
  'lldb-arm': { title: '调试器探针', platforms: { ios: { exec: 'shell', state: 'confirmed' } } },
  'demo-ui-event-log': { title: '调试面板 UI：在「事件日志」点开一条事件，读 delivery / retry_flag', why: '事件有没有被扣、补发时带不带 retry_flag',
    platforms: { ios: { exec: 'ui', state: 'guess' } } },
};
const caseOf = expects => ({ case: 'x', platform: 'ios', tree: [{ op: '做事', expect: expects }] });

test('O4：声明「界面上看不到」，但操作库已有同一件事的界面读法 ⇒ 拦，提示复核 why_not_ui', () => {
  const c = caseOf([{ id: 'E6', assert: '后台期间发的事件立刻交给宿主上报口，category 里没有 retry_flag', via: 'debugger',
    why_not_ui: '事件日志分不出交没交出去', observe: { op: 'lldb-arm' } }]);
  const f = observabilityFindings(c, ops, ['ios']).filter(x => x.rule === 'O4');
  assert.equal(f.length, 1);
  assert.equal(f[0].level, 'block');
  assert.match(f[0].msg, /demo-ui-event-log/);
});

test('O4 不误报：说的不是同一件事的调试器断言不提', () => {
  const c = caseOf([{ id: 'E2', assert: '前后台信号在装配阶段取出', via: 'debugger', why_not_ui: '后台时没有界面', observe: { op: 'lldb-arm' } }]);
  assert.equal(observabilityFindings(c, ops, ['ios']).filter(x => x.rule === 'O4').length, 0);
});

test('O1：写了在界面上看得到，读法却不走界面 ⇒ 拦', () => {
  const c = caseOf([{ id: 'E1', assert: '扣下', seen_at: '观测台上报监控', observe: { op: 'lldb-arm' } }]);
  assert.ok(observabilityFindings(c, ops, ['ios']).some(x => x.rule === 'O1' && x.level === 'block'));
});

test('不豁免存量：since 规则照样出 block 项；处置（accept / reject）才放行，adopt 要等改掉', () => {
  const items = assessCasePre(caseOf([]), { findings: [{ rule: 'Q21', level: 'block', since: '2026-11-06', title: '界面断言用界面通道', at: 'E6', msg: 'm', fix: 'f' }], ops, platforms: ['ios'] });
  const blk = items.find(i => i.rule === 'Q21');
  assert.equal(blk.level, 'block');
  assert.equal(blk.dimension, 'observable');
  for (const i of items) i.ikey = itemKey('case:x', i);
  assert.equal(score(items, 'pre').gate, 'block');
  assert.ok(score(items, 'pre').total <= 59, '有未处置的拦截项，综合分封顶');
  const decided = st => i => clearsGate({ status: st });
  assert.equal(score(items, 'pre', decided('accepted')).gate, 'pass');
  assert.equal(score(items, 'pre', decided('rejected')).gate, 'pass');
  assert.equal(score(items, 'pre', i => clearsGate({ status: 'adopted' })).gate, 'block', '采纳了还没改，照样拦');
});

test('事后：证据缺口算「证据充分」拦截；事前没提过的同一断言记「漏网」且要求 retro', () => {
  const r = { run: 'R1', results: { E6: { status: 'pass', observed: { op: 'lldb-arm' } } }, reviews: {} };
  const post = assessRunPost(r, { gaps: { E6: ['no_ui_shot'] }, preItems: [], expectOps: { E6: 'lldb-arm' } });
  assert.ok(post.some(i => i.dimension === 'evidence' && i.level === 'block'));
  const esc = post.find(i => i.dimension === 'escape' && i.level !== 'ok');
  assert.ok(esc && esc.needs_retro);
  const post2 = assessRunPost(r, { gaps: { E6: ['no_ui_shot'] }, preItems: [{ at: 'E6', dimension: 'observable', level: 'block' }] });
  assert.ok(!post2.some(i => i.dimension === 'escape' && i.level !== 'ok'), '事前提过了就不算漏网');
});
