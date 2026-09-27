//! **导出整合包时哪些文件绝不能带上**（ADR-024）。
//!
//! ## 为什么这是一件"安全"的事，而不是"整洁"的事
//!
//!   导出的整合包是要**发给别人**的。里面只要混进一样东西，后果就不是"文件多了"：
//!
//!   * `launcher_msa_credentials.bin` —— **微软登录凭据**。
//!     分享出去的整合包等于把你的账号送人（ADR-024 把它列为**安全红线**）；
//!   * `saves/` —— 别人的存档、建筑、坐标；
//!   * `logs/` `crash-reports/` —— 里面有你的路径、用户名、服务器地址；
//!   * `libraries/` `assets/` `versions/` —— 几百 MB 的游戏本体（下游自己会下）。
//!
//!   ⇒ 两张名单：**硬黑名单**（导出时绝不包含）与**建议黑名单**
//!     （默认不勾，但用户想要就能勾 —— 比如他就想把存档一起给朋友）。
//!
//! ## 匹配语义（ADR-024 写得很死，这里**逐条照做**）
//!
//! ```text
//!   目录：fileName.startsWith(条目 + "/")   ← 前缀匹配（目录及其全部内容）
//!   文件：非 regex 条目是**精确相等**（不是前缀！）
//!         `regex:` 开头的条目走正则
//! ```
//!
//!   ★ 为什么"文件是精确相等"很关键：条目里有 `data` 这种很普通的名字 ——
//!     如果按前缀匹配，`database.toml`、`data.zip` 也会被误伤（用户会莫名其妙
//!     发现自己的配置文件没进包里）。ADR 特意把这条写出来，说明它踩过。
//!
//! ## 路径格式
//!
//!   一律用**相对游戏目录**、`/` 分隔、目录带尾斜杠（与操作系统无关）：
//!   `mods/`、`mods/jei.jar`、`config/x.toml`。

use std::sync::OnceLock;

/// 命中了哪张名单
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Blacklist {
    /// 绝不包含（ADR-024 的 `MODPACK_BLACK_LIST`）
    Hard,
    /// 默认不勾，用户可选（`MODPACK_SUGGESTED_BLACK_LIST`）
    Suggested,
}

impl Blacklist {
    pub fn key(self) -> &'static str {
        match self {
            Blacklist::Hard => "hard",
            Blacklist::Suggested => "suggested",
        }
    }
}

/// ★★ **安全红线**：这些东西在任何情况下都不许进整合包。
///
/// 它们是硬黑名单的**子集**，单独列出来是为了两件事：
///   ① 判据能单独钉住它（`the_red_line_is_never_crossed`）；
///   ② 导出时**只要盘上存在**就如实报给用户看（"你目录里有登录凭据，我们没带上"）——
///      沉默地跳过是不够的：用户需要知道那个文件**曾经**在那儿，
///      因为他可能正打算把整个目录打包发给别人。
pub const RED_LINE: &[&str] = &[
    "launcher_msa_credentials.bin",
    "launcher_accounts.json",
    "launcher_profiles.json",
    "launcher_settings.json",
    "launcher_ui_state.json",
    "realms_persistence.json",
    "treatment_tags.json",
];

