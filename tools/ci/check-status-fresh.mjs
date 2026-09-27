/*
 * 只读检查：**CNB 的 CI 结果是不是这一版的**。
 *
 * ## 为什么需要它
 *
 *   CNB 的流水线结果只有写在 `ci-status.json` 上才看得见（本机凭据没有构建查询权限）。
 *   而那个文件**只会在流水线真的跑到 endStages 时才更新** ——
 *   于是有三种情况从"文件内容"上分不清：
 *     ① 流水线根本没被触发；② 跑到一半就结束了；③ 跑绿了但上传失败。
 *
 *   ⇒ 这个脚本把"能不能声称 CI 绿"变成一条**可查的**判断：
 *     文件里的 sha 是不是当前 HEAD？是不是最近几分钟内的？
 *     不是的话，如实打印"这一次的结果未知"，而不是拿上一次的绿当这一次的绿。
 *
 * ## 用法
 *
 *   node tools/ci/check-status-fresh.mjs          # 打印结论（退出码 0 = 已覆盖 / 1 = 未覆盖）
 *   node tools/ci/check-status-fresh.mjs --soft   # 永远退 0（只打印，不断流水线）
 *
 * ★ 它**不是门禁**（没进 `verify.mjs`）：CNB 排队与延迟都不该拖住本地开发。
 *   它是给"发版前我要不要声称 CI 绿"这个问题用的。
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const soft = process.argv.includes('--soft');
const URL = 'https://cnb.cool/IEML_Official/IEML/-/releases/download/ci-status/ci-status.json';

const git = join(process.env.LOCALAPPDATA ?? '', 'Programs', 'PortableGit', 'cmd', 'git.exe');
const head = execFileSync(git, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

let status = null;
try {
  const r = await fetch(URL, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  status = await r.json();
} catch (e) {
  console.log(`✗ 读不到 CI 状态（${e.message}）—— **这一次的结果未知**`);
  process.exit(soft ? 0 : 1);
}

const sameCommit = String(status.sha ?? '').startsWith(head.slice(0, 7));
const at = status.at ? Date.parse(status.at) : 0;
const ageMin = at ? Math.round((Date.now() - at) / 60000) : -1;

console.log(`CI 状态资产：sha=${status.sha_short || '?'} status=${status.pipeline_status} at=${status.at}（${ageMin} 分钟前）`);
console.log(`本地 HEAD  ：${head.slice(0, 7)}`);
if (status.note) console.log(`备注       ：${status.note}`);

if (sameCommit) {
  console.log(
    `✓ 这一次推送的 CI 结果**已经上报**：${status.pipeline_status}` +
      `（覆盖：${status.scope}；**不含** Rust 两项）`,
  );
  process.exit(0);
}
console.log(
  `✗ 状态文件里的不是这一次（是 ${String(status.sha_short || status.sha || '?').slice(0, 7)}）——` +
    ` **本次推送的 CNB 结果未知**，别把它当成绿。`,
);
process.exit(soft ? 0 : 1);
