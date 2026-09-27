/**
 * 导出整合包（ADR-024）
 * ------------------------------------------------------------------
 * 导出的包是要**发给别人**的，所以这个弹窗的第一职责不是"导出"，
 * 而是**在导出之前把话说清楚**：
 *
 * ```text
 *   会带上什么      Mod / 配置 / 资源包 ……（列表 + 体积）
 *   不会带上什么    日志、游戏本体、运行期缓存、别的启动器的私有文件
 *   绝不带上什么    登录凭据（红线，单独一条醒目提示）
 *   想带但默认不带  存档 / 设置（用户自己勾）
 * ```
 *
 * ## 为什么"绝不带上"要在界面上单独说
 *
 *   因为它是**沉默的**：用户不会发现包里少了什么，只会发现有人拿到了不该拿到的东西。
 *   盘上存在登录凭据时这里**如实指出来**（"你目录里有它，我们没有带它走"）——
 *   用户需要知道那个文件**曾经**在那儿，因为他可能正打算把整个目录打包发出去。
 */
import { useEffect, useState } from 'react';
import { useApp } from '../state/AppContext';
import { useRealApi } from '../hooks/useRealApi';
import { formatBytes } from '../domain';
import { Button, Modal } from '../ui';
import { IconAlert, IconBox, IconDownload, IconShield } from '../ui/Icons';
import type { ExportPlan } from '../bridge/tauri';

export interface ExportRequest {
  slug: string;
}

export function ExportModpackModal() {
  const { toast } = useApp();
  const { api } = useRealApi();
  const [req, setReq] = useState<ExportRequest | null>(null);
  const [plan, setPlan] = useState<ExportPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [versionId, setVersionId] = useState('1.0.0');
  /** 用户勾上的建议项（默认**一个都不勾** —— ADR-024：存档默认不导出） */
  const [picked, setPicked] = useState<string[]>([]);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const d = (e as CustomEvent<ExportRequest>).detail;
      if (d?.slug) {
        setPicked([]);
        setReq(d);
      }
    };
    window.addEventListener('ieml:export-modpack', onOpen);
    return () => window.removeEventListener('ieml:export-modpack', onOpen);
  }, []);

  useEffect(() => {
    if (!req || !api) return;
    let alive = true;
    setPlan(null);
    setError(null);
    void (async () => {
      try {
        const p = await api.modpackExport.scan(req.slug, picked);
        if (alive) setPlan(p);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req, picked.join('|'), api]);

  const close = () => {
    setReq(null);
    setPlan(null);
    setError(null);
  };

  async function run() {
    if (!api || !req || !plan) return;
    setBusy(true);
    try {
      const r = await api.modpackExport.run(req.slug, versionId, picked);
      const red = r.red_line_found.length > 0 ? '\n★ 登录凭据没有进包：' + r.red_line_found.join('、') : '';
      toast(
        'ok',
        `已导出 ${r.files} 个文件（${formatBytes(r.bytes)}）`,
        [`文件：${r.path}`, `排除了 ${r.excluded} 项不该带的内容。${red}`].join('\n'),
      );
      close();
    } catch (e) {
      toast('err', '导出失败', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const toggle = (rel: string) =>
    setPicked((prev) => (prev.includes(rel) ? prev.filter((x) => x !== rel) : [...prev, rel]));

  return (
    <Modal
      open={req !== null}
      onClose={close}
      size="lg"
      title="导出为整合包"
      subtitle="导出成 .mrpack（Modrinth 格式），别的启动器也认；日志、游戏本体与登录凭据不会进包"
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            取消
          </Button>
          <Button
            variant="primary"
            onClick={() => void run()}
            disabled={!plan || plan.include_files === 0 || busy}
            loading={busy}
          >
            导出
          </Button>
        </>
      }
    >
      {error ? (
        <p className="wz-hint">
          <IconAlert /> {error}
        </p>
      ) : !plan ? (
        <p className="wz-hint">正在算这次导出会带上什么…</p>
      ) : (
        <>
          <div className="iso-move">
            <div className="iso-move-row">
              <span className="iso-move-k">来源</span>
              <span>
                {plan.name} · {plan.mc_version}
                {plan.loader_kind ? ` · ${plan.loader_kind} ${plan.loader_version ?? ''}` : ' · 原版'}
              </span>
            </div>
            <div className="iso-move-row">
              <span className="iso-move-k">版本</span>
              <span>
                <input
                  className="input"
                  style={{ maxWidth: 180 }}
                  value={versionId}
                  onChange={(e) => setVersionId(e.target.value)}
                  aria-label="整合包版本号"
                />
              </span>
            </div>
          </div>

          {/* ★ 红线：单独一条，醒目 */}
          {plan.red_line_found.length > 0 ? (
            <p className="wz-hint res-alias">
              <IconShield /> 这个目录里有登录凭据（{plan.red_line_found.join('、')}）——
              它们绝不会进整合包。
            </p>
          ) : null}

          <div className="iso-move-list">
            {plan.include.map((it) => (
              <div key={it.rel} className="iso-move-item">
                <span className="mono">{it.rel}</span>
                <span>
                  {it.files} 个文件 · {formatBytes(it.bytes)}
                </span>
              </div>
            ))}
            {plan.include.length === 0 ? <div className="iso-move-item">（没有可导出的文件）</div> : null}
          </div>

          <p className="wz-hint">
            <IconBox /> 一共 {plan.include_files} 个文件 · {formatBytes(plan.include_bytes)}。
            包里的内容全部放在 <span className="mono">overrides/</span>，装的时候原样落到游戏目录里。
          </p>

          {plan.suggested.length > 0 ? (
            <>
              <div className="iso-move-list">
                {plan.suggested.map((it) => (
                  <label key={it.rel} className="check-row" style={{ margin: 0 }}>
                    <input
                      type="checkbox"
                      checked={picked.includes(it.rel)}
                      onChange={() => toggle(it.rel)}
                    />
                    <span className="mono">{it.rel}</span>
                    <span className="dim">
                      {it.files} 个文件 · {formatBytes(it.bytes)} —— {it.reason}
                    </span>
                  </label>
                ))}
              </div>
              <p className="wz-hint">★ 存档默认不导出 —— 整合包分享不该带上别人的存档。</p>
            </>
          ) : null}

          {plan.excluded.length > 0 ? (
            <details className="wz-hint">
              <summary>
                有 {plan.excluded.length} 项不会进包（日志 / 游戏本体 / 运行期缓存 / 别的启动器的私有文件）
              </summary>
              <div className="iso-move-list">
                {plan.excluded.map((it) => (
                  <div key={it.rel} className="iso-move-item">
                    <span className="mono">{it.rel}</span>
                    <span className="dim">{it.reason}</span>
                  </div>
                ))}
              </div>
            </details>
          ) : null}

          <p className="wz-hint">
            <IconDownload /> ★ 本版的包把内容全放在 overrides 里（装的时候照抄），
            所以一定能装上；代价是包大一些 —— 宁可大一点，也不要"装完少几个 Mod"。
          </p>
        </>
      )}
    </Modal>
  );
}

/** 让别的页面（实例概览）也能打开它 */
export function openExportModpack(slug: string) {
  window.dispatchEvent(new CustomEvent('ieml:export-modpack', { detail: { slug } }));
}
