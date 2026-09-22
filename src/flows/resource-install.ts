/**
 * 装一个资源版本的**唯一实现**（C5 抽出来的）。
 *
 * ## 为什么要抽
 *
 *   这段逻辑原来长在 `ResourceBrowser` 里（内联展开的卡片上）。C5 要给它一个
 *   **独立页面**（用户："给这些资源点击安装时单独建页面"），如果页面里再抄一遍，
 *   就会出现"两套安装规则"——而这个仓库已经吃过好几次"规则写两份然后分叉"的亏
 *   （服务器地址规则表、加载器能力表、皮肤坐标…都栽过）。
 *
 *   所以：**判断与调用留在这里一份**，界面只负责把结果变成 toast。
 *
 * ## 这里管什么、不管什么
 *
 *   管：能不能装（作者是否禁止第三方分发 / 有没有文件 / 文件有没有下载地址）、
 *       真的去装（`installResource`）、把结果原样返回。
 *   不管：toast 文案、按钮 loading、装完之后刷新列表 —— 那些是界面的事。
 */
import type { ModrinthHit, ModrinthVersion, ResourceKindName } from '../bridge/tauri';

/** 装不成的**原因**（界面据此决定说什么话，而不是在这里拼 toast） */
export type InstallRefusal =
  | { kind: 'forbidden'; pageUrl: string | null }
  | { kind: 'no-file' }
  | { kind: 'no-url' }
  | { kind: 'no-instance' };

export type InstallOutcome =
  | { ok: true; path: string; note: string | null; versionLabel: string; display: string }
  | { ok: false; refusal: InstallRefusal };

export interface InstallResourceArgs {
  api: {
    modrinth: {
      installResource: (
        kind: ResourceKindName,
        url: string,
        filename: string,
        instanceSlug: string,
        sha1?: string,
      ) => Promise<string>;
    };
  };
  kind: ResourceKindName;
  hit: ModrinthHit;
  version: ModrinthVersion;
  /** 装到哪个实例（slug） */
  instanceSlug: string | null;
  /** 「装到哪里」的那句人话（`current.display`，由调用方给） */
  display: string;
  /** 安装说明（有些资源还要再走一步） */
  installNote?: string | null;
}

export async function installResourceVersion(args: InstallResourceArgs): Promise<InstallOutcome> {
  const { api, kind, hit, version, instanceSlug, display, installNote } = args;

  if (!instanceSlug) return { ok: false, refusal: { kind: 'no-instance' } };

  /*
   * ★ 作者禁止第三方分发（CurseForge 专有）→ **提前拦住并说清原因**。
   *   `distribution_allowed === false` 表示作者在 CurseForge 上关掉了
   *   "允许第三方分发"，那种项目的文件 `downloadUrl` 是 null。
   */
  if (hit.distribution_allowed === false) {
    return { ok: false, refusal: { kind: 'forbidden', pageUrl: hit.page_url ?? null } };
  }

  const file = version.files.find((f) => f.primary) ?? version.files[0];
  if (!file) return { ok: false, refusal: { kind: 'no-file' } };
  if (!file.url) return { ok: false, refusal: { kind: 'no-url' } };

  const path = await api.modrinth.installResource(
    kind,
    file.url,
    file.filename,
    instanceSlug,
    file.hashes?.sha1,
  );
  return {
    ok: true,
    path,
    note: installNote ?? null,
    versionLabel: version.version_number || version.name || '',
    display,
  };
}
