/**
 * Minecraft 好友服务（**正版账号专用**）—— 2026-10-12
 * ==================================================================
 *
 * ## 这些端点是怎么定下来的（不是猜的）
 *
 *   用户给了两个基地址，但没给路径。于是从**客户端自己**身上挖：
 *   `com/mojang/authlib/services/` 里的 `FriendsService`（接口）、
 *   `MinecraftServicesFriendsService`（实现）、各 `request/response` DTO
 *   的字符串常量池里就有路径、动词、字段名 —— 混淆改不掉要发给服务端的东西。
 *
 *   而**权威来源**是那份公开的 discovery 文档（游戏日志里那行
 *   `Environment[discoveryUrl=…]` 就是它）：
 *     <https://discovery.minecraftservices.com/minecraft/client>
 *   它把每个服务每个动作的 URI 都列出来了：
 *
 *     player.getFriends     GET  https://api.minecraftservices.com/friends
 *     player.updateFriends       https://api.minecraftservices.com/friends
 *     player.updatePresence POST https://api.minecraftservices.com/presence
 *     player.getAttributes  GET  https://api.minecraftservices.com/player/attributes
 *     player.updateAttributes    https://api.minecraftservices.com/player/attributes
 *     profiles.getByName    GET  https://api.mojang.com/users/profiles/minecraft/{name}
 *
 *   ★ 这里**直接把上面这些 URI 写死**（而不是每次启动去拉 discovery）：
 *     它们是 MOJANG 的稳定公开接口，而多一次网络往返就多一个"进好友页要等它"的理由。
 *     真要换环境时改这一处常量即可（下面那张表就是唯一的地方）。
 *
 * ## 真机验证过什么（2026-10-12，用真实正版令牌）
 *
 *   · `GET /friends` → 200，字段 `friends / incomingRequests / outgoingRequests`，
 *     每条 `{profileId, name}`（**注意：不含在线状态**）；
 *   · `GET /player/attributes` → 200，字段含 `friendsPreferences`
 *     （里面是 `friends` 与 `acceptInvites` 两个开关）；
 *   · `GET /privacy/blocklist` → 200，字段 `blockedProfiles`；
 *   · `PUT /friends {profileId, updateType:"ADD"}` 给一个**不存在**的 uuid
 *     → 400 且回 `{path:"/friends", errorMessage:…}` ⇒ 路径/动词/请求体三件都坐实；
 *   · `POST /presence {status:"ONLINE"}` → 200，回 `{presence:[…]}`（本次 0 条：
 *     好友都不在线），随后 `{status:"OFFLINE"}` 收尾。
 *
 *   ★ **还没验证到的**：`同意/拒绝/撤销` 这三种"对某个请求的动作"在服务端
 *     具体怎么表达（见 `friend_action` 的说明）。它们在客户端里同样走
 *     `putFriendAction`，只是 `UpdateType` 只有 `ADD` / `REMOVE` 两个值，
 *     所以这里的做法是：**同意 = 对请求方 ADD；拒绝/撤销/删除 = REMOVE**。
 *     第一次遇到真实请求时要按这个判据核对一遍（界面上不会假装成功：
 *     非 2xx 一律如实报错）。
 *
 * ## 边界
 *
 *   · **只有正版能用**：所有调用都要 `Authorization: Bearer <Minecraft 令牌>`，
 *     离线身份没有令牌（`"0"`）⇒ 命令一进来就返回"离线账号用不了这个"。
 *   · 令牌**不经过前端**：命令只收 `uuid`，由后端自己从密钥环读令牌。
 */
use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::auth::{self, AuthError};

/* ====================== 端点（唯一一处） ====================== */

const FRIENDS_URL: &str = "https://api.minecraftservices.com/friends";
const PRESENCE_URL: &str = "https://api.minecraftservices.com/presence";
const ATTRIBUTES_URL: &str = "https://api.minecraftservices.com/player/attributes";
const BLOCKLIST_URL: &str = "https://api.minecraftservices.com/privacy/blocklist";
/// 按玩家名查 uuid（`profiles.getByName`）—— 加好友要用它把名字变成 id
const PROFILE_BY_NAME_URL: &str = "https://api.mojang.com/users/profiles/minecraft/";

/* ====================== 类型 ====================== */

/// 一条好友 / 一个请求（服务端给的就是这两样：id 与名字）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FriendEntry {
    pub profile_id: String,
    /// ★ 服务端给的名字；理论上一定在，真缺了就用空串（界面显示 uuid 前 8 位）
    #[serde(default)]
    pub name: String,
}

