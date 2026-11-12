// platform — 用例的平台适用性：**声明 + 算出来**，两者都要成立。
//
// 为什么要有这个文件（读用例的人要能一眼看出它适用哪些平台）：
//   · 大部分用例没写 platform，写了的取值还混着「平台_宿主」这类值（把宿主混进了平台轴）；
//   · 若用 `c.platform || 'ios'` 兜底 —— 没声明的一律按 iOS 解析操作配方，Android 侧没人知道它适不适用。
//     那是「静默缺省」，与静默空操作同族。
// 规矩：platform 必填。一条用例在平台 P 上**可执行**，
// 当且仅当它声明了 P **且**它用到的每个操作在 ops 库里有 P 的配方 —— 后者是机器算的，不是谁写的。
import { recipeFor } from './ops.mjs';
import { hostOfCase } from './hosts.mjs';
export const PLATFORMS = ['ios', 'android', 'both', 'web'];

/**
 * platform 是**多标签**：`["ios","android"]`。
 *
 * 为什么改成多标签（用例要能在多端共享：platform 可以打多个标签，
 * 让需求直接引用同一份用例）：
 * 一个场景（比如「batch 整批执行」「独立注册」）在哪个端都是同一件事，
 * 之前的单值枚举逼着人「为了换个平台复制一份用例」—— 于是同一份规格裂成两份、
 * 各自漂。多标签之后，用例还是那一份，谁要用就把自己那个平台标上。
 *
 * ⚠️ **打上标签 ≠ 跡得起来**：适用性 = 声明了该平台 **且** 用到的每个操作在该平台有配方。
 * 给一条 iOS 用例打上 android 标签只是说「这个场景 Android 也要管」；
 * 操作库里缺 Android 配方时它会显示为 `Android ✗(缺 xxx)`，这正是要让人看见的缺口。
 *
 * 兼容：旧数据的字符串值照收，`both` = `['ios','android']`。
 */
export function normalizePlatforms(c) {
  const v = (c && typeof c === 'object' && !Array.isArray(c)) ? c.platform : c;
  if (!v) return [];
  const list = Array.isArray(v) ? v : (v === 'both' ? ['ios', 'android'] : [v]);
  return [...new Set(list.map(String).filter(p => RUNTIME_PLATFORMS.includes(p)))];
}

/** 写回用的规范形式：单平台给字符串（不动存量），多平台给数组。 */
export function platformValue(list) {
  const u = [...new Set((list || []).filter(p => RUNTIME_PLATFORMS.includes(p)))];
  return u.length === 1 ? u[0] : u;
}
export const RUNTIME_PLATFORMS = ['ios', 'android', 'web'];
export const PLATFORM_LABEL = { ios: 'iOS', android: 'Android', web: 'Web' };

/**
 * 设备引用 → 平台。iOS 模拟器 UDID 是 36 位 GUID；Android 是 `avd:<AVD名>`（身份）、`emulator-NNNN`（当次地址）或真机序列号。
 *
 * `avd:` 这种写法是设备**身份**：模拟器的 serial 端口按启动顺序分配，重启后会指向另一台机器，
 * 所以白名单与租约用身份做键（见 skill/devices.md 第一节）。
 */
export function platformOfUdid(udid) {
  const s = String(udid || '');
  if (/^avd:/i.test(s)) return 'android';
  if (/^emulator-\d+$/.test(s)) return 'android';
  if (/^[0-9A-F-]{36}$/i.test(s)) return 'ios';
  if (/^[0-9A-Za-z]+$/.test(s) && !s.includes('-')) return 'android';
  return null;
}

/** 用例用到的全部操作 id：节点 op_id + 断言 observe.op + 前提 guard(s).op */
export function opsUsedBy(c) {
  const out = new Set();
  const walk = (ns) => (ns || []).forEach(n => {
    if (n.op_id) out.add(n.op_id);
    for (const e of n.expect || []) {
      const o = e.observe; if (!o) continue;
      if (o.op) out.add(o.op);
      for (const g of [...(o.guard ? [o.guard] : []), ...(o.guards || [])]) if (g.op) out.add(g.op);
    }
    walk(n.children);
  });
  walk(c?.tree);
  return [...out];
}

/** { ios:{declared, missing[], ok}, android:{…} } —— missing = 声明了却在该平台没配方的操作 */
/**
 * 用例的 observe 参数里写死了哪些平台的装置。
 *
 * 判据只取**不可能跨平台**的两样：装置 id（udid/serial）与包名/bundle。
 * 这两样一写死，用例就绑在那个平台上了 —— 哪怕 op 在两端都有配方。
 * 占位符（{param.x} / {var.x}）不算写死。
 */
