// 触发方式咨询（用例评审时用）：一步不是真实触发（直接注入 / 说不清），要回答的是「真实世界里这个输入从哪来、怎么让它真的发生」。
// 工具先去被测代码里找线索；执行者顺着线索往上追（输入在哪组装 → 谁调的 → 一直追到用户动作或现成工具能碰到的入口），
// 写出一份测法建议：真实情况下什么产生这个输入、代码依据、换成怎么测、开测前要不要先补东西、换过去能多验到哪一段。owner 看完定改不改。
//
// 工具层不调模型、不认业务词：线索只按形状找 ——
//   锚点 = 这一步手写的字段名和取值、文字里的代码名（下划线 / 点 / 驼峰连起来的标识符）
//   在被测仓里 git grep 锚点，按路径形状分：生产代码里出现 = 可能的组装点（真实输入在这里拼出来，它的调用方就是真实路径）；
//   调试 / 工具 / mock 类目录里出现 = 可能已有能走到组装点的入口；测试目录只计数（单测里的值不说明真实路径）。
//   同一个文件命中的锚点越多越靠前。项目自己的脚本目录（ops/、tools/）里提到锚点的，也列出来 —— 往往稍加改造就能真实触发。
// 测法建议和 owner 的决定记在项目数据目录 state/trigger-proposals.json（用户自己的数据，不进 acceptkit 目录）。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { literalFields, stepInput, walkSteps, INPUTS } from './input-source.mjs';

