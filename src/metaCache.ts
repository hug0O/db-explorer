import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ConnectionManager } from './connections';
import { ForeignKey } from './drivers/types';

export interface ColMeta {
  name: string;
  type: string;
  pk: boolean;
  /** Commentaire de la colonne (proposé comme alias). */
  comment?: string;
}

export interface ObjMeta {
  name: string;
  type: string;
}

export interface FoundObj extends ObjMeta {
  owner?: string;
}

export interface Meta {
  schema: string;
  at: number;
  objects: ObjMeta[];
  /** Colonnes par table (clé en minuscules). */
  columns: Record<string, ColMeta[]>;
  /** Clés étrangères de tout le schéma (bases où c'est bon marché). */
  fks: ForeignKey[];
  /** Clés étrangères par table, chargées à la demande (grosses bases Oracle). */
  fkOf: Record<string, ForeignKey[]>;
  /** La liste des objets a-t-elle été chargée en entier ? */
  complete: boolean;
  /** Toutes les colonnes ont-elles été scannées ? */
  colsDone: boolean;
  colsAt: number;
  /** Type de SGBD et empreintes de structure par table (clé en minuscules) : sert à reconnaître une base dupliquée. */
  kind?: string;
  hashes?: Record<string, string>;
  /** Dernière réutilisation d'un cache existant : tables reprises / relues, nom de la connexion source. */
  reuse?: { from: string; reused: number; refetched: number };
}

export interface ScanState {
  pid: string;
  schema: string;
  phase: 'objects' | 'columns' | 'fks' | 'done' | 'error';
  done: number;
  total: number;
  reused?: { from: string; reused: number; refetched: number };
}

const VERSION = 4;
/** Part minimale de noms d'objets communs pour considérer qu'une base est un duplicat d'une autre. */
const DUP_RATIO = 0.9;
const OBJECTS_STALE_MS = 30 * 60_000;
const COLUMNS_STALE_MS = 24 * 3600_000;
const BATCH = 60;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Attend p au plus `ms` ; retourne TIMEOUT si trop lent (la requête continue en arrière-plan). */
export const TIMEOUT = Symbol('timeout');
export async function within<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  return Promise.race<T | typeof TIMEOUT>([p, sleep(ms).then((): typeof TIMEOUT => TIMEOUT)]);
}

const emptyMeta = (schema: string): Meta => ({ schema, at: 0, objects: [], columns: {}, fks: [], fkOf: {}, complete: false, colsDone: false, colsAt: 0 });

/**
 * Cache des métadonnées de l'aide à la saisie (objets, colonnes, clés étrangères) pensé pour les très grosses bases :
 * - persistant sur disque : disponible instantanément au démarrage ;
 * - alimenté par un scan progressif en arrière-plan sur une connexion dédiée (jamais celle des requêtes) ;
 * - complété à la demande par des recherches ciblées (préfixe tapé, colonnes d'une table) sur une 2e connexion dédiée.
 */
export class MetaCache {
  private mem = new Map<string, Meta>();
  private scanning = new Map<string, Promise<void>>();
  private gen = new Map<string, number>();
  private lazyCols = new Map<string, Promise<ColMeta[]>>();
  private lazyFk = new Map<string, Promise<ForeignKey[]>>();
  private lazySearch = new Map<string, { p: Promise<FoundObj[]>; at: number }>();
  private lastState = new Map<string, ScanState>();
  private readonly dir: string;
  private readonly emitter = new vscode.EventEmitter<ScanState>();
  readonly onProgress = this.emitter.event;

  constructor(ctx: vscode.ExtensionContext, private readonly mgr: ConnectionManager) {
    this.dir = path.join(ctx.globalStorageUri.fsPath, 'metadata');
  }

  private key(pid: string, schema: string) {
    return `${pid}|${schema}`;
  }
  private file(pid: string, schema: string) {
    return path.join(this.dir, `${pid}__${schema}`.replace(/[^\w.-]/g, '_') + '.json');
  }
  private cfg<T>(k: string, d: T): T {
    try {
      return vscode.workspace.getConfiguration('dbexplorer').get<T>(k, d);
    } catch {
      return d;
    }
  }

  /** État du dernier scan de la connexion (vue Réglages). */
  status(pid: string): ScanState | undefined {
    return this.lastState.get(pid);
  }
  cachedCounts(pid: string, schema: string) {
    const m = this.mem.get(this.key(pid, schema));
    return m ? { objects: m.objects.length, tables: Object.keys(m.columns).length } : { objects: 0, tables: 0 };
  }

  // ---------------------------------------------------------------- accès rapide

