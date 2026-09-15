/**
 * 加载器目录的回归测试（`src/domain/loader-catalog.ts`）
 * ------------------------------------------------------------------
 * 用法：`node --test tests/loader-catalog.test.mjs`
 *
 * ★ 为什么单独测这个文件：用户报「该有 Forge 的版本还是没有 Forge」，
 *   而后端实测 11 个版本全部正常返回 Forge —— 问题就出在这个缓存上。
 *
 *   当时的 bug：`ensure()` 把**部分失败**的记录（Forge 超时、Fabric 成功）
 *   也当成有效结果收下，`isFresh()` 只看时间戳，于是这条记录
 *   被当成"新鲜有效"用 1 小时、还被写进 localStorage 存活 24 小时。
 *   一次瞬时失败 = 用户这一天都看到"没查到 Forge"。
 *
 *   这里的断言就是钉住这两条：**带 errors 的记录既不新鲜、也不落盘**。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

/* ---------- 最小 localStorage 桩（目录用它在浏览器里持久化） ---------- */
class MemStorage {
  constructor() {
    this.map = new Map();
  }
  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null;
  }
  setItem(k, v) {
    this.map.set(k, String(v));
  }
  removeItem(k) {
    this.map.delete(k);
  }
}
const storage = new MemStorage();
globalThis.localStorage = storage;

const { loaderCatalog, CATALOG_TTL_MS } = await import('../src/domain/loader-catalog.ts');
const { getLoaderCapabilities, ADDON_INSTALL_IMPLEMENTED } = await import(
  '../src/domain/loader-caps.ts'
);

const KEY = 'ieml.loaderCatalog.v2';

/** 造一个"像后端返回的那样"的结果 */
function payload({ forgeError = null, forgeVersions = ['47.4.23'] } = {}) {
  return {
    base: [
      forgeError
        ? { kind: 'forge', versions: [], error: forgeError }
        : { kind: 'forge', versions: forgeVersions, error: null },
      { kind: 'fabric', versions: ['0.15.11'], error: null },
      { kind: 'neoforge', versions: [], error: null },
      { kind: 'quilt', versions: [], error: null },
    ],
    addons: [
      {
        kind: 'optifine',
        versions: ['HD U I6'],
        error: null,
        optifine: [{ version: 'HD U I6', filename: 'x.jar', preview: false, required_forge: '47.2.18' }],
      },
    ],
  };
}

test('部分失败的结果：不新鲜、不进 localStorage、下次必然重查', async () => {
  storage.map.clear();

  // 第一次：Forge 失败（超时），其余成功
  const rec = await loaderCatalog.ensure('1.20.1', async () => payload({ forgeError: '超时' }));

  assert.equal(rec.errors.forge, '超时', '失败原因要留住，界面才能如实显示');
  assert.equal(rec.bases.fabric?.length, 1, '成功的那部分照样要有');

  assert.equal(
    loaderCatalog.isFresh('1.20.1'),
    false,
    '★ 带 errors 的记录**不许**算新鲜 —— 否则一次瞬时失败会被用满整个 TTL',
  );
  assert.equal(
    storage.getItem(KEY),
    null,
    '★ 带 errors 的记录**不许**落盘 —— 否则重启后依然显示"没查到"，用户连重试的机会都没有',
  );
});

test('再查一次会真的重新请求（不吃那份失败缓存）', async () => {
  let calls = 0;
  const rec = await loaderCatalog.ensure('1.20.1', async () => {
    calls += 1;
    return payload(); // 这次成功
  });
  assert.equal(calls, 1, '必须真的又打了一次接口');
  assert.deepEqual(rec.errors, {}, '这次没有失败项');
  assert.deepEqual(rec.bases.forge, ['47.4.23']);
});

test('全部查到的结果：算新鲜，并且真的落盘了', () => {
  assert.equal(loaderCatalog.isFresh('1.20.1'), true);
  const raw = storage.getItem(KEY);
  assert.ok(raw, '全部成功的记录应当落盘');
  const parsed = JSON.parse(raw);
  assert.deepEqual(parsed['1.20.1'].bases.forge, ['47.4.23']);
  // OptiFine 的完整信息（preview / required_forge）不能丢
  assert.equal(parsed['1.20.1'].addons.optifine[0].preview, false);
  assert.equal(parsed['1.20.1'].addons.optifine[0].required_forge, '47.2.18');
});

