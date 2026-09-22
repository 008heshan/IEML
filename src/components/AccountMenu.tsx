/**
 * C 的前端：**侧栏最底部的账号按钮 + 向上展开的菜单**
 * （用户：「把账号按钮放到最底部，点击可以向上展开，有图二这些功能，
 *   还有切换账号的功能，还有可以切换离线模式，然后还能直接切回来，
 *   正版账号不能自动退登，附属文字描述不能太多，排版要好看且实用」）。
 *
 * 图二那份菜单是：修改皮肤 / 刷新皮肤 / 保存皮肤文件 / 修改披风 / 刷新披风列表 /
 * 使用 CDKEY 兑换奖励 —— 这里逐条落地。
 *
 * ★ 排版原则（用户："附属文字描述不能太多，排版要好看且实用"）：
 *   每一行**只有名字**；需要在状态下说话时（未登录、没有披风、正在忙）用
 *   行尾一个短状态或一个 Chip，**不写解释性小字**。
 */
import { useEffect, useRef, useState } from 'react';
import { Chip } from '../ui';
import {
  IconImage,
  IconRefresh,
  IconDownload,
  IconBox,
  IconInfo,
  IconShield,
} from '../ui/Icons';
import { SkinHead } from './SkinHead';
import { useApp } from '../state/AppContext';
import { getRealApi } from '../bridge';

export interface AccountMenuProps {
  /** 打开"账号"弹窗（登录 / 切换账号都在里面） */
  onOpenAccount: () => void;
}

type Cape = { id: string; name: string; url: string | null; active: boolean };

