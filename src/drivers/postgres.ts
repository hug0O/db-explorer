import { t } from '../i18n';
import { Client, ClientConfig } from 'pg';
import Cursor from 'pg-cursor';
import { Category, ColInfo, DbConn, FoundObject, ForeignKey, Profile, QueryColumn, ResultCursor, groupForeignKeys, toPositional } from './types';

const CATS: Category[] = [
  { type: 'TABLE', label: t('Tables'), icon: 'symbol-class' },
  { type: 'VIEW', label: t('Views'), icon: 'eye' },
  { type: 'MATERIALIZED VIEW', label: t('Materialized views'), icon: 'server' },
  { type: 'SEQUENCE', label: t('Sequences'), icon: 'symbol-numeric' },
  { type: 'FUNCTION', label: t('Functions'), icon: 'symbol-function' },
  { type: 'PROCEDURE', label: t('Procedures'), icon: 'symbol-method' },
  { type: 'TRIGGER', label: t('Triggers'), icon: 'zap' },
  { type: 'INDEX', label: t('Indexes'), icon: 'list-ordered' },
];
const QUERY_RE = /^\s*(\(\s*)*(select|with|show|values|table|explain)\b/i;

export async function connectPostgres(p: Profile, password: string): Promise<DbConn> {
  const cfg: ClientConfig = {
    host: p.host || 'localhost',
    port: p.port || 5432,
    user: p.user,
    password,
    database: p.database || 'postgres',
    ssl: p.ssl ? { rejectUnauthorized: false } : undefined,
  };
  const client = new Client(cfg);
  await client.connect();
  const r = await client.query('SELECT current_schema() AS s');
  return new PgConn(client, String(r.rows[0]?.s ?? 'public'), cfg);
}

class PgConn implements DbConn {
  readonly kind = 'postgres' as const;
  readonly features = { schemas: true, plsql: false, dbmsOutput: false, transactions: true };
  private inTx = false;
  /** Nombre de requêtes en cours (l'annulation n'ouvre une 2e connexion que s'il y en a). */
  private running = 0;

  constructor(private readonly client: Client, public currentSchema: string, private readonly cfg: ClientConfig) {}

  private async track<T>(fn: () => Promise<T>): Promise<T> {
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
    }
  }

  private async rows<T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<T[]> {
    return (await this.track(() => this.client.query(sql, values))).rows as T[];
  }

  isQuery(sql: string) {
    return QUERY_RE.test(sql);
  }

  /** Dans une transaction, protège chaque instruction par un savepoint. */
  private async guarded<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.inTx) return fn();
    await this.client.query('SAVEPOINT dbx_stmt');
    try {
      const r = await fn();
      await this.client.query('RELEASE SAVEPOINT dbx_stmt');
      return r;
    } catch (e) {
      await this.client.query('ROLLBACK TO SAVEPOINT dbx_stmt').catch(() => undefined);
      throw e;
    }
  }

  async open(sql: string, binds: Record<string, unknown>): Promise<ResultCursor> {
    const { sql: s, values } = toPositional(sql, binds, '$');
    return this.guarded(async () => {
      const cursor = this.client.query(new Cursor(s, values, { rowMode: 'array' })) as Cursor<unknown[]>;
      const first = await this.track(() => cursor.read(1));
      const fields = ((cursor as unknown as { _result?: { fields?: { name: string; dataTypeID: number }[] } })._result?.fields ?? []).map((f) => ({
        name: f.name,
        type: String(f.dataTypeID),
      }));
      let pending = first;
      return {
        columns: fields,
        getRows: async (n: number) => {
          const out = pending.length ? pending : [];
          pending = [];
          if (out.length >= n) return out;
          const more = await this.track(() => cursor.read(n - out.length));
          return [...out, ...more];
        },
        close: async () => {
          await cursor.close().catch(() => undefined);
        },
      };
    });
  }

  async exec(sql: string, binds: Record<string, unknown>, autoCommit: boolean) {
    if (!autoCommit && !this.inTx) {
      await this.client.query('BEGIN');
      this.inTx = true;
    }
    const { sql: s, values } = toPositional(sql, binds, '$');
    const r = await this.track(() => this.guarded(() => this.client.query(s, values.length ? values : undefined)));
    if (autoCommit && this.inTx) {
      await this.client.query('COMMIT');
      this.inTx = false;
    }
    return { rowsAffected: r.rowCount ?? undefined };
  }

  async commit() {
    if (this.inTx) {
      await this.client.query('COMMIT');
      this.inTx = false;
    }
  }
  async rollback() {
    if (this.inTx) {
      await this.client.query('ROLLBACK');
      this.inTx = false;
    }
  }
  async setQueryTimeout(seconds: number) {
    await this.client.query(`SET statement_timeout = ${Math.max(0, Math.floor(seconds)) * 1000}`);
  }
  /** Interrompt la requête en cours : pg_cancel_backend(pid) depuis une 2e connexion éphémère. */
  async cancel() {
    if (!this.running) return;
    const pid = (this.client as unknown as { processID?: number }).processID;
    if (!pid) return;
    const c = new Client({ ...this.cfg, connectionTimeoutMillis: 2000 });
    try {
      await c.connect();
      await c.query('SELECT pg_cancel_backend($1)', [pid]);
    } catch {
      /* annulation au mieux */
    } finally {
      await c.end().catch(() => undefined);
    }
  }
  async close() {
    await this.client.end();
  }

  categories() {
    return CATS;
  }

  async schemas() {
    return (await this.rows<{ n: string }>(`SELECT schema_name n FROM information_schema.schemata WHERE schema_name NOT LIKE 'pg\\_%' AND schema_name <> 'information_schema' ORDER BY 1`)).map((r) => r.n);
  }

  async useSchema(schema: string) {
    await this.client.query(`SET search_path TO "${schema.replace(/"/g, '""')}"`);
    this.currentSchema = schema;
  }

  async listObjects(type: string, schema: string, max: number) {
    const rel = (kinds: string) =>
      this.rows<{ n: string }>(
        `SELECT c.relname n FROM pg_class c JOIN pg_namespace s ON s.oid=c.relnamespace WHERE s.nspname=$1 AND c.relkind = ANY($2) ORDER BY 1 LIMIT ${max}`,
        [schema, kinds.split('')]
      );
    let rows: { n: string }[];
    switch (type) {
      case 'TABLE':
        rows = await rel('rp');
        break;
      case 'VIEW':
        rows = await rel('v');
        break;
      case 'MATERIALIZED VIEW':
        rows = await rel('m');
        break;
      case 'SEQUENCE':
        rows = await rel('S');
        break;
      case 'INDEX':
        rows = await rel('i');
        break;
      case 'FUNCTION':
      case 'PROCEDURE':
        rows = await this.rows(
          `SELECT DISTINCT p.proname n FROM pg_proc p JOIN pg_namespace s ON s.oid=p.pronamespace WHERE s.nspname=$1 AND p.prokind=$2 ORDER BY 1 LIMIT ${max}`,
          [schema, type === 'FUNCTION' ? 'f' : 'p']
        );
        break;
      default:
        rows = await this.rows(
          `SELECT DISTINCT t.tgname n FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace s ON s.oid=c.relnamespace WHERE s.nspname=$1 AND NOT t.tgisinternal ORDER BY 1 LIMIT ${max}`,
          [schema]
        );
    }
    return rows.map((r) => ({ name: r.n, invalid: false }));
  }

  async routines(schema: string) {
    const rows = await this.rows<{ n: string; k: string }>(
      `SELECT DISTINCT p.proname n, p.prokind k FROM pg_proc p JOIN pg_namespace s ON s.oid=p.pronamespace WHERE s.nspname=$1 AND p.prokind IN ('f','p') ORDER BY 1 LIMIT 5000`,
      [schema]
    );
    return rows.map((r) => ({ name: r.n, type: (r.k === 'p' ? 'PROCEDURE' : 'FUNCTION') as 'PROCEDURE' | 'FUNCTION' }));
  }

  async routineArgs(schema: string, _pkg: string | undefined, name: string) {
    const rows = await this.rows<{ n: string | null; t: string; m: string; o: number; s: string }>(
      `SELECT p.parameter_name n, p.data_type t, p.parameter_mode m, p.ordinal_position o, p.specific_name s
         FROM information_schema.parameters p JOIN information_schema.routines r ON r.specific_schema=p.specific_schema AND r.specific_name=p.specific_name
        WHERE r.routine_schema=$1 AND r.routine_name=$2 ORDER BY p.specific_name, p.ordinal_position`,
      [schema, name]
    );
    return rows.map((r) => ({ name: r.n ?? '', type: r.t, dir: (r.m === 'OUT' ? 'out' : r.m === 'INOUT' ? 'inout' : 'in') as 'in' | 'out' | 'inout', pos: Number(r.o), overload: r.s }));
  }

  async tableNames(schema: string) {
    return (
      await this.rows<{ n: string }>(
        `SELECT c.relname n FROM pg_class c JOIN pg_namespace s ON s.oid=c.relnamespace WHERE s.nspname=$1 AND c.relkind IN ('r','p','v','m') ORDER BY 1 LIMIT 3000`,
        [schema]
      )
    ).map((r) => r.n);
  }

  async columns(schema: string, table: string): Promise<ColInfo[]> {
    const rows = await this.rows<{ id: number; name: string; type: string; nn: boolean; def: string | null; cm: string | null; pk: boolean }>(
      `SELECT a.attnum id, a.attname name, format_type(a.atttypid, a.atttypmod) type, a.attnotnull nn,
              pg_get_expr(d.adbin, d.adrelid) def, col_description(a.attrelid, a.attnum) cm,
              EXISTS(SELECT 1 FROM pg_constraint k WHERE k.conrelid=a.attrelid AND k.contype='p' AND a.attnum = ANY(k.conkey)) pk
         FROM pg_attribute a
         JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace s ON s.oid=c.relnamespace
         LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE s.nspname=$1 AND c.relname=$2 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,
      [schema, table]
    );
    return rows.map((r) => ({ ID: Number(r.id), NAME: r.name, TYPE: r.type, NULLABLE: r.nn ? 'N' : 'Y', PK: r.pk, DEF: r.def, COMMENTS: r.cm }));
  }

  async dependencies(schema: string, name: string, dir: 'usedBy' | 'uses') {
    const kind = "CASE c%1.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END";
    const sql =
      dir === 'usedBy'
        ? `SELECT DISTINCT n2.nspname s, c2.relname n, ${kind.replace('%1', '2')} t
             FROM pg_depend d JOIN pg_rewrite r ON r.oid=d.objid AND d.classid='pg_rewrite'::regclass
             JOIN pg_class c2 ON c2.oid=r.ev_class JOIN pg_namespace n2 ON n2.oid=c2.relnamespace
             JOIN pg_class c1 ON c1.oid=d.refobjid JOIN pg_namespace n1 ON n1.oid=c1.relnamespace
            WHERE n1.nspname=$1 AND c1.relname=$2 AND c2.oid<>c1.oid`
        : `SELECT DISTINCT n1.nspname s, c1.relname n, ${kind.replace('%1', '1')} t
             FROM pg_rewrite r JOIN pg_class c2 ON c2.oid=r.ev_class JOIN pg_namespace n2 ON n2.oid=c2.relnamespace
             JOIN pg_depend d ON d.objid=r.oid AND d.classid='pg_rewrite'::regclass AND d.refclassid='pg_class'::regclass
             JOIN pg_class c1 ON c1.oid=d.refobjid JOIN pg_namespace n1 ON n1.oid=c1.relnamespace
            WHERE n2.nspname=$1 AND c2.relname=$2 AND c1.oid<>c2.oid`;
    const rows = await this.rows<{ s: string; n: string; t: string }>(sql, [schema, name]);
    return rows.map((r) => ({ schema: r.s, name: r.n, type: r.t }));
  }

  async allColumns(schema: string) {
    const rows = await this.rows<{ t: string; n: string; ty: string; pk: boolean; cm: string | null }>(
      `SELECT c.relname t, a.attname n, format_type(a.atttypid, a.atttypmod) ty, col_description(a.attrelid, a.attnum) cm,
              EXISTS(SELECT 1 FROM pg_constraint k WHERE k.conrelid=a.attrelid AND k.contype='p' AND a.attnum = ANY(k.conkey)) pk
         FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace s ON s.oid=c.relnamespace
        WHERE s.nspname=$1 AND c.relkind IN ('r','p','v','m') AND a.attnum>0 AND NOT a.attisdropped
        ORDER BY c.relname, a.attnum`,
      [schema]
    );
    return rows.map((r) => ({ table: r.t, name: r.n, type: r.ty, pk: r.pk, comment: r.cm ?? undefined }));
  }

  async foreignKeys(schema: string): Promise<ForeignKey[]> {
    const rows = await this.rows<{ fk: string; t: string; c: string; rs: string; rt: string; rc: string }>(
      `SELECT c.conname fk, cl.relname t, a.attname c, fn.nspname rs, fcl.relname rt, fa.attname rc
         FROM pg_constraint c
         JOIN pg_class cl ON cl.oid=c.conrelid JOIN pg_namespace n ON n.oid=cl.relnamespace
         JOIN pg_class fcl ON fcl.oid=c.confrelid JOIN pg_namespace fn ON fn.oid=fcl.relnamespace
         CROSS JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS u(ck, fk, ord)
         JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=u.ck
         JOIN pg_attribute fa ON fa.attrelid=c.confrelid AND fa.attnum=u.fk
        WHERE c.contype='f' AND n.nspname=$1
        ORDER BY cl.relname, c.conname, u.ord`,
      [schema]
    );
    return groupForeignKeys(rows.map((r) => ({ fk: r.fk, table: r.t, col: r.c, refSchema: r.rs, refTable: r.rt, refCol: r.rc })));
  }

  async indexes(schema: string, table: string) {
    const rows = await this.rows<{ n: string; u: boolean; def: string }>(
      `SELECT i.relname n, x.indisunique u, pg_get_indexdef(i.oid) def
         FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_class t ON t.oid=x.indrelid JOIN pg_namespace s ON s.oid=t.relnamespace
        WHERE s.nspname=$1 AND t.relname=$2 ORDER BY 1`,
      [schema, table]
    );
    return rows.map((r) => ({ name: r.n, unique: r.u, cols: /\((.*)\)/.exec(r.def)?.[1] ?? '' }));
  }

  async constraints(schema: string, table: string) {
    const rows = await this.rows<{ n: string; t: string; def: string; v: boolean }>(
      `SELECT k.conname n, k.contype t, pg_get_constraintdef(k.oid) def, k.convalidated v
         FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace s ON s.oid=c.relnamespace
        WHERE s.nspname=$1 AND c.relname=$2 ORDER BY k.contype, k.conname`,
      [schema, table]
    );
    const names: Record<string, string> = { p: 'PK', u: 'UK', f: 'FK', c: 'CHECK', x: 'EXCLUDE' };
    return rows.map((r) => ({ name: r.n, type: names[r.t] ?? r.t, status: r.v ? 'ENABLED' : 'NOT VALID', cols: r.def, ref: null }));
  }

  async ddl(type: string, schema: string, name: string) {
    const q = (s: string) => '"' + s.replace(/"/g, '""') + '"';
    const full = `${q(schema)}.${q(name)}`;
    switch (type) {
      case 'VIEW':
      case 'MATERIALIZED VIEW': {
        const r = await this.rows<{ d: string }>(`SELECT pg_get_viewdef($1::regclass, true) d`, [full]);
        return `CREATE ${type === 'VIEW' ? 'OR REPLACE VIEW' : 'MATERIALIZED VIEW'} ${full} AS\n${r[0]?.d}\n`;
      }
      case 'FUNCTION':
      case 'PROCEDURE': {
        const r = await this.rows<{ d: string }>(
          `SELECT pg_get_functiondef(p.oid) d FROM pg_proc p JOIN pg_namespace s ON s.oid=p.pronamespace WHERE s.nspname=$1 AND p.proname=$2`,
          [schema, name]
        );
        return r.map((x) => x.d.trim() + ';').join('\n\n') + '\n';
      }
      case 'TRIGGER': {
        const r = await this.rows<{ d: string }>(`SELECT pg_get_triggerdef(oid) d FROM pg_trigger WHERE tgname=$1 AND NOT tgisinternal`, [name]);
        return r.map((x) => x.d + ';').join('\n') + '\n';
      }
      case 'INDEX': {
        const r = await this.rows<{ d: string }>(`SELECT indexdef d FROM pg_indexes WHERE schemaname=$1 AND indexname=$2`, [schema, name]);
        return (r[0]?.d ?? '') + ';\n';
      }
      case 'SEQUENCE': {
        const r = await this.rows<Record<string, unknown>>(
          `SELECT start_value, increment_by, min_value, max_value, cycle FROM pg_sequences WHERE schemaname=$1 AND sequencename=$2`,
          [schema, name]
        );
        const s = r[0] ?? {};
        return `CREATE SEQUENCE ${full}\n  START WITH ${s.start_value} INCREMENT BY ${s.increment_by}\n  MINVALUE ${s.min_value} MAXVALUE ${s.max_value}${s.cycle ? ' CYCLE' : ' NO CYCLE'};\n`;
      }
      default: {
        const cols = await this.columns(schema, name);
        const cons = await this.constraints(schema, name);
        const lines = [
          ...cols.map((c) => `  ${q(c.NAME)} ${c.TYPE}${c.DEF ? ' DEFAULT ' + c.DEF : ''}${c.NULLABLE === 'N' ? ' NOT NULL' : ''}`),
          ...cons.map((c) => `  CONSTRAINT ${q(c.name)} ${c.cols}`),
        ];
        const idx = await this.rows<{ d: string }>(
          `SELECT indexdef d FROM pg_indexes WHERE schemaname=$1 AND tablename=$2 AND indexname NOT IN (SELECT conname FROM pg_constraint)`,
          [schema, name]
        );
        return `CREATE TABLE ${full} (\n${lines.join(',\n')}\n);\n` + idx.map((i) => '\n' + i.d + ';').join('') + '\n';
      }
    }
  }

  async findObject(schema: string, name: string): Promise<FoundObject | undefined> {
    const n = name.replace(/^"|"$/g, '');
    const rel = await this.rows<{ n: string; k: string }>(
      "SELECT c.relname n, c.relkind k FROM pg_class c JOIN pg_namespace s ON s.oid=c.relnamespace WHERE c.relname IN ($1, lower($1)) AND s.nspname = $2 AND c.relkind IN ('r','p','v','m','S','i') LIMIT 1",
      [n, schema]
    );
    const kinds: Record<string, string> = { r: 'TABLE', p: 'TABLE', v: 'VIEW', m: 'MATERIALIZED VIEW', S: 'SEQUENCE', i: 'INDEX' };
    if (rel[0]) return { type: kinds[rel[0].k], schema, name: rel[0].n };
    const fn = await this.rows<{ n: string; k: string }>(
      'SELECT p.proname n, p.prokind k FROM pg_proc p JOIN pg_namespace s ON s.oid=p.pronamespace WHERE s.nspname=$2 AND p.proname IN ($1, lower($1)) LIMIT 1',
      [n, schema]
    );
    if (fn[0]) return { type: fn[0].k === 'p' ? 'PROCEDURE' : 'FUNCTION', schema, name: fn[0].n };
    const tg = await this.rows<{ n: string }>('SELECT DISTINCT tgname n FROM pg_trigger WHERE tgname IN ($1, lower($1)) AND NOT tgisinternal LIMIT 1', [n]);
    return tg[0] ? { type: 'TRIGGER', schema, name: tg[0].n } : undefined;
  }

  async describeQuery(sql: string, binds: Record<string, unknown>): Promise<QueryColumn[]> {
    const nb: Record<string, unknown> = {};
    for (const k of Object.keys(binds)) nb[k] = null;
    const { sql: s, values } = toPositional('SELECT * FROM (' + sql + ') AS dbx_q LIMIT 0', nb, '$');
    const r = await this.guarded(() => this.client.query(s, values.length ? values : undefined));
    const out: QueryColumn[] = [];
    for (const f of r.fields) {
      const t = await this.rows<{ t: string }>('SELECT format_type($1::oid, $2::int) t', [f.dataTypeID, f.dataTypeModifier]);
      out.push({ name: f.name, type: t[0]?.t ?? String(f.dataTypeID) });
    }
    return out;
  }

  async explain(sql: string, binds: Record<string, unknown>) {
    const { sql: s, values } = toPositional('EXPLAIN ' + sql, binds, '$');
    const r = await this.client.query({ text: s, values: values.length ? values : undefined, rowMode: 'array' });
    return (r.rows as string[][]).map((x) => x[0]).join('\n');
  }
}
