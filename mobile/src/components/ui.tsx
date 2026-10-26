import { type ButtonHTMLAttributes, type ReactNode, useEffect, useRef } from 'react'
import { openLayer } from '../lib/back.ts'
import { haptic } from '../lib/haptics.ts'
import { Icon, type IconName } from './icons.tsx'

/** While `open`, the back gesture closes this (and only this) first. */
export function useBackLayer(open: boolean, onClose: () => void): void {
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    if (!open) return
    return openLayer(() => close.current())
  }, [open])
}

type Tone = 'filled' | 'tonal' | 'outlined' | 'text' | 'danger'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: Tone
  icon?: IconName
  wide?: boolean
  /** A buzz when pressed: for the actions that matter. */
  feel?: 'tap' | 'confirm' | 'warn'
}

export function Button({ tone = 'tonal', icon, wide, feel, className = '', children, onClick, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={`btn ${tone} ${wide ? 'wide' : ''} ${className}`}
      onClick={e => {
        if (feel) haptic(feel)
        onClick?.(e)
      }}
      {...rest}
    >
      {icon && <Icon name={icon} size={18} />}
      {children}
    </button>
  )
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName
  label: string
  tone?: 'standard' | 'filled' | 'tonal' | 'danger'
  feel?: 'tap' | 'confirm' | 'warn'
}

export function IconButton({ icon, label, tone = 'standard', feel, className = '', onClick, type = 'button', ...rest }: IconButtonProps) {
  return (
    <button
      type={type}
      className={`icon-btn ${tone} ${className}`}
      aria-label={label}
      title={label}
      onClick={e => {
        if (feel) haptic(feel)
        onClick?.(e)
      }}
      {...rest}
    >
      <Icon name={icon} />
    </button>
  )
}

/** A top app bar: a title (with an optional subtitle node) and actions; a back arrow for sub-pages. */
export function TopBar({ title, sub, onBack, children }: { title: ReactNode; sub?: ReactNode; onBack?: () => void; children?: ReactNode }) {
  return (
    <header className="topbar">
      {onBack && <IconButton icon="back" label="Retour" onClick={onBack} />}
      <div className="topbar-title">
        <h1>{title}</h1>
        {sub && <div className="topbar-sub">{sub}</div>}
      </div>
      <div className="topbar-actions">{children}</div>
    </header>
  )
}

/** A modal sheet from the bottom. The scrim and the back gesture close it. */
export function Sheet({ open, onClose, title, children, label }: { open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; label?: string }) {
  useBackLayer(open, onClose)
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (open) panel.current?.focus()
  }, [open])
  if (!open) return null
  return (
    <div className="modal">
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <div className="sheet-panel" role="dialog" aria-modal="true" aria-label={label ?? (typeof title === 'string' ? title : 'Fenêtre')} tabIndex={-1} ref={panel}>
        <div className="grabber" aria-hidden="true" />
        {title && <h2 className="sheet-title">{title}</h2>}
        {children}
      </div>
    </div>
  )
}

/** A centred confirmation. Closing it (scrim, back gesture) is the same as "Annuler". */
export function Dialog({ open, onClose, title, children, actions }: { open: boolean; onClose: () => void; title: string; children?: ReactNode; actions: ReactNode }) {
  useBackLayer(open, onClose)
  if (!open) return null
  return (
    <div className="modal center">
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <div className="dialog" role="alertdialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children && <div className="dialog-body">{children}</div>}
        <div className="dialog-actions">{actions}</div>
      </div>
    </div>
  )
}

/** A row of a settings list: an icon, a title, a hint, and something at the end. */
export function ListItem({ icon, title, hint, end, onClick, danger }: { icon?: IconName; title: ReactNode; hint?: ReactNode; end?: ReactNode; onClick?: () => void; danger?: boolean }) {
  const body = (
    <>
      {icon && (
        <span className="li-icon">
          <Icon name={icon} />
        </span>
      )}
      <span className="li-text">
        <span className="li-title">{title}</span>
        {hint && <span className="li-hint">{hint}</span>}
      </span>
      {end && <span className="li-end">{end}</span>}
    </>
  )
  return onClick ? (
    <button type="button" className={`list-item ${danger ? 'danger' : ''}`} onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className={`list-item ${danger ? 'danger' : ''}`}>{body}</div>
  )
}

/** A Material switch (a real checkbox with the switch role: the keyboard and screen readers work). */
export function Switch({ checked, onChange, title, hint, icon, disabled }: { checked: boolean; onChange: (on: boolean) => void; title: ReactNode; hint?: ReactNode; icon?: IconName; disabled?: boolean }) {
  return (
    <label className={`list-item switch-row ${disabled ? 'disabled' : ''}`}>
      {icon && (
        <span className="li-icon">
          <Icon name={icon} />
        </span>
      )}
      <span className="li-text">
        <span className="li-title">{title}</span>
        {hint && <span className="li-hint">{hint}</span>}
      </span>
      <input
        type="checkbox"
        role="switch"
        className="switch"
        checked={checked}
        disabled={disabled}
        onChange={e => {
          haptic('tap')
          onChange(e.target.checked)
        }}
      />
    </label>
  )
}

/** One choice among a few, side by side. */
export function Segmented<T extends string | number>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map(o => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={o.value === value ? 'on' : ''}
          onClick={() => {
            if (o.value !== value) haptic('tap')
            onChange(o.value)
          }}
        >
          {o.value === value && <Icon name="check" size={16} />}
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** A titled group of rows, on a card. */
export function Group({ title, children, note }: { title?: string; children: ReactNode; note?: ReactNode }) {
  return (
    <section className="group">
      {title && <h2 className="group-title">{title}</h2>}
      <div className="group-card">{children}</div>
      {note && <p className="group-note">{note}</p>}
    </section>
  )
}

/** The colour dot and words for how the phone is connected to the PC. */
export function StatusChip({ tone, children, onClick }: { tone: 'ok' | 'warn' | 'off'; children: ReactNode; onClick?: () => void }) {
  const body = (
    <>
      <span className={`dot ${tone}`} aria-hidden="true" />
      {children}
    </>
  )
  return onClick ? (
    <button type="button" className="chip" onClick={onClick}>
      {body}
    </button>
  ) : (
    <span className="chip">{body}</span>
  )
}

export function Spinner({ label }: { label: string }) {
  return <span className="spinner" role="status" aria-label={label} />
}
