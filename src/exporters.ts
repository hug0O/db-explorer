import * as fs from 'fs';
import { once } from 'events';
import { Zip, ZipDeflate, strToU8 } from 'fflate';

export type ExportFormat = 'xlsx' | 'csv' | 'tsv' | 'json' | 'html' | 'md' | 'sql' | 'sqlbind' | 'merge' | 'mergebind' | 'xml';

export interface FormatInfo {
  id: ExportFormat;
  label: string;
  ext: string;
}

export const FORMATS: FormatInfo[] = [
  { id: 'xlsx', label: 'Excel (.xlsx)', ext: 'xlsx' },
  { id: 'csv', label: 'CSV (.csv)', ext: 'csv' },
  { id: 'tsv', label: 'TSV (.tsv)', ext: 'tsv' },
  { id: 'json', label: 'JSON (.json)', ext: 'json' },
  { id: 'html', label: 'HTML (.html)', ext: 'html' },
  { id: 'md', label: 'Markdown (.md)', ext: 'md' },
  { id: 'sql', label: 'SQL INSERT (.sql)', ext: 'sql' },
  { id: 'sqlbind', label: 'SQL INSERT — bind variables (Oracle PL/SQL, .sql)', ext: 'sql' },
  { id: 'merge', label: 'SQL MERGE (Oracle, .sql)', ext: 'sql' },
  { id: 'mergebind', label: 'SQL MERGE — bind variables (Oracle PL/SQL, .sql)', ext: 'sql' },
  { id: 'xml', label: 'XML (.xml)', ext: 'xml' },
];

export interface ExportOptions {
  csvSeparator: string;
  tableName: string;
  /** Colonnes de la clause ON d'un MERGE. */
  keyColumns: string[];
  /** Dates en TO_DATE / TO_TIMESTAMP (Oracle). */
  oracle: boolean;
}

export interface ExportWriter {
  begin(columns: string[]): Promise<void>;
  rows(rows: unknown[][]): Promise<void>;
  end(): Promise<void>;
}

/** Écriture fichier avec gestion de la contre-pression. */
class Out {
  private s: fs.WriteStream;
  constructor(file: string) {
    this.s = fs.createWriteStream(file);
  }
  write(chunk: string | Uint8Array) {
    this.s.write(chunk);
  }
  async drain() {
    if (this.s.writableNeedDrain) await once(this.s, 'drain');
  }
  close(): Promise<void> {
    return new Promise((res, rej) => {
      this.s.once('error', rej);
      this.s.end(() => res());
    });
  }
}

const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// caractères interdits en XML 1.0
// eslint-disable-next-line no-control-regex
const xmlClean = (s: string) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '');

// ------------------------------------------------------------------------- texte

