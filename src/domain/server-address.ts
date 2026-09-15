/**
 * 服务器地址的清洗与解析（ADR-044）
 * ------------------------------------------------------------------
 * ★ 源码事实（源码研读第 13.4 节，PCL2 的 `TextChanged`）：
 *   PCL2 在输入框里**自动把全角标点换成半角**。原因是中文输入法下打
 *   `mc.example.com：25565` 极其自然（冒号被输入法替换成全角 `：`），
 *   而游戏只认半角 —— 于是用户"明明输对了却连不上"，
 *   而且报错信息里看不出任何异常（地址看起来一模一样）。
 *
 * 这一条在本项目里是**纯收益**：它消灭一整类"输对了却连不上"的困惑，
 * 代价只是一次字符串映射。
 *
 * 规则只有一份（ADR-001）：Rust 侧 `game::server_address` 是同一套规则的实现，
 * 前端只负责在输入框里即时显示"我会用这个地址"。
 */

/** 转换结果：给用户看的一行说明 + 真正会传给游戏的 host/port */
export interface ServerAddress {
  /** 清洗后的完整地址（`host` 或 `host:port`）—— 玩家看到的也是这个 */
  normalized: string;
  /** 主机名（IPv4 / 域名 / IPv6 都原样保留） */
  host: string;
  /** 端口；没写或写坏了就是 null（由游戏用默认 25565） */
  port: number | null;
  /** 输入被改动过（全角标点等）—— 界面要明确提示，不能偷偷改 */
  changed: boolean;
  /** 非空但解析不出主机名时的原因；null = 没问题 */
  error: string | null;
}

/**
 * 全角 → 半角。
 *
 * 覆盖的是**中文输入法会打出来的那批**：
 *   * U+FF01..U+FF5E（！＂＃…～）整体减去 0xFEE0 就落到 ASCII 0x21..0x7E；
 *   * U+3000（全角空格）→ 普通空格；
 *   * 顺带处理几个常见的中文标点：`、`（U+3001）→ `,` 用不上，
 *     但 `。`（U+3002）在端口位置出现过（`host。25565`）→ `.`，
 *     `－`（U+FF0D，全角连字符）已在 FF01..FF5E 范围内。
 */
export function toHalfWidth(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x3000) {
      out += ' ';
    } else if (code === 0x3002) {
      // 句号：只在地址里被误用时才有意义，替换成点比保留全角句号合理
      out += '.';
    } else if (code >= 0xff01 && code <= 0xff5e) {
      out += String.fromCharCode(code - 0xfee0);
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * 清洗用户输入的服务器地址。
 *
 * 容错顺序：
 *   ① 全角 → 半角（这一条是重点）
 *   ② 去掉首尾空白与全角空格、去掉协议前缀（有人会粘 `mc.example.com` 或
 *      `https://…`；后者其实不对，但把协议去掉比让它整个失败好）
 *   ③ 去掉路径 / 查询串（`host:25565/play` 里的 `/play` 游戏不认）
 *   ④ 拆端口：**按最后一个冒号拆**（域名里不会有冒号，IPv6 里全是冒号，
 *      按最后一个拆是唯一能同时照顾两者的做法）
 *   ⑤ 端口必须是 1..65535 的整数；不是的话**保留原样不解析**，
 *      并在 `error` 里说清楚 —— 见下面的"为什么端口坏了不直接丢掉"。
 *
 * ★ 为什么端口写坏时仍然返回原文：
 *   如果 `host:abc` 被我们"好心"改成 `host`，用户会连到默认的 25565，
 *   然后在一个**完全不同的服务器**上发现自己是陌生人。
 *   宁可原样传下去让游戏自己报错，也不要悄悄换目标。
 */
export function parseServerAddress(raw: string): ServerAddress {
  const original = raw ?? '';
  let text = toHalfWidth(original).trim();

  // ② 协议前缀（只在看起来像 URL 时去掉）
  let changed = text !== original;
  const proto = /^[a-z][a-z0-9+.-]*:\/\//i.exec(text);
  if (proto) {
    text = text.slice(proto[0].length);
    changed = true;
  }
  // ③ 路径 / 查询 / 片段
  const cut = text.search(/[/?#]/);
  if (cut >= 0) {
    text = text.slice(0, cut);
    changed = true;
  }
  text = text.trim();

  if (text.length === 0) {
    return {
      normalized: '',
      host: '',
      port: null,
      changed,
      error: null, // 空 = 没设置，不是错误
    };
  }

  // ④ 端口：按最后一个冒号拆
  const colon = text.lastIndexOf(':');
  if (colon < 0) {
    return { normalized: text, host: text, port: null, changed, error: null };
  }
  const host = text.slice(0, colon);
  const portText = text.slice(colon + 1).trim();

  if (host.length === 0) {
    return {
      normalized: text,
      host: '',
      port: null,
      changed,
      error: `「${text}」缺少主机名（冒号前面是空的）`,
    };
  }
  if (!/^\d+$/.test(portText)) {
    return {
      normalized: text,
      host,
      port: null,
      changed,
      // 明确说出"我们没有替你改地址"，否则用户会以为端口已经没用了
      error: `端口「${portText}」不是数字。地址会原样传给游戏，不会自动改成默认端口。`,
    };
  }
  const port = Number(portText);
  if (port < 1 || port > 65535) {
    return {
      normalized: text,
      host,
      port: null,
      changed,
      error: `端口 ${port} 超出范围（1–65535）。地址会原样传给游戏。`,
    };
  }
  return {
    normalized: `${host}:${port}`,
    host,
    port,
    changed,
    error: null,
  };
}

/** 输入框下方那行说明（`null` = 不需要提示） */
export function serverAddressHint(raw: string): { tone: 'ok' | 'fix' | 'warn'; text: string } | null {
  const rawText = (raw ?? '').trim();
  if (rawText.length === 0) return null;
  const parsed = parseServerAddress(rawText);
  if (parsed.error) return { tone: 'warn', text: parsed.error };
  if (parsed.changed) {
    return {
      tone: 'fix',
      text: `已自动把全角字符换成半角：${parsed.normalized}`,
    };
  }
  if (parsed.port === null) {
    return { tone: 'ok', text: `将连接 ${parsed.host}（默认端口 25565）` };
  }
  return { tone: 'ok', text: `将连接 ${parsed.normalized}` };
}
