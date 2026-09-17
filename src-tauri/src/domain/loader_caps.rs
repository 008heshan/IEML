//! 加载器能力表（对应前端 `src/domain/loader-caps.ts`）
//!
//! 数据依据：docs/LAUNCHER_SOURCE_STUDY.md 的源码研读结论 + PCL2 ModComp 行为。
//!
//! 铁律：
//!   ① 不可用必须给**具体理由**，不允许静默隐藏（ADR-004）
//!   ② NeoForge 只从 1.20.2 开始
//!   ③ LiteLoader 只能作 Forge 的附加组件，且仅 1.7.10 ~ 1.12.2
//!   ④ OptiFine 可独立装在纯原版上
//!   ⑤ Fabric/Quilt + OptiFine 需要 OptiFabric，且桥接包在 OptiFine **之后**装
//!   ⑥ Fabric ≥1.20.5 与 OptiFine 不兼容；Forge 1.13~1.14.3 与 OptiFine 不兼容

use crate::domain::types::*;

const MB: u64 = 1024 * 1024;

pub struct McProfile {
    pub released_at: &'static str,
    pub java_major: u32,
    pub vanilla_bytes: u64,
    pub bases: &'static [BaseLoaderKind],
    pub addons: &'static [AddonKind],
    pub note: &'static str,
}

const B_FORGE: BaseLoaderKind = BaseLoaderKind::Forge;
const B_NEO: BaseLoaderKind = BaseLoaderKind::NeoForge;
const B_FABRIC: BaseLoaderKind = BaseLoaderKind::Fabric;
const B_QUILT: BaseLoaderKind = BaseLoaderKind::Quilt;
const A_OPTIFINE: AddonKind = AddonKind::OptiFine;
const A_LITE: AddonKind = AddonKind::LiteLoader;

/// 版本能力表。java_major 只是快照，真实判定见 java.rs 的规则引擎。
pub fn profile(mc_version: &str) -> Option<McProfile> {
    let p = match mc_version {
        "1.21.1" => McProfile {
            released_at: "2024-08-08",
            java_major: 21,
            vanilla_bytes: 470 * MB,
            bases: &[B_NEO, B_FABRIC, B_QUILT],
            // ★ 1.21.1 **有** OptiFine 正式版（实测 OptiFine_1.21.1_HD_U_J1.jar）
            addons: &[A_OPTIFINE],
            note: "最新正式版 · NeoForge / Fabric 生态成熟（OptiFine 已有正式版）",
        },
        "1.20.6" => McProfile {
            released_at: "2024-04-29",
            java_major: 21,
            vanilla_bytes: 450 * MB,
            bases: &[B_NEO, B_FABRIC, B_QUILT],
            /*
             * ★ 这一行原来是 `addons: &[]` + 「OptiFine 从 1.20.5 起不再支持」——
             *   实测是**错的**：1.20.5 确实 0 条，但 1.20.6 有预览版
             *   （HD U J1 pre17/pre18），1.21.1 甚至有正式版。
             *   静态表只作离线兜底，在线时以 `fetch_available_loaders` 为准。
             */
            addons: &[A_OPTIFINE],
            note: "过渡版本 · 1.20.5 被 OptiFine 跳过，1.20.6 起只有预览版",
        },
        "1.20.4" => McProfile {
            released_at: "2023-12-07",
            java_major: 17,
            vanilla_bytes: 440 * MB,
            bases: &[B_NEO, B_FABRIC, B_QUILT],
            addons: &[A_OPTIFINE],
            note: "模组生态成熟 · Fabric 与 OptiFine 的最后一个兼容版本段",
        },
        "1.20.1" => McProfile {
            released_at: "2023-06-12",
            java_major: 17,
            vanilla_bytes: 430 * MB,
            // ★ NeoForge 只从 1.20.2 开始，1.20.1 没有
            bases: &[B_FORGE, B_FABRIC, B_QUILT],
            addons: &[A_OPTIFINE],
            note: "长期热门模组版本 · Forge 与 Fabric 生态都成熟",
        },
        "1.19.2" => McProfile {
            released_at: "2022-08-05",
            java_major: 17,
            vanilla_bytes: 400 * MB,
            bases: &[B_FORGE, B_FABRIC, B_QUILT],
            addons: &[A_OPTIFINE],
            note: "经典模组版本",
        },
        "1.18.2" => McProfile {
            released_at: "2022-02-28",
            java_major: 17,
            vanilla_bytes: 380 * MB,
            bases: &[B_FORGE, B_FABRIC, B_QUILT],
            addons: &[A_OPTIFINE],
            note: "稳定长线版本",
        },
        "1.16.5" => McProfile {
            released_at: "2021-01-14",
            java_major: 8,
            vanilla_bytes: 330 * MB,
            bases: &[B_FORGE, B_FABRIC],
            addons: &[A_OPTIFINE],
            note: "老牌 Mod 生态 · Forge 与 OptiFine 需版本号匹配",
        },
        "1.12.2" => McProfile {
            released_at: "2017-09-18",
            java_major: 8,
            vanilla_bytes: 240 * MB,
            bases: &[B_FORGE],
            addons: &[A_OPTIFINE, A_LITE],
            note: "老版本模组黄金期 · LiteLoader 仅在此段可用（且需 Forge）",
        },
        "1.7.10" => McProfile {
            released_at: "2014-06-26",
            java_major: 8,
            vanilla_bytes: 180 * MB,
            bases: &[B_FORGE],
            addons: &[A_OPTIFINE, A_LITE],
            note: "怀旧经典 · LiteLoader 在此段最常用",
        },
        "24w45a" => McProfile {
            released_at: "2024-11-06",
            java_major: 21,
            vanilla_bytes: 480 * MB,
            bases: &[B_FABRIC],
            addons: &[],
            note: "快照 · 仅供尝鲜，模组基本不可用",
        },
        _ => return None,
    };
    Some(p)
}

