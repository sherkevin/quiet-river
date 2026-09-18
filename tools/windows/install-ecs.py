#!/usr/bin/env python3
"""Install restricted SSH ingestion, not an interactive administrative login."""
import grp
import os
import pathlib
import pwd
import re
import secrets
import shutil
import subprocess
import sys


def read_public_key(filename):
    key = pathlib.Path(filename).read_text().strip()
    if not re.fullmatch(r'ssh-ed25519 [A-Za-z0-9+/=]+(?: [^\r\n]*)?', key):
        raise SystemExit('Expected one Ed25519 public key; private keys are never accepted')
    return key


def main():
    if os.geteuid() != 0 or len(sys.argv) not in (2, 3):
        raise SystemExit('Run as administrator with collector PUBLIC key and optional proxy PUBLIC key')
    key = read_public_key(sys.argv[1])
    proxy_key = read_public_key(sys.argv[2]) if len(sys.argv) == 3 else None
    name = 'qr-collector'
    try:
        pwd.getpwnam(name)
    except KeyError:
        subprocess.run(['useradd', '--system', '--create-home', '--shell', '/bin/sh', name], check=True)
    gid = grp.getgrnam(name).gr_gid
    config = pathlib.Path('/etc/quiet-river-collector')
    config.mkdir(mode=0o750, exist_ok=True)
    os.chown(config, 0, gid)
    env = config / 'agent.env'
    if not env.exists():
        fd = os.open(env, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o640)
        with os.fdopen(fd, 'w') as out:
            out.write('QR_COLLECTOR_TOKEN=' + secrets.token_hex(32) + '\n')
            out.write('QR_DESKTOP_PLATFORMS=zhihu,xiaohongshu,bilibili\n')
    os.chown(env, 0, gid)
    env.chmod(0o640)
    target = pathlib.Path('/usr/local/lib/quiet-river-collector')
    target.mkdir(parents=True, exist_ok=True, mode=0o755)
    shutil.copyfile(pathlib.Path(__file__).with_name('collector-gateway.py'), target / 'gateway.py')
    (target / 'gateway.py').chmod(0o644)
    home = pathlib.Path(pwd.getpwnam(name).pw_dir)
    auth = home / '.ssh'
    auth.mkdir(exist_ok=True, mode=0o755)
    os.chown(auth, 0, 0)
    entry = 'restrict,command="/usr/bin/python3 /usr/local/lib/quiet-river-collector/gateway.py" ' + key
    keys = auth / 'authorized_keys'
    old = keys.read_text().splitlines() if keys.exists() else []
    if entry not in old:
        keys.write_text('\n'.join(old + [entry]) + '\n')
    os.chown(keys, 0, 0)
    keys.chmod(0o644)
    unit = pathlib.Path('/etc/systemd/system/quiet-river-bridge.service.d')
    unit.mkdir(exist_ok=True)
    (unit / 'collector.conf').write_text('[Service]\nEnvironmentFile=/etc/quiet-river-collector/agent.env\n')
    if proxy_key:
        proxy_name = 'qr-proxy-tunnel'
        try:
            pwd.getpwnam(proxy_name)
        except KeyError:
            subprocess.run(['useradd', '--system', '--create-home', '--shell', '/bin/sh', proxy_name], check=True)
        proxy_home = pathlib.Path(pwd.getpwnam(proxy_name).pw_dir)
        proxy_auth = proxy_home / '.ssh'
        proxy_auth.mkdir(exist_ok=True, mode=0o700)
        proxy_entry = 'restrict,port-forwarding,permitopen="127.0.0.1:9",permitlisten="127.0.0.1:17890" ' + proxy_key
        proxy_keys = proxy_auth / 'authorized_keys'
        proxy_keys.write_text(proxy_entry + '\n')
        os.chown(proxy_auth, 0, 0); os.chown(proxy_keys, 0, 0)
        proxy_auth.chmod(0o755); proxy_keys.chmod(0o644)
        deploy = pathlib.Path(__file__).resolve().parents[2] / 'deploy'
        for filename in ('quiet-river-proxy-bridge.socket', 'quiet-river-proxy-bridge.service'):
            shutil.copyfile(deploy / filename, pathlib.Path('/etc/systemd/system') / filename)
    subprocess.run(['systemctl', 'daemon-reload'], check=True)
    print('Restricted collector account configured. No shell, general forwarding, or cloud keys granted.')
    print('Proxy tunnel identity configured only when its separate PUBLIC key was supplied.')
    print('Environment written locally; restart occurs only with the tested application release.')

if __name__ == '__main__':
    main()
