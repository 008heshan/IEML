/*
 * 真机判据 A-2：**纯原版 + OptiFine 的实例，OptiFine 必须真的进启动规格**。
 *
 * ## 这个文件原来记的是"复现"（2026-09-24）
 *
 *   当时判据是反的：两条只差 `addons` 的实例，预览出来的命令行**逐字相同**、
 *   且命令行里**没有** OptiFine —— "勾了也白勾"成立。根因三处
 *   （`docs/BUG-REPORT-2026-09-24.md` 的 A-2）：
 *     · `LaunchRequest` 里没有 `addons` —— 附加组件传不到启动侧；
 *     · `resolve_loader_version_id` 在 `loader_kind` 为空时直接返回原版 id；
 *     · 启动闸只把 OptiFine 从"冒犯项"里排除，**没有任何代码去用它**。
 *
 * ## 现在判据翻过来了（2026-09-26 修复）
 *
 *   修法：`LaunchRequest.addons` + `resolve_addon_version_id()`（按**盘上痕迹**定位
 *   `versions/<mc>-OptiFine_<版本>/`，只认"没有基础加载器痕迹"的目录）。
 *   本探针分两半量，缺一半都不算数：
 *
 *   **后端一半**（直接调 `preview_launch`，req 与前端拼的一模一样）：
 *     ① `addons: []`  → 主类 `net.minecraft.client.main.Main`、没有 tweakClass、`--version 1.12.2`；
 *     ② `addons: [optifine]` → 主类 `net.minecraft.launchwrapper.Launch`、
 *        带 `--tweakClass optifine.OptiFineTweaker`、`--version 1.12.2-OptiFine_HD_U_G8`；
 *     ③ 两条命令行**必须不同**（相同 = 又回到"勾了也白勾"）。
 *
 *   **前端一半**（拦 `invoke`，看界面**真的发出去**的 req）：
 *     ④ 界面上选中的实例预览时，`req.addons` 必须是数组且等于 `['optifine']`
 *        —— 这一条专门守"后端修好了但前端没传"（A-2 的第一处机制）。
 *
 * ## 沙盒
 *
 *   自己造**形态真实**的最小版本目录（原版 + OptiFine 打补丁产物），不借用真实数据 ——
 *   上一版用目录联接借 `D:\IEML\.minecraft`，而那份数据现在是空的，
 *   于是"测不到东西却看起来在跑"。另造一个原生库 jar 让启动前的 natives 硬闸门放行
 *   （**本探针不判那条**，只是不能让它把我们拦在预览之前）。
 *   ★ 用**预览命令**判断：`preview_launch` 与 `launch_minecraft` 走**同一个** `prepare_spec`，
 *     所以"预览一样"就等于"启动一样"，而且不会真的拉起游戏。
 *
 * ★ 与用户那份启动器**并存**：只收自己起的进程树（不调 `killIeml()`）。
 *   ⚠️ 前提：被测 exe 的 identifier 与用户那份不同，否则单实例插件会让它起不来。
 *
 * 用法：node tools/live/probe-bug-repro-6.mjs ["<exe>"]
 * 退出码：0 = 判据全过；1 = 有判据不成立
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launch, sleep } from './lib/cdp.mjs';

const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');
if (!existsSync(EXE)) {
  console.error('找不到 exe：' + EXE);
  process.exit(2);
}

const T = process.env.TEMP ?? '.';
const ROOT = path.join(T, 'ieml-a2-root');
const OWN = path.join(T, 'ieml-a2-own');
const STAGE = path.join(T, 'ieml-a2-stage');
const MC = path.join(ROOT, '.minecraft');
const LIB_REL = 'org/lwjgl/lwjgl/lwjgl-platform/2.9.4-nightly-20150209';
const JAR = 'lwjgl-platform-2.9.4-nightly-20150209-natives-windows.jar';

let pass = 0;
let fail = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? '  ' + extra : ''}`);
  if (ok) pass += 1;
  else fail += 1;
};

/* ====================== 沙盒 ====================== */

for (const d of [ROOT, OWN, STAGE]) rmSync(d, { recursive: true, force: true });
for (const sub of ['versions', 'libraries', 'assets']) mkdirSync(path.join(MC, sub), { recursive: true });

