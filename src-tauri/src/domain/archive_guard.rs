//! **压缩包落盘闸门**（Zip Slip / 路径逃逸 / 体积上限）—— 全仓库**唯一**一份判据。
//!
//! ## 为什么必须有这个模块（P0 安全）
//!
//!   启动器下载的东西**解压出来就被执行**（natives 的 `.dll`、Java 的 `java.exe`、
//!   整合包的 mod）。而压缩包里的条目名是**别人写的字符串**：
//!
//!   * `../../../../AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/x.dll`
//!     —— 目录穿越，写到目标目录**外面**（自启动目录都能写）；
//!   * `C:/Windows/System32/x.dll` / `\\server\share\x` —— 绝对路径。
//!     Rust 的 `Path::join` 语义是"**绝对路径整个替换前缀**"，于是 `target.join(rel)`
//!     就真的写到系统目录去了（这一条最容易看漏：代码读起来像"拼在 target 里"）；
//!   * `..\..\evil.dll` —— Windows 上 `\` 也是分隔符，不先统一分隔符就判不出来；
//!   * `a.txt:zone` —— Windows ADS（备用数据流）：目录**没逃出去**，但写出来的
//!     不是普通文件（`zip` crate 的 `enclosed_name()` 会**放它过去**）。
//!
//! ## 与 `crate::modrinth::safe_relative_path` 的关系
//!
//!   `safe_relative_path` 是这条判据的**第一版**（P0-2，只用在整合包清单的
//!   `files[].path` 上）。它守住了清单那条路，但**解压这条路**各自为政：
//!   natives 与 Java zip 都只靠 `zip` 的 `enclosed_name()`（挡 `..`/绝对路径，
//!   **挡不住 ADS**），而 Java 的 tar.gz 分支直接 `tar -xzf`（**零校验**）。
//!
//!   ⇒ 现在判据只在这里一份，两条路（清单路径 / 解压条目）共用**同一个函数**。
//!     本模块**零 `crate::` 依赖**（纯逻辑）：因此它能被 `rustc` 单独编译成小程序
//!     跑断言（本机 `cargo test --lib` 因 cdylib 加载失败跑不起来，见项目记忆）。
//!
//! ## 判据（保守优先：拿不准就拒绝，并且**必须说出来**）
//!
//!   拒绝：空/只有空白、`..` 段、`.` 段（归一后为空）、空段（`//`、首尾 `/`）、
//!         绝对路径（`/x`、`C:/x`、`C:x`、`\\server\share`）、**任何含 `:` 的段**
//!         （盘符 + ADS）、Windows 保留设备名（`CON` / `NUL` / `COM1` …）、
//!         非 UTF-8（调用方自行判，见 [`ArchivePath::Rejected`]）。
//!   接受：普通相对路径（含 `.hidden` 这种点号开头的隐藏文件）、
//!         反斜杠变体（**先统一成 `/` 再判**）、重复分隔符、结尾多一个 `/`。
//!
//!   调用方**不许静默丢弃**：每次拒绝都要把"条目名 + 拒因"交回给用户，
//!   静默丢文件会让"装完了但少东西"变成一个查不出来的谜（项目已有过一次事故）。

use std::path::PathBuf;

/// 一条压缩包条目名**为什么**被拒（要能原样念给用户听）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rejected {
    /// 空字符串 / 只有空白
    Empty,
    /// 归一化之后什么都不剩（`"."` / `"./"` / `"/"`）
    EmptyAfterNormalize,
    /// 出现 `..` 段（目录穿越）
    Traversal,
    /// 绝对路径（`/etc/x`、`C:/Windows/x`）
    Absolute,
    /// 盘符相对路径（`C:evil.txt` —— Windows 上照样指到别处）
    DriveQualified,
    /// 段里含 `:`（Windows ADS，例如 `a.txt:zone`；也覆盖盘符）
    AlternateDataStream,
    /// Windows 保留设备名（`CON`、`NUL`、`COM1`、`LPT1`…，带不带扩展名都算）
    ReservedDeviceName,
}

impl Rejected {
    /// 中文拒因（写日志、写错误、给测试断言用）
    pub fn why(self) -> &'static str {
        match self {
            Rejected::Empty => "条目名是空的",
            Rejected::EmptyAfterNormalize => "条目名归一化之后为空（只有 `.` 或 `/`）",
            Rejected::Traversal => "含 `..` 段，会解压到目标目录之外（Zip Slip）",
            Rejected::Absolute => "是绝对路径（`join` 会整个替换目标目录）",
            Rejected::DriveQualified => "带盘符（`C:x`：Windows 上指到别处）",
            Rejected::AlternateDataStream => {
                "含 `:`（Windows ADS 备用数据流，`a.txt:zone` 不是普通文件）"
            }
            Rejected::ReservedDeviceName => "是 Windows 保留设备名（CON / NUL / COM1…）",
        }
    }
}

