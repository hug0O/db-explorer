export type DbKind = 'oracle' | 'sqlite' | 'mysql' | 'postgres';

export interface Profile {
  id: string;
  name: string;
  type: DbKind;
  user?: string;
  /** Oracle : host:port/service ou alias TNS. */
  connectString?: string;
  /** Dossier contenant tnsnames.ora (Oracle). */
  tnsAdmin?: string;
  role?: 'DEFAULT' | 'SYSDBA' | 'SYSOPER';
  host?: string;
  port?: number;
  /** Nom de base (MySQL/PostgreSQL) ou chemin du fichier (SQLite). */
  database?: string;
  ssl?: boolean;
  /** Clé de couleur (palette) pour repérer la connexion. */
  color?: string;
  /** Environnement (étiquette DEV / TEST / PROD ; PROD déclenche les protections de production). */
  env?: 'dev' | 'test' | 'prod';
  /** Connexion épinglée en haut des listes. */
  pinned?: boolean;
  /** Mode lecture seule : seules les requêtes de lecture sont exécutées. */
  readOnly?: boolean;
  /** Dernier test de connexion (réussi ou non). */
  lastTest?: { ok: boolean; at: number; message?: string };
}

/** Connexion de production : environnement PROD ou couleur rouge. */
export const isProd = (p?: Profile): boolean => !!p && (p.env === 'prod' || p.color === 'red');
export const envLabel = (p?: Profile): string => (p?.env ? p.env.toUpperCase() : p?.color === 'red' ? 'PROD' : '');

export interface Category {
  type: string;
  label: string;
  icon: string;
}

export interface Col {
  name: string;
  type: string;
}

export interface ColInfo {
  ID: number;
  NAME: string;
  TYPE: string;
  NULLABLE: string; // 'Y' | 'N'
  PK: boolean;
  DEF: string | null;
  COMMENTS: string | null;
}

export interface ResultCursor {
  columns: Col[];
  getRows(n: number): Promise<unknown[][]>;
  close(): Promise<void>;
}

export interface CompileIssue {
  line: number;
  col: number;
  text: string;
  warning: boolean;
}

/** Procédure, fonction ou package (aide à la saisie, Ctrl+clic). */
export interface RoutineInfo {
  name: string;
  type: 'PACKAGE' | 'PROCEDURE' | 'FUNCTION';
}

/** Paramètre d'une procédure / fonction. */
export interface RoutineArg {
  name: string;
  type: string;
  dir: 'in' | 'out' | 'inout';
  pos: number;
  /** Identifiant de la surcharge (plusieurs signatures de même nom). */
  overload?: string;
  /** Valeur de retour d'une fonction (pas un paramètre à fournir). */
  isReturn?: boolean;
}

export interface DbConn {
  readonly kind: DbKind;
  readonly features: { schemas: boolean; plsql: boolean; dbmsOutput: boolean; transactions: boolean };
  currentSchema: string;

  isQuery(sql: string): boolean;
  /** Ouvre un curseur paginable (requête). */
  open(sql: string, binds: Record<string, unknown>): Promise<ResultCursor>;
  /** Exécute une instruction non-SELECT. */
  exec(sql: string, binds: Record<string, unknown>, autoCommit: boolean): Promise<ExecResult>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  cancel(): Promise<void>;
  close(): Promise<void>;

  categories(): Category[];
  schemas(): Promise<string[]>;
  useSchema(schema: string): Promise<void>;
  listObjects(type: string, schema: string, max: number): Promise<{ name: string; invalid: boolean }[]>;
  tableNames(schema: string): Promise<string[]>;
  columns(schema: string, table: string): Promise<ColInfo[]>;
  indexes(schema: string, table: string): Promise<{ name: string; unique: boolean; cols: string }[]>;
  constraints(schema: string, table: string): Promise<{ name: string; type: string; status: string; cols: string; ref: string | null }[]>;
  ddl(type: string, schema: string, name: string): Promise<string>;
  explain(sql: string, binds: Record<string, unknown>): Promise<string>;

  /** Retrouve un objet par son nom (résout les synonymes). */
  findObject(schema: string, name: string): Promise<FoundObject | undefined>;
  /** Types des colonnes retournées par une requête, sans la ramener. */
  describeQuery(sql: string, binds: Record<string, unknown>): Promise<QueryColumn[]>;

  /** DDL des éléments liés à une table / vue (index, clés étrangères, commentaires, triggers, droits, synonymes), séparé de celui de l'objet. */
  scriptExtras?(type: string, schema: string, name: string): Promise<string>;
  /** Types définis par l'utilisateur (Oracle : CREATE TYPE). */
  userTypes?(schema: string): Promise<string[]>;
  /** Packages, procédures et fonctions d'un schéma. */
  routines?(schema: string): Promise<RoutineInfo[]>;
  /** Paramètres d'une procédure / fonction (membre d'un package si pkg est renseigné). */
  routineArgs?(schema: string, pkg: string | undefined, name: string): Promise<RoutineArg[]>;

  /** Objets interrogeables (tables, vues, synonymes…) avec leur type, pour la complétion. */
  objectInfos?(schema: string): Promise<{ name: string; type: string }[]>;

  /** Délai maximal d'une requête en secondes (0 = illimité). */
  setQueryTimeout?(seconds: number): Promise<void>;

