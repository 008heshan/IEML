/**
 * CurseForge API 连通性探针（**不联网就不会跑**，见 package.json 里没有它）
 * ------------------------------------------------------------------
 * 用法：
 *   $env:IEML_CF_API_KEY = '<你的 key>'
 *   node tools/probe/probe-curseforge.mjs
 *
 * ## 为什么要单独写这个脚本（而不是直接写代码）
 *
 *   这个仓库的规矩是"**先证明上游真的通，再写集成代码**"（ADR-050 的教训：
 *   把"某个平台上 404"当成"这东西不存在"）。CurseForge 需要 API Key，
 *   而 key 的有效性、限流额度、字段形状都只能实打实打一次接口才知道。
 *
 * ★ key **只从环境变量读**，不写进这个文件：
 *   它是可以随时被撤销的凭据，落进仓库就等于泄露（README 的交付红线）。
 */
const key = process.env.IEML_CF_API_KEY ?? '';
if (!key) {
  console.error('✗ 没有 IEML_CF_API_KEY —— 先设置它再跑：');
  console.error("    $env:IEML_CF_API_KEY = '<你的 key>'");
  process.exit(2);
}

const BASE = 'https://api.curseforge.com/v1';
const MIRROR = 'https://mod.mcimirror.top/curseforge/v1';

async function get(url, withKey) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      headers: withKey
        ? { 'x-api-key': key, accept: 'application/json' }
        : { accept: 'application/json' },
    });
    const text = await r.text();
    return { status: r.status, ms: Date.now() - t0, text };
  } catch (e) {
    return { status: 0, ms: Date.now() - t0, text: `网络错误：${e.message}` };
  }
}

function head(s, n = 220) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

const results = [];

/* ---------- ① 官方 API：游戏表（最便宜的鉴权检查） ---------- */
{
  const r = await get(`${BASE}/games/432`, true);
  console.log(`\n① 官方 /games/432（带 key） → ${r.status}  ${r.ms}ms`);
  console.log(`   ${head(r.text)}`);
  results.push(['官方 games/432 + key', r.status === 200]);
}

/* ---------- ② 官方 API：不带 key（确认"403 需要 key"这句话还对） ---------- */
{
  const r = await get(`${BASE}/games/432`, false);
  console.log(`\n② 官方 /games/432（不带 key） → ${r.status}  ${r.ms}ms`);
  console.log(`   ${head(r.text)}`);
  results.push(['官方不带 key 应当被拒（403/401）', r.status === 401 || r.status === 403]);
}

/* ---------- ③ 搜索：真实字段形状 ---------- */
{
  const url = `${BASE}/mods/search?gameId=432&classId=6&searchFilter=jei&pageSize=3&sortField=2&sortOrder=desc`;
  const r = await get(url, true);
  console.log(`\n③ 官方搜索 jei → ${r.status}  ${r.ms}ms`);
  try {
    const j = JSON.parse(r.text);
    console.log(`   命中 ${j?.pagination?.totalCount} 条，取回 ${j?.data?.length} 条`);
    for (const m of j?.data ?? []) {
      console.log(`   · #${m.id} ${m.name}（${m.slug}）下载 ${m.downloadCount} · 最新文件 ${m.latestFiles?.[0]?.id ?? '—'} · ${m.latestFiles?.[0]?.fileName ?? ''}`);
    }
    results.push(['官方搜索返回结构化数据', (j?.data?.length ?? 0) > 0]);
  } catch {
    console.log(`   （不是 JSON）${head(r.text, 400)}`);
    results.push(['官方搜索返回结构化数据', false]);
  }
}

/* ---------- ④ 文件列表 + downloadUrl（能不能直接下） ---------- */
{
  // 用搜索里的第一个项目去读它的文件
  const s = await get(`${BASE}/mods/search?gameId=432&classId=6&searchFilter=jei&pageSize=1`, true);
  let modId = null;
  try {
    modId = JSON.parse(s.text)?.data?.[0]?.id ?? null;
  } catch {
    /* 上面已经报过 */
  }
  if (modId) {
    const r = await get(`${BASE}/mods/${modId}/files?pageSize=3`, true);
    console.log(`\n④ 官方 /mods/${modId}/files → ${r.status}  ${r.ms}ms`);
    try {
      const j = JSON.parse(r.text);
      for (const f of j?.data ?? []) {
        console.log(`   · 文件 #${f.id} ${f.fileName} · ${f.fileLength} B · downloadUrl=${f.downloadUrl ? '有' : '**null**'}`);
      }
      const hasNull = (j?.data ?? []).some((f) => !f.downloadUrl);
      console.log(`   ${hasNull ? '⚠️ 有文件的 downloadUrl 是 null（CurseForge 对部分作者屏蔽了直链，必须走我们的镜像/回退）' : '✅ 每个文件的 downloadUrl 都有值'}`);
      results.push(['文件列表可取', (j?.data?.length ?? 0) > 0]);
    } catch {
      console.log(`   （不是 JSON）${head(r.text, 400)}`);
    }
  } else {
    console.log('\n④ 跳过（搜索没拿到项目 id）');
  }
}

/* ---------- ⑤ mcimirror 兜底：镜像能不能不带 key 用 ---------- */
{
  const r = await get(`${MIRROR}/mods/search?gameId=432&classId=6&searchFilter=jei&pageSize=2`, false);
  console.log(`\n⑤ mcimirror 搜索（不带 key） → ${r.status}  ${r.ms}ms`);
  console.log(`   ${head(r.text)}`);
  results.push(['mcimirror 可作为兜底', r.status === 200]);
}

console.log('\n──────── 汇总 ────────');
let bad = 0;
for (const [name, ok] of results) {
  console.log(`${ok ? '✓' : '✗'} ${name}`);
  if (!ok) bad++;
}
console.log(bad === 0 ? '\n全部通过' : `\n${bad} 项不通过`);
process.exit(bad === 0 ? 0 : 1);
