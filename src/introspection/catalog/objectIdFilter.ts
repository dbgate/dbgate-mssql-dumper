import type { MssqlQueryParameter } from '../../connection/types.js';

/**
 * Scopes a bulk catalog query to a caller-supplied set of `object_id`
 * values without ever interpolating them into SQL text: the IDs travel as
 * one bound JSON-array parameter and are unpacked server-side with
 * `OPENJSON`. This is what lets every catalog query in this package stay a
 * single bulk statement (`WHERE object_id IN (...)`) instead of either a
 * per-object query loop or an unbounded, unfiltered scan — "bounded bulk",
 * not N+1.
 *
 * `object_id` values are always integers read back from a previous catalog
 * query in this same introspection run, never user-supplied strings, so
 * there is no injection surface here even before parameterization; the
 * `OPENJSON` approach is used anyway because it scales to arbitrarily large
 * ID sets without hitting a SQL text length limit, and because it keeps
 * every catalog query in this package free of ad hoc string-building.
 */
export interface ObjectIdFilter {
  readonly clause: string;
  readonly parameter: MssqlQueryParameter;
}

/**
 * Builds a `column IN (...)` clause plus its bound parameter. Throws if any
 * ID is not a non-negative safe integer, which would indicate a
 * programming error (a real `object_id` is always such an integer) rather
 * than anything resembling untrusted input.
 */
export function objectIdFilter(
  column: string,
  parameterName: string,
  objectIds: readonly number[],
): ObjectIdFilter {
  for (const id of objectIds) {
    if (!Number.isSafeInteger(id) || id < 0) {
      throw new Error(`Invalid object_id in catalog filter: ${String(id)}`);
    }
  }
  return {
    clause: `${column} IN (SELECT CAST(value AS int) FROM OPENJSON(@${parameterName}))`,
    parameter: { name: parameterName, value: JSON.stringify(objectIds), sqlType: 'NVarChar' },
  };
}
