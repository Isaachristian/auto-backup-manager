import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { postgresArguments, postgresEnvironment } from './connections.js';
import { uploadStream } from './storage.js';

function finished(child, name) {
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
  return new Promise((resolve, reject) => {
    child.once('error', () => reject(new Error(`Could not start ${name}. Rebuild the image with PostgreSQL client tools and gzip.`)));
    child.once('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`${name} failed. ${name === 'pg_dump' ? 'Check database connection, SSL, and permissions.' : 'Compression did not finish.'}${/server version mismatch/i.test(stderr) ? ' The PostgreSQL server is newer than pg_dump.' : ''}`));
    });
  });
}
export async function streamDump(database, storage, key) {
  const controller = new AbortController();
  let dump, gzip;
  const stop = () => {
    dump?.stdout.destroy(); gzip?.stdin.destroy(); gzip?.stdout.destroy();
    if (dump && dump.exitCode === null) dump.kill('SIGKILL');
    if (gzip && gzip.exitCode === null) gzip.kill('SIGKILL');
  };
  controller.signal.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('Backup timed out after six hours.')), 6 * 60 * 60000);
  timer.unref();
  const tasks = [];
  try {
    dump = spawn('pg_dump', [...postgresArguments(database), '-w', '--format=plain', '--no-password'], { env: postgresEnvironment(database), stdio: ['ignore', 'pipe', 'pipe'] });
    gzip = spawn('gzip', ['-c'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const dumpDone = finished(dump, 'pg_dump'), gzipDone = finished(gzip, 'gzip');
    const piped = pipeline(dump.stdout, gzip.stdin, { signal: controller.signal });
    tasks.push(dumpDone, gzipDone, piped);
    const uploaded = uploadStream(storage, key, gzip.stdout, { signal: controller.signal,
      beforeComplete: () => Promise.all([dumpDone, gzipDone, piped]) });
    tasks.push(uploaded);
    const results = await Promise.all(tasks);
    return results[3];
  } catch (error) {
    controller.abort(error);
    await Promise.allSettled(tasks);
    throw error;
  } finally { clearTimeout(timer); stop(); }
}
