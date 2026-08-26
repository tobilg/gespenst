import type { Allocation, GhosttyBindings } from './bindings.js';
import type { KeyInput } from './types.js';

const CODE_ALIASES: Readonly<Record<string, string>> = {
  Backquote: 'BACKQUOTE',
  Backslash: 'BACKSLASH',
  BracketLeft: 'BRACKET_LEFT',
  BracketRight: 'BRACKET_RIGHT',
  Comma: 'COMMA',
  Equal: 'EQUAL',
  IntlBackslash: 'INTL_BACKSLASH',
  IntlRo: 'INTL_RO',
  IntlYen: 'INTL_YEN',
  Minus: 'MINUS',
  Period: 'PERIOD',
  Quote: 'QUOTE',
  Semicolon: 'SEMICOLON',
  Slash: 'SLASH',
};

function enumKey(code: string): string {
  const alias = CODE_ALIASES[code];
  if (alias) return alias;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return `DIGIT_${code.slice(5)}`;
  if (/^Numpad[0-9]$/.test(code)) return `NUMPAD_${code.slice(6)}`;
  return code.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

export class InputEncoder {
  private readonly encoder: number;
  private readonly event: number;
  private readonly written: Allocation;
  private output: Allocation;
  private disposed = false;
  private readonly bindings: GhosttyBindings;

  constructor(bindings: GhosttyBindings) {
    this.bindings = bindings;
    const e = bindings.exports;
    this.encoder = bindings.createHandle('ghostty_key_encoder_new', (slot) =>
      e.ghostty_key_encoder_new(0, slot)
    );
    this.event = bindings.createHandle('ghostty_key_event_new', (slot) =>
      e.ghostty_key_event_new(0, slot)
    );
    this.written = bindings.alloc(4);
    this.output = bindings.alloc(128);
  }

  key(terminal: number, input: KeyInput): Uint8Array {
    this.ensureActive();
    const e = this.bindings.exports;
    e.ghostty_key_event_set_action(
      this.event,
      this.bindings.abi.value('GhosttyKeyAction', (input.action ?? 'press').toUpperCase())
    );
    let key: number;
    try {
      key = this.bindings.abi.value('GhosttyKey', enumKey(input.code));
    } catch {
      key = this.bindings.abi.value('GhosttyKey', 'UNIDENTIFIED');
    }
    e.ghostty_key_event_set_key(this.event, key);
    e.ghostty_key_event_set_mods(this.event, input.modifiers ?? 0);
    e.ghostty_key_event_set_consumed_mods(this.event, input.consumedModifiers ?? 0);
    e.ghostty_key_event_set_composing(this.event, input.composing ?? false);
    e.ghostty_key_event_set_unshifted_codepoint(this.event, input.unshiftedCodepoint ?? 0);
    this.bindings.withBytes(input.text ?? '', (pointer, length) => {
      e.ghostty_key_event_set_utf8(this.event, pointer, length);
      e.ghostty_key_encoder_setopt_from_terminal(this.encoder, terminal);
      return this.encode((out, capacity, written) =>
        e.ghostty_key_encoder_encode(this.encoder, this.event, out, capacity, written)
      );
    });
    return this.currentOutput();
  }

  focus(focused: boolean): Uint8Array {
    this.ensureActive();
    return this.encode((out, capacity, written) =>
      this.bindings.exports.ghostty_focus_encode(
        this.bindings.abi.value('GhosttyFocusEvent', focused ? 'GAINED' : 'LOST'),
        out,
        capacity,
        written
      )
    );
  }

  paste(data: string | Uint8Array, bracketed: boolean): Uint8Array {
    this.ensureActive();
    return this.bindings.withBytes(data, (pointer, length) =>
      this.encode((out, capacity, written) =>
        this.bindings.exports.ghostty_paste_encode(
          pointer,
          length,
          bracketed,
          out,
          capacity,
          written
        )
      )
    );
  }

  text(data: string | Uint8Array): Uint8Array {
    return typeof data === 'string' ? new TextEncoder().encode(data) : data.slice();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.bindings.exports.ghostty_key_event_free(this.event);
    this.bindings.exports.ghostty_key_encoder_free(this.encoder);
    this.written.free();
    this.output.free();
  }

  private encode(
    operation: (out: number, capacity: number, written: number) => number
  ): Uint8Array {
    const outOfSpace = this.bindings.abi.value('GhosttyResult', 'OUT_OF_SPACE');
    for (;;) {
      this.written.view.setUint32(0, 0, true);
      const result = operation(this.output.pointer, this.output.length, this.written.pointer);
      const length = this.written.view.getUint32(0, true);
      if (result === 0) return this.output.bytes.slice(0, length);
      if (result !== outOfSpace) this.bindings.check(result, 'encode terminal input');
      this.output.free();
      this.output = this.bindings.alloc(Math.max(length, this.output.length * 2));
    }
  }

  private currentOutput(): Uint8Array {
    const length = this.written.view.getUint32(0, true);
    return this.output.bytes.slice(0, length);
  }

  private ensureActive(): void {
    if (this.disposed) throw new Error('InputEncoder is disposed');
  }
}
