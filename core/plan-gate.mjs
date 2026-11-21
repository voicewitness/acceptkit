// plan-gate — 把「用例评审 → 执行 → 报告」这条流水线变成闸，而不是文档里的一段话。
//
// 为什么要有这个文件（三个常见症状，根因同一个）：
//   ① 一个需求的 N 条执行记录里用例各不一样  —— 因为从没有「用例评审」这一步，每轮现攒 case
//   ② 经常临时补报告                        —— 因为阻塞只落在 run 文件里，最后才汇总
//   ③ 有些操作老要人主动提醒                —— 因为没人在评审时检查「这条用例要用的操作存不存在」
// 经验：「规则写在文档里而没有对应的检查 = 迟早会被绕过」。
// 所以这里的每一条都必须是 CLI 里**拒绝往下走**的检查。
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, appendFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';

export const planPath   = (SKILL, d) => join(SKILL, 'state', 'plans', `${d}.json`);
export const blockerPath = (SKILL, d) => join(SKILL, 'state', 'blockers', `${d}.jsonl`);

export function loadPlan(SKILL, demand) {
  const p = planPath(SKILL, demand);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}
export function savePlan(SKILL, plan) {
  const p = planPath(SKILL, plan.demand);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(plan, null, 1));
  return p;
}

/** plan 里被点名的全部用例（引用存量 + 本轮新建） */
export function planCases(plan) {
  const out = new Set();
  for (const s of plan?.surfaces || []) { for (const x of [...(s.reuse || []), ...(s.new || [])]) out.add(x); }
  return out;
}
/** 用例内容指纹 —— 「用例不稳定」不只是换了哪几条用例，还包括**同一条用例的断言被悄悄改了**。
 *  批准时钉住每条用例的内容 hash，之后改了就在 run / plan check / 看板上**显形**。
 *
 *  **显形 ≠ 拦路**。
 *     评审的单位是「这条需求 ref 了哪些用例 id」——用例是有唯一 id 的资产，需求引用它的 id，
 *     **一个需求的用例只评审一次**。改一个测试取值就清空批准、要人重批，是把
 *     「资产内容修订」错当成了「需求范围变更」。
 *     ⇒ 指纹漂移只用来**在看板与 run 报告上显形**（谁、什么时候、为什么改的），不再拦 run、
 *       也不再清空 approved_at。真正需要重新评审的是**用例集合变了**（加/减用例 id），那条闸留着。
 */
export function caseFingerprints(CASES, plan, names = planCases(plan)) {
  const out = {};
  for (const name of names) {
    const f = `${CASES}/${name}.case.json`;
    try { out[name] = createHash('sha256').update(readFileSync(f)).digest('hex').slice(0, 12); }
    catch { out[name] = null; }
  }
  return out;
}
export function driftedCases(CASES, plan) {
  if (!plan?.fingerprints) return [];
  const now = caseFingerprints(CASES, plan, Object.keys(plan.fingerprints));
  return Object.entries(plan.fingerprints).filter(([k, v]) => v && now[k] && now[k] !== v).map(([k]) => k);
}

// ---- 用例改动分级：哪些改动事后通知 owner，哪些要 owner 认 ----
// 执行中用例常要自己补（换到读得到那一层的观测、加判内容的判据）。每次都等 owner 批，验收就卡在等人；
// 一律不问，又会有人悄悄删判据、改断言原文把结论改窄。所以按改动的性质分两档：
//   notify = 只会让用例更严或只换了取证办法（加断言、加判据、加前提、换观测用的操作、改操作步骤和说明文字）：照常跑，事后通知 owner
//   ack    = 会改结论或范围（删断言、改断言原文、删或改判据 / 前提、改适用范围、声明某个词不算效果、改成人判、只判有没有的说明、删平台）：owner 认了才跑
// 底稿：批准 / 重钉时把用例内容存一份（state/plans/<需求>.snap/<用例>.json），之后拿现在的跟它比。没留底稿的（这个机制之前批的）分不出改了什么，按原来的规矩只显形。
export const snapDir = (SKILL, d) => join(SKILL, 'state', 'plans', `${d}.snap`);
export function saveSnapshots(SKILL, CASES, plan, names) {
  const dir = snapDir(SKILL, plan.demand); mkdirSync(dir, { recursive: true });
  for (const n of names) { try { writeFileSync(join(dir, `${n}.json`), readFileSync(`${CASES}/${n}.case.json`)); } catch {} }
}
const loadSnap = (SKILL, d, n) => { try { return JSON.parse(readFileSync(join(snapDir(SKILL, d), `${n}.json`), 'utf8')); } catch { return null; } };

