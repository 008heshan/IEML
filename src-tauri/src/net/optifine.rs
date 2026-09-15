//! OptiFine 自动安装（照 PCL 的实现逐条搬过来）
//!
//! ## 为什么现在才做
//!
//!   `loader_caps::addon_install_implemented` 一直返回 `true`，注释还写着
//!   "`install_version` 里有 Patcher 分支" —— **那句话从来就不成立**，
//!   全仓库没有任何 OptiFine 安装代码。界面于是把开关画成"能装"，
//!   用户勾上、点安装、看到成功，磁盘上什么都没多。
//!
//!   上一轮我把这个标志改成了 `false`（诚实：先说做不到），
//!   这一轮把它**真的做出来**。
//!
//! ## 算法来源（不是我猜的）
//!
//!   `E:\PCL-main\Plain Craft Launcher 2\Pages\PageDownload\ModDownloadLib.vb`
//!   的 `McDownloadOptiFineLoader`（473-631 行）与
//!   `McDownloadOptiFineInstall`（350-467 行）。关键事实逐条对应：
//!
//!   | PCL 的行 | 事实 | 我们怎么用 |
//!   |---|---|---|
//!   | 486-510 | 下载地址：`/optifine/<mc>/HD_U/<patch>`（预览版是 `HD_U_<patch>`），同时走 BMCLAPI 与官方 | `download_url()` |
//!   | 354-365 | **读 `optifine/Installer.class` 的字节码头**算需要的 Java：`major = classVersion - 44` | `required_java_major()` |
//!   | 479 | `Inherit >= 1.14` 走**方式 A**（跑 Patcher），更老走**方式 B**（拼 JSON） | `is_new_style()` |
//!   | 543-578 | 方式 A：造一个临时 `.minecraft`（里面放原版 json+jar）→ 跑 Patcher → **整个目录拷回** | `install()` |
//!   | 377-379 | 运行方式：`-Duser.home="<临时>" -cp "<安装器>" optifine.Installer` | 同左 |
//!   | 588-623 | 方式 B：复制原版 jar + **手写一个 inheritsFrom 的 JSON** | `install_legacy()` |
//!
//! ## 方式 A 为什么要造一个假 `.minecraft`
//!
//!   OptiFine 的 Patcher 是**为官方启动器写的**：它硬编码去
//!   `<user.home>/.minecraft/versions/<mc>/` 找原版 json 与 jar，
//!   并且要求同级有 `launcher_profiles.json`。PCL 的做法就是顺着它：
//!   造一个临时目录、把它要的东西摆好、跑完再整体拷回来。
//!   硬碰硬去改它的行为是不可能的（那是闭源 jar）。

use crate::net::download;
use crate::net::metadata::{OptifineVersion};
use crate::net::mirror;
use std::path::{Path, PathBuf};

/// OptiFine 安装结果
#[derive(Debug, Clone, serde::Serialize)]
pub struct OptiFineInstall {
    /// 装出来的版本 id（`1.20.1-OptiFine_HD_U_I6`）
    pub version_id: String,
    /// 版本目录（`versions/<id>/`）
    pub version_dir: PathBuf,
    /// 版本 JSON 路径
    pub json_path: PathBuf,
    /// 客户端 jar 路径（方式 B 会自己造一个）
    pub client_jar: PathBuf,
    /// 用的是哪种方式（给日志与界面看）
    pub method: &'static str,
    /// 安装器要求的 Java 主版本（读 class 头算出来的）
    pub required_java: u32,
    /// 人话总结
    pub summary: String,
}

