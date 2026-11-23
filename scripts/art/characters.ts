import { PixelCanvas, mix, type Color } from './canvas.ts';
import { P } from './palette.ts';

export const FRAME = 16;
/** Frames are taller than a tile so hats and hair fit; the feet sit on the bottom tile (anchor x 8, y 22). */
export const FRAME_H = 24;
const YOFF = 7;
export const DIRECTIONS = ['down', 'left', 'right', 'up'] as const;
export const FRAMES_PER_DIRECTION = 4;

type Hair = 'short' | 'long' | 'bun' | 'ponytail' | 'spiky' | 'bald' | 'curly' | 'bob';
type Hat = 'none' | 'cap' | 'chef' | 'straw' | 'beanie' | 'wizard' | 'bow';

export interface CharacterLook {
  key: string;
  description: string;
  suggestedRole: string;
  skin: string;
  hair: string;
  hairStyle: Hair;
  shirt: string;
  pants: string;
  shoes?: string;
  hat?: Hat;
  hatColor?: string;
  apron?: string;
  beard?: boolean;
  glasses?: boolean;
}

const SKIN = ['#f6d2b0', '#e8b48e', '#c98d64', '#9a6644', '#6e4630'] as const;

export const CHARACTERS: CharacterLook[] = [
  {
    key: 'villager-01',
    description: 'white chef hat, white apron over red shirt',
    suggestedRole: 'baker',
    skin: SKIN[1],
    hair: '#6a3f28',
    hairStyle: 'short',
    shirt: '#c85a46',
    pants: '#4a4a62',
    hat: 'chef',
    hatColor: '#fbf6ea',
    apron: '#f4eee0',
  },
  {
    key: 'villager-02',
    description: 'straw hat, green shirt, brown trousers',
    suggestedRole: 'gardener / farmer',
    skin: SKIN[2],
    hair: '#3a2a20',
    hairStyle: 'short',
    shirt: '#5f9a48',
    pants: '#7a5436',
    hat: 'straw',
    hatColor: '#e8c870',
  },
  {
    key: 'villager-03',
    description: 'long blonde hair, pink dress',
    suggestedRole: 'florist',
    skin: SKIN[0],
    hair: '#e8c060',
    hairStyle: 'long',
    shirt: '#e682aa',
    pants: '#e682aa',
  },
  {
    key: 'villager-04',
    description: 'grey beard, glasses, brown coat',
    suggestedRole: 'retired teacher / librarian',
    skin: SKIN[1],
    hair: '#c8c4bc',
    hairStyle: 'bald',
    shirt: '#8a6444',
    pants: '#4e4a44',
    beard: true,
    glasses: true,
  },
  {
    key: 'villager-05',
    description: 'dark bun, teal blouse',
    suggestedRole: 'shopkeeper',
    skin: SKIN[3],
    hair: '#241a18',
    hairStyle: 'bun',
    shirt: '#3e9a94',
    pants: '#3a3e58',
  },
  {
    key: 'villager-06',
    description: 'red cap, yellow shirt, blue jeans',
    suggestedRole: 'courier / postman',
    skin: SKIN[2],
    hair: '#5a3424',
    hairStyle: 'short',
    shirt: '#e8c24a',
    pants: '#4a6aa0',
    hat: 'cap',
    hatColor: '#c84a3a',
  },
  {
    key: 'villager-07',
    description: 'ginger ponytail, purple top',
    suggestedRole: 'musician',
    skin: SKIN[0],
    hair: '#d0703a',
    hairStyle: 'ponytail',
    shirt: '#8a62b0',
    pants: '#3a3448',
  },
  {
    key: 'villager-08',
    description: 'spiky black hair, orange hoodie',
    suggestedRole: 'student / kid',
    skin: SKIN[1],
    hair: '#1e1a20',
    hairStyle: 'spiky',
    shirt: '#e8823a',
    pants: '#3a4a5a',
  },
  {
    key: 'villager-09',
    description: 'curly brown hair, blue shirt, beard',
    suggestedRole: 'carpenter',
    skin: SKIN[4],
    hair: '#2a1c16',
    hairStyle: 'curly',
    shirt: '#4a78b8',
    pants: '#6a5038',
    beard: true,
  },
  {
    key: 'villager-10',
    description: 'white bob hair, lavender cardigan, glasses',
    suggestedRole: 'grandmother / storyteller',
    skin: SKIN[0],
    hair: '#ece8e0',
    hairStyle: 'bob',
    shirt: '#b49ad0',
    pants: '#5a5068',
    glasses: true,
  },
  {
    key: 'villager-11',
    description: 'green beanie, brown jacket',
    suggestedRole: 'fisher / painter',
    skin: SKIN[2],
    hair: '#4a3020',
    hairStyle: 'short',
    shirt: '#9a6a3e',
    pants: '#3a4a3a',
    hat: 'beanie',
    hatColor: '#4f8a52',
  },
  {
    key: 'villager-12',
    description: 'long black hair, white shirt, red skirt',
    suggestedRole: 'barista / café owner',
    skin: SKIN[3],
    hair: '#18141a',
    hairStyle: 'long',
    shirt: '#f2ece0',
    pants: '#b8463a',
    apron: '#7a4a30',
  },
  {
    key: 'villager-13',
    description: 'blonde short hair, mint shirt',
    suggestedRole: 'doctor / nurse',
    skin: SKIN[0],
    hair: '#e8d08a',
    hairStyle: 'short',
    shirt: '#9ad4c0',
    pants: '#5a6a7a',
  },
  {
    key: 'villager-14',
    description: 'auburn bun, mustard dress, bow',
    suggestedRole: 'tailor',
    skin: SKIN[1],
    hair: '#8a3a2a',
    hairStyle: 'bun',
    shirt: '#d4a23a',
    pants: '#d4a23a',
    hat: 'bow',
    hatColor: '#c84a6a',
  },
  {
    key: 'villager-15',
    description: 'curly black hair, red overalls',
    suggestedRole: 'blacksmith / mechanic',
    skin: SKIN[4],
    hair: '#141010',
    hairStyle: 'curly',
    shirt: '#e8dcc0',
    pants: '#b04a3a',
    apron: '#b04a3a',
  },
  {
    key: 'villager-16',
    description: 'silver ponytail, navy coat',
    suggestedRole: 'mayor',
    skin: SKIN[2],
    hair: '#b8b8c0',
    hairStyle: 'ponytail',
    shirt: '#34406a',
    pants: '#2a2e40',
    glasses: true,
  },
  {
    key: 'villager-17',
    description: 'brown bob, sky-blue dress',
    suggestedRole: 'teacher',
    skin: SKIN[3],
    hair: '#5a3a26',
    hairStyle: 'bob',
    shirt: '#7ab4e0',
    pants: '#7ab4e0',
  },
  {
    key: 'villager-18',
    description: 'bald, big beard, green apron',
    suggestedRole: 'grocer',
    skin: SKIN[1],
    hair: '#7a4a2a',
    hairStyle: 'bald',
    shirt: '#c8b8a0',
    pants: '#4a4038',
    beard: true,
    apron: '#4f8a52',
  },
  {
    key: 'villager-19',
    description: 'pink spiky hair, black tee',
    suggestedRole: 'artist',
    skin: SKIN[0],
    hair: '#e87aa8',
    hairStyle: 'spiky',
    shirt: '#2e2a34',
    pants: '#5a5a6a',
  },
  {
    key: 'villager-20',
    description: 'grey curly hair, olive vest',
    suggestedRole: 'beekeeper',
    skin: SKIN[2],
    hair: '#9a968e',
    hairStyle: 'curly',
    shirt: '#8a8a3e',
    pants: '#5a4a38',
    hat: 'straw',
    hatColor: '#d8b860',
  },
  {
    key: 'laude',
    description: 'Laude the postmaster: blue post cap, blue jacket, round glasses, satchel strap',
    suggestedRole: 'postmaster (Laude)',
    skin: SKIN[1],
    hair: '#7a5a3a',
    hairStyle: 'short',
    shirt: '#3f6aa0',
    pants: '#2e3a50',
    hat: 'cap',
    hatColor: '#2e507c',
    apron: '#c89a52',
    glasses: true,
  },
  {
    key: 'franzi',
    description: 'Franzi: chestnut bob with a pink flower bow, sage-green dress',
    suggestedRole: 'villager (Franzi)',
    skin: SKIN[0],
    hair: '#7a3e26',
    hairStyle: 'bob',
    shirt: '#8ab48a',
    pants: '#8ab48a',
    hat: 'bow',
    hatColor: '#ee8fb4',
  },
  {
    key: 'player',
    description: 'player avatar: yellow shirt with star, dark hair',
    suggestedRole: 'player',
    skin: SKIN[1],
    hair: '#2a2430',
    hairStyle: 'short',
    shirt: '#f2c94c',
    pants: '#3a5a8a',
  },
  {
    key: 'stranger',
    description: 'hooded traveller in a purple cloak with a wizard hat',
    suggestedRole: 'event: stranger',
    skin: SKIN[2],
    hair: '#3a3a3a',
    hairStyle: 'long',
    shirt: '#5a4a7a',
    pants: '#5a4a7a',
    hat: 'wizard',
    hatColor: '#4a3a6a',
    beard: true,
  },
];

