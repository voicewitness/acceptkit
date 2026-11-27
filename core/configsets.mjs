// 配置集：一组用例跑之前被测端要处在什么配置下（开关、AB / 下发值、mock 的全局信号、账号、地区、包）。
// 有名字、能复用、点开看得到每一项 —— 以前这些写在步骤文字里（「档位：xxx=false 时冷启…」），人读不出哪些是配置、哪些是操作，
// 两组配置差在哪也只能逐字对。用例或某一支节点写 config: [<配置集>]，下面的步骤都在这份配置下跑。
//
// 每一项要说清是哪种：
//   mock  只 mock 全局信号（AB、开关、全局特征）—— 触发方式里算「只 mock 全局信号」，要写 why（为什么不用真值）
//   env   真实环境的选择（账号、地区、装哪个包）—— 不算 mock
// 每项可写 apply：用哪个已登记操作把它施加上（例：AB 开关走配置页 mock、全局特征走特征 mock 页）—— mock 不再塞进步骤文字，步骤只留触发动作
// 存在项目目录 ops/configs.json（项目数据，不进 acceptkit 目录）。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const ITEM_KINDS = { mock: '只 mock 全局信号', env: '真实环境的选择' };
const ID = /^[a-z0-9][a-z0-9-]*$/;
const path = root => join(root, 'ops', 'configs.json');
export const loadConfigSets = root => { try { return JSON.parse(readFileSync(path(root), 'utf8')).configs || {}; } catch { return {}; } };

export function configSetProblems(id, s) {
  const out = [];
  if (!ID.test(id)) out.push('id 只能用小写字母、数字、连字符');
  if (!String(s.title || '').trim()) out.push('缺 title（这份配置是什么场景，一句话）');
  if (!(s.items || []).length) out.push('一项都没有');
  for (const it of s.items || []) {
    if (!it.key) out.push('每项要写 key');
    if (!ITEM_KINDS[it.kind]) out.push(`「${it.key}」的 kind 只能是 ${Object.keys(ITEM_KINDS).join(' / ')}`);
    if (it.kind === 'mock' && !String(it.why || '').trim()) out.push(`「${it.key}」是 mock 的全局信号，要写 why（为什么不用真值）`);
  }
  return out;
}

/** 新增 / 改一份配置集：items 按 key 合并（同 key 覆盖），写完必须没有问题才落盘 */
export function writeConfigSet(root, id, { title, items = [], replace = false }) {
  const all = loadConfigSets(root), cur = replace ? { items: [] } : (all[id] || { items: [] });
  const merged = new Map((cur.items || []).map(x => [x.key, x]));
  for (const it of items) merged.set(it.key, { ...merged.get(it.key), ...it });
  const next = { title: title || cur.title || '', items: [...merged.values()] };
  const bad = configSetProblems(id, next);
  if (bad.length) throw new Error(`配置集 ${id} 有问题，没写入：\n   · ${bad.join('\n   · ')}`);
  all[id] = next;
  mkdirSync(join(root, 'ops'), { recursive: true });
  writeFileSync(path(root), JSON.stringify({ _why: '配置集：一组用例跑之前被测端要处在什么配置下。用例 / 节点写 config: [id] 引用', configs: all }, null, 2) + '\n');
  return next;
}

/** 一个节点生效的配置：从用例到这一步，沿路的 config 合起来（后写的同 key 覆盖前面的） */
export function effectiveConfig(sets, chainConfigs) {
  const m = new Map(), from = [];
  for (const ids of chainConfigs) for (const id of [].concat(ids || [])) { const s = sets[id]; if (!s) continue; from.push(id); for (const it of s.items || []) m.set(it.key, { ...it, set: id }); }
  return { from, items: [...m.values()] };
}

/** 沿链生效的配置集 id：用例级 → 祖先 → 本节点，按顺序加 config、去掉 config_unset（例：正反两臂里后一步撤掉前一步的 mock）*/
export function chainConfigIds(caseConfig, nodes) {
  const out = [];
  for (const ids of [[].concat(caseConfig || []), ...nodes.map(n => ({ add: [].concat(n.config || []), rm: [].concat(n.config_unset || []) }))]) {
    if (Array.isArray(ids)) { for (const id of ids) if (!out.includes(id)) out.push(id); continue; }
    for (const id of ids.rm) { const i = out.indexOf(id); if (i >= 0) out.splice(i, 1); }
    for (const id of ids.add) if (!out.includes(id)) out.push(id);
  }
  return out;
}
/** 两份配置差在哪：只列不同的项（看两组用例为什么结果不一样，先看这个） */
export function configDiff(a, b) {
  const A = new Map(a.items.map(x => [x.key, x])), B = new Map(b.items.map(x => [x.key, x]));
  return [...new Set([...A.keys(), ...B.keys()])].filter(k => String(A.get(k)?.value) !== String(B.get(k)?.value))
    .map(k => ({ key: k, a: A.get(k)?.value, b: B.get(k)?.value }));
}
export const configSetsExist = root => existsSync(path(root));
