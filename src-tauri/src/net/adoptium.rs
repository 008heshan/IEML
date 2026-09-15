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

    let task = DownloadTask::new(
        archive.clone(),
        info.download_url.clone(),
        // Adoptium 给 SHA256，我们的引擎算的是 SHA1 → 这里不交给引擎校验，
        // 下载后单独验 SHA256（见下）
        String::new(),
        info.size,
        format!("Java {} 运行时", info.version),
    );
    // Adoptium 没有镜像，只能用官方源（候选列表就是它自己，重试由引擎负责）
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
        eprintln!("请求 Java {major}，实际得到 Java {ver}");
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
fn extract_java_archive(archive: &Path, target: &Path) -> Result<()> {
    let name = archive.to_string_lossy().to_lowercase();
    if name.ends_with(".zip") {
        extract_zip(archive, target)
    } else if name.ends_with(".tar.gz") || name.ends_with(".tgz") {
        // 不引入 tar 依赖：调用系统 tar（Windows 10+ 自带 bsdtar）
        // ★ 同样要抑制控制台窗口（否则解压 Java 时会闪一个黑框）
        let mut tar = std::process::Command::new("tar");
        tar.arg("-xzf").arg(archive).arg("-C").arg(target);
        crate::platform::hide_console(&mut tar);
        let status = tar
            .status()
            .map_err(|e| NetError::Other(format!("调用 tar 失败：{e}（系统可能没有 tar）")))?;
        if !status.success() {
            return Err(NetError::Other(format!("解压失败，tar 退出码 {status}")));
        }
        Ok(())
    } else {
        Err(NetError::Other(format!(
            "不认识的压缩格式：{}",
            archive.display()
        )))
    }
}

/// 用 zip crate 解压（带 zip-slip 防护）
fn extract_zip(archive: &Path, target: &Path) -> Result<()> {
    let file = std::fs::File::open(archive)
        .map_err(|e| NetError::Other(format!("打开压缩包失败：{e}")))?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|e| NetError::Other(format!("这个文件不是有效的 zip：{e}")))?;

    std::fs::create_dir_all(target)
        .map_err(|e| NetError::Other(format!("创建目录失败：{e}")))?;

    for i in 0..zip.len() {
        let mut entry = zip
            .by_index(i)
            .map_err(|e| NetError::Other(format!("读取条目失败：{e}")))?;
        // ★ zip-slip 防护：enclosed_name 会拒绝 ../ 跳出目标目录的路径
        let Some(rel) = entry.enclosed_name() else {
            continue;
        };
        let out = target.join(rel);

        if entry.is_dir() {
            std::fs::create_dir_all(&out).ok();
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
}
