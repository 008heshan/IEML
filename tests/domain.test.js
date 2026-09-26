/**
 * 领域规则测试 —— 用 Node 内置 test runner 跑，不需要额外依赖。
 * 这些用例全部来自 docs/LAUNCHER_SOURCE_STUDY.md 的源码事实，
 * 任何一条挂了都说明规则实现跑偏了。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { validateCombination, addonCompatibility, optifineSuitsForge } from '../src/domain/combination.ts';
import { getLoaderCapabilities, bridgeFor } from '../src/domain/loader-caps.ts';
import { autoMemory, gearToGb, gbToGear, snapToGear, maxGear, memoryBar, memoryReasoning } from '../src/domain/memory.ts';
import { resolveJavaRequirement, pickJava, validateJavaRangeText, inJavaRange, displayJavaMajor } from '../src/domain/java.ts';
import { resolveIsolation } from '../src/domain/isolation.ts';
import {
  isEnabled, toggledName, displayNameOf, scanMods, findDuplicates, judgeModState,
  availableFilters, hashCacheKey, oldFilesToDrop,
} from '../src/domain/mods.ts';
import { compareVersion, forgeVersionSatisfies, parseRange, inRange } from '../src/domain/version.ts';

/* ====================== 加载器能力表 ====================== */

test('NeoForge 在 1.20.1 上不可用，且给出具体理由', () => {
  const caps = getLoaderCapabilities('1.20.1');
  const neo = caps.baseLoaders.find((b) => b.kind === 'neoforge');
  assert.ok(neo);
  assert.equal(neo.available, false);
  assert.match(neo.unavailableReason, /1\.20\.1/);
  // 不允许只说"不支持"
  assert.doesNotMatch(neo.unavailableReason, /^不支持/);
});

test('NeoForge 从 1.20.4 起可用', () => {
  assert.equal(
    getLoaderCapabilities('1.20.4').baseLoaders.find((b) => b.kind === 'neoforge')?.available,
    true,
  );
});

test('LiteLoader 只在 1.7.10 ~ 1.12.2 出现，且只作为附加组件', () => {
  /*
   * ★★ 这条断言改过两次，每次都是跟着代码的真实状态走：
   *
   *   ① 起初断言 `available === true`（"1.7.10 / 1.12.2 上可用"），
   *      而 Rust 侧**根本没有 LiteLoader 的安装实现** —— 用户勾选、
   *      点安装、界面报成功、磁盘上什么都没发生。
   *   ② 于是改成 `implemented === false` + `available === false`（诚实）。
   *   ③ dev.4 第二轮：安装**真的做出来了**
   *      （`net::liteloader`，照 PCL 的 `McDownloadLiteLoaderLoader`），
   *      并有真机测试证明装完能进游戏（`tests/live_liteloader.rs`：
   *      写版本描述 → 下三个 jar → 真的启动、活过 30 秒、
   *      LiteLoader 正常 bootstrap）。
   *
   *   现在这条测试守的是**那条定义式**：
   *     available === exists && implemented
   *   —— 不管实现状态怎么变，"能装 = 上游有 且 我们做了"永远成立。
   */
  for (const v of ['1.7.10', '1.12.2']) {
    const caps = getLoaderCapabilities(v);
    const lite = caps.addons.find((a) => a.kind === 'liteloader');
    assert.equal(lite?.exists, true, `${v} 上 LiteLoader 确实存在`);
    assert.equal(lite?.implemented, true, `${v} 的 LiteLoader 安装已实装（dev.4）`);
    assert.equal(
      lite?.available,
      lite.exists && lite.implemented,
      `${v}：available 必须严格等于 exists && implemented`,
    );
    assert.equal(caps.baseLoaders.find((b) => b.kind === 'liteloader'), undefined, v);
  }
  for (const v of ['1.16.5', '1.20.1', '1.21.1']) {
    assert.equal(
      getLoaderCapabilities(v).addons.find((a) => a.kind === 'liteloader')?.available,
      false,
      v,
    );
  }
});

/*
 * ★★ 2026-09-26 改判据（原判据："版本号以 `+<mc>` 结尾"）。
 *
 *   原来这里钉的是 `0.92.2+1.20.1` 这种写法 —— 可那是**编出来的数字**：
 *   真实安装走 Modrinth 在线清单、由 `pick_default_version` 挑（正式版 > beta > alpha），
 *   实测早就到 `0.92.12+1.20.1` 了。界面上写一个固定的旧版本号 = 对用户说假话。
 *   ⇒ 现在版本号字段只写「最新版」，判据改成"**不许再像具体版本号**"。
 *   （Rust 侧同名字段与判据同步改，见 `domain::loader_caps` 的
 *    `fabric_api_version_is_not_hardcoded_any_more`。）
 */
test('Fabric API 不再显示写死的具体版本号', () => {
  const a = getLoaderCapabilities('1.20.1').apiLibraries.find((l) => l.kind === 'fabric-api');
  const b = getLoaderCapabilities('1.21.1').apiLibraries.find((l) => l.kind === 'fabric-api');
  assert.equal(a.version, '最新版');
  assert.equal(b.version, '最新版');
  assert.doesNotMatch(a.version, /^\d/, '版本号字段不许以数字开头（那会被读成一个具体版本）');
});

/* ====================== 组合校验 ====================== */

test('纯原版 + OptiFine：规则合法，dev.4 起真的可以装', () => {
  /*
   * ★★ 这条测试的名字与断言改过两轮：
   *
   *   起初断言 `r.ok === true` + note 里有"打补丁" —— 那是"第四轮纠错"
   *   要纠正"OptiFine 只能配 Forge"这个错误印象（规则至今是对的）。
   *
   *   dev.3 改成断言 `!r.ok` + 理由是"我们没做" —— 因为当时
   *   **全仓库没有任何 OptiFine 安装实现**，而界面在承诺能装，
   *   是一张空头支票（用户报的"显示有、点击不让选"）。
   *
   *   dev.4 又改回来 —— **这次实现是真的**：`src-tauri/src/net/optifine.rs`
   *   照 PCL 的 `McDownloadOptiFineInstall` 写的，并且有真机证据：
   *     · `tests/live_optifine.rs`        下载 + 跑 Patcher + 校验产物
   *     · `tests/live_optifine_launch.rs` 装完**真的启动、活过 30 秒**
   *
   *   规则本身（纯原版 + OptiFine 合法）从头到尾没变过；
   *   变的一直是"我们做没做"。
   */
  const r = addonCompatibility('1.20.1', null, 'optifine');
  assert.equal(r.ok, true, 'dev.4 已实装 OptiFine 安装，纯原版 + OptiFine 应该放行');
  // 文案不许出现"覆盖原版文件"（ADR-003：是打补丁，不是覆盖）
  assert.doesNotMatch(r.note ?? '', /覆盖/);
  assert.doesNotMatch(r.reason ?? '', /不兼容/);
});

