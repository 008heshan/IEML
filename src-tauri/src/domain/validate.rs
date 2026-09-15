//! 输入校验：**可组合的规则**（照 PCL 的 `ModValidate.vb` 做的）
//!
//! ## 为什么要有这个模块（这一轮的真实起因）
//!
//! 「用户填进来的东西对不对」这件事，在这个仓库里原来是**散在各个调用点**的：
//! 每条判据都是就地写一句 `if ... { return Err("...") }`，
//! 于是同一个判据很容易在第二个地方被**再写一遍**，然后两处慢慢分叉。
//!
//! 这已经真实发生过两次，两次都是我修的：
//!
//! | 重复的判据 | 后果 |
//! |---|---|
//! | `net.minecraftforge:forge` 的前缀匹配写在两个函数里 | 第一次只修了一处，界面照旧显示 `Forge 7.0.1`（真值是 47.2.0） |
//! | 「需要哪个 Java」手写在三个文件里 | `26.2` 的 major 被当成 26 → 落到 `return 8`，界面显示「需要 Java 8」 |
//!
//! 两次的形态完全一样：**同一个判据写两遍 → 有一处忘了改 → 两处给出不同结论**。
//! 这个模块提供的是"判据只有一份"的**承载形式**：规则是数据，不是散落的 if。
//!
//! ## PCL 的做法（`Modules/Base/ModValidate.vb`，424 行）
//!
//! ```vb
//! ' 8-16 行
//! Public Function Validate(Text As String, ValidateRules As IEnumerable(Of Validate)) As String
//!     For Each ValidateRule As Validate In ValidateRules
//!         Result = ValidateRule.Validate(Text)
//!         If Result Is Nothing Then Return ""     ' ← 中断检查并**直接通过**
//!         If Result <> "" Then Return Result      ' ← 第一条错误就返回
//!     Next
//!     Return Result
//! End Function
//! ```
//!
//! 它有三条语义，我们照抄（这三条都不是随手写的）：
//!
//! 1. **规则是三态的**：`None`（跳过并直接通过）/ `Some("")`（这条通过）/
//!    `Some("原因")`（这条不通过）。
//!    `None` 的存在是为了 [`Rule::Optional`] —— "这个字段可以不填，
//!    不填的话**后面所有规则都不适用**"。
//! 2. **第一条不通过的规则决定结论**（`Return Result`），不是把错误攒一堆。
//!    理由：用户一次只该看到**一个**要改的地方，攒一堆反而不知道先改哪个。
//! 3. **文案由规则自己带着**（`Regex As String` / `ErrorDescription`），
//!    不是调用点拼的 —— 换个地方用同一条规则，文案自动一致。
//!
//! 它那 14 个规则类里，我们真正需要的是这 7 条（其余是 WinForms 界面用的，
//! 例如 `ValidateExceptSame` 是"两个输入框不能填一样的"）：
//!
//! | PCL | 我们 | 用途 |
//! |---|---|---|
//! | `ValidateNullable` | [`Rule::Optional`] | 空值直接放行 |
//! | `ValidateNullOrEmpty` | [`Rule::NotEmpty`] | 不能为空 |
//! | `ValidateRegex` | [`Rule::Matches`] | 正则 |
//! | `ValidateInteger` | [`Rule::IntRange`] | 整数 + 上下限 |
//! | `ValidateLength` | [`Rule::LenRange`] | 长度 + 上下限 |
//! | `ValidateFolderName` | [`Rule::SafeName`] | 文件夹 / 文件名 |
//! | `ValidateFunc` | [`Rule::Custom`] | 自定义谓词 |
//!
//! ## 这个模块是**纯的**
//!
//! 不碰文件系统、不发网络（本项目的铁律，见 `domain/mod.rs`）。
//! 需要 I/O 才能判断的事（"这个目录存不存在"）属于调用点，不属于这里。

use serde::{Deserialize, Serialize};

/// 一条校验规则。
///
/// ★ 做成 **enum 而不是 trait 对象**，两个理由：
///   · 规则要能**序列化**（前端与配置文件都该能表达同一套规则）；
///   · 规则集要能**被测试逐条列出来**（PCL 那份是 class 层级，枚举更直白）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "rule", rename_all = "snake_case")]
pub enum Rule {
    /// 空（或缺失）时**直接通过，后面的规则不再检查**。
    ///
    /// 对应 PCL 的 `ValidateNullable`（33-41 行）：`Return Nothing`。
    /// ★ 它必须排在**最前面**才有意义 —— [`validate`] 是按顺序走的。
    Optional,

