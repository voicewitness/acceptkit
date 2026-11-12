#!/usr/bin/env node
// acceptkit 引擎 — 用例 = 操作树(m叉) × 节点断言，融合两套成熟方法：
//   · 分类树法 (Classification Tree Method, Grochtmann/Grimm 1993) —— classifications/tags 给树打切面标签
//   · 步骤级预期结果 (step-wise expected result) —— 每个操作节点挂 ≥0 条 expect(断言)
// 数据：cases/<name>.case.json(用例树) → runs/<run>/result.json(执行结果) → runs/<run>/run.md(报告)
// 定位：每条断言唯一 id + 所在操作路径 A→B→C；证据挂到断言；bug 单直接吐"哪条路径的哪个预期挂了"。
// 内核不含领域知识：白名单、被测 App 特征、私有观测通道、领域命令都来自项目（见 project.mjs）。
import { parseUiDump, readPool } from './screen-read.mjs';
import { judgeParallel } from './parallel.mjs';
import { dropSplashIfPageIsUp } from './android-splash.mjs';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { spawnSync, execSync } from 'node:child_process';
import { join, dirname, resolve, sep, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
// 证据有效性机制（record 当下校验 / 逐份复核 / observe 机判）—— 见 evidence-gate.mjs 头注释
import { checkAtRecord, addPending, reviewItems, reviewGaps, applyReview, reviewPacket, orphanImages, evFingerprint, fpCurrent,
         claimGaps, VERDICTS, rkey, pick, evalPredicate, fmtPred, validateObserve, extractJSON, guardsOf,
         bindingOf, hasBindings, bindingPlatforms,
         apparatusHits, logApparatus } from './evidence-gate.mjs';
// 流水线闸（用例评审 / 阻塞当场上报 / 报告只讲过与不过）—— 见 plan-gate.mjs 头注释
import { loadPlan, savePlan, planPath, planCases, gateRun, checkPlan, caseFingerprints, driftedCases, approvedCases, planDelta,
         raiseBlocker, readBlockers, writeBlockers, unreportedFor, closeBlockersFor, scopeFingerprint } from './plan-gate.mjs';
// 平台适用性（声明 + 按操作库算）与需求登记表（需求↔用例的关系只在评审单里）
import { runAction } from './settings.mjs';
import { loadOps as loadOpsAt, opRecipe as opRecipeAt, doableOn } from './ops.mjs';
import { resolveHost, hostOfCase, caseHosts, hostApp, deviceHosts } from './hosts.mjs';
import { evaluate as qualityOf, formatFindings, standardSummary, QUESTIONS, checkCase } from './case-quality.mjs';
import * as AS from './assess.mjs';
import { PLATFORMS, RUNTIME_PLATFORMS, PLATFORM_LABEL, platformOfUdid, applicability, fmtApplicability, runtimePlatform, normalizePlatforms, platformValue } from './platform.mjs';
import { loadDemands, registerDemand, demandsReferencing, demandOfRun, allPlans, planCaseSet } from './demand-registry.mjs';
import { imageKind, ASSERT_IMAGE_KINDS, appShotsIn, setCardMarkers, assertionGaps, GAP_TEXT } from './evidence-gate.mjs';
import { findingProblems, parseOption, FINDING_KINDS, blockerAskProblems } from './finding-quality.mjs';
import { shotPlaybook, shotNudge } from './shot-guide.mjs';
import { decodePng, blankness, blankVerdict, judgeShot, BLANK_REFUSE } from './shot-check.mjs';
import { scopesOf, validateScope, parseBuild, judge } from './version-scope.mjs';
import { nextCards, carriedExpects } from './next.mjs';
import { destructiveKind, judgeDestructive, DESTRUCTIVE_KINDS } from './destructive.mjs';
import { buildContext, formatContext } from './context.mjs';
import { allEntries as allKnowledge } from './knowledge.mjs';
import { consultFor } from './evidence-consult.mjs';
import { formatCards, deviceCard as cardDevice, deviceAttentionCard as cardDeviceAttention, deviceNeededCard as cardDeviceNeeded,
         expectCard, stepCard, shotCard, shotSummary, findingStateCard, planStateCard, blockerStateCard, reportCard, reviewPackCard,
         reviewDueCard, rejectedCard } from './cards.mjs';
import { findDef, unknownFlags, pageText, pageList } from './protocol.mjs';
import { format } from 'node:util';
import { loadRounds, saveRounds, repoSnapshot, changedFiles, deriveHistory, resolveState, demandRecords, roundMembers } from './rounds.mjs';
import { loadProject, REPO_ROOT, readUserConfig } from './project.mjs';
import { loadLeases as dbLoadLeases, saveLeases as dbSaveLeases, LeaseConflict, recordApproval, loadQualityBaseline, saveAssessment, latestAssessment, upsertSuggestion, settleMissingSuggestions, decideSuggestion, setSuggestionRetro, listSuggestions, getSuggestion } from './store/db.mjs';
import { mask, maskDeep } from './secrets.mjs';
// Android 设备载体：身份（AVD 名）↔ 地址（adb serial）、状态五问、能力读取 —— 见 skill/devices.md
import * as ANDROID from '../adapters/android/device.mjs';
import { pickScreen, placeOn, applyDevicePref } from './display.mjs';

const PROJ = await loadProject();
setCardMarkers(PROJ.config.evidence?.cardMarkers);   // 项目自己的出卡工具标记（配置 evidence.cardMarkers）
if (!PROJ.root) { console.error('acceptkit: 找不到项目 —— 用 --project <dir>、环境变量 ACCEPTKIT_PROJECT，或在项目目录里运行（含 acceptkit.project.json）'); process.exit(1); }
const ROOT = PROJ.root;
const PACK = PROJ.pack;
const CFG = PROJ.config;
const CASES = join(ROOT, 'cases');
const RUNS = join(ROOT, 'runs');
// na = 版本不适用：用例本身没错，只是从某个组件版本起这条断言测的东西不存在了。
//      与 skip 一样不算失败/没跑，但必须带「组件@起始版本」，回归旧版本时照常跑。
const ICON = { pass: '✅', fail: '❌', blocked: '⛔', skip: '⏭️', na: '🚫', todo: '⬜' };
const STATUSES = Object.keys(ICON);

// ---- args ----
function parseArgs(argv) {
  const pos = []; const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      // --k=v：值可以以 -- 开头（原话可能就是这样写的）；看板转发用户原话一律用这个形式
      const eq = a.indexOf('=');
      const k = eq > 0 ? a.slice(2, eq) : a.slice(2);
      const v = eq > 0 ? a.slice(eq + 1) : (i + 1 < argv.length && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
      if (opt[k] === undefined) opt[k] = v;
      else opt[k] = [].concat(opt[k], v); // repeated flag → array
    } else pos.push(a);
  }
  return { pos, opt };
}
// 清单命令加 --json 时（JSON_MODE），拒收不直接退出而是抛出：批量命令按项接住，其余由分发处输出 {"refused":"…"}。
// 不加 --json 时照旧：打一句话到 stderr，退出码 1。
class Refused extends Error {}
let JSON_MODE = false;
const die = m => { if (JSON_MODE) throw new Refused(m); console.error('acceptkit: ' + m); process.exit(1); };

// 🔴 参数白名单：未知参数若被静默收下，命令照样报成功，而改动其实是空操作 ——
//    **静默忽略未知参数 = 让「我以为改了」和「真的改了」看起来一模一样。** 所以一律拒绝。
// decide 的 --by 是拍板的人；写成执行者自己就是自签（曾有执行者 decide --by executor 按默认落定）
const SELF_DECIDER = /^\s*(executor|agent|claude|codex|assistant|bot)\b|^\s*(执行者|自己|我\s*$)/i;
const KNOWN_FLAGS = new Set([
  'demand','demand-title','run','session','title','case','expect','status','actual','actual-file',
  'evidence','quote','reset-quotes','supersede','note','finding','step','blocked-kind','unlock','since',
  'review-note','by','verdict','item','next','all','list','count','regen-case','record','set','source',
  'raise','ack','answer','backfill','resolve','by-me','skip-plan-gate','id','text','what','detail','kind',
  'decide','severity','decision','platform','holder','take-over','sim','bundle','action','udid',
  'from-file','force','json','limit','offset','grep','yes','dry-run','try','parallel','prev','tag','why','desc',
  'surface','host','origin','demand-desc','allow-page','port','allow-obscured','include-probes','label',
  'reuse','new','ops','change','risk','covered','uncovered','cost','suggest','what','detail','settle',
  'pack','prune','apply','todo','reopen',
  // 装置故障（取证手段自己坏了）：分类 / 登记 / 字面量读数放行
  'failure-of','fix','where','allow-literal',
  // 执行者收口 finding（plan settle）
  'ref','undo',
  // finding 写给 owner 拍板的四件事（core/finding-quality.mjs）
  'impact','option','recommend',
  // 端上 run 记 fail 却拍不了 app 截图时的理由（有效截图规则）
  'allow-no-shot',
  // 需求执行轮
  'allow-stale-round','assess','reset','reset-why','inherit-all','round','repo',
  // 断言适用版本范围：被测包的组件版本
  'build',
  // 目标闸（租户 / 网址）与 web 载体
  'tenant', 'url', 'web',
  // 选设备的能力要求（device pick / acquire）
  'need', 'approved-by',
]);
// 平台不适用的 na 只由 observe 的平台分流写入。用 Symbol 做键：命令行解析只产出字符串键，
// 造不出它，所以手工 record 绕不过版本范围闸。
const PLATFORM_NA = Symbol('platform-na');
function rejectUnknownFlags(opt, extra = []) {
  const ok = new Set([...KNOWN_FLAGS, ...extra]);
  const bad = Object.keys(opt).filter(k => !ok.has(k));
  if (bad.length) die(`不认识这些参数：${bad.map(x => '--' + x).join(' ')}\n`
    + `   （静默忽略未知参数会让「更新」变成看不出来的空操作，所以一律拒绝。）`);
}
const asList = v => v === undefined ? [] : [].concat(v).flatMap(x => String(x).split(',')).map(s => s.trim()).filter(Boolean);

// ---- case load / tree walk ----
function casePath(name) {
  const p = name.endsWith('.case.json') ? name : join(CASES, `${name}.case.json`);
  if (existsSync(p)) return p;
  if (existsSync(name)) return name;
  // result.json 的 case_ref 存的是相对项目根的路径 —— 从别的 cwd 调（例：复核 hook）也要找得到
  const q = join(ROOT, name);
  return existsSync(q) ? q : p;
}
function loadCase(name) {
  const p = casePath(name);
  if (!existsSync(p)) die(`case not found: ${p}`);
  const c = JSON.parse(readFileSync(p, 'utf8'));
  c._path = p;
  return c;
}
// 用例不在 / 读不了就返回 null，给本来就按「没有用例」降级的调用方。不能写 try { loadCase } catch {}：
// 不加 --json 时 die 直接退出，加了 --json 时 die 抛 Refused 被 catch 吞掉 —— 同一输入两种行为（002：--json 只换输出）
function tryLoadCase(name) {
  if (!name || !existsSync(casePath(String(name)))) return null;
  try { return loadCase(String(name)); } catch { return null; }   // 文件在、JSON 坏了
}
// DFS：对每个节点回调 (node, path[], nodeId) —— path 是从根到该节点的 op 标签数组
// nodeId：按树位置生成的稳定编号（n1 / n1.1 / n1.2.3），用于把「过程证据」挂到操作节点本身。
function walk(nodes, cb, path = [], prefix = 'n') {
  (nodes || []).forEach((n, i) => {
    const here = [...path, n.op];
    const nodeId = `${prefix}${i + 1}`;
    cb(n, here, nodeId);
    if (n.children) walk(n.children, cb, here, `${nodeId}.`);
  });
}
// 所有操作节点（含 nodeId / op / path / 该节点的断言 id 列表）
function allNodes(c) {
  const out = [];
  walk(c.tree, (n, path, nodeId) => out.push({ nodeId, op: n.op, op_id: n.op_id, path, tags: n.tags || {}, shows: n.shows || [], expectIds: (n.expect || []).map(e => e.id) }));
  return out;
}
function allExpects(c) {
  const out = [];
  walk(c.tree, (n, path) => (n.expect || []).forEach(e => out.push({ ...e, op: n.op, path, tags: n.tags || {} })));
  return out;
}

// ---- validate ----

/**
 * 查重 —— 建新用例前必须先跑。
 *
 * 典型问题：先凭清单猜着建了一批用例，之后拿到权威数据源又建了一条覆盖同一批对象的用例。
 * 两套并存，看的人不知道该信哪个。根因是建之前没查「这块是不是已经有人测了」。
 *
 * 三种重叠各自的判据（都只报告，不自动删，因为「重复」和「互补」只有人能判）：
 *  1. 同一个被测对象被多个用例覆盖 —— 对象怎么认由项目配置 dup.objectKey 给（正则，捕获组拼成对象键）；不设就不查这一项；
 *  2. 标题高度相似 —— 去掉标点后的字符集重合度；
 *  3. 断言文本重复 —— 同一句 assert 出现在不同用例里。
 */
function dupCheck() {
  const all = readdirSync(CASES).filter(f => f.endsWith('.case.json'))
    .map(f => ({ f, c: JSON.parse(readFileSync(join(CASES, f), 'utf8')) }));
  // 被测对象怎么从用例里认出来、哪些断言是模板句式，都是项目知识：读项目配置，内核不写死任何一家的命名规范
  const objRe = CFG.dup?.objectKey ? new RegExp(CFG.dup.objectKey, 'gi') : null;
  const tplRe = CFG.dup?.templateAsserts ? new RegExp(CFG.dup.templateAsserts) : null;
  const byStrategy = new Map(); const asserts = new Map(); const titles = [];
  const walk = (ns, fn2) => (ns || []).forEach(n => { fn2(n); walk(n.children, fn2); });

  for (const { c } of all) {
    // 引用式用例集（有 includes）天生就与成员共享被测对象——那是设计，不是重复。
    if (Array.isArray(c.includes) && c.includes.length) continue;
    titles.push({ id: c.case, t: String(c.title || '') });
    walk(c.tree, n => {
      const blob = JSON.stringify([n.op, n.data || {}]);
      for (const m of objRe ? blob.matchAll(objRe) : []) {
        const k = m.slice(1).filter(Boolean).join(' ') || m[0];
        if (!byStrategy.has(k)) byStrategy.set(k, new Set());
        byStrategy.get(k).add(c.case);
      }
      for (const e of n.expect || []) {
        const a = String(e.assert || '').trim();
        if (a.length < 12) continue;
        if (!asserts.has(a)) asserts.set(a, new Set());
        asserts.get(a).add(c.case);
      }
    });
  }
  let n = 0;
  const s1 = [...byStrategy.entries()].filter(([, v]) => v.size > 1);
  if (s1.length) {
    console.log(`\n⚠️  同一个被测对象被多个用例覆盖（${s1.length} 处）—— 确认是互补还是重复：`);
    for (const [k, v] of s1.slice(0, 15)) console.log(`   ${k}  ←  ${[...v].join(' , ')}`);
    n += s1.length;
  }
  // 标题相似度：先把「模板词」剔掉再比。一批用例共用同一个标题句式时，用字符集重合度会把互不相干的用例两两报成重复——区分度恰恰在被判成
  // 「相同」的那几个字之外。所以统计每个 2-gram 在多少条标题里出现过，出现 ≥3 次的算模板，
  // 不参与比较。（第一版就是栽在这上面，留着这段注释免得有人"简化"回去。）
  const grams = s => {
    const x = s.replace(/[\s：:，,。.、（）()【】\[\]0-9]/g, '');
    const out = new Set();
    for (let i = 0; i + 2 <= x.length; i++) out.add(x.slice(i, i + 2));
    return out;
  };
  const df = new Map();
  const gsets = titles.map(o => { const g = grams(o.t); for (const k of g) df.set(k, (df.get(k) || 0) + 1); return g; });
  const distinctive = g => new Set([...g].filter(k => (df.get(k) || 0) < 3));
  for (let i = 0; i < titles.length; i++) for (let j = i + 1; j < titles.length; j++) {
    const A = distinctive(gsets[i]), B = distinctive(gsets[j]);
    if (A.size < 2 || B.size < 2) continue;   // 去掉模板后没剩下什么可比的，不判
    let inter = 0; for (const k of A) if (B.has(k)) inter++;
    const sim = inter / Math.min(A.size, B.size);
    if (sim > 0.7) { console.log(`\n⚠️  标题在【去掉模板词后】仍高度相似 ${(sim * 100) | 0}%：\n   ${titles[i].id}: ${titles[i].t}\n   ${titles[j].id}: ${titles[j].t}`); n++; }
  }
  // 同一句断言出现在多处，只有当它们指向【同一个被测对象】时才是重复。
  // 套在每个对象上的固定句式（项目配置 dup.templateAsserts）是模板，不是重复。
  const s3 = [...asserts.entries()].filter(([, v]) => v.size > 1)
    .filter(([a]) => !(tplRe && tplRe.test(a)));
  if (s3.length) {
    console.log(`\n⚠️  同一句断言出现在多个用例里（${s3.length} 处）：`);
    for (const [a, v] of s3.slice(0, 10)) console.log(`   「${a.slice(0, 54)}…」 ← ${[...v].join(' , ')}`);
    n += s3.length;
  }
  if (!n) console.log(`✅ 未发现重叠：${objRe ? '没有同一个对象被多处覆盖、' : ''}没有近似标题、没有重复断言${objRe ? '' : '（没配 dup.objectKey，没按被测对象查）'}`);
  else console.log(`\n共 ${n} 处待确认。判据：重叠若是「同一件事测两遍」就合并；若是「同一对象的不同侧面」就在各自 why 里写清分工。`);
  return n;
}

function validate(c) {
  const errs = []; const seen = new Set();
  if (!c.case) errs.push('缺 case(用例 id)');
  // 看板按【需求】组织：没有 demand 的用例会掉进「未归档」，跑完了在需求视图里看不见 ——
  // （用例全部跑完，但按需求打开看板却什么都看不到）。
  // 所以需求归属是硬性的，不是可选装饰。
  // 模型变更：用例不归属需求。需求↔用例的关系只在评审单（state/plans/<D>.json）里，
  // 用例文件只留 origin（出处）。旧字段 demand 一律判错，免得又长回单值归属。
  if (c.demand) errs.push('旧字段 demand 已废弃：用例是跨需求复用的资产，需求↔用例的关系在评审单里。'
    + '把它改名为 origin（出处），并用 acceptkit plan add-case <D> --surface <S> --reuse <case> 建立引用');
  // 平台必填：不写就会被按 iOS 解析操作配方（静默缺省），Android 侧没人知道它适不适用。
  const declPlat = normalizePlatforms(c);
  const rawPlat = Array.isArray(c.platform) ? c.platform : (c.platform ? [c.platform] : []);
  const badPlat = rawPlat.filter(x => !PLATFORMS.includes(String(x)));
  // 宿主：引用的必须登记过，且有用例声明的平台
  for (const h of caseHosts(c)) if (!(CFG.hosts || {})[h]) errs.push(`host=${h} 没有登记（已登记：${Object.keys(CFG.hosts || {}).join(' / ') || '无'}）：acceptkit host add ${h} --platform P …`);
  // （多宿主平台没写 host 是质量规则 Q15 管：存量用例记债，不在这里一刀切拦）
  for (const pf of declPlat) {
    const h = hostOfCase(c, pf);
    if (h && CFG.hosts?.[h] && !CFG.hosts[h][pf]) errs.push(`host=${h} 没有 ${PLATFORM_LABEL[pf]} 端（acceptkit host add ${h} --platform ${pf} …）`);
  }
  // device_need：这条用例对设备的能力要求（device acquire 按它过滤），值写成 "8192" 或 ">=8192" 这样的串
  if (c.device_need !== undefined && !(c.device_need && typeof c.device_need === 'object' && !Array.isArray(c.device_need)
      && Object.values(c.device_need).every(v => (typeof v === 'string' && v.trim()) || typeof v === 'number')))
    errs.push('device_need 要写成 { 能力: 要求 }，如 { "ram_mb": ">=8192", "gpu": "host" }，值是字符串或数字');
  // parallel_devices：这条用例本身要多台设备（device acquire --parallel case 拿它当理由，core/parallel.mjs）
  if (c.parallel_devices !== undefined && !(String(c.parallel_devices?.why || '').trim().length >= 8))
    errs.push('parallel_devices 要写成 { "why": "<为什么这条用例要多台设备>" }，why 至少 8 个字');
  if (!c.platform || !declPlat.length) errs.push(`缺 platform（${PLATFORMS.join('|')}，或它们的数组）—— 宿主写在 host 字段，别混进 platform`);
  else if (badPlat.length) errs.push(`platform=${JSON.stringify(c.platform)} 不合法：只能是 ${PLATFORMS.join('|')} 或它们的数组（android_myapp 这种要拆成 platform=android + host=myapp）`);
  else {
    const ap = applicability(c, loadOps(), CFG);
    for (const pf of RUNTIME_PLATFORMS) if (ap[pf].declared && ap[pf].missing.length)
      errs.push(`声明适用 ${PLATFORM_LABEL[pf]}，但用到的操作在 ${PLATFORM_LABEL[pf]} 侧没有配方：${ap[pf].missing.join(' ')}（acceptkit ops <id> 看；要么补配方，要么改 platform）`);
  }
  if (!Array.isArray(c.tree) || !c.tree.length) errs.push('tree 为空');
  const cls = c.classifications || {};
  walk(c.tree, (n, path) => {
    const where = path.join(' → ');
    if (!n.op) errs.push(`节点缺 op：${where}`);
    for (const [k, v] of Object.entries(n.tags || {})) {
      if (!cls[k]) errs.push(`[${where}] tag 切面未声明：${k}`);
      else if (!cls[k].includes(v)) errs.push(`[${where}] tag ${k}=${v} 不在声明的类里：${cls[k].join('/')}`);
    }
    if (n.applies) errs.push(...validateScope(n.applies, `[${where}]`));
    // shows：这一步画面上应该出现的字，shot --step 截图时拿来核对画面
    if (n.shows !== undefined && !(Array.isArray(n.shows) && n.shows.length && n.shows.every(x => typeof x === 'string' && x.trim())))
      errs.push(`[${where}] shows 必须是非空的字符串数组，写这一步画面上应该出现的字，如 ["已退出登录"]`);
    for (const e of n.expect || []) {
      if (e.applies) errs.push(...validateScope(e.applies, `[${where}] ${e.id || '?'}`));
      if (!e.id) errs.push(`[${where}] 有 expect 缺 id`);
      else if (seen.has(e.id)) errs.push(`expect id 重复：${e.id}`);
      else seen.add(e.id);
      if (!e.assert) errs.push(`[${where}] expect ${e.id || '?'} 缺 assert`);
      if (e.observe) errs.push(...validateObserve(e.observe, `[${where}] ${e.id || '?'}`, loadOps()));
    }
  });
  // 主张：标题/摘要里说出口的每句话都要落到断言上（否则标题里承诺的行为可能根本没有断言去验）
  for (const cl of c.claims || []) {
    if (!cl.text) errs.push('claims 有一条缺 text');
    if (!(cl.proved_by || []).length) errs.push(`claim「${cl.text}」缺 proved_by`);
    for (const id of cl.proved_by || []) if (!seen.has(id)) errs.push(`claim「${cl.text}」的 proved_by ${id} 不是本用例的断言`);
  }
  return errs;
}

// ---- coverage (CTM 最小准则：每个 class 至少被一条路径覆盖) ----
function coverage(c) {
  const cls = c.classifications || {};
  const hit = {}; for (const k of Object.keys(cls)) hit[k] = Object.fromEntries(cls[k].map(v => [v, 0]));
  walk(c.tree, n => { for (const [k, v] of Object.entries(n.tags || {})) if (hit[k] && hit[k][v] !== undefined) hit[k][v]++; });
  const uncovered = [];
  for (const [k, m] of Object.entries(hit)) for (const [v, n] of Object.entries(m)) if (n === 0) uncovered.push(`${k}=${v}`);
  return { hit, uncovered };
}

// ---- result store ----
function runDir(run) { return join(RUNS, run); }
function resultPath(run) { return join(runDir(run), 'result.json'); }
function loadResult(run) {
  const p = resultPath(run);
  if (!existsSync(p)) die(`run 无 result.json：${p}（先 acceptkit run）`);
  return JSON.parse(readFileSync(p, 'utf8'));
}
function saveResult(run, r) { writeFileSync(resultPath(run), JSON.stringify(r, null, 2)); }
// 断言有了结论（pass / fail / na）：本运行、以及同一用例更早运行上卡这条断言的阻塞，由工具关掉（record 和 observe 共用）
function closeBlockersOn(run, r, c, id, status) {
  const seqOf = x => { try { return JSON.parse(readFileSync(resultPath(x), 'utf8')).run_seq || 0; } catch { return Infinity; } };
  const closed = closeBlockersFor(ROOT, { demand: demandOfRun(ROOT, r, c), run, caseName: r.case, expect: id, status,
    earlier: x => seqOf(x) < (r.run_seq || 0) });
  if (closed.length) console.error(`   📮 ${closed.map(b => b.id).join(' ')} 已由工具关闭：${id} 记成了 ${status}，不再算阻塞`);
}

// 同一 case 的历史 run（扫 runs/*/result.json，按 run_seq 升序）——用来把多次跑挂成链，知道用例最终状态。
function priorRunsForCase(caseId, exceptRun) {
  if (!existsSync(RUNS)) return [];
  const out = [];
  for (const d of readdirSync(RUNS)) {
    if (d === exceptRun) continue;
    const p = join(RUNS, d, 'result.json');
    if (!existsSync(p)) continue;
    try { const r = JSON.parse(readFileSync(p, 'utf8')); if (r.case === caseId) out.push(r); } catch { /* skip */ }
  }
  return out.sort((a, b) => (a.run_seq || 0) - (b.run_seq || 0));
}

// 节点聚合状态：任一 fail→fail；有 blocked→blocked；全 pass→pass；有 todo→todo；否则 skip
function nodeStatus(node, res) {
  const st = [];
  walk([node], n => (n.expect || []).forEach(e => st.push(res.results[e.id]?.status || 'todo')));
  if (st.includes('fail')) return 'fail';
  if (st.includes('blocked')) return 'blocked';
  if (st.includes('todo')) return 'todo';           // 有未记录 → 进行中
  if (st.length && st.every(s => s === 'pass')) return 'pass';
  if (st.includes('pass')) return 'pass';
  return st.length && st.every(s => s === 'na') ? 'na' : 'skip';
}


// ---- demands（看板的一级组织单位）----
// 扫所有 case 收集已存在的需求，用来：① `acceptkit demands` 列出；② new/probe 复用已有 id 时补全 title。
function knownDemands() { return loadDemands(ROOT); }   // 需求登记表 state/demands.json，不再从用例文件收集

// 用例资产视图：用例是【资产】（操作树+断言），run 是【一次执行】。两者分开看。
function cmdCases() {
  if (!existsSync(CASES)) { console.log('（还没有用例）'); return; }
  const { opt } = parseArgs(process.argv.slice(3));
  const want = opt.platform ? String(opt.platform) : null;
  if (want && !RUNTIME_PLATFORMS.includes(want)) die(`--platform 只能是 ${RUNTIME_PLATFORMS.join('|')}`);
  const ops = loadOps(); const plans = allPlans(ROOT); const reg = knownDemands();
  const files = readdirSync(CASES).filter(f => f.endsWith('.case.json')).sort();
  // 分组按「被哪些评审单引用」，一条用例可以出现在多个需求下；谁都没引用的单列
  const byDemand = new Map(); let shown = 0;
  for (const f of files) {
    let c; try { c = JSON.parse(readFileSync(join(CASES, f), 'utf8')); } catch { continue; }
    const ap = applicability(c, ops, CFG);
    if (want && !ap[want].ok) continue;
    shown++;
    let nodes = 0; try { walk(c.tree || [], () => nodes++); } catch { /* skip */ }
    const exp = (() => { try { return allExpects(c).length; } catch { return 0; } })();
    const runs = priorRunsForCase(c.case, null);
    const last = runs.length ? runs[runs.length - 1] : null;
    const refs = demandsReferencing(ROOT, c.case, plans);
    const row = { id: c.case, kind: c.kind || 'acceptance', nodes, exp, runN: runs.length, plat: fmtApplicability(ap),
                  origin: c.origin?.id || '', last: last ? `${last.verdict || last.status || '?'} @${last.run}` : '未跑过' };
    const keys = refs.length ? [...new Set(refs.map(x => x.demand))] : ['（未被任何评审单引用）'];
    for (const k of keys) {
      if (!byDemand.has(k)) byDemand.set(k, { title: reg.get(k)?.title || (k.startsWith('（') ? '用例是资产；要用它就把它加进某条需求的评审单' : ''), rows: [] });
      byDemand.get(k).rows.push(row);
    }
  }
  for (const [id, d] of [...byDemand.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))) {
    console.log(`\n${id}  ${d.title}`);
    for (const r of d.rows) {
      console.log(`   ${r.id.padEnd(34)} ${r.kind.padEnd(11)} ${String(r.nodes).padStart(2)}节点/${String(r.exp).padStart(2)}断言  跑过${String(r.runN).padStart(2)}次  ${r.plat}  最近: ${r.last}${r.origin ? `  出处:${r.origin}` : ''}`);
    }
  }
  console.log(`\n共 ${shown} 条用例${want ? `（只列在 ${PLATFORM_LABEL[want]} 上可执行的）` : ''}。平台列是算出来的：声明了该平台 且 用到的操作在该平台有配方。`);
  console.log('（用例 = 资产；一条用例可被多条需求的评审单引用；run = 一次为某条需求做的执行。）');
}

function cmdDemands() {
  const ds = knownDemands(); const plans = allPlans(ROOT);
  if (!ds.size && !plans.length) { console.log('（还没有任何需求；acceptkit plan new <D-id> --title "…" 建第一条）'); return; }
  console.log('现有需求（需求登记表 + 评审单）：');
  const ids = new Set([...ds.keys(), ...plans.map(p => p.demand)]);
  for (const id of [...ids].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
    const p = plans.find(x => x.demand === id);
    const n = p ? planCaseSet(p).size : 0;
    const st = !p ? '无评审单' : p.approved_at ? `已批准 v${p.revision}` : `未批准 v${p.revision}`;
    console.log(`  ${id.padEnd(6)} ${String(n).padStart(2)} 个用例  ${st.padEnd(9)} ${p?.platform ? `[${p.platform}] ` : ''}${ds.get(id)?.title || p?.title || ''}`);
  }
  console.log('\n需求↔用例的关系只在评审单里：acceptkit plan add-case <D> --surface <S> --reuse a,b / --new c');
}

// 从命令行解析 demand；已知 id 可只给 id（自动补 title/desc）。缺失即报错并给出可用 id 列表。
function resolveDemand(opt, forWhat) {
  const known = knownDemands();
  const id = opt.demand;
  if (!id) {
    const list = [...known.entries()].map(([k, v]) => `  ${k}  ${v.title}`).join('\n');
    die(`${forWhat} 必须指定需求：--demand <id> [--demand-title "…"] [--demand-desc "…"]\n`
      + `没有需求归档的用例跑完了在看板需求视图里看不到（这就是它必填的原因）。\n`
      + (list ? `现有需求：\n${list}\n（复用其一只给 --demand <id> 即可）` : '（目前还没有需求，新建时请一并给 --demand-title）'));
  }
  if (known.has(id) && !opt['demand-title']) return known.get(id);
  const title = opt['demand-title'];
  if (!title) die(`需求 ${id} 是新的，必须同时给 --demand-title "…"（一句话说清这条需求要验什么）`);
  return registerDemand(ROOT, { id, title, desc: opt['demand-desc'] || title });
}

// 把一条用例加进某需求评审单的某个改动面（new/add-case/probe 共用）。已批准的单子要 --why 并升修订。
function addCaseToPlan(demandId, sid, caseName, how, opt) {
  const plan = loadPlan(ROOT, demandId);
  if (!plan) die(`需求 ${demandId} 还没有评审单 —— 先 acceptkit plan new ${demandId} --title "…" [--platform ios|android]`);
  let sf = plan.surfaces.find(x => x.id === sid);
  if (!sf) {
    if (!opt.change) die(`评审单 ${demandId} 里没有改动面 ${sid}；新建它要带 --change "<这条改动面是什么>"（现有：${plan.surfaces.map(x => x.id).join(' ') || '无'}）`);
    sf = { id: sid, change: String(opt.change), reuse: [], new: [], ops: [], note: '' }; plan.surfaces.push(sf);
  }
  if (plan.approved_at) {
    if (!opt.why) die(`评审单 ${demandId} 已批准（v${plan.revision}），往里加用例必须带 --why "<为什么现在才加>"`);
    plan.revision += 1;
    plan.history.push({ revision: plan.revision, at: new Date().toISOString(), by: opt.by ? String(opt.by) : null, change: `${sid}: +${caseName}（${how}）—— ${opt.why}` });
    plan.fingerprints ||= caseFingerprints(CASES, plan);   // 没钉过指纹的旧单子：先记下批过哪些，它们照常跑
    plan.approved_at = null; plan.approved_by = null;
    console.log(`↻ 评审单 ${demandId} 升到 v${plan.revision}：新加的 ${caseName} 等 Owner 批准；已批过的 ${approvedCases(plan).size} 条照常跑`);
  }
  sf[how] = [...new Set([...(sf[how] || []), caseName])];
  savePlan(ROOT, plan);
  console.log(`📎 ${caseName} 已加进 ${demandId} 评审单 ${sid}（${how}）`);
  return plan;
}

// ================= commands =================
function cmdNew({ pos }) {
  const name = pos[0] || die('用法：acceptkit new <case-id> --demand <D-id> --surface <S-id> --platform ios|android|both [--host <宿主>] [--change "…"]');
  const { opt } = parseArgs(process.argv.slice(3));
  const demand = resolveDemand(opt, '新建用例');
  const p = casePath(name);
  if (existsSync(p)) die(`已存在：${p}`);
  const plan = loadPlan(ROOT, demand.id) || die(`需求 ${demand.id} 还没有评审单 —— 用例是为某条改动面写的，先 acceptkit plan new ${demand.id}`);
  const sid = opt.surface ? String(opt.surface) : die(`缺 --surface <S-id>：这条用例覆盖评审单 ${demand.id} 的哪条改动面（现有：${plan.surfaces.map(x => x.id).join(' ') || '无，带 --change 新建'}）`);
  const platform = opt.platform ? String(opt.platform) : plan.platform;
  if (!platform) die(`缺 --platform ${PLATFORMS.join('|')}（评审单 ${demand.id} 也没声明平台）`);
  if (!PLATFORMS.includes(platform)) die(`--platform 只能是 ${PLATFORMS.join('|')}`);
  const tpl = PACK.newCaseTemplate ? PACK.newCaseTemplate({ name, platform, host: opt.host, demand }) : {
    case: name, title: `TODO 标题（${name}）`,
    platform, ...(opt.host ? { host: String(opt.host) } : {}),
    origin: { id: demand.id, title: demand.title },   // 出处：第一次为哪条需求写的。不参与分组/筛选
    classifications: CFG.newCase?.classifications || {   // 切面(CTM)：按需增删
      carrier: ['app', 'web', 'static'],
    },
    tree: [{
      op: '操作A（如：确认开关取值）', tags: { carrier: 'static' },
      expect: [{ id: 'E1', assert: '预期a（人话：看到什么算对）' }],
      children: [{
        op: '操作B（如：在 App 里触发某个场景）', tags: { carrier: 'app' },
        expect: [{ id: 'E2', assert: '预期b' }],
      }],
    }],
  };
  if (!existsSync(CASES)) mkdirSync(CASES, { recursive: true });
  writeFileSync(p, JSON.stringify(tpl, null, 2));
  addCaseToPlan(demand.id, sid, name, 'new', opt);
  console.log(`✍️  用例骨架 → ${p}\n   编辑后跑：acceptkit validate ${name}\n\n${standardSummary(PACK.qualityRules || [])}`);
}

// 用例质量：新增 / 改过的用例按 core/case-quality.mjs 的标准检查；项目特有规则来自 pack.qualityRules
// 带上操作库：Q21（界面上验的断言要用界面通道读）要看配方的 exec。以前这里不传，validate / plan check / run 前检查
// 从来不跑 Q21 —— 实测一个需求里十几条界面断言配着 shell 配方，看板上一直「证据不全」，没有任何检查提示过。
const caseQuality = c => qualityOf(ROOT, c, { packRules: PACK.qualityRules || [], extraKeys: CFG.quality?.extraKeys, cfg: CFG.quality || {}, hosts: CFG.hosts || {}, ops: loadOps() });

function cmdValidate({ pos }) {
  const c = loadCase(pos[0] || die('用法：acceptkit validate <case>'));
  const errs = validate(c);
  if (errs.length) { console.error(`❌ ${errs.length} 处问题：`); errs.forEach(e => console.error('   · ' + e)); process.exit(1); }
  const q = caseQuality(c);
  console.log(formatFindings(c.case, q));
  if (q.uninitialized) console.log('   （项目还没登记质量基线，以上只提示不拦：acceptkit doctor --fix）');
  if (q.block.length) { console.error(`❌ ${q.block.length} 处不达标，不能进评审单批准、不能开跑（确属例外：在断言上写 quality_waive）`); process.exit(1); }
  const exp = allExpects(c); let nodes = 0; walk(c.tree, () => nodes++);
  console.log(`✅ ${c.case} 合法：${nodes} 节点 / ${exp.length} 断言 / ${Object.keys(c.classifications || {}).length} 切面`);
}

function cmdCoverage({ pos }) {
  const c = loadCase(pos[0] || die('用法：acceptkit coverage <case>'));
  const { hit, uncovered } = coverage(c);
  console.log(`分类树覆盖（CTM 最小准则：每个类 ≥1 条路径）— ${c.case}`);
  for (const [k, m] of Object.entries(hit)) console.log(`  ${k}: ` + Object.entries(m).map(([v, n]) => `${v}(${n})`).join(' '));
  if (uncovered.length) { console.log(`⚠️  未覆盖：${uncovered.join(', ')}`); process.exit(2); }
  console.log('✅ 每个类均被覆盖');
}

// 这次 run 为哪条需求跑：--demand 显式给；不给就从评审单反查（恰好一条已批准的评审单引用它才自动选）。
// 调查型（probe）不过评审闸，需求取 --demand 或用例出处。
function resolveRunDemand(c, opt) {
  const isProbe = (c.kind || 'acceptance') === 'probe';
  if (opt.demand) return String(opt.demand);
  const refs = demandsReferencing(ROOT, c.case);
  const approved = [...new Set(refs.filter(x => x.approved).map(x => x.demand))];
  const any = [...new Set(refs.map(x => x.demand))];
  if (approved.length === 1) return approved[0];
  if (isProbe && c.origin?.id) return c.origin.id;
  if (approved.length > 1) die(`用例 ${c.case} 被 ${approved.length} 条已批准的评审单引用（${approved.join(' ')}）—— 这次为哪条需求跑要说清：acceptkit run ${c.case} --demand <D-id>`);
  if (any.length) die(`用例 ${c.case} 只被未批准的评审单引用（${any.join(' ')}）—— 先 acceptkit plan approve <D> --by <谁>，或 --demand 指定`);
  die(`用例 ${c.case} 没有被任何需求的评审单引用 —— 用例是资产，跑它得先说为哪条需求跑：\n`
    + `   acceptkit plan add-case <D> --surface <S> --reuse ${c.case}   # 引用存量\n   然后 acceptkit run ${c.case} --demand <D>`);
}

function createRun(c, opt = {}) {
  const demandId = resolveRunDemand(c, opt);
  const isProbe = (c.kind || 'acceptance') === 'probe';
  // 闸 1：没做过用例评审的需求不许开跑。
  // 症状是「同一个需求 N 条执行记录里用例都不一样」—— 根因是从没有这一步。
  if (isProbe) { /* 调查型不过评审闸：它就是「只是查个 bug / 复现一下」那条路 */ }
  else if (!opt['skip-plan-gate']) { const g = gateRun(ROOT, c, CASES, demandId); if (g) die(g); }
  else console.error(`   ⚠️  --skip-plan-gate：这一轮声明不走用例评审流程（会写进 run.result，报告里看得见）`);
  // 需求执行轮：代码变了就先开新轮做影响评估，再跑 —— 否则这次 run 会被记到旧代码版本名下。
  const roundDrift = isProbe ? null : roundCodeDrift(demandId);
  if (roundDrift && !opt['allow-stale-round']) die(roundDrift);
  const errs = validate(c);
  if (errs.length) {
    die(`用例不合法，不能开跑（${errs.length} 处）：\n` + errs.map(e => '   · ' + e).join('\n')
      + `\n修好后重跑 acceptkit run ${c.case}`);
  }
  if (!isProbe) { const q = caseQuality(c); if (q.block.length) die(`用例质量不达标，不能开跑：\n${formatFindings(c.case, q)}`); }
  // 关联性：同 case 的历史 run 挂成链。run_seq=第几次跑；prev_run=上一次跑的 id。
  const priors = priorRunsForCase(c.case, opt.run || null);
  const runSeq = priors.length + 1;
  const prevRun = priors.length ? priors[priors.length - 1].run : null;
  const run = opt.run || `${new Date().toISOString().slice(0, 10)}-${c.case}-r${runSeq}`;
  if (!existsSync(runDir(run))) mkdirSync(runDir(run), { recursive: true });
  const results = {};
  for (const e of allExpects(c)) results[e.id] = { status: 'todo', actual: '', evidence: [] };
  // 适用版本范围：用例声明了范围的断言，按被测包版本预填 —— ≥ below 记 na，< below 留 todo 照常跑。
  // 不给 --build 就一律留 todo（宁可多跑，不许静默判不适用），并点名哪些断言等着版本信息。
  let build = {};
  try { build = parseBuild(opt.build); } catch (e) { die(e.message); }
  const scopes = scopesOf(c.tree); const unknownScoped = [];
  for (const [id, sc] of Object.entries(scopes)) {
    const j = judge(sc, build);
    if (j.state === 'na') results[id] = { status: 'na', auto_na: true, evidence: [],
      na_since: { component: sc.component, version: sc.below },
      actual: `版本不适用（建 run 时按用例声明的范围自动判定）：被测包 ${sc.component}@${j.version} ≥ ${sc.below}。${sc.why}` };
    else if (j.state === 'unknown') unknownScoped.push(id);
  }
  if (unknownScoped.length) console.error(`   ⚠️  ${unknownScoped.length} 条断言声明了适用版本范围，但没给 --build 里对应组件的版本 —— 全部留 todo（照常要跑）：${unknownScoped.slice(0, 12).join(' ')}${unknownScoped.length > 12 ? ' …' : ''}`
    + `\n      若被测包已超出范围：acceptkit run ${c.case} --build <组件>@<版本>，或在本 run 里 record 时带 --build`);
  // steps：操作节点级过程证据（每走一步就 record --step，截图落这里）。与断言级证据分开存。
  const steps = {};
  for (const n of allNodes(c)) steps[n.nodeId] = { op: n.op, evidence: [], note: '' };
  // 一次「执行」= 为某条需求跑的一轮验收，里面通常验多条用例（按模块分组）。
  // 看板左侧一行 = 一次执行，不是一次单用例 run —— 否则同一轮验收会被拆成好几行散在左边，
  // 还得靠互相跳链接才能拼回去。
  // 默认按「日期 + 需求」归并；同一天为同一需求做第二轮验收，用 --session 显式区分。
  const session = opt.session ? String(opt.session) : `${run.slice(0, 10)}-${demandId}`;
  const dreg = knownDemands().get(demandId);
  saveResult(run, { case: c.case, run, run_seq: runSeq, prev_run: prevRun, session,
                    demand: { id: demandId, title: dreg?.title || loadPlan(ROOT, demandId)?.title || demandId },
                    platform: runtimePlatform(c, null) || null,   // both 用例在 device claim 时才定
                    case_ref: c._path.replace(ROOT + '/', ''), meta: Object.keys(build).length ? { build } : {}, results, steps,
                    ...(opt['skip-plan-gate'] ? { plan_gate_skipped: true } : {}) });
  const roundId = attachRunToRound(demandId, run, session);
  if (roundId) { const r0 = loadResult(run); r0.round = roundId; saveResult(run, r0); }
  return { run, runSeq, prevRun, session, expects: Object.keys(results).length, round: roundId };
}

function cmdRun({ pos }) {
  const c = loadCase(pos[0] || die('用法：acceptkit run <case> [--demand <D-id>] [--run <run-id>] [--session <id>]'));
  const { opt } = parseArgs(process.argv.slice(3));
  const { run, runSeq, prevRun, session } = createRun(c, opt);
  const nodes = allNodes(c);
  const results = loadResult(run).results;
  console.log(`▶️  run ${run}（第 ${runSeq} 次跑${prevRun ? `，续上次 ${prevRun}` : '，首次'}）建好：${Object.keys(results).length} 断言 / ${nodes.length} 操作节点待记录`);
  console.log(`   为需求 ${loadResult(run).demand?.id} 跑 · 归属执行：${session}（同一执行下的多条用例在看板里合成一行）`);
  const r1 = loadResult(run);
  if (RUNTIME_PLATFORMS.includes(r1.platform)) for (const l of shotPlaybook(shotCtx(run, r1))) console.log(l);
  else console.log(`   过程证据（每走一步就记）：acceptkit record ${run} --step ${nodes[0]?.nodeId || 'n1'} --evidence <截图或落盘产物>`);
  console.log(`   断言结果：acceptkit record ${run} --expect ${nodes[0]?.expectIds?.[0] || 'E1'} --status pass --evidence api:evidence/xx.json`);
  console.log(`   看节点编号：acceptkit steps ${c.case}`);
}

// 回归轮：「拿上一版用例做回归」= 对该需求下**全部 acceptance 用例资产**各建新轮，
// 共享一个 session（看板一行 = 这一轮回归，组内展开各用例规格）。probe(调查型) 默认不进回归，
// --include-probes 显式带上。之后：能跑的按原规格跑；跑不了的逐断言 record blocked --blocked-kind。
function cmdRegress({ pos }) {
  const demandId = pos[0] || die('用法：acceptkit regress <demandId> [--session <id>] [--include-probes]');
  const { opt } = parseArgs(process.argv.slice(3));
  // 回归的对象 = 这条需求评审单点名的全部用例（需求↔用例的关系只在评审单里，不再看用例文件）
  const plan = loadPlan(ROOT, demandId) || die(`需求 ${demandId} 没有评审单 —— 回归轮也要先评审：acceptkit plan new ${demandId}，把要复跑的资产 --reuse 进去`);
  const cases = [];
  for (const name of planCaseSet(plan)) {
    const c = tryLoadCase(name);
    if (!c) { console.error(`   ⚠️ 评审单点名的用例不存在：${name}`); continue; }
    if ((c.kind || 'acceptance') === 'probe' && !opt['include-probes']) continue;
    cases.push(c);
  }
  if (!cases.length) die(`需求 ${demandId} 的评审单里没有可回归的 acceptance 用例（调查型加 --include-probes）`);
  const session = opt.session ? String(opt.session)
    : `${new Date().toISOString().slice(0, 10)}-${demandId}-regress`;
  // 需求是一等公民：回归轮复用别的需求的用例资产，但这轮的需求归属是
  // 它自己的（例：拿上一版的用例回归新版，需求=「新版回归验收」而非上一版那条）。
  // 开轮即登记 session→需求，标题用 --title 给；不给就落个可后补的占位，看板不再从用例反推冒名。
  {
    // 常量名是 ROOT —— 这里曾引用一个本文件里不存在的旧常量名，一跑 regress 就 ReferenceError。
    // 这条路径没有别的调用方兜着，改名时要连这里一起改。
    const sessionsPath = join(ROOT, 'sessions.json');
    let reg = {}; try { reg = JSON.parse(readFileSync(sessionsPath, 'utf8')); } catch { /* 首次 */ }
    if (!reg[session]) {
      // 回归轮的需求就是 <demandId> 本身：它的评审单已经写清复用了谁的资产，不再另造 R-<D> 这种影子需求
      const dreg = knownDemands().get(demandId);
      reg[session] = { demand: { id: demandId,
        title: opt.title ? String(opt.title) : (dreg?.title || plan.title || demandId),
        desc: dreg?.desc || `回归轮：评审单 ${demandId} 点名的全部资产按原规格复跑。` } };
      writeFileSync(sessionsPath, JSON.stringify(reg, null, 1));
      console.log(`📌 session 需求已登记（sessions.json）：${reg[session].demand.title}`);
    }
  }
  console.log(`🔁 回归轮 ${session}：${demandId} 下 ${cases.length} 条用例资产各建一轮（规格原样生效）`);
  for (const c of cases) {
    const { run, runSeq, expects } = createRun(c, { session, demand: demandId });
    console.log(`   ▶️  ${c.case.padEnd(34)} → ${run}（第 ${runSeq} 次跑，${expects} 断言待记录）`);
  }
  console.log(`\n   同一 session=看板一行。接下来（回归轮规则）：能跑的按原规格跑并逐条 record；`);
  console.log(`   跑不了的**逐断言** record --status blocked --blocked-kind capability|dependency，`);
  console.log(`   actual 写清邻近证据与解锁条件——范围收窄必须显形。全部记完逐个 report。`);
}

// --supersede <证据>：手工 record 的「撤回」——挂错/被盲审驳回且已由新证据取代的那份摘下（文件留盘作历史），
// 连同它的复核一起删。record 的证据只增不减，没有这条，驳回项永远挂在 report 的缺口里。
// 台账自洽：重新挂回的证据不该还躺在 superseded 里；observe 产出全被撤下后，
// cur.observed 不该还指着那次观测（否则看板/报告以为这条仍由 observe 判定）。
function normalizeLedger(cur) {
  if (cur.superseded) cur.superseded = cur.superseded.filter(x => !(cur.evidence || []).includes(x));
  if (cur.observed && !(cur.evidence || []).some(x => x.startsWith('evidence/obs/') || x.startsWith('shots/obs-'))) delete cur.observed;
}

function supersede(r, scope, cur, paths) {
  normalizeLedger(cur);
  const gone = paths.filter(x => (cur.evidence || []).includes(x));
  for (const x of paths) if (!gone.includes(x)) console.error(`   ⚠️  --supersede ${x} 不在 ${scope} 的证据里，忽略`);
  if (!gone.length) return;
  cur.evidence = cur.evidence.filter(x => !gone.includes(x));
  cur.superseded = [...new Set([...(cur.superseded || []), ...gone])];
  for (const x of gone) delete r.reviews?.[rkey(scope, x)];
  normalizeLedger(cur);
  console.log(`   ↩︎  ${scope} 撤下 ${gone.length} 份证据：${gone.join(', ')}`);
}

// ---- 装置故障闸（evidence-gate D）----
// 这个失败是**被测物**的，还是**取证手段**自己的？两者在报告里的分量完全不同，
// 而执行者在现场最容易把后者当成前者写出去（「app is not running」其实是连错了另一台机器）。
// 分类绑在被分类的那段文本上（指纹）：说法换了就要重新分类 —— 否则「上次说过是 subject」
// 会给新的一段装置故障背书。
const PROJ_MARKERS = CFG.apparatus?.markers || [];
function classifyFailure({ run, r, scope, slot, text, status, opt }) {
  const hits = apparatusHits(text, PROJ_MARKERS);
  const fp = text ? createHash('sha1').update(String(text)).digest('hex').slice(0, 8) : '';
  const kept = slot.failure_of_fp === fp ? slot.failure_of : '';
  const fo = opt['failure-of'] ? String(opt['failure-of']) : kept;
  if (fo && !['subject', 'apparatus'].includes(fo))
    die('--failure-of 只能是 subject（被测物真的这样）或 apparatus（取证手段自己坏了）');
  if (hits.length && !fo) die(`${scope} 的说法里命中了装置故障词 —— 先分类，再写入：\n`
    + `   · ${hits.map(h => `「${h.marker}」${h.why}`).join('\n   · ')}\n`
    + `   同一句话有两种读法，报告里的分量完全不同：\n`
    + `     --failure-of subject     被测物真的这样（它就是不响应 / 它就是没有这个符号）\n`
    + `     --failure-of apparatus   取证手段自己坏了（连错机器 / 探针顺序错 / 抓到上一轮的日志 / 落了空文件）\n`
    + `   判不出来就先跑**阳性对照**：拿必然成立的那一个走同一条取证路径 —— 对照也挂了 = 装置坏了。\n`
    + `   装置故障不计入结论、不压低判定，但必须显形（它是基建该补的清单）。`);
  if (!fo) { delete slot.failure_of; delete slot.failure_of_fp; return; }
  slot.failure_of = fo; slot.failure_of_fp = fp;
  if (fo !== 'apparatus') return;
  if (status === 'fail') die(`${scope} 记成 fail，但你自己把这次失败归给了**装置**（--failure-of apparatus）。\n`
    + `   装置坏了 ⇒ 被测物压根没被证伪过，这不是 fail：\n`
    + `     · 修好装置重跑，按真实读数记 pass/fail；\n`
    + `     · 一时修不好 → --status blocked --blocked-kind capability --unlock "<我要补什么>"。\n`
    + `   这次装置故障本身已经可以登记：acceptkit apparatus ${run} --what "<哪里坏了>" --fix "<怎么绕过的>"`);
  const id = logApparatus(r, { where: scope, text, markers: hits.map(h => h.marker), source: 'record', status });
  console.error(`   🔧 ${id} 已记进本轮装置故障台账（不计缺口、不改判定）——`
    + ` 报告会单列这一节；补一句怎么修的：acceptkit apparatus ${run} --what "${String(text).slice(0, 30)}…" --fix "<办法>"`);
}

// ---- 装置故障台账（evidence-gate D）----
// 为什么需要一条独立命令：装置故障大多**不挂在任何断言上** ——
// 「诊断包装了七次才稳」「探针顺序错了」是一轮里的折腾，断言字段装不下它们。
// 不记下来，这一轮的噪音量就只活在执行者的叙事里，读报告的人看不见，基建也攒不出清单。
function cmdApparatus({ pos }) {
  const run = pos[0] || die('用法：acceptkit apparatus <run> [--what "<取证手段哪里坏了>" --fix "<怎么绕过/修的>" [--where E1|step:n1] [--cost <折腾轮数>]]');
  const { opt } = parseArgs(process.argv.slice(3));
  rejectUnknownFlags(opt);
  const r = loadResult(run);
  if (opt.what) {
    const id = logApparatus(r, { where: opt.where ? String(opt.where) : 'run', text: String(opt.what),
      fix: opt.fix ? String(opt.fix) : '', cost: opt.cost ? Number(opt.cost) : null, source: 'manual' });
    saveResult(run, r);
    console.log(`🔧 ${id} 装置故障已登记：${opt.what}`);
    if (!opt.fix) console.error(`   ⚠️  没写 --fix：绕过/修复的办法就是基建该补的那一条，不写等于白踩`);
    return;
  }
  const aps = r.apparatus || [];
  if (!aps.length) { console.log(`${run} 本轮没有登记装置故障。\n   命中装置故障词的 record 会自动登记；其余（装了几次、探针顺序错了）用 --what 手工记。`); return; }
  console.log(`🔧 ${run} 本轮装置故障 ${aps.length} 次（不计入结论；每一条都是基建该补的清单）`);
  for (const a of aps) console.log(`  ${a.id} [${a.where}] ${a.source === 'review' ? `盲审 ${a.verdict}：` : ''}${a.text}`
    + (a.markers?.length ? `  判据 ${a.markers.join(' ')}` : '') + (a.cost ? `  折腾 ${a.cost} 轮` : '') + `\n       修法：${a.fix || '⚠️ 未写'}`);
}

const appShotsOf = run => appShotsIn(runDir(run));
// 截图引导要的上下文：端、设备地址、run 是否已绑定设备（绑定了 shot 就不用再写 --sim）
function shotCtx(run, r = loadResult(run)) {
  const bound = r.device?.key || r.device?.udid || null;
  const dev = bound && platformOfUdid(bound) === 'android' ? ANDROID.addressOf(bound) : bound;
  return { run, platform: r.platform, dev, bound: !!bound };
}
// 端上 run、不是迁移进来的、到现在一张 app 截图都没有 —— 该提醒截图了
const needsShot = (run, r = loadResult(run)) => RUNTIME_PLATFORMS.includes(r.platform) && !r.demand?.migrated && !appShotsOf(run).length;

function cmdRecord({ pos, opt: given }) {
  const run = pos[0] || die('用法：acceptkit record <run> (--step <nodeId> --evidence .. | --expect <id> --status <s> [--actual ..] [--evidence ..] [--finding Fx])');
  // shot --step 会带着自己的参数转调这里：用调用方给的 opt，否则从命令行解析（否则截图挂不上步骤）
  const { opt } = given ? { opt: given } : parseArgs(process.argv.slice(3));
  // ── 过程证据模式：--step <nodeId> 把证据挂到「操作节点」而不是断言 ──
  if (opt.step) {
    const r = loadResult(run);
    if (!r.steps) r.steps = {};
    const sid = String(opt.step);
    const c = loadCase(r.case_ref || r.case);
    const node = allNodes(c).find(n => n.nodeId === sid) || die(`操作节点 ${sid} 不存在（用 acceptkit steps ${c.case} 看编号）`);
    if (!r.steps[sid]) r.steps[sid] = { op: node.op, evidence: [], note: '' };
    const cur = r.steps[sid];
    const ev = asList(opt.evidence);
    const chk = checkAtRecord({ dir: runDir(run), evidence: ev, actual: '', quotes: [], allowLiteral: opt['allow-literal'] && String(opt['allow-literal']) });
    if (chk.errors.length) die(`拒绝写入 ${sid}：\n   · ${chk.errors.join('\n   · ')}`);
    if (ev.length) cur.evidence = [...new Set([...(cur.evidence || []), ...ev])];
    supersede(r, `step:${sid}`, cur, asList(opt.supersede));
    if (opt.note) cur.note = String(opt.note);
    // 步骤的 note 同样会把「我连错了设备」写成过程描述 —— 同一道闸
    classifyFailure({ run, r, scope: `step:${sid}`, slot: cur, text: cur.note || '', status: 'step', opt });
    const pend = addPending(r, `step:${sid}`, ev);
    saveResult(run, r);
    for (const w of chk.warnings) console.error(`   ⚠️  ${w}`);
    nudgeReview(run, pend);
    const shots = (cur.evidence || []).filter(isShot).length;
    console.log(`📍 ${sid} 「${node.op.slice(0, 40)}」 · 证据×${cur.evidence.length}（截图${shots}）`);
    if (!cur.evidence.length) console.error(`   ⚠️  ${sid} 没给 --evidence：每个操作节点都要留过程证据`);
    else if (!shots && !cur.evidence.some(isMachineEv)) console.error(`   ⚠️  ${sid} 只有引用型证据：UI 节点要截图(shots/*.png)，headless 节点要落盘产物(evidence/*.json)`);
    if (needsShot(run, r)) console.error(shotNudge(shotCtx(run, r)));
    return;
  }
  // 命令行来的参数已按清单定义查过（core/protocol.mjs）；observe / shot 转调时给的是代码里的参数
  const id = opt.expect || die('缺 --expect（或用 --step 记过程证据）');
  const status = opt.status || die('缺 --status');
  if (!STATUSES.includes(status)) die(`--status 取值：${STATUSES.join('|')}`);
  const r = loadResult(run);
  if (!r.results[id]) {
    // 演化树支持：调查/探索型 run 的树是边查边长的——case 文件后加的断言
    // 自动同步进 run，而不是 die。直接拒绝会逼着调查绕过工具去做。
    const c2 = loadCase(r.case_ref || r.case);
    if (allExpects(c2).some(e => e.id === id)) {
      r.results[id] = { status: 'todo', actual: '', evidence: [] };
      console.log(`  ➕ 断言 ${id} 系 case 新增，已同步进本 run`);
    } else die(`断言 ${id} 不在该用例里（run=${run}）——先把它加进 case 文件`);
  }
  const cur = r.results[id];
  const prev = { status: cur.status, actual: cur.actual };
  // ── 适用版本范围闸 ────────────────────────────────────────────────────────
  // 范围是用例资产的属性（applies），被测包版本是 run 的属性（meta.build）。两者一比就知道
  // 这条断言在这个包上能不能有 pass/fail/blocked，还是只能是 na —— 矛盾的写入一律拒。
  // 没有这道闸，在已删掉某段功能的包上仍可能把那段功能的断言记成 pass/blocked。
  {
    if (opt.build) {
      let b; try { b = parseBuild(opt.build); } catch (e) { die(e.message); }
      const old = (r.meta || {}).build || {};
      for (const [k, v] of Object.entries(b)) if (old[k] && old[k] !== v)
        die(`本 run 已记被测包 ${k}@${old[k]}，与 --build ${k}@${v} 矛盾 —— 一个 run 只对应一个包`);
      r.meta = { ...(r.meta || {}), build: { ...old, ...b } };
    }
    const rc = loadCase(r.case_ref || r.case);
    const sc = scopesOf(rc.tree)[id];
    const j = judge(sc, (r.meta || {}).build || {});
    // 断言级平台范围（platforms: ["ios"]）：与 applies 对等，只是按端而不是按版本。
    // 本轮平台不在范围里 ⇒ 只能是 na；在范围里 ⇒ 不能记 na（除非版本范围另说）。
    const ep = (allExpects(rc).find(e => e.id === id) || {}).platforms;
    const rp = runtimePlatform(rc, r);
    if (Array.isArray(ep) && rp && !ep.includes(rp)) {
      if (status !== 'na') die(`断言 ${id} 只适用 ${ep.join(' / ')}，本轮跑在 ${rp} —— 只能记 na，不能记 ${status}`);
      opt[PLATFORM_NA] = rp;
    }
    if (status === 'na' && opt[PLATFORM_NA]) {
      // 平台不适用（observe.by 没有这一端的读法）与版本不适用是两回事：它不看组件版本，
      // 不需要 applies。只由 observe 的平台分流内部写入，命令行给不了这个参数。
    } else if (status === 'na') {
      if (!sc) die(`断言 ${id} 在用例里没有声明适用版本范围 —— 先在用例节点上写 applies {component, below, why}，`
        + `再记 na。范围写在资产上，旧版本回归时才会照常跑（只写在 run 里等于没人读）`);
      if (j.state === 'applies') die(`被测包 ${sc.component}@${j.version} < ${sc.below}：断言 ${id} 在这个包上适用，不能记 na`);
      if (j.state === 'unknown') die(`断言 ${id} 的适用范围看 ${sc.component}，但本 run 没记被测包版本 —— 加 --build ${sc.component}@<被测版本>`);
      const want = `${sc.component}@${sc.below}`;
      if (opt.since && String(opt.since) !== want) die(`--since ${opt.since} 与用例声明的范围 ${want} 不一致 —— 以用例为准，改用例或去掉 --since`);
      opt.since = want;
    } else if (j.state === 'na') {
      die(`被测包 ${sc.component}@${j.version} ≥ ${sc.below}：断言 ${id} 在这个包上不适用（${sc.why}）—— 只能记 na，`
        + `不能记 ${status}。它在 < ${sc.below} 的版本上仍是有效用例`);
    }
  }
  // 版本不适用：必须说清「从哪个组件的哪个版本起」，否则和 skip 没区别、回归旧版本时也不知道该不该跑。
  if (status === 'na' && opt[PLATFORM_NA]) {
    delete cur.na_since;
    cur.na_platform = String(opt[PLATFORM_NA]);
  } else if (status === 'na') {
    const m = String(opt.since || '').match(/^([A-Za-z0-9_]+)@(\S+)$/);
    if (!m) die('--status na 必须带 --since <组件>@<起始版本>（例：组件 LibCore、起始版本 1.2.3）');
    if (!opt.actual && !opt['actual-file'] && !cur.actual) die('--status na 必须写 --actual：这条断言测的东西在哪个版本、因为什么不存在了');
    cur.na_since = { component: m[1], version: m[2] };
    const regP = join(ROOT, 'state', 'applicability.json');
    let reg = {}; try { reg = JSON.parse(readFileSync(regP, 'utf8')); } catch { /* 首次 */ }
    const caseId = r.case || '';
    reg[`${caseId}#${id}`] = { component: m[1], not_applicable_since: m[2], run, at: new Date().toISOString() };
    writeFileSync(regP, JSON.stringify(reg, null, 2));
  } else delete cur.na_since;
  // 🔴 有效截图规则：端上验收默认都要有能证明验收过程和结果的、工具截的 app 画面。
  // 以前只在 report 里查，而 run 不出报告也能记 pass —— 实测出现过一整轮 run 全是文本证据、
  // 一张 app 截图都没有，看板照样显示通过。所以在写结论的这一刻查：端上 run 记 pass 之前，这个 run 里
  // 至少要有一张工具截的 app 画面（acceptkit shot，或 observe UI 通道）。fail 确实拍不了（app 起不来）时
  // 用 --allow-no-shot "<为什么拍不了>" 写明，理由留在结果里；pass 没有这个口子。
  if ((status === 'pass' || status === 'fail') && RUNTIME_PLATFORMS.includes(r.platform) && !r.demand?.migrated && !appShotsOf(run).length) {
    const guide = shotPlaybook(shotCtx(run, r)).join('\n');
    if (status === 'pass') die(`拒绝记 ${id}=pass：这个 run 里还没有一张 app 操作截图。判定证据照旧用探针文本，截图是证明这轮真在 app 上跑过、停在什么画面。\n${guide}`);
    if (!opt['allow-no-shot']) die(`拒绝记 ${id}=fail：这个 run 里还没有一张 app 操作截图。\n${guide}\n`
      + `   确实拍不了（例：app 起不来）就加 --allow-no-shot "<为什么拍不了>"`);
    cur.no_shot_reason = String(opt['allow-no-shot']);
  }
  cur.status = status;
  // --actual-file：从文件读 actual。**存在的理由是 shell 引号陷阱**：
  // actual 里写反引号会被 shell 当命令替换执行，把命令输出整段灌进 actual，
  // 而 record 照常返回成功。文本从文件进就没有这一类事故。
  if (opt['actual-file']) {
    const af = String(opt['actual-file']);
    if (!existsSync(af)) die(`--actual-file 指向的文件不存在：${af}`);
    const txt = readFileSync(af, 'utf8').trim();
    if (!txt) die(`--actual-file 是空的：${af}`);
    cur.actual = txt;
  } else if (opt.actual) cur.actual = String(opt.actual);
  if (cur.actual) cur.actual = mask(ROOT, cur.actual);   // #secret 的值不进结果文件
  const ev = asList(opt.evidence);
  // 🔴 图片只有两种身份能挂断言（否则会出现截图内容与断言无关的情况）：
  //   observe UI 通道产出的 ui_observe（读到值的那一刻截的）、或文字排版成的判定卡。
  //   acceptkit shot 的过程截图只证明环境与页面，挂 --step；手工 simctl/screencap 的图没有工具痕迹，不作证据。
  for (const x of ev) {
    const k = imageKind(runDir(run), x);
    if (!k || ASSERT_IMAGE_KINDS.has(k)) continue;
    die(`${x} 不能挂在断言 ${id} 上：它是${k === 'process' ? '过程截图（acceptkit shot）—— 只证明 app 在跑、停在哪页，挂 --step <nN>'
      : '没有任何工具痕迹的图 —— 不知道是哪台机器、哪个 pid、什么时刻、读到了什么'}。\n`
      + `   断言的图由 acceptkit observe 产出（UI 通道：导航到诊断页、读到值那一刻截图；或四段式渲成判定卡）。`);
  }
  // --quote 不按逗号拆（原文片段里常有逗号）；每一条都必须能在所挂文本证据里逐字找到
  const quotes = opt.quote === undefined ? [] : [].concat(opt.quote).map(String);
  supersede(r, id, cur, asList(opt.supersede));
  const allEv = [...new Set([...(cur.evidence || []), ...ev])];
  const chk = checkAtRecord({ dir: runDir(run), evidence: allEv, actual: cur.actual, quotes, allowLiteral: opt['allow-literal'] && String(opt['allow-literal']) });
  if (chk.errors.length) die(`拒绝写入 ${id}：\n   · ${chk.errors.join('\n   · ')}`);
  cur.evidence = allEv;
  normalizeLedger(cur);
  // 🔴 复核结论挂在「断言::证据路径」上，而证据文件的**内容**会变。
  //    按盲审意见补写了证据、路径没变，旧的驳回结论就原样挂着 ——
  //    看板显示「驳回未补」而其实早补了；反过来更糟：被判 ok 的证据后来被改过，ok 会继续生效。
  //    ⇒ 每次 record 都按当前内容对账：指纹对不上（或旧结论根本没记指纹）就作废，重新复核。
  for (const x of allEv) {
    const k = rkey(id, x), rv = r.reviews?.[k];
    if (!rv) continue;
    const now = evFingerprint(runDir(run), x);
    if (now && fpCurrent(rv.fp, now)) continue;      // 内容没变，结论继续有效
    delete r.reviews[k];
    console.error(`   ↩︎ ${x} 的旧复核结论（${rv.state} by ${rv.by}）已作废 —— `
      + (rv.fp ? '证据内容在那之后改过' : '那条结论产生时还没记内容指纹') + '，需重新复核');
  }
  // quotes 原本只增不减 —— 证据被 supersede 之后，指向它的旧 quote 会永远挂着，
  // 盲审在引用面里找不到原文，会判「引用了不存在的东西」。
  if (opt['reset-quotes']) { delete cur.quotes; console.log('   ↩︎ 已清空旧 quotes（证据换过，旧引用不再成立）'); }
  if (quotes.length) cur.quotes = [...new Set([...(cur.quotes || []), ...quotes])];
  if (opt.finding) cur.finding = String(opt.finding);
  classifyFailure({ run, r, scope: id, slot: cur, text: cur.actual || '', status, opt });
  // 复核挂在「这份证据能不能证明这条判定」上 —— 判定或 actual 变了，旧的复核结论就不再成立
  let pend = [];
  // blocked 的证据同样要复核 —— 「验不了」这个结论本身最容易过头（阻塞理由编得出来、
  // 归类编得出来）。以前这里只给 pass/fail 排队，于是 blocked 的证据在 reviews 里**没有条目**，
  // `review --next` 靠「缺条目」还找得到它，但任何直接统计 reviews 的人都会漏掉它，
  // 报出「0 条待复核」这种假绿。
  if (status === 'blocked') pend = addPending(r, id, cur.evidence);
  // 被驳回之后**改判**（而不是换证据）时，旧的驳回结论是针对旧判定下的，不该继续挂着 ——
  // 否则 report 永远报「驳回未补」，而我明明已经照复核人说的改了判定。
  // 判据：这份证据还在挂着 + 它的复核状态是「非 ok 非 pending」+ 本次 record 改了 status。
  // 例：按复核人意见把 pass 改成 blocked 之后，旧的 overclaim 结论不该继续卡着报告。
  if (prev.status !== status || cur.actual !== prev.actual) for (const x of cur.evidence) {
    const k = rkey(id, x), rv = r.reviews?.[k];
    if (rv && rv.state !== 'ok' && rv.state !== 'pending') {
      r.reviews[k] = { state: 'pending', at: new Date().toISOString(),
                       note: `判定/actual 已按复核意见改过（${prev.status} → ${status}）（原结论：${rv.state}${rv.note ? ' — ' + rv.note : ''}），需重新复核` };
      if (!pend.includes(k)) pend.push(k);
    }
  }
  if (status === 'pass' || status === 'fail') {
    // 被驳回退回 todo、补齐后恢复原判：那些没被驳回的复核不作废（否则一条驳回会让整批 ok 重审）
    const restored = prev.status === 'todo' && cur.reverted_from === status;
    // ⚠️ 这里原本写的是 `opt.actual && String(opt.actual) !== prev.actual` —— 只认 --actual 这一条路，
    //    于是走 --actual-file 改写 actual 时它一律判「没变」，旧复核结论继续生效。
    //    比的应该是**结果**（cur.actual），不是**入口**（某个具体参数有没有给）。
    const changed = (prev.status !== status && !restored) || (cur.actual !== prev.actual);
    delete cur.reverted_from;
    // 驳回时 applyReview 把理由**追加**进 finding（evidence-gate.mjs:142）。恢复原判时必须把那段摘掉，
    // 否则看板上一条已经补齐并重新过审的断言，会永远挂着「原判已退回 todo」的旧标签。
    // 否则断言补了新证据、盲审全 ok，状态却还挂着旧驳回语，只能靠人肉发现。
    if (restored && cur.finding) {
      // 驳回段是「🔎 证据被驳回（…）→ 原判 X 已退回 todo」整块；驳回理由正文自己就可能含「；」，
      // 先按「；」切再逐段滤会只摘掉开头一截、把理由后半段留在 finding 里。
      // 所以按整块匹配摘除，不按分隔符切。
      const left = String(cur.finding)
        .replace(/(^|；)🔎 证据被驳回（[\s\S]*?→ 原判 \S+ 已退回 todo/g, '')
        .replace(/^；+|；+$/g, '').trim();
      if (left) cur.finding = left; else delete cur.finding;
    }
    if (changed) for (const x of cur.evidence) {
      if (r.reviews?.[rkey(id, x)]) r.reviews[rkey(id, x)] = { state: 'pending', at: new Date().toISOString(), note: '判定/actual 变了，旧复核作废' };
    }
    pend = addPending(r, id, cur.evidence);
    if (changed) pend = cur.evidence.map(x => rkey(id, x));
  }
  // blocked 必须说清是谁的问题 —— 读报告的人要能分清：是用例失败了要提 bug，
  // 还是测试能力有问题。⛔ 不分类就答不了这个问题。
  //   capability = 我的测试能力缺口（造不出输入 / 拿不到证据）→ 该修工具，不该提 bug
  //   dependency = 外部依赖阻塞（别人的代码/服务挡住了）→ 该上报，不算被测对象失败
  // 两者都**不代表被测行为有问题**：被测行为压根没被证伪过。
  if (status === 'blocked') {
    const kind = opt['blocked-kind'];
    if (!kind) die(`${id}=blocked 必须带 --blocked-kind capability|dependency —— `
      + `不写就分不清「我没测成」和「产品有问题」，看板上会被当成缺陷读`);
    if (!['capability', 'dependency'].includes(String(kind)))
      die(`--blocked-kind 只能是 capability（我的能力缺口）或 dependency（外部依赖阻塞）`);
    cur.blocked_kind = String(kind);
    // 「能力缺口不是范围决策」规则的第二面：闸原本只管住 plan 里不许有「不覆盖」栏，
    // 管不住在 --unlock 里把**自己的能力缺口**写成「同意我…/让 owner 定…」。
    // capability = 我的能力缺口 ⇒ 解锁条件必须是**我要做什么**，不是「谁要同意什么」。
    if (String(kind) === 'capability') {
      const u = opt.unlock ? String(opt.unlock) : (cur.unlock || '');
      const ASK = ['同意我', '同意为', '是否同意', '请批准', '要 owner 定', '由 owner 定',
                   '让 owner', 'owner 拍板', '需要拍板', '同意这', '或同意'];
      // 「补缺口需改产品」那一格：缺口在我这、但补它要**往产品里加东西**时，
      // 补不补确实是产品决定。放行条件是**机器可验**的：unlock 里必须引用一条已立案的 finding。
      // 引用不了 finding 就进不了这一格 —— 这道闸是为了防止这一格变成绕过上面规则的后门。
      const citesFinding = /finding\s*\*{0,2}F\d+/i.test(u);
      const hit = citesFinding ? [] : ASK.filter(w => u.includes(w));
      if (citesFinding) console.error(`   ℹ️  ${id} 的解锁条件引用了一条 finding —— 归入`
        + `「能力缺口，但补它要 owner 先定一条 finding」那一格；raise 时会单列。`);
      if (hit.length) die(`${id} 是 capability（我的能力缺口），但解锁条件写成了「要谁同意」：${hit.join(' ')}\n`
        + `   ⛔ 做不到的事是执行阻塞，不是范围决策。capability 的解锁条件必须写\n`
        + `      **我要做什么**（补哪个工具 / 加哪个字段 / 跑哪一步），不是「请 owner 同意」。\n`
        + `   · 真的需要 owner 拍板的只有两类：产品行为变更（acceptkit plan finding）、验证深度。\n`
        + `   · 真的是外部依赖挡住 → --blocked-kind dependency。`);
    }
    // 闸 3：阻塞**当场**登记并提示上报，不许攒到报告里
    // （没测试完成，包括因为某个原因没测试完成，都应该在执行期当场提出来）。
    const cse = loadCase(r.case_ref || r.case);
    const runDemand = demandOfRun(ROOT, r, cse);
    const b = raiseBlocker(ROOT, { demand: runDemand, run, caseName: r.case, expect: id,
      kind: String(kind), text: cur.actual || '', unlock: opt.unlock ? String(opt.unlock) : '' });
    if (b && !b.reported) {
      console.error(`   📮 ${b.id} 已登记为「待提给 owner」—— 这条不提，report 出不来：`);
      console.error(`      acceptkit blockers ${runDemand} --raise        # 生成要发的话术并标记已提`);
      if (!b.unlock) console.error(`      ⚠️  没写 --unlock "<解锁条件>"：owner 看不出这条要他做什么`);
    }
  } else if (cur.blocked_kind) { delete cur.blocked_kind; }
  saveResult(run, r);
  closeBlockersOn(run, r, existsSync(casePath(r.case_ref || r.case)) ? loadCase(r.case_ref || r.case) : null, id, status);
  console.log(`${ICON[status]} ${id} = ${status}${opt.finding ? ' ['+opt.finding+']' : ''}${cur.evidence.length ? ' · 证据×'+cur.evidence.length : ''}`);
  // 闸门：pass/fail 必须留证据；fail 必须有截图(UI 视觉证据)。当场警告，别拖到 report 才发现。
  if ((status === 'pass' || status === 'fail') && !cur.evidence.length)
    console.error(`   ⚠️  ${id}=${status} 没给 --evidence：pass/fail 必须留证据${status === 'fail' ? '，fail 尤其要 UI 截图' : ''}`);
  else if (status === 'fail' && !cur.evidence.some(x => isShot(x) || isMachineEv(x)))
    console.error(`   ⚠️  ${id}=fail 只有引用型证据：失败断言要有主证据(UI=截图 / headless=evidence/*.json)`);
  for (const w of chk.warnings) console.error(`   ⚠️  ${w}`);
  nudgeReview(run, pend);
}

// 有证据就提示复核 —— 复核发生在「证据刚产生」时，不在收口时（那时已经在向人汇报了）
function nudgeReview(run, keys) {
  if (!keys.length) return;
  console.log(`   🔎 ${keys.length} 份证据待复核 —— 现在就审，别攒到 report：acceptkit review ${run} --next`);
}

// ---- 证据复核（evidence-gate B）----
// 审的人只看「断言 + 证据原文」下结论（盲审包）。执行者自审记 --by self，report 会单列：
// 执行者自己看过的证据最容易被放过（比如一张其实停在登录页的截图）。
function cmdReview({ pos }) {
  const run = pos[0] || die('用法：acceptkit review <run> [--list | --next | --count | --item <key> --verdict <v> --note .. --by blind|owner|self]');
  const { opt } = parseArgs(process.argv.slice(3));
  const r = loadResult(run);
  const c = loadCase(r.case_ref || r.case);
  // 列表/回写看全部证据（含已退回 todo 的断言上的，驳回理由要看得见）；report 的缺口口径只算 pass/fail 断言
  // 被后续 run 取代的轮次不补审：它跑的是用例的旧版本，那些断言在现用例里可能已不存在，
  // 补审等于给一份作废的规格做复核（例：用例整份重建后，旧轮次的断言在现用例里已全部消失）。
  if (r.superseded_by) {
    console.log(`⏭  ${run} 已被 ${r.superseded_by} 取代，不再补审。原因：`);
    console.log(`   ${r.superseded_note || '（没写原因 —— 该补上）'}`);
    if (opt.count) { console.log(JSON.stringify({ run, pending: 0, rejected: 0, total: 0, superseded_by: r.superseded_by })); return; }
    if (!opt.item) return;   // 仍允许显式回写单条（留痕用）
  }
  const items = reviewItems(r, { any: true, dir: runDir(run) });
  const pending = items.filter(i => i.rv.state === 'pending');
  const rejected = items.filter(i => i.rv.state !== 'pending' && i.rv.state !== 'ok');
  if (opt.count) { console.log(JSON.stringify({ run, pending: pending.length, rejected: rejected.length, total: items.length })); return; }
  if (opt.item) {
    const key = String(opt.item);
    if (!reviewItems(r, { any: true, dir: runDir(run) }).some(i => i.key === key)) die(`没有这个复核条目：${key}（acceptkit review ${run} 看全部）`);
    const verdict = opt.verdict ? String(opt.verdict) : die(`缺 --verdict（${Object.keys(VERDICTS).join('|')}）`);
    if (verdict !== 'ok' && !opt.note) die('驳回必须带 --note 写清理由 —— 否则被退回的人不知道该补什么');
    const by = String(opt.by || 'self');
    const evPath = key.split('::').slice(1).join('::');
    // 🔴 「先回写结论、再动文件」的机器闸：只靠自觉守不住 ——
    //    拿到盲审结论后先去补证据、再回写，一条描述旧内容的结论就会被挂到新内容上。
    //    内容指纹拦不住它（回写时文件已是新的，当然"对得上"），所以这里改成比
    //    **生成盲审包时给复核人看的那一版** 与 **现在这一版**。
    const shownFp = r.shown?.[key];
    const nowFp = evFingerprint(runDir(run), evPath);
    if (shownFp && nowFp && shownFp !== nowFp) die(
      `拒绝回写 ${key}：复核人看到的内容（${shownFp}）与现在盘上的内容（${nowFp}）**不是同一版**。\n`
      + `   多半是你拿到结论后先去补了证据、才回来回写 —— 那条结论描述的是补之前的东西。\n`
      + `   正确顺序：**先回写结论，再动文件**；已经改了就把它当新内容重新送审（再跑一次 review --next）。`);
    let out; try { out = applyReview(r, key, verdict, opt.note ? String(opt.note) : '', by,
                                     { fp: evFingerprint(runDir(run), evPath) }); } catch (e) { die(e.message); }
    saveResult(run, r);
    const left = reviewItems(r).filter(i => i.rv.state === 'pending').length;
    console.log(`${verdict === 'ok' ? '✅' : '❌'} ${key} → ${verdict}${by === 'self' ? '（自审：不算独立复核，report 单列）' : ''}`
      + (out.reverted ? `\n   ↩️  ${key.split('::')[0]} 原判 ${out.reverted} 已退回 todo —— 补证据或改判后重新 record` : '')
      + `\n   剩余待复核 ${left}`);
    return;
  }
  if (opt.all) {   // 一次吐出全部盲审包：交给一个独立 subagent 批量审
    const nodes = allNodes(c), exps = allExpects(c);
    r.shown ??= {};
    for (const it of pending) {
      r.shown[it.key] = evFingerprint(runDir(run), it.ev);   // 记下「复核人看到的是哪一版」
      console.log(reviewPacket({ key: it.key, c, r, dir: runDir(run),
        expectOf: id => exps.find(e => e.id === id), nodeOf: nid => nodes.find(n => n.nodeId === nid) }) + '\n');
    }
    saveResult(run, r);
    console.log(`（待复核共 ${pending.length} 条；逐条回写：acceptkit review ${run} --item '<key>' --verdict <v> --note .. --by blind）`);
    return;
  }
  if (opt.next) {
    const it = pending[0];
    if (!it) { console.log(`✅ ${run} 没有待复核的证据${rejected.length ? `（驳回 ${rejected.length} 条待处理）` : ''}`); return; }
    const nodes = allNodes(c), exps = allExpects(c);
    r.shown ??= {}; r.shown[it.key] = evFingerprint(runDir(run), it.ev); saveResult(run, r);
    console.log(reviewPacket({ key: it.key, c, r, dir: runDir(run),
      expectOf: id => exps.find(e => e.id === id), nodeOf: nid => nodes.find(n => n.nodeId === nid) }));
    console.log(`\n回写：acceptkit review ${run} --item '${it.key}' --verdict <v> [--note "<理由>"] --by blind`);
    console.log(`（待复核共 ${pending.length} 条）`);
    return;
  }
  const icon = s => s === 'ok' ? '✅' : s === 'pending' ? '⏳' : '❌';
  console.log(`证据复核 · ${run}（${items.length} 条：待审 ${pending.length} · 驳回 ${rejected.length}）`);
  for (const i of items) console.log(`  ${icon(i.rv.state)} ${i.key}${i.rv.state !== 'pending' ? `  [${i.rv.state}${i.rv.by ? ' by ' + i.rv.by : ''}] ${i.rv.note || ''}` : ''}`);
  if (pending.length) console.log(`\n下一条：acceptkit review ${run} --next`);
}

// ---- reviewq：跨 run 的盲审队列（程序化管理，不靠手工删文件；存储结构支持局部更新）----
// 真值只在 runs/<run>/result.json（reviews + shown 指纹），这里不另存第二份状态。
// state/review/packets/<run>/<断言>__<证据>__<指纹>.txt  盲审包缓存：指纹进文件名 ⇒ 内容没变就命中、不重写；
//                                                       内容变了自然是新文件。旧包只在 --prune 时清，从不隐式删。
// state/review/applied/<时刻>.jsonl                       每次 --apply 的回写流水，只追加。
const REVIEWQ = join(ROOT, 'state', 'review');
const rqSlug = s => String(s).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
const rqPacketName = (key, fp) => {
  const [scope, ...rest] = key.split('::');
  return `${rqSlug(scope)}__${rqSlug(rest.join('::'))}__${fp || 'nofp'}.txt`;
};

function rqScan({ demand, run }) {
  const out = [];
  for (const d of readdirSync(RUNS).sort()) {
    if (run && d !== run) continue;
    const p = resultPath(d);
    if (!existsSync(p)) continue;
    let r; try { r = JSON.parse(readFileSync(p, 'utf8')); } catch { continue; }
    if (r.superseded_by) continue;                       // 被取代的轮次不补审（与 cmdReview 同口径）
    if (demand && (r.demand?.id || demandOfRun?.(d)) !== demand) continue;
    const items = reviewItems(r, { any: true, dir: runDir(d) });
    const pending = items.filter(i => i.rv.state === 'pending');
    const rejected = items.filter(i => i.rv.state !== 'pending' && i.rv.state !== 'ok');
    if (!pending.length && !rejected.length) continue;
    out.push({ run: d, r, pending, rejected });
  }
  return out;
}

// ---- --json 返回的状态卡片：每次从磁盘现读，就是「最新的完整状态」（docs/002-protocol.md 第一节）----
function reviewsOf(run, r, scope) {
  const out = {};
  for (const it of reviewItems(r, { any: true, dir: runDir(run) })) if (it.scope === scope) out[it.ev] = { state: it.rv.state, note: it.rv.note || '' };
  return out;
}
// scope = 断言 id，或 step:<节点>（与复核键的前半段同口径）
function scopeCard(run, scope) {
  const r = loadResult(run); const c = loadCase(r.case_ref || r.case);
  if (scope.startsWith('step:')) {
    const sid = scope.slice(5);
    return stepCard(run, allNodes(c).find(n => n.nodeId === sid) || { nodeId: sid, op: '' }, r.steps?.[sid], reviewsOf(run, r, scope));
  }
  return expectCard(run, allExpects(c).find(x => x.id === scope) || { id: scope }, r.results?.[scope], reviewsOf(run, r, scope), demandOfRun(ROOT, r, c));
}

function cmdReviewQ({ pos }) {
  const { opt } = parseArgs(process.argv.slice(2));
  const demand = opt.demand ? String(opt.demand) : null;
  const onlyRun = opt.run ? String(opt.run) : null;

  if (opt.apply) return rqApply(String(opt.apply), opt);
  // --reopen <key> --run <R> --why "…"：证据文件没变、但被判的上下文变了（例：步骤 note 被盲审判 overclaim 后改写），
  // 把那条复核重新排进待审。指纹没变就不会自动失效，所以要显式重开；理由必填，进流水。
  if (opt.reopen) {
    const run = onlyRun || die('--reopen 要配 --run <run>');
    const why = opt.why ? String(opt.why) : die('--reopen 要写 --why：为什么旧结论不再适用');
    const r = loadResult(run); const key = String(opt.reopen);
    if (!r.reviews?.[key]) die(`没有这条复核：${key}`);
    const prev = r.reviews[key];
    r.reviews[key] = { state: 'pending', at: new Date().toISOString(), note: `重开：${why}（原 ${prev.state}${prev.by ? ' by ' + prev.by : ''}：${prev.note || ''}）` };
    saveResult(run, r);
    const dir = join(REVIEWQ, 'applied'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, new Date().toISOString().replace(/[:.]/g, '-') + '-reopen.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), run, key, action: 'reopen', why, prev }) + '\n');
    console.log(`↩️  ${run} ${key} 重开待审（原 ${prev.state}）`);
    return JSON_MODE ? scopeCard(run, key.split('::')[0]) : undefined;
  }

  const scan = rqScan({ demand, run: onlyRun });
  const totP = scan.reduce((s, x) => s + x.pending.length, 0);
  const totR = scan.reduce((s, x) => s + x.rejected.length, 0);

  if (opt.pack) {
    const limit = opt.limit ? Number(opt.limit) : Infinity;
    let made = 0, hit = 0, n = 0; const index = [];
    for (const { run, r, pending } of scan) {
      if (!pending.length) continue;
      const c = loadCase(r.case_ref || r.case);
      const nodes = allNodes(c), exps = allExpects(c);
      const dir = join(REVIEWQ, 'packets', run); mkdirSync(dir, { recursive: true });
      let dirty = false;
      for (const it of pending) {
        if (n >= limit) break; n++;
        const fp = evFingerprint(runDir(run), it.ev);
        // 包的内容 = 断言/步骤文字 + note + 证据原文。只按证据指纹命名会在「证据没变、note 改了」时命中旧包，
        // 复核人看到的是旧 note。⇒ 文件名再带上包内容本身的哈希。
        const body = reviewPacket({ key: it.key, c, r, dir: runDir(run),
          expectOf: id => exps.find(e => e.id === id), nodeOf: nid => nodes.find(x => x.nodeId === nid) }) + '\n';
        const ph = createHash('sha1').update(body).digest('hex').slice(0, 8);
        const f = join(dir, rqPacketName(it.key, `${fp}-${ph}`));
        if (existsSync(f)) hit++; else { writeFileSync(f, body); made++; }
        r.shown ??= {};
        if (r.shown[it.key] !== fp) { r.shown[it.key] = fp; dirty = true; }   // 「复核人看到的是哪一版」，回写时比对
        index.push({ run, key: it.key, fp, packet: f });
      }
      if (dirty) saveResult(run, r);
      if (n >= limit) break;
    }
    const idx = join(REVIEWQ, `index${demand ? '-' + demand : ''}${onlyRun ? '-' + rqSlug(onlyRun) : ''}.jsonl`);
    mkdirSync(REVIEWQ, { recursive: true });
    writeFileSync(idx, index.map(x => JSON.stringify(x)).join('\n') + (index.length ? '\n' : ''));
    console.log(`📦 盲审包：本次 ${index.length} 份（新写 ${made} · 命中缓存 ${hit}）${n < totP ? `；队列共 ${totP}，--limit 截到 ${n}` : ''}`);
    console.log(`   清单：${idx}`);
    console.log(`   回写：每行 {"run","key","verdict","note"} 写进一个 .jsonl → acceptkit reviewq --apply <文件> --by blind`);
    return JSON_MODE ? reviewPackCard({ index: idx, made, cached: hit, packets: index.map(x => ({ run: x.run, key: x.key, packet: x.packet })) }) : undefined;
  }

  if (opt.prune) {
    // 只删「已不在任何 run 的待审队列里」的包；其余一律保留
    const live = new Set();
    for (const { run, pending } of rqScan({})) for (const it of pending)
      live.add(join(run, rqPacketName(it.key, evFingerprint(runDir(run), it.ev)).replace(/\.txt$/, '')));
    const root = join(REVIEWQ, 'packets'); let gone = 0, kept = 0;
    if (existsSync(root)) for (const run of readdirSync(root)) for (const f of readdirSync(join(root, run))) {
      // 文件名是 <key>__<证据指纹>-<包哈希>.txt：证据指纹那段对得上就算仍在队列（包哈希随 note 变，旧包也只在 prune 时清）
      const stem = join(run, f).replace(/-[0-9a-f]{8}\.txt$/, '');
      if (live.has(stem)) { kept++; continue; }
      if (opt['dry-run']) { console.log(`  would prune ${run}/${f}`); gone++; continue; }
      unlinkSync(join(root, run, f)); gone++;
    }
    console.log(`🧹 ${opt['dry-run'] ? '将清' : '已清'} ${gone} 份陈旧包，保留 ${kept} 份在队列中的`);
    return JSON_MODE ? { pruned: gone, kept, dry_run: !!opt['dry-run'] } : undefined;
  }

  // 默认：看队列
  if (JSON_MODE) return { results: scan.flatMap(x => [...(x.pending.length ? [reviewDueCard(x.run, x.pending)] : []), ...x.rejected.map(it => rejectedCard(x.run, it))]) };
  console.log(`盲审队列${demand ? ' · ' + demand : ''}：待审 ${totP} · 驳回未补 ${totR}（${scan.length} 个 run）`);
  for (const x of scan) console.log(`  ${String(x.pending.length).padStart(3)} 待审 ${String(x.rejected.length).padStart(3)} 驳回  ${x.run}`);
  if (totP) console.log(`\n下一步：acceptkit reviewq --pack${demand ? ' --demand ' + demand : ''}  → 交独立 subagent → acceptkit reviewq --apply <verdicts.jsonl> --by blind`);
}

function rqApply(file, opt) {
  if (file !== '-' && !existsSync(file)) die(`--apply 指向的文件不存在：${file}`);
  const text = file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8');
  const lines = text.split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));
  const byDefault = String(opt.by || 'blind');
  const byRun = new Map(); const log = []; let ok = 0, bad = 0, reverted = 0;
  // 一行一个结果（--json 时原样返回）：被拒的那行带 refused，其余照常回写
  const results = [];
  const refuse = (line, m, v = {}) => { console.log(`❌ ${m}`); bad++; results.push({ line, ...(v.run ? { run: v.run } : {}), ...(v.key ? { key: v.key } : {}), refused: m }); };
  for (const [i, line] of lines.entries()) {
    let v; try { v = JSON.parse(line); } catch { refuse(i + 1, `第 ${i + 1} 行不是 JSON`); continue; }
    const { run, key, verdict } = v; const note = v.note || ''; const by = v.by || byDefault;
    if (!run || !key || !verdict) { refuse(i + 1, `第 ${i + 1} 行缺 run/key/verdict`, v); continue; }
    if (!VERDICTS[verdict]) { refuse(i + 1, `${run} ${key}：verdict=${verdict} 不认（${Object.keys(VERDICTS).join('|')}）`, v); continue; }
    if (verdict !== 'ok' && !note) { refuse(i + 1, `${run} ${key}：驳回必须带 note`, v); continue; }
    if (!byRun.has(run)) { if (!existsSync(resultPath(run))) { refuse(i + 1, `没有 run ${run}`, v); continue; } byRun.set(run, loadResult(run)); }
    const r = byRun.get(run);
    const it = reviewItems(r, { any: true, dir: runDir(run) }).find(x => x.key === key);
    if (!it) { refuse(i + 1, `${run} 没有复核条目 ${key}`, v); continue; }
    const evPath = key.split('::').slice(1).join('::');
    const now = evFingerprint(runDir(run), evPath), shown = r.shown?.[key];
    if (shown && now && shown !== now) { refuse(i + 1, `${run} ${key}：复核人看到的 ${shown} ≠ 现在的 ${now}，先 --pack 重新出包`, v); continue; }
    const out = applyReview(r, key, verdict, note, by, { fp: now });
    if (out.reverted) reverted++;
    ok++; log.push({ at: new Date().toISOString(), run, key, verdict, note, by, fp: now, reverted: out.reverted || null });
    results.push({ line: i + 1, run, key });
  }
  for (const [run, r] of byRun) saveResult(run, r);
  if (log.length) {
    const dir = join(REVIEWQ, 'applied'); mkdirSync(dir, { recursive: true });
    const f = join(dir, new Date().toISOString().replace(/[:.]/g, '-') + '.jsonl');
    writeFileSync(f, log.map(x => JSON.stringify(x)).join('\n') + '\n');
    console.log(`📝 流水：${f}`);
  }
  console.log(`回写 ${ok} 条（驳回致退回 todo ${reverted}）· 拒收 ${bad} 条`);
  if (bad) process.exitCode = 1;
  if (JSON_MODE) return { results: results.map(x => x.refused ? x : { line: x.line, key: x.key, ...scopeCard(x.run, x.key.split('::')[0]) }) };
}

// 观测「没成」的那几次（采样没抽中 / 通道没拿到判据）不改断言状态，但要留台账：
// 否则这一刻的截图在 run 目录里成了孤儿（report 报 orphan_image），而「试过 299 发没抽中」这件事本身也消失了。
// 只追加；状态、证据、复核一概不动。
function noteAttempt(r, id, a) {
  r.results ??= {};
  const cur = (r.results[id] ??= { status: 'todo' });
  cur.attempts = [...(cur.attempts || []), { at: new Date().toISOString(), ...a }];
}

// ---- observe（evidence-gate C）：断言自己声明「在哪观测 / 取哪个值 / 什么算 pass」----
// 工具执行观测、原文落盘、按谓词判、渲染四段式卡片、回写结果 —— 结果性证据由机制产出，
// 不再是人拿一段输出去「解释」成 pass（人工解释时，规格写的观测对象和实际取证的对象可能根本不是同一个，且没人发现）。
function cmdObserve({ pos }) {
  const run = pos[0] || die('用法：acceptkit observe <run> [--expect <id,..> | --todo] [--from-file <已采集的原始输出>] [--dry-run | --try]');
  const { opt } = parseArgs(process.argv.slice(3));
  const r = loadResult(run);
  const c = loadCase(r.case_ref || r.case);
  let ids = opt.expect ? asList(opt.expect) : allExpects(c).filter(e => e.observe).map(e => e.id);
  // --todo：只观测当前是 todo 的（含被盲审驳回退回的）—— 补证据时不碰已经 pass/fail/blocked 的断言（局部更新）
  if (opt.todo) { const r0 = loadResult(run); ids = ids.filter(id => (r0.results?.[id]?.status || 'todo') === 'todo'); }
  if (!ids.length) die('这个用例没有带 observe 的断言 —— 先在 case 里给断言写 observe 规格（acceptkit ops 看 kind=observe 的操作）');
  // 🔴 --dry-run 若只在部分通道生效，UI 通道会照样驱动 app、发几百次 emit ——
  //    一个「只看看」的开关在真机上真跑了，正是 silent no-op 的反面。dry-run 一律在这里截住：只列计划，不碰设备。
  if (opt['dry-run']) {
    const exps = allExpects(c);
    console.log(`observe 计划 · ${run}（${ids.length} 条，--dry-run 不执行）`);
    for (const id of ids) {
      const e = exps.find(x => x.id === id); const o = e?.observe || {};
      console.log(`  ${id.padEnd(4)} 现状=${r.results?.[id]?.status || 'todo'}  op=${o.op || '-'}  ${JSON.stringify(o.params || {}).slice(0, 160)}`);
    }
    return JSON_MODE ? { results: ids.map(id => ({ ...scopeCard(run, id), dry_run: true })) } : undefined;
  }
  // 有效截图规则（与 record 同一道闸，见 cmdRecord）：以前 observe 这条路只在 stderr 提醒一句，结论照样落 pass ——
  // 一个需求跑了两百多个运行、一百多个一张 app 截图都没有，看板照样全绿。现在：观测后这个运行里仍没有 app 画面
  // （UI 通道观测时截的也算），这次观测出来的 pass / fail 退回原样，不落盘。
  const noShotRevert = (id, prev) => {
    if (!['pass', 'fail'].includes(r.results?.[id]?.status) || !needsShot(run, r)) return null;
    r.results[id] = prev;
    return `这个运行里还没有一张 app 操作截图，观测结果没落盘（和 record 同一条规则）：先 acceptkit shot ${run} --step <nN> 截一张当前 app 画面，再 observe`;
  };
  // --try：真执行（可以用推测的配方），打印判定，不写回结果 —— 配方先试通、核对，再 ops verify，再正式观测
  if (opt.try) {
    const scratch = structuredClone(r);
    for (const id of ids) observeOne(run, scratch, c, id, opt);
    console.error('   --try：以上判定没有写进运行结果');
    return JSON_MODE ? { results: ids.map(id => ({ expect: id, tried: true })) } : undefined;
  }
  if (!JSON_MODE) {
    const blocked = [];
    for (const id of ids) { const prev = structuredClone(r.results?.[id] ?? { status: 'todo' }); observeOne(run, r, c, id, opt); if (noShotRevert(id, prev)) blocked.push(id); }
    saveResult(run, r);
    if (blocked.length) die(`${blocked.join('、')} 的观测结果没落盘：这个运行里还没有一张 app 操作截图。\n${shotPlaybook(shotCtx(run, r)).join('\n')}`);
    return;
  }
  // --json：一条一个结果。被拒的（规格不对、通道没拿到判据）带 refused，其余照常观测、写回
  const refused = new Map();
  for (const id of ids) {
    const tried = (r.results?.[id]?.attempts || []).length;
    const prev = structuredClone(r.results?.[id] ?? { status: 'todo' });
    try { observeOne(run, r, c, id, opt); } catch (e) { if (!(e instanceof Refused)) throw e; refused.set(id, e.message); continue; }
    const why = noShotRevert(id, prev); if (why) { refused.set(id, why); continue; }
    const a = (r.results?.[id]?.attempts || [])[tried];
    if (a) refused.set(id, `${ATTEMPT_WORDS[a.outcome] || a.outcome}${a.why ? `：${a.why}` : ''}，没改记录${a.shot ? `（这一刻的截图 ${a.shot}）` : ''}`);
  }
  saveResult(run, r);
  if (needsShot(run, r)) console.error(shotNudge(shotCtx(run, r)));
  return { results: ids.map(id => refused.has(id) ? { expect: id, refused: refused.get(id) } : scopeCard(run, id)) };
}
// observe 没成的那几次（noteAttempt 的 outcome）怎么跟执行者说
const ATTEMPT_WORDS = {
  not_sampled: '重复触发都没走到目标分支（没抽中不是 fail）：再观测一次',
  offscreen_read: '读值在视图树里有、截图上看不到：先把那一行摆进画面再观测',
  channel_failure: '观测没拿到判据：修通道再观测',
};

// 端口 → 监听它的 app 进程属于哪台模拟器。多台模拟器同时跑被测 App 时各占一个端口，
// 连错端口读到的是别人那台的诊断数据，而且看起来和正常结果一模一样。
function portOwnerSim(port) {
  const l = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout || '';
  const pid = l.split('\n')[1]?.trim().split(/\s+/)[1];
  if (!pid) return null;
  const cmd = spawnSync('ps', ['-o', 'command=', '-p', pid], { encoding: 'utf8' }).stdout || '';
  return /Devices\/([0-9A-F-]{36})\//.exec(cmd)?.[1] || null;
}

// UI 观测通道：截图不是独立动作，是观测的副产品。
// 按配方的 steps 把 app 导航到能看见判据的页面（诊断控制台的决策明细等），抓一次 UI 层级，
// 读出画面上的文本 → 按 read 规则抠值 → 同一刻截图。图、读到的文本、判定来自同一个动作，
// 没有「先判定、再找一张图来配」的缝隙。字符串匹配式的"相关性闸"挡不住找个恰好有那几个字的页面，这个能。
// 截图 OCR：视图树会把被盖住的下层页面一起吐出来，读值可能来自屏幕上看不见的那一层
// —— 这会造成假 pass（截图是首页，读值来自下层详情页）。读值必须在截图上看得见才算数。
function ocrText(png) {
  if (PACK.ocr) return PACK.ocr(png, HELPERS);
  const bin = join(PROJ.cacheDir, 'bin', 'ocr');
  if (!existsSync(bin)) {
    if (process.platform !== 'darwin') return null;   // 内置 OCR 用系统 Vision 框架，仅 macOS
    mkdirSync(join(PROJ.cacheDir, 'bin'), { recursive: true });
    spawnSync('swiftc', ['-O', join(REPO_ROOT, 'adapters', 'ocr', 'ocr.swift'), '-o', bin], { encoding: 'utf8', timeout: 180_000 });
  }
  const r = spawnSync(bin, [png], { encoding: 'utf8', timeout: 60_000 });
  return r.status === 0 ? r.stdout : null;
}
const ocrNorm = (x) => String(x).replace(/\s+\S*(Label|TextField\w*)$/, '').replace(/[\p{So}\p{Sk}\uFE0F\u2139]/gu, '')
  .replace(/[\s·•・。．，,、：:;；（）()「」\[\]【】<>＞…\-—_|/！!]+/g, '').toLowerCase();
function visibleOnShot(ocr, val) {
  const o = ocrNorm(ocr.replace(/\n/g, ''));
  const parts = String(val).replace(/\s+\S*(Label|TextField\w*)$/, '').split(/\s{2,}/).filter(q => ocrNorm(q));
  return parts.length === 0 || parts.every(q => o.includes(ocrNorm(q)));
}

// 整行与 OCR 全文的最佳窗口相似度（1 - 编辑距离/长度，都先 ocrNorm）；不足 8 字返回 0 —— 短串模糊匹配没有区分度
function fuzzyOnShot(ocr, line) {
  const t = ocrNorm(String(line).replace(/\s+\S*(Label|TextField\w*)$/, '')), o = ocrNorm(ocr.replace(/\n/g, ''));
  if (t.length < 8 || !o.length) return 0;
  const n = t.length; let best = 0;
  // 半全局编辑距离：t 必须整段对齐，o 里任意起止（经典 approximate substring matching）
  let prev = new Array(n + 1).fill(0).map((_, i) => i);
  for (let j = 1; j <= o.length; j++) {
    const cur = [0];
    for (let i = 1; i <= n; i++) cur[i] = Math.min(prev[i] + 1, cur[i - 1] + 1, prev[i - 1] + (t[i - 1] === o[j - 1] ? 0 : 1));
    best = Math.max(best, 1 - cur[n] / n);
    prev = cur;
  }
  return best;
}

function execObserveUI(recipe, params, dir, udid, ctx = {}) {
  // Android：步骤用 adb 驱动（{serial}），画面层级取 uiautomator dump，截图取 screencap —— 读值与截图仍是同一动作。
  // 没有这一支时，Android 上「界面上验」的断言永远截不到读值那一刻的图，evidence_gap 怎么重试都补不上。
  const android = ctx.platform === 'android';
  if (android && !udid) return { error: 'Android 的 UI 通道要本 run 占着的设备：先 acceptkit device acquire --run <运行>' };
  let port = android ? '' : resolvePort(recipe, udid, ctx);
  if (udid && !android) { const owner = portOwnerSim(port); if (owner !== udid) return { error: `端口 ${port} ${owner ? `属于模拟器 ${owner}` : '没有 app 在监听'}，不是本 run 占用的 ${udid}` }; }
  const sim = udid || portOwnerSim(port);
  if (!sim) return { error: `端口 ${port} 没有 app 在监听，UI 通道无法导航` };
  const adb = android ? `${adbPath()} -s ${sim}` : '';
  //  步骤间传值：一步可以 `capture: {名字: "正则"}` 把自己的输出抓进 vars，
  //  后面的步骤用 `{var.名字}` 引用。为什么需要：
  //  记录列表是**活的流** —— 真实 app 流量与调试通道自己的本地调用都在持续产生记录，
  //  「点列表第一行」永远点不到你刚 emit 的那条（点进去的往往是 app 自身的真实流量）。
  //  唯一可靠的锁定方式是拿 emit 回的记录 id 去筛 —— 那个 id 只有运行时才知道。
  const vars = {};
  const fill = (t) => String(t).replace(/\{port\}/g, port).replace(/\{udid\}/g, sim).replace(/\{serial\}/g, sim)
    .replace(/\{param\.([a-zA-Z0-9_]+)\}/g, (_, k) => params[k] === undefined ? '' : String(params[k]))
    .replace(/\{var\.([a-zA-Z0-9_]+)\}/g, (_, k) => vars[k] === undefined ? '' : String(vars[k]));
  const ran = [];
  for (const st of recipe.steps || []) {
    if (!st.cmd) continue;
    const cmd = fill(st.cmd);
    if (/\{param\./.test(cmd)) return { error: `步骤「${st.do}」里的参数没填上：${cmd}` };
    if (/\{var\./.test(cmd)) return { error: `步骤「${st.do}」引用了还没被 capture 的变量：${cmd}` };
    // Android 配方的驱动脚本直接调 adb：login shell 的 PATH 里常常没有 SDK 的 platform-tools（实测：
    // 驱动脚本报 FileNotFoundError: 'adb'，界面观测一条都跑不起来）。工具已经找到 adb，就把它所在目录放进 PATH。
    // login shell 会按 profile 重置 PATH，所以前缀要写进命令本身，不能只靠 env。
    const adbDir = android && adbPath() !== 'adb' ? dirname(adbPath()) : null;
    const x = spawnSync('bash', ['-lc', adbDir ? `export PATH="${adbDir}:$PATH"; ${cmd}` : cmd], { encoding: 'utf8', timeout: st.timeout_ms || 60_000, maxBuffer: 64 * 1024 * 1024 });
    const out = (x.stdout || '') + (x.stderr || '');
    for (const [k, re] of Object.entries(st.capture || {})) {
      const m = out.match(new RegExp(re));
      if (!m) return { error: `步骤「${st.do}」的 capture「${k}」没抓到（正则 ${re}）—— 抓不到就别往下走，否则后面锁定的是别人的决策\n   命令：${cmd.slice(0, 300)}\n   输出末尾：${out.trim().slice(-400) || '（无输出）'}`, raw: ran.join('\n') };
      vars[k] = m.length > 1 ? m[1] : m[0];
    }
    ran.push(`$ ${cmd}\n${out.trim().slice(0, 20000)}`);   // 步骤输出就是自证（装包时刻 / pid / 采样），别截短（截太短会把 pid 与采样信息丢掉）
    if (x.status !== 0 && !st.ignore_failure) return { error: `步骤「${st.do}」失败（exit ${x.status}）：${cmd}\n${(x.stderr || x.stdout || '').slice(0, 300)}`, raw: ran.join('\n') };
    if (st.settle_ms) spawnSync('sleep', [String(st.settle_ms / 1000)]);
  }
  spawnSync('sleep', [String((recipe.settle_ms || 800) / 1000)]);
  // 步骤里可能冷启过（--relaunch）：主 app 换了端口就跟过去，读画面与截图都要对着它
  const moved = android ? '' : resolvePort(recipe, sim, ctx);
  if (moved && moved !== String(port)) { ran.push(`（冷启后主 app 端口 ${port} → ${moved}）`); port = moved; }
  const h = android ? androidScreen(adb) : fetchHierarchy(port);
  if (h.unknown) return { error: `导航完了但拿不到 UI 层级：${h.reason}`, raw: ran.join('\n') };
  const seq = (android ? h.nodes.map(n => n.text) : h.nodes.filter(h.visible).map(h.textOf)).map(t => t.trim()).filter(Boolean);
  const texts = [...new Set(seq)];
  const read = {}, readMatch = {};
  for (const rd of recipe.read || []) {
    if (rd.source === 'ocr') continue;   // 截图之后从同一张图的 OCR 里读（见下）
    const re = new RegExp(rd.pattern === undefined && rd.desc ? /^[\s\S]+$/.source : fill(rd.pattern), rd.flags || '');
    if (rd.desc && !android) return { error: `read「${rd.key}」用了 desc（按 content-desc 找节点），只有 Android 支持；iOS 用 pattern / after`, raw: ran.join('\n') };
    const pool = readPool(rd, { seq, texts, nodes: android ? h.nodes : [] }, fill);
    const hitLine = pool.find(t => re.test(t));
    const m = hitLine ? hitLine.match(re) : null;
    read[rd.key] = m ? (m.length > 1 ? (m.length === 2 ? m[1] : m.slice(1)) : m[0]) : null;
    if (m) readMatch[rd.key] = m[0];
  }
  // 截图：就在读值这一刻；sidecar 记下读到了什么，让图可追溯到判定
  const ts = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const rel = `shots/obs-${ctx.id || 'x'}-${ts}.ui.png`;
  mkdirSync(join(dir, 'shots'), { recursive: true });
  // simctl io 在 Xcode 27 上直写外接卷报 Operation not permitted：先写 $TMPDIR 再拷进运行目录（与 shot 同一处理）
  const tmpPng = join(process.env.TMPDIR || '/tmp', `acceptkit-obs-${process.pid}-${ts}.png`);
  const shot = android ? spawnSync('bash', ['-c', `${adb} exec-out screencap -p > ${JSON.stringify(tmpPng)}`], { encoding: 'utf8', timeout: 30_000 })
    : spawnSync('xcrun', ['simctl', 'io', sim, 'screenshot', tmpPng], { encoding: 'utf8' });
  if (shot.status === 0 && existsSync(tmpPng)) { try { writeFileSync(join(dir, rel), readFileSync(tmpPng)); unlinkSync(tmpPng); } catch { /* 拷不过去下面按没截到处理 */ } }
  const ok = shot.status === 0 && existsSync(join(dir, rel)) && statSync(join(dir, rel)).size > 1024;
  // 界面通道的结论就靠这张图：没截到不许记 pass（实测踩过：截图写失败时照样判 pass、证据里只有原文）
  if (!ok) return { error: `读到值的那一刻没截到图（${String(shot.stderr || shot.stdout || '').trim().slice(0, 200) || '文件不存在或过小'}）`, raw: ran.join('\n') };
  // 读值必须在截图上可见：看不见的置空（等于没读到），并在原文与侧车里记下
  let ocr_check = null;
  if (ok) {
    const ocr = ocrText(join(dir, rel));
    if (ocr === null) ocr_check = { status: 'ocr_unavailable' };
    else {
      const offscreen = [], how = {};
      for (const [k, v] of Object.entries(read)) {
        if (v === null || v === undefined) continue;
        const vals = Array.isArray(v) ? v : [v];
        if (vals.every(x => x === null || x === '' || visibleOnShot(ocr, x))) { how[k] = 'exact'; continue; }
        // 值本身太短或被 OCR 认歪时，退一步核「整条命中行」：精确包含，或 ≥8 字的整行与截图某段相似度 ≥0.8
        // （例：等宽 JSON 行「"scene" : "some_engine_switch"」被 OCR 认成「sone enaine switch」）。
        // 屏外的行在截图上找不到任何相近片段，所以这一步不会把被盖住的读值放进来。
        const line = readMatch[k];
        const fz = line ? fuzzyOnShot(ocr, line) : 0;
        if (line && (visibleOnShot(ocr, line) || fz >= 0.8)) { how[k] = visibleOnShot(ocr, line) ? 'line_exact' : `line_fuzzy:${fz.toFixed(2)}`; continue; }
        offscreen.push(k); read[k] = null;
      }
      // source:"ocr" 的读项：视图树读不到的窗口（例：内部登录校验 / SSO 之类的独立窗口，UI 层级抓取
      // 里没有它的任何文字，UI 通道读到的是被盖住的下层页面）—— 直接在这张截图的 OCR 文本里按行匹配。
      // 值就取自图本身，天然「在屏上」，不再过上面的屏外闸。
      const ocrLines = ocr.split('\n').map(t => t.trim()).filter(Boolean);
      if ((recipe.read || []).some(r => r.source === 'ocr')) ran.push(['── 截图 OCR 全文 ──', ...ocrLines].join('\n'));
      for (const rd of (recipe.read || []).filter(r => r.source === 'ocr')) {
        const pat = fill(rd.pattern);
        const re = new RegExp(pat, rd.flags || '');
        let hitLine = ocrLines.find(t => re.test(t));
        // 正则里明写了跨行（[\s\S] 或 \n）：作者要的是「同一条记录里这几个字段都在」，逐行永远匹配不上。
        // 逐行没中才在整屏文本上再试；单行正则不走这条，免得把不相干的两行拼出假阳性。
        // 实例：一条断言要同一条记录里的三个字段都在，而 OCR 槽只有两个。
        if (!hitLine && /\[\\s\\S\]|\\n/.test(pat) && re.test(ocrLines.join('\n'))) hitLine = ocrLines.join('\n');
        const m = hitLine ? hitLine.match(re) : null;
        read[rd.key] = m ? (m.length > 1 ? (m.length === 2 ? m[1] : m.slice(1)) : m[0]) : null;
        how[rd.key] = m ? 'ocr_source' : 'ocr_source_miss';
        if (m) ran.push(`（OCR 读值 ${rd.key}：截图上的行「${hitLine}」）`);
      }
      ocr_check = { status: offscreen.length ? 'offscreen_values_dropped' : 'all_visible', offscreen, how };
      if (offscreen.length) ran.push(`（OCR 闸：${offscreen.join('、')} 的读值不在截图上 —— 来自被盖住的下层视图，作废）`);
    }
  }
  // 事中检测：读到的值在这张图上认得出（OCR 闸留下的非空读值），几乎纯色也只是空页面
  const seen = () => Object.entries(ocr_check?.how || {}).some(([k, h]) => h !== 'ocr_source_miss' && ![null, undefined, ''].includes(read[k]));
  const bk = ok ? observeBlank(dir, rel, ran, ctx, seen) : {};
  if (bk.error) return bk;
  const blank = bk.blank || null;
  const pid = android ? androidPid(adb, appOf('android', ctx).package) : appPid(sim, appOf('ios', ctx).bundle);
  const meta = { kind: 'ui_observe', ...(android ? { platform: 'android' } : {}), run: ctx.run, op: ctx.op, udid: sim, port, pid, at: new Date().toISOString(),
                 page_title: h.pageTitle || null, texts_read: read, vars, ocr_check, visible_text_count: texts.length, steps: (recipe.steps || []).map(s => s.do),
                 checks: { blank, screen_text_source: 'hierarchy', screen_text_excerpt: mask(ROOT, texts.join(' ')).slice(0, 300) } };
  return { data: { page_title: h.pageTitle || null, read, texts, vars }, raw: ran.concat(['── 画面可见文本 ──', ...texts]).join('\n'),
           cmdLine: `[ui] ${(recipe.steps || []).map(s => s.do).join(' → ')} → 读画面 → 截图`,
           ...(ok ? { ui_shot: rel, ui_meta: meta } : {}) };
}

// observe 的 ui / web 通道共用：读值那一刻的截图几乎纯色，就什么都证明不了 —— 删图，按通道失败处理。
// seen() = 读到的值在这张图上认得出（空状态之类的页面本来就几乎是空的）：只提示。只在几乎纯色时才调（web 要跑 OCR）。
// 拒收要说清另一条路：白屏本身就是被测物的问题时记 fail，别用 --record-channel-failure 记成取证手段的缺口。
// → { blank }（写进 sidecar）| { error, raw }（调用方原样返回）
function observeBlank(dir, rel, ran, ctx, seen) {
  let blank = null;
  try { const img = decodePng(readFileSync(join(dir, rel))); blank = img && blankness(img); } catch { /* 解不开：不当成纯色 */ }
  const released = !!blank && blank.ratio >= BLANK_REFUSE && seen();
  const v = blankVerdict(blank, { readable: released, what: `等画面出来再观测；等够了还是这样、白屏本身就是被测 app 的问题：`
    + `acceptkit record ${ctx.run || '<run>'} --expect ${ctx.id || '<E>'} --status fail --failure-of subject --actual "<等了多久、画面上是什么>"`
    + `（这个 run 还没有 app 截图时再加 --allow-no-shot "读值那一刻画面是纯色，截图被事中检测拒收"）` });
  if (v?.refuse) { try { unlinkSync(join(dir, rel)); } catch {} return { error: `读值那一刻的截图：${v.refuse}`, raw: ran.join('\n') }; }
  if (v?.hint) ran.push(`（事中检测：${v.hint}）`);
  return { blank: blank && { ratio: blank.ratio, color: blank.color, ...(released ? { released_by: 'read_on_shot' } : {}) } };
}

// 被测 App 的调试端口：由项目 pack.resolvePort 决定（按进程定，别按「上次是几号」猜）；
// 没有钩子时用 ACCEPTKIT_APP_PORT → 配方里的 port → 宿主登记的 ios.port。
const resolvePort = (recipe, udid, ctx = {}) => (PACK.resolvePort ? PACK.resolvePort(recipe, udid, HELPERS) : null)
  || process.env.ACCEPTKIT_APP_PORT || recipe.port || appOf('ios', ctx).port || '';

// 观测执行器注册表：内置通用通道 + 项目 pack.observers 提供的私有通道（同一个接口）。
// 通道不存在 ≠ 判定：返回 error，由 observeOne 走后备通道或显式记为能力缺口。
const WEB_CLI = join(REPO_ROOT, 'adapters', 'web', 'cli.mjs');
const packPath = () => (PACK._none ? null : join(ROOT, CFG.pack || 'pack.mjs'));
function webCli(args) {
  const pp = packPath();
  const x = spawnSync(process.execPath, [WEB_CLI, ...args, ...(pp ? ['--pack', pp] : [])], { encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  const line = (x.stdout || '').trim().split('\n').pop() || '';
  try { return JSON.parse(line); } catch { return { ok: false, error: `web 载体没有返回 JSON：${(x.stderr || x.stdout || '').slice(0, 300)}` }; }
}
const webPort = (params = {}, recipe = {}, ctx = {}) => String(params.port || recipe.port || process.env.ACCEPTKIT_WEB_PORT || appOf('web', ctx).port || '');
const webTab = (params = {}, recipe = {}, ctx = {}) => String(params.tab || recipe.tab || appOf('web', ctx).tabMatch || '');
const BUILTIN_OBSERVERS = {
  ui: execObserveUI,
  // Web 页面：在页面里求值读判据，同一刻截图。读值与截图来自同一个动作（与 App 的 UI 通道同一纪律）。
  web: (recipe, params, dir, udid, ctx) => {
    const port = webPort(params, recipe, ctx);
    if (!port) return { error: 'web 观测缺调试端口（宿主登记的 web.port / 配方 port / ACCEPTKIT_WEB_PORT）' };
    const expr = params.eval || recipe.eval;
    if (!expr) return { error: 'web 观测缺 eval（在页面里求值的表达式，返回判据）' };
    const ts = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
    const rel = `shots/obs-${ctx.id || 'x'}-${ts}.ui.png`;
    mkdirSync(join(dir, 'shots'), { recursive: true });
    const args = ['observe', '--port', port, '--eval', expr, '--out', join(dir, rel)];
    const tab = webTab(params, recipe, ctx); if (tab) args.push('--tab', tab);
    if (params.url || recipe.url) args.push('--url', String(params.url || recipe.url).replace(/\{project\}/g, ROOT));   // {project} = 项目目录（本地页面用 file://{project}/…）
    if (params.wait_ms || recipe.wait_ms) args.push('--wait', String(params.wait_ms || recipe.wait_ms));
    const r = webCli(args);
    if (!r.ok) return { error: `web 观测失败：${r.error || '未知错误'}` };
    const meta = { kind: 'ui_observe', platform: 'web', run: ctx.run, op: ctx.op, port, url: r.url, page_title: r.title,
                   at: new Date().toISOString(), texts_read: r.value, obscuring_check: r.obscuring_check };
    const shotOk = existsSync(join(dir, rel)) && statSync(join(dir, rel)).size > 1024;
    const hints = [];
    if (shotOk) {
      // 和 ui 通道同一道纯色闸。读值来自页面结构不是图，所以「图上认得出」要 OCR 在截图上找到读到的字
      const words = [];
      const leaf = v => { if (typeof v === 'string' && v.trim().length >= 2) words.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(leaf); };
      leaf(r.value);
      let ocr = null;   // 只在几乎纯色时才跑 OCR：别的画面用不着它
      const seen = () => { ocr = words.length ? ocrText(join(dir, rel)) : null; return ocr !== null && words.some(w => visibleOnShot(ocr, w)); };
      const bk = observeBlank(dir, rel, hints, ctx, seen);
      if (bk.error) return bk;
      meta.checks = { blank: bk.blank, screen_text_source: ocr !== null ? 'ocr' : 'none',
                      screen_text_excerpt: ocr ? mask(ROOT, ocr.replace(/\s+/g, ' ').trim()).slice(0, 300) : '' };
    }
    return { data: r.value, raw: [JSON.stringify({ url: r.url, title: r.title, value: r.value }, null, 1), ...hints].join('\n'),
             cmdLine: `[web] ${expr.slice(0, 120)} @ ${r.url}`, ...(shotOk ? { ui_shot: rel, ui_meta: meta } : {}) };
  },
  'file-grep': (recipe, params, dir) => {
    const f = join(dir, params.file || '');
    if (!params.file || !existsSync(f)) return { error: `日志文件不在 run 目录：${params.file}` };
    const re = new RegExp(params.pattern, params.flags || '');
    const matches = [];
    readFileSync(f, 'utf8').split('\n').forEach((t, i) => { if (re.test(t)) matches.push({ n: i + 1, text: t.slice(0, 400) }); });
    return { data: { file: params.file, pattern: params.pattern, count: matches.length, matches: matches.slice(0, 200) },
             cmdLine: `grep -nE '${params.pattern}' ${params.file}（run 目录内）` };
  },
  // 读 run 目录里的 JSON 产物（例：注入器的结果文件），按 pick 判逐条用例
  'json-file': (recipe, params, dir) => {
    const f = join(dir, params.file || '');
    if (!params.file || !existsSync(f)) return { error: `JSON 文件不在 run 目录：${params.file}` };
    try { return { data: JSON.parse(readFileSync(f, 'utf8')), cmdLine: `读取 run 目录内 ${params.file}` }; }
    catch (e) { return { error: `不是合法 JSON：${params.file}（${e.message}）` }; }
  },
};
// 证据强度（docs/architecture.md「观测降级」）：S1 被测对象主动暴露的诊断接口 / S2 日志·网络·页面·产物 / S3 截图识别 / S4 人工
const STRENGTH_RANK = { S1: 1, S2: 2, S3: 3, S4: 4 };
const DEFAULT_STRENGTH = { ui: 'S2', web: 'S2', 'file-grep': 'S2', 'json-file': 'S2' };
const strengthOf = (recipe) => recipe.strength || PACK.observerStrength?.[recipe.exec] || DEFAULT_STRENGTH[recipe.exec] || 'S2';

function execObserve(recipe, params, dir, udid, ctx = {}) {
  const fn = (PACK.observers || {})[recipe.exec] || BUILTIN_OBSERVERS[recipe.exec];
  if (!fn) return { error: `缺少观测扩展「${recipe.exec}」（内置：${Object.keys(BUILTIN_OBSERVERS).join('/')}；项目 pack.observers：${Object.keys(PACK.observers || {}).join('/') || '无'}）`, missing_extension: recipe.exec };
  return fn(recipe, params, dir, udid, ctx, HELPERS);
}

function observeOne(run, r, c, id, opt) {
  const e = allExpects(c).find(x => x.id === id) || die(`断言 ${id} 不在用例里`);
  // 适用版本范围先于观测：被测包不在范围里的断言没有被测对象，观测只会拿别的东西来判。
  // 实例：旧流程已删的包上，「开关关」那一支的 observe 读到的是新流程的结果，一批断言被判成 pass ——
  // record 有这道闸，observe 的写入路径没有。这里经 cmdRecord 记 na，闸与 record 同一处。
  {
    const sc = scopesOf(c.tree)[id];
    if (sc && judge(sc, (r.meta || {}).build || {}).state === 'na') {
      console.error(`🚫 ${id}：被测包不在适用范围（${sc.component} < ${sc.below} 才适用）—— 不观测，记 na`);
      if (opt.try) return;   // 试跑不写结果
      cmdRecord({ pos: [run], opt: { expect: id, status: 'na', actual: `[applies] ${sc.why || ''}`.slice(0, 1200),
        'blocked-kind': '' } });
      // cmdRecord 自己落了盘；调用方手里的 r 是旧的，不刷新的话 cmdObserve 末尾会拿它把 na 覆盖回去
      Object.assign(r, loadResult(run));
      return;
    }
  }
  const o0 = e.observe || die(`${id} 没有 observe 规格${e.machine ? `（只有文本 machine：${e.machine}）` : ''}`);
  const plat = runtimePlatform(c, r) || die(`${c.case} 是 platform=both 的用例，这轮跑在哪端要先 device acquire --run ${run}（它会把平台记进 run）`);
  // 一条断言一个目的、各端一份翻译：按本轮平台取那一支。
  // 该平台没译 ⇒ **na**（这条在这一端不适用/还没译），不是 fail 也不是 blocked ——
  // 把「还没译」记成 fail 会读成产品缺陷，记成 blocked 会读成装置坏了，两种都误导。
  const o = bindingOf(o0, plat);
  if (o === null) {
    const have = bindingPlatforms(o0).join(' / ') || '（空）';
    console.error(`⏭️  ${id}：${plat} 上还没有这条断言的读法（已译：${have}）—— 记 na，不是 fail`);
    if (opt.try) return;
    cmdRecord({ pos: [run], opt: { expect: id, status: 'na', actual: `${plat} 未译：observe.by 里只有 ${have}`,
      since: '', 'blocked-kind': '', [PLATFORM_NA]: plat } });
    Object.assign(r, loadResult(run));   // 同上：别让末尾的 saveResult 把 na 覆盖掉
    return;
  }
  if (!normalizePlatforms(c).length) die(`${c.case} 没声明 platform —— 不再按 iOS 缺省解析操作配方，先把 platform 写上`);
  const host = hostOfCase(c, plat);
  const tryGuess = { tryGuess: !!opt.try };
  const recipe = opRecipe(o.op, plat, host, tryGuess);
  if (recipe.error) die(recipe.error);
  const dir = runDir(run);
  const get = (params, rc = recipe) => {
    if (rc.error) return { error: rc.error };
    if (rc.absent) return { error: `该观测操作在 ${PLATFORM_LABEL[plat] || plat} 侧没有实现` };
    if (opt['from-file'] && rc === recipe && rc.exec === 'diag') {
      const src = resolve(String(opt['from-file']));
      if (!existsSync(src)) die(`--from-file 不存在：${src}`);
      return { raw: readFileSync(src, 'utf8'), cmdLine: `（离线复判）读取已采集的原始输出 ${src.startsWith(dir) ? src.slice(dir.length + 1) : src}` };
    }
    return execObserve(rc, params, dir, r.device?.udid, { run, id, c, op: o.op, platform: plat });
  };
  const parse = (x) => {
    if (x.error) return { error: x.error };
    if (x.data) return { data: x.data };
    const d = extractJSON(x.raw);
    if (!d) return { error: '输出里抠不出 JSON（通道不通？看 raw）' };
    if (d.ok === false) return { error: `命令返回 ok:false —— ${JSON.stringify(d.error || d.message || d).slice(0, 200)}` };
    return { data: d };
  };
  // --set k=v 覆盖规格里的参数（例：老 run 的日志不在约定位置 evidence/app.log，而在 evidence/run3/app.log）
  const sets = Object.fromEntries([].concat(opt.set ?? []).map(s => { const i = String(s).indexOf('='); return [String(s).slice(0, i), String(s).slice(i + 1)]; }));
  // 观测降级（docs/architecture.md）：主通道不可用时按 fallback 顺序尝试后备通道；实际用的是哪条、强度几级都记下来。
  let main = get({ ...(o.params || {}), ...sets });
  let pm = parse(main);
  let usedRecipe = recipe, usedOp = o.op, usedChecks = o.checks;
  const ladder = [{ op: o.op, ok: !pm.error, error: pm.error || null }];
  if (pm.error) for (const fb of o.fallback || []) {
    const rc = fb.op ? opRecipe(fb.op, plat, host, tryGuess) : recipe;
    const m2 = get({ ...(fb.params || {}), ...sets }, rc);
    const p2 = parse(m2);
    ladder.push({ op: fb.op || o.op, ok: !p2.error, error: p2.error || null });
    if (!p2.error) { main = m2; pm = p2; usedRecipe = rc; usedOp = fb.op || o.op; usedChecks = fb.checks || o.checks; break; }
  }
  const strength = strengthOf(usedRecipe.error ? {} : usedRecipe);
  // 前提（阳性对照）：可以有多条，每条可带自己的 params 单独观测一次 ——
  // 例：「0 次 event_x」要配「同一份日志里 hit_y > 0」；有的还要再加「写入闸没被关过」。
  // 前提可以换一种观测方式（gd.op）—— 例：主判定查日志，前提「写入闸开着」要读运行时属性
  const gs = guardsOf(o).map(gd => {
    const rc = gd.op ? opRecipe(gd.op, plat, host, tryGuess) : recipe;
    const px = (gd.params || gd.op) ? parse(get({ ...(gd.op ? {} : (o.params || {})), ...sets, ...(gd.params || {}) }, rc)) : pm;
    const V = px.error ? [] : pick(px.data, gd.pick);
    return { gd, px, V, ok: !px.error && evalPredicate(V, gd.predicate) };
  });
  const badG = gs.find(x => !x.ok);
  const pg = badG?.px || gs[0]?.px;   // 落盘用：优先留下不成立的那条前提的原文

  let status, reason; const lines = [];
  // 通道失败 / 画面上一个判据都没读到 ≠ 判定。例：目标行被惯性滚出屏幕，read=null，若照记就成了 FAIL；
  // 导航失败则被记成 blocked:capability —— 两个都是执行缺口。不改记录，报错退出，修通道再观测。
  if (!pm.error && main.ui_meta?.vars?.reached === '0' && !opt['record-channel-failure']) {
    console.error(`⚠️  ${id}：重复触发 ${main.ui_meta.vars.emits} 发都没走到目标分支 —— 没抽中不是 fail，不改记录（截图 ${main.ui_shot || '无'} 如实是最后一发）`);
    noteAttempt(r, id, { outcome: 'not_sampled', emits: Number(main.ui_meta.vars.emits) || null, shot: main.ui_shot || null });
    process.exitCode = 4; return;
  }
  // OCR 闸把某个读值判为「不在截图上」时，凡是用到它的判定都不能下结论 —— 那是取景/层级问题，不是产品不符（照记会误记成 fail）
  const dropped = main.ui_meta?.ocr_check?.offscreen || [];
  if (!pm.error && dropped.length && (o.checks || []).some(ch => dropped.some(k => String(ch.pick).includes(`read.${k}`)))
      && !opt['record-channel-failure']) {
    console.error(`⚠️  ${id}：读值 ${dropped.join('、')} 在视图树里有、截图上看不到（OCR 闸置空），不改记录 —— 先把那一行摆进画面再观测`
      + (main.ui_shot ? `（截图：${main.ui_shot}）` : ''));
    noteAttempt(r, id, { outcome: 'offscreen_read', dropped, shot: main.ui_shot || null });
    process.exitCode = 3; return;
  }
  const unread = !pm.error && (usedRecipe.exec === 'ui' || usedRecipe.exec === 'web') && (usedChecks || []).length
    && (usedChecks || []).every(ch => pick(pm.data, ch.pick).every(v => v === null || v === undefined));
  if ((pm.error || unread) && !opt['record-channel-failure']) {
    console.error(`⚠️  ${id}：观测没拿到判据，不改记录 —— ${pm.error || '画面上没读到 ' + o.checks.map(ch => ch.pick).join('、')}`
      + (main.ui_shot ? `（这一刻的截图：${main.ui_shot}）` : ''));
    noteAttempt(r, id, { outcome: 'channel_failure', why: String(pm.error || 'unread').slice(0, 200), shot: main.ui_shot || null });
    process.exitCode = 3; return;
  }
  if (pm.error) { status = 'blocked'; reason = `观测通道失败：${pm.error}`; }
  else if (badG) {
    for (const x of gs) { lines.push(`前提 ${x.gd.pick} = ${JSON.stringify(x.V).slice(0, 300)}  → ${x.ok ? '成立' : `不成立（要求 ${fmtPred(x.gd.predicate)}）`}`); if (!x.ok) break; }
    status = 'blocked'; reason = `前提不成立，无从判定：${badG.gd.why || '输入/阳性对照没有出现'}`;
  } else {
    for (const x of gs) lines.push(`前提 ${x.gd.pick} = ${JSON.stringify(x.V).slice(0, 300)}  → 成立`);
    const res = (usedChecks || []).map(ch => {
      const V = pick(pm.data, ch.pick); const ok = evalPredicate(V, ch.predicate);
      lines.push(`${ch.pick} = ${JSON.stringify(V).slice(0, 300)}  → ${ok ? '成立' : '不成立'}（要求 ${fmtPred(ch.predicate)}）`);
      return ok;
    });
    status = res.every(Boolean) ? 'pass' : 'fail';
    reason = status === 'pass' ? '全部判定条件成立' : `判定条件不成立：${usedChecks.filter((_, i) => !res[i]).map(ch => ch.pick).join('、')}`;
  }
  // 最低证据强度：实际强度弱于断言要求的，不记通过，记能力缺口（降级必须显式）。
  if (status === 'pass' && o.min_strength && STRENGTH_RANK[strength] > STRENGTH_RANK[o.min_strength]) {
    status = 'blocked';
    reason = `证据强度不够：实际 ${strength}（${usedOp}），断言要求至少 ${o.min_strength}`;
  }
  if (usedOp !== o.op) lines.push(`（主通道 ${o.op} 不可用：${ladder[0].error}；降级到 ${usedOp}，强度 ${strength}）`);
  console.log(`${ICON[status]} ${id} = ${status}  ← observe ${o.op}${o.params?.command ? ' ' + o.params.command : ''}\n   ${lines.join('\n   ')}\n   ${reason}`);
  if (opt['dry-run'] || opt.try) {
    if (recipe.state === 'guess') console.error(`   （试跑用的是推测的配方 ${o.op}：核对读到的值和截图对得上，再 acceptkit ops verify ${o.op} --platform ${plat}${host ? ` --host ${host}` : ''}，之后才记结论）`);
    return;
  }

  // 原文 + 解析 + 四段式 + 卡片，全部进 run 目录；卡片是「判定所需信息全在图上」的视觉证据
  const ts = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const base = `obs-${id}-${ts}`;
  mkdirSync(join(dir, 'evidence', 'obs'), { recursive: true });
  const evs = [];
  const put = (rel, body) => { writeFileSync(join(dir, rel), mask(ROOT, body)); evs.push(rel); };
  // UI 通道：读到值那一刻截的图就是这条断言的视觉证据（sidecar 里有页面标题、读到的文本、pid）
  if (main.ui_shot) { evs.push(main.ui_shot); if (main.ui_meta) { main.ui_meta.expect = id; writeFileSync(join(dir, main.ui_shot + '.json'), JSON.stringify(main.ui_meta, null, 2)); } }
  if (main.raw !== undefined) put(`evidence/obs/${base}.raw.txt`, main.raw);
  // .json / .txt 是工具对原文的摘要，单看判不了（盲审一律 insufficient），而一份被驳回就会把整条断言退回 todo。
  // 有 raw 时它们只落盘、不挂成断言证据；没有 raw 的通道才把 .txt 挂上兜底。
  const hasRaw = main.raw !== undefined;
  const side = (rel, body) => { writeFileSync(join(dir, rel), mask(ROOT, body)); };
  if (pm.data) (hasRaw ? side : put)(`evidence/obs/${base}.json`, JSON.stringify(pm.data, null, 1));
  if (guardsOf(o).some(gd => gd.params) && pg?.data && pg !== pm) put(`evidence/obs/${base}.guard.json`, JSON.stringify(pg.data, null, 1));
  const verdictWord = { pass: 'PASS', fail: 'FAIL', blocked: 'BLOCKED' }[status];
  (hasRaw ? side : put)(`evidence/obs/${base}.txt`, [
    `########## ${c.case} / ${id} ##########`,
    `采集时间: ${new Date().toISOString()}`, '',
    `断言: ${id} — ${e.assert}`,
    `预期: ${(usedChecks || []).map(ch => `${ch.pick} ${fmtPred(ch.predicate)}`).join(' 且 ')}${guardsOf(o).length ? `（前提：${guardsOf(o).map(gd => `${gd.pick} ${fmtPred(gd.predicate)}`).join('；')}）` : ''}`,
    `命令: ${main.cmdLine || '—'}`,
    `实际:`, ...lines.map(l => '      ' + l),
    `判定: ${verdictWord} —— ${reason}`, '',
  ].join('\n'));
  // 不再渲染文字卡片：文字转成的图片是无效证据；图只认 UI 通道读值那一刻的 app 截图（上面的 ui_shot）

  if (!r.results[id]) r.results[id] = { status: 'todo', actual: '', evidence: [] };
  const cur = r.results[id];
  const restored = cur.status === 'todo' && cur.reverted_from === status;
  const changed = cur.status !== status && !restored;
  delete cur.reverted_from;
  cur.status = status;
  cur.actual = mask(ROOT, `[observe] ${reason}；${lines.join('；')}`.slice(0, 1200));
  // 重新观测 = 新结论**替换**旧的：同一断言先前 observe 产出的证据摘下（文件留在磁盘作历史），
  // 否则新的 BLOCKED 旁边还挂着旧的 FAIL，自相矛盾。
  // 只摘 obs-<id>-* 不够 —— 手挂的执行计划、旧摘要会一直挂着，被盲审逐份驳回后把新结论也拖回 todo。
  //    observe 产出的是这条结果性断言的全部判据，旧证据一律摘下（留在 superseded 台账，文件不删）。
  const stale = (cur.evidence || []).filter(x => !evs.includes(x));
  cur.evidence = [...new Set([...evs, ...(cur.evidence || []).filter(x => !stale.includes(x))])];
  if (stale.length) { cur.superseded = [...new Set([...(cur.superseded || []), ...stale])]; for (const x of stale) delete r.reviews?.[rkey(id, x)]; }
  cur.observed = { op: usedOp, exec: usedRecipe?.exec || null, at: new Date().toISOString(), offline: !!opt['from-file'], strength,
                   ...(ladder.length > 1 ? { ladder } : {}) };
  if (status === 'blocked') cur.blocked_kind = badG?.gd.blocked_kind || 'capability'; else delete cur.blocked_kind;
  // 前提不成立判 blocked 时也要进阻塞台账（否则 observe 判的 blocked 会绕过台账，直到 report 才被闸撞出来）
  if (status === 'blocked') {
    const demand = demandOfRun(ROOT, r, c);
    const b = raiseBlocker(ROOT, { demand, run, caseName: c.case, expect: id, kind: cur.blocked_kind,
      text: cur.actual, unlock: badG ? `让前提成立：${badG.gd.why || badG.gd.pick || '见 observe 规格的 guard'}`
        : pm.error ? `修好观测通道：${pm.error}`
        : '接入证据强度够的观测通道（断言的 min_strength），或由 owner 决定这条降低要求' });
    if (b && !b.reported) console.error(`   📮 已登记阻塞 ${b.id}（${id}）—— 补解锁条件与复盘后 acceptkit blockers ${demand} --raise`);
  } else closeBlockersOn(run, r, c, id, status);
  r.reviews ??= {};
  for (const x of cur.evidence) {
    const k = rkey(id, x);
    // 带内容指纹：没有 fp 的机判会在下一次 record 对账时被当成「没记指纹」作废（observe 之后再 record 补证据，obs 证据会被打回 pending）
    if (evs.includes(x)) r.reviews[k] = { state: 'ok', by: 'machine', note: 'observe 谓词机判：原文与判定由工具产出', at: new Date().toISOString(), fp: evFingerprint(runDir(run), x) };
    else if (changed && r.reviews[k]) r.reviews[k] = { state: 'pending', at: new Date().toISOString(), note: '判定变了，旧复核作废' };
  }
}

// 渲染操作树为 markdown 嵌套列表；每节点带聚合状态点，每断言带 icon + actual + 证据
function renderTree(nodes, c, res, depth = 0, prefix = 'n') {
  let md = '';
  (nodes || []).forEach((n, idx) => {
    const nodeId = `${prefix}${idx + 1}`;
    const ns = nodeStatus(n, res);
    const tags = n.tags ? ' `' + Object.entries(n.tags).map(([k, v]) => `${k}:${v}`).join(' ') + '`' : '';
    md += `${'  '.repeat(depth)}- ${ICON[ns]} \`${nodeId}\` **${n.op}**${tags}\n`;
    // 过程证据（节点级）：走这一步时留下的截图/API 原文，独立于断言证据
    const st = (res.steps || {})[nodeId];
    if (st && (st.evidence || []).length) {
      md += `${'  '.repeat(depth + 1)}- 🎞️ *过程证据*：${st.evidence.map(renderEv).join(' ')}${st.note ? ' — ' + st.note : ''}\n`;
    }
    for (const e of n.expect || []) {
      const r = res.results[e.id] || { status: 'todo' };
      const act = r.actual ? ` — ${r.actual}` : '';
      const find = r.finding ? ` **[${r.finding}]**` : '';
      const ev = (r.evidence || []).map(x => renderEv(x)).join(' ');
      // 判定方式与证据强度（只有记了强度的观测结论才显示；降级要写出来）
      const how = r.observed?.strength ? ` ⟨判定：${r.observed.op} · ${r.observed.strength}${r.observed.ladder ? ` · 降级自 ${r.observed.ladder[0].op}` : ''}⟩` : '';
      md += `${'  '.repeat(depth + 1)}- ${ICON[r.status]} \`${e.id}\` ${e.assert}${act}${find}${how}${ev ? ' ' + ev : ''}\n`;
    }
    if (n.conclusion) md += `${'  '.repeat(depth + 1)}- ⇒ **${n.conclusion}**\n`;
    if (n.children) md += renderTree(n.children, c, res, depth + 1, `${nodeId}.`);
  });
  return md;
}
// 证据带类型图标：📷=截图(进 gallery)，🧾=机器证据(run 目录下的 evidence 文件)，📄=引用(src:/api:)。
function isShot(x) { return /\.(png|jpe?g)$/i.test(x); }
// 机器证据 = 这次 run 真正落盘的产物（探针 evidence JSON、spec、日志）。headless 验收的**主证据**
// 就是它 —— 不是截图。区分开是因为闸门要按载体判：UI 操作认截图，headless 探针认这个。
function isMachineEv(x) { return /^(evidence|runs)\/.+\.(json|txt|log|ndjson)$/i.test(x); }
function renderEv(x) { return `${isShot(x) ? '📷' : isMachineEv(x) ? '🧾' : '📄'}\`${x}\``; }
// 节点/断言的载体：从 case 的 tags.carrier 读。app/ui = 有界面可拍；其余 = headless。
const UI_CARRIERS = new Set(['ui', 'app_ui', 'page']);
// 项目配置 report.uiSteps = 'all'：用例不打 carrier 标签的项目，所有步骤都按界面步骤要求截图
function isUINode(tags) { return CFG.report?.uiSteps === 'all' || UI_CARRIERS.has(String(tags?.carrier ?? '')); }

function cmdReport({ pos }) {
  const run = pos[0] || die('用法：acceptkit report <run> [--force]');
  const res = loadResult(run);
  // 旧引擎产生的运行（没有需求归属）按当时的规矩出过报告；用现在更严的规则重出会改写历史结论（例如 PASS → PARTIAL）。
  // 默认保留原报告；确实要按新规则重出，显式 --force。
  if (!res.demand && !parseArgs(process.argv.slice(3)).opt.force)
    die(`run ${run} 是旧引擎产生的运行（没有需求归属），已有的报告是按当时规则出的；按现在的规则重出会改写历史结论。保留原报告；确实要重出加 --force`);
  const c = loadCase(res.case_ref || res.case);
  const exps = allExpects(c);
  const tally = Object.fromEntries(STATUSES.map(s => [s, 0]));
  for (const e of exps) tally[res.results[e.id]?.status || 'todo']++;
  const fails = exps.filter(e => res.results[e.id]?.status === 'fail');
  const cov = coverage(c);
  let verdict = tally.fail ? 'FAIL' : (tally.blocked || tally.todo) ? 'PARTIAL' : 'PASS';
  // 证据有效性闸（evidence-gate）：未复核/被驳回的证据、没被任何断言引用的图、没证实的主张。
  // 证据还没人核过，就不能叫 PASS。
  const rg = reviewGaps(res, runDir(run));
  const gapUnreviewed = rg.pending, gapRejected = rg.rejected;
  const gapOrphan = orphanImages(runDir(run), res);
  const gapClaims = claimGaps(c, res);
  // 🔴 挂在 pass/fail 断言上的图必须是 observe 产出（ui_observe）或判定卡（card）。
  //    过程截图 / 手工截图占了断言证据位 = 「有图就过」的老病（这类图大多与断言无关）。
  const gapBadImage = [];
  for (const e of exps) {
    const rr = res.results[e.id] || {};
    if (rr.status !== 'pass' && rr.status !== 'fail') continue;
    for (const x of rr.evidence || []) { const k = imageKind(runDir(run), x); if (k && !ASSERT_IMAGE_KINDS.has(k)) gapBadImage.push(`${e.id}:${x}(${k})`); }
  }
  if (verdict === 'PASS' && (gapUnreviewed.length || gapRejected.length || gapClaims.length)) verdict = 'PARTIAL';
  // 证据体检闸门：①断言级 pass/fail 必须有证据；②fail 必须有截图；
  // ③ 执行过的操作节点必须有过程证据 —— 只查断言级的话，全 pass 的 run
  //    只在末尾留几张图也能 gaps=0（evidence 应是全过程，不是最后一步）。
  // 闸门按**载体**判，不一刀切要截图。
  // 病根：headless 探针根本没有 UI 可拍，为了过闸去 `simctl io screenshot` 拍一张首页 ——
  // 那是**凑数证据**，比没有更糟：它让缺口检查失效，看板上还堆一排毫不相干的图。
  // 现在：UI 载体的节点认截图；其余节点认「机器证据」= 这次 run 落盘的 evidence 文件
  // (探针 JSON / spec / 日志)。两者都没有 = 缺口。
  const gapNoEv = [], gapFailWeak = [], gapStepWeak = [];
  const nodes = allNodes(c);
  const steps = res.steps || {};
  const tagsOf = id => nodes.find(n => n.expectIds.includes(id))?.tags;
  const primaryEv = (evs, tags) => isUINode(tags) ? evs.some(isShot) : evs.some(x => isShot(x) || isMachineEv(x));
  for (const e of exps) {
    const r = res.results[e.id] || {};
    if (r.status !== 'pass' && r.status !== 'fail') continue;
    const ev = r.evidence || [];
    if (!ev.length) gapNoEv.push(e.id);
    else if (r.status === 'fail' && !primaryEv(ev, tagsOf(e.id))) gapFailWeak.push(e.id);
  }
  // 节点级：只要该节点有断言被判过 pass/fail，就算「执行过」，必须留主证据
  for (const n of nodes) {
    const executed = n.expectIds.some(id => ['pass', 'fail'].includes(res.results[id]?.status));
    if (!executed) continue;
    const stepEv = (steps[n.nodeId]?.evidence) || [];
    const assertEv = n.expectIds.flatMap(id => res.results[id]?.evidence || []);
    if (!primaryEv([...stepEv, ...assertEv], n.tags)) gapStepWeak.push(`${n.nodeId}(${n.op.slice(0, 18)})`);
  }
  const gapFailNoShot = gapFailWeak, gapStepNoShot = gapStepWeak;
  
  // 把 verdict 回写进 result.json，让 history 不用重算就能读到每次跑的终态。
  res.verdict = verdict; saveResult(run, res);

  const fm = [
    '---',
    `case: ${c.case}`,
    `title: ${c.title || c.case}`,
    `run: ${run}`,
    `run_seq: ${res.run_seq || 1}`,
    `prev_run: ${res.prev_run || ''}`,
    `verdict: ${verdict}`,
    `tally: {${STATUSES.map(s => `${s}: ${tally[s]}`).join(', ')}}`,
    `coverage_uncovered: [${cov.uncovered.join(', ')}]`,
    `method: Classification-Tree-Method × step-wise-expected-result`,
    '---', '',
  ].join('\n');

  let md = fm;
  md += `# ${c.title || c.case} — 验收报告（操作树）\n\n`;
  md += `> **判定 ${verdict}** · ✅${tally.pass} ❌${tally.fail} ⛔${tally.blocked} ⏭️${tally.skip} 🚫${tally.na} ⬜${tally.todo}（共 ${exps.length} 断言）\n\n`;
  // 🔴 反模式二的闸门：整轮跑完看板上一张图都没有。
  // 此前只有「步骤级」检查，而它接受 machine evidence 顶替截图 —— headless 用例每步都有
  // evidence/*.json，于是 gaps=0 而画廊空空。文档里写着「删掉凑数截图后只留纯文本」是错的，
  // 却没有任何东西检查它。正解不是回去拍 app（那是反模式一），是把四段式证据渲染成卡片：
  //   （后来改判：文字渲染出的卡片也不算有效图片证据，见下方 no_visual 的提示。）
  const anyImage = (() => {
    const walk = (d) => { let n = 0;
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const f = join(d, e.name);
        if (e.isDirectory()) n += walk(f);
        else if (/\.(png|jpe?g)$/i.test(e.name)) n++;
      }
      return n; };
    try { return walk(runDir(run)); } catch { return 0; }
  })();
  const gapNoVisual = anyImage ? [] : ['run'];
  // 🔴🔴 有效截图规则：光有图不够，必须有**有效的 app 操作截图**。
  // no_visual 只数 png，而文字渲染出的卡片也是 png —— 于是可以整轮
  // 没有一张真实 app 截图却判 gaps=0。这一条只认 `acceptkit shot` 产出的图（带 sidecar），
  // 因为只有工具自己截的那张才保证了：app 真在跑、画面没被遮蔽层挡着、被测物可追溯。
  const appShots = appShotsOf(run);
  // 「这一轮压根没在端上跑过」的 run 不该被这条闸要求截图 —— 它没有可拍的过程。
  // 判据取最窄的一条：**没有任何 pass / fail 断言**（= 没有任何一条在端上被判过）。
  // 只要有一条 pass 或 fail，就说明确实在端上验过，那就必须有 app 截图。
  // 依据是证据规则本身：「没执行的操作节点不挂过程证据（它只能证明"没做"）」。
  // 例：断言全 skip、已被后续轮次取代的 run，或全 blocked「本轮未跑」的 run，
  // 本来就没东西可拍，不该卡在这条闸上。
  const nothingRan = !exps.some(e => ['pass', 'fail'].includes(res.results?.[e.id]?.status));
  const gapNoAppShot = (appShots.length || nothingRan) ? [] : ['run'];
  if (!appShots.length && nothingRan) console.error(`ℹ️  这一轮没有 app 操作截图，但也没有任何 pass/fail 断言 —— 它没在端上跑过，有效截图规则不适用。`);
  // 被 --allow-obscured 放行的图单独列出来：它们**可能**无效，读报告的人有权知道。
  const obscuredShots = appShots.filter(m => m.allow_obscured_reason).map(m => m.file);
  // 🔴 被测物标识：没有它，报告里的 PASS 不知道是对哪份代码成立的。
  const gapNoProvenance = existsSync(join(runDir(run), 'evidence', 'provenance.json')) ? [] : ['run'];
  // 迁移前的 run（demand 由迁移补的）按当时的规矩记的图：只提示，不计缺口、不改结论 —— 规矩不追溯
  const legacyRun = !!res.demand?.migrated;
  // 没有 app 内真实截图的验收不被接受 —— 每条 pass/fail 都要挂一张
  // UI 通道在读到判据那一刻截的 app 图（sidecar kind=ui_observe）；文本证据照留，但单有文本不算验收完。
  // 判据和看板、next 是同一份（evidence-gate assertionGaps）：报告说是缺口的，看板上就不会是「通过」
  const AG = assertionGaps(runDir(run), res, { expects: exps, ops: loadOps() });
  const gapNoUiShot = exps.filter(e => AG[e.id]?.includes('no_ui_shot')).map(e => e.id);
  const gapNotCollected = exps.filter(e => AG[e.id]?.includes('not_tool_collected')).map(e => e.id);
  const gapCount = gapNoEv.length + gapFailNoShot.length + gapStepNoShot.length + gapNoVisual.length + gapNoAppShot.length + gapNoProvenance.length
    + gapUnreviewed.length + gapRejected.length + gapOrphan.length + gapClaims.length + gapNoUiShot.length + gapNotCollected.length + (legacyRun ? 0 : gapBadImage.length);
  if (verdict === 'PASS' && (gapNoUiShot.length || gapNotCollected.length)) verdict = 'PARTIAL';
  if (verdict === 'PASS' && gapBadImage.length && !legacyRun) verdict = 'PARTIAL';
  if (gapCount) {
    md += `## ⚠️ 证据缺口（${gapCount} 处，必须补齐）\n\n`;
    if (gapNoEv.length) md += `- **无任何证据**（pass/fail 却没证据）：\`${gapNoEv.join('` `')}\`\n`;
    if (gapNotCollected.length) md += `- **声明了命令行验证，但证据不是 observe 亲自采的**（读的是执行者交来的文件；把采集命令登记成操作库配方，由 observe 去跑）：\`${gapNotCollected.join('` `')}\`\n`;
    if (gapNoUiShot.length) md += `- **pass/fail 没有 app 内真实截图**（要 \`acceptkit observe\` 的 UI 通道在读到判据那一刻截的图）：\`${gapNoUiShot.join('` `')}\`\n`;
    if (gapFailNoShot.length) md += `- **fail 缺主证据**（UI 载体要截图；headless 要 run 目录下的证据文件）：\`${gapFailNoShot.join('` `')}\`\n`;
    if (gapNoAppShot.length) md += `- **整轮没有有效的 app 操作截图**（有效截图规则）：验收过程与结果必须有能证明它的真实 app 截图。\n`
      + `  用 \`acceptkit shot ${run} --sim <udid> --label <名字>\` 截 —— 它会先查遮蔽层（登录页/权限弹窗/协议页），挡着就拒绝并告诉你怎么关。\n`;
    if (obscuredShots.length) md += `- ⚠️ **有 ${obscuredShots.length} 张截图是被 \`--allow-obscured\` 放行的**（画面存在遮蔽层）：\`${obscuredShots.join('` `')}\` —— 复核时要单独确认它们是否仍能支撑结论。\n`;
    if (gapStepNoShot.length) md += `- **操作节点缺主证据**（每走一步就留一次；UI=截图，headless=探针产物）：\`${gapStepNoShot.join('` `')}\`\n`;
    if (gapUnreviewed.length) md += `- **证据未复核**（${gapUnreviewed.length} 份；\`acceptkit review ${run} --next\`）：\`${gapUnreviewed.slice(0, 20).join('` `')}\`${gapUnreviewed.length > 20 ? ' …' : ''}\n`;
    if (gapRejected.length) md += `- **证据被驳回、尚未补齐**：\`${gapRejected.join('` `')}\`\n`;
    if (gapOrphan.length) md += `- **孤儿图**（run 目录里有、但没有任何断言/步骤引用 —— 看板不展示；要么挂到它证明的断言上，要么移出 run 目录）：\`${gapOrphan.join('` `')}\`\n`;
    if (gapClaims.length) md += `- **用例主张未被证实**：${gapClaims.map(x => `\n  - ${x}`).join('')}\n`;
    if (gapBadImage.length && !legacyRun) md += `- **断言证据位上挂了非判定图**（过程截图 / 手工截图只证明环境，不证明判定；断言的图由 observe 产出或渲成判定卡）：\`${gapBadImage.join('` `')}\`\n`;
    md += `\n> 证据 = 全过程，不是最后一步。UI 载体留 \`shots/NN-xxx.png\`，headless 载体留 \`evidence/NN-xxx.json\`（探针产物 / spec / 日志）。
> **不要为了过闸拍无关截图** —— 凑数证据比缺证据更糟，它让这个闸门失效。\n\n`;
  }
  // ── 闸 3/4：报告只讲「过」和「不过」；没测完的必须在执行期就提过 ──
  // 测试报告一般只讲通过和不通过的内容，不讲「我没测试完成」；
  //   没测试完成（包括因为某个原因没测试完成）都应该在执行期当场提出来。
  // 所以 blocked 不进报告正文，改成附录「执行期已上报的阻塞」+ owner 的答复；
  // 而**只要还有一条阻塞没提给 owner，报告就不许出**（这是让阻塞当场上报真正发生的唯一办法）。
  const demandId = demandOfRun(ROOT, res, c);
  const blks = demandId ? readBlockers(ROOT, demandId).filter(b => b.run === run) : [];
  // ⚠️ 这里漏了 `!b.resolved`，而 `blockers --raise` 的 todo 集合是 `!reported && !resolved` ——
  //    于是「我自己解掉但没提过」的条目会被这道闸永远判成「还没提」，而 --raise 又永远不会提它，
  //    报告被死锁。两边口径必须一致。
  const unreported = blks.filter(b => !b.reported && !b.resolved);
  const blockedIds = exps.filter(e => res.results[e.id]?.status === 'blocked').map(e => e.id);
  // 自审补洞：blocked 挡住了，todo 却能直接穿过去 —— 而 todo 同样是「没测完」，
  // 只是连「为什么没测」都没写。报告里不许出现它：要么去跑，要么记成 blocked 并提给 owner。
  // 结论继承自更早一轮的（开轮时影响评估定了沿用）不是「没测完」：next 不给它出卡片，这里也不能拦，否则 next 说该出报告、report 却出不来
  const carried = demandId ? carriedExpects(ROOT, demandId, c.case) : new Set();
  const inheritedIds = exps.filter(e => (res.results[e.id]?.status || 'todo') === 'todo' && carried.has(e.id)).map(e => e.id);
  const todoIds = exps.filter(e => (res.results[e.id]?.status || 'todo') === 'todo' && !carried.has(e.id)).map(e => e.id);
  if (todoIds.length) die(`报告不出 —— 还有 ${todoIds.length} 条断言是 todo（连「为什么没测」都没写）：${todoIds.join(', ')}\n`
    + `   报告只讲「过」和「不过」。这些要么去跑，要么记成 blocked 并说清解锁条件：\n`
    + `   acceptkit record ${run} --expect <id> --status blocked --blocked-kind capability|dependency --unlock "<owner 要做什么>"`);
  const unlogged = blockedIds.filter(id => !blks.some(b => b.expect === id));
  if (unreported.length || unlogged.length) die([`报告不出 —— 这一轮还有没提给 owner 的阻塞。`,
    ...(unlogged.length ? [`   · ${unlogged.length} 条 blocked 没登记进阻塞台账（多半是闸上线前记的）：${unlogged.join(', ')}\n`
      + `     补登记：acceptkit blockers ${demandId || '<demand>'} --backfill ${run}`] : []),
    ...(unreported.length ? [`   · ${unreported.length} 条已登记但还没提：${unreported.map(b => b.id).join(', ')}\n`
      + `     生成话术并标记已提：acceptkit blockers ${demandId} --raise`] : []),
    `   为什么卡住：报告里出现「因为 XXX 没测完」= 这条本该在执行期就提给 owner，而不是让他从报告里读到。`].join('\n'));

  md += `## 操作树 × 节点断言\n\n每个操作(节点)挂它自己的预期；断言前的图标=该预期实测；断言后 📷=截图 📄=文本证据；节点前图标=其子树聚合。\n\n`;
  md += renderTree(c.tree, c, res) + '\n';

  md += `## 分类树覆盖（CTM）\n\n`;
  for (const [k, m] of Object.entries(cov.hit)) md += `- **${k}**：` + Object.entries(m).map(([v, n]) => `${v}(${n})`).join(' ') + '\n';
  md += cov.uncovered.length ? `- ⚠️ 未覆盖：${cov.uncovered.join(', ')}\n\n` : `- ✅ 全覆盖\n\n`;

  if (fails.length) {
    md += `## 发现（失败断言 → 精确定位）\n\n`;
    for (const e of fails) {
      const r = res.results[e.id];
      md += `### ❌ \`${e.id}\`${r.finding ? ` [${r.finding}]` : ''} — ${e.assert}\n`;
      md += `- **操作路径**：${e.path.join(' → ')}\n`;
      md += `- **切面**：${Object.entries(e.tags).map(([k, v]) => `${k}:${v}`).join(' ') || '—'}\n`;
      md += `- **实际**：${r.actual || '（未记录）'}\n`;
      const evs = r.evidence || [];
      md += `- **证据**：${evs.length ? evs.map(renderEv).join(' · ') : '⚠️ 无证据'}${evs.length && !evs.some(isShot) ? '（⚠️ 无截图）' : ''}\n`;
      md += '\n';
    }
  }

  // 一个需求同一平台本该只用一台：这一轮另起了第二台的，理由摆给 owner 看（core/parallel.mjs）
  if ((res.parallel_devices || []).length) {
    md += `## 第二台设备（双跑）\n\n`;
    md += res.parallel_devices.map(p => `- 本轮用 ${res.device?.key || '?'}，需求原来那台是 ${p.with}（run ${p.with_run}）· 理由 ${p.kind}：${p.why}`
      + (p.quote ? `（${p.approved_by} 原话「${p.quote}」）` : p.case_why ? `（用例：${p.case_why}）` : p.unfit ? `（那台：${p.unfit.join('；')}）` : '')).join('\n') + '\n\n';
  }

  if (inheritedIds.length) {
    md += `## 沿用上一轮结论（本运行没重测）\n\n`;
    md += `> 开轮时的影响评估判定这些断言不受改动影响，结论沿用更早一轮；它们不计入本运行的通过 / 不通过，看板「本轮状态」里显示为继承。\n\n`;
    md += inheritedIds.map(id => `- \`${id}\` — ${exps.find(e => e.id === id)?.assert || ''}`).join('\n') + '\n\n';
  }

  if (blks.length) {
    md += `## 附录：执行期已上报的阻塞（不计入结论）\n\n`;
    md += `> 这些断言**没有被证伪过**，所以既不算通过也不算不通过。每一条在执行当时就提给了 owner，`
       + `下表的 \`提出时间\` 与 \`owner 答复\` 是那次沟通的留痕。\n\n`;
    md += `| # | 断言 | 归类 | 解锁条件 | 提出时间 | owner 答复 |\n|---|---|---|---|---|---|\n`;
    for (const x of blks) md += `| ${x.id} | \`${x.expect}\` | ${x.kind} | ${x.unlock || '⚠️ 未写'} | ${(x.raised_at || '').slice(0, 16).replace('T', ' ')} | ${x.answer || '（待答复）'} |\n`;
    md += `\n`;
  }

  // ── 本轮装置故障（evidence-gate D）──
  // 🔴 这一节**不计证据缺口、不改判定**：装置故障一旦压低结论，隐瞒它就有了收益。
  //    它只做两件事 —— 给这份报告的可信度标价，给基建出清单。
  const aps = res.apparatus || [];
  if (aps.length) {
    md += `## 本轮装置故障（${aps.length} 次）\n\n`;
    md += `> 这些是**取证手段自己**坏了（连错设备 / 探针顺序错 / 抓到上一轮的日志 / 证据落空 / 装了多次才稳），`
       + `与被测物的行为无关，所以**不计入结论、不改判定**。保留它们有两个用处：\n`
       + `> ① 一轮里装置坏了 ${aps.length} 次，这份报告的可信度就该按这个数字折价；\n`
       + `> ② 每一条都是基建该补的清单 —— 不记下来，下一轮还会再踩一次。\n\n`;
    md += `| # | 在哪 | 现象 | 判据 | 怎么绕过 / 修的 |\n|---|---|---|---|---|\n`;
    const cell = x => String(x || '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 200);
    for (const a of aps) md += `| ${a.id} | ${a.where === 'run' ? '整轮' : '`' + a.where + '`'} | ${cell(a.text)}`
      + `${a.cost ? `（折腾 ${a.cost} 轮）` : ''} | ${a.markers?.length ? a.markers.map(m => '`' + m + '`').join(' ')
      : a.source === 'review' ? `盲审 ${a.verdict}` : '执行者登记'} | ${cell(a.fix) || '⚠️ 未写'} |\n`;
    md += `\n`;
  }

  md += `## MACHINE-READABLE（AI 解析）\n\n\`\`\`json\n` + JSON.stringify({
    case: c.case, run, verdict, tally, coverage: cov,
    demand: demandId, platform: res.platform || res.device?.platform || c.platform || null,
    evidence_gaps: { no_evidence: gapNoEv, no_ui_shot: gapNoUiShot, fail_no_screenshot: gapFailNoShot, step_no_screenshot: gapStepNoShot, no_visual: gapNoVisual, no_app_shot: gapNoAppShot, obscured_shots: obscuredShots, no_provenance: gapNoProvenance,
                     unreviewed: gapUnreviewed, rejected: gapRejected, orphan_image: gapOrphan, unproven_claim: gapClaims, bad_assert_image: gapBadImage, self_reviewed_only: rg.selfOnly },
    expectations: exps.map(e => ({ id: e.id, path: e.path, tags: e.tags, assert: e.assert, ...res.results[e.id] })),
    blockers_raised: blks.map(b => ({ id: b.id, expect: b.expect, kind: b.kind, unlock: b.unlock, raised_at: b.raised_at, answer: b.answer, resolved: !!b.resolved, resolved_how: b.resolved_how })),
    apparatus_failures: aps,
  }, null, 2) + `\n\`\`\`\n`;

  const out = join(runDir(run), 'run.md');
  writeFileSync(out, mask(ROOT, md));   // #secret 的值不进报告
  // run.json：给看板用（显式状态 + 标题）
  const dashStatus = verdict === 'PASS' ? 'pass' : verdict === 'FAIL' ? 'fail' : tally.pass ? 'mixed' : 'wip';
  // parent_run → 看板显示 ↳续 标记（第 N 次跑挂在上一次上），title 带 rN 便于区分同 case 多次跑。
  const rtitle = (c.title || c.case) + (res.run_seq > 1 ? ` · 第${res.run_seq}次` : '');
  // gates 也要进看板：跑过哪些租户闸、拦没拦，是"这轮动过什么"的安全审计线索
  const gates = (res.gates || []).map(g => ({ action: g.action, verdict: g.verdict, tenants: [...new Set((g.checked || []).map(c => c.val))], ...(g.destructive ? { destructive: g.destructive } : {}) }));
  writeFileSync(join(runDir(run), 'run.json'), JSON.stringify({ title: rtitle, status: dashStatus, parent_run: res.prev_run || null, session_id: res.case, demand: demandId, platform: res.platform || res.device?.platform || null, evidence_gaps: gapCount, apparatus: aps.length, gates }, null, 2));
  console.log(`📄 报告 → ${out}（${verdict}；✅${tally.pass} ❌${tally.fail}）+ run.json(status=${dashStatus})`);
  // 报告地址：直接给网址（管理页面上停在这份报告），不只给文件路径 —— 用户要「报告地址」时要的是能点开的链接。
  // 走 acceptkit link，网址规则只在 links.mjs 一处。--no-start：出报告不顺手起 / 重启管理页面 ——
  // 后台起的服务活得比这次调用久（测试里会占住缺省端口，真的 link 就起不来）；要起由 link / open 来。
  const lk = spawnSync(process.execPath, [join(REPO_ROOT, 'bin', 'acceptkit.mjs'), 'link', run, '--json', '--no-start'], { encoding: 'utf8', timeout: 20_000, env: { ...process.env, ACCEPTKIT_PROJECT: ROOT } });
  let url = null; try { url = JSON.parse(lk.stdout).url; } catch { /* 取不到就如实说 */ }
  console.log(url ? `🔗 报告地址：${url}` : `🔗 报告地址没取到（${(lk.stderr || '').trim().replace(/^acceptkit: /, '') || '管理页面没起来'}）：acceptkit link ${run}`);
  const freed = releaseLeasesOfRun(run);
  if (freed.length) console.log(`🔓 已自动释放本轮占着的机器：${freed.join(', ')}`);
  if (gapNoProvenance.length) console.error(`⚠️  这轮没有被测物标识（evidence/provenance.json）——\n` +
    `    报告里的结论将不知道是对哪个分支/哪个 commit/哪套依赖版本成立的。\n` +
    ((PACK.commands || {}).provenance
      ? `    验收开始前先跑：acceptkit provenance ${run} --target "<在验什么>" --repo NAME=PATH [--pin K=V] [--device S] [--artifact F]`
      : `    验收开始前先记下被测物：acceptkit sut ${run} --target "<在验什么>" [--repo 名字=路径] [--app <包名> --device <设备>] [--url <网址>]`));
  if (gapNoAppShot.length) console.error(`⚠️  有效截图规则：这一轮没有任何**有效的 app 操作截图** —— 验收过程和结果必须有真实 app 画面能证明。\n` +
    `    acceptkit shot ${run} --sim <udid> --label <名字> [--expect E | --step nN]\n` +
    `    它会先查遮蔽层（登录页 / 权限弹窗 / 隐私协议页 / Loading 蒙层），挡着就拒绝并告诉你怎么关 —— 别拍一张被挡住的无效图。`);
  if (obscuredShots.length) console.error(`⚠️  有 ${obscuredShots.length} 张截图带 --allow-obscured（画面有遮蔽层）：${obscuredShots.join(' ')} —— 复核会盯这几张。`);
  // 把四段式排版成图的「证据卡片」是**无效图片证据**，一律不许再渲：
  //   它只是把文字转成了图片，不比文字本身多证明任何东西。
  // 所以这一条只保留「过程截图」那一半，删掉引导去渲卡片的那一半 —— 判据面没有 UI 的断言
  // 本来就不该有图，缺图不是缺口，不许为了过闸配图。
  if (gapNoVisual.length) console.error(`⚠️  这轮跑完 run 目录里一张图都没有。\n` +
    `    如果这一轮**有** app 操作，补过程截图：acceptkit shot ${run} --sim <udid> --label <名字> [--expect E | --step nN]\n` +
    `    如果这一轮全是运行时值/决策记录/CLI 原文（判据面没有 UI），那就**不该有图** —— 判据交给文本原文，\n` +
    `    ⛔ 不许用卡片渲染工具把四段式排版成图来过这个闸（那是无效图片证据）。`);
  if (gapNoEv.length + gapFailNoShot.length + gapStepNoShot.length) console.error(`⚠️  证据缺口 ${gapCount} 处：${gapNoEv.length ? '无证据['+gapNoEv.join(',')+'] ' : ''}${gapFailNoShot.length ? 'fail无截图['+gapFailNoShot.join(',')+'] ' : ''}${gapStepNoShot.length ? '操作节点无过程截图['+gapStepNoShot.join(',')+']' : ''} —— 证据要覆盖全过程，补 --step/--evidence 后重跑`);
  if (gapUnreviewed.length || gapRejected.length) console.error(`🔎 证据复核：待审 ${gapUnreviewed.length} · 驳回未补 ${gapRejected.length} —— acceptkit review ${run} --next`);
  if (gapOrphan.length) console.error(`🖼  孤儿图 ${gapOrphan.length} 张（没有断言/步骤引用，看板不展示）：${gapOrphan.join(', ')}`);
  if (gapClaims.length) console.error(`📣 用例主张未证实：\n   · ${gapClaims.join('\n   · ')}`);
  if (gapBadImage.length) console.error(`🖼  ${gapBadImage.length} 张非判定图占着断言证据位${legacyRun ? '（早期格式的 run（证据身份规则生效前），只提示不计缺口）' : '（用 record --supersede 摘下，改挂 --step）'}：${gapBadImage.join(' ')}`);
  if (rg.selfOnly.length) console.error(`   ℹ️  ${rg.selfOnly.length} 份证据只有执行者自审（--by self），不是独立复核`);
  if (aps.length) console.error(`🔧 本轮装置故障 ${aps.length} 次（取证手段自己坏了，不计入结论）：${aps.map(a => a.id).join(' ')}`
    + `${aps.some(a => !a.fix) ? ` —— ${aps.filter(a => !a.fix).length} 条没写修法，补：acceptkit apparatus ${run}` : ''}`);
  return reportCard(run, { verdict, tally, md: out, json: join(runDir(run), 'run.json'), url, gaps: gapCount });
}

function cmdBug({ pos }) {
  const run = pos[0] || die('用法：acceptkit bug <run> --expect <失败断言 id>');
  const { opt } = parseArgs(process.argv.slice(3));
  const id = opt.expect || die('缺 --expect');
  const res = loadResult(run);
  const c = loadCase(res.case_ref || res.case);
  const e = allExpects(c).find(x => x.id === id) || die(`断言 ${id} 不存在`);
  const r = res.results[id] || {};
  const lines = [
    `# BUG · ${c.title || c.case} · ${id}${r.finding ? ` [${r.finding}]` : ''}`, '',
    `- **状态**：${ICON[r.status] || ''} ${r.status || 'todo'}`,
    `- **操作路径**：${e.path.join(' → ')}`,
    `- **切面**：${Object.entries(e.tags).map(([k, v]) => `${k}:${v}`).join(' ') || '—'}`,
    `- **预期**：${e.assert}`,
    e.machine ? `- **机器谓词**：\`${e.machine}\`` : '',
    `- **实际**：${r.actual || '（未记录）'}`,
    (r.evidence || []).length ? `- **证据**：\n${r.evidence.map(x => `  - \`${x}\``).join('\n')}` : '- **证据**：（无）',
    '', `> 复现：按操作路径逐步执行到「${e.op}」，检查预期「${e.assert}」。`,
  ].filter(Boolean);
  console.log(lines.join('\n'));
}

// acceptkit history <case> — 同一用例多次跑的链 + 最终状态（首次/二次/三次…的演进）。
function cmdHistory({ pos }) {
  const c = loadCase(pos[0] || die('用法：acceptkit history <case>'));
  const runs = priorRunsForCase(c.case, null);
  if (!runs.length) { console.log(`${c.case}：暂无 run`); return; }
  console.log(`用例 ${c.case} 的历史（共 ${runs.length} 次跑）：`);
  for (const r of runs) {
    const v = r.verdict || '(未 report)';
    const fails = Object.entries(r.results || {}).filter(([, x]) => x.status === 'fail').map(([id]) => id);
    console.log(`  第${r.run_seq || '?'}次  ${r.run}  → ${v}${fails.length ? '  ❌' + fails.join(',') : ''}${r.prev_run ? '  ↳续 ' + r.prev_run : ''}`);
  }
  const last = runs[runs.length - 1];
  console.log(`\n最终状态（最新一次 ${last.run}）：${last.verdict || '(未 report)'}`);
}

// 列出操作节点编号（记过程证据时用）
function cmdSteps({ pos }) {
  const c = loadCase(pos[0] || die('用法：acceptkit steps <case> 或 acceptkit steps <run>'));
  const nodes = allNodes(c);
  console.log(`${c.case} 的操作节点（过程证据挂这里）：`);
  for (const n of nodes) {
    const depth = (n.nodeId.match(/\./g) || []).length;
    console.log(`  ${'  '.repeat(depth)}${n.nodeId.padEnd(7)} ${n.op.slice(0, 60)}${n.expectIds.length ? '  [' + n.expectIds.join(',') + ']' : ''}`);
  }
  console.log(`\n每走一步就记：acceptkit record <run> --step ${nodes[0]?.nodeId || 'n1'} --evidence shots/NN-xxx.png`);
  const plat = c.platform || '(未声明 —— validate 会拒)';
  const withOp = nodes.filter(n => n.op_id);
  if (withOp.length) {
    console.log(`\n本用例引用的操作（平台 = ${plat}，怎么做见操作库 acceptkit ops <id>）：`);
    for (const n of withOp) {
      const pf = plat === 'both' ? 'ios' : plat;
      const r = opRecipe(n.op_id, pf, hostOfCase(c, pf));
      console.log(`  ${n.nodeId}  ${n.op_id} —— ${r.title || ''}`);
      if (r.error || r.absent) console.error(`      ⚠️ ${r.error || r.note}`);
      else {
        console.log(`      怎么做：${r.how}`);
        if (r.switches) console.log(`      开关：${r.switches.join(' ')}`);
        if (r.caveat) console.log(`      ⚠️ ${r.caveat}`);
      }
    }
  }
}

// ---- probe：调查/复现型 run 的正规入口 ----
// 病因：工具若只服务"验收用例"，一遇到"临时复现个 bug/查个问题"
// 就没有对应命令 → 手建 runs/xxx/ 堆散文件 → 绕过工具 → 看板只能"推断" → 收口全靠自觉。
// probe 把调查也纳入 acceptkit：一步生成最小调查 case(可后续 record --step 追加节点/断言)+ run，
// 走一样的 record/report/证据闸门/看板收口。调查不再是工具之外的野路子。
function cmdProbe({ pos }) {
  const slug = pos[0] || die('用法：acceptkit probe <slug> [标题] --demand <D-id> [--demand-title "…"] --platform ios|android');
  const title = pos.slice(1).join(' ') || `调查：${slug}`;
  const { opt } = parseArgs(process.argv.slice(3));
  const caseId = `probe-${slug}`;
  const p = casePath(caseId);
  if (!existsSync(p)) {
    const demand = resolveDemand(opt, '新建调查');
    const platform = opt.platform ? String(opt.platform) : (loadPlan(ROOT, demand.id)?.platform || die(`新建调查要给 --platform ${PLATFORMS.join('|')}（需求 ${demand.id} 的评审单也没声明平台）`));
    if (!PLATFORMS.includes(platform)) die(`--platform 只能是 ${PLATFORMS.join('|')}`);
    const tpl = {
      case: caseId, title, kind: 'probe', platform, origin: { id: demand.id, title: demand.title },
      note: '调查/复现型 run。节点边查边加：acceptkit record <run> --step <nodeId> --evidence ...；结论断言直接 record --expect FINDING1 --status fail/pass。',
      classifications: { phase: ['repro', 'root-cause', 'verify'] },
      tree: [{
        op: 'P1 复现/取证（贴 API、页面、日志证据）', tags: { phase: 'repro' },
        expect: [{ id: 'FINDING1', assert: 'TODO：这次调查的结论（复现成立/根因/是否 bug）' }],
      }],
    };
    if (!existsSync(CASES)) mkdirSync(CASES, { recursive: true });
    writeFileSync(p, JSON.stringify(tpl, null, 2));
    console.log(`🔎 调查 case → ${p}（可随时编辑加节点/断言）`);
  }
  process.argv.splice(3, process.argv.length - 3, ...(opt.demand ? ['--demand', String(opt.demand)] : []));
  cmdRun({ pos: [caseId] });
  console.log(`   记结论：acceptkit record <上面的 run> --expect FINDING1 --status fail --actual "..." --evidence api:evidence/xx.json`);
  console.log(`   收口：acceptkit report <run>  —— 出 run.md + run.json，看板不再"推断"`);
}

// ---- 目标闸 (target gate) ----
// 任何「会改被测端状态」的动作（装包、重装、清数据、改存储、连真机、对后台的写操作）之前必须过闸。
// **无法确认目标 = 不放行**（缺省拒绝）——白名单才是安全的那一侧，黑名单永远补不全。
// 白名单是项目数据（acceptkit.project.json 的 gate），不是代码：
//   allow:      [{ "value": "<设备号/包名/租户号>", "kind": "device|bundle|tenant", "note": "…", "onlyOn": "android" }]
//   targetKeys: 对象里哪些字段名算「目标」（正则）；embeddedKeys：多层编码的 JSON 串里按正则兜底找的字段；
//   urlKeys:    --url 的 query 里哪些参数算目标；numericOnly：目标值只认数字（租户号）。
// onlyOn：同一个包名在不同平台含义可能相反（一端是调试包、另一端是正式包），这类条目只在目标设备属于该平台时放行。
const GATE = CFG.gate || {};
const GATE_ALLOW = (GATE.allow || []).map(a => ({ ...a, value: String(a.value) }));
const ALLOWED_SIMS = GATE_ALLOW.filter(a => a.kind === 'device').map(a => a.value);
const ALLOWED_PLAIN = GATE_ALLOW.filter(a => a.kind !== 'device' && !a.onlyOn).map(a => a.value);
const isAndroidEmu = v => /^emulator-\d+$/.test(String(v));
const DEVICE_ALLOW = GATE_ALLOW.filter(a => a.kind === 'device');

// ---- 设备身份 ≠ 设备地址（skill/devices.md 第一节；docs/constraints.md 22a）----
// Android 模拟器的 adb serial 里那个端口按**启动顺序**分配：重启换个顺序，同一个号就指向另一台机器。
// 所以白名单条目、租约键、run 绑定一律认**身份**（`avd:<AVD名>`），serial 只是当次的通信地址。
// 为了不推翻存量数据，两种写法都接受：下面的 aliases 把一个引用展开成「身份 + 当前地址」，
// 白名单命中与租约查找都按这组别名来。
const _aliasCache = new Map();
function deviceAliases(ref) {
  const s = String(ref || '');
  if (_aliasCache.has(s)) return _aliasCache.get(s);
  const out = new Set([s]);
  if (platformOfUdid(s) === 'android') {
    try {
      if (/^avd:/i.test(s)) { const a = ANDROID.addressOf(s); if (a) out.add(a); }
      else { const id = ANDROID.identityOf(s); if (id) out.add(id); }
    } catch {}
  }
  const list = [...out];
  _aliasCache.set(s, list);
  return list;
}
/** 白名单里这台设备在不在（身份写法与地址写法互通） */
const isAllowedDevice = (v) => deviceAliases(v).some(x => ALLOWED_SIMS.includes(x));
/** 租约键：能解出身份就用身份（地址会漂），解不出就用原样 */
const leaseKeyOf = (ref) => { const a = deviceAliases(ref); return a.find(x => /^avd:/i.test(x)) || a[0]; };
/** 在租约表里按别名找（兼容早先以 serial 为键写下的租约） */
function findLease(leases, ref) {
  for (const k of deviceAliases(ref)) if (leases[k]) return [k, leases[k]];
  return [leaseKeyOf(ref), null];
}
const TARGET_KEYS = new RegExp(GATE.targetKeys || '^(sim|udid|device|device_id|bundle|bundle_id|bundleId|app_id|package)$', 'i');
const EMBEDDED_KEYS = GATE.embeddedKeys || String(TARGET_KEYS.source).replace(/^\^\(?|\)?\$$/g, '');
const URL_KEYS = new RegExp(`^(${GATE.urlKeys || EMBEDDED_KEYS})$`, 'i');
const NUMERIC_ONLY = !!GATE.numericOnly;
const okVal = v => NUMERIC_ONLY ? /^\d+$/.test(String(v)) : (typeof v === 'string' || typeof v === 'number');

const isAllowedTarget = (v, targets = []) => {
  const x = String(v);
  if (isAllowedDevice(x) || ALLOWED_PLAIN.includes(x)) return true;
  const cond = GATE_ALLOW.find(a => a.value === x && a.onlyOn);
  // 平台限定条目：只有当本次动作的目标设备里出现了该平台的设备才放行。没有设备信息时不放行（无法确认 ≠ 安全）。
  if (cond) return targets.some(t => platformOfUdid(t.val) === cond.onlyOn || (cond.onlyOn === 'android' && isAndroidEmu(t.val)));
  return false;
};

// 递归收集对象里所有目标类字段；字符串里内嵌的 JSON 也要拆开看
function collectTenants(v, out = [], where = '$') {
  if (v === null || v === undefined) return out;
  if (typeof v === 'string') {
    // 内嵌 JSON 串可能是**多层编码**的（字段值是 JSON 字符串，里面再嵌一层，引号变成 \"）——
    // 先尽力逐层解开，解不开再用容忍转义的正则兜底，两条路都走，避免漏检。
    const s = v.trim();
    if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
      try { collectTenants(JSON.parse(s), out, `${where}(json)`); } catch { /* 落到正则 */ }
    }
    const re = NUMERIC_ONLY ? new RegExp(`\\\\*"(${EMBEDDED_KEYS})\\\\*"\\s*:\\s*(\\d+)`, 'g')
                            : new RegExp(`\\\\*"(${EMBEDDED_KEYS})\\\\*"\\s*:\\s*\\\\*"([^"\\\\]+)`, 'g');
    for (const m of v.matchAll(re)) out.push({ key: m[1], val: m[2], where: `${where}(embedded)` });
    return out;
  }
  if (Array.isArray(v)) { v.forEach((x, i) => collectTenants(x, out, `${where}[${i}]`)); return out; }
  if (typeof v === 'object') {
    for (const [k, val] of Object.entries(v)) {
      if (TARGET_KEYS.test(k) && okVal(val)) out.push({ key: k, val: String(val), where: `${where}.${k}` });
      collectTenants(val, out, `${where}.${k}`);
    }
  }
  return out;
}

function cmdGate({ pos, opt }) {
  const action = opt.action || pos[0] || '(未描述)';
  const found = [];

  for (const t of asList(opt.sim)) found.push({ key: '--sim', val: String(t), where: 'flag' });
  for (const t of asList(opt.bundle)) found.push({ key: '--bundle', val: String(t), where: 'flag' });
  for (const t of asList(opt.tenant)) found.push({ key: '--tenant', val: String(t), where: 'flag' });

  // --json 是所有命令「返回 JSON」的开关（docs/002-protocol.md 第一节），载荷不再走它
  if (opt.json !== undefined) die(`gate 的载荷改用 --payload：--payload '<JSON>' 或 --payload <文件>`);
  // --payload 给文件路径，或直接给 JSON 字面量（避免为了过闸先落盘）。
  // 注意：这里**不能**用 asList —— 它按逗号切分，会把 JSON 切碎。
  const isLiteral = v => /^\s*[\[{]/.test(v);
  for (const v of [].concat(opt.payload ?? []).map(String).flatMap(v => isLiteral(v) ? [v] : asList(v))) {
    const literal = isLiteral(v);
    if (!literal && !existsSync(v)) die(`gate: payload 不存在: ${v}`);
    let j; try { j = JSON.parse(literal ? v : readFileSync(v, 'utf8')); } catch (e) { die(`gate: payload 不是合法 JSON: ${v.slice(0, 80)}`); }
    collectTenants(j, found, literal ? '--payload' : v);
  }
  for (const u of [].concat(opt.url ?? []).map(String)) {
    for (const m of u.matchAll(/[?&]([^=&#]+)=([^&#]*)/g)) {
      if (URL_KEYS.test(m[1]) && okVal(decodeURIComponent(m[2]))) found.push({ key: m[1], val: decodeURIComponent(m[2]), where: 'url' });
    }
  }
  console.log(`${GATE.label || '目标闸'} — 动作：${action}`);
  if (!found.length) {
    console.error(`⛔ 拒绝：没有从入参里识别出任何目标（设备 / 包 / 租户），无法确认动作打在哪里。`);
    console.error(`   缺省拒绝（无法确认 ≠ 安全）。请显式传 --sim / --bundle / --tenant / --url / --payload。`);
    process.exit(3);
  }
  const bad = found.filter(f => !isAllowedTarget(f.val, found));
  for (const f of found) console.log(`   ${isAllowedTarget(f.val, found) ? '✅' : '❌'} ${f.key}=${f.val}  @${f.where}`);
  if (bad.length) {
    console.error(`⛔ 拒绝：出现 ${bad.length} 个白名单外的目标。`);
    console.error(`   白名单（项目配置 gate.allow）：${GATE_ALLOW.map(a => `${a.kind}:${a.value}${a.onlyOn ? `(仅 ${a.onlyOn})` : ''}`).join(' ') || '空'}`);
    console.error(`   命中：${[...new Set(bad.map(b => b.val))].join(', ')}`);
    process.exit(2);
  }
  console.log(`✅ 放行：${found.length} 处目标字段全部在白名单内`);

  // 机器占用（开始验收的机器要记入占用状态，避免竞争）：
  // 白名单只回答「这台能不能动」，回答不了「这台现在是不是别人在用」。目标里的模拟器必须由本 run 占着。
  const sims = [...new Set(found.map(f => f.val).filter(v => isAllowedDevice(v)))];
  if (sims.length) {
    const leases = loadLeases();
    const touched = [];
    for (const u of sims) {
      const [key, l] = findLease(leases, u);
      const shown = key === u ? u : `${u}（身份 ${key}）`;
      if (!opt.run) { console.error(`⛔ 拒绝：动作打在 ${shown} 上，但没带 --run —— 不知道是哪次验收在用这台机器`); process.exit(4); }
      if (!l || leaseAgeH(l) > LEASE_STALE_H) {
        console.error(`⛔ 拒绝：${shown} 没有被 run=${opt.run} 占用${l ? `（原占用 run=${l.run} 已过期）` : ''}。\n   先 acceptkit device status 看机器状态，再 acceptkit device acquire --run ${opt.run}（或手动 device claim ${key} --run ${opt.run} --holder "<迭代/worktree>"）`);
        process.exit(4);
      }
      if (l.run !== String(opt.run)) { console.error(`⛔ 拒绝：${shown} 正被 run=${l.run}（${l.holder}，since ${l.since}）占用 —— 换一台`); process.exit(4); }
      // 一次 run 只打一台（constraints 22b）：run 里已经绑了设备，动作却打在另一台上 —— 拒绝，而不是「以实际跑的为准」。
      // 真实发生过：一轮 Android 验收的证据 4 个文件来自甲机、5 个来自乙机，两台配置还不同，没有任何闸拦下来。
      if (opt.run && existsSync(resultPath(opt.run))) {
        const bound = loadResult(opt.run).device?.key || loadResult(opt.run).device?.udid;
        if (bound && !deviceAliases(u).includes(String(bound)) && leaseKeyOf(bound) !== key) {
          console.error(`⛔ 拒绝：run=${opt.run} 绑定的设备是 ${bound}，这个动作却打在 ${shown} 上。\n   一轮验收只能打在一台机器上（证据出处必须单一）。要换机：acceptkit device release ${bound} --run ${opt.run} 后重新 pick/claim。`);
          process.exit(4);
        }
      }
      // 记下身份：--sim 给的是 serial 时，钩子 H1 按身份认设备（hooks.mjs freshGateFor），只记 serial 会认不出这条闸
      for (const f of found) if (f.val === u && key !== u) f.device = key;
      l.heartbeat = new Date().toISOString();
      touched.push(key);
    }
    saveLeases(leases);
    console.log(`🔒 机器占用核对通过：${touched.join(', ')} 由 run=${opt.run} 占着（已续期）`);
  }

  // 卸载 / 清数据：要给理由，按业务登记的理由评估（core/destructive.mjs）；装包覆盖安装不走这一段
  const kind = destructiveKind(action, opt.destructive && String(opt.destructive));
  let destructive = null;
  if (kind) {
    const c = opt.run && existsSync(resultPath(opt.run)) ? tryLoadCase(loadResult(opt.run).case) : null;
    const caseNeeds = [];
    if (c) walk(c.tree, n => (n.expect || []).forEach(e => { if (e.requires_uninstall) caseNeeds.push({ id: e.id, why: e.uninstall_why || '' }); }));
    const ev = opt.evidence ? String(opt.evidence) : '';
    if (ev && !existsSync(ev)) die(`gate: --evidence 不存在：${ev}`);
    const j = judgeDestructive(kind, { reasons: GATE.reasons || [], caseNeeds,
      opt: { reason: opt.reason && String(opt.reason), why: opt.why && String(opt.why), evidenceText: ev ? readFileSync(ev, 'utf8') : '', approvedBy: opt['approved-by'] && String(opt['approved-by']), quote: opt.quote && String(opt.quote) } });
    if (!j.ok) { console.error(`⛔ 拒绝：${DESTRUCTIVE_KINDS[kind] || kind}的理由不成立。`); for (const l of j.why) console.error(l.startsWith(' ') ? l : `   ${l}`); process.exit(5); }
    destructive = { ...j.record, ...(ev ? { evidence: ev } : {}) };
    console.log(`✅ ${DESTRUCTIVE_KINDS[kind]}的理由成立：${j.record.by === 'owner' ? `owner ${j.record.approved_by} 同意（「${j.record.quote}」）` : j.record.by === 'case' ? `用例要求全新安装（${j.record.expects.join(' ')}）` : `${j.record.reason}：${j.record.when}（为了 ${j.record.purpose}）`}`);
  }

  // 过闸留痕：记进 run 的 result.json，报告里可查
  if (opt.run) {
    const r = loadResult(opt.run);
    // at：钩子 H1 据此放行「刚过闸的那一个动作」，见 hooks.mjs guard_device；卸载 / 清数据只认带 destructive 的那条
    (r.gates ||= []).push({ action, checked: found, verdict: 'pass', at: new Date().toISOString(), ...(destructive ? { destructive } : {}) });
    saveResult(opt.run, r);
    console.log(`   已记入 run ${opt.run} 的 gates`);
  }
  // 装包 / 卸载怎么判是这个人的经验（用户层知识），不是工具规矩：过闸时原样带出来，执行者照着判
  const re = readUserConfig().prefs?.devices?.reinstall;
  if (re && /装|卸|install/i.test(action)) console.log(`   你说过装包时这样判：${re}`);
}



// ---- dispatch ----
// ---- 需求执行轮 ------------------------------------------------------------------------------
// 一个需求有代码变更时，不应该全部重跑，而是评估影响范围后继承 & reset 上次执行的用例状态；
//   每次执行信息包含 分支名称 / commit 信息 / 最新 commit 时间。数据与判法见 core/rounds.mjs。
function runsOfDemand(D) {
  const out = [];
  if (!existsSync(RUNS)) return out;
  for (const d of readdirSync(RUNS)) {
    const p = join(RUNS, d, 'result.json'); if (!existsSync(p)) continue;
    try { const r = JSON.parse(readFileSync(p, 'utf8')); const id = r.demand?.id || r.demand;
          if (id === D) out.push({ id: d, dir: join(RUNS, d), session: r.session || d.slice(0, 10) }); } catch { /* skip */ }
  }
  return out;
}
function safeResult(run) { try { return JSON.parse(readFileSync(resultPath(run), 'utf8')); } catch { return null; } }
function demandExpectKeys(D) {
  const keys = [];
  const plan = loadPlan(ROOT, D);
  const names = new Set(plan ? planCaseSet(plan) : []);
  for (const r of runsOfDemand(D)) { const res = safeResult(r.id); if (res?.case) names.add(res.case); }
  for (const n of names) { if (!existsSync(join(CASES, `${n}.case.json`))) continue; try { for (const e of allExpects(loadCase(n))) keys.push(`${n}::${e.id}`); } catch { /* 用例已删 */ } }
  return keys;
}
function ensureRounds(D) {
  let rf = loadRounds(ROOT, D);
  if (rf) return rf;
  const runs = runsOfDemand(D);
  if (!runs.length) return null;
  rf = { demand: D, repos: [], rounds: deriveHistory(runs, safeResult) };
  saveRounds(ROOT, D, rf);
  return rf;
}
// 当前代码与最新一轮登记的代码是否一致；不一致返回要给人看的话（建 run 时拒绝），一致 / 没配仓返回 null
function roundCodeDrift(D) {
  const rf = ensureRounds(D);
  if (!rf || !rf.repos?.length) return null;
  const last = rf.rounds[rf.rounds.length - 1];
  const moved = [];
  for (const repo of rf.repos) {
    const now = repoSnapshot(repo.path); const was = last?.code?.[repo.name];
    if (now.error) continue;
    if (!was || was.commit !== now.commit) moved.push(`${repo.name}: ${was ? was.commit.slice(0, 10) : '（上一轮未记）'} → ${now.commit.slice(0, 10)} ${now.subject || ''}`);
  }
  return moved.length
    ? `需求 ${D} 的代码相对当前轮 ${last?.id} 变了：\n   ${moved.join('\n   ')}\n` +
      `先评估影响开新轮：acceptkit round new ${D} --assess "<评估结论>" [--reset case::E,case::*] [--reset-why ".."] | [--inherit-all]\n` +
      `（确实要把这次 run 记到旧轮名下：--allow-stale-round）`
    : null;
}
function attachRunToRound(D, run, session) {
  const rf = ensureRounds(D); if (!rf || !rf.rounds.length) return null;
  return rf.rounds[rf.rounds.length - 1].id;   // 成员关系按记录时间算（rounds.mjs），这里只给 result 标个当前轮号便于人看
}
function cmdRound({ pos, opt }) {
  const sub = pos[0] || die('用法：acceptkit round <migrate|repos|new|show> <需求> ...');
  if (sub === 'migrate') {
    const ids = opt.all ? [...knownDemands().keys()] : [pos[1] || die('用法：acceptkit round migrate <需求> | --all [--force]')];
    for (const D of ids) {
      if (loadRounds(ROOT, D) && !opt.force) { console.log(`  ${D}: 已有轮次，跳过（--force 重建）`); continue; }
      const runs = runsOfDemand(D); if (!runs.length) { console.log(`  ${D}: 没有 run`); continue; }
      const prev = loadRounds(ROOT, D);
      // --force 只重建「存量迁移」出来的轮；人开过的轮（带影响评估）原样保留，接在后面重新编号 —— 重建不能吃掉评估。
      const rebuilt = deriveHistory(runs, safeResult);
      const kept = (prev?.rounds || []).filter(r => !r.migrated);
      for (const r of kept) { const n = rebuilt.length + 1; r.base = rebuilt.length ? `R${rebuilt.length}` : null; r.id = `R${n}`; r.seq = n; rebuilt.push(r); }
      const rf = { demand: D, repos: prev?.repos || [], rounds: rebuilt };
      if (kept.length) console.log(`  ${D}: 保留 ${kept.length} 个评估过的轮（${kept.map(r => r.id).join(',')}）`);
      saveRounds(ROOT, D, rf);
      const known = rf.rounds.filter(r => r.code_source === 'provenance').length;
      const mem = roundMembers(rf, demandRecords(runs, safeResult));
      console.log(`  ${D}: ${runs.length} 个 run → ${rf.rounds.length} 轮（${known} 轮有代码版本，${rf.rounds.length - known} 轮未记录）；每轮记录数 ${mem.map(m => m.records).join('/')}`);
    }
    return;
  }
  const D = pos[1] || die(`用法：acceptkit round ${sub} <需求> ...`);
  const rf = ensureRounds(D) || { demand: D, repos: [], rounds: [] };
  if (sub === 'repos') {
    const specs = asList(opt.repo); if (!specs.length) die('用法：acceptkit round repos <需求> --repo name=/path [--repo ...]');
    rf.repos = specs.map(s => { const [name, ...p] = String(s).split('='); return { name, path: p.join('=') }; });
    saveRounds(ROOT, D, rf);
    for (const r of rf.repos) { const s = repoSnapshot(r.path); console.log(`  ${r.name.padEnd(12)} ${s.error || `${s.branch} @ ${s.commit.slice(0, 10)}  ${s.committed_at}  ${s.subject}`}`); }
    return;
  }
  if (sub === 'new') {
    if (!rf.repos?.length) die(`需求 ${D} 还没登记被测仓：acceptkit round repos ${D} --repo host=/path --repo engine=/path`);
    const last = rf.rounds[rf.rounds.length - 1] || null;
    const code = {}; const changes = {}; const lines = [];
    for (const repo of rf.repos) {
      const s = repoSnapshot(repo.path); if (s.error) die(`${repo.name}: ${s.error}`);
      code[repo.name] = s;
      const from = last?.code?.[repo.name]?.commit || null;
      const files = changedFiles(repo.path, from, s.commit);
      changes[repo.name] = { from, to: s.commit, files: files ? files.slice(0, 2000) : null, count: files ? files.length : null };
      lines.push(`  ${repo.name.padEnd(12)} ${s.branch} @ ${s.commit.slice(0, 10)}（${s.committed_at}）${s.subject}` +
                 `\n               相对上一轮：${from ? (files ? `${files.length} 个文件` : `算不出（${from.slice(0, 10)} 不在本地历史里）`) : '上一轮未记代码版本'}${s.dirty ? `  ⚠️ 工作区 ${s.dirty} 个已跟踪文件未提交` : ''}`);
    }
    const resets = asList(opt.reset).map(String).filter(Boolean);
    if (!opt.assess) {
      console.log(`代码版本：\n${lines.join('\n')}`);
      for (const [n, ch] of Object.entries(changes)) if (ch.files?.length) console.log(`\n${n} 改动文件（前 40）：\n` + ch.files.slice(0, 40).map(f => '    ' + f).join('\n'));
      die(`开新轮必须带影响评估：--assess "<改了什么、影响哪些断言、为什么其余可以继承>"，并给 --reset <case::E,...>（要重测的）或 --inherit-all（评估后全部继承）`);
    }
    if (!resets.length && !opt['inherit-all']) die('评估结论里既没有要重测的断言（--reset），也没声明全部继承（--inherit-all）—— 二选一，不能默认');
    const id = `R${rf.rounds.length + 1}`;
    rf.rounds.push({ id, seq: rf.rounds.length + 1, opened_at: new Date().toISOString(), last_at: new Date().toISOString(),
      code, code_source: 'snapshot', base: last?.id || null, changes,
      impact: { by: String(opt.by || 'executor'), at: new Date().toISOString(), summary: String(opt.assess),
                reset: resets.map(k => ({ key: k, why: String(opt['reset-why'] || opt.assess) })),
                inherit_note: resets.length ? '除重置项外全部继承上一轮' : '评估后全部继承上一轮' } });
    saveRounds(ROOT, D, rf);
    console.log(`🆕 ${D} 第 ${rf.rounds.length} 轮（${id}）开好：\n${lines.join('\n')}\n   重置 ${resets.length} 项，其余继承 ${last?.id || '（无上一轮）'}`);
    return;
  }
  if (sub === 'show') {
    if (!rf.rounds.length) die(`需求 ${D} 还没有任何轮次`);
    const idx = opt.round ? rf.rounds.findIndex(r => r.id === String(opt.round)) : rf.rounds.length - 1;
    if (idx < 0) die(`没有轮次 ${opt.round}`);
    const rd = rf.rounds[idx];
    const recs = demandRecords(runsOfDemand(D), safeResult);
    const st = resolveState(rf, idx, recs, demandExpectKeys(D));
    const mem = roundMembers(rf, recs)[idx];
    const cnt = {}; const bySrc = {};
    for (const v of st.values()) { cnt[v.status] = (cnt[v.status] || 0) + 1; bySrc[v.source] = (bySrc[v.source] || 0) + 1; }
    console.log(`■ ${D} ${rd.id}（共 ${rf.rounds.length} 轮）开于 ${rd.opened_at}  本轮记录 ${mem.records} 条 / run ${mem.runs.length} 个`);
    for (const [n, c] of Object.entries(rd.code || {})) console.log(`   ${n.padEnd(14)} ${c.branch || '?'} @ ${(c.commit || '?').slice(0, 10)}  ${c.committed_at || ''}  ${c.subject || ''}`);
    if (!Object.keys(rd.code || {}).length) console.log('   （这一轮执行时没有记录代码版本）');
    console.log(`   影响评估：${rd.impact?.summary || '—'}`);
    console.log(`   断言 ${st.size}：${Object.entries(cnt).map(([k, v]) => `${k} ${v}`).join(' · ')}   来源：${Object.entries(bySrc).map(([k, v]) => `${({ here: '本轮测', inherited: '继承', reset: '重置待测', never: '从没测过' })[k] || k} ${v}`).join(' · ')}`);
    if (opt.todo) for (const [k, v] of st) if (v.status === 'todo') console.log(`     · ${k}  ${v.source === 'reset' ? `重置（${v.round}）：${v.reason}` : v.source === 'never' ? '从没测过' : ''}`);
    // --list <状态>：列出本轮该状态的断言和出处（汇总里看到 fail 1，要能一条命令找到是哪条）
    if (typeof opt.list === 'string') for (const [k, v] of st) if (v.status === opt.list) console.log(`     · ${k}  ${v.source}${v.run ? `  ← ${v.run}` : ''}${v.round ? `（${v.round}）` : ''}`);
    return;
  }
  die(`未知子命令 round ${sub}`);
}

const [cmd, ...rest] = process.argv.slice(2);
const args = { pos: rest.filter(a => !a.startsWith('--')), opt: parseArgs(rest).opt };


// ---- 操作库：用例只说【做什么】，各平台各自说【怎么做】（读写与校验在 core/ops.mjs，命令在 bin） ----
// 收益三条：同一条规格跨平台复用、操作怎么做只有一处定义、**某平台缺某操作会在建用例时显形**
// —— 而不是跑到一半才发现某平台没工具，代价是整轮 blocked。
const loadOps = () => loadOpsAt(ROOT);
const opRecipe = (opId, platform, host = null, o = {}) => opRecipeAt(ROOT, opId, platform, host, o);
// 这一步在哪个宿主上：--host → 用例的 host（run 的用例）→ 该平台只登记了一个宿主时就是它；有多个又没指定 → error
function hostFor(platform, { host, c, run } = {}) {
  if (!c && run && existsSync(resultPath(run))) { const r = loadResult(run); c = tryLoadCase(r.case_ref || r.case); }   // run 里没有用例：按宿主登记推
  return resolveHost(CFG, { host: host || hostOfCase(c, platform), platform });
}
const appOf = (platform, ctx) => { const h = hostFor(platform, ctx); return h.error ? {} : hostApp(CFG, h.id, platform); };

// ---- 机器状态与占用 ----
// 起因：白名单模拟器上可能装着别的迭代的包、app 在跑，只能靠 ps / Info.plist 时间去猜「好像有人在用」。
// 现在：开跑前 `device claim` 占机（记在 run 名下），gate 只放行本 run 占着的机器；跑完 `device release`。
// 租约正本在 SQLite（只由 CLI 写，读改写在一个事务里）。旧版 state/devices.json 由 acceptkit doctor --fix 导入。
const LEASE_STALE_H = 8;   // 这么久没续期（gate 每次放行都会续）视为过期
function loadLeases() { return dbLoadLeases(ROOT); }
function saveLeases(m) { try { dbSaveLeases(ROOT, m); } catch (e) { if (e instanceof LeaseConflict) die(e.message); throw e; } }
const leaseAgeH = l => (Date.now() - Date.parse(l.heartbeat || l.since)) / 3600e3;
// ---- 设备状态：五问必须答得出，答不出记「不确定」（skill/devices.md 第三节）----
// 此前 Android 这一支直接 `return { kind:'android' }` —— 一个只说明「它是安卓」的空壳：
// 开没开机、是哪一台、被测进程在不在，一个都读不到。于是「空闲」只能靠猜，
// 选机器无从下手、占用无从校验，最终表现为「明明有空闲的机器，却又启了一台」。
// 被测 App 按这台设备声明装的宿主取（profile.host）；没声明且该平台只有一个宿主时用它
const deviceApp = (ref, plat) => { const hs = deviceHosts(allowEntry(ref)?.profile); return appOf(plat, { host: hs.length === 1 ? hs[0] : null }); };
function deviceState(ref) {
  const plat = platformOfUdid(ref);
  if (plat === 'android') {
    if (PACK.androidDeviceState) return PACK.androidDeviceState(ref, HELPERS);
    return ANDROID.deviceState(ref, deviceApp(ref, 'android').package);
  }
  if (PACK.simState) return iosStateWords({ platform: 'ios', identity: String(ref), address: String(ref), connected: true, ...PACK.simState(ref, HELPERS) });
  const udid = String(ref);
  const line = (spawnSync('xcrun', ['simctl', 'list', 'devices'], { encoding: 'utf8' }).stdout || '').split('\n').find(l => l.includes(udid)) || '';
  const state = /\((Booted|Shutdown)\)/.exec(line)?.[1] || '不存在';
  const name = line.trim().replace(/\s*\(.*$/, '');
  let app = null;
  const bundle = deviceApp(udid, 'ios').bundle;
  if (bundle) {
    const c = spawnSync('xcrun', ['simctl', 'get_app_container', udid, bundle], { encoding: 'utf8' });
    if (c.status === 0) {
      const p = c.stdout.trim(), plist = join(p, 'Info.plist');
      const v = spawnSync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist], { encoding: 'utf8' });
      const version = v.status === 0 ? v.stdout.trim() || null : null;
      try { app = { path: p, mtime: statSync(plist).mtime.toISOString(), version }; } catch { app = { path: p, version }; }
    }
  }
  const pid = bundle ? appPid(udid, bundle) : '';
  return iosStateWords({ platform: 'ios', identity: udid, address: udid, connected: state !== '不存在', name, state, app, running: pid ? `pid ${pid}` : null });
}
// simctl 的 Booted / Shutdown 换成与 Android 同一套词：选设备按「已开机」判复用、按 bootable 判可启动，
// 不换的话 iOS 模拟器永远落不进这两档
function iosStateWords(s) {
  if (s.state === 'Booted') return { ...s, state: '已开机' };
  if (s.state === 'Shutdown') return { ...s, state: '未启动', connected: false, bootable: s.bootable ?? true };
  return s;
}
const simState = deviceState;   // 旧名：项目扩展与存量调用仍可用

/** 白名单里这台设备的条目（身份写法与地址写法互通）—— 条目上的 profile 是**声明**的能力标签 */
const allowEntry = (ref) => DEVICE_ALLOW.find(a => deviceAliases(ref).includes(a.value)) || null;

const MEASURED_KEYS = ['ram_mb', 'cores', 'gpu', 'data_mb'];
const fmtProfile = (pf) => !pf ? '' : [pf.ram_mb ? `${pf.ram_mb}MB` : null, pf.cores ? `${pf.cores} 核` : null,
  pf.gpu ? `gpu ${pf.gpu}` : null, pf.data_mb ? `数据区 ${Math.round(pf.data_mb / 1024)}G` : null,
  ...Object.entries(pf).filter(([k, v]) => !MEASURED_KEYS.includes(k) && v != null).map(([k, v]) => `${k}=${v}`)].filter(Boolean).join(' · ');

/**
 * 设备状态 + 能力：**实测优先，声明补充**。
 * 实测的（内存 / 核数 / GPU / 数据区）从机器本身读 —— 声明和现实不一致时现实说话。
 * 声明的（白名单条目里的 profile：这台装的是哪个宿主、有没有登录态、是不是一次性机）读不出来，
 * 只能人写；没有这一层，「这台跑不了这条用例」就表达不出来，换机的决定也就无法复核。
 */
function stateOf(ref) {
  const s = deviceState(ref);
  const declared = allowEntry(ref)?.profile || null;
  if (declared) {
    const measured = Object.fromEntries(Object.entries(s.profile || {}).filter(([, v]) => v != null));
    s.profile = { ...declared, ...measured };
  }
  return s;
}
const fmtAge = (sec) => sec == null ? '' : sec < 3600 ? `${Math.round(sec / 60)} 分钟` : `${(sec / 3600).toFixed(1)} 小时`;

/**
 * 选设备：复用 → 启动 → 新建（skill/devices.md 第二节；docs/constraints.md 22d）
 *
 * 为什么这一步要由工具做而不是由执行者判断：凭记忆挑机器已经错过一次 —— 白名单上写着
 * 「某个 serial = 某台验收专用机」，实际那个端口早就被另一台占了。而且「为什么不用现有的那台」
 * 这个理由如果不落盘，对的决定（例如那台内存太小、GPU 关着，被测物在上面必然卡死）
 * 和错的决定（随手又开一台）在事后看起来一模一样。
 */
/**
 * run 绑定的设备 → **当次可用地址**。
 *
 * 两件事一起办：
 *  1. 身份→地址每次现解：模拟器重启后端口会变，而 run 绑的是身份，所以这一轮不会因为换了端口就断掉。
 *  2. 带 --sim 时必须与 run 的绑定一致 —— 一次 run 只打一台（docs/constraints.md 22b）。
 *     不然就会出现「一轮验收的证据一半来自甲机、一半来自乙机，而 run 里的设备字段是空的」。
 */
function runDeviceAddress(run, opt) {
  const r = loadResult(run);
  const bound = r.device?.key || r.device?.udid || null;
  if (opt.sim) {
    const s = String(opt.sim);
    if (bound && leaseKeyOf(bound) !== leaseKeyOf(s))
      die(`run=${run} 绑定的设备是 ${bound}，不能对 ${s} 操作 —— 一轮验收只能打在一台机器上。\n   要换机：acceptkit device release ${bound} --run ${run}，并把换机理由写进 run`);
    return s;
  }
  if (!bound) return null;
  const addr = platformOfUdid(bound) === 'android' ? ANDROID.addressOf(bound) : bound;
  if (!addr) die(`run=${run} 绑定的 ${bound} 现在没连上 —— 启动它（身份不变，地址会自动重新解析），或 device release 后重新 pick`);
  return addr;
}
/** 心跳：每次对这台设备的操作都续期，不只闸门续期（续期点越少，租约越容易「人还在用却看起来过期」）。 */
function touchLease(ref, run) {
  if (!ref || !run) return;
  const leases = loadLeases();
  const [, l] = findLease(leases, ref);
  if (l && l.run === String(run)) { l.heartbeat = new Date().toISOString(); saveLeases(leases); }
}
/** 收口时自动释放本 run 占着的机器（靠人记得释放 = 迟早不释放）。 */
function releaseLeasesOfRun(run) {
  const leases = loadLeases();
  const mine = Object.entries(leases).filter(([, l]) => l.run === String(run)).map(([k]) => k);
  if (!mine.length) return [];
  for (const k of mine) delete leases[k];
  saveLeases(leases);
  applyDevicePref();   // 模拟器退出时会把窗口位置写回去：放掉之后再写一遍偏好，下一次谁起都开在用户指定的屏上
  return mine;
}

// 已连接的设备（身份）：项目扩展 listDevices(platform) 优先（自家设备池、测试里注入的设备快照）；
// 否则现读 adb / simctl。只看白名单会漏掉「现实里已经有一台在跑」——那正是上次多开一台的直接原因。
function connectedRefs(platform) {
  if (PACK.listDevices) return (PACK.listDevices(platform, HELPERS) || []).map(String);
  if (platform === 'android') return ANDROID.available() ? ANDROID.listDevices().map(d => ANDROID.identityOf(d.serial)).filter(Boolean) : [];
  if (platform === 'ios') {
    // 取不到（不是 macOS、没装 Xcode）就只看白名单，照旧
    const r = spawnSync('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], { encoding: 'utf8', timeout: 15_000 });
    if (r.status !== 0) return [];
    try { return Object.values(JSON.parse(r.stdout).devices || {}).flat().filter(d => d.state === 'Booted').map(d => d.udid); } catch { return []; }
  }
  return [];
}
// 用户自己的偏好：设备窗口开在哪块显示器（acceptkit prefs set devices.display leftmost|rightmost|main|<第几块>）。
// 是用户的配置、不是项目的：只读 ~/.config/acceptkit/config.json，别人用这个项目不受影响
function devicePlace() {
  const pref = readUserConfig().prefs?.devices?.display;
  return pref ? placeOn(pickScreen(String(pref))) : null;
}
// 启动一台（第二档）：项目扩展 bootDevice 优先；否则 iOS 用 simctl、Android 用 emulator。都带超时。
// 返回 { ok, address? } 或 { ok:false, how }（how = 一句怎么手动启动）
function bootDevice(ref) {
  if (PACK.bootDevice) return PACK.bootDevice(ref, HELPERS) || { ok: false, how: '项目扩展 bootDevice 没有返回结果' };
  const plat = platformOfUdid(ref);
  if (plat === 'android') return ANDROID.boot(ref, { place: devicePlace() });
  if (plat === 'ios') {
    const b = spawnSync('xcrun', ['simctl', 'boot', String(ref)], { encoding: 'utf8', timeout: 60_000 });
    if (b.status !== 0 && !/current state: Booted/i.test(b.stderr || '')) return { ok: false, how: `simctl boot 失败：${(b.stderr || '').trim().slice(0, 200) || '没有输出'}。手动启动：xcrun simctl boot ${ref}` };
    const w = spawnSync('xcrun', ['simctl', 'bootstatus', String(ref), '-b'], { encoding: 'utf8', timeout: 180_000 });
    return w.status === 0 ? { ok: true, address: String(ref) } : { ok: false, how: `已经 simctl boot，180 秒内没开机完成：等它起来，或打开 Simulator 看看 ${ref}` };
  }
  return { ok: false, how: `认不出 ${ref} 是哪个平台的设备，没法启动` };
}

/**
 * 选设备的候选计算：复用 → 启动 → 新建（skill/devices.md 第二节）。只读状态、不打印、不写盘。
 * platform 可以是一个或一组（跨端用例还没定跑在哪端）；host：平台 → 用例要的宿主 id；
 * exclude：租约键 → 本 run 否决它的理由（device reject 记的）；only：只看这一台（run 已经绑了它）。
 * → { cands:[{ ref, key, platform, state, lease, tier, reasons, notes }], chosen, decision: reuse|boot|create }
 */
function pickDevice({ platform, need = {}, run = null, exclude = new Map(), host = {}, only = null, ours = new Set() }) {
  const leases = loadLeases();
  const plats = [].concat(platform).filter(Boolean);
  // 候选 = 白名单 ∪ 实际连接
  const refs = new Set();
  for (const p of plats) {
    for (const a of DEVICE_ALLOW) if (platformOfUdid(a.value) === p) refs.add(a.value);
    for (const id of connectedRefs(p)) refs.add(id);
  }
  if (only) refs.add(only);
  // 白名单写地址、现实解出身份 —— 同一台机器会以两种写法进来。按租约键收敛，优先留身份写法，
  // 否则候选表里同一台会出现两次（看起来像「有两台可用」，正是这套机制要消灭的误读）。
  const byKey = new Map();
  for (const ref of refs) {
    const k = leaseKeyOf(ref), prev = byKey.get(k);
    if (!prev || (/^avd:/i.test(ref) && !/^avd:/i.test(prev))) byKey.set(k, ref);
  }
  const cands = [...byKey.entries()].filter(([k]) => !only || k === only).map(([, ref]) => {
    const s = stateOf(ref);
    const plat = platformOfUdid(ref);
    const [lkey, lease] = findLease(leases, ref);
    const allowed = isAllowedDevice(ref);
    const held = !!(lease && leaseAgeH(lease) <= LEASE_STALE_H && (!run || lease.run !== run) && !ours.has(lease.run));
    const fit = ANDROID.profileMeets(s.profile, need);
    const reasons = [], notes = [];
    if (!allowed) reasons.push('不在白名单');
    if (exclude.has(lkey)) reasons.push(`本 run 否决过：${exclude.get(lkey)}`);
    if (held) reasons.push(`被 run=${lease.run}（${lease.holder}）占着`);
    if (fit.ok === false) reasons.push(`能力不满足：${fit.unmet.join('、')}`);
    if (fit.ok === null && fit.unknown.length) reasons.push(`能力读不到：${fit.unknown.join('、')}（按不确定处理，不当作满足）`);
    // 宿主：设备声明了装哪些宿主、却没有用例要的那个 → 淘汰；没声明 → 留给执行者核对
    const want = host[plat], hs = deviceHosts(s.profile);
    if (want && hs.length && !hs.includes(want)) reasons.push(`装的宿主是 ${hs.join('/')}，用例要 ${want}`);
    else if (want && !hs.length) notes.push(`这台没声明装了哪个宿主（白名单 profile.host）：核对装的是不是 ${want}`);
    // waiting：只差「被别的 run 占着」—— 那个 run 放了就能用，等一等再选，不用问人。
    // 启动中的机器落在启动档；「不存在」「没连上」要人去建、去接，不算等
    const waiting = held && reasons.length === 1;
    const usable = !reasons.length;
    let tier = 'out';
    if (usable) tier = (s.connected && s.state === '已开机') ? 'reuse' : (s.bootable ? 'boot' : 'out');
    if (usable && tier === 'out') reasons.push(s.state || '不可用');
    return { ref, key: lkey, platform: plat, state: s, lease, tier, reasons, notes, waiting };
  });
  const order = { reuse: 0, boot: 1, out: 2 };
  cands.sort((a, b) => order[a.tier] - order[b.tier]);
  const chosen = cands.find(c => c.tier === 'reuse') || cands.find(c => c.tier === 'boot') || null;
  const decision = chosen ? (chosen.tier === 'reuse' ? 'reuse' : 'boot') : 'create';
  return { cands, chosen, decision };
}
const fmtNeed = need => Object.entries(need).map(([k, v]) => `${k}${/^[<>=!]/.test(String(v)) ? '' : '='}${v}`).join(' ');
const parseNeed = v => {
  const need = {};
  for (const n of asList(v)) { const i = String(n).indexOf('='); if (i > 0) need[String(n).slice(0, i)] = String(n).slice(i + 1); }
  return need;
};
// 选择留痕：候选 + 淘汰原因 + 决策写进 run，对的换机和乱开机器事后才分得清
const pickRecord = (plats, need, { cands, chosen, decision }, extra = {}) => ({ at: new Date().toISOString(), platform: plats.length === 1 ? plats[0] : plats, need, decision,
  chosen: chosen?.key || null,
  candidates: cands.map(c => ({ key: c.key, address: c.state.address || null, state: c.state.state || null, tier: c.tier, profile: c.state.profile || null, why_not: c.reasons })),
  ...extra });

function cmdDevicePick({ opt }) {
  const want = opt.platform ? String(opt.platform) : die('pick 必须带 --platform ios|android');
  const need = parseNeed(opt.need);
  const run = opt.run ? String(opt.run) : null;
  const picked = pickDevice({ platform: want, need, run });
  const { cands, chosen, decision } = picked;
  console.log(`选设备 · platform=${want}${Object.keys(need).length ? ` · 要求 ${fmtNeed(need)}` : ''}`);
  for (const c of cands) {
    const s = c.state;
    const icon = c.tier === 'reuse' ? '✅ 可复用' : c.tier === 'boot' ? '▶️  可启动' : '✖️  淘汰 ';
    console.log(`  ${icon}  ${c.key}${s.address && s.address !== c.key ? `  地址 ${s.address}` : ''}  [${s.state || '?'}]${fmtProfile(s.profile) ? `  ${fmtProfile(s.profile)}` : ''}`);
    if (s.running) console.log(`             被测 app 在跑：${s.running}`);
    if (s.uptime_sec != null) console.log(`             已开机 ${fmtAge(s.uptime_sec)}`);
    if (c.reasons.length) console.log(`             ${c.reasons.join('；')}`);
  }
  if (decision === 'reuse') console.log(`\n→ 复用 ${chosen.key}：acceptkit device claim ${chosen.key} --run <R> --holder "<谁在用>"（或直接 acceptkit device acquire --run <R>，选和占一步做完）`);
  else if (decision === 'boot') console.log(`\n→ 启动 ${chosen.key}（白名单内、能力满足、当前没在跑），起来后再 claim；acceptkit device acquire --run <R> 会自己启动并占上`);
  else console.log(`\n→ 现有设备都不可用（理由见上）。要新建一台：把「为什么现有的都不行」写进 run，新机器连能力一起加进白名单，再 pick。`);

  if (run && existsSync(resultPath(run))) {
    const r = loadResult(run);
    (r.device_picks ||= []).push(pickRecord([want], need, picked));
    saveResult(run, r);
    console.log(`   已记入 run ${run}（候选 + 淘汰原因 + 决策）`);
  } else if (run) console.error(`⚠️  run=${run} 还没有 result.json，选择理由没有落盘 —— 先 acceptkit run <case> --demand <D>`);
  return decision;
}

// 关机（release --shutdown 与 stop 共用）→ 一句说明
function shutdownDevice(lkey, ref) {
  const plat = platformOfUdid(lkey);
  const addr = plat === 'android' ? ANDROID.addressOf(lkey) : String(ref);
  const r = !addr ? null : plat === 'android' ? spawnSync(ANDROID.adbBin(), ['-s', addr, 'emu', 'kill'], { encoding: 'utf8', timeout: 15_000 })
    : spawnSync('xcrun', ['simctl', 'shutdown', addr], { encoding: 'utf8', timeout: 60_000 });
  // 等它真退出再往下走：退出那一刻模拟器会写窗口位置，先写偏好会被它盖掉
  if (r?.status === 0 && plat === 'android') for (let i = 0; i < 20 && ANDROID.listDevices().some(d => d.serial === addr); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  return !addr ? '，本来就没开' : r.status === 0 ? '，已关机' : `，关机没成功：${(r.stderr || r.stdout || '').trim().slice(0, 120)}`;
}

/** 占用登记 + 绑到 run（claim 与 acquire 共用；调用方先做完各自的检查） */
function writeClaim(ref, run, holder, s, { cur = null, note = '', takeOver = null } = {}) {
  const leases = loadLeases();
  const key = leaseKeyOf(ref);
  // 调用方查过占用之后、这里重新读之前，别的 run 可能刚占走（并行验收）：不是调用方看到的那个占用方就拒绝，不盖掉
  const live = findLease(leases, ref)[1];
  if (live && String(live.run) !== String(run) && String(live.run) !== String(cur?.run) && leaseAgeH(live) <= LEASE_STALE_H)
    die(`${key} 刚被 run=${live.run} 占走：再跑一次 acceptkit device acquire --run ${run}`);
  const now = new Date().toISOString();
  const platform = platformOfUdid(ref);
  leases[key] = { run, holder, platform, since: cur?.run === run ? cur.since : now, heartbeat: now, note,
                   ...(takeOver && cur ? { took_over_from: cur, take_over_reason: takeOver } : {}) };
  for (const alias of deviceAliases(ref)) if (alias !== key && leases[alias]) delete leases[alias];   // 同一台机器不留两条键
  saveLeases(leases);
  if (existsSync(resultPath(run))) {
    const r = loadResult(run);
    r.device = { key, udid: s.address || ref, address: s.address || null, name: s.name || s.avd || null, platform, holder, claimed_at: leases[key].since, profile: s.profile || null };
    r.platform = r.platform || platform; saveResult(run, r);
  }
  return key;
}

// 同一需求的其他运行还占着的机器（没过期的租约）。一个需求同一平台只用一台：见 core/parallel.mjs
const demandIdOf = r => r?.demand?.id || r?.demand || null;
function demandLeases(r, run, plats) {
  const d = demandIdOf(r);
  if (!d) return [];
  return Object.entries(loadLeases()).flatMap(([key, l]) => {
    if (!l || l.run === run || leaseAgeH(l) > LEASE_STALE_H || !plats.includes(l.platform || platformOfUdid(key))) return [];
    let other = null; try { other = existsSync(resultPath(l.run)) ? loadResult(l.run) : null; } catch {}
    return demandIdOf(other) === d ? [{ key, run: l.run, platform: l.platform || platformOfUdid(key) }] : [];
  });
}

// 运行要的平台与宿主，从 run 和用例推出（不用执行者传）
function runDeviceNeeds(r) {
  const c = tryLoadCase(r.case_ref || r.case);   // 用例文件不在了：只按 run 里记的平台
  const decl = normalizePlatforms(c);
  // 用例写 both、run 还没定平台时，按这次为之跑的需求收窄：Android 需求的 run 不许拿 iOS 机。
  // 实例：一个 Android 需求下两条 both 用例的 run 复用了别的会话开着的 iOS 模拟器，run 被记成 ios，
  // 证据却全来自 Android 模拟器 —— 平台标错之后 observe.by.android 永远取不到，断言只能手记。
  const planPlat = (() => { const d = demandIdOf(r); const p = d ? loadPlan(ROOT, d)?.platform : null; return p === 'ios' || p === 'android' ? p : null; })();
  const fromCase = planPlat && decl.includes(planPlat) ? [planPlat] : decl;
  const plats = (r.device?.platform ? [r.device.platform] : r.platform ? [r.platform] : fromCase).filter(p => p === 'ios' || p === 'android');
  const host = {};
  for (const p of plats) { const h = hostFor(p, { c }); if (!h.error) host[p] = h.id; }
  const caseNeed = c?.device_need && typeof c.device_need === 'object' ? Object.fromEntries(Object.entries(c.device_need).map(([k, v]) => [k, String(v)])) : {};
  return { c, decl, plats, host, caseNeed };
}
function deviceCardOf(run, key, s, how, host, notes = []) {
  const app = s.app || {};
  const appId = s.app?.package || s.app?.bundle || (host ? (hostApp(CFG, host, s.platform || platformOfUdid(key)).bundle || hostApp(CFG, host, s.platform || platformOfUdid(key)).package) : '') || '';
  return cardDevice(run, { key, name: s.name || s.avd || null, address: s.address || null, platform: s.platform || platformOfUdid(key), host: host || null,
    profile: s.profile || null, app_id: appId, app, running: s.running || null, how, warnings: notes });
}

/**
 * device acquire：代码选一台并占上，执行者只核对代码看不出的东西（docs/002-protocol.md 第五节「选设备」）。
 * 复用档直接占；启动档先启动再占；都不行不占任何设备，出 attention 卡片等人加设备。
 */
function cmdDeviceAcquire({ opt }) {
  applyDevicePref();
  const refuse = die;
  const out = card => { if (!JSON_MODE) console.log(formatCards(`运行 ${card.run}`, [card]).split('\n').slice(1).join('\n')); return card; };
  const run = opt.run ? String(opt.run) : refuse('用法：acceptkit device acquire --run R [--need k=v …] [--holder H] [--json]');
  if (!existsSync(resultPath(run))) refuse(`没有运行 ${run}：先 acceptkit run <用例> --demand <D>`);
  const r = loadResult(run);
  const { decl, plats, host, caseNeed } = runDeviceNeeds(r);
  if (!plats.length) refuse(decl.includes('web') ? `运行 ${run} 是 web 用例，不占设备：直接 acceptkit shot ${run} --web` : `运行 ${run} 的用例没声明 ios / android 平台，选不了设备：给用例写 platform`);
  const need = { ...caseNeed, ...parseNeed(opt.need) };
  const holder = opt.holder ? String(opt.holder) : (r.session || `run ${run}`);
  const exclude = new Map((r.device_rejects || []).map(x => [x.key, x.why]));

  // 已经绑了一台：一次 run 只打一台，只看它本身；还占着、开着就原样返回
  const bound = r.device?.key || r.device?.udid || null;
  if (bound) {
    const [, l] = findLease(loadLeases(), bound);
    const s = stateOf(bound);
    if (l && l.run === run && s.connected && s.state === '已开机') { touchLease(bound, run); return out(deviceCardOf(run, leaseKeyOf(bound), s, '已经占着', host[s.platform || plats[0]])); }
  }
  // 一个需求同一平台只用一台：同需求别的运行占着一台，就接过来用；要第二台得 --parallel 给理由，核对过才另选
  if (bound && opt.parallel) refuse(`运行 ${run} 已经绑定 ${bound}，一次 run 只打一台。要双跑：另开一个运行（acceptkit run ${r.case} --demand ${demandIdOf(r)}），在那个运行上 acquire --parallel`);
  // 绑过的运行回来接着做：它那台被同需求的下一轮接走了，照样接回来（ours 里的运行不算「别人占着」）
  const sameDemand = demandLeases(r, run, bound ? [platformOfUdid(bound)] : plats);
  const ours = new Set(sameDemand.map(m => m.run));
  const mine = bound ? [] : sameDemand;
  let parallel = null, takeOver = null;
  if (bound) { const hit = sameDemand.find(m => m.key === leaseKeyOf(bound)); if (hit) takeOver = `同一需求 ${demandIdOf(r)} 只用一台：从 run ${hit.run} 接回来`; }
  if (mine.length) {
    const cur = mine[0];
    const fit = pickDevice({ platform: [cur.platform], need, run, exclude, host, only: cur.key, ours });
    const unfit = fit.chosen ? [] : (fit.cands[0]?.reasons.length ? fit.cands[0].reasons : ['这台现在用不了']);
    if (opt.parallel) {
      const c0 = tryLoadCase(r.case_ref || r.case);
      const j = judgeParallel({ kind: String(opt.parallel), why: opt.why, approvedBy: opt['approved-by'], quote: opt.quote,
        current: { ...cur, unfit }, caseDecl: c0?.parallel_devices || null });
      if (!j.ok) refuse(j.why.join('\n'));
      parallel = j.record;
      for (const m of mine) exclude.set(m.key, `同一需求已在用（run ${m.run}），本 run 按理由 ${j.record.kind} 另选一台`);
    } else {
      if (unfit.length) refuse(`需求 ${demandIdOf(r)} 已经在 ${cur.key} 上跑（run ${cur.run}），这一轮用不了它：${unfit.join('；')}。\n`
        + `   一个需求同一平台只用一台。确实要第二台：acceptkit device acquire --run ${run} --parallel capability --why "<为什么>"（工具会核对那台确实不满足）`);
      takeOver = `同一需求 ${demandIdOf(r)} 只用一台：从 run ${cur.run} 接过来`;
    }
  }
  const picked = parallel || !mine.length
    ? pickDevice({ platform: bound ? [platformOfUdid(bound)] : plats, need, run, exclude, host, only: bound ? leaseKeyOf(bound) : null, ours })
    : pickDevice({ platform: [mine[0].platform], need, run, exclude, host, only: mine[0].key, ours });
  const { cands, chosen, decision } = picked;
  if (bound && decision === 'create')
    refuse(`运行 ${run} 绑定的 ${bound} 现在不能用（${cands[0]?.reasons.join('；') || '找不到这台'}）。一次 run 只打一台：它确实不对就 acceptkit device reject ${bound} --run ${run} --why "…"（已经在它上面留了证据的，要重开一个 run）`);
  const rec = pickRecord(plats, need, picked, { via: 'acquire', ...(parallel ? { parallel } : {}), ...(takeOver ? { took_over: takeOver } : {}) });
  const save = () => { const rr = loadResult(run); (rr.device_picks ||= []).push(rec); saveResult(run, rr); };

  if (decision === 'create') {
    const wantHost = plats.map(p => host[p]).filter(Boolean);
    const detail = cands.length ? cands.map(c => `${c.key}：${c.reasons.join('；')}`) : ['白名单里没有这个平台的设备，也没有连着的'];
    // 有一台只是在等别的 run 放手：不问人，记下等什么，next 照旧出 device_needed 让执行者过会儿再 acquire
    const wait = cands.filter(c => c.waiting);
    if (wait.length) {
      rec.how = `现在没有能用的，但 ${wait.map(c => `${c.key}（${c.reasons.join('；')}）`).join('、')} 只是暂时用不了：`
        + `等占着的 run 放出来，再 acceptkit device acquire --run ${run}`;
      save();
      return out(cardDeviceNeeded(run, rec.how));
    }
    rec.ask = `运行 ${run} 要一台 ${plats.join(' 或 ')} 设备${Object.keys(need).length ? `（要求 ${fmtNeed(need)}）` : ''}${wantHost.length ? `，装着 ${wantHost.join('/')}` : ''}，现有的都不能用${cands.length ? `（${cands.length} 台，原因见下）` : ''}。`
      + `要新建一台这样的设备并加进白名单，还是告诉我可以放行哪一台？`
      // 新增设备时用户自己那边要做的事（代理规则、证书……）因人因机器而异：只读用户自己的配置，工具不内置任何一家的做法
      + (readUserConfig().prefs?.devices?.new_device ? `（新增设备的话，你说过还要：${readUserConfig().prefs.devices.new_device}）` : '');
    rec.ask_detail = detail;
    save();
    return out(cardDeviceAttention(run, rec.ask, detail));
  }

  let s = chosen.state, how = '复用';
  if (decision === 'boot') {
    const b = bootDevice(chosen.ref);
    if (!b.ok) { rec.how = b.how; save(); return out(cardDeviceNeeded(run, b.how)); }
    _aliasCache.clear();   // 刚起来的 Android 模拟器有了新地址
    s = stateOf(chosen.ref); how = '刚启动';
    if (!(s.connected && s.state === '已开机')) { rec.how = `启动后状态是 ${s.state || '读不到'}`; save(); return out(cardDeviceNeeded(run, `${chosen.key} 启动后状态是 ${s.state || '读不到'}：等它开机完成再 acceptkit device acquire --run ${run}`)); }
  }
  // 占之前再看一眼租约：选和占之间可能被别的 run 抢了
  const [, cur] = findLease(loadLeases(), chosen.ref);
  if (cur && cur.run !== run && leaseAgeH(cur) <= LEASE_STALE_H && !ours.has(cur.run)) refuse(`${chosen.key} 刚被 run=${cur.run} 占走：再跑一次 acceptkit device acquire --run ${run}`);
  save();
  if (parallel) { const rr = loadResult(run); (rr.parallel_devices ||= []).push(parallel); saveResult(run, rr); }
  const notes = [...chosen.notes];
  if (!cur && s.running) notes.push(`没有占用登记但被测 app 在跑（${s.running}）：可能有人没登记就在用，确认后再动它`);
  if (takeOver) notes.push(`${takeOver}。那一轮要接着做时，回去 acquire 会再接回来`);
  if (parallel) notes.push(`第二台：理由 ${parallel.kind}（${parallel.why}），需求原来那台是 ${parallel.with}`);
  const key = writeClaim(chosen.ref, run, holder, s, { cur, takeOver: cur && ours.has(cur.run) ? takeOver : null });
  return out(deviceCardOf(run, key, s, how, host[chosen.platform], notes));
}

/**
 * device reject：执行者核对后否决这台（账号不对、页面不能测……）。记进 run，释放本 run 的占用，再选下一台。
 * 已经在这台上留了证据的不许换：一轮验收的证据只能来自一台机器。
 */
function cmdDeviceReject({ pos, opt }) {
  const refuse = die;
  const ref = pos[1] || refuse('用法：acceptkit device reject <设备> --run R --why "<哪里不对>" [--json]');
  const run = opt.run ? String(opt.run) : refuse('reject 必须带 --run（否决记在哪次验收名下）');
  const why = typeof opt.why === 'string' && opt.why.trim() ? opt.why.trim() : refuse('reject 必须带 --why "<哪里不对>"：工具看不出来，下一台选不选得对就靠这句');
  if (!existsSync(resultPath(run))) refuse(`没有运行 ${run}：先 acceptkit run <用例> --demand <D>`);
  const key = leaseKeyOf(ref);
  const r = loadResult(run);
  const bound = r.device?.key || r.device?.udid || null;
  const mine = bound && leaseKeyOf(bound) === key;
  if (mine) {
    const used = [...Object.values(r.results || {}), ...Object.values(r.steps || {})].some(x => (x.evidence || []).length);
    if (used) refuse(`运行 ${run} 已经在 ${key} 上留了证据，换机会让一轮的证据来自两台：重开一个 run（acceptkit run ${r.case} --demand ${r.demand?.id || r.demand}）再 acquire`);
  }
  (r.device_rejects ||= []).push({ key, at: new Date().toISOString(), why });
  if (mine) delete r.device;
  saveResult(run, r);
  const leases = loadLeases();
  const [lkey, cur] = findLease(leases, ref);
  if (cur && cur.run === run) { delete leases[lkey]; saveLeases(leases); }
  if (!JSON_MODE) console.log(`✖️  ${key} 已从运行 ${run} 否决：${why}${cur?.run === run ? '（占用已释放）' : ''}。再选一台：`);
  return cmdDeviceAcquire({ opt });
}

function cmdDevice({ pos, opt }) {
  const sub = pos[0] || 'status';
  if (sub === 'pick') return cmdDevicePick({ opt });
  if (sub === 'acquire') return cmdDeviceAcquire({ opt });
  if (sub === 'reject') return cmdDeviceReject({ pos, opt });
  const leases = loadLeases();
  if (sub === 'status') {
    // 白名单 ∪ 实际连接：只遍历白名单，看不见「现实里多出来的那台」；只看现实，看不见「该有却没起的那台」。
    const refs = [];
    for (const a of DEVICE_ALLOW) refs.push({ ref: a.value, allowed: true, note: a.note || '' });
    for (const d of (ANDROID.available() ? ANDROID.listDevices() : [])) {
      const id = ANDROID.identityOf(d.serial) || d.serial;
      if (!refs.some(r => deviceAliases(r.ref).includes(id) || deviceAliases(r.ref).includes(d.serial))) refs.push({ ref: id, allowed: false, note: '' });
    }
    const avds = ANDROID.available() ? ANDROID.listAvds() : [];
    console.log(`机器状态（白名单 ∪ 实际连接）—— 占用 ${LEASE_STALE_H}h 没续期视为过期`);
    for (const { ref, allowed, note } of refs) {
      const s = stateOf(ref);
      const [lkey, l] = findLease(leases, ref);
      const id = s.identity || ref;
      console.log(`\n■ ${id}${s.name ? ' ' + s.name : ''} [${s.state || s.platform}]${s.address && s.address !== id ? `  地址 ${s.address}` : ''}${allowed ? '' : '  ⚠️ 不在白名单（不可操作）'}`);
      if (note) console.log(`   白名单：${note}`);
      if (fmtProfile(s.profile)) console.log(`   能力：${fmtProfile(s.profile)}`);
      // 地址形式的白名单条目会漂（docs/constraints.md 22a）：把它当前指向谁打出来，和备注里的名字不符时喊出来。
      if (allowed && isAndroidEmu(ref)) {
        if (s.avd) console.log(`   ⚠️ 白名单写的是地址（${ref}），端口按启动顺序分配会漂 —— 建议改成身份 ${id}`);
        else console.log(`   ⚠️ 白名单写的是地址（${ref}）且这个号当前没连上 —— 连它指向哪一台都不知道，应该改成身份（avd:<AVD名>）`);
        // 备注里提到的 AVD 名取**最长匹配**：名字之间常有前缀包含关系（甲 与 甲_acc），
        // 取第一个匹配会把 甲_acc 误读成 甲，于是喊错位的时候还喊错了名字。
        const named = avds.filter(n => note.includes(n)).sort((a, b) => b.length - a.length)[0];
        if (named && s.avd && named !== s.avd) console.log(`   ⛔ 错位：备注说这台是 ${named}，而 ${ref} 当前指向 ${s.avd} —— 按这条白名单放行就会打在另一台机器上`);
      }
      if (s.app?.mtime) console.log(`   已装包：Info.plist ${s.app.mtime}（对照各构建产物时间可知是谁的构建）`);
      if (s.uptime_sec != null) console.log(`   已开机 ${fmtAge(s.uptime_sec)}`);
      if (s.running) console.log(`   被测 app 在跑：${s.running}`);
      console.log(l ? `   占用：run=${l.run} · ${l.holder} · since ${l.since}${leaseAgeH(l) > LEASE_STALE_H ? ' ⚠️ 已过期（只解除阻挡，不等于可以直接抢）' : ''}${l.note ? ' · ' + l.note : ''}${lkey !== id ? `\n   ⚠️ 这条租约的键是 ${lkey}（地址，会漂）：release 后重新 claim 可换成身份 ${id}` : ''}`
                    : `   占用：无登记${s.running ? '  ⚠️ 但被测 app 在跑 —— 可能有人没登记就在用，先问' : ''}`);
      if (!s.connected && s.state === '未启动') console.log(`   （白名单内但没启动：需要时启动它，不要新建）`);
    }
    return;
  }
  const ref = pos[1] || die(`用法：acceptkit device ${sub} <设备身份或地址> ...`);
  if (!isAllowedDevice(ref)) die(`${ref} 不在白名单（gate.allow 里 kind=device 的条目）`);
  const key = leaseKeyOf(ref);
  if (sub === 'claim') {
    const run = opt.run ? String(opt.run) : die('claim 必须带 --run（占用记在哪次验收名下）');
    const holder = opt.holder ? String(opt.holder) : die('claim 必须带 --holder "<谁在用：迭代 / worktree>"');
    const cur = findLease(leases, ref)[1];
    if (cur && cur.run !== run && leaseAgeH(cur) <= LEASE_STALE_H && !opt['take-over'])
      die(`${key} 正被占用：run=${cur.run} · ${cur.holder} · since ${cur.since}\n   换一台（acceptkit device pick / device status），或与占用方确认后 --take-over "<理由>"`);
    const s = stateOf(ref);
    if (!cur && s.running) console.error(`⚠️  这台没有占用登记，但被测 app 在跑（${s.running}）—— 可能有人没登记就在用，确认后再动它`);
    if (s.connected === false) console.error(`⚠️  ${key} 当前没连上（${s.state}）—— 占用先记下；机器起来后 status 会把地址解析到这个身份`);
    const platform = platformOfUdid(ref);
    if (existsSync(resultPath(run))) {
      // 机器的平台必须与用例声明一致；多平台用例由这里定下本轮跑在哪端
      const rr = loadResult(run); const cc = tryLoadCase(rr.case_ref || rr.case);
      const ccPlat = normalizePlatforms(cc);
      if (ccPlat.length && !ccPlat.includes(platform))
        die(`用例 ${cc.case} 声明适用 ${ccPlat.join('/')}，而 ${key} 是 ${platform} 机器 —— 换一台，或给用例打上 ${platform} 标签`);
      // 一次 run 只绑一台（docs/constraints.md 22b）：已经绑了另一台就必须先 release，不能悄悄换机。
      const bound = rr.device?.key || rr.device?.udid;
      const other = demandLeases(rr, run, [platform]).find(m => m.key !== key);
      if (other) die(`需求 ${demandIdOf(rr)} 已经在 ${other.key} 上跑（run ${other.run}）。一个需求同一平台只用一台：`
        + `用 acceptkit device acquire --run ${run} 接过那台；确实要第二台：device acquire --run ${run} --parallel <理由类型> --why "…"`);
      if (bound && leaseKeyOf(bound) !== key)
        die(`run=${run} 已经绑定 ${bound} —— 一轮验收只能打在一台机器上（证据出处必须单一）。\n   要换机：acceptkit device release ${bound} --run ${run}，并把换机理由写进 run`);
    }
    writeClaim(ref, run, holder, s, { cur, note: opt.note ? String(opt.note) : '', takeOver: opt['take-over'] ? String(opt['take-over']) : null });
    console.log(`🔒 ${key}${s.name ? ' ' + s.name : ''}${s.address && s.address !== key ? `（地址 ${s.address}）` : ''} 已由 run=${run}（${holder}）占用`);
    return;
  }
  if (sub === 'release') {
    const [lkey, cur] = findLease(leases, ref);
    if (!cur) { console.log(`${lkey} 本来就没有占用登记`); return; }
    if (cur.run !== String(opt.run || '')) die(`${lkey} 的占用方是 run=${cur.run} —— 带 --run ${cur.run} 才能释放，不能替别人释放`);
    delete leases[lkey]; saveLeases(leases);
    // --shutdown：用完顺手关掉（宿主钩子不许执行者自己 emu kill / simctl shutdown，关机也只走这里；只有占着它的 run 能关）
    const off = opt.shutdown ? shutdownDevice(lkey, ref) : '';
    applyDevicePref();   // 模拟器关掉时会把窗口位置写回去：放掉之后重写偏好
    console.log(`🔓 ${lkey} 已释放（原占用 run=${cur.run}）${off}`);
    return;
  }
  // stop：acceptkit 自己启动、现在没人占着的机器，用完关掉（钩子不许执行者直接关机；占着的走 release --shutdown）。
  // 不是 acceptkit 启动的不关：可能是用户自己开着的
  if (sub === 'stop') {
    const [lkey, cur] = findLease(leases, ref);
    if (cur && leaseAgeH(cur) <= LEASE_STALE_H) die(`${lkey} 正被 run=${cur.run} 占着：由它 acceptkit device release ${lkey} --run ${cur.run} --shutdown`);
    const runsDir = join(ROOT, 'runs');
    const bootedBy = (existsSync(runsDir) ? readdirSync(runsDir) : []).find(x => {
      // 只读选设备记录；读不了的运行（老目录没有 result.json、坏 JSON）跳过 —— loadResult 读不到会直接退出进程，不能用
      try { return existsSync(resultPath(x)) && (JSON.parse(readFileSync(resultPath(x), 'utf8')).device_picks || []).some(p => p.decision === 'boot' && p.chosen === lkey); } catch { return false; }
    });
    if (!bootedBy) die(`${lkey} 不是 acceptkit 启动的（运行记录里没有启动它的选择），可能是用户自己开的：不替人关，问用户`);
    if (cur) { delete leases[lkey]; saveLeases(leases); }
    const off = shutdownDevice(lkey, ref);
    applyDevicePref();
    console.log(`⏹  ${lkey}（run ${bootedBy} 选设备时启动的，现在没人占着）${off}`);
    return;
  }
  die('子命令：status | stop <身份> | acquire --run R [--need k=v] | reject <身份> --run R --why ".." | pick --platform P [--need k=v] [--run R] | claim <身份> --run R --holder H [--note ..] [--take-over "<理由>"] | release <身份> --run R [--shutdown]');
}


// ---- 每轮验收必须有有效的 App 操作截图 ----
// 「run 目录里有没有 png」这种存在性检查挡不住两类无效截图：文字渲染出来的卡片，以及画面被遮蔽层挡着的截图
// （登录页、系统权限弹窗、隐私协议页、Loading 蒙层）。所以 shot 由工具代劳：
// ① 截图前先查遮蔽层，挡着就拒绝并告诉你怎么关；② 截完写 sidecar 记下被测物（设备/包/pid/时刻/前台画面）；
// ③ 只有经本命令产出的图才算过程证据。
// 通用遮蔽层在这里；项目特有的遮蔽层（自家的调试弹窗、登录墙）由 pack.obscurers 追加。
const OBSCURING = [
  { name: '系统权限弹窗', any: ['允许', 'Allow', '不允许', "Don't Allow"],
    how: '点掉它，并在 note 里写清选了哪个' },
  { name: '隐私协议/同意页', any: ['同意并继续', '隐私政策', 'Agree and continue'],
    how: '按用例要求点「同意」或「暂不」，别让它停在这一页' },
  { name: '全屏 Loading 蒙层', any: ['正在加载', 'Loading…'],
    how: '等它消失再截；一直不消失就是个 finding，单独记一条' },
  // 实测：Android 的无响应对话框盖在 app 上时，聚焦窗口仍报被测包的 Activity，只有画面上的字露馅
  { name: '应用无响应 / 崩溃对话框', any: ["isn't responding", '没有响应', '无响应', 'has stopped', 'keeps stopping', '已停止运行'],
    how: '点「Wait / 等待」让它缓过来；反复出现就是 app 卡死，查 logcat 记成执行阻塞，别拿这张图当证据' },
  ...(PACK.obscurers || []),
];

// UI 层级：节点、可见性判定、文本、页面标题。项目的 pack.uiHierarchy 能解析驱动工具的完整产物（含 frame / 隐藏）；
// 没有时退到 #driver 设置的 ui-tree 动作，输出按行当文本节点 —— 看不到可见性，命中即算遮蔽（宁可多拦，不放过）。
function fetchHierarchy(port) {
  if (PACK.uiHierarchy) return PACK.uiHierarchy(port, HELPERS);
  const r = HELPERS.drive('ui-tree', { port });
  if (!r.cmdLine || r.error) return { unknown: true, reason: `拿不到 UI 层级：${r.error}` };
  const nodes = r.stdout.split('\n').map(t => t.trim()).filter(Boolean).map(text => ({ text }));
  return { nodes, visible: () => true, textOf: n => n.text, pageTitle: '', SW: null, SH: null };
}

function detectObscuring(port) {
  // 判「画面被挡住」不能只匹配文本 —— UI 层级里同时存在**隐藏的/离屏的**视图
  // （例：app 明明在首页，层级里照样搜得到登录页上的按钮文字，
  //  但它的 frame 已滑出可视区）。所以逐节点判三件事：文本命中 + 未隐藏 + frame 与屏幕有实际交叠。
  const h = fetchHierarchy(port);
  if (h.unknown) return { ok: false, unknown: true, reason: h.reason };
  const hits = [];
  for (const n of h.nodes) {
    const txt = h.textOf(n);
    if (!txt) continue;
    for (const o of OBSCURING)
      if (o.any.some(s => txt.includes(s)) && h.visible(n) && !hits.find(x => x.name === o.name))
        hits.push({ ...o, matched_text: txt.slice(0, 60), frame: n.frame || n.attributes?.Frame });
  }
  // texts：可见节点的字，给事中检测核对 shows；写 sidecar 前摘掉，只留摘录
  const texts = h.nodes.filter(n => h.visible(n)).map(n => h.textOf(n)).filter(Boolean);
  const base = { scanned_nodes: h.nodes.length, page_title: h.pageTitle, screen: { w: h.SW, h: h.SH }, texts };
  return hits.length ? { ok: false, hits, ...base } : { ok: true, ...base };
}

/**
 * Android 分支的遮蔽层检查，分两层：先读 dumpsys 的当前聚焦窗口，再读画面上的字（androidScreen，限时的 uiautomator dump）。
 *
 * 判据是硬的：**聚焦窗口必须属于被测包**。不属于 = 这张图拍的不是被测 app 的画面，
 * 无论它看起来多正常。权限弹窗/系统对话框/别的 app 都会在这里显形。
 */
function detectObscuringAndroid(adb, pkg) {
  const r = detectFocusAndroid(adb, pkg);
  if (r.unknown) return r;
  // 聚焦窗口属于被测包，只说明没被别的 app 盖住；app 自己画的登录页 / 协议页 / 弹窗还得看画面上的字。
  // 聚焦窗口已经不对时也读一次：拒绝信息要给出画面上能点的按钮和坐标，执行者才知道怎么关。
  const screen = androidScreen(adb);
  if (screen.unknown) return r.ok ? { ...r, screen_check: screen.reason } : r;
  const hits = dropSplashIfPageIsUp([...(r.hits || [])], screen.nodes, pkg);
  // dump 只给当前活动窗口；里面出现别的包（系统对话框是 package="android"）就是有东西盖在 app 上
  const foreign = [...new Set(screen.nodes.map(n => n.pkg).filter(p => p && p !== pkg && p !== 'com.android.systemui'))];
  if (foreign.length) hits.push({ name: `画面上盖着不属于被测 app 的窗口（${foreign.join(', ')}）`, how: `系统对话框就点掉或按返回键；是桌面或别的 app，就把被测 app 拉回前台：${adb} shell monkey -p ${pkg} -c android.intent.category.LAUNCHER 1` });
  for (const n of screen.nodes) for (const o of OBSCURING)
    if (o.any.some(t => n.text.includes(t)) && !hits.find(x => x.name === o.name))
      hits.push({ name: o.name, how: o.how_android || '按返回键，或点它的关闭 / 跳过按钮', matched_text: n.text.slice(0, 60), at: n.center });
  // 按钮的字常常在不可点的子节点上；一个可点的都没读到时，退而列画面上的字，至少给出坐标
  const clickables = screen.nodes.filter(n => n.clickable);
  const buttons = (clickables.length ? clickables : screen.nodes).slice(0, 8).map(n => ({ text: n.text.slice(0, 20), at: n.center }));
  const texts = screen.nodes.map(n => n.text);
  return hits.length ? { ok: false, hits, focus: r.focus, buttons, texts } : { ok: true, focus: r.focus, scanned_nodes: screen.nodes.length, texts };
}


// 画面上的文字和可点元素。uiautomator dump 在部分模拟器上会挂住，所以设备端和本机两头都限时；
// 读不到就如实返回 unknown，由 shot 提醒执行者自己看图，不当成「画面干净」。
function androidScreen(adb) {
  let xml = '';
  // 画面还在动画时常报 null root node，隔一秒再试一次
  const f = '/sdcard/acceptkit-ui.xml';
  try { xml = execSync(`${adb} shell 'for i in 1 2; do timeout 8 uiautomator dump ${f} >/dev/null 2>&1; [ -s ${f} ] && break; sleep 1; done; cat ${f} 2>/dev/null; rm -f ${f}'`, { encoding: 'utf8', timeout: 25000 }); }
  catch { return { unknown: true, reason: 'uiautomator dump 超时或失败' }; }
  if (!xml.includes('<node')) return { unknown: true, reason: 'uiautomator dump 没有返回画面层级' };
  return { nodes: parseUiDump(xml) };
}


function detectFocusAndroid(adb, pkg) {
  let out = '';
  try { out = execSync(`${adb} shell dumpsys window 2>/dev/null | grep -E "mCurrentFocus|mFocusedApp"`, { encoding: 'utf8' }); } catch {}
  if (!out.trim()) return { ok: false, unknown: true, reason: 'dumpsys window 没有 mCurrentFocus/mFocusedApp' };
  const hits = [];
  const focus = (out.match(/mCurrentFocus=\S*\s+\S+\s+([^}]+)}/) || [])[1] || out.trim();
  if (!focus.includes(pkg)) {
    hits.push({ name: `当前聚焦窗口不属于被测包（focus=${focus.trim()}）`,
                how: `把 ${pkg} 切到前台：adb shell am start -n ${pkg}/<Activity>` });
  }
  for (const [re, name, how] of [
    [/permissioncontroller|GrantPermissions/i, '权限弹窗', 'adb shell pm grant 或手动点掉'],
    // 不要教人 hide_error_dialogs：那会把卡死 / 崩溃从画面上藏掉，正是验收该看见的
    [/ANR|Application Not Responding/i, '应用无响应对话框', '点「Wait / 等待」让它缓过来；反复出现就是 app 卡死，查 logcat 记成执行阻塞'],
    [/crash|AppErrorDialog/i, '崩溃对话框', '查 logcat 的真实崩溃并记下来，再重新起 app'],
  ]) if (re.test(out)) hits.push({ name, how });
  // 启动页只证明进程在，证明不了任何验收步骤（实测：画面层级读不到字时它会被当成干净画面截下来）
  if (/Splash/i.test(focus)) hits.push({ name: '还停在启动页', splash: true, how: '等 app 进到要验的页面再截；一直卡在启动页就是没起来，记成执行阻塞' });
  return hits.length ? { ok: false, hits, focus: focus.trim() } : { ok: true, focus: focus.trim() };
}

const shotLabel = (v) => String(v || 'shot').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '') || 'shot';   // 允许中文；原来的 \w 会把中文全洗成 "--"

// 事中截图检测（core/shot-check.mjs）：截完、写 sidecar 之前查一遍，拒收的图当场删掉，不留成过程证据。
// texts = 画面层级读到的字（读不到给 null）；ocrFallback = 读不到层级时用 OCR 查遮蔽层；
// mustSee = OCR 也不可用时拒收（iOS 原来就是读不到层级就拒，Android 原来只提示看图）。
// 返回写进 sidecar 的 checks；ocr_obscured 是 OCR 命中、被 --allow-obscured 放行的遮蔽层。
function checkShot({ run, png, step, texts, ocrFallback, mustSee, allow, android }) {
  const r = loadResult(run);
  let shows = [];
  const sc = step ? tryLoadCase(r.case_ref || r.case) : null;
  if (sc) shows = allNodes(sc).find(n => n.nodeId === String(step))?.shows || [];
  const sdir = dirname(png), cur = png.split('/').pop();
  const prevFile = readdirSync(sdir).filter(f => /^app-\d+-.*\.png$/.test(f) && f !== cur)
    .sort((a, b) => parseInt(a.slice(4)) - parseInt(b.slice(4)) || a.localeCompare(b)).pop() || null;
  const load = f => { try { return decodePng(readFileSync(f)); } catch { return null; } };
  let text = texts ? texts.join('\n') : null, source = texts ? 'hierarchy' : 'none';
  if (!texts && (ocrFallback || shows.length)) { const o = ocrText(png); if (o !== null) { text = o; source = 'ocr'; } }
  const j = judgeShot({ img: load(png), prev: prevFile && load(join(sdir, prevFile)), prevFile: prevFile && `shots/${prevFile}`,
                        text, source, shows, obscuring: ocrFallback && source === 'ocr' ? OBSCURING : null });
  const refuse = (msg) => { try { unlinkSync(png); } catch {} die(msg); };
  if (j.refuse.length) refuse(`shot: 这张图拒收（已删掉），${j.refuse.join('；')}`);
  if (j.obscured.length && !allow)
    refuse(`shot: 读不到画面层级，OCR 在截图上认出遮蔽层（图已删掉），先处理再截：\n`
      + j.obscured.map(x => `   · ${x.name}：画面上有「${x.matched_text}」\n     关法：${(android && x.how_android) || x.how}`).join('\n')
      + `\n   被验的就是这个画面时才用 --allow-obscured "<理由>"，理由会进盲审。`);
  if (mustSee && source === 'none' && !allow)
    refuse(`shot: 读不到画面层级，OCR 也不可用，**无法确认画面没被遮蔽**（图已删掉）。\n`
      + `   截一张可能无效的图比不截更糟。先修通画面层级读取，或确认画面后用 --allow-obscured "<你确认了什么>" 放行（理由会进盲审）`);
  for (const h of j.hints) console.error(`   ⚠️  ${h}`);
  return { ...j.checks, screen_text_excerpt: mask(ROOT, j.checks.screen_text_excerpt),
           ...(j.obscured.length ? { ocr_obscured: j.obscured.map(x => ({ name: x.name, matched_text: mask(ROOT, x.matched_text) })) } : {}) };
}
function cmdShotAndroid({ pos, opt }, run, udid) {
  const label = shotLabel(opt.label);
  const h = opt.bundle ? null : hostFor('android', { host: opt.host, run });
  if (h?.error) die(`shot: ${h.error}`);
  const pkg = String(opt.bundle || hostApp(CFG, h.id, 'android').package || die(`shot: 宿主 ${h.id} 没登记 Android 包名 —— 传 --bundle，或 acceptkit host add ${h.id} --platform android --package <包名>`));
  const adb = `${adbPath()} -s ${udid}`;
  let pid = '';
  try { pid = execSync(`${adb} shell pidof ${pkg} 2>/dev/null`, { encoding: 'utf8' }).trim().split(/\s+/)[0] || ''; } catch {}
  if (!pid) die(`shot: 设备 ${udid} 上 ${pkg} 没在跑 —— 截图会拍到桌面，证明不了任何事。先起 app`);

  const obs = detectObscuringAndroid(adb, pkg);
  const allow = opt['allow-obscured'] ? String(opt['allow-obscured']) : '';
  if (!obs.ok && !allow) {
    if (obs.unknown) die(`shot: 拿不到当前聚焦窗口（${obs.reason}），**无法确认画面没被遮蔽**。\n` +
      `   截一张可能无效的图比不截更糟。确认画面后用 --allow-obscured "<你确认了什么>" 放行。`);
    const serial = udid;
    const tap = at => at ? `（在 ${at[0]},${at[1]}；点它：adb -s ${serial} shell input tap ${at[0]} ${at[1]}）` : '';
    die(`shot: 这个画面证明不了验收过程或结果，先处理再截：\n`
      + obs.hits.map(x => `   · ${x.name}${x.matched_text ? `：画面上有「${x.matched_text}」${tap(x.at)}` : ''}\n     关法：${x.how}`).join('\n')
      + (obs.buttons?.length ? `\n   画面上能点的：${obs.buttons.map(b => `「${b.text}」${b.at[0]},${b.at[1]}`).join(' · ')}` : '')
      + `\n   弹窗多半能按返回键关：adb -s ${serial} shell input keyevent 4\n   处理完再跑一次 shot：这类弹窗常常连着冒好几个。`
      + `\n   被验的就是这个画面时才用 --allow-obscured "<理由>"，理由会进盲审。`);
  }

  const sdir = join(runDir(run), 'shots');
  mkdirSync(sdir, { recursive: true });
  const seq = String(readdirSync(sdir).filter(f => /^app-\d+-/.test(f)).length + 1).padStart(2, '0');
  const base = `app-${seq}-${label}`;
  const png = join(sdir, base + '.png');
  try { execSync(`${adb} exec-out screencap -p > ${JSON.stringify(png)}`, { shell: '/bin/bash' }); } catch (e) { die(`shot: 截图失败: ${e.message}`); }
  if (!existsSync(png) || statSync(png).size < 1024) die('shot: 截图产物为空或过小，没截到东西');
  const { texts, ...obsRec } = obs;
  const checks = checkShot({ run, png, step: opt.step, texts: texts || null, ocrFallback: !texts, allow, android: true });
  const meta = { kind: 'process_shot', platform: 'android', run, udid, bundle: pkg, pid,
                 at: new Date().toISOString(), label, file: `shots/${base}.png`,
                 bytes: statSync(png).size, obscuring_check: obsRec, checks,
                 page_title_on_screen: obs.page_title || null,   // 从本次层级读的，不是人写的
                 ...(allow ? { allow_obscured_reason: allow } : {}),
                 ...(opt.step ? { step: String(opt.step) } : {}), ...(opt.expect ? { expect: String(opt.expect) } : {}),
                 ...(opt.note ? { note: String(opt.note) } : {}) };
  writeFileSync(png + '.json', JSON.stringify(meta, null, 2));
  console.log(`📸 ${meta.file}（${pkg} pid=${pid}，聚焦窗口 ${obs.focus || 'n/a'}）—— 过程截图，挂步骤`);
  if (obs.screen_check && checks.screen_text_source === 'ocr') console.error(`   ⚠️  没读到画面层级（${obs.screen_check}），改用 OCR 查了遮蔽层；OCR 会漏认 —— 打开这张图看一眼，被挡住就关掉重截`);
  else if (obs.screen_check) console.error(`   ⚠️  没读到画面上的字（${obs.screen_check}），OCR 也不可用，查不了 app 内的登录页 / 弹窗 —— 打开这张图看一眼，被挡住就关掉重截`);
  else console.log(`   打开 ${join(runDir(run), meta.file)} 看一眼：是不是你要证明的那一页`);
  if (opt.step) cmdRecord({ pos: [run], opt: { step: opt.step, evidence: meta.file, note: opt.note || label } });
  return meta;
}

// Web 载体的过程截图：连项目的独立调试 Chrome，查遮蔽层（对话框 / 欢迎弹窗等，项目可用 pack.webObscuring 定制），截图 + sidecar。
// 遮蔽层确认不了时如实写 unknown，不写「干净」。
function cmdShotWeb({ pos, opt }, run) {
  const label = shotLabel(opt.label);
  const ctx = { host: opt.host, run };
  const port = webPort(opt, {}, ctx);
  if (!port) die('shot --web 缺调试端口：--port，或宿主登记的 web.port（acceptkit host add <宿主> --platform web --port N）');
  const sdir = join(runDir(run), 'shots');
  mkdirSync(sdir, { recursive: true });
  const seq = String(readdirSync(sdir).filter(f => /^app-\d+-/.test(f)).length + 1).padStart(2, '0');
  const base = `app-${seq}-${label}`;
  const png = join(sdir, base + '.png');
  const allow = opt['allow-obscured'] ? String(opt['allow-obscured']) : '';
  const args = ['shot', '--port', port, '--out', png, ...(allow ? ['--force', '1'] : [])];
  const tab = webTab(opt, {}, ctx); if (tab) args.push('--tab', tab);
  const r = webCli(args);
  if (!r.ok) die(`shot: web 截图失败：${r.error}`);
  const obs = r.obscuring_check || { ok: false, unknown: true, reason: '没有返回遮蔽层检查结果' };
  if (!obs.ok && !allow) {
    if (obs.unknown) die(`shot: 无法确认页面没被遮蔽（${obs.reason}）。确认画面后用 --allow-obscured "<你确认了什么>" 放行。`);
    die(`shot: 页面被遮蔽层挡着：\n` + (obs.hits || []).map(x => `   · ${x.name}${x.matched_text ? `「${x.matched_text}」` : ''} —— ${x.how}`).join('\n'));
  }
  if (!existsSync(png) || statSync(png).size < 1024) die('shot: 截图产物为空或过小，没截到东西');
  // 遮蔽层已由页面结构查过；页面文字载体没给，shows 只能靠 OCR 核对（只提示）
  const checks = checkShot({ run, png, step: opt.step, texts: null, ocrFallback: false, allow });
  const meta = { kind: 'process_shot', platform: 'web', run, port, url: r.url, page_title_on_screen: r.title || null,
                 at: new Date().toISOString(), label, file: `shots/${base}.png`, bytes: statSync(png).size, obscuring_check: obs, checks,
                 ...(allow ? { allow_obscured_reason: allow } : {}), ...(opt.step ? { step: String(opt.step) } : {}),
                 ...(opt.note ? { note: String(opt.note) } : {}) };
  writeFileSync(join(sdir, base + '.json'), JSON.stringify(meta, null, 2));
  console.log(`📸 shots/${base}.png · ${r.url} · ${obs.ok ? '无遮蔽层' : '⚠️ 遮蔽层已被 --allow-obscured 放行'}`);
  if (opt.step) cmdRecord({ pos: [run], opt: { step: opt.step, evidence: `shots/${base}.png`, note: opt.note || label } });
  return meta;
}

function cmdShot({ pos, opt }) {
  const run = pos[0] || die('shot 必须给 <run>');
  if (!existsSync(resultPath(run))) die(`shot: run 不存在: ${run}`);
  // --step 先核：编号不对时以前照样截图落盘、只是挂不上，也不报 —— 执行者以为过程证据已留（实测踩过）
  if (opt.step) {
    const r0 = loadResult(run), c0 = loadCase(r0.case_ref || r0.case);
    const ids = allNodes(c0).map(n => n.nodeId);
    if (!ids.includes(String(opt.step))) die(`shot: 操作节点 ${opt.step} 不存在，没截图。${c0.case} 的节点：${ids.join(' ')}`);
  }
  // shot 是**过程截图**——证明 app 在跑、停在哪页、没被遮蔽层挡着。它不再挂断言：
  // 断言的图必须由 acceptkit observe 产出（UI 通道读到值那一刻截的，或四段式渲成的判定卡）。
  // 所以 shot 的清单定义里没有 --expect（core/protocol.mjs），带了按未知参数拒收。
  if (opt.web || (!opt.sim && loadResult(run).platform === 'web')) return cmdShotWeb({ pos, opt }, run);
  const udid = runDeviceAddress(run, opt) || die(`shot 必须带 --sim <设备>（或先 acceptkit device acquire --run ${run}，选好占上会记进 run）`);
  touchLease(udid, run);
  // Android 与 iOS 是两套完全不同的取图与遮蔽判定；按 udid 形态分流。
  // 之前只有 iOS 分支，于是 Android 轮次永远拿不到"有效 app 截图"，闸门恒报缺口 ——
  // 一个看不见证据的闸门，训练出来的只有"学会忽略它"。
  if (/^emulator-\d+$/.test(udid) || /^[0-9A-Za-z]+$/.test(udid) && !udid.includes('-')) {
    return cmdShotAndroid({ pos, opt }, run, udid);
  }
  const label = shotLabel(opt.label);
  const h = opt.bundle ? null : hostFor('ios', { host: opt.host, run });
  if (h?.error) die(`shot: ${h.error}`);
  const bundle = String(opt.bundle || hostApp(CFG, h.id, 'ios').bundle || '');
  if (!bundle) die(`shot: 宿主 ${h.id} 没登记 iOS bundle —— 传 --bundle，或 acceptkit host add ${h.id} --platform ios --bundle <bundle id>`);

  // app 必须在跑 —— 拍一张没有 app 的桌面图毫无意义
  const pid = appPid(udid, bundle);
  if (!pid) die(`shot: 设备 ${udid} 上没找到在跑的 app —— 截图会拍到桌面，证明不了任何事。先起 app`);

  // 端口：按 pid 归属选（同机多模拟器时端口会错位）
  let port = opt.port ? String(opt.port) : (PACK.appPortForPid ? (PACK.appPortForPid(pid, udid, HELPERS) || '') : '');

  // ① 遮蔽层检查（有效截图规则的核心）
  let obs = { ok: false, unknown: true, reason: '没有 UI 调试端口，无法检查遮蔽层' };
  if (port) obs = detectObscuring(port);
  const allow = opt['allow-obscured'] ? String(opt['allow-obscured']) : '';
  // 拿不到 UI 层级时先截，再由 checkShot 用 OCR 补查遮蔽层；OCR 也不可用才照旧拒收
  if (!obs.ok && !obs.unknown && !allow) {
    const h = obs.hits.map(x => `   · ${x.name} —— 关掉它：${x.how}`).join('\n');
    die(`shot: 画面被遮蔽层挡着，这张图证明不了验收过程或结果：\n${h}\n` +
      `   先关掉再截（遇到遮蔽层要先关闭该层）。\n` +
      `   确有必要保留该画面（例如就是要验这个弹窗）用 --allow-obscured "<理由>"`);
  }

  // ② 截图 + sidecar
  const sdir = join(runDir(run), 'shots');
  mkdirSync(sdir, { recursive: true });
  const seq = String(readdirSync(sdir).filter(f => /^app-\d+-/.test(f)).length + 1).padStart(2, '0');
  const base = `app-${seq}-${label}`;
  const png = join(sdir, base + '.png');
  // 先落到本机临时目录再拷进 run：simctl io 可能没有外接卷的写权限，直写外接卷会报 Operation not permitted（实测）
  const tmpPng = join(process.env.TMPDIR || '/tmp', `acceptkit-shot-${process.pid}-${Date.now()}.png`);
  try {
    execSync(`xcrun simctl io ${udid} screenshot ${JSON.stringify(tmpPng)} 2>/dev/null`);
    writeFileSync(png, readFileSync(tmpPng)); unlinkSync(tmpPng);
  } catch (e) { die(`shot: 截图失败: ${e.message}`); }
  if (!existsSync(png) || statSync(png).size < 1024) die('shot: 截图产物为空或过小，没截到东西');
  const { texts, ...obsRec } = obs;
  const checks = checkShot({ run, png, step: opt.step, texts: obs.unknown ? null : texts, ocrFallback: !!obs.unknown, mustSee: true, allow });
  const meta = { kind: 'process_shot', platform: 'ios', run, udid, bundle, pid, port: port || null,
                 at: new Date().toISOString(), label, file: `shots/${base}.png`,
                 bytes: statSync(png).size, obscuring_check: obsRec, checks,
                 page_title_on_screen: obs.page_title || null,   // 从本次层级读的，不是人写的（此前 iOS 分支漏写，打印永远是「没读到」）
                 ...(allow ? { allow_obscured_reason: allow } : {}),
                 ...(opt.step ? { step: String(opt.step) } : {}), ...(opt.expect ? { expect: String(opt.expect) } : {}),
                 ...(opt.note ? { note: String(opt.note) } : {}) };
  writeFileSync(join(sdir, base + '.json'), JSON.stringify(meta, null, 2));
  const obsWord = obs.ok ? '无遮蔽层' : allow ? '⚠️ 遮蔽层已被 --allow-obscured 放行' : 'OCR 补查无遮蔽层（没读到 UI 层级，OCR 会漏认，打开图看一眼）';
  console.log(`📸 shots/${base}.png（${(meta.bytes / 1024).toFixed(0)} KB）· pid ${pid} · ${obsWord}`);
  console.log(`   画面上的页面标题：「${meta.page_title_on_screen || '(没读到)'}」 ← 对照你写的 note，不符就是拍错页了`);
  console.log(`   挂到步骤：acceptkit record ${run} --step <nN> --evidence shots/${base}.png   （过程截图不挂断言）`);
  console.log(`   打开 ${png} 看一眼：是不是你要证明的那一页`);
  if (opt.step) cmdRecord({ pos: [run], opt: { step: opt.step, evidence: `shots/${base}.png`, note: opt.note || label } });
  return meta;
}


// ════════════ 流水线：用例评审 ════════════
// 「一个需求的 N 条执行记录用例各不一样」，根因就在这一步缺失。
// 评审单 = 这个需求的**用例基线**：改动面逐条列出 → 每条指定引用哪些存量/新建哪些/不覆盖+理由。
function opsIndexForPlan() {
  const ops = loadOps(); const idx = {};
  for (const [k, v] of Object.entries(ops)) {
    const miss = ['ios', 'android'].filter(pf => !doableOn(v, pf));
    idx[k] = { id: k, title: v.title, missing: miss };
  }
  return idx;
}
function knownCaseNames() {
  const s = new Set();
  if (existsSync(CASES)) for (const f of readdirSync(CASES)) if (f.endsWith('.case.json')) s.add(f.replace(/\.case\.json$/, ''));
  return s;
}
function demandTitle(id) { return knownDemands().get(id)?.title || ''; }
// 评审单声明了平台时，它点名的每条用例都得在该平台上可执行（声明了 且 操作都有配方）
function planPlatformErrors(plan) {
  const errs = [];
  if (!plan.platform) return errs;
  const ops = loadOps();
  for (const sf of plan.surfaces || []) for (const name of [...(sf.reuse || []), ...(sf.new || [])]) {
    let c; try { c = JSON.parse(readFileSync(join(CASES, `${name}.case.json`), 'utf8')); } catch { continue; }
    const ap = applicability(c, ops, CFG)[plan.platform];
    if (!ap) continue;
    if (!ap.declared) errs.push(`${sf.id}: 用例 ${name} 声明 platform=${c.platform || '(缺)'}，不适用本评审单的平台 ${plan.platform}`);
    else if (ap.missing.length) errs.push(`${sf.id}: 用例 ${name} 用到的操作在 ${plan.platform} 侧没有配方：${ap.missing.join(' ')}`);
  }
  return errs;
}
// 评审单里每条用例的质量：不达标是硬错（不能批准）；提示与存量质量债汇总成一行
function planQuality(plan) {
  const errs = [], warns = [];
  for (const name of planCases(plan)) {
    const c = tryLoadCase(name);
    if (!c) continue;
    const q = caseQuality(c);
    const rules = fs => [...new Set(fs.map(f => f.rule))].join(' ');
    if (q.block.length) errs.push(`用例 ${name} 质量不达标（${rules(q.block)}）：acceptkit validate ${name}`);
    if (q.warn.length) warns.push(`用例 ${name} 质量提示 ${q.warn.length} 处（${rules(q.warn)}）`);
  }
  return { errs, warns };
}

function cmdPlan({ pos }) {
  const sub = pos[0] || die('用法：acceptkit plan <new|show|review|check|approve|return|add-case|finding|decide|bounce|settle|recheck> <demand> [..]\n       review = 给人读的评审稿（这次动了什么 → 所以验什么 → 挑几条真实断言展开），--out <file> 落盘');
  const demand = pos[1] || die('缺 <demand>（例：D1）');
  const { opt } = parseArgs(process.argv.slice(4));
  let plan = loadPlan(ROOT, demand);

  if (sub === 'new') {
    if (plan && !opt.force) die(`需求 ${demand} 已有评审单（v${plan.revision}）。改它用 plan add-case / plan finding；真要重来加 --force`);
    const platform = opt.platform ? String(opt.platform) : null;
    if (platform && !RUNTIME_PLATFORMS.includes(platform)) die(`评审单的 --platform 只能是 ${RUNTIME_PLATFORMS.join('|')}（一条需求在一端验；两端都验就两张评审单）`);
    if (opt.title) registerDemand(ROOT, { id: demand, title: String(opt.title), desc: opt.desc ? String(opt.desc) : '' });
    plan = { demand, title: opt.title ? String(opt.title) : demandTitle(demand),
             platform,   // ios | android；只对本平台报「操作缺实现」，并要求点名的用例在该平台可执行
             revision: 1, created_at: new Date().toISOString(), approved_by: null, approved_at: null,
             surfaces: [], not_covered: [], history: [] };
    const f = savePlan(ROOT, plan);
    console.log(`📝 评审单骨架 → ${f}`);
    console.log(`   现在逐条填「改动面」。一条改动面 = 这次改了什么，它坏了端上会怎么表现。`);
    console.log(`   加一条：acceptkit plan add-case ${demand} --surface S1 --change "<改动面>" --reuse a,b --new c --ops op1,op2`);
    console.log(`   要产品定的行为变更：acceptkit plan finding ${demand} --what "<一句话>" --kind <性质> --impact "<影响范围>" --why "<读懂要知道的事>" --option "<做法> => <后果>" --option .. --recommend "<推荐+理由>" --decide "<要你定什么>" --detail "<技术细节>"`);
    console.log(`   填完自检：acceptkit plan check ${demand}`);
    return;
  }
  if (!plan) die(`需求 ${demand} 还没有评审单 —— 先 acceptkit plan new ${demand}`);

  if (sub === 'add-case') {
    const sid = opt.surface ? String(opt.surface) : die('缺 --surface <S-id>');
    const before = approvedCases(plan);
    let s = plan.surfaces.find(x => x.id === sid);
    if (!s) { s = { id: sid, change: '', reuse: [], new: [], ops: [], note: '' }; plan.surfaces.push(s); }
    if (opt.change) s.change = String(opt.change);
    for (const [k, f] of [['reuse', 'reuse'], ['new', 'new'], ['ops', 'ops']])
      if (opt[f] !== undefined) s[k] = [...new Set([...(s[k] || []), ...asList(opt[f])])];
    if (opt.case) s.new = [...new Set([...(s.new || []), ...asList(opt.case)])];
    // --drop：把用例从本改动面的 reuse/new 里摘掉（例：原来整条复用的大用例，改成只引用其中相关断言抽出来的小用例）。
    // 与加用例一样是修订：已批准的单子要带 --why、升版本、重批。
    if (opt.drop !== undefined) {
      const drop = new Set(asList(opt.drop));
      const missing = [...drop].filter(x => !(s.reuse || []).includes(x) && !(s.new || []).includes(x));
      if (missing.length) die(`--drop 的 ${missing.join(' ')} 不在 ${sid} 的引用里`);
      s.reuse = (s.reuse || []).filter(x => !drop.has(x)); s.new = (s.new || []).filter(x => !drop.has(x));
    }
    if (opt.note) s.note = String(opt.note);
    // 评审人视角的字段（只给用例名，评审人没法评审）——
    // 闸需要的是「哪些用例在范围内」，评审人需要的是「坏了会怎样 / 够不够 / 漏了什么」。
    // 这两套字段不一样，只写前者做出来的表是评审不了的。
    for (const k of ['risk', 'covered', 'uncovered', 'decide', 'severity'])
      if (opt[k] !== undefined) s[k] = String(opt[k]);
    if (opt['not-covered']) die(`--not-covered 已废弃：改动了就要测，没有「不覆盖」这条路`);
    // 已批准的单子上再动用例 = 评审单修订，必须递增 revision 并说明原因（看板据此区分
    // 「需求变更」与「用例漂移」—— 这两件事必须分清）
    if (plan.approved_at) {
      if (!opt.why) die(`评审单已批准（v${plan.revision}），改它必须带 --why "<为什么现在才加>" —— 这条会进修订历史`);
      plan.revision += 1;
      plan.history.push({ revision: plan.revision, at: new Date().toISOString(), by: opt.by ? String(opt.by) : null,
                          change: `${sid}: ${opt.why}` });
      // 改过就要重批，但重批的只是这次的变化：批准时钉了指纹的用例照常跑（approvedCases）。
      // 没钉过指纹的旧单子，按改之前的用例集合补钉 —— 否则清空批准等于把整张单子停下
      if (!plan.fingerprints) plan.fingerprints = caseFingerprints(CASES, plan, before);
      plan.approved_at = null; plan.approved_by = null;
      const { added } = planDelta(plan);
      console.log(`↻ 评审单升到 v${plan.revision}，批准状态已清空：${added.length ? `新加的 ${added.join(' ')} 等 Owner 批准，` : ''}已批过的 ${approvedCases(plan).size} 条照常跑`);
    }
    savePlan(ROOT, plan);
    console.log(`✅ ${sid}：引用${(s.reuse || []).length} 新建${(s.new || []).length} 操作${(s.ops || []).length}`);
    return;
  }
  if (sub === 'pending' || sub === 'not-covered' || sub === 'set-pending' || sub === 'set-not-covered') {
    die(`子命令 ${sub} 已废弃：改动了就要测，评审单里没有「待测/不覆盖」这一栏。\n`
      + `   · 真的缺用例 → acceptkit new <case> --demand ${demand}，再 plan add-case ${demand} --surface <S> --new <case>\n`
      + `   · 只是还没跑 → 那是执行阻塞：record --status blocked --unlock "…"，再 acceptkit blockers ${demand} --raise\n`
      + `   · 产品行为变更要 owner 定 → acceptkit plan finding ${demand} --what .. --kind .. --impact .. --why .. --option .. --recommend .. --decide ..（写法 docs/finding-quality.md）`);
  }
  if (sub === 'finding') {
    // 「改动造成的行为变更」不是测试缺口，不该混在待测里让 owner 以为是「要不要测」。
    // 写入闸（看不懂的 finding 定不了）：owner 拍板前必问的四件事 ——
    // 性质（bug / 设计 / 用例自己的问题…）、影响范围、为什么（读懂要知道的那件事）、选项+后果+推荐 ——
    // 缺一样或人话区混着代码标识就不收。代码标识、断言原文放 --detail。
    // --finding Fxx = 改写已有的一条（补字段 / 被 owner 退回后重写），不另开一条 —— 另开就是更正链。
    plan.findings ||= [];
    const fields = {};
    for (const k of ['what', 'detail', 'decide', 'kind', 'impact', 'why', 'recommend']) if (opt[k] !== undefined) fields[k] = String(opt[k]);
    if (opt.option !== undefined) fields.options = [].concat(opt.option).map(parseOption);
    const usage = `\n   性质 --kind ${Object.keys(FINDING_KINDS).join('|')}；写法见 docs/finding-quality.md`;
    if (opt.finding) {
      const fid = String(opt.finding);
      const f = plan.findings.find(x => x.id === fid) || die(`${demand} 里没有 ${fid}`);
      if (f.decided_by) die(`${fid} owner 已经定过（${f.decided_by}），不再改写`);
      const next = { ...f, ...fields, rewritten_at: new Date().toISOString() };
      const bad = findingProblems(next);
      if (bad.length) die(`${fid} 改写后还不合格：\n   · ${bad.join('\n   · ')}${usage}`);
      // 旧写法留底：改写是为了让 owner 读懂，不是抹掉当时记下的东西
      const was = Object.fromEntries(Object.keys(fields).filter(k => f[k] !== undefined && JSON.stringify(f[k]) !== JSON.stringify(fields[k])).map(k => [k, f[k]]));
      if (Object.keys(was).length) (f.prior ||= []).push({ at: next.rewritten_at, ...was });
      Object.assign(f, fields, { rewritten_at: next.rewritten_at });
      savePlan(ROOT, plan);
      console.log(`✎ ${fid} 已改写${f.bounced ? '（owner 退回的那句已回应）' : ''}`);
      return;
    }
    const f = { id: `F${plan.findings.length + 1}`, ...fields, at: new Date().toISOString(), decided_by: null, decision: null };
    if (!f.decide) die('缺 --decide：要 owner 定什么（一句问句）');
    const bad = findingProblems(f);
    if (bad.length) die(`这条 finding owner 读不懂 / 定不了，先补：\n   · ${bad.join('\n   · ')}${usage}`);
    plan.findings.push(f);
    savePlan(ROOT, plan);
    console.log(`🔻 ${f.id} 已记下 —— 等 owner 定：${f.decide}`);
    return;
  }
  // ---- plan bounce：owner 说「看不懂」，把这条退回执行者重写 ----
  // 看不懂的 finding 硬定 = 定错。退回不是拍板：不写 decided_by，只记 owner 哪里看不懂（原话）；
  // 执行者用 plan finding --finding Fxx 改写后才回到「等你定」。
  // ---- plan return：owner 看了这一版评审单说「不行」，带一句意见退回执行者改 ----
  // 退回不是批准，也不清空已批过的用例（它们照常测）；执行者照意见改了评审单（升版本）再来问。
  if (sub === 'return') {
    if (plan.approved_at) die(`${demand} 评审单 v${plan.revision} 已经批过了，没有可退回的`);
    const by = opt.by ? String(opt.by) : die('缺 --by <谁退回的>');
    if (SELF_DECIDER.test(by)) die(`--by ${by} 是执行者自己。退回是 owner 的决定：你觉得评审单该改，直接改（plan add-case …），改完请他批`);
    const quote = String(opt.quote || die('缺 --quote "<他的意见，原话>"'));
    // 未批准时改评审单不升版本，所以「改过没有」看改动面的指纹，不看版本号
    plan.returned = { by, quote, at: new Date().toISOString(), revision: plan.revision, scope: scopeFingerprint(plan) };
    (plan.history ||= []).push({ revision: plan.revision, at: plan.returned.at, by, change: `owner 退回 v${plan.revision}：${quote}` });
    savePlan(ROOT, plan);
    recordApproval(ROOT, { kind: 'plan_return', subject: demand, by, quote, detail: { revision: plan.revision } });
    console.log(`↩ ${demand} 评审单 v${plan.revision} 已退回执行者：${quote.slice(0, 80)}`);
    return;
  }
  if (sub === 'bounce') {
    const fid = String(opt.finding || die('缺 --finding <Fxx>'));
    const f = (plan.findings || []).find(x => x.id === fid) || die(`${demand} 里没有 ${fid}`);
    if (f.decided_by) die(`${fid} 已经定过（${f.decided_by}）`);
    const by = opt.by ? String(opt.by) : die('缺 --by <谁退回的>');
    if (SELF_DECIDER.test(by)) die(`--by ${by} 是执行者自己。退回是 owner 说「看不懂」；你觉得写得不清楚，直接 plan finding ${demand} --finding ${fid} 改写`);
    const quote = String(opt.quote || die('缺 --quote "<哪里看不懂，原话>"'));
    f.bounced = { by, quote, at: new Date().toISOString() };
    (f.bounce_history ||= []).push(f.bounced);
    savePlan(ROOT, plan);
    console.log(`↩ ${fid} 已退回执行者重写：${quote.slice(0, 80)}`);
    return;
  }
  // ---- plan decide：把 owner 对某条 finding 的决定写回那一条 ----
  //
  // 为什么要有：`plan finding` 只能**新建**。owner 定了之后无处可写，
  // 结果要么另开一条 finding 说「这是对 Fxx 的答复」（台账越来越长、读的人分不清哪条还没定），
  // 要么只活在聊天记录里（下次又问一遍已定的事）。
  // 决定必须写回它回答的那一条，并且**原话照抄** —— 复述会在传递中走样。
  //
  // 漏存的几种样子（一个真实需求的上百条 finding 里实测）：owner 在聊天里回了，执行者照着做了却没记；
  // 记成了执行者的 settle（原话变成复述、没有 by）；记进评审单 history；一句话回了好几条只记了一条；
  // 「按你建议来」没记下当时推荐的是哪个选项，推荐后来改写了就对不上。所以：
  // --finding 可以一次给多条（一句话回了几条）；--option 把选中的那项连同后果原样快照进来；
  // --by 不能是执行者自己；每次拍板另记一条进 SQLite 审批表（谁、哪条、原话），评审单被覆盖也查得回来。
  if (sub === 'decide') {
    const fids = String(opt.finding || die('缺 --finding <Fxx>（一句话回了几条就 --finding F1,F2）')).split(',').map(x => x.trim()).filter(Boolean);
    const fs = fids.map(id => (plan.findings || []).find(x => x.id === id) || die(`${demand} 里没有 ${id}`));
    const by = opt.by ? String(opt.by) : die('缺 --by <谁定的> —— 决定是有人拍板的');
    if (SELF_DECIDER.test(by)) die(`--by ${by} 是执行者自己。owner 没定的事不能用 decide 记：不用他定的用 plan settle ${demand} --finding <Fxx> --kind executor --note "…"`);
    const quote = String(opt.quote || die('缺 --quote "<原话>" —— 照抄，别复述'));
    const pick = opt.option === undefined ? null : String(opt.option);
    if (pick !== null && fs.length > 1) die('--option 只能配一条 finding：几条选的不一样，分开 decide');
    const at = new Date().toISOString();
    for (const f of fs) {
      let chosen = null;
      if (pick !== null) {
        const ops = f.options || [];
        if (pick === 'recommend') {
          if (!f.recommend) die(`${f.id} 没写推荐，--option recommend 对不上任何一项；给选项序号 1..${ops.length}`);
          chosen = { recommend: f.recommend };
        } else {
          const i = Number(pick);
          if (!Number.isInteger(i) || i < 1 || i > ops.length) die(`--option 是选项序号 1..${ops.length} 或 recommend（${f.id} 的选项：${ops.map((o, k) => `${k + 1}. ${o.label}`).join('；') || '无'}）`);
          chosen = { index: i, ...ops[i - 1] };
        }
      }
      Object.assign(f, { decided_by: by, decision: quote, decided_at: at, ...(chosen ? { decision_option: chosen } : {}) });
      if (fs.length > 1) f.decision_with = fids.filter(x => x !== f.id);
      if (opt.note) f.decision_note = String(opt.note);
      delete f.settled;   // owner 的回答盖过执行者此前的收口
    }
    savePlan(ROOT, plan);
    recordApproval(ROOT, { kind: 'finding', subject: demand, by, quote, detail: { findings: fids, option: pick } });
    console.log(`✅ ${fids.join('、')} 已定（${by}）：${quote.slice(0, 80)}${quote.length > 80 ? '…' : ''}`);
    const left = (plan.findings || []).filter(x => !x.decided_by && !x.settled).length;
    console.log(`   还有 ${left} 条等 owner 定`);
    return;
  }
  // ---- plan settle：执行者把「其实不用 owner 定」的 finding 收口 ----
  //
  // 「等你定」里混着执行者自己的更正链（一个根因六次更正，每次都另开一条）、已被后来查实的事实回答掉的问题、
  // 以及执行者自己的活。全都摆给 owner = 他要在重复和噪音里找真正要拍板的那几条。
  // 收口不是替 owner 拍板：写的是 settled（执行者、带理由、可指向接手的那条），不碰 decided_by；
  // 看板照样列出来、标「执行者已收口（owner 可推翻）」。owner 不认可 → plan decide 直接改判，或 --undo 放回。
  if (sub === 'settle') {
    const fid = String(opt.finding || die('缺 --finding <Fxx>'));
    const f = (plan.findings || []).find(x => x.id === fid) || die(`${demand} 里没有 ${fid}`);
    if (opt.undo) { delete f.settled; savePlan(ROOT, plan); console.log(`↩ ${fid} 放回「等 owner 定」`); return; }
    if (f.decided_by) die(`${fid} owner 已经定过（${f.decided_by}），不用收口`);
    const KINDS = { superseded: '被后面的 finding 更正 / 取代', answered: '问题已被查实的事实回答', executor: '执行者自己的活，不需要 owner 选' };
    const kind = String(opt.kind || die(`缺 --kind ${Object.keys(KINDS).join('|')}`));
    if (!KINDS[kind]) die(`--kind 只能是 ${Object.keys(KINDS).join(' / ')}`);
    const ref = opt.ref ? String(opt.ref) : null;
    if (kind === 'superseded' && !ref) die('superseded 要给 --ref <接手的那条 Fxx> —— owner 要知道该去读哪条');
    if (ref) {
      const r = (plan.findings || []).find(x => x.id === ref) || die(`${demand} 里没有 ${ref}`);
      if (ref === fid) die('--ref 不能指向自己');
      if (kind === 'superseded' && Date.parse(r.at || 0) < Date.parse(f.at || 0)) die(`${ref} 比 ${fid} 早，不能取代它`);
    }
    const note = String(opt.note || die('缺 --note "<为什么不用 owner 定>" —— owner 要能复核'));
    // answered 只给「查实的事实」用，要指得出事实在哪：一个运行，或 owner 已经 decide 过的那条。
    // owner 在聊天里的回答不是事实，是拍板：走 plan decide 记原话。以前这里收进了一批 owner 的回答，原话全丢了。
    if (kind === 'answered') {
      const ev = opt.evidence ? String(opt.evidence) : null;
      const refDecided = ref && (plan.findings || []).find(x => x.id === ref)?.decided_by;
      if (!ev && !refDecided) die(`answered 要指出事实在哪：--evidence <运行 id>，或 --ref 一条 owner 已经定过的 Fxx。\n   是 owner 回答的：acceptkit plan decide ${demand} --finding ${fid} --by <他> --quote "<原话>"`);
      if (ev && !existsSync(join(ROOT, 'runs', ev))) die(`--evidence ${ev} 不是一个运行`);
    }
    f.settled = { kind, ref, note, at: new Date().toISOString(), ...(opt.evidence ? { evidence: String(opt.evidence) } : {}) };
    savePlan(ROOT, plan);
    console.log(`☑ ${fid} 已收口（${KINDS[kind]}${ref ? ` → ${ref}` : ''}）：${note.slice(0, 80)}`);
    const left = (plan.findings || []).filter(x => !x.decided_by && !x.settled).length;
    console.log(`   还有 ${left} 条等 owner 定（owner 不认可：acceptkit plan settle ${demand} --finding ${fid} --undo）`);
    return;
  }
  // ---- plan review：给人读的评审稿 ----
  //
  // 为什么要和 `plan show` 分开（它是帮没参与执行的人理解这次需求测了什么）：
  // `show` 是**执行者的自检面** —— 它要把每个改动面点名的用例名、用到的操作、硬错警告全列出来，
  // 因为那是机器判「够不够格开跑」的依据。但那份东西给**没参与执行的人**读是失败的：
  // 一屏 37 个用例名换不来「这次到底测了什么」的理解（铁律 0.06 抓过同一个病的三个变体）。
  //
  // `review` 换成读者的顺序：先说这次动了什么（人话），再说因此补了什么（叙述式概括，**不列用例名**），
  // 然后挑几条真实断言展开，让前面的概括落地。最后才是缺口与待定。
  //
  // 🔴 highlight 一律取**断言原文**（title / observe 规格 / why），不另写一段解释：
  // 自己写的解释只能证明「我理解我自己的话」，读者要的是「这条用例实际会判什么」。
  if (sub === 'review') {
    const want = Number(opt.highlights || 6);
    const stat = name => {
      try {
        const c = loadCase(name);
        const es = allExpects(c);
        // 占位判定：标题或断言里还留着模板文字 —— 这种「点名了但没写」在列清单的视图里看不出来，
        // 叙述式一展开就露馅（实测揪出过一条模板没填的用例）。
        // 🚨 只认**生成器留下的字面模板串**，不认泛词。
        // 实测：原来把裸「占位」和裸「TODO」也算上，于是
        // 一条正常用例被误判成占位 —— 它那条断言里的「占位」说的是
        // 消息模板里的 %{} **格式占位符**，是业务术语。同形不同义。
        // 判据只能是模板自己写死的那几个串（「TODO 标题」「预期a（如：」「<填…>」）。
        const tmpl = /TODO\s*标题|XXX\s*标题|预期[a-z]（如[：:]|<填[^>]*>/i;
        const placeholder = tmpl.test(String(c.title || '')) || es.some(e => tmpl.test(String(e.assert || e.title || '')));
        return { ok: true, name, title: c.title || name, n: es.length, es, placeholder,
                 platform: c.platform, host: c.host, note: c.android_note || c.note || '' };
      } catch { return { ok: false, title: name, n: 0, es: [] }; }
    };
    const surfaces = (plan.surfaces || []).map(sf => {
      const names = [...(sf.reuse || []), ...(sf.new || [])];
      const cs = names.map(stat);
      return { sf, cs, cases: cs.length, asserts: cs.reduce((a, b) => a + b.n, 0),
               missing: cs.filter(c => !c.ok).map(c => c.title),
               placeholders: cs.filter(c => c.ok && c.placeholder).map(c => c.name) };
    });
    const totC = surfaces.reduce((a, b) => a + b.cases, 0);
    const totA = surfaces.reduce((a, b) => a + b.asserts, 0);
    // 人话那一句：优先 surface.plain（作者写的），否则取 change 的第一句（截到第一个句号/换行）
    const plain = sf => String(sf.plain || sf.change || '').split(/\n|。/)[0].trim();
    const L = [];
    L.push(`# ${plan.title}`);
    L.push(`## 用例评审稿 · ${demand} v${plan.revision}${plan.approved_at ? `（已批准 · ${plan.approved_by}）` : '（未批准）'}`);
    L.push('');
    L.push(`这次动了 ${surfaces.length} 块，为此备了 ${totC} 条用例 / ${totA} 条断言。`);
    L.push(`下面按「改了什么 → 所以验什么 → 具体长什么样」讲，不列用例名清单。`);
    L.push('');
    L.push(`## 一、这次动了什么`);
    L.push('');
    surfaces.forEach(({ sf }, i) => L.push(`${i + 1}. ${plain(sf)}`));
    L.push('');
    L.push(`## 二、所以备了哪些用例`);
    L.push('');
    for (const { sf, cases, asserts, cs, placeholders } of surfaces) {
      const kinds = [];
      if ((sf.reuse || []).length) kinds.push(`复用存量 ${sf.reuse.length} 条`);
      if ((sf.new || []).length) kinds.push(`本轮新建 ${sf.new.length} 条`);
      // 不重复第一节那整句（读者刚读过）：这里只给短标签 + 数量 + 为什么够
      L.push(`**${sf.label || sf.id}**　${kinds.join(' · ')}，合计 ${asserts} 条断言。`);
      // why 的第一句 = 为什么这些就够了
      const why = String(sf.why || '').split(/\n/)[0].trim();
      if (why) L.push(`　为什么这些够：${why}`);
      if ((placeholders || []).length) L.push(`　🚨 其中 ${placeholders.length} 条还是**模板占位**（标题/断言里留着模板文字），等于这一面实际没有判据：${placeholders.join(', ')}`);
      L.push('');
    }
    L.push(`## 三、挑几条展开（让上面那些话落地）`);
    L.push('');
    L.push(`以下每条都是用例里的**原话**，不是复述 —— 读它就知道这条用例实际会判什么。`);
    L.push('');
    const picked = [], noObs = [];
    for (const { sf, cs } of surfaces) {
      const names = String(sf.highlight || '').split(',').map(x => x.trim()).filter(Boolean);
      const pool = names.length ? cs.filter(c => names.includes(c.name) || names.includes(c.title)) : cs;
      // 占位用例不配当 highlight —— 拿模板文字当「让人更懂」的例子是反效果
      const real = pool.filter(c => c.ok && !c.placeholder);
      // 自动挑：带 observe 的优先（有机判判据），再按 why 的长度取信息量最大的一条
      // 🔴 只挑**带 observe** 的断言：没有机判判据的条目摆出来，读者看到的是「人判」两个字，
      // 等于没解释任何东西（第一版挑出来的大多如此）。这一面若一条都没有，
      // 就不出 highlight，而在第四节把它点名 —— 「这一面没有机器可判的判据」本身是要让人看见的事。
      const withObs = (real.length ? real : pool.filter(c => c.ok))
        .flatMap(c => c.es.map(e => ({ c, e }))).filter(x => x.e.observe);
      const cand = withObs.sort((a, b) => String(b.e.why || '').length - String(a.e.why || '').length)[0];
      if (cand) picked.push({ sf, ...cand });
      else noObs.push(sf.label || sf.id);
    }
    for (const { sf, c, e } of picked.slice(0, want)) {
      L.push(`### ${c.title}`);
      L.push(`　（这一面：${plain(sf)}）`);
      L.push(`　**断言 ${e.id}**：${e.assert || e.title || '(无标题)'}`);
      if (e.why) L.push(`　为什么这么判：${e.why}`);
      const o = e.observe;
      if (o) {
        L.push(`　判据面：\`${o.op}\`${o.params?.module ? `（${o.params.module}）` : ''}`);
        for (const ck of (o.checks || []).slice(0, 2))
          L.push(`　　· 取 \`${ck.pick}\`，要求 ${JSON.stringify(ck.predicate)}${ck.why ? ` —— ${ck.why}` : ''}`);
        const gs = Array.isArray(o.guard) ? o.guard : (o.guard ? [o.guard] : []);
        for (const g of gs.slice(0, 1))
          L.push(`　　· 前提（不成立就记 blocked，不记 fail）：取 \`${g.pick}\`，要求 ${JSON.stringify(g.predicate)}`);
      } else {
        L.push(`　判据面：无 observe —— 人判（看这条的 why 与证据要求）`);
      }
      L.push('');
    }
    L.push(`## 四、还缺什么 / 还等什么`);
    L.push('');
    const miss = surfaces.flatMap(x => x.missing);
    if (miss.length) L.push(`- ⚠️ ${miss.length} 条点名了但文件不在：${miss.join(', ')}`);
    const ph = surfaces.flatMap(x => x.placeholders || []);
    if (ph.length) L.push(`- 🚨 ${ph.length} 条是模板占位、还没真写（点名了≠有判据）：${ph.join(', ')}`);
    // 🚨 findings 是**追加式的调查记录**，不是待决清单：里面大量条目已被后续记录推翻、
    // 作废或当场解决（实测：几十条里真正待定的只有最后几条）。
    // 第一版把全部未 decided 的都列成「等 owner 定」，读者会被淹，而且是错的 ——
    // 「没写 decided_by」不等于「还要人定」。
    // 口径改成：只列最近 --findings N 条（缺省 8，按记录顺序取尾部 = 本轮新立的），
    // 并把总数与这个取法明说，不假装那是全部待决项。
    const allF = (plan.findings || []).filter(f => !f.decided_by && !f.settled);   // 执行者已收口的（plan settle）不算待定
    const fn = Number(opt.findings || 8);
    const fs = allF.slice(-fn);
    if (allF.length) {
      L.push(`- 待定项：findings 共 ${plan.findings.length} 条（追加式调查记录，其中大半已被后续条目推翻或当场解决 —— 「没写 decided_by」不等于「还要人定」）。`);
      L.push(`　下面只列**最近 ${fs.length} 条**（本轮新立的）。全部见 \`acceptkit plan show ${demand}\`：`);
      for (const f of fs) L.push(`　- **${f.id}** ${String(f.what).split(/\n/)[0].slice(0, 100)}\n　　要定：${String(f.decide).split(/\n/)[0].slice(0, 140)}`);
    }
    if (noObs.length) L.push(`- ⚠️ ${noObs.length} 个改动面没有带机判判据（observe）的断言，只能人判：${noObs.join(', ')}`);
    if (!plan.approved_at) {
      const { added, removed } = planDelta(plan), ok = approvedCases(plan).size;
      L.push(!ok ? `- 评审单未批准，一条也开不了跑：\`acceptkit plan approve ${demand} --by <谁> --quote "<原话>"\``
        : `- 这一版相对上次批准：${[added.length && `新加 ${added.join('、')}`, removed.length && `摘掉 ${removed.join('、')}`].filter(Boolean).join('；') || '用例没变'}。`
          + `只有新加的等批准，已批过的 ${ok} 条照常在测：\`acceptkit plan approve ${demand} --by <谁> --quote "<原话>"\``);
    }
    const text = L.join('\n') + '\n';
    if (opt.out) { writeFileSync(String(opt.out), text); console.log(`📄 评审稿 → ${opt.out}（${text.split('\n').length} 行）`); }
    else console.log(text);
    return;
  }
  if (sub === 'check' || sub === 'show') {
    const { errs, warns } = checkPlan(plan, opsIndexForPlan(), knownCaseNames());
    errs.push(...planPlatformErrors(plan));
    const pq = planQuality(plan); errs.push(...pq.errs); warns.push(...pq.warns);
    // 等 owner 定、但写得 owner 读不懂 / 定不了的 finding：执行者的待办，不是 owner 的
    const unclear = (plan.findings || []).filter(f => !f.decided_by && !f.settled).map(f => [f.id, findingProblems(f)]).filter(([, b]) => b.length);
    if (unclear.length) warns.push(`${unclear.length} 条待定 finding 写得 owner 定不了（看板里排在「执行者待补写」）：`
      + unclear.slice(0, 5).map(([id, b]) => `\n       ${id}：${b[0]}${b.length > 1 ? ` 等 ${b.length} 处` : ''}`).join('') + (unclear.length > 5 ? `\n       …` : ''));
    const delta = planDelta(plan);
    console.log(`📋 ${demand} 用例评审单 v${plan.revision}${plan.approved_at ? `（已批准 · ${plan.approved_by} · ${plan.approved_at.slice(0, 16).replace('T', ' ')}）` : '（⚠️ 未批准）'}`);
    console.log(`   ${plan.title}\n`);
    if (!plan.approved_at && approvedCases(plan).size)
      console.log(`   相对上次批准：${[delta.added.length && `新加 ${delta.added.join(' ')}（等批准）`, delta.removed.length && `摘掉 ${delta.removed.join(' ')}`].filter(Boolean).join('；') || '用例没变'}；已批过的 ${approvedCases(plan).size} 条照常跑\n`);
    for (const s of plan.surfaces) {
      console.log(`  ${s.id}  ${s.change}`);
      if ((s.reuse || []).length) console.log(`       引用存量：${s.reuse.join(' ')}`);
      if ((s.new || []).length)   console.log(`       本轮新建：${s.new.join(' ')}`);
      if ((s.ops || []).length)   console.log(`       用到操作：${s.ops.join(' ')}`);
    }
    if ((plan.findings || []).length) {
      console.log(`\n  行为变更 / 产品决策（${plan.findings.length} 条）—— 不是测试项，要 owner 定：`);
      for (const f of plan.findings) console.log(`  ${f.id}  ${f.what}\n       ${f.detail}\n       要你定：${f.decide}${f.decided_by ? `\n       已定：${f.decided_by} —— ${f.decision}` : ''}`);
    }
    if (plan.history.length) { console.log(`\n  修订历史：`); for (const h of plan.history) console.log(`   v${h.revision} ${h.at.slice(0, 10)} ${h.by || ''} ${h.change}`); }
    const drift = driftedCases(CASES, plan);
    if (drift.length) console.log(`\n  ↻ ${drift.length} 条用例在批准后被改过内容：${drift.join(', ')} —— acceptkit plan recheck ${demand} --why ".."`);
    if (warns.length) { console.log(`\n  ⚠️  ${warns.length} 处提示：`); for (const w of warns) console.log(`   · ${w}`); }
    if ((plan.surfaces || []).some(s => (s.new || []).length)) { console.log(`\n  评审时逐条问新建用例（机器判断不了）：`); for (const q of QUESTIONS) console.log(`   ? ${q}`); }
    { const ag = planAssessGate(plan, 'tool');
      console.log(`\n  事前评价（已落库；批准时按它卡）：`);
      for (const a of ag.res) console.log(`   ${GATE_MARK[a.gate]} ${a.case}　${a.total} 分　` + Object.entries(a.per).map(([d, v]) => `${AS.DIM_LABEL[d]}${v}`).join(' '));
      if (ag.refuse) errs.push(ag.refuse); }
    if (errs.length) { console.error(`\n  ❌ ${errs.length} 处硬错，评审单不合格：`); for (const e of errs) console.error(`   · ${e}`); process.exit(1); }
    else console.log(`\n  ✅ 评审单自检通过${plan.approved_at ? '' : ` —— 下一步请批准人本人确认：acceptkit plan approve ${demand} --by <谁批的> --quote "<批准人的原话>"`}`);
    return;
  }
  if (sub === 'approve') {
    const by = opt.by ? String(opt.by) : die('缺 --by <谁批的> —— 评审是有人拍板的，不能是「系统自己批的」');
    if (SELF_DECIDER.test(by)) die(`--by ${by} 是执行者自己。评审单只能由用户本人批：把 acceptkit plan review ${demand} 交给他，他同意后记他的名字和原话`);
    const { errs } = checkPlan(plan, opsIndexForPlan(), knownCaseNames());
    errs.push(...planPlatformErrors(plan), ...planQuality(plan).errs);
    // 留着 not_covered 的旧单子在 checkPlan 里就是硬错，上面已拒；这里不再指向已废弃的 set-pending
    if (errs.length) die(`评审单还有 ${errs.length} 处硬错，不能批（acceptkit plan check ${demand} 看详情）`);
    // 事前评价卡口（从库里取，现评现存）：有未处置的拦截项不批
    const ag = planAssessGate(plan, 'tool');
    if (ag.refuse) die(`评审单不能批 —— ${ag.refuse}`);
    // 批准必须带批准人的原话：Agent 不能替人批准，原话是「确实有人批了」的唯一凭据。
    const quote = opt.quote ? String([].concat(opt.quote).join(' ')) : die('缺 --quote "<批准人的原话>" —— 评审单只能由人批准，原话会记进审批记录');
    // 审批记录写清这次批的是哪些变化（相对上次批准加了 / 摘了哪些用例）：一张单子批过好几版，
    // 每版只批它的增量，事后要能回答「这条用例是哪一次、谁、凭哪句原话批进来的」
    const { added, removed } = planDelta(plan), first = !approvedCases(plan).size;
    plan.approved_by = by; plan.approved_at = new Date().toISOString(); plan.approved_quote = quote;
    delete plan.returned;   // 批了就不再是「退回待改」
    plan.fingerprints = caseFingerprints(CASES, plan);   // 钉住用例内容，之后改了要显形；键 = 批过的用例
    savePlan(ROOT, plan);
    recordApproval(ROOT, { kind: 'plan', subject: demand, by, quote, detail: { revision: plan.revision, added, removed, assessments: Object.fromEntries(ag.res.map(a => [a.case, { id: a.id, score: a.total, gate: a.gate }])) } });
    console.log(`✅ ${demand} 评审单 v${plan.revision} 已批准（${by}）—— 现在可以 acceptkit run 了`);
    console.log(first ? `   放行的用例：${[...planCases(plan)].join(' ')}`
      : `   这次放行：${added.join(' ') || '（没有新加用例）'}${removed.length ? `；摘掉：${removed.join(' ')}` : ''}`);
    return;
  }
  if (sub === 'recheck') {
    // 执行期发现用例要改（「是不是要更新用例」）—— 改完走这条重新钉指纹。
    // 🔴 **不清空批准**。用例是有唯一 id 的资产，需求 ref 的是 id，
    //    一个需求的用例只评审一次；改测试取值属于资产内容修订，不是需求范围变更。
    //    这里只做三件事：升 revision、把「谁在什么时候为什么改的」记进 history、重钉指纹。
    const drift = driftedCases(CASES, plan);
    if (!drift.length) { console.log(`✅ ${demand}: 用例内容与批准时一致，没有漂移`); return; }
    if (!opt.why) die(`${drift.length} 条用例在批准后被改过：${drift.join(', ')}\n   重新钉指纹必须带 --why "<为什么改>"`);
    plan.revision += 1;
    plan.history.push({ revision: plan.revision, at: new Date().toISOString(), by: opt.by ? String(opt.by) : null,
                        change: `用例内容更新：${drift.join(', ')} —— ${opt.why}` });
    // 只重钉批过的那些：指纹的键就是「批过哪些」，在这里扩进新加的用例等于替 Owner 批了它们
    plan.fingerprints = caseFingerprints(CASES, plan, Object.keys(plan.fingerprints));
    savePlan(ROOT, plan);
    console.log(`↻ ${demand} 升到 v${plan.revision}（${drift.length} 条用例内容更新，已重钉指纹）`);
    console.log(`   批准状态**保持不变**（${plan.approved_at ? '已批准' : '未批准'}）—— 评审的单位是需求 ref 的用例 id 集合，不是用例的逐字内容。`);
    console.log(`   改动已记进 history，看板上可见；要加/减用例 id 才走 plan add-case（那才是需求范围变更）。`);
    return;
  }
  die(`未知子命令 ${sub}（new|show|review|check|approve|return|add-case|finding|decide|bounce|settle|recheck）`);
}

// ════════════ 流水线：执行期阻塞当场上报 ════════════
function cmdBlockers({ pos }) {
  const demand = pos[0] || die('用法：acceptkit blockers <demand> [--raise | --ack <id> --answer ".." | --resolve <id> --by-me ".." | --backfill <run> | --set <id> --unlock ".."]');
  const { opt } = parseArgs(process.argv.slice(3));
  let all = readBlockers(ROOT, demand);

  if (opt.backfill) {
    // 闸上线之前记的 blocked 没有台账条目 —— 一次性倒灌进来，之后照常走 --raise
    const run = String(opt.backfill);
    const res = loadResult(run); const c = loadCase(res.case_ref || res.case);
    let n = 0;
    for (const [id, r] of Object.entries(res.results || {})) {
      if (r.status !== 'blocked') continue;
      const got = raiseBlocker(ROOT, { demand, run, caseName: res.case, expect: id,
        kind: r.blocked_kind || 'capability', text: r.actual || '', unlock: '' });
      if (got && got.run === run && got.expect === id) n++;
    }
    console.log(`📮 ${run} 倒灌 ${n} 条阻塞进 ${demand} 的台账 —— 逐条补解锁条件后再 --raise`);
    console.log(`   补解锁条件：acceptkit blockers ${demand} --set <Bn> --unlock "<owner 要做什么才解得开>"`);
    return;
  }
  if (opt.set) {
    // 一个问题常卡住好几条断言：--set B1,B2,… 一次写一组（问题、选项一样）
    const ids = String(opt.set).split(',').map(s => s.trim()).filter(Boolean);
    const group = ids.map(id => all.find(x => x.id === id) || die(`没有 ${id}`));
    // 要 owner 拍板的问题（finding-quality.mjs blockerAskProblems）：问句、为什么要问你、选项 + 后果、推荐
    if (opt.ask || opt['why-you'] || opt.option || opt.recommend) for (const x of group) {
      const a = (x.ask ||= {});
      if (opt.ask) a.question = String(opt.ask);
      if (opt['why-you']) a.why = String(opt['why-you']);
      if (opt.option) a.options = [].concat(opt.option).map(parseOption);
      if (opt.recommend) a.recommend = String(opt.recommend);
    }
    if (group.length > 1) {
      for (const x of group.slice(1)) { if (opt.unlock) x.unlock = String(opt.unlock); if (opt.kind) x.kind = String(opt.kind); }
    }
    const b = group[0];
    if (opt.unlock) b.unlock = String(opt.unlock);
    if (opt['review-note']) b.review_note = String(opt['review-note']);
    // 执行期常会发现归类错了（例：记 capability，查下来其实是「这条策略本轮没下发」= dependency）。
    // 没有改口的入口，--raise 就会把「等别人下发」归进「我自己的待办」，读的人被误导。
    if (opt.kind) {
      const k = String(opt.kind);
      if (k !== 'capability' && k !== 'dependency') die('--kind 只能是 capability | dependency');
      b.kind = k;
    }
    if (opt.text) b.text = String(opt.text);
    writeBlockers(ROOT, demand, all);
    const bad = b.ask ? blockerAskProblems(b) : [];
    console.log(`✅ ${ids.join(', ')} 解锁条件：${b.unlock}${b.ask ? (bad.length ? `\n   ⚠️ 问题还不能交给 owner：\n${bad.map(x => '   · ' + x).join('\n')}` : `\n   问题：${b.ask.question}`) : ''}`);
    return;
  }
  // 🔴 「能力缺口不是范围决策」规则的收口：capability 阻塞是**我自己**去解的，解完必须有地方记「已解决」。
  //    以前只有 --ack（等 owner 答复）一条出路，于是我自己修好的缺口永远挂在「已提待答」，
  //    报告里看起来像还在等人 —— 正是这条规则要消灭的假象。
  if (opt.resolve) {
    const b = all.find(x => x.id === String(opt.resolve)) || die(`没有 ${opt.resolve}`);
    const how = String(opt['by-me'] || die('缺 --by-me "<我做了什么、证据在哪>"'));
    b.resolved = true; b.resolved_by = 'self'; b.resolved_how = how;
    b.resolved_at = new Date().toISOString();
    writeBlockers(ROOT, demand, all);
    console.log(`✅ ${b.id} 已自解（不再计入待答）：${how}`);
    return;
  }
  if (opt.ack) {
    // 一个问题常卡住一组阻塞（同一条用例十几条断言）：--ack B1,B2,… 一次答一组，owner 不用逐条答同一句话
    const ids = String(opt.ack).split(',').map(s => s.trim()).filter(Boolean);
    const group = ids.map(id => all.find(x => x.id === id) || die(`没有 ${id}`));
    const answer = String(opt.answer || die('缺 --answer "<owner 怎么说的>"'));
    // 谁答的：和批准、拍板同一套规矩 —— 必须写、不能是执行者自己，记进审批表（看板上答的由服务填这台电脑主人的身份）。
    // 不写 --by 也能记答复的话，一条没有审批记录的「owner 答复」就能解开阻塞，等于执行者替人答了。
    if (!opt.by || opt.by === true || !String(opt.by).trim()) die(`缺 --by "<答复的人>"：阻塞要用户本人答，记他的名字和原话`);
    const by = String(opt.by).trim();
    if (SELF_DECIDER.test(by)) die(`--by ${by} 是执行者自己。阻塞要用户本人答：把问题原样交给他，记他的名字和原话`);
    const at = new Date().toISOString();
    for (const b of group) { b.answer = answer; b.answered_at = at; b.answered_by = by; if (opt.source) b.answer_source = String(opt.source); }
    writeBlockers(ROOT, demand, all);
    // 回读：写进去了才算数（台账曾被并发写静默盖掉答复）
    const back = readBlockers(ROOT, demand);
    const lost = ids.filter(id => (back.find(x => x.id === id) || {}).answer !== answer);
    if (lost.length) die(`写回后读不到答复：${lost.join(', ')} —— 台账被别的进程同时改写，重试一次`);
    recordApproval(ROOT, { kind: 'blocker_answer', subject: demand, by, quote: answer, detail: { blockers: ids, ...(opt.source ? { source: String(opt.source) } : {}) } });
    console.log(`✅ ${ids.join(', ')} 已记下 owner 的答复（回读确认）：${answer}`);
    return;
  }
  if (opt.raise) {
    const todo = all.filter(x => !x.reported && !x.resolved);
    if (!todo.length) { console.log(`✅ ${demand} 没有待提的阻塞`); return; }
    // 「不知道怎么操作」这类阻塞是要复盘的，因为它应该在用例评审里就提出来。
    // capability = 我的能力缺口，几乎都该在用例评审时就暴露；所以提之前必须先答这一句。
    // dependency = 外部依赖挡住，执行期才知道是正常的，不强制。
    const noReview = todo.filter(x => x.kind === 'capability' && !x.review_note);
    if (noReview.length) die(`${noReview.length} 条 capability 阻塞没写「评审时为什么没发现」：${noReview.map(x => x.id).join(', ')}\n`
      + `   这是要做的复盘：能力缺口本该在用例评审时暴露，执行期才撞上就是评审漏了。\n`
      + `   acceptkit blockers ${demand} --set <Bn> --review-note "<评审时漏了：… / 评审后才出现：…>"`);
        const noUnlock = todo.filter(x => !x.unlock);
    if (noUnlock.length) die(`${noUnlock.length} 条还没写解锁条件，提了 owner 也不知道要做什么：${noUnlock.map(x => x.id).join(', ')}\n`
      + `   acceptkit blockers ${demand} --set <Bn> --unlock "<解锁这条要做什么；capability 写「我」要做什么>"`);
    // 🔴 capability 是我的能力缺口，不是 owner 的决定。两类**分开列**，
    //    否则一句「每条都需要你定」会把我自己的待办伪装成等人拍板。
    // 🔴 第三格：能力缺口**通常**是我自己的活，但有一类不是 ——
    //    缺口要靠**往产品里加东西**才能补（例：本轮把定向触发注入面删了，要补得改产品代码），
    //    那超出「我的工作量」，补不补是产品决定。判据不看我怎么说，看 unlock 里**有没有引用一条 finding**：
    //    finding 是产品行为/范围的决策载体，引用了它就说明这条卡在一个别人要定的决定上。
    //    ⚠️ 这一格仍然**不许**用来放「我懒得做」——它必须同时是 capability（缺口在我这）
    //    且 unlock 指向一条已经立案的 finding。
    const refFinding = x => x.kind === 'capability' && /finding\s*\*{0,2}F\d+/i.test(x.unlock || '');
    // 要 owner 答的（外部依赖 / 卡在 finding 上的能力缺口）先写成他能拍板的问题；解锁条件是给执行者的，不是问题
    const unasked = todo.filter(x => (x.kind !== 'capability' || refFinding(x)) && blockerAskProblems(x).length);
    if (unasked.length) die(`${unasked.length} 条要 owner 答的阻塞还没写成他能拍板的问题：${unasked.map(x => x.id).join(', ')}\n`
      + `   第一条的问题：\n${blockerAskProblems(unasked[0]).map(x => '   · ' + x).join('\n')}\n`
      + `   acceptkit blockers ${demand} --set <B1,B2,…> --ask "<问句？>" --why-you "<你为什么解决不了>" --option "做法 => 后果" --option "…" --recommend "<选哪个、为什么>"`);
    const dep = todo.filter(x => x.kind !== 'capability');
    const capOwner = todo.filter(refFinding);
    const cap = todo.filter(x => x.kind === 'capability' && !refFinding(x));
    const byUnlock = list => {
      const m = {};
      for (const b of list) (m[b.ask?.question || b.unlock] ||= []).push(b);
      return Object.entries(m);
    };
    // 给 owner 的是问题 + 选项 + 推荐（blockerAskProblems 已查过）；自己的能力缺口只告知，照旧写解锁条件
    const askText = (head, list) => { const a = list[0].ask; if (!a?.question) return `· ${head}`;
      return [`· ${a.question}`, a.why && `  为什么问你：${a.why}`, ...(a.options || []).map((o, i) => `  ${i + 1}. ${o.label} => ${o.effect}`), a.recommend && `  我推荐：${a.recommend}`].filter(Boolean).join('\n'); };
    console.log(`—— 把下面这段发给 owner（发完这些条目就标记为已提）——\n`);
    console.log(`${demand} 执行中卡住 ${todo.length} 条。`);
    if (dep.length) {
      console.log(`\n【要你定 / 等外部条件】${dep.length} 条 —— 这些我自己走不通：\n`);
      for (const [unlock, list] of byUnlock(dep))
        console.log(`${askText(unlock, list)}\n  影响 ${list.length} 条：${list.map(b => `${b.id}/${b.expect}`).join(' ')}`);
    }
    if (capOwner.length) {
      console.log(`\n【能力缺口，但补它要你先定一条 finding】${capOwner.length} 条 —— `
        + `缺口在我这，可是补它得往产品里加东西，超出我的范围，所以卡在那条 finding 上：\n`);
      for (const [unlock, list] of byUnlock(capOwner))
        console.log(`${askText(unlock, list)}\n  影响 ${list.length} 条：${list.map(b => `${b.id}/${b.expect}`).join(' ')}`);
    }
    if (cap.length) {
      console.log(`\n【我自己的待办，不需要你定】${cap.length} 条 —— 纯工作量/能力缺口，贴出来只是让你知道进度：\n`);
      for (const [unlock, list] of byUnlock(cap))
        console.log(`· ${unlock}\n  影响 ${list.length} 条：${list.map(b => `${b.id}/${b.expect}`).join(' ')}`);
    }
    const now = new Date().toISOString();
    for (const b of todo) { b.reported = true; b.raised_at = now; }
    writeBlockers(ROOT, demand, all);
    console.log(`\n（已标记 ${todo.length} 条为「已提」· ${now.slice(0, 16).replace('T', ' ')}）`);
    console.log(`owner 回了之后：acceptkit blockers ${demand} --ack <Bn> --answer "<他怎么说的>"`);
    return;
  }
  if (!all.length) { console.log(`${demand} 没有阻塞台账`); return; }
  console.log(`📮 ${demand} 阻塞台账（${all.length} 条）\n`);
  const grp = { 待提: all.filter(x => !x.reported && !x.resolved),
                已提待答: all.filter(x => x.reported && !x.answer && !x.resolved),
                已答复: all.filter(x => x.answer && !x.resolved),
                我自己解掉了: all.filter(x => x.resolved && x.resolved_by !== 'tool'),
                工具关闭: all.filter(x => x.resolved && x.resolved_by === 'tool') };
  for (const [k, list] of Object.entries(grp)) {
    if (!list.length) continue;
    console.log(`  ── ${k}（${list.length}）──`);
    for (const b of list) console.log(`  ${b.id}  ${b.expect.padEnd(8)} ${b.kind.padEnd(11)} ${b.resolved ? b.resolved_how : (b.unlock || '⚠️ 没写解锁条件')}`
      + `${b.kind === 'capability' ? `\n        复盘：${b.review_note || '⚠️ 没写「评审时为什么没发现」'}` : ''}`
      + `${b.answer ? `\n        答复：${b.answer}` : ''}`);
  }
  const caps = all.filter(x => x.kind === 'capability');
  const missed = caps.filter(x => /^评审时漏了/.test(x.review_note || ''));
  if (caps.length) console.log(`\n📊 评审复盘：${caps.length} 条能力缺口中，${missed.length} 条本该在用例评审时就发现（漏网率 ${Math.round(missed.length / caps.length * 100)}%）`);
  if (grp.待提.length) console.log(`\n⚠️  ${grp.待提.length} 条还没提给 owner —— 报告出不来：acceptkit blockers ${demand} --raise`);
}

// ════════════ 循环：下一步做什么 ════════════
// 卡片是已有状态的投影，由 core/next.mjs 从磁盘算出、不存盘。评审单自检用和 plan check 同一套（含平台、用例质量）。
function cmdNext() {
  const { pos } = parseArgs(process.argv.slice(3));
  const D = pos[0] || die('用法：acceptkit next <需求> [--json]');
  const planErrors = plan => [...checkPlan(plan, opsIndexForPlan(), knownCaseNames()).errs, ...planPlatformErrors(plan), ...planQuality(plan).errs];
  let cards;
  try { cards = nextCards(ROOT, String(D), { planErrors }); } catch (e) { die(e.message); }
  if (JSON_MODE) return { demand: String(D), cards };
  console.log(formatCards(String(D), cards));
}

// ════════════ context：执行到某个节点时，这一步需要的经验 ════════════
// 操作做法、shows、danger、相关知识、遮蔽层（含项目扩展追加的）、以往运行的情况、截图做法，由 core/context.mjs 算出。
function contextOf(run, nodeId, opts = {}) {
  if (!existsSync(resultPath(run))) die(`没有运行 ${run}`);
  const r = loadResult(run); const c = loadCase(r.case_ref || r.case);
  let node = null;
  walk(c.tree, (n, path, id) => { if (id === nodeId) node = n; });
  if (!node) die(`用例 ${r.case} 里没有节点 ${nodeId}（acceptkit steps ${r.case} 看编号）`);
  const playbook = RUNTIME_PLATFORMS.includes(r.platform) ? shotPlaybook(shotCtx(run, r)) : [];
  return buildContext(ROOT, { run, r, c, nodeId, node, cfg: CFG, obscuring: OBSCURING, playbook }, opts);
}
function cmdContext({ pos, opt }) {
  const run = pos[0], nodeId = opt.node;
  if (!run || !nodeId || nodeId === true) die('用法：acceptkit context <运行> --node <nN> [--json]（节点编号见 step_todo 卡片，或 acceptkit steps <用例>）');
  const card = contextOf(String(run), String(nodeId));
  if (JSON_MODE) return card;
  console.log(formatContext(card));
}

// ════════════ consult：拿不出证据时，按通识标准问清业务知识 ════════════
// 证据不全 / 验不了的断言，工具给出：判据面类别 → 常见取证入口 + 每个入口要问清的业务问题、通识问题、
// 项目里已有的相关知识，以及一条能直接交给 owner 的问题草稿（blockers --set --ask 的现成命令）。只读，不改记录。
function consultOf(run, eid) {
  if (!existsSync(resultPath(run))) die(`没有运行 ${run}`);
  const r = loadResult(run); const c = loadCase(r.case_ref || r.case);
  const e = allExpects(c).find(x => x.id === eid) || die(`用例 ${r.case} 里没有断言 ${eid}`);
  const v = r.results?.[eid] || {};
  const D = r.demand?.id || r.demand || null;
  const gaps = assertionGaps(runDir(run), r, { expects: allExpects(c), ops: loadOps() })[eid] || [];
  const b = D ? readBlockers(ROOT, D).filter(x => x.run === run && x.expect === eid && !x.resolved).pop() : null;
  const situation = v.status === 'blocked' ? 'blocked' : gaps.length ? 'gap' : (v.status || 'todo');
  const k = consultFor({ assert: e.assert, via: e.via, why_not_ui: e.why_not_ui, op: e.observe?.op || e.op, situation, gaps, unlock: b?.unlock || v.unlock, text: b?.text || v.actual });
  const cut = s => clipText(s, 300);
  // 相关知识只收「真的在说这条」的：点名了这个用例 / 配方，或记在「取证」下且和断言有两个以上共同词。
  // 按通用词打分会把整份复盘笔记捞进来（实测捞回来的几条全是不相干的工具复盘）
  const words = [...new Set(String(e.assert || '').toLowerCase().match(/[a-z_][a-z0-9_]{3,}|[\u4e00-\u9fa5]{2,6}/g) || [])];
  const knowledge = allKnowledge(ROOT).map(x => {
    const body = `${x.heading}\n${x.text}`.toLowerCase();
    const named = body.includes(String(r.case).toLowerCase()) || (e.observe?.op && body.includes(String(e.observe.op).toLowerCase()));
    const shared = words.filter(w => body.includes(w)).length;
    return { x, keep: named || (/取证/.test(x.heading || '') && shared >= 2), score: (named ? 10 : 0) + shared };
  }).filter(y => y.keep).sort((a, b) => b.score - a.score).slice(0, 6)
    .map(({ x }) => ({ ref: `${basename(x.file)}:${x.line}`, ...(x.heading ? { heading: x.heading } : {}), text: cut(x.text) }));
  const qa = `--set ${b?.id || '<B>'} --ask ${JSON.stringify(k.owner_ask.question)} --why-you ${JSON.stringify(k.owner_ask.why)} `
    + k.owner_ask.options.map(o => `--option ${JSON.stringify(o)}`).join(' ') + ' --recommend "<你倾向哪个、为什么>"';
  return { kind: 'consult', run, case: r.case, expect: eid, demand: D, status: v.status || 'todo', situation, gaps,
    assert: e.assert, via: e.via || 'ui', ...(e.why_not_ui ? { why_not_ui: e.why_not_ui } : {}), ...(b ? { blocker: b.id, unlock: cut(b.unlock || '') } : {}),
    faces: k.faces, surfaces: k.surfaces, questions: k.questions, knowledge, owner_ask: k.owner_ask,
    next: [
      '先自己答：照 surfaces 逐个查，能查到的入口登记成操作库配方（ops set <id> --platform P --how … --source …），再 observe',
      `查到的业务事实写进知识，下次 consult 会带出：${`acceptkit know add "<事实>" --heading 取证 --source "<哪查到的>"`}`,
      `自己答不了的才问 owner（写成他能拍板的问题）：acceptkit blockers ${D || '<D>'} ${qa}`,
    ] };
}
function cmdConsult({ pos, opt }) {
  const run = pos[0], eid = opt.expect;
  if (!run || !eid || eid === true) die('用法：acceptkit consult <运行> --expect <E> [--json]');
  const k = consultOf(String(run), String(eid));
  if (JSON_MODE) return k;
  const L = [`取证咨询 · ${k.case}/${k.expect}（${k.status}${k.gaps.length ? '，缺口：' + k.gaps.map(g => GAP_TEXT[g] || g).join('、') : ''}）`, `断言：${k.assert}`];
  if (k.unlock) L.push(`卡在：${k.unlock}`);
  L.push('', `判据面：${k.faces.map(f => f.label).join(' / ')}`, '', '常见取证入口（逐个问清）：');
  for (const s of k.surfaces) L.push(`  · ${s.where}：${s.ask}`);
  L.push('', '通识问题：'); k.questions.forEach((q, i) => L.push(`  ${i + 1}. ${q}`));
  L.push('', `项目里的相关知识（${k.knowledge.length}）：`); if (!k.knowledge.length) L.push('  没有检索到');
  for (const x of k.knowledge) L.push(`  ${x.ref} ${x.text}`);
  L.push('', '下一步：'); k.next.forEach(n => L.push(`  - ${n}`));
  console.log(mask(ROOT, L.join('\n')));
}

// ════════════ read：卡片 read 指针指向的长内容，分页取 ════════════
// 卡片只给预览；要全文时按资源名分页读，执行者不必一次读完整个运行目录（docs/002-protocol.md 第一节）。
const READ_USAGE = '资源名：plan/D、finding/D/F3、blocker/D/B2、case/C、case/C#n1.2、run/R、run/R/E1、run/R/step/n1、run/R/file/<相对路径>、context/R/n1';
function cmdRead({ pos }) {
  const { opt } = parseArgs(process.argv.slice(3));
  const res = String(pos[0] || die(`用法：acceptkit read <资源> [--offset N] [--limit M] [--json]\n   ${READ_USAGE}`));
  const page = readResource(res, opt);
  if (JSON_MODE) return page;
  if (page.type === 'text') console.log(page.text);
  else for (const it of page.items) console.log(JSON.stringify(it));
  const end = page.offset + (page.type === 'text' ? page.text.length : page.items.length);
  console.error(`（第 ${page.offset}–${end} ${page.type === 'text' ? '字' : '项'}，共 ${page.total}`
    + `${page.next_offset !== null ? `；下一页：acceptkit read ${res} --offset ${page.next_offset}` : '；到头了'}）`);
}
const clipText = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };
const asText = v => mask(ROOT, JSON.stringify(v, null, 2));   // #secret 的值不经 read 流出
function readResource(res, opt) {
  const [kind, ...rest] = res.split('/');
  const text = t => pageText(res, t, opt);
  if (kind === 'plan' && rest.length === 1) return text(asText(loadPlan(ROOT, rest[0]) || die(`没有需求 ${rest[0]} 的评审单：acceptkit plan new ${rest[0]} …`)));
  if (kind === 'finding' && rest.length === 2)
    return text(asText((loadPlan(ROOT, rest[0])?.findings || []).find(f => f.id === rest[1]) || die(`需求 ${rest[0]} 里没有 finding ${rest[1]}`)));
  if (kind === 'blocker' && rest.length === 2)
    return text(asText(readBlockers(ROOT, rest[0]).find(b => b.id === rest[1]) || die(`需求 ${rest[0]} 的阻塞台账里没有 ${rest[1]}`)));
  // context 卡片把长内容截到 300 字；这里给不截断的全文（已遮蔽）
  if (kind === 'context' && rest.length === 2) return text(asText(contextOf(rest[0], rest[1], { full: true })));
  if (kind === 'case' && rest.length === 1) {
    const [name, nodeId] = rest[0].split('#');
    if (!existsSync(casePath(name))) die(`没有用例 ${name}`);
    const c = loadCase(name); delete c._path;
    if (!nodeId) return text(asText(c));
    let hit = null;
    walk(c.tree, (n, path, id) => { if (id === nodeId) hit = { nodeId: id, path, ...n }; });
    return text(asText(hit || die(`用例 ${name} 里没有节点 ${nodeId}（acceptkit steps ${name} 看编号）`)));
  }
  if (kind === 'run' && rest.length) {
    const run = rest[0];
    if (!existsSync(resultPath(run))) die(`没有运行 ${run}`);
    const r = loadResult(run); const c = loadCase(r.case_ref || r.case);
    if (rest.length === 1) {
      const items = [
        ...allExpects(c).map(e => { const x = r.results?.[e.id] || {};
          return { expect: e.id, status: x.status || 'todo', assert: clipText(e.assert, 120), ...(x.actual ? { actual: clipText(x.actual, 200) } : {}), evidence: x.evidence || [] }; }),
        ...allNodes(c).map(n => ({ node: n.nodeId, op: clipText(n.op, 120), evidence: r.steps?.[n.nodeId]?.evidence || [] })),
      ];
      return pageList(res, maskDeep(ROOT, items), opt,
        { meta: { case: r.case, demand: r.demand?.id || r.demand || null, platform: r.platform || null, device: r.device?.key || r.device?.udid || null } });
    }
    if (rest[1] === 'step' && rest.length === 3) {
      const node = allNodes(c).find(n => n.nodeId === rest[2]) || die(`用例 ${r.case} 里没有节点 ${rest[2]}`);
      return text(asText({ node, step: r.steps?.[rest[2]] || null, reviews: reviewsOf(run, r, `step:${rest[2]}`) }));
    }
    if (rest[1] === 'file' && rest.length >= 3) {
      // 只读本运行目录里的文件：路径逃出运行目录一律拒收
      const base = resolve(runDir(run)), rel = rest.slice(2).join('/'), abs = resolve(base, rel);
      if (abs !== base && !abs.startsWith(base + sep)) die(`${rel} 不在运行 ${run} 的目录里`);
      if (!existsSync(abs)) die(`运行 ${run} 里没有 ${rel}`);
      if (statSync(abs).isDirectory())
        return pageList(res, readdirSync(abs, { withFileTypes: true }).map(d => ({ name: d.name, type: d.isDirectory() ? 'dir' : 'file',
          ...(d.isDirectory() ? {} : { bytes: statSync(join(abs, d.name)).size }) })).sort((a, b) => a.name.localeCompare(b.name)), opt);
      if (isShot(rel)) die(`${rel} 是图片：read 只读文本，直接打开 ${abs} 看`);
      return text(mask(ROOT, readFileSync(abs, 'utf8')));
    }
    if (rest.length === 2) {
      const e = allExpects(c).find(x => x.id === rest[1]) || die(`用例 ${r.case} 里没有断言 ${rest[1]}`);
      return text(asText({ expect: e, result: r.results?.[rest[1]] || null, reviews: reviewsOf(run, r, rest[1]) }));
    }
  }
  die(`不认识的资源 ${res}。${READ_USAGE}`);
}

// adb 路径：ANDROID_HOME / ANDROID_SDK_ROOT → 默认 SDK 位置 → PATH。不设环境变量时也要找得到（否则查进程永远为空，被误判成 app 没在跑）。
function adbPath() {
  const homes = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, join(process.env.HOME || '', 'Library', 'Android', 'sdk'), join(process.env.HOME || '', 'Android', 'Sdk')].filter(Boolean);
  for (const h of homes) { const p = join(h, 'platform-tools', 'adb'); if (existsSync(p)) return p; }
  return 'adb';
}

// 模拟器上被测 App 的 pid：项目钩子优先；否则按 bundle 在 launchctl 列表里找（UIKitApplication:<bundle>）。
function androidPid(adb, pkg) {
  if (!pkg) return '';
  try { return execSync(`${adb} shell pidof ${pkg} 2>/dev/null`, { encoding: 'utf8' }).trim().split(/\s+/)[0] || ''; } catch { return ''; }
}
function appPid(udid, bundle) {
  if (PACK.appPid) return PACK.appPid(udid, bundle, HELPERS) || '';
  if (!udid || !bundle) return '';
  try {
    const out = execSync(`xcrun simctl spawn ${udid} launchctl list 2>/dev/null`, { encoding: 'utf8' });
    const line = out.split('\n').find(l => l.includes(bundle) && !/^-\s/.test(l));
    return line ? line.trim().split(/\s+/)[0] : '';
  } catch { return ''; }
}

// 交给项目扩展钩子用的工具集（扩展只能经由这里碰内核，不 import 内核内部）
const HELPERS = { ROOT, CASES, RUNS, CFG, REPO_ROOT, die, parseArgs, asList, spawnSync, execSync, existsSync, readFileSync, writeFileSync,
  readdirSync, mkdirSync, statSync, join, loadResult, saveResult, loadCase, allExpects, allNodes, runDir, resultPath,
  portOwnerSim, resolvePort: (recipe, udid) => resolvePort(recipe, udid), cmdRecord, opRecipe, loadOps,
  // 驱动 App 的命令来自项目知识里的 #driver 设置（见 settings.mjs），扩展包不写死工具名
  // host 不给时按该平台唯一的宿主；有多个宿主的项目由扩展传进来（它知道这一步对着哪个 App）
  drive: (action, vars, platform = 'ios', host = null) => {
    const h = resolveHost(CFG, { host, platform });
    return runAction(ROOT, 'driver', platform, action, vars, { timeout: 60_000, host: h.error ? null : h.id });
  },
  hostFor, hostApp: (id, platform) => hostApp(CFG, id, platform) };

/**
 * acceptkit platform <case> --add android [--remove ios] --why "<为什么这个场景在该平台也成立>"
 *
 * 给存量用例补平台标签 —— 用例是跨端共享的资产，换个端不应该复制一份。
 *
 * 两条规矩（都是闸，不靠自觉）：
 *  1. **必须给 --why**：打标签是在声明「这个场景在该平台也是同一件事」，这是一个判断，得留下来。
 *     理由进用例的 `platform_notes`，看板与评审单都读得到。
 *  2. **打完立刻回算适用性并打印**：标签只是「该管」，跡不跑得起来看操作配方。
 *     缺配方就当场列出来 —— 这正是要暴露的能力缺口，不是错误。
 */
function cmdPlatform({ pos, opt }) {
  const name = pos[0] || die('用法：acceptkit platform <case> --add ios|android|web [--remove …] --why "…"');
  const c = loadCase(name);
  const cur = new Set(normalizePlatforms(c));
  const add = String(opt.add || '').split(',').map(x => x.trim()).filter(Boolean);
  const rm = String(opt.remove || '').split(',').map(x => x.trim()).filter(Boolean);
  if (!add.length && !rm.length) die('要给 --add 或 --remove');
  for (const x of [...add, ...rm]) if (!RUNTIME_PLATFORMS.includes(x)) die(`平台只能是 ${RUNTIME_PLATFORMS.join('|')}，收到 ${x}`);
  if (!opt.why) die('必须给 --why：为什么这个场景在该平台也成立（打标签是一个判断，得留下来）');
  const before = [...cur];
  add.forEach(x => cur.add(x)); rm.forEach(x => cur.delete(x));
  if (!cur.size) die('不能把平台清空 —— platform 是必填项');
  c.platform = platformValue([...cur]);
  c.platform_notes = c.platform_notes || [];
  c.platform_notes.push({ at: new Date().toISOString().slice(0, 10), add, remove: rm, why: String(opt.why) });
  const out = { ...c }; delete out._path;
  writeFileSync(c._path || casePath(name), JSON.stringify(out, null, 2) + '\n');
  const ap = applicability(c, loadOps(), CFG);
  console.log(`✅ ${name} platform: ${JSON.stringify(before.length === 1 ? before[0] : before)} → ${JSON.stringify(c.platform)}`);
  console.log(`   理由：${opt.why}`);
  console.log(`   适用性（算出来的）：${fmtApplicability(ap)}`);
  for (const pf of RUNTIME_PLATFORMS) if (ap[pf].declared && ap[pf].missing.length)
    console.log(`   ⚠️ ${PLATFORM_LABEL[pf]} 缺配方：${ap[pf].missing.join(' ')}  —— 标签说「该管」，配方决定「跑不跑得起来」`);
}

// ════════════ 评价：事前 / 事后按维度打分并落库（core/assess.mjs + store/db.mjs）════════════
// 卡口只读库：plan approve 读每条用例「当前指纹」的最新事前评价；有未处置的 block 项 ⇒ 不批。
// 不豁免存量（产品规则）：Q 规则不按基线 / since 分级，全部出项；放行靠「处置」——
// 采纳后改掉（下一次评价里这一项消失）/ owner 接受现状 / owner 判建议不成立。没登记处置才拦。
const caseBasis = name => caseFingerprints(CASES, { surfaces: [{ reuse: [name] }] }, [name])[name] || 'missing';
const decidedBy = sugByKey => i => !!i.waived || AS.clearsGate(sugByKey.get(i.ikey));
function persistAssessment({ kind, subject, phase, basis, demand, items, assertOf = () => '', by = 'tool' }) {
  for (const i of items) i.ikey = AS.itemKey(`${kind}:${subject}`, i);
  const keys = new Set(items.filter(i => i.level !== 'ok').map(i => i.ikey));
  // 先取建议的现状（沿用旧决定），再打分
  const sug = new Map(listSuggestions(ROOT, { subject_id: subject }).map(x => [x.ikey, x]));
  const sc = AS.score(items, phase, decidedBy(sug));
  const saved = saveAssessment(ROOT, { subject_kind: kind, subject_id: subject, phase, rubric_version: AS.RUBRIC_VERSION, by, basis, demand,
    score: sc.total, gate: sc.gate, dims: sc.per, items });
  for (const i of saved.items) if (i.level !== 'ok') {
    const d = AS.suggestionFor(i, { assertText: assertOf(i.at) });
    upsertSuggestion(ROOT, { ikey: i.ikey, subject_kind: kind, subject_id: subject, demand, item_id: i.id, dimension: i.dimension, level: i.level, ...d });
  }
  const settled = settleMissingSuggestions(ROOT, kind, subject, keys, `${kind}:${subject}@${basis}`);
  return { id: saved.id, ...sc, items: saved.items, settled };
}
function assessCase(name, { demand = null, platform = null, by = 'tool' } = {}) {
  const c = loadCase(name);
  const ops = loadOps();
  const platforms = platform ? [platform] : normalizePlatforms(c).filter(p => RUNTIME_PLATFORMS.includes(p));
  // 带 ops 才跑得到 Q21（caseQuality 现在也带）
  const findings = checkCase(c, { packRules: PACK.qualityRules || [], extraKeys: CFG.quality?.extraKeys, cfg: CFG.quality || {}, hosts: CFG.hosts || {}, ops });
  const items = AS.assessCasePre(c, { findings, ops, platforms });
  const ex = new Map(allExpects(c).map(e => [e.id, e.assert]));
  return { case: name, ...persistAssessment({ kind: 'case', subject: name, phase: 'pre', basis: caseBasis(name), demand, items, assertOf: at => ex.get(at) || '', by }) };
}
function assessRun(run, { by = 'tool' } = {}) {
  const r = loadResult(run); const c = loadCase(r.case_ref || r.case);
  const exps = allExpects(c);
  const gaps = assertionGaps(runDir(run), r, { expects: exps, ops: loadOps() });
  const pre = latestAssessment(ROOT, 'case', c.case, 'pre');
  const appN = Array.isArray(r.apparatus) ? r.apparatus.length : Object.keys(r.apparatus || {}).length;
  const items = AS.assessRunPost({ ...r, run }, { gaps, apparatus: appN,
    expectOps: Object.fromEntries(exps.filter(e => e.observe?.op).map(e => [e.id, e.observe.op])), preItems: pre?.items || [] });
  const ex = new Map(exps.map(e => [e.id, e.assert]));
  const fp = createHash('sha256').update(readFileSync(resultPath(run))).digest('hex').slice(0, 12);
  const D = r.demand?.id || r.demand || null;
  return { run, case: c.case, pre: pre ? { id: pre.id, score: pre.score, gate: pre.gate } : null,
    ...persistAssessment({ kind: 'run', subject: run, phase: 'post', basis: fp, demand: D, items, assertOf: at => ex.get(at) || '', by }) };
}
const GATE_MARK = { pass: '✅', warn: '⚠️', block: '⛔' };
function fmtAssessment(a, title) {
  const L = [`${GATE_MARK[a.gate]} ${title}　综合 ${a.total} 分　卡口 ${a.gate}（未处置：拦 ${a.open_block}、提示 ${a.open_warn}）`];
  L.push('   ' + Object.entries(a.per).map(([d, v]) => `${AS.DIM_LABEL[d]} ${v}/5`).join('　'));
  const sug = new Map(listSuggestions(ROOT, {}).map(x => [x.ikey, x]));
  for (const i of a.items.filter(i => i.level !== 'ok')) {
    const s = sug.get(i.ikey);
    L.push(`   ${i.level === 'block' ? '✗' : '⚠'} [${AS.DIM_LABEL[i.dimension]}] ${i.target || i.at}：${i.finding}`);
    if (s) L.push(`        建议 S${s.id}（${s.status}${s.decided_by ? ` · ${s.decided_by}「${String(s.quote || '').slice(0, 40)}」` : ''}）：${s.text}`);
  }
  if (a.settled?.length) L.push(`   ↳ 这次评价里消失的旧问题：${a.settled.map(x => `S${x.id}→${x.status}`).join(' ')}`);
  return L.join('\n');
}
function cmdAssess({ pos, opt }) {
  const by = opt.by ? String(opt.by) : 'tool';
  if (opt.plan) {
    const plan = loadPlan(ROOT, String(opt.plan)) || die(`需求 ${opt.plan} 没有评审单`);
    const out = [...planCases(plan)].filter(n => tryLoadCase(n)).map(n => assessCase(n, { demand: plan.demand, platform: plan.platform, by }));
    if (JSON_MODE) return { demand: plan.demand, cases: out.map(({ items, ...x }) => x) };
    for (const a of out) console.log(fmtAssessment(a, `用例 ${a.case}（事前）`) + '\n');
    return;
  }
  if (opt.run) {
    const a = assessRun(String(opt.run), { by });
    if (JSON_MODE) return a;
    console.log(fmtAssessment(a, `运行 ${a.run}（事后）${a.pre ? `　· 事前评价 ${a.pre.score} 分 / ${a.pre.gate}` : '　· 没有事前评价'}`));
    return;
  }
  const name = pos[0] || die('用法：acceptkit assess <case> | --plan <D> | --run <run> [--json]');
  const a = assessCase(String(name), { demand: opt.demand ? String(opt.demand) : null, by });
  if (JSON_MODE) return a;
  console.log(fmtAssessment(a, `用例 ${a.case}（事前）`));
}
// 建议：list / decide（只认用户本人：adopt 采纳 | accept 接受现状 | reject 建议不成立）/ retro（事后漏网的复盘，必填）
function cmdSuggest({ pos, opt }) {
  const sub = pos[0] || 'list';
  if (sub === 'list') {
    const rows = listSuggestions(ROOT, { demand: pos[1] || (opt.demand ? String(opt.demand) : undefined), subject_id: opt.case ? String(opt.case) : opt.run ? String(opt.run) : undefined,
      status: opt.status ? String(opt.status).split(',') : undefined });
    if (JSON_MODE) return { suggestions: rows };
    for (const s of rows) console.log(`S${s.id} [${s.status}] ${s.subject_kind}:${s.subject_id} ${AS.DIM_LABEL[s.dimension] || s.dimension} ${s.level}　${s.text}`
      + (s.decided_by ? `\n      ${s.decided_by}：「${s.quote}」` : '') + (s.needs_retro && !s.retro ? '\n      ⚠️ 待写 retro（事前为什么没发现）' : ''));
    if (!rows.length) console.log('（没有建议）');
    return;
  }
  const id = String(pos[1] || '').replace(/^S/i, '') || die(`用法：acceptkit suggest ${sub} S<id> …`);
  const s = getSuggestion(ROOT, Number(id)) || die(`没有建议 S${id}`);
  if (sub === 'decide') {
    const choice = String(opt.choice || '');
    if (!AS.DECISIONS.has(choice)) die('--choice 只能是 adopt（采纳，照建议改）| accept（接受现状）| reject（建议不成立）');
    const by = opt.by ? String(opt.by) : die('缺 --by <谁定的>');
    if (SELF_DECIDER.test(by)) die(`--by ${by} 是执行者自己：建议的采纳 / 接受只能由用户本人决定，记他的名字和原话`);
    const quote = opt.quote ? String([].concat(opt.quote).join(' ')) : die('缺 --quote "<原话>"');
    if (s.needs_retro && !s.retro && !opt.retro) die(`S${s.id} 是事后才发现的问题，先写 retro：acceptkit suggest retro S${s.id} --text "<事前为什么没发现>"（或 decide 时带 --retro）`);
    const status = { adopt: 'adopted', accept: 'accepted', reject: 'rejected' }[choice];
    const x = decideSuggestion(ROOT, s.id, { status, by, quote, retro: opt.retro ? String(opt.retro) : null });
    recordApproval(ROOT, { kind: 'suggestion', subject: `${s.subject_kind}:${s.subject_id}`, by, quote, detail: { suggestion: s.id, choice, ikey: s.ikey } });
    if (JSON_MODE) return x;
    console.log(`✓ S${s.id} → ${status}（${by}）${status === 'adopted' ? ' —— 改完再 acceptkit assess，这一项消失即记为已落地' : ' —— 这一项不再拦'}`);
    return;
  }
  if (sub === 'retro') {
    const text = opt.text ? String(opt.text) : die('缺 --text "<事前为什么没发现>"');
    setSuggestionRetro(ROOT, s.id, text);
    if (JSON_MODE) return getSuggestion(ROOT, s.id);
    console.log(`✓ S${s.id} retro 已记`);
    return;
  }
  die(`未知子命令 ${sub}（list | decide | retro）`);
}
/** 评审单批准的卡口：每条用例当前指纹的事前评价（现评现存），有未处置 block ⇒ 拒绝理由 */
function planAssessGate(plan, by) {
  const res = [...planCases(plan)].filter(n => tryLoadCase(n)).map(n => assessCase(n, { demand: plan.demand, platform: plan.platform, by }));
  // 没接入质量标准的项目（从没 doctor --fix 登记过基线）与 case-quality.evaluate 同口径：只提示不拦。
  // 接入了的项目不豁免旧用例 —— 那是产品规则；这里豁免的是「项目还没接入」，不是「用例是旧的」
  const onboarded = loadQualityBaseline(ROOT).initialized;
  const bad = onboarded ? res.filter(a => a.gate === 'block') : [];
  if (!onboarded && res.some(a => a.gate === 'block')) console.error(`⚠️ 事前评价有拦截项，但项目还没接入质量标准（acceptkit doctor --fix 登记基线后才拦）`);
  const refuse = !bad.length ? null : `${bad.length} 条用例的事前评价有未处置的拦截项：\n`
    + bad.map(a => `   · ${a.case}（${a.total} 分）：` + a.items.filter(i => i.level === 'block' && !i.waived).slice(0, 4).map(i => `${i.target || i.at} ${AS.DIM_LABEL[i.dimension]}`).join('、')).join('\n')
    + `\n   看建议：acceptkit suggest list ${plan.demand}；owner 定：acceptkit suggest decide S<id> --choice adopt|accept|reject --by <他> --quote "<原话>"`;
  return { res, refuse };
}

const coreTable = { assess: cmdAssess, suggest: cmdSuggest, next: cmdNext, context: cmdContext, consult: cmdConsult, read: cmdRead, round: cmdRound, plan: cmdPlan, blockers: cmdBlockers, shot: cmdShot, device: cmdDevice, dup: dupCheck, demands: cmdDemands, cases: cmdCases, new: cmdNew, validate: cmdValidate, coverage: cmdCoverage, run: cmdRun, regress: cmdRegress, record: cmdRecord, report: cmdReport, bug: cmdBug, history: cmdHistory, steps: cmdSteps, gate: cmdGate, probe: cmdProbe, review: cmdReview, reviewq: cmdReviewQ, observe: cmdObserve, platform: cmdPlatform, apparatus: cmdApparatus };
// 领域命令（项目 pack.commands）：签名 (args, HELPERS)。不允许覆盖内核命令。
const packCommands = Object.fromEntries(Object.entries(PACK.commands || {}).filter(([k]) => !coreTable[k]).map(([k, fn]) => [k, (a) => fn(a, HELPERS)]));
const table = { ...coreTable, ...packCommands };
if (!table[cmd]) {
  console.log(`acceptkit <cmd> — 操作树用例引擎（同一用例多次运行自动挂链）
  next <demand> [--json]                  这个需求还剩什么：从记录推出卡片，按顺序做；只剩 attention 就问用户，清单为空就 link 给报告地址
  consult <run> --expect E [--json]      拿不出证据（证据不全 / 验不了）时：判据面类别、常见取证入口和要问清的业务问题、通识问题、相关知识、问 owner 的草稿
  context <run> --node nN [--json]        做这一步之前取经验：操作做法（推测的不执行）、shows、danger、相关知识、遮蔽层和关法、以往失败 / 故障 / 驳回、截图做法
  read <资源> [--offset N] [--limit M] [--json]   卡片上 read 指针指向的长内容，分页读（plan/D、finding/D/F3、run/R/E1、run/R/file/<路径>、context/R/nN…）
  （循环里用到的命令见 acceptkit protocol：参数按各自的定义查；加 --json 时 stdout 只有一份 JSON —— 被改动的那张卡片，或 {"refused":"…"} 且退出码非 0）
  plan <new|show|review|check|approve|return|add-case|finding|decide|bounce|settle|recheck> <demand>
                                          用例评审单：改动面 → 复用存量 / 新建；要产品定的写 finding（decide / bounce / settle 收口）；review 出给人读的评审稿。未批准的需求不能 run
  blockers <demand> [--raise | --ack Bn --answer .. | --resolve Bn --by-me .. | --backfill <run> | --set Bn --unlock ..]
                                          阻塞台账：record blocked 自动登记；断言后来记成 pass / fail / na 时工具自动关闭；有未上报的阻塞时 report 出不来
  demands                                 列出需求
  cases [--platform ios|android|web]      用例资产：被哪些评审单引用 / 平台适用性（算出来的）/ 运行次数
  dup                                     建新用例前查重（同一对象多处覆盖 / 近似标题 / 重复断言）
  new <case> --demand <D> --surface <S> --platform ios|android|both|web   用例骨架 + 加进评审单
  validate <case>                         用例校验
  coverage <case>                         分类树(CTM)覆盖
  run <case> [--demand <D>] [--run id] [--build 组件@版本]   建运行（自动 run_seq + prev_run 挂链）
  regress <demand> [--session id]         回归轮：评审单点名的全部用例各建一轮
  round <new|show|repos|migrate> <demand> 需求执行轮：代码变了先开新轮（new --assess "…"）评估影响面
  steps <case>                            列出操作节点编号（过程证据挂这里）
  record <run> --step <nodeId> --evidence shots/x.png      过程证据（每走一步就记）
  record <run> --expect E --status s [--actual .. --evidence .. --quote "<原文片段>" --finding Fx]
  observe <run> [--expect E] [--todo] [--from-file f] [--dry-run]   按断言的观测规格观测 → 原文落盘 → 谓词判
  review <run> [--next | --all | --item K --verdict v --note .. --by blind]   逐份证据复核；驳回即退回 todo；图片的包带上截图时工具记下的附带记录
  reviewq [--demand D|--run R] [--pack | --apply <jsonl> | --prune]          跨运行盲审队列
  apparatus <run> [--what "<装置哪里坏了>" --fix "<怎么绕过的>"]              本轮装置故障台账（取证手段自己坏了；不计结论，报告单列）
  report <run>                            出报告（run.md + run.json）
  bug <run> --expect E                    出缺陷单（路径 + 预期 + 证据）
  history <case>                          同一用例多次运行的链
  probe <slug> [标题] --demand <D>        调查 / 复现型用例 + 运行
  ops [id]                                操作库：每个操作在各平台怎么做
  device acquire --run R [--need k=v] [--json]       选设备并占上：平台、宿主、能力要求从用例推出，复用 → 启动；都不行出 attention 卡片
  device reject <身份> --run R --why "<哪里不对>"   核对后否决这台（账号不对、页面不能测）：记进 run、释放，再选下一台
  device [status | pick --platform P [--need k=v] | claim <身份> --run R --holder H | release <身份> --run R [--shutdown] | stop <身份>]
                                                    设备：看状态 · 只看候选不占 · 手动占用 · 释放（身份 = iOS UDID / Android avd:<AVD名>）
  shot <run> (--sim UDID | --web) [--step nN] [--label L]                     过程截图（先查遮蔽层；截完查纯色画面、和上一张是否一样、节点 shows 的字）
  gate --action "<描述>" [--sim ..] [--bundle ..] [--tenant ..] [--url ..] [--payload f.json | --payload '{..}'] [--run R]
                                          目标闸：会改被测端状态的动作之前必过。识别不出目标 = 拒绝(3)，白名单外 = 拒绝(2)
${Object.keys(packCommands).length ? `\n  项目领域命令（pack.commands）：${Object.keys(packCommands).join(' ')}` : ''}`);
  process.exit(cmd ? 1 : 0);
}

// 命令清单里的命令（core/protocol.mjs）：参数按各自的定义查，不认识的拒收；
// 加 --json 时 stdout 只有一份 JSON —— 被改动的那张卡片，或 {"refused":"…"}（退出码非 0）。
// 人话照样打出来，挪到 stderr；blockers --raise 那段要交给用户的话另放进 message。
const PROTO = findDef(cmd, parseArgs(rest).pos, args.opt);
JSON_MODE = !!(PROTO && args.opt.json);
const HUMAN = [];
if (JSON_MODE) console.log = (...a) => { const s = format(...a); HUMAN.push(s); process.stderr.write(s + '\n'); };
const emitJSON = v => process.stdout.write(JSON.stringify(v, null, 1) + '\n');
try {
  if (PROTO) { const bad = unknownFlags(PROTO, args.opt); if (bad) die(bad); }
  const before = PROTO?.name === 'blockers' && args.pos[0] ? readBlockers(ROOT, String(args.pos[0])) : null;
  const ret = await table[cmd](args);
  autoReport(cmd, args);
  if (JSON_MODE) emitJSON(jsonOf(PROTO, args, ret, before));
} catch (e) {
  if (!JSON_MODE) throw e;
  if (!(e instanceof Refused)) console.error(e?.stack || e);
  emitJSON({ refused: e instanceof Refused ? e.message : `内部错误：${e?.message || e}` });
  process.exitCode = 1;
}

// 报告由工具自己出：一个运行的最后一条结论 / 复核落下、只剩出报告时，当场生成。
// 出报告不需要任何判断；以前它是执行者的一张卡片、看板上的一个阶段，执行者一忘就堆着（有个需求一度堆了几十条「只差出报告」），
// owner 还以为流程上有人在等。会改结论或复核的命令（record / observe / reviewq）跑完都过一遍这里。
function autoReport(cmd, { pos, opt }) {
  if (!['record', 'observe', 'reviewq'].includes(cmd)) return;
  let runs = cmd === 'reviewq' ? [] : [String(pos[0] || '')];
  if (cmd === 'reviewq') {
    if (!opt.apply) return;
    if (opt.run) runs = [String(opt.run)];
    else try { runs = [...new Set(readFileSync(String(opt.apply), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l).run; } catch { return null; } }).filter(Boolean))]; } catch { return; }
  }
  for (const run of runs) {
    if (!run || !existsSync(resultPath(run))) continue;
    const r = loadResult(run), D = r.demand?.id || (typeof r.demand === 'string' ? r.demand : null);
    if (!D || Object.values(r.results || {}).some(x => (x.status || 'todo') === 'todo')) continue;   // 还有没结论的：省掉一次 next
    let ready = false;
    try { ready = nextCards(ROOT, D, { planErrors: () => [] }).some(c => c.kind === 'report_due' && c.run === run); } catch { continue; }
    if (!ready) continue;
    const rr = spawnSync(process.execPath, [join(REPO_ROOT, 'bin', 'acceptkit.mjs'), 'report', run], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, ACCEPTKIT_PROJECT: ROOT } });
    console.error(rr.status === 0 ? `📄 ${run} 都做完了，报告已自动生成：acceptkit link ${run}` : `⚠️ ${run} 都做完了，但自动出报告失败：${(rr.stderr || '').trim().split('\n').slice(-2).join(' ')}（手动 acceptkit report ${run}）`);
  }
}

// --json 的返回：命令自己返回的（next / device / observe / reviewq / report / read）原样给；
// 其余从磁盘现读出被改动的那张卡片
function jsonOf(def, { pos, opt }, ret, before) {
  const run = String(pos[0]);
  if (def.name === 'record') return scopeCard(run, String(opt.expect));
  if (def.name === 'record_step') return scopeCard(run, `step:${opt.step}`);
  if (def.name === 'shot') return opt.step ? { ...scopeCard(run, `step:${opt.step}`), shot: shotSummary(ret) } : shotCard(run, ret);
  if (def.name === 'plan_finding') {
    const D = String(pos[1]), fs = loadPlan(ROOT, D)?.findings || [];
    const f = opt.finding ? fs.find(x => x.id === String(opt.finding)) : fs[fs.length - 1];
    return findingStateCard(D, f, findingProblems(f));
  }
  if (def.name === 'plan_approve' || def.name === 'plan_return') return planStateCard(String(pos[1]), loadPlan(ROOT, String(pos[1])));
  if (def.name === 'plan_decide' || def.name === 'plan_settle' || def.name === 'plan_bounce') {
    const D = String(pos[1]), fs = loadPlan(ROOT, D)?.findings || [];
    const cards = String(opt.finding).split(',').map(id => fs.find(x => x.id === id.trim())).map(f => findingStateCard(D, f, findingProblems(f)));
    return cards.length === 1 ? cards[0] : { results: cards };
  }
  if (def.name === 'blockers') {
    const D = String(pos[0]), now = readBlockers(ROOT, D);
    const one = opt.ack || opt.set || opt.resolve;
    if (one) return blockerStateCard(D, now.find(b => b.id === String(one)));
    const was = new Map((before || []).map(b => [b.id, JSON.stringify(b)]));
    const shown = opt.raise || opt.backfill ? now.filter(b => was.get(b.id) !== JSON.stringify(b)) : now;
    return { results: shown.map(b => blockerStateCard(D, b)), message: HUMAN.join('\n') };
  }
  return ret ?? {};
}
