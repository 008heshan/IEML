/**
 * 好友的**本机部分**判据（`src/domain/friends.ts`）。
 *
 * 为什么必须有用例：全是"错了不会报错、只会慢慢变脏"的那一类 ——
 * 备注写串了人、脏 prefs 把界面搞坏、拿不到在线状态时把人家写成"离线"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPresenceBeat,
  displayNameOf,
  friendInitial,
  looksLikeProfileId,
  noteOf,
  parseFriendNotes,
  presenceRank,
  friendsPollIntervalMs,
  presenceBeatIntervalMs,
  FRIENDS_POLL_OPEN_MS,
  FRIENDS_POLL_CLOSED_MS,
  resolvePresence,
  presenceTone,
  setFriendNote,
  sortByPresence,
  FRIEND_NOTE_MAX,
} from '../src/domain/friends.ts';

const A = '0123456789abcdef0123456789abcdef';
const B = 'fedcba9876543210fedcba9876543210';

test('写一条备注、读回来；键统一成小写（uuid 大小写无关）', () => {
  const notes = setFriendNote({}, A.toUpperCase(), '  班里那个  ');
  assert.equal(noteOf(notes, A.toLowerCase()), '班里那个');
  assert.equal(Object.keys(notes)[0], A.toLowerCase());
});

test('★ 空备注 = 删掉这一条（不是存一个空串）', () => {
  let notes = setFriendNote({}, A, '同学');
  assert.ok(noteOf(notes, A));
  notes = setFriendNote(notes, A, '   ');
  assert.equal(noteOf(notes, A), undefined);
  assert.deepEqual(notes, {}, '删干净，不留空串');
});

test('备注超长被砍到上限（界面不会被一行字撑坏）', () => {
  const notes = setFriendNote({}, A, 'x'.repeat(99));
  assert.equal(noteOf(notes, A)?.length, FRIEND_NOTE_MAX);
});

test('不是 uuid 的键写了也白写（不许把任意字符串塞进备注表）', () => {
  const notes = setFriendNote({}, 'not-a-uuid', 'x');
  assert.deepEqual(notes, {});
  assert.equal(noteOf({ [A]: 'y' }, 'nope'), undefined);
  assert.equal(looksLikeProfileId(A), true);
  assert.equal(looksLikeProfileId('01234567-89ab-cdef-0123-456789abcdef'), true);
  assert.equal(looksLikeProfileId('short'), false);
  assert.equal(looksLikeProfileId(null), false);
});

test('从脏 prefs 里读回来：只收 uuid 键 + 短字符串值', () => {
  const parsed = parseFriendNotes({
    [A]: 'Steve 的同学',
    [B]: '   ',
    'not-a-uuid': 'x',
    [A.slice(0, 8)]: 'y', // 太短，不是 uuid
    [B.toUpperCase()]: '大写键也要认',
  });
  assert.deepEqual(Object.keys(parsed).sort(), [A, B].sort());
  assert.equal(parsed[B], '大写键也要认');
});

test('prefs 里不是对象（或压根没有）时返回空表，不炸', () => {
  for (const raw of [undefined, null, {}, [], 'x', 42, true]) {
    assert.deepEqual(parseFriendNotes(raw), {});
  }
});

test('★ 显示名：有备注时备注在前、真名用括号带着；没有就只显示真名', () => {
  const notes = setFriendNote({}, A, '同学');
  assert.equal(displayNameOf('Steve', A, notes), '同学（Steve）');
  assert.equal(displayNameOf('Steve', B, notes), 'Steve');
  // 名字空着的时候用 uuid 前 8 位顶上（别显示一个空白行）
  assert.equal(displayNameOf('', B, notes), 'fedcba98…');
});

test('头像那个字：取首字符并大写，空名字落回 ?', () => {
  assert.equal(friendInitial('steve'), 'S');
  assert.equal(friendInitial('  张三 '), '张');
  assert.equal(friendInitial(''), '?');
});

test('★ 拿不到在线状态时是"未知"（warning），**不是离线**', () => {
  assert.equal(presenceTone('ONLINE'), 'success');
  assert.equal(presenceTone('PLAYING_SERVER'), 'info');
  assert.equal(presenceTone('OFFLINE'), 'neutral');
  assert.equal(presenceTone(undefined), 'warning', '没状态 ⇒ 未知，不许写成离线');
  assert.equal(presenceTone(null), 'warning');
  assert.equal(presenceTone('SOMETHING_NEW'), 'warning', '服务端将来加了新值也当未知');
});

test('排序：在玩世界 > 在线 > 未知 > 离线，同档保持原顺序', () => {
  const rows = [
    { profileId: A, tag: 'offline' },
    { profileId: B, tag: 'unknown' },
    { profileId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', tag: 'playing' },
    { profileId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', tag: 'online' },
  ];
  const presence = {
    [A]: 'OFFLINE',
    aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: 'PLAYING_SERVER',
    bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb: 'ONLINE',
    // B 故意不给 ⇒ 未知
  };
  const sorted = sortByPresence(rows, presence);
  assert.deepEqual(
    sorted.map((r) => r.tag),
    ['playing', 'online', 'unknown', 'offline'],
  );
  assert.equal(presenceRank('PLAYING_HOSTED_SERVER'), 0);
  assert.equal(presenceRank(undefined), 2);
});

test('★★ 状态口径与游戏一致：在场列表拿到了，不在里面就是"离线"', () => {
  const presence = { [A]: 'PLAYING_SERVER' };
  // ① 列表拿到过 ⇒ 查得到就按它说的
  assert.equal(resolvePresence(presence, true, A), 'PLAYING_SERVER');
  // ② 列表拿到过、但这个人不在里面 ⇒ **离线**（游戏里那 9 位就是这么显示的）
  assert.equal(resolvePresence(presence, true, B), 'OFFLINE');
  // ③ 列表**没拿到过** ⇒ 未知（null）——不许把"不知道"写成"离线"
  assert.equal(resolvePresence(presence, false, B), null);
  assert.equal(resolvePresence({}, false, A), null);
  // ④ 列表拿到过、但是空的（好友都不在线）⇒ 全体离线
  assert.equal(resolvePresence({}, true, A), 'OFFLINE');
});

test('状态口径：显式给了 OFFLINE 的人也按 OFFLINE 显示（与"缺席"同一个结论）', () => {
  assert.equal(resolvePresence({ [A]: 'OFFLINE' }, true, A), 'OFFLINE');
});

/**
 * ★★★★ 2026-10-17（用户：「**我的朋友游戏在线，但启动器读不到**」——好友页 10 个人全显示离线）。
 *
 *   `POST /presence` 的回包 `{presence:[…]}` 按 `friends.rs` 的实测记录就是
 *   "**谁在线**"这份名单（当时 0 条 ⇒ "好友都不在线"）。⇒ **一行在名单里** =
 *   这个人在线；`status` 只说明他*在干什么*。
 *
 *   而服务端**完全可能给一行只有 `profileId` 的记录**（这一行没带 status）。
 *   旧实现拿 `presence[id]` 的真假当"在不在名单里"，于是这种行被当成"缺席"，
 *   再被 `presenceKnown` 判成**离线** —— 用户的症状就是这个。
 */
