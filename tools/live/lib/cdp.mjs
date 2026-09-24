/**
 * `tools/live/*.mjs` 的**公共胶水**：起启动器、连 CDP、发命令、清场。
 * ------------------------------------------------------------------
 * 为什么要有这个文件（合并的理由，不是"抽个库显得整洁"）：
 *
 *   这一轮之前，`tools/live/` 下 82 个探针里**每一个**都自带一份同样的 60–80 行：
 *   杀进程 → 起 exe（带 `--remote-debugging-port` 与独立的 WebView 用户目录）→
 *   轮询 `/json/list` 拿 target → 建 WebSocket → 包 `Runtime.evaluate` →
 *   收尾杀进程、删 profile。合计 17k 行里相当一部分是这段复制品。
 *
 *   复制品的代价在这个仓库里已经付过一次：**两个阶段共用一个端口**那个假红
 *   （旧进程被单实例挡掉时，探针连上的是旧进程，于是"新构建"那一栏量到的是旧构建）。
 *   一处笔误要在 82 份里各修一遍是不可能的 —— 所以公共部分只能有一份。
 *
 * 用法（探针里）：
 *
 *   import { launch, killIeml, sleep } from './lib/cdp.mjs';
 *   const app = await launch({ exe: process.argv[2], tag: 'a4' });
 *   try { const n = await app.ev(`document.querySelectorAll('.ver-item').length`); ... }
 *   finally { await app.close(); }
 *
 * ★ 这个库只做"管道"：判据仍然写在各个探针里（探针之间的差别就是判据）。
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 挑一个**当前真的空闲**的 TCP 端口。
 *
 * ★★ 2026-09-24（探针卫生，实测踩到）：探针原来各自写死一个端口（9971、9973…），
 *   而这些脚本一天里要跑几十次 —— 端口上会留下大量 TIME_WAIT 连接，
 *   WebView2 再绑同一个端口就可能失败，表现是"启动器起来了但连不上 CDP"，
 *   甚至进程直接退出（`exitCode=0`，日志里只剩一行 glass 设置）。
 *   手工换一个全新端口跑，同一份 exe 一切正常 —— 所以这是**测量工具**的问题，
 *   不是产品问题。让库自己每次挑一个空闲端口，这类失败就没有了。
 */
export const pickFreePort = () =>
  new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });

/** 读一个日志文件的最后几行（起不来时用来看启动器的原话） */
const tailOf = (file, lines = 12) => {
  try {
    const all = readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim());
    return all.slice(-lines).join('\n') || '(日志是空的)';
  } catch (e) {
    return '(读不到日志) ' + e.message;
  }
};

/** 跑一段 PowerShell（路径里带引号/中文都没问题：走 -Command 字符串） */
export const ps = (command) =>
  new Promise((res) => {
    const p = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', () => res(out.trim()));
  });

/**
 * 把正在跑的启动器全关掉，**并收掉它留下的 WebView2 宿主进程**。
 *
 * ★★ 2026-09-24（探针卫生，实测踩到）：强杀启动器之后，`msedgewebview2.exe`
 *   会留下若干**没跟着退**的进程（一次实测残留 10 个），它们占着探针的 WebView
 *   用户目录 —— 下一阶段的启动会被拖住。
 *
 *   ★ 只杀**命令行里带我们探针 profile 名（`ieml-`）**的那些 ——
 *     别的应用也用 WebView2，按进程名一刀切会把用户的其他程序一起杀掉。
 */
