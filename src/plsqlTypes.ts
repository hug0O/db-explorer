/**
 * Aide à la saisie des types Oracle dans les blocs PL/SQL : où un type est attendu (déclaration, paramètre, RETURN,
 * TABLE OF, CAST…), types prédéfinis, et déclarations locales (types, curseurs, variables) pour %TYPE / %ROWTYPE.
 */

export interface OraType {
  name: string;
  /** Texte inséré (snippet VS Code) ; par défaut le nom. */
  snippet?: string;
  group: 'number' | 'text' | 'date' | 'lob' | 'other';
  detail: string;
}

export const ORACLE_TYPES: OraType[] = [
  { name: 'NUMBER', group: 'number', detail: 'NUMBER[(p[,s])]', snippet: 'NUMBER' },
  { name: 'NUMBER(p,s)', group: 'number', detail: 'NUMBER(precision, scale)', snippet: 'NUMBER(${1:10},${2:0})' },
  { name: 'INTEGER', group: 'number', detail: 'INTEGER' },
  { name: 'PLS_INTEGER', group: 'number', detail: 'PLS_INTEGER (fast integer)' },
  { name: 'BINARY_INTEGER', group: 'number', detail: 'BINARY_INTEGER' },
  { name: 'SIMPLE_INTEGER', group: 'number', detail: 'SIMPLE_INTEGER (NOT NULL)' },
  { name: 'NATURAL', group: 'number', detail: 'NATURAL (≥ 0)' },
  { name: 'POSITIVE', group: 'number', detail: 'POSITIVE (≥ 1)' },
  { name: 'SMALLINT', group: 'number', detail: 'SMALLINT' },
  { name: 'FLOAT', group: 'number', detail: 'FLOAT' },
  { name: 'BINARY_FLOAT', group: 'number', detail: 'BINARY_FLOAT' },
  { name: 'BINARY_DOUBLE', group: 'number', detail: 'BINARY_DOUBLE' },
  { name: 'VARCHAR2(n)', group: 'text', detail: 'VARCHAR2(size [BYTE|CHAR])', snippet: 'VARCHAR2(${1:100})' },
  { name: 'VARCHAR2(n CHAR)', group: 'text', detail: 'VARCHAR2 in characters', snippet: 'VARCHAR2(${1:100} CHAR)' },
  { name: 'CHAR(n)', group: 'text', detail: 'CHAR(size)', snippet: 'CHAR(${1:1})' },
  { name: 'NVARCHAR2(n)', group: 'text', detail: 'NVARCHAR2(size)', snippet: 'NVARCHAR2(${1:100})' },
  { name: 'NCHAR(n)', group: 'text', detail: 'NCHAR(size)', snippet: 'NCHAR(${1:1})' },
  { name: 'VARCHAR2', group: 'text', detail: 'VARCHAR2 (PL/SQL: up to 32767)' },
  { name: 'STRING', group: 'text', detail: 'STRING (= VARCHAR2)' },
  { name: 'LONG', group: 'text', detail: 'LONG' },
  { name: 'DATE', group: 'date', detail: 'DATE' },
  { name: 'TIMESTAMP', group: 'date', detail: 'TIMESTAMP[(n)]' },
  { name: 'TIMESTAMP WITH TIME ZONE', group: 'date', detail: 'TIMESTAMP WITH TIME ZONE' },
  { name: 'TIMESTAMP WITH LOCAL TIME ZONE', group: 'date', detail: 'TIMESTAMP WITH LOCAL TIME ZONE' },
  { name: 'INTERVAL DAY TO SECOND', group: 'date', detail: 'INTERVAL DAY TO SECOND' },
  { name: 'INTERVAL YEAR TO MONTH', group: 'date', detail: 'INTERVAL YEAR TO MONTH' },
  { name: 'CLOB', group: 'lob', detail: 'CLOB' },
  { name: 'NCLOB', group: 'lob', detail: 'NCLOB' },
  { name: 'BLOB', group: 'lob', detail: 'BLOB' },
  { name: 'BFILE', group: 'lob', detail: 'BFILE' },
  { name: 'RAW(n)', group: 'lob', detail: 'RAW(size)', snippet: 'RAW(${1:16})' },
  { name: 'LONG RAW', group: 'lob', detail: 'LONG RAW' },
  { name: 'BOOLEAN', group: 'other', detail: 'BOOLEAN (PL/SQL only)' },
  { name: 'SYS_REFCURSOR', group: 'other', detail: 'weakly typed REF CURSOR' },
  { name: 'ROWID', group: 'other', detail: 'ROWID' },
  { name: 'UROWID', group: 'other', detail: 'UROWID' },
  { name: 'XMLTYPE', group: 'other', detail: 'XMLTYPE' },
  { name: 'JSON', group: 'other', detail: 'JSON (21c+)' },
  { name: 'ANYDATA', group: 'other', detail: 'ANYDATA' },
  { name: 'SYS.ODCIVARCHAR2LIST', group: 'other', detail: 'collection of VARCHAR2', snippet: 'SYS.ODCIVARCHAR2LIST' },
  { name: 'SYS.ODCINUMBERLIST', group: 'other', detail: 'collection of NUMBER', snippet: 'SYS.ODCINUMBERLIST' },
];