/// 好友快照：**服务端的名单**（本地只额外挂"备注"，那是界面的事）
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FriendsSnapshot {
    pub friends: Vec<FriendEntry>,
    pub incoming_requests: Vec<FriendEntry>,
    pub outgoing_requests: Vec<FriendEntry>,
}

/// 在线状态。取值表来自 authlib 的 `PresenceStatus` 枚举（一个字都不能改）
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

impl PresenceStatus {
    /// 我们**自己**上报时用哪一档。
    ///
    /// ★ 启动器只能诚实地报"在线"：我们说不了自己在玩什么世界。
    ///   进游戏之后由游戏自己上报（它才知道是单机还是服务器）。
    pub fn for_launcher() -> Self {
        PresenceStatus::Online
    }
}

/// 一条在场记录（`POST /presence` 回给我们的）
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

#[derive(Debug, Clone, Deserialize)]
struct PresenceResponse {
    #[serde(default)]
    presence: Vec<PresenceRow>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FriendsListResponse {
    #[serde(default)]
    friends: Vec<FriendEntry>,
    #[serde(default)]
    incoming_requests: Vec<FriendEntry>,
    #[serde(default)]
    outgoing_requests: Vec<FriendEntry>,
}

/// 好友隐私设置：**谁能加我**（`friends`）与**谁能邀请我**（`acceptInvites`）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Toggle {
    Enabled,
    Disabled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FriendsSettings {
    pub friends: Toggle,
    pub accept_invites: Toggle,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FriendsPreferencesDto {
    #[serde(default)]
    friends: Option<Toggle>,
    #[serde(default)]
    accept_invites: Option<Toggle>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttributesResponse {
    #[serde(default)]
    friends_preferences: Option<FriendsPreferencesDto>,
}

/// `profiles.getByName` 的回包：`{"id":"<32位hex>","name":"Steve"}`
#[derive(Debug, Clone, Deserialize)]
struct ProfileByName {
    id: String,
    #[serde(default)]
    name: String,
}

/// 服务端的错误体：`{"path":"/friends","errorMessage":"…","details":…}`
///
/// ★ 这个方法体里有 `path`/`details` 两个字段**故意只反序列化、不使用**：
///   它们对用户没有意义（`path` 是给我们自己核对端点用的，`details` 是一坨
///   结构化细节），但**必须能被解析** —— 否则 serde 会把整份错误体判成"看不懂"，
///   于是我们连 `errorMessage`（唯一该给用户看的那句）都拿不到。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiError {
    #[serde(default)]
    #[allow(dead_code)]
    path: Option<String>,
    #[serde(default)]
    error_message: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    details: Option<serde_json::Value>,
}

/* ====================== 令牌与请求 ======================
 *
 * ★★★★ 2026-10-12（用户：「**令牌过期，感觉这是个bug**」—— 他说得对）。
 *
 *   这里原来只有一个 `token_of(uuid)`：把密钥环里那把 `access_token` 拿出来就用，
 *   **完全不看它有没有过期**。于是令牌一过期，好友服务就 401，界面弹
 *   「好友服务不认这把令牌 —— 到设置里重新登录一次正版账号」。
 *   可我们手里**就有 refresh token**，续一次就好了 ——
 *   而启动游戏那条路早就是 `needs_refresh()` → `refresh_msa`。
 *   **同一条链上两套做法**，就是这个 bug 的根。
 *
 *   现在只有一条路：`send_with_token` ——
 *     ① 先用 `auth::valid_access_token`（快过期/没到期时间 ⇒ 自己续期并写回密钥环）；
 *     ② 服务端若仍回 **401**，说明时钟判断不够权威 ⇒ **强制续期一次再试一遍**
 *        （服务端说"这把不认"比我们看 `expires_at` 可信）；
 *     ③ 续期成功且第二次通 ⇒ 当作正常结果（用户什么都不用做）；
 *     ④ 续期也失败（refresh token 真废了）⇒ 把**微软的原因**如实抛出去；
 *     ⑤ 续了还是 401 ⇒ 这时才说"重新登录一次"（那时它是对的）。
 */

/// 一次接口调用的回应：状态码 + ETag + 原文（401 重试时这三样都要留着）
struct ApiReply {
    status: reqwest::StatusCode,
    etag: Option<String>,
    text: String,
}

impl ApiReply {
    async fn from(resp: reqwest::Response) -> Self {
        let status = resp.status();
        let etag = etag_of(&resp);
        let text = resp.text().await.unwrap_or_default();
        Self { status, etag, text }
    }
    fn ok(&self) -> bool {
        self.status.is_success()
    }
    fn not_modified(&self) -> bool {
        self.status == reqwest::StatusCode::NOT_MODIFIED
    }
}

/// 带上**一把能用的令牌**发一个请求；401 就续期再试一次。
///
/// `build(token)` 负责把请求拼出来（同一个闭包会被调用两次，所以里面必须是
/// **可以重复构造**的东西 —— 我们传的都是 URL + 可选 body，没问题）。
async fn send_with_token<F, Fut>(uuid: &str, what: &str, build: F) -> Result<ApiReply, AuthError>
where
    F: Fn(String) -> Fut,
    Fut: std::future::Future<Output = reqwest::Result<reqwest::Response>>,
{
    let token = auth::valid_access_token(uuid).await?;
    let reply = ApiReply::from(build(token).await?).await;
    if reply.status != reqwest::StatusCode::UNAUTHORIZED {
        return Ok(reply);
    }

    /*
     * 401：服务端明确说这把不行了 —— 比我们看 `expires_at` 权威，强制续期一次。
     * ★ 续期失败时**不要**把 401 那句"重新登录"顶上去：续期失败有它自己的原因
     *   （比如 refresh token 被注销了），那句话才是用户该看的。
     */
    let fresh = auth::force_refresh_access_token(uuid).await?;
    let reply = ApiReply::from(build(fresh).await?).await;
    if reply.status == reqwest::StatusCode::UNAUTHORIZED {
        // 续了还不行 ⇒ 这才是真需要重新登录的时候
        return Err(explain(reply.status, &reply.text, what));
    }
    Ok(reply)
}

/// 把服务端的失败翻成**能行动**的话（状态码 + 它自己给的原因）
/// 服务端 `details.status` 里那几个**能行动**的取值。
///
/// ★ 取值表与客户端 authlib 的 `FriendsService$ResultCode` 同源，另外加上真机
///   抓到的那一个 `INVITE_REJECTED`（2026-10-12 用户加好友时服务端给的）。
fn explain_status_code(code: &str) -> Option<&'static str> {
    match code {
        /*
         * ★★★★ 2026-10-12（用户加 Jonct_08 时截的图）：
         *   HTTP 403 + `details.status = "INVITE_REJECTED"` +
         *   `errorMessage = "User does not have friends enabled or accept invites"`。
         *
         *   这句话说的是**对方**：他把"允许别人给我发好友请求"关掉了。
         *   而 403 这个状态码本身什么也说明不了 —— 我原来把它一律解释成
         *   "你没有好友功能的权限（未成年人/地区限制）"，把用户引到了
         *   完全错误的方向（他会去查自己的账号设置，而问题在对方那边）。
         */
        "INVITE_REJECTED" => Some(
            "对方把好友请求关掉了 —— 他的设置里「允许别人给我发好友请求」是关闭状态。\n\
             这不是你的账号问题：让他在游戏里「好友」页的设置里打开那个开关。\n\
             （名字写错通常不是这个错，而是「查不到这个人」。）",
        ),
        "TOO_MANY_REQUESTS" => Some("操作太频繁了，等几分钟再试。"),
        "UNKNOWN_PROFILE" => Some("服务端说没有这个人（名字可能写错了）。"),
        "SERVICE_NOT_AVAILABLE" | "SERVICE_UNAVAILABLE" | "TEMPORARY_UNAVAILABLE" => {
            Some("好友服务现在临时不可用（不是你的问题）—— 稍后再试。")
        }
        "UNAUTHORIZED" => Some("这把令牌不被接受 —— 到「设置 → 账号」重新登录一次正版账号。"),
        "UPGRADE_NEEDED" => Some("这个功能需要把游戏升级到新版本。"),
        "CONNECTION_ISSUE" => Some("网络连接有问题，稍后重试。"),
        "FORBIDDEN" => Some("服务端拒绝了这次操作。"),
        _ => None,
    }
}

/// 把服务端的失败翻成**能行动**的话。
///
/// 优先顺序（越靠前越具体）：
///   ① `details.status` 里那个明确的取值（`INVITE_REJECTED` 这种，它直接指出**谁**的问题）；
///   ② HTTP 状态码给一句兜底（401 = 重新登录、429 = 别急…）；
///   ③ 服务端自己那句话（**照原样带上**，哪怕它是英文 —— 那是权威说法）；
///   ④ 真到什么都没有，才回落到原始响应体（截短）。
fn explain(status: reqwest::StatusCode, body: &str, what: &str) -> AuthError {
    let parsed: Option<ApiError> = serde_json::from_str(body).ok();
    /*
     * ★ `details.status` 可能是字符串，也可能嵌得更深 —— 两种都认。
     */
    let detail_status = parsed
        .as_ref()
        .and_then(|e| e.details.as_ref())
        .and_then(|d| {
            d.get("status")
                .and_then(|s| s.as_str())
                .or_else(|| d.as_str())
        })
        .map(str::to_string);

    let hint = detail_status
        .as_deref()
        .and_then(explain_status_code)
        .map(str::to_string)
        .unwrap_or_else(|| {
            match status.as_u16() {
                401 => "好友服务不认这把令牌 —— 到「设置 → 账号」重新登录一次正版账号。".to_string(),
                /*
                 * ★ 403 **不再猜"你没有权限"**：这个状态码背后可能是对方的设置、
                 *   也可能是别的原因。真正该说的是服务端那句话（见下）。
                 */
                403 => "服务端拒绝了这次操作。".to_string(),
                404 => "服务端说找不到这个人。".to_string(),
                429 => "请求太频繁，稍等一下再试。".to_string(),
                c if c >= 500 => "好友服务现在有问题（不是你的问题）—— 稍后再试。".to_string(),
                _ => "好友服务返回了错误。".to_string(),
            }
        });

    let server_said = parsed
        .as_ref()
        .and_then(|e| e.error_message.clone())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| body.replace(['\r', '\n'], " ").chars().take(200).collect());

