// next — 从磁盘上的记录推出一个需求还剩的每件事，按顺序列成卡片（docs/002-protocol.md 第二、三节）。
//
// 为什么由工具算：「做到哪了」不能靠执行者记 —— 会话一断、换一个 agent，记忆就没了；
// 每一轮从磁盘重新算，中断了从第 1 张卡片接着做。所以这里只读文件，不写（连轮次文件都不补建）。
//
// 顺序：attention → plan_draft → finding_unclear / blocker_own → round_stale
//       → 每个运行内 device_needed → step_todo → expect_todo → rejected → review_due → report_due
//       → run_needed → stalled
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadPlan, planCases, approvedCases, planDelta, checkPlan, readBlockers, returnedPending } from './plan-gate.mjs';
import { loadDemands } from './demand-registry.mjs';
import { loadOps, doableOn } from './ops.mjs';
import { loadRounds, repoSnapshot, demandRecords, resolveState, noShotHolders, shotInRound } from './rounds.mjs';
import { reviewItems, isImage, appShotsIn, assertionGaps, nonUiRead } from './evidence-gate.mjs';
import { hostOfCase } from './hosts.mjs';
import { findingProblems, blockerAskProblems } from './finding-quality.mjs';
import { normalizePlatforms, RUNTIME_PLATFORMS } from './platform.mjs';
import { readConfig } from './project.mjs';
import * as C from './cards.mjs';
import * as ANDROID from '../adapters/android/device.mjs';
import { smokeSpec, smokeState, smokeCaseId } from './smoke.mjs';

export const STALL_HOURS = 2;
// 和报告的节点证据闸同口径（engine.mjs isUINode）：只有 UI 载体的节点要过程截图，其余节点认机器证据
const UI_CARRIERS = new Set(['ui', 'app_ui', 'page']);
const DEVICE_PLATFORMS = new Set(['ios', 'android']);
const DONE = new Set(['pass', 'fail', 'na', 'skip']);

const readJSON = f => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

// 文字里引着 owner 的原话：「owner MM-DD：…」「owner YYYY-MM-DD 说：…」「owner 原话：…」（例：「owner 1-2：先跳过这组」）。返回那一小段，没有就 null。
// 只认「owner + 日期/原话 + 冒号」这种引述，单提一句 owner（「归 owner 定」「问 owner」）不算答复
export function ownerQuoteIn(s) {
  const m = String(s || '').match(/owner\s*(?:\d{4}-)?\d{1,2}-\d{1,2}[^：:\n]{0,8}[：:]\s*[^；;\n]{2,80}|owner\s*原话\s*[：:]\s*[^；;\n]{2,80}/i);
  return m ? m[0].trim() : null;
}
function walk(nodes, cb, prefix = 'n') {
  (nodes || []).forEach((n, i) => { const id = `${prefix}${i + 1}`; cb(n, id); if (n.children) walk(n.children, cb, `${id}.`); });
}
function caseOf(root, ref) {
  for (const f of [join(root, ref || ''), join(root, 'cases', `${ref}.case.json`)])
    if (ref && existsSync(f) && f.endsWith('.json')) { const c = readJSON(f); if (c) return c; }
  return null;
}
// 运行目录里最新的修改时刻（result.json、截图、证据）—— 判「多久没动静」
function lastTouched(dir) {
  let t = 0;
  const scan = (d, depth) => {
    let ents = []; try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = join(d, e.name);
      if (e.isDirectory()) { if (depth < 2) scan(p, depth + 1); continue; }
      try { t = Math.max(t, statSync(p).mtimeMs); } catch { /* 刚被删 */ }
    }
  };
  scan(dir, 0);
  return t;
}

