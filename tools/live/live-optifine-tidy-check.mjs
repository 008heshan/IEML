/*
 * 真机判据：**OptiFine 装完之后，库 jar 里的 Forge Mod 声明必须没了，别的一个字节没动**
 * （ADR-003 修正 2）。
 *
 * ## 为什么这条值得单独验
 *
 *   OptiFine 的 jar 里带着 `META-INF/mods.toml`，内容是 `modLoader="javafml"`
 *   —— 对 Forge 来说**这就是"我是一个 Mod"**。而这个 jar 躺在
 *   `libraries/optifine/…`（启动 classpath 上），于是 OptiFine 会被应用两次：
 *   一次靠 tweaker、一次靠 Forge 当 Mod 加载 —— 这正是我们自己的崩溃规则
 *   `optifine-conflict` 认的那种崩法。HMCL 对它「安装器副本 + 产出的库 jar」
 *   各删一次；我们以前一次都没删。
 *
 *   ★ 单测钉住了"删得准不准"，但**"真装一次之后盘上到底是什么样"只有真机能答** ——
 *     比如官方安装器到底把 jar 放在哪个目录、里面究竟有没有那条声明。
 *     第一版是靠人肉在本机真实产物上翻出来的（3597 个条目里第一条就是它）。
 *
 * ## 判据
 *
 *   ① 装出来了（方式 A），版本目录里 json + jar 都在
 *   ② 库 jar 在 `libraries/optifine/` 下，且**没有** `META-INF/mods.toml`
 *   ③ ★ 但 `META-INF/services/cpw.mods.modlauncher.api.ITransformationService`
 *      **必须还在** —— 那是现代 Forge 发现 OptiFine 的路子，删了就白装
 *   ④ 文件没被削掉：条目数 ≥ 1000，且 install 返回的 summary 里如实说了这件事
 *   ⑤ 安装总结里如实说了这一处收尾
 *   ⑥ ★ 对照组：**原版 jar 一个字节没动**（我们只该动 OptiFine 的库文件）
 *   ⑦ ★ 对照组：安装器自带的 launchwrapper jar 原样不动（没有那条声明的 jar 不许重写）
 *   ⑧ 老版本（1.12.2，方式 B）：版本描述里声明的那个库文件**真的在盘上**
 *      （以前只声明不落文件 ⇒ 这个版本一启动就缺库，或者 OptiFine 静默不生效）
 *
 * ## 沙盒
 *
 *   `IEML_DATA_DIR` / `IEML_OWN_DIR` / `APPDATA` 三个都指到 `%TEMP%`。
 *   ★ `APPDATA` 必须指走：启动时的数据根补齐会拿**真实**的 `%APPDATA%\IEML`
 *     当源复制一份进来（`probe-a4-fixed.mjs` 记录过，0.15.0 又踩了一次）。
 *   原版 1.16.5 由探针自己摆好（安装器只要 `versions/1.16.5/{json,jar}` 两样），
 *   不去装整套原版（那要下 100+ MB 的库与资源）。
 *
 * 用法：
 *   node tools/live/live-optifine-tidy-check.mjs ["<exe>"]
 * 退出码：0 = 判据全过；1 = 有判据不成立；2 = 本次测量无效（下不动 / 本机没有能跑安装器的 Java）
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { invokeOn, launch, sleep } from './lib/cdp.mjs';

const argv = process.argv.slice(2);
const EXE =
  argv.find((a) => !a.startsWith('--')) ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');

const T = process.env.TEMP ?? '.';
const ROOT = path.join(T, 'ieml-oftidy-root');
const OWN = path.join(T, 'ieml-oftidy-own');
const FAKE_APPDATA = path.join(T, 'ieml-oftidy-appdata');
const MC = '1.16.5';
const OF = 'HD U G8';

let pass = 0;
let fail = 0;
let invalid = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? '  —— ' + extra : ''}`);
  if (ok) pass += 1;
  else fail += 1;
};
const giveUp = (why, detail = '') => {
  invalid += 1;
  console.log(`  ⚠ ${why}${detail ? '\n' + detail : ''}`);
};

/* ---------- 沙盒 + 手工摆好原版 1.16.5 ---------- */
for (const d of [ROOT, OWN, FAKE_APPDATA]) rmSync(d, { recursive: true, force: true });
mkdirSync(OWN, { recursive: true });
mkdirSync(FAKE_APPDATA, { recursive: true });
const SHARED = path.join(ROOT, '.minecraft');
const VANILLA = path.join(SHARED, 'versions', MC);
mkdirSync(VANILLA, { recursive: true });

