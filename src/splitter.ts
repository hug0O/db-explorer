/** Découpage de scripts SQL / PL/SQL façon SQL*Plus. */
export interface Stmt {
  text: string;
  start: number; // offset du premier caractère
  end: number; // offset de fin (exclu)
  isPlsql: boolean; // bloc (PL/SQL, trigger…) : terminé par "/" ou par END;
  isSqlplus: boolean; // commande SQL*Plus (SET, PROMPT, ...)
}

/** oracle : PL/SQL + SQL*Plus ; blocks : triggers/procédures avec BEGIN…END (SQLite, MySQL) ; plain : ';' simple. */
export type Dialect = 'oracle' | 'blocks' | 'plain';

const BLOCK_RE =
  /^(declare\b|begin\b|create\s+(or\s+replace\s+)?(and\s+(resolve|compile)\s+(java\s+)?)?(noneditionable\s+|editionable\s+)?(procedure|function|package|trigger|type|library)\b)/i;
const ANON_RE = /^(declare|begin)\b/i;
const SQLPLUS_RE = /^(set|prompt|pro|spool|whenever|exit|quit|define|undefine|column|col|rem|remark|show|accept|clear|var|variable|print|timing|exec|execute|@@?)\b/i;
const GENERIC_BLOCK_RE = /^create\s+(or\s+replace\s+)?(definer\s*=\s*\S+\s+)?(temp(orary)?\s+)?(trigger|procedure|function)\b/i;

const CLOSERS: Record<string, string> = { '[': ']', '(': ')', '{': '}', '<': '>' };

let blankLineSplit = true;
/** Comme dans Toad, une ligne vide termine une instruction qui n'a pas de « ; » (désactivable par réglage). */
export function setBlankLineSplit(v: boolean) {
  blankLineSplit = v;
}

