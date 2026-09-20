/**
 * 一键验证：把前端、领域规则、端到端、Rust、构建与几道静态检查跑一遍。
 *
 * 用法: node tools/verify.mjs
 *
 * ★ **项数不写死在这里**（脚本自己会打印"全部 N 项检查通过"）——
 *   这一轮（dev.12）修的一个病就是"文档里抄了一个数字，然后它悄悄过期了"。
 *   改了这一组检查就顺手看一眼 README「测试」一节的说法是否还对得上。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';

function run(name, cmd, args, opts = {}) {
  process.stdout.write(`\n\x1b[1m▶ ${name}\x1b[0m\n`);
  const started = Date.now();
  const r = spawnSync(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    shell: isWin,
    ...opts,
  });
  const ms = Date.now() - started;
  const ok = r.status === 0;
  console.log(
    ok
      ? `\x1b[32m✓ ${name} 通过\x1b[0m  (${ms}ms)`
      : `\x1b[31m✗ ${name} 失败，退出码 ${r.status}\x1b[0m  (${ms}ms)`,
  );
  return ok;
}

const results = [];

results.push(['类型检查', run('类型检查', 'pnpm', ['exec', 'tsc', '--noEmit'])]);
results.push(['领域单元测试', run('领域单元测试', 'node', ['--test', 'tests/domain.test.js'])]);
// ★ 加载器目录的缓存规则（用户报"该有 Forge 的版本还是没有 Forge"就出在这里）
results.push([
  '加载器缓存测试',
  run('加载器缓存测试', 'node', ['--test', 'tests/loader-catalog.test.mjs']),
]);
// ★ 删除语义：文案必须等于行为（"不可撤销" vs 真的进回收站）—— ADR-042
results.push([
  '删除语义测试',
  run('删除语义测试', 'node', ['--test', 'tests/delete-semantics.test.mjs']),
]);
// ★ 服务器地址清洗（全角标点自动换半角）—— ADR-044，
//   其中一张规则表与 Rust 侧逐字相同，用来钉住前后端不分叉
results.push([
  '服务器地址测试',
  run('服务器地址测试', 'node', ['--test', 'tests/server-address.test.mjs']),
]);
/*
 * ★★ Java 要求规则的**跨语言判据表**（ADR-051，P0-7）。
 *
 *   「这个版本需要 Java 几」有两份实现：Rust（启动时真的按它挑 Java）
 *   与 TS（界面显示那个数字）。两者漂移的后果不是"显示不好看"，
 *   而是**用户被两个答案骗**：界面说 17、启动说需要 25。
 *
 *   本项跑 TS 侧，`Rust 领域测试` 里那条 `domain::java::*` 读**同一份**
 *   `tests/java-rules.cases.json` —— 一边改了规则另一边没跟上，两处必红其一处。
 */
results.push([
  'Java 规则判据表',
  run('Java 规则判据表', 'node', ['--test', 'tests/java-rules.test.mjs']),
]);
/*
 * ★★ CurseForge 指纹（MurmurHash2）的判据表 —— 同一条思路（ADR-052）。
 *
 *   指纹算错的表现是**静默**的：接口只会回一个空的 exactMatches，
 *   于是"所有 Mod 都查不到更新"，没有任何报错。
 *   这一项跑 JS 侧复算，`Rust 领域测试` 里 `net::curseforge` 那条读同一份表。
 */
results.push([
  'CurseForge 指纹判据表',
  run('CurseForge 指纹判据表', 'node', ['tools/gen-curseforge-fingerprint-cases.mjs', '--verify']),
]);
/*
 * ★★ 输入校验（`domain/validate.rs` ↔ `domain/validate.ts`）。
 *
 *   起因是这个仓库已经因为"同一个判据写两遍、有一处忘了改"栽过两次
 *   （`forgespi` 的版本号、`26.2` 的 Java 要求）。校验规则是第三个高危点，
 *   所以这里既验三态语义（最容易写反的地方），
 *   也验**两边的规则参数逐条一致** —— 改一边不改另一边就直接红。
 */
results.push([
  '输入校验规则',
  run('输入校验规则', 'node', ['--test', 'tests/validate-rules.test.mjs']),
]);
/*
 * ★ 子进程窗口抑制审计（用户报"安装 Forge 调出来个啥也没有的 cmd"）。
 *
 *   这类遗漏是**逐处**的：修的时候全仓库 4 处加了标志、13 处没加，
 *   而唯一会真的弹给用户看的那一处恰好就是「安装 Forge」——
 *   因为它是唯一用 tokio::process::Command 的地方，标志只加在了 std 那一侧。
 *   人眼 review 一定会漏，所以做成一条会红的检查。
 */
results.push([
  '子进程窗口抑制',
  run('子进程窗口抑制', 'node', ['tools/gates/audit-spawn-windows.mjs']),
]);

results.push(['端到端规则校验', run('端到端规则校验', 'node', ['tests/e2e-check.mjs'])]);

/*
 * ★ 版本号一致性（规则见 docs/VERSIONING.md）。
 *
 *   版本号散在多个文件里（4 个代码文件 + README 两处），手改一定会漂移 ——
 *   而漂移的后果不是"不好看"，是排查时被骗：用户报"dev.2 有这个 bug"，
 *   你去查那个版本，发现几个文件里的 dev.2 指的是不同的构建。
 *   所以把它变成一条会红的检查，而不是一条"记得改"的约定。
 */
