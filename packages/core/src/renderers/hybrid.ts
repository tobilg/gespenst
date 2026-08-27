/// <reference types="@webgpu/types" />

import type {
  RenderCell,
  RenderColor,
  RenderFrame,
  RenderRow,
  ViewportSnapshot,
} from '../core/types.js';

/**
 * Renderer requested by an application, including automatic capability selection.
 *
 * @remarks
 * `'auto'` tries WebGPU, WebGL2, then Canvas 2D during initialization and runtime recovery. An
 * explicit `'webgpu'` request reports failure instead of silently falling back. An explicit
 * `'webgl2'` request falls back to Canvas 2D when WebGL2 is unavailable or cannot recover.
 */
export type RendererPreference = 'auto' | 'webgpu' | 'webgl2' | 'canvas2d';
/** Concrete renderer backend selected at runtime. */
export type RendererBackend = 'webgpu' | 'webgl2' | 'canvas2d';

/** Measured surface and font values used to lay out render cells. */
export interface RenderMetrics {
  /** Surface width in device pixels. */
  readonly width: number;
  /** Surface height in device pixels. */
  readonly height: number;
  /** Cell width in device pixels. */
  readonly cellWidth: number;
  /** Cell height in device pixels. */
  readonly cellHeight: number;
  /** Font size in CSS pixels. */
  readonly fontSize: number;
  /** CSS font-family stack. */
  readonly fontFamily: string;
  /** Normal font weight. */
  readonly fontWeight: string | number;
  /** Bold font weight. */
  readonly fontWeightBold: string | number;
  /** Additional letter spacing in CSS pixels. */
  readonly letterSpacing: number;
  /** Ratio between CSS and device pixels. */
  readonly devicePixelRatio: number;
}

/** Selected rendering implementation and shaping strategy. */
export interface RendererInfo {
  /** Active graphics backend. */
  readonly backend: RendererBackend;
  /** Text shaping implementation. */
  readonly textShaping: 'browser-canvas';
}

type RenderCanvas = HTMLCanvasElement | OffscreenCanvas;
type TextContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

interface BackgroundRenderer {
  readonly backend: RendererBackend;
  resize(width: number, height: number): void;
  render(
    frame: ViewportSnapshot,
    metrics: RenderMetrics,
    blinkVisible: boolean,
    focused: boolean
  ): void;
  onFailure(handler: (error: Error) => void): void;
  recover(): Promise<void>;
  dispose(): void;
}

type RendererChangeHandler = (info: RendererInfo, surfaceIndex: number) => void;

const WEBGL_RECOVERY_TIMEOUT_MS = 1_000;

function rendererOrder(preference: RendererPreference): readonly RendererBackend[] {
  if (preference === 'webgpu') return ['webgpu'];
  if (preference === 'webgl2') return ['webgl2', 'canvas2d'];
  if (preference === 'canvas2d') return ['canvas2d'];
  return ['webgpu', 'webgl2', 'canvas2d'];
}

/** Number of independent background surfaces required by a renderer preference. @internal */
export function rendererSurfaceCount(preference: RendererPreference = 'auto'): number {
  return rendererOrder(preference).length;
}

interface Rectangle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly color: RenderColor;
}

function context(canvas: RenderCanvas, name: string, options?: object): unknown {
  return (canvas as unknown as { getContext(name: string, options?: object): unknown }).getContext(
    name,
    options
  );
}

function opacity(color: RenderColor): number {
  return color.a ?? 1;
}

function css(color: RenderColor): string {
  const alphaValue = opacity(color);
  return alphaValue === 1
    ? `rgb(${color.r} ${color.g} ${color.b})`
    : `rgba(${color.r}, ${color.g}, ${color.b}, ${alphaValue})`;
}

function effectiveColors(cell: RenderCell, foreground: RenderColor, background: RenderColor) {
  const fg = cell.foreground ?? foreground;
  const bg = cell.background ?? background;
  return cell.style.inverse
    ? { foreground: bg, background: fg }
    : { foreground: fg, background: bg };
}

