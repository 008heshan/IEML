/*
 * 把一次 `tauri build` 的产物发布到 CNB 的公开仓（更新端点就在这里）。
 *
 * 用法：
 *   node tools/release/publish-cnb.mjs            # 只打包 + 生成 latest.json，不上传
 *   node tools/release/publish-cnb.mjs --upload   # 真的传到 CNB
 *
 * ## 为什么要一个 `latest` 滚动 tag
 *
 * Tauri 的更新端点在 `tauri.conf.json` 里必须是**静态 URL**，而版本 tag 每次都变。
 * 所以这里维护两个 release：
 *
 *   - `v<版本>`（如 `v0.1.0-beta.43`）—— 存**真正带版本的产物**，只增不改
 *   - `latest`                        —— 只存一个 `latest.json`，每次**覆盖**
 *
 * 端点固定指向 `.../releases/download/latest/latest.json`，
 * 而 latest.json 里面才写着"这次该去下哪个版本的文件"。
 *
 * ## 认证
 *
 * 令牌从 git 的凭据管理器取（与推送代码用的是同一把），**不落盘、不进仓库**。
 * 也可以直接用环境变量 `CNB_TOKEN` 覆盖（CI 里用这个）。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

/*
 * ★★ 2026-09-26：**代码仓与发布仓合并了**（用户要求：CNB 的代码仓直接当分发仓）。
 *
 *   以前是两个仓：代码仓 `IEML_Official/IEML`（私密）+ 发布仓 `IEML_Official/IEML-releases`（公开），
 *   分开的理由写在 ADR-058 里 —— 当初代码仓是私密的，而更新端点必须**匿名可访问**
 *   （装了启动器的人没带任何凭据），所以另开了一个公开仓专门放 release。
 *
 *   现在两个仓都转公开了，那条理由消失 ⇒ 合成一个：release 直接发在**代码仓**上。
 *   ⇒ 下面这条常量就是全部改动（其余接口调用都走它）。
 *
 *   ★★ 但**已经装了旧版的用户不会自动跟过来**：`latest.json` 的地址是**编在 exe 里**的
 *   （`tauri.conf.json` 的 `plugins.updater.endpoints`），老客户端只会去问**旧发布仓**。
 *   所以合并要配一次**桥接发布**：先把这一版（端点已改成代码仓）发到**旧发布仓**，
 *   老客户端更新到它之后，就从此读代码仓了。顺序反了 = 老用户永远收不到更新。
 */
const REPO = 'IEML_Official/IEML';                    // ★ 代码仓兼分发仓（两仓已合并）
const API = 'https://api.cnb.cool';
const DOWNLOAD = `https://cnb.cool/${REPO}/-/releases/download`;
/** 桥接期间用：把这一版也发到旧发布仓，好让老客户端能走过来（见上面那段说明） */
const LEGACY_REPO = 'IEML_Official/IEML-releases';
/**
 * ★★ 桥接版：**跨过它之后客户端就改读代码仓了**（端点编在 exe 里）。
 *
 *   2026-09-26 三件事做完之后，旧发布仓里**只剩这一座桥**（10 个带版本号的 release
 *   与 21 个 tag 都已清掉），并且已经**归档**（只读）。
 *   ★ 桥里那份 `latest.json` 是**手改过的形态**：包地址指向**旧仓自己的**
 *     `v<桥接版>` 副本（自足、不依赖代码仓那个包），而本脚本生成的那份指向代码仓。
 *     ⇒ **拿本脚本去刷桥 = 把"自足"改回"依赖代码仓"**，所以下面那道闸门默认拒绝重刷。
 */
const BRIDGE_VERSION = '0.1.0-rc.9';
const BUNDLE = 'src-tauri/target/release/bundle';
const upload = process.argv.includes('--upload');
const bridge = process.argv.includes('--bridge');
/** 只有这个开关才允许动已经冻结的桥（见下面那道闸门） */
const republish = process.argv.includes('--bridge-republish');