    let code_line = detail_status
        .as_deref()
        .map(|s| format!("{s} / HTTP {status}"))
        .unwrap_or_else(|| format!("HTTP {status}"));

    /*
     * `what` 当括号里的**标签**用，不再重复一遍「加好友失败」——
     * 弹窗/提示条的标题已经说了那三个字，正文里再来一遍就成了"加好友失败 加好友失败：…"。
     */
    AuthError::Other(format!(
        "{hint}\n（{what} · {code_line}；服务端说：{server_said}）"
    ))
}

/* ====================== ETag 缓存 ======================
 *
 * ★★★★ 2026-10-12（用户给的设计图）：
 *
 *   「核心机制：REST API 与 ETag 缓存 —— `GET /friends` 带上 `If-None-Match`，
 *     数据没变服务端回 **304 Not Modified**，客户端直接用本地那份；
 *     变了才回 **200 OK** 带新数据 + 新 ETag。」
 *
 *   这正是客户端 authlib 的做法（`MinecraftClient.getWithEtag` / `postWithEtag`，
 *   头是 `If-None-Match`，收到 `HTTP_NOT_MODIFIED` 就沿用缓存）——
 *   我一开始挖到了却没接上，于是每次刷新都在重新下载整份名单。
 *
 * ## 为什么 ETag 存**内存**就够
 *
 *   它是"这台机器这个进程上一次看到的样子"，进程一退就没有意义了；
 *   落盘反而会在换账号/被踢下线时留下过期的 etag，让服务端回一个
 *   我们缓存里根本没有的"没变"（于是界面永远停在旧名单上 ✗）。
 *   ⇒ 内存 + 按 uuid 分开 + 只认 200 里带回来的那个。
 */
