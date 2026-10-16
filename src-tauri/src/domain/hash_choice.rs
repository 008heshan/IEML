//! **校验值的选择与"为什么没有校验值"**（审计：`None` 不能悄悄等于成功）—— 纯逻辑。
//!
//! ## 这个模块存在的理由（三件事被一个空串挤成了一件）
//!
//!   以前"没有校验值"只有一个表达：`DownloadTask.sha1 == ""`。而它其实盖住了
//!   **三件处置完全不同**的事：
//!
//!   1. **上游确实没发布校验值**（老加载器条目、`.mrpack` 里没给哈希的文件）
//!      —— 这是**事实**：无事可做，落位但如实记账；
//!   2. **上游只给了我们不支持的算法**（CurseForge 的 `algo = 2` = MD5）
//!      —— 这是**我们的缺口**：值得记下来（以后支持 MD5 或换源）；
//!   3. **清单里有校验值、但我们没解析出来** —— 这是**我们的 bug 信号**，最该显眼。
//!
//!   三者都被当成"跳过校验、当作成功"之后，第 3 态就**永远查不出来** ——
//!   而这正是审计那句话（*`None` must not silently become "skip verification
//!   and assume success"*）要防的形状。
//!
//! ## 接口为什么是"切片"而不是"闭包"
//!
//!   第一版写成 `FnMut(&str) -> Option<&'a str>` + `FnMut(&str) -> bool` 两个闭包，
//!   想让本模块"连 JSON 长什么样都不用知道"。结果是**调用方与测试都要跟生命周期
//!   搏斗**（`iter().find(..)` 拿到的是 `&&(&str, &str)`，还得解引用），
//!   而真正复杂的东西一点没少 —— 判据仍然要调用方那边拼。
//!   ⇒ 改成收 `&[(&str, &str)]`：调用方一行 `.collect()` 就能喂进来，
//!     测试直接写一个字面量数组。**接口更小、更难写错**（这就是"深"）。
//!
//! ## 为什么 SHA-512 优先
//!
//!   Modrinth 的 `version.files[].hashes` **同时**发布 `sha512` 与 `sha1`
//!   （官方必填字段）。两个都在时用**强的那个**（SHA-512）——
//!   这也是官方文档自己的建议顺序。Mojang 这一代只有 SHA-1，
//!   CurseForge 是 `1=SHA1 / 2=MD5`（见 `net/curseforge.rs` 的实测记录）。
//!
//! ## 零 `crate::` 依赖
//!
//!   这里只用 `sha1` / `sha2` 与 `std` —— 于是能被 `rustc` 单独编成小程序
//!   跑断言（本机 `cargo test --lib` 在加载阶段就退出，见项目记忆）。

use serde::{Deserialize, Serialize};
use sha1::Digest as _;
use std::path::Path;

/// 期望的校验值（对象是"**数据**"，不是"一个总是 SHA-1 的字符串"）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ExpectedHash {
    /// SHA-1（Mojang 的清单/库/资源、CurseForge 的 `algo=1`）
    Sha1(String),
    /// SHA-512（Modrinth 同时发布，比 SHA-1 强）—— **优先选它**
    Sha512(String),
    /// **没有可用的校验值** —— 具体是"哪一态"看 [`UnverifiedReason`]
    None,
}

impl ExpectedHash {
    /// 有没有一个**能用来比对**的值。
    pub fn is_some(&self) -> bool {
        !matches!(self, Self::None)
    }

    /// **上游确实没有发布校验值**这一档（与 `is_some` 互为反面）。
    ///
    /// ★ 单独给一个名字（而不是让调用方写 `!is_some()`）：这个判断在
    ///   "如实上报未经校验的文件"那段代码里出现得多，而
    ///   `!x.is_some()` 读起来像"没有值"，容易与
    ///   "解析失败所以是空的"混为一谈 —— 这里的语义是**事实**，不是缺陷。
    pub fn is_none(&self) -> bool {
        matches!(self, Self::None)
    }

    /// 校验值本身（`None` 时是空串）
    pub fn value(&self) -> &str {
        match self {
            Self::Sha1(v) | Self::Sha512(v) => v,
            Self::None => "",
        }
    }

