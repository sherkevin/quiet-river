#!/usr/bin/env python3
"""Consistent local recovery point; credentials stay inside a root-only directory."""
import datetime
import json
import os
import pathlib
import shutil
import sqlite3
import subprocess
import time
import urllib.request

BASE=pathlib.Path('/var/lib/quiet-river-platform')
CONTAINER='quiet-river-platform-karakeep-1'

def run(args, **kwargs):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, **kwargs)

def main():
    if os.geteuid()!=0: raise SystemExit('Administrator required')
    os.umask(0o077)
    stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    dest=pathlib.Path('/var/backups/quiet-river/platform-'+stamp)
    dest.mkdir(mode=0o700)
    bridge=subprocess.run(['systemctl','is-active','--quiet','quiet-river-bridge']).returncode==0
    reader=json.loads(run(['docker','inspect','--format','{{json .State.Running}}',CONTAINER]).stdout)
    try:
        if bridge: run(['systemctl','stop','quiet-river-bridge'])
        if reader: run(['docker','stop','--time','30',CONTAINER])
        with (dest/'miniflux.dump').open('wb') as stream:
            subprocess.run(['runuser','-u','postgres','--','pg_dump','-Fc','qr_miniflux'],
                           check=True,stdout=stream,stderr=subprocess.PIPE)
        for name in ('bridge','karakeep'):
            shutil.copytree(BASE/name,dest/name,copy_function=shutil.copy2)
        shutil.copytree('/etc/quiet-river-platform',dest/'private-config')
        shutil.copy2('/etc/caddy/Caddyfile',dest/'Caddyfile')
        result={}
        for name,relative in [('bridge','bridge/bridge.sqlite'),('reader','karakeep/db.db')]:
            connection=sqlite3.connect(str(dest/relative))
            result[name]=connection.execute('PRAGMA quick_check').fetchone()[0]
            connection.close()
            if result[name]!='ok': raise RuntimeError(name+' backup integrity failure')
        run(['pg_restore','--list',str(dest/'miniflux.dump')])
        result['postgres_archive']='readable'
        result['release']=os.path.realpath('/opt/quiet-river-platform/current').split('/')[-1]
        result['off_host_restore_tested']=False
        (dest/'manifest.json').write_text(json.dumps(result,indent=2)+'\n')
        print('Created and validated private recovery point:',dest)
    finally:
        if reader: run(['docker','start',CONTAINER])
        if bridge: run(['systemctl','start','quiet-river-bridge'])
    print('Previous service activity restored; no credentials displayed')

if __name__=='__main__':
    try: main()
    except Exception as error:
        print('Backup failed:',type(error).__name__)
        raise SystemExit(1)
