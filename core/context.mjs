// context — 执行到某个操作节点时，一次拿到这一步需要的经验（docs/002-protocol.md 第四节）。
//
// 为什么由工具递：经验是项目的数据（操作库、知识、以往运行），执行者不必一次读完整本手册，
// 也不该靠上一个会话的记忆；做到这一步时问一次，工具按节点算出相关的那几条。
// 这里只读文件，不写；卡片是已有概念（操作 / 知识 / 运行 / 复核）的投影，不是新概念。
// 长内容截到 300 字，全文用 read context/<运行>/<节点> 取。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { loadOps, recipeFor, recipeKey, STATE_LABEL } from './ops.mjs';
import { allEntries } from './knowledge.mjs';
import { hostOfCase } from './hosts.mjs';
import { normalizePlatforms, RUNTIME_PLATFORMS } from './platform.mjs';
import { maskDeep } from './secrets.mjs';

export const KNOWLEDGE_MAX = 8;
export const HISTORY_MAX = 5;
const CLIP = 300;
const UI_CARRIERS = new Set(['ui', 'app_ui', 'page']);   // 和 next.mjs 的 step_todo 同口径
const KNOW_STATE_RANK = { verified: 0, confirmed: 1, null: 2, guess: 3 };
const KNOW_STATE_LABEL = { verified: '已验证', confirmed: '已确认', guess: '推测：不用来做决定' };

const readJSON = f => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
const squash = s => String(s ?? '').replace(/\s+/g, ' ').trim();

// 操作标题 / 操作文字里检索知识用的词：拉丁词取整词，中文没有空格，取相邻两字
function termsOf(s) {
  const out = new Set();
  for (const w of String(s || '').split(/[^\p{L}\p{N}_-]+/u).filter(Boolean)) {
    if (/\p{Script=Han}/u.test(w)) { const h = w.replace(/[^\p{Script=Han}]/gu, ''); for (let i = 0; i + 1 < h.length; i++) out.add(h.slice(i, i + 2)); }
    else if (w.length >= 3) out.add(w.toLowerCase());
  }
  return [...out];
}
const tagTerms = tags => Object.values(tags || {}).flatMap(v => [].concat(v)).map(v => String(v).toLowerCase()).filter(Boolean);

/**
 * 相关知识：按操作 id（5 分）、节点标签 / 宿主（2 / 1 分）、操作标题里的词（每个 1 分）打分，至少 2 分才算相关。
 * 标了别的平台（#ios / #android / #web）而没标本平台的不给：那是另一个平台的做法。
 */
export function relatedKnowledge(root, { opId, title, tags, host, platforms, min = 2 }, cut) {
  const words = termsOf(title), tg = tagTerms(tags);
  const scored = [];
  for (const e of allEntries(root)) {
    const etags = e.tags.map(t => t.toLowerCase());
    const pf = etags.filter(t => RUNTIME_PLATFORMS.includes(t));
    if (pf.length && platforms.length && !pf.some(p => platforms.includes(p))) continue;
    const body = `${e.heading}\n${e.text}`.toLowerCase();
    const why = [];
    let score = 0;
    if (opId && (body.includes(opId) || etags.includes(opId))) { score += 5; why.push(opId); }
    for (const t of tg) if (etags.includes(t)) { score += 2; why.push(`#${t}`); }
    if (host && etags.includes(String(host).toLowerCase())) { score += 1; why.push(`#${host}`); }
    const hit = words.filter(w => body.includes(w));
    score += hit.length; why.push(...hit.slice(0, 4));
    if (score >= min) scored.push({ e, score, why });
  }
  scored.sort((a, b) => b.score - a.score || KNOW_STATE_RANK[a.e.state] - KNOW_STATE_RANK[b.e.state] || a.e.file.localeCompare(b.e.file) || a.e.line - b.e.line);
  return scored.slice(0, KNOWLEDGE_MAX).map(({ e, why }) => ({
    ref: `${basename(e.file)}:${e.line}`, ...(e.heading ? { heading: e.heading } : {}),
    state: e.state, state_label: KNOW_STATE_LABEL[e.state] || '没标状态', matched: why,
    ...(e.secret ? { secret: true } : {}), text: cut(e.text),
  }));
}

