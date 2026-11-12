import { t } from './i18n';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ConnectionManager, Profile } from './connections';
import { SchemaTree, Node } from './schemaTree';
import { ResultsPanel } from './resultsPanel';
import { Runner } from './runner';
import { SqlCompletion, parseRefList } from './completion';
import { MetaCache, within, TIMEOUT, ColMeta } from './metaCache';
import { KIND_LABELS, describeProfile } from './drivers';
import { SetupView } from './views/setupView';
import { HelpView } from './views/helpView';
import { DescribePanel } from './views/describePanel';
type HNode = { kind: 'item'; item: import('./runner').HistoryItem } | { kind: 'day' };
import { FavoritesTree, FNode, Favorite } from './views/favoritesTree';
import { SettingsView } from './views/settingsView';
import { EditorColors } from './editorColors';
import { LibraryView } from './views/libraryView';
import { buildCallGraph, buildQueryGraph, showGraph } from './graphs';
import { buildErGraph } from './erGraph';
import { buildLineage } from './lineage';
import { buildDupQueries } from './dupDetector';
import { buildSyncScript, diffSnapshots, takeSnapshot } from './schemaDiff';
import { literal } from './exporters';
import { linkQuery, pickLink, tablesOf } from './linkFollow';
import { analyzeQuery } from './optimizer';
import { showOptimization } from './views/optimizePanel';
import { prettySql } from './sqlformat';
import { setBlankLineSplit, split, statementAt } from './splitter';
import { dialectOf } from './runner';
import { toAnsiJoins } from './ansiJoin';
import { SqlCodeActions } from './codeActions';
import { colorHex, nextColor } from './palette';
import { ObjectLinks } from './objectLinks';
import { registerInlineErrors } from './inlineErrors';
import { builtinSnippets, SnippetDef } from './snippets';
import { isProd, envLabel } from './drivers/types';
import { detectTnsDirs, listTnsAliases } from './drivers/tns';

let manager: ConnectionManager | undefined;
import { q } from './objectTabs';
import type { BindDef } from './views/paramsDialog';


