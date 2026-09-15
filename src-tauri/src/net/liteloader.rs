//! LiteLoader 自动安装（照 PCL 的实现）
//!
//! ## 为什么现在才做
//!
//!   `addon_install_implemented(LiteLoader)` 一直是 `false` —— 这是诚实的
//!   （Rust 侧只有 `loader_trace` 的磁盘识别，没有安装器）。
//!   这一轮把它做出来。
//!
//! ## 算法来源（不是我猜的）
//!
//!   PCL `ModDownloadLib.vb` 的 `McDownloadLiteLoaderLoader`（787-822 行）。
//!   它比 OptiFine **简单得多** ——
//!   **不需要跑任何安装器**，只需要：
//!     ① 从 `versions.json` 拿到这个 MC 版本的 liteloader 条目；
//!     ② 手写一个 `inheritsFrom` 的版本 JSON，里面放三样东西：
//!        · `libraries`：条目里自带的库 + `com.mumfrey:liteloader:<version>`
//!        · `mainClass`：`net.minecraft.launchwrapper.Launch`
//!        · `arguments.game`：`--tweakClass <条目里的 tweakClass>`
//!     ③ 库文件由**正常的下载流程**去下（`com.mumfrey:liteloader` 那条带 `url`）。
//!
//!   PCL 的版本目录名是 `<mc>-LiteLoader`（第 793 行），我们沿用。
//!
//! ## 数据结构有个坑（实测）
//!
//!   `versions.json` 里每个 MC 版本的条目放在 **`artefacts` 或 `snapshots`**
//!   两个键之一（PCL 第 1040 行就是这么取：
//!   `If(Pair.Value("artefacts"), Pair.Value("snapshots"))`）。
//!   实测：
//!     · 1.7.10 / 1.8 → `artefacts`（正式版，版本号 `1.7.10_04` / `1.8`）
//!     · 1.12.2      → `snapshots`（版本号 `1.12.2-SNAPSHOT`）
//!   只认一个键就会漏掉一半版本。

use serde_json::Value;
use std::path::{Path, PathBuf};

/// LiteLoader 官方的版本清单（BMCLAPI 镜像）
pub const VERSIONS_URL: &str = "https://bmclapi2.bangbang93.com/maven/com/mumfrey/liteloader/versions.json";

/// LiteLoader 的库仓库地址（写进版本 JSON 的 `url`，让下载器知道去哪拿）
pub const LIB_REPO: &str = "https://bmclapi2.bangbang93.com/maven/";

/// 一个 MC 版本对应的 LiteLoader 可用版本
#[derive(Debug, Clone, serde::Serialize)]
pub struct LiteLoaderVersion {
    /// 版本号，如 `1.12.2-SNAPSHOT` / `1.7.10_04`
    pub version: String,
    /// 主 jar 文件名，如 `liteloader-1.12.2-SNAPSHOT.jar`
    pub file: String,
    /// 要挂上去的 tweaker 类
    pub tweak_class: String,
    /// 这个条目自带的前置库（坐标 + 可选 url）
    pub libraries: Vec<LiteLoaderLib>,
    /// 是不是正式版（`artefacts`）而不是快照（`snapshots`）
    pub stable: bool,
    /// 发布时间（Unix 秒，可能为 0）
    pub timestamp: u64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct LiteLoaderLib {
    pub name: String,
    pub url: Option<String>,
}

/// 从 `versions.json` 的原始 JSON 里取出某个 MC 版本的 LiteLoader 条目。
///
/// **纯函数**，可以单测 —— 而它值得单测，因为
/// "artefacts 还是 snapshots" 这个分叉实测各占一半。
pub fn parse_version_entry(root: &Value, mc_version: &str) -> Option<LiteLoaderVersion> {
    let entry = root.get("versions")?.get(mc_version)?;
    // ★ 两个键都要认（PCL 第 1040 行的写法）
    let (container, stable) = match (entry.get("artefacts"), entry.get("snapshots")) {
        (Some(a), _) if a.get("com.mumfrey:liteloader").is_some() => (a, true),
        (_, Some(s)) if s.get("com.mumfrey:liteloader").is_some() => (s, false),
        _ => return None,
    };
    let latest = container
        .get("com.mumfrey:liteloader")?
        .get("latest")?;

    let version = latest.get("version")?.as_str()?.to_string();
    let file = latest.get("file")?.as_str()?.to_string();
    let tweak_class = latest
        .get("tweakClass")
        .and_then(|v| v.as_str())
        .unwrap_or("com.mumfrey.liteloader.launch.LiteLoaderTweaker")
        .to_string();
    let timestamp = latest
        .get("timestamp")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<u64>().ok())
        .or_else(|| latest.get("timestamp").and_then(|v| v.as_u64()))
        .unwrap_or(0);

