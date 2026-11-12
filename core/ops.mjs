// 操作库：用例只说【做什么】（op_id），各平台各自说【怎么做】（配方）。正本 ops/registry.json，人可读。
//
// 配方是用户设置进来的知识（和构建、驱动设置同类）：用户说的、或 agent 实测出来的平台做法。
// 所以它和设置一样要有写口，并且写入时校验 —— 只能手改 JSON 时，新发现的做法要么没人写回去、
// 要么写回去时字段各写各的（同一个意思出现 caveat / caveats / note 三种写法），读的一方认不出来。
// 手改的文件也过同一道检查（acceptkit ops check、doctor）。
//
// 形状：
//   { "_why": "…", "ops": { "<id>": { title, why, kind?: "observe"|"act", platforms: { <键>: 配方 } } } }
//   键 = <平台>（与宿主无关：该平台所有宿主都用它）| <平台>@<宿主>（只在这个宿主上成立，优先于前者）
//   配方 = { how | exec | steps …, state: "guess"|"confirmed"|"verified", source }
//        | { absent: true, blocker: "为什么这个平台（宿主）还做不了", unlock?: "怎样才能做" }
//   <平台>@<宿主> 写 absent = 这个宿主上没有这个操作，有通用做法也不套用。
//   推测（guess）的配方不执行：确认后才用（acceptkit ops confirm）。
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { RUNTIME_PLATFORMS } from './platform.mjs';
import { HOST_ID } from './hosts.mjs';

export const opsPath = root => join(root, 'ops', 'registry.json');
export const STATE_LABEL = { guess: '推测', confirmed: '已确认', verified: '已验证' };

const ID = /^[a-z0-9][a-z0-9-]*$/;
const KINDS = ['observe', 'act'];
// 配方字段：内核执行时读的 + 写给人和 agent 读的。不在这里的字段读的一方不认识，等于没写。
export const RECIPE_KEYS = {
  how: '怎么做（一句话）', entry: '入口（类 / 页面 / 命令）', evidence: '留下什么证据', switches: '要打开的开关（列表）',
  steps: '分步做法（列表）', caveats: '注意事项（列表）', pitfalls: '踩过的坑（列表）',
  exec: '观测执行器名（kind=observe 时内核调用）', strength: '证据强度 S1–S4', read: '读哪个诊断项', port: '端口来源',
  url: '页面网址', tab: '页签匹配', eval: '页面内求值表达式', settle_ms: '操作后等多久再读', wait_ms: '等待上限',
  gate: '先决条件（总闸等）', history: '做法的演变', verified: '实测记录（什么时候、在哪跑通的）', state: '推测 / 已确认 / 已验证', source: '从哪来的',
};
const ABSENT_KEYS = new Set(['absent', 'blocker', 'unlock']);
const LIST_KEYS = new Set(['switches', 'steps', 'caveats', 'pitfalls']);
const OP_KEYS = new Set(['title', 'why', 'kind', 'platforms', 'pitfalls', 'notes']);

export function loadRegistry(root) {
  const f = opsPath(root);
  if (!existsSync(f)) return { _why: '', ops: {} };
  const doc = JSON.parse(readFileSync(f, 'utf8'));
  return { ...doc, ops: doc.ops || {} };
}
export const loadOps = root => loadRegistry(root).ops;

/** 配方键 ↔ { platform, host } */
export const parseKey = k => { const i = k.indexOf('@'); return i < 0 ? { platform: k, host: null } : { platform: k.slice(0, i), host: k.slice(i + 1) }; };
export const recipeKey = (platform, host) => (host ? `${platform}@${host}` : platform);

/** 某宿主在某平台上用哪份配方：宿主自己的优先，没有才用与宿主无关的那份 → { key, recipe } | null */
export function recipeFor(o, platform, host) {
  const ps = o?.platforms || {};
  const own = host && ps[recipeKey(platform, host)];
  if (own) return { key: recipeKey(platform, host), recipe: own };
  return ps[platform] ? { key: platform, recipe: ps[platform] } : null;
}
/** 该平台上至少有一个宿主做得了（评审单按平台粗看缺口时用） */
export const doableOn = (o, platform) => Object.entries(o?.platforms || {}).some(([k, r]) => parseKey(k).platform === platform && !r.absent);

/**
 * 一条操作的问题：[{ id, platform?, level, msg }]。
 * block = 结构错了，读的一方会用错（写口直接拒）；warn = 读的一方认不出这个字段，等于没写。
 */
