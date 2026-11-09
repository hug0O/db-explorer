import { analyzeError } from '../errorHints';
import * as vscode from 'vscode';
import { ConnectionManager, Profile } from '../connections';
import { KIND_LABELS, describeProfile } from '../drivers';
import { detectTnsDirs, findTnsAdmin, listTnsAliases } from '../drivers/tns';
import { COLORS, nextColor } from '../palette';
import { t } from '../i18n';

type In =
  | { cmd: 'ready' }
  | { cmd: 'tns'; dir?: string }
  | { cmd: 'browseTns' }
  | { cmd: 'browseFile' }
  | { cmd: 'save'; connect: boolean; profile: Profile; password: string }
  | { cmd: 'test'; profile: Profile; password: string }
  | { cmd: 'setColor'; id: string; color: string }
  | { cmd: 'connect'; id: string }
  | { cmd: 'disconnect'; id: string }
  | { cmd: 'editProfile'; id: string }
  | { cmd: 'testSaved'; id: string }
  | { cmd: 'tab'; tab: 'browser' };

/** Vue de la barre latérale : formulaire de connexion. */
export class SetupView implements vscode.WebviewViewProvider {
  static readonly viewId = 'dbexplorer.connectionForm';
  private view?: vscode.WebviewView;
  private ready = false;
  private pendingEdit: Profile | null | undefined; // null = nouveau formulaire vide

  constructor(private readonly mgr: ConnectionManager) {
    mgr.onDidChange(() => this.pushProfiles());
  }

  private pushProfiles() {
    this.post({
      type: 'profiles',
      list: this.mgr.list().map((p) => ({
        id: p.id,
        name: p.name,
        kind: KIND_LABELS[p.type],
        target: describeProfile(p),
        color: p.color,
        lastTest: p.lastTest,
        connected: this.mgr.isConnected(p.id),
        active: this.mgr.activeProfileId === p.id,
      })),
    });
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    this.ready = false;
    view.webview.options = { enableScripts: true };
    view.webview.html = html();
    view.webview.onDidReceiveMessage((m: In) => void this.onMessage(m));
    view.onDidDispose(() => {
      this.view = undefined;
      this.ready = false;
    });
  }

  /** Ouvre le formulaire (vide ou pour modifier une connexion). */
  async open(profile?: Profile) {
    this.pendingEdit = profile ?? null;
    await vscode.commands.executeCommand('dbexplorer.sideTab.connection');
    await vscode.commands.executeCommand(`${SetupView.viewId}.focus`);
    if (this.ready) this.flushEdit();
  }

  private post(msg: unknown) {
    if (this.view && this.ready) void this.view.webview.postMessage(msg);
  }

  private flushEdit() {
    if (this.pendingEdit === undefined) return;
    this.post({ type: 'edit', profile: this.pendingEdit });
    this.pendingEdit = undefined;
  }

  private tnsInfo(dir?: string) {
    const cfg = vscode.workspace.getConfiguration('dbexplorer').get<string>('tnsAdmin') || undefined;
    const found = findTnsAdmin(dir ?? cfg);
    return { dir: found ?? '', aliases: found ? listTnsAliases(found) : [] };
  }

