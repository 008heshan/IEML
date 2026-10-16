//! Java 运行时自动获取（ADR-013 / ADR-030）
//!
//! 从 Adoptium（Eclipse Temurin）下载 JRE。
//!
//! 三个要点：
//!   ① **API 优先**：先问 `/v3/assets/latest/{major}/hotspot` 要到真实下载地址与 SHA256，
//!      而不是猜一个 URL 拼出来 —— 猜的 URL 版本一变就 404。
//!   ② **自动下载的 JRE 必须能被用户看到和删除**（ADR-013 硬要求），
//!      所以装到 `data/java/<major>/` 下，体积也记下来展示给用户。
//!   ③ 下载后要**真的验证能跑**（执行 `java -version`），
//!      不验的话可能装了个坏包，到启动时才炸。

use crate::net::download::{download_one, sha256_of_file, DownloadTask};
use crate::net::mirror::Source;
use crate::net::{NetError, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const ADOPTIUM: &str = "https://api.adoptium.net/v3";

#[derive(Debug, Clone, Serialize)]
pub struct JavaDownloadInfo {
    pub major: u32,
    pub version: String,
    pub release_name: String,
    pub download_url: String,
    pub size: u64,
    pub checksum: String,
    pub checksum_algorithm: String,
}

/// 当前平台对应的 Adoptium 参数
fn platform_params() -> (&'static str, &'static str, &'static str) {
    let os = if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "mac"
    } else {
        "linux"
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "aarch64",
        "x86" => "x86",
        _ => "x64",
    };
    // 下载 JRE 而不是完整 JDK：启动器只需要运行游戏，JRE 体积小 40%
    (os, arch, "jre")
}

/// 查询某个主版本的 JRE 下载信息
pub async fn query_java(major: u32) -> Result<JavaDownloadInfo> {
    let (os, arch, image) = platform_params();
    // 把 `jre` 换成 `jdk` 也可以 —— 有些版本没有独立 jre 包时回退
    let url = format!(
        "{ADOPTIUM}/assets/latest/{major}/hotspot?os={os}&architecture={arch}&image_type={image}&vendor=eclipse"
    );

    #[derive(Deserialize)]
    struct Asset {
        binary: Binary,
        version: VersionInfo,
        release_name: String,
    }
    #[derive(Deserialize)]
    struct Binary {
        package: Package,
    }
    #[derive(Deserialize)]
    struct Package {
        checksum: String,
        size: u64,
        link: String,
    }
    #[derive(Deserialize)]
    struct VersionInfo {
        semver: String,
    }

    let assets: Vec<Asset> = crate::net::get_json(&url).await?;
    let first = assets
        .into_iter()
        .next()
        .ok_or_else(|| NetError::Other(format!("Adoptium 没有 Java {major} 的 {os}/{arch} 构建")))?;

    // Adoptium 给的是 SHA256
    Ok(JavaDownloadInfo {
        major,
        version: first.version.semver,
        release_name: first.release_name,
        download_url: first.binary.package.link,
        size: first.binary.package.size,
        checksum: first.binary.package.checksum,
        checksum_algorithm: "sha256".into(),
    })
}