/// OptiFine 安装器在 BMCLAPI 上的下载地址。
///
/// 来源：PCL `ModDownloadLib.vb` 490-496。
///
/// 注意预览版的路径形状不一样：
///   · 正式版 `HD U I6` → `/optifine/1.20.1/HD_U/I6`
///   · 预览版 `HD U I6 pre4` → `/optifine/1.20.1/HD_U_I6/pre4`
///
/// ★ 1.8 / 1.9 要写成 `1.8.0` / `1.9.0`（PCL 第 491 行，来自 issue #4281）——
///   那两个版本的目录名与 MC 版本号不一致。
pub fn download_url(mc_version: &str, v: &OptifineVersion) -> String {
    let inherit = if mc_version == "1.8" || mc_version == "1.9" {
        format!("{mc_version}.0")
    } else {
        mc_version.to_string()
    };
    // `version` 形如 `HD U I6` / `HD U I6 pre4`（见 metadata::optifine_version_of）
    let patch = v
        .version
        .trim()
        .strip_prefix("HD U ")
        .unwrap_or(v.version.trim())
        .replace(' ', "/");
    if v.preview {
        // 预览版：`HD_U_` 与 patch 拼在一起，中间用 `/`
        format!("{}/optifine/{inherit}/HD_U_{patch}", mirror::BMCLAPI_BASE)
    } else {
        format!("{}/optifine/{inherit}/HD_U/{patch}", mirror::BMCLAPI_BASE)
    }
}

/// 安装器要求的 Java 主版本 —— **读 `optifine/Installer.class` 的字节码头算出来**。
///
/// 来源：PCL `ModDownloadLib.vb` 354-365。
///
///   class 文件头 8 字节：`CA FE BA BE <minor:2> <major:2>`，
///   `major = classVersion`，而 **Java 主版本 = classVersion - 44**
///   （Java 8 = 52、Java 17 = 61、Java 21 = 65）。
///
/// 为什么要算这个而不是写死：OptiFine 的安装器在不同年代用不同 Java 编译，
/// 拿一个太老的 Java 跑它会直接 `UnsupportedClassVersionError`。
/// 这个判据取的是**盘上的事实**，比任何版本表都准。
pub fn required_java_major(installer: &Path) -> std::io::Result<u32> {
    let file = std::fs::File::open(installer)?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let mut entry = zip
        .by_name("optifine/Installer.class")
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::NotFound, "安装器里没有 optifine/Installer.class"))?;
    let mut header = [0u8; 8];
    use std::io::Read;
    entry.read_exact(&mut header)?;

    if header[0] != 0xCA || header[1] != 0xFE || header[2] != 0xBA || header[3] != 0xBE {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Installer.class 的文件头不对（不是有效的 class 文件）",
        ));
    }
    let class_version = u16::from_be_bytes([header[6], header[7]]) as u32;
    if !(45..=100).contains(&class_version) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("Installer.class 的版本号 {class_version} 不在合理范围内"),
        ));
    }
    Ok(class_version.saturating_sub(44).max(8))
}

/// 新旧方式的分界：`inherits >= 1.14` 走方式 A（跑 Patcher）。
/// 来源：PCL `ModDownloadLib.vb` 第 479 行。
pub fn is_new_style(mc_version: &str) -> bool {
    let segs: Vec<u32> = mc_version
        .split('.')
        .filter_map(|s| s.trim().parse().ok())
        .collect();
    match (segs.first(), segs.get(1)) {
        (Some(1), Some(minor)) => *minor >= 14,
        // 26.x 这种新世代的版本号（主版本 >= 2）当然也算新版
        (Some(major), _) => *major >= 2,
        _ => true,
    }
}

/// 装出来的版本 id。
///
/// ★★ 形状是 **`<mc>-OptiFine_<补丁>`**，不是 `<mc>-<文件名>`。
///
///   我第一版按"文件名去掉 .jar"拼（`1.16.5-OptiFine_1.16.5_HD_U_G8`），
///   而 OptiFine 的 Patcher 实际产出的是 **`1.16.5-OptiFine_HD_U_G8`**
///   —— 它在 id 里**去掉了重复的 MC 版本号**。
///   实测（1.16.5 + HD U G8）：盘上出现的是
///     `versions/1.16.5-OptiFine_HD_U_G8/`
///   于是"按预期路径找文件"必然找不到（文件其实好好地在那儿）。
///
///   PCL 的对照（`ModDownloadLib.vb` 477 行 `InstanceName`）与
///   我们自己的识别器（`loader_trace`，它认 `1.20.1-OptiFine_HD_U_I6` 这种形状）
///   都指向同一个结论。所以规则是：**从补丁号拼**，别从文件名拼。
pub fn installed_version_id(mc_version: &str, v: &OptifineVersion) -> String {
    // `HD U I6` → `HD_U_I6`；预览版 `HD U I6 pre4` → `HD_U_I6_pre4`
    let patch = v.version.trim().replace(' ', "_");
    format!("{mc_version}-OptiFine_{patch}")
}

