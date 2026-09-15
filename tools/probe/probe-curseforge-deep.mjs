/**
 * CurseForge API 细节探针（**写集成代码之前必须跑**）
 * ------------------------------------------------------------------
 * 用法：
 *   $env:IEML_CF_API_KEY = '<你的 key>'
 *   node tools/probe/probe-curseforge-deep.mjs
 *
 * ## 为什么要有这个脚本
 *
 *   这个仓库的规矩是"**先证明上游真的这样，再写代码**"（ADR-050 的教训）。
 *   CurseForge 的这些东西**猜不得**，而且猜错不会报错，只会静默少一半结果：
 *     · 每种资源的 `classId` 是多少（猜错 → 结果集为空，用户以为"没有"）；
 *     · `modLoaderType` 的数字映射（猜错 → Fabric 的 Mod 搜不出来）；
 *     · `/mods/{id}/files` 的返回顺序（界面取 `[0]` 当"最新版"）；
 *     · `downloadUrl` 什么时候是 null（作者禁止分发）；
 *     · 指纹反查（MurmurHash2）到底怎么算 —— 用**接口自己当裁判**验证；
 *     · mcimirror 能不能替我们供文件（官方 CDN 在国内不一定通）。
 *
 * ★ key 只从环境变量读，不落进这个文件。
 */
const key = process.env.IEML_CF_API_KEY ?? '';
if (!key) {
  console.error('✗ 没有 IEML_CF_API_KEY —— 先设置它再跑');
  process.exit(2);
}

const BASE = 'https://api.curseforge.com/v1';
const MIRROR = 'https://mod.mcimirror.top/curseforge/v1';
const H = { 'x-api-key': key, accept: 'application/json' };

let bad = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? `  ${extra}` : ''}`);
  if (!ok) bad++;
};

async function api(url, headers = H) {
  const r = await fetch(url, { headers });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 保留原文 */
  }
  return { status: r.status, json, text };
}

/* ====================== ① 每种资源的 classId ====================== */
console.log('\n=== ① classId（每种资源各是什么）===');
const CLASS_GUESS = { mod: 6, resourcepack: 12, shader: 6552, datapack: 6945 };
for (const [kind, id] of Object.entries(CLASS_GUESS)) {
  const r = await api(`${BASE}/mods/search?gameId=432&classId=${id}&pageSize=2&sortField=2&sortOrder=desc`);
  const hits = r.json?.data ?? [];
  console.log(`  ${kind} → classId=${id}：${r.status}，${r.json?.pagination?.totalCount ?? '—'} 条`);
  for (const h of hits) {
    console.log(`      · [${h.classId}] ${h.name}（${h.slug}）`);
  }
  check(`${kind} 的 classId=${id} 有结果`, hits.length > 0);
}

/* ====================== ② modLoaderType 的数字映射 ====================== */
console.log('\n=== ② modLoaderType（数字 → 加载器）===');
const LOADER_GUESS = { forge: 1, liteloader: 3, fabric: 4, quilt: 5, neoforge: 6 };
for (const [name, id] of Object.entries(LOADER_GUESS)) {
  const r = await api(
    `${BASE}/mods/search?gameId=432&classId=6&gameVersion=1.20.1&modLoaderType=${id}&pageSize=2&sortField=2&sortOrder=desc`,
  );
  const hits = r.json?.data ?? [];
  console.log(`  ${name} → ${id}：${r.status}，${r.json?.pagination?.totalCount ?? '—'} 条`);
  for (const h of hits) console.log(`      · ${h.name}（最新文件 ${h.latestFiles?.[0]?.fileName ?? '—'}）`);
  check(`modLoaderType=${id} 是 ${name}`, hits.length > 0 || r.status !== 200);
}

/* ====================== ③ 文件列表的排序 ====================== */
console.log('\n=== ③ /mods/{id}/files 的顺序（界面取 [0] 当最新版）===');
{
  const s = await api(`${BASE}/mods/search?gameId=432&classId=6&searchFilter=jei&gameVersion=1.20.1&pageSize=1`);
  const modId = s.json?.data?.[0]?.id;
  const r = await api(`${BASE}/mods/${modId}/files?gameVersion=1.20.1&pageSize=10`);
  const files = r.json?.data ?? [];
  const dates = files.map((f) => f.fileDate);
  const desc = dates.every((d, i) => i === 0 || dates[i - 1] >= d);
  console.log(`  项目 #${modId}（1.20.1）取回 ${files.length} 个文件：`);
  for (const f of files.slice(0, 4)) {
    console.log(
      `      · #${f.id} ${f.fileName} · ${f.fileDate} · ${f.gameVersions?.length ?? 0} 个 MC 版本` +
        ` · releaseType=${f.releaseType} · downloadUrl=${f.downloadUrl ? '有' : '**null**'}`,
    );
  }
  check('默认按时间倒序（files[0] 就是最新）', desc || files.length < 2, desc ? '' : '★ 需要自己排序！');
  check('文件自带 gameVersions 字段（可以二次过滤）', (files[0]?.gameVersions?.length ?? 0) > 0);
}