// 评审单的默认自检：结构 + 操作库。engine 调用时传 opts.planErrors，带上平台与用例质量检查（那些要加载项目扩展）。
function defaultPlanErrors(root, plan) {
  const ops = loadOps(root), idx = {};
  for (const [k, v] of Object.entries(ops)) idx[k] = { id: k, title: v.title, missing: ['ios', 'android'].filter(pf => !doableOn(v, pf)) };
  const cases = new Set(existsSync(join(root, 'cases')) ? readdirSync(join(root, 'cases')).filter(f => f.endsWith('.case.json')).map(f => f.replace(/\.case\.json$/, '')) : []);
  return checkPlan(plan, idx, cases).errs;
}

// finding 是否在等 owner 拍板 —— 与看板 findingStatus 的「待 owner 定」同口径：
// 已定、执行者已收口、decide 写明执行者自决的，都不算。
const awaitingOwner = f => !f.decided_by && !f.settled && !/^执行者|自决|执行者按/.test(String(f.decide || ''));

// 轮次漂移：与 engine roundCodeDrift 同一判据，但只读 —— 没有轮次文件就当没配被测仓
function roundDrift(root, D) {
  const rf = loadRounds(root, D);
  if (!rf?.repos?.length || !rf.rounds?.length) return null;
  const last = rf.rounds[rf.rounds.length - 1];
  const moved = [];
  for (const repo of rf.repos) {
    const now = repoSnapshot(repo.path); const was = last?.code?.[repo.name];
    if (now.error) continue;
    if (!was || was.commit !== now.commit) moved.push(`${repo.name}: ${was ? String(was.commit).slice(0, 10) : '（上一轮未记）'} → ${now.commit.slice(0, 10)} ${now.subject || ''}`);
  }
  return moved.length ? { last, moved } : null;
}

// 需求的运行：每条用例只看最新一次（同一用例的旧运行已被后来的接上，它们的待办不是现在的事）
function latestRuns(root, D) {
  const dir = join(root, 'runs');
  if (!existsSync(dir)) return [];
  const byCase = new Map();
  for (const d of readdirSync(dir)) {
    const r = readJSON(join(dir, d, 'result.json'));
    if (!r || r.superseded_by) continue;
    if ((r.demand?.id || r.demand) !== D) continue;
    const prev = byCase.get(r.case);
    if (!prev || (r.run_seq || 0) > (prev.r.run_seq || 0)) byCase.set(r.case, { id: d, dir: join(dir, d), r });
  }
  return [...byCase.values()];
}

// 还没测上的断言 → Map<用例, [{id, source, round, why}]>（用例文件不存在时值为 null）。
// 与看板「本轮状态」同一口径（rounds.mjs resolveState：记录按时间归轮、重置、继承；分母是评审单点名的 + 跑过的用例）。
// 只看每条用例的最新运行会漏两种：轮次重置了、最新运行里却已有结论的；评审单点名了、一次没跑过的 ——
// 看板上显示「待测」，执行者 pull 状态时却一张卡片都没有。
function untested(root, D, plan) {
  const dir = join(root, 'runs');
  const all = (existsSync(dir) ? readdirSync(dir) : []).map(d => ({ id: d, dir: join(dir, d), r: readJSON(join(dir, d, 'result.json')) }))
    .filter(x => x.r && (x.r.demand?.id || x.r.demand) === D);
  const out = new Map(), keys = [];
  for (const n of new Set([...planCases(plan), ...all.map(x => x.r.case)])) {
    const c = caseOf(root, n);
    if (!c) { out.set(n, null); continue; }
    walk(c.tree, nd => { for (const e of nd.expect || []) keys.push(`${n}::${e.id}`); });
  }
  const byId = new Map(all.map(x => [x.id, x.r]));
  const recs = demandRecords(all.map(x => ({ id: x.id, dir: x.dir, session: x.r.session })), id => byId.get(id));
  // 没有轮次文件：当作只有一轮，没有重置
  const rf = loadRounds(root, D)?.rounds?.length ? loadRounds(root, D) : { rounds: [{ id: 'R1', opened_at: new Date(0).toISOString() }] };
  const carried = new Map();
  const state = resolveState(rf, rf.rounds.length - 1, recs, keys);
  // 有效截图规则：受规则管（端上平台、不是迁移来的）却一张 app 画面都没有的运行
  const bare = (id, rd) => { const r = byId.get(id); return !!r && RUNTIME_PLATFORMS.includes(r.platform || r.device?.platform) && !r.demand?.migrated && !appShotsIn(join(dir, id)).some(shotInRound(rf, rd)); };
  const noShot = noShotHolders(state, bare);
  for (const [k, v] of state) {
    const i = k.indexOf('::'), n = k.slice(0, i);
    if (v.source === 'inherited') (carried.get(n) || carried.set(n, new Set()).get(n)).add(k.slice(i + 2));
    if (v.status !== 'todo') continue;
    (out.get(n) || out.set(n, []).get(n)).push({ id: k.slice(i + 2), source: v.source, round: v.round || null, why: v.reason || '' });
  }
  return { todo: out, carried, noShot, caseOfRun: id => byId.get(id)?.case };
}

