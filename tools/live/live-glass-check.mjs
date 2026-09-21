/**
 * 真机验证：**液态玻璃**三档（弱化 / 适中 / 灵动）+ 五要素是否真的在生效。
 * ------------------------------------------------------------------
 * 用户 2026-09-21：「我想要真实的液态玻璃」+ 五条（边缘折射 / 动态高光 / 色散边缘 /
 * 厚度感 / 内容适应性）+「视效也要三档」+「win7 或显卡不支持 WebGL 2.0 时默认适中，
 * 并且不开放灵动视效」。
 *
 * ## 为什么这条必须是真机断言（而不是"我看代码写对了"）
 *
 *   五条要求里有四条**只有在合成器里才成立**：
 *     · 折射 = `backdrop-filter` 里挂 SVG 滤镜，**解析成功 ≠ 渲染出来**
 *       （探针 `probe-webview-glass.mjs` 用像素差证明过这条，但那是探针样张；
 *        真实界面上装没装上，得在这里看）；
 *     · 色散 / 厚度 / 高光 = 多层 `background-image` 的**最终合成**，
 *       任何一条被后面的规则覆盖掉，代码里完全看不出来；
 *     · 内容适应 = JS 每块玻璃按位置算出的 `--glass-tint`，
 *       "算出来了"和"取到的是不同颜色"是两件事（取成同一个值 = 没适应）。
 *
 * ## 判据（每档各一组）
 *
 *   灵动：`data-vfx=aura` · `data-vfx-lens=on` · GL 画布在 · 卡片真的挂着 `url(#…)`
 *         折射滤镜 · 色散/厚度/高光三层渐变都在 · 两块不同位置的卡片**取到不同颜色**
 *   适中：不起 GL，但（这台机器够格时）折射仍在 —— 折 weak 与 aura 之间那一档
 *   弱化：`backdrop-filter: none`、无折射滤镜、无 GL
 *
 * 用法：
 *   node tools/live/live-glass-check.mjs ["<exe>"]
 *   默认 `src-tauri/target/debug/ieml.exe`（开发版）；截图落在 `%TEMP%\ieml-glass/`。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const PORT = 9388;
const EXE =
  process.argv[2] ?? path.join('src-tauri', 'target', 'debug', 'ieml.exe');
const OUT = path.join(process.env.TEMP ?? '.', 'ieml-glass');
const PROFILE = path.join(process.env.TEMP ?? '.', 'ieml-glass-profile');

if (!existsSync(EXE)) {
  console.error(`找不到可执行文件：${EXE}`);
  process.exit(2);
}
rmSync(OUT, { recursive: true, force: true });
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (script) =>
  new Promise((resolve) => {
    const p = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d.toString('utf8')));
    p.stderr.on('data', (d) => (out += d.toString('utf8')));
    p.on('close', () => resolve(out.trim()));
  });

await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(900);

const app = spawn(EXE, [], {
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    WEBVIEW2_USER_DATA_FOLDER: PROFILE,
  },
  stdio: 'ignore',
});

let page = null;
for (let i = 0; i < 60; i += 1) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    page = (await r.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (page) break;
  } catch {}
  await sleep(500);
}
if (!page) {
  console.error('连不上 CDP');
  await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
  process.exit(2);
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
  new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) {
    return { __err: r.result.exceptionDetails.text };
  }
  return r.result?.result?.value;
};

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? `  —— ${extra}` : ''}`);
  if (!ok) failed += 1;
};

const waitApp = async () => {
  for (let i = 0; i < 90; i += 1) {
    if ((await ev(`!!document.querySelector('.nav-item')`)) === true) return true;
    await sleep(400);
  }
  return false;
};
const waitCards = async (n = 2) => {
  for (let i = 0; i < 60; i += 1) {
    const c = await ev(`document.querySelectorAll('.glass').length`);
    if (typeof c === 'number' && c >= n) return c;
    await sleep(400);
  }
  return 0;
};

/** 打开设置页（卡片最多的一页） */
const goto = async (label) => {
  await ev(`(() => {
    const items = [...document.querySelectorAll('.nav-item')];
    const hit = items.find((b) => (b.textContent || '').includes(${JSON.stringify(label)}));
    if (hit) hit.click();
    return !!hit;
  })()`);
  await sleep(1200);
};

