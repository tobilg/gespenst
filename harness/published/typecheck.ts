import { BashKitAddon, createBashKitShell } from '@gespenst/bashkit';
import { ClipboardAddon } from '@gespenst/clipboard';
import { createTerminal, type TerminalOptions } from '@gespenst/core';
import { createCoreRuntime } from '@gespenst/core/headless';
import { GespenstTerminal as ReactTerminal } from '@gespenst/react';
import { SearchAddon } from '@gespenst/search';
import { SerializeAddon } from '@gespenst/serialize';
import { BrowserShellAddon } from '@gespenst/shell';
import { gespenstTerminal } from '@gespenst/svelte';
import { themes } from '@gespenst/themes';
import { catppuccinMocha } from '@gespenst/themes/catppuccin-mocha';
import { GespenstTerminal as VueTerminal } from '@gespenst/vue';
import { WebFontsAddon } from '@gespenst/web-fonts';
import { WebLinksAddon } from '@gespenst/web-links';
import { WebSocketAddon } from '@gespenst/websocket';
import { Terminal as CompatibleTerminal } from '@gespenst/xterm';

const options = { renderer: 'auto', theme: catppuccinMocha } satisfies Omit<
  TerminalOptions,
  'container'
>;

void [
  BashKitAddon,
  ClipboardAddon,
  ReactTerminal,
  SearchAddon,
  SerializeAddon,
  BrowserShellAddon,
  gespenstTerminal,
  themes,
  VueTerminal,
  WebFontsAddon,
  WebLinksAddon,
  WebSocketAddon,
  CompatibleTerminal,
  createTerminal,
  createCoreRuntime,
  createBashKitShell,
  options,
];