const TEST_PATH = /(^|\/)(tests?|androidTest|unitTest|__tests__|spec|testing)(\/|$)|Tests?\.(kt|java|swift|m|mm|ts|js|py|go|cpp)$|_test\.\w+$/i;
const TOOL_PATH = /(debug|diag|devtool|tool|panel|mock|demo|sample|playground|console|inspector)/i;
const CODE_ID = /\b[A-Za-z][A-Za-z0-9]*(?:[_.][A-Za-z0-9]+)+\b|\b[a-z]+[A-Z][A-Za-z0-9]*\b|\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/g;
const VALUE = /[=:]\s*["']?([A-Za-z_][A-Za-z0-9_.\-]{3,})/g;

/** 这一步的锚点：手写字段名、手写取值、文字里的代码名。太短、太泛的不要 */
export function anchorsOf(n) {
  // 这一步下面预期的观测参数（触发编号、策略单元名 …）也是线索：模板步骤自己往往一个可搜的词都没有
  const obs = (n.expect || []).flatMap(e => Object.values((e.observe?.by ? Object.values(e.observe.by)[0] : e.observe)?.params || {})).filter(v => typeof v === 'string' && /^[A-Za-z0-9_.\-]{4,}$/.test(v) && !/^\{/.test(v));
  const text = `${n.op || ''}\n${n.data ? JSON.stringify(n.data) : ''}\n${obs.map(v => `=${v}`).join(' ')}`;
  const fields = literalFields(text);
  const values = [...text.matchAll(VALUE)].map(m => m[1]).filter(v => !fields.includes(v));
  const ids = text.match(CODE_ID) || [];
  return [...new Set([...fields, ...values, ...ids])].filter(a => a.length >= 4 && !/^\d/.test(a) && !/^(true|false|null|http|https)$/i.test(a)).slice(0, 12);
}

function grepRepo(path, anchors, timeoutMs = 20000) {
  if (!anchors.length || !existsSync(path)) return [];
  const args = ['-C', path, 'grep', '-n', '-I', '-F', '--max-count=20', ...anchors.flatMap(a => ['-e', a]), '--', ...CODE_FILES];
  const r = spawnSync('git', args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
  if (r.error || (r.status !== 0 && r.status !== 1)) return [];
  return String(r.stdout || '').split('\n').filter(Boolean).slice(0, 4000).map(l => {
    const m = l.match(/^([^:]+):(\d+):(.*)$/); if (!m) return null;
    return { file: m[1], line: Number(m[2]), text: m[3].trim().slice(0, 200), hits: anchors.filter(a => m[3].includes(a)) };
  }).filter(Boolean);
}

/** 被测仓里的线索 → { assembly: [...], tools: [...], tests: N, scanned: [repo] } */
export function codeLeads(repos, anchors, { per = 8 } = {}) {
  const files = new Map(); let tests = 0;
  for (const repo of repos) for (const h of grepRepo(repo.path, anchors)) {
    if (TEST_PATH.test(h.file)) { tests++; continue; }
    const k = `${repo.name}:${h.file}`;
    const f = files.get(k) || { repo: repo.name, file: h.file, kind: TOOL_PATH.test(h.file) ? 'tool' : 'assembly', anchors: new Set(), lines: [] };
    h.hits.forEach(a => f.anchors.add(a)); if (f.lines.length < 3) f.lines.push(`${h.line}: ${h.text}`);
    files.set(k, f);
  }
  const rank = xs => xs.sort((a, b) => b.anchors.size - a.anchors.size).slice(0, per).map(f => ({ ...f, anchors: [...f.anchors] }));
  const all = [...files.values()];
  return { assembly: rank(all.filter(f => f.kind === 'assembly')), tools: rank(all.filter(f => f.kind === 'tool')), tests, scanned: repos.map(r => r.name) };
}


// ── 往上追：真实情况下这个输入是谁产生的 ──
// 只列「这个字段 / 取值在哪」不够：执行者要的是一条链 —— 生产代码里哪里真的产生了这个取值（发出点），
// 它在哪个函数里，谁调了这个函数 …… 一直追到界面 / 调试工具 / 入口类代码。链的最上面那一层，就是真实触发这一步的地方。
// 只按形状找：取值按字符串字面量搜；函数名按各语言的定义形状认；调用方按整词搜。追 3 层、每层最多 2 个调用方。
const ENTRY_PATH = /(ViewController|Controller|Activity|Fragment|Page|Panel|Screen|View|Cell|Button|Debug|Tool|Mock|Entry|Router|Scheme|Handler)/;
const FN_DEF = [
  /^\s*[-+]\s*\([^)]*\)\s*([A-Za-z_]\w*)/,                         // Objective-C 方法
  /\b(?:func|fun|def|function)\s+([A-Za-z_]\w*)/,                  // Swift / Kotlin / Python / JS
  /^\s*(?:[\w<>\[\],*&:]+\s+)+(?:[\w]+::)?([A-Za-z_]\w*)\s*\([^;]*$/, // Java / C++ 定义（行尾不是分号）
];
const CODE_FILES = ['*.m', '*.mm', '*.h', '*.swift', '*.kt', '*.java', '*.c', '*.cc', '*.cpp', '*.hpp', '*.ts', '*.tsx', '*.js', '*.py', '*.go', '*.rs', '*.dart'];
const NOT_FN = new Set(['if', 'for', 'while', 'switch', 'return', 'catch', 'else', 'sizeof', 'new', 'init', 'main', 'run', 'get', 'set', 'invoke', 'apply', 'call']);
const fnOfLine = l => { for (const re of FN_DEF) { const m = l.match(re); if (m && !NOT_FN.has(m[1]) && m[1].length >= 4) return m[1]; } return null; };

function gitLines(path, args, limit = 60, timeout = 15000) {
  const r = spawnSync('git', ['-C', path, 'grep', '-n', '-I', ...args, '--', ...CODE_FILES], { encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
  if (r.error || (r.status !== 0 && r.status !== 1)) return [];
  return String(r.stdout || '').split('\n').filter(Boolean).slice(0, limit).map(l => { const m = l.match(/^([^:]+):(\d+):(.*)$/); return m ? { file: m[1], line: Number(m[2]), text: m[3].trim().slice(0, 160) } : args.includes('-l') ? { file: l } : null; }).filter(Boolean);
}
/** 这一行在哪个函数里（往上找最近的定义） */
export function enclosingFn(repoPath, file, line) {
  let L = []; try { L = readFileSync(join(repoPath, file), 'utf8').split('\n'); } catch { return null; }
  for (let i = line - 1; i >= 0 && i >= line - 400; i--) { const f = fnOfLine(L[i] || ''); if (f) return { name: f, line: i + 1 }; }
  return null;
}
function callersOf(repo, name, self) {
  return gitLines(repo.path, ['-w', '-F', '--max-count=3', '-e', name], 40)
    .filter(h => !TEST_PATH.test(h.file) && !(h.file === self.file && Math.abs(h.line - self.line) < 3) && fnOfLine(h.text) !== name)
    .sort((a, b) => Number(ENTRY_PATH.test(b.file)) - Number(ENTRY_PATH.test(a.file))).slice(0, 2);
}
/** 取值在生产代码里的发出点 → 往上追的链：[{ value, chain: [{ repo, file, line, fn, text, entry }] }] */
export function traceSources(repos, values, { per = 4, hops = 3, budgetMs = 30000 } = {}) {
  const out = [], t0 = Date.now();
  for (const v of values) for (const repo of repos) {
    if (Date.now() - t0 > budgetMs) break;   // 追链有时间上限：宁可少几条，不让 consult 卡住
    // 出现在很多文件里的取值不是某一个具体输入（常见词、模块名），追它只会得到噪音
    const files = gitLines(repo.path, ['-l', '-F', '-e', `"${v}"`], 200);
    if (files.length > 25) continue;
    const seeds = gitLines(repo.path, ['-F', '--max-count=5', '-e', `"${v}"`], 40).filter(h => !TEST_PATH.test(h.file)).slice(0, per);
    for (const s of seeds) {
      const chain = [{ repo: repo.name, file: s.file, line: s.line, text: s.text, entry: ENTRY_PATH.test(s.file) }];
      let cur = s, seen = new Set([`${s.file}:${s.line}`]);
      for (let h = 0; h < hops && !chain.at(-1).entry; h++) {
        const fn = enclosingFn(repo.path, cur.file, cur.line); if (!fn) break;
        chain.at(-1).fn = fn.name;
        const up = callersOf(repo, fn.name, { file: cur.file, line: fn.line }).find(c => !seen.has(`${c.file}:${c.line}`)); if (!up) break;
        seen.add(`${up.file}:${up.line}`);
        chain.push({ repo: repo.name, file: up.file, line: up.line, text: up.text, entry: ENTRY_PATH.test(up.file) });
        cur = up;
      }
      out.push({ value: v, chain });
    }
  }
  // 追到入口的排前面，链长的（追得深）其次
  return out.sort((a, b) => Number(b.chain.at(-1).entry) - Number(a.chain.at(-1).entry) || b.chain.length - a.chain.length).slice(0, 8);
}
/** 这一步手写的取值（字符串形状的）：真实代码里产生同一个取值的地方，就是真实输入的来源 */
export function literalValues(n) {
  const text = `${n.op || ''}\n${n.data ? JSON.stringify(n.data) : ''}`;
  return [...new Set([...text.matchAll(/[=:]\s*["']?([A-Za-z_][A-Za-z0-9_.\-]{3,})/g)].map(m => m[1]))].filter(v => !/^(true|false|null|https?)$/i.test(v)).slice(0, 6);
}

// 叫人点、叫人找的界面上的字：点击「X」/ 点「X」/ 在「X」… / 找到「X」/「X」页 / 列表 / tab / 按钮 / 这一行。
// 「是不是「1.T#」」这类要比对的取值不算（那是数据，不是界面上的字）；带 {param.x} 的先填参数
const UI_NAME = /(?:点击|点|在|找到|打开|进入|输入)「([^」{}]{2,60})」|「([^」{}]{2,60})」(?:页|列表|tab|按钮|这一行|开头)/g;
export function uiNames(lines) {
  const out = new Set();
  for (const l of lines) for (const m of String(l).matchAll(UI_NAME)) { const v = (m[1] || m[2]).trim();
    // 文件名、路径、正则不是界面上的字（例：打开「evidence/x.log」、按「^a.*b$」搜）
    if (v && !/^\d+$/.test(v) && !/[\\/*^$|]|\.[A-Za-z]{2,5}$/.test(v)) out.add(v); }
  return [...out];
}
/** 这些界面上的字在被测代码里找不找得到（逐字）→ 找不到的名单。界面文字在资源 / 代码里，只搜这些文件 */
// 一个仓只搜一遍：所有名字一起给，-o 只回命中的那段字，看哪些名字出现过（逐个名字各搜一遍，大仓上一条用例要几分钟）
// 结果按「仓 + 当前提交」缓存：同一个提交上一个字在不在不会变，连续写回十几条用例不用每次重搜大仓。缓存放项目数据目录（cacheDir 由调用方给）
export function missingNames(repos, names, cacheFile = null) {
  if (!repos.length) return null;
  const left = new Set(names);
  let cache = {}; if (cacheFile) { try { cache = JSON.parse(readFileSync(cacheFile, 'utf8')); } catch { cache = {}; } }
  const absent = new Map();
  for (const r of repos) {
    const head = String(spawnSync('git', ['-C', r.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout || '').trim();
    const c = cache[r.path]?.head === head ? cache[r.path] : (cache[r.path] = { head, found: [], absent: [] });
    for (const n of [...left]) if (c.found.includes(n)) left.delete(n);
    const todo = [...left].filter(n => !c.absent.includes(n));
    absent.set(r.path, c);
    if (!todo.length) continue;
    const x = spawnSync('git', ['-C', r.path, 'grep', '-h', '-o', '-I', '-F', ...todo.flatMap(n => ['-e', n]), '--', '*.xml', '*.strings', '*.json', ...CODE_FILES],
      { encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
    const hits = new Set(String(x.stdout || '').split('\n'));
    for (const n of todo) { if (hits.has(n)) { c.found.push(n); left.delete(n); } else c.absent.push(n); }
  }
  if (cacheFile) { try { mkdirSync(join(cacheFile, '..'), { recursive: true }); writeFileSync(cacheFile, JSON.stringify(cache)); } catch { /* 缓存写不了就下次再搜 */ } }
  return names.filter(n => left.has(n));
}
export function _missingNamesUncached(repos, names) {
  if (!repos.length) return null;
  const left = new Set(names);
  for (const r of repos) {
    if (!left.size) break;
    const x = spawnSync('git', ['-C', r.path, 'grep', '-h', '-o', '-I', '-F', ...[...left].flatMap(n => ['-e', n]), '--', '*.xml', '*.strings', '*.json', ...CODE_FILES],
      { encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
    for (const hit of new Set(String(x.stdout || '').split('\n'))) left.delete(hit);
  }
  return names.filter(n => left.has(n));
}
/**
 * 界面字三态 → Map(名字 → found | missing | unknown)。fail-closed：
 *   没登记被测仓 → 全部 unknown（查不了不等于找到了）
 *   git grep 出错 / 超时（status 不是 0 也不是 1、或有 error / signal）→ 那个仓查不了；没在别的仓找到的记 unknown，不写缓存
 *   工作区有未提交的改动 → 不读也不写缓存（缓存按提交算，改动里的字可能刚加）
 * 只有确定的 found / missing 进缓存
 */
const REPO_STATE = new Map();
export function uiNameStates(repos, names, cacheFile = null) {
  const uniq = [...new Set(names)], st = new Map(uniq.map(n => [n, 'unknown']));
  if (!repos.length || !uniq.length) return st;
  let cache = {}; if (cacheFile) { try { cache = JSON.parse(readFileSync(cacheFile, 'utf8')); } catch { cache = {}; } }
  const left = new Set(uniq); let failed = false, dirtyCache = false;
  for (const r of repos) {
    if (!left.size) break;
    // 仓的提交号和有没有未提交改动，一个进程里只看一次（大仓上 git status 一次要几十秒，状态 / 打包会对每条用例都问）
    const rs = REPO_STATE.get(r.path) || REPO_STATE.set(r.path, { head: String(spawnSync('git', ['-C', r.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout || '').trim(),
      dirty: String(spawnSync('git', ['-C', r.path, 'status', '--porcelain', '-uno'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120000 }).stdout || '').trim().length > 0 }).get(r.path);
    const { head, dirty } = rs;
    const c = !dirty && head && cache[r.path]?.head === head ? cache[r.path] : null;
    if (c) for (const n of [...left]) if (c.found.includes(n)) { st.set(n, 'found'); left.delete(n); }
    const todo = [...left].filter(n => !(c && c.absent.includes(n)));
    if (!todo.length) continue;
    const x = spawnSync('git', ['-C', r.path, 'grep', '-h', '-o', '-I', '-F', ...todo.flatMap(n => ['-e', n]), '--', '*.xml', '*.strings', '*.json', ...CODE_FILES],
      { encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
    if (x.error || x.signal || (x.status !== 0 && x.status !== 1)) { failed = true; continue; }
    const hits = new Set(String(x.stdout || '').split('\n'));
    const rec = !dirty && head ? (cache[r.path]?.head === head ? cache[r.path] : (cache[r.path] = { head, found: [], absent: [] })) : null;
    for (const n of todo) { if (hits.has(n)) { st.set(n, 'found'); left.delete(n); rec?.found.push(n); } else rec?.absent.push(n); }
    if (rec) dirtyCache = true;
  }
  // 所有仓都确定搜过还没找到才算 missing；有仓查不了就仍是 unknown
  if (!failed) for (const n of left) st.set(n, 'missing');
  if (cacheFile && dirtyCache) { try { mkdirSync(join(cacheFile, '..'), { recursive: true }); writeFileSync(cacheFile, JSON.stringify(cache)); } catch { /* 缓存写不了就下次再搜 */ } }
  return st;
}
/** 一批行里的名字一次查完 → Map(名字 → 找不到) */
export function missingNamesBatch(repos, groups, cacheFile = null) {
  const all = [...new Set(groups.flatMap(g => g))], miss = new Set(missingNames(repos, all, cacheFile) || []);
  return groups.map(g => repos.length ? g.filter(n => miss.has(n)) : null);
}

/** 项目自己的脚本（ops/、tools/）里提到锚点的：常常是能建设成触发工具的半成品 */
export function projectScripts(root, anchors, per = 6) {
  const out = [];
  for (const d of ['ops', 'tools']) {
    let fs = []; try { fs = readdirSync(join(root, d)).filter(f => /\.(py|js|mjs|sh|ts)$/.test(f)); } catch { continue; }
    for (const f of fs) { let t = ''; try { t = readFileSync(join(root, d, f), 'utf8'); } catch { continue; }
      const hit = anchors.filter(a => t.includes(a)); if (hit.length) out.push({ file: `${d}/${f}`, anchors: hit }); }
  }
  return out.sort((a, b) => b.anchors.length - a.anchors.length).slice(0, per);
}

/** 操作库里已登记为真实触发的操作，和这一步共享锚点的（直接复用的候选） */
export function realOps(ops, anchors, per = 6) {
  return Object.entries(ops || {}).filter(([, o]) => o.input === 'real').map(([id, o]) => {
    const t = JSON.stringify(o); return { op: id, title: o.title, anchors: anchors.filter(a => t.includes(a)) };
  }).sort((a, b) => b.anchors.length - a.anchors.length).slice(0, per);
}

/** 找到用例里的这一步 */
export function findStep(c, nodeId) { let hit = null; walkSteps(c.tree, x => { if (x.id === nodeId) hit = x; }); return hit; }
/** 用例里所有不是真实触发的步骤（注入 / 说不清）→ [{ id, n, from }] */
export function nonRealSteps(c, ops) {
  const out = []; walkSteps(c.tree, ({ id, n }) => { const s = stepInput(n, ops, typeof c.input === 'string' ? { from: c.input } : c.input); if (s.from === 'injected' || s.from === 'unknown') out.push({ id, n, ...s }); });
  return out;
}

// ── 测法建议与 owner 的决定 ──
const PROP = root => join(root, 'state', 'trigger-proposals.json');
export const loadProposals = root => { try { return JSON.parse(readFileSync(PROP(root), 'utf8')); } catch { return []; } };
const saveProposals = (root, xs) => { mkdirSync(join(root, 'state'), { recursive: true }); writeFileSync(PROP(root), JSON.stringify(xs, null, 1) + '\n'); };
// 一份测法建议要让 owner 不看代码也能定：每一项都是他拍板要用的事实，缺一项就定不了
export const PROPOSAL_PARTS = {
  real: '真实情况下，是什么产生了这一步的输入（用户做了什么 / app 发了什么）',
  evidence: '代码依据：从输入组装的地方一路到那个动作，每处「文件:行 这里是什么」',
  how: '换成真实触发后，这一步具体怎么做',
  catches: '换过去以后多验到的是哪一段（注入时跳过、可能出错的那段）',
};
export function addProposal(root, { demand, caseName, node, real, evidence, how, prep, catches }) {
  const p = { real, how, catches }, ev = [].concat(evidence || []).map(String).filter(Boolean);
  const miss = Object.entries(PROPOSAL_PARTS).filter(([k]) => k === 'evidence' ? !ev.length : !String(p[k] || '').trim()).map(([k, v]) => `--${k}（${v}）`);
  if (miss.length) throw new Error(`测法建议还缺：${miss.join('；')}。--prep 写开测前要先补的东西和工作量，现在就能测的不写`);
  const xs = loadProposals(root), id = `T${xs.length + 1}`;
  xs.push({ id, demand: demand || null, case: caseName, node, real: String(real), evidence: ev, how: String(how), prep: prep ? String(prep) : null, catches: String(catches), status: 'proposed', at: new Date().toISOString() });
  saveProposals(root, xs); return xs.at(-1);
}
export function decideProposal(root, id, { adopt, by, quote }) {
  if (!by || !String(quote || '').trim()) throw new Error('改不改是 owner 的决定：要 --by <他> --quote "<原话>"');
  const xs = loadProposals(root), p = xs.find(x => x.id === id); if (!p) throw new Error(`没有建议 ${id}`);
  Object.assign(p, { status: adopt ? 'adopted' : 'rejected', decided_by: String(by), quote: String(quote), decided_at: new Date().toISOString() });
  saveProposals(root, xs); return p;
}
export { INPUTS };
