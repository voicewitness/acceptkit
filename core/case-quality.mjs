// 用例质量标准：新增 / 修改用例时按这套规则检查。规则来自真实用例库里反复出现的坏写法，
// 每条写明「教训」—— 违反它在历史上导致过什么（假通过、平凡成立、执行到一半才发现不能做……）。
//
// 两档：block = 新增或改过的用例不达标就不能进评审单批准、不能开跑；warn = 列出来，作者确认。
// 存量用例按基线登记（doctor --fix），基线里已有的问题记为质量债，只提示不拦；改过的用例只拦新增的问题。
// 晚于基线加进来的规则写 since（日期）：对基线里的存量用例只提示，对新用例照常拦 —— 加一条规则不该把存量一夜卡死。
// 个别断言确实要例外：在断言或节点上写 quality_waive: [{ rule: "Q04", why: "…" }]，理由进报告。
//
// 机器判断不了的写成 QUESTIONS：新建用例和评审时列出来，由作者 / 评审人逐条回答。
// 项目特有的规则（某个已淘汰的观测面、某类用例必须带的守卫）由 pack.qualityRules 追加，格式同 RULES。
import { guardsOf, nonUiRead, bindingOf } from './evidence-gate.mjs';
import { claimWordsOf, effectClaims, uncoveredClaims, opLayers, fmtMissing, LAYERS, observePointsOf, projectHasLayer, RESEARCH_STEPS } from './claims.mjs';
import { recipeFor } from './ops.mjs';
import { normalizePlatforms } from './platform.mjs';
import { loadQualityBaseline } from './store/db.mjs';
import { hostOfCase } from './hosts.mjs';

const NEG_PRED = new Set(['empty', 'none_eq', 'none_match']);
// 阴性 = 判「没有」：空、都不等于、都不匹配，或计数类取值等于 0。布尔状态 eq false 是在判一个状态，不算阴性
const isNegCheck = ch => {
  const [k, x] = Object.entries(ch.predicate || {})[0] || [];
  return NEG_PRED.has(k) || (k === 'eq' && String(x) === '0' && /(count|num|total|len|size|hits?|次数|条数|个数)/i.test(String(ch.pick || '')));
};
// 判「有」的谓词：只要有值 / 大于 0。开关两档下都可能成立，分不出对照（区分力）
const isPresenceCheck = ch => {
  const [k, x] = Object.entries(ch.predicate || {})[0] || [];
  return k === 'nonempty' || (['gt', 'count_gt'].includes(k) && Number(x) === 0) || (k === 'gte' && Number(x) <= 1)
    || (k === 'eq' && String(x) === '0');   // 「等于 0」不管读的叫什么，都只是在判有没有
};
// 读法里的 {param.x}：这个读数绑在哪个实体上（某个 unit、某个 trigger）
const paramsOf = pattern => new Set([...String(pattern || '').matchAll(/\{param\.(\w+)\}/g)].map(m => m[1]));
const readPattern = (recipe, pick) => (recipe?.read || []).find(r => pick === `read.${r.key}` || pick === r.key)?.pattern;
const PLACEHOLDER = /TODO|^预期[a-z]($|（)|^操作[A-Z]（/;
const VAGUE_ONLY = /^(正常|无异常|没有异常|符合预期|成功|生效|正确|可以|OK|ok|通过)[。.！!]?$/;
const SUBMIT_OK = /(提示|toast|Toast|弹出)?.{0,6}(保存|提交|发布|创建|更新)(成功|完成)|返回成功|接口成功|code\s*[=:]\s*0/;
const READBACK = /(重新打开|重开|刷新后|再次进入|回读|读回|查询|落库|生效|下发|载荷|详情页|列表里|执行记录)/;
// 通用的破坏性 / 外发动作。项目特有的（例如配置后台的「触发流程」）写在配置 quality.dangerOps（正则）里追加。
const DANGER_OP = '发布|删除|清空|卸载(?=.{0,4}(App|app|应用|包|重装))|卸载重装|下线|回滚|清除数据|重置|publish|delete|purge|uninstall';
// 只读描述（「读发布面」「核实删除结果」）不算危险动作：动作词前面出现这些词就跳过
const READ_ONLY_BEFORE = /(读|查看|查询|核实|核对|确认|回读|观察|检查|看)/;
// 对照分支：两个兄弟节点的操作文字只差一个开关词 —— 开关两档 / 有无改动
const TOGGLE = /\b(true|false|on|off|enabled|disabled|yes|no)\b|开启|关闭|打开|开|关|有|无|启用|停用/gi;
const FRESH_INSTALL = /(全新安装|全新装包|首次安装|卸载重装|fresh install)/i;
const EXEC_STATE_KEYS = ['status', 'result', 'blocked_on', 'root_cause', 'evidence'];
const EXEC_STATE_TEXT = /(待测|待真机核对|当前必红|已验证通过|本轮通过|暂时跳过)/;
const NODE_KEYS = new Set(['op', 'tags', 'expect', 'children', 'conclusion', 'given', 'op_id', 'data', 'id', 'note', 'notes', 'applies', 'danger', 'shows', 'quality_waive']);
const EXPECT_KEYS = new Set(['id', 'assert', 'machine', 'observe', 'applies', 'platform', 'platforms', 'expect_data', 'desc', 'revisions', 'revision', 'assert_orig', 'assert_changelog',
  'note', 'notes', 'scope_note', 'requires_uninstall', 'uninstall_why', 'tags', 'origin', 'source', 'judge', 'human_why', 'quality_waive', 'via', 'why_not_ui', 'why_not_ui_checked', 'seen_at', 'claims_off', 'why_presence_only']);