    let mut libraries: Vec<LiteLoaderLib> = Vec::new();
    if let Some(arr) = latest.get("libraries").and_then(|v| v.as_array()) {
        for l in arr {
            if let Some(name) = l.get("name").and_then(|v| v.as_str()) {
                libraries.push(LiteLoaderLib {
                    name: name.to_string(),
                    url: l.get("url").and_then(|v| v.as_str()).map(|s| s.to_string()),
                });
            }
        }
    }

    Some(LiteLoaderVersion {
        version,
        file,
        tweak_class,
        libraries,
        stable,
        timestamp,
    })
}

/// 拉取并解析整个清单（走镜像，带缓存）。
pub async fn fetch_versions() -> Result<Value, String> {
    // 复用项目里那套"带缓存 + 校验"的取数（与 OptiFine 清单同一条路）
    let v: Value = crate::net::metadata::fetch_cached_json(
        "liteloader_versions.json",
        VERSIONS_URL,
        std::time::Duration::from_secs(6 * 60 * 60),
    )
    .await
    .map_err(|e| format!("拉取 LiteLoader 版本清单失败：{e}"))?;
    Ok(v)
}

/// 某个 MC 版本可用的 LiteLoader（`None` = 上游没有这个版本）
pub async fn available_for(mc_version: &str) -> Result<Option<LiteLoaderVersion>, String> {
    let root = fetch_versions().await?;
    Ok(parse_version_entry(&root, mc_version))
}

/// 安装出来的版本 id（与 PCL 一致：`<mc>-LiteLoader`）
pub fn version_id(mc_version: &str) -> String {
    format!("{mc_version}-LiteLoader")
}

/// LiteLoader 主 jar 在库里的相对路径（maven 布局）。
pub fn lib_relative(version: &str) -> String {
    format!("com/mumfrey/liteloader/{0}/liteloader-{0}.jar", version)
}

/// ★★ 生成版本 JSON —— **核心就是这一个函数**（PCL 第 801-815 行）。
///
/// `inherits_from` 是**挂载点**：
///   · 纯原版上的 LiteLoader → `1.12.2`
///   · **Forge + LiteLoader** → `1.12.2-forge-14.23.5.2860`（挂在 Forge 上！）
///
///   ★ 这一点是实测想明白的：我们的启动器**一次只加载一个版本描述**，
///     所以"Forge + LiteLoader"不能是两份并列的版本目录 ——
///     必须让 LiteLoader 那份沿 `inheritsFrom` **链到 Forge 那份**，
///     合并后 classpath 才是 Forge + LiteLoader + 原版三者的并集。
///     写成 `inheritsFrom: 1.12.2` 的话，Forge 的库一个都不会进 classpath，
///     启动会缺一堆库（而且报错看起来完全不像"挂载点选错了"）。
///
/// 其余字段逐条对齐 PCL：
///   | PCL 行 | 字段 | 我们 |
///   |---|---|---|
///   | 803 | `id` = `<mc>-LiteLoader` | 同 |
///   | 804-806 | `time` / `releaseTime` / `type` | 同（时间取条目里的 timestamp） |
///   | 807 | `arguments.game = ["--tweakClass", <tweakClass>]` | 同 |
///   | 808 | `libraries` = 条目自带的前置库 | 同 |
///   | 809 | 再追加 `com.mumfrey:liteloader:<version>` + `url` | 同 |
///   | 810 | `mainClass` = `net.minecraft.launchwrapper.Launch` | 同 |
///   | 811 | `minimumLauncherVersion` = 18 | 同 |
///   | 812 | `inheritsFrom` = MC 版本 | **改为可指向 Forge** |
///   | 813 | `jar` = MC 版本 | 同（始终是原版的 jar） |
pub fn build_version_json(
    mc_version: &str,
    v: &LiteLoaderVersion,
    inherits_from: &str,
) -> Value {
    let id = version_id(mc_version);

    // 条目自带的前置库（launchwrapper / asm-all / mixin …）
    let mut libraries: Vec<Value> = v
        .libraries
        .iter()
        .map(|l| {
            let mut o = serde_json::Map::new();
            o.insert("name".into(), Value::String(l.name.clone()));
            if let Some(u) = &l.url {
                o.insert("url".into(), Value::String(u.clone()));
            }
            Value::Object(o)
        })
        .collect();
    // ★ liteloader 本体（带 url —— 下载器据此去 BMCLAPI 的 maven 拿）
    libraries.push(serde_json::json!({
        "name": format!("com.mumfrey:liteloader:{}", v.version),
        "url": LIB_REPO,
    }));

    let iso = if v.timestamp > 0 {
        // 不引 chrono，直接给一个固定格式的 UTC 串（Mojang 只把它当信息看）
        format_unix_iso(v.timestamp)
    } else {
        "2026-01-01T00:00:00+08:00".to_string()
    };

    serde_json::json!({
        "id": id,
        "time": iso,
        "releaseTime": iso,
        "type": "release",
        "arguments": {
            "game": ["--tweakClass", v.tweak_class]
        },
        "libraries": libraries,
        "mainClass": "net.minecraft.launchwrapper.Launch",
        "minimumLauncherVersion": 18,
        "inheritsFrom": inherits_from,
        "jar": mc_version,
    })
}

