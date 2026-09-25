/**
 * 更新状态的文案（B-2 的判据）
 * ------------------------------------------------------------------
 * 这条测试守的是一句**用户会信的话**：
 *   `AboutPage` 原来对 9 种更新状态里的 4 种有文案，**其余全说"已是最新版本"**——
 *   包括 `error`（断网 / 404 / 签名失败）、`idle`（还没查过）、`downloading`、`installing`。
 *   于是断网点「检查更新」，界面告诉他一个假事实。
 *
 * 现在：**只有 `uptodate` 能说"已是最新版本"**，失败必须带原因，认不出的状态如实报出。
 * 运行：node --test tests/update-copy.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeUpdate, isUpdateProblem, describeUpdateError } from '../src/domain/update-copy.ts';

test('★ 只有 uptodate 才允许说「已是最新版本」', () => {
  assert.equal(describeUpdate({ phase: 'uptodate' }), '已是最新版本');
  // 其它任何状态都不许出现这句话
  const others = [
    { phase: 'idle' },
    { phase: 'checking' },
    { phase: 'available', version: '0.2.0' },
    { phase: 'downloading', version: '0.2.0' },
    { phase: 'ready', version: '0.2.0' },
    { phase: 'installing' },
    { phase: 'unsupported' },
    { phase: 'error', error: '连不上更新服务器' },
    { phase: 'something-new' },
  ];
  for (const s of others) {
    assert.ok(
      !describeUpdate(s).includes('已是最新版本'),
      `${s.phase} 不许说"已是最新版本"：${describeUpdate(s)}`,
    );
  }
});

test('★ 检查失败必须把原因说出来（那是用户唯一能据此行动的信息）', () => {
  const t = describeUpdate({ phase: 'error', error: '连不上更新服务器（DNS 解析失败）' });
  assert.match(t, /检查更新失败/);
  assert.match(t, /DNS 解析失败/);
  assert.equal(isUpdateProblem('error'), true, '页面据此标红');
  // 没有原因时也不能编一个，只能老实说不知道
  assert.match(describeUpdate({ phase: 'error' }), /原因未知/);
});

test('还没查过 / 正在下载 / 正在安装：各有各的话，不冒充结论', () => {
  assert.match(describeUpdate({ phase: 'idle' }), /还没检查/);
  assert.match(describeUpdate({ phase: 'downloading', version: '0.2.0' }), /正在下载.*0\.2\.0/);
  assert.match(describeUpdate({ phase: 'installing' }), /安装程序/);
  assert.equal(isUpdateProblem('idle'), false);
});

test('认不出的状态如实报出它的名字（宁可难看，也不许说假话）', () => {
  assert.equal(describeUpdate({ phase: 'weird-new-phase' }), '更新状态：weird-new-phase');
});

test('★ 失败原因要说人话（这条是**真机抓到的原串**逼出来的）', () => {
  /*
   * 把 HTTPS_PROXY 指向死端口跑 `probe-b2-fixed.mjs`，界面上一字不差地出现了：
   *   error sending request for url (https://cnb.cool/IEML_Official/IEML-releases/…/latest.json)
   * —— 原来那张词表里没有任何一条能匹配它（只有 connect/network/socket/dns/timeout），
   * 于是**断网的用户看到的是一句纯英文**。
   */
  const real = new Error(
    'error sending request for url (https://cnb.cool/IEML_Official/IEML/-/releases/download/latest/latest.json)',
  );
  const t = describeUpdateError(real);
  assert.ok(!/error sending request/i.test(t), '不该把英文原文甩给用户：' + t);
  assert.match(t, /连不上更新服务器/);
  assert.match(t, /重试|稍后/, '要告诉用户下一步能做什么');
});

test('失败原因的其它几类也各有各的话（不冒充同一个原因）', () => {
  assert.match(describeUpdateError(new Error('request timed out')), /超时/);
  assert.match(describeUpdateError(new Error('dns error: failed to lookup address')), /域名解析/);
  assert.match(describeUpdateError(new Error('invalid tls certificate')), /证书|TLS/);
  assert.match(describeUpdateError(new Error('signature verify failed')), /签名/);
  assert.match(describeUpdateError(new Error('HTTP 404 not found')), /404/);
  // 认不出的原因如实报出原文，**不许**编一个理由
  assert.equal(describeUpdateError(new Error('some brand new failure')), 'some brand new failure');
});