test('OptiFine 文案不许出现"覆盖原版文件"这类假话', () => {
  const r = addonCompatibility('1.20.1', null, 'optifine');
  assert.doesNotMatch(r.reason ?? '', /覆盖/);
  assert.doesNotMatch(r.note ?? '', /覆盖/);
});

/*
 * ★★ 这条在 2026-09-14 反转了**两次**，两次的结论都留在这里 ——
 *    因为第一次反转是错的，而错的理由值得记住。
 *
 *   用户要求：「当我们选择 Fabic 时如果有版本的 Fabic 与高清修复不兼容，
 *   应提示玩家不兼容」。
 *
 *   第一次（dev.10）：我查了 Modrinth，`optifabric` 返回 **404**，于是断言
 *     「1.16 ~ 1.20.4 整段没有任何桥接包 → 判不兼容」。
 *   **错在把"某个平台上没有"当成了"这东西不存在"**：
 *     · OptiFabric 一直在 **CurseForge 项目 322385** 发布 ——
 *       `api.cfwidget.com` 实读：75 个文件、总下载 10,056,111 次、
 *       最高 `optifabric-1.14.3.jar`（MC 1.19.3，2024-01-12）；
 *     · 用户拿 MC百科 class/1703 的「支持MC版本」表纠正我：
 *       Fabric 1.14 ~ **1.20.4** 全支持（Chocohead 1.16~1.20 /
 *       modmuss50 1.14~1.16），CurseForge Project ID 也正是 322385。
 *   它只是**没上 Modrinth** —— 我查错了平台，还把缺席当成了铁证。
 *
 *   现在的正确结论：
 *     · 1.14 ~ 1.20.4 → 桥接包**存在**，组合**合法**，但必须**手动下载**；
 *     · 1.20.5 及以上 → 真的没有 → 判不兼容（这才是该提示的那一段）。
 */
test('★ Fabric 1.20.4 + OptiFine 合法，桥接包要手动下（附下载地址）', () => {
  const v = validateCombination({ mcVersion: '1.20.4', base: 'fabric', addons: ['optifine'] });
  assert.equal(v.valid, true, `应当是合法组合：${v.errors.join('；')}`);
  assert.equal(v.removed.length, 0, '不该被判成不兼容');
  assert.equal(v.autoBridges.length, 0, '手动下载的东西不能列进"将自动安装"');
  const warn = v.warnings.join(' ');
  assert.match(warn, /要你自己下载/, '必须明说桥接包要用户自己下');
  assert.match(warn, /curseforge\.com/, '必须给出可点的下载地址');
  assert.doesNotMatch(warn, /会自动装/, '没有任何代码会去下载它，不许这样承诺');
});

test('★ Fabric 1.20.5+ 与 OptiFine 才是不兼容（上界）', () => {
  const v = validateCombination({ mcVersion: '1.20.5', base: 'fabric', addons: ['optifine'] });
  assert.equal(v.valid, false, '勾了装不上就该拦住，不能静默去掉');
  assert.equal(v.autoBridges.length, 0, '装不了就不该再列桥接包');
  assert.equal(v.removed.length, 1);
  const why = v.removed[0].reason;
  assert.match(why, /OptiFabric/, '要说清缺的是哪个桥接包');
  assert.match(why, /1\.20\.5/, '要说清是这个版本的问题');
  assert.match(why, /Forge/, '要给一条可行的替代：换 Forge');
  assert.match(why, /Iris/, '要给另一条可行的替代：Iris + Sodium');
  // 错误列表里也要有（安装按钮据此拦住）
  assert.ok(v.errors.some((e) => e.includes('OptiFine')), `errors 里要有：${v.errors}`);
});

/*
 * ★★ **来源锚定**：把 MC百科 class/1703「支持MC版本」表原样抄下来逐条核对。
 *
 *   这是这份数据的**出处本身**。表里有一个版本而这个函数判"不支持"，
 *   就说明我又在下没有依据的结论（dev.10 就是漏了 1.16~1.20.4 一整段）。
 */
test('★ MC百科支持表里的 25 个 Fabric 版本逐个核对', () => {
  const table = [
    '1.20.4', '1.20.2', '1.20.1', '1.20', '1.19.4', '1.19.3', '1.19.2', '1.19.1', '1.19',
    '1.18.2', '1.18.1', '1.18', '1.17.1', '1.17', '1.16.5', '1.16.4', '1.16.3', '1.16.2',
    '1.16.1', '1.15.2', '1.14.4', '1.14.3', '1.14.2', '1.14.1', '1.14',
  ];
  /*
   * 1.14 ~ 1.14.3 这四个是**唯一**的例外，而且例外本身有依据：
   * MC百科把 1.14.x 整段记在主项目名下，但 1.14 段实际由
   * OptiFabric Origins 接续，而 Origins 在 Modrinth 上只发布了
   * **1.14.4 和 1.15.2** 两个版本（实查 game_versions 字段）。
   * 所以"1.14.1 装不了"是"Origins 没发布"，不是"我猜的"。
   */
  const originsGap = ['1.14', '1.14.1', '1.14.2', '1.14.3'];
  for (const mc of table) {
    const b = bridgeFor(mc, 'fabric', 'optifine');
    if (originsGap.includes(mc)) {
      assert.equal(b.usable, 'unavailable', `${mc}：Origins 没发布这个版本，应判不可用`);
      assert.match(b.reason, /Origins/, `${mc} 的理由要说清是 Origins 的事：${b.reason}`);
      continue;
    }
    assert.equal(b.usable, 'yes', `${mc} 在 MC百科表里是支持的，不该判不可用`);
    assert.equal(b.manual, true, `${mc} 的桥接包必须标成手动下载`);
  }
  // 1.15.2 属于 Origins（上游建议），不是主项目
  assert.equal(bridgeFor('1.15.2', 'fabric', 'optifine').kind, 'optifabric-origins');
  assert.equal(bridgeFor('1.16.1', 'fabric', 'optifine').kind, 'optifabric');
  assert.equal(bridgeFor('1.20.4', 'fabric', 'optifine').kind, 'optifabric');
});

test('★ Fabric 1.14.4 仍然可以（optifabric-origins 确实存在）', () => {
  // 直接测桥接规则（不经过"能不能查到 Fabric 在线清单"那条无关的判据）
  const b = bridgeFor('1.14.4', 'fabric', 'optifine');
  assert.equal(b.usable, 'yes');
  assert.equal(b.kind, 'optifabric-origins');
  assert.equal(b.manual, true, '没有自动下载方案，必须手动');

  // 而 1.12.2 连 Fabric 生态都没有
  assert.equal(bridgeFor('1.12.2', 'fabric', 'optifine').usable, 'unavailable');
});

