/**
 * 版本的 **Java 要求**：唯一入口（含 Mojang 在版本 JSON 里声明的那个数）。
 * ------------------------------------------------------------------
 * ## 为什么需要这个文件
 *
 * 用户报的：「我的 26.2 给我显示要 java8，虽然游戏能打开，但这毕竟不对」。
 *
 * 根因是"需要哪个 Java"这件事被**抄了三份**手写判定
 * （`InstanceOverview` / `LaunchPage` / `bridge/tauri`），三份都只取
 * `mcVersion.split('.')[0]` 当 major —— 于是 `26.2` 的 major 是 26 而不是 1，
 * 所有 `major === 1 && …` 分支不成立，落到 `return 8`。
 * 那三份已经删掉了（`tests/domain.test.js` 里有守门测试，再出现就红）。
 *
 * ## 但只删掉副本还不够
 *
 * 规则引擎 `resolveJavaRequirement` 里有一条是
 * 「Mojang 在版本 JSON 里写的 `javaVersion.majorVersion`」（26.2 写的是 25）。
 * 那个数**只有版本 JSON 里有**，前端拿不到 —— 于是 26.2 只能算到基线规则
 * 给的 21，而真相是 25。也就是"修好了显示 8，但显示成了 21"，仍然是错的。
 *
 * 所以这里**从后端把那个数取过来**（`metadata.version()` 一直在返回
 * `java_major`，但在此之前全仓库**没有任何地方调用过它**）。
 *
 * ## ★ 这个文件是**纯的**（不 import React、不 import bridge）
 *
 * 本项目的铁律是 `domain/` 不许有 I/O（见 `domain/mod.rs` 的说明）。
 * React hook 与后端调用放在 `hooks/useJavaRequirement.ts`，
 * 它只是把这里的缓存填上。这样：
 *   · `node --test` 能直接跑这里的函数（不需要 DOM、不需要 Tauri）；
 *   · 领域层继续保持可单测。
 *
 * ## 为什么不把 900 个版本的 javaVersion 一次全塞进清单
 *
 * 那要多拉 900 份版本 JSON。这里按**需要**取：用户在看哪个版本/哪个实例，
 * 才取哪一个；结果缓存在内存 + localStorage。
 * 版本 JSON 的 `javaVersion` 是**发布时定死的**，不会变，所以缓存无过期问题。
 */
import { resolveJavaRequirement, type JavaConstraintInput, type JavaRequirement } from './java.ts';
import type { BaseLoaderKind } from './types.ts';

/**
 * 版本 JSON 里 Mojang 声明的 Java 主版本。
 *
 * 用 `0` 表示"查过了，Mojang 没写" —— 规则引擎里那条**只在 >= 22 时采信**，
 * 传 0 是安全的（不会把区间弄坏，只是按版本号基线算）。
 * 而"还没查到"用 **根本不在 map 里** 表达，两者必须分开：
 * 把"还没查到"当成"没有"会让显示在加载过程中闪一下错误的值。
 */
type DeclaredMap = Record<string, number>;

const LS_KEY = 'ieml.mojangJava.v1';

const memory: DeclaredMap = (() => {
  try {
    // 非浏览器环境（`node --test`）下没有 localStorage —— 只用内存那份
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: DeclaredMap = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
      }
      return out;
    }
  } catch {
    /* 脏数据当没存过 —— 不能让它把启动搞崩 */
  }
  return {};
})();

/** 已查到的声明值；`undefined` = **还没查**（不等于"没有"） */
export function declaredJavaOf(mcVersion: string): number | undefined {
  if (!mcVersion) return undefined;
  return memory[mcVersion];
}

/**
 * 把后端取回来的声明值记进缓存。
 *
 * ★ 返回 `true` 表示**这次真的写进去了**（值变了）—— 调用方据此决定要不要
 *   触发重渲染。重复写同一个值不该引起无限渲染。
 */
export function rememberDeclaredJava(mcVersion: string, declared: number): boolean {
  if (!mcVersion) return false;
  if (memory[mcVersion] === declared) return false;
  memory[mcVersion] = declared;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(LS_KEY, JSON.stringify(memory));
    }
  } catch {
    /* 存不进去也不影响这次会话 */
  }
  return true;
}

