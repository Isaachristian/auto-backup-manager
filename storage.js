import { storageRequest } from './connections.js';
import { db } from './database.js';

const partSize = 16 * 1024 * 1024;
db.exec('CREATE TABLE IF NOT EXISTS pending_uploads (upload_id TEXT PRIMARY KEY, object_key TEXT NOT NULL, settings TEXT NOT NULL)');
const escapeXml = value => value.replace(/[<>&"']/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char]);
function xmlValue(xml, name) {
  const value = new RegExp(`<(?:(?:[\\w-]+):)?${name}>([\\s\\S]*?)<\\/(?:(?:[\\w-]+):)?${name}>`).exec(xml)?.[1];
  return value?.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);/g, (_entity, key) => {
    if (key.startsWith('#')) return String.fromCodePoint(key.startsWith('#x') ? parseInt(key.slice(2), 16) : Number(key.slice(1)));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[key];
  });
}
async function* parts(source) {
  let buffer = Buffer.allocUnsafe(partSize), size = 0;
  for await (const chunk of source) {
    let offset = 0;
    while (offset < chunk.length) {
      const count = Math.min(buffer.length - size, chunk.length - offset);
      chunk.copy(buffer, size, offset, offset + count);
      size += count; offset += count;
      if (size === partSize) {
        yield buffer;
        buffer = Buffer.allocUnsafe(partSize); size = 0;
      }
    }
  }
  if (size) yield buffer.subarray(0, size);
}
async function abortUpload(settings, key, uploadId) {
  try { await storageRequest(settings, 'DELETE', key, { query: { uploadId }, timeout: 15000 }); }
  catch (error) { if (error.status !== 404) throw error; }
  db.prepare('DELETE FROM pending_uploads WHERE upload_id = ?').run(uploadId);
}
export async function uploadStream(settings, key, source, { signal, beforeComplete = async () => {} } = {}) {
  let uploadId, bytes = 0;
  try {
    const created = await storageRequest(settings, 'POST', key, { query: { uploads: '' }, signal, headers: { 'content-type': 'application/gzip' } });
    uploadId = xmlValue(created.text, 'UploadId');
    if (!uploadId || uploadId.length > 4096) throw new Error('Object storage did not return a valid multipart upload ID.');
    db.prepare('INSERT INTO pending_uploads VALUES (?, ?, ?)').run(uploadId, key, JSON.stringify(settings));
    const completed = [];
    for await (const body of parts(source)) {
      if (completed.length === 10000) throw new Error('Backup exceeds the 10,000-part limit (about 156 GiB compressed).');
      const number = completed.length + 1;
      const result = await storageRequest(settings, 'PUT', key, { query: { partNumber: number, uploadId }, body, signal, timeout: 10 * 60000 });
      const etag = result.headers.get('etag');
      if (!etag) throw new Error('Object storage did not return a part ETag.');
      completed.push(`<Part><PartNumber>${number}</PartNumber><ETag>${escapeXml(etag)}</ETag></Part>`);
      bytes += body.length;
    }
    if (!completed.length) throw new Error('The backup produced no compressed data.');
    // A failed pg_dump can still produce valid gzip bytes. Check every process
    // before publishing the object, so partial SQL never becomes a good backup.
    await beforeComplete();
    const result = await storageRequest(settings, 'POST', key, { query: { uploadId }, signal,
      headers: { 'content-type': 'application/xml' }, body: `<CompleteMultipartUpload>${completed.join('')}</CompleteMultipartUpload>`, timeout: 10 * 60000 });
    if (/<(?:[\w-]+:)?Error(?:\s|>)/.test(result.text) || !xmlValue(result.text, 'ETag')) throw new Error('Object storage did not complete the multipart upload successfully.');
    db.prepare('DELETE FROM pending_uploads WHERE upload_id = ?').run(uploadId);
    return bytes;
  } catch (error) {
    // Use a fresh timeout, since the pipeline signal may already be aborted.
    if (uploadId) {
      try { await abortUpload(settings, key, uploadId); }
      catch { console.error('Could not abort multipart upload; it will be retried on restart.'); }
    }
    throw error;
  }
}
export async function cleanInterruptedUploads() {
  for (const row of db.prepare('SELECT * FROM pending_uploads').all()) {
    try { await abortUpload(JSON.parse(row.settings), row.object_key, row.upload_id); }
    catch { console.error('Could not clean up an interrupted multipart upload.'); }
  }
}
