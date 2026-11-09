import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Keymap, SHORTCUTS } from '../shortcuts';
import { isFrench, t } from '../i18n';

/** Vue repliée en bas de la barre latérale : version, raccourcis, guide visuel, changelog. */
export class HelpView implements vscode.WebviewViewProvider {
  static readonly viewId = 'dbexplorer.helpPanel';

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView) {
    view.webview.options = { enableScripts: true, enableCommandUris: true };
    view.webview.html = this.html();
    // se rafraîchit si le jeu de raccourcis change
    const sub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('dbexplorer.keymap')) view.webview.html = this.html();
    });
    view.onDidDispose(() => sub.dispose());
  }

  private changelog(): string {
    const files = isFrench() ? ['CHANGELOG.fr.md', 'CHANGELOG.md'] : ['CHANGELOG.md'];
    for (const f of files) {
      try {
        return renderMarkdown(fs.readFileSync(path.join(this.ctx.extensionPath, f), 'utf8'));
      } catch {
        /* suivant */
      }
    }
    return `<p>${t('CHANGELOG.md not found.')}</p>`;
  }

  private html(): string {
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const version = String(this.ctx.extension.packageJSON.version);
    const km = vscode.workspace.getConfiguration('dbexplorer').get<Keymap>('keymap', 'standard');
    const keys = SHORTCUTS.map((s) => `<tr><td>${esc(s.label)}</td><td>${(s.keys[km] ?? s.keys.standard).map((k) => `<kbd>${esc(k)}</kbd>`).join(' ')}</td></tr>`).join('');
    const execKey = (SHORTCUTS[0].keys[km] ?? SHORTCUTS[0].keys.standard)[0];
    const settingLink = 'command:workbench.action.openSettings?' + encodeURIComponent(JSON.stringify(['dbexplorer.keymap']));
    const kbLink = 'command:workbench.action.openGlobalKeybindings?' + encodeURIComponent(JSON.stringify(['dbexplorer']));
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body{padding:0 10px 14px;font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground)}
.ver{display:flex;align-items:center;gap:8px;margin:8px 0}
.badge{background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);border-radius:10px;padding:1px 9px;font-size:11px}
#tabs{display:flex;border-bottom:1px solid var(--vscode-panel-border);margin:0 -10px 6px;position:sticky;top:0;background:var(--vscode-sideBar-background,var(--vscode-editor-background));z-index:2}
.tab{padding:6px 12px;cursor:pointer;opacity:.7;border-bottom:2px solid transparent;user-select:none;white-space:nowrap}
.tab.on{opacity:1;border-bottom-color:var(--vscode-focusBorder);font-weight:600}
h3{margin:12px 0 4px;font-size:13px}h4{margin:8px 0 2px;font-size:12px;opacity:.85}
ul{margin:2px 0 6px;padding-left:18px}li{margin:2px 0}
code{font-family:var(--vscode-editor-font-family);background:var(--vscode-textCodeBlock-background);padding:0 4px;border-radius:3px}
kbd{background:var(--vscode-keybindingLabel-background);color:var(--vscode-keybindingLabel-foreground);border:1px solid var(--vscode-keybindingLabel-border,transparent);border-radius:3px;padding:1px 5px;font-size:11px;white-space:nowrap}
table{width:100%;border-collapse:collapse;font-size:12px}td{padding:3px 2px;border-bottom:1px solid var(--vscode-panel-border)}
svg{width:100%;height:auto;display:block;margin:6px 0}
ol.steps{padding-left:18px}ol.steps li{margin:4px 0}
.n{display:inline-block;width:16px;height:16px;line-height:16px;text-align:center;border-radius:50%;background:var(--vscode-button-background);color:var(--vscode-button-foreground);font-size:10px;margin-right:4px}
a{color:var(--vscode-textLink-foreground)}
.muted{opacity:.75;font-size:11px;margin-top:6px}
</style></head><body>
<div class="ver"><span class="badge">v${esc(version)}</span><span>DB Explorer</span></div>

