import * as vscode from 'vscode';
import { ConnectionManager } from './connections';
import { colorHex } from './palette';

/**
 * Code couleur par connexion sur les éditeurs SQL :
 *  - onglet : titre coloré + pastille (décoration de fichier, couleurs « dbexplorer.color.* » personnalisables) ;
 *  - éditeur : liseré coloré à gauche et marque dans la règle de défilement.
 * Un éditeur est lié à une connexion (création via « Nouvel éditeur SQL » ou première exécution).
 */
export class EditorColors implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.emitter.event;
  private readonly types = new Map<string, vscode.TextEditorDecorationType>();
  private readonly subs: vscode.Disposable[] = [];
  private timer?: NodeJS.Timeout;

  constructor(private readonly mgr: ConnectionManager) {
    this.subs.push(
      mgr.onDidChange(() => this.refresh()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.applyAll()),
      vscode.window.onDidChangeActiveTextEditor(() => this.applyAll()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.languageId === 'sql' && e.contentChanges.some((c) => c.text.includes('\n') || c.range.start.line !== c.range.end.line)) this.schedule();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('dbexplorer.colorEditors')) this.refresh();
      })
    );
  }

  private enabled() {
    return vscode.workspace.getConfiguration('dbexplorer').get<boolean>('colorEditors', true);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (!this.enabled()) return undefined;
    const pid = this.mgr.bound(uri);
    const p = pid ? this.mgr.get(pid) : undefined;
    if (!p?.color || !colorHex(p.color)) return undefined;
    return { badge: '●', color: new vscode.ThemeColor('dbexplorer.color.' + p.color), tooltip: p.name };
  }

  refresh() {
    this.emitter.fire(undefined);
    this.applyAll();
  }

  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.applyAll(), 250);
  }

  private type(hex: string) {
    let t = this.types.get(hex);
    if (!t) {
      t = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        borderStyle: 'solid',
        borderColor: hex,
        borderWidth: '0 0 0 3px',
        overviewRulerColor: hex,
        overviewRulerLane: vscode.OverviewRulerLane.Left,
      });
      this.types.set(hex, t);
    }
    return t;
  }

  private applyAll() {
    const on = this.enabled();
    for (const ed of vscode.window.visibleTextEditors) {
      if (ed.document.languageId !== 'sql') continue;
      const pid = on ? this.mgr.bound(ed.document.uri) : undefined;
      const hex = colorHex(pid ? this.mgr.get(pid)?.color : undefined);
      const whole = [new vscode.Range(0, 0, Math.max(0, ed.document.lineCount - 1), 0)];
      for (const [h, t] of this.types) if (h !== hex) ed.setDecorations(t, []);
      if (hex) ed.setDecorations(this.type(hex), whole);
    }
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.subs.forEach((s) => s.dispose());
    this.types.forEach((t) => t.dispose());
    this.emitter.dispose();
  }
}
