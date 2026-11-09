import { db } from './database.js';
import { parseCron, clock } from './cron.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (section TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS backups (
    id INTEGER PRIMARY KEY, started_at TEXT NOT NULL, database_name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
    size_bytes INTEGER, duration_seconds REAL, object_key TEXT, error TEXT
  );
`);
const definitions = {
  schedule: {
    defaults: { enabled: false, cron: '0 3 * * *', timeZone: 'America/Chicago' },
    required: ['cron', 'timeZone'], secrets: [], choices: {},
  },
  database: {
    defaults: { host: '', port: 5432, database: '', username: '', password: '', sslmode: 'verify-full' },
    required: ['host', 'database', 'username'], secrets: ['password'],
    choices: { sslmode: ['disable', 'require', 'verify-full'] },
  },
  storage: {
    defaults: { endpoint: '', region: '', bucket: '', prefix: 'backups/', accessKeyId: '', secretAccessKey: '', pathStyle: false },
    required: ['endpoint', 'region', 'bucket'], secrets: ['accessKeyId', 'secretAccessKey'], choices: {},
  },
  smtp: {
    defaults: { host: '', port: 587, username: '', password: '', from: '', to: '', security: 'starttls', notifyBackups: false },
    required: ['host', 'from', 'to'], secrets: ['password'], choices: { security: ['starttls', 'tls'] },
  },
};
export function stored(section) {
  const row = db.prepare('SELECT value FROM settings WHERE section = ?').get(section);
  return { ...definitions[section].defaults, ...(row ? JSON.parse(row.value) : {}) };
}
export function settings() {
  return Object.fromEntries(Object.entries(definitions).map(([section, definition]) => {
    const value = stored(section);
    for (const key of definition.secrets) {
      value[`${key}Configured`] = Boolean(value[key]);
      delete value[key];
    }
    return [section, value];
  }));
}
export function validatedSettings(section, input) {
  if (typeof section !== 'string' || !Object.hasOwn(definitions, section)) throw new Error('Unknown settings section.');
  const definition = definitions[section];
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid settings.');
  const current = stored(section);
  const value = { ...current };
  for (const [key, defaultValue] of Object.entries(definition.defaults)) {
    if (!Object.hasOwn(input, key)) continue;
    const item = input[key];
    if (typeof item !== typeof defaultValue) throw new Error(`Invalid value for ${key}.`);
    if (typeof item === 'string' && (item.length > 1024 || /[\r\n\0]/.test(item))) throw new Error(`Invalid value for ${key}.`);
    if (typeof item === 'number' && (!Number.isInteger(item) || item < 1 || item > 65535)) throw new Error('Port must be between 1 and 65535.');
    if (definition.secrets.includes(key)) {
      if (item !== '') value[key] = item;
    } else value[key] = typeof item === 'string' ? item.trim() : item;
  }
  for (const key of definition.secrets) {
    if (input[`clear_${key}`] === true) value[key] = '';
  }
  for (const key of definition.required) if (!value[key]) throw new Error(`Please enter ${key}.`);
  for (const [key, choices] of Object.entries(definition.choices)) if (!choices.includes(value[key])) throw new Error(`Invalid ${key}.`);
  if (section === 'storage') {
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value.bucket)) throw new Error('Enter a valid S3 bucket name (3–63 lowercase letters, numbers, dots, or hyphens).');
    let endpoint;
    try { endpoint = new URL(value.endpoint); } catch { throw new Error('Enter a valid object storage URL.'); }
    if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Use an HTTP or HTTPS endpoint without credentials, query parameters, or fragments.');
  }
  if (section === 'schedule') {
    parseCron(value.cron);
    clock(value.timeZone);
    if (value.enabled) {
      const database = stored('database'), storage = stored('storage');
      if (!database.host || !database.database || !database.username || !storage.endpoint || !storage.region || !storage.bucket || !storage.accessKeyId || !storage.secretAccessKey) throw new Error('Save database and object storage connection details before enabling the schedule.');
    }
  }
  if (section === 'smtp') for (const key of ['from', 'to']) if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value[key])) throw new Error(`Enter a valid ${key} email address.`);
  return value;
}
export function saveSettings(section, input) {
  const value = validatedSettings(section, input);
  db.prepare('INSERT INTO settings VALUES (?, ?) ON CONFLICT(section) DO UPDATE SET value = excluded.value').run(section, JSON.stringify(value));
}
export function backups() {
  return db.prepare('SELECT * FROM backups ORDER BY started_at DESC, id DESC LIMIT 100').all();
}