export interface JavaReqInput {
  mcVersion: string;
  /**
   * ★★ 加载器种类（`forge` / `neoforge` / `fabric` / `quilt` / null）**与它的版本号**。
   *
   * 为什么要给规则引擎（P0-7）：PCL 的 `ModJava.vb` 里有一批规则**按加载器
   * 自身的版本分段**，只看游戏版本号推不出来：
   *   · Forge 34.0.0~36.2.25 最高 Java 8 / 36.2.26+ 最高 23 /
   *     37.0.0~37.0.79 最高 16 / 45.0.21~45.0.65 最高 19 / 45.0.66~47.4.8 最高 21；
   *   · Fabric Loader < 0.17.0 的 Mixin/ASM 不兼容 Java 25。
   *
   * 不给的话，界面算出来的"需要 Java 几"会与**启动时真正用的那个**不一样
   * （启动走 Rust，它现在拿得到这些字段）。
   */
  loaderKind?: string | null;
  loaderVersion?: string | null;
  /** 兼容入口：直接说"是不是 Forge 系"（不传时由 `loaderKind` 推出） */
  hasForgeLike?: boolean;
  /** Mod 数量（影响 MODDED 那几条约束） */
  modCount?: number;
  hasOptifine?: boolean;
  /**
   * Mojang 在版本 JSON 里声明的 Java 主版本。
   *
   * 不传时自动从缓存读。显式传 `undefined` 与不传等价 —— 都表示"按版本号基线算"。
   */
  declaredJava?: number;
}

/**
 * ★★ 把「这个实例 / 这次要装的组合」翻译成规则引擎的输入 ——
 * **字段映射只在这一处做**（与 Rust 的 `JavaConstraintInput::with_loader` 同名同义）。
 *
 * 之所以要收成一处：调用点有三个（实例概览、实例设置、安装配置器），
 * 每个都手写一遍 `hasForgeLike: kind === 'forge' || kind === 'neoforge'`
 * 这种映射，就一定会有一处忘了带版本号 —— 而"忘了带"的表现是
 * **界面显示的 Java 要求与启动时的要求不一致**，用户只会觉得"这软件在骗我"。
 */
export function toEngineInput(
  input: JavaReqInput,
  declaredFallback: number | undefined,
): JavaConstraintInput {
  const declared = input.declaredJava ?? declaredFallback;
  const kind = input.loaderKind ?? null;
  const isForge = kind === 'forge';
  const isNeo = kind === 'neoforge';
  const isFabric = kind === 'fabric'; // ★ Quilt 不算 Fabric，理由见 Rust `with_loader`
  const version = input.loaderVersion ?? null;

  return {
    mcVersion: input.mcVersion,
    hasForgeLike: input.hasForgeLike ?? (isForge || isNeo),
    forgeKind: isForge || isNeo ? (kind as 'forge' | 'neoforge') : null,
    forgeVersion: isForge || isNeo ? version : null,
    fabricVersion: isFabric ? version : null,
    modCount: input.modCount ?? 0,
    hasOptifine: input.hasOptifine ?? false,
    /*
     * 规则引擎里那条**只在 >= 22 时采信**，所以"没声明"传 0 是安全的 ——
     * 它不会把区间弄坏，只是暂时按版本号基线算。
     */
    mojangJavaVersion: declared ?? 0,
  };
}

/**
 * ★★ **算一个版本的 Java 要求 —— 界面上所有地方都用它。**
 *
 * 同步、纯函数（读一份模块级缓存）。首次渲染立刻有值，不会白屏等网络。
 */
export function javaRequirementFor(input: JavaReqInput): JavaRequirement {
  return resolveJavaRequirement(toEngineInput(input, declaredJavaOf(input.mcVersion)));
}

/** 加载器种类 → `hasForgeLike`（只有一个地方做这个映射） */
export function forgeLikeOf(kind: BaseLoaderKind | null | undefined): boolean {
  return kind === 'forge' || kind === 'neoforge';
}

/** 便于测试：清空缓存 */
export function __resetDeclaredJavaCache() {
  for (const k of Object.keys(memory)) delete memory[k];
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(LS_KEY);
  } catch {
    /* ignore */
  }
}