export function split(text: string, dialect: Dialect = 'oracle'): Stmt[] {
  const out: Stmt[] = [];
  const n = text.length;
  let i = 0;
  let start = -1;
  let block = false;
  let anon = false;
  let sqlplus = false;
  let depth = 0; // profondeur de parenthèses (une ligne vide à l'intérieur ne coupe pas)
  let beginBlock = false; // bloc commençant par BEGIN : fin déterminée par l'équilibrage BEGIN/END
  let stack: string[] = [];
  let closing = false;
  let prevWord = '';

  const finish = (end: number) => {
    if (start < 0) return;
    const t = text.slice(start, end).replace(/\s+$/, '');
    if (t) out.push({ text: t, start, end: start + t.length, isPlsql: block, isSqlplus: sqlplus });
    start = -1;
    block = anon = sqlplus = beginBlock = closing = false;
    depth = 0;
    stack = [];
    prevWord = '';
  };

  const begin = (at: number) => {
    start = at;
    const head = text.slice(at, at + 200);
    if (dialect === 'oracle') {
      block = BLOCK_RE.test(head);
      anon = ANON_RE.test(head);
      sqlplus = !block && SQLPLUS_RE.test(head);
      beginBlock = /^begin\b/i.test(head);
    } else {
      block = dialect === 'blocks' && GENERIC_BLOCK_RE.test(head);
      anon = false;
      sqlplus = false;
    }
  };

  /** Équilibre BEGIN/END, IF/END IF, LOOP/END LOOP, CASE/END CASE d'un bloc PL/SQL. */
  const trackWord = (w: string, after: number) => {
    const nxt = (/^\s*([A-Za-z_][\w$#]*)/.exec(text.slice(after, after + 60))?.[1] ?? '').toLowerCase();
    if (w === 'begin') stack.push('b');
    else if (w === 'case') {
      if (prevWord !== 'end') stack.push('c');
    } else if (w === 'if') {
      if (prevWord !== 'end') stack.push('i');
    } else if (w === 'loop') {
      if (prevWord !== 'end') stack.push('l');
    } else if (w === 'end') {
      if (nxt === 'if' || nxt === 'loop' || nxt === 'case') stack.pop();
      else if (stack[stack.length - 1] === 'c') stack.pop();
      else {
        stack.pop();
        if (!stack.length) closing = true;
      }
    }
    prevWord = w;
  };

  const lineStartOf = (pos: number) => text.lastIndexOf('\n', pos - 1) + 1;

  while (i < n) {
    const c = text[i];
    const d = text[i + 1];

    if (c === '-' && d === '-') {
      const e = text.indexOf('\n', i);
      i = e < 0 ? n : e;
      continue;
    }
    if (c === '/' && d === '*') {
      const e = text.indexOf('*/', i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (c === '\n') {
      if (sqlplus) finish(i);
      else if (blankLineSplit && start >= 0 && !block && depth === 0 && /^[ \t]*\r?\n/.test(text.slice(i + 1))) finish(i);
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    // "/" seul sur sa ligne : terminateur
    if (c === '/') {
      const ls = lineStartOf(i);
      const le = text.indexOf('\n', i);
      const line = text.slice(ls, le < 0 ? n : le);
      if (/^\s*\/\s*$/.test(line)) {
        finish(ls);
        i = le < 0 ? n : le;
        continue;
      }
    }
    if (start < 0) begin(i);

    if (sqlplus) {
      i++;
      continue;
    }
    if (c === "'" || ((c === 'q' || c === 'Q') && d === "'" && dialect === 'oracle' && !/[\w$#]/.test(text[i - 1] ?? ' '))) {
      if (c === "'") {
        i++;
        while (i < n) {
          if (text[i] === "'") {
            if (text[i + 1] === "'") i += 2;
            else {
              i++;
              break;
            }
          } else i++;
        }
      } else {
        const open = text[i + 2];
        const close = CLOSERS[open] ?? open;
        const e = text.indexOf(close + "'", i + 3);
        i = e < 0 ? n : e + 2;
      }
      continue;
    }
    if (c === '"' || (c === '`' && dialect !== 'oracle')) {
      const e = text.indexOf(c, i + 1);
      i = e < 0 ? n : e + 1;
      continue;
    }
    if (c === '$' && dialect !== 'oracle') {
      const m = /^\$([A-Za-z_]\w*)?\$/.exec(text.slice(i, i + 64));
      if (m) {
        const e = text.indexOf(m[0], i + m[0].length);
        i = e < 0 ? n : e + m[0].length;
        continue;
      }
    }
    if (/[A-Za-z_]/.test(c) && !/[\w$#]/.test(text[i - 1] ?? ' ')) {
      // spécification de package suivie directement du corps (ou de toute autre unité PL/SQL) sans « / » : le CREATE en début de ligne, après un « ; », ouvre une nouvelle instruction
      if (
        dialect === 'oracle' && block && !beginBlock && start >= 0 && i > start && text.slice(i, i + 6).toLowerCase() === 'create' &&
        /^[ \t]*$/.test(text.slice(lineStartOf(i), i)) && BLOCK_RE.test(text.slice(i, i + 200)) &&
        /;\s*$/.test(text.slice(start, i).replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ''))
      ) {
        finish(i);
        begin(i);
      }
      let j = i + 1;
      while (j < n && /[\w$#]/.test(text[j])) j++;
      if (beginBlock) trackWord(text.slice(i, j).toLowerCase(), j);
      i = j;
      continue;
    }
    if (c === ';') {
      if (beginBlock && closing) {
        finish(i + 1);
        i++;
        continue;
      }
      if (!block) {
        finish(i);
      } else if (dialect === 'blocks') {
        const before = text.slice(start, i);
        if (!/\bbegin\b/i.test(before)) finish(i);
        else {
          const m = /\bend\s*([\w$#"]+)?\s*$/i.exec(before);
          if (m && !/^(if|loop|case|while|repeat)$/i.test(m[1] ?? '')) finish(i + 1);
        }
      } else if (anon) {
        // bloc anonyme : fin après "END;" suivi d'une ligne vide / fin de fichier
        const before = text.slice(start, i);
        const m = /\bend\s*([\w$#"]+)?\s*$/i.exec(before);
        if (m && !/^(if|loop|case)$/i.test(m[1] ?? '')) {
          const rest = text.slice(i + 1);
          if (/^[ \t]*(\r?\n[ \t]*(\r?\n|$)|$)/.test(rest)) finish(i + 1);
        }
      }
      i++;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    i++;
  }
  finish(n);
  return out;
}

/** Instruction sous le curseur. */
export function statementAt(stmts: Stmt[], offset: number): Stmt | undefined {
  let found: Stmt | undefined;
  for (const s of stmts) if (s.start <= offset) found = s;
  return found ?? stmts[0];
}

/** Nom des binds (:x) hors chaînes et commentaires. */
export function findBinds(sql: string): string[] {
  const stripped = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''");
  const names = new Set<string>();
  const re = /(?<![:\w$#]):([A-Za-z_][\w$#]*|\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped))) names.add(m[1]);
  return [...names];
}

/** Retire le ';' final d'une instruction SQL simple. */
export function cleanSql(text: string, isPlsql: boolean): string {
  let t = text.trim();
  if (!isPlsql) t = t.replace(/;+\s*$/, '');
  else t = t.replace(/\n\s*\/\s*$/, '');
  return t;
}