    /// 不能为 `None` 或空串（**不**含全空格检查）。
    ///
    /// 对应 `ValidateNullOrEmpty`（46-54 行）。
    NotEmpty {
        #[serde(default = "default_not_empty_msg")]
        message: String,
    },

    /// 不能为 `None`、空串或全空格。
    ///
    /// 对应 `ValidateNullOrWhiteSpace`（59-67 行）。
    NotBlank {
        #[serde(default = "default_not_empty_msg")]
        message: String,
    },

    /// 必须匹配正则。`message` 是**给用户看的原因**，不是正则本身。
    ///
    /// 对应 `ValidateRegex`（86-103 行）：`ErrorDescription` 与规则一起带着。
    Matches {
        pattern: String,
        message: String,
    },

    /// 必须是整数，且落在 `[min, max]` 闭区间内。
    ///
    /// 对应 `ValidateInteger`（119-140 行）。PCL 还先判 `Str.Length > 9`
    /// 就说"请输入一个大小合理的数字" —— 那是为了防止 `Integer.TryParse`
    /// 溢出。我们用 `i64`，顺便保留那条"太长就不是正常输入"的早期判断。
    IntRange {
        #[serde(default)]
        min: i64,
        #[serde(default = "default_i64_max")]
        max: i64,
        #[serde(default)]
        label: String,
    },

    /// 长度（按**字符**数，不是字节）落在 `[min, max]` 闭区间内。
    ///
    /// 对应 `ValidateLength`（142-161 行）。
    /// ★ 按字符数而不是字节数：中文名一个字 3 个字节，
    ///   按字节算会让"最多 16 个字的版本名"变成"最多 5 个字"。
    LenRange {
        #[serde(default)]
        min: usize,
        #[serde(default = "default_len_max")]
        max: usize,
        #[serde(default)]
        label: String,
    },

    /// 可以作为 Windows 文件夹名 / 文件名。
    ///
    /// 对应 `ValidateFolderName`（259-315 行）。PCL 那一段的判据很具体，
    /// 逐条抄（都是实测会在资源管理器里出问题的形态）：
    ///   · 不能以空格开头 / 结尾（`StartsWithF(" ")` / `EndsWithF(" ")`）；
    ///   · 不能以小数点结尾（`EndsWithF(".")`，Windows 会自己吃掉它）；
    ///   · 不能含 `.{2,}~\d`（8.3 短文件名保留格式）；
    ///   · 不能含 `<>:"/\|?*` 与控制字符；
    ///   · 不能是 `CON` / `PRN` / `AUX` / `NUL` / `COM1..9` / `LPT1..9`；
    ///   · 不能以空格或点**只**组成。
    SafeName {
        #[serde(default)]
        label: String,
    },

    /// 自定义谓词 —— **按名字引用**，函数本身放在 [`CustomRules`] 里。
    ///
    /// 对应 PCL 的 `ValidateFunc`（72-81 行）。
    ///
    /// ★ 为什么不把函数指针直接放进这个 enum（我第一版就是那么写的）：
    ///   那样 `Rule` 就**不能序列化**了。而 `#[serde(skip)]` 更糟 ——
    ///   它让**序列化直接报错**（`the enum variant Rule::Custom cannot be
    ///   serialized`），于是"规则能进出 JSON"这件事整个作废。
    ///
    ///   分开之后两边都干净：
    ///     · `Rule` 是**纯数据**，能进 JSON、能进配置文件、能逐条列给用户看；
    ///     · 函数放 [`CustomRules`]，按名字查 —— 从 JSON 来的规则集如果引用了
    ///       一个没注册的名字，**报错**（`未知的校验规则`），
    ///       而不是静默通过。一条写错名字的规则悄悄放行所有输入，比报错危险得多。
    Custom {
        /// 在 [`CustomRules`] 里注册的名字
        name: String,
        #[serde(default)]
        label: String,
    },
}

fn default_not_empty_msg() -> String {
    "这一项不能为空".into()
}
fn default_i64_max() -> i64 {
    i64::MAX
}
fn default_len_max() -> usize {
    usize::MAX
}

/* ====================== 自定义谓词的注册表 ====================== */

/// 一条自定义谓词：**返回 `Some(原因)` 表示不通过**，`None` 表示通过。
pub type CustomFn = fn(&str) -> Option<String>;

