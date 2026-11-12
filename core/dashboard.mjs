#!/usr/bin/env node
// dashboard — 验收看板，**按需求组织**。
//
// 结构：左侧 = 需求（一个 bug/诉求一条），右侧 = 该需求下跑过哪些用例、每个用例的 run 历史、
// 每条断言的实测与证据、截图 gallery。项目扩展（pack.mjs）可以再加自己的证据渲染和常备用例库。
//
// 需求从哪来：`cases/<case>.case.json` 的 `demand: {id,title,desc}`。同一 demand.id 的多个用例
// 自动归到一条需求下（一个诉求往往要"复现 + 验证修法"两个用例）。没写 demand 的用例落到「未归档」。
//
// 用法: node core/dashboard.mjs [--asset-base <urlPrefix>] [out.html]（通常由 acceptkit open / 管理页面调用）
//   --asset-base 时截图走 URL（server 按需出图，HTML 只有 KB）；否则内联 data-URI。
//   评审内部数据：只在本地宿主页面(localhost) 的 iframe 里出，从不外发。
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { consultFor } from './evidence-consult.mjs';
import { join, dirname, relative } from 'node:path';
import { loadProject, ownerIdentity } from './project.mjs';

const PROJ = await loadProject();
if (!PROJ.root) { console.error('acceptkit open: 找不到项目（--project / ACCEPTKIT_PROJECT / 项目目录）'); process.exit(1); }
const ROOT = PROJ.root;
setCardMarkers(PROJ.config.evidence?.cardMarkers);
// 看板的标题与宿主页面消息前缀来自项目配置（dashboard.title / tabTitle / hostMessagePrefix）。
// 嵌在宿主页面里时，宿主按 <前缀>-run / -copy / -copied 收发消息，改前缀要和宿主一起改。
const DASH = PROJ.config.dashboard || {};
const HOST_MSG = String(DASH.hostMessagePrefix || 'acceptkit').replace(/[^\w-]/g, '');
const CASES = join(ROOT, 'cases');
const RUNS = join(ROOT, 'runs');
import { fmtObserve, claimGaps } from './evidence-gate.mjs';
const EVID = join(ROOT, 'evidence');
// 数据模型：需求↔用例多对多（关系在评审单里）；平台适用性算出来；图按身份分类
import { applicability, fmtApplicability, RUNTIME_PLATFORMS, PLATFORM_LABEL, normalizePlatforms } from './platform.mjs';
import { loadDemands, allPlans, planCaseSet, demandsReferencing } from './demand-registry.mjs';
import { imageKind, appShotsIn, reviewItems, setCardMarkers, assertionGaps, GAP_TEXT, viaOf, VIA_LABEL } from './evidence-gate.mjs';
import { nextCards, caseStages, STAGES } from './next.mjs';
import { approvedCases, planDelta } from './plan-gate.mjs';
import { CARD_KINDS } from './cards.mjs';
import { findingProblems, FINDING_KINDS } from './finding-quality.mjs';
import { loadRounds, deriveHistory, demandRecords, resolveState, roundMembers, recordTime } from './rounds.mjs';
const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const OUT = process.argv.slice(2).find(a => a.endsWith('.html')) || join(ROOT, 'dashboard.html');
const ASSET_BASE = arg('--asset-base');

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pretty = o => esc(JSON.stringify(o, null, 2));
const isShot = f => /\.(png|jpe?g)$/i.test(f);
const ICON = { pass: '✅', fail: '❌', blocked: '⛔', gap: '⚠️', skip: '⏭️', todo: '⬜' };
// 内嵌 base64 有总量预算。没有预算时整张看板会**生成不出来**：
// 实测一个项目积累到一千多张证据图（单条用例十几 MB 图），
// 内嵌后 HTML 超过 V8 的字符串上限，看板生成直接 `RangeError: Invalid string length` ——
// 看板不是「变慢」而是整个没有，而报错位置在 panels.join() 上，完全看不出是图片造成的。
// 预算用完后改为指向原文件（file:// 相对路径），本地打开照样能看；
// 配了 ASSET_BASE（宿主页代理取图）时不受影响。
const INLINE_BUDGET = Number(process.env.ACCEPTKIT_INLINE_BUDGET || 120e6);
let __inlined = 0, __spilled = 0;
const imgSrc = (rel, full) => {
  // 取图接口按项目根目录解析路径：有完整路径就从它换算，调用方给的 rel 可能是相对运行目录的（证据、截图记录里都是）
  if (ASSET_BASE) return `${ASSET_BASE}?f=${encodeURIComponent(full ? relative(ROOT, full) : rel)}`;
  try {
    const buf = readFileSync(full);
    // base64 膨胀约 4/3；按膨胀后的体积记账，否则预算会超
    if (__inlined + buf.length * 1.37 > INLINE_BUDGET) { __spilled++; return relHref(rel, full); }
    __inlined += buf.length * 1.37;
    return 'data:image/png;base64,' + buf.toString('base64');
  } catch { return ''; }
};
const relHref = (rel, full) => { try { return 'file://' + full; } catch { return ''; } };
export const inlineStats = () => ({ inlined: __inlined, spilled: __spilled, budget: INLINE_BUDGET });
const statusClass = st => {
  const s = String(st ?? '').toLowerCase();
  if (s.startsWith('pass') || s.startsWith('green')) return 'pass';
  if (s.startsWith('fail')) return 'fail';
  if (s.startsWith('partial') || s.startsWith('mixed')) return 'mixed';
  return 'wip';
};

// ---------- 读用例 / run ----------
const loadJSON = p => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

const cases = existsSync(CASES)
  ? readdirSync(CASES).filter(f => f.endsWith('.case.json'))
      .map(f => loadJSON(join(CASES, f))).filter(Boolean)
  : [];

// 用例名 → 用例对象（评审单里要按名字查断言数 + 生成详情页链接）
const ALL_CASES = Object.fromEntries(cases.map(c => [c.case, c]));

// 断言 id → assert 文案（渲染断言表用）
function expectText(c) {
  const out = {};
  (function walk(ns) {
    for (const n of ns || []) { for (const e of n.expect || []) out[e.id] = e; walk(n.children); }
  })(c.tree);
  return out;
}

function collectShots(dir, runId) {
  const out = [];
  const walk = d => { for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (isShot(e.name)) out.push({ name: e.name, rel: `runs/${runId}${p.slice(dir.length)}`, path: p, mtime: statSync(p).mtimeMs });
  } };
  try { walk(dir); } catch { /* empty */ }
  return out.sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name, undefined, { numeric: true }));
}

