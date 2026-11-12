// 纯 Node 的 Chrome DevTools Protocol 驱动（无第三方依赖，Node 22 自带 fetch / WebSocket）。
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';

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

/** 起（或复用）一个独立用户目录的调试 Chrome。只复用「我们自己 profile 的活实例且端口活着」的情况，绝不连到别的 Chrome。 */
export async function launchDebugChrome({ port, profile, url = 'about:blank' }) {
  if (!port || !profile) throw new Error('launchDebugChrome 需要 port 与 profile');
  if (ownInstanceAlive(profile) && await cdpAlive(port)) return { port, reused: true };
  if (await cdpAlive(port)) throw new Error(`端口 ${port} 上已有一个不是本项目起的 Chrome —— 换一个端口，避免连到别人的浏览器会话`);
  if (!existsSync(CHROME_BIN)) throw new Error(`Chrome 二进制不存在: ${CHROME_BIN}（设 CHROME_BIN 覆盖）`);
  mkdirSync(profile, { recursive: true });
  spawn(CHROME_BIN, [
    `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1',
    '--remote-allow-origins=*', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', url,
  ], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 30; i++) { await sleep(500); if (await cdpAlive(port)) return { port, reused: false }; }
  throw new Error('调试 Chrome 没有起来');
}

export class Page {
  constructor(port, matchUrl) { this.port = port; this.matchUrl = matchUrl; }
  async connect() {
    const list = await (await fetch(`http://127.0.0.1:${this.port}/json`)).json();
    const pages = list.filter(t => t.type === 'page');
    const p = (this.matchUrl && pages.find(t => new RegExp(this.matchUrl).test(t.url))) || pages[0];
    if (!p) throw new Error(`端口 ${this.port} 上没有打开的页面`);
    this.target = p;
    this.ws = new WebSocket(p.webSocketDebuggerUrl); this._id = 0; this._pend = new Map();
    this.ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && this._pend.has(m.id)) { this._pend.get(m.id)(m); this._pend.delete(m.id); } };
    await new Promise((r, j) => { this.ws.onopen = r; this.ws.onerror = () => j(new Error('CDP WebSocket 连接失败')); });
    await this.send('Page.enable'); await this.send('Runtime.enable'); await this.send('Network.enable');
    return this;
  }
  send(method, params = {}) { return new Promise((res, rej) => { const id = ++this._id; this._pend.set(id, m => m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)); this.ws.send(JSON.stringify({ id, method, params })); }); }
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
