import { deflateSync, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  buildRobots,
  buildSitemap,
  cleanHref,
  cleanPath,
  cleanTitle,
  enhanceApiPage,
  entryPointName,
  extractDescription,
  pageTitle,
  parseGuideTitles,
  rewriteTypeDocData,
  truncate,
} from '../../seo.ts';

const siteUrl = 'https://gespenst.dev';

describe('clean URLs', () => {
  it('maps generated files to the paths Cloudflare Pages serves', () => {
    expect(cleanPath('index.html')).toBe('');
    expect(cleanPath('example.html')).toBe('example');
    expect(cleanPath('api/index.html')).toBe('api/');
    expect(cleanPath('api/modules/_gespenst_core.index.html')).toBe(
      'api/modules/_gespenst_core.index'
    );
  });

  it('rewrites relative page links and leaves everything else alone', () => {
    expect(cleanHref('../index.html')).toBe('../');
    expect(cleanHref('index.html')).toBe('./');
    expect(cleanHref('Core_Guide.Configuration.html#workers')).toBe(
      'Core_Guide.Configuration#workers'
    );
    expect(cleanHref('../classes/_gespenst_core.index.GespenstTerminal.html')).toBe(
      '../classes/_gespenst_core.index.GespenstTerminal'
    );
    for (const href of [
      '',
      '#install',
      '../assets/style.css',
      'https://example.com/a.html',
      '//cdn/a.html',
    ]) {
      expect(cleanHref(href)).toBe(href);
    }
  });
});

describe('API page metadata', () => {
  const page = [
    '<html><head><title>Getting Started | gespenst API - v0.1.2</title>',
    '<meta name="description" content="Documentation for gespenst API"/></head><body>',
    '<a href="../index.html">API</a><a href="Core_Guide.html">Guide</a>',
    '<div class="tsd-panel tsd-typography"><h1>Getting Started</h1>',
    '<p>Create a <code>responsive</code> terminal &amp; &quot;more&quot;.</p></div></body></html>',
  ].join('');

  it('qualifies symbol titles by package so same-named exports stay distinct', () => {
    expect(
      pageTitle(
        'api/variables/_gespenst_react.index.GespenstTerminal.html',
        'GespenstTerminal | gespenst API - v0.1.2'
      )
    ).toBe('GespenstTerminal (@gespenst/react) | gespenst API');
    expect(
      pageTitle(
        'api/classes/_gespenst_core.core.CoreRuntime.html',
        'CoreRuntime | gespenst API - v0.1.2'
      )
    ).toBe('CoreRuntime (@gespenst/core/headless) | gespenst API');
    expect(pageTitle('api/modules.html', 'gespenst API - v0.1.2')).toBe(
      'All packages | gespenst API'
    );
  });

  it('drops the release version from titles', () => {
    expect(cleanTitle('Getting Started | gespenst API - v0.1.2')).toBe(
      'Getting Started | gespenst API'
    );
    expect(cleanTitle('gespenst API - v1.0.0-beta.1')).toBe('gespenst API reference');
  });

  it('uses the first rendered paragraph as the description', () => {
    expect(extractDescription(page)).toBe('Create a responsive terminal & "more".');
    expect(extractDescription('<html><body></body></html>')).toBeUndefined();
  });

  it('truncates long descriptions at a word boundary', () => {
    const text = 'word '.repeat(60).trim();
    const result = truncate(text, 160);
    expect(result.length).toBeLessThanOrEqual(160);
    expect(result.endsWith('word…')).toBe(true);
  });

  it('adds canonical, social, and icon tags with clean links', () => {
    const url = `${siteUrl}/api/documents/Core_Guide.Getting_Started`;
    const { html, description } = enhanceApiPage(page, {
      file: 'api/documents/Core_Guide.Getting_Started.html',
      url,
      siteUrl,
      rootHref: '../../',
    });
    expect(description).toBe('Create a responsive terminal & "more".');
    expect(html).toContain('<title>Getting Started | gespenst API</title>');
    expect(html).toContain(
      '<meta name="description" content="Create a responsive terminal &amp; &quot;more&quot;."/>'
    );
    expect(html).toContain(`<link rel="canonical" href="${url}"/>`);
    expect(html).toContain('<link rel="icon" href="../../favicon.svg" type="image/svg+xml"/>');
    expect(html).toContain(`<meta property="og:image" content="${siteUrl}/opengraph.png"/>`);
    expect(html).toContain('<a href="../">API</a><a href="Core_Guide">Guide</a>');
    expect(html).not.toContain('Documentation for gespenst API');
  });
});

