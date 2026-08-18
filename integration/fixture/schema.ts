/**
 * DDL for the representative fixture database, as an ordered list of
 * individual T-SQL batches (one batch per array element — no `GO` parsing is
 * involved in creating the fixture; see `execBatches`).
 *
 * The fixture deliberately covers every object kind and column type this
 * package claims to support, plus the identifier and value shapes most likely
 * to break quoting, escaping, batch splitting, or ordering:
 *
 *  - schemas: ordinary, Unicode, embedded space, reserved word
 *  - identifiers: spaces, an embedded `]`, Unicode + astral-plane (emoji),
 *    reserved words
 *  - every common numeric/string/binary/date-time type, plus computed
 *    columns, identity, named and unnamed default constraints, rowversion
 *  - PK / unique constraint / check constraint / FK with CASCADE /
 *    self-referencing FK / mutually referencing FKs
 *  - clustered, nonclustered, unique, composite, descending, INCLUDE and
 *    filtered indexes
 *  - sequences (explicit and defaulted cache)
 *  - view, view depending on a view, scalar function, schema-bound scalar
 *    function, inline table-valued function, procedure, trigger
 *  - a procedure whose body contains standalone `GO` lines inside a string
 *    and inside a block comment, which a naive batch splitter would tear in
 *    half on restore
 */