  /** Toutes les colonnes d'un schéma en une requête (cache de complétion). */
  allColumns?(schema: string): Promise<{ table: string; name: string; type: string; pk: boolean; comment?: string }[]>;
  /** Toutes les clés étrangères d'un schéma (suggestions de jointures). */
  foreignKeys?(schema: string): Promise<ForeignKey[]>;

  /** Recherche ciblée par préfixe (grosses bases) : évite de charger tout le dictionnaire. */
  searchObjects?(schema: string, prefix: string, limit: number): Promise<{ name: string; type: string; owner?: string }[]>;
  /** Colonnes d'une table, version légère pour la complétion. */
  columnsLite?(schema: string, table: string): Promise<{ name: string; type: string; pk: boolean; comment?: string }[]>;
  /** Colonnes d'un lot de tables (scan progressif). */
  columnsBatch?(schema: string, tables: string[]): Promise<{ table: string; name: string; type: string; pk: boolean; comment?: string }[]>;
  /** Empreinte de la structure de chaque table (1 requête pour tout le schéma) : détecte les différences entre deux bases sans relire les colonnes. */
  columnHashes?(schema: string): Promise<Record<string, string>>;
  /** Dépendances d'un objet : « usedBy » = objets qui l'utilisent (vues, packages, triggers…), « uses » = objets qu'il utilise. */
  dependencies?(schema: string, name: string, dir: 'usedBy' | 'uses'): Promise<{ schema: string; name: string; type: string }[]>;
  /** Clés étrangères touchant une table (dans les deux sens). */
  foreignKeysOf?(schema: string, table: string): Promise<ForeignKey[]>;

  beforeExec?(): Promise<void>;
  drainOutput?(): Promise<string>;
  compileIssues?(sql: string): Promise<{ label: string; issues: CompileIssue[] } | undefined>;
}

/** Remplace :nom par ? ou $n en ignorant chaînes / commentaires. */
export function toPositional(sql: string, binds: Record<string, unknown>, style: '?' | '$'): { sql: string; values: unknown[] } {
  const values: unknown[] = [];
  const idx = new Map<string, number>();
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const d = sql[i + 1];
    if (c === '-' && d === '-') {
      const e = sql.indexOf('\n', i);
      const end = e < 0 ? n : e;
      out += sql.slice(i, end);
      i = end;
    } else if (c === '/' && d === '*') {
      const e = sql.indexOf('*/', i + 2);
      const end = e < 0 ? n : e + 2;
      out += sql.slice(i, end);
      i = end;
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === c) {
          if (sql[j + 1] === c) j += 2;
          else break;
        } else j++;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else if (c === ':' && d !== ':' && sql[i - 1] !== ':' && /[A-Za-z_0-9]/.test(d ?? '') && !/[\w$#]/.test(sql[i - 1] ?? ' ')) {
      const m = /^[A-Za-z_][\w$#]*|^\d+/.exec(sql.slice(i + 1));
      if (!m) {
        out += c;
        i++;
        continue;
      }
      const name = m[0];
      if (style === '?') {
        values.push(plainBind(binds[name]));
        out += '?';
      } else {
        let k = idx.get(name);
        if (k === undefined) {
          values.push(plainBind(binds[name]));
          k = values.length;
          idx.set(name, k);
        }
        out += '$' + k;
      }
      i += 1 + name.length;
    } else {
      out += c;
      i++;
    }
  }
  return { sql: out, values };
}

export function csvQuote(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/** Variable de liaison typée (direction IN/OUT/IN OUT) saisie dans la fenêtre de paramètres. */
export interface BindSpec {
  __bind: true;
  dir: 'in' | 'out' | 'inout';
  type: 'string' | 'number' | 'date' | 'cursor' | 'clob';
  val: string | null;
}

export const isBindSpec = (v: unknown): v is BindSpec => typeof v === 'object' && v !== null && (v as BindSpec).__bind === true;

/** Valeur simple d'un bind pour les bases sans direction (SQLite, MySQL, PostgreSQL). */
export function plainBind(v: unknown): unknown {
  if (!isBindSpec(v)) return v ?? null;
  if (v.val === null || v.val === '') return null;
  if (v.type === 'number') {
    const n = Number(v.val);
    return Number.isNaN(n) ? v.val : n;
  }
  return v.val;
}

export interface ExecResult {
  rowsAffected?: number;
  /** Valeurs des variables OUT / IN OUT (les REF CURSOR sont fournis sous forme de ResultCursor). */
  outBinds?: Record<string, unknown>;
}

export interface ForeignKey {
  name: string;
  table: string;
  cols: string[];
  refSchema: string;
  refTable: string;
  refCols: string[];
}

/** Regroupe des lignes (une par colonne de clé) en clés étrangères. */
export function groupForeignKeys(rows: { fk: string; table: string; col: string; refSchema: string; refTable: string; refCol: string }[]): ForeignKey[] {
  const map = new Map<string, ForeignKey>();
  for (const r of rows) {
    const k = r.table + '\u0000' + r.fk;
    let f = map.get(k);
    if (!f) {
      f = { name: r.fk, table: r.table, cols: [], refSchema: r.refSchema, refTable: r.refTable, refCols: [] };
      map.set(k, f);
    }
    f.cols.push(r.col);
    f.refCols.push(r.refCol);
  }
  return [...map.values()];
}

export interface FoundObject {
  type: string;
  schema: string;
  name: string;
}

export interface QueryColumn {
  name: string;
  type: string;
  nullable?: boolean;
}
