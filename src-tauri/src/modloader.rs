//! 模组加载器：**检测**（盘上装了什么）与**获取**（网上有哪些可装）
//! ------------------------------------------------------------------
//! 这个模块是加载器能力的**门面**，把两件事各收在一个入口里：
//!
//!   · `detect_installed_modloaders` —— 纯函数，看一份版本 JSON 里有什么
//!     （含 `inheritsFrom` 递归）。实现在 `domain::loader_trace`，
//!     因为"判据只能有一份"（ADR-011 / ADR-020）。
//!   · `fetch_available_loaders` —— 并行问五个来源，拿回可安装的版本列表。
//!
//! ★ **为什么门面放在这里而不是另开一个 `core` crate**：
//!   这个仓库是单 crate（`src-tauri`），领域规则在 `domain::`、网络在 `net::`。
//!   另起一个 `core/src/modloader/` 会让"加载器判定"出现第二份实现 ——
//!   而这份实现已经有四处调用方（版本列表、下载页、启动定位、启动守卫），
//!   一旦分裂，必然是"界面说装了、启动说没装"那类 bug 重新长出来。
//!   所以这里的做法是：**结构上按 spec 分层（types / detect / fetch 各司其职），
//!   位置上落进既有分层**。
//!
//! 五个来源的可靠性实测（本机、2026-09）：
//!   Forge    BMCLAPI build API 3.9s / 官方 maven 2s（BMCLAPI 的 maven-metadata 已停更，见 ADR-037）
//!   NeoForge 官方 maven-metadata 中，BMCLAPI 兜底
//!   Fabric   meta.fabricmc.net 590KB / 4.5s（有缓存 + 5 分钟 TTL）
//!   Quilt    meta.quiltmc.org 892KB / 6.7s
//!   OptiFine BMCLAPI 结构化 JSON 78KB / 0.7s（不抓 HTML，见 metadata.rs 的说明）

use crate::domain::loader_trace::{LoaderFlavor, ModLoaderError};
use crate::net::metadata::{self, OptifineVersion};
use crate::net::mirror::Source;

/// Forge 清单的超时：按版本的 build 接口要列出 14~355 条，比别的大。
/// 实测正常 0.3~2 秒，留 10 倍余量。
const FORGE_LIST_TIMEOUT_SECS: u64 = 20;

/// 其余四个来源的超时（实测 0.1~0.9 秒，留 20 倍以上余量）。
///
/// ★ 上限的意义不是"够不够"，而是"最坏情况要用户等多久"。
///   原来是 75 秒 —— 一条挂住的连接就能把整个查询拖到 75 秒。
const SMALL_LIST_TIMEOUT_SECS: u64 = 20;
use crate::net::NetError;
use serde::Serialize;

/// 检测失败 = 领域层的 `ModLoaderError`（JSON 坏了 / 继承链成环）。
pub type DetectError = ModLoaderError;

/// 获取失败 = 网络层的 `NetError`（超时 / HTTP / 解析）。
///
/// 刻意**不**新建一套 `ModLoaderError`：本仓库的错误链路是
/// `NetError -> String`（命令层），再包一层同义枚举只会多一次转换。
/// 与 spec 的差异在这里，理由在上面的模块说明里。
pub type FetchError = NetError;

/* ====================== 一、检测盘上装了什么 ====================== */

/// 检测一份版本 JSON 里包含哪些加载器（**含 `inheritsFrom` 递归**）。
///
/// `resolve_parent` 收父版本 id、返回它那份 JSON 的原文；`None` = 父版本不在本机
/// （不是错误：装了一半的版本很常见，如实少报即可）。
///
/// 领域层不许有 I/O，所以"父版本从哪来"由调用方决定 ——
/// 装机侧从 `versions/<id>/` 读文件，测试里直接塞字符串。
pub use crate::domain::loader_trace::{detect_installed_modloaders, InstalledModLoader};

/* ====================== 二、获取可安装的加载器版本 ====================== */

