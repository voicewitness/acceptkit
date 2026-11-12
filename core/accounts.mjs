// accounts — 测试账号：acceptkit account list | get <id> <字段> | set <id> … | rm <id> | import <旧文件>。
//
// 账号属于项目（这个项目用哪些测试号），值属于这台机器：清单和值都存在用户目录
// ~/.config/acceptkit/accounts/<项目名>.json（0600），不进项目目录 —— 项目目录会被共享、打包、开源扫描，机密不能在那里。
// 元数据（id / 类型 / 平台 / 登录方式 / 说明）可以看；其余字段都是机密：list 不打印，证据、报告、日志里由 secrets.mjs 统一换成 ***。
// 为什么要有：实测执行者按文件名找账号，没找到就去问用户再要一遍；账号散在各项目自己的脚本里，acceptkit 不知道也遮不住。
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { readConfig } from './project.mjs';

const META = new Set(['id', 'kind', 'desc', 'platform', 'login', 'added', 'updated', 'by']);
const MIN_LEN = 4;   // 与 secrets.mjs 同口径：太短的值不遮，免得把常见词整篇替换掉

const projName = root => { try { return readConfig(root).name || basename(root); } catch { return basename(root); } };
export const accountsFile = root => join(homedir(), '.config', 'acceptkit', 'accounts', `${projName(root)}.json`);

export function loadAccounts(root) {
  const f = accountsFile(root);
  if (!existsSync(f)) return [];
  if (statSync(f).mode & 0o077) throw new Error(`${f} 别人也能读（权限不是 600）：chmod 600 后再用`);
  return JSON.parse(readFileSync(f, 'utf8')).accounts || [];
}
function save(root, list) {
  const f = accountsFile(root);
  mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
  writeFileSync(f, JSON.stringify({ accounts: list }, null, 2) + '\n', { mode: 0o600 });
  chmodSync(f, 0o600);
}
const secretsOf = a => Object.entries(a).filter(([k]) => !META.has(k));

/** 给 secrets.mjs：所有账号的机密字段值 */
export function accountSecretValues(root) {
  try { return loadAccounts(root).flatMap(a => secretsOf(a).map(([, v]) => String(v))).filter(v => v.length >= MIN_LEN); } catch { return []; }
}

/** acceptkit account …（需要项目） */
export function accountCmd({ pos, opt }, P, by) {
  const [sub = 'list', id, field] = pos;
  const list = loadAccounts(P.root);
  if (sub === 'list') {
    if (!list.length) return { text: `项目 ${projName(P.root)} 还没有登记测试账号。用户给了账号：acceptkit account set <id> --kind … --login … --field 手机号=… --by <他>` };
    return { text: list.map(a => `${a.id.padEnd(8)} ${String(a.kind || '').padEnd(10)} ${String(a.platform || '?').padEnd(7)} ${String(a.login || '?').padEnd(12)} 字段：${secretsOf(a).map(([k]) => k).join(', ')}  — ${a.desc || ''}`).join('\n')
      + `\n（值不打印。脚本取值：acceptkit account get <id> <字段>，直接喂给设备，不要 echo、不要写进运行目录）` };
  }
  if (sub === 'get') {
    const a = list.find(x => x.id === id) || (() => { throw new Error(`没有账号 ${id}：acceptkit account list 看有哪些`); })();
    if (!(field in a)) throw new Error(`账号 ${id} 没有字段 ${field}（有：${Object.keys(a).join(', ')}）`);
    return { raw: String(a[field]) };
  }
  if (sub === 'set') {
    if (!id) throw new Error('用法：acceptkit account set <id> [--kind ..] [--platform ..] [--login ..] [--desc ..] --field 名=值 … [--by <谁给的>]');
    const now = new Date().toISOString().slice(0, 10);
    const cur = list.find(x => x.id === id);
    const a = cur || { id, added: now };
    for (const k of ['kind', 'platform', 'login', 'desc']) if (typeof opt[k] === 'string') a[k] = opt[k];
    for (const kv of [opt.field].flat().filter(x => typeof x === 'string')) {
      const i = kv.indexOf('='); if (i < 1) throw new Error(`--field 要写成 名=值：${kv.split('=')[0]}`);
      a[kv.slice(0, i)] = kv.slice(i + 1);
    }
    a.by = typeof opt.by === 'string' ? opt.by : (a.by || by);
    if (cur) a.updated = now; else list.push(a);
    save(P.root, list);
    return { text: `✓ 账号 ${id} 已${cur ? '更新' : '登记'}（${accountsFile(P.root)}，只在这台机器上）；机密字段 ${secretsOf(a).map(([k]) => k).join(', ') || '无'} 在证据和报告里会被遮成 ***` };
  }
  if (sub === 'rm' || sub === 'remove') {
    // 用户说某个号不该用 / 已作废：从清单里摘掉（连同它的机密字段）。只动本项目这一份；旧文件不在这里管
    if (!id) throw new Error('用法：acceptkit account rm <id> [--why "<为什么删>"]');
    const cur = list.find(x => x.id === id) || (() => { throw new Error(`没有账号 ${id}：acceptkit account list 看有哪些`); })();
    save(P.root, list.filter(x => x !== cur));
    return { text: `✓ 账号 ${id} 已删除（${accountsFile(P.root)}）${typeof opt.why === 'string' ? `；理由：${opt.why}` : ''}。还剩：${list.filter(x => x !== cur).map(a => a.id).join('、') || '无'}` };
  }
  if (sub === 'import') {
    const src = id || (() => { throw new Error('用法：acceptkit account import <旧账号文件.json>（{ accounts: [{ id, … }] }）'); })();
    const incoming = JSON.parse(readFileSync(src, 'utf8')).accounts || [];
    // 旧登记常把说明写在值后面（「1234   # 某人某天给的」）：值只留 # 前面的，说明并进 desc —— 不然脚本取到的是整句
    for (const a of incoming) for (const [k, v] of secretsOf(a)) if (typeof v === 'string' && /\s#/.test(v)) {
      const i = v.search(/\s#/); a[k] = v.slice(0, i).trim(); a.desc = `${a.desc || ''}；${k}：${v.slice(i).replace(/^\s*#\s*/, '')}`;
    }
    const merged = [...list.filter(a => !incoming.some(b => b.id === a.id)), ...incoming];
    save(P.root, merged);
    return { text: `✓ 从 ${src} 导入 ${incoming.length} 个账号（${incoming.map(a => a.id).join('、')}）→ ${accountsFile(P.root)}。旧文件没动，确认无误后由用户决定删不删` };
  }
  throw new Error('用法：acceptkit account list | get <id> <字段> | set <id> … | rm <id> | import <旧文件>');
}
