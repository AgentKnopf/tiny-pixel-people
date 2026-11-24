// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientMessage } from '../../../src/shared/protocol.ts';
import { PLAYER_ID } from '../../../src/shared/types.ts';
import {
  mountUi,
  parseConnectionStatus,
  UiStore,
  type CameraControls,
  type UiController,
} from '../../../src/client/ui/index.ts';
import { makeHello, makeInspect } from './fixtures.ts';

let root: HTMLElement;
let sent: ClientMessage[];
let camera: Required<CameraControls>;
let ui: UiController;
let store: UiStore;

const $ = <T extends Element = HTMLElement>(sel: string) => {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
};
const byTestId = <T extends Element = HTMLElement>(id: string) => $<T>(`[data-testid="${id}"]`);
const click = (el: Element) => (el as HTMLElement).click();
const last = () => sent[sent.length - 1];

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('offline'))),
  );
  document.body.innerHTML = '<div id="ui"></div>';
  root = document.querySelector<HTMLElement>('#ui')!;
  sent = [];
  camera = {
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    fit: vi.fn(),
    showScene: vi.fn(),
    followVillager: vi.fn(),
    focusTile: vi.fn(),
  };
  store = new UiStore();
  ui = mountUi(root, { send: (m) => sent.push(m), camera, download: vi.fn() }, store);
  ui.setConnectionStatus('connected');
  ui.handleMessage(makeHello());
});