// 这个节点在某平台（宿主）上的做法：推测的标明不执行，缺的写清缺在哪
function recipeLine(o, opId, platform, host, cut) {
  const hit = recipeFor(o, platform, host);
  const key = recipeKey(platform, host);
  if (!hit) return { platform, key, runnable: false, note: `${key} 上还没有这个操作的做法：做通了写进操作库（acceptkit ops set ${opId} --platform ${platform}${host ? ` --host ${host}` : ''} --how "…" --guess）` };
  const r = hit.recipe;
  if (r.absent) return { platform, key: hit.key, runnable: false, absent: true, note: `${hit.key} 上做不了：${cut(r.blocker || '')}`, ...(r.unlock ? { unlock: cut(r.unlock) } : {}) };
  const out = { platform, key: hit.key, state: r.state || null, state_label: STATE_LABEL[r.state] || '没标状态', runnable: r.state !== 'guess' };
  for (const k of ['how', 'entry', 'evidence', 'url', 'source']) if (r[k]) out[k] = cut(r[k]);
  for (const k of ['steps', 'switches', 'caveats', 'pitfalls']) if (Array.isArray(r[k]) && r[k].length) out[k] = r[k].map(cut);
  if (r.state === 'guess') out.note = `推测：不执行。确认做法对了再用：acceptkit ops confirm ${opId} --platform ${parseFlags(hit.key)}`;
  return out;
}
const parseFlags = key => { const i = key.indexOf('@'); return i < 0 ? key : `${key.slice(0, i)} --host ${key.slice(i + 1)}`; };

/**
 * 这个用例同一节点在以往运行里的情况（不含本运行）：断言失败几次、取证手段故障几次、盲审驳回的理由。
 * 节点编号按树位置算：用例改过树时同一个编号可能是另一步，所以运行里记下的操作文字对不上的跳过。
 */
function nodeHistory(root, { run, caseId, nodeId, op, expectIds }, cut) {
  const dir = join(root, 'runs');
  const h = { runs: 0, fails: 0, apparatus: 0, rejections: 0, fail_samples: [], apparatus_samples: [], rejection_samples: [] };
  if (!existsSync(dir)) return h;
  const scopes = new Set([`step:${nodeId}`, ...expectIds]);
  const rows = [];
  for (const d of readdirSync(dir)) {
    if (d === run) continue;
    const r = readJSON(join(dir, d, 'result.json'));
    if (!r || r.case !== caseId) continue;
    const recorded = r.steps?.[nodeId]?.op;
    if (recorded && squash(recorded) !== squash(op)) continue;
    rows.push({ id: d, r });
  }
  rows.sort((a, b) => (b.r.run_seq || 0) - (a.r.run_seq || 0) || b.id.localeCompare(a.id));
  h.runs = rows.length;
  for (const { id, r } of rows) {
    for (const x of expectIds) {
      const res = r.results?.[x];
      if (res?.status !== 'fail') continue;
      h.fails++;
      h.fail_samples.push({ run: id, expect: x, ...(res.actual ? { actual: cut(res.actual) } : {}) });
    }
    for (const a of r.apparatus || []) {
      if (!scopes.has(a.where)) continue;
      h.apparatus++;
      h.apparatus_samples.push({ run: id, where: a.where, what: cut(a.text), fix: a.fix ? cut(a.fix) : '（没写修法）' });
    }
    for (const [key, rv] of Object.entries(r.reviews || {})) {
      const scope = key.split('::')[0];
      // pending 是待审（含重开、判定变了作废的旧复核），不是驳回：与 cards.rejectedCard / next 同口径
      if (!scopes.has(scope) || !rv || rv.state === 'ok' || rv.state === 'pending') continue;
      h.rejections++;
      h.rejection_samples.push({ run: id, scope, evidence: key.split('::').slice(1).join('::'), verdict: rv.state, note: cut(rv.note || ''), at: rv.at || null });
    }
  }
  h.rejection_samples.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  for (const k of ['fail_samples', 'apparatus_samples', 'rejection_samples']) h[k] = h[k].slice(0, HISTORY_MAX);
  return h;
}

