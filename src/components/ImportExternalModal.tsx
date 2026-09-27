/**
 * 导入别的启动器的数据（官方 / PCL2 / HMCL / Prism-MultiMC）
 * ------------------------------------------------------------------
 * 老玩家换启动器时，手上是一整个游戏目录。这个弹窗做三件事：
 *
 * ```text
 *   ① 说清"这是谁的目录"    —— 依据来自后端（`domain::external` 的单测钉着它）
 *   ② 说清"能搬什么、多大"  —— 让用户在点之前就看得见
 *   ③ 搬（复制）进某个实例  —— 只复制不删源、永不覆盖、可先备份
 * ```
 *
 * ## 为什么入口是"拖进来"而不是一个只在设置里的按钮
 *
 *   用户手上那个目录**就在文件管理器里**，拖进来是最近的一条路。
 *   按钮也留着（版本列表页），但拖拽是主路径。
 *
 * ## 为什么"从哪一层搬"要单独选
 *
 *   PCL2 / HMCL 的「版本隔离」会把某个版本的存档与 Mod 放在
 *   `<游戏目录>/versions/<版本>/` 里面 —— 那正是我们上一版做的那个功能。
 *   不认这一层的话，用户拖进来会发现"我的存档怎么没搬过来"。
 */
import { useEffect, useState } from 'react';
import { useApp } from '../state/AppContext';
import { useRealApi } from '../hooks/useRealApi';
import { formatBytes } from '../domain';
import { Button, CustomSelect, Modal } from '../ui';
import { IconAlert, IconDownload, IconInfo } from '../ui/Icons';
import type { ExternalScan } from '../bridge/tauri';

export interface ImportExternalRequest {
  path: string;
}