/// Windows 保留设备名（**不带**扩展名比较：`CON.txt` 也照样是设备）
///
/// 为什么要拒：`CON` / `NUL` 这类名字在 Windows 上不是普通文件，
/// `File::create` 会打开**设备**（经典例子：`NUL` 一切写入都"成功"但什么都不落盘，
/// 而 `CON` 会跟控制台绞在一起）。启动器解压出的东西要被读、要被执行，
/// 落成设备的文件 = 静默丢失 + 行为诡异。拒掉它，代价是一个正常压缩包里
/// **本来就不会出现**的名字。
const WINDOWS_RESERVED: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// 这一段是不是保留设备名（去掉扩展名再比；`.` 开头的 `.con` 不算 —— 那不是设备）
fn is_reserved_device_name(segment: &str) -> bool {
    // 设备名判定要点：Windows 眼里 `CON`、`CON.txt`、`con.` 是同一个东西，
    // 但 `.con`（隐藏文件）不是 —— 所以先看首字符是不是点。
    if segment.starts_with('.') {
        return false;
    }
    let stem = segment.split('.').next().unwrap_or(segment);
    // Windows 还会忽略结尾的空格（`"CON "` 也是设备）—— 一并归一
    let stem = stem.trim_end_matches(' ');
    WINDOWS_RESERVED
        .iter()
        .any(|r| stem.eq_ignore_ascii_case(r))
}

/// 压缩包里的一条路径**能不能安全地落到目标目录里**。
///
/// 返回 `None` = 不安全（调用方必须**说出来**，不许静默丢弃）。
/// 要通过就把拒因也带出来（"说清楚为什么"比"只说不行"有用）。
pub fn classify_archive_path(raw: &str) -> std::result::Result<PathBuf, Rejected> {
    let text = raw.trim();
    if text.is_empty() {
        return Err(Rejected::Empty);
    }
    // Windows 上 `\` 也是分隔符（zip 里两种都见过）—— **先统一**再判，
    // 否则 `..\..\x` 会被当成一个"名字里带反斜杠"的普通文件放过去。
    let unified = text.replace('\\', "/");

    // ① 绝对路径：POSIX 的 `/x` 与 UNC 的 `//server/share/x`
    //    （`C:/x` 与 `C:x` 走下面的"含 `:`"一并拒掉）
    if unified.starts_with('/') {
        return Err(Rejected::Absolute);
    }

    let mut out = PathBuf::new();
    for part in unified.split('/') {
        if part.is_empty() || part == "." {
            continue; // 重复分隔符 / `./` —— 归一掉，不当成逃逸
        }
        if part == ".." {
            return Err(Rejected::Traversal); // 只要出现一次向上走，整条路径作废
        }
        // ② 任何一段里带 `:` 都不是普通文件名：
        //    `C:`（盘符，Windows 上 `join` 会替换前缀）、`a.txt:zone`（ADS）
        if part.contains(':') {
            // 盘符那几种单独给一个更好念的拒因（都是拒，只是话说得更准）：
            // 单字符 + `:` 开头的段就是盘符（`C:`、`C:evil.jar`、`c:x`）。
            // ★ 判据不写成 `part.len() == 2`：`C:evil.jar` 是**盘符相对路径**，
            //   一样指到别处（这一条是判据层断言先跑出来的）。
            let first = part.chars().next();
            if first.is_some_and(|c| c.is_ascii_alphabetic())
                && part.chars().nth(1) == Some(':')
            {
                return Err(Rejected::DriveQualified);
            }
            return Err(Rejected::AlternateDataStream);
        }
        // ③ Windows 保留设备名
        if is_reserved_device_name(part) {
            return Err(Rejected::ReservedDeviceName);
        }
        out.push(part);
    }

    if out.as_os_str().is_empty() {
        return Err(Rejected::EmptyAfterNormalize);
    }
    Ok(out)
}

/// `classify_archive_path` 的布尔版（调用方只关心能不能过时用这个）
pub fn is_safe_archive_path(raw: &str) -> bool {
    classify_archive_path(raw).is_ok()
}

/// 把一批条目名一次判完：`(通过的, 被拒的)`。
///
/// ★ 为什么要有"先全判、再落盘"这一步：解压**不许**出现
///   "前面几条已经写进去、后面才发现有问题"的状态。先把整包的条目名过一遍，
///   任何一条试图逃出目标目录 ⇒ **整包拒绝、一个字节都不写**（见
///   `installer::try_extract_natives` 与 `adoptium::extract_zip` 的用法）。
pub fn partition_archive_paths<S: AsRef<str>>(
    names: &[S],
) -> (Vec<PathBuf>, Vec<(String, Rejected)>) {
    let mut ok = Vec::new();
    let mut bad = Vec::new();
    for n in names {
        match classify_archive_path(n.as_ref()) {
            Ok(p) => ok.push(p),
            Err(why) => bad.push((n.as_ref().to_string(), why)),
        }
    }
    (ok, bad)
}