export function opProblems(id, o, hosts = null) {
  const out = [];
  const p = (msg, platform, level = 'block') => out.push({ id, ...(platform ? { platform } : {}), level, msg });
  if (!ID.test(id)) p('id 只能用小写字母、数字、连字符');
  if (!o.title) p('缺 title（平台中立地说做什么）');
  if (!o.why) p('缺 why（为什么要有这个操作）');
  if (o.kind && !KINDS.includes(o.kind)) p(`kind 只能是 ${KINDS.join(' / ')}（缺省 act）`);
  for (const k of Object.keys(o)) if (!OP_KEYS.has(k)) p(`不认识的字段 ${k}`, null, 'warn');
  const plats = Object.entries(o.platforms || {});
  if (!plats.length) p('没有任何平台的配方');
  for (const [pl, r] of plats) {
    const k = parseKey(pl);
    if (!RUNTIME_PLATFORMS.includes(k.platform)) { p(`平台只能是 ${RUNTIME_PLATFORMS.join(' / ')}；只在某宿主上成立的做法写成 <平台>@<宿主>`, pl); continue; }
    if (k.host !== null && !HOST_ID.test(k.host)) { p('宿主 id 只能用小写字母、数字、连字符', pl); continue; }
    if (k.host && hosts && !hosts.includes(k.host)) p(`宿主 ${k.host} 没有登记（acceptkit host add ${k.host} …）`, pl);
    if (r.absent) {
      if (!r.blocker) p('标了 absent 要写 blocker：为什么这个平台还做不了', pl);
      for (const k of Object.keys(r)) if (!ABSENT_KEYS.has(k)) p(`absent 配方里不该有 ${k}（做法还不存在）`, pl);
      continue;
    }
    if (!r.how && !r.exec && !r.steps) p('配方至少要有 how / exec / steps 之一', pl);
    if (o.kind === 'observe' && !r.exec) p('kind=observe 的配方要写 exec（观测执行器）', pl);
    if (r.state && !STATE_LABEL[r.state]) p(`state 只能是 ${Object.keys(STATE_LABEL).join(' / ')}`, pl);
    if (!r.state) p('缺 state（推测 / 已确认 / 已验证）', pl, 'warn');
    for (const k of Object.keys(r)) if (!RECIPE_KEYS[k]) p(`不认识的字段 ${k}`, pl, 'warn');
    for (const k of LIST_KEYS) if (r[k] !== undefined && !Array.isArray(r[k])) p(`${k} 要写成列表`, pl);
  }
  return out;
}
export const registryProblems = (root, hosts = null) => Object.entries(loadOps(root)).flatMap(([id, o]) => opProblems(id, o, hosts));

const keyFlags = key => { const k = parseKey(key); return `--platform ${k.platform}${k.host ? ` --host ${k.host}` : ''}`; };

/** 执行时取配方：没有 / 平台缺 / 推测都给出原因，不让调用方去猜。host = 这一步在哪个宿主上做。
 *  tryGuess：试跑（observe --try：真执行、不记结论）可以用推测的配方 —— 不然只能先确认再验证，顺序反了 */
export function opRecipe(root, opId, platform, host = null, { tryGuess = false } = {}) {
  const o = loadOps(root)[opId];
  if (!o) return { error: `操作库里没有 ${opId}` };
  const hit = recipeFor(o, platform, host);
  if (!hit) return { title: o.title, absent: true, note: `${recipeKey(platform, host)} 上还没有这个操作的实现` };
  const r = hit.recipe;
  if (r.absent) return { title: o.title, absent: true, note: `${hit.key} 上做不了：${r.blocker || ''}` };
  if (r.state === 'guess' && !tryGuess) return { title: o.title, error: `${opId} 的 ${hit.key} 配方还是推测，确认后才用：acceptkit ops confirm ${opId} ${keyFlags(hit.key)}；想先试跑看看：observe 加 --try（真执行，不记结论）` };
  return { title: o.title, why: o.why, key: hit.key, ...r };
}

function save(root, doc) {
  mkdirSync(join(root, 'ops'), { recursive: true });
  writeFileSync(opsPath(root), JSON.stringify(doc, null, 2) + '\n');
}

/**
 * 新增或修改一条操作的某个平台配方。
 * recipe 是要写入的字段；replace=false 时并进已有配方（只改给出的字段），true 时整份替换。
 * 写完这条操作必须没有问题，否则不落盘。
 */
