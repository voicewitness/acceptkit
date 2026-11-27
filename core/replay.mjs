// 执行缓存：一条用例跑通过一次，下次照着放一遍 —— 像提示缓存，不改用例、不改操作配方。
// 缓存、执行日志都是用户自己的数据：只写在项目目录（root = 项目根，例：<数据盘>/projects/<项目>）里，绝不写进 acceptkit 代码目录。
//
// 记：执行者每条带运行号的 acceptkit 命令记进这个运行的执行日志（runs/<运行>/journal.jsonl：命令原样、退出码、耗时）。
// 存：一个运行所有断言都有结论（没有验不了的）后，把日志里成功的「动作」命令（占设备、发设备命令、截图、机判）按顺序
//     存成这条用例的缓存（state/cache/<用例>.json），连同当时每条断言的结论和证据数，作为下次比对的基准。
//     失败重试、只读命令（next / read / context …）、手记的判断（record）都不进缓存：判断永远是这一次自己做的。
// 放：下次跑这条用例，先 replay 照缓存把命令放一遍（换成新运行号），机判的断言照常由工具判。
// 查：放完拿关键路径和结论跟基准比 —— 有一步失败、有断言结论不一样、证据少了一半以上，就算差别大：
//     作废这份缓存（留档不删），这一轮按正常流程重跑核对。正常跑完再比一次：结论跟回放时一样，说明差别是被测物真变了；
//     不一样，说明是缓存的毛病。两种都记进 state/cache/log.jsonl（优化包里看得到），然后用这次正常跑的重建缓存。
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, renameSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// 进缓存的命令：除了只读的、做判断的、管流程的，其余都算动作（动设备、截图、机判，以及项目自己扩展的准备命令，例：往被测端注入配置）。
// 反过来列不进的：项目扩展的命令事先不知道，按白名单列会漏掉准备步骤，回放一次就差别大、缓存永远建不起来
const NOT_ACTION = new Set(['next', 'read', 'context', 'consult', 'review', 'reviewq', 'report', 'plan', 'blockers', 'timing', 'tune', 'replay',
  'record', 'steps', 'history', 'cases', 'demands', 'dup', 'validate', 'coverage', 'link', 'open', 'apparatus', 'refile', 'bug', 'round', 'run', 'loop', 'protocol']);
const ACTION_SUB = { device: sub => sub === 'acquire', browser: sub => sub === 'open' };
const isAction = argv => !NOT_ACTION.has(argv[0]) && (ACTION_SUB[argv[0]] ? ACTION_SUB[argv[0]](argv[1]) : true);
const cacheDir = root => join(root, 'state', 'cache');
const cachePath = (root, c) => join(cacheDir(root), `${c}.json`);
const journalPath = (root, run) => join(root, 'runs', run, 'journal.jsonl');
const readJSON = p => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

