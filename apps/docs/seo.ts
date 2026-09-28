import { existsSync, statSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, relative, resolve, sep } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import type { Plugin } from 'vite';

export interface DocsSeoOptions {
  /** Absolute public URL of the site root, without a trailing slash. */
  readonly siteUrl: string;
  /** The Core Guide index whose front matter lists the guides in reading order. */
  readonly guideIndex: string;
}

const siteName = 'gespenst';
const socialImageAlt = 'The gespenst terminal toolkit: Ghostty VT running in the browser.';
const descriptionLimit = 160;
// Thin navigation pages that only repeat the sidebar.
const sitemapExclusions = new Set(['404.html', 'api/hierarchy.html']);

/**
 * Build-time SEO for the documentation site.
 *
 * Cloudflare Pages serves `/page` for `page.html` and redirects the `.html` spelling with a 308, so
 * every generated URL, canonical link, and sitemap entry uses the extensionless form. The dev and
 * preview servers mirror that routing so the same links work locally.
 */
export function docsSeo(options: DocsSeoOptions): Plugin {
  let outDir = '';
  let publicDir = '';
  let root = '';
  let pagesEmitted = false;
  return {
    name: 'gespenst-docs-seo',
    // Runs after Vite's HTML plugin so the page bundle already contains the emitted HTML.
    enforce: 'post',
    configResolved(config) {
      root = config.root;
      outDir = resolve(config.root, config.build.outDir);
      publicDir = config.publicDir;
    },
    configureServer(server) {
      server.middlewares.use(cleanUrlMiddleware(() => [root, publicDir]));
    },
    configurePreviewServer(server) {
      server.middlewares.use(cleanUrlMiddleware(() => [outDir]));
    },
    generateBundle(_options, bundle) {
      // Worker bundles run this plugin too; only the page build should post-process the site.
      if ('index.html' in bundle) pagesEmitted = true;
    },
    async closeBundle() {
      if (!pagesEmitted) return;
      pagesEmitted = false;
      await finalizeSite(outDir, publicDir, options);
    },
  };
}

// Sources are read from publicDir, not outDir, so the rewrite never compounds when Vite leaves
// earlier copies of public files in place.
async function finalizeSite(
  outDir: string,
  publicDir: string,
  options: DocsSeoOptions
): Promise<void> {
  const htmlFiles = (await collectFiles(outDir, '.html')).map((file) =>
    toPosix(relative(outDir, file))
  );
  const descriptions = new Map<string, string>();

  for (const file of htmlFiles.filter((path) => path.startsWith('api/'))) {
    const html = await readFile(join(publicDir, file), 'utf8');
    const page = enhanceApiPage(html, {
      file,
      url: pageUrl(options.siteUrl, file),
      siteUrl: options.siteUrl,
      rootHref: '../'.repeat(file.split('/').length - 1),
    });
    descriptions.set(file, page.description);
    await writeFile(join(outDir, file), page.html);
  }

  for (const name of ['navigation.js', 'search.js', 'hierarchy.js']) {
    const file = `api/assets/${name}`;
    if (existsSync(join(publicDir, file))) {
      await writeFile(
        join(outDir, file),
        rewriteTypeDocData(await readFile(join(publicDir, file), 'utf8'))
      );
    }
  }

  const sitemapPaths = htmlFiles.filter((file) => !sitemapExclusions.has(file));
  await writeFile(join(outDir, 'sitemap.xml'), buildSitemap(options.siteUrl, sitemapPaths));
  await writeFile(join(outDir, 'robots.txt'), buildRobots(options.siteUrl));

  const guides = parseGuideTitles(await readFile(options.guideIndex, 'utf8')).map((title) => {
    const file = `api/documents/Core_Guide.${title.replaceAll(' ', '_')}.html`;
    const description = descriptions.get(file);
    if (description === undefined) {
      throw new Error(`Expected generated guide page for "${title}" at ${file}`);
    }
    return { title, url: pageUrl(options.siteUrl, file), description };
  });
  await writeFile(join(outDir, 'llms.txt'), buildLlmsTxt(options.siteUrl, guides));
}

