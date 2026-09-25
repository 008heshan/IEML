/**
 * mcimirror 能不能顶替官方 CurseForge 接口（**不带任何 key**）？
 * ------------------------------------------------------------------
 * 为什么要问这个：仓库公开前必须处理"内置一把 CurseForge key"这件事，
 * 而"开箱即用"是用户明确的产品要求 —— 不能拿它换干净。
 *
 * 所以先测：如果 `mod.mcimirror.top` 能在**不带 key** 的前提下覆盖我们用到的
 * 四类接口（搜索 / 文件列表 / 指纹反查 / 分类），那就不需要任何 key，
 * "开箱即用"与"不泄露凭据"可以同时成立。
 *
 * 用法：node tools/probe/probe-cf-mirror-keyless.mjs
 * ★ 这个脚本**不读** IEML_CF_API_KEY，也**不发** x-api-key —— 那正是要验的前提。
 */

const MIRROR = 'https://mod.mcimirror.top';
const OFFICIAL = 'https://api.curseforge.com';
const GAME_ID = 432; // Minecraft

const results = [];

async function probe(name, url, init = {}) {
  const started = Date.now();
  try {
    const r = await fetch(url, {
      ...init,
      headers: { Accept: 'application/json', ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(20000),
    });
    const text = await r.text();
    let shape = '';
    let count = null;
    try {
      const j = JSON.parse(text);
      if (Array.isArray(j.data)) {
        count = j.data.length;
        shape = `data[${count}]`;
        if (j.pagination?.totalCount !== undefined) shape += ` totalCount=${j.pagination.totalCount}`;
        if (count > 0) shape += ` 首条=${JSON.stringify(j.data[0].name ?? j.data[0].fileName ?? j.data[0].id ?? '').slice(0, 40)}`;
      } else if (j.data && typeof j.data === 'object') {
        shape = `data{${Object.keys(j.data).slice(0, 6).join(',')}}`;
      } else {
        shape = `keys=${Object.keys(j).slice(0, 6).join(',')}`;
      }
    } catch {
      shape = `非 JSON（前 80 字）：${text.slice(0, 80).replace(/\s+/g, ' ')}`;
    }
    results.push({ name, status: r.status, ms: Date.now() - started, shape });
  } catch (e) {
    results.push({ name, status: 'ERR', ms: Date.now() - started, shape: String(e.message ?? e).slice(0, 90) });
  }
}

// ① GET 搜索（资源中心第一屏就是它）
await probe(
  '镜像 · GET 搜索（mods/search，热门）',
  `${MIRROR}/curseforge/v1/mods/search?gameId=${GAME_ID}&pageSize=5&sortField=2&sortOrder=desc`,
);
// ② GET 文件列表（版本列表）
await probe(
  '镜像 · GET 文件列表（mods/238222/files，JEI）',
  `${MIRROR}/curseforge/v1/mods/238222/files?pageSize=3`,
);
// ③ POST 指纹反查（"检查更新"那条路，只认指纹）
//   ★★ 形状必须与**镜像**一致：对象数组。实测镜像要 `[{fingerprint:n}]`，
//      而**官方**要裸整数 `[n]` —— 两边发错都是 400（见 net/curseforge.rs 的两条注释）。
await probe('镜像 · POST 指纹反查（fingerprints，对象数组）', `${MIRROR}/curseforge/v1/fingerprints`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ fingerprints: [{ fingerprint: 1234567890 }] }),
});
// ③b 反向对照：给镜像发**官方那种裸整数** —— 预期 400（证明"两条路形状相反"这件事）
await probe('对照 · 镜像 + 裸整数（**预期 400**）', `${MIRROR}/curseforge/v1/fingerprints`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ fingerprints: [1234567890] }),
});
// ④ GET 单个 mod（详情）
await probe('镜像 · GET 单个 mod（mods/238222）', `${MIRROR}/curseforge/v1/mods/238222`);
// ⑤ GET 分类（classId 表）
await probe('镜像 · GET 分类（categories）', `${MIRROR}/curseforge/v1/categories?gameId=${GAME_ID}`);

// 对照：同一个搜索打官方、不带 key —— 预期 403（用来证明"我们确实没带 key"）
await probe(
  '对照 · 官方 GET 搜索（**故意不带 key**）',
  `${OFFICIAL}/v1/mods/search?gameId=${GAME_ID}&pageSize=1`,
);

console.log('\n=== 结果（全部请求都没有 x-api-key）===');
for (const r of results) {
  console.log(`\n${r.name}\n  HTTP ${r.status}  ${r.ms}ms\n  ${r.shape}`);
}
const okMirror = results.filter((r) => r.name.startsWith('镜像') && r.status === 200).length;
console.log(`\n镜像可用接口：${okMirror} / 5`);
