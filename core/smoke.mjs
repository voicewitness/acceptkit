// 冒烟闸：每一轮的包先过冒烟，过了才开跑用例。
//
// 为什么要有（真实数据，一个端上引擎需求）：头 4 天在一个根本没装配起来的包上首跑了 41 条用例，
// 121 条 finding 里 97 条开在这 3 天，后来大多重置重跑 —— 那几天其实是在做集成排障，不是验收。
// 包没跑通时跑用例，结论全是噪音；所以把「包能不能跑」单独做成一道闸，挡在 run_needed 前面。
//
// 分工：冒烟项由项目声明（acceptkit.project.json 的 smoke.<平台>.items，形状和用例断言一样：assert + observe），
// acceptkit 只负责执行、判定、按轮次落档，不写死任何业务逻辑。冒烟本身就是一次普通运行（用例 smoke-<平台>，
// kind=smoke）：读数由 observe 取、原文落盘、照样盲审 —— 和用例证据一样能复核，不是只记一个通过 / 不通过。
// 冒烟前先查环境（smoke env）：设备上的包是不是被测包、有没有别人留下的覆盖配置、有没有没登记的装包、宿主机扛不扛得住。
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { loadavg, cpus } from 'node:os';

export const smokeCaseId = p => `smoke-${p}`;
export const isSmokeCase = c => (c?.kind || '') === 'smoke';
export const smokeSpec = (cfg, p) => cfg?.smoke?.[p] || null;

/** 由项目声明生成冒烟用例。每次 acceptkit smoke 都按当前声明重写，声明改了用例跟着改 */
export function smokeCase(spec, p) {
  return {
    case: smokeCaseId(p), kind: 'smoke', platform: p,
    title: `冒烟（${p}）：这一轮的包能不能跑`,
    why: '包没跑通时跑用例，结论全是噪音。冒烟没过，这一轮不开用例运行。冒烟项由项目在 acceptkit.project.json 的 smoke 里声明',
    classifications: { carrier: ['runtime'] },
    tree: [{
      op: spec.op || '装好被测包、冷启一次', tags: { carrier: 'runtime' },
      expect: (spec.items || []).map(i => ({ ...i, id: String(i.id) })),
    }],
  };
}

/**
 * 一轮里的冒烟状态。runs：本需求、本轮、这个平台的冒烟运行（[{ id, r }]，按建的先后）。只看最新那次。
 * → { state: 'none' | 'running' | 'pass' | 'fail', run?, failed: [{ id, assert, status, actual }], env: { done, bad: [...] }, todo: [...] }
 */
export function smokeState(runs, spec) {
  if (!runs.length) return { state: 'none', failed: [], todo: [], env: { done: false, bad: [] } };
  const { id, r } = runs[runs.length - 1];
  const items = spec?.items || [];
  const res = r.results || {};
  const failed = [], todo = [];
  for (const i of items) {
    const x = res[String(i.id)] || { status: 'todo' };
    if (x.status === 'pass' || x.status === 'na') continue;
    if (x.status === 'todo') todo.push(String(i.id));
    else failed.push({ id: String(i.id), assert: i.assert, status: x.status, actual: String(x.actual || '').slice(0, 200) });
  }
  const env = { done: !!r.smoke_env, bad: (r.smoke_env?.checks || []).filter(c => c.ok !== true) }   // 读不到（ok=null）也不算过;
  const state = failed.length || env.bad.length ? 'fail' : (todo.length || !env.done ? 'running' : 'pass');
  return { state, run: id, failed, todo, env };
}

// ── 环境检查 ─────────────────────────────────────────────────────
// 每项 → { id, title, ok: true | false | null（读不到）, reading（原始读数）, why? }。读不到不算过：ok=null 也挡闸。
const sh = (bin, args, timeout = 20_000) => { const r = spawnSync(bin, args, { encoding: 'utf8', timeout, maxBuffer: 64 << 20 }); return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }; };

/** 宿主机：swap 用量和负载。模拟器在 swap 打满时会成片挂掉（实测 swap 31.4/32G 那天模拟器连挂十几轮） */
export function hostChecks({ maxSwapPct = 80, maxLoadPerCore = 1.5 } = {}, read = { swap: () => sh('sysctl', ['vm.swapusage']).out, load: () => loadavg()[0], cores: () => cpus().length }) {
  const out = [];
  const s = read.swap();
  const m = /total = ([\d.]+)M\s+used = ([\d.]+)M/.exec(s || '');
  if (!m) out.push({ id: 'host_swap', title: '宿主机 swap', ok: null, reading: s || '(读不到)', why: '读不到 swap 用量' });
  else { const pct = Number(m[1]) ? Math.round(Number(m[2]) / Number(m[1]) * 100) : 0;
    out.push({ id: 'host_swap', title: '宿主机 swap', ok: pct <= maxSwapPct, reading: s, ...(pct > maxSwapPct ? { why: `swap 用了 ${pct}%（上限 ${maxSwapPct}%）：先关掉不用的模拟器 / 浏览器再冒烟` } : {}) }); }
  const l = read.load(), n = read.cores(), per = l / n;
  out.push({ id: 'host_load', title: '宿主机负载', ok: per <= maxLoadPerCore, reading: `load1=${l.toFixed(2)} cores=${n}`, ...(per > maxLoadPerCore ? { why: `每核负载 ${per.toFixed(2)}（上限 ${maxLoadPerCore}）` } : {}) });
  return out;
}

