// 冷启动与资产入口的几条命令：sut（被测物标识）、import（导入旧用例）、select（推荐可复用的用例）、env 快照。
// 都只读写项目目录与 SQLite，不调模型。
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { scopesOf, parseBuild, judge } from './version-scope.mjs';
import { applicability } from './platform.mjs';
import { mask } from './secrets.mjs';

const sh = (bin, args, o = {}) => spawnSync(bin, args, { encoding: 'utf8', timeout: 20_000, ...o });
const git = (p, args) => { const r = sh('git', ['-C', p, ...args]); return r.status === 0 ? r.stdout.trim() : null; };

// ---------------- sut：被测物标识 ----------------
// 写 runs/<run>/evidence/provenance.json。结构与回合（rounds）读取的一致：repos.<名>.{path, branch, commit, …}。
// 只记录取得到的事实；取不到的写明原因，不猜。
export function sut(root, { run, target, repos = [], app, device, url }) {
  const dir = join(root, 'runs', run);
  if (!existsSync(join(dir, 'result.json'))) throw new Error(`run 不存在：${run}`);
  const out = { run, target: target || null, at: new Date().toISOString(), repos: {}, notes: [] };
  for (const spec of repos) {
    const i = spec.indexOf('='); if (i < 0) throw new Error(`--repo 要写成 名字=路径：${spec}`);
    const name = spec.slice(0, i), path = spec.slice(i + 1);
    const commit = git(path, ['rev-parse', 'HEAD']);
    if (!commit) { out.repos[name] = { path, error: '不是 git 仓库或无法读取，钉不住 commit' }; continue; }
    const dirty = (git(path, ['status', '--porcelain', '--untracked-files=no']) || '').split('\n').filter(Boolean);
    out.repos[name] = { path, branch: git(path, ['rev-parse', '--abbrev-ref', 'HEAD']), commit, commit_short: commit.slice(0, 12),
      subject: git(path, ['log', '-1', '--format=%s']), committed_at: git(path, ['log', '-1', '--format=%cI']), dirty_files: dirty.length,
      ...(dirty.length ? { dirty_list: dirty.slice(0, 30), warning: '工作区有未提交改动 —— 结论对应 commit + 这些改动' } : {}) };
  }
  if (app && device) {
    if (/^[0-9A-F-]{36}$/i.test(device)) {
      const c = sh('xcrun', ['simctl', 'get_app_container', device, app]);
      if (c.status === 0) {
        const plist = join(c.stdout.trim(), 'Info.plist');
        const rd = k => { const r = sh('/usr/libexec/PlistBuddy', ['-c', `Print :${k}`, plist]); return r.status === 0 ? r.stdout.trim() : null; };
        out.app = { platform: 'ios', device, bundle: app, version: rd('CFBundleShortVersionString'), build: rd('CFBundleVersion') };
      } else out.app = { platform: 'ios', device, bundle: app, error: '设备上没有装这个 App（或设备没启动）' };
    } else {
      const adb = process.env.ANDROID_HOME ? join(process.env.ANDROID_HOME, 'platform-tools', 'adb') : 'adb';
      const r = sh(adb, ['-s', device, 'shell', 'dumpsys', 'package', app]);
      const pick = re => (r.stdout || '').match(re)?.[1] || null;
      out.app = r.status === 0 && /versionName/.test(r.stdout || '')
        ? { platform: 'android', device, package: app, version: pick(/versionName=(\S+)/), version_code: pick(/versionCode=(\d+)/), last_update: pick(/lastUpdateTime=([^\n]+)/) }
        : { platform: 'android', device, package: app, error: '设备上没有装这个包（或设备没连上）' };
    }
  }
  if (url) out.web = { url };
  mkdirSync(join(dir, 'evidence'), { recursive: true });
  const f = join(dir, 'evidence', 'provenance.json');
  writeFileSync(f, JSON.stringify(out, null, 2));
  return { file: f, out };
}

// ---------------- import：旧用例导入 ----------------
// CSV（首行表头，认「步骤/操作/step」「预期/期望/expected」「模块/module」）或 Markdown（`- 步骤 → 预期` / `- 步骤 | 预期`）。
// 一行旧用例 = 一个操作节点 + 一条断言。条数守恒：导入多少行就有多少条断言。
// 「显示正常」「无异常」这类判定不了的预期原样保留，标记出来让人逐条澄清 —— 不替它编判定标准。
const VAGUE = /^(显示)?正常$|无异常|没有异常|显示正确|功能正常|符合预期|^ok$|^pass$|正常显示/i;

function parseCSV(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; continue; }
    if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); if (row.some(c => c.trim())) rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  row.push(cur); if (row.some(c => c.trim())) rows.push(row);
  return rows;
}

