import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import * as auth from './auth.js';

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
    if (Buffer.byteLength(text) > 4096) throw new Error('Request too large.');
  }
  const data = JSON.parse(text);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid request.');
  return data;
}
const files = { '/login': 'index.html', '/index.html': 'index.html', '/app': 'main.html', '/style.css': 'style.css', '/login.js': 'login.js', '/main.js': 'main.js' };
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
      if (path !== '/api/logout' && !auth.limit(request)) return json(response, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
      const data = await body(request);
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
    if (path === '/api/me') return json(response, loggedIn ? 200 : 401, loggedIn ? { email: auth.account().email } : { error: 'Please log in.' });
    if (path === '/' || (path === '/app' && !loggedIn) || (['/login', '/index.html'].includes(path) && loggedIn)) {
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