export function ImportExternalModal() {
  const { state, toast, refreshIsolation } = useApp();
  const { api } = useRealApi();
  const [req, setReq] = useState<ImportExternalRequest | null>(null);
  const [scan, setScan] = useState<ExternalScan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [slug, setSlug] = useState('');
  const [layer, setLayer] = useState('');
  const [backupFirst, setBackupFirst] = useState(true);

  /* 拖进来（或按钮选完目录）→ 打开这个弹窗并扫一遍 */
  useEffect(() => {
    const onImport = (e: Event) => {
      const detail = (e as CustomEvent<ImportExternalRequest>).detail;
      if (detail?.path) setReq(detail);
    };
    window.addEventListener('ieml:import-external', onImport);
    return () => window.removeEventListener('ieml:import-external', onImport);
  }, []);

  useEffect(() => {
    if (!req || !api) return;
    let alive = true;
    setScan(null);
    setError(null);
    setLayer('');
    setSlug(state.instances[0]?.config.slug ?? '');
    void (async () => {
      try {
        const s = await api.external.scan(req.path);
        if (!alive) return;
        setScan(s);
        /*
         * ★ 有"版本隔离"那一层时**默认选它**：那才是用户真正在玩的那份
         *   （根目录往往只剩一份老存档）。没有的话就是根目录。
         */
        setLayer(s.version_layers[0]?.key ?? '');
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req, api]);

  const close = () => {
    setReq(null);
    setScan(null);
    setError(null);
  };

  /** 当前选中那一层要搬的东西（根目录 or 某个版本目录） */
  const items = scan
    ? layer
      ? scan.version_layers.find((l) => l.key === layer)?.items ?? []
      : scan.items
    : [];
  const files = items.reduce((n, i) => n + i.files, 0);
  const bytes = items.reduce((n, i) => n + i.bytes, 0);
  const target = state.instances.find((i) => i.config.slug === slug) ?? null;
  const canImport = !!api && !!scan && scan.launcher !== 'unknown' && files > 0 && !!slug;

  async function run() {
    if (!api || !req) return;
    setBusy(true);
    try {
      const r = await api.external.import(req.path, slug, layer, backupFirst);
      const copiedFiles = r.copied.reduce((n, c) => n + c.files, 0);
      const copiedBytes = r.copied.reduce((n, c) => n + c.bytes, 0);
      const extra: string[] = [`原目录里的东西没有删（${req.path}）。`];
      if (r.backup_id) extra.push(`已先备份这个实例一份（${r.backup_id}）`);
      if (r.skipped_existing.length > 0) {
        extra.push(
          `${r.skipped_existing.length} 个同名文件没有覆盖：${r.skipped_existing
            .slice(0, 3)
            .join('、')}${r.skipped_existing.length > 3 ? '…' : ''}`,
        );
      }
      if (r.failed.length > 0) extra.push(`${r.failed.length} 个复制失败：${r.failed[0]}`);
      toast(
        r.failed.length > 0 ? 'warning' : 'ok',
        copiedFiles > 0
          ? `已导入 ${copiedFiles} 个文件（${formatBytes(copiedBytes)}）`
          : '没有需要导入的内容',
        [`${r.copied.map((c) => c.name).join('、')}`, ...extra].filter(Boolean).join('\n'),
      );
      await refreshIsolation();
      close();
    } catch (e) {
      toast('err', '导入失败', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={req !== null}
      onClose={close}
      title="导入别的启动器的数据"
      subtitle="把那个目录里的存档、Mod、配置复制一份过来 —— 原目录一个字节都不动"
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            取消
          </Button>
          <Button variant="primary" onClick={() => void run()} disabled={!canImport} loading={busy}>
            导入到 {target ? target.config.name : '（先选一个版本）'}
          </Button>
        </>
      }
    >
      {error ? (
        <p className="wz-hint">
          <IconAlert /> 读不了这个目录：{error}
        </p>
      ) : !scan ? (
        <p className="wz-hint">正在看这个目录里有什么…</p>
      ) : (
        <>
          <div className="iso-move">
            <div className="iso-move-row">
              <span className="iso-move-k">来源</span>
              <span className="mono">{scan.game_dir}</span>
            </div>
            {scan.game_dir !== scan.picked ? (
              <div className="iso-move-row">
                <span className="iso-move-k"> </span>
                <span className="dim">
                  你选的是 <span className="mono">{scan.picked}</span>，游戏数据在它里面的这一层
                </span>
              </div>
            ) : null}
            <div className="iso-move-row">
              <span className="iso-move-k">判定</span>
              <span>
                {scan.launcher_name}
                {scan.versions > 0 ? ` · 里面有 ${scan.versions} 个版本目录` : ''}
              </span>
            </div>
          </div>

          {scan.evidence.length > 0 ? (
            <p className="wz-hint">
              <IconInfo /> 依据：{scan.evidence.join('；')}
            </p>
          ) : null}
          {scan.note ? <p className="wz-hint">{scan.note}</p> : null}

          {scan.launcher === 'unknown' ? (
            <p className="wz-hint">
              <IconAlert /> 这个目录里没有能搬的游戏数据 —— 请选到游戏目录那一层
              （里面有 saves / mods / config 的那一层）。
            </p>
          ) : (
            <>
              <div className="field-row">
                <label className="field-label">
                  搬到哪个版本
                  <span className="field-hint">复制进它的游戏目录，不会覆盖已有文件</span>
                </label>
                <div className="field-control">
                  <CustomSelect
                    ariaLabel="导入到哪个版本"
                    value={slug}
                    onChange={setSlug}
                    options={state.instances.map((i) => ({
                      value: i.config.slug,
                      label: `${i.config.name}（${i.mcVersion}）`,
                    }))}
                  />
                </div>
                <span />
              </div>

              {scan.version_layers.length > 0 || scan.items.length > 0 ? (
                <div className="field-row">
                  <label className="field-label">
                    从哪一层搬
                    <span className="field-hint">版本目录那一层往往是"版本隔离"后的存档</span>
                  </label>
                  <div className="field-control">
                    <CustomSelect
                      ariaLabel="从哪一层搬"
                      value={layer}
                      onChange={setLayer}
                      options={[
                        ...(scan.items.length > 0
                          ? [{ value: '', label: `游戏目录根这一层（${scan.items.reduce((n, i) => n + i.files, 0)} 个文件）` }]
                          : []),
                        ...scan.version_layers.map((l) => ({
                          value: l.key,
                          label: `${l.label}（${l.items.reduce((n, i) => n + i.files, 0)} 个文件）`,
                        })),
                      ]}
                    />
                  </div>
                  <span />
                </div>
              ) : null}

              <div className="iso-move-list">
                {items.map((it) => (
                  <div key={it.name} className="iso-move-item">
                    <span className="mono">{it.name}</span>
                    <span>
                      {it.files} 个文件 · {formatBytes(it.bytes)}
                    </span>
                  </div>
                ))}
              </div>

              <label className="check-row">
                <input
                  type="checkbox"
                  checked={backupFirst}
                  onChange={(e) => setBackupFirst(e.target.checked)}
                />
                <span>导入之前先给这个版本做一份备份（存档与配置可以回滚）</span>
              </label>

              <p className="wz-hint">
                <IconDownload /> 一共 {files} 个文件 · {formatBytes(bytes)}。
              游戏本体（versions / libraries / assets）不搬 —— 那些是同一份官方文件。
              </p>
              <p className="wz-hint">
                同名文件不会覆盖：目标里已经有的会被跳过，并在完成后列出来。
              </p>
            </>
          )}
        </>
      )}
    </Modal>
  );
}

/** 让别的页面（版本列表的按钮）也能打开这个弹窗 */
export function openImportExternal(path: string) {
  window.dispatchEvent(new CustomEvent('ieml:import-external', { detail: { path } }));
}
