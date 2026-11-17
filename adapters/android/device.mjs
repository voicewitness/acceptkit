// Android 设备载体 —— 身份、状态、能力。
//
// 为什么单独一个文件（见 skill/devices.md 第一、三节）：
//  1. **serial 不是身份**。模拟器的 adb serial 形如 `emulator-<端口>`，端口按**启动顺序**分配。
//     同一个虚拟机今天一个号、明天另一个号；一个号今天指这台、明天指那台。
//     以 serial 为键的白名单/租约会在重启后静默指向另一台机器 —— 真实发生过，而且从输出里看不出来。
//     身份 = AVD 名（真机就用它自己的 serial，那个是稳定的）。
//  2. **状态必须能观测**。此前这里返回的是 `{ kind:'android' }` —— 一个只说明「它是安卓」的空壳。
//     于是「空闲」只能靠猜，选机器无从下手，占用也无从校验。
//     所以这里把五问答全：连接 · 开机完成 · 身份 · 被测进程 · 开机多久。
//  3. **设备不等价**。内存小 / GPU 关掉的虚拟机上，重 UI 的被测物会被软件渲染拖垮（决策为 0 + ANR 循环），
//     那台机器「开着且空闲」却跑不了这条用例。能力读出来，选择才能被复核。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';

const run = (bin, args, timeout = 8000) => {
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
};

/** adb 路径：环境变量 → 默认 SDK 位置 → PATH。找不到时返回 'adb'，由调用方处理失败。 */
export function adbBin() {
  const homes = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, join(homedir(), 'Library/Android/sdk'), join(homedir(), 'Android/Sdk')].filter(Boolean);
  for (const h of homes) { const p = join(h, 'platform-tools', 'adb'); if (existsSync(p)) return p; }
  return 'adb';
}
export function emulatorBin() {
  const p = join(adbBin(), '..', '..', 'emulator', 'emulator');
  return existsSync(p) ? p : null;
}
export const available = () => existsSync(adbBin()) || run('which', ['adb']).ok;

/** 当前连接的设备：[{ serial, link, kind }]；link = device|offline|unauthorized。 */
export function listDevices() {
  const r = run(adbBin(), ['devices']);
  if (!r.ok) return [];
  return r.out.split('\n').slice(1).map(l => l.trim()).filter(Boolean).map(l => {
    const [serial, link] = l.split(/\s+/);
    return { serial, link, kind: /^emulator-\d+$/.test(serial) ? 'emulator' : 'physical' };
  });
}

/** serial → AVD 名。两条通道：控制台 `emu avd name`（设备没起完也能答）、属性兜底。真机返回 null。 */
export function avdNameOf(serial) {
  if (!/^emulator-\d+$/.test(String(serial))) return null;
  const a = run(adbBin(), ['-s', serial, 'emu', 'avd', 'name']);
  if (a.ok) { const n = a.out.split('\n').map(s => s.trim()).filter(s => s && s !== 'OK')[0]; if (n) return n; }
  const b = run(adbBin(), ['-s', serial, 'shell', 'getprop', 'ro.boot.qemu.avd_name']);
  return b.ok && b.out ? b.out : null;
}

/** 设备身份（稳定键）：模拟器 `avd:<名>`，真机用 serial。反解不出 AVD 名时返回 null —— 宁可「不确定」。 */
export function identityOf(serial) {
  if (!/^emulator-\d+$/.test(String(serial))) return String(serial);
  const n = avdNameOf(serial);
  return n ? `avd:${n}` : null;
}

/** 身份 → 当前 serial（没连上返回 null）。接受 `avd:<名>`、裸 AVD 名、serial 三种写法。 */
export function addressOf(ref) {
  const s = String(ref || '');
  if (/^emulator-\d+$/.test(s)) return listDevices().some(d => d.serial === s) ? s : null;
  const want = s.replace(/^avd:/, '');
  for (const d of listDevices()) {
    if (d.kind === 'physical') { if (d.serial === want) return d.serial; continue; }
    if (avdNameOf(d.serial) === want) return d.serial;
  }
  return null;
}

export const bootCompleted = (serial) => run(adbBin(), ['-s', serial, 'shell', 'getprop', 'sys.boot_completed']).out === '1';
/** 这一次开机的编号：重启就变。占用时记下，之后每次动设备都核对 —— 同一个身份、换了一次开机，期间谁动过它都不知道 */
export const bootId = (serial) => { const r = run(adbBin(), ['-s', serial, 'shell', 'cat', '/proc/sys/kernel/random/boot_id']); return r.ok ? r.out.trim() || null : null; };
export const uptimeSec = (serial) => { const r = run(adbBin(), ['-s', serial, 'shell', 'cat', '/proc/uptime']); return r.ok ? Math.round(parseFloat(r.out.split(/\s+/)[0]) || 0) : null; };
export const pidOf = (serial, pkg) => { if (!pkg) return ''; const r = run(adbBin(), ['-s', serial, 'shell', 'pidof', pkg]); return r.ok ? (r.out.split(/\s+/)[0] || '') : ''; };
/** 已装被测包的版本（versionName）；没装或读不到返回 null */
export const versionOf = (serial, pkg) => { if (!pkg) return null; const r = run(adbBin(), ['-s', serial, 'shell', 'dumpsys', 'package', pkg]); return r.ok ? (/versionName=(\S+)/.exec(r.out)?.[1] || null) : null; };

const sleepMs = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/**
 * 启动一台 AVD 并等到开机完成（选设备第二档「启动」）。只起白名单里的那台由调用方保证。
 * 模拟器进程脱离本命令继续跑；等不到开机完成就报超时，不当作「起来了」。
 */
