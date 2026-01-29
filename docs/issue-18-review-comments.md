# Issue #18 - Codex Review Comments and Resolution

**Issue:** https://github.com/geiszla/multitool-workflow-web/issues/18
**Date:** 2026-01-28
**Review Iterations:** 2

---

## Codex Review - Iteration 1

### Bugs and Missing Changes

| Finding | Severity | Resolution |
|---------|----------|------------|
| `connectToVm()` promise can hang during initial connection retries | High | **Fixed**: Propagated retry result to original promise with `resolve(reconnected)` and added `resolve(false)` on early exit paths |
| TextDecoder flush output discarded | Medium | **Fixed**: Now writes flushed output to xterm in `onclose` handler |
| Race condition with stale WS instances | High | **Fixed**: Added guards in `onmessage` and `onclose` handlers, captured decoder per-connection in closure |
| VM-deleted path missing return | Low | **Deferred**: Analyzed and determined unnecessary - no continuation after the if block closes |
| VM-leg reconnect UI exit may be brittle | Low | **Accepted**: stdout-driven exit is simpler per plan, avoids extra message types |

### Security & Privacy

| Finding | Severity | Resolution |
|---------|----------|------------|
| `WebFetch` in allowedTools expands capabilities | Info | **Pre-documented**: Intentional unrelated change, out of scope for #18 |

### Design & Architecture

- `vm_reconnecting` signaling is consistent end-to-end
- Decoder-per-connection pattern aligns with plan

### Style & Consistency

- `WsMessageType` formatting noted but non-blocking

---

## Codex Review - Iteration 2

### Bugs and Missing Changes

| Finding | Severity | Resolution |
|---------|----------|------------|
| Takeover mismatch split-brain: if `currentSession !== sessionAtPrompt`, code promoted new client without closing actual current session | High | **Fixed**: Now closes the actual current session (not snapshot) and added session ID check in `setupWebSocketHandlers` to prevent split-brain stdin |

### Security & Privacy

- Same as iteration 1

### Design & Architecture

- Takeover fix correctly handles edge case where session changes between prompt and takeover
- Session ID gate in message handler prevents any split-brain scenario

---

## Summary of Changes Made

### `app/services/websocket-proxy.server.ts`

1. **Promise resolution fix**: Added `resolve(false)` on early exit after delay check, and `resolve(reconnected)` to propagate retry result to original promise

### `app/components/agents/Terminal.tsx`

1. **Decoder per-connection**: Captured decoder in local variable instead of relying on ref in handlers
2. **Stale WS guard in onmessage**: Added `if (wsRef.current !== ws) return` check
3. **Stale WS guard in onclose**: Added check before processing close event
4. **Flush output fix**: Now writes flushed text to xterm before clearing decoder

### `vm-bootstrap/pty-server.js`

1. **Takeover mismatch fix**: Changed logic to close actual current session (not snapshot) when session changes between prompt and takeover
2. **Split-brain prevention**: Added session ID check at start of message handler to reject input from non-active sessions

---

## Deferred Items

1. **VM-deleted path return statement**: Linter correctly removes it as unreachable code - no continuation after the block
2. **`.env.*` changes**: Pre-documented unrelated template changes
3. **`WebFetch` in allowedTools**: Pre-documented intentional change
4. **WsMessageType comment update**: Minor documentation, non-blocking

---

## Conclusion

Codex review loop concluded after 2 iterations. No significant issues remain. All high and medium severity bugs have been fixed:

- Promise hanging in `connectToVm()` - Fixed
- TextDecoder flush output loss - Fixed
- Stale WS race condition - Fixed
- Takeover split-brain - Fixed
