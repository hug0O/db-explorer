import * as vscode from 'vscode';
import { ConnectionManager } from '../connections';
import { t } from '../i18n';
import { MetaCache } from '../metaCache';
import { ALLOWED, TOOLS_CSS, TOOLS_JS, toolsBody } from './toolsView';

type In =
  | { cmd: 'ready' }
  | { cmd: 'set'; key: string; value: number | boolean }
  | { cmd: 'disconnect'; id: string }
  | { cmd: 'rollback'; id: string }
  | { cmd: 'activate'; id: string }
  | { cmd: 'rebuild' }
  | { cmd: 'run'; command: string };

const KEYS = ['idleTimeoutMinutes', 'rollbackOnTimeout', 'transactionTimeoutMinutes', 'queryTimeoutSeconds', 'prefetchMetadata', 'metadataConnection'] as const;

/** Vue « Réglages » : timeouts, rollback automatique de sécurité, état des connexions ouvertes. */
export class SettingsView implements vscode.WebviewViewProvider {
  static readonly viewId = 'dbexplorer.settingsPanel';
  private view?: vscode.WebviewView;
  private ready = false;
  private timer?: NodeJS.Timeout;

  constructor(private readonly mgr: ConnectionManager, private readonly cache: MetaCache) {
    mgr.onDidChange(() => this.push());
    cache.onProgress(() => this.push());
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('dbexplorer')) this.push();
      if (e.affectsConfiguration('dbexplorer.queryTimeoutSeconds')) void mgr.applyQueryTimeoutAll();
    });
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    this.ready = false;
    view.webview.options = { enableScripts: true };
    view.webview.html = html();
    view.webview.onDidReceiveMessage((m: In) => void this.onMessage(m));
    // rafraîchit les durées d'inactivité tant que la vue est visible
    this.timer = setInterval(() => {
      if (view.visible) this.push();
    }, 5000);
    view.onDidDispose(() => {
      if (this.timer) clearInterval(this.timer);
      this.view = undefined;
      this.ready = false;
    });
  }

  private push() {
    if (!this.view || !this.ready) return;
    const cfg = vscode.workspace.getConfiguration('dbexplorer');
    const settings: Record<string, unknown> = {};
    for (const k of KEYS) settings[k] = cfg.get(k);
    const a = this.mgr.active;
    let meta: unknown;
    if (a) {
      const st = this.cache.status(a.profile.id);
      meta = { name: a.profile.name, schema: a.session.conn.currentSchema, reuse: this.cache.peek(a.profile.id, a.session.conn.currentSchema)?.reuse, phase: st?.phase ?? 'idle', done: st?.done ?? 0, total: st?.total ?? 0, ...this.cache.cachedCounts(a.profile.id, a.session.conn.currentSchema) };
    }
    void this.view.webview.postMessage({ type: 'state', settings, sessions: this.mgr.statuses(), meta });
  }

  private async onMessage(m: In) {
    switch (m.cmd) {
      case 'ready':
        this.ready = true;
        this.push();
        break;
      case 'set':
        if ((KEYS as readonly string[]).includes(m.key)) {
          await vscode.workspace.getConfiguration('dbexplorer').update(m.key, m.value, vscode.ConfigurationTarget.Global);
        }
        break;
      case 'disconnect':
        await this.mgr.disconnect(m.id);
        break;
      case 'rollback':
        await this.mgr.rollbackSession(m.id);
        break;
      case 'activate':
        this.mgr.setActive(m.id);
        break;
      case 'rebuild':
        await vscode.commands.executeCommand('dbexplorer.refresh');
        break;
      case 'run':
        if (ALLOWED.has(m.command)) await vscode.commands.executeCommand(m.command);
        break;
    }
  }
}