/** 这条命令记到哪个运行：--run R，或第一个位置参数正好是个运行 */
export function runOfArgv(root, argv) {
  const i = argv.indexOf('--run'); if (i >= 0 && argv[i + 1]) return argv[i + 1];
  const eq = argv.find(a => a.startsWith('--run=')); if (eq) return eq.slice(6);
  const p = argv.slice(1).find(a => !a.startsWith('--'));
  return p && existsSync(join(root, 'runs', p, 'result.json')) ? p : null;
}
export function journalAppend(root, argv, { exit, ms, replay = null }) {
  const run = runOfArgv(root, argv); if (!run || !existsSync(join(root, 'runs', run))) return;
  try { appendFileSync(journalPath(root, run), JSON.stringify({ at: new Date().toISOString(), argv, exit, ms, ...(replay ? { replay } : {}) }) + '\n'); } catch { /* 记不进去不影响命令本身 */ }
}
export const journalOf = (root, run) => { try { return readFileSync(journalPath(root, run), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };

// 关键路径：动作命令的骨架（命令 + 子命令 / adb 的前三个词 / 机判的是哪条断言），不含运行号和具体数值
const shape = argv => {
  if (argv[0] === 'adb') { const k = argv.indexOf('--'); return `adb ${argv.slice(k + 1, k + 4).join(' ').replace(/\d+/g, '#')}`; }
  if (argv[0] === 'observe') { const i = argv.indexOf('--expect'); return `observe ${i >= 0 ? argv[i + 1] : argv.includes('--todo') ? '--todo' : ''}`.trim(); }
  return `${argv[0]} ${argv[1] && !argv[1].startsWith('--') && argv[0] !== 'shot' ? argv[1] : ''}`.trim();
};
const outcome = r => Object.fromEntries(Object.entries(r.results || {}).map(([id, v]) => [id, { status: v?.status || 'todo', ev: (v?.evidence || []).length }]));

/** 一个运行能不能拿来建缓存：每条断言都有结论、没有验不了的、日志里有动作 */
export function cacheable(root, run, r) {
  const vs = Object.values(r.results || {});
  if (!vs.length || vs.some(v => !v || v.status === 'todo' || v.status === 'blocked')) return null;
  // 执行日志得从开跑起就是全的：日志机制之前开的运行只记到后半段，拿它建缓存回放必少步骤
  if (!r.created_at || !(r.timeline || []).some(e => e.kind === 'created')) return null;
  const steps = journalOf(root, run).filter(e => e.exit === 0 && !e.replay && isAction(e.argv));
  return steps.length ? steps : null;
}
export function buildCache(root, run, r) {
  const steps = cacheable(root, run, r); if (!steps) return null;
  const cache = { case: r.case, from_run: run, built_at: new Date().toISOString(),
    steps: steps.map(e => ({ argv: e.argv, ms: e.ms })), path: steps.map(e => shape(e.argv)), outcome: outcome(r) };
  mkdirSync(cacheDir(root), { recursive: true });
  writeFileSync(cachePath(root, r.case), JSON.stringify(cache, null, 1));
  return cache;
}
export const loadCache = (root, c) => readJSON(cachePath(root, c));

/** 放一遍：run 换成新运行号，逐条执行，有一步失败就停。exec(argv) → { status, ms } 由调用方给（跑 acceptkit 自己） */
export function replay(root, run, cache, exec) {
  const done = [];
  for (const s of cache.steps) {
    const argv = s.argv.map(a => a === cache.from_run ? run : a.replace(`--run=${cache.from_run}`, `--run=${run}`));
    const x = exec(argv);
    done.push({ argv, exit: x.status, ms: x.ms, path: shape(argv) });
    if (x.status !== 0) return { ok: false, failedAt: done.length - 1, done };
  }
  return { ok: true, done };
}

/** 回放的结果跟基准比，差别大就说出是哪几处 */
export function compare(cache, done, r) {
  const reasons = [];
  const bad = done.find(d => d.exit !== 0);
  if (bad) reasons.push(`第 ${done.indexOf(bad) + 1} 步失败：${bad.path}`);
  const now = outcome(r);
  const flipped = Object.entries(cache.outcome).filter(([id, o]) => now[id] && now[id].status !== 'todo' && now[id].status !== o.status);
  if (flipped.length) reasons.push(`结论跟上次不一样：${flipped.map(([id, o]) => `${id} ${o.status}→${now[id].status}`).join(' ')}`);
  const thin = Object.entries(cache.outcome).filter(([id, o]) => o.ev >= 2 && (now[id]?.ev || 0) < o.ev / 2);
  if (thin.length) reasons.push(`证据少了一半以上：${thin.map(([id, o]) => `${id} ${o.ev}→${now[id]?.ev || 0}`).join(' ')}`);
  return { big: reasons.length > 0, reasons };
}

/** 差别大：作废缓存（改名留档），记一笔待核对；正常跑完时由 settleCheck 收口 */
export function dropCache(root, c, run, reasons, r) {
  const p = cachePath(root, c); if (!existsSync(p)) return;
  const to = join(cacheDir(root), `${c}.dropped-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  renameSync(p, to);
  logCache(root, { kind: 'dropped', case: c, run, reasons, replay_outcome: outcome(r), archived: to });
}
export function logCache(root, rec) {
  mkdirSync(cacheDir(root), { recursive: true });
  appendFileSync(join(cacheDir(root), 'log.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...rec }) + '\n');
}
export const cacheLog = root => { try { return readFileSync(join(cacheDir(root), 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };

/** 正常跑完（不是回放的运行全部有结论）：如果这条用例的缓存刚被作废过、还没核对，比一下 —— 结论跟回放时一样 = 被测物真变了；不一样 = 缓存的毛病 */
export function settleCheck(root, run, r) {
  const log = cacheLog(root);
  const open = log.filter(x => x.kind === 'dropped' && x.case === r.case && !log.some(y => y.kind === 'checked' && y.dropped_at === x.at)).at(-1);
  if (!open) return null;   // 同一个运行也算：回放差别大退回待测后，正常流程就在这个运行里重判
  const now = outcome(r);
  const diff = Object.entries(open.replay_outcome).filter(([id, o]) => o.status !== 'todo' && now[id] && now[id].status !== o.status);
  const rec = { kind: 'checked', case: r.case, run, dropped_at: open.at, verdict: diff.length ? 'cache_bug' : 'real_change',
    detail: diff.length ? `正常跑出来跟回放不一样：${diff.map(([id, o]) => `${id} 回放 ${o.status} / 正常 ${now[id].status}`).join(' ')}` : '正常跑出来跟回放一样：差别是被测物真变了' };
  logCache(root, rec);
  return rec;
}

/** 结论类命令（observe / record）跑完：这个运行全部有结论了 → 先核对之前作废的缓存，再用这次正常跑的建缓存（回放出来的运行不拿来建）。返回要打给执行者看的话 */
export function afterCommand(root, argv) {
  if (!['observe', 'record'].includes(argv[0])) return [];
  const run = runOfArgv(root, argv); if (!run) return [];
  const r = readJSON(join(root, 'runs', run, 'result.json'));
  if (!r || Object.values(r.results || {}).some(v => (v?.status || 'todo') === 'todo')) return [];
  const out = [], chk = settleCheck(root, run, r);
  if (chk) out.push(`↻ 执行缓存核对（${r.case}）：${chk.detail}`);
  // 回放顺利的运行不重建（缓存照旧）；回放被作废、正常流程重判完的，用正常那部分建
  if (!r.replay?.ok && loadCache(root, r.case)?.from_run !== run && buildCache(root, run, r)) out.push(`↻ 用例 ${r.case} 的执行缓存已更新：下次跑先 acceptkit replay <运行>`);
  return out;
}

/** 缓存的表现：给优化包和看板 */
export function cacheStats(root) {
  const log = cacheLog(root), dir = cacheDir(root);
  const live = existsSync(dir) ? readdirSync(dir).filter(f => /^[^.]+\.json$/.test(f) && f !== 'log.jsonl').length : 0;
  const replays = log.filter(x => x.kind === 'replayed');
  return { live, replays: replays.length, replay_ms: replays.reduce((s, x) => s + (x.ms || 0), 0),
    dropped: log.filter(x => x.kind === 'dropped').length, cache_bug: log.filter(x => x.verdict === 'cache_bug'), real_change: log.filter(x => x.verdict === 'real_change').length };
}
