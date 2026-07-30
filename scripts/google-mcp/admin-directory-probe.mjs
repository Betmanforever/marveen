#!/usr/bin/env node
// One-shot read-only probe: confirms (a) the Admin SDK API is enabled in the
// zenom-fleet-access-502008 project, and (b) whether the impersonated subject
// (gabor.szabo@zenom.hu) carries the isAdmin/isDelegatedAdmin flag in the
// Directory API. Uses the SAME service-account + domain-wide-delegation
// pattern as gmail-sa-launch.mjs, but with the NEW admin.directory.user.alias
// scope Gabor just added in the Admin Console, read-only (GET, no writes).
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const requireFromRuntime = createRequire(path.join(HERE, 'gmail-sa', 'package.json'))
const { JWT } = requireFromRuntime('google-auth-library')

const KEY_FILE = '/home/szabgabor/.gmail-mcp/zenom-fleet-access-502008-0fd02f7f502f.json'
// zenom@zenom.hu is the TRUE primary Workspace account (confirmed by Gabor
// 2026-07-28); gabor.szabo@zenom.hu is itself only an alias of it. Target the
// primary directly for Directory API userKey lookups to avoid any
// alias-of-an-alias ambiguity.
const SUBJECT = 'zenom@zenom.hu'
const SCOPES = ['https://www.googleapis.com/auth/admin.directory.user.alias']

const sa = JSON.parse(readFileSync(KEY_FILE, 'utf-8'))
const jwt = new JWT({ email: sa.client_email, key: sa.private_key, scopes: SCOPES, subject: SUBJECT })

try {
  // The admin.directory.user.alias scope only covers the aliases
  // sub-resource, not a general user GET -- list the subject's own current
  // aliases (read-only, zero side effects) to confirm both the API is
  // enabled AND the scope grant is live, without needing a broader
  // user-read scope.
  const res = await jwt.request({
    url: `https://admin.googleapis.com/admin/directory/v1/users/${encodeURIComponent(SUBJECT)}/aliases`,
  })
  console.log('OK: Admin SDK reachable, admin.directory.user.alias scope authorized.')
  console.log('current aliases for', SUBJECT, ':', JSON.stringify(res.data.aliases ?? []))
} catch (err) {
  const status = err?.response?.status
  const body = err?.response?.data
  console.error('FAILED. status=', status)
  console.error(JSON.stringify(body, null, 2))
  process.exit(1)
}
