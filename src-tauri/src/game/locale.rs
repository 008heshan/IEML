/**
 * 首次启动时把游戏语言设成中文
 * ------------------------------------------------------------------
 * 用户 2026-09-15："我希望在玩家首次启动游戏时，游戏语言默认是中文"。
 *
 * ## 为什么是启动器该做的事
 *
 *   原版 Minecraft **永远**默认英文（它不跟随系统语言）。新玩家第一次进去看到的是
 *   `Singleplayer / Multiplayer / Options`，很多人第一件事就是去翻语言菜单 ——
 *   PCL 也是启动器替玩家写好这一项。
 *
 * ## 两条硬规矩（定这个功能时最先要定下来的）
 *
 *   ① **只在玩家还没选过语言时才写。**
 *      `options.txt` 里已经有 `lang:` 就**一个字节都不动** ——
 *      玩家把语言改成英文/日文之后再启动，启动器把他的选择改回去，
 *      那是比"没帮他设"严重得多的事。
 *   ② **语言代码跟着游戏版本走。**
 *      1.11 起 Minecraft 的语言代码是全小写（`zh_cn`），1.11 之前是 `zh_CN`。
 *      写错了游戏会当成无效值、**静默回落到英文** —— 看起来就是"这功能没生效"。
 *      （本机就同时有 1.7.10 和 1.12.2 两个实例，正好跨在这条线上。）
 */
use std::path::Path;

/// 1.11 起语言代码改成全小写（`zh_cn`），之前是 `zh_CN`
const LOWERCASE_LOCALE_SINCE: &str = "1.11";

/// 这次为某个游戏目录做了什么事（写进启动日志，便于排查"为什么语言没变"）
#[derive(Debug, PartialEq)]
pub enum LocaleAction {
    /// 建了新的 `options.txt`（首次启动）
    Created,
    /// 文件在、但没有 `lang:` 这一行（别的程序建的），补了一行
    Appended,
    /// 文件里已经有语言设置 —— **原样不动**
    LeftAlone,
}

/// 该用哪个语言代码
pub fn chinese_locale_for(mc_version: &str) -> &'static str {
    use crate::domain::version::compare_version;
    use std::cmp::Ordering;
    match compare_version(mc_version, LOWERCASE_LOCALE_SINCE) {
        // ★ 比不出来（版本号形状怪）时按**新格式**写：现在的版本占绝大多数，
        //   而且写错的时代价是"回落到英文"，比"给老版本写新代码"影响面小。
        Ordering::Less => "zh_CN",
        _ => "zh_cn",
    }
}

/// 首次启动时把语言设成中文（**绝不覆盖玩家已有的选择**）。
///
/// 返回做了什么，交给调用方写日志。
pub fn ensure_chinese_language(game_dir: &Path, mc_version: &str) -> std::io::Result<LocaleAction> {
    let locale = chinese_locale_for(mc_version);
    let options = game_dir.join("options.txt");

    match std::fs::read_to_string(&options) {
        Ok(text) => {
            /*
             * 文件在。只有在**完全没有 lang 行**时才补一行 ——
             * 有 lang 行（不管是什么语言）就说明玩家选过，一个字节都不动。
             */
            let has_lang = text
                .lines()
                .any(|l| l.trim_start().starts_with("lang:"));
            if has_lang {
                return Ok(LocaleAction::LeftAlone);
            }
            let mut next = text;
            if !next.is_empty() && !next.ends_with('\n') {
                next.push('\n');
            }
            next.push_str(&format!("lang:{locale}\n"));
            std::fs::write(&options, next)?;
            Ok(LocaleAction::Appended)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            /*
             * 首次启动：游戏目录里还没有 options.txt。
             *
             * ★ 只写 `lang:` 一行是**安全**的：原版读这份文件时，
             *   认识的键就用、不认识的忽略、缺的键用默认值，进游戏后
             *   它自己会把整份补全并写回来（实测过很多次的行为）。
             *   所以不需要（也不该）在这里伪造一整份 options.txt ——
             *   那等于把我们对某个版本的默认值猜测强加给玩家。
             */
            std::fs::write(&options, format!("lang:{locale}\n"))?;
            Ok(LocaleAction::Created)
        }
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("ieml-locale-{name}"));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn language_code_follows_the_game_version() {
        // 1.11 是分界线（本机正好同时有 1.7.10 和 1.12.2）
        assert_eq!(chinese_locale_for("1.7.10"), "zh_CN");
        assert_eq!(chinese_locale_for("1.8.9"), "zh_CN");
        assert_eq!(chinese_locale_for("1.10.2"), "zh_CN");
        assert_eq!(chinese_locale_for("1.11"), "zh_cn");
        assert_eq!(chinese_locale_for("1.12.2"), "zh_cn");
        assert_eq!(chinese_locale_for("1.20.1"), "zh_cn");
        assert_eq!(chinese_locale_for("26.2"), "zh_cn");
    }

    #[test]
    fn first_launch_creates_options_with_chinese() {
        let dir = tmp_dir("fresh");
        let action = ensure_chinese_language(&dir, "1.20.1").unwrap();
        assert_eq!(action, LocaleAction::Created);
        let text = std::fs::read_to_string(dir.join("options.txt")).unwrap();
        assert_eq!(text, "lang:zh_cn\n");
    }

    #[test]
    fn first_launch_on_an_old_version_uses_the_old_code() {
        let dir = tmp_dir("old");
        ensure_chinese_language(&dir, "1.7.10").unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("options.txt")).unwrap(),
            "lang:zh_CN\n"
        );
    }

    /// ★★ 最重要的一条：玩家选过语言就**一个字节都不许动**。
    #[test]
    fn existing_language_choice_is_never_overwritten() {
        let dir = tmp_dir("keep");
        let original = "lang:en_us\nfov:0.5\nmouseSensitivity:0.5\n";
        std::fs::write(dir.join("options.txt"), original).unwrap();

        let action = ensure_chinese_language(&dir, "1.20.1").unwrap();
        assert_eq!(action, LocaleAction::LeftAlone);
        assert_eq!(
            std::fs::read_to_string(dir.join("options.txt")).unwrap(),
            original,
            "玩家已经选过语言，文件必须逐字节不变"
        );
    }

    #[test]
    fn appends_lang_when_the_file_has_none() {
        let dir = tmp_dir("append");
        std::fs::write(dir.join("options.txt"), "fov:0.5\n").unwrap();
        let action = ensure_chinese_language(&dir, "1.20.1").unwrap();
        assert_eq!(action, LocaleAction::Appended);
        let text = std::fs::read_to_string(dir.join("options.txt")).unwrap();
        assert!(text.starts_with("fov:0.5\n"), "原有内容要保留：{text}");
        assert!(text.contains("lang:zh_cn"), "{text}");
    }

    /// 文件末尾没有换行时不能把两行粘在一起（`fov:0.5lang:zh_cn` 会被整行忽略）
    #[test]
    fn append_respects_a_missing_trailing_newline() {
        let dir = tmp_dir("nonl");
        std::fs::write(dir.join("options.txt"), "fov:0.5").unwrap();
        ensure_chinese_language(&dir, "1.20.1").unwrap();
        let text = std::fs::read_to_string(dir.join("options.txt")).unwrap();
        assert_eq!(text, "fov:0.5\nlang:zh_cn\n");
    }
}