test('★ 不需要桥接的路径仍然是 no-bridge（别把合法组合误伤）', () => {
  assert.equal(bridgeFor('1.20.1', 'forge', 'optifine').usable, 'no-bridge');
  assert.equal(bridgeFor('1.20.1', null, 'optifine').usable, 'no-bridge');
  assert.equal(bridgeFor('1.12.2', 'forge', 'liteloader').usable, 'no-bridge');
});

test('Fabric 1.20.5+ 与 OptiFine 不兼容', () => {
  // Fabric 1.20.5 起换了渲染管线，OptiFine 的补丁没有挂载点 —— 这是**真实的不兼容**
  const r = addonCompatibility('1.20.6', 'fabric', 'optifine');
  assert.equal(r.ok, false);
  assert.match(r.reason, /OptiFine/);
  assert.match(r.reason, /1\.20\.6/);
});

test('OptiFine 的可用性只按事实说，不按印象说', () => {
  /*
   * ★ 这条原来断言「1.20.6 上 OptiFine 根本没有发布过版本」—— **实测是错的**。
   *   真机查 OptiFine 清单：1.20.5 → 0 条；1.20.6 → 有**预览版**（HD U J1 pre17/pre18）；
   *   1.21.1 → 已有**正式版**（OptiFine_1.21.1_HD_U_J1.jar）。
   *   所以"没有 OptiFine"只对 1.20.5 这类确实没有的版本成立，不能按版本号划线。
   *
   * ★ 2026-09-14：`available` 与 `exists` 拆开了。
   *   "上游有没有"和"我们装不装得了"是两个问题 —— 见下面的断言。
   */
  const of206 = getLoaderCapabilities('1.20.6').addons.find((a) => a.kind === 'optifine');
  // 上游确实有（1.20.6 有预览版）→ exists 为真
  assert.equal(of206?.exists, true);
  // ★ dev.4：OptiFine 的安装**已经实装**（net::optifine），所以 implemented / available 都是真
  assert.equal(of206?.implemented, true);
  assert.equal(of206?.available, true);

  // 1.20.5 不在表里 → 不可用，但理由必须区分"没查到"与"确认没有"
  const of = getLoaderCapabilities('1.20.5').addons.find((a) => a.kind === 'optifine');
  assert.equal(of?.available, false);
  assert.match(of?.unavailableReason ?? '', /确认|清单/);
});

test('NeoForge + OptiFine 被移除并给理由', () => {
  /*
   * ★★ 这条守的是一个**措辞顺序**问题，比它看起来重要。
   *
   *   2026-09-14 把 OptiFine 的 `implemented` 改成 false 之后，
   *   `addonCompatibility` 里"我们还没做"那句一度跑到了"NeoForge 不兼容"前面，
   *   于是这条测试立刻变红 —— 因为用户会看到
   *   「IEML 还没做 OptiFine 安装」而不是「NeoForge 与 OptiFine 不兼容」。
   *
   *   这两句话对用户的含义**完全不同**：
   *     · 前者暗示"换个加载器就能装" → 他会白折腾一圈；
   *     · 后者是"这个组合根本装不了" → 他会直接换方案。
   *   所以真实的不兼容必须**先**说。
   */
  const v = validateCombination({ mcVersion: '1.20.4', base: 'neoforge', addons: ['optifine'] });
  assert.equal(v.removed.length, 1);
  assert.match(v.removed[0].reason, /NeoForge/);
});

test('Forge 1.13 ~ 1.14.3 段与 OptiFine 不兼容', () => {
  assert.equal(addonCompatibility('1.13', 'forge', 'optifine').ok, false);
  assert.equal(addonCompatibility('1.14.3', 'forge', 'optifine').ok, false);
});

test('LiteLoader 需要 Forge 基座，但装上之后组合是合法的', () => {
  // 真的兼容性约束（不是"我们没做"）：LiteLoader 的版本描述用 launchwrapper，
  // 纯原版没有它，所以必须挂在 Forge 上。PCL 的 LoadLiteLoaderGetError 也这么判。
  assert.equal(
    addonCompatibility('1.12.2', null, 'liteloader').ok,
    false,
    '纯原版没有 launchwrapper，LiteLoader 挂不上',
  );
  assert.equal(
    addonCompatibility('1.12.2', 'fabric', 'liteloader').ok,
    false,
    'LiteLoader 只认 Forge',
  );

  /*
   * ★★ 这一行翻转过两次，最终状态是 `ok === true`：
   *   · 起初 `ok === true` 而**根本没有安装实现**（假承诺）；
   *   · 中间改成 `ok === false` + 理由是"我们还没做"（诚实）；
   *   · dev.4 第二轮：安装真的做出来了（`net::liteloader`，照 PCL 的
   *     `McDownloadLiteLoaderLoader`），并有真机测试证明装完能进游戏
   *     （`tests/live_liteloader.rs`）—— 所以现在可以放行。
   *
   *   注意理由里**不该**再出现"我们没做" —— 那是过去的说法。
   */
  const lite = addonCompatibility('1.12.2', 'forge', 'liteloader');
  assert.equal(lite.ok, true, 'dev.4 起 LiteLoader 安装已实装，组合应该放行');
  assert.doesNotMatch(
    lite.note ?? '',
    /还没做|没做/,
    '实现已经有了，文案不该还说"我们没做"',
  );
});

test('LiteLoader 在 1.16.5 上不可用（版本区间限制）', () => {
  const r = addonCompatibility('1.16.5', 'forge', 'liteloader');
  assert.equal(r.ok, false);
});

test('自动安装的东西必须出现在 warnings 里', () => {
  const v = validateCombination({ mcVersion: '1.20.1', base: 'fabric', addons: [] });
  assert.equal(v.autoApis.length, 1);
  assert.ok(v.warnings.some((w) => /Fabric API/.test(w)));
});

/*
 * ★★ 2026-09-24（B-3 修复）：这条测试原来断言的是**相反**的结论
 *   （`autoApis[0].kind === 'quilted-fabric-api'`），而 Rust 那边的
 *   `quilt_gets_no_api_library` 断言"什么都不装" —— 两条测试互相钉着相反的结论。
 *   按用户 2026-09-15 的决定「不给 Quilt 装 API 了」，TS 这一侧改过来。
 */
test('Quilt 不自动装任何 API（用户 2026-09-15 的决定，两侧一致）', () => {
  const v = validateCombination({ mcVersion: '1.20.1', base: 'quilt', addons: [] });
  assert.equal(v.autoApis.length, 0, 'Quilt 不该自动装 API：' + JSON.stringify(v.autoApis));
  assert.ok(
    !v.warnings.some((w) => /Quilted Fabric API/.test(w)),
    '也不该在警告里承诺会自动装 QFAPI：' + JSON.stringify(v.warnings),
  );
});

