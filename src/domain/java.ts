/**
 * Java 运行时选择（ADR-013 / ADR-030）
 * ------------------------------------------------------------------
 * 源码事实（源码研读 12.6）：不是简单的"MC 版本 → Java 版本"查表，而是
 * **13 条带优先级的约束规则**，并且 `MODDED_JAVA_*` 规则**只在装了 Forge 时生效**。
 * 这是原设计稿漏掉的关键分叉。
 */
import type { JavaRange, JavaMode } from './types.ts';
import { compareVersion } from './version.ts';

/* ====================== Java 环境实体 ====================== */

export type JavaSourceKind = 'system' | 'downloaded' | 'instance' | 'manual';

export interface JavaRuntime {
  /** 可执行文件绝对路径 */
  path: string;
  /** 主版本，如 17 / 21 / 8 */
  major: number;
  /** 完整版本串，如 17.0.10 */
  version: string;
  vendor: string;
  arch: 'x64' | 'arm64' | 'x86';
  source: JavaSourceKind;
  /** 官方 Java（Oracle JDK）在启动器里默认禁用（源码事实） */
  disabledByDefault?: boolean;
  /** 该运行时占用的磁盘字节数，0 表示未知 */
  bytes?: number;
}

/* ====================== 约束规则 ====================== */

export interface JavaConstraintInput {
  mcVersion: string;
  /** 是否装了 Forge 系（Forge / NeoForge）—— 决定 MODDED 规则是否生效 */
  hasForgeLike: boolean;
  /** 具体是哪个（决定 Forge 的老版本上限规则） */
  forgeKind?: 'forge' | 'neoforge' | null;
  /** Forge / NeoForge 自身的版本号，如 `65.1.3` */
  forgeVersion?: string | null;
  /** Fabric Loader 版本，如 `0.19.5`（0.17.0 之前不兼容 Java 25） */
  fabricVersion?: string | null;
  /** Mod 数量 */
  modCount: number;
  /** 是否有 OptiFine */
  hasOptifine: boolean;
  /**
   * ★★ **Mojang 在版本 JSON 里写的 `javaVersion.majorVersion`。**
   *
   *   这是本文件最重要的一处修正（2026-09-14，用户报
   *   「Forge 版 mc 还没打开就报错崩溃」）：
   *
   *   实测 `26.2` 的版本 JSON 写着 `"javaVersion": {"majorVersion": 25}`,
   *   而**启动器一直没读过这个字段** —— 它只用一张写死的表判断
   *   `>= 1.20.5 → Java 21`。于是 26.2 被交给了 Java 21，
   *   而 Forge 65.1.3 的 profile 里有 `-XX:+UseCompactObjectHeaders`
   *   （Java 24 才有），Java 21 直接拒绝：
   *     `Unrecognized VM option 'UseCompactObjectHeaders'`
   *     `Error: Could not create the Java Virtual Machine.`
   *   游戏**连一行日志都没来得及写**就没了。
   *
   *   PCL 的做法（`ModJava.vb` 第 173-185 行，读的是同一份源码）：
   *     `If RecommendedCode >= 22 Then AddConstraint(AtLeast(RecommendedCode))`
   *   —— 也就是"**Mojang 说了算，而且只在这个值 >= 22 时才用它**"
   *   （更小的值交给版本号规则，避免老版本 JSON 里写错的数字把区间弄坏）。
   */
  mojangJavaVersion?: number | null;
  /**
   * 该版本是不是"非标准版本"（快照/无法解析的版本号）。
   * PCL 对这类版本会放宽或跳过一部分规则。
   */
  isNonStandard?: boolean;
}

export interface JavaRequirement {
  /** 建议的主版本（= 区间内可用的最高版本，没有可用 Java 时为区间下限） */
  major: number;
  /** 允许区间（由多条约束**求交集**得出，见下） */
  range: JavaRange;
  /** 面向用户的一句话理由（禁止"不兼容"三个字，要给具体原因） */
  reason: string;
  /** 命中的规则 id，便于调试与测试 */
  rule: string;
  /**
   * ★ 每条约束的来历（`[{rule, range, why}]`）。
   *   界面要能一条条显示"为什么是这个范围"，而不是只给一个结论。
   */
  constraints: JavaConstraint[];
}