    /// 算法名（给日志与错误文案用）
    pub fn algo(&self) -> &'static str {
        match self {
            Self::Sha1(_) => "SHA1",
            Self::Sha512(_) => "SHA512",
            Self::None => "（无）",
        }
    }

    /// 算一个文件，看它**对不对**。`None` 一律返回 `None`（= 无从判断）。
    ///
    /// ★ 同步实现（纯 `std::fs` + digest）—— 于是本模块能整体单编验证。
    ///   调用方（`net/download.rs`）的异步壳只是把这个包进 `spawn_blocking`。
    pub fn verify_file_sync(&self, path: &Path) -> Option<bool> {
        match self {
            Self::None => None,
            Self::Sha1(want) => hash_file_hex(path, HashAlgo::Sha1)
                .ok()
                .map(|got| got.eq_ignore_ascii_case(want)),
            Self::Sha512(want) => hash_file_hex(path, HashAlgo::Sha512)
                .ok()
                .map(|got| got.eq_ignore_ascii_case(want)),
        }
    }

    /// 算一个文件的实际值（错误信息要说"实际是多少"）
    pub fn actual_of_sync(&self, path: &Path) -> Option<String> {
        match self {
            Self::None => None,
            Self::Sha1(_) => hash_file_hex(path, HashAlgo::Sha1).ok(),
            Self::Sha512(_) => hash_file_hex(path, HashAlgo::Sha512).ok(),
        }
    }

    /// 从一个老口径的 `sha1` 字符串来（空串 = `None`）
    pub fn from_sha1(s: &str) -> Self {
        if s.is_empty() {
            Self::None
        } else {
            Self::Sha1(s.to_string())
        }
    }
}

/// 支持的哈希算法（算文件、比字符串都用它）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HashAlgo {
    Sha1,
    Sha512,
}

impl HashAlgo {
    /// 小写十六进制串的长度（用于"这看起来是不是一个合法的摘要"）
    pub fn hex_len(self) -> usize {
        match self {
            Self::Sha1 => 40,
            Self::Sha512 => 128,
        }
    }
}

/// **算一个文件的摘要（小写十六进制）—— 本仓库唯一那处实现。**
///
///   `net/download.rs` 的 `sha1_of_file` / `sha512_of_file`（异步）与
///   `ExpectedHash` 的校验**都走这里**，免得"算哈希"有两份实现
///   （那是"改了这边忘了那边"的经典来源）。
pub fn hash_file_hex(path: &Path, algo: HashAlgo) -> std::io::Result<String> {
    use std::io::Read as _;
    let mut f = std::fs::File::open(path)?;
    let mut buf = vec![0u8; 64 * 1024];
    match algo {
        HashAlgo::Sha1 => {
            let mut h = sha1::Sha1::new();
            loop {
                let n = f.read(&mut buf)?;
                if n == 0 {
                    break;
                }
                h.update(&buf[..n]);
            }
            Ok(hex_of(&h.finalize()))
        }
        HashAlgo::Sha512 => {
            use sha2::Digest as _;
            let mut h = sha2::Sha512::new();
            loop {
                let n = f.read(&mut buf)?;
                if n == 0 {
                    break;
                }
                h.update(&buf[..n]);
            }
            Ok(hex_of(&h.finalize()))
        }
    }
}

fn hex_of(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// 字符串看起来是不是一个**合法的十六进制摘要**（长度 + 只含 `0-9a-fA-F`）。
///
/// ★ 为什么必须判它：`{"sha512": ""}` / `{"sha1": "N/A"}` 这类值是**"字段在、
///   内容不是摘要"**。把它们当成"合法哈希"会出现最糟的一种行为：
///   我们拿一个永远匹配不上的期望值去比 —— 于是文件**每次都被判坏、每次重下**，
///   而错误信息说"校验不符"，看起来像源上的文件坏了。
fn looks_like_hex_digest(s: &str, algo: HashAlgo) -> bool {
    let t = s.trim();
    t.len() == algo.hex_len() && t.bytes().all(|b| b.is_ascii_hexdigit())
}

/// **上游给了一张哈希表（Modrinth 的 `hashes`）时：选哪一个、选不到时是哪一态。**
///
///   优先级：**sha512 > sha1**（两个都在时用强的那个）。
///   `pairs` 就是那张表本身（键、值），调用方一行 `.collect()` 就能喂进来。
pub fn choose_from_hashes(pairs: &[(&str, &str)]) -> Result<ExpectedHash, UnverifiedReason> {
    let get = |k: &str| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| *v);
    let has = |k: &str| pairs.iter().any(|(n, _)| *n == k);

    // ① SHA-512 优先
    if has("sha512") {
        return match get("sha512") {
            Some(v) if looks_like_hex_digest(v, HashAlgo::Sha512) => {
                Ok(ExpectedHash::Sha512(v.trim().to_ascii_lowercase()))
            }
            _ => Err(UnverifiedReason::MissingField), // 字段在、值不是摘要 ⇒ 我们的解析缺口
        };
    }
    // ② 再看 SHA-1
    if has("sha1") {
        return match get("sha1") {
            Some(v) if looks_like_hex_digest(v, HashAlgo::Sha1) => {
                Ok(ExpectedHash::Sha1(v.trim().to_ascii_lowercase()))
            }
            _ => Err(UnverifiedReason::MissingField),
        };
    }
    // ③ 一个都没有 ⇒ **上游确实没发布**（事实，不是我们的缺口）
    Err(UnverifiedReason::NotPublished)
}

