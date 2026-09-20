//! 启动参数拼装（真实的 Minecraft 命令行）
//!
//! 这是"能启动"最关键的一步。规则（都是实测踩出来的）：
//!
//!   ① **参数模板**：`arguments.game` / `arguments.jvm` 是数组，元素要么是字符串，
//!      要么是 `{ "rules": [...], "value": "..." | ["..."] }` 对象。规则要按平台过滤。
//!   ② **占位符替换**：`${auth_player_name}` / `${version_name}` / `${game_directory}` /
//!      `${assets_root}` / `${assets_index_name}` / `${auth_uuid}` / `${auth_access_token}` /
//!      `${user_type}` / `${version_type}` / `${natives_directory}` / `${launcher_name}` /
//!      `${launcher_version}` / `${classpath}` / `${classpath_separator}` / `${library_directory}`
//!   ③ **JVM 参数必须先于主类**，游戏参数在主类之后。
//!   ④ **classpath 用 `;` 分隔（Windows）或 `:`（Unix）** —— 写错直接起不来。
//!   ⑤ **natives 目录必须在 JVM 参数里给**（`-Djava.library.path`）。
//!   ⑥ **离线账号的令牌是占位符**：`0` 而不是空串，uuid 要是符合格式的假 UUID。
//!   ⑦ **窗口尺寸与内存**：`--width` / `--height` 与 `-Xmx`。
//!   ⑧ **旧版本（1.12 及以前）用 `minecraftArguments` 单字符串**，需要按空格拆。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// 账号信息（正版或离线）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Account {
    pub username: String,
    /// 去掉横线的 32 位 hex
    pub uuid: String,
    /// 正版是真实的 access token；离线是 "0"
    pub access_token: String,
    /// "msa"（正版）或 "legacy"（离线）
    pub user_type: String,
    /// "msa" / "mojang" / "legacy"
    pub user_properties: String,
}

impl Account {
    /// 离线账号：uuid 用名字的 MD5 变体（Minecraft 离线模式就是这么算的）
    pub fn offline(username: &str) -> Self {
        Self {
            username: username.to_string(),
            uuid: offline_uuid(username),
            access_token: "0".to_string(),
            user_type: "legacy".to_string(),
            user_properties: "{}".to_string(),
        }
    }

    /// ★★ 这次启动用的是不是**离线身份**（判据的唯一定义）。
    ///
    /// 为什么要有这个方法（P0-6）：离线时游戏连不上 Mojang 的验证服务，
    /// 日志里**必然**出现 `401 Unauthorized` 一类记录 —— 崩溃判据必须知道
    /// 这件事，否则会把"我们自己造成的现象"报成故障。
    ///
    /// 判据取"令牌是占位符 `0`（或空）**或** `user_type` 不是 `msa`"：
    /// 官方 Yggdrasil 的 `accessToken` 不可能是空串或 `0`，
    /// 所以这两条都不会把正版误判成离线（误判的代价更大：真的 token 失效
    /// 时我们会说"这是离线必然现象"，把真问题盖掉）。
    pub fn is_offline(&self) -> bool {
        let token = self.access_token.trim();
        token.is_empty() || token == "0" || self.user_type != "msa"
    }
}

/// 离线模式的 UUID：`OfflinePlayer:<name>` 的 MD5，再按 Java 的 UUID.nameUUIDFromBytes 规则
/// 把第 7 字节高 4 位置为 3、第 9 字节高 2 位置为 8。
pub fn offline_uuid(username: &str) -> String {
    let input = format!("OfflinePlayer:{username}");
    let digest = md5_bytes(input.as_bytes());
    let mut b = digest;
    b[6] = (b[6] & 0x0f) | 0x30; // version 3
    b[8] = (b[8] & 0x3f) | 0x80; // variant
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// 最小 MD5 实现（只为离线 UUID，不值得为它引一个依赖）
fn md5_bytes(input: &[u8]) -> [u8; 16] {
    const S: [u32; 64] = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5,
        9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10,
        15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
    ];
    let mut k = [0u32; 64];
    for (i, item) in k.iter_mut().enumerate() {
        *item = ((i as f64 + 1.0).sin().abs() * 4294967296.0) as u32;
    }

    let mut a0: u32 = 0x67452301;
    let mut b0: u32 = 0xefcdab89;
    let mut c0: u32 = 0x98badcfe;
    let mut d0: u32 = 0x10325476;

    let mut msg = input.to_vec();
    let bit_len = (input.len() as u64).wrapping_mul(8);
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_le_bytes());

    for chunk in msg.chunks(64) {
        let mut m = [0u32; 16];
        for (i, item) in m.iter_mut().enumerate() {
            *item = u32::from_le_bytes([
                chunk[i * 4],
                chunk[i * 4 + 1],
                chunk[i * 4 + 2],
                chunk[i * 4 + 3],
            ]);
        }
        let (mut a, mut b, mut c, mut d) = (a0, b0, c0, d0);
        for i in 0..64 {
            let (f, g) = match i {
                0..=15 => ((b & c) | (!b & d), i),
                16..=31 => ((d & b) | (!d & c), (5 * i + 1) % 16),
                32..=47 => (b ^ c ^ d, (3 * i + 5) % 16),
                _ => (c ^ (b | !d), (7 * i) % 16),
            };
            let f2 = f
                .wrapping_add(a)
                .wrapping_add(k[i])
                .wrapping_add(m[g]);
            a = d;
            d = c;
            c = b;
            b = b.wrapping_add(f2.rotate_left(S[i]));
        }
        a0 = a0.wrapping_add(a);
        b0 = b0.wrapping_add(b);
        c0 = c0.wrapping_add(c);
        d0 = d0.wrapping_add(d);
    }

    let mut out = [0u8; 16];
    out[0..4].copy_from_slice(&a0.to_le_bytes());
    out[4..8].copy_from_slice(&b0.to_le_bytes());
    out[8..12].copy_from_slice(&c0.to_le_bytes());
    out[12..16].copy_from_slice(&d0.to_le_bytes());
    out
}

/* ====================== 参数模板求值 ====================== */

