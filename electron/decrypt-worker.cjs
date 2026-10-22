// Adapted from upstream wb_api/src/lib.rs; keys stay in the official client process.

const node_crypto = require('crypto');
function lp(s) { const b = Buffer.from(s, 'utf8'); const l = Buffer.alloc(4); l.writeUInt32BE(b.length); return Buffer.concat([l, b]); }
function u32(v) { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b; }
function buildAad(keyId, suite) {
  return Buffer.concat([
    Buffer.from('WB-AAD\0', 'ascii'),
    Buffer.from([1]),
    lp('WBEV1'),
    lp('sym-v1'),
    u32(suite),
    lp(keyId),
    Buffer.from([2]),
    Buffer.from([0]),
    Buffer.from([0])
  ]);
}
function isWrapper(v) { return v && typeof v === 'object' && v.$wbEncrypted === 1 && typeof v.envelope === 'string' && !v.scheme; }
function open(key, wrap) {
  const envBytes = Buffer.from(wrap.envelope, 'base64');
  const env = JSON.parse(envBytes.toString('utf8'));
  if (env.suite !== 1) throw new Error('unsupported suite ' + env.suite);
  const d = node_crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.nonce, 'base64'), { authTagLength: 16 });
  d.setAAD(buildAad(env.keyId, env.suite));
  d.setAuthTag(Buffer.from(env.authTag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(env.ciphertext, 'base64')), d.final()]).toString('utf8');
}
let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  try {
    const n = process._linkedBinding('electron_browser_workbuddy_storage');
    const payload = JSON.parse(n.loggerGet());
    const key = node_crypto.createHash('sha256').update(payload.atRestSecretKey, 'utf8').digest();
    const fields = JSON.parse(input).fields || {};
    const out = {};
    for (const [name, v] of Object.entries(fields)) {
      if (isWrapper(v)) {
        try { out[name] = { ok: true, value: open(key, v) }; }
        catch (e) { out[name] = { ok: false, err: String((e && e.message) || e) }; }
      } else if (typeof v === 'string') {
        out[name] = { ok: true, value: v };
      } else {
        out[name] = { ok: false, err: 'unsupported value type' };
      }
    }
    process.stdout.write(JSON.stringify({ ok: true, out }));
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, err: String((e && e.message) || e) }));
  }
});