// 装包时刻前后 10 分钟内，账本里对这台设备的装包 / 推文件命令：是哪个会话、哪个项目的哪个运行
function whoInstalled(ops, t) {
  const near = ops.filter(o => /\binstall\b|\bpush\b/.test(o.cmd || o.args || '') && Math.abs(Date.parse(o.at) - t) < 10 * 60e3);
  if (!near.length) return '（设备操作账本里查不到这次装包：多半是在 acceptkit 钩子管不到的地方装的，比如终端里手敲）';
  return `（账本里同一时段的装包 / 推文件：${near.slice(-3).map(o => `会话 ${String(o.session || '?').slice(0, 8)}${o.project ? ` · ${o.project}` : ''}${o.run ? ` · 运行 ${o.run}` : ''}${o.denied ? '（被拦下）' : ''} ${o.at}`).join('；')}）`;
}
/** 本地被测包的 sha256（和设备上装着的比） */
export const fileSha = f => createHash('sha256').update(readFileSync(f)).digest('hex');

/**
 * Android 设备上的检查。adb(args) → { ok, out }。
 * pkg：被测包名；apk：本地被测包路径（可不给，不给就记读不到）；overrideFiles：项目声明的「别人会留下的覆盖配置」路径；
 * installs：acceptkit 登记过的装包时刻（ms，过了目标闸的装包动作）；lastRun：这台设备上一次被哪个运行占着（{ run, demand, at }）。
 */
// ops：设备操作账本（钩子和 acceptkit adb 记的，带会话号），没登记的装包靠它查是谁装的
export function androidChecks({ adb, pkg, apk, overrideFiles = [], installs = [], lastRun = null, ops = [] }) {
  const out = [];
  // 1) 装着的是不是被测包
  const path = adb(['shell', 'pm', 'path', pkg]).out.split('\n').map(x => x.replace(/^package:/, '').trim()).find(x => /base\.apk$/.test(x));
  if (!path) out.push({ id: 'pkg_installed', title: '被测包装着', ok: false, reading: `pm path ${pkg} → (空)`, why: `设备上没装 ${pkg}` });
  else {
    const dev = adb(['shell', 'sha256sum', path]).out.split(/\s+/)[0] || '';
    let local = null, lerr = '';
    try { local = apk ? fileSha(apk) : null; } catch (e) { lerr = e.message; }
    if (!apk) out.push({ id: 'pkg_sha', title: '设备上的包 = 被测包', ok: null, reading: `device ${path} sha256=${dev}`, why: '没给被测包（--apk <本地包>），对不了' });
    else if (!local) out.push({ id: 'pkg_sha', title: '设备上的包 = 被测包', ok: null, reading: `device sha256=${dev}`, why: `读不了本地包：${lerr}` });
    else out.push({ id: 'pkg_sha', title: '设备上的包 = 被测包', ok: dev === local, reading: `device ${path} sha256=${dev}\nlocal ${apk} sha256=${local}`, ...(dev !== local ? { why: '设备上装的不是这一轮的被测包' } : {}) });
  }
  // 2) 别人留下的覆盖配置（例：另一个会话往同一台设备推了 mock 配置，开了熔断和忽略名单，当天读数全部作废）
  for (const f of overrideFiles) {
    const r = adb(['shell', `ls -l ${f} 2>/dev/null && head -c 400 ${f}`]);
    const has = r.ok && r.out && !/No such file/.test(r.out);
    out.push({ id: `override:${f}`, title: `没有残留的覆盖配置 ${f}`, ok: !has, reading: has ? r.out : '(不存在)', ...(has ? { why: `设备上有 ${f}：不是这一轮自己放的就先删掉（并查清是谁放的）` } : {}) });
  }
  // 3) 没登记的装包：包的最后安装时间晚于 acceptkit 登记过的最后一次装包
  const dump = adb(['shell', 'dumpsys', 'package', pkg]).out;
  const lut = /lastUpdateTime=([^\n]+)/.exec(dump)?.[1]?.trim();
  // lastUpdateTime 是设备本地时间、不带时区：取设备的时区偏移拼上，别按宿主机时区猜
  const tz = (/^([+-]\d{2})(\d{2})$/.exec(adb(['shell', 'date', '+%z']).out.trim()) || []).slice(1).join(':');
  const t = lut ? Date.parse(lut.replace(' ', 'T') + (tz || '')) : NaN;
  const lastReg = installs.length ? Math.max(...installs) : null;
  const who = lastRun ? `上一次占着这台的是运行 ${lastRun.run}${lastRun.demand ? `（${lastRun.demand}）` : ''}，${lastRun.at || ''}` : '这台没有 acceptkit 占用记录';
  if (!lut || Number.isNaN(t)) out.push({ id: 'install_registered', title: '装包都登记过', ok: null, reading: `lastUpdateTime=${lut || '(读不到)'}；${who}`, why: '读不到包的安装时间' });
  else {
    const ok = lastReg != null && t <= lastReg + 120_000;   // 登记在先、装在后，留两分钟余量
    out.push({ id: 'install_registered', title: '装包都登记过', ok,
      reading: `lastUpdateTime=${lut}；acceptkit 最近登记的装包：${lastReg ? new Date(lastReg).toISOString() : '(没有)'}；${who}`,
      ...(ok ? {} : { why: (lastReg ? '包在最后一次登记的装包之后又被装过，没走 acceptkit' : 'acceptkit 没有这台设备上的装包登记') + whoInstalled(ops, t) + '：按这一轮的被测包重装（过目标闸）' }) });
  }
  return out;
}
