// finding 的「owner 读得懂、能拍板」检查。
//
// 为什么要有：owner 读不懂的 finding 定不了 ——
// 一上来是断言原文和代码标识（node_mode=3、**不命中（走 f 支）** ⇒ …），没讲为什么一定不命中，
// 没讲影响范围，也没讲这到底是产品 bug、设计缺陷还是用例自己的问题。读不懂就定不了。
// 所以 finding 除了 what/detail/decide 这些自由文本，还要回答 owner 拍板前必问的四件事，
// 并且这四件事要用人话写；代码标识、断言原文、文件路径只放 detail（技术细节，折叠显示）。

/** 这条 finding 到底是什么性质 —— 决定了 owner 该用什么心态看它 */
export const FINDING_KINDS = {
  product_bug: '产品缺陷（代码没按设计工作）',
  design_gap: '设计缺陷（按设计工作，但设计本身有问题 / 没考虑到）',
  spec_unclear: '需求没写清（行为怎样都说得通，要产品定）',
  test_defect: '用例或工具的问题（产品没问题，是测的方法错了）',
  env: '环境问题（设备 / 账号 / 网络 / 数据，不是产品也不是用例）',
};

// 人话区不该出现的东西：这些是给机器或写代码的人看的，owner 看到就卡住。
// 只查明显的几类，不追求完备 —— 漏掉的靠 owner 在页面上「看不懂，退回」兜底。
const JARGON = [
  [/[A-Za-z_][\w.-]*\/[\w./-]+\.(py|mjs|js|ts|json|swift|m|h|go|java|kt)\b/, '文件路径'],
  [/\b[a-z]+_[a-z_]+\s*=\s*\S/, '字段=值（如 node_mode=3）'],
  [/::/, '代码里的类型名（Xxx::Yyy）'],
  [/\*\*/, 'markdown 加粗记号（断言原文？）'],
  [/[⇒⟹]/, '推导箭头（断言原文？）'],
  [/\b(?!HTTPS?\b)[A-Z][A-Z_]{3,}\b/, '全大写常量名（ALWAYS 这类要先用人话解释，放到「为什么」里）'],
  [/\b(tree|raw|leaf|unit)\[/, '配置字段下标'],
  [/[有没无长带证]牙|牙齿/, '「有牙 / 没牙」这种黑话（直接说：功能坏了这条会不会失败）'],
];
const PLAIN_FIELDS = { what: '一句话', impact: '影响范围', options: '选项', recommend: '推荐' };

const optionText = o => typeof o === 'string' ? o : `${o.label || ''} ${o.effect || ''}`;

/** 返回问题列表（空 = 合格）。每条是一句给执行者看的、能照着改的话。 */
export function findingProblems(f) {
  const out = [];
  if (f.bounced && !(f.rewritten_at && f.rewritten_at > f.bounced.at))
    out.push(`owner 退回了：「${f.bounced.quote}」—— 照这句重写（acceptkit plan finding <D> --finding ${f.id} …）`);
  if (!f.kind || !FINDING_KINDS[f.kind]) out.push(`缺「性质」：--kind ${Object.keys(FINDING_KINDS).join('|')}`);
  if (!String(f.impact || '').trim()) out.push('缺「影响范围」：--impact "谁会碰到、线上用户受不受影响、多大面"');
  if (!String(f.why || '').trim()) out.push('缺「为什么」：--why "读懂这条要知道的那一件事，用人话讲（例：这类规则是无条件执行的，所以「不执行」那一支不存在）"');
  const opts = f.options || [];
  if (opts.length < 2) out.push('缺「选项」：至少两个 --option "做法 => 选它的后果"（「不处理」也是一个选项）');
  else if (opts.some(o => !String(o.effect || '').trim())) out.push('每个选项都要写后果：--option "做法 => 后果"');
  if (!String(f.recommend || '').trim()) out.push('缺「执行者推荐」：--recommend "选哪个、为什么"');
  if (String(f.what || '').length > 80) out.push(`「一句话」太长（${String(f.what).length} 字 > 80）：细节挪到 --detail`);
  for (const [k, label] of Object.entries(PLAIN_FIELDS)) {
    const v = k === 'options' ? opts.map(optionText).join('\n') : String(f[k] || '');
    for (const [re, what] of JARGON) if (re.test(v)) { out.push(`「${label}」里有${what}：「${v.match(re)[0]}」—— 换成人话，原文放 --detail`); break; }
  }
  return out;
}

/** "做法 => 后果" → {label, effect} */
export function parseOption(s) {
  const [label, ...rest] = String(s).split(/\s*=>\s*/);
  return { label: label.trim(), effect: rest.join(' => ').trim() };
}

/**
 * 阻塞项交给 owner 之前，要写成他能拍板的问题（与 finding 同一个标准）。
 * 为什么要有：以前直接把「解锁条件」摆给 owner ——「服务端把 X 挂进主配置的某个列表；判据=…」，
 * 那是写给执行者的待办，是陈述句；owner 读完不知道要他决定什么、有哪几种走法、各自什么后果。
 * 返回问题列表（空 = 合格）。
 */
export function blockerAskProblems(b) {
  const a = b.ask || {};
  const out = [];
  const q = String(a.question || '').trim();
  if (!q) out.push('缺「问题」：--ask "<要 owner 定什么 / 提供什么，写成一句问句>"');
  else {
    if (!/[？?]\s*$|要不要|是否|能不能|可不可以|选哪|哪个|还是/.test(q)) out.push(`「问题」读起来不是在问：「${q.slice(0, 40)}」—— 写成 owner 能回答的问句（例：「这 5 条策略本轮没放量，是等放量再测，还是本轮不测？」）`);
    if (q.length > 80) out.push(`「问题」太长（${q.length} 字 > 80）：判据、字段这些技术细节放 --unlock`);
  }
  if (!String(a.why || '').trim()) out.push('缺「为什么要问你」：--why-you "<执行者自己为什么解决不了：要谁的权限 / 只有你知道的信息 / 这是范围决定>"');
  const opts = a.options || [];
  if (opts.length < 2) out.push('缺「选项」：至少两个 --option "做法 => 选它的后果"（「本轮不测、报告里写明」也是一个选项）');
  else if (opts.some(o => !String(o.effect || '').trim())) out.push('每个选项都要写后果：--option "做法 => 后果"');
  if (!String(a.recommend || '').trim()) out.push('缺「执行者推荐」：--recommend "选哪个、为什么"');
  const plain = [q, ...opts.map(optionText), a.recommend || ''].join('\n');
  for (const [re, what] of JARGON) if (re.test(plain)) { out.push(`问题 / 选项 / 推荐里有${what}：「${plain.match(re)[0]}」—— 换成人话，技术细节放 --unlock`); break; }
  return out;
}
