/**
 * 视效档位（三档）—— **唯一的判据、唯一的施加处**。
 * ------------------------------------------------------------------
 * 用户 2026-09-21：「我想要真实的液态玻璃」+ 五条具体要求（边缘折射 / 动态高光 /
 * 色散边缘 / 厚度感 / 内容适应性），并补了两条：
 *   · 「视效也要三档，弱化视效，适中视效，灵动视效」；
 *   · 「当用户电脑是 win7 或者显卡不支持 WebGL 2.0 时，默认适中，并且不开放灵动视效」。
 *
 * ## 与「动效档位」的关系（两个档位是**正交**的，别合并）
 *
 * | | 管什么 | 键 | 谁受影响 |
 * |---|---|---|---|
 * | 动效（`ui/motion.ts`） | **时间**：动画、过渡、错峰入场 | `ieml.motion` | 会晕动效的人 |
 * | 视效（本模块） | **材质**：玻璃的折射/模糊/色散/高光 | `ieml.vfx` | 弱机、核显、老系统 |
 *
 * 两者**不联动**：可以"灵韵动效 + 弱化视效"（动画多、但材质便宜），
 * 也可以"减少动效 + 灵动视效"（不动，但玻璃是满血的）。合并成一个滑杆会让
 * "我只想要静一点的动画"变成"我的玻璃也得跟着降级" —— 那是两件事。
 *
 * ## 三档各自是什么
 *
 * | 档位 | 值 | 材质 |
 * |---|---|---|
 * | 弱化视效 | `weak` | **平玻璃**：半透明色打底，不做 `backdrop-filter`、不折射、无色散、无高光跟随 |
 * | 适中视效 | `mid` | 磨砂 + **缩放带折射** + 1px 色散 + 厚度内阴影 + 悬停高光跟随 + 按背景光斑调色 |
 * | 灵动视效 | `aura` | 在「适中」之上：**真折射**（SVG 镜片剖面，见 `glass.ts`）、高光自己在玻璃上缓慢流动、背景光斑换成 WebGL 流体 |
 *
 * ★ **为什么"真折射"只给灵动**：它靠 `backdrop-filter: url(#svg滤镜)`，
 *   是**最新、最贵**的一条渲染路径（真机探针见 `tools/live/probe-webview-glass.mjs`）。
 *   把它压在"已经要求 WebGL2 + 新系统"的那一档，等于**风险与门槛对齐**：
 *   老机器走 `mid` 时用的全是十年老 API（blur / 渐变 / 内阴影），不会因为
 *   某个 WebView2 版本不认 SVG 滤镜而变成一块糊掉的色块。
 *
 * ## 四条硬规矩
 *
 * ① **只在这里定义合法值**：坏值（老版本写的、手改 localStorage、类型不对）
 *    一律落回 `mid` —— **不猜、也不崩**（与 `motion.ts` 同一条）。
 * ② **能力说了算**：`aura` 只在"有真 WebGL2 + 不是老系统"时开放；
 *    存了 `aura` 但机器不够格 → **读出来就是 `mid`**，并带上人话原因。
 * ③ **本机偏好，存 localStorage**：同一份配置在台机上想要灵动、在核显本上想要弱化。
 * ④ **首屏之前就要施加**（见 `main.tsx`）：等 React 挂载再切，用户会先看一遍满血折射
 *    再被降级 —— 那一下闪烁比"一直弱"更难受。
 */

/** 三档（顺序就是界面上从左到右：材质越来越"厚"） */
export type VfxLevel = 'weak' | 'mid' | 'aura';

export const VFX_LEVELS: readonly VfxLevel[] = ['weak', 'mid', 'aura'] as const;

/** localStorage 的键 */
export const VFX_KEY = 'ieml.vfx';

/** 界面上的名字（用户给的三个词，原样用） */
export const VFX_LABEL: Record<VfxLevel, string> = {
  weak: '弱化视效',
  mid: '适中视效',
  aura: '灵动视效',
};

/** 每个档位**具体是什么材质** —— 写在设置页那一行下面，别让用户猜 */
export const VFX_HINT: Record<VfxLevel, string> = {
  weak: '平玻璃：只有半透明底色，不做背景模糊、不折射 —— 最省显卡',
  mid: '磨砂 + 边缘折射 + 厚度感；玻璃跟着底下光斑调色',
  aura: '在「适中」之上：真折射（镜片剖面）、背景换成流动的烟雾光斑；' +
    '窗口切到后台会自动停掉这些动画',
};

/* ====================== 能力探测（纯函数在前，方便测） ====================== */

export interface OsInfo {
  /** 界面显示用（"Windows 10/11" / "Windows 7" / "未知"） */
  name: string;
  /**
   * 是不是**老系统**（NT 6.x = Win7 / 8 / 8.1）。
   *
   * ★ 用户原话只点了 Win7，但 8 / 8.1 是同一代 WebView2 支持边界
   *   （都在 NT 6.x 上），把它们算作同一类不是"扩大化"，而是同一条判据。
   */
  legacy: boolean;
}

