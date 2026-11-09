import { maskText, parseRefList } from './completion';
import { topWord, splitTop } from './ansiJoin';
import { t } from './i18n';
import { DbKind } from './drivers/types';

export interface DupQueries {
  /** Requête d'origine avec la clé de chaque table ajoutée au SELECT (et DUP_COUNT quand c'est possible). */
  ids: string;
  /** Une ligne par table : combien de combinaisons des autres tables sont répétées par cette table. */
  summary?: string;
  notes: string[];
}

const AGG = /\b(count|sum|avg|min|max|listagg|group_concat|string_agg|array_agg|over|rank|row_number|lag|lead)\s*\(/i;
const OPERATORS = new Set(['||', '+', '-', '*', '/', '%', '=', '<', '>', '<=', '>=', '<>', '!=', 'and', 'or', 'not', 'case', 'when', 'then', 'else', 'distinct', 'in', 'is', 'like', 'between', 'as']);

/** « expr AS alias » / « expr alias » → expr (sinon l'élément tel quel). */
function stripAlias(item: string): string {
  const m = maskText(item).trimEnd();
  const asM = /\s+as\s+("?[\w$#]+"?)$/i.exec(m);
  if (asM) return item.slice(0, asM.index).trim();
  const last = /\s+("?[A-Za-z_][\w$#]*"?)$/.exec(m);
  if (last) {
    const before = m.slice(0, last.index).trimEnd();
    const prev = (/(\S+)$/.exec(before) ?? [])[1]?.toLowerCase();
    if (before && prev && !OPERATORS.has(prev) && !/[(.,]$/.test(before) && !/^\d+$/.test(last[1])) return item.slice(0, last.index).trim();
  }
  return item.trim();
}

/**
 * Détecteur de doublons d'une requête : ajoute au SELECT la clé de chaque table du FROM (clé primaire, sinon ROWID / ctid / rowid)
 * pour voir quelle table répète les lignes, et propose un récapitulatif par table. undefined + raison si la requête n'est pas analysable.
 */
export async function buildDupQueries(
  sqlRaw: string,
  kind: DbKind,
  defaultSchema: string,
  columnsOf: (owner: string, table: string) => Promise<{ name: string; pk: boolean }[]>
): Promise<DupQueries | { error: string }> {
  const sql = sqlRaw.trim().replace(/;+\s*$/, '');
  const m = maskText(sql);
  if (topWord(m, /^(union|intersect|minus|except)\b/i) >= 0) return { error: t('UNION / INTERSECT / MINUS queries are not supported.') };
  const sel = topWord(m, /^select\b/i);
  const fromIdx = sel < 0 ? -1 : topWord(m, /^from\b/i, sel);
  if (sel < 0 || fromIdx < 0) return { error: t('This is not a SELECT … FROM query.') };
  const notes: string[] = [];
  let listStart = sel + 6;
  const dm = /^\s*(distinct|unique|all)\b/i.exec(m.slice(listStart));
  if (dm) {
    if (!/^all$/i.test(dm[1])) notes.push(t('DISTINCT was removed: it hides the duplicates.'));
    listStart += dm[0].length;
  }
  let list = sqlRaw.trim().slice(listStart, fromIdx).trim();
  const hint = /^\/\*\+[\s\S]*?\*\//.exec(list)?.[0] ?? '';
  if (hint) list = list.slice(hint.length).trim();
  const head = sql.slice(0, sel);
  let rest = sql.slice(fromIdx);
  const restMasked = maskText(rest);

  const refs = parseRefList(sql, sql.length).filter((r) => !r.virtual);
  const seen = new Set<string>();
  const tables: { alias: string; cols: string[] }[] = [];
  const used = new Set<string>();
  const short = (s: string) => {
    let n = s.toUpperCase().replace(/[^\w$#]/g, '_').slice(0, 30);
    for (let i = 2; used.has(n); i++) n = n.slice(0, 27) + '_' + i;
    used.add(n);
    return n;
  };
  const idItems: string[] = [];
  const idAliases: { alias: string; col?: string }[] = [];
  for (const r of refs) {
    const key = r.alias.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const [o, tb] = r.table.includes('.') ? r.table.split('.') : [defaultSchema, r.table];
    const cols = await columnsOf(o.replace(/"/g, ''), tb.replace(/"/g, '')).catch(() => []);
    const pk = cols.filter((c) => c.pk).map((c) => c.name);
    const alias = r.alias.replace(/"/g, '');
    if (pk.length) {
      for (const c of pk) {
        const a = short(`${alias}_${c}`);
        idItems.push(`${alias}.${c} AS ${a}`);
        idAliases.push({ alias: a, col: pk.length === 1 ? a : undefined });
      }
      tables.push({ alias, cols: pk });
    } else {
      const rid = kind === 'oracle' ? 'ROWID' : kind === 'postgres' ? 'ctid' : kind === 'sqlite' ? 'rowid' : undefined;
      if (!rid) {
        notes.push(t('{0}: no primary key, table skipped.', alias));
        continue;
      }
      const a = short(`${alias}_${rid}`);
      idItems.push(`${alias}.${rid} AS ${a}`);
      idAliases.push({ alias: a, col: a });
      tables.push({ alias, cols: [rid] });
      notes.push(t('{0}: no primary key, {1} used.', alias, rid));
    }
  }
  if (!idItems.length) return { error: t('No table with a key found in the FROM clause.') };

  if (list.trim() === '*') list = tables.map((x) => `${x.alias}.*`).join(', ');

  // DUP_COUNT : nombre de lignes identiques sur les colonnes d'origine (si la liste est énumérable)
  const items = list ? splitTop(list, maskText(list), 'comma') : [];
  const canCount = items.length > 0 && items.length <= 40 && !items.some((i) => /(^|[\s,(])\*|\.\s*\*/.test(maskText(i))) && !AGG.test(maskText(list)) && !/\b(group\s+by|connect\s+by|having)\b/i.test(restMasked);
  if (!canCount) notes.push(t('DUP_COUNT not added (the SELECT has * or aggregates).'));
  const orderIdx = topWord(restMasked, /^order\s+by\b/i);
  const bodyNoOrder = orderIdx >= 0 ? rest.slice(0, orderIdx).trimEnd() : rest;

  const pad = ' '.repeat(7);
  const sel2 = `SELECT ${hint ? hint + ' ' : ''}${idItems.join(', ')}${list ? `,\n${pad}${list}` : ''}${canCount ? `,\n${pad}COUNT(*) OVER (PARTITION BY ${items.map(stripAlias).join(', ')}) AS DUP_COUNT` : ''}`;
  const ids = `${head}${sel2}\n  ${rest}`;

  // récapitulatif : pour chaque table (clé simple), combinaisons des AUTRES tables pour lesquelles cette table donne plusieurs lignes
  let summary: string | undefined;
  const single = idAliases.filter((a) => a.col);
  if (idAliases.length >= 2 && single.length) {
    const inner = `${head}SELECT ${idItems.join(', ')}\n  ${bodyNoOrder}`;
    const parts = single.map((a) => {
      const others = idAliases.filter((x) => x !== a).map((x) => x.alias);
      return `SELECT '${a.alias}' AS KEY_COLUMN, COUNT(*) AS REPEATED_GROUPS\n  FROM (SELECT 1 AS X FROM (${inner.replace(/\n/g, '\n       ')}) q\n         GROUP BY ${others.join(', ')}\n        HAVING COUNT(DISTINCT ${a.alias}) > 1) g`;
    });
    summary = parts.join('\nUNION ALL\n');
  } else if (idAliases.length < 2) notes.push(t('A single table: the duplicates come from its own data (use "Find duplicates" on the table).'));
  return { ids, summary, notes };
}
