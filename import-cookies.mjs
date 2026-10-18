// Import cookies exported with EditThisCookie (JSON array), keep only what the engine needs, never print values.
//   node import-cookies.mjs cookies.json        (or pipe: Get-Clipboard | node import-cookies.mjs)
// kick.com     -> session_token, URL-decoded, saved as KICK_BEARER in .env (enables trade announcements in chat)
// SITE_HOST    -> token + token_scope, saved to .session.json; the engine imports it into its browser profile
//                 on next start, then deletes the file. SITE_HOST is read from .env.
// Everything else (analytics, consent, Cloudflare, Stripe...) is dropped.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const SAME_SITE = { no_restriction: 'None', lax: 'Lax', strict: 'Strict', unspecified: 'Lax' };
const ICE = new Set(['token', 'token_scope']);

export function sortCookies(list, siteHost = '') {
  if (!Array.isArray(list)) throw new Error('expected a JSON array (EditThisCookie export)');
  const out = { kickBearer: null, ice: [], kept: [], dropped: 0 };
  for (const c of list) {
    const domain = String(c.domain || '').replace(/^\./, '');
    if (domain.endsWith('kick.com') && c.name === 'session_token' && c.value) {
      out.kickBearer = decodeURIComponent(c.value);
      out.kept.push('kick.com/session_token');
    } else if (siteHost && domain.endsWith(siteHost) && ICE.has(c.name) && c.value) {
      out.ice.push({
        name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
        expires: c.expirationDate ? Math.floor(c.expirationDate) : -1,
        httpOnly: !!c.httpOnly, secure: !!c.secure, sameSite: SAME_SITE[c.sameSite] || 'Lax',
      });
      out.kept.push(`${siteHost}/${c.name}`);
    } else out.dropped++;
  }
  return out;
}

// replace (or add) one KEY=value line in a .env text, leaving the other lines untouched
export function setEnv(text, key, value) {
  const lines = text.split(/\r?\n/).filter((l) => l !== '' && !l.startsWith(`${key}=`));
  return [...lines, `${key}=${value}`].join('\n') + '\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const raw = process.argv[2] ? fs.readFileSync(process.argv[2], 'utf8') : fs.readFileSync(0, 'utf8');
  if (fs.existsSync('.env')) process.loadEnvFile('.env');
  const r = sortCookies(JSON.parse(raw.replace(/^﻿/, '')), process.env.SITE_HOST);
  if (r.kickBearer) fs.writeFileSync('.env', setEnv(fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8') : '', 'KICK_BEARER', r.kickBearer));
  if (r.ice.length) fs.writeFileSync('.session.json', JSON.stringify({ cookies: r.ice }));
  console.log(`kept: ${r.kept.join(', ') || 'nothing'} | dropped: ${r.dropped}`);
  if (!r.kept.length) process.exitCode = 1;
  else console.log(r.ice.length ? 'restart the engine to load the site session' : 'restart the engine to enable chat announcements');
}
