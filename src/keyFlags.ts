import { MetaCache, within, TIMEOUT, ColMeta } from './metaCache';
import { parseRefList, maskText } from './completion';
import { ForeignKey } from './drivers/types';

const norm = (x: string) => x.replace(/"/g, '').toLowerCase();

/** Lien suivi depuis une cellule : 'p' = ligne parente (clé étrangère), 'c' = lignes enfants (clé référencée). */
export interface GridLink {
  k: 'p' | 'c';
  s?: string;
  t: string;
  /** Colonnes de la table cible, dans l'ordre de `sc`. */
  tc: string[];
  /** Index (dans le résultat) des colonnes qui portent la valeur de la clé. */
  sc: number[];
}

/** Résultat d'une seule table dont la clé primaire est entièrement présente : cellules modifiables dans la grille. */
export interface EditInfo {
  table: string;
  /** Index des colonnes de la clé primaire dans le résultat, et leurs noms. */
  pk: number[];
  pkNames: string[];
  /** Par colonne : modifiable ? */
  cols: boolean[];
}

export interface KeyInfo {
  edit?: EditInfo;
  /** Par colonne : 'P' clé primaire, 'F' clé étrangère, 'PF', ou ''. */
  flags: string[];
  /** Par colonne : liens navigables (Ctrl+clic). */
  links: GridLink[][];
}

/**
 * Pour chaque colonne du résultat : indicateur PK / FK et liens de navigation par clé étrangère.
 * Rapprochement par nom avec les tables de la requête (cache en priorité, sinon requête ciblée limitée dans le temps).
 */
export async function keyFlags(cache: MetaCache, pid: string, schema: string, sql: string, columns: { name: string }[], waitMs = 1200): Promise<KeyInfo> {
  const flags = columns.map(() => ({ p: false, f: false }));
  const links: GridLink[][] = columns.map(() => []);
  const empty = (): KeyInfo => ({ flags: flags.map(() => ''), links });
  let tableCols: ColMeta[] | undefined;
  let refs;
  try {
    refs = parseRefList(sql, sql.length).filter((r) => !r.virtual);
  } catch {
    return empty();
  }
  const byName = new Map<string, number[]>();
  columns.forEach((c, i) => {
    const k = norm(c.name);
    byName.set(k, [...(byName.get(k) ?? []), i]);
  });
  const indices = (names: string[]): number[] | undefined => {
    const out: number[] = [];
    for (const n of names) {
      const i = byName.get(norm(n))?.[0];
      if (i === undefined) return undefined;
      out.push(i);
    }
    return out;
  };
  const addLink = (cols: number[], l: GridLink) => {
    for (const i of cols) if (links[i].length < 8 && !links[i].some((x) => x.k === l.k && x.t === l.t && x.tc.join() === l.tc.join())) links[i].push(l);
  };
  await Promise.all(
    refs.slice(0, 12).map(async (r) => {
      const [o, tb] = r.table.includes('.') ? r.table.split('.') : [schema, r.table];
      const owner = o.replace(/"/g, '');
      const table = norm(tb);
      const [cols, fks] = await Promise.all([
        within(cache.columns(pid, owner, tb.replace(/"/g, '')).catch(() => [] as ColMeta[]), waitMs),
        within(cache.fksFor(pid, owner, tb.replace(/"/g, '')).catch(() => [] as ForeignKey[]), waitMs),
      ]);
      if (cols !== TIMEOUT) {
        if (refs.length === 1) tableCols = cols;
        for (const c of cols) if (c.pk) for (const i of byName.get(norm(c.name)) ?? []) flags[i].p = true;
      }
      if (fks === TIMEOUT) return;
      for (const fk of fks) {
        if (norm(fk.table) === table) {
          // cette table porte la clé étrangère → ligne parente
          for (const c of fk.cols) for (const i of byName.get(norm(c)) ?? []) flags[i].f = true;
          const sc = indices(fk.cols);
          if (sc) addLink(sc, { k: 'p', s: fk.refSchema && norm(fk.refSchema) !== norm(owner) ? fk.refSchema : undefined, t: fk.refTable, tc: fk.refCols, sc });
        }
        if (norm(fk.refTable) === table) {
          // cette table est référencée → lignes enfants
          const sc = indices(fk.refCols);
          if (sc) addLink(sc, { k: 'c', s: undefined, t: fk.table, tc: fk.cols, sc });
        }
      }
    })
  );
  // édition en grille : une seule table (pas de jointure / agrégat / sous-requête dans la liste), clé primaire complète dans le résultat
  let editInfo: EditInfo | undefined;
  const masked = maskText(sql);
  const simple = refs.length === 1 && !/\b(join|group\s+by|distinct|unique|union|intersect|minus|having|connect\s+by|pivot|unpivot|with)\b/i.test(masked) && (masked.match(/\bselect\b/gi) ?? []).length === 1;
  if (simple && tableCols?.length) {
    const meta = cache.peek(pid, schema);
    const tn = norm(refs[0].table.split('.').pop()!);
    const objType = meta?.objects.find((o) => o.name.toLowerCase() === tn)?.type;
    const pkCols = tableCols.filter((c) => c.pk);
    const pk = indices(pkCols.map((c) => c.name));
    const dupNames = new Set([...byName].filter(([, v]) => v.length > 1).map(([k]) => k));
    if ((!objType || objType === 'TABLE') && pkCols.length && pk) {
      const known = new Map(tableCols.map((c) => [norm(c.name), c] as const));
      const cols = columns.map((c) => {
        const m = known.get(norm(c.name));
        return !!m && !m.pk && !dupNames.has(norm(c.name)) && !/lob|long|raw|bytea|binary|image|xml|json|geometry|bfile/i.test(m.type);
      });
      if (cols.some(Boolean)) editInfo = { table: refs[0].table, pk, pkNames: pkCols.map((c) => c.name), cols };
    }
  }
  return { flags: flags.map((x) => (x.p ? 'P' : '') + (x.f ? 'F' : '')), links, edit: editInfo };
}