if (!(await waitApp())) {
  console.error('界面没起来');
  await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
  process.exit(2);
}

/** 切换档位：写 localStorage + 重新加载（模拟"用户改档后重启"） */
const setLevel = async (level) => {
  await ev(`localStorage.setItem('ieml.vfx', ${JSON.stringify(level)})`);
  await send('Page.reload', { ignoreCache: false });
  await sleep(1500);
  if (!(await waitApp())) throw new Error('重载后界面没起来');
  await goto('设置');
  await waitCards(3);
  await sleep(600); // 等取色那一轮 rAF
};

/** 采集当前档位的现场 */
const snapshot = () =>
  ev(`(() => {
    const cards = [...document.querySelectorAll('.glass-refract')];
    const card = cards.find((c) => c.getBoundingClientRect().width > 200) || cards[0];
    const bg = card ? getComputedStyle(card) : null;
    const lens = cards.filter((c) => c.dataset.lens);
    const gl = document.querySelector('canvas.glass-ambient-gl');
    const ph = document.querySelector('.page-head');
    const tints = cards.slice(0, 8).map((c) => ({
      tint: c.style.getPropertyValue('--glass-tint').trim(),
      box: (() => { const r = c.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top)]; })(),
    }));
    /*
     * ★ 判据要**拿这块玻璃真正用的那个颜色**去比对，而且要比对**完整**的
     *   background-image —— 三层坑都踩过（每一条都是实测撞出来的）：
     *     ① 只查 'rgb(' 会漏（旧写法序列化成 rgba(…)，字符串里没有 'rgb('）；
     *     ② 只查前 300 个字符也会漏 —— 调色层是**最后一层**；
     *     ③ 序列化形式**两种都可能**：Chromium 153 对 rgb(r g b / a) 这种输入
     *        会原样保留现代语法 rgb(25 16 43 / 0.12)，不是 rgba(25, 16, 43, …)。
     *   所以用**正则容忍两种**，别写死字符串。
     */
    const tint = card ? card.style.getPropertyValue('--glass-tint').trim() : '';
    const nums = tint.split(/\\s+/).filter(Boolean);
    const tintInPaint = nums.length === 3 && bg
      ? new RegExp('rgba?\\\\(\\\\s*' + nums.join('[,\\\\s]+') + '\\\\b').test(bg.backgroundImage)
      : false;
    return {
      level: document.documentElement.dataset.vfx,
      lensAttr: document.documentElement.dataset.vfxLens,
      glAttr: document.documentElement.dataset.vfxGl ?? null,
      surfaces: document.querySelectorAll('.glass, .page-head').length,
      refract: cards.length,
      withLens: lens.length,
      lensId: lens[0]?.dataset.lens ?? null,
      backdrop: bg ? (bg.backdropFilter || bg.webkitBackdropFilter) : null,
      bgTail: bg ? bg.backgroundImage.slice(-160) : null,
      /*
       * ④ 厚度与 ③ 色散现在都走**内阴影**（box-shadow），不是渐变层 ——
       * 真机实测：三个装饰渐变层每帧多吃 9ms（5 层 24.7ms → 2 层 15.6ms）。
       * 所以判据也要跟着改，否则会拿旧实现去验新代码。
       */
      boxShadow: bg ? bg.boxShadow : null,
      /*
       * ★ 判据要按**浏览器实际序列化**的样子写：
       *   Chromium 把「inset 0 0 26px -14px rgba(...)」输出成
       *   「rgba(255, 255, 255, 0.23) 0px 0px 26px -14px inset」——颜色在前、inset 在后。
       *   （第一版按源码顺序查「inset 0px 0px 26px」→ 永远查不到 → 误报"厚度层不在"。）
       * ★ 另外：这个函数体是**模板字符串**，注释里**不许出现反引号**（会提前结束字符串，
       *   报错还指向别处 —— 这个坑我在这一个文件里踩了两次）。
       */
      hasRim: bg ? String(bg.boxShadow).includes('0px 0px 26px -14px') : false,
      hasDisp: bg ? String(bg.boxShadow).includes('rgba(255, 64, 64') : false,
      tintInPaint,
      phBackdrop: ph ? (getComputedStyle(ph, '::before').backdropFilter || 'none') : null,
      glCanvas: gl ? [gl.width, gl.height] : null,
      tints,
      distinctTints: new Set(tints.map((t) => t.tint)).size,
      gx: card ? getComputedStyle(card).getPropertyValue('--glass-gx').trim() : null,
    };
  })()`);