/* ==================== 按类别的响应体体积上限 ==================== */

/// 一个下载**是什么东西** —— 体积上限按它取（不同类别差三个数量级：
/// 图标几百 KB，Java 运行时 200 MB，拿一个数套所有东西必然要么太松要么太紧）。
///
/// ## 为什么要按类别
///
///   清单第 172 行：「**Cap what you accept.** A response size limit per artifact
///   class stops a hostile server from filling the disk.」
///   没有上限的后果很具体：一个（被劫持的 / 恶意的）镜像返回无限长的响应体，
///   磁盘就满了 —— 而我们的下载是流式写盘，**不设闸门就没有任何东西拦得住**。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArtifactClass {
    /// 客户端 jar（1.20.1 实测 ~22 MB；上限留宽）
    ClientJar,
    /// 普通库 jar / 加载器 jar / 主 jar
    Library,
    /// natives jar（很小，`.dll` 几十 KB ~ 几 MB）
    NativesJar,
    /// 资源文件（`assets/objects/<hash>`，单个最大实测 ~10 MB）
    Asset,
    /// 资源索引 JSON（1.20.1 实测 600 KB）
    AssetIndex,
    /// 整合包包体（Better MC 实测 113 MB，分片下载走这条路）
    ModpackArchive,
    /// 单个 mod / 资源包
    Mod,
    /// 图片类（整合包图标、mod 图标）
    Image,
    /// Java 运行时压缩包（**本仓库最大的单个下载**，JDK 解压后 ~180 MB）
    JavaRuntime,
    /// 别的可执行安装器（Forge / OptiFine / LiteLoader 的 jar）
    LoaderInstaller,
    /// 类别不明 —— 用**最紧**的那一档，宁可重试也不放行一个无限响应体
    Unknown,
}

/// 每个类别的默认上限（字节）。
///
/// ## 取值依据（不是拍脑袋）
///
///   | 类别 | 真实规模（实测/官方清单） | 上限 | 倍数 |
///   |---|---|---|---|
///   | 客户端 jar | 1.20.1 = 22 MB（`downloads.client.size`） | 256 MiB | ×11 |
///   | 库 jar | 绝大多数 < 10 MB（Forge 的 `universal` 约 6 MB） | 128 MiB | ×13 |
///   | natives jar | 实测 `lwjgl-3.3.1-natives-windows` ≈ 1 MB | 64 MiB | ×60 |
///   | 资源文件 | `assets/objects` 单文件最大约 10 MB | 64 MiB | ×6 |
///   | 资源索引 | 1.20.1 的 `indexes/…json` = 600 KB | 32 MiB | ×50 |
///   | 整合包包体 | Better MC 113 MB（用户实测） | 2 GiB | ×18 |
///   | 单个 mod | 大 mod（光影/结构）约 100 MB | 512 MiB | ×5 |
///   | 图片 | 图标是给人看的小图 | 8 MiB | 已存在 2 MiB 那道闸门 |
///   | Java 运行时 | JDK 17 压缩包约 190 MB | 1 GiB | ×5 |
///   | 安装器 | Forge/NeoForge 安装器 < 30 MB | 256 MiB | ×8 |
///
///   ★ 上限**只用于"拒绝荒谬的响应体"**，不是"预期大小"：正常文件离上限
///     还有 5~50 倍。设小了会误杀真实版本（例如某天 Mojang 把客户端做到 300 MB），
///     所以留的余量按"历史上最大值 × 5 以上"取。
///   ★ `Unknown` 故意最紧（64 MiB）：**不知道是什么**的时候保守优先 ——
///     它会被拒、会被如实报出来，而不是悄悄写满磁盘。
pub fn default_limit_for(class: ArtifactClass) -> u64 {
    const MIB: u64 = 1024 * 1024;
    match class {
        ArtifactClass::ClientJar => 256 * MIB,
        ArtifactClass::Library => 128 * MIB,
        ArtifactClass::NativesJar => 64 * MIB,
        ArtifactClass::Asset => 64 * MIB,
        ArtifactClass::AssetIndex => 32 * MIB,
        ArtifactClass::ModpackArchive => 2 * 1024 * MIB, // 2 GiB
        ArtifactClass::Mod => 512 * MIB,                  // 注意：512 * MIB 在 32 位下会溢出，见测试
        ArtifactClass::Image => 8 * MIB,
        ArtifactClass::JavaRuntime => 1024 * MIB, // 1 GiB
        ArtifactClass::LoaderInstaller => 256 * MIB,
        ArtifactClass::Unknown => 64 * MIB,
    }
}

