// rounds.mjs —— 需求执行轮
//
// 一条需求会被测很多次，每次对着的代码不一样。以前的组织单位是 session（哪天跑的），
// 它回答不了两个问题：① 这次测的是哪份代码；② 代码变了以后，哪些结论还能沿用、哪些必须重测。
// 结果就是两头出错：要么一变就整轮重跑（浪费），要么变了也没人测（漏测）。
//
// 现在的单位是「轮」（round）：一轮 = 一份代码版本（每个被测仓的 分支 / commit / 提交说明 / 最新 commit 时间）。
//   · 开新轮必须带影响评估：相对上一轮改了哪些文件 → 哪些断言重置（要重测）、其余继承上一轮的状态。
//     变更不一定都要测 —— 由评估决定，但评估本身不能省（不评估就开不了轮）。
//   · 断言在第 k 轮的状态：从第 k 轮往回找 —— 本轮有记录用本轮；本轮重置了 = 待测；否则继承更早一轮，
//     并写明继承自哪一轮哪个 run。
//
// 存储：state/rounds/<需求>.json
//   { demand, repos: [{name, path}], rounds: [{ id, seq, opened_at, code: {仓: {branch, commit, subject, committed_at, dirty}},
//       code_source, base, changes: {仓: {from, to, files[], count}}, impact: {by, at, summary, reset: [{key, why}], inherit_note},
//       runs: [runId], sessions: [sessionId], migrated? }] }
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';

export const roundsPath = (SKILL, D) => join(SKILL, 'state', 'rounds', `${D}.json`);
export function loadRounds(SKILL, D) {
  try { return JSON.parse(readFileSync(roundsPath(SKILL, D), 'utf8')); } catch { return null; }
}
export function saveRounds(SKILL, D, rf) {
  mkdirSync(join(SKILL, 'state', 'rounds'), { recursive: true });
  writeFileSync(roundsPath(SKILL, D), JSON.stringify(rf, null, 1));
}

const git = (cwd, args) => {
  if (!cwd || !existsSync(cwd)) return null;
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout.trim() : null;
};

// 一个仓此刻的代码版本。dirty 只数已跟踪文件的改动：未跟踪的构建产物（.bazel 生成物）不改变被测代码。
export function repoSnapshot(path) {
  const commit = git(path, ['rev-parse', 'HEAD']);
  if (!commit) return { path, error: '读不到 git HEAD（路径不在或不是仓库）' };
  const dirty = (git(path, ['status', '--porcelain', '--untracked-files=no']) || '').split('\n').filter(Boolean);
  return { path, branch: git(path, ['rev-parse', '--abbrev-ref', 'HEAD']), commit,
           subject: git(path, ['log', '-1', '--format=%s']), committed_at: git(path, ['log', '-1', '--format=%cI']),
           dirty: dirty.length, dirty_list: dirty.slice(0, 30) };
}

// 两个 commit 之间改了哪些文件。from 不在本地（或不是祖先）时返回 null —— 让调用方显形「算不出改动面」，而不是当成没改。
export function changedFiles(path, from, to) {
  if (!from || !to) return null;
  if (from === to) return [];
  const out = git(path, ['diff', '--name-only', from, to]);
  return out === null ? null : out.split('\n').filter(Boolean);
}

// 被测仓 vs 对照仓：provenance 里常常同时记了基线（<app>-baseline-*、<app>-before、baseline 这类目录名），那是参照物不是被测代码。
export const isTestedRepo = (name, path) => !/baseline|before/i.test(`${name} ${basename(path || '')}`);
// 仓的身份按工作区目录名归一：同一个仓历史上可能被记成不同别名（如 host / <app>、engine / <engine-repo>）。
export const repoKey = (name, path) => (path ? basename(path) : name);

export function runBirth(runDir) {
  try { const s = statSync(runDir); return s.birthtimeMs || s.mtimeMs; } catch { return 0; }
}
// 从 run 的 provenance.json 取被测代码版本（只取被测仓），没有就返回 null。
export function runIdentity(runDir) {
  const f = join(runDir, 'evidence', 'provenance.json');
  if (!existsSync(f)) return null;
  let p; try { p = JSON.parse(readFileSync(f, 'utf8')); } catch { return null; }
  const code = {};
  for (const [n, v] of Object.entries(p.repos || {})) {
    if (!v || !v.commit || !isTestedRepo(n, v.path)) continue;
    code[repoKey(n, v.path)] = { path: v.path, branch: v.branch, commit: v.commit, subject: v.subject,
                                 committed_at: v.committed_at, dirty: v.dirty_files || 0 };
  }
  if (!Object.keys(code).length) return null;
  const key = Object.keys(code).sort().map(k => `${k}@${code[k].commit.slice(0, 12)}`).join(' ');
  return { key, code };
}

