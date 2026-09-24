/**
 * 崩溃规则表的**两侧一致性**（C-8 的判据）
 * ------------------------------------------------------------------
 * 规则有两份实现：
 *   · Rust `src-tauri/src/domain/crash.rs`  → 被 `judge_crash` 用（游戏退出那条 toast 的判据）
 *   · TS   `src/domain/crash.ts`            → 被崩溃弹窗与日志页用
 *
 * 它们曾经漂移而**没有任何判据能发现**：36 条 vs 35 条、12 条 id 起名不同
 * （TS `out-of-memory-heap` / Rust `oom-heap` …）。
 *
 * 这份测试做两件事：
 *   ① **id 集合**必须一致（允许 `tests/crash-rules.cases.json` 里 `only` 明确写出的例外，
 *      并且例外必须能自证：写的原因要提到为什么另一边表达不了）；
 *   ② **行为一致**：`cases` 里同一段日志，TS 判出来的 rule id 必须与期望一致
 *      （Rust 那边由 `crash.rs` 里的测试读同一个文件断言 —— 两边红哪一边都说明漂移了）。
 *
 * 运行：node --test tests/crash-rules.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzeCrashLog } from '../src/domain/crash.ts';

const casesFile = JSON.parse(readFileSync('tests/crash-rules.cases.json', 'utf8'));
const tsSrc = readFileSync('src/domain/crash.ts', 'utf8');
const rsSrc = readFileSync('src-tauri/src/domain/crash.rs', 'utf8');

/** 从两侧源码里抽出规则 id（只认表里那一行，避免碰到别的同名串） */
function idsFrom(src, kind) {
  const anchor = kind === 'ts' ? 'id: ' : 'Rule { id: ';
  const re = kind === 'ts' ? /^\s*id: '([^']+)',$/gm : /Rule \{ id: "([^"]+)"/g;
  const start = src.indexOf(kind === 'ts' ? 'export const CRASH_RULES' : 'const RULES');
  const end =
    kind === 'ts'
      ? src.indexOf('export function analyzeCrashLog')
      : src.indexOf('pub struct CrashMatch');
  const block = src.slice(start, end);
  assert.ok(start >= 0 && end > start, `${kind} 的规则表没找到（锚点 ${anchor}）`);
  return [...block.matchAll(re)].map((m) => m[1]);
}

test('① 两侧的规则 id 集合必须一致（例外要在 cases.json 的 only 里写明）', () => {
  const ts = idsFrom(tsSrc, 'ts');
  const rs = idsFrom(rsSrc, 'rs');
  assert.ok(ts.length > 20, `TS 规则太少（${ts.length}），解析可能失效`);
  assert.ok(rs.length > 20, `Rust 规则太少（${rs.length}），解析可能失效`);

  const allowed = new Set(Object.keys(casesFile.only ?? {}));
  const onlyTs = ts.filter((i) => !rs.includes(i) && !allowed.has(i));
  const onlyRs = rs.filter((i) => !ts.includes(i) && !allowed.has(i));
  assert.deepEqual(onlyTs, [], '这些 id 只在 TS 里（漏了同步或没写进 only）');
  assert.deepEqual(onlyRs, [], '这些 id 只在 Rust 里（漏了同步或没写进 only）');

  // 例外必须真的只在一边（不能拿它掩盖"两边都有"或"两边都没有"）
  for (const id of allowed) {
    const inTs = ts.includes(id);
    const inRs = rs.includes(id);
    assert.notEqual(inTs, inRs, `${id} 已在两侧同步，请把它从 only 里删掉`);
  }
  console.log(`  TS ${ts.length} 条 / Rust ${rs.length} 条；例外 ${allowed.size} 条`);
});

test('② cases 里每段日志，TS 必须判出期望的 rule id', () => {
  const bad = [];
  for (const c of casesFile.cases) {
    const a = analyzeCrashLog(c.log, { offline: false });
    const got = a.matches.map((m) => m.rule.id);
    if (!got.includes(c.rule)) bad.push(`${c.rule} → 实际 [${got.join(', ')}]`);
  }
  assert.deepEqual(bad, [], '这些日志片段 TS 侧判错了：\n    ' + bad.join('\n    '));
  console.log(`  ${casesFile.cases.length} 条片段全部命中期望规则`);
});
