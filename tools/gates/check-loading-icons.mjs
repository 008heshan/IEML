#!/usr/bin/env node
/**
 * 门禁：**loading 时不许同时出现"转圈 + 原来的图标"**。
 * ------------------------------------------------------------------
 * ★★★★ 用户 2026-10-09：「我们的某些 UI，点击后会有旋转动画表示正在处理，
 *   但问题是**在原有的图标的左侧再来一个旋转图标**，这是个重复，万万不可。
 *   **这是个通用问题**」。
 *
 * ## 这个 bug 的形状（值得记住，因为它藏了半个多月）
 *
 *   `Button` 渲染的是 `{loading ? <span className="spinner" /> : null}{children}`，
 *   而"藏掉原图标"的 CSS 写的是 `.btn-loading > svg:first-child` ——
 *   **转圈自己就是 first-child**，图标从第一个变成了第二个 ⇒ 那条选择器
 *   在 loading 时**永远匹配不上**。于是每个带图标的按钮都多出一个转圈。
 *
 *   ★ 教训与仓库里其它门禁同源：**"意图"写在注释里、判据不写在代码里，就会这样。**
 *     而且它不会红、不会报错，只是每个按钮都悄悄多画一个图标。
 *
 * ## 三条判据（都是"机制"级的，不看具体哪个按钮）
 *
 *   ① `ui/index.tsx` 的 `Button` 仍然把转圈渲染在 `{children}` **之前**
 *      （那是这套做法的前提；改了顺序，"紧跟在转圈后面"的规则就要一起改）；
 *   ② `app.css` 里有**不依赖 `:first-child`** 的藏图标规则：
 *      直接子 `svg` / `img` 一律藏；
 *   ③ 没有一条 `.btn-loading` 规则还在用 `:first-child` 来藏图标
 *      （那正是复发时的写法）。
 *
 * 用法：node tools/gates/check-loading-icons.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const problems = [];
const ok = [];

const BUTTON = readFileSync(join('src', 'ui', 'index.tsx'), 'utf8');
/*
 * ★ 先剥掉注释再查 CSS：这些规则**本身就在注释里被当成反例写着**
 *   （见 `app.css` 那段说明）。不剥的话会有两种错：
 *   · 注释里提一句 ".btn-loading > svg" 就能让"有这条规则"的判据**假绿**；
 *   · 注释里引用旧的 `:first-child` 写法又会被当成"复发"**假红**。
 *   两类都踩过（这个仓库对"判据只看光秃秃的代码"有共识）。
 */
const CSS_RAW = readFileSync(join('src', 'styles', 'app.css'), 'utf8');
const CSS = CSS_RAW.replace(/\/\*[\s\S]*?\*\//g, '');

/* ---------- ① Button：转圈要在 children 之前 ---------- */
const spinnerAt = BUTTON.indexOf('className="spinner"');
const childrenAt = BUTTON.indexOf('{children}', spinnerAt >= 0 ? spinnerAt : 0);
if (spinnerAt < 0) {
  problems.push('src/ui/index.tsx 里找不到 `className="spinner"` —— Button 的 loading 实现变了？');
} else if (childrenAt < 0 || childrenAt < spinnerAt) {
  problems.push(
    'Button 里的转圈**没有**渲染在 `{children}` 之前 —— 那套"转圈替换图标"的 CSS 是按这个顺序写的，顺序一变就要一起改',
  );
} else {
  ok.push('Button 仍把转圈渲染在 children 之前');
}

/* ---------- ② 有"不看第几个"的藏图标规则 ---------- */
const hideDirect =
  /\.btn-loading\s*>\s*svg\b/.test(CSS) && /\.btn-loading\s*>\s*img\b/.test(CSS);
if (hideDirect) ok.push('app.css 会把 loading 按钮里的直接子 svg / img 藏掉');
else {
  problems.push(
    'app.css 里缺少 `.btn-loading > svg` / `> img` 的隐藏规则 —— loading 时按钮里的原图标不会被替换掉，' +
      '用户会看到"转圈 + 原图标"并排',
  );
}
const hideWrapped = /\.btn-loading\s*>\s*\.spinner\s*\+\s*(\.ico|span:has\(>\s*svg\))/.test(CSS);
if (hideWrapped) ok.push('app.css 也照顾了包在壳里的图标（IconWrap / span>svg）');
else {
  problems.push(
    'app.css 里缺少 `.btn-loading > .spinner + .ico`（或 `+ span:has(> svg)`）—— ' +
      '用 `IconWrap` 包起来的图标仍会与转圈并排',
  );
}

/* ---------- ③ 不许再用 :first-child 藏 loading 图标（复发时的写法） ---------- */
const reFirst = /\.btn-loading[^{]*:first-child[^{]*\{[^}]*display:\s*none/gs;
const firstHits = CSS.match(reFirst);
if (firstHits) {
  for (const h of firstHits) {
    problems.push(
      '又出现了用 `:first-child` 藏 loading 图标的规则 —— 它在 loading 时永远匹配不上（转圈才是第一个）：' +
        h.split('{')[0].trim(),
    );
  }
} else {
  ok.push('没有用 `:first-child` 藏 loading 图标的残留写法');
}

for (const o of ok) console.log('  ✓ ' + o);
for (const p of problems) console.log('  ✗ ' + p);
console.log('');
if (problems.length) {
  console.error(`loading 图标重复的防线没守住：${problems.length} 项（详见文件头部的说明）`);
  process.exit(1);
}
console.log('✓ loading 时按钮里的原图标会被转圈替换掉（不会并排出现两个图标）');
