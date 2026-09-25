/*
 * 门禁：**被跟踪的文件里不许出现密钥类内容**。
 *
 * ## 为什么要有这条（它是这次"公开化清理"的直接产物）
 *
 * 2026-09-25 准备把仓库转公开时，发现 `src-tauri/src/net/curseforge.rs` 里
 * **内置着一把用户的真实 CurseForge API Key** —— 而且它从**初始提交 `f71c91c`**
 * 起就在 git 历史里。这不是"某次手滑"，而是当初 ADR-052 的**有意取舍**
 * （"拿到 exe 就能用"）：代价当时也写进了 ADR，但**没有任何判据守着它**。
 *
 * 于是它活了 12 天、穿过 20 多轮改动、**没有一次红过**，直到有人为了"转公开"
 * 把全部文档与源码通读一遍才被发现。**靠人眼通读才能发现的问题，一定会复发。**
 *
 * ## 判据（宁窄勿宽：只抓"形状确定"的东西，不猜）
 *
 *   ① CurseForge 的 key 形状：`$2a$10$` 开头 + 一长串（这是它的真实格式）；
 *   ② PEM 私钥/公钥块：`-----BEGIN … PRIVATE KEY-----`；
 *   ③ `client_secret` 之类的赋值（OAuth 机密）；
 *   ④ GitHub token、CNB 发布令牌的常见形状。
 *
 *   这四条**红了就退出码 1**（公开前必须处理）。
 *
 * ## 另外一类：本机路径（**只提示，不判失败**）
 *
 *   `C:\Users\<名字>` 这类工作台信息不属于"密钥"，而且这个仓库里它几乎全在
 *   **历史记录**里（`CHANGELOG` 按项目铁律**不许改写**：发布过的不算数）。
 *   把一条"改不动的历史"做成硬失败，只会让门禁失去意义（红着红着就没人看了）。
 *   所以对它们**只打印一份清单**，处置写在
 *   `docs/CLEANUP-PLAN-2026-09-25.md` 的公开前审计那一节。
 *
 * ## 允许的例外（都写在这里，而不是靠"跳过整个文件"）
 *
 *   · 测试里的**假** key：`$2a$10$CUSTOMKEY…` / `$2a$10$SECRET…` 这类重复串；
 *   · 文档里说明"key 长这样"的**形状示例**（同样用重复串或占位）；
 *   · `tools/` 下的探针读**环境变量**（`process.env.…`）—— 那正是"不落盘"的做法。
 *
 * 用法：node tools/gates/check-secrets.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

/** 只扫**被 git 跟踪**的文件 —— 那才是会随仓库公开出去的东西 */
function tracked() {
  /*
   * ★ 这台机器上 `git` **不在默认 PATH 里**（用便携版），而门禁不该假设它在 ——
   *   2026-09-25 实测：跑 `verify` 的环境里没有 git，这条门禁直接 ENOENT 红掉，
   *   看起来像"发现了密钥"，其实只是**找不到 git**。所以先试 PATH，
   *   失败再探几个常见位置；都找不到才报错，并把话说清（别伪装成"有密钥"）。
   */
  const candidates = ['git'];
  const la = process.env.LOCALAPPDATA ?? '';
  const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
  candidates.push(
    join(la, 'Programs', 'PortableGit', 'cmd', 'git.exe'),
    join(pf, 'Git', 'cmd', 'git.exe'),
    'C:\\Program Files\\Git\\cmd\\git.exe',
  );
  let lastErr = null;
  for (const bin of candidates) {
    try {
      return execFileSync(bin, ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
        .split('\0')
        .filter(Boolean);
    } catch (e) {
      lastErr = e;
      if (e.code === 'ENOENT') continue; // 这个位置没有 git，试下一个
      // 找到了 git 但它失败了（不在仓库里等）：直接报出来
      console.error('✗ git 跑不起来：' + e.message);
      process.exit(1);
    }
  }
  console.error(`✗ 找不到 git（试过 PATH 与 ${candidates.length - 1} 个常见位置）—— 本次检查**没有执行**，`);
  console.error('  不等于"没有密钥"。修：把 git 放进 PATH，或在本机装上 PortableGit。');
  console.error('  （最后一条错误：' + (lastErr?.message ?? '?') + '）');
  process.exit(1);
}

/** 明显的假值：连续重复的填充串，测试与文档示例都用它 */
const FAKE = /(CUSTOMKEY|SECRET|EXAMPLE|PLACEHOLDER|xxxx|XXXX|your[-_]?key|YOUR_KEY)/;

const RULES = [
  {
    id: 'curseforge-key',
    // CurseForge 的 key：$2a$10$ + 53 个 base64 字符（实测形状）
    re: /\$2a\$10\$[A-Za-z0-9./]{20,}/g,
    why: 'CurseForge 的 API Key 形状（内置 key 就是这么泄漏的）',
  },
  {
    id: 'pem-private-key',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
    why: 'PEM 私钥（更新签名私钥绝不能进仓库）',
  },
  {
    id: 'client-secret',
    re: /client[_-]?secret\s*[:=]\s*["'][^"']{8,}["']/gi,
    why: 'OAuth client_secret 赋值',
  },
  {
    id: 'gh-token',
    re: /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
    why: 'GitHub token',
  },
  {
    id: 'cnb-token',
    // CNB 的令牌是长串；这里只抓"看起来像被写死的赋值"，不抓读取环境变量的代码
    re: /CNB_TOKEN\s*[:=]\s*["'][A-Za-z0-9_-]{20,}["']/g,
    why: 'CNB 发布令牌被写死（它应当只从 git 凭据管理器或环境变量取）',
  },
];

/** ★ 只提示、不判失败的那一类（见头部说明：历史记录改不动，别做成硬失败） */
const SOFT_RULES = [
  {
    id: 'local-user-path',
    re: /C:\\Users\\[A-Za-z0-9._-]+/g,
    why: '本机用户目录路径（工作台信息；历史记录里的按"不许改写"保留）',
  },
];

const files = tracked();
const hits = [];
const soft = [];

for (const rel of files) {
  let text;
  try {
    text = readFileSync(rel, 'utf8');
  } catch {
    continue; // 二进制 / 读不了：跳过（密钥不会藏在 PNG 里）
  }
  const lines = text.split('\n');
  for (const rule of RULES) {
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      rule.re.lastIndex = 0;
      const m = rule.re.exec(line);
      if (!m) continue;
      if (FAKE.test(m[0])) continue; // 明显的假示例
      hits.push({ rule: rule.id, why: rule.why, file: rel, line: i + 1, found: m[0] });
    }
  }
  for (const rule of SOFT_RULES) {
    for (let i = 0; i < lines.length; i += 1) {
      rule.re.lastIndex = 0;
      const m = rule.re.exec(lines[i]);
      if (m) soft.push({ file: rel, line: i + 1, found: m[0] });
    }
  }
}

console.log(`  扫了 ${files.length} 个被跟踪的文件，硬规则 ${RULES.length} 条 / 提示规则 ${SOFT_RULES.length} 条`);

if (soft.length > 0) {
  const byFile = new Map();
  for (const s of soft) byFile.set(s.file, (byFile.get(s.file) ?? 0) + 1);
  console.log(`  · 提示：${soft.length} 处本机路径（不判失败，处置见 CLEANUP-PLAN 的公开前审计）`);
  for (const [f, n] of [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    console.log(`      ${f}  ×${n}`);
  }
}

for (const h of hits) {
  console.log(`  ✗ ${h.file}:${h.line}  [${h.rule}]  ${h.why}`);
  console.log(`      ${h.found.slice(0, 60)}`);
}

if (hits.length === 0) {
  console.log('  ✓ 没有发现密钥类内容');
  process.exit(0);
}

console.error('');
console.error(`✗ ${hits.length} 处可疑内容 —— 公开之前必须处理：`);
console.error('   · 真的密钥：立刻吊销它，再从源码里删掉（删代码不等于失效！）');
console.error('   · 假示例：把值改成连续重复串（CUSTOMKEY…），让它被 FAKE 规则放行');
console.error('   · 本机路径：改成相对路径或占位符');
console.error('');
process.exit(1);
