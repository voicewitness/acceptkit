// 设置：执行流程里某一步要用、由用户设置进来的知识。流程是确定的，所以每项设置的位置和格式也是固定的，不在别的知识里搜。
//
// 位置按「这份做法归谁」定（宿主 = 项目配置 hosts 里登记的被测 App，见 hosts.mjs）：
//   构建     knowledge/settings/<平台>/<宿主>/build.md   每个 App 一份。两个 App 不能共用一份构建做法，
//                                                       否则第二个 App 进来只能覆盖第一个（二选一）。
//   驱动 App knowledge/settings/<平台>/driver.md         驱动工具跟平台走（iOS 一套、Android 一套），同平台的 App 共用；
//            knowledge/settings/<平台>/<宿主>/driver.md   某个 App 用不了共用的那套时，写它自己的，优先于共用的。
// 新 App 进来可以借鉴别的 App（本项目或别的项目）的做法：借鉴是拷一份成它自己的文件，标「推测」，
// 试通了再升级；走不通就改它自己的那份，不影响被借鉴的一方。不做运行时继承 —— 继承时源头一改，
// 借用方跟着悄悄变，也说不清当前生效的是谁的做法。
//
// 文件格式（人可以直接编辑）：
//   # iOS · 构建
//   - 状态：已确认              推测 | 已确认 | 已验证；推测不执行
//   - 来源：ref/build.md
//   ## 命令
//   - run: `cd {repo} && ./scripts/build.sh`
//   ## 说明
//   （自由文字：注意事项、踩过的坑。只给人和 agent 读，不参与执行）
//
// 命令里的 {port} {udid} {bundle} {repo} {text} 等占位由调用方填，值按 shell 单引号转义。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync } from 'node:fs';
import { join, relative } from 'node:path';

/** 流程里会用到的设置项。required = 这一步执行时一定会调用的动作。 */
// scope：host = 每个宿主一份；platform = 同平台共用，宿主可以有自己的一份覆盖它。
export const SLOTS = {
  build: { title: '构建', step: '把被测对象构建出来（改了会进包的代码、或用户要求时）', platforms: ['ios', 'android', 'web'], required: ['run'], scope: 'host' },
  driver: { title: '驱动 App', step: '操作 App、读 UI 层级（截图前的遮蔽层检查也用它）', platforms: ['ios', 'android'], required: ['ui-tree'], scope: 'platform' },
};
export const PLATFORM_TITLE = { ios: 'iOS', android: 'Android', web: 'Web' };
const STATE_OF = { '推测': 'guess', '已确认': 'confirmed', '已验证': 'verified' };
const LABEL_OF = { guess: '推测', confirmed: '已确认', verified: '已验证' };

/** host 为空 = 同平台共用的那份（只有 scope=platform 的设置有） */
export const settingPath = (root, slot, platform, host = null) => join(root, 'knowledge', 'settings', platform, ...(host ? [host] : []), `${slot}.md`);

function checkSlot(slot, platform, host) {
  const s = SLOTS[slot];
  if (!s) throw new Error(`没有「${slot}」这项设置；有：${Object.keys(SLOTS).join(' / ')}`);
  if (!s.platforms.includes(platform)) throw new Error(`${SLOTS[slot].title}设置只适用于 ${s.platforms.join(' / ')}`);
  if (host === null && s.scope === 'host') throw new Error(`${s.title}设置每个宿主一份：要给 --host`);
  return s;
}

/** 读某一份设置文件 → { path, rel, exists, state, source, commands, note } */
export function readSetting(root, slot, platform, host = null) {
  checkSlot(slot, platform, host);
  const path = settingPath(root, slot, platform, host), rel = relative(root, path);
  if (!existsSync(path)) return { path, rel, exists: false, commands: {} };
  const text = readFileSync(path, 'utf8');
  const sections = {}; let cur = '';
  for (const line of text.split('\n')) {
    const h = /^##\s+(.+)/.exec(line);
    if (h) { cur = h[1].trim(); continue; }
    (sections[cur] ||= []).push(line);
  }
  const head = (sections[''] || []).join('\n');
  const commands = {};
  for (const line of sections['命令'] || []) {
    const m = /^\s*-\s*([a-z][\w-]*)\s*[:：]\s*`(.+)`\s*$/.exec(line);
    if (m) commands[m[1]] = m[2];
  }
  return { path, rel, exists: true, commands,
    state: STATE_OF[/状态[:：]\s*(推测|已确认|已验证)/.exec(head)?.[1]] || 'guess',
    source: /来源[:：]\s*(.+)/.exec(head)?.[1]?.trim() || '',
    note: (sections['说明'] || []).join('\n').trim() };
}

/**
 * 这一步实际用哪份：宿主自己的优先；scope=platform 的设置没有宿主自己的就用共用的。
 * → readSetting 的结果 + own（是不是宿主自己的那份）
 */
