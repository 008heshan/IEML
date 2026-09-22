/**
 * 真机验证：**九套主题**（2026-09-22 用户要求）。
 *
 * 静态测试（`tests/theme-tokens.test.mjs`）只能验"CSS 里的颜色对不对"；
 * 这一条验**换上去之后真的生效**：
 *   ① 点每一套的色板 → `<html data-theme>` 跟着变、背景色真的换成那一套；
 *   ② 对比度**在浏览器里复算**（用 getComputedStyle 得到的实际值，
 *      不是我们解析 CSS 得到的 —— 万一有继承/覆盖，只有这一条抓得到）；
 *   ③ 玻璃与光斑跟着主题走（`--glass-tint` 的采样色、`--ambient-*` 实际值）；
 *   ④ 换完能**持久化**（写进 prefs.json，重启还在）；
 *   ⑤ 每套截图存档，供人眼复核。
 *
 * 用法：node tools/live/live-theme-check.mjs ["<exe>"]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';

const PORT = 9721;
const EXE = process.argv[2] ?? path.join('src-tauri', 'target', 'debug', 'ieml.exe');
const OUT = path.join(process.env.TEMP ?? '.', 'ieml-themes');
const PROFILE = path.join(process.env.TEMP ?? '.', 'ieml-themes-prof');
if (!existsSync(EXE)) {
  console.error('找不到：' + EXE);
  process.exit(2);
}
rmSync(OUT, { recursive: true, force: true });
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (s) =>
  new Promise((res) => {
    const p = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', s], { stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '';
    p.stdout.on('data', (d) => (o += d));
    p.stderr.on('data', (d) => (o += d));
    p.on('close', () => res(o.trim()));
  });

/** 读注册表（主题清单）—— 与测试同源，避免两处写死 */
function registry() {
  const ts = readFileSync('src/ui/theme.ts', 'utf8');
  const out = [];
  const dark = /\{\s*id:\s*'dark',\s*label:\s*'([^']+)',[\s\S]*?bg:\s*'([^']+)',\s*accent:\s*'([^']+)'/.exec(ts);
  if (dark) out.push({ id: 'dark', label: dark[1], bg: dark[2], accent: dark[3] });
  const re = /\{\s*id:\s*'([a-z]+)',\s*label:\s*'([^']+)',\s*hint:\s*'([^']+)',\s*bg:\s*'([^']+)',\s*accent:\s*'([^']+)'\s*\}/g;
  let m;
  while ((m = re.exec(ts))) out.push({ id: m[1], label: m[2], bg: m[4], accent: m[5] });
  return out;
}

await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
await sleep(900);
const app = spawn(EXE, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`, WEBVIEW2_USER_DATA_FOLDER: PROFILE },
  stdio: 'ignore',
});
let page = null;
for (let i = 0; i < 60; i += 1) {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`); page = (await r.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl); if (page) break; } catch {}
  await sleep(500);
}
if (!page) { console.error('连不上 CDP'); await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`); process.exit(2); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0; const pend = new Map(); const errors = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') { const d = m.params?.exceptionDetails; errors.push(String(d?.exception?.description ?? d?.text ?? '?').split('\n')[0]); }
});
const send = (method, params) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text }; return r.result?.result?.value; };
const shoot = async (tag) => { const r = await send('Page.captureScreenshot', { format: 'png' }); const f = path.join(OUT, `${tag}.png`); if (r.result?.data) writeFileSync(f, Buffer.from(r.result.data, 'base64')); return f; };
await send('Runtime.enable', {});

let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? '✓' : '✗'} ${name}${extra ? `  —— ${extra}` : ''}`); if (!ok) failed += 1; };
const waitApp = async () => { for (let i = 0; i < 60; i += 1) { if ((await ev(`!!document.querySelector('.nav-item')`)) === true) return true; await sleep(400); } return false; };

for (let i = 0; i < 60; i += 1) { if ((await ev(`!!document.querySelector('.nav-item')`)) === true) break; await sleep(400); }
await waitApp();
await ev(`[...document.querySelectorAll('.nav-item')].find((b) => (b.textContent || '').includes('设置'))?.click()`);
await sleep(1800);
await ev(`document.querySelectorAll('.toast').forEach((t) => t.remove())`);

const themes = registry();
console.log(`注册表里 ${themes.length} 套主题：${themes.map((t) => t.label).join(' / ')}\n`);

/* 色板按钮在页面上吗 */
const swatches = await ev(`document.querySelectorAll('.theme-swatch').length`);
check('设置页有九宫格色板', swatches === themes.length, `${swatches} 个`);

