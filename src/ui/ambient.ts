/**
 * 背景光斑（氛围层）—— **几何的唯一真源**。
 * ------------------------------------------------------------------
 * 这块原来只有一份 CSS（`tokens.css` 里 `body::before` 的三条 `radial-gradient`）。
 * 这一轮的「液态玻璃」给同一层加了两个新用途，于是它必须变成"一份数据、三处消费"：
 *
 *   | 消费者 | 用途 | 为什么不能各写一份 |
 *   |---|---|---|
 *   | CSS（`--ambient-image`） | 适中/弱化档实际画的背景 | —— |
 *   | CPU 采样（`createSampler`） | 玻璃的**内容适应性**取色（要求 5） | 采样点必须和画出来的**同一团**光斑，否则"玻璃跟着背景变色"就是假的 |
 *   | WebGL（`createAmbientGL`） | 灵动档的流体背景 | 流动相位与 CPU 采样共用 `drift()`，否则取色会与画面**错拍** |
 *
 * ★ 教训从哪来：这个项目里"两处各写一份同样的东西"已经翻过车（版本号散在 6 个文件、
 *   判据表散在 3 处）。所以宁可多一层间接：**几何只写在这里**。
 *
 * ## 光斑的坐标系
 *
 * 全部用**归一化视口坐标**（0..1），CSS 用百分比、canvas 用像素、GL 用 uv ——
 * 三边各自转换，不用互相知道对方的分辨率。
 */

/** 一团光斑 */
export interface AmbientBlob {
  id: string;
  /** 圆心（归一化视口坐标） */
  cx: number;
  cy: number;
  /** 半径（视口宽/高的比例）—— 与 CSS 的 `radial-gradient(60% 55% at …)` 同义 */
  rx: number;
  ry: number;
  /** 圆心颜色：CSS 变量名（**用变量而不是字面色**，深色主题改色时三处一起变） */
  coreVar: string;
  /** 中间停靠点颜色；`null` = 该光斑没有中间色（直接 core → transparent） */
  midVar: string | null;
  /** 流动幅度（归一化坐标；灵动档才动） */
  driftX: number;
  driftY: number;
  /** 流动周期（秒）—— 三团取互质一点的数，合成图案不会"整层一起摆" */
  period: number;
  /** 相位（0..1），让三团不同步 */
  phase: number;
}

/**
 * 三团光斑 —— 与 `tokens.css` 里原来那条 `body::before` 的值**逐个对齐**。
 *
 * ★ 改这里就等于改背景：`ambientCss()` 会把它们重新拼成 CSS 字符串。
 */
export const AMBIENT_BLOBS: readonly AmbientBlob[] = [
  {
    id: 'violet',
    cx: 0.12,
    cy: 0.12,
    rx: 0.6,
    ry: 0.55,
    coreVar: '--ambient-violet',
    midVar: '--ambient-violet-soft',
    driftX: 0.03,
    driftY: 0.025,
    period: 46,
    phase: 0,
  },
  {
    id: 'green',
    cx: 0.88,
    cy: 0.88,
    rx: 0.55,
    ry: 0.5,
    coreVar: '--ambient-green',
    midVar: '--ambient-green-soft',
    driftX: 0.028,
    driftY: 0.03,
    period: 61,
    phase: 0.35,
  },
  {
    id: 'blue',
    cx: 0.7,
    cy: 0.15,
    rx: 0.4,
    ry: 0.35,
    coreVar: '--ambient-blue',
    midVar: null,
    driftX: 0.035,
    driftY: 0.02,
    period: 53,
    phase: 0.7,
  },
] as const;

/** 颜色停靠点：与 CSS 的 `0% / 45% / transparent 85%` 同义（归一化半径） */
export const AMBIENT_STOPS = [0, 0.45, 0.85] as const;

/** 一团光斑在 `t` 秒时的圆心（归一化坐标） */
export function blobCenter(b: AmbientBlob, t: number): { cx: number; cy: number } {
  if (t === 0) return { cx: b.cx, cy: b.cy };
  const w = (t / b.period + b.phase) * Math.PI * 2;
  // 两个频率不同的正弦 → 李萨如式的慢漂移，**不会**看起来像"来回摆"
  return {
    cx: b.cx + Math.sin(w) * b.driftX,
    cy: b.cy + Math.sin(w * 1.37 + 1.1) * b.driftY,
  };
}

