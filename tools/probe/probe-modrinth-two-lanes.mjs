/*
 * 真机判据：**第三方 API 的两条路都通，而且第二条不是"摆设"**。
 *
 * ★★ 2026-09-26 用户一次说清两条路的取向：
 *   「全部 cf 链路默认走镜像；modr 那边偏向走官方，若网络不好，则走镜像」。
 *   代码里对应：
 *     · CurseForge：`net::curseforge` 只走镜像（这一条由 `diag-cf-filters.mjs` 验）；
 *     · Modrinth / 第三方 API：`net::get_text_third_party_with_headers` ——
 *       官方立刻发，**2 秒**还没回来就让镜像同时上，谁先成功用谁。
 *
 *   这一条专验后者。要证的是三件事：
 *     ① 官方这条路**真的通**（不然"偏向官方"是空话）；
 *     ② 镜像这条路**也真的通**（不然"网络不好换镜像"是空话）；
 *     ③ 走函数拿到的结果与直接打官方**是同一份数据**（换路不许换内容）。
 *
 *   ★ 不测"到底走了哪一条"：那取决于这台机器此刻的网络，
 *     是**环境的属性**不是代码的属性（跑得快的先回来，本来就随机）。
 *     日志里有 `[IEML/net] … 换 mcimirror` 那行可以查。
 *
 * 用法：node tools/probe/probe-modrinth-two-lanes.mjs
 * 退出码：0 = 全通；1 = 有判据不成立
 */
const OFFICIAL = 'https://api.modrinth.com/v2/search?limit=1&query=sodium';
const MIRROR = 'https://mod.mcimirror.top/modrinth/v2/search?limit=1&query=sodium';
const UA = 'IEML-Launcher/probe (+https://github.com/008heshan/IEML)';

let pass = 0;
let fail = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? '  ' + extra : ''}`);
  if (ok) pass += 1;
  else fail += 1;
};

async function fetchJson(url) {
  const t0 = Date.now();
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
  const text = await r.text();
  return { status: r.status, ms: Date.now() - t0, text };
}

console.log('① 官方这条路（Modrinth 直连）');
let official = null;
try {
  official = await fetchJson(OFFICIAL);
  check(official.status === 200, `HTTP ${official.status}`, `${official.ms}ms`);
} catch (e) {
  check(false, `打不通：${e.message}`);
}

console.log('\n② 镜像这条路（mcimirror）');
let mirror = null;
try {
  mirror = await fetchJson(MIRROR);
  check(mirror.status === 200, `HTTP ${mirror.status}`, `${mirror.ms}ms`);
} catch (e) {
  check(false, `打不通：${e.message}`);
}

console.log('\n③ 两条路给的是不是同一份数据');
if (official?.status === 200 && mirror?.status === 200) {
  const a = JSON.parse(official.text);
  const b = JSON.parse(mirror.text);
  check(
    a?.hits?.[0]?.project_id === b?.hits?.[0]?.project_id,
    '首条命中的 project_id 相同',
    `${a?.hits?.[0]?.project_id} vs ${b?.hits?.[0]?.project_id}`,
  );
  check(
    typeof a?.total_hits === 'number' && a.total_hits > 0,
    '官方给了 total_hits（接口形状没变）',
    String(a?.total_hits),
  );
} else {
  console.log('  · 有一条不通 ⇒ 这条比不了（上面已经报出来了）');
}

console.log(
  `\n${fail === 0 ? `✓ 全通（${pass} 条判据）` : `✗ ${fail} / ${pass + fail} 条不成立`}` +
    '\n  ★ 顺带记一句：镜像那条路的耗时通常比官方高（国内反代的代价），' +
    '\n    所以"官方优先"不是随便定的 —— 只有官方慢/不通时才值得换。',
);
process.exit(fail ? 1 : 0);