const clauses = s => String(s).split(/[；;]|，且|并且|同时|以及/).map(x => x.trim()).filter(x => x.length >= 4);
const norm = s => String(s).replace(/\s+/g, '').replace(/[0-9]+/g, '#');
// 行话：读的人得先弄懂一个概念才看得懂句子的词。用例正文（标题、为什么、操作、断言）是要念给人听的，
// 结论尤其如此。内核只带通用的几条；项目自己的行话写在配置 quality.jargon（[{ match: 正则, say: 改成怎么说 }]）。
// 内核自己的规则文字也过这份清单（test/case-quality-wording.test.mjs）：检查者说行话，这道闸永远不会把自己标红。
export const JARGON = [
  { match: '[两多反双单正]臂|臂\\s?[A-Za-z0-9一二]|(?<![手])臂(?=[：:，,、）)])', say: '直接写这一支的条件（例：「featureX = true 时」）；要指对照就写「对照组」「改动前 / 改动后」' },
  // 「有牙 / 没牙」：owner 多次反馈听不懂（2026-11-18 起禁用）
  { match: '[有没无长带证]牙|牙齿', say: '直接说「功能坏了这条会不会失败」：会失败就写「能抓出问题」，不会就写「功能坏了也照样通过」' },
];
/** 文本里命中的行话 → [{ term, say }] */
export function jargonHits(text, list = JARGON) {
  const out = [];
  for (const j of list) { const m = new RegExp(j.match, 'u').exec(String(text || '')); if (m) out.push({ term: m[0], say: j.say }); }
  return out;
}

/** 遍历：每个节点给出 { n, path, parent, siblings } */
function walkNodes(tree, fn, path = [], parent = null) {
  (tree || []).forEach((n, i) => {
    const p = [...path, i + 1];
    fn({ n, path: p.join('.'), parent, siblings: tree });
    walkNodes(n.children, fn, p, n);
  });
}
const subtreeExpects = n => [...(n.expect || []), ...(n.children || []).flatMap(subtreeExpects)];
const subtreeOps = n => [n.op || '', ...(n.children || []).flatMap(subtreeOps)];