/// **CurseForge 那种"算法 id + 值"的列表**：选哪一个、选不到时是哪一态。
///
///   `pairs` 里每一条是 `(算法 id, 值)`（`1 = SHA1`、`2 = MD5` —— 见
///   `net/curseforge.rs` 的实测记录）。
///   ★ MD5 落到 [`UnverifiedReason::UnsupportedAlgorithm`]：
///   那是**我们的缺口**，不许伪装成"上游没发布"。
pub fn choose_from_algo_list(pairs: &[(i64, &str)]) -> Result<ExpectedHash, UnverifiedReason> {
    if pairs.is_empty() {
        return Err(UnverifiedReason::NotPublished);
    }
    let mut saw_unsupported = false;
    let mut sha1_value: Option<&str> = None;
    for (algo, value) in pairs {
        match algo {
            1 => {
                if sha1_value.is_none() {
                    sha1_value = Some(value);
                }
            }
            // 2 = MD5（本仓库实测）—— 以及任何将来出现的、我们不认识的算法
            _ => saw_unsupported = true,
        }
    }
    if let Some(v) = sha1_value {
        if looks_like_hex_digest(v, HashAlgo::Sha1) {
            return Ok(ExpectedHash::Sha1(v.trim().to_ascii_lowercase()));
        }
        return Err(UnverifiedReason::MissingField);
    }
    // 有哈希条目、但一条都不是我们支持的算法（CF 只给 MD5 就是这一档）
    if saw_unsupported {
        return Err(UnverifiedReason::UnsupportedAlgorithm);
    }
    Err(UnverifiedReason::NotPublished)
}

/// **为什么这个文件没有可用的校验值**（三态；中文措辞是**给用户看的那一层**）。
///
///   ★ 与 `ExpectedHash::None` 的关系：`None` 是"结论"（没有值可比），
///     `UnverifiedReason` 是"**为什么**"（三态）。两者一起才说得清。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum UnverifiedReason {
    /// ① 上游确实没发布校验值 —— 事实，无事可做
    NotPublished,
    /// ② 上游只给了我们不支持的算法（CurseForge 的 MD5）—— **我们的缺口**
    UnsupportedAlgorithm,
    /// ③ 清单里有校验值、但我们没解析出来 —— **我们的 bug 信号**
    MissingField,
}

impl UnverifiedReason {
    /// **给用户看的一句话**（中文、说人话；界面与任务详情直接显示这句）
    pub fn user_text(self) -> &'static str {
        match self {
            Self::NotPublished => "这个来源没有公布校验值，无法核对文件是否完整",
            Self::UnsupportedAlgorithm => {
                "这个来源只提供了我们不支持的校验方式（例如 MD5），暂时无法核对"
            }
            Self::MissingField => "安装清单里的校验值没能读出来，这可能是启动器的问题",
        }
    }

    /// **工程师向的措辞**（日志/注释；说清"该谁修"）
    pub fn engineer_text(self) -> &'static str {
        match self {
            Self::NotPublished => {
                "上游清单里确实没有 sha1/sha512 字段（事实，不是缺陷）：落位但不校验"
            }
            Self::UnsupportedAlgorithm => {
                "上游给了校验值，但算法不在支持范围（CF algo=2 是 MD5）—— \
                 我们的缺口：要么支持 MD5，要么换一个带 sha1 的源"
            }
            Self::MissingField => {
                "清单里**有**校验字段，但我们没解析出合法摘要（空串/非十六进制）—— \
                 我们的 bug 信号，最该督办"
            }
        }
    }

    /// 这一态是不是"**我们的问题**"（②③ 都是；① 不是）—— 批次层据此显眼报出来
    pub fn is_our_gap(self) -> bool {
        matches!(self, Self::UnsupportedAlgorithm | Self::MissingField)
    }
}

