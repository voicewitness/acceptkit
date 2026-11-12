// 界面读值的纯逻辑：解析 Android uiautomator dump、决定一条 read 在哪些行里找。不碰设备，单测直接测。

/** 一条 read 从哪些行里找：缺省整屏；after = 紧跟某行的下一行；desc = content-desc 命中的节点的字（Android） */
export function readPool(rd, { seq, texts, nodes }, fill = String) {
  // desc：按节点的 content-desc（稳定 id）找节点读它的字 —— 文案改了也不错位，比 after 靠相邻顺序准
  // （实测：一行是「容器 / 标题 / 值」三个节点，after 只取下一个，落到标题上，读错判 fail）
  if (rd.desc) { const dr = new RegExp(fill(rd.desc)); return nodes.filter(n => n.desc && dr.test(n.desc)).map(n => n.text.trim()).filter(Boolean); }
  // after：读「紧跟在某一行后面的那一行」—— 一个 cell 的标题和副标题是相邻两段文本（例：某一行下面的 detail=/path=）
  // 用去重前的序列：两行的副标题逐字相同（如同为 detail=[] … path=…）时，去重会把后一个吃掉，「紧跟」就错位了
  if (rd.after) { const ar = new RegExp(fill(rd.after)); const i = seq.findIndex(t => ar.test(t)); return i >= 0 ? seq.slice(i + 1, i + 2) : []; }
  return texts;
}

// 画面上的文字和可点元素（uiautomator dump 的 XML）
export function parseUiDump(xml) {
  const attr = (tag, k) => (tag.match(new RegExp(` ${k}="([^"]*)"`)) || [])[1] || '';
  const nodes = [];
  for (const [tag] of xml.matchAll(/<node [^>]*>/g)) {
    const unesc = v => v.replace(/&(amp|lt|gt|quot|apos|#\d+);/g, (m, e) =>
      ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[e] ?? String.fromCodePoint(+e.slice(1))).trim();
    const desc = unesc(attr(tag, 'content-desc'));
    const text = unesc(attr(tag, 'text')) || desc;
    const b = attr(tag, 'bounds').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (!text || !b) continue;
    // desc 单独留着：业务常把稳定 id 挂在 content-desc 上、值挂在 text 上（读值用 read.desc 按 id 找节点）
    nodes.push({ text, desc, pkg: attr(tag, 'package'), clickable: attr(tag, 'clickable') === 'true', center: [Math.round((+b[1] + +b[3]) / 2), Math.round((+b[2] + +b[4]) / 2)] });
  }
  return nodes;
}