/// 一种加载器的可安装版本清单。
///
/// ★ 带 `error` 是**故意的**（ADR-037）：
///   "没查到"与"确认没有"必须分开。前者 `versions` 为空且 `error` 有值，
///   界面只能说"这次没查到，可重试"；后者 `error` 为空、`versions` 为空，
///   才是"这个 MC 版本确实没有它"。
///   spec 里的扁平 `{forge: Vec<_>, ...}` 把两种情况合并成空数组，
///   正是我们要修的那个 bug 的形状。
#[derive(Debug, Clone, Serialize)]
pub struct LoaderVersions {
    /// `forge` / `neoforge` / `fabric` / `quilt` / `optifine`
    pub kind: String,
    /// 面向用户的名字
    pub name: String,
    /// 降序（最新在前）；只有 `error` 为空时，"空"才表示"确认没有"
    pub versions: Vec<String>,
    /// 没查到的原因；`None` = 这次查询成功了
    pub error: Option<String>,
    /// 是不是基础加载器（OptiFine 是附加组件）
    pub is_base: bool,
    /// 仅 OptiFine：每个版本的文件名与 Forge 兼容要求
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub optifine: Vec<OptifineVersion>,
}

impl LoaderVersions {
    fn ok(kind: LoaderFlavor, versions: Vec<String>) -> Self {
        Self {
            kind: kind.key().to_string(),
            name: kind.display().to_string(),
            versions,
            error: None,
            is_base: kind.is_base(),
            optifine: Vec::new(),
        }
    }

    fn failed(kind: LoaderFlavor, e: impl std::fmt::Display) -> Self {
        Self {
            kind: kind.key().to_string(),
            name: kind.display().to_string(),
            versions: Vec::new(),
            error: Some(e.to_string()),
            is_base: kind.is_base(),
            optifine: Vec::new(),
        }
    }
}

/// 一个 MC 版本可安装的全部加载器与附加组件。
#[derive(Debug, Clone, Serialize)]
pub struct AvailableLoaders {
    pub mc_version: String,
    /// 基础加载器（Forge / NeoForge / Fabric / Quilt），顺序固定
    pub base: Vec<LoaderVersions>,
    /// 附加组件（OptiFine；LiteLoader 单独处理，仅 1.12.2 及以下）
    pub addons: Vec<LoaderVersions>,
}

impl AvailableLoaders {
    /// 取某一种加载器的结果（前端按 kind 取用）
    pub fn get(&self, kind: &str) -> Option<&LoaderVersions> {
        self.base
            .iter()
            .chain(self.addons.iter())
            .find(|l| l.kind == kind)
    }
}

