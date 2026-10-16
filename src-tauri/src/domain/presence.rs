//! **在线状态**：服务端报的那几个取值、"这一行到底说了什么"、以及一份名单压成一行
//! 诊断文字 —— 纯逻辑，零 `crate::` 依赖。
//!
//! ## 这个模块为什么存在（2026-10-17 修「好友游戏在线，启动器读不到」）
//!
//!   用户原话：「**我的朋友游戏在线，但启动器读不到**」——好友页 10 个人全显示「离线」。
//!   这条链上有三处"把**不知道**说成**离线**"，其中两处在 Rust 这边：
//!
//!   ① **未知状态值毁掉整行**：`PresenceStatus` 是严格枚举，服务端只要冒出一个
//!      我们没见过的取值（或字段类型漂了），`serde_json::from_str::<PresenceResponse>`
//!      就整份失败 —— 而旧实现写的是
//!      `unwrap_or(PresenceResponse { presence: Vec::new() })`，
//!      于是"解析失败"被**静默**变成"没人在线" ⇒ 好友全离线。
//!      ⇒ 现在：wire 上的 `status` **按字符串收**（[`PresenceWireRow`]），
//!        再由 [`parse_presence_status`] 译成枚举；认不出来的取值**只让这一行没状态**，
//!        整行照样留着（"他在服务端的在场名单里"这件事比"他在干什么"重要得多）。
//!   ② **解析失败要如实报错**：见 [`safe_excerpt`] —— 带一段原文摘录（单行化、
//!      截断、**抹掉令牌形状的东西**），不许伪造空名单。
//!
//! ## 为什么不用 `#[serde(other)]` 给枚举加兜底档（试过，实测数据在下面）
//!
//!   `#[serde(other)]` 在外置标签的枚举上**确实能用**（本机试过：未知取值解析成
//!   兜底档、不报错）。但 `PresenceStatus` **既要 `Deserialize` 也要 `Serialize`**
//!   （`POST /presence` 的请求体、以及给界面的 `PresenceRow.status` 都是它），
//!   而兜底档被序列化时会按 `rename_all` 吐出一个**我们自己编的 wire 值**：
//!
//!   ```text
//!   enum St { Online, #[serde(other)] Unknown }   // rename_all = SCREAMING_SNAKE_CASE
//!   serde_json::to_string(&St::Unknown)  ⇒  "\"UNKNOWN\""
//!   ```
//!
//!   那个 `"UNKNOWN"` 服务端从没说过，前端 `PresenceStatus` 里也没有它 ——
//!   等于**凭空往协议里加了一个取值**（"wire 值一个字都不能改"这条红线）。
//!   ⇒ 选了另一条路：wire 层收字符串、映射失败的**落在 `None`**，
//!     而 `None` 在界面上的含义是「在名单里，但不知道他在干什么」（见前端
//!     `domain/friends.ts::resolvePresence`）。
//!
//! ## 为什么能单独编译来跑真断言
//!
//!   这台机器上 `cargo test --lib` 的测试二进制在**加载阶段**就退出
//!   （`0xc0000139 STATUS_ENTRYPOINT_NOT_FOUND`，一个测试都跑不到，见项目记忆）。
//!   本模块只用 `serde`，于是可以用
//!   `rustc --edition 2021 -O -C panic=abort --extern serde=… --extern serde_json=…`
//!   把**仓库里这个源文件**单独编成程序跑真断言（`domain/failure.rs` /
//!   `domain/archive_guard.rs` 同款做法）。
//!   ★ 这个能力的前提是**零 `crate::` 依赖**：一旦这里出现 `crate::say!` 之类，
//!     这条路就断了。日志由调用方（`friends::presence`）打。

use serde::{Deserialize, Serialize};

/// 在线状态。取值表来自客户端 authlib 的 `PresenceStatus` 枚举（**一个字都不能改**）。
///
/// ★ 注意它**只描述"认得的取值"**：服务端冒出来的新值不会变成这里的某个档，
///   而是在 [`parse_presence_status`] 里落成 `None`（见模块头部那段说明）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PresenceStatus {
    /// 在线（在启动器 / 在大厅，但没进世界）
    Online,
    /// 在玩**单机**世界
    PlayingOffline,
    /// 在玩 Realms
    PlayingRealms,
    /// 在玩服务器
    PlayingServer,
    /// 在玩**好友开放的世界**（"对局域网开放"那种）
    PlayingHostedServer,
    /// 离线
    Offline,
}

