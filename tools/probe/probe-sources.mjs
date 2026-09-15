/* 真实元数据源可达性探测 —— 这决定实现方案 */
const targets = [
  ['Mojang 版本清单', 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'],
  ['Mojang 资源', 'https://resources.download.minecraft.net/'],
  ['BMCLAPI 版本清单', 'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json'],
  ['BMCLAPI 版本详情', 'https://bmclapi2.bangbang93.com/version/1.20.1/json'],
  ['Fabric Meta', 'https://meta.fabricmc.net/v2/versions/loader/1.20.1'],
  ['Fabric Maven', 'https://maven.fabricmc.net/'],
  ['Quilt Meta', 'https://meta.quiltmc.org/v3/versions/loader/1.20.1'],
  ['Forge Maven 元数据', 'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml'],
  ['Forge 宣传 JSON', 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json'],
  ['NeoForge Maven', 'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml'],
  ['Modrinth API', 'https://api.modrinth.com/v2/project/sodium'],
  ['CurseForge API', 'https://api.curseforge.com/v1/games'],
  ['Adoptium API', 'https://api.adoptium.net/v3/info/available_releases'],
  ['Mojang 认证', 'https://user.auth.xboxlive.com/user/authenticate'],
  ['OptiFine 清单', 'https://optifine.net/downloads'],
];

async function probe(name, url, method = 'GET') {
  const t0 = Date.now();
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 12000);
    const res = await fetch(url, {
      method,
      signal: ctl.signal,
      headers: { 'user-agent': 'IEML-Launcher/0.1 (probe)' },
    });
    clearTimeout(timer);
    const ms = Date.now() - t0;
    let extra = '';
    if (res.ok) {
      const ct = res.headers.get('content-type') ?? '';
      if (method === 'GET' && (ct.includes('json') || url.endsWith('.json'))) {
        const text = await res.text();
        extra = `  ${(text.length / 1024).toFixed(1)} kB`;
      } else {
        const buf = await res.arrayBuffer();
        extra = `  ${(buf.byteLength / 1024).toFixed(1)} kB`;
      }
    }
    return { name, url, status: res.status, ok: res.ok, ms, extra };
  } catch (e) {
    return { name, url, status: 0, ok: false, ms: Date.now() - t0, extra: `  ${e.name}: ${e.message}` };
  }
}

console.log('探测真实元数据源（12 秒超时）...\n');
for (const [name, url] of targets) {
  const r = await probe(name, url);
  const mark = r.ok ? '✓' : '✗';
  console.log(`${mark} ${String(r.status).padStart(3)} ${String(r.ms).padStart(6)}ms  ${name.padEnd(22)} ${r.extra}`);
  if (!r.ok) console.log(`      ${url}`);
}
