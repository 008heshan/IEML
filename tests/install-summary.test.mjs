/**
 * 整合包安装收尾的**三处文案**（`src/domain/install-summary.ts`）。
 * ------------------------------------------------------------------
 * ★★★★ 2026-10-17（用户：「装完了但缺 N 个文件」）：
 *
 *   后端现在把"缺了几个"和"整包能不能起来"分成两件事了
 *   （`ModpackInstallResult.tier` = `complete` / `partial` / `null`，
 *   判据在 `src-tauri/src/domain/pack_outcome.rs::classify_install`）：
 *     · `complete` —— 清单里的文件全到手；
 *     · `partial`  —— **≥1 个没到手，但骨架齐全** ⇒ **仍然算成功**（实例照建）；
 *     · `null`     —— 这一次没有档位结论（**暂停**走这一档）。
 *
 *   而界面这边**旧形状**只有"缺了没缺"一根筋：主路径先写死一句「安装完成」，
 *   然后才看 `missing_files` 补一句 —— 于是任务卡片上那句"完成"在 partial 时
 *   是一句**假话**（用户最忌讳的"把缺了东西说成完成了"）。
 *
 * ## 为什么判据要提成纯函数（而不是写死在页面里）
 *
 *   三处文案（任务卡片标题 / toast / 页面提示）分开写在三个地方，
 *   分叉只是时间问题 —— 而分叉的后果正是同一句假话从另一处冒出来。
 *   这里钉住的是**同一个输入给出的那一句**，三处都只能从它取。
 *
 * ## 两次结论（先红后绿）
 *
 *   本文件是**先写**的：对着改动前的形状（只认 `missing_count`、不看 `tier`、
 *   暂停与缺件混着说）跑，红的正是下面标了 ★ 的那几条。
 *   实现 `install-summary.ts` 之后转绿。
 *
 * 用法：node --test tests/install-summary.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const { installSummary } = await import('../src/domain/install-summary.ts');

/** 一条"没到手上"的条目（形状照后端 `missing_files` 抄） */
const miss = (name, retryable = true) => ({
  path: `mods/${name}`,
  name,
  reason: retryable ? `下载失败（连接超时）` : '没解析出下载地址（作者不允许第三方分发）',
  retryable,
});

/** 一句"完成"的假话（任何档位下都不许出现的那几个字） */
const CLAIM = '安装完成';

/* ============================================================
   ① complete：全到手 —— 照旧说装好了
   ============================================================ */

test('complete：说"装好了"，不提醒、不给入口、不用留在这一屏', () => {
  const s = installSummary({ tier: 'complete', missingCount: 0, failedCount: 0 });
  assert.equal(s.kind, 'complete');
  assert.equal(s.warn, false);
  assert.equal(s.action, null);
  assert.equal(s.stay, false);
  assert.ok(s.title.length > 0 && s.detail.length > 0);
});

test('complete：哪怕带了一个 0，也不说"缺 0 个"这种废话', () => {
  const s = installSummary({ tier: 'complete', missingCount: 0, missing: [] });
  assert.doesNotMatch(s.title, /缺/, '没有缺件就不许提"缺"');
});

/* ============================================================
   ② partial：**缺 1 个 / 缺多个** —— 这次要修的那一档
   ============================================================ */

test('★ partial 缺 1 个：说的是"装好了，但缺 1 个"，绝不是"安装完成"', () => {
  const s = installSummary({
    tier: 'partial',
    missingCount: 1,
    failedCount: 1,
    missing: [miss('balm-fabric-7.2.1.jar')],
  });
  assert.equal(s.kind, 'partial');
  assert.ok(s.title.includes('缺 1 个'), `标题要说清缺了几个：${s.title}`);
  assert.ok(!s.title.includes(CLAIM), `★ 缺了东西就不许说"${CLAIM}"：${s.title}`);
  assert.equal(s.warn, true, '缺件必须提醒');
  assert.equal(s.stay, true, '缺件时不许跳走 —— 跳走等于把"缺哪几个"从屏幕上抹掉');
  assert.equal(s.action, '重新下载缺失的', '入口文案只有一份（pack-missing 里那个常量）');
});

