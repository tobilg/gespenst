import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const declaration = resolve(import.meta.dirname, '../packages/core/dist/terminal.d.ts');
const source = await readFile(declaration, 'utf8');

// Vite needs the source-level stylesheet import to extract index.css. Declaration consumers do
// not: CSS is exposed explicitly through @gespenst/core/style.css, and NodeNext cannot resolve a
// JavaScript side-effect import for that asset.
const processed = source.replace(/^import ['"]\.\/style\.css['"];\r?\n/u, '');

if (processed === source) {
  throw new Error(`Expected a stylesheet import in ${declaration}`);
}

await writeFile(declaration, processed);