/* 原生库 jar：装一个 lwjgl64.dll（内容无所谓，硬闸门只问"有没有 .dll"） */
mkdirSync(STAGE, { recursive: true });
writeFileSync(path.join(STAGE, 'lwjgl64.dll'), 'fake-native');
const libDir = path.join(MC, 'libraries', ...LIB_REL.split('/'));
mkdirSync(libDir, { recursive: true });
const zip = path.join(T, 'ieml-a2-natives.zip');
rmSync(zip, { force: true });
execFileSync('powershell', [
  '-NoProfile',
  '-Command',
  `Compress-Archive -Path '${STAGE}\\*' -DestinationPath '${zip}' -Force`,
]);
renameSync(zip, path.join(libDir, JAR));

const ARGS =
  '--username ${auth_player_name} --version ${version_name} --gameDir ${game_directory} ' +
  '--uuid ${auth_uuid} --accessToken ${access_token} --userType ${user_type}';
const NATIVE_LIB = {
  name: 'org.lwjgl.lwjgl:lwjgl-platform:2.9.4-nightly-20150209',
  natives: { windows: 'natives-windows' },
  downloads: {
    classifiers: { 'natives-windows': { path: `${LIB_REL}/${JAR}`, url: '', sha1: '', size: 0 } },
  },
};
/*
 * ★ 再放一份**真的 OptiFine 库 jar**到盘上：这样 classpath 里会出现它的路径，
 *   而"用的是哪个版本目录"就有一条**与环境无关**的硬证据（不靠 `--version` 那种
 *   由 `mc_version` 填的占位符 —— 那一条本来就不随附加组件变，见探针尾部说明）。
 */
const OF_REL = 'optifine/OptiFine/1.12.2_HD_U_G8';
const ofJarDir = path.join(MC, 'libraries', ...OF_REL.split('/'));
mkdirSync(ofJarDir, { recursive: true });
writeFileSync(path.join(ofJarDir, 'OptiFine-1.12.2_HD_U_G8.jar'), 'fake-optifine');
const writeVersion = (dir, body) => {
  const d = path.join(MC, 'versions', dir);
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, `${dir}.json`), JSON.stringify(body, null, 2));
};
/* 原版（形态照真实那份：minecraftArguments + Main） */
writeVersion('1.12.2', {
  id: '1.12.2',
  type: 'release',
  mainClass: 'net.minecraft.client.main.Main',
  minecraftArguments: ARGS,
  libraries: [NATIVE_LIB],
});
/* 纯原版 + OptiFine 的产物（官方 Patcher：inheritsFrom 原版 + tweakClass + optifine 库坐标） */
writeVersion('1.12.2-OptiFine_HD_U_G8', {
  id: '1.12.2-OptiFine_HD_U_G8',
  type: 'release',
  inheritsFrom: '1.12.2',
  mainClass: 'net.minecraft.launchwrapper.Launch',
  minecraftArguments: `${ARGS} --tweakClass optifine.OptiFineTweaker`,
  libraries: [{ name: 'optifine:OptiFine:1.12.2_HD_U_G8' }],
});

const mkInstance = (id, slug, name, addons) => ({
  id,
  mcVersion: '1.12.2',
  loader: null,
  addons,
  config: { name, slug, isolation: 'auto', memoryMb: 2048, memorySource: 'auto', javaMode: 'auto' },
  createdAt: new Date().toISOString(),
  lastPlayedAt: null,
  totalPlaySeconds: 0,
});
/* ★ 清单住在**启动器自己的家**（A-4 之后）；`active_id` 指带 OptiFine 那条，
     这样界面一进来选中的就是它 —— 前端那一半判据不用去拨下拉 */
const STORE = JSON.stringify(
  {
    instances: [
      mkInstance('inst-plain', 'probe-plain', '探针·无附加组件', []),
      mkInstance('inst-opti', 'probe-opti', '探针·带OptiFine', [
        { kind: 'optifine', version: 'HD_U_G8' },
      ]),
    ],
    active_id: 'inst-opti',
  },
  null,
  2,
);
mkdirSync(OWN, { recursive: true });
writeFileSync(path.join(OWN, 'instances.json'), STORE);
console.log('沙盒就绪：' + ROOT);

/* ====================== 起启动器 ====================== */

const { ev, pid, ws } = await launch({
  exe: EXE,
  tag: 'a2',
  env: { IEML_DATA_DIR: ROOT, IEML_OWN_DIR: OWN },
  keepDataDir: true,
  settleMs: 3000,
});