/// **从"老口径"的 `sha1` 字符串 + 一个显式原因**，得出结论与理由。
///
///   给那些"上游根本没给哈希表"的构造点用（Mojang 的库条目没给、
///   `commands_real.rs` 的整合包补齐路径等）。
pub fn from_legacy_sha1(
    sha1: &str,
    reason_if_absent: UnverifiedReason,
) -> Result<ExpectedHash, UnverifiedReason> {
    let t = sha1.trim();
    if looks_like_hex_digest(t, HashAlgo::Sha1) {
        return Ok(ExpectedHash::Sha1(t.to_ascii_lowercase()));
    }
    if t.is_empty() {
        return Err(reason_if_absent);
    }
    // 有值但不是合法摘要 ⇒ 我们的解析缺口（第③态）
    Err(UnverifiedReason::MissingField)
}

#[cfg(test)]
mod tests {
    use super::*;

    /* ---------- 优先级：sha512 > sha1 ---------- */

    #[test]
    fn prefers_sha512_over_sha1() {
        let strong = "a".repeat(128);
        let weak = "b".repeat(40);
        let pairs = [("sha512", strong.as_str()), ("sha1", weak.as_str())];
        let got = choose_from_hashes(&pairs).expect("两个都在时必须能选出强的那个");
        assert_eq!(got.algo(), "SHA512", "★ 两个都在时必须用 SHA-512（更强）");
        assert_eq!(got.value(), strong);
    }

    #[test]
    fn falls_back_to_sha1_when_that_is_all_there_is() {
        let weak = "b".repeat(40);
        let pairs = [("sha1", weak.as_str())];
        let got = choose_from_hashes(&pairs).expect("只有 sha1 时用它");
        assert_eq!(got.algo(), "SHA1");
    }

    /// ★ 空的 sha512 字段**不许**变成合法哈希（那会让文件永远校验失败）。
    #[test]
    fn empty_sha512_is_not_treated_as_a_valid_hash() {
        let weak = "b".repeat(40);
        let pairs = [("sha512", ""), ("sha1", weak.as_str())];
        match choose_from_hashes(&pairs) {
            // 本实现的选择：字段在、值不合法 ⇒ 第③态（我们的解析缺口），**显眼**
            Err(UnverifiedReason::MissingField) => {}
            // 另一种可接受的设计是"退到 sha1"；但**绝不接受** Ok(空串)
            Ok(ExpectedHash::Sha1(v)) => assert_eq!(v.len(), 40),
            other => panic!("空的 sha512 不许变成合法哈希：{other:?}"),
        }
    }

    /* ---------- 三态 ---------- */

    #[test]
    fn not_published_is_the_fact_state() {
        let nothing: [(&str, &str); 0] = [];
        assert_eq!(
            choose_from_hashes(&nothing),
            Err(UnverifiedReason::NotPublished)
        );
        assert!(!UnverifiedReason::NotPublished.is_our_gap(), "① 不是我们的缺口");
    }

    #[test]
    fn unsupported_algorithm_is_our_gap() {
        // CF：只有 algo = 2（MD5）
        let pairs = [(2i64, "d41d8cd98f00b204e9800998ecf8427e")];
        assert_eq!(
            choose_from_algo_list(&pairs),
            Err(UnverifiedReason::UnsupportedAlgorithm),
            "★ MD5 不许伪装成「上游没发布」—— 那是我们的缺口"
        );
        assert!(UnverifiedReason::UnsupportedAlgorithm.is_our_gap());
    }

    #[test]
    fn algo_list_prefers_sha1_regardless_of_order() {
        let weak = "c".repeat(40);
        let pairs = [(2i64, "d41d8cd98f00b204e9800998ecf8427e"), (1, weak.as_str())];
        let got = choose_from_algo_list(&pairs).expect("有 algo=1 就该用它");
        assert_eq!(got.algo(), "SHA1");
    }

