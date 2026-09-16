/*
 * 验证：Java 运行时能否走 BMCLAPI 镜像（替代 Adoptium）
 *
 * 背景：Adoptium 在国内没有可用镜像（TUNA 整站 403、NJU/BFSU/SJTU 404），
 *      而 BMCLAPI 存在 /v1/products/java-runtime/ 路径。
 *      若可用，Java 下载就能满足「国内有的就用国内」。
 *
 * 判据（缺一不可）：
 *   ① BMCLAPI 的 all.json 能拿到且结构与 Mojang 一致
 *   ② 清单里的**二进制文件**能从 BMCLAPI 取到
 *   ③ 取的字节与 Mojang 官方**完全相同**（sha1 比对）—— 否则等于换了个软件
 */
import { createHash } from 'node:crypto';

const SHA = '2ec0cc96c44e5a76b9c8b7c39df7210883d12871';
const MOJANG = `https://launchermeta.mojang.com/v1/products/java-runtime/${SHA}/all.json`;
const BMCL = `https://bmclapi2.bangbang93.com/v1/products/java-runtime/${SHA}/all.json`;

async function get(url, ms = 20000, asBuffer = false) {
  const t0 = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'IEML-Launcher/0.1' } });
    const ttfb = Date.now() - t0;
    if (!res.ok) { clearTimeout(timer); return { status: res.status, ttfb, ms: Date.now() - t0 }; }
    const body = asBuffer ? Buffer.from(await res.arrayBuffer()) : await res.text();
    clearTimeout(timer);
    return { status: res.status, ttfb, ms: Date.now() - t0, body, bytes: typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength };
  } catch (e) {
    clearTimeout(timer);
    return { status: 0, ttfb: Date.now() - t0, err: e.name };
  }
}

console.log('Java 运行时走 BMCLAPI 的可行性验证\n');

/* ① 两侧清单 */
const moj = await get(MOJANG);
const bm = await get(BMCL);
console.log(`① 清单获取`);
console.log(`   Mojang : ${moj.status === 200 ? `200  ${moj.ttfb}ms  ${moj.bytes}B` : `失败(${moj.status || moj.err})`}`);
console.log(`   BMCLAPI: ${bm.status === 200 ? `200  ${bm.ttfb}ms  ${bm.bytes}B` : `失败(${bm.status || bm.err})`}`);
if (!moj.body || !bm.body) { console.log('\n清单拿不到，验证中止'); process.exit(1); }

const mojJson = JSON.parse(moj.body);
const bmJson = JSON.parse(bm.body);
const pick = (o) => Object.keys(o).filter((k) => k.startsWith('windows')).sort().join(',');
console.log(`   Mojang  windows 平台键 : ${pick(mojJson)}`);
console.log(`   BMCLAPI windows 平台键 : ${pick(bmJson)}`);

/* ② 组件与二进制路径 */
const key = pick(mojJson).split(',')[0];
const mojPlat = mojJson[key];
const bmPlat = bmJson[key] ?? {};
console.log(`\n② 平台 ${key} 下的组件`);
console.log(`   Mojang : ${Object.keys(mojPlat).join(', ')}`);
console.log(`   BMCLAPI: ${Object.keys(bmPlat).join(', ')}`);

// 找一个体积小、带 raw 下载的文件来测
let probeFile = null;
for (const comp of Object.keys(mojPlat)) {
  const entry = (mojPlat[comp] ?? [])[0];
  if (!entry?.manifest?.files) continue;
  for (const [rel, f] of Object.entries(entry.manifest.files)) {
    if (f?.downloads?.raw?.url && /\.(dll|exe|cfg|properties|dat|zip)$/.test(rel)) {
      const size = f.downloads.raw.size ?? 0;
      if (size > 2000 && size < 900000) { probeFile = { comp, rel, f }; break; }
    }
  }
  if (probeFile) break;
}
if (!probeFile) { console.log('\n找不到合适的小文件来测，中止'); process.exit(1); }

const { comp, rel, f } = probeFile;
const raw = f.downloads.raw;
const officialUrl = raw.url;
// BMCLAPI 的改写规则：piston-data.mojang.com/… → bmclapi2.bangbang93.com/…
const mirroredUrl = officialUrl.replace('https://piston-data.mojang.com/', 'https://bmclapi2.bangbang93.com/');
console.log(`\n③ 二进制实测`);
console.log(`   组件   : ${comp}`);
console.log(`   文件   : ${rel}`);
console.log(`   大小   : ${raw.size} B   sha1=${raw.sha1}`);
console.log(`   官方   : ${officialUrl}`);
console.log(`   镜像   : ${mirroredUrl}`);

const off = await get(officialUrl, 30000, true);
const mir = await get(mirroredUrl, 30000, true);
const line = (label, r) => {
  if (r.status !== 200 || !r.body) return `   ${label}: 失败(${r.status || r.err})`;
  const h = createHash('sha1').update(r.body).digest('hex');
  return `   ${label}: 200  ${r.ttfb}ms  ${r.bytes}B  sha1=${h}  ${h === raw.sha1 ? '★ 与清单一致' : '✗ 不符'}`;
};
console.log(line('官方', off));
console.log(line('镜像', mir));

/* ④ 结论 */
const mirHash = mir.body ? createHash('sha1').update(mir.body).digest('hex') : null;
const same = off.body && mir.body && Buffer.compare(off.body, mir.body) === 0;
console.log(`\n④ 结论`);
if (!mir.body) console.log('   ✗ BMCLAPI 拿不到这个二进制 —— Java 走镜像不可行');
else if (!same) console.log('   ✗ 镜像与官方字节不同 —— 不可用作替代源');
else console.log(`   ✓ 字节完全一致，BMCLAPI 可作为 Java 下载的国内源（镜像 ttfb ${mir.ttfb}ms vs 官方 ${off.ttfb}ms）`);