/// 一个下载类的体积闸门（值对象）。**引擎对接点**见模块末尾的说明。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ByteCap {
    /// 上限（字节）。`None` = 不设上限（**只给"流式复制本地文件"这类内部任务**用）
    pub max_bytes: Option<u64>,
}

impl ByteCap {
    /// 按类别取默认上限
    pub fn for_class(class: ArtifactClass) -> Self {
        Self {
            max_bytes: Some(default_limit_for(class)),
        }
    }

    /// 不设上限（内部 `file://` 复制任务；**绝不用在网络上**）
    pub fn unlimited() -> Self {
        Self { max_bytes: None }
    }

    /// 已知大小（`Content-Length` / 清单里的 `size`）**在开始下之前**就超限？
    ///
    /// ★ 这是最省的一次拦截：一个声明 8 GiB 的"图标"在建立连接前就该被拒，
    ///   而不是下满 8 GiB 再发现。
    pub fn rejected_by_declared_size(&self, declared: u64) -> bool {
        match self.max_bytes {
            Some(cap) => declared > cap,
            None => false,
        }
    }

    /// 流式累计超限？（`received` = 已经收下的字节数）
    ///
    /// ★ 这是**真正兜住"服务器不报 Content-Length"** 的那一次判定：
    ///   `received > cap` 立刻断开 + 删 `.part` + 报错点名这个文件。
    pub fn over_limit(&self, received: u64) -> bool {
        match self.max_bytes {
            Some(cap) => received > cap,
            None => false,
        }
    }

    /// 给人看的上限字符串（"16 MiB"）
    pub fn describe(&self) -> String {
        match self.max_bytes {
            None => "不限".to_string(),
            Some(b) => {
                if b % (1024 * 1024 * 1024) == 0 {
                    format!("{} GiB", b / (1024 * 1024 * 1024))
                } else {
                    format!("{} MiB", b / (1024 * 1024))
                }
            }
        }
    }
}

/// 一次下载的累计字节计数（**引擎接上时用它，别自己写 if**）
///
/// ```ignore
/// // 引擎里（download.rs 的流式写盘循环）：
/// let mut meter = ByteMeter::new(ByteCap { max_bytes: cap });
/// while let Some(chunk) = stream.next().await {
///     meter.add(chunk.len() as u64)?;   // ← 超限立刻 Err，调用方断流 + 删 .part
///     file.write_all(&chunk).await?;
/// }
/// ```
#[derive(Debug, Clone)]
pub struct ByteMeter {
    cap: ByteCap,
    received: u64,
}

impl ByteMeter {
    pub fn new(cap: ByteCap) -> Self {
        Self { cap, received: 0 }
    }

    /// 用"**盘上已经有的字节**"开局（断点续传：`.part` / 分片段已有 `already` 字节）。
    ///
    /// ## 为什么必须有这个开头（否则续传会绕过上限）
    ///
    ///   闸门要拦的是"**这个文件最终会长到多大**"，而不是"这一轮新收了多少"。
    ///   若 meter 从 0 起算，那么"下了一半 → 断了 → 接着下剩下一半"这条路上，
    ///   每一轮都只看到半份大小 —— 一个超大响应体分几轮就绕过去了。
    ///   ⇒ 续传时把 `already` 喂进来，计量口径就永远是**整份文件**。
    ///
    /// ★ 它自己**也会判**：`already` 已经超限就立刻返回 Err（盘上那份残留本身
    ///   就是超限现场，不该再往上加）。Err 与 `add` 同形：`(上限, 已收)`。
    #[allow(clippy::result_large_err)]
    pub fn starting_at(&self, already: u64) -> std::result::Result<Self, (u64, u64)> {
        let mut m = Self::new(self.cap);
        m.received = already;
        if m.cap.over_limit(m.received) {
            return Err((m.cap.max_bytes.unwrap_or(0), m.received));
        }
        Ok(m)
    }

    /// 累加一段；**超限返回 Err(上限, 已收)**（调用方负责断流与删除 `.part`）
    #[allow(clippy::result_large_err)]
    pub fn add(&mut self, n: u64) -> std::result::Result<(), (u64, u64)> {
        self.received = self.received.saturating_add(n);
        if self.cap.over_limit(self.received) {
            let cap = self.cap.max_bytes.unwrap_or(0);
            return Err((cap, self.received));
        }
        Ok(())
    }

    pub fn received(&self) -> u64 {
        self.received
    }

    pub fn cap(&self) -> ByteCap {
        self.cap
    }
}

impl Default for ByteMeter {
    /// 默认**不设上限** —— 但绝不意味着网络任务可以不带闸门：
    /// 每个网络任务都该用过 [`ByteCap::for_class`] 的闸门建 meter。
    fn default() -> Self {
        Self::new(ByteCap::unlimited())
    }
}

