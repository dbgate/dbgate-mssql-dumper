import { createHash } from 'node:crypto';

/**
 * Builds a canonical, collision-resistant identity string from ordered
 * length-prefixed parts, so that (for example) `["ab", "c"]` and `["a", "bc"]`
 * never collide. Used as the input to {@link createDumpId}.
 */
export function createCanonicalIdentity(parts: readonly (string | number)[]): string {
  return parts
    .map(part => {
      const text = String(part);
      return `${text.length}:${text}`;
    })
    .join('|');
}

/** Derives a short, stable, deterministic ID from a canonical identity string. */
export function createDumpId(canonicalIdentity: string): string {
  return createHash('sha256').update(canonicalIdentity, 'utf8').digest('hex').slice(0, 16);
}
