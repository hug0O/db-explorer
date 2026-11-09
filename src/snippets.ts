import { t } from './i18n';
import { DbKind } from './drivers/types';

export interface SnippetDef {
  name: string;
  description?: string;
  /** Corps au format snippet VS Code (${1:défaut}, $0). */
  body: string;
  /** Moteurs concernés (tous si absent). */
  kinds?: DbKind[];
}

/** Modèles courants proposés par « Insérer un modèle de requête ». */
export function builtinSnippets(): SnippetDef[] {
  return [
    { name: 'SELECT', description: t('Select with a filter'), body: 'SELECT ${3:*}\n  FROM ${1:table} ${2:t}\n WHERE ${4:1 = 1};$0' },
    { name: 'JOIN', description: t('Two tables joined'), body: 'SELECT a.*, b.*\n  FROM ${1:table_a} a\n  JOIN ${2:table_b} b ON b.${3:a_id} = a.${4:id}\n WHERE ${5:1 = 1};$0' },
    { name: 'LEFT JOIN … IS NULL', description: t('Rows without a match in the other table'), body: 'SELECT a.*\n  FROM ${1:table_a} a\n  LEFT JOIN ${2:table_b} b ON b.${3:a_id} = a.${4:id}\n WHERE b.${3:a_id} IS NULL;$0' },
    { name: 'GROUP BY / HAVING', description: t('Count per value'), body: 'SELECT ${1:col}, COUNT(*) AS nb\n  FROM ${2:table}\n GROUP BY ${1:col}\nHAVING COUNT(*) > ${3:1}\n ORDER BY nb DESC;$0' },
    { name: 'Duplicates', description: t('Values present more than once'), body: 'SELECT ${1:col}, COUNT(*) AS nb\n  FROM ${2:table}\n GROUP BY ${1:col}\nHAVING COUNT(*) > 1;$0' },
    { name: 'INSERT', description: t('Insert a row'), body: 'INSERT INTO ${1:table} (${2:col1, col2})\nVALUES (${3:v1, v2});$0' },
    { name: 'INSERT … SELECT', description: t('Copy rows from a query'), body: 'INSERT INTO ${1:table} (${2:cols})\nSELECT ${3:cols}\n  FROM ${4:source}\n WHERE ${5:1 = 1};$0' },
    { name: 'UPDATE', description: t('Update with a condition'), body: 'UPDATE ${1:table}\n   SET ${2:col} = ${3:value}\n WHERE ${4:id = 0};$0' },
    { name: 'DELETE', description: t('Delete with a condition'), body: 'DELETE FROM ${1:table}\n WHERE ${2:id = 0};$0' },
    { name: 'MERGE', description: t('Upsert (Oracle)'), kinds: ['oracle'], body: 'MERGE INTO ${1:target} t\nUSING (SELECT ${2:cols} FROM ${3:source}) s\n   ON (t.${4:id} = s.${4:id})\n WHEN MATCHED THEN UPDATE SET t.${5:col} = s.${5:col}\n WHEN NOT MATCHED THEN INSERT (${6:cols}) VALUES (${7:s.cols});$0' },
    { name: 'UPSERT', description: t('Insert or update'), kinds: ['postgres', 'sqlite'], body: 'INSERT INTO ${1:table} (${2:id}, ${3:col})\nVALUES (${4:1}, ${5:v})\nON CONFLICT (${2:id}) DO UPDATE SET ${3:col} = EXCLUDED.${3:col};$0' },
    { name: 'UPSERT', description: t('Insert or update'), kinds: ['mysql'], body: 'INSERT INTO ${1:table} (${2:id}, ${3:col})\nVALUES (${4:1}, ${5:v})\nON DUPLICATE KEY UPDATE ${3:col} = VALUES(${3:col});$0' },
    { name: t('Top N'), description: t('First rows (Oracle 12c+)'), kinds: ['oracle'], body: 'SELECT *\n  FROM ${1:table}\n ORDER BY ${2:col} DESC\n FETCH FIRST ${3:10} ROWS ONLY;$0' },
    { name: t('Top N'), description: t('First rows'), kinds: ['mysql', 'postgres', 'sqlite'], body: 'SELECT *\n  FROM ${1:table}\n ORDER BY ${2:col} DESC\n LIMIT ${3:10};$0' },
    { name: 'CTE (WITH)', description: t('Common table expression'), body: 'WITH ${1:cte} AS (\n  SELECT ${2:*}\n    FROM ${3:table}\n)\nSELECT *\n  FROM ${1:cte};$0' },
    { name: 'ROW_NUMBER', description: t('Latest row per key'), body: 'SELECT *\n  FROM (SELECT t.*, ROW_NUMBER() OVER (PARTITION BY ${1:key} ORDER BY ${2:date_col} DESC) AS rn\n          FROM ${3:table} t)\n WHERE rn = 1;$0' },
    { name: 'CREATE TABLE', description: t('New table with a primary key'), body: 'CREATE TABLE ${1:table} (\n  id ${2:NUMBER} NOT NULL,\n  ${3:name} ${4:VARCHAR(100)},\n  CONSTRAINT pk_${1:table} PRIMARY KEY (id)\n);$0' },
    { name: 'CREATE INDEX', description: t('Index on columns'), body: 'CREATE INDEX ${1:idx_name} ON ${2:table} (${3:col});$0' },
    { name: 'ALTER TABLE ADD', description: t('Add a column'), body: 'ALTER TABLE ${1:table} ADD ${2:col} ${3:VARCHAR(100)};$0' },
    { name: t('Procedure'), description: t('PL/SQL procedure'), kinds: ['oracle'], body: 'CREATE OR REPLACE PROCEDURE ${1:proc} (${2:p_id IN NUMBER}) IS\nBEGIN\n  ${3:NULL};\nEND ${1:proc};\n/\n$0' },
    { name: t('Function'), description: t('PL/SQL function'), kinds: ['oracle'], body: 'CREATE OR REPLACE FUNCTION ${1:func} (${2:p_id IN NUMBER}) RETURN ${3:NUMBER} IS\n  v_res ${3:NUMBER};\nBEGIN\n  ${4:NULL};\n  RETURN v_res;\nEND ${1:func};\n/\n$0' },
    { name: t('Anonymous block'), description: t('PL/SQL block with exception handler'), kinds: ['oracle'], body: 'DECLARE\n  ${1:v_x NUMBER;}\nBEGIN\n  ${2:NULL};\nEXCEPTION\n  WHEN OTHERS THEN\n    DBMS_OUTPUT.PUT_LINE(SQLERRM);\n    RAISE;\nEND;\n/\n$0' },
    { name: t('Table size'), description: t('Rows count of a table'), body: 'SELECT COUNT(*) FROM ${1:table};$0' },
  ];
}