/**
 * 拼出 CSS 背景（`--ambient-image`）。
 *
 * ★ 颜色一律走 `var(--ambient-*)`：主题令牌改了，这里自动跟上 ——
 *   如果在这里写死 rgba，换色时就会漏掉这一份（这个坑在别处踩过）。
 */
export function ambientCss(): string {
  return AMBIENT_BLOBS.map((b) => {
    const at = `${(b.cx * 100).toFixed(2)}% ${(b.cy * 100).toFixed(2)}%`;
    const size = `${(b.rx * 100).toFixed(2)}% ${(b.ry * 100).toFixed(2)}%`;
    const mid = b.midVar ? `, var(${b.midVar}) ${AMBIENT_STOPS[1] * 100}%` : '';
    return `radial-gradient(${size} at ${at}, var(${b.coreVar}) 0%${mid}, transparent ${AMBIENT_STOPS[2] * 100}%)`;
  }).join(',\n    ');
}

/** 把拼好的背景挂到 `:root` 的 `--ambient-image`（`body::before` 用它） */
export function installAmbientCss(root: HTMLElement = document.documentElement): void {
  root.style.setProperty('--ambient-image', ambientCss());
}

/* ====================== CPU 采样（玻璃的"内容适应性"用） ====================== */

/** 一个 RGBA 颜色（0..255） */
export interface Rgb {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parseColor(input: string): Rgb {
  const s = input.trim();
  const m = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (m) {
    const parts = (m[1] ?? '').split(/[\s,/]+/).filter(Boolean).map(Number);
    return {
      r: parts[0] ?? 0,
      g: parts[1] ?? 0,
      b: parts[2] ?? 0,
      a: parts.length > 3 ? (parts[3] ?? 1) : 1,
    };
  }
  // 认不出来就当透明 —— 宁可"不调色"，也不要算出一个错的颜色
  return { r: 0, g: 0, b: 0, a: 0 };
}

export interface AmbientSampler {
  /**
   * 取某个归一化坐标处的**合色**（光斑按 alpha 叠在底色上）。
   *
   * @param nx 0..1（视口横向）
   * @param ny 0..1（视口纵向）
   * @param t  秒；`0` = 静态（适中/弱化档的位置）
   */
  at(nx: number, ny: number, t?: number): Rgb;
  /** 主题或档位变化后重新读令牌色 */
  refresh(): void;
}

/**
 * 造一个采样器：把光斑画进一张很小的离屏 canvas，再读像素。
 *
 * ★ 为什么用 canvas 而不是"手算 alpha 合成"：`radial-gradient` 的**椭圆插值**
 *   在 CSS 里是浏览器算的，手写一份必然有偏差（尤其 45% 那个停靠点附近）。
 *   画进 canvas 再读，等于让浏览器替我们算 —— 代价只是一张 48×48 的图。
 */
export function createSampler(dpr = 1): AmbientSampler {
  const N = 48;
  const cv = document.createElement('canvas');
  cv.width = Math.round(N * dpr);
  cv.height = Math.round(N * dpr);
  const ctx = cv.getContext('2d', { willReadFrequently: true })!;
  let palette: { blobs: { b: AmbientBlob; core: Rgb; mid: Rgb }[]; base: Rgb } | null = null;
  let painted = -1;
  /**
   * ★★ 整张采样图的像素**一次读回**，之后所有取点都在这个数组里查。
   *
   *   为什么（实测）：第一版是**每取一个点**就 `getImageData(px, py, 1, 1)` ——
   *   而 canvas 的 `getImageData` 是一次 GPU→CPU 回读，很贵。
   *   一次取色要 25（网格平均）+ N（每块玻璃）次 → 30 多次回读；
   *   再叠上"滚动时每帧都取一次色"，帧时间直接从 16ms 涨到 **33ms**（掉帧）。
   *   改成一次读整张（48×48 = 9216 像素，一次回读）之后，取点变成纯数组索引。
   */
  let pixels: Uint8ClampedArray | null = null;

  const readPalette = () => {
    const cs = getComputedStyle(document.documentElement);
    const bodyCs = getComputedStyle(document.body);
    return {
      base: parseColor(bodyCs.backgroundColor),
      blobs: AMBIENT_BLOBS.map((b) => ({
        b,
        core: parseColor(cs.getPropertyValue(b.coreVar)),
        mid: b.midVar ? parseColor(cs.getPropertyValue(b.midVar)) : { r: 0, g: 0, b: 0, a: 0 },
      })),
    };
  };

  const paint = (t: number) => {
    const p = palette!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = `rgba(${p.base.r},${p.base.g},${p.base.b},1)`;
    ctx.fillRect(0, 0, cv.width, cv.height);

    for (const { b, core, mid } of p.blobs) {
      const { cx, cy } = blobCenter(b, t);
      // 椭圆 = 先缩放坐标系，再画正圆（圆心在原点、半径 1，stops 用归一化值）
      ctx.save();
      ctx.translate(cx * cv.width, cy * cv.height);
      ctx.scale(Math.max(b.rx * cv.width, 0.001), Math.max(b.ry * cv.height, 0.001));
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
      const c0 = `rgba(${core.r},${core.g},${core.b},${core.a})`;
      g.addColorStop(0, c0);
      if (b.midVar) g.addColorStop(AMBIENT_STOPS[1], `rgba(${mid.r},${mid.g},${mid.b},${mid.a})`);
      g.addColorStop(AMBIENT_STOPS[2], 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(-1, -1, 2, 2);
      ctx.restore();
    }
    // ★ 画完**一次性**把整张读回来（见上面 `pixels` 的说明）
    pixels = ctx.getImageData(0, 0, cv.width, cv.height).data;
    painted = t;
  };

  const ensure = (t: number) => {
    if (!palette) palette = readPalette();
    // 静态档（t=0）画一次就够；灵动档按"秒"取整重画（每秒一次，没人看得出来）
    if (Math.abs(painted - t) > 0.9 || painted === -1) paint(t);
  };

  return {
    at(nx, ny, t = 0) {
      ensure(t);
      const px = Math.min(cv.width - 1, Math.max(0, Math.round(nx * cv.width)));
      const py = Math.min(cv.height - 1, Math.max(0, Math.round(ny * cv.height)));
      const i = (py * cv.width + px) * 4;
      const d = pixels;
      if (!d) return { r: 0, g: 0, b: 0, a: 0 };
      return { r: d[i] ?? 0, g: d[i + 1] ?? 0, b: d[i + 2] ?? 0, a: (d[i + 3] ?? 255) / 255 };
    },
    refresh() {
      palette = null;
      painted = -1;
    },
  };
}

/* ====================== WebGL2 背景（灵动档） ====================== */

/**
 * 光斑强度倍率。
 *
 * ★ 为什么要"倍率"而不是直接用令牌里的 alpha：令牌那套值（0.18 / 0.13 / 0.08）
 *   是给 **CSS 多层 alpha 叠加**调的；这里换成了**加色混合**，同一个数值看起来会
 *   淡得多（加法不会互相盖住，但也不会有 alpha 叠出来的实感）。
 *   第一版没加这个倍率，结果是"灵动档的背景比适中档还看不见"。
 *   2.4 是实机看出来的：再高就开始发灰、影响卡片上的文字对比度。
 */
const AURA_GAIN = 2.4;

const VERT = `#version 300 es
precision highp float;
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

/**
 * 片元着色器：**底色 + 三团流动的光斑 + 一层慢流场 + 细颗粒**。
 *
 * ★ 比 CSS 那版"高级"在哪（用户明确要的"更好看更高级"）：
 *   ① =加色混合=：CSS 的多层渐变是普通 alpha 叠，颜色会互相盖住；
 *      这里是相加，两团重叠处会更亮（紫+绿交界泛出暖白），像真的光。
 *   ② 边缘用 `smoothstep` 收尾，没有 CSS 渐变那种可见的"色带台阶"；
 *   ③ 加一层**抖动噪点**（dither）—— 8bit 屏上大面积暗色渐变必然出色带，
 *      CSS 那版没治，这里用 ±1/255 的噪声打散；
 *   ④ 一团光斑不只是"漂移"，还会**缓慢缩放**（`uTime` 进的第二项），
 *      看起来像流体而不是三个圆形贴纸；
 *   ⑤ 随指针微视差（`uPointer`）。
 *
 * ★★ `uBase` 是**必须的**：这个画布是 `alpha: false`（不透明，省一次合成），
 *    所以它得自己把底色铺上。第一版漏了这一点 —— 画布铺了一层近黑，
 *    把主题底色整个盖掉，症状是"灵动档的背景比中间档还暗"。
 *
 * ★★ 流场（`filaments`）是第三轮加的，它解决的是**折射看不见**这个真问题：
 *    `backdrop-filter` 的执行顺序是「**先模糊、后位移**」——
 *    细于模糊核（这里 18px）的结构会被模糊整个吃掉，于是位移**没有东西可弯**。
 *    真机实测：卡片/模态背后是平滑渐变时，"真滤镜 vs 恒等滤镜"的像素差
 *    **小于同状态的噪声**（5.83）。
 *    所以背景里得放**比模糊核更粗**（~70px 尺度）的亮丝：模糊留得住它，
 *    位移才看得出来。这不是"多画点装饰"，而是**折射可见性的前提**。
 *    （反过来说：如果只想让背景好看，加细噪点更省 —— 但那样折射永远看不见。）
 */
const FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;

uniform vec2  uRes;
uniform float uTime;
uniform vec2  uPointer;      // -1..1
uniform vec3  uBase;         // 主题底色（不透明画布自己要铺）
uniform float uGain;         // 光斑强度倍率（灵动档比 CSS 那版更足）
uniform vec3  uCore[3];      // **预乘 alpha** 的圆心色
uniform vec3  uMid[3];
uniform vec2  uCenter[3];
uniform vec2  uRadius[3];

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

/* 二维值噪声（便宜版）：四次哈希 + 平滑插值 */
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

void main() {
  vec2 uv = vUv;
  vec2 par = uPointer * vec2(0.012, 0.012);
  vec3 acc = uBase;

  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    vec2 c = uCenter[i] + par;
    // 缓慢缩放：让"三团圆"看着像在流动，而不是三个贴纸在平移
    float breathe = 1.0 + 0.07 * sin(uTime * 0.11 + fi * 2.1);
    vec2 d = (uv - c) / max(uRadius[i] * breathe, vec2(1e-4));
    float r = length(d);

    float w = smoothstep(1.0, 0.05, r);
    float inner = smoothstep(0.45, 0.0, r);
    vec3 col = mix(uMid[i], uCore[i], inner);
    acc += col * w * uGain;
  }

  /* 慢流场（亮丝）：~70px 尺度、随时间长流。见上面那段说明 ——
     它是"折射看得见"的前提，不是装饰。用蓝色那团光斑的色，主题一改跟着改。
     ★ 速度取得很慢（每秒约 12px）：既是"缓流"的观感，也让像素级对照
       有机会把"折射造成的位移"从"背景自己在动"里分出来。 */
  vec2 fp = vec2(uv.x * uRes.x / max(uRes.y, 1.0), uv.y) * 13.0;
  float flow = vnoise(fp + vec2(uTime * 0.012, uTime * 0.007))
             + 0.5 * vnoise(fp * 2.13 - vec2(uTime * 0.009, uTime * 0.004));
  flow /= 1.5;
  float filament = smoothstep(0.54, 0.93, flow);
  acc += uCore[2] * filament * 1.9;

  // 颗粒：±1/255 的抖动，专门打散暗部色带
  float n = hash(gl_FragCoord.xy + fract(uTime) * 91.7) - 0.5;
  acc += n * (1.6 / 255.0);

  outColor = vec4(acc, 1.0);
}`;

export interface AmbientGL {
  /** 每帧推进（由调用方的 rAF 驱动；`hidden` 时应当暂停） */
  frame(seconds: number, pointerX: number, pointerY: number): void;
  resize(width: number, height: number, dpr: number): void;
  /** 主题令牌变了（换主题/改档）→ 重读颜色 */
  refreshTheme(): void;
  destroy(): void;
}

/**
 * 起一个 WebGL2 背景。**失败就返回 `null`**（调用方回落到 CSS 背景）——
 * 灵动档已经用能力探测拦过一道，这里是第二道保险：驱动崩了不该让界面白屏。
 */
export function createAmbientGL(canvas: HTMLCanvasElement): AmbientGL | null {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: 'low-power',
  });
  if (!gl) return null;

