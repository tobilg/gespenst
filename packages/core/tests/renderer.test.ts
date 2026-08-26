import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RenderCell, RenderCursor, ViewportSnapshot } from '../src/core/types.js';
import { HybridRenderer, type RenderMetrics } from '../src/renderers/hybrid.js';

const metrics: RenderMetrics = {
  width: 80,
  height: 40,
  cellWidth: 10,
  cellHeight: 20,
  fontSize: 14,
  fontFamily: 'Test Mono',
  fontWeight: 400,
  fontWeightBold: 700,
  letterSpacing: 1,
  devicePixelRatio: 2,
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('HybridRenderer', () => {
  it('renders styled canvas rows, cursor variants, focus, contrast, blink, and resize', async () => {
    vi.useFakeTimers();
    const background = fakeCanvas({ '2d': fake2dContext() });
    const textContext = fake2dContext();
    textContext.measureText.mockReturnValue({ width: 5 } as TextMetrics);
    const text = fakeCanvas({ '2d': textContext.value });
    const renderer = await HybridRenderer.create(
      background.canvas,
      text.canvas,
      metrics,
      'canvas2d',
      true,
      7
    );

    expect(renderer.info).toEqual({ backend: 'canvas2d', textShaping: 'browser-canvas' });
    renderer.render(
      snapshot([
        cell(0, 'A', { bold: true, inverse: true, underline: 1 }),
        cell(1, '\ue0b0'),
        cell(2, 'B', { blink: true }),
        cell(3, 'C', { faint: true, strikethrough: true }),
      ])
    );

    expect(textContext.fillText).toHaveBeenCalled();
    expect(textContext.scale).toHaveBeenCalled();
    expect(textContext.beginPath).toHaveBeenCalled();
    expect(textContext.fillRect).toHaveBeenCalled();
    expect(textContext.value.letterSpacing).toBe('1px');
    const beforeFocus = textContext.clearRect.mock.calls.length;
    renderer.setFocused(true);
    renderer.setFocused(true);
    expect(textContext.clearRect.mock.calls.length).toBeGreaterThan(beforeFocus);

    vi.advanceTimersByTime(500);
    expect(textContext.clearRect.mock.calls.length).toBeGreaterThan(beforeFocus + 1);

    for (const style of ['bar', 'underline', 'block-hollow', 'block'] as const) {
      renderer.render(snapshot([cell(0, 'X')], { style }));
    }
    renderer.resize({ ...metrics, width: 100, height: 60 });
    expect(background.canvas.width).toBe(100);
    expect(text.canvas.height).toBe(60);
    renderer.dispose();
  });

  it('falls back in auto mode and rejects an explicit unavailable WebGPU backend', async () => {
    vi.stubGlobal('navigator', {});
    const background = fakeCanvas({ '2d': fake2dContext().value, webgl2: null });
    const text = fakeCanvas({ '2d': fake2dContext().value });

    const fallback = await HybridRenderer.create(background.canvas, text.canvas, metrics, 'auto');
    expect(fallback.info.backend).toBe('canvas2d');
    fallback.dispose();

    await expect(
      HybridRenderer.create(background.canvas, text.canvas, metrics, 'webgpu')
    ).rejects.toThrow('WebGPU is unavailable');
  });

  it('initializes WebGPU, draws, resizes, restores a lost device, and disposes', async () => {
    const first = fakeWebGpuDevice();
    const second = fakeWebGpuDevice();
    const requestDevice = vi
      .fn<() => Promise<GPUDevice>>()
      .mockResolvedValueOnce(first.value)
      .mockResolvedValueOnce(second.value);
    const gpuContext = fakeWebGpuContext();
    const gpu = {
      requestAdapter: vi.fn(async () => ({ requestDevice })),
      getPreferredCanvasFormat: vi.fn(() => 'bgra8unorm'),
    } as unknown as GPU;
    vi.stubGlobal('navigator', { gpu });
    const background = fakeCanvas({ webgpu: gpuContext.value });
    const text = fakeCanvas({ '2d': fake2dContext().value });
    const renderer = await HybridRenderer.create(
      background.canvas,
      text.canvas,
      metrics,
      'webgpu',
      true
    );

    expect(renderer.info.backend).toBe('webgpu');
    expect(gpuContext.configure).toHaveBeenLastCalledWith({
      device: first.value,
      format: 'bgra8unorm',
      alphaMode: 'premultiplied',
    });
    renderer.render(snapshot([cell(0, 'A')]));
    expect(first.writeBuffer).toHaveBeenCalled();
    expect(first.draw).toHaveBeenCalled();
    expect(first.submit).toHaveBeenCalled();

    renderer.resize({ ...metrics, width: 120, height: 80 });
    expect(background.canvas.width).toBe(120);
    expect(gpuContext.configure).toHaveBeenLastCalledWith({
      device: first.value,
      format: 'bgra8unorm',
      alphaMode: 'premultiplied',
    });

    first.lose();
    await vi.waitFor(() => expect(requestDevice).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(second.draw).toHaveBeenCalled());
    expect(first.bufferDestroy).toHaveBeenCalled();
    expect(gpuContext.configure).toHaveBeenLastCalledWith({
      device: second.value,
      format: 'bgra8unorm',
      alphaMode: 'premultiplied',
    });

    renderer.dispose();
    expect(second.bufferDestroy).toHaveBeenCalled();
    expect(second.deviceDestroy).toHaveBeenCalledOnce();
  });

  it('uses an opaque WebGPU surface when transparency is disabled', async () => {
    const device = fakeWebGpuDevice();
    const gpuContext = fakeWebGpuContext();
    vi.stubGlobal('navigator', {
      gpu: {
        requestAdapter: vi.fn(async () => ({ requestDevice: async () => device.value })),
        getPreferredCanvasFormat: vi.fn(() => 'bgra8unorm'),
      },
    });
    const renderer = await HybridRenderer.create(
      fakeCanvas({ webgpu: gpuContext.value }).canvas,
      fakeCanvas({ '2d': fake2dContext().value }).canvas,
      metrics,
      'webgpu'
    );
    expect(gpuContext.configure).toHaveBeenCalledWith({
      device: device.value,
      format: 'bgra8unorm',
      alphaMode: 'opaque',
    });
    renderer.dispose();
  });

  it('initializes WebGL, pauses on context loss, restores, and releases resources', async () => {
    vi.stubGlobal('navigator', {});
    const gl = fakeWebGl();
    const background = fakeCanvas({ webgl2: gl.value });
    const text = fakeCanvas({ '2d': fake2dContext().value });
    const renderer = await HybridRenderer.create(background.canvas, text.canvas, metrics, 'webgl2');
    renderer.render(snapshot([cell(0, 'A')], { style: 'bar' }));
    expect(gl.drawArrays).toHaveBeenCalled();

    const lost = new Event('webglcontextlost', { cancelable: true });
    background.target.dispatchEvent(lost);
    expect(lost.defaultPrevented).toBe(true);
    const draws = gl.drawArrays.mock.calls.length;
    renderer.render(snapshot([cell(0, 'B')]));
    expect(gl.drawArrays).toHaveBeenCalledTimes(draws);

    background.target.dispatchEvent(new Event('webglcontextrestored'));
    expect(gl.viewport).toHaveBeenCalledWith(0, 0, metrics.width, metrics.height);
    expect(gl.drawArrays.mock.calls.length).toBeGreaterThan(draws);
    renderer.dispose();
    expect(gl.deleteBuffer).toHaveBeenCalled();
    expect(gl.deleteProgram).toHaveBeenCalled();
  });
});

function snapshot(
  cells: readonly RenderCell[],
  cursor: Partial<RenderCursor> = {}
): ViewportSnapshot {
  return {
    cols: 8,
    rows: 2,
    dirty: 'full',
    viewportRows: [
      {
        y: 0,
        text: cells.map((value) => value.text).join(''),
        cells,
        wrapped: false,
        wrapContinuation: false,
        selection: { start: 0, end: 1 },
      },
      { y: 1, text: '', cells: [], wrapped: false, wrapContinuation: false, selection: null },
    ],
    cursor: {
      x: 0,
      y: 0,
      visible: true,
      blinking: false,
      passwordInput: false,
      wideTail: false,
      style: 'block',
      ...cursor,
    },
    colors: {
      foreground: { r: 80, g: 80, b: 80 },
      background: { r: 20, g: 20, b: 20, a: 0.8 },
      cursor: { r: 255, g: 255, b: 255 },
      cursorAccent: { r: 0, g: 0, b: 0 },
      selectionBackground: { r: 50, g: 60, b: 70 },
      selectionInactiveBackground: { r: 30, g: 40, b: 50 },
      selectionForeground: { r: 250, g: 250, b: 250 },
      palette: [],
    },
  };
}

function cell(x: number, text: string, style: Partial<RenderCell['style']> = {}): RenderCell {
  return {
    x,
    text,
    width: 'narrow',
    foreground: null,
    background: x === 0 ? { r: 5, g: 6, b: 7 } : null,
    hyperlink: false,
    semanticContent: 'output',
    style: {
      bold: false,
      italic: false,
      faint: false,
      blink: false,
      inverse: false,
      invisible: false,
      strikethrough: false,
      overline: false,
      underline: 0,
      ...style,
    },
  };
}

function fake2dContext() {
  const calls = {
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn(() => ({ width: 10 }) as TextMetrics),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
  };
  return {
    ...calls,
    value: {
      ...calls,
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      globalAlpha: 1,
      font: '',
      textBaseline: 'alphabetic',
      textAlign: 'left',
      letterSpacing: '',
    } as unknown as CanvasRenderingContext2D,
  };
}

function fakeCanvas(contexts: Record<string, unknown>) {
  const target = new EventTarget();
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn((name: string) => contexts[name] ?? null),
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  } as unknown as HTMLCanvasElement;
  return { canvas, target };
}

