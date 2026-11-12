// demand-registry — 需求是一等公民，用例是跨需求复用的资产（一条用例可以服务多个需求）。
//
// 旧模型：每个用例文件里一个单值 demand，看板按它分组、regress 按它挑用例。实际数据会把它撑破：
//   评审单里的 reuse 引用大多跨需求，不少 run 的 session 需求 ≠ 用例需求。
// 新模型：
//   · 需求登记表 state/demands.json（id → {title, desc}）—— 需求本身在这里，不再从用例文件里"收集"
//   · 需求 ↔ 用例 的多对多关系只在**评审单** state/plans/<D>.json 里（surfaces[].reuse / new）
//   · 用例文件只保留 origin（第一次为哪条需求写的，纯出处，不参与任何分组与筛选）
//   · run 记 demand（这次为哪条需求跑）；session → 需求 的登记表 sessions.json 照旧
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { approvedCases } from './plan-gate.mjs';

export const registryPath = SKILL => join(SKILL, 'state', 'demands.json');

export function loadDemands(SKILL) {
  const out = new Map();
  try {
    const j = JSON.parse(readFileSync(registryPath(SKILL), 'utf8'));
    for (const [id, d] of Object.entries(j.demands || {})) out.set(id, { id, ...d });
  } catch { /* 还没登记表 */ }
  return out;
}
export function saveDemands(SKILL, map) {
  const p = registryPath(SKILL);
  mkdirSync(dirname(p), { recursive: true });
  const demands = {};
  for (const [id, d] of [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true })))
    demands[id] = { title: d.title || id, desc: d.desc || '', ...(d.created_at ? { created_at: d.created_at } : {}) };
  writeFileSync(p, JSON.stringify({ _doc: '需求登记表：需求本身在这里；需求↔用例的关系在 state/plans/<D>.json 的评审单里；用例文件只有 origin（出处）。', demands }, null, 1));
  return p;
}
export function registerDemand(SKILL, d) {
  const m = loadDemands(SKILL);
  if (!m.has(d.id)) { m.set(d.id, { id: d.id, title: d.title || d.id, desc: d.desc || '', created_at: new Date().toISOString() }); saveDemands(SKILL, m); }
  return m.get(d.id);
}

export function allPlans(SKILL) {
  const dir = join(SKILL, 'state', 'plans');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith('.json')).map(f => { try { return JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { return null; } })
    .filter(Boolean).sort((a, b) => String(a.demand).localeCompare(String(b.demand), undefined, { numeric: true }));
}
export function planCaseSet(plan) {
  const out = new Set();
  for (const s of plan?.surfaces || []) for (const x of [...(s.reuse || []), ...(s.new || [])]) out.add(x);
  return out;
}
/** 哪些需求的评审单引用了这条用例 → [{demand, surface, how: 'reuse'|'new', approved}] */
export function demandsReferencing(SKILL, caseName, plans = null) {
  const out = [];
  for (const p of plans || allPlans(SKILL)) for (const s of p.surfaces || []) {
    const approved = approvedCases(p).has(caseName);   // 按用例算：评审单修订后，只有新加的那几条没批
    if ((s.reuse || []).includes(caseName)) out.push({ demand: p.demand, surface: s.id, how: 'reuse', approved });
    if ((s.new || []).includes(caseName)) out.push({ demand: p.demand, surface: s.id, how: 'new', approved });
  }
  return out;
}
/** 一次 run 属于哪条需求：run 自己记的 > session 登记表 > 用例出处（老 run 的退路）*/
export function demandOfRun(SKILL, res, c) {
  if (res?.demand?.id) return res.demand.id;
  if (typeof res?.demand === 'string') return res.demand;
  try { const reg = JSON.parse(readFileSync(join(SKILL, 'sessions.json'), 'utf8')); const d = reg[res?.session]?.demand?.id; if (d) return d; } catch {}
  return c?.origin?.id || c?.demand?.id || null;
}