const OPS_REG = (() => { try { return JSON.parse(readFileSync(join(ROOT, 'ops', 'registry.json'), 'utf8')).ops || {}; } catch { return {}; } })();
const runs = existsSync(RUNS)
  ? readdirSync(RUNS, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => {
      const id = e.name, dir = join(RUNS, id);
      const res = loadJSON(join(dir, 'result.json'));
      // 证据不全的 pass 不算通过：和报告同一份判据（assertionGaps），在这里统一改成 gap，后面所有计数、颜色、泳道都按它
      // case_ref 存的是文件路径（cases/<名>.case.json），不是用例名：按路径查不到 ⇒ 断言定义为空 ⇒ via 被当成 ui ⇒
      // 声明了调试器验证的断言被误判「证据不全」（报告那条路径会解析，所以两边不一致）
      const cdef = res && (ALL_CASES[res.case] || ALL_CASES[String(res.case_ref || '').replace(/^.*\//, '').replace(/\.case\.json$/, '')]);
      const cexp = []; (function w(ns) { for (const n of ns || []) { cexp.push(...(n.expect || [])); w(n.children); } })(cdef?.tree);
      if (res?.results) for (const [eid, g] of Object.entries(assertionGaps(dir, res, { expects: cexp, ops: OPS_REG })))
        if (res.results[eid].status === 'pass') res.results[eid] = { ...res.results[eid], status: 'gap', recorded_status: 'pass', gaps: g };
      const meta = loadJSON(join(dir, 'run.json')) || {};
      return { id, dir, res, meta, wild: !res, shots: collectShots(dir, id) };
    }).sort((a, b) => b.id.localeCompare(a.id))
  : [];

// 用例 → 它跑过的那些 run（按 run_seq 升序）。评审单上的用例要就地展开成树、
// 并显示实测状态与截图，就需要这张索引。
const CASE_RUNS = (() => {
  const m = {};
  for (const r of runs) {
    const cn = r.res?.case_ref || r.res?.case;
    if (!cn) continue;
    (m[cn] = m[cn] || []).push(r);
  }
  for (const k of Object.keys(m)) m[k].sort((a, b) => (a.res.run_seq || 0) - (b.res.run_seq || 0));
  return m;
})();

// ---------- 分组：需求 → 用例 → run ----------
// 用例是跨需求复用的资产：一条用例可以出现在多个需求下。需求↔用例的关系只从评审单读，
// 用例文件里的 origin 只是出处。谁都没引用的用例单独成组（不是「未归档」——用例本来就不归档到需求）。
const DEMAND_REG = loadDemands(ROOT);
const PLANS = allPlans(ROOT);
const OPS_FOR_PLAT = (() => { try { return JSON.parse(readFileSync(join(ROOT, 'ops', 'registry.json'), 'utf8')).ops || {}; } catch { return {}; } })();
for (const c of cases) {
  c._runs = runs.filter(r => r.res?.case === c.case).sort((a, b) => (a.res.run_seq || 0) - (b.res.run_seq || 0));
  c._refs = demandsReferencing(ROOT, c.case, PLANS);
  c._demandIds = [...new Set(c._refs.map(x => x.demand))];
  c._ap = applicability(c, OPS_FOR_PLAT, PROJ.config);
}
const demands = new Map();
for (const p of PLANS) {
  const reg = DEMAND_REG.get(p.demand) || {};
  demands.set(p.demand, { id: p.demand, title: reg.title || p.title || p.demand, desc: reg.desc || '', cases: [...planCaseSet(p)].map(n => ALL_CASES[n]).filter(Boolean) });
}
for (const [id, d] of DEMAND_REG) if (!demands.has(id)) demands.set(id, { id, title: d.title, desc: d.desc || '', cases: [] });
{
  const unref = cases.filter(c => !c._demandIds.length);
  if (unref.length) demands.set('（未被引用）', { id: '（未被引用）', title: '没有任何评审单引用的用例', desc: '用例是资产；要用它就 acceptkit plan add-case <D> --surface <S> --reuse <case>。', cases: unref });
}
for (const dm of demands.values()) {
  // 需求的时间戳 = 它下面**最新一次 run** 的时间。run id 以 YYYY-MM-DD 开头，字典序即时间序。
  dm._latest = dm.cases.flatMap(c => c._runs).reduce((m, r) => (r.id > m ? r.id : m), '');
}
// 时间倒序：最近有动静的需求在最上面。
const demandList = [...demands.values()].sort((a, b) => b._latest.localeCompare(a._latest));
const wildRuns = runs.filter(r => r.wild);

// ---------- 项目扩展的证据渲染 ----------
// 项目特有的证据结构（某种探针输出、某种覆盖矩阵、项目自己的常备用例库）只有项目认得：由项目的 pack.mjs 渲染，内核不写死任何一种。
const PACK_H = { esc, pretty, loadJSON, imgSrc, statusClass, join, existsSync, readdirSync, EVID, ROOT };
const packRender = (name, ...a) => {
  const f = PROJ.pack?.[name];
  if (typeof f !== 'function') return null;
  try { return f(...a, PACK_H); } catch (e) { return { error: `项目扩展 ${name} 出错：${e.message}` }; }
};
const runExtras = dir => { const r = packRender('dashboardRunExtras', dir); return typeof r === 'string' ? r : r?.error ? `<p class="dim">${esc(r.error)}</p>` : ''; };
// ---------- 挂载的用例库（项目配置 libraries）----------
// 不绑定某个需求的常备用例：谁都能挂自己的库，一个项目可以挂几份。库文件的格式（通用）：
//   { "tree": [ { "layer": "<分组名>", "cases": [ { "id", "name", "status", "evidence": "<相对 evidenceDir 的 JSON>" } ] } ] }
// 证据 JSON 每个字段出一格（labels 给字段的显示名，没给就用字段名）；screenshots: [相对路径] 出图。
function renderLibrary(L) {
  const tree = loadJSON(join(ROOT, L.file));
  if (!Array.isArray(tree?.tree)) return null;
  const evRoot = join(ROOT, L.evidenceDir || 'evidence');
  const labels = L.labels || {};
  let done = 0, total = 0;
  const secs = tree.tree.map(G => {
    const rows = (G.cases || []).map(c => {
      total++; if (String(c.status).startsWith('pass')) done++;
      const j = c.evidence ? loadJSON(join(evRoot, c.evidence)) : null;
      let ev = '';
      if (j && typeof j === 'object') {
        const keys = Object.keys(labels).filter(k => k in j).concat(Object.keys(j).filter(k => !(k in labels) && k !== 'screenshots'));
        const cards = keys.map(k => `<div class="evc"><div class="evk">${esc(labels[k] || k)}</div><pre>${pretty(j[k])}</pre></div>`).join('');
        const shots = Array.isArray(j.screenshots) ? j.screenshots.map(rel => {
          const full = join(evRoot, rel);
          return existsSync(full) ? `<figure class="gcell"><img loading="lazy" src="${imgSrc(relative(ROOT, full), full)}"/><figcaption>${esc(rel)}</figcaption></figure>` : '';
        }).join('') : '';
        ev = `<div class="evgrid">${cards}${shots ? `<div class="evc" style="grid-column:1/-1"><div class="evk">截图</div><div class="gal">${shots}</div></div>` : ''}</div>`;
      }
      return `<details class="run"><summary><span class="badge ${statusClass(c.status)}">${esc(c.status)}</span> <b>${esc(c.name)}</b> <code>${esc(c.id)}</code></summary>${ev}</details>`;
    }).join('');
    return `<h4>${esc(G.layer)}</h4>${rows}`;
  }).join('');
  const title = L.title || L.id;
  return { key: `lib-${L.id}`, title, intro: L.intro || '', done, total,
    html: `<div class="case"><div class="chead"><span class="badge pass">${done}/${total}</span><b>${esc(title)}</b></div>${secs}</div>` };
}

// ---------- 操作树渲染（按操作树组织，保证可读性）----------
// 为什么不用扁平断言表：读的人要顺着「做了什么操作 → 这一步期望什么 → 实际什么 → 证据」走下来。
// 扁平表把层级和语境全丢了，只剩一串 E1/E2；报告好不好读，靠的就是这棵树。
// 引用了 run 目录里不存在的文件 = 证据腐烂（删了图却没删引用），直接标红，别让它悄悄挂着。
// 证据要能**打开看内容**，否则 chip 只是个文件名，读的人验证不了任何东西
//（打不开的 evidence 等于没有 evidence）。
// 做法：把文件内容随页面一起内联，点 chip 直接在浮层里看。大文件截断并注明，
// 免得把看板撑爆；截图仍走图片浮层。
// 由管理页面（acceptkit serve）出的看板带 --evidence-base：证据不内联，点开时再向服务取。
// 内联时一个大项目的证据有上百 MB，页面要全部下载、解析完，点击才开始生效（看起来就是「点了不跳」）。
const EV_INLINE_LIMIT = 400 * 1024;
const EV_BASE = arg('--evidence-base');
const evStore = new Map();   // id → {name, text, truncated} | {name, src}
// 同一份证据在很多面板里出现（每一轮都列继承来的结论）：按文件只存一份。
// 本地文件模式要把原文内联进页面，总量也要有上限 —— 超了整页生成失败（字符串长度上限），所以超出后只记「原文在哪」
const evByPath = new Map();
let evInlined = 0;
const EV_TOTAL_BUDGET = Number(process.env.ACCEPTKIT_EV_BUDGET || 60e6);
function stashEvidence(rel, full) {
  if (evByPath.has(full)) return evByPath.get(full);
  const id = 'ev' + evStore.size;
  evByPath.set(full, id);
  if (EV_BASE) { evStore.set(id, { name: rel, src: `${EV_BASE}?f=${encodeURIComponent(relative(ROOT, full))}` }); return id; }
  let text = '', truncated = false;
  try {
    const buf = readFileSync(full);
    if (evInlined + Math.min(buf.length, EV_INLINE_LIMIT) > EV_TOTAL_BUDGET) {
      evStore.set(id, { name: rel, text: `（页面里放不下了，原文在 ${relative(ROOT, full)}；用 acceptkit open 起管理页面就能直接点开）`, truncated: true });
      return id;
    }
    truncated = buf.length > EV_INLINE_LIMIT;
    text = buf.subarray(0, EV_INLINE_LIMIT).toString('utf8');
    evInlined += text.length;
    if (/\.json$/i.test(rel) && !truncated) {
      try { text = JSON.stringify(JSON.parse(text), null, 1); } catch { /* 保留原文 */ }
    }
  } catch { text = '（读不到该文件）'; }
  evStore.set(id, { name: rel, text, truncated });
  return id;
}
// 复核角标（evidence-gate）：🤖 observe 机判 / ✅ 已复核 / ⏳ 未复核 / ❌ 被驳回。
// 历史 run 没有复核记录 —— 如实显示 ⏳，不默认当成核过。
const rvBadge = rv => {
  if (!rv) return '';
  const s = rv.state;
  // 执行者自审（--by self）不是独立复核：不能和盲审一样打 ✅，否则读的人以为有人核过
  const [mark, tip] = s === 'ok' && rv.by === 'self' ? ['🙋', `只有执行者自审，不算盲审${rv.note ? ' · ' + rv.note : ''}`]
    : s === 'ok' ? [rv.by === 'machine' ? '🤖' : '✅', `已复核${rv.by ? ' · ' + rv.by : ''}${rv.note ? ' · ' + rv.note : ''}`]
    : s === 'pending' ? ['⏳', '未复核' + (rv.note ? ' · ' + rv.note : '')] : ['❌', `驳回（${s}）${rv.note ? '：' + rv.note : ''}`];
  return `<span class="rvb" style="font-size:11px;margin-left:1px" title="${esc(tip)}">${mark}</span>`;
};
const rvOf = (reviews, scope, x) => reviews ? (reviews[`${scope}::${x}`] || { state: 'pending' }) : null;
const evChip = (x, dir, rv = null) => {
  const local = /^(shots|evidence)\//.test(x);
  const full = local && dir ? join(dir, x) : null;
  const missing = local && dir && !existsSync(full);
  const icon = missing ? '⚠️' : isShot(x) ? '📷' : isMachineEvName(x) ? '🧾' : '📄';
  const cls = missing ? 'miss' : isShot(x) ? 'shot' : isMachineEvName(x) ? 'mach' : '';
  if (!missing && full && !isShot(x) && existsSync(full)) {
    const id = stashEvidence(x, full);
    return `<code class="ev ${cls} open" data-ev="${id}" title="点开看内容">${icon}${esc(x)}</code>${rvBadge(rv)}`;
  }
  return `<code class="ev ${cls}" ${missing ? 'title="证据文件不存在"' : ''}>${icon}${esc(x)}</code>${rvBadge(rv)}`;
};
const isMachineEvName = x => /^(evidence|runs)\/.+\.(json|txt|log|ndjson)$/i.test(x);
// ── 状态汇总：一套逻辑，三个粒度共用（整轮 whole / 用例 / 树上每条路线 per-path）──
// 要求：用例树要同时给 whole 状态和 per-path 状态，per-path 还要能附上对状态的解释。
// 所以状态不能只是一个点 —— 每一层都要带 ①几条什么状态 ②没过的那些**为什么**没过。
const ROLL_ORDER = ['fail', 'blocked', 'gap', 'todo', 'skip', 'pass', 'na'];
/** 把一组断言状态卷成一个结论；空集合算 todo（没有断言 ≠ 通过）。 */
function rollup(st) {
  for (const k of ROLL_ORDER) if (st.includes(k)) return k;
  return 'todo';
}
/** 收集一棵子树（或一组用例）的断言状态 + 未通过原因，供三个粒度复用。 */
function tallyOf(walkFn, results) {
  const t = { pass: 0, fail: 0, blocked: 0, gap: 0, todo: 0, skip: 0, na: 0 };
  const st = [], why = new Map();      // 原因 → 命中的断言 id
  walkFn(e => {
    const v = results[e.id] || { status: 'todo' };
    const s = v.status || 'todo';
    t[s] = (t[s] || 0) + 1; st.push(s);
    if (s === 'pass') return;
    const r = s === 'blocked'
      ? (v.blocked_kind === 'capability' ? '验不了 · 我的测试能力缺口'
        : v.blocked_kind === 'dependency' ? '验不了 · 外部依赖阻塞' : '验不了 · 未分类')
      : s === 'fail' ? '与契约不符'
      : s === 'gap' ? `记的是通过，但证据不全（${(v.gaps || []).map(g => GAP_TEXT[g] || g).join('；')}）`
      : s === 'skip' ? '本轮跳过'
      : s === 'na' ? `版本不适用（${v.na_since ? `${v.na_since.component} ≥ ${v.na_since.version}` : '未注明版本'}）` : '还没跑';
    if (!why.has(r)) why.set(r, []);
    why.get(r).push(e.id);
  });
  return { tally: t, agg: rollup(st), why, n: st.length };
}
/** 把多份 tallyOf 结果相加（跨用例汇总的唯一正确方式：各算各的再加，不合并 results）。 */
function sumTallies(parts) {
  const t = { pass: 0, fail: 0, blocked: 0, gap: 0, todo: 0, skip: 0, na: 0 };
  const why = new Map(); let n = 0;
  for (const p of parts) {
    for (const k of Object.keys(t)) t[k] += p.tally[k] || 0;
    n += p.n;
    for (const [r, ids] of p.why) why.set(r, (why.get(r) || []).concat(ids));
  }
  return { tally: t, agg: rollup(Object.keys(t).filter(k => t[k] > 0)), why, n };
}
// 阻塞台账按 case::expect 建索引 —— 每条阻塞本来就写明了它卡的是哪条用例的哪条断言，
// 所以它的家在**树上那条断言旁边**，不是页面底下一张和树互不相干的大表
// （阻塞信息应该长在树上）。
const BLOCKERS = (() => {
  const m = {};
  try {
    for (const f of readdirSync(join(ROOT, 'state', 'blockers'))) {
      if (!f.endsWith('.jsonl')) continue;
      for (const line of readFileSync(join(ROOT, 'state', 'blockers', f), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let b; try { b = JSON.parse(line); } catch { continue; }
        if (!b.case || !b.expect) continue;
        // 工具关闭的（断言后来记成 pass / fail / na）已经不是阻塞，结论就在断言上，不再挂卡片
        if (b.resolved_by === 'tool') continue;
        (m[`${b.case}::${b.expect}`] ||= []).push(b);
      }
    }
  } catch { /* 没有台账目录就是没有阻塞 */ }
  return m;
})();
const blockerState = b => b.resolved ? ['已解决', 'ok'] : b.answer ? ['已答复', 'ok']
  : b.reported ? ['已提 owner，待答复', 'wait'] : ['⚠️ 还没提给 owner', 'bad'];
/** 一条断言旁边的阻塞卡：卡在什么上 + 要什么才能继续 + 提没提给 owner。 */
function blockerChips(caseName, expectId) {
  const list = BLOCKERS[`${caseName}::${expectId}`] || [];
  if (!list.length) return '';
  return list.map(b => {
    const [txt, cls] = blockerState(b);
    return `<div class="blk-card ${cls}"><span class="blk-h">⛔ ${esc(b.id)} <span class="bs ${cls}">${esc(txt)}</span></span>
      <div class="blk-t">${esc(b.text || '')}</div>
      <div class="blk-u"><b>要什么才能继续</b> ${b.unlock ? esc(b.unlock) : '<b>⚠️ 没写解锁条件</b>'}</div>
      ${b.answer ? `<div class="blk-a"><b>owner 答复</b> ${esc(b.answer)}</div>` : ''}
      ${b.resolved_how ? `<div class="blk-a"><b>怎么解的</b> ${esc(b.resolved_how)}</div>` : ''}</div>`;
  }).join('');
}
const walkExpects = (nodes) => (cb) => (function w(ns) {
  for (const n of ns || []) { (n.expect || []).forEach(cb); w(n.children); }
})(nodes);
/** 状态徽章条：几条路线是什么状态。
 *  ⚠️ 不用 ⬜/⏭️ 这类 emoji —— 本机字体渲染成空方块，`⬜74` 会被读成孤零零的「74」，
 *  `✅100` 更会被读成 `✅00`。一律文字标签 + 颜色，宽一点但读得准。 */

// 证据不全 / 验不了的断言：展开就是取证咨询（判据面 → 常见取证入口 + 每个入口要问清的业务问题），
// 和 acceptkit consult 同一份通识。owner 在这里就能看出执行者缺的是哪块业务知识，直接告诉他
function consultHtml(id, assertText, v) {
  if (!['gap', 'blocked'].includes(v.status) || !assertText) return '';
  const k = consultFor({ assert: assertText, situation: v.status === 'blocked' ? 'blocked' : 'gap', gaps: v.gaps || [] });
  return `<details class="consult"><summary>怎么拿到证据</summary><div class="dim">判据面：${k.faces.map(f => esc(f.label)).join(' / ')}</div><ul>${k.surfaces.map(x => `<li><b>${esc(x.where)}</b>：${esc(x.ask)}</li>`).join('')}</ul><div class="dim">执行者：<code>acceptkit consult ${esc(v.run || '<运行>')} --expect ${esc(id)}</code></div></details>`;
}
const TB_LABEL = { pass: '通过', fail: '失败', blocked: '验不了', gap: '证据不全', todo: '待测', skip: '跳过', na: '版本不适用' };
function tallyBadges(t) {
  return [['pass', 'pass'], ['fail', 'fail'], ['blocked', 'blk'], ['gap', 'fail'], ['todo', 'todo'], ['skip', 'skip'], ['na', 'na']]
    .filter(([k]) => t[k]).map(([k, cls]) => `<span class="tb ${cls}">${TB_LABEL[k]} ${t[k]}</span>`).join('');
}
/** 状态解释行：只在有没过的断言时出现，点名原因与具体是哪几条。
 *  ⚠️ 断言 id 只在**单条用例内**唯一（每条用例都有自己的 E1/E2…）。所以跨用例汇总的那两层
 *  （整轮 / 分组）只报原因与条数，不列 id —— 列了是「E1 E2 … E1 E2 …」这种既长又指不到人的噪音。 */
function whyLine(why, { ids: showIds = true, cap = 24 } = {}) {
  if (!why.size) return '';
  return `<div class="whyl">` + [...why.entries()].map(([r, ids]) => {
    const tail = showIds
      ? ` <span class="dim">${esc(ids.slice(0, cap).join(' '))}${ids.length > cap ? ` …另 ${ids.length - cap} 条` : ''}</span>` : '';
    return `<span class="why"><b>${esc(r)}</b> ${ids.length} 条${tail}</span>`;
  }).join('') + `</div>`;
}
// 节点聚合状态：子树里任一 fail→fail；有 blocked→blocked；有 todo→todo；全 pass→pass
function nodeAgg(node, results) {
  return tallyOf(walkExpects([node]), results).agg;
}
// ---------- 操作集：用例只说【做什么】，各平台各自说【怎么做】 ----------
// 操作集要有独立页面，用例里引用到的地方是超链接，像 wiki 的关键词引用。
// 这样三件事同时成立：跨平台复用同一条规格、操作怎么做只有一处定义、某平台缺实现在建用例时就显形。
const OPS = (() => {
  const f = join(ROOT, 'ops', 'registry.json');
  try { return JSON.parse(readFileSync(f, 'utf8')).ops || {}; } catch { return {}; }
})();

/** 用例里的操作引用 —— 渲染成可点的关键词，点了跳到操作集那一条。 */
function opRef(opId, platform) {
  if (!opId) return '';
  const o = OPS[opId];
  if (!o) return `<span class="opref bad" title="操作库里没有这一条">⚠ ${esc(opId)}</span>`;
  // 只有 平台@宿主 配方的操作在该平台也算有做法（具体哪个宿主能做，看操作卡片）
  const r = (o.platforms || {})[platform || ''] || Object.entries(o.platforms || {}).find(([k, x]) => k.split('@')[0] === platform && !x.absent)?.[1];
  const miss = !r ? ' bad' : '';
  const tip = r ? (r.how || '') : `${platform} 侧还没有这个操作的实现`;
  return `<a class="opref${miss}" href="#run=ops" data-op="${esc(opId)}" title="${esc(tip)}">🔗 ${esc(o.title)}</a>`;
}

function renderOps() {
  const ids = Object.keys(OPS);
  if (!ids.length) return '<div class="meta">操作库为空（ops/registry.json）</div>';
  const cards = ids.map(id => {
    const o = OPS[id];
    const plats = Object.entries(o.platforms || {});
    const have = plats.filter(([, r]) => r && !r.absent).map(([k]) => k.split('@')[0]);
    const miss = ['ios', 'android'].filter(p => !have.includes(p));
    const rows = plats.map(([plat, r]) => {
      // steps 是「傻瓜式」那一层：编号 + 怎么做 + 配图。其余键仍按原样列出。
      const stepsHtml = Array.isArray(r?.steps) && r.steps.length
        ? `<ol class="opsteps">` + r.steps.map(s =>
            `<li><b>${esc(s.do || '')}</b><div class="ophow">${esc(s.how || '')}</div>` +
            (s.shot ? `<img class="opshot" src="${imgSrc(s.shot, join(ROOT, s.shot))}" loading="lazy">` : '') +
            `</li>`).join('') + `</ol>`
        : '';
      const body = stepsHtml + Object.entries(r || {}).filter(([k]) => k !== 'steps').map(([k, v]) =>
        `<div class="opkv"><code>${esc(k)}</code> ${esc(Array.isArray(v) ? v.join('  ') : String(v))}</div>`).join('');
      return `<div class="opplat"><div class="opplat-h">${esc(plat)}${r && r.absent ? ' <span class="bk">缺实现</span>' : ''}</div>${body}</div>`;
    }).join('');
    // 谁引用了这条操作 —— 反向索引，等于 wiki 的「链入页面」
    const users = [];
    for (const d of demandList) for (const c of d.cases) {
      walkTree(c.tree || [], (n) => { if (n.op_id === id) users.push(`${c.case}`); });
    }
    const uniq = [...new Set(users)];
    return `<div class="opcard" id="op-${esc(id)}">
      <div class="oph"><b>${esc(o.title)}</b> <code>${esc(id)}</code>
        ${miss.length ? `<span class="bk">${esc(miss.join(','))} 侧缺实现</span>` : '<span class="pill pass">两端都有</span>'}</div>
      <div class="opwhy">${esc(o.why || '')}</div>
      ${rows}
      ${o.notes ? `<div class="opwhy">备注：${esc(o.notes)}</div>` : ''}
      ${Array.isArray(o.pitfalls) && o.pitfalls.length ? `<div class="oppit"><b>坑</b><ul>${o.pitfalls.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
      <div class="opusers">被引用：${uniq.length ? uniq.map(u => `<code>${esc(u)}</code>`).join(' ') : '<span class="dim">（还没有用例引用它）</span>'}</div>
    </div>`;
  }).join('');
  return `<div class="meta"><b>操作集</b> —— 用例只说<b>做什么</b>，各平台各自说<b>怎么做</b>。
    用例里带 🔗 的地方点进来就是这一页对应的条目。<br>
    某个操作在某平台没有实现，会在这里直接标出来 —— 那是「这条用例在那个平台跑不了」的<b>提前预警</b>，
    而不是等跑到一半才发现。</div>${cards}`;
}

function renderTree(nodes, results, steps, dir, prefix = 'n', casePlatform = '', reviews = null, caseName = '') {
  return `<ul class="tree">` + (nodes || []).map((n, i) => {
    const nodeId = `${prefix}${i + 1}`;
    // per-path 状态：这条路线下面几条断言、各是什么状态、没过的为什么没过
    const roll = tallyOf(walkExpects([n]), results);
    const agg = roll.agg;
    const tags = Object.entries(n.tags || {}).map(([k, v]) => `<code class="tag">${esc(k)}:${esc(v)}</code>`).join(' ');
    const st = steps[nodeId];
    const stepLine = st && (st.evidence || []).length
      ? `<li class="step">🎞️ <span class="dim">过程证据</span> ${(st.evidence || []).map(x => evChip(x, dir, rvOf(reviews, `step:${nodeId}`, x))).join(' ')}${st.note ? `<div class="ac">${esc(st.note)}</div>` : ''}</li>` : '';
    const asserts = (n.expect || []).map(e => {
      const v = results[e.id] || { status: 'todo' };
      // ⛔ 要说清是谁的问题：能力缺口 = 该修工具；依赖阻塞 = 该上报。两者都不是「被测行为失败」。
      const bk = v.blocked_kind === 'capability'
        ? '<span class="bk cap">验不了 · 我的测试能力缺口</span>'
        : v.blocked_kind === 'dependency' ? '<span class="bk dep">验不了 · 外部依赖阻塞</span>'
        : (v.status === 'blocked' ? '<span class="bk">验不了 · 未分类</span>' : '');
      // 走的是哪条路：界面验证人能直接看图确认；命令行验证带上「为什么界面上看不到」
      const via = viaOf(e), viaTag = via === 'ui' ? `<span class="via ui">${VIA_LABEL.ui}</span>` : `<span class="via cli" title="${esc(e.why_not_ui || '')}">${VIA_LABEL[via]} · ${esc(String(e.why_not_ui || '没写理由').slice(0, 40))}</span>`;
      return `<li class="as-li st-${v.status}">${ICON[v.status] || '·'} <code class="aid">${esc(e.id)}</code> ${esc(e.assert)} ${viaTag} ${bk}` +
        (e.expect_data ? `<div class="exd"><b>预期</b> <code>${esc(e.expect_data)}</code></div>` : '') +
        // 「怎么观测才算 pass/fail」—— observe 是可执行规格（acceptkit observe 照它跑）；只有 machine 文本的如实标出未机判化
        (e.observe ? `<div class="exd"><b>观测</b> <code>${esc(fmtObserve(e.observe))}</code></div>`
          : e.machine ? `<div class="exd"><b>观测</b> <span class="dim">（文本，未机判化）</span> ${esc(e.machine)}</div>` : '') +
        (v.actual ? `<div class="ac"><b>实际</b> ${esc(v.actual)}</div>` : '') +
        // finding 可以很长（一条被驳回的复核意见几千字都有）。整段铺开会把它上面的
        // 断言/实际/证据全部挤出视野 —— 超过阈值就折叠，标题留够判断要不要点开。
        (v.finding ? (String(v.finding).length > 160
          ? `<details class="findd"><summary><span class="find">${esc(String(v.finding).slice(0, 140))}…</span> <span class="dim">展开全文（${String(v.finding).length} 字）</span></summary><div class="find">${esc(v.finding)}</div></details>`
          : ` <span class="find">${esc(v.finding)}</span>`) : '') +
        ((v.evidence || []).length ? `<div class="evs">${v.evidence.map(x => evChip(x, dir, rvOf(reviews, e.id, x))).join(' ')}</div>` : '') +
        blockerChips(caseName, e.id) + `</li>`;
    }).join('');
    // 条件 / 说明 / 具体输入 —— QA 那套用例的三件套：这一支在什么条件下成立、
    // 为什么这么判、以及可以直接复制去执行的输入。没有 data 的节点照旧渲染。
    const givenLine = n.given ? `<div class="given"><span class="glbl">条件</span> ${esc(n.given)}</div>` : '';
    const noteLine = n.note ? `<div class="nnote">${esc(n.note)}</div>` : '';
    const dataLine = n.data
      ? `<div class="ndata"><span class="glbl">输入</span><pre>${pretty(n.data)}</pre></div>` : '';
    return `<li class="node st-node-${agg}"><div class="nhead"><span class="dot ${statusClass(agg)}"></span>` +
      `<code class="nid">${nodeId}</code> <b>${esc(n.op)}</b> ${tags} ${opRef(n.op_id, casePlatform)}` +
      (roll.n ? ` <span class="pstat">${tallyBadges(roll.tally)}</span>` : '') + `</div>` +
      whyLine(roll.why) + givenLine + noteLine + dataLine +
      `<ul class="inner">${stepLine}${asserts}</ul>` +
      (n.conclusion ? `<div class="concl">⇒ ${esc(n.conclusion)}</div>` : '') +
      (n.children?.length ? renderTree(n.children, results, steps, dir, `${nodeId}.`, casePlatform, reviews, caseName) : '') + `</li>`;
  }).join('') + `</ul>`;
}

// ---------- 一次「执行」= 左侧一行 ----------
// 组织结构（不要按「每个用例的每次 run 各一行」摊在左边 —— 那样同一轮验收会被拆成很多行，
// 需求页还得靠链接互跳到别的 run，那个跳转就是不对的地方）：
//   ① 每提一个验收/复现需求、执行一次 = 一条总记录 = 左侧一行
//   ② 一次执行里验收 X 条用例，X 条按模块分成 Y 组（覆盖率一组、策略回归一组…）
//   ③ 组里才是精细的：输入什么 / 操作什么 / 预期什么 / 实际什么
//   ④ 用例可复用；但结果与证据属于「这一次执行」
// 所以：面板自包含，不出现跨执行的跳转链接；同一用例在本次执行里跑了多轮，
// 取最新一轮为结果，早先几轮只作为「本次执行内的重试」留痕，不另开页。
// 一个用例 = 树上一个可展开节点（不要独立标题、不要「未分组」桶）。
// summary 行自带 ①状态点 ②断言计数徽章 ③日期/run —— 折叠着也能看出这条用例跑成什么样；
// 展开才是逐条路线（per-path 状态 + 没过的原因）与证据。
function caseTreeNode(c, runsOfCase, { compact = false } = {}) {
  const rs = runsOfCase || [];
  const latest = rs.length ? rs[rs.length - 1] : null;
  const results = latest?.res?.results || {};
  const steps = latest?.res?.steps || {};
  const reviews = latest?.res?.reviews || null;
  const dir = latest?.dir || null;
  const roll = tallyOf(walkExpects(c.tree || []), results);
  // 日期只认真的日期。以前无脑 `(started_at || run_id).slice(0,10)`，而 run id 不一定是
  // 日期打头（如 `smoke-login-…`），于是树上出现一个叫「smoke-logi」的「日期」。
  const DATE_RE = /^\d{4}-\d{2}-\d{2}/;
  const dates = rs.map(r => {
    const t = r.res?.started_at || r.res?.recorded_at || '';
    if (DATE_RE.test(t)) return t.slice(0, 10);
    if (DATE_RE.test(r.id || '')) return r.id.slice(0, 10);
    try { return statSync(join(r.dir, 'result.json')).mtime.toISOString().slice(0, 10); } catch { return ''; }
  }).filter(Boolean);
  const dateTxt = dates.length
    ? `${dates[0]}${dates.length > 1 ? ` … ${dates[dates.length - 1]}（${dates.length} 次）` : ''}`
    : (rs.length ? '跑过（无日期）' : '未跑');
  const verdict = latest?.res?.verdict;
  const gaps = latest?.meta?.evidence_gaps || 0;

  // 画廊：只展示被断言/步骤引用、且没被复核驳回的图（孤儿图折叠留档，不冒充「现场截图」）
  let gallery = '', orphansHtml = '';
  if (latest) {
    const rvs = reviews || {};
    const alive = (scope, x) => { const st = rvs[`${scope}::${x}`]?.state; return !st || st === 'ok' || st === 'pending'; };
    const refd = new Set([
      ...Object.entries(results).flatMap(([id, v]) => (v.evidence || []).filter(x => alive(id, x))),
      ...Object.entries(steps).flatMap(([sid, st]) => (st.evidence || []).filter(x => alive(`step:${sid}`, x)))]);
    // 图按身份分三档（不分档的话画廊里各种来路的截图混在一起，读不出哪张是证据）：
    //   判定图 = observe UI 通道产出 / 判定卡 → 主画廊；过程截图（acceptkit shot）→ 折叠「过程」；
    //   手工截图（没有工具痕迹）→ 折叠「不作证据」。孤儿图照旧折叠留档。
    const KIND_LABEL = { ui_observe: '📱 观测截图', card: '🧾 判定卡', process: '🎞 过程', unverified: '⚠️ 手工' };
    const kindOf = s => imageKind(latest.dir, s.rel.replace(`runs/${latest.id}/`, '')) || 'unverified';
    const cell = s => `<figure class="gcell k-${kindOf(s)}"><img loading="lazy" src="${imgSrc(s.rel, s.path)}" alt="${esc(s.name)}"/><figcaption>${KIND_LABEL[kindOf(s)] || ''} ${esc(s.name)}</figcaption></figure>`;
    const isRef = s => refd.has(s.rel.replace(`runs/${latest.id}/`, ''));
    const refShots = latest.shots.filter(isRef);
    const judged = refShots.filter(s => ['ui_observe', 'card'].includes(kindOf(s)));
    const proc = refShots.filter(s => kindOf(s) === 'process');
    const manual = refShots.filter(s => kindOf(s) === 'unverified');
    gallery = judged.map(cell).join('');
    const orphans = latest.shots.filter(s => !isRef(s));
    orphansHtml = (proc.length ? `<details><summary class="dim">🎞 过程截图 ${proc.length} 张（acceptkit shot：证明 app 在跑、停在哪页；不是判定证据）</summary><div class="gal">${proc.map(cell).join('')}</div></details>` : '')
      + (manual.length ? `<details><summary class="dim">⚠️ 手工截图 ${manual.length} 张（没有任何工具痕迹：不知道哪台机器、哪个 pid、读到了什么 —— 不作证据）</summary><div class="gal">${manual.map(cell).join('')}</div></details>` : '')
      + (orphans.length ? `<details><summary class="dim">另有 ${orphans.length} 张图没有被断言/步骤引用、或已被复核驳回（仅留档，不是结果证据）</summary><div class="gal">${orphans.map(cell).join('')}</div></details>` : '');
  }

  const cg = latest ? claimGaps(c || {}, latest.res || {}) : [];
  const claims = (c?.claims || []).length ? `<div class="rule"><div class="rk">📣 用例主张（每句都要由断言证实，且证据已复核）</div>${c.claims.map(cl => {
      const bad = cg.find(g => g.startsWith(`「${cl.text}」`));
      return `<div>${bad ? '❌' : '✅'} ${esc(cl.text)} <span class="dim">← ${esc((cl.proved_by || []).join(' '))}${bad ? ' · ' + esc(bad.replace(`「${cl.text}」`, '')) : ''}</span></div>`;
    }).join('')}</div>` : '';
  const retries = rs.slice(0, -1);
  const gates = (latest?.meta?.gates || []).map(g => `<code>${esc(g.action)} → ${esc(g.verdict)}</code>`).join(' ');

  return `<details class="ctree st-${roll.agg}" id="case-node-${esc(c.case)}">
    <summary><span class="dot ${statusClass(roll.agg)}"></span>
      <span class="ct-t">${esc(c.title || c.case)}</span>
      <code class="ct-id">${esc(c.case)}</code>
      <span class="pstat">${roll.n ? tallyBadges(roll.tally) : '<span class="tb todo">无断言</span>'}</span>
      ${latest && latest.shots.length ? `<span class="tb shot">📷${latest.shots.length}</span>` : ''}
      <span class="dim ctree-d">${esc(dateTxt)}${latest ? ` · <code>${esc(latest.id)}</code>` : ''}${verdict ? ` · ${esc(verdict)}` : ''}</span>
      ${gaps ? `<span class="tb fail">证据缺口 ${gaps}</span>` : ''}
      ${latest?.meta?.apparatus ? `<span class="tb todo" title="取证手段自己坏了的次数：不计入结论，但报告的可信度按它折价">🔧 装置故障 ${latest.meta.apparatus}</span>` : ''}
      <a class="caselink" href="#run=case:${esc(c.case)}" title="打开用例详情">↗</a></summary>
    <div class="ctree-b">
      ${whyLine(roll.why)}
      ${retries.length ? `<div class="dim">本次执行内重试 ${retries.length} 轮：${retries.map(r => `<code>${esc(r.id)}</code>`).join(' ')} —— 下面是最后一轮的结果</div>` : ''}
      ${!compact && c.rule ? `<div class="rule"><div class="rk">📐 被测规则（先看这个，再看断言）</div>${esc(c.rule).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>')}</div>` : ''}
      ${!compact && c.report ? `<div class="rep">${Object.entries(c.report).map(([k, v]) => `<div><span class="k">${esc(k)}</span>${esc(v)}</div>`).join('')}</div>` : ''}
      ${!compact ? claims : ''}
      ${gallery ? `<details class="galwrap" open><summary><b>📷 判定图</b> <span class="dim">observe 截图 / 判定卡 · 点开大图</span></summary><div class="gal">${gallery}</div></details>` : ''}
      ${renderTree(c.tree || [], results, steps, dir, 'n', c.platform || '', reviews, c.case)}
      ${!compact && dir ? runExtras(dir) : ''}
      ${gates ? `<div class="dim">⛔ 过闸留痕 ${gates}</div>` : ''}
      ${orphansHtml}
    </div></details>`;
}

function renderExecPanel(ex, first) {
  // ── whole 状态：整轮一个结论，按**断言**算，不是按用例的 verdict 算 ──
  // 按 verdict 算会把「一条用例里 9 条没跑、1 条过」读成「通过」；按断言算才是真实覆盖。
  // ⚠️ 断言 id 只在**单条用例内**唯一（每条用例都有自己的 E1..E10）。
  // 以前这里把各用例的 results 合并成一个字典再统计 —— 后一条用例的 E1 会覆盖前一条的 E1，
  // 于是「通过 4 条」被吃成「通过 0 条」。正解是逐用例各算各的，再把计数相加。
  const whole = sumTallies(ex.cases.map(({ c, rs }) =>
    tallyOf(walkExpects(c.tree || []), rs[rs.length - 1]?.res?.results || {})));
  // 标题按**最严重**的状态取名会误导：94 条里 74 条压根没跑、20 条验不了时，
  // rollup 是 blocked，写成「有验不了的」听起来像「试过了但办不到」——把「根本没试」藏了起来。
  // 所以标题先报完成度（通过几条 / 共几条），再点名占比最大的未完成项。
  const wholeTxt = (() => {
    if (!whole.n) return '没有断言';
    const t = whole.tally;
    if (t.pass === whole.n) return `全部通过（${whole.n}/${whole.n}）`;
    if (t.pass + t.na === whole.n) return `全部通过（${t.pass} 条），另 ${t.na} 条版本不适用`;
    const rest = [['fail', '失败'], ['blocked', '验不了'], ['todo', '没跑'], ['skip', '跳过'], ['na', '版本不适用']]
      .filter(([k]) => t[k]).sort((a, b) => t[b[0]] - t[a[0]]);
    const head = t.fail ? '有失败' : '未完成';
    return `${head} —— 通过 ${t.pass}/${whole.n}，` + rest.map(([k, n]) => `${n} ${t[k]} 条`).join('、');
  })();

  // 审批状态：整轮一句话说清「这批用例被批准了没有」—— 以前埋在评审单折叠件的说明文字里。
  const plan = loadPlanFor(ex.demand.id);
  const appr = !plan
    ? `<span class="appr none">无评审单</span>`
    : plan.approved_at
      ? `<span class="appr ok">已批准</span><span class="dim">${esc(plan.approved_by || '')} · ${esc((plan.approved_at || '').slice(0, 10))} · v${esc(String(plan.revision))}</span>`
      : `<span class="appr wait">⚠️ 未批准</span><span class="dim">评审单 v${esc(String(plan.revision))} 还没过闸</span>`;

  return `<section class="panel" data-k="${esc(ex.session)}" ${first ? '' : 'hidden'}>
    <div class="phead"><h1>${esc(ex.demand.title)}</h1><button class="copylink" data-k="${esc(ex.session)}">🔗 复制链接</button></div>
    <div class="whole st-${whole.agg}">
      <div class="whole-h"><span class="dot ${statusClass(whole.agg)}"></span><b>整轮状态：${esc(wholeTxt)}</b>
        <span class="pstat">${tallyBadges(whole.tally)}</span>
        <span class="dim">共 ${whole.n} 条断言 · ${ex.cases.length} 个用例 · ${ex.runCount} 次 run</span></div>
      ${whyLine(whole.why, { ids: false })}
      <div class="whole-h" style="margin-top:4px"><span class="dim">审批状态</span>${appr}</div>
    </div>
    <div class="meta">执行 <code>${esc(ex.session)}</code> · ${esc(ex.date)} · 需求 ${esc(ex.demand.id)}</div>
    ${ex.demand.desc ? `<p class="desc">${esc(ex.demand.desc)}</p>` : ''}
    ${ex.supersededBy ? `<div class="wild">↻ 本轮的全部用例已在执行 <code>${esc(ex.supersededBy)}</code> 里以更高 run_seq 完整复跑 —— 本页是历史留痕（当时的受阻/中间态），最终结论以那一轮为准。</div>` : ''}
    ${(ex.cases || []).flatMap(v => v.rs).filter(r => r.res?.superseded_by).map(r => `<div class="wild">⛔ <code>${esc(r.res.run)}</code> 已被 <code>${esc(r.res.superseded_by)}</code> 取代，<b>不补审、不计入复核欠账</b>。${esc(r.res.superseded_note || '（没写原因 —— 该补上）')}</div>`).join('')}
    <div class="ghead" style="margin-top:14px">▍用例树 <span class="dim">改动面 → 用例 → 路线 → 断言 · 默认折叠</span>
      <span class="treebar"><button data-act="bad">只展开没过的</button><button data-act="all">全展开</button><button data-act="none">全折叠</button></span></div>
    ${renderOneTree(ex.demand.id, ex.cases)}
    ${blockerSummary(ex.demand.id)}
  </section>`;
}

// ── 流水线可见化：评审单 + 阻塞台账要出现在看板上 ──
// 不上看板 = owner 只能从对话里看到它们，下次还是得靠他主动问。
function loadPlanFor(demandId) {
  try { return JSON.parse(readFileSync(join(ROOT, 'state', 'plans', `${demandId}.json`), 'utf8')); } catch { return null; }
}
function loadBlockersFor(demandId) {
  try {
    return readFileSync(join(ROOT, 'state', 'blockers', `${demandId}.jsonl`), 'utf8')
      .split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
// ── 一棵树（评审单本身就是用例树，不该是一个独立的东西）──
// 改动面不是「另一份文档」，它就是树的**第一层**：一条改动面 → 它覆盖的用例 → 路线 → 断言 → 阻塞。
// QA 平台上常见的用例集就是这个形状：评审看的内容和执行看的内容是同一棵树，不是两份。
/** 阻塞台账只剩「还没提给 owner」这一类提示 —— 明细已经长在树上对应的断言旁边。 */
function blockerSummary(demandId) {
  const un = loadBlockersFor(demandId).filter(b => !b.reported && !b.resolved);
  if (!un.length) return '';
  return `<div class="wild">⚠️ ${un.length} 条阻塞还没提给 owner：${un.map(b =>
    `<code>${esc(b.case)}/${esc(b.expect)}</code>`).join(' ')} —— 明细在树上对应的断言旁边</div>`;
}

function renderOneTree(demandId, execCases) {
  const plan = loadPlanFor(demandId);
  const inExec = new Map((execCases || []).map(({ c, rs }) => [c.case, rs]));
  const runsOf = (name) => inExec.get(name) || (CASE_RUNS && CASE_RUNS[name]) || [];
  const used = new Set();

  const caseNode = (name) => {
    const cs = ALL_CASES && ALL_CASES[name];
    if (!cs) return `<div class="wild">⚠️ 评审单点名的用例 <code>${esc(name)}</code> 不存在</div>`;
    used.add(name);
    // 执行面板只讲**这一轮**：本轮跑过的用例完整渲染（树 + 证据）；评审单点名但本轮没跑的只留一行存根，
    // 指向用例详情。以前不分 —— 每个面板都把评审单点名的全部用例连同它们别的轮次的证据整棵内联，
    // 需求↔用例改成多对多后一条用例会出现在多张评审单里，看板体积直接翻了三倍。
    if (!inExec.has(name)) {
      const rs = runsOf(name); const last = rs.length ? rs[rs.length - 1] : null;
      return `<div class="ctree st-todo stub"><span class="dot wip"></span> <span class="ct-t">${esc(cs.title || name)}</span> <code class="ct-id">${esc(name)}</code>
        <span class="tb todo">本轮没跑</span>${last ? ` <span class="dim">最近 <code>${esc(last.id)}</code> ${esc(String(last.res?.verdict || ''))}</span>` : ''}
        ${platChips(cs)} <a class="caselink" href="#run=case:${esc(name)}" title="打开用例详情">↗</a></div>`;
    }
    return caseTreeNode(cs, runsOf(name));
  };

  let h = '';
  if (plan) {
    for (const sf of plan.surfaces || []) {
      const names = [...(sf.reuse || []), ...(sf.new || [])];
      const r = sumTallies(names.map(n => {
        const cs = ALL_CASES && ALL_CASES[n]; if (!cs) return { tally: {}, why: new Map(), n: 0, agg: 'todo' };
        const rs = runsOf(n);
        return tallyOf(walkExpects(cs.tree || []), rs.length ? (rs[rs.length - 1].res.results || {}) : {});
      }));
      const sev = sf.severity === '必测' ? '<span class="sev must">必测</span>'
                : sf.severity ? `<span class="sev">${esc(sf.severity)}</span>` : '';
      h += `<details class="ctree sfnode st-${r.agg}">
        <summary><span class="dot ${statusClass(r.agg)}"></span><code class="ct-id">${esc(sf.id)}</code>
          <span class="ct-t">${esc(sf.change || '')}</span> ${sev}
          <span class="pstat">${tallyBadges(r.tally)}</span>
          ${(() => { const n = names.reduce((a, x) => { const rs = runsOf(x); return a + (rs.length ? rs[rs.length - 1].shots.length : 0); }, 0);
                     return n ? `<span class="tb shot">📷${n}</span>` : ''; })()}
          <span class="dim">${names.length} 个用例</span></summary>
        <div class="ctree-b">
          ${sf.risk ? `<div class="sfc-r"><b>坏了会怎样</b> ${esc(sf.risk)}</div>` : ''}
          ${sf.covered ? `<div class="sfc-l"><b>覆盖</b> ${esc(sf.covered)}</div>` : ''}
          ${sf.uncovered ? `<div class="sfc-u"><b>没覆盖</b> ${esc(sf.uncovered)}</div>` : ''}
          ${sf.decide ? `<div class="sfc-d"><b>要你定</b> ${esc(sf.decide)}</div>` : ''}
          ${whyLine(r.why, { ids: false })}
          ${names.length ? names.map(caseNode).join('') : '<div class="dim">这条改动面还没挂用例</div>'}
        </div></details>`;
    }
    // 待测：改动了但还没测上的，挂成同一层的节点（不是另一张表）
    for (const n of plan.not_covered || []) {
      h += `<details class="ctree sfnode st-todo"><summary><span class="dot wip"></span>
        <code class="ct-id">${esc(n.id)}</code><span class="ct-t">待测 · ${esc(n.what)}</span>
        <span class="tb todo">还没测上</span></summary>
        <div class="ctree-b"><div class="sfc-u"><b>现在为什么测不了</b> ${esc(n.why)}</div>
          <div class="sfc-l"><b>什么条件下测得上</b> ${n.unlock ? esc(n.unlock) : '<b>⚠️ 没写</b>'}</div>
          ${n.cost ? `<div class="sfc-l"><b>成本</b> ${esc(n.cost)}</div>` : ''}</div></details>`;
    }
    // 行为变更：不是测试项，是要 owner 拍板的事，同样挂在树上
    for (const f of plan.findings || []) {
      const done = !!f.decided_by || !!f.settled;
      h += `<details class="ctree sfnode st-${done ? 'pass' : 'blocked'}"><summary>
        <span class="dot ${done ? 'pass' : 'wip'}"></span><code class="ct-id">${esc(f.id)}</code>
        <span class="ct-t">行为变更 · ${esc(f.what)}</span>
        <span class="tb ${done ? 'pass' : 'blk'}">${findingStatus(f)[0]}</span></summary>
        <div class="ctree-b">${f.kind ? `<div class="sfc-l"><b>性质</b> ${esc(FINDING_KINDS[f.kind] || f.kind)}</div><div class="sfc-l"><b>影响范围</b> ${esc(f.impact || '')}</div><div class="sfc-l"><b>为什么</b> ${esc(f.why || '')}</div>` : ''}${f.detail ? `<div class="sfc-l"><b>细节</b> ${esc(f.detail)}</div>` : ''}
          ${findingConclusion(f)}</div></details>`;
    }
  }
  // 本轮跑了、但评审单没点名的用例 —— 必须显形，否则「跑了没人评审过的东西」看不见
  const orphan = (execCases || []).filter(({ c }) => !used.has(c.case));
  if (orphan.length) {
    const r = sumTallies(orphan.map(({ c, rs }) => tallyOf(walkExpects(c.tree || []), rs[rs.length - 1]?.res?.results || {})));
    h += `<details class="ctree sfnode st-${r.agg}" open><summary><span class="dot ${statusClass(r.agg)}"></span>
      <span class="ct-t">本轮跑了、但评审单没点名的用例</span>
      <span class="pstat">${tallyBadges(r.tally)}</span><span class="dim">${orphan.length} 个用例</span></summary>
      <div class="ctree-b">${orphan.map(({ c, rs }) => caseTreeNode(c, rs)).join('')}</div></details>`;
  }
  if (!plan) h = `<div class="dim">无用例评审单 —— <code>acceptkit plan new ${esc(demandId)}</code></div>` + h;
  return h;
}
function planCasesOf(plan) {
  const out = new Set();
  for (const s of plan?.surfaces || []) for (const x of [...(s.reuse || []), ...(s.new || [])]) out.add(x);
  return out;
}

// 树遍历 / 断言计数（用例集合视图用；与 acceptkit CLI 的同名逻辑保持一致）
function walkTree(nodes, cb) {
  (nodes || []).forEach(n => { cb(n); if (n.children) walkTree(n.children, cb); });
}
function countExpects(c) {
  let n = 0; walkTree(c.tree || [], node => { n += (node.expect || []).length; });
  return n;
}

// ---------- 用例集合（资产视图）----------
// 用例是资产（操作树 × 断言 × 切面），run 是一次执行。需求面板按 run 讲故事，这里按用例讲家底：
// 每条用例有多少节点/断言、归哪条需求、跑过几次、最近一次结论。
/**
 * 单条用例的详情页 —— 对标常见用例管理平台的详情页：一条用例自己就是一份可读的规格，
 * 不依赖任何一次 run 也能看懂「验什么、什么条件下、喂什么、预期什么」。
 * 之前只有一张清单表格，点不进来，等于清单没有下一层。
 */
/**
 * 引用式用例集（suite）：`includes` 列成员 case id，本身不带成员的断言。
 * 数字全部在渲染时从被引用的用例现算 —— 成员改了这里立刻跟着变，
 * 不存在「两份清单要手工同步」这种必然会腐烂的东西。
 */
function renderIncludes(c) {
  const ids = c.includes || [];
  if (!ids.length) return '';
  const idx = new Map(Object.entries(ALL_CASES));
  let nStrat = 0, nExp = 0;
  const rows = ids.map(id => {
    const m = idx.get(id);
    if (!m) return `<tr><td colspan="4"><span class="bk">⚠ 引用了不存在的用例 <code>${esc(id)}</code></span></td></tr>`;
    let nodes = 0; walkTree(m.tree || [], () => nodes++);
    const e = countExpects(m); nExp += e;
    // 成员里「一条策略 = 一个子节点」，减去根节点即策略数
    const s = Math.max(0, nodes - 1); nStrat += s;
    const runs = (m._runs || []); const last = runs[runs.length - 1];
    return `<tr>
      <td><a class="caselink" href="#run=case:${esc(id)}"><b>${esc(m.title || id)}</b></a><br><small class="mono">${esc(id)}</small></td>
      <td style="text-align:right">${s}</td><td style="text-align:right">${e}</td>
      <td>${last ? `<span class="pill ${statusClass(last.res?.verdict)}">${esc(String(last.res?.verdict))}</span>` : '<span class="dim">未跑</span>'}</td>
    </tr>`;
  }).join('');
  return `<div class="rule"><b>🔗 成员（引用，非复制）</b>
    <div class="dim" style="margin:3px 0 6px">下面的数字在打开本页时从成员用例现算：共 ${ids.length} 个成员 · ${nStrat} 条策略 · ${nExp} 条断言。
    成员改了这里自动跟着变。</div>
    <table class="cases"><thead><tr><th>成员用例</th><th>策略</th><th>断言</th><th>最近</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderCaseDetail(c) {
  const runs = (c._runs || []).slice().sort((a, b) => a.id.localeCompare(b.id));
  const last = runs[runs.length - 1];
  let nodes = 0; walkTree(c.tree || [], () => nodes++);
  const pre = (c.preconditions || []).map(x => `<li>${esc(x)}</li>`).join('');
  const cls = Object.entries(c.classifications || {})
    .map(([k, vs]) => `<code class="tag">${esc(k)}: ${esc((vs || []).join(' / '))}</code>`).join(' ');
  // 规格页不带实际/证据，所以每一行必须能点进那次执行的面板（证据在那里），否则是死路。
  const runRows = runs.map(r => `<tr><td>${r.res?.session
      ? `<a class="caselink" href="#run=${esc(r.res.session)}"><code class="mono">${esc(r.id)}</code> → 看实际与证据</a>`
      : `<code class="mono">${esc(r.id)}</code>`}</td>
    <td><span class="pill ${statusClass(r.res?.verdict)}">${esc(String(r.res?.verdict ?? '?'))}</span></td></tr>`).join('')
    || '<tr><td colspan="2" class="dim">还没有跑过</td></tr>';
  // 规格视图：断言只显示预期，不显示某一次的实际（实际属于 run，不属于用例本身）
  // 规格页以前传空结果 ⇒ 每条断言都显示「未跑」，读的人以为没测（看到一片「未跑」会被误导）。
  // 现在填「最近一次记录」：所有 run 里按记录时间取最新那条；证据在那次执行的面板里，这里只写出处。
  const latest = {};
  for (const r of runs) {
    for (const [eid, x] of Object.entries(r.res?.results || {})) {
      if (!x || x.status === 'todo') continue;
      const t = recordTime(r.dir, r.res, eid);
      if (!latest[eid] || t >= latest[eid]._t)
        latest[eid] = { status: x.status, blocked_kind: x.blocked_kind, na_since: x.na_since, finding: x.finding,
                        actual: `［最近记录：${r.id} · ${new Date(t).toISOString().slice(0, 16).replace('T', ' ')}］ ${x.actual || ''}`, evidence: [], _t: t };
    }
  }
  const spec = renderTree(c.tree || [], latest, {}, '', 'n', c.platform || '');
  return `<section class="panel" data-k="case:${esc(c.case)}" hidden>
    <div class="phead"><h1>${esc(c.title || c.case)}</h1>
      <button class="copylink" data-k="case:${esc(c.case)}">🔗 复制链接</button></div>
    <div class="meta"><code>${esc(c.case)}</code>
      · 被引用于 ${(c._demandIds || []).length ? c._demandIds.map(d => `<a class="caselink" href="#run=${esc(d)}"><code>${esc(d)}</code></a>`).join(' ') : '<span class="dim">（没有评审单引用）</span>'}
      ${c.origin?.id ? `· 出处 <code>${esc(c.origin.id)}</code>` : ''}
      · 平台 ${platChips(c)} · ${nodes} 个操作节点 / ${countExpects(c)} 条断言
      · 跑过 ${runs.length} 次${last ? ` · 最近 <span class="pill ${statusClass(last.res?.verdict)}">${esc(String(last.res?.verdict))}</span>` : ''}
      · <a href="#run=allcases" class="opref">← 回用例清单</a></div>
    ${renderIncludes(c)}
    ${c.why ? `<div class="rule"><b>为什么要有这条用例</b><div>${esc(c.why)}</div></div>` : ''}
    ${c.rule ? `<div class="rule"><b>被测规格</b><div>${esc(c.rule)}</div></div>` : ''}
    ${(c.claims || []).length ? `<div class="rule"><b>用例主张 → 由哪些断言证实</b>${c.claims.map(cl => `<div>· ${esc(cl.text)} <span class="dim">← ${esc((cl.proved_by || []).join(' '))}</span></div>`).join('')}</div>` : ''}
    ${pre ? `<h3>前置条件</h3><ul class="pre">${pre}</ul>` : ''}
    ${cls ? `<h3>覆盖切面</h3><div>${cls}</div>` : ''}
    <h3>操作 × 条件 × 输入 × 预期</h3>
    ${spec}
    <h3>历史执行</h3>
    <table class="cases"><thead><tr><th>run</th><th>结论</th></tr></thead><tbody>${runRows}</tbody></table>
  </section>`;
}

// 平台芯片：算出来的适用性（声明 + 操作库配方），不是谁写的
function platChips(c) {
  const ap = c._ap || applicability(c, OPS_FOR_PLAT, PROJ.config);
  // web 列只在用例显式声明 web 时出现（both = iOS + Android）
  return RUNTIME_PLATFORMS.filter(p => p !== 'web' || ap.web?.declared).map(p => {
    const x = ap[p];
    const cls = !x.declared ? 'na' : x.ok ? 'ok' : 'bad';
    const txt = !x.declared ? `${PLATFORM_LABEL[p]} －` : x.ok ? `${PLATFORM_LABEL[p]} ✓` : `${PLATFORM_LABEL[p]} ✗`;
    const tip = !x.declared ? `用例未声明适用 ${PLATFORM_LABEL[p]}` : x.ok ? `声明适用且用到的操作都有 ${PLATFORM_LABEL[p]} 配方` : `缺配方：${x.missing.join(', ')}`;
    return `<span class="plat ${cls}" title="${esc(tip)}">${txt}</span>`;
  }).join('') + (!normalizePlatforms(c).length ? '<span class="plat bad" title="用例缺 platform 字段，validate 会拒">缺声明</span>' : '');
}
function renderCaseLibrary() {
  const rows = [];
  for (const c of cases) {
    let nodes = 0; walkTree(c.tree || [], () => nodes++);
    const exps = countExpects(c);
    const runs = (c._runs || []).slice().sort((a, b) => a.id.localeCompare(b.id));
    const last = runs[runs.length - 1];
    rows.push({ demandIds: c._demandIds || [], origin: c.origin?.id || '', id: c.case, title: c.title || c.case, c,
                kind: c.kind || 'acceptance', nodes, exps, runN: runs.length,
                lastVerdict: last?.res?.verdict || (runs.length ? '?' : '未跑'), lastRun: last?.id || '' });
  }
  rows.sort((a, b) => a.id.localeCompare(b.id));
  const body = rows.map(r => `<tr>
    <td>${r.demandIds.length ? r.demandIds.map(d => `<a class="caselink" href="#run=${esc(d)}"><code>${esc(d)}</code></a>`).join(' ') : '<span class="dim">—</span>'}${r.origin ? `<br><small class="dim">出处 ${esc(r.origin)}</small>` : ''}</td>
    <td><a class="caselink" href="#run=case:${esc(r.id)}"><b>${esc(r.title)}</b></a><br><small class="mono">${esc(r.id)}</small></td>
    <td>${platChips(r.c)}</td>
    <td>${esc(r.kind)}</td>
    <td style="text-align:right">${r.nodes}</td>
    <td style="text-align:right">${r.exps}</td>
    <td style="text-align:right">${r.runN}</td>
    <td><span class="pill ${statusClass(r.lastVerdict)}">${esc(String(r.lastVerdict))}</span>
        ${r.lastRun ? `<br><small class="mono">${esc(r.lastRun)}</small>` : ''}</td>
  </tr>`).join('');
  const nUnref = rows.filter(r => !r.demandIds.length).length;
  const nNoPlat = rows.filter(r => !normalizePlatforms(r.c).length).length;
  return `<div class="meta">用例是<b>资产</b>（操作树 × 断言 × 切面），可被多条需求的评审单引用；run 是<b>一次为某条需求做的执行</b>。共 ${rows.length} 条用例${nUnref ? `，其中 ${nUnref} 条没有任何评审单引用` : ''}${nNoPlat ? `，<b>${nNoPlat} 条缺 platform 声明</b>` : ''}。
   平台列是算出来的：声明了该平台 且 用到的操作在该平台有配方。新建用例：<code>acceptkit new &lt;case&gt; --demand &lt;D&gt; --surface &lt;S&gt; --platform ios|android|both</code></div>
  <table class="cases"><thead><tr><th>被引用于</th><th>用例</th><th>平台</th><th>类型</th><th>节点</th><th>断言</th><th>run</th><th>最近结论</th></tr></thead>
  <tbody>${body}</tbody></table>`;
}



// 选中态的 key = session id（一次执行），不是下标：加执行不会把已分享的旧链接指到别处。
const caseOf = r => cases.find(c => c.case === r.res?.case);
// session → 需求 登记表（sessions.json，可缺省）。
let sessionDemands = {};
try { sessionDemands = JSON.parse(readFileSync(join(ROOT, 'sessions.json'), 'utf8')); } catch { /* 无登记表=全走反推 */ }
const demandOf = id => demands.get(id) || { id, title: id, desc: '' };

// 按 session 归并成「执行」；一次执行里同一用例可能跑了多轮，按 run_seq 升序留着，取最后一轮为结果。
const execMap = new Map();
for (const r of runs) {
  if (!r.res) continue;
  const c = caseOf(r);
  const sid = r.res.session || `${r.id.slice(0, 10)}-${r.res.demand?.id || c?.origin?.id || '未归档'}`;
  if (!execMap.has(sid)) execMap.set(sid, { session: sid, date: sid.slice(0, 10), byCase: new Map(), runCount: 0 });
  const ex = execMap.get(sid);
  ex.runCount++;
  if (!c) continue;
  if (!ex.byCase.has(c.case)) ex.byCase.set(c.case, { c, rs: [] });
  ex.byCase.get(c.case).rs.push(r);
  // 一次执行可以跨需求（例：回归轮 = D4 的 v0.0.2 资产复跑 + D5 的 v0.0.3 验收同 session）。
  // 以前这里单值覆盖，谁最后被扫到标题就是谁的 —— 跨需求执行的标题会张冠李戴。
  // run 自己记的需求优先（新版 result.json 带 demand）；老 run 退回用例出处
  const did = r.res.demand?.id || c.origin?.id || c.demand?.id || '未归档';
  (ex.demandIds ??= new Set()).add(did);
  ex.demandId = did;
}
const execs = [...execMap.values()].map(ex => {
  for (const v of ex.byCase.values()) v.rs.sort((a, b) => (a.res.run_seq || 0) - (b.res.run_seq || 0));
  // 需求是一等公民：session 登记的需求优先（sessions.json）。回归轮复用别的需求的用例资产，
  // 但需求归属是它自己的——从用例反推只是未登记时的退路。
  const registered = sessionDemands[ex.session]?.demand;
  const ids = [...(ex.demandIds || [ex.demandId])];
  let demand;
  if (registered) {
    demand = { id: registered.id || ex.session, title: registered.title || ex.session, desc: registered.desc || '' };
  } else if (ids.length <= 1) {
    demand = demandOf(ex.demandId);
  } else {
    // 未登记的跨需求执行：标题点名全部需求，不让最后一个用例的需求独占。
    const ds = ids.map(demandOf);
    demand = { id: ids.join('+'),
               title: ds.map(d => `${d.id}·${d.title}`).join(' ＋ '),
               desc: ds.map(d => d.desc).filter(Boolean).join('\n') };
  }
  return { ...ex, demand, cases: [...ex.byCase.values()] };
}).sort((a, b) => b.session.localeCompare(a.session));   // 时间倒序

// 「被取代」标注：一次执行里所有用例都有**更晚 session 的更高 run_seq**，说明这轮已被
// 完整复跑（典型：受阻轮 → 解锁后的实跑轮）。老行保留（历史事实），但必须显式标出去向，
// 否则读者点进旧链接会把受阻态当成终态（看板停在 blocked 轮，会被误读成回归没做完）。
{
  const latestByCase = new Map();   // case -> {seq, session}
  for (const r of runs) {
    if (!r.res?.case) continue;
    const cur = latestByCase.get(r.res.case);
    if (!cur || (r.res.run_seq || 0) > cur.seq) latestByCase.set(r.res.case, { seq: r.res.run_seq || 0, session: r.res.session || '' });
  }
  for (const ex of execs) {
    const laters = ex.cases.map(v => {
      const mine = v.rs[v.rs.length - 1].res.run_seq || 0;
      const g = latestByCase.get(v.c.case);
      return g && g.seq > mine && g.session && g.session !== ex.session ? g.session : null;
    });
    if (laters.length && laters.every(Boolean)) {
      ex.supersededBy = laters.sort((a, b) => laters.filter(x => x === b).length - laters.filter(x => x === a).length)[0];
    }
  }
}

const libs = (PROJ.config.libraries || []).map(renderLibrary).filter(Boolean);

// ---------- 需求执行记录：需求 → 轮（代码版本）→ 断言状态（本轮测 / 继承 / 重置）----------
// 要求：「执行记录按需求记录去展开；需求展开可以看到这个需求测试了几次；代码变更时评估影响范围后继承 & reset 上次的状态；
//   每次执行信息包含 分支名称 / commit 信息 / 最新 commit 时间。」数据与判法见 rounds.mjs、acceptkit round。
const RUN_BY_ID = new Map(runs.filter(r => r.res).map(r => [r.id, r]));
const resById = id => RUN_BY_ID.get(id)?.res || null;
const ST_LABEL = { pass: '通过', fail: '失败', blocked: '验不了', gap: '证据不全', todo: '待测', skip: '跳过', na: '版本不适用' };
const SRC_LABEL = { here: '本轮测', inherited: '继承', reset: '已重置·待测', never: '从没测过' };
const shortTime = iso => iso ? String(iso).replace('T', ' ').slice(0, 16) : '';
function demandCaseKeys(did) {
  const plan = allPlans(ROOT).find(p => p.demand === did);
  const names = new Set(plan ? planCaseSet(plan) : []);
  for (const r of runs) if ((r.res?.demand?.id || r.res?.demand) === did && r.res?.case) names.add(r.res.case);
  const keys = [];
  for (const n of names) { const c = cases.find(x => x.case === n); if (!c) continue; walkExpects(c.tree || [])(e => keys.push(`${n}::${e.id}`)); }
  return keys;
}
const demandRounds = [];
{
  const byDemand = new Map();
  for (const r of runs) { if (!r.res) continue; const did = r.res.demand?.id || r.res.demand; if (!did) continue;
    (byDemand.get(did) || byDemand.set(did, []).get(did)).push({ id: r.id, dir: r.dir, session: r.res.session || r.id.slice(0, 10) }); }
  for (const [did, rs] of byDemand) {
    const rf = loadRounds(ROOT, did) || { demand: did, repos: [], rounds: deriveHistory(rs, resById), _derived: true };
    if (!rf.rounds.length) continue;
    const recs = demandRecords(rs, resById);
    const keys = demandCaseKeys(did);
    const mem = roundMembers(rf, recs);
    const states = rf.rounds.map((_, i) => resolveState(rf, i, recs, keys));
    const last = recs.length ? Math.max(...recs.map(x => x.t)) : 0;
    demandRounds.push({ did, demand: demandOf(did), rf, recs, mem, states, last, runCount: rs.length });
  }
  demandRounds.sort((a, b) => b.last - a.last);
}
const stTally = st => { const t = { pass: 0, fail: 0, blocked: 0, gap: 0, todo: 0, skip: 0, na: 0 }; for (const v of st.values()) t[v.status] = (t[v.status] || 0) + 1; return t; };
const aggOf = t => t.fail ? 'fail' : (t.blocked || t.gap || t.todo) ? 'mixed' : 'pass';
function codeTable(rd) {
  const entries = Object.entries(rd.code || {});
  if (!entries.length) return `<div class="meta">这一轮执行时没有记录代码版本（存量）。</div>`;
  return `<table class="tbl"><thead><tr><th>仓</th><th>分支</th><th>commit</th><th>最新 commit 时间</th><th>工作区</th></tr></thead><tbody>` +
    entries.map(([n, c]) => `<tr><td>${esc(n)}</td><td><code>${esc(c.branch || '?')}</code></td>
      <td><code>${esc((c.commit || '').slice(0, 12))}</code> ${esc(c.subject || '')}</td><td>${esc(shortTime(c.committed_at))}</td>
      <td>${c.dirty ? `⚠️ ${c.dirty} 个已跟踪文件未提交` : '干净'}</td></tr>`).join('') + `</tbody></table>
    <div class="meta">代码版本来源：${({ provenance: 'run 的 provenance.json（执行时记录）', snapshot: '开轮时 acceptkit round new 现场取的 git 快照', unknown: '未记录' })[rd.code_source] || esc(rd.code_source)}</div>`;
}
function changesBlock(rd) {
  const ch = Object.entries(rd.changes || {});
  if (!ch.length) return rd.migrated ? `<div class="meta">存量轮：开轮时没有计算改动面。</div>` : '';
  return ch.map(([n, c]) => `<details class="smx"><summary><b>${esc(n)}</b> ${c.from ? `<code>${esc(c.from.slice(0, 10))}</code> → ` : ''}<code>${esc((c.to || '').slice(0, 10))}</code> ·
    ${c.count === null ? '改动面算不出（上一轮的 commit 不在本地历史）' : `${c.count} 个文件`}</summary>
    ${(c.files || []).length ? `<pre class="flist">${esc(c.files.slice(0, 300).join('\n'))}${c.files.length > 300 ? `\n…（共 ${c.files.length} 个）` : ''}</pre>` : ''}</details>`).join('');
}
// ---- findings 进轮面板：finding 及其结论要和轮次集成在一起 ----
const findIds = v => [...new Set(String(v || '').match(/\bF\d+\b/g) || [])];
// plan settle 写的 settled：执行者判断「不用 owner 定」，带理由、可推翻；不等于 owner 拍板（decided_by）
const SETTLED_LABEL = { superseded: '已被更正取代', answered: '已有答案', executor: '执行者自己的活' };
function findingStatus(f) {
  const dec = String(f.decision || '');
  if (f.decided_by && /^待办|^待定|^待 owner/.test(dec)) return ['待办（owner 要求先查）', 'wait'];
  // 旧数据里有执行者用 decide --by executor 自己落定的：不是 owner 拍板，照「执行者收口」显示（现在 decide 已拒收这种）
  if (f.decided_by && /^\s*(executor|agent|执行者)/i.test(f.decided_by)) return ['执行者自己落定（owner 没定过，可推翻）', 'self'];
  if (f.decided_by) return ['已定', 'ok'];
  if (f.settled) return [`执行者已收口 · ${SETTLED_LABEL[f.settled.kind] || f.settled.kind}${f.settled.ref ? ` → ${f.settled.ref}` : ''}（owner 可推翻）`, 'self'];
  if (/^执行者|自决|执行者按/.test(String(f.decide || ''))) return ['执行者自决（owner 可推翻）', 'self'];
  return ['待 owner 定', 'bad'];
}
function findingConclusion(f) {
  const last = (f.history || []).slice(-1)[0];
  const parts = [];
  if (f.decided_by) parts.push(`<div class="sfc-l"><b>裁定</b> ${esc(f.decided_by)}${f.decision ? ' —— ' + esc(f.decision) : ''}${f.decision_option ? `（选的是：${esc(f.decision_option.label ? `${f.decision_option.index}. ${f.decision_option.label} => ${f.decision_option.effect}` : `推荐「${f.decision_option.recommend}」`)}）` : ''}</div>`);
  else if (f.settled) parts.push(`<div class="sfc-l"><b>执行者收口 ${esc(String(f.settled.at || '').slice(0, 10))}</b> ${esc(f.settled.note || '')}${f.settled.ref ? `（看 ${esc(f.settled.ref)}）` : ''}</div>`);
  if (!f.decided_by && f.decide) parts.push(`<div class="sfc-d"><b>${f.settled ? '原来问的' : '处置'}</b> ${esc(f.decide)}</div>`);
  if (last?.note) parts.push(`<div class="sfc-l"><b>最近进展 ${esc(String(last.at || '').slice(0, 10))}</b> ${esc(String(last.note).slice(0, 600))}${String(last.note).length > 600 ? '…' : ''}</div>`);
  return parts.join('');
}
function renderFindings(dr, i, st) {
  const plan = allPlans(ROOT).find(p => p.demand === dr.did);
  const fs = plan?.findings || [];
  if (!fs.length) return '<div class="meta">这条需求没有 finding。</div>';
  const rounds = dr.rf.rounds;
  const roundOfT = t => { let k = 0; for (let j = 0; j < rounds.length; j++) if (Date.parse(rounds[j].opened_at) <= t) k = j; return k; };
  const nextStart = i + 1 < rounds.length ? Date.parse(rounds[i + 1].opened_at) : Infinity;
  const linked = new Map();   // F → [[key, state]]
  for (const [k, v] of st) for (const id of findIds(v.finding)) (linked.get(id) || linked.set(id, []).get(id)).push([k, v]);
  const visible = fs.filter(f => !f.at || Date.parse(f.at) < nextStart);
  const cnt = {}; visible.forEach(f => { const [t] = findingStatus(f); cnt[t] = (cnt[t] || 0) + 1; });
  const rows = visible.slice().sort((a, b) => Number(String(b.id).slice(1)) - Number(String(a.id).slice(1))).map(f => {
    const [txt, cls] = findingStatus(f);
    const born = f.at ? roundOfT(Date.parse(f.at)) : null;
    const ln = linked.get(f.id) || [];
    const lt = { pass: 0, fail: 0, blocked: 0, todo: 0, skip: 0, na: 0 }; ln.forEach(([, v]) => lt[v.status]++);
    return `<details class="ctree sfnode st-${cls === 'ok' ? 'pass' : cls === 'bad' ? 'blocked' : 'todo'}"><summary>
      <span class="dot ${cls === 'ok' ? 'pass' : cls === 'bad' ? 'fail' : 'wip'}"></span><code class="ct-id">${esc(f.id)}</code>
      <span class="ct-t">${esc(f.what)}</span> <span class="bs ${cls}">${esc(txt)}</span>
      ${born !== null ? `<span class="dim">第 ${born + 1} 轮提出${born === i ? '（本轮）' : ''}</span>` : ''}
      ${ln.length ? `<span class="dim">关联 ${ln.length} 条断言</span> ${tallyBadges(lt)}` : ''}</summary>
      <div class="ctree-b">${f.kind ? `<div class="sfc-l"><b>性质</b> ${esc(FINDING_KINDS[f.kind] || f.kind)}</div><div class="sfc-l"><b>影响范围</b> ${esc(f.impact || '')}</div><div class="sfc-l"><b>为什么</b> ${esc(f.why || '')}</div>` : ''}${f.detail ? `<div class="sfc-l"><b>细节</b> ${esc(String(f.detail).slice(0, 800))}${String(f.detail).length > 800 ? '…' : ''}</div>` : ''}
        ${findingConclusion(f)}
        ${ln.length ? `<div class="sfc-l"><b>关联断言（本轮状态）</b> ${ln.map(([k, v]) => `<code>${esc(k)}</code> <span class="tb ${v.status === 'blocked' ? 'blk' : v.status}">${ST_LABEL[v.status] || v.status}</span>`).join(' · ')}</div>` : ''}
      </div></details>`;
  }).join('');
  return `<div class="meta">截至本轮共 ${visible.length} 条 · ${Object.entries(cnt).map(([k, v]) => `${esc(k)} ${v}`).join(' · ')}</div>${rows}`;
}
// 一条断言在本轮那条记录的证据：截图出缩略图，其余点开看原文；每份带盲审角标（复核的是内容，见 reviewItems）
const rvMemo = new Map();
// 只要复核状态、不要页面片段（数「能信几成」用）：不碰证据原文 —— 本地文件模式下 recordEvidence 会把原文内联进页面，
// 为了数数把每一轮每条记录的原文都读进来，页面会超出字符串上限、整个生成失败
function evidenceItems(v) {
  const r = v.run && RUN_BY_ID.get(v.run); const e = v.key?.split('::')[1];
  if (!r?.res || !e) return [];
  if (!rvMemo.has(v.run)) rvMemo.set(v.run, new Map(reviewItems(r.res, { any: true, dir: r.dir }).map(x => [x.key, x.rv])));
  const rvs = rvMemo.get(v.run);
  return (r.res.results?.[e]?.evidence || []).map(x => ({ ev: x, rv: rvs.get(`${e}::${x}`) || { state: 'pending' } }));
}
function recordEvidence(v) {
  const r = v.run && RUN_BY_ID.get(v.run); const e = v.key?.split('::')[1];
  if (!r?.res || !e) return { html: '', items: [] };
  if (!rvMemo.has(v.run)) rvMemo.set(v.run, new Map(reviewItems(r.res, { any: true, dir: r.dir }).map(x => [x.key, x.rv])));
  const rvs = rvMemo.get(v.run);
  const evs = r.res.results?.[e]?.evidence || [];
  const items = evs.map(x => ({ ev: x, rv: rvs.get(`${e}::${x}`) || { state: 'pending' } }));
  const shots = items.filter(x => isShot(x.ev) && existsSync(join(r.dir, x.ev)));
  const html = (shots.length ? `<div class="egrid">${shots.slice(0, 4).map(x => `<figure class="gcell"><img loading="lazy" src="${imgSrc(x.ev, join(r.dir, x.ev))}" alt="${esc(x.ev)}"/><figcaption>${esc(x.ev.split('/').pop())}${rvBadge(x.rv)}</figcaption></figure>`).join('')}</div>` : '')
    + items.filter(x => !shots.includes(x)).map(x => evChip(x.ev, r.dir, x.rv)).join(' ');
  return { html, items };
}
// 本轮流程走到哪：评审 → 执行 → 盲审 → 报告 → 完成（docs/001-domain.md「流程」）。
// 最新一轮（算了 next 的）按用例说：每条用例在哪一步（next.mjs caseStages，与执行者 pull 到的卡片同一份计算），
// 整轮是这几步上各有几条 —— 评审单中途加了一条用例，只有那一条在「用例评审」，其余照常往下走；
// 只说「整轮卡在用例评审」会让已经盲审完的几十条看着像没开始。
// 更早的轮次没有「现在的卡片」，仍按整轮的数字说（评审单只有现在这一版，评审这一步对它们不适用）。
const liveMemo = new Map();
function liveOf(dr, i) {
  const plan = allPlans(ROOT).find(p => p.demand === dr.did);
  // 每个需求的最新一轮都按用例说（以前只算最近活跃的两个：新需求一开，正在验的需求就退回整轮视图，又显示成「卡在用例评审」）
  if (i !== dr.rf.rounds.length - 1 || !plan) return null;
  if (!liveMemo.has(dr.did)) {
    let cards = null; try { cards = nextCards(ROOT, dr.did); } catch (e) { console.error(`⚠️ ${dr.did} 的最新一轮算不出卡片，按整轮显示：${e.message}`); }
    liveMemo.set(dr.did, cards && { plan, cards, stages: caseStages(ROOT, cards) });
  }
  return liveMemo.get(dr.did);
}
const STAGE_LABEL = Object.fromEntries(STAGES);
const stageOf = (live, c) => live?.stages.get(c)?.stage || 'done';
function pulledList(dr, cs) {
  const byKind = [...cs.reduce((m, c) => m.set(c.kind, (m.get(c.kind) || 0) + 1), new Map())];
  return `<details class="pulled"><summary>执行者手上的 ${cs.length} 件事：${byKind.map(([k, n]) => `<span title="${esc(CARD_KINDS[k] || '')}">${esc(KIND_CN[k] || k)} ${n}</span>`).join(' · ')}</summary>
      <ol>${cs.slice(0, 12).map(c => `<li><code>${esc(c.kind)}</code> ${esc(c.title)}${c.held?.length ? ` <span class="dim">（${esc(c.detail?.at(-1) || '')}）</span>` : ''}</li>`).join('')}</ol>${cs.length > 12 ? `<div class="dim">……共 ${cs.length} 件</div>` : ''}</details>`;
}
const flowBar = steps => `<div class="flow">${steps.map(([n, [s, d]]) => `<div class="fstep f-${s}"><b>${s === 'done' ? '✓' : s === 'wait' ? '⏸' : s === 'empty' ? '·' : '…'} ${n}</b><span>${esc(d)}</span></div>`).join('<span class="farr">→</span>')}</div>`;
function roundFlow(dr, i, st, mem) {
  const live = liveOf(dr, i);
  const plan = allPlans(ROOT).find(p => p.demand === dr.did);
  const waitOwner = (plan?.findings || []).filter(f => findingStatus(f)[1] === 'bad').length;
  if (live) return liveFlow(dr, st, live, waitOwner);
  const vals = [...st.values()];
  const todo = vals.filter(v => v.status === 'todo').length;
  // 盲审数的是这一轮所有结论背后的证据（本轮测的 + 继承来的）：继承来的结论照样要有人核过才可信
  const rv = vals.filter(v => v.run).flatMap(v => evidenceItems(v).map(x => x.rv));
  const rvOk = rv.filter(x => x.state === 'ok' && x.by !== 'self').length, rvSelf = rv.filter(x => x.state === 'ok' && x.by === 'self').length;
  const rvBad = rv.filter(x => x.state !== 'ok' && x.state !== 'pending').length, rvWait = rv.filter(x => x.state === 'pending').length;
  const reported = mem.runs.filter(r => existsSync(join(RUNS, r, 'run.md')) && statSync(join(RUNS, r, 'run.md')).mtimeMs >= statSync(join(RUNS, r, 'result.json')).mtimeMs).length;
  const latest = i === dr.rf.rounds.length - 1;
  const added = plan && !plan.approved_at ? planDelta(plan).added.length : 0, kept = plan ? approvedCases(plan).size : 0;
  const steps = [
    ['用例评审', !latest || !plan ? ['done', plan ? '' : '没有评审单'] : plan.approved_at ? ['done', `v${plan.revision} 已批准（${plan.approved_by}）`]
      : kept ? ['wait', `v${plan.revision} 新加 ${added} 条等你批准，已批过的 ${kept} 条照常测`] : ['wait', `v${plan.revision} 等你批准`]],
    ['执行', todo ? ['doing', `还有 ${todo} 条没测上 / 共 ${st.size}`] : ['done', `${st.size} 条都有结论`]],
    ['盲审', !rv.length ? ['doing', '结论都没有挂证据']
      : rvBad || rvWait || rvSelf ? ['doing', [`盲审过 ${rvOk}/${rv.length} 份`, rvSelf && `只有自审 ${rvSelf}`, rvWait && `待审 ${rvWait}`, rvBad && `驳回待补 ${rvBad}`].filter(Boolean).join(' · ')]
      : ['done', `${rv.length} 份都盲审过`]],
    ['报告', !mem.runs.length ? ['doing', '本轮还没有运行'] : reported === mem.runs.length ? ['done', `${reported} 个运行都出了`] : ['doing', `${reported}/${mem.runs.length} 个运行出了报告`]],
  ];
  const allDone = steps.every(([, [s]]) => s === 'done');
  steps.push(['完成', allDone && !waitOwner ? ['done', '这一轮做完了'] : ['doing', waitOwner ? `还有 ${waitOwner} 条 finding 等你定` : '前面还有没做完的']]);
  const stuck = steps.find(([, [s]]) => s !== 'done');
  return flowBar(steps) + (stuck ? `<div class="meta">卡在「${stuck[0]}」：${esc(stuck[1][1])}</div>` : '');
}
// 最新一轮从 owner 的角度答三问：做到哪了 / 要我做什么 / 执行者在做什么。
// 不画「评审 → 执行 → …」带箭头的流水线：那读起来是整轮停在第一个红框上，而它其实是 64 条用例的分布 ——
// 中途加一条用例时，几十条已经盲审完的会被看成「还在用例评审」。所以：
//   进度条按用例分段（每条用例在哪一步，next.mjs caseStages，与执行者 pull 到的卡片同一份计算）；
//   「等你」单独一块、是整页唯一的红色，每件写明挡住了什么，并能一键筛出相关用例；
//   执行者那边只是一行灰字。
// 批准要给 owner 决策空间：为什么加（评审单这一版的修订说明）、加的是什么、要验什么、跑它要什么、批或退回各会怎样
const clipStr = (t, n) => { const x = String(t || '').replace(/\s+/g, ' ').trim(); return x.length > n ? x.slice(0, n) + '…' : x; };
function approvalDetail(plan, added, kept) {
  const why = (plan.history || []).filter(h => h.revision === plan.revision).map(h => h.change).filter(Boolean);
  const caseBox = c => {
    const cs = ALL_CASES[c] || {}; const sf = (plan.surfaces || []).find(x => [...(x.reuse || []), ...(x.new || [])].includes(c));
    const asserts = []; walkExpects(cs.tree || [])(e => asserts.push(`${e.id} ${e.assert || ''}`));
    return `<div class="apcase"><b>${esc(cs.title || c)}</b> <code class="dim">${esc(c)}</code>
      ${sf ? `<div><span class="dim">改动面</span> ${esc(sf.id)}：${esc(sf.change || '')}</div>` : ''}
      ${cs.why ? `<div><span class="dim">为什么要验</span> ${esc(clipStr(cs.why, 400))}</div>` : ''}
      ${(cs.preconditions || []).length ? `<div><span class="dim">跑它需要</span><ul>${[].concat(cs.preconditions).map(x => `<li>${esc(clipStr(x, 200))}</li>`).join('')}</ul></div>` : ''}
      <details><summary>要验的 ${asserts.length} 条断言</summary><ol class="apas">${asserts.map(a => `<li>${esc(clipStr(a, 220))}</li>`).join('')}</ol></details></div>`;
  };
  const form = DECIDE_URL ? `<form class="ap" data-d="${esc(plan.demand)}">
      <div class="dim">批了：执行者开跑这 ${added.length} 条${kept ? `；退回：执行者照你的意见改评审单再来问你。两种情况已批过的 ${kept} 条都照常测` : '；退回：执行者照你的意见改评审单再来问你'}。</div>
      <textarea name="note" rows="2" placeholder="补一句（批准时可不写；退回必须写：为什么、要怎么改）"></textarea>
      <button data-a="approve">同意加这 ${added.length} 条</button> <button data-a="return" class="ghost">不同意，退回改</button>
      <span class="dim">以 ${esc(OWNER)} 的身份记下</span> <span class="ap-msg dim"></span></form>`
    : `<div class="dim">在终端：<code>acceptkit plan review ${esc(plan.demand)}</code> 看评审稿</div>`;
  return `<div class="apbox">${why.length ? `<div class="apwhy"><span class="dim">为什么加</span> ${why.map(esc).join('；')}</div>` : ''}<details class="apd"><summary>看加的是什么、要验哪些、跑它要什么</summary>${added.map(caseBox).join('')}</details>${form}</div>`;
}
// 给 owner 看的六栏：next.mjs 的阶段只说「工具这边还有什么卡片」，owner 要的是「这条用例现在是什么状态」——
//   在测 拆成 待开跑 / 正在测（最近 2 小时有动静）：没人在跑的不能说成在测；
//   完成 只算真验完的（没有「验不了」）；没卡片但有验不了的单独一栏，不能被读成通过（「没证据表明不行」≠「行」）。
const COLS = ['review', 'todo', 'running', 'blind', 'cant', 'done'];
const COL_LABEL = { review: '等你批准', todo: '待开跑', running: '正在测', blind: '待复核', cant: '验不了', done: '完成' };
const ACTIVE_MS = 2 * 3600e3;
const runMtime = run => { try { return statSync(join(RUNS, run, 'result.json')).mtimeMs; } catch { return 0; } };
const latestRunOfCase = (did, c) => runs.filter(r => r.res?.case === c && (r.res?.demand?.id || r.res?.demand) === did)
  .sort((x, y) => (y.res.run_seq || 0) - (x.res.run_seq || 0))[0]?.id || null;
function ownerStage(dr, live, st, c) {
  const k = stageOf(live, c);
  if (k === 'review' || k === 'blind') return k;
  if (k === 'exec') { const r = latestRunOfCase(dr.did, c); return r && Date.now() - runMtime(r) < ACTIVE_MS ? 'running' : 'todo'; }
  const blocked = [...st].some(([key, v]) => key.startsWith(`${c}::`) && v.status === 'blocked');
  return blocked ? 'cant' : 'done';
}
// 能信几成：每条有结论的断言归一类（互斥，按「最不可信」优先）。同一份计算也给侧栏用，两处数字对得上
const shotsMemo = new Map();
const runHasShots = run => { if (!shotsMemo.has(run)) shotsMemo.set(run, appShotsIn(join(RUNS, run)).length > 0); return shotsMemo.get(run); };
function trustOf(st) {
  const t = { solid: 0, self: 0, unreviewed: 0, noshot: 0, gap: 0, cant: 0, na: 0, todo: 0 };
  for (const v of st.values()) {
    if (v.status === 'todo') { t.todo++; continue; }
    if (v.status === 'gap') { t.gap++; continue; }   // 记的是通过、证据不全（assertionGaps）：不算能信
    if (v.status === 'blocked') { t.cant++; continue; }
    if (v.status === 'na' || v.status === 'skip') { t.na++; continue; }
    const plat = v.run && RUN_BY_ID.get(v.run)?.res?.platform;
    if (v.run && RUNTIME_PLATFORMS.includes(plat) && !runHasShots(v.run)) { t.noshot++; continue; }
    const rv = evidenceItems(v).map(x => x.rv);
    if (!rv.length || rv.some(x => x.state !== 'ok')) t.unreviewed++;
    else if (rv.some(x => x.by === 'self')) t.self++;
    else t.solid++;
  }
  return t;
}
const KIND_CN = { attention: '等人回答', plan_draft: '评审单待改', finding_unclear: 'finding 待补写', blocker_own: '执行者自己的能力缺口', round_stale: '被测代码变了',
  device_needed: '缺设备', step_todo: '步骤待截图', expect_todo: '断言待判', rejected: '复核驳回待补', review_due: '证据待复核', report_due: '待出报告',
  run_needed: '待开新运行', shot_missing: '待重测补截图', stalled: '运行停滞' };
const laneName = t => clipStr(String(t || '').split(/[（(：:；;]/)[0], 42);
function liveFlow(dr, st, live, waitOwner) {
  const { plan, cards, stages } = live;
  const names = new Set([...st.keys()].map(k => k.split('::')[0]));
  for (const c of stages.keys()) names.add(c);
  const os = new Map([...names].map(c => [c, ownerStage(dr, live, st, c)]));
  const at = new Map(COLS.map(k => [k, []]));
  for (const c of names) at.get(os.get(c)).push(c);
  const n = k => at.get(k).length;
  const askOf = c => !!stages.get(c)?.ask;
  const reportPending = new Set(cards.filter(c => c.kind === 'report_due').map(c => RUN_BY_ID.get(c.run)?.res?.case).filter(Boolean));
  const stuck = new Set(cards.filter(c => c.kind === 'stalled').map(c => RUN_BY_ID.get(c.run)?.res?.case).filter(Boolean));
  const kept = approvedCases(plan).size;
  // ---- 能信几成：一行，放最上面 ----
  const t = trustOf(st), concl = st.size - t.todo;
  const trust = `<div class="trust"><b>${st.size} 条断言能信几成</b>：<span class="t-ok">${t.solid} 条盲审过、有 app 画面</span>${[
    t.self && `<span class="t-warn">${t.self} 条只有执行者自审</span>`, t.unreviewed && `<span class="t-warn">${t.unreviewed} 条还没复核</span>`,
    t.noshot && `<span class="t-bad">${t.noshot} 条没有 app 画面佐证</span>`, t.gap && `<span class="t-bad">${t.gap} 条记了通过但证据不全</span>`, t.cant && `<span class="t-bad">${t.cant} 条验不了</span>`,
    t.na && `<span class="dim">${t.na} 条不适用</span>`, t.todo && `<span class="dim">${t.todo} 条还没结论</span>`].filter(Boolean).map(x => ' · ' + x).join('')}
    <span class="dim">（有结论 ${concl} 条）</span></div>`;
  // ---- 等你：一件一行，就地办完 ----
  const asks = [];
  if (n('review')) {
    const rv = at.get('review');
    asks.push(`<li><div class="ask-h"><b>同不同意把 ${rv.length} 条用例加进这次验收</b> <span class="dim">· 只挡这 ${rv.length} 条${kept ? `，已同意过的 ${kept} 条照常测` : ''}</span></div>${approvalDetail(plan, rv, kept)}</li>`);
  }
  // 阻塞按「问的是同一件事」合并：一条用例里十几条断言卡在同一件事上，问题只问一次，答一次覆盖全部
  //（问题原文末尾的「（影响 Bxx/Ey，… 提过）」是每条各自的，去掉再比）
  const bq = cards.filter(c => c.kind === 'attention' && c.subject === 'blocker' && c.question);
  const qKey = q => String(q).trim();
  const groups = [...bq.reduce((m, c) => { const k = qKey(c.question); (m.get(k) || m.set(k, []).get(k)).push(c); return m; }, new Map())];
  const groupLi = ([q, cs]) => { const cases = [...new Set(cs.map(c => RUN_BY_ID.get(c.run)?.res?.case).filter(Boolean))];
    const c0 = cs[0];
    return `<li><div><b>${esc(q)}</b></div>${c0.why ? `<div class="dim">为什么问你：${esc(c0.why)}</div>` : ''}<div class="dim">卡住 ${cases.length} 条用例、${cs.length} 条断言：${cases.slice(0, 3).map(c => esc(clipStr(ALL_CASES[c]?.title || c, 40))).join('；')}${cases.length > 3 ? ' 等' : ''}</div>
      ${c0.recommend ? `<div class="dim">执行者推荐：${esc(c0.recommend)}</div>` : ''}${DECIDE_URL ? `<form class="ak" data-d="${esc(dr.did)}" data-b="${esc(cs.map(c => c.blocker).join(','))}">${(c0.options || []).map((o, i) => `<label class="ako"><input type="radio" name="pick" value="${esc(o)}"> ${esc(o)}</label>`).join('')}<textarea name="note" rows="1" placeholder="补一句（不在选项里的也可以直接写）"></textarea><button>记下答复</button> <span class="ap-msg dim"></span></form>` : (c0.options || []).map(o => `<div>${esc(o)}</div>`).join('')}</li>`; };
  // 还没写成问题的阻塞不摆给你：那是执行者的活（blocker_unasked 卡片），这里只说一声有多少
  const unasked = cards.filter(c => c.kind === 'blocker_unasked');
  const unaskedN = unasked.reduce((n, c) => n + (c.blockers?.length || 1), 0);
  if (groups.length) asks.push(`<li><div class="ask-h"><b>答 ${groups.length} 个问题</b> <span class="dim">· 卡住了 ${bq.length} 条断言；每个只挡它涉及的用例，答了执行者照你的话重测</span></div>
    <ol class="bq">${groups.slice(0, 5).map(groupLi).join('')}</ol>${groups.length > 5 ? `<details class="apd"><summary>另外 ${groups.length - 5} 个问题</summary><ol class="bq" start="6">${groups.slice(5).map(groupLi).join('')}</ol></details>` : ''}</li>`);
  if (waitOwner) asks.push(`<li><div class="ask-h"><b>定 ${waitOwner} 条 finding</b> <span class="dim">· 不挡用例往下走，挡这一轮收口</span> <a class="ny-go" href="#run=decide">去裁定 →</a></div></li>`);
  const pending = unasked.length ? `<div class="meta">另有 ${unasked.length} 个阻塞（卡住 ${unaskedN} 条断言）执行者还在写成你能拍板的问题，写好了会出现在这里</div>` : '';
  const you = (asks.length ? `<div class="you"><div class="you-h">等你 · ${asks.length} 件</div><ol>${asks.join('')}</ol></div>` : '<div class="you ok">没有等你的事</div>') + pending;
  // ---- 泳道：默认每格只给数字 + 这一面的进度，点开看用例 ----
  const laneOf = new Map();
  for (const sf of plan.surfaces || []) for (const c of [...(sf.reuse || []), ...(sf.new || [])]) if (!laneOf.has(c)) laneOf.set(c, sf.id);
  const lanes = [...(plan.surfaces || []).map(sf => ({ id: sf.id, label: sf.change || sf.id })), { id: '评审单外', label: '调查型用例（不在评审单里）' }]
    .map(l => ({ ...l, cases: [...names].filter(c => (laneOf.get(c) || '评审单外') === l.id) })).filter(l => l.cases.length);
  const cell = (cs, k) => {
    if (!cs.length) return '<span class="kz">—</span>';
    const sub = k === 'todo' ? cs.filter(c => stuck.has(c)).length && `${cs.filter(c => stuck.has(c)).length} 开了没跑完`
      : k === 'done' ? cs.filter(c => reportPending.has(c)).length && `${cs.filter(c => reportPending.has(c)).length} 报告待生成` : 0;
    const hot = cs.filter(askOf).length;
    return `<span class="kn kn-${k}">${cs.length}</span>${hot ? `<span class="kn-ask">${hot} 等你</span>` : ''}${sub ? `<span class="kn-sub">${sub}</span>` : ''}`;
  };
  const chip = c => `<button class="kc${askOf(c) ? ' ask' : ''}" data-f="case:${esc(c)}" title="${esc(c)}">${esc(ALL_CASES[c]?.title || c)}${askOf(c) ? '<em>等你答复</em>' : stuck.has(c) ? '<em class="g">开了没跑完</em>' : reportPending.has(c) ? '<em class="g">报告待生成</em>' : ''}</button>`;
  const laneRow = l => {
    const by = Object.fromEntries(COLS.map(k => [k, l.cases.filter(c => os.get(c) === k)]));
    const pct = Math.round(by.done.length / l.cases.length * 100);
    return `<details class="ln"><summary class="ln-row"><span class="ln-name" title="${esc(l.label)}"><b>${esc(laneName(l.label))}</b></span>
      ${COLS.map(k => `<span class="ln-c">${cell(by[k], k)}</span>`).join('')}
      <span class="ln-p"><span class="ln-bar"><i style="width:${pct}%"></i></span>${by.done.length}/${l.cases.length}</span></summary>
      <div class="ln-body"><div class="ln-full dim">${esc(l.label)}</div>${COLS.map(k => `<div class="ln-cards">${by[k].map(chip).join('')}</div>`).join('')}<span></span></div></details>`;
  };
  const board = `<div class="lanes"><div class="ln-row ln-head"><span class="ln-name">这次改了什么 <button class="ln-all">全部展开</button></span>${COLS.map(k => `<span class="ln-c">${COL_LABEL[k]} ${n(k)}</span>`).join('')}<span class="ln-p">完成进度</span></div>${lanes.map(laneRow).join('')}</div>`;
  const line = `<div class="progline"><b>${names.size} 条用例</b>${COLS.map(k => n(k) ? ` · <button class="flt" data-f="o:${k}">${COL_LABEL[k]} ${n(k)}</button>` : '').join('')} · <button class="flt" data-f="">看全部</button></div>`;
  const busy = [n('running') && `${n('running')} 条正在测`, n('todo') && `${n('todo')} 条等执行者开跑${stuck.size ? `（其中 ${stuck.size} 条开了没跑完）` : ''}`, n('blind') && `${n('blind')} 条证据待复核`].filter(Boolean);
  const them = `<div class="meta">执行者那边：${busy.length ? busy.join(' · ') : '没有要做的'}${n('done') === names.size && !waitOwner ? ' —— 这一轮做完了' : ''}</div>`;
  return trust + you + line + board + them + pulledList(dr, cards);
}
// 这条用例的结论出自哪个运行，那个运行里工具截的 app 画面：读的人一眼看到「真在 app 上跑过、停在哪页」。
// 一张都没有就直说 —— 以前这里只列断言的文本证据，一个需求跑了两百多个运行，页面上一张能看的图都没有。
function caseShots(es) {
  const recs = es.map(([, v]) => v).filter(v => v.run);
  if (!recs.length) return '';
  const run = recs.sort((x, y) => (y.t || 0) - (x.t || 0))[0].run;
  const plat = RUN_BY_ID.get(run)?.res?.platform;
  if (!RUNTIME_PLATFORMS.includes(plat)) return '';
  const shots = appShotsIn(join(RUNS, run)).filter(m => m.file && existsSync(join(RUNS, run, m.file)));
  if (!shots.length) return `<div class="noshot">这条用例的结论没有一张 app 画面佐证（运行 <code>${esc(run)}</code> 里没有工具截的图）—— 要重测补截图</div>`;
  return `<div class="cshots">${shots.slice(0, 8).map(m => `<figure class="gcell"><img loading="lazy" src="${imgSrc(m.file, join(RUNS, run, m.file))}" alt="${esc(m.file)}"/><figcaption>${esc((m.label || m.file).split('/').pop())}</figcaption></figure>`).join('')}${shots.length > 8 ? `<span class="dim">另 ${shots.length - 8} 张见运行 ${esc(run)}</span>` : ''}</div>`;
}
function renderRoundPanel(dr, i) {
  const rd = dr.rf.rounds[i], st = dr.states[i], mem = dr.mem[i], t = stTally(st);
  const src = {}; for (const v of st.values()) src[v.source] = (src[v.source] || 0) + 1;
  const imp = rd.impact || {};
  const byCase = new Map();
  for (const [k, v] of st) { const [c, e] = k.split('::'); (byCase.get(c) || byCase.set(c, []).get(c)).push([e, v]); }
  // 最新一轮按用例所在的那一步排（等批准的排最前），每行带上它在哪一步
  const live = liveOf(dr, i), rank = c => live ? STAGES.findIndex(([k]) => k === stageOf(live, c)) : 0;
  const caseRows = [...byCase.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0])).map(([c, es]) => {
    const ct = { pass: 0, fail: 0, blocked: 0, todo: 0, skip: 0, na: 0 }; es.forEach(([, v]) => ct[v.status]++);
    const here = es.filter(([, v]) => v.source === 'here').length, reset = es.filter(([, v]) => v.source === 'reset').length;
    // 用例先说人话（标题 + 为什么要验），id 退成小字；每条断言带原文和证据 —— 只看 id 和「通过 4」建立不了信任
    const cs = cases.find(x => x.case === c);
    const asserts = new Map(); if (cs) walkExpects(cs.tree || [])(x => asserts.set(String(x.id), x.assert || ''));
    return `<details class="rcase st-${aggOf(ct) === 'pass' ? 'pass' : ct.fail ? 'fail' : 'todo'}"${live ? ` data-case="${esc(c)}" data-stage="${stageOf(live, c)}" data-o="${ownerStage(dr, live, st, c)}"${live.stages.get(c)?.ask ? ' data-ask="1"' : ''}` : ''}><summary><span class="dot ${statusClass(aggOf(ct))}"></span>
      ${live ? `<span class="stg stg-${ownerStage(dr, live, st, c)}">${COL_LABEL[ownerStage(dr, live, st, c)]}${live.stages.get(c)?.ask ? ' · 等你答复' : ''}</span> ` : ''}<b>${esc(cs?.title || c)}</b> ${tallyBadges(ct)} <small class="dim">本轮测 ${here}${reset ? ` · 重置 ${reset}` : ''} · <a class="caselink" href="#run=case:${esc(c)}">${esc(c)}</a></small></summary>
      ${cs?.why ? `<div class="cwhy">${esc(String(cs.why).slice(0, 400))}${String(cs.why).length > 400 ? '…' : ''}</div>` : ''}
      ${caseShots(es)}
      <table class="tbl"><thead><tr><th>断言</th><th>状态</th><th>来源</th><th>证据</th><th>记录</th></tr></thead><tbody>` +
      es.sort((a, b) => a[0].localeCompare(b[0], 'en', { numeric: true })).map(([e, v]) => `<tr><td><code class="dim">${esc(e)}</code> ${esc(asserts.get(e) || '')}</td><td><span class="tb ${v.status === 'blocked' ? 'blk' : v.status}">${ST_LABEL[v.status] || v.status}</span>${consultHtml(e, asserts.get(e), v)}</td>
        <td>${SRC_LABEL[v.source] || v.source}${v.source === 'inherited' ? ` ← ${esc(v.round)}` : ''}${v.source === 'reset' ? `（${esc(v.round)}）：${esc(v.reason || '')}` : ''}</td>
        <td class="evcol">${recordEvidence(v).html || (v.run ? '<span class="dim">没有挂证据</span>' : '')}</td>
        <td>${v.run ? `<code>${esc(v.run)}</code> · ${esc(shortTime(new Date(v.t).toISOString()))}${findIds(v.finding).map(id => ` <span class="bs self">${esc(id)}</span>`).join('')}<div class="dim">${esc((v.actual || '').slice(0, 140))}</div>` : ''}</td></tr>`).join('') +
      `</tbody></table></details>`;
  }).join('');
  const sessLinks = mem.sessions.map(sid => execs.find(x => x.session === sid) ? `<a class="caselink" href="#run=${esc(sid)}">${esc(sid)}</a>` : `<code>${esc(sid)}</code>`).join(' · ');
  const k = `round:${dr.did}:${rd.id}`;
  // 有效截图规则：本轮的 run 里工具截的 app 画面（按截图时刻落在本轮之内算）。一张都没有就在状态条下面直说 ——
  // 实测：有一轮的几个 run 全是文本证据，面板却只显示「通过」，读的人要自己去翻证据目录才发现。
  const nextAt = dr.rf.rounds[i + 1]?.opened_at;
  const shots = mem.runs.flatMap(r => appShotsIn(join(RUNS, r)).map(m => ({ ...m, run: r })))
    .filter(m => !m.at || (m.at >= rd.opened_at && (!nextAt || m.at < nextAt)));
  // 迁移进来的 run（规则定下之前按当时的规矩跑的）不追溯 —— 与 report / record 的 legacyRun 同一口径
  const ruled = mem.runs.filter(r => !runs.find(x => x.id === r)?.res?.demand?.migrated);
  const noShotRuns = ruled.filter(r => !shots.some(m => m.run === r));
  const shotLine = !mem.records || !ruled.length ? '' : !shots.length
    ? `<div class="rule bad-rule">⚠️ <b>本轮没有一张 app 操作截图</b>（${ruled.length} 个 run 全是文本证据）。违反有效截图规则：验收过程和结果要有真实 app 画面能证明。这一轮的「通过」只有探针日志支撑。</div>`
    : noShotRuns.length ? `<div class="rule bad-rule">⚠️ 本轮 app 操作截图 ${shots.length} 张，但 ${noShotRuns.length} 个 run 一张都没有：${noShotRuns.map(r => `<code>${esc(r)}</code>`).join(' · ')}</div>`
    : `<div class="meta">这一轮新跑的 ${ruled.length} 个运行截了 ${shots.length} 张 app 画面（继承来的结论有没有画面，看上面「能信几成」）</div>`;
  return `<section class="panel" data-k="${esc(k)}" hidden>
    <div class="phead"><h1>${esc(dr.demand.title)} · 第 ${rd.seq} 轮（共 ${dr.rf.rounds.length} 轮）</h1><button class="copylink" data-k="${esc(k)}">🔗 复制链接</button></div>
    ${roundFlow(dr, i, st, mem)}
    <div class="whole"><b>按断言数</b> ${tallyBadges(t)}
      <span class="dim">共 ${st.size} 条断言 · 本轮测 ${src.here || 0} · 继承 ${src.inherited || 0} · 重置待测 ${src.reset || 0} · 从没测过 ${src.never || 0}</span></div>
    ${shotLine}
    <h3>这一轮覆盖的用例（${byCase.size} 条，点开看每条断言）</h3>${caseRows || '<div class="meta">这一轮还没有用例。</div>'}
    <h3>代码版本</h3>${codeTable(rd)}
    <h3>相对上一轮（${esc(rd.base || '—')}）的改动</h3>${changesBlock(rd) || '<div class="meta">首轮。</div>'}
    <h3>影响评估</h3><div class="rule"><b>${esc(imp.by === 'migration' ? '存量迁移' : `评估人 ${imp.by || '?'} · ${shortTime(imp.at)}`)}</b>${esc(imp.summary || '—')}
      ${(imp.reset || []).length ? `<ul class="pre">${imp.reset.map(x => `<li><code>${esc(x.key)}</code> —— ${esc(x.why || '')}</li>`).join('')}</ul>` : ''}
      <div class="dim">${esc(imp.inherit_note || '')}</div></div>
    <h3>本轮执行</h3><div class="meta">开轮 ${esc(shortTime(rd.opened_at))} · 本轮记录 ${mem.records} 条 · run ${mem.runs.length} 个 · 执行（session）：${sessLinks || '—'}</div>
    <h3>发现（findings）与结论</h3>${renderFindings(dr, i, st)}
  </section>`;
}

// 入口放最上面：用例与操作集是「资产」，执行记录是「流水」。
// 之前把两个入口接在 28 条执行记录后面，等于藏在滚动条底部——找不到就等于没有。
// ---- 「等你定」：待 owner 裁定的 finding 必须在顶层一眼看见 ----
// 之前它们只活在「某一轮」面板里、与已定的混排（实测一个需求有近百条 finding，待决的几条要展开两层才找得到）。
// 要 owner 确认的 finding 必须单独高亮，否则他根本找不到。
// 按需求分组，并默认只看**最近活跃**的需求 —— 全项目累积 103 条「待 owner 定」里，
// 绝大多数是早期需求的历史条目（最早那几轮的，早已不成立）。
// 全部塞进横幅等于噪音，owner 一眼看不出哪几条是现在要他定的。
const __activeDids = new Set(demandRounds.slice(0, 2).map(dr => dr.did));   // 侧栏已按最近活跃排序
const pendingAll = allPlans(ROOT).flatMap(p =>
  (p.findings || [])
    .filter(f => findingStatus(f)[1] === 'bad')          // 只有「待 owner 定」这一类
    .map(f => ({ ...f, demand: p.demand, dtitle: p.title })))
  .sort((a, b) => Number(String(b.id).slice(1)) - Number(String(a.id).slice(1)));
// 「已被后续 finding 取代 / 已有答案 / 执行者自己的活」由执行者用 plan settle 显式收口（带理由、owner 可推翻），
// 这里只认那个字段 —— 以前按「后面的条目点名了前面的 Fxx」来猜，会把「回答了 F89 第 3 项」误当成取代整条 F89。
const pendingFindings = pendingAll.filter(f => __activeDids.has(f.demand));
const pendingOlder = pendingAll.length - pendingFindings.length;
const settledActive = allPlans(ROOT).filter(p => __activeDids.has(p.demand)).flatMap(p => (p.findings || []).filter(f => f.settled && !f.decided_by)).length;

// 横幅只做一件事：告诉 owner「有 N 条在等你」并一步带到裁定页。
// 以前一行塞 6 条截断的 finding 标题 + 一句口径说明，占三行、标题截断看不懂，而且链接 href="#decide"
// 不是面板路由（#run=<键>），点了没反应。条目链接带 &f=<Fxx>：落到裁定页并展开、滚到那一条。
const askOf = f => String(f.decide || f.what).split('\n')[0];
// 写得 owner 定不了的（缺性质 / 影响 / 为什么 / 选项，或被 owner 退回）不算「等你定」——那是执行者的待办。
// 硬摆给 owner = 逼他在看不懂的情况下拍板。
const readyFindings = pendingFindings.filter(f => !findingProblems(f).length);
const unclearFindings = pendingFindings.filter(f => findingProblems(f).length);
const pendingByDemand = [...readyFindings.reduce((m, f) => m.set(f.demand, (m.get(f.demand) || 0) + 1), new Map())];
const decideBanner = pendingFindings.length
  ? `<div class="needyou">🔻 <a class="ny-go" href="#run=decide"><b>等你定 ${readyFindings.length} 条</b> · 去裁定 →</a>`
    + `<span class="dim">${pendingByDemand.map(([d, n]) => `${esc(d)} ${n} 条`).join(' · ')}${unclearFindings.length ? ` · 另 ${unclearFindings.length} 条执行者还在补写` : ''}</span>`
    + readyFindings.slice(0, 2).map(f =>
        `<a class="ny-item" href="#run=decide&f=${esc(f.id)}" title="${esc(askOf(f))}"><code>${esc(f.id)}</code> ${esc(askOf(f))}</a>`).join('')
    + `</div>` : '';

// 裁定页：owner 来这里是要**拍板**。每条按 owner 拍板前要问的顺序摆：
// 要你定什么 → 这是什么性质（bug / 设计 / 用例自己的问题…）、影响多大 → 读懂要知道的那件事 → 选项和各自后果、执行者推荐。
// 代码标识、断言原文这类技术细节折叠在最后。能在页面上直接写回（管理页面出的看板才有写入口 —— 本地文件打开时只给命令）。
// 看不懂可以「退回重写」：不算拍板，只记哪里看不懂（原话），执行者改写后回到这里。
const DECIDE_URL = EV_BASE ? EV_BASE.replace(/\/evidence$/, '/decide') : '';
const OWNER = ownerIdentity();   // 在看板上点「批准 / 定」的人：这台电脑的主人（管理页面写回时由服务填同一个身份）
const KIND_SHORT = { product_bug: '产品缺陷', design_gap: '设计缺陷', spec_unclear: '需求没写清', test_defect: '用例/工具的问题', env: '环境问题' };
const LETTERS = 'ABCDEFGH';
function decideCard(f, open) {
  const opts = f.options || [];
  const rec = String(f.recommend || '');
  return `<details class="ctree sfnode st-blocked dz" data-f="${esc(f.id)}" data-d="${esc(f.demand)}"${open ? ' open' : ''}><summary>
      <span class="dot fail"></span><code class="ct-id">${esc(f.id)}</code>
      <span class="ct-t"><b>${esc(askOf(f))}</b><span class="dim"><span class="kd kd-${esc(f.kind)}">${esc(KIND_SHORT[f.kind] || '')}</span> ${esc(f.what)}${f.at ? ` · ${esc(shortTime(f.at).slice(0, 10))}` : ''}</span></span></summary>
      <div class="ctree-b">
        <div class="dz-row"><b>性质</b><div>${esc(FINDING_KINDS[f.kind] || '')}</div></div>
        <div class="dz-row"><b>影响范围</b><div class="dz-q">${esc(f.impact)}</div></div>
        <div class="dz-row"><b>为什么</b><div class="dz-q">${esc(f.why)}</div></div>
        <div class="dz-row"><b>要你定</b><div class="dz-q">${esc(String(f.decide || ''))}</div></div>
        <div class="dz-row"><b>选项</b><div class="dz-opts">${opts.map((o, i) => `<label class="dz-opt"><input type="radio" name="dz-${esc(f.demand)}-${esc(f.id)}" value="${LETTERS[i]}" data-label="${esc(o.label)}"${DECIDE_URL ? '' : ' disabled'}>
          <span><b>${LETTERS[i]}. ${esc(o.label)}</b><span class="dim"> → ${esc(o.effect)}</span></span></label>`).join('')}
          <div class="dz-rec">执行者推荐：${esc(rec)}</div></div></div>
        ${DECIDE_URL ? `<div class="dz-form"><textarea rows="2" placeholder="补充（可不填）；或写下哪里看不懂，点「看不懂，退回」"></textarea>
          <button class="dz-ok">记下决定</button><button class="dz-back">看不懂，退回重写</button><span class="dz-msg dim"></span></div>` : ''}
        ${f.detail ? `<details class="dz-tech"><summary class="dim">技术细节（${String(f.detail).length} 字，给要核对的人看）</summary><pre class="flist">${esc(String(f.detail))}</pre></details>` : ''}
        <details class="dz-tech"><summary class="dim">${DECIDE_URL ? '或在终端' : '裁定命令'}</summary><pre class="flist">acceptkit plan decide ${esc(f.demand)} --finding ${esc(f.id)} --by &lt;你&gt; --quote "&lt;你的原话&gt;"
acceptkit plan bounce ${esc(f.demand)} --finding ${esc(f.id)} --by &lt;你&gt; --quote "&lt;哪里看不懂&gt;"</pre></details>
      </div></details>`;
}
function renderDecide() {
  if (!pendingFindings.length) return '<div class="meta">没有待裁定的 finding。</div>';
  const head = `<div class="meta">最近活跃的需求里写清楚了、等你拍板的 ${readyFindings.length} 条，新的在前。每条按「性质 · 影响 · 为什么 · 选项」摆好，选一个就能定。`
    + (unclearFindings.length ? ` 另有 ${unclearFindings.length} 条执行者还没写清楚，放在最下面，不用你看。` : '')
    + (settledActive ? ` ${settledActive} 条执行者已收口（被更正取代 / 已有答案 / 执行者自己的活），理由在各轮面板的 findings 里，不认可可以直接改判。` : '')
    + (pendingOlder ? ` 早期需求还有 ${pendingOlder} 条没定，在各自的轮面板里。` : '')
    + `</div>`
    + (DECIDE_URL ? `<div class="dz-who dim">在这里定的都以 ${esc(OWNER)} 的身份记下（这台电脑的主人）</div>` : '');
  const groups = pendingByDemand.map(([did]) => {
    const fs = readyFindings.filter(f => f.demand === did);
    return `<h3>${esc(did)} · ${esc(fs[0].dtitle || '')}（${fs.length} 条）</h3>` + fs.map(f => decideCard(f, readyFindings.length <= 3)).join('');
  });
  const unclear = unclearFindings.length ? `<details class="dz-unclear"><summary><h3>执行者还没写清楚（${unclearFindings.length} 条）</h3><span class="dim">缺性质 / 影响 / 为什么 / 选项，或被你退回过；补写合格后自动上去</span></summary>`
    + unclearFindings.map(f => `<div class="sfc-l"><code>${esc(f.demand)}/${esc(f.id)}</code> ${esc(f.what)}<div class="dim">${findingProblems(f).map(x => esc(x)).join('<br>')}</div></div>`).join('')
    + `</details>` : '';
  return head + groups.join('') + unclear;
}

const navTop =
   `<div class="navsec">资产</div>`
  + `<button class="nav nav-d" data-k="allcases"><span class="dot pass"></span><span class="nt"><b>📋 用例清单</b><small>${cases.length} 条用例 · 点标题进详情</small></span></button>`
  + `<button class="nav nav-d" data-k="ops"><span class="dot pass"></span><span class="nt"><b>🧰 操作集</b><small>${Object.keys(OPS).length} 条操作 · 步骤 + 配图</small></span></button>`
  + libs.map(lib => `<button class="nav nav-d" data-k="${lib.key}"><span class="dot pass"></span><span class="nt"><b>📚 ${esc(lib.title)}</b><small>${lib.done}/${lib.total} 常备用例</small></span></button>`).join('')
  ;

// 侧栏那颗点 = 面板顶上的 whole 状态，同一套 tallyOf 算出来（按断言，不按用例 verdict）。
// 两处用两套算法时，侧栏会显示「通过」而面板显示「有验不了的」—— 那种自相矛盾不该存在。
const navDemands = demandRounds.map((dr, di) => {
  const cur = dr.states[dr.states.length - 1], t = stTally(cur);
  const items = dr.rf.rounds.map((rd, i) => ({ rd, i })).reverse().map(({ rd, i }) => {
    const ti = stTally(dr.states[i]);
    // 卡片只给「已测 / 总条数」：已测 = 本轮测 + 继承来的（有结论的）；重置待测与从没测过的不算
    let tested = 0; for (const v of dr.states[i].values()) if ((v.source === 'here' || v.source === 'inherited') && v.status !== 'todo') tested++;
    const total = dr.states[i].size;
    const code = Object.values(rd.code || {})[0];
    return `<button class="nav nav-r" data-k="${esc(`round:${dr.did}:${rd.id}`)}"><span class="dot ${statusClass(aggOf(ti))}"></span>
      <span class="nt"><b>第 ${rd.seq} 轮${Date.parse(rd.opened_at) > 0 ? ` · ${esc(shortTime(rd.opened_at).slice(0, 10))}` : ''}</b>
      <small>${code ? `${esc(code.branch || '?')} @ ${esc((code.commit || '').slice(0, 8))}` : '代码版本未记录'}</small>
      <small><b>有结论 ${tested} / 共 ${total} 条</b>${i === dr.rf.rounds.length - 1 && liveOf(dr, i) ? (() => { const tt = trustOf(dr.states[i]); return tt.noshot || tt.gap || tt.cant ? ` · <span class="t-bad">${[tt.noshot && `${tt.noshot} 无画面`, tt.gap && `${tt.gap} 证据不全`, tt.cant && `${tt.cant} 验不了`].filter(Boolean).join(' · ')}</span>` : ''; })() : ''}</small></span></button>`;
  }).join('');
  const latestK = `round:${dr.did}:${dr.rf.rounds[dr.rf.rounds.length - 1].id}`;
  return `<details class="dgrp"${di === 0 ? ' open' : ''} data-did="${esc(dr.did)}" data-latest="${esc(latestK)}"><summary><span class="dot ${statusClass(aggOf(t))}"></span><span class="nt"><b>${esc(dr.demand.title)}</b>
    <small>${esc(dr.did)} · 测了 ${dr.rf.rounds.length} 轮 · ${dr.runCount} 个 run · 最近 ${esc(shortTime(new Date(dr.last).toISOString()).slice(0, 10))}</small>
    <span class="navtally">${tallyBadges(t)}</span></span></summary>${items}</details>`;
}).join('');
const navDecide = pendingFindings.length
  ? `<div class="navsec">等你定</div><button class="nav" data-k="decide">🔻 待裁定 finding <span class="bs bad">${readyFindings.length}</span></button>`
  : '';
// 「等你定」是独立的一节，排在「需求执行记录」标题之前（以前插在标题和需求之间，读起来像需求记录的一部分）
const nav = navTop + navDecide + `<div class="navsec">需求执行记录</div>` + navDemands + '<div style="display:none">' + execs.map(ex => {
  const w = sumTallies(ex.cases.map(({ c, rs }) =>
    tallyOf(walkExpects(c.tree || []), rs[rs.length - 1]?.res?.results || {})));
  const sup = ex.supersededBy ? ` · <b style="color:var(--muted)">↻ 已被 ${esc(ex.supersededBy)} 复跑取代</b>` : '';
  return `<button class="nav nav-d" data-k="${esc(ex.session)}" data-did="${esc(ex.demand.id)}" ${ex.supersededBy ? 'style="opacity:.55"' : ''}><span class="dot ${statusClass(w.agg)}"></span>
    <span class="nt"><b>${esc(ex.demand.title)}</b>
    <small>${esc(ex.date)} · ${ex.cases.length} 用例 / ${w.n} 断言 · ${ex.runCount} 次 run${sup}</small>
    <span class="navtally">${tallyBadges(w.tally)}</span></span></button>`;
}).join('') + '</div>';

const roundPanels = demandRounds.map(dr => dr.rf.rounds.map((_, i) => renderRoundPanel(dr, i)).join('')).join('');
const panels = roundPanels
  + (pendingFindings.length ? `<section class="panel" data-k="decide" hidden>
  <div class="phead"><h1>🔻 等你定（${readyFindings.length} 条）</h1><button class="copylink" data-k="decide">🔗 复制链接</button></div>
  ${renderDecide()}</section>` : '')
  + execs.map(ex => renderExecPanel(ex, false)).join('')
  + cases.map(c => renderCaseDetail(c)).join('')
  + `<section class="panel" data-k="allcases" hidden>
  <div class="phead"><h1>用例集合</h1><button class="copylink" data-k="allcases">🔗 复制链接</button></div>
  ${renderCaseLibrary()}</section>`
  + `<section class="panel" data-k="ops" hidden>
  <div class="phead"><h1>操作集</h1><button class="copylink" data-k="ops">🔗 复制链接</button></div>
  ${renderOps()}</section>`
  + libs.map(lib => `<section class="panel" data-k="${lib.key}" hidden>
  <div class="phead"><h1>${esc(lib.title)}</h1><button class="copylink" data-k="${lib.key}">🔗 复制链接</button></div>
  ${lib.intro ? `<div class="meta">${esc(lib.intro)}</div>` : ''}${lib.html}</section>`).join('');

const wildBanner = wildRuns.length
  ? `<div class="wild">⚠️ 野生 run（没走 acceptkit、无 result.json）${wildRuns.length} 个：${wildRuns.map(r => `<code>${esc(r.id)}</code>`).join(' ')} —— 用 <code>acceptkit probe</code> 扶正</div>` : '';
if (wildRuns.length) console.error(`⚠️  野生 run ${wildRuns.length} 个：${wildRuns.map(r => r.id).join(', ')}`);

const STYLE = `
.plat{display:inline-block;font-size:11px;padding:1px 6px;border-radius:9px;margin-right:3px;border:1px solid var(--line2)}.plat.ok{color:var(--pass);border-color:var(--pass)}.plat.bad{color:var(--fail);border-color:var(--fail)}.plat.na{color:var(--muted)}
.gcell.k-process img,.gcell.k-unverified img{opacity:.75}
.ctree.stub{padding:4px 8px;font-size:13px}
.nav-d{margin-top:6px}
.backbtn{margin-right:12px;padding:3px 10px;border-radius:7px;border:1px solid rgba(255,255,255,.35);background:transparent;color:inherit;cursor:pointer;font-size:13px}.backbtn:hover{background:rgba(255,255,255,.12)}
.bs.self{background:#e7f0ff;color:#0a5fbf;padding:1px 6px;border-radius:9px;font-size:11px}.bs.wait{padding:1px 6px;border-radius:9px;font-size:11px}
details.dgrp{margin:6px 0}details.dgrp>summary{list-style:none;cursor:pointer;display:flex;gap:6px;padding:6px 8px;border-radius:8px}details.dgrp>summary::-webkit-details-marker{display:none}details.dgrp>summary:hover{background:var(--line2)}details.dgrp.cur>summary{background:var(--line2)}.nav-r{margin:2px 0 2px 16px;width:calc(100% - 16px)}pre.flist{max-height:280px;overflow:auto;font-size:11px;background:var(--line2);padding:6px 8px;border-radius:6px}details.rcase{margin:4px 0;border-bottom:1px solid var(--line)}details.rcase>summary{cursor:pointer;padding:4px 0}.whole{margin:8px 0;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.needyou{margin:8px 12px;padding:8px 12px;border-radius:9px;background:#fff4e5;border:1px solid #f0a500;color:#7a4b00;display:flex;gap:10px;align-items:center;flex-wrap:nowrap;overflow:hidden;white-space:nowrap;font-size:13px}
.needyou>*{flex:0 0 auto}.needyou>.ny-item{flex:0 1 auto;min-width:0}
.needyou b{color:#b35c00}
.ny-item{display:inline-flex;gap:5px;align-items:center;padding:2px 8px;border-radius:8px;background:#fff;border:1px solid #f0c880;text-decoration:none;color:#7a4b00;max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ny-item:hover{background:#ffe9c7}
.ny-go{color:inherit;text-decoration:none}.ny-go:hover b{text-decoration:underline}
details.dz>summary{flex-wrap:nowrap;align-items:flex-start}.dz .ct-t{min-width:0;flex:1 1 0}.dz .ct-t b{font-weight:600;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.dz .ct-t .dim{font-family:inherit;font-size:12px;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.dz.flash{outline:2px solid #f0a500}.dz.dz-done{opacity:.55}
.dz-q{white-space:pre-wrap;line-height:1.6;margin:4px 0}.dz-who{margin:6px 0 10px;font-size:13px}.dz-who input{padding:3px 8px;border:1px solid var(--line);border-radius:6px;background:var(--panel);color:inherit}
.dz-form{display:flex;gap:8px;align-items:flex-start;margin:6px 0 8px;flex-wrap:wrap}.dz-form textarea{flex:1 1 360px;font:inherit;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--panel);color:inherit}
.bad-rule{border-left:3px solid var(--fail);color:var(--fail)}
.dz-row{display:grid;grid-template-columns:72px 1fr;gap:8px;margin:6px 0;line-height:1.6}.dz-row>b{color:var(--muted);font-weight:600}
.dz-opts{display:flex;flex-direction:column;gap:6px}.dz-opt{display:flex;gap:8px;align-items:flex-start;padding:6px 8px;border:1px solid var(--line);border-radius:6px;cursor:pointer}.dz-opt:has(input:checked){border-color:var(--pass);background:var(--pass-bg)}.dz-rec{font-size:13px;color:var(--muted)}
.kd{font-size:11px;padding:0 6px;border-radius:8px;border:1px solid var(--line);margin-right:4px}.kd-product_bug{color:var(--fail);border-color:var(--fail)}.dz-tech{margin:6px 0}.dz-unclear{margin-top:18px}.dz-unclear>summary h3{display:inline;margin-right:8px}
.dz-back{padding:5px 12px;border-radius:6px;border:1px solid var(--line);background:var(--panel);color:inherit;cursor:pointer}
.dz-ok{padding:5px 12px;border-radius:6px;border:1px solid var(--pass);background:var(--pass-bg);color:var(--pass);cursor:pointer}.dz-ok:disabled{opacity:.5}
@media (prefers-color-scheme: dark){.needyou{background:#3a2a10;border-color:#a9761f;color:#ffd79a}.needyou b{color:#ffc46b}.ny-item{background:#2a1f10;border-color:#8a6422;color:#ffd79a}.ny-item:hover{background:#3f2d14}}
.navsec{margin:10px 6px 2px;font-size:11px;letter-spacing:.08em;color:var(--muted);text-transform:uppercase}
.navsec:first-child{margin-top:2px}
.caselink{color:inherit;text-decoration:none;border-bottom:1px dashed var(--line)}
.caselink:hover{color:var(--pass);border-bottom-color:var(--pass)}
.rule{margin:10px 0;padding:9px 12px;background:var(--line2);border-radius:7px;font-size:13px;line-height:1.65}
.rule>b{display:block;margin-bottom:3px;font-size:12px;color:var(--fg2)}
ul.pre{margin:4px 0 10px;padding-left:20px;font-size:13px;line-height:1.7}
.given{margin:3px 0 0 26px;font-size:12.5px;color:var(--fg2)}
.glbl{display:inline-block;min-width:30px;padding:0 5px;border-radius:4px;background:var(--line2);font-size:11px;margin-right:5px}
.nnote{margin:3px 0 0 26px;font-size:12px;color:var(--fg2);opacity:.85;line-height:1.55}
.ndata{margin:4px 0 2px 26px}
.ndata pre{margin:2px 0;padding:7px 9px;background:var(--line2);border-radius:6px;font-size:11.5px;overflow:auto;white-space:pre-wrap;word-break:break-all}
.exd{margin:2px 0 0 22px;font-size:12px;color:var(--fg2)}
.exd code{background:var(--line2);padding:1px 5px;border-radius:4px}
.opsteps{margin:6px 0 8px;padding-left:20px}
.opsteps>li{margin:0 0 9px}
.ophow{font-size:12px;color:var(--fg2);margin:2px 0;white-space:pre-wrap;word-break:break-word}
.opshot{display:block;max-width:230px;margin:5px 0;border:1px solid var(--line);border-radius:6px}
.oppit{margin-top:8px;padding:7px 10px;border-left:3px solid var(--fail);background:var(--line2);border-radius:0 6px 6px 0}
.oppit ul{margin:4px 0 0;padding-left:18px}.oppit li{margin:3px 0;font-size:12.5px}
.opref{display:inline-block;margin-left:6px;padding:1px 7px;border-radius:10px;background:var(--line2);
  color:inherit;text-decoration:none;font-size:12px;border:1px solid transparent}
.opref:hover{border-color:var(--pass);text-decoration:none}
.opref.bad{border-color:var(--fail)}
.opcard{border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:10px 0}
.opcard:target{box-shadow:0 0 0 2px var(--pass)}
.oph{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:4px}
.opwhy{font-size:13px;opacity:.85;margin:4px 0 8px}
.opplat{border-left:3px solid var(--line2);padding:2px 0 2px 10px;margin:6px 0}
.opplat-h{font-weight:600;font-size:13px;margin-bottom:2px}
.opkv{font-size:12px;font-family:ui-monospace,Menlo,monospace;opacity:.9;margin:1px 0}
.opusers{font-size:12px;opacity:.8;margin-top:8px;border-top:1px dashed var(--line);padding-top:6px}
.grp{margin:16px 0 20px}
.sfc{border-left:3px solid var(--bd,#e3e5e8);padding:6px 0 6px 10px;margin:8px 0}.sfc-h{font-size:13px;font-weight:600;margin-bottom:4px}.sfc-r,.sfc-l,.sfc-u,.sfc-d{font-size:12px;line-height:1.6;margin:2px 0}.sfc-r b,.sfc-l b,.sfc-u b,.sfc-d b{display:inline-block;min-width:76px;color:var(--muted);font-weight:600}.sfc-r{color:#b4232a}.sfc-u{color:#9a6700}.sfc-d{color:#0a5fbf}:root:not([data-theme=light]) .sfc-r{color:#ff9a9a}:root:not([data-theme=light]) .sfc-u{color:#e3b341}.sev{font-size:11px;padding:1px 6px;border-radius:3px;background:var(--bg2,#eef);color:var(--muted)}.sev.must{background:#b4232a;color:#fff}.tbl{width:100%;border-collapse:collapse;margin:8px 0;font-size:12px}.tbl th{text-align:left;background:var(--bg2,#f6f7f9);color:var(--muted);font-weight:600;padding:5px 8px;border:1px solid var(--bd,#e3e5e8)}.tbl td{padding:5px 8px;border:1px solid var(--bd,#e3e5e8);vertical-align:top}.tbl code{font-size:11px}details.grp>summary{cursor:pointer;list-style:none}details.grp>summary::-webkit-details-marker{display:none}details.grp>summary:before{content:'▸ ';color:var(--muted)}details.grp[open]>summary:before{content:'▾ '}.ghead{font-size:13px;font-weight:700;color:var(--muted);letter-spacing:.02em;margin:0 0 8px;padding-bottom:5px;border-bottom:1px solid var(--line)}
.ghead .dim{font-weight:400}
.pill{display:inline-block;font-size:10.5px;font-weight:620;padding:1px 8px;border-radius:999px;white-space:nowrap;margin-right:3px}
.pill.pass{color:var(--pass);background:var(--pass-bg)}.pill.fail{color:var(--fail);background:var(--fail-bg)}
.pill.mixed{color:var(--mixed);background:var(--mixed-bg)}.pill.wip{color:var(--wip);background:var(--wip-bg)}
details.smx>summary{padding:3px 0}
table.smxt th{text-align:left;font-size:10.5px;color:var(--faint);font-weight:650;padding:4px 8px;border-bottom:1px solid var(--line)}
table.smxt td{font-size:12px;vertical-align:top}
td.inp .kv{display:inline-block;font-family:var(--mono);font-size:11px;background:var(--line2);border-radius:4px;padding:1px 6px;margin:1px 3px 1px 0}
td.inp .kv i{font-style:normal;color:var(--faint);margin-right:5px}
tr.pathrow td{border-bottom:1px solid var(--line2)}
ol.path{margin:4px 0;padding-left:20px;font-size:11px;line-height:1.6}
code.cel{font-family:var(--mono);font-size:10.5px;color:var(--muted);word-break:break-all}
.bk{display:inline-block;font-size:10px;font-weight:650;padding:1px 7px;border-radius:999px;background:var(--wip-bg);color:var(--wip);white-space:nowrap}
.bk.cap{background:var(--mixed-bg);color:var(--mixed)}
.bk.dep{background:var(--line2);color:var(--muted)}
.r-T{color:var(--pass);font-weight:700}.r-F{color:var(--fail);font-weight:700}.r-UNKNOWN{color:var(--wip);font-weight:700}
a.jump{color:inherit}
table.cases{width:100%;border-collapse:collapse;margin-top:12px;font-size:13px}
table.cases th{text-align:left;color:var(--muted);font-weight:600;border-bottom:1px solid var(--line);padding:8px 10px;white-space:nowrap}
table.cases td{border-bottom:1px solid var(--line2);padding:9px 10px;vertical-align:top}
table.cases tr:hover td{background:var(--line2)}
table.cases small.mono{font-family:var(--mono);color:var(--faint)}

:root{--bg:#f6f7f9;--panel:#fff;--ink:#1b2130;--muted:#5b6478;--faint:#8a92a6;--line:#e4e7ee;--line2:#eef0f5;
 --pass:#0e9f6e;--pass-bg:#e7f6ef;--fail:#d61f45;--fail-bg:#fce8ec;--mixed:#b26b00;--mixed-bg:#fbf0dd;--wip:#8a94a2;--wip-bg:#eef0f3;
 --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;--sans:system-ui,-apple-system,"PingFang SC",sans-serif}
@media(prefers-color-scheme:dark){:root{--bg:#0d1017;--panel:#151a23;--ink:#e7eaf1;--muted:#9aa3b6;--faint:#6b7488;--line:#242b38;--line2:#1c222d;
 --pass:#3ad29f;--pass-bg:#0f2a22;--fail:#f2708c;--fail-bg:#2c1620;--mixed:#e0a755;--mixed-bg:#2c2416;--wip:#6b7488;--wip-bg:#1c222d}}
:root[data-theme="dark"]{--bg:#0d1017;--panel:#151a23;--ink:#e7eaf1;--muted:#9aa3b6;--faint:#6b7488;--line:#242b38;--line2:#1c222d;
 --pass:#3ad29f;--pass-bg:#0f2a22;--fail:#f2708c;--fail-bg:#2c1620;--mixed:#e0a755;--mixed-bg:#2c2416;--wip:#6b7488;--wip-bg:#1c222d}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 var(--sans)}
.top{display:flex;align-items:baseline;gap:12px;padding:12px 18px;background:#111;color:#fff}
.top h2{margin:0;font-size:15px}.top small{color:#9aa}
.wrap{display:flex;min-height:calc(100vh - 46px)}
.side{width:290px;flex:0 0 290px;border-right:1px solid var(--line);background:var(--panel);padding:8px;overflow:auto}
.nav{display:flex;gap:9px;align-items:flex-start;width:100%;text-align:left;border:0;background:0;padding:9px 10px;border-radius:8px;cursor:pointer;color:inherit;font:inherit}
.nav:hover{background:var(--line2)}.nav.on{background:var(--line2);box-shadow:inset 2px 0 0 var(--pass)}
.nt{display:flex;flex-direction:column;min-width:0}.nt b{font-size:13px}.nt small{color:var(--faint);font-size:11px}
.dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto;margin-top:5px}
/* ── 用例树：折叠着看状态，点开看路线 ── */
details.ctree{border:1px solid var(--line);border-radius:6px;margin:6px 0;background:var(--bg1,transparent)}
details.ctree>summary{cursor:pointer;list-style:none;display:flex;align-items:center;gap:7px;flex-wrap:wrap;padding:7px 10px;font-size:13px}
details.ctree>summary::-webkit-details-marker{display:none}
details.ctree>summary:before{content:'▸';color:var(--muted);flex:0 0 auto}
details.ctree[open]>summary:before{content:'▾'}
details.ctree>summary:hover{background:var(--bg2,#f6f7f9)}
details.ctree>summary .dot{margin-top:0}
.ct-t{font-weight:600}
.ct-id{font-size:11px;color:var(--muted)}
.ctree-d{font-size:11px}
.ctree-b{padding:2px 10px 10px;border-top:1px solid var(--line)}
details.ctree.gnode{border-style:dashed}
details.ctree.sfnode{border-width:1px 1px 1px 3px;background:var(--bg2,#fafbfc)}
details.ctree.sfnode>summary{font-size:13.5px}
:root:not([data-theme=light]) details.ctree.sfnode{background:rgba(255,255,255,.02)}
/* 左缘按状态着色：一眼扫出哪条路线没过 */
details.ctree.st-fail{border-left:3px solid var(--fail)}
details.ctree.st-blocked{border-left:3px solid var(--wip)}
details.ctree.st-todo{border-left:3px solid var(--line)}
details.ctree.st-pass{border-left:3px solid var(--pass)}
/* 状态计数徽章 */
.pstat{display:inline-flex;gap:3px;flex-wrap:wrap}
.tb{font-size:11px;padding:1px 5px;border-radius:3px;background:var(--bg2,#eef1f4);color:var(--muted);white-space:nowrap}
.tb.pass{background:rgba(35,134,54,.14);color:var(--pass)}
.tb.fail{background:rgba(180,35,42,.14);color:var(--fail)}
.tb.shot{background:rgba(10,95,191,.14);color:#0a5fbf}
:root:not([data-theme=light]) .tb.shot{color:#79b8ff}
details.galwrap{margin:6px 0 10px}
details.galwrap>summary{cursor:pointer;font-size:12px;padding:3px 0}
.tb.blk{background:rgba(154,103,0,.16);color:#9a6700}
.tb.todo{background:var(--bg2,#eef1f4);color:var(--muted)}
.tb.skip{background:var(--bg2,#eef1f4);color:var(--muted)}
.tb.na{background:var(--bg2,#eef1f4);color:var(--muted);text-decoration:line-through dotted}
:root:not([data-theme=light]) .tb.blk{color:#e3b341}
/* 状态解释：没过的为什么没过 —— 每一层都给，不只给最外层 */
.whyl{display:flex;flex-wrap:wrap;gap:6px 14px;margin:3px 0 5px;font-size:11.5px}
.why b{color:#9a6700;font-weight:600}
:root:not([data-theme=light]) .why b{color:#e3b341}
li.node>.nhead .pstat{margin-left:auto}
li.node>.nhead{display:flex;align-items:flex-start;gap:6px;flex-wrap:wrap}
/* 整轮状态卡 */
details.findd{margin:3px 0}
details.findd>summary{cursor:pointer;list-style:none}
details.findd>summary::-webkit-details-marker{display:none}
details.findd>summary:before{content:'▸ ';color:var(--muted)}
details.findd[open]>summary:before{content:'▾ '}
.blk-card{border-left:3px solid var(--wip);background:var(--bg2,#f8f9fa);border-radius:0 4px 4px 0;padding:5px 9px;margin:4px 0;font-size:11.5px;line-height:1.65}
.blk-card.bad{border-left-color:var(--fail)}
.blk-card.ok{border-left-color:var(--pass)}
.blk-h{font-weight:600}
.blk-t{margin-top:2px}
.blk-u b,.blk-a b{display:inline-block;min-width:88px;color:var(--muted);font-weight:600}
.bs{font-weight:400;font-size:11px;padding:0 5px;border-radius:3px;background:rgba(154,103,0,.16);color:#9a6700}
.bs.ok{background:rgba(35,134,54,.16);color:var(--pass)}
.bs.bad{background:rgba(180,35,42,.14);color:var(--fail)}
:root:not([data-theme=light]) .bs{color:#e3b341}
.treebar{float:right;font-weight:400}
.treebar button{font-size:11px;padding:2px 8px;margin-left:5px;border:1px solid var(--line);border-radius:3px;background:transparent;color:var(--muted);cursor:pointer}
.treebar button:hover{background:var(--bg2,#f6f7f9);color:inherit}
.appr{font-size:11.5px;padding:2px 8px;border-radius:3px;font-weight:600}
.appr.ok{background:rgba(35,134,54,.16);color:var(--pass)}
.appr.wait{background:rgba(180,35,42,.14);color:var(--fail)}
.appr.none{background:var(--bg2,#eef1f4);color:var(--muted)}
.cchip{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--line);border-radius:4px;padding:2px 7px;margin:2px 3px 2px 0;text-decoration:none;color:inherit;font-size:11.5px}
.cchip:hover{background:var(--bg2,#f6f7f9)}
.cchip .dot{margin-top:0;width:7px;height:7px}
.cchip.st-fail{border-left:3px solid var(--fail)}
.cchip.st-blocked{border-left:3px solid var(--wip)}
.cchip.st-pass{border-left:3px solid var(--pass)}
.navtally{display:flex;gap:3px;flex-wrap:wrap;margin-top:3px}
.whole{border:1px solid var(--line);border-radius:6px;padding:9px 12px;margin:10px 0}
.flow{display:flex;flex-wrap:wrap;align-items:stretch;gap:4px;margin:10px 0 4px}.farr{align-self:center;color:var(--faint)}
.fstep{border:1px solid var(--line);border-radius:6px;padding:6px 10px;min-width:110px;display:flex;flex-direction:column;gap:2px}.fstep span{font-size:11px;color:var(--muted)}
.fstep.f-done{border-color:var(--pass);background:color-mix(in srgb,var(--pass) 8%,transparent)}.fstep.f-wait{border-color:var(--fail);background:color-mix(in srgb,var(--fail) 8%,transparent)}.fstep.f-doing{border-style:dashed}.fstep.f-empty{opacity:.55}
.progline{font-size:13px;margin:6px 0 10px;color:var(--muted)}.progline b{color:var(--fg)}.progline button.flt{font:inherit;background:none;border:0;padding:0;color:var(--fg);cursor:pointer;border-bottom:1px dotted var(--muted)}.progline button.flt.on{font-weight:700}.progline button.flt.hot{color:var(--fail)}
.lanes{border:1px solid var(--line);border-radius:10px;overflow:hidden;margin:10px 0 6px;font-size:13px}
.ln-row{display:grid;grid-template-columns:minmax(200px,2fr) repeat(6,minmax(58px,.6fr)) minmax(100px,.9fr);align-items:center;gap:8px;padding:8px 12px}
.ln-head{background:var(--line2,#f2f4f7);color:var(--muted);font-size:12px;font-weight:600}.ln-head .ln-name{display:flex;gap:8px;align-items:center}
details.ln{border-top:1px solid var(--line)}details.ln>summary{list-style:none;cursor:pointer}details.ln>summary::-webkit-details-marker{display:none}details.ln>summary:hover{background:color-mix(in srgb,var(--line) 30%,transparent)}
.ln-name{overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;line-height:1.4}.ln-name b{margin-right:4px}
.ln-c{text-align:center;display:flex;flex-direction:column;align-items:center;line-height:1.2}.kz{color:var(--faint)}
.kn{font-weight:600;font-variant-numeric:tabular-nums}.kn-review{color:var(--fail)}.kn-done{color:var(--pass)}.kn-ask{font-size:11px;color:var(--fail)}.kn-sub{font-size:11px;color:var(--muted)}.kn-cant{color:var(--warn,#b7791f)}.kc em.g{color:var(--muted)}
.trust{font-size:13px;line-height:1.7;margin:8px 0;padding:8px 12px;border:1px solid var(--line);border-radius:8px}.t-ok{color:var(--pass);font-weight:600}.t-warn{color:var(--warn,#b7791f)}.t-bad{color:var(--fail)}
.apwhy{margin:4px 0 6px}ol.bq{margin:4px 0 0 18px;padding:0}label.ako{display:block;margin:2px 0;cursor:pointer}ol.bq li{margin:6px 0}ol.bq li.answered{opacity:.6}.ask-done{color:var(--pass,green);margin-top:4px}details.consult{margin-top:4px;font-size:12px;max-width:520px}details.consult summary{cursor:pointer;color:var(--muted,#888)}details.consult ul{margin:4px 0 4px 16px;padding:0}form.ak{display:flex;gap:6px;align-items:flex-start;margin-top:4px;flex-wrap:wrap}form.ak textarea{flex:1;min-width:240px;max-width:640px;padding:4px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:inherit;font:inherit}form.ak button{font:inherit;padding:3px 12px;border-radius:6px;border:1px solid var(--fail);background:var(--fail);color:#fff;cursor:pointer}
.ln-p{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}.ln-bar{flex:1;height:6px;border-radius:3px;background:var(--line);overflow:hidden}.ln-bar i{display:block;height:100%;background:var(--pass)}
.ln-body{display:grid;grid-template-columns:minmax(200px,2fr) repeat(6,minmax(58px,.6fr)) minmax(100px,.9fr);gap:8px;padding:0 12px 10px}.ln-body>.ln-cards:nth-child(7){grid-column:7/9}.ln-full{font-size:12px;line-height:1.5}
.ln-cards{display:flex;flex-direction:column;gap:4px}
.kc{font:inherit;font-size:12px;text-align:left;border:1px solid var(--line);background:var(--bg);color:var(--fg);border-radius:6px;padding:4px 8px;cursor:pointer;line-height:1.35}.kc:hover{border-color:var(--muted)}.kc.ask{border-color:var(--fail)}.kc em{display:block;font-style:normal;font-size:11px;color:var(--fail)}
button.ln-all{font:inherit;font-weight:400;font-size:11px;border:1px solid var(--line);background:var(--bg);color:var(--muted);border-radius:4px;padding:0 6px;cursor:pointer}
.you-h{font-weight:700;color:var(--fail);margin-bottom:4px}.ask-h{line-height:1.6}.you button.flt.link{font:inherit;font-size:12px;background:none;border:0;color:var(--fg);border-bottom:1px dotted var(--muted);padding:0;cursor:pointer}
details.apd>summary{cursor:pointer;color:var(--muted);font-size:12px;margin:2px 0}
@media (max-width:760px){.ln-row,.ln-body{grid-template-columns:1fr repeat(6,36px)}.ln-p,.ln-body>span,.ln-full{display:none}.ln-body>.ln-cards:nth-child(7){grid-column:auto}.ln-head .ln-name{font-size:11px}}
.apbox{margin:6px 0 2px;font-size:13px;line-height:1.55}.apcase{border-left:3px solid var(--fail);padding:4px 10px;margin:6px 0;background:var(--bg)}.apcase ul,.apas{margin:2px 0 2px 18px;padding:0}.apas{font-size:12px}
form.ap textarea{width:100%;max-width:640px;display:block;margin:6px 0;padding:4px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:inherit;font:inherit}
form.ap button{font:inherit;padding:3px 12px;border-radius:6px;border:1px solid var(--fail);background:var(--fail);color:#fff;cursor:pointer}form.ap button.ghost{background:none;color:var(--fg);border-color:var(--line)}
@media (max-width:760px){.kb{grid-template-columns:repeat(5,minmax(90px,1fr))}.kb-lane{grid-column:1/-1}.kb>.kb-h:first-child{display:none}}
.prog{display:flex;height:14px;border-radius:7px;overflow:hidden;margin:12px 0 6px;font-size:10px;line-height:14px;text-align:center;color:#fff}.prog span{min-width:18px}
.p-done{background:var(--pass)}.p-report{background:color-mix(in srgb,var(--pass) 55%,var(--bg))}.p-blind{background:color-mix(in srgb,var(--pass) 30%,var(--muted))}.p-exec{background:var(--muted)}.p-review{background:var(--fail)}
.progline{font-size:13px;margin-bottom:8px}.progline button.flt{font:inherit;background:none;border:0;padding:0;color:var(--fg);text-decoration:underline dotted;cursor:pointer}.progline button.flt.on{font-weight:700}
.you{border:1px solid var(--fail);border-radius:8px;padding:8px 12px;margin:8px 0;background:color-mix(in srgb,var(--fail) 5%,transparent)}.you.ok{border-color:var(--line);background:none;color:var(--muted)}
.you-h{font-weight:700;color:var(--fail);margin-bottom:2px}.you ol{margin:0;padding-left:20px}.you li{margin:4px 0}.you button.flt{font-size:12px;border:1px solid var(--line);background:var(--bg);color:var(--fg);border-radius:4px;padding:0 6px;cursor:pointer}
.devs{margin:6px 16px;font-size:13px}.devs summary{cursor:pointer}.devs ul{margin:4px 0 4px 18px;padding:0}.devs li{margin:2px 0}.devs li.dv-bad{color:var(--fail)}.devs li.dv-warn{color:var(--warn,#b7791f)}
.fresh{position:fixed;top:8px;right:12px;z-index:50;background:var(--bg);border:1px solid var(--fail);color:var(--fg);border-radius:6px;padding:4px 10px;font-size:12px;box-shadow:0 2px 8px rgba(0,0,0,.12)}.fresh a{margin-left:6px}
.stg{font-size:11px;padding:1px 6px;border-radius:4px;border:1px solid var(--line);color:var(--muted);white-space:nowrap}.stg-review{border-color:var(--fail);color:var(--fail)}.stg-done{border-color:var(--pass);color:var(--pass)}.stg-cant{border-color:var(--warn,#b7791f);color:var(--warn,#b7791f)}
.pulled{margin:4px 0 8px;font-size:12px}.pulled summary{cursor:pointer;color:var(--muted)}.pulled ol{margin:4px 0 0 18px;padding:0}
.via{font-size:11px;padding:0 5px;border-radius:4px;margin-left:4px;white-space:nowrap}.via.ui{background:color-mix(in srgb,var(--pass) 14%,transparent);color:var(--pass)}.via.cli{background:color-mix(in srgb,var(--warn,#b7791f) 16%,transparent);color:var(--warn,#b7791f)}
.cshots{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:6px;margin:6px 0;max-width:900px}.noshot{color:var(--fail);font-size:12px;margin:6px 0}
.cwhy{font-size:12px;color:var(--muted);margin:4px 0 6px;line-height:1.5}.egrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:4px;margin-bottom:4px;max-width:380px}td.evcol{min-width:260px}td.evcol code.ev{word-break:break-all}
.whole-h{display:flex;align-items:center;gap:9px;flex-wrap:wrap;font-size:13px}
.whole.st-fail{border-left:4px solid var(--fail)}
.whole.st-blocked{border-left:4px solid var(--wip)}
.whole.st-todo{border-left:4px solid var(--line)}
.whole.st-pass{border-left:4px solid var(--pass)}
/* 证据缩略图条 */
.ctree-shots{margin-top:8px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.ctree-shots b{font-size:11px;color:var(--muted);margin-right:4px}
.shot-th img{height:56px;border-radius:4px;border:1px solid var(--line);display:block}

.dot.pass{background:var(--pass)}.dot.fail{background:var(--fail)}.dot.mixed{background:var(--mixed)}.dot.wip{background:var(--wip)}
.main{flex:1;min-width:0;padding:20px 24px}
h1{font-size:20px;margin:0 0 4px}.meta{color:var(--faint);font-size:12px;margin-bottom:10px}
.phead{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.copylink{margin-left:auto;border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:6px;font-size:12px;padding:4px 11px;cursor:pointer;white-space:nowrap;font:inherit;font-size:12px}
.copylink:hover{background:var(--line2)}
.copylink.done{color:var(--pass);border-color:var(--pass);background:var(--pass-bg)}
.desc{color:var(--muted);background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--mixed);border-radius:8px;padding:10px 12px;margin:0 0 16px}
.case{background:var(--panel);border:1px solid var(--line);border-radius:11px;margin-bottom:14px;padding:12px 14px}
.chead{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px}
.chead b{font-size:14px}.chead code,.dim{color:var(--faint);font-size:11.5px;font-family:var(--mono)}
.rule{font-size:12.5px;line-height:1.7;background:var(--line2);border:1px solid var(--line);border-left:3px solid var(--pass);border-radius:8px;padding:9px 12px;margin:0 0 10px}
.rule .rk{font-size:11px;font-weight:700;color:var(--muted);margin-bottom:4px}
.rep{font-size:12px;color:var(--muted);border-left:2px solid var(--line);padding-left:10px;margin:0 0 10px}
.rep .k{display:inline-block;min-width:80px;color:var(--faint);font-family:var(--mono);font-size:11px}
details.run{border-top:1px solid var(--line2);padding:8px 0}
details.run>summary{cursor:pointer;list-style:none;display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12.5px}
details.run>summary::-webkit-details-marker{display:none}
.badge{font-size:11px;font-weight:650;padding:2px 9px;border-radius:999px;white-space:nowrap}
.badge.pass{color:var(--pass);background:var(--pass-bg)}.badge.fail{color:var(--fail);background:var(--fail-bg)}
.badge.mixed{color:var(--mixed);background:var(--mixed-bg)}.badge.wip{color:var(--wip);background:var(--wip-bg)}
.cont{color:var(--faint);font-size:11px}
table.rt{width:100%;border-collapse:collapse;font-size:12.5px;margin:8px 0}
table.rt td{padding:6px 8px;border-bottom:1px solid var(--line2);vertical-align:top}
table.rt td:first-child{white-space:nowrap;width:1%;font-family:var(--mono);font-size:11.5px}
table.rt td.hd{font-weight:700;color:var(--muted);background:var(--line2);font-family:var(--sans)}
ul.tree{list-style:none;margin:4px 0;padding-left:0}
ul.tree ul.tree{padding-left:16px;border-left:1px dashed var(--line);margin-left:4px}
ul.inner{list-style:none;margin:2px 0 6px;padding-left:18px}
li.node{margin:6px 0}
.nhead{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;font-size:13px}
.nhead b{font-weight:620}
code.nid{font-family:var(--mono);font-size:10.5px;color:var(--faint)}
code.tag{font-family:var(--mono);font-size:10px;color:var(--muted);background:var(--line2);padding:0 4px;border-radius:3px}
code.aid{font-family:var(--mono);font-size:10.5px;color:var(--muted)}
li.as-li{font-size:12.5px;margin:3px 0;line-height:1.5}
li.as-li.st-fail{color:var(--fail)}li.as-li.st-pass .ac{color:var(--muted)}
li.step{font-size:11.5px;color:var(--faint);margin:2px 0}
.concl{font-size:12.5px;font-weight:600;margin:2px 0 6px 18px;padding:4px 10px;border-left:3px solid var(--pass);background:var(--line2);border-radius:0 6px 6px 0}
.evs{margin-top:2px}
code.ev.mach{color:var(--mixed)}
code.ev.miss{color:var(--fail);text-decoration:line-through}
.probe{border:1px solid var(--line2);border-radius:8px;margin:6px 0;overflow:hidden}
.probe .pk{font-family:var(--mono);font-size:10.5px;color:var(--muted);background:var(--line2);padding:5px 9px}
.probe table.rt{margin:0}
b.ok{color:var(--pass)}b.bad{color:var(--fail)}
table.rt tr.st-fail td:first-child{color:var(--fail)}table.rt tr.st-pass td:first-child{color:var(--pass)}
.as{font-weight:520}.ac{color:var(--muted);font-size:12px;margin-top:3px;white-space:pre-wrap}
.find{display:inline-block;margin-top:4px;font-size:10.5px;font-family:var(--mono);color:var(--fail);background:var(--fail-bg);padding:1px 6px;border-radius:4px}
code.ev{display:inline-block;font-family:var(--mono);font-size:10.5px;color:var(--muted);background:var(--line2);padding:1px 5px;border-radius:4px;margin:1px 2px 1px 0;word-break:break-all}
code.ev.shot{color:var(--pass)}
h5{font-size:11.5px;color:var(--faint);margin:12px 0 2px;font-weight:650;letter-spacing:.03em}
h4{font-size:12px;color:var(--muted);margin:14px 0 2px}
.gal{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:8px;margin-top:6px}
.gcell{margin:0;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--bg)}
.gcell img{width:100%;height:78px;object-fit:cover;display:block;cursor:zoom-in}
.gcell figcaption{font-size:10px;color:var(--faint);padding:3px 5px;border-top:1px solid var(--line2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.evgrid{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:8px}@media(max-width:760px){.evgrid{grid-template-columns:1fr}}
.evc{border:1px solid var(--line2);border-radius:8px;overflow:hidden;min-width:0}
.evk{font-size:10.5px;color:var(--muted);font-weight:620;padding:6px 9px;background:var(--line2)}
.evc pre{margin:0;padding:9px;font-family:var(--mono);font-size:11px;line-height:1.5;overflow:auto;max-height:260px;white-space:pre}
.wild{background:var(--fail-bg);color:var(--fail);padding:8px 14px;font-size:12px}
#lb{position:fixed;inset:0;background:rgba(0,0,0,.92);display:none;align-items:center;justify-content:center;z-index:9}
#lb img{max-width:92%;max-height:88%}#lb .x{position:absolute;top:8px;right:18px;color:#ccc;font-size:30px;cursor:pointer;z-index:2}
#lb .txt{display:none;background:var(--panel);color:var(--ink);width:88%;max-height:86%;border-radius:10px;overflow:auto;padding:0}
#lb .txt h6{margin:0;padding:10px 14px;font-size:12px;font-family:var(--mono);background:var(--line2);position:sticky;top:0}
#lb .txt pre{margin:0;padding:12px 14px;font-family:var(--mono);font-size:11.5px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
code.ev.open{cursor:pointer;text-decoration:underline dotted}code.ev.open:hover{color:var(--ink);background:var(--line)}
`;

const d = new Date(); const pad = n => String(n).padStart(2, '0');
const now = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

const HTML = `<title>${esc(DASH.tabTitle || DASH.title || 'acceptkit 看板')}</title><style>${STYLE}</style>
<div class="top"><button id="backbtn" class="backbtn" hidden title="回到上一个页面">← 返回</button><h2>${esc(DASH.title || ((PROJ.config.name || 'acceptkit') + ' · 验收看板'))}</h2><small>按需求组织 · 每个需求下列它跑过的用例与 run · 生成 ${esc(now)}</small></div>
${wildBanner}
<div id="devboard"></div>
${decideBanner}
<div class="wrap"><div class="side">${nav}</div><div class="main">${panels}</div></div>
<div id="lb"><span class="x">×</span><img/><div class="txt"><h6></h6><pre></pre></div></div>
<script>
const navs=[...document.querySelectorAll('.nav')],pans=[...document.querySelectorAll('.panel')];
// 选中态既写进本页 hash(#run=<demandId>), 也上报父页 —— 宿主页把它落到 ?run= 上,
// 于是切 tab 回来 / 分享链接都能落回同一条需求。key 用 demand.id, 不用下标。
// 浏览栈（点了名称跳过去之后必须能返回）：每次切面板记下来处，顶栏「← 返回」与浏览器后退都能回去
let curK=null;const backStack=[];const backBtn=document.getElementById('backbtn');
function syncBack(){if(backBtn)backBtn.hidden=!backStack.length;}
function sel(k,fromBack){if(curK&&curK!==k&&!fromBack){backStack.push(curK);if(backStack.length>50)backStack.shift();try{history.pushState({k},'','#run='+encodeURIComponent(k))}catch(e){}}
 curK=k;syncBack();
 navs.forEach(n=>n.classList.toggle('on',n.dataset.k===k));
 // 侧栏要能一眼看出现在在看哪个：选中的按钮看得见就高亮它；是隐藏的单次执行（链接直达）就高亮它所属的需求。都滚到看得见的地方
 const on=navs.find(n=>n.dataset.k===k);
 const grp=on?(on.closest('details.dgrp')||(on.dataset.did&&document.querySelector('details.dgrp[data-did="'+CSS.escape(on.dataset.did)+'"]'))):null;
 document.querySelectorAll('details.dgrp').forEach(g=>g.classList.toggle('cur',g===grp));
 if(grp){grp.open=true;}
 const vis=on&&on.offsetParent?on:(grp?grp.querySelector('summary'):null);
 if(vis&&!fromBack)try{vis.scrollIntoView({block:'nearest'})}catch(e){}
 pans.forEach(p=>p.hidden=p.dataset.k!==k);
 const cur=pans.find(p=>p.dataset.k===k);if(cur&&cur.dataset.lazy!==undefined)loadPanel(cur);
 if(!fromBack&&!location.hash.endsWith(encodeURIComponent(k)))try{history.replaceState({k},'','#run='+encodeURIComponent(k))}catch(e){location.hash='run='+encodeURIComponent(k)}
 try{parent.postMessage({type:'${HOST_MSG}-run',run:k},'*')}catch(e){}}
function goBack(){const k=backStack.pop();if(k){sel(k,true);window.scrollTo(0,0);}syncBack();}
if(backBtn)backBtn.onclick=goBack;
window.addEventListener('popstate',()=>{if(backStack.length)goBack();});
navs.forEach(n=>n.onclick=()=>sel(n.dataset.k));
// 点需求那一行 = 看这条需求（最新一轮）。只折叠/展开轮次列表的话，第一条需求默认是展开的，
// 一点反而把它收起来，右侧什么都不变 —— 像是点了没反应。正在看这条需求时再点，才是收起。
document.querySelectorAll('details.dgrp>summary').forEach(s=>s.addEventListener('click',e=>{
 const g=s.parentElement,mine=curK&&[...g.querySelectorAll('.nav')].some(n=>n.dataset.k===curK);
 if(g.open&&mine)return;e.preventDefault();g.open=true;sel(g.dataset.latest);window.scrollTo(0,0);}));
// 清单 → 详情：详情面板没有对应的侧栏按钮，所以 sel 之后侧栏保持「用例集合」高亮
document.addEventListener('click',e=>{const a=e.target.closest('.caselink,.opref[href^="#run="]');if(!a)return;
 const m=/run=(.+)$/.exec(a.getAttribute('href')||'');if(!m)return;e.preventDefault();
 sel(decodeURIComponent(m[1]));window.scrollTo(0,0);});
// 评审单的用例引用 → 树上的那条用例：**展开 + 滚过去 + 高亮**。
// 两条教训写死在这里：
//  ① 跳过去看到一个关着的抽屉 = 这次点击没有任何可见结果（L7）；必须 open=true。
//  ② 绝不写 location.hash —— hash 是面板路由（run=<session>），写成 case-node-x
//     会让「复制链接 / 刷新」落到别的面板去（实测落到 allcases）。所以 preventDefault。
document.addEventListener('click',e=>{const a=e.target.closest('a.cchip');if(!a)return;
 e.preventDefault();
 const el=document.querySelector(a.getAttribute('href'));if(!el)return;
 let n=el;while(n){if(n.tagName==='DETAILS')n.open=true;n=n.parentElement;}   // 连同祖先分组一起展开
 el.scrollIntoView({behavior:'smooth',block:'start'});
 el.style.transition='box-shadow .2s';el.style.boxShadow='0 0 0 2px var(--pass)';
 setTimeout(()=>{el.style.boxShadow=''},1600);});
// 用例里的操作引用：切到「操作集」面板并滚到对应条目（像 wiki 的关键词跳转）
document.addEventListener('click',e=>{const a=e.target.closest('.opref');if(!a)return;
 e.preventDefault();sel('ops');
 const el=document.getElementById('op-'+a.dataset.op);
 if(el){el.scrollIntoView({behavior:'smooth',block:'center'});
   el.style.transition='box-shadow .2s';el.style.boxShadow='0 0 0 2px var(--pass)';
   setTimeout(()=>{el.style.boxShadow=''},1600);}});
// 展开态持久化：看板是「每次开页现跑生成器」，不记住 = 每次回来都要把刚才点开的重点一遍。
// 只存已展开的 id（白名单），所以新增用例默认仍是折叠的。
(function(){const K='${HOST_MSG}:open-trees';
 const read=()=>{try{return new Set(JSON.parse(sessionStorage.getItem(K)||'[]'))}catch(e){return new Set()}};
 const save=st=>{try{sessionStorage.setItem(K,JSON.stringify([...st]))}catch(e){}};
 window.__restoreOpen=root=>{const st=read();root.querySelectorAll('details.ctree[id]').forEach(d=>{if(st.has(d.id))d.open=true;});};
 window.__restoreOpen(document);
 document.addEventListener('toggle',e=>{const d=e.target;
   if(!(d instanceof HTMLDetailsElement)||!d.id||!d.classList.contains('ctree'))return;
   const cur=read();d.open?cur.add(d.id):cur.delete(d.id);save(cur);},true);
 // 每个面板都有一条 treebar，所以只能按 class 做事件委托；早先用 id 选择器，
 // 而 72 个面板里 id 重复，getElementById 永远返回第一个（还在别的面板里）⇒ 按钮点了没反应。
 document.addEventListener('click',e=>{const b=e.target.closest('.treebar button');if(!b)return;
   const act=b.dataset.act;const pan=b.closest('.panel');if(!pan)return;
   const ds=[...pan.querySelectorAll('details.ctree[id]')];
   // 用 classList 不用正则：这段 JS 写在 JS 模板字符串里，反斜杠 b 会被当成退格转义吃掉，
   // 输出成 /<0x08>st-.../ —— 永远匹配不上，而且 grep 看上去完全正常（实测踩到）。
   // 同理：这段注释里一个反引号都不能有，否则直接把外层模板字符串断掉（也实测踩到两次）。
   const BAD=['st-fail','st-blocked','st-todo'];
   const pick=act==='all'?ds:act==='none'?[]:ds.filter(d=>BAD.some(c=>d.classList.contains(c)));
   ds.forEach(d=>{const want=pick.includes(d);if(d.open!==want)d.open=want;});});
})();
// 裁定页的条目链接 #run=decide&f=<Fxx>：切到裁定页，展开那一条并滚过去
function focusFinding(id){const d=document.querySelector('details.dz[data-f="'+id+'"]');if(!d)return;d.open=true;d.scrollIntoView({block:'center'});d.classList.add('flash');setTimeout(()=>d.classList.remove('flash'),1600);}
document.addEventListener('click',e=>{const a=e.target.closest('.needyou a[href^="#run=decide"]');if(!a)return;e.preventDefault();
 const f=/[&]f=([^&]+)/.exec(a.getAttribute('href'));sel('decide');if(f)focusFinding(decodeURIComponent(f[1]));else window.scrollTo(0,0);});
(function(){const h=location.hash==='#decide'?'#run=decide':(location.hash||'');const m=/run=([^&]+)/.exec(h);const want=m?decodeURIComponent(m[1]):'';
 const ff=/[&]f=([^&]+)/.exec(h);if(ff)setTimeout(()=>focusFinding(decodeURIComponent(ff[1])),0);
 const known=want&&pans.some(p=>p.dataset.k===want);
 // 没指定就落到第一个需求的最新一轮（需求执行记录是主视图）
 const firstRound=document.querySelector('.nav-r');
 sel(known?want:(firstRound?firstRound.dataset.k:(navs[0]&&navs[0].dataset.k)));})();
// 在页面上直接裁定：POST 给管理页面，由它调 acceptkit plan decide 写回那一条（原话照抄）。
// 裁定人由管理页面填（这台电脑的主人，project.mjs ownerIdentity）；原话是 owner 自己选 / 写的，页面不替他写。
(function(){const URL_=${JSON.stringify(DECIDE_URL)};if(!URL_)return;
 document.addEventListener('click',async e=>{const b=e.target.closest('.dz-ok,.dz-back');if(!b)return;
  const back=b.classList.contains('dz-back');
  const d=b.closest('details.dz'),msg=d.querySelector('.dz-msg'),note=d.querySelector('textarea').value.trim();
  const pick=d.querySelector('.dz-opt input:checked');
  // 选了选项：原话 =「选 A：<选项原文>」+ 补充；没选只写了字也行（不在选项里的决定）
  const q=back?note:(pick?('选 '+pick.value+'：'+pick.dataset.label+(note?'。'+note:'')):note);
  if(!q){msg.textContent=back?'写一句哪里看不懂，执行者照这句重写':'选一个选项，或写下你的决定';d.querySelector('textarea').focus();return;}
  if(!confirm('将以 '+${JSON.stringify(OWNER)}+' 的身份记录：'+q))return;
  b.disabled=true;msg.textContent='写入中…';
  try{const r=await fetch(URL_,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:back?'bounce':'decide',demand:d.dataset.d,finding:d.dataset.f,quote:q})});
   const j=await r.json();if(!r.ok)throw new Error(j.error||r.status);
   d.classList.add('dz-done');d.open=false;d.querySelector('summary .dot').className='dot pass';
   d.querySelector('summary').insertAdjacentHTML('beforeend',back?'<span class="bs self">已退回重写</span>':'<span class="bs ok">已定</span>');
   const left=document.querySelectorAll('details.dz:not(.dz-done)').length;
   document.querySelectorAll('.needyou .ny-go b, [data-k=decide] .bs.bad').forEach(x=>{x.textContent=x.tagName==='B'?'等你定 '+left+' 条':String(left)});
  }catch(err){msg.textContent='没写进去：'+err.message;b.disabled=false;}});})();
const lb=document.getElementById('lb');
document.addEventListener('click',e=>{
 // 复制链接: 嵌在别的页面里时父页知道真实地址, 由它拼链接并写剪贴板；单独打开（acceptkit serve）时自己拼。
 if(e.target.classList.contains('copylink')){
   if(parent===window){var u=location.origin+location.pathname+location.search+'#run='+encodeURIComponent(e.target.dataset.k),b=e.target;
     var done=function(){b.textContent='✓ 已复制';b.classList.add('done');setTimeout(function(){b.textContent='🔗 复制链接';b.classList.remove('done')},1600)};
     if(navigator.clipboard)navigator.clipboard.writeText(u).then(done,function(){prompt('复制这个链接',u)});else prompt('复制这个链接',u);}
   else{try{parent.postMessage({type:'${HOST_MSG}-copy',run:e.target.dataset.k},'*')}catch(x){}}}
 else if(e.target.matches('.gcell img')){lb.querySelector('img').src=e.target.src;
   lb.querySelector('img').style.display='';lb.querySelector('.txt').style.display='none';lb.style.display='flex';}
 else if(e.target.matches('code.ev.open')){
   var d=EV()[e.target.dataset.ev];if(!d)return;
   lb.querySelector('img').style.display='none';
   var t=lb.querySelector('.txt');t.style.display='block';
   var show=function(x){t.querySelector('h6').textContent=d.name+(x.truncated?'  （内容过大，只显示前 400KB）':'');t.querySelector('pre').textContent=x.text;};
   if(d.src){show({text:'加载中…'});fetch(d.src).then(function(r){return r.json()}).then(show,function(){show({text:'（取不到这份证据）'})});}else show(d);
   lb.style.display='flex';}
 else if(e.target===lb||e.target.matches('#lb .x')){lb.style.display='none';}});
// 证据表放在页面最后、第一次点开时才解析：面板和导航先能用，不等它
// 管理页面出的看板只带面板的空壳（data-lazy），第一次切到时才取内容和它用到的那部分证据表（server.mjs splitPanels）；
// 本地文件打开的看板面板全在页面里，不走这里。
function loadPanel(p){delete p.dataset.lazy;p.innerHTML='<div class="meta">加载中…</div>';
 fetch('panel?k='+encodeURIComponent(p.dataset.k)).then(function(r){if(!r.ok)throw new Error(r.status);return r.json()}).then(function(j){
  p.innerHTML=j.html;Object.assign(EV(),j.ev||{});if(window.__restoreOpen)window.__restoreOpen(p);},
 function(e){p.dataset.lazy='';p.innerHTML='<div class="meta">没取到这一页（'+e.message+'），刷新再试</div>';});}
// 「等你」里直接批评审单：POST 给管理页面，由它调 acceptkit plan approve（名字和原话是 owner 自己填的，页面不替任何人签）
document.addEventListener('submit',e=>{if(e.target.closest('form.ap'))e.preventDefault();});
document.addEventListener('click',async e=>{const btn=e.target.closest('form.ap button[data-a]');if(!btn)return;e.preventDefault();const f=btn.closest('form.ap');
 const msg=f.querySelector('.ap-msg'),note=f.note.value.trim(),act=btn.dataset.a;
 if(act==='return'&&!note){msg.textContent='退回要写一句：为什么、要怎么改';f.note.focus();return;}
 // 一点就以主人身份落库：先确认，让人看清会记下什么
 if(!confirm('将以 '+${JSON.stringify(OWNER)}+' 的身份记录：'+btn.textContent.trim()+(note?'。'+note:'')))return;
 const u=${JSON.stringify(DECIDE_URL)};msg.textContent='写入中…';
 try{const r=await fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:act,demand:f.dataset.d,note,button:btn.textContent.trim()})});
  const j=await r.json();if(!r.ok)throw new Error(j.error||r.status);msg.textContent=act==='approve'?'已批准，刷新后生效':'已退回，执行者会照你的意见改';f.querySelectorAll('button').forEach(x=>x.disabled=true);}
 catch(err){msg.textContent='没写进去：'+err.message}});
document.addEventListener('click',e=>{const b=e.target.closest('button.ln-all');if(!b)return;e.preventDefault();const box=b.closest('.lanes');const ds=[...box.querySelectorAll('details.ln')];const open=!ds.every(d=>d.open);ds.forEach(d=>d.open=open);b.textContent=open?'全部收起':'全部展开';});
// 本机设备一条：管理页面现取（device-board.mjs），本地文件打开的看板取不到就不显示
(function(){const el=document.getElementById('devboard');if(!el||!document.querySelector('meta[name=ak-gen]'))return;
 const load=()=>fetch('devices',{cache:'no-store'}).then(r=>r.ok?r.text():'').then(h=>{if(!h)return;const open=el.querySelector('details')?.open;el.innerHTML=h;const d=el.querySelector('details');if(d&&open!==undefined)d.open=open;}).catch(()=>{});
 load();setInterval(load,15000);})();
// 「等你」里直接答阻塞：POST 给管理页面，由它调 acceptkit blockers --ack（身份由服务填，原话是你写的）
document.addEventListener('submit',async e=>{const f=e.target.closest('form.ak');if(!f)return;e.preventDefault();
 const msg=f.querySelector('.ap-msg'),pk=f.querySelector('input[name=pick]:checked'),extra=f.note.value.trim();
 const note=pk?('选 '+pk.value+(extra?'。'+extra:'')):extra;if(!note){msg.textContent='选一个，或写下你的答复';f.note.focus();return;}
 if(!confirm('将以 '+${JSON.stringify(OWNER)}+' 的身份记下答复：'+note))return;
 msg.textContent='写入中…';
 try{const r=await fetch(${JSON.stringify(DECIDE_URL)},{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'ack',demand:f.dataset.d,blockers:f.dataset.b.split(','),note})});
  const j=await r.json();if(!r.ok)throw new Error(j.error||r.status);
  const li=f.closest('li');const done=document.createElement('div');done.className='ask-done';done.textContent='✓ 已答：'+note+'。执行者会照你的话重测，这一条刷新后从「等你」里移走';
  f.replaceWith(done);if(li){li.classList.add('answered');li.querySelectorAll(':scope > .dim').forEach(x=>x.hidden=true);}}
 catch(err){msg.textContent='没写进去：'+err.message}});
// 「等你」和进度条上的筛选：只看这一类用例（再点「看全部」恢复）
document.addEventListener('click',e=>{const b=e.target.closest('button.flt');if(!b)return;const pan=b.closest('.panel');if(!pan)return;const f=b.dataset.f;
 pan.querySelectorAll('button.flt').forEach(x=>x.classList.toggle('on',x===b&&!!f));
 const rows=[...pan.querySelectorAll('details.rcase')];rows.forEach(d=>{d.hidden=!!f&&(f==='ask'?d.dataset.ask!=='1':f.startsWith('case:')?d.dataset.case!==f.slice(5):f.startsWith('o:')?d.dataset.o!==f.slice(2):d.dataset.stage!==f)});
 if(f.startsWith('case:')){const one=rows.find(d=>!d.hidden);if(one)one.open=true;}
 const first=rows.find(d=>!d.hidden);if(f&&first)first.scrollIntoView({behavior:'smooth',block:'center'});});
// 页面会过时：管理页面出的看板定时问一次「数据变了没」（/version），变了就在右上角说，点一下刷新；
// 后台正在重新生成也说一声。本地文件打开的看板取不到 /version，什么都不显示。
(function(){const m=document.querySelector('meta[name=ak-gen]');if(!m)return;const gen=Number(m.content);
 const chip=document.createElement('div');chip.className='fresh';chip.hidden=true;document.body.appendChild(chip);
 const hm=t=>new Date(t).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
 async function poll(){try{const j=await (await fetch('version',{cache:'no-store'})).json();
  if(j.gen>gen){chip.hidden=false;chip.innerHTML='数据有更新（'+hm(j.gen)+'），这页是 '+hm(gen)+' 的<a href="">刷新</a>';}
  else if(j.updating){chip.hidden=false;chip.textContent='数据有变化，正在重新生成…';}
  else chip.hidden=true;}catch(e){}}
 poll();setInterval(poll,15000);})();
function EV(){if(!window.__EV){try{window.__EV=JSON.parse(document.getElementById('evdata').textContent)}catch(x){window.__EV={}}}return window.__EV}
window.addEventListener('message',e=>{if(e.data&&e.data.type==='${HOST_MSG}-copied'){
 var b=document.querySelector('.panel:not([hidden]) .copylink');
 if(b){b.textContent='✓ 已复制';b.classList.add('done');setTimeout(function(){b.textContent='🔗 复制链接';b.classList.remove('done')},1600)}}});
</script>
<script id="evdata" type="application/json">__EVDATA__</script>`;

// 证据内容随页面内联（点 chip 在浮层里看）。必须在最后拼：chip 渲染完才知道收了哪些文件。
// `</` 转义掉，否则证据里出现的字面量会提前闭合 <script> 标签，整页脚本当场断掉。
const evJson = JSON.stringify(Object.fromEntries(evStore)).replace(/<\//g, '\\u003c/');
// ⚠️ 必须用**函数式**替换：String.replace 的字符串替换值里 `$'` `$\`` `$&` `$$` 是特殊模式，
// 会被展开成"匹配前/后的内容"。证据原文（例如编码过的配置）里 `$` 和引号满地都是，
// 用字符串替换会把 JSON 拦腰打断 —— 表现是页面上证据 chip 点了没反应（JSON.parse 静默失败）。
writeFileSync(OUT, HTML.replace('__EVDATA__', () => evJson));
process.stderr.write(`wrote ${OUT} (${execs.length} 执行 / ${cases.length} 用例集 / ${runs.length} run / 内联证据 ${evStore.size} 份)\n`);
// 溢出必须报出来：图改成 file:// 引用后，看板移动到别的机器就打不开那些图，
// 而页面上看不出区别 —— 不报的话这会表现为「有些证据图莫名空白」。
if (__spilled) process.stderr.write(`⚠️  内嵌预算 ${(INLINE_BUDGET/1e6).toFixed(0)}MB 用完，${__spilled} 张图改为 file:// 引用`
  + `（本机能看，拷走就看不到）。要全内嵌：ACCEPTKIT_INLINE_BUDGET=<字节数>；`
  + `更好的办法是配 ASSET_BASE 让宿主页代理取图。\n`);