/* ★ 2026-10-17：这里原来有一个"我们上报时用哪一档"的函数（返回 `Online`）。
 *   删掉了 —— 理由是**它描述的行为已经不在 Rust 里发生**：启动器自己的状态是前端
 *   把 `'ONLINE'` 这个字符串交给 `friends_presence` 命令（见 `friends::presence()`
 *   的文档注释，那句话留在那里了）。留一个没人调用的函数只会让人以为
 *   "启动器上报那一档"这件事在后端有实现。
 *   ★ 同时删掉的还有一个"状态 → 中文一句话"的函数 —— 用户能看到的措辞只能有
 *     **一处**说法，而实际说话的是前端 `src/domain/friends.ts` 的
 *     `presenceTone`/`presenceText`；Rust 这一份留着就是第二个措辞源，迟早漂移。
 *   ★ `PresenceStatus` 本体与 `parse_presence_status` **留着**（它们仍在用：
 *     请求体的反序列化 + wire 行 → 枚举）。 */

/// 服务端状态字符串 → 客户端枚举。**认不出来就是 `None`**。
///
/// ★ 这是"要不要因为一个字段把整份名单判死"的**唯一判据**，所以它是纯函数、
///   有判据（本机可用 rustc 单编真跑）。
/// ★ 大小写**敏感**：wire 值就是这些大写常量，服务端真要改成小写，
///   那是协议变了 —— 那时"这一行没状态"（进而在界面上是「在线」）比"整份名单解析失败"
///   安全得多。
pub fn parse_presence_status(raw: &str) -> Option<PresenceStatus> {
    match raw {
        "ONLINE" => Some(PresenceStatus::Online),
        "PLAYING_OFFLINE" => Some(PresenceStatus::PlayingOffline),
        "PLAYING_REALMS" => Some(PresenceStatus::PlayingRealms),
        "PLAYING_SERVER" => Some(PresenceStatus::PlayingServer),
        "PLAYING_HOSTED_SERVER" => Some(PresenceStatus::PlayingHostedServer),
        "OFFLINE" => Some(PresenceStatus::Offline),
        _ => None,
    }
}

/// 服务端回给我们的**一行原文**（`POST /presence` 的 `presence[]`）。
///
/// ★ `status` 刻意是 `Option<String>` 而不是 `Option<PresenceStatus>`：
///   一个没见过/漂了的取值只该让**这一行**没状态，不该把整份响应打掉。
///   `PresenceRow`（给界面的那份）才是映射之后的形状。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PresenceWireRow {
    #[serde(default)]
    pub profile_id: String,
    /// 原值（日志里要照原样打出来 —— 那正是"服务端到底说了什么"的证据）
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub last_updated: Option<i64>,
    #[serde(default)]
    pub pmid: Option<String>,
}

/// 一条在场记录（界面拿到的形状）。
///
/// ★ 它既要能 `Deserialize`（解析服务端的回包）**又要能 `Serialize`** ——
///   因为界面的心跳就是直接调 `friends_presence` 命令，把这份结果拿回去显示。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresenceRow {
    pub profile_id: String,
    #[serde(default)]
    pub status: Option<PresenceStatus>,
    /// 服务端那边的时间戳（我们只需要它来排序/调试，不参与显示）
    #[serde(default)]
    pub last_updated: Option<i64>,
    #[serde(default)]
    pub pmid: Option<String>,
}

/// wire 行 → 界面行。**一行都不丢**：认不出的 `status` 落成 `None`（= 在名单里、不知道在干什么）。
pub fn rows_from_wire(rows: &[PresenceWireRow]) -> Vec<PresenceRow> {
    rows.iter()
        .map(|r| PresenceRow {
            profile_id: r.profile_id.clone(),
            status: r.status.as_deref().and_then(parse_presence_status),
            last_updated: r.last_updated,
            pmid: r.pmid.clone(),
        })
        .collect()
}

