/*
 * 探针：**旧发布仓这座桥还通不通**（决定"能不能彻底删掉老仓"的判据）。
 *
 * ## 为什么需要它
 *
 * 2026-09-26 两仓合并：新客户端读代码仓，而**老客户端的更新端点编在 exe 里**，
 * 只会去问旧发布仓 `IEML_Official/IEML-releases`。所以那里留了一座**自足的桥**：
 * `latest`（清单）+ `v<桥接版>`（包）两个 release，仓已归档（只读）。
 *
 * 那座桥**现在通**不等于**以后还通**：仓被归档过、包被删过、清单被手改过，
 * 任何一次"顺手收拾"都可能把它弄断 —— 而断了是**静默**的：
 * 那批没更新过的老客户端只会显示"检查更新失败"，没有任何人能看出来是端点没了。
 * ⇒ 这条判据必须能一条命令重跑。
 *
 * ## 什么时候可以不用它了（进而删掉整个老仓）
 *
 * 判据是**不再有客户端在读老端点**，不是"桥还通"。老端点只存在于桥接版**之前**的
 * 客户端里 ⇒ 桥接版发布足够久（建议 ≥ 6 个月，或随 `0.1.0` 正式版）之后，
 * 先删 `latest`，观察一段时间的下载量归零，再删整个仓。
 *
 * 用法：`node tools/probe/probe-legacy-endpoint-bridge.mjs`
 * 退出码：0 = 四条判据全通；1 = 桥断了（★ 那批老客户端收不到更新了）
 */
const LEGACY = 'IEML_Official/IEML-releases';
const LEGACY_DL = `https://cnb.cool/${LEGACY}/-/releases/download`;
/** 桥接版：跨过它之后客户端就改读代码仓了。改版本端点时这里要一起改 */
const BRIDGE_VERSION = '0.1.0-rc.9';

let pass = 0;
let fail = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? '  ' + extra : ''}`);
  if (ok) pass += 1;
  else fail += 1;
};

async function get(url) {
  const r = await fetch(url, { redirect: 'follow' });
  const buf = new Uint8Array(await r.arrayBuffer());
  return { ok: r.ok, status: r.status, buf, bytes: buf.length };
}

console.log(`桥：${LEGACY}\n`);

/* ① 桥清单匿名可读 */
console.log('① 桥清单（老客户端读的就是这个地址）');
let manifest = null;
try {
  const m = await get(`${LEGACY_DL}/latest/latest.json`);
  check(m.ok, `GET latest.json -> HTTP ${m.status}`, `${m.bytes} B`);
  if (m.ok) manifest = JSON.parse(new TextDecoder().decode(m.buf));
} catch (e) {
  check(false, `GET latest.json 抛异常：${e.message}`);
}

/* ② 清单版本 == 桥接版（★ 被更新版本覆盖 = 老客户端会去装"端点已经变了"的那一版？不 ——
 *    更新端点编在**它们的** exe 里，所以装新版之后端点才变；这里只要它 >= 桥接版） */
if (manifest) {
  console.log('\n② 清单内容');
  check(manifest.version === BRIDGE_VERSION, `version == ${BRIDGE_VERSION}`, `实际 ${manifest.version}`);
  const url = manifest.platforms?.['windows-x86_64']?.url ?? '';
  check(!!url && !!manifest.platforms['windows-x86_64'].signature, '有 url 与 signature');
  check(
    url.startsWith(LEGACY_DL),
    '包地址指向**旧仓自己的副本**（自足，不依赖代码仓那个包）',
    url.replace('https://cnb.cool/', ''),
  );

  /* ③ 清单指向的包匿名可下，且是 PE */
  console.log('\n③ 桥清单指向的包');
  try {
    const p = await get(url);
    const head = new TextDecoder().decode(p.buf.slice(0, 2));
    check(p.ok && head === 'MZ', `GET 包 -> HTTP ${p.status}`, `${(p.bytes / 1048576).toFixed(2)} MB head=${head}`);
    check(p.bytes > 3_000_000, '大小像一份真安装包（> 3 MB）', `${p.bytes} B`);
  } catch (e) {
    check(false, `GET 包抛异常：${e.message}`);
  }
}

/* ④ 退路：旧仓自己的 v<桥接版> 路径也还通 */
console.log('\n④ 退路（万一清单指向的那条路坏了）');
try {
  const r = await get(`${LEGACY_DL}/v${BRIDGE_VERSION}/IEML_${BRIDGE_VERSION}_x64-setup.exe`);
  check(r.ok, `GET v${BRIDGE_VERSION} 的包 -> HTTP ${r.status}`, `${(r.bytes / 1048576).toFixed(2)} MB`);
} catch (e) {
  check(false, `GET v${BRIDGE_VERSION} 抛异常：${e.message}`);
}

console.log(`\n${fail === 0 ? `✓ 桥通（${pass} 条判据全过）` : `✗ 桥断了：${fail} / ${pass + fail} 条不通`}`);
if (fail) {
  console.error('\n★ 这意味着"没更新过的老客户端"从此收不到更新，而且是静默的。');
  console.error('  先看旧仓是不是被解归档/被清空，再按 README 里的说明重建桥。');
}
process.exit(fail ? 1 : 0);
