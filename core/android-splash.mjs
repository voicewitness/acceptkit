/**
 * 「聚焦的 Activity 名字带 Splash」只是启动页的嫌疑，不是结论：有的 App 首页 Feed 就挂在
 * 名字带 Splash 的 Activity 里（实测：焦点窗口是 …SplashActivity 时画面上是完整 Feed，
 * 层级里读得到视频、点赞、评论这些控件），按名字判会把每一张 Feed 截图都拒掉。
 * 页面已经起来的两种迹象，任一成立就撤掉这一条（读不到层级时不撤）：
 *  - 被测包自己的 3 个以上带字的可点控件；
 *  - 被测包自己 5 条以上不同的字。底栏常是外层框可点、不带字，字在里面不可点的文字节点上 ——
 *    只数「可点又带字」时同一个 Feed 有时过有时拒（实测：同一轮里同一个 Feed 先放行后被拒）。
 *    真启动页只有 logo、广告的「跳过」这类寥寥几个字，到不了 5 条。
 */
export function dropSplashIfPageIsUp(hits, nodes, pkg) {
  const own = (nodes || []).filter(n => n.pkg === pkg && String(n.text || '').trim());
  const clickable = own.filter(n => n.clickable).length;
  const distinct = new Set(own.map(n => String(n.text).trim())).size;
  return clickable >= 3 || distinct >= 5 ? hits.filter(h => !h.splash) : hits;
}