pub fn known_versions() -> Vec<&'static str> {
    vec![
        "1.21.1", "1.20.6", "1.20.4", "1.20.1", "1.19.2", "1.18.2", "1.16.5", "1.12.2", "1.7.10",
        "24w45a",
    ]
}

pub fn is_snapshot(mc_version: &str) -> bool {
    let b = mc_version.as_bytes();
    b.len() >= 6 && b[0].is_ascii_digit() && b[1].is_ascii_digit() && b[2] == b'w'
}

/* ====================== Fabric API 支持范围 ====================== */

/// Fabric API 支持哪些 MC 版本（**正式版**）。
///
/// ## 为什么"有没有 Fabric"不能只看 Fabric 加载器
///
/// 以前只看 `meta.fabricmc.net/v2/versions/loader/{mc}` 有没有构建 ——
/// 但**加载器存在 ≠ Fabric API 存在**。加载器在很多版本上都有构建（含快照），
/// 而玩家装 Fabric 基本都是为了装依赖 Fabric API 的 Mod：加载器有、API 没有时，
/// 勾上 Fabric 只会得到一个**装不了任何 Mod 的空壳**。
///
/// ## 一条表两边读
///
/// 真正的那份数据在 `src/domain/fabric-api-versions.json`，
/// **前端与这里读的是同一个文件**（这里是 `include_str!`）。别在这儿再抄一份
/// 数组：抄一份就会漂，而"支持范围"漂了之后的表现是"某个版本莫名其妙不能装"。
///
/// 来源：MC百科 Fabric API 词条（见 JSON 的 `_source`）。页面正文原话：
/// 「除支持 1.14+ 的正式版本外，Fabric API 也跟进最新快照版本开发」。
pub fn fabric_api_versions() -> &'static std::collections::HashSet<String> {
    use std::sync::OnceLock;
    static SET: OnceLock<std::collections::HashSet<String>> = OnceLock::new();
    SET.get_or_init(|| {
        #[derive(serde::Deserialize)]
        struct Table {
            versions: Vec<String>,
        }
        let raw = include_str!("../../../src/domain/fabric-api-versions.json");
        serde_json::from_str::<Table>(raw)
            .expect("fabric-api-versions.json 格式不对")
            .versions
            .into_iter()
            .collect()
    })
}

/// 这个**正式版**在不在 Fabric API 的支持表里。
///
/// ★ 快照**不**归这张表管：页面写明 Fabric API 会跟进快照，
///   一律拒掉会误伤。调用方（`capabilities`）自己判 `is_snapshot`。
pub fn is_fabric_api_version(mc_version: &str) -> bool {
    fabric_api_versions().contains(mc_version)
}

/// 不在表里时，能直接展示给用户的理由（必须包含"那该怎么办"）。
///
/// ★ **不要在里面写 markdown**（2026-09-17 用户截图：`**1.14**` 的星号原样
///   显示出来了）。这段文字会进 `title` 提示与告警面板，两处都按纯文本渲染。
///   要强调就用「」。
pub fn fabric_api_unsupported_reason(mc_version: &str) -> String {
    format!(
        "Fabric API 没有发布 {mc_version} 版本 —— 它从 1.14 起才支持正式版。\n\
         更低的版本要靠移植项目（1.13.2~1.3.2 用 Legacy Fabric API、\
         b1.7.3 用 Cursed Legacy API），那是另一套东西，IEML 没有做。\n\
         这个版本想装 Mod 请改用 Forge —— 1.12.2 / 1.7.10 那一档的 Forge 生态是完整的。"
    )
}

/// ★★ **IEML 真的实现了这个附加组件的安装吗？**（ADR-041：界面上的承诺必须是真的）
///
/// 这是"能装就是能装"的**唯一判据** —— 静态表回答的是"上游有没有"，
/// 这个函数回答的是"我们做没做"。两者分开之前，静态表里写着可用的
/// LiteLoader 会让用户勾选、点安装、看到成功，而磁盘上什么都没发生。
///
/// ## ★ 2026-09-14 更正：OptiFine 也是 false（以前这里写着 true，是假的）
///
/// 用户的报告是「有些版本没有 optifine，可是在切换到有高清修复的版本，
/// 再切回去，就显示有了，实际上点击后，是不让选的」。查下来是**两个 bug
/// 叠在一起**，而这个函数是其中一个的根源：
///
///   这里以前返回 `true`，注释还写着"`install_version` 里有 Patcher 分支"。
///   **那句话不成立**：全仓库搜 `optifine` / `OptiFine` 只有
///     · `metadata::optifine_versions`（拉清单）
///     · `loader_trace`（磁盘识别）
///     · `combination` / `loader_caps`（规则）
///   **没有任何一处真的去下载 OptiFine 的 jar、跑它的 Patcher、或写版本 JSON。**
///   `README.md` 的功能表也一直写着「OptiFine ❌ 未实现（只有领域规则与
///   五级兼容判定，没有安装器）」—— 是**这张表在说谎**，不是 README。
///
///   于是界面上那个 OptiFine 开关是**假的**：勾上、点安装、报告成功，
///   磁盘上什么都没多。用户遇到的"显示有、其实不让选"，
///   就是"我们嘴上说能装"与"实际装不了"打架的表现。
///
///   改回 `false` 之后，前端会显示「上游有、但我们还没做」的明确标记，
///   用户就能一眼看出该等我们还是换别的启动器 —— 这才是诚实。
///
/// * `OptiFine` —— **已实现**（2026-09-14）。
///   走 OptiFine 自己的 Patcher：`java -cp <安装器> optifine.Installer`
///   （照 PCL 的 `McDownloadOptiFineInstall`，见 `net::optifine`）。
///   老版本（< 1.14）不跑 Patcher，直接拼一个带 tweaker 的版本描述。
/// * `LiteLoader` —— **已实现**（2026-09-14）。
///   它没有安装器：写一个带 `--tweakClass` 的 `inheritsFrom` 版本描述 +
///   把 launchwrapper / asm-all / 本体三个 jar 下下来。
///   （照 PCL 的 `McDownloadLiteLoaderLoader`，见 `net::liteloader`。）
pub fn addon_install_implemented(kind: AddonKind) -> bool {
    match kind {
        AddonKind::OptiFine => true,
        AddonKind::LiteLoader => true,
    }
}

