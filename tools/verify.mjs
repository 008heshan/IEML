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
 * ★★ 视效档位（`ui/vfx.ts`）—— 三档 + 降级。
 *
 *   为什么这条必须有：降级**只会在别人的机器上发生**（Win7 / 无 WebGL2 / 软渲染），
 *   开发机永远跑不到那条分支。跑不到的判据等于没有判据，所以把它拆成纯函数
 *   （`osFromUA` / `isSoftwareRenderer` / `auraGate` / `decideVfx`）用真 UA 串喂。
 */
results.push([
  '视效档位规则',
  run('视效档位规则', 'node', ['--test', 'tests/vfx-rules.test.mjs']),
]);
/*
 * ★★ 更新状态的文案（2026-09-24，B-2）。
 *
 *   为什么这是门禁：那段文案原来是一条**会撒谎**的三元链 ——
 *   9 种更新状态里只处理 4 种，其余（含 error=断网/404/签名失败）全说
 *   「已是最新版本」。断网点一下"检查更新"，界面就告诉用户一个假事实，
 *   而真实原因一直躺在 `state.error` 里没人显示。
 *   "只有 uptodate 能说已是最新"这条规矩**必须由判据守着**，
 *   否则下次谁加一个状态又会掉进同一个坑。
 */
results.push([
  '更新状态文案',
  run('更新状态文案', 'node', ['--test', 'tests/update-copy.test.mjs']),
]);
/*
 * ★★ "用户自己取消"的识别（2026-09-24，C-26）。
 *   用户点取消之后弹的是红色「安装失败：任务被取消」—— 把自己刚做的操作说成故障。
 *   两个调用点（整合包安装 / 版本安装）必须用同一处判据（字符串来源不同：
 *   Rust 的「任务被取消」与浏览器桥的「已取消」）。
 */
results.push([
  '取消语义',
  run('取消语义', 'node', ['--test', 'tests/cancel.test.mjs']),
]);

/*
 * ★★ **更新说明的解析与选择**（2026-09-26，用户：「版本更新列表可以改成实时获取吗，
 *   点进去就刷新」）。
 *
 *   为什么这是门禁：这一页的两种错**都不会报错**，只会显示不对的内容 ——
 *   ① 解析把条目读丢了 ⇒ 界面上"这一版没写更新日志"（这次真踩到：rc.9 发布后
 *      包里那份没补 rc.9，用户看到的第一张卡还是 rc.8）；
 *   ② 把**新版本**的说明当成本版说明显示 ⇒ 一句具体的假话。
 *   `domain/release-notes.ts` 里那两个函数就是这两件事的判据。
 */
results.push([
  '更新说明解析与选择',
  run('更新说明解析与选择', 'node', ['--test', 'tests/release-notes.test.mjs']),
]);
/*
 * ★★ 崩溃规则表的**两侧一致性**（2026-09-24，C-8）。
 *
 *   规则有两份实现：Rust `domain/crash.rs`（judge_crash 用，也就是游戏退出那条 toast 的判据）
 *   与 TS `src/domain/crash.ts`（崩溃弹窗与日志页用）。
 *   它们曾经漂移而**没有任何判据能发现**：36 条 vs 35 条、12 条 id 起名不同
 *   （TS `out-of-memory-heap` / Rust `oom-heap` …）。
 *   这条门禁让两份读**同一份判据表**（`tests/crash-rules.cases.json`）：
 *   哪一边改了规则没改另一边，就有一边红（Rust 侧那条在 crash.rs 的 tests 里）。
 */
results.push([
  '崩溃规则两侧一致',
  run('崩溃规则两侧一致', 'node', ['--test', 'tests/crash-rules.test.mjs']),
]);
/*
 * ★★ 九套主题的令牌与对比度（2026-09-22 用户要求 9 套主题）。
 *
 *   为什么这是**门禁**而不是"看一眼"：9 套 × 30 个令牌全是手写的颜色，
 *   · 漏一个令牌 → 它继承深色的值 → 绿底上冒出个蓝按钮；
 *   · 某个次要文字太暗 → 设置页那行说明看不见。
 *   这两种都不是审美问题，是**能算出来的错**（WCAG 对比度有公式），
 *   所以放进 `pnpm verify`，红了就别交付。
 *   ★ 它已经抓到过两个真 bug：主题块被插进深色块内部（CSS 嵌套，永不生效）、
 *     酒红主色对比度只有 4.02。
 */
/*
 * ★★ CSS 令牌引用必须存在（2026-09-22）。
 *   由来：`var(--ease)` 被用了 13 处却从未定义 —— 缺失的自定义属性会让**整条声明**
 *   在计算值阶段失效（transition 变 unset），那些过渡**一直是瞬变**，
 *   而代码读起来完全正常。这条门禁把这类"看不见的坏"挡在交付前。
 */
