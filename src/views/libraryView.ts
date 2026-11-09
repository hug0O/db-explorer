import * as vscode from 'vscode';
import { ConnectionManager } from '../connections';
import { HistoryItem, Runner } from '../runner';
import { FavoritesTree, Favorite } from './favoritesTree';
import { t } from '../i18n';

type In =
  | { cmd: 'ready' }
  | { cmd: 'act'; kind: 'hist' | 'fav'; op: 'open' | 'run' | 'insert' | 'copy' | 'delete' | 'rename'; id: string }
  | { cmd: 'clearHistory' }
  | { cmd: 'favAdd' }
  | { cmd: 'favPick' };

/** Vue « Historique & favoris » : deux onglets internes (requêtes exécutées / requêtes enregistrées), avec filtre. */
export class LibraryView implements vscode.WebviewViewProvider {
  static readonly viewId = 'dbexplorer.library';
  private view?: vscode.WebviewView;
  private ready = false;

  constructor(private readonly runner: Runner, private readonly favorites: FavoritesTree, private readonly mgr: ConnectionManager) {
    runner.onDidChangeHistory(() => this.push());
    favorites.onDidChangeTreeData(() => this.push());
    mgr.onDidChange(() => this.push());
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    this.ready = false;
    view.webview.options = { enableScripts: true };
    view.webview.html = html();
    view.webview.onDidReceiveMessage((m: In) => void this.onMessage(m));
    view.onDidChangeVisibility(() => view.visible && this.push());
    view.onDidDispose(() => {
      this.view = undefined;
      this.ready = false;
    });
  }

  private push() {
    if (!this.view || !this.ready) return;
    const hist = this.runner.history.slice(0, 1000).map((h) => ({ id: String(h.ts), sql: h.sql, ts: h.ts, conn: h.conn, ms: h.ms, ok: h.ok }));
    const groupOf = (f: Favorite) => (f.pid ? this.mgr.get(f.pid)?.name ?? f.pname ?? f.pid : '');
    const favs = this.favorites.list().map((f) => ({ id: f.id, name: f.name, sql: f.sql, group: groupOf(f), active: !!f.pid && f.pid === this.mgr.activeProfileId }));
    void this.view.webview.postMessage({ type: 'state', hist, favs });
  }

  private histOf(id: string): HistoryItem | undefined {
    return this.runner.history.find((h) => String(h.ts) === id);
  }

  private async onMessage(m: In) {
    switch (m.cmd) {
      case 'ready':
        this.ready = true;
        this.push();
        break;
      case 'clearHistory':
        await vscode.commands.executeCommand('dbexplorer.history.clear');
        break;
      case 'favAdd':
        await vscode.commands.executeCommand('dbexplorer.favorite.add');
        break;
      case 'favPick':
        await vscode.commands.executeCommand('dbexplorer.favorite.pick');
        break;
      case 'act': {
        if (m.kind === 'hist') {
          const item = this.histOf(m.id);
          if (item) await vscode.commands.executeCommand('dbexplorer.history.' + m.op, { kind: 'item', item });
        } else {
          const fav = this.favorites.list().find((f) => f.id === m.id);
          if (fav) await vscode.commands.executeCommand('dbexplorer.favorite.' + m.op, { kind: 'fav', fav });
        }
        break;
      }
    }
  }
}

