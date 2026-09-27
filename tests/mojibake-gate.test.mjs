#!/usr/bin/env node
/**
 * 门禁 `tools/gates/check-mojibake.mjs` 的**自测** —— 它必须会红，也必须不乱红。
 * ------------------------------------------------------------------
 * ## 为什么门禁要自带这个
 *
 *   这道门禁已经被**真样本**打过两次脸，两次都是"看起来守住了、其实没有"：
 *
 *   ① 手写一张"常见乱码字"表 ⇒ 拿 `"好了"` 的乱码 `"濂戒簡"` 喂进去，
 *      **一个字都没命中**，门禁照绿；
 *   ② 改成"由 GBK 表算出全部候选字" ⇒ 拿真仓库一跑，`CHANGELOG.md` 报出
 *      **213 行**"乱码"，全是「浏」（浏览）这类正经中文。
 *
 *   两次都是**跑一遍才知道**的。所以这两个方向各钉一条测试：
 *     · 会红：真乱码必须报出来（而且要说得出"本该是什么"）；
 *     · 不乱红：含「浏览 / 流氓 / 啊」这类字的正常中文必须放行。
 *
 * ## 坏样本是**算出来的**，不是抄进来的
 *
 *   测试文件本身就是 UTF-8 源文件 —— 往里面手抄一段乱码，等于把"乱码"
 *   永久留在仓库里（还会被门禁自己抓到）。所以这里**现造**：
 *   把一段正常中文的 UTF-8 字节按 GBK 解一次，就得到了那串乱码。
 *
 * 用法：node --test tests/mojibake-gate.test.mjs
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const GATE = join(ROOT, 'tools', 'gates', 'check-mojibake.mjs');

/** 本机 Node 有没有 GBK 表（没有的话这道门禁只能用兜底小表，测法要放宽） */
function hasGbk() {
  try {
    new TextDecoder('gbk', { fatal: false });
    return true;
  } catch {
    return false;
  }
}
const GBK = hasGbk();

/**
 * 造乱码：正常中文 →（GBK 解）→ 那串怪字。
 *
 * 这正是事故本身的成因（UTF-8 的字节被当成 GBK 读），所以造出来的样本
 * 与真实事故**同源**，不是"看起来像乱码"的假样本。
 */
function mojibakeOf(text) {
  const bytes = Buffer.from(text, 'utf8');
  return new TextDecoder('gbk', { fatal: false }).decode(bytes);
}

/** 把一份临时样本目录跑一遍门禁，返回 { code, out } */
function runGate(dir) {
  try {
    const out = execFileSync('node', [GATE, dir], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/** 一份样本目录（进程 id + 名字分隔，不撞别人） */
function sampleDir(tag) {
  const d = mkdtempSync(join(tmpdir(), `ieml-mojibake-${process.pid}-${tag}-`));
  return d;
}

test('门禁**会红**：真乱码必须报出来，并说出"本该是什么"', { skip: !GBK && '本机 Node 没有 GBK 表' }, () => {
  const d = sampleDir('bad');
  const broken = mojibakeOf('let s = "好了，世界";');
  // ★ 先确认造出来的样本**确实**是乱码（不然下面测的就是"门禁抓不住正常中文"）
  assert.notEqual(broken, 'let s = "好了，世界";', '样本没被写坏，测试本身失效');
  writeFileSync(join(d, 'bad.rs'), `${broken}\n`, 'utf8');

  const r = runGate(d);
  assert.equal(r.code, 1, `真乱码必须判红，实际退出码 ${r.code}：\n${r.out}`);
  assert.match(r.out, /bad\.rs:1/, '要指出是哪个文件的哪一行');
  /*
   * ★ 只要求还原到 **`好了，世`** 为止，不要求连"界"一起还出来 ——
   *   因为那一个字**真的还不了**：UTF-8 的"界"是 `E7 95 8C`，被 GBK 读时
   *   `8C` 咬住了后面的 `"`，那半个字只留下一个 U+FFFD。
   *   门禁如实把它们标成 `…□`（不是我写错了断言）。
   */
  assert.match(r.out, /本该是：.*好了，世/, '要告诉用户"本该是什么"（不然他只能猜）');
  assert.match(r.out, /□/, '还不了的那半个字要标出来，不能悄悄少一个字');

  rmSync(d, { recursive: true, force: true });
});

test('门禁**不乱红**：含「浏览 / 流氓」这类字的正常中文必须放行', { skip: !GBK && '本机 Node 没有 GBK 表' }, () => {
  const d = sampleDir('good');
  /*
   * ★ 这一份就是当初把门禁打脸的那批字：它们的 GBK 字节与某些 UTF-8 前两字节
   *   撞在一起，所以"按候选字表判红"的做法必然冤枉它们。
   */
  writeFileSync(
    join(d, 'ok.md'),
    [
      '# 正常的一篇文档',
      '',
      '* 在浏览器里浏览下载页（「浏览」这两个字最容易撞上候选表）',
      '* 流氓软件、啊这、罢了 —— 都是正经中文',
      '* 代码：`if (a > b) { return "ok"; }`',
      '* 繁体：瀏覽、亂碼、簡體（这三个字不一样，也要放行）',
      '',
    ].join('\n'),
    'utf8',
  );

  const r = runGate(d);
  assert.equal(r.code, 0, `正常中文被判红了（这就是当初那 213 处误报）：\n${r.out}`);

  rmSync(d, { recursive: true, force: true });
});

test('门禁的免责是**逐行**的：写了 mojibake-ok 的那一行才放过', { skip: !GBK && '本机 Node 没有 GBK 表' }, () => {
  const d = sampleDir('exempt');
  const broken = mojibakeOf('这句是坏的');
  writeFileSync(join(d, 'a.md'), `${broken} // mojibake-ok\n${broken}\n`, 'utf8');

  const r = runGate(d);
  assert.equal(r.code, 1, '另一行还是坏的，整份文件不能因为一行豁免就放过');
  assert.match(r.out, /a\.md:2/, '要精确指到没豁免的那一行（第 2 行）');
  assert.doesNotMatch(r.out, /a\.md:1/, '第 1 行豁免了就不该再报');

  rmSync(d, { recursive: true, force: true });
});

test('门禁能证明自己**真的在扫**：空目录绿，塞进坏样本就红', { skip: !GBK && '本机 Node 没有 GBK 表' }, () => {
  const d = sampleDir('proof');
  mkdirSync(join(d, 'sub'), { recursive: true });
  writeFileSync(join(d, 'sub', 'clean.ts'), 'export const 名字 = "正常的一行";\n', 'utf8');
  assert.equal(runGate(d).code, 0, '正常内容应当绿');

  writeFileSync(join(d, 'sub', 'broken.ts'), `${mojibakeOf('导出常量')}\n`, 'utf8');
  const r = runGate(d);
  assert.equal(r.code, 1, '同一份目录里塞进一个坏文件后必须变红（证明扫描真的在看内容）');
  assert.match(r.out, /sub[\\/]broken\.ts:1/, '子目录里的文件也要扫到');

  rmSync(d, { recursive: true, force: true });
});
