import './styles.css'

const root = document.getElementById('root')!

if (location.hash === '#export') {
  // Hidden export window: no UI, just render frames.
  void import('./export/runExport').then((m) => m.runExport())
} else {
  void Promise.all([import('react-dom/client'), import('react'), import('./App')]).then(([dom, React, app]) => {
    dom.createRoot(root).render(React.createElement(app.App))
  })
}
