import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUiDump, readPool } from '../core/screen-read.mjs';

// 一行三个节点：容器（desc=id，无字）/ 标题 / 值（desc=id_value）—— 业务诊断页的常见排法
const xml = `<hierarchy>
<node text="" content-desc="seq.headline" bounds="[0,100][1080,200]" package="p" clickable="false" />
<node text="✅ 逐步对账一致" content-desc="" bounds="[0,100][540,200]" package="p" clickable="false" />
<node text="新链 0.0.3（r5）" content-desc="seq.headline_value" bounds="[540,100][1080,200]" package="p" clickable="false" />
<node text="&amp;下一行" content-desc="" bounds="[0,200][1080,300]" package="p" clickable="true" />
</hierarchy>`;

test('Android 读值：desc 按 content-desc 找到值节点；after 只取紧跟的下一个', () => {
  const nodes = parseUiDump(xml);
  assert.deepEqual(nodes.map(n => n.text), ['seq.headline', '✅ 逐步对账一致', '新链 0.0.3（r5）', '&下一行']);
  assert.equal(nodes[2].desc, 'seq.headline_value');
  const seq = nodes.map(n => n.text), ctx = { seq, texts: [...new Set(seq)], nodes };
  assert.deepEqual(readPool({ desc: '^seq\\.headline_value$' }, ctx), ['新链 0.0.3（r5）']);
  assert.deepEqual(readPool({ after: '^seq\\.headline$' }, ctx), ['✅ 逐步对账一致']);
  assert.deepEqual(readPool({ desc: '^nope$' }, ctx), []);
  const fill = t => t.replace('{param.id1}', 'seq.headline');
  assert.deepEqual(readPool({ desc: '^{param.id1}_value$' }, ctx, fill), ['新链 0.0.3（r5）']);
});
