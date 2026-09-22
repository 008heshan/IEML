/**
 * 九套主题的**静态判据**（纯解析，不跑浏览器）。
 *
 * 为什么必须有它：手写 9 套配色、每套 30 个令牌，靠"看着还行"一定会出事 ——
 * 漏一个令牌会**继承深色的值**（绿底上冒出个蓝按钮），
 * 某个 tertiary 文字太暗则会导致"设置页那行小字看不见"。
 * 这两种都不是"审美问题"，是**能算出来的错**，所以在这里算。
 *
 * 查三件事：
 *   ① **完整性**：每套必须定义与深色**同一组**令牌（不许漏、不许少）；
 *   ② **对比度**（WCAG 2.1）：正文 / 次要 / 提示文字、主色、选中态底色 —— 逐对算；
 *   ③ **注册表一致**：`src/ui/theme.ts` 里色板预览的两个色必须与 CSS 一模一样
 *      （否则选择器上显示的颜色和换完的样子对不上，用户会以为点错了）。
 */
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const CSS = readFileSync('src/styles/tokens.css', 'utf8');
const TS = readFileSync('src/ui/theme.ts', 'utf8');

/** 取出某一套主题的令牌表 */
function themeTokens(id) {
  // 深色那套的选择器是 ":root,\n:root[data-theme='dark'] {"，其余是 ":root[data-theme='x'] {"
  const re =
    id === 'dark'
      ? /:root,\s*\n:root\[data-theme='dark'\]\s*\{([\s\S]*?)\n\}/
      : new RegExp(`:root\\[data-theme='${id}'\\]\\s*\\{([\\s\\S]*?)\\n\\}`);
  const m = re.exec(CSS);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split('\n')) {
    const t = /^\s*(--[a-z0-9-]+):\s*([^;]+);/i.exec(line);
    if (t) out[t[1]] = t[2].trim();
  }
  return out;
}

/** 从注册表里读九套主题的 id / 预览色 */
function registry() {
  const out = [];
  const re = /\{\s*id:\s*'([a-z]+)',\s*label:\s*'([^']+)',\s*hint:\s*'([^']+)',\s*bg:\s*'([^']+)',\s*accent:\s*'([^']+)'\s*\}/g;
  let m;
  while ((m = re.exec(TS))) out.push({ id: m[1], label: m[2], hint: m[3], bg: m[4], accent: m[5] });
  // 深色那套是拎出来单独定义的（DARK_THEME），格式不同，单独抓
  const dark = /\{\s*id:\s*'dark',\s*label:\s*'([^']+)',\s*hint:\s*'([^']+)',\s*bg:\s*'([^']+)',\s*accent:\s*'([^']+)',?\s*\}/.exec(TS);
  if (dark) out.unshift({ id: 'dark', label: dark[1], hint: dark[2], bg: dark[3], accent: dark[4] });
  return out;
}

/* ---------- 颜色工具 ---------- */
const hex = (h) => {
  const s = h.replace('#', '');
  const n = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)];
};
const rgba = (v) => {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?\s*\)/.exec(v);
  return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]] : null;
};
/** 把任意色值压到不透明底色上 */
function flatten(value, baseRgb) {
  if (value.startsWith('#')) return hex(value);
  const c = rgba(value);
  if (!c) return null;
  const [r, g, b, a] = c;
  return [r * a + baseRgb[0] * (1 - a), g * a + baseRgb[1] * (1 - a), b * a + baseRgb[2] * (1 - a)];
}
const lum = (rgb) => {
  const f = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
};
const contrast = (a, b) => {
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
};

/* ---------- ① 完整性 ---------- */
/*
 * ★ 判据是**显式清单**，不是"跟深色比"。
 *   一开始图省事用"深色有什么别的主题也得有什么"，但深色块里混着
 *   **与主题无关**的令牌（状态色/阴影/纯白 inset，已挪到基础 :root 让所有主题继承）
 *   和**没人用的死令牌**（`--ambient-a/b`，实测 0 处引用，已删）——
 *   拿它当基准，等于逼每套主题把无关的东西抄一遍。
 *   这里写死成"**跟主题有关**的那些"，谁漏了都跑不掉。
 */
const REQUIRED = [
  // 背景六档
  '--bg-base', '--bg-surface', '--bg-raised', '--bg-overlay', '--bg-hover', '--bg-active',
  // 边框三档
  '--border-subtle', '--border-default', '--border-strong',
  // 文字四级
  '--text-primary', '--text-secondary', '--text-tertiary', '--text-disabled',
  // 主色五件套
  '--accent', '--accent-hover', '--accent-active', '--accent-subtle', '--accent-border',
  // 焦点环 / 进度 / 玻璃 / 滚动条
  '--focus-ring', '--progress-track', '--progress-bar',
  '--glass', '--scroll-thumb', '--scroll-thumb-hover',
  // 氛围光斑三色（每套主题的味道主要在这儿）
  '--ambient-violet', '--ambient-violet-soft', '--ambient-green', '--ambient-green-soft',
  '--ambient-blue',
  // ★ 派生令牌：从上面这些算出来，**必须各块自己写**
  //   （var() 在"声明它的元素"上求值，放 :root 会把深色的值烤死）
  '--card-bg', '--btn-primary-bg', '--btn-primary-bg-hover', '--shadow-card',
];

