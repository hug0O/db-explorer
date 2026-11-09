import { maskText, topLevelWhere } from './completion';

export interface WritePlan {
  kind: 'UPDATE' | 'DELETE';
  table: string;
  /** SELECT COUNT(*) équivalent : nombre de lignes que l'instruction va toucher. */
  countSql: string;
  hasWhere: boolean;
}

const NOT_ALIAS = /^(set|where|using|returning|order|limit|from|join|inner|left|right|cross|natural|full|values)$/i;

/** Position du premier mot `kw` au niveau 0 de parenthèses à partir de `from` ; -1 sinon. */
function topLevel(masked: string, from: number, re: RegExp): number {
  let d = 0;
  for (let i = from; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === '(') d++;
    else if (ch === ')') d = Math.max(0, d - 1);
    else if (d === 0 && /[A-Za-z]/.test(ch) && (i === 0 || /\W/.test(masked[i - 1])) && re.test(masked.slice(i))) return i;
  }
  return -1;
}

/** Analyse un UPDATE / DELETE mono-table : renvoie la requête de comptage correspondante, sinon undefined (jointures multi-tables, syntaxe inconnue). */
export function planWrite(sql: string): WritePlan | undefined {
  const text = sql.trim().replace(/;+\s*$/, '');
  const masked = maskText(text);
  const head = /^(update|delete)\b\s*(?:(?:only|low_priority|ignore)\s+)*(?:from\s+)?/i.exec(masked);
  if (!head) return undefined;
  const kind = head[1].toUpperCase() as 'UPDATE' | 'DELETE';
  const rest = head[0].length;
  const tm = /^("?[\w$#]+"?(?:\s*\.\s*"?[\w$#]+"?){0,2})(?:\s+(?:as\s+)?("?[\w$#]+"?))?/i.exec(masked.slice(rest));
  if (!tm) return undefined;
  const table = text.slice(rest, rest + tm[1].length);
  const hasAlias = !!tm[2] && !NOT_ALIAS.test(tm[2].replace(/"/g, ''));
  const alias = hasAlias ? text.slice(rest + tm[0].length - tm[2].length, rest + tm[0].length) : '';
  const after = rest + (hasAlias ? tm[0].length : tm[1].length);
  const tail = masked.slice(after);
  if (kind === 'UPDATE' && !/^\s*set\b/i.test(tail)) return undefined;
  if (kind === 'DELETE' && !/^\s*(?:where\b|returning\b|order\b|limit\b|$)/i.test(tail)) return undefined; // DELETE … USING / multi-tables
  if (kind === 'UPDATE' && topLevel(masked, after, /^from\b/i) >= 0) return undefined; // UPDATE … FROM (multi-tables)
  const w = topLevelWhere(masked);
  let where = '';
  if (w >= 0 && w >= after) {
    const end = topLevel(masked, w + 5, /^(?:returning\b|order\s+by\b|limit\b)/i);
    where = text.slice(w, end >= 0 ? end : undefined).trim();
  }
  return { kind, table, hasWhere: !!where, countSql: `SELECT COUNT(*) FROM ${table}${alias ? ' ' + alias : ''}${where ? ' ' + where : ''}` };
}
