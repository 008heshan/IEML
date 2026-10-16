/**
 * 阴影 / 发光的颜色**不许是写死的有彩色** —— 必须走 `var(--…)` 令牌。
 * ----------------------------------------------------------------------------
 * ## 由来（2026-10-17，用户截图 +「**这个辉光并不是跟随按钮颜色**」）
 *
 * 启动按钮外面那圈辉光是 `app.css` 的 `@keyframes ieml-breathe` 画的，而它的两帧里
 * 写着 `rgba(74, 123, 224, 0.32 / 0.46)` —— **深色主题的强调色** `#4a7be0`。
 * `pages.css` 里早就记着一段「这一段原来写死了蓝色…用户报的『启动按钮也要随着主题
 * 颜色变』就是这个原因」，颜色都搬去走 `--accent*` 令牌了，**唯独漏下这两帧**。
 *
 * 它活了很久、没有任何判据能发现，原因有三条，正是这条门禁要补的洞：
 *   ① **没有任何东西会红** —— 硬编码颜色的表现只是"在别的主题上看着不对"；
 *   ② 默认那套主题的强调色**本来就是蓝的**（Δhue 0.7°），开发机上永远看不出问题；
 *   ③ 换主题是**低频操作**，人眼 review 抓不到"某个 keyframe 里有个旧的蓝"。
 *
 * ## 判据（只查"颜色来源"，不查审美）
 *
 * `box-shadow` / `text-shadow` / `filter`（含 `drop-shadow()`）的**颜色**里
 * 不许出现**有彩色**的字面量：
 *   · **中性色一律放行** —— 黑/白/灰（r≈g≈b）、`transparent`、`currentColor`。
 *     中性阴影是正当设计（纵深、内边、1px 顶光），我们不查它。
 *   · **有彩色**（色相可辨，例如 `rgba(74,123,224,…)` / `#4a7be0`）⇒ **必须**
 *     来自 `var(--…)`。九个主题各自声明自己的令牌，颜色才跟着主题走。
 *
 * ★ 这就是那次缺陷的形状；也正是它能把回归拦住的地方。
 *
 * ## 两条边界（写清楚，免得下一个人误以为它管得更宽）
 *
 * 1. **只查消费者样式表（`app.css` / `pages.css`）里"声明式"的阴影。**
 *    `tokens.css` **不在扫描范围内**：那里正是"九套主题各自写死颜色"的地方，
 *    `--accent-glow: rgba(91,141,239,.42)` 这类**有彩色字面量在那里是正当的**
 *    （而且必须与同主题的 `--accent` 同色相，那一条由 `tests/theme-tokens.test.mjs`
 *    的对比度/完整性判据守着）。所以本门禁按**属性名**找声明 ——
 *    `--shadow-card: …` 这种"令牌定义"不是 `box-shadow:` 声明，天然不进范围。
 * 2. **只查颜色，不查布局/数值**（模糊半径、偏移、inset 与否一概不管）。
 *    像 `max-width: 700px` 那种"定宽"缺陷是另一条门禁的事（不走"颜色"这条路）。
 *
 * ## 豁免
 *
 * 如果仓库里**真的**出现正当的有色阴影字面量（例如某个第三方风格必须写死的描边光），
 * 就在下面的 `EXEMPT` 里加一条 **带理由** 的豁免 —— **不要**放宽上面的判据、
 * 也不要写宽泛正则放过一片。豁免按"文件 + 该声明里的一段唯一子串"定位，
 * 所以它只会放过你点名的那一处。
 *
 * ## 自检
 *
 * 这个脚本**自带自检**（`selfTest()`）：量法坏了先红。
 * 仓库里那几条"量法坏掉"的教训（`check-tooltips.mjs` / `check-mojibake.mjs`）
 * 都是同一个形状 —— 检查器自己错了却报绿，比没有检查器更坏。
 *
 * 用法: node tools/gates/check-shadow-colors.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const STYLES = 'src/styles';
/**
 * ★ 只查消费者样式表；`tokens.css` 是主题色源，见头部"边界 1"。
 * ★ 这里**不写死文件名**：`src/styles` 里除 `tokens.css` 之外的**每一份** CSS
 *   都进扫描。将来新增 `components.css` 之类会自动被覆盖 ——
 *   写死一份清单的话，新文件会**静默**漏掉，正是这条门禁要防的那种"不报错的坏"。
 */
