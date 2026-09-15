/**
 * OptiFabric 支持区间 —— **唯一一份**桥接可用范围的实现（2026-09-14 第九轮）
 * ==================================================================
 *
 * ## 为什么要有这个文件（这一轮犯的错，必须写下来）
 *
 * 上一轮（dev.10）我在这里下了两个结论，**两个都是错的**：
 *
 *   ① 「OptiFabric 在 Modrinth 上 404 → 它不存在」
 *   ② 「1.16 ~ 1.20.4 整段没有桥接包 → Fabric + 高清修复不兼容」
 *
 * 实测结果（两条都是硬证据）：
 *
 *   · Modrinth：`optifabric` → **404**（这个是真的）；
 *   · CurseForge：项目 **322385**，`api.cfwidget.com` 读出
 *     **75 个文件、总下载 10,056,111 次**，最高版本 `optifabric-1.14.3.jar`
 *     对应 MC **1.19.3**（2024-01-12 上传）—— 也就是说，
 *     它**一直都在**，只是没上 Modrinth。
 *
 *   ③ 用户拿 MC百科 class 1703 的「支持MC版本」表纠正我：
 *      Fabric: 1.20.4 / 1.20.2 / 1.20.1 / 1.20 / 1.19.4 / 1.19.3 / 1.19.2 /
 *      1.19.1 / 1.19 / 1.18.2 / 1.18.1 / 1.18 / 1.17.1 / 1.17 / 1.16.5 /
 *      1.16.4 / 1.16.3 / 1.16.2 / 1.16.1 / 1.15.2 / 1.14.4 / 1.14.3 /
 *      1.14.2 / 1.14.1 / 1.14
 *      并注明 GitHub 归属：`Chocohead（1.16~1.20）`、`modmuss50（1.14~1.16）`，
 *      CurseForge Project ID `322385` —— **和我自己读到的项目号一模一样**。
 *
 * ## 教训（已写进 ADR-050）
 *
 *   **「某个平台上 404」只能证明"那个平台上没有"，不能证明"这东西不存在"。**
 *   一个项目可以在 Modrinth 没有、在 CurseForge 有；反过来也有。
 *   凡是"上游有没有"的结论，必须落在**它自己发布所在的平台**上；
 *   拿一个镜像站的缺席去替上游下结论，就是造谣。
 *
 *   我上一轮的"证据表"里三行全是 Modrinth 的查询结果 ——
 *   而 OptiFabric 从来就不在 Modrinth 发布。**我查错了平台，却当成铁证。**
 *
 * ## 本文件的职责
 *
 *   只回答一个问题：**这个 MC 版本上，"Fabric/Quilt + 高清修复"有没有桥接包？**
 *   不回答"我们能不能自动下"（那是 `manual` 字段），也不回答"装得上装不上"。
 *
 *   范围、例外版本、每个版本的注意事项**只有这一份**；
 *   `loader-caps.ts` 的 `bridgeFor` 和 Rust 的 `combination.rs` 都读它的结论，
 *   不许各写一遍区间判断（`forgespi`、Java 要求、本轮 OptiFabric 三次漂移
 *   都是"同一个谓词实现两遍"造成的）。
 */
import type { BridgeKind } from './types.ts';
import { compareVersion } from './version.ts';

/** OptiFabric 在 CurseForge 的项目页（项目 ID 322385，与 PCL 的 DlOptiFabricLoader 同源） */
export const OPTIFABRIC_CURSEFORGE_URL = 'https://www.curseforge.com/minecraft/mc-mods/optifabric';

/** OptiFabric Origins（1.14/1.15 段的非官方维护分支），Modrinth 上确实有 */
export const OPTIFABRIC_ORIGINS_URL = 'https://modrinth.com/mod/optifabric-origins';

/** 桥接表的判据来源，随每条数据一起展示/测试，避免"无从核对" */
export const BRIDGE_SOURCE = {
  /** 支持区间与分段作者 */
  range: 'MC百科 class/1703「支持MC版本」表 + GitHub 归属 Chocohead(1.16~1.20) / modmuss50(1.14~1.16)',
  /** 项目真实存在且持续发布 */
  existence: 'CurseForge Project ID 322385（75 个文件 / 1005 万次下载，最高 1.19.3）',
} as const;

/** 桥接可用区间的两端（含端点），字符串按版本号比较而不是字典序 */
const RANGE_LOW = '1.14.0';
const RANGE_HIGH = '1.20.4';

/**
 * 主项目 OptiFabric 覆盖的下界。
 *
 * ★ 1.14 ~ 1.15.2 段官方建议用 **OptiFabric Origins**（MC百科：「1.14.4 / 1.15.2
 *   建议使用非官方更新版本」），所以 1.14 ~ 1.15.2 单独走 `optifabric-origins`。
 *   主项目自己的文件表里 1.15.2 也是有的，但既然上游推荐 Origins，就按上游来。
 */
const MAIN_PROJECT_LOW = '1.16.1';

/**
 * `optifabric-origins`（Modrinth 实测）**只**有这两个版本。
 * 所以 1.14.0 ~ 1.15.2 里只有这两个能装，其余要如实说不支持 —— 不能因为
 * "1.14 段有桥接"就把 1.14.1 / 1.14.2 也说成可用（那又是替上游下结论）。
 */
const ORIGINS_VERSIONS = ['1.14.4', '1.15.2'] as const;

/** 每个版本的额外注意事项（来自 MC百科的「注意」段落，逐条可核对） */
const VERSION_NOTES: Record<string, string> = {
  '1.16.5':
    '这个组合要能跑，Fabric Loader 需要 0.14.21 这一代、OptiFine 需要 HD U G8（MC百科明确写明）',
};