/// 下载并安装 Java 到 `java_root/<major>/`
///
/// 返回安装后的 `java.exe` 路径。
pub async fn install_java(
    major: u32,
    java_root: &Path,
    on_progress: impl Fn(u64, u64),
) -> Result<PathBuf> {
    let info = query_java(major).await?;
    let target_dir = java_root.join(major.to_string());
    std::fs::create_dir_all(&target_dir)
        .map_err(|e| NetError::Other(format!("无法创建 Java 目录：{e}")))?;

    // 已经装过且能用 → 直接用
    if let Some(existing) = find_java_binary(&target_dir) {
        if probe_java(&existing).is_some() {
            on_progress(info.size, info.size);
            return Ok(existing);
        }
    }

    on_progress(0, info.size);

    // ---------- 下载压缩包 ----------
    let ext = if cfg!(windows) { "zip" } else { "tar.gz" };
    let archive = java_root.join(format!("java-{major}.{ext}"));

    /*
     * ★★ 第二阶段 A：**按类别的响应体体积上限**（清单第 172 行「Cap what you accept」）。
     *
     *   Java 运行时是全仓库**最大的单个下载**（JDK 17 压缩包约 190 MB）。
     *   类别与默认值表在 `domain::archive_guard`（纯判据、已单测）：
     *     `ArtifactClass::JavaRuntime` ⇒ 1 GiB（真实规模 ×5 的余量）。
     *
     *   这里把类别算好了，**引擎只差接线两处**：
     *     ① 建连前：`cap.rejected_by_declared_size(info.size)` —— Adoptium 会报大小，
     *        一个声明 8 GiB 的"Java 21"在建立连接前就该被拒；
     *     ② 收 chunk 时：`archive_guard::ByteMeter::new(cap).add(n)` ——
     *        万一 Adoptium（或中间人）不报 `Content-Length`，这是唯一的兜底；
     *        超限 ⇒ 断流 + 删 `.part` + 报错点名这个文件。
     *   ★ 任务标签（`"Java {} 运行时"`）也落在同一张表上 —— 引擎按标签兜底时
     *     `archive_guard::class_from_label` 认得它（有测试钉住这一点）。
     */
    let cap = crate::domain::archive_guard::ByteCap::for_class(
        crate::domain::archive_guard::ArtifactClass::JavaRuntime,
    );
    // 顺手钉住"上限不会误杀正常 Java"这条不变量：Adoptium 声明的大小必须过闸门。
    // （真出问题只在 debug/测试构建里炸，release 不因为一句自检而改变行为。）
    debug_assert!(
        !cap.rejected_by_declared_size(info.size),
        "Java 运行时的体积上限（{}）小于 Adoptium 声明的大小（{} 字节）—— 会把功能改死",
        cap.describe(),
        info.size
    );

    let task = DownloadTask::new(
        archive.clone(),
        info.download_url.clone(),
        // Adoptium 给 SHA256，我们的引擎算的是 SHA1 → 这里不交给引擎校验，
        // 下载后单独验 SHA256（见下）
        String::new(),
        info.size,
        format!("Java {} 运行时", info.version),
    );
    // ★★ Adoptium **没有可用的国内镜像** —— 2026-09-16 逐站实测确认，
    //    不是"懒得找"，是真的没有（详见 tools/probe/probe-adoptium-mirror.mjs
    //    与 probe-ustc-adoptium.mjs）：
    //
    //    | 镜像站 | 结果 |
    //    |---|---|
    //    | 清华 TUNA | 整站 403（`/ubuntu/` 也是 403，与 Adoptium 无关） |
    //    | NJU / BFSU / SJTU / ZJU / PKU / 阿里云 | 404，无此镜像 |
    //    | 中科大 USTC | 有目录，但文件下载被 JS 反爬拦死（返回 859B 验证页） |
    //    | CERNET 联合镜像 | 302 跳回 TUNA（同样 403） |
    //    | BMCLAPI `/v1/products/java-runtime/` | 302 跳到 Cloudflare 后端，**不是国内源** |
    //
    //    所以这里只能用官方源（候选列表就是它自己，重试由引擎负责）。
    //    `ARCHITECTURE.md` 曾写「有国内镜像可换」，那句是错的，已更正。
    download_one(&task, Source::Mojang, &Default::default()).await?;

    // ---------- 校验 SHA256 ----------
    let actual = sha256_of_file(&archive).await?;
    if !actual.eq_ignore_ascii_case(&info.checksum) {
        let _ = tokio::fs::remove_file(&archive).await;
        return Err(NetError::HashMismatch {
            expected: info.checksum.clone(),
            actual,
        });
    }

    on_progress(info.size, info.size);

    // ---------- 解压 ----------
    // zip 解压放到阻塞线程（有 IO 也有 CPU）
    let archive_c = archive.clone();
    let target_c = target_dir.clone();
    tokio::task::spawn_blocking(move || extract_java_archive(&archive_c, &target_c))
        .await
        .map_err(|e| NetError::Other(format!("解压任务失败：{e}")))??;

    let _ = tokio::fs::remove_file(&archive).await;

    // ---------- 验证真的能跑 ----------
    let bin = find_java_binary(&target_dir).ok_or_else(|| {
        NetError::Other(format!(
            "解压后找不到 java 可执行文件 —— 目录结构可能是新的，请检查 {}",
            target_dir.display()
        ))
    })?;
    let ver = probe_java(&bin).ok_or_else(|| {
        NetError::Other(format!(
            "下载的 Java 无法运行：{} —— 文件可能损坏，请删除后重试",
            bin.display()
        ))
    })?;

    if ver != major {
        // 不致命，但要告知（例如请求 17 拿到 17.x）
        say!("请求 Java {major}，实际得到 Java {ver}");
    }

    Ok(bin)
}