/// 求值一个参数元素（字符串或带 rules 的对象）
fn eval_arg_element(
    el: &serde_json::Value,
    features: &HashMap<String, bool>,
) -> Vec<String> {
    match el {
        serde_json::Value::String(s) => vec![s.clone()],
        serde_json::Value::Object(o) => {
            // 有 rules 时要判断
            if let Some(rules_val) = o.get("rules") {
                if let Ok(rules) = serde_json::from_value::<Vec<crate::net::metadata::Rule>>(rules_val.clone()) {
                    if !crate::net::metadata::rules_allow(&rules, features) {
                        return vec![];
                    }
                }
            }
            match o.get("value") {
                Some(serde_json::Value::String(s)) => vec![s.clone()],
                Some(serde_json::Value::Array(a)) => a
                    .iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect(),
                _ => vec![],
            }
        }
        _ => vec![],
    }
}

/// 把参数数组求值成字符串列表（含平台规则过滤）
pub fn eval_args(
    args: &[serde_json::Value],
    features: &HashMap<String, bool>,
) -> Vec<String> {
    args.iter().flat_map(|el| eval_arg_element(el, features)).collect()
}

/// 模板占位符替换
pub fn substitute(template: &str, vars: &HashMap<String, String>) -> String {
    let mut out = template.to_string();
    for (k, v) in vars {
        out = out.replace(&format!("${{{k}}}"), v);
    }
    out
}

/* ====================== 启动规格 ====================== */

#[derive(Debug, Clone)]
pub struct LaunchSpec {
    pub java: PathBuf,
    pub main_class: String,
    /// classpath 条目（**顺序重要**：客户端 jar 与加载器库在前）
    pub classpath: Vec<PathBuf>,
    pub natives_dir: PathBuf,
    /// ★★ **共享库根目录**（`shared/libraries`），`${library_directory}` 取它。
    ///
    /// 为什么要显式传进来（改掉一处真会出错的推导）：
    ///   原来这里是拿 `classpath.first()` 往上数四层反推的 ——
    ///   `libraries/<group>/<artifact>/<version>/<file>.jar` 的祖先第 4 层
    ///   恰好是 `libraries`。这条推导对**标准 Maven 布局**成立，但：
    ///     · classpath 的**第一项不保证**是库：调用方可能把客户端 jar、
    ///       甚至 Forge 的本地生成 jar 排在最前（本项目的 `scan_classpath`
    ///       先放库、再补 jar，但那是调用方的顺序，不是契约）；
    ///     · 库的坐标层级**不是恒定的**：`net/minecraftforge/forge/1.20.1-47.2.0/…`
    ///       是 4 层，而 Forge 安装器还会写出 `…/forge/1.20.1-47.2.0/forge-…-client.jar`
    ///       之外的 `libraries/net/minecraft/…` 等不同深度；多一层少一层，
    ///       `nth(4)` 就指到别的目录上去了；
    ///     · classpath 为空时它返回**空串** —— `${library_directory}` 变成空，
    ///       Forge 的 `-DlibraryDirectory=` 直接指到工作目录。
    ///   这些情况下游戏报的是"找不到某个库"，而根因在启动器拼的变量上。
    ///
    ///   所以改成**调用方（`prepare_spec`）把 `shared/libraries` 直接给它**：
    ///   那是它自己的路径，不需要从 classpath 里猜。
    pub libraries_dir: PathBuf,
    pub game_dir: PathBuf,
    pub assets_root: PathBuf,
    pub asset_index_name: String,
    pub version_name: String,
    pub version_type: String,
    pub account: Account,
    pub memory_mb: u64,
    pub width: u32,
    pub height: u32,
    /// 来自版本 JSON 的 jvm 参数模板
    pub jvm_args_template: Vec<serde_json::Value>,
    /// 来自版本 JSON 的 game 参数模板
    pub game_args_template: Vec<serde_json::Value>,
    /// 旧格式（1.12 及以前）的 minecraftArguments
    pub legacy_arguments: Option<String>,
    /// 用户额外追加的 JVM 参数
    pub extra_jvm_args: Vec<String>,
    /// 用户额外追加的游戏参数
    pub extra_game_args: Vec<String>,
    /// 自定义窗口标题（`None` = 用游戏默认的）
    ///
    /// ★ 审计补：以前前端能设、能存，但**传不到这里**，所以永远不生效。
    pub window_title: Option<String>,
    /// 启动后自动进入的服务器地址（`--server` / `--port`）
    ///
    /// ★ 源码事实（研读第 13.4 节）：PCL2 的"启动时自动进入服务器"，
    ///   并且在输入框里自动把全角标点换成半角 —— 中文输入法下
    ///   `host：25565` 是极自然的手误，而游戏只认半角。
    pub join_server: Option<String>,
    /// ★★ 启动时的**账号告警**（`None` = 一切正常）。
    ///
    /// 典型场景：正版 access token 过期、`refresh_token` 续期又失败 ——
    /// 这时仍然会用**离线身份**启动（单机不受影响），但必须让用户知道：
    /// 他拿着一个离线身份去连正版服务器只会被拒，而界面此前一个字都没说。
    ///
    /// ★ 为什么放在 spec 里：`prepare_spec` 是判定的地方，界面是呈现的地方，
    ///   中间只有这一个结构体。写在日志里等于没写（用户不会去看日志）。
    pub notice: Option<String>,
}

/// 这个 MC 版本支持 `--title` 吗？
///
/// Minecraft **1.14** 起客户端才接受 `--title <文本>`（官方启动器的
/// profile 就是这么带自定义标题的）。更早的版本没有这个参数。
/// 快照按年份判断（`24w45a` 这种一律算新版本，支持）。
///
/// 解析不出来（比如自定义版本名）时**返回 true**：宁可多传一个参数
/// （1.14+ 会正常用、老版本最多忽略），也不要让用户设了标题却没反应 ——
/// 这条取舍是按"用户的预期"选的。
pub fn supports_custom_window_title(version_name: &str) -> bool {
    // 快照（24w45a / 1.20.5-pre1 之类）→ 都远晚于 1.14
    if version_name.contains('w') || version_name.contains("pre") || version_name.contains("rc") {
        return true;
    }
    let segs: Vec<u32> = version_name
        .split('.')
        .filter_map(|s| s.split('-').next()?.parse::<u32>().ok())
        .collect();
    match (segs.first(), segs.get(1)) {
        // 2x.x（26.1 这种新版本号）→ 支持
        (Some(major), _) if *major >= 2 => true,
        (Some(1), Some(minor)) => *minor >= 14,
        // 解析不出来 → 按支持处理（见上面的说明）
        _ => true,
    }
}

/* ====================== 服务器地址 ====================== */