/**
 * 比 semver：**有预发布标识的比同号正式版小**（`0.1.0-rc.9 < 0.1.0`），
 * 预发布之间按点分片段比，纯数字段按数值比（`rc.9 > rc.8`，不是字符串序）。
 * ★ 只需判断"比桥接版新 / 一样 / 更旧"，所以不做 build metadata。
 */
function compareVersions(a, b) {
  const [aCore, aPre] = String(a).split('-');
  const [bCore, bPre] = String(b).split('-');
  const num = (s) => s.split('.').map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const ac = num(aCore);
  const bc = num(bCore);
  for (let i = 0; i < 3; i++) {
    const d = (ac[i] ?? 0) - (bc[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  if (aPre === undefined && bPre === undefined) return 0;
  if (aPre === undefined) return 1;   // 正式版 > 预发布
  if (bPre === undefined) return -1;
  const ap = aPre.split('.');
  const bp = bPre.split('.');
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    if (ap[i] === undefined) return -1;
    if (bp[i] === undefined) return 1;
    const an = /^\d+$/.test(ap[i]);
    const bn = /^\d+$/.test(bp[i]);
    if (an && bn) { if (Number(ap[i]) !== Number(bp[i])) return Number(ap[i]) > Number(bp[i]) ? 1 : -1; continue; }
    if (an !== bn) return an ? -1 : 1;  // 数字段 < 字母段
    if (ap[i] !== bp[i]) return ap[i] > bp[i] ? 1 : -1;
  }
  return 0;
}

/* ---------- 令牌 ---------- */
function token() {
  if (process.env.CNB_TOKEN) return process.env.CNB_TOKEN.trim();
  const git = join(process.env.LOCALAPPDATA ?? '', 'Programs', 'PortableGit', 'cmd', 'git.exe');
  const input = 'protocol=https\nhost=cnb.cool\n\n';
  // ★ 走 stdin 交给 git，避免令牌出现在任何命令行/日志里
  const out = execFileSync(git, ['credential', 'fill'], { input, encoding: 'utf8' });
  const m = out.match(/^password=(.+)$/m);
  if (!m) throw new Error('取不到 cnb 令牌（git credential fill 没返回 password）');
  return m[1].trim();
}

async function api(path, init = {}) {
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: { accept: 'application/json', authorization: `Bearer ${token()}`, ...(init.headers ?? {}) },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> HTTP ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

/* ---------- 找产物 ---------- */
function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = walk(BUNDLE);

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const version = pkg.version;
const tag = `v${version}`;

// bundle/ 里会攒下历次构建的产物，绝不能"取第一个匹配"——否则可能把旧包当成新版本发出去。
// 规则：只认文件名带当前版本号的；一个都没有才退回按修改时间最新的，并且大声警告。
//
// ★★ 2026-09-26（发 `0.1.0` 当场撞到的）：判据原来写的是 `basename(f).includes(version)` ——
//   而**正式版的版本号是每个 rc 的前缀**（`0.1.0` ⊂ `0.1.0-rc.13`），于是它一次匹配到
//   6 个文件（rc.9~rc.13 + 正式版），脚本拒绝继续。这不是"历史产物太多"的问题，
//   是判据太松：版本号必须**整段相等**。所以改成"前后都是边界"：
//     · 前面是 `_` / `-` / 开头；后面是 `_` / `.` / 结尾（**不认 `-`** ——
//       `0.1.0-rc.13` 里的 `-` 正说明那个 `0.1.0` 只是前缀，不是这个版本）。
function pick(suffix) {
  const hit = files.filter((f) => f.endsWith(suffix));
  const esc = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wholeVersion = new RegExp(`(^|[_-])${esc}(?=[_.]|$)`);
  const exact = hit.filter((f) => wholeVersion.test(basename(f)));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    console.error(`✗ ${suffix} 匹配到多个 ${version} 的文件，无法确定发哪个：`);
    console.error(exact.map((f) => '    ' + f).join('\n'));
    process.exit(1);
  }
  if (!hit.length) return null;
  const newest = hit.slice().sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  console.warn(`⚠ bundle 里没有 ${version} 的 ${suffix}，退回最新的 ${basename(newest)}`);
  console.warn('  如果你刚构建过，说明版本号对不上：package.json 与 src-tauri/tauri.conf.json 要一致。');
  return newest;
}

const sig = pick('.sig');
if (!sig) {
  console.error('✗ 找不到 .sig —— 说明这次构建没有产出更新包。');
  console.error('  检查 tauri.conf.json 的 bundle.createUpdaterArtifacts 是否为 true，');
  console.error('  以及构建时有没有设置 TAURI_SIGNING_PRIVATE_KEY。');
  console.error('  bundle 下的文件：\n' + files.map((f) => '    ' + f).join('\n'));
  process.exit(1);
}
// .sig 的同名兄弟就是更新包本体（Tauri 的命名约定：<包>.sig）
const artifact = sig.slice(0, -'.sig'.length);
if (!existsSync(artifact)) {
  console.error(`✗ 找到 ${sig} 但没有对应的 ${artifact}`);
  process.exit(1);
}
const installer = pick('-setup.exe');

const signature = readFileSync(sig, 'utf8').trim();

/*
 * ★★ 2026-09-24 修：这条正则原来带 `m` 标志 —— 于是 `$` 匹配的是**行尾**，
 *   惰性匹配 `*?` 立刻停在第一行 ⇒ 推上去的 notes **只有标题那一行**
 *   （rc.3 实测：线上 notes 长度 85 字，就是 `## 0.1.0-rc.3 — …` 那一行）。
 *   ★ 而这个 bug 一直没被发现，是因为"notes 是 CHANGELOG 里的一节"这条自检
 *     在**只有标题**时同样成立 —— 判据太弱。
 *   现在：去掉 `m`（`^` 只认串首、`$` 只认串尾），用 `(?:^|\n)` 兜住"标题在行首"，
 *   于是 notes = 从这一节开头到**下一节之前**的全部内容。
 *   ★ 另加一条硬判据（verify-manifest 里）：notes 少于 200 字直接报错。
 */
function sectionOf(changelog, version) {
  const re = new RegExp(`(?:^|\\n)## ${version.replace(/\./g, '\\.')}[\\s\\S]*?(?=\\n## |$)`);
  // 顺手去掉尾部那条分隔线（`\n\n---`）：它是给 CHANGELOG 排版用的，不该进更新说明
  return changelog.match(re)?.[0]?.trim().replace(/\n+---\s*$/, '') ?? '';
}

const latest = {
  version,
  notes: sectionOf(readFileSync('CHANGELOG.md', 'utf8'), version),
  pub_date: new Date().toISOString(),
  platforms: {
    // Tauri 的 target triple 命名；本机只出 Windows x64
    'windows-x86_64': { signature, url: `${DOWNLOAD}/${tag}/${basename(artifact)}` },
  },
};

console.log(`版本    : ${version}`);
console.log(`tag     : ${tag}`);
console.log(`更新包  : ${artifact}  (${(statSync(artifact).size / 1048576).toFixed(2)} MB)`);
console.log(`签名    : ${sig}  (${signature.length} 字符)`);
console.log(`安装包  : ${installer ?? '（没有，跳过）'}`);
console.log(`端点    : ${DOWNLOAD}/latest/latest.json`);
writeFileSync('tmp/latest.json', JSON.stringify(latest, null, 2));
console.log('已写 tmp/latest.json');

if (!upload) {
  console.log('\n（未加 --upload，只生成清单。加 --upload 才会真的传。）');
  process.exit(0);
}

/* ---------- 上传 ---------- */
/**
 * 找到或创建指定 tag 的 release。重跑时必须复用，否则 CNB 会因为 tag 已存在而报错。
 *
 * ★ 2026-09-26：`repo` 改成**参数**。以前它写死用 `REPO`（代码仓），
 *   于是桥接去旧发布仓时，拿着旧仓的 release id 去问**代码仓**的上传地址 ⇒
 *   `404 not found`（第一次跑就是这么炸的）。凡是指向"某个仓"的调用都必须带上仓名。
 */
async function ensureRelease(repo, tagName, { name, body, prerelease }) {
  const findAll = async () => {
    const list = await api(`/${repo}/-/releases?per_page=100`);
    const arr = Array.isArray(list) ? list : (list?.releases ?? list?.data ?? []);
    return arr.find((r) => (r.tag_name ?? r.tag) === tagName && r.id);
  };
  try {
    const r = await api(`/${repo}/-/releases/tags/${encodeURIComponent(tagName)}`);
    if (r?.id) return r;
  } catch { /* 这个接口不一定有，回退到列表查找 */ }
  try {
    const hit = await findAll();
    if (hit) return hit;
  } catch { /* 列表也拿不到就直接尝试创建 */ }
  try {
    return await api(`/${repo}/-/releases`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tag_name: tagName, target_commitish: 'main', name, body, prerelease, draft: false }),
    });
  } catch (e) {
    // 可能是上一次跑残留的，再找一次
    try {
      const hit = await findAll();
      if (hit) return hit;
    } catch { /* 忽略，抛出原始错误 */ }
    throw e;
  }
}