/* ====================== 26.x 这一代（用户报的 bug） ====================== */

test('没有在线数据时，绝不说加载器「未发布」', () => {
  /*
   * ★ 回归用户原话：「什么叫 Forge 没发布 26.2 版本，PCL 是有的」
   *
   *   根因：内置表只有 10 个版本、没有 26.2；在线清单没拿到时代码掉进
   *   「表里没有 → 尚未发布」这条路径，把"我不知道"写成了"它没有"。
   *   而实测 BMCLAPI 的 /forge/minecraft/26.2 有 14 个 build（65.0.0…65.1.3）。
   *
   *   现在：没有在线数据 → 一律 confirmed=false + available=false，
   *   理由必须说清是"没查到"，**不许出现"未发布""尚未发布"**。
   */
  for (const v of ['26.2', '26.1.2', '1.20.5']) {
    const caps = getLoaderCapabilities(v);
    for (const o of caps.baseLoaders) {
      if (o.available) continue;
      assert.equal(o.confirmed, false, `${v} 的 ${o.kind} 没有在线数据，不该自称确认`);
      assert.doesNotMatch(
        o.unavailableReason ?? '',
        /未发布|尚未发布/,
        `${v} 的 ${o.kind} 把"没查到"说成了"未发布"：${o.unavailableReason}`,
      );
      assert.match(o.unavailableReason ?? '', /没查到|在线/, `${v} 的 ${o.kind} 理由要说清是没查到`);
    }
  }
});

test('26.2 的真实 Forge 版本来自在线清单（有就是有）', () => {
  // 实测：BMCLAPI 的 26.2 有 65.0.0 … 65.1.3
  const caps = getLoaderCapabilities('26.2', { bases: { forge: ['65.1.3', '65.1.2', '65.1.1'] } });
  const forge = caps.baseLoaders.find((b) => b.kind === 'forge');
  assert.equal(forge.available, true, '在线清单里有 Forge 就必须能选');
  assert.equal(forge.confirmed, true);
  assert.deepEqual(forge.versions, ['65.1.3', '65.1.2', '65.1.1']);
  assert.equal(forge.unavailableReason, undefined);
});

test('在线确认没有时才敢说「未发布」', () => {
  // 在线清单明确返回空 = 确认没有（这才是唯一可以说"未发布"的场合）
  const caps = getLoaderCapabilities('1.20.1', { bases: { neoforge: [] } });
  const neo = caps.baseLoaders.find((b) => b.kind === 'neoforge');
  assert.equal(neo.available, false);
  assert.equal(neo.confirmed, true);
  assert.match(neo.unavailableReason, /1\.20\.1/);
});

test('组合校验收到了"没查到"时不许下结论', () => {
  // 没有在线数据 + 用户选了 Forge → 报的必须是"无法确认"，不是"没有发布"
  const v = validateCombination({ mcVersion: '26.2', base: 'forge', addons: [] });
  assert.equal(v.valid, false);
  const all = v.errors.join('；');
  assert.doesNotMatch(all, /未发布|尚未发布/, `把"没查到"报成了"没有"：${all}`);
  assert.match(all, /无法确认|没查到/);
});

/* ====================== OptiFine × Forge 五级判定 ====================== */

test('Forge 精确比较：1.20.1 要求 47.2.0', () => {
  assert.equal(optifineSuitsForge('1.20.1', '47.2.0').ok, true);
  assert.equal(optifineSuitsForge('1.20.1', '47.1.0').ok, false);
});

test('Forge revision 比较：1.16.5 只比末段', () => {
  assert.equal(optifineSuitsForge('1.16.5', '36.2.39').ok, true);
  assert.equal(optifineSuitsForge('1.16.5', '36.1.0').ok, false);
});

test('Forge 无限制：1.12.2 的 req 是空串', () => {
  assert.equal(optifineSuitsForge('1.12.2', '14.23.5.2860').ok, true);
});

test('Forge 不支持：1.7.10 的 req 是 null', () => {
  assert.equal(optifineSuitsForge('1.7.10', '10.13.4.1614').ok, false);
});

/* ====================== 内存算法 ====================== */

test('档位映射与原版一致（档12→1.5 / 档25→8 / 档33→16）', () => {
  assert.equal(gearToGb(12), 1.5);
  assert.equal(gearToGb(25), 8);
  assert.equal(gearToGb(33), 16);
});

test('档位映射单调不减', () => {
  let prev = -1;
  for (let v = 0; v <= maxGear(32); v++) {
    const gb = gearToGb(v);
    assert.ok(gb >= prev - 1e-9, `档 ${v} 出现回退: ${gb} < ${prev}`);
    prev = gb;
  }
});

test('自动分配随 Mod 数递增', () => {
  const few = autoMemory(0, 'modded', 32, 16).gb;
  const many = autoMemory(200, 'modded', 32, 16).gb;
  assert.ok(many > few, `${many} 应大于 ${few}`);
});

test('★ 自动分配绝不超发：可用内存不足时以可用值为上限', () => {
  // 这是修掉原设计稿 bug 的回归测试
  const r = autoMemory(24, 'modded', 8, 1.5);
  assert.ok(r.gb <= 1.5 + 1e-9, `分配 ${r.gb} GB 超过了可用 1.5 GB`);
  assert.equal(r.detail.cappedByAvailable, true);
});

test('可用内存远大于需求时不触碰上限', () => {
  const r = autoMemory(24, 'modded', 32, 24);
  assert.ok(r.gb > 2, `内存充裕时应给到 2 GB 以上，实际 ${r.gb}`);
  assert.ok(r.gb <= 24);
});

test('可用内存只有 1 GB 时不会给出超过 1 GB 的建议', () => {
  const r = autoMemory(0, 'vanilla', 8, 1);
  assert.ok(r.gb <= 1 + 1e-9, `分配 ${r.gb} GB 超过了可用 1 GB`);
});

test('依据文案里的数字与真实结果一致（原稿写死 2.7 是错的）', () => {
  const r = autoMemory(24, 'modded', 7.9, 3.2);
  const text = memoryReasoning(24, r);
  assert.ok(text.includes(String(r.gb)), '依据文案里应出现真实分配值');
  assert.match(text, /3\.2 GB/);
});

test('内存三分段自洽：已用 + 游戏 + 空闲 = 总量', () => {
  const bar = memoryBar(2.5, 7.9, 3.2);
  assert.ok(Math.abs(bar.usedGb + bar.gameGb + bar.freeGb - bar.totalGb) < 0.11);
});

test('请求值超过可用内存时标出 overAvailable，且游戏段按可用值封顶', () => {
  const bar = memoryBar(6, 8, 2);
  assert.equal(bar.overAvailable, true);
  assert.equal(bar.gameGb, 2);
});