/// 安装完成后，**从磁盘上找出真正产出的那个版本**。
///
/// 为什么不直接用 `installed_version_id` 拼出来：
///   上面那个函数是"我们对命名规则的理解"，而磁盘是"实际发生了什么"。
///   两者一旦不一致（第一版就撞上了），用理解去拼路径就会误报"装完了但没产物"。
///   所以**以盘上的目录为准**，找不到才回退到拼出来的那个。
pub fn locate_produced_version(
    shared: &Path,
    mc_version: &str,
    expected_id: &str,
) -> Option<String> {
    let versions = shared.join("versions");
    // ① 首选期望的 id
    if versions.join(expected_id).join(format!("{expected_id}.json")).is_file() {
        return Some(expected_id.to_string());
    }
    // ② 退一步：找 `<mc>-OptiFine*` 里最新的一个（用户可能装过多个补丁版本）
    let mut found: Vec<String> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&versions) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.starts_with(&format!("{mc_version}-OptiFine")) {
                continue;
            }
            if e.path().join(format!("{name}.json")).is_file() {
                found.push(name);
            }
        }
    }
    found.sort();
    found.pop()
}

/// 把安装器下载到缓存目录（带校验、可重入）。
pub async fn download_installer(
    cache_dir: &Path,
    mc_version: &str,
    v: &OptifineVersion,
    src: mirror::Source,
) -> Result<PathBuf, String> {
    std::fs::create_dir_all(cache_dir).map_err(|e| format!("创建缓存目录失败：{e}"))?;
    let dest = cache_dir.join(&v.filename);
    // 已经下过且体积合理就复用（OptiFine 安装器一般 2~8 MB）
    if dest.is_file() {
        if let Ok(m) = std::fs::metadata(&dest) {
            if m.len() > 300 * 1024 {
                return Ok(dest);
            }
        }
    }
    let url = download_url(mc_version, v);
    let task = download::DownloadTask::new(
        dest.clone(),
        url,
        String::new(), // OptiFine 不给官方 sha1，靠体积下限 + zip 结构校验
        0,
        format!("OptiFine 安装器 {}", v.version),
    );
    let cancel = download::CancelToken::new();
    download::download_one(&task, src, &cancel)
        .await
        .map_err(|e| format!("下载 OptiFine 安装器失败：{e}"))?;
    let len = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
    if len < 300 * 1024 {
        let _ = std::fs::remove_file(&dest);
        return Err(format!(
            "下载到的 OptiFine 安装器只有 {len} 字节，明显不对（镜像可能返回了错误页面）"
        ));
    }
    Ok(dest)
}

