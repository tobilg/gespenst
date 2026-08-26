import type { Allocation, GhosttyBindings } from './bindings.js';
import type { PointerInput, TerminalGeometry } from './types.js';

export class PointerController {
  private readonly mouseEncoder: number;
  private readonly mouseEvent: number;
  private readonly selectionGesture: number;
  private readonly selectionEvents: Readonly<Record<'press' | 'release' | 'drag', number>>;
  private readonly outputLength: Allocation;
  private output: Allocation;
  private readonly scalar: Allocation;
  private readonly mouseSize: Allocation;
  private readonly mousePosition: Allocation;
  private readonly point: Allocation;
  private readonly gridRef: Allocation;
  private readonly selection: Allocation;
  private readonly position: Allocation;
  private readonly geometryValue: Allocation;
  private readonly time: Allocation;
  private readonly repeatDistance: Allocation;
  private readonly repeatInterval: Allocation;
  private readonly rectangle: Allocation;
  private disposed = false;
  private readonly bindings: GhosttyBindings;

  constructor(bindings: GhosttyBindings) {
    this.bindings = bindings;
    const e = bindings.exports;
    this.mouseEncoder = bindings.createHandle('ghostty_mouse_encoder_new', (slot) =>
      e.ghostty_mouse_encoder_new(0, slot)
    );
    this.mouseEvent = bindings.createHandle('ghostty_mouse_event_new', (slot) =>
      e.ghostty_mouse_event_new(0, slot)
    );
    this.selectionGesture = bindings.createHandle('ghostty_selection_gesture_new', (slot) =>
      e.ghostty_selection_gesture_new(0, slot)
    );
    const selectionEvent = (name: 'PRESS' | 'RELEASE' | 'DRAG') =>
      bindings.createHandle(`ghostty_selection_gesture_event_new(${name})`, (slot) =>
        e.ghostty_selection_gesture_event_new(
          0,
          slot,
          bindings.abi.value('GhosttySelectionGestureEventType', name)
        )
      );
    this.selectionEvents = {
      press: selectionEvent('PRESS'),
      release: selectionEvent('RELEASE'),
      drag: selectionEvent('DRAG'),
    };
    this.outputLength = bindings.alloc(4);
    this.output = bindings.alloc(128);
    this.scalar = bindings.alloc(4);
    this.mouseSize = bindings.allocType('GhosttyMouseEncoderSize', true);
    this.mousePosition = bindings.allocType('GhosttyMousePosition');
    this.point = bindings.allocType('GhosttyPoint');
    this.gridRef = bindings.allocType('GhosttyGridRef', true);
    this.selection = bindings.allocType('GhosttySelection', true);
    this.position = bindings.allocType('GhosttySurfacePosition');
    this.geometryValue = bindings.allocType('GhosttySelectionGestureGeometry');
    this.time = bindings.alloc(8);
    this.repeatDistance = bindings.alloc(8);
    this.repeatInterval = bindings.alloc(8);
    this.rectangle = bindings.alloc(1);
  }

  tracking(terminal: number): number {
    this.bindings.check(
      this.bindings.exports.ghostty_terminal_get(
        terminal,
        this.bindings.abi.value('GhosttyTerminalData', 'MOUSE_TRACKING'),
        this.scalar.pointer
      ),
      'read mouse tracking mode'
    );
    return this.scalar.view.getInt32(0, true);
  }

  handle(
    terminal: number,
    input: PointerInput,
    geometry: TerminalGeometry
  ): { readonly data: Uint8Array; readonly selected: boolean } {
    this.ensureActive();
    if (!input.forceSelection && this.tracking(terminal) !== 0) {
      return { data: this.encodeMouse(terminal, input, geometry), selected: false };
    }
    if (input.action === 'motion' && !input.anyButtonPressed) {
      return { data: new Uint8Array(), selected: false };
    }
    this.select(terminal, input, geometry);
    return { data: new Uint8Array(), selected: true };
  }

  resetSelection(terminal: number): void {
    this.bindings.exports.ghostty_selection_gesture_reset(this.selectionGesture, terminal);
  }