/** 单条约束的来历 */
export interface JavaConstraint {
  rule: string;
  range: JavaRange;
  why: string;
}

/**
 * ★★ **约束是"求交集"，不是"第一条命中就返回"。**
 *
 *   这条是照着 PCL 的 `GetJavaRequirement`（`ModJava.vb` 128-265 行）
 *   重写的。老实现是"规则表从上往下，第一条命中的胜出" ——
 *   那种写法把"下限"和"上限"混成了一个区间，于是：
 *     · `>= 1.20.5 → [21, 24)` 这条会对 26.2 生效；
 *     · 而 26.2 真正需要的是 `>= 25`（Mojang 在 JSON 里写了）；
 *     · 两者的交集被丢掉了，最后选到 Java 21 —— Forge 直接起不来。
 *
 *   现在是：每条规则**往一个总区间上求交**，谁都不能覆盖谁。
 *   交集为空时（现实里真的有，例如"1.12 + 某个新 Forge"）
 *   **不能沉默**：要报出来，让用户去手动指定 Java。
 */

/** 区间工具（与 PCL 的 `ValueRange` 对应） */
const ALL: JavaRange = { min: null, max: null, minInclusive: true, maxInclusive: true };

const atLeast = (v: number): JavaRange => ({
  min: v,
  max: null,
  minInclusive: true,
  maxInclusive: true,
});
const lessThan = (v: number): JavaRange => ({
  min: null,
  max: v,
  minInclusive: true,
  maxInclusive: false,
});
const closedOpen = (a: number, b: number): JavaRange => ({
  min: a,
  max: b,
  minInclusive: true,
  maxInclusive: false,
});
const atMost = (v: number): JavaRange => ({
  min: null,
  max: v,
  minInclusive: true,
  maxInclusive: true,
});

/**
 * 两个区间求交。空集返回 `null`。
 *
 * ★ 边界语义：`min` 取**更严**的那个，`max` 也取更严的那个；
 *   相等时要看是不是有开区间（`[17,20)` ∩ `(17,22]` 是空的）。
 */
export function intersectRange(a: JavaRange, b: JavaRange): JavaRange | null {
  let min = a.min;
  let minInclusive = a.minInclusive;
  if (b.min !== null && (min === null || b.min > min)) {
    min = b.min;
    minInclusive = b.minInclusive;
  } else if (b.min !== null && min !== null && b.min === min) {
    minInclusive = a.minInclusive && b.minInclusive;
  }

  let max = a.max;
  let maxInclusive = a.maxInclusive;
  if (b.max !== null && (max === null || b.max < max)) {
    max = b.max;
    maxInclusive = b.maxInclusive;
  } else if (b.max !== null && max !== null && b.max === max) {
    maxInclusive = a.maxInclusive && b.maxInclusive;
  }

  if (min !== null && max !== null) {
    if (min > max) return null;
    if (min === max && !(minInclusive && maxInclusive)) return null;
  }
  return { min, max, minInclusive, maxInclusive };
}

/** 把 `>= x` 这类下限换算成"这个区间里最小的整数主版本" */
export function rangeFloor(r: JavaRange): number {
  return r.min ?? 8;
}

/** 区间里是否可能取到某个主版本 */
export function rangeAllows(r: JavaRange, major: number): boolean {
  return inJavaRange(major, r);
}

/** 规则名容易和"命中 id"混淆，这里给一个空输入的默认值 */
export function defaultJavaInput(): JavaConstraintInput {
  return {
    mcVersion: '1.20.1',
    hasForgeLike: false,
    modCount: 0,
    hasOptifine: false,
  };
}

/**
 * ★★ 计算该实例应使用的 Java 要求（**照 PCL 的算法逐条搬过来**）。
 *
 * 来源：`E:\PCL-main\Plain Craft Launcher 2\Modules\Minecraft\ModJava.vb`
 *      的 `GetJavaRequirement`（128-265 行）。每条规则下面都写了行号，
 *      改的时候可以直接对着源码看。
 *
 * ★ 与原版的差异（都是"我们没那个信息，就说没那个信息"，不猜）：
 *   · PCL 用 `ReleaseTime`（版本发布时间）判断"非标准版本"该按哪条走；
 *     我们只在拿得到 `mojangJavaVersion` 时才用它，否则保持版本号规则。
 *   · PCL 的 "modCount" 类规则（他自己的整合包启发式）我们保留在最后，
 *     且**只收紧下限，不设上限** —— 见下面 `MODDED_*` 的说明。
 */
