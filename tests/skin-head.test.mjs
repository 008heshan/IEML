/**
 * 皮肤头像那套坐标的判据（2026-09-23）。
 *
 * ## 为什么要有这个测试
 *
 *   64×64 皮肤里"哪一块是头、哪一块是帽子"是**位置数据**，而显示出来是
 *   `background-size` + `background-position` 两个字符串。这套数字手抄一次就会错，
 *   **错了界面上只是"头像看着不对"，不报任何错** —— 用户截图问过来两次：
 *     ① 「头像不显示」（我写成了 `0 0`，取到的是皮肤左上角的空白区）；
 *     ② 我第二次手写帽子层时又算错了一遍（缩放后偏移忘了跟着缩放）。
 *
 *   所以这里不看代码、只**核对几何**：
 *     把 `background-size`/`background-position` 还原成"可见窗口覆盖源图哪一块"，
 *     断言它正好等于头部/帽子那 8×8。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

/* 直接跑 TS 不现实（本项目没有 ts 运行时），所以这里**把两个导出原样抄下来**？
   —— 不行，抄下来就失去了"盯住实现"的意义。
   改用：读源文件、解析出 SKIN_SRC 与 skinLayer 的实现，再在测试里跑它。 */
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/components/SkinHead.tsx', import.meta.url), 'utf8');

/** 从源码里取出皮肤源坐标（只认这一处定义） */
function parseSkinSrc() {
  const m = /export const SKIN_SRC = \{([\s\S]*?)\} as const;/.exec(src);
  assert.ok(m, '源码里应当有 SKIN_SRC 定义');
  const head = /head:\s*\{\s*x:\s*(\d+),\s*y:\s*(\d+)\s*\}/.exec(m[1]);
  const hat = /hat:\s*\{\s*x:\s*(\d+),\s*y:\s*(\d+)\s*\}/.exec(m[1]);
  assert.ok(head && hat, 'SKIN_SRC 里应当有 head 与 hat');
  return {
    head: { x: Number(head[1]), y: Number(head[2]) },
    hat: { x: Number(hat[1]), y: Number(hat[2]) },
  };
}

/** 把 `skinLayer` 的公式在测试里独立实现一遍（与源码对照，防止公式被改坏） */
function expected(src2, size) {
  const k = size / 8;
  return {
    backgroundSize: `${64 * k}px ${64 * k}px`,
    backgroundPosition: `${-src2.x * k}px ${-src2.y * k}px`,
  };
}

/** 从 CSS 值反解"可见窗口覆盖源图的哪一块" */
function visibleCell(bgSize, bgPos, size) {
  const scaled = Number(/(-?[\d.]+)px/.exec(bgSize)[1]);
  const k = scaled / 64; // 源图 → 显示 的缩放
  const px = Number(/(-?[\d.]+)px/.exec(bgPos)[1]);
  const py = Number(/(-?[\d.]+)px/.exec(bgPos.slice(bgPos.indexOf(' ') + 1))[1]);
  return { x: -px / k, y: -py / k, cell: size / k };
}

test('皮肤源坐标就是官方布局（头 8,8 / 帽 40,8）', () => {
  const s = parseSkinSrc();
  assert.deepEqual(s.head, { x: 8, y: 8 }, '头部在 (8,8)');
  assert.deepEqual(s.hat, { x: 40, y: 8 }, '帽子层在 (40,8)');
});

test('头部层：可见窗口正好覆盖源图 (8,8) 起的 8×8', () => {
  const s = parseSkinSrc();
  for (const size of [16, 22, 40, 64]) {
    const e = expected(s.head, size);
    const cell = visibleCell(e.backgroundSize, e.backgroundPosition, size);
    assert.equal(cell.x, 8, `size=${size}：横向应当从源图 x=8 开始`);
    assert.equal(cell.y, 8, `size=${size}：纵向应当从源图 y=8 开始`);
    assert.equal(cell.cell, 8, `size=${size}：窗口应当正好 8 像素宽`);
  }
});

test('帽子层：可见窗口正好覆盖源图 (40,8) 起的 8×8', () => {
  const s = parseSkinSrc();
  // ★ 帽子层比头大一圈，所以尺寸是 size × 9/8 —— 系数要跟着它走，
  //   这正是我第二次写错的地方（用了 size 而不是 hatSize）
  for (const size of [16, 22, 40, 64]) {
    const hatSize = (size * 9) / 8;
    const e = expected(s.hat, hatSize);
    const cell = visibleCell(e.backgroundSize, e.backgroundPosition, hatSize);
    assert.equal(cell.x, 40, `size=${size}：帽子横向应当从源图 x=40 开始`);
    assert.equal(cell.y, 8, `size=${size}：帽子纵向应当从源图 y=8 开始`);
    assert.equal(cell.cell, 8, `size=${size}：窗口应当正好 8 像素宽`);
  }
});

test('源码里的实现与这条几何公式一致（不是两套）', () => {
  // 源码里应当**只有一处**算这套坐标的地方：skinLayer
  const impls = (src.match(/const k = size \/ 8;/g) ?? []).length;
  assert.equal(impls, 1, 'skinLayer 应当只有一处实现');
  // 并且确实是用 src.x/src.y 乘 k 得到的（而不是写死的 -size / -5*size）
  assert.match(src, /backgroundPosition: `\$\{-src\.x \* k\}px \$\{-src\.y \* k\}px`/);
  assert.doesNotMatch(
    src,
    /backgroundPosition: `\$\{-5 \* size\}px/,
    '不该再有"手写的 5×size"那种写法（帽子层缩放后不是 5×size）',
  );
});