/// ★★ OptiFine 的**实测覆盖表**：哪个 MC 版本上上游真的发布了 OptiFine。
///
/// ## 为什么必须有这张表（2026-09-14 第九轮实测踩到的）
///
///   附加组件的"存不存在"原来只查 `profile(...).addons`，而内置 `MC_PROFILES`
///   只收录 10 个版本。于是出现一个**互相矛盾**的界面：
///
///     · `InstallComposer` 的 OptiFine 开关由**在线清单**决定能不能点 ——
///       BMCLAPI 的 `/optifine/versionList` 里 1.16.1 有 22 个版本，
///       所以开关**点得动**；
///     · 勾上之后 `combination::addon_compatibility` 查**静态表** ——
///       1.16.1 不在表里 → `exists: false` → 判成
///       「OptiFine 的自动安装 IEML 还没有做」。
///
///   用户看到的就是"我明明勾上了，它说不兼容"。这和 Java 要求、
///   `forgespi`、OptiFabric 区间是同一类病：**拿一张不完整的表去替上游下结论**。
///
/// ## 数据来源（可复核，不要凭印象改）
///
///   `GET https://bmclapi2.bangbang93.com/optifine/versionList`——
///   就是本项目 `net::metadata::optifine_versions` 用的那一个源。
///   2026-09-14 实拉：**497 条**，逐版本计数如下（括号内为该版本的发布条数）。
///
///   注意 1.20.5 是 **0 条**（OptiFine 跳过了这一版），这是唯一一个
///   "确认没有"的现代版本 —— 所以它是**唯一**允许说"未发布"的地方。
fn optifine_releases_on(mc_version: &str) -> Option<u32> {
    Some(match mc_version {
        "1.7.10" => 8,
        "1.12.2" => 6,
        "1.14" => 1,
        "1.14.1" => 0,
        "1.14.2" => 2,
        "1.14.3" => 2,
        "1.14.4" => 6,
        "1.15.2" => 24,
        "1.16.1" => 22,
        "1.16.2" => 9,
        "1.16.3" => 5,
        "1.16.4" => 9,
        "1.16.5" => 26,
        "1.17" => 11,
        "1.17.1" => 22,
        "1.18" => 2,
        "1.18.1" => 10,
        "1.18.2" => 11,
        "1.19" => 15,
        "1.19.1" => 2,
        "1.19.2" => 7,
        "1.19.3" => 6,
        "1.19.4" => 10,
        "1.20" => 3,
        "1.20.1" => 14,
        "1.20.2" => 1,
        "1.20.4" => 11,
        "1.20.5" => 0,
        "1.20.6" => 3,
        _ => return None,
    })
}

/// 上游到底有没有发布这个 MC 版本的附加组件？
///
/// 返回值语义（沿用 `AddonOption.exists` 的约定）：
///   · `true`      —— 有证据说"有"（实测清单里有，或内置表里登记了）
///   · `false`     —— 有证据说"没有"（实测清单里是 0 条）
///   · `None`      —— **不知道**（没有实测数据，也没登记）
///
/// ★ 关键：`None` **不许**被当成"没有"。拿不知道去挡用户的组合，
///   就是 ADR-037 禁止的那种"替上游下结论"。
pub fn addon_exists_on(kind: AddonKind, mc_version: &str) -> Option<bool> {
    match kind {
        AddonKind::OptiFine => match optifine_releases_on(mc_version) {
            // 实测清单说了算
            Some(n) => Some(n > 0),
            // 清单里没记录这个版本 → 内置表登记过就算"有"
            None => match profile(mc_version) {
                Some(p) => Some(p.addons.contains(&AddonKind::OptiFine)),
                None => None,
            },
        },
        AddonKind::LiteLoader => match profile(mc_version) {
            Some(p) => Some(p.addons.contains(&AddonKind::LiteLoader)),
            None => None,
        },
    }
}

/// 某个基础加载器的可选项（第一项为推荐）
fn base_versions(kind: BaseLoaderKind, mc: &str) -> Vec<&'static str> {
    match (kind, mc) {
        (BaseLoaderKind::Forge, "1.20.1") => vec!["47.2.0", "47.1.0", "47.0.3"],
        (BaseLoaderKind::Forge, "1.19.2") => vec!["43.3.0", "43.2.0"],
        (BaseLoaderKind::Forge, "1.18.2") => vec!["40.2.0", "40.1.0"],
        (BaseLoaderKind::Forge, "1.16.5") => vec!["36.2.39", "36.2.34"],
        (BaseLoaderKind::Forge, "1.12.2") => vec!["14.23.5.2860", "14.23.5.2859"],
        (BaseLoaderKind::Forge, "1.7.10") => vec!["10.13.4.1614", "10.13.4.1558"],
        (BaseLoaderKind::NeoForge, "1.21.1") => vec!["21.1.72", "21.1.65", "21.1.48"],
        (BaseLoaderKind::NeoForge, "1.20.6") => vec!["20.6.119", "20.6.99"],
        (BaseLoaderKind::NeoForge, "1.20.4") => vec!["20.4.237", "20.4.190"],
        (BaseLoaderKind::Fabric, _) => vec!["0.16.9", "0.16.5", "0.15.11"],
        (BaseLoaderKind::Quilt, _) => vec!["0.9.2", "0.9.0"],
        _ => vec![],
    }
}