// 一条断言记录是什么时候记的：取它挂的证据文件里最新的 mtime；没有证据退回盲审时间，再退回 run 建立时间。
// （result.json 里的断言不带时间戳，而且老 run 会被重新记录 —— 所以「轮」按记录时间归，不按 run 归。）
export function recordTime(runDir, res, e) {
  const x = res.results?.[e] || {};
  let t = 0;
  for (const ev of x.evidence || []) {
    const rel = String(ev).replace(/^api:/, '');
    try { const m = statSync(join(runDir, rel)).mtimeMs; if (m > t) t = m; } catch { /* 证据已挪走 */ }
  }
  if (!t) for (const [k, v] of Object.entries(res.reviews || {})) {
    if (k.startsWith(`${e}::`) && v?.at) { const m = Date.parse(v.at); if (m > t) t = m; }
  }
  return t || runBirth(runDir);
}

// 一条需求全部断言记录（每个 run 的每条非 todo 断言一条）
export function demandRecords(runs, loadResultById) {
  const out = [];
  for (const r of runs) {
    const res = loadResultById(r.id); if (!res) continue;
    for (const [e, x] of Object.entries(res.results || {})) {
      if (!x || x.status === 'todo') continue;
      out.push({ key: `${res.case}::${e}`, run: r.id, session: r.session, seq: res.run_seq || 0,
                 t: recordTime(r.dir, res, e), status: x.status, actual: x.actual || '', finding: x.finding });
    }
  }
  return out;
}

// 存量迁移：按「被测代码版本第一次出现的时间」切轮。
// 代码版本取自各 run 的 provenance.json（只取被测仓），时间取该文件的 mtime；连续相同的版本合并。
// 第一个版本出现之前就有的记录归入一个「未记录代码版本」的首轮。
export function deriveHistory(runs, loadResultById) {
  const anchors = [];
  const recsAll = demandRecords(runs, loadResultById);
  for (const r of runs) {
    const id = runIdentity(r.dir); if (!id) continue;
    let t = 0; try { t = statSync(join(r.dir, 'evidence', 'provenance.json')).mtimeMs; } catch { /* */ }
    // provenance 常常是跑完才补记的（文件比证据晚）。它描述的是这个 run 自己的代码 ⇒ 锚点取「本 run 最早一条记录」与它两者较早者。
    const own = recsAll.filter(x => x.run === r.id).map(x => x.t);
    if (own.length) t = Math.min(t || Infinity, ...own);
    anchors.push({ t, ...id });
  }
  anchors.sort((a, b) => a.t - b.t);
  const segs = [];
  for (const a of anchors) if (!segs.length || segs[segs.length - 1].key !== a.key) segs.push({ start: a.t, key: a.key, code: a.code });
  const recs = recsAll;
  // 一条记录都还没有时，首轮从最早那个 run 建起来的时刻算（以前落到 0，看板上显示成 1970-01-01）
  const runBorn = runs.map(r => { try { const st = statSync(r.dir); return st.birthtimeMs || st.mtimeMs; } catch { return 0; } }).filter(Boolean);
  const firstRec = recs.length ? Math.min(...recs.map(x => x.t)) : (runBorn.length ? Math.min(...runBorn) : Date.now());
  if (!segs.length || firstRec < segs[0].start) segs.unshift({ start: firstRec, key: null, code: {} });
  return segs.map((sg, i) => ({ id: `R${i + 1}`, seq: i + 1, opened_at: new Date(sg.start).toISOString(),
    code: sg.code, code_source: sg.key ? 'provenance' : 'unknown', base: i ? `R${i}` : null, changes: null,
    impact: { by: 'migration', at: new Date().toISOString(),
              summary: '存量迁移：这一轮执行时没有做影响评估；断言按记录时间归入本轮（证据文件 mtime），状态按「后记覆盖先记」继承，与迁移前看板口径一致。',
              reset: [], inherit_note: '全部继承上一轮' },
    migrated: true }));
}

