/**
 * 液态玻璃的**运行时** —— 三件事，都是 CSS 做不到的：
 * ------------------------------------------------------------------
 *   ① **透镜滤镜**：为每块玻璃按它的**真实尺寸与圆角**烘一张法线图，
 *      塞进 `backdrop-filter: url(#…)`，于是背后内容在边缘被真的扭断
 *      （要求 1「边缘折射」。真机探针见 `tools/live/probe-webview-glass.mjs`）。
 *   ② **指针高光**：一个**委托**的 `pointermove`，把光标位置写进元素的
 *      `--glass-gx/--glass-gy`，CSS 用它摆那层流动的反光（要求 2）。
 *   ③ **内容适应取色**：按元素在视口里的位置，从 `ambient.ts` 的采样器里
 *      取"它下面那团光斑是什么颜色"，写进 `--glass-tint`（要求 5）。
 *
 * ## 三条工程约束（都是被这台机器上的实测逼出来的）
 *
 * ★ **一个元素一张法线图，但只在 `aura` 档**。`backdrop-filter` 里的 SVG 滤镜是
 *   整条链路里最贵的一步：每块玻璃都是一次离屏滤镜 pass。所以：
 *   · 只有**够格的机器**（WebGL2 + 新系统）才会走到这里；
 *   · 只给**尺寸稳定的表面**注册（列表里几十张卡片不注册 —— 它们用 CSS 那套
 *     "缩放带折射"，见 `app.css` 的「液态玻璃」一节）。
 *
 * ★ **尺寸量化到 8px**：`ResizeObserver` 会在拖窗口时疯狂回调，逐像素重建法线图
 *   会把主线程吃满。量化 + `rAF` 合并之后，拖窗口只重建十几次。
 *
 * ★ **每帧只写必要的属性**：指针高光走 rAF 合并；取色**不在**每帧做
 *   （它要 `getBoundingClientRect` + 一次 canvas 采样），而是 1 秒一次。
 */

import {
  createAmbientGL,
  createSampler,
  type AmbientGL,
  type AmbientSampler,
} from './ambient';
import type { VfxLevel } from './vfx';
import { supportsSvgBackdrop, vfxCapability } from './vfx';

/* ====================== 透镜法线图 ====================== */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 法线图的边长上限（越小越省，64 已经够 20px 的边缘带用了） */
const MAP_MAX = 96;
/** 法线图分辨率 = 元素尺寸 × 这个系数 */
const MAP_SCALE = 0.22;
/** 边缘带占短边的比例（决定了"折射带"有多宽） */
const BAND_RATIO = 0.085;
/** 位移强度（像素）—— 越大越"厚"。
 *
 *  ★ 2026-09-21 把它从 26 提到 **44**：真机对照发现，26 的时候折射在**卡片的像素上
 *    几乎测不出来**（那些表面背后是平滑的氛围背景，弯一点点看不出来）。
 *    提到 44 之后差异才进入可测范围。再往上（>60）边缘就开始像哈哈镜了。
 */
const DISPLACE_PX = 44;

function quantize(v: number, step = 8): number {
  return Math.max(step, Math.round(v / step) * step);
}

/**
 * 烘一张圆角矩形的**法线图**（R/G 存 x/y 位移，128 = 不动）。
 *
 * 剖面用"离最近边缘的距离"推：越靠边位移越强，且方向指向**内部** ——
 * 这就是一块凸透镜边缘把背后内容往里拉的样子（放大镜边缘）。
 *
 * @param w 元素宽（CSS px）
 * @param h 元素高（CSS px）
 * @param radius 圆角（CSS px）
 */
