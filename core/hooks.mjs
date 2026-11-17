// hooks — 宿主钩子：要验收就走 acceptkit（声明在 skill-refactor 里登记、核对过依据：skr hook acceptkit …）。
//
//   H1 跑命令之前：起 / 建 / 克隆任何模拟器 —— 一律拦下，只走 acceptkit device acquire；装卸包、清数据、关机动的是验收设备 —— 拦下
//   H2 写文件之前：直接改验收记录（运行结果、评审单、阻塞台账、轮次、复核、项目配置）—— 拦下，指给 acceptkit 的命令
//   H3 要停下时：这个会话绑定了一个验收（acceptkit loop start），next 里还有执行者能做的卡片 —— 不让停，把下一张交回去
//   H4 用户提到验收：提醒先走 acceptkit
//   H5 跑命令之前：直接打看板的写入口（/decide）或去取它的凭据 —— 拦下。那是用户本人在页面上点的地方，执行者从这里写就是冒充他
//
// 为什么要有：只写在手册里守不住。实测执行者手动起模拟器、克隆 AVD、删掉 AVD 锁文件再起，acceptkit 的台账完全不知道。
// 翻译成各家宿主的接法在 host-hooks.mjs（从 skill-refactor 拷来）；出错一律放行 —— 钩子坏了不能把 agent 锁死。
// 只管验收的东西：不是验收设备、不在 acceptkit 项目里的文件、没绑定验收的会话，一律放行。
import { existsSync, readFileSync, statSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve, sep, basename, dirname } from 'node:path';
import { readUserConfig, readConfig, REPO_ROOT, USER_CONFIG } from './project.mjs';
import { loadLeases, loopBinding, listLoopBindings, unbindLoop, bindLoop, recordLoopStop } from './store/db.mjs';
import { nextCards } from './next.mjs';
import * as ANDROID from '../adapters/android/device.mjs';
import { runHook, verdictOf, hookProblems, installSnippet, install, configPath, HOST_IDS } from './host-hooks.mjs';

export const HOOKS = [
  { id: 'H1', event: 'before_tool', on: 'shell', run: 'guard_device', mode: 'block', title: '动验收设备只走 acceptkit',
    // 所有发往设备的 adb / simctl 命令都过这道（不只装卸包）；命令是跑一个脚本文件的，脚本里的 adb 也算（见 guard_device）
    match: 'emulator[^|;&]*-avd|avdmanager[^|;&]*\\bcreate|simctl\\s|\\badb\\b|\\.avd/[^ ]*\\.lock|cp\\s[^|;&]*\\.avd|\\b(node|bash|sh|zsh|python3?)\\s+[^|;&]*\\.(mjs|cjs|js|sh|py)\\b|--(serial|device|udid|device-id)[=\\s]|\\bANDROID_SERIAL=' },
  { id: 'H2', event: 'before_tool', on: 'write', run: 'guard_state', mode: 'block', title: '验收记录只由 acceptkit 写',
    match: 'runs/[^/]+/result\\.json$|/state/(plans|blockers|rounds|review)/|acceptkit\\.project\\.json$' },
  { id: 'H3', event: 'stop', on: 'any', run: 'loop_next', mode: 'continue', title: '验收没做完别停' },
  { id: 'H4', event: 'prompt', on: 'any', run: 'loop_next', mode: 'remind', title: '用户提到验收：先 acceptkit next', match: '验收|验一下|测一下|回归|复现|跑用例' },
  { id: 'H5', event: 'before_tool', on: 'shell', run: 'guard_decide', mode: 'block', title: '看板的写入口只给用户本人',
    match: '/p/[^\\s\'"]*/decide|\\bak_decide\\b' },
];

const projects = () => [...new Set(readUserConfig().projects || [])].filter(p => existsSync(join(p, 'acceptkit.project.json')));
const projName = root => { try { return readConfig(root).name || basename(root); } catch { return basename(root); } };

