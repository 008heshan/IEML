/*
 * 复核：上一轮 probe-source-policy.mjs 里「国内 1/3」的三项，
 * 是否是**连续快速请求触发限流**造成的假象。
 *
 * 做法：同样 3 次，但每次间隔 3 秒；外加一组「间隔 0 秒」做对照。
 */
const TARGETS = [
  ['原版版本清单', 'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json'],
  ['NeoForge maven-metadata', 'https://bmclapi2.bangbang93.com/maven/net/neoforged/neoforge/maven-metadata.xml'],
  ['Modrinth CDN 镜像', 'https://mod.mcimirror.top/data/AANobbMI/versions/VHtnT9Q4/sodium-neoforge-0.9.2%2Bmc26.3.jar'],
  ['Modrinth CDN 官方', 'https://cdn.modrinth.com/data/AANobbMI/versions/VHtnT9Q4/sodium-neoforge-0.9.2%2Bmc26.3.jar'],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function once(url) {
  const t0 = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'IEML-Launcher/0.1' } });
    const ttfb = Date.now() - t0;
    let bytes = 0;
    try { bytes = (await res.arrayBuffer()).byteLength; } catch {}
    clearTimeout(timer);
    return { status: res.status, ttfb, bytes };
  } catch (e) {
    clearTimeout(timer);
    return { status: 0, ttfb: Date.now() - t0, bytes: 0, err: e.name };
  }
}

async function run(label, url, gapMs) {
  const runs = [];
  for (let i = 0; i < 3; i++) {
    if (i > 0 && gapMs > 0) await sleep(gapMs);
    runs.push(await once(url));
  }
  const line = runs
    .map((r) => (r.status ? `${r.status}/${r.ttfb}ms/${(r.bytes / 1024).toFixed(0)}kB` : `ERR(${r.err})`))
    .join('  ');
  const ok = runs.filter((r) => r.status > 0).length;
  console.log(`  ${label}`);
  console.log(`      连打(间隔0s) : ${ok ? '' : ''}${line}   → ${ok}/3`);
  return ok;
}

console.log('限流假象复核\n');
for (const [label, url] of TARGETS) {
  console.log(`── ${label} ──`);
  const burst = [];
  for (let i = 0; i < 3; i++) burst.push(await once(url));
  console.log(`      连打(间隔0s) : ${burst.map((r) => (r.status ? `${r.status}/${r.ttfb}ms/${(r.bytes / 1024).toFixed(0)}kB` : `ERR(${r.err})`)).join('  ')}`);
  await sleep(4000);
  const spaced = [];
  for (let i = 0; i < 3; i++) { if (i) await sleep(3000); spaced.push(await once(url)); }
  console.log(`      间隔3s      : ${spaced.map((r) => (r.status ? `${r.status}/${r.ttfb}ms/${(r.bytes / 1024).toFixed(0)}kB` : `ERR(${r.err})`)).join('  ')}`);
  const b = burst.filter((r) => r.status > 0).length;
  const s = spaced.filter((r) => r.status > 0).length;
  console.log(`      → 连打 ${b}/3 , 间隔 ${s}/3  ${s > b ? '★ 确认是限流假象' : '（间隔无改善，非限流）'}`);
  await sleep(2000);
}
