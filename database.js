import { DatabaseSync } from 'node:sqlite';
import { openSync, closeSync, chmodSync } from 'node:fs';

const filename = process.env.DB_PATH || new URL('./auth.sqlite', import.meta.url);
closeSync(openSync(filename, 'a', 0o600));
chmodSync(filename, 0o600);
export const db = new DatabaseSync(filename);
db.exec('PRAGMA journal_mode = WAL');
