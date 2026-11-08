import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash, createHmac, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { openSync, closeSync, chmodSync } from 'node:fs';

const scrypt = promisify(scryptCallback);
const filename = process.env.DB_PATH || new URL('./auth.sqlite', import.meta.url);
closeSync(openSync(filename, 'a', 0o600));
chmodSync(filename, 0o600);
const db = new DatabaseSync(filename);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS account (
    id INTEGER PRIMARY KEY CHECK (id = 1), email TEXT NOT NULL,
    salt TEXT NOT NULL, password_hash TEXT NOT NULL, secret TEXT NOT NULL,
    last_counter INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS attempts (ip TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
`);
const pending = new Map();
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const digest = value => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('hex');
export const account = () => db.prepare('SELECT * FROM account WHERE id = 1').get();

function base32(bytes) {
  let bits = 0, value = 0, output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { bits -= 5; output += alphabet[(value >>> bits) & 31]; }
  }
  if (bits) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}

function matchingCounter(secret, code, last = -1) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  let bits = 0, value = 0;
  const bytes = [];
  for (const character of secret) {
    value = (value << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((value >>> bits) & 255); }
  }
  const now = Math.floor(Date.now() / 30000);
  for (const counter of [now, now - 1, now + 1]) {
    if (counter <= last) continue;
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64BE(BigInt(counter));
    const hash = createHmac('sha1', Buffer.from(bytes)).update(buffer).digest();
    const offset = hash[19] & 15;
    const expected = String((hash.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(code))) return counter;
  }
  return null;
}

export function sessionToken(request) {
  const value = request.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith('session='))?.slice(8);
  return /^[a-f0-9]{64}$/.test(value || '') ? value : '';
}
export function authenticated(request) {
  return Boolean(db.prepare('SELECT 1 FROM sessions WHERE token_hash = ? AND expires > ?').get(digest(sessionToken(request)), Date.now()));
}
export function setup(request) {
  const now = Date.now();
  for (const [key, entry] of pending) if (entry.expires <= now) pending.delete(key);
  return pending.get(digest(sessionToken(request)));
}
export function limit(request) {
  const now = Date.now();
  db.prepare('DELETE FROM attempts WHERE expires <= ?').run(now);
  const ip = request.socket.remoteAddress;
  db.prepare(`INSERT INTO attempts VALUES (?, 1, ?) ON CONFLICT(ip) DO UPDATE SET count = count + 1`).run(ip, now + 15 * 60_000);
  return db.prepare('SELECT count FROM attempts WHERE ip = ?').get(ip).count <= 20;
}
export async function beginSetup(email, password) {
  if (account()) throw new Error('Account setup is already complete.');
  if (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address.');
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) throw new Error('Use a password between 12 and 128 characters.');
  const salt = randomBytes(16).toString('hex');
  const hash = (await scrypt(password, salt, 64)).toString('hex');
  if (account()) throw new Error('Account setup is already complete.');
  const key = token();
  pending.set(digest(key), { email: email.trim().toLowerCase(), salt, hash, secret: base32(randomBytes(20)), expires: Date.now() + 15 * 60_000 });
  return key;
}
export function setupDetails(entry) {
  const issuer = 'Auto Backup Manager';
  return { email: entry.email, secret: entry.secret, uri: `otpauth://totp/${encodeURIComponent(`${issuer}:${entry.email}`)}?secret=${entry.secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30` };
}
export function confirmSetup(request, code) {
  const entry = setup(request);
  if (!entry || account()) throw new Error('Setup expired or is already complete. Reload to continue.');
  const counter = matchingCounter(entry.secret, code);
  if (counter === null) throw new Error('Invalid code. Check your authenticator and device clock.');
  db.prepare('INSERT INTO account VALUES (1, ?, ?, ?, ?, ?)').run(entry.email, entry.salt, entry.hash, entry.secret, counter);
  pending.clear();
}
export async function login(email, password, code) {
  const user = account();
  if (typeof email !== 'string' || typeof password !== 'string' || password.length > 128) return null;
  const hash = await scrypt(password, user?.salt || 'missing-account', 64);
  if (!user || user.email !== email.trim().toLowerCase() || !timingSafeEqual(hash, Buffer.from(user.password_hash, 'hex'))) return null;
  // Re-read after the asynchronous password check so concurrent requests cannot reuse a code.
  const counter = matchingCounter(user.secret, code, account().last_counter);
  if (counter === null) return null;
  db.prepare('UPDATE account SET last_counter = ? WHERE id = 1').run(counter);
  const key = token();
  db.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now());
  db.prepare('INSERT INTO sessions VALUES (?, ?)').run(digest(key), Date.now() + 12 * 60 * 60_000);
  return key;
}
export function logout(request) {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(digest(sessionToken(request)));
  pending.delete(digest(sessionToken(request)));
}
