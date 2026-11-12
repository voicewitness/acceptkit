// 命令清单、--json 返回与 read（docs/design/003-changes.md E）：清单和真实命令对得上；加 --json 时 stdout 只有一份 JSON ——
// 被改动的那张卡片，批量命令一项一个结果，整条拒收是 {"refused"} 且退出码非 0；长内容用 read 分页取。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { COMMANDS, defProblems, argvParts, findDef } from '../core/protocol.mjs';
import { startServer } from '../core/server.mjs';

const BIN = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'bin', 'acceptkit.mjs');
const ak = (dir, ...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, ACCEPTKIT_PROJECT: dir, HOME: dir } });
const json = (dir, ...args) => { const r = ak(dir, ...args, '--json'); return { status: r.status, body: JSON.parse(r.stdout), stderr: r.stderr }; };

const CASE = {
  case: 'c1', title: '示例', platform: 'web', classifications: { carrier: ['web'] },
  tree: [{ op: '读产物', tags: { carrier: 'web' }, expect: [
    { id: 'E1', assert: '产物里 ok 为 true', observe: { op: 'read-json', params: { file: 'evidence/out.json' }, checks: [{ pick: 'ok', predicate: { eq: true } }] } },
    { id: 'E2', assert: '人看的那条' },
  ] }],
};
const OPS = { ops: { 'read-json': { kind: 'observe', title: '读产物', platforms: { web: { exec: 'json-file', strength: 'S2' } } } } };
function project() {
  const dir = mkdtempSync(join(tmpdir(), 'acceptkit-test-'));
  for (const d of ['cases', 'runs', 'state/plans', 'knowledge', 'ops']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'acceptkit.project.json'), JSON.stringify({ name: 't', gate: { allow: [] } }));
  writeFileSync(join(dir, 'cases', 'c1.case.json'), JSON.stringify(CASE));
  writeFileSync(join(dir, 'ops', 'registry.json'), JSON.stringify(OPS));
  writeFileSync(join(dir, 'state', 'plans', 'D1.json'), JSON.stringify({ demand: 'D1', title: '测', platform: 'web', revision: 1,
    surfaces: [{ id: 'S1', change: 'x', reuse: ['c1'], new: [], ops: [] }], not_covered: [], history: [],
    approved_by: 'tester', approved_at: new Date().toISOString(), created_at: new Date().toISOString() }));
  const r = ak(dir, 'run', 'c1', '--demand', 'D1');
  assert.equal(r.status, 0, r.stderr);
  const run = readdirSync(join(dir, 'runs'))[0];
  mkdirSync(join(dir, 'runs', run, 'evidence'), { recursive: true });
  writeFileSync(join(dir, 'runs', run, 'evidence', 'out.json'), JSON.stringify({ ok: true }));
  writeFileSync(join(dir, 'runs', run, 'evidence', 'page.txt'), '页面上写着：已保存');
  // 测试里不碰浏览器：放一张带工具记录的过程截图，当作 shot 截的（记 pass 要求运行里有 app 截图）
  mkdirSync(join(dir, 'runs', run, 'shots'), { recursive: true });
  writeFileSync(join(dir, 'runs', run, 'shots', 'app-01-home.png'), Buffer.alloc(512, 1));
  writeFileSync(join(dir, 'runs', run, 'shots', 'app-01-home.json'), JSON.stringify({ kind: 'process_shot', platform: 'web', at: '2026-01-01T00:00:00Z' }));
  return { dir, run };
}

