# 🐦 Squawk

**Your voice. Your server. Your rules.**

Squawk is a private, self-hosted voice and text chat app built for gaming groups who are done handing their conversations over to big platforms. No accounts. No ads. No data leaving your machine. Just clear voice chat and messaging between you and the people you actually want to talk to.

Built and maintained by [shynsec](https://github.com/shynsec).

---

## Why Squawk?

Most voice chat apps are free because *you* are the product. Your conversations pass through someone else's servers, your data gets logged, and you're one policy change away from losing access.

Squawk flips that. You host it. You control it. Your friends connect through your private Tailscale network — no one else can even see the server exists.

- 🔒 **Fully private** — accessible only to people you invite via Tailscale VPN
- 🏠 **Self-hosted** — runs on your machine, your Proxmox server, or any Linux box
- 🎮 **Built for gaming** — low-latency WebRTC audio, always-on channels, no faff
- 💬 **Voice + text** — chat alongside your voice channels, with typing indicators
- 👑 **Channel ownership** — kick users, rename and delete channels, manage your space
- 📱 **Works on mobile** — responsive layout with a voice/chat tab switcher
- 🔔 **Sound notifications** — subtle audio cues for joins, leaves, and messages
- 🐳 **Docker ready** — spin up with two commands

---

## Quick Start

### Docker (recommended)

The fastest way to get going. Requires [Docker](https://docs.docker.com/get-docker/) and [Docker Compose](https://docs.docker.com/compose/install/).

**1. Clone the repo**
```bash
git clone https://github.com/shynsec/squawk.git
cd squawk
```

**2. Set your domain or Tailscale IP in the Caddyfile**
```bash
# Find your Tailscale IP
tailscale ip -4
```

Open `Caddyfile` and replace `your.domain.com` with your IP or domain:
```
https://100.x.x.x {
    reverse_proxy squawk:3000
    tls internal
}
```

**3. Start it up**
```bash
docker compose up -d
```

That's it. Visit `https://your-ip` in Firefox, click through the self-signed cert warning once, and you're in.

---

### Manual Setup

Requires [Node.js 18+](https://nodejs.org).

```bash
git clone https://github.com/shynsec/squawk.git
cd squawk
npm install
npm start
```

For HTTPS (required for microphone access over a network), use [Caddy](https://caddyserver.com) or [mkcert](https://github.com/FiloSottile/mkcert). See the [HTTPS Setup](#https-setup) section below.

To keep Squawk running in the background:
```bash
npm install -g pm2
pm2 start server.js --name squawk
pm2 save && pm2 startup
```

---

## Connecting with Friends via Tailscale

Squawk is designed to work over [Tailscale](https://tailscale.com) — a zero-config VPN that creates a private network between your devices. Nobody outside your tailnet can reach your server.

**Setup:**
1. Install Tailscale on your server: `curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up`
2. Install Tailscale on each friend's device — [tailscale.com/download](https://tailscale.com/download)
3. Invite friends: [login.tailscale.com/admin/invite](https://login.tailscale.com/admin/invite)
4. Send them your Tailscale IP and tell them to visit `https://100.x.x.x` in Firefox

> **Console players:** Tailscale runs on iOS and Android, so friends on PlayStation or Xbox can use their phone as a companion voice device alongside their console.

---

## HTTPS Setup

Microphone access requires HTTPS when connecting over a network (browsers enforce this).

### Option A — Caddy (recommended)

```bash
sudo apt install caddy
```

Create `/etc/caddy/Caddyfile`:
```
https://YOUR_IP_OR_DOMAIN {
    reverse_proxy localhost:3000
    tls internal
}
```
```bash
sudo systemctl reload caddy
```

### Option B — mkcert

```bash
sudo apt install mkcert libnss3-tools
mkcert -install
mkcert -key-file key.pem -cert-file cert.pem localhost 127.0.0.1 YOUR_TAILSCALE_IP
```

Then update `server.js` to use HTTPS:
```js
const https = require("https");
const fs = require("fs");

const server = https.createServer({
  key: fs.readFileSync("key.pem"),
  cert: fs.readFileSync("cert.pem"),
}, app);
```

---

## Channel Permissions

Whoever creates a channel is its **owner**, shown with a 👑 crown. Ownership passes to the next person if the owner leaves.

| Action | Owner | Member |
|--------|:-----:|:------:|
| Join & use channels | ✅ | ✅ |
| Send messages | ✅ | ✅ |
| Mute yourself | ✅ | ✅ |
| Kick users | ✅ | ❌ |
| Rename channel | ✅ | ❌ |
| Delete channel | ✅ | ❌ |

**How to use owner controls:**
- **Desktop** — right-click a channel in the sidebar to rename or delete. Right-click a user tile to kick.
- **Mobile** — long-press a channel or user tile.

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Port the server listens on |
| `NODE_ENV` | `development` | Set to `production` in Docker |

You can adjust these limits at the top of `server.js`:

| Constant | Default | Description |
|----------|---------|-------------|
| `MAX_ROOMS` | `50` | Maximum number of channels |
| `MAX_USERS_ROOM` | `20` | Maximum users per channel |
| `MAX_NAME_LEN` | `24` | Maximum display name length |
| `MAX_MSG_LEN` | `500` | Maximum chat message length |
| `RATE_MAX_EVENTS` | `30` | Max socket events per 5s per client |

---

## Security

Squawk is built with privacy and security as first principles:

- **Rate limiting** — 30 socket events per 5 seconds per client
- **Input sanitisation** — all usernames, channel names, and messages validated server-side
- **Prototype pollution protection** — `rooms` object uses `Object.create(null)` with reserved key blocklist
- **Room-scoped WebRTC relay** — signaling only forwarded between peers in the same channel
- **Strict CORS** — only accepts connections from localhost and Tailscale IP ranges (`100.x.x.x`)
- **Security headers** — CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy
- **Non-root Docker container** — runs as unprivileged `squawk` user
- **No external data transmission** — everything stays on your server, always

---

## Tech Stack

| | |
|--|--|
| Runtime | Node.js 20 |
| Server | Express 4 |
| Real-time | Socket.io 4 |
| Voice | WebRTC (browser native) |
| Reverse proxy | Caddy 2 |
| Containers | Docker + Docker Compose |
| VPN | Tailscale |
| Frontend | Vanilla HTML / CSS / JS |

No database. No external services. No telemetry. No bullshit.

---

## Roadmap

- [ ] User avatars / profile pictures
- [ ] Push-to-talk mode
- [ ] Channel passwords
- [ ] Persistent message history (SQLite)
- [ ] Admin dashboard

Have an idea? [Open an issue](https://github.com/shynsec/squawk/issues) — contributions are welcome.

---

## Contributing

1. Fork the repo
2. Create your branch: `git checkout -b feature/your-feature`
3. Commit your changes: `git commit -m 'Add your feature'`
4. Push: `git push origin feature/your-feature`
5. Open a pull request

---

## License

[MIT](LICENSE) — do whatever you want with it.