/* ★ 2026-10-17：这里原来有一个"在线状态 → 中文一句话"的函数。
 *   删掉了：用户能看到的措辞只能有**一处**说法，而实际说话的是前端
 *   `src/domain/friends.ts` 的 `presenceTone`/`presenceText`（`FriendsPage` 用它渲染）。
 *   Rust 这一份留着就是第二个措辞源 —— 迟早漂移，而"漂移"在这个 bug 里
 *   正是形式之一（同一个状态两处说法）。 */

/* ====================== 诊断：一份名单压成一行（H4 的分界器） ======================
 *
 * ★★★★ 2026-10-17。这个 bug 有**两种完全不同的可能**，而它们在界面上长得一样
 *   （都是"好友显示离线"），必须能在用户复现一次之后就分清：
 *
 *     · **H1/H2（我们的代码）**：服务端**把他列进了在场名单**，而我们没显示成在线
 *       （判定错 / 响应被解析掉）；
 *     · **H4（他那边没上报）**：服务端那份名单里**根本没有他** —— 他的客户端没往
 *       `/presence` 报过（没开游戏、游戏版本不报、或者他的隐私设置）。
 *
 *   [`presence_digest`] 就是分界器：它照原样写出**行数**与**每行的 profileId 前 8 位
 *   + status 原值**。看到它就能这样读：
 *
 *     行数 ≥ 1 且他（对得上前 8 位）在里面 ⇒ 服务端说他在线 ⇒ 我们显示错了 = H1/H2；
 *     0 行                                   ⇒ 服务端说没人在场 ⇒ **H4，不是我们的代码**；
 *     "解析失败"那一行                        ⇒ 响应形状漂了 = H2。
 *
 *   ★ 隐私两条（都只是"少写几个字"，不影响判读）：
 *     profileId 只写**前 8 位**；这里**不可能**出现令牌 —— 令牌只在请求头里，
 *     本函数拿到的只是响应体。
 */

/// 日志里最多列几行（一行日志别写成几万字）
pub const DIGEST_MAX_ROWS: usize = 20;
/// 日志里 profileId 只留前几位（够对上号就行）
pub const DIGEST_ID_PREFIX: usize = 8;

/// 一份在场名单 → 一行诊断文字（**不含**任何前缀，前缀由调用方给）。
pub fn presence_digest(rows: &[PresenceWireRow]) -> String {
    if rows.is_empty() {
        return "0 行（服务端这份名单是空的 ⇒ 它说没有任何好友在场）".to_string();
    }
    let shown = rows.len().min(DIGEST_MAX_ROWS);
    let mut parts: Vec<String> = Vec::with_capacity(shown + 1);
    for r in rows.iter().take(shown) {
        let mut id: String = r.profile_id.chars().take(DIGEST_ID_PREFIX).collect();
        if id.is_empty() {
            id = "<无id>".to_string();
        }
        // status **原值**：认不出来的取值照原样写出来（那正是要看的）
        let st = match r.status.as_deref() {
            Some(s) if !s.is_empty() => s.to_string(),
            _ => "null".to_string(),
        };
        parts.push(format!("{id}={st}"));
    }
    if rows.len() > shown {
        parts.push(format!("…（另有 {} 行未列出）", rows.len() - shown));
    }
    format!("{} 行 · {}", rows.len(), parts.join(" "))
}

/* ====================== 诊断：响应原文的安全摘录 ======================
 *
 * ★ "解析失败"时必须把服务端**实际发了什么**带上一小段 —— 否则这条错误只说
 *   "看不懂"，用户与我们都无从下手（真机上见过"回的是 HTML 登录页"这种）。
 *
 * ★ 但它**绝不能把令牌带出去**：正文里通常没有令牌（令牌在请求头），
 *   但"服务端把 token 回显在正文里"是完全可能发生的，而这段文字会进**给用户看的
 *   提示条**。所以摘录是**保守的**：宁可不显示，也不漏。
 *
 * 判据（有真断言，本机可跑）：
 *   ① 单行化（提示条里不许出现换行）；
 *   ② 认得出的"密钥形状"一律隐去：`Bearer xxx`、`"accessToken":"xxx"`
 *      这类**键名**含 token/secret/password/auth/… 的字段、以及 ≥40 个连续
 *      "像密钥"的字符（不透明长串）；
 *   ③ 长度截断（超长补省略号）。
 */

/// 键名里出现这些词（大小写无关）就当它是敏感字段，值一律隐去
const SECRET_KEY_WORDS: [&str; 7] = [
    "token",
    "secret",
    "password",
    "authorization",
    "credential",
    "signature",
    "cookie",
];

