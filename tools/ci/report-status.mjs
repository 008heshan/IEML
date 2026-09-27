/*
 * 把**这一次 CI 的结果**写成一个可读的产物（CNB 的 `ci-status` 滚动 release）。
 *
 * ## 为什么需要它（"看不见"就等于没有）
 *
 *   CNB 的流水线日志只在网页上看，而**本机那把仓库凭据没有构建查询权限**
 *   （`cnb build get-build-logs` → `NO_RIGHT Token scope not match`）。
 *   也就是说：流水线跑没跑、是绿是红，从命令行读不到 ——
 *   一份"跑过了但谁也看不见"的 CI，与没有 CI 的区别只在心理上。
 *
 *   流水线里 CNB 会**自动注入 `CNB_TOKEN`**（权限含 `repo-release:rw`），
 *   所以让流水线自己把结果写成 release 上的一个资产；
 *   那个资产用**仓库凭据**就能读（发布脚本一直在用同一套接口）。
 *   于是"跑起来了"与"可查"同时成立。
 *
 * ## 用法（只在 CI 里跑；本地手跑只会打印）
 *
 *   node tools/ci/report-status.mjs --status "$CNB_PIPELINE_STATUS" --log tmp/ci-verify.log
 *   node tools/ci/report-status.mjs --exit-code 1 --log /tmp/x.log   # 本地/兜底用法
 *
 * ★ 这个脚本**不决定成败**：判定权在 `verify.mjs` 的退出码（流水线里原样传播）。
 *   上报失败只意味着"这一次看不见结果"，不该把绿的判成红的 ——
 *   所以流水线里调用它时带 `|| echo …`。
 *
 * ★ 它**不打印任何凭据**：token 只从环境变量取、只放进请求头。
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (name, dflt = null) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};

/*
 * 状态来源两选一：
 *   ① `--status`（流水线里给 `${CNB_PIPELINE_STATUS}`：success / error / cancel）
 *   ② `--exit-code`（本地手跑，或者你想按某个命令的退出码记）
 */
const statusArg = (arg('--status') || '').trim().toLowerCase();
const exitCodeArg = arg('--exit-code');
const ok = statusArg ? statusArg === 'success' : Number(exitCodeArg ?? '0') === 0;
const logPath = arg('--log');
const note = arg('--note', '');

const repo = (process.env.CNB_REPO_SLUG || 'IEML_Official/IEML').replace(/^\/+|\/+$/g, '');
const apiBase = (process.env.CNB_API_ENDPOINT || 'https://api.cnb.cool').replace(/\/+$/, '');
const token = (process.env.CNB_TOKEN || '').trim();

