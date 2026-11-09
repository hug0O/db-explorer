# DB Explorer

**A multi-database SQL client for VS Code, inspired by Toad.** Browse schemas, write SQL with context-aware completion, run statements and scripts, edit and export results — on **Oracle, PostgreSQL, MySQL / MariaDB and SQLite**.

🇫🇷 [Version française](README.fr.md) · 📜 [Changelog](CHANGELOG.md)

The interface is in **English** and switches to **French** automatically when VS Code is set to French.

| Database | Driver | Notes |
|---|---|---|
| **Oracle** | `oracledb` (Thin mode, **no Instant Client needed**) | `tnsnames.ora` aliases, SYSDBA / SYSOPER, PL/SQL, `DBMS_OUTPUT`, compile errors |
| **PostgreSQL** | `pg` + `pg-cursor` (server-side paging) | savepoints per statement in transactions |
| **MySQL / MariaDB** | `mysql2` | |
| **SQLite** | `node-sqlite3-wasm` (no native build) | file or `:memory:` |

> ⚠️ Oracle-specific features (compilation, package members, `ALL_ARGUMENTS`, synonyms…) are written against the Oracle data dictionary but were **not run against a real Oracle server** by the author. PostgreSQL, MySQL and SQLite are covered by integration tests (see [Development](#development)). Bug reports are welcome.

## Getting started

1. Click **DB Explorer** in the activity bar. Use **+** (or the *Connection* tab) to create a connection: pick the database type, fill the fields (for Oracle choose a TNS alias — `tnsnames.ora` is detected automatically), then **Save and connect**.
2. Open a `.sql` file (or press `Ctrl+Alt+N` for a new editor) and run the statement under the cursor with `Ctrl+Alt+Enter`.
3. Results appear in the bottom **DB Explorer** panel: grid, script messages, errors, DBMS Output and execution plan.

Press `Ctrl+Alt+J` in a SQL editor for the **actions palette** (the everyday actions first, the rest under *More*).

## Features

### Writing SQL
- **Context-aware completion**: tables after `FROM` / `JOIN`, columns after `SELECT` / `WHERE`, `alias.` columns (including sub-queries and CTEs), `package.` members, functions and query templates. Built for very large databases: persistent metadata cache, background scan on a dedicated connection, search-as-you-type straight from the database.
- **Join suggestions** from foreign keys, `JOIN` without `ON` quick fix.
- **Packages, procedures and functions**: names are completed, and inside a call `pkg.proc( … )` the parameters are offered as binds `:param` (current argument first, overloads handled, named notation available).
- **Oracle types in PL/SQL**: in declarations, parameters, `RETURN`, `TABLE OF`, `CAST(… AS`, you get `NUMBER`, `VARCHAR2(n)`, `DATE`…, types declared in the block, `var%TYPE`, `cursor%ROWTYPE`, `TABLE%ROWTYPE`, `table.column%TYPE`, and your own types.
- **Ctrl+click** on a table, view, package, procedure or function opens **Describe Object**.
- **Code actions** (`Ctrl+Alt+A`): expand `*`, add the missing `ON`, format, optimize, compare, "Did you mean …?" fixes.
- **Query templates** (built-in per database + your own), **Go to object** (`Ctrl+Alt+G`).

### Running and errors
- Run a statement or a whole script, with parameters dialog for bind variables (IN / OUT / IN OUT, REF CURSOR), PL/SQL blocks, `EXEC`, `SHOW ERRORS`.
- **Errors are impossible to miss**: tinted line and greyed message at the end of the line, underline, Problems tab, plus a status banner under the result tabs. Short explanations (💡) for common `ORA-` / `PLS-` / PostgreSQL / MySQL / SQLite errors, and instant checks while typing (unbalanced parentheses, `UPDATE` / `DELETE` without `WHERE`).
- Script summary table (line, duration, rows, status), per-statement line numbers in the messages, click to jump to the line.
- **Cancel** really stops the statement (and resets the connection if the database does not obey); default **timeout 10 min** (`dbexplorer.queryTimeoutSeconds`).
- **Transactions**: auto-commit toggle, **Commit / Rollback** buttons (on the right connection), pending-changes banner and reminders, `UPDATE` / `DELETE` preview of the affected rows with confirmation, **read-only** mode per connection, **DEV / TEST / PROD** tag with extra protection for production.
- **Compile** packages / procedures / functions / triggers / views with errors positioned in the source; invalid-object filter and *Recompile all*.

### Results
- Grid: sort and filter **in the database**, columns hide / pin / colour by type, paging with **Show all**, in-grid **editing** (applied as `UPDATE` by primary key), duplicate highlighting and a **duplicate detector** for queries, detail pane with formatted JSON / XML.
- **Linked rows**: Ctrl+click a key to follow the foreign key (parent / child rows) with a breadcrumb to come back.
- Keeps the last results, **compare two results** row by row.
- **Export**: Excel (.xlsx), CSV, TSV, JSON, HTML, Markdown, SQL INSERT, XML (streamed, any size), Oracle INSERT / MERGE with or without binds.

### Exploring the schema
- **Schema Browser** with quick filter (text and object types), invalid objects, group by schema, PK / FK indicators.
- **Describe Objects** (Columns, Indexes, Constraints, Triggers, Data, Script, Grants, Synonyms, Stats / Size, **Referential**, **Used By**) with **Load all rows**.
- **Graphs**: query graph, call graph for packages / functions, **ER diagram**, lineage ("who uses this?").
- **Schema compare** with a synchronisation script, query comparison (text and result diff).
- **Query optimizer advisor** (rules per database, missing indexes, plan findings), colourful **Explain Plan** with full-scan detection.
- **Oracle → ANSI JOIN** converter (`(+)` and comma joins).
- **History** (searchable, reconnects to the original database) and **Favorites**.

## Keyboard shortcuts

Choose a layout with the `dbexplorer.keymap` setting.

| Action | `standard` (default) | `alt` | `toad` |
|---|---|---|---|
| New SQL editor | `Ctrl+Alt+N` | `Alt+Shift+N` | `Ctrl+Alt+N` |
| Execute statement | `Ctrl+Alt+Enter` | `Alt+Enter` | `F9`, `Ctrl+Enter` |
| Execute script | `Ctrl+Alt+S` | `Alt+Shift+Enter` | `F5` |
| Cancel | `Ctrl+Alt+Q` | `Alt+Shift+Q` | `Ctrl+Alt+Q` |
| Explain plan | `Ctrl+Alt+X` | `Alt+Shift+E` | `Ctrl+E` |
| Describe object | `Ctrl+Alt+D` | `Alt+D` | `F4` |
| Query column types | `Ctrl+Alt+T` | `Alt+Shift+D` | `Ctrl+F9` |
| Completion | `Ctrl+Alt+Space` | `Alt+Shift+Space` | `Ctrl+Space` |
| Optimize | `Ctrl+Alt+O` | `Alt+Shift+O` | `Ctrl+Alt+O` |
| Comment lines | `Ctrl+Alt+C` | `Alt+Shift+C` | `Ctrl+B` |
| Code actions | `Ctrl+Alt+A` | `Alt+Shift+A` | `Ctrl+Alt+A` |

Always available in a SQL editor: `Ctrl+Alt+J` (actions palette) and `Ctrl+Alt+G` (go to object).

## Settings (excerpt)

| Setting | Default | Description |
|---|---|---|
| `dbexplorer.queryTimeoutSeconds` | `600` | Statement timeout (0 = none) |
| `dbexplorer.pageSize` / `showAllMaxRows` | `500` / `100000` | Rows per page / limit of **Show all** |
| `dbexplorer.autoCommit` | `false` | Auto-commit on new connections |
| `dbexplorer.onScriptError` | `ask` | `ask`, `continue` or `stop` when a script statement fails |
| `dbexplorer.confirmOnProduction` | `true` | Ask before modifying a production connection |
| `dbexplorer.inlineErrors` / `liveChecks` | `true` | Inline error text / instant checks while typing |
| `dbexplorer.keymap` | `standard` | Shortcut layout |

All settings are grouped by theme under **Settings → Extensions → DB Explorer**.

## Security

- Passwords are stored in VS Code's **SecretStorage**, never in settings or files.
- A connection can be tagged **PROD** (or coloured red) and set to **read-only**. Scripts that modify a production database ask for confirmation first.
- Nothing is sent anywhere: the extension talks only to the databases you configure.

## Installation

**From a `.vsix`** (downloaded from the *Releases* page): in VS Code, **Extensions → … → Install from VSIX…**, or

```bash
code --install-extension dbexplorer-<version>.vsix
```

**From source:** see below.

## Development

Requirements: Node.js 18+ and VS Code 1.85+.

```bash
npm install
npm run compile          # then press F5 in VS Code to launch the extension
npm test                 # quick tests (script splitter, error hints, ANSI JOIN, completion helpers)
npm run package          # builds dbexplorer-<version>.vsix (npx vsce package)
```

**Integration tests on real databases** (SQLite always; PostgreSQL and MySQL when started):

```bash
docker compose -f test/docker-compose.yml up -d
npm run test:integration
docker compose -f test/docker-compose.yml down
```

They cover queries, paging, commit / rollback, errors, explain plan, query cancellation, routines and their parameters.

Project layout: `src/extension.ts` (commands), `src/runner.ts` (execution), `src/completion.ts` (completion), `src/resultsPanel.ts` (results webview), `src/drivers/` (one file per database), `src/views/` (sidebar views). UI strings: `src/i18n.ts` + `src/i18nFr.ts` (runtime) and `package.nls*.json` (manifest).

## Contributing

Issues and pull requests are welcome. Please run `npm test` (and `npm run test:integration` if you touch a driver) before opening a PR, and add the English string and its French translation for any new message.

## Known limits

- SQL Server is not supported. No PL/SQL debugger, no session browser.
- SQLite statements cannot be interrupted (the engine is synchronous).
- Oracle-specific paths need more testing on real servers (see the note at the top).

## License

[MIT](LICENSE)
