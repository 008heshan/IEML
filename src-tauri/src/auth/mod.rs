//! 账号：微软正版登录 + 离线登录（ADR-016：令牌只存系统密钥环）
//!
//! 为什么用**设备代码流（Device Code Flow）**而不是内嵌浏览器或本地回环：
//!   * 微软已限制内嵌 WebView 登录，硬做会导致账号风控（`ARCHITECTURE.md` 第 7 章）
//!   * 回环方式需要应用注册自己的 client_id 与回调地址，个人开发者拿不到
//!   * 设备代码流**由用户在系统浏览器里输入一个短代码**完成授权，
//!     全程不接触用户密码，也不违反微软的风控策略 —— 这是最稳的一条路
//!
//! 令牌存储：`keyring` crate 写进系统凭据管理器（Windows Credential Manager /
//! macOS Keychain / Linux Secret Service），**绝不落明文配置文件**。

use serde::{Deserialize, Serialize};
use std::sync::RwLock;
use std::time::{Duration, Instant};

/*
 * ====================== 微软应用的 client_id ======================
 *
 * ★★★ **这一块以前是假的，而且是实测出来的。**
 *
 *   老代码写死了一个 client_id：`00000000402b5328`。
 *   它是 Minecraft 官方启动器历史上用过的那个 —— 但**微软已经把它删掉了**。
 *   真机验证（2026-09-14，直接打微软的接口）：
 *   ```text
 *   POST https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode
 *   → 400 {"error":"unauthorized_client",
 *          "error_description":"AADSTS700016: Application with identifier
 *          '00000000402b5328' was not found in the directory ..."}
 *   ```
 *   也就是说：**正版登录从第一天起就是不可能成功的**。
 *
 * ## 2026-09-14 第十四轮：用户要求"就用这个 ID"，于是**又实测了一遍**
 *
 *   探针 `tools/probe/probe-ms-clientids.ps1`（同一批请求里带一个**随机编造**
 *   的 id 作对照组）：
 *
 *   | client_id | 结果 |
 *   |---|---|
 *   | `00000000402b5328`（官方启动器旧 id） | **400 AADSTS700016 不存在** |
 *   | `<随机编造>` | 400 AADSTS700016 —— **和上面一模一样** |
 *   | `c36a9fb6-4f2a-41ff-90bd-ae7cc92031eb`（Prism Launcher 公开 id） | **200，真的发了设备码** |
 *
 *   对照组说明了一件事：那个 id 现在的状态就是"**没注册过**"，
 *   写进代码等于交付一个"点了必然失败"的按钮 —— 那不是"照 PCL 做"，
 *   那是又造一个假承诺。
 *
 * ## 2026-09-15：内置值换成**用户提供的那把 id**
 *
 *   用户明确要求换成 `32bde9cc-96cf-4f9d-ae6a-a83afadc0c7f`，并说明
 *   **"不要验证，只换上"** —— 所以这一把**没有**经过实测（下面那张表里没有它）。
 *
 *   ★ 这一点在代码里写明，是有意的：**不把"没验过的"说成"验过的"**。
 *     它是能在微软那边注册过的应用、还是又一个不存在的 id，只有第一次真的
 *     点登录才知道；真不认的时候，界面会把 `AADSTS700016` 翻成人话
 *     （"微软说这个应用 ID 不存在"），而不是丢一句英文报错给用户。
 *
 *   想自己确认的话，探针一条命令：
 *   `powershell -NoProfile -ExecutionPolicy Bypass -File tools/probe/probe-ms-clientids.ps1`
 *
 * ## 仍然可以覆盖（优先级：**设置页 > 环境变量 > 内置**）
 *
 *   ① 界面里「登录用的应用 ID → 换成自己的」（落盘，长期有效），或
 *   ② 环境变量 `IEML_MS_CLIENT_ID`。
 *   内置只是**兜底** —— 换掉 `BUILTIN_CLIENT_ID` 这一个常量即可换成别的应用身份。
 */

/// 内置的 client_id —— **用户自己的 Azure 应用注册**（2026-09-15 换上；2026-09-25 用户确认为本人注册）。
///
/// ★ 它只决定"用哪个应用身份去问微软要设备码"，与账号、令牌无关；
///   换掉这一个常量就能切成别的应用，不需要动任何别的地方。
///
/// ★★ **授权页会显示这个注册的应用名**（用户要的就是"显示 IEML"）——
///   名字由 **Azure 应用注册里的那个应用**决定，**不是**由这个字符串决定的，
///   所以"把 id 藏进 CI Secret"既改不了显示名、也挡不住想拿它的人
///   （exe 里的字符串是明文可读的，2026-09-25 实测过：一条字符串扫描就能捞出来）。
///   ⇒ 结论：**它就该留在这里**，别为它加构建时注入那一套。
/// ★ 泄漏它的后果有限：设备码流程是**公开客户端**（没有 client_secret），
///   拿到它的人只能"用你的应用身份登录"，动不了这个账号。
///
/// ★ 2026-09-25 更正一处**长期误导人的旧注释**：本文件里曾有多处写"内置的是
///   Prism Launcher 的公开 id"—— 错的。Prism 那把（`c36a9fb6-…`）只是当年
///   挑 id 时的**对照样本**（见本文件开头的实测表），从来没有当过内置值。
const BUILTIN_CLIENT_ID: &str = "32bde9cc-96cf-4f9d-ae6a-a83afadc0c7f";

/// 运行期指定的 client_id（由设置页/启动参数注入）
static CLIENT_ID_OVERRIDE: RwLock<Option<String>> = RwLock::new(None);

/// 设一个 client_id（来自设置页或启动参数）。
pub fn set_client_id(id: &str) {
    let trimmed = id.trim().to_string();
    if let Ok(mut g) = CLIENT_ID_OVERRIDE.write() {
        *g = if trimmed.is_empty() { None } else { Some(trimmed) };
    }
}

/// client_id 存在哪 —— 与 `instances.json` / `prefs.json` 同级，
/// 也就是**启动器自己的家**（`own_root`，`%APPDATA%\IEML`）。
///
/// ★★ A-4（2026-09-24）：与那两个 JSON 一起搬出**游戏根目录** ——
///   以前它在 `paths.root` 下，用户删掉那个游戏根目录时它会跟着没，
///   而它是"填过一次就该长期有效"的东西。老位置那份由
///   `platform::adopt_records` 在启动时收养（只复制、不删源）。
///
/// ★ 为什么要落盘：用户在设置页填一次就该长期有效。
///   不存的话"每次启动都要重填"—— 那比不做还烦人。
///
/// ★ 为什么单开一个文件而不是塞进 prefs.json：
///   `prefs.json` 是**前端**管的（`save_prefs` 会把整个 JSON 覆盖写回），
///   而 client_id 是后端启动时就要用的（早于前端加载偏好）。
///   放一起会出现"前端用旧值覆盖掉刚写的 id"这种竞态。
pub fn client_id_file(paths: &crate::platform::AppPaths) -> std::path::PathBuf {
    paths.own_file("ms_client_id.txt")
}

/// 启动时读一次（lib.rs 里调用）。
pub fn load_client_id_from_disk(paths: &crate::platform::AppPaths) {
    // 读：优先 own_root，那儿没有才回退到游戏根目录的老位置（A-4）
    let Some(store) = paths.own_file_for_read("ms_client_id.txt") else {
        return;
    };
    if let Ok(text) = std::fs::read_to_string(store) {
        let first = text.lines().next().unwrap_or("").trim().to_string();
        if first.is_empty() {
            return;
        }
        /*
         * ★★ 磁盘上是**占位符**时**不采用**（回落到内置 / 环境变量）。
         *
         *   实测现场：本机的 `ms_client_id.txt` 里是
         *   `11111111-2222-3333-4444-555555555555` —— 一个手打的假 GUID。
         *   因为"文件 > 内置"的优先级，它会把**实测可用**的内置 id 挤掉，
         *   于是点登录只会拿到 AADSTS700016，而界面还写着"正在用你自己填的"。
         *
         *   处理方式：**不采用、不删除**（文件是用户的数据），只说清为什么。
         */
        if looks_like_placeholder(&first) {
            say!(
                "[IEML/auth] 磁盘上的 client_id（{}…）看起来是占位符，已忽略 —— \
                 本次改用内置 / 环境变量里的 id；要固定使用就在设置里填一个真的",
                &first[..first.len().min(8)]
            );
            return;
        }
        set_client_id(&first);
        say!(
            "[IEML/auth] 已载入正版登录用的 client_id（{}…）",
            &first[..first.len().min(8)]
        );
    }
}

/// 这个字符串看得出是**占位符**吗？（全零 / 连号 / 同一个数字重复）
///
/// ★★ 判据只有这一份，`save_client_id`（保存时拦）与 `load_client_id_from_disk`
///   （启动时忽略）都调它 —— 两处各写一份的话，迟早一处拦住、另一处照用。
///
/// ## 为什么必须有"忽略"这一半（0.1.0-beta.3 实测）
///
///   本机数据目录里真实存在一个 `ms_client_id.txt`：
///   ```
///   11111111-2222-3333-4444-555555555555
///   ```
///   这是**明显的手打占位符**（连号 GUID）。而内置的那把 id 是实测可用的
///   —— 它是**用户自己 Azure 应用注册**的 client_id（见 `BUILTIN_CLIENT_ID` 的说明），
///   授权页上显示的就是那个注册的应用名。
///   ★ 2026-09-25 更正：这里原来写的是"Prism Launcher 公开 id"，**那是错的** ——
///   内置的那把从来都是用户自己的；Prism 那把（`c36a9fb6-…`）只是当初的**对照样本**
///   （见本文件开头的实测表）。照旧注释去理解，会以为"内置的是别人的公开 id"。
///   由于优先级是"文件 > 环境变量 > 内置"，这个假值会把**能用的**那把挤掉 ——
///   用户点登录只会收到 `AADSTS700016`，而界面还理直气壮地说"正在用你自己填的"。
///
///   所以：假值**保存时拒绝**（以后不会再写进去），**启动时忽略**（已经在里面的
///   那些不再生效，回落到内置）。**不动用户的文件** —— 那是他的数据，
///   我们只是不去用一个可证明为假的 id。
pub fn looks_like_placeholder(id: &str) -> bool {
    // ★ 先 trim：全是空格的值是"没填"，不是"占位符"（两条路调用方处理方式不同）。
    //   这一条是**测试先抓出来的** —— 原来的写法只过滤 `-`，
    //   于是 `"   "` 会命中"所有字符都相同"那条规则，被判成占位符。
    let id = id.trim();
    let compact: String = id.chars().filter(|c| *c != '-').collect();
    if compact.trim().is_empty() {
        return false; // 空值由调用方按"没填"处理
    }
    // ① 全零 / 全同一个字符
    let first = compact.chars().next().unwrap();
    if compact.chars().all(|c| c == '0') || compact.chars().all(|c| c == first) {
        return true;
    }
    // ② GUID 的四个段各自是"同一个数字重复"（11111111-2222-3333-…）
    let segs: Vec<&str> = id.split('-').filter(|s| !s.is_empty()).collect();
    if segs.len() == 5 {
        let all_repeat = segs.iter().all(|s| {
            let mut it = s.chars();
            match it.next() {
                Some(c) => it.all(|x| x == c),
                None => true,
            }
        });
        if all_repeat {
            return true;
        }
    }
    // ③ 连号（12345678-1234-1234-…）
    let seq = "0123456789";
    if compact.len() >= 8 && seq.contains(&compact[..8.min(compact.len())]) {
        return true;
    }
    false
}

