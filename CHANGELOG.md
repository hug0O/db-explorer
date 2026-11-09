# Changelog

## 0.35.1

- **Commit / Rollback buttons fixed**: they always acted on the *active* connection, not the one of the SQL editor you were working in, so with several connections the pending changes stayed uncommitted. They now target the editor's connection, or the only connection with pending changes (the results-panel buttons have no editor), or ask which one when several are pending. Disconnecting a connection with changes commits / rolls back that very connection.
- Clear feedback: a green banner and a status-bar message ("Commit done on X"), and a visible error (banner, log and message) if the commit / rollback fails (lost connection…) instead of failing silently; refused while a statement is still running on that connection.

## 0.35.0

- **History**: reopening a query (Open, Run, or the Ctrl+H picker) now reconnects to the database it was run on if that connection is closed, and attaches the new editor to it. **Run** no longer executes on another database if the original connection cannot be opened. When you insert a query into an editor that uses another connection, you are offered to switch that editor to the original one. If the original connection was deleted, the active one is used (with a notice).

## 0.34.0

- **Describe Object › Data**: a **Load all rows** button loads the whole table (up to `dbexplorer.showAllMaxRows`, default 100 000); the header shows "(first N)" while rows remain. Works on followed links too.
- **Errors and warnings are very visible in the SQL editor**: the line is tinted and the message appears greyed (red for errors, amber for warnings) at the end of the line, with the full text on hover; underline and Problems tab as before (`dbexplorer.inlineErrors`). The text is placed at the end of the line, not on a line of its own (VS Code does not let extensions insert lines).
- **Instant checks while typing** (no database needed, `dbexplorer.liveChecks`): unbalanced parentheses (error), UPDATE / DELETE without WHERE (warning). An execution error disappears as soon as you edit its line.
- **Default statement timeout is now 10 minutes** (`dbexplorer.queryTimeoutSeconds` = 600; 0 = no limit). Existing explicit values are kept.
- **Cancel really stops the statement**: besides asking the database to cancel, if it has not stopped after 4 seconds the interface is released and the connection is reset and reopened (uncommitted changes of that session are rolled back). Applies to Cancel and to the timeout. SQLite still cannot be interrupted.

## 0.33.0

- **Oracle types in PL/SQL code completion**: where a type is expected — variable declaration (`v_x |`, `CONSTANT`), procedure / function parameters (`a IN OUT |`), `RETURN |`, `TABLE OF |`, `RECORD` fields, `SUBTYPE … IS`, `CAST(… AS |`, package spec — the list offers the Oracle types (NUMBER, VARCHAR2(n), DATE, TIMESTAMP, CLOB, BOOLEAN, PLS_INTEGER, SYS_REFCURSOR…, with placeholders for sizes), then the types declared in the block, `var%TYPE`, `cursor%ROWTYPE`, the schema's own types (CREATE TYPE), `TABLE%ROWTYPE` and, after `table.`, `column%TYPE`. After `TYPE x IS`: TABLE OF, VARRAY, RECORD, REF CURSOR. Nothing is suggested in the executable part (BEGIN … END) so it does not get in the way.
- Tested with simulated documents; not tried on a real Oracle server (`ALL_TYPES`).

## 0.32.0

- **Ctrl+click** now also works on **packages, procedures and functions** (`pkg.proc`, `proc(`, `EXEC proc`): it opens their description (Oracle, PostgreSQL, MySQL).
- **Code completion** finds packages, procedures and functions of the schema (from the first letter typed) and, inside a call `pkg.proc( … )`, proposes the **parameters as binds `:param_name`** — the current argument first (overloads handled), plus "(all parameters)" and "(all parameters, named)" (`p_id => :p_id, …`). Typing `:` first works too.
- Tested on real PostgreSQL 17 and MySQL 8 (routine list and parameters); Oracle (`ALL_ARGUMENTS`) not tested on a server.

## 0.31.0

- **Ctrl+click on a table / view name** in a SQL editor (after FROM, JOIN, UPDATE, INTO…) opens **Describe Object** (columns, indexes, constraints, referential, data). Synonyms are resolved.

## 0.30.2

- Sidebar back to the 0.29 layout (my 0.30.0 / 0.30.1 changes there are reverted): the "Connection" row (Schema Browser | Connection tabs) and the search row are shown again, the filter icon is back in the title bar, and the Tools / Settings and Help views are visible again. The setting `dbexplorer.alwaysShowToolsAndHelp` is removed.

## 0.30.1

- Sidebar really simplified: the "Connection" row and the search row no longer sit permanently above the connections (the search row only appears once a connection is open), the title bar keeps three icons (new connection, new query, refresh) and the filter moved into the "…" menu. With no connection, only the welcome message is shown.

## 0.30.0

