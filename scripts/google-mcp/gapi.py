#!/usr/bin/env python3
"""Minimal Google API caller reusing the fleet's stored OAuth tokens.

Stdlib-only (fleet-helper rule: no pip deps). Refreshes the access token from
the refresh_token in the given token file and performs a GET/POST against the
Drive or Gmail REST API. Secrets never go to stdout -- only API responses.

Usage:
  gapi.py <token-file> GET  <url>
  gapi.py <token-file> POST <url> <json-body>

Token file: one of ~/.gmail-mcp/{drive,cred}-{zenom,personal}.json
"""
import json
import sys
import urllib.request
import urllib.parse

KEYS = json.load(open('/home/szabgabor/.gmail-mcp/gcp-oauth.keys.json'))['installed']


def fresh_access_token(token_path: str) -> str:
    tok = json.load(open(token_path))
    # Flat legacy format: {"refresh_token": "..."}
    # v2 format (google-drive-mcp's own store): {"accounts": {"default": {"refreshToken": "..."}}}
    refresh_token = tok.get('refresh_token')
    if refresh_token is None:
        accounts = tok.get('accounts', {})
        default = accounts.get(tok.get('defaultAccount', 'default'), {})
        refresh_token = default.get('refreshToken')
    body = urllib.parse.urlencode({
        'client_id': KEYS['client_id'],
        'client_secret': KEYS['client_secret'],
        'refresh_token': refresh_token,
        'grant_type': 'refresh_token',
    }).encode()
    req = urllib.request.Request(KEYS['token_uri'], data=body, method='POST')
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)['access_token']


def call(token_path: str, method: str, url: str, body: str | None = None) -> str:
    at = fresh_access_token(token_path)
    data = body.encode() if body else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={'Authorization': f'Bearer {at}',
                                          'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode()


if __name__ == '__main__':
    token_file, method, url = sys.argv[1], sys.argv[2], sys.argv[3]
    body = sys.argv[4] if len(sys.argv) > 4 else None
    try:
        print(call(token_file, method, url, body))
    except urllib.error.HTTPError as e:
        print(f'HTTP {e.code}: {e.read().decode()[:500]}', file=sys.stderr)
        sys.exit(1)
