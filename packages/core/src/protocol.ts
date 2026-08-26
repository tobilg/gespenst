import type {
  ClipboardLocation,
  ClipboardPasteResult,
  ClipboardProtocolOptions,
  CoreTerminalOptions,
  KeyInput,
  PointerInput,
  TerminalBufferRange,
  TerminalBufferSnapshot,
  TerminalBufferState,
  TerminalTheme,
  ViewportSnapshot,
  WasmSource,
} from './core/types.js';
import type { RendererInfo, RendererPreference, RenderMetrics } from './renderers/hybrid.js';
import type { TerminalFontFace } from './types.js';

/** Version of the internal main-thread/worker message protocol. */
export const TERMINAL_PROTOCOL_VERSION = 6 as const;

type WorkerWasmSource = Exclude<WasmSource, Response | URL>;

export interface WorkerClipboardContent {
  readonly mime: string;
  readonly data: ArrayBuffer;
}

export interface WorkerClipboardPasteRequest {
  readonly contents: readonly WorkerClipboardContent[];
  readonly location?: ClipboardLocation;
  readonly allowUnsafe?: boolean;
}

export interface WorkerInitOptions extends CoreTerminalOptions {
  /** Stable main-thread identity for the runtime sources used by a shared worker. */
  readonly runtimeKey: number;
  readonly metrics: RenderMetrics;
  readonly renderer: RendererPreference;
  readonly accessibility: boolean;
  readonly allowTransparency: boolean;
  readonly minimumContrastRatio: number;
  readonly backgroundCanvas: OffscreenCanvas;
  readonly textCanvas: OffscreenCanvas;
  readonly wasm?: WorkerWasmSource;
  readonly callbacksWasm?: WorkerWasmSource;
}

export type MainToWorkerPayload =
  | { readonly type: 'init'; readonly version: 6; readonly options: WorkerInitOptions }
  | { readonly type: 'write'; readonly data: ArrayBuffer; readonly requestId?: number }
  | {
      readonly type: 'resize';
      readonly cols: number;
      readonly rows: number;
      readonly metrics: RenderMetrics;
    }
  | { readonly type: 'key'; readonly input: KeyInput }
  | { readonly type: 'pointer'; readonly input: PointerInput }
  | { readonly type: 'wheel'; readonly input: PointerInput; readonly lines: number }
  | { readonly type: 'text'; readonly data: string }
  | { readonly type: 'paste'; readonly data: string }
  | {
      readonly type: 'clipboardEnable';
      readonly requestId: number;
      readonly options: ClipboardProtocolOptions;
    }
  | { readonly type: 'clipboardDisable' }
  | {
      readonly type: 'clipboardPaste';
      readonly requestId: number;
      readonly request: WorkerClipboardPasteRequest;
    }
  | { readonly type: 'focus'; readonly focused: boolean }
  | { readonly type: 'scroll'; readonly delta: number | 'top' | 'bottom' }
  | { readonly type: 'selectAll' }
  | { readonly type: 'clearSelection' }
  | { readonly type: 'getSelection'; readonly requestId: number }
  | { readonly type: 'snapshot'; readonly requestId: number }
  | { readonly type: 'viewport'; readonly requestId: number }
  | { readonly type: 'buffer'; readonly requestId: number; readonly range?: TerminalBufferRange }
  | { readonly type: 'loadFont'; readonly requestId: number; readonly face: TerminalFontFace }
  | { readonly type: 'reset' }
  | { readonly type: 'restore'; readonly requestId: number; readonly data: ArrayBuffer }
  | { readonly type: 'theme'; readonly requestId: number; readonly theme: TerminalTheme }
  | { readonly type: 'scrollback'; readonly lines: number }
  | {
      readonly type: 'defaultCursor';
      readonly style: import('./core/types.js').CursorStyle;
      readonly blink: boolean;
    }
  | { readonly type: 'accessibility'; readonly enabled: boolean }
  | { readonly type: 'minimumContrast'; readonly ratio: number }
  | { readonly type: 'dispose' };

export type MainToWorkerMessage = MainToWorkerPayload & { readonly terminalId: number };

export type WorkerEventName =
  | 'bell'
  | 'title'
  | 'cwd'
  | 'notification'
  | 'progress'
  | 'clipboardWrite';

export type WorkerToMainPayload =
  | { readonly type: 'ready'; readonly renderer: RendererInfo }
  | { readonly type: 'input'; readonly data: ArrayBuffer; readonly source: string }
  | { readonly type: 'event'; readonly name: WorkerEventName; readonly value: unknown }
  | { readonly type: 'a11y'; readonly rows: readonly string[] }
  | { readonly type: 'rendered'; readonly state: TerminalBufferState }
  | { readonly type: 'selection'; readonly requestId: number; readonly value: string }
  | { readonly type: 'snapshot'; readonly requestId: number; readonly value: ArrayBuffer }
  | { readonly type: 'viewport'; readonly requestId: number; readonly value: ViewportSnapshot }
  | {
      readonly type: 'buffer';
      readonly requestId: number;
      readonly value: TerminalBufferSnapshot;
    }
  | { readonly type: 'fontLoaded'; readonly requestId: number }
  | { readonly type: 'written'; readonly requestId: number }
  | { readonly type: 'restored'; readonly requestId: number }
  | { readonly type: 'themed'; readonly requestId: number }
  | { readonly type: 'clipboardEnabled'; readonly requestId: number }
  | {
      readonly type: 'clipboardPasted';
      readonly requestId: number;
      readonly value: ClipboardPasteResult;
    }
  | {
      readonly type: 'error';
      readonly message: string;
      readonly stack?: string;
      readonly requestId?: number;
    };

export type WorkerToMainMessage = WorkerToMainPayload & { readonly terminalId: number };