test('★ 滑块档位与显示值一致（原稿手柄 1.7 / 数字 2.5 对不上）', () => {
  const raw = autoMemory(24, 'modded', 7.9, 3.2).gb;
  const snapped = snapToGear(raw, 7.9);
  const gear = gbToGear(raw, 7.9);
  assert.equal(gearToGb(gear), snapped, `档位 ${gear} 对应 ${gearToGb(gear)}，与显示值 ${snapped} 不一致`);
  assert.ok(Math.abs(snapped - raw) <= 0.6, `吸附偏差过大：${raw} → ${snapped}`);
});

/* ====================== Java 规则 ====================== */

test('MC 基线：1.20.5+ 要 21，1.18~1.20.4 要 17，1.12~1.16.5 要 8', () => {
  assert.equal(resolveJavaRequirement({ mcVersion: '1.21.1', hasForgeLike: false, modCount: 0, hasOptifine: false }).major, 21);
  assert.equal(resolveJavaRequirement({ mcVersion: '1.20.1', hasForgeLike: false, modCount: 0, hasOptifine: false }).major, 17);
  assert.equal(resolveJavaRequirement({ mcVersion: '1.16.5', hasForgeLike: false, modCount: 0, hasOptifine: false }).major, 8);
});

/*
 * ★★ 两位数主版本号（26.2）：**显示**与**判定**必须都是 25，不许是 8。
 *
 *   用户报的：「我的 26.2 给我显示要 java8，虽然游戏能打开，但这毕竟不对」。
 *
 *   根因：`1.20.5+ → 21 / 1.17+ → 17 / 其余 → 8` 这条老逻辑被抄了三份
 *   （`InstanceOverview.tsx` / `LaunchPage.tsx` / `bridge/tauri.ts`），
 *   三份都只取 `mcVersion.split('.')[0]` 当 major —— 于是 `26.2` 的 major
 *   是 **26 而不是 1**，所有 `major === 1 && …` 的分支全不成立，
 *   落到最后那个 `return 8`。
 *
 *   启动没坏只是因为 Rust 侧以版本 JSON 的 `javaVersion` 为准。
 *
 *   现在三份都删了，统一走 `displayJavaMajor`（= 同一个规则引擎）。
 */
test('★ 26.2 显示 Java 25，不是 8（两位数主版本号）', () => {
  // 26.2 的版本 JSON 里 Mojang 写着 "javaVersion": {"majorVersion": 25}
  const req = resolveJavaRequirement({
    mcVersion: '26.2',
    hasForgeLike: false,
    modCount: 0,
    hasOptifine: false,
    mojangJavaVersion: 25,
  });
  assert.equal(req.major, 25, `26.2 应该要 Java 25，实际 ${req.major}`);

  // 26.2 + Forge 也必须 >= 25（Forge 65 的 profile 带 Java 24+ 的 VM 选项）
  const forge = resolveJavaRequirement({
    mcVersion: '26.2',
    hasForgeLike: true,
    modCount: 0,
    hasOptifine: false,
    mojangJavaVersion: 25,
  });
  assert.ok(forge.major >= 25, `26.2 + Forge 至少要 25，实际 ${forge.major}`);

  /*
   * ★ 再钉一次"界面用的那个函数"本身 —— 它是唯一入口。
   */
  assert.equal(
    displayJavaMajor({
      mcVersion: '26.2',
      hasForgeLike: false,
      modCount: 0,
      hasOptifine: false,
      mojangJavaVersion: 25,
    }),
    25,
  );

  // 26.1.x 也是两位数主版本号，同样不能掉进 `return 8`
  assert.ok(
    displayJavaMajor({
      mcVersion: '26.1.1',
      hasForgeLike: false,
      modCount: 0,
      hasOptifine: false,
    }) >= 21,
    '26.1.1 不该被判成 Java 8',
  );
});

/*
 * ★ 三个曾经各写一份的地方，现在必须都**不存在**了。
 *
 *   这是"判据只准有一处"的守门测试：源码里再出现那种手写判定就直接红。
 *   实测教训：`net.minecraftforge:forge` 的前缀判据也写过两份，
 *   第一次只修了一处，界面照旧显示错版本。
 */
test('★ 源码里不许再有第二份「需要哪个 Java」的手写判定', async () => {
  const { readFileSync } = await import('node:fs');
  const files = [
    'src/pages/InstanceOverview.tsx',
    'src/pages/LaunchPage.tsx',
    'src/bridge/tauri.ts',
  ];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    assert.ok(
      !/function\s+neededJavaMajor/.test(src),
      `${f} 里又出现了本地 neededJavaMajor —— 判据只能有一处（domain/java.ts）`,
    );
    assert.ok(
      !/minor\s*>=\s*17/.test(src),
      `${f} 里又出现了手写的 Java 版本分支 —— 用 displayJavaMajor`,
    );
  }
});

/*
 * ★★ 「Mojang 在版本 JSON 里声明的 Java」必须真的参与计算。
 *
 *   只按版本号基线算的话，26.2 得到 21，而它真正需要 25 ——
 *   也就是"修好了显示 8，但显示成了 21"，**仍然是错的**。
 *   这个数只有版本 JSON 里有，必须从后端取。
 */
test('★ 26.2 的 Java 要求要读版本 JSON 里声明的 25（不是基线 21）', async () => {
  const { javaRequirementFor, __resetDeclaredJavaCache } = await import(
    '../src/domain/java-requirement.ts'
  );

  __resetDeclaredJavaCache();
  const input = { mcVersion: '26.2', hasForgeLike: false, modCount: 0, hasOptifine: false };

  // 声明值未知时：按版本号基线算（不崩、也不是 8）
  const before = javaRequirementFor(input);
  assert.notEqual(before.major, 8, '两位数主版本号不许掉进 return 8');

  // 显式传入声明值 → 必须采信
  const withDeclared = javaRequirementFor({ ...input, declaredJava: 25 });
  assert.equal(withDeclared.major, 25, `声明 25 就该是 25，实际 ${withDeclared.major}`);
  assert.ok(
    withDeclared.constraints.some((c) => c.rule === 'MOJANG_JAVA_VERSION'),
    '应该命中 MOJANG_JAVA_VERSION 这条约束',
  );

  // 小于 22 的声明值**不采信**（老版本 JSON 里可能是错的/过期的，PCL 也这么判）
  const low = javaRequirementFor({ mcVersion: '1.20.1', declaredJava: 8 });
  assert.ok(
    !low.constraints.some((c) => c.rule === 'MOJANG_JAVA_VERSION'),
    '声明值 < 22 时不该采信',
  );
});