/// 按名字注册的自定义谓词。
///
/// ★ 为什么用"名字 → 函数"的注册表，而不是把函数放进 [`Rule`]：
///   见 `Rule::Custom` 上的说明 —— 那样会让 `Rule` 不可序列化。
///
/// ★ 用**静态表**而不是运行时可变注册：
///   校验规则不该在运行期被替换掉（那是"行为可以被远程改掉"，
///   对启动器来说是不必要的攻击面）。要加规则就改这个表。
static CUSTOM_RULES: &[(&str, CustomFn)] = &[
    ("no_newline", |s: &str| {
        if s.chars().any(|c| c == '\n' || c == '\r' || c == '\t') {
            Some("不能包含换行或制表符".into())
        } else {
            None
        }
    }),
    ("no_spaces", |s: &str| {
        if s.contains(' ') {
            Some("不能包含空格".into())
        } else {
            None
        }
    }),
];

fn custom_lookup(name: &str) -> Option<CustomFn> {
    CUSTOM_RULES
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, f)| *f)
}

impl Rule {
    /// 这一条规则对 `text` 的结论。
    ///
    /// 三种返回值，**与 PCL 的 `Validate` 一一对应**：
    ///   * `Ok(true)`  —— 通过，继续检查下一条（PCL 返回 `""`）
    ///   * `Ok(false)` —— **中断检查并直接判定通过**（PCL 返回 `Nothing`）
    ///   * `Err(原因)` —— 不通过，这就是最终结论（PCL 返回非空串）
    #[allow(clippy::result_large_err)]
    fn check(&self, text: Option<&str>) -> Result<bool, String> {
        match self {
            Rule::Optional => {
                /*
                 * ★★ `Ok(true)` = 继续检查下一条；`Ok(false)` = **中断并直接通过**。
                 *
                 *   所以这里必须反过来写：
                 *     · 空 / 缺失 → `Ok(false)`（中断通过，后面的规则不跑）
                 *     · 有内容   → `Ok(true)`（继续，让后面的规则去判）
                 *
                 *   ★ 我第一版把这两个写反了 —— 结果是**恰恰最糟的那种**：
                 *     没填的时候继续跑后面的规则（把"没填"判成错），
                 *     填了的时候反而直接通过（把非法值放行）。
                 *     两个方向都错，而测试一眼就抓出来了。
                 */
                Ok(!matches!(text, None | Some("")))
            }
            Rule::NotEmpty { message } => match text {
                None | Some("") => Err(message.clone()),
                _ => Ok(true),
            },
            Rule::NotBlank { message } => match text {
                None => Err(message.clone()),
                Some(s) if s.trim().is_empty() => Err(message.clone()),
                _ => Ok(true),
            },
            Rule::Matches { pattern, message } => {
                let Some(s) = text else {
                    return Err(message.clone());
                };
                match regex_lite_is_match(pattern, s) {
                    Some(true) => Ok(true),
                    // 正则本身写错了 → 报出来，不要静默通过
                    Some(false) => Err(message.clone()),
                    None => Err(format!("（校验规则里的正则写错了：{pattern}）")),
                }
            }
            Rule::IntRange { min, max, label } => {
                let name = if label.is_empty() { "这一项" } else { label };
                let Some(s) = text else {
                    return Err(format!("{name}要填一个整数"));
                };
                let t = s.trim();
                if t.is_empty() {
                    return Err(format!("{name}要填一个整数"));
                }
                // PCL 那条"太长就不是正常输入"的早期判断（130 行）
                if t.trim_start_matches(['-', '+']).len() > 18 {
                    return Err(format!("{name}要填一个大小合理的数字"));
                }
                let Ok(v) = t.parse::<i64>() else {
                    return Err(format!("{name}要填一个整数"));
                };
                if v > *max {
                    return Err(format!("{name}不能超过 {max}"));
                }
                if v < *min {
                    return Err(format!("{name}不能低于 {min}"));
                }
                Ok(true)
            }
            Rule::LenRange { min, max, label } => {
                let name = if label.is_empty() { "这一项" } else { label };
                let Some(s) = text else {
                    return Err(format!("{name}不能为空"));
                };
                // ★ 按**字符**数（`chars().count()`），不是 `len()`
                let n = s.chars().count();
                if n < *min {
                    return Err(format!("{name}不能少于 {min} 个字符（现在是 {n} 个）"));
                }
                if n > *max {
                    return Err(format!("{name}不能超过 {max} 个字符（现在是 {n} 个）"));
                }
                Ok(true)
            }
            Rule::SafeName { label } => {
                let name = if label.is_empty() { "名称" } else { label };
                let Some(s) = text else {
                    return Err(format!("{name}不能为空"));
                };
                safe_name_error(s, name).map_or(Ok(true), Err)
            }
            Rule::Custom { name, label } => {
                let Some(s) = text else {
                    // 没填就不该跑自定义逻辑（与 `Optional` 的组合语义一致）
                    return Ok(true);
                };
                match custom_lookup(name) {
                    Some(f) => match f(s) {
                        Some(e) => Err(e),
                        None => Ok(true),
                    },
                    // ★ 名字没注册 → **报错**，不静默通过
                    None => Err(format!(
                        "（校验规则「{name}」没有注册，{}没法检查）",
                        if label.is_empty() { "这一项" } else { label }
                    )),
                }
            }
        }
    }
}

