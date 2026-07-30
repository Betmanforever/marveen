#!/usr/bin/env node
// Mint a short-lived Drive access token from the fleet service account via
// domain-wide delegation, impersonating the SAME subject the (working)
// drive-zenom MCP uses. Exists because the OAuth refresh-token file the
// nightly backup used to upload with (drive-zenom.json / drive-personal.json)
// is either identity-mismatched for the zenom target folder (404, card
// 139f8f1c) or invalid_grant-expired -- while the SA+DWD path is proven live
// daily by the drive-zenom MCP (same key file, same subject, drive scope).
//
// Output contract: the access token on stdout, NOTHING else. Callers capture
// the pipe (never logged, never on a command line). Same runtime as
// admin-directory-probe.mjs: the gmail-sa/node_modules google-auth-library.
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const requireFromRuntime = createRequire(path.join(HERE, 'gmail-sa', 'package.json'))
const { JWT } = requireFromRuntime('google-auth-library')

const KEY_FILE = '/home/szabgabor/.gmail-mcp/zenom-fleet-access-502008-0fd02f7f502f.json'
// Mirrors .mcp.json drive-zenom GOOGLE_DRIVE_MCP_SUBJECT -- the identity that
// verifiably reaches the "Marveen Backups" folder (mr-wolfe upload, 2026-07-30).
const SUBJECT = process.env.SA_DRIVE_SUBJECT || 'gabor.szabo@zenom.hu'
const SCOPES = ['https://www.googleapis.com/auth/drive']

const sa = JSON.parse(readFileSync(KEY_FILE, 'utf-8'))
const jwt = new JWT({ email: sa.client_email, key: sa.private_key, scopes: SCOPES, subject: SUBJECT })
const { token } = await jwt.getAccessToken()
if (!token) {
  console.error('sa-drive-token: no token returned')
  process.exit(1)
}
process.stdout.write(token)
