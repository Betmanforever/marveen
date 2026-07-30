#!/usr/bin/env python3
"""Recursively list a personal-Drive folder tree using gapi.py. Stdlib only."""
import json
import subprocess
import sys
import urllib.parse

TOKEN = sys.argv[1]
ROOT = sys.argv[2]
GAPI = '/home/szabgabor/marveen/scripts/google-mcp/gapi.py'


def ls(folder_id):
    q = urllib.parse.quote(f"'{folder_id}' in parents and trashed=false")
    url = (f'https://www.googleapis.com/drive/v3/files?q={q}'
           '&fields=files(id,name,mimeType,size,modifiedTime)&pageSize=200')
    out = subprocess.run(['python3', GAPI, TOKEN, 'GET', url],
                         capture_output=True, text=True, check=True).stdout
    return json.loads(out)['files']


def walk(folder_id, prefix=''):
    for f in sorted(ls(folder_id), key=lambda x: (x['mimeType'] != 'application/vnd.google-apps.folder', x['name'])):
        is_dir = f['mimeType'] == 'application/vnd.google-apps.folder'
        size = f.get('size', '-')
        print(f"{prefix}{f['name']}\t{f['mimeType']}\t{size}\t{f['id']}")
        if is_dir:
            walk(f['id'], prefix + '  ')


walk(ROOT)