function rectangles(
  frame: ViewportSnapshot,
  metrics: RenderMetrics,
  blinkVisible: boolean,
  focused: boolean
): Rectangle[] {
  const output: Rectangle[] = [];
  for (const row of frame.viewportRows) {
    for (const cell of row.cells) {
      const selected = row.selection && cell.x >= row.selection.start && cell.x < row.selection.end;
      const colors = effectiveColors(cell, frame.colors.foreground, frame.colors.background);
      if (cell.background || cell.style.inverse || selected) {
        output.push({
          x: cell.x * metrics.cellWidth,
          y: row.y * metrics.cellHeight,
          width: metrics.cellWidth,
          height: metrics.cellHeight,
          color: selected
            ? focused
              ? (frame.colors.selectionBackground ?? frame.colors.foreground)
              : (frame.colors.selectionInactiveBackground ??
                frame.colors.selectionBackground ??
                frame.colors.foreground)
            : colors.background,
        });
      }
    }
  }
  if (
    frame.cursor.visible &&
    (!frame.cursor.blinking || blinkVisible) &&
    frame.cursor.x !== null &&
    frame.cursor.y !== null
  ) {
    const x = frame.cursor.x * metrics.cellWidth;
    const y = frame.cursor.y * metrics.cellHeight;
    const cursor = frame.colors.cursor ?? frame.colors.foreground;
    if (frame.cursor.style === 'bar') {
      output.push({
        x,
        y,
        width: Math.max(1, metrics.devicePixelRatio),
        height: metrics.cellHeight,
        color: cursor,
      });
    } else if (frame.cursor.style === 'underline') {
      output.push({
        x,
        y: y + metrics.cellHeight - Math.max(2, metrics.devicePixelRatio),
        width: metrics.cellWidth,
        height: Math.max(2, metrics.devicePixelRatio),
        color: cursor,
      });
    } else if (frame.cursor.style === 'block-hollow') {
      const line = Math.max(1, metrics.devicePixelRatio);
      output.push(
        { x, y, width: metrics.cellWidth, height: line, color: cursor },
        {
          x,
          y: y + metrics.cellHeight - line,
          width: metrics.cellWidth,
          height: line,
          color: cursor,
        },
        { x, y, width: line, height: metrics.cellHeight, color: cursor },
        {
          x: x + metrics.cellWidth - line,
          y,
          width: line,
          height: metrics.cellHeight,
          color: cursor,
        }
      );
    } else {
      output.push({ x, y, width: metrics.cellWidth, height: metrics.cellHeight, color: cursor });
    }
  }
  return output;
}

class WebGpuBackground implements BackgroundRenderer {
  readonly backend = 'webgpu' as const;
  private buffer: GPUBuffer | null = null;
  private capacity = 0;
  private readonly canvas: RenderCanvas;
  private device: GPUDevice;
  private readonly gpuContext: GPUCanvasContext;
  private pipeline: GPURenderPipeline;
  private readonly format: GPUTextureFormat;
  private readonly alphaMode: GPUCanvasAlphaMode;
  private failureHandler: ((error: Error) => void) | null = null;
  private lost = false;
  private disposed = false;

  private constructor(
    canvas: RenderCanvas,
    device: GPUDevice,
    gpuContext: GPUCanvasContext,
    pipeline: GPURenderPipeline,
    format: GPUTextureFormat,
    alphaMode: GPUCanvasAlphaMode
  ) {
    this.canvas = canvas;
    this.device = device;
    this.gpuContext = gpuContext;
    this.pipeline = pipeline;
    this.format = format;
    this.alphaMode = alphaMode;
    this.watchDevice(device);
  }

  static async create(canvas: RenderCanvas, allowTransparency: boolean): Promise<WebGpuBackground> {
    const gpu = globalThis.navigator.gpu;
    if (!gpu) throw new Error('WebGPU is unavailable');
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter is available');
    const device = await adapter.requestDevice();
    try {
      const gpuContext = context(canvas, 'webgpu') as GPUCanvasContext | null;
      if (!gpuContext) throw new Error('The canvas has no WebGPU context');
      const format = gpu.getPreferredCanvasFormat();
      const alphaMode: GPUCanvasAlphaMode = allowTransparency ? 'premultiplied' : 'opaque';
      gpuContext.configure({ device, format, alphaMode });
      const pipeline = createWebGpuPipeline(device, format);
      return new WebGpuBackground(canvas, device, gpuContext, pipeline, format, alphaMode);
    } catch (error) {
      device.destroy();
      throw error;
    }
  }

  resize(width: number, height: number): void {
    this.canvas.width = width;
    this.canvas.height = height;
    if (!this.lost)
      this.gpuContext.configure({
        device: this.device,
        format: this.format,
        alphaMode: this.alphaMode,
      });
  }

  render(
    frame: ViewportSnapshot,
    metrics: RenderMetrics,
    blinkVisible: boolean,
    focused: boolean
  ): void {
    if (this.lost) return;
    const data = vertexData(
      rectangles(frame, metrics, blinkVisible, focused),
      metrics.width,
      metrics.height
    );
    try {
      if (data.byteLength > this.capacity) {
        this.buffer?.destroy();
        this.capacity = Math.max(256, 2 ** Math.ceil(Math.log2(data.byteLength)));
        this.buffer = this.device.createBuffer({ size: this.capacity, usage: 0x20 | 0x08 });
      }
      if (data.byteLength > 0 && this.buffer) this.device.queue.writeBuffer(this.buffer, 0, data);
      const encoder = this.device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: this.gpuContext.getCurrentTexture().createView(),
            clearValue: premultipliedClearValue(frame.colors.background),
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
      pass.setPipeline(this.pipeline);
      if (data.length > 0 && this.buffer) {
        pass.setVertexBuffer(0, this.buffer);
        pass.draw(data.length / 6);
      }
      pass.end();
      this.device.queue.submit([encoder.finish()]);
    } catch (error) {
      this.lost = true;
      this.failureHandler?.(asError(error, 'WebGPU rendering failed'));
    }
  }

  onFailure(handler: (error: Error) => void): void {
    this.failureHandler = handler;
  }

  dispose(): void {
    this.disposed = true;
    this.failureHandler = null;
    this.buffer?.destroy();
    this.device.destroy();
    this.canvas.width = 1;
    this.canvas.height = 1;
  }

