import { t } from './i18n';
import * as vscode from 'vscode';
import { ConnectionManager, Profile } from './connections';
import { describeProfile } from './drivers';
import { colorHex, dbIconSvg } from './palette';
import { within, TIMEOUT } from './metaCache';
import type { MetaCache } from './metaCache';

export type Node =
  | { kind: 'tab' }
  | { kind: 'search' }
  | { kind: 'conn'; profile: Profile }
  | { kind: 'schema'; profile: Profile; name: string; current: boolean }
  | { kind: 'cat'; profile: Profile; type: string; label: string; icon: string; schema?: string; expanded?: boolean; hits?: { name: string; invalid: boolean }[] }
  | { kind: 'obj'; profile: Profile; type: string; owner: string; name: string; invalid: boolean }
  | { kind: 'folder'; profile: Profile; owner: string; table: string; what: 'columns' | 'indexes' | 'constraints' }
  | { kind: 'leaf'; label: string; description?: string; icon?: string; tooltip?: string };

export class SchemaTree implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  /** Filtre rapide sur le nom des objets (sous-chaîne, ou motif avec * et %). */
  filter = '';
  /** Index de métadonnées (utilisé en priorité pour le filtre). */
  cache?: MetaCache;
  private listCache = new Map<string, Promise<{ name: string; invalid: boolean }[]>>();

  /** Types d'objets affichés (vide = tous). */
  types = new Set<string>();

  /** Seulement les objets invalides (Oracle). */
  invalidOnly = false;

  get active(): boolean {
    return !!this.filter || this.types.size > 0 || this.invalidOnly;
  }

  setInvalidOnly(on: boolean) {
    this.invalidOnly = on;
    void vscode.commands.executeCommand('setContext', 'dbexplorer.treeInvalid', on);
    this.applied();
  }

  /** Regroupement par schéma (utilisateur) : connexion → schémas → catégories → objets. */
  private grouped(conn: { features: { schemas: boolean } }): boolean {
    return conn.features.schemas && vscode.workspace.getConfiguration('dbexplorer').get<boolean>('groupBySchema', false);
  }
  private schemaCache = new Map<string, Promise<string[]>>();

  setFilter(f: string) {
    this.filter = f.trim();
    this.applied();
  }

  setTypes(types: Iterable<string>) {
    this.types = new Set(types);
    this.applied();
  }

  private applied() {
    void vscode.commands.executeCommand('setContext', 'dbexplorer.treeFiltered', this.active);
    this.refresh();
  }

  /** Types d'objets qui existent réellement dans les connexions ouvertes (index en priorité, sinon test d'existence dans la base). */
  async existingTypes(): Promise<{ type: string; label: string; count?: number }[]> {
    const out = new Map<string, { type: string; label: string; count?: number }>();
    await Promise.all(
      this.mgr.list().map(async (p) => {
        const s = this.mgr.session(p.id);
        if (!s) return;
        const conn = s.conn;
        const schema = conn.currentSchema;
        const meta = this.cache?.peek(p.id, schema);
        const counts = new Map<string, number>();
        if (meta?.complete && conn.objectInfos) for (const o of meta.objects) counts.set(o.type, (counts.get(o.type) ?? 0) + 1);
        await Promise.all(
          conn.categories().map(async (c) => {
            let count = counts.get(c.type);
            if (!count) {
              const r = await within(conn.listObjects(c.type, schema, 1).catch(() => [] as { name: string }[]), 4000);
              if (r !== TIMEOUT && !r.length) return; // aucun objet de ce type
            }
            const cur = out.get(c.type);
            out.set(c.type, { type: c.type, label: c.label, count: count ? (cur?.count ?? 0) + count : cur?.count });
          })
        );
      })
    );
    const order = new Map<string, number>();
    for (const p of this.mgr.list()) (this.mgr.session(p.id)?.conn.categories() ?? []).forEach((c, i) => order.set(c.type, Math.min(order.get(c.type) ?? 99, i)));
    return [...out.values()].sort((a, b) => (order.get(a.type) ?? 99) - (order.get(b.type) ?? 99));
  }

  /** Résumé du filtre actif (texte et types). */
  summary(): string {
    return [this.filter, this.types.size ? '[' + [...this.types].join(', ') + ']' : '', this.invalidOnly ? '⚠ ' + t('invalid') : ''].filter(Boolean).join(' ');
  }

  constructor(private readonly mgr: ConnectionManager) {
    mgr.onDidChange(() => this.refresh());
  }

  refresh() {
    this.listCache.clear();
    this.schemaCache.clear();
    this.emitter.fire(undefined);
  }

  getTreeItem(n: Node): vscode.TreeItem {
    const C = vscode.TreeItemCollapsibleState;
    switch (n.kind) {
      case 'tab': {
        const it = new vscode.TreeItem(t('Connection'), C.None);
        it.iconPath = new vscode.ThemeIcon('plug');
        it.description = t('add / edit connections');
        it.tooltip = t('Switch to the connection form (the Schema Browser comes back after connecting)');
        it.command = { command: 'dbexplorer.sideTab.connection', title: t('Connection') };
        it.id = 'dbexplorer.tab.connection';
        it.contextValue = 'tab';
        return it;
      }
      case 'search': {
        const it = new vscode.TreeItem(this.active ? this.filter || t('(all names)') : t('Search objects…'), C.None);
        it.iconPath = new vscode.ThemeIcon(this.active ? 'filter-filled' : 'search');
        it.description = this.active ? (this.types.size ? '[' + [...this.types].join(', ') + '] ' : '') + (this.invalidOnly ? '⚠ ' : '') + t('(click to edit)') : t('type a name, Enter');
        it.tooltip = t('Filter objects by name (substring, or pattern with * ; empty = all)');
        it.contextValue = this.active ? 'search.active' : 'search';
        it.command = { command: 'dbexplorer.tree.filter', title: t('Search objects…') };
        it.id = 'dbexplorer.search';
        return it;
      }
      case 'conn': {
        const on = this.mgr.isConnected(n.profile.id);
        const s = this.mgr.session(n.profile.id);
        const isActive = this.mgr.activeProfileId === n.profile.id;
        const it = new vscode.TreeItem(n.profile.name, on ? C.Expanded : C.None);
        it.description = on ? `${isActive ? '● ' + t('active') + ' · ' : ''}${s!.conn.features.schemas ? s!.conn.currentSchema : ''}${s!.dirty ? ' *' : ''}` : describeProfile(n.profile);
        const hex = colorHex(n.profile.color);
        it.iconPath = hex
          ? vscode.Uri.parse('data:image/svg+xml;utf8,' + encodeURIComponent(dbIconSvg(hex, on ? 1 : 0.4)))
          : new vscode.ThemeIcon(on ? 'database' : 'debug-disconnect', on ? new vscode.ThemeColor(isActive ? 'charts.green' : 'charts.yellow') : undefined);
        it.contextValue = on ? (isActive ? 'conn.active' : 'conn.on') : 'conn';
        it.tooltip = `${describeProfile(n.profile)}${n.profile.role && n.profile.role !== 'DEFAULT' ? ' as ' + n.profile.role : ''}`;
        if (!on) it.command = { command: 'dbexplorer.connect', title: t('Connect'), arguments: [n] };
        else if (!isActive) it.command = { command: 'dbexplorer.setActive', title: t('Set as active connection'), arguments: [n] };
        return it;
      }
      case 'schema': {
        const it = new vscode.TreeItem(n.name, n.current ? C.Expanded : C.Collapsed);
        it.iconPath = new vscode.ThemeIcon(n.current ? 'account' : 'person', n.current ? new vscode.ThemeColor('charts.green') : undefined);
        it.description = n.current ? t('current schema') : undefined;
        it.contextValue = n.current ? 'schema.current' : 'schema';
        it.id = `${n.profile.id}|schema|${n.name}|${this.filter}`;
        it.tooltip = t('Schema {0}', n.name);
        return it;
      }
      case 'cat': {
        const it = new vscode.TreeItem(n.label, n.expanded ? C.Expanded : C.Collapsed);
        it.iconPath = new vscode.ThemeIcon(n.icon);
        it.contextValue = 'cat';
        if (n.hits) {
          it.description = String(n.hits.length);
          it.id = `${n.profile.id}|${n.schema ?? ''}|${n.type}|${this.filter}|${this.invalidOnly}`;
        }
        return it;
      }
      case 'obj': {
        const expandable = n.type === 'TABLE' || n.type === 'VIEW' || n.type === 'MATERIALIZED VIEW';
        const it = new vscode.TreeItem(n.name, expandable ? C.Collapsed : C.None);
        it.contextValue = `obj.${n.type}`;
        it.description = n.invalid ? t('INVALID') : undefined;
        it.iconPath = new vscode.ThemeIcon(
          n.invalid ? 'warning' : this.mgr.session(n.profile.id)?.conn.categories().find((c) => c.type === n.type)?.icon ?? 'symbol-misc',
          n.invalid ? new vscode.ThemeColor('list.warningForeground') : undefined
        );
        it.command = { command: 'dbexplorer.openDdl', title: 'DDL', arguments: [n] };
        return it;
      }
      case 'folder': {
        const lbl = { columns: t('Columns'), indexes: t('Indexes'), constraints: t('Constraints') }[n.what];
        const it = new vscode.TreeItem(lbl, C.Collapsed);
        it.iconPath = new vscode.ThemeIcon(n.what === 'columns' ? 'symbol-field' : n.what === 'indexes' ? 'list-ordered' : 'key');
        return it;
      }
      case 'leaf': {
        const it = new vscode.TreeItem(n.label, C.None);
        it.description = n.description;
        it.tooltip = n.tooltip;
        it.iconPath = n.icon ? new vscode.ThemeIcon(n.icon) : undefined;
        return it;
      }
    }
  }

  async getChildren(n?: Node): Promise<Node[]> {
    if (!n) return [{ kind: 'tab' }, { kind: 'search' }, ...this.mgr.list().map((profile) => ({ kind: 'conn' as const, profile }))];
    try {
      switch (n.kind) {
        case 'conn': {
          const conn = this.mgr.session(n.profile.id)?.conn;
          if (!conn) return [];
          if (this.grouped(conn)) return await this.schemaNodes(n.profile, conn);
          return await this.catNodes(n.profile, conn.currentSchema, !!this.filter, false);
        }
        case 'schema':
          return await this.catNodes(n.profile, n.name, false, true);
        case 'cat':
          return await this.objects(n);
        case 'obj':
          return ['columns', 'indexes', 'constraints'].map((what) => ({
            kind: 'folder',
            profile: n.profile,
            owner: n.owner,
            table: n.name,
            what: what as 'columns',
          }));
        case 'folder':
          return await this.details(n);
        default:
          return [];
      }
    } catch (e) {
      return [{ kind: 'leaf', label: (e as Error).message.split('\n')[0], icon: 'error' }];
    }
  }

  /** Schémas (utilisateurs) de la connexion : le courant d'abord ; le texte du filtre s'applique au nom du schéma. */
  private async schemaNodes(profile: Profile, conn: { currentSchema: string; schemas(): Promise<string[]> }): Promise<Node[]> {
    let p = this.schemaCache.get(profile.id);
    if (!p) {
      p = conn.schemas();
      this.schemaCache.set(profile.id, p);
      p.catch(() => this.schemaCache.delete(profile.id));
    }
    const re = this.filterRe();
    const cur = conn.currentSchema.toUpperCase();
    const names = (await p).filter((s) => !re || re.test(s) || s.toUpperCase() === cur).sort((a, b) => (a.toUpperCase() === cur ? -1 : b.toUpperCase() === cur ? 1 : a.localeCompare(b)));
    return names.map((name) => ({ kind: 'schema' as const, profile, name, current: name.toUpperCase() === cur }));
  }

  /** Catégories d'un schéma ; avec un filtre sur le nom / les invalides : seulement celles qui ont des correspondances, dépliées. */
  private async catNodes(profile: Profile, schema: string, textFilter: boolean, withSchema: boolean): Promise<Node[]> {
    const cats = (this.mgr.session(profile.id)?.conn.categories() ?? []).filter((c) => !this.types.size || this.types.has(c.type));
    const sch = withSchema ? schema : undefined;
    if (!textFilter && !this.invalidOnly) return cats.map((c) => ({ kind: 'cat' as const, profile, ...c, schema: sch }));
    const found = await Promise.all(cats.map(async (c) => ({ c, hits: await this.matching(profile, c.type, schema, textFilter).catch(() => []) })));
    const out: Node[] = found.filter((f) => f.hits.length).map((f) => ({ kind: 'cat' as const, profile, ...f.c, schema: sch, expanded: true, hits: f.hits }));
    if (out.length) return out;
    return [{ kind: 'leaf', label: this.invalidOnly ? t('No invalid object') : t('No object matches "{0}"', this.filter), icon: this.invalidOnly ? 'pass' : 'search-stop' }];
  }

  private filterRe(): RegExp | undefined {
    if (!this.filter) return undefined;
    const esc = this.filter.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/[*%]/g, '.*');
    return new RegExp(/[*%]/.test(this.filter) ? `^${esc}$` : esc, 'i');
  }

  /** Objets d'une catégorie qui correspondent au filtre : index de métadonnées d'abord, sinon recherche dans la base. */
  private async matching(profile: Profile, type: string, schema: string, textFilter = true): Promise<{ name: string; invalid: boolean }[]> {
    const re = (textFilter ? this.filterRe() : undefined) ?? (this.invalidOnly ? /./ : undefined);
    const s = this.mgr.session(profile.id);
    if (!re || !s) return [];
    const conn = s.conn;
    const m = this.invalidOnly ? undefined : this.cache?.peek(profile.id, schema);
    if (m?.complete && conn.objectInfos) {
      const hits = m.objects.filter((o) => o.type === type && re.test(o.name));
      if (hits.length) return hits.map((o) => ({ name: o.name, invalid: false }));
    }
    const key = `${profile.id}|${schema}|${type}`;
    let p = this.listCache.get(key);
    if (!p) {
      const max = vscode.workspace.getConfiguration('dbexplorer').get<number>('maxTreeObjects', 5000);
      p = conn.listObjects(type, schema, max);
      this.listCache.set(key, p);
      p.catch(() => this.listCache.delete(key));
    }
    return (await p).filter((r) => re.test(r.name) && (!this.invalidOnly || r.invalid));
  }

  private async objects(n: Extract<Node, { kind: 'cat' }>): Promise<Node[]> {
    const conn = this.mgr.session(n.profile.id)!.conn;
    const schema = n.schema ?? conn.currentSchema;
    const max = vscode.workspace.getConfiguration('dbexplorer').get<number>('maxTreeObjects', 5000);
    const list = n.hits ?? (await conn.listObjects(n.type, schema, max));
    return list.map((r) => ({ kind: 'obj', profile: n.profile, type: n.type, owner: schema, name: r.name, invalid: r.invalid }));
  }

  private async details(n: Extract<Node, { kind: 'folder' }>): Promise<Node[]> {
    const conn = this.mgr.session(n.profile.id)!.conn;
    if (n.what === 'columns') {
      const cols = await conn.columns(n.owner, n.table);
      return cols.map((c) => ({ kind: 'leaf', label: c.NAME, description: `${c.TYPE}${c.NULLABLE === 'N' ? ' NOT NULL' : ''}`, icon: c.PK ? 'key' : 'symbol-field' }));
    }
    if (n.what === 'indexes') {
      const rows = await conn.indexes(n.owner, n.table);
      return rows.map((r) => ({ kind: 'leaf', label: r.name, description: `${r.unique ? 'UNIQUE ' : ''}(${r.cols})`, icon: 'list-ordered' }));
    }
    const rows = await conn.constraints(n.owner, n.table);
    return rows.map((r) => ({
      kind: 'leaf',
      label: r.name,
      description: `${r.type}${r.cols ? ' (' + r.cols + ')' : ''}${r.ref ? ' → ' + r.ref : ''}${r.status === 'DISABLED' ? t(' [disabled]') : ''}`,
      icon: r.type === 'PK' ? 'key' : r.type === 'FK' ? 'references' : 'shield',
    }));
  }
}