export function AccountMenu({ onOpenAccount }: AccountMenuProps) {
  const { state, toast } = useApp();
  const [open, setOpen] = useState(false);
  const [skin, setSkin] = useState<{ skinUrl: string | null; capeUrl: string | null } | null>(null);
  const [capes, setCapes] = useState<Cape[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showCapes, setShowCapes] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const uuid = state.prefs.accountUuid ?? null;
  const offlineName = state.prefs.offlineUsername || 'Player';
  const isOnline = Boolean(uuid);

  /* 点外面关掉（与任务中心同一条规矩） */
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  /* 打开菜单时按需拉一次皮肤（不轮询 —— 换皮肤本来就要重开游戏才看得到） */
  /*
   * ★★ 2026-09-23 用户：「左下角头像需要我点一下那个按钮之后才会出来（存疑）」——
   *   **不存疑，就是这个原因**：这个 effect 原来写着 `if (!open …) return`，
   *   于是菜单不打开就永远不去拉皮肤 —— 头像是"点开之后才出现"的。
   *   现在**挂载就拉**（以及 uuid 变化时重拉），与菜单开不开无关。
   */
  useEffect(() => {
    if (!uuid || skin) return;
    void (async () => {
      const api = await getRealApi();
      if (!api) return;
      try {
        setSkin(await api.account.skin(uuid));
      } catch {
        /* 拉不到就用默认头像，不打扰用户 */
      }
    })();
  }, [open, uuid, skin]);

  const refreshSkin = async () => {
    const api = await getRealApi();
    if (!api || !uuid) return;
    setBusy('skin');
    try {
      setSkin(await api.account.skin(uuid));
      toast('ok', '皮肤已刷新');
    } catch (e) {
      toast('err', '刷新皮肤失败', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const refreshCapes = async () => {
    const api = await getRealApi();
    if (!api || !uuid) return;
    setBusy('capes');
    try {
      const list = await api.account.capes(uuid);
      setCapes(list);
      setShowCapes(true);
      toast('ok', list.length ? `有 ${list.length} 件披风` : '这个账号没有披风');
    } catch (e) {
      toast('err', '取披风列表失败', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const changeSkin = async () => {
    const api = await getRealApi();
    if (!api || !uuid) return;
    let picked: string | null = null;
    try {
      const { open: openDialog } = await import('@tauri-apps/plugin-dialog');
      const r = await openDialog({
        multiple: false,
        title: '选一张 PNG 皮肤（64×64，或旧版 64×32）',
        filters: [{ name: 'PNG 图片', extensions: ['png'] }],
      });
      picked = typeof r === 'string' ? r : null;
    } catch (e) {
      toast('err', '打不开文件选择框', e instanceof Error ? e.message : String(e));
      return;
    }
    if (!picked) return;
    setBusy('upload');
    try {
      await api.account.uploadSkin(uuid, picked, 'classic');
      setSkin(await api.account.skin(uuid));
      toast('ok', '皮肤已换好', '重开游戏就能看到');
    } catch (e) {
      toast('err', '换皮肤失败', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const saveSkinFile = async () => {
    const api = await getRealApi();
    if (!api || !skin?.skinUrl) return;
    let dir: string | null = null;
    try {
      const { open: openDialog } = await import('@tauri-apps/plugin-dialog');
      const r = await openDialog({ directory: true, multiple: false, title: '皮肤存到哪个文件夹' });
      dir = typeof r === 'string' ? r : null;
    } catch (e) {
      toast('err', '打不开文件夹选择框', e instanceof Error ? e.message : String(e));
      return;
    }
    if (!dir) return;
    const sep = dir.includes('\\') ? '\\' : '/';
    const name = (state.prefs.offlineUsername || 'skin').replace(/[\\/:*?"<>|]/g, '_');
    setBusy('save');
    try {
      const n = await api.account.saveSkin(skin.skinUrl, `${dir}${sep}${name}-skin.png`);
      toast('ok', '皮肤已保存', `${(n / 1024).toFixed(1)} KB`);
    } catch (e) {
      toast('err', '保存皮肤失败', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const changeCape = async () => {
    const api = await getRealApi();
    if (!api || !uuid) return;
    setBusy('cape');
    try {
      const list = await api.account.capes(uuid);
      setCapes(list);
      setShowCapes(true);
    } catch (e) {
      toast('err', '取披风列表失败', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const pickCape = async (capeId: string | null) => {
    const api = await getRealApi();
    if (!api || !uuid) return;
    setBusy('cape');
    try {
      await api.account.setCape(uuid, capeId);
      setCapes(await api.account.capes(uuid));
      setSkin(await api.account.skin(uuid));
      toast('ok', capeId ? '披风已换上' : '已隐藏披风');
    } catch (e) {
      toast('err', '换披风失败', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  /**
   * 切到离线模式。
   * ★ 用户要求「可以切换离线模式，然后还能直接切回来」——
   *   所以**不删正版凭据**（keyring 里那份留着），只是把"当前用哪个"换成离线；
   *   切回来只要把 accountUuid 恢复即可，不用重新登录。
   */
  const switchMode = async (toOffline: boolean) => {
    const api = await getRealApi();
    setBusy('mode');
    try {
      if (toOffline) {
        if (!api) throw new Error('演示模式');
        await api.account.offline(offlineName);
        window.dispatchEvent(
          new CustomEvent('ieml:prefs', { detail: { accountUuid: null } }),
        );
        toast('ok', '已切到离线', `玩家名：${offlineName}`);
      } else {
        if (!savedUuidRef.current) {
          // 没有可切回的正版账号 —— 打开登录面板
          onOpenAccount();
          return;
        }
        window.dispatchEvent(
          new CustomEvent('ieml:prefs', { detail: { accountUuid: savedUuidRef.current } }),
        );
        toast('ok', '已切回正版');
      }
    } catch (e) {
      toast('err', '切换失败', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  /** 记住最近一次的正版 uuid —— "还能直接切回来"靠它（凭据一直在 keyring 里，没删） */
  const savedUuidRef = useRef<string | null>(uuid);
  useEffect(() => {
    if (uuid) savedUuidRef.current = uuid;
  }, [uuid]);

  const head = skin?.skinUrl ?? null;
  const label = isOnline ? (state.prefs.offlineUsername || '正版账号') : offlineName;

  return (
    <div className="acct-wrap" ref={wrapRef}>
      <button
        type="button"
        className={'acct-btn' + (open ? ' on' : '')}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="acct-avatar" aria-hidden="true">
          {/*
            ★★ 2026-09-23 用户（截图）：「**头像不显示**，名字显示不全」。
              原因是我这里手写了 `backgroundSize: 800%` + `backgroundPosition: 0 0` ——
              **`0 0` 取到的是皮肤左上角那 8×8，而现代皮肤那一块是空的**
              （头在 (8,8)，帽子在 (40,8)）。改成复用 `SkinHead`：
              那套坐标只有一份实现，不会再被手抄错。
          */}
          <SkinHead url={head} size={22} />
        </span>
        {/* ★ 名字要**放得下**（用户："名字显示不全"）——见 app.css 里那一行的说明 */}
        <span className="acct-name truncate">{label}</span>
        <Chip tone={isOnline ? 'success' : 'neutral'}>{isOnline ? '正版' : '离线'}</Chip>
      </button>

      {open ? (
        <div className="acct-menu" role="menu">
          {/* ---------- 皮肤 ---------- */}
          <button type="button" role="menuitem" disabled={!isOnline || busy === 'upload'} onClick={() => void changeSkin()}>
            <IconImage /> 修改皮肤
            {busy === 'upload' ? <span className="acct-state">上传中…</span> : null}
          </button>
          <button type="button" role="menuitem" disabled={!isOnline || busy === 'skin'} onClick={() => void refreshSkin()}>
            <IconRefresh /> 刷新皮肤
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!isOnline || !skin?.skinUrl || busy === 'save'}
            onClick={() => void saveSkinFile()}
          >
            <IconDownload /> 保存皮肤文件
          </button>

          <div className="acct-sep" />

          {/* ---------- 披风 ---------- */}
          <button type="button" role="menuitem" disabled={!isOnline || busy === 'cape'} onClick={() => void changeCape()}>
            <IconBox /> 修改披风
          </button>
          <button type="button" role="menuitem" disabled={!isOnline || busy === 'capes'} onClick={() => void refreshCapes()}>
            <IconRefresh /> 刷新披风列表
          </button>

          {showCapes && capes ? (
            <div className="acct-capes">
              {capes.length === 0 ? (
                <div className="acct-empty">这个账号没有披风</div>
              ) : (
                <>
                  {capes.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      role="menuitem"
                      className={c.active ? 'on' : ''}
                      disabled={busy === 'cape'}
                      onClick={() => void pickCape(c.id)}
                    >
                      <span className="acct-cape" style={c.url ? { backgroundImage: `url(${c.url})` } : undefined} aria-hidden="true" />
                      {c.name}
                      {c.active ? <Chip tone="success">在用</Chip> : null}
                    </button>
                  ))}
                  <button type="button" role="menuitem" disabled={busy === 'cape'} onClick={() => void pickCape(null)}>
                    不显示披风
                  </button>
                </>
              )}
            </div>
          ) : null}

          <div className="acct-sep" />

          <div className="acct-sep" />

          {/* ---------- 账号与模式 ---------- */}
          <button type="button" role="menuitem" onClick={onOpenAccount}>
            <IconShield /> {isOnline ? '切换账号' : '登录正版账号'}
          </button>
          {isOnline ? (
            <button type="button" role="menuitem" disabled={busy === 'mode'} onClick={() => void switchMode(true)}>
              <IconInfo /> 切到离线模式
            </button>
          ) : (
            <button type="button" role="menuitem" disabled={busy === 'mode'} onClick={() => void switchMode(false)}>
              <IconInfo /> 切回正版账号
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
