// 示例项目的扩展钩子（约定见 docs/architecture.md「扩展模型」）。
//
// 这里只演示一个钩子：observers —— 给操作库里 exec=demo-diag 的配方提供观测通道。
// 真实项目在这里接自己的私有诊断接口（App 调试端口、内部查询服务……），内核不需要知道它们是什么。
//
// 观测函数的约定：
//   (recipe, params, runDir, device, ctx, helpers) => { data } 或 { error }
//   · 同步返回（内核按同步调用）；
//   · data 是读到的原始结构，断言里的 checks 按 pick 从里面取值判定；
//   · 读不到就返回 { error: "人话原因" }，内核会按断言声明的后备通道降级，或记为阻塞 —— 不要自己编一个结果。
// 这个文件也会被 Web 载体的子进程加载（查遮蔽层），所以顶层不要有副作用。

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

function demoDiag(recipe, params, runDir, device, ctx, helpers) {
  // 端口和标签页从项目配置里登记的宿主取（acceptkit.project.json 的 hosts.site.web）
  const app = helpers.hostApp('site', 'web') || {};
  if (!app.port) return { error: '宿主 site 没有登记 web.port' };
  const cli = join(helpers.REPO_ROOT, 'adapters', 'web', 'cli.mjs');
  // 页面自己暴露的状态真值；序列化一次，读到的是纯数据
  const expr = 'JSON.parse(JSON.stringify(window.__demoState ?? null))';
  const x = spawnSync(process.execPath, [cli, 'observe', '--port', String(app.port), '--tab', app.tabMatch || '', '--eval', expr],
    { encoding: 'utf8', timeout: 60_000 });
  let r;
  try { r = JSON.parse((x.stdout || '').trim().split('\n').pop()); } catch { return { error: `诊断通道没有返回结果：${(x.stderr || '').slice(0, 200)}` }; }
  if (!r.ok) return { error: `诊断通道失败：${r.error}` };
  if (!r.value) return { error: `页面 ${r.url} 没有暴露 window.__demoState（不是示例页？）` };
  // 断言要的字段诊断接口里没有 = 这条通道答不了，如实报错（例：示例站点没有订单后台，报不出结算运费）
  const missing = [].concat(params.need || []).filter(k => !(k in r.value));
  if (missing.length) return { error: `诊断接口没有报告 ${missing.join('、')}（只有 ${Object.keys(r.value).join('、')}）` };
  return { data: r.value, cmdLine: `[demo-diag] window.__demoState @ ${r.url}` };
}

export const observers = { 'demo-diag': demoDiag };
export const observerStrength = { 'demo-diag': 'S1' };
