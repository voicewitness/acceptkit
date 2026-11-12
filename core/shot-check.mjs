// 事中截图检测：截图那一刻就查出明显无效的画面，当场拒收或提示，不等盲审。
//
// 只放纯函数（不读设备、不调模型），shot 的三条分支和 observe 的 UI 通道共用：
//   · 纯色画面：白屏 / 黑屏 / 还在加载，画面上什么都证明不了 —— 拒收；放行口只有一个：这一步该有的字
//     （节点的 shows）确实在这张图上读到了 —— 空状态、只有一行提示的页面本来就几乎是空的；
//   · 和上一张几乎一样：上一步的动作可能没生效，或挂错了图 —— 只提示；
//   · 画面上的字：遮蔽层关键词（读不到画面层级时由 OCR 补位）、这一步应该出现的字（节点的 shows）。
import { inflateSync } from 'node:zlib';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };   // 灰度 / RGB / 灰度+alpha / RGBA

/** 解码 8 位、非隔行的 PNG。认不出的格式返回 null（调用方当成「没法检测」，不当成「干净」）。 */
export function decodePng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || !buf.subarray(0, 8).equals(SIG)) return null;
  let off = 8, width = 0, height = 0, ch = 0;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString('latin1', off + 4, off + 8), body = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      const depth = body[8], color = body[9], interlace = body[12];
      ch = CHANNELS[color] || 0;
      if (depth !== 8 || !ch || interlace !== 0) return null;   // 16 位、调色板、隔行：截图工具不产出，不支持
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!width || !height || !ch || !idat.length) return null;
  let raw;
  try { raw = inflateSync(Buffer.concat(idat)); } catch { return null; }
  const stride = width * ch;
  if (raw.length < (stride + 1) * height) return null;
  const data = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x];
      const a = x >= ch ? data[dst + x - ch] : 0;
      const b = y ? data[dst - stride + x] : 0;
      const c = x >= ch && y ? data[dst - stride + x - ch] : 0;
      let p;
      if (f === 0) p = 0;
      else if (f === 1) p = a;
      else if (f === 2) p = b;
      else if (f === 3) p = (a + b) >> 1;
      else if (f === 4) { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      else return null;
      data[dst + x] = (v + p) & 0xff;
    }
  }
  return { width, height, channels: ch, data };
}

// 去掉状态栏（顶部 6%）和导航条（底部 8%）：它们在白屏上照样有字，会把纯色画面算成「有内容」
const bodyRows = img => [Math.floor(img.height * 0.06), img.height - Math.floor(img.height * 0.08)];
const rgbAt = (img, i) => img.channels >= 3 ? [img.data[i], img.data[i + 1], img.data[i + 2]] : [img.data[i], img.data[i], img.data[i]];

/** 主色占比：各通道差 ≤ 12 视为同色。返回 { ratio, color: '#rrggbb', name }。 */
export function blankness(img) {
  const [y0, y1] = bodyRows(img);
  const total = img.width * Math.max(0, y1 - y0);
  if (!total) return null;
  const step = Math.max(1, Math.ceil(Math.sqrt(total / 250_000)));   // 抽样到 25 万点以内，大图也是毫秒级
  const buckets = new Map(), samples = [];
  for (let y = y0; y < y1; y += step) for (let x = 0; x < img.width; x += step) {
    const px = rgbAt(img, (y * img.width + x) * img.channels);
    samples.push(px);
    const k = (px[0] >> 3) << 10 | (px[1] >> 3) << 5 | px[2] >> 3;
    const s = buckets.get(k) || [0, 0, 0, 0];
    s[0]++; s[1] += px[0]; s[2] += px[1]; s[3] += px[2];
    buckets.set(k, s);
  }
  let top = null;
  for (const s of buckets.values()) if (!top || s[0] > top[0]) top = s;
  const main = [top[1], top[2], top[3]].map(v => Math.round(v / top[0]));
  const same = samples.filter(p => Math.abs(p[0] - main[0]) <= 12 && Math.abs(p[1] - main[1]) <= 12 && Math.abs(p[2] - main[2]) <= 12).length;
  const color = '#' + main.map(v => v.toString(16).padStart(2, '0')).join('');
  const name = Math.min(...main) >= 235 ? '纯白' : Math.max(...main) <= 25 ? '纯黑' : `纯色（${color}）`;
  return { ratio: Math.round(same / samples.length * 1000) / 1000, color, name };
}