/**
 * 背景区域截图（**侧栏底部那块空地**）—— 用来判"灵动档的流体背景到底画出来没有"：
 * 这块区域上没有玻璃，两张图不同就说明背景层真的换了实现。
 */
const bgClip = () =>
  ev(`(() => {
    const h = window.innerHeight || 800;
    return { x: 8, y: Math.max(0, h - 150), width: 170, height: 120, scale: 1 };
  })()`);

/**
 * 帧时间：**先热身一轮再量**，报平均 / p95 / 掉帧数。
 *
 * ★★ 为什么要热身（实测踩到，不然数据虚高一倍）：
 *   第一次连续滚动会带上"第一次画这层玻璃"的成本 —— 着色器编译、
 *   合成层提升、SVG 滤镜首次栅格化。直接量到的是 **24ms**，
 *   而同一屏第二次量是 **11ms**。拿前者当结论会得出"液态玻璃很卡"的
 *   错误结论，进而去做一堆没必要的优化（我差点就这么干了）。
 */
const frameTimes = () =>
  ev(`(async () => {
    const box = document.querySelector('.content') || document.scrollingElement;
    const pass = (frames) =>
      new Promise((res) => {
        const times = [];
        let last = performance.now();
        let n = 0;
        const step = () => {
          const now = performance.now();
          times.push(now - last);
          last = now;
          box.scrollTop += 26;
          if (box.scrollTop + box.clientHeight >= box.scrollHeight - 2) box.scrollTop = 0;
          n += 1;
          if (n < frames) requestAnimationFrame(step);
          else res(times);
        };
        requestAnimationFrame(step);
      });
    await pass(120);              // ← 热身 1：把"第一次画这层玻璃"的成本吃掉
    await pass(120);              // ← 热身 2：让合成器把整页内容都栅格化过一遍
    return await pass(120);       // ← 这一轮才算数
  })()`);

/**
 * 把折射（`url(#…)`）拿掉、只留模糊 —— 用来**单独量折射的代价**。
 *
 * ★ 注入通道必须走 CSSOM（`insertRule`），不能用 `<style>` 元素：
 *   后者受 CSP `style-src` 管，会被静默拦掉（我第一次的五个用例全同就是这么来的）。
 * ★ `insertRule` 一次只收**一条**规则，不能把两条拼成一个字符串。
 */
const setLensDisabled = (disabled) =>
  ev(`(() => {
    const s = [...document.styleSheets].find((x) => (x.href || '').includes('index-'));
    if (!s) return 'no-sheet';
    for (let i = s.cssRules.length - 1; i >= 0; i -= 1) {
      if ((s.cssRules[i].cssText || '').includes('probe-no-lens')) s.deleteRule(i);
    }
    if (${disabled}) {
      s.insertRule('.glass{backdrop-filter:blur(13px) saturate(1.5) !important} /* probe-no-lens */', s.cssRules.length);
    }
    const c = document.querySelector('.glass-refract');
    return c ? (getComputedStyle(c).backdropFilter || '') : 'no-card';
  })()`);

