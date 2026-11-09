import { DbConn, ForeignKey } from './drivers/types';
import { MetaCache, within, TIMEOUT } from './metaCache';
import { Graph, GEdge, GNode } from './graphs';
import { t } from './i18n';

const baseType = (x: string) => (x || 'TABLE').toUpperCase().replace(/ BODY$/, '');
const kindOf = (type: string): GNode['kind'] => (type === 'TABLE' ? 'table' : type === 'VIEW' || type === 'MATERIALIZED VIEW' ? 'view' : 'plsql');

/**
 * Impact / lineage : « qui utilise cet objet ? » (usedBy) ou « qu'utilise-t-il ? » (uses), sur plusieurs niveaux.
 * Dépendances du dictionnaire (vues, packages, triggers…) + clés étrangères pour les tables. Flèche = « dépend de ».
 */
export async function buildLineage(conn: DbConn, cache: MetaCache | undefined, pid: string, schema: string, name: string, type: string, dir: 'usedBy' | 'uses', depth = 3, cap = 60): Promise<Graph> {
  const key = (s: string, n: string) => `${s}.${n}`.toLowerCase();
  const nodes = new Map<string, GNode>();
  const edges: GEdge[] = [];
  const edgeSeen = new Set<string>();
  const addEdge = (from: string, to: string, label?: string) => {
    const k = from + '>' + to;
    if (from === to || edgeSeen.has(k)) return;
    edgeSeen.add(k);
    edges.push({ from, to, label, arrow: true });
  };
  const root = key(schema, name);
  const rootType = baseType(type);
  nodes.set(root, { id: root, label: name, sub: rootType, kind: 'focus' });
  let frontier: { s: string; n: string; type: string }[] = [{ s: schema, n: name, type: rootType }];
  let truncated = false;

  for (let d = 0; d < depth && frontier.length; d++) {
    const next: typeof frontier = [];
    for (const cur of frontier) {
      const curId = key(cur.s, cur.n);
      const found: { s: string; n: string; type: string; fk?: string }[] = [];
      if (conn.dependencies) {
        const deps = await within(conn.dependencies(cur.s, cur.n, dir).catch(() => []), 8000);
        if (deps !== TIMEOUT) for (const x of deps) found.push({ s: x.schema, n: x.name, type: baseType(x.type) });
      }
      if (cache && cur.type === 'TABLE') {
        const fks = await within(cache.fksFor(pid, cur.s, cur.n).catch(() => [] as ForeignKey[]), 3000);
        if (fks !== TIMEOUT)
          for (const fk of fks) {
            if (dir === 'usedBy' && fk.refTable.toLowerCase() === cur.n.toLowerCase() && fk.table.toLowerCase() !== cur.n.toLowerCase()) found.push({ s: cur.s, n: fk.table, type: 'TABLE', fk: fk.name });
            if (dir === 'uses' && fk.table.toLowerCase() === cur.n.toLowerCase() && fk.refTable.toLowerCase() !== cur.n.toLowerCase()) found.push({ s: fk.refSchema || cur.s, n: fk.refTable, type: 'TABLE', fk: fk.name });
          }
      }
      for (const f of found) {
        const id = key(f.s, f.n);
        if (!nodes.has(id)) {
          if (nodes.size >= cap) {
            truncated = true;
            continue;
          }
          nodes.set(id, { id, label: f.n, sub: (f.s.toLowerCase() !== schema.toLowerCase() ? f.s + ' · ' : '') + f.type + (f.fk ? '' : ''), kind: kindOf(f.type) });
          next.push(f);
        }
        if (dir === 'usedBy') addEdge(id, curId, f.fk ? 'FK ' + f.fk : undefined);
        else addEdge(curId, id, f.fk ? 'FK ' + f.fk : undefined);
      }
    }
    frontier = next;
  }
  const title = dir === 'usedBy' ? t('Who uses {0}?', name) : t('What does {0} use?', name);
  const note = truncated ? t('Limited to {0} objects.', cap) : edges.length ? undefined : t('No dependency found.');
  return { title, nodes: [...nodes.values()], edges, note };
}
