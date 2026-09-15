/**
 * 账号（正版登录 / 离线模式）—— **一处实现，两处使用**
 * ------------------------------------------------------------------
 * ## 为什么要抽出来（用户要求"正版登录界面应该放在显眼位置，而不是藏起来"）
 *
 * 原来这一整套（设备码 → 自动轮询 → 错误处理 → 离线模式切换）只写在
 * 「设置 → 账号」那张卡里。位置的问题有两层：
 *
 *   ① **它藏在设置页第三屏** —— 一个启动器最常被忽略、又最影响体验的功能
 *      （正版号能不能用来进服务器）要滚半天才看得到；
 *   ② 更根本的是：**账号不是"设置"**。设置是"改一次就不动"的东西，
 *      而账号是"我现在是谁、能不能进服务器"—— 属于**状态**，应该在顶栏
 *      一直看得见（PCL 的做法也是把账号放在主界面显眼处）。
 *
 * 所以现在：顶栏一个账号按钮（头像 + 当前身份 + 状态点），点开是这个面板；
 * 设置页那张卡也用同一个面板。**判据只有一份**（ADR-051：同一件事不许写两遍），
 * 改登录流程只需要动这个文件。
 *
 * ## 里面只做"呈现与调用"，不做判断
 *
 * 能不能登录由后端 `ms_login_status` 说了算（缺不缺 client_id、缺什么、
 * 去哪填），这里只把它的话原样显示出来。
 */
import { useEffect, useState } from 'react';
import { Button, Chip, Note, Spinner } from '../ui';
import { IconAlert, IconCheck, IconShield } from '../ui/Icons';
import { useRealApi } from '../hooks/useRealApi';
import { useApp } from '../state/AppContext';
import type { MsLoginStatus } from '../bridge/tauri';

interface DeviceCode {
  user_code: string;
  verification_uri: string;
  device_code: string;
  interval: number;
  expires_in: number;
}

export interface AccountPanelProps {
  /** 紧凑模式：顶栏弹窗里用（少一层卡片内边距、少两行说明） */
  compact?: boolean;
  toast: (kind: 'ok' | 'warning' | 'err' | 'info', title: string, desc?: string) => void;
  /** 登录成功后（顶栏用它关掉弹窗） */
  onLoggedIn?: () => void;
}

