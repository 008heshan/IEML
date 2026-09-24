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

const REPO = 'IEML_Official/IEML-releases';           // 公开的发布仓（不是代码仓）
const API = 'https://api.cnb.cool';
const DOWNLOAD = `https://cnb.cool/${REPO}/-/releases/download`;
const BUNDLE = 'src-tauri/target/release/bundle';
const upload = process.argv.includes('--upload');

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
function pick(suffix) {
  const hit = files.filter((f) => f.endsWith(suffix));
  const exact = hit.filter((f) => basename(f).includes(version));
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
/** 找到或创建指定 tag 的 release。重跑时必须复用，否则 CNB 会因为 tag 已存在而报错。 */
async function ensureRelease(tagName, { name, body, prerelease }) {
  const findAll = async () => {
    const list = await api(`/${REPO}/-/releases?per_page=100`);
    const arr = Array.isArray(list) ? list : (list?.releases ?? list?.data ?? []);
    return arr.find((r) => (r.tag_name ?? r.tag) === tagName && r.id);
  };
  try {
    const r = await api(`/${REPO}/-/releases/tags/${encodeURIComponent(tagName)}`);
    if (r?.id) return r;
  } catch { /* 这个接口不一定有，回退到列表查找 */ }
  try {
    const hit = await findAll();
    if (hit) return hit;
  } catch { /* 列表也拿不到就直接尝试创建 */ }
  try {
    return await api(`/${REPO}/-/releases`, {
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

async function uploadAsset(releaseId, filePath, assetName) {
  const size = statSync(filePath).size;
  const { upload_url, verify_url, upload_token } = await api(
    `/${REPO}/-/releases/${releaseId}/asset-upload-url`,
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
const rel = await ensureRelease(tag, {
  name: `IEML ${version}`,
  body: latest.notes,
  prerelease: /-/.test(version),   // 带后缀的是预发布
});
const relId = rel.id ?? rel.release_id;
console.log(`  release ${tag} id=${relId}`);
await uploadAsset(relId, artifact, basename(artifact));
// 多数时候 installer 就是 artifact 本身（NSIS 产物既是安装包也是更新包），
// 那就别用同一个名字传两遍 —— 白传一次 3 MB，日志里还像出了错。
if (installer && installer !== artifact) await uploadAsset(relId, installer, basename(installer));

// 滚动 tag：只放 latest.json，每次覆盖
const roll = await ensureRelease('latest', { name: '最新版（更新端点读这里）', body: '由发布脚本自动维护，勿手动改。', prerelease: false });
const rollId = roll.id ?? roll.release_id;
console.log(`  release latest id=${rollId}`);
await uploadAsset(rollId, 'tmp/latest.json', 'latest.json');

console.log('\n完成。更新端点：');
console.log(`  ${DOWNLOAD}/latest/latest.json`);