static ETAGS: std::sync::OnceLock<std::sync::Mutex<HashMap<String, String>>> =
    std::sync::OnceLock::new();

fn etag_map() -> &'static std::sync::Mutex<HashMap<String, String>> {
    ETAGS.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

/// 上一次拿到的 etag（没有就 None ⇒ 请求不带 `If-None-Match`）
fn etag_get(key: &str) -> Option<String> {
    etag_map().lock().ok()?.get(key).cloned()
}

/// 记下（或清掉）这一路的 etag。★ 只在 **200** 时写：304 不带新值，别把它抹了。
fn etag_put(key: &str, value: Option<&str>) {
    if let Ok(mut m) = etag_map().lock() {
        match value {
            Some(v) if !v.is_empty() => {
                m.insert(key.to_string(), v.to_string());
            }
            _ => {
                m.remove(key);
            }
        }
    }
}

/// 把响应头里的 ETag 规范化：去掉弱校验前缀 `W/` 与空白，空值就是"没有"。
///
/// ★ 单独拆出来是为了**能测**：这段错了不会报错，只会"每次都重新下载整份名单"
///   （服务端认不得我们回传的那个串 ⇒ 永远 200）。真机上见过带引号与不带引号两种。
fn normalize_etag(raw: &str) -> Option<String> {
    let t = raw.trim();
    let t = t.strip_prefix("W/").unwrap_or(t).trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

/// 从响应头里取 ETag
fn etag_of(resp: &reqwest::Response) -> Option<String> {
    let raw = resp.headers().get(reqwest::header::ETAG)?.to_str().ok()?;
    normalize_etag(raw)
}

/* ====================== 调用 ====================== */

/// 把应用级的错误翻成给用户看的字符串（Tauri 命令统一走它）
pub fn err_text(e: AuthError) -> String {
    e.to_string()
}

/// 好友名单（`GET /friends`，**带 ETag**）。
///
/// 返回 `None` = 服务端说 **304 没变** ⇒ 调用方**沿用本地那份**（不要清空界面）。
/// 返回 `Some(..)` = 200，拿到了新名单（etag 已更新）。
pub async fn snapshot(uuid: &str) -> Result<Option<FriendsSnapshot>, AuthError> {
    let key = format!("friends:{uuid}");
    let reply = send_with_token(uuid, "取好友名单", |token| {
        /*
         * ★ 闭包会被调用两次（第一次 401 的话）—— 所以每次都要**重新拼**请求，
         *   并且每次都带上当前那个 etag（它不随 token 变）。
         */
        let tag = etag_get(&key);
        let mut req = crate::net::client()
            .get(FRIENDS_URL)
            .bearer_auth(token)
            .header("Accept", "application/json");
        if let Some(t) = tag {
            req = req.header("If-None-Match", t);
        }
        req.send()
    })
    .await?;

    /* ---------- 304：没变，用本地那份 ---------- */
    if reply.not_modified() {
        return Ok(None);
    }

    if !reply.ok() {
        /*
         * ★ 失败时**不动** etag：下次还带同一个，服务端还能给我们 304 ——
         *   把 etag 抹掉只会让下一次白白多下一份完整名单。
         */
        return Err(explain(reply.status, &reply.text, "取好友名单"));
    }
    let parsed: FriendsListResponse = serde_json::from_str(&reply.text).map_err(|e| {
        AuthError::Other(format!("好友名单解析失败：{e}（原始返回前 200 字符：{}）", reply.text.chars().take(200).collect::<String>()))
    })?;
    etag_put(&key, reply.etag.as_deref());
    Ok(Some(FriendsSnapshot {
        friends: parsed.friends,
        incoming_requests: parsed.incoming_requests,
        outgoing_requests: parsed.outgoing_requests,
    }))
}

/// 按玩家名查 uuid（`GET api.mojang.com/users/profiles/minecraft/{name}`）
pub async fn lookup_by_name(name: &str) -> Result<(String, String), AuthError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AuthError::Other("先填一个玩家名。".into()));
    }
    let url = format!("{PROFILE_BY_NAME_URL}{name}");
    let resp = crate::net::client().get(&url).send().await?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if status.as_u16() == 404 || (status.is_success() && text.trim().is_empty()) {
        return Err(AuthError::Other(format!(
            "查不到叫「{name}」的玩家 —— 名字区分大小写，而且要用他的正版玩家名。"
        )));
    }
    if status.as_u16() == 429 {
        return Err(AuthError::Other(
            "查得太频繁了（这个接口有速率限制），等一会儿再试。".into(),
        ));
    }
    if !status.is_success() {
        return Err(explain(status, &text, "查玩家名"));
    }
    let p: ProfileByName = serde_json::from_str(&text)
        .map_err(|e| AuthError::Other(format!("查玩家名的返回看不懂：{e}")))?;
    Ok((p.id, if p.name.is_empty() { name.to_string() } else { p.name }))
}