test('「确认没有」是有效结论，不会被当成失败反复重查', async () => {
  // 1.20.1 没有 NeoForge → versions 为空、error 为 null
  let calls = 0;
  await loaderCatalog.ensure('1.99.9', async () => ({
    base: [
      { kind: 'forge', versions: [], error: null }, // 确认没有
      { kind: 'fabric', versions: ['0.15.11'], error: null },
    ],
    addons: [],
  }));
  calls += 1;
  assert.equal(loaderCatalog.isFresh('1.99.9'), true, '确认没有也是"查到了"，算新鲜');
  const again = await loaderCatalog.ensure('1.99.9', async () => {
    calls += 1;
    return payload();
  });
  assert.equal(calls, 1, '命中新鲜缓存就不该再打接口');
  assert.deepEqual(again.bases.forge, [], '空数组是"确认没有"，不能被改成别的');
});

test('TTL 过期后不再新鲜', () => {
  const rec = loaderCatalog.get('1.20.1');
  assert.ok(rec);
  // 手动把时间戳拨到 TTL 之外
  rec.fetchedAt = Date.now() - CATALOG_TTL_MS - 1000;
  assert.equal(loaderCatalog.isFresh('1.20.1'), false, '过期的记录必须重查');
});

test('没查过的版本：get 返回 null（"还没查到" ≠ "没有"）', () => {
  assert.equal(loaderCatalog.get('3.14.15'), null);
  assert.equal(loaderCatalog.isFresh('3.14.15'), false);
});

test('重新载入时会丢掉"被错误持久化"的失败记录', async () => {
  /*
   * 复现修好之前留下的脏缓存：一条带 errors 的记录被写进了 localStorage。
   * 下一次启动读盘时必须丢掉它 —— 否则界面会继续显示上次那份失败结果，
   * 用户看到的就是"该有 Forge 的版本还是没有 Forge"。
   *
   * ★ 怎么在测试里"重启"：模块级单例没法重建，所以这里用一个**新的模块实例**
   *   （带 query 后缀的动态 import 会拿到一份新的模块 registry 条目）
   *   来模拟下一次启动。
   */
  storage.setItem(
    KEY,
    JSON.stringify({
      '1.20.1': {
        bases: { fabric: ['0.15.11'] },
        errors: { forge: '超时' }, // ← 脏记录
        fetchedAt: Date.now(),
      },
      '1.19.2': {
        bases: { forge: ['43.3.0'] },
        errors: {}, // ← 干净记录
        fetchedAt: Date.now(),
      },
    }),
  );

  const fresh = await import('../src/domain/loader-catalog.ts?restart=1');
  assert.equal(
    fresh.loaderCatalog.get('1.20.1'),
    null,
    '带 errors 的脏记录必须被丢掉，让它重查',
  );
  assert.deepEqual(
    fresh.loaderCatalog.get('1.19.2')?.bases.forge,
    ['43.3.0'],
    '干净的记录要留着（不能被误删）',
  );
  // 盘上也要被清干净
  const onDisk = JSON.parse(storage.getItem(KEY) ?? '{}');
  assert.equal(onDisk['1.20.1'], undefined, '脏记录也要从 localStorage 里清掉');
  assert.ok(onDisk['1.19.2'], '好记录留在盘上');
});

/* ==================================================================
 * "能装就是能装，不能装就是不能装"
 *
 * 用户的原话。这条规则在代码里对应两个**必须分开**的字段：
 *   exists      —— 上游有没有发布这个 MC 版本的版本？
 *   implemented —— **IEML 自己实现安装了吗**？
 *
 * 混在一起时出现过的真实 bug：静态表里写着 LiteLoader 在 1.12.2 可用，
 * 用户勾选 → 点安装 → 界面报成功 → **磁盘上什么都没发生**
 * （Rust 侧只有磁盘识别，没有 LiteLoader 安装实现）。
 *
 * ★★ dev.4 第二轮：两个附加组件的安装**都实装了**，所以这组断言
 *   从"不许说成能装"翻转为"现在真的能装"，但仍然守着那条分界：
 *   **`available` 必须始终等于 `exists && implemented` —— 谁都不许越权。**
 * ================================================================== */

