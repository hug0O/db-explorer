import { RoutineCache, callContext, suggestArgs } from './routines';
import type { RoutineArg, RoutineInfo } from './drivers/types';
import { expectsType, localDeclarations, ORACLE_TYPES, TYPE_FORMS } from './plsqlTypes';
import * as vscode from 'vscode';
import { ConnectionManager } from './connections';
import { split, statementAt } from './splitter';
import { dialectOf } from './runner';
import { q } from './objectTabs';
import { MetaCache, Meta, ColMeta, ObjMeta, within, TIMEOUT } from './metaCache';
import { ForeignKey } from './drivers/types';
import { t } from './i18n';

const KW = vscode.CompletionItemKind;

const KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'JOIN', 'LEFT JOIN', 'INNER JOIN', 'RIGHT JOIN', 'FULL OUTER JOIN', 'CROSS JOIN', 'ON', 'USING',
  'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM', 'MERGE INTO', 'CREATE TABLE', 'CREATE OR REPLACE', 'ALTER TABLE', 'DROP TABLE', 'TRUNCATE TABLE',
  'DISTINCT', 'UNION ALL', 'UNION', 'MINUS', 'INTERSECT', 'CASE WHEN', 'WHEN', 'THEN', 'ELSE', 'END', 'AND', 'OR', 'NOT', 'IN', 'EXISTS', 'BETWEEN', 'LIKE',
  'IS NULL', 'IS NOT NULL', 'AS', 'ASC', 'DESC', 'FETCH FIRST', 'ROWS ONLY', 'FOR UPDATE', 'WITH', 'CONNECT BY', 'START WITH', 'PARTITION BY', 'OVER',
  'BEGIN', 'DECLARE', 'EXCEPTION', 'LOOP', 'END LOOP', 'IF', 'ELSIF', 'END IF', 'FOR', 'WHILE', 'RETURN', 'COMMIT', 'ROLLBACK', 'DUAL', 'ROWNUM', 'NULL',
];
/** Mots-clés proposés juste après « FROM table » / « JOIN table ». */
const AFTER_TABLE = ['WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'JOIN', 'LEFT JOIN', 'INNER JOIN', 'RIGHT JOIN', 'FULL OUTER JOIN', 'ON', 'UNION ALL', 'UNION', 'FETCH FIRST', 'FOR UPDATE'];

/** [nom, snippet]. */
const FUNCTIONS: [string, string][] = [
  ['COUNT', 'COUNT(${1:*})'], ['SUM', 'SUM(${1})'], ['AVG', 'AVG(${1})'], ['MIN', 'MIN(${1})'], ['MAX', 'MAX(${1})'],
  ['NVL', 'NVL(${1}, ${2})'], ['NVL2', 'NVL2(${1}, ${2}, ${3})'], ['COALESCE', 'COALESCE(${1}, ${2})'], ['DECODE', 'DECODE(${1}, ${2}, ${3}, ${4})'],
  ['TO_CHAR', 'TO_CHAR(${1})'], ['TO_DATE', "TO_DATE(${1}, '${2:YYYY-MM-DD}')"], ['TO_NUMBER', 'TO_NUMBER(${1})'], ['TRUNC', 'TRUNC(${1})'], ['ROUND', 'ROUND(${1}, ${2:0})'],
  ['SUBSTR', 'SUBSTR(${1}, ${2:1}, ${3})'], ['INSTR', 'INSTR(${1}, ${2})'], ['LENGTH', 'LENGTH(${1})'], ['UPPER', 'UPPER(${1})'], ['LOWER', 'LOWER(${1})'], ['TRIM', 'TRIM(${1})'],
  ['REPLACE', 'REPLACE(${1}, ${2}, ${3})'], ['LPAD', 'LPAD(${1}, ${2}, ${3})'], ['RPAD', 'RPAD(${1}, ${2}, ${3})'], ['CONCAT', 'CONCAT(${1}, ${2})'],
  ['SYSDATE', 'SYSDATE'], ['SYSTIMESTAMP', 'SYSTIMESTAMP'], ['ADD_MONTHS', 'ADD_MONTHS(${1}, ${2})'], ['MONTHS_BETWEEN', 'MONTHS_BETWEEN(${1}, ${2})'], ['LAST_DAY', 'LAST_DAY(${1})'],
  ['ROW_NUMBER', 'ROW_NUMBER() OVER (ORDER BY ${1})'], ['RANK', 'RANK() OVER (ORDER BY ${1})'], ['LISTAGG', "LISTAGG(${1}, '${2:,}') WITHIN GROUP (ORDER BY ${3})"],
  ['CAST', 'CAST(${1} AS ${2})'], ['DBMS_OUTPUT.PUT_LINE', 'DBMS_OUTPUT.PUT_LINE(${1})'], ['RAISE_APPLICATION_ERROR', 'RAISE_APPLICATION_ERROR(-20001, ${1})'],
];

/** Gabarits de requêtes : libellé, texte, préfixe. */
const SNIPPETS: [string, string, string][] = [
  ['SELECT … FROM', 'SELECT ${1:*}\n  FROM ${2:table}\n WHERE ${3:1 = 1}', 'select'],
  ['INSERT INTO … VALUES', 'INSERT INTO ${1:table} (${2:columns})\nVALUES (${3:values});', 'insert'],
  ['UPDATE … SET', 'UPDATE ${1:table}\n   SET ${2:column} = ${3:value}\n WHERE ${4:condition};', 'update'],
  ['DELETE FROM', 'DELETE FROM ${1:table}\n WHERE ${2:condition};', 'delete'],
  ['SELECT COUNT(*)', 'SELECT COUNT(*)\n  FROM ${1:table};', 'count'],
  ['PL/SQL block', 'DECLARE\n  ${1}\nBEGIN\n  ${2:NULL;}\nEXCEPTION\n  WHEN OTHERS THEN\n    RAISE;\nEND;\n/', 'plsql'],
];

const TABLE_KW = new Set(['from', 'join', 'update', 'into', 'table', 'truncate', 'describe', 'desc', 'analyze']);
const COLUMN_KW = new Set(['select', 'where', 'and', 'or', 'on', 'set', 'by', 'having', 'when', 'then', 'else', 'case', 'distinct', 'not', 'in', 'between', 'like', 'using', 'returning']);
const RESERVED_ALIAS = new Set(['where', 'on', 'left', 'right', 'inner', 'outer', 'full', 'join', 'group', 'order', 'having', 'union', 'minus', 'intersect', 'except', 'set', 'using', 'cross', 'natural', 'fetch', 'connect', 'start', 'values', 'select', 'when', 'returning', 'for', 'limit', 'offset', 'window', 'qualify', 'pivot', 'unpivot', 'sample', 'partition', 'subpartition', 'model', 'with', 'lateral', 'tablesample', 'read', 'only', 'nowait', 'wait', 'skip']);

const clean = (s: string) => s.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/'(?:[^']|'')*'/g, "''");

/** Sous-séquence : « TS » correspond à « TIERS » (comme le filtre flou de VS Code). */
/** Remplace chaînes et commentaires par des espaces (même longueur : les positions restent valables). */
/**
 * Dans un bloc PL/SQL (package, procédure, fonction, trigger, DO…) ou un CREATE VIEW : bornes [début, fin[ de l'instruction SQL
 * contenant la position `rel` — entre deux « ; » ou mots structurants (BEGIN, THEN, LOOP, IS/AS d'un en-tête…), CASE … END et parenthèses respectés.
 */
/** PL/SQL : « SELECT a, b INTO v1, v2 FROM … » — la clause INTO (variables) est remplacée par des espaces pour ne pas être prise pour une table. */
export function blankInto(s: string): string {
  return s.replace(/(\bselect\b[^;]*?)(\binto\b[^;]*?)(?=\bfrom\b)/i, (_m, a: string, b: string) => a + ' '.repeat(b.length));
}