class Delimited implements ExportWriter {
  private out: Out;
  constructor(file: string, private readonly sep: string, private readonly tsv: boolean) {
    this.out = new Out(file);
  }
  private cell(v: unknown) {
    const s = str(v);
    if (this.tsv) return s.replace(/[\t\r\n]+/g, ' ');
    return s.includes(this.sep) || /["\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  async begin(cols: string[]) {
    if (!this.tsv) this.out.write('﻿');
    this.out.write(cols.map((c) => this.cell(c)).join(this.tsv ? '\t' : this.sep) + '\r\n');
  }
  async rows(rows: unknown[][]) {
    this.out.write(rows.map((r) => r.map((v) => this.cell(v)).join(this.tsv ? '\t' : this.sep)).join('\r\n') + '\r\n');
    await this.out.drain();
  }
  async end() {
    await this.out.close();
  }
}

class Json implements ExportWriter {
  private out: Out;
  private cols: string[] = [];
  private n = 0;
  constructor(file: string) {
    this.out = new Out(file);
  }
  async begin(cols: string[]) {
    this.cols = cols;
    this.out.write('[\n');
  }
  async rows(rows: unknown[][]) {
    this.out.write(rows.map((r) => (this.n++ ? ',\n' : '') + JSON.stringify(Object.fromEntries(this.cols.map((c, i) => [c, r[i] ?? null])))).join(''));
    await this.out.drain();
  }
  async end() {
    this.out.write('\n]\n');
    await this.out.close();
  }
}

class Html implements ExportWriter {
  private out: Out;
  constructor(file: string) {
    this.out = new Out(file);
  }
  async begin(cols: string[]) {
    this.out.write(
      '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Export</title><style>body{font-family:Segoe UI,Arial,sans-serif}table{border-collapse:collapse}th,td{border:1px solid #ccc;padding:3px 8px;font-size:13px}th{background:#f0f0f0;text-align:left}td.n{text-align:right}</style></head><body><table>\n<thead><tr>' +
        cols.map((c) => `<th>${esc(c)}</th>`).join('') +
        '</tr></thead><tbody>\n'
    );
  }
  async rows(rows: unknown[][]) {
    this.out.write(rows.map((r) => '<tr>' + r.map((v) => (v === null || v === undefined ? '<td></td>' : `<td${typeof v === 'number' ? ' class="n"' : ''}>${esc(String(v))}</td>`)).join('') + '</tr>').join('\n') + '\n');
    await this.out.drain();
  }
  async end() {
    this.out.write('</tbody></table></body></html>\n');
    await this.out.close();
  }
}

class Markdown implements ExportWriter {
  private out: Out;
  constructor(file: string) {
    this.out = new Out(file);
  }
  private cell(v: unknown) {
    return str(v).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
  }
  async begin(cols: string[]) {
    this.out.write('| ' + cols.map((c) => this.cell(c)).join(' | ') + ' |\n| ' + cols.map(() => '---').join(' | ') + ' |\n');
  }
  async rows(rows: unknown[][]) {
    this.out.write(rows.map((r) => '| ' + r.map((v) => this.cell(v)).join(' | ') + ' |').join('\n') + '\n');
    await this.out.drain();
  }
  async end() {
    await this.out.close();
  }
}

class SqlInsert implements ExportWriter {
  private out: Out;
  private head = '';
  constructor(file: string, private readonly table: string, private readonly oracle: boolean) {
    this.out = new Out(file);
  }
  async begin(cols: string[]) {
    const id = (c: string) => (/^[A-Za-z_][\w$#]*$/.test(c) ? c : '"' + c.replace(/"/g, '""') + '"');
    this.head = `INSERT INTO ${this.table} (${cols.map(id).join(', ')}) VALUES (`;
  }
  async rows(rows: unknown[][]) {
    this.out.write(rows.map((r) => this.head + r.map((v) => literal(v, this.oracle)).join(', ') + ');').join('\n') + '\n');
    await this.out.drain();
  }
  async end() {
    await this.out.close();
  }
}

class Xml implements ExportWriter {
  private out: Out;
  private tags: string[] = [];
  constructor(file: string) {
    this.out = new Out(file);
  }
  async begin(cols: string[]) {
    this.tags = cols.map((c, i) => c.replace(/[^\w.-]/g, '_').replace(/^([^A-Za-z_])/, '_$1') || 'COL' + i);
    this.out.write('<?xml version="1.0" encoding="UTF-8"?>\n<resultset>\n');
  }
  async rows(rows: unknown[][]) {
    this.out.write(
      rows
        .map((r) => '  <row>' + r.map((v, i) => (v === null || v === undefined ? `<${this.tags[i]}/>` : `<${this.tags[i]}>${esc(xmlClean(String(v)))}</${this.tags[i]}>`)).join('') + '</row>')
        .join('\n') + '\n'
    );
    await this.out.drain();
  }
  async end() {
    this.out.write('</resultset>\n');
    await this.out.close();
  }
}

// ------------------------------------------------------------------ INSERT / MERGE

const ID_RE = /^[A-Za-z_][\w$#]*$/;
const ident = (c: string) => (ID_RE.test(c) ? c : '"' + c.replace(/"/g, '""') + '"');
const DATE_LIT = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2})(\.\d+)?)?$/;

/** Valeur SQL littérale ; avec oracle=true les chaînes de date deviennent TO_DATE / TO_TIMESTAMP. */
export function literal(v: unknown, oracle: boolean): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  const s = String(v);
  if (oracle) {
    const d = DATE_LIT.exec(s);
    if (d) {
      const base = s.replace('T', ' ');
      if (d[7]) return `TO_TIMESTAMP('${base}', 'YYYY-MM-DD HH24:MI:SS.FF')`;
      return d[4] === undefined ? `TO_DATE('${s}', 'YYYY-MM-DD')` : `TO_DATE('${base}', 'YYYY-MM-DD HH24:MI:SS')`;
    }
  }
  return "'" + s.replace(/'/g, "''") + "'";
}

/** MERGE (upsert) : `src` = expressions source de chaque colonne (littéraux ou :n). */
function mergeSql(table: string, cols: string[], keys: string[], src: string[]): string {
  const id = cols.map(ident);
  const on = keys.map((k) => `t.${ident(k)} = s.${ident(k)}`).join(' AND ');
  const upd = cols.filter((c) => !keys.includes(c)).map((c) => `t.${ident(c)} = s.${ident(c)}`);
  return (
    `MERGE INTO ${table} t USING (SELECT ${src.map((e, i) => `${e} AS ${id[i]}`).join(', ')} FROM dual) s ON (${on})` +
    (upd.length ? ` WHEN MATCHED THEN UPDATE SET ${upd.join(', ')}` : '') +
    ` WHEN NOT MATCHED THEN INSERT (${id.join(', ')}) VALUES (${id.map((c) => 's.' + c).join(', ')})`
  );
}

/** MERGE avec valeurs littérales, une instruction par ligne. */
class SqlMerge implements ExportWriter {
  private out: Out;
  private cols: string[] = [];
  constructor(file: string, private readonly table: string, private readonly keys: string[], private readonly oracle: boolean) {
    this.out = new Out(file);
  }
  async begin(cols: string[]) {
    this.cols = cols;
  }
  async rows(rows: unknown[][]) {
    this.out.write(rows.map((r) => mergeSql(this.table, this.cols, this.keys, r.map((v) => literal(v, this.oracle))).replace(/ (USING|ON|WHEN) /g, '\n  $1 ') + ';').join('\n\n') + '\n\n');
    await this.out.drain();
  }
  async end() {
    await this.out.close();
  }
}

/**
 * INSERT / MERGE avec variables de liaison : un bloc PL/SQL par lot de lignes, chaque ligne exécutée par
 * EXECUTE IMMEDIATE '… :1, :2 …' USING valeurs — une seule instruction analysée par le serveur, valeurs passées en binds.
 */
class SqlBindBlocks implements ExportWriter {
  private out: Out;
  private cols: string[] = [];
  private stmt = '';
  constructor(file: string, private readonly kind: 'insert' | 'merge', private readonly table: string, private readonly keys: string[], private readonly oracle: boolean) {
    this.out = new Out(file);
  }
  async begin(cols: string[]) {
    this.cols = cols;
    const ph = cols.map((_, i) => ':' + (i + 1));
    this.stmt = this.kind === 'insert' ? `INSERT INTO ${this.table} (${cols.map(ident).join(', ')}) VALUES (${ph.join(', ')})` : mergeSql(this.table, cols, this.keys, ph);
    this.out.write(`-- ${this.kind.toUpperCase()} with bind variables for ${this.table} (${cols.length} columns) — generated by DB Explorer\n`);
  }
  async rows(rows: unknown[][]) {
    const sql = this.stmt.replace(/'/g, "''");
    // NULL n'est pas permis dans USING : TO_CHAR(NULL) convient à toutes les colonnes
    const val = (v: unknown) => (v === null || v === undefined ? 'TO_CHAR(NULL)' : literal(v, this.oracle));
    for (let i = 0; i < rows.length; i += 100) {
      const chunk = rows.slice(i, i + 100);
      this.out.write("BEGIN\n" + chunk.map((r) => `  EXECUTE IMMEDIATE '${sql}' USING ${r.map(val).join(', ')};`).join('\n') + '\nEND;\n/\n');
    }
    await this.out.drain();
  }
  async end() {
    await this.out.close();
  }
}

// ------------------------------------------------------------------------- Excel

const colName = (i: number) => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};
const MAX_ROWS = 1_048_576;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?)?$/;

/** Classeur .xlsx écrit en flux (pas de limite mémoire), sans dépendance lourde : en-têtes en gras, volet figé, filtre auto, dates et nombres typés. */
class Xlsx implements ExportWriter {
  private out: Out;
  private zip: Zip;
  private entry?: ZipDeflate;
  private buf = '';
  private cols: string[] = [];
  private sheet = 0;
  private rowNo = 0;
  private failed?: Error;