const THEME_SOURCE = 'tokens.css';

/** 有色字面量的**显式豁免**（每条都要写清理由；按 文件 + 唯一子串 定位） */
const EXEMPT = [
  // { file: 'app.css', needle: '0 0 8px #ff00ff', why: '…为什么这一处必须有彩色字面量…' },
];

/* ============================ 颜色判定 ============================ */
/** 色相不可辨的阈值：max-min ≤ 它就算灰（黑/白/灰一律放行） */
const GRAY_SPREAD = 14;
/** 近白豁免：最暗通道 ≥ 它 ⇒ 当白看（aliceblue 这类近白也是"白"） */
const NEAR_WHITE = 238;

const NEUTRAL_NAMES = new Set([
  'transparent', 'currentcolor', 'inherit', 'initial', 'unset', 'revert', 'none', 'auto',
  'black', 'white', 'gray', 'grey', 'silver', 'dimgray', 'dimgrey', 'darkgray', 'darkgrey',
  'lightgray', 'lightgrey', 'gainsboro', 'whitesmoke', 'snow', 'ivory', 'floralwhite',
  'ghostwhite', 'aliceblue', 'honeydew', 'azure', 'linen', 'seashell',
]);
/** 常见"有彩色"关键字名字（见头部：有色 ⇒ 必须走令牌） */
const CHROMATIC_NAMES = new Set([
  'red', 'green', 'blue', 'yellow', 'orange', 'purple', 'violet', 'indigo', 'pink', 'brown',
  'cyan', 'aqua', 'magenta', 'fuchsia', 'lime', 'olive', 'navy', 'teal', 'maroon', 'crimson',
  'salmon', 'tomato', 'gold', 'khaki', 'plum', 'orchid', 'coral', 'turquoise', 'skyblue',
  'steelblue', 'royalblue', 'hotpink', 'darkred', 'darkgreen', 'darkblue', 'lightblue',
  'lightgreen', 'lightpink', 'lightyellow', 'beige', 'tan', 'peru', 'chocolate', 'sienna',
]);

const isGray = (rgb) => {
  const [r, g, b] = rgb;
  return Math.max(r, g, b) - Math.min(r, g, b) <= GRAY_SPREAD || Math.min(r, g, b) >= NEAR_WHITE;
};
const isNeutralColor = (rgb) => isGray(rgb);

function parseHex(h) {
  const s = h.slice(1);
  const n = s.length === 3 || s.length === 4 ? s.split('').map((c) => c + c).join('') : s;
  if (n.length !== 6 && n.length !== 8) return null;
  return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)];
}
function parseRgbFn(v) {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(v);
  return m ? [+m[1], +m[2], +m[3]] : null;
}
/**
 * `hsl()`：饱和度为 0 才是灰。
 * ★ 这里只判"有没有色相"，不做色域换算 —— 判据要的是"是不是有彩色"，不是"多亮"。
 */
function hslIsChromatic(v) {
  const m = /hsla?\(\s*([\d.]+)(?:deg)?[,\s]+([\d.]+)%[,\s]+([\d.]+)%/.exec(v);
  if (!m) return true; // 解析不出来又明明是 hsl ⇒ 宁可报
  return +m[2] > 0;
}

/**
 * 从一条阴影值里找出**有彩色**的字面量。
 * 返回 [{ color, why }]，空数组 = 这一条干净。
 */
export function chromaticLiterals(value) {
  const bad = [];
  const seen = new Set();
  const push = (color, why) => {
    if (seen.has(color)) return;
    seen.add(color);
    bad.push({ color, why });
  };

  // ① 色函数（先扫，免得 hex/名字的规则重复报同一个东西）
  for (const m of value.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
    const rgb = parseHex(m[0]);
    if (rgb && !isNeutralColor(rgb)) push(m[0], 'hex 有彩色');
  }
  for (const m of value.matchAll(/rgba?\([^)]*\)/g)) {
    const rgb = parseRgbFn(m[0]);
    if (rgb && !isNeutralColor(rgb)) push(m[0], 'rgb/rgba 有彩色');
  }
  for (const m of value.matchAll(/hsla?\([^)]*\)/g)) {
    if (hslIsChromatic(m[0])) push(m[0], 'hsl 有彩色');
  }
  /*
   * ② 其它颜色函数（`oklch()` / `lab()` / `color()` …）
   *   这里**没法判中性**（要色域换算），一律报 —— 想让中性阴影走这些函数，
   *   就按头部写一条**带理由**的豁免，别把这条判据放宽。
   *   ★ `color-mix(` 不会命中：正则要求 `color(` 紧跟左括号。
   */
  for (const m of value.matchAll(/\b(?:oklch|oklab|lch|lab|color|device-cmyk)\(/g)) {
    push(m[0], '未识别的颜色函数（无法判定中性）');
  }
  // ③ 关键字颜色名
  for (const m of value.matchAll(/(?:^|[\s,(])([a-zA-Z]+)(?=[\s,)]|$)/g)) {
    const name = m[1].toLowerCase();
    if (NEUTRAL_NAMES.has(name)) continue;
    if (CHROMATIC_NAMES.has(name)) push(m[1], '关键字有彩色名');
  }
  return bad;
}

