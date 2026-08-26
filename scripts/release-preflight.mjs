import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { validateRelease } from './release-utils.mjs';

const execute = promisify(execFile);

export async function runReleasePreflight({
  root,
  tag,
  requireClean = false,
  requireMain = false,
}) {
  const { errors, publicPackages, version } = await validateRelease(root, tag);
  if (requireClean) {
    const { stdout } = await execute('git', ['status', '--porcelain'], { cwd: root });
    if (stdout.trim()) errors.push('The release checkout contains uncommitted changes');
  }
  if (requireMain) {
    try {
      await execute('git', ['merge-base', '--is-ancestor', 'HEAD', 'origin/main'], { cwd: root });
    } catch {
      errors.push('The release commit is not reachable from origin/main');
    }
  }
  if (errors.length > 0) throw new Error(`Release preflight failed:\n- ${errors.join('\n- ')}`);
  return { packageCount: publicPackages.length, version };
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const result = await runReleasePreflight({
    root,
    tag: valueAfter(args, '--tag') ?? process.env.GITHUB_REF_NAME,
    requireClean: args.includes('--require-clean'),
    requireMain: args.includes('--require-main'),
  });
  console.log(`Release preflight passed for ${result.packageCount} packages at v${result.version}`);
}
