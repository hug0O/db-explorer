import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';

const hasTns = (dir: string) => {
  try {
    return fs.existsSync(path.join(dir, 'tnsnames.ora'));
  } catch {
    return false;
  }
};

/** Dossiers trouvés par la dernière détection (repli pour les connexions sans dossier TNS explicite). */
let detected: string[] = [];

/** Cherche le dossier contenant tnsnames.ora (réglage / TNS_ADMIN / ORACLE_HOME, puis dossiers détectés). */
export function findTnsAdmin(explicit?: string): string | undefined {
  const candidates = [
    explicit,
    process.env.TNS_ADMIN,
    process.env.ORACLE_HOME && path.join(process.env.ORACLE_HOME, 'network', 'admin'),
    process.env.ORACLE_HOME && path.join(process.env.ORACLE_HOME, 'NETWORK', 'ADMIN'),
    ...detected,
  ];
  for (const c of candidates) if (c && hasTns(c)) return c;
  return undefined;
}

/** Expansion d'un motif avec « * » (un seul niveau par segment), ex. C:/app/* /product/* /network/admin. */
function expand(pattern: string): string[] {
  const parts = pattern.split('/');
  let cur: string[] = [parts[0] + '/'];
  for (const seg of parts.slice(1)) {
    const next: string[] = [];
    for (const base of cur) {
      if (!seg.includes('*')) {
        next.push(path.join(base, seg));
        continue;
      }
      const re = new RegExp('^' + seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
      try {
        for (const e of fs.readdirSync(base, { withFileTypes: true })) if (e.isDirectory() && re.test(e.name)) next.push(path.join(base, e.name));
      } catch {
        /* dossier absent */
      }
    }
    cur = next;
    if (!cur.length) break;
  }
  return cur;
}

function registryOracleHomes(): Promise<string[]> {
  if (process.platform !== 'win32') return Promise.resolve([]);
  const query = (key: string) =>
    new Promise<string[]>((resolve) => {
      execFile('reg', ['query', key, '/s', '/v', 'ORACLE_HOME'], { timeout: 3000, windowsHide: true }, (err, stdout) => {
        if (err) return resolve([]);
        resolve([...stdout.matchAll(/ORACLE_HOME\s+REG_(?:EXPAND_)?SZ\s+(.+)/g)].map((m) => m[1].trim()));
      });
    });
  return Promise.all([query('HKLM\\SOFTWARE\\ORACLE'), query('HKLM\\SOFTWARE\\WOW6432Node\\ORACLE')]).then((r) => r.flat());
}

/**
 * Détecte les tnsnames.ora de la machine : TNS_ADMIN, ORACLE_HOME, registre Windows, dossiers Oracle habituels,
 * Instant Client, dossiers du PATH (sqlplus / client Oracle) et dossiers ouverts dans VS Code.
 */
export async function detectTnsDirs(extra: string[] = []): Promise<string[]> {
  const found: string[] = [];
  const add = (d?: string) => {
    if (!d) return;
    try {
      const real = fs.realpathSync(d);
      if (hasTns(real) && !found.some((f) => f.toLowerCase() === real.toLowerCase())) found.push(real);
    } catch {
      /* ignore */
    }
  };
  add(process.env.TNS_ADMIN);
  if (process.env.ORACLE_HOME) {
    add(path.join(process.env.ORACLE_HOME, 'network', 'admin'));
    add(path.join(process.env.ORACLE_HOME, 'NETWORK', 'ADMIN'));
  }
  for (const home of await registryOracleHomes()) add(path.join(home, 'network', 'admin'));
  for (const e of extra) {
    add(e);
    add(path.join(e, 'network', 'admin'));
  }
  // dossiers du PATH contenant un client Oracle
  for (const d of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!d) continue;
    try {
      const names = fs.readdirSync(d);
      if (names.some((n) => /^(sqlplus(\.exe)?|oci\.dll|libclntsh\.so.*|libclntsh\.dylib.*)$/i.test(n))) {
        add(path.join(d, 'network', 'admin'));
        add(path.join(d, '..', 'network', 'admin'));
      }
    } catch {
      /* ignore */
    }
  }
  const home = os.homedir();
  const patterns: string[] = [];
  if (process.platform === 'win32') {
    for (const drive of ['C:', 'D:', 'E:']) {
      patterns.push(
        `${drive}/oracle/product/*/*/network/admin`, `${drive}/oracle/product/*/network/admin`, `${drive}/oracle/*/network/admin`, `${drive}/oracle/network/admin`,
        `${drive}/app/*/product/*/*/network/admin`, `${drive}/app/*/product/*/network/admin`, `${drive}/app/client/*/product/*/*/network/admin`,
        `${drive}/instantclient*/network/admin`, `${drive}/oracle/instantclient*/network/admin`, `${drive}/Program Files/Oracle/*/network/admin`,
        `${drive}/Program Files (x86)/Oracle/*/network/admin`, `${drive}/tns`, `${drive}/tnsadmin`
      );
    }
    patterns.push(`${home.replace(/\\/g, '/')}/AppData/Local/Oracle/network/admin`, `${home.replace(/\\/g, '/')}/instantclient*/network/admin`);
  } else {
    patterns.push(
      '/etc', '/opt/oracle/*/network/admin', '/opt/oracle/product/*/*/network/admin', '/usr/lib/oracle/*/client*/network/admin', '/u01/app/oracle/product/*/*/network/admin',
      '/u01/app/oracle/product/*/network/admin', `${home}/.oracle`, `${home}/oracle/network/admin`, `${home}/instantclient*/network/admin`, '/opt/instantclient*/network/admin'
    );
  }
  for (const pat of patterns) for (const d of pat.includes('*') ? expand(pat) : [pat]) add(d);
  detected = found;
  return found;
}

/** Liste les alias définis dans tnsnames.ora (suit IFILE). */
export function listTnsAliases(dir: string, seen = new Set<string>()): string[] {
  const file = path.join(dir, 'tnsnames.ora');
  return parseFile(file, seen);
}

function parseFile(file: string, seen: Set<string>): string[] {
  const real = path.resolve(file);
  if (seen.has(real) || !fs.existsSync(real)) return [];
  seen.add(real);
  const text = fs.readFileSync(real, 'utf8');
  const aliases: string[] = [];
  let depth = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '');
    if (depth === 0) {
      const ifile = /^\s*IFILE\s*=\s*(.+?)\s*$/i.exec(line);
      if (ifile) {
        aliases.push(...parseFile(path.resolve(path.dirname(real), ifile[1].replace(/^["']|["']$/g, '')), seen));
        continue;
      }
      const m = /^([A-Za-z0-9_.$#-]+)\s*=/.exec(line);
      if (m) aliases.push(...m[1].split(',').map((s) => s.trim()));
    }
    for (const ch of line) {
      if (ch === '(') depth++;
      else if (ch === ')') depth = Math.max(0, depth - 1);
    }
  }
  return aliases;
}
