import { t } from './i18n';

export interface ErrorInfo {
  /** Explication courte et action suggérée. */
  hint?: string;
  /** La connexion est perdue (réseau, session tuée…) : proposer de se reconnecter. */
  lost?: boolean;
  /** Identifiant inconnu cité par la base et ce qu'il désigne. */
  unknown?: { name: string; what: 'column' | 'table' };
}

const LOST = /ORA-0(?:3113|3114|3135|3136|1012|0028)|ORA-12(?:537|570|571)|NJS-(?:003|500|501|521)|DPI-1(?:010|080)|ECONNRESET|EPIPE|Connection terminated|server closed the connection|Connection lost|PROTOCOL_CONNECTION_LOST|ETIMEDOUT|Can't add new command when connection is in closed state/i;

const HINTS: [RegExp, () => string][] = [
  [/ORA-00904|column "[^"]+" does not exist|Unknown column|no such column/i, () => t('Unknown column: check the spelling and that the alias / table really has this column.')],
  [/ORA-00942|relation "[^"]+" does not exist|Table '[^']+' doesn't exist|no such table/i, () => t('Table or view not found: wrong name or schema, or no privilege on it (try SCHEMA.TABLE).')],
  [/ORA-00933/, () => t('SQL command not properly ended: look for a stray comma, a missing keyword or text after the end of the statement.')],
  [/ORA-00936/, () => t('Missing expression: a column or value is missing, often after SELECT, a comma or an operator.')],
  [/ORA-00923/, () => t('FROM keyword not found: a comma is missing in the SELECT list or an alias contains a space.')],
  [/ORA-00907/, () => t('Missing right parenthesis: count the parentheses (also happens with ORDER BY in a subquery).')],
  [/ORA-00905/, () => t('Missing keyword: a clause is incomplete (for example JOIN without ON, CASE without END).')],
  [/ORA-00918|ORA-00960|column reference is ambiguous/i, () => t('Ambiguous column: prefix it with the table alias.')],
  [/ORA-00979|ORA-00937|must appear in the GROUP BY|not a single-group group function/i, () => t('Every selected column that is not aggregated must appear in the GROUP BY.')],
  [/ORA-00001|duplicate key value|Duplicate entry|UNIQUE constraint failed/i, () => t('Unique constraint violated: a row with the same key already exists (use the duplicate detector or check the key).')],
  [/ORA-01400|null value in column|cannot be null|NOT NULL constraint failed/i, () => t('A NOT NULL column received no value: list it in the INSERT or give it a default.')],
  [/ORA-02291|violates foreign key constraint|a foreign key constraint fails.*(?:insert|update)|FOREIGN KEY constraint failed/i, () => t('Parent row not found: the referenced key does not exist in the parent table.')],
  [/ORA-02292|update or delete on table .* violates foreign key|Cannot delete or update a parent row/i, () => t('Child rows exist: delete or update the rows that reference this one first.')],
  [/ORA-01722|invalid input syntax for type (?:integer|numeric|bigint)|Incorrect (?:integer|decimal) value/i, () => t('Invalid number: a text value is compared to / converted into a number (check the columns types and the data).')],
  [/ORA-01843|ORA-01861|ORA-01830|ORA-01847|invalid input syntax for type (?:date|timestamp)|Incorrect (?:date|datetime) value/i, () => t('Invalid date: use TO_DATE(value, format) or the date format of the connection (setting dbexplorer.dateFormat).')],
  [/ORA-01427|ORA-01422|single-row subquery returns more than one row|more than one row returned by a subquery|Subquery returns more than 1 row|exact fetch returns more/i, () => t('The subquery / SELECT INTO returns several rows: add a condition, ROWNUM = 1 or an aggregate.')],
  [/ORA-01403/, () => t('No data found: the SELECT INTO returned no row (handle it with an EXCEPTION block).')],
  [/ORA-01017|password authentication failed|Access denied for user/i, () => t('Wrong user or password: edit the connection.')],
  [/ORA-28000|ORA-28001/, () => t('Account locked or password expired: ask your DBA to unlock / reset it.')],
  [/ORA-01031|permission denied|insufficient privileges|command denied/i, () => t('Insufficient privileges: ask for the right on this object (GRANT).')],
  [/ORA-00054|ORA-00060|deadlock detected|Lock wait timeout/i, () => t('Locked by another session (or deadlock): commit / rollback the other transaction, then retry.')],
  [/ORA-01555/, () => t('Snapshot too old: the query ran too long on changing data; retry or reduce the volume.')],
  [/ORA-01652|ORA-01653|ORA-01654|ORA-01658/, () => t('Out of space in the tablespace: contact your DBA.')],
  [/ORA-12154|ORA-12514|ORA-12541|ORA-12170|ORA-12543/, () => t('Cannot reach the database: check the TNS alias / host / port / service name, the network and the listener.')],
  [/PLS-00201|PLS-00302|must be declared/i, () => t('Identifier not declared: unknown variable / procedure, or missing EXECUTE privilege or package prefix.')],
  [/PLS-00103/, () => t('Syntax error in PL/SQL: look at the line indicated, often a missing ; or END, or a statement not closed by /.')],
  [/PLS-00306|PLS-00363/, () => t('Wrong number or types of arguments in the call.')],
  [/ORA-06512/, () => t('Stack trace line: the first ORA- error above is the real cause.')],
  [/ORA-04068|ORA-04061|ORA-04065/, () => t('Package state discarded after a recompilation: simply re-run.')],
  [/syntax error at or near|You have an error in your SQL syntax|near ".*": syntax error/i, () => t('Syntax error: look at the word indicated by the database and what precedes it.')],
  [/canceling statement due to statement timeout|Query execution was interrupted|ORA-01013/i, () => t('Execution interrupted (cancel or timeout).')],
];

const NAME_RE: [RegExp, 'column' | 'table'][] = [
  [/ORA-00904:\s*(?:"[^"]*"\.)*"([^"]+)"/, 'column'],
  [/column "([^"]+)" does not exist/i, 'column'],
  [/Unknown column '(?:[^'.]*\.)?([^']+)'/i, 'column'],
  [/no such column: (?:\w+\.)?(\w+)/i, 'column'],
  [/relation "(?:[^"]*\.)?([^"]+)" does not exist/i, 'table'],
  [/Table '(?:[^'.]*\.)?([^']+)' doesn't exist/i, 'table'],
  [/no such table: (?:\w+\.)?(\w+)/i, 'table'],
];

export function analyzeError(message: string): ErrorInfo {
  const info: ErrorInfo = {};
  if (LOST.test(message)) {
    info.lost = true;
    info.hint = t('The connection to the database was lost.');
  } else {
    const h = HINTS.find(([re]) => re.test(message));
    if (h) info.hint = h[1]();
  }
  for (const [re, what] of NAME_RE) {
    const m = re.exec(message);
    if (m) {
      info.unknown = { name: m[1], what };
      break;
    }
  }
  return info;
}

function distance(a: string, b: string): number {
  const d: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return d[b.length];
}

/** Nom le plus proche parmi les candidats (distance d'édition faible, ou préfixe), undefined si rien de plausible. */
export function closest(name: string, candidates: string[]): string | undefined {
  const n = name.toLowerCase();
  let best: string | undefined;
  let bestD = Infinity;
  for (const c of candidates) {
    const cl = c.toLowerCase();
    if (cl === n) continue;
    let d = distance(n, cl);
    if (cl.startsWith(n) || n.startsWith(cl)) d = Math.min(d, 1);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  const max = Math.max(1, Math.floor(n.length / 3));
  return best && bestD <= max ? best : undefined;
}