test('清单自洽：argv 里的参数都在 input_schema 里，反过来也是；名字各家工具都收', () => {
  for (const d of COMMANDS) assert.deepEqual(defProblems(d), [], d.name);
  assert.equal(new Set(COMMANDS.map(d => d.name)).size, COMMANDS.length);
  for (const name of ['next', 'device_acquire', 'device_reject', 'shot', 'observe', 'record', 'reviewq', 'report', 'plan_finding', 'blockers', 'read'])
    assert.ok(COMMANDS.some(d => d.name === name), name);
  // 命令行 → 定义：子命令、record 的两种写法
  assert.equal(findDef('device', ['acquire'], {}).name, 'device_acquire');
  assert.equal(findDef('device', ['status'], {}), null);
  assert.equal(findDef('record', ['R'], { step: 'n1' }).name, 'record_step');
  assert.equal(findDef('record', ['R'], { expect: 'E1' }).name, 'record');
  assert.deepEqual(argvParts(COMMANDS.find(d => d.name === 'device_reject')).positionals, ['device']);
  // 不在项目里也能读清单：执行者开工前就要知道有哪些命令
  const nowhere = mkdtempSync(join(tmpdir(), 'acceptkit-none-'));
  const r = spawnSync(process.execPath, [BIN, 'protocol', '--json'], { cwd: nowhere, encoding: 'utf8', env: { ...process.env, ACCEPTKIT_PROJECT: '', HOME: nowhere } });
  assert.equal(r.status, 0, r.stderr);
  const m = JSON.parse(r.stdout);
  assert.ok(m.commands.every(c => c.name && c.description && c.input_schema && c.argv && c.returns && !('select' in c)));
});

test('参数按各自的定义查：清单外的参数拒收，--json 时是 {"refused"} 且退出码非 0', () => {
  const { dir, run } = project();
  const human = ak(dir, 'record', run, '--expect', 'E2', '--status', 'pass', '--step-note', 'x');
  assert.notEqual(human.status, 0);
  assert.match(human.stderr, /不认识这些参数：--step-note/);
  assert.match(human.stderr, /acceptkit record \{run\} --expect/, '拒收时给出这条命令的用法');
  const j = json(dir, 'shot', run, '--expect', 'E1');
  assert.notEqual(j.status, 0);
  assert.match(j.body.refused, /不认识这些参数：--expect/);
  // 不在清单里的命令照旧走全局白名单
  assert.match(ak(dir, 'apparatus', run, '--bogus', 'x').stderr, /不认识这些参数/);
});

test('record --json 返回断言卡片；被拒时 stdout 只有 {"refused"}', () => {
  const { dir, run } = project();
  const ok = json(dir, 'record', run, '--expect', 'E2', '--status', 'pass', '--evidence', 'evidence/page.txt', '--quote', '已保存', '--actual', '页面写着已保存');
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.body.kind, 'expect');
  assert.equal(ok.body.expect, 'E2');
  assert.equal(ok.body.status, 'pass');
  assert.deepEqual(ok.body.evidence, ['evidence/page.txt']);
  assert.equal(ok.body.reviews['evidence/page.txt'], 'pending');
  assert.match(ok.body.note, /reviewq --pack --run/);
  assert.equal(ok.body.read, `run/${run}/E2`);
  assert.match(ok.stderr, /E2 = pass/, '人话挪到 stderr');

  const bad = ak(dir, 'record', run, '--expect', 'E2', '--status', 'pass', '--evidence', 'evidence/page.txt', '--quote', '页面上没有这句', '--json');
  assert.notEqual(bad.status, 0);
  const body = JSON.parse(bad.stdout);
  assert.deepEqual(Object.keys(body), ['refused']);
  assert.match(body.refused, /拒绝写入 E2/);
  assert.equal(JSON.parse(ak(dir, 'record', run, '--expect', 'E9', '--status', 'pass', '--json').stdout).refused.includes('E9'), true);
});

test('observe 多条：一条一个结果，被拒的项带 refused，其余照常写回', () => {
  const { dir, run } = project();
  const j = json(dir, 'observe', run, '--expect', 'E1', '--expect', 'E2');
  assert.equal(j.status, 0, j.stderr);
  const [e1, e2] = j.body.results;
  assert.equal(e1.kind, 'expect'); assert.equal(e1.status, 'pass');
  assert.equal(e2.expect, 'E2'); assert.match(e2.refused, /没有 observe 规格/);
});

