/** Bundled OFL fonts (assets/fonts, served from the web root). No CDN: the game must work offline. */
export const FONT_FACES: { family: string; url: string; weight: string }[] = [
  { family: 'Departure Mono', url: '/fonts/DepartureMono-Regular.woff2', weight: '400' },
  { family: 'Silkscreen', url: '/fonts/silkscreen-latin-400-normal.woff2', weight: '400' },
  { family: 'Silkscreen', url: '/fonts/silkscreen-latin-700-normal.woff2', weight: '700' },
];

/**
 * Register the bundled fonts with `document.fonts` so canvas text and CSS can use them by family
 * name. Resolves once they loaded (or failed; system monospace is the fallback), capped by `timeoutMs`.
 */
export async function loadFonts(timeoutMs = 3000): Promise<void> {
  if (typeof FontFace === 'undefined' || !document.fonts) return;
  const loads = FONT_FACES.map(async ({ family, url, weight }) => {
    try {
      const face = new FontFace(family, `url(${url}) format("woff2")`, { weight, display: 'block' });
      document.fonts.add(await face.load());
    } catch {
      // Missing font file: keep the fallback stack.
    }
  });
  await Promise.race([Promise.all(loads), new Promise((r) => setTimeout(r, timeoutMs))]);
}
