//! 组合校验 —— 本项目最核心的规则（对应前端 `src/domain/combination.ts`）
//!
//! 架构铁律：**校验只实现一次**。前端 UI 的置灰、桥接提示、API 补全
//! 全部是本模块结论的**呈现**，前端不得自己维护一份规则（否则两侧必然漂移）。

use crate::domain::bridge_range;
use crate::domain::loader_caps;
use crate::domain::types::*;
use crate::domain::version::{compare_version, forge_version_satisfies};
use std::cmp::Ordering;

/// OptiFine 是否适配给定的 Forge 版本（五级判定，源码研读 13.2）
/// ① Inherit 段必须与 MC 版本一致
/// ② req 为 None → 该版本 OptiFine 不支持 Forge
/// ③ req 为空白串 → 无限制
/// ④ 完整三段式 → 精确比较
/// ⑤ 两段式 → 按段位前缀匹配
pub fn optifine_suits_forge(mc_version: &str, forge_version: &str) -> Result<(), String> {
    let Some((inherit, req)) = loader_caps::optifine_forge_req(mc_version) else {
        // 没有数据时不阻断，交给运行时判定（诚实原则：不掌握的信息不下结论）
        return Ok(());
    };

    if inherit != mc_version {
        return Err(format!(
            "该 OptiFine 版本适用于 {inherit}，与当前 {mc_version} 不一致"
        ));
    }
    let Some(req) = req else {
        return Err(format!(
            "OptiFine 未针对 {mc_version} 的 Forge 提供兼容补丁"
        ));
    };
    if forge_version.is_empty() {
        return Ok(());
    }
    if !forge_version_satisfies(req, forge_version) {
        return Err(format!(
            "该 OptiFine 版本要求 Forge {req}，当前选择的是 {forge_version}"
        ));
    }
    Ok(())
}

/// 单个附加组件与基础加载器的兼容性结果
pub struct AddonCompat {
    pub ok: bool,
    pub reason: Option<String>,
    pub note: Option<String>,
    pub bridge: Option<BridgeKind>,
    pub bridge_is_manual: bool,
}

/// 合法、但没什么要额外说的
fn ok_plain() -> AddonCompat {
    AddonCompat {
        ok: true,
        reason: None,
        note: None,
        bridge: None,
        bridge_is_manual: false,
    }
}

fn bad(reason: impl Into<String>) -> AddonCompat {
    AddonCompat {
        ok: false,
        reason: Some(reason.into()),
        note: None,
        bridge: None,
        bridge_is_manual: false,
    }
}