/// 保存并生效（设置页调用）。
pub fn save_client_id(paths: &crate::platform::AppPaths, id: &str) -> Result<()> {
    let trimmed = id.trim().to_string();
    if trimmed.is_empty() {
        let _ = std::fs::remove_file(client_id_file(paths));
        /*
         * ★ A-4：老位置（游戏根目录）那份也一起删掉。
         *   不删的话，下一次启动 `adopt_records` 会把刚被清掉的 id 又收养回来 ——
         *   用户会觉得"清空没用"。（这里删的是**用户刚刚要求清掉**的东西，
         *   与"只复制、绝不删源"那条规矩不冲突：那条规矩管的是**自动**搬运。）
         */
        let _ = std::fs::remove_file(paths.legacy_record_file("ms_client_id.txt"));
        set_client_id("");
        return Ok(());
    }
    /*
     * ★ 明显的假值要拦住：全零、连号、同一个数字重复的 GUID。
     *
     *   实测过：拿 `00000000-0000-0000-0000-000000000000` 去打微软会得到
     *   `AADSTS700016`；本机还真的躺着一个 `11111111-2222-…`（见
     *   `looks_like_placeholder` 的说明）。用户如果手滑粘了个占位符，
     *   应该在**保存时**就被告知，而不是等登录失败再猜。
     *   （不拦别的格式 —— 合法 client_id 的形状不止一种，
     *    我们没有资格替微软做格式校验，只挡这些一眼假的。）
     */
    if looks_like_placeholder(&trimmed) {
        return Err(AuthError::Other(
            "这看起来是一个占位符（全零 / 连号 / 重复数字），不是真的 client_id。\n\
             请到 portal.azure.com → 应用注册里复制「应用程序(客户端) ID」。"
                .into(),
        ));
    }
    if let Some(p) = client_id_file(paths).parent() {
        std::fs::create_dir_all(p).map_err(|e| AuthError::Other(format!("创建数据目录失败：{e}")))?;
    }
    std::fs::write(client_id_file(paths), format!("{trimmed}\n"))
        .map_err(|e| AuthError::Other(format!("保存 client_id 失败：{e}")))?;
    set_client_id(&trimmed);
    Ok(())
}

/// 当前生效的 client_id（`None` = 没有配置，正版登录用不了）。
///
/// 优先级：**运行期注入（设置页）> 环境变量 > 编译期内置**。
///
/// ★ 顺序在 2026-09-14 第十四轮改过一次：内置值以前排在环境变量**前面**，
///   于是"我们自己注册了应用、用 `IEML_MS_CLIENT_ID` 覆盖"这条路过不去 ——
///   内置有值时环境变量永远轮不到。现在显式填的（无论是设置页还是环境变量）
///   都说话更算数，内置只是**兜底**。
pub fn client_id() -> Option<String> {
    client_id_with_source().map(|(id, _)| id)
}

/// 当前生效的 client_id **以及它是从哪来的**。
///
/// ★ 为什么要连来源一起给：用户在授权页看到的**应用名**是"这个 client_id 所属应用"的
///   名字 —— 而内置的那把是**用户自己 Azure 应用注册**的 id，所以页面显示的是
///   **那个注册的名字**（不是 Prism、也不是任何第三方）。
///   ★ 2026-09-25 更正：这里原来写"实测：内置的是 Prism Launcher 的公开 id，
///   页面就写「已登录到 Prism Launcher」"—— **错的**，内置的一直是用户自己的注册。
///   界面必须能回答"现在用的是哪一把、是谁的"，否则用户只会觉得莫名其妙。
///
/// ★ 优先级只在这里实现**一次**（`client_id()` 也走它）—— 两处各写一份必然漂移。
pub fn client_id_with_source() -> Option<(String, &'static str)> {
    if let Ok(g) = CLIENT_ID_OVERRIDE.read() {
        if let Some(v) = g.as_ref().filter(|s| !s.trim().is_empty()) {
            return Some((v.clone(), "settings"));
        }
    }
    if let Some(v) = std::env::var("IEML_MS_CLIENT_ID")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    {
        return Some((v, "env"));
    }
    if !BUILTIN_CLIENT_ID.trim().is_empty() {
        return Some((BUILTIN_CLIENT_ID.trim().to_string(), "builtin"));
    }
    None
}

/// 正版登录能不能用（不能的话界面要如实说，而不是让用户白试一次）
pub fn ms_login_available() -> bool {
    client_id().is_some()
}

const SCOPE: &str = "XboxLive.signin offline_access";

const DEVICE_CODE_URL: &str = "https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode";
const TOKEN_URL: &str = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
/// ★ 刷新令牌走的是**另一个端点**。
///
///   实测踩过：老代码用 `login.microsoftonline.com/consumers/oauth2/v2.0/token`
///   去刷新，而 PCL（`ModLaunch.vb` 第 929 行）用的是
///   **`login.live.com/oauth20_token.srf`**。
///   `consumers` 那个端点对 `grant_type=refresh_token` 会返回
///   `invalid_request`，于是"静默续期"从来没成功过 —— 用户每次启动都要重登。
const REFRESH_URL: &str = "https://login.live.com/oauth20_token.srf";
const XBL_URL: &str = "https://user.auth.xboxlive.com/user/authenticate";
const XSTS_URL: &str = "https://xsts.auth.xboxlive.com/xsts/authorize";
const MC_LOGIN_URL: &str = "https://api.minecraftservices.com/authentication/login_with_xbox";
const MC_PROFILE_URL: &str = "https://api.minecraftservices.com/minecraft/profile";
const MC_ENTITLEMENTS_URL: &str = "https://api.minecraftservices.com/entitlements/mcstore";

const KEYRING_SERVICE: &str = "com.ieml.launcher";

/* ====================== 数据模型 ====================== */

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McAccount {
    pub username: String,
    /// 不带横线的 32 位 hex
    pub uuid: String,
    pub access_token: String,
    /// 微软 refresh token（用于自动续期）
    #[serde(default)]
    pub refresh_token: Option<String>,
    /// 账号类型：msa（正版） / legacy（离线）
    pub kind: String,
    #[serde(default)]
    pub expires_at: Option<u64>,
    /**
     * ★★★★ **Xbox 用户 ID**（2026-10-11 补）。
     *
     *   现代版本做在线动作时要 `--xuid`，而启动参数里原来传的是空字符串。
     *   值来自 XBL 那一步的 `DisplayClaims.xui[0].xid`，登录与续期都会拿到。
     *   老账号里没有这个字段（`serde(default)` ⇒ 空串），续期一次就会补上。
     */
    #[serde(default)]
    pub xuid: String,
}

impl McAccount {
    pub fn to_launch_account(&self) -> crate::game::launch_args::Account {
        crate::game::launch_args::Account {
            username: self.username.clone(),
            uuid: self.uuid.clone(),
            access_token: self.access_token.clone(),
            user_type: if self.kind == "msa" { "msa" } else { "legacy" }.to_string(),
            user_properties: "{}".to_string(),
            xuid: self.xuid.clone(),
        }
    }

    /// 令牌是否已过期（提前 5 分钟算过期）
    pub fn is_expired(&self) -> bool {
        match self.expires_at {
            Some(t) => {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                now + 300 >= t
            }
            None => false,
        }
    }
}

impl McAccount {
    /**
     * ★★★★ **要不要续期**（2026-10-11 补）。
     *
     *   为什么不能直接用 `is_expired()`：`expires_at` 是后来才加进结构体的
     *   （`#[serde(default)]`），**老账号里没有这个字段** ⇒ 反序列化出 `None`
     *   ⇒ `is_expired()` 永远返回 false ⇒ **永远不续期** ⇒
     *   令牌静默过期，游戏里全是 401（用户看到的就是「提供的令牌无效」）。
     *
     *   "不知道什么时候过期"唯一安全的解释是**当作已经过期**：
     *   续期一次是廉价的（一次网络往返 + 一个新令牌），
     *   而拿一份不知道死活的令牌去启动游戏，代价是玩家连不上任何在线服务。
     */
    pub fn needs_refresh(&self) -> bool {
        /*
         * ★★ 还有一件同样性质的事：**记录不完整也要续一次**。
         *
         *   `xuid` 是 2026-10-11 才加进 `McAccount` 的，而它是现代版本 `--xuid`
         *   的唯一来源（联机 / Realms / 好友列表都靠它）。老账号里没有它，
         *   而令牌可能还剩十几个小时 —— 只看过期时间的话，**要等到明天才会续期**，
         *   这一天里玩家的联机与好友功能全是坏的。
         *
         *   ⇒ "缺 xuid 的正版账号"也和"不知道什么时候过期"一样，当作要续期：
         *     续一次就有 xuid 了（顺带还刷新了令牌），代价是一次网络往返。
         */
        if self.kind == "msa" && self.xuid.is_empty() {
            return true;
        }
        self.expires_at.is_none() || self.is_expired()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("网络请求失败：{0}")]
    Http(#[from] reqwest::Error),
    #[error("微软返回错误：{0}")]
    Ms(String),
    #[error("这个微软账号没有购买 Minecraft Java 版")]
    NoEntitlement,
    #[error("账号被 Xbox 限制：{0}")]
    XboxRestricted(String),
    #[error("登录超时，请重新发起")]
    Timeout,
    #[error("密钥环操作失败：{0}")]
    Keyring(String),
    #[error("{0}")]
    Other(String),
}

/// ★★ 没配 client_id 时的说明 —— 必须**可行动**。
///
///   用户看到"登录失败"只会一头雾水；看到"缺一个微软应用 ID、去哪拿、
///   填在哪"才知道下一步做什么。这正是 ADR-041 要求的"界面上的承诺必须是真的"：
///   既然现在给不了一个能用的内置 id，就把这件事**说清楚**，
///   而不是让用户点一下、等半天、然后收到一句看不懂的英文报错。
pub fn missing_client_id_message() -> String {
    "正版登录需要先配置一个「微软应用 ID（client_id）」，当前没有配置。\n\n\
     为什么会这样：微软要求登录方必须是一个**在 Azure 注册过的应用**，\
     而这个 ID 属于要自己申请的资源，不能随启动器随便分发\
     （PCL 也是同样处理：它的开源版把 client_id 留空，由环境变量注入）。\n\n\
     三个办法，任选一个：\n\
     ① 在「设置 → 账号」里填入你自己的 client_id（一次填好，长期有效）；\n\
     ② 启动 IEML 之前设置环境变量 IEML_MS_CLIENT_ID=<你的 id>；\n\
     ③ 不想折腾就用离线模式 —— 单机游戏完全不受影响。\n\n\
     申请步骤（免费，约 5 分钟）：\n\
     \x20 portal.azure.com → 应用注册 → 新注册 →\n\
     \x20 「支持的帐户类型」选**个人 Microsoft 帐户** →\n\
     \x20 复制「应用程序(客户端) ID」填进来；\n\
     \x20 再到「身份验证」页把「允许公共客户端流」打开。"
        .to_string()
}

/// 把微软返回的原始错误翻成人话。
///
/// 来源：PCL 在 `MyMsgLogin.xaml.vb` 128-146 与 `ModLaunch.vb` 937-949 /
/// 991-1016 / 1034-1049 / 1086-1099 里逐条映射过的那些错误码。
/// 每一条都对应一个**用户能自己处理**的动作，所以在启动器里值得单独说。
pub fn explain_ms_error(raw: &str) -> String {
    // ① 最要紧的一条：client_id 本身不对
    if raw.contains("AADSTS700016") || raw.contains("unauthorized_client") {
        return format!(
            "这个微软应用 ID 不被微软认可（AADSTS700016）。\n\n{}",
            missing_client_id_message()
        );
    }
    if raw.contains("authorization_declined") {
        return "你在浏览器里拒绝了授权。想登录的话需要点「同意」。".into();
    }
    if raw.contains("expired_token") || raw.contains("code_expired") {
        return "登录用时太长，验证码已过期 —— 重新点一次「正版登录」即可。".into();
    }
    if raw.contains("Account security interrupt") {
        return "该账号由于安全问题无法登录，请前往微软账户页查看详情。".into();
    }
    if raw.contains("service abuse") {
        return "该账号已被微软封禁，无法登录。".into();
    }
    if raw.contains("AADSTS70000") || raw.contains("invalid_grant") {
        return "刷新凭证已失效，需要重新登录一次。".into();
    }
    if raw.contains("must sign in again") || raw.contains("password expired") {
        return "微软要求重新登录（密码可能已过期）。".into();
    }
    raw.to_string()
}

/// Xbox Live / XSTS 错误码 → 人话。
///
/// 来源：PCL `ModLaunch.vb` 991-1016（它参考的是 prismarine-auth 的常量表）。
/// **这套码是用户最容易卡住的地方** —— 每一条都对应一个具体的自救动作。
pub fn explain_xsts_error(raw: &str) -> Option<&'static str> {
    let table: [(&str, &str); 5] = [
        ("2148916227", "该账号似乎已被微软封禁，无法登录。"),
        (
            "2148916233",
            "这个微软账号还没有注册 Xbox 账户 —— 请先去 xbox.com 登录一次（会自动创建），然后再回来登录。",
        ),
        (
            "2148916235",
            "你网络所在的国家或地区不支持 Xbox Live —— 请使用加速器或 VPN 后再试。",
        ),
        (
            "2148916236",
            "这个账号需要先完成年龄验证才能登录。",
        ),
        (
            "2148916238",
            "这是未成年人账号，需要由家长把它加入 Microsoft 家庭组后才能登录。",
        ),
    ];
    table
        .iter()
        .find(|(code, _)| raw.contains(code))
        .map(|(_, msg)| *msg)
}