test('reviewq --apply --json：每行一个结果，坏行带 refused', () => {
  const { dir, run } = project();
  assert.equal(ak(dir, 'record', run, '--expect', 'E2', '--status', 'pass', '--evidence', 'evidence/page.txt', '--quote', '已保存').status, 0);
  const pack = json(dir, 'reviewq', '--pack', '--run', run);
  assert.equal(pack.body.kind, 'review_pack');
  assert.equal(pack.body.count, 1);
  const f = join(dir, 'verdicts.jsonl');
  writeFileSync(f, [JSON.stringify({ run, key: 'E2::evidence/page.txt', verdict: 'ok', note: '看了包' }), '不是 JSON'].join('\n') + '\n');
  const ap = json(dir, 'reviewq', '--apply', f, '--by', 'blind');
  const [good, broken] = ap.body.results;
  assert.equal(good.kind, 'expect'); assert.equal(good.reviews['evidence/page.txt'], 'ok');
  assert.equal(broken.line, 2); assert.match(broken.refused, /不是 JSON/);
});

test('plan finding / blockers --json 返回被改动的那张卡片', () => {
  const { dir, run } = project();
  const GOOD = ['--what', '保存后提示语没出现', '--kind', 'product_bug', '--impact', '所有保存操作的用户', '--why', '提示语只在第一次保存时出现',
    '--option', '修 => 每次都提示', '--option', '不处理 => 用户不知道存没存上', '--recommend', '修', '--decide', '要不要每次都提示？'];
  const f = json(dir, 'plan', 'finding', 'D1', ...GOOD);
  assert.equal(f.status, 0, f.stderr);
  assert.equal(f.body.kind, 'finding'); assert.equal(f.body.finding, 'F1'); assert.equal(f.body.status, 'pending');
  assert.match(f.body.question, /每次都提示/);

  const b = ak(dir, 'record', run, '--expect', 'E2', '--status', 'blocked', '--blocked-kind', 'dependency', '--actual', '后端没部署', '--unlock', '等后端部署');
  assert.equal(b.status, 0, b.stderr);
  json(dir, 'blockers', 'D1', '--set', 'B1', '--ask', '测试环境什么时候能恢复，要不要先跳过？', '--why-you', '环境归测试平台组管，我没有权限', '--option', '等恢复再测 => 晚一天出结论', '--option', '本轮跳过 => 报告里写明没测', '--recommend', '等恢复：只差一天');
  const raised = json(dir, 'blockers', 'D1', '--raise');
  assert.equal(raised.body.results.length, 1);
  assert.equal(raised.body.results[0].status, 'raised');
  assert.match(raised.body.message, /测试环境什么时候能恢复[\s\S]*1\. 等恢复再测 => 晚一天出结论[\s\S]*我推荐：等恢复/, '交给用户的是问题、选项和推荐，不是解锁条件');
  assert.match(ak(dir, 'blockers', 'D1', '--ack', 'B1', '--answer', '明天部署').stderr, /缺 --by/, '不写谁答的不收');
  assert.match(ak(dir, 'blockers', 'D1', '--ack', 'B1', '--answer', '明天部署', '--by', 'agent').stderr, /执行者自己/);
  const ack = json(dir, 'blockers', 'D1', '--ack', 'B1', '--answer', '明天部署', '--by', 'owner');
  assert.equal(ack.body.kind, 'blocker'); assert.equal(ack.body.status, 'answered'); assert.equal(ack.body.answer, '明天部署');
});

