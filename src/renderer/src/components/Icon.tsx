const PATHS: Record<string, string> = {
  play: 'M5 3.5v9l8-4.5z',
  pause: 'M4.5 3h2.5v10H4.5zM9 3h2.5v10H9z',
  prev: 'M4 3v10M13 3.5v9L6 8z',
  next: 'M12 3v10M3 3.5v9L10 8z',
  stepBack: 'M10.5 3.5L6 8l4.5 4.5',
  stepFwd: 'M5.5 3.5L10 8l-4.5 4.5',
  undo: 'M5.5 4L2.5 7l3 3M3 7h6.5a3.5 3.5 0 010 7H7',
  redo: 'M10.5 4l3 3-3 3M13 7H6.5a3.5 3.5 0 000 7H9',
  save: 'M3 2.5h8l2.5 2.5v8.5H3zM5.5 2.5v3.5h5V2.5M5 13.5V9.5h6v4',
  export: 'M8 2v8M4.5 5.5L8 2l3.5 3.5M2.5 10v3.5h11V10',
  import: 'M8 10V2M4.5 6.5L8 10l3.5-3.5M2.5 10v3.5h11V10',
  scissors: 'M6 5.5L13 12M6 10.5L13 4M4.5 6.5a2 2 0 110-4 2 2 0 010 4zM4.5 13.5a2 2 0 110-4 2 2 0 010 4z',
  trash: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 9h6l.5-9',
  copy: 'M5.5 5.5h8v8h-8zM2.5 10.5v-8h8',
  magnet: 'M3.5 2.5v6a4.5 4.5 0 009 0v-6M3.5 5.5h3M9.5 5.5h3M6.5 2.5v6a1.5 1.5 0 003 0v-6',
  zoomIn: 'M7 3.5a3.5 3.5 0 110 7 3.5 3.5 0 010-7zM12.5 12.5L9.6 9.6M5.5 7h3M7 5.5v3',
  zoomOut: 'M7 3.5a3.5 3.5 0 110 7 3.5 3.5 0 010-7zM12.5 12.5L9.6 9.6M5.5 7h3',
  fit: 'M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10',
  eye: 'M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 6a2 2 0 110 4 2 2 0 010-4z',
  eyeOff: 'M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM2.5 2.5l11 11',
  volume: 'M2.5 6h2.5L8.5 3v10L5 10H2.5zM11 5.5a3.5 3.5 0 010 5M12.5 3.5a6 6 0 010 9',
  mute: 'M2.5 6h2.5L8.5 3v10L5 10H2.5zM10.5 6l4 4M14.5 6l-4 4',
  lock: 'M4 7.5h8v6H4zM5.5 7.5V5a2.5 2.5 0 015 0v2.5',
  unlock: 'M4 7.5h8v6H4zM5.5 7.5V5a2.5 2.5 0 014.8-1',
  plus: 'M8 3v10M3 8h10',
  close: 'M4 4l8 8M12 4l-8 8',
  video: 'M2 4h8.5v8H2zM10.5 7l3.5-2v6l-3.5-2',
  image: 'M2.5 3h11v10h-11zM2.5 11l3.5-3.5 3 3 2-2 2.5 2.5M10.5 5.5a1 1 0 100 2 1 1 0 000-2z',
  audio: 'M6 12V3.5l7-1.5V10.5M6 12a2 2 0 11-4 0 2 2 0 014 0zM13 10.5a2 2 0 11-4 0 2 2 0 014 0z',
  text: 'M3 4V2.5h10V4M8 2.5v11M6 13.5h4',
  shape: 'M2.5 2.5h6v6h-6zM11 8a3 3 0 110 6 3 3 0 010-6z',
  background: 'M2.5 2.5h11v11h-11zM2.5 9.5l11-7M2.5 13.5l11-7',
  template: 'M2.5 2.5h11v4h-11zM2.5 8.5h5v5h-5zM9.5 8.5h4v5h-4z',
  folder: 'M2 4h4.5l1.5 1.5h6v7.5H2z',
  file: 'M4 2h5.5L12 4.5V14H4zM9.5 2v2.5H12',
  diamond: 'M8 3l5 5-5 5-5-5z',
  warning: 'M8 2L14.5 13.5h-13zM8 6.5V9.5M8 11.5v.5',
  link: 'M6.5 9.5l3-3M5 7.5L3.5 9a2.5 2.5 0 003.5 3.5L8.5 11M11 8.5L12.5 7A2.5 2.5 0 009 3.5L7.5 5',
  alignLeft: 'M2.5 3.5h11M2.5 6.5h7M2.5 9.5h11M2.5 12.5h7',
  alignCenter: 'M2.5 3.5h11M4.5 6.5h7M2.5 9.5h11M4.5 12.5h7',
  alignRight: 'M2.5 3.5h11M6.5 6.5h7M2.5 9.5h11M6.5 12.5h7',
  transition: 'M2 3.5h6v9H2zM8 3.5l6 4.5-6 4.5',
  grip: 'M6 4h.01M10 4h.01M6 8h.01M10 8h.01M6 12h.01M10 12h.01',
  chevronDown: 'M4.5 6.5L8 10l3.5-3.5',
  chevronRight: 'M6.5 4.5L10 8l-3.5 3.5',
  scrub: 'M5 5.5L2.5 8 5 10.5M11 5.5l2.5 2.5-2.5 2.5M2.5 8h11',
  chat: 'M2.5 3.5h11v7.5H7l-3 2.5v-2.5H2.5z',
  send: 'M8 13V3.5M4 7.5l4-4 4 4',
  panelRight: 'M2.5 3h11v10h-11zM10 3v10',
  panelOpen: 'M2.5 3h11v10h-11zM10 3v10M6.5 6L4.5 8l2 2',
  logo: 'M2.5 5V2.5H5M11 2.5h2.5V5M13.5 11v2.5H11M5 13.5H2.5V11M6 6h4v4H6z'
}

export function Icon({ name, size = 16, className }: { name: string; size?: number; className?: string }) {
  const d = PATHS[name] ?? PATHS.file
  const filled = name === 'play' || name === 'pause' || name === 'diamond'
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={filled ? 0 : name === 'grip' ? 2.2 : 1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={d} />
    </svg>
  )
}
