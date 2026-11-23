import { h, setText } from './dom.ts';
import { formatSeconds, isLocalProvider, providerLabel } from './format.ts';
import type { UiStore } from './store.ts';

/** Bottom-left card: where the model runs, which model, last reply latency and speed. */
export function createLlmCard(store: UiStore): HTMLElement {
  const title = h('div', { class: 'llm-title', 'data-testid': 'llm-title' });
  const where = h('div', { class: 'label llm-where', 'data-testid': 'llm-where' });
  const last = h('div', { class: 'llm-last', 'data-testid': 'llm-last' });
  const el = h('div', { class: 'panel llm-card', id: 'llm-card' }, title, where, last);

  const render = () => {
    const llm = store.llm;
    if (!llm) {
      setText(title, '… CONNECTING');
      setText(where, 'waiting for the server');
      setText(last, '');
      return;
    }
    const local = isLocalProvider(llm.provider);
    let state = local ? 'offline' : 'online';
    let heading = local ? '✈ OFFLINE' : '☁ ONLINE';
    if (!store.llmOnline) {
      state = 'down';
      heading = '⚠ MODEL UNREACHABLE';
    }
    el.dataset.state = state;
    setText(title, heading);
    const model = llm.model.toUpperCase();
    setText(
      where,
      local
        ? `Running on this machine · ${model} via ${providerLabel(llm.provider)}`
        : `${model} via ${providerLabel(llm.provider)}`,
    );
    const q = store.queue;
    if (!store.llmOnline) {
      setText(last, 'villagers use simple fallback plans until it is back');
    } else if (q?.lastReplyMs != null) {
      const tps = q.tokensPerSecond != null ? ` · ~${q.tokensPerSecond.toFixed(1)} tok/s` : '';
      setText(last, `last reply: ${formatSeconds(q.lastReplyMs)}${tps}`);
    } else {
      setText(last, 'no reply yet — say something');
    }
  };
  store.subscribe(['stats', 'hello'], render);
  render();
  return el;
}