export const SOURCE_SCHEMA_BATCHES: readonly string[] = [
  // ---------------------------------------------------------------- schemas
  `create schema [sales] authorization [dbo];`,
  `create schema [Ünïcødé] authorization [dbo];`,
  `create schema [weird schema] authorization [dbo];`,
  `create schema [select] authorization [dbo];`,

  // ----------------------------------------------------------------- tables
  // Identity + PK + unique constraint + check constraint + named default +
  // deliberately unnamed default + rowversion.
  `create table [sales].[Customers] (
  [CustomerId] int identity(1,1) not null,
  [Name] nvarchar(200) not null,
  [Code] varchar(20) null,
  [Email] nvarchar(256) null,
  [Balance] decimal(19,4) not null constraint [DF_Customers_Balance] default (0),
  [CreatedAt] datetime2(7) not null constraint [DF_Customers_CreatedAt] default (sysutcdatetime()),
  [IsActive] bit not null default (1),
  [RowVer] rowversion not null,
  constraint [PK_Customers] primary key clustered ([CustomerId]),
  constraint [UQ_Customers_Email] unique nonclustered ([Email]),
  constraint [CK_Customers_Name] check (len([Name]) > 0)
);`,

  // Computed (persisted and not), FK targets, indexes below.
  `create table [sales].[Orders] (
  [OrderId] int identity(1,1) not null,
  [CustomerId] int not null,
  [ParentOrderId] int null,
  [OrderDate] date not null,
  [Total] decimal(19,4) not null,
  [Notes] nvarchar(max) null,
  [Status] varchar(20) not null constraint [DF_Orders_Status] default ('new'),
  [LineTotal] as ([Total] * 1.1),
  [TotalRounded] as (round([Total], 0)) persisted,
  constraint [PK_Orders] primary key clustered ([OrderId]),
  constraint [CK_Orders_Total] check ([Total] >= 0)
);`,

  // Written to by the trigger below. Its row count is what proves the
  // trigger does NOT re-fire while table data is being restored.
  `create table [sales].[OrderAudit] (
  [AuditId] int identity(1,1) not null,
  [OrderId] int not null,
  [Note] nvarchar(100) null,
  constraint [PK_OrderAudit] primary key clustered ([AuditId])
);`,

  // Every common data type, including computed columns over them.
  `create table [dbo].[AllTypes] (
  [Id] int identity(1,1) not null constraint [PK_AllTypes] primary key clustered,
  [ColBit] bit null,
  [ColTinyInt] tinyint null,
  [ColSmallInt] smallint null,
  [ColInt] int null,
  [ColBigInt] bigint null,
  [ColDecimal] decimal(38,10) null,
  [ColNumeric] numeric(18,6) null,
  [ColMoney] money null,
  [ColSmallMoney] smallmoney null,
  [ColFloat] float null,
  [ColReal] real null,
  [ColChar] char(10) null,
  [ColVarChar] varchar(100) null,
  [ColVarCharMax] varchar(max) null,
  [ColNChar] nchar(10) null,
  [ColNVarChar] nvarchar(100) null,
  [ColNVarCharMax] nvarchar(max) null,
  [ColBinary] binary(8) null,
  [ColVarBinary] varbinary(100) null,
  [ColVarBinaryMax] varbinary(max) null,
  [ColGuid] uniqueidentifier null,
  [ColDate] date null,
  [ColTime] time(7) null,
  [ColSmallDateTime] smalldatetime null,
  [ColDateTime] datetime null,
  [ColDateTime2] datetime2(7) null,
  [ColDateTimeOffset] datetimeoffset(7) null,
  -- Cast to bigint so the boundary rows (ColInt = ±2147483647) do not
  -- overflow when the expression is evaluated.
  [ColComputedDouble] as (cast([ColInt] as bigint) * 2),
  [ColComputedPersisted] as (cast(isnull([ColInt], 0) as bigint) + 1) persisted,
  [ColRowVer] rowversion not null
);`,

  // Deprecated LOB types, isolated so a problem here cannot destabilize the
  // main type coverage above.
  `create table [dbo].[LegacyLobs] (
  [Id] int not null constraint [PK_LegacyLobs] primary key clustered,
  [ColText] text null,
  [ColNText] ntext null,
  [ColImage] image null
);`,

  // Values whose exact round-trip is limited by the driver, kept apart from
  // the strict comparison set and asserted explicitly instead.
  `create table [dbo].[PrecisionLimits] (
  [Id] int not null constraint [PK_PrecisionLimits] primary key clustered,
  [HugeDecimal] decimal(38,10) null,
  [MaxMoney] money null,
  [OffsetPlus] datetimeoffset(7) null,
  [OffsetMinus] datetimeoffset(7) null
);`,

  // Mutually referencing tables (both FK columns nullable so rows can exist).
  `create table [dbo].[MutualA] (
  [Id] int not null constraint [PK_MutualA] primary key clustered,
  [BId] int null
);`,
  `create table [dbo].[MutualB] (
  [Id] int not null constraint [PK_MutualB] primary key clustered,
  [AId] int null
);`,

  // Difficult identifiers: space in schema and table, embedded `]`, Unicode
  // with an astral-plane emoji, reserved word.
  `create table [weird schema].[Table With Spaces] (
  [Id] int not null constraint [PK_Table With Spaces] primary key clustered,
  [Col]]Bracket] nvarchar(50) null,
  [Ünïcødé Column 🚀] nvarchar(50) null,
  [order] int null
);`,

  // Reserved words as schema, table and column names.
  `create table [select].[from] (
  [where] int not null constraint [PK_from] primary key clustered,
  [group] nvarchar(50) null,
  [table] int null
);`,

  // Unicode schema, table and column names.
  `create table [Ünïcødé].[Zákazník] (
  [Ïd] int not null constraint [PK_Zákazník] primary key clustered,
  [Jméno] nvarchar(100) null,
  [北京] nvarchar(100) null
);`,

  // Untrusted and disabled constraint/index states. Restoring any of these as
  // *enabled* would silently change what the database enforces, so the
  // round-trip comparison covers `isNotTrusted`/`isDisabled` here.
  `create table [dbo].[ConstraintStates] (
  [Id] int not null constraint [PK_ConstraintStates] primary key clustered,
  [ParentId] int null,
  [V] int null
);`,

  // Thousands of rows, for streaming/backpressure and batching coverage.
  `create table [dbo].[BigTable] (
  [Id] int identity(1,1) not null constraint [PK_BigTable] primary key clustered,
  [Payload] nvarchar(200) not null,
  [Num] decimal(18,4) not null,
  [Flag] bit not null
);`,

  // ----------------------------------------------------------- foreign keys
  `alter table [sales].[Orders] add constraint [FK_Orders_Customers]
  foreign key ([CustomerId]) references [sales].[Customers] ([CustomerId])
  on delete cascade on update no action;`,
  // Self-referencing FK (CASCADE is not permitted on a self-reference).
  `alter table [sales].[Orders] add constraint [FK_Orders_Parent]
  foreign key ([ParentOrderId]) references [sales].[Orders] ([OrderId]);`,
  `alter table [sales].[OrderAudit] add constraint [FK_OrderAudit_Orders]
  foreign key ([OrderId]) references [sales].[Orders] ([OrderId]);`,
  `alter table [dbo].[MutualA] add constraint [FK_MutualA_B]
  foreign key ([BId]) references [dbo].[MutualB] ([Id]);`,
  `alter table [dbo].[MutualB] add constraint [FK_MutualB_A]
  foreign key ([AId]) references [dbo].[MutualA] ([Id]);`,

  // `WITH NOCHECK` leaves the constraint untrusted but still enforced; the
  // follow-up `NOCHECK CONSTRAINT` is what actually disables it. Both states
  // must survive the round trip independently.
  `alter table [dbo].[ConstraintStates] with nocheck
  add constraint [CK_ConstraintStates_V] check ([V] > 0);`,
  `alter table [dbo].[ConstraintStates] nocheck constraint [CK_ConstraintStates_V];`,
  `alter table [dbo].[ConstraintStates] add constraint [FK_ConstraintStates_Self]
  foreign key ([ParentId]) references [dbo].[ConstraintStates] ([Id]);`,
  `alter table [dbo].[ConstraintStates] nocheck constraint [FK_ConstraintStates_Self];`,

  // ---------------------------------------------------------------- indexes
  `create nonclustered index [IX_Orders_Customer_Date]
  on [sales].[Orders] ([CustomerId] asc, [OrderDate] desc);`,
  `create unique nonclustered index [UX_Orders_Customer_Order]
  on [sales].[Orders] ([CustomerId], [OrderId]);`,
  `create nonclustered index [IX_Orders_Total_Include]
  on [sales].[Orders] ([Total]) include ([Status], [OrderDate]);`,
  `create nonclustered index [IX_Orders_Filtered]
  on [sales].[Orders] ([OrderDate]) where ([Status] = 'new');`,
  `create nonclustered index [IX_Weird_Bracket]
  on [weird schema].[Table With Spaces] ([Col]]Bracket] desc);`,

  // -------------------------------------------------------------- sequences
  `create sequence [sales].[OrderNumberSeq]
  as bigint start with 1000 increment by 5
  minvalue 1 maxvalue 999999999 no cycle cache 20;`,
  `create sequence [dbo].[PlainSeq] as int start with 1 increment by 1;`,

  // ---------------------------------------------------- programmable objects
  `create view [sales].[vCustomerOrders]
as
select c.[CustomerId], c.[Name], o.[OrderId], o.[Total], o.[OrderDate]
from [sales].[Customers] c
join [sales].[Orders] o on o.[CustomerId] = c.[CustomerId];`,

  // A view whose only dependency is another view.
  `create view [sales].[vCustomerOrderSummary]
as
select [CustomerId], count_big(*) as [OrderCount], sum([Total]) as [TotalSum]
from [sales].[vCustomerOrders]
group by [CustomerId];`,

  `create function [dbo].[fnDouble](@x int)
returns int
as
begin
  return isnull(@x, 0) * 2;
end;`,

  // WITH SCHEMABINDING makes its dependency on Customers a hard, SQL
  // Server-enforced edge, which the archive planner must order accordingly.
  `create function [sales].[fnCustomerName](@id int)
returns nvarchar(200)
with schemabinding
as
begin
  return (select [Name] from [sales].[Customers] where [CustomerId] = @id);
end;`,

  `create function [sales].[tvfOrdersForCustomer](@id int)
returns table
as
return (select [OrderId], [Total] from [sales].[Orders] where [CustomerId] = @id);`,

  `create procedure [sales].[uspGetCustomer]
  @id int
as
begin
  set nocount on;
  select [CustomerId], [Name], [Email] from [sales].[Customers] where [CustomerId] = @id;
end;`,

  // The batch-splitting trap: standalone `GO` lines inside a string literal
  // and inside a block comment, plus an identifier containing `]`. A naive
  // line-based splitter tears this procedure into pieces on restore.
  `create procedure [dbo].[uspGoTrap]
as
begin
  set nocount on;
  -- a line comment that mentions GO
  print 'GO';
  /*
GO
  */
  print N'multi
GO
line';
  select [Col]]Bracket] from [weird schema].[Table With Spaces];
end;`,

  `create trigger [sales].[trOrdersAudit]
on [sales].[Orders]
after insert
as
begin
  set nocount on;
  insert into [sales].[OrderAudit] ([OrderId], [Note])
  select [OrderId], N'inserted' from inserted;
end;`,
];
