#!/usr/bin/env node
// 逐断言查「图片证据合不合格」。由 review-nudge hook 在每次 record 之后调用。
//
// ⚠️ 这个工具的语义翻转过一次，翻转的理由值得记下来：
//   · 最初：为了「有图可看」加了一个把四段式证据渲成卡片的脚本，
//     本工具当时的职责是**催补图**（missing = 结论性断言一张图都没有）。
//   · 后来发现：文字排版成的卡片只是把文字转成了图片，不证明任何东西，属于无效图片。
//   ⇒ 所以现在反过来：**不再催补图，改成揪出文字图**。
//
// 现在的判据：
//   · 用例里声明了 via（log / diag / debugger / cli）+ why_not_ui 的断言 ⇒ 不要求图，判据交给 observe 亲自采的原文；
//     没声明的一律按界面上的断言：要读到结论那一刻的 app 截图（evidence-gate assertionGaps，与报告、看板、next 同一份）；
//   · 判据面确实是 UI 的断言 ⇒ 要在读到那个值的同一刻截的设备屏（kind=ui_observe）；
//   · 文字排版成的卡片（kind=card / PNG 里带出卡标记）⇒ **无效证据**，报出来摘挂并删盘；
//   · 过程图 / 手工截图占着断言证据位 ⇒ 同样报出来，它们该挂 --step 而不是断言。
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { imageKind, ASSERT_IMAGE_KINDS, INVALID_ASSERT_IMAGE_KINDS, setCardMarkers } from './evidence-gate.mjs';

import { loadProject } from './project.mjs';
const PROJ = await loadProject();
setCardMarkers(PROJ.config?.evidence?.cardMarkers);
if (!PROJ.root) { console.error('visual-gate: 找不到项目（--project / ACCEPTKIT_PROJECT）'); process.exit(2); }
const ROOT = PROJ.root;
const run = process.argv[2];
if (!run) { console.error('用法: visual-gate.mjs <run> [--json]'); process.exit(2); }
const dir = join(ROOT, 'runs', run);
const res = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'));

const shots = (() => {
  const out = [];
  (function walk(d) {
    if (!existsSync(d)) return;
    for (const f of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, f.name);
      if (f.isDirectory()) walk(p);
      else if (/\.(png|jpe?g)$/i.test(f.name)) out.push(p.slice(dir.length + 1));
    }
  })(dir);
  return out;
})();

const referenced = new Set(Object.values(res.results || {})
  .flatMap(v => (v.evidence || []).filter(x => /\.(png|jpe?g)$/i.test(x))));
const orphans = shots.filter(f => !referenced.has(f));

const textCards = [];   // 文字转图片的卡片挂在断言上 —— 无效，要删
const notUI = [];       // 过程图/手工图挂在断言上 —— 该挂 --step
for (const [id, v] of Object.entries(res.results || {})) {
  for (const x of (v.evidence || []).filter(y => /\.(png|jpe?g)$/i.test(y))) {
    const k = imageKind(dir, x);
    if (INVALID_ASSERT_IMAGE_KINDS.has(k)) textCards.push(`${id}:${x}`);
    else if (!ASSERT_IMAGE_KINDS.has(k)) notUI.push(`${id}:${x}(${k})`);
  }
}
// 盘上还躺着的文字卡（哪怕没挂在断言上）也报出来 —— 看板会把它们折进留档区，仍然是噪音
const strayCards = shots.filter(f => INVALID_ASSERT_IMAGE_KINDS.has(imageKind(dir, f)));

const out = { run, shots: shots.length, text_cards: textCards, stray_cards: strayCards, not_ui: notUI, orphans };
if (process.argv.includes('--json')) { console.log(JSON.stringify(out)); process.exit(0); }
console.log(`run ${run}：shots ${shots.length} 张`);
console.log(textCards.length
  ? `  🗑 无效图片证据（文字转图片的卡片挂在断言上）${textCards.length} 张：${textCards.join(' ')}`
  : '  ✅ 断言位上没有文字转图片的卡片');
if (strayCards.length) console.log(`  🗑 盘上还有文字卡 ${strayCards.length} 张（没挂在断言上，但仍占着 run 目录）：${strayCards.join(' ')}`);
if (notUI.length) console.log(`  ⚠️ 占着断言证据位但不是「读到值那一刻的设备截图」${notUI.length} 张（该挂 --step）：${notUI.join(' ')}`);
if (orphans.length) console.log(`  ⚠️ 孤儿图 ${orphans.length} 张（没被任何断言引用 ⇒ 看板画廊不展示）：${orphans.join(' ')}`);