### Simpler
- The **Tools / Settings** and **Help** sidebar views are hidden by default (open them from the actions palette, or enable `dbexplorer.alwaysShowToolsAndHelp`); the sidebar keeps Schema Browser / Connection and History / Favorites.
- Settings are grouped by theme (Execution, Safety and production, Results and export, Editor and browser, Oracle client).
- **Go to object…** (Ctrl+Alt+G): find a table, view, package… by name; Enter opens it, ⓘ describes it.
- Connections: **environment** tag (DEV / TEST / PROD, PROD enables the production protections and suggests read-only), **pin** a connection to the top of the lists.
- Each SQL editor keeps its own last result: switching editors shows the result of that editor.
- Read-only mode now also blocks grid edits, recompilation and drop from the tree.
- Fewer pop-ups: success messages (recompiled, dropped, template saved…) appear briefly in the status bar.
- Connection test failures now come with an explanation (💡) for common Oracle/PostgreSQL/MySQL errors.
- Results grid: Ctrl+F focuses the search, Esc closes the detail pane / menu / search; accessibility labels on icon buttons.
- **Copy diagnostic information** command (versions, connections, last error) for support.

### Reliability
- Integration tests on real databases (`npm run test:integration`: SQLite always, PostgreSQL and MySQL with `test/docker-compose.yml`) covering queries, paging, commit / rollback, errors, explain and **query cancellation**.
- Fixed: primary-key detection of columns on **PostgreSQL 17** (`smallint = smallint[]` error) — it broke PK indicators, grid editing and the duplicate detector.

## 0.29.0

### Simpler to use
- Tree: only the everyday actions (Open DDL, Select, Describe, Run) stay at the top of an object menu; call graph, ER diagram, usage, duplicates, recompile and drop moved into a **More…** submenu.
- SQL editor: only execute / script / commit-rollback / cancel / plan stay as icons in the title bar (the rest is in the **…** menu); the context menu keeps execution and a **DB Explorer: more** submenu.
- First use: a welcome message with the next steps; a new query with no connection now lists the saved connections (connected ones first) with **New connection…** at the end.
- One status banner under the result tabs summarises the last execution (✓ rows and time, ✗ first error line — click to jump to it) instead of extra pop-ups.
- **Read-only mode** per connection (checkbox in the connection form, status bar toggle, palette): only queries run; anything else is blocked with a clear message.
- Disconnecting a connection with uncommitted changes offers **Commit / Rollback** first.
- `npm test`: quick automated tests (script splitting, error hints, ANSI JOIN conversion).

## 0.28.0

- Connection view: the "Saved connections" and "New connection" sections can be collapsed (state remembered; editing a connection reopens the form).
- Results grid: new **Show all** button next to "Next rows" (loads every remaining row, cancellable, capped by `dbexplorer.showAllMaxRows`).
- Results toolbar redesigned: grouped buttons (search / filter-columns / paging / export-copy), accent buttons for paging, rarely used actions (Edit, Duplicates) moved to a "⋯" menu, and only the relevant buttons shown on each tab.

## 0.27.0

### Errors
- Errors underlined in the editor (and in the Problems tab, F8 jumps to the next one), even when the database gives no position.
- Short explanation (💡) for common ORA-/PLS-/PostgreSQL/MySQL/SQLite errors, and "Did you mean …?" with a one-click fix (unknown column / table).
- Scripts: summary table (line, duration, rows, status), "N OK, M failed" total, "First error" button; setting `dbexplorer.onScriptError` (ask / continue / stop).
- Lost connection: "Reconnect and re-run".

### Results
- The last 6 results are kept as chips; compare two results (added / removed rows).
- Pin columns (right-click a header), detail pane for long text with formatted JSON / XML.
- Execution plan: full table scans highlighted, cost bars.

### Ergonomics
- Connection badge at the end of the first line of SQL editors (red background in production) and a confirmation before a script that modifies a production database.
- "DB Explorer: Actions…" palette (Ctrl+Alt+J), query templates (built-in + your own), history filterable by connection / errors.

## 0.26.0

- New query: choose the connection when several are open.
- Drop a package / function / procedure / trigger from the tree ("Drop…") with a confirmation prompt.

## 0.25.0
### Fixed
- **Package compilation**: a package specification followed directly by its body (`END name;` then `CREATE OR REPLACE PACKAGE BODY …`, with no `/` between) was sent to Oracle as a single statement, hence `PLS-00103: Encountered the symbol "CREATE"`. A `CREATE …` of a PL/SQL unit at the start of a line after a `;` now starts a new statement. Quoted object names (`"MyPkg"`) keep their case when the compilation errors are read.
### Added
- **Errors tab** separate from **Script / Messages** (with a count badge; it is shown automatically when the last entry is an error) and a **Clear** button on each of the Messages / Errors / Output tabs (`dbexplorer.clearLogOnRun` to clear at each run).
- **Where in the script**: every statement logs `▶ file.sql:LINE` (also in its error line), a separator line starts each execution (time, script, number of statements) so several scripts run in a row stay readable, and the lines are **clickable** to jump to that line of the script (compilation errors too).

