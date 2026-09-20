#!/usr/bin/env python3
"""Read-only Twitter author timeline using explicit credentials only.

This wrapper deliberately imports twitter_cli.client directly and never imports
twitter_cli.auth.get_cookies, so browser-cookie discovery is not on the
execution path. Credentials come only from TWITTER_AUTH_TOKEN and TWITTER_CT0.
"""
from __future__ import annotations

import json
import os
import re
import sys

from twitter_cli.client import TwitterClient
from twitter_cli.serialization import tweet_to_dict

_HANDLE = re.compile(r"^[A-Za-z0-9_]{1,15}$")


def fail(message: str, code: int) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(code)


def main() -> None:
    if len(sys.argv) != 3 or not _HANDLE.fullmatch(sys.argv[1]):
        fail("invalid twitter author", 64)
    handle = sys.argv[1]
    try:
        limit = int(sys.argv[2])
    except ValueError:
        fail("invalid twitter limit", 64)
    if limit < 1 or limit > 20:
        fail("invalid twitter limit", 64)

    auth_token = os.environ.get("TWITTER_AUTH_TOKEN", "")
    ct0 = os.environ.get("TWITTER_CT0", "")
    if not auth_token or not ct0:
        fail("explicit twitter credentials required", 77)

    try:
        client = TwitterClient(
            auth_token,
            ct0,
            rate_limit_config={"requestDelay": 2.5, "maxRetries": 2, "maxCount": 20},
        )
        profile = client.fetch_user(handle)
        if profile.screen_name.casefold() != handle.casefold():
            fail("twitter profile identity mismatch", 65)
        tweets = client.fetch_user_tweets(profile.id, limit)
        rows = []
        for tweet in tweets:
            if getattr(tweet, "is_retweet", False):
                continue
            author = getattr(tweet, "author", None)
            screen = getattr(author, "screen_name", "") if author else ""
            if screen.casefold() != handle.casefold():
                continue
            rows.append(tweet_to_dict(tweet))
        sys.stdout.write(json.dumps(rows, ensure_ascii=False))
    except SystemExit:
        raise
    except Exception as exc:
        # Do not print response bodies/cookies. The class name is sufficient for
        # Quiet River's bounded failure classifier.
        print("twitter explicit fetch failed: " + exc.__class__.__name__, file=sys.stderr)
        raise SystemExit(70)


if __name__ == "__main__":
    main()
