#!/usr/bin/env python3
"""Forced SSH command: only forwards bounded collector messages to a local API."""
import json
import os
import signal
import sys
import urllib.request
import urllib.error


def main():
    signal.alarm(150)
    if os.environ.get('SSH_ORIGINAL_COMMAND', '') not in ('collector', ''):
        raise ValueError('unsupported SSH operation')
    data = sys.stdin.buffer.read(262145)
    if len(data) > 262144:
        raise ValueError('message too large')
    message = json.loads(data)
    if not isinstance(message, dict) or message.get('op') not in ('claim', 'submit', 'status'):
        raise ValueError('unsupported collector operation')
    config = {}
    with open('/etc/quiet-river-collector/agent.env') as stream:
        for line in stream:
            if '=' in line:
                key, value = line.strip().split('=', 1)
                config[key] = value
    req = urllib.request.Request('http://127.0.0.1:4380/desk/collector/v1',
        data=data, method='POST', headers={'Content-Type': 'application/json',
        'X-QR-Collector-Token': config['QR_COLLECTOR_TOKEN']})
    # Ignore shell proxy variables: this request must stay on loopback.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=140) as response:
            result = response.read(262145)
        if len(result) > 262144:
            raise ValueError('response too large')
        json.loads(result)
        sys.stdout.buffer.write(result)
    except urllib.error.HTTPError as error:
        print(json.dumps({'error': 'collector API rejected request', 'status': error.code}))
        return 1
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        # Do not log request content, credentials, or upstream error bodies.
        print(json.dumps({'error': 'collector transport unavailable'}))
        sys.exit(1)