afterEach(() => {
  ui.destroy();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('connection status', () => {
  it('maps net.ts status strings', () => {
    expect(parseConnectionStatus('connected')).toBe('connected');
    expect(parseConnectionStatus('disconnected, retrying…')).toBe('disconnected');
    expect(parseConnectionStatus('connecting…')).toBe('connecting');
  });
});

describe('HUD, stats card and LLM card', () => {
  it('shows clock, day and LIVE badge', () => {
    expect(byTestId('hud-clock').textContent).toBe('07:05');
    expect($('.hud-day').textContent).toBe('Day 1');
    expect(byTestId('hud-live').textContent).toBe('LIVE');
    ui.handleMessage({ type: 'tick', time: 1440 + 21 * 60 + 30, speed: 0, villagers: [] });
    expect(byTestId('hud-clock').textContent).toBe('21:30');
    expect($('.hud-day').textContent).toBe('Day 2');
    expect(byTestId('hud-live').textContent).toBe('PAUSED');
    expect($('.hud-dot').classList.contains('night')).toBe(true);
    ui.setConnectionStatus('disconnected, retrying…');
    expect(byTestId('hud-live').textContent).toBe('OFFLINE');
  });

  it('shows model call totals, gold, items and agents', () => {
    ui.handleMessage({
      type: 'stats',
      llmOnline: true,
      simTicksPerSecond: 10,
      queue: {
        queued: 1,
        running: 1,
        done: 87,
        failed: 0,
        avgLatencyMs: 166,
        totalLatencyMs: 14833,
        totalTokens: 27744,
        lastReplyMs: 5000,
        tokensPerSecond: 3.4,
      },
    });
    expect(byTestId('stats-calls-label').textContent).toBe('Real model calls');
    expect(byTestId('stats-calls').textContent).toBe('87 · 14833 ms · 27744 tok');
    expect(byTestId('stats-purse').textContent).toContain('🪙 20 gold');
    expect(byTestId('stats-purse').textContent).toContain('🌸 2');
    expect(byTestId('stats-agents').textContent).toContain('3 agents');
    expect(byTestId('llm-title').textContent).toBe('✈ OFFLINE');
    expect(byTestId('llm-where').textContent).toBe('Running on this machine · QWEN2.5:7B via Ollama');
    expect(byTestId('llm-last').textContent).toBe('last reply: 5.0s · ~3.4 tok/s');
  });

  it('labels mock provider calls as mock, not real', () => {
    ui.handleMessage({ ...makeHello(), llm: { provider: 'mock', model: 'mock', embeddings: 'mock' } });
    expect(byTestId('stats-calls-label').textContent).toBe('Mock model calls');
    ui.handleMessage(makeHello());
    expect(byTestId('stats-calls-label').textContent).toBe('Real model calls');
  });

  it('flags an unreachable model', () => {
    expect(byTestId('llm-last').textContent).toBe('no reply yet — say something');
    ui.handleMessage({
      type: 'stats',
      llmOnline: false,
      simTicksPerSecond: 10,
      queue: {
        queued: 0,
        running: 0,
        done: 0,
        failed: 3,
        avgLatencyMs: 0,
        totalLatencyMs: 0,
        totalTokens: 0,
        lastReplyMs: null,
        tokensPerSecond: null,
      },
    });
    expect(byTestId('llm-title').textContent).toContain('UNREACHABLE');
  });
});

describe('toolbar', () => {
  it('sends speeds and highlights the active one', () => {
    click(byTestId('speed-4'));
    expect(last()).toEqual({ type: 'speed', speed: 4 });
    expect(byTestId('speed-4').classList.contains('active')).toBe(true);
    expect(byTestId('speed-1').classList.contains('active')).toBe(false);
    click(byTestId('btn-pause'));
    expect(last()).toEqual({ type: 'speed', speed: 0 });
    expect(byTestId('btn-pause').textContent).toContain('PLAY');
    click(byTestId('btn-pause'));
    expect(last()).toEqual({ type: 'speed', speed: 4 });
  });

  it('follows the server speed from ticks', () => {
    ui.handleMessage({ type: 'tick', time: 500, speed: 8, villagers: [] });
    expect(byTestId('speed-8').classList.contains('active')).toBe(true);
  });

  it('triggers world events; birthday targets the inspected villager', () => {
    click(byTestId('event-rain'));
    expect(last()).toEqual({ type: 'world.trigger', kind: 'rain' });
    ui.selectVillager('bo');
    click(byTestId('event-birthday'));
    expect(last()).toEqual({ type: 'world.trigger', kind: 'birthday', villagerId: 'bo' });
    for (const kind of ['party', 'stranger', 'townEvent']) {
      click(byTestId(`event-${kind}`));
      expect(last()).toEqual({ type: 'world.trigger', kind });
    }
  });

  it('save replay sends save and downloads /api/replay', () => {
    vi.useFakeTimers();
    const download = vi.fn();
    ui.destroy();
    ui = mountUi(root, { send: (m) => sent.push(m), download }, new UiStore());
    click(byTestId('btn-save'));
    expect(last()).toEqual({ type: 'save' });
    vi.advanceTimersByTime(1100);
    expect(download).toHaveBeenCalledWith('/api/replay', 'replay.jsonl');
  });

  it('labels every button like the reference toolbar', () => {
    const labels = ['rain', 'party', 'stranger', 'birthday', 'townEvent'].map(
      (k) => byTestId(`event-${k}`).querySelector('.btn-label')?.textContent,
    );
    expect(labels).toEqual(['Rain', 'Party', 'Stranger', 'Birthday', 'Town event']);
    expect(byTestId('btn-save').querySelector('.btn-label')?.textContent).toBe('Save replay');
    expect(byTestId('btn-pause').textContent).toContain('PAUSE');
    for (const el of root.querySelectorAll('#toolbar button')) expect(el.getAttribute('title')).toBeTruthy();
  });

  it('zoom buttons call the camera', () => {
    click($('[aria-label="Zoom in"]'));
    click($('[aria-label="Zoom out"]'));
    click($('[aria-label="Fit the whole town"]'));
    expect(camera.zoomIn).toHaveBeenCalled();
    expect(camera.zoomOut).toHaveBeenCalled();
    expect(camera.fit).toHaveBeenCalled();
  });
});

describe('inspector (AC6)', () => {
  it('subscribes on select and unsubscribes on close', () => {
    const seen: (string | null)[] = [];
    ui.onSelectionChange((id) => seen.push(id));
    ui.selectVillager('ada');
    expect(last()).toEqual({ type: 'inspect', villagerId: 'ada' });
    expect(byTestId('inspector').hidden).toBe(false);
    expect(byTestId('insp-name').textContent).toBe('Ada');
    click(byTestId('insp-close'));
    expect(last()).toEqual({ type: 'inspect', villagerId: null });
    expect(byTestId('inspector').hidden).toBe(true);
    expect(seen).toEqual(['ada', null]);
  });

  it('shows activity, plan, last 10 memories, relationships and needs', () => {
    ui.selectVillager('ada');
    expect(byTestId('insp-memories').textContent).toContain('loading');
    ui.handleMessage(makeInspect());

    expect(byTestId('insp-thought').textContent).toBe('The oven is warm.');
    expect(byTestId('insp-home').textContent).toBe('🏠 Lives in: Brown house');
    expect(byTestId('insp-now').textContent).toContain('waking up');

    const plan = [...byTestId('insp-plan').querySelectorAll('li')];
    expect(plan).toHaveLength(3);
    expect(plan[0]!.classList.contains('done')).toBe(true);
    expect(plan[0]!.textContent).toContain('☑');
    expect(plan[1]!.classList.contains('current')).toBe(true);
    expect(plan[1]!.textContent).toContain('07:00');
    expect(plan[1]!.textContent).toContain('bake bread at Bakery & Café');
    expect(plan[2]!.textContent).toContain('your request');

    const memories = [...byTestId('insp-memories').querySelectorAll('li')];
    expect(memories).toHaveLength(10);
    expect(memories[0]!.textContent).toContain('Kim said the mayor sings');
    expect(memories[0]!.classList.contains('about-you')).toBe(true);
    expect(root.textContent).toContain('knows about you: 1');

    const friends = [...byTestId('insp-friends').querySelectorAll('li')].map((li) => li.textContent);
    expect(friends[0]).toBe('Bo+5');
    expect(friends[1]).toBe('★ Kim (you)+3');
    expect(friends[2]).toBe('Cy-2');
    expect(root.textContent).toContain('❤ 2');

    const hunger = byTestId('insp-needs').querySelector<HTMLElement>('[data-need="hunger"] .need-fill')!;
    expect(hunger.getAttribute('style')).toBe('width:51%');
    expect(byTestId('insp-needs').textContent).toContain('76%');
  });

  it('moves the current-block highlight as time passes and ignores data for other villagers', () => {
    ui.selectVillager('ada');
    ui.handleMessage(makeInspect());
    ui.handleMessage({ type: 'tick', time: 10 * 60 + 30, speed: 1, villagers: [] });
    const plan = [...byTestId('insp-plan').querySelectorAll('li')];
    expect(plan[2]!.classList.contains('current')).toBe(true);
    ui.handleMessage({ ...makeInspect(), villagerId: 'bo' });
    expect(byTestId('insp-name').textContent).toBe('Ada');
  });

  it('shows live bubble text from ticks as the current thought', () => {
    ui.selectVillager('ada');
    ui.handleMessage(makeInspect());
    ui.handleMessage({
      type: 'tick',
      time: 430,
      speed: 1,
      villagers: [
        {
          id: 'ada',
          x: 3,
          y: 3,
          facing: 'left',
          status: 'talking',
          activity: 'chatting with Bo',
          emoji: '💬',
          bubble: 'Morning, Bo!',
        },
      ],
    });
    expect(byTestId('insp-thought').textContent).toBe('Morning, Bo!');
    expect(byTestId('insp-now').textContent).toContain('💬 chatting with Bo');
  });

  it('say, ask and rumor send commands and open the chat dialog', () => {
    ui.selectVillager('ada');
    const input = byTestId<HTMLInputElement>('insp-input');

    click(byTestId('insp-say'));
    expect(last()).toEqual({ type: 'inspect', villagerId: 'ada' });

    input.value = 'Hello there';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(last()).toEqual({ type: 'player.say', villagerId: 'ada', text: 'Hello there', mode: 'say' });
    expect(input.value).toBe('');
    expect(byTestId('chat-dialog').hidden).toBe(false);
    expect(byTestId('chat-dialog').textContent).toContain('Ada is thinking…');

    ui.handleMessage({
      type: 'conversation.message',
      conversationId: 'c1',
      speakerId: 'ada',
      listenerId: PLAYER_ID,
      text: 'Hi Kim!',
      time: 430,
    });
    expect(byTestId('chat-dialog').textContent).toContain('Ada:');
    expect(byTestId('chat-dialog').textContent).toContain('Hi Kim!');
    expect(byTestId('chat-dialog').textContent).not.toContain('thinking');

    input.value = 'Could you sing at the café?';
    click(byTestId('insp-ask'));
    expect(last()).toEqual({
      type: 'player.say',
      villagerId: 'ada',
      text: 'Could you sing at the café?',
      mode: 'ask',
    });
    expect(byTestId('chat-dialog').textContent).toContain('Ada is deciding…');

    input.value = 'The mayor sings in the shower';
    click(byTestId('insp-rumor'));
    expect(last()).toEqual({
      type: 'player.rumor',
      villagerId: 'ada',
      text: 'The mayor sings in the shower',
    });
    expect($('.toasts').textContent).toContain('You whispered a rumor to Ada');
  });

  it('have them talk, find them and visit their home', () => {
    ui.selectVillager('ada');
    const partner = byTestId<HTMLSelectElement>('insp-partner');
    expect([...partner.options].map((o) => o.value)).toEqual(['bo', 'cy']);
    partner.value = 'cy';
    click(byTestId('insp-pair'));
    expect(last()).toEqual({ type: 'player.pairTalk', aId: 'ada', bId: 'cy' });

    click(byTestId('insp-find'));
    expect(camera.followVillager).toHaveBeenCalledWith('ada');

    click(byTestId('insp-visit'));
    expect(last()).toEqual({ type: 'player.move', to: { x: 1, y: 2 } });
    expect(camera.focusTile).toHaveBeenCalledWith({ x: 1, y: 2 });
    expect($('#modal').hidden).toBe(false);
    expect($('.modal-title').textContent).toBe("📮 Note for Ada's door");
  });

  it('"Find them" pans to the last known tile when following fails', () => {
    vi.mocked(camera.followVillager).mockReturnValue(false);
    ui.selectVillager('ada');
    click(byTestId('insp-find'));
    expect(camera.followVillager).toHaveBeenCalledWith('ada');
    expect(camera.focusTile).toHaveBeenCalledWith({ x: 2, y: 3 });
  });

  it('closes when the selected stranger leaves', () => {
    ui.selectVillager('cy');
    ui.handleMessage({ type: 'villagers.changed', added: [], removed: ['cy'] });
    expect(byTestId('inspector').hidden).toBe(true);
  });

  it('re-subscribes after a reconnect', () => {
    ui.selectVillager('ada');
    sent.length = 0;
    ui.handleMessage(makeHello());
    expect(sent).toContainEqual({ type: 'inspect', villagerId: 'ada' });
  });
});

describe('rumor tracker', () => {
  it('shows who knows and how it spread', () => {
    expect(byTestId('rumor-panel').hidden).toBe(true);
    ui.handleMessage({
      type: 'rumor.updated',
      rumor: {
        id: 'r1',
        originMemoryId: 'm1',
        text: 'the mayor sings',
        startedBy: PLAYER_ID,
        startedAt: 480,
        knownBy: [PLAYER_ID, 'ada', 'bo'],
        hops: [{ from: 'ada', to: 'bo', at: 600, text: 'Did you hear the mayor sings?' }],
      },
    });
    expect(byTestId('rumor-panel').hidden).toBe(false);
    expect(byTestId('rumor-title').textContent).toBe('🗣️ Rumor · 2 of 3 villagers know');
    expect(byTestId('rumor-origin').textContent).toBe('You said: “the mayor sings”');
    expect(byTestId('rumor-hops').textContent).toContain('Ada → Bo');
    expect(byTestId('rumor-hops').textContent).toContain('Did you hear the mayor sings?');
  });

  it('can be dismissed and reappears on a new hop', () => {
    const rumor = {
      id: 'r1',
      originMemoryId: 'm1',
      text: 'x',
      startedBy: 'ada',
      startedAt: 1,
      knownBy: ['ada'],
      hops: [],
    };
    ui.handleMessage({ type: 'rumor.updated', rumor });
    expect(byTestId('rumor-origin').textContent).toBe('Ada started: “x”');
    click($('[aria-label="Dismiss rumor tracker"]'));
    expect(byTestId('rumor-panel').hidden).toBe(true);
    ui.handleMessage({
      type: 'rumor.updated',
      rumor: { ...rumor, knownBy: ['ada', 'cy'], hops: [{ from: 'ada', to: 'cy', at: 5, text: 'x!' }] },
    });
    expect(byTestId('rumor-panel').hidden).toBe(false);
    expect(byTestId('rumor-title').textContent).toContain('2 of 3');
  });
});

describe('dock and modals', () => {
  it('map modal switches scenes through the camera', () => {
    click(byTestId('dock-map'));
    expect($('.modal-title').textContent).toBe('🗺️ Map');
    const buttons = [...root.querySelectorAll<HTMLElement>('.scene-btn')];
    expect(buttons.map((b) => b.dataset.scene)).toEqual(['plaza', 'farm', 'home']);
    expect(buttons[0]!.classList.contains('active')).toBe(true);
    click(buttons[1]!);
    expect(camera.showScene).toHaveBeenCalledWith('farm');
    expect($('#modal').hidden).toBe(true);
    expect(byTestId('dock-map').textContent).toContain('Scene: Farm');
  });

  it('home tile jumps to the home scene', () => {
    click(byTestId('dock-home'));
    expect(camera.showScene).toHaveBeenCalledWith('home');
    expect(byTestId('dock-map').textContent).toContain('Your home');
  });

  it('decorate modal shows placed, affordable and too expensive items', () => {
    click(byTestId('dock-decorate'));
    const card = (id: string) => $(`[data-deco="${id}"]`);
    expect(card('welcome_rug').classList.contains('placed')).toBe(true);
    expect(card('welcome_rug').textContent).toContain('Placed ✓');
    expect(card('mailbox').textContent).toContain('🪙 6');
    expect(card('string_lights').classList.contains('too-expensive')).toBe(false);
    ui.handleMessage({ type: 'player.updated', player: { ...makeHello().snapshot.player, gold: 5 } });
    expect(card('string_lights').classList.contains('too-expensive')).toBe(true);
    click(card('mailbox'));
    expect(last()).toEqual({ type: 'decor.toggle', itemId: 'mailbox' });
  });

  it('backpack lists items and gifts to the inspected villager', () => {
    click(byTestId('dock-backpack'));
    const rows = [...root.querySelectorAll<HTMLElement>('.item-row')];
    expect(rows.map((r) => r.dataset.item)).toEqual(['flower', 'apple']);
    expect(rows[0]!.textContent).toContain('Wild flower');
    expect(rows[0]!.textContent).toContain('×2');
    expect(rows[0]!.querySelector('button')!.disabled).toBe(true);
    ui.selectVillager('bo');
    const gift = root.querySelector<HTMLButtonElement>('.item-row[data-item="apple"] button')!;
    expect(gift.disabled).toBe(false);
    click(gift);
    expect(last()).toEqual({ type: 'player.gift', villagerId: 'bo', itemId: 'apple' });
    expect(byTestId('dock-backpack').textContent).toContain('3 items');
  });

  it('pet panel sends pet commands', () => {
    click(byTestId('dock-pet'));
    const buttons = [...root.querySelectorAll<HTMLButtonElement>('.modal-pet .btn')];
    click(buttons.find((b) => b.textContent?.includes('Pet Pip'))!);
    expect(last()).toEqual({ type: 'pet.command', action: 'pet' });
    click(buttons.find((b) => b.textContent?.includes('Stay'))!);
    expect(last()).toEqual({ type: 'pet.command', action: 'stay' });
    const input = root.querySelector<HTMLInputElement>('.modal-pet input')!;
    input.value = 'Mochi';
    click(buttons.find((b) => b.textContent === 'Rename')!);
    expect(last()).toEqual({ type: 'pet.command', action: 'rename', name: 'Mochi' });
  });

  it('door-note modal posts a note and shows the reply', () => {
    ui.openDoorNote('house_01');
    expect($('.modal-title').textContent).toBe("📮 Note for Ada's door");
    const text = byTestId<HTMLTextAreaElement>('note-text');
    text.value = 'Could you bake a cake for Friday?';
    click(byTestId('note-pin'));
    expect(last()).toEqual({
      type: 'note.post',
      houseId: 'house_01',
      text: 'Could you bake a cake for Friday?',
    });
    expect(text.value).toBe('');

    const note = {
      id: 'n1',
      houseId: 'house_01',
      ownerId: 'ada',
      authorId: PLAYER_ID,
      text: 'Could you bake a cake for Friday?',
      postedAt: 500,
      status: 'unread' as const,
    };
    ui.handleMessage({ type: 'note.updated', note });
    expect(byTestId('note-history').textContent).toContain('not read yet');
    expect($('.note-status').textContent).toBe('✓ Pinned');
    ui.handleMessage({
      type: 'note.updated',
      note: { ...note, status: 'replied', reply: 'Happy to! A lemon cake.', repliedAt: 900 },
    });
    expect(byTestId('note-history').textContent).toContain('Ada: Happy to! A lemon cake.');
    expect(byTestId('note-text')).toBe(text);
  });

  it('door-note modal names residents by homeId when the house has no ownerIds', () => {
    ui.openDoorNote('house_02');
    expect($('.modal-title').textContent).toBe("📮 Note for Bo & Cy's door");
  });

  it('mailbox shows letters from villagers and the unread badge', () => {
    ui.handleMessage({
      type: 'note.updated',
      note: {
        id: 'n2',
        houseId: 'player_home',
        ownerId: PLAYER_ID,
        authorId: 'bo',
        text: 'Thanks for the apple!',
        postedAt: 700,
        status: 'unread',
      },
    });
    expect(byTestId('dock-mail').textContent).toContain('1 new');
    click(byTestId('dock-mail'));
    expect($('.modal-title').textContent).toBe('📬 Your mailbox');
    expect(byTestId('mailbox').textContent).toContain('from Bo');
    expect(byTestId('mailbox').textContent).toContain('📝 door note from Bo');
    expect(byTestId('mailbox').textContent).toContain('Thanks for the apple!');
  });

  it('mailbox promises only delivered letters, with or without a placed mailbox', () => {
    click(byTestId('dock-mail'));
    const modal = $('#modal').textContent ?? '';
    expect(modal).toContain('Letters from villagers arrive here with the post office delivery rounds.');
    expect(modal).not.toMatch(/leave a note|so villagers can write to you/);
    expect(byTestId('mailbox').textContent).toBe('No letters yet.');
  });

  it('Escape closes the modal, then the inspector', () => {
    ui.selectVillager('ada');
    click(byTestId('dock-map'));
    expect(ui.capturesKeyboard()).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect($('#modal').hidden).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(byTestId('inspector').hidden).toBe(true);
  });
});

describe('toasts', () => {
  it('shows server toasts and errors, then removes them', () => {
    vi.useFakeTimers();
    ui.handleMessage({ type: 'toast', icon: '📮', text: 'Mailbox placed at your cottage ✓' });
    ui.handleMessage({ type: 'error', message: 'Not enough gold' });
    expect($('.toasts').textContent).toContain('Mailbox placed at your cottage ✓');
    expect($('.toasts').textContent).toContain('Not enough gold');
    vi.advanceTimersByTime(3500);
    expect($('.toasts').children).toHaveLength(0);
  });
});
