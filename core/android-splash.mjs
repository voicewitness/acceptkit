/**
 * 「聚焦的 Activity 名字带 Splash」只是启动页的嫌疑，不是结论：有的 App 新装后首页 Feed 就挂在
 * 名字带 Splash 的 Activity 里（实测：焦点窗口是 …SplashActivity 时画面上是完整 Feed，
 * 层级里读得到视频、点赞、评论这些控件），按名字判会把每一张 Feed 截图都拒掉。
 * 画面层级里有被测包自己的 3 个以上带字的可点控件 = 页面已经起来了，撤掉这一条；读不到层级时不撤。
 */
export function dropSplashIfPageIsUp(hits, nodes, pkg) {
  const live = (nodes || []).filter(n => n.clickable && n.pkg === pkg && String(n.text || '').trim()).length;
  return live >= 3 ? hits.filter(h => !h.splash) : hits;
}
