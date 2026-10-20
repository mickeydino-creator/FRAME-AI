import { ReactNode, useEffect, useRef, useState } from 'react'
import { formatTimecode, parseTime } from '../../../shared/util'
import { Icon } from './Icon'

let mergeCounter = 0
export function newMergeKey(prefix: string): string {
  return `${prefix}-${++mergeCounter}`
}

// Remember which sections the user collapsed while switching between clips.
const sectionOpen = new Map<string, boolean>()

export function Section({ title, children, right, defaultOpen = true }: { title: string; children: ReactNode; right?: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpenState] = useState(sectionOpen.get(title) ?? defaultOpen)
  const setOpen = (v: boolean) => {
    sectionOpen.set(title, v)
    setOpenState(v)
  }
  return (
    <div className={`section ${open ? '' : 'closed'}`}>
      <div
        className="section-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setOpen(!open))}
      >
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} className="chev" />
        <span>{title}</span>
        <div className="spacer" />
        <div onClick={(e) => e.stopPropagation()}>{right}</div>
      </div>
      {open && <div className="section-body">{children}</div>}
    </div>
  )
}

export function Row({ label, children, extra }: { label: ReactNode; children: ReactNode; extra?: ReactNode }) {
  return (
    <div className="prop-row">
      <div className="prop-label">{label}</div>
      <div className="prop-value">{children}</div>
      {extra !== undefined && <div className="prop-extra">{extra}</div>}
    </div>
  )
}

interface NumberFieldProps {
  value: number
  onChange: (v: number, mergeKey: string) => void
  step?: number
  min?: number
  max?: number
  /** Display multiplier (e.g. 100 for percentages). */
  factor?: number
  precision?: number
  unit?: string
  label?: string
  disabled?: boolean
}

/** Numeric input with a scrubbable label (drag left/right to change). */
export function NumberField({ value, onChange, step = 1, min, max, factor = 1, precision = 0, unit, label, disabled }: NumberFieldProps) {
  const shown = (value * factor).toFixed(precision)
  const [text, setText] = useState(shown)
  const [focused, setFocused] = useState(false)
  const scrub = useRef<{ x: number; base: number; key: string } | null>(null)
  useEffect(() => {
    if (!focused) setText(shown)
  }, [shown, focused])

  const clampV = (v: number) => {
    if (min !== undefined) v = Math.max(min, v)
    if (max !== undefined) v = Math.min(max, v)
    return v
  }
  const commit = () => {
    const n = parseFloat(text)
    if (isFinite(n)) onChange(clampV(n / factor), newMergeKey('num'))
    else setText(shown)
  }
  return (
    <div className={`num-field ${disabled ? 'disabled' : ''}`}>
      {label && (
        <span
          className="scrub"
          onPointerDown={(e) => {
            if (disabled) return
            scrub.current = { x: e.clientX, base: value, key: newMergeKey('scrub') }
            ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
          }}
          onPointerMove={(e) => {
            const s = scrub.current
            if (!s) return
            const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1
            const v = s.base + (((e.clientX - s.x) * step) / factor) * mult
            onChange(clampV(Number(v.toFixed(6))), s.key)
          }}
          onPointerUp={() => (scrub.current = null)}
          title="Drag to adjust (Shift = faster, Alt = finer)"
          aria-label={label}
        >
          <Icon name="scrub" size={11} />
        </span>
      )}
      <input
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => {
          setFocused(true)
          e.target.select()
        }}
        onBlur={() => {
          setFocused(false)
          commit()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault()
            const dir = e.key === 'ArrowUp' ? 1 : -1
            const mult = e.shiftKey ? 10 : 1
            onChange(clampV(value + (dir * step * mult) / factor), newMergeKey('arrow'))
          }
        }}
      />
      {unit && <span className="unit">{unit}</span>}
    </div>
  )
}

export function TimeField({ value, fps, onChange, disabled }: { value: number; fps: number; onChange: (v: number) => void; disabled?: boolean }) {
  const shown = formatTimecode(value, fps)
  const [text, setText] = useState(shown)
  const [focused, setFocused] = useState(false)
  useEffect(() => {
    if (!focused) setText(shown)
  }, [shown, focused])
  return (
    <input
      className="time-field"
      value={text}
      disabled={disabled}
      onChange={(e) => setText(e.target.value)}
      onFocus={(e) => {
        setFocused(true)
        e.target.select()
      }}
      onBlur={() => {
        setFocused(false)
        const t = parseTime(text, fps)
        if (t !== null && t >= 0) onChange(t)
        else setText(shown)
      }}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      title="HH:MM:SS:FF or seconds"
    />
  )
}

function toHex(c: string): string {
  if (/^#[0-9a-f]{6}$/i.test(c)) return c
  if (/^#[0-9a-f]{3}$/i.test(c)) return `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c)
  if (m) return `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`
  return '#000000'
}

/** Color swatch + text field (accepts #hex and rgba()). */
export function ColorField({ value, onChange }: { value: string; onChange: (v: string, mergeKey: string) => void }) {
  const [text, setText] = useState(value)
  const key = useRef(newMergeKey('color'))
  useEffect(() => setText(value), [value])
  return (
    <div className="color-field">
      <input
        type="color"
        value={toHex(value)}
        onChange={(e) => onChange(e.target.value, key.current)}
        onBlur={() => (key.current = newMergeKey('color'))}
      />
      <input
        className="color-text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => (text.trim() ? onChange(text.trim(), newMergeKey('color')) : setText(value))}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        spellCheck={false}
      />
    </div>
  )
}

export function Select<T extends string | number>({
  value,
  options,
  onChange
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
}) {
  return (
    <select
      className="select"
      value={String(value)}
      onChange={(e) => {
        const raw = e.target.value
        const opt = options.find((o) => String(o.value) === raw)
        if (opt) onChange(opt.value)
      }}
    >
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function Toggle({ value, onChange, children, title }: { value: boolean; onChange: (v: boolean) => void; children: ReactNode; title?: string }) {
  return (
    <button className={`toggle ${value ? 'on' : ''}`} onClick={() => onChange(!value)} title={title}>
      {children}
    </button>
  )
}
