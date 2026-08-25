export type PerformanceOperation = 'dump' | 'restore';
export type PerformanceStatus = 'succeeded' | 'failed' | 'cancelled';

export interface PerformancePhaseMetric {
  readonly name: string;
  readonly durationMs: number;
}

export interface PerformanceTableMetric {
  readonly schemaName: string;
  readonly tableName: string;
  readonly mode: string;
  readonly rows: number;
  readonly durationMs: number;
  readonly batches?: number;
  readonly bytes?: number;
}

export interface PerformanceReportData {
  readonly formatVersion: 1;
  readonly operation: PerformanceOperation;
  readonly status: PerformanceStatus;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly database?: string;
  readonly engine?: string;
  readonly inputBytes?: number;
  readonly outputBytes?: number;
  readonly rows?: number;
  readonly batches?: number;
  readonly warnings?: number;
  readonly errors?: number;
  readonly phases: readonly PerformancePhaseMetric[];
  readonly tables: readonly PerformanceTableMetric[];
}
