//! 镜像表与多源竞速（ADR-026）
//!
//! 本机实测（`tools/probe-sources.mjs`）：
//!   ✓ 可达：piston-meta.mojang.com · resources.download.minecraft.net ·
//!           libraries.minecraft.net · bmclapi2.bangbang93.com · meta.fabricmc.net ·
//!           meta.quiltmc.org · maven.minecraftforge.net · api.modrinth.com ·
//!           api.adoptium.net · optifine.net
//!   ✗ 不可达：maven.fabricmc.net（根路径超时，但具体 jar 有时能下）·
//!             maven.neoforged.net（TLS 中断）· maven.quiltmc.org · api.curseforge.com（需 Key）
//!
//! 结论：**BMCLAPI 是这台机器的关键路径**，它镜像了原版全部文件、
//! Forge/NeoForge 安装器、Fabric Loader jar、以及全部 maven 库。

use serde::{Deserialize, Serialize};

/// 下载源
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Mojang,
    Bmclapi,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Mojang => "mojang",
            Self::Bmclapi => "bmclapi",
        }
    }

    /// 从 URL 反推它属于哪个源（用于查该源的实测速度等健康数据）。
    ///
    /// 判据是"镜像主机名"，而不是"URL 长得像哪个"：
    /// BMCLAPI 的所有服务都在 `bmclapi2.bangbang93.com` 下
    /// （`/maven/…`、`/assets/…`、`/version/…`），其余都算官方源。
    pub fn from_url(url: &str) -> Self {
        if url.contains("bmclapi") {
            Self::Bmclapi
        } else {
            Self::Mojang
        }
    }
}

/* ====================== 基础地址 ====================== */

pub const MOJANG_VERSION_MANIFEST: &str =
    "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
pub const MOJANG_RESOURCES: &str = "https://resources.download.minecraft.net";
pub const MOJANG_LIBRARIES: &str = "https://libraries.minecraft.net";

pub const BMCLAPI_BASE: &str = "https://bmclapi2.bangbang93.com";

/// 加载器清单 API（这些不走镜像，直连可用）
pub const FABRIC_META: &str = "https://meta.fabricmc.net/v2";
pub const QUILT_META: &str = "https://meta.quiltmc.org/v3";
pub const FORGE_MAVEN: &str = "https://maven.minecraftforge.net";
pub const FORGE_PROMOTIONS: &str =
    "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json";

pub const MODRINTH_API: &str = "https://api.modrinth.com/v2";
pub const ADOPTIUM_API: &str = "https://api.adoptium.net/v3";
/// MCIMirror：Modrinth / CurseForge 的国内镜像（PCL2 用它做 mod 下载兜底）
pub const MCIMIRROR: &str = "https://mod.mcimirror.top";
pub const MCIMIRROR_MODRINTH: &str = "https://mod.mcimirror.top/modrinth";

/* ====================== URL 重写 ====================== */

