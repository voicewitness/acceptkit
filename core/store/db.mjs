// SQLite 存储（Node 22 内置 node:sqlite，零依赖）。
//
// 正本在这里的：设备租约（只由 CLI 写，需要原子读改写）、审批记录、环境快照。
// 派生在这里的：用例 / 运行 / 结论索引 —— 正本是项目目录里的 JSON 文件（人可读，项目自带脚本可能直接读写），
// 索引按文件内容哈希增量重建，任何时候都能从文件完整重建，所以不是双写。
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// node:sqlite 在 Node 22 上会打 ExperimentalWarning，混进 --json 输出就坏了；只屏蔽这一条。
const origEmit = process.emitWarning;
process.emitWarning = function (w, ...rest) {
  const msg = typeof w === 'string' ? w : w?.message;
  if (/SQLite is an experimental feature/.test(msg || '')) return;
  return origEmit.call(this, w, ...rest);
};
const { DatabaseSync } = await import('node:sqlite');

const SCHEMA_VERSION = 3;
const DDL = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS device_leases (
  udid TEXT PRIMARY KEY, run TEXT NOT NULL, holder TEXT NOT NULL, platform TEXT,
  since TEXT NOT NULL, heartbeat TEXT NOT NULL, note TEXT, extra TEXT);
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL, subject TEXT NOT NULL,
  by TEXT, quote TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS env_snapshots (
  id TEXT PRIMARY KEY, at TEXT NOT NULL, target TEXT, platform TEXT, facts TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS loop_bindings (
  key TEXT PRIMARY KEY, demand TEXT NOT NULL, at TEXT NOT NULL, cwd TEXT);
CREATE TABLE IF NOT EXISTS quality_baseline (
  case_id TEXT PRIMARY KEY, at TEXT NOT NULL, keys TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS idx_files (path TEXT PRIMARY KEY, sha TEXT NOT NULL, kind TEXT NOT NULL, mtime REAL);
CREATE TABLE IF NOT EXISTS cases (
  id TEXT PRIMARY KEY, title TEXT, platform TEXT, host TEXT, kind TEXT, origin TEXT,
  nodes INTEGER, expects INTEGER, path TEXT, doc TEXT);
CREATE TABLE IF NOT EXISTS expects (
  case_id TEXT, id TEXT, assert TEXT, has_observe INTEGER, op TEXT, applies TEXT, path TEXT,
  PRIMARY KEY (case_id, id));
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, case_id TEXT, run_seq INTEGER, prev_run TEXT, session TEXT, demand TEXT,
  platform TEXT, device TEXT, verdict TEXT, build TEXT, superseded_by TEXT, path TEXT);
CREATE TABLE IF NOT EXISTS verdicts (
  run TEXT, expect TEXT, status TEXT, blocked_kind TEXT, observed_op TEXT, strength TEXT, evidence_n INTEGER, actual TEXT,
  PRIMARY KEY (run, expect));
CREATE TABLE IF NOT EXISTS plans (
  demand TEXT PRIMARY KEY, title TEXT, platform TEXT, revision INTEGER, approved_at TEXT, approved_by TEXT, cases TEXT);
-- 评价（core/assess.mjs）：事前 / 事后一次评价 = 一行；明细逐维度；建议带决定与落地记录。卡口只读这三张表。
CREATE TABLE IF NOT EXISTS assessments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL, phase TEXT NOT NULL,
  rubric_version INTEGER NOT NULL, at TEXT NOT NULL, by TEXT NOT NULL, basis TEXT NOT NULL, demand TEXT,
  score INTEGER NOT NULL, gate TEXT NOT NULL, dims TEXT NOT NULL, superseded_by INTEGER);
CREATE TABLE IF NOT EXISTS assessment_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, assessment_id INTEGER NOT NULL, dimension TEXT NOT NULL, rule TEXT, target TEXT,
  level TEXT NOT NULL, finding TEXT, evidence TEXT, fix TEXT, ikey TEXT);
