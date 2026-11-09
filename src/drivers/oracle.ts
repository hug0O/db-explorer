import { t } from '../i18n';
import oracledb from 'oracledb';
import { Category, ColInfo, CompileIssue, DbConn, ExecResult, FoundObject, ForeignKey, Profile, QueryColumn, ResultCursor, groupForeignKeys, isBindSpec } from './types';
import { findTnsAdmin } from './tns';

const CATS: Category[] = [
  { type: 'TABLE', label: t('Tables'), icon: 'symbol-class' },
  { type: 'VIEW', label: t('Views'), icon: 'eye' },
  { type: 'MATERIALIZED VIEW', label: t('Materialized views'), icon: 'server' },
  { type: 'SEQUENCE', label: t('Sequences'), icon: 'symbol-numeric' },
  { type: 'PROCEDURE', label: t('Procedures'), icon: 'symbol-method' },
  { type: 'FUNCTION', label: t('Functions'), icon: 'symbol-function' },
  { type: 'PACKAGE', label: t('Packages'), icon: 'package' },
  { type: 'TRIGGER', label: t('Triggers'), icon: 'zap' },
  { type: 'TYPE', label: t('Types'), icon: 'symbol-struct' },
  { type: 'SYNONYM', label: t('Synonyms'), icon: 'link' },
  { type: 'INDEX', label: t('Indexes'), icon: 'list-ordered' },
];

