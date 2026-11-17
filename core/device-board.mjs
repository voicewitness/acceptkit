// device-board — 「本机设备」一条：每台在跑的设备被什么占着，一眼看明白（看板顶部现取，见 server.mjs /devices）。
//
// 为什么要有：模拟器窗口标题只有设备名（Android 是「AVD 名:端口」），读的人不知道它在给哪个需求跑、还有没有人在用；
// 执行者也会绕开 device acquire 自己起模拟器（实测：克隆一个 AVD、删掉锁文件再起），acceptkit 的台账完全不知道。
// 这里把三样东西对一遍：实际在跑的设备、acceptkit 的租约、租约指向的运行 —— 对不上的就直说。
// 只读：不起、不关、不改租约（那些要人点头）。
import { existsSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as ANDROID from '../adapters/android/device.mjs';
import { loadLeases } from './store/db.mjs';
import { readUserConfig, readConfig } from './project.mjs';

const STALE_H = 8;   // 与 engine.mjs LEASE_STALE_H 同口径：这么久没续期视为过期
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ago = ms => ms < 3600e3 ? `${Math.max(1, Math.round(ms / 60e3))} 分钟` : ms < 86400e3 ? `${Math.round(ms / 3600e3)} 小时` : `${Math.round(ms / 86400e3)} 天`;
const readJSON = f => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

function runInfo(root, run) {
  const r = readJSON(join(root, 'runs', run, 'result.json'));
  if (!r) return null;
  const c = readJSON(join(root, 'cases', `${r.case}.case.json`));
  return { demand: r.demand?.id || r.demand || null, caseTitle: c?.title || r.case };
}

/** → [{ window, platform, use, level: 'ok'|'warn'|'bad' }]，外加「台账上占着、设备却没开」的 */
const projName = r => { try { return readConfig(r).name || basename(r); } catch { return basename(r); } };
export function deviceRows(root, others = (readUserConfig().projects || []).filter(r => r !== root)) {
  const leases = loadLeases(root);
  const used = new Set();
  const rows = [];
  // 设备是整台机器共用的，台账却按项目分：只看本项目，别的项目正在用的机器会被说成「不知道谁在用」。
  // 先看本项目，再看其它登记过的项目的占用和白名单
  const leaseFor = keys => {
    for (const k of keys) if (leases[k]) { used.add(k); return { l: leases[k], at: root }; }
    for (const r of others) { let ls; try { ls = loadLeases(r); } catch { continue; } for (const k of keys) if (ls[k]) return { l: ls[k], at: r }; }
    return null;
  };
  const allowOf = keys => {
    for (const r of [root, ...others]) { let cfg; try { cfg = readConfig(r); } catch { continue; }
      const a = (cfg.gate?.allow || []).find(x => x.kind === 'device' && keys.includes(x.value)); if (a) return { a, at: r }; }
    return null;
  };
  const useOf = (hit, keys) => {
    if (!hit) {
      const w = allowOf(keys);
      if (w) return { use: `${w.at === root ? '' : `${projName(w.at)} 项目的`}验收机${w.a.note ? `（${w.a.note}）` : ''}，现在没人占着${w.a.keep_on ? '，白名单写了常开' : '，空闲超时会被回收关机'}`, level: 'ok' };
      return { use: '不在 acceptkit 台账里：不是通过 acceptkit 起的，谁在用、给哪个需求跑都不知道', level: 'bad' };
    }
    const { l, at } = hit;
    const info = runInfo(at, l.run);
    const proj = at === root ? '' : `${projName(at)} 项目 · `;
    const idle = Date.now() - Date.parse(l.heartbeat || l.since);
    const who = proj + (info ? `${info.demand || ''} · ${info.caseTitle}` : `运行 ${l.run}`);
    // 没续期不等于没人用：可能早没人用了，也可能有人在用却没走 acceptkit（实测：手动重启了模拟器、租约还停在两天前）
    if (idle > STALE_H * 3600e3) return { use: `台账上是 ${who} 占着，但 ${ago(idle)}没续期：要么早没人用了，要么有人在用却没走 acceptkit —— 先问清楚再动`, level: 'warn' };
    return { use: `${who}（${l.holder}），${ago(idle)}前还在用`, level: 'ok' };
  };
  if (ANDROID.available()) for (const d of ANDROID.listDevices()) {
    const id = ANDROID.identityOf(d.serial);
    const avd = id?.startsWith('avd:') ? id.slice(4) : null;
    const port = /emulator-(\d+)/.exec(d.serial)?.[1];
    rows.push({ window: avd ? `${avd}:${port}` : d.serial, platform: 'Android', ...useOf(leaseFor([id, d.serial].filter(Boolean)), [id, d.serial].filter(Boolean)) });
  }
  const sim = spawnSync('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], { encoding: 'utf8', timeout: 10_000 });
  try {
    for (const list of Object.values(JSON.parse(sim.stdout || '{}').devices || {})) for (const d of list) {
      rows.push({ window: d.name, platform: 'iOS 模拟器', udid: d.udid, ...useOf(leaseFor([d.udid]), [d.udid]) });
    }
  } catch { /* 没装 Xcode 或没开模拟器 */ }
  for (const [k, l] of Object.entries(leases)) if (!used.has(k)) {
    const info = runInfo(root, l.run);
    rows.push({ window: k, platform: l.platform || '', use: `台账上被 ${info ? `${info.demand || ''} · ${info.caseTitle}` : `运行 ${l.run}`} 占着，但这台现在没开：可以放掉`, level: 'warn', off: true });
  }
  return rows;
}

export function deviceBoardHtml(root) {
  const rows = deviceRows(root);
  if (!rows.length) return '<div class="devs dim">本机设备：没有在跑的</div>';
  const on = rows.filter(r => !r.off).length, bad = rows.filter(r => r.level !== 'ok').length;
  return `<details class="devs"${bad ? ' open' : ''}><summary><b>本机设备</b> ${on} 台在跑${bad ? ` · <span class="t-bad">${bad} 处对不上</span>` : ''}</summary><ul>`
    + rows.map(r => `<li class="dv-${r.level}"><code>${esc(r.window)}</code> <span class="dim">${esc(r.platform)}</span> — ${esc(r.use)}</li>`).join('')
    + `</ul><div class="dim">窗口标题就是左边这个名字：iOS 被需求占着时 acceptkit 会在名字后面加「 ▸ 需求」（切到 Simulator 时刷新）；Android 的是 AVD 名，关机时可以 <code>acceptkit device rename avd:&lt;旧名&gt; --to &lt;新名&gt;</code>。对不上的要先问清楚再动，acceptkit 不会替你关设备。</div></details>`;
}
