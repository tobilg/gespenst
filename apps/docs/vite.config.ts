import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const configuredBase = process.env.DOCS_BASE_PATH ?? '/';
// Social scrapers do not resolve relative URLs, so og:image and friends need a real origin. Set
// DOCS_SITE_URL when deploying anywhere other than the default Pages domain.
const siteUrl = (process.env.DOCS_SITE_URL ?? 'https://gespenst-docs.pages.dev').replace(
  /\/+$/u,
  ''
);
const isolationHeaders = {
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

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
  ],
  base: configuredBase.endsWith('/') ? configuredBase : `${configuredBase}/`,
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, 'index.html'),
        example: resolve(import.meta.dirname, 'example.html'),
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
        find: /^@gespenst\/wasmer$/,
        replacement: resolve(import.meta.dirname, '../../packages/wasmer/src/index.ts'),
      },
      {
        find: /^@gespenst\/themes$/,
        replacement: resolve(import.meta.dirname, '../../packages/themes/src/index.ts'),
      },
    ],
  },
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
});