/*
 * ★★ 这一组测试在 2026-09-14 改过，因为 Java 要求的算法整体换了：
 *
 *   以前是"规则表从上往下，**第一条命中的胜出**"，每条规则自带一个
 *   `rule` id 和一个区间。现在是照 PCL 的 `GetJavaRequirement`
 *   （`ModJava.vb` 128-265）改成**多条约束求交集**，所以：
 *     · 不再有"唯一命中的那条规则"，而是 `constraints` 列表；
 *     · `major` 的语义固定成"**满足全部约束的最低版本**"；
 *     · 实际挑哪个由 `pickJava` 决定（区间内从高往低挑）。
 *
 *   换算法的原因见 `resolveJavaRequirement` 的注释：
 *   老写法把下限和上限混在一个区间里，后写的规则**无法收紧前面写下的上限**，
 *   于是 26.2 + Forge 65.1.3 被派了 Java 21，
 *   而 Forge 65 的 `-XX:+UseCompactObjectHeaders` 需要 Java 24+ →
 *   游戏连日志都没写就崩了（用户报的「还没打开就报错崩溃」）。
 */

test('★ MODDED 规则只在装了 Forge 系时生效', () => {
  const base = { mcVersion: '1.20.1', modCount: 150, hasOptifine: false };
  const withForge = resolveJavaRequirement({ ...base, hasForgeLike: true });
  const without = resolveJavaRequirement({ ...base, hasForgeLike: false });
  const has = (r, id) => r.constraints.some((c) => c.rule === id);
  assert.equal(has(withForge, 'MODDED_MANY_MODS'), true, '装了 Forge 才该有这条');
  assert.equal(has(without, 'MODDED_MANY_MODS'), false, '纯原版不该有这条');
  // 两边都是 1.20.1 → 下限都是 17
  assert.equal(withForge.major, 17);
  assert.equal(without.major, 17);
});

test('装了 200+ Mod 的 Forge 系整合包：下限 17，且允许更高的 Java', () => {
  const r = resolveJavaRequirement({ mcVersion: '1.20.1', hasForgeLike: true, modCount: 250, hasOptifine: false });
  /*
   * ★ 语义变了：`major` 现在是"**最低要求**"（区间下限），不是"建议版本"。
   *   1.20.1 + 250 个 Mod → 至少 Java 17，但**不封顶** ——
   *   老实现封在 22，正是它挡住了 Forge 需要的新 Java。
   */
  assert.equal(r.major, 17);
  assert.equal(inJavaRange(17, r.range), true);
  assert.equal(inJavaRange(21, r.range), true, '★ 不该把 Java 21 挡在外面');
  assert.equal(inJavaRange(25, r.range), true, '★ 也不该把 Java 25 挡在外面');
});

test('OptiFine + 1.16.5 及更早走 Java 8 规则', () => {
  const r = resolveJavaRequirement({ mcVersion: '1.16.5', hasForgeLike: false, modCount: 0, hasOptifine: true });
  assert.equal(r.major, 8);
  assert.equal(inJavaRange(8, r.range), true);
  assert.equal(inJavaRange(17, r.range), false, 'OptiFine + 1.16.5 不能用 Java 17');
  assert.ok(
    r.constraints.some((c) => c.rule.startsWith('OPTIFINE')),
    `应该有 OptiFine 相关约束，实际：${r.constraints.map((c) => c.rule).join(', ')}`,
  );
});

/*
 * ★★ 用户报的「Forge 版 mc 还没打开就报错崩溃了」的回归测试。
 *
 *   现场三行：`Unrecognized VM option 'UseCompactObjectHeaders'`
 *   （Java 24 才有），而 26.2 的版本 JSON 写着 `javaVersion.majorVersion = 25`。
 */
test('★★ 26.2 + Forge：必须要求 Java 25，且**不能**接受 Java 21', () => {
  const input = {
    mcVersion: '26.2',
    hasForgeLike: true,
    forgeKind: 'forge',
    forgeVersion: '65.1.3',
    modCount: 0,
    hasOptifine: false,
    mojangJavaVersion: 25,
  };
  const r = resolveJavaRequirement(input);
  assert.equal(inJavaRange(25, r.range), true, `Java 25 必须在区间内：${r.range.min}+`);
  assert.equal(
    inJavaRange(21, r.range),
    false,
    '★★ Java 21 不能在区间内 —— 拿它启动就是那次崩溃',
  );

  // 真的去挑：本机有 8 / 21 / 25，必须挑到 25
  const pool = [
    { path: '/j8/java.exe', major: 8, version: '1.8.0_51', vendor: 'Oracle', arch: 'x64', source: 'system' },
    { path: '/j21/java.exe', major: 21, version: '21.0.7', vendor: 'Microsoft', arch: 'x64', source: 'system' },
    { path: '/j25/java.exe', major: 25, version: '25.0.3', vendor: 'Temurin', arch: 'x64', source: 'system' },
  ];
  const picked = pickJava('auto', pool, input);
  assert.equal(picked.runtime?.major, 25, `应该挑 Java 25，理由：${picked.reason}`);
});

test('Mojang 声明的 Java 版本小于 22 时不采信（老 JSON 里那个字段可能过期）', () => {
  const r = resolveJavaRequirement({
    mcVersion: '1.20.1',
    hasForgeLike: false,
    modCount: 0,
    hasOptifine: false,
    mojangJavaVersion: 17,
  });
  assert.equal(
    r.constraints.some((c) => c.rule === 'MOJANG_JAVA_VERSION'),
    false,
    '17 < 22，不该当成约束',
  );
  assert.equal(inJavaRange(21, r.range), true);
});

test('纯原版 1.12.2 仍然只能 Java 8（不能被放宽成 Java 25）', () => {
  const r = resolveJavaRequirement({ mcVersion: '1.12.2', hasForgeLike: false, modCount: 0, hasOptifine: false });
  assert.equal(inJavaRange(8, r.range), true);
  assert.equal(inJavaRange(25, r.range), false, '1.12.2 配 Java 25 是"能起但随时崩"');
});

test('区间解析：[17.0, 22.0) 含 17 不含 22', () => {
  const r = validateJavaRangeText('[17.0, 22.0)');
  assert.equal(r.ok, true);
  assert.equal(inJavaRange(17, r.range), true);
  assert.equal(inJavaRange(21, r.range), true);
  assert.equal(inJavaRange(22, r.range), false);
  assert.equal(inJavaRange(16, r.range), false);
});

test('区间解析：右侧闭区间给出两种改法（PCL2 的两种出路）', () => {
  const r = validateJavaRangeText('[17, 21]');
  assert.equal(r.ok, true);
  assert.match(r.hint, /21\)/);
  assert.match(r.hint, /22\)/);
});

test('区间解析：空区间给出可操作的建议', () => {
  const r = validateJavaRangeText('(21, 21)');
  assert.equal(r.ok, false);
  assert.match(r.error, /21/);
});