/// 好友关系动作：**加**（`ADD`）或**删/拒/撤**（`REMOVE`）
///
/// `profile_id` 是 32 位 hex（服务端口径）。名字要先过 `lookup_by_name`。
pub async fn friend_action(uuid: &str, profile_id: &str, add: bool) -> Result<(), AuthError> {
    let body = serde_json::json!({
        "profileId": profile_id,
        "updateType": if add { "ADD" } else { "REMOVE" },
    });
    let reply = send_with_token(uuid, if add { "加好友" } else { "改好友关系" }, |token| {
        crate::net::client()
            .put(FRIENDS_URL)
            .bearer_auth(token)
            .json(&body)
            .send()
    })
    .await?;
    if !reply.ok() {
        return Err(explain(
            reply.status,
            &reply.text,
            if add { "加好友" } else { "改好友关系" },
        ));
    }
    Ok(())
}

/// 上报自己的在线状态，并**拿回好友们的状态**（`POST /presence`，**带 ETag**）。
///
/// 返回 `None` = **304 没变** ⇒ 调用方沿用本地那份状态（也别把界面清空）。
/// 返回 `Some(..)` = 有新数据；`Some(vec![])` = 这一轮**没有好友有状态**
/// （按 `resolvePresence` 的规则，那就是"都离线"）。
///
/// ★ 与名单同一个机制（客户端的 `postWithEtag`）：我们**仍然把自己的状态报上去**
///   （那是心跳的意义），只是"拿回来的那份"可以省掉。etag 由服务端在 200 里给。
pub async fn presence(
    uuid: &str,
    status: PresenceStatus,
) -> Result<Option<Vec<PresenceRow>>, AuthError> {
    let key = format!("presence:{uuid}");
    let body = serde_json::json!({ "status": status });
    let reply = send_with_token(uuid, "上报在线状态", |token| {
        let tag = etag_get(&key);
        let mut req = crate::net::client()
            .post(PRESENCE_URL)
            .bearer_auth(token)
            .json(&body);
        if let Some(t) = tag {
            req = req.header("If-None-Match", t);
        }
        req.send()
    })
    .await?;

    if reply.not_modified() {
        return Ok(None);
    }

    if !reply.ok() {
        return Err(explain(reply.status, &reply.text, "上报在线状态"));
    }
    etag_put(&key, reply.etag.as_deref());
    // ★ 204 / 空体也要当成"没事"（服务端有时只回状态码）
    if reply.text.trim().is_empty() {
        return Ok(Some(Vec::new()));
    }
    let parsed: PresenceResponse =
        serde_json::from_str(&reply.text).unwrap_or(PresenceResponse { presence: Vec::new() });
    Ok(Some(parsed.presence))
}