export function activate(ctx: vscode.ExtensionContext) {
  const mgr = new ConnectionManager(ctx);
  const panel = new ResultsPanel(ctx);
  const runner = new Runner(ctx, mgr, panel);
  const tree = new SchemaTree(mgr);
  const metaCache = new MetaCache(ctx, mgr);
  tree.cache = metaCache;
  DescribePanel.meta = metaCache;
  runner.meta = metaCache;
  const completion = new SqlCompletion(mgr, metaCache);
  const setup = new SetupView(mgr);
  const help = new HelpView(ctx);
  const favorites = new FavoritesTree(ctx, mgr);
  const settings = new SettingsView(mgr, metaCache);
  manager = mgr;
  const applySplitSetting = () => setBlankLineSplit(vscode.workspace.getConfiguration('dbexplorer').get<boolean>('blankLineSeparatesStatements', true));
  applySplitSetting();
  ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('dbexplorer.blankLineSeparatesStatements') && applySplitSetting()));
  mgr.startWatchdog();

  // Pendant une exécution : bouton « Annuler » dans la barre d'état (et dans la barre de l'éditeur, Ctrl+Alt+Q)
  const cancelStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
  cancelStatus.text = t('$(debug-stop) Cancel query');
  cancelStatus.tooltip = t('Interrupt the running statement');
  cancelStatus.command = 'dbexplorer.cancel';
  cancelStatus.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  ctx.subscriptions.push(cancelStatus, runner.onDidChangeRunning((r) => (r ? cancelStatus.show() : cancelStatus.hide())));
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  const acStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  // modifications non validées : Commit / Rollback bien visibles (fond d'alerte) tant qu'il y a une transaction ouverte
  const commitStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 96);
  commitStatus.text = t('$(check) Commit');
  commitStatus.tooltip = t('Commit the pending changes');
  commitStatus.command = 'dbexplorer.commit';
  const rollbackStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 95);
  rollbackStatus.text = t('$(discard) Rollback');
  rollbackStatus.tooltip = t('Roll back the pending changes');
  rollbackStatus.command = 'dbexplorer.rollback';
  for (const i of [commitStatus, rollbackStatus]) i.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  ctx.subscriptions.push(commitStatus, rollbackStatus);
  const roStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 94);
  roStatus.command = 'dbexplorer.toggleReadOnly';
  ctx.subscriptions.push(roStatus);
  const schemaStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
  schemaStatus.command = 'dbexplorer.changeSchema';
  status.command = 'dbexplorer.setActive';
  acStatus.command = 'dbexplorer.toggleAutoCommit';
  const treeView = vscode.window.createTreeView('dbexplorer.connections', { treeDataProvider: tree });
  const userAt = (pr: Profile, conn: { currentSchema: string; features: { schemas: boolean } }) =>
    conn.features.schemas ? `${pr.user ?? ''}@${conn.currentSchema || t('(none)')}` : pr.user ? `${pr.user}@${pr.database || pr.name}` : pr.name;
  // Option : afficher la connexion dans le titre de la fenêtre VS Code (réglage utilisateur window.title, restauré ensuite)
  const DEFAULT_TITLE = '${dirty}${activeEditorShort}${separator}${rootName}${separator}${profileName}${separator}${appName}';
  const restoreTitle = () => {
    const saved = ctx.globalState.get<{ value: string | null }>('dbexplorer.titleSaved');
    if (!saved) return;
    void vscode.workspace.getConfiguration().update('window.title', saved.value ?? undefined, vscode.ConfigurationTarget.Global);
    void ctx.globalState.update('dbexplorer.titleSaved', undefined);
  };
  const syncWindowTitle = (text?: string) => {
    const on = vscode.workspace.getConfiguration('dbexplorer').get<boolean>('connectionInWindowTitle', true);
    if (!on || !text) return restoreTitle();
    const cfg = vscode.workspace.getConfiguration();
    const insp = cfg.inspect<string>('window.title');
    let saved = ctx.globalState.get<{ value: string | null }>('dbexplorer.titleSaved');
    if (!saved) {
      saved = { value: insp?.globalValue ?? null };
      void ctx.globalState.update('dbexplorer.titleSaved', saved);
    }
    const next = `${text.replace(/\$/g, '')} — ${saved.value ?? DEFAULT_TITLE}`;
    if (insp?.globalValue !== next) void cfg.update('window.title', next, vscode.ConfigurationTarget.Global);
  };
  ctx.subscriptions.push({ dispose: restoreTitle });
  const updateStatus = () => {
    // l'éditeur SQL au premier plan utilise sa propre connexion ; sinon la connexion active
    const ed = vscode.window.activeTextEditor;
    const bound = ed && ed.document.languageId === 'sql' ? mgr.forDocument(ed.document.uri) : undefined;
    const a = bound ?? mgr.active;
    if (!a) {
      status.text = t('$(database) DB Explorer: not connected');
      status.tooltip = t('Click to choose a connection');
      status.color = undefined;
      status.backgroundColor = undefined;
      schemaStatus.color = undefined;
      acStatus.hide();
      schemaStatus.hide();
      commitStatus.hide();
      rollbackStatus.hide();
      roStatus.hide();
      void vscode.commands.executeCommand('setContext', 'dbexplorer.dirty', false);
      panel.setDirty(false);
      panel.setDescription(undefined);
      syncWindowTitle(undefined);
    } else {
      const hex = colorHex(a.profile.color);
      const ua = userAt(a.profile, a.session.conn);
      status.text = `$(database) ${a.profile.name}${envLabel(a.profile) ? ' · ' + envLabel(a.profile) : ''}${a.profile.readOnly ? ' $(lock)' : ''}`;
      roStatus.text = a.profile.readOnly ? t('$(lock) Read-only') : t('$(unlock) Read-write');
      roStatus.tooltip = t('Toggle read-only mode: block everything but queries on this connection');
      roStatus.backgroundColor = undefined;
      roStatus.show();
      status.color = hex;
      status.backgroundColor = isProd(a.profile) ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined; // rouge = production : alerte visible
      schemaStatus.color = hex;
      if (a.session.conn.features.schemas) {
        schemaStatus.text = `$(symbol-namespace) ${ua}`;
        schemaStatus.tooltip = t('Change schema');
        schemaStatus.show();
      } else schemaStatus.hide();
      status.tooltip = `${KIND_LABELS[a.profile.type]} — ${describeProfile(a.profile)}
${t('Click to switch connection')}`;
      acStatus.text = `${a.session.autoCommit ? t('$(sync) Auto-commit') : t('$(circle-outline) Manual')}${a.session.dirty ? t(' $(circle-filled) uncommitted') : ''}`;
      acStatus.tooltip = t('Toggle auto-commit');
      acStatus.backgroundColor = a.session.dirty ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
      acStatus.show();
      const dirty = !!a.session.dirty;
      if (dirty) {
        commitStatus.show();
        rollbackStatus.show();
      } else {
        commitStatus.hide();
        rollbackStatus.hide();
      }
      void vscode.commands.executeCommand('setContext', 'dbexplorer.dirty', dirty);
      panel.setDirty(dirty, a.profile.name);
      // en-tête de DB Explorer : connexion + user@schéma
      panel.setDescription(`${a.profile.name} · ${ua}`);
      syncWindowTitle(`${a.profile.name} · ${ua}`);
    }
    status.show();
  };
  ctx.subscriptions.push(treeView, vscode.window.onDidChangeActiveTextEditor(() => updateStatus()));
  const colors = new EditorColors(mgr);
  ctx.subscriptions.push(vscode.window.registerFileDecorationProvider(colors), colors);
  mgr.onDidChangeSchema((pid) => {
    metaCache.markStale(pid);
    completion.routines.clear();
  });
  registerInlineErrors(ctx, (uri, from, to) => runner.forgetDiagnostics(uri, from, to));
  // badge dans l'éditeur : connexion de la requête en fin de première ligne, fond rouge pour la production
  const badge = vscode.window.createTextEditorDecorationType({});
  const badgeProd = vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: 'rgba(241,76,76,0.14)' });
  const updateBadges = () => {
    const on = vscode.workspace.getConfiguration('dbexplorer').get<boolean>('showEditorBadge', true);
    for (const ed of vscode.window.visibleTextEditors) {
      if (ed.document.languageId !== 'sql') continue;
      const a = on && ed.document.lineCount ? mgr.forDocument(ed.document.uri) ?? mgr.active : undefined;
      if (!a) {
        ed.setDecorations(badge, []);
        ed.setDecorations(badgeProd, []);
        continue;
      }
      const prod = isProd(a.profile);
      const r = ed.document.lineAt(0).range;
      ed.setDecorations(badge, [{ range: new vscode.Range(r.end, r.end), renderOptions: { after: { contentText: '   ⛁ ' + a.profile.name + (prod ? ' · PRODUCTION' : envLabel(a.profile) ? ' · ' + envLabel(a.profile) : ''), color: colorHex(a.profile.color) ?? new vscode.ThemeColor('descriptionForeground'), fontStyle: 'italic' } } }]);
      ed.setDecorations(badgeProd, prod ? [r] : []);
    }
  };
  ctx.subscriptions.push(badge, badgeProd, vscode.window.onDidChangeVisibleTextEditors(updateBadges), vscode.workspace.onDidChangeTextDocument((e) => e.document.languageId === 'sql' && e.contentChanges.some((c) => c.range.start.line === 0) && updateBadges()), vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('dbexplorer.showEditorBadge') && updateBadges()));
  ctx.subscriptions.push(vscode.window.onDidChangeActiveTextEditor((e) => e?.document.languageId === 'sql' && panel.update({ activeDoc: e.document.uri.toString() })));
  mgr.onDidChange(() => {
    updateStatus();
    updateBadges();
  });
  updateStatus();
  updateBadges();

  // Indicateur du scan de métadonnées (cache de l'aide à la saisie)
  const scanStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 97);
  scanStatus.tooltip = t('DB Explorer is caching table and column names for faster code completion');
  ctx.subscriptions.push(
    scanStatus,
    metaCache.onProgress((st) => {
      if (st.phase === 'done' || st.phase === 'error') scanStatus.hide();
      else {
        scanStatus.text = st.phase === 'columns' && st.total ? '$(sync~spin) ' + t('Indexing {0}/{1}', st.done, st.total) : '$(sync~spin) ' + t('Indexing metadata…');
        scanStatus.show();
      }
    })
  );

  /** Message de succès discret (barre d'état) : pas de popup à fermer. */
  const notify = (m: string) => void vscode.window.setStatusBarMessage('$(check) ' + m, 6000);
  const reg = (id: string, fn: (...args: any[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));
  const sqlEditor = () => {
    const e = vscode.window.activeTextEditor;
    if (!e) vscode.window.showWarningMessage(t('Open a SQL editor.'));
    return e;
  };
  const profileOf = (n?: Node): Profile | undefined => (n && 'profile' in n ? n.profile : undefined);
  const pickProfile = async () => {
    const pick = await vscode.window.showQuickPick(mgr.list().map((p) => ({ label: p.name, description: `${KIND_LABELS[p.type]} — ${describeProfile(p)}`, id: p.id })));
    return pick ? mgr.get(pick.id) : undefined;
  };

  // ------------------------------------------------------------ connexions
  reg('dbexplorer.addConnection', () => setup.open());
  reg('dbexplorer.showResults', () => panel.reveal());
  reg('dbexplorer.editConnection', async (n?: Node) => {
    const p = profileOf(n) ?? (await pickProfile());
    if (p) await setup.open(p);
  });
  reg('dbexplorer.removeConnection', async (n?: Node) => {
    const p = profileOf(n) ?? (await pickProfile());
    if (!p) return;
    const ok = await vscode.window.showWarningMessage(t('Delete connection "{0}"?', p.name), { modal: true }, t('Delete'));
    if (ok) await mgr.remove(p.id);
  });
  reg('dbexplorer.connect', async (n?: Node) => {
    const p = profileOf(n) ?? (await pickProfile());
    if (p) {
      await mgr.connect(p.id);
      completion.preload();
    }
  });
  /** Transaction ouverte : propose Commit / Rollback avant de fermer la connexion ; false = l'utilisateur renonce. */
  const settleDirty = async (id: string): Promise<boolean> => {
    const st = mgr.statuses().find((x) => x.id === id);
    if (!st?.dirty) return true;
    const commit = t('Commit and disconnect');
    const rollback = t('Rollback and disconnect');
    const pick = await vscode.window.showWarningMessage(t('"{0}" has uncommitted changes.', st.name), { modal: true }, commit, rollback);
    if (!pick) return false;
    await vscode.commands.executeCommand(pick === commit ? 'dbexplorer.commit' : 'dbexplorer.rollback', id);
    return true;
  };
  reg('dbexplorer.disconnect', async (n?: Node) => {
    const p = profileOf(n) ?? mgr.active?.profile;
    if (p && (await settleDirty(p.id))) await mgr.disconnect(p.id);
  });
  reg('dbexplorer.toggleReadOnly', async () => {
    const ed = vscode.window.activeTextEditor;
    const a = (ed && ed.document.languageId === 'sql' ? mgr.forDocument(ed.document.uri) : undefined) ?? mgr.active;
    if (!a) return vscode.window.showInformationMessage(t('Not connected.'));
    const ro = !a.profile.readOnly;
    await mgr.upsert({ ...a.profile, readOnly: ro || undefined });
    notify(ro ? t('"{0}" is now read-only: only queries can run.', a.profile.name) : t('"{0}" is writable again.', a.profile.name));
    mgr.changed();
  });
  /** L'éditeur SQL au premier plan adopte la connexion choisie (et en prend la couleur). */
  const bindEditor = (id: string) => {
    const ed = vscode.window.activeTextEditor;
    if (ed && ed.document.languageId === 'sql') mgr.bind(ed.document.uri, id);
  };
  /** Changer de connexion à tout moment : l'éditeur SQL au premier plan (et la connexion active) passent sur la connexion choisie, ouverte si besoin. */
  reg('dbexplorer.setActive', async (n?: Node) => {
    let p = profileOf(n);
    if (!p) {
      const ed = vscode.window.activeTextEditor;
      const cur = ed && ed.document.languageId === 'sql' ? mgr.forDocument(ed.document.uri)?.profile.id : mgr.active?.profile.id;
      const id = await pickConnection(t('Switch connection'), cur);
      if (!id) return;
      if (id === 'new') return vscode.commands.executeCommand('dbexplorer.addConnection');
      p = mgr.get(id);
    }
    if (!p) return;
    if (!mgr.isConnected(p.id)) {
      await mgr.connect(p.id);
      if (!mgr.isConnected(p.id)) return;
      completion.preload();
    }
    mgr.setActive(p.id);
    bindEditor(p.id);
  });
  reg('dbexplorer.refresh', () => {
    completion.invalidate();
    tree.refresh();
  });
  reg('dbexplorer.changeSchema', async (n?: Node) => {
    const p = profileOf(n) ?? mgr.active?.profile;
    const s = p && mgr.session(p.id);
    if (!p || !s) return;
    if (!s.conn.features.schemas) return vscode.window.showInformationMessage(t('This database has no schema concept.'));
    const pick = await vscode.window.showQuickPick(await s.conn.schemas(), { placeHolder: t('Schema to browse') });
    if (!pick) return;
    await s.conn.useSchema(pick);
    completion.preload();
    mgr.changed();
  });

  // Onglets internes « Schema Browser | Connexion » : deux vues alternées dans le même emplacement (contexte dbexplorer.sideTab)
  void vscode.commands.executeCommand('setContext', 'dbexplorer.sideTab', 'browser');
  reg('dbexplorer.sideTab.browser', () => vscode.commands.executeCommand('setContext', 'dbexplorer.sideTab', 'browser'));
  reg('dbexplorer.sideTab.connection', () => vscode.commands.executeCommand('setContext', 'dbexplorer.sideTab', 'connection'));

  // --------------------------------------------------------------- éditeur
  /**
   * Choix d'une connexion : la dernière utilisée en premier (Entrée la valide), puis les autres par ancienneté d'usage ;
   * « Nouvelle connexion… » en dernier. Renvoie l'identifiant, 'new', ou undefined si l'utilisateur renonce.
   */
  const pickConnection = async (placeholder: string, currentId?: string): Promise<string | undefined> => {
    const all = mgr.ordered();
    const last = mgr.lastUsedId();
    type Pick = vscode.QuickPickItem & { id: string };
    const items: Pick[] = all.map((p) => {
      const on = mgr.isConnected(p.id);
      const tags = [p.id === last ? t('last used') : '', p.id === currentId ? t('this editor') : '', on ? t('connected') : '', envLabel(p), p.readOnly ? t('read-only') : ''].filter(Boolean);
      return {
        label: `${on ? '$(plug)' : '$(database)'} ${p.name}`,
        description: `${KIND_LABELS[p.type]} — ${describeProfile(p)}`,
        detail: tags.length ? tags.join(' · ') : undefined,
        id: p.id,
      };
    });
    items.push({ label: '$(add) ' + t('New connection…'), id: 'new' });
    const pick = await vscode.window.showQuickPick(items, { placeHolder: placeholder, matchOnDescription: true, matchOnDetail: true });
    return pick?.id;
  };

  reg('dbexplorer.newEditor', async (n?: Node) => {
    let profile = profileOf(n);
    if (!profile) {
      const all = mgr.ordered();
      if (!all.length) return vscode.commands.executeCommand('dbexplorer.addConnection');
      if (all.length === 1) profile = all[0];
      else {
        const id = await pickConnection(t('Connection for the new query'));
        if (!id) return;
        if (id === 'new') return vscode.commands.executeCommand('dbexplorer.addConnection');
        profile = mgr.get(id);
      }
    }
    if (!profile) return;
    if (!mgr.isConnected(profile.id)) {
      await mgr.connect(profile.id);
      if (!mgr.isConnected(profile.id)) return;
      completion.preload();
    }
    const base = profile.name.replace(/[^\w.-]+/g, '_');
    let i = 1;
    let uri: vscode.Uri;
    do uri = vscode.Uri.parse(`untitled:${base}-${i++}.sql`);
    while (vscode.workspace.textDocuments.some((d) => d.uri.toString() === uri.toString()));
    let doc = await vscode.workspace.openTextDocument(uri);
    if (doc.languageId !== 'sql') doc = await vscode.languages.setTextDocumentLanguage(doc, 'sql');
    mgr.bind(doc.uri, profile.id);
    mgr.setActive(profile.id);
    await vscode.window.showTextDocument(doc);
  });
  reg('dbexplorer.executeStatement', () => {
    const e = sqlEditor();
    if (e) return runner.run(e, 'statement');
  });
  reg('dbexplorer.executeScript', () => {
    const e = sqlEditor();
    if (e) return runner.run(e, 'script');
  });
  reg('dbexplorer.explainPlan', () => {
    const e = sqlEditor();
    if (e) return runner.explain(e);
  });
  // F4 : table/vue -> colonnes ; fonction, procédure, package, trigger, type... -> source dans l'éditeur
  /** Ouvre un objet : table / vue → Describe Objects ; package, fonction, trigger… → source (« pkg.proc » positionne sur le membre). */
  const openObject = async (input: string, uri?: vscode.Uri) => {
    const act = uri ? await mgr.requireFor(uri) : await mgr.requireActive();
    if (!act) return;
    const conn = act.session.conn;
    const parts = input.split('.');
    // schéma.objet.membre | objet.membre | schéma.objet | objet
    const tries: { schema: string; name: string; member?: string }[] = [];
    if (parts.length === 1) tries.push({ schema: conn.currentSchema, name: parts[0] });
    else if (parts.length === 2) {
      tries.push({ schema: conn.currentSchema, name: parts[0], member: parts[1] });
      tries.push({ schema: parts[0], name: parts[1] });
    } else tries.push({ schema: parts[0], name: parts[1], member: parts[2] });
    let found: { type: string; schema: string; name: string } | undefined;
    let member: string | undefined;
    for (const t of tries) {
      try {
        found = await conn.findObject(t.schema, t.name);
      } catch {
        found = undefined;
      }
      if (found) {
        member = t.member;
        break;
      }
    }
    if (!found) return vscode.window.showWarningMessage(t('Object not found: {0}', input));
    if (['TABLE', 'VIEW', 'MATERIALIZED VIEW'].includes(found.type)) return DescribePanel.open(act.profile.id, conn, found);
    try {
      const ddl = await conn.ddl(found.type, found.schema, found.name);
      const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: ddl });
      mgr.bind(doc.uri, act.profile.id);
      const ed = await vscode.window.showTextDocument(doc, { preview: false });
      if (member) {
        const text = doc.getText();
        const bodyStart = Math.max(0, text.search(/package\s+body/i));
        const re = new RegExp('\\b(procedure|function)\\s+"?' + member.replace(/[^\w$#]/g, '') + '"?\\b', 'i');
        const m = re.exec(text.slice(bodyStart));
        if (m) {
          const pos = doc.positionAt(bodyStart + m.index);
          ed.selection = new vscode.Selection(pos, pos);
          ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.AtTop);
        }
      }
    } catch (err) {
      vscode.window.showErrorMessage(t('Source unavailable: {0}', (err as Error).message));
    }
  };
  /** Ctrl+Alt+D sur une colonne : type, clé primaire et commentaire, d'après les tables de la requête. Renvoie false si ce n'est pas une colonne. */
  const showColumnType = async (e: vscode.TextEditor, word: string): Promise<boolean> => {
    const act = mgr.forDocument(e.document.uri) ?? mgr.active;
    if (!act) return false;
    const conn = act.session.conn;
    const stmt = statementAt(split(e.document.getText(), dialectOf(conn.kind)), e.document.offsetAt(e.selection.active));
    if (!stmt) return false;
    const refs = parseRefList(stmt.text, Math.max(0, e.document.offsetAt(e.selection.active) - stmt.start)).filter((r) => !r.virtual);
    if (!refs.length) return false;
    const parts = word.replace(/"/g, '').split('.');
    const col = parts[parts.length - 1].toLowerCase();
    const qual = parts.length > 1 ? parts[parts.length - 2].toLowerCase() : '';
    const base = (n: string) => n.split('.').pop()!.toLowerCase();
    // un nom de table ou d'alias seul reste un « Describe » de table
    if (!qual && refs.some((r) => r.alias.toLowerCase() === col || base(r.table) === col)) return false;
    const cands = qual ? refs.filter((r) => r.alias.toLowerCase() === qual || base(r.table) === qual || r.table.toLowerCase() === qual) : refs;
    if (!cands.length) return false;
    const hits: { r: (typeof refs)[number]; c: ColMeta }[] = [];
    for (const r of cands) {
      const [o, tb] = r.table.includes('.') ? (r.table.split('.') as [string, string]) : [conn.currentSchema, r.table];
      const cols = await within(metaCache.columns(act.profile.id, o.replace(/"/g, ''), tb.replace(/"/g, '')).catch(() => [] as ColMeta[]), 3000);
      if (cols === TIMEOUT) continue;
      const c = cols.find((x) => x.name.toLowerCase() === col);
      if (c) hits.push({ r, c });
    }
    if (!hits.length) return false;
    const msg = hits.map(({ r, c }) => `${r.alias !== r.table ? r.alias + '.' : base(r.table) + '.'}${c.name} : ${c.type}${c.pk ? ' · PK' : ''}${c.comment ? ' — ' + c.comment : ''}`).join('\n');
    const open = t('Describe {0}', hits[0].r.table);
    const pick = await vscode.window.showInformationMessage(msg, open);
    if (pick === open) await openObject(hits[0].r.table, e.document.uri);
    return true;
  };
  reg('dbexplorer.describe', async () => {
    const e = sqlEditor();
    if (!e) return;
    const range = e.document.getWordRangeAtPosition(e.selection.active, /"?[\w$#]+"?(\."?[\w$#]+"?)*/);
    const word = e.selection.isEmpty ? (range ? e.document.getText(range) : '') : e.document.getText(e.selection).trim();
    // un nom de colonne de la requête (« alias.col » ou « col ») : on affiche son type plutôt que d'ouvrir un objet
    if (word && (await showColumnType(e, word))) return;
    const input = word || (await vscode.window.showInputBox({ prompt: t('Object to open (table, view, package, function, trigger…)') })) || '';
    if (input) await openObject(input, e.document.uri);
  });
  // actions de code : opérations sur un nom de table précis
  reg('dbexplorer.describeName', (name: string, uri?: vscode.Uri | string) => openObject(name, typeof uri === 'string' ? vscode.Uri.parse(uri) : uri));
  const runInNewEditor = async (sqlText: string, uri?: vscode.Uri) => {
    const act = uri ? await mgr.requireFor(uri) : await mgr.requireActive();
    if (!act) return;
    const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: sqlText });
    mgr.bind(doc.uri, act.profile.id);
    const ed = await vscode.window.showTextDocument(doc);
    await runner.run(ed, 'statement');
  };
  reg('dbexplorer.selectName', (name: string, uri?: vscode.Uri) => runInNewEditor(`SELECT *\n  FROM ${name};\n`, uri));
  reg('dbexplorer.countName', (name: string, uri?: vscode.Uri) => runInNewEditor(`SELECT COUNT(*)\n  FROM ${name};\n`, uri));
  reg('dbexplorer.codeActions', () => vscode.commands.executeCommand('editor.action.quickFix'));
  // Ctrl+F9 : types des colonnes de la requête
  reg('dbexplorer.describeQuery', async () => {
    const e = sqlEditor();
    if (!e) return;
    if (!(await runner.describeQuery(e))) await vscode.commands.executeCommand('dbexplorer.describe');
  });
  reg('dbexplorer.commit', (id?: unknown) => runner.commit(typeof id === 'string' ? id : undefined));
  reg('dbexplorer.rollback', (id?: unknown) => runner.rollback(typeof id === 'string' ? id : undefined));
  reg('dbexplorer.cancel', () => runner.cancel());
  reg('dbexplorer.toggleAutoCommit', () => {
    const a = mgr.active;
    if (!a) return;
    a.session.autoCommit = !a.session.autoCommit;
    mgr.changed();
  });
  reg('dbexplorer.history', async () => {
    const h = runner.history;
    if (!h.length) return vscode.window.showInformationMessage(t('History is empty.'));
    // recherche dans le texte, la date (« 2026-10-27 »), la connexion ; boutons : connexion courante / erreurs seulement
    const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { sql: string; connId?: string; connName?: string }>();
    qp.placeholder = t('Search the SQL history (text, date, connection)');
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;
    const current = (mgr.forDocument(vscode.window.activeTextEditor?.document.uri ?? vscode.Uri.parse('untitled:x')) ?? mgr.active)?.profile.id;
    let onlyConn = false;
    let onlyErr = false;
    const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);
    const btn = (icon: string, tip: string) => ({ iconPath: new vscode.ThemeIcon(icon), tooltip: tip });
    const refresh = () => {
      qp.buttons = [btn(onlyConn ? 'database' : 'circle-outline', t('Only the current connection') + (onlyConn ? ' ✓' : '')), btn(onlyErr ? 'error' : 'warning', t('Only failed statements') + (onlyErr ? ' ✓' : ''))];
      qp.items = h
        .filter((x) => (!onlyConn || !current || x.connId === current) && (!onlyErr || !x.ok))
        .map((x) => ({
          label: `${x.ok ? '$(check)' : '$(error)'} ${x.sql.replace(/\s+/g, ' ').slice(0, 100)}`,
          description: `${day(x.ts)} ${new Date(x.ts).toLocaleTimeString()} — ${x.conn} — ${x.ms} ms`,
          detail: x.sql.length > 100 ? x.sql.replace(/\s+/g, ' ').slice(0, 300) : undefined,
          sql: x.sql,
          connId: x.connId,
          connName: x.conn,
        }));
    };
    refresh();
    qp.onDidTriggerButton((b) => {
      if (b.tooltip?.startsWith(t('Only the current connection'))) onlyConn = !onlyConn;
      else onlyErr = !onlyErr;
      refresh();
    });
    const pick = await new Promise<(vscode.QuickPickItem & { sql: string; connId?: string; connName?: string }) | undefined>((resolve) => {
      qp.onDidAccept(() => resolve(qp.selectedItems[0]));
      qp.onDidHide(() => resolve(undefined));
      qp.show();
    });
    qp.dispose();
    if (!pick) return;
    const e = vscode.window.activeTextEditor;
    const origin = { connId: pick.connId, conn: pick.connName };
    if (e && e.document.languageId === 'sql') {
      await e.edit((b) => b.insert(e.selection.active, pick.sql + (/;\s*$/.test(pick.sql) ? '' : ';') + '\n'));
      await offerOrigin(e, origin);
    } else {
      const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: pick.sql + ';\n' });
      await vscode.window.showTextDocument(doc);
      await reconnectOrigin(doc, origin);
    }
  });

  // ---------------------------------------------------------------- modèles de requêtes
  reg('dbexplorer.insertSnippet', async () => {
    const e = sqlEditor() ?? vscode.window.activeTextEditor;
    const act = e ? mgr.forDocument(e.document.uri) ?? mgr.active : mgr.active;
    const kind = act?.session.conn.kind;
    const user = vscode.workspace.getConfiguration('dbexplorer').get<SnippetDef[]>('snippets', []);
    const all = [...user.map((s) => ({ ...s, user: true })), ...builtinSnippets().filter((s) => !s.kinds || !kind || s.kinds.includes(kind)).map((s) => ({ ...s, user: false }))];
    const pick = await vscode.window.showQuickPick(
      all.map((s) => ({ label: (s.user ? '$(star) ' : '') + s.name, description: s.description, detail: s.body.replace(/\$\{\d+:?([^}]*)\}/g, '$1').replace(/\$0/g, '').replace(/\s+/g, ' ').slice(0, 120), body: s.body })),
      { placeHolder: t('Query template to insert'), matchOnDescription: true, matchOnDetail: true }
    );
    if (!pick) return;
    if (!e) {
      const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: '' });
      const ed = await vscode.window.showTextDocument(doc);
      await ed.insertSnippet(new vscode.SnippetString(pick.body));
    } else await e.insertSnippet(new vscode.SnippetString(pick.body));
  });
  reg('dbexplorer.saveSnippet', async () => {
    const e = sqlEditor();
    if (!e) return;
    const text = e.selection.isEmpty ? e.document.getText() : e.document.getText(e.selection);
    if (!text.trim()) return vscode.window.showInformationMessage(t('Nothing to save: select the SQL text first.'));
    const name = await vscode.window.showInputBox({ prompt: t('Name of the template'), ignoreFocusOut: true });
    if (!name) return;
    const cfg = vscode.workspace.getConfiguration('dbexplorer');
    const list = cfg.get<SnippetDef[]>('snippets', []);
    await cfg.update('snippets', [...list.filter((s) => s.name !== name), { name, body: text.replace(/[\\$}]/g, '\\$&') }], vscode.ConfigurationTarget.Global);
    notify(t('Template "{0}" saved.', name));
  });

  // ---------------------------------------------------------------- aller à un objet (Ctrl+Alt+G)
  reg('dbexplorer.goToObject', async () => {
    const act = mgr.active;
    if (!act) return vscode.window.showInformationMessage(t('Not connected.'));
    const pid = act.profile.id;
    const schema = act.session.conn.currentSchema;
    type It = vscode.QuickPickItem & { name: string; type: string };
    const asItem = (o: { name: string; type: string; owner?: string }): It => ({ label: (/TABLE|VIEW/.test(o.type) ? '$(table) ' : '$(symbol-method) ') + o.name, description: o.type + (o.owner && o.owner !== schema ? ' — ' + o.owner : ''), name: o.owner && o.owner !== schema ? o.owner + '.' + o.name : o.name, type: o.type, buttons: [{ iconPath: new vscode.ThemeIcon('info'), tooltip: t('Describe') }] });
    const qp = vscode.window.createQuickPick<It>();
    qp.placeholder = t('Object name (table, view, package, procedure…) — Enter: open, ⓘ: describe');
    qp.matchOnDescription = true;
    const cached = await within(metaCache.get(pid, schema), 1500);
    const base = cached === TIMEOUT ? [] : cached.objects;
    qp.items = base.slice(0, 300).map(asItem);
    let seq = 0;
    qp.onDidChangeValue(async (v) => {
      const mine = ++seq;
      const q = v.trim();
      if (q.length < 2) return void (qp.items = base.slice(0, 300).map(asItem));
      const local = base.filter((o) => o.name.toLowerCase().includes(q.toLowerCase())).slice(0, 100);
      qp.items = local.map(asItem);
      const found = await metaCache.searchObjects(pid, schema, q).catch(() => []);
      if (mine !== seq) return;
      const seen = new Set(local.map((o) => o.name));
      qp.items = [...local.map(asItem), ...found.filter((o) => !seen.has(o.name) || o.owner).map(asItem)];
    });
    const pick = await new Promise<{ it?: It; describe?: boolean }>((resolve) => {
      qp.onDidAccept(() => resolve({ it: qp.selectedItems[0] }));
      qp.onDidTriggerItemButton((e) => resolve({ it: e.item, describe: true }));
      qp.onDidHide(() => resolve({}));
      qp.show();
    });
    qp.dispose();
    if (!pick.it) return;
    const ed = vscode.window.activeTextEditor;
    const uri = ed?.document.languageId === 'sql' ? ed.document.uri : undefined;
    const tableLike = /TABLE|VIEW|SYNONYM/.test(pick.it.type);
    await vscode.commands.executeCommand(pick.describe || !tableLike ? 'dbexplorer.describeName' : 'dbexplorer.selectName', pick.it.name, uri);
  });

  /** Ouvre un texte SQL dans un nouvel éditeur rattaché à une connexion (Describe › Script). */
  reg('dbexplorer.openSqlText', async (sql: string, pid?: string) => {
    const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: sql + '\n' });
    await vscode.window.showTextDocument(doc, { preview: false });
    if (pid && mgr.get(pid)) mgr.bind(doc.uri, pid);
  });

  // ---------------------------------------------------------------- informations de diagnostic
  reg('dbexplorer.diagnostics', async () => {
    const ext = vscode.extensions.getExtension('dbexplorer.dbexplorer') ?? vscode.extensions.all.find((e) => e.id.toLowerCase().includes('dbexplorer'));
    const conns = mgr.list().map((p) => '- ' + p.name + ' [' + p.type + (p.env ? ', ' + p.env : '') + (p.readOnly ? ', read-only' : '') + ']' + (mgr.isConnected(p.id) ? ' (connected)' : ''));
    const text = [
      'DB Explorer ' + (ext?.packageJSON?.version ?? '?'),
      'VS Code ' + vscode.version + ' — ' + process.platform + ' ' + process.arch + ' — node ' + process.versions.node,
      'Oracle client dir: ' + (vscode.workspace.getConfiguration('dbexplorer').get<string>('oracleClientLibDir') || '(none)'),
      'Connections (' + conns.length + '):',
      ...conns,
      'Last error: ' + (runner.lastErrorText ?? '(none)'),
    ].join('\n');
    await vscode.env.clipboard.writeText(text);
    notify(t('Diagnostic information copied to the clipboard.'));
  });

  reg('dbexplorer.togglePin', async (n?: Node) => {
    const p = profileOf(n);
    if (!p) return;
    await mgr.upsert({ ...p, pinned: !p.pinned || undefined });
    mgr.changed();
  });

  // ---------------------------------------------------------------- vues avancées (masquées par défaut)
  const setAdvanced = (on: boolean) => vscode.commands.executeCommand('setContext', 'dbexplorer.advanced', on);
  void setAdvanced(true);
  reg('dbexplorer.openTools', async () => {
    await setAdvanced(true);
    await vscode.commands.executeCommand('dbexplorer.settingsPanel.focus');
  });
  reg('dbexplorer.openHelp', async () => {
    await setAdvanced(true);
    await vscode.commands.executeCommand('dbexplorer.helpPanel.focus');
  });

  // ------------------------------------------------------------ palette d'actions (usage courant d'abord)
  reg('dbexplorer.actions', async () => {
    type Act = vscode.QuickPickItem & { cmd?: string };
    const items: Act[] = [
      { label: t('Essentials'), kind: vscode.QuickPickItemKind.Separator },
      { label: '$(play) ' + t('Execute the statement'), description: 'Ctrl+Enter', cmd: 'dbexplorer.executeStatement' },
      { label: '$(run-all) ' + t('Execute the whole script'), description: 'F5', cmd: 'dbexplorer.executeScript' },
      { label: '$(new-file) ' + t('New query'), cmd: 'dbexplorer.newEditor' },
      { label: '$(check) Commit', cmd: 'dbexplorer.commit' },
      { label: '$(discard) Rollback', cmd: 'dbexplorer.rollback' },
      { label: '$(debug-stop) ' + t('Cancel query'), cmd: 'dbexplorer.cancel' },
      { label: '$(history) ' + t('SQL history'), cmd: 'dbexplorer.history' },
      { label: '$(symbol-snippet) ' + t('Query template to insert'), cmd: 'dbexplorer.insertSnippet' },
      { label: '$(database) ' + t('Click to switch connection'), cmd: 'dbexplorer.setActive' },
      { label: t('More'), kind: vscode.QuickPickItemKind.Separator },
      { label: '$(graph) ' + t('Show the execution plan'), cmd: 'dbexplorer.explainPlan' },
      { label: '$(lightbulb) ' + t('Suggest optimizations'), cmd: 'dbexplorer.optimize' },
      { label: '$(type-hierarchy) ' + t('Show the query graph'), cmd: 'dbexplorer.queryGraph' },
      { label: '$(copy) ' + t('Duplicate detector: add the key of every table to the SELECT'), cmd: 'dbexplorer.diagnoseDuplicates' },
      { label: '$(arrow-swap) ' + t('Convert comma joins / (+) to ANSI JOIN'), cmd: 'dbexplorer.toAnsiJoin' },
      { label: '$(diff) ' + t('Compare with another query…'), cmd: 'dbexplorer.compareQueries' },
      { label: '$(diff) ' + t('Compare schemas'), cmd: 'dbexplorer.compareSchemas' },
      { label: '$(save) ' + t('Save the selection as a template'), cmd: 'dbexplorer.saveSnippet' },
      { label: '$(symbol-namespace) ' + t('Change schema'), cmd: 'dbexplorer.changeSchema' },
      { label: '$(sync) ' + t('Toggle auto-commit'), cmd: 'dbexplorer.toggleAutoCommit' },
      { label: '$(lock) ' + t('Toggle read-only mode (current connection)'), cmd: 'dbexplorer.toggleReadOnly' },
      { label: '$(search) ' + t('Go to object…'), description: 'Ctrl+Alt+G', cmd: 'dbexplorer.goToObject' },
      { label: '$(tools) ' + t('Tools and settings'), cmd: 'dbexplorer.openTools' },
      { label: '$(question) ' + t('Help'), cmd: 'dbexplorer.openHelp' },
      { label: '$(clippy) ' + t('Copy diagnostic information'), cmd: 'dbexplorer.diagnostics' },
    ];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: t('DB Explorer: choose an action') });
    if (pick?.cmd) await vscode.commands.executeCommand(pick.cmd);
  });

  /**
   * Requête rouverte depuis l'historique : on se reconnecte à la base d'origine (si elle n'est plus connectée) et l'éditeur y est rattaché.
   * Renvoie false si la connexion d'origine n'existe plus ou n'a pas pu être ouverte (l'éditeur garde alors la connexion active).
   */
  const reconnectOrigin = async (doc: vscode.TextDocument, h: { connId?: string; conn?: string }): Promise<boolean> => {
    if (!h.connId) return false;
    if (!mgr.get(h.connId)) {
      vscode.window.showWarningMessage(t('The connection "{0}" of this query no longer exists: the query uses the active connection.', h.conn ?? ''));
      return false;
    }
    if (!mgr.isConnected(h.connId)) {
      await mgr.connect(h.connId);
      if (!mgr.isConnected(h.connId)) return false;
      completion.preload();
    }
    mgr.bind(doc.uri, h.connId);
    mgr.setActive(h.connId);
    return true;
  };

  // ------------------------------------------------------------ historique (sidebar)
  const histOf = (n?: HNode) => (n && n.kind === 'item' ? n.item : undefined);
  reg('dbexplorer.history.open', async (n?: HNode) => {
    const h = histOf(n);
    if (!h) return;
    const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: h.sql.replace(/\s+$/, '') + (/;\s*$/.test(h.sql) || /\/\s*$/.test(h.sql) ? '' : ';') + '\n' });
    await vscode.window.showTextDocument(doc, { preview: false });
    await reconnectOrigin(doc, h);
  });
  const offerOrigin = async (e: vscode.TextEditor, h: { connId?: string; conn?: string }) => {
    if (!h.connId || !mgr.get(h.connId)) return;
    const cur = mgr.forDocument(e.document.uri)?.profile.id;
    if (cur === h.connId) return;
    const yes = t('Use "{0}"', h.conn ?? '');
    const pick = await vscode.window.showInformationMessage(t('This query was run on "{0}".', h.conn ?? ''), yes);
    if (pick === yes) await reconnectOrigin(e.document, h);
  };
  reg('dbexplorer.history.insert', async (n?: HNode) => {
    const h = histOf(n);
    const e = vscode.window.activeTextEditor ?? vscode.window.visibleTextEditors.find((x) => x.document.languageId === 'sql');
    if (!h) return;
    if (!e) return vscode.commands.executeCommand('dbexplorer.history.open', n);
    await e.edit((b) => b.insert(e.selection.active, h.sql + (/;\s*$/.test(h.sql) ? '' : ';') + '\n'));
    await offerOrigin(e, h);
  });
  reg('dbexplorer.history.run', async (n?: HNode) => {
    const h = histOf(n);
    if (!h) return;
    const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: h.sql.replace(/\s+$/, '') + (/;\s*$/.test(h.sql) ? '' : ';') + '\n' });
    const ed = await vscode.window.showTextDocument(doc, { preview: false });
    ed.selection = new vscode.Selection(0, 0, 0, 0);
    if (h.connId && mgr.get(h.connId) && !(await reconnectOrigin(doc, h))) return; // connexion d'origine refusée : on n'exécute pas ailleurs
    await runner.run(ed, 'statement');
  });
  reg('dbexplorer.history.copy', async (n?: HNode) => {
    const h = histOf(n);
    if (h) await vscode.env.clipboard.writeText(h.sql);
  });
  reg('dbexplorer.history.delete', async (n?: HNode) => {
    const h = histOf(n);
    if (h) await runner.deleteHistory(h.ts);
  });
  reg('dbexplorer.history.clear', async () => {
    const ok = await vscode.window.showWarningMessage(t('Clear the whole SQL history?'), { modal: true }, t('Clear'));
    if (ok) await runner.clearHistory();
  });
  const INVALID = '__invalid__';
  const showTreeFilter = () => {
    treeView.description = tree.active ? '🔍 ' + tree.summary() : undefined;
  };
  const applyTreeFilter = (v: string) => {
    tree.setFilter(v);
    showTreeFilter();
  };
  // Filtre du Schema Browser : texte + liste à cocher des types d'objets existants, dans une seule boîte
  reg('dbexplorer.tree.filter', async () => {
    if (!mgr.list().some((p) => mgr.isConnected(p.id))) {
      const v = await vscode.window.showInputBox({ prompt: t('Filter objects by name (substring, or pattern with * ; empty = all)'), value: tree.filter });
      if (v !== undefined) applyTreeFilter(v);
      return;
    }
    const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { type: string }>();
    qp.title = t('Filter the Schema Browser');
    qp.placeholder = t('Name (substring or pattern with *) — then tick the object types — Enter to apply');
    qp.canSelectMany = true;
    qp.matchOnDescription = false;
    qp.value = tree.filter;
    qp.busy = true;
    let text = tree.filter;
    const chosen = new Set(tree.types);
    if (tree.invalidOnly) chosen.add(INVALID);
    qp.onDidChangeValue((v) => (text = v));
    qp.onDidChangeSelection((sel) => {
      chosen.clear();
      for (const i of sel) chosen.add(i.type);
    });
    qp.onDidAccept(() => {
      tree.setTypes([...chosen].filter((x) => x !== INVALID));
      tree.setInvalidOnly(chosen.has(INVALID));
      applyTreeFilter(text);
      qp.hide();
    });
    qp.onDidHide(() => qp.dispose());
    qp.show();
    const types = await tree.existingTypes();
    const items = types.map((x) => ({ label: x.label, description: x.type + (x.count ? ' · ' + x.count : ''), type: x.type, alwaysShow: true }));
    if (mgr.list().some((p) => mgr.isConnected(p.id) && mgr.session(p.id)?.conn.kind === 'oracle')) items.unshift({ label: '$(warning) ' + t('Invalid objects only'), description: 'Oracle', type: INVALID, alwaysShow: true });
    qp.items = items;
    qp.selectedItems = items.filter((i) => chosen.has(i.type));
    qp.busy = false;
  });
  reg('dbexplorer.tree.filterType', () => vscode.commands.executeCommand('dbexplorer.tree.filter'));
  reg('dbexplorer.tree.clearFilter', () => {
    tree.setTypes([]);
    tree.setInvalidOnly(false);
    applyTreeFilter('');
  });
  const toggleInvalid = (on: boolean) => () => {
    tree.setInvalidOnly(on);
    showTreeFilter();
  };
  reg('dbexplorer.tree.invalid', toggleInvalid(true));
  reg('dbexplorer.tree.invalidOff', toggleInvalid(false));

  // Regroupement par schéma (utilisateur) dans le Schema Browser
  const syncGroupContext = () => void vscode.commands.executeCommand('setContext', 'dbexplorer.groupedSchemas', vscode.workspace.getConfiguration('dbexplorer').get<boolean>('groupBySchema', false));
  syncGroupContext();
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('dbexplorer.groupBySchema')) {
        syncGroupContext();
        tree.refresh();
      }
    })
  );
  const setGroup = (on: boolean) => () => vscode.workspace.getConfiguration('dbexplorer').update('groupBySchema', on, vscode.ConfigurationTarget.Global);
  reg('dbexplorer.tree.group', setGroup(true));
  reg('dbexplorer.tree.ungroup', setGroup(false));
  reg('dbexplorer.useSchema', async (n?: Node) => {
    if (!n || n.kind !== 'schema') return;
    const s = mgr.session(n.profile.id);
    if (!s) return;
    mgr.setActive(n.profile.id);
    await s.conn.useSchema(n.name);
    completion.preload();
    mgr.changed();
  });

  // Objets invalides (Oracle) : recompilation d'un objet, ou de tous les invalides d'une catégorie / d'un schéma
  const COMPILABLE = ['PACKAGE', 'PROCEDURE', 'FUNCTION', 'TRIGGER', 'VIEW', 'MATERIALIZED VIEW', 'TYPE', 'SYNONYM'];
  const compileOne = async (conn: import('./drivers/types').DbConn, owner: string, name: string, type: string): Promise<{ ok: boolean; errors: string[]; issues: { type: string; line: number; col: number; text: string; warning: boolean }[] }> => {
    const errors: string[] = [];
    const issues: { type: string; line: number; col: number; text: string; warning: boolean }[] = [];
    try {
      await conn.exec(`ALTER ${type} "${owner}"."${name}" COMPILE`, {}, true);
    } catch (e) {
      const msg = (e as Error).message.trim();
      if (!/ORA-24344/.test(msg)) errors.push(msg); // 24344 = « compilé avec erreurs » : détaillé ci-dessous
    }
    const st = await q(conn, 'SELECT status FROM all_objects WHERE owner = :o AND object_name = :n AND object_type IN (:t, :tb)', { o: owner, n: name, t: type, tb: type + ' BODY' }).catch(() => undefined);
    const ok = !!st && st.rows.length > 0 && st.rows.every((r) => r[0] === 'VALID');
    if (!ok) {
      const er = await q(conn, 'SELECT type, line, position, text, attribute FROM all_errors WHERE owner = :o AND name = :n ORDER BY type, sequence', { o: owner, n: name }, 50).catch(() => undefined);
      for (const r of er?.rows ?? []) {
        errors.push(`${r[0]} ${r[1]}:${r[2]} ${r[3]}`);
        issues.push({ type: String(r[0]), line: Number(r[1]), col: Number(r[2]), text: String(r[3]), warning: r[4] === 'WARNING' });
      }
    }
    return { ok, errors, issues };
  };
  const showCompileLog = (lines: string[]) => {
    for (const l of lines) panel.log(l);
    panel.update({ tab: 'log' });
    panel.reveal();
  };
  reg('dbexplorer.recompile', async (n?: Node) => {
    if (!n || n.kind !== 'obj') return;
    if (mgr.isReadOnly(n.profile.id)) return vscode.window.showWarningMessage(t('"{0}" is read-only.', n.profile.name));
    const s = mgr.session(n.profile.id);
    if (!s) return;
    if (s.conn.kind !== 'oracle' || !COMPILABLE.includes(n.type)) return vscode.window.showInformationMessage(t('Only available for Oracle.'));
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Recompiling {0}…', n.name) }, () => compileOne(s.conn, n.owner, n.name, n.type));
    if (r.ok) notify(t('{0} recompiled: VALID.', n.name));
    else {
      showCompileLog(['✗ ' + t('{0} is still INVALID after recompilation:', n.name), ...r.errors]);
      const firstErr = r.issues.find((i) => !i.warning) ?? r.issues[0];
      const open = t('Open the source at the error');
      void vscode.window
        .showErrorMessage(firstErr ? t('{0}: {1} line {2} — {3}', n.name, firstErr.type, firstErr.line, firstErr.text) : t('{0} is still INVALID: see the Script / Messages tab.', n.name), ...(r.issues.length ? [open] : []))
        .then((x) => {
          if (x === open) void runner.openSourceAtError(s.conn, n.profile.id, n.owner, n.name, n.type, r.issues);
        });
      if (r.issues.length) await runner.openSourceAtError(s.conn, n.profile.id, n.owner, n.name, n.type, r.issues).catch(() => undefined);
    }
    mgr.changed();
  });
  reg('dbexplorer.dropRoutine', async (n?: Node) => {
    if (!n || n.kind !== 'obj') return;
    if (mgr.isReadOnly(n.profile.id)) return vscode.window.showWarningMessage(t('"{0}" is read-only.', n.profile.name));
    const s = mgr.session(n.profile.id);
    if (!s) return;
    const full = n.owner && s.conn.features.schemas ? `${n.owner}.${n.name}` : n.name;
    const go = t('Drop');
    const ok = await vscode.window.showWarningMessage(t('Drop {0} {1}? This cannot be undone.', n.type, full), { modal: true }, go);
    if (ok !== go) return;
    try {
      await s.conn.exec(`DROP ${n.type} ${s.conn.kind === 'oracle' ? `"${n.owner}"."${n.name}"` : full}`, {}, true);
      notify(t('{0} dropped.', full));
    } catch (e) {
      vscode.window.showErrorMessage(t('Could not drop {0}: {1}', full, (e as Error).message));
    }
    completion.invalidate(false);
    mgr.changed();
  });
  reg('dbexplorer.recompileInvalid', async (n?: Node) => {
    if (!n || !('profile' in n)) return;
    if (mgr.isReadOnly(n.profile.id)) return vscode.window.showWarningMessage(t('"{0}" is read-only.', n.profile.name));
    const s = mgr.session(n.profile.id);
    if (!s) return;
    if (s.conn.kind !== 'oracle') return vscode.window.showInformationMessage(t('Only available for Oracle.'));
    const schema = n.kind === 'schema' ? n.name : n.kind === 'cat' ? n.schema ?? s.conn.currentSchema : s.conn.currentSchema;
    const types = n.kind === 'cat' ? [n.type] : COMPILABLE;
    const gather = async () => {
      const out: { name: string; type: string }[] = [];
      for (const type of types.filter((x) => COMPILABLE.includes(x))) for (const o of await s.conn.listObjects(type, schema, 5000).catch(() => [])) if (o.invalid) out.push({ name: o.name, type });
      return out;
    };
    let todo = await gather();
    if (!todo.length) return vscode.window.showInformationMessage(t('No invalid object in {0}.', schema));
    const go = t('Recompile');
    if ((await vscode.window.showWarningMessage(t('Recompile {0} invalid object(s) of {1}?', todo.length, schema), { modal: true }, go)) !== go) return;
    const total = todo.length;
    let remaining: { name: string; type: string; errors: string[] }[] = [];
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Recompiling invalid objects…'), cancellable: true }, async (progress, token) => {
      for (let pass = 0; pass < 2 && todo.length && !token.isCancellationRequested; pass++) {
        // 2 passes : une compilation peut en débloquer une autre (dépendances)
        const next: typeof remaining = [];
        let i = 0;
        for (const o of todo) {
          if (token.isCancellationRequested) break;
          progress.report({ message: `${++i}/${todo.length} — ${o.name}`, increment: 100 / (todo.length * 2) });
          const r = await compileOne(s.conn, schema, o.name, o.type);
          if (!r.ok) next.push({ ...o, errors: r.errors });
        }
        remaining = next;
        todo = next;
      }
    });
    mgr.changed();
    if (!remaining.length) return notify(t('{0} object(s) recompiled: all VALID.', total));
    showCompileLog(['✗ ' + t('{0} object(s) still INVALID:', remaining.length), ...remaining.flatMap((o) => [`  ${o.type} ${o.name}`, ...o.errors.slice(0, 3).map((x) => '      ' + x)])]);
    vscode.window.showWarningMessage(t('{0} recompiled, {1} still invalid: see the Script / Messages tab.', total - remaining.length, remaining.length));
  });

  // Jointures « à l'ancienne » (Oracle : FROM a, b WHERE a.x = b.y(+)) → JOIN ANSI, sur l'instruction courante ou la sélection
  reg('dbexplorer.toAnsiJoin', async () => {
    const e = sqlEditor();
    if (!e) return;
    const doc = e.document;
    const act = mgr.forDocument(doc.uri) ?? mgr.active;
    const dialect = act ? dialectOf(act.session.conn.kind) : 'oracle';
    let start: number;
    let end: number;
    if (!e.selection.isEmpty) {
      start = doc.offsetAt(e.selection.start);
      end = doc.offsetAt(e.selection.end);
    } else {
      const st = statementAt(split(doc.getText(), dialect), doc.offsetAt(e.selection.active));
      if (!st) return vscode.window.showInformationMessage(t('No statement to analyze.'));
      start = st.start;
      end = st.end;
    }
    const range = new vscode.Range(doc.positionAt(start), doc.positionAt(end));
    // colonnes de chaque table (cache de métadonnées) : rattachent « AND TIERS_ID = COMMA_TIERS_ID » à ses tables
    const columnsOf = act
      ? async (table: string) => {
          const clean = table.replace(/"/g, '');
          const [o, tb] = clean.includes('.') ? clean.split('.') : [act.session.conn.currentSchema, clean];
          const cols = await within(metaCache.columns(act.profile.id, o, tb).catch(() => []), 4000);
          return cols === TIMEOUT ? undefined : cols.map((c) => c.name);
        }
      : undefined;
    const r = await toAnsiJoins(doc.getText(range), { columnsOf });
    if (!r.converted) return vscode.window.showInformationMessage(r.skipped ? t('Old-style joins found but they cannot be converted safely (OR in the WHERE, (+) on both sides…).') + (r.reasons.length ? ' — ' + r.reasons[0] : '') : t('No old-style join (comma in FROM) found in this statement.'));
    await e.edit((b) => b.replace(range, r.sql));
    vscode.window.showInformationMessage(t('{0} SELECT converted to ANSI JOIN (Ctrl+Z to undo).', r.converted) + (r.skipped ? ' ' + t('{0} left unchanged.', r.skipped) : '') + (r.cross ? ' ' + t('{0} table(s) without any recognised join condition became CROSS JOIN (columns written without alias are matched through the table metadata).', r.cross) : ''));
  });

  // Comparaison de deux schémas (deux connexions, ou deux schémas d'une même connexion) + script de synchronisation de la cible
  reg('dbexplorer.compareSchemas', async () => {
    const live = mgr.list().filter((p) => mgr.isConnected(p.id));
    if (!live.length) return vscode.window.showWarningMessage(t('Connect to the databases to compare first.'));
    const pickSide = async (title: string, exclude?: { pid: string; schema: string }) => {
      const p = await vscode.window.showQuickPick(
        live.map((x) => ({ label: x.name, description: describeProfile(x), id: x.id })),
        { title, placeHolder: t('Connection') }
      );
      if (!p) return undefined;
      const conn = mgr.session(p.id)!.conn;
      let schema = conn.currentSchema;
      if (conn.features.schemas) {
        const list = await conn.schemas().catch(() => [schema]);
        const s = await vscode.window.showQuickPick(
          list.filter((x) => !(exclude && exclude.pid === p.id && exclude.schema.toLowerCase() === x.toLowerCase())),
          { title, placeHolder: t('Schema') }
        );
        if (!s) return undefined;
        schema = s;
      }
      return { pid: p.id, name: p.label, conn, schema };
    };
    const a = await pickSide(t('Source (the reference)'));
    if (!a) return;
    const b = await pickSide(t('Target (to bring in line with the source)'), { pid: a.pid, schema: a.schema });
    if (!b) return;
    if (a.conn.kind !== b.conn.kind) return vscode.window.showWarningMessage(t('Both connections must use the same DBMS to generate a script.'));
    if (a.pid === b.pid && a.schema.toLowerCase() === b.schema.toLowerCase()) return vscode.window.showWarningMessage(t('Pick two different schemas.'));
    try {
      const script = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Comparing the schemas…') }, async () => {
        const [sa, sb] = await Promise.all([takeSnapshot(a.conn, a.schema), takeSnapshot(b.conn, b.schema)]);
        const d = diffSnapshots(sa, sb);
        return { d, text: await buildSyncScript({ name: a.name, snap: sa, ddl: (type, name) => a.conn.ddl(type, a.schema, name) }, { name: b.name, snap: sb }, d) };
      });
      const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: script.text });
      mgr.bind(doc.uri, b.pid);
      await vscode.window.showTextDocument(doc, { preview: false });
      const d = script.d;
      vscode.window.showInformationMessage(t('{0} object(s) missing in the target, {1} only in the target, {2} table(s) with different columns, {3} identical.', d.onlyA.length, d.onlyB.length, d.changed.length, d.same));
    } catch (e) {
      vscode.window.showErrorMessage((e as Error).message);
    }
  });

  // Doublons d'une table : choix des colonnes, puis requête de synthèse, lignes en double, ou script de suppression (non exécuté)
  reg('dbexplorer.findDuplicates', async (n?: Node) => {
    const fromNode = n && n.kind === 'obj' && (n.type === 'TABLE' || n.type === 'VIEW' || n.type === 'MATERIALIZED VIEW') ? n : undefined;
    const act = fromNode ? { profile: fromNode.profile, session: mgr.session(fromNode.profile.id) } : mgr.active;
    if (!act?.session) return vscode.window.showWarningMessage(t('No active connection.'));
    const pid = act.profile.id;
    const conn = act.session.conn;
    const schema = fromNode ? fromNode.owner : conn.currentSchema;
    let table = fromNode?.name;
    if (!table) {
      const meta = await metaCache.get(pid, schema);
      let names = meta.objects.filter((o) => o.type === 'TABLE').map((o) => o.name);
      if (!names.length) names = await conn.tableNames(schema).catch(() => []);
      const pick = await vscode.window.showQuickPick(names.sort(), { placeHolder: t('Table to check for duplicates') });
      if (!pick) return;
      table = pick;
    }
    const cols = await metaCache.columns(pid, schema, table).catch(() => []);
    const usable = cols.filter((c) => !/lob|long|raw|bytea|xml|json|geometry|bfile|image/i.test(c.type));
    if (!usable.length) return vscode.window.showInformationMessage(t('No usable column found for this table.'));
    const nonPk = usable.filter((c) => !c.pk);
    const picks = await vscode.window.showQuickPick(
      usable.map((c) => ({ label: c.name, description: c.type + (c.pk ? ' · PK' : ''), picked: (nonPk.length ? nonPk : usable).includes(c) })),
      { canPickMany: true, title: t('Duplicates of {0}', table), placeHolder: t('Columns that must be identical (default: all except the primary key)') }
    );
    if (!picks?.length) return;
    const by = picks.map((p) => p.label);
    const mode = await vscode.window.showQuickPick(
      [
        { label: '$(list-flat) ' + t('Summary: one row per duplicated value, with its count'), id: 'summary' },
        { label: '$(list-tree) ' + t('All the rows that have a duplicate, grouped'), id: 'rows' },
        { label: '$(trash) ' + t('Script to delete the duplicates, keeping one row per group (not executed)'), id: 'delete' },
      ],
      { title: t('Duplicates of {0}', table), placeHolder: t('What do you want?') }
    );
    if (!mode) return;
    const full = conn.features.schemas ? `${schema}.${table}` : table;
    const list = by.join(', ');
    let sql: string;
    if (mode.id === 'summary') sql = `SELECT ${list}, COUNT(*) AS DUP_COUNT\n  FROM ${full}\n GROUP BY ${list}\nHAVING COUNT(*) > 1\n ORDER BY DUP_COUNT DESC, ${list}`;
    else if (mode.id === 'rows') sql = `SELECT d.*\n  FROM (SELECT x.*, COUNT(*) OVER (PARTITION BY ${list}) AS DUP_COUNT\n          FROM ${full} x) d\n WHERE d.DUP_COUNT > 1\n ORDER BY ${list}`;
    else {
      const head = `-- ${t('Deletes the duplicates of {0} on ({1}), keeping one row per group.', full, list)}\n-- ${t('Check with the "rows" query first, then run (and commit) at your own risk.')}\n`;
      const pk = usable.filter((c) => c.pk);
      const rid = conn.kind === 'oracle' ? 'ROWID' : conn.kind === 'postgres' ? 'ctid' : conn.kind === 'sqlite' ? 'rowid' : undefined;
      if (rid) sql = `${head}DELETE FROM ${full}\n WHERE ${rid} IN (SELECT rid FROM (SELECT ${rid} AS rid, ROW_NUMBER() OVER (PARTITION BY ${list} ORDER BY ${rid}) AS rn FROM ${full}) r WHERE rn > 1);\n`;
      else if (pk.length === 1) sql = `${head}DELETE t FROM ${full} t\n  JOIN (SELECT MIN(${pk[0].name}) AS keep_id, ${list} FROM ${full} GROUP BY ${list} HAVING COUNT(*) > 1) k\n    ON ${by.map((c) => `t.${c} <=> k.${c}`).join(' AND ')} AND t.${pk[0].name} <> k.keep_id;\n`;
      else sql = `${head}-- ${t('MySQL needs a single-column primary key to pick the row to keep: not available for this table.')}\n`;
    }
    const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: sql + (mode.id === 'delete' ? '' : '\n') });
    mgr.bind(doc.uri, pid);
    const ed = await vscode.window.showTextDocument(doc, { preview: false });
    if (mode.id !== 'delete') {
      ed.selection = new vscode.Selection(0, 0, 0, 0);
      await runner.run(ed, 'statement');
    }
  });

  // Détecteur de doublons d'une requête : la clé de chaque table est ajoutée au SELECT (et un récapitulatif par table est proposé)
  reg('dbexplorer.diagnoseDuplicates', async (arg?: { sql?: string; pid?: string }) => {
    let sql = arg && typeof arg.sql === 'string' ? arg.sql : undefined;
    let pid = arg && typeof arg.pid === 'string' ? arg.pid : undefined;
    if (!sql) {
      const e = sqlEditor();
      if (!e) return;
      sql = runner.statementText(e);
      pid = (mgr.forDocument(e.document.uri) ?? mgr.active)?.profile.id;
    }
    const sess = pid ? mgr.session(pid) : undefined;
    if (!sql || !pid || !sess) return vscode.window.showWarningMessage(t('No statement to analyze.'));
    const conn = sess.conn;
    const built = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Analyzing the query…') }, () =>
      buildDupQueries(sql!, conn.kind, conn.currentSchema, (o, tb) => metaCache.columns(pid!, o, tb))
    );
    if ('error' in built) return vscode.window.showInformationMessage(built.error);
    const modes = [{ label: '$(list-selection) ' + t('Add the key of every table to the SELECT (see which one repeats)'), id: 'ids' }];
    if (built.summary) modes.push({ label: '$(graph) ' + t('Which table multiplies the rows? (summary per table)'), id: 'summary' });
    const mode = modes.length > 1 ? await vscode.window.showQuickPick(modes, { title: t('Duplicate detector'), placeHolder: t('What do you want?') }) : modes[0];
    if (!mode) return;
    const head =
      mode.id === 'ids'
        ? `-- ${t('Key of every table added to the SELECT: for identical rows (DUP_COUNT > 1), the key that changes is the table that repeats them.')}\n`
        : `-- ${t('REPEATED_GROUPS > 0: this table gives several rows for the same rows of the other tables, so it multiplies your result (missing or too loose join condition).')}\n`;
    const body = (mode.id === 'ids' ? built.ids : built.summary!) + '\n';
    const notes = built.notes.map((x) => '-- ' + x + '\n').join('');
    const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: head + notes + body });
    mgr.bind(doc.uri, pid);
    const ed = await vscode.window.showTextDocument(doc, { preview: false });
    ed.selection = new vscode.Selection(0, 0, 0, 0);
    await runner.run(ed, 'statement');
  });
  panel.onDupDiagnose = () => void vscode.commands.executeCommand('dbexplorer.diagnoseDuplicates', { sql: runner.currentTrailSql(), pid: runner.resultProfileId() });

  // Impact / lineage : qui utilise cet objet ? / qu'utilise-t-il ?
  const lineage = (dir: 'usedBy' | 'uses') => async (n?: Node) => {
    if (!n || n.kind !== 'obj') return vscode.window.showInformationMessage(t('Right-click an object in the Schema Browser.'));
    const sess = mgr.session(n.profile.id);
    if (!sess) return;
    const g = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Searching dependencies…') }, () =>
      buildLineage(sess.conn, metaCache, n.profile.id, n.owner, n.name, n.type, dir)
    );
    showGraph(g);
  };
  reg('dbexplorer.usedBy', lineage('usedBy'));
  reg('dbexplorer.usesWhat', lineage('uses'));

  // Diagramme ER : la table choisie (menu de l'arbre) ou une sélection de tables, avec leurs voisines par clés étrangères
  reg('dbexplorer.erDiagram', async (n?: Node) => {
    const fromNode = n && n.kind === 'obj' ? n : undefined;
    const act = fromNode ? { profile: fromNode.profile, session: mgr.session(fromNode.profile.id) } : mgr.active;
    if (!act?.session) return vscode.window.showWarningMessage(t('No active connection.'));
    const pid = act.profile.id;
    const schema = fromNode ? fromNode.owner : act.session.conn.currentSchema;
    let tables: string[];
    if (fromNode) tables = [fromNode.name];
    else {
      const meta = await metaCache.get(pid, schema);
      let names = meta.objects.filter((o) => o.type === 'TABLE').map((o) => o.name);
      if (!names.length) names = await act.session.conn.tableNames(schema).catch(() => []);
      if (!names.length) return vscode.window.showInformationMessage(t('No table found.'));
      const picks = await vscode.window.showQuickPick(names.sort().map((label) => ({ label })), { canPickMany: true, matchOnDescription: true, placeHolder: t('Tables of the ER diagram (check the ones to show, their linked tables are added)') });
      if (!picks?.length) return;
      tables = picks.map((p) => p.label);
    }
    const g = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Building the ER diagram…') }, () => buildErGraph(metaCache, pid, schema, tables, 1));
    showGraph(g);
  });

  // Ctrl+clic sur une clé dans la grille : ligne parente (clé étrangère) ou lignes enfants (clé référencée), dans un nouvel éditeur exécuté
  panel.onEdits = (edits) => runner.applyEdits(edits);
  panel.onCrumb = (i) => void runner.gotoCrumb(i);
  panel.onCrumbSql = () => void runner.openTrailSql();
  panel.onFollow = async (links, vals, newEditor, choose) => {
    const pid = runner.resultProfileId();
    const sess = pid ? mgr.session(pid) : undefined;
    if (!pid || !sess || !links?.length) return;
    // lien suivi automatiquement d'après la requête affichée (clé étrangère → ligne parente, sinon lignes enfants) ; Alt+Ctrl+clic = choisir
    let link = pickLink(links, tablesOf(runner.currentTrailSql() ?? ''));
    if (choose && links.length > 1) {
      const pick = await vscode.window.showQuickPick(
        links.map((l) => ({ label: (l.k === 'p' ? '$(arrow-up) ' + t('Parent row') : '$(arrow-down) ' + t('Child rows')) + ' — ' + l.t, description: l.tc.join(', '), l })),
        { placeHolder: t('Follow which link?') }
      );
      if (!pick) return;
      link = pick.l;
    }
    const q = linkQuery(link, vals, sess.conn);
    if (!q) return vscode.window.showInformationMessage(t('NULL key: nothing to follow.'));
    if (newEditor) {
      // Maj+Ctrl+clic : dans un nouvel éditeur
      const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: q.sql });
      mgr.bind(doc.uri, pid);
      const ed = await vscode.window.showTextDocument(doc, { preview: false });
      await runner.run(ed, 'statement');
      return;
    }
    await runner.followSql(pid, q.sql, q.label);
  };

  // Graphe de la requête courante (tables, jointures, sous-requêtes)
  reg('dbexplorer.queryGraph', () => {
    const e = sqlEditor();
    if (!e) return;
    const sql = runner.statementText(e);
    if (!sql) return vscode.window.showInformationMessage(t('No statement to analyze.'));
    showGraph(buildQueryGraph(sql));
  });
  // Graphe des appels d'un package / d'une procédure / d'une fonction (menu de l'arbre, ou source ouvert dans l'éditeur)
  reg('dbexplorer.callGraph', async (n?: Node) => {
    try {
      if (n && n.kind === 'obj') {
        const sess = mgr.session(n.profile.id);
        if (!sess) return;
        const src = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Reading the source…') }, () => sess.conn.ddl(n.type, n.owner, n.name));
        return showGraph(buildCallGraph(src, n.name));
      }
      const text = vscode.window.activeTextEditor?.document.getText() ?? '';
      const nameRe = [/\bpackage\s+body\s+(?:"?[\w$#]+"?\.)?"?([\w$#]+)"?/i, /\bpackage\s+(?:"?[\w$#]+"?\.)?"?([\w$#]+)"?/i, /\b(?:procedure|function)\s+(?:"?[\w$#]+"?\.)?"?([\w$#]+)"?/i];
      for (const re of nameRe) {
        const m = re.exec(text);
        if (m) return showGraph(buildCallGraph(text, m[1]));
      }
      vscode.window.showInformationMessage(t('Open a package / procedure / function source, or use the Schema Browser context menu.'));
    } catch (e) {
      vscode.window.showErrorMessage((e as Error).message);
    }
  });
  // ------------------------------------------------------- favoris (requêtes enregistrées)
  const favOf = (n?: FNode): Favorite | undefined => (n?.kind === 'fav' ? n.fav : undefined);
  const favText = (f: Favorite) => f.sql.replace(/\s+$/, '') + (/;\s*$/.test(f.sql) || /\/\s*$/.test(f.sql) ? '' : ';') + '\n';
  const openFav = async (f: Favorite) => {
    const pid = f.pid && mgr.isConnected(f.pid) ? f.pid : mgr.activeProfileId;
    const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: favText(f) });
    if (pid) mgr.bind(doc.uri, pid);
    return vscode.window.showTextDocument(doc, { preview: false });
  };
  reg('dbexplorer.favorite.add', async () => {
    const e = vscode.window.activeTextEditor;
    const sql = e && e.document.languageId === 'sql' ? runner.statementText(e) : undefined;
    if (!sql) return vscode.window.showInformationMessage(t('Put the cursor in a SQL statement (or select it) to save it as a favorite.'));
    const first = sql.replace(/\s+/g, ' ').trim();
    const name = await vscode.window.showInputBox({ prompt: t('Favorite name'), value: first.length > 40 ? first.slice(0, 40) + '…' : first });
    if (!name) return;
    const act = (e && mgr.forDocument(e.document.uri)) ?? mgr.active;
    let pid: string | undefined;
    if (act) {
      const scope = await vscode.window.showQuickPick(
        [
          { label: '$(database) ' + t('This connection only ({0})', act.profile.name), pid: act.profile.id },
          { label: '$(globe) ' + t('All connections'), pid: undefined as string | undefined },
        ],
        { placeHolder: t('Available for…') }
      );
      if (!scope) return;
      pid = scope.pid;
    }
    await favorites.add(name, sql, pid);
    notify(t('Saved in the Favorites view.'));
  });
  reg('dbexplorer.favorite.open', async (n?: FNode) => {
    const f = favOf(n);
    if (f) await openFav(f);
  });
  reg('dbexplorer.favorite.run', async (n?: FNode) => {
    const f = favOf(n);
    if (!f) return;
    const ed = await openFav(f);
    ed.selection = new vscode.Selection(0, 0, 0, 0);
    await runner.run(ed, 'statement');
  });
  reg('dbexplorer.favorite.rename', async (n?: FNode) => {
    const f = favOf(n);
    if (!f) return;
    const name = await vscode.window.showInputBox({ prompt: t('Favorite name'), value: f.name });
    if (name) await favorites.rename(f.id, name);
  });
  reg('dbexplorer.favorite.delete', async (n?: FNode) => {
    const f = favOf(n);
    if (f) await favorites.remove(f.id);
  });
  // liste rapide (palette / Tools) : favoris de la connexion active + ceux de toutes les connexions, insérés dans l'éditeur
  reg('dbexplorer.favorite.insert', async (n?: FNode) => {
    const f = favOf(n);
    if (!f) return;
    const e = vscode.window.activeTextEditor;
    if (e && e.document.languageId === 'sql') await e.edit((b) => b.insert(e.selection.active, favText(f)));
    else await openFav(f);
  });
  reg('dbexplorer.favorite.pick', async () => {
    const list = favorites.forConnection(mgr.activeProfileId);
    if (!list.length) return vscode.window.showInformationMessage(t('No favorite yet: use "Save as favorite" in a SQL editor.'));
    const pick = await vscode.window.showQuickPick(
      list.map((f) => ({ label: '$(star-full) ' + f.name, description: f.sql.replace(/\s+/g, ' ').slice(0, 80), f })),
      { placeHolder: t('Favorite queries'), matchOnDescription: true }
    );
    if (!pick) return;
    const e = vscode.window.activeTextEditor;
    if (e && e.document.languageId === 'sql') await e.edit((b) => b.insert(e.selection.active, favText(pick.f)));
    else await openFav(pick.f);
  });

  // ------------------------------------------------------- actions de l'arbre
  reg('dbexplorer.openDdl', async (n: Node) => {
    if (n.kind !== 'obj') return;
    const s = mgr.session(n.profile.id);
    if (!s) return;
    try {
      const ddl = await s.conn.ddl(n.type, n.owner, n.name);
      const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: ddl });
      mgr.bind(doc.uri, n.profile.id);
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch (e) {
      vscode.window.showErrorMessage(t('DDL unavailable: {0}', (e as Error).message));
    }
  });
  reg('dbexplorer.selectData', async (n: Node) => {
    if (n.kind !== 'obj') return;
    mgr.setActive(n.profile.id);
    const q = n.profile.type === 'mysql' ? '`' : '"';
    const ident = (s: string) => (n.profile.type === 'oracle' ? s : `${q}${s}${q}`);
    const full = n.profile.type === 'sqlite' ? ident(n.name) : `${ident(n.owner)}.${ident(n.name)}`;
    const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: `SELECT *\n  FROM ${full};\n` });
    const ed = await vscode.window.showTextDocument(doc);
    await runner.run(ed, 'statement');
  });
  reg('dbexplorer.describeObject', async (n: Node) => {
    if (n.kind !== 'obj') return;
    mgr.setActive(n.profile.id);
    const sess = mgr.session(n.profile.id);
    if (sess) DescribePanel.open(n.profile.id, sess.conn, { type: n.type, schema: n.owner, name: n.name });
  });
  // Exécuter une procédure / fonction / un membre de package avec la fenêtre de paramètres (Oracle)
  reg('dbexplorer.runRoutine', async (n: Node) => {
    if (n.kind !== 'obj') return;
    const sess = mgr.session(n.profile.id);
    if (!sess) return;
    const conn = sess.conn;
    if (conn.kind !== 'oracle') return vscode.window.showInformationMessage(t('Only available for Oracle.'));
    mgr.setActive(n.profile.id);
    try {
      let pkg: string | undefined;
      let member = n.name;
      if (n.type === 'PACKAGE') {
        pkg = n.name;
        const list = await q(conn, 'SELECT procedure_name FROM all_procedures WHERE owner=:o AND object_name=:p AND procedure_name IS NOT NULL ORDER BY subprogram_id', { o: n.owner, p: n.name });
        const names = [...new Set(list.rows.map((r) => String(r[0])))];
        if (!names.length) return vscode.window.showWarningMessage(t('No procedure or function in this package.'));
        const pick = await vscode.window.showQuickPick(names, { placeHolder: t('Procedure / function to execute') });
        if (!pick) return;
        member = pick;
      }
      const args = await q(
        conn,
        'SELECT argument_name, position, data_type, in_out, overload FROM all_arguments WHERE owner=:o AND data_level=0 AND object_name=:m AND ' +
          (pkg ? 'package_name=:p' : 'package_name IS NULL') +
          " ORDER BY NVL(overload,'0'), sequence",
        pkg ? { o: n.owner, m: member, p: pkg } : { o: n.owner, m: member }
      );
      const firstOv = args.rows[0]?.[4] ?? null;
      const rows = args.rows.filter((r) => (r[4] ?? null) === firstOv);
      const ident = (x: string) => (/^[A-Z][A-Z0-9_$#]*$/.test(x) ? x : '"' + x.replace(/"/g, '""') + '"');
      const full = [n.owner, pkg, member].filter(Boolean).map((x) => ident(String(x))).join('.');
      const typeOf = (dt: string): BindDef['type'] =>
        /REF CURSOR|REFCURSOR/i.test(dt) ? 'cursor' : /^(NUMBER|INTEGER|FLOAT|BINARY_|PLS_INTEGER|SIMPLE_INTEGER|NATURAL|POSITIVE|LONG)/i.test(dt) ? 'number' : /^(DATE|TIMESTAMP)/i.test(dt) ? 'date' : /CLOB/i.test(dt) ? 'clob' : 'string';
      const presets = new Map<string, Partial<BindDef>>();
      const used = new Set<string>();
      const callArgs: string[] = [];
      let ret = '';
      for (const r of rows) {
        const aname = r[0] === null ? '' : String(r[0]);
        const dt = String(r[2] ?? '');
        const io = String(r[3] ?? 'IN');
        const dir: BindDef['dir'] = io === 'OUT' ? 'out' : io === 'IN/OUT' ? 'inout' : 'in';
        if (!aname && Number(r[1]) === 0) {
          ret = 'result';
          presets.set('result', { dir: 'out', type: typeOf(dt) });
          used.add('result');
          continue;
        }
        if (!aname) continue;
        let b = aname.toLowerCase().replace(/[^\w$#]/g, '_');
        if (!/^[a-z_]/.test(b)) b = 'p_' + b;
        while (used.has(b)) b += '_';
        used.add(b);
        presets.set(b, { dir, type: typeOf(dt), val: null });
        callArgs.push(ident(aname) + ' => :' + b);
      }
      const call = full + (callArgs.length ? '(\n    ' + callArgs.join(',\n    ') + '\n  )' : '');
      const text = 'BEGIN\n  ' + (ret ? ':result := ' : '') + call + ';\nEND;\n';
      const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: text });
      const ed = await vscode.window.showTextDocument(doc, { preview: false });
      ed.selection = new vscode.Selection(0, 0, 0, 0);
      runner.presets = presets;
      try {
        await runner.run(ed, 'statement');
      } finally {
        runner.presets = undefined;
      }
    } catch (e) {
      vscode.window.showErrorMessage(t('Cannot execute: {0}', (e as Error).message));
    }
  });
  // Déclenche l'aide à la saisie avec un raccourci propre (Ctrl+Espace est souvent pris par le système / la méthode de saisie)
  reg('dbexplorer.suggest', () => vscode.commands.executeCommand('editor.action.triggerSuggest'));

  // Après Entrée (FROM⏎, JOIN⏎, WHERE⏎, virgule⏎…) : VS Code ne rouvre pas l'aide tout seul
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || ed.document !== e.document || e.document.languageId !== 'sql' || e.contentChanges.length !== 1) return;
      if (!/^\r?\n[ \t]*$/.test(e.contentChanges[0].text)) return;
      setTimeout(() => {
        const cur = vscode.window.activeTextEditor;
        if (!cur || cur.document !== e.document) return;
        if (completion.wantsAutoSuggest(cur.document, cur.selection.active)) {
          completion.autoTrigger = true;
          void vscode.commands.executeCommand('editor.action.triggerSuggest');
        }
      }, 40);
    })
  );

  reg('dbexplorer.exportResults', () => runner.exportResults());

  // Optimisation de la requête courante (règles par SGBD + index réels + plan d'exécution)
  reg('dbexplorer.optimize', async () => {
    const e = sqlEditor();
    if (!e) return;
    const act = await mgr.requireFor(e.document.uri);
    if (!act) return;
    const sql = runner.statementText(e);
    if (!sql) return vscode.window.showInformationMessage(t('No statement to analyze.'));
    const report = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Analyzing the query…') }, () => analyzeQuery(sql, act.session.conn));
    showOptimization(report, KIND_LABELS[act.profile.type]);
  });

  // Comparer la requête courante avec une autre : différences de texte, ou différences de résultats
  reg('dbexplorer.compareQueries', async () => {
    const e = sqlEditor();
    if (!e) return;
    const a = runner.statementText(e);
    if (!a) return vscode.window.showInformationMessage(t('No statement to analyze.'));
    const mode = await vscode.window.showQuickPick(
      [
        { label: '$(diff) ' + t('Compare the SQL text (side by side)'), id: 'text' },
        { label: '$(table) ' + t('Compare the rows returned by both queries'), id: 'rows' },
      ],
      { placeHolder: t('What do you want to compare?') }
    );
    if (!mode) return;
    type Src = vscode.QuickPickItem & { id: 'clip' | 'editor' | 'history' | 'file' };
    const src = await vscode.window.showQuickPick<Src>(
      [
        { label: '$(clippy) ' + t('Clipboard'), id: 'clip' },
        { label: '$(file-code) ' + t('Another SQL editor…'), id: 'editor' },
        { label: '$(history) ' + t('SQL history…'), id: 'history' },
        { label: '$(go-to-file) ' + t('A file…'), id: 'file' },
      ],
      { placeHolder: t('Compare with…') }
    );
    if (!src) return;
    let b: string | undefined;
    if (src.id === 'clip') b = await vscode.env.clipboard.readText();
    else if (src.id === 'editor') {
      const docs = vscode.workspace.textDocuments.filter((d) => d.languageId === 'sql' && d !== e.document && !d.isClosed);
      if (!docs.length) return vscode.window.showInformationMessage(t('No other SQL editor is open.'));
      const pick = await vscode.window.showQuickPick(docs.map((d) => ({ label: d.fileName.split(/[\\/]/).pop() ?? d.fileName, description: d.getText().replace(/\s+/g, ' ').slice(0, 80), doc: d })), { placeHolder: t('Choose the editor') });
      if (!pick) return;
      const ed = vscode.window.visibleTextEditors.find((x) => x.document === pick.doc);
      b = ed ? runner.statementText(ed) : pick.doc.getText();
    } else if (src.id === 'history') {
      const h = runner.history;
      if (!h.length) return vscode.window.showInformationMessage(t('History is empty.'));
      const pick = await vscode.window.showQuickPick(h.map((x) => ({ label: x.sql.replace(/\s+/g, ' ').slice(0, 100), description: new Date(x.ts).toLocaleString(), sql: x.sql })), { placeHolder: t('SQL history'), matchOnDescription: true });
      if (!pick) return;
      b = pick.sql;
    } else {
      const sel = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { SQL: ['sql', 'pks', 'pkb', 'prc', 'fnc', 'trg', 'txt'] } });
      if (!sel?.[0]) return;
      b = Buffer.from(await vscode.workspace.fs.readFile(sel[0])).toString('utf8');
    }
    if (!b?.trim()) return vscode.window.showWarningMessage(t('The second query is empty.'));
    if (mode.id === 'text') {
      const fmt = await vscode.window.showQuickPick(
        [
          { label: t('Format both queries first (ignore spaces and keyword case)'), v: true },
          { label: t('Compare the text exactly as written'), v: false },
        ],
        { placeHolder: t('Comparison') }
      );
      if (!fmt) return;
      const left = await vscode.workspace.openTextDocument({ language: 'sql', content: fmt.v ? prettySql(a) : a });
      const right = await vscode.workspace.openTextDocument({ language: 'sql', content: fmt.v ? prettySql(b) : b });
      await vscode.commands.executeCommand('vscode.diff', left.uri, right.uri, t('Query A ↔ Query B'));
    } else {
      const act = await mgr.requireFor(e.document.uri);
      if (!act) return;
      const sa = a.replace(/;\s*$/, '');
      const sb = b.trim().replace(/;\s*$/, '');
      if (/(^|[^:\w]):[A-Za-z_]\w*/.test(sa.replace(/'(?:[^']|'')*'/g, '')) || /(^|[^:\w]):[A-Za-z_]\w*/.test(sb.replace(/'(?:[^']|'')*'/g, ''))) {
        return vscode.window.showWarningMessage(t('Replace the bind variables by values before comparing results.'));
      }
      await runner.compareResults(act.session.conn, sa, sb);
    }
  });

  // Déconnexion rapide
  reg('dbexplorer.disconnectAll', async () => {
    for (const x of mgr.list()) if (mgr.isConnected(x.id) && (await settleDirty(x.id))) await mgr.disconnect(x.id);
  });

  // Commenter / décommenter (lignes : --, bloc : /* */) — le langage SQL fournit les délimiteurs
  reg('dbexplorer.toggleComment', () => vscode.commands.executeCommand('editor.action.commentLine'));
  reg('dbexplorer.toggleBlockComment', () => vscode.commands.executeCommand('editor.action.blockComment'));

  // Importe des connexions Oracle depuis un tnsnames.ora détecté (ou choisi) sur la machine
  reg('dbexplorer.importTns', async () => {
    const folders = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath);
    let dirs = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Looking for tnsnames.ora…') }, () => detectTnsDirs(folders));
    if (!dirs.length) {
      const act = await vscode.window.showInformationMessage(t('No tnsnames.ora found on this machine.'), t('Choose folder…'));
      if (!act) return;
      const sel = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: t('Folder containing tnsnames.ora') });
      if (!sel?.[0]) return;
      if (!fs.existsSync(path.join(sel[0].fsPath, 'tnsnames.ora'))) return vscode.window.showWarningMessage(t('tnsnames.ora not found in this folder.'));
      dirs = [sel[0].fsPath];
    }
    type It = vscode.QuickPickItem & { alias?: string; dir?: string };
    const items: It[] = [];
    const have = new Set(mgr.list().filter((x) => x.type === 'oracle').map((x) => `${x.connectString}|${(x.tnsAdmin ?? '').toLowerCase()}`));
    for (const d of dirs) {
      items.push({ label: d, kind: vscode.QuickPickItemKind.Separator });
      for (const al of listTnsAliases(d)) items.push({ label: al, description: have.has(`${al}|${d.toLowerCase()}`) ? t('already added') : undefined, alias: al, dir: d });
    }
    const picked = ((await vscode.window.showQuickPick(items, { canPickMany: true, placeHolder: t('Select the Oracle connections to create'), matchOnDescription: true })) ?? []).filter((x) => x.alias && !x.description);
    if (!picked.length) return;
    const user = await vscode.window.showInputBox({
      prompt: t('Oracle user for these connections (the password is asked on connect)'),
      value: ctx.globalState.get<string>('dbexplorer.lastOracleUser', ''),
      ignoreFocusOut: true,
    });
    if (user === undefined) return;
    void ctx.globalState.update('dbexplorer.lastOracleUser', user);
    const used = mgr.list().map((x) => x.color);
    let first: string | undefined;
    for (const x of picked) {
      const color = nextColor(used);
      used.push(color);
      const id = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
      first ??= id;
      await mgr.upsert({ id, name: x.alias!, type: 'oracle', user, connectString: x.alias, tnsAdmin: x.dir, role: 'DEFAULT', color });
    }
    const go = await vscode.window.showInformationMessage(t('{0} connection(s) created from tnsnames.ora.', picked.length), t('Connect to the first one'));
    if (go && first) await mgr.connect(first);
  });

  // Aucune connexion Oracle : on propose d'importer le tnsnames.ora détecté
  setTimeout(async () => {
    if (mgr.list().some((x) => x.type === 'oracle') || ctx.globalState.get<boolean>('dbexplorer.tnsPromptDismissed')) return;
    const dirs = await detectTnsDirs(vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath)).catch(() => [] as string[]);
    if (!dirs.length) return;
    const count = dirs.reduce((sum, d) => sum + listTnsAliases(d).length, 0);
    const pick = await vscode.window.showInformationMessage(t('tnsnames.ora detected ({0} aliases). Import Oracle connections?', count), t('Import'), t("Don't ask again"));
    if (pick === t('Import')) void vscode.commands.executeCommand('dbexplorer.importTns');
    else if (pick === t("Don't ask again")) void ctx.globalState.update('dbexplorer.tnsPromptDismissed', true);
  }, 4000);

  reg('dbexplorer.copyName', async (n: Node) => {
    if (n.kind === 'obj') await vscode.env.clipboard.writeText(n.profile.type === 'sqlite' ? n.name : `${n.owner}.${n.name}`);
  });

  const version = String(ctx.extension.packageJSON.version);
  if (ctx.globalState.get<string>('dbexplorer.lastVersion') !== version) {
    void ctx.globalState.update('dbexplorer.lastVersion', version);
    void vscode.window.showInformationMessage(t("DB Explorer {0}: see what's new.", version), t("See what's new")).then((a) => {
      if (a) void vscode.commands.executeCommand(HelpView.viewId + '.focus');
    });
  }

  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SettingsView.viewId, settings),
    vscode.window.registerWebviewViewProvider(LibraryView.viewId, new LibraryView(runner, favorites, mgr)),
    vscode.languages.registerCodeActionsProvider({ language: 'sql' }, new SqlCodeActions(mgr, metaCache), { providedCodeActionKinds: SqlCodeActions.kinds }),
    vscode.window.registerWebviewViewProvider(SetupView.viewId, setup),
    vscode.window.registerWebviewViewProvider(HelpView.viewId, help),
    vscode.window.registerWebviewViewProvider(ResultsPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.languages.registerCompletionItemProvider({ language: 'sql' }, completion, '.', ' '),
    vscode.languages.registerHoverProvider({ language: 'sql' }, completion),
    vscode.languages.registerDocumentLinkProvider({ language: 'sql' }, new ObjectLinks(mgr, completion.routines)),
    status,
    acStatus,
    schemaStatus,
    { dispose: () => runner.dispose() },
  );
}

/** Fermeture / rechargement de VS Code : annule les transactions en cours et déconnecte tout. */
export async function deactivate() {
  await manager?.shutdown();
}
