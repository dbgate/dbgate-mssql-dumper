/** A resolved `(schemaName, pureName)` pair for a table or view, keyed by `object_id`. */
export interface ObjectRef {
  readonly schemaName: string;
  readonly pureName: string;
}

export function objectRefKey(schemaName: string, pureName: string): string {
  return `${schemaName}.${pureName}`;
}

/** Builds an `object_id -> ObjectRef` lookup from any rows carrying `objectId`/`schemaName`/`pureName`. */
export function buildObjectRefMap<
  T extends { objectId: number; schemaName: string; pureName: string },
>(rows: readonly T[]): Map<number, ObjectRef> {
  return new Map(
    rows.map(row => [row.objectId, { schemaName: row.schemaName, pureName: row.pureName }]),
  );
}

/**
 * Defensively converts a driver-returned value to `bigint`. SQL Server
 * `sql_variant`/`bigint` columns are exposed by different Node.js drivers as
 * a JS `bigint`, a `string` (to avoid silent precision loss), or in some
 * configurations a `number`; introspection needs the full-precision value
 * regardless of which representation a given adapter happens to choose.
 */
export function toBigIntOrNull(value: unknown): bigint | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'number') {
    return BigInt(Math.trunc(value));
  }
  if (typeof value === 'string') {
    return BigInt(value);
  }
  throw new Error(`Cannot convert catalog value to bigint: ${String(value)}`);
}