/// 在目录里找 java 可执行文件（兼容 zip 顶层多一层目录的布局）
pub fn find_java_binary(root: &Path) -> Option<PathBuf> {
    let exe = if cfg!(windows) { "java.exe" } else { "java" };

    // ① 直接布局：<root>/bin/java
    let direct = root.join("bin").join(exe);
    if direct.is_file() {
        return Some(direct);
    }
    // ② 多一层：<root>/jdk-17.0.10+7/bin/java
    if let Ok(entries) = std::fs::read_dir(root) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                let cand = p.join("bin").join(exe);
                if cand.is_file() {
                    return Some(cand);
                }
                // macOS 布局：Contents/Home/bin/java
                let mac = p.join("Contents").join("Home").join("bin").join(exe);
                if mac.is_file() {
                    return Some(mac);
                }
            }
        }
    }
    // ③ macOS 直接布局
    let mac = root.join("Contents").join("Home").join("bin").join(exe);
    if mac.is_file() {
        return Some(mac);
    }
    None
}

/// 执行 `java -version` 拿到主版本号
pub fn probe_java(java: &Path) -> Option<u32> {
    let mut cmd = std::process::Command::new(java);
    cmd.arg("-version");
    // ★ 不弹黑框（唯一入口，见 platform::hide_console）
    crate::platform::hide_console(&mut cmd);
    let out = cmd.output().ok()?;
    let text = String::from_utf8_lossy(&out.stderr).to_string()
        + &String::from_utf8_lossy(&out.stdout);
    let re = regex::Regex::new(r#"version "(?:1\.)?(\d+)"#).ok()?;
    re.captures(&text)?.get(1)?.as_str().parse().ok()
}

/// 解压 Java 压缩包（zip 或 tar.gz）
///
/// ## ★ tar.gz 分支为什么**故意失败关闭**（fail closed）
///
///   这里原来是 `tar -xzf <archive> -C <target>` —— 一条**完全没有 containment**
///   的解压路径（全仓库唯一一条）：条目名由压缩包作者定，`../..` 能直接写到
///   目标目录之外，而 natives/Java 解出来的东西**会被执行**。
///
///   为什么不"解完再检查"：事后检查挡不住"已经写到目标之外"的那一瞬间 ——
///   那不是加固，只是事后发现。
///
///   为什么不是"加上 `tar` + `flate2` 依赖自己遍历条目"：
///     `src-tauri/Cargo.toml` 里现在**没有**这两个依赖（`tar` 只是别的 crate 的
///     传递依赖，`flate2` 只有 `zip` 内部的 deflate 后端）。加依赖本身不是问题，
///     问题是这样一来 tar 解析器的正确性就成了**新的安全边界**（USTAR / GNU long
///     name / PAX 三种扩展头都要处理对），而这条分支在**已发布的平台上根本走不到**
///     （`cfg!(windows)` 才用 zip，见上面 `install_java` 的 `ext` 选择）。
///     ⇒ 与其塞一个"在没人测过的平台上、没有测试守护的"新解析器，
///       不如**如实拒绝**：这一条路宁可不做，也不留一个没有 containment 的解压路径。
///
///   ★ 影响面（明说，不藏）：Linux / macOS 的 **Java 运行时自动下载**会停在这条
///     错误上，用户需要手动指定 JDK 路径。那两个平台**本来就未发布、未实测**
///     （`tools/` 的构建与发布链只出 Windows exe），所以这是"诚实的降级"，
///     不是功能倒退 —— 而在 Windows 上行为完全不变。
///
///   ★ 以后要恢复它，做法是（按顺序）：
///     ① `Cargo.toml` 加 `tar = "0.4"` + `flate2 = "1"`；
///     ② 用 `flate2::read::GzDecoder` 解出 `tar::Archive`，**逐条** `entries()`；
///     ③ 每条先 `entry.path()` 过 `domain::archive_guard::classify_archive_path`，
///        任何一条越界 ⇒ **整包拒绝、一个字节都不写**（与 `try_extract_natives` 同形）；
///     ④ 落盘前再判一次"解析出的路径拼上 target 之后仍在 target 之内"；
///     ⑤ 补一条真 tar.gz 的端到端越界测试（当前这条分支连测试夹具都没有）。
fn extract_java_archive(archive: &Path, target: &Path) -> Result<()> {
    let name = archive.to_string_lossy().to_lowercase();
    if name.ends_with(".zip") {
        extract_zip(archive, target)
    } else if name.ends_with(".tar.gz") || name.ends_with(".tgz") {
        Err(NetError::Other(format!(
            "这个平台的 Java 运行时压缩包是 tar.gz，而自动解压**还没有加固**（没有做 zip-slip 防护），\
             我们宁可不做也不留一个不安全的解压路径。\n\
             请在设置里手动指定一个已有的 JDK/JRE（Java 路径），或自行解压到 {}。\n\
             压缩包：{}",
            target.display(),
            archive.display()
        )))
    } else {
        Err(NetError::Other(format!(
            "不认识的压缩格式：{}",
            archive.display()
        )))
    }
}

/// 用 zip crate 解压（**两道闸门**：`enclosed_name()` + 共用判据 `classify_archive_path`）
///
/// ## 为什么必须两道
///
///   `enclosed_name()` 拒 `..` / 绝对路径 / 盘符前缀 / NUL，**但放 Windows ADS 过去**
///   （`a.txt:zone` 的父目录没逃出压缩包根 ⇒ 它认为"在包里面"）。
///   共用的 `classify_archive_path` 恰好拒"任何含 `:` 的段"（还有保留设备名、
///   反斜杠变体、`.` 段）⇒ 两道一起用才完整，而这正是 `extract_overrides_dir`
///   那条路一直更严的原因（P0-2 的结论）。
///
/// ## 为什么"先全判、再落盘"
///
///   第一趟只读中央目录、把每个条目名过闸门：任何一条越界 ⇒ **整包拒绝**，
///   一个字节都不写。第二趟才真解压。理由与 `try_extract_natives` 相同：
///   包的可信度是整包级别的，而 Java 解出来的是要**执行**的东西。
fn extract_zip(archive: &Path, target: &Path) -> Result<()> {
    let file = std::fs::File::open(archive)
        .map_err(|e| NetError::Other(format!("打开压缩包失败：{e}")))?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|e| NetError::Other(format!("这个文件不是有效的 zip：{e}")))?;

    // ---------- 第一趟：只判不写 ----------
    let mut names: Vec<String> = Vec::with_capacity(zip.len());
    for i in 0..zip.len() {
        let entry = zip
            .by_index(i)
            .map_err(|e| NetError::Other(format!("读取条目失败：{e}")))?;
        names.push(entry.name().replace('\\', "/"));
    }
    let mut escaped: Vec<String> = Vec::new();
    for name in &names {
        if let Err(why) = crate::domain::archive_guard::classify_archive_path(name) {
            escaped.push(format!("{name}（{}）", why.why()));
        }
    }
    if !escaped.is_empty() {
        say!(
            "[IEML/adoptium] ★ Java 压缩包里有越界条目，**整包拒绝**（一个字节都没写）：{} —— {}",
            archive.display(),
            escaped.join("；")
        );
        return Err(NetError::Other(format!(
            "Java 压缩包里有试图解压到目标目录之外的条目（已整包拒绝，不会写出任何文件）：{}",
            escaped.join("；")
        )));
    }

    std::fs::create_dir_all(target)
        .map_err(|e| NetError::Other(format!("创建目录失败：{e}")))?;

    // ---------- 第二趟：落盘 ----------
    for i in 0..zip.len() {
        let mut entry = zip
            .by_index(i)
            .map_err(|e| NetError::Other(format!("读取条目失败：{e}")))?;
        let name = names[i].clone();
        // 第二道闸门：保留 `enclosed_name()`（判据只有一份，但这条是 zip 语义的兜底）
        let Some(rel) = entry.enclosed_name() else {
            say!("[IEML/adoptium] 跳过压缩包里的一条越界条目：{name}");
            continue;
        };
        // 共用判据：ADS / 保留设备名 / 反斜杠变体
        let safe = match crate::domain::archive_guard::classify_archive_path(&name) {
            Ok(p) => p,
            Err(why) => {
                say!(
                    "[IEML/adoptium] 跳过压缩包里的一条不安全条目：{name}（{}）",
                    why.why()
                );
                continue;
            }
        };
        // 用判据给出的相对路径落盘（`rel` 只用来做一次交叉核对）
        debug_assert_eq!(
            rel.to_string_lossy().replace('\\', "/"),
            safe.to_string_lossy().replace('\\', "/")
        );
        let out = target.join(&safe);

        if entry.is_dir() {
            std::fs::create_dir_all(&out).ok();
            continue;
        }
        // 符号链接条目跳过（`zip` 的 `is_symlink()`；符号链接是逃出目标的一条捷径）
        if entry.is_symlink() {
            say!("[IEML/adoptium] 跳过压缩包里的符号链接条目：{name}");
            continue;
        }
        if let Some(p) = out.parent() {
            std::fs::create_dir_all(p).ok();
        }
        let mut f = std::fs::File::create(&out)
            .map_err(|e| NetError::Other(format!("写入 {} 失败：{e}", out.display())))?;
        std::io::copy(&mut entry, &mut f)
            .map_err(|e| NetError::Other(format!("解压 {} 失败：{e}", out.display())))?;

        // 保留可执行权限（Unix）
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Some(mode) = entry.unix_mode() {
                let _ = std::fs::set_permissions(&out, std::fs::Permissions::from_mode(mode));
            }
        }
    }
    Ok(())
}

