import { afterEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import '../../src/style.css';

afterEach(async () => {
  document.body.replaceChildren();
  await page.viewport(1280, 720);
});

describe('documentation terminal toolbar', () => {
  it('keeps every control visible at a narrow phone width', async () => {
    await page.viewport(375, 720);
    document.body.innerHTML = `
      <div class="terminal-stage">
        <div class="terminal-toolbar">
          <span id="renderer-status">WEBGPU · WASIX Bash</span>
          <div class="terminal-controls">
            <label for="theme-select">Theme</label>
            <select id="theme-select"><option>Gespenst Dark</option></select>
            <button type="button">Clear display</button>
          </div>
        </div>
        <div id="terminal"></div>
        <div class="terminal-error" hidden></div>
      </div>`;

    const toolbar = document.querySelector<HTMLElement>('.terminal-toolbar');
    const status = document.querySelector<HTMLElement>('#renderer-status');
    const controls = document.querySelector<HTMLElement>('.terminal-controls');
    const select = document.querySelector<HTMLSelectElement>('#theme-select');
    const button = document.querySelector<HTMLButtonElement>('button');
    if (!toolbar || !status || !controls || !select || !button) {
      throw new Error('Expected terminal toolbar fixture');
    }
    const bounds = toolbar.getBoundingClientRect();
    for (const element of [status, controls, select, button]) {
      const elementBounds = element.getBoundingClientRect();
      expect(elementBounds.width).toBeGreaterThan(0);
      expect(elementBounds.left).toBeGreaterThanOrEqual(bounds.left);
      expect(elementBounds.right).toBeLessThanOrEqual(bounds.right + 0.5);
    }
    expect(bounds.height).toBeGreaterThan(46);
  });
});
