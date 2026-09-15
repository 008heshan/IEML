/* 取 1.20.1 的真实 asset 哈希与 library 路径，验证下载源 */
const VERSION_JSON = 'https://bmclapi2.bangbang93.com/version/1.20.1/json';

const res = await fetch(VERSION_JSON, { headers: { 'user-agent': 'IEML/0.1' } });
const v = await res.json();
console.log(`版本: ${v.id}  类型: ${v.type}  时间: ${v.releaseTime}`);
console.log(`资产索引: ${v.assetIndex?.id}  ${v.assetIndex?.url}`);
console.log(`主类: ${v.mainClass}`);
console.log(`库数量: ${v.libraries?.length}`);
console.log(`参数: ${v.arguments ? '含 arguments（新版格式）' : '含 minecraftArguments（旧格式）'}`);

const idx = await fetch(v.assetIndex.url, { headers: { 'user-agent': 'IEML/0.1' } });
const idxJson = await idx.json();
const objects = Object.entries(idxJson.objects);
console.log(`\n资源文件总数: ${objects.length}`);
const [name, obj] = objects[0];
const hash = obj.hash;
const sub = hash.slice(0, 2);
console.log(`样例: ${name}`);
console.log(`  hash=${hash}  size=${obj.size}`);

/* 验证各个源的该文件可下载性 */
const sources = [
  ['Mojang 官方', `https://resources.download.minecraft.net/${sub}/${hash}`],
  ['BMCLAPI 镜像', `https://bmclapi2.bangbang93.com/assets/${sub}/${hash}`],
];
console.log('\n=== 资源文件下载验证 ===');
for (const [name2, url] of sources) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    const r = await fetch(url, { method: 'HEAD', signal: ctl.signal });
    clearTimeout(t);
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.status}  ${(Number(r.headers.get('content-length')) / 1024).toFixed(1)} kB (期望 ${(obj.size / 1024).toFixed(1)})  ${name2}`);
  } catch (e) {
    console.log(`  ✗ ERR ${e.name}  ${name2}`);
  }
}

/* 验证一个 library 的各源 */
const lib = v.libraries.find((l) => l.downloads?.artifact?.url);
console.log(`\n=== 库文件下载验证 ===`);
console.log(`样例库: ${lib.name}`);
const art = lib.downloads.artifact;
console.log(`  官方 URL: ${art.url}`);
const libSources = [['Mojang 官方', art.url]];
const m = art.url.match(/^https:\/\/libraries\.minecraft\.net\/(.*)$/);
if (m) libSources.push(['BMCLAPI 镜像', `https://bmclapi2.bangbang93.com/maven/${m[1]}`]);
for (const [n, url] of libSources) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    const r = await fetch(url, { method: 'HEAD', signal: ctl.signal });
    clearTimeout(t);
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.status}  ${(Number(r.headers.get('content-length')) / 1024).toFixed(1)} kB  ${n}`);
    console.log(`      ${url}`);
  } catch (e) {
    console.log(`  ✗ ERR ${e.name}  ${n}  ${url}`);
  }
}

/* 客户端 jar */
console.log('\n=== 客户端 jar ===');
for (const [n, url] of [
  ['Mojang 官方', v.downloads.client.url],
  ['BMCLAPI 镜像', 'https://bmclapi2.bangbang93.com/version/1.20.1/client'],
]) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    const r = await fetch(url, { method: 'HEAD', signal: ctl.signal });
    clearTimeout(t);
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.status}  ${(Number(r.headers.get('content-length')) / 1024 / 1024).toFixed(1)} MB  ${n}`);
  } catch (e) {
    console.log(`  ✗ ERR ${e.name}  ${n}`);
  }
}