test('★ partial 缺多个：数字要说对，且三处的**标题是同一句**', () => {
  const s = installSummary({
    tier: 'partial',
    missingCount: 5,
    failedCount: 3,
    missing: [1, 2, 3, 4, 5].map((i) => miss(`m${i}.jar`, i <= 3)),
  });
  assert.equal(s.kind, 'partial');
  assert.ok(s.title.includes('缺 5 个'), s.title);
  assert.ok(!s.title.includes(CLAIM), s.title);
  // ★ 同一个输入给出的那一句必须唯一 —— 三处都从它取，才不会三处三种说法
  const again = installSummary({
    tier: 'partial',
    missingCount: 5,
    failedCount: 3,
    missing: [1, 2, 3].map((i) => miss(`m${i}.jar`)),
  });
  assert.equal(s.title, again.title, '标题只该由档位与条数决定，不该被别的细节带偏');
});

test('partial：副标题要把"缺的两类"分开说（下载失败 / 没解析出地址）', () => {
  const s = installSummary({ tier: 'partial', missingCount: 5, failedCount: 2 });
  assert.ok(s.detail.includes('5'), `要说总数：${s.detail}`);
  assert.ok(s.detail.includes('2'), `要说其中下载失败几个：${s.detail}`);
  assert.ok(s.detail.includes('3'), `剩下 3 个是没解析出地址：${s.detail}`);
  assert.match(s.detail, /下载|地址/, s.detail);
});

test('partial：明细在手上时**点名**（名字 + 原因都在表里），副标题直接说清', () => {
  const s = installSummary({
    tier: 'partial',
    missingCount: 2,
    failedCount: 1,
    missing: [miss('balm-fabric-7.2.1.jar'), miss('fallingtree-fabric-1.20.1.jar', false)],
  });
  assert.ok(s.detail.includes('balm-fabric-7.2.1.jar'), `要点名：${s.detail}`);
  assert.ok(s.detail.includes('fallingtree-fabric-1.20.1.jar'), `要点名：${s.detail}`);
});

test('★ `failed_files` 为空、但有 missing（没解析出地址的那一类）⇒ 同样是 partial', () => {
  /*
   * 用户点名要覆盖的形状：地址都没解析出来的那种（事故里那 5 个 mod）。
   * `failed_count` 是 0，但 `missing_count` 是 5 —— 旧形状只看下载失败数时
   * 这一档会被说成"完成"。
   */
  const s = installSummary({
    tier: 'partial',
    missingCount: 5,
    failedCount: 0,
    missing: [1, 2, 3, 4, 5].map((i) => miss(`u${i}.jar`, false)),
  });
  assert.equal(s.kind, 'partial');
  assert.ok(s.title.includes('缺 5 个'), s.title);
  assert.ok(!s.title.includes(CLAIM), s.title);
  assert.equal(s.warn, true);
  assert.equal(s.stay, true);
});

test('partial：条数拿不到时也**不许编一个数**（老版本后端）', () => {
  const s = installSummary({ tier: 'partial' });
  assert.equal(s.kind, 'partial');
  assert.doesNotMatch(s.title, /缺 0 个/, '0 是一个编的数，宁可不说数');
  assert.ok(s.title.length > 0);
  assert.equal(s.warn, true);
});

/* ============================================================
   ③ tier=null：**先看 paused**（暂停不属于三档）
   ============================================================ */