CREATE TABLE IF NOT EXISTS suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ikey TEXT NOT NULL, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL, demand TEXT,
  first_item INTEGER, last_item INTEGER, dimension TEXT, level TEXT, kind TEXT, text TEXT, options TEXT, consult TEXT,
  status TEXT NOT NULL, proposed_at TEXT NOT NULL, decided_by TEXT, quote TEXT, decided_at TEXT,
  applied_ref TEXT, applied_at TEXT, retro TEXT, needs_retro INTEGER DEFAULT 0);
-- 用例评审（core/case-review.mjs）：一次打包 = review_cards 一行（每项的指纹，提交时比对）；owner 判过不合格的原题进 review_canaries 当考题
CREATE TABLE IF NOT EXISTS review_cards (
  id TEXT PRIMARY KEY, at TEXT NOT NULL, demand TEXT, cases TEXT NOT NULL, rubric_version INTEGER NOT NULL, extractor_version INTEGER NOT NULL,
  items TEXT NOT NULL, canaries TEXT);
CREATE TABLE IF NOT EXISTS review_canaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT, dim TEXT NOT NULL, item TEXT NOT NULL, max_score INTEGER NOT NULL, source TEXT, quote TEXT);
CREATE INDEX IF NOT EXISTS ix_assess_subject ON assessments(subject_kind, subject_id, phase);
CREATE INDEX IF NOT EXISTS ix_items_assess ON assessment_items(assessment_id);
CREATE UNIQUE INDEX IF NOT EXISTS ix_sugg_key ON suggestions(ikey);
CREATE INDEX IF NOT EXISTS ix_runs_case ON runs(case_id);
CREATE INDEX IF NOT EXISTS ix_verdicts_status ON verdicts(status);
`;

const handles = new Map();
export function openDb(root) {
  if (handles.has(root)) return handles.get(root);
  const dir = join(root, '.acceptkit');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'acceptkit.db'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  db.exec(DDL);
  // v3：评审项的分数、上限、指纹、复述等记在已有的 assessment_items 上（只加列不删）
  const cols = new Set(db.prepare('PRAGMA table_info(assessment_items)').all().map(r => r.name));
  for (const [c, t] of [['score', 'INTEGER'], ['cap', 'INTEGER'], ['item_fp', 'TEXT'], ['facts', 'TEXT'], ['extract', 'TEXT'], ['rulings', 'TEXT'], ['card_id', 'TEXT'], ['reason', 'TEXT']])
    if (!cols.has(c)) db.exec(`ALTER TABLE assessment_items ADD COLUMN ${c} ${t}`);
  db.exec('CREATE INDEX IF NOT EXISTS ix_items_ikey ON assessment_items(ikey)');
  db.prepare('INSERT OR REPLACE INTO meta(k, v) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
  handles.set(root, db);
  return db;
}

// ---------- 设备租约 ----------
// 租约是「整表读 → 改一条 → 写回」。并行验收的几个进程同时在写：整表删了重插，后写的人会把先写的人刚占的机器抹掉，
// 第三个 run 随后就能占到同一台，两轮的证据混在一台机器上。所以写回只动本进程改了的那几条（对照读到时的快照），
// 并且在 IMMEDIATE 事务里重读：读到之后这台机器换了主人，就拒绝写，而不是盖掉。
const _leaseSeen = new Map();   // root -> Map(udid -> 读到时那条的 JSON)
function leaseRows(db) {
  const out = {};
  for (const r of db.prepare('SELECT * FROM device_leases').all()) {
    out[r.udid] = { run: r.run, holder: r.holder, platform: r.platform, since: r.since, heartbeat: r.heartbeat, note: r.note || '',
                    ...(r.extra ? JSON.parse(r.extra) : {}) };
  }
  return out;
}
export function loadLeases(root) {
  const out = leaseRows(openDb(root));
  _leaseSeen.set(root, new Map(Object.entries(out).map(([k, l]) => [k, JSON.stringify(l)])));
  return out;
}
export class LeaseConflict extends Error {}
export function saveLeases(root, map) {
  const db = openDb(root);
  const seen = _leaseSeen.get(root) || new Map();
  db.exec('BEGIN IMMEDIATE');
  try {
    const disk = leaseRows(db);
    const ownerChanged = k => (seen.has(k) ? JSON.parse(seen.get(k)).run : null) !== (disk[k] ? disk[k].run : null);
    const ins = db.prepare('INSERT OR REPLACE INTO device_leases(udid, run, holder, platform, since, heartbeat, note, extra) VALUES (?,?,?,?,?,?,?,?)');
    const del = db.prepare('DELETE FROM device_leases WHERE udid = ?');
    for (const [udid, l] of Object.entries(map)) {
      if (seen.get(udid) === JSON.stringify(l)) continue;            // 没改：以库里为准
      if (ownerChanged(udid) && (!disk[udid] || String(disk[udid].run) !== String(l.run)))
        throw new LeaseConflict(`${udid} 的占用刚被别的进程改过（现在是 run=${disk[udid] ? disk[udid].run : '无'}）：重新看一眼再操作`);
      const { run, holder, platform, since, heartbeat, note, ...extra } = l;
      ins.run(udid, String(run), String(holder), platform || null, since, heartbeat || since, note || '', Object.keys(extra).length ? JSON.stringify(extra) : null);
    }
    for (const udid of seen.keys()) {
      if (udid in map || !disk[udid]) continue;
      if (ownerChanged(udid)) continue;                                // 读到之后已换了主人：那不是本进程要放的那条
      del.run(udid);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  loadLeases(root);   // 快照跟上库里现在的样子
}

// ---------- 审批记录（谁、何时、批准了什么、原话）----------
export function recordApproval(root, { kind, subject, by, quote, detail }) {
  openDb(root).prepare('INSERT INTO approvals(at, kind, subject, by, quote, detail) VALUES (?,?,?,?,?,?)')
    .run(new Date().toISOString(), kind, subject, by || null, quote || null, detail ? JSON.stringify(detail) : null);
}
export function listApprovals(root, subject) {
  const db = openDb(root);
  return subject ? db.prepare('SELECT * FROM approvals WHERE subject = ? ORDER BY id').all(subject)
                 : db.prepare('SELECT * FROM approvals ORDER BY id').all();
}

// ---------- 评价 / 建议（core/assess.mjs 的落库面）----------
// 同一 subject+phase 新评一次：旧的标 superseded_by。卡口只认「最新且 basis 等于当前指纹」的那条（latestAssessment 带 basis 过滤）。
export function saveAssessment(root, { subject_kind, subject_id, phase, rubric_version, by, basis, demand, score, gate, dims, items }) {
  const db = openDb(root);
  const at = new Date().toISOString();
  db.exec('BEGIN');
  try {
    const id = Number(db.prepare('INSERT INTO assessments(subject_kind, subject_id, phase, rubric_version, at, by, basis, demand, score, gate, dims) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(subject_kind, subject_id, phase, rubric_version, at, by, basis, demand || null, score, gate, JSON.stringify(dims)).lastInsertRowid);
    db.prepare('UPDATE assessments SET superseded_by = ? WHERE subject_kind = ? AND subject_id = ? AND phase = ? AND id <> ? AND superseded_by IS NULL').run(id, subject_kind, subject_id, phase, id);
    const ins = db.prepare('INSERT INTO assessment_items(assessment_id, dimension, rule, target, level, finding, evidence, fix, ikey) VALUES (?,?,?,?,?,?,?,?,?)');
    const out = items.map(i => ({ ...i, id: Number(ins.run(id, i.dimension, i.rule || null, i.at || null, i.level, i.finding || '', i.evidence || '', i.fix || '', i.ikey || null).lastInsertRowid) }));
    db.exec('COMMIT');
    return { id, at, items: out };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
export function latestAssessment(root, subject_kind, subject_id, phase, basis = null) {
  const db = openDb(root);
  const a = db.prepare('SELECT * FROM assessments WHERE subject_kind = ? AND subject_id = ? AND phase = ? AND superseded_by IS NULL ORDER BY id DESC LIMIT 1').get(subject_kind, subject_id, phase);
  if (!a) return null;
  const r = { ...a, dims: JSON.parse(a.dims), stale: basis != null && a.basis !== basis };
  r.items = db.prepare('SELECT * FROM assessment_items WHERE assessment_id = ? ORDER BY id').all(a.id);
  return r;
}
// ---- 用例评审 ----
export const getMeta = (root, k) => openDb(root).prepare('SELECT v FROM meta WHERE k = ?').get(k)?.v ?? null;
export const setMeta = (root, k, v) => openDb(root).prepare('INSERT OR REPLACE INTO meta(k, v) VALUES (?, ?)').run(k, String(v));
export function saveReviewCard(root, { id, demand, cases, items, canaries }) {
  openDb(root).prepare('INSERT OR REPLACE INTO review_cards(id, at, demand, cases, rubric_version, extractor_version, items, canaries) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, new Date().toISOString(), demand || null, JSON.stringify(cases), 2, 1, JSON.stringify(items), JSON.stringify(canaries || []));
}
export function getReviewCard(root, id) {
  const r = openDb(root).prepare('SELECT * FROM review_cards WHERE id = ?').get(id);
  return r ? { ...r, cases: JSON.parse(r.cases), items: JSON.parse(r.items), canaries: JSON.parse(r.canaries || '[]') } : null;
}
export const listCanaries = root => openDb(root).prepare('SELECT * FROM review_canaries ORDER BY id').all();
export const addCanary = (root, { dim, item, max_score, source, quote }) => Number(openDb(root).prepare('INSERT INTO review_canaries(dim, item, max_score, source, quote) VALUES (?,?,?,?,?)').run(dim, item, max_score, source || null, quote || null).lastInsertRowid);
/** 一次提交里一条用例通过核对的评审项 → assessments 一行（phase=review，不互相取代：每项按 ikey 取最新）+ 每项一行 */
export function saveReviewItems(root, { caseName, by, demand, card, rows, gate }) {
  const db = openDb(root), at = new Date().toISOString();
  db.exec('BEGIN');
  try {
    const id = Number(db.prepare('INSERT INTO assessments(subject_kind, subject_id, phase, rubric_version, at, by, basis, demand, score, gate, dims) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run('case', caseName, 'review', 2, at, by, card, demand || null, Math.min(3, ...rows.map(r => r.score)), gate || '', '{}').lastInsertRowid);
    const ins = db.prepare('INSERT INTO assessment_items(assessment_id, dimension, rule, target, level, finding, evidence, fix, ikey, score, cap, item_fp, facts, extract, rulings, card_id, reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const r of rows) ins.run(id, r.dim, null, r.at, r.score < 2 ? 'block' : r.score < 3 ? 'warn' : 'ok', r.reason || '', JSON.stringify(r.evidence || []), r.fix || '', r.key, r.score, r.cap, r.fp, JSON.stringify(r.evidence || []), JSON.stringify(r.extract || null), JSON.stringify(r.rulings || []), card, r.reason || '');
    db.exec('COMMIT');
    return id;
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
/** 一条用例每个评审项的最新记录：盲审和自评各取最新 → [{ ikey, score, item_fp, by, at, reason, fix, rulings }] */
export function latestReviewItems(root, caseName) {
  const rows = openDb(root).prepare('SELECT i.ikey, i.score, i.cap, i.item_fp, i.reason, i.fix, i.rulings, i.extract, i.dimension, i.card_id, a.by, a.at, i.id FROM assessment_items i JOIN assessments a ON a.id = i.assessment_id WHERE a.subject_kind = ? AND a.subject_id = ? AND a.phase = ? ORDER BY i.id DESC').all('case', caseName, 'review');
  const seen = new Set(), out = [];
  for (const r of rows) { const k = `${r.ikey}|${r.by === 'blind' ? 'b' : 's'}`; if (seen.has(k)) continue; seen.add(k);
    out.push({ ...r, by: r.by === 'blind' ? 'blind' : r.by, rulings: JSON.parse(r.rulings || '[]'), extract: JSON.parse(r.extract || 'null') }); }
  return out;
}
export const getSuggestion = (root, idOrKey) => openDb(root).prepare(typeof idOrKey === 'number' || /^\d+$/.test(String(idOrKey)) ? 'SELECT * FROM suggestions WHERE id = ?' : 'SELECT * FROM suggestions WHERE ikey = ?').get(idOrKey) || null;
export function upsertSuggestion(root, s) {
  const db = openDb(root);
  const old = db.prepare('SELECT * FROM suggestions WHERE ikey = ?').get(s.ikey);
  if (old) {
    // 同一个问题再次出现：沿用旧建议与它的决定（不重新问）；之前判成「已落地」的又冒出来 = 改回去了，重新打开
    const reopen = old.status === 'applied' || old.status === 'resolved';
    db.prepare('UPDATE suggestions SET last_item = ?, level = ?, text = ?, options = ?, consult = ?, status = ? WHERE id = ?')
      .run(s.item_id, s.level, s.text, JSON.stringify(s.options || []), s.consult ? JSON.stringify(s.consult) : null, reopen ? 'proposed' : old.status, old.id);
    return { ...old, id: old.id, reopened: reopen };
  }
  const id = Number(db.prepare(`INSERT INTO suggestions(ikey, subject_kind, subject_id, demand, first_item, last_item, dimension, level, kind, text, options, consult, status, proposed_at, needs_retro)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(s.ikey, s.subject_kind, s.subject_id, s.demand || null, s.item_id, s.item_id, s.dimension, s.level, s.kind || 'fix', s.text || '',
      JSON.stringify(s.options || []), s.consult ? JSON.stringify(s.consult) : null, 'proposed', new Date().toISOString(), s.needs_retro ? 1 : 0).lastInsertRowid);
  return { id, created: true };
}
/** 本次评价里不再出现的旧建议：采纳过的 → applied；没决定就被改掉的 → resolved（都记 applied_ref = 新评价的 basis） */
export function settleMissingSuggestions(root, subject_kind, subject_id, keysNow, ref) {
  const db = openDb(root);
  const at = new Date().toISOString();
  const rows = db.prepare("SELECT * FROM suggestions WHERE subject_kind = ? AND subject_id = ? AND status IN ('proposed','adopted')").all(subject_kind, subject_id);
  const done = [];
  for (const r of rows) if (!keysNow.has(r.ikey)) {
    const st = r.status === 'adopted' ? 'applied' : 'resolved';
    db.prepare('UPDATE suggestions SET status = ?, applied_ref = ?, applied_at = ? WHERE id = ?').run(st, ref, at, r.id);
    done.push({ ...r, status: st });
  }
  return done;
}
export function decideSuggestion(root, id, { status, by, quote, retro }) {
  openDb(root).prepare('UPDATE suggestions SET status = ?, decided_by = ?, quote = ?, decided_at = ?, retro = COALESCE(?, retro) WHERE id = ?')
    .run(status, by, quote, new Date().toISOString(), retro || null, id);
  return getSuggestion(root, id);
}
export const setSuggestionRetro = (root, id, retro) => openDb(root).prepare('UPDATE suggestions SET retro = ? WHERE id = ?').run(retro, id);
export function listSuggestions(root, { demand, subject_id, status } = {}) {
  const w = [], a = [];
  if (demand) { w.push('demand = ?'); a.push(demand); }
  if (subject_id) { w.push('subject_id = ?'); a.push(subject_id); }
  if (status) { const ss = [].concat(status); w.push(`status IN (${ss.map(() => '?').join(',')})`); a.push(...ss); }
  return openDb(root).prepare(`SELECT * FROM suggestions ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY id`).all(...a);
}

