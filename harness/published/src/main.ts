import './style.css';
import { runBenchmarkComparison } from './benchmarks.js';
import { runFunctionalScenarios, type ScenarioEnvironment } from './scenarios.js';
import type {
  BenchmarkReport,
  BrowserHarnessReport,
  FunctionalReport,
  HarnessMetadata,
} from './types.js';

const packageRows = requiredElement<HTMLTableSectionElement>('package-rows');
const environmentList = requiredElement<HTMLElement>('environment');
const scenarioGrid = requiredElement<HTMLElement>('scenario-grid');
const summary = requiredElement<HTMLElement>('summary-status');
const logElement = requiredElement<HTMLElement>('run-log');
const benchmarkElement = requiredElement<HTMLElement>('benchmark-results');
const functionalButton = requiredElement<HTMLButtonElement>('run-functional');
const benchmarkButton = requiredElement<HTMLButtonElement>('run-benchmarks');
const downloadButton = requiredElement<HTMLButtonElement>('download-report');

let metadata: HarnessMetadata;
let functional: FunctionalReport | undefined;
let benchmarks: BenchmarkReport | undefined;
let runningFunctional: Promise<FunctionalReport> | null = null;
let runningBenchmarks: Promise<BenchmarkReport> | null = null;

const environment: ScenarioEnvironment = {
  get websocketToken() {
    return metadata.websocketToken;
  },
  createHost(id, label) {
    let card = document.querySelector<HTMLElement>(`[data-scenario=${JSON.stringify(id)}]`);
    if (!card) {
      card = document.createElement('article');
      card.className = 'scenario';
      card.dataset.scenario = id;
      card.dataset.status = 'idle';
      card.innerHTML = `
        <header class="scenario-header">
          <h3 class="scenario-title"></h3>
          <span class="scenario-status">idle</span>
        </header>
        <div class="scenario-body">
          <div class="terminal-host"></div>
          <pre class="scenario-details"></pre>
        </div>`;
      scenarioGrid.append(card);
    }
    const title = card.querySelector<HTMLElement>('.scenario-title');
    if (title) title.textContent = label;
    const host = card.querySelector<HTMLElement>('.terminal-host');
    if (!host) throw new Error(`Scenario ${id} has no terminal host`);
    host.replaceChildren();
    return host;
  },
  update(id, status, details = '') {
    const card = document.querySelector<HTMLElement>(`[data-scenario=${JSON.stringify(id)}]`);
    if (!card) return;
    card.dataset.status = status;
    const statusElement = card.querySelector<HTMLElement>('.scenario-status');
    if (statusElement) statusElement.textContent = status;
    const detailsElement = card.querySelector<HTMLElement>('.scenario-details');
    if (detailsElement) detailsElement.textContent = details;
  },
  log,
};

window.__gespenstRunFunctional = runFunctional;
window.__gespenstRunBenchmarks = runBenchmarks;
window.__gespenstPublishedHarness = initialize();

functionalButton.addEventListener('click', () => void runFunctional());
benchmarkButton.addEventListener('click', () => void runBenchmarks());
downloadButton.addEventListener('click', downloadReport);

async function initialize(): Promise<BrowserHarnessReport> {
  metadata = await fetchMetadata();
  renderMetadata(metadata);
  log(
    `Loaded ${metadata.packages.length} published Gespenst packages for selector ${metadata.selector}`
  );
  const params = new URLSearchParams(location.search);
  functional = await runFunctional();
  if (params.get('benchmark') === '1') benchmarks = await runBenchmarks();
  return currentReport();
}

function runFunctional(): Promise<FunctionalReport> {
  if (runningFunctional) return runningFunctional;
  setSummary('running', 'Running functional scenarios…');
  functionalButton.disabled = true;
  runningFunctional = runFunctionalScenarios(environment)
    .then((report) => {
      functional = report;
      const failed = report.scenarios.filter((scenario) => scenario.status === 'failed');
      setSummary(
        failed.length ? 'failed' : 'passed',
        failed.length
          ? `${failed.length} of ${report.scenarios.length} scenarios failed`
          : `${report.scenarios.length} functional scenarios passed`
      );
      downloadButton.disabled = false;
      return report;
    })
    .finally(() => {
      functionalButton.disabled = false;
      runningFunctional = null;
    });
  return runningFunctional;
}