export function sqlChunk(text: string, rel: number): [number, number] {
  const m = maskText(text);
  const toks: { w: string; i: number; e: number }[] = [];
  const re = /[A-Za-z_][\w$#]*|[();]/g;
  let mt: RegExpExecArray | null;
  while ((mt = re.exec(m))) toks.push({ w: mt[0].toLowerCase(), i: mt.index, e: mt.index + mt[0].length });
  const HEADER = new Set(['create', 'procedure', 'function', 'cursor', 'package', 'type', 'trigger', 'subtype']);
  const STRUCT = new Set(['begin', 'declare', 'loop', 'then', 'else', 'exception']);
  let start = 0;
  let depth = 0;
  let caseDepth = 0;
  let first = '';
  for (let k = 0; k < toks.length; k++) {
    const { w, i, e } = toks[k];
    let boundary = false;
    if (w === '(') depth++;
    else if (w === ')') depth = Math.max(0, depth - 1);
    else if (w === 'case') caseDepth++;
    else if (w === 'end') {
      if (caseDepth > 0 || toks[k + 1]?.w === 'case') {
        caseDepth = Math.max(0, caseDepth - 1);
        if (toks[k + 1]?.w === 'case') k++;
      } else boundary = true;
    } else if (w === ';') boundary = true;
    else if (depth === 0 && caseDepth === 0 && (STRUCT.has(w) || ((w === 'is' || w === 'as') && HEADER.has(first)))) boundary = true;
    if (boundary) {
      if (rel >= start && rel <= i) return [start, i];
      start = e;
      first = '';
      depth = 0;
      caseDepth = 0;
    } else if (!first && /^[a-z_]/.test(w)) first = w;
  }
  return [start, Math.max(start, m.length)];
}

export function maskText(s: string): string {
  return s.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|"[^"]*"/g, (m) => ' '.repeat(m.length));
}

/** Position du WHERE de premier niveau (hors parenthèses) dans un texte masqué, ou -1. */
export function topLevelWhere(masked: string): number {
  let d = 0;
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === '(') d++;
    else if (ch === ')') d = Math.max(0, d - 1);
    else if (d === 0 && (ch === 'w' || ch === 'W') && /^where\b/i.test(masked.slice(i, i + 6)) && (i === 0 || /\W/.test(masked[i - 1]))) return i;
  }
  return -1;
}

/** 0 = commence par la saisie, 1 = la contient, 2 = sous-séquence, -1 = ne correspond pas. */
function rankMatch(name: string, partial: string): number {
  if (!partial) return 0;
  const n = name.toLowerCase();
  const p = partial.toLowerCase();
  if (n.startsWith(p)) return 0;
  if (n.includes(p)) return 1;
  return subseq(name, partial) ? 2 : -1;
}

function subseq(name: string, partial: string): boolean {
  if (!partial) return true;
  const n = name.toLowerCase();
  const p = partial.toLowerCase();
  let j = 0;
  for (let i = 0; i < n.length && j < p.length; i++) if (n[i] === p[j]) j++;
  return j === p.length;
}

/** Colonnes d'une sous-requête ou d'une CTE (noms déduits du SELECT ; « * » et « t.* » sont développés à l'usage). */
export interface Virtual {
  cols: string[];
  inner: RefInfo[];
  /** Liste de colonnes explicite : WITH nom (a, b) AS (…). */
  explicit?: string[];
}

export interface RefInfo {
  alias: string;
  table: string; // « schéma.table » ou « table »
  aliased: boolean;
  virtual?: Virtual;
}

const ALIAS_STOP = new Set(['select', 'distinct', 'unique', 'all', 'as', 'from', 'and', 'or', 'not', 'case', 'when', 'then', 'else', 'end', 'by', 'on', 'in', 'is', 'null', 'like', 'between', 'where', 'group', 'order', 'having']);

function matchParen(s: string, open: number): number {
  let d = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') d++;
    else if (s[i] === ')' && --d === 0) return i;
  }
  return -1;
}

/** Retire le contenu des parenthèses (en gardant « () ») : ne reste que le niveau courant. */
function stripParens(s: string): string {
  let d = 0;
  let out = '';
  for (const ch of s) {
    if (ch === '(') {
      if (d++ === 0) out += '(';
    } else if (ch === ')') {
      if (--d === 0) out += ')';
      if (d < 0) d = 0;
    } else if (d === 0) out += ch;
  }
  return out;
}

/** Noms des colonnes produites par un SELECT (texte situé après le mot SELECT). */
export function selectColumns(sel: string): string[] {
  let d = 0;
  let end = sel.length;
  for (let i = 0; i < sel.length; i++) {
    const ch = sel[i];
    if (ch === '(') d++;
    else if (ch === ')') d--;
    else if (d === 0 && /^from\b/i.test(sel.slice(i, i + 5)) && (i === 0 || /\W/.test(sel[i - 1]))) {
      end = i;
      break;
    }
  }
  const list = sel.slice(0, end).replace(/^\s*(distinct|unique|all)\b/i, '');
  const items: string[] = [];
  let cur = '';
  d = 0;
  for (const ch of list) {
    if (ch === '(') d++;
    if (ch === ')') d--;
    if (ch === ',' && d === 0) {
      items.push(cur);
      cur = '';
    } else cur += ch;
  }
  items.push(cur);
  const out: string[] = [];
  for (const raw of items) {
    const it = raw.trim();
    if (!it) continue;
    if (it === '*') {
      out.push('*');
      continue;
    }
    const star = /^("[^"]+"|[\w$#]+)\.\*$/.exec(it);
    if (star) {
      out.push(star[1] + '.*');
      continue;
    }
    const as = /\s+as\s+("[^"]+"|[\w$#]+)\s*$/i.exec(it) ?? /(?<=[\w$#)"\]'])\s+("[^"]+"|[\w$#]+)\s*$/.exec(it);
    if (as) {
      out.push(as[1]);
      continue;
    }
    const col = /(?:^|\.)("[^"]+"|[\w$#]+)\s*$/.exec(it);
    if (col) out.push(col[1]);
  }
  return out;
}