/* ============================ 解析 CSS ============================ */
/** 去掉注释但**保留行号**（把注释字符换成空格、换行原样留着） */
export function stripComments(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      for (const ch of text.slice(i, stop)) out += ch === '\n' ? '\n' : ' ';
      i = stop;
      continue;
    }
    out += text[i];
    i++;
  }
  return out;
}

/**
 * 极小的 CSS 声明解析器：走出 `选择器 { 声明; … }`，遇到 `@media` 这类
 * 块就进下一层（`currentSelector()` 取**最内层不是 @ 规则**的那个 prelude）。
 */
export function parseDeclarations(text) {
  const src = stripComments(text);
  const out = [];
  const stack = [];
  let buf = '';
  let line = 1;
  let bufLine = 1;
  const currentSelector = () => {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (!stack[i].startsWith('@')) return stack[i];
    }
    return '(顶层)';
  };
  const flush = () => {
    const s = buf.trim();
    buf = '';
    if (!s) return;
    const c = s.indexOf(':');
    if (c === -1) return;
    out.push({
      selector: currentSelector(),
      prop: s.slice(0, c).trim().toLowerCase(),
      value: s.slice(c + 1).trim(),
      line: bufLine,
    });
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\n') line++;
    if (ch === '{') {
      stack.push(buf.trim().replace(/\s+/g, ' '));
      buf = '';
      continue;
    }
    if (ch === '}') {
      flush();
      stack.pop();
      continue;
    }
    if (ch === ';') {
      flush();
      continue;
    }
    if (!buf.trim()) bufLine = line;
    buf += ch;
  }
  flush();
  return out;
}

