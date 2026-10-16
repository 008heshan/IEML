/**
 * 好友页（**接上真服务**，2026-10-12）
 * ==================================================================
 *
 * ## 这一版是什么
 *
 *   用户 2026-10-12 给了两个地址：
 *     · `https://api.minecraftservices.com`（REST）
 *     · `wss://signaling-afd.franchise.minecraft-services.net/ws`（信令，本版没用到）
 *   并要求"实现好友系统的各种功能，目前只做正版登录的范围内"。
 *
 *   选定的范围是 **B**：名单 + 加/删/同意/拒绝 + 隐私设置 + **真在线状态**
 *   （周期性 `POST /presence`：上报自己在线的同时拿回好友们的状态）。
 *   端点表与"哪几条真机验证过"写在 `src-tauri/src/friends.rs` 头部。
 *
 * ## 三条不肯妥协的地方
 *
 *   ① **在线状态拿不到就写"未知"**，绝不写成"离线"（服务端没说是另一回事）；
 *   ② 服务端说错了什么就**照原样显示**（页面顶部那条错误里带 HTTP 状态码
 *      与服务端原话）—— 用户要据此判断"是不是得重新登录"；
 *   ③ 每一次操作**都允许失败**：失败弹错误、错误留在页面上，不假装成功。
 *
 * ## 风格
 *
 *   全部用 `ui/` 里既有的组件；行的悬浮反馈沿用版本列表那一套
 *   （`data-hover` + 行首 2px 强调色竖条，`.friend-item` 已登记进那份清单）。
 */
import { useEffect, useMemo, useState } from 'react';
import { Button, Card, CardTitle, Chip, EmptyState, Modal, Note, SearchBox, Segmented, Skeleton } from '../ui';
import {
  IconCheck,
  IconClose,
  IconLayers,
  IconPencil,
  IconRefresh,
  IconTrash,
  IconUserPlus,
  IconUsers,
} from '../ui/Icons';
import { useApp } from '../state/AppContext';
import {
  displayNameOf,
  friendInitial,
  presenceTone,
  resolvePresence,
  sortByPresence,
  type FriendNotes,
} from '../domain/friends.ts';
/* ★ 头像：按 uuid 查 Mojang 的皮肤（sessionserver），与账号菜单同一个组件 */
import { SkinHead } from '../components/SkinHead';
import { getRealApi } from '../bridge';
import type { FriendEntry, PresenceStatus, Toggle } from '../bridge/tauri';

/**
 * 状态 → 中文。★★ **用户看到的措辞只有两份，都在前端**：这里（中文）与
 * `domain/friends.ts::presenceTone`（颜色档）。
 *
 *   ★ 2026-10-17：这里原来写着"与后端保持同一套说法"，而 Rust 那一份**已经删掉**
 *     了 —— 用户能看到的措辞只能有**一处**说法，留两份迟早漂移
 *     （同一个状态两种写法，正是这个 bug 的形式之一）。
 *     现在 Rust 侧只说"这一行还在/没带 status"，一个字的中文标签都不出。
 */
function presenceText(status: PresenceStatus | string | null | undefined): string {
  switch (status) {
    case 'ONLINE':
      return '在线';
    case 'PLAYING_OFFLINE':
      return '在玩单机';
    case 'PLAYING_REALMS':
      return '在玩 Realms';
    case 'PLAYING_SERVER':
      return '在服务器里';
    case 'PLAYING_HOSTED_SERVER':
      return '开放了他的世界';
    case 'OFFLINE':
      return '离线';
    default:
      return '未知';
  }
}

/* ====================== 好友头像（2026-10-12） ======================
 *
 * 用户给的游戏截图里每位好友都有**皮肤头像**。做法与账号菜单一致：
 * 按 uuid 向 Mojang 的 sessionserver 要一份档案，从里面取 `textures` 的皮肤地址，
 * 交给 `SkinHead` 去裁（头部 + 帽子两层，坐标只有那一份实现）。
 *
 * ★ 三件必须做的事，否则这个功能会变成"每次进页面打 9 个请求"：
 *   ① **会话级缓存**（一个玩家的皮肤在一次运行里只查一次）；
 *   ② **并发限制**（同一时刻最多 2 个）—— sessionserver 是有速率限制的；
 *   ③ 查不到就**什么都不显示**（回落成首字母头像），不报错、不重试轰炸。
 */
