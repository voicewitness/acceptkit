// 纯 Node 的 Chrome DevTools Protocol 驱动（无第三方依赖，Node 22 自带 fetch / WebSocket）。
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

// 直接 spawn Chrome 二进制。不要用 macOS 的 `open -na`：它经 LaunchServices，在用户的主 Chrome
// 已运行时会把 --remote-debugging-port 应用到主实例，调试端口开在用户真实会话上并弹授权框。
const DEFAULT_BIN = process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  : 'google-chrome';
export const CHROME_BIN = process.env.CHROME_BIN || DEFAULT_BIN;

/** 有没有 cmdline 带这个 user-data-dir 的活 Chrome 进程 —— 用来确认「这个端口上的 Chrome 是我们自己起的隔离实例」。 */
function ownInstanceAlive(profile) {
  try { execFileSync('pgrep', ['-f', `user-data-dir=${profile}`], { stdio: 'pipe' }); return true; } catch { return false; }
}

export async function cdpAlive(port) {
  try { const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- 浏览器台账：acceptkit 起的每个调试 Chrome 记一条（端口 → 用户目录、最后一次用的时间） ----
// 为什么要有：以前起了就不管，验收做完窗口一直开着，几天下来堆了一串没人用的 Chrome。
// 回收（sweepBrowsers）只认台账里的和登记过的项目目录里的，用户自己的 Chrome 不在里面，碰不到。
export const BROWSER_LEDGER = () => process.env.ACCEPTKIT_BROWSERS || join(homedir(), '.config', 'acceptkit', 'browsers');
// 一条 = 端口 + 用户目录：同一个端口上可能先后（甚至同时）有两个不同目录的实例，只按端口记会互相覆盖
const entryPath = (port, profile) => join(BROWSER_LEDGER(), `${Number(port)}-${createHash('sha1').update(String(profile)).digest('hex').slice(0, 8)}.json`);
const readFile = f => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
const ledgerFiles = () => { try { return readdirSync(BROWSER_LEDGER()).filter(f => /^\d+-[0-9a-f]{8}\.json$/.test(f)).map(f => join(BROWSER_LEDGER(), f)); } catch { return []; } };
/** 记一次使用。给了 profile 是起 / 复用；不给（Page 连上、发命令）只给台账里已有的续时间，不认领别人的端口 */
export function touchBrowser(port, profile = null, at = new Date().toISOString()) {
  try {
    // 只给端口（Page 连上 / 发命令）：分不清是这个端口上的哪个实例，台账里这个端口的都续上
    const profiles = profile ? [profile] : ledgerFiles().map(readFile).filter(e => e && e.port === Number(port)).map(e => e.profile);
    for (const p of profiles) {
      const e = readFile(entryPath(port, p));
      mkdirSync(BROWSER_LEDGER(), { recursive: true });
      writeFileSync(entryPath(port, p), JSON.stringify({ port: Number(port), profile: p, started: e?.started || at, last_used: at }) + '\n');
    }
  } catch { /* 台账写不了不影响验收本身 */ }
}
/** 本机带调试端口和独立用户目录的 Chrome 主进程（子进程带 --type=，排除） */
export function debugChromes() {
  let out = ''; try { out = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', maxBuffer: 32 << 20 }); } catch { return []; }
  const list = [];
  for (const line of out.split('\n')) {
    if (/--type=/.test(line) || !/--remote-debugging-port=\d+/.test(line) || !/--user-data-dir=/.test(line)) continue;
    const m = /^\s*(\d+)\s+(.*)$/.exec(line); if (!m) continue;
    if (!/chrom/i.test(m[2].split(' --')[0])) continue;
    list.push({ pid: Number(m[1]), port: Number(/--remote-debugging-port=(\d+)/.exec(m[2])[1]), profile: /--user-data-dir=(.+?)(?= --|$)/.exec(m[2])[1].trim() });
  }
  return list;
}
// 按进程关，不按端口发 Browser.close：同一个端口上可能有两个实例，端口归另一个的时候会关错。
// SIGTERM 让 Chrome 正常退出（cookie / 登录态写回用户目录）；10 秒还在才 SIGKILL
async function closeChrome(pid) {
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try { process.kill(pid, 'SIGTERM'); } catch {}
  for (let i = 0; i < 20 && alive(); i++) await sleep(500);
  if (alive()) { try { process.kill(pid, 'SIGKILL'); } catch {} await sleep(1000); }
  return alive() ? '没关掉（进程还在）' : '已关';
}
/**
 * 关掉空闲的调试 Chrome。台账里的：超过 idleMin 分钟没用就关；进程没了就删台账。
 * 不在台账里、但用户目录在登记过的项目下（旧版起的）：先收进台账，从现在起算空闲。
 * 其余（用户自己的、别的工具起的）一律不动。关的是窗口，用户目录（登录态）留着，下次 open 复用。
 */
export async function sweepBrowsers({ idleMin = 60, dry = false, roots = [], now = Date.now() } = {}) {
  const procs = debugChromes();
  const out = [];
  const seen = new Set();
  for (const f of ledgerFiles()) {
    const e = readFile(f); if (!e) continue;
    const p = procs.find(x => x.port === e.port && x.profile === e.profile);
    const row = { port: e.port, profile: e.profile };
    if (!p) { if (!dry) rmSync(f, { force: true }); out.push({ ...row, action: 'gone', why: '已经不在跑了，台账删掉' }); continue; }
    seen.add(p.pid);
    const idle = (now - Date.parse(e.last_used || e.started)) / 60e3;
    if (idle < idleMin) { out.push({ ...row, action: 'keep', why: `${Math.round(idle)} 分钟前还在用` }); continue; }
    const r = dry ? null : await closeChrome(p.pid);
    if (!dry && r === '已关') rmSync(f, { force: true });
    out.push({ ...row, action: 'close', why: `${Math.round(idle)} 分钟没用`, ...(r ? { result: r } : {}) });
  }
  for (const p of procs.filter(x => !seen.has(x.pid))) {
    const ours = roots.some(r => p.profile === r || p.profile.startsWith(r.replace(/\/$/, '') + '/'));
    if (!ours) { out.push({ port: p.port, profile: p.profile, action: 'foreign', why: '不是 acceptkit 起的，不动' }); continue; }
    if (!dry) touchBrowser(p.port, p.profile, new Date(now).toISOString());
    out.push({ port: p.port, profile: p.profile, action: 'adopt', why: `项目目录里的浏览器，之前没登记：收进台账，${idleMin} 分钟内没人用就关` });
  }
  return { idle_minutes: idleMin, dry_run: dry, browsers: out };
}

/** 起（或复用）一个独立用户目录的调试 Chrome。只复用「我们自己 profile 的活实例且端口活着」的情况，绝不连到别的 Chrome。 */
export async function launchDebugChrome({ port, profile, url = 'about:blank' }) {
  if (!port || !profile) throw new Error('launchDebugChrome 需要 port 与 profile');
  if (ownInstanceAlive(profile) && await cdpAlive(port)) { touchBrowser(port, profile); return { port, reused: true }; }
  if (await cdpAlive(port)) throw new Error(`端口 ${port} 上已有一个不是本项目起的 Chrome —— 换一个端口，避免连到别人的浏览器会话`);
  if (!existsSync(CHROME_BIN)) throw new Error(`Chrome 二进制不存在: ${CHROME_BIN}（设 CHROME_BIN 覆盖）`);
  mkdirSync(profile, { recursive: true });
  spawn(CHROME_BIN, [
    `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1',
    '--remote-allow-origins=*', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', url,
  ], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 30; i++) { await sleep(500); if (await cdpAlive(port)) { touchBrowser(port, profile); return { port, reused: false }; } }
  throw new Error('调试 Chrome 没有起来');
}

export class Page {
  constructor(port, matchUrl) { this.port = port; this.matchUrl = matchUrl; }
  async connect() {
    const list = await (await fetch(`http://127.0.0.1:${this.port}/json`)).json();
    const pages = list.filter(t => t.type === 'page');
    const p = (this.matchUrl && pages.find(t => new RegExp(this.matchUrl).test(t.url))) || pages[0];
    if (!p) throw new Error(`端口 ${this.port} 上没有打开的页面`);
    touchBrowser(this.port); this._touched = Date.now();
    this.target = p;
    this.ws = new WebSocket(p.webSocketDebuggerUrl); this._id = 0; this._pend = new Map();
    this.ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && this._pend.has(m.id)) { this._pend.get(m.id)(m); this._pend.delete(m.id); } };
    await new Promise((r, j) => { this.ws.onopen = r; this.ws.onerror = () => j(new Error('CDP WebSocket 连接失败')); });
    await this.send('Page.enable'); await this.send('Runtime.enable'); await this.send('Network.enable');
    return this;
  }
  send(method, params = {}) { if (Date.now() - (this._touched || 0) > 60e3) { touchBrowser(this.port); this._touched = Date.now(); } return new Promise((res, rej) => { const id = ++this._id; this._pend.set(id, m => m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async setCookies(cookies) { await this.send('Network.setCookies', { cookies: cookies.map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly })) }); }
  async nav(url) { await this.send('Page.navigate', { url }); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) return { __err: JSON.stringify(r.exceptionDetails).slice(0, 300) }; return r.result.value; }
  // 真实点击 = mouseMoved(hover) → pressed → released。缺 hover 时部分组件库的按钮不响应。
  async clickAt(x, y) { await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); await sleep(120); await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }); await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }); }
  // 有些页面在窄视口下会把按钮挤出可视区不渲染，需要调宽才点得到。
  async setViewport(width = 1920, height = 1000) { await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); }
  // 按可见文本 DOM .click()（跨域 iframe 用 clickAt 坐标）
  async clickText(text, exact = true) { return this.eval(`(()=>{const b=[...document.querySelectorAll('button,a,[role=button]')].filter(e=>e.offsetParent).find(e=>${exact ? `e.innerText.trim()===${JSON.stringify(text)}` : `e.innerText.includes(${JSON.stringify(text)})`});if(!b)return 'NOTFOUND';b.click();return 'CLICKED';})()`); }
  async shot(file) { const r = await this.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(file, Buffer.from(r.data, 'base64')); }
  async wait(ms) { await sleep(ms); }
  close() { try { this.ws.close(); } catch {} }
}

/** 页面上是否有可见的模态层（对话框 / 遮罩）。截图前查：被挡住的画面证明不了验收过程。 */
export async function genericObscuring(page) {
  const r = await page.eval(`(()=>{const v=e=>{const s=getComputedStyle(e);const b=e.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&+s.opacity>0.05&&b.width>40&&b.height>40;};
    const hits=[...document.querySelectorAll('[role=dialog],[aria-modal=true],dialog[open]')].filter(v).map(e=>(e.innerText||'').trim().slice(0,80));
    return {hits}})()`);
  if (!r || r.__err) return { ok: false, unknown: true, reason: `检查遮蔽层失败：${r?.__err || '无返回'}` };
  return r.hits.length ? { ok: false, hits: r.hits.map(t => ({ name: '页面上有可见的对话框', matched_text: t, how: '关掉它再截；若它就是被验对象，用 --allow-obscured "<理由>"' })) } : { ok: true };
}