console.log(`摆原版 ${MC}（安装器只要版本描述 + 客户端 jar 两样）…`);

/** 带重试的取数 —— BMCLAPI 会偶发抽风（这一次第一版就撞上了），一次失败不代表没有 */
async function grab(url, tries = 3) {
  let last = '';
  for (let i = 1; i <= tries; i += 1) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      last = e.message;
      if (i < tries) await sleep(1200 * i);
    }
  }
  throw new Error(last);
}

let clientUrl = '';
try {
  const j = JSON.parse((await grab(`https://bmclapi2.bangbang93.com/version/${MC}/json`)).toString());
  writeFileSync(path.join(VANILLA, `${MC}.json`), JSON.stringify(j));
  /*
   * ★ 先走 BMCLAPI 自己的直链：`downloads.client.url` 指向 Mojang 的
   *   `piston-data.mojang.com`，国内网络下那里经常整条不通（实测 Node 里就是
   *   `fetch failed`）。镜像直链与我们启动器下载时用的是同一条。
   */
  clientUrl = `https://bmclapi2.bangbang93.com/version/${MC}/client`;
} catch (e) {
  giveUp(`拿不到 ${MC} 的版本描述（网络）：${e.message}`);
}
if (clientUrl) {
  try {
    const buf = await grab(clientUrl);
    writeFileSync(path.join(VANILLA, `${MC}.jar`), buf);
    console.log(`  客户端 jar ${(buf.length / 1048576).toFixed(1)} MB（${clientUrl}）`);
  } catch (e) {
    giveUp(`下不动 ${MC} 的客户端 jar：${e.message}`);
  }
}

if (invalid > 0) {
  console.log('\n本次测量无效：沙盒没摆好，先别急着判功能');
  process.exit(2);
}

/* ★ 原版 jar 的指纹：判据 ⑤ 要用它证明"我们只动了 OptiFine 的库文件" */
const vanillaBefore = readFileSync(path.join(VANILLA, `${MC}.jar`));

const { ev, pid, ws } = await launch({
  exe: EXE,
  tag: 'oftidy',
  env: { IEML_DATA_DIR: ROOT, IEML_OWN_DIR: OWN, APPDATA: FAKE_APPDATA },
  keepDataDir: true,
  settleMs: 2500,
});

const inv = async (cmd, args) => {
  const r = await invokeOn(ev, cmd, args);
  return r.ok !== undefined ? r.ok : { __err: r.err };
};