/**
 * 从 UA 里读系统版本（**纯函数**，测试用真 UA 串喂它）。
 *
 * ★ 为什么不问 Rust 要：档位要在**首屏之前**施加，而 `machine` 是异步命令；
 *   UA 是同步可得的。Rust 那边的系统信息用来做别的事（数据根选址等）。
 */
export function osFromUA(ua: string): OsInfo {
  const m = /Windows NT (\d+)\.(\d+)/.exec(ua);
  if (!m) {
    // 不是 Windows（或 UA 被改过）：不声称知道，也不要因此禁掉灵动 ——
    // 真禁掉靠的是 WebGL2 那条判据。
    return { name: '未知', legacy: false };
  }
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major === 6 && minor === 1) return { name: 'Windows 7', legacy: true };
  if (major === 6 && minor === 2) return { name: 'Windows 8', legacy: true };
  if (major === 6 && minor === 3) return { name: 'Windows 8.1', legacy: true };
  if (major === 10) return { name: 'Windows 10/11', legacy: false };
  if (major < 6) return { name: `Windows NT ${major}.${minor}`, legacy: true };
  return { name: `Windows NT ${major}.${minor}`, legacy: false };
}

/**
 * 这个渲染器名是不是**软件光栅化**（没有真显卡在干活）。
 *
 * ★ 为什么单列一条：WebGL2 上下文**在软渲染下也能创建成功**（Chromium 会走
 *   SwiftShader）。也就是说"`getContext('webgl2')` 返回了非空"**证明不了**显卡行 ——
 *   而用户的要求写的是"**显卡**不支持 WebGL 2.0"。软渲染下开灵动，
 *   结果是每帧几毫秒的 CPU 光栅化，比模糊还慢。
 */
export function isSoftwareRenderer(renderer: string | null | undefined): boolean {
  if (!renderer) return false;
  return /swiftshader|software|basic render|llvmpipe|microsoft basic/i.test(renderer);
}

export interface VfxCapability {
  /** 有没有 WebGL2 上下文（含软渲染 —— 见 `software`） */
  webgl2: boolean;
  /** 拿到手的渲染器名（`WEBGL_debug_renderer_info`，可能被浏览器屏蔽成 null） */
  renderer: string | null;
  /** 渲染器看起来是软件光栅化 */
  software: boolean;
  /** 系统信息（UA 解析） */
  os: OsInfo;
  /** 灵动档能不能开 */
  auraAllowed: boolean;
  /** 不能开时的**人话**原因（设置页直接显示这句话，别让用户猜） */
  reason: string | null;
}

/**
 * 由"原始探测结果"推出"灵动能不能开"（**纯函数**）。
 *
 * 判据三条，任一条不满足就不开放灵动：
 *   ① 有 WebGL2 上下文；
 *   ② 不是软件光栅化；
 *   ③ 不是老系统（Win7/8/8.1）。
 */
export function auraGate(raw: {
  webgl2: boolean;
  renderer: string | null;
  os: OsInfo;
}): { allowed: boolean; reason: string | null } {
  const software = isSoftwareRenderer(raw.renderer);
  if (!raw.webgl2) {
    return { allowed: false, reason: '这台机器的显卡（或驱动）不支持 WebGL 2.0，灵动视效开不了' };
  }
  if (software) {
    return {
      allowed: false,
      reason: `显卡没有在干活（Chromium 回落到软件渲染：${raw.renderer}），灵动视效会卡`,
    };
  }
  if (raw.os.legacy) {
    return { allowed: false, reason: `${raw.os.name} 上的 WebView2 太老，撑不住灵动视效` };
  }
  return { allowed: true, reason: null };
}

/** 最终档位的判定结果 */
export interface VfxDecision {
  /** 实际生效的档位 */
  level: VfxLevel;
  /** 用户选的档位存的是不是 `aura`，但被能力挡下来了 */
  clamped: boolean;
  /** 被挡下来的人话原因 */
  why: string | null;
}

function isLevel(v: string | null | undefined): v is VfxLevel {
  return v === 'weak' || v === 'mid' || v === 'aura';
}

/**
 * 由"存着的值 + 能力"推出"实际生效的档位"（**纯函数**，测试的主战场）。
 *
 * ★ 坏值不抛错、也不静默用 `weak`：落回 `mid`（默认档），因为"弱化"看起来像
 *   我们的玻璃坏了，而"适中"是设计过的正常样子。
 */
export function decideVfx(stored: string | null | undefined, cap: VfxCapability): VfxDecision {
  const want: VfxLevel = isLevel(stored) ? stored : 'mid';
  if (want === 'aura' && !cap.auraAllowed) {
    return { level: 'mid', clamped: true, why: cap.reason };
  }
  return { level: want, clamped: false, why: null };
}

