export interface GhosttyDeclaredExports {
  readonly memory: WebAssembly.Memory;
  readonly __indirect_function_table: WebAssembly.Table;

  ghostty_type_json(): number;
  ghostty_build_info(field: number, out: number): number;
  ghostty_wasm_alloc(length: number): number;
  ghostty_wasm_free(pointer: number, length: number): void;
  ghostty_wasm_alloc_opaque(): number;
  ghostty_wasm_free_opaque(pointer: number): void;
  ghostty_wasm_take_opaque(slot: number): number;
  ghostty_sys_set(option: number, value: number): number;

  ghostty_color_palette_default(out: number): void;
  ghostty_color_palette_generate(
    base: number,
    skip: number,
    background: number,
    foreground: number,
    harmonious: boolean,
    out: number
  ): void;

  ghostty_terminal_new(allocator: number, out: number, cols: number, rows: number): number;
  ghostty_terminal_free(terminal: number): void;
  ghostty_terminal_reset(terminal: number): void;
  ghostty_terminal_resize(
    terminal: number,
    cols: number,
    rows: number,
    cellWidth: number,
    cellHeight: number
  ): number;
  ghostty_terminal_vt_write(terminal: number, data: number, length: number): void;
  ghostty_terminal_set(terminal: number, option: number, value: number): number;
  ghostty_terminal_get(terminal: number, data: number, out: number): number;
  ghostty_terminal_scroll_viewport(terminal: number, viewport: number): void;
  ghostty_terminal_paste(terminal: number, paste: number, outWritten: number): number;

  ghostty_render_state_new(allocator: number, out: number): number;
  ghostty_render_state_free(state: number): void;
  ghostty_render_state_update(state: number, terminal: number): number;
  ghostty_render_state_clean(state: number): number;
  ghostty_render_state_get(state: number, data: number, out: number): number;
  ghostty_render_state_row_iterator_new(allocator: number, out: number): number;
  ghostty_render_state_row_iterator_free(iterator: number): void;
  ghostty_render_state_row_iterator_next(iterator: number, outY: number): boolean;
  ghostty_render_state_row_iterator_next_dirty(iterator: number, outY: number): boolean;
  ghostty_render_state_row_get(iterator: number, data: number, out: number): number;
  ghostty_render_state_row_cells_new(allocator: number, out: number): number;
  ghostty_render_state_row_cells_free(cells: number): void;
  ghostty_render_state_row_cells_next(cells: number): boolean;
  ghostty_render_state_row_cells_select(cells: number, x: number): number;
  ghostty_render_state_row_cells_get(cells: number, data: number, out: number): number;

  ghostty_row_get(row: bigint, data: number, out: number): number;

  ghostty_key_event_new(allocator: number, out: number): number;
  ghostty_key_event_free(event: number): void;
  ghostty_key_event_set_action(event: number, action: number): void;
  ghostty_key_event_set_key(event: number, key: number): void;
  ghostty_key_event_set_mods(event: number, mods: number): void;
  ghostty_key_event_set_consumed_mods(event: number, mods: number): void;
  ghostty_key_event_set_composing(event: number, composing: boolean): void;
  ghostty_key_event_set_utf8(event: number, data: number, length: number): void;
  ghostty_key_event_set_unshifted_codepoint(event: number, codepoint: number): void;
  ghostty_key_encoder_new(allocator: number, out: number): number;
  ghostty_key_encoder_free(encoder: number): void;
  ghostty_key_encoder_setopt_from_terminal(encoder: number, terminal: number): void;
  ghostty_key_encoder_encode(
    encoder: number,
    event: number,
    out: number,
    capacity: number,
    outLength: number
  ): number;

  ghostty_focus_encode(event: number, out: number, capacity: number, outLength: number): number;
  ghostty_paste_encode(
    data: number,
    length: number,
    bracketed: boolean,
    out: number,
    capacity: number,
    outLength: number
  ): number;

  ghostty_mouse_event_new(allocator: number, out: number): number;
  ghostty_mouse_event_free(event: number): void;
  ghostty_mouse_event_set_action(event: number, action: number): void;
  ghostty_mouse_event_set_button(event: number, button: number): void;
  ghostty_mouse_event_clear_button(event: number): void;
  ghostty_mouse_event_set_mods(event: number, mods: number): void;
  ghostty_mouse_event_set_position(event: number, position: number): void;
  ghostty_mouse_encoder_new(allocator: number, out: number): number;
  ghostty_mouse_encoder_free(encoder: number): void;
  ghostty_mouse_encoder_setopt(encoder: number, option: number, value: number): void;
  ghostty_mouse_encoder_setopt_from_terminal(encoder: number, terminal: number): void;
  ghostty_mouse_encoder_reset(encoder: number): void;
  ghostty_mouse_encoder_encode(
    encoder: number,
    event: number,
    out: number,
    capacity: number,
    outLength: number
  ): number;

  ghostty_terminal_selection_format_buf(
    terminal: number,
    options: number,
    out: number,
    capacity: number,
    outLength: number
  ): number;
  ghostty_terminal_select_all(terminal: number, selection: number): number;
  ghostty_terminal_grid_ref(terminal: number, point: number, out: number): number;
  ghostty_grid_ref_cell(ref: number, out: number): number;
  ghostty_grid_ref_row(ref: number, out: number): number;
  ghostty_grid_ref_graphemes(ref: number, out: number, capacity: number, outLength: number): number;
  ghostty_grid_ref_style(ref: number, out: number): number;
  ghostty_grid_ref_hyperlink_uri(
    ref: number,
    out: number,
    capacity: number,
    outLength: number
  ): number;
  ghostty_cell_get(cell: bigint, data: number, out: number): number;
  ghostty_selection_gesture_new(allocator: number, out: number): number;
  ghostty_selection_gesture_free(gesture: number, terminal: number): void;
  ghostty_selection_gesture_reset(gesture: number, terminal: number): void;
  ghostty_selection_gesture_event_new(allocator: number, out: number, type: number): number;
  ghostty_selection_gesture_event_free(event: number): void;
  ghostty_selection_gesture_event_set(event: number, option: number, value: number): number;
  ghostty_selection_gesture_event(
    gesture: number,
    terminal: number,
    event: number,
    selection: number
  ): number;

  ghostty_snapshot_encode_buf(
    terminal: number,
    out: number,
    capacity: number,
    outLength: number
  ): number;
  ghostty_snapshot_decoder_new_buf(
    allocator: number,
    decoderOut: number,
    data: number,
    length: number
  ): number;
  ghostty_snapshot_decoder_decode(decoder: number, terminalOut: number): number;
  ghostty_snapshot_decoder_free(decoder: number): void;
}

export type GhosttyExports = WebAssembly.Exports & GhosttyDeclaredExports;

export interface CallbackBridgeExports extends WebAssembly.Exports {
  readonly write_pty: WebAssembly.ExportValue;
  readonly bell: WebAssembly.ExportValue;
  readonly title_changed: WebAssembly.ExportValue;
  readonly pwd_changed: WebAssembly.ExportValue;
  readonly desktop_notification: WebAssembly.ExportValue;
  readonly progress_report: WebAssembly.ExportValue;
  readonly clipboard_read: WebAssembly.ExportValue;
  readonly clipboard_write: WebAssembly.ExportValue;
  readonly mime_reader: WebAssembly.ExportValue;
  readonly random_secure: WebAssembly.ExportValue;
  readonly color_scheme: WebAssembly.ExportValue;
}
