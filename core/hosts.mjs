// 宿主（被测 App）：一个项目可以在多个 App 里验同一个被测物（比如同一个引擎嵌在主 App 和示例 App 里），
// 新 App 也会随时加进来。凡是「每个 App 一份」的东西 —— 包名、构建做法、驱动做法、只在某个 App 上成立的操作配方 ——
// 都按宿主 id 存，不按平台存：按平台存时同一平台只能放一个 App，第二个 App 进来只能覆盖第一个（二选一）。
//
// 项目配置：
//   "hosts": { "<id>": { "title": "…", "ios": { "bundle", "port"? }, "android": { "package" }, "web": { "port", "tabMatch" } } }
// 用例的 host、白名单设备 profile.host、操作配方的 平台@宿主 键，引用的都是这里的 id。
export const HOST_ID = /^[a-z0-9][a-z0-9-]*$/;
export const HOST_PLATFORMS = ['ios', 'android', 'web'];

export const hostsOf = config => config?.hosts || {};

/** 有某个平台的宿主 id 列表 */
export const hostsOn = (config, platform) => Object.entries(hostsOf(config)).filter(([, h]) => h[platform]).map(([id]) => id);

/** 宿主在某平台的应用信息 { bundle | package | port | tabMatch }；没有给 {} */
export const hostApp = (config, id, platform) => (id && hostsOf(config)[id]?.[platform]) || {};

/** 应用标识：iOS 用 bundle，Android 用 package */
export const appIdOf = app => app.bundle || app.package || '';

/**
 * 这一步用哪个宿主 → { id } | { error }。
 * 顺序：显式指定（--host / 用例 host / 设备声明）→ 该平台只登记了一个宿主时就是它。
 * 有多个又没指定时报错，不挑第一个 —— 挑错了就是拿 A 的做法去操作 B。
 */
export function resolveHost(config, { host, platform } = {}) {
  const hosts = hostsOf(config);
  if (host) {
    if (!hosts[host]) return { error: `没有登记宿主 ${host}（已登记：${Object.keys(hosts).join(' / ') || '无'}）：acceptkit host add ${host} --platform ${platform || 'P'} …` };
    if (platform && !hosts[host][platform]) return { error: `宿主 ${host} 没有 ${platform} 端（acceptkit host add ${host} --platform ${platform} …）` };
    return { id: host };
  }
  const on = platform ? hostsOn(config, platform) : Object.keys(hosts);
  if (on.length === 1) return { id: on[0] };
  if (!on.length) return { error: `项目没有登记${platform ? ` ${platform} 端的` : ''}宿主：acceptkit host add <id> --platform ${platform || 'P'} …` };
  return { error: `项目有多个${platform ? ` ${platform} ` : ''}宿主（${on.join(' / ')}），要指定是哪个：用例写 host，或命令带 --host` };
}

/** 配置里宿主登记的问题 → [{ key, level, msg }] */
export function hostProblems(config) {
  const out = [];
  for (const [id, h] of Object.entries(hostsOf(config))) {
    const key = `hosts.${id}`;
    if (!HOST_ID.test(id)) out.push({ key, level: 'block', msg: '宿主 id 只能用小写字母、数字、连字符' });
    if (!h || typeof h !== 'object') { out.push({ key, level: 'block', msg: '要写成 { title, ios|android|web: {…} }' }); continue; }
    const plats = HOST_PLATFORMS.filter(p => h[p]);
    if (!plats.length) out.push({ key, level: 'block', msg: '没有任何平台（ios / android / web）' });
    for (const k of Object.keys(h)) if (k !== 'title' && !HOST_PLATFORMS.includes(k)) out.push({ key: `${key}.${k}`, level: 'warn', msg: '不认识的字段' });
    if (h.ios && !h.ios.bundle) out.push({ key: `${key}.ios`, level: 'block', msg: '缺 bundle' });
    if (h.android && !h.android.package) out.push({ key: `${key}.android`, level: 'block', msg: '缺 package' });
    for (const p of ['ios', 'android']) if (h[p]?.port !== undefined && !(Number.isInteger(h[p].port) && h[p].port > 0)) out.push({ key: `${key}.${p}.port`, level: 'block', msg: '要写成正整数' });
    if (h.web) {
      if (!(Number.isInteger(h.web.port) && h.web.port > 0)) out.push({ key: `${key}.web.port`, level: 'block', msg: '要写成正整数（独立浏览器实例的调试端口）' });
      if (h.web.tabMatch) { try { new RegExp(h.web.tabMatch); } catch (e) { out.push({ key: `${key}.web.tabMatch`, level: 'block', msg: `不是合法正则：${e.message}` }); } }
    }
    const known = { ios: ['bundle', 'port'], android: ['package', 'port'], web: ['port', 'tabMatch'] };
    for (const p of plats) for (const k of Object.keys(h[p] || {})) if (!known[p].includes(k)) out.push({ key: `${key}.${p}.${k}`, level: 'warn', msg: '不认识的字段' });
  }
  return out;
}

/** 用例在某平台上的宿主：host 可以是一个 id，也可以按平台分写 { ios: "a", android: "b" }（两端宿主不同的跨端用例） */
export const hostOfCase = (c, platform) => (c?.host && typeof c.host === 'object' ? c.host[platform] || null : c?.host || null);
/** 用例引用到的全部宿主 id */
export const caseHosts = c => (c?.host && typeof c.host === 'object' ? Object.values(c.host) : c?.host ? [c.host] : []).map(String);
/** 设备声明装着哪些宿主（profile.host 可写一个或一个列表） */
export const deviceHosts = profile => [].concat(profile?.host || []).map(String);

/** 某个宿主引用（用例 host / 设备 profile.host）有没有登记 → 错误文字或 null */
export const unknownHost = (config, id) => (id && !hostsOf(config)[id] ? `宿主 ${id} 没有登记（已登记：${Object.keys(hostsOf(config)).join(' / ') || '无'}）` : null);