/** Maps a site-relative `.html` file to the URL Cloudflare Pages serves it at. */
export function cleanPath(file: string): string {
  const withoutExtension = file.replace(/\.html$/u, '');
  if (withoutExtension === 'index') return '';
  return withoutExtension.endsWith('/index')
    ? withoutExtension.slice(0, -'index'.length)
    : withoutExtension;
}

export function pageUrl(siteUrl: string, file: string): string {
  return `${siteUrl}/${cleanPath(file)}`;
}

/** Rewrites a relative link to a generated `.html` page into its extensionless URL. */
export function cleanHref(href: string): string {
  if (
    href === '' ||
    href.startsWith('#') ||
    href.startsWith('//') ||
    /^[a-z][a-z\d+.-]*:/iu.test(href)
  ) {
    return href;
  }
  const hashIndex = href.indexOf('#');
  const path = hashIndex === -1 ? href : href.slice(0, hashIndex);
  const hash = hashIndex === -1 ? '' : href.slice(hashIndex);
  if (!path.endsWith('.html')) return href;
  const cleaned = cleanPath(path);
  return `${cleaned === '' ? './' : cleaned}${hash}`;
}

export function rewriteHtmlLinks(html: string): string {
  return html.replace(/\bhref="([^"]*)"/gu, (_match, href: string) => `href="${cleanHref(href)}"`);
}

export interface EnhancedPage {
  readonly html: string;
  readonly title: string;
  readonly description: string;
}

/**
 * Gives a TypeDoc page clean links, a release-independent title, a page-specific description, a
 * canonical URL, social cards, and the site icon.
 */
export function enhanceApiPage(
  source: string,
  page: {
    readonly file: string;
    readonly url: string;
    readonly siteUrl: string;
    readonly rootHref: string;
  }
): EnhancedPage {
  const { url } = page;
  const rawTitle = decodeEntities(
    /<title>([\s\S]*?)<\/title>/u.exec(source)?.[1] ?? 'gespenst API'
  );
  const title = pageTitle(page.file, rawTitle);
  const entryPoint = entryPointName(page.file);
  // An entry-point module has no comment of its own, so its first paragraph would be the first
  // export's summary.
  const description =
    (entryPoint === undefined
      ? extractDescription(source)
      : moduleDescription(entryPoint, source)) ?? fallbackDescription(title);
  const image = `${page.siteUrl}/opengraph.png`;
  const head = [
    `<link rel="canonical" href="${escapeAttribute(url)}"/>`,
    `<link rel="icon" href="${page.rootHref}favicon.svg" type="image/svg+xml"/>`,
    '<meta property="og:type" content="website"/>',
    `<meta property="og:site_name" content="${siteName}"/>`,
    `<meta property="og:url" content="${escapeAttribute(url)}"/>`,
    `<meta property="og:title" content="${escapeAttribute(title)}"/>`,
    `<meta property="og:description" content="${escapeAttribute(description)}"/>`,
    `<meta property="og:image" content="${escapeAttribute(image)}"/>`,
    '<meta property="og:image:width" content="1200"/>',
    '<meta property="og:image:height" content="630"/>',
    `<meta property="og:image:alt" content="${socialImageAlt}"/>`,
    '<meta name="twitter:card" content="summary_large_image"/>',
    `<meta name="twitter:title" content="${escapeAttribute(title)}"/>`,
    `<meta name="twitter:description" content="${escapeAttribute(description)}"/>`,
    `<meta name="twitter:image" content="${escapeAttribute(image)}"/>`,
  ].join('');

  const html = rewriteHtmlLinks(source)
    .replace(/<title>[\s\S]*?<\/title>/u, `<title>${escapeText(title)}</title>`)
    .replace(
      /<meta name="description" content="[^"]*"\/?>/u,
      `<meta name="description" content="${escapeAttribute(description)}"/>`
    )
    .replace('</head>', `${head}</head>`);
  return { html, title, description };
}

/**
 * A unique, release-independent title. TypeDoc titles every entry-point module "index", and symbols
 * such as `GespenstTerminal` exist in several packages, so both are qualified by import specifier.
 */
