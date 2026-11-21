// 本机管理页面：acceptkit 自己的网站，不依赖别的宿主页面嵌入。
//
//   /                     项目列表（登记过的项目：用例数、最近一次运行、进各项目的看板）
//   /p/<项目>/             该项目的看板（#run=<面板键> 直接停在某份报告上，见 links.mjs）
//   /p/<项目>/asset?f=…    看板里的截图，按需出图（不内联进 HTML —— 大项目内联后页面会超出字符串上限）
//   /p/<项目>/evidence?f=… 证据原文（点开时才取；只出 runs/ 与 evidence/ 下的文件，最多 400KB）
//   /p/<项目>/panel?k=…   一个面板的内容 + 它用到的证据表（看板首屏只带面板空壳；切到哪一面才渲染哪一面，见 forkBoard）
//   POST /p/<项目>/decide  owner 在裁定页写下决定 → acceptkit plan decide；或「看不懂，退回」→ plan bounce（唯一的写入口）
//   /healthz              { ok, projects } —— link / open 用它判断服务在不在
//
// 默认只监听 127.0.0.1：看板里是被测系统的内部数据，不对局域网开放；要开放得显式 --host。
// 看板按需生成并缓存：项目数据（用例、运行、评审单、操作库、配置）有变化才重新读数据；面板点到才渲染。
import { createServer } from 'node:http';
import { spawn, fork } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, mkdirSync, createReadStream, openSync, readSync, closeSync, appendFileSync, realpathSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { join, resolve, sep, extname, basename } from 'node:path';
import { gzipSync } from 'node:zlib';
import { readConfig, loadPack, REPO_ROOT, ownerIdentity } from './project.mjs';

const IMG = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** 项目 id：配置里的 name（只留网址安全的字符），重名时退到目录名 */
export function projectIds(roots) {
  const out = []; const seen = new Set();
  for (const root of roots) {
    let name = ''; try { name = readConfig(root).name || ''; } catch { /* 配置坏了也要能列出来 */ }
    let id = (name || basename(root)).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
    if (seen.has(id)) id = `${id}-${basename(root).toLowerCase().replace(/[^a-z0-9._-]+/g, '-')}`;
    seen.add(id); out.push({ id, root, name: name || basename(root) });
  }
  return out;
}

/** 项目数据的指纹：任何一处改了，看板就要重新生成 */
function fingerprint(root, script) {
  let n = 0, t = 0;
  const add = f => { try { const s = statSync(f); n++; t = Math.max(t, s.mtimeMs); } catch { /* 不存在 */ } };
  for (const f of ['acceptkit.project.json', 'ops/registry.json', 'cases', 'runs', script]) add(join(root, f));
  for (const d of ['cases', 'state', 'state/plans', 'state/rounds', 'state/review']) {
    const p = join(root, d);
    if (existsSync(p)) for (const f of readdirSync(p)) add(join(p, f));
  }
  const runs = join(root, 'runs');
  if (existsSync(runs)) for (const r of readdirSync(runs)) for (const f of ['result.json', 'run.md', 'run.json', 'shots']) add(join(runs, r, f));
  add(script);
  return `${n}:${t}`;
}

function summary(p) {
  const cases = existsSync(join(p.root, 'cases')) ? readdirSync(join(p.root, 'cases')).filter(f => f.endsWith('.case.json')).length : 0;
  let last = null;
  const runs = join(p.root, 'runs');
  if (existsSync(runs)) for (const r of readdirSync(runs)) {
    try { const t = statSync(join(runs, r, 'result.json')).mtimeMs; if (!last || t > last.t) last = { r, t }; } catch { /* 没有结果的目录 */ }
  }
  return { cases, last };
}