/** Leg/arm swing and body bob for walk frames 0..3 (0 and 2 are the contact poses). */
const WALK = [
  { bob: 0, legL: 0, legR: 0, arm: 0 },
  { bob: -1, legL: -1, legR: 1, arm: 1 },
  { bob: 0, legL: 0, legR: 0, arm: 0 },
  { bob: -1, legL: 1, legR: -1, arm: -1 },
];

function drawFrame(look: CharacterLook, dir: (typeof DIRECTIONS)[number], frame: number): PixelCanvas {
  const c = new PixelCanvas(FRAME, FRAME_H);
  const b = new PixelCanvas(FRAME, FRAME_H);
  const pose = WALK[frame]!;
  const oy = pose.bob;
  const skinDark = mix(look.skin, '#5a3020', 0.25);
  const shirtDark = mix(look.shirt, '#000000', 0.25);
  const hairLight = mix(look.hair, '#ffffff', 0.25);
  const pantsDark = mix(look.pants, '#000000', 0.3);
  const shoes = look.shoes ?? '#3a2a22';
  const side = dir === 'left' || dir === 'right';
  const flip = dir === 'left';
  const px = (x: number, y: number, col: Color) => b.set(flip ? FRAME - 1 - x : x, y + oy + YOFF, col);
  const rect = (x: number, y: number, w: number, h: number, col: Color) => {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) px(xx, yy, col);
  };

  // legs and shoes: the planted foot stays on the ground row while the body bobs
  const footY = (lift: number) => 14 - oy - lift;
  const liftL = pose.legL < 0 ? 1 : 0;
  const liftR = pose.legR < 0 ? 1 : 0;
  if (side) {
    const l = pose.legL;
    rect(6 - l, 12, 2, footY(liftL) - 12, pantsDark);
    rect(8 + l, 12, 2, footY(liftR) - 12, look.pants);
    rect(6 - l, footY(liftL), 2, 1, shoes);
    rect(8 + l, footY(liftR), 3, 1, shoes);
  } else {
    rect(5, 12, 2, footY(liftL) - 12, look.pants);
    rect(9, 12, 2, footY(liftR) - 12, look.pants);
    rect(5, footY(liftL), 2, 1, shoes);
    rect(9, footY(liftR), 2, 1, shoes);
  }
  // body
  rect(4, 9, 8, 4, look.shirt);
  rect(4, 12, 8, 1, shirtDark);
  if (look.apron && dir !== 'up') rect(side ? 7 : 5, 10, side ? 4 : 6, 3, look.apron);
  if (look.key === 'player' && dir === 'down') {
    px(7, 10, '#ffffff');
    px(8, 10, '#ffffff');
    px(7, 11, '#ffffff');
    px(8, 11, '#ffffff');
  }
  // arms
  if (side) {
    rect(7 + pose.arm, 10, 2, 2, shirtDark);
    px(7 + pose.arm, 12, look.skin);
  } else {
    rect(3, 9 + Math.max(0, pose.arm), 1, 3, shirtDark);
    rect(12, 9 + Math.max(0, -pose.arm), 1, 3, shirtDark);
    px(3, 12 + Math.max(0, pose.arm), look.skin);
    px(12, 12 + Math.max(0, -pose.arm), look.skin);
  }
  // head
  rect(3, 2, 10, 7, look.skin);
  rect(4, 1, 8, 1, look.skin);
  rect(3, 8, 10, 1, skinDark);
  if (dir === 'down') {
    px(5, 5, P.outline);
    px(5, 6, P.outline);
    px(10, 5, P.outline);
    px(10, 6, P.outline);
    px(4, 7, '#f0a0a0');
    px(11, 7, '#f0a0a0');
    if (look.glasses) {
      rect(4, 5, 3, 1, '#2a2a3a');
      rect(9, 5, 3, 1, '#2a2a3a');
      px(7, 5, '#2a2a3a');
      px(8, 5, '#2a2a3a');
    }
    if (look.beard)
      rect(
        4,
        7,
        8,
        2,
        look.hair === '#c8c4bc' || look.hairStyle === 'bald' ? mix(look.hair, '#ffffff', 0.2) : look.hair,
      );
  } else if (side) {
    px(10, 5, P.outline);
    px(10, 6, P.outline);
    px(12, 6, skinDark);
    if (look.glasses) rect(9, 5, 3, 1, '#2a2a3a');
    if (look.beard) rect(8, 7, 5, 2, look.hairStyle === 'bald' ? mix(look.hair, '#ffffff', 0.2) : look.hair);
  }
  // hair
  const hair = look.hair;
  const back = dir === 'up';
  switch (look.hairStyle) {
    case 'bald':
      rect(4, 1, 8, 1, mix(look.skin, '#ffffff', 0.2));
      if (!side || back) {
        rect(3, 3, 1, 3, hair);
        rect(12, 3, 1, 3, hair);
      } else rect(3, 3, 3, 3, hair);
      if (back) rect(3, 4, 10, 3, hair);
      break;
    default: {
      rect(3, 0, 10, 3, hair);
      rect(4, 0, 6, 1, hairLight);
      if (dir === 'down') {
        rect(3, 3, 1, 2, hair);
        rect(12, 3, 1, 2, hair);
        if (look.hairStyle === 'spiky') {
          px(4, 3, hair);
          px(7, 3, hair);
          px(10, 3, hair);
        }
      } else if (side) {
        rect(3, 3, 5, 3, hair);
        rect(3, 6, 2, 1, hair);
      } else {
        rect(3, 3, 10, 5, hair);
        rect(5, 2, 5, 1, hairLight);
      }
      if (look.hairStyle === 'spiky') {
        px(3, -1, hair);
        px(6, -1, hair);
        px(9, -1, hair);
        px(12, -1, hair);
      }
      if (look.hairStyle === 'long') {
        if (dir === 'down') {
          rect(2, 3, 2, 7, hair);
          rect(12, 3, 2, 7, hair);
        } else if (side) rect(2, 3, 5, 7, hair);
        else rect(3, 3, 10, 8, hair);
      }
      if (look.hairStyle === 'bob') {
        if (dir === 'down') {
          rect(2, 3, 2, 5, hair);
          rect(12, 3, 2, 5, hair);
        } else if (side) rect(2, 3, 5, 5, hair);
        else rect(2, 3, 12, 6, hair);
      }
      if (look.hairStyle === 'curly') {
        rect(2, 1, 12, 3, hair);
        px(2, 4, hair);
        px(13, 4, hair);
        px(5, 0, hairLight);
        px(9, 0, hairLight);
      }
      if (look.hairStyle === 'bun') rect(6, -2, 4, 2, hair);
      if (look.hairStyle === 'ponytail') {
        if (side) rect(1, 3, 2, 5, hair);
        else if (back) rect(7, 7, 2, 4, hair);
        else {
          px(13, 4, hair);
          px(13, 5, hair);
        }
      }
    }
  }
  // hats
  const hc = look.hatColor ?? '#c84a3a';
  const hcDark = mix(hc, '#000000', 0.25);
  switch (look.hat ?? 'none') {
    case 'cap':
      rect(3, -1, 10, 3, hc);
      if (dir === 'down') rect(3, 2, 10, 1, hcDark);
      else if (side) rect(10, 2, 4, 1, hcDark);
      break;
    case 'chef':
      rect(4, -3, 8, 4, hc);
      rect(3, -2, 10, 2, hc);
      rect(4, 1, 8, 1, mix(hc, '#000000', 0.12));
      break;
    case 'straw':
      rect(1, 1, 14, 1, hc);
      rect(4, -1, 8, 2, hc);
      rect(4, 0, 8, 1, mix(hc, '#a05a2a', 0.5));
      break;
    case 'beanie':
      rect(3, -1, 10, 3, hc);
      rect(3, 2, 10, 1, hcDark);
      px(7, -2, hcDark);
      px(8, -2, hcDark);
      break;
    case 'wizard':
      rect(2, 1, 12, 1, hc);
      rect(4, -1, 8, 2, hc);
      rect(5, -3, 5, 2, hc);
      rect(7, -5, 2, 2, hc);
      px(6, -1, '#f2c94c');
      break;
    case 'bow':
      if (!back) {
        rect(10, -1, 2, 2, hc);
        rect(13, -1, 2, 2, hc);
        px(12, 0, hcDark);
      } else {
        rect(6, 0, 2, 2, hc);
        rect(9, 0, 2, 2, hc);
        px(8, 1, hcDark);
      }
      break;
    case 'none':
      break;
  }
  b.outline(P.outline);
  c.ellipse(8, 15 + YOFF, 5, 1, P.shadow);
  c.blit(b, 0, 0);
  return c;
}