export function AccountPanel({ compact = false, toast, onLoggedIn }: AccountPanelProps) {
  const { state } = useApp();
  const { api } = useRealApi();

  const [msStatus, setMsStatus] = useState<MsLoginStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [device, setDevice] = useState<DeviceCode | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);

  useEffect(() => {
    if (!api) return;
    void api.account
      .msStatus()
      .then(setMsStatus)
      .catch(() => setMsStatus(null));
  }, [api]);

  /**
   * 开始登录：拿设备码 → **自动打开浏览器** → 由下面的 effect 自动轮询。
   *
   * ★ 必须用 `openUrl` 而不是 `openPath`：`verification_uri` 是 URL，
   *   而 `opener:allow-open-path` 不含任何路径白名单，必然被拒 ——
   *   那样用户会看到「无法开始登录」，而设备码其实已经拿到了。
   */
  async function startLogin() {
    if (!api) {
      toast('warning', '演示模式', '桌面版才能正版登录');
      return;
    }
    setLoginError(null);
    setBusy(true);
    try {
      const d = await api.account.startLogin();
      setDevice({
        user_code: d.user_code,
        verification_uri: d.verification_uri,
        device_code: d.device_code,
        interval: d.interval,
        expires_in: d.expires_in,
      });
      try {
        const { openUrl } = await import('@tauri-apps/plugin-opener');
        await openUrl(d.verification_uri);
      } catch (e) {
        // 打不开浏览器不该让登录失败：页面上已经有码和网址，手动去也能登。
        toast(
          'warning',
          '没能自动打开浏览器',
          `请手动打开 ${d.verification_uri} 并输入代码 ${d.user_code}：${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    } catch (e) {
      toast('err', '无法开始登录', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /* 拿到设备码就自动轮询（后端是阻塞式：转到同意 / 拒绝 / 超时） */
  useEffect(() => {
    if (!api || !device) return;
    let alive = true;
    void (async () => {
      try {
        const acc = await api.account.pollLogin(
          device.device_code,
          device.interval,
          device.expires_in,
        );
        if (!alive) return;
        toast('ok', '登录成功', `${acc.username}（${acc.kind === 'msa' ? '正版' : '离线'}）`);
        window.dispatchEvent(
          new CustomEvent('ieml:prefs', {
            detail: { accountUuid: acc.uuid, offlineUsername: acc.username },
          }),
        );
        setDevice(null);
        setLoginError(null);
        onLoggedIn?.();
      } catch (e) {
        if (!alive) return;
        // 失败**留在界面上**：原因（码过期 / 拒绝 / 没买游戏 / 网络）是用户
        // 接下来做决定的依据，不该跟着 toast 几秒后消失。
        setLoginError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, device]);

  const loggedIn = !!state.prefs.accountUuid;

  return (
    <div className={compact ? 'acct acct-compact' : 'acct'}>
      {/* ---------- 当前身份 ---------- */}
      <div className="acct-now">
        <span className={`acct-avatar${loggedIn ? ' on' : ''}`} aria-hidden="true">
          {loggedIn ? <IconCheck /> : <IconShield />}
        </span>
        <div className="acct-who">
          <div className="acct-name">
            {loggedIn ? state.prefs.offlineUsername : '离线模式'}
            {loggedIn ? (
              <Chip tone="success">正版已登录</Chip>
            ) : (
              <Chip tone="neutral">未登录正版</Chip>
            )}
          </div>
          <div className="acct-sub">
            {loggedIn
              ? '进入正版验证的服务器时用的就是这个账号'
              : `离线玩家名：${state.prefs.offlineUsername} —— 单机、局域网联机都能玩，进不了正版验证的服务器`}
          </div>
        </div>
      </div>

      {/* ---------- 设备码：拿到就显示，轮询自动进行 ---------- */}
      {device ? (
        <div className="device-code">
          <div className="dc-label">在浏览器里输入这个代码</div>
          <div className="dc-code mono">{device.user_code}</div>
          <div className="dc-hint">
            浏览器会打开 {device.verification_uri}。完成后<b>自动继续</b>，不用回来点任何东西。
          </div>
          {/*
            ★★ 这一句是 2026-09-15 实测加的（用户真的踩到了）：
              用户在浏览器里点了同意、微软页面写着"大功告成"，但**应用这边没有拿到账号**
              （`prefs.json` 里 `accountUuid` 还是 null）—— 因为那期间启动器没在跑，
              而**授权结果是要靠启动器去领的**（设备码换令牌的那次请求由它发出）。
              所以这里必须把"别关掉启动器"说出来，否则用户会以为已经登好了。
          */}
          <div className="dc-warn">
            <IconAlert /> 这一步还没完成 —— <b>别关掉启动器</b>：浏览器里同意之后，
            要靠它去把授权换成账号（最多等 15 分钟）。
          </div>

          {loginError ? (
            <Note
              tone="warning"
              icon={<IconAlert />}
              title="登录没有完成"
              actions={
                <>
                  <Button size="sm" variant="primary" onClick={() => void startLogin()}>
                    重新开始
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setDevice(null);
                      setLoginError(null);
                    }}
                  >
                    关掉
                  </Button>
                </>
              }
            >
              <div style={{ whiteSpace: 'pre-wrap' }}>{loginError}</div>
            </Note>
          ) : (
            <div className="row" style={{ marginTop: 10, alignItems: 'center', gap: 10 }}>
              <Spinner label="正在等你在浏览器里完成登录（最多 15 分钟，不用回来点任何按钮）…" />
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  /*
                   * 取消：前端停止等待即可。
                   * ★ 后端那一次 `poll_login` 还在跑（它是阻塞命令），会在设备码
                   *   过期后自己结束 —— 它不会再动任何状态，结果只通过返回值交回来。
                   */
                  setDevice(null);
                  setBusy(false);
                }}
              >
                取消
              </Button>
            </div>
          )}
        </div>
      ) : null}

      {/* ---------- 动作 ---------- */}
      <div className="row row-wrap" style={{ marginTop: 'var(--space-3)' }}>
        <Button variant="primary" loading={busy} onClick={() => void startLogin()}>
          {loggedIn ? '重新登录 / 换账号' : '正版登录（微软账号）'}
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            const n = prompt('离线玩家名（英文、数字、下划线）', state.prefs.offlineUsername);
            if (n === null) return;
            /*
             * ★ 校验走 `domain/validate.ts`（与 Rust 侧逐条一致）——
             *   这里原来完全没有校验，中文名/带空格的名字会被当作
             *   `--username` 传给游戏，进服务器被拒而启动器一个字都不说。
             */
            void import('../domain/validate.ts').then(({ validate, offlineUsernameRules }) => {
              const name = n.trim();
              const why = validate(name, offlineUsernameRules());
              if (why) {
                toast('warning', '这个玩家名不能用', why);
                return;
              }
              window.dispatchEvent(
                new CustomEvent('ieml:prefs', {
                  detail: { offlineUsername: name, accountUuid: null },
                }),
              );
              toast('ok', '已切回离线模式', `玩家名：${name}`);
            });
          }}
        >
          使用离线模式
        </Button>
      </div>

      {!compact && msStatus?.available ? (
        <div className="field-hint" style={{ marginTop: 'var(--space-2)' }}>
          当前应用 ID：<span className="mono">{msStatus.client_id_preview}</span>
          {msStatus.offline_note ? ` · ${msStatus.offline_note}` : ''}
        </div>
      ) : null}
    </div>
  );
}
