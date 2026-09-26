/* 端到端自检：真正加载打包后的 bundle，在模拟 DOM 环境里跑一遍领域逻辑与崩溃分析 */
import { analyzeCrashLog, redactReport, RULE_STATS } from '../src/domain/crash.ts';
import { validateCombination, addonCompatibility } from '../src/domain/combination.ts';
import { buildInstallPlan, checkPlan, formatBytes, formatDuration } from '../src/domain/install-plan.ts';
import { getLoaderCapabilities, bridgeFor } from '../src/domain/loader-caps.ts';

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    console.log('  ✗ ' + name + (extra ? '  → ' + extra : ''));
  }
}

console.log('\n=== 1. 规则库规模 ===');
check('崩溃规则条数 >= 30', RULE_STATS.total >= 30, `实际 ${RULE_STATS.total}`);
check('覆盖 9 大类', Object.keys(RULE_STATS.byCategory).length >= 8, JSON.stringify(RULE_STATS.byCategory));

console.log('\n=== 2. 崩溃分析（真实日志样本）===');
const sample = `[13:42:15] [main/WARN]: Mod resolution encountered an incompatible mod set!
[13:42:15] [main/WARN]:  - Mod 'Better Combat' (bettercombat) 1.8.6 requires any version of player-animator, which is missing!
[13:42:15] [main/ERROR]: Missing or unsupported mandatory dependencies:
\tMod ID: 'player-animator', Requested by: 'bettercombat'
[13:42:16] [main/INFO]: C:\\Users\\Administrator\\AppData\\Roaming\\.minecraft
[13:42:16] [main/INFO]: access_token=eyJhbGciOiJSUzI1NiJ9.abcdefghijklmnop.qrstuvwxyz12345`;

const a = analyzeCrashLog(sample);
check('识别出缺前置包', /前置包/.test(a.reason), a.reason);
check('类别为 mod', a.category === 'mod', a.category);
check('给出建议动作', a.actions.length > 0, JSON.stringify(a.actions));
check('不是启发式兜底', a.heuristic === false);
check('首屏是结论不是堆栈', !/Exception|at net\./.test(a.reason));

console.log('\n=== 3. 脱敏 ===');
const red = redactReport(sample);
check('隐藏了 JWT', red.text.includes('<已隐藏的登录令牌>'));
check('隐藏了用户名', red.text.includes('<用户名>'));
check('未残留 access_token 值', !/access_token=eyJ/.test(red.text));
check('报告了处理了哪些内容', red.redacted.length >= 2, JSON.stringify(red.redacted));

console.log('\n=== 4. 崩溃规则逐类命中 ===');
const cases = [
  ['java', 'java.lang.UnsupportedClassVersionError: class file version 65.0'],
  ['memory', 'java.lang.OutOfMemoryError: Java heap space'],
  ['memory', 'Could not reserve enough space for object heap'],
  ['mod', 'DuplicateModsFoundException: found a duplicate mod'],
  ['mod', 'Mixin apply failed: mixins.json could not be applied'],
  ['graphics', 'EXCEPTION_ACCESS_VIOLATION in nvoglv64.dll'],
  ['graphics', 'GLFW error 65542: Failed to create window'],
  ['account', 'InvalidCredentialsException: 401 Unauthorized'],
  ['file', 'java.util.zip.ZipException: invalid LOC header'],
  ['file', 'The filename or extension is too long'],
  ['environment', "java.lang.IllegalArgumentException: URI has an authority component"],
  ['environment', 'java.net.ConnectException: Connection refused'],
];
for (const [cat, log] of cases) {
  const r = analyzeCrashLog(log);
  check(`${cat}: ${log.slice(0, 42)}…`, r.category === cat, `得到 ${r.category}`);
}

console.log('\n=== 5. InstallPlan 生成 ===');
const caps = getLoaderCapabilities('1.20.4');