pub type Result<T> = std::result::Result<T, AuthError>;

/* ====================== 登录链全局节流（防 429） ====================== */

/// 两次「微软登录链」之间的最小间隔。
///
/// ★ 为什么要有它（2026-10-13，用户截图：`login_with_xbox` 频繁 HTTP 429）：
///   一次完整登录要连续打 devicecode / token / XBL / XSTS / login_with_xbox /
///   entitlements / profile 七个接口；用户在短时间内反复点「正版登录」，
///   等于让同一批微软接口吃 N 倍请求 —— 429 限流就是这么来的。
///   与其在被限流之后靠退避硬撑，不如在入口就按住节奏：
///   间隔内的重复登录直接告诉用户「稍等」，连接口都不打。
const LOGIN_MIN_INTERVAL: std::time::Duration = std::time::Duration::from_secs(8);

/// 上一次登录链开始时刻（`None` = 从未开始，第一次必然放行）。
static LAST_LOGIN_CHAIN_AT: std::sync::OnceLock<std::sync::Mutex<Option<std::time::Instant>>> =
    std::sync::OnceLock::new();

fn login_gate_mu() -> &'static std::sync::Mutex<Option<std::time::Instant>> {
    LAST_LOGIN_CHAIN_AT.get_or_init(|| std::sync::Mutex::new(None))
}

/// 纯函数：在 `now` 时刻，距上次登录链开始 `last` 是否已满 `min` 间隔。
/// 抽出便于离线单测（`tests/rate_limit_guard.rs`）。
pub fn login_gate_allows(
    last: Option<std::time::Instant>,
    now: std::time::Instant,
    min: std::time::Duration,
) -> bool {
    match last {
        Some(t) => now.duration_since(t) >= min,
        None => true,
    }
}

/// 检查是否允许开始一条新的登录链；放行时记录本次链的开始时间。
///
/// 间隔内再次调用**不打任何接口**，直接返回一句「请稍等 N 秒」。
/// 用于：新登录（`request_device_code`）与手动刷新（命令层 `account_refresh`）。
/// 自动续期路径（`refresh_msa` 由启动时 `needs_refresh` 驱动）**不走这里** ——
/// 它天然低频（令牌提前 5 分钟才续 + 失败有 300s 冷却），不该被卡。
pub fn login_gate_check() -> Result<()> {
    let mut guard = login_gate_mu().lock().unwrap_or_else(|p| p.into_inner());
    let now = std::time::Instant::now();
    if login_gate_allows(*guard, now, LOGIN_MIN_INTERVAL) {
        *guard = Some(now);
        Ok(())
    } else {
        let wait = LOGIN_MIN_INTERVAL
            .checked_sub(now.duration_since(guard.unwrap_or(now)))
            .unwrap_or_else(|| std::time::Duration::from_secs(1));
        Err(AuthError::Other(format!(
            "登录操作太频繁（为避免触发微软限流）。请 {} 秒后再试。",
            wait.as_secs().max(1)
        )))
    }
}

/* ====================== 设备代码流 ====================== */

#[derive(Debug, Clone, Serialize)]
pub struct DeviceCodeInfo {
    pub user_code: String,
    pub verification_uri: String,
    pub device_code: String,
    pub expires_in: u64,
    pub interval: u64,
    pub message: String,
}

/// 第一步：申请设备代码（用户要在浏览器里输入 user_code）
pub async fn request_device_code() -> Result<DeviceCodeInfo> {
    // ★ 登录链入口节流：短时间内反复点「正版登录」会让整套微软接口吃重复请求，
    //   429 限流就是这么来的 —— 在入口就按住节奏，不打接口。
    login_gate_check()?;

    // ★ 没有 client_id 就直接说清楚，**不要**去请求然后返回一句英文报错。
    //   实测：拿一个不存在的 id 去请求，微软回的是
    //   `AADSTS700016: Application with identifier ... was not found` ——
    //   普通用户完全看不懂，而且会以为是我们坏了。
    let Some(cid) = client_id() else {
        return Err(AuthError::Other(missing_client_id_message()));
    };

    let client = crate::net::client();
    let resp = client
        .post(DEVICE_CODE_URL)
        .form(&[("client_id", cid.as_str()), ("scope", SCOPE)])
        .send()
        .await?;

    if !resp.status().is_success() {
        let t = resp.text().await.unwrap_or_default();
        return Err(AuthError::Ms(explain_ms_error(&t)));
    }

    #[derive(Deserialize)]
    struct Raw {
        user_code: String,
        device_code: String,
        verification_uri: String,
        expires_in: u64,
        #[serde(default = "default_interval")]
        interval: u64,
        #[serde(default)]
        message: String,
    }
    fn default_interval() -> u64 {
        5
    }

    let raw: Raw = resp.json().await?;
    Ok(DeviceCodeInfo {
        user_code: raw.user_code,
        verification_uri: raw.verification_uri,
        device_code: raw.device_code,
        expires_in: raw.expires_in,
        interval: raw.interval,
        message: raw.message,
    })
}

/// 第二步：轮询换取微软令牌，然后一路换到 Minecraft 令牌。
///
/// 这是**阻塞式**的：会一直轮询到用户在浏览器里完成授权或超时。
/// 前端应在独立任务里调用，并展示 `user_code`。
pub async fn poll_for_token(device_code: &str, interval_secs: u64, expires_in: u64) -> Result<McAccount> {
    let Some(cid) = client_id() else {
        return Err(AuthError::Other(missing_client_id_message()));
    };
    let client = crate::net::client();
    let started = Instant::now();
    let interval = Duration::from_secs(interval_secs.max(3));
    let deadline = Duration::from_secs(expires_in.min(900));

    loop {
        if started.elapsed() > deadline {
            return Err(AuthError::Timeout);
        }
        tokio::time::sleep(interval).await;

        let resp = client
            .post(TOKEN_URL)
            .form(&[
                ("client_id", cid.as_str()),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                ("device_code", device_code),
                /*
                 * ★★ `scope` 这一个字段**不能省**。
                 *
                 *   设备码流程的 RFC 8628 与微软的 v2 端点都要求：**换令牌时
                 *   再带一次同样的 scope**。只在 devicecode 那一步带是不够的。
                 *
                 *   这是照 PCL 抄的（`MyMsgLogin.xaml.vb` 111-114 行）：
                 *     grant_type=...&client_id=...&device_code=...&scope=XboxLive.signin%20offline_access
                 *   它**也带了** scope —— 权威实现这么做，我们就不该省。
                 *
                 *   实测教训（同一个仓库里已经犯过一次同类的错）：
                 *   刷新令牌那一步原来误用了
                 *   `login.microsoftonline.com/.../token`，而微软的刷新端点是
                 *   `login.live.com/oauth20_token.srf`（PCL 第 929 行）。
                 *   "少一个字段 / 用错一个端点"这类错误，表现都是
                 *   一句看不懂的英文报错，然后整条登录链路走不通。
                 */
                ("scope", SCOPE),
            ])
            .send()
            .await?;

        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();

        if status.is_success() {
            #[derive(Deserialize)]
            struct Tok {
                access_token: String,
                #[serde(default)]
                refresh_token: String,
                #[serde(default)]
                expires_in: u64,
            }
            let tok: Tok = serde_json::from_str(&text)
                .map_err(|e| AuthError::Ms(format!("解析令牌响应失败：{e}")))?;
            return complete_login(&tok.access_token, Some(tok.refresh_token), tok.expires_in).await;
        }

        // 还在等用户操作 → 继续轮询
        if text.contains("authorization_pending") {
            continue;
        }
        if text.contains("slow_down") {
            tokio::time::sleep(Duration::from_secs(5)).await;
            continue;
        }
        // ★ 429：轮询也被限流 —— 明确说清，不丢给 explain_ms_error 猜。
        if status.as_u16() == 429 {
            return Err(AuthError::Ms(
                "轮询太频繁，已被微软限流。请等待几分钟后再试。".into(),
            ));
        }
        // 其余错误全部翻成人话（含 client_id 不对、账号被封、安全拦截等）
        return Err(AuthError::Ms(explain_ms_error(&text)));
    }
}

/**
 * POST 一个 JSON 请求体：**先看状态码，再解析**，并只在"可能瞬时"时重试。
 *
 * 为什么需要它（2026-10-11，用户：「游戏说提供的令牌无效」）：
 *   这条链上原来每处都是 `.post(...).json(&body).send().await?.json().await?`
 *   —— 两个毛病：
 *     ① 状态码没看，于是**服务端说得清清楚楚的错误体**被当成"解析失败"吞掉，
 *        用户只看到一句 `error decoding response body`（XErr 才是答案）；
 *     ② 没有任何重试，而 HTTP 长连接被服务端先关掉是**常事** ——
 *        这时复用它读到的响应体会读到一半，reqwest 报的就是那句 decoding 错误。
 *        一次抖动 ⇒ 整次续期失败 ⇒ 密钥环里那份令牌永远停在过期状态
 *        ⇒ 游戏进任何在线服务都是 401。
 *
 * 重试策略：网络错 / 2xx 但解析不了 / 5xx / 408 ⇒ 重试（最多 3 次，短退避 1s、3s）；
 * **429（限流）单独对待**：长退避（2s、8s）且尊重服务端 `Retry-After` ——
 *   429 的语义是"你太快了"，按老策略 1s/3s 立刻重试只会再吃一次（见 `backoff_after`）。
 * 账号侧的 4xx（XErr 那种）**不重试** —— 重试也没用，只会让用户白等。
 */
async fn post_json_with_retry(
    client: &reqwest::Client,
    url: &str,
    body: &serde_json::Value,
    what: &str,
) -> Result<serde_json::Value> {
    let (status, text) = post_with_retry(client, url, body, what).await?;
    serde_json::from_str::<serde_json::Value>(&text).map_err(|e| {
        AuthError::Ms(format!(
            "{what} 返回的内容无法解析：{e}（HTTP {status}；原始返回：{}）",
            truncate_for_message(&text)
        ))
    })
}

/**
 * 与 `post_json_with_retry` 同一套重试，但**把状态码与原文交给调用方**。
 *
 * 给"错误码要按各自的含义分别说话"的那一步用（Minecraft 登录：429 / 403 / 503 /
 * ACCOUNT_SUSPENDED 各有各的自救动作，不能用一句通用的话糊过去）。
 *
 * 2026-10-13 补充（用户截图：login_with_xbox 频繁 HTTP 429）：
 *   ① **429 单独走长退避**：等 2s、8s（尊重服务端 `Retry-After`，封顶 30s），
 *      而不是和网络抖动共用 1s/3s —— 429 是"你太快了"，短退避等于白打；
 *   ② 三次都 429 时，报错里直接写明"被限流 + 建议等待"，不再含糊。
 */
async fn post_with_retry(
    client: &reqwest::Client,
    url: &str,
    body: &serde_json::Value,
    what: &str,
) -> Result<(reqwest::StatusCode, String)> {
    let mut last: Option<String> = None;
    for attempt in 1..=3u32 {
        let resp = match client.post(url).json(body).send().await {
            Ok(r) => r,
            Err(e) => {
                last = Some(format!("{what} 请求失败：{e}"));
                if attempt < 3 {
                    tokio::time::sleep(backoff_after(attempt, 0, None)).await;
                }
                continue;
            }
        };
        let status = resp.status();
        let code = status.as_u16();
        let retry_after = resp
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.trim().parse::<u64>().ok());
        let text = resp.text().await.unwrap_or_default();
        if status.is_success() {
            return Ok((status, text));
        }
        let hint = explain_xsts_error(&text)
            .map(str::to_string)
            .unwrap_or_else(|| format!("{what} 认证失败"));
        last = Some(format!(
            "{hint}（HTTP {status}；原始返回：{}）",
            truncate_for_message(&text)
        ));
        if !(code >= 500 || code == 408 || code == 429) {
            break;
        }
        if attempt < 3 {
            tokio::time::sleep(backoff_after(attempt, code, retry_after)).await;
        }
    }
    let mut msg = last.unwrap_or_else(|| format!("{what} 失败，且没有拿到任何响应"));
    // ★ 三次都被限流 → 明确告诉用户"这是限流、要等"，而不是一句干巴巴的 HTTP 429。
    if msg.contains("HTTP 429") {
        msg = format!(
            "{what} 被限流（HTTP 429）：登录/请求太过频繁。已自动退避重试仍未成功，请等待几分钟后再试。（{msg}）"
        );
    }
    Err(AuthError::Ms(msg))
}

