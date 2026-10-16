/**
 * 好友的**本机部分**：备注 + 显示映射（2026-10-12）
 * ==================================================================
 *
 * ## 为什么这里只剩"备注"了
 *
 *   第一版（胚子）是"本机自己攒一份好友名单"，存在 `prefs.json` 里。
 *   现在接上了**真服务**（`GET /friends`，正版令牌），名单以服务端为准 ——
 *   你游戏里的好友直接就出现在启动器里。
 *
 *   用户 2026-10-12 选的处理方式：「本机那份降级成**备注/昵称**」：
 *   ⇒ 本机只存 `profileId → 备注`，**绝不参与"谁是好友"的判断**。
 *     好处是：换台机器、重装启动器，好友名单自动就回来了（服务端的事），
 *     而"班里那个"这种只有你知道的信息留在本机。
 *
 * ## 为什么这些要放进 `domain/`（能被 `node --test` 跑）
 *
 *   "备注怎么写、空备注算不算删、脏 prefs 读回来会不会把界面搞坏"——
 *   全是**错了不会报错、只会慢慢变脏**的那一类。这个仓库的规矩是：
 *   这类判断必须有判据（`tests/friends.test.mjs`）。
 */

/** 备注表：`profileId → 备注`。**只存备注**，不存"谁是我的好友" */
export type FriendNotes = Record<string, string>;

/** 备注长度上限（一条备注是给人看的短标签，不是记事本） */
export const FRIEND_NOTE_MAX = 24;
/** 备注条数上限（手改出来的脏值不该把 prefs 撑坏） */
export const FRIEND_NOTES_MAX = 500;

/** uuid（32 位 hex，可能带横线）才算得像一个 profileId —— 与后端一致 */
export function looksLikeProfileId(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-fA-F-]{32,36}$/.test(v);
}

/**
 * 从 `prefs.json` 里**安全地**读回备注表。
 *
 * 规矩：只收"像样"的条目 —— key 得是 uuid 形态、值得是短字符串。
 * prefs 是用户能手改的文件，读的时候不能假设它干净。
 */
export function parseFriendNotes(raw: unknown): FriendNotes {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: FriendNotes = {};
  let n = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= FRIEND_NOTES_MAX) break;
    if (!looksLikeProfileId(k)) continue;
    if (typeof v !== 'string') continue;
    const text = v.trim().slice(0, FRIEND_NOTE_MAX);
    if (!text) continue;
    out[k.toLowerCase()] = text;
    n += 1;
  }
  return out;
}

/** 写/清一条备注。**空文本 = 删掉这一条**（不是存一个空串） */
export function setFriendNote(notes: FriendNotes, profileId: string, raw: string): FriendNotes {
  if (!looksLikeProfileId(profileId)) return notes;
  const key = profileId.toLowerCase();
  const text = raw.trim().slice(0, FRIEND_NOTE_MAX);
  const next: FriendNotes = { ...notes };
  if (!text) delete next[key];
  else next[key] = text;
  return next;
}

/** 取一条备注（大小写无关；没有就 `undefined`） */
export function noteOf(notes: FriendNotes, profileId: string): string | undefined {
  if (!looksLikeProfileId(profileId)) return undefined;
  return notes[profileId.toLowerCase()];
}

/**
 * 界面上显示什么名字。
 *
 * ★ 备注**优先**（那是用户自己给它起的称呼），但**不隐藏**真实玩家名 ——
 *   只在有备注时在后面补一个括号。PCL 那种"备注盖掉原名"的做法会让人
 *   认不出哪个是哪个（尤其是备注写着"同学"的时候）。
 */
export function displayNameOf(name: string, profileId: string, notes: FriendNotes): string {
  const real = name.trim() || `${profileId.slice(0, 8)}…`;
  const note = noteOf(notes, profileId);
  return note ? `${note}（${real}）` : real;
}

/** 头像里那个字：名字（优先备注）的第一个字符，拿不到就用 `?` */
export function friendInitial(name: string): string {
  const c = [...name.trim()][0];
  return c ? c.toUpperCase() : '?';
}

