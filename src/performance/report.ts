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

function formatPercentage(value: number, total: number): string {
  return total > 0 ? `${((value / total) * 100).toFixed(1)}%` : 'n/a';
}

function createPerformanceReview(report: PerformanceReportData): string[] {
  const review: string[] = [];
  const slowestPhase = report.phases.reduce<(typeof report.phases)[number] | undefined>(
    (slowest, phase) => (!slowest || phase.durationMs > slowest.durationMs ? phase : slowest),
    undefined,
  );
  if (slowestPhase) {
    review.push(
      `- Slowest phase: **${slowestPhase.name}** — ${formatDuration(slowestPhase.durationMs)} (${formatPercentage(slowestPhase.durationMs, report.durationMs)} of total).`,
    );
  }

  const slowestTable = report.tables.reduce<PerformanceTableMetric | undefined>(
    (slowest, table) => (!slowest || table.durationMs > slowest.durationMs ? table : slowest),
    undefined,
  );
  if (slowestTable) {
    const rowsPerSecond =
      slowestTable.durationMs > 0 ? (slowestTable.rows * 1_000) / slowestTable.durationMs : 0;
    const reason = slowestTable.reason ? `, reason: ${slowestTable.reason}` : '';
    review.push(
      `- Slowest table operation: **${escapeMarkdownCell(tableName(slowestTable))}** — ${formatDuration(slowestTable.durationMs)}, ${formatInteger(rowsPerSecond)} rows/s (${slowestTable.mode}${reason}).`,
    );
  }

  const sqlFallbacks = report.tables.filter(table => table.mode === 'sql-fallback');
  if (sqlFallbacks.length > 0) {
    const reasons =
      [...new Set(sqlFallbacks.map(table => table.reason).filter(Boolean))].join(', ') || 'unknown';
    review.push(
      `- SQL fallback was used by ${formatInteger(sqlFallbacks.length)} table operation(s); recorded reason(s): **${escapeMarkdownCell(reasons)}**.`,
    );
  }

  if (report.nativeBulkOperations?.length) {
    const nativePhases = [
      ['create staging', 'createStagingMs'],
      ['bind staging', 'bindStagingMs'],
      ['load staging', 'loadStagingMs'],
      ['copy to target', 'copyToTargetMs'],
      ['drop staging', 'dropStagingMs'],
    ] as const;
    const nativeTotal = report.nativeBulkOperations.reduce(
      (sum, operation) => sum + operation.totalMs,
      0,
    );
    const nativePhaseTotals = nativePhases.map(([name, field]) => ({
      name,
      durationMs: report.nativeBulkOperations!.reduce(
        (sum, operation) => sum + operation[field],
        0,
      ),
    }));
    const slowestNativePhase = nativePhaseTotals.reduce((slowest, phase) =>
      phase.durationMs > slowest.durationMs ? phase : slowest,
    );
    review.push(
      `- Native bulk hot spot: **${slowestNativePhase.name}** — ${formatDuration(slowestNativePhase.durationMs)} (${formatPercentage(slowestNativePhase.durationMs, nativeTotal)} of measured native bulk time).`,
    );
    const arrayBindRows = report.nativeBulkOperations.reduce(
      (sum, operation) => sum + operation.arrayBindRows,
      0,
    );
    if (arrayBindRows > 0) {
      review.push(
        `- Native array-bind safety fallback handled ${formatInteger(arrayBindRows)} row(s).`,
      );
    }
  }

  return review.length > 0 ? review : ['_Not enough timing data for an automatic review._'];
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
    '## Performance review',
    '',
    ...createPerformanceReview(report),
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
      '| Table | Mode | Reason | Rows | Batches | Bytes | Duration | Rows/s |',
      '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |',
      ...report.tables.map(table => {
        const rowsPerSecond = table.durationMs > 0 ? (table.rows * 1_000) / table.durationMs : 0;
        return `| ${escapeMarkdownCell(tableName(table))} | ${escapeMarkdownCell(table.mode)} | ${escapeMarkdownCell(table.reason ?? '')} | ${formatInteger(table.rows)} | ${formatInteger(table.batches)} | ${formatInteger(table.bytes)} | ${formatDuration(table.durationMs)} | ${formatInteger(rowsPerSecond)} |`;
      }),
    );
  }

  lines.push('', '## Native bulk detail', '');
  if (!report.nativeBulkOperations?.length) {
    lines.push('_No native bulk timing was recorded._');
  } else {
    lines.push(
      '| Table | Rows | Chunks | BCP rows | Array-bind rows | Empty-string rows | Create | Bind | Load | Copy | Drop | Total | Result |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
      ...report.nativeBulkOperations.map(
        operation =>
          `| ${escapeMarkdownCell(`${operation.schemaName}.${operation.tableName}`)} | ${formatInteger(operation.rows)} | ${formatInteger(operation.chunks)} | ${formatInteger(operation.bcpRows)} | ${formatInteger(operation.arrayBindRows)} | ${formatInteger(operation.repairedEmptyStringRows)} | ${formatDuration(operation.createStagingMs)} | ${formatDuration(operation.bindStagingMs)} | ${formatDuration(operation.loadStagingMs)} | ${formatDuration(operation.copyToTargetMs)} | ${formatDuration(operation.dropStagingMs)} | ${formatDuration(operation.totalMs)} | ${operation.succeeded ? 'succeeded' : 'failed'} |`,
      ),
    );
  }

  lines.push('', '## Machine-readable data (TOON)', '', '```toon', encode(report), '```', '');
  return lines.join('\n');
}
