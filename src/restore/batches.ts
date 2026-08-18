const DUMP_HEADER_PREFIX = '-- dbgate-mssql-dumper plain SQL dump';

/** Heuristically detects whether `sample` looks like a dump produced by {@link renderPlainSql}. */
export function isDumperSqlDump(sample: string | Uint8Array): boolean {
  const text = typeof sample === 'string' ? sample : Buffer.from(sample).toString('utf8');
  return text.trimStart().startsWith(DUMP_HEADER_PREFIX);
}

/**
 * Redacts the value side of common secret-carrying T-SQL clauses
 * (`PASSWORD = '...'`, `IDENTIFIED BY '...'`) so a failing batch that
 * happens to be a `CREATE LOGIN`/`ALTER LOGIN`/similar statement never
 * echoes the actual secret back into a preview, diagnostic, or error
 * message. Deliberately narrow (pattern-based, not a parser): it protects
 * the specific clauses SQL Server itself uses for credentials, not
 * arbitrary "looks sensitive" text.
 */
const SQL_SECRET_PATTERNS: readonly RegExp[] = [
  /((?:PASSWORD|PWD|SECRET|KEY_SOURCE)\s*=\s*)N?'(?:[^']|'')*'/gi,
  /(IDENTIFIED\s+BY\s+)N?'(?:[^']|'')*'/gi,
  // Scripted logins carry the password as a binary literal
  // (`WITH PASSWORD = 0x0200A1B2... HASHED`), and `CREATE CREDENTIAL` /
  // `CREATE DATABASE SCOPED CREDENTIAL` carry a SAS token or key in
  // `SECRET =`. Both are SQL Server's own credential syntax, so both belong
  // in the same closed set as the quoted forms above.
  /((?:PASSWORD|PWD|SECRET|KEY_SOURCE)\s*=\s*)0x[0-9A-Fa-f]+/gi,
];

/**
 * Redacts the value side of the secret-carrying clauses {@link SQL_SECRET_PATTERNS}
 * matches. Exported separately from {@link safeSqlPreview} so it can also be
 * applied to a driver error *message* — some drivers echo the failing
 * statement text back in their error message, not just in the SQL itself.
 */
export function redactSecrets(text: string): string {
  return SQL_SECRET_PATTERNS.reduce(
    (result, pattern) =>
      result.replace(pattern, (_match, prefix: string) => `${prefix}'***REDACTED***'`),
    text,
  );
}

/** Truncates SQL text for inclusion in error messages, never a full potentially large statement, and never a literal password/credential value. */
export function safeSqlPreview(sql: string, maximumLength = 200): string {
  const normalized = redactSecrets(sql).trim().replace(/\s+/g, ' ');
  if (normalized.length <= maximumLength) {
    return normalized;
  }
  let cut = normalized.slice(0, maximumLength);
  // Never split a surrogate pair: an emoji or other astral-plane character
  // straddling the cut would leave a lone high surrogate, making the preview
  // ill-formed UTF-16 — `JSON.stringify` would emit an unpaired `\ud83d` and
  // writing it as UTF-8 would substitute U+FFFD.
  const lastUnit = cut.charCodeAt(cut.length - 1);
  if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) {
    cut = cut.slice(0, -1);
  }
  return `${cut}…`;
}
