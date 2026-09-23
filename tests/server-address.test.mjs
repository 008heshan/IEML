/**
 * 服务器地址清洗的回归测试（`src/domain/server-address.ts`）
 * ------------------------------------------------------------------
 * 用法：`node --test tests/server-address.test.mjs`
 *
 * ★ 为什么值得单独测：这一条对付的是**一整类"我明明输对了却连不上"**。
 *   中文输入法下 `mc.example.com：25565`（全角冒号）极其自然，
 *   而游戏只认半角 —— 报错里两个地址看起来一模一样，用户永远查不出来。
 *   PCL2 在输入框的 `TextChanged` 里做了同样的事（源码研读第 13.4 节）。
 *
 *   另一半同样重要：**不许偷偷改地址**。端口写坏时只丢端口、
 *   不替用户换目标 —— 悄悄连到另一个服务器上比报错严重得多。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const { parseServerAddress, toHalfWidth, serverAddressHint } = await import(
  '../src/domain/server-address.ts'
);

test('全角冒号被换成半角（中文输入法最常见的手误）', () => {
  const r = parseServerAddress('mc.example.com：25565');
  assert.equal(r.host, 'mc.example.com');
  assert.equal(r.port, 25565);
  assert.equal(r.normalized, 'mc.example.com:25565');
  assert.equal(r.changed, true, '改过就要如实标记，界面才能提示用户');
});

test('全角数字与全角句号也能救回来', () => {
  const r = parseServerAddress('ｍｃ．ｅｘａｍｐｌｅ．ｃｏｍ：２５５６５');
  assert.equal(r.normalized, 'mc.example.com:25565');
  assert.equal(r.changed, true);
});

test('全角空格被去掉，不被当成主机名的一部分', () => {
  const r = parseServerAddress('　mc.example.com　');
  assert.equal(r.normalized, 'mc.example.com');
});

test('本来就正确的地址：一个字都不改', () => {
  const r = parseServerAddress('play.example.net:25565');
  assert.equal(r.normalized, 'play.example.net:25565');
  assert.equal(r.changed, false, '没改过就不该说"已自动替换"（那是假提示）');
  assert.equal(r.error, null);
});

test('没写端口 → 端口为 null（不编一个 25565 出来）', () => {
  const r = parseServerAddress('mc.example.com');
  assert.equal(r.host, 'mc.example.com');
  assert.equal(r.port, null);
  assert.equal(r.error, null);
  const h = serverAddressHint('mc.example.com');
  assert.match(h.text, /默认端口 25565/, '要告诉用户会连到默认端口，别让他猜');
});

test('★ 端口写坏时只丢端口，不替用户换目标服务器', () => {
  const r = parseServerAddress('mc.example.com:abc');
  assert.equal(r.host, 'mc.example.com');
  assert.equal(r.port, null, '不能猜一个端口塞进去');
  assert.ok(r.error, '必须报错说明，不能静默');
  /*
   * ★★ 2026-09-24（B-4 修复）：这句话原来断言的是「原样传给游戏」——
   *   而真实行为是**端口被丢掉、游戏用默认 25565**（`--server host`，没有 `--port`）。
   *   现在断言的是**真实行为**：说清端口被丢掉 + 游戏会用默认端口 + 怎么改对。
   */
  assert.match(r.error, /端口会被丢掉/, '要说清端口真的被丢掉了');
  assert.match(r.error, /25565/, '要说清游戏会用默认端口');
  assert.match(r.error, /写成数字/, '要给一条出路');
  assert.ok(!/原样传给游戏/.test(r.error), '不许再说"原样传给游戏"（那是假的）');
  // 提示语气必须是"警告"而不是"正常"
  assert.equal(serverAddressHint('mc.example.com:abc').tone, 'warn');
});

test('端口越界（>65535 或 0）也被识别出来', () => {
  for (const bad of ['host.example:70000', 'host.example:0', 'host.example:-1']) {
    const r = parseServerAddress(bad);
    assert.equal(r.port, null, `${bad} 的端口不合法`);
    assert.ok(r.error, `${bad} 应当有错误说明`);
    assert.match(r.error, /25565/, `${bad} 的错误说明要说清会用默认端口`);
  }
});