function html(): string {
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const T = {
    history: t('History'),
    favorites: t('Favorites'),
    filter: t('Filter…'),
    today: t('Today'),
    yesterday: t('Yesterday'),
    noHist: t('No query executed yet.'),
    noFav: t('No favorite yet: use "Save as favorite" in a SQL editor.'),
    noMatch: t('No match.'),
    clear: t('Clear history'),
    add: t('Save the current statement'),
    pick: t('Insert a favorite…'),
    failed: t('failed'),
    all: t('All connections'),
    open: t('Open in editor'),
    run: t('Run'),
    insert: t('Insert at the cursor'),
    copy: t('Copy the SQL'),
    del: t('Delete'),
    rename: t('Rename…'),
  };
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body{margin:0;padding:0;font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground)}
#tabs{display:flex;border-bottom:1px solid var(--vscode-panel-border);position:sticky;top:0;background:var(--vscode-sideBar-background,var(--vscode-editor-background));z-index:2}
.tab{padding:6px 12px;cursor:pointer;opacity:.7;border-bottom:2px solid transparent;user-select:none}
.tab.on{opacity:1;border-bottom-color:var(--vscode-focusBorder);font-weight:600}
.badge{margin-left:4px;font-size:10px;padding:0 6px;border-radius:8px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}
#bar{display:flex;gap:6px;padding:6px 8px;align-items:center}
#q{flex:1;min-width:0;box-sizing:border-box;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));padding:3px 6px;font:inherit}
#q:focus{outline:1px solid var(--vscode-focusBorder)}
button.b{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:0;padding:3px 8px;border-radius:2px;cursor:pointer;font:inherit;font-size:11px;white-space:nowrap}
button.b:hover{background:var(--vscode-button-secondaryHoverBackground)}
.grp{display:flex;align-items:center;gap:4px;padding:4px 8px;font-size:11px;font-weight:600;opacity:.8;cursor:pointer;user-select:none;text-transform:uppercase}
.item{display:flex;align-items:center;gap:6px;padding:3px 8px;cursor:pointer;position:relative}
.item:hover{background:var(--vscode-list-hoverBackground)}
.ico{width:14px;text-align:center;flex:none}
.ok{color:var(--vscode-testing-iconPassed,#3fb950)}.ko{color:var(--vscode-testing-iconFailed,#f14c4c)}.star{color:#e0a458}
.txt{min-width:0;flex:1}
.t1{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.t2{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:11px;opacity:.65}
.act{display:none;gap:2px;flex:none}
.item:hover .act{display:flex}
.act span{cursor:pointer;padding:0 4px;border-radius:3px;opacity:.85}
.act span:hover{background:var(--vscode-toolbar-hoverBackground);opacity:1}
.empty{padding:14px 12px;opacity:.7;font-size:12px}
</style></head><body>
<div id="tabs"><div class="tab" data-t="hist">${T.history}<span class="badge" id="nh">0</span></div><div class="tab" data-t="fav">${T.favorites}<span class="badge" id="nf">0</span></div></div>
<div id="bar"><input id="q" placeholder="${T.filter}"><span id="btns"></span></div>
<div id="list"></div>
<script nonce="${nonce}">
const vs=acquireVsCodeApi();const T=${JSON.stringify(T)};const $=id=>document.getElementById(id);
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
let data={hist:[],favs:[]},tab=(vs.getState()||{}).tab||'hist',filter='',collapsed=new Set(((vs.getState()||{}).collapsed)||[]);
function save(){vs.setState({tab:tab,collapsed:[...collapsed]});}
function first(sql){const l=sql.split('\\n').map(x=>x.trim()).find(x=>x)||sql;return l.replace(/\\s+/g,' ');}
function dayLabel(ts){const d=new Date(ts),n=new Date(),y=new Date(Date.now()-86400000);
  return d.toDateString()===n.toDateString()?T.today:d.toDateString()===y.toDateString()?T.yesterday:d.toLocaleDateString();}
function actions(kind,id,ops){return '<span class="act">'+ops.map(o=>'<span data-k="'+kind+'" data-op="'+o[0]+'" data-id="'+esc(id)+'" title="'+esc(o[2])+'">'+o[1]+'</span>').join('')+'</span>';}
function group(key,label,count,body){const c=collapsed.has(key);return '<div class="grp" data-g="'+esc(key)+'"><span>'+(c?'▸':'▾')+'</span>'+esc(label)+' <span class="badge">'+count+'</span></div>'+(c?'':body);}
function render(){
  document.querySelectorAll('.tab').forEach(e=>e.classList.toggle('on',e.dataset.t===tab));
  $('nh').textContent=data.hist.length;$('nf').textContent=data.favs.length;
  const f=filter.toLowerCase();let h='';
  if(tab==='hist'){
    $('btns').innerHTML='<button class="b" id="bclear">'+esc(T.clear)+'</button>';
    const items=data.hist.filter(x=>!f||x.sql.toLowerCase().includes(f)||x.conn.toLowerCase().includes(f));
    if(!data.hist.length)h='<div class="empty">'+T.noHist+'</div>';else if(!items.length)h='<div class="empty">'+T.noMatch+'</div>';
    const groups=new Map();for(const x of items){const k=new Date(x.ts).toDateString();if(!groups.has(k))groups.set(k,[]);groups.get(k).push(x);}
    for(const [k,xs] of groups){h+=group('h:'+k,dayLabel(xs[0].ts),xs.length,xs.map(x=>{
      const time=new Date(x.ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
      return '<div class="item" data-k="hist" data-op="open" data-id="'+esc(x.id)+'" title="'+esc(x.sql.length>1500?x.sql.slice(0,1500)+'…':x.sql)+(x.ok?'':'\\n— '+T.failed)+'"><span class="ico '+(x.ok?'ok':'ko')+'">'+(x.ok?'✓':'✗')+'</span><span class="txt"><div class="t1">'+esc(first(x.sql))+'</div><div class="t2">'+time+' · '+esc(x.conn)+' · '+x.ms+' ms</div></span>'
        +actions('hist',x.id,[['run','▶',T.run],['insert','⎘',T.insert],['copy','⧉',T.copy],['delete','🗑',T.del]])+'</div>';}).join(''));}
  }else{
    $('btns').innerHTML='<button class="b" id="badd">+ '+esc(T.add)+'</button><button class="b" id="bpick">'+esc(T.pick)+'</button>';
    const items=data.favs.filter(x=>!f||x.sql.toLowerCase().includes(f)||x.name.toLowerCase().includes(f)||x.group.toLowerCase().includes(f));
    if(!data.favs.length)h='<div class="empty">'+T.noFav+'</div>';else if(!items.length)h='<div class="empty">'+T.noMatch+'</div>';
    const groups=new Map();for(const x of items){const k=x.group||'';if(!groups.has(k))groups.set(k,[]);groups.get(k).push(x);}
    const keys=[...groups.keys()].sort((a,b)=>a===''?-1:b===''?1:(groups.get(a)[0].active?-1:groups.get(b)[0].active?1:a.localeCompare(b)));
    for(const k of keys){const xs=groups.get(k);h+=group('f:'+k,k||T.all,xs.length,xs.map(x=>
      '<div class="item" data-k="fav" data-op="open" data-id="'+esc(x.id)+'" title="'+esc(x.sql.length>1500?x.sql.slice(0,1500)+'…':x.sql)+'"><span class="ico star">★</span><span class="txt"><div class="t1">'+esc(x.name)+'</div><div class="t2">'+esc(first(x.sql))+'</div></span>'
      +actions('fav',x.id,[['run','▶',T.run],['insert','⎘',T.insert],['rename','✎',T.rename],['delete','🗑',T.del]])+'</div>').join(''));}
  }
  $('list').innerHTML=h;
  document.querySelectorAll('.grp').forEach(g=>g.onclick=()=>{const k=g.dataset.g;collapsed.has(k)?collapsed.delete(k):collapsed.add(k);save();render();});
  document.querySelectorAll('.item').forEach(i=>i.onclick=e=>{if(e.target.closest('.act'))return;vs.postMessage({cmd:'act',kind:i.dataset.k,op:'open',id:i.dataset.id});});
  document.querySelectorAll('.act span').forEach(s=>s.onclick=e=>{e.stopPropagation();vs.postMessage({cmd:'act',kind:s.dataset.k,op:s.dataset.op,id:s.dataset.id});});
  const bc=$('bclear');if(bc)bc.onclick=()=>vs.postMessage({cmd:'clearHistory'});
  const ba=$('badd');if(ba)ba.onclick=()=>vs.postMessage({cmd:'favAdd'});
  const bp=$('bpick');if(bp)bp.onclick=()=>vs.postMessage({cmd:'favPick'});
}
document.querySelectorAll('.tab').forEach(e=>e.onclick=()=>{tab=e.dataset.t;save();render();});
$('q').oninput=e=>{filter=e.target.value;render();};
window.addEventListener('message',e=>{if(e.data.type==='state'){data=e.data;render();}});
render();vs.postMessage({cmd:'ready'});
</script></body></html>`;
}