const skinCache = new Map<string, string | null>();
const skinPending = new Map<string, Promise<string | null>>();

async function loadSkin(profileId: string): Promise<string | null> {
  const key = profileId.toLowerCase();
  if (skinCache.has(key)) return skinCache.get(key) ?? null;
  const running = skinPending.get(key);
  if (running) return running;
  const task = (async () => {
    try {
      const api = await getRealApi();
      if (!api) return null;
      const info = await api.account.skin(profileId);
      return info.skinUrl ?? null;
    } catch {
      // ★ 查不到就是没有（离线/改名/速率限制都走这里）—— 回落首字母，不打扰用户
      return null;
    } finally {
      skinPending.delete(key);
    }
  })();
  skinPending.set(key, task);
  const url = await task;
  skinCache.set(key, url);
  return url;
}

/** 给一批 profileId 取头像 URL（并发 2；结果进 state 触发重渲染） */
function useFriendSkins(ids: readonly string[]): Record<string, string | null> {
  const [skins, setSkins] = useState<Record<string, string | null>>(() => {
    const init: Record<string, string | null> = {};
    for (const id of ids) {
      const k = id.toLowerCase();
      if (skinCache.has(k)) init[k] = skinCache.get(k) ?? null;
    }
    return init;
  });

  const key = ids.join(',');
  useEffect(() => {
    let alive = true;
    const queue = ids.filter((id) => !skinCache.has(id.toLowerCase()));
    if (queue.length === 0) return;
    void (async () => {
      const CONCURRENCY = 2;
      let cursor = 0;
      const worker = async () => {
        for (;;) {
          const next = queue[cursor++];
          if (next === undefined) return;
          const url = await loadSkin(next);
          if (!alive) return;
          setSkins((prev) => ({ ...prev, [next.toLowerCase()]: url }));
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return skins;
}

export function FriendsPage() {
  const {
    state,
    go,
    addFriendByName,
    removeFriend,
    acceptFriend,
    declineFriend,
    revokeFriendRequest,
    refreshFriends,
    loadFriendSettings,
    saveFriendSettings,
    setFriendNote,
    setFriendsPageOpen,
  } = useApp();

  /*
   * ★ 告诉上下文"这一页开着"（2026-10-12，用户给的设计图）：
   *   名单的检查频率按它切 —— 打开时每分钟、关着时每 5 分钟。
   *   卸载时置回 false，别让页面走了还按高频轮询。
   */
  useEffect(() => {
    setFriendsPageOpen(true);
    return () => setFriendsPageOpen(false);
  }, [setFriendsPageOpen]);

  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [noteTarget, setNoteTarget] = useState<FriendEntry | null>(null);
  const [noteDraft, setNoteDraft] = useState('');

  const premium = state.prefs.accountUuid !== null;
  const notes: FriendNotes = state.prefs.friendNotes;
  const snap = state.friends.snapshot;
  const presence = state.friends.presence;
  const loading = state.friends.loading;
  const error = state.friends.error;

  /** 过滤（名字或备注），再按在线状态排一次 */
  const friends = useMemo(() => {
    const list = snap?.friends ?? [];
    const q = query.trim().toLowerCase();
    const filtered = q
      ? list.filter(
          (f) =>
            f.name.toLowerCase().includes(q) ||
            (notes[f.profileId.toLowerCase()] ?? '').toLowerCase().includes(q),
        )
      : list;
    return sortByPresence(filtered, presence);
  }, [snap, query, notes, presence]);

  const incoming = snap?.incomingRequests ?? [];
  const outgoing = snap?.outgoingRequests ?? [];

  /*
   * ★ 头像：给名单里的每个人查一次皮肤（有缓存、限并发）。
   *   请求的 id 列表用 `friends` 的 profileId（与后端口径一致：32 位 hex）。
   */
  const skins = useFriendSkins(useMemo(() => friends.map((f) => f.profileId), [friends]));

  /*
   * ★★ 状态口径与**游戏客户端一致**（用户 2026-10-12 的截图是判据）：
   *   在场列表成功拿到过 ⇒ 不在列表里就是「离线」；从没拿到过才是「未知」。
   *   规则本身在 `domain/friends.ts` 的 `resolvePresence`（那边有用例）。
   */
  const presenceKnown = state.friends.presenceAt !== null;
  const presenceAt = state.friends.presenceAt;
  const presenceError = state.friends.presenceError;

  const run = async (key: string, fn: () => Promise<boolean>) => {
    setBusy(key);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  const submitAdd = () => {
    const name = draft.trim();
    if (!name) return;
    void run('add', async () => {
      const ok = await addFriendByName(name);
      if (ok) setDraft('');
      return ok;
    });
  };

  /* ---------- 不是正版：说清楚，并给一条能走的路 ---------- */
  if (!premium) {
    return (
      <>
        <div className="page-head">
          <div>
            <h1 className="page-title">好友</h1>
            <p className="page-desc">好友服务只对正版账号开放</p>
          </div>
        </div>
        <Note tone="info" title="好友功能要正版登录">
          好友名单、在线状态、加人删人这些都是 Minecraft 官方服务提供的，
          只有登录了正版账号才拿得到。离线模式能正常玩单机，但用不了这一页。
        </Note>
        <div className="stack">
          <EmptyState
            icon={<IconUsers />}
            title="现在是离线模式"
            desc="到「设置 → 账号」登录一次正版账号，回来这里就有你的好友了。"
            actions={
              <Button variant="primary" onClick={() => go('settings')}>
                <IconLayers /> 去设置里登录
              </Button>
            }
          />
        </div>
      </>
    );
  }

  /* ---------- 正版：真名单 ---------- */
  const row = (f: FriendEntry, kind: 'friend' | 'incoming' | 'outgoing') => {
    const pid = f.profileId.toLowerCase();
    const st = resolvePresence(presence, presenceKnown, f.profileId);
    const shown = displayNameOf(f.name, f.profileId, notes);
    const key = `${kind}:${pid}`;
    const skin = skins[pid] ?? null;
    return (
      <div className="friend-item" key={key} data-friend-id={f.profileId}>
        {/*
          ★ 有皮肤就用真头像（与账号菜单同一个 SkinHead，头部+帽子两层）；
            查不到就回落成首字母方块 —— 不显示一个空白圆圈。
        */}
        {skin ? (
          <SkinHead url={skin} size={32} className="friend-skin" />
        ) : (
          <span className="friend-avatar" aria-hidden="true">
            {friendInitial(notes[pid] ?? f.name)}
          </span>
        )}
        <div className="friend-main">
          <div className="friend-name truncate">{shown}</div>
          <div className="friend-meta">
            {kind === 'friend' ? (
              /*
               * ★ 拿不到状态 ⇒ 「未知」（warning 色），**不是**「离线」。
               *   这是这一页最重要的诚实之处：服务端没告诉我们的时候，
               *   说人家离线就是在编。
               */
              <Chip tone={presenceTone(st)}>{presenceText(st)}</Chip>
            ) : (
              <span className="dim">{kind === 'incoming' ? '想加你' : '等你同意'}</span>
            )}
          </div>
        </div>
        <div className="friend-actions">
          {kind === 'friend' ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                iconOnly
                aria-label={`给 ${f.name} 写备注`}
                onClick={() => {
                  setNoteTarget(f);
                  setNoteDraft(notes[pid] ?? '');
                }}
              >
                <IconPencil />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                iconOnly
                aria-label={`把 ${f.name} 从好友里删掉`}
                disabled={busy === key}
                loading={busy === key}
                onClick={() => void run(key, () => removeFriend(f.profileId, f.name))}
              >
                <IconTrash />
              </Button>
            </>
          ) : kind === 'incoming' ? (
            <>
              <Button
                size="sm"
                variant="primary"
                disabled={busy === key}
                loading={busy === key}
                onClick={() => void run(key, () => acceptFriend(f.profileId, f.name))}
              >
                <IconCheck /> 同意
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy === key}
                onClick={() => void run(key, () => declineFriend(f.profileId, f.name))}
              >
                <IconClose /> 拒绝
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy === key}
              loading={busy === key}
              onClick={() => void run(key, () => revokeFriendRequest(f.profileId, f.name))}
            >
              撤销
            </Button>
          )}
        </div>
      </div>
    );
  };

  const toggleOptions = [
    { value: 'ENABLED' as Toggle, label: '允许' },
    { value: 'DISABLED' as Toggle, label: '不允许' },
  ];

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">好友</h1>
          <p className="page-desc">
            {snap
              ? `${snap.friends.length} 位好友 · 收到 ${incoming.length} 个请求 · 发出 ${outgoing.length} 个`
              : '正在取名单…'}

          </p>
        </div>
        <div className="page-actions">
          {snap && snap.friends.length > 0 ? (
            <SearchBox value={query} onChange={setQuery} placeholder="搜名字或备注…" label="搜索好友" />
          ) : null}
          <Button variant="secondary" loading={loading} onClick={() => void refreshFriends()}>
            <IconRefresh /> 刷新
          </Button>
        </div>
      </div>

      {/*
        ★ 错误**留在页面上**（带服务端原话与状态码）—— 不只弹个 toast 就没了。
          用户要照着它判断"是不是得重新登录一次"。
      */}
      {error ? (
        <Note tone="warning" title="好友服务这次没成">
          {error}
        </Note>
      ) : null}

      {/*
        ★★★★ 2026-10-17（用户：「**我的朋友游戏在线，但启动器读不到**」——好友页
          10 个人全显示「离线」）。

          原来这里**没有**这一行：在场状态那一路失败时被悄悄当成"没人在线"
          （`catch(() => [])` + 无条件刷 `presenceAt`），于是十个好友全被判成离线，
          而页面上一个字都不说。现在失败**必须露出来** —— 用户要能分清
          「他们真的都离线」与「我们没拿到状态」这两件事。

          ★ 措辞里刻意点明"下面可能过时"：`presenceAt` 没被刷，所以缺席的人
            仍然显示上一次的结论（多半是「离线」）。不说这一句，用户会以为
            刚拿到的就是最新的。
      */}
      {presenceError ? (
        <Note tone="info" title="在线状态没拿到">
          {presenceError}
          {presenceAt
            ? '（下面那几行的状态还是上一次拿到的，可能已经过时；下一次心跳会再试）'
            : '（还没成功拿到过在场名单，所以状态栏写的是「未知」—— 那不是「离线」）'}
        </Note>
      ) : null}

      <div className="stack">
        {/* ---------- 加好友 ---------- */}
        <Card>
          <CardTitle icon={<IconUserPlus />} hint="按正版玩家名查找，名字区分大小写">
            加好友
          </CardTitle>
          <div className="friend-add">
            <input
              className="input"
              value={draft}
              maxLength={32}
              placeholder="他的正版玩家名"
              aria-label="要加的正版玩家名"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitAdd();
              }}
            />
            <Button
              variant="primary"
              disabled={draft.trim() === '' || busy === 'add'}
              loading={busy === 'add'}
              onClick={submitAdd}
            >
              <IconUserPlus /> 发好友请求
            </Button>
          </div>

        </Card>

        {/* ---------- 请求（**一直在**，见下面那段说明）---------- */}
        <Card>
          <CardTitle
            icon={<IconUsers />}
            hint={
              incoming.length + outgoing.length > 0
                ? `收到 ${incoming.length} · 发出 ${outgoing.length}`
                : '现在没有待处理的'
            }
          >
            好友请求
          </CardTitle>
          {/*
            ★★★★ 2026-10-12（用户：「**好友添加请求在哪里看**」）。

              原来这两块是"有请求才渲染"的 —— 而他的账号当时是 0 收到 / 0 发出，
              于是**页面上一个字都没有**，功能等于不存在。
              ⇒ 现在**请求区一直在**：没有的时候也要说一句"暂时没有"，
                否则用户不知道是"没有请求"还是"没做这个功能"。

              ★ 顺带在侧栏「好友」上挂了收到请求的数量角标（有人加你时进不进这一页都能看见）。
          */}
          <div className="friend-list friend-list-flat">
            <div className="friend-group">
              <span>收到的请求</span>
              <span className="dim">{incoming.length}</span>
            </div>
            {incoming.length > 0 ? incoming.map((f) => row(f, 'incoming')) : null}
            <div className="friend-group">
              <span>我发出的请求</span>
              <span className="dim">{outgoing.length}</span>
            </div>
            {outgoing.length > 0 ? outgoing.map((f) => row(f, 'outgoing')) : null}
          </div>
        </Card>

        {/* ---------- 名单 ---------- */}
        {loading && !snap ? (
          <Skeleton rows={4} height={52} />
        ) : friends.length === 0 ? (
          <EmptyState
            icon={<IconUsers />}
            title={snap ? '名单里还没有人' : '还没拿到名单'}
            desc={
              snap
                ? '把对方的正版玩家名填上面那一栏，发个请求试试。'
                : '点右上角「刷新」再取一次；如果一直失败，上面那条错误里写着原因。'
            }
          />
        ) : (
          <div className="card friend-list">{friends.map((f) => row(f, 'friend'))}</div>
        )}

        {/* ---------- 隐私设置 ---------- */}
        <Card>
          {/*
            ★ 2026-10-12（用户：「图六这个标题得改一下」）：
              原标题「谁能加我」只覆盖了第一行；这张卡片里其实是**两件事** ——
              谁能加我、谁能邀请我。标题按内容改全。
          */}
          <CardTitle icon={<IconLayers />} hint="这些会同步到你的微软账号，游戏里也生效">
            谁能加我、谁能邀请我
          </CardTitle>
          <div className="friend-settings">
            <div className="friend-setting-row">
              <span>允许别人给我发好友请求</span>
              <Segmented
                label="谁能给我发好友请求"
                size="sm"
                value={state.friends.settings?.friends ?? 'ENABLED'}
                options={toggleOptions}
                onChange={(v) =>
                  void saveFriendSettings(
                    v as Toggle,
                    state.friends.settings?.acceptInvites ?? 'ENABLED',
                  )
                }
              />
            </div>
            <div className="friend-setting-row">
              <span>允许好友邀请我进他的世界</span>
              <Segmented
                label="谁能邀请我"
                size="sm"
                value={state.friends.settings?.acceptInvites ?? 'ENABLED'}
                options={toggleOptions}
                onChange={(v) =>
                  void saveFriendSettings(state.friends.settings?.friends ?? 'ENABLED', v as Toggle)
                }
              />
            </div>
            {!state.friends.settings ? (
              <p className="friend-hint">
                ★ 还没读到设置（可能刚才那次调用失败了）。
                <Button size="sm" variant="ghost" onClick={() => void loadFriendSettings()}>
                  再读一次
                </Button>
              </p>
            ) : null}
          </div>
        </Card>


      </div>

      {/* ---------- 备注弹窗（本机，不打扰对方） ---------- */}
      <Modal
        open={noteTarget !== null}
        onClose={() => setNoteTarget(null)}
        title={noteTarget ? `给 ${noteTarget.name} 写个备注` : '备注'}
        subtitle="只存在你这台机器上，对方看不到。"
        footer={
          <>
            <Button variant="secondary" onClick={() => setNoteTarget(null)}>
              取消
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                if (noteTarget) setFriendNote(noteTarget.profileId, noteDraft);
                setNoteTarget(null);
              }}
            >
              保存
            </Button>
          </>
        }
      >
        <input
          className="input"
          autoFocus
          maxLength={24}
          value={noteDraft}
          placeholder="比如：班里那个"
          aria-label="备注"
          onChange={(e) => setNoteDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            if (noteTarget) setFriendNote(noteTarget.profileId, noteDraft);
            setNoteTarget(null);
          }}
        />
      </Modal>
    </>
  );
}
