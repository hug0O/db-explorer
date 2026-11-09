import { DbConn, DbKind } from './drivers/types';
import { t } from './i18n';

export interface Col {
  name: string;
  type: string;
  pk: boolean;
}
export interface Snapshot {
  kind: DbKind;
  schema: string;
  /** Tous les objets (tables, vues, …) : clé en minuscules. */
  objects: Map<string, { name: string; type: string }>;
  /** Colonnes des tables : clé en minuscules. */
  columns: Map<string, Col[]>;
}

/** Photographie d'un schéma : objets et colonnes des tables. */
export async function takeSnapshot(conn: DbConn, schema: string): Promise<Snapshot> {
  const objs = conn.objectInfos ? await conn.objectInfos(schema) : (await conn.tableNames(schema)).map((name) => ({ name, type: 'TABLE' }));
  const objects = new Map(objs.map((o) => [o.name.toLowerCase(), o] as const));
  const columns = new Map<string, Col[]>();
  const tables = objs.filter((o) => o.type === 'TABLE').map((o) => o.name);
  if (conn.allColumns) {
    for (const r of await conn.allColumns(schema)) {
      const k = r.table.toLowerCase();
      if (objects.get(k)?.type === 'TABLE' || !conn.objectInfos) (columns.get(k) ?? columns.set(k, []).get(k)!).push({ name: r.name, type: r.type, pk: r.pk });
    }
  } else if (conn.columnsBatch) {
    for (let i = 0; i < tables.length; i += 60) for (const r of await conn.columnsBatch(schema, tables.slice(i, i + 60))) (columns.get(r.table.toLowerCase()) ?? columns.set(r.table.toLowerCase(), []).get(r.table.toLowerCase())!).push({ name: r.name, type: r.type, pk: r.pk });
  } else {
    for (const tb of tables) columns.set(tb.toLowerCase(), (await conn.columns(schema, tb)).map((c) => ({ name: c.NAME, type: c.TYPE, pk: c.PK })));
  }
  return { kind: conn.kind, schema, objects, columns };
}

export interface Diff {
  onlyA: { name: string; type: string }[];
  onlyB: { name: string; type: string }[];
  /** Tables communes dont les colonnes diffèrent. */
  changed: { table: string; add: Col[]; drop: Col[]; type: { col: Col; from: string }[] }[];
  same: number;
}

const normType = (x: string) => x.toLowerCase().replace(/\s+/g, '');

export function diffSnapshots(a: Snapshot, b: Snapshot): Diff {
  const onlyA = [...a.objects.values()].filter((o) => !b.objects.has(o.name.toLowerCase()));
  const onlyB = [...b.objects.values()].filter((o) => !a.objects.has(o.name.toLowerCase()));
  const changed: Diff['changed'] = [];
  let same = 0;
  for (const [k, colsA] of a.columns) {
    const colsB = b.columns.get(k);
    if (!colsB) continue;
    const mb = new Map(colsB.map((c) => [c.name.toLowerCase(), c] as const));
    const ma = new Map(colsA.map((c) => [c.name.toLowerCase(), c] as const));
    const add = colsA.filter((c) => !mb.has(c.name.toLowerCase()));
    const drop = colsB.filter((c) => !ma.has(c.name.toLowerCase()));
    const type = colsA.filter((c) => mb.has(c.name.toLowerCase()) && normType(mb.get(c.name.toLowerCase())!.type) !== normType(c.type)).map((c) => ({ col: c, from: mb.get(c.name.toLowerCase())!.type }));
    if (add.length || drop.length || type.length) changed.push({ table: a.objects.get(k)?.name ?? k, add, drop, type });
    else same++;
  }
  return { onlyA, onlyB, changed, same };
}

/** Script qui transforme B (cible) pour qu'il ressemble à A (source). Les suppressions sont écrites en commentaire. */
export async function buildSyncScript(src: { name: string; snap: Snapshot; ddl: (type: string, name: string) => Promise<string> }, dst: { name: string; snap: Snapshot }, d: Diff): Promise<string> {
  const kind = dst.snap.kind;
  const q = (n: string) => (kind === 'mysql' ? '`' + n + '`' : n);
  const full = (n: string) => (kind === 'sqlite' ? q(n) : `${q(dst.snap.schema)}.${q(n)}`);
  const L: string[] = [];
  L.push(`-- ${t('Schema synchronization script')}`);
  L.push(`-- ${t('Source')}: ${src.name} [${src.snap.schema}]   →   ${t('Target')}: ${dst.name} [${dst.snap.schema}]`);
  L.push(`-- ${t('Review before running: it is applied to the TARGET. Drops are commented out.')}`);
  L.push(`-- ${t('{0} object(s) missing in the target, {1} only in the target, {2} table(s) with different columns, {3} identical.', d.onlyA.length, d.onlyB.length, d.changed.length, d.same)}`);
  L.push('');
  const rewrite = (sql: string) => (kind === 'oracle' && src.snap.schema.toUpperCase() !== dst.snap.schema.toUpperCase() ? sql.split(`"${src.snap.schema.toUpperCase()}".`).join(`"${dst.snap.schema.toUpperCase()}".`) : sql);
  if (d.onlyA.length) L.push(`-- ${t('Objects missing in the target')}`);
  for (const o of d.onlyA) {
    try {
      const ddl = rewrite((await src.ddl(o.type, o.name)).trim());
      L.push(`-- ${o.type} ${o.name}`, ddl + (/[;/]\s*$/.test(ddl) ? '' : ';'), '');
    } catch (e) {
      L.push(`-- ${o.type} ${o.name}: ${t('DDL unavailable: {0}', (e as Error).message)}`, '');
    }
  }
  if (d.changed.length) L.push(`-- ${t('Columns that differ')}`);
  for (const c of d.changed) {
    const tb = full(c.table);
    L.push(`-- ${c.table}`);
    for (const x of c.add) {
      const col = `${q(x.name)} ${x.type}`;
      L.push(kind === 'oracle' ? `ALTER TABLE ${tb} ADD (${col});` : `ALTER TABLE ${tb} ADD COLUMN ${col};`);
    }
    for (const x of c.type) {
      if (kind === 'oracle') L.push(`ALTER TABLE ${tb} MODIFY (${q(x.col.name)} ${x.col.type});  -- ${t('was')} ${x.from}`);
      else if (kind === 'postgres') L.push(`ALTER TABLE ${tb} ALTER COLUMN ${q(x.col.name)} TYPE ${x.col.type};  -- ${t('was')} ${x.from}`);
      else if (kind === 'mysql') L.push(`ALTER TABLE ${tb} MODIFY COLUMN ${q(x.col.name)} ${x.col.type};  -- ${t('was')} ${x.from}`);
      else L.push(`-- ${t('SQLite cannot change a column type: recreate the table')} (${x.col.name}: ${x.from} → ${x.col.type})`);
    }
    for (const x of c.drop) L.push(`-- ALTER TABLE ${tb} DROP COLUMN ${q(x.name)};`);
    L.push('');
  }
  if (d.onlyB.length) L.push(`-- ${t('Only in the target (not dropped)')}`);
  for (const o of d.onlyB) L.push(`-- DROP ${o.type} ${full(o.name)};`);
  return L.join('\n') + '\n';
}