export function resolveJavaRequirement(input: JavaConstraintInput): JavaRequirement {
  const constraints: JavaConstraint[] = [];
  let range: JavaRange = ALL;

  const add = (rule: string, r: JavaRange, why: string) => {
    const next = intersectRange(range, r);
    if (next === null) {
      /*
       * 交集为空 —— **必须报出来**，不能沉默。
       *
       * 现实里会出现：例如"1.12 的 Forge"要求 < Java 9，
       * 而某条别的要求又写了 >= 17。这时候没有可用的 Java，
       * 用户需要知道**是哪两条打架了**，才能去手动指定。
       */
      violated.push({ rule, range: r, why });
      return;
    }
    range = next;
    constraints.push({ rule, range: r, why });
  };

  const violated: JavaConstraint[] = [];
  const mc = input.mcVersion;

  /* ---------- ① 原版基线（ModJava.vb 152-171） ---------- */
  if (!input.isNonStandard && compareVersion(mc, '1.20.5') >= 0) {
    // 1.20.5+（24w14a+）：至少 Java 21
    add('MC_1_20_5_PLUS', atLeast(21), `${mc} 的官方基线是 Java 21（Mojang 从 1.20.5 起提高）`);
  } else if (!input.isNonStandard && compareVersion(mc, '1.18') >= 0) {
    add('MC_1_18_PLUS', atLeast(17), `${mc} 的官方基线是 Java 17`);
  } else if (!input.isNonStandard && compareVersion(mc, '1.17') >= 0) {
    add('MC_1_17', atLeast(16), `${mc} 是 Java 16 → 17 的过渡版本`);
  } else if (!input.isNonStandard && compareVersion(mc, '1.12') >= 0 && compareVersion(mc, '1.16.5') <= 0) {
    add('MC_1_12_TO_1_16', atLeast(8), `${mc} 的官方基线是 Java 8`);
    /*
     * ★★ 还要一条**上限** —— 光有下限不够，这是实测出来的。
     *
     *   把规则从"第一条命中"改成"求交集"之后，基线规则只剩 `>= 8`，
     *   于是**纯原版 1.12.2 在区间上允许 Java 25**。
     *   而 1.12.2 跑 Java 25 是"能起、能进世界、随时崩"的组合。
     *
     *   用户的要求是「无论什么加载器还是原版，你至少都得让玩家能玩」——
     *   所以有 Java 8 可用的机器上，就不该给 1.12 派一个 Java 25。
     *
     *   PCL 在纯原版这条路径上只写下限（`ModJava.vb` 165-167），
     *   但它会给 Forge / OptiFine 补上限。我们把上限**统一加上**，
     *   因为保守组合（老版本配老 Java）最不容易出事。
     */
    add(
      'MC_LEGACY_MAX_JAVA',
      lessThan(12),
      '1.12 ~ 1.16.5 是 Java 8 时代的版本，用更新的 Java 容易起不来',
    );
  } else if (compareVersion(mc, '1.5.2') <= 0) {
    add('MC_LEGACY_MAX8', lessThan(9), `${mc} 属于老版本，最高只能用到 Java 8`);
  }

  /* ---------- ② Mojang 自己写的 javaVersion（ModJava.vb 173-185） ---------- */
  const rec = input.mojangJavaVersion ?? 0;
  if (rec >= 22) {
    /*
     * ★ 只在这个值 >= 22 时才采信。
     *   PCL 也是这么写的 —— 老版本 JSON 里这个字段可能是错的/过期的，
     *   盲目采信会把区间弄坏。>= 22 意味着"Mojang 明确要求了一个新版本"，
     *   那一定是有原因的（26.2 就要求 25）。
     */
    add(
      'MOJANG_JAVA_VERSION',
      atLeast(rec),
      `这个版本的描述文件里写着需要 Java ${rec}（Mojang 自己的声明）`,
    );
  }

  /* ---------- ③ OptiFine（ModJava.vb 187-199） ---------- */
  if (input.hasOptifine) {
    if (compareVersion(mc, '1.7') < 0) {
      add('OPTIFINE_MAX8', lessThan(9), 'OptiFine 在 1.7 之前的版本依赖 Java 8 的图形接口');
    } else if (
      compareVersion(mc, '1.8') >= 0 &&
      compareVersion(mc, '1.11.2') <= 0
    ) {
      add('OPTIFINE_EXACT8', closedOpen(8, 9), 'OptiFine 在 1.8 ~ 1.11 上必须用 Java 8');
    } else if (compareVersion(mc, '1.12') >= 0 && compareVersion(mc, '1.12.2') <= 0) {
      add('OPTIFINE_MAX8_112', lessThan(9), 'OptiFine 在 1.12 上最高只能用到 Java 8');
    } else if (compareVersion(mc, '1.16.5') <= 0) {
      add('OPTIFINE_MAX8_116', lessThan(9), 'OptiFine 在 1.16.5 及更早版本上依赖 Java 8');
    }
  }

  /* ---------- ④ Forge（ModJava.vb 201-234） ---------- */
  if (input.hasForgeLike && input.forgeKind !== 'neoforge') {
    const fv = input.forgeVersion ?? '';
    const forgeAtLeast = (v: string) => fv !== '' && compareVersion(fv, v) >= 0;
    const forgeAtMost = (v: string) => fv !== '' && compareVersion(v, fv) >= 0;

    if (
      compareVersion(mc, '1.6.1') >= 0 &&
      compareVersion(mc, '1.7.2') <= 0
    ) {
      add('FORGE_1_6_TO_1_7_2', closedOpen(7, 8), 'Forge 在 1.6.1 ~ 1.7.2 上必须用 Java 7');
    } else if (compareVersion(mc, '1.12.2') <= 0) {
      add('FORGE_LE_1_12', lessThan(9), `Forge 在 ${mc} 上最高只能用到 Java 8`);
    } else if (compareVersion(mc, '1.14.4') <= 0) {
      add('FORGE_1_13_TO_1_14', closedOpen(8, 11), 'Forge 在 1.13 ~ 1.14 上只能用到 Java 8 ~ 10');
    } else if (compareVersion(mc, '1.15.2') <= 0) {
      add('FORGE_1_15', closedOpen(8, 16), 'Forge 在 1.15 上只能用到 Java 8 ~ 15');
    } else if (forgeAtLeast('34.0.0') && forgeAtMost('36.2.25')) {
      add('FORGE_1_16_OLD', atMost(8), 'Forge 34.0.0 ~ 36.2.25（1.16.3~5）最高只支持 Java 8u320');
    } else if (forgeAtLeast('36.2.26') && forgeAtMost('37.0.0')) {
      add('FORGE_1_16_NEW', lessThan(24), 'Forge 36.2.26+（1.16.5）最高只支持到 Java 23');
    } else if (forgeAtLeast('37.0.0') && forgeAtMost('37.0.79')) {
      add('FORGE_1_17_1', lessThan(17), 'Forge 37.0.0 ~ 37.0.79（1.17.1）最高只支持到 Java 16');
    } else if (compareVersion(mc, '1.18') >= 0 && compareVersion(mc, '1.18.2') <= 0 && input.hasOptifine) {
      add('FORGE_1_18_OPTIFINE', lessThan(19), '1.18 的 Forge 搭配 OptiFine 时最高只支持到 Java 18');
    } else if (forgeAtLeast('45.0.21') && forgeAtMost('45.0.65')) {
      add('FORGE_1_19_4_OLD', lessThan(20), 'Forge 45.0.21 ~ 45.0.65（1.19.4）最高只支持到 Java 19');
    } else if (forgeAtLeast('45.0.66') && forgeAtMost('47.4.8')) {
      add('FORGE_1_19_4_TO_1_20_1', lessThan(22), 'Forge 45.0.66 ~ 47.4.8（1.19.4 ~ 1.20.1）最高只支持到 Java 21');
    }
    /*
     * ★★ 新版 Forge（47.4.8 之后 / 1.20.2+）**不设上限**。
     *
     *   老实现有一条 `MODDED_JAVA_21 → range [17,22)`，对 26.2 + Forge 65.1.3
     *   来说就是致命的：它把 Java 25 挡在外面，于是只能选 Java 21，
     *   而 Forge 65 的 profile 里有 `-XX:+UseCompactObjectHeaders`（Java 24+）。
     *   结果就是用户遇到的"还没打开就崩溃"。
     */
  }

  /* ---------- ⑤ NeoForge（ModJava.vb 236-243） ---------- */
  if (input.forgeKind === 'neoforge') {
    const nv = input.forgeVersion ?? '';
    const is1201 = compareVersion(mc, '1.20.1') >= 0 && compareVersion(mc, '1.20.1') <= 0;
    const early1202 =
      nv !== '' && compareVersion('20.2.62-beta', nv) >= 0 && !nv.includes('25w14craftmine');
    if (is1201 || early1202) {
      add('NEOFORGE_1_20_1', lessThan(22), 'NeoForge 在这个版本段上最高只支持到 Java 21');
    }
  }

  /* ---------- ⑥ Fabric（ModJava.vb 245-259） ---------- */
  if (input.fabricVersion !== null && input.fabricVersion !== undefined) {
    if (compareVersion(mc, '1.15') >= 0 && compareVersion(mc, '1.16.5') <= 0) {
      add('FABRIC_1_15_1_16', atLeast(8), 'Fabric 在 1.15 ~ 1.16 上至少需要 Java 8');
    } else if (compareVersion(mc, '1.18') >= 0) {
      add('FABRIC_1_18_PLUS', atLeast(17), 'Fabric 在 1.18 及以上至少需要 Java 17');
    }
    const fv = input.fabricVersion;
    if (fv !== '' && compareVersion(fv, '0.17.0') < 0) {
      /*
       * ★ Fabric Loader 0.17.0 之前的 Mixin/ASM 不兼容 Java 25。
       *
       *   实测本机的 Fabric 是 0.19.5 —— **不受这条限制**，所以它可以用
       *   Mojang 要求的 Java 25。这条留着是为了老实例（0.16.x）不出事。
       */
      add(
        'FABRIC_LOADER_OLD',
        lessThan(25),
        `Fabric Loader ${fv} 的 Mixin/ASM 还不兼容 Java 25（0.17.0 起才支持）`,
      );
    }
  }

  /* ---------- ⑦ 大量 Mod 的启发式（我们自己的，只收紧下限） ---------- */
  if (input.hasForgeLike && input.modCount >= 120) {
    add(
      'MODDED_MANY_MODS',
      atLeast(17),
      `装了 ${input.modCount} 个 Mod，Java 17 及以上对大量 Mod 的类加载更稳定`,
    );
  }

  /* ---------- 收尾：算出建议版本与理由 ---------- */
  const major = rangeFloor(range);
  const parts: string[] = constraints.map((c) => c.why);

  let reason: string;
  if (violated.length > 0) {
    reason =
      `Java 版本要求互相冲突 —— ${violated.map((v) => v.why).join('；')}。` +
      `请在实例设置里手动指定一个 Java 试试`;
  } else if (parts.length === 0) {
    reason = `没有特别的 Java 要求，用任意可用的 Java 即可`;
  } else {
    reason = parts.join('；');
  }

  return {
    major,
    range,
    reason,
    rule: constraints.length > 0 ? constraints[0]!.rule : 'NO_CONSTRAINT',
    constraints,
  };
}