  /**
   * Métadonnées disponibles TOUT DE SUITE (mémoire, sinon disque) ; ne touche jamais la base.
   * Lance le scan en arrière-plan si le cache est absent ou périmé.
   */
  async get(pid: string, schema: string): Promise<Meta> {
    const k = this.key(pid, schema);
    let m = this.mem.get(k);
    if (!m) {
      m = (await this.readDisk(pid, schema)) ?? emptyMeta(schema);
      this.mem.set(k, m);
    }
    this.startScan(pid, schema);
    return m;
  }

  peek(pid: string, schema: string): Meta | undefined {
    return this.mem.get(this.key(pid, schema));
  }

  /**
   * Cherche, parmi les caches des autres connexions (mémoire puis disque), celui d'une base qui ressemble à celle-ci
   * (même SGBD, au moins DUP_RATIO de noms d'objets communs) : copie / duplicat à ne pas rescanner entièrement.
   */
  private async findDonor(pid: string, schema: string, kind: string, names: string[]): Promise<{ meta: Meta; label: string } | undefined> {
    if (names.length < 5) return undefined;
    const mine = new Set(names.map((n) => n.toLowerCase()));
    const score = (m: Meta) => {
      if (!m.complete || !m.hashes || m.kind !== kind) return 0;
      let common = 0;
      for (const o of m.objects) if (mine.has(o.name.toLowerCase())) common++;
      return common / Math.max(mine.size, m.objects.length);
    };
    const label = (p: string, m: Meta) => `${this.mgr.get(p)?.name ?? p} (${m.schema})`;
    let best: { meta: Meta; label: string; s: number } | undefined;
    const consider = (p: string, m: Meta | undefined) => {
      if (!m) return;
      const s = score(m);
      if (s >= DUP_RATIO && (!best || s > best.s)) best = { meta: m, label: label(p, m), s };
    };
    const own = this.key(pid, schema);
    const seen = new Set<string>([own]);
    for (const [k, m] of this.mem) if (!seen.has(k)) (seen.add(k), consider(k.split('|')[0], m));
    try {
      const mine_ = this.file(pid, schema);
      for (const f of fs.existsSync(this.dir) ? fs.readdirSync(this.dir) : []) {
        const full = path.join(this.dir, f);
        if (full === mine_) continue;
        try {
          const j = JSON.parse(await fs.promises.readFile(full, 'utf8')) as { v: number; meta: Meta; pid?: string };
          if (j.v !== VERSION || !j.meta) continue;
          const k = this.key(j.pid ?? f, j.meta.schema);
          if (seen.has(k)) continue;
          seen.add(k);
          consider(j.pid ?? f, j.meta);
        } catch {
          /* fichier illisible : ignoré */
        }
      }
    } catch {
      /* ignore */
    }
    return best;
  }

  /** Vide le cache (mémoire + disque) ; le scan repart à la prochaine demande. */
  async invalidate(pid?: string) {
    const pfx = pid ? pid + '|' : '';
    for (const map of [this.mem, this.lazyCols, this.lazyFk, this.lazySearch] as Map<string, unknown>[]) for (const k of [...map.keys()]) if (!pid || k.startsWith(pfx)) map.delete(k);
    for (const k of [...this.gen.keys()]) if (!pid || k.startsWith(pfx)) this.gen.set(k, (this.gen.get(k) ?? 0) + 1); // interrompt les scans en cours
    this.scanning.clear();
    try {
      const safe = pid?.replace(/[^\w.-]/g, '_');
      for (const f of fs.existsSync(this.dir) ? fs.readdirSync(this.dir) : []) if (!pid || f.startsWith(safe + '__')) fs.unlinkSync(path.join(this.dir, f));
    } catch {
      /* ignore */
    }
  }

  // ------------------------------------------------------------ requêtes ciblées

  /** Objets dont le nom commence par `prefix`, cherchés dans la base (2e connexion dédiée) puis mémorisés. */
  searchObjects(pid: string, schema: string, prefix: string): Promise<FoundObj[]> {
    const lk = `${pid}|${schema}|${prefix.toLowerCase()}`;
    const hit = this.lazySearch.get(lk);
    if (hit && Date.now() - hit.at < 60_000) return hit.p;
    const p = (async () => {
      const conn = await this.mgr.auxConn(pid, 'lookup');
      if (!conn.searchObjects) return [];
      const found = await conn.searchObjects(schema, prefix, 60);
      const m = this.peek(pid, schema);
      if (m) {
        const have = new Set(m.objects.map((o) => o.name));
        for (const x of found) if ((!x.owner || x.owner === schema.toUpperCase() || x.owner === 'PUBLIC') && !have.has(x.name)) m.objects.push({ name: x.name, type: x.type });
      }
      return found;
    })();
    this.lazySearch.set(lk, { p, at: Date.now() });
    p.catch(() => this.lazySearch.delete(lk));
    return p;
  }

