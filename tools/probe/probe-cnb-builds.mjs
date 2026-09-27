/*
 * 只读排查：CNB 上**最近的构建**到底跑没跑、是绿是红。
 *
 * 为什么需要它：`ci-status.json` 那个资产是**流水线自己写的**——
 * 它停了，只能说明"最近几次没写到"，不能区分下面三种情况：
 *   ① 流水线根本没被触发；  ② 触发了但在 endStages 之前就被取消/挂掉；
 *   ③ 跑了、也上报了，但上传失败（`.cnb.yml` 里那句 `|| echo` 会把它咽掉）。
 * 这三件事的处置完全不同，所以先能看见构建列表。
 *
 * 用法：
 *   node tools/probe/probe-cnb-builds.mjs            # 最近 10 次
 *   node tools/probe/probe-cnb-builds.mjs 30         # 最近 30 次
 *
 * ★ 令牌只从 `git credential fill` 取、只放进请求头，**不打印**。
 * ★ 没有任何构建查询权限时它会如实报出来（`NO_RIGHT`），不假装列表是空的。
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const API = 'https://api.cnb.cool';
const REPO = 'IEML_Official/IEML';

function token() {
  if (process.env.CNB_TOKEN) return process.env.CNB_TOKEN.trim();
  const git = join(process.env.LOCALAPPDATA ?? '', 'Programs', 'PortableGit', 'cmd', 'git.exe');
  const out = execFileSync(git, ['credential', 'fill'], {
    input: 'protocol=https\nhost=cnb.cool\n\n',
    encoding: 'utf8',
  });
  const m = out.match(/^password=(.+)$/m);
  if (!m) throw new Error('取不到 cnb 令牌');
  return m[1].trim();
}

const limit = Number(process.argv[2] ?? 10);
const headers = { accept: 'application/json', authorization: `Bearer ${token()}` };

async function tryGet(path) {
  const r = await fetch(`${API}${path}`, { headers });
  const text = await r.text();
  return { status: r.status, text };
}

/* 多试几个可能的路径：接口名字以实际返回为准（拿不到权限就如实说） */
const candidates = [
  `/${REPO}/-/builds?limit=${limit}`,
  `/${REPO}/-/build/list?limit=${limit}`,
  `/${REPO}/-/pipeline/list?limit=${limit}`,
];

for (const path of candidates) {
  const { status, text } = await tryGet(path);
  console.log(`\n【GET ${path}】HTTP ${status}`);
  if (status >= 400) {
    console.log('  ' + text.slice(0, 200));
    continue;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    console.log('  （不是 JSON）' + text.slice(0, 200));
    continue;
  }
  const list = Array.isArray(data) ? data : (data.list ?? data.builds ?? data.data ?? []);
  if (!Array.isArray(list) || list.length === 0) {
    console.log('  （空列表）' + JSON.stringify(data).slice(0, 200));
    continue;
  }
  for (const b of list.slice(0, limit)) {
    const sha = String(b.sha ?? b.commit ?? b.commitSha ?? '').slice(0, 7);
    const st = b.status ?? b.pipelineStatus ?? b.state ?? '?';
    const at = b.createdAt ?? b.createTime ?? b.pipelineCreateTime ?? b.startTime ?? '';
    const id = b.id ?? b.buildId ?? b.sn ?? '';
    console.log(`  ${st.padEnd(10)} ${sha}  ${at}  ${id}`);
  }
}
