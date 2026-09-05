import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import ipaddr from 'ipaddr.js';

export function isPublicIp(value) {
  try {
    let ip = ipaddr.parse(value);
    if (ip.kind() === 'ipv6' && ip.isIPv4MappedAddress()) ip = ip.toIPv4Address();
    return ip.range() === 'unicast';
  } catch { return false; }
}
export async function validatePublicUrl(raw, lookup = dns.lookup) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Expected public HTTP(S) URL without credentials');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) throw new Error('Localhost is not allowed');
  const addresses = await lookup(host, { all: true });
  if (!addresses.length || addresses.some(a => !isPublicIp(a.address))) throw new Error('Non-public destination is not allowed');
  return { url, address: addresses[0] };
}
export async function fetchResource(raw, { maxBytes = 10 * 1024 * 1024, timeoutMs = 30000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let next = raw;
  for (let hop = 0; hop <= 5; hop++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('HTTP retrieval timed out');
    let dnsTimer;
    let resolved;
    try {
      resolved = await Promise.race([
        validatePublicUrl(next),
        new Promise((_, reject) => { dnsTimer = setTimeout(() => reject(new Error('DNS timed out')), remaining); })
      ]);
    } finally { clearTimeout(dnsTimer); }
    const { url, address } = resolved;
    const result = await new Promise((resolve, reject) => {
      const transport = url.protocol === 'https:' ? https : http;
      const request = transport.get(url, {
        headers: { 'User-Agent': 'KnowledgeAgent/1.0', Accept: '*/*' },
        // Pin the validated address; do not perform a second DNS lookup when connecting.
        lookup: (_hostname, options, cb) => options.all
          ? cb(null, [address]) : cb(null, address.address, address.family)
      }, response => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          const location = response.headers.location;
          response.destroy();
          if (!location) return reject(new Error('Redirect without Location'));
          resolve({ redirect: new URL(location, url).href });
          return;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          response.destroy(); reject(new Error('HTTP status ' + response.statusCode)); return;
        }
        const chunks = [];
        let bytes = 0;
        response.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > maxBytes) { response.destroy(new Error('Response size limit exceeded')); return; }
          chunks.push(chunk);
        });
        response.on('end', () => resolve({ finalUrl: url.href, contentType: response.headers['content-type'] || '', body: Buffer.concat(chunks) }));
        response.on('error', reject);
      });
      const timer = setTimeout(() => request.destroy(new Error('HTTP retrieval timed out')), Math.max(1, deadline - Date.now()));
      request.on('error', reject);
      request.on('close', () => clearTimeout(timer));
    });
    if (!result.redirect) return result;
    next = result.redirect;
  }
  throw new Error('Too many redirects');
}