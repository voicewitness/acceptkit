// 项目配置（acceptkit.project.json）的写口与校验。
//
// 白名单、被测 App、危险动作词这些都是用户设置进来的。此前只能手改 JSON：新建项目时提示「把设备写进 gate.allow」，
// 写错一个字段名（kind 写成 type、port 写成字符串）不会报错，只会让那一条静默失效 —— 白名单失效表现为全部拒绝，
// 危险动作词写错表现为该拦的不拦。所以每个键登记在 CONFIG_KEYS 里：写口按它校验，手改的文件也按它检查。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_NAME } from './project.mjs';
import { hostProblems, deviceHosts } from './hosts.mjs';

const ALLOW_KINDS = ['device', 'bundle', 'tenant'];
const regexOk = v => { try { new RegExp(v); return null; } catch (e) { return `不是合法正则：${e.message}`; } };
const str = v => typeof v === 'string' && v ? null : '要写成非空字符串';

/** 列表项的检查 → 错误文字或 null */
const allowItem = a => {
  if (!a || typeof a !== 'object') return '要写成 { value, kind, note }';
  if (!a.value) return '缺 value（设备号 / 包名 / 租户号）';
  if (!ALLOW_KINDS.includes(a.kind)) return `kind 只能是 ${ALLOW_KINDS.join(' / ')}`;
  if (!a.note) return '缺 note（这是什么、为什么允许）';
  if (a.onlyOn && !['ios', 'android'].includes(a.onlyOn)) return 'onlyOn 只能是 ios / android';
  if (a.profile && (typeof a.profile !== 'object' || Array.isArray(a.profile))) return 'profile 要写成 { 键: 值 }';
  const extra = Object.keys(a).filter(k => !['value', 'kind', 'note', 'onlyOn', 'profile'].includes(k));
  return extra.length ? `不认识的字段 ${extra.join(' ')}` : null;
};
const libraryItem = l => {
  if (!l || typeof l !== 'object') return '要写成 { id, file, title, intro?, evidenceDir?, labels? }';
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(l.id || ''))) return 'id 只能是小写字母、数字、连字符';
  if (!l.file) return '缺 file（库文件，相对项目目录）';
  if (l.labels && (typeof l.labels !== 'object' || Array.isArray(l.labels))) return 'labels 要写成 { 证据字段: 显示名 }';
  const extra = Object.keys(l).filter(k => !['id', 'file', 'title', 'intro', 'evidenceDir', 'labels'].includes(k));
  return extra.length ? `不认识的字段 ${extra.join(' ')}` : null;
};
const reasonItem = r => {
  if (!r || typeof r !== 'object') return '要写成 { id, actions, when, why, purpose, evidence?, by? }';
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(r.id || '')) || r.id === 'case') return 'id 只能是小写字母、数字、连字符（case 留给用例自带的理由）';
  if (!Array.isArray(r.actions) || !r.actions.length || r.actions.some(a => !['uninstall', 'clear'].includes(a))) return 'actions 要写成 ["uninstall"] / ["clear"] / 两个都写';
  for (const k of ['when', 'why', 'purpose']) if (!String(r[k] || '').trim()) return `缺 ${k}（${({ when: '什么情况下', why: '为什么必须这样做', purpose: '为了什么' })[k]}）`;
  if (String(r.when).trim().length < 8) return 'when 要写成认得出的具体情况（例：覆盖安装报签名不一致），不是「需要时」';
  if (r.evidence) {
    const e = regexOk(r.evidence); if (e) return `evidence ${e}`;
    // 什么都能匹配的特征等于没要求证据：理由就失去了能被核对的那一半
    if (['', 'ok', 'x', '0', 'Success'].some(t => new RegExp(r.evidence).test(t))) return `evidence /${r.evidence}/ 什么都能匹配，等于没要求证据：写成现场原始输出里才会出现的字样（报错码、读数的键名）`;
  }
  const extra = Object.keys(r).filter(k => !['id', 'actions', 'when', 'why', 'purpose', 'evidence', 'by', 'at', 'approved_by', 'quote'].includes(k));
  return extra.length ? `不认识的字段 ${extra.join(' ')}` : null;
};
const markerItem = m => !m?.match ? '缺 match（正则）' : regexOk(m.match) || (!m.why ? '缺 why（命中说明什么）' : null);
const jargonItem = j => !j?.match ? '缺 match（正则）' : regexOk(j.match) || (!j.say ? '缺 say（改成怎么说）' : null);