/**
 * 一次失败后的下次重试等待时间。
 *
 * - `failed_attempt`：**刚失败的是第几次尝试**（1 = 首次失败，2 = 重试又失败）。
 * - `code == 429`：长退避（2s → 8s），并取 `Retry-After` 与基础退避的较大者，封顶 30s。
 * - 其余瞬时错误（网络错 / 5xx / 408）：短退避（1s → 3s），维持原行为。
 * - `code == 0` 表示网络层直接失败（没有响应），按短退避处理。
 *
 * 纯函数，便于离线单测（`tests/rate_limit_guard.rs`）。
 */
pub fn backoff_after(failed_attempt: u32, code: u16, retry_after: Option<u64>) -> std::time::Duration {
    const RATE_LIMIT_CAP_SECS: u64 = 30;
    const RATE_LIMIT_SHORT_SLEEP_SECS: u64 = 2;
    const RATE_LIMIT_LONG_SLEEP_SECS: u64 = 8;
    const TRANSIENT_SHORT_SLEEP_SECS: u64 = 1;
    const TRANSIENT_LONG_SLEEP_SECS: u64 = 3;

    let is_rate_limit = code == 429;
    let base = if is_rate_limit {
        if failed_attempt <= 1 {
            RATE_LIMIT_SHORT_SLEEP_SECS
        } else {
            RATE_LIMIT_LONG_SLEEP_SECS
        }
    } else if failed_attempt <= 1 {
        TRANSIENT_SHORT_SLEEP_SECS
    } else {
        TRANSIENT_LONG_SLEEP_SECS
    };
    let wait = retry_after
        .filter(|_| is_rate_limit)
        .map(|r| r.min(RATE_LIMIT_CAP_SECS).max(base))
        .unwrap_or(base);
    std::time::Duration::from_secs(wait)
}

/// 把一段响应体截短了放进报错里（日志与界面都不该被一坨 JSON 撑爆）
fn truncate_for_message(text: &str) -> String {
    let one_line = text.replace(['\r', '\n'], " ");
    let mut s: String = one_line.chars().take(300).collect();
    if one_line.chars().count() > 300 {
        s.push('…');
    }
    s
}

/**
 * 从 Minecraft 的 access token（一个 JWT）里读出 **XUID**。
 *
 * ## 为什么绕这一下（2026-10-11，真机试出来的）
 *
 *   `--xuid` 是现代版本联机/好友/Realms 的前提，所以要拿到玩家的 XUID。
 *   试过两个来源，只有这个靠谱：
 *
 *     · **XBL 的 DisplayClaims**：只有 `uhs`，**没有** XUID（实测打印过键名）；
 *     · **XSTS 的 DisplayClaims**：文档说带 `xid`，可真机上取回来是空的；
 *     · **MC access token 的载荷**：`xuid` / `xid` 都在里面 ✔
 *       （真机抓到的载荷里有 `"xuid":"2535470293336241"`）。
 *
 * ★ 只解 base64 读载荷，**不验签** —— 这是我们自己刚拿到的令牌，
 *   要的是里面的字段，不是可信性判断（JWT 的签名该由发证方校验，
 *   我们没有任何理由替 Minecraft 服务端做这件事）。
 * ★ 解不出来就返回空串：`--xuid` 那一步会因此不传（见 `build_command`），
 *   而不是把"没有"说成某个值。
 */
pub fn xuid_from_mc_token(token: &str) -> String {
    let payload = match token.split('.').nth(1) {
        Some(p) => p,
        None => return String::new(),
    };
    // base64url（无填充）→ 标准 base64 → 字节
    let std_b64: String = payload
        .chars()
        .map(|c| match c {
            '-' => '+',
            '_' => '/',
            other => other,
        })
        .collect();
    let padded = match std_b64.len() % 4 {
        2 => format!("{std_b64}=="),
        3 => format!("{std_b64}="),
        _ => std_b64,
    };
    let bytes = match base64_decode(&padded) {
        Some(b) => b,
        None => return String::new(),
    };
    let text = String::from_utf8_lossy(&bytes);
    let v: serde_json::Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => return String::new(),
    };
    for key in ["xuid", "xid"] {
        if let Some(s) = v[key].as_str() {
            if !s.is_empty() {
                return s.to_string();
            }
        }
        // 也接受数字形态（不同版本给的类型不一样）
        if let Some(n) = v[key].as_u64() {
            return n.to_string();
        }
    }
    String::new()
}

/// 极小的 base64 解码（只给 JWT 载荷用，不引入新依赖）
fn base64_decode(s: &str) -> Option<Vec<u8>> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut buf: u32 = 0;
    let mut bits = 0u32;
    for c in s.bytes() {
        if c == b'=' {
            break;
        }
        let idx = TABLE.iter().position(|&t| t == c)? as u32;
        buf = (buf << 6) | idx;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buf >> bits) & 0xFF) as u8);
        }
    }
    Some(out)
}

/// 第三步：微软 access token → Xbox Live → XSTS → Minecraft → 玩家档案
async fn complete_login(    ms_access_token: &str,
    refresh_token: Option<String>,
    expires_in: u64,
) -> Result<McAccount> {
    let client = crate::net::client();

    /* ---------- Xbox Live ---------- */
    let xbl_body = serde_json::json!({
        "Properties": {
            "AuthMethod": "RPS",
            "SiteName": "user.auth.xboxlive.com",
            "RpsTicket": format!("d={ms_access_token}")
        },
        "RelyingParty": "http://auth.xboxlive.com",
        "TokenType": "JWT"
    });
    /*
     * ★★★★ 2026-10-11 修（用户截图：「游戏里弹『提供的令牌无效』」）—— 这一处是总病根。
     *
     * ## 原来错在哪（两件事叠在一起）
     *
     *   ① **先 `.json()` 后看状态码**：XBL 失败时返回的其实是一份**说得很清楚**的 JSON
     *      （`{"Identity":"0","XErr":2148916233,"Message":"…"}`），
     *      可代码直接当成功体解析，失败就报一句
     *      「Xbox Live 认证失败：error decoding response body」——
     *      用户和我们都看不出到底发生了什么（XErr 才是答案）。
     *   ② **没有任何重试**：HTTP 长连接被服务端先关掉时，复用它拿到的响应体会**读到一半**，
     *      reqwest 报的正是 `error decoding response body`。一次这样的抖动
     *      就让整次续期失败 —— 于是密钥环里那份令牌一直停在过期状态，
     *      游戏拿它去连任何在线服务都是 **401**（用户看到的就是这个）。
     *
     *      真机现场：同一份 refresh token、同一台机器，
     *      用启动器自己的 reqwest 直接打这两个接口**每次都成功**；
     *      而走这条命令路径**每次都失败** ⇒ 就是这种瞬时断流 + 无重试。
     *
     * ## 现在
     *
     *   · 先看状态码，**保留响应体**；
     *   · 失败按 XErr 翻成人话（与 XSTS 共用一张表），并把原始返回带上；
     *   · 网络错 / 5xx / 429 / 408 / 解析失败 ⇒ **重试 3 次**（0.6s、1.5s 退避）；
     *   · 客户端自己的 4xx 不重试（重试也没用，只会让用户多等）。
     */
    let xbl: serde_json::Value = post_json_with_retry(client, XBL_URL, &xbl_body, "Xbox Live").await?;

    let xbl_token = xbl["Token"]
        .as_str()
        .ok_or_else(|| AuthError::Ms("Xbox Live 没有返回 Token".into()))?
        .to_string();
    let uhs = xbl["DisplayClaims"]["xui"][0]["uhs"]
        .as_str()
        .ok_or_else(|| AuthError::Ms("Xbox Live 没有返回用户哈希".into()))?
        .to_string();
    /*
     * ★ XUID：现代版本的 `--xuid` 要用它，而原来**整条链都没取过这个值**
     *   （`launch_args` 里传的是空字符串 ⇒ 在线功能全废）。
     *
     *   ★★ 取值位置是踩过的坑：**XBL 这一步的 DisplayClaims 里只有 `uhs`**，
     *      XUID（`xid`）在 **XSTS** 的 DisplayClaims 里。写在取 `uhs` 的旁边
     *      只会拿到空串（真机验证过：XBL 返回的键是
     *      IssueInstant / NotAfter / Token / DisplayClaims，里面没有 xid）。
     *      ⇒ 所以它挪到下面 XSTS 之后取。
     */

    /* ---------- XSTS ---------- */
    let xsts_body = serde_json::json!({
        "Properties": { "SandboxId": "RETAIL", "UserTokens": [xbl_token] },
        "RelyingParty": "rp://api.minecraftservices.com/",
        "TokenType": "JWT"
    });
    /*
     * ★★ 2026-10-11：这一步也走"先看状态码 + 重试"（与 XBL 同一个道理）。
     *
     *   真机现场（修好 XBL 的重试之后紧接着暴露出来的就是它）：
     *     ③ 失败：XSTS 授权失败（**原始返回是空的**）
     *   也就是说这一步同样碰上了"响应体是空的"——一次抖动就让续期全程失败。
     *   而 XErr 的翻译表（账号被封 / 未成年人 / 地区不支持…）照旧生效：
     *   非 2xx 时 `post_json_with_retry` 会用同一张表把原因说出来。
     */
    let xsts: serde_json::Value = post_json_with_retry(client, XSTS_URL, &xsts_body, "XSTS")
        .await
        .map_err(|e| match e {
            // ★ 这一步的错误要保留原来的类型：界面靠它区分"账号被限制"与"网络问题"
            AuthError::Ms(m) if m.contains("该账号") || m.contains("Xbox") => AuthError::XboxRestricted(m),
            other => other,
        })?;
    let xsts_token = xsts["Token"]
        .as_str()
        .ok_or_else(|| AuthError::Ms("XSTS 没有返回 Token".into()))?
        .to_string();
    /*
     * ★★ XUID 的取法（2026-10-11，真机上逐一试过）：
     *
     *   · XBL 的 DisplayClaims 里**只有 `uhs`**，没有 XUID（打印过键名）；
     *   · XSTS 的 DisplayClaims 文档说带 `xid`，可真机取回来是**空的**；
     *   · **MC access token 的载荷里有 `xuid`** ✔（真机抓到的令牌里有
     *     `"xuid":"2535470293336241"`）—— 所以以它为准，XSTS 那边留作兜底。
     *
     *   拿不到不算致命（离线身份本来就没有）：留空即可，
     *   `build_command` 会因此**不传** `--xuid`，而不是传一个空值
     *   （空值会把后面的 `--userType` 吃掉）。
     */
    let xsts_xuid = xsts["DisplayClaims"]["xui"][0]["xid"]
        .as_str()
        .unwrap_or("")
        .to_string();

    /* ---------- Minecraft 登录 ---------- */
    let mc_body = serde_json::json!({
        "identityToken": format!("XBL3.0 x={uhs};{xsts_token}")
    });
    /*
     * ★★ 2026-10-11：这一步同样要"网络层重试 + 保留原文"。
     *   真机现场（把 XBL、XSTS 的重试都补上之后，失败点又往后挪到了这里）：
     *     网络请求失败：error sending request for url
     *       (https://api.minecraftservices.com/authentication/login_with_xbox)
     *   —— 一次连接失败就让整次续期前功尽弃，而这一步离成功只差一步。
     *   下面那几个状态码的专门说法**照旧**（它们对应完全不同的自救动作）。
     */
    let (mc_status, mc_text) =
        post_with_retry(client, MC_LOGIN_URL, &mc_body, "Minecraft 登录").await?;
    if !mc_status.is_success() {
        /*
         * ★ 这几个状态码必须分开说 —— 它们对应**完全不同的自救动作**，
         *   合成一句"Minecraft 登录失败"等于什么都没说。
         *   来源：PCL `ModLaunch.vb` 1034-1049。
         */
        let hint = match mc_status.as_u16() {
            429 => {
                "登录尝试太过频繁，已被微软限流。\n\
                 请等待 5-10 分钟后再试；等待期间请不要反复点击登录。"
            }
            403 => {
                "当前 IP 的登录尝试异常。\n\
                 如果你开着 VPN 或加速器，请关掉或换个节点再试。"
            }
            503 => "Mojang 的服务器现在有问题，你的网络没问题 —— 稍后再试。",
            _ if mc_text.contains("ACCOUNT_SUSPENDED") => "该账号已被封禁，无法登录。",
            _ => "Minecraft 登录失败。",
        };
        return Err(AuthError::Ms(format!(
            "{hint}\n（HTTP {mc_status}：{mc_text}）"
        )));
    }
    let mc: serde_json::Value = serde_json::from_str(&mc_text)
        .map_err(|e| AuthError::Ms(format!("解析 Minecraft 登录响应失败：{e}")))?;
    let mc_token = mc["access_token"]
        .as_str()
        .ok_or_else(|| AuthError::Ms("Minecraft 没有返回 access_token".into()))?
        .to_string();
    let mc_expires_in = mc["expires_in"].as_u64().unwrap_or(86400);

    /* ---------- 有没有买游戏？ ---------- */
    // 先查权益（这一步能给出比"档案不存在"更清楚的原因）
    if let Ok(ent) = client
        .get(MC_ENTITLEMENTS_URL)
        .bearer_auth(&mc_token)
        .send()
        .await
    {
        if ent.status().is_success() {
            let ent_json: serde_json::Value = ent.json().await.unwrap_or_default();
            let items = ent_json["items"].as_array().cloned().unwrap_or_default();
            let owns = items.iter().any(|i| {
                i["name"]
                    .as_str()
                    .map(|n| {
                        n.contains("minecraft")
                            || n.contains("product_minecraft")
                            || n.contains("game_minecraft")
                    })
                    .unwrap_or(false)
            });
            if !owns {
                return Err(AuthError::NoEntitlement);
            }
        }
    }

    /* ---------- 玩家档案 ---------- */
    let profile_resp = client
        .get(MC_PROFILE_URL)
        .bearer_auth(&mc_token)
        .send()
        .await?;
    let profile_status = profile_resp.status();
    if !profile_status.is_success() {
        /*
         * ★ 404 与别的失败要分开（PCL `ModLaunch.vb` 1086-1099）：
         *   404 = **这个账号还没有创建 Minecraft 玩家档案** ——
         *   用户自己去 minecraft.net 建一个就好了，不是"没买游戏"。
         *   老代码把它和"没买"合并成 `NoEntitlement`，
         *   于是用户会去买一份已经买过的游戏。
         */
        if profile_status.as_u16() == 404 {
            return Err(AuthError::Ms(
                "这个微软账号还没有创建 Minecraft 玩家档案。\n\n\
                 请打开 minecraft.net 登录一次并设置你的玩家名，\
                 然后回 IEML 重新点「正版登录」即可。\n\
                 （直达：https://www.minecraft.net/zh-hans/msaprofile/mygames/editprofile）"
                    .into(),
            ));
        }
        if profile_status.as_u16() == 429 {
            return Err(AuthError::Ms(
                "登录尝试太过频繁，已被微软限流。\n\
                 请等待几分钟后再试；等待期间请不要反复点击登录。"
                    .into(),
            ));
        }
        return Err(AuthError::NoEntitlement);
    }
    let profile: serde_json::Value = profile_resp.json().await.unwrap_or_default();
    let username = profile["name"]
        .as_str()
        .ok_or_else(|| AuthError::Ms("没有取到玩家名".into()))?
        .to_string();
    let uuid = profile["id"]
        .as_str()
        .ok_or_else(|| AuthError::Ms("没有取到玩家 UUID".into()))?
        .to_string();

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    /*
     * ★★ XUID 以 **MC 令牌载荷**里那个为准（XSTS 那边留作兜底）——
     *   见上面 `xsts_xuid` 前那段说明：真机上只有令牌里那个是有的。
     */
    let xuid = {
        let from_token = xuid_from_mc_token(&mc_token);
        if from_token.is_empty() {
            xsts_xuid
        } else {
            from_token
        }
    };

    let account = McAccount {
        username,
        uuid,
        access_token: mc_token,
        refresh_token,
        kind: "msa".into(),
        expires_at: Some(now + mc_expires_in.min(expires_in.max(mc_expires_in))),
        // ★ Xbox 用户 ID（现代版本的 --xuid 要用它；取法见上面那段）
        xuid,
    };

    // 立刻存进系统密钥环
    store_account(&account)?;
    Ok(account)
}

