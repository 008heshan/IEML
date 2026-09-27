//! **这是谁的目录** —— 认外部启动器（官方 / PCL / HMCL / Prism…）留下的游戏目录。
//!
//! ## 为什么要有这个模块
//!
//!   老玩家换启动器时，手上是一整个 `.minecraft`：里面有存档、Mod、配置，
//!   还有一堆**只有那个启动器才懂**的东西。IEML 要做的只有一件事：
//!   **把用户攒下来的游戏数据搬过来**，而不是让他自己在文件管理器里拷。
//!
//!   但"目录长什么样"各家不同（而且同一个启动器不同版本也不同），所以这里只做
//!   **按证据认形状**：看到哪些文件、就说是谁的目录，并把依据说出来。
//!   判错的代价很具体：把 PCL 的配置目录当成"一个版本"去搬，
//!   用户会得到一堆没用的文件，还以为自己的存档搬过来了。
//!
//! ## 判据（都是**盘上真实存在的名字**，不是猜）
//!
//! | 看到什么 | 认成 | 依据 |
//! |---|---|---|
//! | `launcher_profiles.json` | 官方启动器 | 官方启动器每次启动都写它 |
//! | `.hmcl.json` | HMCL | HMCL 在游戏目录里落这个文件 |
//! | `PCL/` 目录 | PCL2 | PCL 把自己的东西放在 `<.minecraft>/PCL/` |
//! | `instance.cfg` + `mmc-pack.json` | Prism / MultiMC **实例** | 这两个是 Prism 实例的身份证 |
//! | `saves/` `mods/` … 有游戏数据 | 一个游戏目录（认不出是谁） | 有内容就值得搬，是谁的不重要 |
//! | 什么都没有 | 认不出来 | 如实说，不猜 |
//!
//! ★ 顺序有意义：Prism 的**实例目录**里也有 `minecraft/` 子目录（真正的游戏目录在它里面），
//!   所以"这是谁的目录"与"哪一层才是游戏目录"是两个问题（见 [`resolve_game_dir`] 的说明）。

/// 认出来的来源
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LauncherKind {
    Official,
    Pcl,
    Hmcl,
    /// Prism / MultiMC（两者格式相同：`instance.cfg` + `mmc-pack.json`）
    Prism,
    /// 有游戏数据，但认不出是哪个启动器写的
    Generic,
    Unknown,
}

impl LauncherKind {
    pub fn key(self) -> &'static str {
        match self {
            LauncherKind::Official => "official",
            LauncherKind::Pcl => "pcl",
            LauncherKind::Hmcl => "hmcl",
            LauncherKind::Prism => "prism",
            LauncherKind::Generic => "generic",
            LauncherKind::Unknown => "unknown",
        }
    }

    pub fn display(self) -> &'static str {
        match self {
            LauncherKind::Official => "官方启动器",
            LauncherKind::Pcl => "PCL2",
            LauncherKind::Hmcl => "HMCL",
            LauncherKind::Prism => "Prism / MultiMC 实例",
            LauncherKind::Generic => "一个游戏目录",
            LauncherKind::Unknown => "认不出来",
        }
    }
}

/// 值得搬的**游戏数据**（与隔离那边共用同一张清单：它列的就是"游戏会读写的那几样"）
///
/// ★ 不含 `versions/` `libraries/` `assets/`：那些是**游戏本体**，IEML 有自己的共享目录，
///   搬过来只会多占几个 GB（而且它们本来就是同一份官方文件）。
pub fn data_dirs() -> Vec<&'static str> {
    let mut v: Vec<&'static str> = crate::domain::isolation::SHARED_DIRS.to_vec();
    v.push("options.txt");
    v
}

/// 顶层有这些名字 → 这个目录里有**游戏数据**（值得搬）
pub fn has_game_data(names: &[String]) -> bool {
    crate::domain::isolation::SHARED_DIRS
        .iter()
        .any(|d| names.iter().any(|n| n == d))
}

/// 认这是谁留下的目录（返回依据，供界面显示"我凭什么这么认"）
pub fn detect(names: &[String]) -> (LauncherKind, Vec<String>) {
    let has = |n: &str| names.iter().any(|x| x == n);
    let mut evidence = Vec::new();

    // ① Prism / MultiMC 的**实例**目录：身份证是两个配置文件
    if has("instance.cfg") && has("mmc-pack.json") {
        evidence.push("有 instance.cfg 与 mmc-pack.json（Prism / MultiMC 实例的身份证）".to_string());
        return (LauncherKind::Prism, evidence);
    }
    // ② 官方启动器
    if has("launcher_profiles.json") {
        evidence.push("有 launcher_profiles.json（官方启动器写的）".to_string());
        return (LauncherKind::Official, evidence);
    }
    // ③ HMCL
    if has(".hmcl.json") {
        evidence.push("有 .hmcl.json（HMCL 写的）".to_string());
        return (LauncherKind::Hmcl, evidence);
    }
    // ④ PCL2
    if has("PCL") {
        evidence.push("有 PCL/ 目录（PCL2 把自己的东西放在这里）".to_string());
        return (LauncherKind::Pcl, evidence);
    }
    // ⑤ 认不出是谁，但有游戏数据 —— 照样值得搬
    if has_game_data(names) {
        for d in crate::domain::isolation::SHARED_DIRS {
            if has(d) {
                evidence.push(format!("有 {d}/"));
            }
        }
        return (LauncherKind::Generic, evidence);
    }
    (LauncherKind::Unknown, evidence)
}