test('区间解析：非法输入有明确报错', () => {
  assert.equal(validateJavaRangeText('17-22').ok, false);
  assert.equal(validateJavaRangeText('[22, 17]').ok, false);
  assert.equal(validateJavaRangeText('(,)').ok, false);
});

test('Java 四模式：自动模式在区间内挑最高的那个', () => {
  const pool = [
    { path: 'C:/j8/javaw.exe', major: 8, version: '8.0.402', vendor: 'Zulu', arch: 'x64', source: 'system' },
    { path: 'C:/j17/javaw.exe', major: 17, version: '17.0.10', vendor: 'Temurin', arch: 'x64', source: 'system' },
    { path: 'C:/j21/javaw.exe', major: 21, version: '21.0.2', vendor: 'Temurin', arch: 'x64', source: 'system' },
  ];
  /*
   * ★ 断言从 17 改成 21 —— 这是**语义变化**，不是放宽：
   *
   *   1.20.1 的区间是 `>= 17`（不封顶），而 17 / 21 都在里面。
   *   老实现先找"等于建议版本 17"的，所以挑 17；
   *   新实现是"区间内挑最高的"，所以挑 21。
   *
   *   为什么新语义更对：**最高版本通常更稳、也更接近 Forge/Mojang
   *   真正期望的那个**。老语义（挑"建议版本"）在 26.2 + Forge 上
   *   直接导致了崩溃 —— 建议说 21、真实要求是 25。
   *   现在"要求"（区间）与"选择"（区间内最高）彻底分开了。
   */
  const pick = pickJava('auto', pool, { mcVersion: '1.20.1', hasForgeLike: false, modCount: 0, hasOptifine: false });
  assert.equal(pick.runtime?.major, 21);
  assert.equal(inJavaRange(17, pick.requirement.range), true, '17 仍在允许范围内');
  // 1.12.2 那种被封顶的版本，仍然只会挑到 8
  const old = pickJava('auto', pool, { mcVersion: '1.12.2', hasForgeLike: false, modCount: 0, hasOptifine: false });
  assert.equal(old.runtime?.major, 8, '★ 老版本不许挑新的 Java');
});

test('Java 四模式：整合包自带 Java（实例文件夹模式）', () => {
  const pool = [
    { path: 'inst/foo/java/bin/javaw.exe', major: 21, version: '21.0.2', vendor: 'Temurin', arch: 'x64', source: 'instance' },
  ];
  const pick = pickJava('instance-folder', pool, { mcVersion: '1.21.1', hasForgeLike: false, modCount: 0, hasOptifine: false });
  assert.equal(pick.runtime?.major, 21);
});

test('Java 四模式：找不到时给出可行动的说明', () => {
  const pick = pickJava('auto', [], { mcVersion: '1.21.1', hasForgeLike: false, modCount: 0, hasOptifine: false });
  assert.equal(pick.runtime, null);
  assert.match(pick.reason, /Java 21/);
});

/* ====================== 版本隔离三段判定 ====================== */

test('隔离：用户显式设置优先级最高', () => {
  const on = resolveIsolation({ mode: 'on', hasContent: false, globalDefault: 'shared' });
  assert.equal(on.isolated, true);
  assert.equal(on.source, 'user');
  const off = resolveIsolation({ mode: 'off', hasContent: true, globalDefault: 'isolated' });
  assert.equal(off.isolated, false);
  assert.equal(off.source, 'user');
});

test('隔离：自动模式按目录内容判定，并说出依据', () => {
  const r = resolveIsolation({ mode: 'auto', hasContent: true, globalDefault: 'shared' });
  assert.equal(r.isolated, true);
  assert.equal(r.source, 'content');
  assert.match(r.reason, /mods\/|saves\//);
});

test('隔离：目录为空时跟随全局默认', () => {
  const r = resolveIsolation({ mode: 'auto', hasContent: false, globalDefault: 'isolated' });
  assert.equal(r.source, 'global');
  assert.equal(r.isolated, true);
});

test('隔离：强制关闭必须给出污染后果警告', () => {
  const r = resolveIsolation({ mode: 'off', hasContent: true, globalDefault: 'shared' });
  assert.ok(r.warning);
  assert.match(r.warning, /污染|无法启动/);
});

test('隔离：整合包实例一律隔离', () => {
  const r = resolveIsolation({ mode: 'auto', hasContent: false, globalDefault: 'shared', fromModpack: true });
  assert.equal(r.isolated, true);
});

/* ====================== Mod 状态（核心源码事实） ====================== */

test('★ 启用判定只看扩展名，认 .zip', () => {
  assert.equal(isEnabled('sodium.jar'), true);
  assert.equal(isEnabled('pack.zip'), true);
  assert.equal(isEnabled('old.litemod'), true);
  assert.equal(isEnabled('sodium.jar.disabled'), false);
  assert.equal(isEnabled('mod.jar.old'), false);
  assert.equal(isEnabled('something.txt'), false);
});

test('禁用 = 加后缀，再启用能还原', () => {
  assert.equal(toggledName('sodium.jar', false), 'sodium.jar.disabled');
  assert.equal(toggledName('sodium.jar.disabled', true), 'sodium.jar');
  assert.equal(toggledName('mod.jar.old', true), 'mod.jar');
});

test('显示名剥掉禁用后缀与扩展名', () => {
  assert.equal(displayNameOf('sodium.jar.disabled'), 'sodium');
  assert.equal(displayNameOf('JEI 物品管理器.jar'), 'JEI 物品管理器');
});

test('扫描默认不递归子目录', () => {
  const files = [
    { fileName: 'a.jar', path: '/mods/a.jar', bytes: 1, mtimeMs: 1 },
    { fileName: 'sub/b.jar', path: '/mods/sub/b.jar', bytes: 1, mtimeMs: 1 },
  ];
  const entries = scanMods(files, { loaderKind: 'fabric', mcVersion: '1.20.1' });
  assert.equal(entries.length, 1);
});

test('扫描的唯一例外：Forge 且 MC<1.13 且目录名是版本号', () => {
  const files = [
    { fileName: '1.12.2/a.jar', path: '/mods/1.12.2/a.jar', bytes: 1, mtimeMs: 1 },
    { fileName: 'other/a.jar', path: '/mods/other/a.jar', bytes: 1, mtimeMs: 1 },
  ];
  const entries = scanMods(files, { loaderKind: 'forge', mcVersion: '1.12.2' });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].fileName, 'a.jar');
});