/// 一次完整的 OptiFine 安装。
///
/// * `shared` —— 我们的共享游戏目录（`versions/` 与 `libraries/` 都在这）
/// * `java_for_installer` —— 用来跑安装器的 java（调用方按 `required_java_major` 选）
/// * `on_progress` —— 进度回调（给前端任务中心）
pub async fn install(
    shared: &Path,
    mc_version: &str,
    v: &OptifineVersion,
    installer_jar: &Path,
    java_for_installer: &Path,
    on_progress: &(dyn Fn(String) + Send + Sync),
) -> Result<OptiFineInstall, String> {
    let required_java = required_java_major(installer_jar)
        .map_err(|e| format!("读不出 OptiFine 安装器需要的 Java 版本：{e}"))?;
    let expected_id = installed_version_id(mc_version, v);

    if is_new_style(mc_version) {
        on_progress("运行 OptiFine 安装器（会在原版 jar 上打补丁，需要一两分钟）".into());
        install_new_style(
            shared,
            mc_version,
            &expected_id,
            installer_jar,
            java_for_installer,
        )
        .await?;
        /*
         * ★★ **以盘上的目录为准**，不要拿我们拼出来的 id 去找文件。
         *   实测：OptiFine 产出的 id 与我们拼的差一截
         *   （它是 `1.16.5-OptiFine_HD_U_G8`），拿拼出来的路径找必然扑空，
         *   于是会误报"装完了但没产物"—— 而产物好好的在那儿。
         */
        let version_id = locate_produced_version(shared, mc_version, &expected_id)
            .ok_or_else(|| {
                format!(
                    "OptiFine 安装器跑完了，但 versions/ 下没有出现 {mc_version}-OptiFine* 的版本描述。\n\
                     请去「版本列表」看看盘上实际多了什么。"
                )
            })?;
        let version_dir = shared.join("versions").join(&version_id);
        let json_path = version_dir.join(format!("{version_id}.json"));
        return Ok(OptiFineInstall {
            version_id: version_id.clone(),
            version_dir: version_dir.clone(),
            json_path,
            client_jar: version_dir.join(format!("{version_id}.jar")),
            method: "A（跑官方 Patcher）",
            required_java,
            summary: format!(
                "OptiFine {} 已装到 {}（方式 A：Patcher 打过补丁，版本 id {}）",
                v.version, mc_version, version_id
            ),
        });
    }

    on_progress("生成 OptiFine 版本描述（老版本走方式 B，不跑 Patcher）".into());
    let version_id = expected_id;
    let version_dir = shared.join("versions").join(&version_id);
    let json_path = version_dir.join(format!("{version_id}.json"));
    install_legacy_style(shared, mc_version, &version_id, v, &version_dir, &json_path)?;
    Ok(OptiFineInstall {
        version_id: version_id.clone(),
        version_dir: version_dir.clone(),
        json_path,
        client_jar: version_dir.join(format!("{version_id}.jar")),
        method: "B（拼版本描述）",
        required_java,
        summary: format!("OptiFine {} 已装到 {}（方式 B：直接挂 tweaker）", v.version, mc_version),
    })
}

