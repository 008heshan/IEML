/**
 * 校验规则：**三态语义** + **前后端规则同形**。
 * ------------------------------------------------------------------
 * ## 为什么这条测试重要
 *
 * 这个仓库已经因为"同一个判据写两遍、有一处忘了改"栽过两次：
 *   · `net.minecraftforge:forge` 的前缀匹配写在两个函数里 →
 *     第一次只修了一处，界面照旧显示 `Forge 7.0.1`（真值 47.2.0）；
 *   · 「需要哪个 Java」手写在三个文件里 → `26.2` 被算成需要 Java 8。
 *
 * 校验规则是第三个高危点：它会同时存在于 Rust（真源）与 TS（按键即校验）。
 * 所以这里做两件事：
 *   ① 把**三态语义**钉死（`skip` / 通过 / 原因）—— 这是最容易写反的地方
 *      （我在 Rust 侧第一版就把 `Optional` 的两个方向全写反了）；
 *   ② 把**两边的规则参数**逐条对上（与服务器地址那张表的做法一样）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validate,
  isValid,
  instanceNameRules,
  slugRules,
  offlineUsernameRules,
  portRules,
} from '../src/domain/validate.ts';

/* ====================== ① 三态语义 ====================== */

test('★ optional 遇到空值要「中断并直接通过」', () => {
  const rules = [{ rule: 'optional' }, { rule: 'matches', pattern: /^\d+$/, message: '必须是数字' }];
  // 没填 / 空串 → 通过（后面的规则不该被跑）
  assert.equal(validate(null, rules), null, 'null 应当直接通过');
  assert.equal(validate(undefined, rules), null);
  assert.equal(validate('', rules), null, '空串应当直接通过');
  // 填了就必须满足后面的规则
  assert.equal(validate('12', rules), null);
  assert.equal(validate('ab', rules), '必须是数字', '填了内容之后后面的规则必须生效');
});

test('★ 第一条不通过的规则就是结论（不攒错误）', () => {
  const rules = [
    { rule: 'not_empty', message: '不能为空' },
    { rule: 'len_range', min: 3, max: 10, label: '名字' },
    { rule: 'matches', pattern: /^[a-z]+$/, message: '只能小写字母' },
  ];
  assert.equal(validate('', rules), '不能为空');
  assert.match(validate('ab', rules), /不能少于 3/);
  assert.equal(validate('aBc', rules), '只能小写字母');
  assert.equal(validate('abc', rules), null);
});

test('not_empty 与 not_blank 的差别：全空格', () => {
  assert.equal(validate('   ', [{ rule: 'not_empty', message: '不能为空' }]), null);
  assert.equal(validate('   ', [{ rule: 'not_blank', message: '不能为空' }]), '不能为空');
});

test('★ 长度按字符数算，不是 UTF-16 码元', () => {
  const rules = [{ rule: 'len_range', min: 1, max: 6, label: '名字' }];
  assert.equal(validate('中文名字', rules), null, '4 个汉字应当通过');
  assert.equal(validate('一二三四五六', rules), null, '6 个汉字应当通过');
  const err = validate('一二三四五六七', rules);
  assert.ok(err && err.includes('现在是 7 个'), `报的应该是字符数：${err}`);
});

test('整数范围会指出是上界还是下界', () => {
  const rules = [{ rule: 'int_range', min: 1, max: 65535, label: '端口' }];
  assert.equal(validate('25565', rules), null);
  assert.equal(validate('0', rules), '端口不能低于 1');
  assert.equal(validate('70000', rules), '端口不能超过 65535');
  assert.equal(validate('abc', rules), '端口要填一个整数');
  assert.equal(
    validate('999999999999999999999', rules),
    '端口要填一个大小合理的数字',
  );
});

test('safe_name 挡住 Windows 真的会出问题的那些形态', () => {
  const rules = [{ rule: 'safe_name', label: '目录名' }];
  for (const bad of [' a', 'a ', 'a.', 'a..~1', 'a<b', 'CON', 'nul.txt', '...', 'a/b', 'a\\b']) {
    assert.ok(validate(bad, rules), `「${bad}」应当被拒`);
  }
  for (const good of ['fabric-262', 'Minecraft 1.12.2', 'forge_1122', '中文名', 'a.b.c']) {
    assert.equal(validate(good, rules), null, `「${good}」应当通过`);
  }
  // 只是以保留名开头的不算
  assert.equal(validate('CONSOLE', rules), null);
});