results.push([
  'CSS 令牌引用完整',
  run('CSS 令牌引用完整', 'node', ['tools/gates/check-css-tokens.mjs']),
]);
results.push([
  '主题令牌与对比度',
  run('主题令牌与对比度', 'node', ['--test', 'tests/theme-tokens.test.mjs']),
]);
/*
 * ★★ 皮肤头像的坐标几何（2026-09-23）。
 *
 *   用户为头像截了两次图：第一次「头像不显示」（我把 background-position 写成 0 0，
 *   取到的是皮肤左上角的空白区），第二次是我重写时又把帽子层的缩放算错。
 *   这套数字**错了不报错、只是看着不对**，所以必须由判据盯住：
 *   测试把 CSS 值反解成"可见窗口覆盖源图哪一块"，断言正好是头部/帽子那 8×8。
 */
results.push([
  '皮肤头像几何',
  run('皮肤头像几何', 'node', ['--test', 'tests/skin-head.test.mjs']),
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

/*
 * ★★ **密钥类内容不许进被跟踪文件**（2026-09-25 公开化清理新增）。
 *
 *   起因是一条真实事故：`net/curseforge.rs` 里内置着一把用户的真实 CurseForge
 *   API Key，而且它从**初始提交**起就在 git 历史里。它是当初 ADR-052 的**有意取舍**
 *   （"拿到 exe 就能用"），但**没有任何判据守着它** —— 于是活了 12 天、穿过 20 多轮
 *   改动，没有一次红过，直到有人为了"转公开"把全部源码与文档通读一遍才发现。
 *   ★ 教训：**靠人眼通读才能发现的问题，一定会复发。**
 */
results.push([
  '敏感串扫描',
  run('敏感串扫描', 'node', ['tools/gates/check-secrets.mjs']),
]);

/*
 * ★★ **文档里的站内锚点必须存在**（同一天新增）。
 *
 *   `DECISIONS.md` 里有个死锚点 `#adr-020主页即当前实例概览`，而 ADR-020 从第一天起
 *   就叫"加载器识别必须用 libraries 坐标" —— 顺着点会点到空气。
 *   ★ 这类链接**人手写不对**（GitHub 的锚点规则要从标题算），只能靠机器对。
 *   ★ 这条门禁自己踩过一次"量法错"：第一版把"空格"写成 JS 的 `\s`，
 *     而它**包含全角空格**、GitHub 不包含 —— 于是把 12 个**正确**的链接判成死锚点。
 *     红了先怀疑量法（这个仓库的老规矩）。
 */
results.push([
  '文档锚点自检',
  run('文档锚点自检', 'node', ['tools/gates/check-doc-anchors.mjs']),
]);

/*
 * ★★ **README 说的东西必须真的存在**（同一天新增）。
 *
 *   同一次通读里 README 抓到两条用户可见的假话：「换数据根目录要重启才生效」
 *   （rc.6 起即时生效）、以及三个过期的数字（8.9 MB / 437 项测试 / 760 kB）。
 *   判据是**会随代码自动更新**的那两条：README 提到的路径必须存在、
 *   命令必须在 package.json 里；再加几条"已作废机制"的定点禁用短语。
 */
results.push([
  'README 与事实一致',
  run('README 与事实一致', 'node', ['tools/gates/check-readme-truth.mjs']),
]);

/*
 * ★★ **仓库根只放该放的东西**（同一天新增）。
 *
 *   清理时发现根目录里躺着 `debug.log`、`instances.json`/`prefs.json`（**含账号 UUID**）、
 *   探针留下的空 `.minecraft/` 与 `instances/`、以及 26.3 MB 的 `tmp/`。
 *   它们都没被跟踪（所以没泄露），但项目规矩写着"日志不许落进仓库根"——
 *   **规矩在、判据不在，于是又长回来了**。
 *   判据是白名单：根目录只允许配置文件、README/CHANGELOG/LICENSE、源码与文档目录。
 */
results.push([
  '仓库根布局',
  run('仓库根布局', 'node', ['tools/gates/check-repo-root.mjs']),
]);

/*
 * ★★ **发布的仓 == 客户端读的仓**（2026-09-26 两仓合并那一轮新增）。
 *
 *   更新链路上有三处各自独立的地址：客户端读的（`tauri.conf.json`，**编进 exe**）、
 *   发布发的（`publish-cnb.mjs` 的 `REPO`）、自检验的（`verify-endpoint.mjs`）。
 *   它们不一致时的表现是最难查的一种：**发布报成功、自检也绿，而用户永远收不到更新**
 *   —— 没有任何一处会报错。这个仓库吃过同族的亏（beta.49「发布失败而我没发现」）。
 */
results.push([
  '更新链路端点一致',
  run('更新链路端点一致', 'node', ['tools/gates/check-update-endpoint.mjs']),
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
 * ★★ 2026-09-24（rc.4）：**更新日志的格式**也要进门禁。
 *
 *   用户在 rc.4 期间定下了「更新日志」正文的格式（五段 + 每条重复类别词 +
 *   言简意赅 + 不写括号里的解释），并要求把它当作**必读模板**："以后按这个写"。
 *   这句"以后"只有变成会红的判据才守得住 —— 这个仓库已经吃过一次同类亏：
 *   更新说明只推了标题那一行，而当时三条关于 notes 的断言**全都成立**。
 */
results.push([
  '更新日志格式',
  run('更新日志格式', 'node', ['tools/check-release-notes.mjs']),
]);

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
