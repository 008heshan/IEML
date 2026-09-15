/**
 * 审计：所有「创建子进程」的地方有没有抑制控制台窗口。
 *
 * ## 为什么需要它
 *
 * 用户报的原话：「安装 Forge 调出来个啥也没有的 cmd 是何意味」。
 *
 * Windows 上启动**控制台子系统**程序（java.exe / tar.exe / taskkill.exe /
 * cmd.exe）而不传 `CREATE_NO_WINDOW`，系统就会弹出一个控制台窗口。
 * Forge 安装器的输出被启动器接走了（要判断成功失败、给用户看进度），
 * 所以那个窗口里什么都没有，只剩一个空壳挂在屏幕上。
 *
 * ## 为什么必须自动化
 *
 * 这类遗漏是**逐处**的：这轮修的时候，全仓库 4 处加了标志、**13 处没加**，
 * 而"唯一会真的弹给用户看"的那一处恰好就是「安装 Forge」
 * —— 因为它是唯一用 `tokio::process::Command` 创建 Java 子进程的地方，
 * 而标志只加在了 `std::process::Command` 那一侧。
 * 靠人眼 review 这种东西一定会漏，所以做成一条会红的检查。
 *
 * ## 判据
 *
 * 创建子进程的位置，后 20 行内必须出现 `hide_console`（统一入口，
 * 见 `platform::hide_console` / `hide_console_async`）。
 * 直接写 `creation_flags` 也算 —— 那说明有人绕过统一入口手写了标志，
 * 这里会**警告**（不算失败），因为手写那个魔数抄错一次就是一个新黑框。
 */
import fs from 'node:fs';
import path from 'node:path';

const files = [];
function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (p.endsWith('.rs')) files.push(p);
  }
}
walk('src-tauri/src');
walk('src-tauri/tests');

const RE = /Command::new\s*\(/;
let miss = 0;
let ok = 0;
const handRolled = [];

for (const f of files) {
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (!RE.test(lines[i])) continue;
    // 变量绑定的情况：向下找 20 行看有没有统一入口
    const span = 20;
    const near = lines.slice(i, Math.min(i + span, lines.length)).join('\n');
    const hasHelper = /hide_console(_async)?\s*\(/.test(near);
    const hasRaw = /creation_flags/.test(near);
    if (hasRaw) handRolled.push(`${f}:${i + 1}`);
    if (hasHelper || hasRaw) ok += 1;
    else miss += 1;
    console.log(
      `${hasHelper ? '  ok  ' : hasRaw ? '  ok* ' : '★ MISS'} ${f}:${i + 1}  ${lines[i].trim().slice(0, 90)}`,
    );
  }
}

console.log('');
if (handRolled.length) {
  console.log(
    `⚠ ${handRolled.length} 处直接手写了 creation_flags（建议改用 platform::hide_console，避免魔数抄错）：`,
  );
  for (const h of handRolled) console.log(`    ${h}`);
}
console.log(`有抑制：${ok} 处，缺抑制：${miss} 处`);
if (miss === 0) {
  console.log('✓ 所有子进程创建点都抑制了控制台窗口');
}
process.exit(miss === 0 ? 0 : 1);

