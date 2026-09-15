//! Java 运行时选择（对应前端 `src/domain/java.ts`，ADR-013 / ADR-030）
//!
//! 源码事实（源码研读 12.6）：不是简单的"MC 版本 → Java 版本"查表，而是
//! **13 条带优先级的约束规则**，并且 `MODDED_JAVA_*` 规则**只在装了 Forge 系时生效**。
//! 这是原设计稿漏掉的关键分叉。

use crate::domain::version::{compare_version, VersionRange};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JavaRuntime {
    pub path: String,
    pub major: u32,
    pub version: String,
    pub vendor: String,
    pub arch: String,
    pub source: String,
    #[serde(default)]
    pub disabled_by_default: bool,
    #[serde(default)]
    pub bytes: u64,
}

#[derive(Debug, Clone)]
pub struct JavaConstraintInput {
    /// 原始版本字符串（`26.2` / `1.20.1` / `24w45a`）—— **理由文案要用它**。
    ///
    /// ★ 踩过一次：理由里原来是拿 `mc_segments` 拼的
    ///   （`format!("1.{}.{}", minor, patch)`），于是 `26.2` 被显示成
    ///   **"1.2.0"** —— 用户看到一句"1.2.0 的官方基线是 Java 21"，
    ///   完全对不上他点的那个版本。原始串必须原样留着。
    pub raw_version: String,
    /// 完整版本段，例如 [1, 20, 1]。★ 不能只存 major/minor ——
    /// "1.20.1" 的 minor 是 20 而不是 1，只存两段会让 1.20.1 被误判为 ≥1.20.5。
    mc_segments: [u32; 3],
    pub has_forge_like: bool,
    /// 具体是哪个（决定 Forge 老版本的上限规则）
    pub forge_kind_is_neoforge: bool,
    /// ★★ **Forge / NeoForge 自身的版本号**（如 `65.1.3` / `47.2.0`）。
    ///
    /// 为什么必须补上（P0-7）：PCL 的 `ModJava.vb` 201-234 行里有**一批规则
    /// 是按 Forge 补丁号分段的**（34.0.0 ~ 36.2.25 最高 Java 8u320、
    /// 36.2.26+ 最高 Java 23、37.0.0 ~ 37.0.79 最高 Java 16、
    /// 45.0.21 ~ 45.0.65 最高 Java 19、45.0.66 ~ 47.4.8 最高 Java 21）。
    /// 它们**只看游戏版本号是推不出来的** —— 同一个 1.16.5，
    /// Forge 36.2.25 与 36.2.26 的 Java 上限完全不同。
    ///
    /// 前端 `src/domain/java.ts` 一直有 `forgeVersion` 这个字段，
    /// 而 Rust 侧没有 → **同一台机器上"启动用哪个 Java"和"界面显示需要
    /// 哪个 Java"会得出不同答案**（铁律 1：规则只实现一次）。
    pub forge_version: Option<String>,
    /// ★★ **Fabric Loader 自身的版本号**（如 `0.19.5`）。
    ///
    /// 用途见 `FABRIC_LOADER_OLD`：Loader 0.17.0 之前的 Mixin/ASM 不兼容
    /// Java 25，所以那些版本**必须设上限**。没有这个字段就只能放弃这条规则。
    pub fabric_version: Option<String>,
    /// ★★ Mojang 在版本 JSON 里写的 `javaVersion.majorVersion`（26.2 = 25）。
    ///    见 `resolve_java_requirement` 里的说明 —— 不读这个字段就是
    ///    "Forge 版 mc 还没打开就崩溃"的直接原因。
    pub mojang_java_version: u32,
    /// 快照等"非标准版本号"（PCL 对这类版本会跳过一部分版本号规则）
    pub is_non_standard: bool,
    pub mod_count: u32,
    pub has_optifine: bool,
}

impl JavaConstraintInput {
    /// 老签名：只有版本号 + 三个布尔。**真机启动路径不要用这个** ——
    /// 它读不到 Mojang 声明的 Java 版本，26.2 + Forge 会因此崩在
    /// `Unrecognized VM option` 上。用 `detailed`。
    pub fn from(mc_version: &str, has_forge_like: bool, mod_count: u32, has_optifine: bool) -> Self {
        Self::detailed(mc_version, has_forge_like, mod_count, has_optifine, 0, false)
    }

    /// 带 Mojang 声明的版本要求（真机启动路径用这个）
    pub fn detailed(
        mc_version: &str,
        has_forge_like: bool,
        mod_count: u32,
        has_optifine: bool,
        mojang_java_version: u32,
        is_non_standard: bool,
    ) -> Self {
        let parsed: Vec<u32> = mc_version
            .split('.')
            .filter_map(|s| {
                let digits: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
                digits.parse().ok()
            })
            .collect();
        let seg = [
            parsed.first().copied().unwrap_or(1),
            parsed.get(1).copied().unwrap_or(0),
            parsed.get(2).copied().unwrap_or(0),
        ];
        Self {
            raw_version: mc_version.to_string(),
            mc_segments: seg,
            has_forge_like,
            forge_kind_is_neoforge: false,
            forge_version: None,
            fabric_version: None,
            mojang_java_version,
            is_non_standard,
            mod_count,
            has_optifine,
        }
    }

