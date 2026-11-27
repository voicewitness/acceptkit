// 还没跑过的需求：评审单和要 owner 定的事在看板上看得见、link 能直达。
// 以前侧栏只按运行建面板，一次没跑的需求没有面板，它的 finding 也进不了「等你定」，link 还说它「不是需求」
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveLink } from '../core/links.mjs';

const BIN = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'bin', 'acceptkit.mjs');
const DASH = join(dirname(BIN), '..', 'core', 'dashboard.mjs');

test('没跑过的评审单：侧栏单列、有自己的面板、finding 进等你定、link 落到它', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acceptkit-test-'));
  for (const d of ['cases', 'runs', 'state/plans', 'knowledge', 'ops']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'acceptkit.project.json'), JSON.stringify({ name: 't', gate: { allow: [] } }));
  writeFileSync(join(dir, 'cases', 'c1.case.json'), JSON.stringify({ case: 'c1', title: '首页问候语', platform: 'web', classifications: { carrier: ['page'] },
    tree: [{ op: '打开「首页」', tags: { carrier: 'page' }, shows: ['你好'], expect: [{ id: 'E1', assert: '页面顶部显示「你好」' }] }] }));
  const ak = (...a) => { const r = spawnSync(process.execPath, [BIN, ...a], { cwd: dir, encoding: 'utf8', env: { ...process.env, ACCEPTKIT_PROJECT: dir, HOME: dir } }); assert.equal(r.status, 0, a.join(' ') + '\n' + r.stderr); return r; };
  ak('plan', 'new', 'D1', '--title', '首页问候', '--platform', 'web');
  ak('plan', 'add-case', 'D1', '--surface', 'S1', '--change', '首页加了问候语', '--reuse', 'c1', '--risk', '看不到问候', '--uncovered', '其他页');
  ak('plan', 'finding', 'D1', '--what', '问候语要不要跟着系统语言变', '--kind', 'spec_unclear', '--impact', '只影响首页问候语这一处',
    '--why', '需求文档没写多语言', '--option', '跟着变 => 要补多语言用例', '--option', '固定中文 => 不用补', '--recommend', '固定中文：需求只提了中文', '--decide', '问候语跟不跟系统语言？');

  assert.equal(resolveLink(dir, "D1").key, "D1", "需求只有一个地址");
  const out = join(dir, "board.html");
  const render = () => { const b = spawnSync(process.execPath, [DASH, out], { cwd: dir, encoding: "utf8", env: { ...process.env, ACCEPTKIT_PROJECT: dir, HOME: dir } }); assert.equal(b.status, 0, b.stderr); return readFileSync(out, "utf8"); };
  const html = render();
  assert.match(html, /<div class="navsec">需求<\/div><details class="dgrp" open data-did="D1" data-latest="D1">[\s\S]*首页问候[\s\S]*等你 2 件/, "侧栏一个需求一行，写着等你几件");
  const page = html.slice(html.indexOf("<section class=\"panel\" data-k=\"D1\""));
  assert.match(page, /等你 · 2 件[\s\S]*同不同意把 1 条用例加进这次验收[\s\S]*定一件事：[\s\S]{0,20}问候语跟不跟系统语言/, "最上面是等你做的事");
  assert.match(page, /用例与执行[\s\S]*已执行[\s\S]*首页加了问候语[\s\S]*首页问候语/, "下面按改动面列用例");
  assert.match(html, /等你定 1 条/, "finding 也进等你定横幅");
  // 开跑之后：还是同一个地址；批准记录摆出来（谁批的、原话），旧的 plan:D1 链接也落到这里
  ak("plan", "approve", "D1", "--by", "owner", "--quote", "可以");
  ak("run", "c1", "--demand", "D1");
  assert.equal(resolveLink(dir, "D1").key, "D1");
  const h2 = render(), p2 = h2.slice(h2.indexOf("<section class=\"panel\" data-k=\"D1\""));
  assert.match(p2, /批准记录[\s\S]*owner[\s\S]*记下的原话「可以」/);
  assert.match(h2, /"plan:D1":"D1"/);
  assert.match(h2, /data-k="round:D1:[^"]+"/, "轮次挂在需求下面当历史");
});