const VIAS = ['ui', 'log', 'diag', 'debugger', 'cli'];
export const RULES = [
  { id: 'Q20', level: 'block', title: '不在界面上验的断言要写清为什么',
    why: '像 QA 一样，断言默认在界面上验：读到结论那一刻的 app 截图人一眼能看懂、也难伪造。日志 / 诊断命令 / 调试器只在界面上确实看不到时才用，评审时要让 owner 看到理由',
    fix: 'via 写 log / diag / debugger / cli 之一，why_not_ui 写界面上为什么看不到（先找过 app 自带的调试页）；能在界面上验的就别写 via',
    check: ({ c }) => expects(c).flatMap(({ e }) => !e.via ? []
      : !VIAS.includes(e.via) ? [{ at: e.id, msg: `via 只能是 ${VIAS.join(' / ')}` }]
      : e.via !== 'ui' && !String(e.why_not_ui || '').trim() ? [{ at: e.id, msg: `写了 via=${e.via}，没写 why_not_ui（为什么界面上看不到）` }] : []) },

  { id: 'Q21', level: 'block', since: '2026-11-06', title: '界面上验的断言要用界面通道读',
    why: '只有界面通道（exec=ui / web 的配方）会在读到值的那一刻截图；用诊断 / 日志配方读，observe 重跑多少次都补不上那张图，结论一直是「证据不全」',
    fix: 'observe.op 换成在 app 页面上读值的配方（ops set 时写清进到哪一页、读画面上哪几个字；app 自带的调试页也算界面）；界面上确实看不到，才写 via + why_not_ui',
    // 冒烟项读的多是装配结果、决策计数这类运行时值，本来就不在界面上，不套这条
    check: ({ c, ops }) => !ops || c.kind === 'probe' || c.kind === 'smoke' ? [] : expects(c).flatMap(({ e }) => normalizePlatforms(c).flatMap(p => {
      const x = nonUiRead(e, p, ops, hostOfCase(c, p));
      return x ? [{ at: e.id, msg: `${p} 上用 ${x.op} 读（exec=${x.exec}），不是界面通道，截不到读到值那一刻的图` }] : [];
    })) },

  { id: 'Q22', level: 'block', since: '2026-11-18', title: '断言里说的效果要在那一层看到',
    why: '断言写「拦截 + 弹窗」，观测只读了判定记录里的动作名，工具机判通过、盲审也放行 —— 弹窗弹没弹、请求拦没拦、上报发没发，从头到尾没人看过。判定里有这个动作名 ≠ 执行了 ≠ 用户看到了 ≠ 上报发出去了',
    fix: '三选一：收窄说法，只说观测真正读到的那一层（例：「判定产出 fuse、alert 两个动作」）；或者补一条读那一层的观测（弹窗读被测 app 的画面、拦截读网络出口、上报读发出的载荷）；'
      + '或者这个词在这条断言里本来就不是效果（讲的是某个部件里的记录），在断言上写 claims_off: [{ word, why }] 说清楚。观测用的操作要登记它读的是哪一层：acceptkit ops set <op> --observes <层>。'
      + '项目里还没有这一层的观测口时，用例自己补：' + RESEARCH_STEPS.map((x, i) => `${'①②③④'[i]} ${x}`).join(' '),
    check: ({ c, ops, cfg = {} }) => {
      if (!ops) return [];
      const words = claimWordsOf({ quality: cfg }), points = observePointsOf({ quality: cfg }), out = [];
      for (const { e } of expects(c)) {
        // claims_off 要说清为什么、要点得出是哪个词：不然它就成了一句「别查我」
        for (const x of [].concat(e.claims_off || [])) {
          const w = typeof x === 'string' ? x : x?.word;
          if (!w || typeof x === 'string' || !String(x.why || '').trim()) out.push({ at: e.id, msg: `claims_off 的「${w || '?'}」没写 why（这个词在这条断言里为什么不是效果）` });
          else if (!effectClaims(e.assert, words.filter(x2 => x2.word === w)).length) out.push({ at: e.id, msg: `claims_off 的「${w}」在断言原文里没被认成效果，这一项多余，删掉` });
        }
        if (e.judge === 'human' || !e.observe) continue;
        const msgs = new Set();
        for (const p of normalizePlatforms(c)) {
          const host = hostOfCase(c, p);
          const u = uncoveredClaims(e, { ops, platform: p, host, words });
          if (!u.op || !u.missing.length) continue;   // 这一端没写读法（双端用例只译了一端）：交给别的检查
          // 项目在这一端根本没有读这一层的操作：不是这条用例写错了，是项目还不知道这个效果该去哪看 —— 先补观测口
          // 观测用的操作自己没登记层时先报它：登了也许就盖住了
          const none = !u.layers ? [] : u.missing.flatMap(m => m.covers.some(l => projectHasLayer(ops, l, p, host)) ? [] : [m]);
          if (none.length) msgs.add(`${p} 上项目里还没有任何操作读${none.map(m => `「${m.word}」`).join('')}那一层（${none.map(m => fmtMissing(m, points)).join('；')}）—— 先回被测系统里查清楚它的出口，沉淀成操作（见 fix 的 ①–④）`);
          const rest = u.missing.filter(m => !none.includes(m));
          if (rest.length) msgs.add(!u.layers ? `说了${rest.map(m => `「${m.word}」`).join('')}，观测用的 ${u.op} 没登记读的是哪一层（ops set ${u.op} --observes …）`
            : `${p} 上用 ${u.op} 读的是${u.layers.map(l => LAYERS[l] || l).join('、')}；${rest.map(m => fmtMissing(m, points)).join('；')}`);
        }
        for (const msg of msgs) out.push({ at: e.id, msg });
      }
      // 用例级主张：证明它的那几条断言读到的层，要盖得住主张里说的效果
      const byId = new Map(expects(c).map(({ e }) => [e.id, e]));
      (c.claims || []).forEach((cl, i) => {
        const fx = effectClaims(cl.text, words); if (!fx.length) return;
        const seen = new Set();
        for (const id of cl.proved_by || []) { const e = byId.get(id); if (!e?.observe) continue;
          for (const p of normalizePlatforms(c)) { const b = bindingOf(e.observe, p); (b?.op ? opLayers(ops, b.op, p, hostOfCase(c, p)) || [] : []).forEach(l => seen.add(l)); } }
        const miss = fx.filter(f => !f.covers.some(l => seen.has(l)));
        if (miss.length) out.push({ at: `主张 ${i + 1}`, msg: `「${String(cl.text).slice(0, 30)}」：${miss.map(m => fmtMissing(m, points)).join('；')}，proved_by 里没有读这一层的断言` });
      });
      return out;
    } },

  { id: 'Q23', level: 'block', since: '2026-11-18', title: '判「没有」要先证明被判的那个对象在',
    why: '读某个 unit 的动作、判「没有动作」：这个 unit 根本没执行时，读数同样是空，判定照样通过。整页非空（「这次决策评估了 10 项」）证明不了被判的那一项在里面',
    fix: '加一条前提（guard），读同一个对象、判它在（例：评估清单里有这个 unit），再判它「没有」',
    check: ({ c, ops }) => {
      if (!ops) return [];
      const out = [];
      for (const { e } of expects(c)) {
        if (!e.observe) continue;
        const msgs = new Set();
        for (const p of normalizePlatforms(c)) {
          const b = bindingOf(e.observe, p); if (!b?.op) continue;
          const recipe = recipeFor(ops[b.op], p, hostOfCase(c, p))?.recipe; if (!recipe?.read) continue;
          const anchors = [...guardsOf(b), ...(b.checks || []).filter(ch => !isNegCheck(ch))].filter(x => !isNegCheck(x));
          for (const ch of (b.checks || []).filter(isNegCheck)) {
            const need = paramsOf(readPattern(recipe, ch.pick)); if (!need.size) continue;
            const bound = anchors.some(a => { const have = paramsOf(readPattern(recipe, a.pick)); return [...need].every(x => have.has(x)); });
            if (!bound) msgs.add(`${ch.pick} 判「没有」，读的是 ${[...need].map(x => `{param.${x}}`).join(' ')} 那一个对象；没有一条前提或判据先证明这个对象在`);
          }
        }
        for (const msg of msgs) out.push({ at: e.id, msg });
      }
      return out;
    } },

  { id: 'Q24', level: 'warn', since: '2026-11-18', title: '开关类用例的判据要分得出对照',
    why: '判据只是「有值 / 大于 0 / 等于 0」时，开关开和关两种情况下可能都成立：开关关了这条也照样通过，测不出开关',
    fix: 'observe 写 flips_in：在哪个对照节点下这条判据会不成立（再在那个节点上放一条反向断言，或附一次反向运行）；或者换成只在这一档才有的读数',
    check: ({ c }) => {
      let lever = false; walkNodes(c.tree, ({ n }) => { if (n.tags?.lever) lever = true; });
      if (!lever || c.kind === 'probe') return [];
      // 各端一份读法（observe.by）的逐端看；flips_in 写在 observe 上或那一端的读法上都算
      const presenceOnly = o => { const cs = o?.checks || []; return cs.length && !o.flips_in && cs.every(ch => isPresenceCheck(ch) || isNegCheck(ch)); };
      return expects(c).filter(({ e }) => e.observe && !e.observe.flips_in && (e.observe.by ? Object.values(e.observe.by).some(presenceOnly) : presenceOnly(e.observe)))
        .map(({ e }) => ({ at: e.id, msg: '判据只看「有没有 / 是不是 0」，没写 flips_in（在哪个对照节点下它会不成立）' }));
    } },

  { id: 'Q26', level: 'block', since: '2026-11-19', title: '说了上报 / 拦截 / 生效的用例，至少要有一条判内容',
    why: '同样的输入就该得到同样的输出：只判「有上报」，上报里三个字段全是空值也照样通过（实测：一条统计上报的三个版本字段全是占位值，判据只看了有没有，靠盲审碰巧才发现）',
    fix: '挑一条最关键的，判据写到字段和取值（例：read.payload.store_region 匹配 ^[A-Z]{2}$）；不知道该带哪些字段，用例自己补：' + RESEARCH_STEPS.slice(0, 3).map((x, i) => `${'①②③'[i]} ${x}`).join(' ')
      + '。业务上确实只测有没有的，在断言上写 why_presence_only 说明',
    check: ({ c, ops, cfg = {} }) => {
      if (c.kind === 'probe' || c.kind === 'smoke') return [];
      const words = claimWordsOf({ quality: cfg }), content = ['report', 'network', 'state'];
      const hit = expects(c).filter(({ e }) => e.observe && e.judge !== 'human'
        && effectClaims(e.assert, words, e.claims_off).some(m => m.covers.some(l => content.includes(l))));
      if (!hit.length || hit.some(({ e }) => e.why_presence_only)) return [];
      const presenceOnly = o => (o?.checks || []).every(ch => isPresenceCheck(ch) || isNegCheck(ch));
      const all = hit.every(({ e }) => e.observe.by ? Object.values(e.observe.by).every(presenceOnly) : presenceOnly(e.observe));
      return all ? [{ at: hit.map(({ e }) => e.id).join('、'), msg: '这几条说了上报 / 拦截 / 生效，判据全都只看「有没有」，一条判内容（字段、取值）的都没有' }] : [];
    } },

  { id: 'Q27', level: 'warn', since: '2026-11-19', title: '说了上报 / 拦截 / 生效，最好判到内容',
    why: '「有上报」通过了，上报里带的是不是对的值还不知道；用例里别的断言判了内容，这一条只判有没有，就在这一条上漏',
    fix: '判据加到字段和取值；确实只测有没有的写 why_presence_only',
    check: ({ c, cfg = {} }) => {
      if (c.kind === 'probe' || c.kind === 'smoke') return [];
      const words = claimWordsOf({ quality: cfg }), content = ['report', 'network', 'state'];
      const presenceOnly = o => (o?.checks || []).every(ch => isPresenceCheck(ch) || isNegCheck(ch));
      return expects(c).filter(({ e }) => e.observe && e.judge !== 'human' && !e.why_presence_only
        && effectClaims(e.assert, words, e.claims_off).some(m => m.covers.some(l => content.includes(l)))
        && (e.observe.by ? Object.values(e.observe.by).some(presenceOnly) : presenceOnly(e.observe)))
        .map(({ e }) => ({ at: e.id, msg: '只判了有没有，没判带的内容' }));
    } },

  { id: 'Q01', level: 'block', title: '断言要有判定方式',
    why: '没有机器判据的断言大多落成「待测」或「阻塞」，跑不出结论；判据只在执行时临场想，同一条断言两次执行判法不同',
    fix: '写 observe（op + checks）；确实只能人判的，写 judge: "human" 并在 human_why 里说明为什么机器判不了',
    check: ({ c }) => c.kind === 'probe' ? [] : expects(c).filter(({ e }) => !e.observe && !(e.judge === 'human' && e.human_why))
      .map(({ e }) => ({ at: e.id, msg: e.machine ? `只有文字判据「${String(e.machine).slice(0, 40)}」，没有 observe` : '没有 observe，也没声明人工判定' })) },

  { id: 'Q02', level: 'block', title: '断言必须可判定',
    why: '「启动正常」「有相关输出」这类断言，执行人按自己的理解判，通过了也说明不了什么',
    fix: '写成「看到什么值 / 什么现象算对」，把对象、取值、范围写出来',
    check: ({ c }) => c.kind === 'probe' ? [] : expects(c).flatMap(({ e }) => {
      const a = String(e.assert || '').trim();
      if (PLACEHOLDER.test(a)) return [{ at: e.id, msg: `还是模板占位「${a.slice(0, 30)}」` }];
      if (VAGUE_ONLY.test(a)) return [{ at: e.id, msg: `只有「${a}」，没有判据` }];
      return [];
    }) },

  { id: 'Q03', level: 'warn', title: '一条断言只判一件事',
    why: '一条断言里塞三件事，证据往往只证明了其中一件，复核按「证据不足 / 夸大」驳回',
    fix: '拆成多条断言，每条一个判据；或者让 observe.checks 的条数与子句一一对应',
    check: ({ c }) => expects(c).flatMap(({ e }) => {
      const k = clauses(e.assert).length, n = (e.observe?.checks || []).length;
      return k >= 3 && n < k ? [{ at: e.id, msg: `断言有 ${k} 个子句，判据只有 ${n} 条` }] : [];
    }) },

  { id: 'Q04', level: 'block', title: '阴性判定要有前提',
    why: '「没出现 / 数量为 0」在功能根本没跑、开关没生效、数据被淘汰时同样成立 —— 不带前提的阴性判定会平凡通过',
    fix: '加 guard：先证明输入真的到达、观测通道真的在采（阳性对照），再判「没有」',
    check: ({ c }) => expects(c).filter(({ e }) => e.observe?.checks?.length && e.observe.checks.every(isNegCheck) && !guardsOf(e.observe).length)
      .map(({ e }) => ({ at: e.id, msg: '判据全是阴性（empty / none_* / 计数为 0），没有 guard' })) },

  { id: 'Q05', level: 'block', title: '提交成功不等于生效，要回读',
    why: '页面提示「已保存」、接口返回成功，重新打开后值没变 —— 只看提交结果的断言出过假通过',
    fix: '在同一节点或后续节点加回读断言：重新打开、查详情、读下游真正消费的产物',
    check: ({ c }) => {
      // 回读可以写在同一节点、子节点或后续节点里：按文档顺序找这条断言之后有没有回读
      const all = expects(c).map(x => x.e);
      return all.flatMap((e, i) => {
        if (!SUBMIT_OK.test(e.assert || '') || READBACK.test(String(e.assert).replace(SUBMIT_OK, ''))) return [];
        return all.slice(i + 1).some(x => READBACK.test(x.assert || '')) ? [] : [{ at: e.id, msg: `只断言了「${String(e.assert).match(SUBMIT_OK)[0]}」，之后没有回读` }];
      }); } },

  { id: 'Q06', level: 'block', title: '危险写操作要结构化标记',
    why: '发布、删除、清空、触发这类外发或破坏性动作，只写在操作文字里时，执行到一半才发现要人确认，整段记阻塞',
    fix: '节点上写 danger: { kind: "publish|delete|…", confirm: "执行前要谁点头" }；卸载类在断言上写 requires_uninstall + uninstall_why',
    check: ({ c, cfg }) => { const out = [];
      // 英文词按整词匹配（is_delete 这类字段名不算）；动作词后面是名词（删除动作、发布记录）不算
      const words = `${DANGER_OP}${cfg.dangerOps ? `|${cfg.dangerOps}` : ''}`.split('|').map(w => /^[a-z]+$/i.test(w) ? `(?<![\\w])${w}(?![\\w])` : w).join('|');
      const re = new RegExp(`(${words})(?!动作|记录|状态|结果|链路|逻辑|面|腿|单号)`, 'i');
      walkNodes(c.tree, ({ n, path }) => {
        let op = String(n.op || ''); for (let k = 0; k < 5 && /\{[^{}]*\}/.test(op); k++) op = op.replace(/\{[^{}]*\}/g, '…');
        const m = re.exec(op);
        if (!m || READ_ONLY_BEFORE.test(op.slice(0, m.index)) || n.danger || (n.expect || []).some(e => e.requires_uninstall)) return;
        out.push({ at: `节点 ${path}`, msg: `「${op.slice(0, 30)}」含危险动作「${m[0]}」，没有 danger 标记` });
      });
      return out; } },

  { id: 'Q07', level: 'warn', title: '全新安装类断言要标卸载',
    why: '卸载会清掉登录态和人工准备的状态，必须单独审批；没标的用例执行时会被临场卸载',
    fix: '真需要全新安装：断言上写 requires_uninstall: true 与 uninstall_why；只是「首启 / 未同意」：改状态后冷启动，不卸载',
    check: ({ c }) => { const out = [];
      walkNodes(c.tree, ({ n }) => (n.expect || []).forEach(e => { if (FRESH_INSTALL.test(`${n.op} ${e.assert}`) && !e.requires_uninstall) out.push({ at: e.id, msg: '提到全新安装，没标 requires_uninstall' }); }));
      return out; } },

  { id: 'Q08', level: 'warn', title: '依赖的前置状态要写明',
    why: '断言要求「默认关闭 / 从未设置」，上一轮执行改过状态又没复位，下一轮直接阻塞或误判',
    fix: '把前置写进 preconditions 或 guard（执行时读回确认）；改了共享状态的用例加复位节点',
    check: ({ c }) => expects(c).filter(({ e }) => /(默认|初始|从未|未设置|未设过|仍为)/.test(e.assert || '') && !(e.observe && guardsOf(e.observe).length) && !c.preconditions)
      .map(({ e }) => ({ at: e.id, msg: '断言依赖前置状态，用例没写 preconditions，断言也没有 guard' })) },

  { id: 'Q09', level: 'block', title: '用例里不写执行状态',
    why: '用例是资产，执行状态属于某一次运行；写进用例的「待测 / 当前必红」会被下一轮当成规格',
    fix: '执行状态记在运行里（record --status / blockers）；用例只写操作、断言、判定方式',
    check: ({ c }) => { const out = [];
      for (const k of EXEC_STATE_KEYS) if (c[k] !== undefined) out.push({ at: '用例', msg: `有执行状态字段 ${k}` });
      expects(c).forEach(({ e }) => {
        for (const k of EXEC_STATE_KEYS) if (e[k] !== undefined) out.push({ at: e.id, msg: `有执行状态字段 ${k}` });
        if (EXEC_STATE_TEXT.test(`${e.assert} ${e.note || ''}`)) out.push({ at: e.id, msg: `文字里写了执行状态「${`${e.assert} ${e.note || ''}`.match(EXEC_STATE_TEXT)[0]}」` });
      });
      return c.kind === 'probe' ? [] : out; } },

  { id: 'Q10', level: 'warn', title: '不用自造字段',
    why: '自造的字段工具不认：切面写成 classify / classification 时覆盖统计看不见，写错的字段静默失效',
    fix: '切面写 tags；说明写 note；需要新字段先在内核登记',
    check: ({ c, extraKeys }) => { const out = [];
      walkNodes(c.tree, ({ n, path }) => {
        for (const k of Object.keys(n)) if (!NODE_KEYS.has(k) && !extraKeys.node.has(k)) out.push({ at: `节点 ${path}`, msg: `字段 ${k} 不认识` });
        for (const e of n.expect || []) for (const k of Object.keys(e)) if (!EXPECT_KEYS.has(k) && !extraKeys.expect.has(k) && !EXEC_STATE_KEYS.includes(k)) out.push({ at: e.id, msg: `字段 ${k} 不认识` });
      });
      return out; } },

  { id: 'Q11', level: 'block', title: '对照分支的预期不能一样',
    why: '开关开和关、改动前和改动后两个分支写着同样的断言，测不出开关有没有起作用 —— 两个分支都通过说明不了任何事',
    fix: '对照的那个分支写出不同的预期；两个分支的预期确实一样，说明不需要分成两支',
    check: ({ c }) => { const out = [];
      const lists = [c.tree || []]; walkNodes(c.tree, ({ n }) => lists.push(n.children || []));
      lists.forEach(kids => {
        if (kids.length < 2) return;
        const sig = k => subtreeExpects(k).map(e => norm(e.assert)).sort().join('|');
        const arm = k => String(k.op || '').replace(TOGGLE, '◇');
        for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) {
          const a = kids[i], b = kids[j];
          if (a.op === b.op || arm(a) !== arm(b) || !sig(a) || sig(a) !== sig(b)) continue;
          out.push({ at: `节点「${String(a.op).slice(0, 24)}」/「${String(b.op).slice(0, 24)}」`, msg: '开关两档的分支，断言完全一样' });
        }
      });
      return out; } },

  { id: 'Q12', level: 'warn', title: '主张要逐条有断言支撑',
    why: '一条主张的 proved_by 列了全部断言，等于没说哪条断言证明了它，复核无从下手',
    fix: 'proved_by 只列真正证明它的那几条',
    check: ({ c }) => { const n = expects(c).length;
      return n > 3 ? (c.claims || []).filter(cl => (cl.proved_by || []).length === n).map(cl => ({ at: '主张', msg: `「${String(cl.text).slice(0, 30)}」的 proved_by 是全部 ${n} 条断言` })) : []; } },

  { id: 'Q13', level: 'warn', title: '页面判定不读整页文本',
    why: '整页文本里同时有背景页、隐藏层的旧内容，读到了不代表当前可见的那一层是这个值',
    fix: '按选择器读当前可见元素，或者读接口回读的结构化数据',
    check: ({ c }) => expects(c).filter(({ e }) => /document\.body\.innerText|body\.textContent/.test(JSON.stringify(e.observe?.params || {})))
      .map(({ e }) => ({ at: e.id, msg: 'observe 读的是整页文本' })) },

  { id: 'Q14', level: 'warn', title: '硬预期值要有出处',
    why: '设计期写下的数，执行时实际是另一个数；没有出处就分不清是被测错了还是预期写错了',
    fix: '在断言上写 source：契约、基线读回、还是谁拍板的',
    check: ({ c }) => expects(c).filter(({ e }) => /(=|为|是|共|有)\s*\d{2,}/.test(e.assert || '') && !e.source && !e.observe?.why)
      .map(({ e }) => ({ at: e.id, msg: `断言里有硬数值「${String(e.assert).match(/(=|为|是|共|有)\s*\d{2,}/)[0]}」，没有出处` })) },
  { id: 'Q15', level: 'block', since: '2026-10-29', title: '同平台有多个被测 App 时要写在哪个 App 上跑',
    why: '不写 host，只在某个 App 上成立的做法、它的包名和构建都取不到，只能用与 App 无关的通用做法；「这个 App 上没有」的结论也分不清是被测物的行为还是这个 App 的特性',
    fix: '用例写 host（登记过的被测 App）；两端不是同一个 App 时写成 {"ios":"…","android":"…"}',
    check: ({ c, hosts = {} }) => [].concat(c.platform || []).flatMap(p => (p === 'both' ? ['ios', 'android'] : [p])).filter(p => !hostOfCase(c, p) && Object.values(hosts).filter(h => h[p]).length > 1)
      .map(p => ({ at: '用例', msg: `${p} 上登记了 ${Object.entries(hosts).filter(([, h]) => h[p]).map(([k]) => k).join(' / ')}，用例没写 host` })) },
  { id: 'Q16', level: 'block', since: '2026-10-29', title: '用例正文说人话，不用行话',
    why: '用例正文是要念给人听的，验收结论尤其如此；条件本身（「featureX = true 时」）已经是人话，前面再加一个内部代号，只会让读的人以为有个概念要先弄懂',
    fix: '删掉行话，直接写它指的东西（条件、取值、对照组）；项目自己的行话登记在配置 quality.jargon',
    check: ({ c, cfg = {} }) => {
      const list = [...JARGON, ...(cfg.jargon || [])], out = [];
      const scan = (at, field, text) => { const h = jargonHits(text, list); if (h.length) out.push({ at, msg: `${field}里有「${h.map(x => x.term).join('」「')}」—— ${h[0].say}` }); };
      scan('用例', '标题', c.title); scan('用例', '为什么', c.why);
      walkNodes(c.tree, ({ n, path }) => {
        scan(`节点 ${path}`, '操作', n.op);
        for (const e of n.expect || []) scan(e.id, '断言', e.assert);
      });
      return out;
    } },
];