/// 清洗后的服务器地址（`host` + 可选 `port`）。
///
/// 与前端 `src/domain/server-address.ts` **同一套规则**（ADR-001）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerAddress {
    pub host: String,
    pub port: Option<u16>,
}

/// 全角 → 半角（只处理中文输入法会打出来的那批字符）。
///
/// ★ 为什么要有这一步（源码研读第 13.4 节）：PCL2 在服务器地址输入框的
///   `TextChanged` 里自动替换全角标点。中文输入法下 `mc.example.com：25565`
///   是极其自然的手误，而游戏只认半角冒号 —— 报错信息里地址看起来
///   一模一样，用户完全不知道为什么连不上。
fn to_half_width(text: &str) -> String {
    text.chars()
        .map(|c| match c as u32 {
            // 全角空格
            0x3000 => ' ',
            // 中文句号：地址里被误用成点
            0x3002 => '.',
            // ！＂＃…～ → ASCII
            c @ 0xff01..=0xff5e => char::from_u32(c - 0xfee0).unwrap_or('?'),
            _ => c,
        })
        .collect()
}

/// 解析用户输入的服务器地址。返回 `None` 表示**没有设置**（空输入）。
///
/// 容错顺序与前端完全一致：全角→半角 → 去协议 → 去路径 → 按**最后一个**
/// 冒号拆端口（域名里没有冒号，IPv6 里全是冒号，按最后一个拆是唯一
/// 能同时照顾两者的做法）。
///
/// ★ 端口写坏时**保留主机名、丢掉端口**，不猜也不改成别的：
///   宁可让游戏连默认端口，也不要悄悄换一个我们以为对的目标。
///   （前端会在输入框旁边明确提示"端口不是数字，不会自动改成默认端口"。）
pub fn parse_server_address(raw: &str) -> Option<ServerAddress> {
    let mut text = to_half_width(raw).trim().to_string();

    // 协议前缀（有人粘 `https://host:port`）
    if let Some(idx) = text.find("://") {
        let head = &text[..idx];
        if !head.is_empty() && head.chars().all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '.' || c == '-') {
            text = text[idx + 3..].to_string();
        }
    }
    // 路径 / 查询 / 片段
    if let Some(idx) = text.find(['/', '?', '#']) {
        text.truncate(idx);
    }
    let text = text.trim().to_string();
    if text.is_empty() {
        return None;
    }

    match text.rfind(':') {
        None => Some(ServerAddress {
            host: text,
            port: None,
        }),
        Some(idx) => {
            let host = text[..idx].trim().to_string();
            let port_text = text[idx + 1..].trim();
            // 主机名为空 → 整个地址不可用（`":25565"` 这种）
            if host.is_empty() {
                return None;
            }
            match port_text.parse::<u16>() {
                Ok(p) if p > 0 => Some(ServerAddress {
                    host,
                    port: Some(p),
                }),
                // 端口写坏了：保留主机名，端口交给游戏用默认值
                _ => Some(ServerAddress { host, port: None }),
            }
        }
    }
}

