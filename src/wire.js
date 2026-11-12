// Publish request body format (Content-Type: application/vnd.tailnet-artifacts.bundle):
//
//   <manifest JSON>\n<file 1 bytes><file 2 bytes>...
//
// The manifest is a single line: { "v": 1, "files": [{ "path": "index.html", "size": 123 }, ...], ...options }
// File bytes follow in manifest order with no separators. Simple, streaming-friendly, no multipart parsing.
import { HttpError } from './store.js';

export const BUNDLE_TYPE = 'application/vnd.tailnet-artifacts.bundle';
const MAX_MANIFEST = 1024 * 1024;

export function encodeBundle(files, options = {}) {
  const manifest = { v: 1, ...options, files: files.map((f) => ({ path: f.path, size: f.data.length })) };
  const head = Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8');
  return Buffer.concat([head, ...files.map((f) => f.data)]);
}

export function decodeBundle(buf) {
  const nl = buf.indexOf(0x0a);
  if (nl < 0 || nl > MAX_MANIFEST) throw new HttpError(400, 'bad_bundle', 'missing or oversized manifest line');
  let manifest;
  try {
    manifest = JSON.parse(buf.subarray(0, nl).toString('utf8'));
  } catch {
    throw new HttpError(400, 'bad_bundle', 'manifest is not valid JSON');
  }
  if (manifest?.v !== 1 || !Array.isArray(manifest.files)) throw new HttpError(400, 'bad_bundle', 'unsupported manifest');
  let offset = nl + 1;
  const files = [];
  for (const f of manifest.files) {
    const size = Number(f?.size);
    if (!Number.isInteger(size) || size < 0) throw new HttpError(400, 'bad_bundle', 'invalid file size in manifest');
    if (offset + size > buf.length) throw new HttpError(400, 'bad_bundle', 'body shorter than manifest declares');
    files.push({ path: f.path, data: buf.subarray(offset, offset + size) });
    offset += size;
  }
  if (offset !== buf.length) throw new HttpError(400, 'bad_bundle', 'body longer than manifest declares');
  const { files: _f, v: _v, ...options } = manifest;
  return { files, options };
}
