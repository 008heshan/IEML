/**
 * 探针：**空关键词（"列出热门"）到底能不能拿到内容？用哪个排序才拿得到？**
 * ------------------------------------------------------------------
 * 背景：0.1.0-beta.2 把资源中心改成"打开就列出来，不用玩家先搜"。
 *   这条改法成立的前提是**空 query 真的会返回结果** —— 如果上游在空 query +
 *   `index=relevance` 下返回 0 条，那"默认列出"就是一句空话（界面会显示"无"，
 *   而用户以为库里没东西）。
 *
 * 所以要实测三件事：
 *   ① 空 query + `index=relevance` → 几条？
 *   ② 空 query + `index=downloads` → 几条？（"热门"的正确排序）
 *   ③ 五个种类（Mod / 整合包 / 资源包 / 光影 / 数据包）各自成不成立
 *   ④ 顺带验证翻页：offset=20 的那一页与第一页**不重复**
 *
 * ★ 本机直连 `api.modrinth.com` **超时**（实测 ConnectTimeout），
 *   所以默认走应用自己在用的镜像 `mod.mcimirror.top/modrinth/v2`
 *   （与 `net::mirror::mcimirror_url` 同一条规则）。设 `IEML_PROBE_DIRECT=1`
 *   可以强制走官方域名。
 *
 * 用法：node tools/probe/probe-browse.mjs
 */
const DIRECT = process.env.IEML_PROBE_DIRECT === '1';
const API = DIRECT ? 'https://api.modrinth.com/v2' : 'https://mod.mcimirror.top/modrinth/v2';
console.log(`(端点：${API}${DIRECT ? '（强制直连）' : '（镜像）'})\n`);

/** 与 Rust 侧 `domain/resources.rs` 那张表一致（这里只复制"查什么"，不复制规则） */
const KINDS = [
  { key: 'mod', label: 'Mod', projectType: 'mod', category: null, mc: '1.20.1', loader: 'fabric' },
  { key: 'modpack', label: '整合包', projectType: 'modpack', category: null, mc: '1.20.1', loader: null },
  { key: 'resourcepack', label: '资源包', projectType: 'resourcepack', category: null, mc: '1.20.1', loader: null },
  { key: 'shader', label: '光影', projectType: 'shader', category: null, mc: '1.20.1', loader: null },
  { key: 'datapack', label: '数据包', projectType: 'mod', category: 'datapack', mc: '1.20.1', loader: null },
];

const INDEXES = ['relevance', 'downloads'];

function facetsFor(k) {
  const facets = [[`project_type:${k.projectType}`]];
  if (k.mc) facets.push([`versions:${k.mc}`]);
  if (k.loader) facets.push([`categories:${k.loader}`]);
  if (k.category) facets.push([`categories:${k.category}`]);
  return JSON.stringify(facets);
}

async function search(k, index, query, offset = 0, limit = 20) {
  const url =
    `${API}/search?query=${encodeURIComponent(query)}&limit=${limit}&offset=${offset}` +
    `&index=${index}&facets=${encodeURIComponent(facetsFor(k))}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'IEML-probe/0.1 (browse check)' } });
  if (!r.ok) return { error: `HTTP ${r.status} ${await r.text()}` };
  const j = await r.json();
  return { total: j.total_hits, hits: j.hits ?? [] };
}

console.log('=== ① 空 query：relevance vs downloads（每类各查一次）===');
const rows = [];
for (const k of KINDS) {
  const line = { kind: k.label };
  for (const idx of INDEXES) {
    const r = await search(k, idx, '');
    line[idx] = r.error ? r.error : `${r.total} 条（本页 ${r.hits.length}）`;
    line[`first_${idx}`] = r.hits?.[0]?.title ?? '—';
  }
  rows.push(line);
}
for (const r of rows) {
  console.log(`  ${r.kind}`);
  for (const idx of INDEXES) {
    console.log(`    index=${idx.padEnd(9)} ${r[idx]}   首个：${r[`first_${idx}`]}`);
  }
}

console.log('');
console.log('=== ② 翻页：第 1 页与第 2 页是否真的不同 ===');
for (const k of KINDS) {
  const p1 = await search(k, 'downloads', '', 0);
  const p2 = await search(k, 'downloads', '', 20);
  const ids1 = new Set((p1.hits ?? []).map((h) => h.project_id));
  const overlap = (p2.hits ?? []).filter((h) => ids1.has(h.project_id)).length;
  console.log(
    `  ${k.label.padEnd(4)} 第1页 ${(p1.hits ?? []).length} 条 / 第2页 ${(p2.hits ?? []).length} 条` +
      ` · 重复 ${overlap} 条 ${overlap === 0 ? '✓' : '✗'}`,
  );
}

console.log('');
console.log('=== ③ 关键词搜索仍然正常（不能被"默认列出"改坏）===');
for (const q of ['sodium', 'iris', 'terralith']) {
  const r = await search(KINDS[0], 'relevance', q);
  console.log(`  「${q}」→ ${r.error ?? `${r.total} 条，首个：${r.hits?.[0]?.title}`}`);
}