/// 方式 A：造临时 `.minecraft` → 跑 Patcher → 整体拷回。
/// 对应 PCL `ModDownloadLib.vb` 541-582。
#[allow(clippy::too_many_arguments)]
async fn install_new_style(
    shared: &Path,
    mc_version: &str,
    expected_id: &str,
    installer_jar: &Path,
    java: &Path,
) -> Result<(), String> {
    // ① 原版必须先装好（Patcher 要读原版 json + jar）
    let vanilla_json = shared
        .join("versions")
        .join(mc_version)
        .join(format!("{mc_version}.json"));
    let vanilla_jar = shared
        .join("versions")
        .join(mc_version)
        .join(format!("{mc_version}.jar"));
    if !vanilla_json.is_file() || !vanilla_jar.is_file() {
        return Err(format!(
            "OptiFine 是在**原版**基础上打补丁的，所以原版 {mc_version} 必须先装好。\n\
             现在缺：{}{}\n\n\
             请先在「下载」页安装一次原版 {mc_version}，再回来装 OptiFine\
             （已下载的文件会跳过，很快）。",
            if vanilla_json.is_file() { "" } else { "\n  · 原版版本描述（json）" },
            if vanilla_jar.is_file() { "" } else { "\n  · 原版客户端 jar" },
        ));
    }

    // ② 造临时 .minecraft（Patcher 硬编码认这个布局）
    //
    //    ★★ **两个路径都要指过去**（PCL `ModDownloadLib.vb` 377-397）：
    //      · `-Duser.home=<tmp>`            —— 它用 `user.home/.minecraft` 找版本
    //      · 环境变量 `appdata=<tmp>`       —— 它也会从 `%APPDATA%\.minecraft` 找
    //
    //    实测踩过：只给 `-Duser.home` 时，1.16.5 的 G8 安装器第一句就是
    //      `Dir libraries: C:\Users\Administrator\AppData\Roaming\.minecraft\libraries`
    //    —— 它读的是**真实的 APPDATA**，于是它去用户真实的 .minecraft 里找版本，
    //    找不到（或找到别的东西）就退出，一个版本描述都不产出。
    //    这种"它去看別的地方了"的失败，从退出码上是看不出来的。
    let tmp_root = std::env::temp_dir().join(format!(
        "ieml-optifine-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    ));
    // APPDATA 要指向一个**里面装着 .minecraft** 的目录 —— 这是 Windows 的形状
    let fake_appdata = tmp_root.join("appdata");
    let fake_home = tmp_root.join("home");
    let mc_home = fake_appdata.join(".minecraft");
    let _ = std::fs::remove_dir_all(&tmp_root);
    let vdir = mc_home.join("versions").join(mc_version);
    std::fs::create_dir_all(&vdir).map_err(|e| format!("创建临时目录失败：{e}"))?;
    std::fs::create_dir_all(&fake_home).map_err(|e| format!("创建临时目录失败：{e}"))?;

    // launcher_profiles.json —— Patcher 要求它存在
    let profiles = mc_home.join("launcher_profiles.json");
    let _ = std::fs::write(
        &profiles,
        serde_json::json!({
            "profiles": { "(Default)": { "name": "(Default)", "lastVersionId": mc_version } }
        })
        .to_string(),
    );
    std::fs::copy(&vanilla_json, vdir.join(format!("{mc_version}.json")))
        .map_err(|e| format!("复制原版 json 失败：{e}"))?;
    std::fs::copy(&vanilla_jar, vdir.join(format!("{mc_version}.jar")))
        .map_err(|e| format!("复制原版 jar 失败：{e}"))?;
    // 原版库也要能找到（Patcher 会读原版 json 里的库做 classpath）
    let fake_libs = mc_home.join("libraries");
    let real_libs = shared.join("libraries");
    if real_libs.is_dir() {
        // 用硬链接/复制都行，这里直接复制目录树（只在安装时发生一次）
        let _ = copy_dir_all(&real_libs, &fake_libs);
    }

    // ③ 跑 Patcher
    //
    //    参数形状来自 PCL 第 379 行：
    //      -Duser.home="<临时目录>" -cp "<安装器.jar>" optifine.Installer
    //
    //    ★★ `--add-exports` **只在 Java 9+ 才能加**
    //       （PCL 第 381 行：`If Java.Version.Major >= 9 Then Arguments = ...`）。
    //
    //       实测踩过：1.16.5 的 OptiFine G8 安装器是用 **Java 8** 编译的
    //       （读 class 头算出来就是 8），而 Java 8 不认识 `--add-exports`：
    //         `Unrecognized option: --add-exports`
    //         `Error: Could not create the Java Virtual Machine.`
    //       安装器一行都没跑起来。这类"参数比 Java 新"的错误只有真跑才会暴露 ——
    //       代码看着完全合理。
    let java_major = crate::platform::java_major_of(java).unwrap_or(0);
    let mut cmd = tokio::process::Command::new(java);
    // ★ 不弹黑框 —— 放在**紧跟创建之后**：审计脚本按"创建点后 20 行内"判，
    //   放到最后会被判成漏掉（第一次就是这么被自己的审计抓到的）。
    crate::platform::hide_console_async(&mut cmd);
    cmd.arg(format!("-Duser.home={}", fake_home.display()));
    // 安装器在无头环境下也会尝试弹窗，显式关掉
    cmd.arg("-Djava.awt.headless=true");
    if java_major >= 9 {
        cmd.arg("--add-exports")
            .arg("cpw.mods.bootstraplauncher/cpw.mods.bootstraplauncher=ALL-UNNAMED");
    }
    cmd.arg("-cp").arg(installer_jar);
    cmd.arg("optifine.Installer");
    cmd.current_dir(&mc_home);
    /*
     * ★★ `appdata` 必须改掉 —— 这是这次安装能不能成的关键。
     *
     *   实测：只给 `-Duser.home` 时，安装器第一句输出是
     *     `Dir libraries: C:\Users\Administrator\AppData\Roaming\.minecraft\libraries`
     *   也就是说它仍然在读**用户真实的 APPDATA**，去真实的 .minecraft 里找版本。
     *   于是它什么都没装，而且退出码看上去还正常。
     *
     *   PCL 也是这么做的（`ModDownloadLib.vb` 393-397：把 `appdata` 改成临时目录）。
     *   `Command::env` 只影响这个子进程，不动我们自己的环境。
     */
    cmd.env("appdata", &fake_appdata);
    cmd.env("APPDATA", &fake_appdata);

    let out = cmd
        .output()
        .await
        .map_err(|e| format!("运行 OptiFine 安装器失败：{e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();

    // ④ 把临时目录里的东西拷回共享目录（PCL 第 573-574 行）
    let produced_versions = mc_home.join("versions");
    let mut found_json = None;
    if let Ok(rd) = std::fs::read_dir(&produced_versions) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name == mc_version {
                continue; // 原版那份，不用拷
            }
            if e.path().join(format!("{name}.json")).is_file() {
                found_json = Some(name);
                break;
            }
        }
    }

    if found_json.is_none() {
        let _ = std::fs::remove_dir_all(&tmp_root);
        let tail = |s: &str| -> String {
            s.lines()
                .rev()
                .take(12)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
                .join("\n")
        };
        return Err(format!(
            "OptiFine 安装器跑完了，但没有产出任何版本描述 —— 说明它失败了。\n\
             退出码：{}\n\
             --- 安装器输出（尾部）---\n{}\n{}",
            out.status,
            tail(&stdout),
            tail(&stderr)
        ));
    }

    // 拷 versions/<produced> → shared/versions/<produced>
    if let Ok(rd) = std::fs::read_dir(&produced_versions) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name == mc_version {
                continue;
            }
            copy_dir_all(&e.path(), &shared.join("versions").join(&name))
                .map_err(|err| format!("把 OptiFine 产物拷回共享目录失败：{err}"))?;
        }
    }
    // 拷 libraries（OptiFine 的库 + 它下载的其它东西）
    let produced_libs = mc_home.join("libraries");
    if produced_libs.is_dir() {
        copy_dir_all(&produced_libs, &real_libs)
            .map_err(|e| format!("把 OptiFine 的库拷回共享目录失败：{e}"))?;
    }

    tracing_progress(&stdout);

    if let Some(produced) = &found_json {
        if produced != expected_id {
            // 以盘上的为准（第一版按文件名拼 id，结果与 OptiFine 实际产出的不同）
            eprintln!(
                "[IEML/optifine] 安装器产出的版本 id 是 {produced}，与预期的 {expected_id} 不同 —— 以盘上的为准"
            );
        }
    }
    let _ = std::fs::remove_dir_all(&tmp_root);
    Ok(())
}