// ---------- 验收循环绑定 ----------
// 宿主的停止钩子要知道「这个会话在推进哪个需求」才能跑 next（core/hooks.mjs loop_next）。
// key = 会话 id（Claude Code 的 CLAUDE_CODE_SESSION_ID、Gemini 的 GEMINI_SESSION_ID，与钩子输入里的 session_id 同一个值），拿不到时退回 cwd:<目录>。
// 只由 acceptkit loop start / stop 写；没绑定的会话钩子一律放行 —— 别的会话、只是来问一句的会话都不受影响。
export function bindLoop(root, key, demand, cwd = null) {
  openDb(root).prepare('INSERT INTO loop_bindings(key, demand, at, cwd) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET demand=excluded.demand, at=excluded.at, cwd=excluded.cwd').run(key, demand, new Date().toISOString(), cwd);
}
export const unbindLoop = (root, key) => openDb(root).prepare('DELETE FROM loop_bindings WHERE key = ?').run(key).changes > 0;
export const loopBinding = (root, key) => openDb(root).prepare('SELECT * FROM loop_bindings WHERE key = ?').get(key) || null;
// 执行者还有活却自己 loop stop：记下谁、何时、为什么、还剩几件。看板上「没人在跑」时把这条摆出来，owner 才知道是谁停的、为什么停
export function recordLoopStop(root, demand, rec) {
  openDb(root).prepare('INSERT OR REPLACE INTO meta(k, v) VALUES (?, ?)').run(`loop_stop:${demand}`, JSON.stringify({ ...rec, at: new Date().toISOString() }));
}
export function lastLoopStop(root, demand) {
  const v = openDb(root).prepare('SELECT v FROM meta WHERE k = ?').get(`loop_stop:${demand}`)?.v;
  try { return v ? JSON.parse(v) : null; } catch { return null; }
}
export const listLoopBindings = root => openDb(root).prepare('SELECT * FROM loop_bindings ORDER BY at DESC').all();

