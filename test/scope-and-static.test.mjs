// 适用范围按版本线判、评审单记被测包、纯静态用例不要截图、pick 取到对象时不静默判错
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { judge, parseBuild, validateScope } from '../core/version-scope.mjs';
import { assessCasePre } from '../core/assess.mjs';
import { staticOnlyCase } from '../core/evidence-gate.mjs';
// <组件>@<版本> 拼出来写：字面量长得像邮箱，泄漏扫描会报
const at = (c, v) => [c, v].join('@');

test('组件名照包管理器写（带连字符、group:artifact）；两条线共用版本号时按版本线判', () => {
  const sc = { component: 'engine-core', below: '0.0.3-alpha.70', line: 'remove-legacy', why: '老链从这一版起删了' };
  assert.deepEqual(validateScope(sc, 'x'), []);
  assert.deepEqual(validateScope({ ...sc, component: 'com.example:engine-core' }, 'x'), []);
  assert.equal(judge(sc, parseBuild(at('engine-core', '0.0.3-alpha.71#remove-legacy'))).state, 'na');
  assert.equal(judge(sc, parseBuild(at('engine-core', '0.0.3-alpha.71#upstream'))).state, 'applies', '上游后发的版本还带着老链');
  assert.equal(judge(sc, parseBuild(at('engine-core', '0.0.3-alpha.71'))).state, 'unknown', '没记版本线判不出，不当成不适用');
  assert.equal(judge({ component: 'engine-core', below: '0.0.3-alpha.70', why: 'w' }, parseBuild(at('engine-core', '0.0.3-alpha.71'))).state, 'na');
  assert.throws(() => parseBuild(at('engine core', '1.0')), /不合法/);
});

test('评审单记了被测包：不适用的断言不进事前评价', () => {
  const c = { case: 'c', title: 't', platform: 'android', tree: [
    { op: '老链', applies: { component: 'core', below: '2.0.0', why: '老链删了' }, expect: [{ id: 'E1', assert: '老链跑了' }] },
    { op: '新链', expect: [{ id: 'E2', assert: '新链跑了' }] }] };
  const findings = [{ rule: 'Q01', level: 'block', title: '要判定方式', at: 'E1', msg: 'm' }, { rule: 'Q01', level: 'block', title: '要判定方式', at: 'E2', msg: 'm' }];
  const blocks = items => items.filter(i => i.level === 'block').map(i => i.at);
  assert.deepEqual(blocks(assessCasePre(c, { findings })), ['E1', 'E2']);
  const items = assessCasePre(c, { findings, build: parseBuild(at('core', '2.1.0')) });
  assert.deepEqual(blocks(items), ['E2']);
  assert.ok(items.some(i => i.rule === 'NA' && /E1/.test(i.finding)));
});

test('纯静态用例：每个节点都是 carrier=static 才算', () => {
  assert.equal(staticOnlyCase({ classifications: { carrier: ['static'] }, tree: [{ op: 'grep', tags: { carrier: 'static' } }] }), true);
  assert.equal(staticOnlyCase({ tree: [{ op: 'grep', tags: { carrier: 'static' } }, { op: '点', tags: { carrier: 'app' } }] }), false);
  assert.equal(staticOnlyCase({ tree: [{ op: '没标' }] }), false, '没标 carrier 的不豁免');
});

const BIN = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'bin', 'acceptkit.mjs');
const ak = (dir, ...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, ACCEPTKIT_PROJECT: dir, HOME: dir } });
function project(caseObj, out) {
  const dir = mkdtempSync(join(tmpdir(), 'acceptkit-static-'));
  for (const d of ['cases', 'runs', 'state/plans', 'knowledge', 'ops']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'acceptkit.project.json'), JSON.stringify({ name: 't', gate: { allow: [] } }));
  writeFileSync(join(dir, 'cases', 'c1.case.json'), JSON.stringify(caseObj));
  writeFileSync(join(dir, 'ops', 'registry.json'), JSON.stringify({ ops: { 'read-json': { kind: 'observe', title: '读', why: 'w', observes: 'source', platforms: { android: { exec: 'json-file', strength: 'S2', state: 'confirmed' } } } } }));
  writeFileSync(join(dir, 'state', 'plans', 'D1.json'), JSON.stringify({ demand: 'D1', title: '测', platform: 'android', revision: 1,
    surfaces: [{ id: 'S1', change: 'x', reuse: ['c1'], new: [], ops: [] }], not_covered: [], history: [],
    approved_by: 'tester', approved_at: new Date().toISOString(), created_at: new Date().toISOString() }));
  { const x = ak(dir, 'run', 'c1', '--demand', 'D1'); assert.equal(x.status, 0, x.stderr); }
  const run = readdirSync(join(dir, 'runs'))[0];
  mkdirSync(join(dir, 'runs', run, 'evidence'), { recursive: true });
  writeFileSync(join(dir, 'runs', run, 'evidence', 'out.json'), JSON.stringify(out));
  return { dir, run };
}
const staticCase = check => ({ case: 'c1', title: '读源码', platform: 'android', classifications: { carrier: ['static'] },
  tree: [{ op: '在源码里找', tags: { carrier: 'static' }, expect: [{ id: 'E1', assert: '源码里有这个调用', via: 'cli', why_not_ui: '源码没有界面',
    observe: { op: 'read-json', params: { file: 'evidence/out.json' }, checks: [check] } }] }] });

