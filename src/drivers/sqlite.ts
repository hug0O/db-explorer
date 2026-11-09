import { t } from '../i18n';
import { Database } from 'node-sqlite3-wasm';
import * as fs from 'fs';
import { Category, ColInfo, DbConn, FoundObject, ForeignKey, Profile, QueryColumn, ResultCursor, groupForeignKeys, plainBind, toPositional } from './types';

const CATS: Category[] = [
  { type: 'TABLE', label: t('Tables'), icon: 'symbol-class' },
  { type: 'VIEW', label: t('Views'), icon: 'eye' },
  { type: 'INDEX', label: t('Indexes'), icon: 'list-ordered' },
  { type: 'TRIGGER', label: t('Triggers'), icon: 'zap' },
];
const QUERY_RE = /^\s*(\(\s*)*(select|with|pragma|values|explain)\b/i;

type Vals = Record<string, string | number | bigint | Uint8Array | null | boolean>;

export function connectSqlite(p: Profile): DbConn {
  const file = p.database?.trim();
  if (file && !fs.existsSync(file)) {
    // SQLite crée le fichier ; on accepte, mais seulement si le dossier existe
  }
  return new SqliteConn(new Database(file || ':memory:'));
}

function named(binds: Record<string, unknown>): Vals | undefined {
  const keys = Object.keys(binds);
  if (!keys.length) return undefined;
  const out: Vals = {};
  for (const k of keys) {
    const v = binds[k];
    const pv = plainBind(v);
    out[(/^\d+$/.test(k) ? '?' : ':') + k] = (pv === undefined ? null : pv) as Vals[string];
  }
  return out;
}

class SqliteConn implements DbConn {
  readonly kind = 'sqlite' as const;
  readonly features = { schemas: false, plsql: false, dbmsOutput: false, transactions: true };
  currentSchema = 'main';

  constructor(private readonly db: Database) {}

  private all<T = Record<string, unknown>>(sql: string, values?: unknown[]): T[] {
    return this.db.all(sql, values as never) as unknown as T[];
  }

  isQuery(sql: string) {
    return QUERY_RE.test(sql);
  }

  async open(sql: string, binds: Record<string, unknown>): Promise<ResultCursor> {
    const stmt = this.db.prepare(sql);
    const it = stmt.iterate(named(binds));
    const first = it.next();
    const columns = first.done ? [] : Object.keys(first.value).map((name) => ({ name, type: '' }));
    let pending = first.done ? undefined : first.value;
    let done = !!first.done;
    const toRow = (o: Record<string, unknown>) => columns.map((c) => (o[c.name] instanceof Uint8Array ? Buffer.from(o[c.name] as Uint8Array) : o[c.name] ?? null));
    return {
      columns,
      getRows: async (n) => {
        const rows: unknown[][] = [];
        while (rows.length < n && !done) {
          if (pending) {
            rows.push(toRow(pending));
            pending = undefined;
            continue;
          }
          const r = it.next();
          if (r.done) done = true;
          else rows.push(toRow(r.value));
        }
        return rows;
      },
      close: async () => {
        try {
          stmt.finalize();
        } catch {
          /* déjà finalisé */
        }
      },
    };
  }

  async exec(sql: string, binds: Record<string, unknown>, autoCommit: boolean) {
    if (!autoCommit && !this.db.inTransaction) this.db.exec('BEGIN');
    const r = this.db.run(sql, named(binds));
    if (autoCommit && this.db.inTransaction) this.db.exec('COMMIT');
    return { rowsAffected: r.changes };
  }

  async commit() {
    if (this.db.inTransaction) this.db.exec('COMMIT');
  }
  async rollback() {
    if (this.db.inTransaction) this.db.exec('ROLLBACK');
  }
  async cancel() {
    /* exécution synchrone : non annulable */
  }
  async close() {
    if (this.db.inTransaction) this.db.exec('ROLLBACK');
    this.db.close();
  }

  categories() {
    return CATS;
  }
  async schemas() {
    return ['main'];
  }
  async useSchema() {}

  async listObjects(type: string, _schema: string, max: number) {
    const rows = this.all<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type=? AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT ${Math.max(1, max)}`,
      [type.toLowerCase()]
    );
    return rows.map((r) => ({ name: r.name, invalid: false }));
  }

  async tableNames() {
    return this.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name`).map((r) => r.name);
  }

  async columns(_schema: string, table: string): Promise<ColInfo[]> {
    const rows = this.all<{ cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number }>(
      `SELECT * FROM pragma_table_info(?)`,
      [table]
    );
    return rows.map((r) => ({ ID: r.cid + 1, NAME: r.name, TYPE: r.type, NULLABLE: r.notnull ? 'N' : 'Y', PK: r.pk > 0, DEF: r.dflt_value, COMMENTS: null }));
  }

  async dependencies(_schema: string, name: string, dir: 'usedBy' | 'uses') {
    const word = (n: string) => new RegExp('(^|[^\\w])["`\\[]?' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '["`\\]]?([^\\w]|$)', 'i');
    const objs = this.all<{ name: string; type: string; sql: string | null }>("SELECT name, type, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'");
    if (dir === 'usedBy') {
      const re = word(name);
      return objs.filter((o) => ['view', 'trigger'].includes(o.type) && o.name.toLowerCase() !== name.toLowerCase() && re.test(o.sql ?? '')).map((o) => ({ schema: 'main', name: o.name, type: o.type.toUpperCase() }));
    }
    const me = objs.find((o) => o.name.toLowerCase() === name.toLowerCase());
    if (!me?.sql) return [];
    return objs.filter((o) => ['table', 'view'].includes(o.type) && o.name.toLowerCase() !== name.toLowerCase() && word(o.name).test(me.sql!)).map((o) => ({ schema: 'main', name: o.name, type: o.type.toUpperCase() }));
  }

  async allColumns() {
    const rows = this.all<{ t: string; n: string; ty: string; pk: number }>(
      "SELECT m.name t, p.name n, p.type ty, p.pk pk FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type IN ('table','view') AND m.name NOT LIKE 'sqlite_%' ORDER BY m.name, p.cid"
    );
    return rows.map((r) => ({ table: r.t, name: r.n, type: r.ty, pk: r.pk > 0 }));
  }

  async foreignKeys(): Promise<ForeignKey[]> {
    const rows = this.all<{ t: string; id: number; seq: number; rt: string; fc: string; tc: string | null }>(
      "SELECT m.name t, f.id id, f.seq seq, f.\"table\" rt, f.\"from\" fc, f.\"to\" tc FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f WHERE m.type='table' ORDER BY m.name, f.id, f.seq"
    );
    const pkOf = new Map<string, string[]>();
    const need = (t: string) => {
      if (!pkOf.has(t)) pkOf.set(t, this.all<{ name: string }>('SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk', [t]).map((x) => x.name));
      return pkOf.get(t)!;
    };
    return groupForeignKeys(rows.map((r) => ({ fk: 'fk_' + r.id, table: r.t, col: r.fc, refSchema: 'main', refTable: r.rt, refCol: r.tc ?? need(r.rt)[r.seq] ?? r.fc })));
  }

  async indexes(_schema: string, table: string) {
    const list = this.all<{ name: string; unique: number }>(`SELECT name, "unique" FROM pragma_index_list(?)`, [table]);
    return list.map((i) => ({
      name: i.name,
      unique: !!i.unique,
      cols: this.all<{ name: string }>(`SELECT name FROM pragma_index_info(?) ORDER BY seqno`, [i.name]).map((c) => c.name).join(', '),
    }));
  }

  async constraints(_schema: string, table: string) {
    const out: { name: string; type: string; status: string; cols: string; ref: string | null }[] = [];
    const pk = (await this.columns('main', table)).filter((c) => c.PK).map((c) => c.NAME);
    if (pk.length) out.push({ name: 'PRIMARY KEY', type: 'PK', status: 'ENABLED', cols: pk.join(', '), ref: null });
    const fks = this.all<{ id: number; table: string; from: string; to: string | null }>(`SELECT id, "table", "from", "to" FROM pragma_foreign_key_list(?) ORDER BY id, seq`, [table]);
    const byId = new Map<number, { table: string; from: string[]; to: string[] }>();
    for (const f of fks) {
      const e = byId.get(f.id) ?? { table: f.table, from: [], to: [] };
      e.from.push(f.from);
      if (f.to) e.to.push(f.to);
      byId.set(f.id, e);
    }
    for (const [id, f] of byId) out.push({ name: `FK_${id}`, type: 'FK', status: 'ENABLED', cols: f.from.join(', '), ref: `${f.table}(${f.to.join(', ')})` });
    return out;
  }

  async ddl(type: string, _schema: string, name: string) {
    const r = this.all<{ sql: string | null }>(`SELECT sql FROM sqlite_master WHERE type=? AND name=?`, [type.toLowerCase(), name]);
    let text = (r[0]?.sql ?? '').trim();
    if (!text) throw new Error(t('DDL not found'));
    if (type === 'TABLE') {
      const idx = this.all<{ sql: string | null }>(`SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL`, [name]);
      text += ';' + idx.map((i) => '\n' + i.sql + ';').join('');
    } else text += ';';
    return text + '\n';
  }

  async findObject(_schema: string, name: string): Promise<FoundObject | undefined> {
    const r = this.all<{ type: string; name: string }>(
      "SELECT type, name FROM sqlite_master WHERE name = ? COLLATE NOCASE AND type IN ('table','view','index','trigger') ORDER BY CASE type WHEN 'table' THEN 1 WHEN 'view' THEN 2 ELSE 3 END",
      [name.replace(/^["`\[]|["`\]]$/g, '')]
    );
    return r[0] ? { type: r[0].type.toUpperCase(), schema: 'main', name: r[0].name } : undefined;
  }

  async describeQuery(sql: string, binds: Record<string, unknown>): Promise<QueryColumn[]> {
    // vue temporaire : donne noms et types déclarés même sans aucune ligne
    const nb: Record<string, unknown> = {};
    for (const k of Object.keys(binds)) nb[k] = null;
    const inline = toPositional(sql, nb, '$').sql.replace(/\$\d+/g, 'NULL');
    this.db.exec('DROP VIEW IF EXISTS temp.dbx_describe');
    this.db.exec('CREATE TEMP VIEW dbx_describe AS ' + inline);
    let info: { name: string; type: string; notnull: number }[];
    try {
      info = this.all("SELECT * FROM pragma_table_info('dbx_describe')");
    } finally {
      this.db.exec('DROP VIEW IF EXISTS temp.dbx_describe');
    }
    // type observé sur une ligne pour les expressions sans type déclaré
    let row: Record<string, unknown> | undefined;
    if (info.some((c) => !c.type)) {
      const stmt = this.db.prepare('SELECT * FROM (' + sql + ') LIMIT 1');
      try {
        row = (stmt.get(named(nb)) as Record<string, unknown> | null) ?? undefined;
      } finally {
        stmt.finalize();
      }
    }
    const jsType = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'number' ? (Number.isInteger(v) ? 'INTEGER' : 'REAL') : typeof v === 'bigint' ? 'INTEGER' : v instanceof Uint8Array ? 'BLOB' : 'TEXT');
    return info.map((c) => ({ name: c.name, type: c.type || jsType(row?.[c.name]) || '(expression)', nullable: c.type ? !c.notnull : undefined }));
  }

  async explain(sql: string, binds: Record<string, unknown>) {
    const rows = this.db.all('EXPLAIN QUERY PLAN ' + sql, named(binds)) as unknown as { id: number; parent: number; detail: string }[];
    const depth = new Map<number, number>([[0, -1]]);
    return rows
      .map((r) => {
        const d = (depth.get(r.parent) ?? -1) + 1;
        depth.set(r.id, d);
        return '  '.repeat(d) + (d ? '└─ ' : '') + r.detail;
      })
      .join('\n');
  }
}