/* ====================== 给界面用的那一个数字 ====================== */

/**
 * ★★ **界面显示"这个版本需要 Java 几"只能用这一个函数。**
 *
 * ## 为什么必须收敛成一处（实测踩到的 bug）
 *
 * 用户报的：「我的 26.2 给我显示要 java8，虽然游戏能打开，但这毕竟不对」。
 *
 * 根因：`1.20.5+ → Java 21 / 1.17+ → Java 17 / 其余 → Java 8` 这条老逻辑
 * 被**抄了三份**，散在三个文件里：
 *
 *   `pages/InstanceOverview.tsx` · `pages/LaunchPage.tsx` · `bridge/tauri.ts`
 *
 * 三份都只取 `mcVersion.split('.')[0]` 当 major，于是 `26.2` 的 major 是
 * **26 而不是 1** → 所有 `major === 1 && …` 的分支全部不成立 → 落到最后
 * 那个 `return 8`。**26.2 就显示成"需要 Java 8"。**
 *
 * 而启动路径没坏，是因为 Rust 侧以版本 JSON 里的 `javaVersion` 为准
 * （见 `commands_real.rs` 的说明），前端传的那个数只当兜底 ——
 * 所以用户看到的是"游戏能打开，但显示不对"。
 *
 * ## 判据
 *
 * 用 `resolveJavaRequirement`（13 条约束求交集，与 Rust 的
 * `domain::java` 同一套规则），**没有再写一遍**。
 *
 * ★ 不要"顺手优化"成查表：`26.2` 这种两位数主版本号、快照、以及
 *   Mojang 在 JSON 里声明的 Java 要求，都是查表表达不了的。
 */