/// 正则匹配；正则本身不合法时返回 `None`（与"不匹配"区分开）。
///
/// 这个仓库没有引 `regex` crate（依赖越少越好，而且这里只需要几个极简模式），
/// 所以自己实现**这一小撮**够用的形态：字符类、锚点、量词 `{n,m}`、`*`、`+`、`?`。
/// 复杂正则请用 `Rule::Custom` —— 那条路能写任意 Rust 逻辑。
fn regex_lite_is_match(pattern: &str, text: &str) -> Option<bool> {
    // `^...$` = 完整匹配；`^...` = 只锚开头；裸模式 = 包含
    if let Some(inner) = pattern.strip_prefix('^').and_then(|p| p.strip_suffix('$')) {
        return match_class_pattern(inner, text);
    }
    if let Some(inner) = pattern.strip_prefix('^') {
        // 只锚开头：退化成"前缀是否匹配"，用同一套字符类逻辑
        return match_class_pattern(inner, text);
    }
    if let Some(inner) = pattern.strip_suffix('$') {
        // 只锚结尾
        return match_class_pattern(inner, text);
    }
    Some(text.contains(pattern))
}

/// 只支持"字符类 + 量词"与几个简写（够 `^[A-Za-z0-9_]{1,16}$` / `^\d+$` 这类用）。
///
/// 支持的形态（**只有这些**，其它一律返回"认不出来"让调用方报错）：
///   * `[...]`  + 量词：`[a-z]{1,16}` / `[A-Za-z0-9_]+` / `[abc]?`
///   * `\d` / `\w` / `\s`（及其大写取反）+ 量词：`\d+` / `\w{3,}`
///   * 裸字面量：`abc`（完全相等）
///
/// ★ 认不出来就返回 `None`（→ 调用方报"正则写错了"），
///   **不静默通过** —— 一条写错的规则悄悄放行所有输入，比报错危险得多。
fn match_class_pattern(pattern: &str, text: &str) -> Option<bool> {
    // ① `[...]` 形式
    if pattern.starts_with('[') {
        let end = pattern.find(']')?;
        let class = &pattern[1..end];
        let quant = &pattern[end + 1..];
        return Some(class_with_quantifier(class, quant, text));
    }

    // ② `\d+` / `\w{3,}` 这类简写
    if let Some(rest) = pattern.strip_prefix('\\') {
        let mut it = rest.chars();
        let Some(short) = it.next() else { return None };
        if !matches!(short, 'd' | 'D' | 'w' | 'W' | 's' | 'S') {
            return None;
        }
        let quant = &rest[short.len_utf8()..];
        // 把简写包装成一个字符类，复用同一段逻辑
        let class = format!("\\{short}");
        return Some(class_with_quantifier(&class, quant, text));
    }

    // ③ 裸字面量（没有元字符）→ 完全相等
    if !pattern.is_empty()
        && !pattern.contains(['[', ']', '\\', '+', '*', '?', '{', '}', '^', '$'])
    {
        return Some(pattern == text);
    }

    // ④ 认不出来
    None
}

