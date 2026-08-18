/**
 * Package smoke test — runs against the BUILT output in `dist/`, not the
 * TypeScript source.
 *
 * Everything else in the test suite imports from `src/`, so nothing else would
 * catch a broken `exports` map, a missing `.d.ts`, a CJS interop failure, or an
 * ESM-only construct leaking into the CommonJS bundle. Those only surface for a
 * real consumer after publishing.
 *
 *   node scripts/smoke.mjs
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

console.log('\n[1] exports map targets exist');
for (const [entry, conditions] of Object.entries(manifest.exports)) {
  for (const [condition, relative] of Object.entries(conditions)) {
    const file = resolve(root, relative);
    check(`${entry} (${condition}) -> ${relative}`, existsSync(file));
  }
}
check('files[] includes dist', (manifest.files ?? []).includes('dist'));
check('engines.node requires >=20', /(^|[^\d])20/.test(manifest.engines?.node ?? ''));
check(
  'tedious is an optional peer dependency',
  manifest.peerDependenciesMeta?.tedious?.optional === true,
);
check('no runtime dependencies', Object.keys(manifest.dependencies ?? {}).length === 0);
check('sideEffects is false', manifest.sideEffects === false);
check('license is set', typeof manifest.license === 'string' && manifest.license.length > 0);
check('repository metadata is set', typeof manifest.repository?.url === 'string');

const CORE_EXPORTS = [
  'dumpMssql',
  'restoreSqlDump',
  'introspectMssql',
  'inspectDumpArchive',
  'renderPlainSql',
  'exportTableDataAsInserts',
  'preflightRestore',
  'isDumperSqlDump',
  'parseSqlBatches',
  'streamSqlBatches',
  'quoteIdentifier',
  'MssqlDumperError',
];
const ADAPTER_EXPORTS = ['fromTediousConnection', 'connectTedious', 'TediousConnectionAdapter'];

console.log('\n[2] ESM consumer');
const esm = await import(pathToFileURL(resolve(root, manifest.exports['.'].import)).href);
for (const name of CORE_EXPORTS) {
  check(`import { ${name} } from 'dbgate-mssql-dumper'`, typeof esm[name] === 'function');
}
const esmAdapter = await import(
  pathToFileURL(resolve(root, manifest.exports['./tedious'].import)).href
);
for (const name of ADAPTER_EXPORTS) {
  check(
    `import { ${name} } from 'dbgate-mssql-dumper/tedious'`,
    typeof esmAdapter[name] === 'function',
  );
}

console.log('\n[3] CommonJS consumer');
const cjs = require(resolve(root, manifest.exports['.'].require));
for (const name of CORE_EXPORTS) {
  check(`require('dbgate-mssql-dumper').${name}`, typeof cjs[name] === 'function');
}
const cjsAdapter = require(resolve(root, manifest.exports['./tedious'].require));
for (const name of ADAPTER_EXPORTS) {
  check(`require('dbgate-mssql-dumper/tedious').${name}`, typeof cjsAdapter[name] === 'function');
}

console.log('\n[4] type declarations');
for (const entry of ['.', './tedious']) {
  const types = resolve(root, manifest.exports[entry].types);
  check(
    `${entry} .d.ts exists and is non-trivial`,
    existsSync(types) && readFileSync(types, 'utf8').length > 500,
  );
}

console.log('\n[5] built artifacts actually work');
// The GO lexer, on the built bundle rather than the source.
const batches = esm.parseSqlBatches("PRINT 'GO';\nGO\nSELECT 1;\nGO\n");
check(
  'parseSqlBatches splits correctly from the ESM bundle',
  batches.length === 2 && batches[0].sql === "PRINT 'GO';" && batches[1].sql === 'SELECT 1;',
  JSON.stringify(batches.map(b => b.sql)),
);
check(
  'parseSqlBatches behaves identically from the CJS bundle',
  JSON.stringify(cjs.parseSqlBatches("PRINT 'GO';\nGO\nSELECT 1;\nGO\n").map(b => b.sql)) ===
    JSON.stringify(batches.map(b => b.sql)),
);
check(
  'quoteIdentifier doubles a closing bracket',
  esm.quoteIdentifier('we]rd') === '[we]]rd]',
  esm.quoteIdentifier('we]rd'),
);
check(
  'isDumperSqlDump recognizes the header',
  esm.isDumperSqlDump('-- dbgate-mssql-dumper plain SQL dump\n') === true,
);
// Renders a dump end to end, with no connection involved, from the built bundle.
const database = {
  databaseName: 'Smoke',
  collationName: null,
  compatibilityLevel: null,
  schemas: [{ schemaName: 'dbo', ownerName: 'dbo' }],
  tables: [
    {
      schemaName: 'dbo',
      pureName: 'T',
      objectId: 1,
      createDate: null,
      modifyDate: null,
      comment: null,
      isMemoryOptimized: false,
      durability: null,
      isSystemVersioned: false,
      historyTableSchemaName: null,
      historyTablePureName: null,
      columns: [
        {
          columnName: 'Id',
          ordinalPosition: 1,
          dataType: 'int',
          maxLength: null,
          characterMaxLength: null,
          precision: null,
          scale: null,
          isNullable: false,
          isIdentity: false,
          identitySeed: null,
          identityIncrement: null,
          isComputed: false,
          computedExpression: null,
          isPersisted: null,
          isSparse: false,
          isRowGuidCol: false,
          collationName: null,
          defaultConstraintName: null,
          defaultExpression: null,
          comment: null,
        },
      ],
    },
  ],
  views: [],
  routines: [],
  triggers: [],
  sequences: [],
  primaryKeys: [],
  uniqueConstraints: [],
  foreignKeys: [],
  checkConstraints: [],
  defaultConstraints: [],
  indexes: [],
};
const archive = esm.inspectDumpArchive(database, { mode: 'schema-only' });
const writer = new esm.StringDumpWriter();
await esm.renderPlainSql({ database, archive, writer });
const rendered = writer.toString();
check(
  'renderPlainSql emits a usable dump from the built bundle',
  rendered.startsWith('-- dbgate-mssql-dumper plain SQL dump') &&
    rendered.includes('CREATE TABLE dbo.T') &&
    rendered.includes('GO'),
);
check('the rendered dump is recognized by its own detector', esm.isDumperSqlDump(rendered));

console.log(
  failures === 0
    ? '\nPackage smoke test passed.\n'
    : `\nPackage smoke test FAILED (${failures} problem(s)).\n`,
);
process.exit(failures === 0 ? 0 : 1);
