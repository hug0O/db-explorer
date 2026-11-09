import { DbConn, DbKind } from './drivers/types';
import { parseRefList } from './completion';
import { findBinds } from './splitter';
import { t } from './i18n';

export type Severity = 'high' | 'medium' | 'info';

export interface Finding {
  severity: Severity;
  title: string;
  detail: string;
  /** Suggestion de réécriture / de commande. */
  fix?: string;
}

export interface Report {
  kind: DbKind;
  sql: string;
  findings: Finding[];
  plan?: string;
  planError?: string;
  tips: string[];
}

const clean = (s: string) => s.replace(/--[^\n]*/g, ' ').replace(/\/\*(?!\+)[\s\S]*?\*\//g, ' ').replace(/'(?:[^']|'')*'/g, "''");
const RANK: Record<Severity, number> = { high: 0, medium: 1, info: 2 };

const DB_TIPS: Record<DbKind, () => string[]> = {
  oracle: () => [
    t('Compare the estimated and actual rows with DBMS_XPLAN.DISPLAY_CURSOR(NULL, NULL, \'ALLSTATS LAST\') after running the query with the hint /*+ GATHER_PLAN_STATISTICS */.'),
    t('Outdated statistics are the first cause of bad plans: DBMS_STATS.GATHER_TABLE_STATS(ownname => \'SCHEMA\', tabname => \'TABLE\').'),
    t('Use bind variables (:name) for values that change between executions: fewer hard parses, better shared-pool use.'),
    t('Since 12c, FETCH FIRST n ROWS ONLY replaces the ROWNUM / ORDER BY sub-query pattern.'),
  ],
  postgres: () => [
    t('Run EXPLAIN (ANALYZE, BUFFERS) to see actual times and buffer reads; keep the statement inside a transaction you roll back for DML.'),
    t('ANALYZE (or VACUUM ANALYZE) refreshes the planner statistics used to choose the plan.'),
    t('For LIKE / ILIKE with a leading wildcard, a pg_trgm GIN index can make the search indexable.'),
    t('Partial indexes (CREATE INDEX … WHERE …) keep indexes small when you only query a subset of rows.'),
  ],
  mysql: () => [
    t('EXPLAIN ANALYZE (MySQL 8.0.18+) shows the actual cost and row counts of each step.'),
    t('Watch "Using filesort" / "Using temporary" in the Extra column: a composite index matching WHERE + ORDER BY can remove them.'),
    t('ANALYZE TABLE refreshes index statistics; covering indexes avoid reading the table rows.'),
  ],
  sqlite: () => [
    t('EXPLAIN QUERY PLAN shows whether each table is SCANned (full) or SEARCHed (index).'),
    t('Run ANALYZE (or PRAGMA optimize) after loading data so the planner knows the data distribution.'),
    t('Composite indexes should list equality columns first, then the range / ORDER BY column.'),
  ],
};

/** Règles statiques : repèrent les constructions connues pour être lentes, par type de base. */
function staticRules(sqlText: string, kind: DbKind): Finding[] {
  const out: Finding[] = [];
  const src = clean(sqlText);
  const lc = src.toLowerCase();
  const first = /^\s*(\w+)/.exec(lc)?.[1] ?? '';
  const whereIdx = lc.search(/\bwhere\b/);
  const where = whereIdx >= 0 ? lc.slice(whereIdx) : '';
  const add = (severity: Severity, title: string, detail: string, fix?: string) => out.push({ severity, title, detail, fix });

  if ((first === 'update' || first === 'delete') && whereIdx < 0) {
    add('high', t('{0} without WHERE', first.toUpperCase()), t('Every row of the table will be modified. If that is intended, use TRUNCATE for a full delete; otherwise add a WHERE clause.'));
  }
  if (/\bselect\s+(?:distinct\s+|unique\s+|all\s+)?(?:[\w$#"]+\.)?\*/.test(lc) || /,\s*(?:[\w$#"]+\.)?\*\s*(?:,|from\b)/.test(lc)) {
    add('medium', t('SELECT * reads every column'), t('Fetching all columns increases I/O and network traffic and prevents index-only access. List only the columns you need.'));
  }
  // fonction appliquée à une colonne dans un prédicat : l'index de la colonne n'est plus utilisable
  const fnRe = /\b(upper|lower|trunc|to_char|to_date|to_number|substr|substring|instr|nvl|nvl2|coalesce|ifnull|trim|ltrim|rtrim|round|cast|length|lpad|rpad|replace|year|month|day|date|strftime|extract)\s*\(\s*(?:[a-z_][\w$#]*\.)?[a-z_][\w$#]*\s*(?:,[^()]*)?\)\s*(?:=|<>|!=|<=|>=|<|>|like\b|in\b|between\b)/gi;
  const fns = [...new Set([...where.matchAll(fnRe)].map((m) => m[1].toUpperCase()))];
  if (fns.length) {
    const fb = kind === 'oracle' || kind === 'postgres' ? t('or create a function-based index on the expression') : t('or store the computed value in an indexed column');
    add('medium', t('Function on a column in a predicate ({0})', fns.join(', ')), t('Applying a function to a column prevents the use of a normal index on it (full scan). Rewrite the predicate so the column stays alone on one side, {0}.', fb), t('e.g. TRUNC(d) = DATE \'2026-01-01\'  →  d >= DATE \'2026-01-01\' AND d < DATE \'2026-01-02\''));
  }
  if (/\blike\s+'%/.test(lc) || /\blike\s+('%|"%)/.test(lc)) {
    add('medium', t('LIKE with a leading wildcard'), kind === 'postgres' ? t("A pattern starting with % cannot use a B-tree index. Consider a pg_trgm GIN index, or search by prefix.") : t('A pattern starting with % cannot use a B-tree index and forces a scan. Search by prefix (LIKE \'abc%\') when possible.'));
  }
  if (/\bnot\s+in\s*\(\s*select\b/.test(lc)) {
    add('medium', t('NOT IN (sub-query)'), t('NOT IN returns no row if the sub-query yields a NULL and is often planned badly. NOT EXISTS is safer and usually faster.'), t('WHERE NOT EXISTS (SELECT 1 FROM … WHERE … = outer.col)'));
  } else if (/\bin\s*\(\s*select\b/.test(lc)) {
    add('info', t('IN (sub-query)'), t('Depending on the optimizer, EXISTS or a JOIN can be faster than IN (sub-query), especially when the sub-query returns many rows.'));
  }
  if (/\bunion\b(?!\s+all)/.test(lc)) {
    add('info', t('UNION removes duplicates'), t('UNION sorts / hashes the whole result to remove duplicates. Use UNION ALL when duplicates are impossible or acceptable.'));
  }
  if (/\bselect\s+distinct\b/.test(lc) && /\bjoin\b/.test(lc)) {
    add('info', t('DISTINCT over a join'), t('DISTINCT after a join often hides duplicated rows from a missing join condition and costs a sort. Check the join keys, or use EXISTS.'));
  }
  if (/\bcount\s*\(\s*(?:\*|1)\s*\)\s*(?:>\s*0|>=\s*1|=\s*0)/.test(lc)) {
    add('info', t('COUNT(*) used as an existence test'), t('Counting every row just to test existence is wasteful; EXISTS stops at the first match.'));
  }
  if (/\border\s+by\s+(?:rand\s*\(|random\s*\(|dbms_random)/.test(lc)) {
    add('high', t('ORDER BY random'), t('Sorting the whole table on a random value is expensive. Pick random keys with an indexed range or use a sampling clause (SAMPLE / TABLESAMPLE).'));
  }
  if (/\boffset\s+\d{4,}/.test(lc)) {
    add('medium', t('Large OFFSET'), t('The database still reads and discards all skipped rows. Use keyset pagination (WHERE key > last_value ORDER BY key LIMIT n).'));
  }
  if (/\bhaving\b/.test(lc) && !/\b(count|sum|avg|min|max)\s*\(/.test(lc.slice(lc.search(/\bhaving\b/)))) {
    add('info', t('HAVING without aggregate'), t('A condition that does not use an aggregate belongs in WHERE: it filters rows before grouping.'));
  }
  const scalar = (lc.slice(0, Math.max(0, lc.search(/\bfrom\b/))).match(/\(\s*select\b/g) ?? []).length;
  if (scalar) {
    add('info', t('Scalar sub-query in the select list'), t('A correlated scalar sub-query runs once per returned row. A JOIN (or an analytic function) is usually faster.'));
  }
  // jointures à l'ancienne : produit cartésien possible
  const refs = parseRefList(sqlText).filter((r) => !r.virtual);
  const selects = (lc.match(/\bselect\b/g) ?? []).length;
  if (refs.length > 1 && !/\bjoin\b/.test(lc) && selects === 1) {
    const linked = /\b[a-z_][\w$#]*\.[a-z_][\w$#]*\s*=\s*[a-z_][\w$#]*\.[a-z_][\w$#]*/.test(where);
    if (!linked) add('high', t('Possible Cartesian product'), t('Several tables are listed in FROM without a join condition between them: the result is every combination of rows.'));
    else add('info', t('Old-style join syntax'), t('Comma-separated tables with join conditions in WHERE are easy to get wrong. Prefer explicit JOIN … ON.'));
  }
  if (refs.length >= 6) add('info', t('{0} tables joined', refs.length), t('Many joins make plans fragile. Check that each join is selective and consider splitting the query or pre-aggregating.'));

  // littéraux dans les prédicats : plans / curseurs non réutilisés
  if (kind === 'oracle' || kind === 'postgres') {
    const lits = (sqlText.match(/(?:=|<|>|\bin\s*\(|\blike)\s*(?:'[^']*'|\d+)/gi) ?? []).length;
    if (lits >= 1 && findBinds(sqlText).length === 0) add('info', t('Literal values in predicates'), t('Each distinct literal creates a new statement to parse. Use bind variables (:name) for values that change between executions.'));
  }
  // spécifique à chaque base
  if (kind === 'oracle') {
    const rn = lc.search(/\brownum\b/);
    const ob = lc.search(/\border\s+by\b/);
    if (rn >= 0 && ob > rn) {
      add('medium', t('ROWNUM together with ORDER BY'), t('ROWNUM is applied before ORDER BY at the same level, so the "top N" is not the N first sorted rows. Sort in a sub-query then filter, or use FETCH FIRST n ROWS ONLY (12c+).'), t('SELECT … FROM tab ORDER BY col FETCH FIRST 10 ROWS ONLY'));
    }
    if (/\(\+\)/.test(lc)) add('info', t('Oracle (+) outer join syntax'), t('The (+) operator has restrictions (no OR / IN with another table). ANSI LEFT / RIGHT JOIN is clearer and fully supported.'));
    if (/\/\*\+/.test(sqlText)) add('info', t('Optimizer hint present'), t('Hints freeze a plan that may stop being optimal as data changes. Re-check them after statistics or data changes, and prefer fixing statistics / indexes.'));
    if (/\bfor\s+update\b(?!\s+(?:nowait|skip\s+locked|wait))/.test(lc)) add('info', t('FOR UPDATE without NOWAIT / SKIP LOCKED'), t('The session waits indefinitely on rows locked by others. Add NOWAIT, WAIT n or SKIP LOCKED according to what you need.'));
  } else if (kind === 'mysql') {
    if (/\bin\s*\(\s*select\b/.test(lc)) add('info', t('Sub-query on an older MySQL'), t('Before MySQL 5.6 IN (sub-query) was executed as a dependent sub-query per row; rewrite as a JOIN if the version is old.'));
    if (/\border\s+by\b/.test(lc) && !/\blimit\b/.test(lc) && /\bselect\s+\*/.test(lc)) add('info', t('ORDER BY without LIMIT'), t('Sorting a whole result with SELECT * can spill to disk. Add LIMIT or select fewer columns.'));
  } else if (kind === 'sqlite') {
    if (/\bnot\s+in\b/.test(lc)) add('info', t('NOT IN in SQLite'), t('NOT IN with a NULL in the list returns nothing; NOT EXISTS is safer.'));
  }
  return out;
}

const idOf = (s: string) => s.replace(/"|`/g, '').toLowerCase();

/** Colonnes filtrées / jointes sans index qui commence par elles (analyse des index réels). */
async function indexFindings(sqlText: string, conn: DbConn, schema: string): Promise<Finding[]> {
  const out: Finding[] = [];
  const refs = parseRefList(sqlText).filter((r) => !r.virtual);
  if (!refs.length) return out;
  const src = clean(sqlText);
  const lc = src.toLowerCase();
  const wi = lc.search(/\bwhere\b|\bon\b/);
  const text = wi >= 0 ? lc.slice(wi) : '';
  const byAlias = new Map(refs.map((r) => [r.alias.toLowerCase(), r]));
  const cols = new Map<string, { ref: (typeof refs)[number]; col: string; why: 'filter' | 'join' }>();
  const put = (ref: (typeof refs)[number] | undefined, col: string, why: 'filter' | 'join') => {
    if (ref && !/^\d/.test(col)) cols.set(`${ref.alias.toLowerCase()}.${col}`, { ref, col, why });
  };
  for (const m of text.matchAll(/\b([a-z_][\w$#]*)\.([a-z_][\w$#]*)\s*=\s*([a-z_][\w$#]*)\.([a-z_][\w$#]*)/g)) {
    put(byAlias.get(m[1]), m[2], 'join');
    put(byAlias.get(m[3]), m[4], 'join');
  }
  for (const m of text.matchAll(/(?:\b([a-z_][\w$#]*)\.)?\b([a-z_][\w$#]*)\s*(?:=|>=|<=|<>|!=|>|<)\s*(?:''|\d+|:[\w$#]+|\?)/g)) {
    const ref = m[1] ? byAlias.get(m[1]) : refs.length === 1 ? refs[0] : undefined;
    put(ref, m[2], 'filter');
  }
  for (const m of text.matchAll(/(?:\b([a-z_][\w$#]*)\.)?\b([a-z_][\w$#]*)\s+(?:not\s+)?(?:in\s*\(|between\b|like\s+'')/g)) {
    const ref = m[1] ? byAlias.get(m[1]) : refs.length === 1 ? refs[0] : undefined;
    put(ref, m[2], 'filter');
  }
  const pkCache = new Map<string, Set<string>>();
  const pkOf = async (ref: (typeof refs)[number]) => {
    const [o, tb] = ref.table.includes('.') ? ref.table.split('.') : [schema, ref.table];
    const k = (o + '.' + tb).toLowerCase();
    if (!pkCache.has(k)) pkCache.set(k, new Set((await conn.columns(o.replace(/"/g, ''), tb.replace(/"/g, '')).catch(() => [])).filter((c) => c.PK).map((c) => c.NAME.toLowerCase())));
    return pkCache.get(k)!;
  };
  const cache = new Map<string, Awaited<ReturnType<DbConn['indexes']>> | null>();
  const idx = async (ref: (typeof refs)[number]) => {
    const [o, tb] = ref.table.includes('.') ? ref.table.split('.') : [schema, ref.table];
    const k = (o + '.' + tb).toLowerCase();
    if (!cache.has(k)) cache.set(k, await conn.indexes(o.replace(/"/g, ''), tb.replace(/"/g, '')).catch(() => null));
    return cache.get(k);
  };
  for (const { ref, col, why } of cols.values()) {
    if (out.length >= 8) break;
    const list = await idx(ref);
    if (!list) continue;
    const lead = list.some((i) => idOf(i.cols.split(',')[0].trim()) === idOf(col)) || (await pkOf(ref)).has(idOf(col));
    if (lead) continue;
    const tb = ref.table.split('.').pop()!.replace(/"/g, '');
    const upper = (s: string) => (conn.kind === 'oracle' ? s.toUpperCase() : s);
    out.push({
      severity: why === 'join' ? 'high' : 'medium',
      title: t('No index starts with {0}.{1}', tb, col),
      detail: why === 'join'
        ? t('{0}.{1} is used in a join condition. Without an index, every row from the other table can trigger a scan of {0} (and, on Oracle, an unindexed foreign key also locks the parent table on delete).', tb, col)
        : t('{0}.{1} is used in a filter. Without an index starting with it, the database has to scan {0}.', tb, col),
      fix: `CREATE INDEX ${upper('idx_' + tb + '_' + col).slice(0, 30)} ON ${tb} (${upper(col)});`,
    });
  }
  return out;
}

/** Cherche les parcours complets et tris coûteux dans le plan d'exécution (texte natif de chaque SGBD). */
function planFindings(plan: string, kind: DbKind): Finding[] {
  const out: Finding[] = [];
  const full = (name: string) =>
    out.push({ severity: 'medium', title: t('Full table scan on {0}', name), detail: t('The plan reads every row of {0}. This is fine for small tables; for large ones add or fix an index on the filtered / joined columns.', name) });
  if (kind === 'oracle') {
    for (const m of plan.matchAll(/TABLE ACCESS FULL\s*\|\s*([\w$#.]+)/g)) full(m[1]);
    if (/MERGE JOIN CARTESIAN/.test(plan)) out.push({ severity: 'high', title: t('Cartesian join in the plan'), detail: t('MERGE JOIN CARTESIAN multiplies the rows of two row sources. Check for a missing join condition.') });
    if (/dynamic statistics used|dynamic sampling/i.test(plan)) out.push({ severity: 'info', title: t('Dynamic sampling used'), detail: t('The optimizer had no (or stale) statistics on a table and sampled it. Gather statistics with DBMS_STATS.') });
    if (/SORT ORDER BY|SORT GROUP BY|HASH GROUP BY/.test(plan)) out.push({ severity: 'info', title: t('Sort / aggregation step'), detail: t('Large sorts spill to temp space; an index that matches ORDER BY / GROUP BY can avoid them.') });
    const cost = /\|\s*0\s*\|\s*SELECT STATEMENT\s*\|[^|]*\|[^|]*\|[^|]*\|\s*(\d+)/.exec(plan)?.[1];
    if (cost) out.push({ severity: 'info', title: t('Estimated cost: {0}', cost), detail: t('Compare this cost before / after each change: lower is better (the absolute value only makes sense for the same query).') });
  } else if (kind === 'postgres') {
    for (const m of plan.matchAll(/Seq Scan on ("?[\w$.]+"?)/g)) full(m[1]);
    if (/Sort Method: external/.test(plan)) out.push({ severity: 'medium', title: t('Sort spilled to disk'), detail: t('Increase work_mem for this query or add an index matching the ORDER BY.') });
    if (/Nested Loop[\s\S]*Seq Scan/.test(plan)) out.push({ severity: 'info', title: t('Nested loop over a sequential scan'), detail: t('A nested loop whose inner side is a full scan is quadratic. Index the join column of the inner table.') });
  } else if (kind === 'mysql') {
    const lines = plan.split('\n');
    const head = (lines[0] ?? '').split(' | ').map((x) => x.trim().toLowerCase());
    const ti = head.indexOf('type');
    const tab = head.indexOf('table');
    const ex = head.indexOf('extra');
    for (const l of lines.slice(1)) {
      const cells = l.split(' | ');
      if (ti >= 0 && cells[ti]?.trim().toUpperCase() === 'ALL') full(cells[tab]?.trim() ?? '?');
      if (ex >= 0 && /Using filesort/.test(cells[ex] ?? '')) out.push({ severity: 'medium', title: t('Using filesort'), detail: t('MySQL sorts the rows itself. An index covering WHERE + ORDER BY removes the sort.') });
      if (ex >= 0 && /Using temporary/.test(cells[ex] ?? '')) out.push({ severity: 'medium', title: t('Using temporary'), detail: t('A temporary table is built (GROUP BY / DISTINCT / UNION). An index on the grouped columns can avoid it.') });
    }
  } else {
    for (const m of plan.matchAll(/^\s*(?:└─ )?SCAN (?:TABLE )?(\w+)(?! USING)/gm)) if (!/USING (?:COVERING )?INDEX/.test(m[0])) full(m[1]);
    if (/USE TEMP B-TREE/.test(plan)) out.push({ severity: 'info', title: t('Temporary B-tree'), detail: t('SQLite builds a temporary index for ORDER BY / GROUP BY / DISTINCT. An index on those columns avoids it.') });
  }
  // doublons
  const seen = new Set<string>();
  return out.filter((f) => (seen.has(f.title) ? false : (seen.add(f.title), true)));
}

/** Analyse complète : règles statiques + index réels + plan d'exécution. */
export async function analyzeQuery(sql: string, conn: DbConn): Promise<Report> {
  const findings = staticRules(sql, conn.kind);
  findings.push(...(await indexFindings(sql, conn, conn.currentSchema).catch(() => [])));
  let plan: string | undefined;
  let planError: string | undefined;
  const isDml = /^\s*(select|with|insert|update|delete|merge)\b/i.test(sql);
  if (isDml) {
    try {
      const binds: Record<string, unknown> = {};
      for (const n of findBinds(sql)) binds[n] = { __bind: true, dir: 'in', type: 'string', val: null };
      plan = await conn.explain(sql.replace(/;\s*$/, ''), binds);
      findings.push(...planFindings(plan, conn.kind));
    } catch (e) {
      planError = (e as Error).message;
    }
  }
  const seen = new Set<string>();
  const unique = findings.filter((f) => (seen.has(f.title) ? false : (seen.add(f.title), true)));
  unique.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
  return { kind: conn.kind, sql, findings: unique, plan, planError, tips: DB_TIPS[conn.kind]() };
}
