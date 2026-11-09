/**
 * Mise en forme minimale d'une requête pour la comparer : mots-clés en majuscules, espaces normalisés,
 * un retour à la ligne avant chaque clause et après chaque virgule de premier niveau. Chaînes et commentaires sont préservés.
 */
export function prettySql(sql: string): string {
  const saved: string[] = [];
  let s = sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|"[^"]*"/g, (m) => {
    saved.push(m);
    return `\u0001${saved.length - 1}\u0001`;
  });
  s = s.replace(/\s+/g, ' ').trim().replace(/;\s*$/, '');
  const clauses = [
    'select', 'from', 'where', 'group by', 'order by', 'having', 'union all', 'union', 'minus', 'intersect', 'left outer join', 'right outer join', 'full outer join',
    'left join', 'right join', 'inner join', 'cross join', 'join', 'on', 'and', 'or', 'fetch first', 'connect by', 'start with', 'set', 'values',
  ];
  const words = [...clauses, 'as', 'in', 'is', 'not', 'null', 'exists', 'between', 'like', 'distinct', 'case', 'when', 'then', 'else', 'end', 'asc', 'desc', 'over', 'partition by', 'insert into', 'update', 'delete from', 'merge into', 'with'];
  const kw = new RegExp('\\b(' + words.map((k) => k.replace(/ /g, '\\s+')).join('|') + ')\\b', 'gi');
  s = s.replace(kw, (m) => m.toUpperCase().replace(/\s+/g, ' '));
  const cl = new RegExp(' (' + clauses.map((k) => k.toUpperCase().replace(/ /g, ' ')).join('|') + ') ', 'g');
  s = s.replace(cl, '\n$1 ');
  // virgules de premier niveau → retour à la ligne
  let out = '';
  let d = 0;
  for (const ch of s) {
    if (ch === '(') d++;
    if (ch === ')') d = Math.max(0, d - 1);
    out += ch === ',' && d === 0 ? ',\n    ' : ch;
  }
  return out.replace(/\n {4} +/g, '\n    ').replace(/\u0001(\d+)\u0001/g, (_m, i) => saved[+i]) + '\n';
}