/** 这条用例里结论继承自更早一轮的断言 id —— next（不出 expect_todo）和 report（不当 todo 拦）共用，两边口径必须一致 */
export const carriedExpects = (root, D, caseName) => untested(root, D, null).carried.get(caseName) || new Set();

/** 一个运行里的卡片（device_needed → step_todo → expect_todo → rejected → review_due → report_due）+ 是否停滞。
 *  carried：这条用例里结论继承自更早一轮的断言 id（untested 的 carried） */
function deviceDrift(r) {
  const key = r.device?.key;
  if (!key || !r.device.boot_id || !/^avd:/.test(key)) return null;
  try {
    if (!ANDROID.available()) return null;
    const addr = ANDROID.addressOf(key);
    if (!addr) return { kind: 'gone', why: `${key} 现在没开（停了 / 被关了），之前的地址 ${r.device.address || '?'} 可能已经指向别的设备` };
    const b = ANDROID.bootId(addr);
    if (b && b !== r.device.boot_id) return { kind: 'rebooted', why: `${key} 在占用之后重启过（开机号变了），期间谁动过它不知道` };
  } catch { /* 查不了就不报，动设备时 engine 还会再核 */ }
  return null;
}
function runCards(root, cfg, D, { id, dir, r }, blockers, allBlockers, carried = new Set()) {
  const c = caseOf(root, r.case_ref) || caseOf(root, r.case);
  const out = [];
  const results = r.results || {};
  const exps = [], nodes = [];
  if (c) walk(c.tree, (n, nodeId) => {
    for (const e of n.expect || []) exps.push(e);
    nodes.push({ nodeId, op: n.op, tags: n.tags || {}, shows: n.shows || [], expectIds: (n.expect || []).map(e => e.id) });
  });
  else for (const k of Object.keys(results)) exps.push({ id: k });
  // 被阻塞、而用户已经答复的断言：照答复重测，算待办
  const answered = new Map(blockers.filter(b => b.run === id && b.answer && !b.resolved).map(b => [b.expect, b.answer]));
  // 运行里没记、而结论继承自更早一轮的断言不是待办：开轮时的影响评估已经定了它沿用旧结论，
  // 只有被重置的要重测。局部重跑开出的新运行里其余断言都是空的，不排除的话看板说「通过（继承）」，
  // 执行者这边却是一张 expect_todo（与看板同一份计算：rounds.mjs resolveState）。
  // 同一轮里别的运行记过的不算 —— 同一轮里再开一个运行就是要重测。
  const inherited = x => carried.has(x) && (results[x]?.status || 'todo') === 'todo';
  const todo = exps.filter(e => { const s = results[e.id]?.status || 'todo'; return (s === 'todo' && !inherited(e.id)) || (s === 'blocked' && answered.has(e.id)); });

  const pfs = normalizePlatforms(c || r.platform);
  const platform = r.platform || r.device?.platform || (pfs.length === 1 ? pfs[0] : null);
  const web = platform === 'web';
  const uiNode = tags => cfg.report?.uiSteps === 'all' || UI_CARRIERS.has(String(tags?.carrier ?? ''));
  const steps = r.steps || {};
  // 这一步的断言都走到了不用再截的终态，就不再要过程截图：不适用 / 跳过、记了 fail（被测物坏了，报告照样列缺口）、
  // 判不了且进了阻塞台账（000：「判不了」是正当终点）。只有 pass 和还没结论的才非截不可。
  // 执行者把这一步登记成取证手段的问题（apparatus --where step:nN）也算终态 —— 否则 report_due 永远出不来。
  const logged = x => allBlockers.some(b => b.run === id && b.expect === x);
  const settled = x => { const s = results[x]?.status; return inherited(x) || ['na', 'skip', 'fail'].includes(s) || (s === 'blocked' && logged(x) && !answered.has(x)); };
  const stepGivenUp = new Set((r.apparatus || []).map(a => a.where));
  const stepTodo = nodes.filter(n => {
    if (!uiNode(n.tags)) return false;
    if (n.expectIds.length && n.expectIds.every(settled)) return false;
    if (stepGivenUp.has(`step:${n.nodeId}`)) return false;
    const evs = [...(steps[n.nodeId]?.evidence || []), ...n.expectIds.flatMap(x => results[x]?.evidence || [])];
    return !evs.some(isImage);
  });
  const left = todo.length + stepTodo.length;

  const devicePfs = platform ? [platform] : pfs;
  const attention = [];
  if (left && !r.device && devicePfs.length && devicePfs.every(p => DEVICE_PLATFORMS.has(p))) {
    // 上一次 acquire 的结论还作数（之后白名单没改过）：都不能用 → 等人加设备；启动没成 / 只是在等 → 带上原因再 acquire。
    // 只有 acquire 记了 ask（每台都是配置层面的原因：白名单、能力、宿主、本 run 否决过）才问人；
    // 被别的 run 占着、还没开机这类会自己变的，没有 ask，照旧出 device_needed（000：人的注意力只花在人的判断上）
    const last = (r.device_picks || []).filter(p => p.via === 'acquire').pop();
    const cfgAt = (() => { try { return statSync(join(root, 'acceptkit.project.json')).mtimeMs; } catch { return 0; } })();
    const current = last && Date.parse(last.at) > cfgAt;
    if (current && last.decision === 'create' && last.ask) attention.push(C.deviceAttentionCard(id, last.ask, last.ask_detail || []));
    else out.push(C.deviceNeededCard(id, current && last.decision !== 'reuse' ? last.how || null : null));
  }
  // 占着的设备停了 / 重启过：通知占用它的运行，先核对再往下做（engine liveAddress 同一口径；只核对记过开机号的占用）
  const drift = left && deviceDrift(r);
  if (drift) out.push(C.deviceChangedCard(id, r.device.key, drift));
  for (const n of stepTodo) out.push(C.stepTodoCard(id, n, web));
  for (const e of todo) out.push(C.expectTodoCard(id, e, answered.get(e.id) || null));
  // 记了结论、证据不全：同一份判据（assertionGaps）—— 报告列缺口、看板不算通过、这里让执行者先补齐再送盲审
  //（整轮一张 app 画面都没有的，走下面的 shot_missing 开新运行，不在这里重复报）
  const AG = RUNTIME_PLATFORMS.includes(platform) && !r.demand?.migrated && !appShotsIn(dir).length ? {} : assertionGaps(dir, r, { expects: exps, ops: loadOps(root) });
  const gapIds = exps.map(e => e.id).filter(x => AG[x]);
  if (gapIds.length) {
    // 缺截图的断言若读法本身不是界面通道，重跑 observe 也补不上：卡片要指出该换配方，而不是让执行者空转
    const ops = loadOps(root), nonUi = {};
    for (const e of exps) if (AG[e.id]?.includes('no_ui_shot') && platform) { const x = nonUiRead(e, platform, ops, hostOfCase(c, platform)); if (x) nonUi[e.id] = x; }
    out.push(C.evidenceGapCard(id, gapIds, AG, nonUi));
  }
  const items = reviewItems(r, { any: true, dir });
  const rejected = items.filter(i => i.rv.state !== 'pending' && i.rv.state !== 'ok');
  const pending = items.filter(i => i.rv.state === 'pending');
  for (const it of rejected) out.push(C.rejectedCard(id, it));
  if (pending.length) out.push(C.reviewDueCard(id, pending));
  // 报告拒出的两种阻塞情形，这里同口径挡住 report_due：登记了没提的、记了 blocked 却没登记的
  const unreported = blockers.some(b => b.run === id && !b.reported && !b.resolved);
  const unlogged = exps.filter(e => results[e.id]?.status === 'blocked' && !allBlockers.some(b => b.run === id && b.expect === e.id)).map(e => e.id);
  if (unlogged.length) out.push(C.blockerBackfillCard(D, id, unlogged));
  // 有效截图规则的旧账：规则加上之前记的结论，这个运行里一张 app 画面都没有。事后补截的图证明不了当时，所以要开新运行重测
  //（规则定下之前迁移进来的运行不追溯，与 record / report 的 legacyRun 同口径）
  const concluded = exps.filter(e => ['pass', 'fail'].includes(results[e.id]?.status)).length;
  const noShot = concluded && RUNTIME_PLATFORMS.includes(platform) && !r.demand?.migrated && !appShotsIn(dir).length;
  if (!noShot && !gapIds.length && !left && !rejected.length && !pending.length && !unreported && !unlogged.length) {
    // 报告写完后 run.md 比 result.json 新；之后又有记录改动，就要重出
    const md = join(dir, 'run.md'), res = join(dir, 'result.json');
    const fresh = existsSync(md) && statSync(md).mtimeMs >= statSync(res).mtimeMs;
    if (!fresh) out.push(C.reportDueCard(id));
  }
  const idleH = (Date.now() - lastTouched(dir)) / 3600e3;
  return { cards: out, attention, stalled: left && idleH >= STALL_HOURS ? Math.floor(idleH) : 0 };
}

