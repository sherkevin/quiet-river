#!/usr/bin/env python3
"""Initialize a private Karakeep identity through v0.33.2 APIs, never direct DB writes."""
import json
import os
import pathlib
import urllib.request
import urllib.error

ROOT = pathlib.Path('/etc/quiet-river-platform')
BASE = 'http://127.0.0.1:3062'

def load_env(path):
    return dict(line.split('=', 1) for line in path.read_text().splitlines()
                if '=' in line and not line.startswith('#'))

def trpc(method, payload):
    request = urllib.request.Request(BASE + '/api/trpc/' + method,
        data=json.dumps({'json': payload}).encode(),
        headers={'Content-Type': 'application/json'}, method='POST')
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)['result']['data']['json']
    except urllib.error.HTTPError as error:
        # Do not print response bodies: successful exchange responses contain tokens.
        raise RuntimeError(f'{method}: HTTP {error.code}') from None

def atomic_private(path, text):
    temporary = path.with_name(path.name + '.new')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream: stream.write(text)
    os.replace(temporary, path)

def main():
    if os.geteuid() != 0: raise SystemExit('Administrator required for local setup')
    env_path = ROOT / 'bridge.env'
    config = load_env(env_path)
    if config.get('KARAKEEP_TOKEN'):
        print('Reader API already configured; no change made')
        return
    email = 'reader@quiet-river.local'
    password = config['QR_ACCESS_TOKEN']
    if not 8 <= len(password) <= 100:
        raise SystemExit('Existing access password is incompatible; no changes made')
    credentials = {'email': email, 'password': password,
                   'keyName': 'Quiet River Bridge',
                   'scopes': ['bookmarks:readwrite', 'assets:readwrite',
                              'highlights:readwrite', 'users:read', 'tags:read']}
    try:
        result = trpc('apiKeys.exchange', credentials)
    except RuntimeError as error:
        if 'HTTP 401' not in str(error): raise
        trpc('users.create', {'name': 'Quiet River', 'email': email,
             'password': password, 'confirmPassword': password})
        result = trpc('apiKeys.exchange', credentials)
    key = result.get('key')
    if not key: raise SystemExit('Missing API key in response; configuration unchanged')
    request = urllib.request.Request(BASE + '/api/v1/highlights?limit=1',
                                   headers={'Authorization': 'Bearer ' + key})
    with urllib.request.urlopen(request, timeout=20) as response:
        assert response.status == 200
    config['KARAKEEP_TOKEN'] = key
    atomic_private(env_path, ''.join(k + '=' + v + '\n' for k, v in config.items()))
    settings = load_env(ROOT / 'karakeep.env')
    settings['DISABLE_SIGNUPS'] = 'true'
    atomic_private(ROOT / 'karakeep.env', ''.join(k + '=' + v + '\n' for k, v in settings.items()))
    print('Reader identity and scoped API access configured; highlights HTTP 200')
    print('Local reader login: reader@quiet-river.local; password is existing site access password')
    print('Signup disabled in configuration; restart only the new reader container to apply')

if __name__ == '__main__':
    try: main()
    except Exception as error:
        print('Reader setup did not complete:', type(error).__name__, str(error))
        raise SystemExit(1)
