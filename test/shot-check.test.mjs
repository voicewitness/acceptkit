// 事中截图检测：纯色画面拒收、相近画面提示、画面上应该出现的字（shows）。
// PNG 在测试里自己生成，不碰设备；shows 的字段校验走 CLI。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decodePng, blankness, blankVerdict, dHash, hamming, judgeShot, textObscuring } from '../core/shot-check.mjs';

const BIN = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'bin', 'acceptkit.mjs');
const ak = (dir, ...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, ACCEPTKIT_PROJECT: dir, HOME: dir } });

// ---- 生成 PNG：每行轮流用五种行过滤，顺带测解码 ----
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = b => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, body) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
  const tb = Buffer.concat([Buffer.from(type, 'latin1'), body]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(tb));
  return Buffer.concat([len, tb, crc]);
};
function png(w, h, ch, px) {   // px(x, y) → 长度为 ch 的数组
  const colorType = { 1: 0, 3: 2, 4: 6 }[ch];
  const stride = w * ch, raw = Buffer.alloc((stride + 1) * h), rows = [];
  for (let y = 0; y < h; y++) { const r = Buffer.alloc(stride); for (let x = 0; x < w; x++) px(x, y).forEach((v, i) => { r[x * ch + i] = v; }); rows.push(r); }
  for (let y = 0; y < h; y++) {
    const f = y % 5, cur = rows[y], up = y ? rows[y - 1] : Buffer.alloc(stride), o = y * (stride + 1);
    raw[o] = f;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0, b = up[x], c = x >= ch ? up[x - ch] : 0;
      const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
      raw[o + 1 + x] = (cur[x] - pred) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = colorType;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const rand = seed => () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const noise = (seed, ch = 3) => { const r = rand(seed), m = new Map(); return (x, y) => { const k = `${x},${y}`; if (!m.has(k)) m.set(k, Array.from({ length: ch }, () => Math.floor(r() * 256))); return m.get(k); }; };

test('解码：RGB / RGBA / 灰度，五种行过滤都还原得对', () => {
  const f = noise(7, 3), img = decodePng(png(23, 17, 3, f));
  assert.equal(img.width, 23); assert.equal(img.height, 17); assert.equal(img.channels, 3);
  for (const [x, y] of [[0, 0], [22, 16], [5, 9], [11, 3]]) assert.deepEqual([...img.data.slice((y * 23 + x) * 3, (y * 23 + x) * 3 + 3)], f(x, y));
  const g = noise(9, 4), rgba = decodePng(png(10, 10, 4, g));
  assert.deepEqual([...rgba.data.slice((7 * 10 + 4) * 4, (7 * 10 + 4) * 4 + 4)], g(4, 7));
  assert.equal(decodePng(png(8, 8, 1, () => [128])).data[20], 128);
  assert.equal(decodePng(Buffer.from('not a png')), null);
});

test('纯白、纯黑拒收；大部分纯色只提示；杂色不报', () => {
  const white = judgeShot({ img: decodePng(png(60, 120, 3, () => [255, 255, 255])) });
  assert.equal(white.refuse.length, 1); assert.match(white.refuse[0], /纯白（占 100%）.*等画面出来再截/);
  assert.equal(white.checks.blank.color, '#ffffff');
  // 状态栏 / 导航条的字不算内容：只在顶部 6%、底部 8% 有字的白屏照样是白屏
  const bars = (x, y) => (y < 6 || y >= 112) && x % 3 === 0 ? [0, 0, 0] : [255, 255, 255];
  assert.equal(blankness(decodePng(png(60, 120, 3, bars))).ratio, 1);
  const black = judgeShot({ img: decodePng(png(60, 120, 4, () => [0, 0, 0, 255])) });
  assert.match(black.refuse[0], /纯黑/);
  // 白底上几行字（约 2% 的内容）：97%–99.5% 档，提示不拒 —— 真实的稀疏列表页就在这一档
  const sparse = judgeShot({ img: decodePng(png(100, 200, 3, (x, y) => y >= 50 && y < 53 ? [20, 20, 20] : [250, 250, 250])) });
  assert.equal(sparse.refuse.length, 0); assert.match(sparse.hints.join(), /大部分是纯白（占 98%）/);
  // 内容再少一半以上也还是提示；到 99.5% 以上才拒
  const tiny = (x, y) => x < 20 && y >= 50 && y < 52 ? [20, 20, 20] : [250, 250, 250];
  assert.ok(blankness(decodePng(png(100, 200, 3, tiny))).ratio >= 0.995);
  assert.equal(judgeShot({ img: decodePng(png(100, 200, 3, tiny)) }).refuse.length, 1);
  const busy = judgeShot({ img: decodePng(png(60, 120, 3, noise(3))) });
  assert.equal(busy.refuse.length, 0); assert.equal(busy.hints.length, 0);
  assert.ok(busy.checks.blank.ratio < 0.1);
});

test('本来就几乎是空的页面（空状态）：shows 全读到了才放行成提示；没写 shows、只靠层级里有字都不放行', () => {
  // 白底、一个小图标、一行短字：主色占比 ≥ 99.5%
  const page = (x, y) => (x >= 95 && x < 105 && y >= 150 && y < 160) ? [180, 180, 200]
    : (x >= 70 && x < 130 && y >= 190 && y < 192) ? [60, 60, 60] : [255, 255, 255];
  const img = decodePng(png(200, 400, 3, page));
  assert.ok(blankness(img).ratio >= 0.995, `ratio ${blankness(img).ratio}`);
  const shows = ['暂无数据'];
  const h = judgeShot({ img, text: '消息\n暂无数据', source: 'hierarchy', shows });
  assert.deepEqual(h.refuse, []);
  assert.match(h.hints.join(), /该有的字在图上读到了，按空页面放行/);
  assert.equal(h.checks.blank.released_by, 'shows');
  const o = judgeShot({ img, text: '暂无数据', source: 'ocr', shows });
  assert.deepEqual(o.refuse, [], 'OCR 在这张图上认出了该有的字，同样放行');
  // 没写 shows：层级里有字也不算（白屏时层级照样有字），拒收并说出放行的办法
  const noShows = judgeShot({ img, text: '消息\n暂无数据', source: 'hierarchy' });
  assert.match(noShows.refuse.join(), /几乎是纯白.*给这一步写上 shows/);
  assert.equal(noShows.checks.blank.released_by, undefined);
  // shows 没读到：两条都拒；读不到字：拒
  assert.equal(judgeShot({ img, text: '消息', source: 'hierarchy', shows }).refuse.length, 2);
  assert.match(judgeShot({ img, shows }).refuse.join(), /几乎是纯白/);
});

test('observe 用的纯色判定：读值在图上认得出才放行，拒收时说出白屏是被测物问题时怎么记', () => {
  const blank = { ratio: 0.998, color: '#ffffff', name: '纯白' };
  assert.match(blankVerdict(blank, { readable: true }).hint, /按空页面放行/);
  assert.match(blankVerdict(blank, { what: '再观测；白屏就是 app 的问题：record --status fail --failure-of subject' }).refuse, /--failure-of subject/);
  assert.match(blankVerdict({ ...blank, ratio: 0.98 }).hint, /大部分是纯白/);
  assert.equal(blankVerdict({ ...blank, ratio: 0.5 }), null);
  assert.equal(blankVerdict(null), null);
});

test('和上一张几乎一样：提示，记下是哪张；不一样的图不报', () => {
  const base = noise(11);
  const a = decodePng(png(90, 160, 3, base));
  const b = decodePng(png(90, 160, 3, (x, y) => x === 3 && y < 20 ? [0, 0, 0] : base(x, y)));
  const c = decodePng(png(90, 160, 3, noise(12)));
  assert.ok(hamming(dHash(a), dHash(b)) <= 3);
  const near = judgeShot({ img: b, prev: a, prevFile: 'shots/app-01-home.png' });
  assert.equal(near.checks.similar_to, 'shots/app-01-home.png');
  assert.match(near.hints.join(), /和上一张 shots\/app-01-home\.png 几乎一样：上一步的动作可能没生效/);
  assert.equal(near.refuse.length, 0);
  const far = judgeShot({ img: c, prev: a, prevFile: 'shots/app-01-home.png' });
  assert.equal(far.checks.similar_to, null); assert.equal(far.hints.length, 0);
});

test('shows：画面层级缺字拒收，OCR 缺字只提示，读不到字提示看图；结果写进 checks', () => {
  const img = decodePng(png(60, 120, 3, noise(5)));
  const shows = ['已退出登录', '重新登录'];
  const h = judgeShot({ img, text: '设置\n已退出 登录', source: 'hierarchy', shows });
  assert.deepEqual(h.checks.shows_missing, ['重新登录']);
  assert.match(h.refuse.join(), /应该出现的字没找到：「重新登录」/);
  assert.equal(h.checks.screen_text_source, 'hierarchy'); assert.equal(h.checks.screen_text_excerpt, '设置 已退出 登录');
  const o = judgeShot({ img, text: '设置', source: 'ocr', shows });
  assert.equal(o.refuse.length, 0); assert.match(o.hints.join(), /OCR 没在画面上认出「已退出登录」「重新登录」/);
  const n = judgeShot({ img, shows });
  assert.equal(n.refuse.length, 0); assert.deepEqual(n.checks.shows_missing, shows); assert.equal(n.checks.screen_text_source, 'none');
  assert.deepEqual(judgeShot({ img, text: '已退出登录 · 重新登录', source: 'hierarchy', shows }).refuse, []);
  assert.deepEqual(Object.keys(h.checks).sort(), ['blank', 'screen_text_excerpt', 'screen_text_source', 'shows_missing', 'similar_to']);
});

test('OCR 补位：画面文字里认出遮蔽层关键词，带上关法', () => {
  const OB = [{ name: '系统权限弹窗', any: ['Allow', '允许'], how: '点掉它' }, { name: 'Loading', any: ['正在加载'], how: '等' }];
  const hits = textObscuring('首页\n"App" Would Like to Send You Notifications\nDon\'t Allow', OB);
  assert.equal(hits.length, 1); assert.equal(hits[0].how, '点掉它'); assert.match(hits[0].matched_text, /Allow/);
  const j = judgeShot({ img: decodePng(png(60, 120, 3, noise(6))), text: '正在加载', source: 'ocr', obscuring: OB });
  assert.equal(j.obscured[0].name, 'Loading');
  assert.equal(judgeShot({ img: null, text: '正在加载', source: 'ocr' }).obscured.length, 0);   // 不给关键词表就不查
});

test('validate 认识 shows：必须是非空字符串数组', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acceptkit-test-'));
  for (const d of ['cases', 'runs', 'state/plans', 'knowledge', 'ops']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'acceptkit.project.json'), JSON.stringify({ name: 't', gate: { allow: [] } }));
  const put = (name, shows) => writeFileSync(join(dir, 'cases', `${name}.case.json`), JSON.stringify({ case: name, title: '退出登录', platform: 'android',
    tree: [{ op: '点退出登录', shows, expect: [{ id: 'E1', assert: '回到登录页', judge: 'human', human_why: '示例' }] }] }));
  put('good', ['已退出登录']);
  const ok = ak(dir, 'validate', 'good');
  assert.equal(ok.status, 0, ok.stderr); assert.doesNotMatch(ok.stdout, /shows 不认识/);
  for (const [name, bad] of [['empty', []], ['str', '已退出登录'], ['blank', ['  ']], ['num', [1]]]) {
    put(name, bad);
    const r = ak(dir, 'validate', name);
    assert.equal(r.status, 1, name); assert.match(r.stderr, /shows 必须是非空的字符串数组/, name);
  }
});