export function displayJavaMajor(input: JavaConstraintInput): number {
  return resolveJavaRequirement(input).major;
}

/* ====================== 从候选里挑一个 ====================== */

export interface JavaPickResult {
  runtime: JavaRuntime | null;
  /** 为什么选它 / 为什么一个都没选中 */
  reason: string;
  requirement: JavaRequirement;
  /** 命中了要求的候选 */
  candidates: JavaRuntime[];
}

/** 按四模式挑选 Java */
export function pickJava(
  mode: JavaMode,
  runtimes: JavaRuntime[],
  input: JavaConstraintInput,
  opts: { range?: JavaRange; path?: string; instanceJavaDir?: string } = {},
): JavaPickResult {
  const req = resolveJavaRequirement(input);

  switch (mode) {
    case 'path': {
      const found = runtimes.find((r) => r.path === opts.path);
      if (!found) {
        return { runtime: null, reason: `指定的 Java 已不存在：${opts.path ?? '(未指定)'}`, requirement: req, candidates: [] };
      }
      return { runtime: found, reason: `使用你手动指定的 ${found.vendor} ${found.version}`, requirement: req, candidates: [found] };
    }

    case 'instance-folder': {
      const dir = opts.instanceJavaDir;
      const found = runtimes.find(
        (r) => r.source === 'instance' && (!dir || r.path.startsWith(dir)),
      );
      if (!found) {
        return {
          runtime: null,
          reason: '实例文件夹里没有找到 Java —— 整合包自带 Java 的话，请确认 java 目录存在',
          requirement: req,
          candidates: [],
        };
      }
      return { runtime: found, reason: `使用实例文件夹中的 ${found.version}`, requirement: req, candidates: [found] };
    }

    case 'range': {
      const range = opts.range;
      if (!range) {
        return { runtime: null, reason: '未填写区间', requirement: req, candidates: [] };
      }
      const inside = runtimes.filter((r) => inJavaRange(r.major, range));
      if (inside.length === 0) {
        return {
          runtime: null,
          reason: `没有满足区间 ${formatJavaRange(range)} 的 Java，请调整区间或安装对应版本`,
          requirement: req,
          candidates: [],
        };
      }
      const best = inside.reduce((a, b) => (b.major > a.major ? b : a));
      return {
        runtime: best,
        reason: `区间内最高版本：${best.version}`,
        requirement: req,
        candidates: inside,
      };
    }

    case 'auto':
    default: {
      const usable = runtimes.filter((r) => !r.disabledByDefault);
      /*
       * ★★ 自动模式：**取区间内可用的最高版本**，不是"先找等于 major 的"。
       *
       *   老实现先找 `major === req.major` 的精确命中，找不到才退而求其次。
       *   问题出在 `req.major` 原来是"建议版本"，而 26.2 的建议版本是 21、
       *   需求区间却是 `>= 25` —— 两者本来就是矛盾的（老规则表的锅）。
       *
       *   区间才是**真正的约束**；"建议版本"只是为了显示。
       *   所以：先看区间里有什么，从高往低挑。
       *   26.2 + Forge 65.1.3 的区间是 `>= 25` → 挑到 Java 25 → 能起来。
       */
      const inside = usable.filter((r) => inJavaRange(r.major, req.range));
      if (inside.length > 0) {
        const best = inside.reduce((a, b) =>
          compareVersion(b.version, a.version) > 0 ? b : a,
        );
        const exact = best.major === req.major;
        return {
          runtime: best,
          reason: exact
            ? `${req.reason}；已匹配到 ${best.vendor} ${best.version}`
            : `${req.reason}；区间 ${formatJavaRange(req.range)} 内最高可用的是 ${best.vendor} ${best.version}`,
          requirement: req,
          candidates: inside,
        };
      }
      return {
        runtime: null,
        reason:
          `没有找到符合要求的 Java —— ${req.reason}；` +
          `需要 ${formatJavaRange(req.range)} 之间的版本`,
        requirement: req,
        candidates: [],
      };
    }
  }
}