/**
 * 在线状态归成"显示语气"（决定用哪种颜色的 Chip）。
 *
 * ★ `unknown`（拿不到状态）**必须与"离线"分开**：服务端没告诉我们的时候，
 *   说人家"离线"就是在编。
 */
export function presenceTone(status: string | null | undefined): 'success' | 'info' | 'neutral' | 'warning' {
  switch (status) {
    case 'ONLINE':
      return 'success';
    case 'PLAYING_OFFLINE':
    case 'PLAYING_REALMS':
    case 'PLAYING_SERVER':
    case 'PLAYING_HOSTED_SERVER':
      return 'info';
    case 'OFFLINE':
      return 'neutral';
    default:
      return 'warning'; // 未知
  }
}

/**
 * ★★★★ 一条好友**该显示什么状态**（2026-10-12，用户给出的判据是游戏里的截图）。
 *
 *   游戏客户端那 9 位好友**全都显示「离线」**，而我们原来把他们显示成「未知」——
 *   差别在于"看不见"到底该解释成什么：
 *
 *     · 在场列表**成功拿到过**（`presenceKnown`）⇒ 不在列表里的就是**离线**。
 *       客户端的在场列表里只会有"有状态的人"，不在里面等于没有状态可报
 *       —— 游戏自己就是这么显示的。
 *     · 列表**从没拿到过 / 上一次心跳失败** ⇒ 才是 `null`（界面写「未知」）：
 *       那时候我们确实什么都不知道，写成"离线"就是编。
 *
 *   ★ 这条规则只放一处（这里），界面与排序都从它取结论 —— 两边各写一套迟早打架。
 *
 * ★★★★ 2026-10-17 修正（用户：「**我的朋友游戏在线，但启动器读不到**」——
 *   好友页 10 个人全显示「离线」）。
 *
 *   判据（`friends.rs` 头部那段实测记录）：`POST /presence` 的回包
 *   `{presence:[…]}` **就是"谁在线"这份名单**（当时 0 条 ⇒ "好友都不在线"），
 *   `GET /friends` 那份名单**不含在线状态**。⇒
 *
 *     · **一行在名单里** = 这个人在线；`status` 只说明他*在干什么*。
 *     · 所以"这一行没带 status"（值为 `null`）**不是缺席**，而是"在线，但不知道他在干什么"。
 *
 *   旧实现写的是 `const hit = presence[id]; if (hit) return hit;` —— 拿**值的真假**
 *   当"在不在名单里"用。服务端只要给一行只有 `profileId` 的记录，那个人就被判成
 *   "不在名单里"，再被 `presenceKnown` 说成**离线**。这就是那个 bug 的形状：
 *   **把不知道说成了离线**。
 *
 *   ⇒ 现在**键在不在**才是"在不在名单里"（`presenceOf` 是这层判断的唯一一份），
 *     值缺失时回落到 [`PRESENCE_WITHOUT_STATUS`]（"在线"那一档）。
 */
export const PRESENCE_WITHOUT_STATUS = 'ONLINE';

/**
 * 只看**这一行自己说了什么**（不带"名单拿没拿到"的知识）：
 *
 *   · 键不在 map 里 ⇒ `undefined`（= 服务端没提这个人）
 *   · 键在、值有内容 ⇒ 就用那个值
 *   · 键在、值缺失（`null` / 空串）⇒ `'ONLINE'`（在名单里 = 在线，只是不知道在干什么）
 *
 * ★ 用 `hasOwnProperty` 而不是 `presence[key] !== undefined`：跟 `__proto__` /
 *   `constructor` 这种名字撞上时，也不许把原型链上的东西当成"他在线"。
 */
export function presenceOf(
  presence: Readonly<Record<string, string | null | undefined>>,
  profileId: string,
): string | undefined {
  const key = profileId.toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(presence, key)) return undefined;
  return presence[key] || PRESENCE_WITHOUT_STATUS;
}

