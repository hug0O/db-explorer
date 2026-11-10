import { t } from '../i18n';
import * as vscode from 'vscode';
import { DbConn, FoundObject } from '../drivers/types';
import { dataContent, loadTab, objectInfo, tabsFor } from '../objectTabs';
import type { MetaCache } from '../metaCache';
import { linkQuery, pickLink, tablesOf } from '../linkFollow';
import type { GridLink } from '../keyFlags';

/** « Describe Objects » façon Toad : onglets Columns, Indexes, Constraints, Triggers, Data, Script, Grants… */
export class DescribePanel {
  private static panels = new Map<string, vscode.WebviewPanel>();
  /** Cache de métadonnées (indicateurs PK / FK et navigation dans l'onglet Data). */
  static meta?: MetaCache;

  static open(profileId: string, conn: DbConn, o: FoundObject) {
    const key = `${profileId}|${o.type}|${o.schema}|${o.name}`;
    const existing = DescribePanel.panels.get(key);
    if (existing) {
      existing.reveal(undefined, false);
      return;
    }
    const panel = vscode.window.createWebviewPanel('dbexplorer.describe', `${o.schema}.${o.name}`, { viewColumn: vscode.ViewColumn.Beside }, { enableScripts: true, retainContextWhenHidden: true });
    DescribePanel.panels.set(key, panel);
    panel.onDidDispose(() => DescribePanel.panels.delete(key));
    panel.webview.html = html();
    const ctx = { pid: profileId, cache: DescribePanel.meta };
    panel.webview.onDidReceiveMessage(async (m: { cmd: 'ready' } | { cmd: 'openSql'; sql: string } | { cmd: 'loadAll'; sql: string } | { cmd: 'tab'; id: string } | { cmd: 'open'; name: string } | { cmd: 'follow'; links: GridLink[]; vals: unknown[]; sql?: string; choose?: boolean }) => {
      if (m.cmd === 'ready') {
        const tabs = tabsFor(conn, o);
        void panel.webview.postMessage({ type: 'init', title: `${o.schema}.${o.name}`, objType: o.type, tabs });
        void objectInfo(conn, o).then((lines) => panel.webview.postMessage({ type: 'info', lines }));
      } else if (m.cmd === 'open') {
        // table liée (onglet Referential) : ouvre son propre « Describe »
        const i = m.name.lastIndexOf('.');
        const found = await conn.findObject(i > 0 ? m.name.slice(0, i) : o.schema, i > 0 ? m.name.slice(i + 1) : m.name).catch(() => undefined);
        if (found) DescribePanel.open(profileId, conn, found);
      } else if (m.cmd === 'follow') {
        // Ctrl+clic sur une clé de l'onglet Data : lien choisi d'après la requête affichée, résultat renvoyé à l'onglet (fil d'Ariane côté page)
        try {
          let link = pickLink(m.links, tablesOf(m.sql ?? ''));
          if (m.choose && m.links.length > 1) {
            const pick = await vscode.window.showQuickPick(
              m.links.map((l) => ({ label: (l.k === 'p' ? '$(arrow-up) ' + t('Parent row') : '$(arrow-down) ' + t('Child rows')) + ' — ' + l.t, description: l.tc.join(', '), l })),
              { placeHolder: t('Follow which link?') }
            );
            if (!pick) return;
            link = pick.l;
          }
          const q = linkQuery(link, m.vals, conn);
          if (!q) return void vscode.window.showInformationMessage(t('NULL key: nothing to follow.'));
          const content = await dataContent(conn, q.sql, o.schema, ctx);
          void panel.webview.postMessage({ type: 'follow', label: q.label, content });
        } catch (e) {
          void panel.webview.postMessage({ type: 'follow', error: (e as Error).message });
        }
      } else if (m.cmd === 'openSql') {
        void vscode.commands.executeCommand('dbexplorer.openSqlText', m.sql, profileId);
      } else if (m.cmd === 'loadAll') {
        // « Tout charger » : toutes les lignes de la requête affichée (plafond : dbexplorer.showAllMaxRows)
        const cap = vscode.workspace.getConfiguration('dbexplorer').get<number>('showAllMaxRows', 100000);
        try {
          const content = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Loading all rows of {0}…', o.name) }, () => dataContent(conn, m.sql, o.schema, ctx, cap > 0 ? cap : 1_000_000_000));
          void panel.webview.postMessage({ type: 'all', content });
        } catch (e) {
          void panel.webview.postMessage({ type: 'all', error: (e as Error).message });
        }
      } else if (m.cmd === 'tab') {
        try {
          const content = await loadTab(conn, o, m.id, ctx);
          void panel.webview.postMessage({ type: 'tab', id: m.id, content });
        } catch (e) {
          void panel.webview.postMessage({ type: 'tab', id: m.id, error: (e as Error).message });
        }
      }
    });
  }
}

