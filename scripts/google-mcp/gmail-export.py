#!/usr/bin/env python3
"""Export Gmail messages matching a query into per-thread markdown files.

Stdlib only. Usage: gmail-export.py <token-file> <query> <out-dir>
"""
import base64
import json
import os
import re
import sys
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gapi import fresh_access_token  # noqa: E402

TOKEN_PATH, QUERY, OUT_DIR = sys.argv[1], sys.argv[2], sys.argv[3]
AT = fresh_access_token(TOKEN_PATH)
os.makedirs(OUT_DIR, exist_ok=True)


def get(url):
    req = urllib.request.Request(url, headers={'Authorization': f'Bearer {AT}'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def list_all(query):
    ids, token = [], None
    while True:
        url = (f'https://gmail.googleapis.com/gmail/v1/users/me/messages'
               f'?q={urllib.parse.quote(query)}&maxResults=100')
        if token:
            url += f'&pageToken={token}'
        d = get(url)
        ids += d.get('messages', [])
        token = d.get('nextPageToken')
        if not token:
            return ids


def body_text(payload):
    """Prefer text/plain parts; fall back to stripped text/html."""
    plain, html = [], []
    def walk(p):
        mt = p.get('mimeType', '')
        data = p.get('body', {}).get('data')
        if data:
            txt = base64.urlsafe_b64decode(data + '===').decode('utf-8', 'replace')
            (plain if mt == 'text/plain' else html if mt == 'text/html' else []).append(txt)
        for sub in p.get('parts', []):
            walk(sub)
    walk(payload)
    if plain:
        return '\n'.join(plain)
    if html:
        return re.sub(r'\s{3,}', '\n', re.sub(r'<[^>]+>', ' ', '\n'.join(html)))
    return '(no text body)'


threads = {}
ids = list_all(QUERY)
print(f'{len(ids)} messages', file=sys.stderr)
for i, m in enumerate(ids):
    msg = get(f'https://gmail.googleapis.com/gmail/v1/users/me/messages/{m["id"]}?format=full')
    h = {x['name'].lower(): x['value'] for x in msg['payload'].get('headers', [])}
    threads.setdefault(msg['threadId'], []).append({
        'date': h.get('date', ''), 'from': h.get('from', ''), 'to': h.get('to', ''),
        'subject': h.get('subject', '(no subject)'),
        'internal': int(msg.get('internalDate', 0)),
        'body': body_text(msg['payload']).strip(),
        'attachments': [p.get('filename') for p in msg['payload'].get('parts', []) if p.get('filename')],
    })
    if (i + 1) % 25 == 0:
        print(f'  {i + 1}/{len(ids)}', file=sys.stderr)

for tid, msgs in threads.items():
    msgs.sort(key=lambda x: x['internal'])
    slug = re.sub(r'[^a-z0-9]+', '-', msgs[0]['subject'].lower())[:60].strip('-') or 'thread'
    stamp = msgs[0]['date'][:16].replace(',', '').replace(' ', '-')
    path = os.path.join(OUT_DIR, f'{slug}--{tid[:8]}.md')
    with open(path, 'w') as f:
        f.write(f"# {msgs[0]['subject']}\n\nThread {tid}, {len(msgs)} messages\n\n")
        for m in msgs:
            f.write(f"---\n\n**From:** {m['from']}  \n**To:** {m['to']}  \n"
                    f"**Date:** {m['date']}  \n**Subject:** {m['subject']}\n")
            if m['attachments']:
                f.write(f"**Attachments:** {', '.join(m['attachments'])}\n")
            f.write(f"\n{m['body']}\n\n")
print(f'{len(threads)} threads written to {OUT_DIR}')