fn looks_like_secret_key(key: &str) -> bool {
    let k = key.to_ascii_lowercase();
    SECRET_KEY_WORDS.iter().any(|w| k.contains(w))
}

/// "像密钥的字符"：base64url + JWT 会用到的那几个
fn is_secret_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '~' | '+' | '/' | '=' | '-')
}

/// 一个 ≥ 这么长的连续"像密钥字符"串，当不透明令牌处理（真令牌都在 100 字符以上；
/// 阈值取 40 是为了**不误伤**正常的字段名与状态值）
pub const OPAQUE_RUN_MIN: usize = 40;

/// 邮箱被隐去后留下的占位（与"密钥"的占位分开写，好让人一眼看出隐掉的是什么）
pub const EMAIL_MASK: &str = "<邮箱已隐去>";

/// 响应原文 → 一行、脱敏、截断的摘录。
pub fn safe_excerpt(raw: &str, max: usize) -> String {
    // ① 单行化（顺带把连续空白压成一个空格）
    let flat = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    // ② 去敏感形状（顺序无所谓，各管各的形状）
    let masked = mask_bearer(&flat);
    let masked = mask_secret_fields(&masked);
    let masked = mask_emails(&masked);
    let masked = mask_opaque_runs(&masked);
    // ③ 截断（按**字符**数，中文字符也算一个）
    let mut out: String = masked.chars().take(max).collect();
    if masked.chars().count() > max {
        out.push('…');
    }
    out
}

/// 邮箱形状（`a.b@c.d` / `someone@outlook.com`）→ [`EMAIL_MASK`]。
///
/// ★ 为什么要它：摘录会进**给用户看的提示条**，而用户常把它截图或粘进 issue ——
///   那时一个邮箱就跟着出去了（账号相关的错误体里真的会有）。
/// ★ 判据是"形状"，不是字段名：`"email":"x@y.z"` 与自由文本里冒出来的
///   `the account x@y.z is …` 都要被隐掉。
/// ★ 保守的收尾判定（少隐不如不误伤）：
///     · `@` 左边至少要有一个局部名字符；
///     · `@` 右边只吃 `[A-Za-z0-9.-]`，且**必须含 `.`**；
///     · 最后那个点后面至少 2 个字符，且**全是字母**（`v1.2.3@x` 这种不算邮箱）。
fn mask_emails(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0usize;
    while i < chars.len() {
        if let Some(end) = email_at(&chars, i) {
            out.push_str(EMAIL_MASK);
            i = end;
            continue;
        }
        // 不是邮箱的一部分 ⇒ 一个字都不改（`a@b` 这种不算邮箱）
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// 从 `i` 开始是不是一个完整邮箱？是就返回它的结束位置（不含），否则 `None`。
fn email_at(chars: &[char], i: usize) -> Option<usize> {
    let mut j = i;
    while j < chars.len() && is_email_local(chars[j]) {
        j += 1;
    }
    if j == i || j >= chars.len() || chars[j] != '@' {
        return None; // `@` 左边没有名字 / 这个 @ 不在邮箱里
    }
    let dom_start = j + 1;
    let mut k = dom_start;
    while k < chars.len() && is_email_domain(chars[k]) {
        k += 1;
    }
    if k == dom_start {
        return None;
    }
    let domain: String = chars[dom_start..k].iter().collect();
    if !is_email_domain_tail(&domain) {
        return None;
    }
    Some(k)
}

fn is_email_local(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '%' | '+' | '-')
}

fn is_email_domain(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '-')
}

/// `x.y.z` 形状才算域名尾巴：含点、不以点开头/结尾、最后一段 ≥2 个字母
fn is_email_domain_tail(domain: &str) -> bool {
    if domain.starts_with('.') || domain.ends_with('.') || !domain.contains('.') {
        return false;
    }
    match domain.rsplit_once('.') {
        Some((_, tld)) => tld.chars().count() >= 2 && tld.chars().all(|c| c.is_ascii_alphabetic()),
        None => false,
    }
}

