// 从历史用例提操作集：同样的操作只留一份；文字就是操作名的挂上那个操作；父子常连着的提成组合操作（嵌套引用）；模板 / 构造输入 / 说不清的不提
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractOps } from '../core/op-extract.mjs';
import { expandHuman } from '../core/clarity.mjs';

const C = (name, tree) => ({ case: name, platform: 'android', tree });
test('同样的步骤只提一份；操作库已有同标题的复用；文字是操作名的直接挂；父子常连着的提成组合操作', () => {
  const ops = { 'open-settings': { title: '进入「设置」页', human: ['进入「设置」页'] }, 'km-login': { title: 'KM 登录', human: ['用 km 账号登录'] } };
  const cases = [
    C('a', [{ op: '进入「设置」页', children: [{ op: '点击「隐私」', expect: [] }] }, { op: 'km-login' }]),
    C('b', [{ op: '进入 「设置」 页', children: [{ op: '点击「隐私」' }] }, { op: '输入：{"做法": "单发", "context": {}}' }, { op: '输入{"需满足的 CEL": ""}' }]),
    C('c', [{ op: '发一条会路由到策略的 trigger' }, { op: '发一条会路由到策略的 trigger' }]),
  ];
  const x = extractOps(cases, ops);
  const ids = x.leaves.map(l => l.id);
  assert.ok(ids.includes('open-settings'), '标题一样：复用已有操作');
  assert.ok(ids.includes('km-login'), '文字就是操作名：挂上');
  const tap = x.leaves.find(l => l.title === '点击「隐私」'); assert.ok(tap && !tap.existing && tap.at.length === 2, '新操作一份，两处');
  assert.equal(x.leaves.filter(l => l.title === '点击「隐私」').length, 1, '不重复');
  assert.equal(x.combos.length, 1); assert.equal(x.combos[0].a, 'open-settings'); assert.equal(x.combos[0].b, tap.id);
  assert.ok(x.skipped.literal >= 1 && x.skipped.template >= 1 && x.skipped.vague >= 2);
});
test('组合操作的人看步骤：层层展开被引用操作的；防环', () => {
  const ops = { a: { title: 'A', human: ['进入「设置」页'] }, b: { title: 'B', human: ['点击「隐私」'] },
    ab: { title: 'AB', platforms: { android: { steps: [{ use: 'a' }, { use: 'b' }] } } },
    top: { title: 'TOP', platforms: { android: { steps: [{ use: 'ab' }, { use: 'top' }] } } } };
  assert.deepEqual(expandHuman(ops, 'ab'), ['进入「设置」页', '点击「隐私」']);
  assert.deepEqual(expandHuman(ops, 'top'), ['进入「设置」页', '点击「隐私」']);
});