/// 硬黑名单（ADR-024 的 `MODPACK_BLACK_LIST`，逐条照抄）
///
/// ★ 目录条目带尾斜杠、文件条目不带；`regex:` 开头的走正则。
pub const HARD: &[&str] = &[
    /* ---- 日志与备份 ---- */
    "regex:.*\\.log$",
    "regex:.*\\.dat_old$",
    "regex:.*\\.old$",
    /* ---- 各类启动器的私有文件 ---- */
    "clientId.txt",
    "PCL.ini",
    /* ★ 实测：HMCL 的配置文件名是 `.hmcl.json`（ADR 表里写的是 `.hmcl`）——
       两个都留着：前者是**真名字**，后者是那张表原本的样子。 */
    ".hmcl",
    ".hmcl.json",
    "backup",
    "pack.json",
    "launcher.jar",
    "cache",
    "modpack.cfg",
    "log4j2.xml",
    "hmclversion.cfg",
    "instance-game-settings.json",
    "launcher_profiles.json",
    "launcher.pack.lzma",
    "launcher_accounts.json",
    "launcher_cef_log.txt",
    "launcher_log.txt",
    "launcher_msa_credentials.bin",
    "launcher_settings.json",
    "launcher_ui_state.json",
    "realms_persistence.json",
    "webcache2",
    "treatment_tags.json",
    /* ---- 游戏本体与缓存 ---- */
    "versions",
    "assets",
    "libraries",
    "natives",
    "native",
    "$native",
    "$natives",
    "jars",
    "logs",
    "crash-reports",
    "server-resource-packs",
    "command_history.txt",
    "regex:.*-natives$",
    /* ---- 加载器运行期缓存 ---- */
    ".fabric",
    ".mixin.out",
    ".optifine",
    "irisUpdateInfo.json",
    "modernfix",
    "modtranslations",
    "mods/.connector",
    /* ---- 其他启动器与平台 ---- */
    "manifest.json",
    "minecraftinstance.json",
    ".curseclient",
    "modrinth.index.json",
    "regex:.*\\.BakaCoreInfo$",
    /* ---- Mod 产生的数据 ---- */
    "asm",
    "backups",
    "TCNodeTracker",
    "CustomDISkins",
    "data",
    "CustomSkinLoader/caches",
    "debug",
    ".replay_cache",
    "replay_recordings",
    "replay_videos",
    "schematics",
    "journeymap/data",
];

/// 建议黑名单（ADR-024 的 `MODPACK_SUGGESTED_BLACK_LIST`，默认不勾）
pub const SUGGESTED: &[&str] = &[
    "fonts",
    "saves",
    "servers.dat",
    "options.txt",
    "blueprints",
    "optionsof.txt",
    "journeymap",
    "optionsshaders.txt",
    "mods/VoxelMods",
];

/// 一张名单 + 它编好的正则（只编一次）
struct Compiled {
    exact: Vec<&'static str>,
    regex: Vec<regex::Regex>,
}

fn compiled(list: &'static [&'static str]) -> &'static Compiled {
    // 两张名单各缓存一份（编译正则不便宜，而导出会问几千次）
    static HARD_C: OnceLock<Compiled> = OnceLock::new();
    static SUG_C: OnceLock<Compiled> = OnceLock::new();
    let cell = if std::ptr::eq(list.as_ptr(), HARD.as_ptr()) {
        &HARD_C
    } else {
        &SUG_C
    };
    cell.get_or_init(|| {
        let mut exact = Vec::new();
        let mut regex = Vec::new();
        for item in list {
            match item.strip_prefix("regex:") {
                Some(r) => {
                    // 编译不了就**跳过它并留痕**：一个写错的正则不该让整次导出失败，
                    // 但也绝不能静默 —— 见下面的测试（表里每个正则都必须是合法的）。
                    if let Ok(re) = regex::Regex::new(r) {
                        regex.push(re);
                    }
                }
                None => exact.push(*item),
            }
        }
        Compiled { exact, regex }
    })
}

/// 这条名单命中了吗
///
/// `rel` 是**相对游戏目录**的路径（`/` 分隔）；`is_dir` 说明它是目录。
pub fn matches(list: &'static [&'static str], rel: &str, is_dir: bool) -> bool {
    let c = compiled(list);
    if is_dir {
        /*
         * 目录：`startsWith(条目 + "/")` —— ADR-024 的语义。
         *
         * ★ 这里**容错**：调用方忘了给目录加尾斜杠时，我们替它补上。
         *   为什么值得容错：漏一个斜杠的后果是"**整个目录被装进整合包**"
         *   （`saves` 变成 `saves` 匹配不上 `saves/`），而这是**静默**的 ——
         *   用户会在把包发给别人之后才知道。安全相关的判据宁可宽进严出。
         */
        let dir = if rel.ends_with('/') { rel.to_string() } else { format!("{rel}/") };
        return list.iter().filter(|s| !s.starts_with("regex:")).any(|s| {
            let s = s.trim_end_matches('/');
            if s.is_empty() {
                return false;
            }
            dir == format!("{s}/") || dir.starts_with(&format!("{s}/"))
        });
    }
    // 文件：精确相等（非 regex）或正则命中
    if c.exact.iter().any(|s| *s == rel) {
        return true;
    }
    c.regex.iter().any(|re| re.is_match(rel))
}