results.push([
  '版本号一致性',
  run('版本号一致性', 'node', ['tools/set-version.mjs', '--check']),
]);

/*
 * ★★ **文档版本口径一致**（dev.12 新增，P0 文档修复的一条防复发断言）。
 *
 *   起因是一次真实的漂移：代码里已经是 `0.1.0-dev.11`，而 README 开头还写着
 *   「当前版本：0.1.0-dev.3」—— **落后 8 个版本**，没有任何检查会发现。
 *   读文档的人（包括下一轮的我自己）会拿那个数字去对现象，对不上，然后怀疑代码。
 *
 *   这条断言要求：README 里的「当前版本」与 CHANGELOG **最新一节**的标题
 *   逐字相同（且与代码里的版本号一致 —— 上一条已经查过）。
 *   改版本号忘了改文档 = 红。
 */
results.push([
  '文档版本口径一致',
  run('文档版本口径一致', 'node', ['tools/set-version.mjs', '--docs']),
]);

/*
 * ★ **PowerShell 脚本的编码**（第五十六轮新增）。
 *
 *   含中文的 `.ps1` 必须有 UTF-8 BOM，否则 PowerShell 5.1 按 GBK 解码、
 *   直接解析失败，而报错指向一个无辜的 `}`。这个坑踩过三次，且**极易复发**：
 *   任何以"UTF-8 无 BOM"重新落盘的工具（AI 的 write/edit、node writeFileSync）
 *   都会把 BOM 悄悄抹掉，文件看起来完全正常、diff 也看不出来。
 *   所以它必须是一条会红的检查，而不是一句"记得加 BOM"。
 */
results.push([
  'PowerShell 脚本编码',
  run('PowerShell 脚本编码', 'node', ['tools/gates/check-ps1-encoding.mjs']),
]);

if (existsSync(join(root, 'src-tauri', 'Cargo.toml'))) {
  results.push([
    'Rust 领域测试（含 Java 判据表）',
    run('Rust 领域测试（含 Java 判据表）', 'powershell', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      'tools/env/cargo.ps1',
      'test',
      '--manifest-path',
      'src-tauri/Cargo.toml',
      '--lib',
    ]),
  ]);

  /*
   * ★★ 2026-09-20 新增：**所有测试目标都要能编译**。
   *
   *   为什么单独来一条：上面那条只跑 `--lib`（单元测试），而
   *   `src-tauri/tests/*.rs`（集成 / 真机测试）**根本不会被编译** ——
   *   于是它们红着也没人知道。实测代价：`LaunchSpec` 多了个 `libraries_dir`
   *   （dev.12）、`AppState.running` 从 `Option` 变成表（beta.6），四个集成测试
   *   从那以后就编译不过，而 `pnpm test:live` / `test:fresh` / `test:416`
   *   这些脚本全都跑不起来 —— 直到这一轮才被发现。
   *
   *   ★ 判据用 `check --tests`（只编译不运行）：真机测试要联网、要装好的游戏，
   *     不能在交付门禁里跑；但"它们至少能编译"是必须守住的底线。
   */
  results.push([
    'Rust 全部测试目标可编译',
    run('Rust 全部测试目标可编译', 'powershell', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      'tools/env/cargo.ps1',
      'check',
      '--manifest-path',
      'src-tauri/Cargo.toml',
      '--tests',
    ]),
  ]);
}

results.push(['前端生产构建', run('前端生产构建', 'pnpm', ['exec', 'vite', 'build'])]);

/*
 * ★★ **release exe 里的前端 == 当前 dist**（存在 exe 时才查）。
 *
 *   这条守的是"交付物与源码一致"：桌面 exe 的前端是**编译进二进制**的，
 *   改了前端不重新构建，exe 里还是旧的那一份 —— 而用户拿到的就是这个 exe。
 *
 *   这个检查自己踩过四次"检查方法错了"（见脚本头部的记录），
 *   所以它现在用两个层次的判据：资源 key（Vite 的内容哈希文件名）
 *   + 内容比对（brotli q9 字节流，或解压后逐字节）。
 */
const releaseExe = join(root, 'src-tauri', 'target', 'release', 'ieml.exe');
if (existsSync(releaseExe)) {
  results.push([
    'exe 内嵌前端一致性',
    run('exe 内嵌前端一致性', 'node', ['tools/gates/check-frontend-embedded.mjs']),
  ]);
} else {
  console.log('\n\x1b[33m▶ 跳过「exe 内嵌前端一致性」—— 还没有 release exe\x1b[0m');
}


// 产物体积
const dist = join(root, 'dist', 'assets');
if (existsSync(dist)) {
  console.log('\n\x1b[1m▶ 产物体积\x1b[0m');
  const { readdirSync } = await import('node:fs');
  let total = 0;
  for (const f of readdirSync(dist)) {
    const size = statSync(join(dist, f)).size;
    total += size;
    console.log(`  ${f.padEnd(34)} ${(size / 1024).toFixed(1)} kB`);
  }
  console.log(`  合计 ${(total / 1024).toFixed(1)} kB`);
}

console.log('\n' + '─'.repeat(52));
const failed = results.filter(([, ok]) => !ok);
if (failed.length === 0) {
  console.log(`\x1b[32m全部 ${results.length} 项检查通过\x1b[0m`);
  process.exit(0);
}
console.log(`\x1b[31m${failed.length} / ${results.length} 项失败：${failed.map(([n]) => n).join('、')}\x1b[0m`);
process.exit(1);
