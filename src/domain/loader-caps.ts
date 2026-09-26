/**
 * 加载器能力表 —— 从各版本的真实支持情况生成 LoaderCapabilities
 * ------------------------------------------------------------------
 * 数据依据：docs/LAUNCHER_SOURCE_STUDY.md 的源码研读结论 + PCL2 ModComp 行为。
 *
 * 铁律（违反即 UI 会骗人）：
 *   ① 不可用必须给**具体理由**，不允许静默隐藏（ADR-004）
 *   ② NeoForge 只从 1.20.2 开始（1.20.1 及以下没有）
 *   ③ LiteLoader 只能作 Forge 的附加组件，且仅 1.7.10 ~ 1.12.2
 *   ④ OptiFine 可独立装在纯原版上（走自带的 Patcher 打补丁）
 *   ⑤ Fabric/Quilt + OptiFine 需要 OptiFabric 桥接，且桥接包必须在 OptiFine **之后**装
 *   ⑥ Fabric ≥1.20.5 与 OptiFine 不兼容（1.14 ~ 1.20.4 有桥接包，只是要手动下）；
 *      Forge 1.13~1.14.3 与 OptiFine 不兼容
 */
import type {
  AddonKind,
  AddonOption,
  ApiLibraryOption,
  BaseLoaderKind,
  BridgeKind,
  LoaderCapabilities,
  LoaderOption,
} from './types.ts';
/*
 * ★ Fabric API 的支持表（判"这个正式版能不能用 Fabric"）。
 *   表和理由都在那边，这里只用结论 —— 判据只有一处。
 */
import { isFabricApiVersion, fabricApiUnsupportedReason } from './fabric-api.ts';
// ★ 版本比较只有一份实现（`version.ts`）—— 判"1.20.5 及以上"必须用它，
//   不要再用 `parseInt(mcVersion.split('.')[1])`：那对 `26.2` 这种
//   两位数主版本号是错的（这个坑在 Java 要求那边已经踩过一次，
//   本轮 Rust 侧的 OptiFabric 区间又踩了第二次）。
import { compareVersion } from './version.ts';
// ★ 桥接区间**只有这一份**（`bridge-range.ts`）：本轮就是因为区间逻辑
//   在 TS/Rust 各写一遍，才把 1.16~1.20.4 整段误判成"没有桥接包"。
import {
  BRIDGE_SEGMENTS,
  optifabricAvailability,
} from './bridge-range.ts';

/* ====================== MC 版本基础数据 ====================== */

interface McProfile {
  releasedAt: string;
  javaMajor: number;
  /** 原版落盘字节数（jar + libraries + assets），实测近似值 */
  vanillaBytes: number;
  /** 支持的基础加载器 */
  bases: BaseLoaderKind[];
  /** 支持的附加组件 */
  addons: Array<'optifine' | 'liteloader'>;
  /** 该版本每个基础加载器的可选版本（第一项为推荐） */
  baseVersions?: Partial<Record<BaseLoaderKind, string[]>>;
  /** 附加组件可选版本 */
  addonVersions?: Partial<Record<'optifine' | 'liteloader', string[]>>;
  note: string;
}

const MB = 1024 * 1024;

/**
 * 版本能力表。
 * 注意 javaMajor 的取值依据见 java.ts 的规则引擎，这里只是快照。
 */
