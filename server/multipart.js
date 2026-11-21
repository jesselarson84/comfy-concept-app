// multipart.js - tiny multipart/form-data parser (enough for file uploads
// from the import button and the Android share sheet). Keeps the server
// dependency-free. Reads the whole body into memory, so it enforces a limit.

export function readBody(req, limit = 50 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Returns [{ name, filename?, contentType?, data: Buffer }] */
export function parseMultipart(body, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) throw Object.assign(new Error('Missing multipart boundary'), { status: 400 });
  const boundary = Buffer.from('--' + (m[1] || m[2]).trim());
  const parts = [];
  let pos = body.indexOf(boundary);
  while (pos !== -1) {
    const start = pos + boundary.length;
    if (body.slice(start, start + 2).toString() === '--') break; // final boundary
    const headerEnd = body.indexOf('\r\n\r\n', start);
    if (headerEnd === -1) break;
    const headers = body.slice(start + 2, headerEnd).toString('utf8');
    const next = body.indexOf(boundary, headerEnd);
    if (next === -1) break;
    const data = body.slice(headerEnd + 4, next - 2); // strip trailing \r\n
    const disp = /content-disposition:[^\r\n]*/i.exec(headers)?.[0] || '';
    const name = /\bname="([^"]*)"/i.exec(disp)?.[1];
    const filename = /\bfilename="([^"]*)"/i.exec(disp)?.[1];
    const ct = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1];
    parts.push({ name, filename, contentType: ct, data });
    pos = next;
  }
  return parts;
}
