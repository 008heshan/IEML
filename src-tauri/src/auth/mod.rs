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

/// 内置的 client_id —— **用户提供的应用 ID**（2026-09-15 换上，未实测）。
///
/// ★ 它只决定"用哪个应用身份去问微软要设备码"，与账号、令牌无关；
///   换掉这一个常量就能切成别的应用，不需要动任何别的地方。
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

/// client_id 存在哪 —— 与 `instances.json` / `prefs.json` 同级。
///
/// ★ 为什么要落盘：用户在设置页填一次就该长期有效。
///   不存的话"每次启动都要重填"—— 那比不做还烦人。
///
/// ★ 为什么单开一个文件而不是塞进 prefs.json：
///   `prefs.json` 是**前端**管的（`save_prefs` 会把整个 JSON 覆盖写回），
///   而 client_id 是后端启动时就要用的（早于前端加载偏好）。
///   放一起会出现"前端用旧值覆盖掉刚写的 id"这种竞态。
pub fn client_id_file(paths: &crate::platform::AppPaths) -> std::path::PathBuf {
    paths.root.join("ms_client_id.txt")
}

/// 启动时读一次（lib.rs 里调用）。
pub fn load_client_id_from_disk(paths: &crate::platform::AppPaths) {
    if let Ok(text) = std::fs::read_to_string(client_id_file(paths)) {
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
///   （Prism Launcher 公开 id，能真的发出设备码）。
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
/// ★ 为什么要连来源一起给：用户在授权页看到的名字是"这个 ID 所属应用"的名字
///   （实测：内置的是 Prism Launcher 的公开 id，页面就写「已登录到 Prism Launcher」）。
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
}

impl McAccount {
    pub fn to_launch_account(&self) -> crate::game::launch_args::Account {
        crate::game::launch_args::Account {
            username: self.username.clone(),
            uuid: self.uuid.clone(),
            access_token: self.access_token.clone(),
            user_type: if self.kind == "msa" { "msa" } else { "legacy" }.to_string(),
            user_properties: "{}".to_string(),
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
        // 其余错误全部翻成人话（含 client_id 不对、账号被封、安全拦截等）
        return Err(AuthError::Ms(explain_ms_error(&text)));
    }
}

/// 第三步：微软 access token → Xbox Live → XSTS → Minecraft → 玩家档案
async fn complete_login(
    ms_access_token: &str,
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
    let xbl: serde_json::Value = client
        .post(XBL_URL)
        .json(&xbl_body)
        .send()
        .await?
        .json()
        .await
        .map_err(|e| AuthError::Ms(format!("Xbox Live 认证失败：{e}")))?;

    let xbl_token = xbl["Token"]
        .as_str()
        .ok_or_else(|| AuthError::Ms("Xbox Live 没有返回 Token".into()))?
        .to_string();
    let uhs = xbl["DisplayClaims"]["xui"][0]["uhs"]
        .as_str()
        .ok_or_else(|| AuthError::Ms("Xbox Live 没有返回用户哈希".into()))?
        .to_string();

    /* ---------- XSTS ---------- */
    let xsts_body = serde_json::json!({
        "Properties": { "SandboxId": "RETAIL", "UserTokens": [xbl_token] },
        "RelyingParty": "rp://api.minecraftservices.com/",
        "TokenType": "JWT"
    });
    let xsts_resp = client.post(XSTS_URL).json(&xsts_body).send().await?;
    let xsts_status = xsts_resp.status();
    let xsts_text = xsts_resp.text().await.unwrap_or_default();

    if !xsts_status.is_success() {
        /*
         * XSTS 的错误码有明确含义，翻译成人话（这是最容易卡住的一步）。
         *
         * ★ 这张表是照 PCL 的 `ModLaunch.vb` 991-1016 抄的
         *   （它参考 prismarine-auth 的常量表）。老代码只映射了 3 条，
         *   而且把 2148916227（**账号被封**）漏了 —— 那种情况下用户会
         *   一直重试、一直失败，因为提示里什么也没说。
         */
        let hint = explain_xsts_error(&xsts_text).unwrap_or(
            "XSTS 授权失败 —— 请把下面的原始返回反馈给我们，或者换个网络环境再试",
        );
        return Err(AuthError::XboxRestricted(format!("{hint}（原始返回：{xsts_text}）")));
    }

    let xsts: serde_json::Value = serde_json::from_str(&xsts_text)
        .map_err(|e| AuthError::Ms(format!("解析 XSTS 响应失败：{e}")))?;
    let xsts_token = xsts["Token"]
        .as_str()
        .ok_or_else(|| AuthError::Ms("XSTS 没有返回 Token".into()))?
        .to_string();

    /* ---------- Minecraft 登录 ---------- */
    let mc_body = serde_json::json!({
        "identityToken": format!("XBL3.0 x={uhs};{xsts_token}")
    });
    let mc_resp = client.post(MC_LOGIN_URL).json(&mc_body).send().await?;
    let mc_status = mc_resp.status();
    let mc_text = mc_resp.text().await.unwrap_or_default();
    if !mc_status.is_success() {
        /*
         * ★ 这几个状态码必须分开说 —— 它们对应**完全不同的自救动作**，
         *   合成一句"Minecraft 登录失败"等于什么都没说。
         *   来源：PCL `ModLaunch.vb` 1034-1049。
         */
        let hint = match mc_status.as_u16() {
            429 => "登录尝试太过频繁，请等几分钟再试。",
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
            return Err(AuthError::Ms("登录尝试太过频繁，请等几分钟再试。".into()));
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

    let account = McAccount {
        username,
        uuid,
        access_token: mc_token,
        refresh_token,
        kind: "msa".into(),
        expires_at: Some(now + mc_expires_in.min(expires_in.max(mc_expires_in))),
    };

    // 立刻存进系统密钥环
    store_account(&account)?;
    Ok(account)
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
        let t = resp.text().await.unwrap_or_default();
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
        // 内置的那把（Prism Launcher 公开 id，实测能发设备码）
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