/** 每个键：类型、说明，以及列表项的主键（rm 时按它找） */
export const CONFIG_KEYS = {
  name: { type: 'string', title: '项目名' },
  pack: { type: 'string', title: '扩展钩子文件（相对项目目录）' },
  'gate.label': { type: 'string', title: '闸门名字' },
  'gate.allow': { type: 'list', title: '允许操作的设备 / 包名 / 租户', item: allowItem, key: 'value' },
  'gate.reasons': { type: 'list', title: '什么情况下可以卸载 / 清数据（执行者按经验登记：什么情况、为什么必须、为了什么、现场证据特征）；过闸时点名一条，acceptkit 按它核对', item: reasonItem, key: 'id' },
  'gate.targetKeys': { type: 'regex', title: '对象里哪些字段名算目标' },
  'gate.embeddedKeys': { type: 'regex', title: '多层编码的 JSON 串里兜底找的字段' },
  'gate.urlKeys': { type: 'regex', title: '网址参数里哪些算目标' },
  'gate.numericOnly': { type: 'bool', title: '目标值只认数字（租户号）' },
  hosts: { type: 'hosts', title: '被测 App（宿主）登记：acceptkit host add / rm' },
  'report.uiSteps': { type: 'enum', values: ['all'], title: 'all = 所有步骤都按界面步骤要求截图' },
  'quality.dangerOps': { type: 'regex', title: '项目特有的危险动作词（追加在通用词之后）' },
  'quality.extraKeys': { type: 'list', title: '用例里允许的项目字段', item: str },
  'quality.jargon': { type: 'list', title: '项目自己的行话（用例正文里不许出现）', item: jargonItem, key: 'match' },
  'apparatus.markers': { type: 'list', title: '取证手段自己的失败形状', item: markerItem, key: 'match' },
  'evidence.cardMarkers': { type: 'list', title: '项目自己的出卡工具写进图片的标记串（带这些标记的图算文字判定卡，不算截图证据）', item: str },
  libraries: { type: 'list', title: '挂载的用例库（常备用例 + 逐条证据）：acceptkit config add libraries --json \'{"id":…,"file":…,"title":…}\'', item: libraryItem, key: 'id' },
  'dup.objectKey': { type: 'regex', title: '查重：从用例操作和数据里认出被测对象的正则（捕获组拼起来就是对象键），不设就不按对象查重' },
  'dup.templateAsserts': { type: 'regex', title: '查重：套在每个对象上的模板断言句式（命中的不算重复）' },
  'newCase.classifications': { type: 'json', title: '新用例的切面骨架 { 切面: [取值] }' },
  'dashboard.title': { type: 'string', title: '看板标题' },
  'dashboard.tabTitle': { type: 'string', title: '看板页签标题' },
  'dashboard.hostMessagePrefix': { type: 'string', title: '宿主页面消息前缀' },
  'dashboard.locateBy': { type: 'enum', values: ['panel', 'run'], title: '看板按什么定位：panel = 面板键（内核看板，缺省）；run = 运行 id（项目自己的看板）' },
  'dashboard.url': { type: 'urltpl', title: '看板网址模板：{key} 填面板键，{run} 填运行 id（看板另外嵌在别的页面里时用；不设 = acceptkit 自己的管理页面）' },
};

