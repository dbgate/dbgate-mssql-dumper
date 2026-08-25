import { describe, expect, it } from 'vitest';
import { createPerformanceReportMarkdown } from '../src/performance/report.js';

describe('createPerformanceReportMarkdown', () => {
  it('renders a readable summary and a TOON payload without operational secrets', () => {
    const markdown = createPerformanceReportMarkdown({
      formatVersion: 1,
      operation: 'restore',
      status: 'succeeded',
      startedAt: '2026-08-25T10:00:00.000Z',
      finishedAt: '2026-08-25T10:00:10.000Z',
      durationMs: 10_000,
      database: 'dump4',
      engine: 'tedious',
      inputBytes: 12_345,
      rows: 40_000,
      batches: 4,
      warnings: 0,
      errors: 0,
      phases: [{ name: 'executing', durationMs: 9_000 }],
      tables: [
        {
          schemaName: 'dbo',
          tableName: 'download',
          mode: 'bulk-insert',
          reason: 'native-bulk',
          rows: 40_000,
          batches: 4,
          durationMs: 8_000,
        },
      ],
      nativeBulkOperations: [
        {
          schemaName: 'dbo',
          tableName: 'download',
          rows: 40_000,
          chunks: 4,
          bcpRows: 40_000,
          arrayBindRows: 0,
          repairedEmptyStringRows: 12,
          createStagingMs: 100,
          bindStagingMs: 50,
          loadStagingMs: 4_000,
          copyToTargetMs: 500,
          dropStagingMs: 50,
          totalMs: 4_700,
          succeeded: true,
        },
      ],
    });

    expect(markdown).toContain('# SQL Server restore performance report');
    expect(markdown).toContain('## Performance review');
    expect(markdown).toContain('Slowest phase: **executing**');
    expect(markdown).toContain('Slowest table operation: **dbo.download**');
    expect(markdown).toContain('Native bulk hot spot: **load staging**');
    expect(markdown).toContain('| dbo.download | bulk-insert | native-bulk | 40,000 | 4 |');
    expect(markdown).toContain('## Native bulk detail');
    expect(markdown).toContain('| dbo.download | 40,000 | 4 | 40,000 | 0 | 12 |');
    expect(markdown).toContain('```toon');
    expect(markdown).toContain(
      'tables[1]{schemaName,tableName,mode,reason,rows,batches,durationMs}',
    );
    expect(markdown).toContain('nativeBulkOperations[1]');
    expect(markdown).not.toContain('password');
    expect(markdown).not.toContain('connectionString');
  });
});
