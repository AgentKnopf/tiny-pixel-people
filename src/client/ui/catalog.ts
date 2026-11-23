import type { DecorationItem, ItemDef } from '../../shared/types.ts';
import type { Catalog } from './types.ts';

/**
 * Fallback catalog used until the server provides one (GET /api/catalog). It mirrors the suggested
 * catalogues in assets/maps/village.meta.json; the server's data/*.json is authoritative.
 */
const decorations: DecorationItem[] = (
  [
    ['welcome_rug', 'Welcome rug', '🟥', 6, 'deco_rug'],
    ['porch_cushion', 'Porch cushion', '🪑', 6, 'deco_cushion'],
    ['flower_vase', 'Flower vase', '🏺', 8, 'deco_vase'],
    ['lanterns', 'Lanterns', '🏮', 10, 'deco_lantern'],
    ['flower_pots', 'Flower pots', '🪴', 8, 'deco_flowerpots'],
    ['garden_bench', 'Garden bench', '🪵', 12, 'deco_bench'],
    ['string_lights', 'String lights', '✨', 15, 'deco_string_lights'],
    ['mailbox', 'Mailbox', '📮', 6, 'deco_mailbox'],
    ['flag', 'Flag', '🚩', 6, 'deco_flag'],
    ['bird_bath', 'Bird bath', '🐦', 10, 'deco_birdbath'],
  ] as const
).map(([id, name, emoji, cost, sprite], slot) => ({ id, name, emoji, cost, sprite, slot }));

const items: ItemDef[] = (
  [
    ['flower', 'Wild flower', '🌸'],
    ['apple', 'Apple', '🍎'],
    ['seed', 'Seed packet', '🌱'],
    ['gem', 'Shiny pebble', '💎'],
    ['bread', 'Bread', '🍞'],
    ['honey', 'Honey jar', '🍯'],
  ] as const
).map(([id, name, emoji]) => ({ id, name, emoji, sprite: `ui/icons.json#${id}` }));

export const DEFAULT_CATALOG: Catalog = { items, decorations };

export function itemDef(catalog: Catalog, itemId: string): ItemDef {
  return (
    catalog.items.find((i) => i.id === itemId) ?? {
      id: itemId,
      name: itemId.replace(/[_-]/g, ' '),
      emoji: '📦',
      sprite: itemId,
    }
  );
}