/** 这条声明是不是"阴影/发光"，且颜色该不该走令牌 */
function shadowValue(prop, value) {
  if (prop === 'box-shadow' || prop === 'text-shadow') return value;
  if (prop === 'filter' && /drop-shadow\(/.test(value)) return value;
  return null;
}

/* ============================ 自检 ============================ */
function selfTest() {
  /*
   * 量法自检：正例必须报、反例必须不报。
   * ★ 正例第一条就是这次那个真凶的**原文**（改了颜色就改成你的新值，
   *   但必须留一条"会红的正例"，否则量法坏了你也不知道）。
   */
  const cases = [
    ['0 6px 18px rgba(74, 123, 224, 0.32)', true, '这次的真凶：写死的蓝'],
    ['0 10px 26px rgba(74, 123, 224, 0.46)', true, '同上（第二帧）'],
    ['0 0 0 3px #4a7be0', true, 'hex 有彩色'],
    ['0 0 12px hsl(220, 80%, 60%)', true, 'hsl 有彩色'],
    ['0 0 12px crimson', true, '关键字有彩色'],
    ['0 0 12px oklch(0.6 0.2 250)', true, '未识别颜色函数'],
    ['inset 0 1px 0 rgba(255, 255, 255, 0.24)', false, '白色内线（中性）'],
    ['0 1px 2px rgba(0, 0, 0, 0.25)', false, '黑影（中性）'],
    ['0 10px 26px -12px rgba(0, 0, 0, 0.55), 0 2px 6px rgba(0, 0, 0, 0.28)', false, '多层黑影'],
    ['0 12px 32px rgba(0, 0, 0, 0.42), 0 0 0 1px var(--accent-border)', false, '黑 + 令牌'],
    ['0 8px 22px var(--accent-glow-strong)', false, '全令牌'],
    ['drop-shadow(0 0 4px black)', false, 'drop-shadow 黑影'],
    ['0 0 6px transparent', false, 'transparent'],
    ['0 0 6px currentColor', false, 'currentColor'],
    ['0 0 6px #ffffff', false, 'hex 白'],
    ['0 0 6px #f5f5f5', false, 'hex 近白灰'],
  ];
  const bad = [];
  for (const [value, wantBad, why] of cases) {
    const got = shadowValue('box-shadow', value) !== null || /drop-shadow/.test(value);
    const hit = chromaticLiterals(value).length > 0;
    if (hit !== wantBad) bad.push(`  ${wantBad ? '该报没报' : '不该报却报了'}: \`${value}\`（${why}）`);
    if (!got && wantBad) bad.push(`  shadowValue() 没认出这是阴影: \`${value}\``);
  }
  if (bad.length) {
    console.error('✗ 自检没过 —— **量法坏了**，这条门禁现在的结果不可信：\n');
    for (const b of bad) console.error(b);
    console.error('\n先把 chromaticLiterals() / shadowValue() 修对，再来信它的结论。');
    return false;
  }
  console.log(`✓ 自检通过（${cases.length} 个正反例：有彩色会报、黑白灰/令牌放行）`);
  return true;
}

/* ============================ 主流程 ============================ */
const allCss = readdirSync(STYLES).filter((f) => f.endsWith('.css')).sort();
const SCANNED = allCss.filter((f) => f !== THEME_SOURCE);
if (!allCss.includes(THEME_SOURCE)) {
  // 主题色源不见了 ⇒ "排除它"这件事已经失去意义，先别急着报绿
  console.error(`✗ ${STYLES}/${THEME_SOURCE} 不存在 —— 主题色源没了，先确认仓库状态`);
  process.exit(1);
}
if (SCANNED.length === 0) {
  console.error(`✗ ${STYLES} 里除了 ${THEME_SOURCE} 没有别的 CSS 可查 —— 量法失去了对象`);
  process.exit(1);
}
console.log(`扫描 ${STYLES}/ 下除 ${THEME_SOURCE} 外的 ${SCANNED.length} 份：${SCANNED.join('、')}`);
if (!selfTest()) process.exit(1);

const hits = [];
for (const name of SCANNED) {
  let text;
  try {
    text = readFileSync(join(STYLES, name), 'utf8');
  } catch {
    console.error(`✗ 读不到 ${STYLES}/${name}`);
    process.exit(1);
  }
  for (const d of parseDeclarations(text)) {
    const value = shadowValue(d.prop, d.value);
    if (value === null) continue;
    const literal = `${d.prop}:${d.value}`;
    const exempt = EXEMPT.find((e) => e.file === name && literal.includes(e.needle));
    for (const badColor of chromaticLiterals(value)) {
      if (exempt) {
        console.log(`··· 已豁免（${exempt.why}）  ${name}:${d.line}  ${badColor.color}`);
        continue;
      }
      hits.push({ file: name, ...d, color: badColor.color, why: badColor.why });
    }
  }
}

if (hits.length) {
  console.error(`\n✗ 阴影/发光里有 ${hits.length} 处**写死的有彩色**（换主题不会变色）：\n`);
  for (const h of hits) {
    console.error(`   ${h.file}:${h.line}  [${h.selector}]`);
    console.error(`      ${h.color}  (${h.why})`);
    console.error(`      → ${h.prop}: ${h.value}`);
  }
  console.error(
    `
为什么必须拦住：这类颜色**不会报错、也不会崩**，它只是"在别的主题上看着不对" ——
而默认主题的强调色往往与被写死的那个色**很接近**（启动按钮那次差 0.7°），
所以开发机上永远看不出问题，换主题又是低频操作。用户报的时候已经在用别的主题了。

修法：把颜色换成**跟该元素语义对得上的令牌**（--accent* / --danger* / --slab-glow …），
九套主题各自声明自己的值，颜色就跟着主题走。
万一某处确实必须有彩色字面量，就在 ${'tools/gates/check-shadow-colors.mjs'}
的 EXEMPT 里加一条**带理由**的豁免（按"文件 + 该声明里的唯一子串"定位，
只放过你点名的那一处），不要放宽判据。`,
  );
  process.exit(1);
}
console.log(
  `✓ ${SCANNED.length} 份消费者样式表里，阴影/发光的颜色全部走令牌` +
    `（另 ${THEME_SOURCE} 是主题色源、按判据不查；${allCss.length} 份 CSS 已识别）`,
);
