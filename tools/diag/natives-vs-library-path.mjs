/* 检查 natives 目录 + java.library.path 是否一致 */
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const base = join(process.env.TEMP, 'ieml-live-test');
const natives = join(base, 'instances', 'live-1.20.1', 'natives');

console.log('=== natives 目录 ===');
console.log(natives, existsSync(natives) ? '(存在)' : '(不存在!)');
if (existsSync(natives)) {
  const files = readdirSync(natives);
  console.log(`共 ${files.length} 个文件:`);
  for (const f of files.sort()) console.log('  ' + f);
}

console.log('\n=== 检查 java.library.path 参数是否在命令里 ===');
const logPath = join(base, 'instances', 'live-1.20.1', 'run.log');
console.log('run.log 存在:', existsSync(logPath));

/* 用 javap 或直接看 classpath 里是否有 lwjgl jar —— 检查 jar 是否完整 */
console.log('\n=== lwjgl natives jar 的大小（判断是否下全）===');
const jars = [
  'libraries/org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1-natives-windows.jar',
  'libraries/org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1.jar',
  'libraries/org/lwjgl/lwjgl-glfw/3.3.1/lwjgl-glfw-3.3.1-natives-windows.jar',
];
import { statSync } from 'node:fs';
for (const j of jars) {
  const p = join(base, j);
  if (existsSync(p)) {
    console.log(`  ✓ ${(statSync(p).size / 1024).toFixed(0).padStart(6)} kB  ${j}`);
  } else {
    console.log(`  ✗ 不存在  ${j}`);
  }
}

/* 关键：Java 的 java.library.path 需要目录存在于启动时。检查是否有多余的 arm64/x86 natives 被解压进来覆盖 */
console.log('\n=== 是否存在 32 位 / arm64 的 dll 混入 ===');
if (existsSync(natives)) {
  const files = readdirSync(natives).filter((f) => f.endsWith('.dll'));
  console.log(`  dll 共 ${files.length} 个: ${files.join(', ')}`);
}
