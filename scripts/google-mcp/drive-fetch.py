#!/usr/bin/env python3
"""Batch-download Drive files (binary-safe) with the fleet's stored OAuth tokens.

Stdlib only. Reads a manifest of lines: <file_id>\t<kind>\t<out_path>
  kind: media   -> files/{id}?alt=media (regular files)
        doc     -> export text/markdown (Google Docs; falls back to text/plain)
        sheet   -> export xlsx (Google Sheets)

Usage: drive-fetch.py <token-file> <manifest.tsv>
"""
import sys
import os
import json
import urllib.request
import urllib.parse
import urllib.error

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gapi import fresh_access_token  # noqa: E402

TOKEN_PATH, MANIFEST = sys.argv[1], sys.argv[2]
AT = fresh_access_token(TOKEN_PATH)


def fetch(url, out_path):
    req = urllib.request.Request(url, headers={'Authorization': f'Bearer {AT}'})
    with urllib.request.urlopen(req, timeout=120) as r, open(out_path, 'wb') as f:
        while chunk := r.read(1 << 16):
            f.write(chunk)


ok = fail = 0
for line in open(MANIFEST):
    line = line.strip()
    if not line or line.startswith('#'):
        continue
    fid, kind, out = line.split('\t')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    base = f'https://www.googleapis.com/drive/v3/files/{fid}'
    if kind == 'media':
        urls = [f'{base}?alt=media']
    elif kind == 'doc':
        urls = [f'{base}/export?mimeType={urllib.parse.quote("text/markdown")}',
                f'{base}/export?mimeType={urllib.parse.quote("text/plain")}']
    elif kind == 'sheet':
        urls = [f'{base}/export?mimeType={urllib.parse.quote("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}']
    else:
        print(f'SKIP unknown kind {kind}: {out}')
        continue
    for i, url in enumerate(urls):
        try:
            fetch(url, out)
            ok += 1
            print(f'OK  {out} ({os.path.getsize(out)} B)')
            break
        except urllib.error.HTTPError as e:
            if i == len(urls) - 1:
                fail += 1
                print(f'ERR {out}: HTTP {e.code}')
print(f'\n{ok} ok, {fail} failed')
