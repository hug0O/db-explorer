import { t } from './i18n';
import * as vscode from 'vscode';
import { within, TIMEOUT } from './metaCache';
import type { MetaCache } from './metaCache';
import { planWrite } from './writePreview';
import { literal } from './exporters';
import { maskText, parseRefList } from './completion';
import { analyzeError, closest } from './errorHints';
import { DIAG_SOURCE } from './inlineErrors';
import { keyFlags } from './keyFlags';
import * as fs from 'fs';
import { ConnectionManager, Session } from './connections';
import { ResultsPanel, GridData, SummaryRow, PanelState } from './resultsPanel';
import { split, statementAt, findBinds, cleanSql, Stmt, Dialect } from './splitter';
import { BindSpec, DbConn, DbKind, ResultCursor, isProd } from './drivers/types';
import { createWriter, ExportFormat, FORMATS } from './exporters';
import type { FilterCrit, GridView } from './resultsPanel';
import { askParams, BindDef } from './views/paramsDialog';

export interface HistoryItem {
  /** id de la connexion (pour réactiver la bonne connexion à l'exécution). */
  connId?: string;
  sql: string;
  ts: number;
  conn: string;
  ms: number;
  ok: boolean;
}

interface Cursor {
  rs?: ResultCursor;
  sql: string;
  binds: Record<string, unknown>;
  profileId: string;
}

