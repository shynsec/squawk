# VoxLink 🎙️

A lightweight, private voice chat app for gaming with friends — hosted on your own machine, accessible only over Tailscale.

## Requirements

- Node.js 18+
- Tailscale installed and running on your machine
- Friends on your Tailscale tailnet

## Setup & Running

```bash
# Install dependencies
npm install

# Start the server
npm start
```

The server binds to `0.0.0.0:3000`, so it's reachable on all interfaces including Tailscale.

## Sharing with friends

1. Find your Tailscale IP:
   ```bash
   tailscale ip -4
   ```
   It will look like `100.x.x.x`

2. Invite friends to your tailnet via the Tailscale admin panel:
   https://login.tailscale.com/admin/invite

3. Tell your friends to visit:
   ```
   http://100.x.x.x:3000
   ```
   (replace with your actual Tailscale IP)

## How it works

- **Signaling**: Socket.io server (on your machine) coordinates who's in each room and brokers WebRTC connections
- **Voice**: WebRTC peer-to-peer audio — once connected, voice flows directly between peers
- **Privacy**: The server only accepts connections from within your Tailscale network — nobody outside can connect

## Features

- Multiple voice channels (create as many as you want)
- Real-time speaking detection with animated rings
- Per-user volume bars
- Mute toggle
- No accounts or sign-up — just set a display name

## Changing the port

Set the `PORT` environment variable:
```bash
PORT=8080 npm start
```
