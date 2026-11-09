import { t } from '../i18n';
import * as mysql from 'mysql2/promise';
import { Category, ColInfo, DbConn, FoundObject, ForeignKey, Profile, QueryColumn, ResultCursor, groupForeignKeys, toPositional } from './types';

const CATS: Category[] = [
  { type: 'TABLE', label: t('Tables'), icon: 'symbol-class' },
  { type: 'VIEW', label: t('Views'), icon: 'eye' },
  { type: 'PROCEDURE', label: t('Procedures'), icon: 'symbol-method' },
  { type: 'FUNCTION', label: t('Functions'), icon: 'symbol-function' },
  { type: 'TRIGGER', label: t('Triggers'), icon: 'zap' },
];
const QUERY_RE = /^\s*(\(\s*)*(select|with|show|describe|desc|explain|values|table)\b/i;
const MAX_ROWS = 200_000;

export async function connectMysql(p: Profile, password: string): Promise<DbConn> {
  const cfg: mysql.ConnectionOptions = {
    host: p.host || 'localhost',
    port: p.port || 3306,
    user: p.user,
    password,
    database: p.database || undefined,
    ssl: p.ssl ? {} : undefined,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
  };
  const conn = await mysql.createConnection(cfg);
  const [r] = await conn.query({ sql: 'SELECT DATABASE()', rowsAsArray: true });
  return new MysqlConn(conn, String((r as unknown[][])[0]?.[0] ?? ''), cfg);
}

class MysqlConn implements DbConn {
  readonly kind = 'mysql' as const;
  readonly features = { schemas: true, plsql: false, dbmsOutput: false, transactions: true };
  private ac = true;
  private running = 0;

  constructor(private readonly conn: mysql.Connection, public currentSchema: string, private readonly cfg: mysql.ConnectionOptions) {}

  private async track<T>(fn: () => Promise<T>): Promise<T> {
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
    }
  }

  private async rows<T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<T[]> {
    const [r] = await this.track(() => this.conn.query(sql, values));
    return r as T[];
  }

  isQuery(sql: string) {
    return QUERY_RE.test(sql);
  }

  async open(sql: string, binds: Record<string, unknown>): Promise<ResultCursor> {
    const { sql: s, values } = toPositional(sql, binds, '?');
    const [rows, fields] = await this.track(() => this.conn.query({ sql: s, rowsAsArray: true }, values));
    const all = (rows as unknown[][]).slice(0, MAX_ROWS);
    const columns = ((fields as mysql.FieldPacket[]) ?? []).map((f) => ({ name: f.name, type: '' }));
    let pos = 0;
    return {
      columns,
      getRows: async (n) => {
        const out = all.slice(pos, pos + n);
        pos += out.length;
        return out;
      },
      close: async () => {
        pos = all.length;
      },
    };
  }

  async exec(sql: string, binds: Record<string, unknown>, autoCommit: boolean) {
    if (this.ac !== autoCommit) {
      await this.conn.query(`SET autocommit=${autoCommit ? 1 : 0}`);
      this.ac = autoCommit;
    }
    const { sql: s, values } = toPositional(sql, binds, '?');
    const [r] = await this.track(() => this.conn.query(s, values));
    return { rowsAffected: (r as mysql.ResultSetHeader).affectedRows };
  }

  async commit() {
    await this.conn.commit();
  }
  async rollback() {
    await this.conn.rollback();
  }
  async setQueryTimeout(seconds: number) {
    await this.conn.query(`SET SESSION max_execution_time = ${Math.max(0, Math.floor(seconds)) * 1000}`).catch(() => undefined);
  }
  /** Interrompt la requête en cours : KILL QUERY <thread> depuis une 2e connexion éphémère. */
  async cancel() {
    if (!this.running) return;
    const id = (this.conn as unknown as { threadId?: number }).threadId;
    if (!id) return;
    let c: mysql.Connection | undefined;
    try {
      c = await mysql.createConnection({ ...this.cfg, connectTimeout: 2000 });
      await c.query(`KILL QUERY ${Number(id)}`);
    } catch {
      /* annulation au mieux */
    } finally {
      await c?.end().catch(() => undefined);
    }
  }
  async close() {
    await this.conn.end();
  }

  categories() {
    return CATS;
  }

  async schemas() {
    return (await this.rows<{ n: string }>(`SELECT schema_name AS n FROM information_schema.schemata ORDER BY 1`)).map((r) => r.n);
  }

  async useSchema(schema: string) {
    await this.conn.query(`USE \`${schema.replace(/`/g, '``')}\``);
    this.currentSchema = schema;
  }

  async listObjects(type: string, schema: string, max: number) {
    let sql: string;
    switch (type) {
      case 'TABLE':
        sql = `SELECT table_name AS n FROM information_schema.tables WHERE table_schema=? AND table_type='BASE TABLE' ORDER BY 1`;
        break;
      case 'VIEW':
        sql = `SELECT table_name AS n FROM information_schema.tables WHERE table_schema=? AND table_type='VIEW' ORDER BY 1`;
        break;
      case 'TRIGGER':
        sql = `SELECT trigger_name AS n FROM information_schema.triggers WHERE trigger_schema=? ORDER BY 1`;
        break;
      default:
        return (
          await this.rows<{ n: string }>(`SELECT routine_name AS n FROM information_schema.routines WHERE routine_schema=? AND routine_type=? ORDER BY 1 LIMIT ${max}`, [schema, type])
        ).map((r) => ({ name: r.n, invalid: false }));
    }
    return (await this.rows<{ n: string }>(`${sql} LIMIT ${max}`, [schema])).map((r) => ({ name: r.n, invalid: false }));
  }

  async routines(schema: string) {
    const rows = await this.rows<{ n: string; k: string }>(`SELECT routine_name AS n, routine_type AS k FROM information_schema.routines WHERE routine_schema=? ORDER BY 1 LIMIT 5000`, [schema]);
    return rows.map((r) => ({ name: r.n, type: (r.k === 'PROCEDURE' ? 'PROCEDURE' : 'FUNCTION') as 'PROCEDURE' | 'FUNCTION' }));
  }

  async routineArgs(schema: string, _pkg: string | undefined, name: string) {
    const rows = await this.rows<{ n: string | null; t: string; m: string | null; o: number }>(
      `SELECT parameter_name AS n, dtd_identifier AS t, parameter_mode AS m, ordinal_position AS o FROM information_schema.parameters WHERE specific_schema=? AND specific_name=? ORDER BY ordinal_position`,
      [schema, name]
    );
    return rows.map((r) => ({ name: r.n ?? '', type: r.t, dir: (r.m === 'OUT' ? 'out' : r.m === 'INOUT' ? 'inout' : 'in') as 'in' | 'out' | 'inout', pos: Number(r.o), isReturn: Number(r.o) === 0 }));
  }

  async tableNames(schema: string) {
    return (await this.rows<{ n: string }>(`SELECT table_name AS n FROM information_schema.tables WHERE table_schema=? ORDER BY 1 LIMIT 3000`, [schema])).map((r) => r.n);
  }

  async columns(schema: string, table: string): Promise<ColInfo[]> {
    const rows = await this.rows<{ id: number; name: string; type: string; nl: string; pk: string; def: string | null; cm: string | null }>(
      `SELECT ordinal_position AS id, column_name AS name, column_type AS type, is_nullable AS nl, column_key AS pk, column_default AS def, column_comment AS cm
         FROM information_schema.columns WHERE table_schema=? AND table_name=? ORDER BY ordinal_position`,
      [schema, table]
    );
    return rows.map((r) => ({ ID: Number(r.id), NAME: r.name, TYPE: r.type, NULLABLE: r.nl === 'NO' ? 'N' : 'Y', PK: r.pk === 'PRI', DEF: r.def, COMMENTS: r.cm || null }));
  }

  async dependencies(schema: string, name: string, dir: 'usedBy' | 'uses') {
    try {
      const rows =
        dir === 'usedBy'
          ? await this.rows<{ s: string; n: string }>('SELECT view_schema AS s, view_name AS n FROM information_schema.view_table_usage WHERE table_schema=? AND table_name=?', [schema, name])
          : await this.rows<{ s: string; n: string }>('SELECT table_schema AS s, table_name AS n FROM information_schema.view_table_usage WHERE view_schema=? AND view_name=?', [schema, name]);
      return rows.map((r) => ({ schema: r.s, name: r.n, type: dir === 'usedBy' ? 'VIEW' : 'TABLE' }));
    } catch {
      if (dir === 'uses') return [];
      // MySQL < 8.0.13 / MariaDB : recherche du nom dans la définition des vues
      const rows = await this.rows<{ s: string; n: string; d: string }>('SELECT table_schema AS s, table_name AS n, view_definition AS d FROM information_schema.views WHERE table_schema=?', [schema]);
      const re = new RegExp('(^|[^\\w])`?' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '`?([^\\w]|$)', 'i');
      return rows.filter((r) => re.test(r.d ?? '')).map((r) => ({ schema: r.s, name: r.n, type: 'VIEW' }));
    }
  }

  async allColumns(schema: string) {
    const rows = await this.rows<{ t: string; n: string; ty: string; pk: string; cm: string }>(
      'SELECT table_name AS t, column_name AS n, column_type AS ty, column_key AS pk, column_comment AS cm FROM information_schema.columns WHERE table_schema=? ORDER BY table_name, ordinal_position',
      [schema]
    );
    return rows.map((r) => ({ table: r.t, name: r.n, type: r.ty, pk: r.pk === 'PRI', comment: r.cm || undefined }));
  }

  async foreignKeys(schema: string): Promise<ForeignKey[]> {
    const rows = await this.rows<{ fk: string; t: string; c: string; rs: string; rt: string; rc: string }>(
      'SELECT constraint_name AS fk, table_name AS t, column_name AS c, referenced_table_schema AS rs, referenced_table_name AS rt, referenced_column_name AS rc FROM information_schema.key_column_usage WHERE table_schema=? AND referenced_table_name IS NOT NULL ORDER BY table_name, constraint_name, ordinal_position',
      [schema]
    );
    return groupForeignKeys(rows.map((r) => ({ fk: r.fk, table: r.t, col: r.c, refSchema: r.rs, refTable: r.rt, refCol: r.rc })));
  }

  async indexes(schema: string, table: string) {
    const rows = await this.rows<{ n: string; nu: number; c: string }>(
      `SELECT index_name AS n, MIN(non_unique) AS nu, GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ', ') AS c
         FROM information_schema.statistics WHERE table_schema=? AND table_name=? GROUP BY index_name ORDER BY index_name`,
      [schema, table]
    );
    return rows.map((r) => ({ name: r.n, unique: Number(r.nu) === 0, cols: r.c }));
  }

  async constraints(schema: string, table: string) {
    const rows = await this.rows<{ n: string; t: string; c: string | null; r: string | null }>(
      `SELECT tc.constraint_name AS n, tc.constraint_type AS t,
              GROUP_CONCAT(k.column_name ORDER BY k.ordinal_position SEPARATOR ', ') AS c,
              MAX(CONCAT(k.referenced_table_name,'(',k.referenced_column_name,')')) AS r
         FROM information_schema.table_constraints tc
         LEFT JOIN information_schema.key_column_usage k
           ON k.constraint_schema=tc.constraint_schema AND k.constraint_name=tc.constraint_name AND k.table_name=tc.table_name
        WHERE tc.table_schema=? AND tc.table_name=? GROUP BY tc.constraint_name, tc.constraint_type`,
      [schema, table]
    );
    const names: Record<string, string> = { 'PRIMARY KEY': 'PK', UNIQUE: 'UK', 'FOREIGN KEY': 'FK', CHECK: 'CHECK' };
    return rows.map((r) => ({ name: r.n, type: names[r.t] ?? r.t, status: 'ENABLED', cols: r.c ?? '', ref: r.r }));
  }

  async ddl(type: string, schema: string, name: string) {
    const q = (s: string) => '`' + s.replace(/`/g, '``') + '`';
    const [rows] = await this.conn.query({ sql: `SHOW CREATE ${type} ${q(schema)}.${q(name)}`, rowsAsArray: true });
    const first = (rows as unknown[][])[0] ?? [];
    const text = first.filter((v): v is string => typeof v === 'string').sort((a, b) => b.length - a.length)[0];
    if (!text) throw new Error(t('DDL not found'));
    return text + ';\n';
  }

  async findObject(schema: string, name: string): Promise<FoundObject | undefined> {
    const n = name.replace(/^`|`$/g, '');
    const t = await this.rows<{ n: string; t: string }>(
      'SELECT table_name AS n, table_type AS t FROM information_schema.tables WHERE table_schema=? AND table_name=?',
      [schema, n]
    );
    if (t[0]) return { type: t[0].t === 'VIEW' ? 'VIEW' : 'TABLE', schema, name: t[0].n };
    const r = await this.rows<{ n: string; t: string }>(
      'SELECT routine_name AS n, routine_type AS t FROM information_schema.routines WHERE routine_schema=? AND routine_name=?',
      [schema, n]
    );
    if (r[0]) return { type: r[0].t, schema, name: r[0].n };
    const g = await this.rows<{ n: string }>('SELECT trigger_name AS n FROM information_schema.triggers WHERE trigger_schema=? AND trigger_name=?', [schema, n]);
    return g[0] ? { type: 'TRIGGER', schema, name: g[0].n } : undefined;
  }

  async describeQuery(sql: string, binds: Record<string, unknown>): Promise<QueryColumn[]> {
    const nb: Record<string, unknown> = {};
    for (const k of Object.keys(binds)) nb[k] = null;
    const { sql: s, values } = toPositional('SELECT * FROM (' + sql + ') AS dbx_q LIMIT 0', nb, '?');
    const [, fields] = await this.conn.query({ sql: s, rowsAsArray: true }, values);
    const types = new Map<number, string>(Object.entries(mysql.Types as unknown as Record<string, number>).map(([k, v]) => [Number(v), k]));
    return ((fields as mysql.FieldPacket[]) ?? []).map((f) => {
      const fp = f as unknown as { columnType?: number; type?: number; columnLength?: number; decimals?: number; flags?: number };
      const code = fp.columnType ?? fp.type ?? -1;
      let type = types.get(code) ?? String(code);
      if (/VAR_STRING|STRING|VARCHAR/.test(type) && fp.columnLength) type = (type === 'STRING' ? 'CHAR' : 'VARCHAR') + '(' + Math.round(fp.columnLength / 4) + ')';
      else if (/DECIMAL/.test(type) && fp.columnLength) type = 'DECIMAL(' + (fp.columnLength - (fp.decimals ? 2 : 1)) + ',' + (fp.decimals ?? 0) + ')';
      return { name: f.name, type, nullable: fp.flags !== undefined ? (fp.flags & 1) === 0 : undefined };
    });
  }

  async explain(sql: string, binds: Record<string, unknown>) {
    const { sql: s, values } = toPositional('EXPLAIN ' + sql, binds, '?');
    const [rows] = await this.conn.query(s, values);
    const list = rows as Record<string, unknown>[];
    if (!list.length) return '';
    const keys = Object.keys(list[0]);
    const lines = [keys.join(' | ')];
    for (const r of list) lines.push(keys.map((k) => String(r[k] ?? 'NULL')).join(' | '));
    return lines.join('\n');
  }
}