  private watchDevice(device: GPUDevice): void {
    void device.lost.then(() => {
      // A synchronous render failure can precede the device-lost promise. Treat both signals as
      // one failure so the same device is restored only once.
      if (this.disposed || this.device !== device || this.lost) return;
      this.lost = true;
      this.failureHandler?.(new Error('The WebGPU device was lost'));
    });
  }

  async recover(): Promise<void> {
    const gpu = globalThis.navigator.gpu;
    if (!gpu || this.disposed) throw new Error('WebGPU recovery is unavailable');
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter || this.disposed) throw new Error('No WebGPU adapter is available for recovery');
    const device = await adapter.requestDevice();
    if (this.disposed) {
      device.destroy();
      throw new Error('WebGPU renderer was disposed during recovery');
    }
    try {
      const pipeline = createWebGpuPipeline(device, this.format);
      this.gpuContext.configure({ device, format: this.format, alphaMode: this.alphaMode });
      this.buffer?.destroy();
      this.device.destroy();
      this.buffer = null;
      this.capacity = 0;
      this.device = device;
      this.pipeline = pipeline;
      this.lost = false;
      this.watchDevice(device);
    } catch (error) {
      device.destroy();
      throw error;
    }
  }
}

/** Clear colour for a premultiplied canvas: channels already scaled by alpha. */
function premultipliedClearValue(color: Parameters<typeof opacity>[0]): GPUColorDict {
  const alpha = opacity(color);
  return {
    r: (color.r / 255) * alpha,
    g: (color.g / 255) * alpha,
    b: (color.b / 255) * alpha,
    a: alpha,
  };
}

function createWebGpuPipeline(device: GPUDevice, format: GPUTextureFormat): GPURenderPipeline {
  const shader = device.createShaderModule({
    code: `
      struct VertexOut {
        @builtin(position) position: vec4f,
        @location(0) color: vec4f,
      }
      @vertex fn vertex_main(
        @location(0) position: vec2f,
        @location(1) color: vec4f
      ) -> VertexOut {
        var output: VertexOut;
        output.position = vec4f(position, 0.0, 1.0);
        output.color = color;
        return output;
      }
      @fragment fn fragment_main(input: VertexOut) -> @location(0) vec4f {
        // The canvas is configured as premultiplied, so scale the channels by alpha here rather
        // than emitting straight alpha the compositor would read as an out-of-gamut colour.
        return vec4f(input.color.rgb * input.color.a, input.color.a);
      }
    `,
  });
  return device.createRenderPipeline({
    layout: 'auto',
    vertex: {
      module: shader,
      entryPoint: 'vertex_main',
      buffers: [
        {
          arrayStride: 24,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x2' },
            { shaderLocation: 1, offset: 8, format: 'float32x4' },
          ],
        },
      ],
    },
    fragment: {
      module: shader,
      entryPoint: 'fragment_main',
      targets: [
        {
          format,
          blend: {
            color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        },
      ],
    },
    primitive: { topology: 'triangle-list' },
  });
}

class WebGlBackground implements BackgroundRenderer {
  readonly backend = 'webgl2' as const;
  private program: WebGLProgram | null = null;
  private buffer: WebGLBuffer | null = null;
  private readonly canvas: RenderCanvas;
  private readonly gl: WebGL2RenderingContext;
  private failureHandler: ((error: Error) => void) | null = null;
  private recovery:
    | {
        readonly resolve: () => void;
        readonly reject: (error: Error) => void;
        readonly timeout: ReturnType<typeof setTimeout>;
        readonly promise: Promise<void>;
      }
    | undefined;
  private lost = false;
  private disposed = false;
  private readonly contextLost = (event: Event) => {
    event.preventDefault();
    if (this.disposed || this.lost) return;
    this.lost = true;
    this.failureHandler?.(new Error('The WebGL2 context was lost'));
  };
  private readonly contextRestored = () => {
    if (this.disposed) return;
    try {
      if (this.buffer) this.gl.deleteBuffer(this.buffer);
      if (this.program) this.gl.deleteProgram(this.program);
      this.buffer = null;
      this.program = null;
      this.initialize();
      this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      this.lost = false;
      this.settleRecovery();
    } catch (error) {
      this.settleRecovery(asError(error, 'WebGL2 restoration failed'));
    }
  };

  constructor(canvas: RenderCanvas, gl: WebGL2RenderingContext) {
    this.canvas = canvas;
    this.gl = gl;
    this.initialize();
    canvas.addEventListener('webglcontextlost', this.contextLost);
    canvas.addEventListener('webglcontextrestored', this.contextRestored);
  }

