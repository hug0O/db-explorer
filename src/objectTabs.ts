import { t } from './i18n';
import { DbConn, FoundObject } from './drivers/types';
import { fmtRow } from './runner';
import type { MetaCache } from './metaCache';
import { keyFlags, GridLink } from './keyFlags';

export interface TabDef {
  id: string;
  title: string;
}

export type TabContent = { columns: string[]; rows: unknown[][]; types?: string[]; sql?: string; keys?: string[]; links?: GridLink[][]; /** Il reste des lignes non chargées. */ more?: boolean } | { text: string };

/** Contexte facultatif : connexion et cache de métadonnées (indicateurs PK / FK et liens dans l'onglet Data). */
export interface TabCtx {
  pid: string;
  cache?: MetaCache;
}

/** Lignes d'une requête (200 par défaut, `limit` pour tout charger) avec le type de chaque colonne et, si possible, les clés / liens de navigation. */
export async function dataContent(conn: DbConn, sql: string, schema: string, ctx?: TabCtx, limit = 200): Promise<TabContent> {
  const rs = await conn.open(sql, {});
  try {
    const raw: unknown[][] = [];
    let more = false;
    for (;;) {
      const chunk = await rs.getRows(Math.min(2000, limit - raw.length));
      raw.push(...chunk);
      if (raw.length >= limit) {
        more = chunk.length > 0 && (await rs.getRows(1)).length > 0;
        break;
      }
      if (!chunk.length) break;
    }
    const rows = raw.map(fmtRow);
    const out: TabContent = { columns: rs.columns.map((c) => c.name), types: rs.columns.map((c) => c.type), rows, sql, more };
    if (ctx?.cache) {
      const k = await keyFlags(ctx.cache, ctx.pid, schema, sql, rs.columns).catch(() => undefined);
      if (k) {
        out.keys = k.flags;
        if (k.links.some((l) => l.length)) out.links = k.links;
      }
    }
    return out;
  } finally {
    await rs.close().catch(() => undefined);
  }
}

export function quoteIdent(conn: DbConn, name: string): string {
  const q = conn.kind === 'mysql' ? '`' : '"';
  return q + name.replace(new RegExp(q, 'g'), q + q) + q;
}

export async function q(conn: DbConn, sql: string, binds: Record<string, unknown> = {}, max = 2000) {
  const rs = await conn.open(sql, binds);
  try {
    const rows = (await rs.getRows(max)).map(fmtRow);
    return { columns: rs.columns.map((c) => c.name), rows };
  } finally {
    await rs.close();
  }
}

/** Onglets disponibles, dans l'ordre de Toad « Describe Objects ». */
export function tabsFor(conn: DbConn, o: FoundObject): TabDef[] {
  const isTable = o.type === 'TABLE';
  const isView = o.type === 'VIEW' || o.type === 'MATERIALIZED VIEW';
  const tab = (id: string, title: string): TabDef => ({ id, title: t(title) });
  if (conn.kind === 'oracle') {
    if (isTable) {
      return [
        tab('columns', 'Columns'), tab('indexes', 'Indexes'), tab('constraints', 'Constraints'), tab('triggers', 'Triggers'),
        tab('data', 'Data'), tab('script', 'Script'), tab('partitions', 'Partitioning'), tab('grants', 'Grants'),
        tab('synonyms', 'Synonyms'), tab('stats', 'Stats/Size'), tab('referential', 'Referential'), tab('usedby', 'Used By'),
      ];
    }
    return [tab('columns', 'Columns'), ...(isView && o.type === 'MATERIALIZED VIEW' ? [tab('indexes', 'Indexes')] : []), tab('data', 'Data'), tab('script', 'Script'), tab('grants', 'Grants'), tab('synonyms', 'Synonyms'), tab('usedby', 'Used By')];
  }
  if (isTable) return [tab('columns', 'Columns'), tab('indexes', 'Indexes'), tab('constraints', 'Constraints'), tab('referential', 'Referential'), tab('data', 'Data'), tab('script', 'Script')];
  return [tab('columns', 'Columns'), tab('data', 'Data'), tab('script', 'Script')];
}

