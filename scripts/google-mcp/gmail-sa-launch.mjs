#!/usr/bin/env node
// In-process launcher that gives @gongrzhe/server-gmail-autoauth-mcp a Google
// service-account identity (Workspace domain-wide delegation) instead of the
// installed-app OAuth flow it ships with.
//
// WHY A LAUNCHER AND NOT JUST CONFIG
// That package supports exactly two env vars -- GMAIL_OAUTH_PATH and
// GMAIL_CREDENTIALS_PATH -- and nothing else: no GOOGLE_APPLICATION_CREDENTIALS,
// no keyFile, no subject/impersonation (verified by grepping its dist). It builds
// one OAuth2Client at startup and refreshes it with an OAuth refresh_token.
// A service account cannot mint a refresh_token; it mints ~1h access tokens by
// signing a JWT assertion. So NO static credentials file can keep that package
// authenticated for longer than one token lifetime.
//
// The one public hook that does work is google-auth-library's
// `OAuth2Client.refreshHandler`. In getRequestMetadataAsync() it is consulted
// BEFORE a refresh_token is required, and getAccessToken() falls back to it when
// no refresh_token is set. An OAuth2Client with empty credentials plus a
// refreshHandler therefore mints tokens through us indefinitely -- and the
// package's interactive consent flow is unreachable anyway (it only runs when
// argv[2] === 'auth'), so no OAuth dialog can ever appear.
//
// The patch must land on the SAME google-auth-library instance the server will
// load, so we resolve it from the server's own directory (npm hoisting cannot
// desync us) and require() it -- ESM `import` of that CJS package hits the same
// require cache, so the server sees our patched prototype.
//
// This is why ./gmail-sa/ pins the server package instead of `npx -y`: the
// launcher needs a stable path to resolve against, and pinning also stops every
// server start from pulling whatever version npm currently serves.
//
// Usage (exactly how .mcp.json invokes it):
//   node gmail-sa-launch.mjs
// Env:
//   GMAIL_SA_KEY_FILE  path to the service-account JSON key   (required)
//   GMAIL_SA_SUBJECT   Workspace user to impersonate via DWD  (required)

import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import process from 'node:process'

const TAG = '[gmail-sa]'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const RUNTIME = path.join(HERE, 'gmail-sa', 'package.json')

// Exactly the Gmail scopes authorized for this client in the Workspace admin
// console (Security -> API controls -> Domain-wide Delegation). A DWD token
// request fails wholesale with `unauthorized_client` if it asks for even one
// unauthorized scope, so this list is least-privilege by necessity as well as by
// choice. It also matches the scopes the previous OAuth token carried.
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.settings.basic',
]

function fail(msg) {
  process.stderr.write(`${TAG} ${msg}\n`)
  process.exit(1)
}

// --- config ----------------------------------------------------------------

const keyFile = process.env.GMAIL_SA_KEY_FILE?.trim()
const subject = process.env.GMAIL_SA_SUBJECT?.trim()
if (!keyFile) fail('GMAIL_SA_KEY_FILE is not set (path to the service-account JSON key).')
if (!subject) fail('GMAIL_SA_SUBJECT is not set (Workspace user to impersonate via domain-wide delegation).')
if (!existsSync(keyFile)) fail(`service-account key file not found: ${keyFile}`)

let sa
try {
  sa = JSON.parse(readFileSync(keyFile, 'utf8'))
} catch (err) {
  fail(`cannot parse service-account key file ${keyFile}: ${err.message}`)
}
if (sa.type !== 'service_account' || !sa.client_email || !sa.private_key) {
  fail(`${keyFile} is not a service-account key (need type/client_email/private_key).`)
}

// --- resolve the server and ITS google-auth-library -------------------------

let serverEntry
try {
  serverEntry = createRequire(RUNTIME).resolve('@gongrzhe/server-gmail-autoauth-mcp/dist/index.js')
} catch (err) {
  fail(`cannot resolve the Gmail MCP server from ${RUNTIME} -- run \`npm install\` in ${path.dirname(RUNTIME)} (${err.message})`)
}
// Resolving from the server's own file is what makes the patch bind: whatever
// copy of google-auth-library the server would import is the copy we patch.
const requireFromServer = createRequire(serverEntry)
const { OAuth2Client, JWT } = requireFromServer('google-auth-library')

// --- service-account credentials -------------------------------------------

const jwt = new JWT({ email: sa.client_email, key: sa.private_key, scopes: SCOPES, subject })

let minted = false
// Signature required by OAuth2Client.refreshHandler: resolve to credentials
// carrying an access_token. `expiry_date` is NOT optional here -- isTokenExpiring()
// returns false when it is absent, so omitting it would pin the very first token
// forever and every call would 401 an hour later. JWT.getAccessToken() caches and
// re-signs on its own, so calling it per request is cheap after the first.
OAuth2Client.prototype.refreshHandler = async () => {
  const { token } = await jwt.getAccessToken()
  if (!token) throw new Error('service account returned no access token')
  if (!minted) {
    minted = true
    process.stderr.write(`${TAG} domain-wide delegation OK; acting as ${subject}\n`)
  }
  return {
    access_token: token,
    // Fall back to a conservative lifetime if the library did not record one.
    expiry_date: jwt.credentials.expiry_date ?? Date.now() + 55 * 60 * 1000,
  }
}

// --- neutralize the package's OAuth file inputs -----------------------------

// loadCredentials() exits(1) unless GMAIL_OAUTH_PATH holds an installed/web keys
// file, but in this mode the client_id/secret it reads are never used: our
// refreshHandler short-circuits every path that would call the token endpoint.
// We therefore point it at an inert placeholder instead of the real OAuth keys,
// so this server keeps working after those keys are rotated or removed.
const placeholder = path.join(HERE, 'gmail-sa', 'inert-oauth-keys.json')
if (!existsSync(placeholder)) {
  writeFileSync(
    placeholder,
    JSON.stringify(
      {
        _comment:
          'Inert placeholder. Satisfies @gongrzhe/server-gmail-autoauth-mcp startup validation; ' +
          'these values are never used because gmail-sa-launch.mjs supplies a service-account refreshHandler.',
        installed: {
          client_id: 'unused.apps.googleusercontent.com',
          client_secret: 'unused',
          redirect_uris: ['http://localhost'],
        },
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  )
}
process.env.GMAIL_OAUTH_PATH = placeholder
// Must NOT exist: any file here would be setCredentials()'d over our handler's
// results. A stale OAuth token is exactly what this migration removes.
process.env.GMAIL_CREDENTIALS_PATH = path.join(HERE, 'gmail-sa', 'no-oauth-credentials.json')

process.stderr.write(
  `${TAG} up; auth=service-account subject=${subject} sa=${sa.client_email} scopes=${SCOPES.length}\n`,
)

// Start the unmodified server in this process, now that the prototype is patched.
await import(pathToFileURL(serverEntry).href)