test('附加组件：上游"有"和我们"能装"必须分开表达（现在两个都真能装）', () => {
  // 1.12.2 上 LiteLoader 确实存在（静态表有它、组合校验也认这个版本段）
  const caps = getLoaderCapabilities('1.12.2');
  const lite = caps.addons.find((a) => a.kind === 'liteloader');
  assert.ok(lite, '1.12.2 上应当列出 LiteLoader 这一项');
  assert.equal(lite.exists, true, '它确实存在 —— 不许说成"这个版本没有"');
  assert.equal(
    lite.implemented,
    true,
    'dev.4 起 LiteLoader 的安装已实装（net::liteloader，真机测试证明能进游戏）',
  );
  assert.equal(
    lite.available,
    lite.exists && lite.implemented,
    '★ 最终结论必须严格等于 exists && implemented —— 这是那条分界的表达式',
  );
});

test('★ available 永远等于 exists && implemented（前后端同一张表）', () => {
  for (const mc of ['1.7.10', '1.12.2', '1.20.1', '1.21.1']) {
    for (const a of getLoaderCapabilities(mc).addons) {
      // ★ 这条断言与实现状态无关 —— 它是那条**定义**：
      //   "能装" = 上游有 且 我们做了。任何一边不成立都不许标成可用。
      assert.equal(
        a.available,
        a.exists && a.implemented,
        `${mc} 的 ${a.name}：available 必须严格等于 exists(${a.exists}) && implemented(${a.implemented})`,
      );
      if (a.implemented === false) {
        assert.equal(
          a.available,
          false,
          `${mc} 的 ${a.name} 没有安装实现，却被标成可用 —— 这正是"做不到却承诺"`,
        );
      }
      // 有在线 OptiFine 清单时 available 由清单决定，这里只查 implemented 标记
      if (a.available) {
        assert.notEqual(
          a.implemented,
          false,
          `${mc} 的 ${a.name} 标成可用，却没有安装实现`,
        );
      }
    }
  }
});

test('ADDON_INSTALL_IMPLEMENTED 与 Rust 侧登记的现状一致', () => {
  /*
   * ★★ 这个值改过三轮，每轮都有实测理由：
   *   · 起初 `optifine: true` —— **假的**（全仓库没有安装实现），
   *     界面于是承诺做不到的事（用户报"显示有，点击后不让选"）；
   *   · dev.3 两个都改成 `false` —— 诚实，但功能确实没有；
   *   · dev.4 两个都改成 `true` —— **这次是真的**。
   *
   *   真机证据（每一项都真的跑过）：
   *     `tests/live_optifine.rs`         下载安装器 + 跑 Patcher + 校验产物
   *     `tests/live_optifine_launch.rs`  装完真的启动、活过 30 秒，
   *                                      日志里 ConnectedTextures 在工作
   *     `tests/live_liteloader.rs`       写版本描述 + 下三个 jar + 真的启动、
   *                                      活过 30 秒，LiteLoader 正常 bootstrap
   *
   *   ★ 改这里的**同时**必须改 Rust 的
   *     `domain::loader_caps::addon_install_implemented` —— 两边各有一条测试盯着。
   */
  assert.equal(ADDON_INSTALL_IMPLEMENTED.optifine, true);
  assert.equal(ADDON_INSTALL_IMPLEMENTED.liteloader, true);
});

/**
 * ★★ 缓存键必须跟着"解析规则"的修改一起升版本。
 *
 * 为什么值得一条测试（这是真实事故）：缓存里存的是**结论**，
 * 不只是原始数据。NeoForge 的旧逻辑把 `-beta` 全部过滤掉，
 * 于是 `26.1`（18 条全是 beta）被记成"**确认没有** NeoForge"并写进 localStorage。
 * 修好解析规则之后，那条**自信的错误结论**还在缓存里活着，
 * 用户升级了启动器看到的仍然是"没有 NeoForge"。
 *
 * 所以：v1 的键不许再被读写。
 */
test('缓存键已升到 v2（旧的错误结论不会被继续吃）', () => {
  assert.equal(KEY, 'ieml.loaderCatalog.v2');
  assert.equal(
    storage.getItem('ieml.loaderCatalog.v1'),
    null,
    'v1 的键不该被这个模块再写入',
  );
});
