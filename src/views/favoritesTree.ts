import * as vscode from 'vscode';
import { ConnectionManager } from '../connections';
import { t } from '../i18n';

export interface Favorite {
  id: string;
  name: string;
  sql: string;
  /** Connexion propriétaire ; absent = toutes les connexions. */
  pid?: string;
  pname?: string;
  ts: number;
}

export type FNode = { kind: 'group'; id: string; label: string; items: Favorite[] } | { kind: 'fav'; fav: Favorite };

const KEY = 'dbexplorer.favorites';

/** Vue « Favoris » : requêtes enregistrées, par connexion (ou pour toutes), avec leurs paramètres :nom. */
export class FavoritesTree implements vscode.TreeDataProvider<FNode> {
  private readonly emitter = new vscode.EventEmitter<FNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly ctx: vscode.ExtensionContext, private readonly mgr: ConnectionManager) {
    mgr.onDidChange(() => this.emitter.fire(undefined));
  }

  list(): Favorite[] {
    return this.ctx.globalState.get<Favorite[]>(KEY, []);
  }

  /** Favoris visibles pour une connexion : les siens et ceux de « toutes les connexions ». */
  forConnection(pid?: string): Favorite[] {
    return this.list().filter((f) => !f.pid || f.pid === pid);
  }

  async add(name: string, sql: string, pid?: string): Promise<Favorite> {
    const fav: Favorite = { id: Math.random().toString(36).slice(2) + Date.now().toString(36), name, sql, pid, pname: pid ? this.mgr.get(pid)?.name : undefined, ts: Date.now() };
    await this.ctx.globalState.update(KEY, [fav, ...this.list()]);
    this.emitter.fire(undefined);
    return fav;
  }

  async rename(id: string, name: string) {
    await this.ctx.globalState.update(KEY, this.list().map((f) => (f.id === id ? { ...f, name } : f)));
    this.emitter.fire(undefined);
  }

  async remove(id: string) {
    await this.ctx.globalState.update(KEY, this.list().filter((f) => f.id !== id));
    this.emitter.fire(undefined);
  }

  getTreeItem(n: FNode): vscode.TreeItem {
    if (n.kind === 'group') {
      const it = new vscode.TreeItem(`${n.label} (${n.items.length})`, vscode.TreeItemCollapsibleState.Expanded);
      it.iconPath = new vscode.ThemeIcon(n.id === '*' ? 'globe' : 'database');
      it.contextValue = 'favGroup';
      it.id = 'fav-group-' + n.id;
      return it;
    }
    const f = n.fav;
    const it = new vscode.TreeItem(f.name, vscode.TreeItemCollapsibleState.None);
    const first = f.sql.split('\n').map((l) => l.trim()).find((l) => l) ?? f.sql;
    it.description = first.length > 60 ? first.slice(0, 60) + '…' : first;
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${f.name}**\n\n`);
    md.appendCodeblock(f.sql.length > 1500 ? f.sql.slice(0, 1500) + '\n…' : f.sql, 'sql');
    it.tooltip = md;
    it.iconPath = new vscode.ThemeIcon('star-full');
    it.contextValue = 'fav';
    it.command = { command: 'dbexplorer.favorite.open', title: t('Open in editor'), arguments: [n] };
    return it;
  }

  getChildren(n?: FNode): FNode[] {
    if (n?.kind === 'group') return n.items.map((fav) => ({ kind: 'fav', fav }));
    if (n) return [];
    const all = this.list();
    const groups = new Map<string, FNode & { kind: 'group' }>();
    for (const f of all) {
      const id = f.pid ?? '*';
      const label = f.pid ? this.mgr.get(f.pid)?.name ?? f.pname ?? f.pid : t('All connections');
      const g = groups.get(id) ?? { kind: 'group' as const, id, label, items: [] };
      g.items.push(f);
      groups.set(id, g);
    }
    // « toutes les connexions » d'abord, puis par nom ; la connexion active en tête des autres
    const active = this.mgr.activeProfileId;
    return [...groups.values()].sort((a, b) => (a.id === '*' ? -1 : b.id === '*' ? 1 : a.id === active ? -1 : b.id === active ? 1 : a.label.localeCompare(b.label)));
  }
}
