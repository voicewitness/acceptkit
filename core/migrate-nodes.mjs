// 节点形状迁移（doctor --fix，一次完成、可重复执行）：
//   group: true → kind: 'group'（分组的标题文字仍在 op 里：57 处读 op 的代码不用跟着改）
//   每个节点分配稳定的 nid（用例内唯一、永不复用；n1.2 这种位置编号挪了节点就变，评审记录要挂在不变的 id 上）
//   已有 id 字段的节点（老写法）改名 nid
// 不替存量补 because / role：缺 because 由评审逐条补（E1 上限 0），role 缺省按 claim 读（最严）。
// 评审单钉住的用例指纹：迁移前就等于钉的值的，按迁移后的内容重钉；迁移前就已被改过的保持「已改」，不借迁移洗掉。
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const fp12 = buf => createHash('sha256').update(buf).digest('hex').slice(0, 12);

/** 改写一条用例（原地）→ 改了几处 */
export function migrateCase(c) {
  let n = 0;
  const used = new Set();
  (function scan(ns) { for (const x of ns || []) { if (x.nid) used.add(x.nid); scan(x.children); } })(c.tree);
  for (const id of [].concat(c.retired_nids || [])) used.add(id);   // 删掉的节点的 nid 不再分给新节点：评审记录挂在 nid 上
  const fresh = (seed) => { for (let i = 0; ; i++) { const id = 's' + createHash('sha256').update(`${c.case}|${seed}|${i}`).digest('hex').slice(0, 4); if (!used.has(id)) { used.add(id); return id; } } };
  (function w(ns, p) { (ns || []).forEach((x, i) => { const pos = `${p}${i + 1}`;
    if ('group' in x) { if (x.group) x.kind = 'group'; delete x.group; n++; }
    if (!x.nid && x.id && typeof x.id === 'string' && !used.has(x.id)) { x.nid = x.id; used.add(x.id); delete x.id; n++; }
    if (!x.nid) { x.nid = fresh(pos); n++; }
    w(x.children, `${pos}.`); }); })(c.tree, 'n');
  return n;
}

/** 整个项目：用例 + 评审单底稿 + 钉住的指纹。dry=true 只报告 */
export function migrateProject(root, { dry = false } = {}) {
  const casesDir = join(root, 'cases'), plansDir = join(root, 'state', 'plans');
  const out = { cases: 0, nodes: 0, snaps: 0, repinned: 0, kept_drift: 0, groups: 0 };
  const before = new Map(), after = new Map();
  const stamp = new Date().toISOString().slice(0, 10);
  const attic = join(root, 'attic', `cases-before-nodes-${stamp}`);
  for (const f of existsSync(casesDir) ? readdirSync(casesDir).filter(f => f.endsWith('.case.json')) : []) {
    const p = join(casesDir, f), raw = readFileSync(p); let c; try { c = JSON.parse(raw); } catch { continue; }
    const g = JSON.stringify(c).split('"group":true').length - 1;
    const k = migrateCase(c); if (!k) continue;
    out.cases++; out.nodes += k; out.groups += g;
    const name = f.replace(/\.case\.json$/, ''), next = JSON.stringify(c, null, 2) + '\n';
    before.set(name, fp12(raw)); after.set(name, fp12(Buffer.from(next)));
    if (!dry) { mkdirSync(attic, { recursive: true }); copyFileSync(p, join(attic, f)); writeFileSync(p, next); }
  }
  // 评审单底稿（批准时的样子）做同样的改写，后面判「改了什么」才不会把迁移算成改动
  for (const d of existsSync(plansDir) ? readdirSync(plansDir).filter(x => x.endsWith('.snap')) : []) {
    for (const f of readdirSync(join(plansDir, d)).filter(x => x.endsWith('.json'))) {
      const p = join(plansDir, d, f); let c; try { c = JSON.parse(readFileSync(p, 'utf8')); } catch { continue; }
      if (migrateCase(c)) { out.snaps++; if (!dry) writeFileSync(p, JSON.stringify(c, null, 2) + '\n'); }
    }
  }
  for (const f of existsSync(plansDir) ? readdirSync(plansDir).filter(x => x.endsWith('.json')) : []) {
    const p = join(plansDir, f); let plan; try { plan = JSON.parse(readFileSync(p, 'utf8')); } catch { continue; }
    let touched = false;
    for (const [name, pinned] of Object.entries(plan.fingerprints || {})) {
      if (!after.has(name)) continue;
      if (pinned === before.get(name)) { plan.fingerprints[name] = after.get(name); out.repinned++; touched = true; } else out.kept_drift++;
    }
    if (touched && !dry) writeFileSync(p, JSON.stringify(plan, null, 2) + '\n');
  }
  return out;
}
