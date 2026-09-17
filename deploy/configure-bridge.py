#!/usr/bin/env python3
"""Create the Miniflux API key locally; configure Bridge without displaying secrets."""
import base64, json, os, pathlib, urllib.request
root=pathlib.Path('/etc/quiet-river-platform')
settings=json.loads((root/'bootstrap.json').read_text())
file=root/'bridge.env'
if file.exists(): raise SystemExit('bridge.env exists; refusing to overwrite runtime configuration')
request=urllib.request.Request('http://127.0.0.1:3061/v1/api-keys',
    data=json.dumps({'description':'Quiet River Bridge'}).encode(),method='POST',
    headers={'Content-Type':'application/json','Authorization':'Basic '+base64.b64encode(('reader:'+settings['miniflux_password']).encode()).decode()})
result=json.load(urllib.request.urlopen(request,timeout=20))
token=result.get('api_key') or result.get('token')
if not token: raise SystemExit('API-key response did not contain expected key; no configuration written')
legacy={}
for line in pathlib.Path('/etc/quiet-river/env').read_text().splitlines():
    if '=' in line and not line.startswith('#'):
        k,v=line.split('=',1);legacy[k]=v.strip('"\'')
if not legacy.get('QR_ACCESS_TOKEN'): raise SystemExit('Existing application access token is required')
text='\n'.join(['QR_ACCESS_TOKEN='+legacy['QR_ACCESS_TOKEN'],'MINIFLUX_URL=http://127.0.0.1:3061','MINIFLUX_TOKEN='+token,
    'KARAKEEP_URL=http://127.0.0.1:3062','KARAKEEP_TOKEN=','BRIDGE_PORT=4380','BRIDGE_HOST=127.0.0.1',
    'BRIDGE_DATA_DIR=/var/lib/quiet-river-platform/bridge','BRIDGE_MANIFEST=/opt/quiet-river-platform/current/data/subscriptions.json',''])
fd=os.open(file,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,'w') as stream:stream.write(text)
print('Bridge local API authorization configured; secret values were not displayed')