function indexPage(projects) {
  const rows = projects.map(p => {
    const s = summary(p);
    return `<a class="card" href="/p/${esc(p.id)}/"><b>${esc(p.name)}</b><span>${s.cases} 条用例${s.last ? ` · 最近运行 ${esc(s.last.r)}（${new Date(s.last.t).toLocaleString('zh-CN', { hour12: false })}）` : ' · 还没有运行'}</span><small>${esc(p.root)}</small></a>`;
  }).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>acceptkit</title>
<style>:root{--bg:#f6f7f9;--panel:#fff;--ink:#1d2129;--dim:#6b7280;--line:#e5e7eb;--acc:#2563eb}
@media (prefers-color-scheme:dark){:root{--bg:#111318;--panel:#1a1d24;--ink:#e6e8ec;--dim:#9aa1ad;--line:#2a2f3a;--acc:#6ea8ff}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
main{max-width:860px;margin:0 auto;padding:32px 16px}h1{font-size:20px;margin:0 0 4px}p{color:var(--dim);margin:0 0 20px}
.card{display:flex;flex-direction:column;gap:2px;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:10px 0;color:inherit;text-decoration:none}
.card:hover{border-color:var(--acc)}.card span{color:var(--dim);font-size:13px}.card small{color:var(--dim);font-size:12px;word-break:break-all}</style></head>
<body><main><h1>acceptkit · 验收项目</h1><p>${projects.length ? '点进项目看用例、运行与报告。' : '还没有登记项目：acceptkit project use &lt;项目目录&gt;'}</p>${rows}</main></body></html>`;
}

/**
 * 起服务 → Promise<{ server, port, url }>。projects = 项目目录列表；port 0 = 系统挑一个空闲端口（测试用）。
 */
// 看板一次生成所有面板（每轮、每次执行、每条用例，大项目四百多个、几十 MB），全塞进首屏 = 浏览器要解析几十 MB 才能点。
// 项目自带的看板脚本（pack.dashboard）出的是一整份 HTML：这里把面板内容拆出来按需给：首屏留空壳（data-k 不变，路由、链接照旧），证据表也按面板拆。
// 裁定页、操作集首屏就要用（裁定表单、操作引用跳转在页面加载时绑定），留在首屏。
// 依赖看板的形状：面板是不嵌套的 <section class="panel" data-k=…>，证据引用写成 data-ev="evN"。
const EAGER = new Set(['decide', 'ops']);
export function splitPanels(html) {
  const s = html.toString('utf8');
  const evm = /<script id="evdata" type="application\/json">([\s\S]*?)<\/script>/.exec(s);
  let ev = {}; try { ev = JSON.parse(evm?.[1] || '{}'); } catch { /* 证据表坏了：点开时取不到，不影响面板 */ }
  const evOf = h => { const o = {}; for (const m of h.matchAll(/data-ev="([^"]+)"/g)) if (ev[m[1]]) o[m[1]] = ev[m[1]]; return o; };
  const panels = new Map(); const keep = {};
  let shell = s.replace(/<section class="panel" data-k="([^"]*)"([^>]*)>([\s\S]*?)<\/section>/g, (all, k, attrs, body) => {
    const key = k.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    if (EAGER.has(key)) { Object.assign(keep, evOf(body)); return all; }
    panels.set(key, JSON.stringify({ html: body, ev: evOf(body) }));
    return `<section class="panel" data-k="${k}"${attrs} data-lazy></section>`;
  });
  if (evm) shell = shell.replace(evm[0], () => `<script id="evdata" type="application/json">${JSON.stringify(keep).replace(/</g, '\\u003c')}</script>`);
  return { shell: Buffer.from(shell), panels };
}

// 只认回环地址的 Host。DNS 重绑定能让别的网站把自己的域名解析到 127.0.0.1：它的页面打到本服务时 Origin 和 Host 是同一个域名，
// 光比 Origin == Host 拦不住，证据、写入口都会被它读写。按 Host 拒掉（服务显式绑到别的地址时才放开）。
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
// 写入口的凭据：每次起服务随机生成，打开看板页时以 HttpOnly + SameSite=Strict 的 cookie 发给浏览器，/decide 只认带着它的请求。
// 别的网站拿不到（SameSite + 回环 Host）；本机进程要先专门去取 —— 这一步由宿主钩子 H5 拦（core/hooks.mjs），见 SECURITY.md。
const COOKIE = 'ak_decide';
const tokenOf = req => (/(?:^|;\s*)ak_decide=([0-9a-f]+)/.exec(req.headers.cookie || '') || [])[1] || '';
const sameToken = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
// 路径必须真的落在目录里：resolve 只看字面，目录里的符号链接能指到项目外面（知识、配置、本机任意文件）
const inside = (full, dirs) => { let real; try { real = realpathSync(full); } catch { return false; } return dirs.some(d => { try { return real.startsWith(realpathSync(d) + sep); } catch { return false; } }); };

export async function startServer({ roots, port = 9470, host = '127.0.0.1' }) {
  const TOKEN = randomBytes(24).toString('hex');
  const strictHost = LOOPBACK_HOST.test(host) || host === '::1';
  const projects = projectIds([...new Set(roots.map(r => resolve(r)))]);
  const cache = new Map();     // id → { fp, html, gz, at, panel(k), child?, dead?, stale?, used }
  const building = new Map();  // id → { fp, pending }
  const withGen = (raw, at) => {   // 页面记下自己是哪一版生成的，定时对 /version 问「变了没」—— 开着的旧页面要能知道自己旧了
    const meta = `<meta name="ak-gen" content="${at}">`, h = raw.toString('utf8');
    return Buffer.from(/<head>/i.test(h) ? h.replace(/<head>/i, m => m + meta) : meta + h);   // 看板脚本出的是片段，没有 <head>
  };
  // 常驻看板进程：数据读一次（大项目约 2s），点到哪一面才渲染哪一面，渲染过的按这一代缓存。
  // 以前每次数据变化都把几百个面板全渲染一遍（大项目 45s、94MB），新数据要等这一整遍跑完才看得到。
  const kids = new Set();   // 所有活着的看板进程（含正在起、等着被换下的）
  const forkBoard = (p, script, fp) => new Promise((ok, fail) => {
    const ch = fork(script, ['--worker', '--asset-base', `/p/${p.id}/asset`, '--evidence-base', `/p/${p.id}/evidence`],
      { cwd: p.root, env: { ...process.env, ACCEPTKIT_PROJECT: p.root }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    kids.add(ch);
    let err = ''; ch.stderr.on('data', d => { err = (err + d).slice(-4000); });
    const waits = new Map(), done = new Map(); let seq = 0, entry = null;
    ch.on('message', m => {
      if (m?.type === 'ready') {
        const at = Date.now(), html = withGen(m.shell, at);
        entry = { fp, html, gz: gzipSync(html), at, child: ch, used: at, panel(k) {
          if (!done.has(k)) {
            const id = ++seq;
            const pr = new Promise((res, rej) => waits.set(id, { res, rej }));
            pr.catch(() => done.delete(k));   // 渲染失败不缓存，下次再试
            done.set(k, pr); ch.send({ type: 'panel', id, k });
          }
          return done.get(k);
        } };
        return ok(entry);
      }
      const w = waits.get(m?.id); if (!w) return; waits.delete(m.id);
      m.error ? w.rej(new Error(m.error)) : w.res(m.body == null ? null : Buffer.from(m.body));
    });
    ch.on('exit', () => {
      kids.delete(ch);
      if (entry) entry.dead = true;
      for (const w of waits.values()) w.rej(new Error('看板进程退出了，刷新再试')); waits.clear();
      fail(new Error(`看板生成失败（${basename(script)}）：${err.trim().split('\n').slice(-3).join(' ')}`));
    });
  });
  // 一个项目一个常驻进程；半小时没人看就收掉，下次打开再起
  const IDLE_MS = 30 * 60e3;
  setInterval(() => { for (const [id, e] of cache) if (e.child && Date.now() - e.used > IDLE_MS) { e.child.kill(); cache.delete(id); } }, 60e3).unref();

  async function dashboard(p) {
    const config = readConfig(p.root);
    const pack = await loadPack(p.root, config);
    const script = pack.dashboard ? resolve(p.root, pack.dashboard) : join(REPO_ROOT, 'core', 'dashboard.mjs');
    const fp = fingerprint(p.root, script);
    const hit = cache.get(p.id)?.dead ? null : cache.get(p.id);
    if (hit) hit.used = Date.now();
    if (hit?.fp === fp) return hit;
    // 数据变了：已有旧版就先给旧版，后台重新读（执行者一直在写，每次都等就一直慢）。
    // 用户刚在页面上写过（stale 标记）：等新版，否则他一刷新又看到写之前的样子。
    const serveOld = hit?.html && !hit.stale;
    const b = building.get(p.id);
    if (b?.fp === fp) return serveOld ? hit : b.pending;
    const pending = (pack.dashboard ? staticBoard(p, script, fp) : forkBoard(p, script, fp)).then(entry => {
      const old = cache.get(p.id);
      cache.set(p.id, entry);
      // 旧一代晚一分钟再收：开着旧页面的人可能正在等它渲染某一面
      if (old?.child && old.child !== entry.child) setTimeout(() => old.child.kill(), 60e3).unref();
      return entry;
    });
    pending.catch(() => { /* 打开时如实报错 */ }).finally(() => { if (building.get(p.id)?.pending === pending) building.delete(p.id); });
    building.set(p.id, { fp, pending });
    return serveOld ? hit : pending;
  }

  // 项目自带的看板脚本：一次出整份 HTML，拆成面板缓存
  function staticBoard(p, script, fp) {
    const outDir = join(p.root, '.acceptkit'); mkdirSync(outDir, { recursive: true });
    const out = join(outDir, 'serve-dashboard.html');
    return new Promise((ok, fail) => {
      const ch = spawn(process.execPath, [script, '--asset-base', `/p/${p.id}/asset`, '--evidence-base', `/p/${p.id}/evidence`, out], { cwd: p.root, env: { ...process.env, ACCEPTKIT_PROJECT: p.root }, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = ''; ch.stderr.on('data', d => { err += d; });
      ch.on('close', code => {
        if (code !== 0) return fail(new Error(`看板生成失败（${basename(script)}）：${err.trim().split('\n').slice(-3).join(' ')}`));
        const at = Date.now();
        const { shell: raw, panels } = splitPanels(readFileSync(out));
        const html = withGen(raw, at);
        ok({ fp, html, gz: gzipSync(html), at, used: at, panel: async k => panels.get(k) || null });
      });
    });
  }

  const server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    // 不许被别的页面嵌进 iframe：否则能把「批准」按钮叠在诱导点击的东西下面
    const send = (code, body, type = 'text/plain; charset=utf-8', extra = {}) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'", 'x-content-type-options': 'nosniff', ...extra }); res.end(body); };
    try {
      if (strictHost && !LOOPBACK_HOST.test(req.headers.host || '')) return send(421, '只接受本机地址的请求');
      if (u.pathname === '/healthz') return send(200, JSON.stringify({ ok: true, pid: process.pid, projects: projects.map(p => ({ id: p.id, root: p.root })) }), 'application/json');
      if (u.pathname === '/') return send(200, indexPage(projects), 'text/html; charset=utf-8');
      const m = /^\/p\/([^/]+)(\/.*)?$/.exec(u.pathname);
      const p = m && projects.find(x => x.id === decodeURIComponent(m[1]));
      if (!p) return send(404, '没有这个项目');
      const rest = m[2] || '';
      if (rest === '') return send(302, '', 'text/plain', { location: `/p/${p.id}/${u.search}` });
      if (rest === '/') {
        const d = await dashboard(p);
        const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
        const cookie = `${COOKIE}=${TOKEN}; HttpOnly; SameSite=Strict; Path=/`;
        return send(200, gz ? d.gz : d.html, 'text/html; charset=utf-8', { 'set-cookie': cookie, ...(gz ? { 'content-encoding': 'gzip' } : {}) });
      }
      // 开着的页面定时来问：现在最新的是哪一版、后台是不是正在重新生成。顺便按需触发重新生成（数据变了才会真的生成）
      // 本机设备被什么占着：实时的（不跟看板缓存走），页面打开时和之后每 15 秒来取
      if (rest === '/devices') {
        const { deviceBoardHtml } = await import('./device-board.mjs');
        return send(200, deviceBoardHtml(p.root), 'text/html; charset=utf-8');
      }
      if (rest === '/version') {
        dashboard(p).catch(() => { /* 生成失败时页面照旧，打开时会报 */ });
        const cur = cache.get(p.id) || {};
        return send(200, JSON.stringify({ gen: cur.at || 0, updating: building.has(p.id) }), 'application/json');
      }
      if (rest === '/panel') {
        const d = await dashboard(p);
        const body = await d.panel(u.searchParams.get('k') || '');
        if (!body) return send(404, JSON.stringify({ error: '没有这一页（看板刚更新过，刷新一下）' }), 'application/json');
        const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
        return send(200, gz ? gzipSync(body) : body, 'application/json; charset=utf-8', gz ? { 'content-encoding': 'gzip' } : {});
      }
      if (rest === '/asset') {
        const rel = u.searchParams.get('f') || '';
        const full = resolve(p.root, rel);
        // 只出项目目录里的图片：路径逃出项目目录、或不是图片，一律拒
        if (!full.startsWith(p.root + sep)) return send(400, 'bad path');
        const type = IMG[extname(full).toLowerCase()];
        if (!type) return send(415, 'unsupported');
        if (!existsSync(full)) return send(404, 'not found');
        if (!inside(full, [p.root])) return send(400, 'bad path');
        res.writeHead(200, { 'content-type': type, 'cache-control': 'max-age=3600' });
        return createReadStream(full).pipe(res);
      }
      if (rest === '/evidence') {
        const rel = u.searchParams.get('f') || '';
        const full = resolve(p.root, rel);
        // 只出运行证据：runs/ 与 evidence/ 底下的文件（知识、配置、数据库不在这里出）
        if (!['runs', 'evidence'].some(d => full.startsWith(join(p.root, d) + sep))) return send(400, 'bad path');
        if (!existsSync(full) || !statSync(full).isFile()) return send(404, JSON.stringify({ text: '（读不到该文件）' }), 'application/json');
        if (!inside(full, ['runs', 'evidence'].map(d => join(p.root, d)))) return send(400, 'bad path');
        const LIMIT = 400 * 1024, size = statSync(full).size, buf = Buffer.alloc(Math.min(size, LIMIT));
        const fd = openSync(full, 'r'); readSync(fd, buf, 0, buf.length, 0); closeSync(fd);
        let text = buf.toString('utf8');
        if (/\.json$/i.test(full) && size <= LIMIT) { try { text = JSON.stringify(JSON.parse(text), null, 1); } catch { /* 保留原文 */ } }
        return send(200, JSON.stringify({ text, truncated: size > LIMIT }), 'application/json; charset=utf-8');
      }
      if (rest === '/decide' && req.method === 'POST') {
        // 只收本页发来的：别的网站在浏览器里也能往 127.0.0.1 发请求。要求 JSON（跨站要先预检，这里不答预检），
        // 且必须带 Origin、是本服务自己（浏览器的 POST 一定带；命令行直接打这个口子不带 —— 执行者别想从这里冒充点击）。
        const origin = req.headers.origin || '';
        if (!/^application\/json\b/.test(req.headers['content-type'] || '') || origin !== `http://${req.headers.host}`) return send(403, JSON.stringify({ error: '只接受本页面的请求' }), 'application/json');
        if (!sameToken(tokenOf(req), TOKEN)) return send(403, JSON.stringify({ error: '页面已过期（看板服务重启过），刷新一下再提交' }), 'application/json');
        let body = ''; for await (const c of req) { body += c; if (body.length > 64 * 1024) return send(413, JSON.stringify({ error: '太长' }), 'application/json'); }
        let b; try { b = JSON.parse(body); } catch { return send(400, JSON.stringify({ error: '不是 JSON' }), 'application/json'); }
        const ok = v => typeof v === 'string' && v.trim();
        const action = b.action === undefined ? 'decide' : b.action;
        if (!['decide', 'bounce', 'approve', 'return', 'ack'].includes(action)) return send(400, JSON.stringify({ error: 'action 只能是 decide / bounce / approve / return / ack' }), 'application/json');
        // 同一个问题可能卡住好几条断言：一次答复覆盖一组阻塞项
        const blockerIds = action === 'ack' ? [].concat(b.blockers || b.blocker || []).map(String) : [];
        if (action === 'ack' && (!blockerIds.length || blockerIds.length > 200 || !blockerIds.every(x => /^B\d+$/.test(x)))) return send(400, JSON.stringify({ error: '缺阻塞项编号' }), 'application/json');
        // 看板只听本机：在这个页面上点的人就是这台电脑的主人，身份由服务填（ownerIdentity），页面不再让人填名字。
        // 原话：批准是「点了哪个按钮」加他写的补充；退回、裁定、看不懂要他写的那句话。
        // 只有裁定 / 打回一条 finding 要 finding 编号；批准、退回、答阻塞（ack，用阻塞项编号）都不带（曾经 ack 也要，看板上答阻塞一律「缺需求 / finding」）
        const plan = action === 'decide' || action === 'bounce' ? 'finding' : null;
        if (!/^[A-Za-z0-9._-]+$/.test(b.demand || '') || (plan && !/^F\d+$/.test(b.finding || ''))) return send(400, JSON.stringify({ error: '缺需求 / finding' }), 'application/json');
        const note = ok(b.note) ? b.note.trim() : ok(b.quote) ? b.quote.trim() : '';
        if (action !== 'approve' && !note) return send(400, JSON.stringify({ error: action === 'return' ? '写一句为什么退回、要怎么改' : action === 'ack' ? '写下你的答复' : '写下你的决定' }), 'application/json');
        b.by = ownerIdentity();
        b.quote = action === 'approve' ? `看板上点了「${ok(b.button) ? b.button.trim() : '批准'}」${note ? '：' + note : ''}` : note;
        const target = plan ? ['--finding', b.finding] : [];
        // 答阻塞：blockers <D> --ack <B> --answer <原话> --by <主人>（不是 plan 子命令）
        const runOne = cmdArgs => new Promise(done => {
          const ch = spawn(process.execPath, [join(REPO_ROOT, 'bin', 'acceptkit.mjs'), ...cmdArgs],
            { cwd: p.root, env: { ...process.env, ACCEPTKIT_PROJECT: p.root }, stdio: ['ignore', 'pipe', 'pipe'] });
          let out = ''; ch.stdout.on('data', d => { out += d; }); ch.stderr.on('data', d => { out += d; });
          ch.on('close', code => done({ code, out: out.trim() }));
        });
        let r = { code: 0, out: '' };
        // 一组阻塞一条命令答完（逐条答的话中途失败会留下一半答了、一半没答）；原话用 --k=v 传，以 -- 开头也不会被当成参数
        if (action === 'ack') r = await runOne(['blockers', b.demand, `--ack=${blockerIds.join(',')}`, `--answer=${b.quote}`, `--by=${b.by}`]);
        else r = await runOne(['plan', action, b.demand, ...target, `--by=${b.by.trim()}`, `--quote=${b.quote.trim()}`]);
        if (r.code === 0 && cache.get(p.id)) cache.get(p.id).stale = true;
        // 每次点击都留底（成功和失败都记）：owner 说「我答过」时，能查到他点没点、写没写进去、为什么没写进去
        try { mkdirSync(join(p.root, 'state'), { recursive: true }); appendFileSync(join(p.root, 'state', 'decide-log.jsonl'), JSON.stringify({ at: new Date().toISOString(), action, demand: b.demand, finding: b.finding || null, blockers: blockerIds, by: b.by, quote: b.quote, ok: r.code === 0, out: r.out.split('\n').slice(-3).join(' ') }) + '\n'); } catch { /* 留底失败不挡答复 */ }
        return send(r.code === 0 ? 200 : 422, JSON.stringify(r.code === 0 ? { ok: true, out: r.out } : { error: r.out.split('\n').slice(-2).join(' ') }), 'application/json; charset=utf-8');
      }
      return send(404, 'not found');
    } catch (e) { return send(500, String(e.message || e)); }
  });
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(port, host, ok); });
  // 服务关了，常驻看板进程一起收（IPC 连着时它们会把服务进程拖住不退）
  server.on('close', () => { for (const ch of kids) ch.kill(); cache.clear(); });
  // 起来就在后台把各项目的看板生成好：大项目生成要几秒，别让第一个打开的人等
  for (const p of projects) dashboard(p).catch(() => { /* 打开时会如实报错 */ });
  const real = server.address().port;
  return { server, port: real, url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${real}`, projects };
}