/// 这条路径**要不要排除**（返回命中的是哪张名单）
///
/// ★ 顺序：先看硬黑名单，再看建议名单。两张都命中时按**硬**算
///   （用户勾了"包含存档"也不该把登录凭据放进去）。
pub fn excluded(rel: &str, is_dir: bool) -> Option<Blacklist> {
    if matches(HARD, rel, is_dir) {
        return Some(Blacklist::Hard);
    }
    if matches(SUGGESTED, rel, is_dir) {
        return Some(Blacklist::Suggested);
    }
    None
}

/// 是不是**红线**文件（登录凭据）
pub fn is_red_line(rel: &str) -> bool {
    RED_LINE.iter().any(|r| *r == rel)
}

/// 给界面用的一句话：为什么它被排除了
pub fn reason_of(rel: &str, is_dir: bool) -> Option<String> {
    match excluded(rel, is_dir)? {
        Blacklist::Hard if is_red_line(rel) => Some(
            "★ 登录凭据：绝不进整合包（ADR-024 的安全红线）".to_string(),
        ),
        Blacklist::Hard => Some(if is_dir {
            "启动器私有目录 / 游戏本体 / 运行期缓存：不带".to_string()
        } else {
            "日志、启动器私有文件或 Mod 产生的数据：不带".to_string()
        }),
        Blacklist::Suggested => Some(if is_dir {
            "默认不带（存档这类内容，需要时可以勾上）".to_string()
        } else {
            "默认不带（存档 / 设置这类内容，需要时可以勾上）".to_string()
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ★★★ **安全红线**：登录凭据在任何情况下都不许进整合包
    #[test]
    fn the_red_line_is_never_crossed() {
        for name in RED_LINE {
            assert_eq!(
                excluded(name, false),
                Some(Blacklist::Hard),
                "「{name}」是登录凭据，必须在硬黑名单里"
            );
            assert!(is_red_line(name));
            // 理由里要**点名**它是登录凭据（不能混在"日志/私有文件"那一类里）
            let why = reason_of(name, false).unwrap();
            assert!(why.contains("登录凭据"), "{name} 的理由是：{why}");
        }
        // 即使勾了"包含建议项"，红线也不动（它压根不在建议名单里）
        assert!(!SUGGESTED.contains(&"launcher_msa_credentials.bin"));
    }

    /// 硬黑名单：日志、启动器私有文件、游戏本体、运行期缓存都要挡住
    #[test]
    fn the_hard_list_covers_the_dangerous_families() {
        // 日志（正则）
        assert_eq!(excluded("logs/latest.log", false), Some(Blacklist::Hard));
        assert_eq!(excluded("hs_err_pid1234.log", false), Some(Blacklist::Hard));
        // 游戏本体（目录）
        for d in ["versions/", "libraries/", "assets/", "natives/", "logs/", "crash-reports/"] {
            assert_eq!(excluded(d, true), Some(Blacklist::Hard), "{d} 应当被排除");
        }
        // 加载器运行期缓存
        assert_eq!(excluded(".fabric/", true), Some(Blacklist::Hard));
        assert_eq!(excluded("mods/.connector/", true), Some(Blacklist::Hard));
        // 别的启动器留下的
        assert_eq!(excluded("PCL.ini", false), Some(Blacklist::Hard));
        assert_eq!(excluded(".hmcl", false), Some(Blacklist::Hard));
        // ★ HMCL 的真文件名是 `.hmcl.json`（ADR 表里只写了 `.hmcl`）——两个都要挡住
        assert_eq!(excluded(".hmcl.json", false), Some(Blacklist::Hard));
        assert_eq!(excluded("manifest.json", false), Some(Blacklist::Hard));
    }

    /// ★★ 匹配语义：**文件是精确相等，不是前缀**
    #[test]
    fn files_match_exactly_but_directories_match_by_prefix() {
        // 条目里有 `data`（Mod 产生的数据目录）
        assert_eq!(excluded("data/", true), Some(Blacklist::Hard), "目录 data/ 要挡住");
        assert_eq!(excluded("data/foo.nbt", false), None, "data 里面的文件由目录那条挡住，文件本身不命中");
        // ★ 关键：`database.toml` 不该被 `data` 误伤（前缀匹配就会误伤）
        assert_eq!(excluded("config/database.toml", false), None, "database 不是 data");
        assert_eq!(excluded("database.toml", false), None, "database.toml 不是 data");
        // `logs` 是目录条目：`logs/` 与它下面的一切都挡，但 `logs.txt` 不命中
        // （`logs.txt` 由 `regex:.*\.log$` 管？不 —— .txt 不是 .log，所以它是**允许**的）
        assert_eq!(excluded("logs.txt", false), None);
        // `asm` 目录同理
        assert_eq!(excluded("asm/", true), Some(Blacklist::Hard));
        assert_eq!(excluded("asmfile.txt", false), None, "asmfile 不是 asm");
    }

    /// 建议名单：默认不勾，但**能被用户勾上**（所以它们不是 Hard）
    #[test]
    fn the_suggested_list_is_optional_not_forbidden() {
        for (rel, is_dir) in [
            ("saves/", true),
            ("options.txt", false),
            ("servers.dat", false),
            ("journeymap/", true),
            ("fonts/", true),
            // ★ 忘了加尾斜杠也要拦住（补斜杠是容错，见 `matches` 的说明）
            ("saves", true),
        ] {
            assert_eq!(
                excluded(rel, is_dir),
                Some(Blacklist::Suggested),
                "「{rel}」应当在建议名单里（默认不勾，但可以勾）"
            );
        }
        // 存档目录：默认不导出（ADR-024 明文）
        assert_eq!(excluded("saves/", true), Some(Blacklist::Suggested));
    }

    /// 正常该带上的东西：一个都不许被误伤
    #[test]
    fn ordinary_game_files_are_not_excluded() {
        for rel in [
            "mods/jei.jar",
            "config/jei.toml",
            "resourcepacks/材质包.zip",
            "shaderpacks/光影.zip",
            "datapacks/x.zip",
        ] {
            assert_eq!(excluded(rel, false), None, "「{rel}」不该被排除");
        }
        for d in ["mods/", "config/", "resourcepacks/", "shaderpacks/"] {
            assert_eq!(excluded(d, true), None, "「{d}」不该被排除");
        }
    }

    /// 表本身要干净：正则都能编译、没有重复、没有空条目
    #[test]
    fn both_lists_are_well_formed() {
        for (name, list) in [("HARD", HARD), ("SUGGESTED", SUGGESTED)] {
            let mut seen = std::collections::HashSet::new();
            for item in list {
                assert!(!item.trim().is_empty(), "{name} 里有空条目");
                assert!(seen.insert(*item), "{name} 里「{item}」重复了");
                if let Some(r) = item.strip_prefix("regex:") {
                    // ★ 编译不了的正则会被 `compiled()` 跳过 —— 那等于那条判据**静默失效**，
                    //   所以这里必须钉住"每个正则都能编译"。
                    regex::Regex::new(r).unwrap_or_else(|e| panic!("{name} 的正则「{r}」编译不了：{e}"));
                }
            }
        }
        // 红线必须是硬名单的子集（否则"红线"只是个说法）
        for r in RED_LINE {
            assert!(HARD.contains(r), "红线「{r}」不在硬黑名单里");
        }
    }

    /// 正则那条要真的生效（`.*\.log$` 挡住任何层级的 .log，但挡不住 .log.gz）
    #[test]
    fn regex_entries_behave_as_written() {
        assert_eq!(excluded("a/b/c.log", false), Some(Blacklist::Hard));
        assert_eq!(excluded("2026-09-27-1.log", false), Some(Blacklist::Hard));
        assert_eq!(excluded("latest.log.gz", false), None, "正则以 $ 结尾，.gz 不该命中");
        assert_eq!(excluded("world/level.dat_old", false), Some(Blacklist::Hard));
        assert_eq!(excluded("x/y/dummy-natives", false), Some(Blacklist::Hard));
    }
}