/// **哪一层才是游戏目录**。
///
/// 三种常见形状（都要认，不然用户拖进来会得到"这里没有游戏数据"）：
///
/// ```text
///   选中的目录本身就是游戏目录        → 用它（空串）
///   Prism 实例目录（里面是 minecraft/）→ 用 <它>/minecraft
///   选中的是上一级（里面有 .minecraft）→ 用 <它>/.minecraft
/// ```
///
/// ★ 先看自己、再看子目录：**自己的证据优先**（一个目录里同时有 `saves/` 与
///   `minecraft/saves/` 时，用户显然指的是前者）。
///
/// ★ Prism 的实例目录**不是**游戏目录 —— 它里面的 `minecraft/` 才是。
///   第一版把"认出是 Prism"直接当成"就是它自己"，于是导入时会把
///   `instance.cfg`、`mmc-pack.json` 这些启动器配置当游戏数据搬过来
///   （探针抓到的：`game_dir` 等于实例目录本身）。
pub fn resolve_game_dir(names: &[String], has_subdir: impl Fn(&str) -> bool) -> Option<String> {
    if has_game_data(names) {
        return Some(String::new()); // 空串 = "就是它自己"
    }
    for sub in ["minecraft", ".minecraft"] {
        if has_subdir(sub) {
            return Some(sub.to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn each_launcher_is_recognised_by_its_own_evidence() {
        let (k, e) = detect(&names(&["launcher_profiles.json", "versions", "saves"]));
        assert_eq!(k, LauncherKind::Official);
        assert!(e[0].contains("launcher_profiles.json"), "{e:?}");
        assert_eq!(k.display(), "官方启动器");

        let (k, e) = detect(&names(&[".hmcl.json", "mods"]));
        assert_eq!(k, LauncherKind::Hmcl);
        assert!(e[0].contains(".hmcl.json"), "{e:?}");

        let (k, e) = detect(&names(&["PCL", "saves", "mods"]));
        assert_eq!(k, LauncherKind::Pcl);
        assert!(e[0].contains("PCL"), "{e:?}");

        let (k, e) = detect(&names(&["instance.cfg", "mmc-pack.json", "minecraft"]));
        assert_eq!(k, LauncherKind::Prism);
        assert!(e[0].contains("instance.cfg"), "{e:?}");
    }

    /// ★ 认不出是谁，但**有游戏数据** —— 那也得能搬（这才是最常见的"别人给我一个 .minecraft"）
    #[test]
    fn an_anonymous_folder_with_data_is_still_importable() {
        let (k, e) = detect(&names(&["saves", "mods", "options.txt"]));
        assert_eq!(k, LauncherKind::Generic);
        assert!(e.iter().any(|x| x.contains("saves")), "{e:?}");
        // 依据要**指名道姓**（说得出看见了什么），不能只说"有数据"
        assert!(e.iter().any(|x| x.contains("mods")), "{e:?}");
    }

    /// 只有游戏本体（versions/libraries/assets）→ 不值得搬，如实说认不出来
    #[test]
    fn a_folder_with_only_game_files_is_not_importable() {
        let (k, e) = detect(&names(&["versions", "libraries", "assets"]));
        assert_eq!(k, LauncherKind::Unknown);
        assert!(e.is_empty());
        assert_eq!(k.display(), "认不出来");
        // ★ 没内容时**一个数据目录都不许报**（搬 0 个文件却说自己成功了，是最坏的假话）
        assert!(!has_game_data(&names(&["versions", "libraries", "assets"])));
    }

    /// Prism 的顺序：**实例目录**（有 instance.cfg）不能因为里面有 minecraft/ 就先被当成游戏目录
    #[test]
    fn a_prism_instance_is_recognised_before_its_inner_game_dir() {
        let outer = names(&["instance.cfg", "mmc-pack.json", "minecraft", ".gitignore"]);
        assert_eq!(detect(&outer).0, LauncherKind::Prism);
        // 它自己不算"有游戏数据"（instance.cfg 不是游戏数据）
        assert!(!has_game_data(&outer));
        /*
         * ★ 而且游戏目录**不是它自己**，是里面的 `minecraft/`。
         *   第一版这里写的是 `Some("")` —— 于是导入会把 Prism 的配置文件
         *   当游戏数据搬过去（真机探针抓到的）。
         */
        assert_eq!(
            resolve_game_dir(&outer, |s| s == "minecraft").as_deref(),
            Some("minecraft")
        );
    }

    /// 游戏目录在哪一层：自己优先，其次 `minecraft/`，再次 `.minecraft/`
    #[test]
    fn the_game_dir_is_the_closest_layer_that_has_data() {
        // 自己就是游戏目录
        let own = names(&["saves", "mods"]);
        assert_eq!(resolve_game_dir(&own, |_| false).as_deref(), Some(""));
        // 自己不是，里面有个 minecraft/
        let wrapper = names(&["README.txt", "minecraft"]);
        assert_eq!(resolve_game_dir(&wrapper, |s| s == "minecraft").as_deref(), Some("minecraft"));
        // 里面有个 .minecraft/
        let upper = names(&["截图", ".minecraft"]);
        assert_eq!(resolve_game_dir(&upper, |s| s == ".minecraft").as_deref(), Some(".minecraft"));
        // 两层都没有 → 认不出来
        assert_eq!(resolve_game_dir(&names(&["截图"]), |_| false), None);
    }

    /// 数据清单与隔离那边同源（一处改，两处都变）
    #[test]
    fn the_data_list_is_shared_with_isolation() {
        let dirs = data_dirs();
        for d in crate::domain::isolation::SHARED_DIRS {
            assert!(dirs.contains(&d), "少了 {d}");
        }
        assert!(dirs.contains(&"options.txt"), "options.txt 也是用户的东西");
        // 游戏本体**不在**清单里（搬它们只是白占几个 GB）
        for heavy in ["versions", "libraries", "assets"] {
            assert!(!dirs.contains(&heavy), "{heavy} 不该搬");
        }
    }
}