export const MC_PROFILES: Record<string, McProfile> = {
  '1.21.1': {
    releasedAt: '2024-08-08',
    javaMajor: 21,
    vanillaBytes: 470 * MB,
    bases: ['neoforge', 'fabric', 'quilt'],
    // ★ 1.21.1 **有** OptiFine 正式版（实测 OptiFine_1.21.1_HD_U_J1.jar）
    addons: ['optifine'],
    baseVersions: {
      neoforge: ['21.1.72', '21.1.65', '21.1.48'],
      fabric: ['0.16.9', '0.16.5', '0.15.11'],
      quilt: ['0.9.2', '0.9.0'],
    },
    addonVersions: { optifine: ['HD U J1'] },
    note: '最新正式版 · NeoForge / Fabric 生态成熟（OptiFine 已有正式版）',
  },
  '1.20.6': {
    releasedAt: '2024-04-29',
    javaMajor: 21,
    vanillaBytes: 450 * MB,
    bases: ['neoforge', 'fabric', 'quilt'],
    /*
     * ★ 这里原来写着「OptiFine 未发布 1.20.5+ 的任何版本」—— **实测是错的**。
     *   真机查 BMCLAPI 的 OptiFine 清单：
     *     · 1.20.5 → 0 条（这一版确实被跳过了）
     *     · 1.20.6 → 有**预览版**（HD U J1 pre17/pre18）
     *     · 1.21.1 → 有**正式版**（OptiFine_1.21.1_HD_U_J1.jar）
     *   所以"没有"只对 1.20.5 成立；1.20.6 是"只有预览版"，不是"没有"。
     *   静态表只用于**离线兜底**，在线时以 `fetch_available_loaders` 为准。
     */
    addons: ['optifine'],
    baseVersions: {
      neoforge: ['20.6.119', '20.6.99'],
      fabric: ['0.16.9', '0.15.11'],
      quilt: ['0.9.2'],
    },
    addonVersions: { optifine: ['HD U J1 pre18', 'HD U J1 pre17'] },
    note: '过渡版本 · 1.20.5 被 OptiFine 跳过，1.20.6 起只有预览版',
  },
  '1.20.4': {
    releasedAt: '2023-12-07',
    javaMajor: 17,
    vanillaBytes: 440 * MB,
    bases: ['neoforge', 'fabric', 'quilt'],
    addons: ['optifine'],
    baseVersions: {
      neoforge: ['20.4.237', '20.4.190'],
      fabric: ['0.16.9', '0.15.11'],
      quilt: ['0.9.2', '0.8.1'],
    },
    addonVersions: { optifine: ['HD U I6', 'HD U I5'] },
    note: '模组生态成熟 · Fabric 与 OptiFine 的最后一个兼容版本段',
  },
  '1.20.1': {
    releasedAt: '2023-06-12',
    javaMajor: 17,
    vanillaBytes: 430 * MB,
    bases: ['forge', 'fabric', 'quilt'],
    addons: ['optifine'],
    baseVersions: {
      forge: ['47.2.0', '47.1.0', '47.0.3'],
      fabric: ['0.16.9', '0.15.11'],
      quilt: ['0.9.2', '0.8.1'],
    },
    addonVersions: { optifine: ['HD U I6', 'HD U I5'] },
    note: '长期热门模组版本 · Forge 与 Fabric 生态都成熟',
  },
  '1.19.2': {
    releasedAt: '2022-08-05',
    javaMajor: 17,
    vanillaBytes: 400 * MB,
    bases: ['forge', 'fabric', 'quilt'],
    addons: ['optifine'],
    baseVersions: {
      forge: ['43.3.0', '43.2.0'],
      fabric: ['0.16.9', '0.15.11'],
      quilt: ['0.9.2'],
    },
    addonVersions: { optifine: ['HD U I2', 'HD U H9'] },
    note: '经典模组版本',
  },
  '1.18.2': {
    releasedAt: '2022-02-28',
    javaMajor: 17,
    vanillaBytes: 380 * MB,
    bases: ['forge', 'fabric', 'quilt'],
    addons: ['optifine'],
    baseVersions: { forge: ['40.2.0', '40.1.0'], fabric: ['0.16.9'], quilt: ['0.9.2'] },
    addonVersions: { optifine: ['HD U H4', 'HD U H3'] },
    note: '稳定长线版本',
  },
  '1.16.5': {
    releasedAt: '2021-01-14',
    javaMajor: 8,
    vanillaBytes: 330 * MB,
    bases: ['forge', 'fabric'],
    addons: ['optifine'],
    baseVersions: { forge: ['36.2.39', '36.2.34'], fabric: ['0.14.24', '0.14.22'] },
    addonVersions: { optifine: ['HD U G8', 'HD U G7'] },
    note: '老牌 Mod 生态 · Forge 与 OptiFine 需版本号匹配',
  },
  '1.12.2': {
    releasedAt: '2017-09-18',
    javaMajor: 8,
    vanillaBytes: 240 * MB,
    bases: ['forge'],
    addons: ['optifine', 'liteloader'],
    baseVersions: { forge: ['14.23.5.2860', '14.23.5.2859'] },
    addonVersions: {
      optifine: ['HD U F5', 'HD U E2'],
      liteloader: ['1.12.2-SNAPSHOT-r175'],
    },
    note: '老版本模组黄金期 · LiteLoader 仅在此段可用（且需 Forge）',
  },
  '1.7.10': {
    releasedAt: '2014-06-26',
    javaMajor: 8,
    vanillaBytes: 180 * MB,
    bases: ['forge'],
    addons: ['optifine', 'liteloader'],
    baseVersions: { forge: ['10.13.4.1614', '10.13.4.1558'] },
    addonVersions: {
      optifine: ['HD U E7', 'HD U D5'],
      liteloader: ['1.7.10_04'],
    },
    note: '怀旧经典 · LiteLoader 在此段最常用',
  },
  '24w45a': {
    releasedAt: '2024-11-06',
    javaMajor: 21,
    vanillaBytes: 480 * MB,
    bases: ['fabric'],
    addons: [],
    baseVersions: { fabric: ['0.16.9'] },
    note: '快照 · 仅供尝鲜，模组基本不可用',
  },
};

