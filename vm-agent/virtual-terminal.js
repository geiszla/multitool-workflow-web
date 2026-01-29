/**
 * VirtualTerminal - Server-side terminal emulator using @xterm/headless.
 *
 * This class wraps @xterm/headless to capture all PTY output, enabling
 * terminal state restoration when users reconnect after closing their browser tab.
 *
 * Features:
 * - 10,000 line scrollback buffer
 * - Full terminal state capture (including alt-buffer for vim/less)
 * - Graceful error handling (serialize failures return null)
 * - Configurable dimensions with resize support
 */

// CJS modules require default import + destructure for ESM interop
import xtermHeadless from '@xterm/headless'
import xtermSerialize from '@xterm/addon-serialize'

const { Terminal } = xtermHeadless
const { SerializeAddon } = xtermSerialize

const SCROLLBACK_LINES = 10000
const MAX_SERIALIZE_SIZE_WARNING = 5 * 1024 * 1024 // 5MB
// Hard cap accounts for potential JSON encoding expansion (control chars become \uXXXX).
// Typical terminal output is mostly printable ASCII, but we use a conservative 8MB limit
// to ensure the final JSON payload stays reasonable even with heavy escape sequences.
const MAX_SERIALIZE_SIZE_HARD_CAP = 8 * 1024 * 1024 // 8MB - skip restore if exceeded

/**
 * VirtualTerminal class that captures all PTY output for state restoration.
 */
export class VirtualTerminal {
  /**
   * Create a new VirtualTerminal.
   * @param {number} cols - Initial number of columns (default: 80)
   * @param {number} rows - Initial number of rows (default: 24)
   * @param {function} log - Logging function (default: console.log)
   */
  constructor(cols = 80, rows = 24, log = console.log) {
    this.log = log

    this.terminal = new Terminal({
      cols,
      rows,
      scrollback: SCROLLBACK_LINES,
      allowProposedApi: true, // Required for serialize addon
    })

    this.serializeAddon = new SerializeAddon()
    this.terminal.loadAddon(this.serializeAddon)
  }

  /**
   * Write PTY output to the virtual terminal.
   * @param {string} data - Terminal output data
   */
  write(data) {
    try {
      this.terminal.write(data)
    }
    catch (error) {
      // Log but don't throw - virtual terminal failures shouldn't break PTY
      this.log('warn', 'VirtualTerminal write failed', { error: error.message })
    }
  }

  /**
   * Resize the virtual terminal.
   * @param {number} cols - New number of columns
   * @param {number} rows - New number of rows
   */
  resize(cols, rows) {
    try {
      this.terminal.resize(cols, rows)
    }
    catch (error) {
      this.log('warn', 'VirtualTerminal resize failed', { error: error.message })
    }
  }

  /**
   * Serialize the current terminal state.
   * @returns {string|null} Serialized terminal state, or null on error
   */
  serialize() {
    try {
      const serialized = this.serializeAddon.serialize({
        scrollback: SCROLLBACK_LINES,
        excludeModes: false, // Include terminal modes
        excludeAltBuffer: false, // Include alt-buffer (vim/less)
      })

      // Hard cap: skip restore if serialized state is too large
      // This prevents CPU/network/UI pressure from extremely large payloads
      if (serialized.length > MAX_SERIALIZE_SIZE_HARD_CAP) {
        this.log('warn', 'VirtualTerminal serialized state exceeds hard cap, skipping restore', {
          size: serialized.length,
          hardCap: MAX_SERIALIZE_SIZE_HARD_CAP,
        })
        return null
      }

      // Warn if serialized size is large (for monitoring)
      if (serialized.length > MAX_SERIALIZE_SIZE_WARNING) {
        this.log('warn', 'VirtualTerminal serialized state is large', {
          size: serialized.length,
          maxWarning: MAX_SERIALIZE_SIZE_WARNING,
        })
      }

      return serialized
    }
    catch (error) {
      // Log failure but return null - caller should handle gracefully
      this.log('error', 'VirtualTerminal serialize failed', { error: error.message })
      return null
    }
  }

  /**
   * Dispose of the virtual terminal and release resources.
   */
  dispose() {
    try {
      this.terminal.dispose()
    }
    catch (error) {
      this.log('warn', 'VirtualTerminal dispose failed', { error: error.message })
    }
  }
}