export const killIeml = async () => {
  await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
  await sleep(600);
  await ps(
    `Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue ` +
      `| Where-Object { $_.CommandLine -like '*ieml-*' } ` +
      `| ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
  );
  await sleep(400);
};

/**
 * 等到**一个 ieml 进程都没有**（最多 ~20 秒）。
 *
 * ★ 必须等：启动器是单实例的 —— 旧进程还活着时，新起的那个会被挡掉、悄悄退出，
 *   而探针会连上**旧进程**的端口，量出一份看起来合理、其实测错了对象的结果。
 */
export const waitNoIeml = async () => {
  for (let i = 0; i < 40; i += 1) {
    const n = (await ps(`(Get-Process ieml -ErrorAction SilentlyContinue | Measure-Object).Count`)).trim();
    if (n === '0') return true;
    await sleep(500);
  }
  return false;
};

/**
 * 起一个启动器实例并接上 CDP。
 *
 * @param {object} o
 * @param {string} o.exe            要跑的 exe（默认仓库里的 release 版）
 * @param {number} [o.port]         CDP 端口；**不给就自动挑一个空闲的**（推荐，见 `pickFreePort`）。
 *                                  多阶段探针必须让每个阶段各拿一个端口 —— 否则第二阶段失败时，
 *                                  连上的会是还在服务的第一阶段进程。
 * @param {string} o.tag            这个阶段的短名（用作 WebView 用户目录名与日志名）
 * @param {object} [o.env]          额外的环境变量（沙盒用 IEML_DATA_DIR / IEML_OWN_DIR / APPDATA）
 * @param {boolean} [o.keepDataDir] true = 不删 IEML_DATA_DIR / IEML_OWN_DIR（默认删掉，走真实数据）
 * @param {string} [o.waitFor]      等这个选择器出现再返回（默认 `.nav-item`）
 * @param {number} [o.settleMs]     接到页面后再等多久（默认 2500，让界面把数据拉起来）
 * @param {number} [o.retries]      起不来时重试几次（默认 2，带退避）
 * @returns {Promise<{ev: Function, send: Function, pid: number, port: number, close: Function, ws: WebSocket}>}
 */
export async function launch({
  exe = path.join('src-tauri', 'target', 'release', 'ieml.exe'),
  port,
  tag = 'probe',
  env = {},
  keepDataDir = false,
  waitFor = '.nav-item',
  settleMs = 2500,
  retries = 2,
  /*
   * ★ 保留 WebView 用户目录（默认每次清空）。
   *   `localStorage`（`ieml.motion` / `ieml.lowPerf` 这些"本机偏好"）就存在那里 ——
   *   要验"重启之后设置还在不在"必须保留它，否则每次都是全新的浏览器配置。
   */
  keepProfile = false,
} = {}) {
  if (!existsSync(exe)) throw new Error('找不到 exe：' + exe);
  const cdpPort = port || (await pickFreePort());

  const profile = path.join(process.env.TEMP ?? '.', `ieml-${tag}-prof`);
  const childEnv = { ...process.env, ...env };
  if (!keepDataDir) {
    delete childEnv.IEML_DATA_DIR;
    delete childEnv.IEML_OWN_DIR;
  }
  childEnv.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-port=${cdpPort}`;
  childEnv.WEBVIEW2_USER_DATA_FOLDER = profile;

  /*
   * 把启动器的 stdout/stderr 直接落到文件（**不是管道** —— 这个环境里
   * "程序用管道抓另一个程序的输出"会被挡掉，报 EPERM）。
   * 起不来的时候把它的原话打出来，比"连不上 CDP"有用得多。
   */
  const logFile = path.join(process.env.TEMP ?? '.', `ieml-${tag}-out.log`);
  const logFd = openSync(logFile, 'w');

  let page = null;
  let child = null;

  for (let attempt = 0; attempt <= retries && !page; attempt += 1) {
    if (attempt > 0) {
      const wait = 3000 * attempt;
      console.log(`[cdp] 第 ${attempt} 次重试（等 ${wait} ms）—— 上一次没能连上（tag=${tag}）`);
      await sleep(wait);
    }
    try {
      if (!keepProfile) rmSync(profile, { recursive: true, force: true });
    } catch {}

    child = spawn(exe, [], { env: childEnv, stdio: ['ignore', logFd, logFd] });

    for (let i = 0; i < 75; i += 1) {
      /*
       * ★ 进程已经退出就**立刻**报出来，别干等到超时：这两种情况端口永远不会开，
       *   等到 30 秒只会看到一句"连不上 CDP"，把真正的原因藏起来。
       */
      if (child.exitCode !== null) {
        console.log(`[cdp] 进程已退出（exitCode=${child.exitCode}，pid=${child.pid}）—— 下面是它的原话：`);
        console.log(tailOf(logFile));
        break;
      }
      try {
        const r = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
        page = (await r.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (page) break;
      } catch {}
      await sleep(400);
    }
    if (!page && child.exitCode === null) {
      // 还活着却连不上：这种不是"被挡掉"，重试也没意义 —— 直接说清楚
      try {
        child.kill();
      } catch {}
      console.log('[cdp] 进程还活着但连不上 CDP —— 它的原话：');
      console.log(tailOf(logFile));
      try {
        closeSync(logFd);
      } catch {}
      throw new Error(`连不上 CDP（tag=${tag}，端口 ${cdpPort}，pid ${child.pid}，进程还活着）—— 本次测量无效`);
    }
  }
  try {
    closeSync(logFd);
  } catch {}
  if (!page) {
    throw new Error(`试了 ${retries + 1} 次都没起来（tag=${tag}，端口 ${cdpPort}）—— 本次测量无效`);
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  const send = (method, params) =>
    new Promise((res) => {
      const id = ++seq;
      pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    });

  /** 在页面里求值；`awaitPromise` 让 `invoke(...)` 这种 Promise 能直接 return */
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) {
      return { __err: String(r.result.exceptionDetails.text).slice(0, 300) };
    }
    return r.result?.result?.value;
  };

  if (waitFor) {
    for (let i = 0; i < 75; i += 1) {
      if ((await ev(`!!document.querySelector(${JSON.stringify(waitFor)})`)) === true) break;
      await sleep(400);
    }
  }
  if (settleMs) await sleep(settleMs);

  const close = async () => {
    try {
      ws.close();
    } catch {}
    await killIeml();
    try {
      if (!keepProfile) rmSync(profile, { recursive: true, force: true });
    } catch {}
  };

  return { ev, send, pid: child.pid, port: cdpPort, close, ws };
}

/** 调一个 Tauri 命令（走页面里的 `__TAURI_INTERNALS__.invoke`），返回 `{ok}` 或 `{err}` */
export const invokeOn = (ev, cmd, args) =>
  ev(
    `(async () => {
       try { return { ok: await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? {})}) }; }
       catch (e) { return { err: String(e && e.message ? e.message : e) }; }
     })()`,
  );

/** 点侧栏/二级导航里文案包含 `label` 的那一项 */
export const clickNav = (ev, label) =>
  ev(
    `[...document.querySelectorAll('.nav-item, .side-link')].find((x)=>(x.textContent||'').includes(${JSON.stringify(label)}))?.click()`,
  );

/* ---------- 文件小工具（探针里反复用到的几个） ---------- */

export const readOr = (p) => {
  try {
    return readFileSync(p, 'utf8');
  } catch (e) {
    return '(读不到) ' + e.message;
  }
};

export const jsonOr = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};

