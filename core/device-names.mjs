// 设备名跟着占用走：iOS 模拟器窗口标题就是设备名，改了名、下次切到 Simulator 时标题就刷新（实测，不用关机）。
// 被某个需求占着 → 「<原名> ▸ <需求号>」；放掉 → 改回原名。
// 不带需求标题、整名限 NAME_MAX_BYTES 字节：设备名会被被测 app 拼进 Bonjour 服务名（上限 63 字节），
// 带中文标题的长名让被测 app 冷启动 ~20s 在 dnssd 注册回调里 SIGABRT（实测连崩 5 次，改回短名即好）。
// 为什么要有：窗口标题只有「sim-acc-210814 – iOS 26.0」这种建机时随手起的名字，看的人不知道它在给哪个需求跑。
// Android 的标题是 AVD 名，开着改不了，见 renameAvd（只在关机时改）。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const SEP = ' ▸ ';
export const NAME_MAX_BYTES = 40;
const bytes = s => Buffer.byteLength(s, 'utf8');
export const baseName = n => String(n || '').split(SEP)[0];
/** 被占着时该叫什么。demand：{ id, title } 或 null */
export function nameFor(current, demand) {
  const base = baseName(current);
  if (!demand?.id) return base;
  const want = `${base}${SEP}${demand.id}`;
  return bytes(want) <= NAME_MAX_BYTES ? want : base;   // 放不下就不标，宁可窗口标题看不出需求，也不能让 app 崩
}
function simList() {
  const r = spawnSync('xcrun', ['simctl', 'list', 'devices', '-j'], { encoding: 'utf8', timeout: 15_000 });
  if (r.status !== 0) return [];
  try { return Object.values(JSON.parse(r.stdout).devices || {}).flat(); } catch { return []; }
}
/**
 * 按租约把 iOS 模拟器的名字对齐。leases：{ key: { run, platform } }；demandOf(run) → { id, title } | null。
 * 只动「被占着的」和「名字里带着 ▸、但已经没人占的」两种，别的设备名一个字不碰。返回改了哪些
 */
export function syncIosNames(leases, demandOf, { list = simList, rename = (u, n) => spawnSync('xcrun', ['simctl', 'rename', u, n], { timeout: 15_000 }).status === 0 } = {}) {
  const done = [];
  for (const d of list()) {
    const l = leases[d.udid];
    if (!l && !d.name.includes(SEP)) continue;
    const want = nameFor(d.name, l ? demandOf(l.run) : null);
    if (want !== d.name && rename(d.udid, want)) done.push({ udid: d.udid, from: d.name, to: want });
  }
  return done;
}

/** Android：AVD 名只能是字母数字和 . _ -；改名 = 改 ~/.android/avd/<名>.ini 的文件名（AVD 目录不动，ini 里 path= 指着它） */
export const AVD_NAME = /^[A-Za-z0-9._-]+$/;
export function renameAvd(from, to, avdHome = join(homedir(), '.android', 'avd')) {
  if (!AVD_NAME.test(to)) throw new Error(`AVD 名只能用英文字母、数字和 . _ -：${to}`);
  const src = join(avdHome, `${from}.ini`), dst = join(avdHome, `${to}.ini`);
  if (!existsSync(src)) throw new Error(`本机没有名为 ${from} 的 AVD（${src}）`);
  if (existsSync(dst)) throw new Error(`已经有一台叫 ${to} 的 AVD`);
  const path = /^path=(.+)$/m.exec(readFileSync(src, 'utf8'))?.[1]?.trim();
  if (!path || !existsSync(path)) throw new Error(`${from}.ini 里的 path= 指不到 AVD 目录，不敢改`);
  renameSync(src, dst);
  return { from, to, dir: path };
}