/// 把官方 URL 改写成镜像 URL。
///
/// 这是整个下载层最关键的一个函数 —— 因为版本 JSON 里写的是官方地址，
/// 而这台机器上 Fabric / NeoForge 的 maven 不通，必须靠 BMCLAPI 兜底。
///
/// 映射规则（已实测）：
///   piston-meta.mojang.com/...            → bmclapi2/...（去掉主机名即可）
///   piston-data.mojang.com/...            → bmclapi2/...（同上；客户端 jar 就在这里）
///   libraries.minecraft.net/<path>        → bmclapi2/maven/<path>
///   resources.download.minecraft.net/<a>/<b> → bmclapi2/assets/<a>/<b>
///   launcher.mojang.com/...               → bmclapi2/...
///   maven.fabricmc.net/<path>             → bmclapi2/maven/<path>
///   maven.neoforged.net/releases/<path>   → bmclapi2/maven/<path>
///   maven.minecraftforge.net/<path>       → bmclapi2/maven/<path>
///
/// ★ 为什么 `piston-data` 必须在表里（踩过的坑，2026-09-11）：
///   新版本（实测 26.2）的**客户端 jar 不再放在 launcher.mojang.com**，
///   而是放在 `piston-data.mojang.com/v1/objects/<sha1>/client.jar`。
///   漏掉这条改写，客户端 jar 就永远不会走 BMCLAPI，而官方直连这台机器
///   实测**单文件 39 MB 会被中途掐断** —— 于是整个安装卡在"校验失败/换源耗尽"，
///   表现为"点了下载没反应"。库和资源索引都能下，唯独客户端 jar 下不来。
pub fn mirror_url(url: &str, source: Source) -> String {
    if source == Source::Mojang {
        return url.to_string();
    }

    const REWRITES: [(&str, &str); 7] = [
        (
            "https://resources.download.minecraft.net/",
            "https://bmclapi2.bangbang93.com/assets/",
        ),
        (
            "https://libraries.minecraft.net/",
            "https://bmclapi2.bangbang93.com/maven/",
        ),
        (
            "https://piston-meta.mojang.com/",
            "https://bmclapi2.bangbang93.com/",
        ),
        (
            "https://piston-data.mojang.com/",
            "https://bmclapi2.bangbang93.com/",
        ),
        (
            "https://launcher.mojang.com/",
            "https://bmclapi2.bangbang93.com/",
        ),
        (
            "https://maven.fabricmc.net/",
            "https://bmclapi2.bangbang93.com/maven/",
        ),
        (
            "https://maven.minecraftforge.net/",
            "https://bmclapi2.bangbang93.com/maven/",
        ),
    ];
    for (from, to) in REWRITES {
        if let Some(rest) = url.strip_prefix(from) {
            return format!("{to}{rest}");
        }
    }
    if let Some(rest) = url.strip_prefix("https://maven.neoforged.net/releases/") {
        return format!("https://bmclapi2.bangbang93.com/maven/{rest}");
    }

    /*
     * ★★ Quilt 的 meta **必须走 BMCLAPI 镜像**（实测 2026-09-13）：
     *
     *   | 地址 | 结果 |
     *   |---|---|
     *   | `meta.quiltmc.org/v3/versions/loader` | **40 秒超时（两个不同的路径都超时）** |
     *   | `bmclapi2.bangbang93.com/quilt-meta/v3/versions/loader` | 22 KB / **0.31 秒** |
     *
     *   这就是用户报的"查询在线清单很慢，甚至还有连不上而导致查不出来"的
     *   一个直接原因：官方 Quilt meta 在这台机器上根本连不通，
     *   而我们的镜像改写表里**没有这一条** —— 于是每次冷启动都要等满
     *   20 秒超时才放弃 Quilt，界面显示"没查到"，而它其实一直都在，
     *   只是要走镜像。
     *
     *   ★ Fabric 的 meta **不在这个表里**：实测官方 `meta.fabricmc.net`
     *     直连只要 2.75 秒（38 KB），比镜像更快 —— 有更快的路就别绕。
     */
    if let Some(rest) = url.strip_prefix("https://meta.quiltmc.org/") {
        return format!("https://bmclapi2.bangbang93.com/quilt-meta/{rest}");
    }
    if let Some(rest) = url.strip_prefix("https://maven.quiltmc.org/repository/release/") {
        return format!("https://bmclapi2.bangbang93.com/maven/{rest}");
    }

    // Modrinth / CurseForge 的镜像是**兜底候选**，由 `candidate_urls` 追加，
    // 不在这里改写首选地址（见 `mcimirror_url` 的说明）。
    // 其它域名（Adoptium / OptiFine / Fabric meta 等）本来就没有镜像。
    url.to_string()
}

/// MCIMirror 改写（Modrinth / CurseForge 的国内镜像）。
///
/// ## 规则（已逐条实测，2026-09-13）
///
/// | 官方 | 镜像 |
/// |---|---|
/// | `api.modrinth.com/v2/...` | `mod.mcimirror.top/modrinth/v2/...` |
/// | `staging-api.modrinth.com/v2/...` | 同上 |
/// | `cdn.modrinth.com/data/...` | `mod.mcimirror.top/data/...` |
/// | `api.curseforge.com/v1/...` | `mod.mcimirror.top/curseforge/v1/...` |
/// | `edge.forgecdn.net/...`、`media.forgecdn.net/...`、`mediafilez.forgecdn.net/...` | `mod.mcimirror.top/...` |
///
/// 实测（本机）：
///   * `mod.mcimirror.top/modrinth/v2/project/fabric-api` → HTTP 200
///   * `mod.mcimirror.top/data/P7dR8mSH/versions/rvI2dfzR/fabric-api-0.92.12%2B1.20.1.jar`
///     → HTTP 200，2 087 116 字节（和官方 CDN 同一个文件）
///   * `mod.mcimirror.top/curseforge/v1/mods/search?...` → HTTP 200
///
/// ## 为什么它是"兜底"而不是"首选"
///
/// 本机实测：官方 `cdn.modrinth.com` 约 **230 KB/s**，mcimirror 约 **146 KB/s**
/// —— 镜像更慢。但它是**一条真正不同的路**：换源、限流、CDN 边缘挂住时，
/// 多一条路就是多一次活命机会（用户报的"下载慢得要死/有些版本甚至报错"
/// 正是"只有一个候选地址、失败就没退路"造成的）。
///
/// 所以它进 `candidate_urls` 的**末尾**，只在前面都失败时才被用到。
pub fn mcimirror_url(url: &str) -> Option<String> {
    const REWRITES: [(&str, &str); 6] = [
        ("https://api.modrinth.com/", "https://mod.mcimirror.top/modrinth/"),
        (
            "https://staging-api.modrinth.com/",
            "https://mod.mcimirror.top/modrinth/",
        ),
        ("https://cdn.modrinth.com/", "https://mod.mcimirror.top/"),
        (
            "https://api.curseforge.com/",
            "https://mod.mcimirror.top/curseforge/",
        ),
        ("https://edge.forgecdn.net/", "https://mod.mcimirror.top/"),
        ("https://media.forgecdn.net/", "https://mod.mcimirror.top/"),
    ];
    for (from, to) in REWRITES {
        if let Some(rest) = url.strip_prefix(from) {
            return Some(format!("{to}{rest}"));
        }
    }
    if let Some(rest) = url.strip_prefix("https://mediafilez.forgecdn.net/") {
        return Some(format!("https://mod.mcimirror.top/{rest}"));
    }
    None
}