  /** Colonnes d'une table : cache, sinon requête ciblée (version légère) sur la connexion dédiée. */
  columns(pid: string, schema: string, table: string): Promise<ColMeta[]> {
    const k = table.toLowerCase().replace(/"/g, '');
    const m = this.peek(pid, schema);
    if (m?.columns[k]?.length) return Promise.resolve(m.columns[k]);
    const lk = `${pid}|${schema}|${k}`;
    // nom absent d'un cache complet (alias, ou table créée depuis le scan) : on vérifie directement dans la base (recherche mémorisée 60 s)
    if (m?.complete && m.colsDone && !m.objects.some((o) => o.name.toLowerCase() === k)) {
      return this.searchObjects(pid, schema, table.replace(/"/g, '')).then((found) => (found.some((x) => x.name.toLowerCase() === k && (!x.owner || x.owner === schema.toUpperCase() || x.owner === 'PUBLIC')) ? this.columns(pid, schema, table) : []));
    }
    let p = this.lazyCols.get(lk);
    if (!p) {
      p = (async () => {
        const conn = await this.mgr.auxConn(pid, 'lookup');
        const name = conn.kind === 'postgres' ? k : table;
        const list = conn.columnsLite
          ? await conn.columnsLite(schema, name)
          : (await conn.columns(schema, name)).map((c) => ({ name: c.NAME, type: c.TYPE, pk: c.PK, comment: c.COMMENTS ?? undefined }));
        const meta = this.peek(pid, schema);
        if (meta && list.length) meta.columns[k] = list;
        return list;
      })();
      this.lazyCols.set(lk, p);
      p.catch(() => this.lazyCols.delete(lk));
    }
    return p;
  }

  /** Clés étrangères touchant une table (dans les deux sens). */
  fksFor(pid: string, schema: string, table: string): Promise<ForeignKey[]> {
    const k = table.toLowerCase();
    const m = this.peek(pid, schema);
    if (m?.fkOf[k]) return Promise.resolve(m.fkOf[k]);
    if (m?.fks.length) return Promise.resolve(m.fks.filter((f) => f.table.toLowerCase() === k || f.refTable.toLowerCase() === k));
    const lk = `${pid}|${schema}|fk|${k}`;
    let p = this.lazyFk.get(lk);
    if (!p) {
      p = (async () => {
        const conn = await this.mgr.auxConn(pid, 'lookup');
        const list = conn.foreignKeysOf ? await conn.foreignKeysOf(schema, table) : [];
        const meta = this.peek(pid, schema);
        if (meta) meta.fkOf[k] = list;
        return list;
      })();
      this.lazyFk.set(lk, p);
      p.catch(() => this.lazyFk.delete(lk));
    }
    return p;
  }

  // -------------------------------------------------------------------- disque

  private async readDisk(pid: string, schema: string): Promise<Meta | undefined> {
    try {
      const raw = await fs.promises.readFile(this.file(pid, schema), 'utf8');
      const j = JSON.parse(raw) as { v: number; meta: Meta };
      return j.v === VERSION ? j.meta : undefined;
    } catch {
      return undefined;
    }
  }

  private async writeDisk(pid: string, schema: string) {
    const meta = this.peek(pid, schema);
    if (!meta) return;
    try {
      await fs.promises.mkdir(this.dir, { recursive: true });
      await fs.promises.writeFile(this.file(pid, schema), JSON.stringify({ v: VERSION, pid, meta }), 'utf8');
    } catch {
      /* cache facultatif */
    }
  }

  // ---------------------------------------------------------------------- scan

  private emit(s: ScanState) {
    this.lastState.set(s.pid, s);
    this.emitter.fire(s);
  }

  startScan(pid: string, schema: string) {
    const k = this.key(pid, schema);
    if (this.scanning.has(k)) return;
    const m = this.mem.get(k);
    const fresh = m && m.complete && Date.now() - m.at < OBJECTS_STALE_MS && (m.colsDone || !this.cfg('prefetchMetadata', true));
    if (fresh || !this.mgr.isConnected(pid)) return;
    const p = this.scan(pid, schema)
      .catch(() => this.emit({ pid, schema, phase: 'error', done: 0, total: 0 }))
      .finally(() => this.scanning.delete(k));
    this.scanning.set(k, p);
  }

  private async waitIdle(pid: string) {
    for (let i = 0; i < 60 && this.mgr.session(pid)?.busy; i++) await sleep(500);
  }

  private async scan(pid: string, schema: string) {
    const k = this.key(pid, schema);
    const g = this.gen.get(k) ?? 0;
    const alive = () => (this.gen.get(k) ?? 0) === g && this.mgr.isConnected(pid);
    const conn = await this.mgr.auxConn(pid, 'scan');
    const m = this.mem.get(k) ?? emptyMeta(schema);
    this.mem.set(k, m);

    // 1) liste des objets (USER_OBJECTS pour son propre schéma : quasi instantané)
    this.emit({ pid, schema, phase: 'objects', done: 0, total: 0 });
    m.objects = conn.objectInfos ? await conn.objectInfos(schema) : (await conn.tableNames(schema)).map((name) => ({ name, type: 'TABLE' }));
    m.complete = true;
    m.at = Date.now();
    await this.writeDisk(pid, schema);
    if (!alive()) return;

    // 2) colonnes
    if (!this.cfg('prefetchMetadata', true)) {
      this.emit({ pid, schema, phase: 'done', done: 0, total: 0 });
      return;
    }
    const stale = Date.now() - m.colsAt > COLUMNS_STALE_MS;
    m.kind = conn.kind;
    let reuse: { from: string; reused: number; refetched: number } | undefined;
    if (conn.columnsBatch) {
      const names = m.objects.filter((o) => o.type !== 'SYNONYM').map((o) => o.name);
      // empreintes de structure : une seule requête ; seules les tables dont l'empreinte diffère sont relues
      const hashes = conn.columnHashes ? await conn.columnHashes(schema).catch(() => undefined) : undefined;
      let todo: string[];
      if (hashes) {
        const donor = Object.keys(m.columns).length < names.length / 2 ? await this.findDonor(pid, schema, conn.kind, names) : undefined;
        let reused = 0;
        todo = [];
        for (const n of names) {
          const key = n.toLowerCase();
          const h = hashes[key];
          if (h === undefined) { todo.push(n); continue; }
          if (m.columns[key] && m.hashes?.[key] === h && !(stale && Date.now() - m.colsAt > 7 * COLUMNS_STALE_MS)) { reused++; continue; }
          const d = donor?.meta;
          if (d && d.hashes?.[key] === h && d.columns[key]) {
            m.columns[key] = d.columns[key].map((c) => ({ ...c }));
            reused++;
            continue;
          }
          todo.push(n);
        }
        m.hashes = hashes;
        if (donor) reuse = { from: donor.label, reused, refetched: todo.length };
        m.reuse = reuse ?? m.reuse;
      } else {
        todo = names.filter((n) => stale || !m.columns[n.toLowerCase()]);
      }
      let done = names.length - todo.length;
      this.emit({ pid, schema, phase: 'columns', done, total: names.length, reused: reuse });
      for (let i = 0; i < todo.length; i += BATCH) {
        if (!alive()) return;
        await this.waitIdle(pid);
        const batch = todo.slice(i, i + BATCH);
        const rows = await conn.columnsBatch(schema, batch);
        for (const n of batch) m.columns[n.toLowerCase()] = [];
        for (const r of rows) (m.columns[r.table.toLowerCase()] ??= []).push({ name: r.name, type: r.type, pk: r.pk, comment: r.comment });
        done += batch.length;
        this.emit({ pid, schema, phase: 'columns', done, total: names.length });
        if ((i / BATCH) % 10 === 9) await this.writeDisk(pid, schema);
        await sleep(60); // laisse respirer le serveur
      }
      m.colsDone = true;
      m.colsAt = Date.now();
    } else if (conn.allColumns) {
      this.emit({ pid, schema, phase: 'columns', done: 0, total: m.objects.length });
      const cols: Record<string, ColMeta[]> = {};
      for (const r of await conn.allColumns(schema)) (cols[r.table.toLowerCase()] ??= []).push({ name: r.name, type: r.type, pk: r.pk, comment: r.comment });
      for (const [t, v] of Object.entries(m.columns)) if (!cols[t]) cols[t] = v; // conserve ce qui vient d'être obtenu à la demande
      const donor = Object.keys(m.columns).length < m.objects.length / 2 ? await this.findDonor(pid, schema, conn.kind, m.objects.map((o) => o.name)) : undefined;
      if (donor) {
        const sig = (l: ColMeta[]) => l.map((c) => c.name + ':' + c.type).join('|');
        let same = 0;
        for (const [t, v] of Object.entries(cols)) if (donor.meta.columns[t] && sig(donor.meta.columns[t]) === sig(v)) same++;
        m.reuse = { from: donor.label, reused: same, refetched: Object.keys(cols).length - same };
      }
      m.columns = cols;
      m.colsDone = true;
      m.colsAt = Date.now();
    }
    if (!alive()) return;

    // 3) clés étrangères du schéma entier (bases où c'est bon marché ; Oracle : à la demande, table par table)
    if (!conn.foreignKeysOf && conn.foreignKeys) {
      this.emit({ pid, schema, phase: 'fks', done: 0, total: 0 });
      m.fks = await conn.foreignKeys(schema).catch(() => []);
    }
    await this.writeDisk(pid, schema);
    this.emit({ pid, schema, phase: 'done', done: Object.keys(m.columns).length, total: Object.keys(m.columns).length });
  }
}
