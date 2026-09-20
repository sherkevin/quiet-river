# Agent-Reach attribution

Quiet River's capability/backend routing model is adapted from Agent-Reach's ordered channel/backend design.

Upstream: https://github.com/Panniantong/Agent-Reach
Pinned reference commit: `a19a171fa980a0785849596492e0af4db800c82f`
License: MIT (see `LICENSE` in this directory).

Quiet River does not vendor Agent-Reach as a runtime dependency. The Node.js capability overlay ports the ordered-backend, active-backend, and health-probe concepts so existing Quiet River acquisition transports can migrate incrementally without changing article/source persistence.