  private initialize(): void {
    const gl = this.gl;
    const vertex = compileShader(
      gl,
      gl.VERTEX_SHADER,
      `#version 300 es
      in vec2 position;
      in vec4 color;
      out vec4 vertexColor;
      void main() { gl_Position = vec4(position, 0.0, 1.0); vertexColor = color; }
    `
    );
    const fragment = compileShader(
      gl,
      gl.FRAGMENT_SHADER,
      `#version 300 es
      precision mediump float;
      in vec4 vertexColor;
      out vec4 outputColor;
      void main() { outputColor = vertexColor; }
    `
    );
    const program = gl.createProgram();
    if (!program) throw new Error('Unable to create a WebGL2 program');
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.bindAttribLocation(program, 0, 'position');
    gl.bindAttribLocation(program, 1, 'color');
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) ?? 'Unable to link WebGL2 shaders');
    }
    const buffer = gl.createBuffer();
    if (!buffer) throw new Error('Unable to create a WebGL2 buffer');
    this.program = program;
    this.buffer = buffer;
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 24, 8);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  resize(width: number, height: number): void {
    this.canvas.width = width;
    this.canvas.height = height;
    this.gl.viewport(0, 0, width, height);
  }

  render(
    frame: ViewportSnapshot,
    metrics: RenderMetrics,
    blinkVisible: boolean,
    focused: boolean
  ): void {
    const gl = this.gl;
    const program = this.program;
    const buffer = this.buffer;
    if (this.lost || !program || !buffer) return;
    const data = vertexData(
      rectangles(frame, metrics, blinkVisible, focused),
      metrics.width,
      metrics.height
    );
    try {
      gl.clearColor(
        frame.colors.background.r / 255,
        frame.colors.background.g / 255,
        frame.colors.background.b / 255,
        opacity(frame.colors.background)
      );
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.TRIANGLES, 0, data.length / 6);
    } catch (error) {
      this.lost = true;
      this.failureHandler?.(asError(error, 'WebGL2 rendering failed'));
    }
  }

  onFailure(handler: (error: Error) => void): void {
    this.failureHandler = handler;
  }

  recover(): Promise<void> {
    if (!this.lost) return Promise.resolve();
    if (this.disposed) return Promise.reject(new Error('WebGL2 renderer is disposed'));
    if (this.recovery) return this.recovery.promise;
    let resolveRecovery!: () => void;
    let rejectRecovery!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolveRecovery = resolve;
      rejectRecovery = reject;
    });
    const timeout = setTimeout(
      () => this.settleRecovery(new Error('WebGL2 context restoration timed out')),
      WEBGL_RECOVERY_TIMEOUT_MS
    );
    this.recovery = {
      resolve: resolveRecovery,
      reject: rejectRecovery,
      timeout,
      promise,
    };
    return promise;
  }

  dispose(): void {
    this.disposed = true;
    this.failureHandler = null;
    this.settleRecovery(new Error('WebGL2 renderer was disposed during recovery'));
    this.canvas.removeEventListener('webglcontextlost', this.contextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.contextRestored);
    if (this.buffer) this.gl.deleteBuffer(this.buffer);
    if (this.program) this.gl.deleteProgram(this.program);
    this.buffer = null;
    this.program = null;
    this.canvas.width = 1;
    this.canvas.height = 1;
  }

  private settleRecovery(error?: Error): void {
    const recovery = this.recovery;
    if (!recovery) return;
    this.recovery = undefined;
    clearTimeout(recovery.timeout);
    if (error) recovery.reject(error);
    else recovery.resolve();
  }
}

class CanvasBackground implements BackgroundRenderer {
  readonly backend = 'canvas2d' as const;
  private readonly canvas: RenderCanvas;
  private readonly context: TextContext;

  constructor(canvas: RenderCanvas, allowTransparency: boolean) {
    this.canvas = canvas;
    const value = context(canvas, '2d', { alpha: allowTransparency });
    if (!value) throw new Error('The canvas has no 2D background context');
    this.context = value as TextContext;
  }

  resize(width: number, height: number): void {
    this.canvas.width = width;
    this.canvas.height = height;
  }

  render(
    frame: ViewportSnapshot,
    metrics: RenderMetrics,
    blinkVisible: boolean,
    focused: boolean
  ): void {
    this.context.clearRect(0, 0, metrics.width, metrics.height);
    this.context.fillStyle = css(frame.colors.background);
    this.context.fillRect(0, 0, metrics.width, metrics.height);
    for (const rectangle of rectangles(frame, metrics, blinkVisible, focused)) {
      this.context.fillStyle = css(rectangle.color);
      this.context.fillRect(rectangle.x, rectangle.y, rectangle.width, rectangle.height);
    }
  }

  onFailure(_handler: (error: Error) => void): void {}

  recover(): Promise<void> {
    return Promise.reject(new Error('Canvas 2D has no fallback renderer'));
  }

  dispose(): void {
    this.canvas.width = 1;
    this.canvas.height = 1;
  }
}

async function createBackground(
  canvas: RenderCanvas,
  backend: RendererBackend,
  allowTransparency: boolean
): Promise<BackgroundRenderer> {
  if (backend === 'webgpu') return WebGpuBackground.create(canvas, allowTransparency);
  if (backend === 'canvas2d') return new CanvasBackground(canvas, allowTransparency);
  const gl = context(canvas, 'webgl2', {
    alpha: allowTransparency,
    // The renderer blends and clears with straight alpha, so the canvas must not be told its
    // colors are premultiplied. Left at its default of true, a translucent background is
    // composited as though its channels were already scaled by alpha and renders opaque.
    premultipliedAlpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    desynchronized: true,
    preserveDrawingBuffer: false,
  }) as WebGL2RenderingContext | null;
  if (!gl) throw new Error('The canvas has no WebGL2 context');
  return new WebGlBackground(canvas, gl);
}

