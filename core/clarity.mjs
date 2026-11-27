// 用例清不清晰：人照着能不能做出来、能不能看出结论。
// AI 写的新用例一开始可以不清晰（还不知道页面长什么样），但 AI 跑过一次以后，必须变成清晰的用例，或者判定不可执行 ——
// 这是 acceptkit 的职责：用例状态由工具算，跑过还不清晰的，next 出卡（附上这次执行实际做了什么），再开跑之前要先改。
//
// 清晰 = 每一步都说得出「在哪一页点什么、输入什么，或跑哪条命令」（挂了带人看步骤的操作也算）；
//        每条机判的预期都说得出人怎么看（预期上写 see，或观测用的操作带人看的步骤）。
// 不可执行 = 用例上写 unexecutable: { why }（例：这一步在真实世界里没有入口，见 finding Fx）。
import { walkSteps } from './input-source.mjs';

// 规则从这一刻起生效：之前跑过的不算「跑过还不清晰」（不然存量用例一夜之间全被卡住）
export const CLARITY_SINCE = '2026-11-25T16:00:00Z';
export const CONCRETE_STEP = /(点击|点按|点|长按|双击|输入|填|进入|打开|切到|切换到|滑动|滑到|返回|退出|选择|勾选|冷启动|重启|安装|卸载|运行|执行|发送|访问|登录|等待)[^。；\n]{0,12}([「『“"'‘][^」』”"'’]{1,40}[」』”"'’])|^(冷启动|等待\s*\d+\s*(s|秒|分钟)|返回桌面|杀进程)$/;
// 步骤里写着命令（反引号、adb / shell / am start …）：那是机器做法，人读不懂；进操作集，步骤只写人话
export const RAW_COMMAND = /`[^`]{6,}`|\badb\s+(shell|install|push|pull)\b|\bam\s+start\b|\b(python3?|node|bash)\s+\S+\.(py|mjs|js|sh)\b/;
export const STRUCT_IN_TEXT = /\{\s*"[^"]+"\s*:/;
export const commandOf = t => (String(t).match(/`([^`]{6,})`/) || [])[1] || (String(t).match(/\b(adb\s+[^，。；`]+|am\s+start[^，。；`]+)/) || [])[1] || null;
// 没填的模板：{…} 里有空值（"k": "" / k=、），或参数值为空 —— 形状上像在输入，其实什么都没给
const EMPTY_SLOT = /\{[^{}]*(:\s*""|=\s*[,、}])[^{}]*\}/;
export const emptySlots = n => EMPTY_SLOT.test(String(n.op || '')) || Object.values(n.params || {}).some(v => v === '' || v == null);
/** 一个操作的人看步骤：自己写了就用；没写、步骤是引用别的操作（{ use }）的，层层展开成被引用操作的人看步骤（防环） */
export function expandHuman(ops, id, seen = new Set(), platform = null) {
  if (!id || seen.has(id)) return []; seen.add(id);
  const o = ops?.[id]; if (!o) return [];
  const ph = platform ? (o.platforms?.[platform]?.human || Object.entries(o.platforms || {}).find(([k]) => k.split('@')[0] === platform)?.[1]?.human) : null;
  const own = [].concat(ph || []).filter(Boolean).length ? [].concat(ph) : [].concat(o.human || []);
  if (own.filter(Boolean).length) return expandRefs(ops, own.filter(Boolean), seen, platform);
  const steps = Object.values(o.platforms || {}).find(r => Array.isArray(r?.steps))?.steps || [];
  const uses = steps.filter(s => s && typeof s === 'object' && s.use);
  return uses.length ? uses.flatMap(s => expandHuman(ops, s.use, seen, platform)) : [];
}
export const REF_LINE = /^@([a-z0-9][a-z0-9-]*)$/;
/** 一组人看步骤里的 @<操作> 展开成那个操作的人看步骤（防环） */
export function expandRefs(ops, lines, seen = new Set(), platform = null) {
  return lines.flatMap(l => { const m = REF_LINE.exec(String(l).trim()); return m ? expandHuman(ops, m[1], new Set(seen), platform) : [l]; });
}
// 「打开 / 进入「X」页」却没说怎么进去：要么这一行是 @<操作>（那个操作知道怎么打开），要么同一行 / 上一行说清从哪点进去
const NAV = /(打开|进入)[^，。；]{0,20}页/;
export function vagueNav(lines) {
  for (let i = 0; i < lines.length; i++) {
    const l = String(lines[i]), prev = String(lines[i - 1] || '');
    if (REF_LINE.test(l.trim()) || !NAV.test(l)) continue;
    if (/点击「|点「|从「/.test(l) || REF_LINE.test(prev.trim()) || /点击「|点「/.test(prev)) continue;
    return l;
  }
  return null;
}
const humanOf = (ops, id, platform = null) => expandHuman(ops, id, new Set(), platform);

