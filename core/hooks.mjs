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
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, sep, basename } from 'node:path';
import { readUserConfig, readConfig } from './project.mjs';
import { loadLeases, loopBinding, listLoopBindings, unbindLoop, bindLoop } from './store/db.mjs';
import { nextCards } from './next.mjs';
import * as ANDROID from '../adapters/android/device.mjs';
import { runHook, verdictOf, hookProblems, installSnippet, install, configPath, HOST_IDS } from './host-hooks.mjs';

export const HOOKS = [
  { id: 'H1', event: 'before_tool', on: 'shell', run: 'guard_device', mode: 'block', title: '动验收设备只走 acceptkit',
    match: 'emulator[^|;&]*-avd|avdmanager[^|;&]*\\bcreate|simctl\\s+(boot|shutdown|erase|install|uninstall|clone|create|delete)|adb\\b[^|;&]*\\b(install|uninstall|emu\\s+kill|shell\\s+pm\\s+(clear|uninstall))|\\.avd/[^ ]*\\.lock|cp\\s[^|;&]*\\.avd' },
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
    const hit = cmds.flatMap(devicesIn).map(id => [id, acc.get(id) || acc.get(id.toUpperCase())]).find(([, why]) => why);
    if (!hit) return { decision: 'allow' };
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
  if (sub === 'stop') return { kind: 'loop', stopped: unbindLoop(P.root, key) };
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