export function writeOp(root, id, { title, why, kind, platform, recipe = {}, replace = false, absent, hosts = null }) {
  const doc = loadRegistry(root);
  const cur = doc.ops[id];
  const o = cur ? structuredClone(cur) : { title: '', why: '', platforms: {} };
  if (title) o.title = title;
  if (why) o.why = why;
  if (kind) o.kind = kind;
  if (platform) {
    o.platforms ||= {};
    if (absent) o.platforms[platform] = { absent: true, blocker: absent.blocker, ...(absent.unlock ? { unlock: absent.unlock } : {}) };
    else {
      const base = replace || o.platforms[platform]?.absent ? {} : (o.platforms[platform] || {});
      o.platforms[platform] = { ...base, ...recipe };
    }
  }
  // 只拦这次写到的部分：别的平台上的存量问题照常由 ops check 报，不挡这次写入
  const probs = opProblems(id, o, hosts).filter(x => (!x.platform || x.platform === platform) && (x.level === 'block' || x.platform === platform));
  if (probs.length) throw new Error(`${id} 写不进去：\n${probs.map(x => `  · ${x.platform ? `[${x.platform}] ` : ''}${x.msg}`).join('\n')}`);
  doc.ops[id] = o;
  save(root, doc);
  return { created: !cur, op: o };
}

export function setOpState(root, id, platform, state) {
  const doc = loadRegistry(root);
  const r = doc.ops[id]?.platforms?.[platform];
  if (!r) throw new Error(`${id} 没有 ${platform} 配方`);
  if (r.absent) throw new Error(`${id} 的 ${platform} 配方是 absent，没有可确认的做法`);
  r.state = state;
  save(root, doc);
}

/** 删一条操作；还被用例引用时拒绝（引用它的用例会变成跑不了）。 */
export function removeOp(root, id, usedBy = []) {
  const doc = loadRegistry(root);
  if (!doc.ops[id]) throw new Error(`操作库里没有 ${id}`);
  if (usedBy.length) throw new Error(`${id} 还被 ${usedBy.length} 条用例引用：${usedBy.slice(0, 8).join(' ')}${usedBy.length > 8 ? ' …' : ''}`);
  delete doc.ops[id];
  save(root, doc);
}

/**
 * doctor --fix：把能机械改正的旧写法改成现行形状。改不了的留给 ops check 报出来。
 *   · absent 配方里写在 note / how 的原因 → blocker
 *   · caveat（单数字符串）→ caveats（列表）；tested → verified
 *   · host / host_constraint（自由文字的宿主限定）→ caveats；改成 <平台>@<宿主> 键要人来定归属
 *   · <平台>_<宿主> 键 → <平台>@<宿主>（宿主是登记过的 id 时）
 *   · 没写 state 的配方：实测记录里写了跑通的 → verified；没有或写着「未验证」→ confirmed（维护者手写的做法）
 */
export function migrateRegistry(root, hosts = []) {
  const doc = loadRegistry(root); let n = 0;
  const rename = (r, from, to) => { if (r[from] === undefined) return; r[to] = r[to] ? `${r[to]}；${r[from]}` : r[from]; delete r[from]; n++; };
  for (const o of Object.values(doc.ops)) for (const k of Object.keys(o.platforms || {})) {
    const m = /^([a-z]+)_([a-z0-9-]+)$/.exec(k), to = m && `${m[1]}@${m[2]}`;
    if (m && RUNTIME_PLATFORMS.includes(m[1]) && hosts.includes(m[2]) && !o.platforms[to]) { o.platforms[to] = o.platforms[k]; delete o.platforms[k]; n++; }
  }
  for (const o of Object.values(doc.ops)) for (const r of Object.values(o.platforms || {})) {
    if (r.absent) {
      const why = r.blocker || r.note || r.how;
      if (why && (r.note || r.how)) { r.blocker = why; delete r.note; delete r.how; n++; }
      continue;
    }
    if (typeof r.caveat === 'string') { r.caveats = [...(r.caveats || []), r.caveat]; delete r.caveat; n++; }
    rename(r, 'tested', 'verified');
    for (const f of ['host_constraint', 'host']) if (typeof r[f] === 'string') { r.caveats = [...(r.caveats || []), `限定宿主：${r[f]}`]; delete r[f]; n++; }
    if (!r.state) {
      r.state = r.verified && !/未验证/.test(r.verified) ? 'verified' : 'confirmed';
      r.source ||= '迁移前手写'; n++;
    }
  }
  if (n) save(root, doc);
  return n;
}
