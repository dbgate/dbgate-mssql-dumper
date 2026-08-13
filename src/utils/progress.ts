export type DumpProgressPhase =
  | 'connecting'
  | 'detecting-version'
  | 'introspecting'
  | 'planning-archive'
  | 'rendering-schema'
  | 'exporting-data'
  | 'finalizing';

export interface DumpProgressEvent {
  readonly phase: DumpProgressPhase;
  readonly message?: string;
  readonly objectsProcessed?: number;
  readonly objectsTotal?: number;
  /** Bytes written to the output so far, when practical to report (e.g. during `exporting-data`). */
  readonly bytesWritten?: number;
}

export type DumpProgressCallback = (event: DumpProgressEvent) => void;

export type RestoreProgressPhase =
  'connecting' | 'preflight' | 'parsing' | 'executing' | 'finalizing';

export interface RestoreProgressEvent {
  readonly phase: RestoreProgressPhase;
  readonly message?: string;
  readonly statementsProcessed?: number;
  readonly statementsTotal?: number;
}

export type RestoreProgressCallback = (event: RestoreProgressEvent) => void;