/// 这个官方 URL 是否**只存在于镜像上**（原版 Mojang 源上根本没有这个文件）。
///
/// 依据 ADR-026 ②（PCL2 源码的显式注释「不添加原版源」）：
/// Forge / Fabric / NeoForge 的 maven 库**不在 Mojang 的源上**，
/// 给它们挂一个 `libraries.minecraft.net` 候选只是白白浪费一次注定 404 的请求 ——
/// 批量安装时这类库有几十上百个，累积起来是实打实的等待时间。
///
/// 注意：这里只对**加载器自己的 maven** 生效；原版库仍然两个源都留
/// （原版库在两边都有，多一个候选就是多一次活命机会）。
pub fn not_on_official_source(url: &str) -> bool {
    const LOADER_PREFIXES: [&str; 5] = [
        "https://maven.fabricmc.net/",
        "https://maven.minecraftforge.net/",
        "https://maven.neoforged.net/",
        "https://maven.quiltmc.org/",
        "https://files.minecraftforge.net/",
    ];
    LOADER_PREFIXES.iter().any(|p| url.starts_with(p))
}

/// 为一个下载项生成**候选源列表**（按优先级），供多源回退使用。
///
/// ★ 不变量：**只要两个 URL 真的不同，就必须都在列表里**（可用的源不能只剩一个）。
///   踩过的坑（2026-09-11）：客户端 jar 落在一个没有改写规则的域上，
///   于是官方地址自己既是首选又是"兜底"，两个候选其实是同一个 URL，
///   实测被中途掐断后**没有任何退路**，整个安装就此失败。
///
/// ★ 反过来，**镜像地址与官方地址相同时只留一个**（真正没有任何镜像的域，
///   如 Adoptium / OptiFine），此时传输层自己的重试就是唯一的活命手段。
///
/// ★ Modrinth / CurseForge 是特例：它们有 mcimirror 兜底，见下面那条分支。
pub fn candidate_urls(original: &str, preferred: Source) -> Vec<(Source, String)> {
    let mirrored = mirror_url(original, Source::Bmclapi);
    let official = original.to_string();

    // ★ Modrinth / CurseForge：**官方 CDN 首选，mcimirror 兜底**。
    //
    //   为什么必须有这一条（用户报的"下载慢得要死 / 有些版本甚至报错"）：
    //   这两个域的地址在镜像表里改写不出东西，于是候选列表**只有一个**
    //   —— 一旦它慢、被限流、或 CDN 边缘挂住，整个下载就只剩重试，
    //   没有任何"换一条路"的余地。实测就是这样把 2 MB 的 Fabric API
    //   判成"装不上"的（见 net/download.rs 里 `switchable` 的说明）。
    //
    //   顺序刻意是"官方在前"：本机实测官方 230 KB/s、mcimirror 146 KB/s，
    //   把镜像放首位会拖慢所有人；它只在前面失败时才被用到。
    if let Some(m) = mcimirror_url(original) {
        if m != official {
            return vec![(preferred, official), (Source::Bmclapi, m)];
        }
    }

    // 镜像改写没生效（没有镜像的域）→ 只有一个候选，且两种源都指向它
    if mirrored == official {
        return vec![(preferred, official)];
    }

    // 加载器 maven：官方源上不存在 → 不给官方候选
    if not_on_official_source(original) {
        return vec![(Source::Bmclapi, mirrored)];
    }

    let primary = match preferred {
        Source::Bmclapi => (Source::Bmclapi, mirrored.clone()),
        Source::Mojang => (Source::Mojang, official.clone()),
    };
    let fallback = match preferred {
        Source::Bmclapi => (Source::Mojang, official),
        Source::Mojang => (Source::Bmclapi, mirrored),
    };

    // 顺序：用户选的源优先，另一个兜底。
    vec![primary, fallback]
}

