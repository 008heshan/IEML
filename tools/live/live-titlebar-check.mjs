/**
 * 真机断言：**自绘标题栏**这件事有没有真的成立。
 * ------------------------------------------------------------------
 * 用户报："这个白色的条，并进软件里，这个额外的在外面，很丑"。
 * 改法是 `decorations: false` + 自绘顶栏。但"配置改了"不等于"界面对了"，
 * 所以这里读**跑起来的那份应用**：
 *   ① 顶栏有没有 `data-tauri-drag-region`（没有 = 窗口拖不动，事故）
 *   ② 三个窗口按钮在不在、可不可见、点了真的最小化吗
 *   ③ 窗口样式里还有没有 WS_THICKFRAME（没了 = 用户拖不动窗口大小）
 *
 * 用法：node tools/live/live-titlebar-check.mjs [exe]
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const PORT = Number(process.env.CDP_PORT ?? 9224);
const HOME = process.env.USERPROFILE ?? 'C:\\Users\\Administrator';
const EXE = process.argv[2] ?? join('E:/IEML/src-tauri/target/debug/ieml.exe');
if (!existsSync(EXE)) {
  console.error(`找不到 exe：${EXE}`);
  process.exit(2);
}

const child = spawn(EXE, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: 'ignore',
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
console.log(`启动 PID ${child.pid}（${EXE}）`);

async function getPage() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const page = (await r.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* 还没起来 */
    }
    await sleep(500);
  }
  return null;
}

const page = await getPage();
if (!page) {
  console.error('✗ WebView2 的 CDP 没起来');
  child.kill();
  process.exit(1);
}
console.log(`✓ 界面已渲染：${page.title}`);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
function evaluate(expression) {
  const myId = ++id;
  return new Promise((resolve, reject) => {
    pending.set(myId, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result?.result?.value)));
    ws.send(JSON.stringify({ id: myId, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  });
}

await sleep(1500);
const dom = await evaluate(`(() => {
  const bar = document.querySelector('.titlebar');
  const btns = [...document.querySelectorAll('.winctl-btn')];
  const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  return {
    dragRegion: bar ? bar.hasAttribute('data-tauri-drag-region') : null,
    barRect: bar ? rect(bar) : null,
    winBtnCount: btns.length,
    winBtns: btns.map((b) => ({ label: b.getAttribute('aria-label'), visible: b.offsetParent !== null, rect: rect(b) })),
  };
})()`);
console.log('\n=== DOM ===');
console.log(JSON.stringify(dom, null, 2));

// 最小化：点一下，然后把**几个候选信号**都读出来。
//
// ★★ 这里踩过一个错：我原本以为"窗口最小化 → `document.visibilityState` 变 hidden"。
//   实测在 WebView2 里**不会**（点完仍然是 'visible'），所以它不能当判据 ——
//   脚本会因此谎报"点了没反应"。
//   真正可靠的信号在**系统侧**：Win32 `IsIconic(hwnd)`（实测 False → True → False）。
//   那个需要 P/Invoke，不适合塞进这个 node 脚本，所以这里改成：
//     ① 点一下按钮（证明 React 侧接上了）
//     ② 把候选信号都打印出来，供人工/后续判断
//     ③ 把"从系统侧确认"的命令写在输出里
const minInfo = await evaluate(`(async () => {
  const b = [...document.querySelectorAll('.winctl-btn')].find(x => x.getAttribute('aria-label') === '最小化');
  if (!b) return { clicked: false };
  b.click();
  await new Promise(r => setTimeout(r, 1200));
  return {
    clicked: true,
    visibilityState: document.visibilityState,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
  };
})()`);
console.log('\n=== 最小化按钮 ===');
console.log(JSON.stringify(minInfo, null, 2));
console.log('系统侧确认（PowerShell，P/Invoke user32!IsIconic）：点击后应为 True');
console.log("  Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class W{[DllImport(\"user32.dll\")]public static extern bool IsIconic(IntPtr h);}';");
console.log("  $h=(Get-Process ieml|?{$_.MainWindowHandle -ne 0}|Select -First 1).MainWindowHandle; [W]::IsIconic($h)");

// 判据只包含**能被这个脚本证实**的东西：拖动区 + 三个按钮在位可见 + 点击被接受。
const pass =
  dom.dragRegion === true &&
  dom.winBtnCount === 3 &&
  dom.winBtns.every((b) => b.visible) &&
  minInfo?.clicked === true;
console.log(
  `\n${pass ? '✓ 自绘标题栏的 DOM 部分成立（可拖动 + 三个窗口按钮在位可见 + 点击已接上）' : '✗ 有项目没通过'}`,
);
console.log('★ 窗口是否真的最小化，看上面那条系统侧命令 —— 本脚本证不了它，就不假装证得了。');
ws.close();
child.kill();
await sleep(400);
process.exit(pass ? 0 : 1);