function fakeWebGl() {
  const calls = {
    createShader: vi.fn(() => ({})),
    shaderSource: vi.fn(),
    compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => true),
    getShaderInfoLog: vi.fn(() => null),
    createProgram: vi.fn(() => ({})),
    attachShader: vi.fn(),
    bindAttribLocation: vi.fn(),
    linkProgram: vi.fn(),
    getProgramParameter: vi.fn(() => true),
    getProgramInfoLog: vi.fn(() => null),
    createBuffer: vi.fn(() => ({})),
    useProgram: vi.fn(),
    bindBuffer: vi.fn(),
    enableVertexAttribArray: vi.fn(),
    vertexAttribPointer: vi.fn(),
    enable: vi.fn(),
    blendFunc: vi.fn(),
    viewport: vi.fn(),
    clearColor: vi.fn(),
    clear: vi.fn(),
    bufferData: vi.fn(),
    drawArrays: vi.fn(),
    deleteBuffer: vi.fn(),
    deleteProgram: vi.fn(),
  };
  return {
    ...calls,
    value: {
      ...calls,
      VERTEX_SHADER: 1,
      FRAGMENT_SHADER: 2,
      COMPILE_STATUS: 3,
      LINK_STATUS: 4,
      ARRAY_BUFFER: 5,
      FLOAT: 6,
      BLEND: 7,
      SRC_ALPHA: 8,
      ONE_MINUS_SRC_ALPHA: 9,
      COLOR_BUFFER_BIT: 10,
      DYNAMIC_DRAW: 11,
      TRIANGLES: 12,
    } as unknown as WebGL2RenderingContext,
  };
}