/** 机器判断不了、要作者 / 评审人回答的问题。 */
export const QUESTIONS = [
  '被测改动不存在时，这条断言还会成立吗？成立就是平凡断言，测不出改动',
  '前提（guard）证明的是「输入真的生效了」，还是只证明了「页面开着 / 环境就绪」？',
  '断言读的是下游真正消费的产物，还是记录面、页面回显？',
  '开关、配置的取值是运行时读回的真值，还是代码里的默认值？',
  '预期出自契约、基线读回，还是谁的裁定？基线版本上同样读回是多少？',
  '这一步在产品里有页面 / App 入口吗？有就要走入口，不能用接口代测',
  '判据面在这个环境里观测得到吗？操作库里有对应的观测操作吗？没有就在评审时提出，不要执行时拿别的面顶替',
];

const expects = c => { const out = []; walkNodes(c.tree, ({ n }) => (n.expect || []).forEach(e => out.push({ e, n }))); return out; };

function waivedBy(c, f) {
  const lists = [];
  walkNodes(c.tree, ({ n }) => { if (n.quality_waive) lists.push(n.quality_waive); (n.expect || []).forEach(e => { if (e.id === f.at && e.quality_waive) lists.push(e.quality_waive); }); });
  if (c.quality_waive) lists.push(c.quality_waive);
  return lists.flat().find(w => w.rule === f.rule && w.why);
}

