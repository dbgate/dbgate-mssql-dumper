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
          rows: 40_000,
          batches: 4,
          durationMs: 8_000,
        },
      ],
    });

    expect(markdown).toContain('# SQL Server restore performance report');
    expect(markdown).toContain('| dbo.download | bulk-insert | 40,000 | 4 |');
    expect(markdown).toContain('```toon');
    expect(markdown).toContain('tables[1]{schemaName,tableName,mode,rows,batches,durationMs}');
    expect(markdown).not.toContain('password');
    expect(markdown).not.toContain('connectionString');
  });
});
