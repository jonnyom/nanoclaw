# NanoClaw Pi Deployment

NanoClaw running on Raspberry Pi 4 Model B (ARM64, Debian Bookworm).

## Why the Pi

Laptop sleep pauses launchd + containers. Pi is always on, low power, and expendable (just reflash the SD card).

## Architecture

Runs **directly on the host** — no Docker containers. The Claude Agent SDK `query()` function had issues spawning Claude Code inside Docker on ARM64, so we bypassed containers entirely. The Pi is a dedicated device, so container isolation isn't needed.

```
Telegram Bot → NanoClaw (node) → Agent Runner (node) → Claude Code → Response
```

All processes run as the `pi` user. systemd manages the service.

## What's Different from Laptop

| Aspect | Laptop (macOS) | Pi |
|--------|---------------|-----|
| Container runtime | Apple Container | None (direct host) |
| Service manager | launchd | systemd |
| Agent execution | Inside container | Direct on host |
| Agent power | Sandboxed | Full host access |

### Key Code Changes (Pi-specific)

- `src/container-runtime.ts`: `CONTAINER_RUNTIME_BIN = 'docker'`, runtime check uses `docker info`
- `src/container-runner.ts`: Spawns `node dist-agent-runner/index.js` directly instead of `docker run`, passes paths via env vars
- `container/agent-runner/src/index.ts`: Paths configurable via env vars (`NANOCLAW_IPC_DIR`, `NANOCLAW_GROUP_DIR`, etc.), falls back to `/workspace/*` for container mode
- `container/agent-runner/src/ipc-mcp-stdio.ts`: IPC_DIR configurable via `NANOCLAW_IPC_DIR`
- `container/entrypoint.sh`: `mount --bind` made non-fatal with `|| true`
- `dist-agent-runner/`: Pre-compiled agent-runner for host execution

## Scripts

```bash
# Status check (memory, CPU, disk, temp, processes)
/home/pi/nanoclaw/scripts/status.sh

# Restart with Telegram notification + auto-trigger
/home/pi/nanoclaw/scripts/restart.sh tg:5158581055
```

## Services

```bash
sudo systemctl status nanoclaw
sudo systemctl restart nanoclaw
sudo journalctl -u nanoclaw -f        # live logs
```

## Integrations

### Telegram
Bot: `@clankerbellbot`. Pool bots for agent teams (5 bots in `TELEGRAM_BOT_POOL`).
Message reactions: 👀 on receive, cleared on response.

### Google Workspace (`gws` CLI)
- **Personal** (default): `gws <command>` → jonathanomahony@gmail.com
- **Work**: `GOOGLE_WORKSPACE_CLI_CONFIG_DIR=~/.config/gws-work gws <command>` → jonny@nory.ai

Scopes: Calendar, Gmail, Drive, Tasks, Sheets, Docs, Slides.
OAuth client from GCP project `tidy-muse-147916`. `jonny@nory.ai` granted Service Usage Consumer role.

### Linear (MCP)
- **linear-nory**: Nory workspace (READ-ONLY)
- **linear-ravell**: Ravell workspace (full access)

Configured in `data/sessions/telegram_main/.claude/settings.json`.

### GitHub (`gh` CLI)
Authenticated as `jonnyom`.

### Browser (`agent-browser` + Chromium)
Chromium at `/usr/bin/chromium-browser`. Set via `AGENT_BROWSER_EXECUTABLE_PATH` in systemd.

### Image Vision
Photos via Telegram downloaded to `groups/telegram_main/images/`, auto-cleaned after 24h. Agent reads with Claude's multimodal vision.

## SSH Access

```
ssh pi    # 192.168.1.156, user: pi, key: ~/.ssh/id_pi
```

## Rebuilding

```bash
# From Mac — sync source and rebuild
rsync -av --exclude node_modules --exclude .git --exclude dist src/ pi:nanoclaw/src/
ssh pi "cd nanoclaw && npm run build && sudo systemctl restart nanoclaw"
```

## WiFi Gotchas

- Bookworm (Debian 12) — Trixie (13) WiFi didn't work
- rfkill-blocked on first boot — `/etc/rc.local` runs `rfkill unblock wifi`
- wpa_supplicant.conf on boot partition didn't auto-copy — created manually
- NetworkManager can't see networks but `iw` can — used wpa_supplicant directly
- `wpa_supplicant@wlan0` systemd service persists across reboots
