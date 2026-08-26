/// <reference lib="webworker" />

import type { MainToWorkerMessage } from '../protocol.js';
import { TerminalWorkerHost } from './terminal-worker-host.js';

const scope = self as DedicatedWorkerGlobalScope;
const host = new TerminalWorkerHost(scope);

scope.addEventListener('message', (event: MessageEvent<MainToWorkerMessage>) => {
  host.dispatch(event.data);
});
