/*
 * 探针：**CurseForge 整合包这一路到底能不能自动装**（先证明事实，再写代码 —— ADR-050）。
 *
 * ## 要回答的四个问题（每一个都会决定实现怎么写）
 *
 *   ① 搜索时 `classId=4471` 是否**真的**把结果限在"整合包"这一类？
 *      （`docs/DECISIONS.md` 里留着一条我自己记下的疑点：「CF 那批的第一条是 GeckoLib ——
 *       classId=4471 有没有真的把结果限在整合包这一类……**我还没验实**」）
 *   ② 文件列表里每条 file 的 `downloadUrl` 长什么样？**有没有 null**？
 *      （CF 的作者可以关掉"允许第三方下载"，那种包 API 不给直链 ——
 *       这一条决定"自动装"是不是对所有包都成立，还是必须留一条降级路径）
 *   ③ 镜像这条路能不能**真的把包体 zip 拉下来**（不是只有元数据）？
 *   ④ 拉下来的 zip 里 `manifest.json` / `overrides/` 是什么形状？
 *      （CF 整合包的清单格式与 Modrinth 的 `.mrpack` 不同，解析器要另写一份）
 *
 * ★ 全程**不带任何 key**（用户 2026-09-26 定：CF 完全不用 key，走国内镜像）。
 * ★ 只读探针：不写盘（除 %TEMP% 下的一个临时 zip），不改仓库。
 *
 * 用法：node tools/probe/probe-cf-modpack.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const MIRROR = 'https://mod.mcimirror.top';
const API = `${MIRROR}/curseforge/v1`;
const T = process.env.TEMP ?? '.';
const OUT = path.join(T, 'ieml-cf-modpack-probe');

let pass = 0;
let fail = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? '  ' + extra : ''}`);
  if (ok) pass += 1;
  else fail += 1;
};

async function get(url, { as = 'json', timeoutMs = 20000 } = {}) {
  /*
   * ★ 每个候选都要能**单独失败**：CF 的 CDN（`edge.forgecdn.net` 等）在这台机器上
   *   经常连不上（ADR-052 决定五就是为它写的），而"一个候选连不上"不等于
   *   "这件事做不到" —— 探针第一版让 fetch 抛出去，第二个候选（镜像）根本没轮到跑。
   */
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'IEML-Probe/1 (+https://github.com/008heshan/IEML)' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const status = r.status;
    if (as === 'json') {
      const text = await r.text();
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = text.slice(0, 200);
      }
      return { status, body };
    }
    const buf = Buffer.from(await r.arrayBuffer());
    return { status, buf, type: r.headers.get('content-type') ?? '' };
  } catch (e) {
    return { error: String(e?.cause?.code ?? e?.name ?? e).slice(0, 60), status: 0 };
  }
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

/* ---------- ① 搜索：classId 是否真的限在整合包 ---------- */
console.log('\n【① 搜索 modpack（classId=4471）】');
const search = await get(
  `${API}/mods/search?gameId=432&classId=4471&sortField=2&sortOrder=desc&pageSize=8&index=0`,
);
console.log(`  HTTP ${search.status}`);
const hits = search.body?.data ?? [];
check(Array.isArray(hits) && hits.length > 0, '搜索有结果', `${hits.length} 条`);
for (const m of hits.slice(0, 6)) {
  console.log(`    · [${m.id}] ${m.name}   classId=${m.classId}  categories=${(m.categories ?? []).map((c) => c.name).join('/')}`);
}
check(
  hits.length > 0 && hits.every((m) => m.classId === 4471),
  '★ 每一条的 classId 都是 4471（而不是混进 Mod/资源包）',
  hits.length ? `实际 ${[...new Set(hits.map((m) => m.classId))].join(',')}` : '',
);

/* ---------- ② 文件列表：downloadUrl 的形状 ---------- */
const pack = hits[0];
console.log(`\n【② 「${pack?.name}」的文件列表】`);
const files = await get(`${API}/mods/${pack.id}/files?pageSize=6&index=0`);
console.log(`  HTTP ${files.status}`);
const rows = files.body?.data ?? [];
for (const f of rows.slice(0, 4)) {
  console.log(
    `    · fileId=${f.id}  ${f.displayName?.slice(0, 46)}  ${(f.fileLength / 1024 / 1024).toFixed(1)} MB` +
      `  downloadUrl=${f.downloadUrl ? '有' : '★ null'}`,
  );
}
check(rows.length > 0, '文件列表有结果', `${rows.length} 条`);
const withUrl = rows.filter((f) => f.downloadUrl);
console.log(`    直链情况：${withUrl.length}/${rows.length} 条有 downloadUrl`);
check(
  rows.some((f) => f.downloadUrl),
  '★ 至少有一部分文件带直链（能自动下）',
);
check(
  rows.every((f) => 'downloadUrl' in f),
  '每条都带 downloadUrl 字段（null 也算带，解析器要能接住）',
);

