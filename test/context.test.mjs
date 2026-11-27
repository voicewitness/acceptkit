// context：执行到某个节点时，一次拿到这一步需要的经验（docs/002-protocol.md 第四节，docs/design/003 F）。
// 小项目带操作库、知识和一次失败历史，断言返回的各段都在；不碰设备和浏览器（web 用例，只读记录）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'bin', 'acceptkit.mjs');
const ak = (dir, ...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, ACCEPTKIT_PROJECT: dir, HOME: dir } });
const ok = (dir, ...args) => { const r = ak(dir, ...args); assert.equal(r.status, 0, `${args.join(' ')}\n${r.stderr}`); return r; };

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'acceptkit-test-'));
  for (const d of ['cases', 'runs', 'state/plans', 'knowledge', 'ops']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'acceptkit.project.json'), JSON.stringify({ name: 't', gate: { allow: [] } }));
  writeFileSync(join(dir, 'ops', 'registry.json'), JSON.stringify({ ops: {
    'open-settings': { title: '打开设置页', why: '多条用例从设置页开始', pitfalls: ['首次打开会弹引导层'],
      platforms: {
        web: { how: '点右上角头像，再点「设置」', steps: ['点头像', '点设置'], state: 'confirmed', source: '实测' },
        ios: { how: '点「我的」再点齿轮', state: 'guess', source: '推测' },
      } },
  } }));
  writeFileSync(join(dir, 'cases', 'c1.case.json'), JSON.stringify({ case: 'c1', title: '设置页退出登录', platform: 'web',
    classifications: { carrier: ['page'] },
    tree: [
      { op: '打开「设置」页', op_id: 'open-settings', tags: { carrier: 'page' }, shows: ['退出登录'],
        expect: [{ id: 'E1', assert: '设置页上有「退出登录」按钮' }],
        children: [{ op: '点击「退出登录」', tags: { carrier: 'page' }, danger: { kind: 'logout', confirm: 'owner' },
          expect: [{ id: 'E2', assert: '回到登录页' }] }] },
    ] }));
  writeFileSync(join(dir, 'knowledge', 'notes.md'), [
    '# 笔记', '',
    '- open-settings 在窄窗口下头像会收进菜单 #已验证',
    '- 设置页加载慢，等两秒再截 #已确认',
    '- 设置页在 iOS 上要先登录 #ios',
    '- 测试账号密码：hunter2-secret-value #secret #account #page',
    '- 和这一步无关的一条：报表导出格式',
    '',
  ].join('\n'));
  return dir;
}
const runs = dir => readdirSync(join(dir, 'runs')).sort();
const runAt = (dir, id) => join(dir, 'runs', id, 'result.json');