/**
 * nextCards(root, demand, opts) → 卡片数组（空 = 这个需求没有剩下的事）。
 * opts.planErrors(plan) → string[]：评审单硬错（engine 传入完整的自检；不传用结构 + 操作库检查）。
 * 需求不存在（既没登记也没有评审单）→ 抛错，消息是一句能照着改的话。
 */
export function nextCards(root, D, opts = {}) {
  const plan = loadPlan(root, D);
  if (!plan && !loadDemands(root).has(D)) {
    const known = [...loadDemands(root).keys()];
    throw new Error(`没有需求 ${D}：先 acceptkit plan new ${D} --title "…"${known.length ? `（现有：${known.slice(0, 12).join(' ')}）` : ''}`);
  }
  if (!plan) return [C.planMissingCard(D)];
  const cfg = (() => { try { return readConfig(root); } catch { return {}; } })();
  const attention = [], draft = [], own = [], rest = [], stalled = [];

  const errs = opts.planErrors ? opts.planErrors(plan) : defaultPlanErrors(root, plan);
  const approved = approvedCases(plan);
  if (errs.length) draft.push(C.planDraftCard(D, plan, errs));
  // owner 退回了：轮到执行者照意见改；改动面一变就回到等 owner 批（returnedPending）
  else if (returnedPending(plan)) draft.push(C.planReturnedCard(D, plan));
  else if (!plan.approved_at) {
    // 评审时让 owner 看到：这次要批的用例里几条在界面上验、几条用命令行验（各自为什么界面上看不到）
    const delta = planDelta(plan);
    const scope = approved.size ? delta.added : [...planCases(plan)];
    const via = { ui: 0, cli: [] };
    for (const name of scope) { const c = caseOf(root, name); if (c) walk(c.tree, n => { for (const e of n.expect || []) { if ((e.via || 'ui') === 'ui') via.ui++; else via.cli.push({ case: name, id: e.id, via: e.via, why: e.why_not_ui || '' }); } }); }
    attention.push(C.planApprovalCard(D, plan, delta, approved.size, via));
  }

  // 写得 owner 定不了的不算「等你定」，是执行者的待办（与看板同口径）
  for (const f of (plan.findings || []).filter(awaitingOwner)) {
    const bad = findingProblems(f);
    if (bad.length) own.push(C.findingUnclearCard(D, f, bad)); else attention.push(C.findingCard(D, f));
  }

  const runs0 = latestRuns(root, D);
  // 挂错需求的运行：用例不在本需求的评审单里、不是调查型、出处也不是本需求（典型：--skip-plan-gate 开在了别的需求名下）。
  // 它的卡片不是本需求的活：只出一张「改挂」卡，不派重跑（本需求下也开不了跑）。不改挂这张卡就一直在，问题藏不掉。
  const planned = planCases(plan);
  const misfiled = new Set(runs0.filter(x => { const c = caseOf(root, x.r.case_ref || x.r.case);
    return c && !planned.has(x.r.case) && !['probe', 'smoke'].includes(c.kind || 'acceptance') && c.origin?.id !== D; }).map(x => x.id));
  const misCase = new Set(runs0.filter(x => misfiled.has(x.id)).map(x => x.r.case));
  for (const x of runs0.filter(y => misfiled.has(y.id))) own.push(C.runMisfiledCard(D, x.id, x.r.case, caseOf(root, x.r.case_ref || x.r.case)?.origin?.id || null));
  const runs = runs0.filter(x => !misfiled.has(x.id));
  const statusNow = new Map(runs.map(x => [x.r.case, x.r]));
  // 阻塞项按它所在运行里那条断言现在的状态分流：还是 blocked 才可能要问人
  const allBlockers = readBlockers(root, D);
  const blockers = allBlockers.filter(b => !b.resolved);
  // 只有自己的能力缺口（capability，且解锁条件没指向一条 finding）不用问人：与 blockers --raise 的分栏同口径
  const ownCap = b => b.kind === 'capability' && !/finding\s*\*{0,2}F\d+/i.test(b.unlock || '');
  const unaskedSeen = new Set();
  const askedGroups = new Map();
  for (const b of blockers) {
    if (misCase.has(b.case)) continue;   // 挂错需求的运行上的阻塞随「改挂」卡走
    const newer = statusNow.get(b.case);
    if (newer && newer.run !== b.run) continue;   // 这条用例已经重跑：以新运行里的阻塞为准，旧运行不再出报告
    const st = readJSON(join(root, 'runs', b.run, 'result.json'))?.results?.[b.expect]?.status || 'blocked';
    if (st !== 'blocked') {
      // 后来有了结论：没提过的要关掉（否则 report 拒出）；已提过的不再打扰人
      if (!b.reported && st !== 'todo') own.push(C.blockerStaleCard(D, b, st));
      continue;
    }
    if (b.answer) continue;                                  // 已答复：落到断言卡片上照答复重测
    if (ownCap(b)) { if (!b.reported) own.push(C.blockerOwnCard(D, b)); continue; }
    // 要 owner 答的，先得写成他能拍板的问题（问句 / 为什么问你 / 选项 + 后果 / 推荐）；没写成的是执行者的活。
    // 同一个解锁条件下的几条只出一张（一个问题常卡住十几条断言）
    if (blockerAskProblems(b).length) {
      const key = `${b.case}|${b.unlock || b.text}`;
      if (!unaskedSeen.has(key)) { unaskedSeen.add(key); own.push(C.blockerUnaskedCard(D, b, allBlockers.filter(x => !x.resolved && x.case === b.case && (x.unlock || x.text) === (b.unlock || b.text)).map(x => x.id))); }
      continue;
    }
    // 同一条用例、同一个问题卡住的几条只出一张卡，答一次覆盖整组（以前一条阻塞一张卡：7 条用例 52 张，同一句话要答 52 遍）
    const q = `${b.case}|${b.ask?.question || b.unlock || b.text}`;
    if (!askedGroups.has(q)) askedGroups.set(q, []);
    askedGroups.get(q).push(b);
  }
  for (const g of askedGroups.values()) {
    // 说明里已经引着 owner 的原话（执行者把答复写进了 unlock / text，而不是 --ack）：不再问他，转成执行者补记
    const quoted = g.map(x => ownerQuoteIn(`${x.unlock || ''}\n${x.text || ''}`)).find(Boolean);
    if (quoted) own.push(C.blockerQuotedAnswerCard(D, g[0], g.map(x => x.id), quoted));
    else attention.push(C.blockerCard(D, g[0], g.map(x => x.id)));
  }

  const drift = roundDrift(root, D);
  if (drift) rest.push(C.roundStaleCard(D, drift.last, drift.moved));

  // 运行按评审单里的用例顺序，评审单外的（调查型）排后面
  const order = [...planCases(plan)];
  const { todo: untestedBy, carried, noShot, caseOfRun } = untested(root, D, plan);
  runs.sort((a, b) => ((order.indexOf(a.r.case) + 1) || 1e9) - ((order.indexOf(b.r.case) + 1) || 1e9) || a.id.localeCompare(b.id));
  for (const x of runs) {
    const rc = runCards(root, cfg, D, x, blockers, allBlockers, carried.get(x.r.case));
    attention.push(...rc.attention);
    rest.push(...rc.cards);
    if (rc.stalled) stalled.push(C.stalledCard(x.id, rc.stalled));
  }
  // 结论还靠没截图的运行撑着：按当前状态出（与看板红条同一份 noShotHolders），被后来的运行覆盖了的不出
  for (const [run, ks] of noShot) if (!misfiled.has(run)) rest.push(C.shotMissingCard(D, run, caseOfRun(run), ks.map(k => k.slice(k.indexOf('::') + 2))));

  // 还没测上、最新运行里也不开着的断言（开着的上面已出 expect_todo / 阻塞卡片）：要开新运行。先把已开的跑完，再开新的。
  // 没批的用例开不了（调查型除外），挂到批准 / 草稿卡片上 —— 问的人要知道批了才能接着测哪些。
  // 按用例判：评审单修订后只有新加的那几条没批，已批过的照常出 run_needed（与 gateRun 同口径）。
  const surfaceOf = name => (plan.surfaces || []).find(s => [...(s.reuse || []), ...(s.new || [])].includes(name))?.id;
  const inPlan = new Set(order);
  const held = [];
  for (const [name, es] of untestedBy) {
    if (misCase.has(name)) continue;   // 挂错需求的用例：本需求下开不了跑，由「改挂」卡处理
    const cur = statusNow.get(name);
    const left = es && es.filter(e => DONE.has(cur?.results?.[e.id]?.status || 'todo') || !cur);
    if (es && !left.length) continue;
    const probe = (caseOf(root, name)?.kind || 'acceptance') === 'probe';
    const card = C.runNeededCard(D, name, !!es, surfaceOf(name), left || [], !!cur);
    if (probe || approved.has(name) || (plan.approved_at && !inPlan.has(name))) rest.push(card); else held.push(card);
  }
  const gate = held.length && [...attention, ...draft].find(c => c.subject === 'plan_approval' || c.kind === 'plan_draft');
  if (gate) Object.assign(gate, C.heldByPlan(gate, held));
  // 冒烟闸：项目声明了冒烟项、评审单批过了，这一轮的冒烟没过就不派用例运行（run_needed 收进冒烟卡片里，看得见被挡了什么）
  if (plan.approved_at) {
    const curRound = loadRounds(root, D)?.rounds?.at(-1)?.id;
    for (const p of normalizePlatforms(plan).filter(x => DEVICE_PLATFORMS.has(x))) {
      const spec = smokeSpec(cfg, p); if (!spec) continue;
      if (Array.isArray(spec.demands) && !spec.demands.includes(D)) continue;   // 试用：只闸列出的需求，别的需求照旧
      const sr = runs.filter(x => x.r.case === smokeCaseId(p) && (!curRound || x.r.round === curRound));
      const st = smokeState(sr, spec);
      if (st.state === 'pass') continue;
      const blocked = rest.filter(c => c.kind === 'run_needed');
      for (const c of blocked) rest.splice(rest.indexOf(c), 1);
      const card = st.state === 'none' ? C.smokeNeededCard(D, p, curRound)
        : st.state === 'fail' ? C.smokeFailedCard(D, p, st)
        : !st.env.done && sr.at(-1).r.device ? C.smokeEnvCard(st.run, p) : null;
      if (card) rest.unshift(Object.assign(card, blocked.length ? { held: blocked.map(c => ({ case: c.case, expects: c.expects || [] })), detail: [...(card.detail || []), `冒烟过了才开跑：${blocked.length} 条用例（${blocked.map(c => c.case).slice(0, 6).join('、')}${blocked.length > 6 ? ' 等' : ''}）`] } : {}));
    }
  }
  return [...attention, ...draft, ...own, ...rest, ...stalled];
}