export function importCases(root, { file, caseId, platform, title }) {
  const ext = extname(file).toLowerCase();
  const text = readFileSync(file, 'utf8').replace(/^﻿/, '');
  const items = [];
  if (ext === '.csv') {
    const rows = parseCSV(text);
    const head = rows.shift().map(h => h.trim().toLowerCase());
    const col = re => head.findIndex(h => re.test(h));
    const ci = { mod: col(/模块|module/), step: col(/步骤|操作|step|action/), exp: col(/预期|期望|expect/) };
    if (ci.step < 0 || ci.exp < 0) throw new Error(`表头里找不到「步骤」和「预期」列（现有：${head.join(' / ')}）`);
    rows.forEach((r, i) => items.push({ line: i + 2, module: ci.mod >= 0 ? (r[ci.mod] || '').trim() : '', step: (r[ci.step] || '').trim(), expect: (r[ci.exp] || '').trim() }));
  } else if (ext === '.md' || ext === '.markdown') {
    let module = '';
    text.split('\n').forEach((l, i) => {
      const h = l.match(/^#{1,6}\s+(.*)/); if (h) { module = h[1].trim(); return; }
      const m = l.match(/^\s*[-*]\s+(.+?)\s*(→|->|\|)\s*(.+)$/);
      if (m) items.push({ line: i + 1, module, step: m[1].trim(), expect: m[3].trim() });
    });
  } else throw new Error('只支持 .csv 与 .md（Excel 先另存为 CSV）');
  if (!items.length) throw new Error('没有解析出任何用例行');
  const vague = [], empty = [];
  const tree = items.map((it, i) => {
    const id = `I${i + 1}`;
    if (!it.expect) empty.push(id); else if (VAGUE.test(it.expect)) vague.push(id);
    return { op: it.step || `（第 ${it.line} 行没有写步骤）`, ...(it.module ? { tags: { module: it.module } } : {}),
      expect: [{ id, assert: it.expect || '（原用例没有写预期）', source: { file: basename(file), line: it.line },
        ...(it.expect && !VAGUE.test(it.expect) ? {} : { needs_clarify: true }) }] };
  });
  const modules = [...new Set(items.map(x => x.module).filter(Boolean))];
  const c = { case: caseId, title: title || `导入自 ${basename(file)}`, platform, kind: 'acceptance',
    origin: { id: `import:${basename(file)}`, title: `导入 ${items.length} 条` },
    classifications: modules.length ? { module: modules } : {}, tree };
  mkdirSync(join(root, 'cases'), { recursive: true });
  const out = join(root, 'cases', `${caseId}.case.json`);
  if (existsSync(out)) throw new Error(`已存在：${out}`);
  writeFileSync(out, JSON.stringify(c, null, 2) + '\n');
  return { file: out, rows: items.length, asserts: tree.length, vague, empty };
}

// ---------------- select：推荐可复用的用例 ----------------
// 按平台适用性、改动面（节点 tags.surface / 用例 origin）、断言适用版本范围（applies）筛；每条入选/排除都给理由。
export function selectCases(root, { platform, surface, build, loadOps, config = null }) {
  const b = build ? parseBuild(build) : {};
  const ops = loadOps();
  const keep = [], drop = [];
  for (const f of readdirSync(join(root, 'cases')).filter(x => x.endsWith('.case.json')).sort()) {
    let c; try { c = JSON.parse(readFileSync(join(root, 'cases', f), 'utf8')); } catch { drop.push({ case: f, why: '用例文件不是合法 JSON' }); continue; }
    const ap = applicability(c, ops, config);
    if (platform && !ap[platform]?.ok) {
      drop.push({ case: c.case, why: !ap[platform]?.declared ? `没有声明适用 ${platform}` : `在 ${platform} 侧缺操作配方：${ap[platform].missing.join(' ')}` });
      continue;
    }
    const surfaces = new Set();
    const walk = ns => (ns || []).forEach(n => { if (n.tags?.surface) surfaces.add(String(n.tags.surface)); walk(n.children); });
    walk(c.tree);
    if (surface && !surfaces.has(surface)) { drop.push({ case: c.case, why: `改动面不相交（用例覆盖：${[...surfaces].join(' / ') || '未标改动面'}）` }); continue; }
    const scopes = Object.entries(scopesOf(c.tree));
    const na = scopes.filter(([, sc]) => judge(sc, b).state === 'na').map(([id]) => id);
    const unknown = scopes.filter(([, sc]) => judge(sc, b).state === 'unknown').map(([id]) => id);
    const total = (() => { let n = 0; const w = ns => (ns || []).forEach(x => { n += (x.expect || []).length; w(x.children); }); w(c.tree); return n; })();
    if (total && na.length === total) { drop.push({ case: c.case, why: `全部 ${total} 条断言在该版本上不适用（applies）` }); continue; }
    keep.push({ case: c.case, title: c.title || '', why: [platform ? `适用 ${platform}` : null, surface ? `覆盖改动面 ${surface}` : null,
      na.length ? `${na.length} 条断言在该版本上不适用、会自动记 na` : null, unknown.length ? `${unknown.length} 条断言的适用范围要看版本，没给 --build` : null].filter(Boolean).join('；') || '无筛选条件' });
  }
  return { keep, drop };
}

export function maskOut(root, s) { return mask(root, s); }
