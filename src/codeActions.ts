import * as vscode from 'vscode';
import { ConnectionManager } from './connections';
import { MetaCache, within, TIMEOUT, ColMeta } from './metaCache';
import { split, statementAt } from './splitter';
import { dialectOf } from './runner';
import { parseRefList, maskText, RefInfo } from './completion';
import { prettySql } from './sqlformat';
import { ForeignKey } from './drivers/types';
import { t } from './i18n';

const A = vscode.CodeActionKind;

const base = (x: string) => x.split('.').pop()!.replace(/"/g, '').toLowerCase();

/**
 * « Afficher les actions de code » (Ctrl+. / ampoule / Ctrl+Alt+A) sur la position du curseur :
 * actions sur la table sous le curseur, sur l'instruction, développement de « * », condition ON manquante d'une JOIN.
 */
export class SqlCodeActions implements vscode.CodeActionProvider {
  static readonly kinds = [A.QuickFix, A.Refactor, A.RefactorRewrite];

  constructor(private readonly mgr: ConnectionManager, private readonly cache: MetaCache) {}

  private cmd(title: string, kind: vscode.CodeActionKind, command: string, ...args: unknown[]) {
    const a = new vscode.CodeAction(title, kind);
    a.command = { command, title, arguments: args };
    return a;
  }

  async provideCodeActions(doc: vscode.TextDocument, range: vscode.Range | vscode.Selection, context?: vscode.CodeActionContext): Promise<vscode.CodeAction[]> {
    const fixes: vscode.CodeAction[] = [];
    // « Vouliez-vous dire X ? » : correction en un clic de l'identifiant refusé par la base
    for (const d of context?.diagnostics ?? []) {
      if (typeof d.code !== 'string' || !d.code.startsWith('dbx:')) continue;
      const to = d.code.slice(4);
      const old = doc.getText(d.range);
      const a = new vscode.CodeAction(t('Replace with {0}', to), A.QuickFix);
      a.diagnostics = [d];
      a.isPreferred = true;
      a.edit = new vscode.WorkspaceEdit();
      a.edit.replace(doc.uri, d.range, old.startsWith('"') ? `"${to}"` : to);
      fixes.push(a);
    }
    return [...fixes, ...(await this.statementActions(doc, range))];
  }

  private async statementActions(doc: vscode.TextDocument, range: vscode.Range | vscode.Selection): Promise<vscode.CodeAction[]> {
    const act = this.mgr.forDocument(doc.uri) ?? this.mgr.active;
    const dialect = act ? dialectOf(act.session.conn.kind) : 'oracle';
    const off = doc.offsetAt(range.start);
    const stmt = statementAt(split(doc.getText(), dialect), off);
    if (!stmt || off < stmt.start || off > stmt.end + 1) return [];
    const out: vscode.CodeAction[] = [];
    const text = stmt.text;
    const refs = parseRefList(text, off - stmt.start).filter((r) => !r.virtual);

    // ---- 1) objet sous le curseur : table / vue (ou son alias)
    const wr = doc.getWordRangeAtPosition(range.start, /"?[\w$#]+"?(\."?[\w$#]+"?)?/);
    const word = wr ? doc.getText(wr).replace(/"/g, '') : '';
    const hit = word && !word.includes('.') ? refs.find((r) => r.alias.toLowerCase() === word.toLowerCase() || base(r.table) === word.toLowerCase()) : undefined;
    const tableName = hit?.table ?? (word && act ? await this.knownObject(act.profile.id, act.session.conn.currentSchema, word) : undefined);
    if (tableName) {
      out.push(this.cmd(t('Describe {0}', tableName), A.QuickFix, 'dbexplorer.describeName', tableName, doc.uri));
      out.push(this.cmd(t('SELECT * FROM {0} (new editor)', tableName), A.QuickFix, 'dbexplorer.selectName', tableName, doc.uri));
      out.push(this.cmd(t('Count the rows of {0}', tableName), A.QuickFix, 'dbexplorer.countName', tableName, doc.uri));
    }

    // ---- 2) « * » → liste des colonnes
    const star = await this.expandStar(doc, stmt.start, text, off, refs);
    if (star) out.push(star);

    // ---- 3) JOIN sans condition ON → conditions issues des clés étrangères
    out.push(...(await this.missingOn(doc, stmt.start, text, off)));

    // ---- 4) actions sur l'instruction
    const stmtRange = new vscode.Range(doc.positionAt(stmt.start), doc.positionAt(stmt.end));
    const fmt = new vscode.CodeAction(t('Format the statement (keywords, one clause per line)'), A.RefactorRewrite);
    fmt.edit = new vscode.WorkspaceEdit();
    fmt.edit.replace(doc.uri, stmtRange, prettySql(text).replace(/\n$/, '') + (/;\s*$/.test(text) ? ';' : ''));
    out.push(
      this.cmd(t('Execute the statement'), A.QuickFix, 'dbexplorer.executeStatement'),
      this.cmd(t('Show the execution plan'), A.QuickFix, 'dbexplorer.explainPlan'),
      this.cmd(t('Suggest optimizations'), A.QuickFix, 'dbexplorer.optimize'),
      this.cmd(t('Show the query graph'), A.QuickFix, 'dbexplorer.queryGraph'),
      this.cmd(t('Duplicate detector: add the key of every table to the SELECT'), A.QuickFix, 'dbexplorer.diagnoseDuplicates'),
      this.cmd(t('Convert comma joins / (+) to ANSI JOIN'), A.RefactorRewrite, 'dbexplorer.toAnsiJoin'),
      this.cmd(t('Show the column types'), A.QuickFix, 'dbexplorer.describeQuery'),
      this.cmd(t('Compare with another query…'), A.Refactor, 'dbexplorer.compareQueries'),
      fmt,
      this.cmd(t('Comment / uncomment the lines'), A.Refactor, 'dbexplorer.toggleComment'),
      this.cmd(t('Execute the whole script'), A.Refactor, 'dbexplorer.executeScript')
    );
    return out;
  }

  /** Le mot est-il un objet connu du cache (table, vue, synonyme) ? */
  private async knownObject(pid: string, schema: string, word: string): Promise<string | undefined> {
    const meta = await this.cache.get(pid, schema);
    const w = word.toLowerCase();
    return meta.objects.find((o) => o.name.toLowerCase() === w)?.name;
  }

  private async colsOf(pid: string, schema: string, r: RefInfo): Promise<ColMeta[]> {
    const [o, tb] = r.table.includes('.') ? r.table.split('.') : [schema, r.table];
    const res = await within(this.cache.columns(pid, o.replace(/"/g, ''), tb.replace(/"/g, '')).catch(() => [] as ColMeta[]), 1500);
    return res === TIMEOUT ? [] : res;
  }

  private async expandStar(doc: vscode.TextDocument, start: number, text: string, off: number, refs: RefInfo[]): Promise<vscode.CodeAction | undefined> {
    const act = this.mgr.forDocument(doc.uri) ?? this.mgr.active;
    if (!act || !refs.length) return undefined;
    const masked = maskText(text);
    const rel = off - start;
    // « * » ou « alias.* » à la position du curseur, dans la liste du SELECT
    const re = /(?:("?[\w$#]+"?)\s*\.\s*)?\*/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(masked))) {
      const a = m.index;
      const b = a + m[0].length;
      if (rel < a || rel > b) continue;
      const before = masked.slice(0, a).trimEnd();
      const after = masked.slice(b).trimStart();
      const inList = /(?:^|\bselect|\bdistinct|\bunique|,|\.)$/i.test(before) || (m[1] && /(?:\bselect|\bdistinct|,)$/i.test(masked.slice(0, a).trimEnd()));
      const ends = /^(?:,|from\b|$)/i.test(after);
      const selectIdx = masked.toLowerCase().lastIndexOf('select', a);
      const fromIdx = masked.toLowerCase().indexOf('from', a);
      if (!inList || !ends || selectIdx < 0 || (fromIdx >= 0 && fromIdx < a)) continue;
      const q = m[1]?.replace(/"/g, '');
      const targets = q ? refs.filter((r) => r.alias.toLowerCase() === q.toLowerCase() || base(r.table) === q.toLowerCase()) : refs;
      if (!targets.length) continue;
      const parts: string[] = [];
      for (const r of targets) {
        const cols = await this.colsOf(act.profile.id, act.session.conn.currentSchema, r);
        const qual = targets.length > 1 || q || refs.length > 1 ? r.alias + '.' : '';
        for (const c of cols) parts.push(qual + c.name);
      }
      if (!parts.length) return undefined;
      const action = new vscode.CodeAction(t('Expand * into the {0} column(s)', parts.length), A.RefactorRewrite);
      action.edit = new vscode.WorkspaceEdit();
      action.edit.replace(doc.uri, new vscode.Range(doc.positionAt(start + a), doc.positionAt(start + b)), parts.join(', '));
      action.isPreferred = true;
      return action;
    }
    return undefined;
  }

  /** « JOIN t [alias] » sans ON / USING : propose la condition issue des clés étrangères avec les tables précédentes. */
  private async missingOn(doc: vscode.TextDocument, start: number, text: string, off: number): Promise<vscode.CodeAction[]> {
    const act = this.mgr.forDocument(doc.uri) ?? this.mgr.active;
    if (!act) return [];
    const masked = maskText(text);
    const re = /\bjoin\s+("?[\w$#]+"?(?:\."?[\w$#]+"?)?)(?:\s+(?:as\s+)?("?[\w$#]+"?))?/gi;
    const stop = /^(on|using|where|group|order|having|union|left|right|inner|full|cross|natural|join|fetch|connect|start|minus|intersect)$/i;
    let m: RegExpExecArray | null;
    const rel = off - start;
    while ((m = re.exec(masked))) {
      const alias = m[2] && !stop.test(m[2].replace(/"/g, '')) ? m[2].replace(/"/g, '') : undefined;
      const endOfName = m.index + m[0].length - (m[2] && !alias ? m[2].length + (/\s+as\s+/i.test(m[0]) ? 0 : 1) : 0);
      const tail = masked.slice(endOfName).trimStart();
      if (/^(on|using)\b/i.test(tail)) continue;
      const lineStart = masked.lastIndexOf('\n', m.index) + 1;
      const lineEnd = masked.indexOf('\n', endOfName);
      if (rel < lineStart || rel > (lineEnd < 0 ? masked.length : lineEnd)) continue; // le curseur doit être sur la ligne de la JOIN
      const table = m[1].replace(/"/g, '');
      const prev = parseRefList(text.slice(0, m.index), m.index).filter((r) => !r.virtual);
      if (!prev.length) return [];
      const schema = act.session.conn.currentSchema;
      const newAlias = alias ?? table.split('.').pop()!;
      const lists = await Promise.all(
        [{ table, alias: newAlias, aliased: !!alias } as RefInfo, ...prev].map(async (r) => {
          const [o, tb] = r.table.includes('.') ? r.table.split('.') : [schema, r.table];
          const res = await within(this.cache.fksFor(act.profile.id, o, tb).catch(() => [] as ForeignKey[]), 1500);
          return res === TIMEOUT ? [] : res;
        })
      );
      const seen = new Set<string>();
      const fks = lists.flat().filter((f) => (seen.has(f.table + '|' + f.name) ? false : (seen.add(f.table + '|' + f.name), true)));
      const nt = base(table);
      const out: vscode.CodeAction[] = [];
      for (const p of prev) {
        const pt = base(p.table);
        for (const fk of fks) {
          let conds: string[] | undefined;
          if (fk.table.toLowerCase() === nt && fk.refTable.toLowerCase() === pt) conds = fk.cols.map((c, i) => `${newAlias}.${c} = ${p.alias}.${fk.refCols[i]}`);
          else if (fk.table.toLowerCase() === pt && fk.refTable.toLowerCase() === nt) conds = fk.cols.map((c, i) => `${p.alias}.${c} = ${newAlias}.${fk.refCols[i]}`);
          if (!conds) continue;
          const on = conds.join(' AND ');
          const a = new vscode.CodeAction(t('Add ON {0} (foreign key {1})', on, fk.name), A.QuickFix);
          a.edit = new vscode.WorkspaceEdit();
          a.edit.insert(doc.uri, doc.positionAt(start + endOfName), ` ON ${on}`);
          a.isPreferred = out.length === 0;
          out.push(a);
        }
      }
      return out;
    }
    return [];
  }
}