// ── 每条用例走到哪一步 ──────────────────────────────────────────────
// 一个需求里的用例各走各的：评审单中途加了一条，只有那一条回到「评审」，其余的照常往下走。
// 所以阶段按用例算，整轮只是这些阶段的分布。阶段不另存，从 next 的卡片推出 ——
// 看板和执行者看到的是同一份计算：看板说某条用例在「盲审」，执行者那边就有它的 review_due。
export const STAGES = [
  // 出报告不是一个阶段：工具在最后一条结论 / 复核落下时自动出（engine autoReport）。还没出的（规则之前留下的）算完成，卡片照旧提醒执行者
  ['review', '用例评审'], ['exec', '执行'], ['blind', '盲审'], ['done', '完成'],
];
const STAGE_OF_KIND = { run_needed: 'exec', smoke_env: 'exec', device_changed: 'exec', device_needed: 'exec', step_todo: 'exec', expect_todo: 'exec', rejected: 'exec',
  blocker_own: 'exec', blocker_unasked: 'exec', stalled: 'exec', shot_missing: 'exec', run_misfiled: 'exec', evidence_gap: 'exec', review_due: 'blind', report_due: 'done' };
/** caseStages(root, cards) → Map<用例, {stage, ask}>：用例最靠前的那张卡片定它在哪一步；没有卡片的不在表里（= 完成）。
 *  ask：这条用例上已经问了、等人回答的事（阻塞答复、设备放行）。需求级的卡片（finding、round_stale）不属于哪条用例，不在这里。 */