// 「看」的步骤只点了要找的对象，没说在页面上看哪里：「看「app2app_report」的执行路径」里括起来的是参数值（unit 名），
// 不是页面上读得到的字；执行路径在页面上叫什么（path=）、在哪一行，读的人还是不知道（2026-11-25 owner：「怎么看执行路径呢」）。
// 只按形状认：括号里全是这条观测的参数值或 {param.x}、也没写「字段=」，就算没说看哪里；一个括号都没有的「看」也算
const LOOK = /(看|核对|检查|确认|读)/, ACT = /(点击|点开|点按|长按|输入|填入|滑到)/;
const QUOTED = /[「『“"'‘]([^」』”"'’]{1,40})[」』”"'’]/g, FIELD = /[A-Za-z_][\w.]*=/;
/** → null（说得出看哪里）| { entity: [k, v] | null }（只点了对象 / 什么都没点） */
export function lookWithoutLocator(line, params = {}, prev = '') {
  const l = String(line);
  if (REF_LINE.test(l.trim()) || !LOOK.test(l) || ACT.test(l)) return null;
  // 上一步已经定位到那一行（「找到「X」这一行」），这一步说「这一行 …」：算说了看哪里
  if (/(这|该|同)一?(行|列|格|栏)/.test(l) && /(行|列|格|栏)/.test(String(prev)) && [...String(prev).matchAll(QUOTED)].length && !LOOK.test(String(prev))) return null;
  if (FIELD.test(l.replace(/\{param\.\w+\}/g, ''))) return null;
  const byVal = new Map(Object.entries(params || {}).filter(([, v]) => typeof v === 'string' && v.trim()).map(([k, v]) => [v.trim(), k]));
  const qs = [...l.matchAll(QUOTED)].map(m => m[1].trim());
  const ent = q => { const p = /^\{param\.(\w+)\}$/.exec(q); return p ? [p[1], q] : byVal.has(q) ? [byVal.get(q), q] : null; };
  if (qs.some(q => !ent(q))) return null;
  return { entity: qs.length ? ent(qs[0]) : null };
}
// 同一个看法别的用例也会用：找操作库里已有的读法操作（人看步骤用 {param.<k>}、而且每个「看」都说得出看哪里）
function readerOps(ops, k, platform, skip) {
  return Object.entries(ops || {}).filter(([id]) => id !== skip).filter(([id]) => {
    const own = [].concat(ops[id].platforms?.[platform]?.human || ops[id].human || []).map(String);
    return own.some(l => l.includes(`{param.${k}}`)) && own.some(l => LOOK.test(l)) && own.every((l, i) => !lookWithoutLocator(l, {}, own[i - 1]));
  }).map(([id]) => id).slice(0, 3);
}
function locatorMsg(line, hit, { ops, platform, op, fromOp }) {
  const [k, v] = hit.entity || [];
  const cands = k ? readerOps(ops, k, platform, op) : [];
  const where = fromOp ? `（来自操作 ${op} 的人看步骤，改操作：ops set ${op} --platform ${platform || '<平台>'} --human …）` : '';
  const reuse = cands.length ? `，或者直接引用读法操作 ${cands.map(x => '@' + x).join(' / ')}（参数由这条预期带入）`
    : k ? `；这个看法别的${k}也会用，建成一个带参数的读法操作（ops set <id> --human "在「…」一节找以「{param.${k}}」开头的那一行" --human "看这一行的「<字段>=」…"），用例里写 @<id>` : '';
  return `「${String(line).slice(0, 30)}${String(line).length > 30 ? '…' : ''}」${k ? `括起来的「${v}」是要找的对象（参数 ${k}），` : ''}没说在页面上看哪个字段、哪一行、怎样算对${where}：写出页面上读得到的字（例：「path=」「evaluated」）${reuse}`;
}

/** 人看的步骤：{param.x} 换成这一步 / 这条观测的参数 */
export function fillHuman(lines, params = {}) {
  return lines.map(l => String(l).replace(/\{param\.(\w+)\}/g, (m, k) => params[k] !== undefined ? String(params[k]) : m));
}