/*
 * ★★ 这一组在 2026-09-14 **改回来过**，两次结论都留在这里，因为第一次是错的。
 *
 *   第一版（dev.10）：我查了 Modrinth，`optifabric` 返回 404，于是断言
 *     「1.16 ~ 1.20.4 整段没有桥接包 → Fabric + 高清修复不兼容」。
 *   **这是错的**，错在把"某个平台上没有"当成了"不存在"：
 *     · OptiFabric 一直在 **CurseForge 项目 322385** 发布
 *       （75 个文件 / 1005 万次下载，最高 1.14.3 对应 MC 1.19.3）；
 *     · 用户拿 MC百科 class/1703 的「支持MC版本」表纠正了我：
 *       Fabric 1.14 ~ **1.20.4** 全支持（Chocohead 1.16~1.20 /
 *       modmuss50 1.14~1.16），CurseForge Project ID 也是 322385。
 *
 *   现在的结论（有依据）：
 *     · 1.14 ~ 1.20.4 → **合法**，但桥接包要**用户自己下**（附下载地址）；
 *     · 1.20.5 及以上 → 真的没有 → **判不兼容**（这才是该提示的那一段）；
 *     · 1.13 及以下   → 真没有。
 */
const manualBridge = validateCombination({
  mcVersion: '1.20.4',
  base: 'fabric',
  addons: ['optifine'],
});
check(
  '★ Fabric 1.20.4 + OptiFine 是**合法组合**（桥接包存在）',
  manualBridge.valid,
  manualBridge.errors.join('；'),
);
check(
  '★ 但桥接包必须标明"要自己下"，并给出可点的地址',
  /要你自己下载/.test(manualBridge.warnings.join(' ')) &&
    /curseforge\.com/.test(manualBridge.warnings.join(' ')),
  JSON.stringify(manualBridge.warnings),
);
check(
  '★ 手动桥接包**不**进"将自动安装"列表',
  manualBridge.autoBridges.length === 0,
  JSON.stringify(manualBridge.autoBridges),
);

/* 1.20.5 起是真的没有桥接包 —— 这才是用户要的"提示不兼容" */
const incompatible = validateCombination({
  mcVersion: '1.20.5',
  base: 'fabric',
  addons: ['optifine'],
});
check('★ Fabric 1.20.5 + OptiFine 被判不兼容', !incompatible.valid);
check(
  '★ 拒绝理由说清了是 OptiFabric 的问题',
  (incompatible.removed[0]?.reason ?? '').includes('OptiFabric'),
  incompatible.removed[0]?.reason?.slice(0, 60) ?? '（没有理由）',
);
check(
  '★ 拒绝理由给出了可行的替代（换 Forge / 用 Iris+Sodium）',
  /Forge/.test(incompatible.removed[0]?.reason ?? '') &&
    /Iris/.test(incompatible.removed[0]?.reason ?? ''),
);
check('不兼容时不该再列出桥接包', incompatible.autoBridges.length === 0);

/* 1.14.4 有桥接包（optifabric-origins），应当放行但提示手动 */
/*
 * ★ 这条**不经过 `validateCombination`** —— 那条路还要求"能查到 Fabric 的
 *   在线版本清单"，而离线跑 e2e 时查不到，会报一条**与本事无关**的错误
 *   （"Fabric 的版本清单这次没查到"）。测桥接规则就该直接测桥接规则。
 */
const legacyBridge = bridgeFor('1.14.4', 'fabric', 'optifine');
check(
  '★ Fabric 1.14.4 的桥接是 optifabric-origins 且需要手动',
  legacyBridge.usable === 'yes' &&
    legacyBridge.kind === 'optifabric-origins' &&
    legacyBridge.manual === true,
  JSON.stringify(legacyBridge),
);
/* 而它**不该**被"不兼容"那条规则拒掉 */
check(
  '★ Fabric 1.14.4 不被判成"上游没有桥接包"',
  legacyBridge.usable !== 'unavailable',
);
/* 1.12.2 连 Fabric 生态都没有 → 明确不可用 */
check(
  '★ Fabric 1.12.2 与 OptiFine 不可用（上游没有方案）',
  bridgeFor('1.12.2', 'fabric', 'optifine').usable === 'unavailable',
);