const expectsOf = c => { const out = new Map(); const walk = ns => { for (const n of ns || []) { for (const e of n.expect || []) out.set(e.id, e); walk(n.children); } }; walk(c?.tree); return out; };
const stepsOf = c => { const out = []; const walk = ns => { for (const n of ns || []) { out.push(n.op || ''); walk(n.children); } }; walk(c?.tree); return out; };
const J = x => JSON.stringify(x ?? null);
// 一份读法（observe 或 observe.by 的某一端）里的判据 / 前提，按 pick 比
const bindings = o => !o ? {} : o.by ? Object.fromEntries(Object.entries(o.by).map(([k, v]) => [k, v])) : { '': o };
const ACK_KEYS = { applies: '适用范围', claims_off: '声明某个词不算效果', judge: '判定方式（机判 / 人判）', why_presence_only: '「只测有没有」的说明', quality_waive: '豁免的检查' };

/** before / after 两份用例 → { tier: 'notify'|'ack'|'same', changes: [{ tier, what }] } */
export function classifyCaseEdit(before, after) {
  const ch = [], add = (tier, what) => ch.push({ tier, what });
  const B = expectsOf(before), A = expectsOf(after);
  for (const id of B.keys()) if (!A.has(id)) add('ack', `删了断言 ${id}`);
  for (const id of A.keys()) if (!B.has(id)) add('notify', `加了断言 ${id}`);
  for (const [id, a] of A) {
    const b = B.get(id); if (!b) continue;
    if (String(a.assert || '') !== String(b.assert || '')) add('ack', `${id} 的断言原文改了`);
    for (const [k, label] of Object.entries(ACK_KEYS)) if (J(a[k]) !== J(b[k])) add('ack', `${id} 的${label}改了`);
    const ob = bindings(b.observe), oa = bindings(a.observe);
    for (const side of new Set([...Object.keys(ob), ...Object.keys(oa)])) {
      const x = ob[side], y = oa[side], at = side ? `${id}（${side}）` : id;
      if (x && !y) { add('ack', `${at} 的读法删了`); continue; }
      if (!x && y) { add('notify', `${at} 加了读法`); continue; }
      if ((x.op || null) !== (y.op || null)) add('notify', `${at} 观测换成了操作 ${y.op}`);
      for (const kind of ['checks', 'guards']) {
        const label = kind === 'checks' ? '判据' : '前提';
        const bx = new Map((x[kind] || []).map(c => [c.pick + J(c.predicate), c])), ay = new Map((y[kind] || []).map(c => [c.pick + J(c.predicate), c]));
        const gone = [...bx.keys()].filter(k => !ay.has(k)), added = [...ay.keys()].filter(k => !bx.has(k));
        if (gone.length) add('ack', `${at} 删了或改了 ${gone.length} 条${label}（${gone.map(k => bx.get(k).pick).join('、')}）`);
        if (added.length && !gone.length) add('notify', `${at} 加了 ${added.length} 条${label}`);
      }
    }
  }
  const pb = [].concat(before?.platform || before?.platforms || []), pa = new Set([].concat(after?.platform || after?.platforms || []));
  const lost = pb.filter(x => !pa.has(x)); if (lost.length) add('ack', `去掉了平台 ${lost.join('、')}`);
  if (J(stepsOf(before)) !== J(stepsOf(after))) add('notify', '操作步骤改了');
  if (!ch.length && J(before) !== J(after)) add('notify', '说明文字改了');
  return { tier: ch.some(x => x.tier === 'ack') ? 'ack' : ch.length ? 'notify' : 'same', changes: ch };
}

/** 批准后改过的用例逐条分级 → [{ case, tier: 'notify'|'ack'|'unknown', changes }]。unknown = 没留底稿 */
export function caseEdits(SKILL, CASES, plan) {
  return driftedCases(CASES, plan).map(name => {
    const before = loadSnap(SKILL, plan.demand, name);
    if (!before) return { case: name, tier: 'unknown', changes: [] };
    let after = null; try { after = JSON.parse(readFileSync(`${CASES}/${name}.case.json`, 'utf8')); } catch {}
    return { case: name, ...classifyCaseEdit(before, after || {}) };
  });
}