/* ====================== 加载器显示名与体积 ====================== */

export const BASE_LOADER_NAME: Record<BaseLoaderKind, string> = {
  forge: 'Forge',
  neoforge: 'NeoForge',
  fabric: 'Fabric',
  quilt: 'Quilt',
};


export const ADDON_NAME: Record<'optifine' | 'liteloader', string> = {
  optifine: 'OptiFine',
  liteloader: 'LiteLoader',
};

export const ADDON_DESC: Record<'optifine' | 'liteloader', string> = {
  optifine: '光影与高清材质支持',
  liteloader: '轻量客户端 Mod 支持（已停止维护）',
};

/**
 * ★★ **IEML 真的实现了这个附加组件的安装吗？**（与 Rust 侧 `addon_install_implemented` 同步）
 *
 * 这是"能装就是能装"的唯一判据 —— 静态表回答"上游有没有"，
 * 这张表回答"我们做没做"。两者混在一起时，静态表里写着可用的 LiteLoader
 * 会让用户勾选、点安装、看到成功，而磁盘上什么都没发生。
 *
 * ★★ 2026-09-14：`optifine` 从 `true` 改成 `false`。
 *
 *   用户报「有些版本没有 optifine，可是在切换到有高清修复的版本，再切回去，
 *   就显示有了，实际上点击后，是不让选的」。查下来 OptiFine 这条是**假承诺**：
 *   全仓库（Rust + TS）没有任何一处真的下载 OptiFine、跑它的 Patcher、
 *   或写版本 JSON —— 只有"拉清单""认磁盘""算兼容性"三件事。
 *   而这张表写着 `true`，界面于是一半说"能装"、一半因为拿不到真实清单而置灰，
 *   正是用户看到的"显示有，但不让选"。
 *
 *   改成 `false` 之后界面统一显示「上游有 · 但我们还没做」，
 *   用户能一眼看出该等我们、还是换别的启动器装好再用 IEML 启动。
 *
 * ★ 改这一个值时，Rust 侧 `domain::loader_caps::addon_install_implemented`
 *   必须一起改；两边各有一条测试守着（`nothing_unimplemented_is_marked_available`
 *   与 `tests/loader-catalog.test.mjs` 里的同款断言）。
 */
export const ADDON_INSTALL_IMPLEMENTED: Record<'optifine' | 'liteloader', boolean> = {
  /*
   * ★★ 两个附加组件现在**都实装了**（2026-09-14 第二轮）。
   *
   *   这个值改过三轮，每轮都有实测理由，值得留着：
   *     · 起初 `optifine: true` —— **假的**（全仓库没有安装实现），
   *       界面于是承诺做不到的事（用户报"显示有，点击后不让选"）；
   *     · dev.3 两个都改成 `false` —— 诚实，但功能确实没有；
   *     · dev.4 两个都改成 `true` —— **这次是真的**：
   *       `net::optifine`（跑官方 Patcher）与 `net::liteloader`（写版本描述 + 下库）
   *       都有真机测试证明装完能进游戏：
   *         `tests/live_optifine.rs` + `live_optifine_launch.rs`
   *         `tests/live_liteloader.rs`
   *
   *   ★ 改这里的**同时**必须改 Rust 的
   *     `domain::loader_caps::addon_install_implemented`，两边有测试对着。
   */
  optifine: true,
  liteloader: true,
};

/** 各组件大约增加的文件体积（字节） */
export const COMPONENT_BYTES: Record<string, number> = {
  forge: 120 * MB,
  neoforge: 135 * MB,
  fabric: 12 * MB,
  quilt: 14 * MB,
  optifine: 38 * MB,
  liteloader: 6 * MB,
  optifabric: 1.2 * MB,
  'fabric-api': 2.1 * MB,
  'quilted-fabric-api': 3.4 * MB,
};

/* ====================== OptiFine × Forge 五级判定 ====================== */

/**
 * OptiFine 版本清单里的 RequiredForgeVersion（源码事实见源码研读第 13 章）。
 * 这是**按 MC 版本**索引的：每个 MC 版本对应一个 OptiFine 版本段，该段要求特定 Forge 版本。
 */
export const OPTIFINE_FORGE_REQ: Record<string, { inherit: string; req: string | null }> = {
  '1.20.1': { inherit: '1.20.1', req: '47.2.0' }, // 含 '.' → 精确比较
  '1.19.2': { inherit: '1.19.2', req: '43.2' }, // 不含 '.' → 只比 revision
  '1.18.2': { inherit: '1.18.2', req: '40.1' },
  '1.16.5': { inherit: '1.16.5', req: '36.2' },
  '1.12.2': { inherit: '1.12.2', req: '' }, // 空白串 → 无限制
  '1.7.10': { inherit: '1.7.10', req: null }, // null → 不支持 Forge
};

