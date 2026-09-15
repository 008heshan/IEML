# PCL2 的微软登录：逐行研读与对照

> 结论先行：**PCL 把"登录"当成一个有状态的六步流程 + 一个缓存层**，
> 而不是"调几个接口"。我们缺的那一层是**缓存与续期**。
>
> 本文所有行号都能在 `E:\PCL-main\Plain Craft Launcher 2\` 里查到。
> 写完这一轮之后，我们的实现已经按这份对照补齐（见每一节的「我们的现状」）。

---

## 一、六步流程（`Modules/Minecraft/ModLaunch.vb`）

编排在 `McLoginMsStart`（552-611 行）。逐步抄下来：

| 步 | PCL 函数 | 行号 | 端点 | 说明 |
|---|---|---|---|---|
| 1a | `MsLoginStep1New` | 892 | `login.microsoftonline.com/consumers/oauth2/v2.0/devicecode` | 无 refresh token 时走设备码 |
| 1b | `MsLoginStep1Refresh` | 924 | **`login.live.com/oauth20_token.srf`** | 有 refresh token 时**先续期** |
| 2 | `MsLoginStep2` | 958 | `user.auth.xboxlive.com/user/authenticate` | OAuth access token → XBL token |
| 3 | `MsLoginStep3` | 974 | `xsts.auth.xboxlive.com/xsts/authorize` | XBL → XSTS token + UHS |
| 4 | `MsLoginStep4` | 1026 | `api.minecraftservices.com/authentication/login_with_xbox` | XSTS → Minecraft access token |
| 5 | `MsLoginStep5` | 1058 | `api.minecraftservices.com/entitlements/mcstore` | **验证有没有买游戏** |
| 6 | `MsLoginStep6` | 1078 | `api.minecraftservices.com/minecraft/profile` | → UUID + 玩家名 |

**这七条我们一条不差**（`src-tauri/src/auth/mod.rs`），端点在
`tests/live_ms_protocol.rs::endpoints_match_the_reference_implementations` 里钉着。

### 1.1 一个容易抄错的细节：两个 token 端点**不是同一个**

```text
892-900  devicecode  →  login.microsoftonline.com/consumers/oauth2/v2.0/devicecode
924-930  刷新        →  login.live.com/oauth20_token.srf          ← 注意域名都不同
```

我们的代码里为这个留了一大段注释：老实现刷新时误用了 `consumers` 那个端点，
微软对 `grant_type=refresh_token` 返回的是一句看不懂的英文错误。
**这类"少一个字段 / 用错一个端点"的错误，表现都是整条链路莫名其妙走不通。**

### 1.2 设备码的两个参数

```text
899  Content := $"client_id={OAuthClientId}&tenant=/consumers&scope=XboxLive.signin%20offline_access"
```

* `scope` = `XboxLive.signin offline_access` —— **`offline_access` 是拿
  refresh_token 的前提**，少了它就只能反复让用户输设备码。
* `tenant=/consumers` 写在 **form body** 里（不是 URL 路径）。v2 端点其实
  忽略它，但照着抄不会错。
* 换令牌时（`MyMsgLogin.xaml.vb` 111-114）再带一次 `scope`。

> 实测记录：我曾以为"轮询时少带 `scope` 是 bug"，真机验过之后发现
> **带不带都能过**（HMCL 的 `OAuth.java` 就不带）。注释按实测改了 ——
> 证据推翻推测时，要改的是注释。

---

## 二、★ 真正的分水岭：缓存层（552-582 行）

这一段是**我们原来完全没有的**，也是用户报"第二天变成离线 Player"的根因。

```text
557  '检查是否已经登录完成
558  Dim ExpiresAt = Settings.Get(Of Long)("CacheMsV2Expires")
559  If Not Data.IsForceRestarting AndAlso
560     ExpiresAt > 0 AndAlso ExpiresAt > GetUnixTimestampUtc() AndAlso
561     Input.UserName = Settings.Get(Of String)("CacheMsV2Name") Then
...
570      GoTo SkipLogin                     ← ① 没过期 → 直接复用，**不打网络**
571  End If
572  '尝试登录
574  If Input.OAuthRefreshToken = "" Then
577      OAuthTokens = MsLoginStep1New(Data)        ← ② 没 refresh token → 设备码
579  Else
580      OAuthTokens = MsLoginStep1Refresh(...)     ← ③ 有 → **先续期**
581      If ... = "Relogin" Then GoTo Relogin       ← ④ 续不上 → 回设备码
582  End If
583  If Data.IsCanceled Then Throw New OperationCanceledException
```

### 四个要点

1. **没过期就复用**（570 行 `GoTo SkipLogin`）—— 启动时不打任何网络。
2. **过期先用 refresh_token 静默续期**（580 行）—— 用户无感。
3. **续不上要区分原因**（581 行 + `MsLoginStep1Refresh` 934-950）：
   * `must sign in again` / `password expired` / `refresh_token ... is not valid`
     / `expired` → 返回 `"Relogin"`，**回设备码让用户重新授权**；
   * `Account security interrupt` → 账号安全问题，弹窗说清；
   * `service abuse` → 账号被封。
   三种情况的处置完全不同，混成一个"登录失败"就是耍赖。
4. **每一步之间都查 `IsCanceled`**（583-600 行，六处）—— 用户点了取消就立刻停，
   而不是跑完整个流程才响应。

### 缓存写盘（604-611 行）

```text
604  Settings.Set("CacheMsV2OAuthRefresh", OAuthRefreshToken)
605  Settings.Set("CacheMsV2Access",        LoginResult.AccessToken)
606  Settings.Set("CacheMsV2Uuid",          Result.UUID)
607  Settings.Set("CacheMsV2Name",          Result.UserName)
608  Settings.Set("CacheMsV2ProfileJson",   Result.ProfileJson)
609  Settings.Set("CacheMsV2Expires",       LoginResult.ExpiresAt)
```

**六个字段一起存**：access token、refresh token、uuid、玩家名、档案 JSON、过期时间。
过期时间是 4 步算出来的（1055 行）：

```text
ResultJson("expires_in") + GetUnixTimestampUtc() - 1200   '提前 20 分钟视作过期
```

> **提前 20 分钟**这点很关键：不留提前量的话，token 会在"刚好要进服务器"
> 的那一刻过期，表现为随机掉线。

### 我们的现状（这一轮补齐）

| PCL 的做法 | 我们原来 | 现在 |
|---|---|---|
| ① 没过期就复用 | ✅ 有（`expires_at` + `is_expired()`） | 保留 |
| ② **过期先静默续期** | ❌ **`is_expired()` 从来没在启动路径上被调用过** | ✅ `prepare_spec` 里续期 |
| ③ 续不上区分原因 | ⚠️ 翻译表有，但没有"回设备码"这条 | ✅ 提示去设置页重登 |
| ④ 各步之间可取消 | ⚠️ 部分 | 未做（登录是短流程，优先级低） |
| 提前 20 分钟过期 | ⚠️ 我们提前 5 分钟 | 保持 5 分钟（更保守：更早续期） |

**②的后果（用户实测）**：正版 access token 一过期（约 24 小时），
`load_account` 拿到的还是那条旧 token，然后**被 `unwrap_or_else` 悄悄换成离线账号** ——
用户第二天启动就变成离线 "Player"，进不了正版服务器、皮肤没了，
而界面上一切正常，**一个字都没说**。

修法见 `commands_real.rs` 的 `prepare_spec`：过期 → `refresh_msa` → 成功就静默用新令牌，
失败就**如实说出来**（`LaunchSpec.notice` → 界面 toast），而不是静默降级。

---

## 三、client_id：PCL 也不带

```text
Modules/ModSecret.vb:10
Public OAuthClientId As String = If(Environment.GetEnvironmentVariable("PCL_MS_CLIENT_ID"), "")
```

**PCL 的开源版把 client_id 留空**，由构建时/环境变量注入。
正式版的 id 是作者自己注册的，不进公开源码。

所以「正版登录需要用户自己填一个 id」**不是我们的缺陷，是这一行的通行做法** ——
微软要求登录方必须是一个在 Azure 注册过的应用，而那个 id 属于要自己申请的资源。
（我们实测过 5 个网上流传的公开 id，全部 `AADSTS700016`：已被微软删掉。）

我们的处理：
* `BUILTIN_CLIENT_ID = ""`；
* 运行期注入（设置页）> 编译期内置 > 环境变量 `IEML_MS_CLIENT_ID`；
* 没配时**不发请求**就给出可行动的说明（去哪申请、三步、以及"不想折腾就用离线模式"）。

---

## 四、错误翻译表（这是 PCL 最值得抄的一块）

PCL 把微软/微软系 API 的英文错误逐条翻成"用户该做什么"，
而且**同一个错误码在两步里各有一份**（源码里明确写着"修改错误列表时，
同时修改 XX 处的对应代码"）：

### 4.1 设备码轮询（`MyMsgLogin.xaml.vb` 124-146）

| 返回里含 | 翻译 |
|---|---|
| `authorization_declined` | 你拒绝了权限 |
| `expired_token` | 登录用时太长，重新试 |
| `Account security interrupt` | 账号由于安全问题无法登录 |
| `service abuse` | 账号已被微软封禁 |
| `AADSTS70000` | （可能不是 invalid_grant）→ 重新登录 |
| `authorization_pending` | **不是错误** → `Thread.Sleep(2000)` 继续轮询 |

> ★ 最后一条最容易写错：`authorization_pending` 是**正常状态**
> （"我看懂了，用户还没去网页输码"）。把它当错误处理，用户就没机会完成登录。
> 我们的轮询里判的就是这个字符串，并且有一条测试
> （`authorization_pending_is_not_an_error_to_the_user`）钉着它。

### 4.2 XSTS（`ModLaunch.vb` 991-1016）

| XErr | 含义 | PCL 的动作 |
|---|---|---|
| `2148916227` | 账号被封 | 说清并终止 |
| `2148916233` | 没注册 Xbox 账户 | 给注册链接 |
| `2148916235` | 国家/地区不支持 | 建议用加速器/VPN |
| `2148916238` | 年龄不足 / 家庭组 | 给改出生日期的链接 |
| `2148916236` | 年龄（另一码） | 同上 |

这五个码我们全有（`explain_xsts_error`）。**老实现只映射了 3 条，
而且漏了 `2148916227`（账号被封）** —— 那种情况下用户会一直重试一直失败，
因为提示里什么都没说。

### 4.3 第 4 步（`login_with_xbox`，1034-1049）

| HTTP | 翻译 |
|---|---|
| 429 | 登录太频繁，等几分钟 |
| 403 | 当前 IP 的登录尝试异常；用了 VPN/加速器就关掉换节点 |
| 503 | Mojang 服务器问题，不是你的网络也不是启动器的问题 |
| `ACCOUNT_SUSPENDED` | 账号被封 |

> PCL 那句"你的网络是正常的，PCL 也是正常的，是 Mojang 出问题了"
> 值得学：**它替用户排除了两个他本来会去排查的方向**。

### 4.4 第 6 步（`minecraft/profile`，1085-1102）

| HTTP | 翻译 |
|---|---|
| 429 | 太频繁 |
| 404 | **请先创建 Minecraft 玩家档案** + 给链接 |

`404` 这一条特别容易漏：账号买了游戏、Xbox 也通，但**没建过 Java 版档案**，
接口就是 404。不说清的话用户完全无从下手。

---

## 五、值得学但还没做的

| # | PCL 的做法 | 我们的现状 |
|---|---|---|
| 1 | 每步之间 `IsCanceled`（六处） | 登录是短流程，未做 |
| 2 | `Relogin` 自动回退到设备码（581 行） | 只提示用户去设置页重登，没有自动重开设备码流程 |
| 3 | `Input.UserName = CacheMsV2Name` 一起判（561 行）—— **换了账号就重新登录** | 我们按 uuid 存凭据，天然按账号隔离 |
| 4 | 提前 20 分钟视作过期（1055 行） | 我们用 5 分钟（更早续期，更保守） |
| 5 | 档案 JSON 一起存（608 行） | 未存（我们的启动只用到 uuid + name + token） |

---

## 六、一句话总结

PCL 的微软登录**不难**（就是七条 HTTP），难的是它外面那层：

> **缓存 → 判过期 → 静默续期 → 续不上再回设备码 → 每一步的错误都翻成"你该做什么"。**

我们原来只有中间那七条 HTTP 和一张错误翻译表，
**缓存判断和续期那一层是空的** —— 而且它是静默失效的（悄悄退回离线），
所以既没人报错、也没人查得出来。这一轮补上了。