/** 检查一条用例 → [{ rule, level, title, at, msg, why, fix, waived? }] */
export function checkCase(c, { packRules = [], extraKeys = {}, cfg = {}, hosts = {}, ops = null } = {}) {
  const ek = { node: new Set(extraKeys.node || []), expect: new Set(extraKeys.expect || []) };
  const out = [];
  for (const r of [...RULES, ...packRules]) {
    let fs = [];
    try { fs = r.check({ c, extraKeys: ek, cfg, hosts, ops }) || []; } catch (e) { fs = [{ at: '用例', msg: `规则执行出错：${e.message}` }]; }
    for (const f of fs) {
      const x = { rule: r.id, level: r.level, since: r.since, title: r.title, why: r.why, fix: r.fix, ...f };
      const w = waivedBy(c, x);
      out.push(w ? { ...x, waived: w.why } : x);
    }
  }
  return out;
}

export const findingKey = f => `${f.rule}@${f.at}`;

/** 结合基线分出：拦截（新问题）/ 提示 / 质量债（基线里已有）/ 豁免 */
export function classify(findings, baseline, baselineAt = null) {
  const old = new Set(baseline?.keys || []);
  const r = { block: [], warn: [], debt: [], waived: [] };
  // 存量用例（基线里有它）遇到晚于基线的规则：只提示
  const lateRule = f => baseline && baselineAt && f.since && f.since > baselineAt.slice(0, 10);
  for (const f of findings) {
    if (f.waived) r.waived.push(f);
    else if (old.has(findingKey(f))) r.debt.push(f);
    else (f.level === 'block' && !lateRule(f) ? r.block : r.warn).push(f);
  }
  return r;
}