<div id="tabs"><div class="tab" data-t="guide">${t('Visual guide')}</div><div class="tab" data-t="keys">${t('Keyboard shortcuts')}</div><div class="tab" data-t="news">${t("What's new")}</div></div>
<div class="pane" id="pane-guide">
<svg viewBox="0 0 320 210" role="img" aria-label="${t('Interface diagram')}">
  <rect x="1" y="1" width="318" height="208" rx="6" fill="none" stroke="currentColor" opacity=".35"/>
  <rect x="1" y="1" width="26" height="208" rx="6" fill="currentColor" opacity=".10"/>
  <g fill="currentColor" opacity=".55"><ellipse cx="14" cy="22" rx="7" ry="2.6"/><path d="M7 25a7 2.6 0 0 0 14 0v3a7 2.6 0 0 1-14 0z"/><path d="M7 31a7 2.6 0 0 0 14 0v3a7 2.6 0 0 1-14 0z"/></g>
  <rect x="31" y="6" width="84" height="92" rx="3" fill="currentColor" opacity=".08"/>
  <g fill="currentColor" opacity=".5" font-size="7"><text x="36" y="18">▾ MY_DB</text><text x="42" y="30">▸ Tables</text><text x="42" y="42">▸ Views</text><text x="42" y="54">▸ Packages</text><text x="42" y="66">▸ Triggers</text></g>
  <rect x="31" y="102" width="84" height="48" rx="3" fill="currentColor" opacity=".08"/>
  <g fill="currentColor" opacity=".5" font-size="7"><text x="36" y="113">${t('History')}</text><rect x="36" y="118" width="74" height="5" rx="1" opacity=".4"/><rect x="36" y="127" width="74" height="5" rx="1" opacity=".4"/><rect x="36" y="136" width="74" height="5" rx="1" opacity=".4"/></g>
  <rect x="31" y="154" width="84" height="50" rx="3" fill="currentColor" opacity=".08"/>
  <g fill="currentColor" opacity=".5" font-size="7"><text x="36" y="165">${t('Connection')}</text><rect x="36" y="169" width="74" height="7" rx="1" opacity=".5"/><rect x="36" y="180" width="74" height="7" rx="1" opacity=".5"/><rect x="36" y="191" width="34" height="9" rx="1" opacity=".8"/></g>
  <rect x="120" y="6" width="194" height="94" rx="3" fill="none" stroke="currentColor" opacity=".3"/>
  <g fill="currentColor" font-size="7" opacity=".6"><text x="126" y="20">SELECT *</text><text x="126" y="31">  FROM employees e</text><text x="126" y="42">  WHERE e.dept = :dept;</text></g>
  <rect x="124" y="36" width="130" height="8" fill="currentColor" opacity=".12"/>
  <rect x="120" y="104" width="194" height="100" rx="3" fill="currentColor" opacity=".08"/>
  <g fill="currentColor" opacity=".55" font-size="7"><text x="126" y="116">${t('Data | Script | DBMS Output | Plan')}</text><rect x="126" y="121" width="182" height="6" opacity=".5"/><rect x="126" y="131" width="182" height="5" opacity=".25"/><rect x="126" y="140" width="182" height="5" opacity=".25"/><rect x="126" y="149" width="182" height="5" opacity=".25"/></g>
  <g font-size="9" font-weight="700" fill="var(--vscode-button-foreground)">
    <circle cx="14" cy="50" r="7" fill="var(--vscode-button-background)"/><text x="11.2" y="53.2">1</text>
    <circle cx="106" cy="14" r="7" fill="var(--vscode-button-background)"/><text x="103.2" y="17.2">2</text>
    <circle cx="106" cy="108" r="7" fill="var(--vscode-button-background)"/><text x="103.2" y="111.2">3</text>
    <circle cx="106" cy="158" r="7" fill="var(--vscode-button-background)"/><text x="103.2" y="161.2">4</text>
    <circle cx="304" cy="14" r="7" fill="var(--vscode-button-background)"/><text x="301.2" y="17.2">5</text>
    <circle cx="304" cy="112" r="7" fill="var(--vscode-button-background)"/><text x="301.2" y="115.2">6</text>
  </g>
</svg>
<ol class="steps">
  <li><span class="n">1</span>${t('<b>DB Explorer icon</b> in the activity bar.')}</li>
  <li><span class="n">2</span>${t('<b>Schema Browser</b>: connections, objects, columns, indexes. Click = DDL / source. Click a connected connection to make it active.')}</li>
  <li><span class="n">3</span>${t('<b>History</b>: previous queries. Click to open, ▶ to run again.')}</li>
  <li><span class="n">4</span>${t('<b>Connection</b>: form (type, TNS alias, host…) then <i>Save and connect</i>.')}</li>
  <li><span class="n">5</span>${t('<b>SQL editor</b>: {0} runs the statement at the cursor.', `<kbd>${esc(execKey)}</kbd>`)}</li>
  <li><span class="n">6</span>${t('<b>Results</b> in the bottom panel: grid, script, DBMS_OUTPUT, plan.')}</li>
</ol>
</div>

<div class="pane" id="pane-keys">
<table>${keys}</table>
<div class="muted">${t('Shortcut set')}: <b>${esc(km)}</b> — <a href="${settingLink}">${t('change')}</a> · <a href="${kbLink}">${t('customize keys')}</a></div>
</div>

<div class="pane" id="pane-news">${this.changelog()}</div>
<script nonce="${nonce}">
const vs=acquireVsCodeApi();let cur=(vs.getState()||{}).tab||'guide';
function show(x){cur=x;vs.setState({tab:x});document.querySelectorAll('.tab').forEach(e=>e.classList.toggle('on',e.dataset.t===x));document.querySelectorAll('.pane').forEach(e=>e.style.display=e.id==='pane-'+x?'':'none');}
document.querySelectorAll('.tab').forEach(e=>e.onclick=()=>show(e.dataset.t));show(cur);
</script>
</body></html>`;
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/** Rendu Markdown minimal : titres, listes, gras, code. */
function renderMarkdown(md: string): string {
  const inline = (x: string) => esc(x).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  const out: string[] = [];
  let inList = false;
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (li) {
      if (!inList) out.push('<ul>');
      inList = true;
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      if (h[1].length === 1) continue; // titre du fichier
      out.push(h[1].length === 2 ? `<h3>${inline(h[2])}</h3>` : `<h4>${inline(h[2])}</h4>`);
    } else if (line) out.push(`<p>${inline(line)}</p>`);
  }
  if (inList) out.push('</ul>');
  return out.join('\n');
}

export function currentVersion(ctx: vscode.ExtensionContext): string {
  return String(ctx.extension.packageJSON.version);
}
