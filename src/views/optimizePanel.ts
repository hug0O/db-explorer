import * as vscode from 'vscode';
import { Report } from '../optimizer';
import { t } from '../i18n';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

let panel: vscode.WebviewPanel | undefined;

/** Affiche le rapport d'optimisation d'une requête (règles, index manquants, plan d'exécution, conseils du SGBD). */
export function showOptimization(report: Report, kindLabel: string) {
  if (!panel) {
    panel = vscode.window.createWebviewPanel('dbexplorer.optimize', t('Query optimization'), { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false }, { enableScripts: true });
    panel.onDidDispose(() => (panel = undefined));
    panel.webview.onDidReceiveMessage((m: { cmd: 'copy'; text: string }) => {
      if (m.cmd === 'copy') {
        void vscode.env.clipboard.writeText(m.text);
        void vscode.window.showInformationMessage(t('Copied to the clipboard.'));
      }
    });
  } else panel.reveal(undefined, false);
  panel.webview.html = html(report, kindLabel);
}

function html(r: Report, kindLabel: string): string {
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const count = (s: string) => r.findings.filter((f) => f.severity === s).length;
  const label: Record<string, string> = { high: t('High'), medium: t('Medium'), info: t('Info') };
  const cards = r.findings.length
    ? r.findings
        .map(
          (f, i) => `<div class="card ${f.severity}"><div class="top"><span class="sev ${f.severity}">${label[f.severity]}</span><b>${esc(f.title)}</b></div><div class="det">${esc(f.detail)}</div>${
            f.fix ? `<pre class="fix">${esc(f.fix)}</pre><button data-i="${i}">${t('Copy')}</button>` : ''
          }</div>`
        )
        .join('')
    : `<div class="ok">${t('No problem found by the rules, the index check and the execution plan.')}</div>`;
  const report = [`${t('Query optimization')} — ${kindLabel}`, '', r.sql, '', ...r.findings.map((f) => `[${f.severity.toUpperCase()}] ${f.title}\n  ${f.detail}${f.fix ? '\n  ' + f.fix : ''}`), '', r.plan ?? ''].join('\n');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:12px 20px;max-width:980px}
h2{margin:0 0 6px}h3{margin:18px 0 6px;font-size:13px;text-transform:uppercase;letter-spacing:.05em;opacity:.8}
.sum{display:flex;gap:8px;margin:6px 0 12px}.pill{padding:1px 10px;border-radius:10px;font-size:12px}
.pill.high,.sev.high{background:rgba(244,71,71,.25);color:var(--vscode-errorForeground)}.pill.medium,.sev.medium{background:rgba(255,170,0,.25)}.pill.info,.sev.info{background:rgba(66,153,225,.25)}
.card{border-left:4px solid var(--vscode-panel-border);background:var(--vscode-editorWidget-background,rgba(128,128,128,.08));padding:8px 12px;margin:8px 0;border-radius:3px}
.card.high{border-left-color:var(--vscode-errorForeground)}.card.medium{border-left-color:#ffaa00}.card.info{border-left-color:#4299e1}
.top{display:flex;gap:8px;align-items:center}.sev{font-size:10px;padding:0 7px;border-radius:8px;text-transform:uppercase}
.det{margin:4px 0;opacity:.95}
pre{background:var(--vscode-textCodeBlock-background);padding:8px;border-radius:3px;overflow:auto;font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size);white-space:pre-wrap;margin:6px 0}
pre.fix{border-left:3px solid var(--vscode-focusBorder)}
button{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:0;padding:3px 10px;border-radius:2px;cursor:pointer}
button.main{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
details{margin:8px 0}summary{cursor:pointer;font-weight:600}
.ok{padding:10px;border-radius:4px;background:rgba(63,185,80,.18)}li{margin:4px 0}
</style></head><body>
<h2>${t('Query optimization')}</h2><div style="opacity:.8">${esc(kindLabel)}</div>
<div class="sum"><span class="pill high">${t('High')}: ${count('high')}</span><span class="pill medium">${t('Medium')}: ${count('medium')}</span><span class="pill info">${t('Info')}: ${count('info')}</span><button class="main" id="copyall">${t('Copy report')}</button></div>
<details><summary>${t('Analyzed statement')}</summary><pre>${esc(r.sql)}</pre></details>
<h3>${t('Findings')}</h3>${cards}
<h3>${t('Execution plan')}</h3>
${r.plan ? `<pre>${esc(r.plan)}</pre>` : `<div class="det">${r.planError ? esc(r.planError) : t('No plan available for this statement.')}</div>`}
<h3>${t('Tips for {0}', kindLabel)}</h3><ul>${r.tips.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
<script nonce="${nonce}">
const vs=acquireVsCodeApi();const fixes=${JSON.stringify(r.findings.map((f) => f.fix ?? ''))};const all=${JSON.stringify(report)};
document.querySelectorAll('button[data-i]').forEach(b=>b.onclick=()=>vs.postMessage({cmd:'copy',text:fixes[+b.dataset.i]}));
document.getElementById('copyall').onclick=()=>vs.postMessage({cmd:'copy',text:all});
</script></body></html>`;
}
