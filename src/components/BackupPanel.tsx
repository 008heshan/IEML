/**
 * 实例的「备份与回滚」面板（ADR-014）
 * ------------------------------------------------------------------
 * 放在**实例设置页**里，而不是版本列表上 —— 这是本仓库早就定过的：
 *   备份是**某个实例**的属性，一级页那一行不该再塞一张卡
 *   （见 `VersionsPage.tsx` 文件头"刻意删掉的东西"一节）。
 *
 * ## 这个面板刻意**不做**的三件事
 *
 * 1. **不自己拼"备份包含什么"**。范围（`saves/` `config/` `options.txt`
 *    `servers.dat`，Mod 只记清单）由后端给，界面只呈现 ——
 *    前端再写一份的话，以后改范围必然漏掉一边，
 *    而"界面说备份了、实际没备"是最坏的一种不一致。
 * 2. **不说"回滚会撤销一切"**。回滚只做两件事：把备份里的文件放回去、
 *    把多出来的 Mod 移出 `mods/`。**备份里没有的文件一个都不删**，
 *    所以"我今天新建的世界"回滚之后仍在盘上。报告里如实列出来。
 * 3. **不假装补齐 Mod**。清单里有、盘上没有的 jar，我们不会偷偷下回来 ——
 *    面板上直接说"这几个 Mod 现在不在盘上"，由用户决定重装还是算了。
 *
 * ## 两句话必须让用户看到（都是 ADR-014 的硬要求）
 *
 * * 回滚**之前**会自动再做一份备份（`pre-rollback snapshot`）——
 *   所以"回滚"这个动作本身也是可以反悔的；
 * * 目录名 = epoch 秒，界面按**本地时间**显示，两者永远对得上。
 */
import { useCallback, useEffect, useState } from 'react';
import { Button, Card, CardTitle, EmptyState, Note, Segmented } from '../ui';
import { IconAlert, IconClock, IconFolder, IconInfo, IconRefresh, IconShield, IconTrash } from '../ui/Icons';
import { useConfirm } from '../ui/confirm';
import { useRealApi } from '../hooks/useRealApi';
import { useApp } from '../state/AppContext';
import { formatBytes } from '../domain';
import type { BackupManifest, BackupRestorePreview, BackupRestoreReport } from '../bridge/tauri';

