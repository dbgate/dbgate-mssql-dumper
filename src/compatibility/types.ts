import type { MssqlObjectReference } from '../model/reference.js';
import type { SourceCapabilities } from '../version/types.js';

/**
 * A restore target's capabilities are the same shape as a source's
 * structural capabilities (see `version/capabilities.ts`), but the two are
 * kept as distinct concepts: a source's capabilities describe what its
 * catalog may contain, while a target's describe what it can accept during
 * restore. They happen to share a derivation function today because both
 * are pure functions of {@link MssqlVersion}.
 */
export type TargetCapabilities = SourceCapabilities;

export interface RequiredFeatureCheck {
  readonly feature: keyof SourceCapabilities;
  readonly objectReference?: MssqlObjectReference;
}
