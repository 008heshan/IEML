/*
 * 真机判据：拖拽的**界面那一半** —— 提示语、路由、以及 ADR-015 那个"要不要现在装"。
 *
 * ## 为什么还要这一条（命令层已经验过了）
 *
 *   `live-drop-check.mjs` 验的是命令：判得对、装到对的目录、该提醒的带 note。
 *   但用户看见的是**界面**，而界面与命令之间那一段（`AppShell` 的 handleDrop）
 *   恰好是最容易坏的地方：note 拿到了却没人显示、装了却弹一句"没装成"、
 *   拖进来三样东西只有一样有反应 —— 这些都是"命令全对、用户全错"。
 *
 * ## 怎么在没有鼠标的情况下验
 *
 *   用**原生拖放事件本身**：`getCurrentWebview().onDragDropEvent()` 监听的是
 *   Tauri 的事件总线上那个 `tauri://drag-drop`。所以从页面里把同一个事件**发回去**，
 *   走的就是真实那条链路（不是替身、也不是 mock）。
 *
 *   ★ 先说清它的边界：这样发的**不是**操作系统的拖放，验不出"Rust 有没有把系统的
 *     拖放转成这个事件"（那一段由 Tauri 自己保证，我们改不了也不该测）。
 *     它验的是**事件之后的每一步**：分类 → 装 → 提示 → 路由。
 *
 * 用法：
 *   node tools/live/live-drop-ui-check.mjs ["<exe>"]
 * 退出码：0 = 判据全过；1 = 有判据不成立
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { clickNav, launch, sleep } from './lib/cdp.mjs';

const argv = process.argv.slice(2);
const EXE =
  argv.find((a) => !a.startsWith('--')) ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');

const T = process.env.TEMP ?? '.';
const ROOT = path.join(T, 'ieml-dropui-root');
const OWN = path.join(T, 'ieml-dropui-own');
const SRC = path.join(T, 'ieml-dropui-src');
const SLUG = 'dropui';
const NAME = '拖拽界面探针';

let pass = 0;
let fail = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? '  —— ' + extra : ''}`);
  if (ok) pass += 1;
  else fail += 1;
};

/* ---------- 样本：一个真 zip（stored），与命令层探针同源 ---------- */
function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function makeZip(entries) {
  const enc = (s) => Buffer.from(s, 'utf8');
  const parts = [];
  const central = [];
  let offset = 0;
  for (const name of entries) {
    const nb = enc(name);
    const data = enc('ieml');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nb.length, 26);
    parts.push(local, nb, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nb.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nb]));
    offset += local.length + nb.length + data.length;
  }
  const cdb = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(cdb.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdb, eocd]);
}

/* ---------- 沙盒 ---------- */
for (const d of [ROOT, OWN, SRC]) rmSync(d, { recursive: true, force: true });
mkdirSync(SRC, { recursive: true });
mkdirSync(OWN, { recursive: true });
const GAME = path.join(ROOT, 'instances', SLUG, 'game');
for (const sub of ['mods', 'resourcepacks', 'shaderpacks']) {
  mkdirSync(path.join(GAME, sub), { recursive: true });
}
const VER = path.join(ROOT, '.minecraft', 'versions', 'fabric-loader-0.15.0-1.20.1');
mkdirSync(VER, { recursive: true });
/*
 * ★★ 必须在**共享目录**里放一个"**加载器**版本"的目录，实例才认领得到它。
 *   认领规则（`src/domain/folder-versions.ts`）：`mcVersion` 相同 **且**
 *   "是不是加载器版本"相同 —— 而"是不是加载器版本"是**按目录名**认的。
 *   第一版探针只写了一个原版 `1.20.1` 目录，而实例是 Fabric 的 ⇒ 认领不到
 *   ⇒ 版本列表里没有那一行 ⇒ 界面永远打不开实例 ⇒ 后面 8 条判据全红，
 *   而那 8 条红**一条都与拖拽无关**（同 live-backup-check 里记的那次教训）。
 */
writeFileSync(
  path.join(VER, 'fabric-loader-0.15.0-1.20.1.json'),
  JSON.stringify({
    id: 'fabric-loader-0.15.0-1.20.1',
    inheritsFrom: '1.20.1',
    mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
    libraries: [],
  }),
);
writeFileSync(path.join(VER, 'fabric-loader-0.15.0-1.20.1.jar'), Buffer.alloc(1024, 3));
writeFileSync(
  path.join(OWN, 'instances.json'),
  JSON.stringify(
    {
      instances: [
        {
          id: 'i-dropui',
          mcVersion: '1.20.1',
          /*
           * ★ `mcVersion` 是**必填**的（`LoaderRecord` 里那个字段）。
           *   第一版只写了 `kind` / `version`，启动器当场如实报
           *   「实例列表损坏：missing field `mcVersion`」并把列表显示成空的 ——
           *   又是一条"量法错了、量出来的红跟功能无关"。命令层那两条探针
           *   （classify/install）不看实例列表，所以它们没被这一点绊住。
           */
          loader: { kind: 'fabric', version: '0.15.0', mcVersion: '1.20.1' },
          addons: [],
          config: {
            name: NAME,
            slug: SLUG,
            isolation: 'auto',
            memoryMb: 2048,
            memorySource: 'global',
            javaMode: 'auto',
          },
          createdAt: null,
          lastPlayedAt: null,
          totalPlaySeconds: 0,
        },
      ],
      activeId: 'i-dropui',
    },
    null,
    2,
  ),
);

