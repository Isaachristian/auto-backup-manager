import { db } from './database.js';
import { stored, validatedSettings } from './settings.js';
import { streamDump } from './dump.js';
import { cleanInterruptedUploads } from './storage.js';
import { smtp } from './smtp.js';
import { parseCron, clock, localTime, matchesCron, nextRun } from './cron.js';

// One application instance owns the scheduler and backup worker.
db.exec('CREATE TABLE IF NOT EXISTS schedule_slots (slot TEXT PRIMARY KEY, claimed_at INTEGER NOT NULL)');
if (!db.prepare('PRAGMA table_info(backups)').all().some(column => column.name === 'notification_error')) {
  db.exec('ALTER TABLE backups ADD COLUMN notification_error TEXT');
}
db.prepare("UPDATE backups SET status = 'failed', error = 'Backup interrupted by an application restart.' WHERE status = 'running'").run();
let running = false;
export function scheduleStatus() {
  const schedule = stored('schedule');
  const latest = db.prepare('SELECT started_at, status, error FROM backups ORDER BY id DESC LIMIT 1').get() || null;
  return { nextRun: schedule.enabled ? nextRun(schedule.cron, schedule.timeZone) : null, running, latest };
}
export function startManualBackup() {
  if (running) throw new Error('A backup is already running.');
  validatedSettings('database', {});
  const storage = validatedSettings('storage', {});
  if (!storage.accessKeyId || !storage.secretAccessKey) throw new Error('Save both object storage access keys before running a backup.');
  // runBackup reserves the worker and inserts its history row before its first
  // await. Return immediately so large backups do not hold an HTTP request open.
  void runBackup().catch(() => console.error('Manual backup worker failed.'));
  return Number(db.prepare('SELECT id FROM backups ORDER BY id DESC LIMIT 1').get().id);
}
export async function runBackup() {
  if (running) throw new Error('A backup is already running.');
  running = true;
  const started = Date.now(), database = stored('database'), storage = stored('storage'), mail = stored('smtp');
  let id;
  let status = 'failed', failure;
  try {
    id = Number(db.prepare("INSERT INTO backups (started_at, database_name, status) VALUES (?, ?, 'running')").run(new Date(started).toISOString(), database.database).lastInsertRowid);
    const name = database.database.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100) || 'database';
    const objectKey = `${storage.prefix}${name}-${new Date(started).toISOString().replace(/[:.]/g, '-')}-${id}.sql.gz`;
    const size = await streamDump(database, storage, objectKey);
    status = 'completed';
    db.prepare("UPDATE backups SET status = 'completed', size_bytes = ?, duration_seconds = ?, object_key = ? WHERE id = ?").run(size, (Date.now() - started) / 1000, objectKey, id);
  } catch (error) {
    failure = error.message;
    if (id) db.prepare("UPDATE backups SET status = 'failed', error = ?, duration_seconds = ? WHERE id = ?").run(failure, (Date.now() - started) / 1000, id);
    console.error(`Backup failed: ${failure}`);
  } finally {
    try {
      if (mail.notifyBackups && id) {
        try {
          await smtp(mail, { subject: `Database backup ${status}`, body: `Backup #${id}\nDatabase: ${database.database}\nStarted: ${new Date(started).toISOString()}\nStatus: ${status}\n${failure || 'The database dump was uploaded to object storage.'}` });
        } catch (error) {
          db.prepare('UPDATE backups SET notification_error = ? WHERE id = ?').run(error.message, id);
          console.error('Backup notification failed.');
        }
      }
    } finally { running = false; }
  }
}
let lastMinute;
export async function schedulerTick(now = new Date()) {
  const minute = Math.floor(now.getTime() / 60000);
  if (lastMinute === minute) return;
  lastMinute = minute;
  const schedule = stored('schedule');
  if (!schedule.enabled) return;
  const local = localTime(now, clock(schedule.timeZone));
  if (!matchesCron(parseCron(schedule.cron), local)) return;
  const slot = `${schedule.timeZone}:${local.key}`;
  const claimed = db.prepare('INSERT OR IGNORE INTO schedule_slots VALUES (?, ?)').run(slot, now.getTime());
  if (!claimed.changes) return;
  db.prepare('DELETE FROM schedule_slots WHERE claimed_at < ?').run(now.getTime() - 366 * 86400000);
  if (running) { console.log('Skipped scheduled backup because a backup is still running.'); return; }
  await runBackup();
}
export async function startScheduler() {
  await cleanInterruptedUploads();
  const tick = () => schedulerTick().catch(() => console.error('Backup scheduler failed to run.'));
  void tick();
  setInterval(tick, 5000).unref();
}