test('★ tier=null + paused：说的是"已暂停"，不是"缺件"', () => {
  const s = installSummary({ tier: null, paused: true, remainingFiles: 12 });
  assert.equal(s.kind, 'paused');
  assert.equal(s.title, '已暂停');
  assert.ok(s.detail.includes('12'), `还剩几个要说出来：${s.detail}`);
  assert.doesNotMatch(s.title + s.detail, /缺/, '暂停不是缺件（文件还在 .part 里等着续传）');
  assert.equal(s.warn, false);
  assert.equal(s.action, null, '暂停的出口是「继续」，不是「重新下载缺失的」');
  assert.equal(s.stay, false);
});

test('★ 暂停**优先于**档位：就算后端哪天同时给了 partial，也不许说成缺件', () => {
  const s = installSummary({ tier: 'partial', paused: true, remainingFiles: 3, missingCount: 3 });
  assert.equal(s.kind, 'paused', '先看 paused —— 这条顺序本身就是要钉住的判据');
  assert.equal(s.title, '已暂停');
});

test('暂停时停在某一步没做完 ⇒ 说清是哪一步（不许只说一句"已暂停"）', () => {
  const s = installSummary({
    tier: null,
    paused: true,
    remainingFiles: 0,
    pausedStage: '运行 forge 安装器',
  });
  assert.equal(s.kind, 'paused');
  assert.ok(s.detail.includes('运行 forge 安装器'), `要点名停在哪一步：${s.detail}`);
});

test('★ tier=null 且**不是**暂停：不许假装有档位结论，也不许说"安装完成"', () => {
  const s = installSummary({ tier: null, paused: false, missingCount: 0 });
  assert.equal(s.kind, 'unknown');
  assert.ok(!s.title.includes(CLAIM), `★ 没有结论就不许替后端下结论：${s.title}`);
  assert.equal(s.warn, false, '没有缺件证据就不提醒');
  assert.equal(s.action, null);
  assert.equal(s.stay, false);
});

test('tier=null 但**数据说缺了**（missing_count > 0）⇒ 按缺的说，不说"完成"', () => {
  const s = installSummary({ tier: null, paused: false, missingCount: 2, failedCount: 2 });
  assert.equal(s.kind, 'partial', '缺件这件事有数据为证，不需要档位替它背书');
  assert.ok(s.title.includes('缺 2 个'), s.title);
  assert.ok(!s.title.includes(CLAIM), s.title);
});

test('tier 缺失（老后端 / 演示模式）按 tier=null 处理，不抛', () => {
  const s = installSummary({});
  assert.equal(s.kind, 'unknown');
  assert.ok(s.title.length > 0);
});

/* ============================================================
   ④ 脏输入：不许抛，也不许编
   ============================================================ */

test('脏输入（负数 / undefined 计数）不抛，也不编出负数', () => {
  const s = installSummary({ tier: 'partial', missingCount: -3, failedCount: -1 });
  assert.equal(s.kind, 'partial');
  assert.doesNotMatch(s.title, /-/, s.title);
  assert.doesNotMatch(s.detail, /-/, s.detail);
});

test('failed_count 比 missing_count 大（脏数据）时不许说出"超过总数"的分配', () => {
  const s = installSummary({ tier: 'partial', missingCount: 2, failedCount: 9 });
  assert.doesNotMatch(s.detail, /7/, `别算出 −7：${s.detail}`);
  assert.ok(s.detail.includes('2'), s.detail);
});

/* ============================================================
   ⑤ 「安装完成」这四个字只允许出现在 complete 那一档
   ============================================================ */

test('★ 只有 complete 允许出现"安装完成"这类说法（其余档位一律不许）', () => {
  const partial = installSummary({ tier: 'partial', missingCount: 1, failedCount: 1 });
  const paused = installSummary({ tier: null, paused: true, remainingFiles: 2 });
  const unknown = installSummary({ tier: null });
  for (const s of [partial, paused, unknown]) {
    assert.ok(!s.title.includes(CLAIM), `${s.kind} 的标题不许说"${CLAIM}"：${s.title}`);
    assert.ok(!s.detail.includes(CLAIM), `${s.kind} 的副标题不许说"${CLAIM}"：${s.detail}`);
  }
});