/* ====================== 生成能力表 ====================== */

/*
 * ★★ "正式版"的判据（2026-09-15 修）。
 *
 *   原来这里只有 `SNAPSHOT_RE = /^\d{2}w\d{2}[a-z]$/` —— 它**只认周更快照**
 *   （`24w14a`）。于是 `26.2-rc-2`、`26.2-pre-6`、`1.21.2-pre1` 这些
 *   **预发布版全被判成"正式版"**，在"正式版"这一档里照样显示。
 *   （用户报的"切回正式版还显示快照版"就是这个形状。）
 *
 *   正确的判据不是"列举哪些是快照"，而是**反过来问：这是不是一个最终版本？**
 *   Mojang 的最终版本号只有 `x.y` / `x.y.z` 两种形状；
 *   任何带后缀的（-pre / -rc / -beta / -alpha / w 周更 / a·b 远古版）
 *   都不是。所以：
 */
const FINAL_RELEASE_RE = /^\d+\.\d+(\.\d+)?$/;

function isSnapshot(id: string): boolean {
  return !FINAL_RELEASE_RE.test(id);
}

/*
 * ★★ 2026-09-23（用户第 6 条：「选择游戏版本的筛选，给愚人节版本新增一个筛选项：**愚人节**」）
 *
 *   愚人节版本的**已知名单**。
 *
 *   ★ 为什么不用"第 14 周"这种规律：真机版本清单里有一个 `26w14a`，
 *     它是**普通快照**（那一年的第 14 周不是 4 月 1 日那周）——
 *     光看周数会把它误判成愚人节版本。所以用白名单：
 *     **宁可漏一个，不可错一个**（错了会让用户在"愚人节"这一档里看到普通快照）。
 *   ★ Mojang 以后再加，往这个 Set 里补一个即可（改一处）。
 */
const APRIL_FOOLS = new Set([
  '15w14a', // 2015 · 分享石头
  '1.RV-Pre1', // 2016 · 潮流更新
  '3D Shareware v1.34', // 2019 · 3D 共享软件
  '20w14infinite', // 2020 · 无限维度（清单里也可能写成 20w14∞）
  '20w14∞',
  '22w13oneblockatatime', // 2022 · 一个方块
  '23w13a_or_b', // 2023 · 投票更新
  '24w14potato', // 2024 · 毒土豆
  '25w14craftmine', // 2025 · 合成挖矿
]);

/** 这个版本 id 是不是愚人节版本（安装游戏那一页的"愚人节"档用它筛） */
export function isAprilFoolsVersion(id: string): boolean {
  return APRIL_FOOLS.has(id.trim());
}

/** 已知的全部 MC 版本 id（按发布时间倒序由 source 层提供，这里只列本地表） */
export function knownVersions(): string[] {
  return Object.keys(MC_PROFILES);
}

export function getProfile(mcVersion: string): McProfile | undefined {
  return MC_PROFILES[mcVersion];
}

/**
 * ★ 在线加载器数据（真实版本清单里的版本大多不在静态表内，必须靠它判可用性）。
 *
 * 语义（三条，别混）：
 *   · 没给这个 kind  → 用静态表（旧行为，方便离线/演示）
 *   · 给了空数组     → **在线确认**该加载器没有这个 MC 版本的发布
 *   · 给了非空数组   → 可用，并且这就是真实可选版本列表
 *
 * 为什么必须由外部传进来：静态表只有 10 个版本，而真实清单有 900+ 个。
 * 如果不在线查，1.21.4 会被判成"只有 Fabric"，那是**错误的禁用**——
 * 而禁用比不禁用更危险（用户会以为启动器不支持）。
 */