test('看板上答阻塞：/decide 收 ack，不要求 finding 编号，答复落到阻塞项上', async () => {
  const { dir, run } = project();
  assert.equal(ak(dir, 'record', run, '--expect', 'E2', '--status', 'blocked', '--blocked-kind', 'dependency', '--actual', '后端没部署', '--unlock', '等后端部署').status, 0);
  json(dir, 'blockers', 'D1', '--set', 'B1', '--ask', '测试环境什么时候能恢复，要不要先跳过？', '--why-you', '环境归测试平台组管，我没有权限', '--option', '等恢复再测 => 晚一天出结论', '--option', '本轮跳过 => 报告里写明没测', '--recommend', '等恢复：只差一天');
  const { server, url } = await startServer({ roots: [dir], port: 0 });
  try {
    const id = (await (await fetch(url + '/healthz')).json()).projects[0].id;
    const post = (body, headers = {}) => fetch(`${url}/p/${id}/decide`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url, ...headers }, body: JSON.stringify(body) });
    const body = { action: 'ack', demand: 'D1', blockers: ['B1'], note: '--选 等恢复再测' };
    // 只带 Origin 的请求（命令行伪造）不收：没打开过看板页就没有凭据
    assert.equal((await post(body)).status, 403, '没有页面发的凭据');
    const page = await fetch(`${url}/p/${id}/`);
    const cookie = (page.headers.get('set-cookie') || '').split(';')[0];
    assert.match(cookie, /^ak_decide=[0-9a-f]{48}$/);
    assert.match(page.headers.get('set-cookie'), /HttpOnly/i); assert.match(page.headers.get('set-cookie'), /SameSite=Strict/i);
    assert.equal(page.headers.get('x-frame-options'), 'DENY', '不许被别的页面嵌');
    // 证据目录里的符号链接指到项目外（或项目配置）：不出
    const { symlinkSync } = await import('node:fs');
    symlinkSync(join(dir, 'acceptkit.project.json'), join(dir, 'runs', run, 'evidence', 'leak.json'));
    assert.equal((await fetch(`${url}/p/${id}/evidence?f=runs/${run}/evidence/leak.json`)).status, 400, '符号链接逃出证据目录');
    assert.equal((await post(body, { cookie: 'ak_decide=' + '0'.repeat(48) })).status, 403, '凭据不对');
    // DNS 重绑定：别的域名解析到本机，Origin 和 Host 对得上也不收
    const { request } = await import('node:http');
    const rebinding = await new Promise(done => { const rq = request(`${url}/p/${id}/decide`, { method: 'POST', headers: { host: 'evil.example:80', origin: 'http://evil.example:80', 'content-type': 'application/json', cookie } }, rs => done(rs.statusCode)); rq.end(JSON.stringify(body)); });
    assert.equal(rebinding, 421);
    const r = await post(body, { cookie });
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.match(ak(dir, 'blockers', 'D1').stdout, /--选 等恢复再测/, '以 -- 开头的原话原样落到阻塞项上');
  } finally { server.close(); }
});

test('read：文本按字符分页、列表按项分页，越界和逃出运行目录的路径拒收', () => {
  const { dir, run } = project();
  writeFileSync(join(dir, 'runs', run, 'evidence', 'long.txt'), 'x'.repeat(9000));
  const p1 = json(dir, 'read', `run/${run}/file/evidence/long.txt`, '--limit', '100');
  assert.equal(p1.body.type, 'text');
  assert.equal(p1.body.total, 9000);
  assert.equal(p1.body.text.length, 100);
  assert.equal(p1.body.next_offset, 100);
  const big = json(dir, 'read', `run/${run}/file/evidence/long.txt`, '--offset', '1000', '--limit', '99999').body;
  assert.equal(big.limit, 8000, '一页最多 8000 字');
  assert.equal(big.next_offset, null);
  assert.equal(json(dir, 'read', `run/${run}/file/evidence/long.txt`).body.limit, 4000);

  const list = json(dir, 'read', `run/${run}`, '--limit', '1').body;
  assert.equal(list.type, 'list');
  assert.equal(list.total, 3);   // 两条断言 + 一个节点
  assert.equal(list.items[0].expect, 'E1');
  assert.equal(list.next_offset, 1);
  assert.equal(list.meta.case, 'c1');

  assert.match(json(dir, 'read', `run/${run}/E1`).body.text, /产物里 ok 为 true/);
  assert.match(json(dir, 'read', 'case/c1#n1').body.text, /读产物/);
  assert.match(json(dir, 'read', 'plan/D1').body.text, /"demand": "D1"/);
  assert.match(json(dir, 'read', `run/${run}/file/evidence`).body.items.map(x => x.name).join(' '), /long\.txt/);

  const esc = json(dir, 'read', `run/${run}/file/../../acceptkit.project.json`);
  assert.notEqual(esc.status, 0); assert.match(esc.body.refused, /不在运行/);
  assert.match(json(dir, 'read', 'nothing/here').body.refused, /资源名/);
  // 人话模式：正文到 stdout，翻页提示到 stderr
  const h = ak(dir, 'read', `run/${run}/file/evidence/long.txt`, '--limit', '10');
  assert.equal(h.stdout.trim(), 'x'.repeat(10));
  assert.match(h.stderr, /--offset 10/);
});