/** → { status: clear|unclear|unexecutable, steps: [{ at, msg }], expects: [{ at, msg }] } */
export function caseClarity(c, ops = {}) {
  if (c.unexecutable) return { status: 'unexecutable', why: String(c.unexecutable.why || c.unexecutable), steps: [], expects: [] };
  const steps = [], expects = [], plat = String(c.platform || '').split(/[,/]/)[0] || null;
  walkSteps(c.tree, ({ id, n }) => {
    const t = String(n.op || '');
    const viaOp = n.op_id && humanOf(ops, n.op_id, plat).length;
    // 纯分组节点（只是分支标题，动作在下面）：不查这一步写得具体不具体
    if (n.kind === 'group') { for (const e of n.expect || []) void e; }
    // 步骤文字里塞着一段 JSON（做法、条件、命令、判据 …）：那是机器的计划，不是人能照做的一步 —— 写的时候就拦
    if (n.kind === 'group') { /* 分支标题 */ }
    else if (STRUCT_IN_TEXT.test(t)) steps.push({ at: id, level: 'missing', msg: `「${t.slice(0, 30)}…」里塞着一段 JSON：人话写进这一步（做什么），要填的值写进 params，命令进操作集（--to-op），判据写进预期（see / say），解释写进 note` });
    else if (!viaOp && RAW_COMMAND.test(t)) steps.push({ at: id, level: 'vague', msg: `「${t.slice(0, 30)}${t.length > 30 ? '…' : ''}」里写着命令：命令是机器做法，进操作集（clarify --node ${id} --to-op <操作名> --human "打开「…」页"），步骤只写人话` });
    else if (emptySlots(n) || !t.trim()) steps.push({ at: id, level: 'missing', msg: `「${t.slice(0, 30)}${t.length > 30 ? '…' : ''}」里有没填的值（空字符串 / 空参数）：这一步其实什么都没输入` });
    else if (!viaOp && !CONCRETE_STEP.test(t)) steps.push({ at: id, level: 'vague', msg: `「${t.slice(0, 30)}${t.length > 30 ? '…' : ''}」说不出在哪一页点什么、输入什么或跑哪条命令${n.op_id ? `（挂的操作 ${n.op_id} 也没写人看的步骤）` : ''}` });
    for (const e of n.expect || []) {
      if (!e.observe || e.judge === 'human') continue;
      const see = [].concat(e.see || []);
      { const lines = see.length ? see : humanOf(ops, (e.observe.by ? Object.values(e.observe.by)[0] : e.observe)?.op, plat), bad = vagueNav(lines);
        if (bad) { expects.push({ at: e.id, level: 'vague', msg: `「${bad.slice(0, 30)}」没说怎么进到这一页：写成 @<操作>（那个操作知道怎么打开它），或写清从哪点进去` }); continue; }
        const b0 = e.observe.by ? Object.values(e.observe.by)[0] : e.observe;
        const loose = lines.map((l, i) => [l, lookWithoutLocator(l, b0?.params, lines[i - 1])]).find(([, h]) => h);
        if (loose) { expects.push({ at: e.id, level: 'vague', msg: locatorMsg(loose[0], loose[1], { ops, platform: plat, op: b0?.op, fromOp: !see.length }) }); continue; } }
      if (see.length) { if (!see.some(x => /[「『“"'‘][^」』”"'’]{1,40}[」』”"'’]/.test(x) || REF_LINE.test(String(x).trim()))) expects.push({ at: e.id, level: 'vague', msg: '操作步骤说不出具体看哪里（页名、那一行、按钮写在「」里）' }); continue; }
      const b = e.observe.by ? Object.values(e.observe.by)[0] : e.observe;
      if (!humanOf(ops, b?.op, plat).length) expects.push({ at: e.id, level: 'missing', msg: `没写操作步骤：写 see，先写大致的（进哪一页、看什么），跑过后再改准；或给观测操作 ${b?.op || ''} 补人看的步骤` });
    }
  });
  // 预期前面一个动作都没有（从根到它全是分组标题）：读的人只看到「打开某页看结果」，看不出是什么操作产生了这个结果
  //（例：发事件那一步挂在兄弟节点上，分组标题和它平级）—— 把分组挪到产生结果的那一步下面（clarify --node <分组> --move-under <那一步>）
  (function w(ns, p, acted) { (ns || []).forEach((n, i) => { const id = `${p}${i + 1}`, a = acted || n.kind !== 'group';
    if (!a) for (const e of n.expect || []) if (!expects.some(x => x.at === e.id)) expects.push({ at: e.id, level: 'missing', msg: `前面没有任何动作（${id} 和它上面全是分组标题）：看不出是哪一步操作产生了要看的结果 —— 把 ${id} 挪到产生结果的那一步下面：clarify <用例> --node ${id} --move-under <那一步>` });
    w(n.children, `${id}.`, a); }); })(c.tree, 'n', false);
  return { status: steps.length || expects.length ? 'unclear' : 'clear', steps, expects };
}

/** 这条用例在规则生效后跑出过结论没有（跑过就必须清晰） */
export function executedSince(runs) {
  return runs.some(r => (r.created_at || r.started_at || '') >= CLARITY_SINCE && Object.values(r.results || {}).some(v => v && v.status && v.status !== 'todo'));
}
export const CLARITY_LABEL = { clear: '清晰', unclear: '待澄清', unexecutable: '不可执行' };