/// 从任务的**展示标签**推类别（兜底用）。
///
/// ## 为什么还要一个"从标签推"的兜底
///
///   任务生成的三个地方（`installer.rs` / `modrinth.rs` / `curseforge.rs`）都会
///   **显式**把类别写在标签前缀里（`"库 …"` / `"客户端 …"` / `"Java {版本} 运行时"`），
///   所以类别本来该由调用方直接给。但下载引擎那边拿到的是一个字符串标签——
///   当它需要在**不知道调用方意图**的地方兜住一条响应体时，这个查表就是那条兜底。
///
///   ★ 匹配顺序有讲究：**先长后短**（`"客户端"` 要在 `"库"` 之前判，
///     `"Java "` 要在 `"库"` 之前判）—— 否则 `"本地库 …"` 会吃掉
///     `"Java …"` 那种前缀重叠。不确定的一律回 [`ArtifactClass::Unknown`]
///     （最紧的一档，宁可拒也不放行一个无限响应体）。
pub fn class_from_label(label: &str) -> ArtifactClass {
    let l = label.trim();
    if l.is_empty() {
        return ArtifactClass::Unknown;
    }
    // ↓ 顺序 = 优先级（标签前缀越长、越具体越靠前）
    const TABLE: [(&str, ArtifactClass); 12] = [
        // ★ 实际标签是 `"Java {版本} 运行时"`（见 adoptium.rs）—— 所以前缀是 `"Java `，
        //   不是 `"Java 运行时"`。这条要是写错，Java 那条会掉进 Unknown（64 MiB），
        //   而 Adoptium 的压缩包正常就有 190 MB ⇒ 会把功能改死。测试盯着这一点。
        ("Java ", ArtifactClass::JavaRuntime),
        ("客户端", ArtifactClass::ClientJar),
        ("资源索引", ArtifactClass::AssetIndex),
        ("OptiFine 安装器", ArtifactClass::LoaderInstaller),
        ("LiteLoader 依赖", ArtifactClass::LoaderInstaller),
        ("Forge 安装器", ArtifactClass::LoaderInstaller),
        ("NeoForge 安装器", ArtifactClass::LoaderInstaller),
        ("本地库", ArtifactClass::Library),
        ("库 ", ArtifactClass::Library),
        ("整合包", ArtifactClass::ModpackArchive),
        ("图标", ArtifactClass::Image),
        ("mod ", ArtifactClass::Mod),
    ];
    for (prefix, class) in TABLE {
        if l.starts_with(prefix) {
            return class;
        }
    }
    ArtifactClass::Unknown
}

#[cfg(test)]
mod tests {
    /*
     * ★★ 本模块的测试是**唯一能在本机真跑**的那一层：
     *   项目记忆实测 `cargo test --lib` 在加载阶段就退出
     *   （`0xc0000139 STATUS_ENTRYPOINT_NOT_FOUND`，与 cdylib 有关）。
     *   所以这里刻意做到**零 `crate::` 依赖**，好让
     *     rustc --edition 2021 -O -C panic=abort -o out.exe test.rs
     *   把**同一个源文件**单独编译成小程序跑断言（项目既有做法）。
     */
    use super::*;

    /* ---------- 该放过的（别把功能改死） ---------- */

    #[test]
    fn accepts_normal_entries() {
        // 普通路径（用正斜杠比较，避免 Windows 上的分隔符差异）
        for good in [
            "mods/sodium.jar",
            "config/deep/nested/a.toml",
            "windows/x64/org/lwjgl/lwjgl.dll",
        ] {
            let got = classify_archive_path(good).expect("正常路径必须通过");
            assert_eq!(got.to_string_lossy().replace('\\', "/"), good);
        }
        // 反斜杠变体 → 归一成 `/`
        let got = classify_archive_path("mods\\sodium.jar").expect("反斜杠要归一后通过");
        assert_eq!(got.to_string_lossy().replace('\\', "/"), "mods/sodium.jar");
        // 隐藏文件（整合包里真的会有 `.connector` 这类）
        let got = classify_archive_path("mods/.connector").expect("点号开头的隐藏文件要通过");
        assert_eq!(got.to_string_lossy().replace('\\', "/"), "mods/.connector");
        // 重复分隔符 / `./` 只是归一，不算逃逸
        assert_eq!(
            classify_archive_path("mods//a.jar")
                .expect("重复分隔符不该拒")
                .to_string_lossy()
                .replace('\\', "/"),
            "mods/a.jar"
        );
        assert_eq!(
            classify_archive_path("./mods/a.jar")
                .expect("`./` 不该拒")
                .to_string_lossy()
                .replace('\\', "/"),
            "mods/a.jar"
        );
        assert_eq!(
            classify_archive_path("mods/a.jar/")
                .expect("结尾多一个分隔符不该拒")
                .to_string_lossy()
                .replace('\\', "/"),
            "mods/a.jar"
        );
    }