function bakeNormalMap(w: number, h: number, radius: number): string {
  const mw = Math.max(16, Math.min(MAP_MAX, Math.round(w * MAP_SCALE)));
  const mh = Math.max(16, Math.min(MAP_MAX, Math.round(h * MAP_SCALE)));
  const cv = document.createElement('canvas');
  cv.width = mw;
  cv.height = mh;
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(mw, mh);

  // 以图心为原点、按图尺寸归一化的圆角矩形「距离场」
  const hx = mw / 2;
  const hy = mh / 2;
  // 圆角与边缘带都按**短边**折算，这样长条卡片与方块看起来厚度一致
  const short = Math.min(mw, mh);
  const r = Math.max(1, Math.min(radius * MAP_SCALE, short / 2 - 1));
  const band = Math.max(2, short * BAND_RATIO);

  const sdf = (px: number, py: number) => {
    const qx = Math.abs(px) - (hx - r);
    const qy = Math.abs(py) - (hy - r);
    const ax = Math.max(qx, 0);
    const ay = Math.max(qy, 0);
    return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
  };

  for (let y = 0; y < mh; y += 1) {
    for (let x = 0; x < mw; x += 1) {
      const px = x + 0.5 - hx;
      const py = y + 0.5 - hy;
      const inside = -sdf(px, py); // >0 = 在形状内部
      let nx = 0;
      let ny = 0;
      if (inside > 0 && inside < band) {
        const e = 0.5;
        const gx = sdf(px + e, py) - sdf(px - e, py);
        const gy = sdf(px, py + e) - sdf(px, py - e);
        const len = Math.hypot(gx, gy) || 1;
        const t = Math.pow(1 - inside / band, 1.35);
        nx = (-gx / len) * t;
        ny = (-gy / len) * t;
      }
      const i = (y * mw + x) * 4;
      img.data[i] = 128 + nx * 127;
      img.data[i + 1] = 128 + ny * 127;
      img.data[i + 2] = 128;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv.toDataURL('image/png');
}

/** 透镜滤镜的注册表：同一个 key 只烘一次 */
class LensRegistry {
  private host: SVGSVGElement;
  private made = new Map<string, string>();

  constructor() {
    this.host = document.createElementNS(SVG_NS, 'svg');
    this.host.setAttribute('width', '0');
    this.host.setAttribute('height', '0');
    this.host.setAttribute('aria-hidden', 'true');
    this.host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;pointer-events:none';
    this.host.id = 'ieml-lens-defs';
    document.body.appendChild(this.host);
  }

  /** 为一块玻璃取（或建）它的滤镜 id */
  idFor(w: number, h: number, radius: number): string {
    const qw = quantize(w);
    const qh = quantize(h);
    const qr = quantize(radius, 4);
    const key = `${qw}x${qh}x${qr}`;
    const hit = this.made.get(key);
    if (hit) return hit;

    const id = `ieml-lens-${key}`;
    const filter = document.createElementNS(SVG_NS, 'filter');
    filter.setAttribute('id', id);
    // ★ x/y/width/height 必须显式写满：默认滤镜区域是 -10%/120%，
    //   位移把边缘像素推到区域外就会被裁掉，症状是"边缘一圈变透明"。
    filter.setAttribute('x', '0');
    filter.setAttribute('y', '0');
    filter.setAttribute('width', '100%');
    filter.setAttribute('height', '100%');
    filter.setAttribute('color-interpolation-filters', 'sRGB');

    const feImage = document.createElementNS(SVG_NS, 'feImage');
    feImage.setAttribute('href', bakeNormalMap(qw, qh, qr));
    feImage.setAttribute('result', 'map');
    feImage.setAttribute('preserveAspectRatio', 'none');
    feImage.setAttribute('x', '0');
    feImage.setAttribute('y', '0');
    feImage.setAttribute('width', '100%');
    feImage.setAttribute('height', '100%');

    const disp = document.createElementNS(SVG_NS, 'feDisplacementMap');
    disp.setAttribute('in', 'SourceGraphic');
    disp.setAttribute('in2', 'map');
    disp.setAttribute('scale', String(DISPLACE_PX));
    disp.setAttribute('xChannelSelector', 'R');
    disp.setAttribute('yChannelSelector', 'G');

    filter.appendChild(feImage);
    filter.appendChild(disp);
    this.host.appendChild(filter);
    this.made.set(key, id);
    return id;
  }

  /** 已烘多少张（验证时打印，也用于"别烘爆了"的告警） */
  get size(): number {
    return this.made.size;
  }

  /**
   * **回收没人在用的滤镜**。
   *
   * ★ 为什么需要：每次元素尺寸一变（拖窗口、切页面、开合模态）就会烘一张新的 ——
   *   量化到 8px 只是让增长变慢，**不是不增长**。实测：三次改尺寸 +4 张、
   *   档位来回切再 +1 张。一个开着几小时的启动器会攒下几百张
   *   （每张 = 一个 SVG filter 节点 + 一段 96×96 的 PNG dataURI，约 3 KB）。
   *   这里只回收**当前没有任何元素引用**的那些（`data-lens` 里出现的 id 一律留着），
   *   所以不会把正在用的滤镜摘掉。
   */
  prune(active: Set<string>): number {
    let dropped = 0;
    for (const [key, id] of [...this.made]) {
      if (active.has(id)) continue;
      this.host.querySelector(`filter[id="${id}"]`)?.remove();
      this.made.delete(key);
      dropped += 1;
    }
    return dropped;
  }

  destroy(): void {
    this.host.remove();
    this.made.clear();
  }
}

/* ====================== 控制器 ====================== */

export interface GlassController {
  /** 换档（设置页改档 / 启动时施加） */
  setLevel(level: VfxLevel): void;
  /**
   * 低性能损耗模式开关（<html> 上的 low-perf 类）。
   *
   * ★ 为什么控制器要知道它：那一档的 CSS 用 `!important` 把所有 backdrop-filter
   *   关掉了（包括折射），但 JS 这边**还在维护透镜** —— 实测 low-perf 开着时
   *   6 块玻璃仍然挂着 `data-lens`、仍在按尺寸重烘法线图。
   *   状态两边不一致 = 白干活，而且以后谁读 `data-lens` 都会被误导。
   */
  setLowPerf(on: boolean): void;
  /** 当前生效的档位 */
  level(): VfxLevel;
  /** 诊断信息（真机验证脚本读它，比翻 DOM 可靠） */
  stats(): { level: VfxLevel; surfaces: number; lenses: number; pruned: number; gl: boolean; canRefract: boolean };
  dispose(): void;
}

/**
 * 参与折射的玻璃 —— **有意只收大的、尺寸稳定的表面**。
 *
 * ★★ `.page-head`（粘性标题条）**不能进来** —— 这一条是真机量出来的，而且
 *   它是"标题条上磨砂与折射**二选一**"这个事实：
 *
 *   · 给 `.page-head::before` 挂 `backdrop-filter: … url(#滤镜)` 之后，
 *     **整条 backdrop-filter 失效**（连 blur 一起没了）——
 *     实测："挂真滤镜 / 挂同结构但位移 1px 的克隆滤镜 / 完全关掉"三者像素**完全一样**；
 *   · 而不挂 url() 时，磨砂是**真的在遮挡**（开关差远大于噪声）。
 *
 *   用户当初要的是"没有割裂感**还能作遮挡**"——遮挡是硬需求，折射是锦上添花，
 *   所以这里选磨砂。**谁想给标题条加折射，先解决"url() 会让它整条失效"这件事。**
 */
const REFRACT_SELECTOR = '.glass-refract';

export function createGlassController(initial: VfxLevel): GlassController {
  let level: VfxLevel = initial;
  let disposed = false;

  /**
   * 真折射**要不要装** —— 两条同时成立才装：
   *   ① 这台机器够格跑灵动档（真显卡 + 新系统，判据在 `vfx.ts`）；
   *   ② 这个 WebView2 认 `backdrop-filter: url(#…)`（直接问，见 `supportsSvgBackdrop`）。
   *
   * ★ 为什么"适中档也要用真折射"：老机器根本走不到这里（条件①就把它们挡住了），
   *   它们用的是 `app.css` 里那套纯 CSS 的廉价材质；而**能跑灵动的机器**在适中档
   *   装一个弱一点的折射，才不会出现"切到适中，玻璃忽然变成一块平面"这种断层。
   *   也就是说：**材质的分档是连续的，只有老机器才走另一条实现路径。**
   */
  const canRefract = vfxCapability().auraAllowed && supportsSvgBackdrop();
  document.documentElement.dataset.vfxLens = canRefract ? 'on' : 'off';

  const sampler: AmbientSampler = createSampler();
  const lenses = new LensRegistry();
  const registered = new Set<HTMLElement>();
  const observed = new WeakMap<HTMLElement, ResizeObserver>();

  /* ---------- 背景（灵动档才起 GL） ---------- */
  let glCanvas: HTMLCanvasElement | null = null;
  let gl: AmbientGL | null = null;
  let raf = 0;
  let pointerX = 0;
  let pointerY = 0;
  const started = performance.now();

  const startGL = () => {
    if (gl || glCanvas) return;
    glCanvas = document.createElement('canvas');
    glCanvas.className = 'glass-ambient-gl';
    glCanvas.setAttribute('aria-hidden', 'true');
    document.body.insertBefore(glCanvas, document.body.firstChild);
    gl = createAmbientGL(glCanvas);
    if (!gl) {
      // ★ 第二道保险：能力探测说行、真起却失败（驱动崩了/被策略拦了）。
      //   回落成 CSS 背景，并且**别把界面留在黑屏上**。
      console.warn('[IEML/glass] WebGL2 背景起不来，回落 CSS 光斑');
      glCanvas.remove();
      glCanvas = null;
      document.documentElement.dataset.vfxGl = 'fallback';
      return;
    }
    document.documentElement.dataset.vfxGl = 'on';
    const resize = () => {
      gl?.resize(window.innerWidth, window.innerHeight, Math.min(window.devicePixelRatio || 1, 1.5));
    };
    resize();
    window.addEventListener('resize', resize);
    glCanvas.dataset.resize = '1'; // 标记已挂 resize（dispose 时据此解绑）
  };

  const stopGL = () => {
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    gl?.destroy();
    gl = null;
    glCanvas?.remove();
    glCanvas = null;
    delete document.documentElement.dataset.vfxGl;
  };

  /* ---------- 每帧循环（只有灵动档在跑） ---------- */
  const loop = () => {
    if (disposed || level !== 'aura') return;
    raf = requestAnimationFrame(loop);
    // 后台时循环**根本不会被调度**（见 applyVisibility）——这里再兜一道
    if (document.hidden || !gl) return;
    gl.frame((performance.now() - started) / 1000, pointerX, pointerY);
  };

  /* ---------- 内容适应取色 ---------- */
  /**
   * 每块玻璃取到的颜色，要**放大它相对整屏平均的偏离**才看得见。
   *
   * ★ 为什么必须放：光斑令牌的 alpha 只有 0.08~0.18，叠在深色底上，
   *   两块相隔 500px 的玻璃采样出来的差值往往只有 **3~6 个色阶**
   *   （实测 rgb(22 23 35) 与 rgb(18 24 27)）—— 直接拿去当底色，
   *   人眼完全看不出来，"内容适应性"就成了一句空话。
   *   放大的办法是**只放大偏离、不动平均**：`tint = 平均 + 偏离 × K`，
   *   这样整体亮度不变（不会把玻璃调亮或调暗），只有**色相**跟着背景走 ——
   *   正是用户要的那句"背景是暖色玻璃就偏暖，冷色就偏冷"。
   *
   * K = 4.2 是实机调出来的：3 以下几乎看不出，6 以上颜色开始失真（紫的变洋红）。
   */
  const TINT_GAIN = 4.2;

  const tintAll = () => {
    if (level === 'weak') {
      // 弱化档不做适应：固定色。清掉旧值，免得切档后残留上一档的颜色。
      for (const el of registered) el.style.removeProperty('--glass-tint');
      return;
    }
    const t = level === 'aura' ? (performance.now() - started) / 1000 : 0;
    const vw = window.innerWidth || 1;
    const vh = window.innerHeight || 1;

    // 先在 5×5 网格上取一次"整屏平均" —— 它就是中性的参照色
    let ar = 0;
    let ag = 0;
    let ab = 0;
    for (let i = 0; i < 5; i += 1) {
      for (let j = 0; j < 5; j += 1) {
        const s = sampler.at((i + 0.5) / 5, (j + 0.5) / 5, t);
        ar += s.r;
        ag += s.g;
        ab += s.b;
      }
    }
    ar /= 25;
    ag /= 25;
    ab /= 25;

    const clamp255 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

    for (const el of registered) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      // 取**中心**那一点：卡片的四角往往压在别的面上，中心最能代表"它底下是什么"
      const c = sampler.at((r.left + r.width / 2) / vw, (r.top + r.height / 2) / vh, t);
      const tr = clamp255(ar + (c.r - ar) * TINT_GAIN);
      const tg = clamp255(ag + (c.g - ag) * TINT_GAIN);
      const tb = clamp255(ab + (c.b - ab) * TINT_GAIN);
      el.style.setProperty('--glass-tint', `${tr} ${tg} ${tb}`);
      // 亮度也带上：下方越亮，玻璃的高光越淡（否则两块叠一起会"过曝"）
      const lum = (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
      el.style.setProperty('--glass-lum', lum.toFixed(3));
    }
  };

  /* ---------- 折射：按元素尺寸注册滤镜 ---------- */
  /**
   * 给一块玻璃装折射滤镜。
   *
   * ★ 两种装法，取决于"滤镜挂在哪一层"：
   *   · 普通玻璃（卡片 / 模态）→ 直接写元素的内联 `backdrop-filter`；
   *   · **标题条**（材质挂在 `::before` 上，伪元素设不了内联样式）
   *     → 把 `url(#…)` 写进 `--glass-lens-url`，由 CSS 变量喂给 `::before`。
   *   标题条那一处才是折射**最看得出来**的地方（它下面滚过的全是文字与列表），
   *   详见 `app.css` 里 `.page-head::before` 的注释。
   */
  const applyLens = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    if (r.width < 24 || r.height < 24) return;
    const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
    const id = lenses.idFor(r.width, r.height, radius);

    if (el.classList.contains('page-head')) {
      // 材质挂在 `::before` 上，而伪元素设不了内联样式 → 只能走变量。
      // `data-lens` 则是 CSS 里那条规则的开关（见 app.css 的说明）。
      el.style.setProperty('--glass-lens-url', `url(#${id})`);
      el.dataset.lens = id;
      return;
    }

    const blur = getComputedStyle(el).getPropertyValue('--glass-blur').trim() || '12px';
    el.style.backdropFilter = `blur(${blur}) saturate(150%) url(#${id})`;
    el.style.setProperty('-webkit-backdrop-filter', `blur(${blur}) saturate(150%) url(#${id})`);
    el.dataset.lens = id;
  };

  const clearLens = (el: HTMLElement) => {
    el.style.removeProperty('backdrop-filter');
    el.style.removeProperty('-webkit-backdrop-filter');
    el.style.removeProperty('--glass-lens-url');
    delete el.dataset.lens;
  };

  /** 低性能损耗模式：CSS 会把所有 backdrop-filter 关掉，所以这里也不该装透镜 */
  let lowPerfOn = false;

  /** 这一档该不该装透镜滤镜 */
  const lensWanted = () => canRefract && !lowPerfOn && (level === 'aura' || level === 'mid');

  /**
   * 回收没被引用的透镜滤镜（见 `LensRegistry.prune`）。
   * ★ 必须在**一轮重烘之后**调：那时每个元素的 `data-lens` 才都是它当前真正用的 id。
   */
  let prunedTotal = 0;
  const pruneLenses = () => {
    const active = new Set<string>();
    for (const el of registered) {
      const id = el.dataset.lens;
      if (id) active.add(id);
    }
    prunedTotal += lenses.prune(active);
  };

  const register = (el: HTMLElement) => {
    if (registered.has(el)) return;
    registered.add(el);
    // ② 高光的载体（固定尺寸光斑 + 边缘环）——只在需要时创建，创建后一直复用
    if (!el.hasAttribute('data-no-glow')) ensureGlow(el);
    rects.set(el, el.getBoundingClientRect());
    if (lensWanted() && el.matches(REFRACT_SELECTOR)) applyLens(el);
    const ro = new ResizeObserver(() => {
      if (lensWanted() && el.matches(REFRACT_SELECTOR)) applyLens(el);
      pruneLenses();
      scheduleTint();
    });
    ro.observe(el);
    observed.set(el, ro);
  };

  const scan = () => {
    // ★ `.page-head` 也算玻璃面（它的材质挂在 `::before` 上）：
    //   把取色也给它，否则标题条永远用兜底蓝 —— 和它下面的卡片明显不是一家人。
    document.querySelectorAll<HTMLElement>('.glass, .glass-refract, .page-head').forEach(register);
  };

  const unregisterGone = () => {
    for (const el of registered) {
      if (!el.isConnected) {
        observed.get(el)?.disconnect();
        registered.delete(el);
      }
    }
  };

  /* ---------- 调度：把高频事件合并成一帧 ---------- */
  let tintQueued = false;
  const scheduleTint = () => {
    if (tintQueued) return;
    tintQueued = true;
    requestAnimationFrame(() => {
      tintQueued = false;
      if (!disposed) tintAll();
    });
  };

  /* ====================== ② 动态高光：固定光斑元素 + transform ======================
   *
   * ★★ 写法抄自用户自己的网站（`Infinity/source/custom/nav/nav-core.js`），
   *   它把"为什么"写得很清楚，我照搬结论：
   *
   *   「光斑做成独立合成层(.nav-glow-spot) + 边缘环(.nav-edge>.nav-edge-light)，
   *     位置全部由 JS【直写 style.transform】控制（不再用 CSS 变量，避免每帧
   *     变量传播/样式重算/背景重绘造成的拖影与跳动）。
   *     原方案是在 ::after 上移动 radial-gradient 中心(改 --gx/--gy)，
   *     但那属于每帧重绘(paint)；改用固定尺寸光斑元素 + transform:translate3d，
   *     transform 只走合成器(compositor)不触发重绘，帧数更高、更跟手。」
   *
   *   我上一版正是它点名的"原方案"（指针每动一次就改 `--glass-gx/--glass-gy`）。
   *
   * ★ 另外三个细节也照搬：
   *   · 光心 = 指针到元素矩形的**最近投影点**（clamp）——
   *     指针在元素外但靠近时，光斑压在最靠边的那一点，边缘被照亮；
   *   · 亮度按**椭圆归一化距离**衰减（越近越亮，"接近即泛光"）；
   *   · **rect 缓存**：不是每次 pointermove 都 getBoundingClientRect()
   *     （那会强制同步布局）；滚动/尺寸变化时按 rAF 重测。
   * ==================================================================== */

  interface Glow {
    spot: HTMLElement;
    edge: HTMLElement;
    edgeLight: HTMLElement;
    alpha: string;
    /** 最近一次写入的位置（用来各自去重：位置变了就写位置，亮度变了才写亮度） */
    transform: string;
  }
  const glows = new WeakMap<HTMLElement, Glow>();
  const rects = new WeakMap<HTMLElement, DOMRect>();

  const ensureGlow = (el: HTMLElement): Glow => {
    const hit = glows.get(el);
    if (hit) return hit;
    const clip = document.createElement('div');
    clip.className = 'glass-glow';
    clip.setAttribute('aria-hidden', 'true');
    const spot = document.createElement('div');
    spot.className = 'glass-glow-spot';
    const edge = document.createElement('div');
    edge.className = 'glass-edge';
    const edgeLight = document.createElement('div');
    edgeLight.className = 'glass-edge-light';
    edge.appendChild(edgeLight);
    clip.appendChild(spot);
    clip.appendChild(edge);
    el.insertBefore(clip, el.firstChild);
    const g: Glow = { spot, edge, edgeLight, alpha: '', transform: '' };
    glows.set(el, g);
    return g;
  };

  /** 光斑椭圆半径（来自 CSS 令牌，改档/改尺寸时重读） */
  let RX = 170;
  let RY = 130;
  let GLOW_W = 340;
  let GLOW_H = 260;
  const readGlowVars = () => {
    const cs = getComputedStyle(document.documentElement);
    const num = (k: string, fb: number) => {
      const v = parseFloat(cs.getPropertyValue(k));
      return Number.isFinite(v) && v > 0 ? v : fb;
    };
    RX = num('--glow-rx', 170);
    RY = num('--glow-ry', 130);
    GLOW_W = num('--glow-w', 340);
    GLOW_H = num('--glow-h', 260);
  };
  readGlowVars();

  const measureRects = () => {
    for (const el of registered) if (el.isConnected) rects.set(el, el.getBoundingClientRect());
  };
  const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
  /** 越近越亮：椭圆归一化距离的补数 */
  const targetAlphaAt = (r: DOMRect, x: number, y: number) => {
    let dx = 0;
    let dy = 0;
    if (x < r.left) dx = r.left - x;
    else if (x > r.right) dx = x - r.right;
    if (y < r.top) dy = r.top - y;
    else if (y > r.bottom) dy = y - r.bottom;
    const t = Math.hypot(dx / RX, dy / RY);
    return Math.max(0, Math.min(1, 1 - t));
  };

  const pointer = { x: -1e5, y: -1e5 };
  let glowQueued = false;

  const writeGlows = () => {
    glowQueued = false;
    if (disposed) return;
    for (const el of registered) {
      const g = glows.get(el);
      if (!g) continue;
      const r = rects.get(el);
      if (!r || !r.width || !r.height) continue;
      // 弱化档不发光（那一档承诺"平"）；灵动/适中都发光
      const want = level === 'weak' ? 0 : targetAlphaAt(r, pointer.x, pointer.y);
      const a = want.toFixed(3);
      const cx = clamp(pointer.x, r.left, r.right) - r.left;
      const cy = clamp(pointer.y, r.top, r.bottom) - r.top;
      const t = 'translate3d(' + (cx - GLOW_W / 2).toFixed(1) + 'px,' + (cy - GLOW_H / 2).toFixed(1) + 'px,0)';
      /*
       * ★★ 位置与亮度要**各自**去重，不能"亮度没变就整次跳过" —— 这是踩出来的：
       *   指针在元素**内部**移动时亮度一直是 1（不变），于是
       *   "亮度相同 → continue" 把**位置更新也一起跳过**了，
       *   症状是"在卡片上滑动时光斑不动"（真机检查一眼抓到）。
       */
      if (t !== g.transform) {
        g.transform = t;
        g.spot.style.transform = t;
        /*
         * 边缘环的光心：那层现在是 `calc(100% + 520px) × calc(100% + 280px)`
         * （见 app.css），即四周各留 260 / 140 的余量。
         * 要把渐变中心落在元素内的 (cx, cy)，位移就是 (cx - w/2, cy - h/2) ——
         * 层中心正好比元素中心多出 (260, 140)，两边抵消。
         * ★ 别再写回固定的 1200/600：那是"层永远是 2400×1200"时代的常数，
         *   层一旦跟着元素缩，它就把光斑推到元素外面去。
         */
        g.edgeLight.style.transform =
          'translate3d(' + (cx - r.width / 2).toFixed(1) + 'px,' + (cy - r.height / 2).toFixed(1) + 'px,0)';
      }
      if (a !== g.alpha) {
        g.alpha = a;
        g.spot.style.opacity = a;
        g.edge.style.opacity = a;
        if (Number(a) > 0.5) el.setAttribute('data-hover', '1');
        else el.removeAttribute('data-hover');
      }
    }
  };
  const scheduleGlow = () => {
    if (glowQueued || disposed) return;
    glowQueued = true;
    requestAnimationFrame(writeGlows);
  };

  const onPointerMove = (e: PointerEvent) => {
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    scheduleGlow();
  };
  /** 指针离开窗口：全部熄灭（否则光斑会停在最后一处） */
  const onPointerLeave = () => {
    pointer.x = -1e5;
    pointer.y = -1e5;
    scheduleGlow();
  };

  /* ---------- 组装 ---------- */
  const applyLevel = (next: VfxLevel) => {
    level = next;
    if (next === 'aura') {
      startGL();
      if (!raf) raf = requestAnimationFrame(loop);
      for (const el of registered) if (el.matches(REFRACT_SELECTOR)) applyLens(el);
    } else if (lensWanted()) {
      // 适中档：还留着折射（弱一档），但**不起 GL 背景**
      stopGL();
      for (const el of registered) if (el.matches(REFRACT_SELECTOR)) applyLens(el);
    } else {
      for (const el of registered) clearLens(el);
      stopGL();
    }
    pruneLenses();
    sampler.refresh();
    scheduleTint();
  };

  document.addEventListener('pointermove', onPointerMove, { passive: true });
  document.addEventListener('pointerleave', onPointerLeave);
  document.addEventListener('mouseleave', onPointerLeave);
  const mo = new MutationObserver(() => {
    unregisterGone();
    scan();
    scheduleTint();
  });
  mo.observe(document.body, { childList: true, subtree: true });
  /**
   * 滚动时要做两件事：重新取色 + **重测矩形**。
   * ★ 为什么必须重测：卡片在滚动容器里，位置一直在变；而光斑用的是
   *   `getBoundingClientRect`（视口坐标）——不重测的话，滚过之后
   *   光斑就会"跟错地方"（这是用户网站注释里点名的第二个坑：
   *   "导航栏缩小后光效位置不对"）。
   */
  let measureQueued = false;
  const onScroll = () => {
    scheduleTint();
    if (measureQueued) return;
    measureQueued = true;
    requestAnimationFrame(() => {
      measureQueued = false;
      if (!disposed) measureRects();
    });
  };
  document.addEventListener('scroll', onScroll, { passive: true, capture: true });
  window.addEventListener('resize', () => {
    sampler.refresh();
    scheduleTint();
  });

  // 灵动档每 900ms 跟一次流动的颜色；其余档位不需要（背景是静的）
  const tintTimer = window.setInterval(() => {
    if (level === 'aura' && !document.hidden) scheduleTint();
  }, 900);

  /* ====================== ④ 前台才渲染高级效果 ======================
   *
   * 用户要求：「选择灵动视效并且启动器在前台时强制用 GPU 渲染，
   *           在后台时不渲染高级效果」。
   *
   * ★ 做法抄自用户网站的 `perf/tab-visibility.js`（它连原因都写了）：
   *   「.bg-liquid 全屏光斑层有 46s 的 CSS 动画，浏览器在标签页失焦时会对动画
   *     节流(throttling)，重新聚焦一瞬间会一次性重算该全屏动画 + 全部
   *     backdrop-filter 模糊层 → 卡一下。
   *     方案: 监听 visibilitychange，页面隐藏时给 <html> 加 .tab-hidden，
   *     CSS 据此暂停所有动画(animation-play-state: paused)；切回时移除。」
   *
   * 我们这边"高级效果"有三样，后台时**全部停掉**：
   *   ① GL 背景的 rAF 循环（停止调度，不只是 return —— 省掉每帧的回调）；
   *   ② 取色定时器（已在上面用 document.hidden 挡着）；
   *   ③ CSS 动画（由 .tab-hidden 里的 animation-play-state: paused 承担）。
   *   回前台时原样恢复：重开 rAF、必要时补一次取色。
   */
  const applyVisibility = () => {
    const hidden = document.hidden;
    document.documentElement.classList.toggle('tab-hidden', hidden);
    if (hidden) {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    } else if (level === 'aura' && !raf) {
      raf = requestAnimationFrame(loop);
      scheduleTint();
    }
  };
  document.addEventListener('visibilitychange', applyVisibility);

  scan();
  applyLevel(initial);

  return {
    setLevel(next) {
      if (disposed || next === level) return;
      applyLevel(next);
    },
    setLowPerf(on) {
      if (disposed || on === lowPerfOn) return;
      lowPerfOn = on;
      // 重新施加一遍：该收的收（low-perf 开）、该装回来的装回来
      applyLevel(level);
    },
    level: () => level,
    stats: () => ({
      level,
      surfaces: registered.size,
      lenses: lenses.size,
      pruned: prunedTotal,
      gl: !!gl,
      canRefract,
    }),
    dispose() {
      disposed = true;
      if (tintTimer) clearInterval(tintTimer);
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerleave', onPointerLeave);
      document.removeEventListener('mouseleave', onPointerLeave);
      document.removeEventListener('visibilitychange', applyVisibility);
      document.documentElement.classList.remove('tab-hidden');
      document.removeEventListener('scroll', onScroll, true);
      mo.disconnect();
      for (const el of registered) {
        observed.get(el)?.disconnect();
        clearLens(el);
        el.style.removeProperty('--glass-tint');
        el.style.removeProperty('--glass-lum');
        el.removeAttribute('data-hover');
      }
      registered.clear();
      stopGL();
      lenses.destroy();
      delete document.documentElement.dataset.vfxLens;
    },
  };
}