/** CNB 有时返回绝对地址、有时返回相对路径，统一补全。 */
const abs = (u) => (/^https?:\/\//i.test(u) ? u : `${API}${u.startsWith('/') ? '' : '/'}${u}`);

async function uploadAsset(repo, releaseId, filePath, assetName) {
  const size = statSync(filePath).size;
  const { upload_url, verify_url, upload_token } = await api(
    `/${repo}/-/releases/${releaseId}/asset-upload-url`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // overwrite：latest 那个 release 每次都要覆盖同名文件
      body: JSON.stringify({ asset_name: assetName, size, overwrite: true }),
    },
  );
  const put = await fetch(abs(upload_url), { method: 'PUT', body: readFileSync(filePath) });
  if (!put.ok) throw new Error(`上传 ${assetName} 失败：HTTP ${put.status} ${(await put.text()).slice(0, 200)}`);
  // 确认接口强制要求 JSON content-type（否则 406），哪怕不需要请求体
  const confirm = await fetch(abs(verify_url), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token()}`,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: '{}',
  });
  if (!confirm.ok) throw new Error(`确认 ${assetName} 失败：HTTP ${confirm.status} ${(await confirm.text()).slice(0, 200)}`);
  console.log(`  ✓ ${assetName} (${(size / 1048576).toFixed(2)} MB)  upload_token=${String(upload_token).slice(0, 8)}…`);
}

console.log('\n上传中…');
const rel = await ensureRelease(REPO, tag, {
  name: `IEML ${version}`,
  body: latest.notes,
  prerelease: /-/.test(version),   // 带后缀的是预发布
});
const relId = rel.id ?? rel.release_id;
console.log(`  release ${tag} id=${relId}`);
await uploadAsset(REPO, relId, artifact, basename(artifact));
// 多数时候 installer 就是 artifact 本身（NSIS 产物既是安装包也是更新包），
// 那就别用同一个名字传两遍 —— 白传一次 3 MB，日志里还像出了错。
if (installer && installer !== artifact) await uploadAsset(REPO, relId, installer, basename(installer));

// 滚动 tag：只放 latest.json，每次覆盖
const roll = await ensureRelease(REPO, 'latest', { name: '最新版（更新端点读这里）', body: '由发布脚本自动维护，勿手动改。', prerelease: false });
const rollId = roll.id ?? roll.release_id;
console.log(`  release latest id=${rollId}`);
await uploadAsset(REPO, rollId, 'tmp/latest.json', 'latest.json');

console.log('\n完成。更新端点：');
console.log(`  ${DOWNLOAD}/latest/latest.json`);

/*
 * ★★ 桥接：把**同一份产物与清单**也发到旧发布仓（`LEGACY_REPO`）。
 *
 *   为什么必须有这一步：老客户端的 `latest.json` 地址是编在 exe 里的（旧发布仓），
 *   它们只会去问旧地址。冒烟测试也可以先只推这一边 —— 因为**验证端点上的地址
 *   就是客户端真正会读的那个**，而它此刻还在旧仓。等老用户更新到这一版，
 *   他们的端点才变成代码仓，此后 `--bridge` 就不需要了。
 *
 *   ★★ **2026-09-26：桥已冻结。** 跨过它之后客户端就改读代码仓了，所以：
 *     · **同一版再跑一次 `--bridge`** → 直接拒绝（重刷会把桥里"自足"的包地址
 *       改回"依赖代码仓"，那正是我们要避免的单点）；
 *     · **版本比桥接版更新时跑 `--bridge`** → 也拒绝并提示：桥已经不需要再更新了。
 *     真正需要重刷时（比如桥接版本的包坏了要重传），用 `--bridge-republish`，
 *     并且刷完要回读一次桥清单，确认包地址仍然指向旧仓自己。
 *
 *   用法：node tools/release/publish-cnb.mjs --upload --bridge   （只在跨桥那一版用一次）
 */
if (bridge) {
  const cmp = compareVersions(version, BRIDGE_VERSION);
  if (version === BRIDGE_VERSION && !republish) {
    throw new Error(
      `桥已冻结：${BRIDGE_VERSION} 就是桥接版，重刷会把桥清单改成"依赖代码仓"的形态。\n` +
        `  · 只是发新版本 → 去掉 --bridge（桥不需要再更新）\n` +
        `  · 真要重传桥接版的包 → node tools/release/publish-cnb.mjs --upload --bridge --bridge-republish`,
    );
  }
  if (cmp > 0) {
    throw new Error(
      `桥接版是 ${BRIDGE_VERSION}，而当前版本是 ${version}（更新的版本）—— 桥不需要、也不该再更新。\n` +
        `  · 直接发：node tools/release/publish-cnb.mjs --upload\n` +
        `  · 确实要动桥：加 --bridge-republish 并说明理由`,
    );
  }
  if (cmp < 0) {
    throw new Error(
      `当前版本 ${version} 比桥接版 ${BRIDGE_VERSION} 还旧 —— 往回发会造出一个"更旧的桥"。\n` +
        `  先确认版本号（package.json / tauri.conf.json）是不是被改回去了。`,
    );
  }
  console.log(`\n桥接：把这一版也发到旧发布仓 ${LEGACY_REPO} …`);
  const legacyDownload = `https://cnb.cool/${LEGACY_REPO}/-/releases/download`;
  // ★ 复用参数化后的 ensureRelease（第一版我在这里另抄了一份，`uploadAsset` 却仍写死代码仓 ⇒ 404）
  const legacyRel = await ensureRelease(LEGACY_REPO, tag, {
    name: `IEML ${version}`,
    body: latest.notes,
    prerelease: /-/.test(version),
  });
  const legacyId = legacyRel.id ?? legacyRel.release_id;
  await uploadAsset(LEGACY_REPO, legacyId, artifact, basename(artifact));
  if (installer && installer !== artifact) {
    await uploadAsset(LEGACY_REPO, legacyId, installer, basename(installer));
  }
  const legacyRoll = await ensureRelease(LEGACY_REPO, 'latest', {
    name: '最新版（更新端点读这里）',
    body: '由发布脚本自动维护，勿手动改。',
    prerelease: false,
  });
  await uploadAsset(LEGACY_REPO, legacyRoll.id ?? legacyRoll.release_id, 'tmp/latest.json', 'latest.json');
  console.log('  桥接完成，老客户端的端点：');
  console.log(`  ${legacyDownload}/latest/latest.json`);
}