/**
 * 截图 → 返回**内容哈希**（不是长度！）。
 * ★ 长度相同 ≠ 内容相同：第一次比对"背景有没有在动"就是用长度比的，
 *   两张不同的图凑巧字节数一样就误报成"没动"。
 */
const shoot = async (tag, clip) => {
  const r = await send('Page.captureScreenshot', clip ? { format: 'png', clip } : { format: 'png' });
  const b64 = r.result?.data ?? '';
  if (!b64) return '';
  const buf = Buffer.from(b64, 'base64');
  writeFileSync(path.join(OUT, `${tag}.png`), buf);
  return createHash('sha256').update(buf).digest('hex').slice(0, 12);
};

const cardClip = async () => {
  const box = await ev(`(() => {
    const c = [...document.querySelectorAll('.glass-refract')].find((x) => x.getBoundingClientRect().width > 240);
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: Math.max(0, r.left - 8), y: Math.max(0, r.top - 8), width: Math.min(420, r.width + 16), height: Math.min(300, r.height + 16) };
  })()`);
  return box ? { ...box, scale: 2 } : null;
};

const report = (s, perf) => {
  const arr = Array.isArray(perf) ? perf.slice(2) : [];
  const avg = arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const p95 = sorted.length ? sorted[Math.floor(sorted.length * 0.95)] ?? 0 : 0;
  const drops = arr.filter((t) => t > 33).length;
  console.log(
    `   帧时间 平均 ${avg.toFixed(1)}ms · p95 ${p95.toFixed(1)}ms · >33ms 的帧 ${drops}/${arr.length}`,
  );
  console.log(`   玻璃面 ${s.surfaces} 个（其中参与折射 ${s.refract} 个，已装透镜 ${s.withLens} 个）`);
  console.log(`   取色 ${s.distinctTints} 种：${s.tints.slice(0, 4).map((t) => `[${t.box[0]},${t.box[1]}] rgb(${t.tint})`).join(' ')}`);
  console.log(`   backdrop-filter: ${String(s.backdrop).slice(0, 90)}`);
  console.log(`   GL 画布: ${s.glCanvas ? `${s.glCanvas[0]}×${s.glCanvas[1]}` : '（无）'}`);
  return { avg, p95, drops };
};

/* ====================== 灵动档 ====================== */
console.log('=== 灵动视效（aura）===');
await setLevel('aura');
const aura = await snapshot();
const auraPerf = await frameTimes();
const auraPerfStat = report(aura, auraPerf);
const auraClip = await cardClip();
await shoot('aura-全窗');
if (auraClip) await shoot('aura-卡片特写', auraClip);
const auraBg = await shoot('aura-背景区', await bgClip());
const auraBg2 = await (async () => {
  await sleep(1500);
  return shoot('aura-背景区-1.5秒后', await bgClip());
})();

check('档位属性 = aura', aura.level === 'aura', String(aura.level));
check('折射能力标记 = on', aura.lensAttr === 'on', String(aura.lensAttr));
check('★ 卡片真的挂着折射滤镜 url(#…)', String(aura.backdrop).includes('url("#ieml-lens-'), String(aura.lensId ?? '无'));
check('折射滤镜注册了不止一块玻璃', aura.withLens >= 2, `${aura.withLens} 块`);
check('④ 厚度层（内缘辉光）在', aura.hasRim === true, String(aura.boxShadow).slice(0, 60));
check('③ 色散边缘（红/蓝错位内阴影）在', aura.hasDisp === true);
check('⑤ 内容调色层在（用的就是这块玻璃那一份色）', aura.tintInPaint === true, String(aura.tints[0]?.tint ?? ''));
check('★ 不同位置的玻璃取到**不同**颜色（内容适应性真的在动）', aura.distinctTints >= 2, `${aura.distinctTints} 种`);
check('② 高光位置有值', /%/.test(String(aura.gx)), String(aura.gx));
check('GL 流体背景起了', aura.glCanvas !== null && aura.glCanvas[0] > 100, aura.glCanvas ? `${aura.glCanvas[0]}×${aura.glCanvas[1]}` : '无');
check('★ GL 背景在动（1.5 秒后那两张不一样）', auraBg !== auraBg2 && auraBg.length > 0);

