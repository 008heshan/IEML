/*
 * USTC Adoptium 镜像可用性验证（真下载 + 校验）
 *
 * 已确认的结构：
 *   GitHub 官方 : https://github.com/adoptium/temurin<M>-binaries/releases/download/<TAG>/<FILE>
 *   USTC  镜像  : https://mirrors.ustc.edu.cn/adoptium/releases/temurin<M>-binaries/<TAG>/<FILE>
 *
 * 本脚本：列目录 → 挑 JRE windows x64 → 真下载 → 验 zip 完整性 + 速度
 */
import { createHash } from 'node:crypto';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://mirrors.ustc.edu.cn/adoptium/releases';

async function getText(url, ms = 20000) {
  const t0 = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': UA } });
    const text = await res.text();
    clearTimeout(timer);
    return { status: res.status, text, ms: Date.now() - t0, bytes: Buffer.byteLength(text) };
  } catch (e) {
    clearTimeout(timer);
    return { status: 0, text: '', ms: Date.now() - t0, err: e.name };
  }
}

async function getBuf(url, ms = 180000) {
  const t0 = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': UA } });
    if (!res.ok) { clearTimeout(timer); return { status: res.status, ms: Date.now() - t0 }; }
    const buf = Buffer.from(await res.arrayBuffer());
    const ms2 = Date.now() - t0;
    clearTimeout(timer);
    return { status: 200, buf, bytes: buf.byteLength, ms: ms2, mbps: (buf.byteLength / 1048576 / (ms2 / 1000)) * 8 };
  } catch (e) {
    clearTimeout(timer);
    return { status: 0, err: e.name, ms: Date.now() - t0 };
  }
}

const href = (html) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);

console.log('USTC Adoptium 镜像真下载验证\n');

for (const major of [21, 17, 8]) {
  const dir = `${BASE}/temurin${major}-binaries/`;
  const r = await getText(dir);
  if (r.status !== 200) { console.log(`Java ${major}: 目录 HTTP ${r.status || r.err}`); continue; }
  const tags = href(r.text).filter((h) => /jdk-/.test(h) && h.endsWith('/'));
  if (!tags.length) { console.log(`Java ${major}: 目录里没有 tag`); continue; }
  const tag = tags[tags.length - 1];
  console.log(`── Java ${major} ──  tag: ${decodeURIComponent(tag)}`);

  const tr = await getText('https://mirrors.ustc.edu.cn' + tag);
  if (tr.status !== 200) { console.log(`   tag 目录 HTTP ${tr.status || tr.err}\n`); continue; }
  const files = href(tr.text).filter((h) => h.endsWith('.zip'));
  const want = files.find((f) => /jre_x64_windows_hotspot/.test(decodeURIComponent(f)));
  if (!want) {
    console.log(`   没有 jre_x64_windows 的 zip；该 tag 下有 ${files.length} 个 zip`);
    console.log(`   样例: ${files.slice(0, 3).map((f) => decodeURIComponent(f).split('/').pop()).join(' , ')}\n`);
    continue;
  }
  const url = 'https://mirrors.ustc.edu.cn' + want;
  const name = decodeURIComponent(want).split('/').pop();
  console.log(`   文件: ${name}`);

  const d = await getBuf(url);
  if (d.status !== 200 || !d.buf) {
    console.log(`   ✗ 下载失败 HTTP ${d.status || d.err}\n`);
    continue;
  }
  const isZip = d.buf[0] === 0x50 && d.buf[1] === 0x4b; // 'PK'
  const sha = createHash('sha256').update(d.buf).digest('hex');
  console.log(`   ✓ HTTP 200  ${(d.bytes / 1048576).toFixed(1)} MB  ${(d.ms / 1000).toFixed(1)}s  ${d.mbps.toFixed(1)} Mbps`);
  console.log(`   zip 头: ${isZip ? '✓ PK 有效' : '✗ 不是 zip'}`);
  console.log(`   sha256: ${sha}`);
  console.log(`   ⚠ 该 sha256 需与 Adoptium 官方核对（api.adoptium.net 当前不可达，待补验）\n`);
}