/// 版本清单 URL
pub fn version_manifest_url(source: Source) -> String {
    match source {
        Source::Mojang => MOJANG_VERSION_MANIFEST.to_string(),
        Source::Bmclapi => format!("{BMCLAPI_BASE}/mc/game/version_manifest_v2.json"),
    }
}

/// 某个 MC 版本的详情 JSON 的镜像地址（BMCLAPI 专有，省一次清单解析）
pub fn bmclapi_version_json(mc_version: &str) -> String {
    format!("{BMCLAPI_BASE}/version/{mc_version}/json")
}

/// 加载器安装器的 maven 地址（优先 BMCLAPI）
pub fn forge_installer_url(mc_version: &str, forge_version: &str, source: Source) -> String {
    let path = format!(
        "net/minecraftforge/forge/{mc}-{fv}/forge-{mc}-{fv}-installer.jar",
        mc = mc_version,
        fv = forge_version
    );
    match source {
        Source::Bmclapi => format!("{BMCLAPI_BASE}/maven/{path}"),
        Source::Mojang => format!("{FORGE_MAVEN}/{path}"),
    }
}

/// NeoForge 安装器的 maven 地址。
///
/// ★★ **包名按版本段决定**（源码事实，PCL2 `ModDownload.vb:831`）：
///   ```
///   Dim PackageName As String = If(Inherit = "1.20.1", "forge", "neoforge")
///   ```
///   NeoForge 最早是 Forge 的一个分支，1.20.1 段的产物发布在
///   **`net/neoforged/forge`** 名下（版本号形如 `1.20.1-47.1.105`），
///   1.20.4 起才改成 `net/neoforged/neoforge`。
///
/// 判定方式：NeoForge 从 **20.2** 开始走新坐标（20.2 = 1.20.2 的第一个版本），
/// 所以主版本号 < 20 或等于 20.1 的一律用 `forge`。
/// 实测两侧都在线：
///   * `bmclapi2/neoforge/list/1.20.1` → 60 条，安装器路径是 `net/neoforged/forge/…`
///   * 21.x 的版本路径是 `net/neoforged/neoforge/…`
///
/// ★ 这只是**兜底**：调用方（`neoforge_installer_url_for`）优先用
///   BMCLAPI 列表里服务端自己给的 `installerPath` —— 坐标这种事不该由我们猜。
pub fn neoforge_installer_url(neoforge_version: &str, source: Source) -> String {
    neoforge_installer_url_with_mc("", neoforge_version, source)
}

/// 同上，但**带上 MC 版本**（判坐标最可靠的方式 —— 见 `neoforge_package_for`）。
///
/// ★ 注意 artifact **文件名**也跟着包名走（实测 2026-09-13）：
///   1.20.1 段服务端给的路径是
///   `/maven/net/neoforged/forge/1.20.1-47.1.85/forge-1.20.1-47.1.85-installer.jar`
///   —— 目录是 `forge/`，**文件名也是 `forge-…`**。
///   我第一版只改了目录、文件名仍写 `neoforge-…`，实测 404。
pub fn neoforge_installer_url_with_mc(
    mc_version: &str,
    neoforge_version: &str,
    source: Source,
) -> String {
    let mc = if mc_version.trim().is_empty() {
        None
    } else {
        Some(mc_version.trim())
    };
    let pkg = neoforge_package_for(mc, neoforge_version);
    let path = format!("net/neoforged/{pkg}/{v}/{pkg}-{v}-installer.jar", v = neoforge_version);
    match source {
        Source::Bmclapi => format!("{BMCLAPI_BASE}/maven/{path}"),
        Source::Mojang => format!("https://maven.neoforged.net/releases/{path}"),
    }
}

