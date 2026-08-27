import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { inflateSync } from 'node:zlib';

const root = resolve(import.meta.dirname, '..');
const outputDirectory = resolve(root, 'apps/docs/dist');
const configuredBase = normalizeBase(process.env.DOCS_BASE_PATH ?? '/');
const requiredPages = [
  'index.html',
  'example.html',
  'api/index.html',
  'api/documents/Core_Guide.html',
  'api/documents/Core_Guide.Getting_Started.html',
  'api/documents/Core_Guide.Connecting_a_PTY.html',
  'api/documents/Core_Guide.Browser-only_Shells.html',
  'api/documents/Core_Guide.Configuration.html',
  'api/documents/Core_Guide.Layout,_Fonts,_and_Themes.html',
  'api/documents/Core_Guide.Events,_Permissions,_and_Lifecycle.html',
  'api/documents/Core_Guide.Clipboard_and_MIME_Paste.html',
  'api/documents/Core_Guide.Performance.html',
  'api/documents/Core_Guide.Headless_Runtime.html',
  'api/documents/Core_Guide.Migrating_from_xterm.js.html',
  'api/documents/Core_Guide.Troubleshooting.html',
];
const guideTitles = [
  'Core Guide',
  'Getting Started',
  'Connecting a PTY',
  'Browser-only Shells',
  'Configuration',
  'Layout, Fonts, and Themes',
  'Events, Permissions, and Lifecycle',
  'Clipboard and MIME Paste',
  'Performance',
  'Headless Runtime',
  'Migrating from xterm.js',
  'Troubleshooting',
];

for (const page of requiredPages) await assertFile(resolve(outputDirectory, page));
await assertDeploymentHeaders();
await assertNoRetiredRuntimeArtifacts();
await assertSocialImage();

const htmlFiles = await collectFiles(outputDirectory, (file) => extname(file) === '.html');
const errors = [];
const htmlCache = new Map();

