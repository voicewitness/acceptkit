// 断言的适用版本范围。
//
// na 的标准是「从某组件某版本起不适用，**回归旧版本时照常跑**」。
// 此前只在 record 时把 --since 写进 run 与 state/applicability.json —— 那份登记表**没有任何读者**：
// 建新 run 时全部 todo、看不见范围；在新包上照样能把只属于旧版本的断言记成 pass/blocked；
// 反过来某条 na 也能被继承到一个旧版本的轮次里。「旧版本仍可用」只靠自觉。
//
// 现在范围是**用例资产自己的属性**，写在节点或断言上，子节点继承：
//   "applies": { "component": "LibCore", "below": "1.2.0-beta.0", "why": "…" }
//   语义：组件版本 < below 时本断言适用；≥ below 时不适用（那个版本起被测的东西不存在了）。
// 读它的三处：validate（字段合法）、createRun（按 --build 预填 na / 留 todo）、record（结果与包版本矛盾直接拒）。

const VER_RE = /^\d+(\.\d+)*(-[0-9A-Za-z.]+)?$/;

/** semver 风格比较：核心段逐段比；同核心时正式版 > 任何预发布；预发布段数字按数值比。 */
export function verCmp(a, b) {
  const [ca, pa] = String(a).split('-', 2).length === 1 ? [a, null] : [a.slice(0, a.indexOf('-')), a.slice(a.indexOf('-') + 1)];
  const [cb, pb] = String(b).split('-', 2).length === 1 ? [b, null] : [b.slice(0, b.indexOf('-')), b.slice(b.indexOf('-') + 1)];
  const na = ca.split('.').map(Number), nb = cb.split('.').map(Number);
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const d = (na[i] || 0) - (nb[i] || 0);
    if (d) return Math.sign(d);
  }
  if (pa === null && pb === null) return 0;
  if (pa === null) return 1;
  if (pb === null) return -1;
  const xa = pa.split('.'), xb = pb.split('.');
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    if (xa[i] === undefined) return -1;
    if (xb[i] === undefined) return 1;
    const an = /^\d+$/.test(xa[i]), bn = /^\d+$/.test(xb[i]);
    if (an && bn) { const d = Number(xa[i]) - Number(xb[i]); if (d) return Math.sign(d); }
    else if (an !== bn) return an ? -1 : 1;
    else if (xa[i] !== xb[i]) return xa[i] < xb[i] ? -1 : 1;
  }
  return 0;
}

export function isVersion(v) { return VER_RE.test(String(v || '')); }

/** --build "<组件>@<版本>,<组件>@<版本>" → { 组件: '版本', … }（例：A 为 1.2.3、B 为 1.2.0-beta.3） */
export function parseBuild(s) {
  const out = {};
  for (const part of String(s || '').split(',').map(x => x.trim()).filter(Boolean)) {
    const m = part.match(/^([A-Za-z0-9_]+)@(\S+)$/);
    if (!m || !isVersion(m[2])) throw new Error(`--build 片段不合法：${part}（要 <组件>@<版本>，逗号分隔）`);
    out[m[1]] = m[2];
  }
  return out;
}

/** 断言 id → 生效的 applies（断言自己的优先，否则取最近的祖先节点）。 */
export function scopesOf(tree) {
  const out = {};
  const go = (nodes, inherited) => (nodes || []).forEach(n => {
    const here = n.applies || inherited;
    for (const e of n.expect || []) if (e.id) { const s = e.applies || here; if (s) out[e.id] = s; }
    go(n.children, here);
  });
  go(tree, null);
  return out;
}

export function validateScope(s, where) {
  const errs = [];
  if (!s || typeof s !== 'object') return [`${where} applies 必须是对象`];
  if (!/^[A-Za-z0-9_]+$/.test(s.component || '')) errs.push(`${where} applies.component 缺失或不合法`);
  if (!isVersion(s.below)) errs.push(`${where} applies.below 必须是版本号（例 1.2.0-beta.0）：适用于 < below 的版本`);
  if (!s.why) errs.push(`${where} applies.why 缺失：写清从 below 起被测的东西为什么不存在了`);
  return errs;
}

/**
 * 判一条断言在给定包上适不适用。
 * @returns {{state:'applies'|'na'|'unknown'|'unscoped', scope?, version?}}
 */
export function judge(scope, build) {
  if (!scope) return { state: 'unscoped' };
  const v = build && build[scope.component];
  if (!v) return { state: 'unknown', scope };
  return { state: verCmp(v, scope.below) >= 0 ? 'na' : 'applies', scope, version: v };
}