export function pageTitle(file: string, rawTitle: string): string {
  const entryPoint = entryPointName(file);
  if (entryPoint !== undefined) return `${entryPoint} exports | gespenst API`;
  const symbol = /^api\/\w+\/_gespenst_([\w-]+)\.([\w-]+)\.[^/]+\.html$/u.exec(file);
  const title = cleanTitle(rawTitle);
  if (symbol) {
    const [, packageName = '', entry = ''] = symbol;
    return title.replace(
      / \| gespenst API$/u,
      ` (${importSpecifier(packageName, entry)}) | gespenst API`
    );
  }
  if (file === 'api/modules.html') return 'All packages | gespenst API';
  if (file === 'api/hierarchy.html') return 'Class hierarchy | gespenst API';
  return title;
}

/** The public import specifier documented by an entry-point module page. */
export function entryPointName(file: string): string | undefined {
  const match = /^api\/modules\/_gespenst_([\w-]+)\.([\w-]+)\.html$/u.exec(file);
  return match ? importSpecifier(match[1] ?? '', match[2] ?? '') : undefined;
}

function importSpecifier(packageName: string, entry: string): string {
  if (entry === 'index') return `@gespenst/${packageName}`;
  // The headless runtime is built from src/core but published as the ./headless subpath.
  return `@gespenst/${packageName}/${packageName === 'core' && entry === 'core' ? 'headless' : entry}`;
}

function moduleDescription(entryPoint: string, html: string): string {
  const names = [
    ...html.matchAll(
      /tsd-member-summary-name">(?:<svg[\s\S]*?<\/svg>)?<a href="[^"]*">([^<]+)<\/a>/gu
    ),
  ].map((match) => decodeEntities(match[1] ?? ''));
  const summary = `API reference for every export of ${entryPoint}`;
  return truncate(
    names.length === 0 ? `${summary}.` : `${summary}: ${names.join(', ')}`,
    descriptionLimit
  );
}

/** Drops the release suffix so titles, and the search results built from them, survive releases. */
export function cleanTitle(title: string): string {
  const withoutVersion = title.replace(/ - v\d[\w.+-]*$/u, '');
  return withoutVersion === 'gespenst API' ? 'gespenst API reference' : withoutVersion;
}

/** The first prose paragraph of the page's rendered Markdown or TSDoc comment. */
export function extractDescription(html: string): string | undefined {
  const start = html.search(/class="[^"]*\btsd-typography\b[^"]*"/u);
  if (start === -1) return undefined;
  const paragraph = /<p>([\s\S]*?)<\/p>/u.exec(html.slice(start))?.[1];
  if (paragraph === undefined) return undefined;
  const text = decodeEntities(paragraph.replace(/<[^>]+>/gu, ''))
    .replace(/\s+/gu, ' ')
    .trim();
  return text === '' ? undefined : truncate(text, descriptionLimit);
}

function fallbackDescription(title: string): string {
  const subject = title.replace(/ \| gespenst API$/u, '');
  return truncate(
    `${subject}: API reference for gespenst, the Ghostty VT terminal emulator for the web.`,
    descriptionLimit
  );
}

export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit - 1);
  const boundary = cut.lastIndexOf(' ');
  return `${(boundary > limit / 2 ? cut.slice(0, boundary) : cut).replace(/[\s,;:.]+$/u, '')}…`;
}

/**
 * TypeDoc ships its sidebar, search, and hierarchy as deflated JSON. Their links drive the sidebar's
 * current-page highlight, which compares against `location.pathname`, so they need the same clean
 * URLs as the page markup.
 */
export function rewriteTypeDocData(source: string): string {
  const match = /^(window\.\w+ = ")(data:[^,]*,)?([A-Za-z\d+/=]+)(";?\s*)$/u.exec(source);
  if (!match) throw new Error('Unexpected TypeDoc data asset format');
  const [, prefix, dataUrlPrefix = '', payload = '', suffix] = match;
  const data: unknown = JSON.parse(inflateSync(Buffer.from(payload, 'base64')).toString('utf8'));
  const encoded = deflateSync(Buffer.from(JSON.stringify(cleanLinkFields(data)))).toString(
    'base64'
  );
  return `${prefix}${dataUrlPrefix}${encoded}${suffix}`;
}

function cleanLinkFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cleanLinkFields);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      (key === 'path' || key === 'url') && typeof entry === 'string'
        ? cleanHref(entry)
        : cleanLinkFields(entry),
    ])
  );
}