function html(): string {
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body{margin:0;display:flex;flex-direction:column;height:100vh;font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-editor-background)}
#head{padding:8px 12px 4px}
#title{font-size:15px;font-weight:600}#type{opacity:.7;font-size:11px;margin-left:6px;text-transform:uppercase}
.info{margin-top:3px;opacity:.9;font-size:12px}
#tabs{display:flex;flex-wrap:wrap;gap:0;padding:6px 12px 0;border-bottom:1px solid var(--vscode-panel-border)}
.tab{padding:4px 12px;cursor:pointer;border:1px solid transparent;border-bottom:none;border-radius:3px 3px 0 0;opacity:.75;user-select:none}
.tab:hover{opacity:1}
.tab.on{opacity:1;border-color:var(--vscode-panel-border);background:var(--vscode-editor-background);margin-bottom:-1px;border-bottom:1px solid var(--vscode-editor-background);font-weight:600}
#bar{display:flex;gap:8px;align-items:center;padding:6px 12px}
input{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);padding:2px 6px}
#body{flex:1;overflow:auto;padding:0 12px 12px}
table{border-collapse:collapse;font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size)}
th,td{border:1px solid var(--vscode-panel-border);padding:2px 8px;white-space:nowrap;max-width:480px;overflow:hidden;text-overflow:ellipsis;text-align:left}
th{position:sticky;top:0;background:var(--vscode-editorGroupHeader-tabsBackground);cursor:pointer;user-select:none}
td.null{opacity:.45;font-style:italic}td.n{text-align:right}
tr:hover td{background:var(--vscode-list-hoverBackground)}
pre{margin:0;padding:8px 0;font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size);white-space:pre}
.err{color:var(--vscode-errorForeground)}.muted{opacity:.7;padding:8px 0}
button{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:0;padding:3px 9px;border-radius:2px;cursor:pointer}
:root{--tn:#4f9de0;--tt:#7fb069;--td:#e0a458;--tb:#b07fd0;--tl:#d0746f;--to:#8a8a8a}
th.k-n,.lg.k-n{--k:var(--tn)}th.k-t,.lg.k-t{--k:var(--tt)}th.k-d,.lg.k-d{--k:var(--td)}th.k-b,.lg.k-b{--k:var(--tb)}th.k-l,.lg.k-l{--k:var(--tl)}th.k-o,.lg.k-o{--k:var(--to)}
th[class^=k-]{box-shadow:inset 0 -3px 0 var(--k)}
td.c-n{background:color-mix(in srgb,var(--tn) 7%,transparent)}td.c-t{background:color-mix(in srgb,var(--tt) 6%,transparent)}td.c-d{background:color-mix(in srgb,var(--td) 8%,transparent)}td.c-b{background:color-mix(in srgb,var(--tb) 8%,transparent)}td.c-l{background:color-mix(in srgb,var(--tl) 8%,transparent)}
#crumbs{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:4px 10px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-editorWidget-background,var(--vscode-editor-background));font-size:12px}
#crumbs a{color:var(--vscode-textLink-foreground);cursor:pointer}#crumbs a:hover{text-decoration:underline}#crumbs .sep{opacity:.5}
#legend{display:flex;flex-wrap:wrap;gap:4px 12px;align-items:center;padding:3px 10px;font-size:11px;opacity:.85;border-bottom:1px solid var(--vscode-panel-border)}
#legend:empty{display:none}
#legend .lg{display:inline-flex;align-items:center;gap:4px}#legend .lg:before{content:'';width:10px;height:10px;border-radius:2px;background:var(--k)}
th .ki{margin-right:3px;font-size:10px}
td.lk:hover,td.rel:hover{text-decoration:underline dotted;cursor:alias}
td.rel{color:var(--vscode-textLink-foreground);cursor:pointer}
.sec{margin:10px 0;border:1px solid var(--vscode-panel-border);border-radius:4px}.sh{display:flex;gap:6px;align-items:center;padding:4px 8px;background:var(--vscode-editorGroupHeader-tabsBackground)}.sh b{flex:1}.sh .kd{opacity:.5;font-size:10px;text-transform:uppercase}.sec pre{padding:6px 10px;overflow:auto}
#crumbs{margin:0 -12px}#legend{margin:0 -12px}
</style></head><body>
<div id="head"><span id="title">…</span><span id="type"></span><div id="info" class="info"></div></div>
<div id="tabs"></div>
<div id="bar"><input id="filter" placeholder="${t('Filter…')}" size="20"><button id="copy">${t('Copy')}</button><button id="all" style="display:none"></button><span id="count" class="muted"></span></div>
<div id="crumbs" style="display:none"></div>
<div id="legend"></div>
<div id="body"></div>
<script nonce="${nonce}">
const vs=acquireVsCodeApi();const $=id=>document.getElementById(id);
const T=${JSON.stringify({ back: t('Back'), pk: t('Primary key'), fk: t('Foreign key'), follow: t('Ctrl+click on a key: follow the link (Alt+Ctrl+click: choose, Shift+Ctrl+click: new editor)').replace(/, Shift\+Ctrl\+click: new editor/, ''), kinds: { n: t('Number'), t: t('Text'), d: t('Date / time'), b: t('Boolean'), l: t('Binary / LOB'), o: t('Other') }, typesLbl: t('Column types'), parentTip: t('parent row'), childTip: t('child rows'), openRel: t('Click to open this table'), loading: t('Loading…'), nodata: t('No data.'), norows: t('No rows.'), row0: t('0 rows'), rows: t('{0} row(s)'), copy: t('Copy'), openEd: t('Open in editor'), elements: t('element(s)'), firstN: t(' (first {0})'), loadAll: t('Load all rows'), loadAllTip: t('Load every row of the table (up to the limit of dbexplorer.showAllMaxRows)'), loadingAll: t('Loading all rows…') })};
const esc=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
let cache={},cur=null,sortCol=-1,asc=true,filter='',dtrail=[];
function kind(ty){ty=String(ty||'').toLowerCase();
  if(/bool|^bit\\b|tinyint\\(1\\)/.test(ty))return 'b';
  if(/date|time|interval/.test(ty))return 'd';
  if(/int|num|dec|float|double|real|serial|money|binary_|long$|smallint|bigint/.test(ty)&&!/point|interval/.test(ty))return 'n';
  if(/blob|clob|lob|raw|bytea|binary|image|bfile|xml|json/.test(ty))return 'l';
  if(/char|text|string|uuid|enum|set|name|rowid/.test(ty))return 't';
  return 'o';}
function show(id){
  cur=id;sortCol=-1;filter='';$('filter').value='';
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('on',t.dataset.id===id));
  if(cache[id]){render();return;}
  $('body').innerHTML='<div class="muted">'+T.loading+'</div>';
  vs.postMessage({cmd:'tab',id});
}
function renderCrumbs(){
  const c=$('crumbs');
  if(cur!=='data'||dtrail.length<2){c.style.display='none';c.innerHTML='';return;}
  c.style.display='flex';
  c.innerHTML='<button id="cback">‹ '+T.back+'</button>'+dtrail.map((x,i)=>i===dtrail.length-1?'<b>'+esc(x.label)+'</b>':'<a data-i="'+i+'">'+esc(x.label)+'</a>').join('<span class="sep">›</span>');
  const go=i=>{dtrail.length=i+1;cache.data={content:dtrail[i].content};sortCol=-1;filter='';$('filter').value='';render();};
  $('cback').onclick=()=>go(dtrail.length-2);
  c.querySelectorAll('a[data-i]').forEach(a=>a.onclick=()=>go(+a.dataset.i));
}
function render(){
  $('legend').innerHTML='';renderCrumbs();
  const c=cache[cur];if(!c)return;
  if(c.error){$('body').innerHTML='<div class="err">'+esc(c.error)+'</div>';$('count').textContent='';return;}
  const ct=c.content;
  if(ct.sections&&ct.sections.length){
    $('body').innerHTML=ct.sections.map((s,i)=>'<div class="sec"><div class="sh"><b>'+esc(s.title)+'</b><span class="kd">'+esc(s.kind)+'</span><button data-c="'+i+'">'+T.copy+'</button><button data-o="'+i+'">'+T.openEd+'</button></div><pre>'+esc(s.sql)+'</pre></div>').join('');
    $('body').querySelectorAll('button[data-c]').forEach(b=>b.onclick=()=>navigator.clipboard.writeText(ct.sections[+b.dataset.c].sql));
    $('body').querySelectorAll('button[data-o]').forEach(b=>b.onclick=()=>vs.postMessage({cmd:'openSql',sql:ct.sections[+b.dataset.o].sql}));
    $('count').textContent=ct.sections.length+' '+T.elements;return;}
  if(ct.text!==undefined){$('body').innerHTML='<pre>'+esc(ct.text)+'</pre>';$('count').textContent='';return;}
  if(!ct.columns.length){$('body').innerHTML='<div class="muted">'+T.nodata+'</div>';$('count').textContent='';return;}
  let rows=ct.rows.map(r=>r);
  if(filter){const f=filter.toLowerCase();rows=rows.filter(r=>r.some(v=>v!==null&&String(v).toLowerCase().includes(f)));}
  if(sortCol>=0)rows.sort((a,b)=>{const x=a[sortCol],y=b[sortCol];if(x===null)return y===null?0:1;if(y===null)return -1;
    const k=(typeof x==='number'&&typeof y==='number')?x-y:String(x).localeCompare(String(y),undefined,{numeric:true});return asc?k:-k;});
  if(!rows.length){$('body').innerHTML='<div class="muted">'+T.norows+'</div>';$('count').textContent=T.row0;return;}
  const ks=ct.types?ct.types.map(kind):null,kf=ct.keys||[],kl=ct.links||[],isRef=cur==='referential';
  let h='<table><thead><tr>'+ct.columns.map((n,i)=>'<th'+(ks?' class="k-'+ks[i]+'"':'')+' data-i="'+i+'"'+(ct.types?' title="'+esc(ct.types[i])+'"':'')+'>'+(kf[i]?'<span class="ki">'+(kf[i].includes('P')?'🔑':'')+(kf[i].includes('F')?'🔗':'')+'</span>':'')+esc(n)+(sortCol===i?(asc?' ▲':' ▼'):'')+'</th>').join('')+'</tr></thead><tbody>';
  for(const r of rows){const ri=ct.rows.indexOf(r);h+='<tr>'+r.map((v,j)=>{
    if(v===null)return '<td class="null">(null)</td>';
    const lk=kl[j]&&kl[j].length;
    const cls=[ks?'c-'+ks[j]:'',typeof v==='number'?'n':'',lk?'lk':'',isRef&&j===2?'rel':''].filter(Boolean).join(' ');
    return '<td'+(cls?' class="'+cls+'"':'')+(lk?' data-ri="'+ri+'" data-c="'+j+'"':'')+(isRef&&j===2?' data-open="'+esc(v)+'"':'')+' title="'+esc(v)+(lk?'  ⟶ '+kl[j].map(l=>(l.k==='p'?T.parentTip:T.childTip)+': '+l.t).join(', '):'')+(isRef&&j===2?'  — '+T.openRel:'')+'">'+esc(v)+'</td>';}).join('')+'</tr>';}
  $('body').innerHTML=h+'</tbody></table>';
  $('body').querySelectorAll('td[data-c]').forEach(td=>td.onclick=e=>{if(!(e.ctrlKey||e.metaKey))return;vs.postMessage({cmd:'follow',links:kl[+td.dataset.c],vals:ct.rows[+td.dataset.ri],sql:ct.sql,choose:e.altKey});});
  $('body').querySelectorAll('td[data-open]').forEach(td=>td.onclick=()=>vs.postMessage({cmd:'open',name:td.dataset.open}));
  const used=ks?[...new Set(ks)]:[];
  $('legend').innerHTML=ks?'<b>'+T.typesLbl+'</b>'+used.map(k=>'<span class="lg k-'+k+'">'+T.kinds[k]+'</span>').join('')+(kf.some(x=>x)?'<span>'+(kf.some(x=>x.includes('P'))?'🔑 '+T.pk+'&nbsp;&nbsp;':'')+(kf.some(x=>x.includes('F'))?'🔗 '+T.fk:'')+'</span>':'')+(kl.some(l=>l&&l.length)?'<span>↗ '+T.follow+'</span>':''):'';
  $('body').querySelectorAll('th').forEach(th=>th.onclick=()=>{const i=+th.dataset.i;if(sortCol===i)asc=!asc;else{sortCol=i;asc=true;}render();});
  $('count').textContent=T.rows.replace('{0}',rows.length)+(cur==='data'&&ct.more?T.firstN.replace('{0}',ct.rows.length):'');
  $('all').style.display=cur==='data'&&ct.more?'':'none';$('all').textContent=T.loadAll;$('all').title=T.loadAllTip;
}
$('filter').oninput=e=>{filter=e.target.value;render();};
$('all').onclick=()=>{const c=cache.data;if(!c||!c.content||!c.content.sql)return;$('all').disabled=true;$('count').textContent=T.loadingAll;vs.postMessage({cmd:'loadAll',sql:c.content.sql});};
$('copy').onclick=()=>{const c=cache[cur];if(!c||c.error)return;const ct=c.content;
  navigator.clipboard.writeText(ct.text!==undefined?ct.text:ct.columns.join('\\t')+'\\n'+ct.rows.map(r=>r.map(v=>v===null?'':v).join('\\t')).join('\\n'));};