test('★★ [回路] 在场名单里有他 ⇒ 不许显示成离线（即使这一行没带 status）', () => {
  const presence = { [A]: null };
  assert.notEqual(resolvePresence(presence, true, A), 'OFFLINE', '他在名单里 ⇒ 不许说离线');
  assert.equal(resolvePresence(presence, true, A), 'ONLINE', '没带 status 就报"在线"（不知道他在干什么）');

  // 传进来的 id 大小写无关（map 的键由 AppContext 统一小写后建）
  const UPPER = '0123456789ABCDEF0123456789ABCDEF';
  assert.equal(resolvePresence({ [UPPER.toLowerCase()]: null }, true, UPPER), 'ONLINE');
  // 空串 / undefined 这类"没带状态"的值同样是"在名单里"
  assert.equal(resolvePresence({ [A]: '' }, true, A), 'ONLINE');
  assert.equal(resolvePresence({ [A]: undefined }, true, A), 'ONLINE');

  // ★ 排序必须跟显示同一档：名单里那行算"在线"，不许算"未知"
  assert.equal(presenceRank(resolvePresence(presence, true, A)), presenceRank('ONLINE'));
  const sorted = sortByPresence(
    [
      { profileId: B, tag: '不在名单里' },
      { profileId: A, tag: '名单里但没带状态' },
    ],
    presence,
  );
  assert.deepEqual(sorted.map((r) => r.tag), ['名单里但没带状态', '不在名单里']);

  // ★ 同一份名单里**真的不在**的那个人仍然是离线（上面那条不许把这条改坏）
  assert.equal(resolvePresence(presence, true, B), 'OFFLINE');
});

