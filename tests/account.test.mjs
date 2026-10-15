/**
 * 「切回正版」这条判断的判据（`src/domain/account.ts`）。
 *
 * 背景是用户报的那个 bug：「切换到离线登录，再切回正版登录**要重新登录**」——
 * 根因是"上一次那个正版号是谁"只记在组件的 ref 里，切离线时又被写进了 prefs
 * 之外的地方（丢在重启之后）。这几条用例把那个决定钉死。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adoptablePremiumUuid, looksLikeUuid, planSwitchBack } from '../src/domain/account.ts';

const PREMIUM = '0123456789abcdef0123456789abcdef';
const OTHER = 'fedcba9876543210fedcba9876543210';

test('★ 现在就在正版上：什么都不用做（别把登录面板弹出来）', () => {
  const plan = planSwitchBack({ accountUuid: PREMIUM, lastPremiumUuid: PREMIUM });
  assert.equal(plan.kind, 'already-online');
  assert.equal(plan.uuid, PREMIUM);
});

test('★ 在离线、但记着上一个正版号 ⇒ 直接切回去，不用重新登录', () => {
  const plan = planSwitchBack({ accountUuid: null, lastPremiumUuid: PREMIUM });
  assert.equal(plan.kind, 'switch');
  assert.equal(plan.uuid, PREMIUM);
});

test('★ 在离线、而且没有任何正版号的记忆 ⇒ 只能走一次登录（如实说）', () => {
  assert.equal(planSwitchBack({ accountUuid: null, lastPremiumUuid: null }).kind, 'need-login');
  assert.equal(planSwitchBack({}).kind, 'need-login');
  assert.equal(
    planSwitchBack({ accountUuid: null, lastPremiumUuid: '不是-uuid' }).kind,
    'need-login',
  );
});

test('形态检查：带横线的 uuid 也认，垃圾值一律不认', () => {
  assert.equal(looksLikeUuid(PREMIUM), true);
  assert.equal(looksLikeUuid('01234567-89ab-cdef-0123-456789abcdef'), true);
  assert.equal(looksLikeUuid(''), false);
  assert.equal(looksLikeUuid(null), false);
  assert.equal(looksLikeUuid('zzzz'), false);
  assert.equal(looksLikeUuid(12345), false);
});

test('★ 老数据自愈①：现在就在用正版、但没记过 ⇒ 把当前这个记下来', () => {
  /*
   * 这是**最常见的一种**：修复之前登录过的老用户，`accountUuid` 有值、
   * `lastPremiumUuid` 这个键还不存在。不补的话，他切一次离线就回不来了。
   * （真机核过：本机 prefs.json 就是这个形状。）
   */
  assert.equal(
    adoptablePremiumUuid({ accountUuid: PREMIUM, lastPremiumUuid: null }, OTHER),
    PREMIUM,
    '该记的是"现在正在用的这个"，不是密钥环里那个可能过时的指针',
  );
});

test('★ 老数据自愈②：记忆丢了、人还在离线 ⇒ 用密钥环里那个指针补回来', () => {
  // 修好之前切到离线的那批用户是这个形状
  assert.equal(
    adoptablePremiumUuid({ accountUuid: null, lastPremiumUuid: null }, PREMIUM),
    PREMIUM,
  );
});

test('自愈不该做的事：已经记着就绝不覆盖', () => {
  assert.equal(adoptablePremiumUuid({ lastPremiumUuid: OTHER }, PREMIUM), null, '记着就别动它');
  assert.equal(
    adoptablePremiumUuid({ accountUuid: PREMIUM, lastPremiumUuid: OTHER }, PREMIUM),
    null,
    '记着就别动它（哪怕现在用的是另一个号）',
  );
  // 后端那边也没有（没登录过 / 读不到密钥环）⇒ 什么都不做，不许编一个出来
  assert.equal(adoptablePremiumUuid({ accountUuid: null, lastPremiumUuid: null }, null), null);
  assert.equal(adoptablePremiumUuid({ accountUuid: null, lastPremiumUuid: null }, '乱码'), null);
});