/**
 * 这台机器的 `backdrop-filter` 认不认 `url(#svg滤镜)` —— 也就是**真折射**能不能做。
 *
 * ★ 为什么要单独探这一条（而不是看 `auraAllowed`）：这两件事**不是一回事**。
 *   `auraAllowed` 问的是"显卡够不够格跑灵动档"，而这一条问的是
 *   "这个 WebView2 版本的合成器认不认 SVG 滤镜"。理论上可以出现
 *   "有好显卡、但 WebView2 版本旧到不认 `url()`" —— 那时如果硬装滤镜，
 *   整条 `backdrop-filter` 声明会**失效**（连模糊一起没了），
 *   玻璃会从"磨砂"直接掉成"一块半透明色"，比不做折射还难看。
 *   所以装滤镜之前必须**直接问这一句**。
 *
 * 真机证据：`tools/live/probe-webview-glass.mjs`（本机 Chromium 153 上是 `true`，
 * 并且截图证明它真的扭了像素，不只是被解析）。
 */
export function supportsSvgBackdrop(): boolean {
  if (typeof CSS === 'undefined' || typeof CSS.supports !== 'function') return false;
  return CSS.supports('backdrop-filter', 'url(#x)');
}

/* ====================== 运行时（DOM） ====================== */

let cached: VfxCapability | null = null;

/** 探测一次能力（结果缓存；`probeWebgl:false` 用于测试/极早调用） */
export function detectVfxCapability(probeWebgl = true): VfxCapability {
  const os = osFromUA(typeof navigator === 'undefined' ? '' : navigator.userAgent);
  let webgl2 = false;
  let renderer: string | null = null;

  if (probeWebgl && typeof document !== 'undefined') {
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2') as WebGL2RenderingContext | null;
      if (gl) {
        webgl2 = true;
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        renderer = dbg
          ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL))
          : String(gl.getParameter(gl.RENDERER));
        // ★ 探完就还回去：别给 App 留一个多余的 GL 上下文
        //   （Chromium 同时活着的上下文有上限，超了会丢掉最早的那个 ——
        //    把用户真正的背景渲染器挤掉，症状是"背景忽然变黑"）。
        gl.getExtension('WEBGL_lose_context')?.loseContext();
      }
    } catch {
      webgl2 = false;
    }
  }

  const gate = auraGate({ webgl2, renderer, os });
  return {
    webgl2,
    renderer,
    software: isSoftwareRenderer(renderer),
    os,
    auraAllowed: gate.allowed,
    reason: gate.reason,
  };
}

/** 取能力（第一次调用时探测，之后走缓存） */
export function vfxCapability(): VfxCapability {
  if (!cached) cached = detectVfxCapability();
  return cached;
}

/** 读**用户存的那个档位**（不做能力校正；坏值落回 `mid`）。
 *
 *  ★ 为什么要和 `readVfx()` 分开：界面上要分得清两件事 ——
 *    「用户选的是什么」（`want`）与「实际生效的是什么」（`level`）。
 *    只留后者的话，**降级就变成了"用户的选择被悄悄改掉"**：
 *    设置页会显示"适中"被选中，而他明明选的是灵动，也没有任何说明
 *    （这正是这个项目的规矩里点名不许出现的那类行为）。
 */
export function storedVfx(): VfxLevel {
  const v = typeof localStorage === 'undefined' ? null : localStorage.getItem(VFX_KEY);
  return isLevel(v) ? v : 'mid';
}

/** 读本机选择的档位（**已经过能力校正**；没选过 / 值不合法 / 被挡 → `mid`） */
export function readVfx(): VfxDecision {
  return decideVfx(storedVfx(), vfxCapability());
}

/**
 * 把档位挂到 `<html data-vfx="…">` —— CSS 全靠这个属性分档。
 *
 * ★ 必须在**首屏之前**调一次（见 `main.tsx`）。
 */
export function applyVfx(level: VfxLevel): void {
  document.documentElement.dataset.vfx = level;
}

/** 写入 + 立即生效。★ 被能力挡住时**不写**用户的选择（存了也没用，读出来还是 mid） */
export function setVfx(level: VfxLevel): VfxDecision {
  const cap = vfxCapability();
  const decision = decideVfx(level, cap);
  localStorage.setItem(VFX_KEY, level);
  return decision;
}

/**
 * 关掉"当前正在生效"的档位 —— 用于**实时**把档位应用到界面上。
 *
 * 与应用时机无关：`main.tsx` 首屏前调一次，设置页改档时再调一次。
 */
export function currentVfx(): VfxLevel {
  const attr = document.documentElement.dataset.vfx;
  return isLevel(attr) ? attr : 'mid';
}