/** Owner 批准过、现在还在评审单里的用例。
 *  评审单修订（加了用例）会清空批准状态，但上次批过的用例照常跑 —— 只有新加的那几条等批准。
 *  「批过哪些」就是批准时钉了指纹的那些（plan.fingerprints 的键：approve 按全单写，recheck 只重钉不扩）。
 *  这一版已批准 ⇒ 全部；没钉过指纹的单子没批过 ⇒ 空。 */
export function approvedCases(plan) {
  const all = planCases(plan);
  if (plan?.approved_at) return all;
  return new Set(Object.keys(plan?.fingerprints || {}).filter(x => all.has(x)));
}
/** 这一版相对上次批准：加了哪些用例（只有它们等批准）、摘了哪些（批准时一并交代给 Owner） */
/** 评审单「要测什么」的指纹（改动面 + 各自引用的用例）。owner 退回时记下，之后它变了 = 执行者照意见改过了 */
export const scopeFingerprint = plan => createHash('sha1').update(JSON.stringify((plan?.surfaces || []).map(s => [s.id, s.change, s.reuse || [], s.new || []]))).digest('hex').slice(0, 12);
/** owner 退回了这一版、执行者还没照意见改 */
export const returnedPending = plan => !!(plan?.returned && !plan.approved_at && plan.returned.scope === scopeFingerprint(plan));
export function planDelta(plan) {
  const all = planCases(plan), ok = approvedCases(plan);
  return { added: [...all].filter(x => !ok.has(x)),
           removed: plan?.approved_at ? [] : Object.keys(plan?.fingerprints || {}).filter(x => !all.has(x)) };
}

/** plan 里被点名的全部 op_id */
export function planOps(plan) {
  const out = new Set();
  for (const s of plan?.surfaces || []) for (const x of (s.ops || [])) out.add(x);
  return out;
}

/**
 * 闸 1：没评审过的需求不许开跑。
 * 返回 null = 放行；返回字符串 = 拒绝理由（调用方 die 掉）。
 */
export function gateRun(SKILL, c, CASES_DIR, demandId = null) {
  // 需求不在用例文件里：这次 run 为哪条需求跑，由调用方（run --demand / 评审单反查）给出。
  const demand = demandId || c?.origin?.id || c?.demand?.id;
  if (!demand) return `这次 run 不知道为哪条需求跑：acceptkit run <case> --demand <D-id>（或先把用例加进某条需求的评审单）`;
  const plan = loadPlan(SKILL, demand);
  if (!plan) return `需求 ${demand} 还没做用例评审，不许开跑。\n`
    + `   写用例期要上机取证：acceptkit probe <slug> --demand ${demand} --platform <ios|android> --host <宿主>\n`
    + `   先出评审单：acceptkit plan new ${demand}\n`
    + `   自检：      acceptkit plan check ${demand}\n`
    + `   评审通过后：acceptkit plan approve ${demand} --by <谁批的> --quote "<批准人的原话>"`;
  const approved = approvedCases(plan);
  if (!approved.size) return `需求 ${demand} 的用例评审单还没批（plan v${plan.revision}），不许开跑。\n`
    + `   写用例期要上机（核 api id、试观测读法 observe --try）：走调查运行，不用借别的需求的运行：\n`
    + `     acceptkit probe <slug> --demand ${demand} --platform <ios|android> --host <宿主>，再 device acquire --run <它建的运行>\n`
    + `   看单子：acceptkit plan show ${demand}\n`
    + `   批准：  acceptkit plan approve ${demand} --by <谁批的> --quote "<批准人的原话>"`;
  // 内容漂移**不拦路**：它只在看板/报告上显形。
  // 拦路的只有「这条用例根本不在需求 ref 的用例 id 集合里」——那才是需求范围变了。
  if (!planCases(plan).has(c.case)) return `用例 ${c.case} 不在需求 ${demand} 已批准的评审单里（plan v${plan.revision}）。\n`
    + `   ⛔ 这正是「同一个需求 N 条记录用例都不一样」的来源：用例集合必须在评审时定死。\n`
    + `   要加它，走评审单修订（会递增 revision，看板上就能分清「需求变更」与「用例漂移」）：\n`
    + `   acceptkit plan add-case ${demand} --surface <S-id> --case ${c.case} --why "<为什么现在才加>"`;
  // 批准后改了会影响结论 / 范围的内容（删判据、改断言原文……）：owner 认了才跑。只加判据、换观测这类照常跑，事后通知
  { const ed = caseEdits(SKILL, CASES_DIR, plan).find(x => x.case === c.case && x.tier === 'ack');
    if (ed) return `用例 ${c.case} 批准后改了会影响结论的内容，owner 认了才能跑：${ed.changes.filter(x => x.tier === 'ack').map(x => x.what).join('；')}\n`
      + `   看改了什么：acceptkit plan show ${demand}\n`
      + `   owner 认了：acceptkit plan recheck ${demand} --case ${c.case} --by <他> --quote "<原话>" --why "<为什么改>"\n`
      + `   不想等：把这几处改回去（只加不删的改动事后通知就行）`; }
  // 评审单修订时新加的用例：只有它等批准，同一张单子上已批过的照常跑
  if (!approved.has(c.case)) return `用例 ${c.case} 是评审单 v${plan.revision} 新加的，Owner 还没批，不许开跑（本单其余 ${approved.size} 条已批过的照常跑）。\n`
    + `   看这次改了什么：acceptkit plan show ${demand}\n`
    + `   批准：          acceptkit plan approve ${demand} --by <谁批的> --quote "<批准人的原话>"`;
  return null;
}