window.addEventListener('message',e=>{const m=e.data;
  if(m.type==='init'){$('title').textContent=m.title;$('type').textContent=m.objType;
    $('tabs').innerHTML=m.tabs.map(t=>'<div class="tab" data-id="'+t.id+'">'+esc(t.title)+'</div>').join('');
    document.querySelectorAll('.tab').forEach(t=>t.onclick=()=>show(t.dataset.id));
    show(m.tabs[0].id);}
  else if(m.type==='info')$('info').innerHTML=m.lines.map(l=>'<div>'+esc(l)+'</div>').join('');
  else if(m.type==='tab'){cache[m.id]=m;if(m.id==='data'&&m.content&&!m.error)dtrail=[{label:$('title').textContent,content:m.content}];if(m.id===cur)render();}
  else if(m.type==='all'){$('all').disabled=false;if(m.error){$('count').textContent=m.error;return;}
    if(dtrail.length)dtrail[dtrail.length-1].content=m.content;cache.data={content:m.content};if(cur==='data')render();}
  else if(m.type==='follow'){if(m.error){$('count').textContent=m.error;return;}
    dtrail.push({label:m.label,content:m.content});cache.data={content:m.content};sortCol=-1;filter='';$('filter').value='';if(cur==='data')render();}
});
vs.postMessage({cmd:'ready'});
</script></body></html>`;
}