// ---------- 用例质量基线 ----------
// 引入质量标准时已存在的用例：当时就有的问题记为质量债，只提示不拦（新增 / 改出来的问题才拦）。
// meta.quality_baseline_at 标记「已登记过」；没登记过的项目（有存量用例却没跑 doctor --fix）只提示不拦，免得一升级就把存量全卡住。
export function loadQualityBaseline(root) {
  const db = openDb(root);
  const at = db.prepare("SELECT v FROM meta WHERE k = 'quality_baseline_at'").get()?.v || null;
  const map = Object.fromEntries(db.prepare('SELECT case_id, keys FROM quality_baseline').all().map(r => [r.case_id, { keys: JSON.parse(r.keys) }]));
  return { initialized: !!at, at, map };
}
export function saveQualityBaseline(root, entries) {
  const db = openDb(root); const at = new Date().toISOString();
  db.exec('BEGIN');
  try {
    const ins = db.prepare('INSERT OR REPLACE INTO quality_baseline(case_id, at, keys) VALUES (?,?,?)');
    for (const [id, keys] of Object.entries(entries)) ins.run(id, at, JSON.stringify(keys));
    db.prepare("INSERT OR REPLACE INTO meta(k, v) VALUES ('quality_baseline_at', ?)").run(at);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return at;
}

// ---------- 环境快照 ----------
export function saveSnapshot(root, snap) {
  const id = `${snap.at.replace(/[-:.]/g, '').slice(0, 15)}-${createHash('sha1').update(JSON.stringify(snap.facts)).digest('hex').slice(0, 6)}`;
  openDb(root).prepare('INSERT OR REPLACE INTO env_snapshots(id, at, target, platform, facts) VALUES (?,?,?,?,?)')
    .run(id, snap.at, snap.target || null, snap.platform || null, JSON.stringify(snap.facts));
  return id;
}

// ---------- 派生索引 ----------
const sha = buf => createHash('sha1').update(buf).digest('hex');
function walkTree(nodes, cb, prefix = 'n', path = []) {
  (nodes || []).forEach((n, i) => { const id = `${prefix}${i + 1}`; const p = [...path, n.op]; cb(n, id, p); walkTree(n.children, cb, `${id}.`, p); });
}

/** 按文件哈希增量重建索引。返回 { scanned, changed, removed }。 */
export function rebuildIndex(root, { full = false } = {}) {
  const db = openDb(root);
  if (full) db.exec('DELETE FROM idx_files; DELETE FROM cases; DELETE FROM expects; DELETE FROM runs; DELETE FROM verdicts; DELETE FROM plans;');
  const seen = new Set(); let changed = 0;
  const known = new Map(db.prepare('SELECT path, sha, mtime FROM idx_files').all().map(r => [r.path, r]));
  const touch = (rel, kind, fn) => {
    const abs = join(root, rel);
    let st; try { st = statSync(abs); } catch { return; }
    seen.add(rel);
    const k = known.get(rel);
    if (k && k.mtime === st.mtimeMs) return;
    const buf = readFileSync(abs);
    const h = sha(buf);
    if (k && k.sha === h) { db.prepare('UPDATE idx_files SET mtime=? WHERE path=?').run(st.mtimeMs, rel); return; }
    let doc; try { doc = JSON.parse(buf.toString('utf8')); } catch { return; }
    fn(doc, rel);
    db.prepare('INSERT OR REPLACE INTO idx_files(path, sha, kind, mtime) VALUES (?,?,?,?)').run(rel, h, kind, st.mtimeMs);
    changed++;
  };
  db.exec('BEGIN');
  try {
    const casesDir = join(root, 'cases');
    if (existsSync(casesDir)) for (const f of readdirSync(casesDir).filter(x => x.endsWith('.case.json'))) {
      touch(`cases/${f}`, 'case', (c, rel) => {
        db.prepare('DELETE FROM expects WHERE case_id=?').run(c.case);
        let nodes = 0, exps = 0;
        const insE = db.prepare('INSERT OR REPLACE INTO expects(case_id, id, assert, has_observe, op, applies, path) VALUES (?,?,?,?,?,?,?)');
        walkTree(c.tree, (n, nid, p) => { nodes++; for (const e of n.expect || []) { exps++; insE.run(c.case, String(e.id), String(e.assert || ''), e.observe ? 1 : 0, e.observe?.op || null, JSON.stringify(e.applies || n.applies || null), p.join(' → ')); } });
        db.prepare('INSERT OR REPLACE INTO cases(id, title, platform, host, kind, origin, nodes, expects, path, doc) VALUES (?,?,?,?,?,?,?,?,?,?)')
          .run(c.case, c.title || '', [].concat(c.platform || []).join(',') || null,   // 多平台用例的 platform 是数组（engine.mjs 收两种）
                typeof c.host === 'string' ? c.host : null, c.kind || 'acceptance', c.origin?.id || null, nodes, exps, rel, JSON.stringify(c));
      });
    }
    const runsDir = join(root, 'runs');
    if (existsSync(runsDir)) for (const d of readdirSync(runsDir)) {
      touch(`runs/${d}/result.json`, 'run', (r, rel) => {
        db.prepare('DELETE FROM verdicts WHERE run=?').run(r.run || d);
        db.prepare('INSERT OR REPLACE INTO runs(id, case_id, run_seq, prev_run, session, demand, platform, device, verdict, build, superseded_by, path) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(r.run || d, r.case || null, r.run_seq ?? null, r.prev_run || null, typeof r.session === 'string' ? r.session : null,
               r.demand?.id || (typeof r.demand === 'string' ? r.demand : null), r.platform || null, r.device?.udid || null,
               r.verdict || r.status || null, r.meta?.build ? JSON.stringify(r.meta.build) : null, r.superseded_by || null, rel);
        const insV = db.prepare('INSERT OR REPLACE INTO verdicts(run, expect, status, blocked_kind, observed_op, strength, evidence_n, actual) VALUES (?,?,?,?,?,?,?,?)');
        for (const [id, v] of Object.entries(r.results || {})) insV.run(r.run || d, id, v.status || 'todo', v.blocked_kind || null, v.observed?.op || null, v.observed?.strength || null, (v.evidence || []).length, String(v.actual || '').slice(0, 2000));
      });
    }
    const plansDir = join(root, 'state', 'plans');
    if (existsSync(plansDir)) for (const f of readdirSync(plansDir).filter(x => x.endsWith('.json'))) {
      touch(`state/plans/${f}`, 'plan', (p) => {
        const cs = new Set(); for (const s of p.surfaces || []) for (const k of ['reuse', 'new']) for (const c of s[k] || []) cs.add(c);
        db.prepare('INSERT OR REPLACE INTO plans(demand, title, platform, revision, approved_at, approved_by, cases) VALUES (?,?,?,?,?,?,?)')
          .run(p.demand, p.title || '', p.platform || null, p.revision ?? null, p.approved_at || null, p.approved_by || null, JSON.stringify([...cs]));
      });
    }
    // 文件被删 → 索引里的行一并删
    let removed = 0;
    for (const [rel, k] of known) {
      if (seen.has(rel)) continue;
      removed++;
      db.prepare('DELETE FROM idx_files WHERE path=?').run(rel);
      if (k.kind === 'case') { const id = rel.replace(/^cases\//, '').replace(/\.case\.json$/, ''); db.prepare('DELETE FROM cases WHERE id=?').run(id); db.prepare('DELETE FROM expects WHERE case_id=?').run(id); }
      if (k.kind === 'run') { const id = rel.split('/')[1]; db.prepare('DELETE FROM runs WHERE id=?').run(id); db.prepare('DELETE FROM verdicts WHERE run=?').run(id); }
      if (k.kind === 'plan') db.prepare('DELETE FROM plans WHERE demand=?').run(rel.replace(/^state\/plans\//, '').replace(/\.json$/, ''));
    }
    db.exec('COMMIT');
    return { scanned: seen.size, changed, removed };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function query(root, sql, params = []) {
  const db = openDb(root);
  if (!/^\s*(select|with|pragma)\b/i.test(sql)) throw new Error('query 只允许只读语句（SELECT / WITH / PRAGMA）');
  return db.prepare(sql).all(...params);
}

/** 校验索引与文件一致：条数守恒 + 每个文件哈希一致。 */
export function verifyIndex(root) {
  const db = openDb(root);
  const problems = [];
  for (const r of db.prepare('SELECT path, sha FROM idx_files').all()) {
    let buf; try { buf = readFileSync(join(root, r.path)); } catch { problems.push(`索引里有、盘上没有：${r.path}`); continue; }
    if (sha(buf) !== r.sha) problems.push(`哈希不一致（文件改过还没重建索引）：${r.path}`);
  }
  const count = (q) => db.prepare(q).get().n;
  const caseFiles = existsSync(join(root, 'cases')) ? readdirSync(join(root, 'cases')).filter(x => x.endsWith('.case.json')).length : 0;
  const runFiles = existsSync(join(root, 'runs')) ? readdirSync(join(root, 'runs')).filter(d => existsSync(join(root, 'runs', d, 'result.json'))).length : 0;
  const nc = count("SELECT count(*) n FROM idx_files WHERE kind='case'"), nr = count("SELECT count(*) n FROM idx_files WHERE kind='run'");
  if (nc !== caseFiles) problems.push(`用例文件 ${caseFiles} 个，索引 ${nc} 个（有文件不是合法 JSON？）`);
  if (nr !== runFiles) problems.push(`运行结果 ${runFiles} 个，索引 ${nr} 个`);
  return { ok: !problems.length, problems, counts: { cases: nc, runs: nr, verdicts: count('SELECT count(*) n FROM verdicts'), expects: count('SELECT count(*) n FROM expects') } };
}
