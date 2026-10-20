/** The FRAME AI mark, identical to the app icon (resources/icon.svg) without its tile. */
export function LogoMark({ size = 18 }: { size?: number }) {
  return (
    <svg className="logo-mark" width={size} height={size} viewBox="176 176 672 672" aria-hidden>
      <path
        d="M232 400V232h168M624 232h168v168M792 624v168H624M400 792H232V624"
        fill="none"
        stroke="#3d8bff"
        strokeWidth={72}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x={400} y={400} width={224} height={224} rx={28} fill="#ececef" />
    </svg>
  )
}