export function buildSitemap(siteUrl: string, files: readonly string[]): string {
  const urls = files
    .map((file) => pageUrl(siteUrl, file))
    .sort()
    .map((url) => `  <url><loc>${escapeText(url)}</loc></url>`);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    '</urlset>',
    '',
  ].join('\n');
}

export function buildRobots(siteUrl: string): string {
  return `User-agent: *\nAllow: /\n\nSitemap: ${siteUrl}/sitemap.xml\n`;
}

/** Guide titles in reading order, from the `children` map in the Core Guide front matter. */
export function parseGuideTitles(indexMarkdown: string): string[] {
  const frontMatter = /^---\n([\s\S]*?)\n---/u.exec(indexMarkdown)?.[1] ?? '';
  return [...frontMatter.matchAll(/^ {2}(.+): \.\/[\w-]+\.md$/gmu)].map((match) => match[1] ?? '');
}

export interface LlmsGuide {
  readonly title: string;
  readonly url: string;
  readonly description: string;
}

export function buildLlmsTxt(siteUrl: string, guides: readonly LlmsGuide[]): string {
  return [
    '# gespenst',
    '',
    '> gespenst is a high-performance TypeScript terminal emulator for the web, built on the official Ghostty VT engine compiled to WebAssembly. It offers a byte-native API, worker isolation, WebGPU/WebGL2/Canvas 2D rendering, an xterm.js 6 compatibility layer, React, Vue, and Svelte adapters, and browser-only Bash shells.',
    '',
    'Install `@gespenst/core` for the browser terminal and headless runtime. Every package ships as ESM with lockstep versions and is MIT licensed.',
    '',
    '## Core Guide',
    '',
    ...guides.map((guide) => `- [${guide.title}](${guide.url}): ${guide.description}`),
    '',
    '## Reference',
    '',
    `- [API reference](${siteUrl}/api/): Generated TypeScript API reference for every @gespenst package`,
    `- [Core Guide overview](${siteUrl}/api/documents/Core_Guide): Where to start for each integration goal`,
    '',
    '## Optional',
    '',
    `- [Transparent terminal example](${siteUrl}/example): A draggable browser-only Bash session on an alpha surface`,
    '- [Source code](https://github.com/tobilg/gespenst): Repository, issues, and third-party notices',
    '',
  ].join('\n');
}

type Middleware = (request: IncomingMessage, response: ServerResponse, next: () => void) => void;

/** Serves `/page` from `page.html` and `/dir/` from `dir/index.html`, like Cloudflare Pages. */
function cleanUrlMiddleware(directories: () => readonly string[]): Middleware {
  return (request, _response, next) => {
    const url = request.url;
    if (!url || (request.method !== 'GET' && request.method !== 'HEAD')) return next();
    const queryIndex = url.search(/[?#]/u);
    const pathname = queryIndex === -1 ? url : url.slice(0, queryIndex);
    const query = queryIndex === -1 ? '' : url.slice(queryIndex);
    // TypeDoc names contain dots (`Core_Guide.Getting_Started`), so the extension alone cannot tell
    // a page from an asset. Rewrite only when the `.html` sibling exists.
    if (pathname === '/' || pathname.endsWith('.html')) return next();
    const candidate = pathname.endsWith('/') ? `${pathname}index.html` : `${pathname}.html`;
    let decoded: string;
    try {
      decoded = decodeURIComponent(candidate);
    } catch {
      return next();
    }
    for (const directory of directories()) {
      const file = resolve(directory, `.${decoded}`);
      if (!file.startsWith(directory + sep)) continue;
      if (existsSync(file) && statSync(file).isFile()) {
        request.url = `${candidate}${query}`;
        break;
      }
    }
    next();
  };
}

async function collectFiles(directory: string, extension: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return collectFiles(path, extension);
      return entry.isFile() && entry.name.endsWith(extension) ? [path] : [];
    })
  );
  return nested.flat();
}

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&#(\d+);/gu, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/gu, '&');
}

function escapeText(text: string): string {
  return text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

function escapeAttribute(text: string): string {
  return escapeText(text).replace(/"/gu, '&quot;');
}