test('重复 Mod：一启用一禁用时保留启用的', () => {
  const files = [
    { fileName: 'sodium.jar', path: '/a', bytes: 100, mtimeMs: 1 },
    { fileName: 'sodium.jar.disabled', path: '/b', bytes: 100, mtimeMs: 2 },
  ];
  const entries = scanMods(files, { loaderKind: 'fabric', mcVersion: '1.20.1' });
  const groups = findDuplicates(entries);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].enabled?.path, '/a');
  assert.equal(groups[0].disabled.length, 1);
  assert.equal(groups[0].identicalContent, true);
});

test('哈希缓存 key 必须带 mtime 与 size', () => {
  const k1 = hashCacheKey({ fileName: 'a.jar', mtimeMs: 100, bytes: 10 });
  const k2 = hashCacheKey({ fileName: 'a.jar', mtimeMs: 200, bytes: 10 });
  assert.notEqual(k1, k2, '同名文件被替换后 key 必须变化，否则会拿到过期的反查结果');
});

test('状态判定优先级：禁用 > 前置库 > 可更新', () => {
  const base = { fileName: 'x.jar', path: '/x', bytes: 1, mtimeMs: 1, enabled: false };
  const s = judgeModState({
    entry: { ...base, remote: { source: 'modrinth', projectId: 'p', name: 'X', version: '1', gameVersions: ['1.20.1'], loaders: ['fabric'], isLibrary: true }, updateAvailable: true },
    instanceMcVersion: '1.20.1',
    instanceLoader: 'fabric',
    managedByModpack: false,
  });
  assert.equal(s.state, 'disabled');
});

test('可能不兼容必须带推断依据', () => {
  const s = judgeModState({
    entry: {
      displayName: 'Iris', fileName: 'iris.jar', path: '/i', bytes: 1, mtimeMs: 1, enabled: true,
      remote: { source: 'modrinth', projectId: 'p', name: 'Iris', version: '1.7.0', gameVersions: ['1.20.1'], loaders: ['fabric'], isLibrary: false },
    },
    instanceMcVersion: '1.20.4',
    instanceLoader: 'fabric',
    managedByModpack: false,
  });
  assert.equal(s.state, 'maybe-incompatible');
  assert.ok((s.evidence ?? []).length >= 2);
  assert.ok(s.evidence.some((e) => /1\.20\.1/.test(e)));
});

test('整合包管理的实例不显示"可更新"', () => {
  const s = judgeModState({
    entry: {
      displayName: 'Sodium', fileName: 's.jar', path: '/s', bytes: 1, mtimeMs: 1, enabled: true, updateAvailable: true,
      remote: { source: 'modrinth', projectId: 'p', name: 'Sodium', version: '0.5', gameVersions: ['1.20.1'], loaders: ['fabric'], isLibrary: false },
    },
    instanceMcVersion: '1.20.1',
    instanceLoader: 'fabric',
    managedByModpack: true,
  });
  assert.equal(s.state, 'fine');
});

test('筛选器自动隐藏空档，但选中项永远可见', () => {
  const entries = [
    { displayName: 'a', fileName: 'a.jar', path: '/a', enabled: true, bytes: 1, mtimeMs: 1 },
  ];
  const states = new Map([['/a', 'fine']]);
  const f = availableFilters(entries, states, 'can-update');
  assert.ok(f.some((x) => x.id === 'can-update'), '选中项必须可见');
  assert.ok(!f.some((x) => x.id === 'disabled'), '没有禁用项时不显示该筛选');
});

/* ====================== 版本比较与区间 ====================== */

test('版本比较能处理非三段式', () => {
  assert.equal(compareVersion('1.20.4', '1.20.1'), 1);
  assert.equal(compareVersion('1.20', '1.20.1'), -1);
  assert.equal(compareVersion('24w45a', '1.20.1'), 1);
});

test('Forge 版本匹配的两种方式', () => {
  assert.equal(forgeVersionSatisfies('47.2.0', '47.2.0'), true);
  assert.equal(forgeVersionSatisfies('47.2.0', '47.2.1'), false);
  assert.equal(forgeVersionSatisfies('36.2', '36.2.39'), true);
  assert.equal(forgeVersionSatisfies('', 'anything'), true);
});

test('通用区间解析与判定', () => {
  const r = parseRange('[17.0, 22.0)');
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(inRange(17, r.range), true);
    assert.equal(inRange(22, r.range), false);
  }
});

/* ============ ★★ B-1：更新 Mod 时该删掉哪些旧文件 ============ */

test('更新时只删**同一个 sha1** 的旧文件（B-1）', () => {
  const entries = [
    { displayName: 'sodium', fileName: 'sodium-0.5.8.jar', path: '/m/sodium-0.5.8.jar', enabled: true, bytes: 1, mtimeMs: 1, sha1: 'AAA' },
    { displayName: 'lithium', fileName: 'lithium-0.12.jar', path: '/m/lithium-0.12.jar', enabled: true, bytes: 1, mtimeMs: 1, sha1: 'BBB' },
  ];
  assert.deepEqual(oldFilesToDrop(entries, 'AAA', 'sodium-0.5.11.jar'), ['/m/sodium-0.5.8.jar']);
  // 别的 Mod 一个都不许动
  assert.equal(oldFilesToDrop(entries, 'AAA', 'sodium-0.5.11.jar').includes('/m/lithium-0.12.jar'), false);
});

test('★ 新文件名与旧文件同名时**不删**（否则会把刚下的新文件删掉）', () => {
  const entries = [
    { displayName: 'x', fileName: 'mod-1.0.jar', path: '/m/mod-1.0.jar', enabled: true, bytes: 1, mtimeMs: 1, sha1: 'AAA' },
  ];
  assert.deepEqual(oldFilesToDrop(entries, 'AAA', 'mod-1.0.jar'), []);
  // 大小写不同也算同名
  assert.deepEqual(oldFilesToDrop(entries, 'AAA', 'MOD-1.0.JAR'), []);
});

test('★ 同一个 sha1 有多份（用户放了两遍）→ 全删；没有 sha1 → 一个都不删', () => {
  const entries = [
    { displayName: 'a', fileName: 'a.jar', path: '/m/a.jar', enabled: true, bytes: 1, mtimeMs: 1, sha1: 'AAA' },
    { displayName: 'a', fileName: 'a副本.jar', path: '/m/a副本.jar', enabled: true, bytes: 1, mtimeMs: 1, sha1: 'AAA' },
    { displayName: 'u', fileName: 'u.jar', path: '/m/u.jar', enabled: true, bytes: 1, mtimeMs: 1 },
  ];
  assert.deepEqual(oldFilesToDrop(entries, 'AAA', 'a-2.0.jar').sort(), ['/m/a.jar', '/m/a副本.jar']);
  // 空 sha1 = "不知道要更新的是哪个文件" → 不许删任何东西（宁可留下旧文件）
  assert.deepEqual(oldFilesToDrop(entries, '', 'a-2.0.jar'), []);
});
