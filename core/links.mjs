// 报告链接：用户要「报告地址」时，直接给一个打开就停在那份报告上的网址，不让人自己去看板里找。
//
// 看板的面板按键定位（dashboard.mjs 里 data-k，网址 hash 是 #run=<键>）：
//   一次运行（及它的报告） → 它所在的执行记录 session（有需求归属时），否则 case:<用例>
//   一个需求              → 最新一轮 round:<需求>:<轮次>；还没有轮次就是它最近一次运行的执行记录
//   一条用例              → case:<用例>
// 网址：缺省是 acceptkit 自己的管理页面（acceptkit serve，见 server.mjs）http://127.0.0.1:<端口>/p/<项目>/#run=<键>。
// 项目自己的看板（pack.dashboard）按运行 id 定位时，配置 dashboard.locateBy = "run"。
// 看板另外嵌在别的页面里、想给那个页面的地址时，配 dashboard.url 模板：
//   "dashboard.url": "http://localhost:8080/boards?p=acceptance&run={key}"
// {key} = 上面的面板键；{run} = 运行 id（给需求 / 用例时取它最近一次运行）。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadRounds } from './rounds.mjs';

const readJSON = f => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
const resultOf = (root, run) => readJSON(join(root, 'runs', run, 'result.json'));
const mtime = (root, run) => statSync(join(root, 'runs', run, 'result.json')).mtimeMs;
const runsWhere = (root, pred) => (existsSync(join(root, 'runs')) ? readdirSync(join(root, 'runs')) : [])
  .map(x => ({ x, res: resultOf(root, x) })).filter(o => o.res && pred(o.res)).sort((a, b) => mtime(root, a.x) - mtime(root, b.x));
const demandId = res => (res?.demand && typeof res.demand === 'object' ? res.demand.id : res?.demand) || null;

/** 一次运行在看板上的面板键 */
export const runKey = (res) => (res.session && demandId(res) ? res.session : `case:${res.case}`);

/** 最近更新的运行（「上下文」没点名时就是刚跑的那次） */
export function latestRun(root) {
  const d = join(root, 'runs');
  if (!existsSync(d)) return null;
  let best = null;
  for (const run of readdirSync(d)) {
    const f = join(d, run, 'result.json');
    if (!existsSync(f)) continue;
    const t = statSync(f).mtimeMs;
    if (!best || t > best.t) best = { run, t };
  }
  return best?.run || null;
}

/**
 * 引用 → { key, what, report? } | { error }。ref 可以是运行 id、需求 id、用例 id、看板面板键；不给就用最近的运行。
 * 名字冲突时按 运行 → 需求 → 用例 的顺序认（运行最具体）。
 */
export function resolveLink(root, ref) {
  const r = ref || latestRun(root);
  if (!r) return { error: '项目里还没有运行；给一个用例或需求：acceptkit link <用例|需求>' };
  if (/^(case|round|plan):/.test(r)) return { key: r, what: `看板面板 ${r}` };
  const res = resultOf(root, r);
  if (res) {
    const report = ['run.md', 'report.md'].map(f => join(root, 'runs', r, f)).find(existsSync) || null;
    return { key: runKey(res), run: r, what: `运行 ${r}（用例 ${res.case}${demandId(res) ? `，需求 ${demandId(res)}` : ''}）${ref ? '' : ' —— 最近一次运行'}`, report };
  }
  const ofDemand = runsWhere(root, res => demandId(res) === r).at(-1);
  const rf = loadRounds(root, r);
  // 需求只有一个地址：需求页（最上面是等你做的事）。开跑前后都是它，发出去的链接不会因为需求开跑而落空
  if (rf?.rounds?.length || existsSync(join(root, 'state', 'plans', `${r}.json`))) return { key: r, run: ofDemand?.x, what: `需求 ${r}` };
  if (ofDemand) return { key: runKey(ofDemand.res), run: ofDemand.x, what: `需求 ${r} 最近一次运行 ${ofDemand.x}（还没有回归轮）` };
  if (existsSync(join(root, 'cases', `${r}.case.json`))) return { key: `case:${r}`, run: runsWhere(root, res => res.case === r).at(-1)?.x, what: `用例 ${r}` };
  return { error: `${r} 不是运行、需求，也不是用例（acceptkit cases / demands 看有哪些）` };
}

/**
 * 定位结果 → 网址 | { error }。传字符串当面板键。
 * base = 管理页面上这个项目的地址（http://127.0.0.1:<端口>/p/<项目>/）；没有时退到本地看板文件。
 */
export function linkUrl(root, config, target, base = null) {
  const t = typeof target === 'string' ? { key: target } : target;
  const byRun = config?.dashboard?.locateBy === 'run';
  const tpl = config?.dashboard?.url || `${base || pathToFileURL(join(root, 'dashboard.html')).href}#run=${byRun ? '{run}' : '{key}'}`;
  if (tpl.includes('{run}') && !t.run) return { error: `${t.what || t.key} 还没有运行，这个看板按运行定位（dashboard.url 用的是 {run}）` };
  return tpl.replace('{key}', encodeURIComponent(t.key)).replace('{run}', encodeURIComponent(t.run || ''));
}
