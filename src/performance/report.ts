import { encode } from '@toon-format/toon';
import type { PerformanceReportData, PerformanceTableMetric } from './types.js';

function formatInteger(value: number | undefined): string {
  return value == null ? 'n/a' : Math.round(value).toLocaleString('en-US');
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.round(durationMs)} ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(2)} s`;
  const minutes = Math.floor(durationMs / 60_000);
  return `${minutes}m ${((durationMs % 60_000) / 1_000).toFixed(1)}s`;
}

function escapeMarkdownCell(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('|', '\\|')
    .replaceAll('\r', ' ')
    .replaceAll('\n', ' ');
}

function tableName(table: PerformanceTableMetric): string {
  return `${table.schemaName}.${table.tableName}`;
}

/**
 * Creates a self-contained, human-readable Markdown report with a lossless
 * TOON payload for automated/LLM analysis. The input type deliberately has no
 * SQL text, row values, credentials, host name, or connection string fields.
 */
export function createPerformanceReportMarkdown(report: PerformanceReportData): string {
  const lines = [
    `# SQL Server ${report.operation} performance report`,
    '',
    '> Debug performance artifact. It contains timings, counters, engine and database/object names; it does not contain SQL text, row values, credentials, host names, or connection strings.',
    '',
    '## Summary',
    '',
    '| Metric | Value |',
    '| --- | ---: |',
    `| Status | ${report.status} |`,
    `| Started | ${report.startedAt} |`,
    `| Finished | ${report.finishedAt} |`,
    `| Duration | ${formatDuration(report.durationMs)} |`,
    `| Database | ${escapeMarkdownCell(report.database ?? 'n/a')} |`,
    `| Engine | ${escapeMarkdownCell(report.engine ?? 'n/a')} |`,
    `| Rows | ${formatInteger(report.rows)} |`,
    `| Batches | ${formatInteger(report.batches)} |`,
    `| Input bytes | ${formatInteger(report.inputBytes)} |`,
    `| Output bytes | ${formatInteger(report.outputBytes)} |`,
    `| Warnings | ${formatInteger(report.warnings)} |`,
    `| Errors | ${formatInteger(report.errors)} |`,
    '',
    '## Phase timings',
    '',
    '| Phase | Duration |',
    '| --- | ---: |',
    ...report.phases.map(
      phase => `| ${escapeMarkdownCell(phase.name)} | ${formatDuration(phase.durationMs)} |`,
    ),
    '',
    '## Table timings',
    '',
  ];

  if (report.tables.length === 0) {
    lines.push('_No table-level operation was observed._');
  } else {
    lines.push(
      '| Table | Mode | Rows | Batches | Bytes | Duration | Rows/s |',
      '| --- | --- | ---: | ---: | ---: | ---: | ---: |',
      ...report.tables.map(table => {
        const rowsPerSecond = table.durationMs > 0 ? (table.rows * 1_000) / table.durationMs : 0;
        return `| ${escapeMarkdownCell(tableName(table))} | ${escapeMarkdownCell(table.mode)} | ${formatInteger(table.rows)} | ${formatInteger(table.batches)} | ${formatInteger(table.bytes)} | ${formatDuration(table.durationMs)} | ${formatInteger(rowsPerSecond)} |`;
      }),
    );
  }

  lines.push('', '## Machine-readable data (TOON)', '', '```toon', encode(report), '```', '');
  return lines.join('\n');
}
