/**
 * 生成 NSIS 安装程序的**头部图**与**侧边图**（用户：「美化一下安装程序」）。
 *
 * ## 为什么要自己写编码器
 *
 *   NSIS 的两张图必须是 **BMP**（`MUI_HEADERIMAGE_BITMAP` / `MUI_SIDEBARIMAGE`
 *   只认位图）。而仓库的规矩是**不引第三方依赖**（`make-icons.mjs` 连 PNG
 *   都是手写编码的）—— 所以这里同样手写一个 24 位 BMP 编码器，几十行。
 *
 * ## 画什么 / 为什么这么画
 *
 *   安装程序的观感要和**应用本身**一致：深色底（`--bg-base #12151a`）、
 *   强调色蓝（`--accent #5b8def`）、左上角一点氛围光。
 *   两张图都不放文字 —— 文字由 NSIS 自己画（中英文两种语言都有），
 *   画在图里等于把中文钉死，英文用户看到的就是乱码方块。
 *
 *   尺寸是 NSIS 规定的，不能改：
 *     · 头部图 150 × 57
 *     · 侧边图 164 × 314
 *
 * 用法：`node tools/make-installer-assets.mjs`（产物落在 `src-tauri/icons/`）
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(here, '..', 'src-tauri', 'icons');

/* ---------- 24 位 BMP 编码器（自下而上存行，行按 4 字节对齐） ---------- */
function encodeBmp(width, height, rgb) {
  const rowBytes = width * 3;
  const pad = (4 - (rowBytes % 4)) % 4;
  const stride = rowBytes + pad;
  const pixelBytes = stride * height;
  const fileSize = 54 + pixelBytes;

  const buf = Buffer.alloc(fileSize);
  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(54, 10); // 像素数据偏移
  buf.writeUInt32LE(40, 14); // BITMAPINFOHEADER
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26); // planes
  buf.writeUInt16LE(24, 28); // bpp
  buf.writeUInt32LE(0, 30); // 不压缩
  buf.writeUInt32LE(pixelBytes, 34);
  buf.writeInt32LE(2835, 38); // 72 DPI
  buf.writeInt32LE(2835, 42);

  for (let y = 0; y < height; y++) {
    // BMP 是**自下而上**的
    const srcY = height - 1 - y;
    let off = 54 + y * stride;
    for (let x = 0; x < width; x++) {
      const i = (srcY * width + x) * 3;
      buf[off++] = rgb[i + 2]; // B
      buf[off++] = rgb[i + 1]; // G
      buf[off++] = rgb[i]; // R
    }
    for (let p = 0; p < pad; p++) buf[off++] = 0;
  }
  return buf;
}

/* ---------- 画布（RGB，不要 alpha —— BMP 这一版不带透明） ---------- */
function canvas(w, h) {
  return { w, h, data: Buffer.alloc(w * h * 3) };
}
function px(c, x, y, [r, g, b], a = 1) {
  if (x < 0 || y < 0 || x >= c.w || y >= c.h) return;
  const i = (y * c.w + x) * 3;
  c.data[i] = Math.round(r * a + c.data[i] * (1 - a));
  c.data[i + 1] = Math.round(g * a + c.data[i + 1] * (1 - a));
  c.data[i + 2] = Math.round(b * a + c.data[i + 2] * (1 - a));
}
/** 圆形柔光（氛围光斑，和应用的背景一个意思） */
function glow(c, cx, cy, radius, color, strength) {
  for (let y = 0; y < c.h; y++) {
    for (let x = 0; x < c.w; x++) {
      const d = Math.hypot(x - cx, y - cy) / radius;
      if (d >= 1) continue;
      const falloff = (1 - d) * (1 - d); // 二次衰减，边缘更柔
      px(c, x, y, color, falloff * strength);
    }
  }
}
/** 竖直渐变底 */
function gradient(c, top, bottom) {
  for (let y = 0; y < c.h; y++) {
    const k = y / Math.max(1, c.h - 1);
    const col = [0, 1, 2].map((i) => top[i] * (1 - k) + bottom[i] * k);
    for (let x = 0; x < c.w; x++) px(c, x, y, col);
  }
}
/** 圆角矩形（侧边图左侧那道强调色竖条用） */
function bar(c, x0, y0, w, h, color, a = 1) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) px(c, x, y, color, a);
}

/* 与应用同一套颜色（见 styles/tokens.css 的深色主题） */
const BG_TOP = [0x16, 0x1a, 0x21];
const BG_BOTTOM = [0x0f, 0x12, 0x17];
const ACCENT = [0x5b, 0x8d, 0xef];
const VIOLET = [0x8b, 0x5c, 0xf6];

/* ---------- 头部图 150×57：深底 + 左上角一点紫光 + 底部一道强调线 ---------- */
{
  const c = canvas(150, 57);
  gradient(c, BG_TOP, BG_BOTTOM);
  glow(c, 18, 6, 62, VIOLET, 0.5);
  glow(c, 132, 54, 70, ACCENT, 0.35);
  bar(c, 0, 55, 150, 2, ACCENT, 0.85);
  writeFileSync(join(OUT_DIR, 'installer-header.bmp'), encodeBmp(150, 57, c.data));
  console.log('✓ installer-header.bmp  150×57');
}

/* ---------- 侧边图 164×314：深底 + 两道竖光 + 左侧强调条 ---------- */
{
  const c = canvas(164, 314);
  gradient(c, BG_TOP, BG_BOTTOM);
  glow(c, 30, 60, 150, VIOLET, 0.42);
  glow(c, 150, 250, 170, ACCENT, 0.32);
  glow(c, 82, 300, 120, ACCENT, 0.18);
  bar(c, 0, 0, 3, 314, ACCENT, 0.9);
  writeFileSync(join(OUT_DIR, 'installer-sidebar.bmp'), encodeBmp(164, 314, c.data));
  console.log('✓ installer-sidebar.bmp 164×314');
}

mkdirSync(OUT_DIR, { recursive: true });
console.log('（尺寸由 NSIS 规定，不能改；图里不放文字 —— 文字由 NSIS 按语言自己画）');
