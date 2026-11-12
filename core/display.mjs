// display — 设备窗口开在哪块显示器上（用户自己的偏好 prefs.devices.display，见 acceptkit prefs）。
//
// 只有 macOS：用系统自带的 JXA 读 NSScreen。坐标换成「主屏左上角为原点、向下为正」—— 模拟器窗口位置用的是这套
// （AppKit 的原点在主屏左下角、向上为正，直接用会把窗口放到屏幕外）。读不到就返回空，调用方照旧不指定位置。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readUserConfig, readConfig } from './project.mjs';
import { placeWindow } from '../adapters/android/device.mjs';

export const DISPLAY_PREFS = { leftmost: '最左边那块', rightmost: '最右边那块', main: '主屏（有菜单栏的那块）' };

export function screens() {
  if (process.platform !== 'darwin') return [];
  const js = 'ObjC.import("AppKit");var s=$.NSScreen.screens,o=[];for(var i=0;i<s.count;i++){var f=s.objectAtIndex(i).frame;o.push([f.origin.x,f.origin.y,f.size.width,f.size.height])}JSON.stringify(o)';
  const r = spawnSync('osascript', ['-l', 'JavaScript', '-e', js], { encoding: 'utf8', timeout: 5000 });
  let raw = []; try { raw = JSON.parse(r.stdout || '[]'); } catch { return []; }
  return toTopLeft(raw);
}
/** AppKit 的 [x, y, w, h]（第一项是主屏）→ 左上角坐标的 { x, y, w, h, main } */
export function toTopLeft(raw) {
  if (!raw.length) return [];
  const mainH = raw[0][3];
  return raw.map(([x, y, w, h], i) => ({ x, y: mainH - (y + h), w, h, main: i === 0 }));
}
/** 偏好 → 那块显示器。数字 = 从左往右数第几块（1 起） */
export function pickScreen(pref, list = screens()) {
  if (!pref || !list.length) return null;
  const byX = [...list].sort((a, b) => a.x - b.x);
  if (pref === 'leftmost') return byX[0];
  if (pref === 'rightmost') return byX[byX.length - 1];
  if (pref === 'main') return list.find(s => s.main) || null;
  const n = Number(pref);
  return Number.isInteger(n) && n >= 1 && n <= byX.length ? byX[n - 1] : null;
}
/** 设备窗口放在那块显示器左上角往里一点 */
export const placeOn = s => (s ? { x: Math.round(s.x + 40), y: Math.round(s.y + 40) } : null);

/**
 * 把偏好预先写进本机每台验收 AVD（各项目 gate.allow 里的 avd:*）的窗口位置。
 * 为什么不只在 acceptkit 自己起模拟器时写：实测执行者手动 `emulator -avd …` 起了一台，偏好完全没生效。
 * 模拟器启动时读 emulator-user.ini、退出时把当时的位置写回去，所以在 prefs set / 占用 / 释放 时都重写一遍，
 * 谁起的都开在那块屏上。没设偏好、读不到显示器 → 什么都不写。返回写了哪些 AVD
 */
export function applyDevicePref() {
  const place = placeOn(pickScreen(readUserConfig().prefs?.devices?.display));
  if (!place) return [];
  const avds = new Set();
  for (const root of readUserConfig().projects || []) {
    let cfg; try { cfg = readConfig(root); } catch { continue; }
    for (const a of cfg.gate?.allow || []) if (a.kind === 'device' && /^avd:/.test(a.value)) avds.add(a.value.slice(4));
  }
  const done = [];
  for (const n of avds) {
    const dir = join(homedir(), '.android', 'avd', `${n}.avd`);
    if (existsSync(dir)) { placeWindow(join(dir, 'emulator-user.ini'), place); done.push(n); }
  }
  return done;
}