/** Lignes d'en-tête : créé / dernier DDL / clé primaire. */
export async function objectInfo(conn: DbConn, o: FoundObject): Promise<string[]> {
  const lines: string[] = [];
  if (conn.kind === 'oracle') {
    try {
      const r = await q(
        conn,
        `SELECT TO_CHAR(created,'DD/MM/YYYY HH24:MI:SS'), TO_CHAR(last_ddl_time,'DD/MM/YYYY HH24:MI:SS'), status
           FROM all_objects WHERE owner=:o AND object_name=:n AND object_type=:t`,
        { o: o.schema, n: o.name, t: o.type }
      );
      const row = r.rows[0];
      if (row) lines.push(`${o.name}:  Created: ${row[0]}   Last DDL: ${row[1]}   Status: ${row[2]}`);
    } catch {
      /* optionnel */
    }
  } else lines.push(`${o.name}  (${o.type})`);
  if (o.type === 'TABLE') {
    try {
      const pk = (await conn.constraints(o.schema, o.name)).find((c) => c.type === 'PK');
      if (pk) lines.push(`Primary Key:  ${pk.cols}`);
    } catch {
      /* optionnel */
    }
  }
  return lines;
}

const COLS_HEAD = [t('Name'), t('Type'), t('Null?'), 'PK', t('Default'), t('Comment')];

