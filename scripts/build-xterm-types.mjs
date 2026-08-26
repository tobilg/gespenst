import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'node_modules/@xterm/xterm/typings/xterm.d.ts');
const output = resolve(root, 'packages/xterm/dist/index.d.ts');
let declarations = await readFile(source, 'utf8');
const opening = "declare module '@xterm/xterm' {";
const start = declarations.indexOf(opening);
if (start === -1) throw new Error('Unable to locate the xterm.js declaration wrapper');
declarations = declarations.slice(start + opening.length).trim();
if (!declarations.endsWith('}')) throw new Error('Unexpected xterm.js declaration format');
declarations = declarations.slice(0, -1);
declarations = declarations.replace(
  'export class Terminal implements IDisposable {',
  "export class Terminal implements IDisposable {\n    readonly ready: Promise<void>;\n    readonly native: Promise<import('@gespenst/core').GespenstTerminal>;"
);
declarations = declarations
  .replace(
    'onKey: IEvent<{ key: string, domEvent: KeyboardEvent }>;',
    'onKey: IEvent<XtermKeyEvent>;'
  )
  .replace(
    'onRender: IEvent<{ start: number, end: number }>;',
    'onRender: IEvent<XtermRenderEvent>;'
  )
  .replace(
    'onResize: IEvent<{ cols: number, rows: number }>;',
    'onResize: IEvent<XtermResizeEvent>;'
  );
declarations =
  '/** xterm.js 6.0 public API declarations, MIT licensed. */\n' +
  "export const XTERM_COMPAT_VERSION: '6.0.0';\n" +
  '/** Error thrown when an xterm.js extension point cannot be implemented over Ghostty. */\n' +
  'export class XtermCompatibilityError extends Error { readonly feature: string; }\n' +
  '/** Keyboard payload emitted by `Terminal.onKey`. */\n' +
  'export interface XtermKeyEvent { readonly key: string; readonly domEvent: KeyboardEvent; }\n' +
  '/** Inclusive viewport row range emitted by `Terminal.onRender`. */\n' +
  'export interface XtermRenderEvent { readonly start: number; readonly end: number; }\n' +
  '/** Character geometry emitted by `Terminal.onResize`. */\n' +
  'export interface XtermResizeEvent { readonly cols: number; readonly rows: number; }\n' +
  declarations;
await mkdir(dirname(output), { recursive: true });
await writeFile(output, declarations);