/**
 * doctor --fix：旧版迁移写下的「首轮开轮时间 = 1970-01-01」改成这个需求最早那个 run 目录的创建时间。
 * 只动 migrated 的首轮、只动这一个字段；返回改了哪些需求
 */
export function fixEpochRounds(root) {
  const dir = join(root, 'state', 'rounds');
  const fixed = [];
  let files = []; try { files = readdirSync(dir).filter(f => f.endsWith('.json')); } catch { return fixed; }
  const runDirs = (() => { try { return readdirSync(join(root, 'runs')); } catch { return []; } })();
  for (const f of files) {
    const p = join(dir, f);
    let rf; try { rf = JSON.parse(readFileSync(p, 'utf8')); } catch { continue; }
    const r0 = rf.rounds?.[0];
    if (!r0?.migrated || Date.parse(r0.opened_at) > 0) continue;
    const born = runDirs.map(id => {
      try { const res = JSON.parse(readFileSync(join(root, 'runs', id, 'result.json'), 'utf8')); if ((res.demand?.id || res.demand) !== rf.demand) return 0; const st = statSync(join(root, 'runs', id)); return st.birthtimeMs || st.mtimeMs; } catch { return 0; }
    }).filter(Boolean);
    if (!born.length) continue;
    r0.opened_at = new Date(Math.min(...born)).toISOString();
    writeFileSync(p, JSON.stringify(rf, null, 2) + '\n');
    fixed.push(`${rf.demand} → ${r0.opened_at.slice(0, 10)}`);
  }
  return fixed;
}

// 记录 → 轮：落在 [opened_at_i, opened_at_{i+1}) 的归第 i 轮
export function roundIndexAt(rf, t) {
  let idx = 0;
  for (let i = 0; i < rf.rounds.length; i++) if (Date.parse(rf.rounds[i].opened_at) <= t) idx = i;
  return idx;
}

// 断言在第 idx 轮（0 基）时的状态。
// 返回 Map<"case::E", {status, actual, run, round, source: 'here'|'inherited'|'reset'|'never', reason, t}>
export function resolveState(rf, idx, recs, expectKeys) {
  const per = rf.rounds.map(() => new Map());
  for (const r of recs) {
    const i = roundIndexAt(rf, r.t); if (i > idx) continue;
    const prev = per[i].get(r.key);
    if (!prev || r.t >= prev.t) per[i].set(r.key, r);
  }
  const keys = new Set(expectKeys || []);
  // 资产是分母：给了资产的断言清单时，只认清单里的 key。历史记录里出现过、但已从用例里删掉的断言
  // （如条件恒真、另一支不可达而删掉的那几条）不再算待测 —— 否则 `case::*` 的重置会把它们复活成幽灵 todo
  //（实测：一轮里冒出过一批）。没给清单时（老调用方）保持原口径。
  if (!expectKeys) for (let i = 0; i <= idx; i++) for (const k of per[i].keys()) keys.add(k);
  const out = new Map();
  for (const key of keys) {
    let got = null;
    for (let j = idx; j >= 0; j--) {
      const rec = per[j].get(key);
      if (rec) { got = { ...rec, round: rf.rounds[j].id, source: j === idx ? 'here' : 'inherited' }; break; }
      const rs = (rf.rounds[j].impact?.reset || []).find(x => x.key === key || (x.key.endsWith('::*') && key.startsWith(x.key.slice(0, -1))));
      if (rs) { got = { status: 'todo', source: 'reset', round: rf.rounds[j].id, reason: rs.why || '' }; break; }
    }
    out.set(key, got || { status: 'todo', source: 'never' });
  }
  return out;
}

// 每轮里实际有记录的 run / session（展示用）
export function roundMembers(rf, recs) {
  const m = rf.rounds.map(() => ({ runs: new Set(), sessions: new Set(), n: 0 }));
  for (const r of recs) { const i = roundIndexAt(rf, r.t); m[i].runs.add(r.run); m[i].sessions.add(r.session); m[i].n++; }
  return m.map(x => ({ runs: [...x.runs], sessions: [...x.sessions], records: x.n }));
}