/**
 * buildContext(root, ctx, { full }) → context 卡片。
 * ctx：{ run, r（result.json）, c（用例）, nodeId, node（用例里的原节点）, cfg, obscuring（含项目扩展追加的）, playbook: string[] }
 * full = true 时不截断（read context/R/nN 用）。
 */
export function buildContext(root, { run, r, c, nodeId, node, cfg = {}, obscuring = [], playbook = [] }, { full = false } = {}) {
  const cut = full ? (s => String(s ?? '')) : (s => { const t = squash(s); return t.length > CLIP ? t.slice(0, CLIP) + '…' : t; });
  const declared = normalizePlatforms(c).filter(p => RUNTIME_PLATFORMS.includes(p));
  const one = r.platform || r.device?.platform || (declared.length === 1 ? declared[0] : null);
  const platforms = one ? [one] : declared;
  const host = one ? hostOfCase(c, one) : null;
  const ops = loadOps(root);
  const o = node.op_id ? ops[node.op_id] : null;
  const expects = node.expect || [];

  const op = { text: cut(node.op), op_id: node.op_id || null };
  if (!node.op_id) op.note = '这一步没引用操作库：照操作文字做；做通了把做法写进操作库（acceptkit ops set <id> --platform <P> --how "…" --guess），再让用例引用它';
  else if (!o) op.note = `操作库里没有 ${node.op_id}：照操作文字做，或先补上这条操作（acceptkit ops set ${node.op_id} …）`;
  else {
    op.title = o.title;
    if (o.why) op.why = cut(o.why);
    for (const k of ['pitfalls', 'notes']) if (o[k]) op[k] = [].concat(o[k]).map(cut);
    op.recipes = platforms.map(p => recipeLine(o, node.op_id, p, hostOfCase(c, p), cut));
  }

  const danger = node.danger ? { ...node.danger } : null;
  const uninstall = expects.filter(e => e.requires_uninstall).map(e => e.id);
  const cautions = [];
  if (danger) cautions.push(`这一步有危险动作（${danger.kind || '没写种类'}）：做之前要 ${danger.confirm || '用户'} 点头；会改被测端状态的动作先过 acceptkit gate --action "…" --run ${run}`);
  if (uninstall.length) cautions.push(`${uninstall.join(' ')} 要卸载重装：只按用例写明的做，卸载前先过 acceptkit gate`);

  const pf = one || platforms[0] || null;
  const knowledge = relatedKnowledge(root, { opId: node.op_id, title: o?.title || node.op, tags: node.tags, host, platforms }, cut);
  const obsc = obscuring.map(x => ({ name: x.name, words: (x.any || []).slice(0, 6), how: cut((pf === 'android' && x.how_android) || x.how || '') }));
  const history = nodeHistory(root, { run, caseId: r.case || c.case, nodeId, op: node.op, expectIds: expects.map(e => e.id) }, cut);
  const ui = cfg.report?.uiSteps === 'all' || UI_CARRIERS.has(String(node.tags?.carrier ?? ''));
  const shotCmd = `acceptkit shot ${run} ${pf === 'web' ? '--web ' : ''}--step ${nodeId}`;

  const card = {
    kind: 'context', run, case: r.case || c.case, node: nodeId, platform: one, ...(host ? { host } : {}),
    title: `${nodeId} 这一步的经验：${cut(node.op).slice(0, 60)}`,
    op, shows: node.shows || [], danger, ...(uninstall.length ? { uninstall } : {}),
    knowledge, obscuring: obsc, history, shot: playbook.map(l => l.replace(/\s+$/, '')),
    ...(cautions.length ? { detail: cautions } : {}),
    note: [
      ...(cautions.length ? ['先看 detail 里的危险动作'] : []),
      ui ? `做这一步，再 ${shotCmd}` : '做这一步，留下机器证据（observe / record --step）',
      ...(history.rejections ? ['以往盲审驳回过这一步：照 history 里的理由留证据'] : []),
    ].join('；'),
    read: `context/${run}/${nodeId}`,
  };
  return maskDeep(root, card);   // 知识里的 #secret 值、以往运行的原文都不经 context 流出
}