/** 64 位差值哈希（dHash），16 位十六进制。 */
export function dHash(img) {
  const [y0, y1] = bodyRows(img);
  const h = Math.max(1, y1 - y0), cells = [];
  for (let gy = 0; gy < 8; gy++) for (let gx = 0; gx < 9; gx++) {
    const ya = y0 + Math.floor(gy * h / 8), yb = Math.max(ya + 1, y0 + Math.floor((gy + 1) * h / 8));
    const xa = Math.floor(gx * img.width / 9), xb = Math.max(xa + 1, Math.floor((gx + 1) * img.width / 9));
    const sy = Math.max(1, Math.floor((yb - ya) / 16)), sx = Math.max(1, Math.floor((xb - xa) / 16));
    let sum = 0, n = 0;
    for (let y = ya; y < yb; y += sy) for (let x = xa; x < xb; x += sx) {
      const [r, g, b] = rgbAt(img, (y * img.width + x) * img.channels);
      sum += r * 299 + g * 587 + b * 114; n++;
    }
    cells.push(sum / n);
  }
  let hex = '';
  for (let gy = 0; gy < 8; gy++) {
    let byte = 0;
    for (let gx = 0; gx < 8; gx++) byte = byte << 1 | (cells[gy * 9 + gx] > cells[gy * 9 + gx + 1] ? 1 : 0);
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

export function hamming(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i += 2) { let x = parseInt(a.slice(i, i + 2), 16) ^ parseInt(b.slice(i, i + 2), 16); while (x) { d += x & 1; x >>= 1; } }
  return d;
}

const norm = s => String(s).replace(/\s+/g, '').toLowerCase();

/** 画面文字里命中的遮蔽层（关键词表由调用方给，含项目扩展追加的）。 */
export function textObscuring(text, obscuring) {
  const lines = String(text || '').split('\n').map(t => t.trim()).filter(Boolean), hits = [];
  for (const o of obscuring) {
    const line = lines.find(t => o.any.some(s => t.includes(s)));
    if (line) hits.push({ ...o, matched_text: line.slice(0, 60) });
  }
  return hits;
}

/** shows 里画面上找不到的那几条。 */
export const missingShows = (text, shows) => (shows || []).filter(s => !norm(text || '').includes(norm(s)));

// 阈值按真实截图定：一页几行字的列表、一屏 JSON 主色就有 97%–99%，是有效证据，只能提示；
// 白屏、加载圈、启动黑屏在 99.5% 以上。提示线再低就会在四分之一的正常截图上响，没人会看。
export const BLANK_REFUSE = 0.995, BLANK_HINT = 0.97, SIMILAR_MAX = 3;

/**
 * 纯色画面怎么处理：{ refuse } | { hint } | null。
 * readable = 这张图该证明的字确实读到了（shows 全在、observe 的读值在截图上）——
 * 这时几乎纯色说明页面本来就空（空状态、一行提示），只提示；否则什么都证明不了，拒收。
 * what = 拒收后该做什么（截图：等画面出来再截；观测：再观测，或白屏本身就是被测物的问题时怎么记）。
 */
export function blankVerdict(blank, { readable = false, what = '等画面出来再截' } = {}) {
  if (!blank || blank.ratio < BLANK_HINT) return null;
  const pct = `占 ${Math.round(blank.ratio * 100)}%`;
  if (blank.ratio < BLANK_REFUSE) return { hint: `画面大部分是${blank.name}（${pct}）：打开图确认不是加载中、白屏或黑屏` };
  if (readable) return { hint: `画面几乎是${blank.name}（${pct}），但该有的字在图上读到了，按空页面放行：打开图确认不是加载中` };
  return { refuse: `画面几乎是${blank.name}（${pct}），多半还在加载、白屏或黑屏：${what}` };
}

/**
 * 一张截图的事中检测。
 *   img / prev：decodePng 的结果（prev 是本 run 上一张 app 截图，没有就 null）
 *   text / source：画面文字和它的来源（hierarchy | ocr | none）
 *   shows：这一步画面上应该出现的字；obscuring：要用画面文字查遮蔽层时给关键词表，否则不给
 * 返回 { checks（写进 sidecar）, refuse（拒收理由）, hints（提示）, obscured（文字里命中的遮蔽层，放不放行由调用方按 --allow-obscured 定） }
 */
export function judgeShot({ img, prev = null, prevFile = null, text = null, source = 'none', shows = [], obscuring = null }) {
  const refuse = [], hints = [];
  const blank = img ? blankness(img) : null;
  if (!img) hints.push('这张图解不开（不是 8 位 PNG），没做纯色 / 相似检测：打开图看一眼');
  const miss = source === 'none' ? [...(shows || [])] : missingShows(text, shows);
  // 放行要正面证据：节点写了 shows 且全都读到了。画面层级里随便有几个字不算 —— 白屏时层级照样有字
  const readable = !!(shows || []).length && !miss.length;
  const bv = blankVerdict(blank, { readable,
    what: `等画面出来再截；这一页本来就几乎是空的（空状态、只有一行提示），给这一步写上 shows（画面上该有的字），读到了就只提示` });
  if (bv?.refuse) refuse.push(bv.refuse); else if (bv?.hint) hints.push(bv.hint);
  let similar_to = null;
  if (img && prev && hamming(dHash(img), dHash(prev)) <= SIMILAR_MAX) {
    similar_to = prevFile;
    hints.push(`和上一张${prevFile ? ` ${prevFile}` : ''} 几乎一样：上一步的动作可能没生效，或挂错了图`);
  }
  const obscured = obscuring && text ? textObscuring(text, obscuring) : [];
  if (miss.length) {
    const q = `「${miss.join('」「')}」`;
    if (source === 'hierarchy') refuse.push(`这一步画面上应该出现的字没找到：${q}。确认停在了这一步该到的页面再截；用例的 shows 写错了就改用例`);
    else if (source === 'ocr') hints.push(`OCR 没在画面上认出${q}（OCR 会漏认，只提示）：打开图确认是不是这一步该到的页面`);
    else hints.push(`读不到画面上的字，没法核对这一步应该出现的${q}：打开图看一眼`);
  }
  const checks = { blank: blank && { ratio: blank.ratio, color: blank.color, ...(blank.ratio >= BLANK_REFUSE && readable ? { released_by: 'shows' } : {}) }, similar_to, screen_text_source: source,
                   shows_missing: miss, screen_text_excerpt: text ? String(text).replace(/\s+/g, ' ').trim().slice(0, 300) : '' };
  return { checks, refuse, hints, obscured };
}
