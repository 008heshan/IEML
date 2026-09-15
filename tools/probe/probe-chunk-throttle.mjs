// 实测：BMCLAPI 对「分片并行」到底是更快还是被限速？
//
// 背景：新版本（26.2）的客户端 jar 有 40 MB，走 8 路 Range 并行下载。
// 用户反馈"下载新版本会限速"。这个脚本直接量三个数：
//   ① 单连接整文件下完要多久
//   ② 8 路 Range 并行下完要多久
//   ③ 期间有没有 429 / 5xx
//
// 用法：node tools/probe/probe-chunk-throttle.mjs [版本号]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const version = process.argv[2] ?? '26.2';
const MIRROR = 'https://bmclapi2.bangbang93.com';
const OFFICIAL = 'https://piston-data.mojang.com';

/** 拿版本 JSON，取客户端 jar 的官方地址 */
async function clientJarUrl() {
  const res = await fetch(`${MIRROR}/version/${version}/json`);
  if (!res.ok) throw new Error(`拉版本 JSON 失败：HTTP ${res.status}`);
  const j = await res.json();
  const dl = j.downloads?.client;
  if (!dl?.url) throw new Error('版本 JSON 里没有 downloads.client');
  return { url: dl.url, size: dl.size, sha1: dl.sha1 };
}

function mirrorUrl(u) {
  return u
    .replace('https://piston-data.mojang.com/', `${MIRROR}/`)
    .replace('https://piston-meta.mojang.com/', `${MIRROR}/`)
    .replace('https://launcher.mojang.com/', `${MIRROR}/`);
}

async function timed(label, fn) {
  const t0 = Date.now();
  const r = await fn();
  const ms = Date.now() - t0;
  console.log(
    `  ${label.padEnd(22)} ${(ms / 1000).toFixed(2)}s  ${(r.bytes / 1024 / 1024).toFixed(1)} MB  ` +
      `→ ${(r.bytes / 1024 / 1024 / (ms / 1000)).toFixed(1)} MB/s  ${r.note ?? ''}`,
  );
  return { ms, ...r };
}

/** 带超时的单连接整文件下载（每 3 秒报一次进度，能看出是"慢"还是"卡死"） */
async function single(url, label, timeoutMs = 60000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const t0 = Date.now();
  let lastLog = 0;
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) return { bytes: 0, note: `HTTP ${res.status}` };
    let bytes = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      const el = Date.now() - t0;
      if (label && el - lastLog > 3000) {
        lastLog = el;
        console.log(
          `    ${String(Math.round(el / 1000)).padStart(3)}s  ${(bytes / 1024 / 1024).toFixed(1)} MB  ` +
            `(${(bytes / 1024 / 1024 / (el / 1000)).toFixed(1)} MB/s)`,
        );
      }
    }
    return { bytes, status: res.status };
  } catch (e) {
    return {
      bytes: 0,
      note: e.name === 'AbortError' ? `★ ${timeoutMs / 1000}s 超时被掐断（连接挂住不回）` : e.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 8 路 Range 并行 */
async function chunked(url, total, n = 8) {
  const size = Math.ceil(total / n);
  let statuses = [];
  const results = await Promise.all(
    Array.from({ length: n }, async (_, i) => {
      const start = i * size;
      const end = Math.min(start + size - 1, total - 1);
      const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
      statuses.push(res.status);
      if (res.status !== 206) return 0;
      let bytes = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
      }
      return bytes;
    }),
  );
  return {
    bytes: results.reduce((a, b) => a + b, 0),
    note: `状态码 ${[...new Set(statuses)].join(',')}`,
  };
}

const { url, size } = await clientJarUrl();
const m = mirrorUrl(url);
console.log(`版本 ${version}`);
console.log(`客户端 jar：${(size / 1024 / 1024).toFixed(1)} MB`);
console.log(`官方 ${url}`);
console.log(`镜像 ${m}`);
console.log(`临时目录 ${os.tmpdir()}\n`);

console.log('--- 单连接（60 秒上限）---');
const a = await timed('镜像 单连接', () => single(m, 'progress'));

console.log('\n--- 8 路 Range 并行（每路 60 秒上限）---');
const b = await timed('镜像 8 路分片', () => chunked(m, size));

console.log('\n--- 官方源单连接（对照）---');
const c = await timed('官方 单连接', () => single(url));

console.log('\n结论：');
if (a.bytes === 0) {
  console.log(`  ★ 镜像单连接根本下不动：${a.note ?? '未知'}`);
}
if (c.bytes === 0) {
  console.log(`  ★ 官方源单连接也下不动：${c.note ?? '未知'}`);
}
if (a.bytes > 0 && b.bytes > 0) {
  const ratio = b.ms / a.ms;
  if (ratio < 0.85) {
    console.log(`  ✓ 分片更快（${(a.ms / 1000).toFixed(1)}s → ${(b.ms / 1000).toFixed(1)}s）`);
  } else if (ratio > 1.25) {
    console.log(`  ✗ 分片更慢（${(a.ms / 1000).toFixed(1)}s → ${(b.ms / 1000).toFixed(1)}s）—— 建议下调段数`);
  } else {
    console.log(`  ≈ 相当（${(a.ms / 1000).toFixed(1)}s vs ${(b.ms / 1000).toFixed(1)}s）`);
  }
}
if (b.note && /429|503/.test(b.note)) {
  console.log(`  ★ 分片期间出现限流状态码：${b.note}`);
}
void fs;
void path;