test('粘贴进来的 URL 会被收拾成主机名 + 端口', () => {
  const r = parseServerAddress('https://mc.example.com:25566/play?x=1');
  assert.equal(r.host, 'mc.example.com');
  assert.equal(r.port, 25566);
  assert.equal(r.changed, true);
});

test('空输入 = 没设置（不是错误）', () => {
  for (const empty of ['', '   ', '　']) {
    const r = parseServerAddress(empty);
    assert.equal(r.normalized, '');
    assert.equal(r.error, null, '留空是合法选择，不该报错');
    assert.equal(serverAddressHint(empty), null, '留空时不需要提示行');
  }
});

test('只有端口没有主机名 → 报错而不是当成地址', () => {
  const r = parseServerAddress(':25565');
  assert.equal(r.host, '');
  assert.ok(r.error);
  assert.match(r.error, /缺少主机名/);
});

test('IPv6 字面量：按最后一个冒号拆，不会把地址切碎', () => {
  // [::1]:25565 这种写法里冒号很多，只有最后一个是端口分隔符
  const r = parseServerAddress('[::1]:25565');
  assert.equal(r.host, '[::1]');
  assert.equal(r.port, 25565);
});

test('toHalfWidth 只动该动的字符：中文内容要原样保留', () => {
  assert.equal(toHalfWidth('abc123'), 'abc123');
  assert.equal(toHalfWidth('ＡＢＣ１２３'), 'ABC123');
  assert.equal(toHalfWidth('中文测试'), '中文测试', '汉字不在全角 ASCII 区，不许被改动');
  assert.equal(toHalfWidth('中文：测试。'), '中文:测试.', '标点要换（句号也换，见实现说明）');
});

test('提示行的三种语气对应三种真实状态', () => {
  assert.equal(serverAddressHint('mc.example.com：25565').tone, 'fix');
  assert.equal(serverAddressHint('mc.example.com:25565').tone, 'ok');
  assert.equal(serverAddressHint('mc.example.com:abc').tone, 'warn');
  // fix 语气必须写出最终地址 —— 用户要能一眼确认改成了什么
  assert.match(serverAddressHint('mc.example.com：25565').text, /mc\.example\.com:25565/);
});

/**
 * ★ 前后端规则**必须给出同样的结论**。
 *
 *   规则在两处实现（前端为了"边输边纠正"，Rust 为了真正拼命令行），
 *   两边分叉时症状极隐蔽：输入框下面写着"会连 mc.example.com:25565"，
 *   实际启动参数里却是别的东西。
 *
 *   这张表与 `src-tauri/src/game/launch_args.rs` 里
 *   `server_address_matches_the_frontend_rule_table` 的**逐字相同** ——
 *   任何一边改了规则，两张表就会有一个红。
 */
test('规则表与 Rust 侧逐条一致（两边分叉立刻可见）', () => {
  const table = [
    ['mc.example.com：25565', 'mc.example.com', 25565],
    ['mc.example.com:25565', 'mc.example.com', 25565],
    ['mc.example.com', 'mc.example.com', null],
    ['mc.example.com：', 'mc.example.com', null],
    ['https://mc.example.com:25566/play?x=1', 'mc.example.com', 25566],
    ['　mc.example.com　', 'mc.example.com', null],
    ['mc.example.com:abc', 'mc.example.com', null],
    ['[::1]:25565', '[::1]', 25565],
    ['ＭＣ．ＥＸＡＭＰＬＥ．ＣＯＭ：２５５６５', 'MC.EXAMPLE.COM', 25565],
    ['mc.example.com:70000', 'mc.example.com', null],
  ];
  for (const [input, host, port] of table) {
    const r = parseServerAddress(input);
    assert.equal(r.host, host, `「${input}」的主机名不对`);
    assert.equal(r.port, port, `「${input}」的端口不对`);
  }
});
