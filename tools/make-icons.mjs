/**
 * 生成应用图标（无第三方依赖，手写 PNG 编码）
 * 画的是 IEML 的方块标记：靛蓝圆角底 + 白色立方体线框。
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/* ---------- 最小 PNG 编码器 ---------- */
function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // 每行前面加 filter byte 0
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- 画图 ---------- */
const ACCENT = [0x5b, 0x8d, 0xef];
const WHITE = [0xff, 0xff, 0xff];

function createCanvas(size) {
  return { size, data: Buffer.alloc(size * size * 4) };
}

function setPx(c, x, y, [r, g, b], a = 1) {
  if (x < 0 || y < 0 || x >= c.size || y >= c.size) return;
  const i = (y * c.size + x) * 4;
  const inv = 1 - a;
  c.data[i] = Math.round(r * a + c.data[i] * inv);
  c.data[i + 1] = Math.round(g * a + c.data[i + 1] * inv);
  c.data[i + 2] = Math.round(b * a + c.data[i + 2] * inv);
  c.data[i + 3] = Math.round(255 * a + c.data[i + 3] * inv);
}

/** 圆角矩形的覆盖率（用于抗锯齿） */
function roundRectCoverage(size, radius, x, y) {
  const inset = size * 0.06;
  const l = inset, t = inset, r = size - inset, b = size - inset;
  const rad = radius;
  // 点是否在圆角矩形内，返回 0/1；用 2x2 超采样做抗锯齿
  const inside = (px, py) => {
    if (px < l || px > r || py < t || py > b) return false;
    const cx = Math.min(Math.max(px, l + rad), r - rad);
    const cy = Math.min(Math.max(py, t + rad), b - rad);
    const dx = px - cx, dy = py - cy;
    return dx * dx + dy * dy <= rad * rad + 0.0001;
  };
  let hits = 0;
  for (const ox of [0.25, 0.75]) for (const oy of [0.25, 0.75]) {
    if (inside(x + ox, y + oy)) hits++;
  }
  return hits / 4;
}

/** 画线段（带粗细），坐标用 0..1 归一化 */
function drawLine(c, x1, y1, x2, y2, width, color, alpha = 1) {
  const S = c.size;
  const ax = x1 * S, ay = y1 * S, bx = x2 * S, by = y2 * S;
  const hw = (width * S) / 2;
  const minX = Math.floor(Math.min(ax, bx) - hw - 2);
  const maxX = Math.ceil(Math.max(ax, bx) + hw + 2);
  const minY = Math.floor(Math.min(ay, by) - hw - 2);
  const maxY = Math.ceil(Math.max(ay, by) + hw + 2);
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      // 点到线段的距离
      let t = ((x - ax) * dx + (y - ay) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const px = ax + t * dx, py = ay + t * dy;
      const d = Math.hypot(x - px, y - py);
      // 1px 抗锯齿
      const cov = Math.max(0, Math.min(1, hw - d + 0.5));
      if (cov > 0) setPx(c, x, y, color, cov * alpha);
    }
  }
}

function drawIcon(size) {
  const c = createCanvas(size);
  const radius = size * 0.22;

  // 底：圆角方块
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cov = roundRectCoverage(size, radius, x, y);
      if (cov > 0) setPx(c, x, y, ACCENT, cov);
    }
  }

  // 立方体线框（等轴测）：用一个"上菱形 + 竖直棱 + 下菱形"的标准画法
  const cx = 0.5;
  const cy = 0.5;
  const rx = 0.30;   // 水平半径
  const ry = 0.16;   // 菱形竖直半高
  const h = 0.20;    // 棱柱高度（竖直棱长度）

  const top = [cx, cy - h / 2 - ry];
  const right = [cx + rx, cy - h / 2];
  const left = [cx - rx, cy - h / 2];
  const mid = [cx, cy - h / 2 + ry];

  const topB = [top[0], top[1] + h];
  const rightB = [right[0], right[1] + h];
  const leftB = [left[0], left[1] + h];
  const midB = [mid[0], mid[1] + h];

  const w = size <= 32 ? 0.07 : size <= 64 ? 0.06 : 0.05;

  // 顶面菱形
  drawLine(c, ...top, ...right, w, WHITE);
  drawLine(c, ...right, ...mid, w, WHITE);
  drawLine(c, ...mid, ...left, w, WHITE);
  drawLine(c, ...left, ...top, w, WHITE);
  // 三条可见的竖直棱（后棱画细一点，形成层次）
  drawLine(c, ...left, ...leftB, w, WHITE);
  drawLine(c, ...right, ...rightB, w, WHITE);
  drawLine(c, ...mid, ...midB, w, WHITE);
  // 底面两条可见边
  drawLine(c, ...leftB, ...midB, w, WHITE);
  drawLine(c, ...midB, ...rightB, w, WHITE);

  return encodePng(size, size, c.data);
}

/* ---------- 输出 ---------- */
const outDir = join(__dirname, '..', 'src-tauri', 'icons');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const targets = [
  ['32x32.png', 32],
  ['128x128.png', 128],
  ['128x128@2x.png', 256],
  ['icon.png', 512],
];

for (const [name, size] of targets) {
  const png = drawIcon(size);
  writeFileSync(join(outDir, name), png);
  console.log(`${name.padEnd(18)} ${size}x${size}  ${png.length} 字节`);
}

// Windows .ico（内嵌 PNG 的 ICO 格式，Vista+ 支持）
function buildIco(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);

  const dirs = [];
  let offset = 6 + count * 16;
  const blobs = [];
  for (const [size, png] of entries) {
    const d = Buffer.alloc(16);
    d[0] = size >= 256 ? 0 : size;
    d[1] = size >= 256 ? 0 : size;
    d[2] = 0;
    d[3] = 0;
    d.writeUInt16LE(1, 4);
    d.writeUInt16LE(32, 6);
    d.writeUInt32LE(png.length, 8);
    d.writeUInt32LE(offset, 12);
    dirs.push(d);
    blobs.push(png);
    offset += png.length;
  }
  return Buffer.concat([header, ...dirs, ...blobs]);
}

const ico = buildIco([
  [16, drawIcon(16)],
  [32, drawIcon(32)],
  [48, drawIcon(48)],
  [256, drawIcon(256)],
]);
writeFileSync(join(outDir, 'icon.ico'), ico);
console.log(`icon.ico           ${ico.length} 字节`);
console.log('\n图标已生成到 src-tauri/icons/');