/* ---------- ③ 镜像能不能把包体 zip 拉下来 ---------- */
/*
 * ★ 挑一个**小的客户端包**来试下载：ATM10 那种 190 MB 的包用来验证"能不能下"太贵。
 *   ★ 第一版挑中的是 `DeceasedCraft_Server_…zip`（**服务端包**、fileLength 0）——
 *     挑"最小"挑到了服务端包，那不是我们要的形态（客户端整合包才有 overrides）。
 *     现在：跳过 server 包 / fileLength 为 0 的，并在**客户端包**里挑最小的。
 */
console.log('\n【③ 找一个小包来试下载（只认客户端包）】');
let target = null;
let targetPack = null;
for (const m of hits) {
  const fl = await get(`${API}/mods/${m.id}/files?pageSize=8&index=0`);
  const cand = (fl.body?.data ?? []).filter(
    (f) =>
      f.downloadUrl &&
      (f.fileLength ?? 0) > 1024 * 1024 &&
      !/server|服务端/i.test(f.displayName ?? ''),
  );
  if (!cand.length) {
    const anyUrl = (fl.body?.data ?? []).some((f) => f.downloadUrl);
    console.log(`    · [${m.id}] ${m.name.slice(0, 34).padEnd(34)} ${anyUrl ? '（只有服务端包/小文件）' : '★ 全部无直链'}`);
    continue;
  }
  cand.sort((a, b) => a.fileLength - b.fileLength);
  const f = cand[0];
  const mb = f.fileLength / 1024 / 1024;
  console.log(`    · [${m.id}] ${m.name.slice(0, 34).padEnd(34)} 最小客户端包 ${mb.toFixed(1)} MB  ${f.displayName?.slice(0, 40)}`);
  if (!target || f.fileLength < target.fileLength) {
    target = f;
    targetPack = m;
  }
}
console.log(`  ⇒ 选「${targetPack?.name}」的 fileId=${target?.id}（${((target?.fileLength ?? 0) / 1024 / 1024).toFixed(1)} MB）`);

let zipPath = null;
if (target) {
  /*
   * ## URL 形状：与生产代码**同一张表**（`net/curseforge.rs::download_candidates`）
   *
   *   实测（本机，2026-09-26 深夜）：
   *     · API 给的 `edge.forgecdn.net/…` → **连接超时**（10s）；
   *     · 同路径换 `mediafilez.forgecdn.net` → **HTTP 206、1.2s、PK 魔数** ✓；
   *     · `media.forgecdn.net` → 超时；`edgedl.me.gvt1.com` → 404；
   *     · 镜像 `mod.mcimirror.top/files/…` → 超时（`/curseforge`、`/files`、`/cf`
   *       几种前缀全是 404）—— 也就是说**镜像这一路对 CF 的文件下载没有可用形态**，
   *       能救场的是第二个官方边缘域名 `mediafilez`。
   *   ⇒ 这就解释了生产代码为什么把候选排成「API 原样 → mediafilez → mcimirror」。
   */
  const official = target.downloadUrl;
  const p = new URL(official).pathname;
  const shapes = [
    ['官方原样（API 给的）', official],
    ['mediafilez（第二边缘）', `https://mediafilez.forgecdn.net${p}`],
    ['镜像 路径原样', `${MIRROR}${p}`],
  ];
  for (const [label, url] of shapes) {
    const started = Date.now();
    try {
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'IEML-Probe/1 (+https://github.com/008heshan/IEML)',
          Range: 'bytes=0-1',
        },
        signal: AbortSignal.timeout(20000),
      });
      const buf = Buffer.from(await r.arrayBuffer());
      const isZip = buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b;
      console.log(
        `    · ${label.padEnd(22)} HTTP ${String(r.status).padEnd(4)} ${String(buf.length).padStart(4)} B  ${isZip ? 'PK（zip 魔数）' : '（不是 zip 魔数）'}  ${((Date.now() - started) / 1000).toFixed(1)}s`,
      );
      if (isZip) {
        /* 真下整份，供 ④ 解包看清单 */
        const full = await get(url, { as: 'buffer', timeoutMs: 180000 });
        if (full.buf?.length > 4 && full.buf[0] === 0x50) {
          zipPath = path.join(OUT, 'pack.zip');
          writeFileSync(zipPath, full.buf);
          console.log(`      ⇒ 整份已下：${(full.buf.length / 1024 / 1024).toFixed(2)} MB`);
          break;
        }
      }
    } catch (e) {
      console.log(
        `    · ${label.padEnd(22)} 连接失败：${String(e?.cause?.code ?? e?.name ?? e).slice(0, 32)}  ${((Date.now() - started) / 1000).toFixed(1)}s`,
      );
    }
  }
}
check(!!zipPath, '★ 有一条路真的能下到包体 zip（不只是元数据）', zipPath ? `${(statSync(zipPath).size / 1024 / 1024).toFixed(2)} MB` : '');

