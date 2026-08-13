import type { MssqlObjectKind } from './reference.js';

/**
 * One discovered reference from a view/procedure/function/trigger body to
 * another table/view/routine, from `sys.sql_expression_dependencies`.
 *
 * `isSchemaBoundReference` distinguishes two very different trust levels:
 *
 * - `true` (`WITH SCHEMABINDING`, or a reference SQL Server otherwise
 *   enforces): the referenced object is guaranteed to exist and keep a
 *   compatible shape for as long as the dependent object exists — SQL
 *   Server itself blocks a `DROP`/incompatible `ALTER` of the target. This
 *   is trustworthy enough to be a *hard* archive dependency.
 * - `false` (an ordinary reference): SQL Server does not enforce or
 *   validate it after creation — the referenced object could be renamed,
 *   dropped, or never have existed validly in the first place (dynamic SQL,
 *   a name that only resolves at execution time, ...). This is used only
 *   as an *ordering preference*: a hint for a nicer default order, never a
 *   correctness requirement, and safe to discard if honoring it would
 *   create a cycle.
 */
export interface MssqlObjectDependency {
  readonly fromKind: MssqlObjectKind;
  readonly fromSchemaName: string;
  readonly fromName: string;
  /** Best-effort; `'unknown'` when the referenced object's kind could not be determined. */
  readonly toKind: MssqlObjectKind | 'unknown';
  readonly toSchemaName: string;
  readonly toName: string;
  readonly isSchemaBoundReference: boolean;
}
