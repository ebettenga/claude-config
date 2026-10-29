// flow's logo (drawn in VectorCraft: assets/flow-logo.vectorcraft, exported to
// assets/flow-logo.svg): one line falling through three steps, in the colours
// of the run, python and model step kinds. Here as markup for the hub, the
// agents pane and the band to draw at any size.

export const LOGO_COLORS = { line: '#b794f6', dots: ['#6ea8e8', '#4fb3a5', '#f0a6ca'] } as const

const DOTS: [number, number][] = [
  [16, 14],
  [32, 32],
  [48, 50],
]

/**
 * The mark's shapes in its own 64×64 box. `ring` is the colour of the gap
 * around each dot (the page behind it); none at small sizes.
 */
function shapes(ring?: string): string {
  const line = `<path d="M16 14 C16 30 32 22 32 32 C32 42 48 34 48 50" fill="none" stroke="${LOGO_COLORS.line}" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>`
  const dots = DOTS.map(
    ([cx, cy], i) => `<circle cx="${cx}" cy="${cy}" r="7" fill="${LOGO_COLORS.dots[i]}"${ring ? ` stroke="${ring}" stroke-width="3"` : ''}/>`,
  ).join('')
  return line + dots
}

/** The mark at (x, y), `size` px square, inside another svg. */
export const logoMark = (x: number, y: number, size: number, ring?: string): string =>
  `<g transform="translate(${x} ${y}) scale(${size / 64})">${shapes(ring)}</g>`

/** The mark as its own svg, `size` px square. */
export const logoSvg = (size: number, ring?: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64"><title>flow</title>${shapes(ring)}</svg>`

/** The terminal's mark: three dots in the logo's colours. */
export const LOGO_TEXT_PARTS: { glyph: string; color: string }[] = LOGO_COLORS.dots.map(color => ({ glyph: '●', color }))
