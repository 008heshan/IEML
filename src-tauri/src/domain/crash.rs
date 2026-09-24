//! 崩溃日志分析（对应前端 `src/domain/crash.ts`，ADR-011）
//!
//! 源码事实：PCL2 的崩溃分析是 **9 大类约 70 条日志特征规则 + 堆栈启发式兜底**。
//!
//! 铁律（DESIGN_SYSTEM 7.14）：**首屏必须是「原因 + 建议动作」，绝不能是堆栈。**
//! 用户要的是"我该怎么办"，不是 "Exception in thread main"。

use regex::Regex;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CrashCategory {
    Java,
    Memory,
    Mod,
    Loader,
    Graphics,
    Account,
    File,
    Environment,
    Unknown,
}

impl CrashCategory {
    pub fn label(self) -> &'static str {
        match self {
            Self::Java => "Java 运行环境",
            Self::Memory => "内存",
            Self::Mod => "Mod",
            Self::Loader => "加载器",
            Self::Graphics => "图形驱动",
            Self::Account => "账号",
            Self::File => "文件完整性",
            Self::Environment => "环境",
            Self::Unknown => "未能确定",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum FixKind {
    SwitchJava,
    RaiseMemory,
    LowerMemory,
    DisableMod,
    RemoveMod,
    ReinstallLoader,
    VerifyFiles,
    DisableOptifine,
    Relogin,
    OpenFolder,
    None,
}

#[derive(Debug, Clone, Serialize)]
pub struct SuggestedAction {
    pub label: String,
    pub kind: FixKind,
}

struct Rule {
    id: &'static str,
    category: CrashCategory,
    pattern: &'static str,
    conclusion: &'static str,
    fix: Option<(&'static str, FixKind)>,
}

/// 规则库。9 大类，覆盖启动器最常见的失败场景。
const RULES: &[Rule] = &[
    // ---------- Java ----------
    Rule { id: "java-version-mismatch", category: CrashCategory::Java,
        pattern: r"(?i)UnsupportedClassVersionError|class file version \d+",
        conclusion: "Mod 或游戏需要的 Java 版本比当前用的更高",
        fix: Some(("换用合适的 Java", FixKind::SwitchJava)) },
    Rule { id: "java-too-new", category: CrashCategory::Java,
        pattern: r"(?i)NoSuchMethodError.*java\.base|Unsupported class file major version 6[5-9]",
        conclusion: "当前 Java 版本过高，老版本 Forge 或 OptiFine 无法在此版本上运行",
        fix: Some(("改用 Java 8", FixKind::SwitchJava)) },
    Rule { id: "java-not-found", category: CrashCategory::Java,
        pattern: r"(?i)Could not find or load main class",
        conclusion: "找不到要启动的主程序，通常是 Java 选错了或游戏文件缺失",
        fix: Some(("校验游戏文件", FixKind::VerifyFiles)) },
    Rule { id: "java-arch-mismatch", category: CrashCategory::Java,
        pattern: r"(?i)Can't load this \.dll|is not a valid Win32 application|wrong ELF class",
        conclusion: "Java 的位数与系统或 Mod 不匹配",
        fix: Some(("换用 64 位 Java", FixKind::SwitchJava)) },
    Rule { id: "java-unsafe", category: CrashCategory::Java,
        pattern: r"(?i)sun\.misc\.Unsafe|LWJGL.*Unsafe",
        conclusion: "新版 Java 移除了 LWJGL 依赖的 Unsafe 接口",
        fix: Some(("关闭 LWJGL Unsafe 检查", FixKind::SwitchJava)) },
    // ---------- 内存 ----------
    Rule { id: "out-of-memory-heap", category: CrashCategory::Memory,
        pattern: r"(?i)OutOfMemoryError: Java heap space",
        conclusion: "内存不够用了",
        fix: Some(("把内存调大", FixKind::RaiseMemory)) },
    Rule { id: "out-of-memory-metaspace", category: CrashCategory::Memory,
        pattern: r"(?i)OutOfMemoryError: Metaspace",
        conclusion: "Mod 数量太多，类元数据区占满了",
        fix: Some(("把内存调大", FixKind::RaiseMemory)) },
    Rule { id: "gc-overhead", category: CrashCategory::Memory,
        pattern: r"(?i)GC overhead limit exceeded",
        conclusion: "内存几乎全部被占用，垃圾回收陷入空转",
        fix: Some(("把内存调大", FixKind::RaiseMemory)) },
    Rule { id: "memory-too-large", category: CrashCategory::Memory,
        pattern: r"(?i)Could not reserve enough space|Invalid maximum heap size|specified size exceeds",
        conclusion: "分配的内存超过了本机可用内存",
        fix: Some(("把内存调小", FixKind::LowerMemory)) },
    Rule { id: "native-oom", category: CrashCategory::Memory,
        pattern: r"(?i)OutOfMemoryError.*native|Cannot allocate memory",
        conclusion: "系统层面的内存不足（不是游戏堆内存）",
        fix: Some(("关掉其他占内存的程序", FixKind::LowerMemory)) },
    // ---------- Mod ----------
    Rule { id: "missing-dependency", category: CrashCategory::Mod,
        pattern: r"(?i)requires? [\w-]+.{0,40}(which is missing)?|Missing or unsupported mandatory dependencies|which is missing!",
        conclusion: "有 Mod 缺少前置包",
        fix: Some(("自动补装前置包", FixKind::DisableMod)) },
    Rule { id: "mod-mc-mismatch", category: CrashCategory::Mod,
        pattern: r"(?i)Incompatible mod set|is not compatible with|requires Minecraft",
        conclusion: "有 Mod 与当前游戏版本不匹配",
        fix: Some(("查看是哪个 Mod", FixKind::DisableMod)) },
    Rule { id: "mod-duplicate", category: CrashCategory::Mod,
        pattern: r"(?i)Duplicate mods|DuplicateModsFoundException|found a duplicate mod",
        conclusion: "装了两个同名或同 ID 的 Mod",
        fix: Some(("清理重复 Mod", FixKind::RemoveMod)) },
    Rule { id: "mod-crash-mixin", category: CrashCategory::Mod,
        pattern: r"(?i)Mixin apply failed|MixinTransformerError|spongepowered\.asm",
        conclusion: "某个 Mod 的注入代码与其他 Mod 冲突",
        fix: Some(("二分法排查 Mod", FixKind::DisableMod)) },
    Rule { id: "mod-conflict", category: CrashCategory::Mod,
        pattern: r"(?i)Conflicting mods|incompatible mod set",
        conclusion: "两个 Mod 互相冲突，无法同时加载",
        fix: Some(("查看冲突的两个 Mod", FixKind::DisableMod)) },
    Rule { id: "fabric-api-missing", category: CrashCategory::Mod,
        pattern: r"(?i)fabric-api|requires fabric",
        conclusion: "缺 Fabric API",
        fix: Some(("自动补装 Fabric API", FixKind::DisableMod)) },
    Rule { id: "optifine-conflict", category: CrashCategory::Mod,
        pattern: r"(?i)optifine.{0,20}(conflict|incompatible)|ClassNotFoundException: optifine",
        conclusion: "OptiFine 与当前加载器组合冲突",
        fix: Some(("关掉 OptiFine", FixKind::DisableOptifine)) },
    // ---------- 加载器 ----------
    Rule { id: "forge-install-corrupt", category: CrashCategory::Loader,
        pattern: r"(?i)Failed to find (the )?main class|net\.minecraftforge.*ClassNotFound",
        conclusion: "Forge 没有装完整",
        fix: Some(("重新安装加载器", FixKind::ReinstallLoader)) },
    Rule { id: "loader-version-mismatch", category: CrashCategory::Loader,
        pattern: r"(?i)LoaderException|incompatible loader version",
        conclusion: "加载器版本与 Mod 要求的不一致",
        fix: Some(("重新安装加载器", FixKind::ReinstallLoader)) },
    Rule { id: "mixin-loader", category: CrashCategory::Loader,
        pattern: r"(?i)MixinBootstrap|mixin.{0,20}loader.{0,20}failed",
        conclusion: "Mixin 框架加载失败，通常是加载器装得不完整",
        fix: Some(("重新安装加载器", FixKind::ReinstallLoader)) },
    // ---------- 图形 ----------
    Rule { id: "gpu-driver", category: CrashCategory::Graphics,
        /*
         * ★★ 2026-09-24（C-8）：原来是 `EXCEPTION_ACCESS_VIOLATION.*(nvoglv|atio|igd)` ——
         *   而 Rust 的 regex 与 JS 一样，`.` **不跨行**；真实崩溃日志里驱动名在下一行
         *   （`C  [nvoglv64.dll+0x…]`）⇒ 这条规则永远不会命中。
         *   改成 `[\s\S]{0,400}?`：跨行、但限定距离；与 TS 侧逐字同形
         *   （判据表见 tests/crash-rules.cases.json）。
         */
        pattern: r"(?i)EXCEPTION_ACCESS_VIOLATION[\s\S]{0,400}?(nvoglv|atio|igd)",
        conclusion: "显卡驱动崩溃了",
        fix: Some(("更新显卡驱动", FixKind::None)) },
    Rule { id: "glfw-error", category: CrashCategory::Graphics,
        pattern: r"(?i)GLFW error \d+|Failed to create (window|GL context)|Pixel format not accelerated",
        conclusion: "无法创建图形窗口，通常是显卡驱动过旧或缺少 OpenGL 支持",
        fix: Some(("更新显卡驱动", FixKind::None)) },
    Rule { id: "shader-compile", category: CrashCategory::Graphics,
        pattern: r"(?i)Shader compilation failed|Iris.{0,20}shader.{0,20}error",
        conclusion: "光影包编译失败",
        fix: Some(("换个光影包或关掉光影", FixKind::None)) },
    Rule { id: "context-lost", category: CrashCategory::Graphics,
        pattern: r"(?i)GL context lost|Graphics device lost|DXGI_ERROR_DEVICE",
        conclusion: "显卡上下文丢失（常见于驱动重启或显存不足）",
        fix: Some(("降低游戏内画质设置", FixKind::None)) },
    // ---------- 账号 ----------
    Rule { id: "auth-failed", category: CrashCategory::Account,
        pattern: r"(?i)InvalidCredentialsException|401 Unauthorized|Failed to (refresh|authenticate)|AuthenticationException",
        conclusion: "登录状态已失效",
        fix: Some(("重新登录", FixKind::Relogin)) },
    Rule { id: "auth-offline", category: CrashCategory::Account,
        pattern: r"(?i)Failed to verify username|UserNotAuthenticated|Invalid session",
        conclusion: "服务器拒绝了你的登录会话",
        fix: Some(("重新登录后再进服务器", FixKind::Relogin)) },
    // ---------- 文件 ----------
    Rule { id: "file-corrupt", category: CrashCategory::File,
        pattern: r"(?i)ZipException|invalid LOC header|zip END header not found",
        conclusion: "有文件损坏（多半是下载没完成）",
        fix: Some(("校验并修复文件", FixKind::VerifyFiles)) },
    Rule { id: "missing-file", category: CrashCategory::File,
        pattern: r"(?i)FileNotFoundException|NoSuchFileException|cannot find the file",
        conclusion: "缺少必需的文件",
        fix: Some(("校验并补全文件", FixKind::VerifyFiles)) },
    Rule { id: "permission-denied", category: CrashCategory::File,
        pattern: r"(?i)AccessDeniedException|Permission denied|拒绝访问",
        conclusion: "没有权限读写游戏目录",
        fix: Some(("把游戏目录换到有权限的位置", FixKind::OpenFolder)) },
    Rule { id: "path-too-long", category: CrashCategory::File,
        pattern: r"(?i)filename or extension is too long|path too long|文件名或扩展名太长",
        conclusion: "文件路径过长，Windows 默认限制 260 字符",
        fix: Some(("把游戏目录移到更浅的位置", FixKind::OpenFolder)) },
    Rule { id: "disk-full", category: CrashCategory::File,
        pattern: r"(?i)not enough space on the disk|No space left on device",
        conclusion: "磁盘空间不足",
        fix: Some(("清理磁盘空间", FixKind::None)) },
    // ---------- 环境 ----------
    Rule { id: "chinese-path", category: CrashCategory::Environment,
        pattern: r"(?i)URI has an authority component",
        conclusion: "游戏路径里有中文或特殊字符，Java 启动包装器处理不了",
        fix: Some(("把游戏目录改成纯英文路径", FixKind::OpenFolder)) },
    Rule { id: "antivirus", category: CrashCategory::Environment,
        pattern: r"(?i)being used by another process",
        conclusion: "文件被其他程序占用（多半是杀毒软件正在扫描）",
        fix: Some(("把游戏目录加入杀毒白名单", FixKind::OpenFolder)) },
    Rule { id: "firewall", category: CrashCategory::Environment,
        pattern: r"(?i)Connection refused|ConnectException|UnknownHostException",
        conclusion: "网络连接被拒绝或域名解析失败",
        fix: Some(("检查网络与代理设置", FixKind::None)) },
    Rule { id: "locale", category: CrashCategory::Environment,
        pattern: r"(?i)UnsupportedEncodingException|MalformedInputException",
        conclusion: "系统编码不是 UTF-8，导致文件读取失败",
        fix: Some(("把游戏目录改成纯英文路径", FixKind::OpenFolder)) },
];

#[derive(Debug, Clone, Serialize)]
pub struct CrashMatch {
    pub rule_id: String,
    pub category: CrashCategory,
    pub conclusion: String,
    pub excerpt: String,
}

/// 分析时的**环境事实**（决定哪些"日志特征"其实是必然出现的噪声）。
#[derive(Debug, Clone, Copy, Default)]
pub struct AnalyzeOptions {
    /// ★★ 这次启动用的是**离线身份**（没有正版令牌）。
    ///
    /// 离线时客户端连不上 Mojang 的验证服务，日志里**必然**出现
    /// `401 Unauthorized` / `Failed to verify username` 一类记录。
    /// 把它们当成"崩溃原因"就是一句假报告：用户看到"登录状态已失效，
    /// 请重新登录"，而他本来就是故意用离线身份玩的，重新登录也改变不了。
    ///
    /// 所以离线时这类命中会被标成 `benign_matches`（照实列出来、解释清楚），
    /// **不参与**"原因"的评选。
    pub offline: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct CrashAnalysis {
    /// 面向用户的原因（首屏第一条）
    pub reason: String,
    pub category: CrashCategory,
    /// **真正可疑**的命中（不含本环境必然出现的那些）
    pub matches: Vec<CrashMatch>,
    /// 本环境下**必然出现、与崩溃无关**的命中（离线启动的 401 等）。
    ///
    /// ★ 必须交出来而不是丢掉：用户自己滑日志时会看到那几行，
    ///   界面得能解释"这行我们看到了，它不是原因，因为……"。
    pub benign_matches: Vec<CrashMatch>,
    pub actions: Vec<SuggestedAction>,
    /// 是否用了启发式兜底（诚实告诉用户"我不确定"）
    pub heuristic: bool,
    pub rule_count: usize,
}

/// 类别优先级：内存/Java 这类"必然结论"排在 Mod 冲突这类"可能结论"之前
fn category_rank(c: CrashCategory) -> u8 {
    match c {
        CrashCategory::Java => 0,
        CrashCategory::Memory => 1,
        CrashCategory::Loader => 2,
        CrashCategory::Mod => 3,
        CrashCategory::File => 4,
        CrashCategory::Graphics => 5,
        CrashCategory::Account => 6,
        CrashCategory::Environment => 7,
        CrashCategory::Unknown => 8,
    }
}

pub fn analyze_crash_log(raw: &str) -> CrashAnalysis {
    analyze_crash_log_with(raw, AnalyzeOptions::default())
}

/// 同上，但带上**环境事实**（目前只有"是不是离线启动"）。
///
/// 分两个入口是为了不破坏既有调用点：不知道环境的地方传默认值（= 不排除
/// 任何东西），知道的地方（启动/停止路径）把事实传进来。
pub fn analyze_crash_log_with(raw: &str, opts: AnalyzeOptions) -> CrashAnalysis {
    let mut all: Vec<CrashMatch> = Vec::new();

    for rule in RULES {
        let Ok(re) = Regex::new(rule.pattern) else {
            continue;
        };
        if let Some(m) = re.find(raw) {
            let start = raw[..m.start()].char_indices().rev().nth(80).map(|(i, _)| i).unwrap_or(0);
            let end = raw[m.end()..]
                .char_indices()
                .nth(80)
                .map(|(i, _)| m.end() + i)
                .unwrap_or(raw.len());
            all.push(CrashMatch {
                rule_id: rule.id.to_string(),
                category: rule.category,
                conclusion: rule.conclusion.to_string(),
                excerpt: raw[start..end].trim().to_string(),
            });
        }
    }

    all.sort_by_key(|m| category_rank(m.category));

    /*
     * ★★ 拆成"可疑"与"本环境必然"两组（P0-6）。
     *
     *   离线启动时，日志里那句 `401 Unauthorized` 是**我们让它发生的** ——
     *   界面拿它当"崩溃原因"就等于把自己造成的结果报成故障。
     */
    let (benign_matches, matches): (Vec<CrashMatch>, Vec<CrashMatch>) = all
        .into_iter()
        .partition(|m| opts.offline && is_offline_noise(&m.rule_id));

    // 建议动作去重（只给"真正可疑"的那些建议 —— 否则用户会去重新登录）
    let mut actions: Vec<SuggestedAction> = Vec::new();
    for m in &matches {
        if let Some(rule) = RULES.iter().find(|r| r.id == m.rule_id) {
            if let Some((label, kind)) = rule.fix {
                if !actions.iter().any(|a| a.kind == kind) {
                    actions.push(SuggestedAction {
                        label: label.to_string(),
                        kind,
                    });
                }
            }
        }
    }

    if let Some(top) = matches.first() {
        return CrashAnalysis {
            reason: top.conclusion.clone(),
            category: top.category,
            matches,
            benign_matches,
            actions,
            heuristic: false,
            rule_count: RULES.len(),
        };
    }

    // ---------- 兜底：从堆栈里找线索 ----------
    let (reason, category, actions) = heuristic_guess(raw);
    CrashAnalysis {
        reason,
        category,
        matches: vec![],
        benign_matches,
        actions,
        heuristic: true,
        rule_count: RULES.len(),
    }
}

/// 这条命中是不是"**离线身份下必然出现**"的噪声。
///
/// 只有账号类的两条规则可能属于这一类（见 `AnalyzeOptions::offline`）。
pub fn is_offline_noise(rule_id: &str) -> bool {
    matches!(rule_id, "auth-failed" | "auth-offline")
}

fn heuristic_guess(text: &str) -> (String, CrashCategory, Vec<SuggestedAction>) {
    // 从堆栈里找非 Minecraft / 非 Java 的包名，那通常是肇事的 Mod
    let re = Regex::new(r"at\s+([a-z][\w.]*)\.[\w$]+\(").unwrap();
    let known = Regex::new(
        r"(?i)^(java|javax|jdk|sun|com\.mojang|net\.minecraft|org\.lwjgl|it\.unimi|org\.spongepowered|cpw\.mods|net\.minecraftforge|org\.apache|com\.google|net\.fabricmc)",
    )
    .unwrap();

    let mut found: Vec<String> = Vec::new();
    for cap in re.captures_iter(text) {
        let pkg = &cap[1];
        if known.is_match(pkg) {
            continue;
        }
        let root: String = pkg.split('.').take(2).collect::<Vec<_>>().join(".");
        if !found.contains(&root) {
            found.push(root);
        }
        if found.len() >= 3 {
            break;
        }
    }

    if !found.is_empty() {
        return (
            format!(
                "未能匹配到已知问题，但从堆栈看可能与 {} 有关",
                found.join("、")
            ),
            CrashCategory::Mod,
            vec![
                SuggestedAction {
                    label: "二分法排查 Mod".into(),
                    kind: FixKind::DisableMod,
                },
                SuggestedAction {
                    label: "打开日志所在目录".into(),
                    kind: FixKind::OpenFolder,
                },
            ],
        );
    }

    if Regex::new(r"(?i)Exception|Error|Caused by")
        .unwrap()
        .is_match(text)
    {
        return (
            "游戏异常退出，但日志里没有 IEML 能识别的特征".into(),
            CrashCategory::Unknown,
            vec![
                SuggestedAction {
                    label: "校验并修复文件".into(),
                    kind: FixKind::VerifyFiles,
                },
                SuggestedAction {
                    label: "打开日志所在目录".into(),
                    kind: FixKind::OpenFolder,
                },
            ],
        );
    }

    (
        "游戏进程结束但没有留下错误信息（可能是被强制结束或正常退出）".into(),
        CrashCategory::Unknown,
        vec![SuggestedAction {
            label: "打开日志所在目录".into(),
            kind: FixKind::OpenFolder,
        }],
    )
}

/* ====================== 「这次算不算崩溃」的唯一判据（P0-6） ====================== */

/// 秒退判定的时间上限：进程在这么短时间内退出、且日志几乎是空的，就不算正常退出。
///
/// ★ 常数的**唯一来源**在这里（`launch.rs` 与命令层都读它）——
///   以前它只写在 `launch.rs`，于是"停止游戏"那条路径压根没有这条判据。
pub const INSTANT_FAIL_SECS: u64 = 10;
/// 日志短于这个长度算"什么都没写出来"
pub const INSTANT_FAIL_LOG_BYTES: u64 = 64;

/// 游戏/ JVM **自己声明"我崩了"**的日志特征。
///
/// ## 为什么不能拿那 30 条"原因规则"当崩溃判据
///
///   原因规则是给**崩溃之后**的分析用的：它回答"崩在哪一类"。
///   拿它当"是不是崩了"的判据会出两种错：
///     · 假阳性：一局玩了两小时的正常退出，日志里也可能有
///       `FileNotFoundException`（某个可选资源没找到）→ 被判成崩溃；
///     · 假阴性：游戏以退出码 0 退出（Fabric 找不到游戏本体就是这样），
///       日志里一句"Missing or unsupported"却不算 Exception。
///
///   所以"崩没崩"用**退出码 + 游戏自己的崩溃声明**来判，
///   "崩在哪"才交给原因规则。两者分开，各说各的话。
const FATAL_MARKERS: &[&str] = &[
    // 原版/Forge/Fabric 写崩溃报告时都会留这几句
    r"(?i)The game crashed whilst",
    r"(?i)crash-reports[/\\]crash-",
    // JVM 自己崩了（hs_err_pid.log 那一类）
    r"(?i)A fatal error has been detected by the Java Runtime Environment",
    // 主线程直接抛到顶（"游戏没起来"最常见的那种）
    r#"(?i)Exception in thread "main""#,
    // Fabric / Quilt 的加载失败
    r"(?i)net\.fabricmc\.loader\.impl\.FormattedException",
    r"(?i)Failed to launch|Failed to start the game",
];

/// 日志里有没有"游戏自己声明崩溃"的痕迹。
pub fn log_declares_crash(raw: &str) -> bool {
    FATAL_MARKERS
        .iter()
        .any(|p| Regex::new(p).map(|re| re.is_match(raw)).unwrap_or(false))
}

/// 一次会话的**结束判据**（P0-6 的唯一实现）。
#[derive(Debug, Clone, Serialize)]
pub struct CrashVerdict {
    /// 这次算不算"崩溃退出"
    pub crashed: bool,
    /// 崩溃原因（面向用户；`crashed = false` 时为 `None`）
    pub reason: Option<String>,
    /// 命中的规则 id（日志分析给出的那个）
    pub rule_id: Option<String>,
    pub category: Option<CrashCategory>,
    /// 判定依据（一条一条写清"我凭什么这么说"）
    pub evidence: Vec<String>,
    /// 本环境下必然出现、**已排除**的命中（离线启动的 401 等）
    pub benign: Vec<CrashMatch>,
}

/// 判断一次游戏会话"算不算崩溃"。
///
/// ## 三条输入，缺一不可
///
///   ① `exit_code`：游戏自己退出的返回码（**用户主动停止时为 `None`** ——
///      taskkill 给的码不代表游戏出了什么事）；
///   ② `user_stopped`：是不是用户按了「停止游戏」；
///   ③ `log_text`：这次会话的日志（用来找"游戏自己声明崩溃"的痕迹）。
///
/// ## 为什么必须这么做（原来两条路径各判各的，结论互相打架）
///
///   · `launch::watch_game_exit`（游戏自己退出）**只看退出码**：
///     native 库加载失败时 JVM 退出码是 **0**，于是我们报"正常退出"，
///     用户看到"游戏启动了然后关了"，没有任何解释；
///   · `stop_minecraft`（点停止按钮）**只看日志规则**：离线启动的日志里
///     必然有 `401 Unauthorized`，于是点一下"停止"就弹出
///     「游戏异常退出 · 登录状态已失效」—— 一句凭空的假报告。
///
///   现在两条路径都调这里，判据只有一份。
pub fn judge_crash(
    exit_code: Option<i32>,
    user_stopped: bool,
    offline: bool,
    played_seconds: u64,
    log_bytes: u64,
    log_text: &str,
) -> CrashVerdict {
    let analysis = analyze_crash_log_with(log_text, AnalyzeOptions { offline });
    let declared = log_declares_crash(log_text);
    let instant_fail = played_seconds <= INSTANT_FAIL_SECS && log_bytes <= INSTANT_FAIL_LOG_BYTES;

    // ---------- ① 用户主动停止：这不是崩溃 ----------
    if user_stopped {
        return CrashVerdict {
            crashed: false,
            reason: None,
            rule_id: None,
            category: None,
            evidence: vec!["是你自己按的「停止游戏」，不算异常退出".into()],
            benign: analysis.benign_matches,
        };
    }

    /*
     * ---------- ② 崩没崩：只看退出码与游戏自己的声明 ----------
     *
     * ★ 退出码为 `None`（被信号杀死、或拿不到状态）时**不猜**：
     *   交给另外两条判据。
     */
    let code_bad = matches!(exit_code, Some(c) if c != 0);
    let crashed = instant_fail || declared || code_bad;

    // ---------- ③ 理由：优先用日志分析给出的"人话原因" ----------
    let mut evidence: Vec<String> = Vec::new();
    if instant_fail {
        evidence.push(format!(
            "进程在 {played_seconds} 秒内就退出了，而且日志只有 {log_bytes} 字节\
             （多半连 JVM 都没起来）"
        ));
    }
    if declared {
        evidence.push("日志里有游戏/JVM 自己写下的崩溃记录".into());
    }
    if let Some(c) = exit_code {
        if c != 0 {
            evidence.push(format!("游戏退出时返回了非零退出码 {c}"));
        }
    } else {
        evidence.push("拿不到退出码（进程被强制结束），没有用它下结论".into());
    }
    if !analysis.benign_matches.is_empty() {
        evidence.push(format!(
            "日志里有 {} 条「{}」—— 这是**离线启动必然出现**的，已排除",
            analysis.benign_matches.len(),
            analysis
                .benign_matches
                .iter()
                .map(|m| m.conclusion.clone())
                .collect::<Vec<_>>()
                .join("、")
        ));
    }

    if !crashed {
        return CrashVerdict {
            crashed: false,
            reason: None,
            rule_id: None,
            category: None,
            evidence,
            benign: analysis.benign_matches,
        };
    }

    let (reason, rule_id, category) = match analysis.matches.first() {
        Some(m) => (
            m.conclusion.clone(),
            Some(m.rule_id.clone()),
            Some(m.category),
        ),
        None => {
            // 没匹配到已知特征：**如实说我认不出**，而不是编一个类别
            let reason = if instant_fail {
                format!(
                    "游戏刚启动就退出了（{played_seconds} 秒，日志几乎为空）—— \
                     常见原因是本地库（natives）不完整、Java 版本不对或游戏文件缺失"
                )
            } else if declared {
                "游戏自己写了崩溃记录，但 IEML 没能从日志里认出具体原因".to_string()
            } else {
                format!(
                    "游戏以非零退出码 {} 结束，日志里没有 IEML 能识别的特征",
                    exit_code.unwrap_or(-1)
                )
            };
            (reason, None, None)
        }
    };

    CrashVerdict {
        crashed: true,
        reason: Some(reason),
        rule_id,
        category,
        evidence,
        benign: analysis.benign_matches,
    }
}

/*
 * ★ 2026-09-24（死代码清理）：Rust 侧的 `redact_report` / `RedactionEntry` /
 *   `RedactionResult` 删掉了。理由：**活的脱敏在 TS 那一侧**
 *   （`src/domain/crash.ts::redactReport`，被日志页与崩溃弹窗用），
 *   Rust 这份的**唯一**调用方是 `commands::redact_report` 命令，
 *   而那个命令全仓库 0 处调用（`bridge/tauri.ts` 的 `rust` 对象也一起删了）。
 *   两份实现留着只会像崩溃规则表那样慢慢漂移 —— 判据/实现都只留一处。
 */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rule_count_is_substantial() {
        assert!(RULES.len() >= 30, "规则只有 {} 条", RULES.len());
    }

    #[test]
    fn detects_missing_dependency() {
        let log = "[13:42:15] [main/WARN]:  - Mod 'Better Combat' (bettercombat) 1.8.6 requires any version of player-animator, which is missing!";
        let a = analyze_crash_log(log);
        assert!(!a.heuristic);
        assert!(a.reason.contains("前置包"), "{}", a.reason);
        assert!(!a.actions.is_empty());
    }

    #[test]
    fn first_screen_is_conclusion_not_stacktrace() {
        let log = "java.lang.OutOfMemoryError: Java heap space\n\tat net.minecraft.Foo.bar(Foo.java:1)";
        let a = analyze_crash_log(log);
        assert_eq!(a.category, CrashCategory::Memory);
        assert!(!a.reason.contains("at net.minecraft"), "{}", a.reason);
        assert!(a.actions.iter().any(|x| x.kind == FixKind::RaiseMemory));
    }

    #[test]
    fn each_category_hits() {
        let cases = [
            (CrashCategory::Java, "java.lang.UnsupportedClassVersionError: class file version 65.0"),
            (CrashCategory::Memory, "java.lang.OutOfMemoryError: Java heap space"),
            (CrashCategory::Mod, "DuplicateModsFoundException: found a duplicate mod"),
            (CrashCategory::Graphics, "EXCEPTION_ACCESS_VIOLATION in nvoglv64.dll"),
            (CrashCategory::Account, "InvalidCredentialsException: 401 Unauthorized"),
            (CrashCategory::File, "java.util.zip.ZipException: invalid LOC header"),
            (CrashCategory::Environment, "java.net.ConnectException: Connection refused"),
        ];
        for (expected, log) in cases {
            let a = analyze_crash_log(log);
            assert_eq!(a.category, expected, "日志: {log}");
        }
    }

    #[test]
    fn heuristic_fallback_names_suspects() {
        let log = "java.lang.RuntimeException: boom\n\tat com.example.mymod.Thing.run(Thing.java:10)";
        let a = analyze_crash_log(log);
        assert!(a.heuristic);
        assert!(a.reason.contains("com.example"), "{}", a.reason);
    }

    /* ====================== P0-6：崩溃判据 ====================== */

    /// 离线启动的日志：游戏连不上验证服务，日志里**必然**有这一行。
    ///   （真实形态：`[Render thread/INFO]: Failed to verify username!` 或
    ///    客户端自己打的 `401 Unauthorized`。）
    const OFFLINE_LOG: &str = "[Render thread/INFO]: Setting user: Player\n\
         [Render thread/WARN]: Failed to verify username!\n\
         [Render thread/WARN]: com.mojang.authlib.exceptions.AuthenticationException: 401 Unauthorized\n\
         [Render thread/INFO]: Stopping!\n";

    /// ★★ 离线启动 + 用户自己点「停止游戏」→ **不是崩溃**。
    ///
    ///   这就是那句假报告的形状：老 `stop_minecraft` 只看日志规则，
    ///   命中 `auth-failed` 就 `crashed = true`，于是用户点一下停止，
    ///   界面弹「游戏异常退出 · 登录状态已失效」——
    ///   而那句 401 是**我们自己用离线身份启动**造成的必然现象。
    #[test]
    fn offline_session_stopped_by_user_is_not_a_crash() {
        let v = judge_crash(None, true, true, 600, OFFLINE_LOG.len() as u64, OFFLINE_LOG);
        assert!(!v.crashed, "用户按的停止不算崩溃：{:?}", v.reason);
        assert!(v.reason.is_none());
        assert!(
            v.benign.iter().any(|m| m.rule_id == "auth-failed"),
            "那条 401 要被**排除**并如实列出来（而不是当成原因）：{:?}",
            v.benign
        );
    }

    /// ★★ 离线启动 + 游戏**自己**以非零码退出 → 算崩溃，但原因**不是**那句 401。
    #[test]
    fn offline_crash_reason_is_not_the_inevitable_401() {
        let log = format!(
            "java.lang.OutOfMemoryError: Java heap space\n\tat net.minecraft.Foo.bar(Foo.java:1)\n{OFFLINE_LOG}"
        );
        let v = judge_crash(Some(1), false, true, 120, log.len() as u64, &log);
        assert!(v.crashed);
        let reason = v.reason.unwrap();
        assert!(reason.contains("内存"), "原因该是内存，而不是登录：{reason}");
        assert!(!reason.contains("登录"), "{reason}");
        assert!(
            v.benign.iter().any(|m| m.rule_id == "auth-failed"),
            "只排除了 401，内存那条还在：{:?}",
            v.benign
        );
    }

    /// ★ **正版**身份下同一条日志仍然是"登录状态已失效" —— 排除只对离线成立。
    #[test]
    fn online_session_keeps_the_auth_match() {
        let log = "com.mojang.authlib.exceptions.InvalidCredentialsException: 401 Unauthorized";
        let a = analyze_crash_log_with(log, AnalyzeOptions { offline: false });
        assert_eq!(a.category, CrashCategory::Account);
        assert!(a.benign_matches.is_empty(), "正版下不许排除：{:?}", a.benign_matches);
    }

    /// 默认入口（不知道环境）行为不变 —— 既有调用点与测试不受影响。
    #[test]
    fn default_analysis_never_excludes_anything() {
        let a = analyze_crash_log("InvalidCredentialsException: 401 Unauthorized");
        assert!(a.benign_matches.is_empty());
        assert_eq!(a.category, CrashCategory::Account);
    }

    /// ★★ 退出码 0 但**游戏自己写了崩溃记录** → 也算崩溃。
    ///
    ///   实测形态：native 库加载失败时 JVM 退出码是 0；Fabric 找不到游戏本体
    ///   时也是 0。老判据（只看退出码）在这些情况下报"正常退出"。
    #[test]
    fn self_declared_crash_counts_even_with_exit_code_zero() {
        let log = "[Render thread/ERROR]: The game crashed whilst initializing game\n\
             java.lang.UnsatisfiedLinkError: Failed to locate library: lwjgl.dll";
        let v = judge_crash(Some(0), false, false, 900, log.len() as u64, log);
        assert!(v.crashed, "游戏自己说崩了，就不能报「正常退出」");
        assert!(v.evidence.iter().any(|e| e.contains("崩溃记录")), "{:?}", v.evidence);
    }

    /// 玩了两小时、正常退出、日志里却有"缺文件"这类噪声 → **不算崩溃**。
    ///
    ///   这一条防的是另一种假报告：把正常的一局报成崩溃。
    #[test]
    fn normal_long_session_is_not_a_crash() {
        let log = "[Render thread/WARN]: FileNotFoundException: options.txt\n\
             [Render thread/INFO]: Stopping!";
        let v = judge_crash(Some(0), false, false, 7200, log.len() as u64, log);
        assert!(!v.crashed, "长会话 + 退出码 0 → 不是崩溃：{:?}", v.reason);
    }

    /// 秒退（几秒内退出 + 日志几乎为空）→ 崩溃，理由要指向"启动失败"而不是编类别。
    #[test]
    fn instant_failure_is_reported_as_a_crash() {
        let v = judge_crash(Some(0), false, false, 2, 5, "abc");
        assert!(v.crashed);
        let reason = v.reason.unwrap();
        assert!(reason.contains("刚启动就退出"), "{reason}");
        assert!(v.evidence.iter().any(|e| e.contains("秒内")), "{:?}", v.evidence);
    }

    /// 拿不到退出码（被信号杀死 / 进程状态读不到）时**不许猜**：
    ///   没有其它证据就不能说"崩溃"，也不许编一个退出码出来。
    #[test]
    fn missing_exit_code_is_not_treated_as_a_failure() {
        let v = judge_crash(None, false, false, 300, 5000, "[INFO]: Stopping!");
        assert!(!v.crashed, "没有证据就不下结论：{:?}", v.reason);
        assert!(
            v.evidence.iter().any(|e| e.contains("拿不到退出码")),
            "但要把这件事说出来：{:?}",
            v.evidence
        );
    }

    /// 非零退出码 + 认不出的日志 → 仍然算崩溃，并**如实说认不出**。
    #[test]
    fn unknown_failure_reports_honestly() {
        let v = judge_crash(Some(1), false, false, 60, 200, "[INFO]: Stopping!");
        assert!(v.crashed);
        let reason = v.reason.unwrap();
        assert!(reason.contains("非零退出码 1"), "{reason}");
        assert!(v.rule_id.is_none(), "没命中规则就不许编一个 id");
    }

    /*
     * ====================== ★★ C-8：两侧规则表的一致性 ======================
     *
     * 规则有两份实现：这一份（被 `judge_crash` 用，也就是游戏退出那条 toast 的判据）
     * 与 TS 的 `src/domain/crash.ts`（被崩溃弹窗与日志页用）。
     *
     * 它们**曾经漂移而没有任何判据能发现**：36 条 vs 35 条、12 条 id 起名不同
     * （TS `out-of-memory-heap` / 这边 `oom-heap` …）。
     *
     * 现在两边读**同一份判据表** `tests/crash-rules.cases.json`：
     * 同一段日志必须判出同一个 rule id。哪一边改了规则没改另一边，
     * 就会有一边的测试红 —— TS 侧那条在 `tests/crash-rules.test.mjs`。
     */
    #[derive(serde::Deserialize)]
    struct CaseFile {
        cases: Vec<Case>,
    }
    #[derive(serde::Deserialize)]
    struct Case {
        rule: String,
        log: String,
    }

    #[test]
    fn crash_rules_cases_match_both_sides() {
        const RAW: &str = include_str!("../../../tests/crash-rules.cases.json");
        let file: CaseFile = serde_json::from_str(RAW).expect("判据表要能解析");
        assert!(!file.cases.is_empty(), "判据表不能是空的");

        let mut bad: Vec<String> = Vec::new();
        for c in &file.cases {
            let a = analyze_crash_log_with(&c.log, AnalyzeOptions { offline: false });
            let got: Vec<String> = a
                .matches
                .iter()
                .chain(a.benign_matches.iter())
                .map(|m| m.rule_id.clone())
                .collect();
            if !got.iter().any(|g| g == &c.rule) {
                bad.push(format!("{} → 实际 [{}]", c.rule, got.join(", ")));
            }
        }
        assert!(
            bad.is_empty(),
            "这些日志片段 Rust 侧判错了（说明两份规则表漂移了）：\n    {}",
            bad.join("\n    ")
        );
    }

    /// 判据表里允许"只在一边有"的例外，必须真的只在这边缺/那边有。
    #[test]
    fn only_one_side_rules_are_documented() {
        const RAW: &str = include_str!("../../../tests/crash-rules.cases.json");
        let v: serde_json::Value = serde_json::from_str(RAW).unwrap();
        let only = v.get("only").and_then(|o| o.as_object());
        let ids: Vec<&str> = RULES.iter().map(|r| r.id).collect();
        if let Some(only) = only {
            for (id, why) in only {
                assert!(
                    !ids.contains(&id.as_str()),
                    "「{id}」现在两边都有了 —— 请把它从判据表的 only 里删掉"
                );
                assert!(
                    why.as_str().map(|s| s.len() > 10).unwrap_or(false),
                    "「{id}」的例外必须写清原因"
                );
            }
        }
    }
}
