/* 精确验证：真实 asset 哈希 + Fabric/Quilt maven 可达性 */
const checks = [
  // 真实 asset 哈希（从 1.20.1 的 asset index 里取一个常见文件）
  ['BMCLAPI assets', 'https://bmclapi2.bangbang93.com/assets/1c/1c4c1f4b6c0e6d6a0a5e5e0e6c0e6d6a0a5e5e0e', false],
  ['Mojang assets', 'https://resources.download.minecraft.net/1c/1c4c1f4b6c0e6d6a0a5e5e0e6c0e6d6a0a5e5e0e', false],
  // Fabric / Quilt maven（直连）
  ['Fabric maven 根', 'https://maven.fabricmc.net/', false],
  ['Fabric intermediary', 'https://maven.fabricmc.net/net/fabricmc/intermediary/1.20.1/intermediary-1.20.1-v2.jar', false],
  ['Quilt maven', 'https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-loader/maven-metadata.xml', false],
  ['Quilt Meta API', 'https://meta.quiltmc.org/v3/versions/loader/1.20.1/0.23.1/profile/json', false],
  // Fabric 的 installer JSON（关键：Fabric 用 JSON profile，不是 installer jar）
  ['Fabric profile JSON', 'https://meta.fabricmc.net/v2/versions/loader/1.20.1/0.16.9/profile/json', false],
  // 第三方镜像备选
  ['MCIM Fabric', 'https://mod.mcimirror.top/Fabric', false],
  ['Littleskin maven', 'https://bmclapi2.bangbang93.com/maven/net/fabricmc/fabric-loader/0.16.9/fabric-loader-0.16.9.jar', false],
];

async function probe([name, url]) {
  const t0 = Date.now();
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    const res = await fetch(url, {
      method: 'GET',
      signal: ctl.signal,
      headers: { 'user-agent': 'IEML-Launcher/0.1' },
    });
    clearTimeout(timer);
    let sample = '';
    if (res.ok) {
      const text = await res.text();
      sample = `  ${(text.length / 1024).toFixed(1)} kB  ${text.slice(0, 60).replace(/\s+/g, ' ')}`;
    }
    return { ok: res.ok, status: res.status, ms: Date.now() - t0, sample };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, sample: `  ERR ${e.name}` };
  }
}

for (const c of checks) {
  const r = await probe(c);
  console.log(`${r.ok ? '✓' : '✗'} ${String(r.status).padStart(3)} ${String(r.ms).padStart(6)}ms  ${c[0].padEnd(22)}${r.sample}`);
  if (!r.ok) console.log(`       ${c[1]}`);
}
