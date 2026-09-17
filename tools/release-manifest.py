#!/usr/bin/env python3
"""Verify a git archive against its exact commit; emit no runtime secrets."""
import argparse
import datetime
import hashlib
import json
import pathlib
import subprocess


def git(repo, *args):
    return subprocess.check_output(['git', '-C', str(repo), *args])


def snapshot(repo, root, revision):
    commit = git(repo, 'rev-parse', revision + '^{commit}').decode().strip()
    tree = git(repo, 'rev-parse', commit + '^{tree}').decode().strip()
    records = git(repo, 'ls-tree', '-rz', commit).split(b'\0')
    files = []
    for record in filter(None, records):
        meta, name_bytes = record.split(b'\t', 1)
        mode, kind, expected = meta.split()
        name = name_bytes.decode('utf-8')
        path = root / name
        if kind != b'blob' or mode not in (b'100644', b'100755'):
            raise ValueError('Unsupported archive entry: ' + name)
        if path.is_symlink() or not path.is_file():
            raise ValueError('Missing/non-regular release file: ' + name)
        data = path.read_bytes()
        actual = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
        if actual != expected.decode():
            raise ValueError('Release content differs from commit: ' + name)
        if bool(path.stat().st_mode & 0o111) != (mode == b'100755'):
            raise ValueError('Release executable mode differs: ' + name)
        files.append({'path': name, 'sha256': hashlib.sha256(data).hexdigest(),
                      'git_blob': actual, 'mode': mode.decode(), 'bytes': len(data)})
    return {'schema': 1, 'commit': commit, 'tree': tree,
            'verified_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'tracked_file_count': len(files), 'files': files}


def bind_test_report(manifest, report_path):
    report = json.loads(report_path.read_text())
    if report.get('commit') != manifest['commit'] or report.get('tree') != manifest['tree']:
        raise ValueError('Test evidence belongs to a different commit/tree')
    counts = report.get('counts', {})
    if report.get('exit_code') != 0 or counts.get('tests', 0) < 1:
        raise ValueError('No successful test run in evidence')
    if counts.get('fail', -1) != 0 or counts.get('pass') != counts.get('tests'):
        raise ValueError('Failed or skipped tests cannot satisfy this release gate')
    log = report_path.with_name('tests.tap')
    if hashlib.sha256(log.read_bytes()).hexdigest() != report.get('log_sha256'):
        raise ValueError('Test log hash mismatch')
    manifest['test_evidence'] = report
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', required=True, type=pathlib.Path)
    parser.add_argument('--root', required=True, type=pathlib.Path)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--test-evidence', type=pathlib.Path)
    parser.add_argument('--output', type=pathlib.Path)
    args = parser.parse_args()
    try:
        result = snapshot(args.repo.resolve(), args.root.resolve(), args.commit)
        if args.test_evidence:
            bind_test_report(result, args.test_evidence)
        encoded = json.dumps(result, ensure_ascii=False, indent=2) + '\n'
        if args.output:
            if args.output.exists():
                raise ValueError('Refusing to overwrite an existing manifest')
            args.output.write_text(encoded)
            print('Verified', result['tracked_file_count'], 'files at', result['commit'])
        else:
            print(encoded, end='')
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, 'Release verification failed: ' + str(error) + '\n')


if __name__ == '__main__':
    main()
