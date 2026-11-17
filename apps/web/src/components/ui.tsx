import type { User } from '@app/shared';
import { X } from 'lucide-react';
import {
  forwardRef,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { safeInsets } from '../lib/safeArea';
import { createPortal } from 'react-dom';
import { asset } from '../lib/api';
import { displayName, useStore } from '../lib/store';
import { S } from '../strings';

// ── Avatar ──────────────────────────────────────────────────────────────────

export function Avatar({ user, size = 36, presence = false }: { user: User | undefined; size?: number; presence?: boolean }) {
  const state = useStore((store) => (presence && user ? store.presence[user.id] : undefined));
  const source = user ? asset(size > 48 ? user.profile.image_192 : user.profile.image_72) : '';
  const radius = Math.max(4, Math.round(size * 0.24));
  return (
    <span className="avatar" style={{ width: size, height: size, borderRadius: radius }}>
      {source ? <img src={source} alt="" width={size} height={size} style={{ borderRadius: radius }} loading="lazy" /> : null}
      {presence && user && !user.is_bot ? (
        <span className={`presence ${state === 'active' ? 'on' : 'off'}`} title={state === 'active' ? S.profile.active : S.profile.away} />
      ) : null}
    </span>
  );
}

export function PresenceDot({ userId }: { userId: string }) {
  const state = useStore((store) => store.presence[userId]);
  return <span className={`presence inline ${state === 'active' ? 'on' : 'off'}`} />;
}

export function userLabel(user: User | undefined): string {
  return displayName(user);
}

// ── Buttons ─────────────────────────────────────────────────────────────────

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'default' | 'danger' | 'ghost' | 'brand';
  size?: 'sm' | 'md';
  busy?: boolean;
}

export function Button({ variant = 'default', size = 'md', busy = false, className = '', children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      className={`btn btn-${variant} btn-${size} ${busy ? 'is-busy' : ''} ${className}`}
      disabled={disabled || busy}
      {...rest}
    >
      {busy ? <span className="spinner" aria-hidden="true" /> : null}
      <span className="btn-label">{children}</span>
    </button>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  active?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, active = false, className = '', children, ...rest },
  ref,
) {
  return (
    <button ref={ref} type="button" className={`icon-btn ${active ? 'is-active' : ''} ${className}`} aria-label={label} title={label} {...rest}>
      {children}
    </button>
  );
});

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="spinner-row" role="status">
      <span className="spinner" aria-hidden="true" />
      {label ? <span>{label}</span> : null}
    </span>
  );
}

// ── Popover and menu ────────────────────────────────────────────────────────

interface PopoverProps {
  anchor: HTMLElement | null;
  onClose: () => void;
  children: ReactNode;
  /** Which edge of the anchor the popover lines up with. */
  align?: 'start' | 'end';
  /** Preferred side; it flips when there is no room. */
  side?: 'bottom' | 'top';
  className?: string;
  /**
   * `menu` (the default for a popover whose class names it a menu) follows the
   * ARIA menu pattern: focus starts on the first item, arrow keys, Home and End
   * move between items, Tab and Escape close it. Anything else is a labelled,
   * non-modal dialog when `label` is given.
   */
  role?: 'menu' | 'dialog';
  label?: string;
}

const MENU_ITEMS = '[role="menuitem"]:not([disabled]), [role="menuitemradio"]:not([disabled]), [role="menuitemcheckbox"]:not([disabled])';

export function Popover({ anchor, onClose, children, align = 'start', side = 'bottom', className = '', role, label }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden', top: 0, left: 0 });
  const menu = (role ?? (/\bmenu\b/.test(className) ? 'menu' : undefined)) === 'menu';

  // However it closes (a pick, Escape, a click elsewhere), focus that was inside goes back to the control that opened it.
  // A layout effect, so this runs while the popover is still in the document.
  useLayoutEffect(
    () => () => {
      const node = ref.current;
      if (node && node.contains(document.activeElement) && anchor?.isConnected) anchor.focus();
    },
    [anchor],
  );

  // A menu takes focus on its first item once it is visible, unless something inside already has it.
  useEffect(() => {
    if (!menu || style.visibility !== 'visible') return;
    const node = ref.current;
    if (!node || node.contains(document.activeElement)) return;
    node.querySelector<HTMLElement>(MENU_ITEMS)?.focus();
  }, [menu, style.visibility]);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !anchor) return;
    const place = (): void => {
      const rect = anchor.getBoundingClientRect();
      const width = node.offsetWidth;
      const height = node.offsetHeight;
      // Kept 8px inside the part of the screen the notch and the home indicator leave free.
      const safe = safeInsets();
      const minTop = 8 + safe.top;
      const maxBottom = window.innerHeight - 8 - safe.bottom;
      let top = side === 'bottom' ? rect.bottom + 6 : rect.top - height - 6;
      if (side === 'bottom' && top + height > maxBottom) top = rect.top - height - 6;
      if (top < minTop) top = Math.min(rect.bottom + 6, maxBottom - height);
      top = Math.max(minTop, top);
      let left = align === 'start' ? rect.left : rect.right - width;
      left = Math.max(8 + safe.left, Math.min(left, window.innerWidth - width - 8 - safe.right));
      setStyle({ top, left, visibility: 'visible' });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(node);
    window.addEventListener('resize', place);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [anchor, align, side]);

  // The button that opened it says so while it is open (a link opening a context menu keeps being a link).
  useEffect(() => {
    if (!anchor || !anchor.matches('button, [role="button"]')) return;
    if (!anchor.hasAttribute('aria-haspopup')) anchor.setAttribute('aria-haspopup', menu ? 'menu' : 'dialog');
    anchor.setAttribute('aria-expanded', 'true');
    return () => anchor.setAttribute('aria-expanded', 'false');
  }, [anchor, menu]);

  useEffect(() => {
    const onPointer = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (ref.current?.contains(target) || anchor?.contains(target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.isComposing) return;
      event.stopPropagation();
      onClose();
      anchor?.focus();
    };
    document.addEventListener('mousedown', onPointer, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onPointer, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [anchor, onClose]);

  const onMenuKey = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!menu) return;
    const items = [...(ref.current?.querySelectorAll<HTMLElement>(MENU_ITEMS) ?? [])];
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    const go = (next: number): void => {
      event.preventDefault();
      items[(next + items.length) % items.length]?.focus();
    };
    if (event.key === 'ArrowDown') go(index + 1);
    else if (event.key === 'ArrowUp') go(index < 0 ? items.length - 1 : index - 1);
    else if (event.key === 'Home') go(0);
    else if (event.key === 'End') go(items.length - 1);
    else if (event.key === 'Tab') {
      event.preventDefault();
      onClose();
      anchor?.focus();
    }
  };

  return createPortal(
    <div
      ref={ref}
      className={`popover ${className}`}
      style={style}
      role={menu ? 'menu' : label ? 'dialog' : undefined}
      aria-label={label}
      onKeyDown={onMenuKey}
    >
      {children}
    </div>,
    document.body,
  );
}

