import * as vscode from 'vscode';
import { parseRefList, maskText, RefInfo } from './completion';
import { t } from './i18n';

export interface GNode {
  id: string;
  label: string;
  sub?: string;
  kind: 'focus' | 'view' | 'plsql' | 'table' | 'subquery' | 'cte' | 'proc' | 'func' | 'external' | 'system' | 'root';
}
export interface GEdge {
  from: string;
  to: string;
  label?: string;
  dashed?: boolean;
  arrow?: boolean;
}
export interface Graph {
  title: string;
  nodes: GNode[];
  edges: GEdge[];
  note?: string;
}

const q = (s: string) => s.replace(/"/g, '');

// ------------------------------------------------------------------------------------------ requête

/** Schéma d'une requête : tables / sous-requêtes / CTE du niveau principal, conditions de jointure, sous-requêtes imbriquées. */
export function buildQueryGraph(sql: string): Graph {
  const nodes: GNode[] = [];
  const edges: GEdge[] = [];
  const masked = maskText(sql);
  const top = parseRefList(sql, sql.length);
  const used = new Set<string>();
  const uid = (base: string) => {
    let id = base.toLowerCase();
    for (let i = 2; used.has(id); i++) id = base.toLowerCase() + '#' + i;
    used.add(id);
    return id;
  };

  const joinKind = (table: string, alias: string): string => {
    const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const tb = esc(table.split('.').pop()!);
    const re = new RegExp(`(?:\\b(left|right|full)\\s+(?:outer\\s+)?|\\b(inner|cross|natural)\\s+)?\\bjoin\\s+(?:[\\w$#"]+\\.)?"?${tb}"?(?:\\s+(?:as\\s+)?"?${esc(alias)}"?)?(?=\\s|$|\\()`, 'i');
    const m = re.exec(masked);
    if (!m) return t('implicit join');
    return ((m[1] ?? m[2] ?? '') + ' JOIN').trim().toUpperCase();
  };

  const add = (r: RefInfo, depth: number, parent?: string, first = false): string => {
    const id = uid(r.alias || r.table);
    if (r.virtual) {
      const cteLike = !r.aliased;
      nodes.push({ id, label: r.alias, sub: t('subquery') + (r.virtual.cols.length ? ` · ${r.virtual.cols.length} ${t('col.')}` : ''), kind: cteLike ? 'cte' : 'subquery' });
      if (depth < 3) {
        let prev: string | undefined;
        for (const c of r.virtual.inner.filter((x) => x.alias)) {
          const cid = add(c, depth + 1, id);
          edges.push({ from: cid, to: id, dashed: true, arrow: true });
          prev = cid;
        }
        void prev;
      }
    } else {
      nodes.push({ id, label: q(r.table.split('.').pop()!), sub: (r.aliased ? q(r.alias) + ' · ' : '') + (parent ? '' : first ? 'FROM' : joinKind(r.table, r.alias)), kind: 'table' });
    }
    return id;
  };

  const ids = new Map<string, string>(); // alias minuscule → id
  const roots: string[] = [];
  top.forEach((r, i) => {
    const id = add(r, 0, undefined, i === 0);
    ids.set(r.alias.toLowerCase(), id);
    ids.set(q(r.table.split('.').pop()!).toLowerCase(), ids.get(q(r.table.split('.').pop()!).toLowerCase()) ?? id);
    roots.push(id);
  });

  // conditions de jointure (ANSI ON / WHERE à l'ancienne) : « a.x = b.y », y compris avec fonctions (upper(a.x) = upper(b.y)) et le (+) d'Oracle
  const refRe = /("?[\w$#]+"?)\s*\.\s*("?[\w$#]+"?)\s*(\(\+\))?/g;
  const pairs = new Map<string, { a: string; b: string; conds: string[]; outer?: string }>();
  const optional = new Set<string>(); // tables du côté (+) : jointure externe Oracle
  for (const seg of masked.split(/\b(?:and|or|where|on|having|when|then|else|join|left|right|full|inner|cross|natural|group|order|union|connect|start|from|select|minus|intersect)\b/i)) {
    const eq = /[^<>!:=]=(?!=)/.exec(seg);
    if (!eq) continue;
    const side = (part: string) => {
      const refs = [...part.matchAll(refRe)].map((r) => ({ id: ids.get(q(r[1]).toLowerCase()), plus: !!r[3] }));
      const known = refs.filter((r) => r.id);
      const set = new Set(known.map((r) => r.id));
      return known.length && set.size === 1 && known.length === refs.length ? { id: known[0].id!, plus: /\(\+\)/.test(part) } : undefined;
    };
    const l = side(seg.slice(0, eq.index + 1));
    const r = side(seg.slice(eq.index + 2));
    if (!l || !r || l.id === r.id) continue;
    if (l.plus) optional.add(l.id);
    if (r.plus) optional.add(r.id);
    const key = [l.id, r.id].sort().join('|');
    const cond = seg.replace(/\s+/g, ' ').trim();
    const p = pairs.get(key) ?? { a: l.id, b: r.id, conds: [] };
    if (cond && !p.conds.includes(cond)) p.conds.push(cond.length > 70 ? cond.slice(0, 69) + '…' : cond);
    if (l.plus || r.plus) p.outer = l.plus ? l.id : r.id;
    pairs.set(key, p);
  }
  for (const p of pairs.values()) {
    const label = (p.outer ? t('OUTER JOIN (+)') + '\n' : '') + p.conds.join('\n');
    // la flèche va de la table « préservée » vers la table optionnelle (côté (+))
    const from = p.outer === p.a ? p.b : p.a;
    const to = p.outer === p.a ? p.a : p.b;
    edges.push({ from, to, label, arrow: !!p.outer, dashed: !!p.outer });
  }
  for (const n of nodes) if (optional.has(n.id) && n.kind === 'table') n.sub = (n.sub ?? '').replace(/(FROM|implicit join)$/, '').replace(/ · $/, '') + (n.sub && !/ · $/.test(n.sub) && !/^$/.test(n.sub.replace(/(FROM|implicit join)$/, '')) ? ' · ' : '') + 'OUTER (+)';

  const linked = new Set(edges.flatMap((e) => [e.from, e.to]));
  const lonely = roots.filter((r) => !linked.has(r));
  const title = t('Query graph');
  const note = roots.length > 1 && lonely.length ? t('Not linked by any condition (cartesian product?): {0}', lonely.map((id) => nodes.find((n) => n.id === id)!.label).join(', ')) : undefined;
  return { title, nodes, edges, note };
}

// ------------------------------------------------------------------------------------------ PL/SQL

const SYSTEM_PREFIX = /^(dbms_|utl_|sys\.|apex_|owa_|htp$|htf$|sdo_|ctx_|standard$|json_|xmltype)/i;
const COLLECTION_METHODS = /^(count|exists|extend|first|last|next|prior|delete|trim|limit)$/i;
const KEYWORDS = new Set(['if', 'elsif', 'while', 'for', 'loop', 'case', 'when', 'in', 'not', 'and', 'or', 'return', 'select', 'insert', 'update', 'delete', 'values', 'into', 'from', 'where', 'cursor', 'is', 'as', 'begin', 'end', 'then', 'else', 'exception', 'raise', 'open', 'fetch', 'close', 'exit', 'exists', 'nvl', 'to_char', 'to_date', 'to_number', 'substr', 'instr', 'length', 'trim', 'upper', 'lower', 'decode', 'coalesce', 'count', 'sum', 'min', 'max', 'avg', 'sysdate', 'replace', 'round', 'trunc', 'lpad', 'rpad']);

/** Graphe des appels d'un package (corps), d'une procédure ou d'une fonction : appels internes + appels vers d'autres objets. */
export function buildCallGraph(source: string, name: string): Graph {
  const split = /create\s+(?:or\s+replace\s+)?(?:(?:non)?editionable\s+)?package\s+body\b/i.exec(source);
  const spec = split ? source.slice(0, split.index) : /\bpackage\b/i.test(source) && !/package\s+body/i.test(source) ? source : '';
  const body = split ? source.slice(split.index) : spec ? '' : source;
  const isPackage = !!split || !!spec;
  const nodes: GNode[] = [];
  const edges: GEdge[] = [];
  const have = new Set<string>();
  const addNode = (n: GNode) => {
    if (!have.has(n.id)) {
      have.add(n.id);
      nodes.push(n);
    }
  };
  const pkg = q(name).toLowerCase();

  // sous-programmes déclarés dans la spécification (publics)
  const publics = new Set<string>();
  for (const m of maskText(spec).matchAll(/\b(?:procedure|function)\s+("?[\w$#]+"?)/gi)) publics.add(q(m[1]).toLowerCase());

  const text = maskText(body);
  type Def = { name: string; kind: 'proc' | 'func'; start: number; headerEnd: number };
  const defs: Def[] = [];
  if (isPackage) {
    for (const m of text.matchAll(/\b(procedure|function)\s+("?[\w$#]+"?)/gi)) {
      // un sous-programme défini a un corps (IS / AS) ; on ignore les déclarations anticipées « …; »
      const rest = text.slice(m.index! + m[0].length);
      const head = /^[^;]*?\b(is|as)\b/i.exec(rest);
      const semi = rest.indexOf(';');
      if (!head || (semi >= 0 && semi < head[0].length - 2 && !/\(/.test(rest.slice(0, semi + 1)) && semi < rest.search(/\b(is|as)\b/i))) continue;
      defs.push({ name: q(m[2]), kind: m[1].toLowerCase() === 'function' ? 'func' : 'proc', start: m.index!, headerEnd: m.index! + m[0].length + head[0].length });
    }
  } else {
    const k = /\b(procedure|function)\b/i.exec(text);
    defs.push({ name: q(name), kind: k && k[1].toLowerCase() === 'function' ? 'func' : 'proc', start: 0, headerEnd: k ? k.index + k[0].length : 0 });
  }
  const seen = new Set<string>();
  const uniq = defs.filter((d) => (seen.has(d.name.toLowerCase()) ? false : (seen.add(d.name.toLowerCase()), true)));
  for (const d of uniq) addNode({ id: d.name.toLowerCase(), label: d.name, sub: isPackage ? (publics.has(d.name.toLowerCase()) ? t('public') : t('private')) : undefined, kind: d.kind });

  const own = new RegExp(`(?<![\\w$#.])${pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\.\\s*`, 'gi');
  const externals = new Map<string, number>();
  defs.forEach((d, i) => {
    const end = i + 1 < defs.length ? defs[i + 1].start : text.length;
    const seg = text.slice(d.headerEnd, end).replace(own, '');
    const from = d.name.toLowerCase();
    // appels internes
    for (const o of uniq) {
      const to = o.name.toLowerCase();
      if (to === from) continue;
      const rx = new RegExp(`(?<![\\w$#.])"?${o.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"?(?=\\s*[(;]|\\s+(?:then|loop|and|or)\\b)`, 'gi');
      const n = [...seg.matchAll(rx)].length;
      if (n) edges.push({ from, to, label: n > 1 ? `×${n}` : undefined, arrow: true });
    }
    // appels vers d'autres objets : pkg.proc(
    for (const m of seg.matchAll(/(?<![\w$#.])("?[a-z][\w$#]*"?)\s*\.\s*("?[a-z][\w$#]*"?)\s*\(/gi)) {
      const a = q(m[1]);
      const b = q(m[2]);
      if (COLLECTION_METHODS.test(b) || KEYWORDS.has(a.toLowerCase())) continue;
      const label = `${a}.${b}`;
      const id = label.toLowerCase();
      const sys = SYSTEM_PREFIX.test(label);
      addNode({ id, label, kind: sys ? 'system' : 'external' });
      externals.set(from + '>' + id, (externals.get(from + '>' + id) ?? 0) + 1);
    }
  });
  for (const [k, n] of externals) {
    const [from, to] = k.split('>');
    edges.push({ from, to, label: n > 1 ? `×${n}` : undefined, arrow: true, dashed: true });
  }
  const note = !uniq.length
    ? t('No subprogram found in the source (is the package body accessible?).')
    : !isPackage
      ? t('Only calls to other objects (schema.object or package.procedure) are detected in a standalone routine.')
      : !body
        ? t('Package body not available: only the specification was read.')
        : undefined;
  return { title: t('Call graph — {0}', name), nodes, edges, note };
}

// ------------------------------------------------------------------------------------------ affichage

let panel: vscode.WebviewPanel | undefined;
let current: Graph | undefined;

export function toMermaid(g: Graph): string {
  const id = (s: string) => 'n' + [...g.nodes].findIndex((n) => n.id === s);
  const lines = ['graph LR'];
  for (const n of g.nodes) lines.push(`  ${id(n.id)}["${n.label.replace(/"/g, "'")}${n.sub ? '<br/>' + n.sub.replace(/"/g, "'") : ''}"]`);
  for (const e of g.edges) {
    const lbl = e.label ? e.label.replace(/\n/g, ' AND ').replace(/"/g, "'") : '';
    const a = id(e.from);
    const b = id(e.to);
    if (e.dashed) lines.push(`  ${a} -. ${lbl ? '"' + lbl + '" ' : ''}.-> ${b}`.replace('-. .->', '-.-> '));
    else if (e.arrow) lines.push(`  ${a} -- ${lbl ? '"' + lbl + '" ' : ''}--> ${b}`.replace('-- -->', '-->'));
    else lines.push(`  ${a} -- ${lbl ? '"' + lbl + '" ' : ''}--- ${b}`.replace('-- ---', '---'));
  }
  return lines.join('\n');
}

export function showGraph(g: Graph) {
  current = g;
  if (!panel) {
    panel = vscode.window.createWebviewPanel('dbexplorer.graph', g.title, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false }, { enableScripts: true });
    panel.onDidDispose(() => (panel = undefined));
    panel.webview.onDidReceiveMessage((m: { cmd: string }) => {
      if (m.cmd === 'mermaid' && current) {
        void vscode.env.clipboard.writeText(toMermaid(current));
        void vscode.window.showInformationMessage(t('Mermaid diagram copied to the clipboard.'));
      }
    });
  } else panel.reveal(undefined, false);
  panel.title = g.title;
  panel.webview.html = html(g);
}

const KIND_LABEL = () => ({ view: t('View'), plsql: t('PL/SQL object'), focus: t('Selected table'), table: t('Table'), subquery: t('Subquery'), cte: t('CTE'), proc: t('Procedure'), func: t('Function'), external: t('Other object'), system: t('System package'), root: '' });

function html(g: Graph): string {
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const data = JSON.stringify({ g, kinds: KIND_LABEL() }).replace(/</g, '\\u003c');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body{margin:0;font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-editor-background)}
#top{display:flex;gap:12px;align-items:center;padding:8px 12px;border-bottom:1px solid var(--vscode-panel-border);flex-wrap:wrap}
#top h3{margin:0;font-size:13px}
button{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:0;padding:3px 10px;border-radius:3px;cursor:pointer}
#note{padding:6px 12px;font-size:12px;opacity:.85}
#legend{display:flex;gap:12px;font-size:11px;opacity:.85;flex-wrap:wrap}
#legend span:before{content:'';display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px;background:var(--c);vertical-align:-1px}
#wrap{overflow:auto;height:calc(100vh - 80px);padding:12px}
svg text{fill:var(--vscode-foreground);font-size:12px}
.sub{font-size:10px;opacity:.7}
.node rect{stroke-width:1.5}
.k-table{--c:#4f9de0}.k-subquery{--c:#b07fd0}.k-cte{--c:#7fb069}.k-proc{--c:#4f9de0}.k-func{--c:#e0a458}.k-external{--c:#8a8a8a}.k-system{--c:#555}.k-root{--c:#888}.k-focus{--c:#e0a458}.k-view{--c:#b07fd0}.k-plsql{--c:#3fb6a8}
.node rect{fill:color-mix(in srgb,var(--c) 14%,var(--vscode-editor-background));stroke:var(--c)}
.edge{fill:none;stroke:var(--vscode-foreground);opacity:.55;stroke-width:1.4}.edge.d{stroke-dasharray:5 4}
.elabel{font-size:10px}.elabg{fill:var(--vscode-editor-background);opacity:.9}
</style></head><body>
<div id="top"><h3 id="ttl"></h3><div id="legend"></div><button id="mm">Mermaid</button></div>
<div id="note"></div>
<div id="wrap"><svg id="svg" xmlns="http://www.w3.org/2000/svg"></svg></div>
<script nonce="${nonce}">
const vs=acquireVsCodeApi();const D=${data};const g=D.g;
document.getElementById('ttl').textContent=g.title;
document.getElementById('note').textContent=g.note||'';
const kinds=[...new Set(g.nodes.map(n=>n.kind))];
document.getElementById('legend').innerHTML=kinds.map(k=>'<span class="k-'+k+'" style="--c:var(--c)">'+(D.kinds[k]||k)+'</span>').join('');
document.getElementById('mm').onclick=()=>vs.postMessage({cmd:'mermaid'});
const W=190,H=46,GX=90,GY=26;
const idx=new Map(g.nodes.map((n,i)=>[n.id,i]));
const lvl=g.nodes.map(()=>0);
const es=g.edges.filter(e=>idx.has(e.from)&&idx.has(e.to)&&e.from!==e.to);
for(let p=0;p<g.nodes.length+1;p++){let ch=false;for(const e of es){const a=idx.get(e.from),b=idx.get(e.to);if(lvl[b]<lvl[a]+1&&lvl[a]+1<g.nodes.length){lvl[b]=lvl[a]+1;ch=true;}}if(!ch)break;}
const cols=[];g.nodes.forEach((n,i)=>{(cols[lvl[i]]=cols[lvl[i]]||[]).push(i);});
const pos=[];let maxRows=0;cols.forEach(c=>{if(c)maxRows=Math.max(maxRows,c.length);});
cols.forEach((c,x)=>{if(!c)return;c.forEach((i,r)=>{const off=(maxRows-c.length)*(H+GY)/2;pos[i]={x:20+x*(W+GX),y:20+off+r*(H+GY)};});});
const width=20+cols.length*(W+GX),height=40+maxRows*(H+GY);
const svg=document.getElementById('svg');svg.setAttribute('width',width);svg.setAttribute('height',height);
const esc=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
let out='<defs><marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="currentColor" style="fill:var(--vscode-foreground);opacity:.7"/></marker></defs>';
const pair=new Map();
for(const e of es){
  const a=pos[idx.get(e.from)],b=pos[idx.get(e.to)];
  const key=[e.from,e.to].sort().join('|');const n=pair.get(key)||0;pair.set(key,n+1);
  const same=a.x===b.x;
  let x1,y1,x2,y2,d,lx,ly;
  if(same){x1=a.x+W;y1=a.y+H/2;x2=b.x+W;y2=b.y+H/2;const bow=40+n*14;d='M'+x1+' '+y1+' C'+(x1+bow)+' '+y1+' '+(x2+bow)+' '+y2+' '+x2+' '+y2;lx=x1+bow*.75;ly=(y1+y2)/2;}
  else{const fw=a.x<b.x;x1=fw?a.x+W:a.x;x2=fw?b.x:b.x+W;y1=a.y+H/2+n*6;y2=b.y+H/2+n*6;const mx=(x1+x2)/2;d='M'+x1+' '+y1+' C'+mx+' '+y1+' '+mx+' '+y2+' '+x2+' '+y2;lx=mx;ly=(y1+y2)/2;}
  out+='<path class="edge'+(e.dashed?' d':'')+'" d="'+d+'"'+(e.arrow?' marker-end="url(#ar)"':'')+'/>';
  if(e.label){const ls=String(e.label).split('\\n');const w=Math.max(...ls.map(s=>s.length))*5.6+8,h=ls.length*12+4;
    out+='<rect class="elabg" x="'+(lx-w/2)+'" y="'+(ly-h/2)+'" width="'+w+'" height="'+h+'" rx="3"/>';
    ls.forEach((s,i)=>{out+='<text class="elabel" text-anchor="middle" x="'+lx+'" y="'+(ly-h/2+11+i*12)+'">'+esc(s)+'</text>';});}
}
g.nodes.forEach((n,i)=>{const p=pos[i];
  out+='<g class="node k-'+n.kind+'"><rect x="'+p.x+'" y="'+p.y+'" width="'+W+'" height="'+H+'" rx="6"/><title>'+esc(n.label)+(n.sub?' — '+esc(n.sub):'')+'</title>'
   +'<text x="'+(p.x+10)+'" y="'+(p.y+(n.sub?19:28))+'">'+esc(n.label.length>26?n.label.slice(0,25)+'…':n.label)+'</text>'
   +(n.sub?'<text class="sub" x="'+(p.x+10)+'" y="'+(p.y+35)+'">'+esc(n.sub.length>34?n.sub.slice(0,33)+'…':n.sub)+'</text>':'')+'</g>';});
svg.innerHTML=out;
</script></body></html>`;
}
