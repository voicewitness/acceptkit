// evidence-gate — 证据「有效性」机制（acceptkit 的共享模块）。
//
// 为什么有这个文件：
//   只做「存在性」检查的闸门 —— 有没有 --evidence、run 目录里有没有 png、有没有 json ——
//   从来不核「证据对不对」。于是这几类问题会全部被放行：
//     ① 一张排查时随手截的无关页面，被看板当成「现场截图」展示（它恰好满足了 no_visual 闸）；
//     ② 用例 machine 规格写的是观测点 A，实际取证用的是观测点 B —— 规格与执行漂移；
//     ③ 标题主张「→ 产出某 action」，却没有任何断言去验策略真的产出了 action；
//     ④ 以上都要**全部跑完**才被发现 —— 复核只发生在收口，发现时已经在向人汇报了。
//   本模块把三件事做成机制：
//     A. record 当下的机器校验（证据存在、--quote 原文在证据里找得到、大文件预警）
//     B. 每份证据一个复核状态（pending → ok / 驳回），驳回即把断言退回 todo —— 有证据就能复核，不等收口
//     C. observe：断言自己声明「怎么观测、取哪个值、什么算 pass」，由工具执行、存原文、按谓词判
//        —— 结果性证据由机制产出，而不是人拿一段输出去「解释」成 pass
//     D. 装置故障：上面三件全在「证据 ↔ 断言」这一个轴上，抓不到**取证手段自己坏了**（见 D 节）
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { BLANK_HINT } from './shot-check.mjs';
import { recipeFor } from './ops.mjs';
import { claimList, uncoveredClaims, DEFAULT_CLAIM_WORDS } from './claims.mjs';

export const isImage = x => /\.(png|jpe?g)$/i.test(x);
export const isLocalEv = x => /^(shots|evidence)\//.test(x);
const isTextFile = x => /\.(txt|log|json|ndjson|md|csv)$/i.test(x);
// 探针脚本本身也常被挂成证据（它是「这个读数怎么来的」的唯一说明）。
// 它**不进** --quote 的比对语料：quote 要对的是读数，不是产出读数的那段代码 ——
// 否则在脚本里写一句期望字符串就能让 quote 通过。它只用来查「读数是不是写死的」。
export const isScriptFile = x => /\.(m?js|cjs|ts|py|sh|bash|rb)$/i.test(x);
export const INLINE_LIMIT = 400 * 1024;   // 与看板的 EV_INLINE_LIMIT 一致：超过就会被截断

