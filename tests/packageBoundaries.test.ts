/**
 * Build-time protection for two structural guarantees this package makes:
 *
 *  1. It is standalone — no DbGate runtime dependency of any kind.
 *  2. `tedious` is genuinely optional — the core entry point's transitive
 *     import graph never reaches it, so importing `dbgate-mssql-dumper` alone
 *     cannot fail or pull a driver into a bundle.
 *
 * Both are easy to break accidentally with a single convenience import, and
 * neither is visible in any behavioural test, so they are asserted directly
 * against the source tree.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(import.meta.dirname, '..', 'src');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap(entry => {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      return sourceFiles(full);
    }
    return full.endsWith('.ts') ? [full] : [];
  });
}

/** Every module specifier imported (or re-exported) by a source file. */
function importedSpecifiers(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const specifiers: string[] = [];
  const pattern = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g;
  for (const match of text.matchAll(pattern)) {
    specifiers.push(match[1]!);
  }
  // Bare side-effect imports and dynamic imports.
  for (const match of text.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g)) {
    specifiers.push(match[1]!);
  }
  for (const match of text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    specifiers.push(match[1]!);
  }
  for (const match of text.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    specifiers.push(match[1]!);
  }
  return specifiers;
}

describe('no DbGate runtime dependency', () => {
  const FORBIDDEN = [
    'dbgate',
    'dbgate-tools',
    'dbgate-types',
    'dbgate-datalib',
    'dbgate-query-splitter',
    'dbgate-plugin-mssql',
    'dbgate-plugin-tools',
  ];

  it('imports nothing from any DbGate package', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      for (const specifier of importedSpecifiers(file)) {
        // Only a bare specifier is a package import; relative paths are ours.
        if (specifier.startsWith('.') || specifier.startsWith('node:')) {
          continue;
        }
        const packageName = specifier.startsWith('@')
          ? specifier.split('/').slice(0, 2).join('/')
          : specifier.split('/')[0]!;
        if (FORBIDDEN.includes(packageName)) {
          offenders.push(`${file}: ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never reads a DbGate global', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8');
      if (/DBGATE_PACKAGES|global\.DBGATE|globalThis\.DBGATE/.test(text)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('declares no runtime dependencies at all', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '..', 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    expect(manifest.dependencies ?? {}).toEqual({});
  });
});

describe('tedious stays optional', () => {
  /** Resolves a relative `.js` specifier back to its `.ts` source file. */
  function resolveLocal(fromFile: string, specifier: string): string | null {
    const candidate = resolve(dirname(fromFile), specifier).replace(/\.js$/, '.ts');
    try {
      return statSync(candidate).isFile() ? candidate : null;
    } catch {
      return null;
    }
  }

  it('is unreachable from the core entry point', () => {
    // A single convenience import anywhere under src/ (outside src/tedious.ts)
    // would silently make the driver mandatory for every consumer.
    const entry = join(SRC, 'index.ts');
    const seen = new Set<string>();
    const queue = [entry];
    const pathTo = new Map<string, string>([[entry, 'src/index.ts']]);

    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);

      for (const specifier of importedSpecifiers(file)) {
        if (specifier === 'tedious' || specifier.startsWith('tedious/')) {
          throw new Error(
            `"tedious" is reachable from the core entry point via ${pathTo.get(file)} -> ${specifier}`,
          );
        }
        const local = resolveLocal(file, specifier);
        if (local && !seen.has(local)) {
          pathTo.set(local, `${pathTo.get(file)} -> ${specifier}`);
          queue.push(local);
        }
      }
    }

    // Sanity: the walk really did traverse the package, not stop at the entry.
    expect(seen.size).toBeGreaterThan(20);
  });

  it('is imported only by the dedicated adapter module', () => {
    const importers = sourceFiles(SRC).filter(file =>
      importedSpecifiers(file).some(
        specifier => specifier === 'tedious' || specifier.startsWith('tedious/'),
      ),
    );
    expect(importers.map(file => file.slice(SRC.length + 1).replace(/\\/g, '/'))).toEqual([
      'tedious.ts',
    ]);
  });
});