  private async onMessage(m: In) {
    switch (m.cmd) {
      case 'ready':
        this.ready = true;
        this.post({ type: 'init', kinds: KIND_LABELS, tns: this.tnsInfo(), colors: COLORS, suggested: nextColor(this.mgr.list().map((x) => x.color)) });
        this.pushProfiles();
        this.flushEdit();
        // détection des tnsnames.ora de la machine (registre, ORACLE_HOME, Instant Client…), sans bloquer l'affichage
        void detectTnsDirs(vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath)).then((dirs) => {
          this.post({ type: 'tnsDirs', dirs });
          const cur = this.tnsInfo();
          if (cur.dir) this.post({ type: 'tns', ...cur });
        });
        break;
      case 'tns':
        this.post({ type: 'tns', ...this.tnsInfo(m.dir || undefined) });
        break;
      case 'browseTns': {
        const sel = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: t('Folder containing tnsnames.ora') });
        if (!sel?.[0]) return;
        if (!findTnsAdmin(sel[0].fsPath)) {
          vscode.window.showWarningMessage(t('tnsnames.ora not found in this folder.'));
          return;
        }
        this.post({ type: 'tns', ...this.tnsInfo(sel[0].fsPath) });
        break;
      }
      case 'browseFile': {
        const sel = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { SQLite: ['db', 'sqlite', 'sqlite3', 'db3', 's3db'], [t('All files')]: ['*'] } });
        if (sel?.[0]) this.post({ type: 'file', path: sel[0].fsPath });
        break;
      }
      case 'test': {
        const err = await this.mgr.test(this.normalize(m.profile), m.password);
        this.post({ type: 'result', ok: !err, message: err ? err + (analyzeError(err).hint ? '\n💡 ' + analyzeError(err).hint : '') : t('Connection successful.') });
        if (m.profile.id && this.mgr.get(m.profile.id)) await this.mgr.recordTest(m.profile.id, !err, err);
        break;
      }
      case 'setColor': {
        const p = this.mgr.get(m.id);
        if (p) await this.mgr.upsert({ ...p, color: m.color || undefined });
        break;
      }
      case 'connect':
        await this.mgr.connect(m.id);
        if (this.mgr.isConnected(m.id)) await vscode.commands.executeCommand('dbexplorer.sideTab.browser');
        break;
      case 'tab':
        await vscode.commands.executeCommand('dbexplorer.sideTab.browser');
        break;
      case 'disconnect':
        await this.mgr.disconnect(m.id);
        break;
      case 'editProfile':
        await this.open(this.mgr.get(m.id));
        break;
      case 'testSaved': {
        const p = this.mgr.get(m.id);
        if (!p) break;
        const err = await this.mgr.test(p, '');
        await this.mgr.recordTest(m.id, !err, err);
        break;
      }
      case 'save': {
        const p = this.normalize(m.profile);
        const existing = this.mgr.get(p.id);
        await this.mgr.upsert(p, existing && m.password === '' ? undefined : m.password);
        this.post({ type: 'result', ok: true, message: t('Connection "{0}" saved.', p.name), saved: true, suggested: nextColor(this.mgr.list().map((x) => x.color)) });
        if (m.connect) {
          await this.mgr.connect(p.id);
          if (this.mgr.isConnected(p.id)) await vscode.commands.executeCommand('dbexplorer.sideTab.browser'); // connecté : retour au Schema Browser
        }
        break;
      }
    }
  }

  private normalize(p: Profile): Profile {
    const out: Profile = { ...p, id: p.id || `c${Date.now().toString(36)}` };
    if (out.port !== undefined) out.port = Number(out.port) || undefined;
    if (!out.name) out.name = out.type === 'sqlite' ? (out.database || 'SQLite').split(/[\\/]/).pop()! : `${out.user ?? ''}@${out.connectString ?? out.host ?? ''}`;
    return out;
  }
}

