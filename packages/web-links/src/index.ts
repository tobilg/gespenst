import type { BrowserTerminal, Disposable, RenderCell, TerminalAddon } from '@gespenst/core';

/** Controls link detection and activation behavior. */
export interface WebLinksOptions {
  /** Custom activation handler; defaults to a safe `_blank` browser navigation. */
  readonly activate?: (event: MouseEvent, uri: string) => void;
  /** Require Command on macOS or Control elsewhere for mouse/pen activation. Defaults to `true`. */
  readonly requireModifier?: boolean;
  /** Pattern used to detect links. Defaults to HTTP and HTTPS URLs. */
  readonly pattern?: RegExp;
}

interface LinkOverlay {
  readonly element: HTMLAnchorElement;
  readonly dispose: Disposable;
}

/** Detects links in the visible viewport and exposes them as accessible DOM overlays. */
export class WebLinksAddon implements TerminalAddon {
  private terminal: BrowserTerminal | null = null;
  private readonly overlays: LinkOverlay[] = [];
  private readonly subscriptions: Disposable[] = [];
  private refreshQueued = false;
  private generation = 0;
  private readonly options: WebLinksOptions;

  /** Creates a link addon with optional activation policy. */
  constructor(options: WebLinksOptions = {}) {
    this.options = options;
  }

  /** Attaches the addon and starts tracking parsed terminal output. */
  activate(terminal: BrowserTerminal): void {
    this.terminal = terminal;
    for (const event of ['writeParsed', 'viewportChange', 'resize', 'font'] as const) {
      this.subscriptions.push(terminal.on(event, () => this.queueRefresh()));
    }
    this.queueRefresh();
  }

  /** Rebuilds link overlays from the terminal's current viewport snapshot. */
  async refresh(): Promise<void> {
    this.refreshQueued = false;
    const terminal = this.terminal;
    if (!terminal) return;
    const generation = ++this.generation;
    const viewport = await terminal.readViewport();
    if (this.terminal !== terminal || generation !== this.generation) return;
    this.clear();
    const configured = this.options.pattern ?? /\bhttps?:\/\/[^\s<>"']+/giu;
    const pattern = new RegExp(
      configured.source,
      configured.flags.includes('g') ? configured.flags : `${configured.flags}g`
    );
    const bounds = terminal.element.getBoundingClientRect();
    const cellWidth = bounds.width / terminal.geometry.cols;
    const cellHeight = bounds.height / terminal.geometry.rows;
    for (const row of viewport.viewportRows) {
      for (const match of row.text.matchAll(pattern)) {
        if (match.index === undefined || !match[0]) continue;
        const columns = cellColumns(row.cells, match.index, match[0].length);
        if (!columns) continue;
        const link = document.createElement('a');
        link.className = 'gespenst__link';
        link.href = match[0];
        link.tabIndex = 0;
        link.setAttribute('aria-label', match[0]);
        link.style.cssText =
          'position:absolute;z-index:4;background:transparent;cursor:pointer;left:' +
          columns.column * cellWidth +
          'px;top:' +
          row.y * cellHeight +
          'px;width:' +
          columns.length * cellWidth +
          'px;height:' +
          cellHeight +
          'px';
        let pointerType = '';
        const rememberPointerType = (event: PointerEvent) => {
          pointerType = event.pointerType;
        };
        const activate = (event: MouseEvent) => {
          const eventPointerType =
            typeof PointerEvent !== 'undefined' && event instanceof PointerEvent
              ? event.pointerType
              : '';
          const nonPointerActivation = event.detail === 0;
          const touchActivation = eventPointerType === 'touch' || pointerType === 'touch';
          const modifier = navigator.platform.includes('Mac') ? event.metaKey : event.ctrlKey;
          if (
            (this.options.requireModifier ?? true) &&
            !nonPointerActivation &&
            !touchActivation &&
            !modifier
          ) {
            event.preventDefault();
            pointerType = '';
            return;
          }
          event.preventDefault();
          pointerType = '';
          if (this.options.activate) this.options.activate(event, match[0]);
          else window.open(match[0], '_blank', 'noopener,noreferrer');
        };
        link.addEventListener('pointerdown', rememberPointerType);
        link.addEventListener('click', activate);
        terminal.element.append(link);
        this.overlays.push({
          element: link,
          dispose: {
            dispose: () => {
              link.removeEventListener('pointerdown', rememberPointerType);
              link.removeEventListener('click', activate);
            },
          },
        });
      }
    }
  }

  /** Removes all overlays, listeners, and terminal references. */
  dispose(): void {
    this.generation += 1;
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    this.clear();
    this.terminal = null;
  }

  private queueRefresh(): void {
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    queueMicrotask(() => {
      void this.refresh().catch(() => {
        this.refreshQueued = false;
      });
    });
  }

  private clear(): void {
    for (const overlay of this.overlays.splice(0)) {
      overlay.dispose.dispose();
      overlay.element.remove();
    }
  }
}

function cellColumns(
  cells: readonly RenderCell[],
  matchStart: number,
  matchLength: number
): { readonly column: number; readonly length: number } | null {
  if (cells.length === 0) return { column: matchStart, length: matchLength };
  const matchEnd = matchStart + matchLength;
  let offset = 0;
  const covered: RenderCell[] = [];
  for (const cell of cells) {
    const start = offset;
    if (cell.width !== 'spacer-head' && cell.width !== 'spacer-tail') {
      offset += (cell.text || ' ').length;
    }
    if (offset > matchStart && start < matchEnd) covered.push(cell);
  }
  const first = covered[0];
  const last = covered.at(-1);
  if (!first || !last) return null;
  const lastWidth = last.width === 'wide' ? 2 : last.width.startsWith('spacer') ? 0 : 1;
  return { column: first.x, length: Math.max(1, last.x + lastWidth - first.x) };
}
