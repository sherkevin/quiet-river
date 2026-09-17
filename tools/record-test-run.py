#!/usr/bin/env python3
"""Run serial Node tests on a clean commit and bind results to the exact tree."""
import argparse
import datetime
import hashlib
import json
import pathlib
import re
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=pathlib.Path, default=pathlib.Path.cwd())
    parser.add_argument('--node', default='node')
    parser.add_argument('--output-dir', required=True, type=pathlib.Path)
    args = parser.parse_args()
    repo = args.repo.resolve()
    def git(*options):
        return subprocess.check_output(['git', '-C', str(repo), *options]).decode().strip()
    if git('status', '--porcelain'):
        parser.error('Test evidence requires a clean worktree, including untracked files')
    commit, tree = git('rev-parse', 'HEAD'), git('rev-parse', 'HEAD^{tree}')
    output = args.output_dir.resolve()
    if output == repo or repo in output.parents:
        parser.error('Evidence must be written outside the source worktree')
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    log = output / 'tests.tap'
    report_file = output / 'tests.json'
    if log.exists() or report_file.exists():
        parser.error('Evidence destination must be unused')
    command = [args.node, '--test', '--test-concurrency=1']
    started = datetime.datetime.now(datetime.timezone.utc).isoformat()
    with log.open('xb') as stream:
        result = subprocess.run(command, cwd=repo, stdout=stream, stderr=subprocess.STDOUT)
    text = log.read_text(errors='replace')
    counts = {key: int(value) for key, value in re.findall(
        r'^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$', text, re.M)}
    unchanged = not git('status', '--porcelain') and git('rev-parse', 'HEAD') == commit
    exit_code = result.returncode if unchanged else 2
    report = {'schema': 1, 'commit': commit, 'tree': tree, 'started_at': started,
        'finished_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'node_version': subprocess.check_output([args.node, '--version']).decode().strip(),
        'command': ['node', '--test', '--test-concurrency=1'], 'exit_code': exit_code,
        'counts': counts, 'worktree_unchanged': unchanged,
        'log_sha256': hashlib.sha256(log.read_bytes()).hexdigest()}
    report_file.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))
    sys.exit(exit_code if exit_code else (0 if counts.get('fail') == 0 and counts.get('tests', 0) > 0 else 1))


if __name__ == '__main__':
    main()