/** Après « TYPE x IS » : formes de types composés. */
export const TYPE_FORMS: { name: string; snippet: string; detail: string }[] = [
  { name: 'TABLE OF', snippet: 'TABLE OF ${1:type}', detail: 'Nested table / associative array' },
  { name: 'TABLE OF … INDEX BY PLS_INTEGER', snippet: 'TABLE OF ${1:type} INDEX BY ${2:PLS_INTEGER}', detail: 'Associative array' },
  { name: 'VARRAY(n) OF', snippet: 'VARRAY(${1:10}) OF ${2:type}', detail: 'Variable-size array' },
  { name: 'RECORD (…)', snippet: 'RECORD (\n  ${1:field} ${2:NUMBER}\n)', detail: 'Record' },
  { name: 'REF CURSOR', snippet: 'REF CURSOR', detail: 'Cursor variable type' },
];

type Section = 'decl' | 'body' | 'case';

/**
 * Un type est-il attendu à la fin de ce texte (masqué : chaînes et commentaires remplacés) ?
 * Déclaration de variable, paramètre de procédure / fonction, RETURN d'en-tête, TABLE OF, CAST(… AS, SUBTYPE …
 */
export function expectsType(masked: string): { kind: 'type' | 'typeForm' } | undefined {
  // « table. » : on regarde ce qui précède le qualificatif (colonnes proposées sous forme col%TYPE)
  const qual = /([A-Za-z_][\w$#]*)\.$/.exec(masked);
  if (qual) return expectsType(masked.slice(0, qual.index) + ' ');
  const toks = [...masked.matchAll(/[A-Za-z_][\w$#]*|[(),;]|:=|%|\S/g)].map((m) => ({ w: m[0], l: m[0].toLowerCase(), i: m.index ?? 0 }));
  if (!toks.length || !/\s$/.test(masked)) return undefined;
  const stack: Section[] = [];
  let header = false; // procedure / function / package en attente de IS / AS
  let paramDepth = 0; // parenthèses de la liste de paramètres
  let depth = 0;
  let headerDepth = -1;
  let lastStmt = 0; // index du dernier « ; », « is », « as », « declare », « begin », « , », « ( » (début du fragment courant)
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    const prev = toks[k - 1]?.l;
    const next = toks[k + 1]?.l;
    switch (t.l) {
      case 'declare':
        stack.push('decl');
        lastStmt = k + 1;
        break;
      case 'procedure':
      case 'function':
        if (prev !== 'end') header = true;
        break;
      case 'package':
        header = true;
        break;
      case 'is':
      case 'as':
        if (header && depth === 0) {
          header = false;
          stack.push('decl');
          lastStmt = k + 1;
        }
        break;
      case 'case':
        if (prev !== 'end') stack.push('case');
        break;
      case 'begin':
        if (stack.length && stack[stack.length - 1] === 'decl') stack[stack.length - 1] = 'body';
        else stack.push('body');
        lastStmt = k + 1;
        break;
      case 'end':
        if (next === 'case') {
          if (stack[stack.length - 1] === 'case') stack.pop();
        } else if (next !== 'if' && next !== 'loop') stack.pop();
        break;
      case ';':
        header = header && depth > 0;
        lastStmt = k + 1;
        break;
      case '(':
        depth++;
        if (header && headerDepth < 0) {
          headerDepth = depth;
          paramDepth = depth;
        }
        lastStmt = k + 1;
        break;
      case ')':
        if (paramDepth && depth === paramDepth) {
          paramDepth = 0;
          headerDepth = -1;
        }
        depth = Math.max(0, depth - 1);
        lastStmt = k + 1;
        break;
      case ',':
        lastStmt = k + 1;
        break;
    }
  }
  const frag = toks.slice(lastStmt).map((x) => x.l);
  if (!frag.length) return undefined;
  const last = frag[frag.length - 1];
  const inDecl = stack[stack.length - 1] === 'decl' && depth === 0;
  const inRecord = stack[stack.length - 1] === 'decl' && depth > 0 && !paramDepth && frag.length === 1 && !!toks.slice(0, lastStmt).reverse().find((x) => x.l === 'record');
  // CAST(x AS …)
  if (last === 'as' && /\bcast\s*\([^()]*$/i.test(masked.replace(/\bas\s*$/i, ''))) return { kind: 'type' };
  // en-tête : RETURN type
  if (last === 'return' && header) return { kind: 'type' };
  if (last === 'return' && frag.includes('ref') && frag.includes('cursor')) return undefined;
  // paramètres : name [IN] [OUT] [NOCOPY] _
  if (paramDepth && depth === paramDepth) {
    const mods = new Set(['in', 'out', 'nocopy']);
    const rest = frag.filter((x) => !mods.has(x));
    if (rest.length === 1 && frag.length >= 1 && /^[a-z_]/.test(rest[0])) return { kind: 'type' };
    if (rest.length === 0) return undefined;
    return rest.length === 1 ? { kind: 'type' } : undefined;
  }
  if (inDecl || inRecord) {
    if (frag[0] === 'type' && frag.length === 3 && frag[2] === 'is') return { kind: 'typeForm' };
    if (frag[0] === 'subtype' && frag.length === 3 && frag[2] === 'is') return { kind: 'type' };
    if (frag.length >= 2 && frag[frag.length - 2] === 'of' && !frag.includes('constant')) return { kind: 'type' };
    if (frag.length >= 2 && frag[frag.length - 1] === 'of') return { kind: 'type' };
    if (frag[0] === 'cursor' || frag[0] === 'type' || frag[0] === 'subtype' || frag[0] === 'pragma' || frag[0] === 'procedure' || frag[0] === 'function') return undefined;
    const rest = frag.filter((x) => x !== 'constant');
    if (rest.length === 1 && /^[a-z_]/.test(rest[0]) && !['begin', 'end', 'exception', 'is', 'as'].includes(rest[0])) return { kind: 'type' };
  }
  if (frag.length >= 2 && frag[frag.length - 1] === 'of' && stack[stack.length - 1] !== 'body') return { kind: 'type' };
  return undefined;
}

export interface LocalDecls {
  types: string[];
  cursors: string[];
  vars: string[];
}

/** Types (TYPE / SUBTYPE), curseurs et variables déclarés dans le texte (ancres pour %TYPE / %ROWTYPE). */
export function localDeclarations(masked: string): LocalDecls {
  const uniq = (a: string[]) => [...new Set(a)];
  const types = uniq([...masked.matchAll(/\b(?:sub)?type\s+([A-Za-z_][\w$#]*)\s+is\b/gi)].map((m) => m[1]));
  const cursors = uniq([...masked.matchAll(/\bcursor\s+([A-Za-z_][\w$#]*)\s*(?:\([^)]*\))?\s*is\b/gi)].map((m) => m[1]));
  const base = '(?:number|integer|int|pls_integer|binary_integer|simple_integer|natural|positive|varchar2|varchar|char|nchar|nvarchar2|string|date|timestamp|clob|nclob|blob|raw|boolean|rowid|sys_refcursor|float|long|[\\w$#.]+%(?:row)?type' + (types.length ? '|' + types.join('|') : '') + ')';
  const vars = uniq([...masked.matchAll(new RegExp('(?:^|[;\\s(,])([A-Za-z_][\\w$#]*)\\s+(?:constant\\s+)?' + base + '\\b', 'gi'))].map((m) => m[1]).filter((v) => !/^(type|subtype|cursor|in|out|return|is|as|of|then|else)$/i.test(v)));
  return { types, cursors, vars };
}