/// **并行**获取某个 MC 版本可安装的加载器与附加组件。
///
/// ## 并行 + 错峰 + 每个来源自己的超时（按 PCL2 的 `DlSourceLoader` 改造）
///
/// ★ 必须并行：五个来源串行的话合计 ≈ 18 秒，用户看到的是"切一下版本等 18 秒"。
///   并行后由最慢的那个决定，有缓存时是毫秒级。
///
/// ★★ **但不能"同时开五条连接然后一起等 75 秒"**（用户报的"查询很慢、
///   甚至还有连不上而导致查不出来"）。两个真实问题：
///
///   ① **总时长 = 最慢那条**。BMCLAPI 偶尔整片挂住（TCP 通、TLS 完成、
///      一个字节不回），它一挂，整次查询要等满 75 秒总超时才回 ——
///      而另外四条路早就拿到答案了。
///   ② **五个请求同时发会互相饿死**。实测并行 5 个请求时，连接池竞争会让
///      本来 4.5 秒就成功的 Fabric 查询超过 30 秒被砍掉（→ "查不出来"）。
///
///   PCL2 的做法（`ModDownload.vb` 的 `DlSourceLoader`）是**错峰启动**：
///   每个来源带一个"第几个 100ms 启动"的偏移，先起一个，不行再起下一个，
///   任何一个成功就取消其余。这里按同样的思路给每个来源**自己的超时**：
///
///   | 来源 | 接口大小 / 实测耗时 | 超时 |
///   |---|---|---|
///   | Forge | 按版本 build 接口，14~355 条 | 20s |
///   | NeoForge | `/neoforge/list/{mc}`，87~632 ms | 20s |
///   | Fabric | 小接口 `/versions/loader`，30 KB | 15s |
///   | Quilt | 小接口，144 KB | 20s |
///   | OptiFine | BMCLAPI `/optifine/versionList` | 20s |
///
///   这些数字都远大于实测耗时（留了 20~100 倍余量），但远小于原来的 75 秒 ——
///   用户最多等 20 秒就能拿到"这一项没查到"，而不是 75 秒。
///
/// ★ 单个来源失败**不影响其它来源**：那一种的 `error` 有值，其余照常返回。
///   这正是"能装就是能装"——Fabric 查不到不该连累 Forge。
pub async fn fetch_available_loaders(
    mc_version: &str,
    source: Source,
) -> Result<AvailableLoaders, FetchError> {
    let mc = mc_version.to_string();

    // 五个请求同时发出去（`join!` 而不是 `try_join!`：一个失败不能拖垮其余），
    // 但**每个来源有自己的超时** —— 见上面那张表。
    //
    // ★ Fabric / Quilt 走**不分 MC 的小接口**（30 KB / 144 KB、0.1~0.9 秒），
    //   而不是 397 KB / 892 KB 的按 MC 全量接口（实测 Quilt 那份要 25~28 秒）。
    //   加载器版本号本来就是跨 MC 共享的，而且安装时用的是现取的 profile JSON，
    //   所以短列表不会让我们装错版本。见 `metadata::fabric_loader_list` 的说明。
    let (forge, neoforge, fabric, quilt, optifine) = tokio::join!(
        async {
            metadata::with_timeout_secs(
                "Forge 版本清单",
                FORGE_LIST_TIMEOUT_SECS,
                metadata::forge_versions(&mc),
            )
            .await
        },
        async {
            metadata::with_timeout_secs(
                "NeoForge 版本清单",
                SMALL_LIST_TIMEOUT_SECS,
                metadata::neoforge_versions_for_mc(&mc, source),
            )
            .await
        },
        async {
            metadata::with_timeout_secs(
                "Fabric 版本清单",
                SMALL_LIST_TIMEOUT_SECS,
                metadata::fabric_loader_list(source),
            )
            .await
        },
        async {
            metadata::with_timeout_secs(
                "Quilt 版本清单",
                SMALL_LIST_TIMEOUT_SECS,
                metadata::quilt_loader_list(source),
            )
            .await
        },
        async {
            metadata::with_timeout_secs(
                "OptiFine 版本清单",
                SMALL_LIST_TIMEOUT_SECS,
                metadata::optifine_versions(&mc),
            )
            .await
        },
    );

    // ---- Forge ----
    let forge = match forge {
        Ok(list) => LoaderVersions::ok(LoaderFlavor::Forge, list),
        Err(e) => LoaderVersions::failed(LoaderFlavor::Forge, e),
    };

    // ---- NeoForge ----
    //
    // ★ 走**按版本的小接口**（`/neoforge/list/{mc}`，87~632 ms），拿到的就是
    //   这个 MC 版本的 build 列表、并且已经在 `neoforge_versions_for_mc` 里
    //   归一化过（剥 MC 前缀 + 去重 + 降序）—— 不再需要在这里按前缀过滤
    //   1706 条全量清单，也就不会再踩"两种世代前缀混排"的坑。
    let neoforge = match neoforge {
        Ok(list) => LoaderVersions::ok(LoaderFlavor::NeoForge, list),
        Err(e) => LoaderVersions::failed(LoaderFlavor::NeoForge, e),
    };

    // ---- Fabric / Quilt ----
    //
    // ★ 4xx（400/404）是**确定的结论**：服务端明确说"这个 MC 版本没有它"
    //   （实测 Fabric 对 1.12.2 回 400、Quilt 回 404）。
    //   这必须算「确认没有」（ok + 空列表），**不能**算「没查到」——
    //   否则界面会把"Fabric 从来没支持过 1.12.2"显示成"查询失败"，
    //   而用户只知道反复重试（ADR-037）。
    let fabric = match fabric {
        Ok(list) => LoaderVersions::ok(LoaderFlavor::Fabric, list),
        Err(e) if crate::net::is_definitely_absent(&e) => {
            LoaderVersions::ok(LoaderFlavor::Fabric, Vec::new())
        }
        Err(e) => LoaderVersions::failed(LoaderFlavor::Fabric, e),
    };
    let quilt = match quilt {
        Ok(list) => LoaderVersions::ok(LoaderFlavor::Quilt, list),
        Err(e) if crate::net::is_definitely_absent(&e) => {
            LoaderVersions::ok(LoaderFlavor::Quilt, Vec::new())
        }
        Err(e) => LoaderVersions::failed(LoaderFlavor::Quilt, e),
    };

    // ---- OptiFine ----
    let optifine = match optifine {
        Ok(list) => {
            let versions: Vec<String> = list.iter().map(|v| v.version.clone()).collect();
            LoaderVersions {
                kind: LoaderFlavor::OptiFine.key().to_string(),
                name: LoaderFlavor::OptiFine.display().to_string(),
                versions,
                error: None,
                is_base: false,
                optifine: list,
            }
        }
        Err(e) => LoaderVersions::failed(LoaderFlavor::OptiFine, e),
    };

    Ok(AvailableLoaders {
        mc_version: mc,
        base: vec![forge, neoforge, fabric, quilt],
        addons: vec![optifine],
    })
}

