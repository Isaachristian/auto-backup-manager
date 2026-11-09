import net from 'node:net';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';

// A single connection with bounded, multiline SMTP replies.
function replies(socket) {
  let buffer = '', lines = [], ready = [], waiter, failure;
  const fail = error => { failure = error; if (waiter) { waiter.reject(error); waiter = null; } };
  const data = chunk => {
    buffer += chunk.toString('utf8');
    if (buffer.length + lines.join('').length > 65536) return socket.destroy(new Error('SMTP reply too large.'));
    let index;
    while ((index = buffer.indexOf('\r\n')) !== -1) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 2);
      if (!/^\d{3}[ -]/.test(line)) return socket.destroy(new Error('Invalid SMTP reply.'));
      lines.push(line);
      if (line[3] === ' ') {
        const result = { code: Number(line.slice(0, 3)), lines };
        lines = [];
        if (waiter) { const current = waiter; waiter = null; current.resolve(result); }
        else ready.push(result);
        if (ready.length > 20) return socket.destroy(new Error('Unexpected SMTP replies.'));
      }
    }
  };
  const close = () => fail(new Error('SMTP server closed the connection.'));
  socket.on('data', data); socket.on('error', fail); socket.on('close', close);
  return {
    read() {
      if (ready.length) return Promise.resolve(ready.shift());
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => { waiter = { resolve, reject }; });
    },
    detach() { socket.off('data', data); socket.off('error', fail); socket.off('close', close); },
  };
}
function tlsOptions(host) {
  return { servername: net.isIP(host) ? undefined : host, rejectUnauthorized: true, minVersion: 'TLSv1.2',
    checkServerIdentity: (_name, certificate) => tls.checkServerIdentity(host, certificate) };
}
export async function smtp(settings, message) {
  if (!settings.host || !settings.from || !settings.to) throw new Error('Save SMTP host, sender, and recipient first.');
  if (Boolean(settings.username) !== Boolean(settings.password)) throw new Error('SMTP authentication needs both username and password, or neither for a trusted relay.');
  let socket = settings.security === 'tls'
    ? tls.connect({ host: settings.host, port: settings.port, ...tlsOptions(settings.host) })
    : net.connect({ host: settings.host, port: settings.port });
  const timeout = setTimeout(() => socket.destroy(new Error('SMTP operation timed out.')), 20000);
  let reader = replies(socket);
  const expect = async codes => {
    const reply = await reader.read();
    // Do not echo remote replies, which can contain addresses or authentication data.
    if (!codes.includes(reply.code)) throw new Error(`SMTP server returned ${reply.code}. Check credentials, sender permissions, and transport security.`);
    return reply;
  };
  const command = async (text, codes) => { socket.write(text + '\r\n'); return expect(codes); };
  try {
    await expect([220]);
    let hello = await command('EHLO backup-manager.local', [250]);
    if (settings.security === 'starttls') {
      if (!hello.lines.some(line => /^250[ -]STARTTLS\b/i.test(line))) throw new Error('SMTP server does not offer STARTTLS.');
      await command('STARTTLS', [220]);
      reader.detach();
      socket = tls.connect({ socket, ...tlsOptions(settings.host) });
      reader = replies(socket);
      await new Promise((resolve, reject) => { socket.once('secureConnect', resolve); socket.once('error', reject); });
      hello = await command('EHLO backup-manager.local', [250]);
    }
    if (settings.username) {
      const auth = hello.lines.find(line => /^250[ -]AUTH[ =]/i.test(line))?.toUpperCase() || '';
      if (/\bPLAIN\b/.test(auth)) {
        const response = await command('AUTH PLAIN ' + Buffer.from(`\0${settings.username}\0${settings.password}`).toString('base64'), [235, 334]);
        if (response.code === 334) await command(Buffer.from(`\0${settings.username}\0${settings.password}`).toString('base64'), [235]);
      } else if (/\bLOGIN\b/.test(auth)) {
        await command('AUTH LOGIN', [334]);
        await command(Buffer.from(settings.username).toString('base64'), [334]);
        await command(Buffer.from(settings.password).toString('base64'), [235]);
      } else throw new Error('SMTP server must support AUTH PLAIN or LOGIN.');
    }
    if (message) {
      await command(`MAIL FROM:<${settings.from}>`, [250]);
      await command(`RCPT TO:<${settings.to}>`, [250, 251]);
      await command('DATA', [354]);
      const body = Buffer.from(message.body, 'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n') || '';
      const headers = [`From: ${settings.from}`, `To: ${settings.to}`, `Date: ${new Date().toUTCString()}`,
        `Message-ID: <${randomUUID()}@backup-manager.local>`, `Subject: =?UTF-8?B?${Buffer.from(message.subject).toString('base64')}?=`,
        'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64'];
      await command(headers.join('\r\n') + '\r\n\r\n' + body + '\r\n.', [250]);
    }
    // Delivery is accepted at DATA's 250 response, even if QUIT later disconnects.
    socket.end('QUIT\r\n');
  } finally { clearTimeout(timeout); socket.destroy(); }
}
