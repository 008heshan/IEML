/*
 * Adoptium（Java 运行时）国内镜像候选实测
 *
 * 背景：ARCHITECTURE.md 写着「有国内镜像可换」，但 adoptium.rs 的注释是
 *      「Adoptium 没有镜像，只能用官方源」—— 文档与代码矛盾，需要实测定论。
 *
 * 硬门槛：镜像文件必须与 Adoptium 官方给的 SHA256 **逐位一致**才算忠实副本。
 *        只测 HTTP 200 是不够的 —— 镜像给错版本、给坏包都会 200。
 *
 * 用法：node tools/probe/probe-adoptium-mirror.mjs
 */
import { createHash } from 'node:crypto';

const API = 'https://api.adoptium.net/v3';
const OS = 'windows';
const ARCH = 'x64';
const IMAGE = 'jre';
const MAJORS = [8, 17, 21, 25];

/** 国内镜像的 URL 模板（{major}/{arch}/{os}/{file} 占位） */
const MIRRORS = [
  ['清华 TUNA', (m, a, o, f) => `https://mirrors.tuna.tsinghua.edu.cn/Adoptium/${m}/jre/${a}/${o}/${f}`],
  ['南大 NJU', (m, a, o, f) => `https://mirror.nju.edu.cn/Adoptium/${m}/jre/${a}/${o}/${f}`],
  ['北外 BFSU', (m, a, o, f) => `https://mirrors.bfsu.edu.cn/Adoptium/${m}/jre/${a}/${o}/${f}`],
  ['上交 SJTU', (m, a, o, f) => `https://mirror.sjtu.edu.cn/Adoptium/${m}/jre/${a}/${o}/${f}`],
  ['中科大 USTC', (m, a, o, f) => `https://mirrors.ustc.edu.cn/adoptium/${m}/jre/${a}/${o}/${f}`],
  ['阿里云', (m, a, o, f) => `https://mirrors.aliyun.com/adoptium/${m}/jre/${a}/${o}/${f}`],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchMeta(major) {
  const url = `${API}/assets/latest/${major}/hotspot?os=${OS}&architecture=${ARCH}&image_type=${IMAGE}&vendor=eclipse`;
  const res = await fetch(url, { headers: { 'user-agent': 'IEML-Launcher/0.1' } });
  if (!res.ok) throw new Error(`Adoptium API ${major} → HTTP ${res.status}`);
  const arr = await res.json();
  if (!arr.length) throw new Error(`Adoptium API ${major} → 空结果`);
  const pkg = arr[0].binary.package;
  const file = decodeURIComponent(pkg.link.split('/').pop());
  return { link: pkg.link, file, size: pkg.size, sha256: pkg.checksum, version: arr[0].version.semver };
}

/** 只取前 N 字节算哈希太弱；这里全量下载并计时 */
async function downloadAndHash(url, timeoutMs = 90000) {
  const t0 = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'IEML-Launcher/0.1' } });
    if (!res.ok) { clearTimeout(timer); return { status: res.status, hash: null, bytes: 0, ms: Date.now() - t0 }; }
    const buf = Buffer.from(await res.arrayBuffer());
    clearTimeout(timer);
    const ms = Date.now() - t0;
    return {
      status: res.status,
      hash: createHash('sha256').update(buf).digest('hex'),
      bytes: buf.byteLength,
      ms,
      mbps: (buf.byteLength / 1048576 / (ms / 1000)) * 8,
    };
  } catch (e) {
    clearTimeout(timer);
    return { status: 0, hash: null, bytes: 0, ms: Date.now() - t0, err: e.name };
  }
}

console.log('Adoptium 国内镜像实测（含 SHA256 忠实性校验）\n');
const verdict = [];

for (const major of MAJORS) {
  let meta;
  try {
    meta = await fetchMeta(major);
  } catch (e) {
    console.log(`── Java ${major} ──  ✗ ${e.message}\n`);
    continue;
  }
  console.log(`── Java ${major}  (${meta.version}) ──`);
  console.log(`   官方文件 : ${meta.file}`);
  console.log(`   官方大小 : ${(meta.size / 1048576).toFixed(1)} MB`);
  console.log(`   官方SHA256: ${meta.sha256.slice(0, 16)}…`);

  // 官方自身也测一次作为速度基线（只测 Java 17/21 省时间）
  if (major === 21) {
    const off = await downloadAndHash(meta.link);
    const okHash = off.hash && off.hash.toLowerCase() === meta.sha256.toLowerCase();
    console.log(`   [基线] 官方 : HTTP ${off.status} ${(off.bytes / 1048576).toFixed(1)}MB ` +
      `${(off.ms / 1000).toFixed(1)}s ${off.mbps ? off.mbps.toFixed(1) + 'Mbps' : ''} 哈希${okHash ? '✓' : '✗'}`);
  }

  for (const [name, build] of MIRRORS) {
    const url = build(major, ARCH, OS, meta.file);
    const r = await downloadAndHash(url);
    if (r.status === 200 && r.hash) {
      const match = r.hash.toLowerCase() === meta.sha256.toLowerCase();
      const sizeOk = r.bytes === meta.size;
      console.log(`   ${name.padEnd(10)}: HTTP 200  ${(r.bytes / 1048576).toFixed(1)}MB  ` +
        `${(r.ms / 1000).toFixed(1)}s  ${r.mbps.toFixed(1)}Mbps  ` +
        `哈希${match ? '✓一致' : '✗不符'}  大小${sizeOk ? '✓' : '✗'}`);
      verdict.push({ major, name, ok: match && sizeOk, mbps: r.mbps });
    } else {
      console.log(`   ${name.padEnd(10)}: ${r.status ? `HTTP ${r.status}` : `失败(${r.err})`}`);
      verdict.push({ major, name, ok: false, mbps: 0 });
    }
    await sleep(300);
  }
  console.log('');
}

console.log('════════ 汇总：通过 SHA256 校验的镜像 ════════');
const byName = new Map();
for (const v of verdict) {
  if (!byName.has(v.name)) byName.set(v.name, { pass: 0, total: 0, speeds: [] });
  const e = byName.get(v.name);
  e.total++;
  if (v.ok) { e.pass++; e.speeds.push(v.mbps); }
}
for (const [name, e] of byName) {
  const avg = e.speeds.length ? (e.speeds.reduce((a, b) => a + b, 0) / e.speeds.length).toFixed(1) : '—';
  console.log(`  ${name.padEnd(10)} 忠实副本 ${e.pass}/${e.total}   平均 ${avg} Mbps`);
}
