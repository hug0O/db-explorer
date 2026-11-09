import { MetaCache, within, TIMEOUT, ColMeta } from './metaCache';
import { ForeignKey } from './drivers/types';
import { Graph, GEdge, GNode } from './graphs';
import { t } from './i18n';

interface TableRef {
  s: string;
  t: string;
  focus: boolean;
}

/**
 * Diagramme ER : les tables choisies (en couleur) et leurs voisines par clés étrangères, `depth` niveaux (1 = tables liées directement).
 * Flèche = clé étrangère, de la table enfant vers la table parente.
 */
export async function buildErGraph(cache: MetaCache, pid: string, schema: string, tables: string[], depth = 1, cap = 40): Promise<Graph> {
  const key = (s: string, tb: string) => `${s}.${tb}`.toLowerCase();
  const nodes = new Map<string, TableRef>();
  for (const tb of tables) nodes.set(key(schema, tb), { s: schema, t: tb, focus: true });
  const fks: ForeignKey[] = [];
  const seen = new Set<string>();
  let truncated = false;
  let frontier = [...nodes.values()];

  for (let d = 0; d <= depth; d++) {
    const next: TableRef[] = [];
    await Promise.all(
      frontier.map(async (n) => {
        const list = await within(cache.fksFor(pid, n.s, n.t).catch(() => [] as ForeignKey[]), 3000);
        if (list === TIMEOUT) return;
        for (const fk of list) {
          const child = { s: n.s, t: fk.table }; // le propriétaire de la table enfant est celui interrogé
          const parent = { s: fk.refSchema || n.s, t: fk.refTable };
          const id = `${key(child.s, child.t)}|${fk.name}`;
          if (!seen.has(id)) {
            seen.add(id);
            fks.push({ ...fk, refSchema: parent.s });
          }
          if (d < depth) {
            for (const e of [child, parent]) {
              const k = key(e.s, e.t);
              if (nodes.has(k)) continue;
              if (nodes.size >= cap) {
                truncated = true;
                continue;
              }
              const r = { ...e, focus: false };
              nodes.set(k, r);
              next.push(r);
            }
          }
        }
      })
    );
    frontier = next;
    if (!frontier.length) break;
  }

  // clés primaires et nombre de colonnes (cache en priorité)
  const info = new Map<string, string>();
  await Promise.all(
    [...nodes.entries()].map(async ([k, n]) => {
      const cols = await within(cache.columns(pid, n.s, n.t).catch(() => [] as ColMeta[]), 1500);
      if (cols === TIMEOUT || !cols.length) return;
      const pk = cols.filter((c) => c.pk).map((c) => c.name);
      info.set(k, (pk.length ? 'PK: ' + pk.join(', ') + ' · ' : '') + `${cols.length} ${t('col.')}`);
    })
  );

  const gNodes: GNode[] = [...nodes.entries()].map(([k, n]) => ({
    id: k,
    label: n.t,
    sub: (n.s.toLowerCase() !== schema.toLowerCase() ? n.s + ' · ' : '') + (info.get(k) ?? ''),
    kind: n.focus ? 'focus' : 'table',
  }));
  const gEdges: GEdge[] = [];
  for (const fk of fks) {
    const from = key(schemaOfChild(fk, nodes, schema), fk.table);
    const to = key(fk.refSchema || schema, fk.refTable);
    if (from === to || !nodes.has(from) || !nodes.has(to)) continue;
    gEdges.push({ from, to, label: `${fk.cols.join(', ')} → ${fk.refCols.join(', ')}`, arrow: true });
  }
  const title = t('ER diagram — {0}', tables.length === 1 ? tables[0] : `${tables.length} ${t('tables')}`);
  const note = truncated ? t('Limited to {0} tables.', cap) : gEdges.length ? undefined : t('No foreign key found for the selected table(s).');
  return { title, nodes: gNodes, edges: gEdges, note };
}

function schemaOfChild(fk: ForeignKey, nodes: Map<string, TableRef>, fallback: string): string {
  // la table enfant appartient au schéma interrogé : le premier nœud portant ce nom
  for (const n of nodes.values()) if (n.t.toLowerCase() === fk.table.toLowerCase() && n.s.toLowerCase() !== (fk.refSchema || '').toLowerCase()) return n.s;
  for (const n of nodes.values()) if (n.t.toLowerCase() === fk.table.toLowerCase()) return n.s;
  return fallback;
}
