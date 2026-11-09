import { spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { smtp } from './smtp.js';

export function postgresEnvironment(settings) {
  if (!settings.host || !settings.database || !settings.username) throw new Error('Save PostgreSQL host, database, and username first.');
  return { ...process.env, PGHOST: settings.host, PGPORT: String(settings.port), PGUSER: settings.username,
    PGPASSWORD: settings.password, PGDATABASE: settings.database, PGSSLMODE: settings.sslmode,
    PGCONNECT_TIMEOUT: '10', PGAPPNAME: 'auto-backup-manager',
    ...(settings.sslmode === 'verify-full' ? { PGSSLROOTCERT: process.env.PGSSLROOTCERT || 'system' } : {}) };
}
export function postgresArguments(settings) {
  const quote = value => `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
  return ['--dbname', `dbname=${quote(settings.database)}`];
}
export function postgresCommand(command, args, settings, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const connectionArgs = ['psql', 'pg_dump'].includes(command) ? postgresArguments(settings) : [];
    const child = spawn(command, [...connectionArgs, ...args], { env: postgresEnvironment(settings), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-4096); });
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-4096); });
    child.once('error', error => { clearTimeout(timer); reject(new Error(error.code === 'ENOENT' ? 'PostgreSQL client tools are missing. Rebuild the Docker image.' : 'Could not start PostgreSQL client.')); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) return resolve(output.trim());
      // Avoid returning server-controlled text or connection parameters.
      const detail = /server version mismatch/i.test(errors) ? ' The PostgreSQL server is newer than the installed pg_dump client.' : '';
      reject(new Error(timedOut ? 'PostgreSQL operation timed out.' : `PostgreSQL operation failed. Check connection details, SSL certificates, and database permissions.${detail}`));
    });
  });
}
const sha256 = value => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
export function signStorage(settings, method, key = '', payloadHash = sha256(''), date = new Date(), query = {}, extraHeaders = {}) {
  if (!settings.endpoint || !settings.bucket || !settings.region || !settings.accessKeyId || !settings.secretAccessKey) throw new Error('Save an object storage endpoint, region, bucket, and both access keys first.');
  const url = new URL(settings.endpoint);
  const prefix = url.pathname.replace(/\/$/, '');
  if (settings.pathStyle) url.pathname = `${prefix}/${encode(settings.bucket)}${key ? '/' + key.split('/').map(encode).join('/') : ''}`;
  else {
    url.hostname = `${settings.bucket}.${url.hostname}`;
    url.pathname = `${prefix}/${key.split('/').map(encode).join('/')}`;
  }
  const canonicalQuery = Object.entries(query).map(([name, value]) => [encode(name), encode(String(value))]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, value]) => `${name}=${value}`).join('&');
  url.search = canonicalQuery;
  const timestamp = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const scope = `${timestamp.slice(0, 8)}/${settings.region}/s3/aws4_request`;
  const headers = { host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': timestamp, ...extraHeaders };
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort().map(name => `${name}:${headers[name]}\n`).join('');
  const canonical = [method, url.pathname, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  let signingKey = hmac('AWS4' + settings.secretAccessKey, timestamp.slice(0, 8));
  for (const part of [settings.region, 's3', 'aws4_request']) signingKey = hmac(signingKey, part);
  const signature = createHmac('sha256', signingKey).update(`AWS4-HMAC-SHA256\n${timestamp}\n${scope}\n${sha256(canonical)}`).digest('hex');
  headers.Authorization = `AWS4-HMAC-SHA256 Credential=${settings.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { url, headers };
}
export async function storageRequest(settings, method, key = '', { query = {}, body, headers: extraHeaders = {}, signal, timeout = 60000 } = {}) {
  const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(body);
  const { url, headers } = signStorage(settings, method, key, sha256(payload || ''), new Date(), query, extraHeaders);
  if (payload) headers['content-length'] = String(payload.length);
  const response = await fetch(url, { method, headers, body: payload, redirect: 'manual',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) });
  // Bound service responses rather than buffering arbitrary remote error bodies.
  let text = '';
  if (response.body) {
    for await (const chunk of response.body) {
      text += Buffer.from(chunk).toString('utf8');
      if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('Object storage response is too large.');
    }
  }
  if (!response.ok) {
    const error = new Error(`Object storage returned HTTP ${response.status}. Check endpoint, region, bucket, and key permissions.`);
    error.status = response.status;
    throw error;
  }
  return { text, headers: response.headers };
}
export async function checkConnection(section, settings, sendEmail = false) {
  if (section === 'database') {
    await postgresCommand('psql', ['-X', '-w', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', 'SELECT 1'], settings);
    return 'PostgreSQL connection and authentication succeeded.';
  }
  if (section === 'storage') {
    await storageRequest(settings, 'HEAD', '');
    return 'Bucket access verified. This checks bucket access, not permission to upload backups.';
  }
  if (section === 'smtp') {
    await smtp(settings, sendEmail ? { subject: 'Auto Backup Manager — test email', body: 'Your SMTP settings are working. This test email was sent by Auto Backup Manager.' } : undefined);
    return sendEmail ? 'Test email accepted by the SMTP server. Check the recipient inbox.' : 'SMTP connection, TLS, and authentication succeeded.';
  }
  throw new Error('Unknown connection type.');
}