const QUERY_RE = /^\s*(\(\s*)*(select|with)\b/i;
const CREATE_SRC_RE =
  /^create\s+(?:or\s+replace\s+)?(?:(?:non)?editionable\s+)?(procedure|function|package\s+body|package|trigger|type\s+body|type)\s+(?:("?)([\w$#]+)\2\.)?("?)([\w$#]+)\4/i;

let initDone = false;
export function initOracle(libDir: string | undefined, warn: (m: string) => void) {
  if (initDone) return;
  initDone = true;
  oracledb.fetchAsString = [oracledb.CLOB];
  oracledb.fetchAsBuffer = [oracledb.BLOB];
  oracledb.outFormat = oracledb.OUT_FORMAT_ARRAY;
  if (libDir) {
    try {
      oracledb.initOracleClient({ libDir });
    } catch (e) {
      warn(t('Cannot initialize Instant Client ({0}). Thin mode used.', (e as Error).message));
    }
  }
}

export async function connectOracle(
  p: Profile,
  password: string,
  opts: { dateFormat: string; timestampFormat: string; defaultTnsAdmin?: string }
): Promise<DbConn> {
  const tns = findTnsAdmin(p.tnsAdmin ?? opts.defaultTnsAdmin);
  if (tns) {
    process.env.TNS_ADMIN = tns;
    (oracledb as unknown as { configDir?: string }).configDir = tns;
  }
  const attrs: oracledb.ConnectionAttributes = { user: p.user, password, connectString: p.connectString };
  if (p.role === 'SYSDBA') attrs.privilege = oracledb.SYSDBA;
  if (p.role === 'SYSOPER') attrs.privilege = oracledb.SYSOPER;
  const conn = await oracledb.getConnection(attrs);
  await conn.execute(`ALTER SESSION SET NLS_DATE_FORMAT = '${opts.dateFormat}' NLS_TIMESTAMP_FORMAT = '${opts.timestampFormat}'`);
  const r = await conn.execute<[string]>(`SELECT sys_context('USERENV','CURRENT_SCHEMA') FROM dual`);
  const su = await conn.execute<[string]>(`SELECT sys_context('USERENV','SESSION_USER') FROM dual`);
  return new OracleConn(conn, String(r.rows?.[0]?.[0] ?? (p.user ?? '').toUpperCase()), String(su.rows?.[0]?.[0] ?? (p.user ?? '').toUpperCase()));
}

/** Convertit les BindSpec en paramètres node-oracledb. */
function toOracleBinds(binds: Record<string, unknown>): oracledb.BindParameters {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(binds)) {
    if (!isBindSpec(v)) {
      out[k] = v;
      continue;
    }
    const dir = v.dir === 'out' ? oracledb.BIND_OUT : v.dir === 'inout' ? oracledb.BIND_INOUT : oracledb.BIND_IN;
    const empty = v.val === null || v.val === '';
    let type: unknown = oracledb.STRING;
    let val: unknown = empty ? null : v.val;
    if (v.type === 'number') {
      type = oracledb.NUMBER;
      if (!empty) val = Number(v.val);
    } else if (v.type === 'cursor') type = oracledb.CURSOR;
    else if (v.type === 'date' && !empty) {
      const d = new Date(String(v.val).replace(' ', 'T'));
      if (!Number.isNaN(d.getTime())) {
        type = oracledb.DATE;
        val = d;
      }
    }
    const spec: Record<string, unknown> = { dir, type };
    if (dir !== oracledb.BIND_OUT || type === oracledb.CURSOR) {
      if (type !== oracledb.CURSOR || dir !== oracledb.BIND_OUT) spec.val = val;
    }
    if (type === oracledb.STRING && dir !== oracledb.BIND_IN) spec.maxSize = v.type === 'clob' ? 1_000_000 : 32767;
    out[k] = spec;
  }
  return out as oracledb.BindParameters;
}

function wrapResultSet(rs: oracledb.ResultSet<unknown[]>): ResultCursor {
  return {
    columns: (rs.metaData ?? []).map((m) => ({ name: m.name, type: m.dbTypeName ?? '' })),
    getRows: (n) => rs.getRows(n),
    close: () => rs.close(),
  };
}

class OracleConn implements DbConn {
  readonly kind = 'oracle' as const;
  readonly features = { schemas: true, plsql: true, dbmsOutput: true, transactions: true };

  constructor(private readonly conn: oracledb.Connection, public currentSchema: string, private readonly sessionUser: string = currentSchema) {}

  private async rows<T>(sql: string, binds: oracledb.BindParameters = {}, maxRows = 0): Promise<T[]> {
    const r = await this.conn.execute(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT, maxRows });
    return (r.rows ?? []) as T[];
  }

  isQuery(sql: string) {
    return QUERY_RE.test(sql);
  }

  async open(sql: string, binds: Record<string, unknown>): Promise<ResultCursor> {
    const res = await this.conn.execute<unknown[]>(sql, toOracleBinds(binds), {
      resultSet: true,
      fetchArraySize: 500,
      outFormat: oracledb.OUT_FORMAT_ARRAY,
    });
    const rs = res.resultSet!;
    return {
      columns: (res.metaData ?? []).map((m) => ({ name: m.name, type: m.dbTypeName ?? '' })),
      getRows: (n) => rs.getRows(n),
      close: () => rs.close(),
    };
  }

  async exec(sql: string, binds: Record<string, unknown>, autoCommit: boolean): Promise<ExecResult> {
    const r = await this.conn.execute(sql, toOracleBinds(binds), { autoCommit, outFormat: oracledb.OUT_FORMAT_ARRAY });
    let outBinds: Record<string, unknown> | undefined;
    if (r.outBinds && !Array.isArray(r.outBinds)) {
      outBinds = {};
      for (const [k, v] of Object.entries(r.outBinds as Record<string, unknown>)) {
        const rs = v as { getRows?: unknown } | null;
        outBinds[k] = rs && typeof rs.getRows === 'function' ? wrapResultSet(v as oracledb.ResultSet<unknown[]>) : v;
      }
    }
    return { rowsAffected: r.rowsAffected, outBinds };
  }

  commit() {
    return this.conn.commit();
  }
  rollback() {
    return this.conn.rollback();
  }
  async cancel() {
    await this.conn.break();
  }
  async close() {
    await this.conn.close();
  }

  categories() {
    return CATS;
  }

  async schemas() {
    return (await this.rows<{ OWNER: string }>(`SELECT DISTINCT owner FROM all_objects ORDER BY owner`)).map((r) => r.OWNER);
  }

  async useSchema(schema: string) {
    this.currentSchema = schema;
    try {
      await this.conn.execute(`ALTER SESSION SET CURRENT_SCHEMA = ${schema}`);
    } catch {
      /* droits insuffisants : seul le browser change */
    }
  }

  async listObjects(type: string, schema: string, max: number) {
    const extra = type === 'TABLE' ? ` AND object_name NOT IN (SELECT mview_name FROM all_mviews WHERE owner=:o)` : '';
    const rows = await this.rows<{ OBJECT_NAME: string; STATUS: string }>(
      `SELECT object_name, status FROM all_objects WHERE owner=:o AND object_type=:t AND object_name NOT LIKE 'BIN$%'${extra} ORDER BY object_name`,
      { o: schema, t: type },
      max
    );
    return rows.map((r) => ({ name: r.OBJECT_NAME, invalid: r.STATUS !== 'VALID' }));
  }

  async tableNames(schema: string) {
    const rows = await this.rows<{ N: string }>(
      `SELECT object_name n FROM all_objects WHERE owner=:o AND object_type IN ('TABLE','VIEW','SYNONYM','MATERIALIZED VIEW') AND object_name NOT LIKE 'BIN$%' ORDER BY 1`,
      { o: schema },
      3000
    );
    return rows.map((r) => r.N);
  }

  async routines(schema: string) {
    const own = schema.toUpperCase() === this.sessionUser.toUpperCase();
    const types = "('PACKAGE','PROCEDURE','FUNCTION')";
    const rows = own
      ? await this.rows<{ N: string; T: string }>(`SELECT object_name n, object_type t FROM user_objects WHERE object_type IN ${types} ORDER BY 1`, {}, 20000)
      : await this.rows<{ N: string; T: string }>(`SELECT object_name n, object_type t FROM all_objects WHERE owner=:o AND object_type IN ${types} ORDER BY 1`, { o: schema }, 20000);
    return rows.map((r) => ({ name: r.N, type: r.T as 'PACKAGE' | 'PROCEDURE' | 'FUNCTION' }));
  }

  async userTypes(schema: string) {
    const own = schema.toUpperCase() === this.sessionUser.toUpperCase();
    const rows = own
      ? await this.rows<{ N: string }>(`SELECT type_name n FROM user_types ORDER BY 1`, {}, 5000)
      : await this.rows<{ N: string }>(`SELECT type_name n FROM all_types WHERE owner=:o ORDER BY 1`, { o: schema }, 5000);
    return rows.map((r) => r.N).filter((n) => !n.startsWith('SYS_PLSQL_'));
  }

  async routineArgs(schema: string, pkg: string | undefined, name: string) {
    const rows = await this.rows<{ N: string | null; P: number; T: string | null; D: string; O: string | null }>(
      `SELECT argument_name n, position p, NVL(pls_type, data_type) t, in_out d, overload o FROM all_arguments
        WHERE owner=:o AND data_level=0 AND object_name=:n AND ${pkg ? 'package_name=:p' : 'package_name IS NULL'}
        ORDER BY NVL(overload,'0'), sequence`,
      pkg ? { o: schema.toUpperCase(), n: name.toUpperCase(), p: pkg.toUpperCase() } : { o: schema.toUpperCase(), n: name.toUpperCase() },
      2000
    );
    return rows
      .filter((r) => r.N || Number(r.P) === 0)
      .map((r) => ({ name: r.N ?? '', type: r.T ?? '', dir: (r.D === 'OUT' ? 'out' : r.D === 'IN/OUT' ? 'inout' : 'in') as 'in' | 'out' | 'inout', pos: Number(r.P), overload: r.O ?? undefined, isReturn: !r.N }));
  }

  async objectInfos(schema: string) {
    const types = "('TABLE','VIEW','SYNONYM','MATERIALIZED VIEW')";
    const own = schema.toUpperCase() === this.sessionUser.toUpperCase();
    const rows = own
      ? await this.rows<{ N: string; T: string }>(
          `SELECT object_name n, object_type t FROM user_objects WHERE object_type IN ${types} AND object_name NOT LIKE 'BIN$%'`,
          {},
          60000
        )
      : await this.rows<{ N: string; T: string }>(
          `SELECT object_name n, object_type t FROM all_objects WHERE owner=:o AND object_type IN ${types} AND object_name NOT LIKE 'BIN$%'`,
          { o: schema },
          60000
        );
    return rows.map((r) => ({ name: r.N, type: r.T })).sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  }

  /** Recherche par préfixe : schéma courant + synonymes publics, puis autres schémas si peu de résultats. */
  async searchObjects(schema: string, prefix: string, limit: number) {
    const like = prefix.toUpperCase().replace(/[\\%_]/g, '\\$&') + '%';
    const types = "('TABLE','VIEW','MATERIALIZED VIEW','SYNONYM')";
    const own = await this.rows<{ O: string; N: string; T: string }>(
      `SELECT * FROM (SELECT owner o, object_name n, object_type t FROM all_objects
                       WHERE object_name LIKE :p ESCAPE '\\' AND owner IN (:s, 'PUBLIC') AND object_type IN ${types} AND object_name NOT LIKE 'BIN$%'
                       ORDER BY object_name) WHERE ROWNUM <= :n`,
      { p: like, s: schema.toUpperCase(), n: limit }
    );
    const out = own.map((r) => ({ name: r.N, type: r.T, owner: r.O }));
    if (out.length < 8) {
      const other = await this.rows<{ O: string; N: string; T: string }>(
        `SELECT * FROM (SELECT owner o, object_name n, object_type t FROM all_objects
                         WHERE object_name LIKE :p ESCAPE '\\' AND owner NOT IN (:s, 'PUBLIC', 'SYS', 'SYSTEM') AND object_type IN ('TABLE','VIEW')
                         ORDER BY object_name) WHERE ROWNUM <= 30`,
        { p: like, s: schema.toUpperCase() }
      ).catch(() => []);
      out.push(...other.map((r) => ({ name: r.N, type: r.T, owner: r.O })));
    }
    return out;
  }

  private fmtType(dt: string, charLen: number | null, prec: number | null, scale: number | null) {
    if (/^(VARCHAR2|NVARCHAR2|CHAR|NCHAR|RAW)$/.test(dt) && charLen) return `${dt}(${charLen})`;
    if (dt === 'NUMBER' && prec) return `NUMBER(${prec}${scale ? ',' + scale : ''})`;
    return dt;
  }

  async columnsLite(schema: string, table: string) {
    let o = schema.toUpperCase();
    let t = table.toUpperCase();
    const q = (own: string, tb: string) =>
      this.rows<{ N: string; DT: string; CL: number | null; P: number | null; S: number | null }>(
        'SELECT column_name n, data_type dt, char_length cl, data_precision p, data_scale s FROM all_tab_columns WHERE owner=:o AND table_name=:t ORDER BY column_id',
        { o: own, t: tb }
      );
    let rows = await q(o, t);
    if (!rows.length) {
      const syn = await this.rows<{ TO: string; TN: string }>(
        "SELECT table_owner \"TO\", table_name tn FROM all_synonyms WHERE synonym_name=:n AND owner IN (:o,'PUBLIC') ORDER BY CASE owner WHEN 'PUBLIC' THEN 1 ELSE 0 END",
        { n: t, o },
        1
      );
      if (syn[0]) {
        o = syn[0].TO;
        t = syn[0].TN;
        rows = await q(o, t);
      }
    }
    const pk = new Set(
      (
        await this.rows<{ N: string }>(
          "SELECT cc.column_name n FROM all_constraints k JOIN all_cons_columns cc ON cc.owner=k.owner AND cc.constraint_name=k.constraint_name WHERE k.owner=:o AND k.table_name=:t AND k.constraint_type='P'",
          { o, t }
        ).catch(() => [])
      ).map((r) => r.N)
    );
    const cm = new Map(
      (
        await this.rows<{ N: string; C: string }>('SELECT column_name n, comments c FROM all_col_comments WHERE owner=:o AND table_name=:t AND comments IS NOT NULL', { o, t }).catch(() => [])
      ).map((r) => [r.N, r.C] as const)
    );
    return rows.map((r) => ({ name: r.N, type: this.fmtType(r.DT, r.CL, r.P, r.S), pk: pk.has(r.N), comment: cm.get(r.N) }));
  }

  async dependencies(schema: string, name: string, dir: 'usedBy' | 'uses') {
    const b = { o: schema.toUpperCase(), n: name.toUpperCase() };
    const rows =
      dir === 'usedBy'
        ? await this.rows<{ S: string; N: string; T: string }>(
            'SELECT DISTINCT owner s, name n, type t FROM all_dependencies WHERE referenced_owner=:o AND referenced_name=:n AND NOT (owner=:o AND name=:n)',
            b,
            2000
          )
        : await this.rows<{ S: string; N: string; T: string }>(
            "SELECT DISTINCT referenced_owner s, referenced_name n, referenced_type t FROM all_dependencies WHERE owner=:o AND name=:n AND referenced_owner NOT IN ('SYS','PUBLIC','SYSTEM') AND NOT (referenced_owner=:o AND referenced_name=:n)",
            b,
            2000
          );
    return rows.map((r) => ({ schema: r.S, name: r.N, type: r.T }));
  }

  async columnHashes(schema: string) {
    const rows = await this.rows<{ T: string; C: number; H: string }>(
      `SELECT table_name t, COUNT(*) c,
              TO_CHAR(SUM(ORA_HASH(column_name || ':' || data_type || ':' || data_length || ':' || NVL(data_precision, -1) || ':' || NVL(data_scale, -1) || ':' || column_id))) h
         FROM all_tab_columns WHERE owner=:o GROUP BY table_name`,
      { o: schema.toUpperCase() },
      500000
    );
    const out: Record<string, string> = {};
    for (const r of rows) out[r.T.toLowerCase()] = r.C + ':' + r.H;
    return out;
  }

  async columnsBatch(schema: string, tables: string[]) {
    if (!tables.length) return [];
    const binds: Record<string, string> = { o: schema.toUpperCase() };
    const list = tables.map((t, i) => {
      binds['t' + i] = t.toUpperCase();
      return ':t' + i;
    });
    const rows = await this.rows<{ T: string; N: string; DT: string; CL: number | null; P: number | null; S: number | null }>(
      `SELECT table_name t, column_name n, data_type dt, char_length cl, data_precision p, data_scale s
         FROM all_tab_columns WHERE owner=:o AND table_name IN (${list.join(',')}) ORDER BY table_name, column_id`,
      binds,
      200000
    );
    const pks = await this.rows<{ T: string; N: string }>(
      `SELECT k.table_name t, cc.column_name n FROM all_constraints k
         JOIN all_cons_columns cc ON cc.owner=k.owner AND cc.constraint_name=k.constraint_name
        WHERE k.owner=:o AND k.constraint_type='P' AND k.table_name IN (${list.join(',')})`,
      binds,
      50000
    ).catch(() => []);
    const pk = new Set(pks.map((r) => r.T + '.' + r.N));
    const cms = await this.rows<{ T: string; N: string; C: string }>(
      `SELECT table_name t, column_name n, comments c FROM all_col_comments WHERE owner=:o AND comments IS NOT NULL AND table_name IN (${list.join(',')})`,
      binds,
      200000
    ).catch(() => []);
    const cm = new Map(cms.map((r) => [r.T + '.' + r.N, r.C] as const));
    return rows.map((r) => ({ table: r.T, name: r.N, type: this.fmtType(r.DT, r.CL, r.P, r.S), pk: pk.has(r.T + '.' + r.N), comment: cm.get(r.T + '.' + r.N) }));
  }

  async foreignKeysOf(schema: string, table: string): Promise<ForeignKey[]> {
    const sel = `SELECT c.constraint_name fk, c.table_name t, cc.column_name c, p.owner rs, p.table_name rt, pc.column_name rc
         FROM all_constraints c
         JOIN all_cons_columns cc ON cc.owner=c.owner AND cc.constraint_name=c.constraint_name
         JOIN all_constraints p ON p.owner=c.r_owner AND p.constraint_name=c.r_constraint_name
         JOIN all_cons_columns pc ON pc.owner=p.owner AND pc.constraint_name=p.constraint_name AND pc.position=cc.position`;
    const o = schema.toUpperCase();
    const t = table.toUpperCase();
    const asChild = await this.rows<{ FK: string; T: string; C: string; RS: string; RT: string; RC: string }>(
      `${sel} WHERE c.owner=:o AND c.constraint_type='R' AND c.table_name=:t ORDER BY c.constraint_name, cc.position`,
      { o, t }
    );
    const asParent = await this.rows<{ FK: string; T: string; C: string; RS: string; RT: string; RC: string }>(
      `${sel} WHERE c.constraint_type='R' AND c.owner=:o AND p.owner=:o AND p.table_name=:t ORDER BY c.table_name, c.constraint_name, cc.position`,
      { o, t }
    );
    return groupForeignKeys([...asChild, ...asParent].map((r) => ({ fk: r.FK, table: r.T, col: r.C, refSchema: r.RS, refTable: r.RT, refCol: r.RC })));
  }

  async allColumns(schema: string) {
    const rows = await this.rows<{ T: string; N: string; TY: string; PK: number }>(
      `SELECT c.table_name t, c.column_name n,
              c.data_type || CASE
                WHEN c.data_type IN ('VARCHAR2','NVARCHAR2','CHAR','NCHAR','RAW') THEN '(' || c.char_length || ')'
                WHEN c.data_type = 'NUMBER' AND c.data_precision IS NOT NULL THEN '(' || c.data_precision || CASE WHEN c.data_scale > 0 THEN ',' || c.data_scale END || ')'
                END ty,
              CASE WHEN pk.column_name IS NULL THEN 0 ELSE 1 END pk
         FROM all_tab_columns c
         LEFT JOIN (SELECT cc.table_name, cc.column_name FROM all_cons_columns cc
                      JOIN all_constraints k ON k.owner=cc.owner AND k.constraint_name=cc.constraint_name
                     WHERE k.constraint_type='P' AND k.owner=:o) pk
                ON pk.table_name=c.table_name AND pk.column_name=c.column_name
        WHERE c.owner=:o ORDER BY c.table_name, c.column_id`,
      { o: schema },
      500000
    );
    return rows.map((r) => ({ table: r.T, name: r.N, type: r.TY, pk: r.PK === 1 }));
  }

  async foreignKeys(schema: string): Promise<ForeignKey[]> {
    const rows = await this.rows<{ FK: string; T: string; C: string; RS: string; RT: string; RC: string }>(
      `SELECT c.constraint_name fk, c.table_name t, cc.column_name c, p.owner rs, p.table_name rt, pc.column_name rc
         FROM all_constraints c
         JOIN all_cons_columns cc ON cc.owner=c.owner AND cc.constraint_name=c.constraint_name
         JOIN all_constraints p ON p.owner=c.r_owner AND p.constraint_name=c.r_constraint_name
         JOIN all_cons_columns pc ON pc.owner=p.owner AND pc.constraint_name=p.constraint_name AND pc.position=cc.position
        WHERE c.owner=:o AND c.constraint_type='R'
        ORDER BY c.table_name, c.constraint_name, cc.position`,
      { o: schema },
      100000
    );
    return groupForeignKeys(rows.map((r) => ({ fk: r.FK, table: r.T, col: r.C, refSchema: r.RS, refTable: r.RT, refCol: r.RC })));
  }

  private async cols(owner: string, table: string): Promise<ColInfo[]> {
    const rows = await this.rows<{ ID: number; NAME: string; TYPE: string; NULLABLE: string; PK: number; DEF: string | null; COMMENTS: string | null }>(
      `SELECT c.column_id id, c.column_name name,
              c.data_type || CASE
                WHEN c.data_type IN ('VARCHAR2','NVARCHAR2','CHAR','NCHAR','RAW') THEN '(' || c.char_length || ')'
                WHEN c.data_type = 'NUMBER' AND c.data_precision IS NOT NULL THEN '(' || c.data_precision || CASE WHEN c.data_scale > 0 THEN ',' || c.data_scale END || ')'
                END type,
              c.nullable nullable,
              (SELECT COUNT(*) FROM all_cons_columns cc JOIN all_constraints k ON k.owner=cc.owner AND k.constraint_name=cc.constraint_name
                WHERE k.constraint_type='P' AND k.owner=c.owner AND k.table_name=c.table_name AND cc.column_name=c.column_name) pk,
              c.data_default def, m.comments comments
         FROM all_tab_columns c
         LEFT JOIN all_col_comments m ON m.owner=c.owner AND m.table_name=c.table_name AND m.column_name=c.column_name
        WHERE c.owner=:o AND c.table_name=:t ORDER BY c.column_id`,
      { o: owner, t: table }
    );
    return rows.map((r) => ({ ...r, PK: r.PK > 0, DEF: r.DEF ? String(r.DEF).trim() : null }));
  }

  async columns(schema: string, table: string) {
    const o = schema.toUpperCase();
    const t = table.toUpperCase();
    let cols = await this.cols(o, t);
    if (!cols.length) {
      const syn = await this.rows<{ TABLE_OWNER: string; TABLE_NAME: string }>(
        `SELECT table_owner, table_name FROM all_synonyms WHERE synonym_name=:n AND owner IN (:o,'PUBLIC') ORDER BY CASE owner WHEN 'PUBLIC' THEN 1 ELSE 0 END`,
        { n: t, o },
        1
      );
      if (syn[0]) cols = await this.cols(syn[0].TABLE_OWNER, syn[0].TABLE_NAME);
    }
    return cols;
  }

  async indexes(schema: string, table: string) {
    const rows = await this.rows<{ N: string; U: string; C: string }>(
      `SELECT i.index_name n, i.uniqueness u,
              (SELECT LISTAGG(column_name, ', ') WITHIN GROUP (ORDER BY column_position) FROM all_ind_columns ic WHERE ic.index_owner=i.owner AND ic.index_name=i.index_name) c
         FROM all_indexes i WHERE i.table_owner=:o AND i.table_name=:t ORDER BY i.index_name`,
      { o: schema, t: table }
    );
    return rows.map((r) => ({ name: r.N, unique: r.U === 'UNIQUE', cols: r.C }));
  }

  async constraints(schema: string, table: string) {
    const rows = await this.rows<{ N: string; T: string; S: string; C: string; R: string | null }>(
      `SELECT k.constraint_name n, k.constraint_type t, k.status s,
              (SELECT LISTAGG(column_name, ', ') WITHIN GROUP (ORDER BY position) FROM all_cons_columns cc WHERE cc.owner=k.owner AND cc.constraint_name=k.constraint_name) c,
              k.r_constraint_name r
         FROM all_constraints k WHERE k.owner=:o AND k.table_name=:t AND k.constraint_name NOT LIKE 'BIN$%' ORDER BY k.constraint_type, k.constraint_name`,
      { o: schema, t: table }
    );
    const names: Record<string, string> = { P: 'PK', U: 'UK', R: 'FK', C: 'CHECK', V: 'VIEW CHECK', O: 'READ ONLY' };
    return rows.map((r) => ({ name: r.N, type: names[r.T] ?? r.T, status: r.S, cols: r.C, ref: r.R }));
  }

  async ddl(type: string, schema: string, name: string) {
    await this.conn
      .execute(`BEGIN
        DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM,'SQLTERMINATOR',TRUE);
        DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM,'PRETTY',TRUE);
      END;`)
      .catch(() => undefined);
    const get = async (t: string) => {
      const r = await this.conn.execute<[string]>(`SELECT DBMS_METADATA.GET_DDL(:t, :n, :o) FROM dual`, { t, n: name, o: schema });
      return String(r.rows?.[0]?.[0] ?? '').trim();
    };
    const parts: string[] = [];
    if (type === 'PACKAGE') {
      parts.push(await get('PACKAGE_SPEC'));
      parts.push(await get('PACKAGE_BODY').catch(() => ''));
    } else if (type === 'TYPE') {
      parts.push(await get('TYPE_SPEC'));
      parts.push(await get('TYPE_BODY').catch(() => ''));
    } else parts.push(await get(type.replace(' ', '_')));
    return parts.filter(Boolean).join('\n\n') + '\n';
  }

  async explain(sql: string, binds: Record<string, unknown>) {
    const id = 'DBX' + Date.now();
    await this.conn.execute(`EXPLAIN PLAN SET STATEMENT_ID = '${id}' FOR ${sql}`, toOracleBinds(binds));
    const r = await this.conn.execute<[string]>(
      `SELECT plan_table_output FROM TABLE(DBMS_XPLAN.DISPLAY('PLAN_TABLE', :id, 'TYPICAL'))`,
      { id },
      { outFormat: oracledb.OUT_FORMAT_ARRAY }
    );
    await this.conn.execute(`DELETE FROM plan_table WHERE statement_id = :id`, { id }, { autoCommit: false });
    return (r.rows ?? []).map((x) => x[0]).join('\n');
  }

  async findObject(schema: string, name: string): Promise<FoundObject | undefined> {
    const n = name.replace(/^"|"$/g, '').toUpperCase();
    const o = schema.replace(/^"|"$/g, '').toUpperCase();
    const find = async (owner: string, nm: string) => {
      const rows = await this.rows<{ OWNER: string; T: string; N: string }>(
        `SELECT owner, object_type t, object_name n FROM all_objects
          WHERE owner=:o AND object_name=:n AND object_type IN ('TABLE','VIEW','MATERIALIZED VIEW','SEQUENCE','PROCEDURE','FUNCTION','PACKAGE','TRIGGER','TYPE','SYNONYM')
          ORDER BY CASE object_type WHEN 'TABLE' THEN 1 WHEN 'VIEW' THEN 2 WHEN 'SYNONYM' THEN 9 ELSE 3 END`,
        { o: owner, n: nm },
        1
      );
      return rows[0];
    };
    let hit: { OWNER: string; T: string; N: string } | undefined = await find(o, n);
    if (!hit) hit = await find('PUBLIC', n);
    for (let depth = 0; hit && hit.T === 'SYNONYM' && depth < 5; depth++) {
      const syn: { TO: string; TN: string }[] = await this.rows<{ TO: string; TN: string }>(
        `SELECT table_owner "TO", table_name tn FROM all_synonyms WHERE owner=:o AND synonym_name=:n`,
        { o: hit.OWNER, n: hit.N },
        1
      );
      const next: { OWNER: string; T: string; N: string } | undefined = syn[0] ? await find(syn[0].TO, syn[0].TN) : undefined;
      hit = next;
    }
    return hit ? { type: hit.T, schema: hit.OWNER, name: hit.N } : undefined;
  }

  async describeQuery(sql: string, binds: Record<string, unknown>): Promise<QueryColumn[]> {
    const b: Record<string, unknown> = {};
    for (const k of Object.keys(binds)) b[k] = { val: binds[k] ?? null, type: oracledb.STRING };
    const res = await this.conn.execute(sql, b as oracledb.BindParameters, { resultSet: true, prefetchRows: 0, fetchArraySize: 1 });
    await res.resultSet?.close();
    return (res.metaData ?? []).map((m) => {
      const t = m.dbTypeName ?? '';
      let type = t;
      if (/CHAR|RAW/.test(t) && m.byteSize) type = `${t}(${m.byteSize})`;
      else if (t === 'NUMBER' && m.precision) type = `NUMBER(${m.precision}${m.scale ? "," + m.scale : ""})`;
      return { name: m.name, type, nullable: m.nullable };
    });
  }

  async setQueryTimeout(seconds: number) {
    this.conn.callTimeout = Math.max(0, seconds) * 1000;
  }

  async beforeExec() {
    await this.conn.execute('BEGIN DBMS_OUTPUT.ENABLE(NULL); END;').catch(() => undefined);
  }

  async drainOutput() {
    const chunks: string[] = [];
    try {
      for (let guard = 0; guard < 200; guard++) {
        const r = await this.conn.execute<{ lines: string[]; n: number }>(
          'BEGIN DBMS_OUTPUT.GET_LINES(:lines, :n); END;',
          {
            lines: { type: oracledb.STRING, dir: oracledb.BIND_OUT, maxArraySize: 1000 },
            n: { type: oracledb.NUMBER, dir: oracledb.BIND_INOUT, val: 1000 },
          },
          { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        const out = r.outBinds as { lines: string[]; n: number };
        chunks.push(...(out.lines ?? []).slice(0, out.n));
        if (out.n < 1000) break;
      }
    } catch {
      /* DBMS_OUTPUT indisponible */
    }
    return chunks.join('\n');
  }

  async compileIssues(sql: string) {
    const m = CREATE_SRC_RE.exec(sql);
    if (!m) return undefined;
    const type = m[1].toUpperCase().replace(/\s+/g, ' ');
    const owner = m[3] ? (m[2] ? m[3] : m[3].toUpperCase()) : this.currentSchema.toUpperCase();
    const name = m[4] ? m[5] : m[5].toUpperCase();
    const rows = await this.rows<{ LINE: number; POSITION: number; TEXT: string; ATTRIBUTE: string }>(
      `SELECT line, position, text, attribute FROM all_errors WHERE owner=:o AND name=:n AND type=:t ORDER BY sequence`,
      { o: owner, n: name, t: type }
    );
    const issues: CompileIssue[] = rows.map((e) => ({ line: e.LINE, col: e.POSITION, text: e.TEXT, warning: e.ATTRIBUTE === 'WARNING' }));
    return { label: `${type} ${owner}.${name}`, issues };
  }
}