const MOD = path.join(SRC, 'sodium.jar');
writeFileSync(MOD, makeZip(['fabric.mod.json']));
const SHADER = path.join(SRC, '光影.zip');
writeFileSync(SHADER, makeZip(['pack.mcmeta', 'shaders/shadow.fsh']));
const JUNK = path.join(SRC, '说明.zip');
writeFileSync(JUNK, makeZip(['readme.txt']));

/* ---------- 开跑 ---------- */
const { ev, pid, ws } = await launch({
  exe: EXE,
  tag: 'dropui',
  env: { IEML_DATA_DIR: ROOT, IEML_OWN_DIR: OWN },
  keepDataDir: true,
  settleMs: 3500,
});

/** 把**原生那条事件**发回去（走的就是真实链路） */
const fireDrop = async (paths) => {
  const r = await ev(
    `window.__TAURI_INTERNALS__.invoke('plugin:event|emit', ${JSON.stringify({
      event: 'tauri://drag-drop',
      payload: { type: 'drop', paths, position: { x: 400, y: 300 } },
    })}).then(()=>'ok').catch((e)=>'ERR '+String(e))`,
  );
  console.log(`  · 派发拖放事件 ${JSON.stringify(paths)} → ${r}`);
  return r;
};

/** 界面上现在有哪些 toast（标题 + 正文），以及有没有弹窗 */
const uiState = () =>
  ev(`(() => {
    const toasts = [...document.querySelectorAll('.toast')].map((t) => ({
      title: (t.querySelector('.toast-t')?.textContent || '').trim(),
      desc: (t.querySelector('.toast-d')?.textContent || '').trim(),
    }));
    const modal = document.querySelector('.modal');
    return {
      toasts,
      modal: modal ? (modal.querySelector('.modal-title')?.textContent || '').trim() : null,
      modalText: modal ? (modal.textContent || '').slice(0, 300) : '',
    };
  })()`);

const clearToasts = () =>
  ev(
    `[...document.querySelectorAll('.toast .toast-x')].forEach((b) => b.click()); true`,
  );

/**
 * 等一条满足条件的 toast 出现（最多 `ms`）。
 *
 * ★ 为什么不"派发完 sleep 固定毫秒再查"：第一版就是这么写的，结果**时有时无**
 *   （同一份代码，第 ① 步查得到、第 ② 步查不到）。提示是异步来的（分类要读盘、
 *   装完还要写文件），固定等待等于把判据押在"这台机器当时有多快"上 ——
 *   探针要么漏报要么偶发红。"等到出现"才是它真正想说的意思。
 */
async function waitForToast(pred, ms = 6000) {
  const deadline = Date.now() + ms;
  let last = [];
  while (Date.now() < deadline) {
    const st = await uiState();
    last = st.toasts ?? [];
    const hit = last.find((t) => pred(t));
    if (hit) return { hit, all: last };
    await sleep(300);
  }
  return { hit: null, all: last };
}

/** 等弹窗出现（同理：别押在固定毫秒上） */
async function waitForModal(pred, ms = 6000) {
  const deadline = Date.now() + ms;
  let last = null;
  while (Date.now() < deadline) {
    const st = await uiState();
    last = st.modal;
    if (last && pred(last, st.modalText || '')) return { modal: last, text: st.modalText || '' };
    await sleep(300);
  }
  return { modal: null, text: '' };
}