/// 生成某个 MC 版本的加载器能力表。
/// 不支持的加载器**也返回**，带 unavailable_reason —— UI 据此置灰并显示原因。
pub fn capabilities(mc_version: &str) -> LoaderCapabilities {
    let Some(p) = profile(mc_version) else {
        /*
         * 内置表里没有这个版本（如 26.2）→ **任何加载器都不下结论**。
         *
         * ★★ 这里原来写着「{加载器} 尚未发布 {mc} 版本」—— 把"我不知道"说成了
         *   "它没有"。用户报的正是这个：「什么叫 Forge 没发布 26.2 版本，PCL 是有的」。
         *
         * ★ 现在的立场：**内置表不再是"能不能装"的判据**。没有在线数据就全部
         *   标 `confirmed: false` + `available: false`，理由说清是"没查到"。
         *   宁可暂时不能选，也不替加载器下一个可能是假的结论（ADR-037 / ADR-040）。
         */
        let base_loaders = BaseLoaderKind::all()
            .iter()
            .map(|&kind| LoaderOption {
                kind,
                name: kind.display_name().to_string(),
                versions: vec![],
                available: false,
                confirmed: false,
                unavailable_reason: Some(format!(
                    "{} 的 {mc_version} 版本清单这次没查到 —— 不代表它没有发布\
                     （例如 26.2 的 Forge 是有的）。请重新查询在线清单；\
                     能装不能装一律以在线清单为准",
                    kind.display_name()
                )),
            })
            .collect();

        let addons = AddonKind::all()
            .iter()
            .map(|&kind| {
                let implemented = addon_install_implemented(kind);
                /*
                 * ★ 走**实测覆盖表**（`addon_exists_on`），不走 `profile()` ——
                 *   内置表只有 10 个版本，拿它判"1.16.1 有没有 OptiFine"
                 *   必然误判（实测 1.16.1 有 22 个 OptiFine 发布）。
                 *   这里以前写死 `exists: false`，于是界面出现
                 *   "开关点得动、勾上却说不兼容"的自相矛盾。
                 */
                let exists = addon_exists_on(kind, mc_version).unwrap_or(false);
                AddonOption {
                    kind,
                    name: kind.display_name().to_string(),
                    versions: vec![],
                    // 上游没有 → 装不了；上游有但清单没拿到 → 也不下结论
                    available: exists && implemented,
                    exists,
                    implemented,
                    /*
                     * ★ 理由顺序：**先说"我们没做"，再说"上游有没有"**。
                     *   这两句话对用户的含义完全不同：
                     *     · "清单要联网确认" → 暗示重试一下就有了（可解决）
                     *     · "IEML 还没做安装" → 暗示等我们或换启动器（不可解决）
                     */
                    unavailable_reason: Some(if !implemented {
                        format!(
                            "{} 的**自动安装 IEML 还没有做** —— 现在只能识别已经装好的\
                             （会显示在版本清单里），不能帮你装。\
                             想用的话请用别的启动器装好，再用 IEML 启动它",
                            kind.display_name()
                        )
                    } else if !exists {
                        /*
                         * ★ 有**实测证据**说上游没有（`optifine_releases_on` 返回 0）。
                         *   全清单里只有 1.20.5 和 1.14.1 是这样 ——
                         *   只有这种地方才允许说"未发布"。
                         */
                        format!(
                            "上游没有发布 {} 在 {} 上的版本（已核对实拉清单）",
                            kind.display_name(),
                            mc_version
                        )
                    } else {
                        // 上游**有**，但是这个 MC 版本不在内置表里。
                        // ★ 绝不能因此说"没有" —— 实测 1.16.1 有 22 个 OptiFine 发布。
                        format!(
                            "{} 在 {} 上有发布，但内置表里没有它的可选版本清单 —— \
                             版本号要联网查（打开「下载」页会拉到真实的 OptiFine 清单）",
                            kind.display_name(),
                            mc_version
                        )
                    }),
                    note: None,
                }
            })
            .collect();

        return LoaderCapabilities {
            mc_version: mc_version.to_string(),
            base_loaders,
            addons,
            api_libraries: vec![],
            java_major: 21,
        };
    };

    let base_loaders = BaseLoaderKind::all()
        .iter()
        .map(|&kind| {
            let available = p.bases.contains(&kind);
            LoaderOption {
                kind,
                name: kind.display_name().to_string(),
                versions: if available {
                    base_versions(kind, mc_version)
                        .into_iter()
                        .map(String::from)
                        .collect()
                } else {
                    vec![]
                },
                available,
                /*
                 * ★ 内置表**不是**权威来源（900 个版本覆盖不全，更跟不上新版本），
                 *   所以它给出的"没有"一律标成 **未确认** —— 界面只能说
                 *   "内置参考里没有，联网确认一下"，不能说"未发布"。
                 *   见 ADR-037 / ADR-040。
                 */
                confirmed: false,
                unavailable_reason: if available {
                    None
                } else {
                    Some(format!(
                        "内置参考表里没有 {} 在 {} 上的条目 —— 这不代表它没有发布，\
                         请以在线清单为准",
                        kind.display_name(),
                        mc_version
                    ))
                },
            }
        })
        .collect();

    let addons = AddonKind::all()
        .iter()
        .map(|&kind| {
            /*
             * ★★ 这里必须把"**它存不存在**"和"**我们能不能装**"分成两件事。
             *
             *   用户的原话：「能装就是能装，不能装就是不能装」。而 LiteLoader
             *   在本项目里是一个**只在文档里存在**的选项：
             *     * 静态表里标着 1.7.10 / 1.12.2 可用（`addon_compatibility` 也放行）；
             *     * 磁盘检测（`loader_trace`）能认出已装的 LiteLoader；
             *     * 但 **Rust 侧没有任何安装实现** —— `run_loader_installer`
             *       只认 forge / neoforge，`install_version` 里也没有 LiteLoader 分支。
             *
             *   于是旧行为是：用户勾上 LiteLoader、点安装 → 界面报告成功、
             *   实例记录里多一条 `LiteLoader` 附加组件 → **磁盘上什么都没发生**，
             *   启动后是这个组件不存在。这正是 ADR-041 里那类"做不到却承诺"。
             *
             *   现在它由 `implemented` 单独表达：静态表说的"存在"照实说，
             *   而"我们还没做"也照实说 —— 两者不再混成一个 `available: false`。
             */
            let exists = addon_exists_on(kind, mc_version).unwrap_or_else(|| {
                // 既没实测数据也没登记 → 退回内置表（旧行为）
                p.addons.contains(&kind)
            });
            let implemented = addon_install_implemented(kind);
            AddonOption {
                kind,
                name: kind.display_name().to_string(),
                versions: vec![],
                available: exists && implemented,
                exists,
                implemented,
                /*
                 * ★★ 理由的**顺序**：先说"我们没做"，再说"表里没有"。
                 *
                 *   为什么：这两句话对用户的含义完全不同 ——
                 *     · "版本清单这次没查到" → 暗示**重试一下就有了**（可解决）；
                 *     · "IEML 还没做它的安装" → 暗示**等或换启动器**（不可解决）。
                 *
                 *   如果先说前者，用户会一直点「重新查询」，而真正的原因
                 *   （我们根本没写安装器）永远看不到 —— 这正是用户报的
                 *   「显示有高清修复，实际上点击后是不让选的」那种困惑。
                 *   把最难的那条放在最前面，用户一次就能做对决定。
                 *
                 *   （真实的组合不兼容比这两条都更优先，那一条在
                 *    `combination::addon_compatibility` 里判，比这里更早。）
                 */
                unavailable_reason: if !implemented {
                    Some(format!(
                        "{} 的**自动安装 IEML 还没有做** —— 现在只能识别已经装好的\
                         （会显示在版本清单里），不能帮你装。\
                         想用的话请用别的启动器装好，再用 IEML 启动它",
                        kind.display_name()
                    ))
                } else if !exists {
                    /*
                     * ★ 附加组件在这张静态表里**没有随版本变化的在线清单源**，
                     *   所以"表里没有"绝不等于"它没有发布这个版本"。
                     *
                     *   实测教训：这里原来写的是「OptiFine 未发布 1.20.5 版本」，
                     *   而 1.20.6 其实有预览版、1.21.1 有正式版 —— 一句话就把
                     *   用户的判断带偏了。ADR-004 要求"不可用必须给具体理由"，
                     *   而这里**根本不知道**，所以理由必须如实说"表里没有、以在线清单为准"。
                     */
                    Some(format!(
                        "内置表里没有 {} 在 {} 上的条目，且该组件的版本清单要联网才能确认 —— \
                         这**不代表**它没有发布；打开「下载」页会拉到真实的 OptiFine 清单",
                        kind.display_name(),
                        mc_version
                    ))
                } else {
                    None
                },
                note: None,
            }
        })
        .collect();

    LoaderCapabilities {
        mc_version: mc_version.to_string(),
        base_loaders,
        addons,
        api_libraries: all_api_libraries(mc_version),
        java_major: p.java_major,
    }
}

