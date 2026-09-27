#!/usr/bin/env node
/**
 * 版本号**怎么走**的判据 —— `docs/VERSIONING.md` §3.2.1（**用户 2026-09-27 定**）。
 * ------------------------------------------------------------------
 * 规则就一句：**只许动一位，低位一律归零**。
 *
 * ```text
 *   小修小改        → 修订位 +1    1.0.0 → 1.0.1 → … → 1.0.10
 *   大修大改        → 次版本 +1    1.0.7 → 1.1.0（修订位归零）
 *   下一个大版本    → 主版本 +1    1.4.2 → 2.0.0（后两位归零）
 * ```
 *
 * ## 为什么这条也要机器守
 *
 *   版本号是**给别人看的坐标**：用户报"1.0.3 有这个问题"，你得能指到唯一一个构建。
 *   手写版本号最常出的两种错，都属于"看起来没问题"：
 *     · **多进一位**：`1.0.9 → 1.1.0`（顺眼，但按规则该是 `1.0.10`）——
 *       于是"1.0.10 到 1.1.0 之间那些小修"全被吞进一个次版本号里；
 *     · **跳号/补零**：`1.0.11 → 1.2.0`、`1.0.09` —— 前者让 1.1.x 永远空着，
 *       后者同一个版本有两种写法。
 *   两个都只会在几个月后"查某个 bug 是哪个版本引入的"时才疼，所以现在钉住。
 *
 * ## 判据
 *
 *   ① 当前版本（`CHANGELOG.md` 最新一节）形状合法：`X.Y.Z`，可选阶段后缀（仅 0.x）；
 *   ② **主版本 ≥ 1 时不许带阶段后缀**（`1.0.0-rc.1` 是候选，`1.0.0` 才是正式版）；
 *   ③ 不许前导零（`1.0.09` ✗）；
 *   ④ 与**上一节**的版本号相比，恰好只动一位（或"去掉后缀"那一跳）。
 *      0.x 阶段仍允许 §3.2 里那几种阶段内/阶段间的走法（历史如此，不必改写）。
 *
 * 用法：
 *   node tools/gates/check-version-scheme.mjs              # 查真实 CHANGELOG
 *   node tools/gates/check-version-scheme.mjs <另外一份>    # 自查用（喂坏样本，证明它会红）
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = process.argv[2];
const FILE = arg ? (isAbsolute(arg) ? arg : resolve(ROOT, arg)) : join(ROOT, 'CHANGELOG.md');

const SHAPE = /^(\d+)\.(\d+)\.(\d+)(?:-(dev|alpha|beta|rc)\.(\d+))?$/;
const STAGES = ['dev', 'alpha', 'beta', 'rc'];

const text = readFileSync(FILE, 'utf8');
/** 变更记录里**每一节的版本号**，按文件顺序（新的在前） */
const versions = [...text.matchAll(/^## (\S+) —/gm)].map((m) => m[1]);

if (versions.length < 2) {
  console.error(`✗ 读不到两节以上的版本号（${FILE}）—— 判据要求至少有"当前"与"上一个"`);
  process.exit(1);
}

const problems = [];
const parse = (v) => {
  const m = v.match(SHAPE);
  if (!m) return null;
  return {
    raw: v,
    maj: Number(m[1]),
    min: Number(m[2]),
    pat: Number(m[3]),
    stage: m[4] ?? null,
    seq: m[5] ? Number(m[5]) : null,
  };
};

/* ---------- ① 形状：全部节都要认得（历史的阶段号也在内） ---------- */
for (const v of versions) {
  const p = parse(v);
  if (!p) {
    problems.push(`${v}：形状不合规（应为 X.Y.Z 或 X.Y.Z-阶段.序号）`);
    continue;
  }
  // ② 1.0.0 起不许带阶段后缀
  if (p.maj >= 1 && p.stage) {
    problems.push(`${v}：主版本 ≥ 1 不许带阶段后缀（正式大版本是 1.0.0，候选是 0.x 的事）`);
  }
  // ③ 前导零
  if (/\.0\d/.test(v) || /^0\d/.test(v)) {
    problems.push(`${v}：不许前导零（同一个版本两种写法）`);
  }
}

/* ---------- ④ 当前 vs 上一个：只许动一位 ---------- */
const cur = parse(versions[0]);
const prev = parse(versions[1]);
if (cur && prev) {
  const sameBase = cur.maj === prev.maj && cur.min === prev.min && cur.pat === prev.pat;
  const droppedSuffix = prev.stage && !cur.stage && sameBase;
  const patchStep = cur.maj === prev.maj && cur.min === prev.min && cur.pat === prev.pat + 1;
  const minorStep = cur.maj === prev.maj && cur.min === prev.min + 1 && cur.pat === 0;
  const majorStep = cur.maj === prev.maj + 1 && cur.min === 0 && cur.pat === 0;
  const sameStageStep =
    sameBase &&
    cur.stage &&
    prev.stage &&
    cur.stage === prev.stage &&
    cur.seq === prev.seq + 1;
  const stageJump =
    sameBase &&
    cur.stage &&
    prev.stage &&
    STAGES.indexOf(cur.stage) === STAGES.indexOf(prev.stage) + 1 &&
    cur.seq === 1;

  const ok =
    droppedSuffix ||
    patchStep ||
    minorStep ||
    majorStep ||
    (prev.maj === 0 && (sameStageStep || stageJump));

  if (!ok) {
    const what =
      `上一次是 ${prev.raw}，这一次是 ${cur.raw} —— 不是"只动一位"里的任何一种。`;
    const hint =
      prev.maj === 0
        ? '0.x 阶段允许：修订位 +1 / 次版本 +1（后位归零）/ 阶段序号 +1 / 进下一阶段 / 去掉后缀。'
        : `1.0.0 起只允许三种：修订位 +1（${prev.maj}.${prev.min}.${prev.pat + 1}）、` +
          `次版本 +1 且修订位归零（${prev.maj}.${prev.min + 1}.0）、` +
          `主版本 +1 且后两位归零（${prev.maj + 1}.0.0）。`;
    problems.push(`${what}\n      ${hint}`);
  }
}

if (problems.length === 0) {
  console.log(
    `✓ 版本号的走法合规：${versions[1]} → ${versions[0]}（只动一位，低位已归零；共 ${versions.length} 节）`,
  );
  process.exit(0);
}
console.error('✗ 版本号走法有问题：');
for (const p of problems) console.error(`    ${p}`);
console.error('\n  规则见 docs/VERSIONING.md §3.2.1；改号用 node tools/set-version.mjs --bump patch|minor|major');
process.exit(1);
