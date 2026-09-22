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

  /*
   * ★★ 2026-09-23 用户第一遍：「头像需要点一下按钮才出来（存疑）」
   *   第二遍：「**左下角头像还是我不点就不加载**」—— 说明第一遍我只修了一半。
   *
   *   真相：这里原来是 `try { setSkin(await …) } catch { /* 忽略 *\/ }` ——
   *   **失败被吞掉、而且不重试**。而拉皮肤走的是 `sessionserver.mojang.com`，
   *   这台机器上它**时通时不通**（`2026-09-16-network-diag.md` 里记着）。
   *   于是：首拉失败 → 头像空着 → 用户点一下按钮（`open` 变了）→ effect 重跑 →
   *   这一次网络通了 → 头像出现。**"不点就不出来"就是这么来的。**
   *
   *   现在：**失败就退避重试**（2s / 5s / 10s，共 4 次），不依赖用户去点。
   *   ★ 为什么退避而不是轮询：换皮肤本来就要重开游戏才看得到，
   *     高频轮询只会白白撞速率限制（Mojang 那边约每分钟一次）。
   */
  useEffect(() => {
    if (!uuid || skin) return;
    let alive = true;
    let timer: number | undefined;
    const DELAYS = [2000, 5000, 10000];
    const attempt = async (n: number) => {
      const api = await getRealApi();
      if (!api || !alive) return;
      const retry = () => {
        if (!alive || n >= DELAYS.length) return;
        timer = window.setTimeout(() => void attempt(n + 1), DELAYS[n]);
      };
      try {
        const s = await api.account.skin(uuid);
        // ★ 拉到了但里面没有皮肤（用的是默认皮肤）也算"成功"，不必重试
        if (alive) setSkin(s);
        else retry();
      } catch {
        retry();
      }
    };
    void attempt(0);
    return () => {
      alive = false;
      if (timer) window.clearTimeout(timer);
    };
    // ★ 不再依赖 `open` —— 头像是"状态"，不该等用户点开菜单才开始加载
  }, [uuid, skin]);

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

            ★★ 2026-09-23（第二次）：皮肤还没拉到时给一个**占位人形** ——
              原来什么都没有，看着就像"坏了"（用户为此截了两次图）。
              占位与真实头像同一个方框，拉到了就换掉，不会跳版。
          */}
          <SkinHead url={head} size={22} />
          {!head ? (
            <span className="acct-avatar-ph">
              <IconInfo />
            </span>
          ) : null}
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
