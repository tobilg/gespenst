import { type BrowserTerminal, createTerminal, type TerminalOptions } from '@gespenst/core';
import {
  type CSSProperties,
  createElement,
  forwardRef,
  type HTMLAttributes,
  type RefObject,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';

/** Props accepted by the {@link GespenstTerminal} React component. */
export interface GespenstTerminalProps
  extends Omit<HTMLAttributes<HTMLDivElement>, 'onError'>,
    Omit<TerminalOptions, 'container'> {
  /** Called once the asynchronous Ghostty runtime and terminal are ready. */
  readonly onReady?: (terminal: BrowserTerminal) => void;
  /** Called when terminal creation fails. */
  readonly onTerminalError?: (error: Error) => void;
}

/**
 * A full-size React terminal container that creates and disposes its terminal with the component.
 * The forwarded ref exposes the active native {@link BrowserTerminal}.
 */
export const GespenstTerminal = forwardRef<BrowserTerminal | null, GespenstTerminalProps>(
  function GespenstTerminalComponent(props, ref) {
    const {
      onReady,
      onTerminalError,
      className,
      style,
      worker,
      renderer,
      allowTransparency,
      minimumContrastRatio,
      fontFamily,
      fontSizePx,
      lineHeight,
      fontWeight,
      fontWeightBold,
      letterSpacingPx,
      accessibility,
      ariaLabel,
      wasm,
      callbacksWasm,
      cols,
      rows,
      cellWidthPx,
      cellHeightPx,
      scrollbackLines,
      theme,
      ...elementProps
    } = props;
    const container = useRef<HTMLDivElement>(null);
    const onReadyRef = useRef(onReady);
    const onTerminalErrorRef = useRef(onTerminalError);
    onReadyRef.current = onReady;
    onTerminalErrorRef.current = onTerminalError;
    const [terminal, setTerminal] = useState<BrowserTerminal | null>(null);
    useImperativeHandle(ref, () => terminal as BrowserTerminal, [terminal]);

    useEffect(() => {
      const host = container.current;
      if (!host) return;
      let cancelled = false;
      let value: BrowserTerminal | null = null;
      void createTerminal({
        container: host,
        ...(worker === undefined ? {} : { worker }),
        ...(renderer === undefined ? {} : { renderer }),
        ...(allowTransparency === undefined ? {} : { allowTransparency }),
        ...(minimumContrastRatio === undefined ? {} : { minimumContrastRatio }),
        ...(fontFamily === undefined ? {} : { fontFamily }),
        ...(fontSizePx === undefined ? {} : { fontSizePx }),
        ...(lineHeight === undefined ? {} : { lineHeight }),
        ...(fontWeight === undefined ? {} : { fontWeight }),
        ...(fontWeightBold === undefined ? {} : { fontWeightBold }),
        ...(letterSpacingPx === undefined ? {} : { letterSpacingPx }),
        ...(accessibility === undefined ? {} : { accessibility }),
        ...(ariaLabel === undefined ? {} : { ariaLabel }),
        ...(wasm === undefined ? {} : { wasm }),
        ...(callbacksWasm === undefined ? {} : { callbacksWasm }),
        ...(cols === undefined ? {} : { cols }),
        ...(rows === undefined ? {} : { rows }),
        ...(cellWidthPx === undefined ? {} : { cellWidthPx }),
        ...(cellHeightPx === undefined ? {} : { cellHeightPx }),
        ...(scrollbackLines === undefined ? {} : { scrollbackLines }),
        ...(theme === undefined ? {} : { theme }),
      })
        .then((created) => {
          if (cancelled) return created.dispose();
          value = created;
          setTerminal(created);
          onReadyRef.current?.(created);
        })
        .catch((error) => {
          if (!cancelled)
            onTerminalErrorRef.current?.(error instanceof Error ? error : new Error(String(error)));
        });
      return () => {
        cancelled = true;
        value?.dispose();
        setTerminal(null);
      };
    }, [
      accessibility,
      ariaLabel,
      callbacksWasm,
      cellHeightPx,
      cellWidthPx,
      cols,
      fontFamily,
      fontSizePx,
      fontWeight,
      fontWeightBold,
      letterSpacingPx,
      lineHeight,
      renderer,
      allowTransparency,
      minimumContrastRatio,
      rows,
      scrollbackLines,
      theme,
      wasm,
      worker,
    ]);

    return createElement('div', {
      ...elementProps,
      ref: container,
      className,
      style: { width: '100%', height: '100%', ...(style as CSSProperties) },
    });
  }
);

/** Values returned by {@link useGespenstTerminal}. */
export interface UseGespenstTerminalResult {
  /** Attach this ref to the element that will host the terminal. */
  readonly ref: RefObject<HTMLDivElement | null>;
  /** The current terminal, or `null` before one has been assigned. */
  readonly terminal: BrowserTerminal | null;
  /** Updates the terminal exposed to consumers of the hook. */
  readonly setTerminal: (terminal: BrowserTerminal | null) => void;
}

/**
 * Creates a host element ref and state for integrations that manage terminal creation themselves.
 */
export function useGespenstTerminal(): UseGespenstTerminalResult {
  const ref = useRef<HTMLDivElement>(null);
  const [terminal, setTerminal] = useState<BrowserTerminal | null>(null);
  return { ref, terminal, setTerminal };
}