/** Devine direction et type d'un bind dans un bloc PL/SQL (ex. :r := f(); OPEN :c FOR …). */
function guessBind(sql: string, name: string): { dir: BindSpec['dir']; type: BindSpec['type'] } {
  const e = name.replace(/[$#]/g, '\\$&');
  if (new RegExp('\\bopen\\s+:' + e + '\\b', 'i').test(sql)) return { dir: 'out', type: 'cursor' };
  const assigned = new RegExp(':' + e + '\\b\\s*:=', 'i').test(sql) || new RegExp('\\binto\\s+:' + e + '\\b', 'i').test(sql);
  if (!assigned) return { dir: 'in', type: 'string' };
  const uses = (sql.match(new RegExp(':' + e + '\\b', 'gi')) ?? []).length;
  return { dir: uses > 1 ? 'inout' : 'out', type: 'string' };
}

export function dialectOf(kind: DbKind): Dialect {
  return kind === 'oracle' ? 'oracle' : kind === 'postgres' ? 'plain' : 'blocks';
}

export class Runner {
  private cursor?: Cursor;
  private last?: Cursor;
  /** Requête d'origine de la grille (sans tri ni filtre) : base des vues triées / filtrées. */
  private base?: Cursor;
  private running = false;
  /** Connexion sur laquelle tourne l'exécution en cours (celle de l'éditeur, pas forcément la connexion active). */
  private currentConn?: DbConn;
  private cancelRequested = false;
  private readonly runningEmitter = new vscode.EventEmitter<boolean>();
  readonly onDidChangeRunning = this.runningEmitter.event;

  private setRunning(v: boolean) {
    this.runningEmitter.fire(v);
    void vscode.commands.executeCommand('setContext', 'dbexplorer.running', v);
  }
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('dbexplorer');
  /** Récapitulatif du script en cours / du dernier script (une ligne par instruction). */
  private summary: SummaryRow[] = [];
  /** Lignes affectées / lues par l'instruction en cours (pour le récapitulatif). */
  private stmtRows?: number;
  /** La dernière erreur indique une connexion perdue. */
  private lostConn = false;
  private lastErrMsg?: string;
  /** Dernier message d'erreur complet (informations de diagnostic). */
  lastErrorText?: string;
  /** Éditeur dont la requête s'exécute : ses résultats lui sont rattachés. */
  private curDoc?: string;
  private tag(d: vscode.Diagnostic) {
    d.source = DIAG_SOURCE;
    return d;
  }
  /** Une ligne retouchée (ou une ligne plus bas, dont la position change) n'a plus son erreur d'exécution. */
  forgetDiagnostics(uri: vscode.Uri, fromLine: number, _toLine: number) {
    const list = this.diagnostics.get(uri);
    if (!list?.length) return;
    const keep = list.filter((d) => d.range.end.line < fromLine);
    if (keep.length !== list.length) this.diagnostics.set(uri, keep);
  }
  private addDiag(doc: vscode.TextDocument, d: vscode.Diagnostic) {
    d.source = DIAG_SOURCE;
    this.diagnostics.set(doc.uri, [...(this.diagnostics.get(doc.uri) ?? []), d]);
  }
  /** Valeurs préremplies pour la prochaine exécution (ex. « Exécuter la procédure »). */
  presets?: Map<string, Partial<BindDef>>;
  private lastCompileSql?: string;
  /** Exécute une requête de navigation (ligne parente / enfants) directement dans la grille et ajoute une étape au fil d'Ariane. */
  async followSql(pid: string, sql: string, label: string) {
    const prev = this.trail;
    await this.showStep(pid, sql, {}, label, () => (this.trail = [...prev, { label, sql, pid, binds: {} }]), () => (this.trail = prev));
  }

  /** Retour à une étape du fil d'Ariane (la requête est ré-exécutée : données à jour, tri / pagination / édition cohérents). */
  async gotoCrumb(index: number) {
    const c = this.trail[index];
    if (!c || index === this.trail.length - 1 || this.running) return;
    if (c.grid) {
      // résultat déjà chargé : on le réaffiche tel quel, sans relancer la requête
      await this.closeCursor();
      this.trail = this.trail.slice(0, index + 1);
      this.base = this.last = { sql: c.sql, binds: c.binds, profileId: c.pid };
      this.editCtx = c.edit;
      this.pendingMore = c.grid.hasMore ? { sql: c.sql, binds: c.binds, profileId: c.pid, skip: c.grid.rows.length } : undefined;
      const labels = this.trail.map((x) => x.label);
      c.grid.trail = labels.length > 1 ? labels : undefined;
      this.panel.update({ grid: c.grid, tab: 'grid' });
      return;
    }
    const prev = this.trail;
    await this.showStep(c.pid, c.sql, c.binds, c.label, () => (this.trail = prev.slice(0, index + 1)), () => (this.trail = prev));
  }

  /** Requête de l'étape courante du fil d'Ariane. */
  currentTrailSql(): string | undefined {
    return this.trail[this.trail.length - 1]?.sql;
  }

  /** Ouvre dans un éditeur SQL la requête de l'étape courante du fil d'Ariane. */
  async openTrailSql() {
    const c = this.trail[this.trail.length - 1];
    if (!c) return;
    const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: c.sql + ';\n' });
    this.mgr.bind(doc.uri, c.pid);
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  private async showStep(pid: string, sql: string, binds: Record<string, unknown>, label: string, apply: () => void, undo: () => void) {
    const session = this.mgr.session(pid);
    if (!session || this.running) return;
    this.running = true;
    this.currentConn = session.conn;
    this.cancelRequested = false;
    this.setRunning(true);
    session.busy = true;
    session.lastActivity = Date.now();
    this.panel.setBusy(true, label);
    try {
      await this.closeCursor();
      apply();
      await this.runQuery(sql, binds, session, pid, label, Date.now(), 'keep');
      this.panel.update({ tab: 'grid' });
    } catch (e) {
      undo();
      this.panel.log('✗ ' + label);
      this.panel.log((e as Error).message.trim());
      this.panel.update({ tab: 'log' });
    } finally {
      this.running = false;
      this.currentConn = undefined;
      this.setRunning(false);
      session.busy = false;
      session.lastActivity = Date.now();
      this.panel.setBusy(false);
      this.mgr.changed();
    }
  }

  /** Table éditable du résultat affiché (édition en grille). */
  private editCtx?: { pid: string; table: string; pkNames: string[]; columns: string[] };

  /** Connexion du résultat affiché dans la grille. */
  resultProfileId(): string | undefined {
    return (this.base ?? this.last)?.profileId;
  }

  /** Cache de métadonnées (indicateurs PK / FK de la grille). */
  meta?: MetaCache;

  constructor(private readonly ctx: vscode.ExtensionContext, private readonly mgr: ConnectionManager, private readonly panel: ResultsPanel) {
    panel.onFetchMore = () => void this.fetchMore();
    panel.onFetchAll = () => void this.fetchAll();
    panel.onExport = (f) => void this.exportResults(f);
    panel.onView = (v) => void this.applyView(v);
    panel.onCancel = () => void this.cancel();
  }

  dispose() {
    this.diagnostics.dispose();
    void this.closeCursor();
  }

  get history(): HistoryItem[] {
    return this.ctx.globalState.get<HistoryItem[]>('dbexplorer.history', []);
  }
  private readonly historyEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeHistory = this.historyEmitter.event;

  private async saveHistory(list: HistoryItem[]) {
    await this.ctx.globalState.update('dbexplorer.history', list);
    this.historyEmitter.fire();
  }
  private addHistory(h: HistoryItem) {
    const list = [h, ...this.history.filter((x) => x.sql !== h.sql)].slice(0, 300);
    void this.saveHistory(list);
  }
  deleteHistory(ts: number) {
    return this.saveHistory(this.history.filter((x) => x.ts !== ts));
  }
  clearHistory() {
    return this.saveHistory([]);
  }

  private async closeCursor() {
    const c = this.cursor;
    this.cursor = undefined;
    if (c?.rs) await c.rs.close().catch(() => undefined);
  }

  /** Annule l'exécution en cours (Oracle : break, PostgreSQL : pg_cancel_backend, MySQL : KILL QUERY ; SQLite ne peut pas être interrompu). */
  async cancel() {
    if (this.fetchingAll) {
      this.stopFetch = true;
      return;
    }
    if (!this.running) return;
    this.cancelRequested = true;
    this.panel.log('⚠ ' + t('Cancelling…'));
    this.scheduleHardCancel();
    await this.currentConn?.cancel().catch(() => undefined);
  }

  /** Rend la main à l'interface quand la base n'obéit pas à l'annulation (reset de la connexion). */
  private hardCancel?: () => void;
  private hardReset = false;
  private hardTimer?: NodeJS.Timeout;
  private scheduleHardCancel() {
    clearTimeout(this.hardTimer);
    this.hardTimer = setTimeout(() => {
      if (this.running && this.hardCancel) {
        this.hardReset = true;
        this.hardCancel();
      }
    }, 4000);
  }
  /** Attend `p` mais peut être interrompu par hardCancel. */
  private raceHard<T>(p: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.hardCancel = () => reject(new Error(t('The database did not stop the statement: the connection was reset.')));
      p.then(resolve, reject);
    }).finally(() => {
      this.hardCancel = undefined;
      clearTimeout(this.hardTimer);
    });
  }

  // ---------------------------------------------------------------- exécution

  async run(editor: vscode.TextEditor, mode: 'statement' | 'script') {
    if (this.running) {
      vscode.window.showWarningMessage(t('An execution is already in progress.'));
      return;
    }
    const act = await this.mgr.requireFor(editor.document.uri);
    if (!act) return;
    const { session, profile } = act;
    const dialect = dialectOf(session.conn.kind);
    const doc = editor.document;
    const sel = editor.selection;
    let stmts: Stmt[];

    if (!sel.isEmpty) {
      const base = doc.offsetAt(sel.start);
      stmts = split(doc.getText(sel), dialect).map((p) => ({ ...p, start: base + p.start, end: base + p.end }));
      if (mode === 'statement') stmts = stmts.slice(0, stmts.length > 1 ? stmts.length : 1);
    } else {
      const all = split(doc.getText(), dialect);
      if (mode === 'script') stmts = all;
      else {
        const one = statementAt(all, doc.offsetAt(sel.active));
        stmts = one ? [one] : [];
      }
    }
    if (!stmts.length) {
      vscode.window.showInformationMessage(t('No statement to execute.'));
      return;
    }

    // mode lecture seule : seules les requêtes passent
    if (profile.readOnly) {
      const blocked = stmts.filter((x) => {
        const c = cleanSql(x.text, x.isPlsql);
        return !x.isSqlplus && !(session.conn.isQuery(c) && !x.isPlsql && !/^\s*(with\b[\s\S]*\b)?(insert|update|delete|merge)\b/i.test(maskText(c)));
      });
      if (blocked.length) {
        const line = doc.positionAt(blocked[0].start).line + 1;
        this.panel.log(this.mark(doc, line) + '✗ ' + t('"{0}" is read-only: {1} statement(s) blocked, nothing was executed.', profile.name, blocked.length));
        this.panel.update({ tab: 'log', banner: { kind: 'err', text: t('Read-only connection: statement blocked'), u: encodeURIComponent(doc.uri.toString()), line } });
        this.panel.reveal();
        const off = t('Switch to read-write');
        void vscode.window.showWarningMessage(t('"{0}" is read-only.', profile.name), off).then((x) => x === off && vscode.commands.executeCommand('dbexplorer.toggleReadOnly'));
        return;
      }
    }

    // connexion de production : une seule confirmation avant un script qui modifie la base (les UPDATE / DELETE ont leur propre aperçu)
    const prodCfg = vscode.workspace.getConfiguration('dbexplorer');
    if (prodCfg.get<boolean>('confirmOnProduction', true) && isProd(profile)) {
      const risky = stmts.filter((x) => {
        const c = cleanSql(x.text, x.isPlsql);
        return !x.isSqlplus && !(session.conn.isQuery(c) && !x.isPlsql) && !planWrite(c);
      });
      if (risky.length) {
        const go = t('Execute');
        const pick = await vscode.window.showWarningMessage(
          t('PRODUCTION connection "{0}": {1} statement(s) will modify the database.', profile.name, risky.length),
          { modal: true, detail: risky.slice(0, 5).map((x) => '• ' + x.text.trim().split('\n')[0].slice(0, 90)).join('\n') },
          go
        );
        if (pick !== go) return;
      }
    }

    this.diagnostics.delete(doc.uri);
    this.summary = [];
    this.hardReset = false;
    this.curDoc = doc.uri.toString();
    this.lostConn = false;
    this.panel.update({ banner: undefined });
    const runStart = Date.now();
    this.running = true;
    this.currentConn = session.conn;
    this.cancelRequested = false;
    this.setRunning(true);
    session.busy = true;
    session.lastActivity = Date.now();
    this.panel.setBusy(true);
    if (vscode.workspace.getConfiguration('dbexplorer').get<boolean>('clearLogOnRun', false)) this.panel.clearLog();
    // séparateur : plusieurs exécutions d'affilée restent lisibles (script, heure, nombre d'instructions)
    this.panel.log(`━━ ${new Date().toLocaleTimeString()} · ${doc.fileName.split(/[\\/]/).pop()} · ${mode === 'script' || stmts.length > 1 ? t('script ({0} statement(s))', stmts.length) : t('statement')} ━━`);
    this.panel.reveal();
    try {
      const onError = vscode.workspace.getConfiguration('dbexplorer').get<'ask' | 'continue' | 'stop'>('onScriptError', 'ask');
      for (const s of stmts) {
        const ok = await this.runOne(doc, s, session, profile.id, profile.name);
        if (!ok && this.cancelRequested) break; // annulation : on n'enchaîne pas la suite du script
        if (!ok && this.lostConn) break; // connexion perdue : inutile de continuer
        if (!ok && stmts.length > 1) {
          if (onError === 'stop') break;
          if (onError === 'ask') {
            const cont = await vscode.window.showErrorMessage(t('Error — continue the script?'), t('Continue'), t('Stop'));
            if (cont !== t('Continue')) break;
          }
        }
      }
      this.finishSummary(doc, stmts.length, Date.now() - runStart);
    } finally {
      this.running = false;
      this.currentConn = undefined;
      this.setRunning(false);
      session.busy = false;
      session.lastActivity = Date.now();
      this.panel.setBusy(false);
      this.mgr.changed();
    }
    if (this.hardReset) {
      // la connexion était bloquée par l'instruction : on la ferme (la base arrête la session) et on se reconnecte
      this.hardReset = false;
      void (async () => {
        await this.mgr.disconnect(profile.id).catch(() => undefined);
        await this.mgr.connect(profile.id).catch(() => undefined);
        this.panel.log(t('Connection "{0}" reset after the cancellation.', profile.name));
      })();
    }
    if (this.lostConn) {
      const again = t('Reconnect and re-run');
      void vscode.window.showErrorMessage(t('Connection to "{0}" lost.', profile.name), again).then(async (x) => {
        if (x !== again) return;
        await this.mgr.disconnect(profile.id);
        if (!(await this.mgr.connect(profile.id))) return;
        const ed = vscode.window.visibleTextEditors.find((e) => e.document === doc) ?? editor;
        await this.run(ed, mode);
      });
    }
  }

  /** Récapitulatif d'un script : tableau dans l'onglet Messages, ligne de total, accès direct à la première erreur. */
  private finishSummary(doc: vscode.TextDocument, total: number, ms: number) {
    const rows = this.summary;
    const failed = rows.filter((r) => r.ok === 0);
    const u = encodeURIComponent(doc.uri.toString());
    const fmt = (n: number) => (n < 1000 ? n + ' ms' : (n / 1000).toFixed(1) + ' s');
    if (total < 2) {
      const r = rows[0];
      const banner: PanelState['banner'] = !r
        ? undefined
        : r.ok === 1
          ? { kind: 'ok', text: (r.n !== undefined ? t('{0} row(s)', r.n) + ' · ' : '') + fmt(r.ms) }
          : r.ok === 2
            ? { kind: 'warn', text: t('Execution cancelled.') }
            : { kind: 'err', text: r.msg ?? t('Error'), u, line: r.line };
      this.panel.update({ summary: undefined, banner });
      return;
    }
    this.panel.update({ banner: failed.length ? { kind: 'err', text: t('{0} statement(s) failed out of {1}.', failed.length, total), u, line: failed[0].line } : { kind: 'ok', text: t('{0} statements executed', rows.length) + ' · ' + fmt(ms) } });
    const okN = rows.filter((r) => r.ok === 1).length;
    const skipped = total - rows.length;
    this.panel.log(`━━ ${t('Summary: {0} OK, {1} error(s){2} — {3}', okN, failed.length, skipped > 0 ? t(', {0} not run', skipped) : '', ms < 1000 ? ms + ' ms' : (ms / 1000).toFixed(1) + ' s')} ━━`);
    this.panel.update({ summary: rows });
  }

  /** Fenêtre « Paramètres » : une seule boîte listant toutes les variables de liaison. */
  private async askBinds(sql: string, isPlsql: boolean, kind: DbKind): Promise<Record<string, unknown> | undefined> {
    const names = findBinds(sql);
    if (!names.length) return {};
    type Mem = { type: BindSpec['type']; val: string | null };
    const stored = this.ctx.globalState.get<Record<string, Mem>>('dbexplorer.binds', {});
    const oracle = kind === 'oracle';
    const defs: BindDef[] = names.map((n) => {
      const preset = this.presets?.get(n);
      const mem = stored[n];
      const g = oracle && isPlsql ? guessBind(sql, n) : { dir: 'in' as const, type: 'string' as const };
      return {
        name: n,
        dir: preset?.dir ?? g.dir,
        type: preset?.type ?? (g.type !== 'string' ? g.type : mem?.type ?? 'string'),
        val: preset && 'val' in preset ? preset.val ?? null : mem?.val ?? null,
      };
    });
    const res = await askParams(defs, { advanced: oracle, title: t('Parameters'), sql });
    if (!res) return undefined;
    const binds: Record<string, unknown> = {};
    const mem: Record<string, Mem> = { ...stored };
    for (const n of names) {
      const d = res[n];
      binds[n] = { __bind: true, dir: oracle ? d.dir : 'in', type: d.type, val: d.val } satisfies BindSpec;
      if (d.dir !== 'out') mem[n] = { type: d.type, val: d.val };
    }
    void this.ctx.globalState.update('dbexplorer.binds', mem);
    return binds;
  }

  private async runOne(doc: vscode.TextDocument, s: Stmt, session: Session, pid: string, pname: string): Promise<boolean> {
    const conn = session.conn;
    const first = s.text.split('\n')[0].trim();
    const label = first.length > 80 ? first.slice(0, 80) + '…' : first;
    // emplacement de l'instruction dans le script (fichier:ligne) — reporté dans le journal et cliquable
    this.stmtRows = undefined;
    this.lastErrMsg = undefined;
    const lineNo = doc.positionAt(s.start).line + 1;
    const where = `${doc.fileName.split(/[\\/]/).pop()}:${lineNo}`;
    this.panel.log(this.mark(doc, lineNo) + t('▶ {0}  {1}', where, label));

    if (s.isSqlplus) {
      const trimmed = s.text.trim();
      const ex = /^exec(?:ute)?\s+([\s\S]+)$/i.exec(trimmed);
      if (ex) {
        // EXEC proc(...) équivaut à BEGIN proc(...); END;
        s = { ...s, text: 'BEGIN ' + ex[1].trim().replace(/;+\s*$/, '') + '; END;', isPlsql: true, isSqlplus: false };
      } else {
        const m = /^(?:prompt|pro)\s*(.*)$/i.exec(trimmed);
        if (m) this.panel.log(m[1]);
        else if (/^show\s+err/i.test(trimmed)) {
          if (this.lastCompileSql) await this.reportCompileIssues(doc, s, this.lastCompileSql, session, false);
          else this.panel.log(t('No object compiled in this session.'));
        } else if (/^set\s+serveroutput/i.test(trimmed)) this.panel.log(t('(SERVEROUTPUT handled automatically)'));
        else this.panel.log(t('(SQL*Plus command ignored: {0})', label));
        return true;
      }
    }

    const sql = cleanSql(s.text, s.isPlsql);
    const isCreate = /^create\b/i.test(sql);
    const binds = isCreate && conn.kind === 'oracle' ? {} : await this.askBinds(sql, s.isPlsql, conn.kind);
    if (binds === undefined) return false;

    // UPDATE / DELETE : aperçu du nombre de lignes touchées et confirmation (seuil, absence de WHERE, connexion de production)
    if (!s.isPlsql && !isCreate && !(await this.confirmWrite(sql, binds, session, pid))) {
      this.panel.log(`⚠ ${label}`);
      this.panel.log(t('Cancelled before execution: nothing was changed.'));
      this.panel.update({ tab: 'log' });
      this.cancelRequested = true; // un script s'arrête là
      return false;
    }

    const started = Date.now();
    const timeoutSec = vscode.workspace.getConfiguration('dbexplorer').get<number>('queryTimeoutSeconds', 600);
    this.panel.setBusy(true, label, timeoutSec);
    let timedOut = false;
    const watchdog = timeoutSec > 0 ? setTimeout(() => {
      timedOut = true;
      this.scheduleHardCancel();
      void conn.cancel().catch(() => undefined);
    }, timeoutSec * 1000) : undefined;
    const statusMsg = vscode.window.setStatusBarMessage(t('$(sync~spin) DB Explorer: executing…'));
    const useOutput = conn.features.dbmsOutput && vscode.workspace.getConfiguration('dbexplorer').get<boolean>('enableDbmsOutput', true);
    let ok = true;
    try {
      await this.closeCursor();
      if (useOutput) await conn.beforeExec?.();

      if (conn.isQuery(sql) && !s.isPlsql) {
        await this.raceHard(this.runQuery(sql, binds, session, pid, label, started));
      } else {
        const r = await this.raceHard(conn.exec(sql, binds, session.autoCommit));
        const ms = Date.now() - started;
        if (/^\s*(?:create|drop|alter|rename|truncate|comment)\b/i.test(sql)) this.mgr.schemaChanged(pid);
        this.stmtRows = r.rowsAffected;
        if (r.outBinds) await this.showOutBinds(r.outBinds, pid, started);
        const kind = /^(insert|update|delete|merge|replace)\b/i.exec(sql)?.[1]?.toUpperCase();
        if (kind) {
          if (conn.features.transactions && !session.autoCommit) this.markDirty(session);
          this.panel.log(t('{0} row(s) affected ({1}) — {2} ms{3}', r.rowsAffected ?? 0, kind, ms, session.autoCommit ? t(' — auto-commit') : ''));
        } else if (s.isPlsql && !isCreate) {
          if (!session.autoCommit) this.markDirty(session);
          this.panel.log(t('PL/SQL block executed successfully — {0} ms', ms));
        } else {
          this.panel.log(t('{0} executed — {1} ms', (/^\w+/.exec(sql)?.[0] ?? 'Statement').toUpperCase(), ms));
        }
        if (isCreate) await this.reportCompileIssues(doc, s, sql, session);
      }
    } catch (e) {
      ok = false;
      const err = e as Error & { offset?: number };
      const hitTimeout = timedOut || (timeoutSec > 0 && Date.now() - started >= timeoutSec * 1000 - 300);
      const cancelled = this.cancelRequested && !hitTimeout;
      this.panel.log(this.mark(doc, lineNo) + (cancelled ? `⚠ ${where} — ${label}` : `✗ ${where} — ${label}`));
      if (cancelled) this.panel.log(t('Execution cancelled.'));
      else if (hitTimeout) this.panel.log(t('Execution stopped after {0} s: query timeout reached (setting dbexplorer.queryTimeoutSeconds, 0 = no limit).', timeoutSec));
      else {
        this.panel.log(err.message.trim());
        this.lastErrMsg = err.message.trim().split('\n')[0];
        this.lastErrorText = new Date().toISOString() + ' — ' + err.message.trim();
        const info = analyzeError(err.message);
        if (info.lost) this.lostConn = true;
        if (info.hint) this.panel.log('   💡 ' + info.hint);
        const fix = info.unknown ? await this.suggestName(info.unknown, sql, session, pid).catch(() => undefined) : undefined;
        if (fix) this.panel.log('   💡 ' + t('Did you mean {0}?', fix));
        // soulignement dans l'éditeur : position exacte donnée par la base, sinon l'identifiant fautif, sinon la première ligne de l'instruction
        let range: vscode.Range;
        if (typeof err.offset === 'number' && err.offset >= 0 && !s.isPlsql) {
          const pos = doc.positionAt(s.start + err.offset);
          range = doc.getWordRangeAtPosition(pos) ?? new vscode.Range(pos, pos.translate(0, 1));
        } else {
          const first = doc.positionAt(s.start);
          range = doc.lineAt(first.line).range;
          if (info.unknown) {
            const m = new RegExp('(^|[^\\w$#])("?' + info.unknown.name.replace(/[$#.*+?^()[\]{}|\\]/g, '\\$&') + '"?)(?![\\w$#])', 'i').exec(s.text);
            if (m) range = new vscode.Range(doc.positionAt(s.start + m.index + m[1].length), doc.positionAt(s.start + m.index + m[1].length + m[2].length));
          }
        }
        const d = new vscode.Diagnostic(range, err.message.split('\n')[0] + (info.hint ? '\n💡 ' + info.hint : ''), vscode.DiagnosticSeverity.Error);
        if (fix) d.code = 'dbx:' + fix;
        this.addDiag(doc, d);
      }
      this.panel.update({ tab: 'log' });
    }
    if (watchdog) clearTimeout(watchdog);
    statusMsg.dispose();
    this.panel.setBusy(false);
    if (useOutput && !this.hardReset) await this.drainOutput(session);
    this.addHistory({ sql, ts: Date.now(), conn: pname, connId: pid, ms: Date.now() - started, ok });
    this.summary.push({ u: encodeURIComponent(doc.uri.toString()), line: lineNo, label, ok: ok ? 1 : this.cancelRequested ? 2 : 0, ms: Date.now() - started, n: ok ? this.stmtRows : undefined, msg: this.lastErrMsg });
    return ok;
  }

  /** « Vouliez-vous dire … ? » : nom de colonne (tables de la requête) ou de table (objets du schéma) le plus proche. */
  private async suggestName(u: { name: string; what: 'column' | 'table' }, sql: string, session: Session, pid: string): Promise<string | undefined> {
    if (!this.meta) return undefined;
    const schema = session.conn.currentSchema;
    if (u.what === 'table') {
      const m = await within(this.meta.get(pid, schema), 2000);
      return m === TIMEOUT ? undefined : closest(u.name, m.objects.map((o) => o.name));
    }
    const names: string[] = [];
    for (const r of parseRefList(sql, sql.length).filter((x) => !x.virtual)) {
      const [o, tb] = r.table.includes('.') ? r.table.split('.') : [schema, r.table];
      const cols = await within(this.meta.columns(pid, o.replace(/"/g, ''), tb.replace(/"/g, '')).catch(() => []), 2000);
      if (cols !== TIMEOUT) names.push(...cols.map((c) => c.name));
    }
    return closest(u.name, [...new Set(names)]);
  }

  /** Affiche les paramètres OUT : REF CURSOR dans la grille, valeurs scalaires dans le journal. */
  private async showOutBinds(out: Record<string, unknown>, pid: string, started: number) {
    const pageSize = vscode.workspace.getConfiguration('dbexplorer').get<number>('pageSize', 500);
    let shown = false;
    for (const [k, v] of Object.entries(out)) {
      if (v && typeof (v as ResultCursor).getRows === 'function') {
        const rs = v as ResultCursor;
        if (shown) {
          await rs.close().catch(() => undefined);
          continue;
        }
        shown = true;
        const rows = await rs.getRows(pageSize);
        const hasMore = rows.length === pageSize;
        if (hasMore) this.cursor = { rs, sql: '', binds: {}, profileId: pid };
        else await rs.close();
        this.last = undefined;
        this.panel.update({
          grid: { title: ':' + k + ' (REF CURSOR)', columns: rs.columns, rows: rows.map(fmtRow), hasMore, elapsedMs: Date.now() - started },
          tab: 'grid',
        });
        this.panel.log(t(':{0} = REF CURSOR — {1} row(s)', k, rows.length + (hasMore ? '+' : '')));
      } else {
        const text = v === null || v === undefined ? '(null)' : String(fmtRow([v])[0]);
        this.panel.log(':' + k + ' = ' + text);
      }
    }
  }

  /** Fil d'Ariane des lignes liées : requête d'origine puis chaque clé suivie (Ctrl+clic). */
  private trail: { label: string; sql: string; pid: string; binds: Record<string, unknown>; grid?: GridData; edit?: { pid: string; table: string; pkNames: string[]; columns: string[] } }[] = [];
  /** Résultat restauré depuis le fil d'Ariane avec des lignes encore à lire : le curseur est rouvert à la demande. */
  private pendingMore?: { sql: string; binds: Record<string, unknown>; profileId: string; skip: number };

  private async runQuery(sql: string, binds: Record<string, unknown>, session: Session, pid: string, label: string, started: number, crumb: 'reset' | 'keep' = 'reset') {
    if (crumb === 'reset') this.trail = [{ label, sql, pid, binds }];
    this.pendingMore = undefined;
    const pageSize = vscode.workspace.getConfiguration('dbexplorer').get<number>('pageSize', 500);
    const rs = await session.conn.open(sql, binds);
    this.last = { sql, binds, profileId: pid };
    this.base = this.last;
    const rows = await rs.getRows(pageSize);
    const hasMore = rows.length === pageSize;
    if (hasMore) this.cursor = { rs, sql, binds, profileId: pid };
    else await rs.close();
    // clés / liens : on attend un peu ; si la base est lente (connexion de métadonnées à froid, gros dictionnaire) la grille s'affiche
    // tout de suite et les liens de clés étrangères arrivent dès qu'ils sont prêts
    const schemaNow = session.conn.currentSchema;
    const kfP = this.meta ? keyFlags(this.meta, pid, schemaNow, sql, rs.columns, 15000).catch(() => undefined) : Promise.resolve(undefined);
    const early = await within(kfP, 1500);
    const kinfo = early === TIMEOUT ? undefined : early;
    const keys = kinfo?.flags;
    const links = kinfo?.links.some((l) => l.length) ? kinfo.links : undefined;
    this.editCtx = kinfo?.edit ? { pid, table: kinfo.edit.table, pkNames: kinfo.edit.pkNames, columns: rs.columns.map((c) => c.name) } : undefined;
    const edit = kinfo?.edit ? { pk: kinfo.edit.pk, cols: kinfo.edit.cols } : undefined;
    const ms = Date.now() - started;
    this.stmtRows = rows.length;
    const grid: GridData = { doc: this.curDoc, title: label, columns: rs.columns, rows: rows.map(fmtRow), hasMore, elapsedMs: ms, canView: true, keys, links, edit, trail: this.trail.length > 1 ? this.trail.map((c) => c.label) : undefined };
    const crumbNow = this.trail[this.trail.length - 1];
    if (crumbNow) {
      crumbNow.grid = grid; // instantané : le retour par le fil d'Ariane réaffiche ces lignes sans relancer la requête
      crumbNow.edit = this.editCtx;
    }
    this.panel.update({ grid, tab: 'grid' });
    this.panel.log(t('{0} row(s) selected — {1} ms', rows.length + (hasMore ? '+' : ''), ms), false);
    if (early === TIMEOUT) {
      const seq = this.panel.state.gridSeq;
      void kfP.then((late) => {
        if (!late || this.panel.state.gridSeq !== seq) return; // un autre résultat est affiché entre-temps
        grid.keys = late.flags;
        grid.links = late.links.some((l) => l.length) ? late.links : undefined;
        grid.edit = late.edit ? { pk: late.edit.pk, cols: late.edit.cols } : undefined;
        this.editCtx = late.edit ? { pid, table: late.edit.table, pkNames: late.edit.pkNames, columns: rs.columns.map((c) => c.name) } : undefined;
        if (crumbNow) crumbNow.edit = this.editCtx;
        this.panel.patchGrid(seq, { keys: grid.keys, links: grid.links, edit: grid.edit });
      });
    }
  }

  private fetchingAll = false;
  private stopFetch = false;
  /** « Tout afficher » : charge toutes les lignes restantes (plafonné par dbexplorer.showAllMaxRows, annulable). */
  async fetchAll() {
    if (this.fetchingAll || this.running) return;
    const cap = vscode.workspace.getConfiguration('dbexplorer').get<number>('showAllMaxRows', 100000);
    this.fetchingAll = true;
    this.stopFetch = false;
    try {
      while ((this.cursor?.rs || this.pendingMore) && !this.stopFetch) {
        await this.fetchMore();
        const n = this.panel.state.grid?.rows.length ?? 0;
        if (cap > 0 && n >= cap && (this.cursor?.rs || this.pendingMore)) {
          this.panel.log(t('Show all stopped at {0} rows (setting dbexplorer.showAllMaxRows).', n));
          vscode.window.showWarningMessage(t('Show all stopped at {0} rows (setting dbexplorer.showAllMaxRows).', n));
          break;
        }
      }
    } finally {
      this.fetchingAll = false;
    }
  }

  async fetchMore() {
    if (!this.cursor?.rs && this.pendingMore) {
      // résultat restauré : rouvre la requête et saute les lignes déjà affichées
      const p = this.pendingMore;
      this.pendingMore = undefined;
      const session = this.mgr.session(p.profileId);
      if (!session) return;
      this.panel.setBusy(true, t('Fetching next rows'));
      try {
        const rs = await session.conn.open(p.sql, p.binds);
        for (let skip = p.skip; skip > 0; ) {
          const r = await rs.getRows(Math.min(skip, 1000));
          if (!r.length) break;
          skip -= r.length;
        }
        this.cursor = { rs, sql: p.sql, binds: p.binds, profileId: p.profileId };
      } catch (e) {
        this.panel.log(`✗ ${(e as Error).message}`);
        this.panel.setBusy(false);
        return;
      }
      this.panel.setBusy(false);
    }
    const c = this.cursor;
    if (!c?.rs) return;
    const pageSize = vscode.workspace.getConfiguration('dbexplorer').get<number>('pageSize', 500);
    this.panel.setBusy(true, t('Fetching next rows'));
    try {
      const rows = await c.rs.getRows(pageSize);
      const hasMore = rows.length === pageSize;
      this.panel.append(rows.map(fmtRow), hasMore);
      if (!hasMore) await this.closeCursor();
    } catch (e) {
      this.panel.log(`✗ ${(e as Error).message}`);
      await this.closeCursor();
    } finally {
      this.panel.setBusy(false);
    }
  }

  private async drainOutput(session: Session) {
    const text = await session.conn.drainOutput?.();
    if (text) {
      const st = this.panel.state;
      this.panel.update({ output: st.output + (st.output ? '\n' : '') + text, tab: st.grid && !st.log.length ? st.tab : 'output' });
    }
  }

  clearOutput() {
    this.panel.update({ output: '' });
  }

  private async reportCompileIssues(doc: vscode.TextDocument, s: Stmt, sql: string, session: Session, withDiagnostics = true) {
    this.lastCompileSql = sql;
    const res = await session.conn.compileIssues?.(sql);
    if (!res) return;
    if (!res.issues.length) {
      this.panel.log(t('{0} compiled without errors.', res.label));
      return;
    }
    this.panel.log(this.mark(doc, doc.positionAt(s.start).line + 1) + t('✗ Compilation errors for {0}:', res.label));
    // la ligne 1 du dictionnaire est celle du mot-clé de l'objet (PACKAGE, PROCEDURE…), pas celle du début de l'instruction (commentaires, lignes vides, CREATE OR REPLACE sur sa propre ligne)
    const km = /^\s*create\s+(?:or\s+replace\s+)?(?:(?:non)?editionable\s+)?(?:force\s+)?(package\s+body|package|procedure|function|trigger|type\s+body|type|view)\b/i.exec(maskText(s.text));
    const baseLine = doc.positionAt(s.start + (km ? km.index + km[0].length - km[1].length : 0)).line;
    const at = (e: { line: number; col: number }) => ({ line: Math.min(doc.lineCount - 1, baseLine + e.line - 1), col: Math.max(0, e.col - 1) });
    const diags = res.issues.map((e) => {
      const p = at(e);
      const src = doc.lineAt(p.line).text.trim();
      this.panel.log(this.mark(doc, p.line + 1) + t('   line {0}, col {1}: {2}', p.line + 1, e.col, e.text));
      if (src) this.panel.log(this.mark(doc, p.line + 1) + '      ▸ ' + (src.length > 140 ? src.slice(0, 140) + '…' : src));
      return this.tag(new vscode.Diagnostic(new vscode.Range(p.line, p.col, p.line, p.col + 1), e.text, e.warning ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error));
    });
    if (withDiagnostics) this.diagnostics.set(doc.uri, [...(this.diagnostics.get(doc.uri) ?? []), ...diags]);
    this.panel.update({ tab: 'log' });
    const first = res.issues.find((e) => !e.warning);
    if (first) {
      // première erreur : curseur sur sa ligne, et message avec le détail (bouton pour y revenir)
      const p = at(first);
      const go = () => void this.goTo(doc, p.line, p.col);
      go();
      void vscode.window.showErrorMessage(t('{0}: line {1}, col {2} — {3}', res.label, p.line + 1, first.col, first.text), t('Go to line {0}', p.line + 1)).then((x) => x && go());
    }
  }

  /** Préfixe d'une ligne de journal cliquable : ouvre le document à la ligne indiquée. */
  private mark(doc: vscode.TextDocument, line: number): string {
    return '\u0001' + encodeURIComponent(doc.uri.toString()) + '|' + line + '\u0001';
  }

  /** Place le curseur dans le document (l'affiche si besoin) et centre la ligne. */
  private async goTo(doc: vscode.TextDocument, line: number, col: number) {
    const pos = new vscode.Position(line, col);
    const ed = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === doc.uri.toString());
    await vscode.window.showTextDocument(doc, { viewColumn: ed?.viewColumn, selection: new vscode.Range(pos, pos), preserveFocus: false });
    const cur = vscode.window.activeTextEditor;
    if (cur) cur.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  /**
   * Ouvre le source d'un objet compilé en erreur (depuis le Schema Browser) : diagnostics sur chaque ligne en cause et curseur sur la première erreur.
   * Les lignes d'erreur sont relatives au début de chaque unité (spécification / corps) du source.
   */
  async openSourceAtError(conn: DbConn, pid: string, owner: string, name: string, type: string, issues: { type: string; line: number; col: number; text: string; warning: boolean }[]) {
    const ddl = await conn.ddl(type, owner, name);
    const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: ddl });
    this.mgr.bind(doc.uri, pid);
    await vscode.window.showTextDocument(doc, { preview: false });
    const lines = doc.getText().split(/\r?\n/);
    const startOf = (ty: string) => {
      const kw = ty.trim().replace(/\s+/g, '\\s+');
      const re = new RegExp('create\\s+(?:or\\s+replace\\s+)?(?:(?:non)?editionable\\s+)?(?:force\\s+)?' + kw + (/body/i.test(ty) ? '' : '(?!\\s+body)') + '\\b', 'i');
      const i = lines.findIndex((l) => re.test(l));
      return i < 0 ? 0 : i;
    };
    const at = (e: { type: string; line: number; col: number }) => ({ line: Math.min(doc.lineCount - 1, startOf(e.type) + e.line - 1), col: Math.max(0, e.col - 1) });
    this.diagnostics.set(
      doc.uri,
      issues.map((e) => {
        const p = at(e);
        return this.tag(new vscode.Diagnostic(new vscode.Range(p.line, p.col, p.line, p.col + 1), e.text, e.warning ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error));
      })
    );
    const first = issues.find((e) => !e.warning) ?? issues[0];
    if (first) {
      const p = at(first);
      await this.goTo(doc, p.line, p.col);
    }
  }

  // ------------------------------------------------------------- explain plan

  async explain(editor: vscode.TextEditor) {
    const act = await this.mgr.requireFor(editor.document.uri);
    if (!act) return;
    const dialect = dialectOf(act.session.conn.kind);
    const doc = editor.document;
    const s = !editor.selection.isEmpty
      ? split(doc.getText(editor.selection), dialect)[0]
      : statementAt(split(doc.getText(), dialect), doc.offsetAt(editor.selection.active));
    if (!s) return;
    const sql = cleanSql(s.text, s.isPlsql);
    const binds = await this.askBinds(sql, false, act.session.conn.kind);
    if (binds === undefined) return;
    try {
      const plan = await act.session.conn.explain(sql, binds);
      this.panel.update({ plan, tab: 'plan' });
    } catch (e) {
      this.panel.log(t('✗ Explain plan: {0}', (e as Error).message));
      this.panel.update({ tab: 'log' });
    }
    this.panel.reveal();
  }

  // ----------------------------------------------------------------- describe

  async describe(owner: string | undefined, name: string) {
    const act = await this.mgr.requireActive();
    if (!act) return;
    const { conn } = act.session;
    const started = Date.now();
    const o = owner ?? conn.currentSchema;
    try {
      const cols = await conn.columns(o, name);
      if (!cols.length) {
        vscode.window.showWarningMessage(t('Object not found: {0}', `${owner ? owner + '.' : ''}${name}`));
        return;
      }
      this.last = undefined;
      this.panel.update({
        grid: {
          title: `DESCRIBE ${owner ? owner + '.' : ''}${name}`,
          columns: ['#', t('Column'), t('Type'), t('Null?'), 'PK', t('Default'), t('Comment')].map((n) => ({ name: n, type: '' })),
          rows: cols.map((c) => [c.ID, c.NAME, c.TYPE, c.NULLABLE === 'N' ? 'NOT NULL' : '', c.PK ? 'PK' : '', c.DEF, c.COMMENTS]),
          hasMore: false,
          elapsedMs: Date.now() - started,
        },
        tab: 'grid',
      });
      this.panel.reveal();
    } catch (e) {
      vscode.window.showErrorMessage((e as Error).message);
    }
  }

  /** Ctrl+F9 : types des colonnes de la requête sous le curseur, sans l'exécuter. Retourne false si ce n'est pas une requête. */
  async describeQuery(editor: vscode.TextEditor): Promise<boolean> {
    const act = await this.mgr.requireFor(editor.document.uri);
    if (!act) return true;
    const { conn } = act.session;
    const dialect = dialectOf(conn.kind);
    const doc = editor.document;
    const st = !editor.selection.isEmpty
      ? split(doc.getText(editor.selection), dialect)[0]
      : statementAt(split(doc.getText(), dialect), doc.offsetAt(editor.selection.active));
    if (!st) return false;
    const sql = cleanSql(st.text, st.isPlsql);
    if (!conn.isQuery(sql) || st.isPlsql) return false;
    const binds: Record<string, unknown> = {};
    for (const n of findBinds(sql)) binds[n] = null;
    const started = Date.now();
    try {
      const cols = await conn.describeQuery(sql, binds);
      this.last = undefined;
      this.panel.update({
        grid: {
          title: t('COLUMN TYPES — ') + sql.split('\n')[0].slice(0, 70),
          columns: ['#', t('Column'), t('Type'), t('Null?')].map((n) => ({ name: n, type: '' })),
          rows: cols.map((c, i) => [i + 1, c.name, c.type, c.nullable === undefined ? '' : c.nullable ? '' : 'NOT NULL']),
          hasMore: false,
          elapsedMs: Date.now() - started,
        },
        tab: 'grid',
      });
    } catch (e) {
      this.panel.log('✗ ' + (e as Error).message.trim());
      this.panel.update({ tab: 'log' });
    }
    this.panel.reveal();
    return true;
  }

  // ------------------------------------------------------- transaction / export

  /** Marque la transaction comme ouverte ; première modification : rappel non bloquant avec Commit / Rollback. */
  private markDirty(session: Session) {
    const sid = this.mgr.idOf(session);
    const first = !session.dirty;
    session.dirty = true;
    if (first && vscode.workspace.getConfiguration('dbexplorer').get<boolean>('notifyUncommitted', true)) {
      void vscode.window.showInformationMessage(t('Data modified but not committed yet.'), t('Commit'), t('Rollback')).then((pick) => {
        if (pick === t('Commit')) void this.commit(sid);
        else if (pick === t('Rollback')) void this.rollback(sid);
      });
    }
  }

  /** Nombre de lignes que renverrait la requête de comptage (5 s maximum, sinon inconnu). */
  private async countRows(sql: string, binds: Record<string, unknown>, conn: DbConn): Promise<number | undefined> {
    const names = new Set([...maskText(sql).matchAll(/:(\w+)/g)].map((m) => m[1]));
    const used = Object.fromEntries(Object.entries(binds).filter(([k]) => names.has(k)));
    const p = (async () => {
      const rs = await conn.open(sql, used);
      try {
        const rows = await rs.getRows(1);
        return Number(rows[0]?.[0]);
      } finally {
        await rs.close().catch(() => undefined);
      }
    })();
    try {
      const r = await within(p, 5000);
      if (r === TIMEOUT) {
        void conn.cancel().catch(() => undefined);
        p.catch(() => undefined);
        return undefined;
      }
      return Number.isFinite(r) ? r : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * UPDATE / DELETE : compte les lignes concernées (aperçu dans le journal) et demande confirmation si le nombre dépasse le seuil,
   * s'il n'y a pas de WHERE, ou si la connexion est une connexion de production (rouge).
   */
  private async confirmWrite(sql: string, binds: Record<string, unknown>, session: Session, pid: string): Promise<boolean> {
    const plan = planWrite(sql);
    if (!plan) return true;
    const cfg = vscode.workspace.getConfiguration('dbexplorer');
    const production = cfg.get<boolean>('confirmOnProduction', true) && isProd(this.mgr.get(pid));
    const threshold = cfg.get<number>('confirmRowsThreshold', 100);
    const count = cfg.get<boolean>('previewAffectedRows', true) ? await this.countRows(plan.countSql, binds, session.conn) : undefined;
    if (count !== undefined) this.panel.log(t('Preview: {0} row(s) would be affected ({1} on {2}).', count, plan.kind, plan.table), false);
    const big = count !== undefined && threshold > 0 && count >= threshold;
    if (!(production || !plan.hasWhere || big)) return true;
    const why: string[] = [];
    if (!plan.hasWhere) why.push(t('no WHERE clause: every row of the table is concerned'));
    if (big) why.push(t('at least {0} rows (threshold {0}, setting dbexplorer.confirmRowsThreshold)', threshold));
    if (production) why.push(t('production connection (red)'));
    if (session.autoCommit) why.push(t('auto-commit is on: the change cannot be rolled back'));
    const go = t('Execute');
    const pick = await vscode.window.showWarningMessage(
      t('{0} on {1}: {2} row(s) will be affected.', plan.kind, plan.table, count === undefined ? '?' : count),
      { modal: true, detail: why.map((x) => '• ' + x).join('\n') + '\n\n' + sql.trim().slice(0, 400) },
      go
    );
    return pick === go;
  }

  /**
   * Applique les cellules modifiées dans la grille : un UPDATE par ligne (clé primaire dans le WHERE), exécuté dans la transaction de la connexion.
   * Confirmation si l'auto-commit est activé ou si la connexion est une connexion de production.
   */
  async applyEdits(edits: { pk: unknown[]; set: { col: number; v: unknown }[] }[]): Promise<{ ok: boolean; msg?: string }> {
    const ctx = this.editCtx;
    if (ctx && this.mgr.isReadOnly(ctx.pid)) return { ok: false, msg: t('"{0}" is read-only.', this.mgr.get(ctx.pid)?.name ?? '') };
    const sess = ctx ? this.mgr.session(ctx.pid) : undefined;
    if (!ctx || !sess) return { ok: false, msg: t('The result can no longer be edited (connection closed or other result displayed).') };
    const conn = sess.conn;
    const oracle = conn.kind === 'oracle';
    const stmts = edits.map((e) => {
      const set = e.set.map((s) => `${ctx.columns[s.col]} = ${s.v === null || s.v === undefined ? 'NULL' : literal(s.v, oracle)}`).join(', ');
      const where = ctx.pkNames.map((p, i) => (e.pk[i] === null || e.pk[i] === undefined ? `${p} IS NULL` : `${p} = ${literal(e.pk[i], oracle)}`)).join(' AND ');
      return `UPDATE ${ctx.table} SET ${set} WHERE ${where}`;
    });
    const production = vscode.workspace.getConfiguration('dbexplorer').get<boolean>('confirmOnProduction', true) && isProd(this.mgr.get(ctx.pid));
    if (sess.autoCommit || production) {
      const why = [sess.autoCommit ? t('auto-commit is on: the change cannot be rolled back') : '', production ? t('production connection (red)') : ''].filter(Boolean).map((x) => '• ' + x);
      const go = t('Apply');
      const pick = await vscode.window.showWarningMessage(t('Apply {0} change(s) to {1}?', stmts.length, ctx.table), { modal: true, detail: why.join('\n') + '\n\n' + stmts.slice(0, 8).join('\n') + (stmts.length > 8 ? '\n…' : '') }, go);
      if (pick !== go) return { ok: false, msg: t('Cancelled: nothing was changed.') };
    }
    let done = 0;
    try {
      for (const sql of stmts) {
        const r = await conn.exec(sql, {}, sess.autoCommit);
        if ((r.rowsAffected ?? 1) !== 1) this.panel.log(t('⚠ {0} row(s) affected (1 expected): {1}', r.rowsAffected ?? 0, sql));
        else this.panel.log(sql + ';', false);
        done++;
      }
    } catch (e) {
      if (done && !sess.autoCommit) this.markDirty(sess);
      this.mgr.changed();
      return { ok: false, msg: t('{0} change(s) applied, then: {1}', done, (e as Error).message.trim()) };
    }
    if (!sess.autoCommit) this.markDirty(sess);
    this.mgr.changed();
    this.panel.log(t('{0} cell change(s) applied on {1}.', done, ctx.table), false);
    return { ok: true };
  }

  /**
   * Connexion visée par Commit / Rollback : celle demandée, sinon celle de l'éditeur SQL au premier plan, sinon la seule qui a des
   * modifications en attente (le bouton du panneau de résultats n'a pas d'éditeur), sinon on demande.
   */
  private async txTarget(id?: string): Promise<{ id: string; name: string; session: Session } | undefined> {
    const make = (pid: string) => {
      const p = this.mgr.get(pid);
      const session = this.mgr.session(pid);
      return p && session ? { id: pid, name: p.name, session } : undefined;
    };
    if (id) return make(id);
    const ed = vscode.window.activeTextEditor;
    const bound = ed && ed.document.languageId === 'sql' ? this.mgr.forDocument(ed.document.uri)?.profile.id : undefined;
    if (bound && this.mgr.session(bound)?.dirty) return make(bound);
    const dirty = this.mgr.statuses().filter((s) => s.dirty);
    if (dirty.length === 1) return make(dirty[0].id);
    if (dirty.length > 1) {
      const pick = await vscode.window.showQuickPick(dirty.map((d) => ({ label: d.name, id: d.id })), { placeHolder: t('Several connections have uncommitted changes: which one?') });
      return pick ? make(pick.id) : undefined;
    }
    const a = bound ? this.mgr.forDocument(ed!.document.uri) : this.mgr.active;
    return a ? make(a.profile.id) : undefined;
  }

  async commit(id?: string) {
    await this.finishTx('commit', id);
  }

  async rollback(id?: string) {
    await this.finishTx('rollback', id);
  }

  private async finishTx(kind: 'commit' | 'rollback', id?: string) {
    const tg = await this.txTarget(id);
    if (!tg) return void vscode.window.showWarningMessage(t('No active connection.'));
    if (this.running && this.currentConn === tg.session.conn) return void vscode.window.showWarningMessage(t('A statement is still running on this connection: wait for it to finish or cancel it.'));
    const hadChanges = tg.session.dirty;
    try {
      if (kind === 'commit') await tg.session.conn.commit();
      else await tg.session.conn.rollback();
    } catch (e) {
      const msg = (e as Error).message;
      this.panel.log('✗ ' + t(kind === 'commit' ? 'Commit failed on {0}: {1}' : 'Rollback failed on {0}: {1}', tg.name, msg));
      this.panel.update({ tab: 'log', banner: { kind: 'err', text: t(kind === 'commit' ? 'Commit failed: {0}' : 'Rollback failed: {0}', msg.split('\n')[0]) } });
      this.panel.reveal();
      vscode.window.showErrorMessage(t(kind === 'commit' ? 'Commit failed on {0}: {1}' : 'Rollback failed on {0}: {1}', tg.name, msg));
      return;
    }
    tg.session.dirty = false;
    this.mgr.changed();
    const done = t(kind === 'commit' ? 'Commit done on {0}.' : 'Rollback done on {0}.', tg.name);
    this.panel.log((hadChanges ? '✓ ' : '') + done + (hadChanges ? '' : ' ' + t('(no pending change)')));
    this.panel.update({ banner: { kind: 'ok', text: done } });
    void vscode.window.setStatusBarMessage('$(check) ' + done, 5000);
  }

  /** Tri (clic sur l'en-tête) et filtres de la grille : exécutés par la base, par-dessus la requête d'origine. */
  async applyView(view: GridView) {
    const base = this.base;
    const grid = this.panel.state.grid;
    const session = base ? this.mgr.session(base.profileId) : undefined;
    if (!base || !grid || !session) return;
    const conn = session.conn;
    const q = (c: string) => (conn.kind === 'mysql' ? '`' + c.replace(/`/g, '``') + '`' : '"' + c.replace(/"/g, '""') + '"');
    const names = grid.columns.map((c) => c.name);
    const text = (col: string) => (conn.kind === 'oracle' ? `TO_CHAR(${col})` : conn.kind === 'mysql' ? `CAST(${col} AS CHAR)` : `CAST(${col} AS TEXT)`);
    const binds: Record<string, unknown> = { ...base.binds };
    const where: string[] = [];
    const bind = (name: string, val: string, numeric: boolean) => {
      binds[name] = { __bind: true, dir: 'in', type: numeric && val.trim() !== '' && !Number.isNaN(Number(val)) ? 'number' : 'string', val } satisfies BindSpec;
      return ':' + name;
    };
    view.filters.forEach((f: FilterCrit, i) => {
      const col = q(names[f.col]);
      const numeric = /NUM|INT|DEC|FLOAT|DOUBLE|REAL|SERIAL|BINARY_(FLOAT|DOUBLE)/i.test(grid.columns[f.col].type);
      const v = f.value ?? '';
      switch (f.op) {
        case 'null':
          where.push(`${col} IS NULL`);
          break;
        case 'notnull':
          where.push(`${col} IS NOT NULL`);
          break;
        case 'contains':
          where.push(`UPPER(${text(col)}) LIKE UPPER(${bind('dbx_f' + i, '%' + v + '%', false)})`);
          break;
        case 'starts':
          where.push(`UPPER(${text(col)}) LIKE UPPER(${bind('dbx_f' + i, v + '%', false)})`);
          break;
        case 'ends':
          where.push(`UPPER(${text(col)}) LIKE UPPER(${bind('dbx_f' + i, '%' + v, false)})`);
          break;
        case 'in': {
          const items = v.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
          if (items.length) where.push(`${col} IN (${items.map((x, k) => bind(`dbx_f${i}_${k}`, x, numeric)).join(', ')})`);
          break;
        }
        case 'between':
          where.push(`${col} BETWEEN ${bind('dbx_f' + i + '_a', v, numeric)} AND ${bind('dbx_f' + i + '_b', f.value2 ?? '', numeric)}`);
          break;
        default: {
          const op = { eq: '=', ne: '<>', gt: '>', ge: '>=', lt: '<', le: '<=' }[f.op] ?? '=';
          where.push(`${col} ${op} ${bind('dbx_f' + i, v, numeric)}`);
        }
      }
    });
    let sql = base.sql;
    if (where.length || view.sort) {
      sql = `SELECT * FROM (${base.sql}) dbx_v`;
      if (where.length) sql += ` WHERE ${where.join(view.join === 'OR' ? ' OR ' : ' AND ')}`;
      if (view.sort) sql += ` ORDER BY ${q(names[view.sort.col])} ${view.sort.dir === 'desc' ? 'DESC' : 'ASC'}`;
    }
    const pageSize = vscode.workspace.getConfiguration('dbexplorer').get<number>('pageSize', 500);
    const started = Date.now();
    this.panel.setBusy(true, view.sort || where.length ? t('Sorting / filtering…') : t('Restoring the original result…'));
    try {
      await this.closeCursor();
      const rs = await conn.open(sql, binds);
      const rows = await rs.getRows(pageSize);
      const hasMore = rows.length === pageSize;
      this.last = { sql, binds, profileId: base.profileId };
      if (hasMore) this.cursor = { rs, sql, binds, profileId: base.profileId };
      else await rs.close();
      const viewed: GridData = { ...grid, rows: rows.map(fmtRow), hasMore, elapsedMs: Date.now() - started, canView: true, view: where.length || view.sort ? view : undefined };
      const crumbNow = this.trail[this.trail.length - 1];
      if (crumbNow) crumbNow.grid = viewed;
      this.panel.update({ grid: viewed, tab: 'grid' });
    } catch (e) {
      // ex. colonnes en double ou LOB : on repasse en tri / filtre local sur les lignes déjà chargées
      this.panel.log('✗ ' + (e as Error).message.trim());
      this.panel.update({ grid: { ...grid, canView: false, view: undefined } });
    } finally {
      this.panel.setBusy(false);
    }
  }

  /** SQL à analyser : la sélection, sinon l'instruction sous le curseur (sans « ; » final). */
  statementText(editor: vscode.TextEditor): string | undefined {
    const conn = (this.mgr.forDocument(editor.document.uri) ?? this.mgr.active)?.session.conn;
    const dialect = conn ? dialectOf(conn.kind) : 'oracle';
    const doc = editor.document;
    const st = !editor.selection.isEmpty ? split(doc.getText(editor.selection), dialect)[0] : statementAt(split(doc.getText(), dialect), doc.offsetAt(editor.selection.active));
    return st ? cleanSql(st.text, st.isPlsql) : undefined;
  }

  /** Compare les lignes renvoyées par deux requêtes (différences dans les deux sens) et les affiche dans la grille. */
  async compareResults(conn: DbConn, sqlA: string, sqlB: string) {
    const cap = vscode.workspace.getConfiguration('dbexplorer').get<number>('compareMaxRows', 50000);
    const started = Date.now();
    const read = async (sql: string) => {
      const rs = await conn.open(sql, {});
      try {
        const cols = rs.columns.map((c) => c.name);
        const rows: unknown[][] = [];
        while (rows.length < cap) {
          const r = await rs.getRows(Math.min(1000, cap - rows.length));
          if (!r.length) break;
          rows.push(...r.map(fmtRow));
        }
        const truncated = rows.length >= cap && (await rs.getRows(1)).length > 0;
        return { cols, rows, truncated };
      } finally {
        await rs.close();
      }
    };
    this.panel.reveal();
    this.panel.setBusy(true, t('Comparing results…'));
    try {
      const [a, b] = await Promise.all([read(sqlA), read(sqlB)]);
      if (a.cols.length !== b.cols.length) {
        this.panel.log(t('✗ The two queries return a different number of columns ({0} vs {1}).', a.cols.length, b.cols.length));
        this.panel.update({ tab: 'log' });
        return;
      }
      const key = (r: unknown[]) => JSON.stringify(r);
      const left = new Map<string, { row: unknown[]; n: number }>();
      for (const r of a.rows) {
        const e = left.get(key(r));
        if (e) e.n++;
        else left.set(key(r), { row: r, n: 1 });
      }
      const onlyB: unknown[][] = [];
      for (const r of b.rows) {
        const e = left.get(key(r));
        if (e && e.n > 0) e.n--;
        else onlyB.push(r);
      }
      const onlyA: unknown[][] = [];
      for (const { row, n } of left.values()) for (let i = 0; i < n; i++) onlyA.push(row);
      const side = (s: string) => (r: unknown[]) => [s, ...r];
      this.last = undefined;
      this.panel.update({
        grid: {
          title: t('Result comparison A ↔ B'),
          columns: [{ name: t('Side'), type: '' }, ...a.cols.map((n) => ({ name: n, type: '' }))],
          rows: [...onlyA.map(side(t('only in A'))), ...onlyB.map(side(t('only in B')))],
          hasMore: false,
          elapsedMs: Date.now() - started,
        },
        tab: 'grid',
      });
      const same = !onlyA.length && !onlyB.length;
      this.panel.log(
        (same ? '✓ ' : '≠ ') + t('A: {0} row(s), B: {1} row(s) — {2} only in A, {3} only in B{4}', a.rows.length, b.rows.length, onlyA.length, onlyB.length, a.truncated || b.truncated ? t(' (limited to {0} rows per query)', cap) : '')
      );
      if (same) vscode.window.showInformationMessage(t('The two queries return exactly the same rows.'));
    } catch (e) {
      this.panel.log('✗ ' + (e as Error).message.trim());
      this.panel.update({ tab: 'log' });
    } finally {
      this.panel.setBusy(false);
    }
  }

  /** Exporte la grille (toutes les lignes de la requête, relue en flux) au format choisi. */
  async exportResults(format?: ExportFormat) {
    const grid = this.panel.state.grid;
    if (!grid) {
      vscode.window.showWarningMessage(t('No query result to export.'));
      return;
    }
    if (!format) {
      const pick = await vscode.window.showQuickPick(
        FORMATS.map((f) => ({ label: f.label, id: f.id })),
        { placeHolder: t('Export format') }
      );
      if (!pick) return;
      format = pick.id;
    }
    const info = FORMATS.find((f) => f.id === format)!;
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const uri = await vscode.window.showSaveDialog({ filters: { [info.label]: [info.ext] }, defaultUri: vscode.Uri.file(`export-${stamp}.${info.ext}`) });
    if (!uri) return;
    const base = this.last;
    let tableName = 'TABLE_NAME';
    let keyColumns: string[] = [];
    const sqlFormat = format === 'sql' || format === 'sqlbind' || format === 'merge' || format === 'mergebind';
    if (sqlFormat) {
      const guess = base ? /\bfrom\s+("?[\w$#.]+"?)/i.exec(base.sql)?.[1] : undefined;
      const n = await vscode.window.showInputBox({ prompt: t('Table name for the INSERT statements'), value: guess ?? tableName });
      if (!n) return;
      tableName = n;
    }
    const srcConn = (base ? this.mgr.session(base.profileId) : undefined)?.conn ?? this.mgr.active?.session.conn;
    const oracle = srcConn?.kind === 'oracle';
    if (format === 'merge' || format === 'mergebind') {
      // clés du MERGE : clé primaire de la table si on la trouve, sinon à choisir
      const names = grid.columns.map((c) => c.name);
      let pk: string[] = [];
      try {
        const [o, tb] = tableName.includes('.') ? tableName.split('.') : [srcConn?.currentSchema ?? '', tableName];
        pk = srcConn ? (await srcConn.columns(o.replace(/"/g, ''), tb.replace(/"/g, ''))).filter((c) => c.PK && names.includes(c.NAME)).map((c) => c.NAME) : [];
      } catch {
        /* table introuvable : choix manuel */
      }
      const picked = await vscode.window.showQuickPick(
        names.map((n) => ({ label: n, picked: pk.includes(n) })),
        { canPickMany: true, placeHolder: t('Key columns for the MERGE (ON clause)') }
      );
      if (!picked?.length) return;
      keyColumns = picked.map((x) => x.label);
    }
    if (sqlFormat && !oracle && format !== 'sql') vscode.window.showWarningMessage(t('This format generates Oracle SQL (MERGE / PL/SQL).'));
    const csvSeparator = vscode.workspace.getConfiguration('dbexplorer').get<string>('csvSeparator', ';');
    const session = base ? this.mgr.session(base.profileId) : undefined;
    let total = 0;
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Exporting…'), cancellable: true }, async (prog, token) => {
        const w = createWriter(format!, uri.fsPath, { csvSeparator, tableName, keyColumns, oracle: srcConn?.kind === 'oracle' });
        try {
          if (base && session) {
            const rs = await session.conn.open(base.sql, base.binds);
            await w.begin(rs.columns.map((c) => c.name));
            for (;;) {
              if (token.isCancellationRequested) break;
              const rows = await rs.getRows(1000);
              if (!rows.length) break;
              await w.rows(rows.map(fmtRow));
              total += rows.length;
              prog.report({ message: t('{0} rows', total) });
            }
            await rs.close();
          } else {
            // grille sans requête source (DESCRIBE…) : lignes déjà affichées
            await w.begin(grid.columns.map((c) => c.name));
            await w.rows(grid.rows);
            total = grid.rows.length;
          }
        } finally {
          await w.end();
        }
      });
    } catch (e) {
      vscode.window.showErrorMessage(t('Export failed: {0}', (e as Error).message));
      return;
    }
    const pick = await vscode.window.showInformationMessage(t('{0} rows exported to {1}', total, uri.fsPath), t('Open'), t('Show in folder'));
    if (pick === t('Open')) void vscode.env.openExternal(uri);
    else if (pick === t('Show in folder')) void vscode.commands.executeCommand('revealFileInOS', uri);
  }
}

function csv(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[;"\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** Date locale lisible « 2026-07-17 » ou « 2026-07-17 15:34:23 » (reconnue par les exports INSERT/MERGE Oracle). */
function fmtDate(d: Date): string {
  if (isNaN(d.getTime())) return '';
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  const day = `${p(d.getFullYear(), 4)}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const ms = d.getMilliseconds();
  if (!d.getHours() && !d.getMinutes() && !d.getSeconds() && !ms) return day;
  return `${day} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${ms ? '.' + p(ms, 3) : ''}`;
}

export function fmtRow(row: unknown[]): unknown[] {
  return row.map((v) => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number' || typeof v === 'string') return v;
    if (typeof v === 'boolean') return String(v);
    if (Buffer.isBuffer(v)) return `<BLOB ${v.length} bytes> ${v.subarray(0, 16).toString('hex')}${v.length > 16 ? '…' : ''}`;
    if (v instanceof Date) return fmtDate(v);
    if (typeof v === 'bigint') return v.toString();
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  });
}