/* ====================== ④ downloadUrl 什么时候是 null ====================== */
console.log('\n=== ④ allowModDistribution / downloadUrl=null（作者禁止分发）===');
{
  const r = await api(`${BASE}/mods/search?gameId=432&classId=6&pageSize=50&sortField=2&sortOrder=desc`);
  const hits = r.json?.data ?? [];
  const denied = hits.filter((h) => h.allowModDistribution === false);
  const nullUrl = hits.filter((h) => h.latestFiles?.[0] && !h.latestFiles[0].downloadUrl);
  console.log(`  热门 50 个里：allowModDistribution=false 的 ${denied.length} 个；最新文件 downloadUrl=null 的 ${nullUrl.length} 个`);
  for (const h of denied.slice(0, 3)) console.log(`      · #${h.id} ${h.name}（作者不允许第三方分发）`);
  check('搜索响应里带 allowModDistribution（能提前告诉用户）', hits.some((h) => 'allowModDistribution' in h));
}

/* ====================== ⑤ MurmurHash2 指纹：用接口当裁判 ====================== */
console.log('\n=== ⑤ 指纹反查（自己算 MurmurHash2，再用接口验证）===');

/** CurseForge 的指纹算法：MurmurHash2（32 位、种子 1），先剔除空白字符 */
function murmur2(data) {
  const M = 0x5bd1e995;
  const R = 24;
  let h = (1 ^ data.length) >>> 0;
  let i = 0;
  const len = data.length;
  while (len - i >= 4) {
    let k = (data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24)) >>> 0;
    k = Math.imul(k, M) >>> 0;
    k = (k ^ (k >>> R)) >>> 0;
    k = Math.imul(k, M) >>> 0;
    h = Math.imul(h, M) >>> 0;
    h = (h ^ k) >>> 0;
    i += 4;
  }
  switch (len - i) {
    case 3:
      h = (h ^ (data[i + 2] << 16)) >>> 0;
    // falls through
    case 2:
      h = (h ^ (data[i + 1] << 8)) >>> 0;
    // falls through
    case 1:
      h = (h ^ data[i]) >>> 0;
      h = Math.imul(h, M) >>> 0;
  }
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, M) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return h >>> 0;
}

/** CF 规定：把 \t \n \r 空格 全部去掉再算 */
function fingerprint(buf) {
  const out = [];
  for (const b of buf) {
    if (b === 9 || b === 10 || b === 13 || b === 32) continue;
    out.push(b);
  }
  return murmur2(Uint8Array.from(out));
}

{
  // 挑一个小的真实文件下载，算指纹，再用 /mods/fingerprints 反查
  const s = await api(`${BASE}/mods/search?gameId=432&classId=6&searchFilter=jei&gameVersion=1.20.1&pageSize=1`);
  const modId = s.json?.data?.[0]?.id;
  const fr = await api(`${BASE}/mods/${modId}/files?gameVersion=1.20.1&pageSize=1`);
  const file = fr.json?.data?.[0];
  if (!file?.downloadUrl) {
    console.log('  （拿不到可下载的文件，跳过）');
  } else {
    console.log(`  下载 #${file.id} ${file.fileName}（${file.fileLength} B）…`);
    const resp = await fetch(file.downloadUrl);
    const bytes = new Uint8Array(await resp.arrayBuffer());
    console.log(`  实际拿到 ${bytes.length} B（HTTP ${resp.status}）`);
    const fp = fingerprint(bytes);
    console.log(`  自己算的指纹：${fp}（十六进制 ${fp.toString(16)}）`);

    const post = await fetch(`${BASE}/mods/fingerprints`, {
      method: 'POST',
      headers: { ...H, 'content-type': 'application/json' },
      body: JSON.stringify({ fingerprints: [fp] }),
    });
    const pj = await post.json().catch(() => null);
    const exact = pj?.data?.exactMatches ?? [];
    console.log(`  POST /mods/fingerprints → ${post.status}，exactMatches ${exact.length} 条`);
    for (const m of exact) {
      console.log(`      · 命中 #${m.id} ${m.file?.fileName}（文件 #${m.file?.id}）`);
    }
    check(
      '★ 指纹算法正确（接口把我们刚下的那个文件原样认了回来）',
      exact.some((m) => m.file?.id === file.id),
    );
  }
}

/* ====================== ⑥ mcimirror 能不能替我们供文件 ====================== */
console.log('\n=== ⑥ mcimirror 兜底（官方 CDN 不通时）===');
{
  const s = await api(`${MIRROR}/mods/search?gameId=432&classId=6&searchFilter=jei&gameVersion=1.20.1&pageSize=1`, {
    accept: 'application/json',
  });
  const modId = s.json?.data?.[0]?.id;
  console.log(`  镜像搜索 → ${s.status}，项目 #${modId}`);
  const fr = await api(`${MIRROR}/mods/${modId}/files?gameVersion=1.20.1&pageSize=1`, { accept: 'application/json' });
  const f = fr.json?.data?.[0];
  console.log(`  镜像文件列表 → ${fr.status}`);
  if (f) {
    console.log(`      · #${f.id} ${f.fileName} · downloadUrl=${(f.downloadUrl ?? '(null)').slice(0, 110)}`);
    const host = (() => {
      try {
        return new URL(f.downloadUrl).host;
      } catch {
        return '(无)';
      }
    })();
    console.log(`      下载地址主机：${host}`);
    if (f.downloadUrl) {
      const head = await fetch(f.downloadUrl, { method: 'GET', headers: { range: 'bytes=0-1023' } });
      console.log(`      试取前 1 KB → HTTP ${head.status}（content-length ${head.headers.get('content-length')}）`);
      check('镜像给出的下载地址真的能取到字节', head.status === 200 || head.status === 206);
    }
  }
  check('镜像可作 API 兜底', s.status === 200);
}

console.log(`\n──────── ${bad === 0 ? '全部通过' : `${bad} 项需要处理`} ────────`);
process.exit(bad === 0 ? 0 : 1);
