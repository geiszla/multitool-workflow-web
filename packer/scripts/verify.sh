#!/bin/bash
# Verification script for Agent VM Image Build
#
# This script validates that the image was built correctly by checking:
# - Node.js version
# - Claude CLI installation
# - npm dependencies
# - systemd service files
# - Directory structure
# - File permissions

set -euo pipefail

echo "=== Verifying VM Image Build ==="

# Check Node.js
NODE_VERSION=$(node --version)
echo "Node.js: $NODE_VERSION"
[[ "$NODE_VERSION" == v24.* ]] || { echo "ERROR: Expected Node.js 24.x"; exit 1; }

# Check Claude CLI
CLAUDE_VERSION=$(claude --version 2>&1 || echo "NOT INSTALLED")
echo "Claude CLI: $CLAUDE_VERSION"
[[ "$CLAUDE_VERSION" != "NOT INSTALLED" ]] || { echo "ERROR: Claude CLI not installed"; exit 1; }

# Check npm dependencies
echo "Checking npm dependencies in /opt/vm-agent..."
cd /opt/vm-agent
npm ls node-pty ws || { echo "ERROR: Missing npm dependencies"; exit 1; }

# Check systemd units exist
echo "Checking systemd units..."
[[ -f /etc/systemd/system/agent-bootstrap.service ]] || { echo "ERROR: agent-bootstrap.service missing"; exit 1; }
[[ -f /etc/systemd/system/pty-server.service ]] || { echo "ERROR: pty-server.service missing"; exit 1; }

# Check services are disabled (will be enabled at runtime)
echo "Checking services are disabled..."
if systemctl is-enabled agent-bootstrap.service 2>/dev/null; then
  echo "ERROR: agent-bootstrap.service should be disabled"
  exit 1
fi
if systemctl is-enabled pty-server.service 2>/dev/null; then
  echo "ERROR: pty-server.service should be disabled"
  exit 1
fi
echo "Services are correctly disabled"

# Check agent user exists
echo "Checking agent user..."
id agent || { echo "ERROR: agent user not found"; exit 1; }

# Check directories
echo "Checking directories..."
[[ -d /home/agent/workspace ]] || { echo "ERROR: /home/agent/workspace missing"; exit 1; }
[[ -d /opt/vm-agent ]] || { echo "ERROR: /opt/vm-agent missing"; exit 1; }

# Check bootstrap.js and pty-server.js exist
echo "Checking script files..."
[[ -f /opt/vm-agent/bootstrap.js ]] || { echo "ERROR: /opt/vm-agent/bootstrap.js missing"; exit 1; }
[[ -f /opt/vm-agent/pty-server.js ]] || { echo "ERROR: /opt/vm-agent/pty-server.js missing"; exit 1; }

# Check pty-server env file exists with correct permissions
echo "Checking /etc/default/pty-server..."
[[ -f /etc/default/pty-server ]] || { echo "ERROR: /etc/default/pty-server missing"; exit 1; }
OWNER=$(stat -c '%U:%G' /etc/default/pty-server)
[[ "$OWNER" == "agent:agent" ]] || { echo "ERROR: /etc/default/pty-server has wrong owner: $OWNER"; exit 1; }
PERMS=$(stat -c '%a' /etc/default/pty-server)
[[ "$PERMS" == "600" ]] || { echo "ERROR: /etc/default/pty-server has wrong permissions: $PERMS"; exit 1; }

# Check /opt/vm-agent permissions (should be root-owned)
echo "Checking /opt/vm-agent permissions..."
VMOWNER=$(stat -c '%U:%G' /opt/vm-agent)
[[ "$VMOWNER" == "root:root" ]] || { echo "ERROR: /opt/vm-agent has wrong owner: $VMOWNER"; exit 1; }

echo ""
echo "=== All Verifications Passed ==="
