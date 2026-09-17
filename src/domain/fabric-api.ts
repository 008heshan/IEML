/**
 * Fabric API 支持哪些 Minecraft 版本 —— **能不能给这个版本提供 Fabric 的判据**。
 * ------------------------------------------------------------------
 * ★ 为什么需要单独一个模块：
 *
 *   以前"这个版本有没有 Fabric"只看 **Fabric 加载器**的在线清单
 *   （`meta.fabricmc.net/v2/versions/loader/{mc}`）。**这两件事不是一回事**：
 *
 *     · Fabric **加载器**在很多版本上都有构建（包括快照）；
 *     · Fabric **API** 才决定"装完能不能装 Mod"。
 *
 *   玩家装 Fabric 基本都是为了装依赖 Fabric API 的 Mod。所以当加载器存在、
 *   而 API 不存在时，勾上 Fabric 只会得到一个**装不了任何 Mod 的空壳** ——
 *   界面说"Fabric 可用"，实际什么也做不了。
 *
 * ★ 数据来源：MC百科的 Fabric API 词条（见 JSON 的 `_source`）。
 *   页面正文原话：「除支持 1.14+ 的正式版本外，Fabric API 也跟进最新快照版本开发」。
 *   核对过：1.14 起的正式版一个不多一个不少，正好 48 个。
 *
 * ★ **一条表两边读**：这份 JSON 同时被 Rust 侧 `include_str!` 读走
 *   （`src-tauri/src/domain/loader_caps.rs`）。别在这里再抄一份数组 ——
 *   抄一份就会漂，而"支持范围"漂了之后的表现是"某个版本莫名其妙不能装"。
 *
 * ★ 这里**不做快照判断**：那需要 `isSnapshotVersion`，而它在 `loader-caps.ts` 里，
 *   反过来又要用本模块 —— 会成环。快照那条例外交给调用方处理（它本来就知道
 *   自己面对的是不是快照）。
 */
/*
 * ★ `with { type: 'json' }` 是必须的：node 直接跑 `.ts`（`node --test`）时，
 *   ESM 的 JSON import 要这个属性，否则报 `ERR_IMPORT_ATTRIBUTE_MISSING`。
 *   Vite 也认这个写法（它是标准语法）。
 */
import table from './fabric-api-versions.json' with { type: 'json' };

/** 表里列出的版本（1.14 起的正式版，共 48 个） */
export const FABRIC_API_VERSIONS: readonly string[] = table.versions;

/** 判据从哪来 —— 界面上要向用户交代（不能说"系统判定"，那等于没说） */
export const FABRIC_API_SOURCE = table._sourceName;

const SET = new Set(FABRIC_API_VERSIONS);

/** 这个**正式版**在不在这张表里 */
export function isFabricApiVersion(mcVersion: string): boolean {
  return SET.has(mcVersion);
}

/**
 * 不在表里时，能直接展示给用户的理由。
 *
 * ★ 必须包含"那该怎么办"，而不只是"不行"：这个版本的 Mod 生态在哪，
 *   用户看完这句话就能自己决定下一步。
 *
 * ★ **不要在里面写 markdown**（2026-09-17 用户截图：星号原样显示出来了）。
 *   这段文字会进 `title` 提示与告警面板，两处都按纯文本渲染。
 *
 * ★ 2026-09-17 补：**Quilt 走同一张表**。用户指出「Quilt 和 Fabric 支持的版本
 *   是重合的」—— 实测确认：Quilt 的加载器从 **1.14.4** 起有构建，
 *   而 Fabric API 从 1.14 起，两者基本重合。Quilt 上装 Mod 要靠
 *   **QFAPI（Quilted Fabric API）**，它的支持范围跟着 Fabric API 走，
 *   所以"Fabric API 不支持这个版本"对 Quilt 同样成立。
 *   我上一轮把 Quilt 排除在外，理由是"它有自己的范围"—— 那是错的。
 */
export function fabricApiUnsupportedReason(
  mcVersion: string,
  loader: 'fabric' | 'quilt' = 'fabric',
): string {
  const isQuilt = loader === 'quilt';
  const api = isQuilt ? 'QFAPI（Quilted Fabric API）' : 'Fabric API';
  const lead = isQuilt
    ? `Quilt 上的前置 API 是 ${api}，它的支持范围跟着 Fabric API 走 —— 而 Fabric API 没有发布 ${mcVersion} 版本，它从 1.14 起才支持正式版。`
    : `Fabric API 没有发布 ${mcVersion} 版本 —— 它从 1.14 起才支持正式版。`;
  return (
    `${lead}\n` +
    `更低的版本要靠移植项目（1.13.2~1.3.2 用 Legacy Fabric API、b1.7.3 用 ` +
    `Cursed Legacy API），那是另一套东西，IEML 没有做。\n` +
    `这个版本想装 Mod 请改用 Forge —— 1.12.2 / 1.7.10 那一档的 Forge 生态是完整的。`
  );
}
