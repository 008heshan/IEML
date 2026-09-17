/*
 * 确认"更新能力真的被编进了 exe"，而不只是写在配置文件里。
 *
 * 为什么值得单独一条：配置写对了却没进二进制，是这类功能的经典失败形态 ——
 * 而且**只有玩家点按钮时才会暴露**（构建、类型检查、打包全都不会报）。
 *
 * ★ 关于 ACL 的正确形态（第一版这里写错过）：
 *   `capabilities/default.json` 里写的是 `updater:default`，但 Tauri 会把它
 *   **展开成具体命令**再编进二进制，形态是 `plugin:updater|check` 这种。
 *   所以查字面量 `updater:default` 永远是找不到的 —— 那不代表权限没生效。
 *
 * ★ `createUpdaterArtifacts` 也不该查：它是**纯构建期选项**，
 *   运行时的 conf 里本来就会被剥掉，查它同样是假阴性。
 */
import { readFileSync, existsSync } from 'node:fs';

const exe = 'src-tauri/target/release/ieml.exe';
const conf = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const endpoint = conf.plugins.updater.endpoints[0];
const pubkey = conf.plugins.updater.pubkey;

if (!existsSync(exe)) {
  console.error('✗ 没有 release exe（先 pnpm exec tauri build）');
  process.exit(1);
}
const hay = readFileSync(exe).toString('latin1'); // 逐字节，不做编码转换

const probes = [
  ['更新端点 URL', endpoint],
  ['内置公钥（base64）', pubkey],
  ['插件被编入 tauri-plugin-updater', 'tauri-plugin-updater'],
  // 前端 useLauncherUpdate 调的就是这两个命令，权限必须放行
  ['ACL 放行 plugin:updater|check', 'plugin:updater|check'],
  ['ACL 放行 plugin:updater|download_and_install', 'plugin:updater|download_and_install'],
  ['更新器运行时（installMode）', 'installMode'],
];

let bad = 0;
for (const [label, needle] of probes) {
  const hit = hay.includes(needle);
  console.log(`  ${hit ? '✓' : '✗'} ${label}`);
  if (!hit) bad++;
}

// 反面证据：配置里若还留着占位端点，必须报出来
const placeholder = hay.match(/https:\/\/REPLACE-ME[^"\\ ]*/);
if (placeholder) {
  console.log(`  ✗ exe 里仍有占位符端点：${placeholder[0]}`);
  bad++;
} else {
  console.log('  ✓ 没有残留的 REPLACE-ME 占位端点');
}

console.log('');
if (bad) {
  console.error(`✗ ${bad} 项没进 exe —— 更新能力没被编进去，玩家点"检查更新"会失败`);
  process.exit(1);
}
console.log('✓ 更新能力确实编进了 exe：端点、公钥、插件、ACL 权限、运行时都在');
