# Snapshot file
# Unset all aliases to avoid conflicts with functions
unalias -a 2>/dev/null || true
shopt -s expand_aliases
# Check for rg availability
if ! command -v rg >/dev/null 2>&1; then
  alias rg=''\''E:\tataanAI\claude-agent-kit\node_modules\.pnpm\@anthropic-ai+claude-agent-sdk@0.1.76_zod@4.1.12\node_modules\@anthropic-ai\claude-agent-sdk\vendor\ripgrep\x64-win32\rg.exe'\'''
fi
export PATH=$PATH
