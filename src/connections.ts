import { t } from './i18n';
import * as vscode from 'vscode';
import { DbConn, Profile } from './drivers/types';
import { connectDb, describeProfile, NEEDS_PASSWORD } from './drivers';
import { initOracle } from './drivers/oracle';

export { Profile };

export interface Session {
  conn: DbConn;
  autoCommit: boolean;
  /** Transaction en cours non validée. */
  dirty: boolean;
  /** Début de la transaction non validée (ms). */
  dirtySince?: number;
  /** Dernière activité (ms) : sert au timeout d'inactivité. */
  lastActivity: number;
  /** Une exécution est en cours : pas de timeout. */
  busy?: boolean;
}

const PROFILES_KEY = 'dbexplorer.profiles';

export class ConnectionManager {
  private profiles: Profile[];
  private sessions = new Map<string, Session>();
  private activeId?: string;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.profiles = ctx.globalState.get<Profile[]>(PROFILES_KEY, []);
    initOracle(vscode.workspace.getConfiguration('dbexplorer').get<string>('oracleClientLibDir'), (m) => vscode.window.showWarningMessage(`DB Explorer: ${m}`));
  }

  private timer?: NodeJS.Timeout;
  /** Éditeur (uri) → connexion sur laquelle il exécute ses requêtes. */
  private bindings = new Map<string, string>();
  private passwords = new Map<string, string>();
  private aux = new Map<string, Promise<DbConn>>();
  /** Connexions auxiliaires effectivement ouvertes (hors repli sur la connexion principale). */
  private auxLive = new Map<string, DbConn>();

  /**
   * Connexion auxiliaire dédiée aux métadonnées (scan en arrière-plan / recherches de complétion),
   * pour ne jamais bloquer les requêtes de l'utilisateur. Retombe sur la connexion principale si impossible.
   */
  auxConn(id: string, kind: 'scan' | 'lookup'): Promise<DbConn> {
    const s = this.sessions.get(id);
    const p = this.get(id);
    if (!s || !p) return Promise.reject(new Error('not connected'));
    const cfg = vscode.workspace.getConfiguration('dbexplorer');
    if (s.conn.kind === 'sqlite' || !cfg.get<boolean>('metadataConnection', true)) return Promise.resolve(s.conn);
    const key = id + '|' + kind;
    let c = this.aux.get(key);
    if (!c) {
      c = connectDb(p, this.passwords.get(id) ?? '', {
        dateFormat: cfg.get<string>('dateFormat', 'YYYY-MM-DD HH24:MI:SS'),
        timestampFormat: cfg.get<string>('timestampFormat', 'YYYY-MM-DD HH24:MI:SS.FF3'),
        defaultTnsAdmin: cfg.get<string>('tnsAdmin') || undefined,
      }).then(
        async (conn) => {
          await conn.useSchema(s.conn.currentSchema).catch(() => undefined);
          // la session a pu être fermée pendant l'ouverture : on ne laisse rien derrière nous
          if (!this.sessions.has(id)) {
            void this.hardClose(conn, false);
            throw new Error('closed');
          }
          this.auxLive.set(key, conn);
          return conn;
        },
        () => s.conn
      );
      this.aux.set(key, c);
    }
    return c;
  }

  /**
   * Ferme une connexion pour de bon, même si elle est occupée : on interrompt d'abord la requête en cours,
   * on annule la transaction, puis on ferme — le tout borné dans le temps pour ne jamais bloquer la fermeture de VS Code.
   */
  private async hardClose(conn: DbConn, rollback: boolean, maxMs = 2500) {
    const work = (async () => {
      try {
        await conn.cancel();
      } catch {
        /* rien à interrompre */
      }
      if (rollback) {
        try {
          await conn.rollback();
        } catch {
          /* ignore */
        }
      }
      try {
        await conn.close();
      } catch {
        /* déjà fermée */
      }
    })();
    await Promise.race([work, new Promise<void>((r) => setTimeout(r, maxMs))]);
  }

  /** Nombre de sessions de métadonnées (scan / recherche) réellement ouvertes en plus de la connexion principale. */
  auxCount(id: string): number {
    return [...this.auxLive.keys()].filter((k) => k.startsWith(id + '|')).length;
  }

  private async closeAux(id: string) {
    await Promise.all(
      ['scan', 'lookup'].map(async (kind) => {
        const key = id + '|' + kind;
        const c = this.aux.get(key);
        this.aux.delete(key);
        this.auxLive.delete(key);
        if (!c) return;
        try {
          // si la connexion est encore en cours d'établissement, on la ferme dès qu'elle arrive
          const conn = await Promise.race([c, new Promise<undefined>((r) => setTimeout(() => r(undefined), 2500))]);
          if (conn && conn !== this.sessions.get(id)?.conn) await this.hardClose(conn, false);
          else if (!conn) void c.then((late) => (late !== this.sessions.get(id)?.conn ? this.hardClose(late, false) : undefined)).catch(() => undefined);
        } catch {
          /* ignore */
        }
      })
    );
    this.passwords.delete(id);
  }

  /** Démarre la surveillance : timeout d'inactivité et de transaction. */
  startWatchdog() {
    this.timer = setInterval(() => void this.checkTimeouts(), 15_000);
    this.timer.unref?.();
  }

  bind(uri: vscode.Uri, pid: string) {
    this.touchMru(pid);
    if (this.bindings.get(uri.toString()) === pid) return;
    this.bindings.set(uri.toString(), pid);
    this.emitter.fire();
  }
  bound(uri: vscode.Uri): string | undefined {
    return this.bindings.get(uri.toString());
  }
  /** Connexion de l'éditeur, si elle est ouverte. */
  forDocument(uri: vscode.Uri): { profile: Profile; session: Session } | undefined {
    const id = this.bindings.get(uri.toString());
    const profile = id ? this.get(id) : undefined;
    const session = id ? this.sessions.get(id) : undefined;
    return profile && session ? { profile, session } : undefined;
  }
  /** Connexion de l'éditeur, sinon la connexion active (que l'éditeur adopte). */
  async requireFor(uri: vscode.Uri): Promise<{ profile: Profile; session: Session } | undefined> {
    const b = this.forDocument(uri);
    if (b) return b;
    const a = await this.requireActive();
    if (a) this.bind(uri, a.profile.id);
    return a;
  }

  /** Marque une activité sur la connexion (réinitialise le timeout d'inactivité). */
  touch(id?: string) {
    const s = this.sessions.get(id ?? this.activeId ?? '');
    if (s) s.lastActivity = Date.now();
  }

  private async applyQueryTimeout(s: Session) {
    const sec = vscode.workspace.getConfiguration('dbexplorer').get<number>('queryTimeoutSeconds', 600);
    try {
      await s.conn.setQueryTimeout?.(sec);
    } catch {
      /* non supporté */
    }
  }

  /** Réapplique le délai de requête à toutes les connexions (changement de réglage). */
  async applyQueryTimeoutAll() {
    for (const s of this.sessions.values()) await this.applyQueryTimeout(s);
  }

  /** État des connexions ouvertes (vue Réglages). */
  statuses() {
    const now = Date.now();
    return [...this.sessions.entries()].map(([id, s]) => ({
      id,
      name: this.get(id)?.name ?? id,
      active: id === this.activeId,
      dirty: s.dirty,
      idleSec: Math.floor((now - s.lastActivity) / 1000),
      busy: !!s.busy,
      aux: this.auxCount(id),
      txSec: s.dirty && s.dirtySince ? Math.floor((now - s.dirtySince) / 1000) : 0,
    }));
  }

  async rollbackSession(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    await s.conn.rollback();
    s.dirty = false;
    this.emitter.fire();
  }

  private async checkTimeouts() {
    const cfg = vscode.workspace.getConfiguration('dbexplorer');
    const idleMin = cfg.get<number>('idleTimeoutMinutes', 0);
    const txMin = cfg.get<number>('transactionTimeoutMinutes', 0);
    const rollbackOnTimeout = cfg.get<boolean>('rollbackOnTimeout', true);
    const now = Date.now();
    for (const [id, s] of [...this.sessions]) {
      if (s.busy) continue;
      const name = this.get(id)?.name ?? id;
      if (txMin > 0 && s.dirty && s.dirtySince && now - s.dirtySince >= txMin * 60_000) {
        try {
          await s.conn.rollback();
        } catch {
          /* ignore */
        }
        s.dirty = false;
        this.emitter.fire();
        void vscode.window.showWarningMessage(t('Connection "{0}": uncommitted changes were rolled back after {1} min (transaction timeout).', name, txMin));
      }
      if (idleMin > 0 && now - s.lastActivity >= idleMin * 60_000) {
        if (s.dirty && !rollbackOnTimeout) {
          s.lastActivity = now; // on garde la connexion : il reste des modifications non validées
          void vscode.window.showWarningMessage(t('Connection "{0}" has been idle for {1} min with uncommitted changes. It was kept open.', name, idleMin));
          continue;
        }
        const hadTx = s.dirty;
        await this.closeSession(id, true);
        void vscode.window.showWarningMessage(
          hadTx
            ? t('Connection "{0}" closed after {1} min of inactivity. Uncommitted changes were rolled back.', name, idleMin)
            : t('Connection "{0}" closed after {1} min of inactivity.', name, idleMin)
        );
      }
    }
  }

  /** Ferme une connexion sans poser de question (principale + sessions de métadonnées, en parallèle). */
  private async closeSession(id: string, rollback: boolean) {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id); // d'abord : plus rien ne peut rouvrir de session auxiliaire pour cet id
    if (this.activeId === id) this.activeId = [...this.sessions.keys()][0];
    await Promise.all([this.closeAux(id), this.hardClose(s.conn, rollback)]);
    this.emitter.fire();
  }

  /** Fermeture de VS Code / rechargement : rollback puis déconnexion de toutes les connexions. */
  async shutdown() {
    if (this.timer) clearInterval(this.timer);
    const ids = [...this.sessions.keys()];
    await Promise.race([Promise.all(ids.map((id) => this.closeSession(id, true))), new Promise<void>((r) => setTimeout(r, 4500))]);
    // filet de sécurité : aucune session auxiliaire ne doit survivre
    for (const key of [...this.auxLive.keys()]) {
      const c = this.auxLive.get(key);
      this.auxLive.delete(key);
      if (c) void this.hardClose(c, false, 1000);
    }
  }

  private readonly schemaEmitter = new vscode.EventEmitter<string>();
  /** Une instruction DDL a été exécutée sur cette connexion : le contenu des listes d'objets est à relire. */
  readonly onDidChangeSchema = this.schemaEmitter.event;
  schemaChanged(pid: string) {
    this.schemaEmitter.fire(pid);
  }

  private mruIds(): string[] {
    return this.ctx.globalState.get<string[]>('dbexplorer.mru', []);
  }
  /** Mémorise cette connexion comme la dernière utilisée. */
  touchMru(id: string) {
    const cur = this.mruIds();
    if (cur[0] === id) return;
    void this.ctx.globalState.update('dbexplorer.mru', [id, ...cur.filter((x) => x !== id)].slice(0, 50));
  }
  /** Connexions de la plus récemment utilisée à la plus ancienne, puis les jamais utilisées (épinglées d'abord). */
  ordered(): Profile[] {
    const mru = this.mruIds();
    const rank = (p: Profile) => {
      const i = mru.indexOf(p.id);
      return i < 0 ? 1e6 : i;
    };
    return [...this.profiles].sort((a, b) => rank(a) - rank(b) || Number(!!b.pinned) - Number(!!a.pinned) || a.name.localeCompare(b.name));
  }
  lastUsedId(): string | undefined {
    return this.mruIds().find((id) => this.profiles.some((p) => p.id === id));
  }

  list(): Profile[] {
    return [...this.profiles].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned));
  }
  get(id: string): Profile | undefined {
    return this.profiles.find((p) => p.id === id);
  }
  session(id: string): Session | undefined {
    return this.sessions.get(id);
  }
  isConnected(id: string): boolean {
    return this.sessions.has(id);
  }
  get active(): { profile: Profile; session: Session } | undefined {
    if (!this.activeId) return undefined;
    const profile = this.get(this.activeId);
    const session = this.sessions.get(this.activeId);
    return profile && session ? { profile, session } : undefined;
  }
  get activeProfileId(): string | undefined {
    return this.activeId;
  }
  changed() {
    this.emitter.fire();
  }

  private async save() {
    await this.ctx.globalState.update(PROFILES_KEY, this.profiles);
    this.emitter.fire();
  }

  /** Mémorise le résultat d'un test / d'une connexion (affiché dans la vue Connexion). */
  async recordTest(id: string, ok: boolean, message?: string) {
    const p = this.get(id);
    if (!p) return;
    p.lastTest = { ok, at: Date.now(), message: ok ? undefined : message };
    await this.ctx.globalState.update(PROFILES_KEY, this.profiles);
    this.emitter.fire();
  }

  async upsert(p: Profile, password?: string) {
    const i = this.profiles.findIndex((x) => x.id === p.id);
    // le résultat du dernier test n'est conservé que si les paramètres de connexion n'ont pas changé
    const core = (x: Profile) => JSON.stringify([x.type, x.user, x.connectString, x.tnsAdmin, x.role, x.host, x.port, x.database, x.ssl]);
    if (i >= 0 && !p.lastTest && this.profiles[i].lastTest && core(this.profiles[i]) === core(p)) p.lastTest = this.profiles[i].lastTest;
    if (i >= 0) this.profiles[i] = p;
    else this.profiles.push(p);
    if (password !== undefined) await this.ctx.secrets.store(`dbexplorer.pw.${p.id}`, password);
    await this.save();
  }

  async remove(id: string) {
    await this.disconnect(id);
    this.profiles = this.profiles.filter((p) => p.id !== id);
    for (const [k, v] of [...this.bindings]) if (v === id) this.bindings.delete(k);
    await this.ctx.secrets.delete(`dbexplorer.pw.${id}`);
    await this.save();
  }

  async connect(id: string): Promise<Session | undefined> {
    const existing = this.sessions.get(id);
    if (existing) {
      this.activeId = id;
      this.touchMru(id);
      this.emitter.fire();
      return existing;
    }
    const p = this.get(id);
    if (!p) return undefined;
    let password = (await this.ctx.secrets.get(`dbexplorer.pw.${id}`)) ?? '';
    if (!password && NEEDS_PASSWORD[p.type]) {
      const entered = await vscode.window.showInputBox({ prompt: t('Password for {0}', describeProfile(p)), password: true, ignoreFocusOut: true });
      if (entered === undefined) return undefined;
      password = entered;
    }
    const cfg = vscode.workspace.getConfiguration('dbexplorer');
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Connecting to {0}…', p.name) }, async () => {
      try {
        const conn = await connectDb(p, password, {
          dateFormat: cfg.get<string>('dateFormat', 'YYYY-MM-DD HH24:MI:SS'),
          timestampFormat: cfg.get<string>('timestampFormat', 'YYYY-MM-DD HH24:MI:SS.FF3'),
          defaultTnsAdmin: cfg.get<string>('tnsAdmin') || undefined,
        });
        let dirty = false;
        const session: Session = {
          conn,
          autoCommit: cfg.get<boolean>('autoCommit', false),
          lastActivity: Date.now(),
          get dirty() {
            return dirty;
          },
          set dirty(v: boolean) {
            if (v && !dirty) this.dirtySince = Date.now();
            if (!v) this.dirtySince = undefined;
            dirty = v;
          },
        };
        await this.applyQueryTimeout(session);
        this.passwords.set(id, password);
        this.sessions.set(id, session);
        this.activeId = id;
        this.touchMru(id);
        void this.auxConn(id, 'lookup').catch(() => undefined); // prête pour les liens de clés étrangères / colonnes (aucun scan)
        void this.recordTest(id, true);
        return session;
      } catch (e) {
        void this.recordTest(id, false, (e as Error).message);
        vscode.window.showErrorMessage(t('Connection failed: {0}', (e as Error).message));
        return undefined;
      }
    });
  }

  /** Teste une connexion sans l'enregistrer. Retourne un message d'erreur ou undefined. */
  async test(p: Profile, password: string): Promise<string | undefined> {
    let pw = password;
    if (!pw) pw = (await this.ctx.secrets.get('dbexplorer.pw.' + p.id)) ?? '';
    const cfg = vscode.workspace.getConfiguration('dbexplorer');
    try {
      const conn = await connectDb(p, pw, {
        dateFormat: cfg.get<string>('dateFormat', 'YYYY-MM-DD HH24:MI:SS'),
        timestampFormat: cfg.get<string>('timestampFormat', 'YYYY-MM-DD HH24:MI:SS.FF3'),
        defaultTnsAdmin: cfg.get<string>('tnsAdmin') || undefined,
      });
      await conn.close();
      return undefined;
    } catch (e) {
      return (e as Error).message;
    }
  }

  async disconnect(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    if (s.dirty) {
      const pick = await vscode.window.showWarningMessage(t('Uncommitted transaction in progress.'), { modal: true }, 'Commit', 'Rollback');
      if (!pick) return;
      try {
        if (pick === 'Commit') await s.conn.commit();
        else await s.conn.rollback();
      } catch {
        /* ignore */
      }
    }
    await this.closeSession(id, false); // la transaction vient d'être validée ou annulée au choix de l'utilisateur
  }

  async disposeAll() {
    for (const s of this.sessions.values()) {
      try {
        await s.conn.close();
      } catch {
        /* ignore */
      }
    }
    this.sessions.clear();
  }

  setActive(id: string) {
    if (this.sessions.has(id)) {
      this.activeId = id;
      this.emitter.fire();
    }
  }

  /** Identifiant de la connexion à laquelle appartient cette session. */
  idOf(session: Session): string | undefined {
    for (const [id, s] of this.sessions) if (s === session) return id;
    return undefined;
  }

  isReadOnly(id: string): boolean {
    return !!this.get(id)?.readOnly;
  }

  /** Connexion active ou, à défaut, propose d'en choisir/ouvrir une. */
  async requireActive(): Promise<{ profile: Profile; session: Session } | undefined> {
    if (this.active) return this.active;
    if (!this.profiles.length) {
      await vscode.commands.executeCommand('dbexplorer.addConnection');
      return this.active;
    }
    const NEW = '\u0000new';
    const items: (vscode.QuickPickItem & { id: string })[] = [
      ...[...this.profiles]
        .sort((a, b) => Number(this.sessions.has(b.id)) - Number(this.sessions.has(a.id)))
        .map((p) => ({ label: (this.sessions.has(p.id) ? '$(plug) ' : '$(database) ') + p.name, description: describeProfile(p), detail: this.sessions.has(p.id) ? t('connected') : undefined, id: p.id })),
      { label: '$(add) ' + t('New connection'), id: NEW },
    ];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: t('Choose a connection'), matchOnDescription: true });
    if (!pick) return undefined;
    if (pick.id === NEW) {
      await vscode.commands.executeCommand('dbexplorer.addConnection');
      return this.active;
    }
    await this.connect(pick.id);
    return this.active;
  }
}