test('九套主题都在 CSS 里，且该有的令牌一个不少', () => {
  const reg = registry();
  assert.equal(reg.length, 9, `注册表里应当有 9 套主题，实际 ${reg.length}`);
  assert.deepEqual(
    reg.map((t) => t.id),
    ['dark', 'molv', 'zanglan', 'jiangzi', 'jiuhong', 'hupo', 'daiqing', 'ouhe', 'kahe'],
    '主题 id 或顺序变了 —— 顺序就是选择器里的显示顺序',
  );

  for (const t of reg) {
    const tokens = themeTokens(t.id);
    assert.ok(tokens, `CSS 里没有主题 ${t.id}（${t.label}）`);
    const missing = REQUIRED.filter((k) => !(k in tokens));
    assert.deepEqual(missing, [], `主题 ${t.label} 缺令牌：${missing.join(', ')}`);
  }
});

/* ---------- ② 对比度 ---------- */
test('九套主题的正文/次要/提示文字与主色对比度达标', () => {
  const reg = registry();
  const failures = [];
  for (const t of reg) {
    const k = themeTokens(t.id);
    const base = hex(k['--bg-base']);
    const ratio = (varName, against) => {
      // against 可能是 rgba（半透明面板）→ 先压到 base 上
      const bgRaw = against === '--bg-base' ? base : flatten(k[against], base);
      const fg = flatten(k[varName], bgRaw);
      return contrast(fg, bgRaw);
    };
    /*
     * 阈值怎么定的：
     *  · 正文（primary）要 7 —— 这是主要阅读内容，深色界面上做不到 7 就是没调好；
     *  · 次要（secondary）4.5 —— WCAG AA 的正文线；
     *  · 提示（tertiary）3 —— 它是 hint 小字，AA 对大字号/非正文的要求；
     *  · 主色（accent）4.5 —— 它当链接与主按钮底色用，必须读得清；
     *  · 正文压在"选中态底色"（bg-active）上 4.5 —— 侧栏选中项就是这一对。
     */
    const checks = [
      ['--text-primary', '--bg-base', 7, '正文'],
      ['--text-secondary', '--bg-base', 4.5, '次要文字'],
      ['--text-tertiary', '--bg-base', 3, '提示文字'],
      ['--accent', '--bg-base', 4.5, '主色'],
      ['--text-primary', '--bg-active', 4.5, '正文/选中底色'],
      ['--text-secondary', '--bg-raised', 4.5, '次要文字/卡片底'],
    ];
    for (const [fgVar, bgVar, min, what] of checks) {
      const r = ratio(fgVar, bgVar);
      if (!(r >= min)) {
        failures.push(`${t.label}(${t.id}) ${what} ${fgVar} on ${bgVar} = ${r.toFixed(2)} < ${min}`);
      }
    }
  }
  assert.deepEqual(failures, [], '对比度不达标：\n' + failures.join('\n'));
});

/* ---------- ③ 注册表与 CSS 一致 ---------- */
test('注册表里的预览色与 CSS 里的实际色一致', () => {
  const bad = [];
  for (const t of registry()) {
    const k = themeTokens(t.id);
    if (k['--bg-base'].toLowerCase() !== t.bg.toLowerCase()) {
      bad.push(`${t.label}: 预览底色 ${t.bg} ≠ CSS ${k['--bg-base']}`);
    }
    if (k['--accent'].toLowerCase() !== t.accent.toLowerCase()) {
      bad.push(`${t.label}: 预览主色 ${t.accent} ≠ CSS ${k['--accent']}`);
    }
  }
  assert.deepEqual(bad, [], bad.join('\n'));
});

/* ---------- ④ 光斑三色也得跟着主题 ---------- */
test('每套主题都有自己的氛围光斑颜色（不是共用深色那套紫/绿/蓝）', () => {
  const dark = themeTokens('dark');
  const same = [];
  for (const t of registry()) {
    if (t.id === 'dark') continue;
    const k = themeTokens(t.id);
    for (const v of ['--ambient-violet', '--ambient-green', '--ambient-blue']) {
      if (k[v] === dark[v]) same.push(`${t.label} 的 ${v} 与深色完全相同`);
    }
  }
  assert.deepEqual(same, [], same.join('\n'));
});