/// NeoForge 的 maven artifact 名：`neoforge` 还是旧的 `forge`？
///
/// ★★ 这一条**不能只看 NeoForge 版本号**（我第一版就是这么写的，被实测打回来了）：
///   1.20.1 段的版本号是 **`1.20.1-47.1.105`** —— 剥掉 MC 前缀后是 `47.1.105`，
///   和 1.21 段的 `47.1.5` 长得一样，但两者在**完全不同的坐标**下：
///
///   | 版本号 | 坐标 | 说明 |
///   |---|---|---|
///   | `1.20.1-47.1.105` | `net/neoforged/forge` | 1.20.1 段（NeoForge 还是 Forge 的分支） |
///   | `21.1.72` | `net/neoforged/neoforge` | 1.20.4 起 |
///
///   所以判据是**两段**：
///     ① 有 `mc_version` 时以它为准（`1.20.1` / `1.20.2` 及以前 → `forge`）；
///     ② 只有版本号时看它**有没有 `1.20.x-` 前缀** —— 只有 1.20.1 段的
///        NeoForge 才会长成那样（新版本都是 `21.x.y` 或 `20.4.x`）。
///
/// ★ 这只是**兜底**：调用方（`neoforge_installer_url_for`）优先用 BMCLAPI
///   列表里服务端自己给的 `installerPath` —— 坐标这种事不该由我们猜。
///   实测那条路径是 `/maven/net/neoforged/forge/1.20.1-47.1.105/…`。
pub fn neoforge_package_for(mc_version: Option<&str>, neoforge_version: &str) -> &'static str {
    // ① 有 MC 版本 → 直接按版本段判
    //
    //    ★ 边界必须是 **1.20.1**（PCL2 的源码就是 `If(Inherit = "1.20.1", "forge", …)`）：
    //      1.20.2 起 NeoForge 就换了新坐标。所以判据是
    //      "1.20 及以前，且 minor ≤ 20 时 patch ≤ 1"。
    if let Some(mc) = mc_version {
        let mut it = mc.split('.');
        let major: u32 = it.next().and_then(|s| s.parse().ok()).unwrap_or(99);
        let minor: u32 = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        let patch: u32 = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        let legacy = major < 2 && (minor < 20 || (minor == 20 && patch <= 1));
        return if legacy { "forge" } else { "neoforge" };
    }
    // ② 只有版本号 → 看有没有 `1.20.x-` 这种 MC 前缀
    let v = neoforge_version.trim();
    if let Some((head, _)) = v.split_once('-') {
        if head.starts_with("1.20.") {
            return "forge";
        }
    }
    // ③ 剩下的新版本号形如 20.2+ / 21.x / 26.x
    let major: u32 = v
        .split('.')
        .next()
        .and_then(|s| s.parse().ok())
        .unwrap_or(99);
    if major < 20 { "forge" } else { "neoforge" }
}