/** One sheet per character: 4 columns (walk frames) × 4 rows (down, left, right, up), 16×24 each. */
export function drawCharacterSheet(look: CharacterLook): PixelCanvas {
  const sheet = new PixelCanvas(FRAME * FRAMES_PER_DIRECTION, FRAME_H * DIRECTIONS.length);
  DIRECTIONS.forEach((dir, row) => {
    for (let f = 0; f < FRAMES_PER_DIRECTION; f++)
      sheet.blit(drawFrame(look, dir, f), f * FRAME, row * FRAME_H);
  });
  return sheet;
}

/** Pet "Pip": a small orange cat, same sheet layout as characters. */
export function drawPetSheet(): PixelCanvas {
  const sheet = new PixelCanvas(FRAME * FRAMES_PER_DIRECTION, FRAME_H * DIRECTIONS.length);
  const fur = '#e8933e';
  const furLight = '#f6b868';
  const furDark = '#b8662a';
  DIRECTIONS.forEach((dir, row) => {
    for (let f = 0; f < FRAMES_PER_DIRECTION; f++) {
      const c = new PixelCanvas(FRAME, FRAME_H);
      const b = new PixelCanvas(FRAME, FRAME_H);
      const bob = f % 2 === 1 ? -1 : 0;
      const step = f === 1 ? 1 : f === 3 ? -1 : 0;
      const flip = dir === 'left';
      const px = (x: number, y: number, col: Color) => b.set(flip ? FRAME - 1 - x : x, y + YOFF, col);
      const rect = (x: number, y: number, w: number, h: number, col: Color) => {
        for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) px(xx, yy, col);
      };
      if (dir === 'left' || dir === 'right') {
        rect(3, 9 + bob, 8, 4, fur);
        rect(4, 9 + bob, 6, 1, furLight);
        rect(4 + step, 13, 1, 2, furDark);
        rect(9 - step, 13, 1, 2, furDark);
        rect(9, 5 + bob, 5, 5, fur);
        px(9, 4 + bob, fur);
        px(13, 4 + bob, fur);
        px(12, 7 + bob, P.outline);
        px(14, 8 + bob, '#f0a0a0');
        rect(1, 6 + bob, 1, 4, fur);
        px(2, 10 + bob, fur);
        px(1, 5 + bob, furDark);
      } else {
        rect(4, 8 + bob, 8, 5, fur);
        rect(4, 13, 2, 2, furDark);
        rect(10, 13, 2, 2, furDark);
        if (step !== 0) rect(step > 0 ? 4 : 10, 14, 2, 1, [0, 0, 0, 0]);
        rect(4, 3 + bob, 8, 6, fur);
        px(4, 2 + bob, fur);
        px(11, 2 + bob, fur);
        if (dir === 'down') {
          px(6, 5 + bob, P.outline);
          px(9, 5 + bob, P.outline);
          px(7, 7 + bob, '#f0a0a0');
          px(8, 7 + bob, '#f0a0a0');
          rect(6, 9 + bob, 4, 3, furLight);
        } else {
          rect(5, 4 + bob, 6, 1, furDark);
          rect(7, 9 + bob, 2, 4, furDark);
          rect(8, 13 + bob, 1, 2, fur);
        }
      }
      b.outline(P.outline);
      c.ellipse(8, 15 + YOFF, 5, 1, P.shadow);
      c.blit(b, 0, 0);
      sheet.blit(c, f * FRAME, row * FRAME_H);
    }
  });
  return sheet;
}