/// Unix 秒 → `YYYY-MM-DDTHH:MM:SSZ`（不引 chrono 的实现）
fn format_unix_iso(secs: u64) -> String {
    // 民用历算法（Howard Hinnant 的 days_from_civil 逆运算）
    let days = (secs / 86400) as i64;
    let rem = secs % 86400;
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

/// 安装结果
#[derive(Debug, Clone, serde::Serialize)]
pub struct LiteLoaderInstall {
    pub version_id: String,
    pub version_dir: PathBuf,
    pub json_path: PathBuf,
    /// 主 jar 会落在哪（下载流程负责真的下下来）
    pub jar_path: PathBuf,
    pub tweak_class: String,
    pub libraries: usize,
    pub summary: String,
}

/// 一条要下的库
struct LibTask {
    url: String,
    rel: String,
    label: String,
}

/// 把这个 LiteLoader 版本需要的**所有文件**列出来（纯函数，可单测）。
///
/// ★ 为什么需要它：光写版本 JSON 是不够的 —— LiteLoader 依赖三个 jar
///   （launchwrapper / asm-all / liteloader 本体），它们**必须真的在磁盘上**，
///   否则启动时 `scan_classpath` 会报缺库、游戏直接起不来。
///
///   实测（第一次跑真机测试就是这么挂的）：写完 JSON 直接启动 → 报
///   `缺库，肯定起不来：["net.minecraft:launchwrapper:1.12", "org.ow2.asm:asm-all:5.2"]`。
///   所以"安装"必须包含"把文件下下来"这一步。
///
/// 地址来源（逐条对照 PCL / 实测可达性）：
///   · `com.mumfrey:liteloader` → BMCLAPI 的 maven 镜像（实测 HTTP 200、1.6 MB）
///   · 其余前置库 → 条目自带 `url`（如 spongepowered 的 mixin），
///     没有就按坐标拼**官方 maven**（`net.minecraft:launchwrapper` 与
///     `org.ow2.asm:asm-all` 都在 `libraries.minecraft.net` 上，实测可下）
fn plan_lib_tasks(v: &LiteLoaderVersion) -> Vec<LibTask> {
    let mut out: Vec<LibTask> = Vec::new();
    for l in &v.libraries {
        let Some(rel) = maven_rel(&l.name) else { continue };
        let url = match &l.url {
            Some(u) if !u.is_empty() => format!("{}/{}", u.trim_end_matches('/'), rel),
            _ => format!("https://libraries.minecraft.net/{rel}"),
        };
        out.push(LibTask {
            url,
            rel,
            label: l.name.clone(),
        });
    }
    // 本体排最后（它最大，日志里排最后更好读）
    out.push(LibTask {
        url: jar_url(&v.version),
        rel: lib_relative(&v.version),
        label: format!("com.mumfrey:liteloader:{}", v.version),
    });
    out
}

/// `group:artifact:version[:classifier]` → maven 相对路径
fn maven_rel(coord: &str) -> Option<String> {
    let parts: Vec<&str> = coord.split(':').collect();
    let g = parts.first()?.to_string();
    let a = parts.get(1)?.to_string();
    let ver = parts.get(2)?.to_string();
    let classifier = parts.get(3).map(|c| format!("-{c}")).unwrap_or_default();
    Some(format!(
        "{}/{a}/{ver}/{a}-{ver}{classifier}.jar",
        g.replace('.', "/")
    ))
}

/// 真正"安装"：写版本 JSON **并把所有依赖下下来**。
///
/// ★ 与 OptiFine 不同，这里**不需要**跑任何安装器 —— LiteLoader 就是
///   "挂一个 tweaker + 几个库"，PCL 也是这么做的（`ModDownloadLib.vb` 798-819）。
///   但也正因为没有安装器，**下文件这件事必须我们自己做完**。
pub async fn install(
    shared: &Path,
    mc_version: &str,
    v: &LiteLoaderVersion,
    base_version_id: Option<&str>,
    on_progress: &(dyn Fn(String) + Send + Sync),
) -> Result<LiteLoaderInstall, String> {
    // ★★ ① 先把"挂载点"定下来，再干别的。
    //
    //   顺序是有讲究的：挂载点选错了的话，后面下载全成功也一样起不来，
    //   而症状（缺库 / 找不到主类）看起来跟"下载坏了"差不多 —— 排查会绕远路。
    //   所以**先判挂载点，判不过当场退**。
    //
    //   `base_version_id` = 界面组合器选中的**基座加载器版本目录**，
    //   例如 Forge 的 `1.12.2-forge-14.23.5.2860`。要求：
    //     · 目录在
    //     · 带同名版本 JSON
    //   不满足就报错，**绝不偷偷退化成原版** —— 那会丢掉 Forge 的全部库，
    //   制造出"装好了却打不开"这种最难查的故障。
    let mount = match base_version_id.map(str::trim).filter(|s| !s.is_empty()) {
        Some(base) => {
            let json = shared
                .join("versions")
                .join(base)
                .join(format!("{base}.json"));
            if !json.is_file() {
                return Err(format!(
                    "LiteLoader 要挂在 {base} 上，但这个版本目录里没有版本描述文件。\n\
                     缺失：{}\n\n\
                     请先在「下载」页把这个版本（连同它的加载器）装好，再回来装 LiteLoader。",
                    json.display()
                ));
            }
            base.to_string()
        }
        None => {
            // 没有基座加载器 → 挂原版。原版必须在（LiteLoader 靠 inheritsFrom 拿 jar 与库）
            let json = shared
                .join("versions")
                .join(mc_version)
                .join(format!("{mc_version}.json"));
            if !json.is_file() {
                return Err(format!(
                    "LiteLoader 是挂在原版 {mc_version} 上的，所以原版要先装好。\n\
                     现在缺：{}\n\n\
                     请先在「下载」页安装一次原版 {mc_version}，再回来装 LiteLoader。",
                    json.display()
                ));
            }
            mc_version.to_string()
        }
    };

    // ② 写版本 JSON（`inheritsFrom` = 上面定下来的挂载点）
    let id = version_id(mc_version);
    let dir = shared.join("versions").join(&id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建版本目录失败：{e}"))?;
    let json_path = dir.join(format!("{id}.json"));
    let json = build_version_json(mc_version, v, &mount);
    std::fs::write(
        &json_path,
        serde_json::to_string_pretty(&json).map_err(|e| format!("序列化失败：{e}"))?,
    )
    .map_err(|e| format!("写版本描述失败：{e}"))?;

    // ③ ★ 把依赖真的下下来
    let tasks = plan_lib_tasks(v);
    let libs_root = shared.join("libraries");
    let mut downloaded = 0usize;
    for t in &tasks {
        let dest = libs_root.join(&t.rel);
        // 已经有了就跳过（可重入：重装一次不会白下 1.6 MB）
        if dest.is_file() {
            if let Ok(m) = std::fs::metadata(&dest) {
                if m.len() > 1024 {
                    downloaded += 1;
                    continue;
                }
            }
        }
        on_progress(format!("下载 {}", t.label));
        if let Some(p) = dest.parent() {
            std::fs::create_dir_all(p).map_err(|e| format!("创建库目录失败：{e}"))?;
        }
        let task = crate::net::download::DownloadTask::new(
            dest.clone(),
            t.url.clone(),
            String::new(),
            0,
            format!("LiteLoader 依赖 {}", t.label),
        );
        let cancel = crate::net::download::CancelToken::new();
        crate::net::download::download_one(&task, crate::net::mirror::Source::Bmclapi, &cancel)
            .await
            .map_err(|e| format!("下载 {} 失败：{e}\n地址：{}", t.label, t.url))?;
        let size = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
        if size < 512 {
            // 小到不像 jar —— 多半是镜像返回了错误页面
            let _ = std::fs::remove_file(&dest);
            return Err(format!(
                "下载到的 {} 只有 {size} 字节，明显不对（镜像可能返回了错误页面）。\n地址：{}",
                t.label, t.url
            ));
        }
        downloaded += 1;
    }

    let jar_path = libs_root.join(lib_relative(&v.version));
    Ok(LiteLoaderInstall {
        version_id: id.clone(),
        version_dir: dir.clone(),
        json_path,
        jar_path,
        tweak_class: v.tweak_class.clone(),
        libraries: downloaded,
        summary: format!(
            "LiteLoader {} 已装到 {}（挂在 {} 上，tweaker {}，{} 个库都已就位）",
            v.version, mc_version, mount, v.tweak_class, downloaded
        ),
    })
}

/// 主 jar 的下载地址（BMCLAPI 镜像）
pub fn jar_url(version: &str) -> String {
    format!("{}{}", LIB_REPO, lib_relative(version))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(stable: bool) -> Value {
        let key = if stable { "artefacts" } else { "snapshots" };
        serde_json::json!({
            "versions": {
                "1.12.2": {
                    key: {
                        "com.mumfrey:liteloader": {
                            "latest": {
                                "tweakClass": "com.mumfrey.liteloader.launch.LiteLoaderTweaker",
                                "libraries": [
                                    {"name": "net.minecraft:launchwrapper:1.12"},
                                    {"name": "org.ow2.asm:asm-all:5.2"}
                                ],
                                "file": "liteloader-1.12.2-SNAPSHOT.jar",
                                "version": "1.12.2-SNAPSHOT",
                                "timestamp": "1511880271"
                            }
                        }
                    }
                },
                "1.7.10": {
                    "artefacts": {
                        "com.mumfrey:liteloader": {
                            "latest": {
                                "tweakClass": "com.mumfrey.liteloader.launch.LiteLoaderTweaker",
                                "libraries": [{"name": "net.minecraft:launchwrapper:1.12"}],
                                "file": "liteloader-1.7.10.jar",
                                "version": "1.7.10_04",
                                "timestamp": "1437000000"
                            }
                        }
                    }
                }
            }
        })
    }

    /// ★ `artefacts` 与 `snapshots` **两个键都要认**。
    ///
    ///   实测：1.7.10 / 1.8 在 `artefacts` 下，1.12.2 在 `snapshots` 下。
    ///   只认一个就漏掉一半版本（PCL 第 1040 行也是两个都取）。
    #[test]
    fn parses_both_artefacts_and_snapshots() {
        let root = sample(false);
        let v = parse_version_entry(&root, "1.12.2").expect("snapshots 下的条目要能解析");
        assert_eq!(v.version, "1.12.2-SNAPSHOT");
        assert!(!v.stable, "snapshots 里的是快照");
        assert_eq!(v.libraries.len(), 2);
        assert_eq!(v.tweak_class, "com.mumfrey.liteloader.launch.LiteLoaderTweaker");
        assert_eq!(v.timestamp, 1511880271);

        let v2 = parse_version_entry(&root, "1.7.10").expect("artefacts 下的条目要能解析");
        assert_eq!(v2.version, "1.7.10_04");
        assert!(v2.stable, "artefacts 里的是正式版");
    }

    #[test]
    fn missing_mc_version_is_none_not_panic() {
        let root = sample(false);
        assert!(parse_version_entry(&root, "1.99").is_none());
        assert!(parse_version_entry(&serde_json::json!({}), "1.12.2").is_none());
        assert!(parse_version_entry(&serde_json::json!({"versions": {}}), "1.12.2").is_none());
    }

    /// ★ 版本 JSON 的每个字段都要与 PCL 对齐（`ModDownloadLib.vb` 801-815）。
    #[test]
    fn version_json_matches_pcl_fields() {
        let v = parse_version_entry(&sample(false), "1.12.2").unwrap();
        let j = build_version_json("1.12.2", &v, "1.12.2");

        assert_eq!(j["id"], "1.12.2-LiteLoader");
        assert_eq!(j["inheritsFrom"], "1.12.2");
        assert_eq!(j["jar"], "1.12.2");
        assert_eq!(j["mainClass"], "net.minecraft.launchwrapper.Launch");
        assert_eq!(j["minimumLauncherVersion"], 18);
        assert_eq!(j["type"], "release");

        // tweakClass 必须传下去 —— 少了它 launchwrapper 不知道要加载 LiteLoader
        assert_eq!(j["arguments"]["game"][0], "--tweakClass");
        assert_eq!(
            j["arguments"]["game"][1],
            "com.mumfrey.liteloader.launch.LiteLoaderTweaker"
        );

        // 库：条目自带的 2 个 + liteloader 本体 = 3
        let libs = j["libraries"].as_array().unwrap();
        assert_eq!(libs.len(), 3, "库要带上条目自带的前置 + liteloader 本体：{libs:?}");
        let names: Vec<&str> = libs.iter().filter_map(|l| l["name"].as_str()).collect();
        assert!(names.contains(&"net.minecraft:launchwrapper:1.12"));
        assert!(names.contains(&"org.ow2.asm:asm-all:5.2"));
        assert!(
            names.contains(&"com.mumfrey:liteloader:1.12.2-SNAPSHOT"),
            "liteloader 本体必须在：{names:?}"
        );
        // ★ 本体那条必须带 url —— 下载器靠它去 BMCLAPI 拿（否则会去官方 maven 404）
        let body = libs
            .iter()
            .find(|l| l["name"].as_str().unwrap_or("").contains("mumfrey"))
            .unwrap();
        assert_eq!(body["url"], LIB_REPO);
    }

    /// ★★ 挂在 Forge 上时，`inheritsFrom` 必须是 **Forge 那份版本描述**。
    ///
    ///   为什么这条必须单独钉一个测试：
    ///     界面的组合规则要求「LiteLoader 必须有 Forge 作基座」，
    ///     而版本描述里的挂载点**原先写死成 mc_version**（= 1.12.2）。
    ///     两边说的不是一回事 —— 用户选了 Forge + LiteLoader，
    ///     装出来的却是"挂原版的 LiteLoader"，Forge 的库一个都没进 classpath。
    ///     这种 bug 不会在安装时报错，只会在启动时缺库，最难查。
    #[test]
    fn mounts_on_forge_when_asked() {
        let v = parse_version_entry(&sample(false), "1.12.2").unwrap();
        let forge = "1.12.2-forge-14.23.5.2860";
        let j = build_version_json("1.12.2", &v, forge);

        assert_eq!(
            j["inheritsFrom"], forge,
            "选了 Forge 作基座，挂载点就得是 Forge 的版本目录名"
        );
        // ★ `jar` 仍然是原版的 —— Forge 的库是"额外叠加"，不是替换游戏本体
        assert_eq!(
            j["jar"], "1.12.2",
            "jar 指原版客户端 jar；Forge 是叠加在它上面的，不能改"
        );
        // 版本目录名与挂载点无关（LiteLoader 自己的目录只有一份）
        assert_eq!(j["id"], "1.12.2-LiteLoader");
    }

    #[test]
    fn lib_path_is_maven_layout() {
        assert_eq!(
            lib_relative("1.12.2-SNAPSHOT"),
            "com/mumfrey/liteloader/1.12.2-SNAPSHOT/liteloader-1.12.2-SNAPSHOT.jar"
        );
        assert_eq!(version_id("1.7.10"), "1.7.10-LiteLoader");
    }

    #[test]
    fn unix_iso_formatting() {
        // 1511880271 = 2017-11-28T14:44:31Z（用标准库交叉验算）
        assert_eq!(format_unix_iso(1511880271), "2017-11-28T14:44:31Z");
        assert_eq!(format_unix_iso(0), "1970-01-01T00:00:00Z");
    }
}
