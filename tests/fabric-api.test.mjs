/**
 * Fabric API 支持范围 —— 判"这个版本能不能用 Fabric"的**跨语言判据**。
 * ------------------------------------------------------------------
 * ## 这条测试守的是什么
 *
 * 用户原话：「根据 Fabric API 支持版本来精确限制哪些版本有 Fabric 哪些没有」。
 *
 * 起因是一个真实的错配：以前"有没有 Fabric"只看 **Fabric 加载器**的在线清单。
 * 但**加载器存在 ≠ Fabric API 存在** —— 玩家装 Fabric 基本都是为了装依赖
 * Fabric API 的 Mod，所以加载器有、API 没有时，勾上 Fabric 只会得到一个
 * **装不了任何 Mod 的空壳**，而界面说它"可用"。
 *
 * ## 表在哪
 *
 * `src/domain/fabric-api-versions.json`（来源：MC百科 Fabric API 词条）。
 * **Rust 侧 `include_str!` 读的是同一个文件** —— 一份表两边读，不抄第二份。
 *
 *   · 本文档 → `node --test tests/fabric-api.test.mjs`
 *   · Rust   → `cargo test --lib domain::loader_caps`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  FABRIC_API_VERSIONS,
  isFabricApiVersion,
  fabricApiUnsupportedReason,
} from '../src/domain/fabric-api.ts';
import { getLoaderCapabilities } from '../src/domain/loader-caps.ts';

const table = JSON.parse(readFileSync('src/domain/fabric-api-versions.json', 'utf8'));

test('表本身：1.14 起的正式版共 48 个', () => {
  assert.equal(FABRIC_API_VERSIONS.length, 48);
  assert.equal(table.versions.length, 48);
  assert.equal(new Set(table.versions).size, 48, '不该有重复');
});

test('下界：1.14 是第一个，1.13.2 及以下都不在表里', () => {
  assert.ok(isFabricApiVersion('1.14'));
  assert.ok(!isFabricApiVersion('1.13.2'), '1.13.2 要走 Legacy Fabric API');
  assert.ok(!isFabricApiVersion('1.12.2'));
  assert.ok(!isFabricApiVersion('1.7.10'));
});

test('上界与中间不能有洞', () => {
  for (const v of ['26.3', '26.1', '1.21.11', '1.20.6', '1.19.1', '1.17.1']) {
    assert.ok(isFabricApiVersion(v), `${v} 在 MC百科清单里，不能漏`);
  }
});

test('理由必须给出替代方案，不能只说不行', () => {
  const r = fabricApiUnsupportedReason('1.12.2');
  assert.match(r, /1\.14/, '要说清从哪个版本起支持');
  assert.match(r, /Legacy Fabric/, '要说清低版本是另一套移植');
  assert.match(r, /Forge/, '★ 要给出这个版本上可行的替代');
});

/* ====================== 真正的那道闸 ====================== */

test('在线清单说有 Fabric 构建，但 API 不支持 → 必须判不可用', () => {
  // 1.12.2：Fabric 加载器**确实**有构建（真机查得到），所以在线清单非空
  const caps = getLoaderCapabilities('1.12.2', { bases: { fabric: ['0.16.9', '0.15.11'] } });
  const fabric = caps.baseLoaders.find((b) => b.kind === 'fabric');

  assert.ok(fabric, 'fabric 这一项要存在（界面要显示它并置灰）');
  assert.equal(fabric.available, false, '★ API 不支持就不能判可用');
  assert.match(fabric.unavailableReason ?? '', /1\.14/, '理由要说清从 1.14 起支持');
  assert.deepEqual(
    fabric.versions,
    ['0.16.9', '0.15.11'],
    '★ 版本号要留着 —— 让用户看出「加载器确实有，是 API 不支持」，而不是「没查到」',
  );
});

test('表里支持的版本：在线有构建就判可用', () => {
  const caps = getLoaderCapabilities('1.20.1', { bases: { fabric: ['0.16.9'] } });
  const fabric = caps.baseLoaders.find((b) => b.kind === 'fabric');
  assert.equal(fabric.available, true);
  assert.equal(fabric.unavailableReason, undefined);
});

test('★ 快照不走这道闸（否则就是误伤）', () => {
  /*
   * MC百科页面明确写着 Fabric API「也跟进最新快照版本开发」。
   * 表里只有正式版，所以快照不能拿表去拒 ——
   * "用户明明能装、我们不让"比"漏放一个"更糟。
   */
  const caps = getLoaderCapabilities('24w45a', { bases: { fabric: ['0.16.9'] } });
  const fabric = caps.baseLoaders.find((b) => b.kind === 'fabric');
  assert.equal(fabric.available, true, '快照上 Fabric 可用性交给在线清单');
});

test('这道闸只针对 Fabric，不牵连 Quilt / Forge', () => {
  const caps = getLoaderCapabilities('1.12.2', {
    bases: { fabric: ['0.16.9'], quilt: ['0.9.2'], forge: ['47.2.0'] },
  });
  const q = caps.baseLoaders.find((b) => b.kind === 'quilt');
  const f = caps.baseLoaders.find((b) => b.kind === 'forge');
  assert.equal(q.available, true, 'Quilt 有它自己的支持范围，不能拿 Fabric API 的表去卡');
  assert.equal(f.available, true, 'Forge 更不该被牵连');
});