export function caseStages(root, cards) {
  const caseOfRun = new Map();
  const caseFor = c => {
    if (c.case) return c.case;
    if (!c.run) return null;
    if (!caseOfRun.has(c.run)) caseOfRun.set(c.run, readJSON(join(root, 'runs', c.run, 'result.json'))?.case || null);
    return caseOfRun.get(c.run);
  };
  const rank = s => STAGES.findIndex(([k]) => k === s);
  const out = new Map();
  const put = (name, stage, ask = 0) => {
    if (!name) return;
    const cur = out.get(name) || { stage, ask: 0 };
    if (rank(stage) < rank(cur.stage)) cur.stage = stage;
    cur.ask += ask;
    out.set(name, cur);
  };
  for (const c of cards) {
    for (const h of c.held || []) put(h.case, /^smoke_/.test(c.kind) ? 'exec' : 'review');   // 被冒烟挡住的已过评审，停在执行前
    // 还没提给用户的阻塞（没有 question）是执行者要先提的，不算「等你答复」
    if (c.kind === 'attention' && (c.subject === 'blocker' || c.subject === 'device')) put(caseFor(c), 'exec', c.question ? 1 : 0);
    else if (STAGE_OF_KIND[c.kind]) put(caseFor(c), STAGE_OF_KIND[c.kind]);
  }
  return out;
}