export interface OnlineLoaderVersions {
  bases?: Partial<Record<BaseLoaderKind, string[]>>;
  /**
   * ★ 附加组件的**在线**清单（目前只有 OptiFine 有：BMCLAPI 的 `/optifine/versionList`）。
   *
   * 语义与 `bases` 完全一致（同样别混）：
   *   · 没给这个 kind → 用静态表兜底
   *   · 给了空数组   → **在线确认**上游没有这个 MC 版本的发布
   *   · 给了非空数组 → 存在
   *
   * ## 为什么必须补上这一条（2026-09-14 第九轮，实测踩到的）
   *
   *   `InstallComposer` 的 OptiFine 开关是**在线清单**说了算的：
   *   `disabled = !a.implemented ? true : isOf && online ? !ofVersionsKnown : !a.available`
   *   —— 只要在线清单里有版本，开关就点得动。
   *
   *   而 `validateCombination` 走的却是**静态表**的 `exists`（只有 10 个版本）。
   *   于是 `1.16.1 + Fabric + OptiFine` 变成：
   *     · 开关**点得动**（在线清单里 1.16.1 有 22 个 OptiFine 版本，实测）；
   *     · 勾上之后 `validateCombination` 却报「组合不合法」。
   *   两个判据不一致，用户看到的就是"我明明勾上了，它说不兼容"。
   *
   *   ★ 根子还是"不要拿一张不完整的表去替上游下结论"：
   *     静态表回答不了"1.16.1 有没有 OptiFine"，在线清单能。
   */
  addons?: Partial<Record<AddonKind, string[]>>;
}

/**
 * 生成某个 MC 版本的加载器能力表。
 * 不支持的基础加载器**也返回**，带 unavailableReason —— UI 据此置灰并显示原因。
 */
