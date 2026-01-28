#!/bin/bash
# Provisioning script for Agent VM Image
#
# This script installs all global dependencies during Packer build.
# User-specific configuration (credentials, repo clone) remains dynamic at runtime.
#
# Security considerations:
# - Uses signed apt repos for Node.js (supply-chain hardening)
# - Claude CLI installed via bash installer (official method from claude.ai)
# - Codex CLI installed via npm with user prefix
# - Locked npm dependencies via package-lock.json
# - Services disabled by default (enabled at runtime)
# - VMs have no external IP, limiting attack surface

set -euo pipefail

echo "=== Agent VM Provisioning Script ==="
echo "Starting at $(date -Iseconds)"

# Update package lists
echo "Updating package lists..."
apt-get update

# Install build dependencies
echo "Installing build dependencies..."
apt-get install -y --no-install-recommends \
  build-essential \
  python3 \
  git \
  jq \
  curl \
  gnupg \
  ca-certificates

# Install Node.js 24 LTS via signed apt repository (supply-chain hardening)
echo "Installing Node.js 24 LTS..."

# Install NodeSource GPG key securely
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | \
  gpg --dearmor -o /usr/share/keyrings/nodesource.gpg

# Add repo with signed-by (not the insecure curl|bash method)
echo "deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" | \
  tee /etc/apt/sources.list.d/nodesource.list

apt-get update
apt-get install -y nodejs

echo "Node.js version: $(node --version)"
echo "npm version: $(npm --version)"

# Create agent user with home directory BEFORE installing Claude
# This is required so Claude CLI is installed in the correct home directory
echo "Creating agent user..."
useradd -m -s /bin/bash agent || true

# Install Claude CLI as agent user using bash installer
# This installs to ~/.local/bin/claude with correct ownership
echo "Installing Claude CLI..."
su - agent -c 'curl -fsSL https://claude.ai/install.sh | bash'

# Add ~/.local/bin to agent's PATH for systemd services
echo 'export PATH="$HOME/.local/bin:$PATH"' >> /home/agent/.bashrc

echo "Claude CLI version: $(su - agent -c 'claude --version' 2>&1 || echo 'installed')"

# Install Codex CLI as agent user with local prefix
# Using ~/.local as npm prefix allows global installs without root
echo "Installing Codex CLI..."
su - agent -c 'mkdir -p ~/.local && npm config set prefix ~/.local && npm install -g @openai/codex'
echo "Codex CLI version: $(su - agent -c 'codex --version' 2>&1 || echo 'installed')"

# Create Codex config directory and configuration
echo "Configuring Codex CLI..."
mkdir -p /home/agent/.codex

cat > /home/agent/.codex/config.toml << 'EOF'
approval_policy = "never"
sandbox_mode = "danger-full-access"

# MCP Server Configuration
[mcp_servers.github]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-github"]
# GITHUB_PERSONAL_ACCESS_TOKEN inherited from environment

[mcp_servers.shopify]
command = "npx"
args = ["-y", "@shopify/dev-mcp@latest"]

# Note: Figma MCP is added dynamically by pty-server.js if figmaApiKey is available
EOF

chown -R agent:agent /home/agent/.codex
chmod 600 /home/agent/.codex/config.toml

# Create workspace directory
echo "Creating workspace directory..."
mkdir -p /home/agent/workspace
chown agent:agent /home/agent/workspace

# Create vm-agent directory structure
echo "Setting up /opt/vm-agent..."
mkdir -p /opt/vm-agent

# Copy vm-bootstrap files from upload location
cp /tmp/vm-bootstrap/package.json /opt/vm-agent/
cp /tmp/vm-bootstrap/package-lock.json /opt/vm-agent/
cp /tmp/vm-bootstrap/bootstrap.js /opt/vm-agent/
cp /tmp/vm-bootstrap/pty-server.js /opt/vm-agent/

# Install npm dependencies with locked versions
echo "Installing npm dependencies..."
cd /opt/vm-agent
npm ci --omit=dev

# Set directory permissions - root-owned, read-only for agent
echo "Setting directory permissions..."
chown -R root:root /opt/vm-agent
chmod -R 755 /opt/vm-agent

# Copy systemd service unit files
echo "Installing systemd services..."
cp /tmp/vm-bootstrap/systemd/agent-bootstrap.service /etc/systemd/system/
cp /tmp/vm-bootstrap/systemd/pty-server.service /etc/systemd/system/

# Pre-create runtime-writable files
echo "Creating runtime files..."

# /etc/default/pty-server - writable by agent for API keys
touch /etc/default/pty-server
chown agent:agent /etc/default/pty-server
chmod 600 /etc/default/pty-server

# /home/agent/.claude.json - writable by agent for Claude configuration
# Pre-create with base MCP server configuration (no secrets)
# Note: MCP servers inherit environment from the parent process (claude CLI).
# pty-server injects GITHUB_PERSONAL_ACCESS_TOKEN into claude's environment,
# which MCP servers will automatically inherit. No explicit env config needed.
echo "Configuring Claude MCP servers..."
cat > /home/agent/.claude.json << 'EOF'
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"]
    },
    "shopify": {
      "command": "npx",
      "args": ["-y", "@shopify/dev-mcp@latest"]
    }
  }
}
EOF
chown agent:agent /home/agent/.claude.json
chmod 600 /home/agent/.claude.json

# State directory /var/lib/agent-bootstrap is created by systemd StateDirectory at runtime

# Reload systemd to recognize new services
systemctl daemon-reload

# Ensure services are DISABLED (will be enabled by startup script)
# This is important - we don't want them starting on image boot
systemctl disable agent-bootstrap.service || true
systemctl disable pty-server.service || true

# Copy multitool-workflow plugin to /opt
echo "Installing multitool-workflow plugin..."
mkdir -p /opt/multitool-workflow
cp -r /tmp/multitool-workflow/* /opt/multitool-workflow/
chown -R root:root /opt/multitool-workflow
chmod -R 755 /opt/multitool-workflow

# Clean up apt cache to reduce image size
echo "Cleaning up..."
apt-get clean
rm -rf /var/lib/apt/lists/*
rm -rf /tmp/vm-bootstrap
rm -rf /tmp/multitool-workflow

echo "=== Agent VM Provisioning Complete ==="
echo "Finished at $(date -Iseconds)"