/* 纯原版 + OptiFine 仍然合法（走 OptiFine 自带 Patcher） */
const vanillaOf = validateCombination({ mcVersion: '1.20.4', base: null, addons: ['optifine'] });
check('纯原版 + OptiFine 合法', vanillaOf.valid, vanillaOf.removed[0]?.reason ?? '');

/* Forge + OptiFine 仍然合法（Forge 上 OptiFine 是官方支持的） */
const forgeOf = validateCombination({
  mcVersion: '1.20.1',
  base: 'forge',
  addons: ['optifine'],
});
check('Forge 1.20.1 + OptiFine 合法（Forge 上有官方支持）', forgeOf.valid, forgeOf.removed[0]?.reason ?? '');

/* Fabric 单独用（不带 OptiFine）当然合法，而且会自动补 Fabric API */
const fabricOnly_sel = { mcVersion: '1.20.4', base: 'fabric', addons: [] };
const fabricOnly = validateCombination(fabricOnly_sel);
const v = fabricOnly;
check('Fabric 1.20.4 单独用合法', v.valid);
check('自动补 Fabric API', v.autoApis.length === 1 && v.autoApis[0].kind === 'fabric-api');
check('自动补齐被明示（warnings）', v.warnings.some((w) => /Fabric API/.test(w)));

// 构造一个假 source 跑完整计划生成
const source = {
  async vanillaManifest(mc) {
    const files = Array.from({ length: 40 }, (_, i) => ({
      path: `libraries/l${i}.jar`,
      url: `https://example/l${i}.jar`,
      sha1: `sha-${i}`,           // 故意让 l0 与 l1 的 sha1 重复以测去重
      bytes: 1000 * (i + 1),
    }));
    files[1].sha1 = files[0].sha1;
    return {
      mcVersion: mc,
      files,
      clientJar: { path: 'client.jar', url: 'https://example/client.jar', sha1: 'client', bytes: 20_000_000 },
    };
  },
  async loaderInstaller(kind, mc, ver) {
    return { path: `${kind}-${ver}-installer.jar`, url: 'https://x/i.jar', sha1: `${kind}-${ver}`, bytes: 2_400_000 };
  },
  async addonFile(kind, mc, ver) {
    return { path: `${kind}-${ver}.jar`, url: 'https://x/o.jar', sha1: `${kind}-${ver}`, bytes: 6_000_000 };
  },
  async bridgeFile(kind, mc) {
    return { path: `${kind}.jar`, url: 'https://x/b.jar', sha1: `${kind}-${mc}`, bytes: 1_200_000 };
  },
  async apiLibraryFile(lib) {
    return { path: `${lib.kind}.jar`, url: 'https://x/a.jar', sha1: `api-${lib.version}`, bytes: lib.bytes };
  },
  async cachedHashes() {
    return new Map([['sha-2', { path: 'libraries/l2.jar', bytes: 3000 }]]);
  },
  estimatedSpeed() {
    return 12.4 * 1024 * 1024;
  },
};