## 0.24.1
### Added
- **Duplicate detector for a query** (code action, editor menu, Tools, or *Find the cause…* in the grid's Duplicates panel): the **key of every table** of the FROM / JOIN list (primary key, else ROWID / ctid / rowid) is added to the SELECT, with `DUP_COUNT` when the select list allows it — for identical rows the key that changes is the table that repeats them. A second mode gives a **summary per table** (`REPEATED_GROUPS` > 0 = this table multiplies the rows, usually a missing or too loose join condition). `DISTINCT` is removed so the duplicates show.

## 0.24.0
### Added
- **Duplicates in the results grid**: the *Duplicates* button highlights the rows that have the same values in the chosen columns (default: every column except the primary key), one colour per group with a `×N` count next to the row number; *Only duplicates* keeps just those rows, grouped together; a summary gives the number of rows and groups (loaded rows only).
- **Find duplicates in a table** (right-click a table, Tools tile, or the command palette): pick the columns that must be identical, then get a **summary** (one row per duplicated value with its count), **all the rows that have a duplicate** (grouped, with `DUP_COUNT`), or a **delete script** keeping one row per group (opened, never executed). LOB / JSON / XML columns are left out.

## 0.23.1
### Improved
- **Compilation errors** (package, package body, procedure, function, trigger, type…): after *Execute* the **cursor jumps to the first error** (line and column), a message gives the error with a *Go to line N* button, the Script / Messages tab lists every error with the source line, and the errors stay underlined in the editor / Problems panel (F8 for the next one). The line is now exact even with comments, blank lines or `CREATE OR REPLACE` on its own line before the object keyword.
- **Recompile from the Schema Browser** (invalid object): the message shows the first error and *Open the source at the error* opens the object's source with every error underlined and the cursor on the first one (spec and body errors are placed in their own unit).

## 0.23.0
### Changed
- **Ctrl+click on a key no longer asks anything**: the link is chosen from the query on screen (a foreign key opens the parent row; a referenced key opens the child rows; a table already in the query comes last). **Alt+Ctrl+click** still lets you choose, **Shift+Ctrl+click** opens a new editor.
- **Breadcrumb: going back does not re-run the query** — the rows already loaded are shown again as they were (including rows fetched with *Next rows*, and *Next rows* keeps working afterwards).
### Added
- **Describe Objects → Referential** for every database (not only Oracle): *References →* and *← Referenced by* with this table's columns, the related table's columns and the referenced key (Oracle); click a related table to open its own Describe.
- **Describe Objects → Data**: colour per column type with legend, 🔑 / 🔗 indicators, **Ctrl+click on a key** to follow the link with the same **breadcrumb** (instant back) as the results grid.

## 0.22.3
### Fixed
- **Breadcrumb of linked rows**: going back re-ran the original query without its bind variables (`NJS-098: 1 bind placeholders were used … but 0 bind values were provided`); the values are now kept with each step.
- **Oracle joins → ANSI JOIN**: a condition with an expression on one side now becomes `JOIN LANGU ON LANGU.LANGU_ID = NVL(FACTU.FACTU_LANGU_ID, FA_TIERS.TIERS_LANGU_ID)` (joined table first); when a statement cannot be converted, the message now gives the precise reason (OR in the WHERE, (+) on both sides of a condition, unsupported FROM item, duplicate alias…).
### Changed
- **Tools tab**: compact grid of icon tiles (the description is the tooltip).

## 0.22.2
### Fixed
- **Oracle joins → ANSI JOIN**: join conditions written **without alias** (`AND TIERS_ID = COMMA_TIERS_ID`) are now recognised — each column is matched to its table through the table metadata — so they become `JOIN … ON` (no `(+)`), `LEFT JOIN` (`col = other(+)`) or `RIGHT JOIN` (`col(+) = other`); only tables with no join condition become `CROSS JOIN`, and the message tells how many.
### Changed
- **Schema Browser toolbar**: only 4 icons remain (filter, new connection, new SQL editor, refresh); the other actions are in the `…` menu, by section (view: group by schema / invalid only / filter by type — connection: active connection, schema, disconnect all, import tnsnames — tools: compare schemas). Connection rows keep a single inline button (disconnect); the others are in the right-click menu.

## 0.22.1
### Changed
- **Help view**: *Visual guide*, *Keyboard shortcuts* and *What's new* are now three internal tabs (same style as the other views); the selected tab is remembered.

## 0.22.0
### Changed
- **Sidebar reorganised into fewer views, with internal tabs**:
  - **History & Favorites** — one view, two tabs (filter box, grouped lists, run / insert / open / copy / rename / delete buttons on each row).
  - **Tools & Settings** — one view, two tabs.
  - **Schema Browser | Connection** — the connection form takes the Schema Browser's place through a *Connection* tab (first row of the tree, or *New connection*); the form has a *Schema Browser* tab and brings you back to the browser once connected. (VS Code trees cannot host tabs themselves, so the two views alternate in the same slot.)
- The history filter commands are replaced by the filter box of the new view.

## 0.21.0
### Changed
- **Linked rows with a breadcrumb**: Ctrl+click on a key now opens the parent row / child rows **in the grid itself** and adds a step to a **breadcrumb trail** above it (`SELECT … › ↑ DEPT [ID=10] › ↓ EMP [DEPT_ID=10]`). Click a step or *Back* to return (the step's query is run again, so data is fresh and sorting, paging and editing keep working); *SQL* opens the current step's query in an editor. Shift+Ctrl+click keeps the previous behaviour (new editor). Running a normal query resets the trail.

## 0.20.0
### Added
- **Oracle joins → ANSI JOIN** (Tools, code actions, editor menu): rewrites `FROM a, b WHERE a.x = b.y(+)` as `FROM a LEFT JOIN b ON …` (also `RIGHT JOIN`, `CROSS JOIN`, filters on the optional side moved into `ON`), subqueries and UNION branches included, on the statement or the selection. Cases that cannot be converted safely (`OR` at the top of the WHERE, `(+)` on both sides…) are left untouched and reported. Ctrl+Z undoes it.
- **Invalid objects (Oracle)**: *Show only invalid objects* (view title, or in the filter box) and **Recompile** — one object, or all the invalid objects of a category / schema (two passes to resolve dependencies; remaining errors listed in Script / Messages).
- **Group by schema (user)** in the Schema Browser (`dbexplorer.groupBySchema`, toggle in the view title): connection → schemas (current first) → categories → objects; *Use this schema* makes one current. The name filter then filters the schemas; type and invalid filters apply inside each schema.

## 0.19.0
### Added
- **Impact / lineage**: right-click an object in the Schema Browser → *Who uses this object?* (views, packages, procedures, triggers, tables by foreign key…) or *What does this object use?*, shown as a graph over up to 3 levels (Oracle `ALL_DEPENDENCIES`, PostgreSQL view dependencies, MySQL view usage, SQLite views/triggers).
- **Schema comparison** (Schema Browser title menu / Tools): pick a source and a target (two connections, or two schemas of one), get the missing objects, the extra ones and the columns that differ, as a **sync script** opened in an editor bound to the target (CREATE of missing objects, ADD / MODIFY of columns; drops are commented out).
- **Favorites view**: save the current statement per connection or for all connections (editor context menu, Tools), open / run / rename / delete from the view, insert one with *Insert a favorite*; `:name` parameters work as usual.
- **Inline grid editing**: for a result coming from a single table whose primary key is in the result, the **Edit** button lets you double-click cells, stage changes (highlighted), then **Apply** them: one `UPDATE … WHERE pk = …` per row in the open transaction (confirmation on auto-commit or production connections). Typing `NULL` sets a null; LOBs and key columns stay read-only.

## 0.18.0
### Added
- **ER diagram**: right-click a table in the Schema Browser (or Tools → ER diagram to pick several tables) to see it with the tables linked by foreign keys; arrows go from the child to the parent table, labelled with the key columns, nodes show the primary key and column count.
- **Follow foreign keys in the results grid**: **Ctrl+click** a key cell opens the parent row (foreign key) or the child rows (referenced key) in a new editor, executed right away. Linked cells are underlined on hover; a hint in the legend banner explains it.

## 0.17.0
### Added
- **Preview before UPDATE / DELETE**: the rows the statement will touch are counted first (`SELECT COUNT(*)` with the same WHERE, 5 s max) and shown in the log. A confirmation dialog is shown when the count reaches `dbexplorer.confirmRowsThreshold` (default 100), when there is **no WHERE**, or on a **red (production) connection** (`dbexplorer.confirmOnProduction`); it also warns when auto-commit is on. Cancelling stops a script before anything is changed. Disable the count with `dbexplorer.previewAffectedRows`.

## 0.16.0
### Added
- **Uncommitted changes are now obvious**: a warning banner above the results grid with big **Commit** / **Rollback** buttons, warning-coloured **Commit** and **Rollback** items in the status bar, buttons in the editor title bar (only while a transaction is open), and a reminder message the first time a statement leaves data uncommitted (`dbexplorer.notifyUncommitted`).
- **Hover on a table alias** (or table name) in a query: the fields of the linked table (type, PK, comment); for a subquery / CTE, its columns.

## 0.15.3
### Changed
- Schema Browser filter: **one dialog with the name filter and a multi-select list of the object types that actually exist** (with counts when indexed); tick the types, type a name, Enter. Only the checked types are shown.

## 0.15.2
### Added
- **Filter the Schema Browser by object type** (tables, views, packages…): checklist from the view title or the search row, combinable with the name filter.
### Fixed
- **Query graph and Oracle joins**: `WHERE a.x = b.y(+)` is shown as an outer join (arrow from the preserved table to the optional one, `OUTER (+)` on the table); comma joins are labelled *implicit join*; conditions with functions (`UPPER(a.x) = UPPER(b.y)`, `(+)` after a parenthesis) and ANSI `ON` conditions are no longer mixed up.

## 0.15.1
### Changed
- The object search is merged into the **Schema Browser**: first row of the tree (click, type, Enter; × to clear).
### Fixed
- **Completion inside the source of packages, procedures, functions, triggers and views** (opened from the Schema Browser or F4): the SQL statement around the cursor is isolated from the PL/SQL block (aliases, columns, joins, `SELECT … INTO` variables, cursors, `FOR r IN (SELECT …)`), and the source is bound to the connection it came from.

## 0.15.0
### Added
- **Query graph** (Tools, code actions, command palette): diagram of the tables, subqueries / CTE and join conditions (with Oracle `(+)`) of the current statement; tables with no join condition are flagged. "Mermaid" button copies the diagram as Mermaid text.
- **Call graph** of a package, procedure or function (right-click in the Schema Browser, or from the source open in the editor): internal calls between subprograms (public / private), calls to other packages and system packages.
- **PK / FK indicators** in the results grid header (key and link icons, with a legend), from the indexed metadata.
- **Search field above the Schema Browser**: type and press Enter. Every category containing matches is opened automatically; the indexed metadata is used first, then the database. Esc / × clears.
- Filter by column: the filter panel closes once applied; column lists (filter, search, show/hide) are sorted alphabetically (A→Z toggle in the Columns panel).

## 0.14.1
### Fixed
- Dates in the results grid are shown as `2026-07-17 15:34:23` (date only at midnight) instead of the long JavaScript format.

## 0.14.0
### Added
- **Cancel the running statement**: "Cancel query" button in the status bar and the editor title bar (and in the results banner), `Ctrl+Alt+Q`. Oracle (break), PostgreSQL (`pg_cancel_backend`) and MySQL/MariaDB (`KILL QUERY`) are really interrupted; SQLite cannot be interrupted. A cancelled script stops.
- **Configurable query timeout** (`dbexplorer.queryTimeoutSeconds`, also in the Settings view): the statement is cancelled when the time is exceeded; the limit is shown in the running banner and a clear message in the log.
- **Duplicated databases are not rescanned**: when a connection's schema looks like another cached one (same DBMS, ≥ 90% of the object names), its column metadata is reused. On Oracle a single query returns a structure fingerprint of every table and only the tables that differ are read again (this also makes the periodic refresh much cheaper). The Settings view shows how many tables were reused.
- **Show / hide columns** in the results grid (Columns button; the copy follows the visible columns).
- **Discreet colour per column type** in the grid header and cells (number, text, date/time, boolean, binary/LOB, other) with a **legend banner** above the grid.
- **Quick filter in the Schema Browser** (filter icon in the view title): substring or pattern with `*`, applied to the objects of every category.
### Changed
- The Excel and CSV buttons of the grid are removed; only **Export…** remains (all formats).
### Fixed
- Aliases of **subqueries / derived tables** and table aliases inside nested queries (correlated subqueries, CTEs, `TABLE()`/`XMLTABLE()`/`UNNEST()` aliases) are now detected per query scope; tables of a subquery no longer leak into the outer query.

## 0.13.0 — 2026-11-01
### Added
- **Connection in the VS Code title bar** (`name · user@schema`, e.g. `Hhdev1@PSGLWRK · Hhdev1@HHDEV1`), on by default (`dbexplorer.connectionInWindowTitle`). It sets the user setting `window.title` and restores it when no connection is active. If you use the Command Center, set `"window.commandCenter": false` to see the title text. The extra "Active connection" view and the Schema Browser header text are removed.
- **Show code actions at the cursor** (`Ctrl+Alt+A`, `Ctrl+.`, lightbulb): describe / SELECT * / count rows of the table or alias under the cursor, **expand `*` / `alias.*` into the column list**, **add the missing `ON` condition of a JOIN** from the foreign keys, execute, explain, optimize, column types, compare, format the statement, comment lines.
- **Oracle-style joins in completion**: after `FROM a, ` the tables linked by foreign key are proposed with their alias and the join condition is added to the existing WHERE; in the WHERE clause the missing join conditions are proposed (`a.id = b.a_id`) with the Oracle outer-join variants (`(+)` on either side); `DUAL` and table functions (`TABLE(`, `XMLTABLE(`, `JSON_TABLE(`) after FROM.
- A **blank line ends a statement** without ";" (like Toad; not inside parentheses or PL/SQL blocks; `dbexplorer.blankLineSeparatesStatements`). The statement under the cursor — run, explain, optimize, and the table aliases used by completion — no longer mixes with the neighbouring queries.
### Changed
- Sidebar at startup: **only Schema Browser is expanded**; Connection, Settings, **Tools** (no longer hidden), Help and History are collapsed (view ids renamed so the new defaults apply).
### Fixed
- Table aliases were not recognized when several queries without ";" followed each other (the aliases of other queries were mixed in).
- Describe / open object now uses the connection of the editor instead of the global active one.


## 0.12.0 — 2026-10-31
### Added
- **Connection banner at the very top of DB Explorer**: a first view whose title is the active connection (`name · user@schema`), with a color bar, database type, commit mode, uncommitted-changes flag and quick buttons (switch, schema, SQL editor, disconnect). Optional `dbexplorer.connectionInWindowTitle` also puts it in the VS Code window title.
- **Connection view lists your saved connections**: tested-OK / failed / not-tested badge (with date and error in the tooltip), connected flag, Connect / Disconnect / Test / Edit buttons, and a color dot to change the connection color in one click. Results are remembered.
- **Quick disconnect icon** on each connected connection in the Schema Browser, plus "Disconnect all".
- **Grid**: the search box can target a single column; NULL cells have a light-gray background.
- **Completion**:
  - in an existing query, the FROM tables come first — their aliases (`t.` opens the columns), then their columns; columns of other tables only if nothing in the FROM matches (marked "not in the FROM clause"); ambiguous columns are offered qualified (`t.ID`, `c.ID`);
  - after `a.x =`, the columns of the other FROM tables are offered, the foreign-key counterpart first;
  - **column alias from the column comment**: after `col AS ` or `col ` the comment becomes `DATE_DE_CREATION` or `"Date de création"` (Oracle, PostgreSQL, MySQL);
  - aliases are recognized for sub-queries (`FROM (SELECT …) x`, `SELECT *` expanded), CTEs (`WITH w (a, b) AS …`) and `MERGE … USING`;
  - tables no longer go missing: matches are ranked (prefix, contains, fuzzy) *before* the cap, and the database is also searched by prefix (other schemas, public synonyms, new tables) as soon as 3 characters are typed.
- **Suggest query optimizations** (`Ctrl+Alt+O`, editor toolbar, **Tools** view — hidden by default, enable it from the DB Explorer "…" menu): rules per database (SELECT *, functions on columns, leading-wildcard LIKE, NOT IN, UNION vs UNION ALL, Cartesian product, ORDER BY random, large OFFSET, Oracle ROWNUM / (+) / hints / FOR UPDATE…), **missing indexes** checked against the real indexes for filtered and joined columns (with a ready-to-run CREATE INDEX), full scans / filesort / temporary tables found in the **execution plan**, and per-database tips.
- **Comment / uncomment** lines (`Ctrl+Alt+C`, `Ctrl+B` with the Toad keymap) and block comment, from the editor context menu too.
- **Compare queries**: side-by-side diff with another editor, the clipboard, a history entry or a file (optionally formatted first, so spacing and keyword case are ignored), or **compare the rows** returned by two queries (rows only in A / only in B).
### Fixed
- Explain Plan with bind variables on Oracle (bind values were not converted).
- The row count was displayed twice in the results status bar.


## 0.11.0 — 2026-10-30
### Added
- **Sort by clicking a column header, run by the database**: click = `ORDER BY` ascending, second click = descending, third click = original order (▲ / ▼ shown on the header). The query is wrapped as `SELECT * FROM (<your query>) ORDER BY …`, so exports follow the sort.
- **Filter button with several criteria**: add as many criteria as needed (column, operator, value) — `=`, `≠`, `>`, `≥`, `<`, `≤`, contains, starts with, ends with, in list, between, is null, is not null — combined with AND or OR. Values are passed as bind variables; the filter runs in the database and the export uses the filtered rows. If a query cannot be wrapped (duplicate column names, LOBs…), sort and filters fall back to the rows already loaded.
- **Export as INSERT / MERGE with bind variables** (Oracle): "SQL INSERT — bind variables" and "SQL MERGE" / "SQL MERGE — bind variables". The bind versions are PL/SQL blocks (100 rows each) running `EXECUTE IMMEDIATE '… :1, :2 …' USING value, …`: one statement parsed by the server, values passed as binds. MERGE key columns default to the table's primary key (or are picked from a list). Dates become `TO_DATE` / `TO_TIMESTAMP`.
### Fixed
- **No connection stays open after quit / reload / idle timeout / disconnect**: the metadata sessions (scan and lookup) are closed with their connection, running queries are interrupted first, the transaction is rolled back, and everything closes in parallel within a bounded time (previously a busy connection could delay the close past VS Code's shutdown deadline). The Settings view shows how many extra metadata sessions a connection holds.


## 0.10.0 — 2026-10-29
### Added
- **Active connection in the DB Explorer header**: the Schema Browser header and the Results panel show `connection · user@schema`; the status bar shows `user@schema` too.
- **Export results to Excel (.xlsx) and more**: CSV, TSV, JSON, HTML, Markdown, SQL INSERT and XML, via the new **Excel** / **CSV** / **Export…** buttons of the results panel (or the "Export results…" command). All rows are re-read as a stream (no memory limit, tested with 400,000 rows); the Excel file has bold headers, a frozen header row, auto-filter, typed numbers and dates, and a new sheet every 1,048,576 rows. CSV separator is configurable (`dbexplorer.csvSeparator`).
- **New SQL editor shortcut**: `Ctrl+Alt+N` (`standard`), `Alt+Shift+N` (`alt`). The editor is named after its connection (`PROD-1.sql`) and bound to it.
- **tnsnames.ora detection**: TNS_ADMIN, ORACLE_HOME, the Windows registry, usual Oracle / Instant Client folders, the PATH and your workspace are scanned. With no Oracle connection yet, a prompt offers to import; "Import connections from tnsnames.ora…" (also in the empty Schema Browser) lets you pick several aliases and creates the connections in one go. The Connection form suggests the detected folders.
- **Color per connection** (palette of 9, red = production): colored database icon in the Schema Browser, colored tab title with a dot, colored left edge and ruler mark in the SQL editor, colored status bar (red turns the status bar into an alert). The colors can be customized (`dbexplorer.color.*`) and turned off (`dbexplorer.colorEditors`).
### Changed
- **Each SQL editor now runs on its own connection** (the one it was created or first run with), so a PROD editor stays on PROD even after you switch the active connection. Choosing a connection while an SQL editor is focused moves that editor to it.


## 0.9.0 — 2026-10-28
### Fixed
- **Code completion no longer hangs on "Loading…" on very large Oracle databases.** The slow part (loading the whole dictionary) used to run on your query connection and the list waited for it. Now:
  - the object list comes from memory / the disk cache instantly and the list **always answers within ~1.2 s**; if the database is slower, you get what is cached plus a "Searching…" / "Loading columns…" line, and the list **reopens by itself** when the data arrives;
  - Oracle: own-schema objects are listed from `USER_OBJECTS` (much faster than `ALL_OBJECTS`), columns come from a light per-table query, and foreign keys are fetched per table on demand (no more schema-wide scans).
### Added
- **Background metadata scanner** on a **dedicated connection** (never your query session): object list, then columns of every table in throttled batches of 60 (paused while you run a statement). Progress is shown in the status bar and in the Settings view; the result is stored on disk (24 h for columns, 30 min for the object list) so the next start is instant.
- **Search-on-type fallback**: if what you typed is not in the cache (new table, partially scanned database), the extension looks it up directly in the database by prefix — own schema, public synonyms, then other schemas (`OWNER.TABLE`) — and remembers the result. Unknown names are verified in the database before being ignored.
- Settings: `dbexplorer.prefetchMetadata` and `dbexplorer.metadataConnection`, plus a "Code completion cache" section (counts, scan progress, "Rebuild cache") in the Settings view.
- The schema list is cached for 10 minutes; typing `name.` only scans a schema if it really exists.


## 0.8.0 — 2026-10-27
### Added
- **Dedicated "Trigger code completion" shortcut** that does not clash with the system / input method (`Ctrl+Space` is often taken): `Ctrl+Alt+Space` (`standard`), `Alt+Shift+Space` (`alt`), `Ctrl+Space` (`toad`). Also in the editor context menu.
- **Join suggestions from foreign keys**: after `JOIN` the tables linked to the tables already in the query are offered first, with the alias and the `ON` condition ready (`COMMANDES c ON c.TIERS_ID = t.TIERS_ID`); after `ON` the matching equality conditions are offered. Works on Oracle, SQLite, MySQL and PostgreSQL, with or without aliases.
- **Persistent metadata cache** (objects, columns, foreign keys), stored on disk per connection and schema: suggestions are available instantly when VS Code starts, then refreshed in the background. "Refresh" in the Schema Browser rebuilds it.
- **Columns without an alias**: while typing a column in the `SELECT` list before any `FROM`, columns of all tables of the schema are suggested (with their table).
### Fixed
- Suggestions after **Enter** following `FROM` / `JOIN` / `WHERE` / a comma: the list now opens automatically on the new line, and `Enter` only accepts a suggestion when it changes the text (otherwise it is a plain line break).
- Suggestion lists are filtered server-side and capped, so schemas with thousands of objects stay fast.


## 0.7.0 — 2026-10-26
### Added
- **Settings view** in the sidebar: idle timeout (default 30 min), automatic rollback of uncommitted changes on timeout, transaction timeout, query timeout, and the list of open connections (idle time, uncommitted state) with Set active / Rollback / Disconnect buttons.
- **Automatic rollback + disconnect when VS Code quits or reloads**: every open connection is rolled back and closed.
### Changed
- The **History** view is collapsed by default and placed last in the sidebar (new view id, so the new default applies to existing installs).
### Fixed
- Code completion now appears while typing (not only with Ctrl+Space): snippets no longer block quick suggestions, and the object list is preloaded on connect and cached, so a slow database no longer cancels every suggestion request. Completion after `JOIN` / `LEFT JOIN` / `INNER JOIN` verified.


## 0.6.0 — 2026-10-25
### Added
- **Context-aware code completion** in the SQL editor: type `TI` and get `TIERS` (tables, views, synonyms with their type).
  - after `FROM` / `JOIN` / `UPDATE` / `INTO`: tables, views and schemas only (also suggested right after the space);
  - after `SELECT` / `WHERE` / `AND` / `ON` / `SET` / `ORDER BY`…: columns (type and PK shown) of the tables used in the statement, then functions and keywords;
  - `alias.` / `table.` → columns, `schema.` → objects of the schema, `package.` → package procedures and functions (Oracle);
  - after `FROM table`: the next clauses (`WHERE`, `GROUP BY`, `JOIN`…);
  - Oracle functions with argument placeholders, query templates (`select`, `insert`, `update`, `delete`, `count`, `plsql`);
  - keywords follow the case you type; nothing is suggested inside strings or comments.
- SQL files now get quick suggestions as you type (`[sql]` defaults: quick suggestions on, document-word suggestions off).


## 0.5.0 — 2026-10-24
### Added
- **English interface by default**, French when VS Code (hence the OS) is set to French: menus, commands, settings, views, messages and dialogs.
- **Query history** in the sidebar: grouped by day, tooltip with the full SQL, click = open in an editor, ▶ = run again (the right connection is re-activated), filter, copy, delete, "Clear history".
- **Switch the active connection easily**: click a connected connection in the Schema Browser (the active one is green and marked "active"), `$(plug)` button in the view title and the editor toolbar, status bar click; picker with connected / saved connections and "New connection…".
### Changed
- Shortcuts are no longer shown in the Connection view: they live in the (collapsed) Help view, with links to change the shortcut set or customize keys.

## 0.4.0 — 2026-10-23
### Added
- **Parameters dialog**: when running, all bind variables (`:name`) are listed in one panel (value, NULL, type; IN / OUT / IN OUT direction for Oracle). Values are remembered.
- **Execution timer**: "Executing… mm:ss" banner in the results panel plus a status bar message until the query answers.
- **PL/SQL**:
  - OUT / IN OUT parameters shown after execution (`:r := f(…)`, `INTO :x`), OUT **REF CURSOR** shown in the grid (`OPEN :c FOR …`);
  - SQL*Plus `EXEC` / `EXECUTE` and `SHOW ERRORS`;
  - "Execute with parameters…" (right-click a procedure, function or package in the Schema Browser): generates the call block with the real arguments (`ALL_ARGUMENTS`);
  - reliable splitting of `BEGIN … END;` blocks (nested IF / LOOP / CASE, blank lines, consecutive blocks without `/`).
### Fixed
- Shortcuts are only active when the cursor is in the SQL editor (`editorTextFocus`): F4 no longer conflicts with search-result navigation, etc.

## 0.3.0 — 2026-10-22
### Added
- **Describe Objects** (like Toad) on `Ctrl+Alt+D` (`F4` with the Toad keymap): Columns, Indexes, Constraints, Triggers, Data, Script, Partitioning, Grants, Synonyms, Stats/Size, Referential, Used By tabs, with header (created, last DDL, primary key). Sort and filter in each tab. Also available from the Schema Browser. Full on Oracle; other databases: Columns, Indexes, Constraints, Data, Script.
- `dbexplorer.keymap` setting with three shortcut sets: `standard`, `alt`, `toad`.
### Changed
- Default shortcuts (`standard` set): `Ctrl+Alt+Enter` (execute), `Ctrl+Alt+S` (script), `Ctrl+Alt+X` (Explain Plan), `Ctrl+Alt+D` (Describe), `Ctrl+Alt+T` (column types).

## 0.2.0 — 2026-10-22
### Added
- **Connection** view in the sidebar: form with per-database fields (TNS alias list, `tnsnames.ora` folder, SQLite file, host/port…), Test / Save / Save and connect.
- Collapsed **Help** view at the bottom of the sidebar: version, changelog, visual guide.
- "What's new" notification on each version change.
### Changed
- The results panel now appears at the **bottom** of VS Code, without stealing editor focus.
### Fixed
- Oracle: Describe on a table no longer fails with `ORA-00932: inconsistent datatypes: expected CHAR got LONG` (`DATA_DEFAULT` column).
- Sidebar icon drawn with filled shapes (black square).

## 0.1.0 — 2026-10-20
### Added
- Oracle (Thin, `tnsnames.ora`), SQLite, MySQL/MariaDB and PostgreSQL support.
- Schema Browser, SQL editor (statement / script execution), results grid, DBMS_OUTPUT, Explain Plan, DDL, CSV/JSON export, history, completion.
- Describe table or open the source of a function, package or trigger; column types of a query.
