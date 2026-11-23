// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { icon, loadIconSheet, spriteIcon } from '../../../src/client/ui/icons.ts';

class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_v: string) {
    queueMicrotask(() => this.onload?.());
  }
}

afterEach(() => vi.unstubAllGlobals());

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

describe('pixel icons', () => {
  it('render the emoji fallback before the sheet loads', () => {
    const el = icon('rain', '🌧️');
    expect(el.textContent).toBe('🌧️');
    expect(el.style.getPropertyValue('--ix')).toBe('7');
    expect(el.style.getPropertyValue('--iy')).toBe('0');
    expect(spriteIcon('ui/icons.json#flower', '🌸').dataset.icon).toBe('flower');
    expect(icon('nope', '?').classList.contains('no-sprite')).toBe(true);
  });

  it('switch the UI root to the sprite sheet from icons.json', async () => {
    vi.stubGlobal('Image', FakeImage);
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(jsonResponse({ image: 'ui/icons.png', size: 16, columns: 4, icons: { rain: 5 } })),
      ),
    );
    const root = document.createElement('div');
    const el = icon('rain', '🌧️');
    root.append(el);
    await expect(loadIconSheet(root)).resolves.toBe(true);
    expect(root.classList.contains('has-pixel-icons')).toBe(true);
    expect(root.style.getPropertyValue('--icons-url')).toBe('url("/ui/icons.png")');
    expect(el.style.getPropertyValue('--ix')).toBe('1');
    expect(el.style.getPropertyValue('--iy')).toBe('1');
  });

  it('keep the emoji when the art is not served (index.html fallback)', async () => {
    vi.stubGlobal('Image', FakeImage);
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } })),
      ),
    );
    const root = document.createElement('div');
    await expect(loadIconSheet(root)).resolves.toBe(false);
    expect(root.classList.contains('has-pixel-icons')).toBe(false);
  });
});