/** epoch 秒 → 本地时间（与备份目录名同源，见文件头第 2 条） */
function localTime(secs: number): string {
  const d = new Date(secs * 1000);
  if (Number.isNaN(d.getTime())) return String(secs);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 一份备份里有什么（**只用清单里真实存在的字段**，不猜） */
function contentsOf(b: BackupManifest): string {
  const parts: string[] = [];
  for (const it of b.items) {
    if (!it.present) continue;
    const label = it.rel === 'saves' ? '存档' : it.rel === 'config' ? '配置' : it.rel;
    parts.push(`${label} ${it.files} 个文件`);
  }
  if (b.mods.length > 0) parts.push(`Mod ${b.mods.length} 个（只记清单）`);
  return parts.length > 0 ? parts.join(' · ') : '这次备份时盘上还没有可备份的文件';
}

export function BackupPanel({
  slug,
  name,
  mcVersion,
}: {
  slug: string;
  name: string;
  /** 只用来写进清单（"这份备份是哪个游戏版本的实例"），拿不到就留空 */
  mcVersion?: string;
}) {
  const { api } = useRealApi();
  const { toast, state } = useApp();
  const confirm = useConfirm();
  const [list, setList] = useState<BackupManifest[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [report, setReport] = useState<BackupRestoreReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!api) {
      setList([]);
      return;
    }
    try {
      setList(await api.backup.list(slug));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setList([]);
    }
  }, [api, slug]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const doCreate = async () => {
    if (!api) return;
    setBusy('create');
    setError(null);
    try {
      const m = await api.backup.create({ slug, name, mcVersion, reason: '手动' });
      setReport(null);
      await reload();
      // ★ 只说做了的事实（体积、内容），不说"已保护你的存档"这种大话
      toast('ok', '已备份', `${formatBytes(m.total_bytes)} · ${contentsOf(m)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const doRestore = async (b: BackupManifest) => {
    if (!api) return;
    /*
     * ★★ 先算差异，再确认（ADR-014 原文："点击可**预览差异**（哪些存档文件会变化）
     *   再确认回滚"）。算差异只读文件、一个字节都不动 —— 而回滚是这个功能里
     *   **唯一会覆盖现有数据**的动作，所以"会动哪些文件"必须在动手之前说出来。
     *
     * ★ 算不出来就**如实说算不出来**，并把确认框的措辞退回"不知道会动什么" ——
     *   不许假装算过了（那正是这个仓库反复修的假话）。
     */
    let preview: BackupRestorePreview | null = null;
    let previewErr: string | null = null;
    try {
      preview = await api.backup.preview(slug, b.id);
    } catch (e) {
      previewErr = e instanceof Error ? e.message : String(e);
    }
    const diff = preview
      ? [
          '会用这一份备份里的存档与配置**覆盖当前状态**：',
          `· 写回 ${preview.will_write} 个文件，其中 ${preview.will_change} 个与现在不同` +
            (preview.will_add > 0 ? `（${preview.will_add} 个是现在还没有的）` : ''),
          preview.sample_write.length > 0
            ? `  ${preview.sample_write.slice(0, 4).join('、')}` +
              (preview.will_change > 4 ? ` …等共 ${preview.will_change} 个` : '')
            : null,
          `· 备份里没有、现在盘上有的 ${preview.kept_extra} 个文件**不会被删除**`,
          preview.mods_extra.length > 0
            ? `· ${preview.mods_extra.length} 个多余的 Mod 会被移出 mods/（挪进 mods-extra/，没删）`
            : null,
          preview.mods_missing.length > 0
            ? `· ★ 清单里有 ${preview.mods_missing.length} 个 Mod 现在不在盘上（${preview.mods_missing
                .slice(0, 3)
                .join('、')}）—— 回滚之后需要你自己重新获取`
            : null,
        ]
          .filter(Boolean)
          .join('\n')
      : `★ 这次的差异**没算出来**（${previewErr ?? '未知原因'}）—— 所以"回滚会覆盖什么、` +
        `保留什么"我给不了数字，点下去之前你我都不知道。`;
    const ok = await confirm({
      title: `回滚到 ${localTime(b.created_secs)} 的备份`,
      danger: true,
      confirmText: '回滚',
      message: `${diff}\n\n· 回滚之前会先自动备份一次当前状态，所以后悔了还能回到现在。`,
    });
    if (!ok) return;
    setBusy(b.id);
    setError(null);
    try {
      setReport(await api.backup.restore({ slug, name, mcVersion, id: b.id }));
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const doRemove = async (b: BackupManifest) => {
    if (!api) return;
    const ok = await confirm({
      title: '删除这份备份',
      danger: true,
      confirmText: '删除',
      message: `${localTime(b.created_secs)}（${b.reason}，${formatBytes(b.total_bytes)}）会被永久删除，删了就回不到这个时间点了。`,
    });
    if (!ok) return;
    setBusy(b.id);
    try {
      await api.backup.remove(slug, b.id);
      if (report?.from_id === b.id) setReport(null);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardTitle icon={<IconShield />} hint="存档与配置的保险，Mod 只记清单">
        备份与回滚
      </CardTitle>

      <div className="field-row">
        <span className="field-label">
          备份范围
          <span className="field-hint">
            存档 saves/、配置 config/、游戏设置 options.txt、服务器列表 servers.dat ——
            Mod **只记文件名与校验值**，jar 不进备份（一个整合包几百 MB，五份就能把盘吃光）
          </span>
        </span>
        <div className="field-control">
          <Button variant="secondary" loading={busy === 'create'} onClick={() => void doCreate()}>
            <IconRefresh /> 立即备份
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              void api?.backup.openFolder(slug).catch((e) => setError(String(e)));
            }}
          >
            <IconFolder /> 打开备份目录
          </Button>
        </div>
      </div>

      <div className="field-row">
        <span className="field-label">
          启动游戏前自动备份
          <span className="field-hint">
            默认开启。每次启动前把存档与配置存一份，滚动保留最近 5 份 ——
            关掉之后只有手动备份了
          </span>
        </span>
        <div className="field-control">
          <Segmented
            label="启动前自动备份"
            value={state.prefs.autoBackup === false ? 'off' : 'on'}
            options={[
              { value: 'on', label: '开' },
              { value: 'off', label: '关' },
            ]}
            onChange={(v) =>
              // ★ 偏好走 `ieml:prefs` 事件（与设置页同一套），它会落到 prefs.json ——
              //   而**启动路径在 Rust 里**，那一刻前端可能还没加载完，只能读文件
              window.dispatchEvent(
                new CustomEvent('ieml:prefs', { detail: { autoBackup: v === 'on' } }),
              )
            }
          />
        </div>
      </div>

      {error ? (
        <Note tone="warning" icon={<IconAlert />} title="备份功能出了问题">
          {error}
        </Note>
      ) : null}

      {report ? (
        <Note tone="info" icon={<IconInfo />} title="回滚完成">
          {/* ★ 每一项都是真实发生的：还原了多少、保留了什么、缺了什么 */}
          从 {localTime(Number(report.from_id.split('-')[0] ?? 0))} 的备份还原了{' '}
          {report.restored.reduce((n, i) => n + i.files, 0)} 个文件；回滚前的状态已另存为一份备份（
          {report.pre_rollback_id}），想回去就在下面的时间线里找它。
          {report.kept_extra_files.length > 0
            ? ` 备份里没有、盘上已有的 ${report.kept_extra_files.length} 个文件**没有删除**。`
            : ''}
          {report.mods_moved_out.length > 0
            ? ` ${report.mods_moved_out.length} 个多余的 Mod 已移出 mods/（挪进那份备份的 mods-extra/）。`
            : ''}
          {report.mods_missing.length > 0
            ? ` ★ 清单里有 ${report.mods_missing.length} 个 Mod 现在不在盘上（例如 ${report.mods_missing
                .slice(0, 3)
                .join('、')}）—— 需要你自己重新获取，启动器不会偷偷下载。`
            : ''}
        </Note>
      ) : null}

      {list === null ? (
        <div className="field-hint">正在读备份…</div>
      ) : list.length === 0 ? (
        <EmptyState
          title="还没有备份"
          desc="点「立即备份」存一份；开启自动备份后，每次启动游戏前也会自动存一份。"
        />
      ) : (
        list.map((b) => (
          <div className="field-row" key={b.id}>
            <span className="field-label">
              <IconClock /> {localTime(b.created_secs)}
              <span className="field-hint">
                {b.reason} · {formatBytes(b.total_bytes)} · {contentsOf(b)}
                {b.skipped.length > 0 ? ` · ★ 有 ${b.skipped.length} 项没备上` : ''}
              </span>
            </span>
            <div className="field-control">
              <Button
                variant="secondary"
                loading={busy === b.id}
                onClick={() => void doRestore(b)}
              >
                回滚
              </Button>
              <Button variant="ghost" onClick={() => void doRemove(b)}>
                <IconTrash /> 删除
              </Button>
            </div>
          </div>
        ))
      )}
    </Card>
  );
}