function fakeWebGpuContext() {
  const configure = vi.fn();
  return {
    configure,
    value: {
      configure,
      getCurrentTexture: vi.fn(() => ({ createView: vi.fn(() => ({})) })),
    } as unknown as GPUCanvasContext,
  };
}

function fakeWebGpuDevice() {
  let resolveLost: (value: GPUDeviceLostInfo) => void = () => undefined;
  const lost = new Promise<GPUDeviceLostInfo>((resolve) => {
    resolveLost = resolve;
  });
  const bufferDestroy = vi.fn();
  const deviceDestroy = vi.fn();
  const draw = vi.fn();
  const writeBuffer = vi.fn();
  const submit = vi.fn();
  const pass = {
    setPipeline: vi.fn(),
    setVertexBuffer: vi.fn(),
    draw,
    end: vi.fn(),
  };
  const value = {
    lost,
    queue: { writeBuffer, submit },
    createShaderModule: vi.fn(() => ({})),
    createRenderPipeline: vi.fn(() => ({})),
    createBuffer: vi.fn(() => ({ destroy: bufferDestroy })),
    createCommandEncoder: vi.fn(() => ({
      beginRenderPass: vi.fn(() => pass),
      finish: vi.fn(() => ({})),
    })),
    destroy: deviceDestroy,
  } as unknown as GPUDevice;
  return {
    bufferDestroy,
    deviceDestroy,
    draw,
    lose: () =>
      resolveLost({ message: 'test loss', reason: 'unknown' } as unknown as GPUDeviceLostInfo),
    submit,
    value,
    writeBuffer,
  };
}