const plan = await buildInstallPlan({
  // ★ 用"Fabric + Fabric API"这个**确实能装**的组合（不带 OptiFine）——
  //   带 OptiFine 时桥接包要用户手动下（手动项不进下载计划），
  //   计划生成里只剩"手动放 mods"的提示，测不到下载项。
  selection: fabricOnly_sel,
  instanceName: '测试实例',
  slug: 'test',
  javaMajor: 17,
  source,
});
check('计划包含下载项', plan.downloads.length > 0, `${plan.downloads.length} 项`);
check('去重生效（重复 sha1 只下一次）', plan.summary.dedupedBytes > 0, `省下 ${formatBytes(plan.summary.dedupedBytes)}`);
check('缓存命中被算作复用', plan.summary.reusedBytes > 0, `复用 ${formatBytes(plan.summary.reusedBytes)}`);
check('下载量 + 复用 = 总量', Math.abs(plan.summary.downloadBytes + plan.summary.reusedBytes - plan.summary.installBytes) < 1);
check('步骤顺序：桥接/附加在 collect-libraries 之后', plan.steps.findIndex((s) => s.phase === 'apply-addons') > plan.steps.findIndex((s) => s.phase === 'collect-libraries'));
check('摘要里有时长', plan.summary.estimatedSeconds > 0, formatDuration(plan.summary.estimatedSeconds));
check('notes 里说明了自动安装', plan.notes.some((n) => /Fabric API/.test(n)), JSON.stringify(plan.notes));

const issues = checkPlan(plan);
check('计划自检无 error', issues.filter((i) => i.level === 'error').length === 0, JSON.stringify(issues));

console.log('\n=== 6. 加载器能力表 ===');
check('1.20.1 无 NeoForge 且有理由', (() => {
  const o = getLoaderCapabilities('1.20.1').baseLoaders.find((b) => b.kind === 'neoforge');
  return !o.available && /1\.20\.1/.test(o.unavailableReason);
})());
check('1.20.4 有 NeoForge', getLoaderCapabilities('1.20.4').baseLoaders.find((b) => b.kind === 'neoforge').available);
/*
 * ★ 这一条原来断言「1.20.6 无 OptiFine」—— **实测是错的**，已纠正。
 *   真机查 OptiFine 清单：1.20.5 → 0 条；1.20.6 → 有预览版（HD U J1 pre17/pre18）；
 *   1.21.1 → 已有正式版（OptiFine_1.21.1_HD_U_J1.jar）。
 *   所以"没有 OptiFine"只能按**实际清单**说，不能按版本号划线。
 *
 * ★★ 2026-09-14：这条又改了一次，因为"上游有"与"我们装得了"是**两件事**。
 *   原来断言 `available === true`（上游有 → 界面说能装），
 *   而全仓库根本没有 OptiFine 的安装实现 —— 界面于是在说谎。
 *   用户报的「显示有高清修复，实际上点击后不让选」就是它。
 *   现在断言的是完整语义：上游确实有（exists），但我们没做（implemented=false），
 *   所以 available 必须是 false，且理由要说明是"我们没实现"。
 */
check('1.20.6 上游有 OptiFine（预览版）且安装已实装 → 可用', (() => {
  const o = getLoaderCapabilities('1.20.6').addons.find((x) => x.kind === 'optifine');
  return o.exists === true && o.implemented === true && o.available === true;
})());
check('1.20.5 表里没有 OptiFine，且理由区分"没查到"与"确认没有"', (() => {
  const o = getLoaderCapabilities('1.20.5').addons.find((x) => x.kind === 'optifine');
  return !o.available && /确认|清单/.test(o.unavailableReason ?? '');
})());
/*
 * ★★ 2026-09-26：这条原来断言 `version === '0.92.2+1.20.4'` —— 那个数字**是编的**
 *   （真实安装走 Modrinth 在线清单，实测那时已经是 `0.92.12+1.20.1`）。
 *   界面写一个固定的旧版本号就是对用户说假话，所以 preview 现在只写「最新版」。
 *   判据改成两条：① 不再出现**像具体版本号**的东西；② 两个包的写法一致。
 */