export function getLoaderCapabilities(
  mcVersion: string,
  online?: OnlineLoaderVersions,
): LoaderCapabilities {
  const profile = MC_PROFILES[mcVersion];

  const baseLoaders: LoaderOption[] = (['forge', 'neoforge', 'fabric', 'quilt'] as BaseLoaderKind[]).map(
    (kind) => {
      /* --- ① 有在线数据：以在线为准（这是真实版本唯一可靠的判据） --- */
      const live = online?.bases?.[kind];
      if (live) {
        const hasBuilds = live.length > 0;

        /*
         * ★★ 2026-09-17（用户：「根据 Fabric API 支持版本来精确限制哪些版本有
         *    Fabric 哪些没有」，随后补一句「Quilt 和 Fabric 支持的版本是重合的」）。
         *
         *   **Fabric 加载器存在 ≠ Fabric API 存在。**
         *   以前这里只看在线清单有没有构建 —— 只要有，就说"可用"。
         *   可是玩家装 Fabric 基本都是为了装依赖 Fabric API 的 Mod：加载器有、
         *   API 没有时，勾上只会得到一个**装不了任何 Mod 的空壳**。
         *
         *   ★ **Quilt 走同一张表**（2026-09-17 补）：
         *     实测 Quilt 加载器从 **1.14.4** 起有构建，而 Fabric API 从 1.14 起 ——
         *     两者基本重合。Quilt 装 Mod 靠的是 **QFAPI**，它的支持范围跟着
         *     Fabric API 走，所以"Fabric API 不支持这个版本"对 Quilt 同样成立。
         *     我一开始把 Quilt 排除在外（理由是"它有自己的支持范围"），那是错的：
         *     它的范围**不是自己的**，是跟着 Fabric API 的。
         *
         *   ★ 快照**不**过这道闸：MC百科页面明确写着 Fabric API
         *     「也跟进最新快照版本开发」，一律拒掉是**误伤** ——
         *     "用户明明能装、我们不让"比"漏放一个"更糟。
         */
        const fabricFamily = kind === 'fabric' || kind === 'quilt';
        const blockedByApi =
          fabricFamily && !isSnapshotVersion(mcVersion) && !isFabricApiVersion(mcVersion);
        const available = hasBuilds && !blockedByApi;

        return {
          kind,
          name: BASE_LOADER_NAME[kind],
          // ★ 保留在线拿到的版本号：用户看得见"加载器确实有构建"，
          //   再配上理由就能明白"是 API 不支持，不是没下载到"。
          versions: live,
          available,
          // 在线清单是**权威**的：有就是有，空就是"确认没有"
          confirmed: true,
          unavailableReason: blockedByApi
            ? fabricApiUnsupportedReason(mcVersion, kind === 'quilt' ? 'quilt' : 'fabric')
            : available
              ? undefined
              : `${BASE_LOADER_NAME[kind]} 未发布 ${mcVersion} 版本`,
        };
      }

      /* --- ② 没有在线数据：**任何加载器都不下结论** --- */
      if (!profile) {
        /*
         * ★★ 这里曾经写着「{加载器} 尚未发布 {mc} 版本」—— 那是把"我不知道"
         *   说成了"它没有"，是 ADR-037 明令禁止的。
         *
         *   实测代价（用户报的正是这个）：「什么叫 Forge 没发布 26.2 版本，PCL 是有的」。
         *   内置表只有 10 个版本，没有 26.2；只要在线清单那一瞬间没拿到
         *   （超时/失败/网络掐断），Forge / NeoForge / Quilt 就全被断言成"尚未发布"。
         *
         *   ★ 现在的立场：**内置表不再是"能不能装"的判据**。
         *     没有在线数据 → 全部标 `confirmed: false`、`available: false`，
         *     理由说清是"没查到"。用户要么重试、要么等后台把清单拉回来。
         *     宁可暂时不能选，也不替加载器下一个可能是假的结论。
         */
        return {
          kind,
          name: BASE_LOADER_NAME[kind],
          versions: [],
          available: false,
          confirmed: false,
          unavailableReason:
            `${BASE_LOADER_NAME[kind]} 的 ${mcVersion} 版本清单这次没查到 —— ` +
            `**不代表它没有发布**（例如 26.2 的 Forge 是有的）。` +
            `点「重新查询」重试；能装不能装一律以在线清单为准`,
        };
      }

      /* --- ③ 在线没拿到、但内置表里有这个版本：表只作"离线参考"，仍是未知 --- */
      const available = profile.bases.includes(kind);
      const versions = profile.baseVersions?.[kind] ?? [];
      return {
        kind,
        name: BASE_LOADER_NAME[kind],
        versions,
        available,
        /*
         * ★ 内置表**不是**权威来源（它连 900 个版本都覆盖不全，更跟不上新版本）。
         *   所以它给出的"没有"一律标成未确认 —— 界面只能说"内置参考里没有，
         *   联网确认一下"，不能说"未发布"。见 ADR-037 / ADR-040。
         */
        confirmed: false,
        unavailableReason: available
          ? undefined
          : `内置参考表里没有 ${BASE_LOADER_NAME[kind]} 在 ${mcVersion} 上的条目 —— ` +
            `这不代表它没有发布，请以在线清单为准`,
      };
    },
  );

  const addons: AddonOption[] = (['optifine', 'liteloader'] as const).map((kind) => {
    /*
     * ★★ 与 Rust 侧 `AddonOption` 一一对应的两个字段（ADR-041 / ADR-045）：
     *
     *   `exists`      —— 上游有没有发布这个 MC 版本的版本？
     *   `implemented` —— **IEML 自己实现安装了吗**？
     *
     *   分开之前，静态表里写着可用的 LiteLoader 会让用户勾选、点安装、
     *   界面报成功 —— 而 Rust 侧根本没有它的安装实现（只有磁盘识别）。
     *   用户的原话是「能装就是能装，不能装就是不能装」，
     *   所以这两个问题必须分开回答，界面才能说清该怪谁。
     */
    const implemented = ADDON_INSTALL_IMPLEMENTED[kind];
    const inTable = profile ? profile.addons.includes(kind) : false;
    /*
     * ★★ 在线清单优先 —— 和基础加载器（上面那段）用**同一套三态语义**。
     *
     *   修的是一个实测出来的自相矛盾：`InstallComposer` 让 OptiFine 开关
     *   由**在线清单**决定能不能点，而这里却由**静态表**（只有 10 个版本）
     *   决定"存不存在"。`1.16.1 + Fabric + OptiFine` 因此出现
     *   "开关点得动、勾上却说不兼容"。见 `OnlineLoaderVersions.addons`。
     */
    const live = online?.addons?.[kind];
    const exists = live ? live.length > 0 : inTable;
    const versions = live ?? profile?.addonVersions?.[kind] ?? [];
    /*
     * 附加组件的版本清单：
     *   * OptiFine —— **有在线清单**（BMCLAPI 的 `/optifine/versionList`，
     *     `InstallComposer` 会拉真实版本），所以这里的静态值只是离线兜底；
     *   * LiteLoader —— 没有在线清单，且安装未实现，静态值仅供展示。
     */
    /*
     * ★★ 理由的**顺序**：先说"我们没做"，再说"上游有没有"。
     *
     *   这两句话对用户的含义完全不同：
     *     · "版本清单这次没查到" → 暗示**重试一下就有了**（可解决）；
     *     · "IEML 还没做它的安装" → 暗示**等我们或换启动器**（不可解决）。
     *
     *   先说前者的话，用户会一直点「重新查询」，而真正的原因
     *   （我们根本没写安装器）永远看不到 —— 那正是用户报的
     *   「显示有高清修复，实际上点击后是不让选的」那种困惑。
     *   把最难的那条放最前面，用户一次就能做对决定。
     *
     *   （真实的组合不兼容比这两条都更优先，由 `combination.ts` 的
     *    `addonCompatibility` 先判。）
     */
    const opt: AddonOption = {
      kind,
      name: ADDON_NAME[kind],
      versions: versions.length > 0 ? versions : ['最新版'],
      // ★ 最终结论 = 上游有 **且** 我们装得了
      available: exists && implemented,
      exists,
      implemented,
      unavailableReason: !implemented
        ? `${ADDON_NAME[kind]} 的**自动安装 IEML 还没有做** —— ` +
          `现在只能识别已经装好的（会显示在版本清单里），不能帮你装。` +
          `想用的话请用别的启动器装好，再用 IEML 启动它`
        : !exists
          ? profile
            ? /*
               * ★ 这里原来写「{组件} 未发布 {mc} 版本」—— 又是"把不知道说成没有"。
               *   实测：OptiFine 在 1.20.6 有预览版、1.21.1 有正式版，
               *   内置表没收录 ≠ 它没发布。理由必须说清是"表里没有、以在线清单为准"。
               */
              `内置参考表里没有 ${ADDON_NAME[kind]} 在 ${mcVersion} 上的条目 —— ` +
              `这不代表它没有发布（打开「下载」页会拉到真实的 OptiFine 清单）`
            : `${ADDON_NAME[kind]} 的版本清单这次没查到，无法为 ${mcVersion} 确认可用版本 —— ` +
              `这不代表它没有。该组件仍是可选的：装完可以手动放进 mods`
          : undefined,
    };
    return opt;
  });

  return {
    mcVersion,
    baseLoaders,
    addons,
    apiLibraries: apiLibrariesFor(mcVersion),
    // 表里没有的版本按 Java 21 显示；真正用于安装的 Java 要求由 java.ts 的规则引擎算
    javaMajor: profile?.javaMajor ?? 21,
  };
}

