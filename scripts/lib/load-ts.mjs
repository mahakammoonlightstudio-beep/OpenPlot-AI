/**
 * Test helper: bundle a renderer-side TypeScript module for Node.
 *
 * The pure libraries live under src/lib/ (they are browser-side, no Node APIs),
 * while headless tests run plain Node against dist-electron. esbuild is
 * already installed as Vite's dependency, so we bundle the module on demand
 * into a temp .cjs file and require() it. No project files are modified.
 */
import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PROJ = path.resolve(import.meta.dirname, '..', '..');

/**
 * @param {string} relPath path relative to the project root, e.g. 'src/lib/storyImport.ts'
 * @returns {Promise<any>} the module exports
 */
export async function loadTs(relPath) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openplot-ts-'));
  const outfile = path.join(outDir, 'module.cjs');
  await build({
    entryPoints: [path.join(PROJ, relPath)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    logLevel: 'silent'
  });
  const mod = require(outfile);
  fs.rmSync(outDir, { recursive: true, force: true });
  return mod;
}