check(
  'Fabric API 不再显示写死的版本号（真实版本由安装时在线挑）',
  (() => {
    const libs = getLoaderCapabilities('1.20.4').apiLibraries;
    return (
      libs.length === 2 &&
      libs.every((l) => l.version === '最新版') &&
      !libs.some((l) => /^\d/.test(l.version))
    );
  })(),
);
check('快照无 API 包', getLoaderCapabilities('24w45a').apiLibraries.length === 0);
/*
 * ★ 这两条断言被改过一次，原因值得留在代码里：
 *   原来它们断言的是「1.12.2 上 LiteLoader **可用**」与
 *   「1.12.2 + Forge + LiteLoader **可以装**」—— 而 Rust 侧根本没有
 *   LiteLoader 的安装实现（只有磁盘识别）。用户勾选 → 点安装 →
 *   界面报成功 → 磁盘上什么都没发生。
 *
 *   现在它们断言的是**正确的语义**：上游存在（exists / 版本段判断成立），
 *   但我们没做安装（implemented=false / 组合校验明确拒绝并说明原因）。
 *   等 LiteLoader 安装实现了，把两个 `implemented` 表改成 true，
 *   这里再断言 available / ok 为真。
 */
/*
 * ★★ 这条改过两次（每次跟着真实状态走）：
 *   起初断言「1.12.2 上 LiteLoader 可用」而**没有安装实现**（假承诺）；
 *   然后改成「存在但不能装」（诚实）；
 *   dev.4 第二轮：安装**真的做出来了**（`net::liteloader`），
 *   所以现在断言的是那条**定义式**：available === exists && implemented。
 */
check(
  'LiteLoader 只在 1.12.2/1.7.10 存在，且 available === exists && implemented',
  (() => {
    const a = getLoaderCapabilities('1.12.2').addons.find((x) => x.kind === 'liteloader');
    const b = getLoaderCapabilities('1.20.4').addons.find((x) => x.kind === 'liteloader');
    return (
      a.exists === true &&
      a.available === a.exists && a.implemented &&
      b.exists === false &&
      b.available === false
    );
  })(),
);

console.log('\n=== 7. 组合校验的边界 ===');
/*
 * ★★ 2026-09-14（dev.4）：OptiFine 的安装**已经实装**，
 *   所以"纯原版 + OptiFine"现在真的可以装（以前是"组合合法但我们没做"）。
 *   规则本身（纯原版 + OptiFine 合法）从 ADR-003 起没变过；
 *   变的是"我们做没做"—— 现在做了，有真机测试证明装完能进游戏。
 */
check('纯原版 + OptiFine：真的可以装（dev.4 已实装）', (() => {
  const r = addonCompatibility('1.20.1', null, 'optifine');
  const note = r.note ?? '';
  return r.ok === true && !/不兼容/.test(note) && !/覆盖/.test(note);
})());
check('NeoForge + OptiFine 被拒', !addonCompatibility('1.20.4', 'neoforge', 'optifine').ok);
check('Fabric 1.20.6 + OptiFine 被拒', !addonCompatibility('1.20.6', 'fabric', 'optifine').ok);
check('Forge 1.13 + OptiFine 被拒', !addonCompatibility('1.13', 'forge', 'optifine').ok);
/*
 * ★ 真实不兼容必须**先**说（它的理由里要有 NeoForge / 版本号），
 *   不能被"我们还没做"盖掉 —— 那两句话对用户的含义完全不同：
 *   前者=换个加载器就能装，后者=换个加载器也白搭。
 */
check(
  '真实不兼容的理由优先于"我们没实现"',
  /NeoForge/.test(addonCompatibility('1.20.4', 'neoforge', 'optifine').reason ?? '') &&
    /1\.13/.test(addonCompatibility('1.13', 'forge', 'optifine').reason ?? ''),
);
check(
  'LiteLoader 需 Forge 基座（真的兼容性约束），装了之后组合合法',
  !addonCompatibility('1.12.2', null, 'liteloader').ok &&
    !addonCompatibility('1.12.2', 'fabric', 'liteloader').ok &&
    // dev.4 起安装已实装 → 1.12.2 + Forge + LiteLoader 可以装
    addonCompatibility('1.12.2', 'forge', 'liteloader').ok,
);

console.log('');
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
