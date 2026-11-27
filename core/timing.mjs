// 验收用时与定期优化包。
//
// 用时：每个运行有时间线（engine saveResult 记的 timeline：开始 + 每条结论变化的时刻、机判还是手记）。
// 一条结论的用时 = 它和同一运行里上一件事之间隔了多久；隔得太久（中途离开、隔天再接着做）不算进去。
// 时间线机制之前的老运行没有这些，按「运行目录建立时刻 + 证据文件写入时刻 + 机判时刻」估，标成估算。
//
// 优化包（tune）：定期（看板服务每周一份）把要优化的东西连同全部上下文写进一个文件 —— 处理它的会话
// 可能是另一个、离线的，手上只有这个文件。包里每一节都自带：数据、读懂它要的原文、可以怎么处理、处理完怎么记。
// 工具层不调用模型：包只摆事实和候选，判断由处理它的会话做，处理结果 tune done 记下，下一份包对照着看。
// 包里要处理的都是基建自己的事（执行缓存的取舍、自动批准标准）：不改项目的用例、不改操作配方
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AUTO_RULES } from './plan-gate.mjs';
import { allPlans } from './demand-registry.mjs';
import { loadCache, cacheLog, cacheStats } from './replay.mjs';

export const IDLE_CAP_MS = 45 * 60e3;     // 两件事之间隔超过 45 分钟：当中途离开，不算进下一条的用时
export const TUNE_EVERY_DAYS = 7;
const REPEAT_MIN = 3;                      // 跑过（判过）几次算「重复」

