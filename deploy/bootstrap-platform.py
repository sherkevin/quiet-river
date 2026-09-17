#!/usr/bin/env python3
"""Local-only initialization; never prints credentials and never changes cloud resources.
Run as root after Ubuntu PostgreSQL and the pinned official images have been installed.
The default container setup uses the native PostgreSQL UNIX socket, not a public DB port.
"""
import json, os, pathlib, secrets, subprocess, urllib.parse

ROOT = pathlib.Path('/etc/quiet-river-platform')
DATA = pathlib.Path('/var/lib/quiet-river-platform')
def run(argv, data=None):
    return subprocess.run(argv, input=data, text=True, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout

def secure_write(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        stream.write(value)

def main():
    if os.geteuid() != 0:
        raise SystemExit('Administrator required for first-time setup')
    ROOT.mkdir(mode=0o700, exist_ok=True)
    DATA.mkdir(mode=0o755, exist_ok=True)
    for name in ('bridge', 'karakeep'):
        (DATA/name).mkdir(mode=0o700, exist_ok=True)
    secret_file = ROOT/'bootstrap.json'
    if secret_file.exists():
        settings = json.loads(secret_file.read_text())
    else:
        settings = {k:secrets.token_hex(24) for k in ('database_password','miniflux_password','nextauth_secret')}
        secure_write(secret_file, json.dumps(settings)+'\n')
    # Newly allocated database only. No ALTER SYSTEM or changes to other databases.
    role = run(['runuser','-u','postgres','--','psql','-tAc',"SELECT 1 FROM pg_roles WHERE rolname='qr_miniflux'"]).strip()
    if not role:
        run(['runuser','-u','postgres','--','psql','-v','ON_ERROR_STOP=1'],
            "CREATE ROLE qr_miniflux LOGIN CONNECTION LIMIT 12 PASSWORD '%s';\n" % settings['database_password'])
    db = run(['runuser','-u','postgres','--','psql','-tAc',"SELECT 1 FROM pg_database WHERE datname='qr_miniflux'"]).strip()
    if not db:
        run(['runuser','-u','postgres','--','createdb','-O','qr_miniflux','qr_miniflux'])
    hba = pathlib.Path(run(['runuser','-u','postgres','--','psql','-tAc','SHOW hba_file']).strip())
    rule = 'local qr_miniflux qr_miniflux scram-sha-256'
    text = hba.read_text()
    if rule not in text:
        backup = hba.with_suffix(hba.suffix+'.before-quiet-river')
        if not backup.exists(): backup.write_text(text); backup.chmod(0o600)
        hba.write_text(rule+'\n'+text)
        run(['runuser','-u','postgres','--','psql','-c','SELECT pg_reload_conf()'])
    mf = ROOT/'miniflux.env'
    if not mf.exists():
        secure_write(mf, '\n'.join([
            'DATABASE_URL=postgres://qr_miniflux:'+settings['database_password']+'@localhost/qr_miniflux?host=/var/run/postgresql&sslmode=disable',
            'LISTEN_ADDR=0.0.0.0:8080','RUN_MIGRATIONS=1','CREATE_ADMIN=1','ADMIN_USERNAME=reader',
            'ADMIN_PASSWORD='+settings['miniflux_password'],'FETCHER_ALLOW_PRIVATE_NETWORKS=false',
            'DISABLE_SCHEDULER_SERVICE=true','WORKER_POOL_SIZE=1','POLLING_LIMIT_PER_HOST=1',
            'CLEANUP_ARCHIVE_READ_DAYS=-1','CLEANUP_ARCHIVE_UNREAD_DAYS=-1','MEDIA_PROXY_MODE=none',
            'HTTP_CLIENT_TIMEOUT=25','LOG_LEVEL=warning','']) )
    kk = ROOT/'karakeep.env'
    if not kk.exists():
        secure_write(kk,'\n'.join([
            'DATA_DIR=/data','NEXTAUTH_SECRET='+settings['nextauth_secret'],
            'NEXTAUTH_URL='+os.environ.get('READER_PUBLIC_ORIGIN','http://127.0.0.1:3062'),
            'DISABLE_SIGNUPS=false','DISABLE_NEW_RELEASE_CHECK=true','DB_WAL_MODE=true',
            'INFERENCE_ENABLE_AUTO_TAGGING=false','INFERENCE_ENABLE_AUTO_SUMMARIZATION=false',
            'EMBEDDING_ENABLE_AUTO_INDEXING=false','SEMANTIC_SEARCH_ENABLED=false',
            'CRAWLER_NUM_WORKERS=1','CRAWLER_STORE_SCREENSHOT=false','CRAWLER_STORE_PDF=false',
            'CRAWLER_VIDEO_DOWNLOAD=false','OCR_ENABLED=false','']))
    print('Isolated database and private configuration initialized. No credential values printed.')

if __name__=='__main__': main()
