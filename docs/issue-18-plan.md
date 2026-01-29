# Issue #18 - WebSocket Review Findings - Implementation Plan

**Issue:** https://github.com/geiszla/multitool-workflow-web/issues/18
**Status:** Draft Plan v2 (Codex-refined)
**Created:** 2026-01-28

---

## Scope & Goals

Fix WebSocket-related issues in the terminal connection system:

1. Properly handle VM takeover close code 4409 as terminal (no retry)
2. Add defensive null checks for `currentSession` during takeover (snapshot + compare pattern)
3. Show reconnecting UI when VM leg is down
4. Fix streaming UTF-8 decoding for terminal output (with proper lifecycle management)
5. Synchronize `WsMessageType` with actual protocol
6. Ensure `connectToVm()` promise always resolves

**Success Criteria:**
- Browser receives clean disconnect on session takeover (no retry loop)
- No crashes if `currentSession` is null during takeover
- User sees "Reconnecting" UI when proxy is reconnecting to VM
- Multibyte UTF-8 characters render correctly even when split across frames
- Type definitions match actual protocol
- No hanging promises in VM connection logic

---

## Architecture Impact

### Files to Modify

| File | Changes |
|------|---------|
| `app/services/websocket-proxy.server.ts` | Add 4409 to no-retry codes, add vm_reconnecting notification, update WsMessageType, fix promise resolution |
| `app/components/agents/Terminal.tsx` | Handle vm_reconnecting notification, fix streaming TextDecoder with lifecycle management |
| `vm-bootstrap/pty-server.js` | Add snapshot-and-compare pattern for currentSession during takeover |

### No Schema/Database Changes

This is purely a code fix - no data model changes required.

---

## Technical Decisions (from Codex Review)

1. **Decoder strategy**: Keep `TextDecoder` in a `useRef` that's recreated on each WebSocket connection; call `decode(undefined, {stream:false})` flush on close.

2. **Close code handling**: Add `4409` to no-retry codes in both proxy and client.

3. **Takeover correctness**: Capture `sessionAtPrompt` snapshot when sending `session_active`; only act on takeover if `currentSession === sessionAtPrompt`.

4. **Suppress stdin during VM-leg reconnect**: Safer than buffering.

5. **UI simplification**: Reuse existing `reconnecting` state for VM-leg reconnects, but hide attempt count since it's not browser-WS retries.

6. **Promise resolution**: Move `resolve(false)` from error handler to close handler, since close always fires (even after error). This ensures exactly one resolve without tracking.

---

## Task Breakdown

### Task 1: Update WsMessageType

**Purpose:** Keep type definitions in sync with actual message types.

**Target:** `app/services/websocket-proxy.server.ts`

**Changes:**
- Line 61: Update type definition:
  ```typescript
  export type WsMessageType =
    | 'resize'              // Client -> VM
    | 'takeover'            // Client -> VM
    | 'connected'           // VM -> Client
    | 'session_active'      // VM -> Client
    | 'session_taken_over'  // VM -> Client
    | 'vm_reconnecting'     // Proxy -> Client (new)
    | 'error'               // VM/Proxy -> Client
    | 'exit'                // VM -> Client
  ```

**Tests:** TypeScript compilation

**Risk:** Low

---

### Task 2: Add 4409 to no-retry codes in proxy

**Purpose:** When VM closes with code 4409 (session taken over), propagate to browser instead of retrying.

**Target:** `app/services/websocket-proxy.server.ts`

**Changes:**
- Line 438: Add `4409` to `noRetryCodes` array
- Change from `[1000, 1008]` to `[1000, 1008, 4409]`

**Tests:** Manual - verify session takeover cleanly disconnects old browser tab

**Risk:** Low

---

### Task 3: Fix connectToVm() promise resolution

**Purpose:** Prevent hanging promises when VM connection closes without an error event first.

**Target:** `app/services/websocket-proxy.server.ts`

**Changes:**
1. Remove `resolve(false)` from the error handler (around line 417)
2. Add `resolve(false)` to the close handler (around line 421)

Since `close` always fires (even after `error`), this ensures exactly one resolve call for failures without needing to track whether we've already resolved.

**Tests:** Manual - test connection failures where close fires without error

**Risk:** Low

---

### Task 4: Add VM reconnecting notification to browser

**Purpose:** Notify browser when VM leg is down so user knows input may be dropped.

**Target:** `app/services/websocket-proxy.server.ts`

**Changes:**
1. When VM connection is lost and retry starts, send to browser (once, before first retry):
   ```typescript
   if (browserConnected && ws.readyState === ws.OPEN) {
     ws.send(JSON.stringify({ type: 'vm_reconnecting' }))
   }
   ```

2. No explicit `vm_reconnected` message needed - next stdout data serves as implicit signal that connection is restored.

**Tests:** Manual - simulate VM connection drops

**Risk:** Low

---

### Task 5: Add snapshot-and-compare pattern for takeover

**Purpose:** Prevent crash/race if active session disconnects before takeover message arrives.

**Target:** `vm-bootstrap/pty-server.js`

**Changes:**
1. Capture snapshot when entering takeover flow (around line 394):
   ```javascript
   const sessionAtPrompt = currentSession
   ```