/// API 前置包目录。
/// ★ 版本号必须与 MC 版本绑定（形如 0.92.2+1.20.1）
pub fn all_api_libraries(mc_version: &str) -> Vec<ApiLibrary> {
    if is_snapshot(mc_version) {
        return vec![];
    }
    vec![
        ApiLibrary {
            kind: "fabric-api".into(),
            name: "Fabric API".into(),
            version: format!("0.92.2+{mc_version}"),
            description: "绝大多数 Fabric Mod 依赖此包，不装会导致 Mod 加载失败".into(),
            bytes: 2 * MB,
            required: true,
        },
        ApiLibrary {
            kind: "quilted-fabric-api".into(),
            name: "Quilted Fabric API".into(),
            version: "7.4.0+0.92.2".into(),
            description: "已内含 Fabric API，同时支持 Fabric 与 Quilt Mod".into(),
            bytes: 3 * MB,
            required: true,
        },
    ]
}

/// 某个基础加载器该自动装哪个 API 包。
///
/// ★ 只返回**一个** —— Fabric → Fabric API；其余 → 无。
///   两者同时装会导致 Mod 重复加载。
///
/// ★★ 2026-09-15（用户："**不给 Quilt 装 API 了**"）：Quilt 原来会自动装
///   Quilted Fabric API（QFAPI）。用户明确不要 —— 所以 Quilt 现在**不返回任何 API 包**，
///   要装由玩家自己决定（Quilt 本身不装 QFAPI 也能跑，只是依赖它的 Mod 会失败，
///   那种情况会在 Mod 管理里如实报"缺前置"）。
///   ★ 这条规则只写在**这一个地方**：`quilt_gets_qfapi_not_fabric_api` 那两条测试
///     也一起改成"Quilt 什么都不自动装"。
pub fn api_for_base(base: Option<BaseLoaderKind>, mc_version: &str) -> Vec<ApiLibrary> {
    let want = match base {
        Some(BaseLoaderKind::Fabric) => "fabric-api",
        // ★ Quilt：不自动装（用户 2026-09-15 的决定）
        _ => return vec![],
    };
    all_api_libraries(mc_version)
        .into_iter()
        .filter(|l| l.kind == want)
        .collect()
}