/** 文本模式：一段一段打出来，空的段写明「没有」，让人知道是查过了没有，而不是没查。 */
export function formatContext(k) {
  const L = [`${k.title}`, `   运行 ${k.run} · 用例 ${k.case} · 平台 ${k.platform || '（运行还没定平台）'}${k.host ? ` · 宿主 ${k.host}` : ''}`];
  L.push('', '操作做法');
  L.push(`   ${k.op.text}${k.op.op_id ? `（操作库 ${k.op.op_id}${k.op.title ? `：${k.op.title}` : ''}）` : ''}`);
  if (k.op.note) L.push(`   ⚠️ ${k.op.note}`);
  for (const p of k.op.pitfalls || []) L.push(`   坑：${p}`);
  for (const rc of k.op.recipes || []) {
    L.push(`   [${rc.key}] ${rc.state_label || ''}${rc.runnable ? '' : ' · 不执行'}`);
    if (rc.note) L.push(`      ${rc.note}`);
    for (const f of ['how', 'entry', 'evidence', 'url']) if (rc[f]) L.push(`      ${f}：${rc[f]}`);
    for (const f of ['steps', 'switches', 'caveats', 'pitfalls']) for (const x of rc[f] || []) L.push(`      ${f === 'steps' ? '·' : `${f}：`} ${x}`);
  }
  L.push('', `画面上应该出现：${k.shows.length ? k.shows.join('、') : '（节点没写 shows）'}`);
  L.push(`危险等级：${k.danger ? `${k.danger.kind || '没写种类'}，要 ${k.danger.confirm || '用户'} 点头` : '没标 danger'}${k.uninstall ? ` · 要卸载：${k.uninstall.join(' ')}` : ''}`);
  for (const d of k.detail || []) L.push(`   ⚠️ ${d}`);
  L.push('', `相关知识（${k.knowledge.length}）`);
  if (!k.knowledge.length) L.push('   没有检索到');
  for (const e of k.knowledge) L.push(`   ${e.ref} [${e.state_label}]${e.secret ? ' 机密值已遮蔽' : ''} ${e.text}`);
  L.push('', '可能遇到的遮蔽层和关法');
  for (const x of k.obscuring) L.push(`   ${x.name}（${x.words.join(' / ')}）：${x.how}`);
  const h = k.history;
  L.push('', `以往运行（${h.runs} 次）：断言失败 ${h.fails} 次 · 取证手段故障 ${h.apparatus} 次 · 盲审驳回 ${h.rejections} 次`);
  for (const x of h.fail_samples) L.push(`   失败 ${x.run} ${x.expect}${x.actual ? `：${x.actual}` : ''}`);
  for (const x of h.apparatus_samples) L.push(`   故障 ${x.run} [${x.where}] ${x.what} → 修法：${x.fix}`);
  for (const x of h.rejection_samples) L.push(`   驳回 ${x.run} ${x.scope}（${x.verdict}）：${x.note}`);
  if (k.shot.length) L.push('', ...k.shot);
  L.push('', `→ ${k.note}`, `   全文：acceptkit read ${k.read}`);
  return L.join('\n');
}
