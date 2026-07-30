#!/usr/bin/env python3
"""Batch-upload local files to Drive, preserving a folder tree.

Stdlib only. Usage: drive-upload.py <token-file> <local-dir> <parent-folder-id>
Mirrors <local-dir>'s subfolders under the parent (creates folders as needed),
uploads every file. A file is skipped only if it already exists by (name,
parent) AND its remote size matches the local size exactly -- a size mismatch
is treated as a stale/partial remote copy and re-uploaded, so a name collision
can never produce a silent, zero-byte "success".

Shared Drive parents work the same as My Drive parents (supportsAllDrives is
sent on every files.list/files.create call) -- no separate flag needed.

Files above RESUMABLE_THRESHOLD use the resumable upload protocol (chunked
PUT to a session URI) instead of a single multipart POST, per Google's
guidance that multipart is for small files; resumable is required reading
Content-Length-first behaviour for anything past a few MB.
"""
import json
import mimetypes
import os
import sys
import urllib.parse
import urllib.request
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gapi import fresh_access_token  # noqa: E402

TOKEN_PATH, LOCAL_DIR, PARENT_ID = sys.argv[1], sys.argv[2], sys.argv[3]
AT = fresh_access_token(TOKEN_PATH)
HDR = {'Authorization': f'Bearer {AT}'}
RESUMABLE_THRESHOLD = 4 * 1024 * 1024  # Google's multipart guidance tops out well under this
CHUNK_SIZE = 8 * 1024 * 1024


def api(method, url, body=None, headers=None, want_headers=False):
    data = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode()
    h = dict(HDR)
    if headers:
        h.update(headers)
    elif body is not None:
        h['Content-Type'] = 'application/json'
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    with urllib.request.urlopen(req, timeout=120) as r:
        if want_headers:
            return r.headers, (json.load(r) if r.length != 0 else {})
        return json.load(r) if r.length != 0 else {}


def with_drive_flags(url):
    sep = '&' if '?' in url else '?'
    return f'{url}{sep}supportsAllDrives=true'


def find_child(parent_id, name, mime=None):
    q = f"'{parent_id}' in parents and name = '{name.replace(chr(39), chr(92)+chr(39))}' and trashed=false"
    if mime:
        q += f" and mimeType = '{mime}'"
    url = with_drive_flags(
        f'https://www.googleapis.com/drive/v3/files?q={urllib.parse.quote(q)}'
        '&fields=files(id,size)&includeItemsFromAllDrives=true&supportsAllDrives=true')
    files = api('GET', url)['files']
    return files[0] if files else None


def ensure_folder(parent_id, name):
    existing = find_child(parent_id, name, 'application/vnd.google-apps.folder')
    if existing:
        return existing['id']
    r = api('POST', with_drive_flags('https://www.googleapis.com/drive/v3/files'),
            {'name': name, 'mimeType': 'application/vnd.google-apps.folder', 'parents': [parent_id]})
    return r['id']


def upload_multipart(parent_id, name, mime, content):
    boundary = uuid.uuid4().hex
    meta = json.dumps({'name': name, 'parents': [parent_id]}).encode()
    body = (f'--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'.encode()
            + meta
            + f'\r\n--{boundary}\r\nContent-Type: {mime}\r\n\r\n'.encode()
            + content + f'\r\n--{boundary}--'.encode())
    api('POST', with_drive_flags(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart'),
        body, {'Content-Type': f'multipart/related; boundary={boundary}'})


def upload_resumable(parent_id, name, mime, path, total_size):
    meta = json.dumps({'name': name, 'parents': [parent_id]}).encode()
    init_headers, _ = api(
        'POST', with_drive_flags(
            'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,size'),
        meta, {'Content-Type': 'application/json; charset=UTF-8',
               'X-Upload-Content-Type': mime, 'X-Upload-Content-Length': str(total_size)},
        want_headers=True)
    session_uri = init_headers.get('Location')
    if not session_uri:
        raise RuntimeError(f'resumable upload init for {name} returned no Location header')
    final_resource = None
    with open(path, 'rb') as f:
        sent = 0
        while sent < total_size:
            chunk = f.read(CHUNK_SIZE)
            start, end = sent, sent + len(chunk) - 1
            req = urllib.request.Request(
                session_uri, data=chunk, method='PUT',
                headers={'Content-Length': str(len(chunk)),
                         'Content-Range': f'bytes {start}-{end}/{total_size}'})
            try:
                with urllib.request.urlopen(req, timeout=120) as r:
                    # A 2xx here means Drive committed the file -- capture the
                    # returned resource so the caller can verify its size. A
                    # swallowed 308 on what we *thought* was the last chunk
                    # would otherwise report success on a truncated upload.
                    final_resource = json.load(r) if r.length != 0 else {}
            except urllib.error.HTTPError as e:
                if e.code != 308:  # 308 Resume Incomplete = expected between chunks
                    raise
            sent += len(chunk)
    if final_resource is None or int(final_resource.get('size', -1)) != total_size:
        raise RuntimeError(
            f'{name}: resumable upload finished sending {total_size} B but Drive never '
            f'returned a committed file resource with a matching size (got {final_resource!r}) '
            '-- treating as a truncated/uncommitted upload, not a success.')


def upload(parent_id, path):
    name = os.path.basename(path)
    local_size = os.path.getsize(path)
    existing = find_child(parent_id, name)
    if existing:
        remote_size = int(existing.get('size', -1))
        if remote_size == local_size:
            print(f'skip (exists, size-verified {local_size} B)  {name}')
            return
        raise RuntimeError(
            f'{name}: a file with this (name, parent) already exists in Drive but its size '
            f'({remote_size} B) does not match the local file ({local_size} B) -- refusing to '
            'silently skip a possibly-stale/partial remote copy. Resolve manually (rename the '
            'local file, or delete the stale remote copy) before re-running.')
    mime = mimetypes.guess_type(path)[0] or 'application/octet-stream'
    if local_size > RESUMABLE_THRESHOLD:
        upload_resumable(parent_id, name, mime, path, local_size)
    else:
        with open(path, 'rb') as f:
            upload_multipart(parent_id, name, mime, f.read())
    print(f'up   {local_size:>9} B  {name}')


count = 0
uploaded_bytes = 0
for root, dirs, files in sorted(os.walk(LOCAL_DIR)):
    dirs.sort()
    rel = os.path.relpath(root, LOCAL_DIR)
    parent = PARENT_ID
    if rel != '.':
        for part in rel.split(os.sep):
            parent = ensure_folder(parent, part)
    for fname in sorted(files):
        path = os.path.join(root, fname)
        upload(parent, path)
        uploaded_bytes += os.path.getsize(path)
        count += 1
print(f'\n{count} files processed, {uploaded_bytes} B verified present in Drive (uploaded or size-matched)')