/* ---------- 折射的**单独**代价：同一屏，只把 url(#…) 摘掉再量一次 ---------- */
const noLensAfter = await setLensDisabled(true);
const auraNoLens = await frameTimes();
const noLensStat = report({ ...aura, backdrop: noLensAfter, surfaces: aura.surfaces }, auraNoLens);
await setLensDisabled(false);
console.log(
  `   → 折射让它多花 ${(auraPerfStat.avg - noLensStat.avg).toFixed(1)}ms/帧（平均 ${auraPerfStat.avg.toFixed(1)} → ${noLensStat.avg.toFixed(1)}）`,
);
check('帧时间没有明显掉帧（p95 < 40ms）', auraPerfStat.p95 < 40, `p95 ${auraPerfStat.p95.toFixed(1)}ms`);

/* ====================== 适中档 ====================== */
console.log('\n=== 适中视效（mid）===');
await setLevel('mid');
const mid = await snapshot();
const midPerf = await frameTimes();
const midPerfStat = report(mid, midPerf);
const midClip = await cardClip();
await shoot('mid-全窗');
if (midClip) await shoot('mid-卡片特写', midClip);
const midBg = await shoot('mid-背景区', await bgClip());

check('档位属性 = mid', mid.level === 'mid', String(mid.level));
check('不起 GL 背景（只有灵动档才起）', mid.glCanvas === null, mid.glCanvas ? '竟然起了' : '');
check(
  '够格的机器上适中档**仍有折射**（材质是连续的，不是断层）',
  aura.lensAttr === 'on' ? String(mid.backdrop).includes('url("#ieml-lens-') : true,
  String(mid.lensId ?? '无'),
);
check('⑤ 适中档也调色', mid.tintInPaint === true, String(mid.tints[0]?.tint ?? ''));
check('★ 灵动档的背景与适中档**不一样**（换了实现，不是同一张图）', auraBg !== midBg, auraBg === midBg ? '两张背景区截图完全相同' : '');
check('帧时间不差于灵动档太多（p95 < 33ms）', midPerfStat.p95 < 33, `p95 ${midPerfStat.p95.toFixed(1)}ms`);

/* ====================== 弱化档 ====================== */
console.log('\n=== 弱化视效（weak）===');
await setLevel('weak');
const weak = await snapshot();
const weakPerf = await frameTimes();
const weakPerfStat = report(weak, weakPerf);
await shoot('weak-全窗');

check('档位属性 = weak', weak.level === 'weak', String(weak.level));
check('★ 平玻璃：卡片 backdrop-filter 是 none', String(weak.backdrop) === 'none', String(weak.backdrop));
check('★ 弱化档连**标题条**的磨砂也关掉（不然会留一条糊的带子）', String(weak.phBackdrop) === 'none', String(weak.phBackdrop));
check('没有折射滤镜', weak.withLens === 0, `${weak.withLens} 块`);
check('没有 GL 背景', weak.glCanvas === null);
check('帧时间最省（p95 < 33ms）', weakPerfStat.p95 < 33, `p95 ${weakPerfStat.p95.toFixed(1)}ms`);

/* ====================== 收尾 ====================== */
console.log(`\n截图：${OUT}`);
console.log('（人眼复核：aura-卡片特写 与 mid-卡片特写 的边缘应有弯折与红蓝色边；weak-全窗 应是平面）');

await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
console.log(`\n===== ${failed === 0 ? '全部通过' : `${failed} 项失败`} =====`);
process.exit(failed === 0 ? 0 : 1);