const readJSON = p => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const mtime = p => { try { return statSync(p).mtimeMs; } catch { return 0; } };
const med = a => { const s = a.filter(x => x != null).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const demandOf = r => r?.demand?.id || r?.demand || '?';

/** 一个运行里每条结论的时刻和用时 → { start, items: [{ id, t, dt, how, status }], estimated } */
export function runTimes(dir, r) {
  let start, raw = [], estimated = false;
  if (r.timeline?.length) {
    start = Date.parse(r.created_at || r.timeline[0].at);
    raw = r.timeline.filter(e => e.id && e.status !== 'todo').map(e => ({ id: e.id, t: Date.parse(e.at), how: e.how, status: e.status }));
  } else {
    estimated = true;
    const st = statSync(dir); start = st.birthtimeMs || st.ctimeMs;
    for (const [id, v] of Object.entries(r.results || {})) {
      if (!v || v.status === 'todo') continue;
      const ts = [v.observed?.at ? Date.parse(v.observed.at) : 0, ...(v.evidence || []).map(e => mtime(join(dir, e)))].filter(x => x > start - 60e3);
      if (ts.length) raw.push({ id, t: Math.max(...ts), how: v.observed ? 'observe' : 'record', status: v.status });
    }
  }
  raw.sort((a, b) => a.t - b.t);
  let prev = start;
  const items = raw.map(x => { const gap = x.t - prev; prev = x.t; return { ...x, dt: gap > 0 && gap <= IDLE_CAP_MS ? gap : null }; });
  return { start, items, estimated };
}

/** 读项目里全部运行（被取代的不算）→ [{ run, dir, r, times }] */
export function loadRunTimes(root) {
  const RUNS = join(root, 'runs'); if (!existsSync(RUNS)) return [];
  const out = [];
  for (const d of readdirSync(RUNS)) {
    const dir = join(RUNS, d), r = readJSON(join(dir, 'result.json'));
    if (!r || r.superseded_by) continue;
    out.push({ run: d, dir, r, times: runTimes(dir, r) });
  }
  return out;
}

/** 按需求 / 用例 / 断言汇总用时。demand 给了只看那个需求 */
export function timingReport(root, { demand = null } = {}) {
  const all = loadRunTimes(root).filter(x => !demand || demandOf(x.r) === demand);
  const sum = xs => xs.reduce((s, x) => s + (x || 0), 0);
  const activeOf = x => sum(x.times.items.map(i => i.dt));
  const demands = new Map(), cases = new Map(), asserts = new Map();
  for (const x of all) {
    const d = demandOf(x.r), a = activeOf(x);
    const D = demands.get(d) || { demand: d, runs: 0, active: 0, cases: new Set(), estimated: 0 };
    D.runs++; D.active += a; D.cases.add(x.r.case); if (x.times.estimated) D.estimated++; demands.set(d, D);
    const C = cases.get(x.r.case) || { case: x.r.case, demands: new Set(), runs: [], failures: [] };
    C.demands.add(d); C.runs.push({ run: x.run, active: a, concluded: x.times.items.length, estimated: x.times.estimated });
    for (const [id, v] of Object.entries(x.r.results || {})) for (const at of v?.attempts || []) if (at.outcome && at.outcome !== 'ok') C.failures.push({ run: x.run, id, outcome: at.outcome, why: String(at.why || '').slice(0, 200), at: at.at });
    cases.set(x.r.case, C);
    for (const i of x.times.items) {
      const k = `${x.r.case}::${i.id}`, A = asserts.get(k) || { case: x.r.case, id: i.id, n: 0, dts: [], observe: 0, record: 0, statuses: {} };
      A.n++; if (i.dt) A.dts.push(i.dt); A[i.how === 'observe' ? 'observe' : 'record']++; A.statuses[i.status] = (A.statuses[i.status] || 0) + 1; asserts.set(k, A);
    }
  }
  const items = all.flatMap(x => x.times.items);
  return {
    demand, runs: all.length, conclusions: items.length, timed: items.filter(i => i.dt).length,
    estimatedRuns: all.filter(x => x.times.estimated).length, total: sum(all.map(activeOf)),
    demands: [...demands.values()].map(D => ({ ...D, cases: D.cases.size })).sort((a, b) => b.active - a.active),
    cases: [...cases.values()].map(C => ({ case: C.case, demands: [...C.demands], runs: C.runs.length, total: sum(C.runs.map(r => r.active)), median: med(C.runs.map(r => r.active)), failures: C.failures }))
      .sort((a, b) => b.total - a.total),
    asserts: [...asserts.values()].map(A => ({ ...A, total: sum(A.dts), median: med(A.dts) })).sort((a, b) => b.total - a.total),
  };
}

// 给人读的那份只留断言第一行（断言原文常常十几行，全文在 .json 里）
const short = a => { const l = String(a || '').split('\n')[0].replace(/\*\*/g, ''); return l.length > 100 ? l.slice(0, 100) + '…' : l; };
const H = ms => `${(ms / 3600e3).toFixed(1)} 小时`, M = ms => ms == null ? '—' : `${Math.round(ms / 60e3)} 分钟`;
export function fmtTiming(t, top = 15) {
  const L = [`${t.demand ? `需求 ${t.demand}` : '全项目'}：${t.runs} 个运行，有效用时 ${H(t.total)}；${t.conclusions} 条结论里 ${t.timed} 条算得出用时`
    + (t.estimatedRuns ? `（${t.estimatedRuns} 个运行没有时间线，按证据文件时间估算）` : '')];
  if (!t.demand) { L.push('', '需求（按有效用时）：'); for (const d of t.demands.slice(0, top)) L.push(`  ${d.demand}  ${H(d.active)} · ${d.runs} 个运行 / ${d.cases} 条用例`); }
  L.push('', `用例（按累计用时；跑过 ${REPEAT_MIN} 次以上的标 ↻）：`);
  for (const c of t.cases.slice(0, top)) L.push(`  ${c.runs >= REPEAT_MIN ? '↻' : ' '} ${c.case}  跑 ${c.runs} 次 · 每次中位 ${M(c.median)} · 累计 ${H(c.total)}${c.failures.length ? ` · 读取失败 ${c.failures.length} 次` : ''}`);
  L.push('', '断言（按累计用时）：');
  for (const a of t.asserts.slice(0, top)) L.push(`  ${a.case} ${a.id}  判了 ${a.n} 次 · 每次中位 ${M(a.median)} · 累计 ${H(a.total)} · 机判 ${a.observe} / 手记 ${a.record}`);
  return L.join('\n');
}

// ───────────────────────── 定期优化包 ─────────────────────────
const tuneDir = root => join(root, 'state', 'tune');
const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
export function tunePacks(root) {
  const dir = tuneDir(root); if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().map(f => {
    const id = f.replace('.json', ''); return { id, json: join(dir, f), md: join(dir, `${id}.md`), done: readJSON(join(dir, `${id}.done.json`)) };
  });
}
export const tuneDue = (root, now = Date.now()) => { const last = tunePacks(root).at(-1);
  return !last || now - Date.parse(last.id) >= TUNE_EVERY_DAYS * 86400e3; };

/** 自动批准标准的表现：每条规则通过几次，哪些通过之后被复核驳回（带改前改后、复核意见，处理时不用再去翻） */
function autoApproveSection(root, runsAll) {
  const out = { rules: {}, rejected: [] };
  for (const plan of allPlans(root)) for (const n of (plan.notices || []).filter(n => n.rules?.length)) {
    for (const rule of n.rules) out.rules[rule] = (out.rules[rule] || 0) + 1;
    for (const id of n.reset || []) for (const x of runsAll.filter(x => x.r.case === n.case && demandOf(x.r) === plan.demand))
      for (const [k, v] of Object.entries(x.r.reviews || {})) if (k.startsWith(`${id}::`) && !['ok', 'pending'].includes(v?.state) && String(v?.at || '') > n.at)
        out.rejected.push({ demand: plan.demand, case: n.case, id, rules: n.rules, why: n.why, changes: n.changes, judged: (n.judged || []).filter(j => j.id === id),
          review: { state: v.state, note: String(v.note || '').slice(0, 400), by: v.by, at: v.at, evidence: k.slice(id.length + 2) }, run: x.run });
  }
  return out;
}

/** 打一份优化包：state/tune/<日期>.json（给工具 / 会话读）+ .md（给人读，内容一样） */
export function tuneBuild(root, { now = Date.now() } = {}) {
  const runsAll = loadRunTimes(root), t = timingReport(root);
  const caseFile = c => readJSON(join(root, 'cases', `${c}.case.json`));
  const assertText = (c, id) => { const cf = caseFile(c); let a = ''; const w = ns => { for (const n of ns || []) { for (const e of n.expect || []) if (e.id === id) a = e.assert; w(n.children); } }; w(cf?.tree); return a; };
  // 重复跑：跑过 REPEAT_MIN 次以上的用例，时间花在哪（读取失败、手记的断言、每次用时）
  const repeated = t.cases.filter(c => c.runs >= REPEAT_MIN).slice(0, 25).map(c => {
    const as = t.asserts.filter(a => a.case === c.case);
    const byOutcome = {}; for (const f of c.failures) byOutcome[f.outcome] = (byOutcome[f.outcome] || 0) + 1;
    const cache = loadCache(root, c.case), log = cacheLog(root).filter(x => x.case === c.case);
    return { case: c.case, title: caseFile(c.case)?.title || '', demands: c.demands, runs: c.runs, total: c.total, median: c.median,
      cache: cache ? { from_run: cache.from_run, built_at: cache.built_at, steps: cache.steps.length } : null,
      replays: log.filter(x => x.kind === 'replayed').length, dropped: log.filter(x => x.kind === 'dropped').map(x => ({ at: x.at, reasons: x.reasons })), cache_bugs: log.filter(x => x.verdict === 'cache_bug').length,
      failures: { total: c.failures.length, byOutcome, samples: [...new Map(c.failures.map(f => [f.why.slice(0, 60), f])).values()].slice(0, 5) },
      manual: as.filter(a => a.record >= REPEAT_MIN && !a.observe).map(a => ({ id: a.id, assert: assertText(c.case, a.id), n: a.n, total: a.total })),
      slowest: as.slice(0, 5).map(a => ({ id: a.id, assert: assertText(c.case, a.id), n: a.n, median: a.median, total: a.total, observe: a.observe, record: a.record })) };
  });
  const aa = autoApproveSection(root, runsAll);
  const pack = {
    id: day(now), built_at: new Date(now).toISOString(), previous: tunePacks(root).filter(p => p.id < day(now)).at(-1)?.id || null,
    how_to_use: '这份包自带处理它要的全部上下文，不依赖产生它的会话。逐节处理：每节的 ask 是要判断的事，options 是可以怎么做；处理完 acceptkit tune done <包> --note "<做了什么、没做什么、为什么>"，下一份包会对照这次的处理看效果。',
    timing: { runs: t.runs, total_ms: t.total, conclusions: t.conclusions, timed: t.timed, estimated_runs: t.estimatedRuns,
      demands: t.demands.slice(0, 10).map(d => ({ demand: d.demand, active_ms: d.active, runs: d.runs, cases: d.cases })) },
    sections: [
      { key: 'repeated', title: `重复跑的用例（跑过 ${REPEAT_MIN} 次以上，按累计用时）和执行缓存的覆盖`,
        ask: '重复跑的时间应该被执行缓存吃掉。逐条看：没有缓存的，为什么没建起来（从没全部跑通、有验不了的、日志里没有动作命令）；有缓存但回放少、作废多的，作废理由是什么。改进的是缓存机制本身（core/replay.mjs：哪些命令进缓存、比对口径），不动用例和操作配方。',
        options: ['改进缓存：调整进缓存的命令、关键路径的写法、差别大的判定口径，并补测试', '不动：写清为什么（例：这条用例每次本来就不一样）'],
        items: repeated },
      { key: 'cache', title: '执行缓存的表现',
        ask: '缓存的毛病（回放判出的跟正常重判的不一样）一次都不该放过：逐条看是哪一步出的问题，决定是修比对口径、把某类命令排除出缓存，还是给某类用例关掉缓存。被测物真变了的那些说明比对在起作用。',
        options: ['修缓存：改 core/replay.mjs 并补一条复现这次毛病的测试', '不动：写清为什么'],
        stats: (({ cache_bug, ...x }) => ({ ...x, cache_bug: cache_bug.length }))(cacheStats(root)), items: cacheStats(root).cache_bug },
      { key: 'auto_approve', title: '自动批准标准的表现',
        ask: '每条规则自动通过了多少次，其中哪些通过之后证据被复核驳回。驳回多的规则说明放过了不该放的：看这些实例，决定要不要收紧（例：某类判法改动改成「必须复核过才算数」），或者驳回跟这次改动无关。',
        options: ['收紧规则：改 core/plan-gate.mjs 的 AUTO_RULES 和 classifyCaseEdit，并补测试', '不动：驳回与改动无关，写清理由'],
        rules: Object.fromEntries(Object.entries(AUTO_RULES).map(([k, v]) => [k, { ...v, passed: aa.rules[k] || 0, later_rejected: aa.rejected.filter(x => x.rules.includes(k)).length }])),
        items: aa.rejected },
      { key: 'data_gaps', title: '用时数据的缺口',
        ask: '算不出用时的结论越多，上面的排序越不准。看缺口是老运行（没有时间线）还是新运行里也有：新运行里也有，说明有写结论的路径绕过了工具的记录，要查。',
        items: [{ conclusions: t.conclusions, timed: t.timed, estimated_runs: t.estimatedRuns, runs: t.runs }] },
    ],
  };
  const dir = tuneDir(root); mkdirSync(dir, { recursive: true });
  const json = join(dir, `${pack.id}.json`), md = join(dir, `${pack.id}.md`);
  writeFileSync(json, JSON.stringify(pack, null, 1));
  writeFileSync(md, tuneMarkdown(pack));
  return { json, md, pack };
}

function tuneMarkdown(p) {
  const L = [`# 验收优化包 ${p.id}`, '', p.how_to_use, '', `上一份：${p.previous || '无'}`, '',
    `## 用时概况`, '', `${p.timing.runs} 个运行，有效用时 ${H(p.timing.total_ms)}；${p.timing.conclusions} 条结论里 ${p.timing.timed} 条算得出用时（${p.timing.estimated_runs} 个运行是估算的）。`, '',
    ...p.timing.demands.map(d => `- ${d.demand}：${H(d.active_ms)}，${d.runs} 个运行 / ${d.cases} 条用例`), ''];
  for (const s of p.sections) {
    L.push(`## ${s.title}`, '', `**要判断：** ${s.ask}`, '', `**可以怎么做：**`, ...s.options?.map(o => `- ${o}`) || [], '');
    if (s.key === 'repeated') for (const c of s.items) {
      L.push(`### ${c.case}${c.title ? ` —— ${c.title}` : ''}`, `跑了 ${c.runs} 次（${c.demands.join('、')}），每次中位 ${M(c.median)}，累计 ${H(c.total)}。读取失败 ${c.failures.total} 次${Object.keys(c.failures.byOutcome).length ? `（${Object.entries(c.failures.byOutcome).map(([k, n]) => `${k} ${n}`).join('、')}）` : ''}。`);
      L.push(c.cache ? `执行缓存：有（来自 ${c.cache.from_run}，${c.cache.steps} 步），回放 ${c.replays} 次，作废 ${c.dropped.length} 次${c.cache_bugs ? `，其中缓存的毛病 ${c.cache_bugs} 次` : ''}` : `执行缓存：没有${c.dropped.length ? `（作废过 ${c.dropped.length} 次：${c.dropped.at(-1).reasons.join('；')}）` : ''}`);
      for (const f of c.failures.samples) L.push(`- 失败样例 ${f.id}（${f.outcome}）：${f.why}`);
      for (const a of c.manual) L.push(`- 一直手记：${a.id}「${short(a.assert)}」判了 ${a.n} 次，累计 ${H(a.total)}`);
      for (const a of c.slowest) L.push(`- 最花时间：${a.id}「${short(a.assert)}」判了 ${a.n} 次，每次中位 ${M(a.median)}，机判 ${a.observe} / 手记 ${a.record}`);
      L.push('');
    }
    if (s.key === 'auto_approve') {
      for (const [k, r] of Object.entries(s.rules)) L.push(`- ${k} ${r.title}：通过 ${r.passed} 次，之后被驳回 ${r.later_rejected} 次`);
      for (const x of s.items) L.push('', `- ${x.demand} ${x.case} ${x.id}（${x.rules.join(' ')}）改动：${x.changes.join('；')}；理由：${x.why}`,
        ...x.judged.map(j => `  以前判：${j.before}；现在判：${j.after}`), `  复核（${x.review.state}，${x.review.by}，${x.review.at}）：${x.review.note}`);
      L.push('');
    }
    if (s.key === 'cache') { const x = s.stats; L.push(`现有缓存 ${x.live} 份；回放 ${x.replays} 次，共 ${M(x.replay_ms)}；作废 ${x.dropped} 次，核对下来被测物真变了 ${x.real_change} 次、缓存的毛病 ${x.cache_bug} 次。`);
      for (const b of s.items) L.push(`- ${b.case} ${b.run}：${b.detail}`); L.push(''); }
    if (s.key === 'data_gaps') { const g = s.items[0]; L.push(`${g.conclusions} 条结论，${g.timed} 条算得出用时；${g.estimated_runs}/${g.runs} 个运行没有时间线。`, ''); }
  }
  return L.join('\n');
}

export function tuneDone(root, id, note) {
  const p = tunePacks(root).find(x => x.id === id);
  if (!p) throw new Error(`没有优化包 ${id}（acceptkit tune 看有哪些）`);
  const rec = { id, done_at: new Date().toISOString(), note };
  writeFileSync(join(tuneDir(root), `${id}.done.json`), JSON.stringify(rec, null, 1));
  return rec;
}