  dispose(terminal: number): void {
    if (this.disposed) return;
    this.disposed = true;
    const e = this.bindings.exports;
    e.ghostty_mouse_event_free(this.mouseEvent);
    e.ghostty_mouse_encoder_free(this.mouseEncoder);
    for (const event of Object.values(this.selectionEvents)) {
      e.ghostty_selection_gesture_event_free(event);
    }
    e.ghostty_selection_gesture_free(this.selectionGesture, terminal);
    for (const allocation of [
      this.outputLength,
      this.output,
      this.scalar,
      this.mouseSize,
      this.mousePosition,
      this.point,
      this.gridRef,
      this.selection,
      this.position,
      this.geometryValue,
      this.time,
      this.repeatDistance,
      this.repeatInterval,
      this.rectangle,
    ])
      allocation.free();
  }

  private encodeMouse(
    terminal: number,
    input: PointerInput,
    geometry: TerminalGeometry
  ): Uint8Array {
    const e = this.bindings.exports;
    const abi = this.bindings.abi;
    e.ghostty_mouse_event_set_action(
      this.mouseEvent,
      abi.value('GhosttyMouseAction', input.action.toUpperCase())
    );
    if (input.button) {
      e.ghostty_mouse_event_set_button(
        this.mouseEvent,
        abi.value('GhosttyMouseButton', input.button.toUpperCase())
      );
    } else e.ghostty_mouse_event_clear_button(this.mouseEvent);
    e.ghostty_mouse_event_set_mods(this.mouseEvent, input.modifiers ?? 0);
    this.mousePosition.view.setFloat32(
      abi.field('GhosttyMousePosition', 'x').offset,
      input.x,
      true
    );
    this.mousePosition.view.setFloat32(
      abi.field('GhosttyMousePosition', 'y').offset,
      input.y,
      true
    );
    e.ghostty_mouse_event_set_position(this.mouseEvent, this.mousePosition.pointer);
    e.ghostty_mouse_encoder_setopt_from_terminal(this.mouseEncoder, terminal);
    const sizeField = (name: string) => abi.field('GhosttyMouseEncoderSize', name).offset;
    this.mouseSize.view.setUint32(sizeField('screen_width'), geometry.widthPx, true);
    this.mouseSize.view.setUint32(sizeField('screen_height'), geometry.heightPx, true);
    this.mouseSize.view.setUint32(sizeField('cell_width'), geometry.cellWidthPx, true);
    this.mouseSize.view.setUint32(sizeField('cell_height'), geometry.cellHeightPx, true);
    e.ghostty_mouse_encoder_setopt(
      this.mouseEncoder,
      abi.value('GhosttyMouseEncoderOption', 'SIZE'),
      this.mouseSize.pointer
    );
    this.scalar.view.setUint8(0, input.anyButtonPressed ? 1 : 0);
    e.ghostty_mouse_encoder_setopt(
      this.mouseEncoder,
      abi.value('GhosttyMouseEncoderOption', 'ANY_BUTTON_PRESSED'),
      this.scalar.pointer
    );
    const outOfSpace = abi.value('GhosttyResult', 'OUT_OF_SPACE');
    for (;;) {
      this.outputLength.view.setUint32(0, 0, true);
      const result = e.ghostty_mouse_encoder_encode(
        this.mouseEncoder,
        this.mouseEvent,
        this.output.pointer,
        this.output.length,
        this.outputLength.pointer
      );
      const length = this.outputLength.view.getUint32(0, true);
      if (result === 0) return this.output.bytes.slice(0, length);
      if (result !== outOfSpace) this.bindings.check(result, 'encode mouse input');
      const previousLength = this.output.length;
      this.output.free();
      this.output = this.bindings.alloc(Math.max(length, previousLength * 2));
    }
  }