  constructor(file: string) {
    this.out = new Out(file);
    this.zip = new Zip((err, chunk) => {
      if (err) this.failed = err;
      else this.out.write(chunk);
    });
  }

  private put(s: string, final = false) {
    this.buf += s;
    if (this.buf.length > 65536 || final) {
      this.entry!.push(strToU8(this.buf), final);
      this.buf = '';
    }
  }

  private cell(r: number, c: number, v: unknown, style = 0): string {
    const ref = colName(c) + r;
    if (v === null || v === undefined || v === '') return '';
    if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`;
    const s = String(v);
    const d = DATE_RE.exec(s);
    if (d && style === 0) {
      const serial = Date.UTC(+d[1], +d[2] - 1, +d[3], +(d[4] ?? 0), +(d[5] ?? 0), +(d[6] ?? 0)) / 86400000 + 25569;
      return `<c r="${ref}" s="2"><v>${serial}</v></c>`;
    }
    return `<c r="${ref}"${style ? ` s="${style}"` : ''} t="inlineStr"><is><t xml:space="preserve">${esc(xmlClean(s))}</t></is></c>`;
  }

  private openSheet() {
    this.sheet++;
    this.rowNo = 0;
    this.entry = new ZipDeflate(`xl/worksheets/sheet${this.sheet}.xml`, { level: 6 });
    this.zip.add(this.entry);
    const widths = this.cols.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.min(45, Math.max(10, c.length + 4))}" customWidth="1"/>`).join('');
    this.put(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
        `<sheetFormatPr defaultRowHeight="15"/><cols>${widths}</cols><sheetData>`
    );
    this.rowNo = 1;
    this.put(`<row r="1">${this.cols.map((c, i) => this.cell(1, i, c, 1)).join('')}</row>`);
  }

