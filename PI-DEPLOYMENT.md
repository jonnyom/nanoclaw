# NanoClaw Pi Deployment

NanoClaw running on Raspberry Pi 4 Model B (ARM64, Debian Bookworm).

## Why the Pi

Laptop sleep pauses launchd + containers. Pi is always on, low power, and expendable (just reflash the SD card if anything goes wrong).

## What's Different from Laptop

| Aspect | Laptop (macOS) | Pi |
|--------|---------------|-----|
| Container runtime | Apple Container | Docker |
| Service manager | launchd | systemd |
| Container mode | Sandboxed | Privileged + host networking |
| WiFi | N/A | wpa_supplicant (manually configured) |
| Agent power | Restricted | Full (can install packages, network access) |

### Key Code Changes (Pi-specific)

- `src/container-runtime.ts`: `CONTAINER_RUNTIME_BIN = 'docker'` (was `'container'`), runtime check uses `docker info` instead of `container system status`
- `src/container-runner.ts`: `--privileged --net=host` on all containers, mounts gws/gcloud configs, memory capped at 3GiB
- `container/build.sh`: `CONTAINER_RUNTIME="docker"`
- `container/Dockerfile`: adds `@googleworkspace/cli` and `linear-mcp` to global npm installs

## Services

```bash
# NanoClaw (systemd)
sudo systemctl status nanoclaw
sudo systemctl restart nanoclaw
sudo journalctl -u nanoclaw -f        # live logs

# WiFi
sudo wpa_supplicant -B -i wlan0 -c /etc/wpa_supplicant/wpa_supplicant.conf
sudo dhclient wlan0
```

## Google Workspace

Two accounts authenticated via `gws` CLI:
- **Work**: `gws <command>` → jonny@nory.ai
- **Personal**: `GOOGLE_WORKSPACE_CLI_CONFIG_DIR=~/.config/gws-personal gws <command>` → jonathanomahony@gmail.com

Scopes: Calendar, Gmail, Drive, Tasks, Sheets, Docs, Slides.

OAuth credentials stored in `~/.config/gws/` and `~/.config/gws-personal/`.
Client config from GCP project `tidy-muse-147916`.

To re-auth (headless — needs SSH tunnel):
```bash
# From Mac:
ssh pi "gws auth login --scopes 'email,profile,https://www.googleapis.com/auth/calendar,https://www.googleapis.com/auth/gmail.modify,https://www.googleapis.com/auth/drive,https://www.googleapis.com/auth/tasks'"
# Open URL in browser, grab port from failed redirect, then:
ssh -N -L PORT:localhost:PORT pi
# Reload the page
```

## Linear

Two workspaces via MCP (`linear-mcp` package):
- **linear-nory**: Nory workspace (READ-ONLY)
- **linear-ravell**: Ravell workspace (full access)

Configured in `data/sessions/telegram_main/.claude/settings.json`.

## SSH Access

```
ssh pi    # 192.168.1.156, user: pi, key: ~/.ssh/id_pi
```

## Rebuilding

```bash
ssh pi "cd nanoclaw && npm run build && ./container/build.sh && sudo systemctl restart nanoclaw"
```

## WiFi Gotchas

- Trixie (Debian 13) WiFi didn't work — used Bookworm (Debian 12) instead
- WiFi was rfkill-blocked on first boot — `/etc/rc.local` runs `rfkill unblock wifi`
- wpa_supplicant.conf on boot partition didn't auto-copy — created manually in `/etc/wpa_supplicant/`
- NetworkManager can't see networks but `iw` can — used wpa_supplicant directly
- `wpa_supplicant@wlan0` systemd service persists WiFi across reboots