test('纯静态用例：没有 app 截图也记得上结论', () => {
  const { dir, run } = project(staticCase({ pick: 'hit', predicate: { any_match: 'Foo' } }), { hit: ['Foo.kt:12'] });
  const o = ak(dir, 'observe', run);
  assert.equal(o.status, 0, o.stdout + o.stderr);
  assert.equal(JSON.parse(readFileSync(join(dir, 'runs', run, 'result.json'), 'utf8')).results.E1.status, 'pass');
});

test('pick 取到对象：不静默判不成立，不记，点名改法', () => {
  const { dir, run } = project(staticCase({ pick: 'hit', predicate: { any_match: 'Foo' } }), { hit: { _: ['Foo.kt:12'] } });
  const o = ak(dir, 'observe', run);
  assert.notEqual(o.status, 0);
  assert.match(o.stdout, /取到的是对象（键：_）.*hit\._/);
  assert.equal(JSON.parse(readFileSync(join(dir, 'runs', run, 'result.json'), 'utf8')).results?.E1?.status || 'todo', 'todo');
});

test('记 na：组件名带连字符、按版本线限定的范围也记得上（--since 自动按用例补）', () => {
  const c = { case: 'c1', title: '老链', platform: 'android', classifications: { carrier: ['app'] },
    tree: [{ op: '老链这一支', tags: { carrier: 'app' }, applies: { component: 'engine-core', below: '0.0.3-alpha.70', line: 'remove-legacy', why: '老链删了' },
      expect: [{ id: 'E1', assert: '老链跑了', judge: 'human', human_why: '示例' }] }] };
  const { dir, run } = project(c, {});
  const x = ak(dir, 'record', run, '--expect', 'E1', '--status', 'na', '--build', at('engine-core', '0.0.3-alpha.71#remove-legacy'), '--actual', '老链从这一版起删了');
  assert.equal(x.status, 0, x.stderr);
  const v = JSON.parse(readFileSync(join(dir, 'runs', run, 'result.json'), 'utf8')).results.E1;
  assert.equal(v.status, 'na'); assert.deepEqual(v.na_since, { component: 'engine-core', version: '0.0.3-alpha.70', line: 'remove-legacy' });
  // 同一个运行换成上游那条线的包：一个运行只对应一个包
  const y = ak(dir, 'record', run, '--expect', 'E1', '--status', 'na', '--build', at('engine-core', '0.0.3-alpha.71#upstream'), '--actual', 'x');
  assert.notEqual(y.status, 0); assert.match(y.stderr, /一个 run 只对应一个包/);
});

test('调试浏览器的用户目录不放 /tmp；用户偏好的模板优先；同一端口落回同一目录', async () => {
  const { stableProfile } = await import('../adapters/web/cdp.mjs');
  const { homedir } = await import('node:os');
  assert.equal(stableProfile(9333, '/tmp/fe-deploy-chrome-9333'), join(homedir(), '.config', 'acceptkit', 'browser-profiles', '9333'));
  assert.equal(stableProfile(9333, '/private/tmp/x'), join(homedir(), '.config', 'acceptkit', 'browser-profiles', '9333'));
  assert.equal(stableProfile(9333, '/work/proj/.acceptkit/browser-9333'), '/work/proj/.acceptkit/browser-9333');
  assert.equal(stableProfile(9333, '/tmp/x', '~/.local/share/my-chrome-{port}'), join(homedir(), '.local/share/my-chrome-9333'));
});