    /* ---------- 该拒的（清单第 159-163 行逐条） ---------- */

    #[test]
    fn rejects_traversal() {
        for bad in [
            "../escape.txt",
            "../../escape.txt",
            "..\\..\\escape.txt",
            "mods/../../escape.txt",
            "mods/..",
            "..",
            "a/../../b",
        ] {
            assert_eq!(
                classify_archive_path(bad),
                Err(Rejected::Traversal),
                "必须拒绝目录穿越：{bad}"
            );
        }
    }

    #[test]
    fn rejects_absolute_and_drive_paths() {
        assert_eq!(classify_archive_path("/etc/cron.d/x"), Err(Rejected::Absolute));
        assert_eq!(
            classify_archive_path("\\\\server\\share\\evil.txt"),
            Err(Rejected::Absolute)
        );
        assert_eq!(
            classify_archive_path("//server/share/evil.txt"),
            Err(Rejected::Absolute)
        );
        assert_eq!(
            classify_archive_path("C:/Windows/System32/x.dll"),
            Err(Rejected::DriveQualified)
        );
        // 盘符**相对**路径：`C:evil.txt`（Windows 上指到 C 盘当前目录）
        assert_eq!(
            classify_archive_path("C:evil.txt"),
            Err(Rejected::DriveQualified)
        );
        assert_eq!(
            classify_archive_path("c:evil.txt"),
            Err(Rejected::DriveQualified)
        );
        // 深一层里的盘符段
        assert_eq!(
            classify_archive_path("mods/C:evil.jar"),
            Err(Rejected::DriveQualified)
        );
    }

    /// ★ ADS：`zip` 的 `enclosed_name()` **会放它过去**（路径没逃出目标目录），
    ///   而它写出来的不是普通文件 —— 这一条正是"两道闸门一起用"的理由。
    #[test]
    fn rejects_windows_ads() {
        for bad in ["a.txt:zone", "mods/a.jar:evil", ":zone"] {
            assert_eq!(
                classify_archive_path(bad),
                Err(Rejected::AlternateDataStream),
                "必须拒绝 ADS：{bad}"
            );
        }
        /*
         * `a:b:c` 归到**盘符**那一档（单字符 + `:` 开头的段）。
         * 两种拒因都对（Windows 上 `a:x` 首先是盘符相对路径），
         * 这里钉住的是"它**被拒**"这件事 —— 拒因的措辞不参与安全判定。
         */
        assert_eq!(
            classify_archive_path("a:b:c"),
            Err(Rejected::DriveQualified)
        );
    }

    #[test]
    fn rejects_empty_and_dot_only() {
        assert_eq!(classify_archive_path(""), Err(Rejected::Empty));
        assert_eq!(classify_archive_path("   "), Err(Rejected::Empty));
        assert_eq!(classify_archive_path("."), Err(Rejected::EmptyAfterNormalize));
        assert_eq!(classify_archive_path("./"), Err(Rejected::EmptyAfterNormalize));
        assert_eq!(classify_archive_path("/"), Err(Rejected::Absolute));
    }

    /// 保留设备名（比清单多出来的一条：`CON`/`NUL` 落盘会变成**设备**）
    #[test]
    fn rejects_windows_reserved_device_names() {
        for bad in ["CON", "nul", "COM1", "lpt9", "CON.txt", "mods/NUL"] {
            assert_eq!(
                classify_archive_path(bad),
                Err(Rejected::ReservedDeviceName),
                "必须拒绝保留设备名：{bad}"
            );
        }
        // 但 `.con`（隐藏文件）不是设备 —— 不许误杀
        assert!(classify_archive_path(".con").is_ok());
        // `CONSOLE.txt` 也不是
        assert!(classify_archive_path("CONSOLE.txt").is_ok());
    }

    /// "先全判、再落盘"：整包判定要能把**被拒的条目点名交回**
    #[test]
    fn partition_reports_every_rejected_entry_by_name() {
        let names = [
            "mods/ok.jar",
            "../escape.txt",
            "C:evil.txt",
            "a.txt:zone",
            "config/a.toml",
        ];
        let (ok, bad) = partition_archive_paths(&names);
        assert_eq!(ok.len(), 2, "只有两条合法：{ok:?}");
        assert_eq!(bad.len(), 3, "三条必须被点名：{bad:?}");
        assert!(bad.iter().any(|(n, w)| n == "../escape.txt" && *w == Rejected::Traversal));
        assert!(bad.iter().any(|(n, w)| n == "C:evil.txt" && *w == Rejected::DriveQualified));
        assert!(bad.iter().any(|(n, w)| n == "a.txt:zone" && *w == Rejected::AlternateDataStream));
        // 拒因必须能念给人听（不是空的）
        for (_, w) in &bad {
            assert!(!w.why().is_empty());
        }
    }

