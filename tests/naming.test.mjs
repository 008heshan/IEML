/**
 * 目录名与版本名规范的**跨语言一致**测试（决定八）。
 * ------------------------------------------------------------------
 * ★★ 2026-09-30（用户：「游戏数据目录有些杂乱和不规范，按 PCL 的来规范一下」）
 *
 *   这条规范有两份实现：Rust `src-tauri/src/domain/naming.rs`（权威）与
 *   `src/domain/naming.ts`（浏览器 demo 模式的镜像）。两边都跑
 *   `tests/naming-cases.json`，算出来必须**逐字一致**。
 *
 *   为什么值得为它单开一个测试文件：这已经不是"好习惯"的问题 —— 真机上
 *   盘子里有**三种**名字（`26.3-fabric-0.19.5` / `fabric-loader-0.19.5-26.3` /
 *   `vanilla-262`），而账本里的 slug 拼不出磁盘目录，导致
 *   "拿 slug 判目录在不在"把所有版本都判成了不存在。
 *   Rust 那一半由 `domain::naming::tests::the_shared_case_table_holds` 跑同一张表。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(readFileSync(join(here, 'naming-cases.json'), 'utf8'));

const {
  sanitizeDirName,
  versionDirName,
  versionDisplayName,
  uniqueDirName,
  parseDirName,
  loaderLabel,
} = await import('../src/domain/naming.ts');

/** 用例里的成分 → `VersionParts` */
function parts(c) {
  return {
    mcVersion: c.mc ?? '',
    loader: c.loader ? { kind: c.loader, version: c.loaderVersion ?? '' } : null,
    addons: (c.addons ?? []).map((a) => ({ kind: a.kind, version: a.version })),
  };
}

test('目录名：规范的写法（与 Rust 逐字一致）', () => {
  assert.ok(cases.dir.length >= 10, '用例表不能是空的');
  for (const c of cases.dir) {
    const got = versionDirName(parts(c));
    assert.equal(got, c.want, `用例 ${JSON.stringify(c)}`);
  }
});

test('显示名：Minecraft <版本> + <加载器> <版本>', () => {
  for (const c of cases.display) {
    assert.equal(versionDisplayName(parts(c)), c.want, `用例 ${JSON.stringify(c)}`);
  }
});

test('清洗：非法字符被换掉，而不是让目录建不出来', () => {
  for (const c of cases.sanitize) {
    assert.equal(sanitizeDirName(c.raw), c.want, `用例 ${JSON.stringify(c)}`);
  }
});

test('去重：撞名时加 -2 / -3，且大小写无关', () => {
  for (const c of cases.unique) {
    assert.equal(uniqueDirName(c.base, c.taken), c.want, `用例 ${JSON.stringify(c)}`);
  }
});

test('反解：能反解的才敢改名（反解不出来的一律 null）', () => {
  for (const c of cases.parse) {
    const got = parseDirName(c.dir);
    if (c.want === null) {
      assert.equal(got, null, `${c.dir} 应当反解不出来`);
      continue;
    }
    assert.ok(got, `${c.dir} 应当能反解`);
    assert.equal(got.mcVersion, c.want.mc, `${c.dir} 的 mc 版本`);
    assert.equal(
      got.loader?.kind ?? null,
      c.want.loader,
      `${c.dir} 的加载器种类`,
    );
    if (c.want.loaderVersion != null) {
      assert.equal(got.loader?.version, c.want.loaderVersion, `${c.dir} 的加载器版本`);
    }
  }
});

/**
 * ★★ 这条是**这一轮修复的核心断言**：真机上那三种目录名，谁该被改成什么。
 *
 *   它把"我们到底打算怎么规范用户的现有数据"写成可执行的形式 ——
 *   与 Rust 侧 `canonical_dir_name_for` 的判据同源（优先读 JSON 的
 *   `inheritsFrom`，读不到才退回目录名反解）。
 */
test('真机上的三种名字：规范化后的结果', () => {
  // ① 已经规范的 → 不动
  assert.equal(versionDirName(parseDirName('26.3-fabric-0.19.5')), '26.3-fabric-0.19.5');
  // ② 老的 `vanilla-262`：反解不出 mc 版本 → 保留原名（不猜）
  const old = parseDirName('vanilla-262');
  assert.equal(old.mcVersion, 'vanilla-262');
  assert.equal(versionDirName(old), 'vanilla-262', '★ 反解不出来就保留原名，绝不猜着改');
  // ③ PCL 那种 `fabric-loader-0.19.5-26.3` → 规范成 `26.3-fabric-0.19.5`
  const pcl = parseDirName('fabric-loader-0.19.5-26.3');
  assert.equal(pcl.mcVersion, '26.3');
  assert.equal(pcl.loader.kind, 'fabric');
  assert.equal(pcl.loader.version, '0.19.5', '★ 加载器版本不能丢');
  assert.equal(versionDirName(pcl), '26.3-fabric-0.19.5');
});

test('加载器显示名与 instance-name.ts 同源', () => {
  assert.equal(loaderLabel('forge'), 'Forge');
  assert.equal(loaderLabel('neoforge'), 'NeoForge');
  assert.equal(loaderLabel('fabric'), 'Fabric');
  assert.equal(loaderLabel('quilt'), 'Quilt');
  // 认不出的原样返回（不许编一个中文名出来）
  assert.equal(loaderLabel('unknown-loader'), 'unknown-loader');
});