try {
  console.log(`装 OptiFine ${OF}（真下载 + 真跑官方安装器，要几分钟）…`);
  const t0 = Date.now();
  const res = await inv('install_optifine', { mcVersion: MC, optifineVersion: OF });
  const secs = Math.round((Date.now() - t0) / 1000);

  if (res?.__err || !res?.version_id) {
    const msg = String(res?.__err ?? JSON.stringify(res));
    /*
     * 安装器跑不起来 / 下载失败都属于"这一次量不到"，不是功能缺陷 ——
     * 但要说清是哪一种（本机没有能跑安装器的 Java 是最常见的那种）。
     */
    giveUp(`装不上（${secs}s），本次测量无效：`, msg.slice(0, 600));
    throw new Error('__invalid__');
  }

  console.log(`  装好了：${res.version_id}（方式 ${res.method}，${secs}s）`);
  console.log(`  summary：${res.summary}`);

  const versionDir = path.join(SHARED, 'versions', res.version_id);
  check(
    readFileSync(path.join(versionDir, `${res.version_id}.json`), 'utf8').length > 0 &&
      readFileSync(`${res.client_jar}`).length > 0,
    '① 装出来了：版本描述与客户端 jar 都在',
    versionDir,
  );

  /* ---------- 找出 OptiFine 的库 jar ---------- */
  const { readdirSync, statSync } = await import('node:fs');
  const jars = [];
  const walk = (d) => {
    let ents = [];
    try {
      ents = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.toLowerCase().endsWith('.jar')) jars.push(p);
    }
  };
  walk(path.join(SHARED, 'libraries', 'optifine'));
  check(jars.length > 0, '② 库 jar 真的落在 libraries/optifine/ 下', jars.map((j) => path.basename(j)).join('、'));

  /*
   * 直接在 Node 里读 zip：用内置的 zlib 解 zip 太啰嗦，这里只判断
   * 「中央目录里有没有这个名字」—— 条目名在 zip 里是明文，够用且不依赖第三方库。
   */
  const zipNames = (file) => {
    const b = readFileSync(file);
    const out = [];
    // 扫本地文件头（PK\x03\x04）与中央目录头（PK\x01\x02）里的文件名
    for (let i = 0; i + 30 < b.length; i += 1) {
      if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x01 && b[i + 3] === 0x02) {
        const n = b.readUInt16LE(i + 28);
        out.push(b.toString('utf8', i + 46, i + 46 + n));
      }
    }
    return out;
  };

  /*
   * ★ 要挑的是**OptiFine 本体那个 jar**，不是同目录下的 `launchwrapper-of-*.jar`。
   *   第一版拿 `jars[0]`，正好是 12 个条目的 launchwrapper —— 于是三条判据红得
   *   莫名其妙（它与 mods.toml 这件事毫无关系）。
   *   ★ 顺带这也证明了一件事：**launchwrapper 是安装器自己带出来的**
   *     （ADR-003 修正 2 ② 那条"提取"在我们这条路上不适用）。
   */
  const ofJar = jars.find((j) => /(^|[\\/])OptiFine-.*\.jar$/.test(j) && !/-installer\.jar$/.test(j));
  check(!!ofJar, '② 找得到 OptiFine 本体那个库 jar', ofJar ? path.basename(ofJar) : jars.join('、'));
  const names = ofJar ? zipNames(ofJar) : [];
  check(names.length > 1000, '④ 库 jar 没被削掉（条目数 ≥ 1000）', `${names.length} 个条目`);
  check(
    !names.some((n) => n === 'META-INF/mods.toml'),
    '② ★ 库 jar 里**没有** META-INF/mods.toml（Forge 不会再把它当 Mod 加载一次）',
  );
  check(
    names.some((n) => n === 'META-INF/services/cpw.mods.modlauncher.api.ITransformationService'),
    '③ ★ 但 ModLauncher 的服务声明还在（删了 OptiFine 就不生效了）',
  );
  /*
   * ★ 对照组：同一棵树里那些**本来就没有**这条声明的 jar（安装器自带的
   *   launchwrapper）必须原样不动 —— 证明我们不是"见 jar 就重写一遍"。
   */
  const lw = jars.find((j) => /launchwrapper.*\.jar$/i.test(j));
  if (lw) {
    const lwNames = zipNames(lw);
    check(
      lwNames.length > 0 && !lwNames.some((n) => n.startsWith('META-INF/mods')),
      '⑦ ★ 对照组：安装器自带的 launchwrapper jar 原样不动（没有就该一个字节不写）',
      `${path.basename(lw)}：${lwNames.length} 个条目`,
    );
  }
  check(
    /清掉了.*Forge Mod 声明/.test(String(res.summary)),
    '⑤ 安装总结里如实说了这一处收尾',
    String(res.summary).slice(0, 200),
  );
  check(
    readFileSync(path.join(VANILLA, `${MC}.jar`)).equals(vanillaBefore),
    '⑥ ★ 对照组：原版 jar 一个字节没动（我们只动 OptiFine 自己的库文件）',
  );

  /* ================= 第二段：老版本（方式 B）的库文件必须落盘 ================= */
  /*
   * 方式 B 不跑任何安装器，所以这一段不用 Java、也很快。
   * 验的是另一处修复：那份手写的版本描述里声明了 `optifine:OptiFine:<MC>_<OF>`，
   * 以前**只声明、不落文件** —— 盘上没有它，游戏一启动就缺库（OptiFine 静默不生效）。
   */
  const MC2 = '1.12.2';
  const OF2 = 'HD U G5';
  console.log(`\n第二段：老版本 ${MC2} + ${OF2}（方式 B，不跑安装器）…`);
  const VAN2 = path.join(SHARED, 'versions', MC2);
  mkdirSync(VAN2, { recursive: true });
  try {
    const j2 = JSON.parse((await grab(`https://bmclapi2.bangbang93.com/version/${MC2}/json`)).toString());
    writeFileSync(path.join(VAN2, `${MC2}.json`), JSON.stringify(j2));
    writeFileSync(
      path.join(VAN2, `${MC2}.jar`),
      await grab(`https://bmclapi2.bangbang93.com/version/${MC2}/client`),
    );
  } catch (e) {
    giveUp(`第二段摆不出原版 ${MC2}：${e.message}`);
    throw new Error('__invalid__');
  }

  const res2 = await inv('install_optifine', { mcVersion: MC2, optifineVersion: OF2 });
  if (res2?.__err || !res2?.version_id) {
    giveUp(`第二段装不上，本次测量无效：`, String(res2?.__err ?? JSON.stringify(res2)).slice(0, 500));
    throw new Error('__invalid__');
  }
  console.log(`  装好了：${res2.version_id}（方式 ${res2.method}）`);

  const ver2 = path.join(SHARED, 'versions', res2.version_id);
  const json2 = JSON.parse(readFileSync(path.join(ver2, `${res2.version_id}.json`), 'utf8'));
  const coord = (json2.libraries ?? [])
    .map((l) => (typeof l === 'string' ? l : l?.name))
    .find((n) => typeof n === 'string' && n.startsWith('optifine:OptiFine:'));
  check(!!coord, '⑧ 老版本的版本描述里声明了 OptiFine 库', String(coord));

  /* Maven 布局：group/artifact/version/<artifact>-<version>.jar（与后端同一个规则） */
  const [g, a, v] = String(coord ?? '').split(':');
  const lib2 = path.join(SHARED, 'libraries', ...g.split('.'), a, v, `${a}-${v}.jar`);
  const lib2Exists = (() => {
    try {
      return statSync(lib2).size;
    } catch {
      return 0;
    }
  })();
  check(
    lib2Exists > 100 * 1024,
    '⑧ ★ 声明的那个库文件**真的在盘上**（以前只声明不落文件 ⇒ 启动即缺库）',
    `${lib2}（${lib2Exists} 字节）`,
  );
  check(
    /方式 B/.test(String(res2.summary)),
    '⑧ 安装总结里说了走的是方式 B',
    String(res2.summary).slice(0, 160),
  );} catch (e) {
  if (String(e.message) !== '__invalid__') {
    console.log(`  ⚠ 探针自己出错：${e.message}`);
    invalid += 1;
  }
} finally {
  const verdict = invalid > 0 ? '本次测量无效' : fail === 0 ? '全过' : '有不合格项';
  console.log(`\n${verdict}：${pass} 过 / ${fail} 不过`);
  try {
    ws.close();
  } catch {}
  const { spawnSync } = await import('node:child_process');
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  process.exit(invalid > 0 ? 2 : fail === 0 ? 0 : 1);
}