describe('entry-point module pages', () => {
  it('names the import specifier instead of TypeDoc\'s "index"', () => {
    expect(entryPointName('api/modules/_gespenst_web-fonts.index.html')).toBe(
      '@gespenst/web-fonts'
    );
    expect(entryPointName('api/modules/_gespenst_core.core.html')).toBe('@gespenst/core/headless');
    expect(entryPointName('api/modules/_gespenst_core.html')).toBeUndefined();
  });

  it('describes the module by its exports rather than its first export', () => {
    const source = [
      '<html><head><title>index | gespenst API - v0.1.2</title>',
      '<meta name="description" content="Documentation for gespenst API"/></head><body>',
      '<span class="tsd-member-summary-name"><svg class="tsd-kind-icon"><use href="#c"></use></svg>',
      '<a href="../classes/_gespenst_serialize.index.SerializeAddon.html">SerializeAddon</a></span>',
      '<div class="tsd-comment tsd-typography"><p>Creates snapshots.</p></div>',
      '<span class="tsd-member-summary-name"><a href="../interfaces/X.html">SerializeOptions</a></span>',
      '</body></html>',
    ].join('');
    const { title, description } = enhanceApiPage(source, {
      file: 'api/modules/_gespenst_serialize.index.html',
      url: `${siteUrl}/api/modules/_gespenst_serialize.index`,
      siteUrl,
      rootHref: '../../',
    });
    expect(title).toBe('@gespenst/serialize exports | gespenst API');
    expect(description).toBe(
      'API reference for every export of @gespenst/serialize: SerializeAddon, SerializeOptions'
    );
  });
});

describe('TypeDoc data assets', () => {
  it('rewrites path and url fields inside the deflated payload', () => {
    const data = {
      rows: [{ name: 'index.html', url: 'classes/Terminal.html#write' }],
      children: [{ path: 'documents/Core_Guide.html', text: 'Core Guide' }],
    };
    const payload = deflateSync(Buffer.from(JSON.stringify(data))).toString('base64');
    const output = rewriteTypeDocData(`window.searchData = "${payload}"`);
    const encoded = /"([^"]+)"$/u.exec(output)?.[1] ?? '';
    expect(output.startsWith('window.searchData = "')).toBe(true);
    expect(JSON.parse(inflateSync(Buffer.from(encoded, 'base64')).toString('utf8'))).toEqual({
      rows: [{ name: 'index.html', url: 'classes/Terminal#write' }],
      children: [{ path: 'documents/Core_Guide', text: 'Core Guide' }],
    });
  });

  it('refuses an unknown asset format instead of shipping it unchanged', () => {
    expect(() => rewriteTypeDocData('export default {}')).toThrow(
      'Unexpected TypeDoc data asset format'
    );
  });
});

describe('crawler files', () => {
  it('lists clean, absolute, sorted URLs in the sitemap', () => {
    const sitemap = buildSitemap(siteUrl, ['example.html', 'index.html', 'api/index.html']);
    expect([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/gu)].map((match) => match[1])).toEqual([
      'https://gespenst.dev/',
      'https://gespenst.dev/api/',
      'https://gespenst.dev/example',
    ]);
  });

  it('points robots.txt at the sitemap', () => {
    expect(buildRobots(siteUrl)).toContain('Sitemap: https://gespenst.dev/sitemap.xml');
  });

  it('reads guide titles from the Core Guide front matter in order', () => {
    const markdown = [
      '---',
      'title: Core Guide',
      'children:',
      '  Getting Started: ./getting-started.md',
      '  Events, Permissions, and Lifecycle: ./events-permissions-lifecycle.md',
      '---',
      '',
      '# Core Guide',
    ].join('\n');
    expect(parseGuideTitles(markdown)).toEqual([
      'Getting Started',
      'Events, Permissions, and Lifecycle',
    ]);
  });
});