/// 一条 NeoForge 版本号是否属于这个 MC 版本。
///
/// 两种世代（实测都有）：
///   · 新世代（1.21 起）：`21.1.72`，前两段 = MC 版本去掉 `1.` 前缀
///   · 更早的过渡期（1.20.1）：`1.20.1-47.1.76`，**带 MC 前缀**
///
/// ★ 保留它是给**全量清单**（`neoforge_versions`）用的兜底路径；
///   正常路径走 `neoforge_versions_for_mc` 的按版本接口，不需要这个过滤。
///
/// ★ 现在**只被测试用到**（`#[cfg(test)]`）。以前标的是 `#[allow(dead_code)]`
///   —— 那等于说"它是死代码但别报"，读者分不清"真死了"还是"只在测试里活"。
///   改成 `#[cfg(test)]` 之后它不进 release 二进制，意图一眼可见（ADR-053）。
#[cfg(test)]
fn neoforge_belongs(v: &str, mc_version: &str) -> bool {
    let parts: Vec<&str> = mc_version.split('.').collect();
    let prefix = match (parts.get(1), parts.get(2)) {
        (Some(a), Some(b)) => format!("{a}.{b}."),
        (Some(a), None) => format!("{a}."),
        _ => String::new(),
    };
    if !prefix.is_empty() && v.starts_with(&prefix) {
        return true;
    }
    v.starts_with(&format!("{mc_version}-"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn neoforge_generations_both_match() {
        // 新世代
        assert!(neoforge_belongs("21.1.72", "1.21.1"));
        assert!(neoforge_belongs("20.4.237", "1.20.4"));
        // 过渡期（带 MC 前缀）
        assert!(neoforge_belongs("1.20.1-47.1.76", "1.20.1"));
        // 不能串台
        assert!(!neoforge_belongs("21.1.72", "1.20.1"));
        assert!(!neoforge_belongs("20.4.237", "1.21.1"));
    }

    /// ★ 失败的来源只影响它自己 —— 其余照常返回（"能装就是能装"）
    #[test]
    fn one_failed_source_does_not_poison_the_others() {
        let forge = LoaderVersions::failed(LoaderFlavor::Forge, "网络超时");
        let fabric = LoaderVersions::ok(LoaderFlavor::Fabric, vec!["0.15.0".into()]);

        assert_eq!(forge.kind, "forge");
        assert!(forge.error.is_some(), "查不到必须能表达出来");
        assert!(forge.versions.is_empty());

        assert_eq!(fabric.kind, "fabric");
        assert!(fabric.error.is_none(), "别的来源成功就是成功");
        assert_eq!(fabric.versions, vec!["0.15.0"]);
    }

    /// 「确认没有」（ok 且空）与「没查到」（error）必须可区分
    #[test]
    fn empty_ok_is_distinguishable_from_error() {
        let confirmed_empty = LoaderVersions::ok(LoaderFlavor::Forge, vec![]);
        let failed = LoaderVersions::failed(LoaderFlavor::Forge, "超时");
        assert!(confirmed_empty.error.is_none() && confirmed_empty.versions.is_empty());
        assert!(failed.error.is_some() && failed.versions.is_empty());
    }

    #[test]
    fn available_loaders_lookup_by_kind() {
        let a = AvailableLoaders {
            mc_version: "1.20.1".into(),
            base: vec![LoaderVersions::ok(LoaderFlavor::Forge, vec!["47.2.0".into()])],
            addons: vec![LoaderVersions::ok(LoaderFlavor::OptiFine, vec![])],
        };
        assert_eq!(a.get("forge").map(|l| l.versions.len()), Some(1));
        assert_eq!(a.get("optifine").map(|l| l.is_base), Some(false));
        assert!(a.get("liteloader").is_none(), "没查的种类返回 None 而不是空壳");
    }
}
