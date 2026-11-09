import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import * as auth from './auth.js';
import { settings, saveSettings, backups, validatedSettings } from './settings.js';
import { checkConnection } from './connections.js';
import { scheduleStatus, startScheduler, startManualBackup } from './backup.js';

const port = Number(process.env.PORT || 3000);
function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}
function cookie(response, value, age = 43200) {
  response.setHeader('Set-Cookie', `session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${process.env.COOKIE_SECURE === 'true' ? '; Secure' : ''}`);
}
async function body(request) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw new Error('Expected JSON.');
  let text = '';
  for await (const chunk of request) {
    text += chunk;
    if (Buffer.byteLength(text) > 16384) throw new Error('Request too large.');
  }
  const data = JSON.parse(text);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid request.');
  return data;
}
const files = { '/login': 'index.html', '/index.html': 'index.html', '/app': 'main.html', '/settings': 'settings.html', '/settings-page.js': 'settings-page.js', '/style.css': 'style.css', '/login.js': 'login.js', '/main.js': 'main.js' };
const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    const loggedIn = auth.authenticated(request);
    if (request.method === 'POST') {
      const origin = process.env.APP_ORIGIN || `http://${request.headers.host}`;
      if (request.headers.origin !== origin) return json(response, 403, { error: 'Request origin is not allowed.' });
      if (['/api/setup', '/api/setup/confirm', '/api/login'].includes(path) && !auth.limit(request)) return json(response, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
      if ((path.startsWith('/api/settings') || path === '/api/backups/run') && !loggedIn) return json(response, 401, { error: 'Please log in.' });
      const data = await body(request);
      if (path === '/api/backups/run') {
        if (scheduleStatus().running) return json(response, 409, { error: 'A backup is already running.' });
        return json(response, 202, { id: startManualBackup() });
      }
      if (path === '/api/settings/check' || path === '/api/settings/test-email') {
        if (!['database', 'storage', 'smtp'].includes(data.section) || (path.endsWith('test-email') && data.section !== 'smtp')) return json(response, 400, { error: 'Invalid connection type.' });
        const config = validatedSettings(data.section, data.settings || {});
        const message = await checkConnection(data.section, config, path.endsWith('test-email'));
        return json(response, 200, { message });
      }
      if (path === '/api/settings') {
        saveSettings(data.section, data.settings);
        return json(response, 200, { ok: true });
      }
      if (path === '/api/setup') {
        cookie(response, await auth.beginSetup(data.email, data.password), 900);
        return json(response, 200, { ok: true });
      }
      if (path === '/api/setup/confirm') {
        auth.confirmSetup(request, data.code);
        cookie(response, '', 0);
        return json(response, 200, { ok: true });
      }
      if (path === '/api/login') {
        const key = await auth.login(data.email, data.password, data.code);
        if (!key) return json(response, 401, { error: 'Invalid email, password, or authenticator code. Use a fresh code.' });
        cookie(response, key);
        return json(response, 200, { ok: true });
      }
      if (path === '/api/logout') {
        auth.logout(request);
        cookie(response, '', 0);
        return json(response, 200, { ok: true });
      }
      return json(response, 404, { error: 'Not found.' });
    }
    if (request.method !== 'GET') return json(response, 405, { error: 'Method not allowed.' });
    if (path === '/api/status') {
      const pending = !auth.account() && auth.setup(request);
      return json(response, 200, { state: loggedIn ? 'authenticated' : auth.account() ? 'login' : pending ? 'verify' : 'register', ...(pending ? auth.setupDetails(pending) : {}) });
    }
    if (['/api/settings', '/api/backups', '/api/schedule'].includes(path)) {
      if (!loggedIn) return json(response, 401, { error: 'Please log in.' });
      return json(response, 200, path === '/api/settings' ? settings() : path === '/api/schedule' ? scheduleStatus() : { backups: backups() });
    }
    if (path === '/api/me') return json(response, loggedIn ? 200 : 401, loggedIn ? { email: auth.account().email } : { error: 'Please log in.' });
    if (path === '/' || (['/app', '/settings'].includes(path) && !loggedIn) || (['/login', '/index.html'].includes(path) && loggedIn)) {
      response.writeHead(302, { Location: loggedIn ? '/app' : '/login' });
      return response.end();
    }
    const file = files[path];
    if (!file) return json(response, 404, { error: 'Not found.' });
    const types = { html: 'text/html', css: 'text/css', js: 'text/javascript' };
    response.writeHead(200, { 'Content-Type': `${types[file.split('.').pop()]}; charset=utf-8` });
    response.end(await readFile(new URL(file, import.meta.url)));
  } catch (error) {
    if (!response.headersSent) json(response, 400, { error: error.message });
    else response.end();
  }
});
server.listen(port, '0.0.0.0', () => console.log(`Auto Backup Manager running at http://localhost:${port}`));

startScheduler().catch(() => { console.error('Could not initialize backup scheduler.'); process.exit(1); });