/** Sous-requêtes dans FROM / JOIN : « FROM (SELECT …) x » → table virtuelle x. */
function derivedTables(src: string): RefInfo[] {
  const out: RefInfo[] = [];
  const re = /\(\s*(?:\(\s*)*(?:select|with)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const open = m.index;
    const close = matchParen(src, open);
    if (close < 0) continue;
    re.lastIndex = close + 1;
    const after = /^\s*(?:as\s+)?("?[\w$#]+"?)/i.exec(src.slice(close + 1));
    if (!after || RESERVED_ALIAS.has(after[1].toLowerCase())) continue;
    const before = stripParens(src.slice(0, open)).trimEnd();
    const kw = [...before.matchAll(/\b(select|from|where|join|group\s+by|order\s+by|having|on|set)\b/gi)].pop()?.[1].toLowerCase();
    if (!(before.endsWith('(') ? false : /(?:\bfrom|\bjoin)$/i.test(before) || (before.endsWith(',') && kw === 'from'))) continue;
    const inner = src.slice(open + 1, close);
    const si = mainSelectIndex(inner);
    const name = after[1].replace(/"/g, '');
    out.push({ alias: name, table: name, aliased: true, virtual: { cols: selectColumns(inner.slice(si + 6)), inner: parseRefList(inner) } });
  }
  return out;
}

/** CTE : WITH nom [(colonnes)] AS (SELECT …), nom2 AS (…) */
export function parseCtes(text: string): Map<string, Virtual> {
  const src = clean(text);
  const out = new Map<string, Virtual>();
  const re = /(?:\bwith\s+(?:recursive\s+)?|,\s*)("?[\w$#]+"?)\s*(?:\(([^()]*)\))?\s+as\s*\(\s*select\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const o = src.lastIndexOf('(', m.index + m[0].length);
    const end = matchParen(src, o);
    if (end < 0) continue;
    re.lastIndex = end + 1;
    const inner = src.slice(o + 1, end);
    const si = mainSelectIndex(inner);
    out.set(m[1].replace(/"/g, '').toLowerCase(), {
      cols: selectColumns(inner.slice(si + 6)),
      inner: parseRefList(inner),
      explicit: m[2] ? m[2].split(',').map((x) => x.trim().replace(/"/g, '')).filter(Boolean) : undefined,
    });
  }
  return out;
}

/** Contenu des parenthèses imbriquées remplacé par des espaces (les parenthèses restent) : ne reste que le niveau courant. */
function blankNested(s: string): string {
  let d = 0;
  let out = '';
  for (const ch of s) {
    if (ch === '(') {
      out += d === 0 ? '(' : ' ';
      d++;
    } else if (ch === ')') {
      d = Math.max(0, d - 1);
      out += d === 0 ? ')' : ' ';
    } else out += d === 0 ? ch : ch === '\n' ? '\n' : ' ';
  }
  return out;
}

/** Portées de requête contenant la position `rel` : sous-requête la plus interne d'abord, puis les requêtes englobantes. */
function enclosingScopes(masked: string, rel: number): [number, number][] {
  const stack: number[] = [];
  for (let i = 0; i < Math.min(rel, masked.length); i++) {
    if (masked[i] === '(') stack.push(i);
    else if (masked[i] === ')') stack.pop();
  }
  const scopes: [number, number][] = [];
  for (let k = stack.length - 1; k >= 0; k--) {
    const open = stack[k];
    if (/^\(\s*(?:\(\s*)*(?:select|with)\b/i.test(masked.slice(open, open + 40))) {
      const close = matchParen(masked, open);
      scopes.push([open + 1, close < 0 ? masked.length : close]);
    }
  }
  scopes.push([0, masked.length]);
  return scopes;
}

/** Position du SELECT principal d'un texte (après les définitions WITH éventuelles). */
function mainSelectIndex(inner: string): number {
  let d = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '(') d++;
    else if (ch === ')') d--;
    else if (d === 0 && /^select\b/i.test(inner.slice(i, i + 7)) && (i === 0 || /\W/.test(inner[i - 1]))) return i;
  }
  return inner.search(/\bselect\b/i);
}

const FN_TABLES = 'table|xmltable|json_table|unnest|generate_series|lateral|jsonb_to_recordset|json_to_recordset';

/** Tables d'UNE portée de requête (les sous-requêtes imbriquées ne sont pas dans la portée). */
function refsOfScope(scope: string, flat: boolean): RefInfo[] {
  const out: RefInfo[] = [];
  let src = flat ? scope : blankNested(scope);
  // PARTITION (p1) / SAMPLE (10) : retirés pour que l'alias qui suit soit lu
  src = src.replace(/\b(?:sub)?partition\s*(?:for\s*)?\([^)]*\)/gi, (m) => ' '.repeat(m.length)).replace(/\bsample\s*(?:block\s*)?\([^)]*\)(?:\s*seed\s*\([^)]*\))?/gi, (m) => ' '.repeat(m.length));
  // FROM TABLE(f(x)) t / XMLTABLE(...) t / UNNEST(...) t : alias connu, colonnes inconnues
  const fnSrc = blankNested(scope);
  const fnRe = new RegExp('(\\b(?:from|join)\\s*|,\\s*)(?:' + FN_TABLES + ')\\s*\\(\\s*\\)\\s*(?:as\\s+)?("?[\\w$#]+"?)', 'gi');
  let f: RegExpExecArray | null;
  while ((f = fnRe.exec(fnSrc))) {
    const a = f[2].replace(/"/g, '');
    if (!RESERVED_ALIAS.has(a.toLowerCase())) out.push({ alias: a, table: a, aliased: true, virtual: { cols: [], inner: [] } });
  }
  src = src.replace(new RegExp('(\\b(?:from|join)\\s*|,\\s*)(?:' + FN_TABLES + ')\\s*\\(\\s*\\)\\s*(?:as\\s+)?"?[\\w$#]+"?', 'gi'), (_m, p1: string) => p1);
  const re = /\b(?:from|join|update|into|using)\s+([^()]*?)(?=\b(?:where|group|order|having|union|minus|intersect|except|connect|start|set|values|select|on|using|left|right|inner|full|cross|natural|join|fetch|offset|limit|for|window|qualify|pivot|unpivot|model|when|returning)\b|[(;]|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    for (const item of m[1].split(',')) {
      // [schéma.]table[@lien_de_base] [AS] [alias] — le reste de l'élément (FOR UPDATE, LIMIT…) est ignoré
      const x = /^\s*(?:"?([\w$#]+)"?\.)?"?([\w$#]+)"?(?:@[\w$#.]+)?(?:\s+(?:as\s+)?"?([\w$#]+)"?)?/i.exec(item);
      if (!x || RESERVED_ALIAS.has(x[2].toLowerCase()) || FN_TABLES.split('|').includes(x[2].toLowerCase())) continue;
      const aliased = !!x[3] && !RESERVED_ALIAS.has(x[3].toLowerCase());
      out.push({ alias: aliased ? x[3] : x[2], table: (x[1] ? x[1] + '.' : '') + x[2], aliased });
    }
  }
  out.push(...derivedTables(scope));
  return out;
}

/**
 * Tables / alias visibles à une position du texte.
 * Sans `rel` : toutes les tables du texte (parenthèses comprises), comme avant.
 * Avec `rel` : portée du curseur — sa sous-requête d'abord, puis les requêtes englobantes (sous-requêtes corrélées) ;
 * les tables d'une sous-requête ne « fuient » plus dans la requête principale.
 */
export function parseRefList(text: string, rel?: number): RefInfo[] {
  const masked = maskText(text);
  if (rel === undefined) return refsOfScope(masked, true);
  const out: RefInfo[] = [];
  const seen = new Set<string>();
  for (const [a, b] of enclosingScopes(masked, Math.min(rel, masked.length))) {
    for (const r of refsOfScope(masked.slice(a, b), false)) {
      const k = r.alias.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(r);
    }
  }
  return out;
}

/** alias (ou nom) en MAJUSCULES → table. */
export function parseRefs(text: string): Map<string, string> {
  const refs = new Map<string, string>();
  for (const r of parseRefList(text)) {
    refs.set(r.alias.toUpperCase(), r.table);
    refs.set(r.table.split('.').pop()!.toUpperCase(), r.table);
  }
  return refs;
}

/** « Date de création » → DATE_DE_CREATION (sans accents, sans caractères spéciaux), borné à la longueur d'identifiant du SGBD. */
export function commentToAlias(comment: string, max: number): string {
  let s = comment
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  if (/^\d/.test(s)) s = 'C_' + s;
  return s.slice(0, max).replace(/_+$/, '');
}

interface Context {
  before: string;
  whole: string;
  head: string;
  partial: string;
  wordRange?: vscode.Range;
  prev: string;
  lastKw: string;
  qualified?: string;
  expectTable: boolean;
  afterTable: boolean;
  expectColumn: boolean;
  inOn: boolean;
  inSelect: boolean; // dans la liste du SELECT (avant le FROM)
  skip: boolean; // commentaire ou chaîne
  stmtStart: number; // offset du début de l'instruction
  /** Oracle / PL/SQL : un type est attendu ici (déclaration, paramètre, RETURN, TABLE OF, CAST…). */
  typeExpected?: 'type' | 'typeForm';
  /** Texte de l'unité PL/SQL (ou de l'instruction) avant le mot en cours. */
  unitHead: string;
}

type Mk = (l: string | vscode.CompletionItemLabel, k: vscode.CompletionItemKind, s: string, d?: string, i?: string | vscode.SnippetString, f?: string) => vscode.CompletionItem;

export class SqlCompletion implements vscode.CompletionItemProvider, vscode.HoverProvider {
  /** Survol d'un alias (ou d'un nom de table) de la requête : champs de la table liée. */
  async provideHover(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.Hover | undefined> {
    const act = this.mgr.forDocument(doc.uri) ?? this.mgr.active;
    const wr = doc.getWordRangeAtPosition(pos, /"?[\w$#]+"?/);
    if (!act || !wr) return undefined;
    const word = doc.getText(wr).replace(/"/g, '');
    const c = this.analyze(doc, wr.end);
    if (!c.whole) return undefined;
    const refs = parseRefList(c.whole, c.before.length);
    const ref = refs.find((r) => r.alias.toLowerCase() === word.toLowerCase()) ?? refs.find((r) => !r.virtual && r.table.split('.').pop()!.replace(/"/g, '').toLowerCase() === word.toLowerCase());
    if (!ref) return undefined;
    const md = new vscode.MarkdownString();
    md.appendMarkdown(ref.virtual ? `**${ref.alias}** — ${t('subquery')}\n\n` : `**${ref.alias}** → \`${ref.table}\`\n\n`);
    if (ref.virtual) {
      md.appendMarkdown(ref.virtual.cols.slice(0, 60).map((x) => '`' + x + '`').join(', '));
      return new vscode.Hover(md, wr);
    }
    const schema = act.session.conn.currentSchema;
    const [o, tb] = ref.table.includes('.') ? ref.table.split('.') : [schema, ref.table];
    const r = await within(this.cache.columns(act.profile.id, o.replace(/"/g, ''), tb.replace(/"/g, '')).catch(() => [] as ColMeta[]), 1500);
    if (r === TIMEOUT || !r.length) return undefined;
    md.appendMarkdown('| | ' + t('Column') + ' | ' + t('Type') + ' |\n|---|---|---|\n');
    for (const x of r.slice(0, 60)) md.appendMarkdown(`| ${x.pk ? '🔑' : ''} | ${x.name} | ${x.type}${x.comment ? ' — ' + x.comment.replace(/[|\n]/g, ' ') : ''} |\n`);
    if (r.length > 60) md.appendMarkdown(`\n… +${r.length - 60}`);
    return new vscode.Hover(md, wr);
  }

  /** Positionné par l'écouteur « retour à la ligne » : traité comme un déclenchement automatique. */
  autoTrigger = false;
  private objNames = new WeakMap<Meta, Map<string, string>>();
  /** Packages, procédures, fonctions et paramètres (aide à la saisie et Ctrl+clic). */
  readonly routines = new RoutineCache();

  constructor(private readonly mgr: ConnectionManager, private readonly cache: MetaCache) {
    // précharge (depuis le disque, puis la base) dès qu'une connexion devient active
    mgr.onDidChange(() => this.preload());
  }

  /**
   * Charge le cache depuis le disque pour la connexion active, SANS scanner la base (un scan complet d'un gros schéma est long) :
   * le scan démarre quand on utilise vraiment l'aide à la saisie, ou à la connexion si dbexplorer.scanOnConnect est activé.
   */
  preload() {
    const a = this.mgr.active;
    if (!a) return;
    const scan = vscode.workspace.getConfiguration('dbexplorer').get<boolean>('scanOnConnect', false);
    void this.cache.get(a.profile.id, a.session.conn.currentSchema, scan).catch(() => undefined);
  }

  /** Vide le cache de la connexion active puis le recharge en arrière-plan. */
  invalidate(rescan = true) {
    this.routines.clear();
    const a = this.mgr.active;
    void this.cache.invalidate(a?.profile.id).then(() => {
      if (a && rescan) void this.cache.get(a.profile.id, a.session.conn.currentSchema).catch(() => undefined);
    });
  }

  /** Analyse (synchrone, sans base) de ce qui précède le curseur. */
  analyze(doc: vscode.TextDocument, pos: vscode.Position): Context {
    const act = this.mgr.forDocument(doc.uri) ?? this.mgr.active;
    const dialect = act ? dialectOf(act.session.conn.kind) : 'oracle';
    const off = doc.offsetAt(pos);
    let stmt = statementAt(split(doc.getText(), dialect), off);
    let before = '';
    let whole = '';
    let stmtStart = off;
    if (stmt && off >= stmt.start) {
      const between = doc.getText(new vscode.Range(doc.positionAt(stmt.end), pos));
      if (off > stmt.end && (/;|^\s*\/\s*$/m.test(between) || (!stmt.isPlsql && /\n[ \t]*\r?\n/.test(between)))) stmt = undefined; // l'instruction précédente est terminée
      else {
        stmtStart = stmt.start;
        let endOff = stmt.end;
        // bloc PL/SQL, trigger, vue : on ne garde que l'instruction SQL qui contient le curseur
        if (stmt.isPlsql || /^\s*(?:create|declare|begin)\b/i.test(stmt.text)) {
          const [a, b] = sqlChunk(stmt.text, off - stmt.start);
          stmtStart = stmt.start + a;
          endOff = stmt.start + b;
        }
        before = doc.getText(new vscode.Range(doc.positionAt(stmtStart), pos));
        whole = doc.getText(new vscode.Range(doc.positionAt(stmtStart), doc.positionAt(Math.max(endOff, off))));
        if (stmtStart !== stmt.start || stmt.isPlsql) {
          before = blankInto(before);
          whole = blankInto(whole);
        }
      }
    }
    const lineBefore = doc.lineAt(pos.line).text.slice(0, pos.character);
    const skip = /--/.test(lineBefore.replace(/'(?:[^']|'')*'/g, "''")) || (before.replace(/--[^\n]*/g, '').match(/'/g) ?? []).length % 2 === 1;

    const wordRange = doc.getWordRangeAtPosition(pos, /[\w$#]+/);
    const partial = wordRange ? doc.getText(new vscode.Range(wordRange.start, pos)) : '';
    const head = before.slice(0, before.length - partial.length);
    const tokens = [...clean(head).matchAll(/[A-Za-z_][\w$#]*|[(),.;=<>]|\S/g)].map((m) => m[0].toLowerCase());
    const prev = tokens[tokens.length - 1] ?? '';
    let lastKw = '';
    for (let i = tokens.length - 1; i >= 0; i--) {
      if (TABLE_KW.has(tokens[i]) || COLUMN_KW.has(tokens[i])) {
        lastKw = tokens[i];
        break;
      }
    }
    const qm = /([\w$#"]+)\.$/.exec(head);
    const expectTable = TABLE_KW.has(prev) || (prev === ',' && lastKw === 'from');
    const afterTable = !expectTable && (lastKw === 'from' || lastKw === 'join' || lastKw === 'update') && /[\w$#"]$/.test(head.trimEnd()) && /\s$/.test(head);
    const expectColumn = !expectTable && !afterTable && (COLUMN_KW.has(prev) || prev === ',' || prev === '(' || prev === '=' || prev === '<' || prev === '>' || COLUMN_KW.has(lastKw));
    const lastOn = tokens.lastIndexOf('on');
    const lastJoin = tokens.lastIndexOf('join');
    const afterOn = tokens.slice(lastOn + 1).some((x) => ['where', 'group', 'order', 'having', 'select'].includes(x));
    const inOn = lastOn >= 0 && lastOn > lastJoin && !afterOn;
    const inSelect = tokens.lastIndexOf('select') > tokens.lastIndexOf('from');
    // type attendu (PL/SQL Oracle) : on regarde toute l'unité avant le curseur, pas seulement l'instruction SQL qui le contient
    let unitHead = '';
    let typeExpected: Context['typeExpected'];
    if (act?.session.conn.kind === 'oracle' && !skip && stmt && off >= stmt.start) {
      unitHead = doc.getText(new vscode.Range(doc.positionAt(stmt.start), pos));
      unitHead = unitHead.slice(0, unitHead.length - partial.length);
      typeExpected = expectsType(maskText(unitHead))?.kind;
    }
    return { before, whole, head, partial, wordRange, prev, lastKw, qualified: qm?.[1], expectTable, afterTable, expectColumn, inOn, inSelect, skip, stmtStart, typeExpected, unitHead };
  }

  /** Faut-il ouvrir l'aide automatiquement (après Entrée / espace) ? */
  wantsAutoSuggest(doc: vscode.TextDocument, pos: vscode.Position): boolean {
    const c = this.analyze(doc, pos);
    return !c.skip && !c.qualified && (!!c.typeExpected || c.expectTable || c.afterTable || (c.expectColumn && (COLUMN_KW.has(c.prev) || c.prev === ',')));
  }

  private schemaCache = new Map<string, { p: Promise<string[]>; at: number }>();

  /** Liste des schémas, mémorisée 10 min (SELECT DISTINCT owner sur une grosse base Oracle est coûteux). */
  private schemaList(pid: string, conn: { schemas(): Promise<string[]> }): Promise<string[]> {
    const hit = this.schemaCache.get(pid);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.p;
    const p = conn.schemas().catch(() => [] as string[]);
    this.schemaCache.set(pid, { p, at: Date.now() });
    return p;
  }

  private nameMap(meta: Meta) {
    let m = this.objNames.get(meta);
    if (!m) {
      m = new Map(meta.objects.map((o) => [o.name.toLowerCase(), o.name]));
      this.objNames.set(meta, m);
    }
    return m;
  }

  async provideCompletionItems(doc: vscode.TextDocument, pos: vscode.Position, _tok: vscode.CancellationToken, ctx: vscode.CompletionContext): Promise<vscode.CompletionList> {
    const c = this.analyze(doc, pos);
    const auto = ctx.triggerCharacter === ' ' || this.autoTrigger;
    this.autoTrigger = false;
    const empty = new vscode.CompletionList([], false);
    if (c.skip) return empty;
    if (auto && !(c.expectTable || c.expectColumn || c.afterTable || c.typeExpected)) return empty;

    const lower = c.partial !== '' && c.partial === c.partial.toLowerCase();
    const cs = (s: string) => (lower ? s.toLowerCase() : s);
    const range = c.wordRange ?? new vscode.Range(pos, pos);
    const items: vscode.CompletionItem[] = [];
    const mk: Mk = (label, kind, sort, detail, insert, filter) => {
      const name = typeof label === 'string' ? label : label.label;
      const i = new vscode.CompletionItem(label, kind);
      i.range = range;
      i.sortText = sort + name;
      if (detail) i.detail = detail;
      if (insert !== undefined) i.insertText = insert;
      if (filter) i.filterText = filter;
      return i;
    };

    // Jamais plus de ~1,2 s : si la base est lente, on répond avec ce qu'on a (cache) et on ré-ouvre la liste dès que la donnée arrive.
    const pend: Promise<unknown>[] = [];
    let hint = '';
    const guard = async <T>(p: Promise<T>, fallback: T, label?: string): Promise<T> => {
      const r = await within(p.catch(() => fallback), 1200);
      if (r === TIMEOUT) {
        pend.push(p.catch(() => undefined));
        if (label) hint = label;
        return fallback;
      }
      return r as T;
    };
    const finish = (list: vscode.CompletionItem[], incomplete: boolean) => {
      if (hint) {
        const h = mk(hint, KW.Text, '0', undefined, '', c.partial || ' ');
        h.filterText = c.partial || ' ';
        list.unshift(h);
      }
      if (pend.length) this.scheduleRetrigger(doc, pos, pend, auto);
      return new vscode.CompletionList(list, incomplete || pend.length > 0);
    };

    const act = this.mgr.forDocument(doc.uri) ?? this.mgr.active;
    if (!act) {
      this.pushGeneric(items, c.partial, cs, mk, true);
      return new vscode.CompletionList(items, true);
    }
    const pid = act.profile.id;
    const conn = act.session.conn;
    const schema = conn.currentSchema;

    try {
      // ---- type attendu dans un bloc PL/SQL : types prédéfinis, types du bloc / du schéma, %TYPE et %ROWTYPE
      if (c.typeExpected && conn.kind === 'oracle') {
        const loc = localDeclarations(maskText(c.unitHead));
        if (c.qualified) {
          // « table. » → colonnes sous forme d'ancre col%TYPE
          const cols = await guard(this.cache.columns(pid, schema, c.qualified.replace(/"/g, '')), [] as ColMeta[], t('Loading columns of {0}…', c.qualified));
          return finish(cols.map((x) => mk(x.name + '%TYPE', KW.Field, '0', x.type, x.name + '%TYPE', x.name)), false);
        }
        if (c.typeExpected === 'typeForm') {
          return finish(TYPE_FORMS.map((f) => mk(f.name, KW.Struct, '0', f.detail, new vscode.SnippetString(f.snippet))), false);
        }
        const w = (s: string) => (lower ? s.toLowerCase() : s);
        for (const n of loc.types) if (subseq(n, c.partial)) items.push(mk(n, KW.Struct, '00', t('Type declared in this block')));
        for (const v of loc.vars) if (subseq(v, c.partial)) items.push(mk(v + '%TYPE', KW.Variable, '01', t('Same type as the variable {0}', v), w(v + '%TYPE'), v));
        for (const k of loc.cursors) if (subseq(k, c.partial)) items.push(mk(k + '%ROWTYPE', KW.Variable, '02', t('Row of the cursor {0}', k), w(k + '%ROWTYPE'), k));
        const order = { number: '1a', text: '1b', date: '1c', lob: '1d', other: '1e' } as const;
        for (const ty of ORACLE_TYPES) {
          const base = ty.name.split('(')[0];
          if (!subseq(base, c.partial)) continue;
          const body = w(ty.snippet ?? ty.name);
          const i = mk(w(ty.name), KW.Struct, order[ty.group], ty.detail, body.includes('${') ? new vscode.SnippetString(body) : body, base);
          items.push(i);
        }
        for (const n of await guard(this.routines.userTypes(pid, conn, schema), [] as string[])) if (subseq(n, c.partial)) items.push(mk(n, KW.Class, '2', t('User-defined type')));
        if (c.partial.length >= 1) {
          const meta0 = await this.cache.get(pid, schema);
          let n = 0;
          for (const o of meta0.objects) {
            if (o.type !== 'TABLE' && o.type !== 'VIEW' && o.type !== 'SYNONYM') continue;
            if (!subseq(o.name, c.partial)) continue;
            if (n++ >= 80) break;
            items.push(mk(o.name + '%ROWTYPE', KW.Class, '3', t('Row of the table {0}', o.name), w(o.name + '%ROWTYPE'), o.name));
            const col = mk(o.name + '.column%TYPE…', KW.Field, '4', t('Type of a column of {0}', o.name), o.name + '.', o.name);
            col.command = { command: 'editor.action.triggerSuggest', title: '' };
            items.push(col);
          }
        }
        return finish(items, true);
      }

      // ---- paramètres d'une procédure / fonction appelée : « pkg.proc( » → :param (liste complète, notation nommée, paramètre courant en tête)
      const call = callContext(maskText(c.head));
      if (call && call.chain.length <= 3) {
        const target = await guard(this.routines.resolve(pid, conn, call.chain), undefined);
        if (target) {
          const { first, rest, full } = suggestArgs(await guard(this.routines.argsOf(pid, conn, target), [] as RoutineArg[]), call.argIndex);
          const colon = (c.wordRange ? c.wordRange.start : pos).translate(0, -1);
          const hasColon = colon.character >= 0 && doc.getText(new vscode.Range(colon, colon.translate(0, 1))) === ':';
          const prange = hasColon ? new vscode.Range(colon, pos) : range;
          const bindName = (a: RoutineArg) => a.name.toLowerCase().replace(/[^\w$#]/g, '_');
          const dirLbl = (a: RoutineArg) => (a.dir === 'in' ? 'IN' : a.dir === 'out' ? 'OUT' : 'IN OUT');
          const paramItem = (a: RoutineArg, sort: string) => {
            const i = mk(':' + bindName(a), KW.Variable, sort, `${dirLbl(a)} ${a.type} — ${target.pkg ? target.pkg + '.' : ''}${target.name}`);
            i.range = prange;
            i.filterText = ':' + bindName(a);
            return i;
          };
          first.forEach((a, k) => items.push(paramItem(a, '00' + k)));
          rest.forEach((a, k) => items.push(paramItem(a, '01' + String(k).padStart(2, '0'))));
          if (full.length > 1) {
            const all = mk(t('(all parameters)'), KW.Snippet, '02', full.map((a) => ':' + bindName(a)).join(', '), full.map((a) => ':' + bindName(a)).join(', '));
            all.range = prange;
            all.filterText = ':' + c.partial;
            const named = mk(t('(all parameters, named)'), KW.Snippet, '03', full.map((a) => `${a.name.toLowerCase()} => :${bindName(a)}`).join(', '), full.map((a) => `${a.name.toLowerCase()} => :${bindName(a)}`).join(', '));
            named.range = prange;
            named.filterText = ':' + c.partial;
            items.push(all, named);
          }
        }
      }

      const refList = parseRefList(c.whole, c.before.length);
      const ctes = parseCtes(c.whole);
      const base = (x: string) => x.split('.').pop()!.replace(/"/g, '').toLowerCase();

      /** Colonnes d'une table de la requête : table réelle (cache), sous-requête ou CTE. */
      const colsOf = async (r: RefInfo, depth = 0): Promise<ColMeta[]> => {
        const virt = r.virtual ?? ctes.get(base(r.table));
        if (virt && depth < 4) return this.virtualCols(virt, depth, colsOf);
        const [o, tb] = r.table.includes('.') ? r.table.split('.') : [schema, r.table];
        return guard(this.cache.columns(pid, o.replace(/"/g, ''), tb.replace(/"/g, '')), [] as ColMeta[], t('Loading columns of {0}…', tb));
      };
      const detailOf = (r: RefInfo, x: ColMeta) =>
        `${r.alias !== r.table ? r.alias + ' · ' : ''}${base(r.table)}${x.type ? ' · ' + x.type : ''}${x.pk ? ' · PK' : ''}${x.comment ? ' — ' + x.comment : ''}`;

      // ---- « qualificatif. » : alias de table / table / sous-requête → colonnes ; schéma → objets ; package → membres
      if (c.qualified) {
        const rawQ = c.qualified.replace(/"/g, '');
        const ref = refList.find((r) => r.alias.toUpperCase() === rawQ.toUpperCase()) ?? refList.find((r) => base(r.table) === rawQ.toLowerCase()) ?? (ctes.has(rawQ.toLowerCase()) ? ({ alias: rawQ, table: rawQ, aliased: false } as RefInfo) : undefined);
        const cols = ref ? await colsOf(ref) : await guard(this.cache.columns(pid, schema, rawQ), [] as ColMeta[], t('Loading columns of {0}…', rawQ));
        if (cols.length || hint) return finish(cols.map((x) => mk(x.name, KW.Field, x.pk ? '0a' : '0b', `${x.type}${x.pk ? ' · PK' : ''}${x.comment ? ' — ' + x.comment : ''}`)), false);
        if (conn.kind === 'oracle') {
          const pk = await conn.findObject(schema, rawQ).catch(() => undefined);
          if (pk?.type === 'PACKAGE') {
            const r = await q(conn, 'SELECT procedure_name FROM all_procedures WHERE owner=:o AND object_name=:p AND procedure_name IS NOT NULL ORDER BY subprogram_id', { o: pk.schema, p: pk.name });
            return new vscode.CompletionList([...new Set(r.rows.map((x) => String(x[0])))].map((n) => mk(n, KW.Method, '0', t('Package member'))), false);
          }
        }
        // le qualificatif n'est un schéma que s'il existe vraiment (sinon : alias inconnu, on ne scanne rien)
        const known = conn.features.schemas ? await guard(this.schemaList(pid, conn), [] as string[]) : [];
        if (!known.some((x) => x.toUpperCase() === rawQ.toUpperCase())) return finish([], false);
        const other = await this.cache.get(pid, rawQ.toUpperCase()).catch(() => undefined);
        return finish((other?.objects ?? []).filter((x) => subseq(x.name, c.partial)).slice(0, 5000).map((x) => this.objectItem(mk, x, '0')), true);
      }

      // ---- alias de colonne : « col AS | » propose le commentaire de la colonne (DATE_DE_CREATION, "Date de création")
      if (c.inSelect) {
        const am = /(?:^|[\s,(])(?:([\w$#"]+)\.)?([\w$#"]+)\s+(?:as\s+)?$/i.exec(c.head);
        const colName = am?.[2]?.replace(/"/g, '');
        if (am && colName && !ALIAS_STOP.has(colName.toLowerCase())) {
          const qual = am[1]?.replace(/"/g, '').toLowerCase();
          const targets = qual ? refList.filter((r) => r.alias.toLowerCase() === qual || base(r.table) === qual) : refList;
          let found: ColMeta | undefined;
          for (const r of targets) {
            found = (await colsOf(r)).find((x) => x.name.toLowerCase() === colName.toLowerCase());
            if (found) break;
          }
          if (found?.comment && found.comment.trim().toLowerCase() !== colName.toLowerCase()) {
            const max = conn.kind === 'oracle' ? 30 : conn.kind === 'postgres' ? 63 : conn.kind === 'mysql' ? 64 : 128;
            const slug = commentToAlias(found.comment, max);
            const qchar = conn.kind === 'mysql' ? '`' : '"';
            const quoted = qchar + found.comment.trim().replace(new RegExp(qchar, 'g'), qchar + qchar) + qchar;
            const aliasItems: vscode.CompletionItem[] = [];
            if (slug) aliasItems.push(mk(slug, KW.Constant, '00', `${t('Column comment')}: ${found.comment}`, slug));
            aliasItems.push(mk(quoted, KW.Constant, '01', t('Column comment (quoted alias)'), quoted, found.comment.trim()));
            for (const k of ['AS', 'FROM']) if (subseq(k, c.partial)) aliasItems.push(mk(cs(k), KW.Keyword, '5'));
            return finish(aliasItems, false);
          }
        }
      }

      const meta = await this.cache.get(pid, schema); // mémoire / disque : jamais la base
      const refsBefore = parseRefList(c.before, c.before.length);

      // ---- jointures proposées d'après les clés étrangères (après JOIN, après ON, et après « a.x = »)
      const eqLeft = c.prev === '=' ? /([\w$#"]+)\.([\w$#"]+)\s*=\s*$/.exec(c.head) : null;
      const needJoin = c.expectTable && c.lastKw === 'join' && refsBefore.length > 0;
      const needComma = c.expectTable && c.prev === ',' && c.lastKw === 'from' && refsBefore.length > 0;
      const commaMode = refList.length > 1 && !/\bjoin\b/i.test(c.whole);
      const needCommaCond = commaMode && c.expectColumn && ['where', 'and', 'or'].includes(c.prev);
      const needOn = c.expectColumn && c.inOn && (c.prev === 'on' || c.prev === 'and') && refsBefore.length > 1;
      const needEq = !!eqLeft && refList.length > 1;
      if (needJoin || needComma || needOn || needEq || needCommaCond) {
        const fkRefs = needEq || needCommaCond ? refList : refsBefore;
        const lists = await Promise.all(
          fkRefs.map((r) => {
            const [o, tb] = r.table.includes('.') ? r.table.split('.') : [schema, r.table];
            return guard(this.cache.fksFor(pid, o, tb), [] as ForeignKey[]);
          })
        );
        const seenFk = new Set<string>();
        const fks = lists.flat().filter((f) => (seenFk.has(f.table + '|' + f.name) ? false : (seenFk.add(f.table + '|' + f.name), true)));
        if (needJoin || needComma) {
          // FROM a, b : la condition de jointure est ajoutée au WHERE existant (texte supplémentaire inséré après le mot WHERE)
          const whereOff = topLevelWhere(maskText(c.whole));
          const whereEdit = (cond: string) => (whereOff >= 0 && c.stmtStart + whereOff + 5 > doc.offsetAt(pos) ? vscode.TextEdit.insert(doc.positionAt(c.stmtStart + whereOff + 5), ` ${cond} AND`) : undefined);
          this.pushJoinTables(items, fks, meta, refsBefore, schema, mk, needComma ? { whereEdit } : undefined);
        } else if (needOn) this.pushOnConditions(items, fks, refsBefore, mk);
        if (needCommaCond) this.pushCommaConditions(items, fks, refList, c.whole, conn.kind === 'oracle', mk);
        if (needEq && eqLeft) await this.pushEquality(items, fks, refList, eqLeft[1].replace(/"/g, ''), eqLeft[2].replace(/"/g, ''), colsOf, mk);
      }

      // ---- colonnes : d'abord celles des tables du FROM (alias compris), le reste seulement si ça n'existe pas
      if (c.expectColumn || (!c.expectTable && !c.afterTable && refList.length)) {
        const perRef = await Promise.all(refList.map(async (r) => ({ r, cols: await colsOf(r) })));
        const freq = new Map<string, number>();
        for (const { cols } of perRef) for (const n of new Set(cols.map((x) => x.name.toLowerCase()))) freq.set(n, (freq.get(n) ?? 0) + 1);
        // alias / tables du FROM : « t. » ouvre directement la liste de leurs colonnes
        if (c.expectColumn) {
          const seenAlias = new Set<string>();
          for (const { r } of perRef) {
            if (seenAlias.has(r.alias.toLowerCase())) continue;
            seenAlias.add(r.alias.toLowerCase());
            const i = mk(r.alias, KW.Variable, '0q', r.alias !== r.table ? base(r.table) : t('table of the FROM clause'), r.alias + '.');
            i.command = { command: 'editor.action.triggerSuggest', title: '' };
            items.push(i);
          }
        }
        let hits = 0;
        const low = c.partial.toLowerCase();
        for (const { r, cols } of perRef) {
          for (const x of cols) {
            const ambiguous = perRef.length > 1 && (freq.get(x.name.toLowerCase()) ?? 0) > 1;
            const label = ambiguous ? `${r.alias}.${x.name}` : x.name;
            items.push(mk(label, KW.Field, c.expectColumn ? (x.pk ? '1a' : '1b') : '2', detailOf(r, x), undefined, ambiguous ? label : undefined));
            if (x.name.toLowerCase().startsWith(low)) hits++;
          }
        }
        // rien dans le FROM qui corresponde à la saisie : colonnes des autres tables du schéma (marquées « hors FROM »)
        if (c.expectColumn && refList.length && c.partial.length >= 2 && hits === 0) {
          const names = this.nameMap(meta);
          const inFrom = new Set(refList.map((r) => base(r.table)));
          let n = 0;
          outerFallback: for (const [tl, cols] of Object.entries(meta.columns)) {
            if (inFrom.has(tl)) continue;
            for (const x of cols) {
              if (!x.name.toLowerCase().startsWith(low)) continue;
              items.push(mk(x.name, KW.Field, '3', `${names.get(tl) ?? tl} · ${x.type}${x.pk ? ' · PK' : ''} — ${t('not in the FROM clause')}`));
              if (++n >= 200) break outerFallback;
            }
          }
        }
        // pas encore de FROM (« SELECT NO| ») : colonnes de toutes les tables du schéma
        if (c.expectColumn && !refList.length && c.partial.length >= 2) {
          const names = this.nameMap(meta);
          const p = c.partial.toLowerCase();
          let n = 0;
          outer: for (const [tl, cols] of Object.entries(meta.columns)) {
            for (const x of cols) {
              if (!x.name.toLowerCase().startsWith(p)) continue;
              items.push(mk(x.name, KW.Field, '2', `${names.get(tl) ?? tl} · ${x.type}${x.pk ? ' · PK' : ''}${x.comment ? ' — ' + x.comment : ''}`));
              if (++n >= 400) break outer;
            }
          }
        }
      }

      // ---- tables / vues / synonymes (classées : préfixe, puis contient, puis sous-séquence — le plafond ne coupe jamais le bon résultat)
      if (c.expectTable || (!c.afterTable && !refList.length)) {
        const buckets: ObjMeta[][] = [[], [], []];
        for (const x of meta.objects) {
          const r = rankMatch(x.name, c.partial);
          if (r >= 0) buckets[r].push(x);
        }
        let count = 0;
        const cap = c.partial ? 5000 : 3000;
        buckets.forEach((b, ri) => {
          for (const x of b) {
            if (count++ >= cap) return;
            items.push(this.objectItem(mk, x, (c.expectTable ? '1' : '3') + ri));
          }
        });
        const localCount = buckets[0].length + buckets[1].length;
        // la base est interrogée par préfixe : objets absents du cache (autre schéma, synonyme public, table créée depuis, scan en cours…)
        const missingLikely = localCount === 0 || !meta.complete;
        if (c.partial.length >= 2 && (missingLikely || c.partial.length >= 3)) {
          const have = new Set(items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label).toLowerCase()));
          const search = this.cache.searchObjects(pid, schema, c.partial);
          const found = missingLikely ? await guard(search, [], t('Searching "{0}" in the database…', c.partial)) : (await within(search.catch(() => []), 500)) === TIMEOUT ? [] : await search.catch(() => []);
          for (const x of found) {
            const foreign = !!x.owner && x.owner !== schema.toUpperCase() && x.owner !== 'PUBLIC';
            const label = foreign ? `${x.owner}.${x.name}` : x.name;
            if (have.has(label.toLowerCase())) continue;
            have.add(label.toLowerCase());
            const i = this.objectItem(mk, { name: label, type: x.type }, c.expectTable ? '13' : '33');
            if (foreign) i.detail = `${x.owner} · ${i.detail ?? ''}`;
            items.push(i);
          }
        } else if (!c.partial && c.expectTable && !meta.complete && !items.length) hint = t('Loading object list…');
        if (c.expectTable && conn.kind === 'oracle') {
          if (!meta.objects.some((o) => o.name === 'DUAL') && subseq('DUAL', c.partial)) items.push(mk('DUAL', KW.Class, '12', t('Oracle dummy table')));
          for (const [n, snip] of [['TABLE', 'TABLE(1)'], ['XMLTABLE', 'XMLTABLE(1)'], ['JSON_TABLE', 'JSON_TABLE(1)']]) {
            if (subseq(n, c.partial)) items.push(mk(cs(n), KW.Function, '2x', t('Table function'), new vscode.SnippetString(snip.replace(/^[A-Z_]+/, (m) => cs(m)))));
          }
        }
        if (c.expectTable && conn.features.schemas) {
          for (const s of await guard(this.schemaList(pid, conn), [] as string[])) if (subseq(s, c.partial)) items.push(mk(s, KW.Module, '2', t('Schema')));
        }
      }

      // ---- mots-clés (après « FROM table » : les clauses suivantes)
      if (c.afterTable) for (const k of AFTER_TABLE) items.push(mk(cs(k), KW.Keyword, '0z'));
      // ---- packages, procédures et fonctions du schéma (à partir d'une lettre saisie)
      if (!c.expectTable && !c.afterTable && c.partial.length >= 1) {
        const list = await guard(this.routines.list(pid, conn, schema), [] as RoutineInfo[]);
        let n = 0;
        for (const r of list) {
          if (!subseq(r.name, c.partial)) continue;
          if (n++ >= 300) break;
          items.push(mk(r.name, r.type === 'PACKAGE' ? KW.Module : r.type === 'PROCEDURE' ? KW.Method : KW.Function, '4', r.type === 'PACKAGE' ? t('Package') : r.type === 'PROCEDURE' ? t('Procedure') : t('Function')));
        }
      }
      if (!c.expectTable) this.pushGeneric(items, c.partial, cs, mk, c.expectColumn);
    } catch {
      /* aide à la saisie : au mieux */
    }
    return finish(items, true);
  }

  /** Quand une donnée lente arrive, ré-ouvre la liste si le curseur n'a pas bougé. */
  private scheduleRetrigger(doc: vscode.TextDocument, pos: vscode.Position, pend: Promise<unknown>[], auto: boolean) {
    const v = doc.version;
    void Promise.allSettled(pend).then(() => {
      const ed = vscode.window.activeTextEditor;
      if (ed && ed.document === doc && doc.version === v && ed.selection.active.isEqual(pos)) {
        this.autoTrigger = auto;
        void vscode.commands.executeCommand('editor.action.triggerSuggest');
      }
    });
  }

  // ------------------------------------------------------------------ jointures

  /** Colonnes d'une sous-requête / CTE ; « * » et « t.* » sont développés avec les tables internes. */
  private async virtualCols(v: Virtual, depth: number, colsOf: (r: RefInfo, d?: number) => Promise<ColMeta[]>): Promise<ColMeta[]> {
    const out: ColMeta[] = [];
    for (const n of v.cols) {
      if (n === '*') for (const r of v.inner) out.push(...(await colsOf(r, depth + 1)));
      else if (n.endsWith('.*')) {
        const a = n.slice(0, -2).replace(/"/g, '').toLowerCase();
        for (const r of v.inner.filter((x) => x.alias.toLowerCase() === a || this.baseName(x.table) === a)) out.push(...(await colsOf(r, depth + 1)));
      } else out.push({ name: n.replace(/"/g, ''), type: '', pk: false });
    }
    if (v.explicit?.length) return v.explicit.map((name, i) => ({ name, type: out[i]?.type ?? '', pk: false }));
    return out;
  }

  /** Après « a.x = » : colonnes des autres tables du FROM — d'abord celle liée par clé étrangère, puis même nom, puis les autres. */
  private async pushEquality(
    items: vscode.CompletionItem[],
    fks: ForeignKey[],
    refs: RefInfo[],
    leftAlias: string,
    leftCol: string,
    colsOf: (r: RefInfo) => Promise<ColMeta[]>,
    mk: Mk
  ) {
    const left = refs.find((r) => r.alias.toLowerCase() === leftAlias.toLowerCase()) ?? refs.find((r) => this.baseName(r.table) === leftAlias.toLowerCase());
    if (!left) return;
    const lt = this.baseName(left.table);
    const lc = leftCol.toLowerCase();
    const others = refs.filter((r) => r !== left && r.alias.toLowerCase() !== left.alias.toLowerCase());
    const seen = new Set<string>();
    const add = (r: RefInfo, col: string, sort: string, detail: string) => {
      const label = `${r.alias}.${col}`;
      if (seen.has(label.toLowerCase())) return;
      seen.add(label.toLowerCase());
      items.push(mk(label, KW.Field, sort, detail, label, label));
    };
    for (const fk of fks) {
      const i1 = fk.table.toLowerCase() === lt ? fk.cols.findIndex((c) => c.toLowerCase() === lc) : -1;
      if (i1 >= 0) {
        const r = others.find((o) => this.baseName(o.table) === fk.refTable.toLowerCase());
        if (r) add(r, fk.refCols[i1], '00', t('Foreign key {0}', fk.name));
      }
      const i2 = fk.refTable.toLowerCase() === lt ? fk.refCols.findIndex((c) => c.toLowerCase() === lc) : -1;
      if (i2 >= 0) {
        const r = others.find((o) => this.baseName(o.table) === fk.table.toLowerCase());
        if (r) add(r, fk.cols[i2], '00', t('Foreign key {0}', fk.name));
      }
    }
    for (const r of others) {
      for (const x of await colsOf(r)) add(r, x.name, x.name.toLowerCase() === lc ? '01' : '1', `${this.baseName(r.table)}${x.type ? ' · ' + x.type : ''}${x.comment ? ' — ' + x.comment : ''}`);
    }
  }

  private baseName(table: string) {
    return table.split('.').pop()!.toLowerCase();
  }

  private makeAlias(table: string, used: Set<string>, upper: boolean): string {
    const parts = table.split(/[_\W]+/).filter(Boolean);
    const base = parts.map((p) => p[0]).join('').toLowerCase().slice(0, 3) || 'x';
    let cand = base;
    let n = 1;
    while (used.has(cand) || /^(on|in|is|as|or|by|to|if|of)$/.test(cand)) cand = base + ++n;
    used.add(cand);
    return upper ? cand.toUpperCase() : cand;
  }

  /** Après JOIN : tables liées par clé étrangère aux tables déjà présentes, avec la condition ON prête. */
  private pushJoinTables(items: vscode.CompletionItem[], fks: ForeignKey[], meta: Meta, refs: RefInfo[], schema: string, mk: Mk, comma?: { whereEdit: (cond: string) => vscode.TextEdit | undefined }) {
    const names = this.nameMap(meta);
    const useAlias = refs.every((r) => r.aliased);
    const upper = refs[0].aliased && refs[0].alias === refs[0].alias.toUpperCase() && /[A-Z]/.test(refs[0].alias);
    const used = new Set(refs.map((r) => r.alias.toLowerCase()));
    const seen = new Set<string>();
    for (const ref of refs) {
      const rt = this.baseName(ref.table);
      for (const fk of fks) {
        let cand: string | undefined;
        let cond: (a: string) => string[] = () => [];
        if (fk.table.toLowerCase() === rt) {
          if (fk.refSchema.toUpperCase() !== schema.toUpperCase()) continue;
          cand = fk.refTable; // la table existante référence cand
          cond = (a) => fk.cols.map((c, i) => `${a}.${fk.refCols[i]} = ${ref.alias}.${c}`);
        } else if (fk.refTable.toLowerCase() === rt) {
          cand = fk.table; // cand référence la table existante
          cond = (a) => fk.cols.map((c, i) => `${a}.${c} = ${ref.alias}.${fk.refCols[i]}`);
        }
        if (!cand || refs.some((r) => this.baseName(r.table) === cand!.toLowerCase())) continue;
        const display = names.get(cand.toLowerCase()) ?? cand;
        const key = display + '|' + fk.name + '|' + ref.alias;
        if (seen.has(key)) continue;
        seen.add(key);
        const alias = useAlias ? this.makeAlias(display, new Set(used), upper) : display;
        const on = cond(alias).join(' AND ');
        if (comma) {
          const plain = `${display}${useAlias ? ' ' + alias : ''}`;
          const edit = comma.whereEdit(on);
          const ci = mk({ label: display, detail: `${useAlias ? ' ' + alias : ''} — ${on}` }, KW.Reference, '00', t('Join by foreign key {0}', fk.name) + (edit ? '' : ' — ' + t('add the condition to the WHERE clause')), plain, display);
          if (edit) ci.additionalTextEdits = [edit];
          ci.documentation = new vscode.MarkdownString().appendCodeblock(`FROM …, ${plain}\nWHERE ${on}`, 'sql');
          items.push(ci);
          continue;
        }
        const text = `${display}${useAlias ? ' ' + alias : ''} ON ${on}`;
        const i = mk({ label: display, detail: `${useAlias ? ' ' + alias : ''} ON ${on}` }, KW.Reference, '00', t('Join by foreign key {0}', fk.name), text, display);
        i.documentation = new vscode.MarkdownString().appendCodeblock(`JOIN ${text}`, 'sql');
        items.push(i);
      }
    }
  }

  /** FROM a, b WHERE … : conditions de jointure issues des clés étrangères pas encore écrites (+ variantes (+) Oracle). */
  private pushCommaConditions(items: vscode.CompletionItem[], fks: ForeignKey[], refs: RefInfo[], whole: string, oracle: boolean, mk: Mk) {
    const norm = (x: string) => x.toLowerCase().replace(/\s+/g, '');
    const text = norm(maskText(whole));
    for (const fk of fks) {
      const child = refs.find((r) => this.baseName(r.table) === fk.table.toLowerCase());
      const parent = refs.find((r) => this.baseName(r.table) === fk.refTable.toLowerCase());
      if (!child || !parent || child === parent) continue;
      const parts = fk.cols.map((cl, i) => ({ l: `${child.alias}.${cl}`, r: `${parent.alias}.${fk.refCols[i]}` }));
      if (parts.every((x) => text.includes(norm(x.l + '=' + x.r)) || text.includes(norm(x.r + '=' + x.l)))) continue; // déjà écrite
      const detail = t('Join by foreign key {0}', fk.name);
      const plain = parts.map((x) => `${x.l} = ${x.r}`).join(' AND ');
      items.push(mk(plain, KW.Reference, '00', detail, plain, plain));
      if (oracle) {
        const keepChild = parts.map((x) => `${x.l} = ${x.r} (+)`).join(' AND ');
        const keepParent = parts.map((x) => `${x.l} (+) = ${x.r}`).join(' AND ');
        items.push(mk(keepChild, KW.Reference, '01', `${detail} — ${t('outer join: keep all rows of {0}', child.alias)}`, keepChild, keepChild));
        items.push(mk(keepParent, KW.Reference, '02', `${detail} — ${t('outer join: keep all rows of {0}', parent.alias)}`, keepParent, keepParent));
      }
    }
  }

  /** Après ON : conditions d'égalité issues des clés étrangères entre la dernière table jointe et les précédentes. */
  private pushOnConditions(items: vscode.CompletionItem[], fks: ForeignKey[], refs: RefInfo[], mk: Mk) {
    const last = refs[refs.length - 1];
    const lt = this.baseName(last.table);
    for (const other of refs.slice(0, -1)) {
      const ot = this.baseName(other.table);
      for (const fk of fks) {
        let conds: string[] | undefined;
        if (fk.table.toLowerCase() === lt && fk.refTable.toLowerCase() === ot) conds = fk.cols.map((c, i) => `${last.alias}.${c} = ${other.alias}.${fk.refCols[i]}`);
        else if (fk.table.toLowerCase() === ot && fk.refTable.toLowerCase() === lt) conds = fk.cols.map((c, i) => `${other.alias}.${c} = ${last.alias}.${fk.refCols[i]}`);
        if (!conds) continue;
        const text = conds.join(' AND ');
        items.push(mk(text, KW.Reference, '00', t('Foreign key {0}', fk.name), text, text));
      }
    }
  }

  // ------------------------------------------------------------------- éléments

  private objectItem(mk: Mk, x: { name: string; type: string }, sort: string) {
    const kind = x.type === 'VIEW' || x.type === 'MATERIALIZED VIEW' ? KW.Interface : x.type === 'SYNONYM' ? KW.Reference : KW.Class;
    const label = x.type === 'VIEW' ? t('View') : x.type === 'MATERIALIZED VIEW' ? t('Materialized view') : x.type === 'SYNONYM' ? t('Synonym') : t('Table');
    return mk(x.name, kind, sort, label);
  }

  private pushGeneric(items: vscode.CompletionItem[], partial: string, cs: (s: string) => string, mk: Mk, includeFunctions: boolean) {
    for (const [name, snip] of FUNCTIONS) {
      if ((!includeFunctions && !partial) || !subseq(name, partial)) continue;
      items.push(mk(cs(name), KW.Function, '5', t('Function'), new vscode.SnippetString(snip.replace(/^[A-Za-z_.]+/, (m) => cs(m)))));
    }
    for (const k of KEYWORDS) if (subseq(k, partial)) items.push(mk(cs(k), KW.Keyword, '8'));
    for (const [label, body, key] of SNIPPETS) {
      if (partial && !subseq(key, partial) && !subseq(label, partial)) continue;
      const i = mk(label, KW.Snippet, '6', t('Snippet'), new vscode.SnippetString(body));
      i.filterText = key + ' ' + label;
      items.push(i);
    }
  }
}