function asError(reason: unknown, fallback: string): Error {
  return reason instanceof Error ? reason : new Error(String(reason) || fallback);
}

export class HybridRenderer {
  private readonly text: TextContext;
  private readonly textCanvas: RenderCanvas;
  private background: BackgroundRenderer;
  private readonly surfaces: readonly RenderCanvas[];
  private readonly order: readonly RendererBackend[];
  private readonly allowTransparency: boolean;
  private orderIndex: number;
  private surfaceIndexValue: number;
  private metrics: RenderMetrics;
  private lastFrame: ViewportSnapshot | null = null;
  private readonly rowCache = new Map<number, RenderRow>();
  private lastCursorRow: number | null = null;
  private blinkVisible = true;
  private focused = false;
  private minimumContrastRatio: number;
  private readonly contrastCache = new Map<string, RenderColor>();
  private readonly blinkTimer: ReturnType<typeof setInterval>;
  private rendererChangeHandler: RendererChangeHandler | null = null;
  private rendererErrorHandler: ((error: Error) => void) | null = null;
  private recoveryPromise: Promise<void> | null = null;
  private queuedFailure: Error | null = null;
  private fatalError: Error | null = null;
  private disposed = false;

  private constructor(
    textCanvas: RenderCanvas,
    background: BackgroundRenderer,
    surfaces: readonly RenderCanvas[],
    order: readonly RendererBackend[],
    orderIndex: number,
    surfaceIndex: number,
    metrics: RenderMetrics,
    minimumContrastRatio: number,
    allowTransparency: boolean
  ) {
    this.textCanvas = textCanvas;
    this.background = background;
    this.surfaces = surfaces;
    this.order = order;
    this.orderIndex = orderIndex;
    this.surfaceIndexValue = surfaceIndex;
    this.metrics = metrics;
    this.allowTransparency = allowTransparency;
    this.minimumContrastRatio = Math.max(1, Math.min(21, minimumContrastRatio));
    const text = context(textCanvas, '2d', { alpha: true });
    if (!text) throw new Error('The canvas has no 2D text context');
    this.text = text as TextContext;
    this.bindBackground(background);
    this.resize(metrics);
    this.blinkTimer = setInterval(() => {
      const frame = this.lastFrame;
      if (!frame || !hasBlinkingContent(frame)) return;
      this.blinkVisible = !this.blinkVisible;
      const rows = new Set<number>();
      if (frame.cursor.y !== null) rows.add(frame.cursor.y);
      for (const row of frame.viewportRows) {
        if (row.cells.some((cell) => cell.style.blink)) rows.add(row.y);
      }
      this.paint(frame, rows);
    }, 500);
  }

  static async create(
    backgroundCanvases: RenderCanvas | readonly RenderCanvas[],
    textCanvas: RenderCanvas,
    metrics: RenderMetrics,
    preference: RendererPreference = 'auto',
    allowTransparency = false,
    minimumContrastRatio = 1
  ): Promise<HybridRenderer> {
    const surfaces = Array.isArray(backgroundCanvases)
      ? backgroundCanvases
      : [backgroundCanvases as RenderCanvas];
    const order = rendererOrder(preference);
    let lastError: Error | null = null;
    for (let index = 0; index < order.length; index += 1) {
      const backend = order[index];
      if (!backend) continue;
      const surface = surfaces[index] ?? surfaces[surfaces.length - 1];
      if (!surface) throw new Error('At least one renderer background surface is required');
      let background: BackgroundRenderer | null = null;
      try {
        background = await createBackground(surface, backend, allowTransparency);
        return new HybridRenderer(
          textCanvas,
          background,
          surfaces,
          order,
          index,
          Math.min(index, surfaces.length - 1),
          metrics,
          minimumContrastRatio,
          allowTransparency
        );
      } catch (error) {
        background?.dispose();
        lastError = asError(error, `Unable to initialize ${backend}`);
      }
    }
    throw lastError ?? new Error('No renderer backend could be initialized');
  }

  /** Active renderer and browser text-shaping implementation. */
  get info(): RendererInfo {
    return { backend: this.background.backend, textShaping: 'browser-canvas' };
  }

  /** Index of the background surface presenting the active renderer. @internal */
  get surfaceIndex(): number {
    return this.surfaceIndexValue;
  }

  /** Observes successful restoration and fallback transitions. @internal */
  onRendererChange(handler: RendererChangeHandler): void {
    this.rendererChangeHandler = handler;
  }

  /** Observes a renderer that could neither recover nor fall back. @internal */
  onRendererError(handler: (error: Error) => void): void {
    this.rendererErrorHandler = handler;
  }

  resize(metrics: RenderMetrics): void {
    this.metrics = metrics;
    this.background.resize(metrics.width, metrics.height);
    this.textCanvas.width = metrics.width;
    this.textCanvas.height = metrics.height;
    this.rowCache.clear();
    this.lastCursorRow = null;
  }

