#!/usr/bin/env node
// Web 载体的子进程入口：引擎用同步方式调用它（spawnSync），输出一行 JSON。
//   open    --port P --profile DIR [--url U] [--pref TPL]          起/复用独立调试 Chrome，打开页面（登录用）；用户目录不放 /tmp
//   tab     --port P [--target ID] [--url U]                       验收运行自己的标签页：没有 / 不在了就新开一个，给了 --url 就在里面打开 → { target }
//   shot    --port P [--tab RE | --target ID] --out FILE [--pack PACK.mjs]       查遮蔽层后截图
//   observe --port P [--tab RE | --target ID] [--url U] [--wait MS] --eval EXPR [--out FILE] [--pack PACK.mjs]
//           截图前先把读到的值滚进视口（reveal），截图里看不到读到的值时如实报 reveal.in_view=false
//           在页面里求值读判据；同一刻截图（读值与截图来自同一个动作）
import { pathToFileURL } from 'node:url';
import { launchDebugChrome, Page, genericObscuring, openTarget, targetAlive } from './cdp.mjs';

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
    const r = await launchDebugChrome({ port: Number(opt.port), profile: opt.profile, url: opt.url || 'about:blank', pref: opt.pref || null });
    if (r.reused && opt.url) { const p = await new Page(Number(opt.port)).connect(); await p.nav(opt.url); p.close(); }
    out({ ok: true, ...r });
  } else if (cmd === 'tab') {
    const port = Number(opt.port);
    let target = opt.target && await targetAlive(port, opt.target) ? opt.target : null;
    const fresh = !target;
    if (!target) target = await openTarget(port, opt.url || 'about:blank');
    else if (opt.url) { const p = await new Page(port, null, target).connect(); await p.nav(opt.url); await p.wait(Number(opt.wait || 2000)); p.close(); }
    out({ ok: true, target, fresh });
  } else if (cmd === 'shot') {
    const page = await new Page(Number(opt.port), opt.tab, opt.target || null).connect();
    const url = await page.eval('location.href'); const title = await page.eval('document.title');
    const obs = await obscuring(page);
    let shot = null;
    if (obs.ok || opt.force === '1') { await page.shot(opt.out); shot = opt.out; }
    page.close();
    out({ ok: true, url, title, obscuring_check: obs, shot });
  } else if (cmd === 'observe') {
    const page = await new Page(Number(opt.port), opt.tab, opt.target || null).connect();
    if (opt.url) { await page.nav(opt.url); await page.wait(Number(opt.wait || 3000)); }
    else if (opt.wait) await page.wait(Number(opt.wait));
    const value = opt.eval ? await page.eval(opt.eval) : null;
    const url = await page.eval('location.href'); const title = await page.eval('document.title');
    // 结论截图要拍到读到的值：先把它滚进视口（内层滚动容器也滚）
    let reveal = null;
    if (opt.out && value && !value.__err) {
      const words = []; const leaf = v => { if (typeof v === 'string' || typeof v === 'number') words.push(String(v)); else if (v && typeof v === 'object') Object.values(v).forEach(leaf); };
      leaf(value); reveal = await page.reveal(words);
      if (reveal && reveal.__err) reveal = null;
      if (reveal?.found?.length) await page.wait(300);
    }
    const obs = await obscuring(page);
    if (opt.out) await page.shot(opt.out);
    page.close();
    out({ ok: !(value && value.__err), url, title, value, reveal, obscuring_check: obs, shot: opt.out || null, ...(value && value.__err ? { error: value.__err } : {}) });
  } else {
    out({ ok: false, error: `未知子命令 ${cmd}` }); process.exit(1);
  }
} catch (e) {
  out({ ok: false, error: e.message }); process.exit(1);
}
