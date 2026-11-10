import { split } from './splitter';
import { t } from './i18n';

export interface ScriptSection {
  /** Nature de l'élément (clé stable) : table, index, fk, constraint, trigger, synonym, grants, comments, view, other. */
  kind: string;
  title: string;
  sql: string;
}

const NAME = '((?:"[^"]+"|`[^`]+`|[\\w$#]+)(?:\\s*\\.\\s*(?:"[^"]+"|`[^`]+`|[\\w$#]+))?)';
const short = (n: string) => n.replace(/\s+/g, '').replace(/["`]/g, '').split('.').pop() ?? n;

/** Un élément du script (instruction) → sa nature et son titre. */
export function classify(stmt: string): { kind: string; title: string } {
  const s = stmt.replace(/^(?:\s*--[^\n]*\n|\s*\/\*[\s\S]*?\*\/)+/g, '').trim();
  let m: RegExpExecArray | null;
  if (/^create\s+(?:global\s+temporary\s+|private\s+temporary\s+|unlogged\s+|temporary\s+|temp\s+)?table\b/i.test(s)) return { kind: 'table', title: t('Table creation') };
  if ((m = new RegExp('^create\\s+(?:unique\\s+|bitmap\\s+|fulltext\\s+|spatial\\s+)?index\\s+(?:concurrently\\s+)?(?:if\\s+not\\s+exists\\s+)?' + NAME, 'i').exec(s))) return { kind: 'index', title: t('Index {0}', short(m[1])) };
  if ((m = new RegExp('^alter\\s+table\\b[\\s\\S]*?\\badd\\s+constraint\\s+' + NAME + '[\\s\\S]*?\\bforeign\\s+key', 'i').exec(s))) return { kind: 'fk', title: t('Foreign key {0}', short(m[1])) };
  if (/^alter\s+table\b[\s\S]*?\bforeign\s+key/i.test(s)) return { kind: 'fk', title: t('Foreign key') };
  if ((m = new RegExp('^alter\\s+table\\b[\\s\\S]*?\\badd\\s+constraint\\s+' + NAME, 'i').exec(s))) return { kind: 'constraint', title: t('Constraint {0}', short(m[1])) };
  if (/^comment\s+on\b/i.test(s)) return { kind: 'comments', title: t('Comments') };
  if ((m = new RegExp('^create\\s+(?:or\\s+replace\\s+)?(?:editionable\\s+|noneditionable\\s+)?(?:constraint\\s+)?trigger\\s+' + NAME, 'i').exec(s))) return { kind: 'trigger', title: t('Trigger {0}', short(m[1])) };
  if ((m = new RegExp('^create\\s+(?:or\\s+replace\\s+)?(?:public\\s+)?synonym\\s+' + NAME, 'i').exec(s))) return { kind: 'synonym', title: t('Synonym {0}', short(m[1])) };
  if (/^grant\b/i.test(s)) return { kind: 'grants', title: t('Grants') };
  if (/^create\s+(?:or\s+replace\s+)?(?:force\s+|noforce\s+)?(?:editionable\s+|noneditionable\s+)?materialized\s+view\b/i.test(s)) return { kind: 'view', title: t('Materialized view creation') };
  if (/^create\s+(?:or\s+replace\s+)?(?:force\s+|noforce\s+)?(?:editionable\s+|noneditionable\s+)?(?:temp(?:orary)?\s+)?(?:recursive\s+)?view\b/i.test(s)) return { kind: 'view', title: t('View creation') };
  if (/^create\s+(?:or\s+replace\s+)?(?:editionable\s+|noneditionable\s+)?(?:procedure|function|package|type)\b/i.test(s)) return { kind: 'code', title: t('Source') };
  if (/^create\s+sequence\b/i.test(s)) return { kind: 'sequence', title: t('Sequence creation') };
  if (/^alter\s+table\b/i.test(s)) return { kind: 'alter', title: t('Table options') };
  return { kind: 'other', title: t('Other statements') };
}

/**
 * Découpe un script de description d'objet en éléments distincts (création de la table, chaque index, chaque clé étrangère,
 * triggers, synonymes, droits, commentaires…). Les droits et commentaires sont regroupés en un seul bloc chacun.
 */
export function sectionsOf(script: string, dialect: 'oracle' | 'plain' | 'blocks'): ScriptSection[] {
  const text = script.trim().replace(/\n[ \t]*\n+/g, '\n'); // pas de ligne vide : elle terminerait une instruction
  if (!text) return [];
  const out: ScriptSection[] = [];
  for (const st of split(text, dialect)) {
    const sql = st.text.trim();
    if (!sql || /^\/$/.test(sql)) continue;
    const body = /[;/]\s*$/.test(sql) ? sql : sql + ';';
    const c = classify(sql);
    const last = out[out.length - 1];
    if ((c.kind === 'grants' || c.kind === 'comments') && last && last.kind === c.kind) last.sql += '\n' + body;
    else out.push({ kind: c.kind, title: c.title, sql: body });
  }
  // un seul bloc « Table » même si le script est une instruction non reconnue
  return out;
}
