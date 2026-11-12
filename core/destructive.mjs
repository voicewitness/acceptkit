// 卸载、清数据：不是一律问人，也不是放开 —— 要给理由，由 acceptkit 按业务登记的理由来评估。
//
// 为什么这样分：装包覆盖安装不丢状态，闸过了就做；卸载、清数据会把登录态、首启状态、本地数据一起抹掉，
// 做错了这一轮的前提就变了，而且往往没法撤回。但「什么情况必须卸载」是业务自己清楚的事
// （例：签名不一致装不上、要验首次安装的引导），每次都问 owner 只会让他重复回答同一个问题。
// 所以：执行者自己清楚为什么要卸载，就由它把「什么情况、为什么必须、为了什么、现场证据特征」登记成理由（项目配置 gate.reasons）。
// owner 不逐条批理由（为什么要卸载，执行者自己应该清楚，不该把这个判断推回给 owner），acceptkit 替他把关两处：
//   登记时 —— 理由写全、情况具体、证据特征不是什么都能匹配（config-edit reasonItem）；
//   过闸时 —— 点名的理由覆盖这个动作、现场写清、证据里真有那个特征。理由和每次用它的现场都记进运行，报告 / 看板里 owner 事后看得到。
// 登记的理由都不覆盖、又说不出新理由时，才问 owner。

export const DESTRUCTIVE_KINDS = { uninstall: '卸载', clear: '清数据' };
const SAYS = { uninstall: /卸载|uninstall/i, clear: /清数据|清空数据|清除数据|pm\s+clear|clear[\s-]*data|抹掉|erase/i };

/** 动作是不是卸载 / 清数据：显式 --destructive 优先，否则按动作描述认 */
// 否定的说法不算（「覆盖安装不卸载」「without uninstall」）：先去掉再认。认漏了也放不过真卸载 ——
// 钩子 H1 按实际命令认卸载 / 清数据，只放行带 destructive 理由的闸（hooks.mjs guard_device）
const NEGATED = /(不|无需|不用|不必|没有|没|别|未|免|勿|without|no|not|don't|never)\s*(要|用|需要?|必|会)?\s*(卸载|清数据|清空数据|清除数据|抹掉|uninstall(ing)?|clear(ing)?[\s-]*data|erase)/gi;
export const destructiveKind = (action, explicit) => {
  if (explicit) return explicit;
  const t = String(action || '').replace(NEGATED, '');
  return Object.keys(SAYS).find(k => SAYS[k].test(t)) || null;
};

/**
 * 评估一次卸载 / 清数据的理由 → { ok: true, record } | { ok: false, why: [行] }
 *   reasons   项目登记的理由（gate.reasons）
 *   caseNeeds 本 run 用例里写了 requires_uninstall 的断言：[{ id, why }]（用例经过评审单批准，算业务登记过的理由）
 *   opt       { reason, why, evidenceText, approvedBy, quote }
 */
export function judgeDestructive(kind, { reasons = [], caseNeeds = [], opt = {} }) {
  const label = DESTRUCTIVE_KINDS[kind];
  if (!label) return { ok: false, why: [`--destructive 只能是 ${Object.keys(DESTRUCTIVE_KINDS).join(' / ')}`] };
  // owner 当场同意（理由表里没有这种情况）：记下他的原话
  if (opt.approvedBy || opt.quote) {
    if (!opt.approvedBy || !String(opt.quote || '').trim()) return { ok: false, why: ['owner 同意要同时写 --approved-by <他> 和 --quote "<他的原话>"'] };
    return { ok: true, record: { kind, by: 'owner', approved_by: opt.approvedBy, quote: opt.quote, why: opt.why || '' } };
  }
  const situ = String(opt.why || '').trim();
  const fail = (...lines) => ({ ok: false, why: [...lines, ...menu(kind, reasons, caseNeeds)] });
  if (!opt.reason) return fail(`${label}要给理由：--reason <登记的理由 id> --why "<现在是什么情况>"`);
  if (situ.length < 8) return fail(`--why 要写清现场（现在是什么情况、为什么非${label}不可），这一句会进记录给 owner 看`);
  if (opt.reason === 'case') {
    if (kind !== 'uninstall' || !caseNeeds.length) return fail(`用例里没有写 requires_uninstall 的断言，不能拿用例当${label}的理由`);
    return { ok: true, record: { kind, by: 'case', reason: 'case', expects: caseNeeds.map(x => x.id), case_why: caseNeeds.map(x => x.why).filter(Boolean).join('；'), why: situ } };
  }
  const r = reasons.find(x => x.id === opt.reason);
  if (!r) return fail(`项目里没有登记理由 ${opt.reason}`);
  if (!(r.actions || []).includes(kind)) return fail(`理由 ${r.id} 只覆盖 ${(r.actions || []).map(a => DESTRUCTIVE_KINDS[a] || a).join(' / ')}，不覆盖${label}`);
  if (r.evidence) {
    if (!opt.evidenceText) return fail(`理由 ${r.id} 要求现场证据（里面要出现 /${r.evidence}/）：--evidence <文件，例如装包失败的原始输出>`);
    if (!new RegExp(r.evidence).test(opt.evidenceText)) return fail(`--evidence 里没有理由 ${r.id} 要求的 /${r.evidence}/ —— 现场不是这种情况`);
  }
  return { ok: true, record: { kind, by: 'reason', reason: r.id, when: r.when, purpose: r.purpose, why: situ } };
}

function menu(kind, reasons, caseNeeds) {
  const fit = reasons.filter(r => (r.actions || []).includes(kind));
  return [
    fit.length ? `   项目登记的理由（${DESTRUCTIVE_KINDS[kind]}）：` : `   项目还没登记任何${DESTRUCTIVE_KINDS[kind]}的理由。`,
    ...fit.map(r => `     ${r.id}：${r.when} → ${r.why}（为了 ${r.purpose}）${r.evidence ? ` 要证据 /${r.evidence}/` : ''}`),
    ...(kind === 'uninstall' && caseNeeds.length ? [`     case：用例要求全新安装（${caseNeeds.map(x => x.id).join(' ')}）`] : []),
    `   都不适用：先找不${DESTRUCTIVE_KINDS[kind]}的办法（只要某个状态，就在 app 里改状态再冷启）；`,
    `   确实要做、而且说得出为什么：把这种情况登记成理由再过闸 —— acceptkit config add gate.reasons --json '{"id":…,"actions":["${kind}"],"when":"<具体情况>","why":"<为什么非这样不可>","purpose":"<为了什么>","evidence":"<现场原始输出里会出现的字样>","by":"<你>"}'`,
    `   说不出理由、或者拿不准会丢掉什么：问 owner（现场、要${DESTRUCTIVE_KINDS[kind]}什么、会丢掉什么），他同意后加 --approved-by <他> --quote "<原话>" 过闸`,
  ];
}