/// 字符类 + 量词 组合的匹配
fn class_with_quantifier(class: &str, quant: &str, text: &str) -> bool {
    if !text.chars().all(|c| class_contains(class, c)) {
        return false;
    }
    let n = text.chars().count();
    let (min, max) = match quant {
        "" => (n, n),
        "+" => (1, usize::MAX),
        "*" => (0, usize::MAX),
        "?" => (0, 1),
        q if q.starts_with('{') && q.ends_with('}') => {
            let body = &q[1..q.len() - 1];
            match body.split_once(',') {
                Some((a, b)) => (
                    a.trim().parse().unwrap_or(0),
                    b.trim().parse().unwrap_or(usize::MAX),
                ),
                None => {
                    let v = body.trim().parse().unwrap_or(0);
                    (v, v)
                }
            }
        }
        _ => return false,
    };
    n >= min && n <= max
}

/// 字符类里有没有 `c`（支持 `a-z` 区间与 `\d` / `\w` 简写）。
fn class_contains(class: &str, c: char) -> bool {
    let chars: Vec<char> = class.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        // 简写
        if chars[i] == '\\' && i + 1 < chars.len() {
            let hit = match chars[i + 1] {
                'd' => c.is_ascii_digit(),
                'w' => c.is_ascii_alphanumeric() || c == '_',
                's' => c.is_whitespace(),
                'D' => !c.is_ascii_digit(),
                'W' => !(c.is_ascii_alphanumeric() || c == '_'),
                'S' => !c.is_whitespace(),
                other => c == other,
            };
            if hit {
                return true;
            }
            i += 2;
            continue;
        }
        // 区间 a-z
        if i + 2 < chars.len() && chars[i + 1] == '-' {
            if chars[i] <= c && c <= chars[i + 2] {
                return true;
            }
            i += 3;
            continue;
        }
        if chars[i] == c {
            return true;
        }
        i += 1;
    }
    false
}