export function resolvePresence(
  presence: Readonly<Record<string, string | null | undefined>>,
  presenceKnown: boolean,
  profileId: string,
): string | null {
  const hit = presenceOf(presence, profileId);
  if (hit) return hit;
  return presenceKnown ? 'OFFLINE' : null;
}

/**
 * 在线状态的先后顺序（列表排序用）：
 * 在玩世界 > 在线 > 未知 > 离线。同档保持服务端给的顺序。
 */
export function presenceRank(status: string | null | undefined): number {
  switch (status) {
    case 'PLAYING_HOSTED_SERVER':
    case 'PLAYING_SERVER':
    case 'PLAYING_REALMS':
    case 'PLAYING_OFFLINE':
      return 0;
    case 'ONLINE':
      return 1;
    case 'OFFLINE':
      return 3;
    default:
      return 2; // 未知
  }
}

/** 把一组条目按状态排一下（稳定排序：同档保持原顺序） */
export function sortByPresence<T extends { profileId: string }>(
  rows: readonly T[],
  presence: Readonly<Record<string, string | null | undefined>>,
): T[] {
  return rows
    /* ★ 与显示走**同一个** `presenceOf`：名单里那行（哪怕没带 status）是"在线"档，
       不许在排序里被当成"未知"（同一件事两套判据，界面与顺序会打架） */
    .map((r, i) => ({ r, i, rank: presenceRank(presenceOf(presence, r.profileId)) }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.r);
}

/* ====================== 一次心跳该得出什么（2026-10-17） ======================
 *
 * ★★★★ 用户：「**我的朋友游戏在线，但启动器读不到**」——好友页 10 个人全显示「离线」。
 *
 *   这条链上有三处"把不知道说成离线"，上面 `resolvePresence` 是第一处，
 *   这里是第二、三处（都在 `AppContext.refreshFriends` 里）：
 *
 *     ① `friendsApi.presence(...).catch(() => [])`：请求**失败**时捏造一个空数组。
 *        空数组的语义是"我问过了、没人在线"——于是全员离线。
 *     ② 紧接着 `patch.presenceAt = Date.now()`：把"未知"盖章成"已知"，
 *        之后 `resolvePresence` 再也不会回落到 `null`（未知）。
 *
 *   ## 为什么抽成纯函数
 *
 *   "这一次心跳该得出什么"是**判据**（失败 / 304 / 成功三种结果各自意味着什么），
 *   而它原来散在 `refreshFriends` 与心跳那个 `useEffect` 两处 async 代码里 ——
 *   两边各写一遍，判据就会分叉（这个仓库吃过太多次这种亏）。
 *   抽出来之后它有判据（`tests/friends.test.mjs` 三条用例），也不再需要网络就能验。
 *
 *   ★ 三种结果的区别**一个字都不能含糊**：
 *     · `ok`（200）        ⇒ 这一份名单就是全部真相：**整份替换**（没在名单里的才是离线）
 *     · `notModified`（304）⇒ 服务端说"没变" ⇒ 沿用旧 map，**可以**刷 `presenceAt`
 *                              （它确认了我们手上这份是最新的）
 *     · `failed`           ⇒ **什么都不许改**：保住旧 map、**不许**动 `presenceAt`、
 *                              并且把这次失败**露出来**（`presenceError`）——
 *                              "不知道"就是"不知道"，不许伪装成"没人在线"
 */

/** 一条在场记录里我们真正用到的东西（形状与后端 `friends::PresenceRow` 一致） */
export interface PresenceRowLike {
  profileId: string;
  status?: string | null;
}

/**
 * 在场表：`profileId`（小写）→ 服务端报过的状态。
 *
 * ★ 值是**字符串**而不是那几个取值的联合类型：这一层不做 wire 校验
 *   （认不出来的值由 `presenceTone` 当"未知"显示），而"这个人在不在表里"
 *   才是判断在线/离线的唯一依据（见 `presenceOf`）。
 *   `null` = 服务端把他列进了在场名单，但这一行没带 status ⇒ **在线**。
 */
export type PresenceMap = Record<string, string | null>;

/** 一次心跳的结果。★ 三种，没有第四种（"失败"不许退化成"空名单"） */
export type PresenceBeat =
  | { kind: 'ok'; rows: readonly PresenceRowLike[] }
  | { kind: 'notModified' }
  | { kind: 'failed'; reason: string };

/** 心跳要读/写的三样状态（`state.friends` 里与在场有关的那三个字段） */
export interface PresenceBeatState {
  /** profileId（小写）→ 状态；`null` = 在名单里但这一行没带 status */
  presence: Readonly<PresenceMap>;
  /** 上一次**成功**拿到在场列表的时刻（null = 从没成功过） */
  presenceAt: number | null;
  /** 最近一次心跳失败的原因（`null` = 没失败） */
  presenceError: string | null;
}

/** 把一次 200 的名单摊成 map。★ 服务端说他在名单里，哪怕没带 status 也要留一行（值 `null`） */
export function presenceMapOf(rows: readonly PresenceRowLike[]): PresenceMap {
  const out: PresenceMap = {};
  for (const row of rows) {
    /* 坏行（没有 profileId）跳过 —— 一条读不懂的记录不该把整份名单搞没 */
    if (!row || typeof row.profileId !== 'string' || row.profileId === '') continue;
    out[row.profileId.toLowerCase()] = row.status ?? null;
  }
  return out;
}

/**
 * 一次心跳的结果 → 新的三样状态。**纯函数**（`now` 由调用方给，便于判据）。
 */
export function applyPresenceBeat(
  prev: PresenceBeatState,
  beat: PresenceBeat,
  now: number,
): PresenceBeatState {
  switch (beat.kind) {
    case 'ok':
      return { presence: presenceMapOf(beat.rows), presenceAt: now, presenceError: null };
    case 'notModified':
      /* 服务端说没变 ⇒ 旧 map 就是最新的一份，但"什么时候确认的"要更新 */
      return { presence: prev.presence, presenceAt: now, presenceError: null };
    case 'failed':
      /* ★★ 失败**只**记错误：map 与 presenceAt 一律不动（不知道就是不知道） */
      return { presence: prev.presence, presenceAt: prev.presenceAt, presenceError: beat.reason };
  }
}

/* ====================== 轮询频率（2026-10-12，用户给的设计图） ======================
 *
 * 设计图原话：「好友列表的更新频率是**动态调整**的，以平衡实时性和性能：
 *   · 好友列表**打开时**：每**分钟**检查一次更新；
 *   · 好友列表**未打开时**：每 **5 分钟**检查一次更新。」
 *
 * ★ 数字写在这里、只有这一处，并且**有判据**：这两个常量会被界面与心跳共用，
 *   两边各写一个 60000/300000 迟早会分叉（这个仓库吃过太多次这种亏）。
 */

/** 好友列表打开时的轮询间隔：1 分钟 */
export const FRIENDS_POLL_OPEN_MS = 60_000;
/** 好友列表没打开时的轮询间隔：5 分钟 */
export const FRIENDS_POLL_CLOSED_MS = 300_000;

/** 名单该多久检查一次更新（按设计图：打开 1 分钟 / 关着 5 分钟） */
export function friendsPollIntervalMs(pageOpen: boolean): number {
  return pageOpen ? FRIENDS_POLL_OPEN_MS : FRIENDS_POLL_CLOSED_MS;
}

/**
 * 在场心跳的间隔。
 *
 * ★ 设计图只规定了**名单**的频率，而心跳是另一件事：它同时承担"让好友看到我在线"
 *   的职责（见 AppContext 的说明），所以不能跟着名单一起降到 5 分钟 ——
 *   那样关掉好友页之后，好友在游戏里会以为你掉线了。
 *   这里沿用同一个思路（打开时紧、关着时松），数字是自己的：30 秒 / 90 秒。
 */
export const PRESENCE_BEAT_OPEN_MS = 30_000;
export const PRESENCE_BEAT_CLOSED_MS = 90_000;

export function presenceBeatIntervalMs(pageOpen: boolean): number {
  return pageOpen ? PRESENCE_BEAT_OPEN_MS : PRESENCE_BEAT_CLOSED_MS;
}