/** 浏览器里复算对比度（用真实计算值） */
const readTheme = () =>
  ev(`(() => {
    const cs = getComputedStyle(document.documentElement);
    /*
     * ★ 颜色值可能是 hex（--bg-base 就是 #12151a）也可能是 rgb()/rgba()。
     *   最稳的归一化办法：丢给浏览器自己解析 —— 临时元素设上颜色，
     *   读回 getComputedStyle().color 一律是 rgb(...)。
     *   （第一版直接正则抓数字，于是 hex 被读成 [12151]，对比度全是 null。）
     */
    const rgb = (v) => {
      const el = document.createElement("span");
      el.style.color = String(v).trim();
      document.body.appendChild(el);
      const c = getComputedStyle(el).color;
      el.remove();
      return (c.match(/[\\d.]+/g) || []).slice(0, 3).map(Number);
    };
    const lum = (c) => {
      const f = (x) => { const t = x / 255; return t <= 0.03928 ? t / 12.92 : Math.pow((t + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    };
    const cr = (a, b) => { const l = [lum(a), lum(b)].sort((x, y) => y - x); return (l[0] + 0.05) / (l[1] + 0.05); };
    const base = rgb(cs.getPropertyValue('--bg-base'));
    const bodyBg = rgb(getComputedStyle(document.body).backgroundColor);
    const card = document.querySelector('.glass');
    const cardCs = card ? getComputedStyle(card) : null;
    return {
      attr: document.documentElement.dataset.theme,
      base: cs.getPropertyValue('--bg-base').trim(),
      accent: cs.getPropertyValue('--accent').trim(),
      bodyBg: getComputedStyle(document.body).backgroundColor,
      accentOnBase: +cr(rgb(cs.getPropertyValue('--accent')), base).toFixed(2),
      primaryOnBase: +cr(rgb(cs.getPropertyValue('--text-primary')), base).toFixed(2),
      secondaryOnBase: +cr(rgb(cs.getPropertyValue('--text-secondary')), base).toFixed(2),
      ambientViolet: cs.getPropertyValue('--ambient-violet').trim(),
      glassTint: card ? card.style.getPropertyValue('--glass-tint').trim() : null,
      glassBackdrop: cardCs ? String(cardCs.backdropFilter).slice(0, 34) : null,
    };
  })()`);

const first = await readTheme();
console.log(`起手：data-theme=${first.attr} · 底 ${first.base} · 主色 ${first.accent} · 正文对比 ${first.primaryOnBase}`);

for (const t of themes) {
  const clicked = await ev(`(() => {
    const b = [...document.querySelectorAll('.theme-swatch')].find((x) => (x.getAttribute('aria-label') || '') === ${JSON.stringify(t.label)});
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await sleep(900);
  const s = await readTheme();
  await shoot(`主题-${t.id}-${t.label}`);
  console.log(
    `  ${t.label.padEnd(3)} attr=${String(s.attr).padEnd(8)} 底=${String(s.base).padEnd(8)} 主色=${String(s.accent).padEnd(8)}` +
      ` 正文 ${s.primaryOnBase} / 次要 ${s.secondaryOnBase} / 主色 ${s.accentOnBase} · 玻璃调色 ${s.glassTint || '—'}`,
  );
  check(`  ${t.label}｜色板点得到`, clicked === true);
  check(`  ${t.label}｜data-theme 与背景色都换了`, s.attr === t.id && String(s.base).toLowerCase() === t.bg.toLowerCase(), `${s.attr} / ${s.base}`);
  check(
    `  ${t.label}｜对比度达标（正文≥7 次要≥4.5 主色≥4.5）`,
    s.primaryOnBase >= 7 && s.secondaryOnBase >= 4.5 && s.accentOnBase >= 4.5,
    `${s.primaryOnBase} / ${s.secondaryOnBase} / ${s.accentOnBase}`,
  );
  check(`  ${t.label}｜玻璃仍挂着模糊`, String(s.glassBackdrop).includes('blur'), String(s.glassBackdrop));
}

/* 持久化：prefs.json 里应当记的是最后那套 */
const last = themes[themes.length - 1];
const prefsPath = await ev(`window.__IEML_DATA_DIR__ ?? null`).catch(() => null);
const dataDir = (await ev(`(() => (window.__IEML_DATA_DIR__ || null))()`)) ?? 'D:\\IEML';
const prefsFile = path.join(typeof dataDir === 'string' ? dataDir : 'D:\\IEML', 'prefs.json');
let saved = null;
try { saved = JSON.parse(readFileSync(prefsFile, 'utf8')).theme ?? null; } catch {}
console.log(`\nprefs.json 里的 theme = ${saved}（期望 ${last.id}）`);
check('★ 换主题会持久化（重启后还在）', saved === last.id, `${saved}`);

check('全程没有异常', errors.length === 0, errors.slice(0, 2).join(' | '));
console.log(`\n截图：${OUT}`);
await ps(`Get-Process ieml -ErrorAction SilentlyContinue | Stop-Process -Force`);
console.log(`\n===== ${failed === 0 ? '全部通过' : `${failed} 项失败`} =====`);
process.exit(failed === 0 ? 0 : 1);