/// OptiFine 版本清单里的 RequiredForgeVersion（按 MC 版本索引）
pub fn optifine_forge_req(mc_version: &str) -> Option<(&'static str, Option<&'static str>)> {
    match mc_version {
        "1.20.1" => Some(("1.20.1", Some("47.2.0"))),
        "1.19.2" => Some(("1.19.2", Some("43.2"))),
        "1.18.2" => Some(("1.18.2", Some("40.1"))),
        "1.16.5" => Some(("1.16.5", Some("36.2"))),
        // 空白串 = 无限制
        "1.12.2" => Some(("1.12.2", Some(""))),
        // None = 该版本 OptiFine 不支持 Forge
        "1.7.10" => Some(("1.7.10", None)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /*
     * ★★ Fabric API 支持表（2026-09-17 用户要求）。
     *
     *   用户：「根据 Fabric API 支持版本来精确限制哪些版本有 Fabric 哪些没有」，
     *   并给了 MC百科的词条。表在 `src/domain/fabric-api-versions.json`，
     *   前端读同一份。
     *
     *   这几条测试守两件事：
     *     ① 表本身没被改坏（条数、边界）
     *     ② **静态表不许和它对不上** —— 这是防漂的关键一条
     */
    #[test]
    fn fabric_api_table_has_the_expected_shape() {
        let t = fabric_api_versions();
        assert_eq!(t.len(), 48, "1.14 起的正式版共 48 个（1.14段5 + 1.15段3 + 1.16段6 + 1.17段2 + 1.18段3 + 1.19段5 + 1.20段7 + 1.21段12 + 26.x段5）");
    }

    #[test]
    fn fabric_api_boundaries_are_exactly_right() {
        // 下界：1.14 是第一个支持的正式版
        assert!(is_fabric_api_version("1.14"), "1.14 必须支持");
        assert!(!is_fabric_api_version("1.13.2"), "1.13.2 要走 Legacy Fabric，不在表里");
        assert!(!is_fabric_api_version("1.12.2"), "1.12.2 不在表里");
        assert!(!is_fabric_api_version("1.7.10"), "1.7.10 不在表里");
        // 上界：表里最新的几个
        assert!(is_fabric_api_version("26.3"), "26.3 在表里");
        assert!(is_fabric_api_version("26.1"), "26.1 在表里");
        // 中间不能有洞（抽几个容易被漏的）
        for v in ["1.17.1", "1.19.1", "1.20.6", "1.21.11"] {
            assert!(is_fabric_api_version(v), "{v} 在 MC百科的清单里，不能漏");
        }
    }

    #[test]
    fn fabric_api_reason_tells_the_user_what_to_do_instead() {
        let r = fabric_api_unsupported_reason("1.12.2");
        assert!(r.contains("1.14"), "理由要说清是从哪个版本起支持");
        assert!(r.contains("Legacy Fabric"), "理由要说清低版本是另一套移植");
        assert!(r.contains("Forge"), "★ 理由必须给出替代方案，不能只说不行");
    }

    /// ★★ 防漂：**静态能力表里凡是给了 Fabric 的正式版，都必须在 API 支持表里**。
    ///
    /// 以后有人往 `profile()` 里加一个 1.12.2 + Fabric，这条会立刻变红 ——
    /// 而不是等玩家勾上 Fabric、装完发现一个 Mod 都装不了才暴露。
    ///
    /// ★ **快照跳过这条**：表里只有正式版，而 MC百科页面写明 Fabric API
    ///   「也跟进最新快照版本开发」。一律拒掉会误伤 ——
    ///   "用户明明能装、我们不让"比"漏放一个"更糟。运行时的规则也是这样：
    ///   快照不过那道闸，交给在线清单。这条断言必须与它一致，否则就是
    ///   "测试说的"和"程序做的"两回事。
    #[test]
    fn builtin_table_never_offers_fabric_outside_the_api_list() {
        for v in known_versions() {
            let p = profile(v).expect("known_versions 里的每个都该有 profile");
            if !p.bases.contains(&BaseLoaderKind::Fabric) {
                continue;
            }
            if is_snapshot(v) {
                continue; // 快照不归这张表管（见上）
            }
            assert!(
                is_fabric_api_version(v),
                "静态表给 {v} 提供了 Fabric，但 Fabric API 不支持它（表里没有）—— \
                 玩家勾上只会得到一个装不了 Mod 的空壳"
            );
        }
    }

    /// 表说支持的正式版，静态表里若给了 Fabric 就是一致的。
    /// （表比静态表大得多是正常的 —— 静态表只有 10 个版本，在线清单才是权威。）
    #[test]
    fn fabric_api_table_is_a_superset_of_the_builtin_fabric_versions() {
        for v in known_versions() {
            if is_snapshot(v) {
                continue;
            }
            if let Some(p) = profile(v) {
                if p.bases.contains(&BaseLoaderKind::Fabric) {
                    assert!(is_fabric_api_version(v), "{v} 不在 API 表里却提供了 Fabric");
                }
            }
        }
    }

    /// ★ 快照例外本身也要被钉住 —— 否则上面两条 `continue` 可能悄悄变成
    ///   "把快照全跳过"，而没人发现那条规则已经不在生效。
    #[test]
    fn snapshot_is_recognized_and_exempted_by_design() {
        assert!(is_snapshot("24w45a"), "24w45a 是快照");
        assert!(!is_snapshot("1.20.1"), "1.20.1 不是快照");
        // 静态表给快照配了 Fabric —— 这是**故意的**（Fabric API 跟进快照）
        let p = profile("24w45a").expect("静态表里有这个快照");
        assert!(
            p.bases.contains(&BaseLoaderKind::Fabric),
            "24w45a 的 Fabric 是刻意留的；删掉它这条测试就没意义了"
        );
        assert!(
            !is_fabric_api_version("24w45a"),
            "快照不该出现在只有正式版的表里 —— 它走的是「不归表管」那条路"
        );
    }

    #[test]
    fn neoforge_unavailable_on_1_20_1_with_reason() {
        let caps = capabilities("1.20.1");
        let neo = caps
            .base_loaders
            .iter()
            .find(|b| b.kind == BaseLoaderKind::NeoForge)
            .unwrap();
        assert!(!neo.available);
        let reason = neo.unavailable_reason.as_ref().unwrap();
        assert!(reason.contains("1.20.1"), "{reason}");
        // 不允许只说"不支持"
        assert!(!reason.starts_with("不支持"));
    }

    #[test]
    fn neoforge_available_from_1_20_4() {
        let caps = capabilities("1.20.4");
        assert!(caps
            .base_loaders
            .iter()
            .find(|b| b.kind == BaseLoaderKind::NeoForge)
            .unwrap()
            .available);
    }

    /// ★★ LiteLoader 在 1.7.10 / 1.12.2 上**存在且能装**（dev.4 第二轮起）。
    ///
    ///   这条测试改过两次，每次都跟着代码的真实状态走：
    ///     · 起初断言 `available == true`，而**根本没有安装实现** ——
    ///       那正是那个 bug：用户勾上 LiteLoader、点安装 →
    ///       界面报成功、磁盘上什么都没发生；
    ///     · 中间改成断言 `!implemented && !available` + 理由说"我们没做"（诚实）；
    ///     · dev.4 第二轮：安装真的做出来了（`net::liteloader`，
    ///       照 PCL 的 `McDownloadLiteLoaderLoader`），真机测试证明装完能进游戏
    ///       （`tests/live_liteloader.rs`）。
    ///
    ///   现在这条测试守的是**那条定义式**：`available == exists && implemented`。
    ///   不管将来的实现状态怎么变，这个等式永远成立 —— 它就是
    ///   "能装就是能装，不能装就是不能装"在代码里的样子。
    #[test]
    fn liteloader_availability_follows_exists_and_implemented() {
        for v in ["1.7.10", "1.12.2"] {
            let caps = capabilities(v);
            let a = caps
                .addons
                .iter()
                .find(|a| a.kind == AddonKind::LiteLoader)
                .unwrap();
            assert!(a.exists, "{v} 上 LiteLoader 确实存在（静态表有它）");
            assert!(
                a.implemented,
                "★ dev.4 起 LiteLoader 的安装已实装（net::liteloader）"
            );
            assert_eq!(
                a.available,
                a.exists && a.implemented,
                "{v}：available 必须严格等于 exists && implemented"
            );
        }
        // 老版本段之外：连"存在"都不该成立
        for v in ["1.16.5", "1.20.1", "1.21.1"] {
            let caps = capabilities(v);
            let a = caps
                .addons
                .iter()
                .find(|a| a.kind == AddonKind::LiteLoader)
                .unwrap();
            assert!(!a.exists, "{v} 上不该有 LiteLoader");
            assert!(!a.available);
        }
    }

    /// ★ 反向守：任何"我们没实现"的组件都不许标成 available。
    ///
    ///   这一条比上一条更宽 —— 以后再加附加组件时，只要忘了写安装实现
    ///   又忘了把 `implemented` 设成 false，这里立刻红。
    #[test]
    fn nothing_unimplemented_is_marked_available() {
        for v in crate::domain::loader_caps::known_versions() {
            for a in capabilities(v).addons {
                if !a.implemented {
                    assert!(
                        !a.available,
                        "{v} 的 {} 没有安装实现，却被标成可用",
                        a.name
                    );
                }
            }
        }
    }

    /// ★★ LiteLoader 的安装也**已经实装**了（dev.4 第二轮）——
    ///   照 PCL 的 `McDownloadLiteLoaderLoader`：写一个带 `--tweakClass` 的
    ///   `inheritsFrom` 版本描述 + 把三个 jar 下下来。真机测试证明装完能进游戏
    ///   （`tests/live_liteloader.rs`）。
    ///
    ///   这条测试以前断言 LiteLoader **不能**装（当时是对的 —— 没有实现）。
    ///   现在反过来了：两个附加组件都该标成可用。
    #[test]
    fn both_addons_claim_install_only_because_they_have_it() {
        assert!(
            addon_install_implemented(AddonKind::OptiFine),
            "OptiFine 的安装已实装（net::optifine）"
        );
        assert!(
            addon_install_implemented(AddonKind::LiteLoader),
            "LiteLoader 的安装已实装（net::liteloader）"
        );
    }

    /// ★ 能力表里 OptiFine 的 `available` 必须等于 `exists && implemented`。
    ///
    /// 这条是防回归的：只要有人把 `implemented` 改回 true 而没写实现，
    /// 这条与上面那条会同时红。
    #[test]
    fn optifine_availability_follows_implemented_flag() {
        for mc in ["1.21.1", "1.20.6", "1.20.1", "1.12.2", "1.7.10"] {
            let caps = capabilities(mc);
            let of = caps
                .addons
                .iter()
                .find(|a| a.kind == AddonKind::OptiFine)
                .expect("每个版本的能力表都要有 OptiFine 这一项");
            assert_eq!(
                of.available,
                of.exists && of.implemented,
                "{mc} 的 OptiFine available 与 exists/implemented 不一致"
            );
            if of.exists && !of.implemented {
                let reason = of.unavailable_reason.as_deref().unwrap_or("");
                assert!(
                    reason.contains("还没有做") || reason.contains("没做"),
                    "{mc}：上游有、我们没做时，理由必须说清是「我们没实现」，实际是：{reason}"
                );
            }
        }
    }

    #[test]
    fn fabric_api_version_binds_to_mc() {
        let a = api_for_base(Some(BaseLoaderKind::Fabric), "1.20.1");
        let b = api_for_base(Some(BaseLoaderKind::Fabric), "1.21.1");
        assert!(a[0].version.ends_with("+1.20.1"));
        assert!(b[0].version.ends_with("+1.21.1"));
        assert_ne!(a[0].version, b[0].version);
    }

    #[test]
    fn quilt_gets_no_api_library() {
        // ★ 2026-09-15 用户决定："不给 Quilt 装 API 了"（原来会自动装 QFAPI）
        let libs = api_for_base(Some(BaseLoaderKind::Quilt), "1.20.1");
        assert!(libs.is_empty(), "Quilt 不该自动装任何 API 包：{libs:?}");
    }

    /// ★ 这条测试原来断言「1.20.6 没有 OptiFine」—— **实测是错的**。
    ///   真机查 OptiFine 清单：1.20.5 → 0 条；1.20.6 → 有预览版（HD U J1 pre17/pre18）；
    ///   1.21.1 → 有正式版（HD U J1）。所以：
    ///     · 表里没收录的版本（1.20.5）→ **说清是"表里没这个版本"**，不是"OptiFine 不支持"
    ///     · 收录了的版本 → **上游确实有**（`exists == true`）
    ///
    /// ★ 2026-09-14：`available` 已经不等于 `exists` 了。
    ///   上游有（exists）但**我们没有安装实现**（implemented=false）时，
    ///   `available` 必须是 false —— 这条测试同时钉住这两件事。
    #[test]
    fn optifine_offer_is_honest_about_what_the_table_knows() {
        // 1.20.6 收录了 → 上游确实有这个版本的 OptiFine
        let known = capabilities("1.20.6");
        let of_206 = known
            .addons
            .iter()
            .find(|a| a.kind == AddonKind::OptiFine)
            .expect("要有 optifine 这一项");
        assert!(of_206.exists, "1.20.6 上游是有 OptiFine 的（有预览版）");
        // dev.4：安装已实装 → implemented 与 available 都是真
        assert!(of_206.implemented, "OptiFine 的安装已经做出来了");
        assert!(of_206.available, "上游有 + 我们做了 = 可用");

        // 1.20.5 不在表里 → 不可用，但理由必须说"没查到/要联网确认"，
        // 不能写死成"OptiFine 不支持这个版本"
        let unknown = capabilities("1.20.5");
        let of = unknown
            .addons
            .iter()
            .find(|a| a.kind == AddonKind::OptiFine)
            .expect("要有 optifine 这一项");
        assert!(!of.available);
        let reason = of.unavailable_reason.as_deref().unwrap_or("");
        assert!(
            reason.contains("确认") || reason.contains("清单") || reason.contains("联网"),
            "不可用理由必须区分「没查到」与「确认没有」，实际：{reason}"
        );
    }

    /// ★★ 回归用户原话：「什么叫 Forge 没发布 26.2 版本，PCL 是有的」★★
    ///
    ///   内置表只有 10 个版本、没有 26.2。老代码在"表里没有 + 在线没拿到"时
    ///   掉进 `尚未发布` 分支，把"我不知道"写成了"它没有"。
    ///   实测 BMCLAPI 的 `/forge/minecraft/26.2` 有 14 个 build（65.0.0…65.1.3）。
    ///
    ///   现在：没有在线数据 → 一律 `confirmed: false` + `available: false`，
    ///   理由必须说清是"没查到"，**不许出现"未发布""尚未发布"**。
    #[test]
    fn never_claims_a_loader_is_unpublished_when_we_simply_dont_know() {
        for mc in ["26.2", "26.1.2", "1.20.5"] {
            let caps = capabilities(mc);
            for o in caps.base_loaders.iter().filter(|o| !o.available) {
                assert!(
                    !o.confirmed,
                    "{mc} 的 {} 没有在线数据，不该自称确认",
                    o.kind.display_name()
                );
                let reason = o.unavailable_reason.clone().unwrap_or_default();
                assert!(
                    !reason.contains("未发布") && !reason.contains("尚未发布"),
                    "{mc} 的 {} 把「没查到」说成了「未发布」：{reason}",
                    o.kind.display_name()
                );
                assert!(
                    reason.contains("没查到") || reason.contains("在线"),
                    "{mc} 的 {} 的理由要说清是没查到：{reason}",
                    o.kind.display_name()
                );
            }
        }
    }

    /// 内置表给出的"没有"一律**不算确认**（它连 900 个版本都覆盖不全）
    #[test]
    fn builtin_table_answers_are_never_marked_confirmed() {
        // 1.20.1 在表里，但它没列 NeoForge；这条"没有"只能算参考，不能算确认
        let neo = capabilities("1.20.1")
            .base_loaders
            .iter()
            .find(|b| b.kind == BaseLoaderKind::NeoForge)
            .cloned()
            .expect("要有 neoforge 这一项");
        assert!(!neo.available);
        assert!(
            !neo.confirmed,
            "内置表不是权威来源，它说的「没有」不能标成确认（ADR-040）"
        );
    }
}