/* ====================== 一次心跳该得出什么（2026-10-17） ======================
 *
 * ★★★★ 用户：「**我的朋友游戏在线，但启动器读不到**」——好友页 10 个人全显示「离线」。
 *
 *   这条链上还有两处"把不知道说成离线"，都在 `AppContext.refreshFriends` 里：
 *     · `friendsApi.presence(...).catch(() => [])` —— 请求**失败**时捏造一个空数组，
 *       而空数组的语义是"我问过了、没人在线" ⇒ 全员离线；
 *     · 紧接着 `presenceAt = Date.now()` —— 把"未知"盖章成"已知"。
 *
 *   判据现在抽在 `domain/friends.ts::applyPresenceBeat`（纯函数），三种结果各有用例。
 *   ★ 失败与 304 是**两件不同的事**：304 是服务端确认"没变"（可以刷 presenceAt），
 *     失败是"我们什么都没问到"（什么都不许动）。
 */
const PREV = { presence: { [A]: 'PLAYING_SERVER' }, presenceAt: 1000, presenceError: null };

test('★★ [心跳] 失败 ⇒ 不许捏造"没人在线"：map 与 presenceAt 都不动，错误要露出来', () => {
  const next = applyPresenceBeat(PREV, { kind: 'failed', reason: '网络断了' }, 2000);
  assert.deepEqual(next.presence, PREV.presence, '上一次的结论要保住（哪怕它是"未知"）');
  assert.equal(next.presenceAt, 1000, '★ 失败不许把"未知"盖成"已知"');
  assert.equal(next.presenceError, '网络断了', '失败要露出来，不许悄悄当成成功');
});

test('★★ [心跳] 304（服务端说没变）⇒ 沿用旧 map，但可以刷 presenceAt', () => {
  const next = applyPresenceBeat(PREV, { kind: 'notModified' }, 2000);
  assert.deepEqual(next.presence, PREV.presence, '304 沿用本地那份');
  assert.equal(next.presenceAt, 2000, '304 是"确认过没变" ⇒ 算已知');
  assert.equal(next.presenceError, null);
});

test('★★ [心跳] 200 成功 ⇒ 整份替换；没带 status 的那行由 resolvePresence 判成在线', () => {
  const C = 'cccccccccccccccccccccccccccccccc';
  const next = applyPresenceBeat(
    PREV,
    {
      kind: 'ok',
      rows: [
        { profileId: A.toUpperCase(), status: 'PLAYING_SERVER' },
        { profileId: C, status: null }, // 在名单里但没带 status ⇒ 在线（不是离线）
        { profileId: '', status: 'ONLINE' }, // 坏行：没有 id ⇒ 跳过，不许把整份名单搞没
      ],
    },
    2000,
  );
  assert.deepEqual(Object.keys(next.presence).sort(), [A, C].sort(), '整份替换（旧 map 里的人不再保留）');
  assert.equal(next.presence[A], 'PLAYING_SERVER');
  assert.equal(next.presence[C], null);
  assert.equal(resolvePresence(next.presence, true, C), 'ONLINE', '★ 名单里有他 ⇒ 在线');
  assert.equal(next.presenceAt, 2000);
  assert.equal(next.presenceError, null, '成功要把上一次的错误清掉');

  // ★ 与"请求失败"对照：服务端这一轮**真的**说没人在线（空名单）⇒ 全体离线才是对的
  const empty = applyPresenceBeat(PREV, { kind: 'ok', rows: [] }, 2000);
  assert.deepEqual(empty.presence, {}, '这一份"空"是服务端说的，不是我们编的');
  assert.equal(resolvePresence(empty.presence, true, A), 'OFFLINE');
});