export function formatFindings(name, cls, { verbose = false } = {}) {
  const lines = [];
  const show = (f, mark) => {
    lines.push(`   ${mark} ${f.rule} ${f.title} · ${f.at}：${f.msg}`);
    if (verbose || mark === '✗') lines.push(`        教训：${f.why}\n        修法：${f.fix}`);
  };
  cls.block.forEach(f => show(f, '✗'));
  cls.warn.forEach(f => show(f, '⚠'));
  if (cls.debt.length) lines.push(`   · 存量质量债 ${cls.debt.length} 处（基线里已有，不拦）：${[...new Set(cls.debt.map(f => f.rule))].join(' ')}`);
  cls.waived.forEach(f => lines.push(`   ⊘ ${f.rule} · ${f.at} 已豁免：${f.waived}`));
  return lines.length ? [`用例质量 · ${name}`, ...lines].join('\n') : `用例质量 · ${name}：达标`;
}

/** 按项目基线评估一条用例（validate / 评审单 / run 共用）。 */
export function evaluate(root, c, opts) {
  const base = loadQualityBaseline(root);
  const cls = classify(checkCase(c, opts), base.map[c.case], base.at);
  if (!base.initialized) { cls.warn.unshift(...cls.block); cls.block = []; cls.uninitialized = true; }
  return cls;
}

/** 新建用例时给作者看的标准摘要。 */
export function standardSummary(packRules = []) {
  const rs = [...RULES, ...packRules];
  return ['用例质量标准（validate / 评审单 / 开跑时检查；✗ 不达标不能批准、不能开跑）',
    ...rs.map(r => `   ${r.level === 'block' ? '✗' : '⚠'} ${r.id} ${r.title} —— ${r.fix}`),
    '   写完后自问（机器判断不了，评审时也会问）：', ...QUESTIONS.map(q => `     · ${q}`)].join('\n');
}