  const compile = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      console.warn('[IEML/glass] 着色器编译失败：', log);
      gl.deleteShader(s);
      return null;
    }
    return s;
  };

  const vs = compile(gl.VERTEX_SHADER, VERT);
  const fs = compile(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return null;

  const prog = gl.createProgram()!;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.warn('[IEML/glass] 着色器链接失败：', gl.getProgramInfoLog(prog));
    return null;
  }
  gl.useProgram(prog);

  // 一个盖满屏的三角形（比两个三角形少一条对角线接缝）
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'aPos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const u = {
    res: gl.getUniformLocation(prog, 'uRes'),
    time: gl.getUniformLocation(prog, 'uTime'),
    pointer: gl.getUniformLocation(prog, 'uPointer'),
    base: gl.getUniformLocation(prog, 'uBase'),
    gain: gl.getUniformLocation(prog, 'uGain'),
    core: gl.getUniformLocation(prog, 'uCore'),
    mid: gl.getUniformLocation(prog, 'uMid'),
    center: gl.getUniformLocation(prog, 'uCenter'),
    radius: gl.getUniformLocation(prog, 'uRadius'),
  };
  gl.uniform1f(u.gain, AURA_GAIN);

  /** 把 CSS 色（含 alpha）读成预乘的 0..1 三元组 */
  const readColors = () => {
    const cs = getComputedStyle(document.documentElement);
    const rgba = (v: string) => {
      const m = /^rgba?\(([^)]+)\)$/i.exec(cs.getPropertyValue(v).trim());
      const p = m ? (m[1] ?? '').split(/[\s,/]+/).filter(Boolean).map(Number) : [0, 0, 0, 0];
      const a = p.length > 3 ? (p[3] ?? 1) : 1;
      return [((p[0] ?? 0) / 255) * a, ((p[1] ?? 0) / 255) * a, ((p[2] ?? 0) / 255) * a];
    };
    const core = new Float32Array(9);
    const mid = new Float32Array(9);
    AMBIENT_BLOBS.forEach((b, i) => {
      const c = rgba(b.coreVar);
      const m = b.midVar ? rgba(b.midVar) : c;
      core.set(c, i * 3);
      mid.set(m, i * 3);
    });
    return { core, mid };
  };

  let colors = readColors();
  const center = new Float32Array(6);
  const radius = new Float32Array(6);

  /** 主题底色（画布不透明，得自己铺） */
  const readBase = () => {
    const cs = getComputedStyle(document.documentElement);
    const hex = cs.getPropertyValue('--bg-base').trim();
    const m = /^#([0-9a-f]{6})$/i.exec(hex);
    if (m) {
      const v = parseInt(m[1] ?? '12151a', 16);
      return [(v >> 16) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
    }
    // 不是 #rrggbb（主题改过）→ 退回浏览器算出来的 body 底色
    const rgb = /^rgba?\(([^)]+)\)$/i.exec(getComputedStyle(document.body).backgroundColor);
    const p = rgb ? (rgb[1] ?? '').split(/[\s,/]+/).filter(Boolean).map(Number) : [18, 21, 26];
    return [(p[0] ?? 18) / 255, (p[1] ?? 21) / 255, (p[2] ?? 26) / 255];
  };
  let base = readBase();

  return {
    frame(seconds, pointerX, pointerY) {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

      AMBIENT_BLOBS.forEach((b, i) => {
        const { cx, cy } = blobCenter(b, seconds);
        center[i * 2] = cx;
        center[i * 2 + 1] = 1 - cy; // GL 的 y 朝上
        radius[i * 2] = b.rx;
        radius[i * 2 + 1] = b.ry;
      });

      gl.uniform2f(u.res, canvas.width, canvas.height);
      gl.uniform1f(u.time, seconds);
      gl.uniform2f(u.pointer, pointerX, pointerY);
      gl.uniform3fv(u.base, base);
      gl.uniform3fv(u.core, colors.core);
      gl.uniform3fv(u.mid, colors.mid);
      gl.uniform2fv(u.center, center);
      gl.uniform2fv(u.radius, radius);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    resize(width, height, dpr) {
      const w = Math.max(1, Math.round(width * dpr));
      const h = Math.max(1, Math.round(height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
    },
    refreshTheme() {
      colors = readColors();
      base = readBase();
    },
    destroy() {
      gl.deleteBuffer(buf);
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}