/** 1.20 及以上的已知坑：Fabric API 0.86.0+ 会让文字变成方框 */
const NOTE_1_20_FABRIC_API =
  '1.20 段有个已知问题：Fabric API 0.86.0 及以上会让文字显示成方框 —— ' +
  '要么降低 Fabric API 版本，要么用 OptiFabric CI 207 及以上版本';

export interface BridgeAvailability {
  /**
   * 这个 MC 版本上有没有可用的桥接包。
   * `false` 是**真的没有**（拿得到证据的那种），不是"我们查不到"。
   */
  available: boolean;
  /** 可用的桥接包种类（`available: false` 时为 null） */
  kind: BridgeKind | null;
  /** 需不需要用户手动下载（目前**恒为 true** —— 见下方说明） */
  manual: boolean;
  /** 该版本的额外注意事项 */
  notes: string[];
  /** 不可用时的具体理由（要能直接给用户看） */
  reason?: string;
}

/**
 * ★ `manual` 恒为 true 的事实依据（不要再写 `manual: false`）：
 *
 *   `bridgeFile()` 这个下载接口**只存在于 `src/bridge/web.ts`（浏览器演示模式）**，
 *   生产用的 `src/bridge/tauri.ts` 根本没有它 —— `SourceAdapter` 里也没有。
 *   也就是说**没有任何一条生产路径**会去下载桥接包。
 *
 *   老代码返回 `{ kind: 'optifabric', manual: false }`，
 *   界面于是写着「（会自动装）」，而实际上一行都不会下 ——
 *   这正是用户抱怨的那句假承诺。现在一律 `manual: true` + 给真实下载地址。
 */
const MANUAL = true;

/**
 * 判断某个 MC 版本上 Fabric/Quilt 能否挂高清修复，用哪个桥接包。
 *
 * @param mcVersion MC 版本号（如 `1.20.1`、`26.2`、`24w45a`）
 */
export function optifabricAvailability(mcVersion: string): BridgeAvailability {
  // ---- 上界之外：真的没有 ----
  if (compareVersion(mcVersion, RANGE_HIGH) > 0) {
    return {
      available: false,
      kind: null,
      manual: MANUAL,
      notes: [],
      /*
       * ★ 上界给 1.20.4 的依据：MC百科的表到 1.20.4 为止，
       *   而 CurseForge 上主项目的最高发布（1.14.3）也只标到 1.19.3；
       *   1.20.5 起 OptiFine 自己改了渲染管线挂载点，OptiFabric 从未跟上。
       *   仓库里还挂着两个 issue（#1856、#2145）在要 1.21 —— 也就是**还没有**。
       */
      reason:
        `OptiFabric 最后一个支持到 1.20.4（CurseForge 项目 322385）。` +
        `1.20.5 起 OptiFine 的渲染补丁换了挂载点，OptiFabric 至今没有跟进` +
        `（上游仓库里要 1.21 的 issue 还开着）`,
    };
  }

  // ---- 下界之外：Fabric 生态都还没成型 ----
  if (compareVersion(mcVersion, RANGE_LOW) < 0) {
    return {
      available: false,
      kind: null,
      manual: MANUAL,
      notes: [],
      reason: `OptiFabric 最早支持到 1.14（再往前的桥接是 Legacy Fabric 那一支，不是 Fabric）`,
    };
  }

  // ---- 1.14 ~ 1.15.2：走 Origins，但只有它发布过的两个版本 ----
  if (compareVersion(mcVersion, '1.15.2') <= 0) {
    const exact = (ORIGINS_VERSIONS as readonly string[]).includes(mcVersion);
    if (!exact) {
      return {
        available: false,
        kind: null,
        manual: MANUAL,
        notes: [],
        reason:
          `1.14 ~ 1.15 段由 OptiFabric Origins 接续，而它只发布了 ` +
          ORIGINS_VERSIONS.join(' 和 ') +
          ` 两个版本，没有 ${mcVersion} 的包`,
      };
    }
    return {
      available: true,
      kind: 'optifabric-origins',
      manual: MANUAL,
      notes: [
        `1.14 ~ 1.15 段主项目已停更，上游建议改用 OptiFabric Origins：${OPTIFABRIC_ORIGINS_URL}`,
      ],
    };
  }

  // ---- 1.16.1 ~ 1.20.4：主项目 OptiFabric ----
  return {
    available: true,
    kind: 'optifabric',
    manual: MANUAL,
    notes: [
      ...(VERSION_NOTES[mcVersion] ? [VERSION_NOTES[mcVersion]] : []),
      ...(compareVersion(mcVersion, '1.20') >= 0 ? [NOTE_1_20_FABRIC_API] : []),
    ],
  };
}

/** 桥接包在界面上的显示名 */
export function bridgeDisplayName(kind: BridgeKind): string {
  return kind === 'optifabric' ? 'OptiFabric' : 'OptiFabric Origins';
}

/** 桥接包的下载页（手动安装时给用户点的那个链接） */
export function bridgeUrl(kind: BridgeKind): string {
  return kind === 'optifabric' ? OPTIFABRIC_CURSEFORGE_URL : OPTIFABRIC_ORIGINS_URL;
}

/** 主项目与 Origins 各自覆盖的区间，供文档/测试引用 */
export const BRIDGE_SEGMENTS = {
  origins: { low: '1.14.0', high: '1.15.2', versions: ORIGINS_VERSIONS },
  main: { low: MAIN_PROJECT_LOW, high: RANGE_HIGH },
} as const;