export function boot(ref, { timeoutMs = 180_000, place = null } = {}) {
  const name = String(ref || '').replace(/^avd:/, '');
  const e = emulatorBin();
  if (!e) return { ok: false, how: `没找到 emulator 程序：手动启动 AVD ${name}（Android Studio 设备管理器，或 emulator -avd ${name}）` };
  if (!listAvds().includes(name)) return { ok: false, how: `本机没有名为 ${name} 的 AVD：emulator -list-avds 看看有哪些` };
  // 用户偏好的显示器（prefs.devices.display）：模拟器启动时读 AVD 目录里 emulator-user.ini 的 window.x / window.y 定窗口位置
  if (place) placeWindow(join(homedir(), '.android', 'avd', `${name}.avd`, 'emulator-user.ini'), place);
  const child = spawn(e, ['-avd', name], { detached: true, stdio: 'ignore' });
  child.unref();
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    sleepMs(3000);
    const serial = addressOf(`avd:${name}`);
    if (serial && bootCompleted(serial)) return { ok: true, address: serial };
  }
  return { ok: false, how: `已经启动 AVD ${name}，${Math.round(timeoutMs / 1000)} 秒内没开机完成：等它起来，或手动看看模拟器窗口` };
}

/** 改 emulator-user.ini 里的窗口位置（其余行原样保留；文件不在就新建）。导出给测试用 */
export function placeWindow(ini, { x, y }) {
  let lines = []; try { lines = readFileSync(ini, 'utf8').split('\n').filter(l => l.trim() && !/^window\.(x|y)\s*=/.test(l)); } catch { /* 第一次起这台 */ }
  try { writeFileSync(ini, [`window.x = ${x}`, `window.y = ${y}`, ...lines].join('\n') + '\n'); } catch { /* 写不了就按模拟器自己记的位置开 */ }
}

/** 本机全部可启动的 AVD（包含没启动的 —— 「可以启动哪一台」是选择的第二档）。 */
export function listAvds() {
  const e = emulatorBin(); if (!e) return [];
  return run(e, ['-list-avds'], 15000).out.split('\n').map(s => s.trim()).filter(Boolean);
}

const toMB = (v) => {
  const s = String(v || '').trim();
  const m = /^(\d+(?:\.\d+)?)\s*([GgMm])?$/.exec(s);
  if (!m) return null;
  return Math.round(parseFloat(m[1]) * (/[Gg]/.test(m[2] || '') ? 1024 : 1));
};

/**
 * AVD 的能力：内存 / GPU / 核数 / 数据分区。
 * 这些值决定「这台能不能跑这条用例」，所以它们必须出现在选机器的输出里，而不是留在某个人的记忆里。
 */
export function avdProfile(name) {
  if (!name) return null;
  const p = join(homedir(), '.android', 'avd', `${name}.avd`, 'config.ini');
  if (!existsSync(p)) return null;
  const kv = {};
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const i = line.indexOf('='); if (i < 0) continue;
    kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const gpuOn = kv['hw.gpu.enabled'] === 'yes';
  return {
    ram_mb: toMB(kv['hw.ramSize']),
    cores: Number(kv['hw.cpu.ncore']) || null,
    gpu: gpuOn ? (kv['hw.gpu.mode'] || 'on') : 'off',
    data_mb: toMB(kv['disk.dataPartition.size']),
  };
}

/**
 * 一台设备的完整状态。五问全答，答不出的字段给 null —— 调用方据此记「不确定」，不许当「空闲」。
 * ref 可以是身份（`avd:<名>`）或 serial。
 */
export function deviceState(ref, pkg) {
  const serial = addressOf(ref);
  if (!serial) {
    const want = String(ref || '').replace(/^avd:/, '');
    const bootable = listAvds().includes(want);
    return { platform: 'android', identity: String(ref), address: null, connected: false,
             state: bootable ? '未启动' : '不存在', bootable, profile: avdProfile(want), app: null, running: null, uptime_sec: null };
  }
  const avd = avdNameOf(serial);
  const booted = bootCompleted(serial);
  const pid = pkg ? pidOf(serial, pkg) : '';
  return {
    platform: 'android', identity: avd ? `avd:${avd}` : serial, address: serial, connected: true,
    state: booted ? '已开机' : '启动中', bootable: true, avd, profile: avd ? avdProfile(avd) : null,
    app: pkg ? { package: pkg, pid: pid || null, version: versionOf(serial, pkg) } : null,
    running: pid ? `pid ${pid}` : null, uptime_sec: uptimeSec(serial),
  };
}

/** 能力是否满足要求：{ ram_mb: '>=8192', gpu: 'host', cores: '>=8' }。读不到能力 ⇒ 不确定（null），不是满足。 */
export function profileMeets(profile, need = {}) {
  const keys = Object.keys(need);
  if (!keys.length) return { ok: true, unmet: [], unknown: [] };
  if (!profile) return { ok: null, unmet: [], unknown: keys };
  const unmet = [], unknown = [];
  for (const k of keys) {
    const have = profile[k], want = String(need[k]);
    if (have === null || have === undefined) { unknown.push(k); continue; }
    const m = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(want);
    const op = m[1] || '=', rhs = m[2];
    const num = Number(rhs);
    const ok = Number.isFinite(num) && Number.isFinite(Number(have))
      ? ({ '>=': (a, b) => a >= b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '<': (a, b) => a < b, '=': (a, b) => a === b })[op](Number(have), num)
      : String(have) === rhs;
    if (!ok) unmet.push(`${k}=${have}（要 ${want}）`);
  }
  return { ok: unmet.length === 0 && unknown.length === 0 ? true : (unmet.length ? false : null), unmet, unknown };
}
