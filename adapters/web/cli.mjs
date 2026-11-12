#!/usr/bin/env node
// Web 载体的子进程入口：引擎用同步方式调用它（spawnSync），输出一行 JSON。
//   open    --port P --profile DIR [--url U]                       起/复用独立调试 Chrome，打开页面（登录用）
//   shot    --port P [--tab RE] --out FILE [--pack PACK.mjs]       查遮蔽层后截图
//   observe --port P [--tab RE] [--url U] [--wait MS] --eval EXPR [--out FILE] [--pack PACK.mjs]
//           在页面里求值读判据；同一刻截图（读值与截图来自同一个动作）
import { pathToFileURL } from 'node:url';
import { launchDebugChrome, Page, genericObscuring } from './cdp.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = {};
for (let i = 1; i < argv.length; i++) if (argv[i].startsWith('--')) { opt[argv[i].slice(2)] = argv[i + 1]; i++; }
const out = (o) => { process.stdout.write(JSON.stringify(o) + '\n'); };

async function obscuring(page) {
  if (opt.pack) {
    const mod = await import(pathToFileURL(opt.pack).href);
    const hook = mod.webObscuring || mod.default?.webObscuring;
    if (hook) return hook(page);
  }
  return genericObscuring(page);
}

try {
  if (cmd === 'open') {
    const r = await launchDebugChrome({ port: Number(opt.port), profile: opt.profile, url: opt.url || 'about:blank' });
    if (r.reused && opt.url) { const p = await new Page(Number(opt.port)).connect(); await p.nav(opt.url); p.close(); }
    out({ ok: true, ...r });
  } else if (cmd === 'shot') {
    const page = await new Page(Number(opt.port), opt.tab).connect();
    const url = await page.eval('location.href'); const title = await page.eval('document.title');
    const obs = await obscuring(page);
    let shot = null;
    if (obs.ok || opt.force === '1') { await page.shot(opt.out); shot = opt.out; }
    page.close();
    out({ ok: true, url, title, obscuring_check: obs, shot });
  } else if (cmd === 'observe') {
    const page = await new Page(Number(opt.port), opt.tab).connect();
    if (opt.url) { await page.nav(opt.url); await page.wait(Number(opt.wait || 3000)); }
    else if (opt.wait) await page.wait(Number(opt.wait));
    const value = opt.eval ? await page.eval(opt.eval) : null;
    const url = await page.eval('location.href'); const title = await page.eval('document.title');
    const obs = await obscuring(page);
    if (opt.out) await page.shot(opt.out);
    page.close();
    out({ ok: !(value && value.__err), url, title, value, obscuring_check: obs, shot: opt.out || null, ...(value && value.__err ? { error: value.__err } : {}) });
  } else {
    out({ ok: false, error: `未知子命令 ${cmd}` }); process.exit(1);
  }
} catch (e) {
  out({ ok: false, error: e.message }); process.exit(1);
}
