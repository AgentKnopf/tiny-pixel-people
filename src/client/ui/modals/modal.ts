import { h, replaceChildren } from '../dom.ts';
import { icon } from '../icons.ts';

export interface ModalView {
  title: string;
  /** Sprite name in assets/ui/icons.json and its emoji fallback. */
  icon?: [sprite: string, emoji: string];
  subtitle?: string;
  /** Fills the body; called on open and whenever a watched store topic changes. */
  render(body: HTMLElement): void;
  footer?: string;
  className?: string;
  /** Re-render only when this changes (keeps focus and scroll while unrelated state ticks). */
  key?: () => string;
}

/** Centred modal on a dimmed backdrop (style guide §8.8), with the close button bottom-right. */
export class ModalHost {
  readonly el: HTMLElement;
  private panel: HTMLElement;
  private view: ModalView | null = null;
  private body = h('div', { class: 'modal-body' });
  private onClose: () => void;
  private lastKey: string | null = null;

  constructor(onClose: () => void) {
    this.onClose = onClose;
    this.panel = h('div', { class: 'panel modal', role: 'dialog', 'aria-modal': 'true' });
    this.el = h(
      'div',
      {
        class: 'modal-backdrop',
        id: 'modal',
        hidden: true,
        onclick: (ev: Event) => {
          if (ev.target === this.el) this.onClose();
        },
      },
      this.panel,
    );
  }

  get isOpen(): boolean {
    return this.view !== null;
  }

  open(view: ModalView): void {
    this.view = view;
    this.panel.className = `panel modal ${view.className ?? ''}`.trim();
    this.panel.setAttribute('aria-label', view.title);
    replaceChildren(
      this.panel,
      h(
        'header',
        { class: 'modal-head' },
        h(
          'div',
          { class: 'modal-title' },
          view.icon ? [icon(view.icon[0], view.icon[1]), ' '] : null,
          view.title,
        ),
        view.subtitle ? h('div', { class: 'label modal-subtitle' }, view.subtitle) : null,
      ),
      this.body,
      h(
        'footer',
        { class: 'modal-foot' },
        h('span', { class: 'modal-hint' }, view.footer ?? ''),
        h(
          'button',
          { class: 'btn btn-icon close-modal', 'aria-label': 'Close', onclick: () => this.onClose() },
          '×',
        ),
      ),
    );
    this.el.hidden = false;
    this.lastKey = null;
    this.refresh();
  }

  refresh(): void {
    if (!this.view) return;
    if (this.view.key) {
      const key = this.view.key();
      if (key === this.lastKey) return;
      this.lastKey = key;
    }
    this.view.render(this.body);
  }

  close(): void {
    this.view = null;
    this.el.hidden = true;
    replaceChildren(this.body);
  }
}