/* ====================== 工具 ====================== */

export function inJavaRange(major: number, r: JavaRange): boolean {
  if (r.min !== null && (r.minInclusive ? major < r.min : major <= r.min)) return false;
  if (r.max !== null && (r.maxInclusive ? major > r.max : major >= r.max)) return false;
  return true;
}

/**
 * 区间 → 人话。
 *
 * ★ 无界的一侧用**圆括号**，例如 `[17, )` / `(, 9)`。
 *   以前直接用 `maxInclusive` 决定方括号 —— 而 `atLeast(17)` 这类区间的
 *   `maxInclusive` 字段是 `true`（它只是"没设上限"），于是会打印成
 *   `[17, ]`：**看着像闭合区间，其实是无穷**。
 *
 *   与 Rust 的 `VersionRange::format()` **逐字一致**
 *   （`tests/java-rules.cases.json` 两侧共用，改一边就红）。
 */
export function formatJavaRange(r: JavaRange): string {
  const left = r.min !== null && r.minInclusive ? '[' : '(';
  const right = r.max !== null && r.maxInclusive ? ']' : ')';
  return `${left}${r.min ?? ''}, ${r.max ?? ''}${right}`;
}

/**
 * 把用户输入的区间串解析成 JavaRange（供 UI 调用）。
 * 复用 version.ts 的 parseRange，这里只做 Java 语境下的额外校验。
 */