    #[test]
    fn algo_list_with_nothing_is_not_published() {
        let nothing: [(i64, &str); 0] = [];
        assert_eq!(
            choose_from_algo_list(&nothing),
            Err(UnverifiedReason::NotPublished)
        );
    }

    #[test]
    fn missing_field_is_our_bug_signal() {
        // 字段在、值是垃圾（不是十六进制摘要）
        let junk = [("sha1", "N/A")];
        assert_eq!(
            choose_from_hashes(&junk),
            Err(UnverifiedReason::MissingField)
        );
        assert!(UnverifiedReason::MissingField.is_our_gap());
        // 长度不对也是"解析缺口"
        let short = [("sha1", "abc")];
        assert_eq!(
            choose_from_hashes(&short),
            Err(UnverifiedReason::MissingField)
        );
    }

    #[test]
    fn legacy_sha1_maps_to_the_right_state() {
        // 合法 sha1（大小写都认，统一成小写）
        assert_eq!(
            from_legacy_sha1(&"A".repeat(40), UnverifiedReason::NotPublished),
            Ok(ExpectedHash::Sha1("a".repeat(40)))
        );
        // 空串 ⇒ 调用方指定的那一态（"上游没发布"是默认口径）
        assert_eq!(
            from_legacy_sha1("", UnverifiedReason::NotPublished),
            Err(UnverifiedReason::NotPublished)
        );
        // 有值但不是摘要 ⇒ 第③态（覆盖调用方给的那一态）
        assert_eq!(
            from_legacy_sha1("oops", UnverifiedReason::NotPublished),
            Err(UnverifiedReason::MissingField)
        );
    }

    /* ---------- 三态的文案（给用户看的那一层） ---------- */

    #[test]
    fn every_state_has_a_plain_chinese_sentence() {
        for r in [
            UnverifiedReason::NotPublished,
            UnverifiedReason::UnsupportedAlgorithm,
            UnverifiedReason::MissingField,
        ] {
            let u = r.user_text();
            assert!(!u.is_empty(), "每一态都要有给用户看的话");
            assert!(
                u.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c)),
                "给用户看的那一层必须是中文：{u}"
            );
            assert!(!r.engineer_text().is_empty());
        }
        let mut all = vec![
            UnverifiedReason::NotPublished.user_text(),
            UnverifiedReason::UnsupportedAlgorithm.user_text(),
            UnverifiedReason::MissingField.user_text(),
        ];
        all.sort_unstable();
        let before = all.len();
        all.dedup();
        assert_eq!(all.len(), before, "三种话不许有重复");
    }

    /* ---------- 算文件（同步实现，本机真能跑） ---------- */

    #[test]
    fn hash_file_matches_known_vectors_and_verifies() {
        let dir = std::env::temp_dir().join(format!("ieml-hashchoice-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let f = dir.join("a.txt");
        std::fs::write(&f, b"abc").unwrap();

        // 已知向量：SHA-1("abc") / SHA-512("abc")
        let sha1 = hash_file_hex(&f, HashAlgo::Sha1).unwrap();
        assert_eq!(sha1, "a9993e364706816aba3e25717850c26c9cd0d89d");
        let sha512 = hash_file_hex(&f, HashAlgo::Sha512).unwrap();
        assert_eq!(sha512.len(), 128);
        assert!(sha512.starts_with("ddaf35a193617aba"));

        // 对得上 ⇒ Some(true)；对不上 ⇒ Some(false)；None ⇒ None
        assert_eq!(
            ExpectedHash::Sha1(sha1.clone()).verify_file_sync(&f),
            Some(true)
        );
        assert_eq!(
            ExpectedHash::Sha512(sha512.clone()).verify_file_sync(&f),
            Some(true),
            "★ SHA-512 必须能真的验（这是「接线」的判据）"
        );
        assert_eq!(
            ExpectedHash::Sha512("0".repeat(128)).verify_file_sync(&f),
            Some(false)
        );
        assert_eq!(ExpectedHash::None.verify_file_sync(&f), None);
        // 大小写不敏感
        assert_eq!(
            ExpectedHash::Sha1(sha1.to_ascii_uppercase()).verify_file_sync(&f),
            Some(true)
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