/// 续期失败之后的**冷却时间**：这期间不再重试续期。
///
/// 为什么要冷却（2026-10-12 用户：「令牌过期，感觉这是个bug」）：
///   续期失败最常见的原因是 refresh token 真的废了（换了密码、注销了设备）。
///   那种情况下**每次调用都去试一次续期**会：① 让用户白等 ② 把微软的
///   令牌端点打成限流（好友页的心跳 30 秒一次，一分钟就两次）。
///   冷却期内直接用旧的（反正也不可用），过了冷却才再试一次 ——
///   用户在这期间去设置里重新登录，一切照旧。
const REFRESH_RETRY_AFTER: std::time::Duration = std::time::Duration::from_secs(300);

/// 上次续期**失败**的时刻（按 uuid）。见 `REFRESH_RETRY_AFTER` 的说明。
static REFRESH_FAILED_AT: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, std::time::Instant>>> =
    std::sync::OnceLock::new();

fn refresh_failed_map() -> &'static std::sync::Mutex<std::collections::HashMap<String, std::time::Instant>> {
    REFRESH_FAILED_AT.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// 现在该不该去试续期（纯函数 —— 有判据）
fn should_try_refresh(
    last_failure: Option<std::time::Instant>,
    now: std::time::Instant,
) -> bool {
    match last_failure {
        None => true,
        Some(t) => now.duration_since(t) >= REFRESH_RETRY_AFTER,
    }
}

fn note_refresh_failed(uuid: &str) {
    if let Ok(mut m) = refresh_failed_map().lock() {
        m.insert(uuid.to_string(), std::time::Instant::now());
    }
}

fn clear_refresh_failure(uuid: &str) {
    if let Ok(mut m) = refresh_failed_map().lock() {
        m.remove(uuid);
    }
}

/// 走一次续期，并把**新账号写回密钥环**（`refresh_msa` 内部已经会存）。
async fn try_refresh(uuid: &str, refresh_token: &str) -> Result<McAccount> {
    match refresh_msa(refresh_token).await {
        Ok(acc) => {
            clear_refresh_failure(uuid);
            say!("[IEML/auth] 令牌已静默续期（{}）", acc.username);
            Ok(acc)
        }
        Err(e) => {
            note_refresh_failed(uuid);
            Err(e)
        }
    }
}

/// ★★★★ 取一把**现在能用**的正版令牌：快过期就自己续期。
///
/// ## 为什么必须有这个函数（2026-10-12，用户报的 bug）
///
///   好友服务原来直接 `load_account(uuid)` 拿 `access_token` 就用 ——
///   **完全不看它有没有过期**。令牌一过期，好友服务就 401，然后界面弹
///   「好友服务不认这把令牌 —— 到设置里重新登录一次正版账号」。
///
///   可我们**手里就有 refresh token**，续一次就好的事。
///   而启动游戏那条路（`commands_real` 的启动命令）早就是 "`needs_refresh()`
///   → `refresh_msa`" —— **同一条链上两套做法**，这就是这个 bug 的根：
///   凡是"拿令牌去调接口"的地方，都应该走这一个入口。
///
/// ★ 判定用 `needs_refresh()`：**没有到期时间也当作要续期**（老账号没有那个字段，
///   见它的说明）。续一次很便宜，拿一把不知道死活的令牌去调接口很贵。
pub async fn valid_access_token(uuid: &str) -> Result<String> {
    let acc = load_account(uuid)?;
    if acc.access_token.is_empty() || acc.access_token == "0" {
        return Err(AuthError::Other(
            "离线账号用不了这个功能 —— 它要正版令牌。\n\
             到「设置 → 账号」登录一次正版账号即可。"
                .into(),
        ));
    }
    if acc.kind != "msa" || !acc.needs_refresh() {
        return Ok(acc.access_token);
    }
    let Some(rt) = acc.refresh_token.clone().filter(|s| !s.trim().is_empty()) else {
        // 没有 refresh token ⇒ 只能拿旧的去试（多半会 401，由调用方如实报出来）
        return Ok(acc.access_token);
    };
    let last = refresh_failed_map().lock().ok().and_then(|m| m.get(uuid).copied());
    if !should_try_refresh(last, std::time::Instant::now()) {
        return Ok(acc.access_token);
    }
    Ok(try_refresh(uuid, &rt).await?.access_token)
}

/// **强制**续期一次（服务端已经明确回 401 时用 —— 那比"看时钟判断"更权威）。
///
/// 返回新的 access token；续期本身失败就把那个错误抛出去（**带上微软的原因**，
/// 那才是用户该看的话）。冷却期内直接返回原错误，不去打令牌端点。
pub async fn force_refresh_access_token(uuid: &str) -> Result<String> {
    let acc = load_account(uuid)?;
    let Some(rt) = acc.refresh_token.clone().filter(|s| !s.trim().is_empty()) else {
        return Err(AuthError::Other(
            "这把令牌服务端不认，而且账号里**没有** refresh token —— 只能重新登录一次。\n\
             到「设置 → 账号」点正版登录即可。"
                .into(),
        ));
    };
    let last = refresh_failed_map().lock().ok().and_then(|m| m.get(uuid).copied());
    if !should_try_refresh(last, std::time::Instant::now()) {
        return Err(AuthError::Other(
            "刚才续期失败了，这五分钟内不再重试（免得把微软的接口打成限流）。\n\
             到「设置 → 账号」重新登录一次是最快的办法。"
                .into(),
        ));
    }
    Ok(try_refresh(uuid, &rt).await?.access_token)
}

/// 用 refresh_token 静默续期（避免每次启动都要重新授权）
///
/// ★★ 端点必须是 `login.live.com/oauth20_token.srf`，**不是** `consumers` 那个。
///
///   老代码用 `login.microsoftonline.com/consumers/oauth2/v2.0/token` 刷新，
///   而 PCL 用的是 `login.live.com/oauth20_token.srf`（`ModLaunch.vb` 第 929 行）。
///   实测发现两者不通用：`consumers` 端点对 `grant_type=refresh_token` 返回
///   `invalid_request` —— 于是"静默续期"从来没成功过，用户每次启动都要重登一次。
pub async fn refresh_msa(refresh_token: &str) -> Result<McAccount> {
    let Some(cid) = client_id() else {
        return Err(AuthError::Other(missing_client_id_message()));
    };
    let client = crate::net::client();
    let resp = client
        .post(REFRESH_URL)
        .header("Accept-Language", "en-US,en;q=0.5")
        .header("X-Requested-With", "XMLHttpRequest")
        .form(&[
            ("client_id", cid.as_str()),
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("scope", SCOPE),
        ])
        .send()
        .await?;

    if !resp.status().is_success() {
        let code = resp.status().as_u16();
        let t = resp.text().await.unwrap_or_default();
        // ★ 429：刷新令牌也被限流 —— 明确说清，不丢给 explain_ms_error 猜
        //   （它面对 429 的响应体翻不出「限流」这个意思）。
        if code == 429 {
            return Err(AuthError::Ms(
                "刷新令牌太频繁，已被微软限流。请等待几分钟后再试。".into(),
            ));
        }
        return Err(AuthError::Ms(explain_ms_error(&t)));
    }
    #[derive(Deserialize)]
    struct Tok {
        access_token: String,
        #[serde(default)]
        refresh_token: String,
        #[serde(default)]
        expires_in: u64,
    }
    let tok: Tok = resp.json().await?;
    let rt = if tok.refresh_token.is_empty() {
        refresh_token.to_string()
    } else {
        tok.refresh_token
    };
    complete_login(&tok.access_token, Some(rt), tok.expires_in).await
}

/* ====================== 密钥环存储 ====================== */

