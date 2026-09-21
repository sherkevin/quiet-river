# Acquisition capability layer

## Why this exists

Quiet River historically persisted a concrete `transport` directly on each channel (`public`, `desktop`, `native`, `rsshub`, `werss`). That is sufficient for execution, but it couples the stable user intent ("read this author's notes") to whichever implementation happens to work today.

This layer adapts Agent-Reach's channel/backend design:

- stable capability;
- ordered backend candidates;
- explicit active backend;
- health probes that do not confuse "installed/configured" with "actually healthy";
- backend execution behind a registry rather than transport-specific branches in `ReaderService`.

Upstream reference: `Panniantong/Agent-Reach` at commit
`a19a171fa980a0785849596492e0af4db800c82f`, MIT licensed.
See `third_party/agent-reach/`.

## Phase 1: non-destructive overlay

Phase 1 deliberately does **not** migrate source/channel IDs or Miniflux feed identities.

Existing persistence remains:

```
Source
  -> persisted Channel
      -> transport
```

The new runtime view is:

```
Source
  -> Capability (platform + logical channel label)
      -> ordered Backend candidates
          -> activeBackend
          -> status / reason
```

Current backend identities are:

| Persisted transport | Backend identity | Ownership |
| --- | --- | --- |
| `public` | `direct-feed` | ECS / Quiet River |
| `native` | `quiet-river-native` | ECS / Quiet River |
| `desktop` | `opencli-shervin` | Shervin |
| `rsshub` | `rsshub-ecs` | ECS |
| `werss` | `werss-ecs` | legacy compatibility only; runtime intentionally skipped/off |

The health API exposes `capabilities` and `capabilitySummary`. The UI shows the active backend on blogger pages and the acquisition-health screen.

An explicit `/desk/api/acquisition/doctor` endpoint ports Agent-Reach's doctor idea without weakening Quiet River's passive-health rule. Passive health never sends network requests. Doctor runs only when explicitly requested and probes runtime dependencies, not platform content: Shervin heartbeat plus configured loopback-only runtimes such as RSSHub/xiaohongshu-mcp. The legacy `werss-ecs` identity may still appear for the 16 preserved WeChat adapter records, but no WeRSS runtime URL is loaded and those channels stay disabled/off after the user explicitly skipped WeRSS. Probe results are observational and never rewrite persisted channel state.

Health semantics intentionally mirror Agent-Reach's "probe, don't assume" rule:

- `ok`: a real check completed successfully;
- `warn`: configured but unverified, partial, running, cooling down, or temporarily offline;
- `error`: explicit credential/authentication failure;
- `off`: disabled, not configured, or source paused.

A `warn` backend may remain the active route when it can retain/queue work (for example Shervin offline). An `error` or `off` backend never pretends to be active.

## Backend runner registry

`reader-bridge/acquisition-backends.js` is the execution counterpart to the capability overlay. `ReaderService.pump()` resolves the backend identity and delegates execution through the registry.

This removes transport-specific execution branches from `ReaderService` without changing behavior. The desktop backend is registered but intentionally refuses ECS execution because Shervin pull-owns that work.

Adding a new backend no longer requires editing `ReaderService`; a runner can be registered behind a stable backend ID.

## What Phase 1 does not do

Phase 1 does **not** automatically switch between multiple physical backends for one capability. That would require scheduler ownership, cooldown groups, credential groups, and duplicate-ingestion semantics to be explicit per candidate.

The UI therefore says that capability/backend routing is currently observational.

## Phase 2 migration gate

Actual fallback should be introduced one platform at a time after both candidates have real probes and equivalent normalization contracts.

The first ordered policy is already declared for Xiaohongshu:

```
xiaohongshu.notes
  1. OpenCLI @ Shervin
  2. xiaohongshu-mcp @ ECS
```

The second candidate is deliberately reported as `off` until it has a real local probe and runner. A declared policy is not evidence that a backend is usable; this keeps the Agent-Reach `probe, don't assume` rule intact.

Before enabling automatic fallback:

1. both backends must return the same normalized article identity;
2. fallback must not move Chrome cookies from Shervin to ECS;
3. one logical capability may have only one active scheduler owner at a time;
4. read state and Miniflux external IDs must remain stable across backend switches;
5. health must distinguish "backend unavailable" from "author has no new content";
6. a backend override must be reversible without rewriting source/channel history.

Only after these gates should the persisted channel model be migrated from one transport per channel to multiple physical backend candidates.
