import { GridLink } from './keyFlags';
import { literal } from './exporters';
import { parseRefList } from './completion';

/** Tables (minuscules, sans schéma) citées dans une requête. */
export function tablesOf(sql: string): Set<string> {
  try {
    return new Set(parseRefList(sql, sql.length).filter((r) => !r.virtual).map((r) => r.table.split('.').pop()!.replace(/"/g, '').toLowerCase()));
  } catch {
    return new Set();
  }
}

/**
 * Lien à suivre sans rien demander : la clé étrangère (ligne parente) d'abord, puis les lignes enfants ;
 * à égalité, de préférence une table qui n'est pas déjà dans la requête affichée.
 */
export function pickLink(links: GridLink[], inQuery: Set<string>): GridLink {
  const score = (l: GridLink) => (l.k === 'p' ? 0 : 10) + (inQuery.has(l.t.toLowerCase()) ? 5 : 0);
  return [...links].sort((a, b) => score(a) - score(b))[0];
}

/** Requête et libellé de fil d'Ariane d'un lien ; undefined si une valeur de la clé est NULL. */
export function linkQuery(link: GridLink, vals: unknown[], conn: { kind: string; currentSchema: string }): { sql: string; label: string } | undefined {
  const values = link.sc.map((i) => vals[i]);
  if (values.some((v) => v === null || v === undefined)) return undefined;
  const oracle = conn.kind === 'oracle';
  const conds = link.tc.map((c, i) => `${c} = ${literal(values[i], oracle)}`);
  const target = link.s && link.s.toLowerCase() !== conn.currentSchema.toLowerCase() ? link.s + '.' + link.t : link.t;
  return {
    sql: `SELECT *\n  FROM ${target}\n WHERE ${conds.join('\n   AND ')}`,
    label: (link.k === 'p' ? '↑ ' : '↓ ') + link.t + ' [' + link.tc.map((c, i) => `${c}=${values[i]}`).join(', ') + ']',
  };
}
