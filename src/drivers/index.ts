import { DbConn, DbKind, Profile } from './types';
import { connectOracle } from './oracle';
import { connectSqlite } from './sqlite';
import { connectMysql } from './mysql';
import { connectPostgres } from './postgres';

export interface ConnectOpts {
  dateFormat: string;
  timestampFormat: string;
  defaultTnsAdmin?: string;
}

export const KIND_LABELS: Record<DbKind, string> = {
  oracle: 'Oracle',
  sqlite: 'SQLite',
  mysql: 'MySQL / MariaDB',
  postgres: 'PostgreSQL',
};

export const NEEDS_PASSWORD: Record<DbKind, boolean> = { oracle: true, sqlite: false, mysql: true, postgres: true };

export async function connectDb(p: Profile, password: string, o: ConnectOpts): Promise<DbConn> {
  switch (p.type) {
    case 'oracle':
      return connectOracle(p, password, o);
    case 'sqlite':
      return connectSqlite(p);
    case 'mysql':
      return connectMysql(p, password);
    case 'postgres':
      return connectPostgres(p, password);
  }
}

export function describeProfile(p: Profile): string {
  switch (p.type) {
    case 'oracle':
      return `${p.user}@${p.connectString}`;
    case 'sqlite':
      return p.database || ':memory:';
    default:
      return `${p.user}@${p.host}:${p.port ?? ''}/${p.database ?? ''}`;
  }
}