    /* ---------- 体积上限 ---------- */

    #[test]
    fn caps_are_ordered_sensibly() {
        // 图标 < 资源索引 < natives < 资源 < 库 < 客户端 jar < Java 运行时
        assert!(default_limit_for(ArtifactClass::Image) < default_limit_for(ArtifactClass::AssetIndex));
        assert!(
            default_limit_for(ArtifactClass::AssetIndex) < default_limit_for(ArtifactClass::NativesJar)
        );
        // natives 与单个资源文件同档（都是 64 MiB）：两者真实规模都远小于它，
        // 这里要的是"不许比资源索引还松"而不是一条无意义的严格序
        assert!(
            default_limit_for(ArtifactClass::NativesJar) <= default_limit_for(ArtifactClass::Asset)
        );
        assert!(default_limit_for(ArtifactClass::Asset) < default_limit_for(ArtifactClass::Library));
        assert!(default_limit_for(ArtifactClass::Library) < default_limit_for(ArtifactClass::ClientJar));
        assert!(
            default_limit_for(ArtifactClass::ClientJar) < default_limit_for(ArtifactClass::JavaRuntime)
        );
        assert!(
            default_limit_for(ArtifactClass::JavaRuntime) < default_limit_for(ArtifactClass::ModpackArchive)
        );
        // 类别不明取最紧的一档（保守优先）
        assert!(default_limit_for(ArtifactClass::Unknown) <= default_limit_for(ArtifactClass::Asset));
    }

    /// ★ 真实的规模必须**远低于**上限（不然就是设小了，会误杀真版本）
    #[test]
    fn real_world_sizes_pass_their_caps() {
        const MIB: u64 = 1024 * 1024;
        // 1.20.1 客户端 jar = 39,193,383 字节（`downloads.client.size`）
        assert!(!ByteCap::for_class(ArtifactClass::ClientJar).over_limit(39_193_383));
        // Better MC 包体 113 MB（用户实测）
        assert!(!ByteCap::for_class(ArtifactClass::ModpackArchive).over_limit(113 * MIB));
        // JDK 17 压缩包约 190 MB
        assert!(!ByteCap::for_class(ArtifactClass::JavaRuntime).over_limit(190 * MIB));
        // 1.20.1 资源索引 600 KB
        assert!(!ByteCap::for_class(ArtifactClass::AssetIndex).over_limit(600 * 1024));
        // 整合包图标 2 MiB 那道既有闸门的量级
        assert!(!ByteCap::for_class(ArtifactClass::Image).over_limit(2 * MIB));
    }

    #[test]
    fn over_limit_boundary_is_inclusive_of_the_cap() {
        let cap = ByteCap {
            max_bytes: Some(100),
        };
        assert!(!cap.over_limit(0));
        assert!(!cap.over_limit(100), "正好等于上限 = 允许（上限是「最多」的意思）");
        assert!(cap.over_limit(101));
    }

    #[test]
    fn declared_size_is_rejected_before_the_first_byte() {
        let cap = ByteCap::for_class(ArtifactClass::Image); // 8 MiB
        assert!(!cap.rejected_by_declared_size(0));
        assert!(!cap.rejected_by_declared_size(2 * 1024 * 1024));
        assert!(cap.rejected_by_declared_size(64 * 1024 * 1024));
        // 未知大小（0）= 不拦 —— 真正的兜底是流式累计那里
        assert!(!cap.rejected_by_declared_size(0));
        // 不设上限的任务（内部 file:// 复制）永远不拦
        assert!(!ByteCap::unlimited().over_limit(u64::MAX));
        assert!(!ByteCap::unlimited().rejected_by_declared_size(u64::MAX));
    }

    /// 流式累计：**服务器不报 Content-Length 时**唯一拦得住的判定
    #[test]
    fn meter_stops_streaming_once_over_the_cap() {
        let mut m = ByteMeter::new(ByteCap {
            max_bytes: Some(1000),
        });
        assert!(m.add(400).is_ok());
        assert!(m.add(600).is_ok(), "累计到 1000 = 正好等于上限，放行");
        assert_eq!(m.received(), 1000);
        let err = m.add(1).expect_err("再收一个字节就超限");
        assert_eq!(err, (1000, 1001), "要把(上限, 已收)交回去，错误里才能点名");
        // 不设上限的meter永远不报错
        let mut u = ByteMeter::new(ByteCap::unlimited());
        for _ in 0..100 {
            assert!(u.add(u64::MAX / 200).is_ok());
        }
    }

