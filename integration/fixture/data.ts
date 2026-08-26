/**
 * Row data for the fixture database, as individual T-SQL batches.
 *
 * Values are chosen to stress serialization: embedded single quotes,
 * CR/LF-bearing multiline text, Unicode including astral-plane emoji and a
 * ZWJ sequence, binary with embedded zero bytes, the exact boundary values of
 * every integer type, and a non-UTC `datetimeoffset`.
 *
 * Everything in the tables compared strictly (`AllTypes`, `Customers`,
 * `Orders`, ...) is chosen to be exactly round-trippable through the Tedious
 * driver, so a comparison failure means a real bug in this package. Values
 * that the driver itself cannot carry losslessly — currently a
 * `datetimeoffset`'s original display offset — live in `dbo.PrecisionLimits`,
 * which the round-trip comparison excludes and a dedicated test asserts on
 * explicitly.
 */

/** Explicit identity values, including a deliberate gap, so identity preservation is verifiable. */
export const SOURCE_DATA_BATCHES: readonly string[] = [
  // ------------------------------------------------------------- Customers
  `set identity_insert [sales].[Customers] on;
insert into [sales].[Customers]
  ([CustomerId], [Name], [Code], [Email], [Balance], [CreatedAt], [IsActive])
values
  (1, N'O''Brien & Sons', 'C-001', N'obrien@example.com', 1234.5678, '2023-01-15T10:20:30.1234567', 1),
  (2, N'Ünïcødé 北京 🚀 café', null, N'unicode@example.com', -99.9999, '2024-02-29T23:59:59.9999999', 0),
  (3, N'line one
line two
line three', 'C-003', null, 0, '2020-06-30T00:00:00.0000000', 1),
  (100, N'Gap Customer 👨‍👩‍👧‍👦', 'C-100', N'gap@example.com', 42.0001, '2021-12-31T12:00:00.0000001', 1);
set identity_insert [sales].[Customers] off;`,

  // ---------------------------------------------------------------- Orders
  // Inserting these fires trOrdersAudit, which populates OrderAudit.
  `set identity_insert [sales].[Orders] on;
insert into [sales].[Orders]
  ([OrderId], [CustomerId], [ParentOrderId], [OrderDate], [Total], [Notes], [Status])
values
  (10, 1, null, '2023-02-01', 100.0000, N'first order', 'new'),
  (11, 1, 10, '2023-02-02', 250.5000, N'child of 10; note the '' quote', 'shipped'),
  (12, 2, null, '2024-03-15', 0.0000, null, 'new'),
  (13, 100, 12, '2021-12-31', 999999999.9999, N'big total', 'closed');
set identity_insert [sales].[Orders] off;`,

  // --------------------------------------------------------------- AllTypes
  // Row 1: typical values across every type.
  `set identity_insert [dbo].[AllTypes] on;
insert into [dbo].[AllTypes]
  ([Id], [ColBit], [ColTinyInt], [ColSmallInt], [ColInt], [ColBigInt],
   [ColDecimal], [ColNumeric], [ColMoney], [ColSmallMoney], [ColFloat], [ColReal],
   [ColChar], [ColVarChar], [ColVarCharMax], [ColNChar], [ColNVarChar], [ColNVarCharMax],
   [ColBinary], [ColVarBinary], [ColVarBinaryMax], [ColGuid],
   [ColDate], [ColTime], [ColSmallDateTime], [ColDateTime], [ColDateTime2], [ColDateTimeOffset])
values
  (1, 1, 200, 12345, 987654, 1234567890123,
   12345.6789, 123456.789012, 12345.6789, -214.7483, 0.1, 3.5,
   'abc', 'plain ascii', 'varchar(max) value with '' quote',
   N'nchar', N'Ünïcødé 🚀', N'nvarchar(max): 北京 café 🚀 with '' quote and
a second line',
   0x0001ff00deadbeef, 0x00, 0xcafebabe0011ff,
   '6F9619FF-8B86-D011-B42D-00C04FC964FF',
   '2023-03-14', '15:09:26.5359876', '2023-03-14T15:09:00',
   '2023-03-14T15:09:26.533', '2023-03-14T15:09:26.5359876',
   '2023-03-14T15:09:26.5359876+02:00');`,

  // Row 2: boundary values of every integer type, plus double extremes.
  `insert into [dbo].[AllTypes]
  ([Id], [ColBit], [ColTinyInt], [ColSmallInt], [ColInt], [ColBigInt],
   [ColDecimal], [ColNumeric], [ColMoney], [ColSmallMoney], [ColFloat], [ColReal],
   [ColChar], [ColVarChar], [ColNVarChar],
   [ColBinary], [ColVarBinary], [ColGuid],
   [ColDate], [ColTime], [ColSmallDateTime], [ColDateTime], [ColDateTime2], [ColDateTimeOffset])
values
  (2, 0, 0, -32768, -2147483648, -9223372036854775808,
   -1234567.8901, -123456.789012, -12345.6789, -214748.3647,
   1.7976931348623157E+308, 1.17549435E-38,
   '', '', N'',
   0x0000000000000000, 0x, '00000000-0000-0000-0000-000000000000',
   '0001-01-01', '00:00:00.0000000', '1900-01-01T00:00:00',
   '1753-01-01T00:00:00.000', '0001-01-01T00:00:00.0000000',
   '0001-01-01T00:00:00.0000000-05:30');`,

  `insert into [dbo].[AllTypes]
  ([Id], [ColBit], [ColTinyInt], [ColSmallInt], [ColInt], [ColBigInt],
   [ColDecimal], [ColNumeric], [ColMoney], [ColSmallMoney], [ColFloat], [ColReal],
   [ColDate], [ColTime], [ColSmallDateTime], [ColDateTime], [ColDateTime2], [ColDateTimeOffset])
values
  (3, 1, 255, 32767, 2147483647, 9223372036854775807,
   987654321.12345, 654321.123456, 12345.6789, 214748.3647,
   2.2250738585072014E-308, 3.4028234663852886E+38,
   '9999-12-31', '23:59:59.9999999', '2079-06-06T23:59:00',
   '9999-12-31T23:59:59.997', '9999-12-31T23:59:59.9999999',
   '9999-12-31T23:59:59.9999999+00:00');`,

  // Row 4: every nullable column NULL.
  `insert into [dbo].[AllTypes] ([Id], [ColInt]) values (4, null);
set identity_insert [dbo].[AllTypes] off;`,

  // -------------------------------------------------------------- LegacyLobs
  `insert into [dbo].[LegacyLobs] ([Id], [ColText], [ColNText], [ColImage])
values
  (1, 'legacy text with '' quote', N'legacy ntext: Ünïcødé 🚀', 0x00ff00ff),
  (2, null, null, null);`,

  // ---------------------------------------------------------- PrecisionLimits
  // Exact numerics deliberately exceed IEEE-754 precision; the exporter must
  // read them as text before they enter the driver. The datetimeoffset display
  // offset remains a documented driver limitation.
  `insert into [dbo].[PrecisionLimits] ([Id], [HugeDecimal], [MaxMoney], [OffsetPlus], [OffsetMinus])
values
  (1, 1234567890123456789012345678.1234567890, 92233720368547.5807,
   '2023-06-15T12:00:00.0000000+05:45', '2023-06-15T12:00:00.0000000-08:00');`,

  // ------------------------------------------------------- mutual references
  `insert into [dbo].[MutualA] ([Id], [BId]) values (1, null), (2, null);`,
  `insert into [dbo].[MutualB] ([Id], [AId]) values (1, 1), (2, 2);`,
  `update [dbo].[MutualA] set [BId] = 1 where [Id] = 1;
update [dbo].[MutualA] set [BId] = 2 where [Id] = 2;`,

  // ---------------------------------------------------- difficult identifiers
  `insert into [weird schema].[Table With Spaces] ([Id], [Col]]Bracket], [Ünïcødé Column 🚀], [order])
values
  (1, N'value containing ] and ]] brackets', N'emoji 🚀 and 北京', 42),
  (2, null, null, null);`,

  `insert into [select].[from] ([where], [group], [table])
values (1, N'reserved ''group'' value', 2), (3, null, null);`,

  `insert into [Ünïcødé].[Zákazník] ([Ïd], [Jméno], [北京])
values (1, N'Žluťoučký kůň', N'北京欢迎你'), (2, null, null);`,

  // N-prefixed on the way in too, or the source itself would store '??????'.
  `insert into [dbo].[Collations] ([Id], [CyrillicVarchar], [GreekChar], [DefaultVarchar])
values
  (1, N'Привет мир', N'Καλημέρα', 'plain ascii'),
  (2, null, null, null);`,

  // ------------------------------------------------------------- BigTable
  // Set-based so seeding thousands of rows stays fast. Payload carries a
  // quote, Unicode and an emoji on every one of the rows, so the streaming
  // export path escapes non-trivial text thousands of times.
  `insert into [dbo].[BigTable] ([Payload], [Num], [Flag])
select top (5000)
  concat(N'row ', cast(row_number() over (order by (select null)) as nvarchar(20)),
         N' — Ünïcødé 🚀 ''quoted'''),
  cast(cast(row_number() over (order by (select null)) as decimal(18,4)) / 7.0 as decimal(18,4)),
  case when row_number() over (order by (select null)) % 2 = 0 then 1 else 0 end
from sys.all_objects a cross join sys.all_objects b;`,
];

/** Tables compared strictly by the round-trip suite, in a stable order. */
export const STRICTLY_COMPARED_TABLES: readonly { schemaName: string; pureName: string }[] = [
  { schemaName: 'dbo', pureName: 'AllTypes' },
  { schemaName: 'dbo', pureName: 'BigTable' },
  { schemaName: 'dbo', pureName: 'Collations' },
  { schemaName: 'dbo', pureName: 'LegacyLobs' },
  { schemaName: 'dbo', pureName: 'MutualA' },
  { schemaName: 'dbo', pureName: 'MutualB' },
  { schemaName: 'sales', pureName: 'Customers' },
  { schemaName: 'sales', pureName: 'OrderAudit' },
  { schemaName: 'sales', pureName: 'Orders' },
  { schemaName: 'select', pureName: 'from' },
  { schemaName: 'weird schema', pureName: 'Table With Spaces' },
  { schemaName: 'Ünïcødé', pureName: 'Zákazník' },
];

/** Excluded from strict comparison: holds values the driver cannot carry losslessly. */
export const KNOWN_LIMITATION_TABLE = { schemaName: 'dbo', pureName: 'PrecisionLimits' } as const;

export const BIG_TABLE_ROW_COUNT = 5000;