try {
  /*
   * ★★ 必须先**打开一个版本**：拖进来的四类资源都要装进"当前那个版本"，
   *   没有它界面会如实说"要先打开一个版本"（第一版探针就栽在这里 ——
   *   量出来的 8 条红全都与功能无关，全是量法错了）。
   *   `activeId` 在 instances.json 里**不等于**"界面上打开了它"。
   */
  await clickNav(ev, '版本列表');
  await sleep(1500);
  const diag = await ev(`JSON.stringify({
    navCount: document.querySelectorAll('.nav-item').length,
    empty: (document.body.innerText || '').includes('这个文件夹里没有可用的版本'),
    rows: document.querySelectorAll('.ver-row, .list-row, .inst-row').length,
    aria: [...document.querySelectorAll('button[aria-label]')].map((x) => x.getAttribute('aria-label')),
    head: (document.querySelector('main')?.innerText || '').slice(0, 200),
  })`);
  console.log('  诊断：' + diag);
  const backend = await ev(`(async () => {
    const inv = window.__TAURI_INTERNALS__.invoke;
    try {
      const fv = await inv('folder_versions');
      const ins = await inv('list_instances');
      return JSON.stringify({ fv, ins: Array.isArray(ins) ? ins.length : ins });
    } catch (e) { return 'ERR ' + String(e); }
  })()`);
  console.log('  后端说：' + backend);
  const rows = await ev(`JSON.stringify([...document.querySelectorAll('button[aria-label]')].map((x)=>x.getAttribute('aria-label')))`);
  console.log('  版本列表里的按钮 aria-label：' + rows);
  await ev(`(() => {
    const b = document.querySelector('button[aria-label^=${JSON.stringify(NAME)}]');
    b?.click();
    return !!b;
  })()`);
  await sleep(800);
  const menuBtn = await ev(`(() => {
    const all = [...document.querySelectorAll('button')].filter((x) => x.offsetParent !== null);
    return JSON.stringify(all.map((x) => (x.textContent || '').trim()).filter(Boolean).slice(0, 30));
  })()`);
  console.log('  点开更多操作后可见的按钮：' + menuBtn);
  await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(
      (x) => (x.textContent || '').trim().includes('打开设置') && x.offsetParent !== null,
    );
    b?.click();
    return !!b;
  })()`);
  await sleep(2500);

  // 确认"当前打开的是哪个版本"这件事成立：没有它，装资源会被如实拒绝
  const opened = await ev(`(document.body.innerText || '').includes(${JSON.stringify(NAME)})`);
  check(opened === true, '① 已经打开探针那个实例（后面的判据才有意义）');

  /* ---------- 装一个 Mod：应当有"已装进去"、且**没有**提醒 ---------- */
  await clearToasts();
  await fireDrop([MOD]);
  let r = await waitForToast((t) => t.title.includes('已装进去'));
  check(r.hit !== null, '② 拖一个 Mod：界面报"已装进去"', JSON.stringify(r.all));
  check(
    !r.all.some((t) => (t.desc || '').includes('加载器')),
    '② 有加载器的版本装 Mod：**不**出现"放进去也不会被读取"的提醒',
    JSON.stringify(r.all),
  );
  check((await uiState()).modal === null, '② 装 Mod 不弹窗（没有要问的事）');

  /* ---------- 装一个认不出来的：应当说清是哪个文件、为什么 ---------- */
  await clearToasts();
  await fireDrop([JUNK]);
  r = await waitForToast((t) => t.title.includes('没装成'));
  check(
    r.hit !== null && (r.hit.desc || '').includes('说明.zip'),
    '③ 认不出来的文件：报"没装成"并点名是哪个文件',
    JSON.stringify(r.all),
  );

  /* ---------- 装一个光影：应当有提醒 + **弹出问句**（ADR-015） ---------- */
  await clearToasts();
  await fireDrop([SHADER]);
  r = await waitForToast((t) => t.title.includes('已装进去'));
  check(r.hit !== null, '④ 拖一个光影：界面报"已装进去"', JSON.stringify(r.all));
  const m = await waitForModal((title) => title.includes('光影包已放好'));
  check(m.modal !== null, '④ 这个版本没有 Iris/OptiFine → **弹出问句**（ADR-015 的"是否现在安装"）', String(m.modal));
  check(
    /Iris|Oculus/.test(m.text),
    '④ 问句里说清要装的是什么（有加载器 → Iris/Oculus）',
    m.text.slice(0, 160),
  );

  // 关掉弹窗：点"以后再说"，确认它真的会关（不是个关不掉的窗）
  await ev(
    `[...document.querySelectorAll('.modal button')].find((b) => (b.textContent||'').includes('以后再说'))?.click(); true`,
  );
  await sleep(600);
  check((await uiState()).modal === null, '④ 「以后再说」能关掉问句');

  /* ---------- 拖一个目录：一次装两个，且顺序不吞东西 ---------- */
  await clearToasts();
  const DIR = path.join(SRC, '一包东西');
  mkdirSync(DIR, { recursive: true });
  writeFileSync(path.join(DIR, 'a.jar'), makeZip(['fabric.mod.json']));
  writeFileSync(path.join(DIR, 'b.zip'), makeZip(['pack.mcmeta', 'assets/x/y.json']));
  writeFileSync(path.join(DIR, 'readme.txt'), 'x');
  await fireDrop([DIR]);
  const okDir = await waitForToast((t) => t.title.includes('已装进去'));
  check(
    (okDir.hit?.title || '').includes('2'),
    '⑤ 拖一个目录：报"已装进去 2 个"',
    JSON.stringify(okDir.all),
  );
  const badDir = await waitForToast((t) => t.title.includes('没装成'));
  check(
    badDir.hit !== null && (badDir.hit.desc || '').includes('readme.txt'),
    '⑤ 同一批里没装成的那个**也说了**（不静默丢掉）',
    JSON.stringify(badDir.all),
  );
} finally {
  console.log(`\n${fail === 0 ? '全过' : '有不合格项'}：${pass} 过 / ${fail} 不过`);
  try {
    ws.close();
  } catch {}
  const { spawnSync } = await import('node:child_process');
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  process.exit(fail === 0 ? 0 : 1);
}
