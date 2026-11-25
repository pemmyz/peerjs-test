# peerjs-test

## Try it now: https://pemmyz.github.io/peerjs-test/

# PeerJS P2P Chat

A lightweight browser-based peer-to-peer (P2P) chat demo built with vanilla HTML, CSS, and JavaScript. It uses [PeerJS](https://peerjs.com/) for WebRTC signaling and data connections, allowing two browser clients to connect directly and exchange chat messages.

The interface displays both the direct player-to-player ping and the PeerJS signaling-server ping. Players can connect by entering a Peer ID or scanning a dynamically generated QR code.

## Features

- **Peer-to-peer chat:** Exchange text messages over a PeerJS `DataConnection`.
- **Peer ID sharing:** Copy your Peer ID or display it as a QR code.
- **QR-code auto-connect:** Opening a generated join URL automatically attempts to connect to the peer.
- **Automatic reconnection:** Attempts to restore the P2P connection after interruptions, using an increasing retry delay.
- **Signaling reconnection:** Retries the PeerJS Cloud connection after network interruptions.
- **Heartbeat monitoring:** Periodic ping/pong messages detect an unresponsive peer.
- **Ping display:** Shows P2P round-trip time and PeerJS signaling-server response time.
- **Connection status:** Displays connection, disconnection, and error states.
- **Responsive dark interface:** A compact layout suitable for desktop and mobile browsers.

## Project files

```text
.
├── index.html   # Page structure and external library imports
├── style.css    # Dark UI, ping indicators, and QR modal styling
└── script.js    # PeerJS setup, connections, chat, ping, and reconnection logic
```

## Requirements

- A modern browser with JavaScript and WebRTC support.
- An internet connection to load the external libraries and reach the PeerJS signaling service.
- A web server or static web host to serve the project files.

The page loads these libraries from CDNs:

- [PeerJS 1.5.5](https://unpkg.com/peerjs@1.5.5/dist/peerjs.min.js)
- [QRCode.js 1.0.0](https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js)

No build step or package installation is required for the current implementation.

## Running locally

Place `index.html`, `style.css`, and `script.js` in the same directory, then serve that directory using any local HTTP server.

For example, with Python:

```bash
python3 -m http.server 8000
```

Open the page in your browser:

```text
http://localhost:8000/
```

To connect a second device on the same Wi-Fi network, open the page using the host computer's LAN IP address instead of `localhost`. For example:

```text
http://192.168.1.100:8000/
```

Replace the example IP with the actual address of the computer running the server. Ensure that the host firewall allows incoming connections to the chosen port.

> **QR-code note:** A QR code generated while the page is opened through `localhost` contains a localhost URL. Other devices cannot use that address to reach your computer. Open the page using a LAN IP or publicly accessible URL before sharing the QR code.

## Connecting two players

1. Open the page in both browsers.
2. Wait until each client has connected to PeerJS Cloud and received a Peer ID.
3. On one client, copy the displayed Peer ID.
4. On the other client, paste that ID into **Join another player** and select **Connect**.

Alternatively:

1. Select **Show QR Code** on the client you want to join.
2. Scan the QR code using the other device.
3. The scanned URL includes the host's Peer ID as a `join` query parameter. The page will attempt to connect automatically.

A join URL has this general form:

```text
https://example.com/path/?join=PEER_ID
```

The URL is generated from the current page origin and path, so it can work when the project is hosted in a subdirectory as well as at a site's root.

## Network connectivity and NAT

PeerJS uses a signaling service to help browsers establish a WebRTC connection. Once established, chat data is sent through the peer-to-peer data channel rather than being relayed through the PeerJS signaling server.

The current ICE configuration includes these STUN servers:

```javascript
const ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" }
];
```

STUN can help peers discover network paths, but it does not guarantee that a direct connection can be established across every NAT or firewall configuration.

### TURN server support

For networks where a direct P2P path cannot be established, configure a TURN server in `ICE_SERVERS`. The source includes commented examples for TURN and TURN-over-TLS entries.

Add valid server details supplied by your TURN provider:

```javascript
const ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    {
        urls: "turn:your-turn-host.example.com:3478",
        username: "YOUR_USERNAME",
        credential: "YOUR_CREDENTIAL"
    }
];
```

Use the actual URL, port, username, and credential provided by your TURN service. Do not publish long-lived TURN credentials in a public repository. Consider using short-lived credentials issued by a backend if the application is deployed publicly.

**Important:** The current project does not configure a TURN server by default. Connections between different networks, mobile connections, or restrictive NAT/firewall environments may fail without a suitable TURN service. TURN can relay WebRTC traffic when a direct route is unavailable; it is separate from the PeerJS signaling service.

## Ping indicators

The page displays two different measurements:

- **Player Ping (P2P):** Round-trip time measured using ping/pong messages sent over the active peer data connection.
- **Server Ping (PeerJS):** HTTP response time measured against the configured PeerJS signaling endpoint.

The player ping is updated through the heartbeat exchange. The server ping is measured periodically while the PeerJS client is active.

The UI classifies ping values as:

| Display color | Measured latency |
|---|---:|
| Green | Below 80 ms |
| Orange | 80–180 ms |
| Red | Above 180 ms |

These values are simple visual indicators, not guarantees of game or application performance.

## Reconnection behavior

The client includes two recovery mechanisms:

- **PeerJS signaling recovery:** If the PeerJS connection is disconnected, the client attempts to reconnect to the signaling service.
- **P2P recovery:** If the player data connection closes or fails, the client attempts to reconnect to the remembered Peer ID.

P2P retry delays use exponential backoff, starting at 2 seconds and increasing up to 15 seconds. After both clients have connected once, the client with the lexicographically smaller Peer ID is selected as the reconnect leader. This is intended to reduce the chance that both peers repeatedly initiate reconnection at the same time.

A heartbeat is sent every 3 seconds. If no pong is received for 30 seconds, the connection is treated as unresponsive and closed so reconnection can be attempted.

Reconnection is best-effort. It cannot guarantee recovery if the other browser has closed, the remote peer ID is no longer available, or network conditions prevent WebRTC from establishing a connection.

## Configuration

The main timing and ICE settings are near the top of `script.js`:

```javascript
const HEARTBEAT_INTERVAL = 3000;
const HEARTBEAT_TIMEOUT = 30000;
const SERVER_PING_INTERVAL = 10000;
const RECONNECT_BASE_DELAY = 2000;
const RECONNECT_MAX_DELAY = 15000;
```

Adjust these values to change heartbeat frequency, timeout behavior, server ping frequency, and reconnection delays.

The PeerJS client is currently created with its default PeerJS Cloud configuration:

```javascript
peer = new Peer({
    debug: 3,
    config: {
        iceServers: ICE_SERVERS
    }
});
```

The application also derives the signaling-server URL used for its HTTP ping measurement from the PeerJS client's options.

## Limitations and security notes

- This is a two-peer chat demo, not a multi-user chat room or lobby.
- Peer IDs are connection identifiers, not user accounts or authentication.
- The current chat has no end-user identity verification, moderation, message persistence, or application-level encryption/authentication layer.
- WebRTC data channels are encrypted in transit by the WebRTC stack, but this does not authenticate the identity of the person behind a Peer ID.
- A TURN server may relay traffic when direct connectivity fails. The current configuration does not include TURN credentials.
- The project depends on external CDN-hosted libraries and the PeerJS signaling service.
- Do not treat the public PeerJS signaling service as a guaranteed production service. For production deployments, review the service's current terms, limits, and availability, or operate a signaling server you control.
- Do not expose private TURN credentials in client-side source code.

## Technologies

- HTML5
- CSS3
- Vanilla JavaScript
- [PeerJS](https://peerjs.com/)
- WebRTC DataChannels
- STUN / optional TURN
- [QRCode.js](https://github.com/davidshimjs/qrcodejs)

## License

MIT License

Copyright (c) 2026 pemmyz
