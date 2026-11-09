import * as vscode from 'vscode';
import { ConnectionManager } from './connections';
import { split } from './splitter';
import { dialectOf } from './runner';
import { parseRefList, maskText } from './completion';
import { t } from './i18n';
import { RoutineCache } from './routines';
import { within, TIMEOUT } from './metaCache';

const escapeRe = (s: string) => s.replace(/[$#.*+?^()[\]{}|\\]/g, '\\$&');

/**
 * Ctrl+clic sur un nom de table / vue du SQL : ouvre « Describe Object » (colonnes, index, contraintes, référentiel, données).
 * Implémenté en liens de document : le soulignement n'apparaît qu'avec Ctrl, comme « Aller à la définition ».
 */
export class ObjectLinks implements vscode.DocumentLinkProvider {
  constructor(private readonly mgr: ConnectionManager, private readonly routines: RoutineCache) {}

  async provideDocumentLinks(doc: vscode.TextDocument): Promise<vscode.DocumentLink[]> {
    const text = doc.getText();
    if (text.length > 400_000) return [];
    const act = this.mgr.forDocument(doc.uri) ?? this.mgr.active;
    const dialect = act ? dialectOf(act.session.conn.kind) : 'oracle';
    const out: vscode.DocumentLink[] = [];
    for (const s of split(text, dialect)) {
      const masked = maskText(s.text);
      let refs: ReturnType<typeof parseRefList> = [];
      try {
        refs = parseRefList(s.text, s.text.length).filter((r) => !r.virtual);
      } catch {
        continue;
      }
      const done = new Set<string>();
      for (const r of refs) {
        const key = r.table.toLowerCase();
        if (done.has(key)) continue;
        done.add(key);
        const body = r.table
          .split('.')
          .map((p) => '"?' + escapeRe(p) + '"?')
          .join('\\s*\\.\\s*');
        const re = new RegExp('(?:^|[^\\w$#."])(' + body + ')(?![\\w$#".(])', 'gi');
        let m: RegExpExecArray | null;
        while ((m = re.exec(masked))) {
          const offset = m.index + m[0].length - m[1].length;
          // seulement une table citée après FROM / JOIN / UPDATE / INTO / TABLE ou dans une liste de tables
          if (!/(?:\b(?:from|join|update|into|table|using|merge)|,)$/i.test(masked.slice(0, offset).trimEnd())) continue;
          if (s.text.slice(0, offset).trimEnd().endsWith('"')) continue; // « "Table" alias » : le nom cité n'est pas analysé, on n'y devine rien
          const start = s.start + offset;
          const name = m[1].replace(/\s+/g, '').replace(/"/g, '');
          const link = new vscode.DocumentLink(
            new vscode.Range(doc.positionAt(start), doc.positionAt(start + m[1].length)),
            vscode.Uri.parse('command:dbexplorer.describeName?' + encodeURIComponent(JSON.stringify([name, doc.uri.toString()])))
          );
          link.tooltip = t('Ctrl+click: describe {0}', r.table);
          out.push(link);
        }
      }
    }
    out.push(...(await this.routineLinks(doc, text, act)));
    return out;
  }

  /** Appels de packages / procédures / fonctions : « pkg.proc », « proc( » — Ctrl+clic ouvre leur description. */
  private async routineLinks(doc: vscode.TextDocument, text: string, act: { profile: { id: string }; session: { conn: import('./drivers/types').DbConn } } | undefined): Promise<vscode.DocumentLink[]> {
    if (!act?.session.conn.routines) return [];
    const list = await within(this.routines.list(act.profile.id, act.session.conn, act.session.conn.currentSchema), 1500);
    if (list === TIMEOUT || !list.length) return [];
    const byName = new Map(list.map((r) => [r.name.toLowerCase(), r.type]));
    const masked = maskText(text);
    const out: vscode.DocumentLink[] = [];
    const re = /(?<![\w$#."])([A-Za-z_][\w$#]*)(?:\s*\.\s*([A-Za-z_][\w$#]*))?(\s*\()?/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(masked))) {
      const first = byName.get(m[1].toLowerCase());
      if (!first) continue;
      const before = masked.slice(0, m.index).trimEnd();
      if (/\b(?:procedure|function|package|body|create|replace|end|type|trigger)$/i.test(before)) continue; // déclaration, pas un appel
      let chain: string | undefined;
      if (first === 'PACKAGE') chain = m[2] ? m[1] + '.' + m[2] : m[1];
      else if (m[3] || /\b(?:exec|execute|call)$/i.test(before)) chain = m[1];
      if (!chain) continue;
      const len = m[1].length + (first === 'PACKAGE' && m[2] ? m[0].slice(m[1].length).replace(/\s*\($/, '').length : 0);
      const range = new vscode.Range(doc.positionAt(m.index), doc.positionAt(m.index + len));
      const link = new vscode.DocumentLink(range, vscode.Uri.parse('command:dbexplorer.describeName?' + encodeURIComponent(JSON.stringify([chain, doc.uri.toString()]))));
      link.tooltip = t('Ctrl+click: describe {0}', chain);
      out.push(link);
    }
    return out;
  }
}
