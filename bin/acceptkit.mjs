#!/usr/bin/env node
// acceptkit CLI 入口。冷启动、知识、索引这类命令在这里；用例 / 运行 / 证据 / 评审单等交给引擎（core/engine.mjs）。
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, chmodSync, statSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { REPO_ROOT, CONFIG_NAME, USER_CONFIG, resolveProjectRoot, readConfig, readUserConfig, loadProject } from '../core/project.mjs';
import { loadOps } from '../core/ops.mjs';

const VERSION = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version;
const argv = process.argv;
// `acceptkit --project <dir> <命令>`：先把 --project 挪到后面，否则它会被当成命令名
if (argv[2] === '--project') argv.push(...argv.splice(2, 2));
const cmd = argv[2];
const sub = argv[3];
const flags = (from) => {
  const pos = [], opt = {};
  for (let i = from; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); const v = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true; opt[k] = opt[k] === undefined ? v : [].concat(opt[k], v); }
    else pos.push(a);
  }
  return { pos, opt };
};
const die = m => { console.error('acceptkit: ' + m); process.exit(1); };
const sh = (bin, args, o = {}) => spawnSync(bin, args, { encoding: 'utf8', timeout: 20_000, ...o });
const have = bin => sh('/bin/sh', ['-c', `command -v ${bin}`]).status === 0;
const adbBin = () => {
  const home = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || join(process.env.HOME || '', 'Library', 'Android', 'sdk');
  const p = join(home, 'platform-tools', 'adb');
  return existsSync(p) ? p : (have('adb') ? 'adb' : null);
};
async function needProject() {
  const p = await loadProject();
  if (!p.root) die('找不到项目 —— acceptkit project init <dir> 新建，或 --project <dir> / ACCEPTKIT_PROJECT 指定');
  return p;
}

