import { t } from '../i18n';

export const ALLOWED = new Set([
  'dbexplorer.optimize',
  'dbexplorer.queryGraph',
  'dbexplorer.erDiagram',
  'dbexplorer.findDuplicates',
  'dbexplorer.diagnoseDuplicates',
  'dbexplorer.toAnsiJoin',
  'dbexplorer.favorite.add',
  'dbexplorer.favorite.pick',
  'dbexplorer.compareSchemas',
  'dbexplorer.callGraph',
  'dbexplorer.compareQueries',
  'dbexplorer.explainPlan',
  'dbexplorer.describeQuery',
  'dbexplorer.toggleComment',
  'dbexplorer.toggleBlockComment',
  'dbexplorer.newEditor',
  'dbexplorer.exportResults',
  'dbexplorer.history',
  'dbexplorer.codeActions',
]);

export const TOOLS_CSS = `
#toolgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(64px,1fr));gap:6px;padding:4px 0}
.tool{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;min-height:56px;padding:6px 2px;text-align:center;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:0;border-radius:4px;cursor:pointer;font-family:inherit}
.tool:hover{background:var(--vscode-button-secondaryHoverBackground);outline:1px solid var(--vscode-focusBorder)}
.tool .ic{font-size:18px;line-height:1}
.tool .lb{font-size:10px;line-height:1.15;overflow-wrap:anywhere}
.tool.main{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}`;

/** Boutons d'accès rapide aux outils sur la requête courante (onglet « Outils » de la vue « Outils & réglages »). */
export function toolsBody(): string {
  const ICONS: Record<string, string> = {"dbexplorer.optimize":"⚡","dbexplorer.compareSchemas":"⇄","dbexplorer.favorite.add":"⭐","dbexplorer.favorite.pick":"📌","dbexplorer.toAnsiJoin":"🔗","dbexplorer.erDiagram":"🗺️","dbexplorer.findDuplicates":"👯","dbexplorer.diagnoseDuplicates":"🔎","dbexplorer.queryGraph":"🕸️","dbexplorer.callGraph":"📞","dbexplorer.compareQueries":"⚖️","dbexplorer.codeActions":"💡","dbexplorer.explainPlan":"📊","dbexplorer.describeQuery":"🏷️","dbexplorer.toggleComment":"💬","dbexplorer.toggleBlockComment":"📝","dbexplorer.exportResults":"📤","dbexplorer.history":"🕘","dbexplorer.newEditor":"📄"};
  const tools: [string, string, string][] = [
    ['dbexplorer.optimize', t('Optimize query'), t('Rules, missing indexes and execution plan for the current statement')],
    ['dbexplorer.compareSchemas', t('Compare schemas'), t('Differences between two schemas (dev vs prod) and a script to bring the target in line')],
    ['dbexplorer.favorite.add', t('Save as favorite'), t('Keep the current statement in the Favorites view (per connection or for all)')],
    ['dbexplorer.favorite.pick', t('Insert a favorite'), t('Pick a saved query and insert it in the editor')],
    ['dbexplorer.toAnsiJoin', t('Oracle joins → ANSI JOIN'), t('Rewrite FROM a, b WHERE a.x = b.y(+) as JOIN … ON (statement or selection)')],
    ['dbexplorer.diagnoseDuplicates', t('Duplicate detector'), t('Adds the key of every table of the query to the SELECT to see which one repeats the rows')],
    ['dbexplorer.findDuplicates', t('Find duplicates'), t('Rows that share the same values in chosen columns: summary, all rows, or a delete script (right-click a table too)')],
    ['dbexplorer.erDiagram', t('ER diagram'), t('Tables of the schema and their foreign keys (pick tables, or right-click a table in the Schema Browser)')],
    ['dbexplorer.queryGraph', t('Query graph'), t('Diagram of the tables, joins and subqueries of the current statement')],
    ['dbexplorer.callGraph', t('Call graph'), t('Internal and external calls of the package / routine open in the editor (or right-click it in the Schema Browser)')],
    ['dbexplorer.compareQueries', t('Compare queries'), t('Text diff, or compare the rows returned by two queries')],
    ['dbexplorer.codeActions', t('Actions at the cursor'), t('Quick fixes and refactorings available where the cursor is')],
    ['dbexplorer.explainPlan', t('Explain plan'), t('Execution plan of the current statement')],
    ['dbexplorer.describeQuery', t('Column types'), t('Types of the columns returned by the statement')],
    ['dbexplorer.toggleComment', t('Comment / uncomment'), t('Toggle -- comments on the selected lines')],
    ['dbexplorer.toggleBlockComment', t('Block comment'), t('Toggle a /* … */ comment on the selection')],
    ['dbexplorer.exportResults', t('Export results'), t('Excel, CSV, JSON, SQL INSERT / MERGE…')],
    ['dbexplorer.history', t('SQL history'), t('Quick pick of previous statements')],
    ['dbexplorer.newEditor', t('New SQL editor'), t('Bound to the active connection')],
  ];

  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  return `<div id="toolgrid">${tools.map(([c, l, d], i) => `<button class="tool${i === 0 ? ' main' : ''}" data-c="${c}" title="${esc(l + ' — ' + d)}"><span class="ic">${ICONS[c] ?? '•'}</span><span class="lb">${esc(l)}</span></button>`).join('')}</div>`;
}

/** Script de l'onglet Outils (suppose \`vs\` = acquireVsCodeApi()). */
export const TOOLS_JS = "document.querySelectorAll('button.tool').forEach(b=>b.onclick=()=>vs.postMessage({cmd:'run',command:b.dataset.c}));";