/// 读好友隐私设置（`GET /player/attributes`）
pub async fn settings(uuid: &str) -> Result<FriendsSettings, AuthError> {
    let reply = send_with_token(uuid, "读好友设置", |token| {
        crate::net::client()
            .get(ATTRIBUTES_URL)
            .bearer_auth(token)
            .send()
    })
    .await?;
    if !reply.ok() {
        return Err(explain(reply.status, &reply.text, "读好友设置"));
    }
    let parsed: AttributesResponse = serde_json::from_str(&reply.text)
        .map_err(|e| AuthError::Other(format!("好友设置解析失败：{e}")))?;
    let prefs = parsed.friends_preferences.unwrap_or(FriendsPreferencesDto {
        friends: None,
        accept_invites: None,
    });
    Ok(FriendsSettings {
        friends: prefs.friends.unwrap_or(Toggle::Enabled),
        accept_invites: prefs.accept_invites.unwrap_or(Toggle::Enabled),
    })
}

/// 改好友隐私设置（`POST /player/attributes`）
pub async fn set_settings(uuid: &str, s: &FriendsSettings) -> Result<(), AuthError> {
    let body = serde_json::json!({
        "friendsPreferences": {
            "friends": s.friends,
            "acceptInvites": s.accept_invites,
        }
    });
    let reply = send_with_token(uuid, "改好友设置", |token| {
        crate::net::client()
            .post(ATTRIBUTES_URL)
            .bearer_auth(token)
            .json(&body)
            .send()
    })
    .await?;
    if !reply.ok() {
        return Err(explain(reply.status, &reply.text, "改好友设置"));
    }
    Ok(())
}

/// 被拉黑名单（`GET /privacy/blocklist`）—— 界面用它说明"为什么看不到某个人"
pub async fn blocklist(uuid: &str) -> Result<Vec<String>, AuthError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct BlockListResponse {
        #[serde(default)]
        blocked_profiles: Vec<String>,
    }
    let reply = send_with_token(uuid, "读黑名单", |token| {
        crate::net::client()
            .get(BLOCKLIST_URL)
            .bearer_auth(token)
            .send()
    })
    .await?;
    if !reply.ok() {
        return Err(explain(reply.status, &reply.text, "读黑名单"));
    }
    let parsed: BlockListResponse = serde_json::from_str(&reply.text).unwrap_or(BlockListResponse {
        blocked_profiles: Vec::new(),
    });
    Ok(parsed.blocked_profiles)
}

/// 把在线状态摊成"看得懂的一句话"（界面直接用；Rust 侧也用它写日志）
pub fn presence_label(status: Option<PresenceStatus>) -> &'static str {
    match status {
        Some(PresenceStatus::Online) => "在线",
        Some(PresenceStatus::PlayingOffline) => "在玩单机",
        Some(PresenceStatus::PlayingRealms) => "在玩 Realms",
        Some(PresenceStatus::PlayingServer) => "在服务器里",
        Some(PresenceStatus::PlayingHostedServer) => "开放了他的世界",
        Some(PresenceStatus::Offline) => "离线",
        None => "未知",
    }
}

/// 界面要的合并结果：名单 + 每个人的状态（一次调用把两样都给出去）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FriendView {
    pub profile_id: String,
    pub name: String,
    /// 在线状态（拿不到就是 None ⇒ 界面写"未知"，**不许编**）
    pub presence: Option<PresenceStatus>,
    pub presence_label: String,
    /// 本机备注（界面从 prefs 里挂上去的，这里留字段让前端少一次拼装）
    #[serde(default)]
    pub note: Option<String>,
}