// ---------------- env：检查本机环境（不需要项目） ----------------
function detectEnv() {
  const facts = { at: new Date().toISOString(), node: process.version, os: `${process.platform} ${process.arch}`, cwd: process.cwd() };
  facts.project_marker = existsSync(join(process.cwd(), CONFIG_NAME)) ? join(process.cwd(), CONFIG_NAME) : null;
  facts.git_repo = sh('git', ['rev-parse', '--show-toplevel'], { cwd: process.cwd() }).stdout?.trim() || null;
  // iOS 模拟器
  facts.ios = { available: false };
  if (process.platform === 'darwin' && have('xcrun')) {
    const x = sh('xcrun', ['simctl', 'list', 'devices', '-j']);
    if (x.status === 0) {
      const j = JSON.parse(x.stdout);
      const devs = Object.entries(j.devices || {}).flatMap(([rt, ds]) => ds.filter(d => d.isAvailable).map(d => ({ udid: d.udid, name: d.name, state: d.state, runtime: rt.replace(/^.*SimRuntime\./, '') })));
      facts.ios = { available: true, xcode: sh('xcodebuild', ['-version']).stdout?.split('\n')[0] || null, simulators: devs };
    } else facts.ios = { available: false, reason: 'xcrun simctl 不可用（没装 Xcode？）' };
  } else facts.ios = { available: false, reason: process.platform === 'darwin' ? '没有 xcrun（没装 Xcode 命令行工具）' : 'iOS 模拟器只能在 macOS 上运行' };
  // Android
  const adb = adbBin();
  facts.android = { available: !!adb };
  if (adb) {
    const x = sh(adb, ['devices', '-l']);
    facts.android.devices = (x.stdout || '').split('\n').slice(1).map(l => l.trim()).filter(Boolean).map(l => {
      const [serial, state, ...rest] = l.split(/\s+/);
      return { serial, state, kind: /^emulator-/.test(serial) ? 'emulator' : 'device', info: rest.join(' ') };
    });
    const emu = join(adb, '..', '..', 'emulator', 'emulator');
    if (existsSync(emu)) facts.android.avds = (sh(emu, ['-list-avds']).stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
  } else facts.android.reason = '没找到 adb（装 Android SDK platform-tools，或设 ANDROID_HOME）';
  // 浏览器
  const chrome = process.env.CHROME_BIN || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome');
  facts.web = { chrome: existsSync(chrome) || have(chrome) ? chrome : null };
  // OCR
  facts.ocr = process.platform === 'darwin' ? (have('swiftc') ? 'macOS Vision（首次使用时编译）' : '缺 swiftc，内置 OCR 不可用') : (have('tesseract') ? 'tesseract' : '无（可装 tesseract，或由项目 pack.ocr 提供）');
  return facts;
}
function printEnv(f) {
  console.log(`本机环境 · ${f.at}\n  Node ${f.node} · ${f.os}\n  启动目录 ${f.cwd}${f.git_repo ? `（git 仓库 ${f.git_repo}）` : ''}${f.project_marker ? '\n  ✓ 这里是一个 acceptkit 项目' : ''}`);
  if (f.ios.available) {
    const booted = f.ios.simulators.filter(d => d.state === 'Booted');
    console.log(`  ✓ iOS 模拟器：${f.ios.simulators.length} 台可用，运行中 ${booted.length} 台${f.ios.xcode ? ` · ${f.ios.xcode}` : ''}`);
    for (const d of booted) console.log(`      ${d.udid} ${d.name} (${d.runtime})`);
  } else console.log(`  ✗ iOS：${f.ios.reason}`);
  if (f.android.available) {
    console.log(`  ✓ Android：已连接 ${f.android.devices.length} 台${f.android.avds ? ` · 可启动的模拟器 ${f.android.avds.join(', ') || '无'}` : ''}`);
    for (const d of f.android.devices) console.log(`      ${d.serial} ${d.state} ${d.kind}${d.kind === 'device' ? '（真机：默认不在上面操作，除非你明确要求）' : ''}`);
  } else console.log(`  ✗ Android：${f.android.reason}`);
  console.log(f.web.chrome ? `  ✓ 浏览器：${f.web.chrome}` : '  ✗ 浏览器：没找到 Chrome（设 CHROME_BIN）');
  console.log(`  · 截图文字识别：${f.ocr}`);
}

// ---------------- project ----------------
async function projectInit({ pos, opt }) {
  const dir = resolve(pos[0] || process.cwd());
  const f = join(dir, CONFIG_NAME);
  if (existsSync(f) && !opt.force) die(`${f} 已存在`);
  mkdirSync(dir, { recursive: true });
  for (const d of ['cases', 'runs', 'state', 'knowledge']) mkdirSync(join(dir, d), { recursive: true });
  const cfg = { name: String(opt.name || basename(dir)), gate: { label: '目标闸', allow: [] }, hosts: {} };
  writeFileSync(f, JSON.stringify(cfg, null, 2) + '\n');
  const k = join(dir, 'knowledge', 'project.md');
  if (!existsSync(k)) { writeFileSync(k, `# ${cfg.name}\n\n- 被测对象：（待确认）#推测\n`); chmodSync(k, 0o600); }
  // 新项目没有存量用例：质量基线登记为空，之后每条用例都按标准拦
  const db = await import('../core/store/db.mjs'); db.saveQualityBaseline(dir, {});
  rememberProject(dir);   // 管理页面（acceptkit serve）上列出它
  console.log(`✓ 新建项目 ${dir}\n  配置：${f}\n  下一步：
    被测 App（可以有多个）：acceptkit host add <宿主> --platform ios --bundle <bundle id>（或 --platform android --package / --platform web --port）
    构建做法：acceptkit setting set build --platform P --host <宿主> --run "<命令>"，或借鉴别的 App：acceptkit setting borrow build --platform P --host <宿主> --from [<项目目录>:]<宿主>
    允许操作的目标：acceptkit config add gate.allow <设备号|包名|租户号> --kind device|bundle|tenant --note "…"
    测试账号：acceptkit account set <id> --login … --field 字段=值 --by <谁给的>（只存在这台机器上，机密字段自动遮蔽）`);
}

// 不在项目目录里启动时用哪个项目（~/.config/acceptkit/config.json 的 defaultProject）
function projectUse({ pos }) {
  const dir = resolve(pos[0] || die('用法：acceptkit project use <项目目录>'));
  if (!existsSync(join(dir, CONFIG_NAME))) die(`${dir} 不是项目（没有 ${CONFIG_NAME}）`);
  const u = readUserConfig();
  mkdirSync(join(USER_CONFIG, '..'), { recursive: true });
  writeFileSync(USER_CONFIG, JSON.stringify({ ...u, defaultProject: dir, projects: [...new Set([...(u.projects || []), dir])] }, null, 2) + '\n');
  console.log(`✓ 缺省项目 → ${dir}（${USER_CONFIG}）`);
}

// ---------------- doctor ----------------
async function doctor({ opt }) {
  const problems = []; const ok = (m) => console.log(`  ✓ ${m}`); const bad = (m, fix) => { problems.push(m); console.log(`  ✗ ${m}${fix ? `\n      修法：${fix}` : ''}`); };
  console.log('acceptkit doctor');
  const major = Number(process.version.slice(1).split('.')[0]);
  major >= 22 ? ok(`Node ${process.version}`) : bad(`Node ${process.version} 太旧`, '需要 Node 22+');
  const { root, via } = resolveProjectRoot({ argv: [...argv] });
  if (!root) { bad('没有找到项目', 'acceptkit project init <dir>'); return finish(); }
  ok(`项目 ${root}（来自 ${via}）`);
  let cfg; try { cfg = readConfig(root); cfg._missing ? bad(`缺 ${CONFIG_NAME}`, 'acceptkit project init') : ok('项目配置可读'); } catch (e) { bad(e.message); return finish(); }
  const P = await loadProject();
  ok(P.pack._none ? '没有项目扩展钩子（pack.mjs），走内置通用路径' : `项目扩展钩子已加载：${Object.keys(P.pack).filter(k => !k.startsWith('_')).join(', ')}`);
  (cfg.gate?.allow || []).length ? ok(`目标闸白名单 ${cfg.gate.allow.length} 条`) : bad('目标闸白名单为空：所有会改被测端状态的动作都会被拒绝', 'acceptkit config add gate.allow <设备号|包名|租户号> --kind … --note …');
  if (!cfg._missing) {
    const C = await import('../core/config-edit.mjs');
    if (opt.fix) {
      const m = C.migrateAppToHosts(root, loadAllCases(root).flatMap(c => (c.host && typeof c.host === 'object') ? Object.values(c.host) : c.host ? [c.host] : []));
      if (m?.migrated) { ok(`被测 App 旧写法 app → hosts.${m.migrated}`); cfg = readConfig(root); }
      if (m?.refused) bad(`被测 App 旧写法 app 没有迁移：${m.refused}`, 'acceptkit host add <宿主> --platform P …（每个 App 一条），再 acceptkit config unset app');
      const S = await import('../core/settings.mjs');
      for (const x of S.migrateSettings(root, cfg)) x.to ? ok(`设置 ${x.from} → ${x.to}`) : bad(`设置 ${x.from} 没有迁移：${x.refused}`, 'mv 到 knowledge/settings/<平台>/<宿主>/，或 acceptkit setting set … --host <宿主>');
    }
    const probs = C.projectConfigProblems(root);
    const blocks = probs.filter(x => x.level === 'block');
    for (const x of blocks) bad(`配置 ${x.key} ${x.msg}（这一项会静默失效）`, 'acceptkit config set|add …');
    for (const x of probs.filter(x => x.level === 'warn')) console.log(`  · 配置 ${x.key} ${x.msg}`);
    if (!blocks.length) ok('项目配置各项合法');
    // 卸载 / 清数据的理由逐条点名：登记的人看得到哪几条已过质量检查（写全、情况具体、证据特征不是什么都匹配）
    const rs = cfg.gate?.reasons || [];
    if (rs.length) for (const [i, r] of rs.entries()) { const p = blocks.find(x => x.key === 'gate.reasons' && x.msg.startsWith(`第 ${i + 1} 项`)); if (!p) ok(`卸载 / 清数据理由 ${r.id}（${(r.actions || []).join(' / ')}${r.evidence ? '，要现场证据' : '，只靠现场说明'}）：写全、情况具体${r.evidence ? '、证据特征有区分度' : ''}`); }
  }
  {
    const O = await import('../core/ops.mjs');
    if (existsSync(O.opsPath(root))) {
      const hostIds = Object.keys(cfg.hosts || {});
      if (opt.fix) { const n = O.migrateRegistry(root, hostIds); if (n) ok(`操作库旧写法已迁移 ${n} 处（absent 原因 → blocker、tested → verified、平台_宿主 → 平台@宿主、补 state）`); }
      const probs = O.registryProblems(root, hostIds);
      const blocks = probs.filter(x => x.level === 'block');
      if (probs.some(x => /缺 state/.test(x.msg)) && !opt.fix) bad('操作库有配方没写状态（推测 / 已确认 / 已验证）', 'acceptkit doctor --fix');
      for (const x of blocks) bad(`操作库 ${x.id}${x.platform ? ` [${x.platform}]` : ''} ${x.msg}`, `acceptkit ops set ${x.id} …`);
      const warns = probs.filter(x => x.level === 'warn' && !/缺 state/.test(x.msg)).length;
      if (!blocks.length) ok(`操作库 ${Object.keys(O.loadOps(root)).length} 条结构合法${warns ? `（${warns} 处字段读的一方不认识：acceptkit ops check）` : ''}`);
    }
  }
  const { permissionProblems } = await import('../core/knowledge.mjs');
  const perm = permissionProblems(root);
  if (perm.length) {
    if (opt.fix) { for (const p of perm) chmodSync(p.file, 0o600); ok(`已把 ${perm.length} 份知识文件权限收紧到 600`); }
    else bad(`${perm.length} 份知识文件对他人可读（知识里可能有账号）`, 'acceptkit doctor --fix');
  } else ok('知识文件权限正常');
  // 旧版迁移把没有记录的需求首轮开轮时间写成了 1970-01-01（看板上就这么显示）
  {
    const R = await import('../core/rounds.mjs');
    if (opt.fix) { const f = R.fixEpochRounds(root); if (f.length) ok(`首轮开轮时间修正 ${f.length} 个需求：${f.join('，')}`); }
    else if (existsSync(join(root, 'state', 'rounds')) && readdirSync(join(root, 'state', 'rounds')).some(f => /"opened_at":\s*"1970-01-01/.test(readFileSync(join(root, 'state', 'rounds', f), 'utf8'))))
      bad('有需求的首轮开轮时间是 1970-01-01（旧版迁移留下的）', 'acceptkit doctor --fix');
  }
  {
    const S = await import('../core/settings.mjs');
    if (!Object.keys(cfg.hosts || {}).length) console.log('  · 还没有登记被测 App（宿主）：acceptkit host add <宿主> --platform P …');
    for (const x of S.settingsStatus(root, cfg)) {
      const f = `--platform ${x.platform} --host ${x.host}`;
      x.status === 'missing' ? console.log(`  · 缺 ${x.title} 设置（${x.rel}）—— 执行到「${x.step}」时会停下来问；acceptkit setting set ${x.slot} ${f} …${S.borrowCandidates(root, cfg, x.slot, x.platform, x.host).map(c => `，或借鉴 ${c.host}：acceptkit setting borrow ${x.slot} ${f} --from ${c.host}`).join('')}`)
        : x.status === 'guess' ? console.log(`  · ${x.title} 设置还是推测（${x.rel}）—— 试跑：acceptkit ${x.slot === 'build' ? 'build' : 'drive ui-tree'} ${f} --try`)
        : ok(`${x.title} 设置${x.status === 'verified' ? '已验证' : '已确认'}${x.own ? '' : '（同平台共用）'}`);
    }
  }
  const db = await import('../core/store/db.mjs');
  const { evFingerprint } = await import('../core/evidence-gate.mjs');
  try { db.openDb(root); ok('SQLite 存储可用'); } catch (e) { bad(`SQLite 打不开：${e.message}`); }
  // 迁移：引入用例质量标准前已有的用例 → 登记基线（当时就有的问题记为质量债，只提示不拦）
  {
    const Q = await import('../core/case-quality.mjs');
    const base = db.loadQualityBaseline(root);
    if (!base.initialized) {
      const all = loadAllCases(root);
      if (opt.fix) {
        const entries = Object.fromEntries(all.map(c => [c.case, Q.checkCase(c, qualityOpts(P)).filter(f => !f.waived).map(Q.findingKey)]));
        db.saveQualityBaseline(root, entries);
        ok(`已登记用例质量基线：${all.length} 条存量用例，质量债 ${Object.values(entries).reduce((n, k) => n + k.length, 0)} 处（acceptkit quality --verbose 看明细）`);
      } else bad(`还没登记用例质量基线（${all.length} 条存量用例）：现在质量检查只提示不拦`, 'acceptkit doctor --fix');
    } else ok(`用例质量基线已登记（${base.at.slice(0, 10)}，${Object.keys(base.map).length} 条存量用例）`);
    // 检查规则自己的文字也不许用行话（内核规则 + 项目私有规则，按项目的行话清单）：检查者说行话，这道闸永远不会把自己标红
    const list = [...Q.JARGON, ...(cfg.quality?.jargon || [])];
    const talk = [...Q.RULES, ...(P.pack.qualityRules || [])].flatMap(r => ['title', 'why', 'fix'].flatMap(k => Q.jargonHits(r[k], list).map(h => `${r.id}.${k}「${h.term}」`)));
    talk.length ? bad(`质量规则自己的文字在用行话：${talk.join('、')}`, '改写规则文字（项目私有规则在 pack.mjs 的 qualityRules）') : ok('质量规则文字里没有行话');
  }
  // 迁移：旧版 state/devices.json → SQLite 租约
  const legacyLeases = join(root, 'state', 'devices.json');
  if (existsSync(legacyLeases)) {
    if (opt.fix) {
      const cur = db.loadLeases(root);
      const old = JSON.parse(readFileSync(legacyLeases, 'utf8'));
      db.saveLeases(root, { ...old, ...cur });
      writeFileSync(legacyLeases + '.migrated', readFileSync(legacyLeases)); spawnSync('rm', [legacyLeases]);
      ok(`已把旧租约 ${Object.keys(old).length} 条导入 SQLite（原文件改名为 devices.json.migrated）`);
    } else bad('发现旧版设备租约文件 state/devices.json', 'acceptkit doctor --fix 导入 SQLite');
  }
  // 迁移：旧版复核结论没有内容指纹 → 用盘上当前内容补指纹，并标 fp_source=migrated
  const runsDir = join(root, 'runs');
  if (existsSync(runsDir)) {
    let nofp = 0, fixed = 0, dropped = 0;
    for (const d of readdirSync(runsDir)) {
      const rp = join(runsDir, d, 'result.json'); if (!existsSync(rp)) continue;
      let r; try { r = JSON.parse(readFileSync(rp, 'utf8')); } catch { continue; }
      let dirty = false;
      for (const [k, rv] of Object.entries(r.reviews || {})) {
        if (rv.fp || rv.state === 'pending') continue;
        nofp++;
        if (!opt['backfill-review-fp']) continue;
        const ev = k.split('::').slice(1).join('::');
        if (!/^(shots|evidence)\//.test(ev)) continue;      // 引用型证据（api: / src:）不落盘，没有指纹可言
        const fp = evFingerprint(join(runsDir, d), ev);
        if (!fp) { delete r.reviews[k]; dropped++; dirty = true; continue; }
        rv.fp = fp; rv.fp_source = 'migrated'; fixed++; dirty = true;
      }
      if (dirty) writeFileSync(rp, JSON.stringify(r, null, 2));
    }
    // 没有指纹的旧复核：引擎在下次 record 碰到时会作废重审（这是有意的）。只有从「从不记指纹」的旧版本迁来的项目，
    // 才需要用 --backfill-review-fp 按当前内容补齐（标 fp_source=migrated，如实说明是迁移时补的）。
    if (opt['backfill-review-fp']) ok(`补指纹 ${fixed} 条，证据已不存在而删除的复核 ${dropped} 条`);
    else if (nofp) console.log(`  · ${nofp} 条旧复核结论没有内容指纹：下次 record 碰到时会作废重审。从不记指纹的旧版本迁来的项目可用 --backfill-review-fp 补齐`);
    else ok('复核结论都有内容指纹');
  }
  const env = detectEnv();
  env.ios.available ? ok('iOS 模拟器工具可用') : console.log(`  · iOS 不可用：${env.ios.reason}`);
  env.android.available ? ok('adb 可用') : console.log(`  · Android 不可用：${env.android.reason}`);
  env.web.chrome ? ok('Chrome 可用') : console.log('  · 没有 Chrome');
  return finish();
  function finish() { console.log(problems.length ? `\n${problems.length} 个问题` : '\n全部通过'); process.exit(problems.length ? 1 : 0); }
}

// ---------------- know ----------------
async function know({ pos, opt }) {
  const P = await needProject();
  const K = await import('../core/knowledge.mjs');
  const { mask } = await import('../core/secrets.mjs');
  const s = pos[0] || 'list';
  const show = (e) => console.log(`- ${mask(P.root, e.text).replace(/\n/g, '\n  ')}\n    ${e.file.replace(P.root + '/', '')}:${e.line}${e.heading ? ` · ${e.heading}` : ''}${e.state ? ` · ${e.state}` : ''}`);
  if (s === 'add') {
    const text = pos.slice(1).join(' ') || die('用法：acceptkit know add "<内容 #标签>" [--file f.md] [--heading 标题] [--source 来源]');
    const f = K.add(P.root, { text, file: opt.file ? String(opt.file) : 'notes.md', heading: opt.heading ? String(opt.heading) : '', source: opt.source ? String(opt.source) : '' });
    console.log(`✓ 记进 ${f}`); return;
  }
  if (s === 'find') { const r = K.find(P.root, pos.slice(1)); if (!r.length) console.log('（没找到）'); r.forEach(show); return; }
  if (s === 'list') { const r = K.allEntries(P.root); console.log(`知识 ${r.length} 条`); r.forEach(show); return; }
  if (s === 'edit' || s === 'rm') {
    const ref = pos[1] || die(`用法：acceptkit know ${s} <文件>:<行号>${s === 'edit' ? ' "<新内容 #标签>"' : ''}`);
    const text = s === 'edit' ? (pos.slice(2).join(' ') || die('要给新内容')) : null;
    try {
      const r = K.replaceEntry(P.root, ref, text);
      console.log(`✓ ${s === 'edit' ? '改写' : '删掉'} ${r.file.replace(P.root + '/', '')}:${r.line}（原来：${r.oldSecret ? '机密条目，不回显' : mask(P.root, r.old).split('\n')[0].slice(0, 80)}）${r.secretKept ? '\n  原条目标了 #secret，新内容也带上了' : ''}`);
    } catch (e) { die(e.message); }
    return;
  }
  if (s === 'confirm' || s === 'verify' || s === 'guess') {
    const st = { confirm: 'confirmed', verify: 'verified', guess: 'guess' }[s];
    const r = K.setState(P.root, pos[1] || die(`用法：acceptkit know ${s} <文件>:<行号>`), st);
    console.log(`✓ ${r.file.replace(P.root + '/', '')}:${r.line} → ${st}`); return;
  }
  if (s === 'profile') {
    const r = K.allEntries(P.root);
    const by = {}; for (const e of r) (by[e.heading || '（未分组）'] ||= []).push(e);
    console.log(`环境画像 · ${P.config.name || basename(P.root)}`);
    for (const [h, es] of Object.entries(by)) {
      console.log(`\n■ ${h}`);
      for (const e of es) console.log(`  ${e.state === 'guess' ? '?' : e.state === 'verified' ? '✓' : '·'} ${mask(P.root, e.text.split('\n')[0]).slice(0, 160)}`);
    }
    const S = await import('../core/settings.mjs');
    const st = S.settingsStatus(P.root, P.config);
    if (st.length) { console.log('\n■ 设置'); for (const x of st) console.log(`  ${{ missing: '✗', guess: '?', confirmed: '·', verified: '✓' }[x.status]} ${x.title}：${x.status === 'missing' ? '缺口' : x.actions.join(' / ')}${x.status !== 'missing' && !x.own ? '（同平台共用）' : ''}`); }
    const guesses = r.filter(e => e.state === 'guess').length;
    if (guesses) console.log(`\n${guesses} 条还是推测 —— 确认后才会用来做决定（acceptkit know confirm <文件>:<行号>）`);
    return;
  }
  die('用法：acceptkit know add|find|list|edit|rm|confirm|verify|guess|profile');
}

// ---------------- setting / build / drive ----------------
// 流程里要用的设置（构建方式、驱动 App 的工具）位置固定：knowledge/settings/<平台>/<设置项>.md（见 core/settings.mjs）。
const STATE_ICON = { missing: '✗ 缺', guess: '? 推测', confirmed: '· 已确认', verified: '✓ 已验证' };
const SETTING_USAGE = `用法：
  acceptkit setting show
  acceptkit setting set build --platform P --host H --run "<命令>" [--note …] [--source …] [--guess]
  acceptkit setting set driver --platform P [--host H] --ui-tree "<命令>" [--tap "<命令>" …]   不带 --host = 同平台共用的那份
  acceptkit setting borrow <项> --platform P --host H --from [<项目目录>:]<宿主>   拷一份别的 App 的做法成 H 自己的（推测）
  acceptkit setting confirm <项> --platform P [--host H]
  acceptkit setting verify <项> --platform P [--host H] --evidence "<怎么核对的：产物包名 / 跑通的命令>"`;
const caseHostIds = c => [].concat(c.host && typeof c.host === 'object' ? Object.values(c.host) : c.host || []);
async function setting({ pos, opt }) {
  const P = await needProject();
  const S = await import('../core/settings.mjs');
  const sub = pos[0] || 'show';
  if (sub === 'show') {
    const st = S.settingsStatus(P.root, P.config);
    if (!st.length) { console.log('项目还没有登记被测 App（宿主），没有要设置的项：acceptkit host add <宿主> --platform P …'); return; }
    for (const x of st) {
      console.log(`${STATE_ICON[x.status].padEnd(6)} ${x.title.padEnd(24)} ${x.rel}${x.status !== 'missing' && !x.own ? '（同平台共用）' : ''}${x.actions.length ? `  动作：${x.actions.join(' / ')}` : ''}\n         用在：${x.step}`);
      if (x.status === 'missing') for (const c of S.borrowCandidates(P.root, P.config, x.slot, x.platform, x.host))
        console.log(`         可借鉴 ${c.host}（${STATE_ICON[c.state].slice(2)}）：acceptkit setting borrow ${x.slot} --platform ${x.platform} --host ${x.host} --from ${c.host}`);
    }
    return;
  }
  const slot = pos[1] || die(SETTING_USAGE);
  const platform = opt.platform ? String(opt.platform) : die('要给 --platform');
  let host = opt.host ? String(opt.host) : null;
  if (host && !(P.config.hosts || {})[host]) die(`没有登记宿主 ${host}：acceptkit host add ${host} --platform ${platform} …`);
  // 每个宿主一份的设置（构建）没给 --host：该平台只有一个宿主时就是它，多个时要说清写给谁
  if (!host && S.SLOTS[slot]?.scope === 'host') {
    const { resolveHost } = await import('../core/hosts.mjs');
    const h = resolveHost(P.config, { platform }); if (h.error) die(h.error); host = h.id;
  }
  try {
    if (sub === 'set') {
      const META = new Set(['platform', 'host', 'note', 'source', 'guess', 'project']);
      const commands = Object.fromEntries(Object.entries(opt).filter(([k]) => !META.has(k)).map(([k, v]) => [k, String(v)]));
      const r = S.writeSetting(P.root, slot, platform, host, { commands, note: opt.note ? String(opt.note) : '', source: opt.source ? String(opt.source) : '用户设置', state: opt.guess ? 'guess' : 'confirmed' });
      console.log(`✓ ${r.rel}（${opt.guess ? '推测，确认后才执行' : '已确认'}）  动作：${Object.keys(commands).join(' / ')}`);
      return;
    }
    if (sub === 'borrow') {
      if (!host) die('借鉴要写给哪个宿主：--host');
      const from = opt.from ? String(opt.from) : die('--from [<项目目录>:]<宿主>');
      const i = from.lastIndexOf(':');
      const fromRoot = i > 0 ? resolve(from.slice(0, i)) : P.root, fromHost = i > 0 ? from.slice(i + 1) : from;
      if (fromRoot !== P.root && !existsSync(join(fromRoot, CONFIG_NAME))) die(`${fromRoot} 不是项目`);
      const r = S.borrowSetting(P.root, slot, platform, host, { fromRoot, fromHost });
      console.log(`✓ ${r.rel}（借鉴自 ${r.from}，推测）\n  试跑：acceptkit ${slot === 'build' ? 'build' : 'drive ui-tree'} --platform ${platform} --host ${host} --try\n  走不通：acceptkit setting set ${slot} --platform ${platform} --host ${host} …（改的是 ${host} 自己的这份，不影响 ${fromHost}）`);
      return;
    }
    if (sub === 'confirm' || sub === 'verify') {
      if (sub === 'verify' && !opt.evidence) die('升级成已验证要写 --evidence "<怎么核对的>"（构建跑通不等于产物是这个 App 的包，写清核对了什么）');
      const r = S.setState(P.root, slot, platform, host, sub === 'confirm' ? 'confirmed' : 'verified', opt.evidence ? `${new Date().toISOString().slice(0, 10)} 验证：${opt.evidence}` : '');
      console.log(`✓ ${r.rel} → ${sub === 'confirm' ? '已确认' : '已验证'}`); return;
    }
  } catch (e) { die(e.message); }
  die(SETTING_USAGE);
}

async function settingCmd(slot, { pos, opt }) {
  const P = await needProject();
  const S = await import('../core/settings.mjs');
  const { resolveHost, hostsOf } = await import('../core/hosts.mjs');
  const action = slot === 'build' ? String(opt.action || 'run') : (pos[0] || die('用法：acceptkit drive <动作> --platform P [--host H] [--参数 值 …]（动作见 acceptkit setting show）'));
  const declared = [...new Set(Object.values(hostsOf(P.config)).flatMap(h => Object.keys(h).filter(p => S.SLOTS[slot].platforms.includes(p))))];
  const platform = opt.platform ? String(opt.platform) : declared.length === 1 ? declared[0] : die(`用 --platform 指定（登记的宿主有 ${declared.join(' / ') || '无'}）`);
  const h = resolveHost(P.config, { host: opt.host ? String(opt.host) : null, platform });
  if (h.error) die(h.error);
  const app = P.config.hosts[h.id][platform] || {};
  const META = ['platform', 'host', 'dry', 'action', 'project', 'try'];
  const vars = { bundle: app.bundle || app.package, port: process.env.ACCEPTKIT_APP_PORT || app.port,
    ...Object.fromEntries(Object.entries(opt).filter(([k]) => !META.includes(k)).map(([k, v]) => [k, String(v)])) };
  const o = { host: h.id, tryGuess: !!opt.try };
  if (opt.dry) { const a = S.resolveAction(P.root, slot, platform, action, vars, o); if (a.error) die(a.error); console.log(`${a.rel}\n${a.cmdLine}`); return; }
  const r = S.runAction(P.root, slot, platform, action, vars, { inherit: slot === 'build', ...o });
  if (!r.cmdLine) die(r.error);
  console.error(`▶ ${r.cmdLine}  （${h.id} · 设置：${r.ref}）`);
  if (slot !== 'build') { process.stdout.write(r.stdout); process.stderr.write(r.stderr); }
  const f = `--platform ${platform} --host ${h.id}`;
  if (r.error) die(r.state === 'guess' ? `${r.error}\n  借鉴来的做法在 ${h.id} 上走不通：改 ${h.id} 自己的这份 acceptkit setting set ${slot} ${f} …` : r.error);
  // 试跑通过不自动升级：退出码 0 只说明命令跑完了，产物是不是这个 App 的（包名、能不能装上起来）要另外核对
  if (r.state === 'guess') console.error(`✓ 试跑通过。核对${slot === 'build' ? `产物是 ${app.bundle || app.package || h.id} 的包` : `读到的是 ${h.id} 的界面`}后：acceptkit setting verify ${slot} ${f} --evidence "<核对了什么>"`);
}

// ---------------- host ----------------
// 被测 App（宿主）登记：一个项目可以有多个 App，包名、构建做法、宿主专属的操作配方都按宿主 id 存。
const HOST_USAGE = `用法：
  acceptkit host [show]
  acceptkit host add <宿主> --platform ios --bundle <bundle id> [--port N] [--title …]
  acceptkit host add <宿主> --platform android --package <包名> [--title …]
  acceptkit host add <宿主> --platform web --port N [--tab-match <网址正则>] [--title …]
  acceptkit host rm <宿主>`;
async function hostCmd({ pos, opt }) {
  const P = await needProject();
  const C = await import('../core/config-edit.mjs');
  const S = await import('../core/settings.mjs');
  const [sub = 'show', id] = pos;
  try {
    if (sub === 'show') {
      const hosts = P.config.hosts || {};
      if (!Object.keys(hosts).length) { console.log(`还没有登记被测 App。\n${HOST_USAGE}`); return; }
      const st = S.settingsStatus(P.root, P.config);
      const cases = loadAllCases(P.root);
      for (const [h, v] of Object.entries(hosts)) {
        console.log(`■ ${h}${v.title ? ` —— ${v.title}` : ''}   ${cases.filter(c => caseHostIds(c).includes(h)).length} 条用例`);
        for (const p of ['ios', 'android', 'web']) if (v[p]) console.log(`  ${p.padEnd(8)} ${JSON.stringify(v[p])}`);
        for (const x of st.filter(x => x.host === h)) console.log(`  ${STATE_ICON[x.status].padEnd(6)} ${x.platform} ${x.slot.padEnd(7)} ${x.rel}${x.status !== 'missing' && !x.own ? '（同平台共用）' : ''}`);
      }
      return;
    }
    if (!id) die(HOST_USAGE);
    if (sub === 'add') {
      const platform = opt.platform ? String(opt.platform) : null;
      const known = { ios: ['bundle', 'port'], android: ['package'], web: ['port', 'tab-match'] };
      if (platform && !known[platform]) die(`--platform 只能是 ${Object.keys(known).join(' / ')}`);
      for (const k of Object.keys(opt)) if (!['platform', 'title', 'project'].includes(k) && !(known[platform] || []).includes(k)) die(`不认识的参数 --${k}\n${HOST_USAGE}`);
      const fields = Object.fromEntries((known[platform] || []).filter(k => opt[k] !== undefined).map(k => [k === 'tab-match' ? 'tabMatch' : k, k === 'port' ? Number(opt[k]) : String(opt[k])]));
      const hosts = C.addHost(P.root, id, platform, fields, opt.title ? String(opt.title) : undefined);
      console.log(`✓ 宿主 ${id}${platform ? ` · ${platform} ${JSON.stringify(hosts[id][platform])}` : ''}`);
      if (!platform) return;
      const appId = hosts[id][platform].bundle || hosts[id][platform].package;
      if (appId && !(P.config.gate?.allow || []).some(a => a.kind === 'bundle' && a.value === appId))
        console.log(`  · ${appId} 还不在目标闸白名单里：会改端上状态的动作（装包、清数据）都会被拒。确认这是测试包后：acceptkit config add gate.allow ${appId} --kind bundle --note "…"`);
      const cfg = { ...P.config, hosts };
      for (const slot of Object.keys(S.SLOTS).filter(k => S.SLOTS[k].platforms.includes(platform))) {
        if (S.effectiveSetting(P.root, slot, platform, id).exists) continue;
        const cand = S.borrowCandidates(P.root, cfg, slot, platform, id);
        console.log(`  · 还没有${S.SLOTS[slot].title}设置：acceptkit setting set ${slot} --platform ${platform} --host ${id} …${cand.map(c => `\n      或借鉴 ${c.host}：acceptkit setting borrow ${slot} --platform ${platform} --host ${id} --from ${c.host}`).join('')}\n      或借鉴别的项目：… --from <项目目录>:<宿主>`);
      }
      return;
    }
    if (sub === 'rm') {
      C.removeHost(P.root, id, loadAllCases(P.root).filter(c => caseHostIds(c).includes(id)).map(c => c.case));
      console.log(`✓ 已删宿主 ${id}（它的设置文件 knowledge/settings/*/${id}/ 留着，不需要了手动删）`); return;
    }
  } catch (e) { die(e.message); }
  die(HOST_USAGE);
}

// ---------------- config ----------------
// 项目配置的写口（core/config-edit.mjs）：白名单、被测 App、危险动作词…… 写入时按登记的类型校验。
const CONFIG_USAGE = `用法：
  acceptkit config [show]                       每一项的当前值与说明
  acceptkit config set <键> <值>  ·  config unset <键>
  acceptkit config add gate.allow <设备号|包名|租户号> --kind device|bundle|tenant --note "<是什么、为什么允许>" [--only-on ios|android] [--profile 键=值 …]
  acceptkit config add apparatus.markers "<正则>" --why "<命中说明什么>"
  acceptkit config add quality.extraKeys <字段名>
  acceptkit config add quality.jargon "<正则>" --say "<改成怎么说>"     项目自己的行话
  acceptkit config rm <列表键> <值>  ·  acceptkit config check`;
async function configCmd({ pos, opt }) {
  const P = await needProject();
  const C = await import('../core/config-edit.mjs');
  const [sub = 'show', key, ...vals] = pos;
  const value = vals.join(' ');
  try {
    if (sub === 'show') {
      const raw = JSON.parse(readFileSync(join(P.root, CONFIG_NAME), 'utf8'));
      for (const [k, s] of Object.entries(C.CONFIG_KEYS)) {
        const v = k.split('.').reduce((x, p) => x?.[p], raw);
        console.log(`  ${k.padEnd(28)} ${v === undefined ? '（未设）' : Array.isArray(v) ? `${v.length} 项` : JSON.stringify(v).slice(0, 60)}   ${s.title}`);
      }
      return;
    }
    if (sub === 'check') {
      const probs = C.projectConfigProblems(P.root);
      if (!probs.length) { console.log(`✓ ${CONFIG_NAME} 没有问题`); return; }
      for (const x of probs) console.log(`  ${x.level === 'block' ? '✗' : '·'} ${x.key} ${x.msg}`);
      if (probs.some(x => x.level === 'block')) process.exit(1);
      return;
    }
    if (!key) die(CONFIG_USAGE);
    if (sub === 'set') { if (!vals.length) die(CONFIG_USAGE); C.setConfig(P.root, key, C.parseValue(key, value)); console.log(`✓ ${key} = ${value}`); return; }
    if (sub === 'unset') { C.unsetConfig(P.root, key); console.log(`✓ 已删 ${key}`); return; }
    if (sub === 'rm') { C.removeConfig(P.root, key, value); console.log(`✓ ${key} 去掉 ${value}`); return; }
    if (sub === 'add') {
      const s = C.CONFIG_KEYS[key];
      if (!vals.length && !opt.json) die(CONFIG_USAGE);
      let item = opt.json ? JSON.parse(String(opt.json)) : value;
      if (!opt.json && s?.key) {
        item = { [s.key]: value };
        const known = { kind: 'kind', note: 'note', 'only-on': 'onlyOn', why: 'why', say: 'say', profile: 'profile' };
        for (const [k, v] of Object.entries(opt)) {
          if (k === 'project') continue;
          if (!known[k]) die(`不认识的参数 --${k}\n${CONFIG_USAGE}`);
          item[known[k]] = k === 'profile' ? Object.fromEntries([].concat(v).map(x => String(x).split('='))) : String(v);
        }
      }
      C.addConfig(P.root, key, item);
      console.log(`✓ ${key} 加上 ${typeof item === 'object' ? JSON.stringify(item) : item}`);
      return;
    }
  } catch (e) { die(e.message); }
  die(CONFIG_USAGE);
}

// ---------------- ops ----------------
// 操作库的读写（core/ops.mjs）。新发现的平台做法从这里写回去，写入时校验；手改的文件用 ops check 查。
const OPS_USAGE = `用法：
  acceptkit ops [<id>]                          列表 / 看某条
  acceptkit ops set <id> --platform P [--title … --why … --kind observe|act] [--observes <层>[,<层>]]
        --observes   观测读的是哪一层：decision / diag / ui / network / report / crash / state / log / source / perf
        [--host H]   只在宿主 H 上成立的做法（不带 = 该平台所有宿主通用）
        [--how … --entry … --evidence … --exec … --switches … --steps … --caveats … --pitfalls …]
        [--json '<配方 JSON>'] [--replace] [--guess | --verified "<实测记录>"] [--source …]
  acceptkit ops set <id> --platform P [--host H] --absent "<为什么这个平台（宿主）还做不了>" [--unlock "<怎样才能做>"]
  acceptkit ops confirm|verify <id> --platform P [--host H]
  acceptkit ops rm <id>  ·  acceptkit ops check`;
async function opsCmd({ pos, opt }) {
  const P = await needProject();
  const O = await import('../core/ops.mjs');
  const sub = pos[0];
  const fmtProb = x => `  ${x.level === 'block' ? '✗' : '·'} ${x.id}${x.platform ? ` [${x.platform}]` : ''} ${x.msg}`;
  try {
    if (!sub) {
      const ops = O.loadOps(P.root);
      console.log(`操作库（${Object.keys(ops).length} 条）—— 用例的 op_id 从这里取：`);
      for (const [k, v] of Object.entries(ops)) {
        const marks = Object.entries(v.platforms || {}).map(([p, r]) => r.absent ? `${p}✗` : r.state === 'guess' ? `${p}?` : p);
        console.log(`  ${k.padEnd(30)} ${v.title}   ${marks.join(' ')}`);
      }
      console.log(`\n✗ 缺实现  ? 推测（确认后才用）\n看某条：acceptkit ops <id>；写回新做法：acceptkit ops set <id> --platform P …`);
      return;
    }
    if (sub === 'check') {
      const probs = O.registryProblems(P.root, Object.keys(P.config.hosts || {}));
      if (!probs.length) { console.log(`✓ ${O.opsPath(P.root)} 没有问题`); return; }
      probs.forEach(x => console.log(fmtProb(x)));
      const blocks = probs.filter(x => x.level === 'block').length;
      console.log(`\n${blocks} 处结构错误（读的一方会用错），${probs.length - blocks} 处读的一方认不出的字段${probs.some(x => /缺 state/.test(x.msg)) ? '；旧写法可以 acceptkit doctor --fix 迁移' : ''}`);
      if (blocks) process.exit(1);
      return;
    }
    if (!['set', 'confirm', 'verify', 'rm'].includes(sub)) {
      const o = O.loadOps(P.root)[sub] || die(`操作库里没有 ${sub}（新增：acceptkit ops set ${sub} --platform P --title … --why … --how …）`);
      console.log(`■ ${sub} —— ${o.title}\n  为什么：${o.why}`);
      for (const [plat, r] of Object.entries(o.platforms || {})) {
        console.log(`\n  [${plat}]${r.absent ? '  ✗ 缺实现' : `  ${O.STATE_LABEL[r.state] || '（没写状态）'}`}`);
        for (const [k, v] of Object.entries(r)) if (k !== 'state') console.log(`    ${k}: ${Array.isArray(v) ? v.map(x => typeof x === 'object' ? JSON.stringify(x) : x).join('\n      ') : typeof v === 'object' ? JSON.stringify(v) : v}`);
      }
      if (o.notes) console.log(`\n  备注：${o.notes}`);
      return;
    }
    const id = pos[1] || die(OPS_USAGE);
    const hostIds = Object.keys(P.config.hosts || {});
    // --platform P [--host H]：带 --host 写的是只在 H 上成立的那份（键 P@H），不带是与宿主无关的那份
    const keyOf = () => {
      const pf = opt.platform ? String(opt.platform) : die('要给 --platform');
      if (opt.host && !hostIds.includes(String(opt.host))) die(`没有登记宿主 ${opt.host}（已登记：${hostIds.join(' / ') || '无'}）`);
      return O.recipeKey(pf, opt.host ? String(opt.host) : null);
    };
    if (sub === 'set') {
      const META = new Set(['platform', 'host', 'title', 'why', 'kind', 'observes', 'json', 'replace', 'guess', 'absent', 'unlock', 'project']);
      const recipe = opt.json ? JSON.parse(String(opt.json)) : {};
      for (const [k0, v] of Object.entries(opt)) {
        if (META.has(k0)) continue;
        const k = k0.replace(/-/g, '_');
        if (!O.RECIPE_KEYS[k] || k === 'state') die(`不认识的参数 --${k0}\n${OPS_USAGE}`);
        recipe[k] = ['switches', 'steps', 'caveats', 'pitfalls'].includes(k) ? [].concat(v).map(String) : /_ms$/.test(k) ? Number(v) : String(v);
      }
      const observes = opt.observes ? String(opt.observes).split(',').map(s => s.trim()).filter(Boolean) : null;
      // 只改操作本身（--observes / --title / --why / --kind）：配方一个字也不碰，也不校验配方里的存量字段。
      // 以前这里也会把配方的 state 改成「已确认」、source 改成「用户设置」：批量登记 observes 时，推测的配方被抬成了已确认、出处全被抹掉
      const opOnly = !opt.absent && !opt.guess && !opt.replace && !Object.keys(recipe).length;
      const platform = opOnly ? null : keyOf();
      const cur = platform ? O.loadOps(P.root)[id]?.platforms?.[platform] : null;
      if (opt.absent) {
        if (Object.keys(recipe).length) die('--absent 表示这个平台还做不了，不能同时写做法');
      } else if (!opOnly) {
        // 状态：显式 --guess / --verified 按它；改了做法（怎么做 / 执行器 / 读什么）又没说，记「已确认」—— 做法变了，旧的「已验证」不再成立；
        // 只补说明（注意事项、坑、证据、出处……）不动状态。新配方记「已确认」
        const changesHow = ['how', 'exec', 'steps', 'read', 'entry', 'eval', 'url', 'tab', 'port', 'gate', 'switches'].some(k => k in recipe);
        recipe.state = opt.guess ? 'guess' : recipe.verified ? 'verified' : (!cur || cur.absent || changesHow || opt.replace) ? 'confirmed' : (cur.state || 'confirmed');
        // 出处是这份配方从哪来的：只在原来没有、这次也没给 --source 时补默认
        if (!recipe.source && (!cur || cur.absent || !cur.source || opt.replace)) recipe.source = '用户设置';
      }
      const r = O.writeOp(P.root, id, { title: opt.title && String(opt.title), why: opt.why && String(opt.why), kind: opt.kind && String(opt.kind), observes, platform, recipe, replace: !!opt.replace,
        absent: opt.absent ? { blocker: String(opt.absent), unlock: opt.unlock ? String(opt.unlock) : '' } : null, hosts: hostIds });
      if (opOnly) { console.log(`✓ 更新 ${id}（只改了操作本身${observes ? `：读的是 ${observes.join(' / ')}` : ''}；配方没动）`); return; }
      const st = r.op.platforms[platform];
      console.log(`✓ ${r.created ? '新增' : '更新'} ${id} [${platform}] ${st.absent ? '缺实现' : O.STATE_LABEL[st.state]}${st.state === 'guess' ? `（确认后才用：acceptkit ops confirm ${id} --platform ${opt.platform}${opt.host ? ` --host ${opt.host}` : ''}）` : ''}`);
      const rest = O.opProblems(id, r.op, hostIds).filter(x => x.platform !== platform);
      if (rest.length) { console.log('  这条操作别的平台上还有存量问题：'); rest.forEach(x => console.log(fmtProb(x))); }
      return;
    }
    if (sub === 'confirm' || sub === 'verify') {
      const platform = keyOf();
      O.setOpState(P.root, id, platform, sub === 'confirm' ? 'confirmed' : 'verified');
      console.log(`✓ ${id} [${platform}] → ${sub === 'confirm' ? '已确认' : '已验证'}`); return;
    }
    if (sub === 'rm') {
      const { opsUsedBy } = await import('../core/platform.mjs');
      O.removeOp(P.root, id, loadAllCases(P.root).filter(c => opsUsedBy(c).includes(id)).map(c => c.case));
      console.log(`✓ 已删 ${id}`); return;
    }
  } catch (e) { die(e.message); }
  die(OPS_USAGE);
}

// ---------------- quality ----------------
function loadAllCases(root) {
  const d = join(root, 'cases');
  if (!existsSync(d)) return [];
  return readdirSync(d).filter(f => f.endsWith('.case.json')).sort().flatMap(f => { try { return [JSON.parse(readFileSync(join(d, f), 'utf8'))]; } catch { return []; } });
}
const qualityOpts = P => ({ packRules: P.pack.qualityRules || [], extraKeys: P.config.quality?.extraKeys, cfg: P.config.quality || {}, hosts: P.config.hosts || {}, ops: loadOps(P.root) });
async function quality({ pos, opt }) {
  const P = await needProject();
  const Q = await import('../core/case-quality.mjs');
  if (opt.standard) { console.log(Q.standardSummary(P.pack.qualityRules || [])); return; }
  const all = loadAllCases(P.root);
  const pick = pos.length ? all.filter(c => pos.includes(c.case)) : all;
  if (pos.length && !pick.length) die(`没有用例 ${pos.join(' ')}`);
  const res = pick.map(c => ({ c, q: Q.evaluate(P.root, c, qualityOpts(P)) }));
  if (opt.json) { console.log(JSON.stringify(res.map(({ c, q }) => ({ case: c.case, ...q })), null, 1)); return; }
  if (pos.length || opt.verbose) for (const { c, q } of res) console.log(Q.formatFindings(c.case, q, { verbose: !!opt.verbose }) + '\n');
  // 汇总：每条规则 新问题 / 存量债 各多少
  const tally = {};
  for (const { q } of res) for (const [k, fs] of Object.entries({ block: q.block, warn: q.warn, debt: q.debt, waived: q.waived })) for (const f of fs) ((tally[f.rule] ||= { title: f.title, level: f.level, block: 0, warn: 0, debt: 0, waived: 0 })[k]++);
  console.log(`用例质量 · ${res.length} 条用例${res[0]?.q.uninitialized ? '（还没登记基线，只提示不拦：acceptkit doctor --fix）' : ''}`);
  console.log('   规则                          新问题  存量债  已豁免');
  for (const [id, t] of Object.entries(tally).sort()) console.log(`   ${t.level === 'block' ? '✗' : '⚠'} ${id} ${t.title.padEnd(14, '　')} ${String(t.block + t.warn).padStart(5)} ${String(t.debt).padStart(7)} ${String(t.waived).padStart(7)}`);
  const failing = res.filter(r => r.q.block.length).map(r => r.c.case);
  console.log(failing.length ? `\n❌ ${failing.length} 条用例有不达标的新问题：${failing.join(' ')}` : '\n✅ 没有不达标的新问题');
  if (failing.length) process.exitCode = 1;
}

// ---------------- index / query ----------------
async function index({ opt }) {
  const P = await needProject();
  const db = await import('../core/store/db.mjs');
  if (opt.verify) {
    db.rebuildIndex(P.root);
    const v = db.verifyIndex(P.root);
    console.log(`${v.ok ? '✓' : '✗'} 索引 · 用例 ${v.counts.cases} · 运行 ${v.counts.runs} · 断言 ${v.counts.expects} · 结论 ${v.counts.verdicts}`);
    v.problems.forEach(p => console.log('  ✗ ' + p));
    process.exit(v.ok ? 0 : 1);
  }
  const t0 = Date.now();
  const r = db.rebuildIndex(P.root, { full: !!opt.full });
  console.log(`✓ 索引已更新：扫描 ${r.scanned} 个文件，变化 ${r.changed}，删除 ${r.removed}（${Date.now() - t0}ms）`);
}
async function query({ pos, opt }) {
  const P = await needProject();
  const db = await import('../core/store/db.mjs');
  db.rebuildIndex(P.root);
  const sql = pos.join(' ') || die('用法：acceptkit query "<SELECT …>" [--json]   表：cases expects runs verdicts plans device_leases approvals env_snapshots');
  const rows = db.query(P.root, sql);
  if (opt.json) { console.log(JSON.stringify(rows, null, 1)); return; }
  if (!rows.length) { console.log('（0 行）'); return; }
  const cols = Object.keys(rows[0]);
  console.log(cols.join('\t'));
  for (const r of rows) console.log(cols.map(c => String(r[c] ?? '').replace(/\s+/g, ' ').slice(0, 120)).join('\t'));
  console.log(`（${rows.length} 行）`);
}

// ---------------- login / open ----------------
async function login({ pos, opt }) {
  const P = await needProject();
  if (pos[0] !== 'web') die('用法：acceptkit login web <网址> [--port P]  或  acceptkit browser <网址>');
  const url = pos[1] || die('缺网址');
  const { resolveHost, hostApp } = await import('../core/hosts.mjs');
  const h = resolveHost(P.config, { host: opt.host ? String(opt.host) : null, platform: 'web' });
  const port = String(opt.port || (h.error ? '' : hostApp(P.config, h.id, 'web').port) || 9350);
  // 用户目录：项目里的常驻目录；用户偏好 browsers.profile_dir 写了就用它（cdp.mjs stableProfile）
  const pref = readUserConfig().prefs?.browsers?.profile_dir || null;
  const { stableProfile } = await import('../adapters/web/cdp.mjs');
  const profile = stableProfile(port, join(P.root, '.acceptkit', `browser-${port}`), pref);
  const cli = join(REPO_ROOT, 'adapters', 'web', 'cli.mjs');
  const call = args => { const r = sh(process.execPath, [cli, ...args], { timeout: 60_000 }); const out = (r.stdout || '').trim().split('\n').pop();
    let j; try { j = JSON.parse(out); } catch { die(`浏览器没起来：${r.stderr || out}`); } if (!j.ok) die(j.error); return j; };
  // --run R：在这个验收运行自己的标签页里打开（observe / shot 只连这个标签页，见 engine runTab）
  if (opt.run) {
    const run = String(opt.run), rp = join(P.root, 'runs', run, 'result.json');
    if (!existsSync(rp)) die(`没有运行 ${run}`);
    call(['open', '--port', port, '--profile', profile, ...(pref ? ['--pref', pref] : [])]);
    const res = JSON.parse(readFileSync(rp, 'utf8'));
    const cur = res.browser && String(res.browser.port) === port ? res.browser.target : null;
    const t = call(['tab', '--port', port, ...(cur ? ['--target', cur] : []), '--url', url]);
    if (t.target !== cur) { res.browser = { port: Number(port), target: t.target, opened_at: new Date().toISOString() }; writeFileSync(rp, JSON.stringify(res, null, 2) + '\n'); }
    console.log(`✓ 运行 ${run} 的标签页（${t.target.slice(0, 8)}…，端口 ${port}）已打开 ${url}${t.fresh ? '（新开的）' : ''}\n  这个运行的 observe / shot 只在这个标签页上做；别的运行的标签页不会被截进来。`);
    return;
  }
  call(['open', '--port', port, '--profile', profile, '--url', url, ...(pref ? ['--pref', pref] : [])]);
  console.log(`✓ 独立浏览器实例（端口 ${port}，用户目录 ${profile}）已打开 ${url}\n  需要登录的话在这个窗口里登录一次；登录态留在这个独立用户目录里，不影响你日常用的浏览器。\n  验收时用 acceptkit browser --run <运行> <网址> 在运行自己的标签页里打开。`);
}
// 空闲浏览器回收：acceptkit 起的调试 Chrome 超过阈值（缺省 60 分钟，prefs browsers.idle_minutes）没用就关。
// 关的是窗口，独立用户目录（登录态）留着，下次 login / 驱动复用。用户自己的 Chrome、别的工具起的不动（adapters/web/cdp.mjs sweepBrowsers）
async function browserSweep({ opt }, listOnly = false) {
  const { sweepBrowsers } = await import('../adapters/web/cdp.mjs');
  const idleMin = Number(readUserConfig().prefs?.browsers?.idle_minutes) || 60;
  const r = await sweepBrowsers({ idleMin, dry: listOnly || !!opt['dry-run'], roots: knownProjects() });
  if (opt.json) { console.log(JSON.stringify(r, null, 1)); return r; }
  const dry = r.dry_run;
  console.log(`调试浏览器（空闲阈值 ${idleMin} 分钟${dry ? '，只看不动' : ''}）`);
  if (!r.browsers.length) console.log('  没有开着的调试浏览器');
  const verb = { keep: '留着', close: dry ? '会关' : '已关', gone: '已不在', adopt: dry ? '会收进台账' : '收进台账', foreign: '不动' };
  for (const x of r.browsers) console.log(`  ${x.action === 'close' ? '⏹' : '·'} 端口 ${x.port}  ${x.profile}：${verb[x.action]} —— ${x.why}${x.result && x.result !== '已关' ? '，' + x.result : ''}`);
  return r;
}
// ---------------- 管理页面（acceptkit serve） ----------------
// acceptkit 自己的本机网站：项目列表 + 各项目看板（core/server.mjs）。link / open 缺省都指向它，
// 没在跑就在后台起一个；登记过的项目（project init / use）都在上面。
const SERVE_STATE = join(USER_CONFIG, '..', 'serve.json');
const servePort = () => Number(readUserConfig().serve?.port) || 9470;
/** 登记过的项目目录（还存在的） */
function knownProjects() {
  const u = readUserConfig();
  return [...new Set([...(u.projects || []), ...(u.defaultProject ? [u.defaultProject] : [])])].filter(d => existsSync(join(d, CONFIG_NAME)));
}
function rememberProject(dir) {
  const u = readUserConfig();
  if ((u.projects || []).includes(dir)) return;
  mkdirSync(join(USER_CONFIG, '..'), { recursive: true });
  writeFileSync(USER_CONFIG, JSON.stringify({ ...u, projects: [...(u.projects || []), dir] }, null, 2) + '\n');
}
async function health(port) {
  try { const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) }); return r.ok ? await r.json() : null; } catch { return null; }
}
// pid 优先取健康检查报的：端口上的服务可能不是这份 SERVE_STATE 记的（别的 HOME 起的），
// 只认自己的记录就停不掉它，后面的启动会撞 EADDRINUSE，link / open 全部失败。
function stopServer(pid = null) {
  let st = {}; try { st = JSON.parse(readFileSync(SERVE_STATE, 'utf8')); } catch { if (!pid) return false; }
  try { process.kill(pid || st.pid); } catch { /* 已经不在了 */ }
  writeFileSync(SERVE_STATE, '{}\n');
  return true;
}
/** 确保管理页面在跑、且带着这个项目 → 这个项目在上面的地址 http://127.0.0.1:<端口>/p/<id>/ */
async function ensureServer(root, { start = true } = {}) {
  rememberProject(root);
  const port = servePort();
  let h = await health(port);
  // 服务起来之后才登记的项目它不认识：重启一次（服务启动时读项目列表）
  if (h && !h.projects.some(p => p.root === root)) { if (!start) return null; stopServer(h.pid); await new Promise(r => setTimeout(r, 300)); h = null; }
  if (!h && !start) return null;
  if (!h) {
    const { openSync } = await import('node:fs');
    const log = openSync(join(USER_CONFIG, '..', 'serve.log'), 'a');
    const ch = spawn(process.execPath, [join(REPO_ROOT, 'bin', 'acceptkit.mjs'), 'serve', '--port', String(port)], { detached: true, stdio: ['ignore', log, log], env: { ...process.env, ACCEPTKIT_PROJECT: '' } });
    ch.unref();
    for (let i = 0; i < 40 && !h; i++) { await new Promise(r => setTimeout(r, 150)); h = await health(port); }
    if (!h) return null;
  }
  const p = h.projects.find(x => x.root === root);
  return p ? `http://127.0.0.1:${port}/p/${p.id}/` : null;
}
const SERVE_USAGE = `用法：
  acceptkit serve [--port N] [--host 127.0.0.1]   前台起管理页面（缺省端口 ${9470}，只听本机）
  acceptkit serve status · acceptkit serve stop
  （link / open 会在后台自动起它；端口改用户配置 serve.port）`;
async function serveCmd({ pos, opt }) {
  if (pos[0] === 'status') { const h = await health(servePort()); console.log(h ? `✓ 管理页面在跑：http://127.0.0.1:${servePort()}/  （${h.projects.map(p => p.id).join(' / ')}）` : `✗ 管理页面没在跑（acceptkit serve）`); return; }
  if (pos[0] === 'stop') { console.log(stopServer() ? '✓ 已停' : '没有在跑的管理页面'); return; }
  if (pos[0]) die(SERVE_USAGE);
  const cur = resolveProjectRoot({ argv: [...argv] }).root;
  const roots = [...new Set([...knownProjects(), ...(cur && existsSync(join(cur, CONFIG_NAME)) ? [resolve(cur)] : [])])];
  const { startServer } = await import('../core/server.mjs');
  const host = String(opt.host || '127.0.0.1');
  let s; try { s = await startServer({ roots, port: opt.port !== undefined ? Number(opt.port) : servePort(), host }); } catch (e) { die(`起不来：${e.message}${e.code === 'EADDRINUSE' ? '（端口被占：acceptkit serve status / stop，或 --port 换一个）' : ''}`); }
  mkdirSync(join(USER_CONFIG, '..'), { recursive: true });
  writeFileSync(SERVE_STATE, JSON.stringify({ pid: process.pid, port: s.port, host, at: new Date().toISOString() }) + '\n');
  console.log(`✓ acceptkit 管理页面：${s.url}/`);
  for (const p of s.projects) console.log(`  ${s.url}/p/${p.id}/   ${p.name} · ${p.root}`);
  if (host !== '127.0.0.1' && host !== 'localhost') console.log('  ⚠️ 不只听本机：看板里是被测系统的内部数据，同网段的人都能打开');
  // 空闲设备回收：看板服务是本机唯一常驻的 acceptkit 进程，由它定时跑 device sweep。
  // 不放在 startServer 里：测试会起很多个服务，不能让它们去关机器。子进程跑，不阻塞页面。
  const sweep = () => { for (const p of s.projects) {
    const ch = spawn(process.execPath, [join(REPO_ROOT, 'bin', 'acceptkit.mjs'), 'device', 'sweep'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ACCEPTKIT_PROJECT: p.root } });
    let o = ''; ch.stdout.on('data', d => { o += d; }); ch.stderr.on('data', d => { o += d; });
    ch.on('close', () => { if (/⏹/.test(o)) console.log(`[${new Date().toISOString()}] ${p.id} ${o.trim()}`); });
  } };
  // 浏览器不分项目，一轮只跑一次
  const sweepB = () => { const ch = spawn(process.execPath, [join(REPO_ROOT, 'bin', 'acceptkit.mjs'), 'browser', 'sweep'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let o = ''; ch.stdout.on('data', d => { o += d; }); ch.stderr.on('data', d => { o += d; });
    ch.on('close', () => { if (/⏹/.test(o)) console.log(`[${new Date().toISOString()}] ${o.trim()}`); }); };
  setInterval(() => { sweep(); sweepB(); }, 10 * 60e3).unref?.();
  setTimeout(() => { sweep(); sweepB(); }, 60e3).unref?.();
}

async function open({ opt }) {
  const P = await needProject();
  // --file：旧做法，生成本地 dashboard.html 并打开（图片内联，大项目可能生成失败）
  if (opt.file) {
    const custom = P.pack.dashboard;
    const script = custom ? resolve(P.root, custom) : join(REPO_ROOT, 'core', 'dashboard.mjs');
    const r = spawnSync(process.execPath, [script], { stdio: 'inherit', env: { ...process.env, ACCEPTKIT_PROJECT: P.root }, cwd: P.root });
    if (r.status !== 0) process.exit(r.status || 1);
    const html = join(P.root, 'dashboard.html');
    if (!opt['no-open'] && process.platform === 'darwin' && existsSync(html)) sh('open', [html]);
    return;
  }
  const base = await ensureServer(P.root) || die(`管理页面起不来，看 ${join(USER_CONFIG, '..', 'serve.log')}；或 acceptkit open --file 生成本地文件`);
  console.log(base);
  if (!opt['no-open'] && process.platform === 'darwin') sh('open', [base]);
}

// 报告地址：按上下文（给的运行 / 需求 / 用例，不给就是最近一次运行）给出直接停在那份报告上的网址
async function linkCmd({ pos, opt }) {
  const P = await needProject();
  const L = await import('../core/links.mjs');
  const r = L.resolveLink(P.root, pos[0] || null);
  if (r.error) die(r.error);
  const base = P.config.dashboard?.url ? null : await ensureServer(P.root, { start: !opt['no-start'] });
  if (!P.config.dashboard?.url && !base) die(opt['no-start'] ? '管理页面没在跑' : `管理页面起不来，看 ${join(USER_CONFIG, '..', 'serve.log')}`);
  const url = L.linkUrl(P.root, P.config, r, base);
  if (url.error) die(url.error);
  if (opt.json) { console.log(JSON.stringify({ url, key: r.key, what: r.what, report: r.report || null })); return; }
  console.log(`${url}\n  定位到：${r.what}${r.report ? `\n  报告文件：${r.report}` : ''}`);
  if (opt.open && process.platform === 'darwin') sh('open', [url]);
}

// ---------------- sut / import / select / env --save ----------------
async function sutCmd({ pos, opt }) {
  const P = await needProject();
  const run = pos[0] || die('用法：acceptkit sut <run> [--target "<在验什么>"] [--repo 名字=路径 ...] [--app <bundle|包名> --device <udid|serial>] [--url <网址>]');
  const { sut } = await import('../core/phase1.mjs');
  const { file, out } = sut(P.root, { run, target: opt.target ? String(opt.target) : '', repos: [].concat(opt.repo || []).map(String),
    app: opt.app ? String(opt.app) : null, device: opt.device ? String(opt.device) : null, url: opt.url ? String(opt.url) : null });
  console.log(`✓ 被测物标识 → ${file}`);
  for (const [n, r] of Object.entries(out.repos)) console.log(r.error ? `  ✗ ${n} ${r.path}：${r.error}` : `  ${n} ${r.branch} @ ${r.commit_short}${r.dirty_files ? `（${r.dirty_files} 个未提交改动）` : ''}`);
  if (out.app) console.log(out.app.error ? `  ✗ App：${out.app.error}` : `  App ${out.app.bundle || out.app.package} ${out.app.version || ''}${out.app.build ? ` (${out.app.build})` : ''}${out.app.version_code ? ` (${out.app.version_code})` : ''}`);
}
async function importCmd({ pos, opt }) {
  const P = await needProject();
  const file = pos[0] || die('用法：acceptkit import <旧用例.csv|.md> --case <新用例 id> --platform ios|android|both|web [--title …]');
  if (!opt.case || !opt.platform) die('必须给 --case 与 --platform（平台不缺省）');
  const { importCases } = await import('../core/phase1.mjs');
  const r = importCases(P.root, { file: resolve(String(file)), caseId: String(opt.case), platform: String(opt.platform), title: opt.title ? String(opt.title) : '' });
  console.log(`✓ 导入 ${r.rows} 行 → ${r.asserts} 条断言（条数守恒）：${r.file}`);
  if (r.vague.length) console.log(`  ⚠️ ${r.vague.length} 条预期写得判定不了（如「显示正常」），已标 needs_clarify，要逐条问清楚：${r.vague.join(' ')}`);
  if (r.empty.length) console.log(`  ⚠️ ${r.empty.length} 条原用例没写预期：${r.empty.join(' ')}`);
  console.log('  下一步：给能机判的断言写 observe 规格；加进评审单：acceptkit plan add-case <D> --surface <S> --reuse ' + String(opt.case));
}
async function selectCmd({ opt }) {
  const P = await needProject();
  const { selectCases } = await import('../core/phase1.mjs');
  const { loadOps: opsAt } = await import('../core/ops.mjs');
  const loadOps = () => opsAt(P.root);
  const r = selectCases(P.root, { platform: opt.platform ? String(opt.platform) : null, surface: opt.surface ? String(opt.surface) : null, build: opt.build ? String(opt.build) : null, loadOps , config: P.config });
  if (opt.json) { console.log(JSON.stringify(r, null, 1)); return; }
  console.log(`建议复用 ${r.keep.length} 条：`);
  for (const k of r.keep) console.log(`  ✓ ${k.case.padEnd(36)} ${k.why}`);
  console.log(`\n排除 ${r.drop.length} 条：`);
  for (const d of r.drop.slice(0, opt.all ? Infinity : 30)) console.log(`  · ${String(d.case).padEnd(36)} ${d.why}`);
  if (r.drop.length > 30 && !opt.all) console.log(`  …… 还有 ${r.drop.length - 30} 条（--all 看全部）`);
  console.log('\n这是建议，不是决定：要不要复用由评审单决定（plan add-case … --reuse），并由人批准。');
}

const HELP = `acceptkit ${VERSION} — 本机验收 Agent 工具箱（不调用模型）

冷启动
  env [--json] [--save]                检查本机环境：设备、浏览器、工具链、启动目录；--save 存成快照
  sut <run> [--repo 名=路径] [--app <包> --device <设备>] [--url U] [--target T]   记录被测物标识
  project init <dir> [--name N]        新建项目（要测哪个项目由你决定）
  project use <dir>                    不在项目目录里启动时缺省用这个项目（也登记到管理页面）
  project list · project forget <dir>  管理页面上列哪些项目
  doctor [--fix] [--backfill-review-fp]  体检；--fix 做迁移（旧租约导入、权限收紧）
  login web <网址> [--port P]          在独立浏览器实例里登录一次
  browser --run <运行> <网址>           在这个验收运行自己的标签页里打开页面（observe / shot 只连它）
  browser <网址> [--port P]            打开项目的独立调试浏览器实例（不需要登录的页面用这个）
知识
  know add "<内容 #标签>" [--file f] [--heading h] [--source s]
  know find <词|#标签>...  ·  know list  ·  know profile
  know edit <文件>:<行号> "<新内容>"  ·  know rm <文件>:<行号>
  know confirm|verify|guess <文件>:<行号>
被测 App（宿主；一个项目可以有多个，包名、构建、宿主专属的做法按宿主分开存）
  host [show] · host add <宿主> --platform ios|android|web --bundle|--package|--port … · host rm <宿主>
设置（流程要用的、由你设置的知识；构建每个 App 一份 knowledge/settings/<平台>/<宿主>/build.md，
      驱动同平台共用 knowledge/settings/<平台>/driver.md，某个 App 例外时写它自己的那份）
  setting show                          每项设置的状态：缺 / 推测 / 已确认 / 已验证；缺的列出可借鉴的
  setting set build --platform P --host H --run "<命令>" [--note …] [--source …] [--guess]
  setting set driver --platform P [--host H] --ui-tree "<命令>" [--tap "<命令>" …]
  setting borrow <项> --platform P --host H --from [<项目目录>:]<宿主>   新 App 先借别的 App 的做法（拷成自己的，推测）
  setting confirm <项> … · setting verify <项> … --evidence "<核对了什么>"
  build [--platform P] [--host H] [--try] [--dry]   按构建设置构建；--try 试跑推测的（借鉴来的）做法
  drive <动作> [--platform P] [--host H] [--try]    按驱动设置操作 App（如 tap --text 允许）
项目配置与操作库（由你设置；写入时校验，手改的文件用 check 查）
  config [show] · config set <键> <值> · config add|rm <列表键> <值> … · config check
  config add gate.allow <设备号|包名|租户号> --kind device|bundle|tenant --note "…"   允许操作的目标
  ops [<id>] · ops set <id> --platform P [--host H] --how … [--guess] · ops set <id> --platform P [--host H] --absent "<原因>"
  ops confirm|verify <id> --platform P [--host H] · ops rm <id> · ops check
用例质量
  quality [<case>…] [--verbose] [--json]   按质量标准检查（新问题 / 存量质量债 / 已豁免）
  quality --standard                       打印标准：规则、教训、修法、评审时要问的问题
资产
  import <旧用例.csv|.md> --case <id> --platform <P>    导入旧用例（条数守恒，判定不了的标出来）
  select [--platform P] [--surface S] [--build 组件@版本]  推荐可复用的用例（带入选 / 排除理由）
管理
  index [--full | --verify]            重建 / 校验 SQLite 索引
  query "<SELECT …>" [--json]          用 SQL 查用例、运行、结论、评审单
  serve [--port N] · serve status|stop  acceptkit 自己的管理页面（本机网站：项目列表 + 各项目看板）
  open [--no-open] [--file]            打开管理页面上这个项目的看板（没在跑就后台起一个）；--file = 生成本地 html
  link [<运行|需求|用例>] [--open] [--json]   报告地址：直接停在那份报告上的网址（不给 = 最近一次运行）
                                       看板另外嵌在别的页面里时：config set dashboard.url "<网址，{key} 处填面板键>"
用例与运行（引擎）
  protocol [--json]                    命令清单：循环里用到的命令，照工具定义的格式（名字、说明、参数 schema、argv、返回）
  next <需求> [--json]                  还剩什么：工具从记录推出卡片，照第一张能做的做，做完再 next
  consult <运行> --expect E [--json]   拿不出证据时：按判据面给常见取证入口、要问清的业务问题、通识问题、问 owner 的草稿
  context <运行> --node nN [--json]     做这一步之前取经验：做法、shows、danger、相关知识、遮蔽层、以往失败 / 驳回、截图做法
  read <资源> [--offset N] [--limit M] [--json]   卡片 read 指针指向的长内容，分页读
  device acquire --run R [--json]       选设备并占上（复用 → 启动）；核对不对就 device reject <身份> --run R --why "…"
  plan · new · validate · run · record · observe · review · reviewq · report · bug · history · regress · round
  shot · device · gate · blockers · cases · demands · dup · probe · steps · coverage
  （acceptkit <命令> 不带参数看用法；全部命令说明：acceptkit engine-help）

项目：--project <dir> / 环境变量 ACCEPTKIT_PROJECT / 当前目录向上找 ${CONFIG_NAME}`;

const own = {
  env: async () => {
    const { opt } = flags(3); const f = detectEnv();
    if (opt.json) console.log(JSON.stringify(f, null, 1)); else printEnv(f);
    if (opt.save) { const P = await needProject(); const db = await import('../core/store/db.mjs'); console.log(`✓ 环境快照已存：${db.saveSnapshot(P.root, { at: f.at, target: 'host', platform: process.platform, facts: f })}`); }
  },
  sut: () => sutCmd(flags(3)),
  import: () => importCmd(flags(3)),
  select: () => selectCmd(flags(3)),
  project: () => {
    if (sub === 'init') return projectInit(flags(4));
    if (sub === 'use') return projectUse(flags(4));
    if (sub === 'list') { const ps = knownProjects(); console.log(ps.length ? ps.join('\n') : '还没有登记项目（project init / project use 会登记）'); return; }
    if (sub === 'forget') {
      const dir = resolve(argv[4] || die('用法：acceptkit project forget <项目目录>')); const u = readUserConfig();
      writeFileSync(USER_CONFIG, JSON.stringify({ ...u, projects: (u.projects || []).filter(d => d !== dir) }, null, 2) + '\n');
      console.log(`✓ 管理页面上不再列出 ${dir}（目录本身没动）`); return;
    }
    if (sub === 'show' || !sub) return needProject().then(p => console.log(JSON.stringify({ root: p.root, via: p.via, config: p.config }, null, 2)));
    die('用法：acceptkit project init|use|show|list|forget');
  },
  doctor: () => doctor(flags(3)),
  know: () => know(flags(3)),
  quality: () => quality(flags(3)),
  setting: () => setting(flags(3)),
  config: () => configCmd(flags(3)),
  host: () => hostCmd(flags(3)),
  link: () => linkCmd(flags(3)),
  serve: () => serveCmd(flags(3)),
  ops: () => opsCmd(flags(3)),
  build: () => settingCmd('build', flags(3)),
  drive: () => settingCmd('driver', flags(3)),
  index: () => index(flags(3)),
  query: () => query(flags(3)),
  login: () => login(flags(3)),
  browser: () => (['sweep', 'list'].includes(sub) ? browserSweep(flags(4), sub === 'list') : (argv.splice(3, 0, 'web'), login(flags(3)))),
  open: () => open(flags(3)),
  // 用户自己的偏好（不是项目配置，只存在本机 ~/.config/acceptkit/config.json 的 prefs 下，别人不受影响）
  prefs: async () => {
    const { pos } = flags(3);
    const { DISPLAY_PREFS, screens, pickScreen, applyDevicePref } = await import('../core/display.mjs');
    const KEYS = { 'devices.display': `设备窗口开在哪块显示器：${Object.entries(DISPLAY_PREFS).map(([k, v]) => `${k}（${v}）`).join(' / ')} / 数字（从左往右第几块）。目前只管 Android 模拟器`,
      'devices.new_device': '新增设备时你自己那边还要做的事（一句话，原话）。acceptkit 要新建设备时会把它带进问你的问题里',
      'devices.idle_minutes': '设备空闲多少分钟算没人用、被回收关机（缺省 60）',
      'browsers.idle_minutes': 'acceptkit 起的调试浏览器空闲多少分钟就关掉（缺省 60；只关窗口，登录态留着）',
      'browsers.profile_dir': '调试浏览器的用户目录放哪（登录态在里面）：模板，{port} 换成端口，例 ~/.local/share/my-chrome-{port}。不设就放项目的 .acceptkit/browser-<端口>；不能放 /tmp（重启就清空）',
      'devices.reinstall': '装包时什么情况要先卸载、什么情况覆盖安装就行（你的判断，原话）。过装包 / 卸载的闸时 acceptkit 会把它带出来' };
    const [sub = 'show', key, value] = pos;
    const u = readUserConfig();
    const save = () => { mkdirSync(join(USER_CONFIG, '..'), { recursive: true }); writeFileSync(USER_CONFIG, JSON.stringify(u, null, 2) + '\n'); };
    if (sub === 'show') {
      for (const [k, d] of Object.entries(KEYS)) console.log(`  ${k.padEnd(18)} ${JSON.stringify(k.split('.').reduce((x, p) => x?.[p], u.prefs) ?? '（未设）')}   ${d}`);
      const sc = screens(); if (sc.length) console.log(`  本机显示器（从左往右）：${[...sc].sort((a, b) => a.x - b.x).map((s, i) => `${i + 1}. ${s.w}×${s.h}${s.main ? ' 主屏' : ''}`).join('  ')}`);
      return;
    }
    if (!KEYS[key]) { console.error(`acceptkit: 能设的偏好：${Object.keys(KEYS).join(' ')}`); process.exitCode = 1; return; }
    const [g, k] = key.split('.');
    if (sub === 'unset') { if (u.prefs?.[g]) delete u.prefs[g][k]; save(); console.log(`✓ 已清掉 ${key}`); return; }
    if (sub !== 'set' || !value) { console.error('acceptkit: 用法：acceptkit prefs [show] | set <键> <值> | unset <键>'); process.exitCode = 1; return; }
    if (/idle_minutes$/.test(key) && !/^[1-9]\d*$/.test(value)) { console.error(`acceptkit: ${key} 要一个正整数（分钟）`); process.exitCode = 1; return; }
    if (key === 'devices.display' && !DISPLAY_PREFS[value] && !/^[1-9]\d*$/.test(value)) { console.error(`acceptkit: devices.display 只能是 ${Object.keys(DISPLAY_PREFS).join(' / ')} 或一个数字`); process.exitCode = 1; return; }
    ((u.prefs ||= {})[g] ||= {})[k] = value; save();
    if (key !== 'devices.display') { console.log(`✓ ${key} = ${value}`); return; }
    const sc = pickScreen(value);
    const avds = applyDevicePref();
    console.log(`✓ ${key} = ${value}${sc ? `（这台机器上是 ${sc.w}×${sc.h} 那块${sc.main ? '，主屏' : ''}）` : ''}。已写进 ${avds.length} 台验收 AVD 的窗口位置（${avds.join('、')}），下次开机就在这块上；已经开着的不动`);
  },
  // 宿主钩子：由宿主从任意目录调起，不需要项目（core/hooks.mjs）。run 的 stdout 只给宿主看，其余命令输出卡片
  hook: async () => {
    const H = await import('../core/hooks.mjs');
    try {
      const r = await H.hookCmd(flags(3), join(REPO_ROOT, 'bin', 'acceptkit.mjs'));
      if (r?.exitCode !== undefined) { process.exitCode = r.exitCode; return; }
      console.log(JSON.stringify(r, null, 1));
    } catch (e) { console.error('acceptkit: ' + e.message); process.exitCode = 1; }
  },
  // 绑定「这个会话在验收哪个需求」：停止钩子据此跑 next（core/hooks.mjs）
  // 测试账号：清单和值都存用户目录（0600），不进项目；机密字段在证据、报告里被遮成 ***（core/accounts.mjs）
  account: async () => {
    const A = await import('../core/accounts.mjs');
    const { ownerIdentity } = await import('../core/project.mjs');
    try { const r = A.accountCmd(flags(3), await needProject(), ownerIdentity()); if (r.raw !== undefined) process.stdout.write(r.raw); else console.log(r.text); }
    catch (e) { console.error('acceptkit: ' + e.message); process.exitCode = 1; }
  },
  loop: async () => {
    const H = await import('../core/hooks.mjs');
    try { console.log(JSON.stringify(await H.loopCmd(flags(3), await needProject()), null, 1)); } catch (e) { console.error('acceptkit: ' + e.message); process.exitCode = 1; }
  },
  // 命令清单不需要项目：执行者开工前就要知道有哪些命令、怎么调
  protocol: async () => {
    const P = await import('../core/protocol.mjs');
    console.log(flags(3).opt.json ? JSON.stringify(P.manifest(), null, 1) : P.formatManifest());
  },
  version: () => console.log(VERSION),
  '--version': () => console.log(VERSION),
  help: () => console.log(HELP), '--help': () => console.log(HELP), '-h': () => console.log(HELP),
};

if (!cmd) console.log(HELP);
else if (own[cmd]) await own[cmd]();
else {
  if (cmd === 'engine-help') argv.splice(2, 1);
  await import('../core/engine.mjs');
}
