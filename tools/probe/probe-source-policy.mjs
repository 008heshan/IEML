/*
 * 下载源策略探测：官方 vs 国内镜像，逐个对比「成功率 / 延迟 / 首字节」
 *
 * 目的：为 ADR「国内优先 + 低延迟兜底」提供实测依据。
 * 用法：node tools/probe/probe-source-policy.mjs
 */

const ATTEMPTS = 3;
const TIMEOUT_MS = 12000;

/** [分组, 标签, 官方 URL, 国内镜像 URL（无则 null）] */
const PAIRS = [
  ['原版', '版本清单',
    'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
    'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json'],
  ['原版', '版本详情 1.20.1',
    'https://piston-meta.mojang.com/v1/packages/1.20.1.json',
    'https://bmclapi2.bangbang93.com/version/1.20.1/json'],
  ['原版', '库文件 asm-9.5',
    'https://libraries.minecraft.net/org/ow2/asm/asm/9.5/asm-9.5.jar',
    'https://bmclapi2.bangbang93.com/maven/org/ow2/asm/asm/9.5/asm-9.5.jar'],

  ['Fabric', 'meta loader 列表',
    'https://meta.fabricmc.net/v2/versions/loader/1.20.1',
    'https://bmclapi2.bangbang93.com/fabric-meta/v2/versions/loader/1.20.1'],
  ['Fabric', 'loader jar',
    'https://maven.fabricmc.net/net/fabricmc/fabric-loader/0.16.9/fabric-loader-0.16.9.jar',
    'https://bmclapi2.bangbang93.com/maven/net/fabricmc/fabric-loader/0.16.9/fabric-loader-0.16.9.jar'],

  ['Quilt', 'meta loader 列表',
    'https://meta.quiltmc.org/v3/versions/loader/1.20.1',
    'https://bmclapi2.bangbang93.com/quilt-meta/v3/versions/loader/1.20.1'],

  ['Forge', 'promotions JSON',
    'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json',
    'https://bmclapi2.bangbang93.com/forge/promotions_slim.json'],
  ['Forge', 'installer jar',
    'https://maven.minecraftforge.net/net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-installer.jar',
    'https://bmclapi2.bangbang93.com/maven/net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-installer.jar'],

  ['NeoForge', 'maven-metadata',
    'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml',
    'https://bmclapi2.bangbang93.com/maven/net/neoforged/neoforge/maven-metadata.xml'],

  ['Modrinth', 'API project/sodium',
    'https://api.modrinth.com/v2/project/sodium',
    'https://mod.mcimirror.top/modrinth/v2/project/sodium'],
  ['Modrinth', 'CDN jar',
    'https://cdn.modrinth.com/data/AANobbMI/versions/VHtnT9Q4/sodium-neoforge-0.9.2%2Bmc26.3.jar',
    'https://mod.mcimirror.top/data/AANobbMI/versions/VHtnT9Q4/sodium-neoforge-0.9.2%2Bmc26.3.jar'],

  ['CurseForge', 'API games',
    'https://api.curseforge.com/v1/games',
    'https://mod.mcimirror.top/curseforge/v1/games'],
  ['CurseForge', 'forgecdn 文件',
    'https://edge.forgecdn.net/files/2380/873/jei.jar',
    'https://mod.mcimirror.top/files/2380/873/jei.jar'],

  ['OptiFine', '版本列表',
    'https://optifine.net/downloads',
    'https://bmclapi2.bangbang93.com/optifine/versionList'],

  ['Java', 'Adoptium 可用版本',
    'https://api.adoptium.net/v3/info/available_releases',
    null],
  ['Java', 'Adoptium 资产查询',
    'https://api.adoptium.net/v3/assets/latest/21/hotspot?os=windows&architecture=x64&image_type=jdk',
    null],
];

async function once(url) {
  const t0 = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { 'user-agent': 'IEML-Launcher/0.1 (probe)' },
      redirect: 'follow',
    });
    const ttfb = Date.now() - t0;
    let bytes = 0;
    try {
      const buf = await res.arrayBuffer();
      bytes = buf.byteLength;
    } catch { /* 头部到了但体读不下来，也算拿到状态码 */ }
    clearTimeout(timer);
    return { ok: res.ok, status: res.status, ttfb, total: Date.now() - t0, bytes };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, status: 0, ttfb: Date.now() - t0, total: Date.now() - t0, bytes: 0, err: e.name };
  }
}

async function measure(url) {
  const runs = [];
  for (let i = 0; i < ATTEMPTS; i++) runs.push(await once(url));
  const okRuns = runs.filter((r) => r.status > 0);
  const okCount = okRuns.length;
  const med = (arr) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  return {
    okCount,
    n: ATTEMPTS,
    status: runs.find((r) => r.status > 0)?.status ?? 0,
    ttfb: med(okRuns.map((r) => r.ttfb)),
    bytes: Math.max(0, ...runs.map((r) => r.bytes)),
    err: runs.find((r) => r.err)?.err ?? '',
  };
}

const fmt = (m) => {
  if (!m) return '—（无镜像候选）';
  const pct = `${m.okCount}/${m.n}`;
  if (!m.okCount) return `✗ ${pct} 全失败${m.err ? ` (${m.err})` : ''}`;
  const kb = m.bytes ? ` ${(m.bytes / 1024).toFixed(0)}kB` : '';
  const flag = m.okCount === m.n ? '✓' : '△';
  return `${flag} ${pct}  HTTP ${m.status}  ttfb ${String(m.ttfb).padStart(5)}ms${kb}`;
};

console.log('源策略探测 —— 官方 vs 国内镜像（每项 3 次取中位）\n');
let group = '';
const summary = [];
for (const [g, label, official, mine] of PAIRS) {
  if (g !== group) { group = g; console.log(`\n── ${g} ──`); }
  const a = await measure(official);
  const b = mine ? await measure(mine) : null;
  console.log(`  ${label}`);
  console.log(`      官方 : ${fmt(a)}`);
  console.log(`      国内 : ${fmt(b)}`);
  summary.push({ g, label, official: a, mine: b });
}

console.log('\n════════ 结论速览 ════════');
for (const s of summary) {
  const o = s.official, m = s.mine;
  let verdict;
  if (!m) verdict = '无国内镜像 → 只能官方';
  else if (m.okCount > o.okCount) verdict = '★ 国内更可靠';
  else if (m.okCount < o.okCount) verdict = '官方更可靠';
  else if (m.ttfb != null && o.ttfb != null) {
    const d = o.ttfb - m.ttfb;
    verdict = Math.abs(d) < 80 ? '两者相当' : d > 0 ? `★ 国内快 ${d}ms` : `官方快 ${-d}ms`;
  } else verdict = '两者都失败';
  console.log(`  ${s.g.padEnd(11)} ${s.label.padEnd(20)} ${verdict}`);
}
