// flow's logo (drawn in VectorCraft: assets/flow-logo.vectorcraft, exported to
// assets/flow-logo.svg): one line falling through three steps, in the colours
// of the run, python and model step kinds. Here as markup for the hub, the
// agents pane and the band to draw at any size.
//
// Loading: designed in EffectCraft (assets/flow-logo-loading.ecproj, a 4 s
// loop) and ported here as CSS. The line dims to a track, a bright stretch of
// it (the comp's Trim Paths, as a dash on a 100-long path) runs from the first
// step to the last each second, and each dot pops as it arrives; after three
// of those the mark turns twice. The bar redraws every second, which restarts
// CSS animations, so each draw starts them at the clock's place in the loop.

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
function shapes(ring?: string, isLoading = false): string {
  const path = (extra: string) =>
    `<path d="M16 14 C16 30 32 22 32 32 C32 42 48 34 48 50" fill="none" stroke="${LOGO_COLORS.line}" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"${extra}/>`
  const line = isLoading ? path(' opacity="0.3"') + path(' pathLength="100" class="fl-p"') : path('')
  const dots = DOTS.map(
    ([cx, cy], i) =>
      `<circle cx="${cx}" cy="${cy}" r="7" fill="${LOGO_COLORS.dots[i]}"${ring ? ` stroke="${ring}" stroke-width="3"` : ''}${isLoading ? ` class="fl-d fl-d${i}"` : ''}/>`,
  ).join('')
  if (!isLoading) return line + dots
  // An empty 64×64 box keeps the turn centred while the dots pop.
  return `${loadingCss()}<g class="fl-s"><rect width="64" height="64" fill="none"/>${line}${dots}</g>`
}

// The comp's keys: the pulse's end runs 0→100 over 0–0.7 s and its start
// 0→100 over 0.15–0.85 s; each dot scales 100→128→100 over 0.1 s and 0.2 s,
// at 0, 0.35 and 0.7 s; the spin null turns 0→720° over 3.3–4 s, eased hard (85% influence).
const loadingCss = (now = Date.now()): string => {
  const at = (now % 4000) / 1000
  const delay = (offset: number) => `animation-delay:${-(at + offset).toFixed(3)}s`
  return `<style>
.fl-p{stroke-dasharray:0 200;animation:fl-pulse 1s linear infinite;${delay(0)}}
@keyframes fl-pulse{0%{stroke-dasharray:0 200;stroke-dashoffset:0}15%{stroke-dasharray:21.4 200;stroke-dashoffset:0}70%{stroke-dasharray:21.4 200;stroke-dashoffset:-78.6}85%,100%{stroke-dasharray:0 200;stroke-dashoffset:-100}}
.fl-d{transform-box:fill-box;transform-origin:center;animation:fl-pop 1s ease-in-out infinite}
.fl-d0{${delay(0)}}.fl-d1{${delay(0.65)}}.fl-d2{${delay(0.3)}}
@keyframes fl-pop{0%,30%,100%{transform:scale(1)}10%{transform:scale(1.28)}}
.fl-s{transform-box:fill-box;transform-origin:center;animation:fl-spin 4s infinite;${delay(0)}}
@keyframes fl-spin{0%,82.5%{transform:rotate(0);animation-timing-function:cubic-bezier(.85,0,.15,1)}100%{transform:rotate(720deg)}}
@media (prefers-reduced-motion: reduce){.fl-p,.fl-d,.fl-s{animation:none}.fl-p{stroke-dasharray:none}}
</style>`
}

/** The mark at (x, y), `size` px square, inside another svg; `isLoading` runs the pulse. */
export const logoMark = (x: number, y: number, size: number, ring?: string, isLoading = false): string =>
  `<g transform="translate(${x} ${y}) scale(${size / 64})">${shapes(ring, isLoading)}</g>`

/** The mark as its own svg, `size` px square; `isLoading` runs the pulse. */
export const logoSvg = (size: number, ring?: string, isLoading = false): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64"><title>flow</title>${shapes(ring, isLoading)}</svg>`

/** The terminal's mark: three dots in the logo's colours. */
export const LOGO_TEXT_PARTS: { glyph: string; color: string }[] = LOGO_COLORS.dots.map(color => ({ glyph: '●', color }))
