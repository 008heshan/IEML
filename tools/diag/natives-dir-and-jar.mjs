/* 检查 natives 目录内容，以及 natives jar 里的实际结构 */
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const nativesDir = process.env.TEMP + '\\ieml-live-test\\instances\\live-1.20.1\\natives';
console.log('=== natives 目录内容 ===');
try {
  const files = readdirSync(nativesDir);
  console.log(`共 ${files.length} 个文件`);
  const byExt = {};
  for (const f of files) {
    const ext = f.includes('.') ? f.split('.').pop().toLowerCase() : '(无扩展名)';
    byExt[ext] = (byExt[ext] || 0) + 1;
  }
  console.log('按扩展名:', JSON.stringify(byExt));
  console.log('\n文件名列表:');
  for (const f of files.sort()) {
    const size = statSync(join(nativesDir, f)).size;
    console.log(`  ${f.padEnd(40)} ${(size / 1024).toFixed(1)} kB`);
  }
  const hasLwjgl = files.some((f) => f.toLowerCase() === 'lwjgl.dll');
  console.log(`\n★ 有 lwjgl.dll 吗？ ${hasLwjgl ? '有' : '没有 —— 这就是失败原因'}`);
} catch (e) {
  console.log('读目录失败:', e.message);
}

/* 看 natives jar 里的结构 */
const libsDir = process.env.TEMP + '\\ieml-live-test\\libraries\\org\\lwjgl';
console.log('\n=== lwjgl natives jar 的磁盘位置 ===');
function walk(dir, depth = 0) {
  if (depth > 4) return;
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.includes('natives')) console.log('  ' + p);
    }
  } catch {}
}
walk(libsDir);

console.log('\n=== 用 tar 列出 natives jar 里的条目结构 ===');
const jar = process.env.TEMP + '\\ieml-live-test\\libraries\\org\\lwjgl\\lwjgl\\3.3.1\\lwjgl-3.3.1-natives-windows.jar';
try {
  const out = execSync(`tar -tf "${jar}"`, { encoding: 'utf8' });
  const entries = out.trim().split('\n');
  console.log(`共 ${entries.length} 个条目:`);
  for (const e of entries.slice(0, 30)) console.log('  ' + e);
  const dlls = entries.filter((e) => e.toLowerCase().endsWith('.dll'));
  console.log(`\n其中的 .dll: ${JSON.stringify(dlls)}`);
} catch (e) {
  console.log('tar 失败:', e.message);
}