/* ---------- ④ 包里的 manifest / overrides ---------- */
if (zipPath) {
  console.log('\n【④ 包体内容】');
  const ps = (cmd) =>
    execFileSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' }).trim();
  const listing = ps(
    `Add-Type -AssemblyName System.IO.Compression.FileSystem;` +
      `$z=[System.IO.Compression.ZipFile]::OpenRead('${zipPath}');` +
      `$z.Entries | Select-Object -First 25 | ForEach-Object { $_.FullName };` +
      `$z.Dispose()`,
  );
  console.log(listing.split('\n').map((l) => '    ' + l.trim()).join('\n'));
  const extract = path.join(OUT, 'x');
  mkdirSync(extract, { recursive: true });
  ps(
    `Add-Type -AssemblyName System.IO.Compression.FileSystem;` +
      `[System.IO.Compression.ZipFile]::ExtractToDirectory('${zipPath}','${extract}')`,
  );
  const manifestRaw = ps(`Get-Content -Raw -LiteralPath '${path.join(extract, 'manifest.json')}'`);
  let manifest = null;
  try {
    manifest = JSON.parse(manifestRaw);
  } catch {}
  check(!!manifest, 'zip 根下有 manifest.json 且能解析');
  if (manifest) {
    console.log('    manifest 顶层键：' + Object.keys(manifest).join(', '));
    console.log('    minecraft    ：' + JSON.stringify(manifest.minecraft));
    console.log(`    files        ：${manifest.files?.length ?? 0} 条，第一条 ${JSON.stringify(manifest.files?.[0])}`);
    console.log(`    overrides    ：${manifest.overrides ?? '(没有这个键)'}`);
    check(manifest.manifestType === 'minecraftModpack', 'manifestType 是 minecraftModpack', String(manifest.manifestType));
    check(Array.isArray(manifest.files) && manifest.files.length > 0, 'files 数组非空', `${manifest.files?.length} 条`);
    check(
      manifest.files?.every((f) => typeof f.projectID === 'number' && typeof f.fileID === 'number'),
      '★ 每条 files 都是 projectID + fileID 的数字对（自动安装要按它逐个解析）',
    );
    const requiredCount = manifest.files?.filter((f) => f.required).length ?? 0;
    console.log(`    required=true 的：${requiredCount} / ${manifest.files?.length ?? 0}`);
  }
  const overridesDir = path.join(extract, String(manifest?.overrides ?? 'overrides'));
  const hasOverrides = (() => {
    try {
      return statSync(overridesDir).isDirectory();
    } catch {
      return false;
    }
  })();
  check(hasOverrides, `overrides 目录在（${manifest?.overrides ?? 'overrides'}）`);
}

/* ---------- ⑤ 结论 ---------- */
console.log('\n===== 结论（决定实现怎么写） =====');
console.log(`  ① classId=4471 限定了整合包：${hits.length && hits.every((m) => m.classId === 4471) ? '是' : '否'}`);
console.log(`  ② 文件直链：${rows.filter((f) => f.downloadUrl).length}/${rows.length} 条有；null 的那部分必须留降级路径`);
console.log(`  ③ 镜像能下包体：${zipPath ? '是' : '否'}`);
console.log(`  ④ 清单格式：${zipPath ? 'manifest.json（projectID/fileID + overrides）' : '（没拿到包，未验）'}`);
console.log(`\n${fail === 0 ? `✓ 探针跑完（${pass} 条判据全过）` : `✗ ${fail} / ${pass + fail} 条不成立`}`);
console.log(`（临时文件在 ${OUT}，可手动删）`);
process.exit(fail === 0 ? 0 : 1);