/// 凭据管理器对**单条**凭据的硬上限（UTF-16 码元数）。
///
/// ★★ 这个数字必须记清楚 —— **报错信息会骗人**：
///   Windows 的 `CRED_MAX_CREDENTIAL_BLOB_SIZE` 是 **2560 字节**，
///   而 `keyring` 把密码按 UTF-16 存（`windows.rs`：
///   `password.encode_utf16().count() * 2 > 2560` 就报错）。
///   所以**真正的上限是 1280 个 UTF-16 码元**。
///
///   它抛出的错误信息写的是
///   「longer than platform limit of **2560 chars**」—— 2560 是**字节**，
///   不是字符。照着这句话把分片定成 2560 会继续失败。
///
/// 触发场景（用户报的「正版登录报错 / 密码环操作失败」）：
///   整个 `McAccount` 序列化成 JSON 后，光 `access_token`（JWT）就有 ~1600 字符，
///   再加微软的 refresh token，稳稳超过 1280 —— 一存就炸。
const KEYRING_MAX_CHARS: usize = 1280;

/// 单个分片的大小。留 80 字符余量，吸收任何计数口径差异。
const CHUNK_CHARS: usize = 1200;

/// 分片数上限。1200 × 64 = 76800 字符 —— 远超任何真实令牌，
/// 纯粹是防止读到脏数据时无限循环。
const MAX_CHUNKS: usize = 64;

/// 凭据的"用户名"：第 0 片用**裸 uuid**，第 i 片用 `uuid#i`。
///
/// 第 0 片刻意不加后缀：这样**旧格式（单条存整串）天然还能读**，
/// 不需要任何迁移步骤。
fn chunk_user(uuid: &str, i: usize) -> String {
    if i == 0 {
        uuid.to_string()
    } else {
        format!("{uuid}#{i}")
    }
}

fn entry_for(user: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, user).map_err(|e| AuthError::Keyring(e.to_string()))
}

/// 按 **UTF-16 码元**切分。空串返回一个空分片（不是 0 个 —— 那样会存出"没有凭据"）。
///
/// 为什么不能按字节或 `chars()` 切：
///   * 按字节切会把 UTF-8 多字节字符劈成两半，拼回来是乱码；
///   * 按 `chars()` 切会让 BMP 之外的字符（emoji）少算一半 ——
///     它们在 UTF-16 里占 **2** 个码元，而限制正是按 UTF-16 算的。
fn split_chunks(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut cur_len = 0usize;
    for ch in s.chars() {
        let w = ch.len_utf16();
        if cur_len + w > CHUNK_CHARS && !cur.is_empty() {
            out.push(std::mem::take(&mut cur));
            cur_len = 0;
        }
        cur.push(ch);
        cur_len += w;
    }
    // 空串也要留一个分片：否则"存了空账号"会变成"什么都没存"
    if !cur.is_empty() || out.is_empty() {
        out.push(cur);
    }
    out
}

/// 读出并拼回某个账号的全部内容。
///
/// `Ok(None)` = 这个账号根本没存过。
/// 从第 0 片一直读到"取不到"为止 —— 旧格式（单条整串）天然兼容。
fn read_chunks(uuid: &str) -> Result<Option<String>> {
    let mut out = String::new();
    for i in 0..MAX_CHUNKS {
        match entry_for(&chunk_user(uuid, i))?.get_password() {
            Ok(part) => out.push_str(&part),
            Err(keyring::Error::NoEntry) => {
                if i == 0 {
                    return Ok(None); // 从来没存过
                }
                break; // 分片到此为止
            }
            Err(e) => return Err(AuthError::Keyring(e.to_string())),
        }
    }
    Ok(Some(out))
}

/// 删掉某个账号的全部分片（删到一个不存在为止）。
fn clear_chunks(uuid: &str) {
    for i in 0..MAX_CHUNKS {
        let Ok(e) = entry_for(&chunk_user(uuid, i)) else {
            break;
        };
        // 删不到就是"没有下一片了"，正常结束
        if e.delete_credential().is_err() {
            break;
        }
    }
}

/// 把账号存进系统密钥环。**绝不写明文配置文件。**
///
/// ★ 大令牌要**分片**（见 `KEYRING_MAX_CHARS`）：单条凭据最多 1280 字符，
///   而正版账号的 JSON 通常 2000~3000 字符，一条根本存不下。
pub fn store_account(account: &McAccount) -> Result<()> {
    let json = serde_json::to_string(account)
        .map_err(|e| AuthError::Other(format!("序列化账号失败：{e}")))?;
    let chunks = split_chunks(&json);

    // ★★ 必须先清掉**旧分片**再写新的，顺序不能反。
    //
    //   不清的后果（这是分片方案最容易踩的坑）：上次存了 4 片、这次只要 3 片，
    //   残留的第 4 片会在读的时候被拼到末尾 —— JSON 尾部多一段旧令牌，
    //   反序列化直接报「账号数据损坏」。而**令牌长度本来就是会变的**
    //   （刷新之后微软给的新 refresh token 长短不一定），所以这不是理论风险。
    //
    //   代价：万一写到一半失败，这个账号就没了（需要重新登录）。
    //   两害相权取轻 —— 留一段会**稳定损坏**的旧尾巴比要求重新登录更糟。
    clear_chunks(&account.uuid);

    for (i, part) in chunks.iter().enumerate() {
        // ★ 防御性检查：分片逻辑万一被改坏（比如有人把 CHUNK_CHARS 调大），
        //   这里要立刻给出**看得懂**的错误，而不是把 keyring 那句
        //   「longer than platform limit of 2560 chars」（还把字节写成了字符）
        //   原样丢给用户 —— 用户报的就是那句话，没人能从中知道该做什么。
        let units = part.encode_utf16().count();
        if units > KEYRING_MAX_CHARS {
            return Err(AuthError::Other(format!(
                "内部错误：账号数据分片 {i} 有 {units} 个 UTF-16 码元，超过密钥环上限 \
                 {KEYRING_MAX_CHARS}。这是分片逻辑的缺陷，请反馈这个问题。"
            )));
        }
        entry_for(&chunk_user(&account.uuid, i))?
            .set_password(part)
            .map_err(|e| AuthError::Keyring(e.to_string()))?;
    }

    // 记一个"当前账号"指针（只存 uuid，不敏感）
    entry_for("__current__")?
        .set_password(&account.uuid)
        .map_err(|e| AuthError::Keyring(e.to_string()))?;
    Ok(())
}

pub fn load_account(uuid: &str) -> Result<McAccount> {
    let json = read_chunks(uuid)?
        .ok_or_else(|| AuthError::Keyring(format!("找不到账号 {uuid} 的凭据（可能已被移除）")))?;
    serde_json::from_str(&json).map_err(|e| AuthError::Other(format!("账号数据损坏：{e}")))
}

pub fn current_account_uuid() -> Option<String> {
    entry_for("__current__").ok()?.get_password().ok()
}

pub fn remove_account(uuid: &str) -> Result<()> {
    // ★ 必须删**全部分片**，不能只删第 0 片 —— 否则 `uuid#1` 会永远留在
    //   用户的凭据管理器里，既清不掉也看不见。
    clear_chunks(uuid);
    if current_account_uuid().as_deref() == Some(uuid) {
        if let Ok(idx) = entry_for("__current__") {
            let _ = idx.delete_credential();
        }
    }
    Ok(())
}

/// 离线账号不进密钥环（没有秘密可存）
pub fn offline_account(username: &str) -> McAccount {
    let uuid = crate::game::launch_args::offline_uuid(username);
    McAccount {
        username: username.to_string(),
        uuid,
        access_token: "0".into(),
        refresh_token: None,
        kind: "legacy".into(),
        expires_at: None,
        // 离线身份没有 Xbox 用户 ID（这是"离线"的一部分，不是漏填）
        xuid: String::new(),
    }
}

/* ====================== 皮肤（照 PCL 的做法：走 Mojang 官方） ====================== */

/// 正版账号的皮肤信息，**全部来自 Mojang 官方**，不经过任何第三方头像站。
///
/// ★ `rename_all = "camelCase"`：这个结构是**直接透传给前端**的，
///   按 ADR-036「透传的必须 camelCase」—— 前端 `AccountSkin` 读的是
///   `skinUrl` / `capeUrl`，写成 snake_case 会让那两个值静默变成 `undefined`
///   （这类跨 IPC 字段名不一致的 bug 编译器抓不到）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkinInfo {
    /// Mojang 侧的玩家名（比本地记的 `offlineUsername` 权威）
    pub name: String,
    /// 皮肤原图 URL（64×64 PNG）。没设皮肤时为 `None`
    pub skin_url: Option<String>,
    /// 披风图 URL。没有披风时为 `None`
    pub cape_url: Option<String>,
}

/// 查一个正版账号的皮肤。
///
/// ## 为什么不用第三方头像站（用户问「PCL 的头像服务也是境外的？」）
///
/// **PCL 根本不用第三方头像站** —— 它走 Mojang 官方：拿到 64×64 的皮肤原图，
/// **在本地裁头部**画出来。所以它不依赖任何第三方服务。
///
/// 2026-09-17 在本机把两条路都实测了：
///
/// | 端点 | 结果 |
/// |---|---|
/// | `mc-heads.net/avatar/<uuid>/64` | **403 + 1084 B HTML**（`<img>` 只会静默失败） |
/// | `minotar.net/avatar/<uuid>/64` | 200 + 458 B（能用，但仍是第三方） |
/// | **`sessionserver.mojang.com/.../profile/<uuid>`** | **200 / 727 B / 0.9 s** |
/// | **`textures.minecraft.net/texture/<hash>`** | **200 / 3054 B / 真 PNG 64×64** |
///
/// → **官方那条链在用户的网络环境里反而是通的**，而且顺带带回玩家名与披风。
///
/// ## 皮肤图的坐标（前端裁头用）
///
/// 64×64 皮肤里：**头部在 (8,8) 的 8×8**，**帽子层（第二层）在 (40,8) 的 8×8**。
/// 裁剪在前端用 CSS `background-position` 做 —— 后端只负责把 URL 拿到，
/// 不引入任何图像处理依赖。
///
/// ★ **接口有速率限制**（Mojang 建议同一 profile 每分钟不超过一次），
///   所以调用方要缓存；改完皮肤不会立刻生效，这是 Mojang 的行为不是我们的 bug。
pub async fn fetch_skin(uuid: &str) -> Result<SkinInfo> {
    #[derive(Deserialize)]
    struct Profile {
        name: String,
        #[serde(default)]
        properties: Vec<Property>,
    }
    #[derive(Deserialize)]
    struct Property {
        name: String,
        value: String,
    }

    let url = format!("https://sessionserver.mojang.com/session/minecraft/profile/{uuid}");
    let resp = crate::net::client().get(&url).send().await?;

    // ★ sessionserver 对**不存在的 profile** 回的是 **204 No Content**，不是 404 ——
    //   直接 `.json()` 会得到一个"EOF while parsing a value"那种看不懂的错，
    //   用户完全不知道自己做错了什么。这里翻译成一句能行动的说明。
    if resp.status() == reqwest::StatusCode::NO_CONTENT {
        return Err(AuthError::Other(format!(
            "Mojang 查不到这个账号（{uuid}）—— 可能它不是正版账号，或 UUID 不对"
        )));
    }
    if !resp.status().is_success() {
        let code = resp.status();
        let body = resp.text().await.unwrap_or_default();
        let brief: String = body.chars().take(200).collect();
        return Err(AuthError::Other(format!("查皮肤失败（HTTP {code}）：{brief}")));
    }
    let profile: Profile = resp.json().await?;

    // textures 属性是一段 base64 包着的 JSON —— 这是 Mojang 的格式，不是我们选的
    let mut skin_url = None;
    let mut cape_url = None;
    if let Some(prop) = profile.properties.iter().find(|p| p.name == "textures") {
        use base64::Engine as _;
        if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(&prop.value) {
            if let Ok(text) = String::from_utf8(bytes) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                    skin_url = v["textures"]["SKIN"]["url"].as_str().map(force_https);
                    cape_url = v["textures"]["CAPE"]["url"].as_str().map(force_https);
                }
            }
        }
    }

    Ok(SkinInfo {
        name: profile.name,
        skin_url,
        cape_url,
    })
}

