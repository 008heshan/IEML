/**
 * Java 要求规则：**跨语言判据表**（P0-7）
 * ------------------------------------------------------------------
 * ## 这条测试守的是什么
 *
 * 「这个版本需要 Java 几」有两份实现：
 *   · Rust `src-tauri/src/domain/java.rs` —— 启动时真的按它挑 Java；
 *   · TS   `src/domain/java.ts`            —— 界面显示与按键即校验用。
 *
 * 两份漂移的后果不是"显示不好看"，是**用户被两个答案骗**：
 * 界面上写着"需要 Java 17"、点启动却弹"本机没有落在 [25, ∞) 内的 Java"。
 * 这个仓库已经因为同类问题栽过（`26.2` 被算成需要 Java 8）。
 *
 * 所以这里和 Rust 侧**读同一份表**（`tests/java-rules.cases.json`），
 * 各跑各自的引擎，比对同一个期望区间：
 *   · 本文件 → `node --test tests/java-rules.test.mjs`
 *   · Rust   → `cargo test --lib domain::java`（java_rules_table_matches_rust_engine）
 * 谁的规则改了、另一边没跟上，**必红**。
 *
 * 表里的期望值全部来自 PCL 的 `ModJava.vb`（`GetJavaRequirement`）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  resolveJavaRequirement,
  formatJavaRange,
} from '../src/domain/java.ts';

const table = JSON.parse(readFileSync('tests/java-rules.cases.json', 'utf8'));

/** 与 Rust 侧 `JavaConstraintInput::with_loader` 同名同义（改一处必须改两处） */
function inputOf(c) {
  const kind = c.loader ?? null;
  return {
    mcVersion: c.mc,
    hasForgeLike: kind === 'forge' || kind === 'neoforge',
    forgeKind: kind === 'forge' || kind === 'neoforge' ? kind : null,
    // ★ Quilt 不算 Fabric（Quilt Loader 的版本号不是 Fabric 那一套）
    forgeVersion: kind === 'forge' || kind === 'neoforge' ? (c.loaderVersion ?? null) : null,
    fabricVersion: kind === 'fabric' ? (c.loaderVersion ?? null) : null,
    modCount: 0,
    hasOptifine: c.optifine ?? false,
    mojangJavaVersion: c.mojangJava ?? 0,
    isNonStandard: false,
  };
}

test('★ 跨语言判据表：TS 引擎逐条对上 PCL 的期望区间', () => {
  assert.ok(table.cases.length >= 20, `表里只有 ${table.cases.length} 条，太少了`);
  for (const c of table.cases) {
    const got = formatJavaRange(resolveJavaRequirement(inputOf(c)).range);
    assert.equal(got, c.expect, `${c.name}\n  期望 ${c.expect}，实际 ${got}`);
  }
});

/* ====================== 规则 id 两侧同名 ====================== */

test('★ 规则 id 两侧同名（改一边不改另一边 = 红）', () => {
  const rust = readFileSync('src-tauri/src/domain/java.rs', 'utf8');
  const ids = [
    'MC_1_20_5_PLUS',
    'MC_1_18_PLUS',
    'MC_1_17',
    'MC_1_12_TO_1_16',
    'MC_LEGACY_MAX_JAVA',
    'MC_LEGACY_MAX8',
    'MOJANG_JAVA_VERSION',
    'OPTIFINE_MAX8',
    'OPTIFINE_EXACT8',
    'OPTIFINE_MAX8_112',
    'OPTIFINE_MAX8_116',
    'FORGE_1_6_TO_1_7_2',
    'FORGE_LE_1_12',
    'FORGE_1_13_TO_1_14',
    'FORGE_1_15',
    'FORGE_1_16_OLD',
    'FORGE_1_16_NEW',
    'FORGE_1_17_1',
    'FORGE_1_18_OPTIFINE',
    'FORGE_1_19_4_OLD',
    'FORGE_1_19_4_TO_1_20_1',
    'NEOFORGE_1_20_1',
    'FABRIC_1_15_1_16',
    'FABRIC_1_18_PLUS',
    'FABRIC_LOADER_OLD',
    'MODDED_MANY_MODS',
  ];
  for (const id of ids) {
    assert.ok(
      rust.includes(`"${id}"`),
      `规则 ${id} 只在 TS 侧有 —— Rust 侧必须同名实现（铁律 1：校验规则只实现一次）`,
    );
  }
});

/**
 * ★★ 「两边都读同一份表」这件事本身也要能被验证。
 *
 *   否则有人把 Rust 侧的读取删掉、只留一句断言，这条防线就静默失效了
 *   （这个仓库最贵的一类 bug 就是"静默降级"）。
 */
test('★ Rust 侧确实读了同一份判据表', () => {
  const rust = readFileSync('src-tauri/src/domain/java.rs', 'utf8');
  assert.ok(
    rust.includes('java-rules.cases.json'),
    'Rust 侧的测试必须读 tests/java-rules.cases.json（否则两边各测各的，漂移照样发生）',
  );
});

/** 空区间的处理：两侧都必须**报出冲突**而不是悄悄取一边 */
test('要求互相冲突时要说出来（不是沉默取一侧）', () => {
  // 1.12.2 的基线给上限 12，而 Mojang 声明要求 25 → 交集为空
  const req = resolveJavaRequirement({
    mcVersion: '1.12.2',
    hasForgeLike: false,
    modCount: 0,
    hasOptifine: false,
    mojangJavaVersion: 25,
  });
  assert.match(req.reason, /冲突/, `应当报冲突，实际：${req.reason}`);
});

/** 便利函数：确认 formatJavaRange 的形状（Rust 的 VersionRange::format 与它逐字一致） */
test('formatJavaRange 的形状与 Rust 侧一致', () => {
  const cases = [
    [{ min: 17, max: null, minInclusive: true, maxInclusive: true }, '[17, )'],
    [{ min: 8, max: 12, minInclusive: true, maxInclusive: false }, '[8, 12)'],
    [{ min: null, max: 9, minInclusive: true, maxInclusive: false }, '(, 9)'],
    [{ min: 8, max: 8, minInclusive: true, maxInclusive: true }, '[8, 8]'],
  ];
  for (const [r, want] of cases) {
    assert.equal(formatJavaRange(r), want);
  }
});