  render(frame: ViewportSnapshot | RenderFrame): void | Promise<void> {
    if (this.fatalError) throw this.fatalError;
    if (this.disposed) throw new Error('Renderer is disposed');
    const changed = 'viewportRows' in frame ? frame.viewportRows : frame.changedRows;
    for (const row of changed) this.rowCache.set(row.y, row);
    for (const y of [...this.rowCache.keys()]) {
      if (y >= frame.rows) this.rowCache.delete(y);
    }
    const snapshot: ViewportSnapshot =
      'viewportRows' in frame
        ? frame
        : {
            ...frame,
            viewportRows: Array.from(
              { length: frame.rows },
              (_, y) => this.rowCache.get(y) ?? blankRow(y, frame.cols)
            ),
          };
    this.lastFrame = snapshot;
    this.blinkVisible = true;
    const damage = new Set<number>();
    if ('viewportRows' in frame || frame.dirty === 'full') {
      for (let y = 0; y < frame.rows; y += 1) damage.add(y);
    } else {
      for (const row of changed) damage.add(row.y);
    }
    if (this.lastCursorRow !== null) damage.add(this.lastCursorRow);
    if (frame.cursor.y !== null) damage.add(frame.cursor.y);
    this.lastCursorRow = frame.cursor.y;
    this.paint(snapshot, damage);
    return this.recoveryPromise ?? undefined;
  }

  /** Updates whether active or inactive selection colors should be used. */
  setFocused(focused: boolean): void {
    if (this.focused === focused) return;
    this.focused = focused;
    const frame = this.lastFrame;
    if (frame) this.paint(frame, new Set(frame.viewportRows.map((row) => row.y)));
  }