/* ====================== ② 项目里在用的那几套 ====================== */

test('实例显示名：允许中文，挡换行，挡超长', () => {
  assert.equal(validate('我的世界 1.12.2', instanceNameRules()), null);
  assert.ok(validate('名字\n换行', instanceNameRules()));
  assert.ok(validate('   ', instanceNameRules()), '全空格要拒');
  assert.ok(validate('x'.repeat(65), instanceNameRules()), '超过 64 个字符要拒');
});

test('slug 就是文件夹名', () => {
  assert.equal(validate('vanilla-262', slugRules()), null);
  assert.ok(validate('a/b', slugRules()), '不能含路径分隔符');
  assert.ok(validate('CON', slugRules()));
});

test('★ 离线玩家名：中文/空格/超长都不许（以前完全没校验）', () => {
  const rules = offlineUsernameRules();
  assert.equal(validate('Steve_01', rules), null);
  assert.ok(validate('史提夫', rules), '中文名正版不允许');
  assert.ok(validate('Steve 01', rules), '不能带空格');
  assert.ok(validate('a'.repeat(17), rules), '17 个字符应当被拒');
  assert.ok(validate('', rules));
});

test('端口是可选字段 —— 不填是正常的', () => {
  assert.equal(validate('', portRules()), null);
  assert.equal(validate(null, portRules()), null);
  assert.equal(validate('25565', portRules()), null);
  assert.ok(validate('70000', portRules()));
});

/* ====================== ③ 规则名字必须两边都注册 ====================== */

test('★ 规则里用到的自定义谓词名，Rust 侧必须也注册了', async () => {
  const { readFileSync } = await import('node:fs');
  const rust = readFileSync('src-tauri/src/domain/validate.rs', 'utf8');

  // 收集本项目规则集里用到的 custom 名字
  const used = new Set();
  for (const rules of [instanceNameRules(), slugRules(), offlineUsernameRules(), portRules()]) {
    for (const r of rules) if (r.rule === 'custom') used.add(r.name);
  }
  assert.ok(used.size > 0, '应当至少用到一个自定义谓词');
  for (const name of used) {
    assert.ok(
      rust.includes(`("${name}",`),
      `自定义谓词「${name}」在 Rust 侧没有注册 —— 两边必须同名（见 domain/validate.rs 的 CUSTOM_RULES）`,
    );
  }
});

test('★ 没注册的规则名要报错，不能静默通过', () => {
  const e = validate('随便', [{ rule: 'custom', name: '这个规则不存在', label: '名字' }]);
  assert.ok(e && e.includes('没有注册'), `应当报"没有注册"，实际：${e}`);
});

/* ====================== ④ 与 Rust 侧同一套规则参数 ====================== */

test('★ 前后端的规则参数逐条一致（改一边必须改另一边）', async () => {
  const { readFileSync } = await import('node:fs');
  const rust = readFileSync('src-tauri/src/domain/validate.rs', 'utf8');

  // 实例显示名：max 64
  const tsName = instanceNameRules().find((r) => r.rule === 'len_range');
  assert.equal(tsName.max, 64);
  assert.ok(
    rust.includes('max: 64') && rust.includes('instance_name_rules'),
    'Rust 侧的 instance_name_rules 应当是 max: 64',
  );

  // slug：max 48
  const tsSlug = slugRules().find((r) => r.rule === 'len_range');
  assert.equal(tsSlug.max, 48);
  assert.ok(rust.includes('max: 48'), 'Rust 侧的 slug_rules 应当是 max: 48');

  // 端口：1..65535
  const tsPort = portRules().find((r) => r.rule === 'int_range');
  assert.equal(tsPort.min, 1);
  assert.equal(tsPort.max, 65535);
  assert.ok(
    rust.includes('min: 1') && rust.includes('max: 65535'),
    'Rust 侧的 port_rules 应当是 1..65535',
  );

  // 离线玩家名：同一个正则
  const tsUser = offlineUsernameRules().find((r) => r.rule === 'matches');
  assert.equal(tsUser.pattern.source, '^[A-Za-z0-9_]{1,16}$');
  assert.ok(
    rust.includes('^[A-Za-z0-9_]{1,16}$'),
    'Rust 侧的 offline_username_rules 应当是同一个正则',
  );
});

test('isValid 是 validate 的便利包装', () => {
  assert.equal(isValid('ok', slugRules()), true);
  assert.equal(isValid('a/b', slugRules()), false);
});