/// `Bearer <token>` / `bearer <token>` → `Bearer <已隐去>`
fn mask_bearer(s: &str) -> String {
    let lower = s.to_ascii_lowercase();
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0usize;
    while i < s.len() {
        if lower[i..].starts_with("bearer ") {
            out.push_str(&s[i..i + "bearer ".len()]);
            i += "bearer ".len();
            // 令牌一直取到分隔符（空格 / 引号 / 逗号 / 花括号）
            let start = i;
            while i < s.len() {
                let c = bytes[i] as char;
                if c.is_whitespace() || matches!(c, '"' | ',' | '}' | ']') {
                    break;
                }
                i += 1;
            }
            if i > start {
                out.push_str("<已隐去>");
            }
            continue;
        }
        // 逐字符推进（UTF-8 安全：按 char 边界走）
        let ch = s[i..].chars().next().expect("i 落在 char 边界上");
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// `"accessToken":"xxx"` / `"secret": xxx` → 值隐去（键名与结构**原样保留**，
/// 因为"服务端到底回了哪些字段"是诊断信息）
fn mask_secret_fields(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0usize;
    while i < chars.len() {
        if chars[i] != '"' {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        // 找这一段的收尾引号
        let close = match chars[i + 1..].iter().position(|c| *c == '"') {
            Some(rel) => i + 1 + rel,
            None => {
                out.push(chars[i]);
                i += 1;
                continue;
            }
        };
        let key: String = chars[i + 1..close].iter().collect();
        // 后面允许空白，然后必须是 ':' 才算一个字段名
        let mut j = close + 1;
        while j < chars.len() && chars[j].is_whitespace() {
            j += 1;
        }
        if j >= chars.len() || chars[j] != ':' || !looks_like_secret_key(&key) {
            out.push('"');
            out.push_str(&key);
            out.push('"');
            i = close + 1;
            continue;
        }
        // 键名照写（它本身是诊断信息），值换成占位
        out.push('"');
        out.push_str(&key);
        out.push_str("\":");
        let mut k = j + 1;
        while k < chars.len() && chars[k].is_whitespace() {
            k += 1;
        }
        if k < chars.len() && chars[k] == '"' {
            let mut m = k + 1;
            while m < chars.len() && chars[m] != '"' {
                m += 1;
            }
            out.push_str("\"<已隐去>\"");
            i = if m < chars.len() { m + 1 } else { m };
        } else {
            // 非字符串值（数字 / 对象 / 数组）→ 隐去到这一层的分隔符
            let mut m = k;
            while m < chars.len() && !matches!(chars[m], ',' | '}' | ']') {
                m += 1;
            }
            out.push_str("<已隐去>");
            i = m;
        }
    }
    out
}

/// ≥ [`OPAQUE_RUN_MIN`] 的连续"像密钥字符"串 → `<已隐去 N 字符>`
fn mask_opaque_runs(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut run = String::new();
    for ch in s.chars() {
        if is_secret_char(ch) {
            run.push(ch);
        } else {
            flush_opaque(&mut run, &mut out);
            out.push(ch);
        }
    }
    flush_opaque(&mut run, &mut out);
    out
}

fn flush_opaque(run: &mut String, out: &mut String) {
    if run.chars().count() >= OPAQUE_RUN_MIN {
        out.push_str(&format!("<已隐去 {} 字符>", run.chars().count()));
    } else {
        out.push_str(run);
    }
    run.clear();
}

/* ====================== 判据 ======================
 *
 * ★★ 本机 `cargo test --lib` **跑不了**（测试二进制加载阶段就退出，
 *    `0xc0000139`，一个测试都跑不到 —— 项目记忆里有记录）。
 *    所以这些断言在本机是**写了未运行**的；同一批判据另有一份用 rustc
 *    把本文件单独编译后真跑的版本（见模块头部"为什么能单独编译"）。
 *    ⇒ 改动这里的判据时，两份都要跟着改。
 */

#[cfg(test)]
mod tests {
    use super::*;

    /* ---------- ① 状态字符串 → 枚举 ---------- */

    #[test]
    fn known_wire_values_map_to_the_client_enum() {
        let cases = [
            ("ONLINE", PresenceStatus::Online),
            ("PLAYING_OFFLINE", PresenceStatus::PlayingOffline),
            ("PLAYING_REALMS", PresenceStatus::PlayingRealms),
            ("PLAYING_SERVER", PresenceStatus::PlayingServer),
            ("PLAYING_HOSTED_SERVER", PresenceStatus::PlayingHostedServer),
            ("OFFLINE", PresenceStatus::Offline),
        ];
        for (wire, want) in cases {
            assert_eq!(parse_presence_status(wire), Some(want), "wire 值={wire}");
        }
    }

    /// ★★★★ 这条就是"好友在线却显示离线"的 Rust 半边：
    ///   服务端冒出没见过/漂了的取值时，**这一行必须留着**（只是没状态）。
    #[test]
    fn unknown_wire_value_does_not_kill_the_row() {
        assert_eq!(parse_presence_status("SOMETHING_BRAND_NEW"), None);
        assert_eq!(parse_presence_status("online"), None, "大小写漂了也不认（但也不炸）");
        assert_eq!(parse_presence_status(""), None);

        let wire = vec![PresenceWireRow {
            profile_id: "bbbb1111bbbb1111bbbb1111bbbb1111".into(),
            status: Some("SOMETHING_BRAND_NEW".into()),
            last_updated: None,
            pmid: None,
        }];
        let rows = rows_from_wire(&wire);
        assert_eq!(rows.len(), 1, "★ 一行都不许丢");
        assert_eq!(rows[0].profile_id, "bbbb1111bbbb1111bbbb1111bbbb1111");
        // 没有具体状态 ⇒ None ⇒ 界面上是"在名单里但不知道在干什么"（见 resolvePresence）
        assert_eq!(rows[0].status, None);
    }

    /// 一行**只有 profileId**（没有 status）时，这一行照样要留 —— 那正说明"他在场"。
    #[test]
    fn a_row_without_status_is_still_a_row() {
        let wire: Vec<PresenceWireRow> =
            serde_json::from_str(r#"[{"profileId":"aaaa1111aaaa1111aaaa1111aaaa1111"}]"#).unwrap();
        let rows = rows_from_wire(&wire);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].status, None);
    }

    /* ★ "wire 值一个字都不能改"那条判据（`presence_wire_values_match_the_client_enum`）
       留在 `friends.rs` 里 —— 它盯的是**对外那条路**（`friends::PresenceStatus`）。
       定义处的同一批字面量在 rustc 单编那份真跑里也验了一遍。 */

    /* ★ 这里原来有一条钉住"启动器上报用哪一档"那个函数的用例。函数删了，
       判据跟着走 —— "启动器只报 ONLINE"这句话现在写在 `friends::presence()`
       的文档注释里（它描述的是**调用方怎么用**，不是枚举上的一条规则）。 */

    /* ---------- ② 诊断行（H4 的分界器） ---------- */

    #[test]
    fn digest_lists_rows_with_truncated_ids_and_raw_status() {
        let wire = vec![
            PresenceWireRow {
                profile_id: "bbbb1111222233334444555566667777".into(),
                status: Some("PLAYING_SERVER".into()),
                ..Default::default()
            },
            PresenceWireRow {
                profile_id: "cccc1111222233334444555566667777".into(),
                status: None,
                ..Default::default()
            },
        ];
        let d = presence_digest(&wire);
        assert!(d.starts_with("2 行 · "), "{d}");
        // ★ 只写前 8 位（不许把完整 id 撒进日志）
        assert!(d.contains("bbbb1111=PLAYING_SERVER"), "{d}");
        assert!(!d.contains("bbbb11112222"), "profileId 必须截断：{d}");
        // ★ status 缺失就写 null（"他在名单里但没带状态"这件事本身是证据）
        assert!(d.contains("cccc1111=null"), "{d}");
        // 认不出来的取值**照原样**写出来
        let odd = vec![PresenceWireRow {
            profile_id: "dddd1111222233334444555566667777".into(),
            status: Some("BRAND_NEW".into()),
            ..Default::default()
        }];
        assert!(presence_digest(&odd).contains("dddd1111=BRAND_NEW"));
    }

    /// ★ 0 行是**结论**（服务端说没人在场 ⇒ H4），不是"没记录"。
    #[test]
    fn digest_says_zero_rows_out_loud() {
        let d = presence_digest(&[]);
        assert!(d.starts_with("0 行"), "{d}");
        assert!(d.contains("空"), "{d}");
    }

    #[test]
    fn digest_caps_how_many_rows_it_prints() {
        let wire: Vec<PresenceWireRow> = (0..(DIGEST_MAX_ROWS + 5))
            .map(|i| PresenceWireRow {
                profile_id: format!("{i:032x}"),
                status: Some("ONLINE".into()),
                ..Default::default()
            })
            .collect();
        let d = presence_digest(&wire);
        assert!(d.starts_with(&format!("{} 行 · ", DIGEST_MAX_ROWS + 5)), "{d}");
        assert!(d.contains("另有 5 行未列出"), "{d}");
    }

    /* ---------- ③ 响应原文的安全摘录 ---------- */

    #[test]
    fn excerpt_is_single_line_and_truncated() {
        let raw = "{\n  \"presence\": []\r\n}";
        let got = safe_excerpt(raw, 200);
        assert!(!got.contains('\n') && !got.contains('\r'), "提示条里不许有换行：{got}");
        let long = "a".repeat(500);
        // ★ 长串会被"不透明长串"规则隐去，所以这里比长度而不是比内容
        assert!(safe_excerpt(&long, 20).chars().count() <= 21, "要截断");
    }

    #[test]
    fn excerpt_never_carries_a_bearer_token() {
        let raw = r#"{"error":"bad","note":"sent Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig"}"#;
        let got = safe_excerpt(raw, 400);
        assert!(!got.contains("eyJhbGciOiJIUzI1NiJ9"), "★ 令牌不许出现在摘录里：{got}");
        assert!(got.contains("Bearer"), "结构要留着（说明那句话长什么样）：{got}");
    }

    #[test]
    fn excerpt_masks_secret_valued_fields_but_keeps_their_names() {
        let raw = r#"{"path":"/presence","accessToken":"SECRET-VALUE-1","errorMessage":"nope"}"#;
        let got = safe_excerpt(raw, 400);
        assert!(!got.contains("SECRET-VALUE-1"), "★ 敏感字段的值不许出现：{got}");
        assert!(got.contains("accessToken"), "键名要留着（诊断信息）：{got}");
        assert!(got.contains("nope"), "不相干的字段照原样留着：{got}");
        assert!(got.contains("/presence"), "{got}");
    }

    /// ★★ 邮箱也要隐掉：这段摘录会进**给用户看的提示条**，而用户常把它截图
    ///   或粘进 issue —— 账号相关的错误体里真的会有邮箱。
    #[test]
    fn excerpt_masks_email_shapes() {
        let raw = r#"{"error":"the account someone@outlook.com is banned","email":"a.b+c@sub.example.org"}"#;
        let got = safe_excerpt(raw, 400);
        assert!(!got.contains("someone@outlook.com"), "★ 邮箱不许出现：{got}");
        assert!(!got.contains("a.b+c@sub.example.org"), "★ 字段里的邮箱同样要隐：{got}");
        assert!(got.contains(EMAIL_MASK), "{got}");
        // 结构留着（"哪句话里有邮箱"本身是诊断信息）
        assert!(got.contains("is banned") && got.contains(r#""email":"#), "{got}");

        // ★ 不是邮箱的形状一个字都不许改（少隐也不能误伤诊断信息）
        for keep in ["a@b", "v1.2.3@x", "@x.com", "user@localhost", "C:\\path\\x"] {
            let got = safe_excerpt(keep, 400);
            assert_eq!(got, keep, "这个不该被当成邮箱：{keep}");
        }
        // 正常错误体照旧
        let ok = safe_excerpt(r#"{"path":"/friends","errorMessage":"That profile does not exist"}"#, 400);
        assert!(ok.contains("That profile does not exist") && !ok.contains(EMAIL_MASK), "{ok}");
    }

    #[test]
    fn excerpt_masks_long_opaque_runs() {
        let token = "A".repeat(120);
        let raw = format!(r#"{{"whatever":"{token}"}}"#);
        let got = safe_excerpt(&raw, 400);
        assert!(!got.contains(&token), "★ 长不透明串一律隐去：{got}");
        assert!(got.contains("已隐去"), "{got}");
        // 短值不许被误伤（状态值、路径这些是诊断的主体）
        let short = r#"{"presence":[{"profileId":"bbbb1111","status":"PLAYING_SERVER"}]}"#;
        let got2 = safe_excerpt(short, 400);
        assert!(got2.contains("PLAYING_SERVER") && got2.contains("bbbb1111"), "{got2}");
    }
}