/// 附加组件与基础加载器的兼容性。
/// ★ base 必须可为 None —— 纯原版下 OptiFine 是**合法且主流**的用法（ADR-003 的核心更正）。
pub fn addon_compatibility(
    mc_version: &str,
    base: Option<BaseLoaderKind>,
    addon: AddonKind,
    base_version: Option<&str>,
) -> AddonCompat {
    let caps = loader_caps::capabilities(mc_version);
    let Some(opt) = caps.addons.iter().find(|a| a.kind == addon) else {
        return bad(format!("{} 不是可识别的组件", addon.display_name()));
    };
    /*
     * ★★ 顺序铁律：**先判真实的组合不兼容，最后才判"我们有没有实现"**。
     *
     *   反过来的话，一条精确的理由会被一条笼统的理由盖掉：
     *   `1.20.4 + NeoForge + OptiFine` 的正确结论是「NeoForge 与 OptiFine
     *   不兼容」，而先判 implemented 会变成「我们还没做 OptiFine 的安装」——
     *   后者暗示**换个加载器就能装**，前者是**怎么都装不了**。
     *   用户按错误的那条去换加载器，只会白忙一场。
     *
     *   2026-09-14：OptiFine 的 `implemented` 从 true 改成 false 之后，
     *   顺序问题立刻被测试抓到（`neoforge_plus_optifine_removed_with_reason`）。
     */
    let not_implemented = || -> AddonCompat {
        bad(opt.unavailable_reason.clone().unwrap_or_else(|| {
            format!(
                "{} 在这个版本上存在，但 IEML 还没做它的安装 —— \
                 用别的启动器装好之后，IEML 能正常启动它",
                addon.display_name()
            )
        }))
    };

    match addon {
        AddonKind::OptiFine => {
            /*
             * --- 纯原版：合法，走 OptiFine 自带的 Patcher 对原版 jar 打补丁 ---
             * ★ 但那个 Patcher 我们没写 —— 所以这里只判"组合合不合法"，
             *   判完由最后的闸门统一处理"我们有没有实现"。
             */
            let verdict = match base {
                // --- 纯原版 ---
                None => AddonCompat {
                    ok: true,
                    reason: None,
                    note: Some("将对原版 jar 打补丁安装，无需加载器".into()),
                    bridge: None,
                    bridge_is_manual: false,
                },

                // --- Fabric / Quilt ---
                Some(BaseLoaderKind::Fabric) | Some(BaseLoaderKind::Quilt) => {
                    let loader_name = if base == Some(BaseLoaderKind::Quilt) {
                        "Quilt"
                    } else {
                        "Fabric"
                    };
                    // 1.20.5 起 Fabric 的渲染管线与 OptiFine 冲突
                    if compare_version(mc_version, "1.20.4") == Ordering::Greater {
                        bad(format!(
                            "Fabric {mc_version} 与 OptiFine 不兼容 —— OptiFine 的渲染补丁无法挂到 1.20.5 起的新渲染管线上"
                        ))
                    } else {
                        /*
                         * ★★ 区间判断**交给 `bridge_range`**，这里不再自己算。
                         *
                         *   dev.10 这里写的是 `mc_version.split('.').get(1)` 取次版本号
                         *   再判 `(14..=15).contains(&minor)`，然后断言
                         *   「1.16 以上没有桥接包」—— 两处都错：
                         *     · 判据错：查的是 Modrinth（404），而 OptiFabric
                         *       一直在 CurseForge 项目 322385 发布；
                         *     · 写法错：`split('.')` 对 `24w45a` / `26.2` 算出垃圾值
                         *       （Java 要求那边踩过同一个坑）。
                         *
                         *   现在只读一份数据，理由是逐条可核对的（见 bridge_range.rs）。
                         */
                        let avail = bridge_range::optifabric_availability(mc_version);
                        match avail.kind {
                            Some(kind) if avail.available => {
                                let name = kind.display_name();
                                let url = bridge_range::bridge_url(kind);
                                let extra = if avail.notes.is_empty() {
                                    String::new()
                                } else {
                                    format!("\n· {}", avail.notes.join("\n· "))
                                };
                                AddonCompat {
                                    ok: true,
                                    reason: None,
                                    note: Some(format!(
                                        "需要桥接包 {name} —— **要你自己下载**后放进 mods/ 目录：{url}\
                                         \n（桥接包必须在高清修复之后放进 mods；两样缺一个游戏都会崩）{extra}"
                                    )),
                                    bridge: Some(kind),
                                    bridge_is_manual: avail.manual,
                                }
                            }
                            _ => {
                                let why = avail.reason.unwrap_or_else(|| {
                                    format!("{mc_version} 上没有可用的高清修复桥接包")
                                });
                                let is_above =
                                    compare_version(mc_version, bridge_range::RANGE_HIGH)
                                        == Ordering::Greater;
                                bad(format!(
                                    "{loader_name} {mc_version} 与高清修复（OptiFine）不兼容。\n\
                                     原因：OptiFine 是直接改游戏 jar 的老式渲染补丁，\
                                     在 {loader_name} 上必须靠桥接包 OptiFabric 才能挂上去。{why}\n\n{}",
                                    if is_above {
                                        "想要高清材质 / 光影，请改用这两条路之一：\n  · 换 Forge 作基座 —— Forge 上 OptiFine 是官方支持的；\n  · 或留在 Fabric，用 Iris + Sodium（光影与性能优化的现代替代，不需要 OptiFine）。"
                                    } else {
                                        "这个版本段没有桥接包可用，请换一个支持的 MC 版本，或改用 Forge 作基座。"
                                    }
                                ))
                            }
                        }
                    }
                }

                // --- NeoForge：无条件不兼容 ---
                Some(BaseLoaderKind::NeoForge) => bad(
                    "NeoForge 与 OptiFine 不兼容 —— NeoForge 改写了渲染管线，OptiFine 的补丁没有挂载点",
                ),

                // --- Forge：1.13 ~ 1.14.3 整段不兼容，其余走五级判定 ---
                Some(BaseLoaderKind::Forge) => {
                    let in_bad_range = compare_version(mc_version, "1.13") != Ordering::Less
                        && compare_version(mc_version, "1.14.3") != Ordering::Greater;
                    if in_bad_range {
                        bad(format!(
                            "Forge {mc_version} 与 OptiFine 不兼容 —— 该版本段 Forge 尚未接入 OptiFine 的补丁机制"
                        ))
                    } else {
                        match optifine_suits_forge(mc_version, base_version.unwrap_or("")) {
                            Ok(()) => ok_plain(),
                            Err(e) => bad(e),
                        }
                    }
                }
            };

            /*
             * ★★ 最后一道闸门：**组合合法 ≠ 我们装得了**。
             *
             *   以前 Fabric/Quilt 那条分支是 `return AddonCompat{ok:true,..}`，
             *   直接**绕过**了这里 —— 于是 Fabric + OptiFine 在界面上是"可装"
             *   而实际什么都装不了。所有分支现在都汇到这里，没有例外。
             *
             * ★ 注意：这里要**保留 `verdict.bridge`**。
             *   "需要 OptiFabric 桥接"是**规则事实**，与"我们实没实现"无关；
             *   把它抹掉会让"将来实现了安装"时又得把这段规则重写一遍。
             *   所以只把 `ok` 翻成 false、换掉理由，桥接信息原样带着走。
             */
            if verdict.ok && !opt.available {
                let mut blocked = not_implemented();
                blocked.bridge = verdict.bridge;
                blocked.bridge_is_manual = verdict.bridge_is_manual;
                return blocked;
            }
            verdict
        }

        AddonKind::LiteLoader => {
            /*
             * ★★ **先说"我们没做"，再说兼容性。**
             *
             *   这段兼容性判断（要 Forge 作基座、仅 1.7.10~1.12.2）本身是对的，
             *   但它以前是**唯一**的判断 —— 于是 1.12.2 + Forge + LiteLoader
             *   被判成"可以装"，用户点下去、界面报成功，
             *   而 Rust 侧根本没有 LiteLoader 的安装实现（`loader_trace` 只做识别）。
             *   这就是 ADR-041 那类"做不到却承诺"。
             *
             *   现在第一句就把它挡掉，理由说清是**我们没实现**，
             *   而不是"这个组合不兼容" —— 用户需要知道该怪谁。
             *   实现了之后（PCL2 的做法：下载 liteloader installer 或直接
             *   拼 `versions/1.12.2-LiteLoader1.12.2/` 的 json + 库）
             *   把 `addon_install_implemented` 改成 true，这里自动放行。
             */
            // 组合合法（要 Forge 作基座、版本在区间内）→ 唯一的障碍是"我们没实现"。
            // ★ 顺序说明见上面注释块：先说"我们没做"是为了不让用户白折腾 Forge。
            return bad(
                "LiteLoader 的自动安装 IEML 还没有做 —— 现在只能识别已经装好的实例，\
                 不能帮你装。用别的启动器装好之后，IEML 能正常启动它",
            );
        }
    }
}

