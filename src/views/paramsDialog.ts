import { t } from '../i18n';
import * as vscode from 'vscode';
import { BindSpec } from '../drivers/types';

export interface BindDef {
  name: string;
  dir: BindSpec['dir'];
  type: BindSpec['type'];
  val: string | null;
}

interface Options {
  /** Oracle : afficher direction (IN/OUT/IN OUT) et types étendus. */
  advanced: boolean;
  title: string;
  sql: string;
}

/**
 * Fenêtre « Paramètres » : liste toutes les variables de liaison de l'instruction et leurs valeurs.
 * Retourne undefined si l'utilisateur annule.
 */
export function askParams(defs: BindDef[], opt: Options): Promise<Record<string, BindDef> | undefined> {
  return new Promise((resolve) => {
    const panel = vscode.window.createWebviewPanel('dbexplorer.params', opt.title, { viewColumn: vscode.ViewColumn.Active, preserveFocus: false }, { enableScripts: true });
    let done = false;
    const finish = (v: Record<string, BindDef> | undefined) => {
      if (done) return;
      done = true;
      resolve(v);
      panel.dispose();
    };
    panel.webview.html = html(defs, opt);
    panel.webview.onDidReceiveMessage((m: { cmd: 'ok'; values: BindDef[] } | { cmd: 'cancel' }) => {
      if (m.cmd === 'ok') finish(Object.fromEntries(m.values.map((d) => [d.name, d])));
      else finish(undefined);
    });
    panel.onDidDispose(() => finish(undefined));
  });
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function html(defs: BindDef[], opt: Options): string {
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const types: [string, string][] = opt.advanced
    ? [['string', t('Text')], ['number', t('Number')], ['date', t('Date')], ['clob', 'CLOB'], ['cursor', 'REF CURSOR']]
    : [['string', t('Text')], ['number', t('Number')]];
  const rows = defs
    .map(
      (d, i) => `<tr data-i="${i}">
  <td class="name">:${esc(d.name)}</td>
  ${opt.advanced ? `<td><select class="dir"><option value="in"${d.dir === 'in' ? ' selected' : ''}>IN</option><option value="out"${d.dir === 'out' ? ' selected' : ''}>OUT</option><option value="inout"${d.dir === 'inout' ? ' selected' : ''}>IN OUT</option></select></td>` : ''}
  <td><select class="type">${types.map(([v, l]) => `<option value="${v}"${d.type === v ? ' selected' : ''}>${l}</option>`).join('')}</select></td>
  <td><input class="val" value="${esc(d.val ?? '')}" placeholder="${t('value')}"></td>
  <td style="text-align:center"><input type="checkbox" class="nul"${d.val === null ? ' checked' : ''} title="NULL"></td>
</tr>`
    )
    .join('');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:16px 24px;max-width:820px}
h2{margin:0 0 8px;font-size:16px}
pre{background:var(--vscode-textCodeBlock-background);padding:8px;border-radius:4px;max-height:140px;overflow:auto;font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size);white-space:pre-wrap;margin:6px 0 14px}
table{border-collapse:collapse;width:100%}th{text-align:left;font-size:11px;text-transform:uppercase;opacity:.7;padding:4px}
td{padding:4px}td.name{font-family:var(--vscode-editor-font-family);white-space:nowrap}
input.val,select{width:100%;box-sizing:border-box;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));padding:4px 6px;font-family:inherit;font-size:inherit}
input.val:disabled{opacity:.4}
.btns{display:flex;gap:8px;margin-top:16px}
button{padding:6px 16px;border:0;border-radius:2px;cursor:pointer;font-family:inherit;font-size:inherit;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
button.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
.hint{opacity:.7;font-size:12px;margin-top:10px}
</style></head><body>
<h2>${t('Statement parameters ({0})', defs.length)}</h2>
<pre>${esc(opt.sql.length > 600 ? opt.sql.slice(0, 600) + '…' : opt.sql)}</pre>
<table><thead><tr><th>${t('Variable')}</th>${opt.advanced ? `<th>${t('Direction')}</th>` : ''}<th>${t('Type')}</th><th>${t('Value')}</th><th>NULL</th></tr></thead><tbody>${rows}</tbody></table>
<div class="hint">${opt.advanced ? t('OUT / IN OUT: returned values are shown in "Script / Messages"; an OUT REF CURSOR is shown in the grid.') : ''}</div>
<div class="btns"><button class="primary" id="ok">${t('Execute')}</button><button id="cancel">${t('Cancel')}</button></div>
<script nonce="${nonce}">
const vs=acquireVsCodeApi();
const defs=${JSON.stringify(defs.map((d) => d.name))};
function rows(){return [...document.querySelectorAll('tbody tr')];}
function sync(tr){
  const dir=tr.querySelector('.dir'),type=tr.querySelector('.type').value,nul=tr.querySelector('.nul'),val=tr.querySelector('.val');
  const out=dir&&dir.value==='out';
  if(type==='cursor'&&dir&&dir.value==='in'){dir.value='out';}
  val.disabled=nul.checked||out||type==='cursor';
}
rows().forEach(tr=>{['change','input'].forEach(ev=>tr.addEventListener(ev,()=>sync(tr)));sync(tr);});
function submit(){
  const values=rows().map((tr,i)=>{
    const dir=tr.querySelector('.dir');const type=tr.querySelector('.type').value;
    const isNull=tr.querySelector('.nul').checked;const v=tr.querySelector('.val').value;
    return {name:defs[i],dir:dir?dir.value:'in',type,val:(isNull||v==='')?null:v};
  });
  vs.postMessage({cmd:'ok',values});
}
document.getElementById('ok').onclick=submit;
document.getElementById('cancel').onclick=()=>vs.postMessage({cmd:'cancel'});
document.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&e.target.tagName!=='SELECT'){e.preventDefault();submit();}if(e.key==='Escape')vs.postMessage({cmd:'cancel'});});
const first=document.querySelector('.val:not(:disabled)');if(first){first.focus();first.select();}
</script></body></html>`;
}