export function effectiveSetting(root, slot, platform, host = null) {
  if (host) { const own = readSetting(root, slot, platform, host); if (own.exists || SLOTS[slot].scope === 'host') return { ...own, own: true }; }
  return { ...readSetting(root, slot, platform, null), own: false };
}

/** 写一份设置（整份覆盖）。缺必需动作就拒绝 —— 流程执行到这一步时一定会调用它们。 */
export function writeSetting(root, slot, platform, host, { commands, note = '', source = '', state = 'confirmed' }) {
  const s = checkSlot(slot, platform, host);
  const missing = s.required.filter(a => !commands[a]);
  if (missing.length) throw new Error(`${PLATFORM_TITLE[platform]} ${s.title}设置缺必需动作：${missing.map(a => `--${a}`).join(' ')}`);
  for (const [a, c] of Object.entries(commands)) if (c.includes('`')) throw new Error(`动作 ${a} 的命令里不能有反引号`);
  const path = settingPath(root, slot, platform, host);
  mkdirSync(join(path, '..'), { recursive: true });
  const body = [`# ${PLATFORM_TITLE[platform]}${host ? ` · ${host}` : ''} · ${s.title}`, '', `- 状态：${LABEL_OF[state]}`, ...(source ? [`- 来源：${source}`] : []), '',
    '## 命令', '', ...Object.entries(commands).map(([a, c]) => `- ${a}: \`${c}\``), '', ...(note ? ['## 说明', '', note, ''] : [])].join('\n');
  writeFileSync(path, body);
  try { chmodSync(path, 0o600); } catch { /* 非 POSIX 文件系统 */ }
  return { path, rel: relative(root, path) };
}

/** 改状态。note 追加进来源行（升级成已验证时写「什么时候、怎么核对的」） */
export function setState(root, slot, platform, host, state, note = '') {
  const r = readSetting(root, slot, platform, host);
  if (!r.exists) throw new Error(`还没有 ${r.rel}`);
  let text = readFileSync(r.path, 'utf8').replace(/状态[:：]\s*(推测|已确认|已验证)/, `状态：${LABEL_OF[state]}`);
  if (note) text = /来源[:：].*/.test(text) ? text.replace(/(来源[:：].*)/, `$1；${note}`) : text.replace(/(- 状态[:：].*)/, `$1\n- 来源：${note}`);
  writeFileSync(r.path, text);
  return r;
}

/**
 * 借鉴：把另一个宿主（本项目或别的项目目录）当前生效的那份拷成 host 自己的文件，标推测。
 * 已有自己的那份时拒绝 —— 借鉴只用在刚进来、还没有做法的时候，别把自己试出来的覆盖掉。
 */
export function borrowSetting(root, slot, platform, host, { fromRoot = root, fromHost }) {
  checkSlot(slot, platform, host);
  if (existsSync(settingPath(root, slot, platform, host))) throw new Error(`${host} 已经有自己的${SLOTS[slot].title}设置（${relative(root, settingPath(root, slot, platform, host))}），直接改它：acceptkit setting set`);
  if (fromRoot === root && fromHost === host) throw new Error('不能借鉴自己');
  const src = effectiveSetting(fromRoot, slot, platform, fromHost);
  if (!src.exists) throw new Error(`${fromRoot === root ? '' : `${fromRoot} 的`}${fromHost} 没有 ${PLATFORM_TITLE[platform]} ${SLOTS[slot].title}设置可借鉴`);
  const from = `${fromRoot === root ? '' : `${fromRoot}/`}${src.rel}`;
  const note = [`> 借鉴自 ${from}（原状态 ${LABEL_OF[src.state]}，${new Date().toISOString().slice(0, 10)}）。下面是原宿主的说明，不一定适用于 ${host}；试通后改成自己的。`, '', src.note].join('\n').trim();
  return { ...writeSetting(root, slot, platform, host, { commands: src.commands, note, source: `借鉴自 ${from}`, state: 'guess' }), from };
}

/** 本项目里可以借鉴的：同平台、其他宿主、已确认或已验证的那份 → [{ host, rel, state }] */
export function borrowCandidates(root, config, slot, platform, host) {
  return Object.keys(config.hosts || {}).filter(h => h !== host && config.hosts[h][platform]).map(h => ({ host: h, ...effectiveSetting(root, slot, platform, h) }))
    .filter(x => x.exists && x.own && x.state !== 'guess').map(x => ({ host: x.host, rel: x.rel, state: x.state }));
}

/**
 * 项目要哪些设置、各是什么状态：每个宿主 × 它登记的平台 × 每项设置，给出当前生效的那份。
 * → [{ slot, platform, host, title, step, rel, own, status, actions }]
 */