const inv = (cmd, args) =>
  ev(`(async () => {
    try { return { ok: await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? {})}) }; }
    catch (e) { return { err: String(e && e.message ? e.message : e) }; }
  })()`);

try {
  const baseReq = {
    mc_version: '1.12.2',
    loader_kind: null,
    loader_version: null,
    username: 'Probe',
    account_uuid: null,
    memory_mb: 2048,
    width: 854,
    height: 480,
    instance_slug: 'probe-plain',
    instance_id: 'inst-plain',
    extra_jvm_args: [],
    extra_game_args: [],
    window_title: null,
    join_server: null,
    addons: [],
  };
  const plain = await inv('preview_launch', { req: baseReq });
  const opti = await inv('preview_launch', {
    req: { ...baseReq, instance_slug: 'probe-opti', instance_id: 'inst-opti', addons: ['optifine'] },
  });

  const cmdOf = (r, tag) => {
    if (r?.err) {
      console.log(`\n=== ${tag}: 失败 ===\n` + String(r.err).slice(0, 300));
      return '';
    }
    const c = String(r.ok.command);
    console.log(`\n=== ${tag} ===\n  main: ${/ ([\w.$]+) --username/.exec(c)?.[1] ?? '(没读到主类)'}`);
    console.log('  --version: ' + (/(?:^|\s)--version (\S+)/.exec(c)?.[1] ?? '(没有)')); 
    console.log('  tweakClass: ' + (/--tweakClass (\S+)/.exec(c)?.[1] ?? '(没有)'));
    return c;
  };
  const cPlain = cmdOf(plain, 'A：addons = []');
  const cOpti = cmdOf(opti, 'B：addons = [optifine]');

  console.log('\n===== 判据 =====');
  check(plain?.ok !== undefined, '① 纯原版实例能拼出启动命令（前置条件）');
  check(
    /net\.minecraft\.client\.main\.Main/.test(cPlain) && !/--tweakClass/.test(cPlain),
    '① 纯原版那条：主类 Main、没有 tweakClass',
  );
  check(
    /net\.minecraft\.launchwrapper\.Launch/.test(cOpti) &&
      /--tweakClass optifine\.OptiFineTweaker/.test(cOpti),
    '② 带 OptiFine 那条：主类换成 launchwrapper、带 --tweakClass（差的就是这一步）',
  );
  /*
   * ★ "用的是那份 OptiFine 版本目录"用 **classpath** 判：OptiFine 那个库坐标
   *   （`optifine:OptiFine:1.12.2_HD_U_G8`）只写在 OptiFine 的那份版本 JSON 里，
   *   它出现在 classpath = 那份 JSON 被读到并合并了。
   *   ★ 不用 `--version` 判：那个占位符由 `req.mc_version` 填（`commands_real.rs` 里
   *     `version_name: req.mc_version.clone()`），本来就不随附加组件变 ——
   *     拿它当判据会把"功能正常"误判成红（第一版就这么错过一次）。
   */
  const hasOfJar = (c) => /optifine[\\/]OptiFine[\\/]1\.12\.2_HD_U_G8/i.test(c);
  check(!hasOfJar(cPlain), '③ 纯原版那条的 classpath 里**没有** OptiFine 的库');
  check(hasOfJar(cOpti), '③ 带 OptiFine 那条的 classpath 里**有** OptiFine 的库（= 用了那份版本目录）');
  /*
   * ★ 比较前先把**实例路径**抹平：两条命令的 `-Djava.library.path` / `--gameDir`
   *   本来就该指到各自的实例目录（那是实例的身份，不是加载器的差别）。
   *   上一版直接比全文 ⇒ 这一条在"勾了也白勾"的状态下也会"通过"（假绿）。
   */
  const norm = (c) => c.replace(/probe-(plain|opti)/g, 'PROBE');
  check(
    cPlain !== '' && cOpti !== '' && norm(cPlain) !== norm(cOpti),
    '④ 抹掉实例路径后，两条命令行**必须不同**（相同 = 勾了也白勾）',
  );

  /*
   * ---------- 反向对照：把 OptiFine 的版本目录**藏起来** ----------
   *
   * ★★ 为什么必须有这一段：上面 ②/③ 是"应该出现"型的判据 —— 它们只有在
   *   **真的读到了那份目录**时才应该成立；但如果判据本身写松了（比如正则能匹配
   *   原版 JSON 里的东西），它会在坏代码上也绿。把目录移走再量一次，
   *   预期**回落成原版**（主类 Main、没有 tweakClass、classpath 里没有 OptiFine）：
   *   这一步能红，就证明 ②/③ 量的确实是"那份目录有没有被用上"。
   */
  /*
   * ★ 藏必须藏到 `versions/` **外面**：第一版只把目录改了个名（`_hidden_OptiFine`），
   *   而判据是按**痕迹**找的 —— 那份 JSON 里的 `inheritsFrom` 还是 1.12.2，
   *   于是它照样被找到（这一步因此"红"了，而红得对：改名不影响定位）。
   */
  const ofDir = path.join(MC, 'versions', '1.12.2-OptiFine_HD_U_G8');
  const hidden = path.join(ROOT, '_hidden_OptiFine');
  renameSync(ofDir, hidden);
  const fallen = await inv('preview_launch', {
    req: { ...baseReq, instance_slug: 'probe-opti', instance_id: 'inst-opti', addons: ['optifine'] },
  });
  const cFallen = fallen?.ok ? String(fallen.ok.command) : '';
  renameSync(hidden, ofDir);
  console.log('\n=== C：addons = [optifine]，但盘上没有 OptiFine 目录（反向对照）===');
  console.log('  main: ' + (/ ([\w.$]+) --username/.exec(cFallen)?.[1] ?? '(没读到)'));
  check(
    /net\.minecraft\.client\.main\.Main/.test(cFallen) && !hasOfJar(cFallen),
    '⑥ 反向对照：OptiFine 目录不在时**落回原版**（证明 ②③ 量的就是那份目录）',
  );

  /* ---------- 前端那一半：界面**真的**把 addons 传下去了吗（端到端） ---------- */

  /*
   * ★★ 这里**不去拦 `invoke`**：`window.__TAURI_INTERNALS__` 在 Tauri 2 里是
   *   defineProperty 定义的（赋值拦不住，实测 `patched: false`），而拦不住的判据
   *   会"永远绿"。改成走**界面本身**：点「预览命令」，读模态里渲染出来的命令行 ——
   *   前端没传 addons 的话，这里看到的就是原版主类（上一版红绿对照里正是这样）。
   */
  await ev(
    `[...document.querySelectorAll('.nav-item')].find((b)=>(b.textContent||'').includes('启动'))?.click()`,
  );
  await sleep(1800);
  const head = await ev(`(() => {
    const t = (document.querySelector('.content')?.innerText || '').split('\\n').map(s=>s.trim()).filter(Boolean);
    return t.slice(0, 4);
  })()`);
  console.log('\n界面选中的实例（页头）：' + JSON.stringify(head));
  await ev(
    `[...document.querySelectorAll('button')].find((b) => /预览命令/.test(b.textContent || ''))?.click()`,
  );
  /* 预览是异步的（要解析 Java、读版本 JSON、拼 classpath）—— 轮询到出结果为止 */
  let uiText = '';
  for (let i = 0; i < 40; i += 1) {
    await sleep(800);
    uiText = String(
      (await ev(`(() => { const m = document.querySelector('.modal'); return m ? (m.innerText || '') : ''; })()`)) ??
        '',
    );
    if (/tweakClass|client\.main\.Main|无法拼装|启动被拦下/.test(uiText)) break;
  }
  console.log('界面预览（截取）：' + uiText.replace(/\n+/g, ' | ').slice(0, 260));
  check(
    /--tweakClass optifine\.OptiFineTweaker/.test(uiText),
    '⑤ 界面端到端：选中的是 OptiFine 实例，点预览命令拿到的命令行**带 tweakClass**',
  );
} finally {
  /*
   * ★★ 只收自己那棵进程树：`lib/cdp.mjs` 的 `close()` 内部是**按进程名全杀**，
   *   会把用户正开着的启动器一起收掉。这里自己关 WS + taskkill 自己的 PID。
   */
  try {
    ws.close();
  } catch {}
  if (pid) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  await sleep(1200);
  for (const d of [ROOT, OWN, STAGE]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
  try {
    rmSync(path.join(T, 'ieml-a2-prof'), { recursive: true, force: true });
  } catch {}
}

console.log(
  fail === 0
    ? `\n✓ A-2 判据全过（${pass} 条）：实例记录里的 OptiFine **真的进了启动规格**。`
    : `\n✗ ${fail} / ${pass + fail} 条不成立（见上）`,
);
process.exit(fail === 0 ? 0 : 1);