  /** Updates contrast correction and repaints the current viewport. */
  setMinimumContrastRatio(ratio: number): void {
    const next = Math.max(1, Math.min(21, Math.round(ratio * 10) / 10));
    if (next === this.minimumContrastRatio) return;
    this.minimumContrastRatio = next;
    this.contrastCache.clear();
    const frame = this.lastFrame;
    if (frame) this.paint(frame, new Set(frame.viewportRows.map((row) => row.y)));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.blinkTimer);
    this.lastFrame = null;
    this.rowCache.clear();
    this.rendererChangeHandler = null;
    this.rendererErrorHandler = null;
    this.queuedFailure = null;
    this.background.dispose();
  }

  private bindBackground(background: BackgroundRenderer): void {
    background.onFailure((error) => this.startRecovery(error));
  }

  private startRecovery(cause: Error): void {
    if (this.disposed || this.fatalError) return;
    if (this.recoveryPromise) {
      this.queuedFailure = cause;
      return;
    }
    const recovery = this.recoverUntilStable(cause).catch((error: unknown) => {
      if (this.disposed) return;
      const failure = asError(error, `Renderer recovery failed after: ${cause.message}`);
      this.fatalError = failure;
      this.rendererErrorHandler?.(failure);
      throw failure;
    });
    this.recoveryPromise = recovery;
    void recovery.catch(() => undefined);
    void recovery
      .finally(() => {
        if (this.recoveryPromise === recovery) this.recoveryPromise = null;
      })
      .catch(() => undefined);
  }

  private async recoverUntilStable(initialCause: Error): Promise<void> {
    let cause: Error | null = initialCause;
    while (cause && !this.disposed) {
      this.queuedFailure = null;
      await this.recover(cause);
      cause = this.queuedFailure;
    }
  }

  private async recover(cause: Error): Promise<void> {
    try {
      await this.background.recover();
      if (this.disposed) return;
      this.repaintAll();
      if (!this.queuedFailure) this.rendererChangeHandler?.(this.info, this.surfaceIndexValue);
      return;
    } catch (recoveryError) {
      if (this.disposed) return;
      let lastError = asError(recoveryError, cause.message);
      this.background.dispose();
      for (let index = this.orderIndex + 1; index < this.order.length; index += 1) {
        const backend = this.order[index];
        if (!backend) continue;
        const surfaceIndex = Math.min(index, this.surfaces.length - 1);
        const surface = this.surfaces[surfaceIndex];
        if (!surface) continue;
        let background: BackgroundRenderer | null = null;
        try {
          background = await createBackground(surface, backend, this.allowTransparency);
          if (this.disposed) {
            background.dispose();
            return;
          }
          background.resize(this.metrics.width, this.metrics.height);
          this.background = background;
          this.orderIndex = index;
          this.surfaceIndexValue = surfaceIndex;
          this.bindBackground(background);
          this.repaintAll();
          if (!this.queuedFailure) this.rendererChangeHandler?.(this.info, surfaceIndex);
          return;
        } catch (error) {
          background?.dispose();
          lastError = asError(error, `Unable to fall back to ${backend}`);
        }
      }
      throw new Error(
        `The ${this.order[this.orderIndex]} renderer could not recover: ${lastError.message}`,
        { cause: lastError }
      );
    }
  }

  private repaintAll(): void {
    const frame = this.lastFrame;
    if (!frame) return;
    this.paint(frame, new Set(frame.viewportRows.map((row) => row.y)));
  }

  private paint(frame: ViewportSnapshot, damage: ReadonlySet<number>): void {
    this.background.render(frame, this.metrics, this.blinkVisible, this.focused);
    const ctx = this.text;
    const metrics = this.metrics;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    for (const row of frame.viewportRows) {
      if (!damage.has(row.y)) continue;
      ctx.clearRect(0, row.y * metrics.cellHeight, metrics.width, metrics.cellHeight);
      for (let index = 0; index < row.cells.length; ) {
        const cell = row.cells[index];
        if (!cell) break;
        if (
          !cell.text ||
          cell.style.invisible ||
          (cell.style.blink && !this.blinkVisible) ||
          cell.width === 'spacer-tail' ||
          cell.width === 'spacer-head'
        ) {
          index += 1;
          continue;
        }
        const selected =
          row.selection && cell.x >= row.selection.start && cell.x < row.selection.end;
        const colors = effectiveColors(cell, frame.colors.foreground, frame.colors.background);
        const cursorCell =
          frame.cursor.visible &&
          (!frame.cursor.blinking || this.blinkVisible) &&
          frame.cursor.style === 'block' &&
          frame.cursor.x === cell.x &&
          frame.cursor.y === row.y;
        const rawForeground = cursorCell
          ? (frame.colors.cursorAccent ?? frame.colors.background)
          : selected
            ? (frame.colors.selectionForeground ?? colors.foreground)
            : colors.foreground;
        const foreground = this.contrast(
          rawForeground,
          selected
            ? this.focused
              ? (frame.colors.selectionBackground ?? frame.colors.foreground)
              : (frame.colors.selectionInactiveBackground ??
                frame.colors.selectionBackground ??
                frame.colors.foreground)
            : colors.background
        );
        const fontStyle = `${cell.style.italic ? 'italic ' : ''}${cell.style.bold ? metrics.fontWeightBold : metrics.fontWeight} `;
        if (drawPowerlineGlyph(ctx, cell.text, cell.x, row.y, foreground, metrics)) {
          index += 1;
          continue;
        }
        const runKey = `${css(foreground)}|${fontStyle}|${cell.style.faint}|${cell.style.blink}|${cell.style.underline}|${cell.style.strikethrough}|${cell.style.overline}`;
        let runText = cell.text;
        let nextIndex = index + 1;
        let endX = cell.x + (cell.width === 'wide' ? 2 : 1);
        if (cell.width === 'narrow') {
          while (nextIndex < row.cells.length) {
            const next = row.cells[nextIndex];
            if (!next || !next.text || next.width !== 'narrow' || next.style.invisible) break;
            const nextSelected =
              row.selection && next.x >= row.selection.start && next.x < row.selection.end;
            const nextColors = effectiveColors(
              next,
              frame.colors.foreground,
              frame.colors.background
            );
            const nextCursorCell =
              frame.cursor.visible &&
              (!frame.cursor.blinking || this.blinkVisible) &&
              frame.cursor.style === 'block' &&
              frame.cursor.x === next.x &&
              frame.cursor.y === row.y;
            const nextRawForeground = nextCursorCell
              ? (frame.colors.cursorAccent ?? frame.colors.background)
              : nextSelected
                ? (frame.colors.selectionForeground ?? nextColors.foreground)
                : nextColors.foreground;
            const nextForeground = this.contrast(
              nextRawForeground,
              nextSelected
                ? this.focused
                  ? (frame.colors.selectionBackground ?? frame.colors.foreground)
                  : (frame.colors.selectionInactiveBackground ??
                    frame.colors.selectionBackground ??
                    frame.colors.foreground)
                : nextColors.background
            );
            const nextFont = `${next.style.italic ? 'italic ' : ''}${next.style.bold ? metrics.fontWeightBold : metrics.fontWeight} `;
            const nextKey = `${css(nextForeground)}|${nextFont}|${next.style.faint}|${next.style.blink}|${next.style.underline}|${next.style.strikethrough}|${next.style.overline}`;
            if (next.x !== endX || nextKey !== runKey) break;
            runText += next.text;
            endX += 1;
            nextIndex += 1;
          }
        }
        ctx.fillStyle = css(foreground);
        ctx.globalAlpha = cell.style.faint ? 0.66 : 1;
        ctx.font = `${fontStyle}${metrics.fontSize}px ${metrics.fontFamily}`;
        if ('letterSpacing' in ctx) {
          (ctx as TextContext & { letterSpacing: string }).letterSpacing =
            `${metrics.letterSpacing}px`;
        }
        const x = cell.x * metrics.cellWidth;
        const baseline =
          row.y * metrics.cellHeight + (metrics.cellHeight + metrics.fontSize * 0.72) / 2;
        const runWidth = (endX - cell.x) * metrics.cellWidth;
        fillTextRun(ctx, runText, x, baseline, runWidth);
        if (cell.style.underline > 0 || cell.style.strikethrough || cell.style.overline) {
          ctx.fillRect(
            x,
            row.y * metrics.cellHeight + decorationY(cell, metrics),
            runWidth,
            Math.max(1, metrics.devicePixelRatio)
          );
        }
        index = nextIndex;
      }
    }
    ctx.globalAlpha = 1;
  }

  private contrast(foreground: RenderColor, background: RenderColor): RenderColor {
    if (this.minimumContrastRatio <= 1) return foreground;
    const key = `${foreground.r}:${foreground.g}:${foreground.b}:${foreground.a ?? 1}|${background.r}:${background.g}:${background.b}|${this.minimumContrastRatio}`;
    const cached = this.contrastCache.get(key);
    if (cached) return cached;
    const adjusted = contrastingColor(foreground, background, this.minimumContrastRatio);
    if (this.contrastCache.size >= 4096) this.contrastCache.clear();
    this.contrastCache.set(key, adjusted);
    return adjusted;
  }
}