/** 闸 2：评审时校验操作集。ops = acceptkit 的操作库（id → {id, platforms:{ios,android}}） */
// 规则：用例评审单只回答「用例够不够」，不回答「我测到哪了」。
// 这些词一旦出现在评审单里，说明执行状态又混进了用例设计 —— 这是反复出现的病。
const EXEC_STATE_WORDS = ['待测', '未跑', '没跑', '跑不了', '未执行', '待补', '待跑', 'TODO', 'blocked', '阻塞中'];

export function checkPlan(plan, opsIndex, knownCases) {
  const errs = [], warns = [];
  if (!plan.surfaces?.length) errs.push('评审单里一条改动面都没有 —— 评审的对象就是改动面');
  for (const s of plan.surfaces || []) {
    if (!s.change) errs.push(`${s.id}: 缺 change（这条改动面是什么）`);
    if (!s.risk) warns.push(`${s.id} 缺「坏了会怎样」—— 评审人据此判断该在哪几行多花时间`);
    if (!s.uncovered) warns.push(`${s.id} 缺「没覆盖什么」—— 只说覆盖了什么，评审人判不出够不够`);
    // 规则：范围由改动决定，不由执行者的能力决定。改动了就必须有用例，**没有第三个选项**。
    if (!(s.reuse || []).length && !(s.new || []).length)
      errs.push(`${s.id}「${(s.change || '').slice(0, 24)}」没有任何用例覆盖。\n`
        + `     ⛔ 改动了就要测 —— 要么引用存量（--reuse），要么新建（--new）。没有「不覆盖」这条路。\n`
        + `     测不上是**执行阻塞**（record blocked + blockers --raise），不是范围决策。`);
    // 执行状态不许出现在评审单里
    for (const [k, v] of Object.entries(s)) {
      if (typeof v !== 'string') continue;
      const hit = EXEC_STATE_WORDS.filter(w => v.includes(w));
      if (hit.length) errs.push(`${s.id} 的「${k}」里出现执行状态字样：${hit.join(' ')}\n`
        + `     ⛔ 评审单只讲「用例够不够」，不讲「我测到哪了」。\n`
        + `     「还没跑」属于 run 与阻塞台账，把它写进评审单会让评审人误以为覆盖不足。`);
    }
    for (const cs of [...(s.reuse || []), ...(s.new || [])])
      if (knownCases && !knownCases.has(cs)) warns.push(`${s.id}: 用例 ${cs} 现在还不存在（新建的话开跑前要先 acceptkit new）`);
    for (const op of (s.ops || [])) {
      const o = opsIndex?.[op];
      if (!o) errs.push(`${s.id}: 操作 ${op} 不在操作库里 —— 评审阶段就要把它试跑确认并补进 ops，不能等执行期卡住`);
      else {
        // 只对**本需求所在平台**报缺实现：iOS 的需求不需要关心某操作 Android 侧没实现，
        // 否则每条改动面都会刷一条无关告警，真正的告警被淹掉（实际试跑时噪音会成片出现）。
        const miss = (o.missing || []).filter(x => !plan.platform || x === plan.platform);
        if (miss.length) warns.push(`${s.id}: 操作 ${op} 在 ${miss.join('/')} 侧标着「缺实现」`);
      }
    }
  }
  // not_covered 已整体废弃（范围由改动决定，没有「不覆盖」）—— 残留的要报出来让人清掉
  if ((plan.not_covered || []).length)
    errs.push(`评审单里还留着 ${plan.not_covered.length} 条 not_covered（「决定不覆盖」的旧语义，已废弃）。\n`
      + `     ⛔ 改动了就要测。逐条处理：真缺用例 → acceptkit new 建 case 并 plan add-case；\n`
      + `        只是还没跑 → 那是执行阻塞，进阻塞台账（acceptkit blockers），不进评审单。`);
  return { errs, warns };
}