/**
 * 桥接需求的结果。
 *
 * ★ 用一个**可判别的联合**（`usable` 是判别式），而不是 `A | B | null` ——
 *   后者在调用点很难窄化（TypeScript 分不清"不需要桥接"和"要桥接但装不了"），
 *   而那两件事的**处置完全不同**：
 *     · `no-bridge`     → 这个附加组件在这个基座上本来就不需要桥接，放行
 *     · `unavailable`   → 需要桥接但上游没有 → **判不兼容**
 */
export type BridgeNeed =
  /** 不需要桥接包（例如 Forge 上的 OptiFine、LiteLoader） */
  | { usable: 'no-bridge' }
  /** 需要桥接包，而且能拿到 */
  | { usable: 'yes'; kind: BridgeKind; manual: boolean; notes: string[] }
  /** 需要桥接包，但**上游没有** → 这个组合装不了 */
  | { usable: 'unavailable'; reason: string };

/**
 * 附加组件的桥接需求（取决于当前选中的基础加载器）。
 *
 * ## ★★ 区间判断**不在这里** —— 在 `bridge-range.ts`
 *
 * 这个函数只做两件事：判"这个基座要不要桥接"，然后把
 * `optifabricAvailability()` 的结论翻译成 `BridgeNeed`。
 * **不许在这里再写一遍版本区间**：本轮（dev.10）就是因为区间逻辑
 * 在 TS/Rust 各写一遍 + 判据查错了平台，导致 1.16~1.20.4 这一大段
 * 被误判成"根本没有桥接包"。
 *
 * ## dev.10 的错误与更正（务必留档）
 *
 *   错：我查了 Modrinth，`optifabric` 404，于是断言
 *       「**1.16 ~ 1.20.4 这一段没有任何桥接包**」，并据此把
 *       Fabric + 高清修复整段判成不兼容。
 *
 *   对：OptiFabric **一直在 CurseForge 发布**（项目 ID 322385，
 *       75 个文件 / 1005 万次下载），MC百科 class/1703 的支持表列到 1.20.4。
 *       它只是**没上 Modrinth** —— 我查错了平台，还把缺席当成了铁证。
 *
 *   现在的结论：**1.14 ~ 1.20.4 有桥接包（需手动下载，见 `manual`）**，
 *   1.20.5 及以上才是真的没有。
 */
export function bridgeFor(
  mcVersion: string,
  base: BaseLoaderKind | null,
  addon: 'optifine' | 'liteloader',
): BridgeNeed {
  if (addon === 'optifine') {
    if (base === 'fabric' || base === 'quilt') {
      const loaderName = base === 'quilt' ? 'Quilt' : 'Fabric';
      const avail = optifabricAvailability(mcVersion);
      if (!avail.available || !avail.kind) {
        const isAbove = compareVersion(mcVersion, BRIDGE_SEGMENTS.main.high) > 0;
        return {
          usable: 'unavailable',
          reason:
            `${loaderName} ${mcVersion} 与高清修复（OptiFine）不兼容。\n` +
            `原因：OptiFine 是直接改游戏 jar 的老式渲染补丁，在 ${loaderName} 上必须靠桥接包\n` +
            `OptiFabric 才能挂上去。${avail.reason ?? ''}\n\n` +
            (isAbove
              ? `想要高清材质 / 光影，请改用这两条路之一：\n` +
                `  · 换 Forge 作基座 —— Forge 上 OptiFine 是官方支持的；\n` +
                `  · 或留在 ${loaderName}，用 Iris + Sodium（光影与性能优化的现代替代，不需要 OptiFine）。`
              : `这个版本段没有桥接包可用，请换一个支持的 MC 版本，或改用 Forge 作基座。`),
        };
      }
      return {
        usable: 'yes',
        kind: avail.kind,
        manual: avail.manual,
        notes: avail.notes,
      };
    }
    return { usable: 'no-bridge' };
  }
  if (addon === 'liteloader') {
    // LiteLoader 直接挂在 Forge 上，不需要桥接包
    return { usable: 'no-bridge' };
  }
  return { usable: 'no-bridge' };
}