/// 列出 IEML 下载过的所有 Java（供设置页展示与删除）
#[derive(Debug, Clone, Serialize)]
pub struct InstalledJava {
    pub major: u32,
    pub path: PathBuf,
    pub bytes: u64,
    pub usable: bool,
}

pub fn list_downloaded_java(java_root: &Path) -> Vec<InstalledJava> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(java_root) else {
        return out;
    };
    for e in entries.flatten() {
        let dir = e.path();
        if !dir.is_dir() {
            continue;
        }
        let Some(major) = dir
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| n.parse::<u32>().ok())
        else {
            continue;
        };
        let Some(bin) = find_java_binary(&dir) else {
            continue;
        };
        out.push(InstalledJava {
            major,
            usable: probe_java(&bin).is_some(),
            path: bin,
            bytes: dir_size(&dir),
        });
    }
    out.sort_by_key(|j| j.major);
    out
}

fn dir_size(dir: &Path) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else {
            continue;
        };
        for e in entries.flatten() {
            let Ok(meta) = e.metadata() else { continue };
            if meta.is_dir() {
                stack.push(e.path());
            } else {
                total += meta.len();
            }
        }
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_params_are_sane() {
        let (os, arch, image) = platform_params();
        assert!(["windows", "mac", "linux"].contains(&os));
        assert!(["x64", "aarch64", "x86"].contains(&arch));
        assert_eq!(image, "jre");
    }

    #[test]
    fn find_java_binary_handles_direct_layout() {
        let root = std::env::temp_dir().join("ieml-java-test-direct");
        let bin = root.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let exe = bin.join(if cfg!(windows) { "java.exe" } else { "java" });
        std::fs::write(&exe, b"fake").unwrap();
        assert_eq!(find_java_binary(&root), Some(exe));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn find_java_binary_handles_nested_layout() {
        // Adoptium 的 zip 会多一层目录：jdk-17.0.10+7/bin/java
        let root = std::env::temp_dir().join("ieml-java-test-nested");
        let bin = root.join("jdk-17.0.10+7").join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let exe = bin.join(if cfg!(windows) { "java.exe" } else { "java" });
        std::fs::write(&exe, b"fake").unwrap();
        assert_eq!(find_java_binary(&root), Some(exe));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn find_java_binary_returns_none_when_empty() {
        let root = std::env::temp_dir().join("ieml-java-test-empty");
        std::fs::create_dir_all(&root).unwrap();
        assert_eq!(find_java_binary(&root), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn probe_real_system_java_if_available() {
        // 本机有 Java 25 时应当能探到；没有就跳过
        let candidates = [
            r"C:\Program Files\Eclipse Adoptium\jdk-25.0.3.9-hotspot\bin\java.exe",
        ];
        for c in candidates {
            let p = Path::new(c);
            if p.is_file() {
                let v = probe_java(p);
                assert!(v.is_some(), "探测 {c} 失败");
                assert!(v.unwrap() >= 8);
                return;
            }
        }
    }

    /* ================= ★★ 解压落盘闸门（P0 安全，清单第 204 行） ================= */

    /// 造一个真 zip（条目名逐字写进去，**包括那些恶意名字**）
    fn make_zip(path: &Path, entries: &[(&str, &[u8])]) {
        let f = std::fs::File::create(path).expect("建 zip");
        let mut w = zip::ZipWriter::new(f);
        let opts = zip::write::SimpleFileOptions::default();
        for (name, body) in entries {
            w.start_file(*name, opts).expect("写 zip 条目");
            use std::io::Write as _;
            w.write_all(body).expect("写 zip 内容");
        }
        w.finish().expect("收尾 zip");
    }

    fn temp_root(tag: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!("ieml-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).expect("建临时根");
        base
    }

    fn list_files(dir: &Path) -> Vec<String> {
        fn walk(dir: &Path, prefix: &str, out: &mut Vec<String>) {
            let Ok(entries) = std::fs::read_dir(dir) else {
                return;
            };
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                let rel = if prefix.is_empty() {
                    name.clone()
                } else {
                    format!("{prefix}/{name}")
                };
                if e.path().is_dir() {
                    walk(&e.path(), &rel, out);
                } else {
                    out.push(rel);
                }
            }
        }
        let mut out = Vec::new();
        walk(dir, "", &mut out);
        out.sort();
        out
    }

    /// ★★ 端到端③（Java zip）：含 `../escape.txt` / `C:evil.txt` / `a.txt:zone`
    ///   的**真 zip** 喂给 `extract_java_archive` ——
    ///     ① 目标目录**外**不许生成任何文件；
    ///     ② 越界条目必须被点名；
    ///     ③ 整包拒绝（一个字节都不写）。
    ///
    ///   ★ 这一条钉的正是"两道闸门一起用"：`enclosed_name()` 放得过的
    ///     `a.txt:zone`，必须由共用的 `classify_archive_path` 拒掉。
    #[test]
    fn java_zip_slip_is_rejected_and_nothing_is_written_outside() {
        let base = temp_root("java-zip-escape");
        let archive = base.join("java-17.zip");
        make_zip(
            &archive,
            &[
                ("../escape.txt", b"ESCAPED"),
                ("C:evil.txt", b"ESCAPED"),
                ("a.txt:zone", b"ESCAPED"),
            ],
        );
        let target = base.join("jdk");
        std::fs::create_dir_all(&target).unwrap();

        let err = extract_java_archive(&archive, &target)
            .expect_err("含越界条目的 Java zip 必须被整包拒绝");
        let msg = err.to_string();
        for must in ["../escape.txt", "C:evil.txt", "a.txt:zone"] {
            assert!(msg.contains(must), "拒绝理由必须点名「{must}」，实际：{msg}");
        }
        assert!(
            !base.join("escape.txt").exists(),
            "★ 目标目录外被写了 escape.txt —— 这就是 Zip Slip"
        );
        assert!(!base.join("evil.txt").exists(), "★ 目标目录外被写了 evil.txt");
        assert!(
            list_files(&target).is_empty(),
            "整包拒绝 = 一个字节都不写，实际：{:?}",
            list_files(&target)
        );
        assert_eq!(list_files(&base), vec!["java-17.zip".to_string()]);
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 反向：**正常的 Java zip 照旧解压**（不许把功能改死），
    /// 而且多一层目录的布局（`jdk-17.0.10+7/bin/java.exe`）要能落地。
    #[test]
    fn java_zip_normal_entries_still_land() {
        let base = temp_root("java-zip-ok");
        let archive = base.join("java-17.zip");
        make_zip(
            &archive,
            &[
                ("jdk-17.0.10+7/bin/java.exe", b"MZ-FAKE"),
                ("jdk-17.0.10+7/release", b"JAVA_VERSION=17"),
            ],
        );
        let target = base.join("jdk");
        extract_java_archive(&archive, &target).expect("正常 Java zip 必须解压成功");
        assert_eq!(
            std::fs::read(target.join("jdk-17.0.10+7").join("bin").join("java.exe")).unwrap(),
            b"MZ-FAKE"
        );
        assert!(target.join("jdk-17.0.10+7").join("release").is_file());
        let _ = std::fs::remove_dir_all(&base);
    }

    /// ★★ tar.gz 分支**故意失败关闭**：
    ///   不再执行外部 `tar -xzf`（那是一条没有 containment 的解压路径），
    ///   而是**如实报错**并且**一个字节都不解**。
    ///
    ///   ★ 本平台（Windows）走不到这条分支（`cfg!(windows)` 用 zip），
    ///     所以这条测试是它在 CI（Windows 全量）上**唯一**的守护：
    ///     它证明的是"这条路宁可不做，也不留一个不安全实现"。
    #[test]
    fn java_targz_fails_closed_instead_of_unsafe_extract() {
        let base = temp_root("java-targz");
        let archive = base.join("java-17.tar.gz");
        // gzip 魔数 + 一段垃圾：即便有人把实现改回"解码 + 解 tar"，也会在头一步停下
        let mut bytes = vec![0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0x00, 0xff];
        bytes.extend_from_slice(b"NOT-A-REAL-TARGZ");
        std::fs::write(&archive, &bytes).unwrap();
        let target = base.join("jdk");
        std::fs::create_dir_all(&target).unwrap();

        let err = extract_java_archive(&archive, &target).expect_err("tar.gz 必须失败关闭");
        let msg = err.to_string();
        assert!(
            msg.contains("tar.gz") && msg.contains("加固"),
            "错误必须说清「这条路没加固」，实际：{msg}"
        );
        assert!(
            msg.contains("手动"),
            "错误必须给用户一条出路（手动指定 Java），实际：{msg}"
        );
        assert!(
            list_files(&target).is_empty(),
            "失败关闭 = 什么都不能解出来：{:?}",
            list_files(&target)
        );
        let _ = std::fs::remove_dir_all(&base);
    }
}