fn tracing_progress(stdout: &str) {
    // OptiFine 安装器输出很多行；把最后几行打出来，方便排查
    for l in stdout.lines().rev().take(3).collect::<Vec<_>>().iter().rev() {
        if !l.trim().is_empty() {
            eprintln!("[IEML/optifine] {l}");
        }
    }
}

/// 方式 B：老版本（< 1.14）不跑 Patcher，直接复制原版 jar 并手写版本描述。
/// 对应 PCL `ModDownloadLib.vb` 585-627。
fn install_legacy_style(
    shared: &Path,
    mc_version: &str,
    version_id: &str,
    v: &OptifineVersion,
    version_dir: &Path,
    json_path: &Path,
) -> Result<(), String> {
    let vanilla_jar = shared
        .join("versions")
        .join(mc_version)
        .join(format!("{mc_version}.jar"));
    let vanilla_json = shared
        .join("versions")
        .join(mc_version)
        .join(format!("{mc_version}.json"));
    if !vanilla_jar.is_file() || !vanilla_json.is_file() {
        return Err(format!(
            "OptiFine 要挂在原版 {mc_version} 上，请先装一次原版（缺 {}）。",
            if !vanilla_json.is_file() { "版本描述" } else { "客户端 jar" }
        ));
    }
    std::fs::create_dir_all(version_dir).map_err(|e| format!("创建版本目录失败：{e}"))?;
    std::fs::copy(&vanilla_jar, version_dir.join(format!("{version_id}.jar")))
        .map_err(|e| format!("复制原版 jar 失败：{e}"))?;

    // 版本号段：`OptiFine_1.12.2_HD_U_G5.jar` → `1.12.2_HD_U_G5`
    let of_ver = v
        .filename
        .replace("OptiFine_", "")
        .replace("preview_", "")
        .replace(".jar", "");
    let now = "2026-01-01T00:00:00+08:00";
    let json = serde_json::json!({
        "id": version_id,
        "inheritsFrom": mc_version,
        "time": now,
        "releaseTime": now,
        "type": "release",
        "libraries": [
            { "name": format!("optifine:OptiFine:{of_ver}") },
            { "name": "net.minecraft:launchwrapper:1.12" }
        ],
        "mainClass": "net.minecraft.launchwrapper.Launch",
        "minimumLauncherVersion": 18,
        "arguments": {
            "game": ["--tweakClass", "optifine.OptiFineTweaker"]
        }
    });
    std::fs::write(json_path, serde_json::to_string_pretty(&json).unwrap())
        .map_err(|e| format!("写版本描述失败：{e}"))?;
    Ok(())
}