/// 分隔符：Windows 用 ; 其它用 :
pub fn classpath_separator() -> &'static str {
    if cfg!(windows) {
        ";"
    } else {
        ":"
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct BuiltCommand {
    pub program: String,
    pub args: Vec<String>,
    /// 给用户看的摘要（**不含令牌**）
    pub summary: String,
    /// 完整命令行（**已脱敏**，可直接入日志）
    pub debug_line: String,
}

/// 拼装完整启动命令。
pub fn build_command(spec: &LaunchSpec) -> BuiltCommand {
    let sep = classpath_separator();

    // ---------- natives 目录必须在 JVM 参数之前可用 ----------
    let classpath_str = spec
        .classpath
        .iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join(sep);

    let library_dir = spec.libraries_dir.to_string_lossy().to_string();
    if library_dir.is_empty() {
        // 空串会把 `-DlibraryDirectory=` 指到工作目录：宁可说出来
        say!(
            "[IEML/launch] 警告：共享库根目录为空，${{library_directory}} 会是空串\
             —— 装了 Forge 的版本会因此找不到库"
        );
    }

    let vars: HashMap<String, String> = HashMap::from([
        ("natives_directory".into(), spec.natives_dir.to_string_lossy().to_string()),
        ("launcher_name".into(), "IEML".into()),
        ("launcher_version".into(), env!("CARGO_PKG_VERSION").into()),
        ("classpath".into(), classpath_str.clone()),
        ("classpath_separator".into(), sep.to_string()),
        ("library_directory".into(), library_dir),
        ("auth_player_name".into(), spec.account.username.clone()),
        ("version_name".into(), spec.version_name.clone()),
        ("game_directory".into(), spec.game_dir.to_string_lossy().to_string()),
        ("assets_root".into(), spec.assets_root.to_string_lossy().to_string()),
        ("assets_index_name".into(), spec.asset_index_name.clone()),
        ("auth_uuid".into(), spec.account.uuid.clone()),
        ("auth_access_token".into(), spec.account.access_token.clone()),
        ("auth_session".into(), spec.account.access_token.clone()),
        ("user_type".into(), spec.account.user_type.clone()),
        ("version_type".into(), spec.version_type.clone()),
        ("user_properties".into(), spec.account.user_properties.clone()),
        ("game_assets".into(), spec.assets_root.to_string_lossy().to_string()),
        ("resolution_width".into(), spec.width.to_string()),
        ("resolution_height".into(), spec.height.to_string()),
        ("clientid".into(), String::new()),
        ("auth_xuid".into(), String::new()),
    ]);

    let features: HashMap<String, bool> = HashMap::from([
        ("is_demo_user".into(), false),
        ("has_custom_resolution".into(), true),
        ("has_quick_plays_support".into(), false),
        ("is_quick_play_singleplayer".into(), false),
        ("is_quick_play_multiplayer".into(), false),
        ("is_quick_play_realms".into(), false),
    ]);

    let mut args: Vec<String> = Vec::new();

    /* ---------- JVM 参数 ---------- */
    /*
     * ★★ **第一件事**：让 JVM 忽略它不认识的 `-XX:` 选项。
     *
     *   用户报的「Forge 版 mc 还没打开就报错崩溃」现场只有三行：
     *     `Error: Could not create the Java Virtual Machine.`
     *     `Error: A fatal exception has occurred. Program will exit.`
     *     `Unrecognized VM option 'UseCompactObjectHeaders'`
     *   而 `UseCompactObjectHeaders` 是 **Java 24** 才有的选项 ——
     *   Forge 65.1.3 的 profile 里写着它，我们却拿了 Java 21 去启动。
     *
     *   根因（Java 版本选错）已经在 `resolve_java_requirement` 里修了。
     *   但这里再加一道**保险**，因为这类崩溃的代价特别大：
     *   它发生在 JVM 初始化阶段，**游戏一行日志都写不出来** ——
     *   用户看到的是一个空日志加一个退出码，完全没有线索。
     *
     *   为什么这道保险是对的而不是掩盖问题：
     *     · `-XX:+IgnoreUnrecognizedVMOptions` 是 JVM 官方提供的开关，
     *       语义就是"不认识就跳过"，PCL 等启动器也依赖同类机制；
     *     · 它**只影响 `-XX:` 选项**，不会放过真正致命的错误
     *       （classpath 错、主类找不到、内存过大等照样正常报错）；
     *     · 被忽略的是"这个 Java 版本不认识这个调优开关"——
     *       少一个调优开关最多是性能差一点，比"游戏打不开"好得多。
     *
     *   必须放在**最前面**：JVM 按顺序解析，放在后面就来不及了。
     */
    args.push("-XX:+IgnoreUnrecognizedVMOptions".into());
    // 再给内存（保证用户设置生效，不被模板里的 -Xmx 覆盖）
    args.push(format!("-Xmx{}M", spec.memory_mb));
    args.push(format!("-Xms{}M", (spec.memory_mb / 2).max(512)));

    // 模板里的 jvm 参数
    let mut jvm_from_template = eval_args(&spec.jvm_args_template, &features);
    // 补上 natives 与 classpath（现代版本 JSON 里已有，但老版本没有）
    let has_library_path = jvm_from_template
        .iter()
        .any(|a| a.contains("java.library.path"));
    if !has_library_path {
        jvm_from_template.push(format!(
            "-Djava.library.path={}",
            spec.natives_dir.to_string_lossy()
        ));
    }
    let has_classpath = jvm_from_template.iter().any(|a| a == "-cp" || a == "-classpath");
    if !has_classpath {
        jvm_from_template.push("-cp".into());
        jvm_from_template.push(classpath_str.clone());
    }

    for a in &jvm_from_template {
        args.push(substitute(a, &vars));
    }

    // ★ 中文路径兼容：Java Launch Wrapper 处理不了非 ASCII 路径（崩溃模式库里的 environment 类）
    args.push("-Dfile.encoding=UTF-8".into());
    // macOS 上必须加（否则 Dock 里显示的是 java 而不是游戏）
    #[cfg(target_os = "macos")]
    args.push("-XstartOnFirstThread".into());

    // 用户自定义 JVM 参数
    args.extend(spec.extra_jvm_args.iter().cloned());

    /* ---------- 主类 ---------- */
    args.push(spec.main_class.clone());

    /* ---------- 游戏参数 ---------- */
    /*
     * ★★ **两个来源都要用，不是二选一。**
     *
     *   老代码是 `if let Some(legacy) { … } else { … }` ——
     *   有 `minecraftArguments` 就**完全忽略** `arguments.game`。
     *
     *   实测踩到（LiteLoader on 1.12.2 起不来）：
     *     1.12.2 是老格式，游戏参数写在 `minecraftArguments`（单字符串）里；
     *     LiteLoader 的版本 JSON（照 PCL 拼的）只写了
     *       `arguments.game = ["--tweakClass", "…LiteLoaderTweaker"]`。
     *     合并后两个字段**同时存在**，而 launchwrapper 只认
     *     `--tweakClass` —— 二选一就必然丢掉一半：
     *       · 只取 minecraftArguments → 丢掉 tweakClass → LiteLoader 不加载
     *       · 只取 arguments.game   → 丢掉 username/gameDir → 启动即崩
     *     实测第一次跑真机测试就是这么挂的（游戏参数只有 2 个）。
     *
     *   所以：先放 `minecraftArguments`（基础参数），再追加 `arguments.game`
     *   （加载器/附加组件挂上来的 tweakClass 之类）。
     *
     *   ★ 顺序很关键：`--tweakClass` 必须能在参数表里被找到，
     *     launchwrapper 是从整个参数数组里搜它的，位置不影响识别，
     *     但把 tweaker 放后面更符合"基础参数在前"的直觉，
     *     也和 PCL 的做法一致（它把 OptiFineForgeTweaker 挪到最后）。
     */
    if let Some(legacy) = &spec.legacy_arguments {
        for part in legacy.split_whitespace() {
            args.push(substitute(part, &vars));
        }
    }
    /*
     * ★★ 追加 `arguments.game`，但要**按"键值对"去重** —— 不是按单个 token。
     *
     *   踩过的细节（自己写的测试当场发现的）：
     *   只判"这个 token 出现过没有"是不够的 —— `--username A` 之后又来
     *   `--username B`，token `--username` 被跳过了，但 `B` 会**留在原地**，
     *   于是参数表里出现一个裸值，游戏解析参数时会错位。
     *   （PCL 的 `DeduplicateJavaArguments` 用的是同一套"键值对"视角，
     *    它的注释里写着：重复的 `--width` / `--uuid` 会让**两个都失效**，
     *    发生在关键参数上会直接崩。）
     *
     *   规则：
     *     · 带值的参数（`--key value`）：键已存在 → **整对跳过**
     *     · 单值开关（`--demo`）：已存在 → 跳过
     *     · `--tweakClass`：**允许重复**（一个版本可能挂多个 tweaker ——
     *       Forge+OptiFine、LiteLoader+OptiFine 都是真实组合）
     */
    let evaluated = eval_args(&spec.game_args_template, &features);
    let mut i = 0usize;
    while i < evaluated.len() {
        let s = substitute(&evaluated[i], &vars);
        if s.is_empty() {
            i += 1;
            continue;
        }
        let has_key = args.iter().any(|x| x == &s);
        if s == "--tweakClass" {
            // 允许重复：原样放进去
            args.push(s);
            i += 1;
            continue;
        }
        if has_key {
            // 键已存在 → 连同它的值一起跳过（值在当前或下一个位置）
            i += 1;
            if i < evaluated.len() {
                let v = substitute(&evaluated[i], &vars);
                if !v.starts_with('-') {
                    i += 1; // 把那个孤立的"值"也吞掉
                }
            }
            continue;
        }
        args.push(s);
        i += 1;
    }

    // 窗口尺寸（模板里已有 has_custom_resolution 规则时会带，但保险起见补齐）
    if !args.iter().any(|a| a == "--width") {
        args.push("--width".into());
        args.push(spec.width.to_string());
        args.push("--height".into());
        args.push(spec.height.to_string());
    }

    /*
     * ★ 自定义窗口标题 —— 让「实例设置 → 游戏窗口标题」真的生效。
     *
     *   审计发现：这个设置在界面上能改、也存进了实例记录，
     *   但 Rust 的 `LaunchSpec` 里根本没有这个字段，启动参数里也从不出现它 ——
     *   用户改了标题、启动后还是默认的 "Minecraft*"。这是典型的
     *   "做了功能但没法用"（前端的值到后端就被丢掉了）。
     *
     *   实现依据：Minecraft 1.14 起支持 `--title <文本>`（官方启动器
     *   在 profile 里就是这么传的）。1.14 以下的版本**没有**这个参数，
     *   传了会被当成未知参数（不同版本反应不一），所以按版本号判断：
     *   只有 1.14+ 才追加。
     *
     *   注意：Forge/Fabric 不影响这一条 —— 它由原版客户端解析。
     */
    if let Some(title) = spec.window_title.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        if supports_custom_window_title(&spec.version_name) {
            args.push("--title".into());
            args.push(title.to_string());
        }
    }

    // 用户自定义游戏参数
    args.extend(spec.extra_game_args.iter().cloned());

    /*
     * ★ 启动后自动进入服务器（`--server` / `--port`）。
     *
     *   源码依据（研读第 13.4 节）：PCL2 的实例设置里可以直接填服务器地址，
     *   启动就进服 —— 对"整合包测试服客户端"这类场景是刚需。
     *
     *   两个形式上的注意点：
     *   ① 原版客户端接受的是**分开的两个参数**（`--server host --port N`），
     *      不是 `host:port`。所以这里拆开传。
     *   ② `--port` 只在拿到**合法端口**时才传；地址里没写端口就交给游戏
     *      用默认的 25565 —— **不替用户猜**（他写的 `host:abc` 会被解析成
     *      只有主机名，而不是被我们改成某个端口）。
     */
    if let Some(addr) = spec.join_server.as_deref().and_then(parse_server_address) {
        args.push("--server".into());
        args.push(addr.host);
        if let Some(port) = addr.port {
            args.push("--port".into());
            args.push(port.to_string());
        }
    }

    /* ---------- 摘要（不含令牌） ---------- */
    // ★ 内存要按 GB 展示（2048 MB 直接显示成 "2 MB" 是错的，之前踩过）
    let mem_text = if spec.memory_mb >= 1024 {
        format!("{} GB", spec.memory_mb as f64 / 1024.0)
    } else {
        format!("{} MB", spec.memory_mb)
    };
    let summary = format!("{} · {} 内存", spec.version_name, mem_text);

    let debug_line = redact_command(&spec.java.to_string_lossy(), &args);

    BuiltCommand {
        program: spec.java.to_string_lossy().to_string(),
        args,
        summary,
        debug_line,
    }
}

