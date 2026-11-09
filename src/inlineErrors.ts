import * as vscode from 'vscode';
import { split } from './splitter';
import { maskText } from './completion';
import { planWrite } from './writePreview';
import { cleanSql } from './splitter';
import { t } from './i18n';

export const DIAG_SOURCE = 'DB Explorer';

const ERR_BG = 'rgba(241, 76, 76, 0.10)';
const WARN_BG = 'rgba(224, 164, 88, 0.10)';
const ERR_TEXT = 'rgba(241, 120, 120, 0.70)';
const WARN_TEXT = 'rgba(224, 175, 104, 0.80)';

/**
 * Erreurs et avertissements bien visibles dans l'éditeur : fond teinté sur la ligne et message en rouge / orange grisé
 * à la fin de la ligne concernée (en plus du soulignement et de l'onglet Problèmes).
 * Contrôles instantanés (sans base de données) : parenthèses non équilibrées, UPDATE / DELETE sans WHERE.
 */
export function registerInlineErrors(ctx: vscode.ExtensionContext, forget: (uri: vscode.Uri, fromLine: number, toLine: number) => void) {
  const errType = vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: ERR_BG });
  const warnType = vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: WARN_BG });
  const lint = vscode.languages.createDiagnosticCollection('dbexplorer-live');
  const cfg = () => vscode.workspace.getConfiguration('dbexplorer');

  const decorate = (ed: vscode.TextEditor) => {
    if (ed.document.languageId !== 'sql') return;
    if (!cfg().get<boolean>('inlineErrors', true)) {
      ed.setDecorations(errType, []);
      ed.setDecorations(warnType, []);
      return;
    }
    const byLine = new Map<number, vscode.Diagnostic[]>();
    for (const d of vscode.languages.getDiagnostics(ed.document.uri)) {
      if (d.source !== DIAG_SOURCE || d.severity > vscode.DiagnosticSeverity.Warning) continue;
      const l = d.range.start.line;
      byLine.set(l, [...(byLine.get(l) ?? []), d]);
    }
    const errs: vscode.DecorationOptions[] = [];
    const warns: vscode.DecorationOptions[] = [];
    for (const [line, list] of byLine) {
      if (line >= ed.document.lineCount) continue;
      const sorted = [...list].sort((a, b) => a.severity - b.severity);
      const d = sorted[0];
      const isErr = d.severity === vscode.DiagnosticSeverity.Error;
      const msg = d.message.split('\n')[0].trim();
      const text = `   ${isErr ? '✗' : '⚠'} ${msg.length > 180 ? msg.slice(0, 177) + '…' : msg}${sorted.length > 1 ? `  (+${sorted.length - 1})` : ''}`;
      const end = ed.document.lineAt(line).range.end;
      const opt: vscode.DecorationOptions = {
        range: new vscode.Range(end, end),
        hoverMessage: new vscode.MarkdownString(sorted.map((x) => (x.severity === vscode.DiagnosticSeverity.Error ? '**✗** ' : '**⚠** ') + x.message.replace(/\n/g, '  \n')).join('\n\n')),
        renderOptions: { after: { contentText: text, color: isErr ? ERR_TEXT : WARN_TEXT, fontStyle: 'italic', margin: '0 0 0 1em' } },
      };
      (isErr ? errs : warns).push(opt);
    }
    ed.setDecorations(errType, errs);
    ed.setDecorations(warnType, warns);
  };
  const decorateAll = () => vscode.window.visibleTextEditors.forEach(decorate);

  // ---- contrôles instantanés
  const check = (doc: vscode.TextDocument) => {
    if (doc.languageId !== 'sql' || !cfg().get<boolean>('liveChecks', true) || doc.getText().length > 300_000) return void lint.delete(doc.uri);
    const diags: vscode.Diagnostic[] = [];
    const add = (from: number, to: number, msg: string, sev: vscode.DiagnosticSeverity) => {
      const d = new vscode.Diagnostic(new vscode.Range(doc.positionAt(from), doc.positionAt(to)), msg, sev);
      d.source = DIAG_SOURCE;
      diags.push(d);
    };
    for (const s of split(doc.getText(), 'oracle')) {
      if (s.isSqlplus) continue;
      const masked = maskText(s.text);
      // parenthèses
      const open: number[] = [];
      for (let i = 0; i < masked.length; i++) {
        if (masked[i] === '(') open.push(i);
        else if (masked[i] === ')') {
          if (open.length) open.pop();
          else add(s.start + i, s.start + i + 1, t('Unexpected closing parenthesis.'), vscode.DiagnosticSeverity.Error);
        }
      }
      for (const i of open) add(s.start + i, s.start + i + 1, t('Missing closing parenthesis.'), vscode.DiagnosticSeverity.Error);
      // UPDATE / DELETE sans WHERE
      if (!s.isPlsql && !/^\s*create\b/i.test(s.text)) {
        const plan = planWrite(cleanSql(s.text, false));
        if (plan && !plan.hasWhere) {
          const m = /^\s*(update|delete)\b/i.exec(s.text);
          if (m) add(s.start + m.index + m[0].length - m[1].length, s.start + m.index + m[0].length, plan.kind === 'DELETE' ? t('No WHERE clause: every row of the table will be deleted.') : t('No WHERE clause: every row of the table will be updated.'), vscode.DiagnosticSeverity.Warning);
        }
      }
    }
    lint.set(doc.uri, diags);
  };
  const timers = new Map<string, NodeJS.Timeout>();
  const later = (doc: vscode.TextDocument) => {
    const k = doc.uri.toString();
    clearTimeout(timers.get(k));
    timers.set(k, setTimeout(() => check(doc), 400));
  };

  ctx.subscriptions.push(
    errType,
    warnType,
    lint,
    vscode.languages.onDidChangeDiagnostics((e) => {
      const set = new Set(e.uris.map((u) => u.toString()));
      for (const ed of vscode.window.visibleTextEditors) if (set.has(ed.document.uri.toString())) decorate(ed);
    }),
    vscode.window.onDidChangeVisibleTextEditors(decorateAll),
    vscode.workspace.onDidOpenTextDocument(check),
    vscode.workspace.onDidCloseTextDocument((d) => lint.delete(d.uri)),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.languageId !== 'sql') return;
      // une ligne modifiée n'a plus son erreur d'exécution : elle disparaît dès qu'on la retouche
      for (const c of e.contentChanges) forget(e.document.uri, c.range.start.line, c.range.end.line + (c.text.split('\n').length - 1));
      later(e.document);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('dbexplorer.inlineErrors') || e.affectsConfiguration('dbexplorer.liveChecks')) {
        vscode.workspace.textDocuments.forEach(check);
        decorateAll();
      }
    })
  );
  vscode.workspace.textDocuments.forEach(check);
  decorateAll();
}