// ───────────────────────── A. record 当下的机器校验 ─────────────────────────
// errors = 必须拒绝写入；warnings = 提示但放行
export function checkAtRecord({ dir, evidence, actual, quotes, allowLiteral }) {
  const errors = [], warnings = [];
  const texts = [];
  for (const x of evidence) {
    if (!isLocalEv(x)) continue;                          // api:/src: 这类引用型证据不落盘，不查
    const f = join(dir, x);
    if (!existsSync(f)) { errors.push(`证据文件不存在：${x}（路径按 run 目录解析）`); continue; }
    const sz = statSync(f).size;
    if (!sz) errors.push(`证据文件是空的：${x}`);
    if (isTextFile(x)) {
      if (sz > INLINE_LIMIT) warnings.push(`${x} 有 ${(sz / 1048576).toFixed(1)}MB，看板只内嵌前 400KB —— `
        + `关键行若不在开头，看的人点开也看不到。另存一份摘录（关键行 + 行号）一起挂上`);
      // 一份大 bundle 供多条断言共用时，盲审包只装得下前一段，这些断言会集体判 insufficient。
      // 超过盲审包上限的证据 = 盲审拿不到判定所需的后半截，所以在 record 时就拒绝。
      if (sz > PACKET_MAX) errors.push(`${x} 有 ${sz} 字符，超过盲审包上限 ${PACKET_MAX} —— `
        + `盲审只会看到前 ${PACKET_MAX} 字符并被要求判 insufficient。`
        + `拆成**逐条断言自足**的证据（一条断言一份，只放这条判定用得上的原文），不要一份大 bundle 供多条复用`);
      texts.push({ x, body: readFileSync(f, 'utf8') });
    }
    if (isScriptFile(x)) {
      // 真实事故：第一版探针写的是 say("installed", true) —— **字面量，不是函数返回值**。
      // 它造出一个假读数；盲审只看得到证据文件里的 installed=true，看不到脚本，永远发现不了。
      // 所以脚本一挂上来就查这一类形状，并要求探针打印「表达式原样 -> 它的值」。
      for (const l of literalReadings(readFileSync(f, 'utf8'))) {
        if (allowLiteral) { warnings.push(`${x}:${l.line} ${l.name}=${l.value} 是写死的字面量（已 --allow-literal 放行：${allowLiteral}）`); continue; }
        errors.push(`${x} 第 ${l.line} 行把读数写死了：\`${l.text}\` —— ${l.name} 的值是字面量，不是表达式的值。\n`
          + `     这会造出一个假读数，而盲审只看得到证据里的 ${l.name}=${l.value}，看不到这段脚本。\n`
          + `     探针要打印**表达式原样和它的值**（例：${l.name}=<表达式> -> <值>），复核才分得出「读出来的」和「写进去的」。\n`
          + `     确实是常量输入（配置 / 开关的入参，不是读数）：--allow-literal "<为什么它不是读数>"`);
      }
    }
  }
  // --quote：你在 actual 里声称的那个值，必须能在证据原文里逐字找到。找不到 = 证据不支撑结论。
  for (const q of quotes) {
    const hit = texts.find(t => t.body.includes(q));
    if (!hit) errors.push(`--quote 「${q}」在所挂的文本证据里一处都找不到 —— 证据不支撑这句结论`
      + (texts.length ? `（查过：${texts.map(t => t.x).join(', ')}）` : '（本条没有挂文本证据）'));
  }
  // 没给 --quote 时，抽 actual 里的 k=v 形态做软检查：找不到只提示（actual 常带人话改写）
  if (!quotes.length && actual && texts.length) {
    const toks = [...new Set((String(actual).match(/[A-Za-z_][\w.]*=[\w.\-'"[\]]+/g) || []))].slice(0, 12);
    const miss = toks.filter(t => !texts.some(x => x.body.includes(t)));
    if (miss.length) warnings.push(`actual 里的 ${miss.map(t => `「${t}」`).join(' ')} 在证据原文里没找到 `
      + `—— 若是改写过的，用 --quote 给出原文片段`);
  }
  return { errors, warnings };
}

// ───────────────────────── B. 复核状态 ─────────────────────────
// key = "<scope>::<evidence>"，scope = 断言 id 或 "step:<nodeId>"。
// 同一份文件挂在两条断言上是两次独立判断：「它能证明 A」与「它能证明 B」不是一回事。
export const VERDICTS = {
  ok:           '只看这份证据，能判出这条断言',
  irrelevant:   '证据与断言无关（例：登录页截图挂在决策断言上）',
  insufficient: '相关但不够判（缺关键字段 / 缺对照 / 被截断看不到）',
  contradicts:  '证据原文与 actual 的说法矛盾',
  overclaim:    '证据只支撑了更弱的结论，actual/断言说过头了',
  wrong_round:  '证据不属于本轮/本被测物（时间、构建、设备对不上）',
  // 下面两条不在「证据↔断言」轴上，是 D 节那两类噪音。没有它们时只能硬塞进 insufficient，语义是混的。
  apparatus_failure: '证据反映的是**取证手段自己**坏了（超时 / 连错设备 / 探针报错 / 抓的是上一轮的日志 / 落了空文件），不是被测物的行为',
  fabricated:        '证据里的读数看不出是**读出来的**：没有来源表达式/命令/原始输出，或它是脚本里写死的字面量',
};
export const rkey = (scope, ev) => `${scope}::${ev}`;

export function addPending(r, scope, evs) {
  r.reviews ??= {};
  const added = [];
  for (const ev of evs) {
    const k = rkey(scope, ev);
    if (!r.reviews[k]) { r.reviews[k] = { state: 'pending', at: new Date().toISOString() }; added.push(k); }
  }
  return added;
}

// 所有「应该有复核结论」的条目：pass/fail 断言上的证据 + 执行过的步骤证据。
// 历史 run 没有 reviews 字段 —— 没有记录一律按 pending 算，而不是按 ok 算。
// opts.any：连 todo/blocked 断言上的证据也列出 —— 回写复核时用。一条证据被驳回、断言退回 todo 后，
// 同一断言的其余证据仍要能记下复核结论（否则这些结论会写不进去）。
/**
 * 证据文件当前内容的指纹。文件不在 / 不是本地文件 → null（不参与失效判断）。
 * 图片带附带记录时是「图.记录」两段：记录也进盲审包，记录变了复核结论就作废。
 */
export function evFingerprint(dir, ev) {
  if (!dir || !isLocalEv(ev)) return null;
  const f = join(dir, ev);
  if (!existsSync(f)) return null;
  const sha = b => createHash('sha1').update(b).digest('hex');
  try {
    const sc = sidecarOf(dir, ev);
    return sha(readFileSync(f)).slice(0, 12) + (sc ? `.${sha(sc.raw).slice(0, 8)}` : '');
  } catch { return null; }
}
// 复核时记下的指纹是否仍对得上现在的内容。
// 兼容：图片指纹原来只有图一段。那时的盲审本来就没看到附带记录，图没变就照旧有效；
// 新结论一律记两段，所以这一支只服务升级前留下的复核，不会再产生新的。去掉它 = 升级后所有截图的复核集体作废。
export const fpCurrent = (recorded, now) => recorded === now
  || (!!recorded && !!now && !recorded.includes('.') && now.split('.')[0] === recorded);

export function reviewItems(r, opts = {}) {
  const out = [];
  const dir = opts.dir || r.run_dir || null;
  // 复核结论挂在「断言::证据路径」上，而**证据文件的内容是会变的**。
  //    按盲审意见补写证据后路径不变 —— 旧的驳回结论会原样挂着，看板显示「驳回未补」，
  //    而实际早就补了。反过来更危险：一份被判 ok 的证据被后来改过，
  //    那个 ok 会继续生效。**复核的对象是内容，不是路径。**
  const withRv = (key, ev) => {
    const rv = r.reviews?.[key];
    if (!rv) return { state: 'pending' };
    const now = evFingerprint(dir, ev);
    if (rv.fp && now && !fpCurrent(rv.fp, now)) {
      return { state: 'pending', stale_from: rv.state, stale_note: `证据内容在复核之后改过（${rv.fp} → ${now}），旧结论作废` };
    }
    return rv;
  };
  for (const [id, v] of Object.entries(r.results || {})) {
    if (!opts.any && v.status !== 'pass' && v.status !== 'fail') continue;
    for (const ev of v.evidence || []) out.push({ key: rkey(id, ev), scope: id, ev, rv: withRv(rkey(id, ev), ev) });
  }
  for (const [sid, s] of Object.entries(r.steps || {}))
    for (const ev of s.evidence || []) out.push({ key: rkey(`step:${sid}`, ev), scope: `step:${sid}`, ev, rv: withRv(rkey(`step:${sid}`, ev), ev) });
  return out;
}
export function reviewGaps(r, dir = null) {
  const items = reviewItems(r, { dir });
  return {
    pending: items.filter(i => i.rv.state === 'pending').map(i => i.key),
    rejected: items.filter(i => i.rv.state !== 'pending' && i.rv.state !== 'ok').map(i => `${i.key}(${i.rv.state})`),
    selfOnly: items.filter(i => i.rv.state === 'ok' && i.rv.by === 'self').map(i => i.key),
  };
}

// 驳回即反馈：断言退回 todo，驳回理由进 finding —— 看板/status 上立刻可见，不等收口
export function applyReview(r, key, verdict, note, by, opts = {}) {
  if (!VERDICTS[verdict]) throw new Error(`--verdict 取值：${Object.keys(VERDICTS).join('|')}`);
  const [scope] = key.split('::');
  r.reviews ??= {};
  r.reviews[key] = { state: verdict, note: note || '', by: by || 'unknown', at: new Date().toISOString(), fp: opts.fp || null,
    ...(opts.claims ? { claims: opts.claims, claims_checked: true } : {}) };
  // 盲审判「这是装置坏了 / 这个读数看不出来源」时，结论本身就是一条装置故障记录 ——
  // 顺手进台账，report 的「本轮装置故障」才数得出真实次数（靠执行者自己回头补登记是不会发生的）。
  if (verdict === 'apparatus_failure' || verdict === 'fabricated')
    logApparatus(r, { where: scope, ev: key.split('::').slice(1).join('::'), text: note || VERDICTS[verdict], source: 'review', verdict, by: by || 'unknown' });
  let reverted = null;
  if (verdict !== 'ok' && !scope.startsWith('step:')) {
    const v = r.results?.[scope];
    if (v && (v.status === 'pass' || v.status === 'fail')) {
      reverted = v.status;
      v.status = 'todo';
      v.reverted_from = reverted;   // 执行者补齐后恢复同一判定时，其它未被驳回的复核仍然有效
      v.finding = [v.finding, `🔎 证据被驳回（${verdict}：${note || VERDICTS[verdict]}）→ 原判 ${reverted} 已退回 todo`].filter(Boolean).join('；');
    }
  }
  return { reverted };
}

// 盲审包：只给断言 + 证据本身，不给执行者的叙述之外的东西。审的人要能不问任何问题就下结论。
/** 盲审包里证据原文的上限。超了就明说必须判 insufficient（见 reviewPacket 内注释）。 */
export const PACKET_MAX = 60000;

/** 盲审要逐条核的主张：两条以上才要求逐条回答（一句话一件事的断言照旧整体判） */
export function reviewClaims(e, words = DEFAULT_CLAIM_WORDS) {
  const list = e?.assert ? claimList(e.assert, words, e.claims_off) : [];
  return list.length >= 2 ? list.map((text, i) => ({ id: `C${i + 1}`, text })) : [];
}
export function reviewPacket({ key, c, r, dir, expectOf, nodeOf, words = DEFAULT_CLAIM_WORDS }) {
  const [scope, ev] = key.split('::');
  const isStep = scope.startsWith('step:');
  const e = isStep ? null : expectOf(scope);
  const n = isStep ? nodeOf(scope.slice(5)) : null;
  const v = isStep ? null : r.results?.[scope];
  const f = isLocalEv(ev) ? join(dir, ev) : null;
  let body = '';
  if (f && existsSync(f) && !isImage(ev)) {
    const t = readFileSync(f, 'utf8');
    // 上限太小时，一份含多个分支的 bundle 会被切在第一个分支，盲审看到的是「只跑了一个分支」，
    //    相关断言集体判 insufficient —— 而那些分支**是真跑过的**。
    //    截断不是省 token，是把有效证据变成无效证据。两条修法一起上：
    //      ① 上限提到 PACKET_MAX，够装一份自足的 bundle；
    //      ② 真的超了就**明说必须判 insufficient**，不让盲审拿半截原文去猜。
    body = t.length > PACKET_MAX
      ? t.slice(0, PACKET_MAX) + `\n\n🔴🔴 原文被截断：共 ${t.length} 字符，上面只有前 ${PACKET_MAX}。`
        + `\n本条**必须判 insufficient**，理由写「证据超长被截断，盲审只看到前 ${PACKET_MAX} 字符」——`
        + `\n不要拿半截原文去推断后面有什么。全文在 ${f}，但复核人不应去读它：`
        + `\n一份需要跳出包外才能读全的证据，本身就不合格，该由执行者拆成逐条自足的证据。`
      : t;
  }
  return [
    `════ 证据复核 ${key} ════`,
    `用例：${c.title || c.case}`,
    isStep ? `操作节点：${scope.slice(5)} 「${n?.op || '?'}」（过程证据：这一步真的做了吗？）`
      : `断言 ${scope}：${e?.assert || '?'}`,
    e?.observe ? `观测规格：${fmtObserve(e.observe)}` : e?.machine ? `机判规格（文本）：${e.machine}` : '',
    v ? `执行者的判定：${v.status} —— ${v.actual || '（没写 actual）'}` : '',
    // 执行者的归类放进包里，第 ② 问才有对手：你是在核一个**已经下过的判断**。
    // 他说「被测物就是这样」而原文其实是装置坏了 —— 这正是要被驳回的那种。
    (isStep ? r.steps?.[scope.slice(5)] : v)?.failure_of
      ? `执行者的归类：这次失败是${(isStep ? r.steps[scope.slice(5)] : v).failure_of === 'apparatus' ? '**装置**（取证手段）' : '**被测物**'}的`
      : '',
    // 步骤的 note 就是执行者对这张过程图的说法 —— 不放进包，复核人判不了 overclaim（note 被改写后，包里也必须看得到新说法）
    isStep && r.steps?.[scope.slice(5)]?.note ? `执行者的说明：${r.steps[scope.slice(5)].note}` : '',
    `证据：${ev}${f ? `\n绝对路径：${f}` : ''}${isImage(ev) ? '\n（这是图片：必须打开看，不许凭文件名判断）' : ''}`,
    f && isImage(ev) ? sidecarLines(dir, ev).join('\n') : '',
    body ? `── 证据原文 ──\n${body}\n── 原文完 ──` : '',
    ...(() => { const cl = isStep ? [] : reviewClaims(e, words); return cl.length ? [
      `── 主张清单（逐条核，判 ok 前每条都要在证据里找到）──`, ...cl.map(x => `  ${x.id}  ${x.text}`),
      // 作者声明不当效果的词：给审的人看见，原文读下来确实是效果的，照样按效果核（声明不能替断言收窄）
      ...[].concat(e?.claims_off || []).filter(x => x?.word).map(x => `  （作者声明「${x.word}」在这条里不是效果：${x.why}。原文读下来它就是效果的，照样当一条主张核）`),
      `  判 ok 时回写必须带 claims：[{"id":"C1","where":"证据第几行 / 截图哪一处"}, …]，每条都要有；`,
      `  有一条在证据里找不到（例：只看到判定里有 alert 这个动作名，没看到弹窗）⇒ 不能判 ok，判 insufficient，note 写是哪一条`,
    ] : []; })(),
    `请只凭上面的证据回答，给出一个 verdict：`,
    ...Object.entries(VERDICTS).map(([k, d]) => `  ${k.padEnd(18)} ${d}`),
    `并逐条核对：`,
    `  ① actual 里的数值能否在原文里逐字找到？结论是否超出证据？证据是否属于本轮被测物？`,
    // 下面两问是 D 节的两类噪音 —— 不明确问出来，它们会被塞进 insufficient，报告上读不出区别。
    `  ② 原文里出现的失败，是**被测物**的失败，还是**取证手段（装置）**的失败？`,
    `     装置的失败长这样：超时、目标进程不在、连错设备、找不到符号（含必然存在的那个）、`,
    `     抓到的是上一轮的日志、事后捞导致落了空文件、读数被自己的写操作污染。`,
    `     只要原文反映的是装置坏了 ⇒ 判 apparatus_failure（被测物压根没被验到，这不是 insufficient）。`,
    `  ③ 原文里的每个读数，是**读出来的**还是**写进去的**？`,
    `     看得到来源（表达式原样 / 命令 / 原始输出）才算读出来的；只看到一个结论值（如 installed=true）`,
    `     而看不出它从哪来 ⇒ 判 fabricated。`,
  ].filter(Boolean).join('\n');
}

// ── 截图的附带记录（sidecar）──
// 盲审多次驳回「看不出是哪个构建 / 什么时刻」，而这些事实就记在截图旁边，只是没进包。
// 两种命名并存：<图>.json（Android shot、observe 读值截图）与 <去扩展名>.json（iOS / Web shot），顺序同 imageKind。
// 只认带 kind 的 JSON：同目录下碰巧同名的别的 JSON 不算记录。
export function sidecarOf(dir, rel) {
  if (!dir || !isImage(rel)) return null;
  for (const sc of [rel + '.json', rel.replace(/\.(png|jpe?g)$/i, '.json')]) {
    const f = join(dir, sc);
    if (!existsSync(f)) continue;
    try {
      const raw = readFileSync(f), meta = JSON.parse(raw);
      if (meta && typeof meta.kind === 'string') return { rel: sc, raw, meta };
    } catch { /* 坏 sidecar 当没有 */ }
  }
  return null;
}

const SHOT_KIND_WORDS = {
  process_shot: '过程截图（acceptkit shot）', app_screenshot: '过程截图（acceptkit shot，旧版记录）',
  ui_observe: '读值截图（observe 的 UI 通道在读到值的那一刻截的）', card: '判定卡（文字排版成的图，不是 app 画面）',
};
const clip = (v, n = 300) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > n ? s.slice(0, n) + '…' : s; };
function fmtObscuringCheck(o) {
  if (!o) return '（没记）';
  if (o.unknown) return `没查成：${o.reason || '原因没记'}`;
  const hits = (o.hits || []).map(h => `${h.name}${h.matched_text ? `「${h.matched_text}」` : ''}`);
  if (hits.length) return `命中 ${hits.join('、')}`;
  return `无遮蔽层${o.scanned_nodes ? `（查了 ${o.scanned_nodes} 个节点）` : ''}${o.screen_check ? `；画面上的字没读到：${o.screen_check}` : ''}`;
}
function fmtShotChecks(ck) {
  const out = [];
  if (ck.blank) out.push(ck.blank.ratio >= BLANK_HINT ? `大部分是纯色 ${ck.blank.color}（占 ${Math.round(ck.blank.ratio * 100)}%${ck.blank.released_by ? `；${ck.blank.released_by === 'shows' ? '这一步该有的字' : '读到的值'}在图上认得出，按空页面放行` : ''}）`
    : `不是纯色画面（主色占 ${Math.round(ck.blank.ratio * 100)}%）`);
  else out.push('没做纯色检测（图解不开）');
  if (ck.similar_to) out.push(`和 ${ck.similar_to} 几乎一样`);
  if (ck.shows_missing?.length) out.push(`这一步应该出现的字没找到：「${ck.shows_missing.join('」「')}」`);
  out.push(`画面文字来自 ${{ hierarchy: '画面层级', ocr: 'OCR（会漏认）', none: '无（没读到）' }[ck.screen_text_source] || ck.screen_text_source || '（没记）'}`);
  if (ck.ocr_obscured?.length) out.push(`OCR 认出遮蔽层并已放行：${ck.ocr_obscured.map(x => `${x.name}「${x.matched_text}」`).join('、')}`);
  return out.join('；');
}

/** 盲审包里的「工具记录」一节：图片证据旁的附带记录，按固定格式渲染。 */
export function sidecarLines(dir, ev) {
  const sc = sidecarOf(dir, ev);
  if (!sc) return ['── 工具记录 ──', '没有工具记录：这张图不是工具截的，看不出是哪台设备、哪个包、什么时刻。', '── 记录完 ──'];
  const m = sc.meta, web = m.platform === 'web';
  const nv = v => (v === undefined || v === null || v === '') ? '（没记）' : String(v);
  return [
    `── 工具记录（${sc.rel}）──`,
    '这是工具截图时记下的事实，不是结论；仍必须打开图片看，核对画面和这些记录对得上。',
    `种类：${SHOT_KIND_WORDS[m.kind] || m.kind}`,
    web ? `浏览器：调试端口 ${nv(m.port)} · 页面 ${nv(m.url)}`
      : `设备：${nv(m.udid)}${m.platform ? ` · ${m.platform}` : ''} · 包 ${nv(m.bundle)} · 进程 ${nv(m.pid)}`,
    `时刻：${nv(m.at)}`,
    m.obscuring_check?.focus ? `前台窗口：${m.obscuring_check.focus}` : '',
    `画面标题：${nv(m.page_title_on_screen ?? m.page_title)}`,
    m.kind === 'card' ? '' : `遮蔽层检查：${fmtObscuringCheck(m.obscuring_check)}`,
    m.allow_obscured_reason ? `放行理由（执行者用 --allow-obscured 写的）：${m.allow_obscured_reason}` : '',
    m.checks ? `事中检测：${fmtShotChecks(m.checks)}` : '',
    m.checks?.screen_text_excerpt ? `画面文字摘录：${m.checks.screen_text_excerpt}` : '',
    m.texts_read !== undefined ? `读到的值：${clip(m.texts_read)}` : '',
    m.ocr_check ? `读值在截图上可见吗：${m.ocr_check.status}${m.ocr_check.offscreen?.length ? `（不在图上、已作废：${m.ocr_check.offscreen.join('、')}）` : ''}` : '',
    m.step || m.expect ? `截图时挂在：${[m.step && `步骤 ${m.step}`, m.expect && `断言 ${m.expect}`].filter(Boolean).join(' · ')}` : '',
    '── 记录完 ──',
  ].filter(Boolean);
}

// 孤儿图：run 目录里没被任何断言/步骤引用的图片。看板画廊不该展示它们 —— 没人为它们作过证。
// ── 图片的身份 ──
// 常见的无效截图：随机内容页、黑屏、登录页、文字卡片 —— 而真正有用的只有诊断页。根因是**断言的判据面不在屏幕上**，
// 于是"app 截图"只能拍当时屏幕上碰巧是什么。字符串匹配挡不住这个（找个恰好有那几个字的页面就能过）。
// 正解是把截图变成**观测的副产品**：`observe` 的 UI 通道导航到诊断页、读到值的那一刻截图，图与判定同一动作产出。
// 所以图分四种身份，只有前两种能挂在断言的证据位上：
//   ui_observe  observe 的 UI 通道产出（sidecar kind=ui_observe：读到了什么、页面标题、pid）
//   card        把文字排版成图的判定卡（sidecar kind=card，或 PNG 里带 acceptkit_card / 项目配置 evidence.cardMarkers 里的标记）
//   process     acceptkit shot 的过程截图（sidecar kind=process_shot；老名 app_screenshot）—— 只证明环境与页面，挂步骤
//   unverified  没有任何工具痕迹的图（手工 simctl/screencap）—— 不作证据
// 项目自己的出卡工具留下的标记（项目配置 evidence.cardMarkers）：由加载项目的入口调 setCardMarkers 告诉这里
let CARD_MARKERS = ['acceptkit_card'];
export const setCardMarkers = (extra = []) => { CARD_MARKERS = ['acceptkit_card', ...extra.map(String).filter(Boolean)]; };
export function imageKind(dir, rel) {
  if (!isImage(rel)) return null;
  const full = join(dir, rel);
  for (const sc of [full + '.json', full.replace(/\.(png|jpe?g)$/i, '.json')]) {
    if (!existsSync(sc)) continue;
    try {
      const m = JSON.parse(readFileSync(sc, 'utf8'));
      if (m.kind === 'ui_observe') return 'ui_observe';
      if (m.kind === 'card') return 'card';
      if (m.kind === 'process_shot' || m.kind === 'app_screenshot') return 'process';
    } catch { /* 坏 sidecar 当没有 */ }
  }
  try { const buf = readFileSync(full); if (CARD_MARKERS.some(m => buf.includes(Buffer.from(m)))) return 'card'; } catch { /* 文件不存在 */ }
  return 'unverified';
}
// ── 断言怎么验（像 QA 一样）──
// 默认在界面上验：证据是读到结论那一刻的 app 截图（observe 的 UI 通道截的；app 自带的调试页也算界面）。
// 只有用例里明确写了 via（log / diag / debugger / cli）和 why_not_ui（为什么界面上看不到）的断言，才用命令行手段验，
// 而且证据要由 observe 亲自采（跑登记在操作库里的配方）—— 执行者自己交来的文件只能参考：它证明不了是当场读出来的。
export const VIA_LABEL = { ui: '界面验证', log: '日志验证', diag: '诊断命令验证', debugger: '调试器验证', cli: '命令行验证' };
// 用例里每个节点都是 carrier=static（读源码、读构建产物，没有 app 画面可拍）：有效截图规则不管它。
// 判据面本来就没有界面，为过闸去截一张无关的 app 画面，等于造证据（owner 定过：缺图不是缺口）。record / observe / next / 看板共用这一份
export function staticOnlyCase(c) {
  const cs = new Set((c?.classifications?.carrier || []).map(String));
  const go = ns => (ns || []).forEach(n => { if (n.tags?.carrier) cs.add(String(n.tags.carrier)); go(n.children); });
  go(c?.tree);
  return cs.size > 0 && [...cs].every(x => x === 'static');
}
// 某个运行的用例是不是纯静态（按运行结果里记的用例名去项目里读）
const staticMemo = new Map();
export function staticOnlyRun(root, res) {
  const name = res?.case_ref || res?.case; if (!name) return false;
  const k = `${root}::${name}`;
  if (!staticMemo.has(k)) { let c = null; for (const f of [join(root, String(name)), join(root, 'cases', `${name}.case.json`)]) { try { c = JSON.parse(readFileSync(f, 'utf8')); break; } catch { /* 引用可能是路径也可能是名字；用例删了就按不是静态 */ } } staticMemo.set(k, staticOnlyCase(c)); }
  return staticMemo.get(k);
}
export const viaOf = e => (e?.via && VIA_LABEL[e.via] ? e.via : 'ui');
// 界面上的断言要用界面通道读：只有 exec=ui / web 的配方会在读到值那一刻截图（ui_observe）。
// 用诊断 / 日志配方读，observe 重跑多少次都补不上那张图 —— 执行者会在 evidence_gap 上空转。用例检查（Q21）和缺口卡片共用这一个判断。
const UI_EXECS = new Set(['ui', 'web']);
/** via=ui 的断言在某端的读法不是界面通道 → { op, exec } | null（没译、配方缺的交给别的检查） */
export function nonUiRead(e, platform, ops, host = null) {
  if (viaOf(e) !== 'ui' || !e?.observe) return null;
  const b = bindingOf(e.observe, platform);
  const hit = b?.op ? recipeFor(ops?.[b.op], platform, host) : null;
  if (!hit || hit.recipe.absent || !hit.recipe.exec || UI_EXECS.has(hit.recipe.exec)) return null;
  return { op: b.op, exec: hit.recipe.exec };
}
// 只是读 run 目录里现成文件的配方：文件是谁写的，工具不知道
const FILE_EXECS = new Set(['json-file', 'file-grep']);
const execOfObserved = (o, ops) => o?.exec || Object.values(ops?.[o?.op]?.platforms || {}).map(p => p?.exec).find(Boolean) || null;

/**
 * 每条 pass / fail 断言还缺什么证据 → { E1: ['no_evidence' | 'no_ui_shot' | 'not_tool_collected'] }。
 * 报告的证据缺口、看板的计数（缺证据的 pass 显示成「证据不全」、不算通过）、next 的卡片（让执行者重试）都调这一份 ——
 * 以前报告按一套规则算缺口，看板和计数只看记下的状态，于是同一条断言一边是缺口、一边是「通过」。
 * expects：用例里的断言定义（读 via）；ops：操作库（认 observe 用的配方是不是只读现成文件）。
 * 迁移前的运行按当时的规矩记的证据，不追溯这两条要求（与报告同口径）。
 */
export function assertionGaps(dir, res, { expects = [], ops = {}, words = DEFAULT_CLAIM_WORDS } = {}) {
  const out = {};
  const legacy = !!res?.demand?.migrated;
  const def = new Map((expects || []).map(e => [e.id, e]));
  for (const [id, v] of Object.entries(res?.results || {})) {
    if (!['pass', 'fail'].includes(v?.status)) continue;
    const ev = v.evidence || [];
    const g = [];
    if (!ev.length) g.push('no_evidence');
    else if (!legacy && viaOf(def.get(id)) === 'ui') { if (!ev.some(x => imageKind(dir, x) === 'ui_observe')) g.push('no_ui_shot'); }
    else if (!legacy && (!v.observed || v.observed.offline || FILE_EXECS.has(execOfObserved(v.observed, ops)))) g.push('not_tool_collected');
    // 断言说的效果（弹窗 / 拦截 / 上报……）比观测读到的那一层宽，又没有盲审逐条核过主张：这条 pass 只证明了谓词。
    // 继承下来的 pass 也走这里 —— 缺口跟着证据走，不跟着轮次走。
    if (!legacy && v.status === 'pass' && ev.length && def.get(id)
        && uncoveredClaims(def.get(id), { ops, platform: res.platform, words, usedOp: v.observed?.op }).missing.length
        && !ev.some(x => { const rv = res.reviews?.[rkey(id, x)]; return rv?.state === 'ok' && rv.claims_checked; })) g.push('claims_uncovered');
    if (g.length) out[id] = g;
  }
  return out;
}
export const GAP_TEXT = {
  no_evidence: '没有任何证据',
  no_ui_shot: '界面上的断言，没有读到结论那一刻的 app 截图（acceptkit observe 的 UI 通道）',
  not_tool_collected: '声明了命令行验证，但证据不是 observe 亲自采的（读的是执行者交来的文件）',
  claims_uncovered: '断言说的效果（弹窗 / 拦截 / 上报……）观测没读到那一层，也没经盲审逐条核过：这条 pass 只证明了判定谓词',
};

// **文字排版成的卡片不是图片证据**：它只是把文字转成了图片，不证明任何东西。
//    所以 'card' 从这个集合里去掉了 —— 断言位上只认「真的拍到了那个判据面」的图：
//      · ui_observe = observe 的 UI 通道在读到值的那一刻截的设备屏；
//      · 真实设备截图（sidecar 标 kind=ui_observe 才算；手工截的判 unverified）。
//    判据面本来就没有 UI 的断言（运行时值 / 决策记录）⇒ **不该有图**，用文本原文，缺图不是缺口。
export const ASSERT_IMAGE_KINDS = new Set(['ui_observe']);
// 无效图：文字转图片的卡片。占着断言证据位就要被报出来删掉。
export const INVALID_ASSERT_IMAGE_KINDS = new Set(['card']);

export function orphanImages(dir, r) {
  const ref = new Set([
    ...Object.values(r.results || {}).flatMap(v => v.evidence || []),
    ...Object.values(r.steps || {}).flatMap(s => s.evidence || []),
    // 被新观测替换下来的旧证据记在 superseded 台账里 —— 有来历，不是孤儿（看板照样折叠留档，不当现场截图）
    ...Object.values(r.results || {}).flatMap(v => v.superseded || []),
    // 步骤上的 superseded 同理。漏了它会出现「从步骤上摘下来的图立刻变孤儿」这种两头堵
    // （例如把环境前提类截图从步骤证据位上摘下时）。
    ...Object.values(r.steps || {}).flatMap(s => s.superseded || []),
    // observe 没成的那几次（采样没抽中 / 通道失败）的截图记在 attempts 台账里 —— 有来历，不是孤儿
    ...Object.values(r.results || {}).flatMap(v => (v.attempts || []).map(a => a.shot).filter(Boolean)),
  ]);
  const out = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (isImage(e.name)) { const rel = p.slice(dir.length + 1); if (!ref.has(rel)) out.push(rel); }
  } };
  try { walk(dir); } catch { /* 目录不存在 */ }
  return out;
}

// 用例主张：c.claims = [{ text, proved_by: [断言 id] }]。标题/摘要里说出口的每句话都要有断言撑着，
// 且这些断言都 pass 并通过复核 —— 否则就是「标题说了、没人验过」。
export function claimGaps(c, r) {
  const out = [];
  for (const cl of c.claims || []) {
    const ids = cl.proved_by || [];
    if (!ids.length) { out.push(`「${cl.text}」没有 proved_by`); continue; }
    const bad = ids.filter(id => {
      const v = r.results?.[id];
      if (!v || v.status !== 'pass') return true;
      return (v.evidence || []).some(ev => (r.reviews?.[rkey(id, ev)]?.state || 'pending') !== 'ok');
    });
    if (bad.length) out.push(`「${cl.text}」未被证实：${bad.map(id => `${id}=${r.results?.[id]?.status || '?'}`).join(' ')}`);
  }
  return out;
}

// ───────────────────────── D. 装置故障（取证手段自己坏了） ─────────────────────────
// 为什么有这一节：A/B/C 审的都是「证据 ↔ 断言」对不对得上，六个 verdict 全在这一个轴上。
// 真跑一轮时还有一类噪音完全不在这个轴上 —— **取证手段自己坏了**：
//   连错了设备（两台在线时默认去了另一台）、探针顺序错了（恢复会停进程，而加载要求进程活着）、
//   日志抓的是上一轮被测物的缓冲区、改了开关又去读「有没有接管」于是读数被自己污染、
//   事后捞日志落了 0 字节、装了七次才装稳。
// 这些跟被测物没有任何关系，但会以两种方式混进结论：
//   ① 被当成「发现」写进汇报正文 —— 读报告的人以为被测物坏了；
//   ② 悄悄重试掉 —— 一轮折腾了八次装置故障，报告上一个字都看不到。
//      于是既读不出这份报告的可信度，也攒不出「基建该补什么」的清单。
// 机制分三处：
//   · record：actual / 步骤 note 命中装置故障词 ⇒ 必须显式分类（subject / apparatus）；
//             判成 apparatus 就**不许记 fail**（装置坏了 ⇒ 被测物没被证伪过）。
//   · review：verdict 多 apparatus_failure / fabricated，盲审被明确问「这是谁的失败」「读数从哪来」。
//   · report：单列「本轮装置故障」一节 + 进 MACHINE-READABLE。
// 🔴 台账**不计证据缺口、不改判定**：一旦装置故障会压低结论，隐瞒它就有了收益。
//    它只做两件事：给报告的可信度标价，给基建出清单。

// 词表只放跨项目通用的形状；项目自己的工具话术写进 acceptkit.project.json 的 apparatus.markers。
export const APPARATUS_MARKERS = [
  { re: /\btimed?\s?out\b|\btimeout\b|超时/i,                    why: '取证命令超时 —— 读数可能压根没取到' },
  { re: /\bnot running\b|\bno such process\b|进程(不在|没起)/i,    why: '目标进程不在 —— 多半连错了机器，或 app 没起来' },
  { re: /ClassNotFound|NoClassDefFound|NoSuchMethod|ModuleNotFound|AttributeError|undefined is not a function/i,
                                                                 why: '探针自己找不到符号 —— 先验阳性对照（拿必然存在的那个探一遍），别记成「被测物没有它」' },
  { re: /\bcommand not found\b|\bno such file\b|\bENOENT\b/i,    why: '工具链缺件 —— 装置没装好' },
  { re: /devices? (not found|offline|unauthorized)|more than one device|multiple devices/i,
                                                                 why: '设备不唯一或连不上 —— 读数可能来自另一台机器' },
  { re: /connection (refused|reset)|broken pipe|ECONNREFUSED|EPIPE/i, why: '通道断了' },
  { re: /permission denied|EACCES/i,                             why: '权限不够 ⇒ 是「没读到」，不是「读到了没有」' },
  { re: /(?<![\d.])0\s?(行|字节|bytes|lines)|空文件|empty (output|file)/i,
                                                                 why: '证据是空的 —— 抓取窗口不对（事后捞 / 环已经转过去了）' },
  { re: /install(ed)? (failed|failure)|安装失败|重装|装了\s?\d+\s?次/i, why: '装不稳 —— 这一轮有多少次是在跟安装较劲' },
];
/** 文本里命中的装置故障形状。extra = 项目词表 [{re|match, why}]。 */
export function apparatusHits(text, extra = []) {
  const t = String(text || '');
  if (!t) return [];
  const out = [];
  const all = [...APPARATUS_MARKERS, ...extra.map(x => ({ re: x.re instanceof RegExp ? x.re : new RegExp(x.re || x.match, 'i'), why: x.why || '项目词表' }))];
  for (const m of all) { const hit = t.match(m.re); if (hit) out.push({ marker: hit[0], why: m.why }); }
  return out;
}

// 「读出来的」vs「写进去的」：探针脚本里把一个具名读数报成字面量的两种形状。
// 只认这两种窄形状 —— 宁可漏，不要把正常代码判成造假（闸要能被信任）。
export function literalReadings(body) {
  const src = String(body);
  const out = [];
  const pats = [
    // say("installed", true) / report('hooked', False) —— 具名读数的值直接写死
    /\b[A-Za-z_]\w*\s*\(\s*(['"`])([\w .\u4e00-\u9fa5_.-]{1,40})\1\s*,\s*(true|false|True|False)\s*[,)]/g,
    // "installed=true" —— 把结论拼进字符串再打印
    /(['"`])([\w.-]{1,40})\s?=\s?(true|false|True|False)\1/g,
  ];
  for (const re of pats) for (const m of src.matchAll(re)) {
    const line = src.slice(0, m.index).split('\n').length;
    out.push({ line, name: m[2], value: m[3], text: m[0].trim() });
  }
  return out.sort((a, b) => a.line - b.line);
}

// 台账：只追加，同一处同一现象不重复记（record 常被重跑）。
export function logApparatus(r, e) {
  r.apparatus ??= [];
  const text = String(e.text || '').slice(0, 400);
  const dup = r.apparatus.find(x => x.where === e.where && x.text === text && x.source === e.source);
  if (dup) return dup.id;
  const id = `A${r.apparatus.length + 1}`;
  r.apparatus.push({ id, at: new Date().toISOString(), where: e.where || 'run', ...e, text });
  return id;
}

// ───────────────────────── C. observe：可执行的观测规格 ─────────────────────────
// 断言上的 observe：
//   { op: "<ops/registry.json 里 kind=observe 的 id>", params: {...},
//     guard:  { pick, predicate, why }   // 输入/阳性对照：不成立 ⇒ blocked（没法判），不是 fail
//     checks: [{ pick, predicate }]      // 全部成立 ⇒ pass，任一不成立 ⇒ fail
//   }
// pick 路径：点号分段；段尾可接 [*]（展开）、[k=v]（按字段过滤）、[n]（下标），可叠加。
//   例 data.decisions[*].evaluated[hit=true].unit_id
export function pick(obj, path) {
  let cur = [obj];
  // 切段时要跳过方括号内部：行 id 本身可能带点（`read.row[decision.count]`），
  // 直接 split('.') 会把它切成 `row[decision` + `count]` 两段，然后报「路径段不合法」。
  const segs = [];
  { let buf = '', depth = 0;
    for (const ch of String(path)) {
      if (ch === '[') depth++;
      else if (ch === ']') depth--;
      if (ch === '.' && depth === 0) { if (buf) segs.push(buf); buf = ''; }
      else buf += ch;
    }
    if (buf) segs.push(buf);
  }
  for (const seg of segs) {
    const m = /^([^[\]]*)((?:\[[^\]]*\])*)$/.exec(seg);
    if (!m) throw new Error(`pick 路径段不合法：${seg}`);
    const [, name, sels] = m;
    if (name) cur = cur.map(o => (o && typeof o === 'object') ? o[name] : undefined).filter(v => v !== undefined);
    for (const s of sels.match(/\[[^\]]*\]/g) || []) {
      const inner = s.slice(1, -1);
      if (inner === '*') cur = cur.flatMap(v => Array.isArray(v) ? v : (v && typeof v === 'object') ? Object.values(v) : []);
      else if (/^\d+$/.test(inner)) cur = cur.map(v => Array.isArray(v) ? v[+inner] : undefined).filter(v => v !== undefined);
      else if (inner.includes('=')) {
        const [k, want] = inner.split('=');
        cur = cur.flatMap(v => Array.isArray(v) ? v : [v]).filter(o => o && typeof o === 'object' && String(o[k]) === want);
      } else {
        // 字面 key 查找：`read.row[item.count]`。
        // 为什么需要：pick 按 `.` 切路径，而**被测物的行 id 本身可能带点**
        // （Android 诊断决策页的行就叫 `decision.count`）。写成 read.row.decision.count 会被切成
        // 四段、永远取不到，而且取不到的后果是空集 ⇒ 断言判成 fail/blocked，看起来像被测物坏了。
        // 这里原本直接抛「选择器不认识」，所以没有任何存量写法依赖它，加这一支是纯增量。
        cur = cur.map(o => (o && typeof o === 'object') ? o[inner] : undefined).filter(v => v !== undefined);
      }
    }
  }
  return cur;
}
const flatVals = V => V.flatMap(v => Array.isArray(v) ? v : [v]).filter(v => v !== null && v !== undefined && v !== '');
export const PREDICATES = {
  nonempty: (V) => flatVals(V).length > 0,
  empty:    (V) => flatVals(V).length === 0,
  eq:       (V, x) => V.length > 0 && V.every(v => String(v) === String(x)),
  any_eq:   (V, x) => flatVals(V).some(v => String(v) === String(x)),
  none_eq:  (V, x) => !flatVals(V).some(v => String(v) === String(x)),
  any_in:   (V, xs) => flatVals(V).some(v => xs.map(String).includes(String(v))),
  gt:       (V, n) => V.length > 0 && V.every(v => Number(v) > n),
  gte:      (V, n) => V.length > 0 && V.every(v => Number(v) >= n),
  count_gt: (V, n) => flatVals(V).length > n,
  any_match:  (V, re) => flatVals(V).some(v => new RegExp(re).test(String(v))),
  none_match: (V, re) => !flatVals(V).some(v => new RegExp(re).test(String(v))),
};
export function evalPredicate(V, pred) {
  const entries = Object.entries(pred || {});
  if (entries.length !== 1) throw new Error(`predicate 必须恰好一个键：${JSON.stringify(pred)}（可用：${Object.keys(PREDICATES).join(' ')}）`);
  const [k, x] = entries[0];
  if (!PREDICATES[k]) throw new Error(`predicate 不认识：${k}（可用：${Object.keys(PREDICATES).join(' ')}）`);
  return PREDICATES[k](V, x);
}
export const fmtPred = p => Object.entries(p || {}).map(([k, x]) => `${k}${x === true ? '' : ' ' + JSON.stringify(x)}`).join('');
// 前提可以有多条（guards: [...]）；老写法 guard: {...} 视为只有一条。逐条判，第一条不成立即 blocked。
// 例：一条断言既要「写入闸没被关过」，又要「第二段真的到达了」—— 只写一条，另一条缺席时会被误判成 fail。
/**
 * 一条断言 = **一个目的** + 各端的**翻译**。
 *
 * 问题：observe 规格原本把「判什么」和「怎么读」糊在一起，于是同一个目的在两端只能写成
 * 两条用例 —— 用例数随端数翻倍，而且「这两条是不是同一件事」没有任何机器判据，
 * 全靠人记。实测后果：一批 iOS 用例标 platform=both 之后，大部分断言在 Android 上
 * 恒读空集、判成 fail，看起来像产品坏了。
 *
 * 形状（向后兼容：没写 `by` 的照旧，存量用例一条都不用改）：
 *
 *     observe: {
 *       intent: "启动链路页说这次装配成功了",      // 目的，平台中立
 *       by: {
 *         ios:     { op, params, checks, guards },  // iOS 怎么读
 *         android: { op, params, checks, guards },  // Android 怎么读
 *       }
 *     }
 *
 * 规则：
 *  · 按 run 的平台取那一支；该平台没有写 → 这条断言在该平台 **na**（不是 fail、不是 blocked）；
 *  · 两支的 checks 谓词必须**同构**（见 [bindingsIsomorphic]）—— 只许 op/params/pick 不同。
 *    不设这道闸的话，「翻译」会悄悄变成「换了个判据」，而那是两件事，不是一件事的两种读法。
 */
export const bindingOf = (o, platform) => {
  if (!o || !o.by) return o;                       // 旧形状，原样
  const b = o.by[platform];
  if (!b) return null;                             // 该平台没译 → na
  return { ...b, intent: o.intent || '' };
};
export const hasBindings = o => !!(o && o.by);
export const bindingPlatforms = o => (o && o.by) ? Object.keys(o.by) : [];

/**
 * 两支「翻译」是不是同一件事：逐条比 checks 的**谓词**（类型与期望值），允许顺序不同。
 * 只比谓词，不比 pick/op/params —— 那三样本来就该不同，那正是「翻译」的含义。
 * guards 同理单独比：前提也必须是同一个前提，否则一端比另一端宽。
 */
export function bindingsIsomorphic(o) {
  const ps = bindingPlatforms(o);
  if (ps.length < 2) return [];
  // 比**形状**不比字面值：翻译时期望值本来就该不同
  // （iOS 页面写「已开启」，Android 同一件事写 `yes`；强求同值等于禁止翻译）。
  // 所以签名 = 谓词的**种类**，按出现顺序排。它能抓住的：
  //   · 一边判 3 件事、另一边判 2 件（漏译）
  //   · 一边 gt 另一边 empty（判的不是一回事）
  // 它抓不住的：两边都是 eq 但值一个对一个错 —— 那只能靠 intent 把目的写清 + 人读。
  // 不假装机器能判那个，但也不因此放弃能判的那部分。
  const kind = (pd) => Object.keys(pd || {}).sort().join('+') || '(空谓词)';
  const sig = (arr) => (arr || []).map(c => kind(c.predicate)).sort();
  const errs = [];
  const base = ps[0];
  const bc = sig(o.by[base].checks), bg = sig(guardsOf(o.by[base]));
  for (const p of ps.slice(1)) {
    const c = sig(o.by[p].checks), g = sig(guardsOf(o.by[p]));
    if (JSON.stringify(c) !== JSON.stringify(bc))
      errs.push(`${base} 与 ${p} 的判据形状不同构：${JSON.stringify(bc)} vs ${JSON.stringify(c)}`
        + ` —— 「翻译」只许换怎么读（op/params/pick）与期望值；`
        + `判几件事、每件用哪类谓词必须一致，否则就是两件事，该拆成两条断言`);
    if (JSON.stringify(g) !== JSON.stringify(bg))
      errs.push(`${base} 与 ${p} 的前提谓词不同构：${JSON.stringify(bg)} vs ${JSON.stringify(g)}`
        + ` —— 前提不一致等于一端比另一端宽，结论没有可比性`);
  }
  return errs;
}

export const guardsOf = o => [...(o.guard ? [o.guard] : []), ...(o.guards || [])];
export function fmtObserve(o) {
  const ps = o.params ? JSON.stringify(o.params) : '';
  // guard 带自己的 params 时必须显示出来 —— 否则读的人会以为前提和判定查的是同一份数据（盲审实测误读过）
  const g = guardsOf(o).map(x => ` ｜ 前提${x.params ? ` [另查 ${JSON.stringify(x.params)}]` : ''} ${x.pick} ${fmtPred(x.predicate)}`).join('');
  const cs = (o.checks || []).map(c => `${c.pick} ${fmtPred(c.predicate)}`).join(' 且 ');
  return `${o.op} ${ps}${g} ｜ 判定 ${cs}`;
}
export function validateObserve(o, where, ops) {
  // 一条断言一个目的、各端一份翻译。有 by 就逐支校验，并加同构闸。
  if (hasBindings(o)) {
    const errs = [];
    if (!o.intent) errs.push(`${where} observe 有 by 就必须写 intent（这条断言的目的，平台中立）`
      + ` —— 没有目的，两支就只是两段互不相干的读法，谁也说不清它们是不是同一件事`);
    const ps = bindingPlatforms(o);
    if (!ps.length) errs.push(`${where} observe.by 是空的`);
    for (const p of ps) errs.push(...validateObserve(o.by[p], `${where}[${p}]`, ops));
    errs.push(...bindingsIsomorphic(o).map(m => `${where} ${m}`));
    return errs;
  }
  const errs = [];
  if (!o.op) errs.push(`${where} observe 缺 op`);
  else if (ops && !ops[o.op]) errs.push(`${where} observe.op=${o.op} 不在 ops/registry.json`);
  else if (ops && ops[o.op].kind !== 'observe') errs.push(`${where} observe.op=${o.op} 不是 kind=observe 的操作`);
  if (!Array.isArray(o.checks) || !o.checks.length) errs.push(`${where} observe 缺 checks（至少一条 {pick,predicate}）`);
  for (const c of [...(o.checks || []), ...guardsOf(o)]) {
    if (!c.pick) errs.push(`${where} observe 有一条缺 pick`);
    if (c.op && ops && !ops[c.op]) errs.push(`${where} 前提的 op=${c.op} 不在 ops/registry.json`);
    try { evalPredicate([], c.predicate); } catch (e) { errs.push(`${where} ${e.message}`); }
    try { pick({}, c.pick || ''); } catch (e) { errs.push(`${where} ${e.message}`); }
  }
  return errs;
}

// 设备驱动工具的输出里常夹着「描述: {...}」和 logger 行 —— 按括号配对（跳过字符串内的括号）抠出第一个完整 JSON。
export function extractJSON(text) {
  const s = String(text);
  for (let i = s.indexOf('{'); i >= 0; i = s.indexOf('{', i + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < s.length; j++) {
      const ch = s[j];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        try { return JSON.parse(s.slice(i, j + 1)); } catch { break; }
      }
    }
  }
  return null;
}

// 这个 run 目录里由工具截的 app 画面（acceptkit shot 的过程截图 / observe UI 通道的读值截图），只认 sidecar。
// 手工 screencap、文字渲染的卡片都没有这类 sidecar，不算 —— 有效截图规则（record 闸、report 缺口、看板）共用这一个口径。
const APP_SHOT_KINDS = new Set(['app_screenshot', 'process_shot', 'ui_observe']);
export function appShotsIn(dir) {
  const out = [];
  const walk = d => { for (const e of readdirSync(d, { withFileTypes: true })) {
    const f = join(d, e.name);
    if (e.isDirectory()) walk(f);
    else if (/\.(png|jpe?g)\.json$/i.test(e.name) || /^app-\d+-.*\.json$/.test(e.name)) {
      try { const m = JSON.parse(readFileSync(f, 'utf8')); if (APP_SHOT_KINDS.has(m.kind)) out.push(m); } catch { /* 不是 sidecar */ }
    } } };
  try { walk(dir); } catch { /* 目录还没有 */ }
  return out;
}