export async function loadTab(conn: DbConn, o: FoundObject, id: string, ctx?: TabCtx): Promise<TabContent> {
  const oracle = conn.kind === 'oracle';
  const b = { o: o.schema, n: o.name };
  switch (id) {
    case 'columns': {
      const cols = await conn.columns(o.schema, o.name);
      return { columns: COLS_HEAD, rows: cols.map((c) => [c.NAME, c.TYPE, c.NULLABLE === 'N' ? 'NOT NULL' : '', c.PK ? 'PK' : '', c.DEF, c.COMMENTS]) };
    }
    case 'indexes': {
      const rows = await conn.indexes(o.schema, o.name);
      return { columns: [t('Index'), 'Unique', t('Columns')], rows: rows.map((r) => [r.name, r.unique ? 'UNIQUE' : '', r.cols]) };
    }
    case 'constraints': {
      const rows = await conn.constraints(o.schema, o.name);
      return { columns: [t('Constraint'), t('Type'), t('Columns / definition'), t('Reference'), t('Status')], rows: rows.map((r) => [r.name, r.type, r.cols, r.ref, r.status]) };
    }
    case 'data': {
      const full = conn.kind === 'sqlite' ? quoteIdent(conn, o.name) : `${quoteIdent(conn, o.schema)}.${quoteIdent(conn, o.name)}`;
      return dataContent(conn, `SELECT * FROM ${full}`, o.schema, ctx);
    }
    case 'script':
      return { text: (await conn.ddl(o.type, o.schema, o.name)).trim() + '\n' };
  }
  if (id === 'referential' && !oracle) {
    // autres bases : clés étrangères dans les deux sens (celles de la table, et celles qui la référencent)
    const fks = conn.foreignKeysOf
      ? await conn.foreignKeysOf(o.schema, o.name)
      : conn.foreignKeys
        ? (await conn.foreignKeys(o.schema)).filter((f) => f.table.toLowerCase() === o.name.toLowerCase() || f.refTable.toLowerCase() === o.name.toLowerCase())
        : [];
    const me = o.name.toLowerCase();
    const rows: unknown[][] = [];
    for (const f of fks) {
      if (f.table.toLowerCase() === me) rows.push([t('References →'), f.name, `${f.refSchema || o.schema}.${f.refTable}`, f.cols.join(', '), f.refCols.join(', '), '', '']);
      if (f.refTable.toLowerCase() === me) rows.push([t('← Referenced by'), f.name, `${o.schema}.${f.table}`, f.refCols.join(', '), f.cols.join(', '), '', '']);
    }
    return { columns: [t('Direction'), t('Constraint'), t('Related table'), t('This table columns'), t('Related columns'), t('Referenced key'), t('Status')], rows };
  }
  if (!oracle) return { columns: [], rows: [] };
  switch (id) {
    case 'triggers':
      return q(
        conn,
        `SELECT trigger_name "Trigger", trigger_type "Type", triggering_event "${t('Event')}", status "${t('Status')}"
           FROM all_triggers WHERE table_owner=:o AND table_name=:n ORDER BY trigger_name`,
        b
      );
    case 'partitions':
      return q(
        conn,
        `SELECT partition_position "#", partition_name "Partition", tablespace_name "Tablespace", num_rows "${t('Rows')}", TO_CHAR(last_analyzed,'DD/MM/YYYY HH24:MI') "${t('Analyzed')}"
           FROM all_tab_partitions WHERE table_owner=:o AND table_name=:n ORDER BY partition_position`,
        b
      );
    case 'grants':
      return q(
        conn,
        `SELECT grantee "${t('Grantee')}", privilege "${t('Privilege')}", grantable "Grantable", grantor "${t('Granted by')}"
           FROM all_tab_privs WHERE table_schema=:o AND table_name=:n ORDER BY grantee, privilege`,
        b
      );
    case 'synonyms':
      return q(conn, `SELECT owner "${t('Owner')}", synonym_name "${t('Synonym')}" FROM all_synonyms WHERE table_owner=:o AND table_name=:n ORDER BY owner, synonym_name`, b);
    case 'usedby':
      return q(
        conn,
        `SELECT owner "${t('Owner')}", name "${t('Name')}", type "Type" FROM all_dependencies WHERE referenced_owner=:o AND referenced_name=:n ORDER BY type, owner, name`,
        b
      );
    case 'stats': {
      const r = await q(
        conn,
        `SELECT num_rows, blocks, empty_blocks, avg_row_len, sample_size, TO_CHAR(last_analyzed,'DD/MM/YYYY HH24:MI:SS') last_analyzed,
                tablespace_name, logging, partitioned, temporary, compression, degree
           FROM all_tables WHERE owner=:o AND table_name=:n`,
        b
      );
      const labels = [t('Rows (NUM_ROWS)'), t('Blocks'), t('Empty blocks'), t('Avg row length (bytes)'), t('Sample size'), t('Last analyzed'), 'Tablespace', 'Logging', t('Partitioned'), t('Temporary'), 'Compression', t('Degree')];
      const rows: unknown[][] = r.rows[0] ? labels.map((l, i) => [l, r.rows[0][i]]) : [];
      for (const view of ['dba_segments', 'user_segments']) {
        try {
          const sz = await q(
            conn,
            view === 'dba_segments'
              ? `SELECT ROUND(SUM(bytes)/1024/1024, 2) FROM dba_segments WHERE owner=:o AND segment_name=:n`
              : `SELECT ROUND(SUM(bytes)/1024/1024, 2) FROM user_segments WHERE segment_name=:n`,
            view === 'dba_segments' ? b : { n: o.name }
          );
          if (sz.rows[0]?.[0] !== null && sz.rows[0]?.[0] !== undefined) {
            rows.push([t('Size (MB)'), sz.rows[0][0]]);
            break;
          }
        } catch {
          /* droits insuffisants : essai suivant */
        }
      }
      return { columns: [t('Property'), t('Value')], rows };
    }
    case 'referential': {
      // « Références → » : clés étrangères de la table ; « ← Référencée par » : tables dont une clé étrangère pointe sur la clé de cette table
      const out = await q(
        conn,
        `SELECT '${t('References →')}' "${t('Direction')}", c.constraint_name "${t('Constraint')}", rc.owner || '.' || rc.table_name "${t('Related table')}",
                (SELECT LISTAGG(cc.column_name, ', ') WITHIN GROUP (ORDER BY cc.position) FROM all_cons_columns cc WHERE cc.owner=c.owner AND cc.constraint_name=c.constraint_name) "${t('This table columns')}",
                (SELECT LISTAGG(cc.column_name, ', ') WITHIN GROUP (ORDER BY cc.position) FROM all_cons_columns cc WHERE cc.owner=rc.owner AND cc.constraint_name=rc.constraint_name) "${t('Related columns')}",
                rc.constraint_name "${t('Referenced key')}", c.status "${t('Status')}"
           FROM all_constraints c JOIN all_constraints rc ON rc.owner=c.r_owner AND rc.constraint_name=c.r_constraint_name
          WHERE c.constraint_type='R' AND c.owner=:o AND c.table_name=:n
         UNION ALL
         SELECT '${t('← Referenced by')}', c.constraint_name, c.owner || '.' || c.table_name,
                (SELECT LISTAGG(cc.column_name, ', ') WITHIN GROUP (ORDER BY cc.position) FROM all_cons_columns cc WHERE cc.owner=pc.owner AND cc.constraint_name=pc.constraint_name),
                (SELECT LISTAGG(cc.column_name, ', ') WITHIN GROUP (ORDER BY cc.position) FROM all_cons_columns cc WHERE cc.owner=c.owner AND cc.constraint_name=c.constraint_name),
                pc.constraint_name, c.status
           FROM all_constraints c JOIN all_constraints pc ON pc.owner=c.r_owner AND pc.constraint_name=c.r_constraint_name
          WHERE c.constraint_type='R' AND pc.owner=:o AND pc.table_name=:n
          ORDER BY 1 DESC, 3, 2`,
        b
      );
      return out;
    }
  }
  return { columns: [], rows: [] };
}
