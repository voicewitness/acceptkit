// 截图引导：什么时候截、怎么截、画面被挡住怎么办。
//
// 执行者照着命令输出往下干，手册读一遍就忘；所以这段话由工具在它一定会经过的地方说：
// 开跑（run）、记步骤（record --step）、观测完（observe）、记结论被拦（record）、截图被拒（shot）。
// 说法只有这一份，各处按需取几行，免得几处的口径慢慢不一样。
//
// 按平台给命令：Web 没有设备号，也没有 adb / 模拟器，给它打 Android 的命令只会让人照着跑错。

const CLOSE = {
  android: dev => [
    `     返回键关弹窗：adb -s ${dev} shell input keyevent 4`,
    `     点它的按钮：adb -s ${dev} shell input tap <x> <y>（shot 拒绝时会列出画面上能点的按钮和坐标）`,
    `     别的 app / 桌面盖在上面：adb -s ${dev} shell monkey -p <包名> -c android.intent.category.LAUNCHER 1`,
  ],
  ios: () => [
    `     点它的按钮：acceptkit drive tap --platform ios --port <port> --text "<按钮文字>"`,
  ],
};

/** Web：截的是 acceptkit browser 起的那个独立浏览器窗口里的页面，按宿主登记的端口找，不用指定设备。 */
function webPlaybook(run) {
  return [
    `📸 这轮要留页面操作截图：每次验收都要有能证明过程和结果的有效截图（产品规则）。`,
    `   只认 acceptkit shot 截的图 —— 它截的是 acceptkit browser 起的那个浏览器窗口，并先查页面有没有被对话框挡住。`,
    `   什么时候截：① 进到要验的页面 ② 每做完一个触发动作、页面变了 ③ 出结果的那一刻`,
    `   断言的结论图不靠 shot：observe 读页面时同一刻自己截。shot 证明过程，observe 的图证明结论。`,
    `   怎么截：acceptkit shot ${run} --label <这张证明什么> --step <nN>（节点编号看 acceptkit steps <用例>）`,
    `   页面被对话框 / 登录框挡住时 shot 会拒绝：在那个浏览器窗口里关掉再截；被验的就是这个对话框时才用 --allow-obscured "<理由>"（理由会进盲审）。`,
    `   几乎纯色的画面直接拒收（等页面渲染出来再截）。截完打开那张图看一眼：是不是你要证明的那一页。`,
  ];
}

/** 完整的截图做法：开跑时打一次，拒收时再打一次。 */
export function shotPlaybook({ run, platform, dev, bound }) {
  if (platform === 'web') return webPlaybook(run);
  const d = dev || '<设备>';
  const sim = bound ? '' : ` --sim ${d}`;   // run 已绑定设备时 shot 自己找得到，不用再写
  const close = CLOSE[platform];
  return [
    `📸 这轮要留 app 操作截图：每次验收都要有能证明过程和结果的有效截图（产品规则）。`,
    `   只认 acceptkit shot 截的图 —— 它会查 app 在不在跑、画面有没有被挡；自己 screencap 的不算。`,
    `   什么时候截：① app 起来、进到要验的页面 ② 每做完一个触发动作、画面变了 ③ 出结果的那一刻（结果页 / 弹窗 / 拦截提示）`,
    `   断言的结论图不靠 shot：observe 走界面通道，读到判据的同一刻自己截（看板上标「界面验证」的就是这张）。shot 证明过程，observe 的图证明结论。`,
    `   怎么截：acceptkit shot ${run}${sim} --label <这张证明什么> --step <nN>`,
    `   截之前先清场：登录页、权限弹窗、隐私协议、崩溃 / 无响应对话框、Loading、别的 app 盖在上面 —— 先关掉再截。`,
    ...(close ? close(d) : []),
    `     关完再截一次：这类弹窗常常连着冒好几个，shot 会再查。`,
    `   --allow-obscured 只在「被验的就是这个弹窗」时用，理由会进盲审；不是绕过拒绝的开关。`,
    `   截完 shot 当场查：几乎纯白 / 纯黑 / 纯色的画面直接拒收（等画面出来再截；空状态这类本来就空的页面，给节点写 shows，读到了就只提示）；和上一张几乎一样会提示；`,
    `     节点写了 shows（这一步画面上应该出现的字）时，读得到画面层级就核对，缺了拒收。`,
    `   截完打开那张图看一眼：是不是你要证明的那一页。`,
  ];
}

/** 一行提醒：这个 run 到现在还没有截图时，在记步骤 / 观测完之后说。 */
export const shotNudge = ({ run, platform, dev, bound }) => platform === 'web'
  ? `📸 这个 run 还没有一张页面操作截图，记 pass 时会被拒。现在就截：acceptkit shot ${run} --label <画面> --step <nN>`
  : `📸 这个 run 还没有一张 app 操作截图，记 pass 时会被拒。现在就截：acceptkit shot ${run}${bound ? '' : ` --sim ${dev || '<设备>'}`} --label <画面> --step <nN>`
    + `（被登录页 / 弹窗挡住它会拒绝并告诉你怎么关）`;