// ── 闸 3：阻塞当场登记 ──────────────────────────────────────────────
export function raiseBlocker(SKILL, { demand, run, caseName, expect, kind, text, unlock }) {
  if (!demand) return null;
  const p = blockerPath(SKILL, demand);
  mkdirSync(dirname(p), { recursive: true });
  const all = readBlockers(SKILL, demand);
  const existing = all.find(b => b.run === run && b.expect === expect);
  if (existing && !existing.resolved) return existing;   // 同一条断言重复 record 不重复登记
  if (existing && existing.resolved) {
    // 已解掉的又被记成 blocked（例如断言从 fail 改回 blocked，旧条目是 resolved；
    // 若直接 return 旧条目 ⇒ 新阻塞在台账里隐形、report 的未提闸也看不见）。重开它，保留历史。
    (existing.history ||= []).push({ at: new Date().toISOString(), note: '重开：断言再次记为 blocked',
      prev: { resolved_how: existing.resolved_how || null, answer: existing.answer || null, unlock: existing.unlock || '' } });
    Object.assign(existing, { resolved: false, resolved_how: null, resolved_by: null, resolved_at: null, kind, text: text || existing.text || '',
      unlock: unlock || existing.unlock || '', reported: false, raised_at: null, answer: null, answered_at: null,
      reopened_at: new Date().toISOString() });
    writeBlockers(SKILL, demand, all);
    return existing;
  }
  // 编号与写入都在锁里做：两个进程同时 raise 不会撞号，也不会互相盖掉
  return withLock(p, () => {
    const disk = readRows(p);
    const again = disk.find(b => b.run === run && b.expect === expect && !b.resolved);
    if (again) return again;
    const maxN = disk.reduce((m, b) => Math.max(m, Number(String(b.id).slice(1)) || 0), 0);
    const rec = { id: `B${maxN + 1}`, at: new Date().toISOString(), demand, run, case: caseName,
                  expect, kind, text: text || '', unlock: unlock || '', reported: false,
                  raised_at: null, answer: null, answered_at: null };
    const prior = priorAnswer(disk, caseName, expect, kind, text || '');
    if (prior) Object.assign(rec, { reported: true, raised_at: prior.raised_at || rec.at, answer: prior.answer,
      answered_at: prior.answered_at, answered_by: prior.answered_by, answer_inherited_from: prior.id, ...(prior.ask ? { ask: prior.ask } : {}) });
    disk.push(rec);
    atomicWrite(p, disk.map(x => JSON.stringify(x)).join('\n') + '\n');
    _seen.set(p, new Map(disk.map(r => [r.id, JSON.stringify(r)])));
    return rec;
  });
}
// 断言后来有了结论（pass / fail / na），卡它的阻塞就不在了：由工具关掉，写清是哪个运行的哪条结论关的。
// 不关的话台账里挂着已经不存在的阻塞：report 拒出、看板和 next 还拿它去问人。
// earlier(run) 判断同一用例的另一个运行是不是更早的那次（更早运行上的阻塞也被这条新结论解掉了）。
export const CLOSING_STATUSES = ['pass', 'fail', 'na'];
export function closeBlockersFor(SKILL, { demand, run, caseName, expect, status, earlier = () => false }) {
  if (!demand || !CLOSING_STATUSES.includes(status)) return [];
  const all = readBlockers(SKILL, demand);
  const hit = all.filter(b => !b.resolved && b.expect === expect
    && (b.run === run || (b.case === caseName && earlier(b.run))));
  if (!hit.length) return [];
  const at = new Date().toISOString();
  for (const b of hit) Object.assign(b, { resolved: true, resolved_by: 'tool', resolved_at: at,
    resolved_how: `工具关闭：运行 ${run} 的 ${expect} 记成了 ${status}` });
  writeBlockers(SKILL, demand, all);
  return hit;
}
// ── 台账并发写 ───────────────────────────────────────────────────────
// 台账是「整文件读 → 改一行 → 整文件写回」。批跑的 record/observe、看板上的答复、另一个会话的 --set
// 同时在写：后写的人拿着自己读到的旧副本整份写回，先写的人的改动（典型是 owner 的答复）被静默抹掉。
// 实测：并发写回时大部分答复被旧副本盖掉，owner 同一个问题被问了很多轮。
// 修法：readBlockers 记下读到时每行的原文；writeBlockers 在锁里重读磁盘，只把「本进程改过的字段」合进最新版本，
// 再原子替换。没改过的行、改过的行里没改的字段，一律以磁盘为准，所以别人的答复不会被一份旧副本盖掉。
const _seen = new Map();   // path -> Map(id -> 读到时的那行原文)
function readRows(p) {
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function withLock(p, fn) {
  const lock = p + '.lock';
  const t0 = Date.now();
  for (;;) {
    try { mkdirSync(lock); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // 持锁进程崩了留下的锁：超过 30 秒算陈锁，拿走
      try { if (Date.now() - statSync(lock).mtimeMs > 30_000) { rmSync(lock, { recursive: true, force: true }); continue; } } catch { continue; }
      if (Date.now() - t0 > 20_000) throw new Error(`台账锁 ${lock} 20 秒拿不到（别的进程还在写；确认没人在写后可删掉这个目录）`);
      const until = Date.now() + 25; while (Date.now() < until) { /* 同步等一小会 */ }
    }
  }
  try { return fn(); } finally { rmSync(lock, { recursive: true, force: true }); }
}
function atomicWrite(p, text) {
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, text); renameSync(tmp, p);
}
export function readBlockers(SKILL, demand) {
  const p = blockerPath(SKILL, demand);
  const rows = readRows(p);
  _seen.set(p, new Map(rows.map(r => [r.id, JSON.stringify(r)])));
  return rows;
}
export function writeBlockers(SKILL, demand, list) {
  const p = blockerPath(SKILL, demand);
  mkdirSync(dirname(p), { recursive: true });
  const seen = _seen.get(p) || new Map();
  withLock(p, () => {
    const disk = readRows(p);
    const byId = new Map(disk.map(r => [r.id, r]));
    for (const r of list) {
      const base = seen.get(r.id);
      if (base === JSON.stringify(r)) continue;       // 本进程没改这行：以磁盘为准
      const cur = byId.get(r.id);
      if (base === undefined || !cur) { byId.set(r.id, r); continue; }   // 新加的行
      // 改过的行按字段合：只写本进程改了的字段，其余字段以磁盘为准。
      // 整行替换会把别人刚写进去的字段（典型：owner 的答复）用本进程读到的旧值盖掉。
      const was = JSON.parse(base), merged = { ...cur };
      for (const k of new Set([...Object.keys(was), ...Object.keys(r)])) {
        if (JSON.stringify(was[k]) === JSON.stringify(r[k])) continue;
        if (k in r) merged[k] = r[k]; else delete merged[k];
      }
      byId.set(r.id, merged);
    }
    const out = [...byId.values()];
    atomicWrite(p, out.map(x => JSON.stringify(x)).join('\n') + (out.length ? '\n' : ''));
    _seen.set(p, new Map(out.map(r => [r.id, JSON.stringify(r)])));
  });
}
// 同一条用例的同一条断言、卡在同一个问题上（阻塞类型和说明都一样），上一次被 owner 答过（不论哪个运行），
// 新运行里再卡住时沿用那个答复，不再问人。答复带出处，owner 要改口照常 --ack 覆盖。
// 只按断言配的话，换了个原因卡住（例如上次缺账号、这次后端挂了）也会套上旧答复，等于替 owner 答了一个他没见过的问题。
function priorAnswer(all, caseName, expect, kind, text) {
  const prev = all.filter(b => b.case === caseName && b.expect === expect && b.answer && b.answered_by
      && b.kind === kind && (b.text || '') === (text || ''))
    .sort((a, b) => String(b.answered_at || '').localeCompare(String(a.answered_at || '')));
  return prev[0] || null;
}
/** 这一轮里「还没上报」的阻塞 —— report 的硬闸看它 */
export function unreportedFor(SKILL, demand, run) {
  // resolved（执行者自己解掉的）不必再上报 —— 它已经不是阻塞了
  return readBlockers(SKILL, demand).filter(b => !b.reported && !b.resolved && (!run || b.run === run));
}