/** 日志尾巴：红了的时候，读它就知道红在哪 */
function tail(path, lines = 60) {
  if (!path || !existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .slice(-lines)
    .filter((l) => l.trim().length > 0);
}

/**
 * ★ 失败细节：只截日志尾巴是不够的 —— 失败点常常在尾巴之前几十行
 *   （第一版就是这样：只看到"1 / 30 项失败：仓库根布局"，看不到**是哪一条**）。
 *   这里把带标记的行单独捞出来，红的时候一眼能看到原因。
 */
function failures(path, max = 40) {
  if (!path || !existsSync(path)) return [];
  const strip = (s) => s.replace(/\u001b\[[0-9;]*m/g, '').trimEnd();
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map(strip)
    .filter((l) => /✗|★ MISS|不该在|失败，退出码|Error:|error:/.test(l))
    .slice(0, max);
}

const status = {
  ok,
  // ★ 如实写清"这一次跑的是什么、没跑什么"：
  //   本流水线只跑可移植子集，Rust 那两项不在里面（要 Windows 的 MSVC）。
  scope: 'portable-subset（node tools/verify.mjs --skip-rust）',
  not_covered: ['Rust 领域测试（含 Java 判据表）', 'Rust 全部测试目标可编译'],
  pipeline_status: statusArg || null,
  exit_code: exitCodeArg === null ? null : Number(exitCodeArg),
  branch: process.env.CNB_BRANCH || '',
  sha: process.env.CNB_COMMIT || '',
  sha_short: process.env.CNB_COMMIT_SHORT || '',
  event: process.env.CNB_EVENT || '',
  build_id: process.env.CNB_BUILD_ID || '',
  /** ★ 点进去就是这次构建的日志（人看的地方） */
  build_url: process.env.CNB_BUILD_WEB_URL || '',
  at: new Date().toISOString(),
  note,
  log_tail: tail(logPath),
  /** ★ 失败细节（带 ✗ / MISS / 退出码 的那些行）—— 红了先看这里 */
  failures: failures(logPath),
};

/*
 * ★ 产物**写在仓库之外**（默认系统临时目录）。
 *   第一版写的是仓库里的 `tmp/ci-status.json`，结果"仓库根布局"那条门禁当场红了 ——
 *   `tmp/` 在白名单里，但**只允许空着**（它是给本地临时文件用的，不许攒东西）。
 *   门禁是对的：仓库根就是公开仓的门面，CI 的临时文件不该落在里面。
 */
const file = arg('--out', join(tmpdir(), 'ci-status.json'));
writeFileSync(file, JSON.stringify(status, null, 2), 'utf8');

const summary = `${ok ? '✓ 通过' : '✗ 失败'}｜sha=${status.sha_short || status.sha.slice(0, 8) || '?'}｜${status.branch || '?'}`;
if (!token) {
  // 本地手跑：如实说没上报，不假装
  console.log(`[ci-status] 没有 CNB_TOKEN —— 只打印结果，不上报：${summary}`);
  process.exit(0);
}

const headers = { accept: 'application/json', authorization: `Bearer ${token}` };
const api = async (path, init = {}) => {
  const r = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers ?? {}) },
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} -> HTTP ${r.status}: ${text.slice(0, 200)}`);
  }
  return text ? JSON.parse(text) : {};
};

const TAG = 'ci-status';
async function findRelease() {
  const list = await api(`/${repo}/-/releases`);
  const arr = Array.isArray(list) ? list : (list.releases ?? []);
  return arr.find((r) => (r.tag_name ?? r.tagName) === TAG) ?? null;
}

let rel = null;
try {
  rel = await findRelease();
} catch {
  /* 列表拿不到就当没有，下面直接建 */
}
if (!rel) {
  rel = await api(`/${repo}/-/releases`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tag_name: TAG,
      target_commitish: 'main',
      name: 'CI 状态（滚动，由流水线自动维护）',
      body:
        '每一次推送的结果写在 `ci-status.json` 里（含日志尾部与构建链接）。' +
        '★ 只覆盖可移植子集，**不含 Rust 两项**（那两项要 Windows 的 MSVC）。',
      prerelease: true,
      draft: false,
    }),
  });
}
const relId = rel.id ?? rel.release_id;

const size = statSync(file).size;
const { upload_url, verify_url } = await api(`/${repo}/-/releases/${relId}/asset-upload-url`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ asset_name: 'ci-status.json', size, overwrite: true }),
});
const abs = (u) => (/^https?:\/\//i.test(u) ? u : `${apiBase}${u.startsWith('/') ? '' : '/'}${u}`);
const put = await fetch(abs(upload_url), { method: 'PUT', body: readFileSync(file) });
if (!put.ok) throw new Error(`上传失败：HTTP ${put.status}`);
const confirm = await fetch(abs(verify_url), {
  method: 'POST',
  headers: { ...headers, 'content-type': 'application/json' },
  body: '{}',
});
if (!confirm.ok) throw new Error(`确认失败：HTTP ${confirm.status}`);

console.log(`[ci-status] 已上报：${summary} → release「${TAG}」的 ci-status.json`);
if (status.build_url) console.log(`[ci-status] 构建日志：${status.build_url}`);