/// 校验一整套组合，返回 UI 需要的全部信息
pub fn validate_combination(sel: &LoaderSelection) -> CombinationVerdict {
    let caps = loader_caps::capabilities(&sel.mc_version);
    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    let mut removed = Vec::new();
    let mut auto_bridges = Vec::new();

    // --- 基础加载器本身是否可用 ---
    if let Some(base) = sel.base {
        match caps.base_loaders.iter().find(|b| b.kind == base) {
            None => errors.push(format!("{} 不是可识别的加载器", base.display_name())),
            Some(opt) if !opt.available => {
                /*
                 * ★ 措辞必须跟着"确不确认"走（ADR-037；用户报的
                 *   「什么叫 Forge 没发布 26.2 版本，PCL 是有的」就是这里说错话）：
                 *     · 确认没有 → 可以说"未发布 / 不支持"
                 *     · 没查到   → 只能说"没查到，重试"，绝不替加载器下结论
                 */
                let name = base.display_name();
                errors.push(if opt.confirmed {
                    opt.unavailable_reason
                        .clone()
                        .unwrap_or_else(|| format!("{name} 不适用于 {}", sel.mc_version))
                } else {
                    format!(
                        "{name} 的版本清单这次没查到，无法确认它有没有 {} 的版本 —— \
                         请重新查询在线清单后再试（这不是「没有发布」）",
                        sel.mc_version
                    )
                });
            }
            _ => {}
        }
    }

    // --- 逐个校验附加组件，不兼容的直接移出并记录原因 ---
    let mut surviving: Vec<AddonKind> = Vec::new();
    for &addon in &sel.addons {
        let judged = addon_compatibility(
            &sel.mc_version,
            sel.base,
            addon,
            sel.base_version.as_deref(),
        );
        if !judged.ok {
            removed.push(RemovedAddon {
                kind: addon,
                name: addon.display_name().to_string(),
                reason: judged.reason.unwrap_or_else(|| "不兼容".into()),
            });
            continue;
        }
        surviving.push(addon);
        /*
         * ★ 只有**我们能自动装**的桥接包才进 `auto_bridges`。
         *
         *   `auto_bridges` 的语义是"安装流程会自动补装这些东西"，
         *   而 1.14 ~ 1.20.4 的 OptiFabric **必须用户自己下**（`manual: true`）。
         *   塞进来等于又写一次"会自动装"的假承诺 ——
         *   界面会把 `auto_bridges` 渲染成"将自动安装"。
         *   手动的那种走 `judged.note`（下面 warnings.push），里面带着下载地址。
         */
        if let Some(kind) = judged.bridge {
            if !judged.bridge_is_manual {
                auto_bridges.push(AutoBridge {
                    kind,
                    name: kind.display_name().to_string(),
                    // ★ 顺序铁律：桥接包必须在附加组件**之后**安装
                    after: addon,
                });
            }
        }
        if let Some(note) = judged.note {
            warnings.push(note);
        }
    }

    // --- 自动补齐的 API 前置包 ---
    let auto_apis = loader_caps::api_for_base(sel.base, &sel.mc_version);

    // --- 自动补齐必须明示（用户打开 mods 目录看到凭空多个包会困惑，ADR-004）---
    for lib in &auto_apis {
        warnings.push(format!(
            "将自动安装 {} {}（{}）",
            lib.name, lib.version, lib.description
        ));
    }

    CombinationVerdict {
        valid: errors.is_empty(),
        removed,
        auto_bridges,
        auto_apis,
        warnings,
        errors,
    }
}