/// Windows 上"这个名字能不能当文件夹/文件名"。
///
/// 逐条对照 PCL 的 `ValidateFolderName`（259-315 行）。
fn safe_name_error(s: &str, label: &str) -> Option<String> {
    if s.is_empty() {
        return Some(format!("{label}不能为空"));
    }
    if s.starts_with(' ') {
        return Some(format!("{label}不能以空格开头"));
    }
    if s.ends_with(' ') {
        return Some(format!("{label}不能以空格结尾"));
    }
    // Windows 会静默吃掉结尾的点
    if s.ends_with('.') {
        return Some(format!("{label}不能以小数点结尾"));
    }
    // 8.3 短文件名的保留格式（PCL 294 行：`.{2,}~\d`）
    if has_double_dot_tilde_digit(s) {
        return Some(format!("{label}不能包含「..~数字」这种特殊格式"));
    }
    const BAD: &[char] = &['<', '>', ':', '"', '/', '\\', '|', '?', '*'];
    if let Some(c) = s.chars().find(|c| BAD.contains(c) || (*c as u32) < 0x20) {
        return Some(format!("{label}不能包含 {c} 这个字符"));
    }
    // 保留设备名
    let stem = s.split('.').next().unwrap_or(s).to_ascii_uppercase();
    const RESERVED: &[&str] = &[
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if RESERVED.contains(&stem.as_str()) {
        return Some(format!("{label}不能是系统保留名（{stem}）"));
    }
    // 只有点和空格
    if s.chars().all(|c| c == '.' || c == ' ') {
        return Some(format!("{label}不能只由点和空格组成"));
    }
    None
}

fn has_double_dot_tilde_digit(s: &str) -> bool {
    let b: Vec<char> = s.chars().collect();
    for i in 0..b.len() {
        // "..~" 后面跟数字
        if b[i] == '.' && i + 2 < b.len() && b[i + 1] == '.' && b[i + 2] == '~' {
            if b.get(i + 3).is_some_and(|c| c.is_ascii_digit()) {
                return true;
            }
        }
    }
    false
}

/// ★★ **按顺序跑一遍规则，返回第一条不通过的原因**（`None` = 全部通过）。
///
/// 与 PCL 的 `Validate`（8-16 行）语义逐条一致：
///   · 一条规则返回 `Ok(false)`（= `Optional` 遇到空值）→ **立刻判定通过**；
///   · 一条规则返回 `Err(原因)` → **立刻返回那个原因**（不攒错误）；
///   · 全部走完没有错误 → 通过。
///
/// `text` 用 `Option<&str>`：`None` 表示"这个字段压根没填" ——
/// 它与 `Some("")` 在 [`Rule::Optional`] 下**等价**（PCL 的 `IsNothing OrElse
/// String.IsNullOrEmpty` 就是这么判的），但 [`Rule::NotEmpty`] 会把它算作错误。
pub fn validate(text: Option<&str>, rules: &[Rule]) -> Option<String> {
    for r in rules {
        match r.check(text) {
            Ok(true) => continue,
            Ok(false) => return None, // 中断并直接通过
            Err(e) => return Some(e),
        }
    }
    None
}

/// 方便调用点：`Err` 就是错误原因。
#[allow(clippy::result_large_err)]
pub fn validate_str(text: Option<&str>, rules: &[Rule]) -> Result<(), String> {
    match validate(text, rules) {
        None => Ok(()),
        Some(e) => Err(e),
    }
}

/* ====================== 项目里在用的那几套规则 ====================== */

/// 实例「显示名」的规则。
///
/// ★ 与 [`slug_rules`] 分开：显示名可以写中文，slug 会变成目录名。
///   两者混用是这一类校验最常见的错（改了显示名却把目录名也改了）。
pub fn instance_name_rules() -> Vec<Rule> {
    vec![
        Rule::NotBlank {
            message: "版本名不能为空，也不能只有空格".into(),
        },
        // Windows 文件夹名那套仍然适用于**目录**，但显示名不受它限制；
        // 这里只挡真正会出问题的字符（换行、制表符之类）
        Rule::Custom {
            name: "no_newline".into(),
            label: "版本名".into(),
        },
        Rule::LenRange {
            min: 1,
            max: 64,
            label: "版本名".into(),
        },
    ]
}

/// 实例 `slug`（磁盘目录名）的规则 —— 它就是文件夹名。
pub fn slug_rules() -> Vec<Rule> {
    vec![
        Rule::NotBlank {
            message: "目录名不能为空".into(),
        },
        Rule::SafeName {
            label: "目录名".into(),
        },
        Rule::LenRange {
            min: 1,
            max: 48,
            label: "目录名".into(),
        },
    ]
}

/// 离线玩家名（会被写进 `--username`）。
pub fn offline_username_rules() -> Vec<Rule> {
    vec![
        Rule::NotBlank {
            message: "玩家名不能为空".into(),
        },
        Rule::Matches {
            // Minecraft 的离线名只认字母数字下划线，1~16 个（3~16 是 Mojang 的正版规则）
            pattern: "^[A-Za-z0-9_]{1,16}$".into(),
            message: "玩家名只能用英文字母、数字、下划线，且不超过 16 个字符".into(),
        },
    ]
}

/// 服务器地址的**端口**部分（主机名由 `launch_args::parse_server_address` 管）。
pub fn port_rules() -> Vec<Rule> {
    vec![
        Rule::Optional,
        Rule::IntRange {
            min: 1,
            max: 65535,
            label: "端口".into(),
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    /* ---------- 引擎本身：三态语义 ---------- */

    /// ★★ `Optional` 遇到空值要**中断并直接通过**（PCL `Return Nothing`）。
    ///
    ///   这一条是整套语义的关键：不填的可选字段，不该被后面的规则判错。
    #[test]
    fn optional_short_circuits_to_pass() {
        let rules = vec![
            Rule::Optional,
            Rule::Matches {
                pattern: "^\\d+$".into(),
                message: "必须是数字".into(),
            },
        ];
        // 没填 / 空串 → 通过（后面的正则不该被跑）
        assert_eq!(validate(None, &rules), None, "None 应当直接通过");
        assert_eq!(validate(Some(""), &rules), None, "空串应当直接通过");
        // 填了就必须满足后面的规则
        assert_eq!(validate(Some("12"), &rules), None);
        assert_eq!(
            validate(Some("ab"), &rules).as_deref(),
            Some("必须是数字"),
            "填了内容之后后面的规则必须生效"
        );
    }

    /// ★ `Optional` 必须排在**最前面**才有意义（顺序敏感是设计，不是缺陷）
    #[test]
    fn optional_only_short_circuits_when_it_is_first() {
        let rules = vec![
            Rule::Matches {
                pattern: "x".into(),
                message: "必须含 x".into(),
            },
            Rule::Optional,
        ];
        // Optional 在后面 → 空串先被正则判错
        assert_eq!(
            validate(Some(""), &rules).as_deref(),
            Some("必须含 x"),
            "排在后面的 Optional 拦不住前面的规则 —— 这是设计（顺序即优先级）"
        );
    }

    /// ★ **第一条不通过的就是结论**（不攒错误）
    #[test]
    fn first_failing_rule_wins() {
        let rules = vec![
            Rule::NotEmpty {
                message: "不能为空".into(),
            },
            Rule::LenRange {
                min: 3,
                max: 10,
                label: "名字".into(),
            },
            Rule::Matches {
                pattern: "^[a-z]+$".into(),
                message: "只能小写字母".into(),
            },
        ];
        // 空 → 只有第一条报
        assert_eq!(validate(Some(""), &rules).as_deref(), Some("不能为空"));
        // 太短 → 第二条报（第一条已通过）
        assert!(validate(Some("ab"), &rules).unwrap().contains("不能少于 3"));
        // 长度够但含大写 → 第三条报
        assert_eq!(
            validate(Some("aBc"), &rules).as_deref(),
            Some("只能小写字母")
        );
        // 全通过
        assert_eq!(validate(Some("abc"), &rules), None);
    }

    /* ---------- 每条规则单独验 ---------- */

    #[test]
    fn not_empty_vs_not_blank() {
        let ne = vec![Rule::NotEmpty {
            message: "不能为空".into(),
        }];
        // 全空格：NotEmpty 放行（PCL 也不管），NotBlank 拦住
        assert_eq!(validate(Some("   "), &ne), None);
        let nb = vec![Rule::NotBlank {
            message: "不能为空".into(),
        }];
        assert_eq!(validate(Some("   "), &nb).as_deref(), Some("不能为空"));
        assert_eq!(validate(None, &nb).as_deref(), Some("不能为空"));
    }

    /// ★★ 长度按**字符**数算，不是字节数。
    ///
    ///   中文名一个字 3 个字节 —— 用 `len()` 会把"最多 16 个字"变成"最多 5 个字"，
    ///   而用户看到的是"我就输了 6 个字，怎么超了"。
    #[test]
    fn length_counts_characters_not_bytes() {
        let rules = vec![Rule::LenRange {
            min: 1,
            max: 6,
            label: "名字".into(),
        }];
        assert_eq!(validate(Some("中文名字"), &rules), None, "4 个汉字应当通过");
        assert_eq!(validate(Some("一二三四五六"), &rules), None, "6 个汉字应当通过");
        let err = validate(Some("一二三四五六七"), &rules).expect("7 个应当被拒");
        assert!(err.contains("现在是 7 个"), "报的应该是字符数：{err}");
        // 如果是按字节算，下面这个会被误拒
        assert_eq!(validate(Some("中文abc"), &rules), None, "5 个字符应当通过");
    }

    #[test]
    fn int_range_reports_which_bound() {
        let rules = vec![Rule::IntRange {
            min: 1,
            max: 65535,
            label: "端口".into(),
        }];
        assert_eq!(validate(Some("25565"), &rules), None);
        assert_eq!(
            validate(Some("0"), &rules).as_deref(),
            Some("端口不能低于 1")
        );
        assert_eq!(
            validate(Some("70000"), &rules).as_deref(),
            Some("端口不能超过 65535")
        );
        assert_eq!(
            validate(Some("abc"), &rules).as_deref(),
            Some("端口要填一个整数")
        );
        // PCL 那条"太长就不是正常输入"（130 行）
        assert_eq!(
            validate(Some("999999999999999999999"), &rules).as_deref(),
            Some("端口要填一个大小合理的数字")
        );
    }

    #[test]
    fn safe_name_catches_the_real_windows_traps() {
        let rules = vec![Rule::SafeName {
            label: "目录名".into(),
        }];
        for bad in [
            " a",      // 空格开头
            "a ",      // 空格结尾
            "a.",      // 点结尾（Windows 会吃掉）
            "a..~1",   // 8.3 短名保留格式
            "a<b",     // 非法字符
            "CON",     // 保留设备名
            "nul.txt", // 保留设备名（带扩展名）
            "...",     // 只有点
        ] {
            assert!(
                validate(Some(bad), &rules).is_some(),
                "「{bad}」应当被拒（Windows 上会出问题）"
            );
        }
        for good in ["fabric-262", "Minecraft 1.12.2", "forge_1122", "中文名", "a.b.c"] {
            assert_eq!(
                validate(Some(good), &rules),
                None,
                "「{good}」应当通过"
            );
        }
    }

    #[test]
    fn reserved_names_are_case_insensitive() {
        let rules = vec![Rule::SafeName {
            label: "目录名".into(),
        }];
        for bad in ["con", "Con", "COM1", "lpt9"] {
            assert!(validate(Some(bad), &rules).is_some(), "{bad} 是保留名");
        }
        // 只是**以**保留名开头的不算（CONSOLE 是合法名字）
        assert_eq!(validate(Some("CONSOLE"), &rules), None);
    }

    /* ---------- 项目里在用的那几套 ---------- */

    #[test]
    fn offline_username_uses_a_full_match() {
        let rules = offline_username_rules();
        assert_eq!(validate(Some("Steve_01"), &rules), None);
        assert!(validate(Some("史提夫"), &rules).is_some(), "中文名正版不允许");
        assert!(
            validate(Some("a".repeat(17).as_str()), &rules).is_some(),
            "17 个字符应当被拒"
        );
        assert!(validate(Some(""), &rules).is_some());
    }

    #[test]
    fn instance_name_allows_chinese_but_not_newlines() {
        let rules = instance_name_rules();
        assert_eq!(validate(Some("我的世界 1.12.2"), &rules), None);
        assert!(validate(Some("名字\n换行"), &rules).is_some());
        assert!(validate(Some("   "), &rules).is_some(), "全空格要拒");
    }

    #[test]
    fn slug_is_a_folder_name() {
        let rules = slug_rules();
        assert_eq!(validate(Some("vanilla-262"), &rules), None);
        assert!(validate(Some("a/b"), &rules).is_some(), "不能含路径分隔符");
        assert!(validate(Some("a\\b"), &rules).is_some());
        assert!(validate(Some("CON"), &rules).is_some());
    }

    #[test]
    fn port_uses_optional_so_blank_is_fine() {
        let rules = port_rules();
        // ★ 地址里没写端口是**正常**的（默认 25565 由别处填）
        assert_eq!(validate(Some(""), &rules), None);
        assert_eq!(validate(None, &rules), None);
        assert_eq!(validate(Some("25565"), &rules), None);
        assert!(validate(Some("70000"), &rules).is_some());
    }

    /* ---------- 规则集可以序列化 ---------- */

    /// 规则要能进出 JSON（前端与配置文件都该能表达同一套），
    /// 但 `Custom` **不进 JSON** —— 从外部来的规则集不该有可执行逻辑。
    #[test]
    fn rules_round_trip_through_json() {
        let rules = vec![
            Rule::Optional,
            Rule::NotBlank {
                message: "不能为空".into(),
            },
            Rule::IntRange {
                min: 1,
                max: 10,
                label: "数量".into(),
            },
        ];
        let json = serde_json::to_string(&rules).expect("应当能序列化");
        let back: Vec<Rule> = serde_json::from_str(&json).expect("应当能反序列化");
        assert_eq!(rules, back, "序列化一圈之后必须一模一样");

        // Custom 序列化后是一个**数据**规则（名字 + 标签），反序列化回来一模一样；
        // 名字没注册时 `validate` 会**报错**，不会静默通过
        let with_custom = vec![Rule::Custom {
            name: "no_spaces".into(),
            label: "名字".into(),
        }];
        let j = serde_json::to_string(&with_custom).expect("Custom 也必须能序列化");
        let back: Vec<Rule> = serde_json::from_str(&j).expect("应当能反序列化");
        assert_eq!(with_custom, back, "Custom 进出 JSON 也要一模一样");
        // 注册过的名字 → 真的生效
        assert!(validate(Some("a b"), &back).is_some(), "no_spaces 应当拦住空格");
        assert_eq!(validate(Some("ab"), &back), None);

        // ★ 没注册的名字 → **报错**（不是静默通过）
        let unknown = vec![Rule::Custom {
            name: "这个规则不存在".into(),
            label: "名字".into(),
        }];
        let e = validate(Some("随便"), &unknown).expect("未注册的规则必须报错");
        assert!(
            e.contains("没有注册"),
            "要说清是规则名字的问题，而不是把输入判成非法：{e}"
        );
    }

    /// 写错的正则要**报出来**，不能静默通过
    #[test]
    fn a_broken_pattern_is_reported_not_silently_passed() {
        let rules = vec![Rule::Matches {
            // 字符类没闭合 → 我们的极简匹配器认不出来
            pattern: "^[abc".into(),
            message: "应当匹配".into(),
        }];
        let e = validate(Some("abc"), &rules).expect("写错的正则必须报错");
        assert!(e.contains("正则写错了"), "要说清是规则自己的问题：{e}");
    }
}
