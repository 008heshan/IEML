/**
 * UI 基础组件
 * ------------------------------------------------------------------
 * 与原设计稿最大的差别：**全部是真组件，不是静态 div**。
 * 原稿有 50 处可点击的 div/span/label，0 个 tabindex、0 个键盘处理，
 * 这里每个交互元素都是真 <button> 或带 role/tabindex/keydown 的元素。
 */
import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';

/* ====================== 按钮 ====================== */

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** 纯图标按钮必须给，否则屏幕阅读器读不出来 */
  iconOnly?: boolean;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', iconOnly, loading, className = '', children, disabled, ...rest },
  ref,
) {
  const cls = [
    'btn',
    `btn-${variant}`,
    `btn-${size}`,
    iconOnly ? 'btn-icon' : '',
    loading ? 'btn-loading' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      ref={ref}
      type="button"
      className={cls}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className="spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
});

/* ====================== 开关 ====================== */

interface SwitchProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  /** 无障碍名称 —— 原稿 4 个开关完全没有名字 */
  label: string;
  disabled?: boolean;
  id?: string;
}

export function Switch({ checked, onChange, label, disabled }: SwitchProps) {
  const auto = useId();
  const id = `sw-${auto}`;
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`switch${checked ? ' on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-knob" aria-hidden="true" />
    </button>
  );
}

/* ====================== 分段选择器 ====================== */

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  /** 不可用时的具体理由（禁止只说"不支持"） */
  disabledReason?: string;
}

interface SegmentedProps<T extends string> {
  value: T;
  options: Array<SegmentOption<T>>;
  onChange: (v: T) => void;
  /** 无障碍组名 */
  label: string;
  size?: 'sm' | 'md';
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  size = 'md',
}: SegmentedProps<T>) {
  return (
    <div className={`seg${size === 'sm' ? ' seg-sm' : ''}`} role="group" aria-label={label}>
      {options.map((o) => {
        const disabled = Boolean(o.disabledReason);
        return (
          <button
            key={o.value}
            type="button"
            className={value === o.value ? 'on' : ''}
            aria-pressed={value === o.value}
            disabled={disabled}
            title={o.disabledReason}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* ====================== 卡片 ====================== */

export function Card({
  children,
  className = '',
  padded = true,
  id,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
  /** ★ 给"从摘要跳过来"用（`InstanceSetup` 的 `.setup-summary`） */
  id?: string;
}) {
  return (
    <div id={id} className={`card${padded ? ' card-padded' : ''} ${className}`}>
      {children}
    </div>
  );
}

export function CardTitle({
  icon,
  children,
  hint,
  actions,
}: {
  icon?: ReactNode;
  children: ReactNode;
  hint?: ReactNode;
  /**
   * 右端动作（按钮）。★ 加上它是因为"这张卡最主要的动作"以前被放在卡片**底部**，
   * 用户得读完一屏说明才看到按钮 —— 比如「下载 Java 21」。放在标题行右侧，
   * 动作和它作用的对象在同一行，一眼就知道点它是干什么的。
   */
  actions?: ReactNode;
}) {
  return (
    <div className="card-title">
      {icon ? <span className="card-title-ic">{icon}</span> : null}
      <span>{children}</span>
      {hint || actions ? (
        <span className="card-tail">
          {hint ? <span className="card-hint">{hint}</span> : null}
          {actions ? <span className="card-actions">{actions}</span> : null}
        </span>
      ) : null}
    </div>
  );
}

/* ====================== 徽标 ====================== */

export type ChipTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

export function Chip({
  tone = 'neutral',
  children,
  onClick,
  title,
}: {
  tone?: ChipTone;
  children: ReactNode;
  onClick?: () => void;
  title?: string;
}) {
  if (onClick) {
    return (
      <button type="button" className={`chip chip-${tone} chip-btn`} onClick={onClick} title={title}>
        {children}
      </button>
    );
  }
  return (
    <span className={`chip chip-${tone}`} title={title}>
      {children}
    </span>
  );
}

/* ====================== 提示条 ====================== */

export type NoteTone = 'info' | 'warning' | 'danger' | 'success';

export function Note({
  tone = 'info',
  title,
  children,
  icon,
  actions,
}: {
  tone?: NoteTone;
  title?: ReactNode;
  children?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className={`note note-${tone}`}>
      {icon ? (
        <span className="note-ic" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <div className="note-body">
        {title ? <div className="note-title">{title}</div> : null}
        {children ? <div className="note-text">{children}</div> : null}
      </div>
      {actions ? <div className="note-actions">{actions}</div> : null}
    </div>
  );
}

/* ====================== 图标 ====================== */
/**
 * ★ 图标必须包一层 span 才能作为 flex 子项被正确约束。
 *   直接给 <svg> 写 class 也行，但 Tab 那种"图标 + 文字"的行内块里，
 *   svg 作为 flex item 会拿到 flex-shrink:1 并被压成 0 宽，于是文字换行。
 *   统一由这个组件兜住：固定 15px、不收缩。
 */
export function IconWrap({ children }: { children: ReactNode }) {
  return (
    <span className="ico" aria-hidden="true">
      {children}
    </span>
  );
}

/* ====================== 进度条 ====================== */

export function Progress({
  percent,
  indeterminate,
  label,
}: {
  percent?: number;
  indeterminate?: boolean;
  label: string;
}) {
  return (
    <div
      className={`progress${indeterminate ? ' indeterminate' : ''}`}
      role="progressbar"
      aria-label={label}
      aria-valuenow={indeterminate ? undefined : Math.round(percent ?? 0)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <i style={indeterminate ? undefined : { width: `${Math.min(100, Math.max(0, percent ?? 0))}%` }} />
    </div>
  );
}

/* ====================== 空状态 ====================== */

export function EmptyState({
  icon,
  title,
  desc,
  actions,
}: {
  icon?: ReactNode;
  title: string;
  desc?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="empty">
      {icon ? <div className="empty-ic">{icon}</div> : null}
      <h3>{title}</h3>
      {desc ? <p>{desc}</p> : null}
      {actions ? <div className="empty-actions">{actions}</div> : null}
    </div>
  );
}

/* ====================== 加载骨架 ====================== */

export function Skeleton({ rows = 3, height = 44 }: { rows?: number; height?: number }) {
  return (
    <div className="skeleton-list" aria-busy="true" aria-label="正在加载">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ height }} />
      ))}
    </div>
  );
}

/**
 * 转圈（用户要求："要是网络不佳，一时半会儿查不到，不想让困惑，
 * 就做个加载等待的动画，就像 windows 开机的那个转圈圈"）。
 *
 * ★ 为什么不用 Skeleton：骨架屏表达的是"这里会有一行行内容"，
 *   而"正在查在线清单"是在**一行文字的位置**等一个结论 ——
 *   骨架屏会让人以为已经有数据了。转圈 + 一句"在查什么"最直白。
 */
export function Spinner({ label, size = 14 }: { label?: ReactNode; size?: number }) {
  return (
    <span className="spinner-wrap" role="status" aria-live="polite">
      <span className="spinner-ring" style={{ width: size, height: size }} aria-hidden="true" />
      {label ? <span className="spinner-label">{label}</span> : null}
    </span>
  );
}

/* ====================== 表单行 ====================== */

export function Field({
  label,
  hint,
  children,
  htmlFor,
  /** 配置来源标签（跟随全局 / 已覆盖） */
  source,
  onToggleSource,
  rowId,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
  source?: 'inherit' | 'over';
  onToggleSource?: () => void;
  /**
   * ★ 行本身的 id —— 给"从摘要跳过来"用（`InstanceSetup`）。
   *   注意它和 `htmlFor` 是两件事：`htmlFor` 指向控件（点标签聚焦输入框），
   *   `rowId` 标的是**整行**（滚过去 + 闪一下）。
   */
  rowId?: string;
}) {
  return (
    <div className="field-row" id={rowId}>
      <label className="field-label" htmlFor={htmlFor}>
        {label}
        {hint ? <span className="field-hint">{hint}</span> : null}
      </label>
      <div className="field-control">{children}</div>
      {source && onToggleSource ? (
        <button
          type="button"
          className={`src-tag src-${source}`}
          onClick={onToggleSource}
          title={
            source === 'inherit'
              ? '当前跟随全局设置，点击改为单独设定'
              : '当前已单独设定，点击恢复跟随全局'
          }
        >
          {source === 'inherit' ? '跟随全局' : '已覆盖'}
        </button>
      ) : (
        <span />
      )}
    </div>
  );
}

/* ====================== 输入控件 ====================== */

export function TextInput({
  label,
  hint,
  source,
  onToggleSource,
  rowId,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: ReactNode;
  source?: 'inherit' | 'over';
  onToggleSource?: () => void;
  /** 整行的 id（见 `Field` 的说明） */
  rowId?: string;
}) {
  const auto = useId();
  const id = rest.id ?? `in-${auto}`;
  return (
    <Field
      label={label}
      hint={hint}
      htmlFor={id}
      source={source}
      onToggleSource={onToggleSource}
      rowId={rowId}
    >
      <input id={id} className="input" {...rest} />
    </Field>
  );
}

export function Select({
  label,
  hint,
  source,
  onToggleSource,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & {
  label: string;
  hint?: ReactNode;
  source?: 'inherit' | 'over';
  onToggleSource?: () => void;
}) {
  const auto = useId();
  const id = rest.id ?? `sel-${auto}`;
  return (
    <Field label={label} hint={hint} htmlFor={id} source={source} onToggleSource={onToggleSource}>
      <select id={id} className="input" {...rest}>
        {children}
      </select>
    </Field>
  );
}

/* ====================== 自定义下拉（替换原生 select） ====================== */
/**
 * 原生 <select> 的下拉菜单是浏览器画的，CSS 改不了 —— 选项挤在一起、
 * 灰底选中态，在深色主题下非常丑。这个组件用 div+button 模拟，
 * 样式完全可控。
 *
 * ★ 2026-09-15 补了两处被换掉时丢掉的东西：
 *   ① `ariaLabel` —— 原生 select 上写的 `aria-label="装到哪个版本"` 换成
 *      button 之后没有地方放了，屏幕阅读器只能读到当前值，读不到"这是什么"；
 *   ② 键盘：Esc 关闭、方向键在选项间移动（原生 select 本来就有，
 *      自绘的必须自己补回来，否则又是一个"键盘用户用不了"的控件）。
 */
export function CustomSelect({
  value,
  onChange,
  options,
  disabled,
  placeholder = '请选择',
  className = '',
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  /** 无障碍名称（原生 select 的 aria-label 位置） */
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value);
  /** 键盘高亮的那一项（-1 = 没在用键盘走） */
  const [cursor, setCursor] = useState(-1);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  /** 打开时把光标放到当前项上 */
  useEffect(() => {
    if (open) setCursor(options.findIndex((o) => o.value === value));
  }, [open, options, value]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (disabled) return;
    if (e.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      setOpen(true);
      return;
    }
    if (!open) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      const next = Math.min(options.length - 1, Math.max(0, cursor + dir));
      setCursor(next);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const pick = options[cursor];
      if (pick) {
        onChange(pick.value);
        setOpen(false);
      }
    }
  }

  /**
   * ★★ 面板朝上还是朝下开（2026-09-17 用户："java选择方式的下拉栏被遮挡了"）。
   *
   *   根因：`.content`（二级页面的滚动容器）带 `overflow-y: auto`，
   *   而 `.cs-menu` 是 `position: absolute` —— 面板一旦超出**容器**底部就被裁掉。
   *
   *   ★ 第一版修错了：量的是 `window.innerHeight`（视口）。
   *     但**视口比滚动容器大**（容器上面还有标题栏、下面还有别的东西），
   *     所以"视口底部还有空间"跟"容器底部还有空间"是两回事 ——
   *     量出来说下面够，实际早被容器裁没了，用户看到的还是被挡。
   *     **量哪个容器裁它，就得量哪个容器。**
   *
   *   所以这里先往上找**最近的可滚动祖先**，以它的边界为准。
   */
  const [dropUp, setDropUp] = useState(false);

  /** 往上找最近的可滚动祖先（没有就返回 null，退回视口） */
  function scrollParent(el: HTMLElement): HTMLElement | null {
    let p = el.parentElement;
    while (p) {
      const oy = getComputedStyle(p).overflowY;
      if (oy === 'auto' || oy === 'scroll' || oy === 'hidden') return p;
      p = p.parentElement;
    }
    return null;
  }

  function measureDrop() {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // 面板最大 280px（.cs-menu 的 max-height），再按项数估实际高度、留 20px 余量
    const need = Math.min(options.length * 36 + 8, 280) + 20;

    const sp = scrollParent(el);
    const box = sp ? sp.getBoundingClientRect() : null;
    const bottomLimit = box ? box.bottom : window.innerHeight;
    const topLimit = box ? box.top : 0;

    const below = bottomLimit - r.bottom;
    const above = r.top - topLimit;
    // 只有"下面确实不够、上面更宽裕"时才翻 —— 免得在页面中部莫名其妙朝上开
    setDropUp(below < need && above > below);
  }

  return (
    <div
      className={`cs ${className}`}
      ref={ref}
      data-open={open}
      data-drop={dropUp ? 'up' : 'down'}
      onKeyDown={onKeyDown}
    >
      <button
        type="button"
        className="cs-trigger input"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          if (!open) measureDrop();
          setOpen((o) => !o);
        }}
      >
        <span className="cs-label">{current?.label ?? placeholder}</span>
        <svg className="cs-arrow" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
          <path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
      {open ? (
        <div className="cs-menu" role="listbox" aria-label={ariaLabel}>
          {options.map((o, i) => (
            <div
              key={o.value}
              className="cs-option"
              role="option"
              aria-selected={o.value === value}
              data-active={o.value === value}
              data-cursor={i === cursor}
              onMouseEnter={() => setCursor(i)}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              {o.label}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ====================== 搜索框 ====================== */

export function SearchBox({
  value,
  onChange,
  placeholder,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  label: string;
}) {
  return (
    <div className="searchbox">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="11" cy="11" r="8" />
        <path d="m21 21-4.3-4.3" />
      </svg>
      <input
        type="search"
        value={value}
        aria-label={label}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

/* ====================== 模态框（带焦点陷阱） ====================== */

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  size = 'md',
  labelledBy,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'md' | 'lg' | 'xl';
  labelledBy?: string;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const auto = useId();
  const titleId = labelledBy ?? `modal-title-${auto}`;

  /* 焦点陷阱：Tab 循环留在弹窗内；打开时移入首元素，关闭时归还焦点 */
  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;

    const node = dialogRef.current;
    if (!node) return;
    const focusables = () =>
      Array.from(
        node.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null);

    const first = focusables()[0];
    first?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const list = focusables();
      if (list.length === 0) return;
      const firstEl = list[0]!;
      const lastEl = list[list.length - 1]!;
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };

    document.addEventListener('keydown', onKey, true);
    // 锁背景滚动
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prevOverflow;
      restoreRef.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={dialogRef}
        className={`modal${size === 'lg' ? ' modal-lg' : ''}${size === 'xl' ? ' modal-xl' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="modal-head">
          <div>
            <h2 className="modal-title" id={titleId}>
              {title}
            </h2>
            {subtitle ? <p className="modal-sub">{subtitle}</p> : null}
          </div>
          <Button variant="ghost" size="sm" iconOnly aria-label="关闭" onClick={onClose}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </Button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

/* ====================== Toast 容器（带 aria-live） ====================== */

export function ToastRegion({ children }: { children: ReactNode }) {
  return (
    <div className="toasts" role="status" aria-live="polite" aria-atomic="false">
      {children}
    </div>
  );
}
