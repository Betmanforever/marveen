#!/usr/bin/env node
// One-shot: adds email aliases to the primary Workspace account (zenom@zenom.hu)
// via the Admin SDK Directory API. Same SA + domain-wide-delegation pattern as
// admin-directory-probe.mjs, admin.directory.user.alias scope (covers insert).
// UPDATED 2026-07-29 per independent audit + Gabor's explicit instruction
// (Telegram, msg 820 relay): zenom.lu/ibanguardian.com are ALIAS domains (not
// secondary domains) -- they only mirror EXISTING primary-domain usernames,
// they cannot take a brand-new local part directly (that is what caused the
// earlier "Invalid Input: alias_email" 400s). The fix is to add the alias on
// the PRIMARY domain (zenom.hu); the mirror then produces it automatically on
// zenom.lu and ibanguardian.com. hello@ is the PRIMARY target (published on
// the live ibanguardian.com contact page for privacy requests); info@ is
// secondary, add if hello@ succeeds.
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const requireFromRuntime = createRequire(path.join(HERE, 'gmail-sa', 'package.json'))
const { JWT } = requireFromRuntime('google-auth-library')

const KEY_FILE = '/home/szabgabor/.gmail-mcp/zenom-fleet-access-502008-0fd02f7f502f.json'
const SUBJECT = 'zenom@zenom.hu'
const SCOPES = ['https://www.googleapis.com/auth/admin.directory.user.alias']

const ALIASES_TO_ADD = [
  'hello@zenom.hu',
  'info@zenom.hu',
]

const sa = JSON.parse(readFileSync(KEY_FILE, 'utf-8'))
const jwt = new JWT({ email: sa.client_email, key: sa.private_key, scopes: SCOPES, subject: SUBJECT })

const existing = await jwt.request({
  url: `https://admin.googleapis.com/admin/directory/v1/users/${encodeURIComponent(SUBJECT)}/aliases`,
})
const existingSet = new Set((existing.data.aliases ?? []).map(a => a.alias))
console.log('existing aliases:', JSON.stringify([...existingSet]))

for (const alias of ALIASES_TO_ADD) {
  if (existingSet.has(alias)) {
    console.log('SKIP (already present):', alias)
    continue
  }
  try {
    const res = await jwt.request({
      method: 'POST',
      url: `https://admin.googleapis.com/admin/directory/v1/users/${encodeURIComponent(SUBJECT)}/aliases`,
      data: { alias },
    })
    console.log('ADDED:', alias, '->', JSON.stringify(res.data))
  } catch (err) {
    console.error('FAILED:', alias, 'status=', err?.response?.status)
    console.error(JSON.stringify(err?.response?.data, null, 2))
  }
}

const after = await jwt.request({
  url: `https://admin.googleapis.com/admin/directory/v1/users/${encodeURIComponent(SUBJECT)}/aliases`,
})
console.log('final aliases:', JSON.stringify(after.data.aliases ?? []))
