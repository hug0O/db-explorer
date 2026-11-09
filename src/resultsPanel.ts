import { t } from './i18n';
import * as vscode from 'vscode';
import type { GridLink } from './keyFlags';
import type { ExportFormat } from './exporters';

export type FilterOp = 'eq' | 'ne' | 'gt' | 'ge' | 'lt' | 'le' | 'contains' | 'starts' | 'ends' | 'in' | 'between' | 'null' | 'notnull';

export interface FilterCrit {
  col: number;
  op: FilterOp;
  value?: string;
  value2?: string;
}

/** Tri et filtres appliqués à la grille (exécutés par la base). */
export interface GridView {
  sort?: { col: number; dir: 'asc' | 'desc' } | null;
  filters: FilterCrit[];
  join: 'AND' | 'OR';
}

export interface GridData {
  /** Éditeur (uri) dont vient ce résultat. */
  doc?: string;
  title: string;
  columns: { name: string; type: string }[];
  rows: unknown[][];
  hasMore: boolean;
  elapsedMs: number;
  /** Tri / filtre exécutables côté base (requête d'origine connue). */
  canView?: boolean;
  view?: GridView;
  /** Par colonne : 'P' clé primaire, 'F' clé étrangère, 'PF' les deux, '' sinon. */
  keys?: string[];
  /** Par colonne : liens de navigation par clé étrangère. */
  links?: GridLink[][];
  /** Édition en grille : colonnes de la clé primaire et colonnes modifiables. */
  edit?: { pk: number[]; cols: boolean[] };
  /** Fil d'Ariane des lignes liées (étapes successives, la dernière est affichée). */
  trail?: string[];
}

/** Une instruction d'un script : résultat résumé (ok : 0 erreur, 1 réussie, 2 annulée). */
export interface SummaryRow {
  u: string;
  line: number;
  label: string;
  ok: 0 | 1 | 2;
  ms: number;
  n?: number;
  /** Première ligne du message d'erreur. */
  msg?: string;
}

/** Résumé d'une ligne de la dernière exécution, affiché sous les onglets. */
export interface Banner {
  kind: 'ok' | 'err' | 'warn';
  text: string;
  /** Lien vers la ligne du script (uri encodée + numéro de ligne). */
  u?: string;
  line?: number;
}

export interface PanelState {
  grid?: GridData;
  /** Incrémenté à chaque nouveau résultat : le panneau garde les derniers résultats pour les comparer. */
  gridSeq?: number;
  summary?: SummaryRow[];
  banner?: Banner;
  /** Éditeur SQL au premier plan : le panneau réaffiche son dernier résultat. */
  activeDoc?: string;
  log: string[];
  output: string;
  plan: string;
  tab: 'grid' | 'log' | 'errors' | 'output' | 'plan';
}

type Incoming = { cmd: 'clear'; tab: string } | { cmd: 'goto'; uri: string; line: number } | { cmd: 'dupDiagnose' } | { cmd: 'crumb'; index: number } | { cmd: 'crumbSql' } | { cmd: 'applyEdits'; edits: { pk: unknown[]; set: { col: number; v: unknown }[] }[] } | { cmd: 'follow'; links: GridLink[]; vals: unknown[]; newEditor?: boolean; choose?: boolean } | { cmd: 'commit' } | { cmd: 'rollback' } | { cmd: 'ready' } | { cmd: 'fetchMore' } | { cmd: 'fetchAll' } | { cmd: 'export'; format?: ExportFormat } | { cmd: 'view'; view: GridView } | { cmd: 'cancel' };

export class ResultsPanel implements vscode.WebviewViewProvider {
  static readonly viewId = 'dbexplorer.results';
  private view?: vscode.WebviewView;
  private ready = false;
  state: PanelState = { log: [], output: '', plan: '', tab: 'log' };
  onFetchMore: () => void = () => {};
  onFetchAll: () => void = () => {};
  onExport: (f?: ExportFormat) => void = () => {};
  onView: (v: GridView) => void = () => {};
  private description?: string;
  onCancel: () => void = () => {};
  /** Cellules modifiées dans la grille : appliquées par le runner (UPDATE par clé primaire). */
  onEdits: (edits: { pk: unknown[]; set: { col: number; v: unknown }[] }[]) => Promise<{ ok: boolean; msg?: string }> = async () => ({ ok: false });
  /** Ctrl+clic sur une clé : navigation vers la ligne parente / les lignes enfants. */
  onFollow: (links: GridLink[], vals: unknown[], newEditor: boolean, choose: boolean) => void = () => {};
  /** Fil d'Ariane des lignes liées : retour à une étape / ouverture de la requête en éditeur. */
  onCrumb: (index: number) => void = () => {};
  onCrumbSql: () => void = () => {};
  /** Détecteur de doublons : ajoute la clé de chaque table au SELECT de la requête affichée. */
  onDupDiagnose: () => void = () => {};

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    this.ready = false;
    view.webview.options = { enableScripts: true };
    view.webview.html = html(view.webview);
    view.description = this.description;
    view.webview.onDidReceiveMessage((m: Incoming) => {
      if (m.cmd === 'ready') {
        this.ready = true;
        this.post({ type: 'state', state: this.state });
        this.post({ type: 'dirty', on: this.dirty.on, name: this.dirty.name });
      } else if (m.cmd === 'fetchMore') this.onFetchMore();
      else if (m.cmd === 'fetchAll') this.onFetchAll();
      else if (m.cmd === 'export') this.onExport(m.format);
      else if (m.cmd === 'view') this.onView(m.view);
      else if (m.cmd === 'cancel') this.onCancel();
      else if (m.cmd === 'follow') this.onFollow(m.links, m.vals, !!m.newEditor, !!m.choose);
      else if (m.cmd === 'crumb') this.onCrumb(m.index);
      else if (m.cmd === 'dupDiagnose') this.onDupDiagnose();
      else if (m.cmd === 'clear') {
        if (m.tab === 'output') this.update({ output: '', tab: 'output' });
        else {
          this.clearLog();
          this.update({ tab: m.tab === 'errors' ? 'errors' : 'log' });
        }
      } else if (m.cmd === 'goto') {
        void vscode.window.showTextDocument(vscode.Uri.parse(decodeURIComponent(m.uri)), { selection: new vscode.Range(m.line - 1, 0, m.line - 1, 0), preview: false });
      }
      else if (m.cmd === 'crumbSql') this.onCrumbSql();
      else if (m.cmd === 'applyEdits') void this.onEdits(m.edits).then((r) => this.post({ type: 'editResult', ok: r.ok, msg: r.msg }));
      else if (m.cmd === 'commit') void vscode.commands.executeCommand('dbexplorer.commit');
      else if (m.cmd === 'rollback') void vscode.commands.executeCommand('dbexplorer.rollback');
    });
    view.onDidDispose(() => {
      this.view = undefined;
      this.ready = false;
    });
  }

  private post(msg: unknown) {
    if (this.view && this.ready) void this.view.webview.postMessage(msg);
  }

  private dirty: { on: boolean; name?: string } = { on: false };

  /** Bandeau « modifications non validées » avec les boutons Commit / Rollback. */
  setDirty(on: boolean, name?: string) {
    this.dirty = { on, name };
    this.post({ type: 'dirty', on, name });
  }

  /** Connexion affichée dans l'en-tête du panneau (user@schéma). */
  setDescription(text?: string) {
    this.description = text;
    if (this.view) this.view.description = text;
  }

  /** Affiche le panneau du bas sans prendre le focus de l'éditeur. */
  reveal() {
    if (this.view) {
      this.view.show(true);
    } else {
      void vscode.commands
        .executeCommand(`${ResultsPanel.viewId}.focus`)
        .then(() => vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup'));
    }
  }

  update(patch: Partial<PanelState>) {
    Object.assign(this.state, patch);
    if ('grid' in patch) this.state.gridSeq = (this.state.gridSeq ?? 0) + 1;
    this.post({ type: 'state', state: this.state });
  }

  log(line: string, show = true) {
    this.state.log.push(line);
    if (this.state.log.length > 2000) this.state.log.splice(0, this.state.log.length - 2000);
    if (show) this.post({ type: 'log', line });
  }

  clearLog() {
    this.state.log = [];
    this.state.summary = undefined;
    this.state.banner = undefined;
  }

  append(rows: unknown[][], hasMore: boolean) {
    if (this.state.grid) {
      this.state.grid.rows.push(...rows);
      this.state.grid.hasMore = hasMore;
    }
    this.post({ type: 'append', rows, hasMore });
  }

  setBusy(busy: boolean, label?: string, timeoutSec?: number) {
    this.post({ type: 'busy', busy, label, timeoutSec, startedAt: Date.now() });
  }
}

