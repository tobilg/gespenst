import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { docsSeo } from './seo.ts';

const configuredBase = process.env.DOCS_BASE_PATH ?? '/';
// Social scrapers do not resolve relative URLs, so og:image and friends need a real origin. Set
// DOCS_SITE_URL when deploying anywhere other than the default Pages domain.
const siteUrl = (process.env.DOCS_SITE_URL ?? 'https://gespenst.dev').replace(/\/+$/u, '');
export default defineConfig({
  appType: 'mpa',
  plugins: [
    {
      name: 'gespenst-docs-site-url',
      transformIndexHtml: {
        order: 'pre',
        handler: (html) => html.replaceAll('%SITE_URL%', siteUrl),
      },
    },
    docsSeo({
      siteUrl,
      guideIndex: resolve(import.meta.dirname, '../../docs/core/index.md'),
    }),
  ],
  base: configuredBase.endsWith('/') ? configuredBase : `${configuredBase}/`,
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, 'index.html'),
        example: resolve(import.meta.dirname, 'example.html'),
        // Cloudflare Pages answers unknown paths with this page and a real 404 status. Without it,
        // Pages falls back to SPA routing and serves the landing page for every URL.
        notFound: resolve(import.meta.dirname, '404.html'),
      },
    },
  },
  resolve: {
    alias: [
      {
        find: /^@gespenst\/clipboard$/,
        replacement: resolve(import.meta.dirname, '../../packages/clipboard/src/index.ts'),
      },
      {
        find: /^@gespenst\/core$/,
        replacement: resolve(import.meta.dirname, '../../packages/core/src/index.ts'),
      },
      {
        find: /^@gespenst\/themes$/,
        replacement: resolve(import.meta.dirname, '../../packages/themes/src/index.ts'),
      },
    ],
  },
});