export function validateJavaRangeText(text: string): { ok: true; range: JavaRange; hint?: string } | { ok: false; error: string } {
  const t = text.trim();
  const m = /^([[(])\s*([\d.]*)\s*,\s*([\d.]*)\s*([\])])$/.exec(t);
  if (!m) {
    return {
      ok: false,
      error: '格式形如 [17.0, 22.0) —— 方括号含该值、圆括号不含，留空一侧表示不限制',
    };
  }
  const left = m[1] ?? '[';
  const minRaw = m[2] ?? '';
  const maxRaw = m[3] ?? '';
  const right = m[4] ?? ')';
  const min: number | null = minRaw === '' ? null : Number(minRaw);
  const max: number | null = maxRaw === '' ? null : Number(maxRaw);
  if (min !== null && Number.isNaN(min)) return { ok: false, error: '下限不是合法数字' };
  if (max !== null && Number.isNaN(max)) return { ok: false, error: '上限不是合法数字' };
  if (min === null && max === null) return { ok: false, error: '两侧都不限制时，请直接用「自动选择」' };
  if (min !== null && max !== null) {
    if (min > max) return { ok: false, error: `下限 ${min} 大于上限 ${max}` };
    // 空区间必须给出可操作的建议，而不是只说"格式不对"
    if (min === max && (left === '(' || right === ')')) {
      return {
        ok: false,
        error: `(${min}, ${max}) 是空区间（开区间两端相等，什么都选不到）。如果只想允许 Java ${min}，请写 [${min}, ${min}]`,
      };
    }
  }
  const range: JavaRange = { min, max, minInclusive: left === '[', maxInclusive: right === ']' };
  let hint: string | undefined;
  if (max !== null && range.maxInclusive && Number.isInteger(max)) {
    hint = `如果不想允许 Java ${max}，请改为 ${max})；如果想允许，请改为 ${max + 1})`;
  }
  return { ok: true, range, hint };
}
