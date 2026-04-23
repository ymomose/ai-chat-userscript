#!/usr/bin/env node
/**
 * Tailwind precompile + embed into ai-chat.user.js
 *
 * Runs the Tailwind CLI against input.css + tailwind.config.cjs (whose `content`
 * points at the userscript source), captures the generated CSS, and writes it
 * into the userscript's `/* @TAILWIND_CSS_START *\/ ... /* @TAILWIND_CSS_END *\/`
 * region as a template-literal string.
 *
 * The userscript ships as a single self-contained file, so running this script
 * is the only way to regenerate the embedded utility CSS when classes change.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const configPath = join(__dirname, 'tailwind.config.cjs');
const inputPath = join(__dirname, 'input.css');
const scriptPath = join(root, 'ai-chat.user.js');

// Markers must be the sole non-whitespace content on their line. Using an
// anchored regex (rather than `indexOf`) avoids matching a marker literal
// that happens to appear inside a `//` comment — the previous version of
// this script silently spliced the CSS into a documentation comment and
// left the real declaration intact, producing two `const TAILWIND_CSS`
// declarations in the same scope.
const START_RE = /^[ \t]*\/\* @TAILWIND_CSS_START \*\/[ \t]*$/m;
const END_RE = /^[ \t]*\/\* @TAILWIND_CSS_END \*\/[ \t]*$/m;

const tmp = mkdtempSync(join(tmpdir(), 'aicx-tw-'));
const outPath = join(tmp, 'out.css');

try {
  const cli = resolve(root, 'node_modules/.bin/tailwindcss');
  execFileSync(cli, [
    '-c', configPath,
    '-i', inputPath,
    '-o', outPath,
    '--minify',
  ], { stdio: 'inherit', cwd: root });

  const css = readFileSync(outPath, 'utf8').trim();
  const source = readFileSync(scriptPath, 'utf8');

  const startMatch = source.match(START_RE);
  const endMatch = source.match(END_RE);
  if (!startMatch || !endMatch || endMatch.index < startMatch.index) {
    throw new Error(
      `Placeholder markers not found in ${scriptPath}. Expected a line containing only ` +
      `"/* @TAILWIND_CSS_START */" followed later by a line containing only "/* @TAILWIND_CSS_END */".`
    );
  }
  // Reject multi-match ambiguity: if the same marker appears twice on its
  // own line, refuse rather than guess which pair to rewrite.
  const startAll = source.match(new RegExp(START_RE.source, 'gm')) || [];
  const endAll = source.match(new RegExp(END_RE.source, 'gm')) || [];
  if (startAll.length !== 1 || endAll.length !== 1) {
    throw new Error(
      `Expected exactly one START and one END marker line; found ${startAll.length} START and ${endAll.length} END.`
    );
  }

  // Escape for a template-literal embedded in JS: backslashes, backticks, ${ interpolation.
  const escaped = css
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');

  // `startMatch[0]` ends just before the newline after the START marker;
  // `endMatch.index` points at the START of the END marker's leading
  // whitespace. Splitting at these offsets keeps each marker's original
  // indentation, so repeat builds don't drift.
  const startEnd = startMatch.index + startMatch[0].length;
  const before = source.slice(0, startEnd);
  const after = source.slice(endMatch.index);
  const replacement = `\n  const TAILWIND_CSS = \`${escaped}\`;\n`;
  const next = before + replacement + after;

  writeFileSync(scriptPath, next);
  const sizeKb = (Buffer.byteLength(css) / 1024).toFixed(1);
  console.log(`[aicx-build] embedded Tailwind CSS (${sizeKb} KB) into ${scriptPath}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