export function settingsStatus(root, config) {
  const out = [];
  for (const [host, h] of Object.entries(config.hosts || {}))
    for (const [slot, s] of Object.entries(SLOTS))
      for (const p of s.platforms.filter(x => h[x])) {
        const r = effectiveSetting(root, slot, p, host);
        out.push({ slot, platform: p, host, title: `${host} · ${PLATFORM_TITLE[p]} · ${s.title}`, step: s.step, rel: r.rel, own: r.own,
          status: !r.exists ? 'missing' : r.state, actions: Object.keys(r.commands) });
      }
  return out;
}

const quote = v => (/^[\w@%+=:,./-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`);

/** 填占位符 → { cmdLine } | { error } */
export function fill(cmd, vars) {
  const missing = [];
  const cmdLine = cmd.replace(/\{([a-z][\w-]*)\}/g, (m, k) => {
    const v = vars[k];
    if (v === undefined || v === null || v === '') { missing.push(k); return m; }
    return quote(String(v));
  });
  return missing.length ? { error: `命令缺参数 ${missing.map(k => `--${k}`).join(' ')}：${cmd}` } : { cmdLine };
}

/**
 * 取某项设置的某个动作，填好参数 → { cmdLine, rel, state } | { error }
 * tryGuess：推测的设置只在显式试跑（build/drive --try）时执行 —— 借鉴来的做法要先试一次才知道通不通。
 */
export function resolveAction(root, slot, platform, action, vars = {}, { host = null, tryGuess = false } = {}) {
  let r; try { r = effectiveSetting(root, slot, platform, host); } catch (e) { return { error: e.message }; }
  const t = `${host ? `${host} 的 ` : ''}${PLATFORM_TITLE[platform]} ${SLOTS[slot].title}设置`;
  const flags = `--platform ${platform}${host ? ` --host ${host}` : ''}`;
  if (!r.exists) return { error: `项目还没有${t}（${r.rel}）。告诉我怎么做（acceptkit setting set ${slot} ${flags} --${SLOTS[slot].required[0]} "<命令>"），或借鉴别的宿主：acceptkit setting borrow ${slot} ${flags} --from [<项目目录>:]<宿主>` };
  if (r.state === 'guess' && !tryGuess) return { error: `${t}（${r.rel}）还是推测：试跑一次 acceptkit ${slot === 'build' ? 'build' : 'drive <动作>'} ${flags} --try，或确认后执行：acceptkit setting confirm ${slot} ${flags}` };
  const cmd = r.commands[action];
  if (!cmd) return { error: `${t}（${r.rel}）里没有「${action}」动作；有：${Object.keys(r.commands).join(' / ')}` };
  const f = fill(cmd, vars);
  return f.error ? f : { cmdLine: f.cmdLine, rel: r.rel, state: r.state, own: r.own };
}

/** 执行某项设置的某个动作。inherit=true 时输出直接打到终端（构建这类长命令）。 */
export function runAction(root, slot, platform, action, vars = {}, { inherit = false, timeout, host = null, tryGuess = false } = {}) {
  const a = resolveAction(root, slot, platform, action, vars, { host, tryGuess });
  if (a.error) return a;
  const x = spawnSync('sh', ['-c', a.cmdLine], { cwd: root, encoding: 'utf8', timeout, maxBuffer: 256 * 1024 * 1024, stdio: inherit ? 'inherit' : 'pipe' });
  return { ref: a.rel, state: a.state, cmdLine: a.cmdLine, status: x.status, stdout: x.stdout || '', stderr: x.stderr || '',
           error: x.error ? `执行失败：${x.error.message}` : (x.status ? `命令退出码 ${x.status}` : undefined) };
}

/**
 * doctor --fix：旧位置 knowledge/settings/<平台>/build.md（每平台一份）→ 该平台唯一的宿主名下。
 * 该平台登记了多个宿主时不迁：这份构建做法是哪个 App 的，机器分不出来。
 * → [{ from, to } | { from, refused }]
 */
export function migrateSettings(root, config) {
  const out = [];
  for (const [slot, s] of Object.entries(SLOTS)) {
    if (s.scope !== 'host') continue;
    for (const p of s.platforms) {
      const from = settingPath(root, slot, p, null);
      if (!existsSync(from)) continue;
      const on = Object.keys(config.hosts || {}).filter(h => config.hosts[h][p]);
      if (on.length !== 1) { out.push({ from: relative(root, from), refused: on.length ? `${p} 有 ${on.length} 个宿主（${on.join(' / ')}），要人来定它归谁` : `${p} 还没有登记宿主` }); continue; }
      const to = settingPath(root, slot, p, on[0]);
      if (existsSync(to)) { out.push({ from: relative(root, from), refused: `${relative(root, to)} 已存在` }); continue; }
      mkdirSync(join(to, '..'), { recursive: true });
      renameSync(from, to);
      out.push({ from: relative(root, from), to: relative(root, to) });
    }
  }
  return out;
}
