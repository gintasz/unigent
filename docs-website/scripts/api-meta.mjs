// Post-process the TypeDoc-generated API markdown for Fumadocs.
// TypeDoc (typedoc-plugin-markdown) emits plain markdown with an H1 but no
// frontmatter; Fumadocs requires a `title`. This walks the generated tree and
// prepends frontmatter derived from each file's first heading, then writes the
// folder `meta.json`. Runs after `typedoc` (which cleans the output dir first).
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const apiDir = join(process.cwd(), 'content/docs/api');

/** Turn an H1 like "Function: runProgram()" into a clean page title. */
function cleanTitle(heading) {
  return heading
    .replace(/^(Function|Class|Interface|Type Alias|Variable|Enumeration|Namespace):\s*/, '')
    .replace(/\\<.*$/, '') // drop escaped generic params, e.g. Program\<S\>
    .replace(/\(\)$/, '')
    .trim();
}

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full);
      continue;
    }
    if (!entry.endsWith('.md')) continue;

    const raw = readFileSync(full, 'utf8');
    if (raw.startsWith('---')) continue; // already has frontmatter

    const headingMatch = raw.match(/^#\s+(.+?)\s*$/m);
    const isIndex = entry === 'index.md';
    const title = isIndex
      ? '@microfoom/core'
      : headingMatch
        ? cleanTitle(headingMatch[1])
        : entry.replace(/\.md$/, '');

    const fm = `---\ntitle: ${JSON.stringify(title)}\n---\n\n`;
    writeFileSync(full, fm + raw);
  }
}

walk(apiDir);

writeFileSync(
  join(apiDir, 'meta.json'),
  `${JSON.stringify(
    {
      title: 'API reference',
      description: 'Generated from the source — the same docs your editor shows on hover.',
    },
    null,
    2,
  )}\n`,
);
