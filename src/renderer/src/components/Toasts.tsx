import { dismissToast, useEditor } from '../editor/store'
import { Icon } from './Icon'

export function Toasts() {
  const toasts = useEditor((s) => s.toasts)
  const importing = useEditor((s) => s.importing)
  const jobs = Object.values(importing)
  return (
    <div className="toasts">
      {jobs.map((j) => (
        <div key={j.file} className="toast info">
          <span className="spinner" />
          <span>
            {j.stage === 'proxy' ? `Converting ${j.file} for preview` : `Importing ${j.file}`}
            {j.percent !== undefined ? ` · ${j.percent}%` : ` · ${j.stage}`}
          </span>
        </div>
      ))}
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.kind === 'error' && <Icon name="warning" />}
          <span className="toast-msg">{t.message}</span>
          <button className="icon-btn small" onClick={() => dismissToast(t.id)}>
            <Icon name="close" size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}