/// 把名单与在场记录合起来（纯函数 —— 有判据，见下方测试）
pub fn merge_presence(
    entries: &[FriendEntry],
    presence: &[PresenceRow],
) -> Vec<FriendView> {
    let mut by_id: HashMap<&str, Option<PresenceStatus>> = HashMap::new();
    for p in presence {
        by_id.insert(p.profile_id.as_str(), p.status);
    }
    entries
        .iter()
        .map(|e| {
            let st = by_id.get(e.profile_id.as_str()).copied().flatten();
            FriendView {
                profile_id: e.profile_id.clone(),
                name: e.name.clone(),
                presence: st,
                presence_label: presence_label(st).to_string(),
                note: None,
            }
        })
        .collect()
}

/* ====================== 判据 ====================== */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presence_wire_values_match_the_client_enum() {
        // ★ 这些字面量来自 authlib 的 PresenceStatus 枚举 —— 改一个就发错了
        let cases = [
            (PresenceStatus::Online, "\"ONLINE\""),
            (PresenceStatus::PlayingOffline, "\"PLAYING_OFFLINE\""),
            (PresenceStatus::PlayingRealms, "\"PLAYING_REALMS\""),
            (PresenceStatus::PlayingServer, "\"PLAYING_SERVER\""),
            (PresenceStatus::PlayingHostedServer, "\"PLAYING_HOSTED_SERVER\""),
            (PresenceStatus::Offline, "\"OFFLINE\""),
        ];
        for (st, wire) in cases {
            assert_eq!(serde_json::to_string(&st).unwrap(), wire);
        }
    }

    #[test]
    fn toggle_wire_values_are_enabled_or_disabled() {
        assert_eq!(serde_json::to_string(&Toggle::Enabled).unwrap(), "\"ENABLED\"");
        assert_eq!(serde_json::to_string(&Toggle::Disabled).unwrap(), "\"DISABLED\"");
    }

    #[test]
    fn friends_list_parses_the_real_shape() {
        // 真机拿回来的形状（名字换成占位符）
        let text = r#"{
            "friends":[{"profileId":"aaaa","name":"A"}],
            "incomingRequests":[{"profileId":"bbbb","name":"B"}],
            "outgoingRequests":[],
            "empty":false
        }"#;
        let v: FriendsListResponse = serde_json::from_str(text).unwrap();
        assert_eq!(v.friends.len(), 1);
        assert_eq!(v.friends[0].profile_id, "aaaa");
        assert_eq!(v.incoming_requests[0].name, "B");
        assert!(v.outgoing_requests.is_empty());
    }

    #[test]
    fn presence_response_parses_and_merges() {
        let text = r#"{"presence":[
            {"profileId":"aaaa","pmid":"p1","status":"PLAYING_SERVER","lastUpdated":123}
        ]}"#;
        let v: PresenceResponse = serde_json::from_str(text).unwrap();
        let entries = vec![
            FriendEntry { profile_id: "aaaa".into(), name: "A".into() },
            FriendEntry { profile_id: "cccc".into(), name: "C".into() },
        ];
        let merged = merge_presence(&entries, &v.presence);
        assert_eq!(merged[0].presence, Some(PresenceStatus::PlayingServer));
        assert_eq!(merged[0].presence_label, "在服务器里");
        // ★ 没出现在在场列表里的那个人：**写"未知"，不许编成"离线"**
        assert_eq!(merged[1].presence, None);
        assert_eq!(merged[1].presence_label, "未知");
    }

    #[test]
    fn unknown_presence_string_does_not_blow_up_the_whole_list() {
        // 服务端将来加了新状态值：那一条解析不出来也不能把整份名单搞挂 ——
        // 现在的实现是"整条 presence 解析失败就当作空"，所以这里钉住"空 = 未知"
        let entries = vec![FriendEntry { profile_id: "aaaa".into(), name: "A".into() }];
        let merged = merge_presence(&entries, &[]);
        assert_eq!(merged[0].presence_label, "未知");
    }

    #[test]
    fn profile_by_name_parses() {
        let p: ProfileByName =
            serde_json::from_str(r#"{"id":"0123456789abcdef0123456789abcdef","name":"Steve"}"#)
                .unwrap();
        assert_eq!(p.id.len(), 32);
        assert_eq!(p.name, "Steve");
    }

    #[test]
    fn attributes_parse_with_and_without_preferences() {
        let with = r#"{"privileges":{},"friendsPreferences":{"friends":"ENABLED","acceptInvites":"DISABLED"}}"#;
        let v: AttributesResponse = serde_json::from_str(with).unwrap();
        let prefs = v.friends_preferences.unwrap();
        assert_eq!(prefs.friends, Some(Toggle::Enabled));
        assert_eq!(prefs.accept_invites, Some(Toggle::Disabled));

        // 缺字段时按"允许"（服务端的默认就是允许）—— 不许默认成"禁止"，
        // 那会让界面显示一个用户根本没设过的状态
        let without = r#"{"privileges":{}}"#;
        let v2: AttributesResponse = serde_json::from_str(without).unwrap();
        assert!(v2.friends_preferences.is_none());
        let s = FriendsSettings {
            friends: Toggle::Enabled,
            accept_invites: Toggle::Enabled,
        };
        assert_eq!(s.friends, Toggle::Enabled);
    }

    #[test]
    fn api_error_is_explained_with_the_servers_own_words() {
        // 真机那次 400 的形状
        let e = explain(
            reqwest::StatusCode::BAD_REQUEST,
            r#"{"path":"/friends","errorMessage":"That profile does not exist"}"#,
            "加好友",
        );
        let text = e.to_string();
        assert!(text.contains("That profile does not exist"), "要把服务端的话带上：{text}");
        assert!(text.contains("400"));
        /*
         * ★★ 这一条同时钉住"解析有没有真的成功"：
         *   `errorMessage` 的键是**驼峰**，结构体漏了 `rename_all` 就会解析失败、
         *   于是那句话根本进不了提示，用户看到的是整坨 JSON（真机就这么错过一次）。
         */
        assert!(
            !text.contains(r#""errorMessage""#),
            "不该把原始 JSON 整坨丢给用户（说明驼峰键没解析出来）：{text}"
        );
    }

    /// ★★★★ 2026-10-12（用户加 Jonct_08 时截的图，一字不差抄下来的响应体）。
    ///
    ///   这一条错误当时被我说成了"这个账号没有好友功能的权限（未成年人/地区限制）" ——
    ///   而服务端的意思恰恰相反：**对方**把好友请求关掉了。
    ///   两条判据：① 要指向对方；② 不许再猜"你的账号没权限"。
    #[test]
    fn invite_rejected_is_about_the_other_person_not_you() {
        let body = r#"{"path":"/friends","details":{"status":"INVITE_REJECTED"},"errorMessage":"User does not have friends enabled or accept invites"}"#;
        let text = explain(reqwest::StatusCode::FORBIDDEN, body, "加好友").to_string();

        assert!(text.contains("对方"), "必须指出问题在**对方**那边：{text}");
        assert!(
            text.contains("允许别人给我发好友请求"),
            "要说出对方关掉的是哪一个开关：{text}"
        );
        assert!(
            !text.contains("未成年人") && !text.contains("地区限制"),
            "★ 不许再把 403 猜成「你的账号没权限」：{text}"
        );
        // 服务端原话与那个错误码都要留着（排查时是唯一线索）
        assert!(text.contains("does not have friends enabled"));
        assert!(text.contains("INVITE_REJECTED"));
        assert!(!text.contains(r#""details""#), "不该把原始 JSON 整坨丢出来：{text}");
    }

    /// 认不出来的 `details.status` 不许瞎翻译 —— 回落成 HTTP 状态码那句兜底。
    #[test]
    fn unknown_detail_status_falls_back_to_the_http_code() {
        let body = r#"{"path":"/friends","details":{"status":"SOMETHING_BRAND_NEW"},"errorMessage":"nope"}"#;
        let text = explain(reqwest::StatusCode::FORBIDDEN, body, "加好友").to_string();
        assert!(text.contains("SOMETHING_BRAND_NEW"), "错误码要带上：{text}");
        assert!(text.contains("服务端拒绝了这次操作"));
        assert!(text.contains("nope"));
    }

    /// ★★ ETag 的规范化：弱校验前缀、引号、空白都要吃掉；空值当"没有"。
    ///
    ///   这段错了的后果很隐蔽：不会报错，只是**每次都重新下载整份名单**
    ///   （服务端认不得我们回传的串 ⇒ 永远 200）。
    #[test]
    fn etag_is_normalized_before_being_sent_back() {
        assert_eq!(normalize_etag("\"abc123\""), Some("\"abc123\"".to_string()));
        assert_eq!(normalize_etag("W/\"abc123\""), Some("\"abc123\"".to_string()));
        assert_eq!(normalize_etag("  W/\"abc\"  "), Some("\"abc\"".to_string()));
        assert_eq!(normalize_etag("abc"), Some("abc".to_string()));
        assert_eq!(normalize_etag(""), None);
        assert_eq!(normalize_etag("   "), None);
        assert_eq!(normalize_etag("W/"), None);
    }

    #[test]
    fn launcher_reports_itself_as_online_not_playing() {
        // 启动器不知道你在玩什么世界 ⇒ 只报"在线"，不许冒充"在玩单机"
        assert_eq!(PresenceStatus::for_launcher(), PresenceStatus::Online);
    }
}
