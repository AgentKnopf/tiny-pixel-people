import { PixelCanvas, type Color } from './canvas.ts';
import { P, ROOFS } from './palette.ts';

export const ICON = 16;

/**
 * Icons are drawn from character masks. Each mask is up to 16×16; '.' or ' ' is transparent.
 * An outline is added automatically, so masks stay one pixel inside the frame.
 */
interface IconDef {
  rows: string[];
  colors: Record<string, Color>;
  outline?: boolean;
}

const O = P.outline;
const Y = '#f2c94c';
const YL = '#fde6a0';
const YD = '#c89a2a';
const WH = '#fef7e5';
const GR = '#b9bdb6';
const RD = P.red;
const RL = P.redLight;
const BL = '#7cc6f2';
const BD = '#4a8ac0';
const GN = '#8fd16a';
const GD = '#4f8a3a';
const PK = '#e872b8';
const OR = '#f08a4b';
const BR = P.wood;
const BRD = P.woodDark;

export const ICONS: Record<string, IconDef> = {
  pause: {
    rows: [
      '',
      '',
      '',
      '   ww  ww',
      '   ww  ww',
      '   ww  ww',
      '   ww  ww',
      '   ww  ww',
      '   ww  ww',
      '   ww  ww',
      '   ww  ww',
    ],
    colors: { w: WH },
  },
  play: {
    rows: [
      '',
      '',
      '   w',
      '   ww',
      '   www',
      '   wwww',
      '   wwwww',
      '   wwwww',
      '   wwww',
      '   www',
      '   ww',
      '   w',
    ],
    colors: { w: WH },
  },
  fast: {
    rows: [
      '',
      '',
      '',
      '  w   w',
      '  ww  ww',
      '  www www',
      '  wwwwwwww',
      '  wwwwwwww',
      '  www www',
      '  ww  ww',
      '  w   w',
    ],
    colors: { w: WH },
  },
  zoom_in: {
    rows: [
      '',
      '',
      '',
      '      ww',
      '      ww',
      '      ww',
      '   wwwwwwww',
      '   wwwwwwww',
      '      ww',
      '      ww',
      '      ww',
    ],
    colors: { w: WH },
  },
  zoom_out: { rows: ['', '', '', '', '', '', '   wwwwwwww', '   wwwwwwww'], colors: { w: WH } },
  fit: {
    rows: [
      '',
      '',
      '  www  www',
      '  w      w',
      '  w      w',
      '',
      '',
      '',
      '',
      '  w      w',
      '  w      w',
      '  www  www',
    ],
    colors: { w: WH },
  },
  close: {
    rows: ['', '', '', '   w    w', '    w  w', '     ww', '     ww', '    w  w', '   w    w'],
    colors: { w: WH },
  },
  rain: {
    rows: [
      '',
      '    gggg',
      '   gwwwwgg',
      '  gwwwwwwwg',
      ' gwwwwwwwwwg',
      ' ggggggggggg',
      '',
      '  b  b  b',
      ' b  b  b',
      '  b  b  b',
      ' b  b  b',
    ],
    colors: { g: GR, w: WH, b: BL },
  },
  party: {
    rows: [
      '',
      '        y  p',
      '   b      y',
      '       p',
      '   r     b',
      '      yr',
      '     yyy',
      '    yrryy',
      '   yyryyy',
      '  yyryyyy',
      ' yryyyyy',
      ' yyyyyy',
    ],
    colors: { y: Y, r: RD, p: PK, b: BL },
  },
  stranger: {
    rows: [
      '        p',
      '       ppp',
      '      ppypp',
      '     ppppppp',
      '    ppppppppp',
      '   ppppppppppp',
      '     sssss',
      '     sosos',
      '     sssss',
      '    ppppppp',
      '   ppppppppp',
      '   ppppppppp',
      '   ppppppppp',
    ],
    colors: { p: '#6a5a9a', y: Y, s: '#e8b48e', o: O },
  },
  birthday: {
    rows: [
      '     y  y  y',
      '     r  r  r',
      '     r  r  r',
      '   wwwwwwwwww',
      '   wpwwpwwpww',
      '   wwwwwwwwww',
      '   pppppppppp',
      '   pppppppppp',
      '   wwwwwwwwww',
      '   pppppppppp',
      '   pppppppppp',
      '  bbbbbbbbbbbb',
    ],
    colors: { y: Y, r: RL, w: WH, p: PK, b: BR },
  },
  town_event: {
    rows: [
      '',
      '   r      r',
      '  rrrrrrrrrr',
      '  rrrrrrrrrr',
      '  wwwwwwwwww',
      '  wgwgwgwgww',
      '  wwwwwwwwww',
      '  wgwgwyywww',
      '  wwwwwyywww',
      '  wgwgwgwgww',
      '  wwwwwwwwww',
    ],
    colors: { r: RD, w: WH, g: GR, y: Y },
  },
  save: {
    rows: [
      '',
      '  bbbbbbbbbb',
      '  bwwwwwwwbb',
      '  bwwwwwwwbb',
      '  bbbbbbbbbb',
      '  bbbbbbbbbb',
      '  bbggggggbb',
      '  bbggggggbb',
      '  bbggggggbb',
      '  bbbbbbbbbb',
    ],
    colors: { b: BD, w: WH, g: GR },
  },
  map: {
    rows: [
      '',
      '  gggbbbbggg',
      '  gggbbbbggg',
      '  ggybbbgggg',
      '  gyyybbbggg',
      '  ggyggbbbgg',
      '  gggggggbbb',
      '  gggrggggbb',
      '  ggrrrgggbb',
      '  gggrgggggb',
    ],
    colors: { g: GN, b: BL, y: YL, r: RD },
  },
  home: {
    rows: [
      '       r',
      '      rrr',
      '     rrrrr',
      '    rrrrrrr',
      '   rrrrrrrrr',
      '  rrrrrrrrrrr',
      '   wwwwwwwww',
      '   wbbwwwbbw',
      '   wbbwddwbb',
      '   wwwwddwww',
      '   wwwwddwww',
    ],
    colors: { r: RD, w: P.wallCream, b: BL, d: BRD },
  },
  rumor: {
    rows: [
      '',
      '  wwwwwwwww',
      ' wwwwwwwwwww',
      ' ww.w.w.w.ww',
      ' wwwwwwwwwww',
      '  wwwwwwwww',
      '   ww',
      '  w',
      '',
      '        y',
      '       yyy',
      '        y',
    ],
    colors: { w: WH, '.': GR, y: Y },
  },
  note: {
    rows: [
      '     rr',
      '   wwwwwwww',
      '   wwwwwwww',
      '   wggggggw',
      '   wwwwwwww',
      '   wggggggw',
      '   wwwwwwww',
      '   wggggwww',
      '   wwwwwwww',
      '   wwwwwwgg',
      '   wwwwwwg',
    ],
    colors: { w: WH, g: GR, r: RD },
  },
  reply: {
    rows: [
      '',
      '',
      '  wwwwwwwwwwww',
      '  wwwwwwwwwwww',
      '  gwwwwwwwwwwg',
      '  wgwwwwwwwwgw',
      '  wwgwwwwwwgww',
      '  wwwggrrggwww',
      '  wwwwwrrwwwww',
      '  wwwwwwwwwwww',
    ],
    colors: { w: WH, g: GR, r: RD },
  },
  pin: {
    rows: [
      '',
      '     rrrr',
      '    rrrrrr',
      '    rrwwrr',
      '    rrwwrr',
      '    rrrrrr',
      '     rrrr',
      '      rr',
      '      rr',
      '      r',
    ],
    colors: { r: RD, w: WH },
  },
  heart: {
    rows: [
      '',
      '',
      '   pp   pp',
      '  pwpp ppppp',
      '  pwpppppppp',
      '  ppppppppp',
      '   ppppppp',
      '    ppppp',
      '     ppp',
      '      p',
    ],
    colors: { p: PK, w: '#ffffff' },
  },
  heart_empty: {
    rows: [
      '',
      '',
      '   pp   pp',
      '  p..p p..p',
      '  p...p...p',
      '  p.......p',
      '   p.....p',
      '    p...p',
      '     p.p',
      '      p',
    ],
    colors: { p: PK, '.': '#3a2a34' },
  },
  zzz: {
    rows: [
      '',
      '        wwww',
      '          w',
      '         w',
      '        wwww',
      '   www',
      '     w',
      '    w',
      '   www',
    ],
    colors: { w: WH },
    outline: true,
  },
  chat: {
    rows: [
      '',
      '  wwwwwwwwwww',
      ' wwwwwwwwwwwww',
      ' wwgwwgwwgwwww',
      ' wwwwwwwwwwwww',
      '  wwwwwwwwwww',
      '   ww',
      '  w',
    ],
    colors: { w: WH, g: O },
  },
  thinking: {
    rows: [
      '',
      '',
      '     bbbbb',
      '    bbbbbbb',
      '   bbwbbbbbb',
      '   bbbbbbbbb',
      '   bbbbbbbbb',
      '    bbbbbbb',
      '     bbbbb',
    ],
    colors: { b: BL, w: '#ffffff' },
  },
  star: {
    rows: [
      '',
      '      y',
      '      y',
      '     yyy',
      ' yyyyyyyyyyy',
      '  yyyyyyyyy',
      '   yyyyyyy',
      '   yyyyyyy',
      '  yyy   yyy',
      '  yy     yy',
    ],
    colors: { y: Y },
  },
  moon: {
    rows: ['', '     yyy', '    yyy', '   yyy', '   yyy', '   yyy', '   yyyy', '    yyyyy', '     yyyy'],
    colors: { y: YL },
  },
  sun: {
    rows: [
      '',
      '      y',
      '  y       y',
      '     yyy',
      '    yyyyy',
      ' y yyyyyyy y',
      '    yyyyy',
      '     yyy',
      '  y       y',
      '      y',
    ],
    colors: { y: Y },
  },
  coin: {
    rows: [
      '',
      '',
      '    dddddd',
      '   dyyyyyyd',
      '  dyylyyyyyd',
      '  dyylyddyyd',
      '  dyylydyyyd',
      '  dyyyyddyyd',
      '  dyyyyyyyyd',
      '   dyyyyyyd',
      '    dddddd',
    ],
    colors: { d: YD, y: Y, l: YL },
  },
  silver: {
    rows: [
      '',
      '',
      '    dddddd',
      '   dllllllld',
      '  dllwllllld',
      '  dllwlllllld',
      '  dllllllllld',
      '   dllllllld',
      '    dddddd',
    ],
    colors: { d: '#7a7a82', l: '#c8c8d0', w: '#ffffff' },
  },
  backpack: {
    rows: [
      '',
      '     dddd',
      '    d    d',
      '   rrrrrrrr',
      '  rrrrrrrrrr',
      '  rlrrrrrrrr',
      '  rlrdddddrr',
      '  rlryyyydrr',
      '  rrrdddddrr',
      '  rrrrrrrrrr',
      '  rrrrrrrrrr',
      '   rr    rr',
    ],
    colors: { d: P.redDark, r: RD, l: RL, y: Y },
  },
  paw: {
    rows: [
      '',
      '   o    o',
      '  ooo  ooo',
      '  ooo  ooo',
      ' o        o',
      'ooo oooo ooo',
      ' o oooooo o',
      '  oooooooo',
      '  oooooooo',
      '   oooooo',
    ],
    colors: { o: '#e8933e' },
  },
  decorate: {
    rows: [
      '',
      '',
      '   bbbbbbbb',
      '  bbbbbbbbbb',
      '  bllllllllb',
      '  bllllllllb',
      ' bbbbbbbbbbbb',
      ' bbbbbbbbbbbb',
      ' bbbbbbbbbbbb',
      ' dd        dd',
    ],
    colors: { b: ROOFS.teal!.base, l: ROOFS.teal!.light, d: BRD },
  },
  seed: {
    rows: [
      '',
      '',
      '      g',
      '     ggg  g',
      '   g  g  gg',
      '   gg g ggg',
      '    gggg',
      '      g',
      '      g',
      '   bbbbbbb',
      '  bbbbbbbbb',
    ],
    colors: { g: GN, b: P.soil },
  },
  bread: {
    rows: [
      '',
      '',
      '',
      '    bbbbbb',
      '  bbllllllbb',
      ' bllblllbllb',
      ' bllllllllllb',
      ' bllllllllllb',
      '  bbbbbbbbbb',
    ],
    colors: { b: '#a8682e', l: '#e0a858' },
  },
  honey: {
    rows: [
      '',
      '    bbbbbb',
      '    bbbbbb',
      '   wwwwwwww',
      '  wyyyyyyyyw',
      '  wylyyyyyyw',
      '  wyyyyyyyyw',
      '  wyyyyyyyyw',
      '  wyyyyyyyyw',
      '   wwwwwwww',
    ],
    colors: { b: BR, w: '#e8e0c8', y: '#e8a83a', l: YL },
  },
  flower: {
    rows: [
      '',
      '     p p',
      '    ppppp',
      '   ppyypp',
      '    ppppp',
      '     p p',
      '      g',
      '    g g',
      '     gg',
      '      g',
    ],
    colors: { p: PK, y: Y, g: GD },
  },
  gem: {
    rows: [
      '',
      '',
      '    bbbbbb',
      '   blllbbbb',
      '  blwllbbbbb',
      '   bllbbbbb',
      '    bbbbbb',
      '     bbbb',
      '      bb',
    ],
    colors: { b: '#4aa0c8', l: '#8ad0f0', w: '#ffffff' },
  },
  apple: {
    rows: [
      '',
      '      g',
      '     gg',
      '   rrr rrr',
      '  rlrrrrrrr',
      '  rlrrrrrrr',
      '  rrrrrrrrr',
      '  rrrrrrrrr',
      '   rrrrrrr',
      '    rr rr',
    ],
    colors: { r: RD, l: RL, g: GD },
  },
  hunger: {
    rows: [
      '',
      '',
      '',
      '   wwwwwwwwww',
      '  wooooooooooo',
      '  ooooooooooo',
      '  ooooooooooo',
      '   oooooooooo',
      '    oooooooo',
      '     oooooo',
    ],
    colors: { w: '#ffffff', o: OR },
  },
  energy: {
    rows: ['', '       yy', '      yy', '     yy', '    yyyyyy', '      yy', '     yy', '    yy', '   y'],
    colors: { y: BL },
  },
  social: {
    rows: [
      '',
      '  pp    pp',
      ' pppp  pppp',
      ' pppp  pppp',
      '  pp    pp',
      '',
      ' pppp  pppp',
      'pppppppppppp',
      'pppppppppppp',
    ],
    colors: { p: PK },
  },
  fun: {
    rows: [
      '',
      '       ggggg',
      '       g   g',
      '       g   g',
      '       g   g',
      '       g   g',
      '   gggg ggggg',
      '  ggggg ggggg',
      '  gggg  gggg',
    ],
    colors: { g: GN },
  },
  clock: {
    rows: [
      '',
      '    wwwwww',
      '   wwwwwwww',
      '  wwwwowwwww',
      '  wwwwowwwww',
      '  wwwwooowww',
      '  wwwwwwwwww',
      '  wwwwwwwwww',
      '   wwwwwwww',
      '    wwwwww',
    ],
    colors: { w: WH, o: O },
  },
  offline: {
    rows: ['', '      yy', '      yy', ' y   yyy', ' yyyyyyyyyyy', ' y   yyy', '      yy', '      yy'],
    colors: { y: Y },
  },
  model: {
    rows: [
      '',
      '  w w w w',
      ' gggggggggg',
      'wgbbbbbbbbgw',
      ' gbllbbbbbg',
      'wgbbbbbbbbgw',
      ' gbbbbbbbbg',
      'wgbbbbbbbbgw',
      ' gggggggggg',
      '  w w w w',
    ],
    colors: { w: GR, g: '#5a6a5a', b: '#3a7a5a', l: GN },
  },
  agents: {
    rows: [
      '',
      '     bbb',
      '    bsssb',
      '    sssss',
      '    sssss',
      '     sss',
      '   bbbbbbb',
      '  bbbbbbbbb',
      '  bbbbbbbbb',
    ],
    colors: { b: BL, s: '#e8b48e' },
  },
  cake: {
    rows: [
      '',
      '      y',
      '      r',
      '   wwwwwwww',
      '  wppwwppwww',
      '  pppppppppp',
      '  pppppppppp',
      '  wwwwwwwwww',
      '  pppppppppp',
    ],
    colors: { y: Y, r: RL, w: WH, p: '#a8682e' },
  },
  music: {
    rows: [
      '',
      '      ggggg',
      '      g   g',
      '      g   g',
      '      g   g',
      '   gggg gggg',
      '  ggggg ggggg',
      '  gggg  gggg',
    ],
    colors: { g: Y },
  },
  picnic: {
    rows: [
      '',
      '',
      '     bbbbb',
      '    b     b',
      '   rrrrrrrrr',
      '   rwrwrwrwr',
      '   rrrrrrrrr',
      '   rwrwrwrwr',
      '   rrrrrrrrr',
    ],
    colors: { b: BRD, r: RD, w: WH },
  },
};

export function drawIcon(def: IconDef): PixelCanvas {
  const c = new PixelCanvas(ICON, ICON);
  const b = new PixelCanvas(ICON, ICON);
  const h = def.rows.length;
  const top = Math.max(0, Math.floor((ICON - h) / 2));
  b.pattern(
    0,
    top,
    def.rows.map((r) => r.replaceAll(' ', ' ')),
    def.colors,
  );
  if (def.outline !== false) b.outline(O);
  c.blit(b, 0, 0);
  return c;
}

/** Soft warm radial light used for lamps and lit windows at night (draw with additive or screen blending). */
export function drawGlow(size = 64): PixelCanvas {
  const c = new PixelCanvas(size, size);
  const r = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - r, y + 0.5 - r) / r;
      if (d >= 1) continue;
      const a = Math.round((1 - d) ** 2 * 140);
      const step = Math.round(a / 20) * 20;
      if (step > 0) c.set(x, y, [253, 230, 160, step]);
    }
  }
  return c;
}
