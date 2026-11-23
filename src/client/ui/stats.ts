import { itemDef } from './catalog.ts';
import { h, replaceChildren, setText } from './dom.ts';
import { formatInt } from './format.ts';
import { icon, spriteIcon } from './icons.ts';
import type { UiStore } from './store.ts';

/** Top-right card: REAL MODEL CALLS, gold + item counts, online · agents. */
export function createStatsCard(store: UiStore): HTMLElement {
  const calls = h('div', { class: 'stats-calls', 'data-testid': 'stats-calls' }, '0 · 0 ms · 0 tok');
  const purse = h('div', { class: 'stats-purse', 'data-testid': 'stats-purse' });
  const queue = h('div', { class: 'stats-queue' });
  const agents = h('div', { class: 'stats-agents', 'data-testid': 'stats-agents' });
  const el = h(
    'div',
    { class: 'panel stats', id: 'stats' },
    h('div', { class: 'label' }, 'Real model calls'),
    calls,
    purse,
    h('div', { class: 'label' }, 'Recorded from responses'),
    agents,
    queue,
  );

  const render = () => {
    const q = store.queue;
    const done = q?.done ?? 0;
    setText(
      calls,
      `${done} · ${formatInt(q?.totalLatencyMs ?? 0)} ms · ${formatInt(q?.totalTokens ?? 0)} tok`,
    );
    const pending = (q?.queued ?? 0) + (q?.running ?? 0);
    const failed = q?.failed ?? 0;
    setText(queue, pending || failed ? `${pending} in queue${failed ? ` · ${failed} failed` : ''}` : '');
    const online = store.connection === 'connected' ? 1 : 0;
    setText(agents, `👤 ${online} online · 👥 ${store.profiles.size} agents`);

    const p = store.player;
    const parts: (Node | string)[] = [h('strong', null, icon('coin', '🪙'), ` ${p?.gold ?? 0}`), ' gold'];
    for (const entry of (p?.inventory ?? []).filter((e) => e.count > 0).slice(0, 3)) {
      const def = itemDef(store.catalog, entry.itemId);
      parts.push(' · ', h('span', { title: def.name }, spriteIcon(def.sprite, def.emoji), ` ${entry.count}`));
    }
    replaceChildren(purse, ...parts);
  };
  store.subscribe(['stats', 'player', 'villagers', 'connection', 'hello', 'catalog'], render);
  render();
  return el;
}
