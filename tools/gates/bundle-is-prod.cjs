/**
 * 判断打包产物里 React 是 dev 还是 prod 构建。
 *
 * 判据说明（避免误报）：
 *   __REACT_DEVTOOLS_GLOBAL_HOOK__ 在**生产版里也存在**（它只是用来告知 devtools
 *   不要接管），所以不能作为 dev 的标志。
 *   可靠判据是：开发版会保留**未压缩的完整错误文案**与 process.env.NODE_ENV 判断。
 */
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', 'dist', 'assets');
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.js'))
  .map((f) => ({ f, size: fs.statSync(path.join(dir, f)).size }))
  .sort((a, b) => b.size - a.size);

console.log('=== dist/assets 里的 JS ===');
for (const { f, size } of files) console.log(`  ${f.padEnd(30)} ${(size / 1024).toFixed(1)} kB`);

const main = files[0];
const code = fs.readFileSync(path.join(dir, main.f), 'utf8');
const count = (s) => code.split(s).length - 1;
const has = (s) => count(s) > 0;

console.log(`\n=== 主 bundle: ${main.f} (${(main.size / 1024).toFixed(1)} kB) ===`);

/* ---------- 可靠判据 ---------- */
const checks = [
  // 开发版特征
  ['dev', 'process.env.NODE_ENV 未被替换（dev 才会在运行时判断）', has('process.env.NODE_ENV')],
  ['dev', '激活警告文案（开发版独有）', has('act(') && has('Warning:')],
  ['dev', '完整错误文案 "Cannot update a component"', has('Cannot update a component')],
  ['dev', 'stack 提取函数（开发版独有）', has('captureOwnerStack') || has('getStackAddendum')],
  // 生产版特征
  ['prod', '压缩错误表（生产版独有）', has('Minified React error')],
  ['prod', 'React 版本号字符串', /react-dom@?\d/.test(code) || has('"18.3.1"')],
];

let devScore = 0;
let prodScore = 0;
for (const [kind, label, hit] of checks) {
  if (kind === 'dev' && hit) devScore++;
  if (kind === 'prod' && hit) prodScore++;
  console.log(`  [${kind}] ${hit ? 'HIT ' : 'miss'}  ${label}`);
}

console.log(`\n开发版特征命中 ${devScore} / 生产版特征命中 ${prodScore}`);

/* ---------- 体积交叉验证 ---------- */
// React 18 生产版 react-dom 压缩后约 130 kB；开发版约 900 kB+
const reactDomDevMin = 700 * 1024;
const verdict =
  devScore > 0 && main.size > reactDomDevMin
    ? '开发版（需修复）'
    : prodScore > 0 && devScore === 0
      ? '生产版 ✅'
      : main.size < 400 * 1024
        ? '生产版 ✅（按体积判断）'
        : '无法确定';

console.log(`\n结论：React 运行在 ${verdict}`);
console.log(`对照：React 18 生产版 react-dom 压缩后约 130 kB；开发版约 900 kB+`);