  private select(terminal: number, input: PointerInput, geometry: TerminalGeometry): void {
    const e = this.bindings.exports;
    const abi = this.bindings.abi;
    const eventName = input.action === 'motion' ? 'drag' : input.action;
    const event = this.selectionEvents[eventName];
    const pointValue = abi.field('GhosttyPoint', 'value').offset;
    const coordinateX = abi.field('GhosttyPointCoordinate', 'x').offset;
    const coordinateY = abi.field('GhosttyPointCoordinate', 'y').offset;
    this.point.bytes.fill(0);
    this.point.view.setInt32(
      abi.field('GhosttyPoint', 'tag').offset,
      abi.value('GhosttyPointTag', 'VIEWPORT'),
      true
    );
    const cellX = Math.max(
      0,
      Math.min(geometry.cols - 1, Math.floor(input.x / geometry.cellWidthPx))
    );
    const cellY = Math.max(
      0,
      Math.min(geometry.rows - 1, Math.floor(input.y / geometry.cellHeightPx))
    );
    this.point.view.setUint16(pointValue + coordinateX, cellX, true);
    this.point.view.setUint32(pointValue + coordinateY, cellY, true);
    this.gridRef.bytes.fill(0);
    this.gridRef.view.setUint32(0, this.gridRef.length, true);
    const gridResult = e.ghostty_terminal_grid_ref(
      terminal,
      this.point.pointer,
      this.gridRef.pointer
    );
    if (gridResult !== 0 && input.action === 'release') {
      this.setGestureOption(event, 'REF', 0);
    } else {
      this.bindings.check(gridResult, 'resolve selection grid reference');
      this.setGestureOption(event, 'REF', this.gridRef.pointer);
    }
    if (input.action !== 'release') {
      this.position.view.setFloat64(abi.field('GhosttySurfacePosition', 'x').offset, input.x, true);
      this.position.view.setFloat64(abi.field('GhosttySurfacePosition', 'y').offset, input.y, true);
      this.setGestureOption(event, 'POSITION', this.position.pointer);
    }
    if (input.action === 'press') {
      this.time.view.setBigUint64(
        0,
        BigInt(Math.round((input.timeMs ?? performance.now()) * 1_000_000)),
        true
      );
      this.repeatDistance.view.setFloat64(0, 5 * (globalThis.devicePixelRatio || 1), true);
      this.repeatInterval.view.setBigUint64(0, 500_000_000n, true);
      this.setGestureOption(event, 'TIME_NS', this.time.pointer);
      this.setGestureOption(event, 'REPEAT_DISTANCE', this.repeatDistance.pointer);
      this.setGestureOption(event, 'REPEAT_INTERVAL_NS', this.repeatInterval.pointer);
    } else if (input.action === 'motion') {
      const field = (name: string) => abi.field('GhosttySelectionGestureGeometry', name).offset;
      this.geometryValue.view.setUint32(field('columns'), geometry.cols, true);
      this.geometryValue.view.setUint32(field('cell_width'), geometry.cellWidthPx, true);
      this.geometryValue.view.setUint32(field('padding_left'), 0, true);
      this.geometryValue.view.setUint32(field('screen_height'), geometry.heightPx, true);
      this.rectangle.view.setUint8(0, input.rectangle ? 1 : 0);
      this.setGestureOption(event, 'GEOMETRY', this.geometryValue.pointer);
      this.setGestureOption(event, 'RECTANGLE', this.rectangle.pointer);
    }
    this.selection.bytes.fill(0);
    this.selection.view.setUint32(0, this.selection.length, true);
    const result = e.ghostty_selection_gesture_event(
      this.selectionGesture,
      terminal,
      event,
      this.selection.pointer
    );
    if (result === 0) {
      this.bindings.check(
        e.ghostty_terminal_set(
          terminal,
          abi.value('GhosttyTerminalOption', 'SELECTION'),
          this.selection.pointer
        ),
        'apply pointer selection'
      );
    } else if (result !== abi.value('GhosttyResult', 'NO_VALUE')) {
      this.bindings.check(result, 'update pointer selection');
    }
  }

  private setGestureOption(event: number, name: string, value: number): void {
    this.bindings.check(
      this.bindings.exports.ghostty_selection_gesture_event_set(
        event,
        this.bindings.abi.value('GhosttySelectionGestureEventOption', name),
        value
      ),
      `set selection gesture option ${name}`
    );
  }

  private ensureActive(): void {
    if (this.disposed) throw new Error('PointerController is disposed');
  }
}
