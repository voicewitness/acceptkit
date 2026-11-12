// project — 找到「项目目录」、读项目配置、加载项目的扩展钩子（pack.mjs）。
//
// 项目 = 一个目录，里面有 acceptkit.project.json、用例、运行记录、知识。内核不认识任何具体项目：
// 领域相关的东西（白名单、被测 App 的进程特征、私有观测通道、领域命令）全部从这里进来。
//
// 找项目的顺序（先到先得）：
//   1. 命令行 --project <dir>（从 argv 里摘掉，后续命令解析看不到它）
//   2. 环境变量 ACCEPTKIT_PROJECT
//   3. 从当前目录向上找 acceptkit.project.json
//   4. ~/.config/acceptkit/config.json 的 defaultProject
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir, userInfo } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_NAME = 'acceptkit.project.json';
export const USER_CONFIG = join(homedir(), '.config', 'acceptkit', 'config.json');

export function takeProjectFlag(argv = process.argv) {
  const i = argv.indexOf('--project');
  if (i < 0) return null;
  const v = argv[i + 1];
  if (!v || v.startsWith('--')) throw new Error('--project 需要一个目录');
  argv.splice(i, 2);
  return resolve(v);
}

function findUp(start) {
  let d = resolve(start);
  for (;;) {
    if (existsSync(join(d, CONFIG_NAME))) return d;
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/**
 * 这台电脑主人的身份：看板（只听本机）上点「批准 / 定」的人就是他，不用再填名字。
 * 顺序：用户配置里的 owner → git 的 user.name → 系统用户名。
 */
export function ownerIdentity() {
  const fromCfg = readUserConfig().owner;
  if (fromCfg) return String(fromCfg);
  try { const n = execFileSync('git', ['config', '--global', 'user.name'], { encoding: 'utf8', timeout: 3000 }).trim(); if (n) return n; } catch { /* 没装 git 或没配 */ }
  return userInfo().username;
}
export function readUserConfig() {
  try { return JSON.parse(readFileSync(USER_CONFIG, 'utf8')); } catch { return {}; }
}

export function resolveProjectRoot({ argv = process.argv, env = process.env, cwd = process.cwd() } = {}) {
  const flag = takeProjectFlag(argv);
  if (flag) return { root: flag, via: '--project' };
  if (env.ACCEPTKIT_PROJECT) return { root: resolve(env.ACCEPTKIT_PROJECT), via: 'ACCEPTKIT_PROJECT' };
  const up = findUp(cwd);
  if (up) return { root: up, via: 'cwd' };
  const u = readUserConfig();
  if (u.defaultProject) return { root: resolve(u.defaultProject), via: 'defaultProject' };
  return { root: null, via: null };
}

// 缺省配置：什么都不放行（闸门缺省拒绝），没有私有扩展。
export const DEFAULT_CONFIG = {
  name: '',
  gate: { label: '目标闸', allow: [], targetKeys: '^(sim|udid|device|device_id|bundle|bundle_id|bundleId|app_id|package)$' },
  hosts: {},
  newCase: null,
};

export function readConfig(root) {
  const f = join(root, CONFIG_NAME);
  if (!existsSync(f)) return { ...DEFAULT_CONFIG, _missing: true };
  let raw;
  try { raw = JSON.parse(readFileSync(f, 'utf8')); } catch (e) { throw new Error(`${f} 不是合法 JSON：${e.message}`); }
  return { ...DEFAULT_CONFIG, ...raw, gate: { ...DEFAULT_CONFIG.gate, ...(raw.gate || {}) }, hosts: { ...(raw.hosts || {}) } };
}

// pack.mjs 导出的钩子。约定见 docs/architecture.md「扩展模型」。缺哪个钩子，内核走通用路径或显式报缺。
export async function loadPack(root, config) {
  const rel = config.pack || 'pack.mjs';
  const f = join(root, rel);
  if (!existsSync(f)) return { _none: true };
  const mod = await import(pathToFileURL(f).href);
  return { ...(mod.default || {}), ...mod };
}

let cached = null;
export async function loadProject(opts = {}) {
  if (cached) return cached;
  const { root, via } = resolveProjectRoot(opts);
  if (!root) { cached = { root: null, via: null, config: { ...DEFAULT_CONFIG }, pack: { _none: true } }; return cached; }
  const config = readConfig(root);
  const pack = await loadPack(root, config);
  const cacheDir = join(root, '.acceptkit');
  cached = { root, via, config, pack, cacheDir };
  return cached;
}

export function ensureCacheDir(p) { mkdirSync(p.cacheDir, { recursive: true }); return p.cacheDir; }
