import type { User } from '@app/shared';
import { X } from 'lucide-react';
import {
  forwardRef,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode,
} from 'react';
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
}

export function Popover({ anchor, onClose, children, align = 'start', side = 'bottom', className = '' }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden', top: 0, left: 0 });

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !anchor) return;
    const place = (): void => {
      const rect = anchor.getBoundingClientRect();
      const width = node.offsetWidth;
      const height = node.offsetHeight;
      const margin = 8;
      let top = side === 'bottom' ? rect.bottom + 6 : rect.top - height - 6;
      if (side === 'bottom' && top + height > window.innerHeight - margin) top = rect.top - height - 6;
      if (top < margin) top = Math.min(rect.bottom + 6, window.innerHeight - height - margin);
      top = Math.max(margin, top);
      let left = align === 'start' ? rect.left : rect.right - width;
      left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
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

  useEffect(() => {
    const onPointer = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (ref.current?.contains(target) || anchor?.contains(target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
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

  return createPortal(
    <div ref={ref} className={`popover ${className}`} style={style} role="dialog">
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

export function Modal({ title, onClose, children, footer, width = 520, className = '' }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const target = node?.querySelector<HTMLElement>('[data-autofocus], input, textarea, select') ?? node;
    target?.focus();
    return () => previous?.focus?.();
  }, []);

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
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <header className="modal-head">
          <h2>{title}</h2>
          <IconButton label={S.close} onClick={onClose}>
            <X size={18} />
          </IconButton>
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-foot">{footer}</footer> : null}
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

export function Toasts() {
  const toasts = useStore((state) => state.toasts);
  if (toasts.length === 0) return null;
  return createPortal(
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((item) => (
        <div key={item.id} className={`toast toast-${item.kind}`}>
          {item.text}
        </div>
      ))}
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