function runBenchmarks(): Promise<BenchmarkReport> {
  if (runningBenchmarks) return runningBenchmarks;
  benchmarkButton.disabled = true;
  benchmarkElement.classList.remove('empty');
  benchmarkElement.textContent = 'Collecting benchmark samples…';
  runningBenchmarks = runBenchmarkComparison(log)
    .then((report) => {
      benchmarks = report;
      renderBenchmarks(report);
      downloadButton.disabled = false;
      return report;
    })
    .catch((error) => {
      benchmarkElement.classList.add('empty');
      benchmarkElement.textContent = error instanceof Error ? error.message : String(error);
      throw error;
    })
    .finally(() => {
      benchmarkButton.disabled = false;
      runningBenchmarks = null;
    });
  return runningBenchmarks;
}

async function fetchMetadata(): Promise<HarnessMetadata> {
  const response = await fetch('/metadata.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`Harness metadata failed with HTTP ${response.status}`);
  return (await response.json()) as HarnessMetadata;
}

function renderMetadata(value: HarnessMetadata): void {
  packageRows.replaceChildren(
    ...value.packages.map((item) => {
      const row = document.createElement('tr');
      for (const value of [
        item.name,
        item.version,
        item.scenario,
        compactIntegrity(item.integrity),
      ]) {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.append(cell);
      }
      return row;
    })
  );
  const values = [
    ['Selector', value.selector],
    ['xterm.js', value.upstreamXterm.version],
    ['Browser', browserName()],
    ['DPR', String(devicePixelRatio)],
  ];
  environmentList.replaceChildren(
    ...values.map(([term, description]) => {
      const wrapper = document.createElement('div');
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = term ?? '';
      dd.textContent = description ?? '';
      wrapper.append(dt, dd);
      return wrapper;
    })
  );
}

function renderBenchmarks(report: BenchmarkReport): void {
  const table = document.createElement('table');
  table.innerHTML = `
    <thead><tr><th>Implementation</th><th>Mode</th><th>Workload</th><th>Median</th><th>p95</th></tr></thead>
    <tbody></tbody>`;
  const body = table.querySelector('tbody');
  for (const item of report.cases) {
    const row = document.createElement('tr');
    for (const value of [
      item.implementation,
      item.mode,
      item.workload,
      `${formatNumber(item.summary.median)} ${item.unit}`,
      `${formatNumber(item.summary.p95)} ${item.unit}`,
    ]) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    body?.append(row);
  }
  benchmarkElement.replaceChildren(table);
}

function currentReport(): BrowserHarnessReport {
  if (!functional) throw new Error('Functional harness has not completed');
  return {
    metadata,
    userAgent: navigator.userAgent,
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    functional,
    ...(benchmarks ? { benchmarks } : {}),
  };
}

function downloadReport(): void {
  const blob = new Blob([`${JSON.stringify(currentReport(), null, 2)}\n`], {
    type: 'application/json',
  });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `gespenst-published-harness-${new Date().toISOString().replaceAll(':', '-')}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 0);
}

function log(message: string): void {
  const timestamp = new Date().toISOString().slice(11, 23);
  logElement.textContent += `${timestamp} ${message}\n`;
  logElement.scrollTop = logElement.scrollHeight;
}

function setSummary(status: string, text: string): void {
  summary.dataset.status = status;
  summary.textContent = text;
}

function compactIntegrity(integrity: string): string {
  return integrity.length > 28 ? `${integrity.slice(0, 18)}…${integrity.slice(-8)}` : integrity;
}

function browserName(): string {
  if (navigator.userAgent.includes('Firefox')) return 'Firefox';
  if (navigator.userAgent.includes('AppleWebKit') && !navigator.userAgent.includes('Chrome'))
    return 'WebKit';
  if (navigator.userAgent.includes('Chrome')) return 'Chromium';
  return 'Unknown';
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Harness element #${id} is missing`);
  return element as T;
}