2. In takeoverHandler, compare against snapshot:
   ```javascript
   if (msg.type === 'takeover') {
     // Session may have disconnected - check both current state and snapshot
     if (!currentSession || currentSession !== sessionAtPrompt ||
         currentSession.ws.readyState !== currentSession.ws.OPEN) {
       // Session disappeared - treat as fresh connection
       ws.removeListener('message', takeoverHandler)
       currentSession = { ws, sessionId: newSessionId }
       setupWebSocketHandlers(ws, newSessionId)
       ws.send(JSON.stringify({ type: 'connected', sessionId: newSessionId }))
       if (!ptyProcess) {
         ptyProcess = spawnPtyProcess(repoDir)
       }
       return
     }

     // Normal takeover flow (existing code)
     // ...
   }
   ```

**Tests:** Manual - rapid connect/disconnect/reconnect sequences

**Risk:** Low - defensive, doesn't change normal flow

---

### Task 6: Fix streaming UTF-8 decoding with lifecycle management

**Purpose:** Handle multibyte UTF-8 characters split across WebSocket frames; prevent leaking state across connections.

**Target:** `app/components/agents/Terminal.tsx`

**Changes:**
1. Move TextDecoder to a ref (not module-level):
   ```typescript
   const textDecoderRef = useRef<TextDecoder | null>(null)
   ```

2. Create new decoder when WebSocket connects:
   ```typescript
   // In connect(), after creating ws:
   textDecoderRef.current = new TextDecoder('utf-8', { fatal: false })
   ```

3. Use streaming mode in onmessage:
   ```typescript
   const text = textDecoderRef.current?.decode(event.data, { stream: true }) ?? ''
   ```

4. Flush decoder on close:
   ```typescript
   // In ws.onclose or cleanup:
   textDecoderRef.current?.decode(undefined, { stream: false })
   textDecoderRef.current = null
   ```

**Tests:** Manual - send multibyte characters, verify no mojibake across frames or reconnects

**Risk:** Low

---

### Task 7: Add vm_reconnecting handling to Terminal

**Purpose:** Show reconnecting UI when VM leg is reconnecting.

**Target:** `app/components/agents/Terminal.tsx`

**Changes:**
1. Add to WsMessage type:
   ```typescript
   type: '...' | 'vm_reconnecting'
   ```

2. Handle vm_reconnecting message - reuse existing `reconnecting` state:
   ```typescript
   case 'vm_reconnecting':
     setConnectionState('reconnecting')
     break
   ```

3. Input is already suppressed (connectionStateRef check in onData only allows `connected` state)

4. Modify reconnecting UI to hide attempt count when it's a VM-leg reconnect:
   - Add a ref to track whether reconnect is VM-leg vs browser-WS
   - Hide attempt count display when VM-leg reconnecting

5. Exit reconnecting state when stdout arrives (set to 'connected' on binary message if in reconnecting state)

**Tests:** Manual - simulate VM leg disconnect, verify UI shows

**Risk:** Low

---

## Implementation Order

1. Task 1 (WsMessageType sync) - enables other changes
2. Task 2 (4409 no-retry) - standalone fix
3. Task 3 (promise resolution) - standalone fix
4. Task 5 (takeover snapshot pattern) - standalone fix
5. Task 6 (UTF-8 streaming with lifecycle) - standalone fix
6. Task 4 (VM reconnecting notification) - depends on Task 1
7. Task 7 (vm_reconnecting UI handling) - depends on Task 1 and Task 4

---

## Package/Library Strategy

No new packages needed. All fixes use existing Node.js and browser APIs:
- `TextDecoder` with streaming option (standard Web API)
- WebSocket close codes (standard protocol)
- TypeScript types (development only)

---

## Risk Areas & Watch-outs

### Race Conditions
- **Concern:** Session takeover vs session disconnect timing
- **Mitigation:** Task 5 uses snapshot-and-compare pattern

### Promise Never Resolving
- **Concern:** `connectToVm()` promise could hang if close fires without error
- **Mitigation:** Task 3 moves resolve to close handler (which always fires)

### TextDecoder State Leakage
- **Concern:** Streaming decoder buffering partial codepoints across connections
- **Mitigation:** Task 6 recreates decoder per connection and flushes on close

### Backwards Compatibility
- **Concern:** New `vm_reconnecting` message type
- **Mitigation:** Old clients will ignore unknown message types (try/catch exists)

---

## Testing Matrix

1. **Session takeover (4409)**
   - Open two tabs to same agent
   - Second tab takes over
   - First tab should disconnect cleanly (not retry)

2. **Takeover race condition**
   - Connect while existing session
   - Existing session disconnects before takeover sent
   - New session should become active without crash

3. **VM leg reconnection**
   - Kill VM WS connection (or simulate timeout)
   - Browser should show "Reconnecting" overlay (without attempt count)
   - Input should be suppressed
   - On reconnect, terminal should resume

4. **UTF-8 streaming**
   - Send multibyte emoji split across frames
   - Verify correct rendering
   - Reconnect and send more data
   - Verify no corruption from previous connection

5. **Promise resolution**
   - Test connection failures where close fires without error event
   - Verify no hanging awaits

---

## Revision History

- **v1** (2026-01-28): Initial draft
- **v2** (2026-01-28): Codex-refined with snapshot pattern, lifecycle management, simplified promise resolution, simplified reconnecting UI