/// 旧名字（`neoforge_package_name` 的名字更准确地反映了"要看两段"这件事）
pub fn neoforge_maven_package(neoforge_version: &str) -> &'static str {
    neoforge_package_for(None, neoforge_version)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mirrors_resources_path() {
        assert_eq!(
            mirror_url(
                "https://resources.download.minecraft.net/ab/abcdef",
                Source::Bmclapi
            ),
            "https://bmclapi2.bangbang93.com/assets/ab/abcdef"
        );
    }

    #[test]
    fn mirrors_libraries_path() {
        assert_eq!(
            mirror_url(
                "https://libraries.minecraft.net/org/ow2/asm/asm/9.5/asm-9.5.jar",
                Source::Bmclapi
            ),
            "https://bmclapi2.bangbang93.com/maven/org/ow2/asm/asm/9.5/asm-9.5.jar"
        );
    }

    #[test]
    fn mirrors_neoforge_maven() {
        // ★ 这台机器上 maven.neoforged.net 不可达，必须能改写
        assert_eq!(
            mirror_url(
                "https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.72/x.jar",
                Source::Bmclapi
            ),
            "https://bmclapi2.bangbang93.com/maven/net/neoforged/neoforge/21.1.72/x.jar"
        );
    }

    /// ★★ NeoForge 的 maven 坐标**按版本段不同**（PCL2 `ModDownload.vb:831`）。
    ///
    ///   1.20.1 段的产物发布在 `net/neoforged/forge` 名下，
    ///   我们原来一律拼 `neoforge` —— 于是 1.20.1 上装 NeoForge 会 404，
    ///   界面只说"安装失败"，用户完全不知道为什么。
    ///
    ///   ★ 第一版实现只按版本号第一段判（`< 20 → forge`），被实测打回来了：
    ///     1.20.1 段的版本号是 **`1.20.1-47.1.105`**，剥掉前缀后的 `47.x`
    ///     与 1.21 段的 `47.x` 长得一样，但坐标完全不同。
    ///     所以必须**同时看 MC 版本**（或看有没有 `1.20.x-` 前缀）。
    #[test]
    fn neoforge_package_name_follows_the_version_generation() {
        // ① 有 MC 版本时以 MC 版本为准（这才是权威判据）
        assert_eq!(neoforge_package_for(Some("1.20.1"), "1.20.1-47.1.105"), "forge");
        assert_eq!(neoforge_package_for(Some("1.20.1"), "47.1.105"), "forge");
        assert_eq!(neoforge_package_for(Some("1.20.2"), "20.2.0"), "neoforge");
        assert_eq!(neoforge_package_for(Some("1.20.4"), "20.4.237"), "neoforge");
        assert_eq!(neoforge_package_for(Some("1.21.1"), "21.1.72"), "neoforge");
        assert_eq!(neoforge_package_for(Some("1.12.2"), "1.0.0"), "forge");

        // ② 只有版本号时：`1.20.x-` 前缀 = 1.20.1 段（只有那一代长这样）
        assert_eq!(neoforge_maven_package("1.20.1-47.1.105"), "forge");
        assert_eq!(neoforge_maven_package("21.1.72"), "neoforge");
        assert_eq!(neoforge_maven_package("20.4.237"), "neoforge");
        assert_eq!(neoforge_maven_package("20.2.0"), "neoforge");
        // 解析不出来时按新坐标（当前主流），而且调用方本来有更可靠的路
        assert_eq!(neoforge_maven_package("weird"), "neoforge");
    }

    /// 安装器地址要真的落到正确的坐标目录上（实测过的两条）
    #[test]
    fn neoforge_installer_url_uses_the_right_coordinate() {
        // 1.20.1 段：BMCLAPI 服务端给的 installerPath 就是这个形状
        // （/maven/net/neoforged/forge/1.20.1-47.1.85/forge-1.20.1-47.1.85-installer.jar）
        // ★ 目录与**文件名**都要用 forge —— 只改目录会 404（实测踩过）
        let old = neoforge_installer_url("1.20.1-47.1.85", Source::Bmclapi);
        assert!(
            old.contains("/net/neoforged/forge/1.20.1-47.1.85/forge-1.20.1-47.1.85-installer.jar"),
            "1.20.1 段必须用旧的 forge 坐标（目录与文件名都是 forge）：{old}"
        );
        let new = neoforge_installer_url("21.1.72", Source::Bmclapi);
        assert!(
            new.contains("/net/neoforged/neoforge/21.1.72/neoforge-21.1.72-installer.jar"),
            "1.20.2 之后必须用 neoforge 坐标：{new}"
        );
        // 官方源走 maven.neoforged.net，坐标规则一致
        assert!(neoforge_installer_url("1.20.1-47.1.85", Source::Mojang)
            .starts_with("https://maven.neoforged.net/releases/net/neoforged/forge/"));
    }

    #[test]
    fn leaves_third_party_alone() {
        // Adoptium 没有镜像，不该被改写
        let u = "https://api.adoptium.net/v3/assets/latest/21/hotspot";
        assert_eq!(mirror_url(u, Source::Bmclapi), u);
    }

    /* ---------- Modrinth / CurseForge 的 mcimirror 兜底 ---------- */

    /// ★ 回归：Modrinth / CurseForge 的下载地址**必须有第二个候选**。
    ///
    ///   为什么值得一条测试：这两个域在镜像改写表里什么都改不出来，
    ///   于是 `candidate_urls` 只会返回**一个**候选 —— 一旦它慢、被限流、
    ///   或 CDN 边缘挂住，就没有任何"换一条路"的余地。
    ///   实测后果：2 MB 的 Fabric API 被判成"装不上"，用户看到的是
    ///   「所有下载源都失败了（试过 1 个）」。
    #[test]
    fn modrinth_downloads_have_a_second_candidate() {
        let jar = "https://cdn.modrinth.com/data/P7dR8mSH/versions/rvI2dfzR/fabric-api.jar";
        let c = candidate_urls(jar, Source::Bmclapi);
        assert_eq!(c.len(), 2, "Modrinth 的 CDN 地址必须有两个候选，实际 {c:?}");
        // 首选必须是官方（实测官方 230 KB/s 比镜像 146 KB/s 快，不能反着来）
        assert_eq!(c[0].1, jar);
        assert_eq!(
            c[1].1,
            "https://mod.mcimirror.top/data/P7dR8mSH/versions/rvI2dfzR/fabric-api.jar"
        );
    }

    #[test]
    fn curseforge_downloads_have_a_second_candidate() {
        let u = "https://edge.forgecdn.net/files/1234/567/sodium.jar";
        let c = candidate_urls(u, Source::Bmclapi);
        assert_eq!(c.len(), 2);
        assert_eq!(c[0].1, u);
        assert_eq!(c[1].1, "https://mod.mcimirror.top/files/1234/567/sodium.jar");

        let api = "https://api.curseforge.com/v1/mods/search?gameId=432";
        let c2 = candidate_urls(api, Source::Bmclapi);
        assert_eq!(c2[1].1, "https://mod.mcimirror.top/curseforge/v1/mods/search?gameId=432");
    }

    /// 实测过的四条改写规则（URL 形状照抄 2026-09-13 的手工验证结果）
    #[test]
    fn mcimirror_url_shapes_are_the_measured_ones() {
        assert_eq!(
            mcimirror_url("https://api.modrinth.com/v2/project/fabric-api").unwrap(),
            "https://mod.mcimirror.top/modrinth/v2/project/fabric-api"
        );
        assert_eq!(
            mcimirror_url("https://staging-api.modrinth.com/v2/tag/loader").unwrap(),
            "https://mod.mcimirror.top/modrinth/v2/tag/loader"
        );
        assert_eq!(
            mcimirror_url("https://cdn.modrinth.com/data/AA/versions/BB/x.jar").unwrap(),
            "https://mod.mcimirror.top/data/AA/versions/BB/x.jar"
        );
        assert_eq!(
            mcimirror_url("https://api.curseforge.com/v1/mods/search").unwrap(),
            "https://mod.mcimirror.top/curseforge/v1/mods/search"
        );
        // mediafilez 是第三条 forgecdn 域名（PCL2 的改写表里有它）
        assert_eq!(
            mcimirror_url("https://mediafilez.forgecdn.net/files/1/2/x.jar").unwrap(),
            "https://mod.mcimirror.top/files/1/2/x.jar"
        );
        // 没有镜像的域必须返回 None（不能瞎改）
        assert!(mcimirror_url("https://api.adoptium.net/v3/x").is_none());
        assert!(mcimirror_url("https://piston-meta.mojang.com/x").is_none());
    }

    /// Modrinth 的**元数据**也要能走镜像（清单拉不到时界面就是空白）
    #[test]
    fn modrinth_api_has_a_mirror_variant() {
        let api = "https://api.modrinth.com/v2/project/sodium/version";
        let m = mcimirror_url(api).expect("Modrinth API 必须有镜像变体");
        assert_ne!(m, api, "镜像地址与官方相同时这个兜底等于没有");
        assert!(m.starts_with("https://mod.mcimirror.top/modrinth/v2/"));
    }

    /// ★★ 回归：**Quilt 的 meta 必须改写**（用户报的"清单很慢/查不出来"）。
    ///
    ///   实测 2026-09-13：
    ///     `meta.quiltmc.org/v3/versions/loader` → **40 秒超时**（两条路径都超时）
    ///     `bmclapi2.bangbang93.com/quilt-meta/v3/versions/loader` → 22 KB / 0.31 秒
    ///
    ///   不改写的话，每次冷启动都要等满超时才放弃 Quilt —— 界面显示"没查到"，
    ///   而它其实一直都在，只是要走镜像。
    #[test]
    fn quilt_meta_is_rewritten_to_bmclapi() {
        assert_eq!(
            mirror_url("https://meta.quiltmc.org/v3/versions/loader", Source::Bmclapi),
            "https://bmclapi2.bangbang93.com/quilt-meta/v3/versions/loader"
        );
        // 带查询串的也要保留
        assert_eq!(
            mirror_url(
                "https://meta.quiltmc.org/v3/versions/loader/1.20.1",
                Source::Bmclapi
            ),
            "https://bmclapi2.bangbang93.com/quilt-meta/v3/versions/loader/1.20.1"
        );
        // Quilt 的 maven 同样改写（产物 jar 也在这台机器上直连不通）
        assert_eq!(
            mirror_url(
                "https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-loader/0.20.0/x.jar",
                Source::Bmclapi
            ),
            "https://bmclapi2.bangbang93.com/maven/org/quiltmc/quilt-loader/0.20.0/x.jar"
        );
        // Mojang 源不改写（那是"要官方数据"的选项）
        assert_eq!(
            mirror_url("https://meta.quiltmc.org/v3/versions/loader", Source::Mojang),
            "https://meta.quiltmc.org/v3/versions/loader"
        );
    }

    /// ★ Fabric 的 meta **故意不改写**：实测官方 2.75 秒比绕镜像更快。
    ///   这条测试是为了防止有人"顺手把 Fabric 也加进镜像表"。
    #[test]
    fn fabric_meta_is_left_alone_because_official_is_faster() {
        assert_eq!(
            mirror_url("https://meta.fabricmc.net/v2/versions/loader", Source::Bmclapi),
            "https://meta.fabricmc.net/v2/versions/loader",
            "Fabric meta 直连实测 2.75s / 38KB，镜像更慢，别绕"
        );
    }

    #[test]
    fn mojang_source_never_rewrites() {
        let u = "https://libraries.minecraft.net/a/b.jar";
        assert_eq!(mirror_url(u, Source::Mojang), u);
    }

    #[test]
    fn mirrors_client_jar_on_piston_data() {
        // ★ 回归测试（2026-09-11）：新版本（实测 26.2）的客户端 jar 在
        //   piston-data.mojang.com，不是 launcher.mojang.com。
        //   漏掉这条改写 → 客户端 jar 只能直连官方 → 39 MB 被中途掐断 →
        //   安装整体失败，表现为"点了下载没反应"。
        const CLIENT: &str = "https://piston-data.mojang.com/v1/objects/2dc72797acbc1b63fc16a11c4ac393605f453754/client.jar";
        assert_eq!(
            mirror_url(CLIENT, Source::Bmclapi),
            "https://bmclapi2.bangbang93.com/v1/objects/2dc72797acbc1b63fc16a11c4ac393605f453754/client.jar"
        );
        // 并且必须真的产生两个不同的候选 —— 不能只有一个"命中注定"的源
        let c = candidate_urls(CLIENT, Source::Bmclapi);
        assert_eq!(c.len(), 2);
        assert_eq!(c[0].0, Source::Bmclapi);
        assert_eq!(c[1].0, Source::Mojang);
        assert_ne!(c[0].1, c[1].1, "两个候选不能是同一个 URL");
    }

    #[test]
    fn candidates_include_fallback() {
        let c = candidate_urls(
            "https://libraries.minecraft.net/a/b.jar",
            Source::Bmclapi,
        );
        assert_eq!(c.len(), 2);
        assert_eq!(c[0].0, Source::Bmclapi);
        assert_eq!(c[1].0, Source::Mojang);
    }

    #[test]
    fn candidates_prefer_requested_source() {
        let c = candidate_urls("https://libraries.minecraft.net/a/b.jar", Source::Mojang);
        assert_eq!(c[0].0, Source::Mojang);
        assert_eq!(c[1].0, Source::Bmclapi);
        assert_eq!(c[0].1, "https://libraries.minecraft.net/a/b.jar");
    }

    #[test]
    fn unmirrorable_url_has_no_duplicate_candidate() {
        // ★ 真的没有任何镜像的域（Adoptium / OptiFine）：改写结果与原文一致，
        //   所以只留一个候选 —— 否则就是"两个候选同一个 URL"的假回退。
        //   单文件传输自带重试（见 download.rs），所以这里不是"只能赌一次"。
        let c = candidate_urls("https://api.adoptium.net/v3/x", Source::Bmclapi);
        assert_eq!(c.len(), 1, "没有镜像时不该产生重复候选：{c:?}");
        assert_eq!(c[0].1, "https://api.adoptium.net/v3/x");

        // ★ 而 Modrinth **有**镜像 → 现在必须有两个候选。
        //   （这条以前断言的是 1 —— 那正是"Modrinth 下载失败就彻底没退路"的根源，
        //    实测把 2 MB 的 Fabric API 判成了装不上。见 mcimirror_url 的说明。）
        let m = candidate_urls("https://api.modrinth.com/v2/x", Source::Bmclapi);
        assert_eq!(m.len(), 2, "Modrinth 现在有 mcimirror 兜底：{m:?}");
        assert_eq!(m[0].1, "https://api.modrinth.com/v2/x");
        assert_ne!(m[0].1, m[1].1, "两个候选不能是同一个 URL（那是假回退）");
    }

    #[test]
    fn loader_maven_has_no_official_candidate() {
        // ★ ADR-026 ②：Fabric / Forge / NeoForge 的库不在 Mojang 源上，
        //   挂官方候选只会换来一次注定失败的请求（批量时累积成可观的等待）。
        for u in [
            "https://maven.fabricmc.net/net/fabricmc/fabric-loader/0.15.0/fabric-loader-0.15.0.jar",
            "https://maven.minecraftforge.net/net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-universal.jar",
            "https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.72/x.jar",
        ] {
            let c = candidate_urls(u, Source::Bmclapi);
            assert_eq!(c.len(), 1, "{u} 应该只有镜像候选：{c:?}");
            assert_eq!(c[0].0, Source::Bmclapi);
            assert!(c[0].1.contains("bmclapi2"), "{u} 的候选必须是镜像：{c:?}");
            assert!(not_on_official_source(u));
        }
    }

    #[test]
    fn vanilla_library_still_has_both_sources() {
        // 原版库两边都有 → 必须保留两个候选
        let c = candidate_urls("https://libraries.minecraft.net/org/ow2/asm/asm/9.5/asm-9.5.jar", Source::Mojang);
        assert_eq!(c.len(), 2);
        assert!(!not_on_official_source(
            "https://libraries.minecraft.net/org/ow2/asm/asm/9.5/asm-9.5.jar"
        ));
    }
}
