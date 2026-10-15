/**
 * 好友的**本机部分**判据（`src/domain/friends.ts`）。
 *
 * 为什么必须有用例：全是"错了不会报错、只会慢慢变脏"的那一类 ——
 * 备注写串了人、脏 prefs 把界面搞坏、拿不到在线状态时把人家写成"离线"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
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