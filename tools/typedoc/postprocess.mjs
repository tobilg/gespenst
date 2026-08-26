import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';

const apiDirectory = resolve(import.meta.dirname, '../../apps/docs/public/api');
const landingPage = resolve(apiDirectory, '../index.html');
const coreGuide = resolve(apiDirectory, 'documents/Core_Guide.html');
const homePlaceholder = '__GESPENST_HOME__';
const guidePlaceholder = '__GESPENST_GUIDE__';

const htmlFiles = await collectHtmlFiles(apiDirectory);
await assertFile(coreGuide);
let homeReplacementCount = 0;
let guideReplacementCount = 0;

for (const file of htmlFiles) {
  const source = await readFile(file, 'utf8');
  const homeHref = webRelative(dirname(file), landingPage);
  const guideHref = webRelative(dirname(file), coreGuide);
  const homeOccurrences = source.split(homePlaceholder).length - 1;
  const guideOccurrences = source.split(guidePlaceholder).length - 1;
  if (homeOccurrences === 0) throw new Error(`Missing Home placeholder in ${file}`);
  if (guideOccurrences === 0) throw new Error(`Missing Core Guide placeholder in ${file}`);
  homeReplacementCount += homeOccurrences;
  guideReplacementCount += guideOccurrences;
  await writeFile(
    file,
    source.replaceAll(homePlaceholder, homeHref).replaceAll(guidePlaceholder, guideHref)
  );
}

console.log(
  `Rewrote ${homeReplacementCount} Home and ${guideReplacementCount} Core Guide links across ${htmlFiles.length} TypeDoc pages.`
);

function webRelative(from, to) {
  return relative(from, to).split(sep).join('/');
}

async function assertFile(file) {
  try {
    await readFile(file);
  } catch {
    throw new Error(`Expected generated documentation target is missing: ${file}`);
  }
}

async function collectHtmlFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return collectHtmlFiles(path);
      return entry.isFile() && entry.name.endsWith('.html') ? [path] : [];
    })
  );
  return files.flat();
}
