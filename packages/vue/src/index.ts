import { type BrowserTerminal, createTerminal, type TerminalOptions } from '@gespenst/core';
import {
  defineComponent,
  h,
  onBeforeUnmount,
  onMounted,
  type PropType,
  type Ref,
  ref,
  type ShallowRef,
  shallowRef,
} from 'vue';

/** Reactive values returned by {@link useGespenstTerminal}. */
export interface UseGespenstTerminalResult {
  /** Assign this ref to the DOM element that should host the terminal. */
  readonly container: Ref<HTMLElement | null>;
  /** Active terminal instance, or `null` before mount and after unmount. */
  readonly terminal: ShallowRef<BrowserTerminal | null>;
}

/**
 * Vue composable that creates a terminal when its returned container ref mounts and disposes it
 * before unmount.
 */
export function useGespenstTerminal(
  options: Omit<TerminalOptions, 'container'> = {}
): UseGespenstTerminalResult {
  const container = ref<HTMLElement | null>(null);
  const terminal = shallowRef<BrowserTerminal | null>(null);
  let cancelled = false;
  onMounted(async () => {
    if (!container.value) return;
    const created = await createTerminal({ ...options, container: container.value });
    if (cancelled) created.dispose();
    else terminal.value = created;
  });
  onBeforeUnmount(() => {
    cancelled = true;
    terminal.value?.dispose();
    terminal.value = null;
  });
  return { container, terminal };
}

/**
 * Vue component that fills its host, owns the terminal lifecycle, and emits `ready` or `error`.
 */
export const GespenstTerminal = defineComponent({
  name: 'GespenstTerminal',
  props: {
    /** Core terminal options other than the component-owned container. */
    options: {
      /** Vue runtime type declaration for terminal options. */
      type: Object as PropType<Omit<TerminalOptions, 'container'>>,
      /** Supplies core terminal options other than the component-owned container. */
      default: () => ({}),
    },
  },
  emits: {
    /** Emitted once the asynchronous terminal is ready. */
    ready: (_terminal: BrowserTerminal) => true,
    /** Emitted when terminal creation fails. */
    error: (_error: Error) => true,
  },
  setup(props, { emit, attrs }) {
    const container = ref<HTMLElement | null>(null);
    let terminal: BrowserTerminal | null = null;
    let cancelled = false;
    onMounted(async () => {
      if (!container.value) return;
      try {
        const created = await createTerminal({ ...props.options, container: container.value });
        if (cancelled) created.dispose();
        else {
          terminal = created;
          emit('ready', created);
        }
      } catch (error) {
        if (!cancelled) emit('error', error instanceof Error ? error : new Error(String(error)));
      }
    });
    onBeforeUnmount(() => {
      cancelled = true;
      terminal?.dispose();
    });
    return () =>
      h('div', {
        ...attrs,
        ref: container,
        style: { width: '100%', height: '100%', ...(attrs.style as object) },
      });
  },
});