/** 某个文件的 mtime（不存在时 0 —— 判据里"0 = 不该存在"也是有意义的信息） */
export const mtimeOf = (p) => {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
};

/** 目录里最新的 mtime（递归；目录不存在时 0） */
export const newestIn = (dir) => {
  try {
    let best = 0;
    for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      try {
        const t = statSync(path.join(e.parentPath ?? dir, e.name)).mtimeMs;
        if (t > best) best = t;
      } catch {}
    }
    return best;
  } catch {
    return 0;
  }
};

/** 目录里的文件数（递归；不存在时 -1 —— 与"空目录 0"区分开） */
export const countIn = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true, recursive: true }).filter((e) => e.isFile()).length;
  } catch {
    return -1;
  }
};

/** `src` 里的文件，有多少个在 `dst` 里**找不到同名相对路径**（删东西之前的安全核对） */
export const missingIn = (src, dst) => {
  const set = new Set();
  try {
    for (const e of readdirSync(dst, { withFileTypes: true, recursive: true })) {
      if (e.isFile()) {
        const rel = path.join(e.parentPath ?? dst, e.name).slice(dst.length);
        set.add(rel.toLowerCase());
      }
    }
  } catch {}
  const out = [];
  try {
    for (const e of readdirSync(src, { withFileTypes: true, recursive: true })) {
      if (!e.isFile()) continue;
      const rel = path.join(e.parentPath ?? src, e.name).slice(src.length);
      if (!set.has(rel.toLowerCase())) out.push(rel);
    }
  } catch {}
  return out;
};
