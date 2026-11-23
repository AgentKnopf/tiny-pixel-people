import { SAY_MAX_LENGTH } from '../../shared/protocol.ts';
import { PLAYER_ID, type Needs, type VillagerId } from '../../shared/types.ts';
import type { UiContext } from './context.ts';
import { h, replaceChildren, setText } from './dom.ts';
import { currentBlockIndex, formatClock, isAboutPlayer, memoryEmoji } from './format.ts';

const CLOSE_FRIEND_AFFINITY = 3;
const NEED_LABELS: (keyof Needs)[] = ['hunger', 'energy', 'social', 'fun'];

/**
 * Right-side villager inspector (style guide §8.6): identity, current thought, needs, today's plan,
 * friends, say/ask/rumor input, actions, and the last 10 memories (AC6).
 */
export function createInspector(ctx: UiContext): HTMLElement {
  const { store, host } = ctx;

  const name = h('h2', { class: 'insp-name', 'data-testid': 'insp-name' });
  const occupation = h('div', { class: 'insp-occupation' });
  const bio = h('blockquote', { class: 'insp-bio' });
  const thought = h('div', { class: 'insp-thought', 'data-testid': 'insp-thought' });
  const needs = h('div', { class: 'insp-needs', 'data-testid': 'insp-needs' });
  const plan = h('ul', { class: 'insp-plan', 'data-testid': 'insp-plan' });
  const planSource = h('span', { class: 'label-note' });
  const friendsTitle = h('div', { class: 'label' });
  const friends = h('ul', { class: 'insp-friends', 'data-testid': 'insp-friends' });
  const input = h('input', {
    class: 'insp-input',
    type: 'text',
    maxlength: SAY_MAX_LENGTH,
    placeholder: 'Say, ask, or whisper a rumor…',
    'data-testid': 'insp-input',
    'aria-label': 'Message to the villager',
  });
  const livesIn = h('div', { 'data-testid': 'insp-home' });
  const now = h('div', { 'data-testid': 'insp-now' });
  const partner = h('select', {
    class: 'insp-partner',
    'data-testid': 'insp-partner',
    'aria-label': 'Talk partner',
  });
  const memoriesTitle = h('div', { class: 'label' });
  const memories = h('ul', { class: 'insp-memories', 'data-testid': 'insp-memories' });

  const id = (): VillagerId | null => store.selectedId;

  const takeText = (): string | null => {
    const text = input.value.trim();
    if (!text) {
      input.focus();
      input.classList.remove('shake');
      void input.offsetWidth;
      input.classList.add('shake');
      return null;
    }
    input.value = '';
    return text;
  };

  const say = (mode: 'say' | 'ask') => {
    const vid = id();
    const text = takeText();
    if (!vid || !text) return;
    host.send({ type: 'player.say', villagerId: vid, text, mode });
    store.startChat(vid, text, `${store.name(vid)} is ${mode === 'ask' ? 'deciding' : 'thinking'}…`);
  };

  const rumor = () => {
    const vid = id();
    const text = takeText();
    if (!vid || !text) return;
    host.send({ type: 'player.rumor', villagerId: vid, text });
    store.toast('🗣️', `You whispered a rumor to ${store.name(vid)}`);
  };

  const pairTalk = () => {
    const vid = id();
    const other = partner.value;
    if (!vid || !other || other === vid) return;
    host.send({ type: 'player.pairTalk', aId: vid, bId: other });
    store.toast('💬', `${store.name(vid)} will go talk to ${store.name(other)}`);
  };

  const find = () => {
    const vid = id();
    if (!vid) return;
    if (host.camera?.followVillager) host.camera.followVillager(vid);
    else {
      const f = store.frames.get(vid);
      if (f) host.camera?.focusTile?.({ x: f.x, y: f.y });
    }
    store.setScene(null);
  };

  const visit = () => {
    const vid = id();
    const homeId = vid ? store.profiles.get(vid)?.homeId : undefined;
    const home = store.location(homeId);
    if (!home) return;
    const to = home.door ?? home.entry;
    host.send({ type: 'player.move', to });
    host.camera?.focusTile?.(to);
    store.setScene(null);
    ctx.openModal('door-note', home.id);
  };

  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      say('say');
    }
    ev.stopPropagation();
  });

  const button = (label: string, testid: string, onclick: () => void, cls = 'btn') =>
    h('button', { class: cls, 'data-testid': testid, onclick }, label);

  const el = h(
    'aside',
    {
      class: 'panel inspector',
      id: 'inspector',
      hidden: true,
      'aria-label': 'Villager inspector',
      'data-testid': 'inspector',
    },
    h(
      'button',
      {
        class: 'close',
        'aria-label': 'Close inspector',
        'data-testid': 'insp-close',
        onclick: () => ctx.select(null),
      },
      '×',
    ),
    h('header', null, name, occupation),
    bio,
    h('div', { class: 'card' }, h('div', { class: 'label' }, 'Current thought'), thought),
    h('section', null, h('div', { class: 'label' }, 'Needs'), needs),
    h('section', null, h('div', { class: 'label' }, "Today's plan ", planSource), plan),
    h('section', null, friendsTitle, friends),
    h(
      'div',
      { class: 'insp-say' },
      input,
      button('Say', 'insp-say', () => say('say')),
    ),
    h('div', { class: 'card insp-info' }, livesIn, now),
    h(
      'div',
      { class: 'insp-actions' },
      button('🫴 Ask to do it', 'insp-ask', () => say('ask')),
      button('🗣️ Tell as rumor', 'insp-rumor', rumor),
      partner,
      button('💬 Have them talk', 'insp-pair', pairTalk),
      button('📍 Find them', 'insp-find', find),
      button('🏠 Visit their home', 'insp-visit', visit),
    ),
    h('section', null, memoriesTitle, memories),
  );

  let lastPlanKey = '';

  const renderPlan = () => {
    const vid = id();
    const state = vid ? store.villagerStates.get(vid) : undefined;
    const p = store.inspect?.plan ?? state?.plan ?? null;
    const idx = p ? currentBlockIndex(p.blocks, store.time) : -1;
    const key = `${vid}:${p?.day}:${p?.revision}:${p?.blocks.length}:${p?.blocks.map((b) => (b.done ? 1 : 0)).join('')}:${idx}`;
    if (key === lastPlanKey) return;
    lastPlanKey = key;
    setText(planSource, p?.source === 'fallback' ? '· fallback' : '');
    if (!p || p.blocks.length === 0) {
      replaceChildren(plan, h('li', { class: 'empty' }, '☐ no plan yet'));
      return;
    }
    replaceChildren(
      plan,
      p.blocks.map((b, i) =>
        h(
          'li',
          { class: [b.done ? 'done' : '', i === idx ? 'current' : ''].join(' ').trim() || null },
          h('span', { class: 'check' }, b.done ? '☑' : '☐'),
          h('span', { class: 'time' }, formatClock(b.start)),
          ` ${b.emoji ? `${b.emoji} ` : ''}${b.activity} at ${store.locationName(b.locationId)}`,
          b.taskId ? h('span', { class: 'tag' }, 'your request') : null,
        ),
      ),
    );
  };

  const renderLive = () => {
    const vid = id();
    if (!vid) return;
    const f = store.frames.get(vid);
    const state = store.inspect?.state ?? store.villagerStates.get(vid);
    setText(thought, f?.bubble || state?.thought || f?.activity || state?.activity.text || '…');
    const activity = f?.activity || state?.activity.text || 'idle';
    const where = state?.locationId ? ` (${store.locationName(state.locationId)})` : '';
    setText(now, `📍 Now: ${f?.emoji ? `${f.emoji} ` : ''}${activity}${where}`);
  };

  const renderAll = () => {
    const vid = id();
    el.hidden = !vid;
    if (!vid) return;
    const profile = store.profiles.get(vid);
    const data = store.inspect;
    const state = data?.state ?? store.villagerStates.get(vid);
    setText(name, profile?.name ?? vid);
    setText(occupation, profile ? `${profile.occupation}${profile.age ? ` · ${profile.age}` : ''}` : '');
    setText(bio, [profile?.traits.join(', '), profile?.bio].filter(Boolean).join(' — '));
    setText(livesIn, `🏠 Lives in: ${store.locationName(profile?.homeId)}`);

    const n = state?.needs;
    replaceChildren(
      needs,
      NEED_LABELS.map((k) => {
        const v = Math.max(0, Math.min(100, Math.round(n?.[k] ?? 0)));
        return h(
          'div',
          { class: `need need-${k}`, 'data-need': k },
          h('span', { class: 'need-label' }, k),
          h('span', { class: 'need-track' }, h('span', { class: 'need-fill', style: `width:${v}%` })),
          h('span', { class: 'need-value' }, n ? `${v}%` : '–'),
        );
      }),
    );

    const rels = Object.entries(data?.relationships ?? state?.relationships ?? {}).sort(
      (a, b) => b[1].affinity - a[1].affinity,
    );
    const close = rels.filter(([, r]) => r.affinity >= CLOSE_FRIEND_AFFINITY).length;
    replaceChildren(
      friendsTitle,
      'Friends ',
      h('span', { class: 'heart' }, `❤ ${close}`),
      close === 0 ? h('span', { class: 'label-note' }, ' (no close friends yet)') : null,
    );
    replaceChildren(
      friends,
      rels
        .slice(0, 5)
        .map(([other, r]) =>
          h(
            'li',
            { class: r.affinity < 0 ? 'neg' : null, title: r.summary ?? '' },
            h('span', null, other === PLAYER_ID ? `★ ${store.name(other)} (you)` : store.name(other)),
            h('span', { class: 'aff' }, r.affinity > 0 ? `+${r.affinity}` : String(r.affinity)),
          ),
        ),
    );

    const selected = partner.value;
    replaceChildren(
      partner,
      store
        .villagerIds()
        .filter((o) => o !== vid)
        .map((o) => {
          const p = store.profiles.get(o)!;
          return h('option', { value: o, selected: o === selected }, `${p.name} · ${p.occupation}`);
        }),
    );

    const mems = data?.memories.slice(0, 10) ?? [];
    const playerName = store.player?.name;
    const about = mems.filter((m) => isAboutPlayer(m, playerName)).length;
    replaceChildren(
      memoriesTitle,
      'Recent memories · ',
      h('span', { class: about ? 'accent' : null }, `knows about you: ${about}`),
    );
    if (!data) replaceChildren(memories, h('li', { class: 'empty' }, 'loading…'));
    else if (mems.length === 0) replaceChildren(memories, h('li', { class: 'empty' }, 'no memories yet'));
    else
      replaceChildren(
        memories,
        mems.map((m) =>
          h(
            'li',
            {
              class: `memory memory-${m.kind}${isAboutPlayer(m, playerName) ? ' about-you' : ''}`,
              title: `${formatClock(m.createdAt)} · ${m.kind} · importance ${m.importance}`,
            },
            h('span', { class: 'memory-emoji' }, memoryEmoji(m.kind)),
            ` ${m.text}`,
          ),
        ),
      );

    lastPlanKey = '';
    renderPlan();
    renderLive();
  };

  store.subscribe(['selection', 'inspect', 'hello', 'player'], renderAll);
  store.subscribe(['villagers'], () => {
    if (!id()) return;
    if (!store.profiles.has(id()!)) return;
    renderLive();
    if (partner.options.length !== Math.max(0, store.profiles.size - 1)) renderAll();
  });
  store.subscribe(['time'], () => {
    if (id()) renderPlan();
  });
  renderAll();
  return el;
}