export function MenuItem({
  icon,
  label,
  onSelect,
  danger = false,
  hint,
}: {
  icon?: ReactNode;
  label: string;
  onSelect: () => void;
  danger?: boolean;
  hint?: string;
}) {
  return (
    <button type="button" role="menuitem" className={`menu-item ${danger ? 'is-danger' : ''}`} onClick={onSelect}>
      {icon ? <span className="menu-icon">{icon}</span> : null}
      <span className="menu-label">{label}</span>
      {hint ? <span className="menu-hint">{hint}</span> : null}
    </button>
  );
}

export function MenuDivider() {
  return <div className="menu-divider" role="separator" />;
}

// ── Modal ───────────────────────────────────────────────────────────────────

interface ModalProps {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  className?: string;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

export function Modal({ title, onClose, children, footer, width = 520, className = '' }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    // A dialog opened from a menu item finds focus already back on the menu's button (see Popover).
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    // The first field that can take focus (a hidden file input cannot), else the dialog itself.
    const fields = [...(node?.querySelectorAll<HTMLElement>('[data-autofocus], input:not([disabled]), textarea:not([disabled]), select:not([disabled])') ?? [])];
    const target = fields.find((field) => field.matches('[data-autofocus]') && field.getClientRects().length > 0) ?? fields.find((field) => field.getClientRects().length > 0) ?? node;
    target?.focus();
    return () => {
      if (previous && previous !== document.body && previous.isConnected) previous.focus();
    };
  }, []);

  /** Keep Tab inside the dialog. */
  const trap = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Tab' || !ref.current) return;
    // What Tab can reach: shown, and not taken out of the order (a roving group's other items).
    const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((item) => item.tabIndex >= 0 && (item.getClientRects().length > 0 || item === document.activeElement));
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className={`modal ${className}`}
        style={{ width }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={(event) => {
          // Esc while a Japanese, Chinese or Korean input method is converting cancels the conversion, not the dialog.
          if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
            event.stopPropagation();
            onClose();
          }
          trap(event);
        }}
      >
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <IconButton label={S.close} onClick={onClose}>
            <X size={18} />
          </IconButton>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

// ── Form pieces ─────────────────────────────────────────────────────────────

export function Field({ label, hint, error, children }: { label: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function CopyField({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-field">
      {label ? <span className="field-label">{label}</span> : null}
      <div className="copy-row">
        <input readOnly value={value} onFocus={(event) => event.currentTarget.select()} aria-label={label} />
        <Button
          size="sm"
          onClick={() => {
            void navigator.clipboard.writeText(value).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? S.copied : S.copy}
        </Button>
      </div>
    </div>
  );
}

/**
 * Toasts are read out: the live regions stay mounted (a region inserted with its
 * text is often missed by screen readers); errors interrupt, the rest wait.
 */
export function Toasts() {
  const toasts = useStore((state) => state.toasts);
  return createPortal(
    <div className="toasts">
      <div className="toast-region" role="status" aria-live="polite">
        {toasts
          .filter((item) => item.kind !== 'error')
          .map((item) => (
            <div key={item.id} className={`toast toast-${item.kind}`}>
              {item.text}
            </div>
          ))}
      </div>
      <div className="toast-region" role="alert" aria-live="assertive">
        {toasts
          .filter((item) => item.kind === 'error')
          .map((item) => (
            <div key={item.id} className={`toast toast-${item.kind}`}>
              {item.text}
            </div>
          ))}
      </div>
    </div>,
    document.body,
  );
}

/** The product mark: an open ring. */
export function Mark({ size = 28 }: { size?: number }) {
  return (
    <svg className="mark" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <path d="M46.6 21.2A18 18 0 1 0 50 32" fill="none" stroke="var(--accent)" strokeWidth="8" strokeLinecap="round" />
      <circle cx="49" cy="19" r="4.6" fill="currentColor" />
    </svg>
  );
}