function html(webview: vscode.Webview): string {
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body{margin:0;padding:0;font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-editor-background);display:flex;flex-direction:column;height:100vh}
#bar{display:flex;gap:2px;align-items:center;padding:4px 8px;border-bottom:1px solid var(--vscode-panel-border);flex-wrap:wrap}
.tab{padding:3px 10px;cursor:pointer;border:1px solid transparent;border-radius:3px;opacity:.75}
.tab.on{opacity:1;border-color:var(--vscode-focusBorder);background:var(--vscode-list-hoverBackground)}
button{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:0;padding:3px 9px;border-radius:2px;cursor:pointer}
button:hover{background:var(--vscode-button-secondaryHoverBackground)}
input{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);padding:2px 6px}
#status{padding:2px 8px;font-size:11px;opacity:.8;border-top:1px solid var(--vscode-panel-border)}
.pane{display:none;flex:1;overflow:auto}.pane.on{display:block}
table{border-collapse:collapse;font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size)}
th,td{border:1px solid var(--vscode-panel-border);padding:2px 8px;white-space:nowrap;max-width:420px;overflow:hidden;text-overflow:ellipsis}
th{position:sticky;top:0;background:var(--vscode-editorGroupHeader-tabsBackground);cursor:pointer;text-align:left;user-select:none;z-index:1}
td.n{text-align:right}td.rn{opacity:.5;text-align:right;background:var(--vscode-editorGroupHeader-tabsBackground)}
td.null{color:var(--vscode-disabledForeground,#888);font-style:italic;background:rgba(128,128,128,.22)}
#fcol{max-width:130px}
#tools select{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);padding:2px 4px}
tr:hover td{background:var(--vscode-list-hoverBackground)}
pre{margin:0;padding:8px;font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size);white-space:pre-wrap}
.err{color:var(--vscode-errorForeground)}
.loc{cursor:pointer}.loc:hover{text-decoration:underline}.runhead{opacity:.65;margin-top:8px;border-top:1px solid var(--vscode-panel-border);padding-top:4px}
.errbadge{margin-left:5px;font-size:10px;padding:0 6px;border-radius:8px;background:var(--vscode-errorForeground,#f14c4c);color:#fff}
#fb{padding:6px 10px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-editorWidget-background,var(--vscode-editor-background))}
#fb .crit{display:flex;gap:6px;align-items:center;margin:3px 0}
#fb select,#fb input{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));padding:2px 4px;font-family:inherit;font-size:inherit}
#fb .foot{display:flex;gap:6px;align-items:center;margin-top:6px}
#fb button.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
th .si{opacity:.9;margin-left:4px}
td.ed{cursor:cell;outline:1px dashed color-mix(in srgb,var(--vscode-focusBorder) 50%,transparent);outline-offset:-1px}
td.mod{background:color-mix(in srgb,#e0a458 28%,transparent)!important;font-weight:600}
td.lk:hover{text-decoration:underline dotted;cursor:alias}
th .ki{margin-right:3px;font-size:10px}
:root{--tn:#4f9de0;--tt:#7fb069;--td:#e0a458;--tb:#b07fd0;--tl:#d0746f;--to:#8a8a8a}
th.k-n,.lg.k-n{--k:var(--tn)}th.k-t,.lg.k-t{--k:var(--tt)}th.k-d,.lg.k-d{--k:var(--td)}th.k-b,.lg.k-b{--k:var(--tb)}th.k-l,.lg.k-l{--k:var(--tl)}th.k-o,.lg.k-o{--k:var(--to)}
th[class^=k-]{box-shadow:inset 0 -3px 0 var(--k)}
td.c-n{background:color-mix(in srgb,var(--tn) 7%,transparent)}td.c-t{background:color-mix(in srgb,var(--tt) 6%,transparent)}td.c-d{background:color-mix(in srgb,var(--td) 8%,transparent)}td.c-b{background:color-mix(in srgb,var(--tb) 8%,transparent)}td.c-l{background:color-mix(in srgb,var(--tl) 8%,transparent)}
#crumbs{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:4px 10px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-editorWidget-background,var(--vscode-editor-background));font-size:12px}
#crumbs a{color:var(--vscode-textLink-foreground);cursor:pointer}#crumbs a:hover{text-decoration:underline}#crumbs .sep{opacity:.5}
#legend{display:flex;flex-wrap:wrap;gap:4px 12px;align-items:center;padding:3px 10px;font-size:11px;opacity:.85;border-bottom:1px solid var(--vscode-panel-border)}
#legend:empty{display:none}
#legend .lg{display:inline-flex;align-items:center;gap:4px}#legend .lg:before{content:'';width:10px;height:10px;border-radius:2px;background:var(--k)}
.dn{margin-left:4px;font-size:10px;padding:0 5px;border-radius:8px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}
tr.dg0 td{background:color-mix(in srgb,#e0a458 26%,transparent)!important}tr.dg1 td{background:color-mix(in srgb,#4f9de0 24%,transparent)!important}tr.dg2 td{background:color-mix(in srgb,#7fb069 26%,transparent)!important}
tr.dg3 td{background:color-mix(in srgb,#b07fd0 26%,transparent)!important}tr.dg4 td{background:color-mix(in srgb,#d0746f 26%,transparent)!important}tr.dg5 td{background:color-mix(in srgb,#3fb6a8 26%,transparent)!important}
#dp{padding:6px 10px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-editorWidget-background,var(--vscode-editor-background));max-height:40vh;overflow:auto}
#dp label{display:inline-flex;align-items:center;gap:3px;margin:2px 10px 2px 0;white-space:nowrap}
#cp{padding:6px 10px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-editorWidget-background,var(--vscode-editor-background));max-height:40vh;overflow:auto}
#cp label{display:inline-flex;align-items:center;gap:3px;margin:2px 10px 2px 0;white-space:nowrap}
#dirtybar{display:flex;align-items:center;gap:10px;padding:5px 10px;background:var(--vscode-inputValidation-warningBackground,#5a4a00);border-bottom:2px solid var(--vscode-inputValidation-warningBorder,#d7ba00);font-size:12px}
#dirtybar .dot{color:var(--vscode-editorWarning-foreground,#d7ba00);font-size:14px}
#dirtybar button.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground);font-weight:700;padding:3px 14px}
#dirtybar button.warn{background:var(--vscode-statusBarItem-warningBackground,#8a6d00);color:var(--vscode-statusBarItem-warningForeground,#fff)}
#busybar{display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--vscode-editorInfo-background,var(--vscode-list-hoverBackground));border-bottom:1px solid var(--vscode-panel-border);font-size:12px}
.spin{width:12px;height:12px;border:2px solid var(--vscode-foreground);border-right-color:transparent;border-radius:50%;animation:sp .8s linear infinite;display:inline-block}
@keyframes sp{to{transform:rotate(360deg)}}
#tools{margin-left:auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end}
.grp{display:flex;gap:3px;align-items:center;padding-left:8px;border-left:1px solid var(--vscode-panel-border)}.grp:first-child{border-left:0;padding-left:0}
button.tb{background:transparent;color:var(--vscode-foreground);border:1px solid transparent;padding:3px 9px;border-radius:4px;display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
button.tb:hover{background:var(--vscode-toolbar-hoverBackground,var(--vscode-list-hoverBackground))}
button.tb.acc{border-color:var(--vscode-focusBorder);color:var(--vscode-textLink-foreground)}
button.tb.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}button.tb.primary:hover{background:var(--vscode-button-hoverBackground)}
button.tb.danger{color:var(--vscode-errorForeground)}
#fbtn:before{content:'⛃'}#colbtn:before{content:'▥'}#more:before{content:'↓'}#all:before{content:'⇊'}#exp:before{content:'⤓'}#copy:before{content:'⧉'}
#tools:not([data-t=grid]) .gonly{display:none}
#mwrap{position:relative;display:inline-block}
#menu{position:absolute;right:0;top:100%;z-index:20;min-width:170px;flex-direction:column;background:var(--vscode-menu-background,var(--vscode-editorWidget-background,var(--vscode-editor-background)));border:1px solid var(--vscode-menu-border,var(--vscode-panel-border));border-radius:4px;padding:4px;box-shadow:0 4px 14px rgba(0,0,0,.35)}
#menu button{background:transparent;text-align:left;padding:5px 10px;border-radius:3px;color:var(--vscode-menu-foreground,var(--vscode-foreground))}#menu button:hover{background:var(--vscode-menu-selectionBackground,var(--vscode-list-hoverBackground))}
#filter{border-radius:4px}#fcol{border-radius:4px}
#banner{display:none;padding:4px 12px;font-size:12px;border-bottom:1px solid var(--vscode-panel-border)}
#banner.ok{display:block;background:color-mix(in srgb,#3fb950 14%,transparent)}#banner.err{display:block;background:color-mix(in srgb,#f14c4c 16%,transparent);color:var(--vscode-errorForeground)}#banner.warn{display:block;background:color-mix(in srgb,#e0a458 18%,transparent)}
#banner.loc{cursor:pointer}#banner.loc:hover{text-decoration:underline}
#main{display:flex;flex:1;min-height:0}#main .pane{min-width:0}
#rs{display:flex;flex-wrap:wrap;gap:4px;align-items:center;padding:3px 10px;border-bottom:1px solid var(--vscode-panel-border);font-size:11px}
.chip{display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border:1px solid var(--vscode-panel-border);border-radius:10px;cursor:pointer;opacity:.75}
.chip.on{opacity:1;border-color:var(--vscode-focusBorder);background:var(--vscode-list-hoverBackground)}.chip small{opacity:.7}.chip .cx{opacity:.5;margin-left:2px}.chip .cx:hover{opacity:1}
#rs select{font-size:11px}
th.pin,td.pin{position:sticky;z-index:2}th.pin{z-index:4}td.pin{background:var(--vscode-editor-background)}td.rn.pin{background:var(--vscode-editorGroupHeader-tabsBackground)}
#dt{display:none;flex:0 0 38%;min-width:180px;flex-direction:column;border-left:1px solid var(--vscode-panel-border);background:var(--vscode-editorWidget-background,var(--vscode-editor-background))}
#dt .h{display:flex;gap:6px;align-items:center;padding:4px 8px;border-bottom:1px solid var(--vscode-panel-border)}#dt .h b{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#dtt{flex:1;overflow:auto;white-space:pre-wrap;word-break:break-word}
#sumt{display:none;padding:6px 8px;border-bottom:1px solid var(--vscode-panel-border)}#sumt table{width:100%}#sumt tr{cursor:pointer}#sumt td.e{color:var(--vscode-errorForeground)}#sumt .ml{max-width:520px}
.pf{background:color-mix(in srgb,#e0a458 26%,transparent);border-left:3px solid #e0a458}.pi{border-left:3px solid #7fb069}.pl{border-left:3px solid transparent}
.cb{display:inline-block;height:6px;background:var(--vscode-progressBar-background,#0e70c0);border-radius:2px;margin-left:8px;vertical-align:middle}
#plsum{padding:6px 10px;border-bottom:1px solid var(--vscode-panel-border);font-size:12px}
</style></head><body>
<div id="bar">
 <span class="tab on" data-t="grid">${t('Data')}</span><span class="tab" data-t="log">${t('Script / Messages')}</span><span class="tab" data-t="errors">${t('Errors')}<span id="errn" class="errbadge" style="display:none"></span></span><span class="tab" data-t="output">DBMS Output</span><span class="tab" data-t="plan">Explain Plan</span>
 <div id="tools" data-t="grid">
  <div class="grp gonly"><input id="filter" placeholder="${t('Search in rows…')}" size="16"><select id="fcol" title="${t('Column to search in')}"><option value="-1">${t('All columns')}</option></select></div>
  <div class="grp gonly"><button class="tb" id="fbtn" title="${t('Add filter criteria on a column (run by the database)')}">${t('Filter')}</button><button class="tb" id="colbtn" title="${t('Show / hide columns')}">${t('Columns')}</button></div>
  <div class="grp gonly"><button class="tb acc" id="more" style="display:none" title="${t('Load the next page of rows')}">${t('Next rows')}</button><button class="tb acc" id="all" style="display:none" title="${t('Load every remaining row (can be cancelled)')}">${t('Show all')}</button></div>
  <div class="grp gonly"><button class="tb primary" id="applybtn" style="display:none"></button><button class="tb" id="discardbtn" style="display:none">${t('Discard')}</button></div>
  <div class="grp gonly"><button class="tb" id="exp" title="${t('Other formats: TSV, JSON, HTML, Markdown, SQL INSERT, XML')}">${t('Export…')}</button><button class="tb" id="copy" title="${t('Copy the rows to the clipboard')}">${t('Copy')}</button></div>
  <div class="grp"><button class="tb" id="clr" style="display:none" title="${t('Clear this tab')}">${t('Clear')}</button><button class="tb danger" id="cancel">${t('Cancel')}</button><span id="mwrap" class="gonly"><button class="tb" id="mbtn" aria-label="More actions" title="${t('More actions')}">⋯</button><div id="menu" style="display:none"><button id="editbtn" style="display:none" title="${t('Edit cells of this table (double-click a cell)')}">${t('Edit')}</button><button id="dupbtn" title="${t('Highlight duplicate rows (same values in the chosen columns) among the loaded rows')}">${t('Duplicates')}</button></div></span></div>
 </div>
</div>
<div id="banner"></div>
<div id="crumbs" style="display:none"></div>
<div id="rs" style="display:none"></div>
<div id="cp" style="display:none"></div>
<div id="dp" style="display:none"></div>
<div id="legend"></div>
<div id="fb" style="display:none"></div>
<div id="dirtybar" style="display:none"><span class="dot">●</span><b id="dirtytxt"></b><button id="dcommit" class="primary">${t('Commit')}</button><button id="drollback" class="primary warn">${t('Rollback')}</button></div>
<div id="busybar" style="display:none"><span class="spin"></span><span id="busytxt"></span><button id="cancel2" style="margin-left:auto">${t('Cancel')}</button></div>
<div id="main"><div id="grid" class="pane on"></div><div id="log" class="pane"><div id="sumt"></div><pre id="logt"></pre></div><div id="errors" class="pane"><pre id="errt"></pre></div><div id="output" class="pane"><pre id="outt"></pre></div><div id="plan" class="pane"><div id="plsum"></div><div id="plant"></div></div>
<div id="dt"><div class="h"><b id="dtn"></b><button id="dtcopy" aria-label="Copy">${t('Copy')}</button><button id="dtx" aria-label="Close" title="${t('Close')}">×</button></div><pre id="dtt"></pre></div></div>
<div id="status"></div>
<script nonce="${nonce}">
const vs=acquireVsCodeApi();
const T=${JSON.stringify({ noresult: t('No result. Run a query ({0}).', 'F9'), dirty: t('Uncommitted data changes'), rows: t(' {0} row(s)'), shown: t(' ({0} shown)'), more: t(' (more available)'), running: t('Executing… '), timeout: t('timeout {0} s'), dupTitle: t('Duplicates on:'), dupWhy: t('Find the cause…'), dupWhyTip: t('Add the key of every table of the query to the SELECT to see which one repeats the rows'), dupOn: t('Highlight'), dupOnly: t('Only duplicates'), dupSummary: t('{0} duplicate row(s) in {1} group(s)'), dupNone: t('No duplicate among the loaded rows.'), dupPartial: t(' (loaded rows only)'), back: t('Back'), openSql: t('Open this query in an editor'), applyN: t('Apply ({0})'), editing: t('Edit mode: double-click a cell, Enter to stage, Esc to cancel; NULL = null value'), follow: t('Ctrl+click on a key: follow the link (Alt+Ctrl+click: choose, Shift+Ctrl+click: new editor)'), parentTip: t('parent row'), childTip: t('child rows'), colsLbl: t('Columns'), allBtn: t('All'), noneBtn: t('None'), kinds: { n: t('Number'), t: t('Text'), d: t('Date / time'), b: t('Boolean'), l: t('Binary / LOB'), o: t('Other') }, typesLbl: t('Column types'), pk: t('Primary key'), fk: t('Foreign key'), allCols: t('All columns'), filter: t('Filter'), addCrit: t('+ Add criterion'), apply: t('Apply'), clearF: t('Clear filters'), all: t('all criteria (AND)'), any: t('any criterion (OR)'), value: t('value'), and: t('and'), column: t('Column'), ops: { eq: '=', ne: '≠', gt: '>', ge: '≥', lt: '<', le: '≤', contains: t('contains'), starts: t('starts with'), ends: t('ends with'), in: t('in list (a, b, c)'), between: t('between'), null: t('is null'), notnull: t('is not null') }, showAll: t('Show all'), bannerGo: t('Click to go to the line'), identical: t('identical'), onlyIn: t('only in'), compare: t('Compare with…'), pinHint: t('Right-click a header: pin / unpin the column'), sumOk: t('OK'), sumErr: t('Error'), sumCancel: t('Cancelled'), sumRows: t('row(s)'), sumStmt: t('Statement'), sumLine: t('Line'), fullScans: t('{0} full table scan(s)'), planOk: t('No full table scan detected'), planFullTip: t('Full scan: the whole table is read (an index may help)'), sorted: t('sorted by the database'), filtered: t('filtered by the database') })};
const hidden=new Set(),pinned=new Set();let results=[],cur=-1,lastSeq=-2,lastDoc;let cpAlpha=true;let dup={on:false,cols:null,only:true},dupMap=null,dupGroups=0;let editing=false;const staged=new Map();
function renderCrumbs(){
  const c=$('crumbs'),tr=grid&&grid.trail;
  if(!tr||tr.length<2){c.style.display='none';c.innerHTML='';return;}
  c.style.display='flex';
  c.innerHTML='<button id="cback">‹ '+T.back+'</button>'+tr.map((l,i)=>i===tr.length-1?'<b>'+esc(l)+'</b>':'<a data-i="'+i+'">'+esc(l)+'</a>').join('<span class="sep">›</span>')+'<button id="csql" title="'+esc(T.openSql)+'" style="margin-left:auto">SQL</button>';
  $('cback').onclick=()=>vs.postMessage({cmd:'crumb',index:tr.length-2});
  $('csql').onclick=()=>vs.postMessage({cmd:'crumbSql'});
  c.querySelectorAll('a[data-i]').forEach(a=>a.onclick=()=>vs.postMessage({cmd:'crumb',index:+a.dataset.i}));
}
function applyPins(){
  const tb=$('grid').querySelector('table');if(!tb||!pinned.size||!grid)return;
  const ths=[...tb.querySelectorAll('thead th')],idx=[0];
  ths.forEach((th,k)=>{if(k>0&&pinned.has(grid.columns[+th.dataset.i].name))idx.push(k);});
  const rows=[...tb.querySelectorAll('tr')];let left=0;
  idx.forEach(k=>{const w=ths[k].offsetWidth;rows.forEach(r=>{const c=r.children[k];if(c){c.classList.add('pin');c.style.left=left+'px';}});left+=w;});
}
function pickChip(i){cur=i;grid=results[i].grid;sortCol=-1;clientCrit=[];crit=grid.view?grid.view.filters.map(c=>({...c})):[];cJoin=grid.view?grid.view.join:'AND';render();}
function adopt(s){
  if(s.gridSeq!==lastSeq){
    const L=results.find(r=>r.seq===lastSeq);
    lastSeq=s.gridSeq;
    if(s.grid){
      const g=s.grid;
      if(L&&!L.cmp&&(L.grid.title===g.title||(g.trail&&g.trail.length>1)||(L.grid.trail&&L.grid.trail[0]===g.title))){L.grid=g;L.seq=lastSeq;}
      else{if(L){L.grid.canView=false;L.grid.edit=undefined;L.grid.hasMore=false;}results.push({grid:g,seq:lastSeq});if(results.length>6)results.shift();}
      cur=results.findIndex(r=>r.seq===lastSeq);
    }else{results=[];cur=-1;}
  }else if(s.grid){const L=results.find(r=>r.seq===lastSeq);if(L)L.grid=s.grid;}
  grid=results[cur]?results[cur].grid:null;
}
function chipLabel(r,i){return (r.cmp?'⇄ ':(i+1)+' · ')+esc(String(r.grid.title).slice(0,28));}
function renderChips(){
  const el=$('rs');
  if(results.length<2){el.style.display='none';el.innerHTML='';return;}
  el.style.display='flex';
  el.innerHTML=results.map((r,i)=>'<span class="chip'+(i===cur?' on':'')+'" data-i="'+i+'" title="'+esc(r.grid.title)+'">'+chipLabel(r,i)+(r.cmp?'':' <small>'+r.grid.rows.length+'</small>')+'<b class="cx" data-x="'+i+'">×</b></span>').join('')
    +'<select id="cmpsel"><option value="">'+T.compare+'</option>'+results.map((r,i)=>i===cur||r.cmp||results[cur]&&results[cur].cmp?'':'<option value="'+i+'">'+chipLabel(r,i)+'</option>').join('')+'</select>';
  el.querySelectorAll('.chip').forEach(c=>c.onclick=e=>{if(e.target.dataset.x!==undefined)return;pickChip(+c.dataset.i);});
  el.querySelectorAll('.cx').forEach(x=>x.onclick=e=>{e.stopPropagation();const i=+x.dataset.x;results.splice(i,1);if(!results.length){cur=-1;grid=null;render();return;}pickChip(Math.min(cur>i?cur-1:cur,results.length-1));});
  $('cmpsel').onchange=e=>{const j=e.target.value;if(j==='')return;const a=results[cur],b=results[+j],d=compareGrids(a.grid,b.grid,cur+1,+j+1);
    if(!d){e.target.value='';return;}
    const k=results.findIndex(r=>r.cmp);if(k>=0)results.splice(k,1);
    results.push({grid:d,seq:-1,cmp:true});pickChip(results.length-1);};
}
function compareGrids(a,b,na,nb){
  const bn=new Map(b.columns.map((c,i)=>[c.name.toLowerCase(),i]));
  const common=a.columns.map((c,i)=>({n:c.name,ty:c.type,ia:i,ib:bn.get(c.name.toLowerCase())})).filter(x=>x.ib!==undefined);
  if(!common.length)return null;
  const key=(r,w)=>JSON.stringify(common.map(c=>r[c[w]]));
  const cb=new Map();b.rows.forEach(r=>{const k=key(r,'ib');cb.set(k,(cb.get(k)||0)+1);});
  const rows=[];let same=0,onlyA=0,onlyB=0;
  a.rows.forEach(r=>{const k=key(r,'ia'),n=cb.get(k);if(n){cb.set(k,n-1);same++;}else{onlyA++;if(rows.length<3000)rows.push(['− '+na].concat(common.map(c=>r[c.ia])));}});
  b.rows.forEach(r=>{const k=key(r,'ib'),n=cb.get(k);if(n){cb.set(k,n-1);onlyB++;if(rows.length<3000)rows.push(['+ '+nb].concat(common.map(c=>r[c.ib])));}});
  return {title:'Δ '+na+' ↔ '+nb+' — '+same+' '+T.identical+' · '+onlyA+' '+T.onlyIn+' '+na+' · '+onlyB+' '+T.onlyIn+' '+nb,columns:[{name:'Δ',type:'text'}].concat(common.map(c=>({name:c.n,type:c.ty}))),rows:rows,hasMore:false,elapsedMs:0};
}
function pretty(v){
  if(v===null)return '(null)';if(typeof v!=='string')return String(v);const s=v.trim();
  if(/^[\\[{]/.test(s)){try{return JSON.stringify(JSON.parse(s),null,2);}catch(e){}}
  if(/^<[^>]+>/.test(s)){let d=0;return s.replace(/>\\s*</g,'>\\n<').split('\\n').map(l=>{if(/^<\\//.test(l))d=Math.max(0,d-1);const o='  '.repeat(d)+l;if(/^<[^!?\\/][^>]*[^\\/]>$/.test(l))d++;return o;}).join('\\n');}
  return v;
}
function showDetail(p,td){
  if(!grid)return;const [i,j]=p.split(':').map(Number),v=grid.rows[i]&&grid.rows[i][j];if(v===undefined)return;
  const open=$('dt').style.display==='flex';
  const long=typeof v==='string'&&((td&&td.scrollWidth>td.clientWidth+1)||v.length>80||/^\\s*[\\[{<]/.test(v));
  if(!open&&!long)return;
  $('dt').style.display='flex';$('dtn').textContent=grid.columns[j].name+' #'+(i+1);$('dtt').textContent=pretty(v);
}
function renderBanner(b){const el=$('banner');el.className=b?b.kind+(b.u?' loc':''):'';el.textContent=b?(b.kind==='ok'?'✓ ':b.kind==='err'?'✗ ':'⚠ ')+b.text:'';el.dataset.u=b&&b.u?b.u:'';el.dataset.l=b&&b.line?b.line:'';el.title=b&&b.u?T.bannerGo:'';}
function renderSummary(sum){
  const el=$('sumt');if(!sum||!sum.length){el.style.display='none';el.innerHTML='';return;}
  el.style.display='block';
  el.innerHTML='<table><thead><tr><th></th><th>'+T.sumLine+'</th><th>'+T.sumStmt+'</th><th>ms</th><th>'+T.sumRows+'</th></tr></thead><tbody>'+sum.map(r=>'<tr class="loc" data-u="'+esc(r.u)+'" data-l="'+r.line+'"><td'+(r.ok===1?'':' class="e"')+'>'+(r.ok===1?'✓':r.ok===2?'⚠':'✗')+'</td><td>'+r.line+'</td><td class="ml'+(r.ok===0?' e':'')+'" style="max-width:520px">'+esc(r.label)+'</td><td class="n">'+r.ms+'</td><td class="n">'+(r.n===undefined?'':r.n)+'</td></tr>').join('')+'</tbody></table>';
}
const FULL=/TABLE ACCESS (STORAGE )?(FULL|SAMPLE)|Seq Scan|Parallel Seq Scan|type[ :=|]+ALL\\b|SCAN(?!.*INDEX)\\s+(TABLE\\s+)?\\w+|\\|\\s*ALL\\s*\\|/i;
const IDX=/INDEX\\s+(UNIQUE|RANGE|FULL|FAST|SKIP)?\\s*SCAN|Index (Only )?Scan|Bitmap|USING (COVERING )?INDEX|SEARCH/i;
function renderPlan(text){
  const lines=String(text||'').split('\\n');let full=0,max=0;
  const cost=l=>{const m=/\\|\\s*(\\d+)\\s*\\(\\d+\\)\\s*\\|/.exec(l);return m?+m[1]:null;};
  lines.forEach(l=>{const c=cost(l);if(c!==null&&c>max)max=c;});
  $('plant').innerHTML='<pre>'+lines.map(l=>{const f=FULL.test(l)&&!/^\\s*\\|?\\s*Id\\b/.test(l);if(f)full++;const c=cost(l);
    return '<div class="'+(f?'pf':IDX.test(l)?'pi':'pl')+'"'+(f?' title="'+esc(T.planFullTip)+'"':'')+'>'+esc(l)+(c!==null&&max?'<span class="cb" style="width:'+Math.max(2,Math.round(c*120/max))+'px"></span>':'')+'</div>';}).join('')+'</pre>';
  $('plsum').textContent=lines.join('').trim()?(full?'⚠ '+T.fullScans.replace('{0}',full):'✓ '+T.planOk):'';
}
function kindOfCol(j){return kind(grid.columns[j].type);}
function startEdit(td){
  const [r,j]=td.dataset.e.split(':').map(Number);const key=r+':'+j;
  const cur=staged.has(key)?staged.get(key).v:grid.rows[r][j];
  const inp=document.createElement('input');inp.value=cur===null?'':String(cur);inp.style.cssText='width:100%;box-sizing:border-box;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-focusBorder);font:inherit;padding:0 2px';
  td.textContent='';td.appendChild(inp);inp.focus();inp.select();
  let done=false;
  const finish=(ok)=>{if(done)return;done=true;if(ok){let v=inp.value;const k=kindOfCol(j);
      if(v==='NULL'||(v===''&&k!=='t'))v=null;else if(k==='n'&&v!==''&&!isNaN(Number(v)))v=Number(v);
      const orig=grid.rows[r][j];if(String(v)===String(orig)&&(v===null)===(orig===null))staged.delete(key);else staged.set(key,{r:r,j:j,v:v});}
    render();};
  inp.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();finish(true);}else if(e.key==='Escape')finish(false);};
  inp.onblur=()=>finish(true);
}
function syncEditBar(){
  const can=!!(grid&&grid.edit);
  $('editbtn').style.display=can?'':'none';
  $('editbtn').style.fontWeight=editing?'700':'';
  $('applybtn').style.display=staged.size?'':'none';$('discardbtn').style.display=staged.size?'':'none';
  $('applybtn').textContent=T.applyN.replace('{0}',staged.size);
  if(editing&&can)$('status').textContent=T.editing;
}
function ord(){return grid.columns.map((c,i)=>i).sort((a,b)=>grid.columns[a].name.localeCompare(grid.columns[b].name,undefined,{sensitivity:'base'}));}
function kind(ty){ty=String(ty||'').toLowerCase();
  if(/bool|^bit\\b|tinyint\\(1\\)/.test(ty))return 'b';
  if(/date|time|interval/.test(ty))return 'd';
  if(/int|num|dec|float|double|real|serial|money|binary_|long$|smallint|bigint/.test(ty)&&!/point|interval/.test(ty))return 'n';
  if(/blob|clob|lob|raw|bytea|binary|image|bfile|xml|json/.test(ty))return 'l';
  if(/char|text|string|uuid|enum|set|name|rowid/.test(ty))return 't';
  return 'o';}
let grid=null,view=[],sortCol=-1,sortAsc=true,filter='',crit=[],cJoin='AND',clientCrit=[],clientJoin='AND';
const $=id=>document.getElementById(id);
let curTab='grid';
function tab(t){curTab=t;$('tools').dataset.t=t;$('menu').style.display='none';$('clr').style.display=(t==='log'||t==='errors'||t==='output')?'':'none';document.querySelectorAll('.tab').forEach(e=>e.classList.toggle('on',e.dataset.t===t));document.querySelectorAll('.pane').forEach(e=>e.classList.toggle('on',e.id===t));}
document.querySelectorAll('.tab').forEach(e=>e.onclick=()=>tab(e.dataset.t));
const esc=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
function recompute(){
  if(!grid){view=[];return;}
  view=grid.rows.map((r,i)=>[r,i]);
  if(!grid.canView&&clientCrit.length)view=view.filter(([r])=>clientJoin==='OR'?clientCrit.some(c=>matchCrit(r,c)):clientCrit.every(c=>matchCrit(r,c)));
  if(filter){const f=filter.toLowerCase(),ci=+$('fcol').value;view=view.filter(([r])=>ci>=0?(r[ci]!==null&&String(r[ci]).toLowerCase().includes(f)):r.some(v=>v!==null&&String(v).toLowerCase().includes(f)));}
  if(!grid.canView&&sortCol>=0)view.sort((a,b)=>{const x=a[0][sortCol],y=b[0][sortCol];
    if(x===null)return y===null?0:1;if(y===null)return -1;
    const c=(typeof x==='number'&&typeof y==='number')?x-y:String(x).localeCompare(String(y),undefined,{numeric:true});
    return sortAsc?c:-c;});
  dupMap=null;dupGroups=0;
  if(dup.on){
    const cs=[...dupCols()];const keyOf=r=>JSON.stringify(cs.map(j=>r[j]));
    const cnt=new Map();grid.rows.forEach(r=>{const k=keyOf(r);cnt.set(k,(cnt.get(k)||0)+1);});
    dupMap=new Map();const gid=new Map();
    grid.rows.forEach((r,i)=>{const k=keyOf(r),n=cnt.get(k);if(n>1){if(!gid.has(k))gid.set(k,dupGroups++);dupMap.set(i,{n:n,g:gid.get(k)});}});
    if(dup.only){view=view.filter(p=>dupMap.has(p[1]));if(sortCol<0)view.sort((a,b)=>dupMap.get(a[1]).g-dupMap.get(b[1]).g||a[1]-b[1]);}
  }
}
function dupCols(){
  if(dup.cols&&dup.cols.size)return dup.cols;
  const all=grid.columns.map((c,i)=>i),k=grid.keys||[];
  const nonPk=all.filter(i=>!(k[i]||'').includes('P')); // par défaut : tout sauf la clé primaire (qui est unique par définition)
  return new Set(nonPk.length?nonPk:all);
}
function cmp(v,w){if(typeof v==='number'&&w!==''&&w!==undefined&&!isNaN(Number(w)))return v-Number(w);return String(v).localeCompare(String(w),undefined,{numeric:true});}
function matchCrit(r,c){const v=r[c.col],s=v===null?null:String(v),q=(c.value||'').toLowerCase();
  switch(c.op){case 'null':return v===null;case 'notnull':return v!==null;
    case 'contains':return s!==null&&s.toLowerCase().includes(q);case 'starts':return s!==null&&s.toLowerCase().startsWith(q);case 'ends':return s!==null&&s.toLowerCase().endsWith(q);
    case 'in':return s!==null&&(c.value||'').split(/[,;\\n]/).map(x=>x.trim().toLowerCase()).filter(Boolean).includes(s.toLowerCase());
    case 'between':return v!==null&&cmp(v,c.value)>=0&&cmp(v,c.value2)<=0;
    default:{if(v===null)return false;const k=cmp(v,c.value);return c.op==='eq'?k===0:c.op==='ne'?k!==0:c.op==='gt'?k>0:c.op==='ge'?k>=0:c.op==='lt'?k<0:k<=0;}}}
function activeFilters(){return grid&&grid.canView?((grid.view&&grid.view.filters)||[]):clientCrit;}
function currentSort(){if(!grid)return null;if(grid.canView)return (grid.view&&grid.view.sort)||null;return sortCol>=0?{col:sortCol,dir:sortAsc?'asc':'desc'}:null;}
function sendView(sort,filters,join){vs.postMessage({cmd:'view',view:{sort:sort,filters:filters,join:join}});}
function renderFB(){
  const fb=$('fb');if(!grid||fb.dataset.open!=='1'){fb.style.display='none';return;}
  fb.style.display='block';
  const cols=ord().map(i=>'<option value="'+i+'">'+esc(grid.columns[i].name)+'</option>').join('');
  const ops=Object.entries(T.ops).map(([k,v])=>'<option value="'+k+'">'+esc(v)+'</option>').join('');
  fb.innerHTML=crit.map((c,i)=>'<div class="crit" data-i="'+i+'"><select class="c">'+cols+'</select><select class="o">'+ops+'</select>'
    +(c.op==='null'||c.op==='notnull'?'':'<input class="v" placeholder="'+T.value+'" value="'+esc(c.value||'')+'">')
    +(c.op==='between'?'<span>'+T.and+'</span><input class="v2" placeholder="'+T.value+'" value="'+esc(c.value2||'')+'">':'')
    +'<button class="x" title="×">×</button></div>').join('')
    +'<div class="foot"><button id="addc">'+T.addCrit+'</button><select id="joinsel"><option value="AND">'+T.all+'</option><option value="OR">'+T.any+'</option></select><button id="applyf" class="primary">'+T.apply+'</button><button id="clearf">'+T.clearF+'</button></div>';
  fb.querySelectorAll('.crit').forEach(row=>{const i=+row.dataset.i,c=crit[i];
    row.querySelector('.c').value=c.col;row.querySelector('.o').value=c.op;
    row.querySelector('.c').onchange=e=>{c.col=+e.target.value;};
    row.querySelector('.o').onchange=e=>{c.op=e.target.value;renderFB();};
    const v=row.querySelector('.v');if(v)v.oninput=e=>{c.value=e.target.value;};
    const v2=row.querySelector('.v2');if(v2)v2.oninput=e=>{c.value2=e.target.value;};
    row.querySelector('.x').onclick=()=>{crit.splice(i,1);renderFB();};
    row.querySelectorAll('input').forEach(inp=>inp.onkeydown=e=>{if(e.key==='Enter')$('applyf').click();});
  });
  $('joinsel').value=cJoin;$('joinsel').onchange=e=>{cJoin=e.target.value;};
  $('addc').onclick=()=>{crit.push({col:0,op:'contains',value:''});renderFB();};
  $('applyf').onclick=()=>{fb.dataset.open='0';const list=crit.filter(c=>c.op==='null'||c.op==='notnull'||(c.value!==undefined&&c.value!==''));
    if(grid.canView)sendView(currentSort(),list,cJoin);else{clientCrit=list;clientJoin=cJoin;render();}};
  $('clearf').onclick=()=>{crit=[];cJoin='AND';if(grid.canView)sendView(currentSort(),[],'AND');else{clientCrit=[];render();}renderFB();};
}
function syncFcol(){
  const sel=$('fcol'),sig=grid?grid.columns.map(c=>c.name).join('|'):'';
  if(sel.dataset.sig===sig)return;
  const cur=sel.value;sel.dataset.sig=sig;
  sel.innerHTML='<option value="-1">'+T.allCols+'</option>'+(grid?ord().map(i=>'<option value="'+i+'">'+esc(grid.columns[i].name)+'</option>').join(''):'');
  if([...sel.options].some(o=>o.value===cur))sel.value=cur;
}
function render(){
  syncFcol();
  recompute();
  const nf=activeFilters().length;$('fbtn').textContent=T.filter+(nf?' ('+nf+')':'');$('fbtn').style.fontWeight=nf?'700':'';
  if(!grid){$('grid').innerHTML='<pre>'+T.noresult+'</pre>';status();return;}
  const kf=grid.keys||[],kl=grid.links||[],ks=grid.columns.map(c=>kind(c.type)),vis0=grid.columns.map((c,i)=>i).filter(i=>!hidden.has(grid.columns[i].name)),vis=pinned.size?vis0.filter(i=>pinned.has(grid.columns[i].name)).concat(vis0.filter(i=>!pinned.has(grid.columns[i].name))):vis0;
  let h='<table><thead><tr><th>#</th>'+vis.map(i=>{const c=grid.columns[i];return '<th class="k-'+ks[i]+'" data-i="'+i+'" title="'+esc(c.type)+'">'+(pinned.has(c.name)?'📌':'')+(kf[i]?'<span class="ki">'+(kf[i].includes('P')?'🔑':'')+(kf[i].includes('F')?'🔗':'')+'</span>':'')+esc(c.name)+(currentSort()&&currentSort().col===i?'<span class="si">'+(currentSort().dir==='asc'?'▲':'▼')+'</span>':'')+'</th>';}).join('')+'</tr></thead><tbody>';
  for(const [r,i] of view){const dd=dupMap&&dupMap.get(i);h+='<tr'+(dd?' class="dg'+(dd.g%6)+'"':'')+'><td class="rn">'+(i+1)+(dd?'<span class="dn">×'+dd.n+'</span>':'')+'</td>'+vis.map(j=>{const v=r[j];const sk=i+':'+j,st=staged.get(sk),ed=editing&&grid.edit&&grid.edit.cols[j];if(st||ed){const vv=st?st.v:v;return '<td class="c-'+ks[j]+(typeof vv==='number'?' n':'')+(st?' mod':'')+(ed?' ed':'')+(vv===null?' null':'')+'" data-e="'+sk+'">'+(vv===null?'(null)':esc(vv))+'</td>';}
    const lk=kl[j]&&kl[j].length&&v!==null;return v===null?'<td class="null" data-p="'+i+':'+j+'">(null)</td>':'<td data-p="'+i+':'+j+'" class="c-'+ks[j]+(typeof v==='number'?' n':'')+(lk?' lk':'')+'" title="'+esc(v)+(lk?'  ⟶ '+kl[j].map(l=>(l.k==='p'?T.parentTip:T.childTip)+': '+l.t).join(', '):'')+'"'+(lk?' data-r="'+i+'" data-c="'+j+'"':'')+'>'+esc(v)+'</td>';}).join('')+'</tr>';}
  const used=[...new Set(vis.map(i=>ks[i]))];
  $('legend').innerHTML=used.length?'<b>'+T.typesLbl+'</b>'+used.map(k=>'<span class="lg k-'+k+'">'+T.kinds[k]+'</span>').join('')+(kf.some(x=>x)?'<span>'+(kf.some(x=>x.includes('P'))?'🔑 '+T.pk+'&nbsp;&nbsp;':'')+(kf.some(x=>x.includes('F'))?'🔗 '+T.fk:'')+'</span>':'')+(kl.some(l=>l&&l.length)?'<span>↗ '+T.follow+'</span>':'')+'<span>'+T.pinHint+'</span>':'';
  $('colbtn').textContent=T.colsLbl+(hidden.size?' (-'+hidden.size+')':'');
  $('grid').innerHTML=h+'</tbody></table>';
  $('grid').querySelectorAll('th[data-i]').forEach(th=>th.onclick=()=>{const i=+th.dataset.i;
    if(grid.canView){const cur=currentSort();let next;if(!cur||cur.col!==i)next={col:i,dir:'asc'};else if(cur.dir==='asc')next={col:i,dir:'desc'};else next=null;
      sendView(next,(grid.view&&grid.view.filters)||[],(grid.view&&grid.view.join)||'AND');}
    else{if(sortCol===i)sortAsc=!sortAsc;else{sortCol=i;sortAsc=true;}render();}});
  $('grid').querySelectorAll('td.ed').forEach(td=>td.ondblclick=e=>{e.stopPropagation();startEdit(td);});
  $('grid').querySelectorAll('th[data-i]').forEach(th=>th.oncontextmenu=e=>{e.preventDefault();const n=grid.columns[+th.dataset.i].name;if(pinned.has(n))pinned.delete(n);else pinned.add(n);render();});
  applyPins();
  syncEditBar();
  renderCrumbs();renderChips();
  $('grid').querySelectorAll('td[data-c]').forEach(td=>td.onclick=e=>{if(!(e.ctrlKey||e.metaKey))return;vs.postMessage({cmd:'follow',links:kl[+td.dataset.c],vals:grid.rows[+td.dataset.r],newEditor:e.shiftKey,choose:e.altKey});});
  $('grid').querySelectorAll('td').forEach(td=>td.ondblclick=()=>navigator.clipboard&&navigator.clipboard.writeText(td.textContent));
  $('more').style.display=grid.hasMore?'':'none';$('all').style.display=grid.hasMore?'':'none';
  renderFB();renderCP();renderDP();
  status();
}
function status(){if(!grid){$('status').textContent='';return;}
  $('status').textContent=grid.title+' —'+T.rows.replace('{0}',grid.rows.length)+(view.length!==grid.rows.length?T.shown.replace('{0}',view.length):'')+(grid.hasMore?T.more:'')+(dupMap?' — '+T.dupSummary.replace('{0}',dupMap.size).replace('{1}',dupGroups):'')+(grid.canView&&grid.view?' — '+(grid.view.sort?T.sorted:'')+(grid.view.sort&&grid.view.filters.length?', ':'')+(grid.view.filters.length?T.filtered:''):'')+' — '+grid.elapsedMs+' ms';}
let logLines=[];
const ERR_HEAD=/^(✗|⚠|ORA-|PLS-|SP2-|NJS-|Erreur|Error)/;
function parseLog(l){const m=/^\\u0001([^|]*)\\|(\\d+)\\u0001([\\s\\S]*)$/.exec(l);return m?{u:m[1],n:+m[2],t:m[3]}:{t:l};}
function logRow(p,inErr){const cls=[ERR_HEAD.test(p.t)?'err':'',p.u?'loc':'',/^━━/.test(p.t)?'runhead':''].filter(Boolean).join(' ');
  return '<div'+(cls?' class="'+cls+'"':'')+(p.u?' data-u="'+esc(p.u)+'" data-l="'+p.n+'" title="'+esc(p.t)+'"':'')+'>'+esc(p.t)+'</div>';}
/** Messages d'un côté, erreurs (✗ ⚠ ORA- PLS-… et leurs lignes indentées) de l'autre ; renvoie true si la dernière ligne est une erreur. */
function setLog(lines){logLines=lines;let inErr=false;const msgs=[],errs=[];let heads=0;
  for(const raw of lines){const p=parseLog(raw);if(ERR_HEAD.test(p.t)){inErr=true;heads++;}else if(!/^\\s/.test(p.t))inErr=false;(inErr?errs:msgs).push(logRow(p));}
  $('logt').innerHTML=msgs.join('');$('errt').innerHTML=errs.join('');
  const b=$('errn');b.style.display=heads?'':'none';b.textContent=heads;
  return inErr;}
document.addEventListener('click',e=>{const a=e.target.closest&&e.target.closest('.loc');if(a)vs.postMessage({cmd:'goto',uri:a.dataset.u,line:+a.dataset.l});});
window.addEventListener('message',e=>{const m=e.data;
  if(m.type==='state'){const s=m.state;const prevTitle=grid&&grid.title;staged.clear();adopt(s);if(s.activeDoc!==lastDoc){lastDoc=s.activeDoc;const k=results.map(r=>r.grid.doc).lastIndexOf(lastDoc);if(lastDoc&&k>=0&&k!==cur){cur=k;grid=results[k].grid;}}if(!prevTitle||grid&&grid.title!==prevTitle)dup.cols=null;if(!grid||grid.title!==prevTitle||!grid.view){if(!grid||grid.title!==prevTitle){sortCol=-1;clientCrit=[];}if(grid&&grid.view){crit=grid.view.filters.map(c=>({...c}));cJoin=grid.view.join;}else if(!grid||grid.title!==prevTitle)crit=[];}else{crit=grid.view.filters.map(c=>({...c}));cJoin=grid.view.join;}render();const logErr=setLog(s.log);$('outt').textContent=s.output;renderPlan(s.plan);renderSummary(s.summary);renderBanner(s.banner);tab(s.tab==='log'&&logErr?'errors':s.tab);}
  else if(m.type==='append'){const L=results.find(r=>r.seq===lastSeq),g=L?L.grid:grid;if(g){g.rows.push(...m.rows);g.hasMore=m.hasMore;}render();}
  else if(m.type==='log'){logLines.push(m.line);setLog(logLines);}
  else if(m.type==='editResult'){$('applybtn').disabled=false;
    if(m.ok){for(const s of staged.values())grid.rows[s.r][s.j]=s.v;staged.clear();render();}
    else if(m.msg){const d=document.createElement('div');d.className='err';d.textContent=m.msg;$('logt').appendChild(d);tab('log');}}
  else if(m.type==='dirty'){$('dirtybar').style.display=m.on?'flex':'none';$('dirtytxt').textContent=T.dirty+(m.name?' — '+m.name:'');}
  else if(m.type==='busy'){$('cancel').style.display=m.busy?'':'none';
    clearInterval(window.__bt);
    if(m.busy){const t0=m.startedAt||Date.now(),lbl=(m.label||'').slice(0,80);
      const tick=()=>{const s=Math.floor((Date.now()-t0)/1000);$('busytxt').textContent=T.running+String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0')+(lbl?' — '+lbl:'')+(m.timeoutSec?' — '+T.timeout.replace('{0}',m.timeoutSec):'');};
      tick();window.__bt=setInterval(tick,250);$('busybar').style.display='flex';}
    else $('busybar').style.display='none';}
});
$('filter').oninput=e=>{filter=e.target.value;render();};
$('fcol').onchange=()=>render();
$('more').onclick=()=>vs.postMessage({cmd:'fetchMore'});
$('all').onclick=()=>vs.postMessage({cmd:'fetchAll'});
$('mbtn').onclick=e=>{e.stopPropagation();const m=$('menu');m.style.display=m.style.display==='flex'?'none':'flex';};
document.addEventListener('click',e=>{const m=$('menu');if(m.style.display==='flex'&&!(e.target.closest&&e.target.closest('#menu button')&&false))m.style.display='none';});
$('fbtn').onclick=()=>{const fb=$('fb');if(fb.dataset.open==='1')fb.dataset.open='0';else{fb.dataset.open='1';if(!crit.length)crit=[{col:0,op:'contains',value:''}];}renderFB();};
function renderCP(){const p=$('cp');if(!grid||p.dataset.open!=='1'){p.style.display='none';return;}
  p.style.display='block';
  p.innerHTML='<div style="margin-bottom:4px"><button id="cpall">'+T.allBtn+'</button> <button id="cpnone">'+T.noneBtn+'</button> <label><input type="checkbox" id="cpa"'+(cpAlpha?' checked':'')+'>A→Z</label></div>'+(cpAlpha?ord():grid.columns.map((c,i)=>i)).map(i=>{const c=grid.columns[i];return '<label><input type="checkbox" data-n="'+i+'"'+(hidden.has(c.name)?'':' checked')+'>'+esc(c.name)+'</label>';}).join('');
  $('cpa').onchange=e=>{cpAlpha=e.target.checked;renderCP();};
  p.querySelectorAll('input[data-n]').forEach(cb=>cb.onchange=()=>{const n=grid.columns[+cb.dataset.n].name;if(cb.checked)hidden.delete(n);else hidden.add(n);render();});
  $('cpall').onclick=()=>{hidden.clear();render();};
  $('cpnone').onclick=()=>{grid.columns.forEach(c=>hidden.add(c.name));render();};}
$('editbtn').onclick=()=>{editing=!editing;if(!editing)staged.clear();render();};
$('discardbtn').onclick=()=>{staged.clear();render();};
$('applybtn').onclick=()=>{const by=new Map();
  for(const s of staged.values()){if(!by.has(s.r))by.set(s.r,[]);by.get(s.r).push({col:s.j,v:s.v});}
  const edits=[...by].map(([r,set])=>({pk:grid.edit.pk.map(i=>grid.rows[r][i]),set:set,r:r}));
  $('applybtn').disabled=true;vs.postMessage({cmd:'applyEdits',edits:edits.map(e=>({pk:e.pk,set:e.set}))});};
function renderDP(){const p=$('dp');if(!grid||p.dataset.open!=='1'){p.style.display='none';return;}
  p.style.display='block';
  const sel=dupCols();
  const sum=dupMap?(dupMap.size?T.dupSummary.replace('{0}',dupMap.size).replace('{1}',dupGroups):T.dupNone)+(grid.hasMore?T.dupPartial:''):'';
  p.innerHTML='<div style="margin-bottom:4px"><b>'+T.dupTitle+'</b> <label><input type="checkbox" id="dpon"'+(dup.on?' checked':'')+'>'+T.dupOn+'</label><label><input type="checkbox" id="dponly"'+(dup.only?' checked':'')+'>'+T.dupOnly+'</label><button id="dpall">'+T.allBtn+'</button> <button id="dpnone">'+T.noneBtn+'</button> <button id="dpwhy" title="'+esc(T.dupWhyTip)+'">'+T.dupWhy+'</button> <span id="dpsum" style="opacity:.85">'+esc(sum)+'</span></div>'
    +ord().map(i=>'<label><input type="checkbox" data-d="'+i+'"'+(sel.has(i)?' checked':'')+'>'+esc(grid.columns[i].name)+'</label>').join('');
  $('dpwhy').onclick=()=>vs.postMessage({cmd:'dupDiagnose'});
  $('dpon').onchange=e=>{dup.on=e.target.checked;render();};
  $('dponly').onchange=e=>{dup.only=e.target.checked;render();};
  $('dpall').onclick=()=>{dup.cols=new Set(grid.columns.map((c,i)=>i));render();};
  $('dpnone').onclick=()=>{dup.cols=new Set();dup.cols.add(0);dup.cols.clear();render();};
  p.querySelectorAll('input[data-d]').forEach(cb=>cb.onchange=()=>{const s=new Set(dupCols());const i=+cb.dataset.d;if(cb.checked)s.add(i);else s.delete(i);dup.cols=s;render();});}
$('dupbtn').onclick=()=>{const p=$('dp');const open=p.dataset.open!=='1';p.dataset.open=open?'1':'0';dup.on=open;render();};
$('colbtn').onclick=()=>{const p=$('cp');p.dataset.open=p.dataset.open==='1'?'0':'1';renderCP();};
$('grid').addEventListener('click',e=>{if(e.ctrlKey||e.metaKey||editing)return;const td=e.target.closest&&e.target.closest('td[data-p]');if(td&&!td.querySelector('input'))showDetail(td.dataset.p,td);});
$('dtx').onclick=()=>{$('dt').style.display='none';};
$('dtcopy').onclick=()=>navigator.clipboard&&navigator.clipboard.writeText($('dtt').textContent);
document.addEventListener('keydown',e=>{
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='f'&&curTab==='grid'){e.preventDefault();$('filter').focus();$('filter').select();}
  else if(e.key==='Escape'){if($('dt').style.display==='flex')$('dt').style.display='none';else if($('menu').style.display==='flex')$('menu').style.display='none';else if($('filter')===document.activeElement&&$('filter').value){$('filter').value='';filter='';render();}}
});
$('exp').onclick=()=>vs.postMessage({cmd:'export'});
$('cancel').onclick=()=>vs.postMessage({cmd:'cancel'});
$('clr').onclick=()=>vs.postMessage({cmd:'clear',tab:curTab});
$('cancel2').onclick=()=>vs.postMessage({cmd:'cancel'});
$('dcommit').onclick=()=>vs.postMessage({cmd:'commit'});
$('drollback').onclick=()=>vs.postMessage({cmd:'rollback'});
$('cancel').style.display='none';
$('copy').onclick=()=>{if(!grid)return;const vi=grid.columns.map((c,i)=>i).filter(i=>!hidden.has(grid.columns[i].name));const t=vi.map(i=>grid.columns[i].name).join('\\t')+'\\n'+view.map(([r])=>vi.map(i=>r[i]===null?'':r[i]).join('\\t')).join('\\n');navigator.clipboard.writeText(t);};
vs.postMessage({cmd:'ready'});
</script></body></html>`;
}