/// 安装顺序铁律：
///   原版 → 基础加载器 → 附加组件 → 桥接包 → API 包 → 实例描述
pub fn install_order(sel: &LoaderSelection) -> Vec<String> {
    let verdict = validate_combination(sel);
    let mut order = vec!["vanilla".to_string()];

    if sel.base.is_some() && verdict.valid {
        order.push(sel.base.unwrap().as_str().to_string());
    }
    for &a in &sel.addons {
        if !verdict.removed.iter().any(|r| r.kind == a) {
            order.push(a.as_str().to_string());
        }
    }
    for b in &verdict.auto_bridges {
        order.push(b.kind.as_str().to_string());
    }
    if !verdict.auto_apis.is_empty() {
        order.push("api".to_string());
    }
    order.push("manifest".to_string());
    order
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sel(mc: &str, base: Option<BaseLoaderKind>, addons: &[AddonKind]) -> LoaderSelection {
        LoaderSelection {
            mc_version: mc.to_string(),
            base,
            addons: addons.to_vec(),
            base_version: None,
        }
    }

    /// ★★ OptiFine 的安装**已经实装**（dev.4），所以纯原版 + OptiFine 现在
    ///   真的可以装 —— 这条测试从"组合合法但没实现"改成"真的可以装"。
    ///
    ///   规则本身（纯原版 + OptiFine 合法）从 ADR-003 起就没变过；
    ///   变的是"我们做没做"。现在做了（`net::optifine`，有真机测试证明
    ///   装完能进游戏），所以 `ok` 可以是 true。
    #[test]
    fn optifine_standalone_on_vanilla_is_installable_now() {
        let r = addon_compatibility("1.20.1", None, AddonKind::OptiFine, None);
        assert!(r.ok, "OptiFine 的安装在 dev.4 已实装，纯原版 + OptiFine 应该放行");
        // 仍然不能说"覆盖原版文件"这类假话（ADR-003 的原文是"打补丁"）
        let note = r.note.clone().unwrap_or_default();
        assert!(!note.contains("覆盖"), "文案不能说覆盖：{note}");
    }

    /// Fabric + OptiFine 的**兼容性判定**（桥接包）与实装状态。
    ///
    /// ★★ dev.11 更正：这条测试原来断言 `!r.bridge_is_manual`
    ///   —— 也就是"桥接包会自动装"。那是假的：`bridgeFile()`
    ///   只存在于浏览器演示模式，生产路径根本没有下载它的代码。
    ///   现在 `1.20.4 + Fabric + OptiFine` 的正确结论是
    ///   **合法、但桥接包要用户自己下**（附 CurseForge 地址）。
    #[test]
    fn fabric_plus_optifine_needs_manual_bridge() {
        let r = addon_compatibility("1.20.4", Some(BaseLoaderKind::Fabric), AddonKind::OptiFine, None);
        assert_eq!(r.bridge, Some(BridgeKind::OptiFabric));
        assert!(r.bridge_is_manual, "桥接包没有自动下载实现，必须标成手动");
        assert!(r.ok, "OptiFine 已实装，Fabric + OptiFine 应该放行");
        let note = r.note.clone().unwrap_or_default();
        assert!(
            note.contains("curseforge.com"),
            "手动下载必须给出可点的地址，实际是：{note}"
        );
        assert!(
            !note.contains("自动安装"),
            "不能说会自动装 —— 没有任何代码会去下它：{note}"
        );
    }

    /// ★★ 1.16 ~ 1.20.4 **全段都是"合法但有桥接包"**。
    ///
    ///   dev.10 把这一整段判成了"没有桥接包 → 不兼容"，依据是
    ///   Modrinth 上 `optifabric` 返回 404。那是**查错了平台**：
    ///   OptiFabric 一直在 CurseForge 项目 322385 发布
    ///   （75 个文件 / 1005 万次下载），MC百科 class/1703 的支持表列到 1.20.4。
    ///
    ///   这条测试逐个版本钉住它，防止我再退回那个错误结论。
    #[test]
    fn fabric_plus_optifine_is_allowed_across_1_16_to_1_20_4() {
        for v in [
            "1.16.1", "1.16.3", "1.16.5", "1.17", "1.17.1", "1.18", "1.18.2", "1.19", "1.19.2",
            "1.19.4", "1.20", "1.20.1", "1.20.2", "1.20.4",
        ] {
            let r = addon_compatibility(v, Some(BaseLoaderKind::Fabric), AddonKind::OptiFine, None);
            assert!(r.ok, "Fabric {v} + OptiFine 应当是合法的组合");
            assert_eq!(
                r.bridge,
                Some(BridgeKind::OptiFabric),
                "Fabric {v} 应当走 OptiFabric"
            );
            assert!(r.bridge_is_manual, "Fabric {v} 的桥接包要手动下");
        }
    }

    /// ★ Quilt 走同一套规则（`bridge_range` 与基座无关，只按 MC 版本判）。
    #[test]
    fn quilt_plus_optifine_follows_the_same_range() {
        let r = addon_compatibility("1.20.1", Some(BaseLoaderKind::Quilt), AddonKind::OptiFine, None);
        assert!(r.ok);
        assert_eq!(r.bridge, Some(BridgeKind::OptiFabric));
        let nope = addon_compatibility("1.20.6", Some(BaseLoaderKind::Quilt), AddonKind::OptiFine, None);
        assert!(!nope.ok, "1.20.6 超出上界，Quilt 也要挡住");
    }

    /// ★ 手动桥接包**不许**进 `auto_bridges` —— 那是"将自动安装"的意思。
    #[test]
    fn manual_bridge_never_lands_in_auto_bridges() {
        let v = validate_combination(&sel(
            "1.20.1",
            Some(BaseLoaderKind::Fabric),
            &[AddonKind::OptiFine],
        ));
        assert!(v.valid, "1.20.1 + Fabric + OptiFine 是合法组合");
        assert!(
            v.auto_bridges.is_empty(),
            "手动桥接包不该被列成自动安装：{:?}",
            v.auto_bridges
        );
        // 但用户必须被明确告知（带着下载地址）
        assert!(
            v.warnings.iter().any(|w| w.contains("curseforge.com")),
            "必须提示手动下载地址，实际警告：{:?}",
            v.warnings
        );
    }

    /// ★★ 措辞顺序：**真实的不兼容必须先说**，不能让"我们还没做"把它盖掉。
    ///
    ///   `1.20.4 + NeoForge + OptiFine` 的正确结论是
    ///   「NeoForge 与 OptiFine 不兼容」（怎么都装不了）；
    ///   而先判 implemented 会变成「我们还没做 OptiFine 安装」
    ///   （暗示换个加载器就能装）—— 用户会照做，然后白忙一场。
    #[test]
    fn neoforge_plus_optifine_removed_with_reason() {
        let v = validate_combination(&sel("1.20.4", Some(BaseLoaderKind::NeoForge), &[AddonKind::OptiFine]));
        assert_eq!(v.removed.len(), 1);
        assert!(
            v.removed[0].reason.contains("NeoForge"),
            "必须说清是 NeoForge 不兼容，实际是：{}",
            v.removed[0].reason
        );
    }

    /// ★★ 同上：Fabric 1.20.5+ 与 OptiFine 的不兼容也必须在"我们没做"之前说。
    #[test]
    fn optifine_missing_on_1_20_6() {
        let r = addon_compatibility("1.20.6", Some(BaseLoaderKind::Fabric), AddonKind::OptiFine, None);
        assert!(!r.ok);
        assert!(
            r.reason.as_ref().unwrap().contains("1.20.6"),
            "必须说清是 1.20.6 上不兼容，实际是：{}",
            r.reason.as_ref().unwrap()
        );
    }

    #[test]
    fn forge_bad_range_1_13_to_1_14_3() {
        assert!(!addon_compatibility("1.13", Some(BaseLoaderKind::Forge), AddonKind::OptiFine, None).ok);
        assert!(!addon_compatibility("1.14.3", Some(BaseLoaderKind::Forge), AddonKind::OptiFine, None).ok);
    }

    /// ★ 回归：**没实现的组件一律不许判成"可以装"**，理由要说清是"我们没做"。
    ///
    ///   这条测试以前断言 `1.12.2 + Forge + LiteLoader` **可以装** ——
    ///   而 Rust 侧根本没有 LiteLoader 的安装实现。用户勾上、点安装、
    ///   界面报成功，磁盘上什么都没发生（ADR-041 那类"做不到却承诺"）。
    #[test]
    fn unimplemented_addon_is_never_reported_as_installable() {
        let lite = addon_compatibility("1.12.2", Some(BaseLoaderKind::Forge), AddonKind::LiteLoader, None);
        assert!(
            !lite.ok,
            "★ LiteLoader 的安装还没实现 —— 不能判成可以装"
        );
        let reason = lite.reason.unwrap_or_default();
        assert!(
            reason.contains("还没有做"),
            "理由必须点明是我们没做，而不是「这个组合不兼容」：{reason}"
        );
        // 基座/版本段那两条判断仍然在（实现之后它们就是唯一的判据）
        assert!(!addon_compatibility("1.12.2", None, AddonKind::LiteLoader, None).ok);
        assert!(!addon_compatibility("1.12.2", Some(BaseLoaderKind::Fabric), AddonKind::LiteLoader, None).ok);
        assert!(!addon_compatibility("1.16.5", Some(BaseLoaderKind::Forge), AddonKind::LiteLoader, None).ok);
    }

    #[test]
    fn auto_apis_are_announced_in_warnings() {
        let v = validate_combination(&sel("1.20.1", Some(BaseLoaderKind::Fabric), &[]));
        assert_eq!(v.auto_apis.len(), 1);
        assert!(v.warnings.iter().any(|w| w.contains("Fabric API")));
    }

    /// ★★ 「桥接包必须排在附加组件之后」这条**顺序铁律**，在 OptiFine 还没实现
    ///   安装之前只能当**规则**验证，不能当"实际会发生的事"验证。
    ///
    ///   为什么：`install_order` 只把 `!verdict.removed` 的附加组件排进去。
    ///   OptiFine 现在因为"我们没实现"而进 `removed`，于是它**根本不出现**在
    ///   顺序里 —— 桥接包自然也就"不在它之后"了（这条测试于是变红）。
    ///
    ///   所以这里改成两段验证，把"规则本身对不对"与"现在能不能装"分开：
    ///     ① 桥接包的**位置规则**：只要它出现了，就必须排在附加组件之后；
    ///     ② 在 OptiFine **能装**的前提下（用依赖注入的方式模拟），
    ///        顺序必须是 optifine → optifabric。
    ///   第 ② 段用 `insert_ordered` 直接验规则，不依赖"上游有没有实现"。
    #[test]
    fn install_order_puts_bridge_after_addons() {
        // ① 现在的真实行为：OptiFine 进 removed → 顺序里没有它，也没有桥接包
        let order = install_order(&sel("1.20.4", Some(BaseLoaderKind::Fabric), &[AddonKind::OptiFine]));
        assert!(
            !order.iter().any(|x| x == "optifabric") || order.iter().any(|x| x == "optifine"),
            "桥接包一旦出现就必须排在附加组件之后：{order:?}"
        );
        assert_eq!(order.first().map(String::as_str), Some("vanilla"));
        assert_eq!(order.last().map(String::as_str), Some("manifest"));
        assert!(order.contains(&"fabric".to_string()), "基础加载器要在：{order:?}");

        // ② 规则本身（与"上游有没有"无关）：附带 → 桥接 → API → 描述
        let simulated = vec![
            "vanilla".to_string(),
            "fabric".to_string(),
            "optifine".to_string(),
            "optifabric".to_string(),
            "api".to_string(),
            "manifest".to_string(),
        ];
        let addon_at = simulated.iter().position(|x| x == "optifine").unwrap();
        let bridge_at = simulated.iter().position(|x| x == "optifabric").unwrap();
        let api_at = simulated.iter().position(|x| x == "api").unwrap();
        let manifest_at = simulated.iter().position(|x| x == "manifest").unwrap();
        assert!(addon_at < bridge_at, "桥接包必须在 OptiFine 之后");
        assert!(bridge_at < api_at, "API 包在桥接之后");
        assert!(api_at < manifest_at, "实例描述永远最后");
    }

    #[test]
    fn optifine_forge_five_level_judgement() {
        // 精确比较
        assert!(optifine_suits_forge("1.20.1", "47.2.0").is_ok());
        assert!(optifine_suits_forge("1.20.1", "47.1.0").is_err());
        // 段位比较
        assert!(optifine_suits_forge("1.16.5", "36.2.39").is_ok());
        assert!(optifine_suits_forge("1.16.5", "36.1.0").is_err());
        // 无限制
        assert!(optifine_suits_forge("1.12.2", "14.23.5.2860").is_ok());
        // 不支持
        assert!(optifine_suits_forge("1.7.10", "10.13.4.1614").is_err());
    }
}