function checkValue(key, v) {
  const s = CONFIG_KEYS[key];
  switch (s.type) {
    case 'string': return str(v);
    case 'number': return Number.isInteger(v) && v > 0 ? null : '要写成正整数';
    case 'bool': return typeof v === 'boolean' ? null : '要写成 true / false';
    case 'regex': return str(v) || regexOk(v);
    case 'urltpl': return str(v) || (/^(https?|file):\/\//.test(v) && /\{(key|run)\}/.test(v) ? null : '要写成以 http(s):// 或 file:// 开头、带 {key}（面板键）或 {run}（运行 id）的网址');
    case 'enum': return s.values.includes(v) ? null : `只能是 ${s.values.join(' / ')}`;
    case 'json': return v && typeof v === 'object' && !Array.isArray(v) ? null : '要写成 JSON 对象';
    case 'hosts': { const bad = hostProblems({ hosts: v }).filter(x => x.level === 'block'); return bad.length ? bad.map(x => `${x.key} ${x.msg}`).join('；') : null; }
    case 'list': {
      if (!Array.isArray(v)) return '要写成列表';
      const bad = v.map((x, i) => [i, s.item(x)]).filter(([, e]) => e);
      return bad.length ? bad.map(([i, e]) => `第 ${i + 1} 项 ${e}`).join('；') : null;
    }
  }
}

const getPath = (o, key) => key.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
function setPath(o, key, v) {
  const ks = key.split('.'); let x = o;
  for (const k of ks.slice(0, -1)) x = (x[k] ??= {});
  if (v === undefined) delete x[ks.at(-1)]; else x[ks.at(-1)] = v;
}
/** 配置里出现的全部叶子键（_note 之类以下划线开头的说明不算）。登记过的列表 / JSON 键不再往下拆。 */
function leafKeys(o, pre = '') {
  return Object.entries(o || {}).flatMap(([k, v]) => {
    if (k.startsWith('_')) return [];
    const key = pre + k;
    if (CONFIG_KEYS[key] || !v || typeof v !== 'object' || Array.isArray(v)) return [key];
    return leafKeys(v, key + '.');
  });
}

const cfgPath = root => join(root, CONFIG_NAME);
function readRaw(root) {
  const f = cfgPath(root);
  if (!existsSync(f)) throw new Error(`没有 ${CONFIG_NAME}：先 acceptkit project init`);
  return JSON.parse(readFileSync(f, 'utf8'));
}

/** 配置文件的问题：[{ key, level, msg }]。block = 这一项会静默失效；warn = 读的一方不认识这个键。 */
export function configProblems(raw) {
  const out = leafKeys(raw).flatMap(key => {
    if (key.split('.')[0] === 'app') return [{ key, level: 'block', msg: '旧写法：被测 App 改成按宿主登记（hosts）。acceptkit doctor --fix 迁移；一个平台有多个 App 的项目要手工拆，见 docs/architecture.md「宿主」' }];
    if (!CONFIG_KEYS[key]) return [{ key, level: 'warn', msg: '不认识的配置项（没有读者，写了等于没写）' }];
    const e = checkValue(key, getPath(raw, key));
    return e ? [{ key, level: 'block', msg: e }] : [];
  });
  out.push(...hostProblems(raw).filter(x => x.level === 'warn'));
  // 设备声明装着哪个宿主：写了没登记的宿主，按宿主挑设备时这台永远挑不中
  const hosts = Object.keys(raw.hosts || {});
  for (const a of raw.gate?.allow || []) for (const h of deviceHosts(a.profile))
    if (!hosts.includes(h)) out.push({ key: `gate.allow ${a.value}`, level: 'block', msg: `profile.host=${h} 没有登记成宿主（已登记：${hosts.join(' / ') || '无'}）` });
  return out;
}
export const projectConfigProblems = root => configProblems(readRaw(root));

/** 改一项，校验通过才落盘。mutate(当前值) → 新值；返回新值 */
function edit(root, key, mutate) {
  if (!CONFIG_KEYS[key]) throw new Error(`没有配置项 ${key}；有：\n${Object.keys(CONFIG_KEYS).map(k => `  ${k.padEnd(28)} ${CONFIG_KEYS[k].title}`).join('\n')}`);
  const raw = readRaw(root);
  const v = mutate(getPath(raw, key));
  if (v !== undefined) { const e = checkValue(key, v); if (e) throw new Error(`${key} ${e}`); }
  setPath(raw, key, v);
  writeFileSync(cfgPath(root), JSON.stringify(raw, null, 2) + '\n');
  return v;
}

/** 命令行给的字符串 → 该键的类型 */
export function parseValue(key, text) {
  const t = CONFIG_KEYS[key]?.type;
  if (t === 'number') return Number(text);
  if (t === 'bool') return text === 'true' ? true : text === 'false' ? false : text;
  if (t === 'json') { try { return JSON.parse(text); } catch { throw new Error(`${key} 要给 JSON`); } }
  return text;
}

export function setConfig(root, key, value) {
  if (CONFIG_KEYS[key]?.type === 'list') throw new Error(`${key} 是列表：用 config add / config rm`);
  return edit(root, key, () => value);
}
export const unsetConfig = (root, key) => edit(root, key, () => undefined);

/** 往列表里加一项；同主键的旧项被替换（同一台设备改备注不该出现两条） */
export function addConfig(root, key, item) {
  const s = CONFIG_KEYS[key];
  if (s?.type !== 'list') throw new Error(`${key} 不是列表`);
  return edit(root, key, cur => {
    const list = [...(cur || [])];
    const i = s.key ? list.findIndex(x => String(x[s.key]) === String(item[s.key])) : list.indexOf(item);
    if (i >= 0) list[i] = item; else list.push(item);
    return list;
  });
}
export function removeConfig(root, key, id) {
  const s = CONFIG_KEYS[key];
  if (s?.type !== 'list') throw new Error(`${key} 不是列表`);
  return edit(root, key, cur => {
    const list = cur || [];
    const left = list.filter(x => String(s.key ? x[s.key] : x) !== String(id));
    if (left.length === list.length) throw new Error(`${key} 里没有 ${id}`);
    return left;
  });
}

/**
 * 登记宿主（或给已有宿主补一个平台）。fields = { bundle | package | port | tabMatch }。
 * 同一个宿主同一个平台再写一次 = 改它，不新增第二条。
 */
export function addHost(root, id, platform, fields = {}, title) {
  return edit(root, 'hosts', cur => {
    const hosts = structuredClone(cur || {});
    const h = (hosts[id] ||= {});
    if (title) h.title = title;
    if (platform) h[platform] = { ...(h[platform] || {}), ...fields };
    return hosts;
  });
}
/** 删宿主；还被用例引用时拒绝 */
export function removeHost(root, id, usedBy = []) {
  if (usedBy.length) throw new Error(`宿主 ${id} 还被 ${usedBy.length} 条用例引用：${usedBy.slice(0, 8).join(' ')}${usedBy.length > 8 ? ' …' : ''}`);
  return edit(root, 'hosts', cur => {
    if (!cur?.[id]) throw new Error(`没有宿主 ${id}`);
    const { [id]: _, ...rest } = cur;
    return rest;
  });
}

/**
 * doctor --fix：旧写法 app: { ios, android, web, port } → hosts。
 * 只在能确定归属时迁：用例里写到的宿主不超过一个（用它的名字，没有就叫 main）。
 * 用例写了多个宿主的项目，旧 app 里每个平台属于哪个宿主机器猜不出来 —— 猜错就是把 A 的包名配给 B，所以不迁、报出来让人拆。
 * → { migrated: hostId } | { refused: 原因 } | null（没有旧写法）
 */
export function migrateAppToHosts(root, caseHostIds = []) {
  const raw = readRaw(root);
  if (!raw.app) return null;
  const ids = [...new Set(caseHostIds)];
  if (ids.length > 1) return { refused: `用例里写到了 ${ids.length} 个宿主（${ids.join(' / ')}），旧 app 里各平台归哪个宿主要人来定` };
  const id = ids[0] || 'main';
  const { port, ...plats } = raw.app;
  const h = { ...(raw.hosts?.[id] || {}) };
  for (const [p, v] of Object.entries(plats)) h[p] = { ...v, ...(h[p] || {}) };
  if (port && h.ios && !h.ios.port) h.ios.port = port;
  raw.hosts = { ...(raw.hosts || {}), [id]: h };
  delete raw.app;
  writeFileSync(cfgPath(root), JSON.stringify(raw, null, 2) + '\n');
  return { migrated: id };
}