    #[test]
    fn cap_describe_is_human_readable() {
        assert_eq!(ByteCap::for_class(ArtifactClass::Image).describe(), "8 MiB");
        assert_eq!(ByteCap::for_class(ArtifactClass::JavaRuntime).describe(), "1 GiB");
        assert_eq!(ByteCap::unlimited().describe(), "不限");
    }

    /// 标签 → 类别（引擎那条兜底查表）：**先长后短**，不认识就取最紧的一档
    #[test]
    fn class_from_label_matches_longest_prefix_first() {
        use ArtifactClass::*;
        let cases = [
            ("Java 17.0.10 运行时", JavaRuntime), // ★ 真实文案（adoptium.rs）
            ("Java 运行时 Temurin 17.0.10", JavaRuntime),
            ("客户端 1.20.1.jar", ClientJar),
            ("资源索引 5", AssetIndex),
            ("资源文件 minecraft/sounds/x.ogg", Unknown), // 单个资源：标签是资源名，取最紧
            ("本地库 lwjgl-3.3.1", Library),
            ("库 fabric-loader-0.19.5", Library),
            ("OptiFine 安装器 1.20.1_HD_U_I6", LoaderInstaller),
            ("LiteLoader 依赖 lwjgl", LoaderInstaller),
            ("整合包 Better MC", ModpackArchive),
            ("图标 pack.png", Image),
            ("", Unknown),
        ];
        for (label, want) in cases {
            assert_eq!(class_from_label(label), want, "标签：{label}");
        }
        // ★ 前缀重叠的那两条最容易搞错：`"本地库 …"` 不许被当成别的，
        //   而 `"Java …"` 也不许被 `"库"` 那类规则吃掉
        assert_eq!(class_from_label("本地库 java-17"), Library);
        assert_eq!(class_from_label("Java 17.0.10 运行时"), JavaRuntime);
        // ★★ 防"把功能改死"：Adoptium 的压缩包正常 190 MB，
        //    Java 这条必须拿到 1 GiB 那一档，不能掉进 Unknown（64 MiB）
        assert!(
            !ByteCap::for_class(class_from_label("Java 17.0.10 运行时")).over_limit(190 * 1024 * 1024),
            "Java 运行时的上限不许小于 190 MB —— 否则真机上下不动 Java"
        );
        // 不认识 → 最紧的一档（保守优先）
        assert_eq!(
            default_limit_for(class_from_label("谁知道这是什么")),
            default_limit_for(Unknown)
        );
    }

    /// ★★ 续传**不许绕过上限**（引擎那两处写盘路径的判据就在这里被钉住）。
    ///
    ///   形状：一个 200 MB 的响应体，上限 100 MB，客户端"下一半 → 断 → 续传剩下一半"。
    ///   如果 meter 只算这一轮新收的字节，两轮各 100 MB 都"没超限" —— 绕过去了。
    ///   `starting_at(already)` 把盘上已有的字节当**初值**，计量口径永远是整份文件。
    #[test]
    fn resume_does_not_bypass_the_cap() {
        let cap = ByteCap {
            max_bytes: Some(100 * 1024 * 1024),
        };
        const MB: u64 = 1024 * 1024;

        // 第一轮：下到 100 MB 正好到顶（放行），第 101 MB 就必须被拦
        let mut first = ByteMeter::new(cap).starting_at(0).expect("从 0 起算不超限");
        assert!(first.add(100 * MB).is_ok(), "正好等于上限 = 放行");
        assert_eq!(
            first.add(1).expect_err("再多一个字节就超限"),
            (100 * MB, 100 * MB + 1)
        );

        // 第二轮（续传）：盘上已有 90 MB —— 初值必须是 90 MB，而不是 0
        let mut resumed = ByteMeter::new(cap)
            .starting_at(90 * MB)
            .expect("90 MB 的残留还没超限，可以接着下");
        assert_eq!(resumed.received(), 90 * MB, "初值 = 盘上已有的字节");
        assert!(resumed.add(10 * MB).is_ok(), "补到 100 MB 正好到顶：放行");
        let err = resumed
            .add(1)
            .expect_err("★ 续传这条路也必须被上限拦住");
        assert_eq!(err, (100 * MB, 100 * MB + 1));

        // 盘上残留**本身**就超限 ⇒ 开局就拒（不许再往上加）
        let err = ByteMeter::new(cap)
            .starting_at(120 * MB)
            .expect_err("残留已经超限，不许继续续传");
        assert_eq!(err, (100 * MB, 120 * MB));

        // 不设上限的任务照旧不受影响（内部 file:// 复制）
        let unlimited = ByteCap::unlimited();
        assert!(ByteMeter::new(unlimited).starting_at(u64::MAX).is_ok());
    }
}