for (const file of htmlFiles) {
  const source = await readFile(file, 'utf8');
  htmlCache.set(file, source);
  const sourceName = webPath(relative(outputDirectory, file));
  for (const match of source.matchAll(/\b(?:href|src)=(['"])(.*?)\1/giu)) {
    const reference = decodeHtml(match[2] ?? '');
    if (/api\/api\//u.test(reference)) {
      errors.push(`${sourceName}: nested API path ${reference}`);
      continue;
    }
    if (shouldIgnore(reference)) continue;
    const target = resolveReference(file, reference);
    if (!target) continue;
    if (!inside(outputDirectory, target.file)) {
      errors.push(`${sourceName}: link escapes documentation output: ${reference}`);
      continue;
    }
    if (!(await fileExists(target.file))) {
      errors.push(`${sourceName}: missing target for ${reference}`);
      continue;
    }
    if (target.fragment && extname(target.file) === '.html') {
      const targetSource = htmlCache.get(target.file) ?? (await readFile(target.file, 'utf8'));
      htmlCache.set(target.file, targetSource);
      if (!hasAnchor(targetSource, target.fragment)) {
        errors.push(`${sourceName}: missing fragment #${target.fragment} in ${reference}`);
      }
    }
  }
}

const searchFiles = await collectFiles(resolve(outputDirectory, 'api/assets'), (file) =>
  /search.*\.js$/u.test(file)
);
const searchRows = [];
for (const file of searchFiles) {
  const source = await readFile(file, 'utf8');
  const payload = source.match(/window\.searchData = "([^"]+)"/u)?.[1];
  if (!payload) continue;
  const data = JSON.parse(inflateSync(Buffer.from(payload, 'base64')).toString('utf8'));
  if (Array.isArray(data.rows)) searchRows.push(...data.rows);
}
for (const title of guideTitles) {
  if (!searchRows.some((row) => row?.name === title)) {
    errors.push(`TypeDoc search index does not include ${title}`);
  }
}

if (errors.length > 0) {
  throw new Error(
    `Documentation verification failed:\n${errors.map((error) => `- ${error}`).join('\n')}`
  );
}

console.log(
  `Verified ${htmlFiles.length} documentation pages, ${requiredPages.length} required routes, and the TypeDoc guide search index.`
);

function resolveReference(sourceFile, reference) {
  const hashIndex = reference.indexOf('#');
  const queryIndex = reference.indexOf('?');
  const end = [hashIndex, queryIndex].filter((value) => value >= 0).sort((a, b) => a - b)[0];
  const pathPart = reference.slice(0, end ?? reference.length);
  const fragment = hashIndex >= 0 ? safeDecode(reference.slice(hashIndex + 1)) : '';
  let target;
  if (pathPart === '') {
    target = sourceFile;
  } else if (pathPart.startsWith('/')) {
    const withoutBase =
      configuredBase !== '/' && pathPart.startsWith(configuredBase)
        ? pathPart.slice(configuredBase.length)
        : pathPart.slice(1);
    target = resolve(outputDirectory, safeDecode(withoutBase));
  } else {
    target = resolve(dirname(sourceFile), safeDecode(pathPart));
  }
  if (pathPart.endsWith('/')) target = resolve(target, 'index.html');
  return { file: target, fragment };
}

function shouldIgnore(reference) {
  return reference === '' || reference.startsWith('//') || /^[a-z][a-z\d+.-]*:/iu.test(reference);
}

function hasAnchor(source, fragment) {
  const escaped = escapeRegExp(fragment);
  return new RegExp(`\\b(?:id|name)=(['"])${escaped}\\1`, 'u').test(source);
}

function decodeHtml(value) {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeBase(value) {
  const withLeadingSlash = value.startsWith('/') ? value : `/${value}`;
  return withLeadingSlash.endsWith('/') ? withLeadingSlash : `${withLeadingSlash}/`;
}

function inside(directory, file) {
  const path = relative(directory, file);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep));
}

function webPath(value) {
  return value.split(sep).join('/');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

async function fileExists(file) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/** Keeps the static deployment policy present without reintroducing obsolete isolation headers. */
async function assertDeploymentHeaders() {
  const file = resolve(outputDirectory, '_headers');
  await assertFile(file);
  const source = await readFile(file, 'utf8');
  const required = [
    'X-Content-Type-Options: nosniff',
    'Referrer-Policy: strict-origin-when-cross-origin',
  ];
  const missing = required.filter((header) => !source.includes(header));
  if (missing.length > 0) {
    throw new Error(`_headers is missing required directives: ${missing.join(', ')}`);
  }
  const obsolete = ['Cross-Origin-Opener-Policy', 'Cross-Origin-Embedder-Policy'];
  const retained = obsolete.filter((header) => source.includes(header));
  if (retained.length > 0) {
    throw new Error(`_headers retains obsolete isolation directives: ${retained.join(', ')}`);
  }
}

/** Fails a docs build if an old runtime chunk, API page, or bootstrap script survives cleanup. */
async function assertNoRetiredRuntimeArtifacts() {
  const files = await collectFiles(outputDirectory, () => true);
  const failures = [];
  const forbiddenPaths = ['wasmer_js', '_gespenst_wasmer', 'coi-serviceworker'];
  const forbiddenContent = ['cdn.wasmer.io', 'wasmer_js_bg.wasm', 'coi-serviceworker'];
  const readableExtensions = new Set(['.css', '.html', '.js', '.json', '.map', '.mjs', '.txt']);

  for (const file of files) {
    const outputPath = webPath(relative(outputDirectory, file));
    const lowerPath = outputPath.toLowerCase();
    if (forbiddenPaths.some((fragment) => lowerPath.includes(fragment))) {
      failures.push(`${outputPath}: retired runtime artifact`);
      continue;
    }
    if (!readableExtensions.has(extname(file))) continue;
    const source = await readFile(file, 'utf8');
    const match = forbiddenContent.find((fragment) => source.includes(fragment));
    if (match) failures.push(`${outputPath}: contains retired runtime reference ${match}`);
  }

  if (failures.length > 0) {
    throw new Error(
      `Retired runtime artifacts remain in documentation output:\n${failures
        .map((failure) => `- ${failure}`)
        .join('\n')}`
    );
  }
}

/**
 * Social scrapers do not resolve relative URLs, so every page must point at an absolute image that
 * actually shipped. `apps/docs/public` is otherwise generated and ignored, which makes the file
 * easy to lose without any visible symptom until a shared link renders a bare card.
 */
async function assertSocialImage() {
  await assertFile(resolve(outputDirectory, 'opengraph.png'));
  const pages = ['index.html', 'example.html'];
  const failures = [];
  for (const page of pages) {
    const source = await readFile(resolve(outputDirectory, page), 'utf8');
    const image = source.match(/property=["']og:image["'] content=["']([^"']+)["']/u)?.[1];
    if (!image) failures.push(`${page}: no og:image`);
    else if (!/^https:\/\//u.test(image))
      failures.push(`${page}: og:image is not absolute (${image})`);
  }
  if (failures.length > 0) {
    throw new Error(
      `Social metadata verification failed:\n${failures.map((f) => `- ${f}`).join('\n')}`
    );
  }
}

async function assertFile(file) {
  if (!(await fileExists(file))) {
    throw new Error(
      `Required documentation page is missing: ${webPath(relative(outputDirectory, file))}`
    );
  }
}

async function collectFiles(directory, predicate) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return collectFiles(path, predicate);
      return entry.isFile() && predicate(path) ? [path] : [];
    })
  );
  return files.flat();
}