/// 递归复制（目标已有的文件会被覆盖 —— 这里是"把安装产物搬回来"，
/// 与数据目录迁移的"只补齐"语义不同，所以单独一个函数，不复用）。
fn copy_dir_all(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for e in std::fs::read_dir(from)? {
        let e = e?;
        let src = e.path();
        let dst = to.join(e.file_name());
        if e.file_type()?.is_dir() {
            copy_dir_all(&src, &dst)?;
        } else {
            if let Some(p) = dst.parent() {
                std::fs::create_dir_all(p)?;
            }
            std::fs::copy(&src, &dst)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn of(preview: bool, version: &str, filename: &str) -> OptifineVersion {
        OptifineVersion {
            version: version.into(),
            preview,
            filename: filename.into(),
            required_forge: None,
        }
    }

    /// ★ 下载地址必须与 PCL 的拼法一致（`ModDownloadLib.vb` 490-496）。
    #[test]
    fn download_urls_match_pcl_shapes() {
        // 正式版：/optifine/<mc>/HD_U/<patch>
        assert_eq!(
            download_url("1.20.1", &of(false, "HD U I6", "OptiFine_1.20.1_HD_U_I6.jar")),
            "https://bmclapi2.bangbang93.com/optifine/1.20.1/HD_U/I6"
        );
        // 预览版：/optifine/<mc>/HD_U_<base>/<pre>
        assert_eq!(
            download_url(
                "1.20.1",
                &of(true, "HD U I6 pre4", "preview_OptiFine_1.20.1_HD_U_I6_pre4.jar")
            ),
            "https://bmclapi2.bangbang93.com/optifine/1.20.1/HD_U_I6/pre4"
        );
        // ★ 1.8 / 1.9 的目录名要补 `.0`（PCL issue #4281）
        assert_eq!(
            download_url("1.8", &of(false, "HD U H9", "OptiFine_1.8_HD_U_H9.jar")),
            "https://bmclapi2.bangbang93.com/optifine/1.8.0/HD_U/H9"
        );
        assert_eq!(
            download_url("1.9", &of(false, "HD U G5", "OptiFine_1.9_HD_U_G5.jar")),
            "https://bmclapi2.bangbang93.com/optifine/1.9.0/HD_U/G5"
        );
    }

    /// 新旧方式的分界：1.14 起跑 Patcher，更老的手写 JSON。
    /// 来源：PCL `ModDownloadLib.vb` 第 479 行。
    #[test]
    fn new_style_boundary_is_1_14() {
        assert!(!is_new_style("1.12.2"), "1.12.2 走方式 B");
        assert!(!is_new_style("1.13.2"), "1.13.2 走方式 B");
        assert!(is_new_style("1.14"), "1.14 起走方式 A");
        assert!(is_new_style("1.16.5"));
        assert!(is_new_style("1.20.1"));
        assert!(is_new_style("26.2"), "26.x 当然是新版");
    }

    /// 装出来的版本 id 形如 `<mc>-OptiFine_<补丁>`（与 PCL / 我们的识别器一致）。
    ///
    /// ★ 这条测试第一版断言的是 `<mc>-<文件名>`（`1.20.1-OptiFine_1.20.1_HD_U_I6`），
    ///   而 OptiFine 的 Patcher **实际产出**的是 `1.20.1-OptiFine_HD_U_I6`
    ///   —— 它在 id 里把重复的 MC 版本号去掉了（实测 1.16.5 + G8 确认）。
    ///   期望值改成实测结果；真实产出的判定走 `locate_produced_version`（读盘）。
    #[test]
    fn version_id_shape() {
        assert_eq!(
            installed_version_id("1.20.1", &of(false, "HD U I6", "OptiFine_1.20.1_HD_U_I6.jar")),
            "1.20.1-OptiFine_HD_U_I6"
        );
        assert_eq!(
            installed_version_id("1.16.5", &of(false, "HD U G8", "OptiFine_1.16.5_HD_U_G8.jar")),
            "1.16.5-OptiFine_HD_U_G8"
        );
        // 预览版的补丁号里有空格，要变成下划线
        assert_eq!(
            installed_version_id(
                "1.20.1",
                &of(true, "HD U I6 pre4", "preview_OptiFine_1.20.1_HD_U_I6_pre4.jar")
            ),
            "1.20.1-OptiFine_HD_U_I6_pre4"
        );
    }

    /// ★ 读 class 头算 Java 版本：构造一个最小 zip 来验算。
    ///
    ///   class 文件头 `CA FE BA BE <minor:2> <major:2>`，Java 主版本 = major - 44。
    ///   这里造 3 个：Java 8（52）、Java 17（61）、Java 21（65）。
    #[test]
    fn required_java_from_class_header() {
        use std::io::Write;
        for (class_ver, want_java) in [(52u16, 8u32), (61, 17), (65, 21)] {
            let dir = std::env::temp_dir().join(format!("ieml-ofhdr-{class_ver}"));
            let _ = std::fs::create_dir_all(&dir);
            let jar = dir.join("inst.jar");
            {
                let f = std::fs::File::create(&jar).unwrap();
                let mut z = zip::ZipWriter::new(f);
                z.start_file("optifine/Installer.class", zip::write::SimpleFileOptions::default())
                    .unwrap();
                let mut bytes = vec![0xCA, 0xFE, 0xBA, 0xBE];
                bytes.extend_from_slice(&0u16.to_be_bytes()); // minor
                bytes.extend_from_slice(&class_ver.to_be_bytes()); // major
                bytes.extend_from_slice(&[0u8; 16]); // 随便一点正文
                z.write_all(&bytes).unwrap();
                z.finish().unwrap();
            }
            let got = required_java_major(&jar).expect("应该能读出来");
            assert_eq!(
                got, want_java,
                "class 版本 {class_ver} 应对应 Java {want_java}，实际算出 {got}"
            );
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    /// 坏 jar / 缺 class → 要报错，不能静默给一个错的 Java 版本。
    #[test]
    fn required_java_rejects_garbage() {
        let dir = std::env::temp_dir().join("ieml-ofhdr-bad");
        let _ = std::fs::create_dir_all(&dir);
        let notjar = dir.join("not.jar");
        std::fs::write(&notjar, b"this is not a zip").unwrap();
        assert!(required_java_major(&notjar).is_err(), "不是 zip 就该报错");

        // 是 zip 但没有 optifine/Installer.class
        let empty = dir.join("empty.jar");
        {
            let f = std::fs::File::create(&empty).unwrap();
            let mut z = zip::ZipWriter::new(f);
            z.start_file("readme.txt", zip::write::SimpleFileOptions::default())
                .unwrap();
            use std::io::Write as _;
            z.write_all(b"hi").unwrap();
            z.finish().unwrap();
        }
        assert!(
            required_java_major(&empty).is_err(),
            "没有 Installer.class 就该报错（而不是猜一个 Java 版本）"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