    /// 带上加载器**自身版本**（Forge/NeoForge/Fabric 的段位规则要用）。
    ///
    /// 与前端 `javaRequirementFor({ …, forgeVersion, fabricVersion })` 对齐：
    /// 两个字段的**有无**必须一致，否则两侧算出来的 Java 区间会不一样。
    pub fn with_loader(mut self, kind: &str, version: Option<&str>) -> Self {
        let v = version.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        match kind {
            "forge" => {
                self.has_forge_like = true;
                self.forge_kind_is_neoforge = false;
                self.forge_version = v;
            }
            "neoforge" => {
                self.has_forge_like = true;
                self.forge_kind_is_neoforge = true;
                self.forge_version = v;
            }
            /*
             * ★ Quilt **不算** Fabric：Quilt Loader 的版本号是 0.20.x 那一套，
             *   拿它去比 `0.17.0` 会得出一个**看着合理、其实无意义**的结论。
             *   Quilt 的 Java 基线由 MC 版本那几条规则覆盖（而 PCL 的 Fabric
             *   分支本来也只是"1.15~1.16 → 8+ / 1.18+ → 17+"，与基线重复）。
             */
            "fabric" => {
                self.fabric_version = v;
            }
            _ => {}
        }
        self
    }

    /// 当前版本 >= (a.b.c) 吗
    fn mc_at_least(&self, a: u32, b: u32, c: u32) -> bool {
        self.mc_segments >= [a, b, c]
    }
    /// 当前版本 <= (a.b.c) 吗
    fn mc_at_most(&self, a: u32, b: u32, c: u32) -> bool {
        self.mc_segments <= [a, b, c]
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct JavaRequirement {
    pub major: u32,
    pub range: VersionRange,
    /// 面向用户的一句话理由（禁止"不兼容"三个字，要给具体原因）
    pub reason: String,
    /// 命中的规则 id，便于调试与测试
    pub rule: String,
    /// ★ 每条约束的来历（界面要能一条条显示"为什么是这个范围"）
    pub constraints: Vec<JavaConstraint>,
}

/// 一条约束的来历（界面要能一条条显示"为什么是这个范围"）
#[derive(Debug, Clone, Serialize)]
pub struct JavaConstraint {
    pub rule: String,
    pub range: VersionRange,
    pub why: String,
}

/// `[a, b)` —— 测试与规则都用得上
#[allow(dead_code)]
fn r(min: f64, max: f64) -> VersionRange {
    VersionRange {
        min: Some(min),
        min_inclusive: true,
        max: Some(max),
        max_inclusive: false,
    }
}

/// `>= x`
fn at_least(v: f64) -> VersionRange {
    VersionRange {
        min: Some(v),
        min_inclusive: true,
        max: None,
        max_inclusive: true,
    }
}
/// `< x`
fn less_than(v: f64) -> VersionRange {
    VersionRange {
        min: None,
        min_inclusive: true,
        max: Some(v),
        max_inclusive: false,
    }
}
/// `[a, b)`
fn closed_open(a: f64, b: f64) -> VersionRange {
    VersionRange {
        min: Some(a),
        min_inclusive: true,
        max: Some(b),
        max_inclusive: false,
    }
}
/// `<= x`
///
/// ★ 用途：`FORGE_1_16_OLD`（Forge 34.0.0 ~ 36.2.25 最高 Java 8）。
///   PCL 的边界是 `AtMost(New Version(8, 0, 320))`，我们按主版本表达成 `<= 8`，
///   并把"8u320 及更早"这句写进理由里 —— 不假装我们区分得了补丁号。
fn at_most(v: f64) -> VersionRange {
    VersionRange {
        min: None,
        min_inclusive: true,
        max: Some(v),
        max_inclusive: true,
    }
}

/// 两个区间求交。空集返回 `None`。
fn intersect(a: &VersionRange, b: &VersionRange) -> Option<VersionRange> {
    let (mut min, mut min_inc) = (a.min, a.min_inclusive);
    if let Some(bmin) = b.min {
        match min {
            Some(amin) if amin > bmin => {}
            Some(amin) if amin == bmin => min_inc = a.min_inclusive && b.min_inclusive,
            _ => {
                min = Some(bmin);
                min_inc = b.min_inclusive;
            }
        }
    }
    let (mut max, mut max_inc) = (a.max, a.max_inclusive);
    if let Some(bmax) = b.max {
        match max {
            Some(amax) if amax < bmax => {}
            Some(amax) if amax == bmax => max_inc = a.max_inclusive && b.max_inclusive,
            _ => {
                max = Some(bmax);
                max_inc = b.max_inclusive;
            }
        }
    }
    if let (Some(lo), Some(hi)) = (min, max) {
        if lo > hi || (lo == hi && !(min_inc && max_inc)) {
            return None;
        }
    }
    Some(VersionRange {
        min,
        min_inclusive: min_inc,
        max,
        max_inclusive: max_inc,
    })
}

/// ★★ 计算该实例应使用的 Java 要求（**照 PCL 的算法逐条搬过来**）。
///
/// ## 为什么重写（用户报「Forge 版 mc 还没打开就报错崩溃了」）
///
///   用户的日志只有三行：
///   ```text
///   Error: Could not create the Java Virtual Machine.
///   Error: A fatal exception has occurred. Program will exit.
///   Unrecognized VM option 'UseCompactObjectHeaders'
///   ```
///   游戏**一行自己的日志都没来得及写** —— JVM 在启动前就拒绝了参数。
///
///   链路是这样的：
///     ① `26.2` 的版本 JSON 写着 `"javaVersion": {"majorVersion": 25}`
///        —— Mojang 明确要求 Java 25；
///     ② 我们的规则表只有一条 `MC_1_20_5_PLUS → Java 21，区间 [21,24)`，
///        **从没读过 JSON 里那个字段**，于是 26.2 被判成"要 Java 21"；
///     ③ Forge 65.1.3 的 profile 里有 `-XX:+UseCompactObjectHeaders`
///        （Java 24 才有），Java 21 直接拒绝启动。
///
///   老实现的根本问题是"**第一条命中的规则胜出**"：它把下限和上限
///   混成一个区间，后写的规则无法收紧前面写下的上限。
///
///   现在照 `ModJava.vb` 的 `GetJavaRequirement`（128-265 行）改成
///   **多条约束求交集**，每条都留下来历（`constraints`）。
pub fn resolve_java_requirement(i: JavaConstraintInput) -> JavaRequirement {
    let mut constraints: Vec<JavaConstraint> = Vec::new();
    let mut range = VersionRange {
        min: None,
        min_inclusive: true,
        max: None,
        max_inclusive: true,
    };
    let mut violated: Vec<JavaConstraint> = Vec::new();

    // 用闭包收集约束；交集为空时**不沉默**，记进 violated
    macro_rules! add {
        ($rule:expr, $rng:expr, $why:expr) => {{
            let rng: VersionRange = $rng;
            let why: String = $why;
            match intersect(&range, &rng) {
                Some(next) => {
                    range = next;
                    constraints.push(JavaConstraint {
                        rule: $rule.to_string(),
                        range: rng,
                        why,
                    });
                }
                None => violated.push(JavaConstraint {
                    rule: $rule.to_string(),
                    range: rng,
                    why,
                }),
            }
        }};
    }

    /* ---------- ① 原版基线（ModJava.vb 152-171） ---------- */
    if !i.is_non_standard && i.mc_at_least(1, 20, 5) {
        add!(
            "MC_1_20_5_PLUS",
            at_least(21.0),
            format!(
                "{} 的官方基线是 Java 21（Mojang 从 1.20.5 起提高）",
                i.raw_version
            )
        );
    } else if !i.is_non_standard && i.mc_at_least(1, 18, 0) {
        add!(
            "MC_1_18_PLUS",
            at_least(17.0),
            format!("{} 的官方基线是 Java 17", i.raw_version)
        );
    } else if !i.is_non_standard && i.mc_at_least(1, 17, 0) {
        add!("MC_1_17", at_least(16.0), "1.17 是 Java 16 → 17 的过渡版本".into());
    } else if !i.is_non_standard && i.mc_at_least(1, 12, 0) && i.mc_at_most(1, 16, 5) {
        add!(
            "MC_1_12_TO_1_16",
            at_least(8.0),
            format!("{} 的官方基线是 Java 8", i.raw_version)
        );
        /*
         * ★★ 还要一条**上限** —— 光有下限是不够的，这是实测出来的。
         *
         *   这条测试（`legacy_versions_still_require_java_8`）第一版红了，
         *   红得对：改成"求交集"之后，基线规则只剩下限 `>= 8`，
         *   于是**纯原版 1.12.2 在区间上允许 Java 25**。
         *
         *   而 1.12.2 跑在 Java 25 上是"能起、能进世界、随时崩"的组合
         *   （LWJGL 2 的 Unsafe/反射在老版本上本来就不稳）。
         *   用户的要求是「无论什么加载器还是原版，你至少都得让玩家能玩」——
         *   所以**有 Java 8 可用的机器上，就不该给 1.12 派一个 Java 25**。
         *
         *   PCL 在纯原版这条路径上只写下限（`ModJava.vb` 165-167），
         *   但它同时会给 Forge / OptiFine 补上限。我们把这个上限**统一加上**，
         *   因为我们没有 PCL 那套"按发布时间猜非标准版本"的信息，
         *   宁可保守：老版本就用老 Java，这是最不容易出事的组合。
         *
         *   例外：机器上**只有** Java 17+ 时，区间内一个都没有 →
         *   `find_java_by_requirement` 会明确报错并告诉用户装 Java 8，
         *   而不是偷偷拿 Java 25 去跑（那正是上一轮的 bug 形态）。
         */
        add!(
            "MC_LEGACY_MAX_JAVA",
            less_than(12.0),
            "1.12 ~ 1.16.5 是 Java 8 时代的版本，用更新的 Java 容易起不来".into()
        );
    } else if i.mc_at_most(1, 5, 2) {
        /*
         * ★ 1.5.2 及更早：最高 Java 8（PCL `ModJava.vb` 168-171）。
         *
         *   这里原来是 `mc_at_most(1, 11, 2)` —— **比 PCL 和前端都宽**：
         *   它会给 1.6 ~ 1.11.2 也加上"最高 Java 8"这条上限，
         *   而 PCL 对那一段**不设任何基线约束**（2017 年那条例外把
         *   1.12~1.16 划到"至少 8"，1.6~1.11 落在两条例外之间）。
         *   于是 1.7.10 + 某加载器在界面上（TS）说"可以用 Java 17"、
         *   而启动时（Rust）说"最高 Java 8" —— 同一台机器两个答案。
         *   现在两边都按 PCL 的边界来。
         */
        add!("MC_LEGACY_MAX8", less_than(9.0), format!("{} 属于老版本，最高只能用到 Java 8", i.raw_version));
    }

    /* ---------- ② Mojang 自己写的 javaVersion（ModJava.vb 173-185） ---------- */
    if i.mojang_java_version >= 22 {
        /*
         * ★ 只在这个值 >= 22 时才采信 —— PCL 也是这么写的。
         *   更小的值交给版本号规则（老版本 JSON 里这个字段可能是错的/过期的）。
         *   >= 22 意味着"Mojang 明确要求了一个新版本"，那一定有原因。
         */
        add!(
            "MOJANG_JAVA_VERSION",
            at_least(i.mojang_java_version as f64),
            format!(
                "这个版本的描述文件里写着需要 Java {}（Mojang 自己的声明）",
                i.mojang_java_version
            )
        );
    }

    /* ---------- ③ OptiFine（ModJava.vb 187-199） ---------- */
    if i.has_optifine {
        if i.mc_at_most(1, 6, 4) {
            add!("OPTIFINE_MAX8", less_than(9.0), "OptiFine 在 1.7 之前依赖 Java 8".into());
        } else if i.mc_at_least(1, 8, 0) && i.mc_at_most(1, 11, 2) {
            add!("OPTIFINE_EXACT8", closed_open(8.0, 9.0), "OptiFine 在 1.8 ~ 1.11 上必须用 Java 8".into());
        } else if i.mc_at_least(1, 12, 0) && i.mc_at_most(1, 12, 2) {
            add!("OPTIFINE_MAX8_112", less_than(9.0), "OptiFine 在 1.12 上最高只能用到 Java 8".into());
        } else if i.mc_at_most(1, 16, 5) {
            add!("OPTIFINE_MAX8_116", less_than(9.0), "OptiFine 在 1.16.5 及更早版本上依赖 Java 8".into());
        }
    }

    /* ---------- ④ Forge（ModJava.vb 201-234） ---------- */
    if i.has_forge_like && !i.forge_kind_is_neoforge {
        /*
         * ★★ Forge **自身版本**的两条比较（P0-7）。
         *
         *   PCL 用的 `CompareVersionGE(a, b)` 是"a >= b"，注意参数顺序：
         *     `CompareVersionGE(Instance.Version.Forge, "34.0.0")` → Forge >= 34.0.0
         *     `CompareVersionGE("36.2.25", Instance.Version.Forge)` → 36.2.25 >= Forge
         *   两条一起才是"区间"。前端 `forgeAtLeast/forgeAtMost` 与它逐字对应，
         *   这里也照抄 —— 少一个 `!` 就会把"最高 Java 23"变成"最低 Java 23"。
         */
        let fv = i.forge_version.clone().unwrap_or_default();
        let fv_known = !fv.trim().is_empty();
        let forge_at_least = |v: &str| fv_known && compare_version(&fv, v) != Ordering::Less;
        let forge_at_most = |v: &str| fv_known && compare_version(v, &fv) != Ordering::Less;

        if i.mc_at_least(1, 6, 1) && i.mc_at_most(1, 7, 2) {
            add!("FORGE_1_6_TO_1_7_2", closed_open(7.0, 8.0), "Forge 在 1.6.1 ~ 1.7.2 上必须用 Java 7".into());
        } else if i.mc_at_most(1, 12, 2) {
            add!("FORGE_LE_1_12", less_than(9.0), format!("Forge 在 {} 上最高只能用到 Java 8", i.raw_version));
        } else if i.mc_at_most(1, 14, 4) {
            add!("FORGE_1_13_TO_1_14", closed_open(8.0, 11.0), "Forge 在 1.13 ~ 1.14 上只能用到 Java 8 ~ 10".into());
        } else if i.mc_at_most(1, 15, 2) {
            add!("FORGE_1_15", closed_open(8.0, 16.0), "Forge 在 1.15 上只能用到 Java 8 ~ 15".into());
        } else if forge_at_least("34.0.0") && forge_at_most("36.2.25") {
            /*
             * ★ `AtMost(New Version(8, 0, 320))`：PCL 精确到 Java 8u320
             *   （JDK-8273826：Java 8u321+ 会让 1.16 的 Forge 崩）。
             *   我们的区间是按**主版本**算的（8.0 就是"Java 8"），
             *   所以只能表达成"最高 Java 8"，并把这句限制写进理由里 ——
             *   撒谎说"随便哪个 8u 都行"是不对的。
             */
            add!(
                "FORGE_1_16_OLD",
                at_most(8.0),
                format!("Forge {fv}（1.16.3~1.16.5）最高只支持 Java 8 —— 而且要 8u320 及更早")
            );
        } else if forge_at_least("36.2.26") && forge_at_most("37.0.0") {
            add!(
                "FORGE_1_16_NEW",
                less_than(24.0),
                format!("Forge {fv}（1.16.5）最高只支持到 Java 23")
            );
        } else if forge_at_least("37.0.0") && forge_at_most("37.0.79") {
            add!(
                "FORGE_1_17_1",
                less_than(17.0),
                format!("Forge {fv}（1.17.1）最高只支持到 Java 16")
            );
        } else if i.mc_at_least(1, 18, 0) && i.mc_at_most(1, 18, 2) && i.has_optifine {
            add!("FORGE_1_18_OPTIFINE", less_than(19.0), "1.18 的 Forge 搭配 OptiFine 时最高只支持到 Java 18".into());
        } else if forge_at_least("45.0.21") && forge_at_most("45.0.65") {
            add!(
                "FORGE_1_19_4_OLD",
                less_than(20.0),
                format!("Forge {fv}（1.19.4）最高只支持到 Java 19")
            );
        } else if forge_at_least("45.0.66") && forge_at_most("47.4.8") {
            add!(
                "FORGE_1_19_4_TO_1_20_1",
                less_than(22.0),
                format!("Forge {fv}（1.19.4 ~ 1.20.1）最高只支持到 Java 21")
            );
        }
        /*
         * ★★ 新版 Forge（47.4.8 之后 / 1.20.2+）**不设上限**。
         *
         *   老实现有一条 `MODDED_JAVA_21 → 区间 [17,22)`，对
         *   26.2 + Forge 65.1.3 是致命的：它把 Java 25 挡在外面，
         *   于是只能选 Java 21 —— 而 Forge 65 需要 Java 24+。
         *   这正是用户"还没打开就崩溃"的直接原因。
         */
    }
    /* ---------- ⑤ NeoForge（ModJava.vb 236-243） ---------- */
    if i.forge_kind_is_neoforge {
        let nv = i.forge_version.clone().unwrap_or_default();
        let is_1201 = i.mc_at_least(1, 20, 1) && i.mc_at_most(1, 20, 1);
        /*
         * ★ 1.20.2 的 **20.2.62-beta 之前**也有上限。
         *
         *   PCL：`CompareVersionGE("20.2.62-beta", NeoForge) AndAlso
         *         Not NeoForge.Contains("25w14craftmine")`
         *   —— 也就是"NeoForge <= 20.2.62-beta"，且排除那个特殊快照。
         *   Rust 侧原来只判了 1.20.1，**漏了 1.20.2 这一段**：
         *   于是 1.20.2 + NeoForge 20.2.50 会被派一个 Java 22+，
         *   而那一版 NeoForge 在 Java 22 上起不来。
         */
        let early_1202 = !nv.trim().is_empty()
            && compare_version("20.2.62-beta", &nv) != Ordering::Less
            && !nv.contains("25w14craftmine");
        if is_1201 || early_1202 {
            add!("NEOFORGE_1_20_1", less_than(22.0), "NeoForge 在这个版本段上最高只支持到 Java 21".into());
        }
    }

    /* ---------- ⑥ Fabric（ModJava.vb 245-259） ---------- */
    if let Some(fv) = i.fabric_version.clone() {
        if i.mc_at_least(1, 15, 0) && i.mc_at_most(1, 16, 5) {
            add!("FABRIC_1_15_1_16", at_least(8.0), "Fabric 在 1.15 ~ 1.16 上至少需要 Java 8".into());
        } else if i.mc_at_least(1, 18, 0) {
            add!("FABRIC_1_18_PLUS", at_least(17.0), "Fabric 在 1.18 及以上至少需要 Java 17".into());
        }
        if !fv.trim().is_empty() && compare_version(&fv, "0.17.0") == Ordering::Less {
            /*
             * ★ Fabric Loader 0.17.0 之前的 Mixin/ASM 不兼容 Java 25。
             *
             *   实测本机的 Fabric 是 0.19.5 —— **不受这条限制**，所以它可以用
             *   Mojang 要求的 Java 25。这条留着是为了老实例（0.16.x）不出事。
             */
            add!(
                "FABRIC_LOADER_OLD",
                less_than(25.0),
                format!("Fabric Loader {fv} 的 Mixin/ASM 还不兼容 Java 25（0.17.0 起才支持）")
            );
        }
    }

    if i.has_forge_like && i.mod_count >= 120 {
        add!(
            "MODDED_MANY_MODS",
            at_least(17.0),
            format!("装了 {} 个 Mod，Java 17 及以上对大量 Mod 的类加载更稳定", i.mod_count)
        );
    }

    /* ---------- 收尾 ---------- */
    /*
     * `major` 的语义：**满足全部约束的最低版本**（区间下限）。
     *
     * ★ 为什么是"最低"而不是"最高"：
     *   · 它是"这个版本**至少**要 Java 几"这句话的答案，界面就是这么用的；
     *   · 实际挑哪一个由 `pick_java` 决定 —— 它在区间内**从高往低**挑
     *     （新版本通常更稳，也更可能是 Forge/Mojang 真正期望的那个）；
     *   · 两者分开之后，"要求"与"选择"就不会互相污染。老代码把两者
     *     混在同一个数字里，才出现了"26.2 建议 Java 21、区间却是 ≥25"
     *     这种自相矛盾的状态 —— 那个矛盾就是 Forge 崩溃的源头。
     *   · 区间无下限时（极罕见）退回一个保守值。
     */
    let major = range.min.unwrap_or(8.0) as u32;
    let reason = if !violated.is_empty() {
        format!(
            "Java 版本要求互相冲突 —— {}。请在实例设置里手动指定一个 Java 试试",
            violated
                .iter()
                .map(|v| v.why.clone())
                .collect::<Vec<_>>()
                .join("；")
        )
    } else if constraints.is_empty() {
        "没有特别的 Java 要求，用任意可用的 Java 即可".to_string()
    } else {
        constraints
            .iter()
            .map(|c| c.why.clone())
            .collect::<Vec<_>>()
            .join("；")
    };

    JavaRequirement {
        major,
        range,
        reason,
        rule: constraints
            .first()
            .map(|c| c.rule.clone())
            .unwrap_or_else(|| "NO_CONSTRAINT".into()),
        constraints,
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct JavaPickResult {
    pub runtime: Option<JavaRuntime>,
    pub reason: String,
    pub requirement: JavaRequirement,
}

/// 按四种模式挑选 Java（ADR-030）
pub fn pick_java(
    mode: &str,
    runtimes: &[JavaRuntime],
    input: JavaConstraintInput,
    range: Option<VersionRange>,
    path: Option<&str>,
) -> JavaPickResult {
    let req = resolve_java_requirement(input);

    match mode {
        "path" => {
            let found = path.and_then(|p| runtimes.iter().find(|r| r.path == p).cloned());
            let reason = match &found {
                Some(rt) => format!("使用你手动指定的 {} {}", rt.vendor, rt.version),
                None => format!("指定的 Java 已不存在：{}", path.unwrap_or("(未指定)")),
            };
            JavaPickResult {
                runtime: found,
                reason,
                requirement: req,
            }
        }
        "instance-folder" => {
            let found = runtimes
                .iter()
                .find(|r| r.source == "instance")
                .cloned();
            let reason = match &found {
                Some(rt) => format!("使用实例文件夹中的 {}", rt.version),
                None => {
                    "实例文件夹里没有找到 Java —— 整合包自带 Java 的话，请确认 java 目录存在".into()
                }
            };
            JavaPickResult {
                runtime: found,
                reason,
                requirement: req,
            }
        }
        "range" => {
            let Some(range) = range else {
                return JavaPickResult {
                    runtime: None,
                    reason: "未填写区间".into(),
                    requirement: req,
                };
            };
            let best = runtimes
                .iter()
                .filter(|rt| range.contains(rt.major as f64))
                .max_by_key(|rt| rt.major)
                .cloned();
            let reason = match &best {
                Some(rt) => format!("区间内最高版本：{}", rt.version),
                None => format!(
                    "没有满足区间 {} 的 Java，请调整区间或安装对应版本",
                    range.format()
                ),
            };
            JavaPickResult {
                runtime: best,
                reason,
                requirement: req,
            }
        }
        _ => {
            // auto：优先精确命中要求的主版本
            let usable: Vec<&JavaRuntime> = runtimes
                .iter()
                .filter(|r| !r.disabled_by_default)
                .collect();
            let exact: Vec<&&JavaRuntime> =
                usable.iter().filter(|r| r.major == req.major).collect();
            if let Some(best) = exact.iter().max_by(|a, b| {
                compare_version(&b.version, &a.version)
            }) {
                let rt = (**best).clone();
                return JavaPickResult {
                    reason: format!("{}；已匹配到 {} {}", req.reason, rt.vendor, rt.version),
                    runtime: Some(rt),
                    requirement: req,
                };
            }
            // 退而求其次：允许区间内任意版本
            let inside: Vec<&&JavaRuntime> = usable
                .iter()
                .filter(|r| req.range.contains(r.major as f64))
                .collect();
            if let Some(best) = inside.iter().max_by_key(|r| r.major) {
                let rt = (**best).clone();
                return JavaPickResult {
                    reason: format!(
                        "没有找到 Java {}，改用区间 {} 内可用的 {}",
                        req.major,
                        req.range.format(),
                        rt.version
                    ),
                    runtime: Some(rt),
                    requirement: req,
                };
            }
            JavaPickResult {
                runtime: None,
                reason: format!(
                    "没有找到可用的 Java —— {}；需要 Java {}",
                    req.reason, req.major
                ),
                requirement: req,
            }
        }
    }
}

/// 判断某个 MC 版本是否至少为给定版本
pub fn mc_gte(mc: &str, target: &str) -> bool {
    compare_version(mc, target) != Ordering::Less
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rt(major: u32, source: &str) -> JavaRuntime {
        JavaRuntime {
            path: format!("/j{major}/javaw.exe"),
            major,
            version: format!("{major}.0.1"),
            vendor: "Temurin".into(),
            arch: "x64".into(),
            source: source.into(),
            disabled_by_default: false,
            bytes: 0,
        }
    }

    #[test]
    fn baseline_rules_by_mc_version() {
        let r21 = resolve_java_requirement(JavaConstraintInput::from("1.21.1", false, 0, false));
        assert_eq!(r21.major, 21);
        let r17 = resolve_java_requirement(JavaConstraintInput::from("1.20.1", false, 0, false));
        assert_eq!(r17.major, 17);
        let r8 = resolve_java_requirement(JavaConstraintInput::from("1.16.5", false, 0, false));
        assert_eq!(r8.major, 8);
    }

    #[test]
    fn modded_rules_only_apply_with_forge_like() {
        // ★ 这是原设计稿漏掉的分叉（现在体现为"只收紧下限，不改上限"）
        let with = resolve_java_requirement(JavaConstraintInput::from("1.20.1", true, 150, false));
        let without =
            resolve_java_requirement(JavaConstraintInput::from("1.20.1", false, 150, false));
        // 带 Forge 与不带 Forge，1.20.1 的下限都是 17（基线），
        // 但带 Forge 时会因为 Mod 数多而多出一条约束
        assert_eq!(with.major, 17);
        assert_eq!(without.major, 17);
        assert!(with.constraints.len() > without.constraints.len());
        assert!(with.constraints.iter().any(|c| c.rule == "MODDED_MANY_MODS"));
        assert!(!without.constraints.iter().any(|c| c.rule == "MODDED_MANY_MODS"));
    }

    /// ★★ 这条是用户报的「Forge 版 mc 还没打开就报错崩溃」的**回归测试**。
    ///
    ///   现场：
    ///     `Unrecognized VM option 'UseCompactObjectHeaders'`
    ///     `Error: Could not create the Java Virtual Machine.`
    ///
    ///   `UseCompactObjectHeaders` 是 Java **24** 才有的选项，写在
    ///   Forge 65.1.3 的 profile 里；而 26.2 的版本 JSON 写着
    ///   `"javaVersion": {"majorVersion": 25}` —— **Mojang 要 Java 25**。
    ///
    ///   老规则表只认 `>= 1.20.5 → Java 21`（而且上限还写死在 24），
    ///   于是选到 Java 21 → JVM 在启动前就拒绝参数 → 游戏一行日志都没有。
    #[test]
    fn forge_on_modern_mc_requires_mojang_declared_java() {
        // 26.2 + Forge 65.1.3：Mojang 声明要 Java 25
        let input = JavaConstraintInput::detailed("26.2", true, 0, false, 25, false);
        let req = resolve_java_requirement(input.clone());
        assert!(
            req.range.contains(25.0),
            "★ Java 25 必须落在区间内，实际区间 {}",
            req.range.format()
        );
        assert!(
            !req.range.contains(21.0),
            "★★ Java 21 **不能**落在区间内 —— 它跑不了 Forge 65 的启动参数（这就是崩溃原因），实际区间 {}",
            req.range.format()
        );

        // 且自动挑选必须挑到 Java 25，不能挑 21
        let pool = vec![rt(8, "system"), rt(21, "mojang"), rt(25, "registry")];
        let p = pick_java("auto", &pool, input.clone(), None, None);
        assert_eq!(
            p.runtime.expect("应该能选到 Java").major,
            25,
            "★★ 应该选区间内最高的 Java 25，而不是 21"
        );
    }

    /// 反过来守住：Mojang 声明的值**小于 22 时不采信**
    /// （老版本 JSON 里那个字段可能是错的/过期的，采信它会把区间弄坏）。
    #[test]
    fn mojang_java_version_below_22_is_ignored() {
        let with = JavaConstraintInput::detailed("1.20.1", false, 0, false, 17, false);
        let req = resolve_java_requirement(with);
        assert!(
            !req.constraints.iter().any(|c| c.rule == "MOJANG_JAVA_VERSION"),
            "17 < 22，不该当成约束"
        );
        assert!(req.range.contains(17.0));
        assert!(req.range.contains(21.0), "1.20.1 允许更高的 Java");
    }

    /// 老版本仍然要 Java 8，而且**不许**被新版规则放宽。
    #[test]
    fn legacy_versions_still_require_java_8() {
        let r = resolve_java_requirement(JavaConstraintInput::from("1.12.2", false, 0, false));
        assert!(r.range.contains(8.0));
        assert!(
            !r.range.contains(17.0) && !r.range.contains(21.0) && !r.range.contains(25.0),
            "1.12.2 只能 Java 8，实际区间 {}",
            r.range.format()
        );
        // Forge 1.12.2 也一样
        let rf = resolve_java_requirement(JavaConstraintInput::from("1.12.2", true, 0, false));
        assert!(!rf.range.contains(17.0));
    }

    /// OptiFine 在老版本上的 Java 8 要求仍在。
    #[test]
    fn optifine_legacy_needs_java_8() {
        let r = resolve_java_requirement(JavaConstraintInput::from("1.16.5", false, 0, true));
        assert!(r.range.contains(8.0));
        assert!(
            !r.range.contains(17.0),
            "OptiFine + 1.16.5 不能用 Java 17，实际区间 {}",
            r.range.format()
        );
    }

    /* ====================== ★★ 跨语言判据表（P0-7） ====================== */

    /// 这份表**两边共用**：`tests/java-rules.cases.json`
    /// （TS 侧的对应用例在 `tests/java-rules.test.mjs`）。
    ///
    /// ## 为什么要有它
    ///
    ///   「这个版本需要 Java 几」有两份实现 —— Rust（启动时真的按它挑 Java）
    ///   与 TS（界面显示那个数字）。两边漂移的后果不是"显示不好看"，
    ///   而是**用户被两个答案骗**：界面说 17、启动说需要 25。
    ///   本轮（P0-7）之前它们就真的不一样：
    ///   Rust 缺 `forge_version` / `fabric_version` 两个字段，
    ///   于是 Forge 补丁号那 5 条规则与 Fabric 那 3 条**只有前端会生效**。
    ///
    ///   现在两侧读同一份表、跑各自的引擎、比对同一个期望区间字符串
    ///   （`VersionRange::format()` ↔ `formatJavaRange`）。
    #[test]
    fn java_rules_table_matches_rust_engine() {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Case {
            name: String,
            mc: String,
            #[serde(default)]
            loader: Option<String>,
            #[serde(default)]
            loader_version: Option<String>,
            #[serde(default)]
            optifine: bool,
            #[serde(default)]
            mojang_java: u32,
            expect: String,
        }
        #[derive(serde::Deserialize)]
        struct Table {
            cases: Vec<Case>,
        }

        // 判据表放在仓库根的 tests/ 下（与 TS 侧同一个文件）
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/java-rules.cases.json");
        let text = std::fs::read_to_string(path).unwrap_or_else(|e| {
            panic!("读不到跨语言判据表 {path}：{e}（它必须存在，两边共用）")
        });
        let table: Table = serde_json::from_str(&text).expect("判据表不是合法 JSON");
        assert!(
            table.cases.len() >= 20,
            "判据表只有 {} 条 —— 太少，覆盖不到两套规则的分叉点",
            table.cases.len()
        );

        for c in &table.cases {
            let kind = c.loader.as_deref().unwrap_or("");
            let input = JavaConstraintInput::detailed(
                &c.mc,
                false, // 由 with_loader 依 kind 设定
                0,
                c.optifine,
                c.mojang_java,
                false,
            )
            .with_loader(kind, c.loader_version.as_deref());

            let got = resolve_java_requirement(input).range.format();
            assert_eq!(got, c.expect, "{}\n  mc={} loader={kind:?} v={:?}", c.name, c.mc, c.loader_version);
        }
    }

    /// `with_loader` 的分派规则（Quilt **不算** Fabric）
    #[test]
    fn with_loader_maps_only_real_fabric() {
        let f = JavaConstraintInput::detailed("1.20.1", false, 0, false, 0, false)
            .with_loader("fabric", Some("0.19.5"));
        assert_eq!(f.fabric_version.as_deref(), Some("0.19.5"));
        assert!(!f.has_forge_like);

        let q = JavaConstraintInput::detailed("1.20.1", false, 0, false, 0, false)
            .with_loader("quilt", Some("0.20.0-beta.9"));
        assert!(
            q.fabric_version.is_none(),
            "Quilt Loader 的版本号不是 Fabric 那一套，拿去比 0.17.0 会得出无意义的结论"
        );

        let nf = JavaConstraintInput::detailed("1.20.1", false, 0, false, 0, false)
            .with_loader("neoforge", Some("47.1.105"));
        assert!(nf.has_forge_like && nf.forge_kind_is_neoforge);
        assert_eq!(nf.forge_version.as_deref(), Some("47.1.105"));

        // 空串与纯空格都算"没给版本"，不许当成一个 0.0.0 的版本号去比
        let empty = JavaConstraintInput::detailed("1.20.1", false, 0, false, 0, false)
            .with_loader("forge", Some("   "));
        assert!(empty.forge_version.is_none());
    }

    /// 1.6 ~ 1.11.2 这一段**没有任何基线约束**（PCL 的两条例外之间）——
    ///   这条曾经是 Rust 与 TS 不一致的地方（Rust 多加了"最高 Java 8"）。
    #[test]
    fn no_baseline_between_1_6_and_1_11() {
        for mc in ["1.7.10", "1.8.9", "1.11.2"] {
            let r = resolve_java_requirement(JavaConstraintInput::from(mc, false, 0, false));
            assert!(
                r.constraints.is_empty(),
                "{mc} 不该有基线约束，实际：{:?}",
                r.constraints.iter().map(|c| &c.rule).collect::<Vec<_>>()
            );
            assert_eq!(r.range.format(), "(, )");
        }
    }

    #[test]
    fn auto_picks_exact_major() {
        let pool = vec![rt(8, "system"), rt(17, "system"), rt(21, "system")];
        let p = pick_java(
            "auto",
            &pool,
            JavaConstraintInput::from("1.20.1", false, 0, false),
            None,
            None,
        );
        assert_eq!(p.runtime.unwrap().major, 17);
    }

    #[test]
    fn instance_folder_mode_finds_bundled_java() {
        let pool = vec![rt(21, "instance")];
        let p = pick_java(
            "instance-folder",
            &pool,
            JavaConstraintInput::from("1.21.1", false, 0, false),
            None,
            None,
        );
        assert_eq!(p.runtime.unwrap().major, 21);
    }

    #[test]
    fn missing_java_gives_actionable_reason() {
        let p = pick_java(
            "auto",
            &[],
            JavaConstraintInput::from("1.21.1", false, 0, false),
            None,
            None,
        );
        assert!(p.runtime.is_none());
        assert!(p.reason.contains("Java 21"), "{}", p.reason);
    }

    #[test]
    fn range_mode_picks_highest_inside() {
        let pool = vec![rt(17, "system"), rt(19, "system"), rt(21, "system")];
        let p = pick_java(
            "range",
            &pool,
            JavaConstraintInput::from("1.20.1", false, 0, false),
            Some(r(17.0, 20.0)),
            None,
        );
        assert_eq!(p.runtime.unwrap().major, 19);
    }
}