  private closeSheet() {
    this.put(`</sheetData><autoFilter ref="A1:${colName(Math.max(0, this.cols.length - 1))}${Math.max(1, this.rowNo)}"/></worksheet>`, true);
  }

  async begin(cols: string[]) {
    this.cols = cols;
    this.openSheet();
  }

  async rows(rows: unknown[][]) {
    for (const r of rows) {
      if (this.rowNo >= MAX_ROWS) {
        this.closeSheet();
        this.openSheet();
      }
      this.rowNo++;
      this.put(`<row r="${this.rowNo}">${r.map((v, i) => this.cell(this.rowNo, i, v)).join('')}</row>`);
    }
    if (this.failed) throw this.failed;
    await this.out.drain();
  }

  private part(name: string, xml: string) {
    const e = new ZipDeflate(name, { level: 6 });
    this.zip.add(e);
    e.push(strToU8(xml), true);
  }

  async end() {
    this.closeSheet();
    const n = this.sheet;
    const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
    const sheets = Array.from({ length: n }, (_, i) => i + 1);
    this.part(
      '[Content_Types].xml',
      head +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        sheets.map((i) => `<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
        '</Types>'
    );
    this.part('_rels/.rels', head + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
    this.part(
      'xl/workbook.xml',
      head +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
        sheets.map((i) => `<sheet name="${i === 1 ? 'Result' : 'Result ' + i}" sheetId="${i}" r:id="rId${i}"/>`).join('') +
        '</sheets></workbook>'
    );
    this.part(
      'xl/_rels/workbook.xml.rels',
      head +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        sheets.map((i) => `<Relationship Id="rId${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i}.xml"/>`).join('') +
        `<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`
    );
    this.part(
      'xl/styles.xml',
      head +
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd\\ hh:mm:ss"/></numFmts>' +
        '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
        '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE7E6E6"/><bgColor indexed="64"/></patternFill></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>' +
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'
    );
    this.zip.end();
    if (this.failed) throw this.failed;
    await this.out.close();
  }
}

export function createWriter(format: ExportFormat, file: string, opts: ExportOptions): ExportWriter {
  switch (format) {
    case 'xlsx':
      return new Xlsx(file);
    case 'csv':
      return new Delimited(file, opts.csvSeparator, false);
    case 'tsv':
      return new Delimited(file, '\t', true);
    case 'json':
      return new Json(file);
    case 'html':
      return new Html(file);
    case 'md':
      return new Markdown(file);
    case 'sql':
      return new SqlInsert(file, opts.tableName, opts.oracle);
    case 'sqlbind':
      return new SqlBindBlocks(file, 'insert', opts.tableName, [], opts.oracle);
    case 'merge':
      return new SqlMerge(file, opts.tableName, opts.keyColumns, opts.oracle);
    case 'mergebind':
      return new SqlBindBlocks(file, 'merge', opts.tableName, opts.keyColumns, opts.oracle);
    case 'xml':
      return new Xml(file);
  }
}