function pinnedDevicePlatforms(c, config) {
  const found = new Set();
  const isPlaceholder = v => /^\{(param|var)\.[A-Za-z0-9_]+\}$/.test(String(v || ''));
  const noteUdid = v => {
    if (!v || isPlaceholder(v)) return;
    const p = platformOfUdid(v); if (p) found.add(p);
  };
  const noteBundle = v => {
    const s = String(v || '');
    if (!s || isPlaceholder(s)) return;
    // iOS bundle 与 Android 包名长得一样，只认项目登记的宿主：只出现在某个宿主 iOS 侧（或只在 Android 侧）的才算写死了平台；
    // 两端同名、没登记的不判。（以前这里写死了某家 iOS 包名的后缀约定，那是项目知识，不该在内核里。）
    const hs = Object.values(config?.hosts || {});
    const onIos = hs.some(h => h.ios?.bundle === s), onAndroid = hs.some(h => h.android?.package === s);
    if (onIos && !onAndroid) found.add('ios');
    if (onAndroid && !onIos) found.add('android');
  };
  const walk = (x) => {
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (!x || typeof x !== 'object') return;
    for (const [k, v] of Object.entries(x)) {
      if (/^(udid|serial|device)$/i.test(k)) noteUdid(v);
      else if (/^(bundle|pkg|package)$/i.test(k)) noteBundle(v);
      else if (k === 'flags' && typeof v === 'string') {
        const mu = v.match(/--udid\s+(\S+)/); if (mu) noteUdid(mu[1]);
        const mb = v.match(/--bundle\s+(\S+)/); if (mb) noteBundle(mb[1]);
      } else walk(v);
    }
  };
  walk(c?.tree || []);
  return [...found];
}

/** config：项目配置（用它登记的宿主认包名属于哪个平台）；不给就不按包名推断 */
export function applicability(c, ops = {}, config = null) {
  const used = opsUsedBy(c);
  const decl = new Set(normalizePlatforms(c));
  const out = {};
  for (const p of RUNTIME_PLATFORMS) {
    const declared = decl.has(p);
    // 按用例在该平台的宿主取配方：宿主自己的（平台@宿主）优先，没有才用与宿主无关的
    const host = hostOfCase(c, p);
    const missing = used.filter(id => { const r = recipeFor(ops[id], p, host)?.recipe; return !r || r.absent; });
    // 🔴 用到 0 个操作的用例不算「可执行」，算「未机器化」。
    //
    // 原来的写法是 `ok = declared && missing.length === 0` —— 没有 observe 规格的用例
    // used 为空，missing 必然为空，于是它在**任何**平台上都算✓。那是典型的「平凡一致」：
    // 换一个毫不相干的平台结论照样成立 ⇒ 这个判据什么都没说。
    // 实测：给三条纯文本的 iOS 用例打上 android 标签，全部显示 Android ✓。
    const machinable = used.length > 0;
    // 🔴 还有一类「声明了却跑不了」：observe 的参数里**写死了别的平台的装置**。
    // 配方查不出来（op 本身两端都有配方），但那条用例在本平台永远跑不动。
    // 实测有用例声明 platform=both，参数里却钉着 iOS 模拟器 UDID 和 iOS bundle
    // —— 它们在 Android 上一次都没跑成，却占着 Android 的分母，
    // 让覆盖看起来有、实则全是 blocked。这跟「用到 0 个操作却算✓」是同一类平凡一致。
    const pinned = pinnedDevicePlatforms(c, config);
    const foreign = pinned.length > 0 && !pinned.includes(p);
    out[p] = { declared, missing, machinable, foreign, pinned,
               ok: declared && machinable && missing.length === 0 && !foreign };
  }
  out.declared = c?.platform || null;
  return out;
}

export function fmtApplicability(a) {
  return RUNTIME_PLATFORMS.filter(p => p !== 'web' || a.web?.declared).map(p => {
    const x = a[p];
    if (!x.declared) return `${PLATFORM_LABEL[p]} －`;
    if (x.ok) return `${PLATFORM_LABEL[p]} ✓`;
    if (!x.machinable) return `${PLATFORM_LABEL[p]} ✗(未机器化：没有 observe 规格)`;
    // foreign 要先报：它的 missing 是空的，不先判会显示成 `✗(缺 )` —— 看不出为什么不适用
    if (x.foreign) return `${PLATFORM_LABEL[p]} ✗(参数里写死了 ${x.pinned.map(q => PLATFORM_LABEL[q] || q).join('/')} 的装置)`;
    return `${PLATFORM_LABEL[p]} ✗(缺 ${x.missing.join(',')})`;
  }).join(' · ');
}

/** 本轮实际跑在哪个平台：单平台用例就是它自己；both 用例看 device claim 记进 run 的平台 */
export function runtimePlatform(c, res) {
  const decl = normalizePlatforms(c);
  if (decl.length === 1) return decl[0];
  return res?.device?.platform || null;
}