/// Mojang 给的皮肤/披风地址是 **`http://`**，而界面的 CSP 里
/// `img-src` **只允许 `https:`** —— 原样塞进去会被 CSP 拦掉，
/// 表现是"图片地址对了但什么都不显示"（又是静默失败）。
///
/// 实测 `https://textures.minecraft.net/...` 与 http 返回**同一张图、同样 3054 字节**，
/// 所以直接改写协议，比放宽 CSP 更对（没有理由为了迁就对方的 http 而降低自己的策略）。
fn force_https(url: &str) -> String {
    url.replacen("http://", "https://", 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offline_account_has_legacy_type() {
        let a = offline_account("Tester");
        assert_eq!(a.kind, "legacy");
        assert_eq!(a.access_token, "0");
        assert_eq!(a.username, "Tester");
        assert_eq!(a.uuid.len(), 32);
    }

    #[test]
    fn to_launch_account_maps_user_type() {
        let a = offline_account("Tester");
        let l = a.to_launch_account();
        assert_eq!(l.user_type, "legacy");
        assert_eq!(l.username, "Tester");
    }

    #[test]
    fn expiry_check_works() {
        let mut a = offline_account("T");
        a.expires_at = None;
        assert!(!a.is_expired(), "没有过期时间应当视为不过期");

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        a.expires_at = Some(now + 3600);
        assert!(!a.is_expired());
        a.expires_at = Some(now + 60); // 60 秒后过期，提前 5 分钟算过期
        assert!(a.is_expired());
        a.expires_at = Some(now - 10);
        assert!(a.is_expired());
    }

    /// ★★★★ 2026-10-11（用户：「游戏里弹『提供的令牌无效』」那条 bug 的判据）。
    ///
    ///   `expires_at` 是后来才加进 `McAccount` 的（`#[serde(default)]`）——
    ///   **老账号里根本没有这个字段**，反序列化出来是 `None`，
    ///   而 `is_expired()` 对 `None` 返回 false ⇒ **永远不续期** ⇒
    ///   令牌静默过期、游戏里所有在线服务 401。
    ///
    ///   ⇒ "不知道什么时候过期"必须当成**要续期**（续一次很便宜，
    ///     拿着不知道死活的令牌去启动游戏的代价是玩家连不上任何在线服务）。
    #[test]
    fn unknown_expiry_means_refresh() {
        let mut a = offline_account("T");

        a.expires_at = None;
        assert!(a.needs_refresh(), "没有过期时间 ⇒ 必须续期（老账号就是这个形状）");

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        a.expires_at = Some(now - 10);
        assert!(a.needs_refresh(), "已过期 ⇒ 续期");
        a.expires_at = Some(now + 60);
        assert!(a.needs_refresh(), "5 分钟内到期 ⇒ 也提前续（与 is_expired 口径一致）");
        a.expires_at = Some(now + 3600);
        assert!(!a.needs_refresh(), "还早 ⇒ 不折腾");
    }

    /// ★★★★ 2026-10-12（用户：「令牌过期，感觉这是个bug」）：
    ///   续期**失败**之后要有一段冷却期，否则好友页那 30 秒一次的心跳
    ///   会把微软的令牌端点打成限流（refresh token 真废了的时候每次都白试）。
    #[test]
    fn refresh_failure_has_a_cooldown() {
        let now = std::time::Instant::now();
        assert!(should_try_refresh(None, now), "没失败过 ⇒ 该试");
        assert!(!should_try_refresh(Some(now), now), "刚失败过 ⇒ 先别试");
        assert!(
            !should_try_refresh(Some(now - REFRESH_RETRY_AFTER / 2), now),
            "冷却期内 ⇒ 别试"
        );
        assert!(
            should_try_refresh(Some(now - REFRESH_RETRY_AFTER), now),
            "过了冷却 ⇒ 再试一次"
        );
    }

    /// ★★ 2026-10-11：**记录不完整也要续一次**（缺 xuid 的正版账号）。
    ///
    ///   现场：`xuid` 是 10-11 才加进 `McAccount` 的，而它是现代版本 `--xuid`
    ///   的唯一来源。老账号的令牌可能还剩十几个小时 —— 只看过期时间的话，
    ///   要等到明天才会续期，而这一天里联机与好友功能全是坏的。
    #[test]
    fn missing_xuid_also_needs_refresh() {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let mut a = offline_account("T");
        a.kind = "msa".into();
        a.xuid = String::new();
        a.expires_at = Some(now + 24 * 3600); // 令牌还很新
        assert!(a.needs_refresh(), "正版账号缺 xuid ⇒ 续一次把它补上（顺带刷令牌）");

        a.xuid = "2535470293336241".into();
        assert!(!a.needs_refresh(), "xuid 有了、令牌还新 ⇒ 不折腾");

        // ★ 离线账号不该因为"没有 xuid"被反复续期（它本来就没有在线身份）
        let mut off = offline_account("T");
        off.expires_at = Some(now + 3600);
        assert_eq!(off.kind, "legacy");
        assert!(!off.needs_refresh(), "离线身份的 xuid 空是正常的");
    }

    /// ★★ 2026-10-11：**XUID 从 MC 令牌的载荷里读**（真机上唯一可靠的来源）。
    ///
    ///   试过的三个来源：XBL 的 DisplayClaims（只有 `uhs`）、XSTS 的 DisplayClaims
    ///   （文档说带 `xid`，真机取回来是空的）、MC access token 的载荷（**有** ✔）。
    ///   这几个 fixture 就是真机令牌载荷的形状（base64url 编码过）。
    #[test]
    fn xuid_comes_from_the_mc_token_payload() {
        // {"xuid":"2535470293336241","foo":1}
        let t1 = "h.eyJ4dWlkIjoiMjUzNTQ3MDI5MzMzNjI0MSIsImZvbyI6MX0.s";
        assert_eq!(xuid_from_mc_token(t1), "2535470293336241");

        // {"xuid":2535470293336241} —— 数字形态也要认
        let t2 = "h.eyJ4dWlkIjoyNTM1NDcwMjkzMzM2MjQxfQ.s";
        assert_eq!(xuid_from_mc_token(t2), "2535470293336241");

        // {"sub":"x"} —— 没有就不许编一个出来
        let t3 = "h.eyJzdWIiOiJ4In0.s";
        assert_eq!(xuid_from_mc_token(t3), "");
        assert_eq!(xuid_from_mc_token(""), "");
        assert_eq!(xuid_from_mc_token("not-a-jwt"), "");
        assert_eq!(xuid_from_mc_token("h.????.s"), "", "解不出来的载荷 ⇒ 空串，不许崩");
    }

    /// 报错里带的响应体必须被截短、压成一行 —— 否则界面与日志会被一坨 JSON 撑爆。
    #[test]
    fn error_snippets_are_shortened() {        assert_eq!(truncate_for_message("短"), "短");
        let multi = "{\n  \"XErr\": 2148916233,\n  \"Message\": \"x\"\n}";
        let one = truncate_for_message(multi);
        assert!(!one.contains('\n'), "必须压成一行：{one}");
        let long = "a".repeat(1000);
        let cut = truncate_for_message(&long);
        assert!(cut.chars().count() <= 301, "太长没截：{}", cut.chars().count());
        assert!(cut.ends_with('…'));
    }

    /* ---------- client_id 的占位符判据（0.1.0-beta.3） ---------- */

    /// 本机实测踩到的那个值必须被认出来 —— 它会把可用的内置 id 挤掉。
    #[test]
    fn the_real_world_placeholder_is_detected() {
        assert!(looks_like_placeholder("11111111-2222-3333-4444-555555555555"));
        assert!(looks_like_placeholder("00000000-0000-0000-0000-000000000000"));
        assert!(looks_like_placeholder("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"));
        assert!(looks_like_placeholder("12345678-1234-1234-1234-123456789012"));
    }

    /// 真的 id 一个都不许误伤 —— 误伤的后果是"用户填了真的却被告知是假的"。
    #[test]
    fn real_looking_ids_are_not_flagged() {
        // Prism Launcher 的公开 id（对照用的那个；★ 2026-09-25 更正：这不是"内置的那把"——
        //   内置的是 `BUILTIN_CLIENT_ID`，即用户自己 Azure 注册的那把）
        assert!(!looks_like_placeholder("c36a9fb6-4f2a-41ff-90bd-ae7cc92031eb"));
        // 官方启动器历史上用过的那把（今天已不存在，但**形状**是真的）
        assert!(!looks_like_placeholder("00000000402b5328"));
        assert!(!looks_like_placeholder("6b2f7b41-5b3a-4a3f-9a1e-0f2b6d3c8e11"));
    }

    /// 空串不是"占位符"，是"没填" —— 两条路必须分开（调用方各自处理）。
    #[test]
    fn empty_is_not_a_placeholder() {
        assert!(!looks_like_placeholder(""));
        assert!(!looks_like_placeholder("   "));
    }

    /* ====================== 密钥环分片（用户报的登录失败） ====================== */

    /// ★★ 核心不变量：**任何分片都不能超过凭据管理器的上限**。
    ///
    ///   用户报的「密钥环操作失败：Attribute 'password encoded as UTF-16'
    ///   is longer than platform limit of 2560 chars」就是这条被违反。
    ///   注意断言用的是**UTF-16 码元 × 2 ≤ 2560**（keyring 的真实判据），
    ///   而不是报错信息里那句"2560 chars"。
    fn assert_chunks_fit(parts: &[String]) {
        for (i, p) in parts.iter().enumerate() {
            let units = p.encode_utf16().count();
            assert!(
                units * 2 <= 2560,
                "第 {i} 片有 {units} 个 UTF-16 码元（{} 字节），超过 2560 字节上限",
                units * 2
            );
        }
    }

    /// 真实尺寸的账号 JSON 必须能存下 —— 这就是用户遇到的那个场景。
    ///
    /// 尺寸取自实测：Minecraft 的 access_token 是 ~1600 字符的 JWT，
    /// 微软 refresh token 另有 ~1000 字符。单条存必然超过 1280。
    #[test]
    fn real_sized_account_is_chunked_within_limit() {
        let account = McAccount {
            username: "Player".into(),
            uuid: "0123456789abcdef0123456789abcdef".into(),
            // 1600 字符的假 JWT
            access_token: "a".repeat(1600),
            xuid: String::new(),
            refresh_token: Some("r".repeat(1000)),
            kind: "msa".into(),
            expires_at: Some(1758000000000),
        };
        let json = serde_json::to_string(&account).unwrap();
        assert!(
            json.encode_utf16().count() * 2 > 2560,
            "这个账号本来就该超过单条上限，否则测不到分片（实际 {} 字符）",
            json.encode_utf16().count()
        );

        let parts = split_chunks(&json);
        assert!(parts.len() >= 2, "应当被切成多片，实际 {} 片", parts.len());
        assert_chunks_fit(&parts);
        assert_eq!(parts.concat(), json, "拼回来必须逐字符一致");
    }

    /// 拼回来必须与原文**逐字符一致**（分片方案的正确性底线）。
    #[test]
    fn chunks_round_trip() {
        for len in [0usize, 1, 10, 1199, 1200, 1201, 2400, 2401, 5000, 30000] {
            let s = "x".repeat(len);
            let parts = split_chunks(&s);
            assert_chunks_fit(&parts);
            assert_eq!(parts.concat(), s, "长度 {len} 的串拼回来不一致");
        }
    }

    /// ★ 必须按 **UTF-16 码元**切，不能按 `chars()` ——
    ///   emoji 在 UTF-16 里占 2 个码元，按 `chars()` 计会少算一半，
    ///   于是一个"1200 字符"的分片实际是 2400 字节，照样超限。
    #[test]
    fn chunks_count_utf16_units_not_chars() {
        // 每个 emoji 占 2 个 UTF-16 码元
        let s = "😀".repeat(2000); // 2000 个 char，4000 个 UTF-16 码元
        assert_eq!(s.chars().count(), 2000);
        assert_eq!(s.encode_utf16().count(), 4000);

        let parts = split_chunks(&s);
        assert_chunks_fit(&parts);
        assert_eq!(parts.concat(), s);
        // 每片最多 1200 码元 → 至少 4 片（按 chars() 切只会给 2 片，那是错的）
        assert!(
            parts.len() >= 4,
            "按 UTF-16 码元应有 ≥4 片，实际 {} 片 —— 说明切分没按码元算",
            parts.len()
        );
    }

    /// 空串要产出**一个**分片，不能是 0 个。
    /// 0 个分片意味着什么都没写进密钥环，读的时候会变成"账号不存在"。
    #[test]
    fn empty_string_still_produces_one_chunk() {
        let parts = split_chunks("");
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0], "");
        assert_eq!(parts.concat(), "");
    }

    /// 小账号（离线账号没有 refresh_token）应当只有一片 ——
    /// 这保证了**大多数情况行为与分片之前完全一样**。
    #[test]
    fn small_account_is_a_single_chunk() {
        let account = McAccount {
            username: "Steve".into(),
            uuid: "0123456789abcdef0123456789abcdef".into(),
            access_token: "0".into(),
            xuid: String::new(),
            refresh_token: None,
            kind: "legacy".into(),
            expires_at: None,
        };
        let json = serde_json::to_string(&account).unwrap();
        assert!(json.encode_utf16().count() <= CHUNK_CHARS);
        assert_eq!(split_chunks(&json).len(), 1, "小账号不该被分片");
    }

    /// 分片命名：第 0 片必须是**裸 uuid**，否则旧格式（单条存整串）读不出来。
    #[test]
    fn first_chunk_keeps_the_bare_uuid_for_backward_compat() {
        assert_eq!(chunk_user("abc123", 0), "abc123");
        assert_eq!(chunk_user("abc123", 1), "abc123#1");
        assert_eq!(chunk_user("abc123", 7), "abc123#7");
        // 不能和 uuid 本身撞（uuid 是 32 位 hex，不含 #）
        assert_ne!(chunk_user("abc123", 0), chunk_user("abc123", 1));
    }

    /// 上限常量本身要对得上 keyring 的真实判据。
    /// 这条是防止有人照着报错信息里的 "2560 chars" 把 `CHUNK_CHARS` 改成 2560。
    #[test]
    fn chunk_size_stays_under_the_real_platform_limit() {
        assert_eq!(KEYRING_MAX_CHARS, 1280, "keyring 的真实上限是 1280 个 UTF-16 码元");
        assert!(
            CHUNK_CHARS < KEYRING_MAX_CHARS,
            "分片必须严格小于上限，否则最后一片会踩线"
        );
        // 留的余量要够，不能贴着 1280 写
        assert!(
            KEYRING_MAX_CHARS - CHUNK_CHARS >= 16,
            "余量太小，计数口径稍有出入就会失败"
        );
    }
}