test('context：做法、shows、danger、知识、遮蔽层、以往失败 / 故障 / 驳回、截图做法都在', () => {
  const dir = project();
  ok(dir, 'plan', 'new', 'D1', '--title', '退出登录', '--platform', 'web');
  ok(dir, 'plan', 'add-case', 'D1', '--surface', 'S1', '--change', '设置页加了退出登录', '--reuse', 'c1', '--risk', '退不出去', '--uncovered', '其他页');
  ok(dir, 'plan', 'approve', 'D1', '--by', 'owner', '--quote', '可以');
  ok(dir, 'run', 'c1', '--demand', 'D1');
  const [old] = runs(dir);
  // 以往那次运行：E1 失败、n1 上一次取证手段故障、一次盲审驳回（直接写记录，不碰浏览器）
  const r = JSON.parse(readFileSync(runAt(dir, old), 'utf8'));
  r.results.E1 = { status: 'fail', actual: '设置页上找不到退出登录' };
  r.apparatus = [{ id: 'A1', at: '2026-01-01T00:00:00Z', where: 'step:n1', text: '截到了上一页', fix: '等页面切换完再截', source: 'manual' }];
  r.reviews = { 'step:n1::shots/app-01.png': { state: 'irrelevant', note: '截的是首页，不是设置页', by: 'blind', at: '2026-01-02T00:00:00Z' },
                // 待审（重开 / 判定变了作废的旧复核）不是驳回，不算进以往情况
                'step:n1::shots/app-02.png': { state: 'pending', note: '', at: '2026-01-03T00:00:00Z' } };
  writeFileSync(runAt(dir, old), JSON.stringify(r));
  ok(dir, 'run', 'c1', '--demand', 'D1');
  const run = runs(dir).find(x => x !== old);

  const res = ok(dir, 'context', run, '--node', 'n1', '--json');
  const k = JSON.parse(res.stdout);
  assert.equal(k.kind, 'context');
  assert.equal(k.node, 'n1');
  assert.equal(k.platform, 'web');
  // 操作做法：本平台的配方带状态
  assert.equal(k.op.op_id, 'open-settings');
  assert.equal(k.op.recipes.length, 1);
  assert.equal(k.op.recipes[0].key, 'web');
  assert.equal(k.op.recipes[0].runnable, true);
  assert.match(k.op.recipes[0].state_label, /已确认/);
  assert.deepEqual(k.op.pitfalls, ['首次打开会弹引导层']);
  assert.deepEqual(k.shows, ['退出登录']);
  assert.equal(k.danger, null);
  // 知识：命中操作 id 的排第一；别的平台的不给；无关的不给；机密值遮蔽
  assert.ok(k.knowledge.length >= 2 && k.knowledge.length <= 8);
  assert.match(k.knowledge[0].text, /窄窗口/);
  assert.equal(k.knowledge[0].ref, 'notes.md:3');
  assert.equal(k.knowledge[0].state, 'verified');
  assert.ok(k.knowledge.some(e => /加载慢/.test(e.text)));
  assert.ok(!k.knowledge.some(e => /iOS/.test(e.text)), '标了别的平台的知识不给');
  assert.ok(!k.knowledge.some(e => /报表导出/.test(e.text)), '无关的知识不给');
  const sec = k.knowledge.find(e => e.secret);
  assert.ok(sec, '标签命中的机密条目也给，但值遮蔽');
  assert.ok(!res.stdout.includes('hunter2-secret-value'));
  // 遮蔽层：通用的那几类都在
  assert.ok(k.obscuring.some(o => /权限弹窗/.test(o.name) && o.how));
  // 以往运行：失败、故障、驳回都数到了
  assert.equal(k.history.runs, 1);
  assert.equal(k.history.fails, 1);
  assert.equal(k.history.apparatus, 1);
  assert.equal(k.history.rejections, 1);
  assert.match(k.history.rejection_samples[0].note, /不是设置页/);
  assert.match(k.history.apparatus_samples[0].fix, /页面切换/);
  // 截图做法与下一步
  assert.ok(k.shot.some(l => /acceptkit shot/.test(l)));
  assert.match(k.note, new RegExp(`shot ${run} --web --step n1`));
  assert.equal(k.read, `context/${run}/n1`);

  // 危险节点、没引用操作库的节点
  const k2 = JSON.parse(ok(dir, 'context', run, '--node', 'n1.1', '--json').stdout);
  assert.deepEqual(k2.danger, { kind: 'logout', confirm: 'owner' });
  assert.match(k2.detail.join(''), /危险动作/);
  assert.equal(k2.op.op_id, null);
  assert.match(k2.op.note, /没引用操作库/);
  assert.equal(k2.history.fails, 0);

  // 文本模式各段都打出来；read 给不截断的全文
  const txt = ok(dir, 'context', run, '--node', 'n1').stdout;
  for (const s of ['操作做法', '画面上应该出现：退出登录', '相关知识', '可能遇到的遮蔽层和关法', '以往运行（1 次）', '盲审驳回 1 次'])
    assert.ok(txt.includes(s), `文本模式缺「${s}」`);
  const page = JSON.parse(ok(dir, 'read', `context/${run}/n1`, '--json').stdout);
  assert.equal(page.type, 'text');
  assert.match(page.text, /open-settings/);
  assert.ok(!page.text.includes('hunter2-secret-value'));

  // next 的 step_todo 卡片指向 context
  const cards = JSON.parse(ok(dir, 'next', 'D1', '--json').stdout).cards;
  const st = cards.find(c => c.kind === 'step_todo' && c.node === 'n1');
  assert.match(st.note, new RegExp(`需要经验：acceptkit context ${run} --node n1`));
});

test('context：推测的配方标明不执行；节点不存在、缺 --node 时拒收是能照着改的话', () => {
  const dir = project();
  const cf = join(dir, 'cases', 'c1.case.json');
  const c = JSON.parse(readFileSync(cf, 'utf8')); c.platform = 'ios';
  writeFileSync(cf, JSON.stringify(c));
  ok(dir, 'plan', 'new', 'D1', '--title', '退出登录', '--platform', 'ios');
  ok(dir, 'plan', 'add-case', 'D1', '--surface', 'S1', '--change', '设置页加了退出登录', '--reuse', 'c1', '--risk', '退不出去', '--uncovered', '其他页');
  ok(dir, 'plan', 'approve', 'D1', '--by', 'owner', '--quote', '可以');
  ok(dir, 'run', 'c1', '--demand', 'D1');
  const [run] = runs(dir);
  const k = JSON.parse(ok(dir, 'context', run, '--node', 'n1', '--json').stdout);
  assert.equal(k.op.recipes[0].key, 'ios');
  assert.equal(k.op.recipes[0].runnable, false);
  assert.match(k.op.recipes[0].note, /推测：不执行[\s\S]*ops confirm open-settings --platform ios/);
  // iOS：标了 #ios 的知识这回给
  assert.ok(k.knowledge.some(e => /iOS/.test(e.text)));

  let r = ak(dir, 'context', run, '--node', 'n9', '--json');
  assert.notEqual(r.status, 0);
  assert.match(JSON.parse(r.stdout).refused, /没有节点 n9[\s\S]*steps c1/);
  r = ak(dir, 'context', run, '--json');
  assert.notEqual(r.status, 0);
  assert.match(JSON.parse(r.stdout).refused, /--node/);
  r = ak(dir, 'context', run, '--node', 'n1', '--expect', 'E1', '--json');
  assert.notEqual(r.status, 0);
  assert.match(JSON.parse(r.stdout).refused, /不认识这些参数：--expect/);
});
