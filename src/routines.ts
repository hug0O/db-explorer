import { DbConn, RoutineArg, RoutineInfo } from './drivers/types';

const TTL = 10 * 60_000;

export interface CallCtx {
  /** Nom appelé, ex. ['pkg', 'proc'] ou ['proc']. */
  chain: string[];
  /** Index (base 0) du paramètre en cours de saisie. */
  argIndex: number;
}

/**
 * Appel de procédure / fonction dont la parenthèse ouvrante précède le curseur : « pkg.proc( a, | ».
 * `masked` = texte avant le curseur, chaînes et commentaires masqués.
 */
export function callContext(masked: string): CallCtx | undefined {
  let depth = 0;
  let argIndex = 0;
  for (let i = masked.length - 1; i >= 0; i--) {
    const ch = masked[i];
    if (ch === ')') depth++;
    else if (ch === ';') return undefined;
    else if (ch === ',' && depth === 0) argIndex++;
    else if (ch === '(') {
      if (depth > 0) {
        depth--;
        continue;
      }
      const m = /([A-Za-z_"][\w$#"]*(?:\s*\.\s*[A-Za-z_"][\w$#"]*){0,2})\s*$/.exec(masked.slice(0, i));
      if (!m) return undefined;
      return { chain: m[1].split('.').map((x) => x.trim().replace(/"/g, '')), argIndex };
    }
  }
  return undefined;
}

export interface Target {
  schema: string;
  pkg?: string;
  name: string;
}

interface Entry<T> {
  p: Promise<T>;
  at: number;
}

/** Packages, procédures, fonctions et leurs paramètres, mémorisés quelques minutes (aide à la saisie, Ctrl+clic). */
export class RoutineCache {
  private lists = new Map<string, Entry<RoutineInfo[]>>();
  private args = new Map<string, Entry<RoutineArg[]>>();
  private targets = new Map<string, Entry<Target | undefined>>();
  private types = new Map<string, Entry<string[]>>();

  clear() {
    this.lists.clear();
    this.args.clear();
    this.targets.clear();
    this.types.clear();
  }

  /** Types utilisateur du schéma (CREATE TYPE). */
  userTypes(pid: string, conn: DbConn, schema: string): Promise<string[]> {
    if (!conn.userTypes) return Promise.resolve([]);
    return this.hit(this.types, pid + '|' + schema.toUpperCase(), () => conn.userTypes!(schema).catch(() => [] as string[]));
  }

  private hit<T>(m: Map<string, Entry<T>>, key: string, make: () => Promise<T>): Promise<T> {
    const e = m.get(key);
    if (e && Date.now() - e.at < TTL) return e.p;
    const p = make();
    m.set(key, { p, at: Date.now() });
    return p;
  }

  list(pid: string, conn: DbConn, schema: string): Promise<RoutineInfo[]> {
    if (!conn.routines) return Promise.resolve([]);
    return this.hit(this.lists, pid + '|' + schema.toUpperCase(), () => conn.routines!(schema).catch(() => [] as RoutineInfo[]));
  }

  /** Retrouve la procédure / fonction désignée par un appel (synonymes Oracle et schéma qualifié compris). */
  resolve(pid: string, conn: DbConn, chain: string[]): Promise<Target | undefined> {
    const key = pid + '|' + conn.currentSchema.toUpperCase() + '|' + chain.join('.').toUpperCase();
    return this.hit(this.targets, key, async () => {
      try {
        const cur = conn.currentSchema;
        if (conn.kind === 'oracle') {
          const kind = (f?: { type: string }) => f?.type;
          if (chain.length === 1) {
            const f = await conn.findObject(cur, chain[0]);
            return f && (kind(f) === 'PROCEDURE' || kind(f) === 'FUNCTION') ? { schema: f.schema, name: f.name } : undefined;
          }
          if (chain.length === 2) {
            const pk = await conn.findObject(cur, chain[0]);
            if (pk?.type === 'PACKAGE') return { schema: pk.schema, pkg: pk.name, name: chain[1].toUpperCase() };
            const f = await conn.findObject(chain[0], chain[1]);
            return f && (f.type === 'PROCEDURE' || f.type === 'FUNCTION') ? { schema: f.schema, name: f.name } : undefined;
          }
          const pk = await conn.findObject(chain[0], chain[1]);
          return pk?.type === 'PACKAGE' ? { schema: pk.schema, pkg: pk.name, name: chain[2].toUpperCase() } : undefined;
        }
        const schema = chain.length === 2 ? chain[0] : cur;
        const name = chain[chain.length - 1];
        const all = await this.list(pid, conn, schema);
        const f = all.find((r) => r.type !== 'PACKAGE' && r.name.toLowerCase() === name.toLowerCase());
        return f && chain.length <= 2 ? { schema, name: f.name } : undefined;
      } catch {
        return undefined;
      }
    });
  }

  argsOf(pid: string, conn: DbConn, t: Target): Promise<RoutineArg[]> {
    if (!conn.routineArgs) return Promise.resolve([]);
    return this.hit(this.args, [pid, t.schema, t.pkg ?? '', t.name].join('|').toUpperCase(), () => conn.routineArgs!(t.schema, t.pkg, t.name).catch(() => [] as RoutineArg[]));
  }
}

/** Paramètres à proposer : ceux de la surcharge compatible avec l'index courant en premier, puis les autres. */
export function suggestArgs(all: RoutineArg[], argIndex: number): { first: RoutineArg[]; rest: RoutineArg[]; full: RoutineArg[] } {
  const groups = new Map<string, RoutineArg[]>();
  for (const a of all) {
    if (a.isReturn || !a.name) continue;
    const k = a.overload ?? '';
    groups.set(k, [...(groups.get(k) ?? []), a].sort((x, y) => x.pos - y.pos));
  }
  const lists = [...groups.values()];
  const full = lists[0] ?? [];
  const first: RoutineArg[] = [];
  for (const l of lists) {
    const a = l[argIndex];
    if (a && !first.some((x) => x.name.toLowerCase() === a.name.toLowerCase())) first.push(a);
  }
  const seen = new Set(first.map((x) => x.name.toLowerCase()));
  const rest: RoutineArg[] = [];
  for (const l of lists) for (const a of l) if (!seen.has(a.name.toLowerCase())) (seen.add(a.name.toLowerCase()), rest.push(a));
  return { first, rest, full };
}
