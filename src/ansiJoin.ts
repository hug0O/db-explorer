import { maskText } from './completion';
import { t } from './i18n';

/** Contexte de conversion : compteurs + accès aux colonnes d'une table (pour rattacher les colonnes non qualifiées à leur table). */
interface Ctx {
  converted: number;
  skipped: number;
  cross: number;
  reasons: string[];
  columnsOf?: (table: string) => Promise<string[] | undefined>;
}

export interface AnsiResult {
  sql: string;
  /** SELECT réécrits. */
  converted: number;
  /** Tables sans aucune condition de jointure reconnue (écrites en CROSS JOIN). */
  cross: number;
  /** Motifs des SELECT laissés tels quels. */
  reasons: string[];
  /** SELECT avec jointures à l'ancienne laissés tels quels (OR dans le WHERE, (+) des deux côtés, syntaxe non gérée…). */
  skipped: number;
}

const END_FROM = /^(where|group\s+by|order\s+by|having|connect\s+by|start\s+with|fetch|offset|for\s+update|model|window)\b/i;
const SET_OP = /^(union\s+all|union|intersect|minus|except)\b/i;
const isWordStart = (m: string, i: number) => /[A-Za-z]/.test(m[i]) && (i === 0 || !/[\w$#]/.test(m[i - 1]));

function matchParen(m: string, open: number): number {
  let d = 0;
  for (let i = open; i < m.length; i++) {
    if (m[i] === '(') d++;
    else if (m[i] === ')' && --d === 0) return i;
  }
  return -1;
}

/** Position du premier mot (regex ancrée) au niveau 0 de parenthèses dans [from, to) ; -1 sinon. */
function topWord(m: string, re: RegExp, from = 0, to = m.length): number {
  let d = 0;
  for (let i = from; i < to; i++) {
    if (m[i] === '(') d++;
    else if (m[i] === ')') d = Math.max(0, d - 1);
    else if (d === 0 && isWordStart(m, i) && re.test(m.slice(i, to))) return i;
  }
  return -1;
}

/** Découpe aux séparateurs de niveau 0 (virgule ou AND hors BETWEEN). */
function splitTop(text: string, m: string, sep: 'comma' | 'and'): string[] {
  const out: string[] = [];
  let d = 0;
  let last = 0;
  let between = false;
  for (let i = 0; i < m.length; i++) {
    const ch = m[i];
    if (ch === '(') d++;
    else if (ch === ')') d = Math.max(0, d - 1);
    else if (d === 0) {
      if (sep === 'comma' && ch === ',') {
        out.push(text.slice(last, i));
        last = i + 1;
      } else if (sep === 'and' && isWordStart(m, i)) {
        if (/^between\b/i.test(m.slice(i, i + 8))) between = true;
        else if (/^and\b/i.test(m.slice(i, i + 4))) {
          if (between) between = false;
          else {
            out.push(text.slice(last, i));
            last = i + 3;
            i += 2;
          }
        }
      }
    }
  }
  out.push(text.slice(last));
  return out.map((x) => x.trim()).filter(Boolean);
}

interface Item {
  text: string;
  alias: string;
  /** Nom de la table (absent pour une sous-requête ou une fonction de table). */
  table?: string;
}

function parseItem(raw: string): Item | undefined {
  const text = raw.trim();
  const m = maskText(text);
  let end: number;
  let plain = true;
  if (text[0] === '(') {
    plain = false;
    const c = matchParen(m, 0);
    if (c < 0) return undefined;
    end = c + 1;
  } else {
    const nm = /^[\w$#".]+/.exec(m);
    if (!nm) return undefined;
    end = nm[0].length;
    const after = /^\s*\(/.exec(m.slice(end));
    if (after) {
      const c = matchParen(m, end + after[0].length - 1);
      if (c < 0) return undefined;
      end = c + 1;
      plain = false;
    }
  }
  const body = text.slice(0, end);
  const rest = text.slice(end).trim().replace(/^as\s+/i, '');
  if (/\s/.test(rest)) return undefined; // PARTITION (…), SAMPLE, alias composé… : non géré
  const alias = rest || (text[0] === '(' ? '' : body.replace(/"/g, '').split('.').pop()!);
  if (!alias) return undefined;
  return { text: rest ? `${body} ${rest}` : body, alias, table: plain ? body : undefined };
}

const REF = /("?[\w$#]+"?)\s*\.\s*("?[\w$#]+"?)(\s*\(\+\))?/g;
/** Identifiant non qualifié (ni fonction, ni préfixe d'une référence qualifiée, ni variable de liaison), suivi ou non de (+). */
const UNQ = /(?<![\w$#.":])("?[A-Za-z_][\w$#]*"?)(?![\w$#"])(?!\s*\.)(?!\s*\((?!\+\)))(\s*\(\+\))?/g;
const NOT_COLUMN = new Set(['and', 'or', 'not', 'in', 'is', 'null', 'like', 'between', 'exists', 'any', 'all', 'some', 'case', 'when', 'then', 'else', 'end', 'escape', 'true', 'false']);

/** Réécrit un SELECT (jointures par virgule + (+) d'Oracle) en jointures ANSI ; undefined = laissé tel quel. */
async function convertSelect(whole: string, stats: Ctx): Promise<string> {
  const trailing = /\s*$/.exec(whole)![0];
  return (await convertCore(whole.slice(0, whole.length - trailing.length), stats)) + trailing;
}

async function convertCore(part: string, stats: Ctx): Promise<string> {
  const m = maskText(part);
  const sel = topWord(m, /^select\b/i);
  if (sel < 0) return part;
  const fromIdx = topWord(m, /^from\b/i, sel);
  if (fromIdx < 0) return part;
  const semi = /;\s*$/.test(part) ? part.lastIndexOf(';') : part.length;
  const clauseEnd = (from: number) => {
    const e = topWord(m, END_FROM, from, semi);
    return e < 0 ? semi : e;
  };
  const fromEnd = clauseEnd(fromIdx + 4);
  const fromText = part.slice(fromIdx + 4, fromEnd);
  const fromMasked = m.slice(fromIdx + 4, fromEnd);
  if (topWord(fromMasked, /^(join|inner|left|right|full|cross|natural)\b/i) >= 0) return part; // déjà en ANSI
  const rawItems = splitTop(fromText, fromMasked, 'comma');
  if (rawItems.length < 2) return part;

  const fail = (why: string) => {
    stats.skipped++;
    stats.reasons.push(why);
    return part;
  };
  const items: Item[] = [];
  for (const r of rawItems) {
    const it = parseItem(r);
    if (!it) return fail(t('unsupported FROM item: {0}', rawItems.find((x) => !parseItem(x))?.replace(/\s+/g, ' ').slice(0, 60) ?? ''));
    items.push(it);
  }
  const idx = new Map(items.map((it, i) => [it.alias.toLowerCase(), i] as const));
  if (idx.size !== items.length) return fail(t('the same alias is used twice in the FROM clause')); // alias en double

  // colonnes de chaque table : permettent de rattacher une colonne non qualifiée (« AND TIERS_ID = COMMA_TIERS_ID ») à sa table
  const colSets = await Promise.all(
    items.map(async (it) => {
      if (!it.table || !stats.columnsOf) return undefined;
      const c = await stats.columnsOf(it.table).catch(() => undefined);
      return c?.length ? new Set(c.map((x) => x.toLowerCase())) : undefined;
    })
  );

  // WHERE
  let whereText = '';
  let whereEnd = fromEnd;
  if (/^where\b/i.test(m.slice(fromEnd, fromEnd + 5))) {
    whereEnd = clauseEnd(fromEnd + 5);
    whereText = part.slice(fromEnd + 5, whereEnd);
  }
  const whereMasked = maskText(whereText);
  if (topWord(whereMasked, /^or\b/i) >= 0) return fail(t('OR at the top level of the WHERE clause')); // OR de niveau 0 : l'ordre de priorité ne permet pas de séparer les jointures
  const conj = whereText ? splitTop(whereText, whereMasked, 'and') : [];

  const refsOf = (cm: string) => {
    const aliases = new Set<number>();
    const plus = new Set<number>();
    for (const r of cm.matchAll(REF)) {
      const i = idx.get(r[1].replace(/"/g, '').toLowerCase());
      if (i === undefined) continue;
      aliases.add(i);
      if (r[3]) plus.add(i);
    }
    // colonnes non qualifiées : rattachées à la seule table du FROM qui possède cette colonne
    const unq = cm.replace(REF, (x) => ' '.repeat(x.length));
    for (const r of unq.matchAll(UNQ)) {
      const name = r[1].replace(/"/g, '').toLowerCase();
      if (NOT_COLUMN.has(name)) continue;
      const owners = colSets.map((cs, i) => (cs?.has(name) ? i : -1)).filter((i) => i >= 0);
      if (owners.length !== 1) continue; // inconnue ou ambiguë
      aliases.add(owners[0]);
      if (/\(\+\)/.test(r[2] ?? '')) plus.add(owners[0]);
    }
    return { aliases, plus };
  };
  const attached: { text: string; plus: Set<number>; join: boolean }[][] = items.map(() => []);
  const filters: string[] = [];
  for (const c of conj) {
    const cm = maskText(c);
    if (/\bselect\b/i.test(cm)) {
      filters.push(c);
      continue;
    }
    const { aliases, plus } = refsOf(cm);
    const clean = c.replace(/\s*\(\+\)/g, '');
    if (aliases.size >= 2) {
      if (plus.size && [...plus].length > 1 && [...aliases].every((a) => plus.has(a))) return fail(t('(+) on both sides of a condition: {0}', c.replace(/\s+/g, ' ').slice(0, 80))); // (+) des deux côtés
      const k = Math.max(...aliases);
      attached[k].push({ text: swapOperands(clean, k, refsOf), plus, join: true });
    } else if (aliases.size === 1 && plus.size === 1) attached[[...aliases][0]].push({ text: clean, plus, join: false });
    else filters.push(c);
  }

  const upper = part.slice(fromIdx, fromIdx + 4) === 'FROM';
  const kw = (s: string) => (upper ? s.toUpperCase() : s.toLowerCase());
  const ls = part.lastIndexOf('\n', fromIdx) + 1;
  const lead = part.slice(ls, fromIdx);
  const inline = !/^\s*$/.test(lead); // FROM au milieu d'une ligne (sous-requête sur une ligne) : tout reste sur une ligne
  const indent = inline ? '' : lead;
  const nl = inline ? ' ' : '\n' + indent;
  const sub = inline ? ' ' : nl + '  ';
  let from = `${kw('from')} ${items[0].text}`;
  for (let k = 1; k < items.length; k++) {
    const conds = attached[k];
    const joins = conds.filter((c) => c.join);
    let type = 'join';
    if (!joins.length) {
      // pas de condition qui relie cette table : produit cartésien (les filtres (+) isolés redeviennent des filtres)
      for (const c of conds) filters.push(c.text);
      stats.cross++;
      from += `${sub}${kw('cross join')} ${items[k].text}`;
      continue;
    }
    const optional = new Set<number>(joins.flatMap((c) => [...c.plus]));
    if (optional.has(k)) type = 'left join';
    else if (optional.size) type = 'right join';
    from += `${sub}${kw(type)} ${items[k].text} ${kw('on')} ${conds.map((c) => c.text).join(` ${kw('and')} `)}`;
  }
  const where = filters.length ? `${nl}${kw('where')} ${filters.join(`${inline ? ' ' : nl + '  '}${kw('and')} `)}` : '';
  const tail = part.slice(whereEnd, semi).trim();
  stats.converted++;
  return part.slice(0, fromIdx) + from + where + (tail ? nl + tail : '') + part.slice(semi);
}

/** Les SELECT d'un texte (séparés par UNION / INTERSECT / MINUS) : chacun converti à part. */
async function convertQuery(text: string, stats: Ctx): Promise<string> {
  const m = maskText(text);
  const parts: string[] = [];
  const seps: string[] = [];
  let d = 0;
  let last = 0;
  for (let i = 0; i < m.length; i++) {
    if (m[i] === '(') d++;
    else if (m[i] === ')') d = Math.max(0, d - 1);
    else if (d === 0 && isWordStart(m, i)) {
      const so = SET_OP.exec(m.slice(i));
      if (so) {
        parts.push(text.slice(last, i));
        seps.push(text.slice(i, i + so[0].length));
        last = i + so[0].length;
        i = last - 1;
      }
    }
  }
  parts.push(text.slice(last));
  let out = '';
  for (let i = 0; i < parts.length; i++) out += (await convertSelect(parts[i], stats)) + (seps[i] ?? '');
  return out;
}

async function walk(text: string, isQuery: boolean, stats: Ctx): Promise<string> {
  const m = maskText(text);
  let out = '';
  let last = 0;
  let i = 0;
  while (i < text.length) {
    if (m[i] === '(') {
      const close = matchParen(m, i);
      if (close < 0) break;
      const selectLike = /^\s*(select|with)\b/i.test(m.slice(i + 1, close));
      out += text.slice(last, i + 1) + (await walk(text.slice(i + 1, close), selectLike, stats)) + ')';
      last = i = close + 1;
    } else i++;
  }
  out += text.slice(last);
  return isQuery ? await convertQuery(out, stats) : out;
}

/** Transforme les jointures « à l'ancienne » (FROM a, b WHERE a.x = b.y(+)) d'une requête en JOIN ANSI, sous-requêtes comprises. */
export async function toAnsiJoins(sql: string, opts: { columnsOf?: (table: string) => Promise<string[] | undefined> } = {}): Promise<AnsiResult> {
  const stats: Ctx = { converted: 0, skipped: 0, cross: 0, reasons: [], columnsOf: opts.columnsOf };
  const out = await walk(sql, true, stats);
  return { sql: out, converted: stats.converted, skipped: stats.skipped, cross: stats.cross, reasons: stats.reasons };
}

/** Colonne simple (éventuellement qualifiée, éventuellement suivie de (+)). */
const SIMPLE_COL = /^\s*(?:"?[\w$#]+"?\s*\.\s*)?"?[\w$#]+"?(?:\s*\(\+\))?\s*$/;

/** « expression = colonne de la table jointe » devient « colonne de la table jointe = expression » (lecture plus naturelle du ON). */
function swapOperands(cond: string, k: number, refsOf: (cm: string) => { aliases: Set<number> }): string {
  const m = maskText(cond);
  const eq = /[^<>!:=]=(?!=)/.exec(m);
  if (!eq || /[^<>!:=]=(?!=)/.test(m.slice(eq.index + 2))) return cond; // une seule égalité
  const left = cond.slice(0, eq.index + 1);
  const right = cond.slice(eq.index + 2);
  const lm = m.slice(0, eq.index + 1);
  const rm = m.slice(eq.index + 2);
  const la = refsOf(lm).aliases;
  const ra = refsOf(rm).aliases;
  if (SIMPLE_COL.test(rm) && !SIMPLE_COL.test(lm) && ra.size === 1 && ra.has(k) && !la.has(k)) return `${right.trim()} = ${left.trim()}`;
  return cond;
}

export { topWord, splitTop, matchParen, isWordStart };