function html(): string {
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const T = {
    newConn: t('New connection'),
    edit: t('Edit "{0}"', '{0}'),
    unchanged: t('(empty = unchanged)'),
    oracleReq: t('User and alias / connection string are required.'),
    hostReq: t('Host and user are required.'),
    aliasN: t('({0} alias)', '{0}'),
    notFound: t('(not found)'),
    noColor: t('No color'),
    testedOk: t('Tested OK'),
    testFailed: t('Test failed'),
    untested: t('Not tested'),
    connected: t('connected'),
    connect: t('Connect'),
    disconnect: t('Disconnect'),
    test: t('Test'),
    editBtn: t('Edit'),
    changeColor: t('Change color'),
    noProfiles: t('No saved connection yet.'),
  };
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body{padding:0 10px 12px;font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground)}
h4{margin:14px 0 6px;text-transform:uppercase;font-size:11px;letter-spacing:.06em;opacity:.8}
label{display:block;margin:7px 0 2px;font-size:12px;opacity:.9}
input,select{width:100%;box-sizing:border-box;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));padding:4px 6px;font-family:inherit;font-size:inherit}
input:focus,select:focus{outline:1px solid var(--vscode-focusBorder)}
.row{display:flex;gap:6px;align-items:flex-end}.row>*{flex:1}.row>button{flex:0 0 auto}
.chk{display:flex;gap:6px;align-items:center;margin-top:8px}.chk input{width:auto}
button{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:0;padding:5px 10px;border-radius:2px;cursor:pointer;font-family:inherit}
button:hover{background:var(--vscode-button-secondaryHoverBackground)}
button.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
button.primary:hover{background:var(--vscode-button-hoverBackground)}
.btns{display:flex;gap:6px;flex-wrap:wrap;margin-top:12px}
.sw{display:flex;gap:6px;flex-wrap:wrap;margin-top:4px}.sw button{width:20px;height:20px;border-radius:50%;padding:0;border:2px solid var(--vscode-panel-border);line-height:1;font-size:11px}.sw button.on{border-color:var(--vscode-focusBorder)}
.prow{display:flex;gap:6px;align-items:center;padding:4px 0;border-bottom:1px solid var(--vscode-panel-border)}
.dot{width:14px;height:14px;border-radius:50%;padding:0;border:2px solid var(--vscode-panel-border);flex:0 0 auto}
.pinfo{flex:1;min-width:0}.pinfo b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pinfo .muted{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tag{font-size:10px;padding:0 6px;border-radius:8px;white-space:nowrap}
.tag.ok{background:rgba(63,185,80,.25);color:var(--vscode-testing-iconPassed,#3fb950)}.tag.ko{background:rgba(244,71,71,.22);color:var(--vscode-errorForeground)}.tag.na{background:rgba(128,128,128,.25)}
.pact{display:flex;gap:3px;flex:0 0 auto}.pact button{padding:2px 6px;font-size:11px}
.pal{display:flex;gap:6px;flex-wrap:wrap;padding:4px 0 6px 20px}.pal button{width:18px;height:18px;border-radius:50%;padding:0;border:2px solid var(--vscode-panel-border);font-size:10px;line-height:1}
.hide{display:none}
h4.fold{cursor:pointer;user-select:none}h4.fold:before{content:'▾ '}h4.fold.shut:before{content:'▸ '}h4.fold.shut+.secbody{display:none}
#msg{margin-top:8px;font-size:12px;min-height:16px}.ok{color:var(--vscode-testing-iconPassed,#3fb950)}.ko{color:var(--vscode-errorForeground)}
.muted{opacity:.75;font-size:11px}
#tabs{display:flex;border-bottom:1px solid var(--vscode-panel-border);margin:0 -10px 6px;position:sticky;top:0;background:var(--vscode-sideBar-background,var(--vscode-editor-background));z-index:2}
.tab{padding:6px 14px;cursor:pointer;opacity:.7;border-bottom:2px solid transparent;user-select:none}
.tab.on{opacity:1;border-bottom-color:var(--vscode-focusBorder);font-weight:600}
</style></head><body>
<div id="tabs"><div class="tab" id="tabBrowser">${t('Schema Browser')}</div><div class="tab on">${t('Connection')}</div></div>
<h4 class="fold" data-k="saved">${t('Saved connections')}</h4>
<div class="secbody"><div id="plist"></div></div>
<h4 class="fold" id="title" data-k="new">${t('New connection')}</h4>
<div class="secbody">
<label>${t('Database type')}</label><select id="type"></select>
<label>${t('Connection name (optional)')}</label><input id="name" placeholder="${t('e.g. Production')}">
<label>${t('Color')} <span class="muted">${t('(tab and status bar of its SQL editors)')}</span></label><div id="colors" class="sw"></div>

<div data-for="oracle">
  <label>${t('User')}</label><input id="o_user" autocomplete="off">
  <label>${t('TNS alias or host:port/service')}</label>
  <input id="o_cs" list="aliases" placeholder="${t('e.g. MYDB or localhost:1521/XEPDB1')}" autocomplete="off"><datalist id="aliases"></datalist>
  <label>${t('tnsnames.ora folder')} <span id="tnsn" class="muted"></span></label>
  <div class="row"><input id="o_tns" list="tnsdirs" placeholder="${t('auto (TNS_ADMIN / ORACLE_HOME)')}"><datalist id="tnsdirs"></datalist><button id="tnsbrowse" title="${t('Browse')}">…</button></div>
  <label>${t('Role')}</label><select id="o_role"><option>DEFAULT</option><option>SYSDBA</option><option>SYSOPER</option></select>
</div>

<div data-for="sqlite" class="hide">
  <label>${t('SQLite file (empty = in-memory database)')}</label>
  <div class="row"><input id="s_file" placeholder="C:\\path\\database.db"><button id="filebrowse">…</button></div>
</div>

<div data-for="mysql postgres" class="hide">
  <div class="row"><div><label>${t('Host')}</label><input id="m_host" value="localhost"></div><div style="flex:0 0 80px"><label>${t('Port')}</label><input id="m_port" type="number"></div></div>
  <label>${t('Database')}</label><input id="m_db">
  <label>${t('User')}</label><input id="m_user" autocomplete="off">
  <div class="chk"><input type="checkbox" id="m_ssl"><span>SSL</span></div>
</div>

<label>${t('Environment')}</label><select id="env"><option value="">—</option><option value="dev">DEV</option><option value="test">TEST</option><option value="prod">PROD</option></select>
<div class="chk"><input type="checkbox" id="ro"><span>${t('Read-only (only queries can run)')}</span></div>
<div data-for="oracle mysql postgres">
  <label>${t('Password')} <span id="pwhint" class="muted"></span></label><input id="pw" type="password" autocomplete="new-password">
</div>

<div class="btns">
  <button class="primary" id="saveconn">${t('Save and connect')}</button>
  <button id="save">${t('Save')}</button>
  <button id="test">${t('Test')}</button>
  <button id="clear">${t('New')}</button>
</div>
<div id="msg"></div>
</div>

<script nonce="${nonce}">
const vs=acquireVsCodeApi();
document.getElementById('env').onchange=e=>{if(e.target.value==='prod')document.getElementById('ro').checked=true;};
document.getElementById('tabBrowser').onclick=()=>vs.postMessage({cmd:'tab',tab:'browser'});
const T=${JSON.stringify(T)};
const $=id=>document.getElementById(id);
// sections repliables (état mémorisé)
const fold=(vs.getState()||{}).fold||{};
document.querySelectorAll('h4.fold').forEach(h=>{h.classList.toggle('shut',!!fold[h.dataset.k]);h.onclick=()=>{h.classList.toggle('shut');fold[h.dataset.k]=h.classList.contains('shut');vs.setState({fold});};});
function openNew(){const h=$('title');if(h.classList.contains('shut')){h.classList.remove('shut');fold.new=false;vs.setState({fold});}}
let editingId=null, kinds={}, ports={mysql:3306,postgres:5432}, colors={}, color='', suggested='';
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function applyType(){
  const t=$('type').value;
  document.querySelectorAll('[data-for]').forEach(e=>e.classList.toggle('hide',!e.dataset.for.split(' ').includes(t)));
  if(ports[t]&&(!$('m_port').value||Object.values(ports).includes(+$('m_port').value)))$('m_port').value=ports[t];
  if(t==='postgres'&&!$('m_user').value)$('m_user').value='postgres';
}
function clearForm(){
  editingId=null;color=suggested;renderColors();$('title').textContent=T.newConn;
  for(const id of ['name','o_user','o_cs','s_file','m_db','m_user','pw'])$(id).value='';
  $('m_host').value='localhost';$('m_port').value='';$('m_ssl').checked=false;$('ro').checked=false;$('env').value='';$('o_role').value='DEFAULT';
  $('pwhint').textContent='';$('msg').textContent='';applyType();
}
function profile(){
  const type=$('type').value,p={id:editingId||'',type,name:$('name').value.trim(),color:color||undefined};
  if(type==='oracle')Object.assign(p,{user:$('o_user').value.trim(),connectString:$('o_cs').value.trim(),tnsAdmin:$('o_tns').value.trim()||undefined,role:$('o_role').value});
  else if(type==='sqlite')p.database=$('s_file').value.trim();
  else Object.assign(p,{host:$('m_host').value.trim(),port:+$('m_port').value||undefined,database:$('m_db').value.trim(),user:$('m_user').value.trim(),ssl:$('m_ssl').checked});
  if($('env').value)p.env=$('env').value;
  if($('ro').checked)p.readOnly=true;
  return p;
}
function valid(p){
  if(p.type==='oracle'&&(!p.user||!p.connectString))return T.oracleReq;
  if((p.type==='mysql'||p.type==='postgres')&&(!p.host||!p.user))return T.hostReq;
  return '';
}
function say(ok,t){const m=$('msg');m.className=ok?'ok':'ko';m.textContent=t;}
function send(cmd,extra){const p=profile(),e=valid(p);if(e)return say(false,e);say(true,'…');vs.postMessage({cmd,profile:p,password:$('pw').value,...extra});}
$('type').onchange=applyType;
$('save').onclick=()=>send('save',{connect:false});
$('saveconn').onclick=()=>send('save',{connect:true});
$('test').onclick=()=>send('test');
$('clear').onclick=clearForm;
$('tnsbrowse').onclick=()=>vs.postMessage({cmd:'browseTns'});
$('filebrowse').onclick=()=>vs.postMessage({cmd:'browseFile'});
$('o_tns').onchange=()=>vs.postMessage({cmd:'tns',dir:$('o_tns').value.trim()});
let plist=[],openColor=null;
function renderProfiles(){
  const box=$('plist');
  if(!plist.length){box.innerHTML='<div class="muted">'+T.noProfiles+'</div>';return;}
  box.innerHTML=plist.map(p=>{
    const hex=p.color&&colors[p.color]?colors[p.color]:'transparent';
    const lt=p.lastTest;
    const badge=lt?(lt.ok?'<span class="tag ok" title="'+esc(new Date(lt.at).toLocaleString())+'">✓ '+T.testedOk+'</span>':'<span class="tag ko" title="'+esc((lt.message||'')+' — '+new Date(lt.at).toLocaleString())+'">✗ '+T.testFailed+'</span>'):'<span class="tag na">'+T.untested+'</span>';
    return '<div class="prow"><button class="dot" data-a="color" data-id="'+esc(p.id)+'" title="'+T.changeColor+'" style="background:'+hex+'"></button>'
      +'<div class="pinfo"><b>'+esc(p.name)+(p.connected?' <span class="tag ok">● '+T.connected+'</span>':'')+'</b><div class="muted">'+esc(p.kind)+' · '+esc(p.target)+'</div></div>'+badge
      +'<div class="pact">'+(p.connected?'<button data-a="disconnect" data-id="'+esc(p.id)+'">'+T.disconnect+'</button>':'<button data-a="connect" data-id="'+esc(p.id)+'">'+T.connect+'</button>')
      +'<button data-a="testSaved" data-id="'+esc(p.id)+'">'+T.test+'</button><button data-a="editProfile" data-id="'+esc(p.id)+'">'+T.editBtn+'</button></div></div>'
      +(openColor===p.id?'<div class="pal"><button data-a="pick" data-id="'+esc(p.id)+'" data-c="" title="'+T.noColor+'" style="background:transparent">×</button>'+Object.entries(colors).map(([k,h])=>'<button data-a="pick" data-id="'+esc(p.id)+'" data-c="'+k+'" title="'+k+'" style="background:'+h+';'+(p.color===k?'border-color:var(--vscode-focusBorder)':'')+'"></button>').join('')+'</div>':'');
  }).join('');
  box.querySelectorAll('button[data-a]').forEach(b=>b.onclick=()=>{const a=b.dataset.a,id=b.dataset.id;
    if(a==='color'){openColor=openColor===id?null:id;renderProfiles();}
    else if(a==='pick'){openColor=null;vs.postMessage({cmd:'setColor',id,color:b.dataset.c});}
    else vs.postMessage({cmd:a,id});});
}
function renderColors(){
  $('colors').innerHTML='<button data-c="" title="'+T.noColor+'" class="'+(color===''?'on':'')+'" style="background:transparent">×</button>'+Object.entries(colors).map(([k,h])=>'<button data-c="'+k+'" title="'+k+'" class="'+(color===k?'on':'')+'" style="background:'+h+'"></button>').join('');
  document.querySelectorAll('#colors button').forEach(b=>b.onclick=()=>{color=b.dataset.c;renderColors();});
}
function renderTns(m){
  $('o_tns').value=m.dir||'';
  $('aliases').innerHTML=m.aliases.map(a=>'<option value="'+esc(a)+'">').join('');
  $('tnsn').textContent=m.dir?T.aliasN.replace('{0}',m.aliases.length):T.notFound;
}
window.addEventListener('message',e=>{const m=e.data;
  if(m.type==='init'){kinds=m.kinds;colors=m.colors;renderProfiles();suggested=m.suggested;color=suggested;renderColors();$('type').innerHTML=Object.entries(kinds).map(([k,v])=>'<option value="'+k+'">'+esc(v)+'</option>').join('');renderTns(m.tns);applyType();}
  else if(m.type==='tns')renderTns(m);
  else if(m.type==='profiles'){plist=m.list;renderProfiles();}
  else if(m.type==='tnsDirs')$('tnsdirs').innerHTML=m.dirs.map(d=>'<option value="'+esc(d)+'">').join('');
  else if(m.type==='file')$('s_file').value=m.path;
  else if(m.type==='result'){say(m.ok,m.message);if(m.suggested)suggested=m.suggested;if(m.saved&&!editingId){const msg=m.message;clearForm();say(true,msg);}}
  else if(m.type==='edit'){
    clearForm();const p=m.profile;if(!p)return;
    openNew();editingId=p.id;$('title').textContent=T.edit.replace('{0}',p.name);$('type').value=p.type;applyType();$('name').value=p.name||'';color=p.color||'';renderColors();
    if(p.type==='oracle'){$('o_user').value=p.user||'';$('o_cs').value=p.connectString||'';if(p.tnsAdmin){$('o_tns').value=p.tnsAdmin;vs.postMessage({cmd:'tns',dir:p.tnsAdmin});}$('o_role').value=p.role||'DEFAULT';}
    else if(p.type==='sqlite')$('s_file').value=p.database||'';
    else{$('m_host').value=p.host||'';$('m_port').value=p.port||'';$('m_db').value=p.database||'';$('m_user').value=p.user||'';$('m_ssl').checked=!!p.ssl;}
    $('ro').checked=!!p.readOnly;$('env').value=p.env||'';
    $('pwhint').textContent=T.unchanged;
  }
});
vs.postMessage({cmd:'ready'});
</script></body></html>`;
}
