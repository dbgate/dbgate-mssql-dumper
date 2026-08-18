/** 1-based line range a parsed batch's SQL text occupies in its source. */
export interface BatchSourceLocation {
  readonly startLine: number;
  readonly endLine: number;
}