function fillTextRun(
  context: TextContext,
  text: string,
  x: number,
  baseline: number,
  width: number
): void {
  const measuredWidth = context.measureText(text).width;
  if (measuredWidth <= 0 || Math.abs(measuredWidth - width) < 0.01) {
    context.fillText(text, x, baseline);
    return;
  }
  context.save();
  context.translate(x, 0);
  context.scale(width / measuredWidth, 1);
  context.fillText(text, 0, baseline);
  context.restore();
}

function blankRow(y: number, cols: number): RenderRow {
  return {
    y,
    text: ' '.repeat(cols),
    cells: [],
    wrapped: false,
    wrapContinuation: false,
    selection: null,
  };
}

function drawPowerlineGlyph(
  context: TextContext,
  glyph: string,
  cellX: number,
  cellY: number,
  color: RenderColor,
  metrics: RenderMetrics
): boolean {
  if (!['\ue0b0', '\ue0b1', '\ue0b2', '\ue0b3'].includes(glyph)) return false;
  const x = cellX * metrics.cellWidth;
  const y = cellY * metrics.cellHeight;
  const right = glyph === '\ue0b0' || glyph === '\ue0b1';
  const solid = glyph === '\ue0b0' || glyph === '\ue0b2';
  context.save();
  context.fillStyle = css(color);
  context.strokeStyle = css(color);
  context.lineWidth = Math.max(1, metrics.devicePixelRatio);
  context.beginPath();
  if (right) {
    context.moveTo(x, y);
    context.lineTo(x + metrics.cellWidth, y + metrics.cellHeight / 2);
    context.lineTo(x, y + metrics.cellHeight);
  } else {
    context.moveTo(x + metrics.cellWidth, y);
    context.lineTo(x, y + metrics.cellHeight / 2);
    context.lineTo(x + metrics.cellWidth, y + metrics.cellHeight);
  }
  if (solid) {
    context.closePath();
    context.fill();
  } else {
    context.stroke();
  }
  context.restore();
  return true;
}

function hasBlinkingContent(frame: ViewportSnapshot): boolean {
  return (
    frame.cursor.blinking ||
    frame.viewportRows.some((row) => row.cells.some((cell) => cell.style.blink))
  );
}

function luminance(color: RenderColor): number {
  const channel = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return channel(color.r) * 0.2126 + channel(color.g) * 0.7152 + channel(color.b) * 0.0722;
}

function contrastRatio(left: RenderColor, right: RenderColor): number {
  const a = luminance(left);
  const b = luminance(right);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function contrastingColor(
  foreground: RenderColor,
  background: RenderColor,
  minimum: number
): RenderColor {
  if (contrastRatio(foreground, background) >= minimum) return foreground;
  const alphaValue = foreground.a === undefined ? {} : { a: foreground.a };
  const black: RenderColor = { r: 0, g: 0, b: 0, ...alphaValue };
  const white: RenderColor = { r: 255, g: 255, b: 255, ...alphaValue };
  const target =
    contrastRatio(black, background) > contrastRatio(white, background) ? black : white;
  let low = 0;
  let high = 1;
  let result = target;
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const amount = (low + high) / 2;
    const candidate: RenderColor = {
      r: Math.round(foreground.r + (target.r - foreground.r) * amount),
      g: Math.round(foreground.g + (target.g - foreground.g) * amount),
      b: Math.round(foreground.b + (target.b - foreground.b) * amount),
      ...alphaValue,
    };
    if (contrastRatio(candidate, background) >= minimum) {
      result = candidate;
      high = amount;
    } else low = amount;
  }
  return result;
}

function decorationY(cell: RenderCell, metrics: RenderMetrics): number {
  if (cell.style.overline) return 1;
  if (cell.style.strikethrough) return metrics.cellHeight * 0.52;
  return metrics.cellHeight - Math.max(2, metrics.devicePixelRatio * 2);
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Unable to create a WebGL2 shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) ?? 'Unable to compile a WebGL2 shader');
  }
  return shader;
}

function vertexData(items: readonly Rectangle[], width: number, height: number): Float32Array {
  const output = new Float32Array(items.length * 6 * 6);
  let offset = 0;
  const vertex = (x: number, y: number, color: RenderColor) => {
    output[offset++] = (x / width) * 2 - 1;
    output[offset++] = 1 - (y / height) * 2;
    output[offset++] = color.r / 255;
    output[offset++] = color.g / 255;
    output[offset++] = color.b / 255;
    output[offset++] = opacity(color);
  };
  for (const item of items) {
    const x0 = item.x;
    const y0 = item.y;
    const x1 = item.x + item.width;
    const y1 = item.y + item.height;
    vertex(x0, y0, item.color);
    vertex(x1, y0, item.color);
    vertex(x0, y1, item.color);
    vertex(x0, y1, item.color);
    vertex(x1, y0, item.color);
    vertex(x1, y1, item.color);
  }
  return output;
}