/* ====================== 改皮肤 / 改披风（2026-09-22，用户那张账号菜单要的） ======================
 *
 * ## 为什么要"保证可用"的令牌
 *
 *   查皮肤（fetch_skin）走 sessionserver，**不需要登录**；
 *   但**改**皮肤/披风必须带**已登录的 MC access token**。
 *   令牌存在系统凭据管理器里（见上面 keyring 那段），**会过期** ——
 *   所以这里统一先走一遍"过期就静默续期"，与启动游戏时**同一套规则**
 *   （用户要求"正版账号不能自动退登"，靠的就是续期而不是重新登录）。
 *
 * ## 接口（都是官方 api.minecraftservices.com）
 *
 *   · 上传皮肤  POST   /minecraft/profile/skins        （multipart：variant + file）
 *   · 披风列表  GET    /minecraft/profile          ← 注意是 profile，**不是 profile/capes**
 *   · 激活披风  PUT    /minecraft/profile/capes/active （body：{"capeId": "..."}）
 *   · 取消披风  DELETE /minecraft/profile/capes/active
 */

/// 拿一个**保证可用**的正版令牌（过期就静默续期）。
///
/// ★ 与启动游戏那条路用的是同一套判断（`is_expired` + `refresh_msa`），
///   不另写第二套 —— 两套规则迟早会不一致。
pub async fn fresh_account(uuid: &str) -> Result<McAccount> {
    let mut acc = load_account(uuid)?;
    if acc.kind != "msa" {
        return Err(AuthError::Other(
            "这是离线账号，没有可以改皮肤的正版凭据。先登录正版账号。".into(),
        ));
    }
    if acc.is_expired() {
        match acc.refresh_token.clone().filter(|r| !r.trim().is_empty()) {
            Some(rt) => acc = refresh_msa(&rt).await?,
            None => {
                return Err(AuthError::Other(
                    "正版登录已过期，而且没有可用的续期凭据。重新登录一次即可。".into(),
                ))
            }
        }
    }
    Ok(acc)
}

/// 皮肤条目（上传成功后返回当前那张，界面据此刷新预览）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkinEntry {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub variant: String,
}

#[derive(Debug, Deserialize)]
struct SkinsReply {
    #[serde(default)]
    skins: Vec<SkinEntry>,
}

/// 上传一张皮肤。`variant`：`classic`（4px 手臂）或 `slim`（3px 手臂）。
///
/// ★ 尺寸（64×64 / 旧版 64×32）由 Mojang 校验，我们**不自己判** ——
///   自己判就得内置一个 PNG 解码器，而且上游规则改了我们还不知道。
///   上游返回的报错里会写清哪一项不合格，这里原样带给用户。
pub async fn upload_skin(uuid: &str, png: Vec<u8>, variant: &str) -> Result<SkinEntry> {
    let acc = fresh_account(uuid).await?;
    let variant = if variant == "slim" { "slim" } else { "classic" };

    let part = reqwest::multipart::Part::bytes(png)
        .file_name("skin.png")
        .mime_str("image/png")
        .map_err(|e| AuthError::Other(format!("构造上传内容失败：{e}")))?;
    let form = reqwest::multipart::Form::new()
        .text("variant", variant.to_string())
        .part("file", part);

    let resp = crate::net::client()
        .post("https://api.minecraftservices.com/minecraft/profile/skins")
        .bearer_auth(&acc.access_token)
        .multipart(form)
        .send()
        .await?;

    if !resp.status().is_success() {
        let code = resp.status();
        let body = resp.text().await.unwrap_or_default();
        let brief: String = body.chars().take(300).collect();
        /*
         * ★ 401/403 单独翻译：那几乎总是"令牌没权限 / 过期"，而不是"图不对"。
         *   不翻译的话，用户会拿着一个 401 反复换图片。
         */
        if code == reqwest::StatusCode::UNAUTHORIZED || code == reqwest::StatusCode::FORBIDDEN {
            return Err(AuthError::Other(format!(
                "Mojang 拒绝了这个令牌（HTTP {code}）—— 通常是要重新登录一次正版账号。原始回应：{brief}"
            )));
        }
        return Err(AuthError::Other(format!("上传皮肤失败（HTTP {code}）：{brief}")));
    }

    let reply: SkinsReply = resp.json().await.unwrap_or(SkinsReply { skins: Vec::new() });
    Ok(reply
        .skins
        .into_iter()
        .find(|s| s.state == "ACTIVE")
        .unwrap_or(SkinEntry {
            id: String::new(),
            state: "ACTIVE".into(),
            url: String::new(),
            variant: variant.to_string(),
        }))
}

/// 拥有的披风（**只有正版、而且确实拥有披风**的账号才有内容）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapeEntry {
    pub id: String,
    pub name: String,
    /// 官方给的预览图（可能没有）
    pub url: Option<String>,
    /// 现在正穿着它吗
    pub active: bool,
}

pub async fn list_capes(uuid: &str) -> Result<Vec<CapeEntry>> {
    let acc = fresh_account(uuid).await?;

    /*
     * ★★ 2026-09-23 修（用户截图：`取披风列表失败（HTTP 404 Not Found）：
     *   {"path":"/minecraft/profile/capes","error":"NOT_FOUND"}`）——
     *
     *   **那个地址是我编的**：`GET /minecraft/profile/capes` **不存在**。
     *   披风列表要去 `GET /minecraft/profile` 拿 —— 它的响应里同时带
     *   `skins[]` 与 `capes[]`（`state` 是 `ACTIVE` / `INACTIVE`）。
     *
     *   ★ 判据的来源要说清楚：**不带 token 打这两个地址都是 401**（网关先拦鉴权），
     *     所以"401 vs 404"**分辨不了**（我一度这么以为，重跑才发现是错的）。
     *     真正的证据有两条：
     *       ① 用户的应用**带着有效 token** 收到了 404 + body 里写着
     *          `"path":"/minecraft/profile/capes"` —— 路径不存在，确凿；
     *       ② 官方文档在"换披风"那页明说：cape ID 要 "use the new
     *          View your profile information endpoint"（也就是 `/minecraft/profile`）。
     *   ★ `PUT /minecraft/profile/capes/active`（换披风）**是对的** —— 官方文档里就是它，
     *     所以只有"取列表"这一处写错了，别把两个一起改坏。
     */
    #[derive(Deserialize)]
    struct Raw {
        id: String,
        #[serde(default)]
        state: Option<String>,
        #[serde(default)]
        url: Option<String>,
        /// 披风的名字（官方字段叫 `alias`，如 `Minecon2012`）
        #[serde(default)]
        alias: Option<String>,
    }
    #[derive(Deserialize)]
    struct ProfileReply {
        #[serde(default)]
        capes: Vec<Raw>,
    }

    let resp = crate::net::client()
        .get("https://api.minecraftservices.com/minecraft/profile")
        .bearer_auth(&acc.access_token)
        .send()
        .await?;
    if !resp.status().is_success() {
        let code = resp.status();
        let body = resp.text().await.unwrap_or_default();
        let brief: String = body.chars().take(200).collect();
        /*
         * ★ 401/403 单独翻译：那几乎总是"令牌没权限 / 过期"，而不是"披风列表有问题"。
         *   不翻译的话用户会拿着一个 401 反复点刷新。
         */
        if code == reqwest::StatusCode::UNAUTHORIZED || code == reqwest::StatusCode::FORBIDDEN {
            return Err(AuthError::Other(format!(
                "Mojang 拒绝了这个令牌（HTTP {code}）—— 通常是要重新登录一次正版账号。原始回应：{brief}"
            )));
        }
        return Err(AuthError::Other(format!("取披风列表失败（HTTP {code}）：{brief}")));
    }
    let reply: ProfileReply = resp.json().await?;
    Ok(reply
        .capes
        .into_iter()
        .map(|c| CapeEntry {
            // ★ 现在"哪件在穿"由**每件自己的 state** 说了算（不再是单独一个 activeCape 字段）
            active: c.state.as_deref() == Some("ACTIVE"),
            name: c.alias.unwrap_or_else(|| c.id.clone()),
            id: c.id,
            url: c.url,
        })
        .collect())
}

/// 换披风；`cape_id == None` 表示**不显示披风**。
pub async fn set_active_cape(uuid: &str, cape_id: Option<&str>) -> Result<()> {
    let acc = fresh_account(uuid).await?;
    let client = crate::net::client();
    let resp = match cape_id {
        Some(id) => {
            client
                .put("https://api.minecraftservices.com/minecraft/profile/capes/active")
                .bearer_auth(&acc.access_token)
                .json(&serde_json::json!({ "capeId": id }))
                .send()
                .await?
        }
        None => {
            client
                .delete("https://api.minecraftservices.com/minecraft/profile/capes/active")
                .bearer_auth(&acc.access_token)
                .send()
                .await?
        }
    };
    if !resp.status().is_success() {
        let code = resp.status();
        let body = resp.text().await.unwrap_or_default();
        let brief: String = body.chars().take(200).collect();
        return Err(AuthError::Other(format!("换披风失败（HTTP {code}）：{brief}")));
    }
    Ok(())
}

/// 把当前皮肤**存成文件**（用户菜单里的"保存皮肤文件"）。
///
/// ★ 为什么在后端下：皮肤图在 textures.minecraft.net，
///   前端用 img 拉是**跨域读不到字节**的（canvas 会被污染），
///   而在后端就是一次普通的 GET + 写文件。
pub async fn save_skin_png(skin_url: &str, dest: &std::path::Path) -> Result<u64> {
    let resp = crate::net::client().get(skin_url).send().await?;
    if !resp.status().is_success() {
        return Err(AuthError::Other(format!("下载皮肤失败（HTTP {}）", resp.status())));
    }
    let bytes = resp.bytes().await?;
    if bytes.is_empty() {
        return Err(AuthError::Other("下载到的皮肤是空的".into()));
    }
    std::fs::write(dest, &bytes).map_err(|e| AuthError::Other(format!("写文件失败：{e}")))?;
    Ok(bytes.len() as u64)
}