// 验收设备：各项目白名单里的设备 + 正被运行占着的。键用设备身份（avd:<名> / UDID / 真机 serial）
function acceptanceDevices() {
  const out = new Map();
  for (const root of projects()) {
    let cfg = {}; try { cfg = readConfig(root); } catch { continue; }
    for (const a of cfg.gate?.allow || []) if (a.kind === 'device') out.set(String(a.value), `${projName(root)} 的验收白名单${a.note ? `（${a.note}）` : ''}`);
    for (const [k, l] of Object.entries(loadLeases(root))) out.set(k, `${projName(root)} 的运行 ${l.run} 正占着`);
  }
  return out;
}
// 刚过闸的动作放行：占着这台设备的运行，在 GATE_FRESH_MIN 分钟内对它过过 acceptkit gate（verdict=pass）。
// 闸本身已查白名单 + 占用 + 记下动作；用户坚持要做的动作（例如卸载重装）走「gate → 执行」就该能落地，
// 否则 acceptkit 会把 owner 明确要求的动作永远挡在门外（实测踩过：gate 已过、owner 原话在案，H1 仍拦）。
const GATE_FRESH_MIN = 15;
function freshGateFor(id, kind = null) {
  const want = String(id).toUpperCase();
  for (const root of projects()) {
    let leases = {}; try { leases = loadLeases(root); } catch { continue; }
    const l = leases[id] || leases[want];
    if (!l?.run) continue;
    let r; try { r = JSON.parse(readFileSync(join(root, 'runs', l.run, 'result.json'), 'utf8')); } catch { continue; }
    // c.device：gate 按占用反解出的身份（--sim 给的是 serial 时）；钩子这边也是按身份认设备
    const recent = (r.gates || []).filter(x => x.verdict === 'pass' && x.at && (Date.now() - Date.parse(x.at)) < GATE_FRESH_MIN * 60e3);
    const onIt = recent.filter(x => (x.checked || []).some(c => [c.val, c.device].some(v => v && String(v).toUpperCase() === want)));
    const g = onIt.filter(x => !kind || x.destructive?.kind === kind).pop();
    if (g) return { run: l.run, action: g.action, at: g.at };
    // 有新鲜的闸却不算：把为什么说出来，不然执行者只看到一句「先 gate」，会以为闸没记上
    const near = (onIt.length ? onIt : recent).pop();
    if (near) return { miss: onIt.length
      ? `run=${l.run} 在 ${near.at} 过的闸（${near.action}）没带${kind === 'uninstall' ? '卸载' : '清数据'}的理由，这个动作要带理由的那种闸`
      : `run=${l.run} 在 ${near.at} 过的闸（${near.action}）核对的是 ${(near.checked || []).map(c => c.val).join(' ')}，不是 ${id}` };
  }
  return null;
}
// 命令里提到了哪些设备
function devicesIn(cmd) {
  const ids = new Set();
  for (const m of cmd.matchAll(/-avd\s+["']?([\w.-]+)/g)) ids.add(`avd:${m[1]}`);
  for (const m of cmd.matchAll(/([\w.-]+)\.avd\b/g)) ids.add(`avd:${m[1]}`);
  for (const m of cmd.matchAll(/\b([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})\b/gi)) ids.add(m[1].toUpperCase());
  for (const m of cmd.matchAll(/adb\b[^|;&]*?-s\s+(\S+)/g)) { const id = /^emulator-\d+$/.test(m[1]) && ANDROID.available() ? ANDROID.identityOf(m[1]) : m[1]; if (id) ids.add(id); }
  // adb 没写 -s：打在唯一连着的那台上，连着的设备都算
  if (/\badb\b/.test(cmd) && !/-s\s+\S+/.test(cmd) && ANDROID.available()) for (const d of ANDROID.listDevices()) { const id = ANDROID.identityOf(d.serial); if (id) ids.add(id); }
  return [...ids];
}

// heredoc 喂给 node / cat / python 这类程序时，正文是数据（改文档、写脚本），不是要执行的命令；喂给 shell 的照样算命令。
// 实测：改一份写着「emulator -avd …」的文档，被当成起模拟器拦下
const commandsOf = t => String(t).replace(/^(?!\s*(?:\S*\/)?(?:ba|z)?sh\b)([^\n]*?)<<-?\s*(['"]?)(\w+)\2[^\n]*\n[\s\S]*?\n\s*\3\s*(?=\n|$)/gm, '$1');
const LIFECYCLE = /emulator[^|;&]*\s-avd\b|avdmanager[^|;&]*\bcreate\b|simctl\s+(boot|clone|create)\b|\.avd\/[^ ]*\.lock|cp\s[^|;&]*\.avd/;
// ── 设备强制管控（11-16 三次事故：没占就在别人那台上装包推 mock；脚本写死 emulator-5554 打到了别的设备；设备停了占用方不知道）──
// 规则：发往验收设备（白名单里的、正被占着的）的命令，只有「这台被本会话的运行占着」才放行；没人占也要先 device acquire。
// 地址按调用时现查身份（emulator-NNNN 按启动顺序分配，停一台起一台就指到别的设备上）。只读的身份查询（adb devices、emu avd name）不拦。
const ADB_IDENT = /\badb\b(?:\s+-s\s+\S+)?\s+(devices|version|start-server|kill-server|get-state|get-serialno|emu\s+avd\s+name)\b/;
const SIMCTL_READ = /simctl\s+(list|help)\b/;
const CMD_POS = String.raw`(?:^|[;&|(` + '`' + String.raw`]|\$\()\s*(?:\w+=\S+\s+)*(?:(?:timeout|gtimeout)\s+\S+\s+|sudo\s+)?`;
// 命令在跑一个脚本文件：读脚本，里面调了 adb / simctl 的照样算（脚本里的 adb 钩子看不见，实测探针脚本写死地址打错设备一路放行）
function scriptTexts(cmd, cwd) {
  const out = [];
  for (const m of cmd.matchAll(/\b(?:node|bash|sh|zsh|python3?)\s+(?:-\S+\s+)*["']?([^\s|;&"']+\.(?:mjs|cjs|js|sh|py))\b/g)) {
    const f = resolve(cwd || process.cwd(), m[1]);
    if (f.startsWith(REPO_ROOT + sep)) continue;   // acceptkit 自己：它在里面按占用核对
    try { if (statSync(f).size > 512 * 1024) continue; const t = readFileSync(f, 'utf8'); if (SCRIPT_CALL.test(t)) out.push({ file: f, text: t }); } catch { /* 不是文件 */ }
  }
  return out;
}
// 一段命令 / 脚本里发往设备的调用打到了哪些设备。看不出是哪台（地址写成变量、没写 -s）就算连着的全部
// 脚本里「真的在调用」adb / simctl 的写法（注释、文档里提到这个词不算）：JS / Python 里以字符串传给子进程、acceptkit 的 adbBin()，shell 里一行以 adb 开头
const SCRIPT_CALL = /(['"`])adb\1|adbBin\(\)|adbPath\(\)|(?:^|[;&|(]\s*|\$\(\s*)adb\s+(?:-s\b|shell|install|push|pull|uninstall|logcat|reverse|forward|root|reboot|emu)\b|(['"`])simctl\2|(?:^|[;&|(]\s*)xcrun\s+simctl\s+(?!list\b|help\b)/m;
function scriptTargets(t) {
  if (!SCRIPT_CALL.test(t)) return null;
  const ids = new Set();
  for (const m of t.matchAll(/emulator-\d+/g)) { const id = ANDROID.available() ? ANDROID.identityOf(m[0]) : null; if (id) ids.add(id); }
  for (const m of t.matchAll(/\b([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})\b/gi)) ids.add(m[1].toUpperCase());
  return { ids: [...ids], any: !ids.size };
}
/** adb 的全局 -s（子命令之前的那个）；子命令之后的 -s 是子命令自己的参数（例：logcat -s TAG），不是设备 */
export function adbSerial(call) {
  const tok = call.trim().split(/\s+/).slice(1).map(x => x.replace(/^["']|["']$/g, ''));
  for (let i = 0; i < tok.length; i++) {
    if (!tok[i].startsWith('-')) return null;               // 到子命令了
    if (tok[i] === '-s') return tok[i + 1] || null;
    if (['-t', '-H', '-P', '-L'].includes(tok[i])) i++;      // 带值的全局选项
  }
  return null;
}
export function deviceTargets(t, { script = false } = {}) {
  if (script) return scriptTargets(t);
  const ids = new Set(); let any = false;
  const calls = t.replace(/acceptkit(\.mjs)?\s+adb\b/g, '');   // acceptkit adb 封装：它自己按占用核对
  // 只认处在命令位置的 adb / xcrun simctl（行首、管道 / 分号之后、$( 里，可带环境变量、timeout、路径前缀）；grep adb、echo 里的字样不算
  const adbCalls = [...calls.matchAll(new RegExp(CMD_POS + String.raw`(?:[\w.~/-]*/)?(adb\s[^\n|;&]*)`, 'gm'))].map(m => m[1]).filter(c => !ADB_IDENT.test(c));
  const simCalls = [...calls.matchAll(new RegExp(CMD_POS + String.raw`xcrun\s+(simctl\s+[^\n|;&]*)`, 'gm'))].map(m => m[1]).filter(c => !SIMCTL_READ.test(c));
  const addAddr = a => { if (/^emulator-\d+$/.test(a)) { const id = ANDROID.available() ? ANDROID.identityOf(a) : null; if (id) ids.add(id); else any = true; } else ids.add(/^[0-9A-F]{8}-/i.test(a) ? a.toUpperCase() : a); };
  // 别的工具自己调 adb / simctl、只把设备地址当参数传进去（例：某编译工具的 load --serial <地址>）：钩子看不见它里面的 adb，
  // 按参数认设备 —— 常见写法 --serial / --device / --udid / --device-id / ANDROID_SERIAL=
  const viaArg = [...calls.matchAll(/(?:--(?:serial|device|udid|device-id)[=\s]+|\bANDROID_SERIAL=)["']?([\w.:-]+)/g)].map(m => m[1]);
  if (!adbCalls.length && !simCalls.length && !viaArg.length) return null;
  for (const a of viaArg) addAddr(a);
  for (const c of adbCalls) {
    const s = adbSerial(c);
    if (s) addAddr(s); else any = true;
  }
  for (const c of simCalls) { const u = /\b([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})\b/i.exec(c); if (u) ids.add(u[1].toUpperCase()); else any = true; }
  return { ids: [...ids], any };
}
const connectedIds = () => { const out = []; try { if (ANDROID.available()) for (const d of ANDROID.listDevices()) { const id = ANDROID.identityOf(d.serial); if (id) out.push(id); } } catch {} return out; };
function leaseOf(id) {
  const want = String(id).toUpperCase();
  for (const root of projects()) { let ls = {}; try { ls = loadLeases(root); } catch { continue; } const l = ls[id] || ls[want]; if (l) return { root, ...l }; }
  return null;
}
function logOp(x) {
  try { const f = join(dirname(USER_CONFIG), 'device-ops.jsonl'); mkdirSync(dirname(f), { recursive: true }); appendFileSync(f, JSON.stringify({ at: new Date().toISOString(), via: 'hook', ...x }) + '\n'); } catch (e) { process.stderr.write(`acceptkit: 设备操作没记进账本：${e.message}\n`); }
}
/** 本会话能不能动这些设备 → null（能）或拒收的话 */
function holdCheck(ids, session) {
  for (const id of ids) {
    const l = leaseOf(id);
    if (!l) return `${id} 是验收设备，现在没人占着。没人占也不能直接用：先 acceptkit device acquire --run <运行>（占上、记到本会话名下），之后用 acceptkit adb --run <运行> -- <参数>`;
    if (!session) continue;   // 宿主不给会话号：只能核到「有人占着」
    if (!l.session) return `${id} 被 ${projName(l.root)} 的运行 ${l.run} 占着，但占用还没绑会话（旧版占的）。是你的运行：acceptkit device acquire --run ${l.run} 重新占一下（同一运行原样返回，并记到本会话名下）；不是你的：别动它`;
    if (l.session !== session) return `${id} 被另一个会话占着（${projName(l.root)} 的运行 ${l.run}${l.holder ? `，${l.holder}` : ''}，占于 ${l.since}）：别动它 —— 读数会打在别人的验收上，装包 / 推配置会把别人的结论作废。要设备：acceptkit device acquire --run <你的运行>`;
  }
  return null;
}

const DECIDE = {
  guard_device(n) {
    // 起 / 建 / 克隆设备：不管是哪台都只走 acceptkit —— 设备开在谁的屏上、被谁占着、给哪个需求跑，只有 acceptkit 起的才知道
    // （实测：执行者先 avdmanager 建一台新 AVD 再手动 emulator -avd 起，用户的显示器偏好、台账都没管到）
    const cmds = n.texts.map(commandsOf);
    const life = cmds.find(t => LIFECYCLE.test(t));
    if (life) return { decision: 'deny', reason: `设备只由 acceptkit 起：这条命令在起 / 建 / 克隆模拟器。`
      + `要设备用 acceptkit device acquire --run <运行>（会按用户偏好开在他指定的显示器上、记进台账）；`
      + `本机没有合适的 AVD：别自己建，把要什么配置（内存 / GPU / 系统版本）告诉用户，请他建好并加进白名单（acceptkit config add gate.allow …）。` };
    const acc = acceptanceDevices();
    const isAcc = id => acc.has(id) || acc.has(String(id).toUpperCase());
    // 命令本身 + 它要跑的脚本里，发往设备的调用打到了哪些验收设备
    const targets = [...cmds.map(t => ({ t, where: '这条命令' })), ...cmds.flatMap(t => scriptTexts(t, n.cwd)).map(x => ({ t: x.text, where: `脚本 ${x.file}`, script: true }))]
      .map(x => ({ ...x, d: deviceTargets(x.t, { script: x.script }) })).filter(x => x.d);
    for (const x of targets) {
      const ids = [...new Set([...x.d.ids, ...(x.d.any ? connectedIds() : [])])].filter(isAcc);
      if (!ids.length) continue;
      const why = holdCheck(ids, n.session);
      if (why) { logOp({ session: n.session, denied: true, devices: ids, cmd: x.t.slice(0, 300), where: x.where }); return { decision: 'deny', reason: `${x.where}要动验收设备 ${ids.join('、')}。${why}${x.script ? '。脚本里别写死 emulator-NNNN：地址按启动顺序分配，会指到别的设备上' : ''}` }; }
      logOp({ session: n.session, devices: ids, cmd: x.t.slice(0, 300), where: x.where });
    }
    // 装卸包、清数据、关机：占着之外还要新鲜的闸（下面原有规则）
    const hit = cmds.flatMap(devicesIn).map(id => [id, acc.get(id) || acc.get(id.toUpperCase())]).find(([, why]) => why);
    if (!hit || !cmds.some(t => /simctl\s+(boot|shutdown|erase|install|uninstall|clone|create|delete)|adb\b[^|;&]*\b(install|uninstall|emu\s+kill|shell\s+pm\s+(clear|uninstall))/.test(t))) return { decision: 'allow' };
    // 卸载 / 清数据只认带理由过的闸（gate 按业务登记的理由评估过，core/destructive.mjs）；装包任何一条新鲜的闸都行
    const kind = cmds.some(t => /adb\b[^|;&]*\buninstall|pm\s+uninstall|simctl\s+uninstall/.test(t)) ? 'uninstall'
      : cmds.some(t => /pm\s+clear|simctl\s+erase/.test(t)) ? 'clear' : null;
    const fresh = freshGateFor(hit[0], kind);
    if (fresh?.run) return { decision: 'allow', reason: `${hit[0]} 在 ${fresh.at} 由 run=${fresh.run} 过闸（${fresh.action}），${GATE_FRESH_MIN} 分钟内放行` };
    return { decision: 'deny', reason: `这条命令动的是验收设备 ${hit[0]}（${hit[1]}）。${fresh?.miss ? `有闸但不算：${fresh.miss}。` : ''}要验收就走 acceptkit：`
      + `起 / 选设备用 acceptkit device acquire --run <运行>；装包先 acceptkit gate --action "<要做什么>"，过了就做（本 run 占着的设备不用再问用户）；卸载、清数据过闸要带理由：acceptkit gate --action "卸载 …" --reason <登记的理由 id> --why "<现场>"（没有登记的理由覆盖，闸会告诉你怎么问用户）；`
      + `关机：本 run 占着的 acceptkit device release <设备> --run <运行> --shutdown，acceptkit 起的、没人占着的 acceptkit device stop <设备>；`
      + `不要删 AVD 锁文件、不要克隆 AVD —— 要新设备请用户加进白名单（acceptkit config add gate.allow …）。不是在做验收：换一台不在验收白名单里的设备。` };
  },
  guard_decide() {
    return { decision: 'deny', reason: '看板的写入口（/decide）只给用户本人在页面上点：执行者从这里提交就是冒充他的批准 / 答复。'
      + '要用户定的事：把卡片的 question 原样交给他，请他在看板上点，或他回话后照卡片的 on_reply 记下他的名字和原话。' };
  },
  guard_state(n) {
    for (const t of n.texts) {
      const f = resolve(n.cwd || process.cwd(), t);
      const root = projects().find(r => f.startsWith(resolve(r) + sep));
      if (!root) continue;
      const rel = f.slice(resolve(root).length + 1);
      return { decision: 'deny', reason: `${rel} 是 acceptkit 的验收记录（${projName(root)}），只由命令写：结论 acceptkit record / observe，`
        + `评审单 acceptkit plan …，阻塞 acceptkit blockers …，复核 acceptkit reviewq …，项目配置 acceptkit config …。直接改会绕过闸门和审计记录。` };
    }
    return { decision: 'allow' };
  },
  loop_next(n, hook) {
    const b = findBinding(n);
    if (!b) return hook.event === 'prompt'
      ? { decision: 'remind', reason: '要验收就走 acceptkit：先 acceptkit loop start <需求>，再每轮照 acceptkit next <需求> --json 的卡片做；动设备用 acceptkit device acquire。' }
      : { decision: 'allow' };
    const cards = nextCards(b.root, b.demand);
    if (!cards.length) { unbindLoop(b.root, b.key); return { decision: 'allow' }; }   // 做完了：解绑
    const v = verdictOf(hook, { cards });
    // 只剩等人的事、要停下等用户了：停之前拦一次，要它先把要问的事记下来再停。
    // 实测：执行者在聊天里问「选 1 还是 2」，没记成 finding，看板上看不到，owner 只看到一句没上下文的问话；
    // 用户早在看板上批过的事，它也不回来看，接着在聊天里再问。同一批等人的事只拦一次（told 记在绑定旁边）
    if (v.decision === 'allow' && hook.event === 'stop') {
      const asks = cards.filter(c => c.kind === 'attention').map(c => c.title).sort().join('|');
      const told = loopBinding(b.root, `told:${b.key}`);
      if (told?.demand === asks) return v;
      bindLoop(b.root, `told:${b.key}`, asks);
      return { decision: 'continue', reason: `停下等用户之前：① 先跑 acceptkit next ${b.demand} --json 看现在的状态（用户可能已经在看板上答过了，别再问一遍）；`
        + `② 你要用户拍板的每件事，都要先记进 acceptkit —— 产品行为 / 范围的决定用 acceptkit plan finding ${b.demand} …（人话写清性质、影响、为什么、选项和后果、推荐），`
        + `卡住的阻塞用 acceptkit blockers ${b.demand} --set … --ask …；只在聊天里问的，用户在看板上看不到也定不了；③ 然后用中文告诉用户去看板哪里定，再停。` };
    }
    return v.decision === 'allow' ? v : { ...v, reason: `验收 ${b.demand} 还没做完（acceptkit next ${b.demand}）。下一张：${v.reason}` };
  },
};

// 这个会话绑定的验收：先按会话 id，再按工作目录（拿不到会话 id 的宿主）
const sessionKey = () => process.env.CLAUDE_CODE_SESSION_ID || process.env.GEMINI_SESSION_ID || null;
function findBinding(n) {
  for (const root of projects()) {
    if (n.session) { const b = loopBinding(root, n.session); if (b) return { ...b, root }; }
    const cwd = resolve(n.cwd || process.cwd());
    const b = listLoopBindings(root).find(x => x.key.startsWith('cwd:') && (cwd === x.cwd || cwd.startsWith(x.cwd + sep)));
    if (b) return { ...b, root };
  }
  return null;
}

/** acceptkit loop start <需求> | stop | status —— 需要项目（绑定记在项目库里） */
export async function loopCmd({ pos, opt }, P) {
  const sub = pos[0];
  const key = sessionKey() || `cwd:${resolve(process.cwd())}`;
  if (sub === 'start') {
    const D = pos[1] || (() => { throw new Error('用法：acceptkit loop start <需求>'); })();
    bindLoop(P.root, key, String(D), resolve(process.cwd()));
    return { kind: 'loop', demand: String(D), key: key.startsWith('cwd:') ? key : '本会话', note: `这个会话在验收 ${D}：没做完宿主不会让你停（装了钩子的话）；做完或要停：acceptkit loop stop` };
  }
  if (sub === 'stop') {
    // 还有执行者能做的卡片就自己解绑 = 停钩子再也拦不住它，看板上一堆待测却没人在跑（实测：做完用户插进来的一件事就 loop stop，前一天开的三个运行 48 条断言没人管）。
    // 所以要停得写理由：用户让停就照抄原话；理由和剩下的件数记下来，看板「没人在跑」时摆给 owner
    const b = loopBinding(P.root, key);
    if (!b) return { kind: 'loop', stopped: false };
    const left = nextCards(P.root, b.demand).filter(c => c.kind !== 'attention');
    const why = String(opt.why || '').trim();
    if (left.length && why.length < 6) throw new Error(`${b.demand} 还有 ${left.length} 件你能做的事（第一件：${left[0].title}），不能就这么停。`
      + `\n   接着做：acceptkit next ${b.demand} --json`
      + `\n   真要停：acceptkit loop stop --why "<为什么停；用户让停就照抄他的原话>" —— 理由会摆在看板上，owner 看得到是谁、为什么、还剩多少`);
    if (left.length) recordLoopStop(P.root, b.demand, { session: key, why, left: left.length });
    return { kind: 'loop', stopped: unbindLoop(P.root, key), ...(left.length ? { left: left.length, note: '理由已记到看板' } : {}) };
  }
  if (sub === 'status' || !sub) return { kind: 'loop', bindings: listLoopBindings(P.root) };
  throw new Error('用法：acceptkit loop start <需求> | stop | status');
}

/** acceptkit hook list | run --host <宿主> --id <H> | install --host <宿主> [--scope project|user] [--print] —— 不需要项目 */
export async function hookCmd({ pos, opt }, self) {
  const sub = pos[0];
  if (sub === 'list' || !sub) return { kind: 'hooks', hooks: HOOKS, hosts: HOST_IDS, problems: hookProblems(HOOKS, Object.keys(DECIDE)), note: `装到宿主：acceptkit hook install --host <${HOST_IDS.join('|')}> [--scope project|user] [--print]` };
  if (!HOST_IDS.includes(String(opt.host))) throw new Error(`--host 只能是 ${HOST_IDS.join(' / ')}`);
  if (sub === 'run') {
    let stdinText = ''; if (!process.stdin.isTTY) for await (const c of process.stdin) stdinText += c;
    const decide = async (hook, n) => DECIDE[hook.run](n, hook);
    const r = await runHook({ host: String(opt.host), id: String(opt.id), hooks: HOOKS, decide, stdinText });
    if (r.stdout) process.stdout.write(r.stdout + '\n');
    if (r.stderr) process.stderr.write(r.stderr);
    return { exitCode: r.code };
  }
  if (sub === 'install') {
    const scope = opt.scope && opt.scope !== true ? String(opt.scope) : 'project';
    const command = `node ${JSON.stringify(self)}`;
    if (opt.print) return { kind: 'hook_snippet', host: opt.host, path: configPath(String(opt.host), scope), snippet: installSnippet(String(opt.host), HOOKS, command) };
    const r = install(String(opt.host), HOOKS, command, { scope, marker: `${self}" hook run` });
    return { kind: 'hook_install', host: opt.host, scope, ...r, note: opt.host === 'codex' ? '新装或改过的钩子要在 Codex 里 /hooks 信任一次才会跑' : '' };
  }
  throw new Error('用法：acceptkit hook list | run --host <宿主> --id <H> | install --host <宿主> [--scope project|user] [--print]');
}
export { DECIDE as _DECIDE };