/*
 * ★ 上面那几条钉的是**判据**；这一条钉的是**接线**：心跳那一路是
 *   `dispatch({ type: 'friends/presence', … })` 交给 reducer 结算的
 *   （这样它拿到的永远是**当前** state，不会踩闭包里的旧值）。
 *   接线错了的话（比如少 spread 一个字段、或者又去无脑刷 presenceAt），
 *   上面那几条照样全绿 —— 所以这一条必须单独钉。
 */
const { initialState, reducer } = await import('../src/state/store.ts');

test('★★ [心跳] 走 reducer 那一跳：失败不动 presence/presenceAt，只留一句错误', () => {
  const before = {
    ...initialState,
    friends: { ...initialState.friends, presence: { [A]: 'PLAYING_SERVER' }, presenceAt: 1000 },
  };
  const failed = reducer(before, {
    type: 'friends/presence',
    now: 2000,
    beat: { kind: 'failed', reason: '网络断了' },
  });
  assert.deepEqual(failed.friends.presence, before.friends.presence, '上一次的名单要保住');
  assert.equal(failed.friends.presenceAt, 1000, '★ 失败不许把"未知"盖成"已知"');
  assert.equal(failed.friends.presenceError, '网络断了');

  // 304：沿用旧 map、刷时间、清错误
  const stale = reducer(failed, { type: 'friends/presence', now: 2500, beat: { kind: 'notModified' } });
  assert.deepEqual(stale.friends.presence, before.friends.presence);
  assert.equal(stale.friends.presenceAt, 2500);
  assert.equal(stale.friends.presenceError, null);

  // 200：整份替换
  const ok = reducer(stale, {
    type: 'friends/presence',
    now: 3000,
    beat: { kind: 'ok', rows: [{ profileId: B, status: null }] },
  });
  assert.deepEqual(Object.keys(ok.friends.presence), [B.toLowerCase()], '整份替换');
  assert.equal(ok.friends.presenceAt, 3000);
  assert.equal(ok.friends.presenceError, null);
  // ★ 名单那一份（snapshot / loading / pageOpen…）不许被心跳顺手改掉
  assert.equal(ok.friends.snapshot, before.friends.snapshot);
  assert.equal(ok.friends.pageOpen, before.friends.pageOpen);
});
test('★★ 按需更新频率（用户给的设计图）：打开这一页每分钟、没打开每 5 分钟', () => {
  assert.equal(friendsPollIntervalMs(true), 60_000, '打开好友页 ⇒ 每分钟');
  assert.equal(friendsPollIntervalMs(false), 300_000, '关着 ⇒ 每 5 分钟');
  assert.equal(FRIENDS_POLL_OPEN_MS, 60_000);
  assert.equal(FRIENDS_POLL_CLOSED_MS, 300_000);
  // 关着的时候必须比打开时**更松**（这就是"平衡实时性与性能"那句话的判据）
  assert.ok(friendsPollIntervalMs(false) > friendsPollIntervalMs(true));
});

test('在场心跳：同一套"打开紧、关着松"，但它不能跟名单一样降到 5 分钟', () => {
  assert.equal(presenceBeatIntervalMs(true), 30_000);
  assert.equal(presenceBeatIntervalMs(false), 90_000);
  assert.ok(
    presenceBeatIntervalMs(false) < friendsPollIntervalMs(false),
    '★ 心跳比名单更紧：不然关掉好友页之后，好友会以为你掉线了',
  );
});