function html(): string {
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const T = {
    none: t('No open connection.'),
    active: t('active'),
    uncommitted: t('uncommitted'),
    running: t('running'),
    idle: t('idle {0}'),
    tx: t('transaction {0}'),
    disconnect: t('Disconnect'),
    rollback: t('Rollback'),
    activate: t('Set active'),
    saved: t('Saved'),
    scanning: t('indexing {0}/{1}'),
    objectsPhase: t('listing objects…'),
    reuseLine: t('Structure reused from {0}: {1} table(s) identical, {2} read again.'),
    ready: t('ready'),
    cacheLine: t('{0}: {1} objects, {2} tables with columns cached'),
    noConn: t('No active connection.'),
  };
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body{padding:0 10px 12px;font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground)}
h4{margin:14px 0 6px;text-transform:uppercase;font-size:11px;letter-spacing:.06em;opacity:.8}
label{display:block;margin:8px 0 2px;font-size:12px}
.hint{opacity:.7;font-size:11px;margin:2px 0 0}
input[type=number]{width:90px;box-sizing:border-box;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));padding:4px 6px;font-family:inherit;font-size:inherit}
.chk{display:flex;gap:6px;align-items:flex-start;margin-top:10px;font-size:12px}.chk input{margin-top:2px}
.info{margin-top:10px;padding:6px 8px;border-left:3px solid var(--vscode-focusBorder);background:var(--vscode-textBlockQuote-background);font-size:12px}
.conn{border:1px solid var(--vscode-panel-border);border-radius:4px;padding:6px 8px;margin:6px 0}
.conn .name{font-weight:600}.chips{margin:3px 0;display:flex;gap:4px;flex-wrap:wrap}
.chip{font-size:10px;padding:0 6px;border-radius:8px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}
.chip.warn{background:var(--vscode-inputValidation-warningBackground,#665500);color:var(--vscode-foreground)}
.btns{display:flex;gap:4px;margin-top:4px;flex-wrap:wrap}
button{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:0;padding:3px 8px;border-radius:2px;cursor:pointer;font-family:inherit;font-size:11px}
button:hover{background:var(--vscode-button-secondaryHoverBackground)}
#saved{color:var(--vscode-testing-iconPassed,#3fb950);font-size:11px;margin-left:6px;opacity:0;transition:opacity .3s}
${TOOLS_CSS}
#tabs{display:flex;border-bottom:1px solid var(--vscode-panel-border);margin:0 -10px 6px;position:sticky;top:0;background:var(--vscode-sideBar-background,var(--vscode-editor-background));z-index:2}
.tab{padding:6px 14px;cursor:pointer;opacity:.7;border-bottom:2px solid transparent;user-select:none}
.tab.on{opacity:1;border-bottom-color:var(--vscode-focusBorder);font-weight:600}
</style></head><body>
<div id="tabs"><div class="tab" data-t="tools">${t('Tools')}</div><div class="tab" data-t="settings">${t('Settings')}</div></div>
<div id="pane-tools">${toolsBody()}</div>
<div id="pane-settings" style="display:none">
<h4>${t('Security')}<span id="saved">${t('Saved')}</span></h4>

<label for="idle">${t('Idle timeout (minutes)')}</label>
<input type="number" id="idle" min="0" step="1">
<div class="hint">${t('Close a connection after this much inactivity. 0 = never.')}</div>

<div class="chk"><input type="checkbox" id="rb"><label for="rb" style="margin:0">${t('Roll back uncommitted changes when the idle timeout hits (otherwise the connection is kept open)')}</label></div>

<label for="tx">${t('Transaction timeout (minutes)')}</label>
<input type="number" id="tx" min="0" step="1">
<div class="hint">${t('Automatically roll back uncommitted changes after this long, even if you are active. 0 = never.')}</div>

<label for="qt">${t('Query timeout (seconds)')}</label>
<input type="number" id="qt" min="0" step="1">
<div class="hint">${t('Abort queries running longer than this. 0 = unlimited.')}</div>

<h4>${t('Code completion cache')}</h4>
<div class="chk"><input type="checkbox" id="pf"><label for="pf" style="margin:0">${t('Scan table and column names in the background (separate connection, throttled)')}</label></div>
<div class="chk"><input type="checkbox" id="mc"><label for="mc" style="margin:0">${t('Use dedicated metadata connections (never blocks your queries; uses extra sessions)')}</label></div>
<div class="hint" id="cacheinfo"></div>
<div class="btns"><button id="rebuild">${t('Rebuild cache')}</button></div>

<div class="info">${t('When you quit or reload VS Code, open connections are automatically rolled back and disconnected.')}</div>

<h4>${t('Open connections')}</h4>
<div id="conns"></div>

</div>
<script nonce="${nonce}">
const vs=acquireVsCodeApi();
${TOOLS_JS}
let curTab=(vs.getState()||{}).tab||'tools';
function showTab(x){curTab=x;vs.setState({tab:x});document.querySelectorAll('.tab').forEach(e=>e.classList.toggle('on',e.dataset.t===x));$('pane-tools').style.display=x==='tools'?'':'none';$('pane-settings').style.display=x==='settings'?'':'none';}
document.querySelectorAll('.tab').forEach(e=>e.onclick=()=>showTab(e.dataset.t));
const T=${JSON.stringify(T)};const $=id=>document.getElementById(id);
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function dur(s){if(s<60)return s+'s';const m=Math.floor(s/60);if(m<60)return m+'m '+String(s%60).padStart(2,'0')+'s';return Math.floor(m/60)+'h '+String(m%60).padStart(2,'0')+'m';}
let focusKey=null,flash;
function send(key,value){vs.postMessage({cmd:'set',key,value});const e=$('saved');e.style.opacity=1;clearTimeout(flash);flash=setTimeout(()=>e.style.opacity=0,1200);}
const num=(id,key)=>{$(id).onchange=()=>send(key,Math.max(0,Math.floor(+$(id).value||0)));$(id).onfocus=()=>focusKey=id;$(id).onblur=()=>focusKey=null;};
num('idle','idleTimeoutMinutes');num('tx','transactionTimeoutMinutes');num('qt','queryTimeoutSeconds');
$('rb').onchange=()=>send('rollbackOnTimeout',$('rb').checked);
$('pf').onchange=()=>send('prefetchMetadata',$('pf').checked);
$('mc').onchange=()=>send('metadataConnection',$('mc').checked);
$('rebuild').onclick=()=>vs.postMessage({cmd:'rebuild'});
function render(m){
  const s=m.settings;
  if(focusKey!=='idle')$('idle').value=s.idleTimeoutMinutes??0;
  if(focusKey!=='tx')$('tx').value=s.transactionTimeoutMinutes??0;
  if(focusKey!=='qt')$('qt').value=s.queryTimeoutSeconds??0;
  $('rb').checked=s.rollbackOnTimeout!==false;
  $('pf').checked=s.prefetchMetadata!==false;$('mc').checked=s.metadataConnection!==false;
  const mt=m.meta;
  $('cacheinfo').textContent=!mt?T.noConn:T.cacheLine.replace('{0}',mt.name+' ['+mt.schema+']').replace('{1}',mt.objects).replace('{2}',mt.tables)
    +(mt.phase==='columns'?' — '+T.scanning.replace('{0}',mt.done).replace('{1}',mt.total):mt.phase==='objects'?' — '+T.objectsPhase:mt.phase==='done'?' — '+T.ready:'')
    +(mt.reuse?' — '+T.reuseLine.replace('{0}',mt.reuse.from).replace('{1}',mt.reuse.reused).replace('{2}',mt.reuse.refetched):'');
  $('conns').innerHTML=m.sessions.length?m.sessions.map(c=>
    '<div class="conn"><div class="name">'+esc(c.name)+'</div><div class="chips">'
    +(c.active?'<span class="chip">'+T.active+'</span>':'')
    +(c.busy?'<span class="chip">'+T.running+'</span>':'<span class="chip">'+T.idle.replace('{0}',dur(c.idleSec))+'</span>')
    +(c.dirty?'<span class="chip warn">'+T.uncommitted+' · '+T.tx.replace('{0}',dur(c.txSec))+'</span>':'')
    +'</div><div class="btns">'
    +(c.active?'':'<button data-a="activate" data-id="'+esc(c.id)+'">'+T.activate+'</button>')
    +(c.dirty?'<button data-a="rollback" data-id="'+esc(c.id)+'">'+T.rollback+'</button>':'')
    +'<button data-a="disconnect" data-id="'+esc(c.id)+'">'+T.disconnect+'</button></div></div>').join(''):'<div class="hint">'+T.none+'</div>';
  document.querySelectorAll('#conns button').forEach(b=>b.onclick=()=>vs.postMessage({cmd:b.dataset.a,id:b.dataset.id}));
}
window.addEventListener('message',e=>{if(e.data.type==='state')render(e.data);});
showTab(curTab);
vs.postMessage({cmd:'ready'});
</script></body></html>`;
}