/// 把命令行里的敏感信息打码，方便写日志/贴出来求助
pub fn redact_command(program: &str, args: &[String]) -> String {
    let mut out = String::new();
    out.push_str(program);
    let mut skip_next = false;
    for a in args {
        if skip_next {
            out.push_str(" <已隐藏>");
            skip_next = false;
            continue;
        }
        // 令牌类参数
        if a == "--accessToken" || a == "--clientId" || a == "--xuid" || a == "--auth_session" {
            out.push(' ');
            out.push_str(a);
            skip_next = true;
            continue;
        }
        // -D 形式的敏感项
        if a.starts_with("--accessToken=") {
            out.push_str(" --accessToken=<已隐藏>");
            continue;
        }
        out.push(' ');
        out.push_str(a);
    }
    out
}

/// 从 classpath 里找出客户端 jar（用于校验是否装全）
pub fn find_client_jar(classpath: &[PathBuf], version_id: &str) -> Option<PathBuf> {
    classpath
        .iter()
        .find(|p| {
            p.file_name()
                .map(|f| f.to_string_lossy() == format!("{version_id}.jar"))
                .unwrap_or(false)
        })
        .cloned()
}

/// java.library.path 是否指向存在的目录
pub fn natives_ready(natives_dir: &Path) -> bool {
    natives_dir.is_dir()
        && std::fs::read_dir(natives_dir)
            .map(|mut d| d.next().is_some())
            .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offline_uuid_is_deterministic_and_well_formed() {
        let u1 = offline_uuid("DevTester");
        let u2 = offline_uuid("DevTester");
        assert_eq!(u1, u2, "同名必须得到同一 UUID");
        assert_eq!(u1.len(), 32, "必须是 32 位 hex");
        assert!(u1.chars().all(|c| c.is_ascii_hexdigit()));
        // version 3 特征：第 13 个字符是 '3'
        assert_eq!(&u1[12..13], "3", "UUID 版本位应为 3：{u1}");
    }

    #[test]
    fn offline_uuid_differs_by_name() {
        assert_ne!(offline_uuid("Alice"), offline_uuid("Bob"));
    }

    #[test]
    fn substitution_handles_all_placeholders() {
        let vars = HashMap::from([
            ("auth_player_name".to_string(), "Steve".to_string()),
            ("version_name".to_string(), "1.20.1".to_string()),
        ]);
        let s = substitute("--username ${auth_player_name} --version ${version_name}", &vars);
        assert_eq!(s, "--username Steve --version 1.20.1");
    }

    /// ★★ `${library_directory}` **必须是 spec 给的那个目录**，不许从
    /// classpath 反推。
    ///
    /// 为什么要钉住（这是 P0-1 那条缺陷）：
    ///   Forge 的 profile 里有 `-DlibraryDirectory=${library_directory}`，
    ///   而原实现是拿 `classpath.first()` 往上数四层。classpath 的第一项
    ///   一旦不是"标准四层 Maven 布局的库"（客户端 jar 排在最前、坐标层级
    ///   多一层少一层、classpath 为空），反推出来的就是**别的目录**或空串，
    ///   游戏起来只会报"找不到某个库"。
    ///
    ///   这条测试刻意把**客户端 jar 放在 classpath 第一位**（一个典型会
    ///   骗过 `nth(4)` 的输入），并断言 library_directory 仍然是 spec 里的
    ///   `shared/libraries`。
    #[test]
    fn library_directory_comes_from_spec_not_from_classpath() {
        let mut spec = basic_spec();
        // 客户端 jar 放在最前：`versions/1.20.1/1.20.1.jar` 往上数四层是
        // `C:/shared`（不是 `C:/shared/libraries`）—— 反推就错了
        spec.classpath = vec![
            PathBuf::from("C:/shared/versions/1.20.1/1.20.1.jar"),
            PathBuf::from("C:/shared/libraries/a/a/1/a-1.jar"),
        ];
        spec.libraries_dir = PathBuf::from("C:/shared/libraries");
        spec.jvm_args_template = vec![serde_json::json!(
            "-DlibraryDirectory=${library_directory} -Dminecraft.launcher.brand=${launcher_name}"
        )];

        let cmd = build_command(&spec);
        let line = cmd.args.join(" ");
        assert!(
            line.contains("-DlibraryDirectory=C:/shared/libraries"),
            "★ library_directory 必须等于 spec.libraries_dir（不许从 classpath 反推）：{line}"
        );
        assert!(
            !line.contains("-DlibraryDirectory=C:/shared "),
            "★ 不许推出 classpath 第一项的祖先目录：{line}"
        );
    }

    /// classpath 为空时也不能崩、不能推一个空串上去（那是 `-DlibraryDirectory=`）
    #[test]
    fn library_directory_is_stable_with_empty_classpath() {
        let mut spec = basic_spec();
        spec.classpath = vec![];
        spec.jvm_args_template = vec![serde_json::json!("-DlibraryDirectory=${library_directory}")];
        let cmd = build_command(&spec);
        assert!(
            cmd.args.iter().any(|a| a == "-DlibraryDirectory=C:/shared/libraries"),
            "空 classpath 时也要用 spec 的库根目录：{:?}",
            cmd.args
        );
    }

    #[test]
    fn rules_filter_platform_specific_args() {
        // 只允许 osx 的参数在 windows 上应该被过滤掉
        let args: Vec<serde_json::Value> = vec![
            serde_json::json!("--always"),
            serde_json::json!({
                "rules": [{"action": "allow", "os": {"name": "osx"}}],
                "value": "--only-on-mac"
            }),
            serde_json::json!({
                "rules": [{"action": "allow", "os": {"name": "windows"}}],
                "value": "--only-on-win"
            }),
        ];
        let got = eval_args(&args, &HashMap::new());
        assert!(got.contains(&"--always".to_string()));
        if cfg!(target_os = "windows") {
            assert!(got.contains(&"--only-on-win".to_string()));
            assert!(!got.contains(&"--only-on-mac".to_string()));
        }
    }

    #[test]
    fn eval_args_supports_value_arrays() {
        let args = vec![serde_json::json!({
            "value": ["--a", "1"]
        })];
        assert_eq!(eval_args(&args, &HashMap::new()), vec!["--a", "1"]);
    }

    fn basic_spec() -> LaunchSpec {
        LaunchSpec {
            java: PathBuf::from("C:/jdk/bin/javaw.exe"),
            main_class: "net.minecraft.client.main.Main".into(),
            classpath: vec![
                PathBuf::from("C:/shared/libraries/a/a/1/a-1.jar"),
                PathBuf::from("C:/shared/versions/1.20.1/1.20.1.jar"),
            ],
            natives_dir: PathBuf::from("C:/inst/natives"),
            libraries_dir: PathBuf::from("C:/shared/libraries"),
            game_dir: PathBuf::from("C:/inst"),
            assets_root: PathBuf::from("C:/shared/assets"),
            asset_index_name: "5".into(),
            version_name: "1.20.1".into(),
            version_type: "release".into(),
            account: Account::offline("Tester"),
            memory_mb: 4096,
            width: 1280,
            height: 720,
            jvm_args_template: vec![],
            game_args_template: vec![],
            legacy_arguments: None,
            extra_jvm_args: vec![],
            extra_game_args: vec![],
            window_title: None,
            join_server: None,
        notice: None,
        }
    }

    /* ---------- 服务器地址 ---------- */

    /// ★★ **`minecraftArguments` 与 `arguments.game` 必须同时生效**。
    ///
    ///   老代码是二选一（`if legacy { … } else { … }`），于是
    ///   "老格式基础参数 + 新格式 tweaker"这种组合必然丢一半：
    ///
    ///   实测踩到（LiteLoader on 1.12.2 起不来）：
    ///     · 1.12.2 的游戏参数写在 `minecraftArguments`（老格式单字符串）
    ///     · LiteLoader 的版本 JSON 只写 `arguments.game = [--tweakClass …]`
    ///     · 合并后两个字段同时存在 → 二选一就崩
    ///       （实测第一次跑真机测试时游戏参数只有 2 个，启动即退）
    ///
    ///   这条测试钉住"两个都要在"，并且钉住"重复的参数只留一份"。
    #[test]
    fn legacy_and_template_arguments_are_both_applied() {
        let mut spec = basic_spec();
        // 老格式：基础参数
        spec.legacy_arguments = Some(
            "--username ${auth_player_name} --version ${version_name} --gameDir ${game_directory}"
                .into(),
        );
        // 新格式：加载器挂上来的 tweaker
        spec.game_args_template = vec![
            serde_json::json!("--tweakClass"),
            serde_json::json!("com.mumfrey.liteloader.launch.LiteLoaderTweaker"),
        ];
        let cmd = build_command(&spec);
        let all = cmd.args.join(" ");
        say!("游戏参数段：{}", cmd.args[cmd.args.len() - 5..].join(" "));

        assert!(
            cmd.args.iter().any(|a| a == "--tweakClass"),
            "★★ 加载器挂的 --tweakClass 不能因为存在 minecraftArguments 就被丢掉：{:?}",
            cmd.args
        );
        assert!(
            cmd.args
                .iter()
                .any(|a| a == "com.mumfrey.liteloader.launch.LiteLoaderTweaker"),
            "tweakClass 的值也要在"
        );
        assert!(
            cmd.args.iter().any(|a| a == "--username"),
            "★ 老格式的基础参数（--username）也不能丢 —— 只取一边就会缺一半"
        );
        assert!(cmd.args.iter().any(|a| a == "--gameDir"));
        assert!(all.contains("Tester"), "占位符要替换：{all}");
    }

    /// 重复的游戏参数只留一份（PCL 实测：重复的 `--width` 会让两个都失效）。
    /// `--tweakClass` 是唯一的例外（一个版本可能挂多个 tweaker）。
    #[test]
    fn duplicate_game_args_are_deduped_but_tweakclass_is_allowed() {
        let mut spec = basic_spec();
        spec.legacy_arguments = Some("--username ${auth_player_name} --width 854".into());
        spec.game_args_template = vec![
            serde_json::json!("--username"),
            serde_json::json!("DUPLICATE"),
            serde_json::json!("--tweakClass"),
            serde_json::json!("a.Tweaker"),
            serde_json::json!("--tweakClass"),
            serde_json::json!("b.Tweaker"),
        ];
        let cmd = build_command(&spec);
        let count = |needle: &str| cmd.args.iter().filter(|a| a.as_str() == needle).count();

        assert_eq!(count("--username"), 1, "重复的 --username 只该留一份：{:?}", cmd.args);
        assert!(
            !cmd.args.iter().any(|a| a == "DUPLICATE"),
            "重复项的**值**也不该混进来"
        );
        assert_eq!(
            count("--tweakClass"),
            2,
            "★ --tweakClass 允许重复（Forge+OptiFine / LiteLoader+OptiFine 都是真实组合）"
        );
    }

    /// ★ 回归：**全角冒号**必须被换成半角。
    ///
    ///   这是中文输入法下最自然的手误：`mc.example.com：25565`。
    ///   游戏只认半角，报错里两个地址看起来一模一样 ——
    ///   不处理的话用户永远不知道问题在哪（PCL2 在 `TextChanged` 里做了同样的事）。
    #[test]
    fn full_width_colon_in_server_address_is_normalized() {
        let a = parse_server_address("mc.example.com：25565").unwrap();
        assert_eq!(a.host, "mc.example.com");
        assert_eq!(a.port, Some(25565));
    }

    #[test]
    fn server_address_without_port_is_kept_as_is() {
        let a = parse_server_address("play.example.net").unwrap();
        assert_eq!(a.host, "play.example.net");
        assert_eq!(a.port, None, "没写端口就不该编一个出来");
    }

    /// 端口写坏时：**保留主机名、不猜端口**（不替用户换目标服务器）
    #[test]
    fn broken_port_keeps_host_and_drops_the_port() {
        let a = parse_server_address("host.example:abc").unwrap();
        assert_eq!(a.host, "host.example");
        assert_eq!(a.port, None, "端口写坏时不许猜一个默认值塞进去");
        // 超出 u16 的端口同样只是丢掉
        let b = parse_server_address("host.example:70000").unwrap();
        assert_eq!(b.host, "host.example");
        assert_eq!(b.port, None);
    }

    #[test]
    fn server_address_tolerates_pasted_urls_and_paths() {
        let a = parse_server_address("  https://mc.example.com:25566/play  ").unwrap();
        assert_eq!(a.host, "mc.example.com");
        assert_eq!(a.port, Some(25566));
        // 只有路径、没有协议
        let b = parse_server_address("mc.example.com/status").unwrap();
        assert_eq!(b.host, "mc.example.com");
        assert_eq!(b.port, None);
    }

    #[test]
    fn empty_server_address_means_no_auto_join() {
        assert!(parse_server_address("").is_none());
        assert!(parse_server_address("   ").is_none());
        assert!(parse_server_address("：25565").is_none(), "只有端口没有主机名 → 不算地址");
    }

    /// ★ 前后端规则**必须给出同样的结论**。
    ///
    ///   规则在两处实现（前端为了"边输边纠正"，Rust 为了真正拼命令行），
    ///   而两边分叉时症状极隐蔽：输入框下面写着"会连 mc.example.com:25565"，
    ///   实际启动参数里却是别的东西。
    ///
    ///   所以这张表在两边的测试里**逐字相同**：
    ///   `tests/server-address.test.mjs` 里有一张一样的表，
    ///   任何一边改了规则，两张表就会有一个红。
    #[test]
    fn server_address_matches_the_frontend_rule_table() {
        // (输入, 期望 host, 期望 port)
        let table: [(&str, &str, Option<u16>); 10] = [
            ("mc.example.com：25565", "mc.example.com", Some(25565)),
            ("mc.example.com:25565", "mc.example.com", Some(25565)),
            ("mc.example.com", "mc.example.com", None),
            ("mc.example.com：", "mc.example.com", None),
            ("https://mc.example.com:25566/play?x=1", "mc.example.com", Some(25566)),
            ("　mc.example.com　", "mc.example.com", None),
            ("mc.example.com:abc", "mc.example.com", None),
            ("[::1]:25565", "[::1]", Some(25565)),
            ("ＭＣ．ＥＸＡＭＰＬＥ．ＣＯＭ：２５５６５", "MC.EXAMPLE.COM", Some(25565)),
            ("mc.example.com:70000", "mc.example.com", None),
        ];
        for (input, host, port) in table {
            let got = parse_server_address(input)
                .unwrap_or_else(|| panic!("「{input}」应当能被解析出主机名"));
            assert_eq!(got.host, host, "「{input}」的主机名不对");
            assert_eq!(got.port, port, "「{input}」的端口不对");
        }
    }

    /// ★ 回归：地址必须真的进命令行，且**拆成 `--server` / `--port` 两个参数**
    ///   （原版客户端不认 `host:port` 这种写法）。
    #[test]
    fn join_server_reaches_the_command_line() {
        let mut spec = basic_spec();
        spec.join_server = Some("mc.example.com：25565".into());
        let cmd = build_command(&spec);
        let pos = cmd.args.iter().position(|a| a == "--server").expect("必须带 --server");
        assert_eq!(cmd.args[pos + 1], "mc.example.com");
        let ppos = cmd.args.iter().position(|a| a == "--port").expect("必须带 --port");
        assert_eq!(cmd.args[ppos + 1], "25565");
    }

    /// 没设地址时命令行里**不许**出现这两个参数（否则游戏会去连空地址）
    #[test]
    fn no_server_flags_when_not_configured() {
        let mut spec = basic_spec();
        spec.join_server = Some("   ".into());
        let cmd = build_command(&spec);
        assert!(!cmd.args.iter().any(|a| a == "--server"));
        assert!(!cmd.args.iter().any(|a| a == "--port"));
    }

    /// 只写主机名时不传 `--port`，让游戏用默认端口
    #[test]
    fn no_port_flag_when_address_has_no_port()  {
        let mut spec = basic_spec();
        spec.join_server = Some("mc.example.com".into());
        let cmd = build_command(&spec);
        let pos = cmd.args.iter().position(|a| a == "--server").expect("必须带 --server");
        assert_eq!(cmd.args[pos + 1], "mc.example.com");
        assert!(
            !cmd.args.iter().any(|a| a == "--port"),
            "没写端口就不该传 --port（游戏自己会用 25565）"
        );
    }

    /// ★ 回归：自定义窗口标题必须真的进命令行（1.14+）
    ///
    ///   审计发现这个功能以前"前端能设、后端丢掉"，所以永远不生效。
    #[test]
    fn custom_window_title_reaches_the_command_line() {
        let mut spec = basic_spec();
        spec.window_title = Some("我的整合包".into());
        let cmd = build_command(&spec);
        let i = cmd
            .args
            .iter()
            .position(|a| a == "--title")
            .expect("1.20.1 应当带上 --title");
        assert_eq!(cmd.args[i + 1], "我的整合包");

        // 没设标题就不该出现这个参数
        let plain = build_command(&basic_spec());
        assert!(!plain.args.iter().any(|a| a == "--title"));

        // 空白标题等于没设
        let mut blank = basic_spec();
        blank.window_title = Some("   ".into());
        assert!(!build_command(&blank).args.iter().any(|a| a == "--title"));
    }

    /// 1.14 以下**没有** `--title` 参数，不能瞎传
    #[test]
    fn window_title_is_skipped_on_legacy_versions() {
        assert!(!supports_custom_window_title("1.12.2"));
        assert!(!supports_custom_window_title("1.7.10"));
        assert!(supports_custom_window_title("1.14"));
        assert!(supports_custom_window_title("1.20.1"));
        assert!(supports_custom_window_title("26.2"));
        assert!(supports_custom_window_title("24w45a"));

        let mut spec = basic_spec();
        spec.version_name = "1.12.2".into();
        spec.window_title = Some("怀旧服".into());
        assert!(
            !build_command(&spec).args.iter().any(|a| a == "--title"),
            "1.12.2 不支持 --title，不该传"
        );
    }

    #[test]
    fn command_has_memory_and_main_class() {
        let cmd = build_command(&basic_spec());
        assert!(cmd.args.iter().any(|a| a == "-Xmx4096M"));
        assert!(cmd.args.iter().any(|a| a == "net.minecraft.client.main.Main"));
    }

    #[test]
    fn main_class_comes_after_jvm_and_before_game_args() {
        let mut spec = basic_spec();
        spec.game_args_template = vec![serde_json::json!("--username"), serde_json::json!("${auth_player_name}")];
        let cmd = build_command(&spec);
        let mc = cmd.args.iter().position(|a| a == "net.minecraft.client.main.Main").unwrap();
        let cp = cmd.args.iter().position(|a| a == "-cp").unwrap();
        let un = cmd.args.iter().position(|a| a == "--username").unwrap();
        assert!(cp < mc, "classpath 必须在主类之前");
        assert!(mc < un, "游戏参数必须在主类之后");
    }

    #[test]
    fn classpath_uses_platform_separator() {
        let cmd = build_command(&basic_spec());
        let cp_idx = cmd.args.iter().position(|a| a == "-cp").unwrap();
        let cp = &cmd.args[cp_idx + 1];
        assert!(cp.contains(classpath_separator()));
    }

    #[test]
    fn natives_and_classpath_injected_when_template_lacks_them() {
        let cmd = build_command(&basic_spec());
        assert!(cmd.args.iter().any(|a| a.starts_with("-Djava.library.path=")));
        assert!(cmd.args.iter().any(|a| a == "-cp"));
    }

    #[test]
    fn placeholders_are_substituted_in_game_args() {
        let mut spec = basic_spec();
        spec.game_args_template = vec![
            serde_json::json!("--username"),
            serde_json::json!("${auth_player_name}"),
            serde_json::json!("--uuid"),
            serde_json::json!("${auth_uuid}"),
        ];
        let cmd = build_command(&spec);
        assert!(cmd.args.contains(&"Tester".to_string()));
        assert!(!cmd.args.iter().any(|a| a.contains("${")), "不该有未替换的占位符");
    }

    #[test]
    fn legacy_arguments_split_by_whitespace() {
        let mut spec = basic_spec();
        spec.legacy_arguments = Some("--username ${auth_player_name} --version 1.7.10".into());
        let cmd = build_command(&spec);
        assert!(cmd.args.contains(&"--username".to_string()));
        assert!(cmd.args.contains(&"Tester".to_string()));
        assert!(cmd.args.contains(&"1.7.10".to_string()));
    }

    #[test]
    fn debug_line_redacts_token() {
        let mut spec = basic_spec();
        spec.account.access_token = "super-secret-token".into();
        spec.game_args_template = vec![
            serde_json::json!("--accessToken"),
            serde_json::json!("${auth_access_token}"),
        ];
        let cmd = build_command(&spec);
        assert!(!cmd.debug_line.contains("super-secret-token"), "{}", cmd.debug_line);
        assert!(cmd.debug_line.contains("<已隐藏>"), "{}", cmd.debug_line);
        // 但真实 args 里必须有令牌
        assert!(cmd.args.contains(&"super-secret-token".to_string()));
    }

    #[test]
    fn window_size_added_when_missing() {
        let cmd = build_command(&basic_spec());
        assert!(cmd.args.contains(&"--width".to_string()));
        assert!(cmd.args.contains(&"1280".to_string()));
    }

    #[test]
    fn summary_shows_memory_in_gb_not_mb() {
        // ★ 回归测试：2048 MB 曾经被显示成 "2 MB"
        let cmd = build_command(&basic_spec()); // memory_mb = 4096
        assert!(cmd.summary.contains("4 GB"), "{}", cmd.summary);
        assert!(!cmd.summary.contains("4 MB"), "{}", cmd.summary);

        let mut small = basic_spec();
        small.memory_mb = 768;
        let cmd2 = build_command(&small);
        assert!(cmd2.summary.contains("768 MB"), "{}", cmd2.summary);
    }

    #[test]
    fn empty_substituted_args_are_skipped() {
        let mut spec = basic_spec();
        spec.game_args_template = vec![
            serde_json::json!("--clientId"),
            serde_json::json!("${clientid}"),
        ];
        let cmd = build_command(&spec);
        // ${clientid} 替换成空串 → --clientId 后面不该跟一个空参数
        let idx = cmd.args.iter().position(|a| a == "--clientId").unwrap();
        assert_eq!(cmd.args[idx + 1], "--width", "空参数应被跳过");
    }
}
