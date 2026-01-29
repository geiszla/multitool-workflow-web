# Issue #18 - WebSocket Review Findings - Final Report

**Issue:** [#18 - Websocket review findings](https://github.com/geiszla/multitool-workflow-web/issues/18)
**Date:** 2026-01-28
**PR:** _To be created_

---

## 1. Summary of Work

This implementation addresses 5 WebSocket-related issues in the terminal connection system identified in a code review. The fixes ensure proper session takeover handling (close code 4409), prevent race conditions during takeover, show reconnecting UI when the VM leg is down, fix streaming UTF-8 decoding for multibyte characters, and synchronize the `WsMessageType` definition with the actual protocol.

---

## 2. Implementation Details

### Key Files Changed

| File | Lines Changed | Purpose |
|------|---------------|---------|
| `app/services/websocket-proxy.server.ts` | +18/-8 | VM takeover handling, promise resolution, reconnecting notification |
| `app/components/agents/Terminal.tsx` | +50/-16 | UTF-8 streaming, vm_reconnecting UI, stale WS guards |
| `vm-bootstrap/pty-server.js` | +36/-8 | Takeover snapshot pattern, split-brain prevention |

### Important Functions/Classes Modified

**websocket-proxy.server.ts:**
- `WsMessageType` - Added missing message types: `connected`, `session_active`, `session_taken_over`, `takeover`, `vm_reconnecting`
- `setupProxyConnection()` → `connectToVm()` - Fixed promise resolution to always resolve, added VM reconnecting notification

**Terminal.tsx:**
- `connect()` - Creates per-connection TextDecoder, handles `vm_reconnecting` message
- `ws.onmessage()` - Uses streaming decode, exits reconnecting state on stdout
- `ws.onclose()` - Flushes decoder output to terminal

**pty-server.js:**
- Connection handler - Added snapshot-and-compare pattern for takeover
- `setupWebSocketHandlers()` - Added session ID check to prevent split-brain input

### No Data Model/Schema Changes

This is purely a code fix - no database or schema changes required.

---

## 3. Key Technical Decisions

### Close Code Handling
- Added `4409` (session taken over) to no-retry codes in proxy
- When VM closes with 4409, browser receives clean disconnect instead of retry loop

### Promise Resolution Strategy
- Moved `resolve(false)` from error handler to close handler
- Since `close` always fires (even after `error`), this ensures exactly one resolve
- Also propagates retry result with `resolve(reconnected)` after reconnection attempts

### Takeover Race Protection
- Capture `sessionAtPrompt` snapshot when sending `session_active` message
- On takeover, close actual current session (may differ from snapshot)
- Added session ID check in message handler to prevent split-brain stdin

### UTF-8 Streaming
- TextDecoder created per-connection (not module-level)
- Uses `{ stream: true }` option for decoding split multibyte sequences
- Flushes decoder on close and writes any remaining output to terminal

### Stale WebSocket Guards
- Added `wsRef.current !== ws` checks in onmessage and onclose
- Prevents race conditions when new connection starts during handler execution

### UI Approach
- Reused existing `reconnecting` state for VM-leg reconnects
- Added `isVmLegReconnectRef` to track source and hide attempt count
- Exit reconnecting state when stdout arrives (implicit reconnect signal)

---

## 4. Risks, Limitations, and Follow-Ups

### Known Limitations
- VM reconnecting UI exits based on stdout data arrival, which is simpler but could delay exit if VM is quiet
- No explicit `vm_reconnected` message - relies on stdout as implicit signal

### Deferred Items
- `.env.*` template changes are unrelated pre-existing changes
- `WebFetch` in allowedTools is an unrelated intentional change

### Suggested Follow-Ups
- Consider adding integration tests for session takeover scenarios
- Consider adding E2E test for multibyte UTF-8 character rendering

---

## 5. Workflow Meta-Analysis

### What Worked Well
- **Codex plan refinement** identified important edge cases not in initial plan:
  - Snapshot-and-compare pattern for takeover
  - TextDecoder lifecycle management
  - Promise resolution guarantee
- **Codex review loop** caught critical bugs in implementation:
  - Promise hanging during retries
  - Takeover split-brain scenario
  - Stale WS race conditions
  - Decoder flush output loss

### Opportunities for Earlier Surfacing
- The "promise always resolves" issue could have been caught during initial code review (Step 1)
- The split-brain takeover scenario was subtle and correctly identified only in review

### Unnecessary Churn
- **Minimal churn** - the initial implementation was close to correct
- Review loop required 2 iterations, both fixing real bugs
- No features were revised or reverted

### Workflow Improvements
- The multi-step review process (Claude plan → Codex refinement → Implementation → Codex review) was effective for this type of complex state management code
- For similar WebSocket/state machine issues, consider adding explicit state transition diagrams to the plan

---

## 6. Files Summary

```
docs/issue-18-plan.md              # Implementation plan (v2, Codex-refined)
docs/issue-18-review-comments.md   # Codex review findings and resolutions
docs/issue-18-final-report.md      # This report
```

---

_Implementation complete. Ready for testing and PR creation._
