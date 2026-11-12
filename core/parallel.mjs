// 一个需求同一平台只用一台设备。要第二台（双跑 / 多跑）必须给理由，acceptkit 核对过才放行。
//
// 为什么：同一需求的上一轮没收尾、还占着机器时，选设备会把它当成「别人在用」，转头去启动一台新的 ——
// 新机器上 app 没起、脚本还连着旧机器，结论被误记成 blocked，多开的模拟器还白吃 CPU（实测踩过）。
// 同一需求的机器上次怎么设置的、登录态和装的包都在那台上，接着用才对；换机或加机都要说清为什么。
//
// 能接受的理由（每种都有工具能核对的东西，不是写一句话就过）：
//   capability 这一轮要的能力 / 宿主，需求现在那台给不了 —— 工具按能力要求核对那台
//   case       用例本身写了要多台（parallel_devices.why，用例过了评审）
//   owner      owner 明确要求双跑 —— 记他是谁、原话

export const PARALLEL_KINDS = { capability: '需求现有那台给不了这一轮要的能力', case: '用例写明要多台设备', owner: 'owner 明确要求双跑' };

/**
 * → { ok: true, record } | { ok: false, why: [行] }
 *   kind / why / approvedBy / quote  执行者给的
 *   current   需求现在占着的那台：{ key, run, unfit: [这一轮用不了它的原因] }
 *   caseDecl  用例的 parallel_devices（没有就 null）
 */
export function judgeParallel({ kind, why, approvedBy, quote, current, caseDecl }) {
  const situ = String(why || '').trim();
  const head = `需求已经在 ${current.key} 上跑（run ${current.run}）。一个需求同一平台只用一台，要第二台得给理由：`;
  const menu = Object.entries(PARALLEL_KINDS).map(([k, v]) => `   --parallel ${k}：${v}`);
  const fail = (...lines) => ({ ok: false, why: [head, ...lines, ...menu, `   不需要第二台：不带 --parallel，acquire 会从 run ${current.run} 接过 ${current.key}`] });
  if (!PARALLEL_KINDS[kind]) return fail(kind ? `不认识的理由类型 ${kind}` : '没给 --parallel <理由类型>');
  if (situ.length < 8) return fail('--why 要写清为什么非要第二台（这一句进运行记录，owner 在报告里看得到）');
  const base = { kind, why: situ, with: current.key, with_run: current.run, at: new Date().toISOString() };
  if (kind === 'capability') {
    if (!current.unfit.length) return fail(`${current.key} 满足这一轮的能力和宿主要求，用它就行，不能拿 capability 当理由`);
    return { ok: true, record: { ...base, unfit: current.unfit } };
  }
  if (kind === 'case') {
    const cw = String(caseDecl?.why || '').trim();
    if (cw.length < 8) return fail('用例没有写 parallel_devices.why（要多台的理由要写进用例、过评审），不能拿用例当理由');
    return { ok: true, record: { ...base, case_why: cw } };
  }
  if (!approvedBy || !String(quote || '').trim()) return fail('owner 要求双跑：要同时写 --approved-by <他> 和 --quote "<他的原话>"');
  return { ok: true, record: { ...base, approved_by: String(approvedBy), quote: String(quote) } };
}