/**
 * 基础加载器对应的 API 前置包。
 * ★ 两者是**互斥**的：Fabric 用 Fabric API，Quilt 用 QFAPI（它已内含 Fabric API）。
 *   原设计稿把两个都列出来（"将自动安装 Fabric API + Quilted Fabric API"），
 *   是错的 —— 同时装两个会导致 Mod 重复加载。
 *
 * ★★ 2026-09-26：**这里的版本号不再是具体数字**。
 *   原来写的是 `0.92.2+<mc>` / `7.4.0+0.92.2` —— 那是**编出来的数字**：
 *   真实安装走 Modrinth 在线清单，由 `pick_default_version` 在**该 MC 版本的**
 *   候选里挑（正式版 > beta > alpha），实测那时候已经到 `0.92.12+1.20.1` 了。
 *   界面上写一个固定的旧版本号，等于对用户说一句假话（判据②那一类）。
 *   所以这里只写"最新版"，具体哪个版本由安装时在线挑（Rust 侧同名字段同步改）。
 */
export function apiLibrariesFor(mcVersion: string): ApiLibraryOption[] {
  if (isSnapshot(mcVersion)) return [];
  return [
    {
      kind: 'fabric-api',
      name: 'Fabric API',
      version: '最新版',
      description: '绝大多数 Fabric Mod 依赖此包，不装会导致 Mod 加载失败',
      bytes: COMPONENT_BYTES['fabric-api'] ?? 0,
      required: true,
    },
    {
      kind: 'quilted-fabric-api',
      name: 'Quilted Fabric API',
      version: '最新版',
      description: '已内含 Fabric API，同时支持 Fabric 与 Quilt Mod',
      bytes: COMPONENT_BYTES['quilted-fabric-api'] ?? 0,
      required: true,
    },
  ];
}

/**
 * 某个基础加载器该自动装哪个 API 包。
 * ★ 只返回**一个** —— Fabric → Fabric API；**其余（含 Quilt）→ 无**。
 *
 * ★★ 2026-09-24（B-3 修复）：Quilt 原来返回 Quilted Fabric API（QFAPI）。
 *   但用户 2026-09-15 明确说过「**不给 Quilt 装 API 了**」，
 *   Rust 的 `domain::loader_caps::api_for_base` 当时就改成了 `return vec![]` ——
 *   **只有 TS 这一侧没跟着改**，而界面读的正是这一侧：
 *   安装页选 1.20.1 + Quilt 会写「将自动安装 Quilted Fabric API 7.4.0+0.92.2」，
 *   点下去真的会往 mods/ 里塞一个用户明确不要的包
 *   （QFAPI 已内含 Fabric API，与 Fabric 侧的判定还会打架）。
 *
 *   现在两侧一致：**只有 Fabric 自动装**。Quilt 缺前置时由 Mod 管理页如实报出来，
 *   装不装由玩家自己决定。
 *   ★ `apiLibrariesFor` 仍然把两个包都列出来 —— 那是"这个版本**可能**需要的 API 包"
 *     能力表，不是"我会替你装什么"。两件事不能混。
 */
export function apiForBase(
  base: BaseLoaderKind | null,
  mcVersion: string,
): ApiLibraryOption[] {
  if (base !== 'fabric') return [];
  const found = apiLibrariesFor(mcVersion).find((l) => l.kind === 'fabric-api');
  return found ? [found] : [];
}

/** 取该 MC 版本+加载器组合下 API 包应该用哪一个 */
export function resolveApiLibrary(
  base: BaseLoaderKind | null,
  mcVersion: string,
): ApiLibraryOption | null {
  return apiForBase(base, mcVersion)[0] ?? null;
}

/** 别名：能力表里的 apiLibraries 字段用于展示"该版本可能需要的 API 包" */
export const allApiLibraries = apiLibrariesFor;

export function isSnapshotVersion(id: string): boolean {
  return isSnapshot(id);
}
