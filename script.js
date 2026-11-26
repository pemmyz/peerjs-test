// ==========================================
// PeerJS Host-Relayed Multi-User P2P Chat Room
// First browser acts as Relay Host + Custom nicknames + Buffered delivery queue + Heartbeat + QR Connect
// ==========================================

// DOM elements
const status = document.getElementById("status");
const myId = document.getElementById("my-id");
const remoteId = document.getElementById("remote-id");
const usernameInput = document.getElementById("username");
const saveUsernameBtn = document.getElementById("save-username");
const userListEl = document.getElementById("user-list");
const userCountEl = document.getElementById("user-count");
const messages = document.getElementById("messages");
const messageInput = document.getElementById("message");
const queueStatusEl = document.getElementById("queue-status");
const playerPingEl = document.getElementById("player-ping");
const serverPingEl = document.getElementById("server-ping");

// QR Modal DOM elements
const qrModal = document.getElementById("qr-modal");
const showQrBtn = document.getElementById("show-qr");
const closeQrBtn = document.getElementById("close-qr");
const qrcodeElement = document.getElementById("qrcode");
const qrUrlText = document.getElementById("qr-url-text");

// Configuration
const HEARTBEAT_INTERVAL = 3000;
const MAX_MISSED_PINGS = 5;
const MESSAGE_ACK_TIMEOUT = 10000;
const SERVER_PING_INTERVAL = 10000;
const RECONNECT_BASE_DELAY = 1500;
const RECONNECT_MAX_DELAY = 15000;
const CONNECT_TIMEOUT = 10000;
const HOST_PROMOTION_ATTEMPTS = 3;
const USERNAME_STORAGE_KEY = "peerjs_chat_username";

// ICE Servers (STUN + TURN)
// IMPORTANT: Passing `config.iceServers` to PeerJS replaces its defaults.
// Keep STUN servers here, and uncomment + fill in your TURN server(s)
// (e.g. from Metered.ca or Cloudflare Realtime TURN) for internet connections.
const ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" }

    // Example TURN entries (uncomment and replace with your credentials):
    // ,{
    //     urls: "turn:your-turn-host.example.com:80",
    //     username: "YOUR_USERNAME",
    //     credential: "YOUR_CREDENTIAL"
    // },
    // {
    //     urls: "turns:your-turn-host.example.com:443?transport=tcp",
    //     username: "YOUR_USERNAME",
    //     credential: "YOUR_CREDENTIAL"
    // }
];

// QR Code instance
let qrCodeInstance = null;

// Read query params for auto-connect: ?join=<PEER_ID>
const urlParams = new URLSearchParams(window.location.search);
let autoJoinId = urlParams.get("join");

// PeerJS state
let peer;
let defaultUsername = "User";
let isHost = false;
let attemptingHostClaim = false;
let hostPeerId = null;

// Host-relay state: Map<peerId, PeerEntry> (Host tracks all clients; Clients track the Host)
const peers = new Map();
let roomUsers = []; // Roster synced from Host to Clients

// Reconnection state
let signalingRetryTimer = null;
let signalingRetryAttempts = 0;
let destroyed = false;

// Heartbeat & Ping state
let heartbeatTimer = null;
let serverPingTimer = null;

// Message buffering & deduplication state
let messageCounter = 0;
const globalPendingQueue = []; // Buffered when 0 peers are in the room
const seenMessageIds = new Set(); // Deduplicates incoming messages across reconnects
const sentMessages = new Map(); // msgId -> { totalRecipients: Set, ackedRecipients: Set, statusEl }

// Restore per-tab/per-browser nickname if previously set
const savedUsername = sessionStorage.getItem(USERNAME_STORAGE_KEY);
if (savedUsername) {
    usernameInput.value = savedUsername;
}

// Deterministic Host Peer ID shared by browsers opening the same page/room
function getRoomHostId() {
    const currentParams = new URLSearchParams(window.location.search);
    const room = currentParams.get("room") || "default";
    const key = `${window.location.host}${window.location.pathname}#${room}`;
    let hash = 2166136261;
    for (let i = 0; i < key.length; i++) {
        hash ^= key.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return `p2p-room-host-${(hash >>> 0).toString(36)}`;
}

function generateRoomKey() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
        return window.crypto.randomUUID().split("-")[0];
    }
    return Math.random().toString(36).slice(2, 10);
}

// ==========================================
// UI, PING & URL HELPERS
// ==========================================

function setStatus(text) {
    status.textContent = text;
}

function safeSend(conn, payload) {
    if (!conn || !conn.open) return false;
    try {
        conn.send(payload);
        return true;
    } catch (err) {
        console.warn("DataConnection send failed:", err);
        return false;
    }
}

function sanitizeUsername(name, fallbackId = "") {
    if (typeof name === "string") {
        const trimmed = name.trim().slice(0, 24);
        if (trimmed) return trimmed;
    }
    return fallbackId ? `User-${fallbackId.slice(0, 4)}` : defaultUsername;
}

function getUsername() {
    return sanitizeUsername(usernameInput.value, peer && peer.id ? peer.id : "");
}

function formatTime(ts) {
    return new Date(ts || Date.now()).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit"
    });
}

function addMessage(sender, message, options = {}) {
    const item = document.createElement("p");
    item.className = "msg-row";

    const timeSpan = document.createElement("span");
    timeSpan.className = "msg-time";
    timeSpan.textContent = `[${formatTime(options.timestamp)}]`;

    const textSpan = document.createElement("span");
    textSpan.textContent = `${sender}: ${message}`;

    item.appendChild(timeSpan);
    item.appendChild(textSpan);

    let statusSpan = null;
    if (options.isSelf) {
        statusSpan = document.createElement("span");
        statusSpan.className = "msg-status queued";
        statusSpan.textContent = options.initialStatus || "[Queued]";
        item.appendChild(statusSpan);
    }

    messages.appendChild(item);
    messages.scrollTop = messages.scrollHeight;
    return statusSpan;
}

function addSystemMessage(text) {
    addMessage("SYSTEM", text);
}

function renderUserList() {
    if (!userListEl) return;

    userListEl.innerHTML = "";

    if (!isHost && roomUsers.length > 0) {
        let activeCount = 0;
        for (const u of roomUsers) {
            if (u.connected) activeCount++;
            const isSelf = peer && u.id === peer.id;
            const isRelay = u.role === "host";
            const li = document.createElement("li");
            li.className = "user-item";

            const roleMeta = isRelay ? " · Relay Host" : "";
            const selfMeta = isSelf ? " · You" : "";
            const statusClass = isRelay ? "host" : (u.connected ? "connected" : "reconnecting");
            const statusLabel = isRelay ? "Host" : (u.connected ? "Connected" : "Reconnecting");

            li.innerHTML = `
                <div>
                    <strong>${escapeHtml(u.username)}</strong>
                    <span class="user-meta">(${escapeHtml(u.id.slice(0, 8))}…${roleMeta}${selfMeta})</span>
                </div>
                <span class="user-status ${statusClass}">${statusLabel}</span>
            `;
            userListEl.appendChild(li);
        }
        if (userCountEl) {
            userCountEl.textContent = String(activeCount || roomUsers.length);
        }
        return;
    }

    // Host view (or Client before first roster sync)
    const selfLi = document.createElement("li");
    selfLi.className = "user-item";
    const selfRole = isHost ? " · Relay Host" : "";
    selfLi.innerHTML = `<div><strong>${escapeHtml(getUsername())}</strong> <span class="user-meta">(You${selfRole}${peer && peer.id ? ` · ${escapeHtml(peer.id.slice(0, 8))}…` : ""})</span></div><span class="user-status ${isHost ? "host" : "connected"}">${isHost ? "Host" : "Online"}</span>`;
    userListEl.appendChild(selfLi);

    let activeCount = 1;
    for (const entry of peers.values()) {
        if (entry.left) continue;

        const isOpen = Boolean(entry.conn && entry.conn.open);
        if (isOpen) activeCount++;

        const li = document.createElement("li");
        li.className = "user-item";

        const pingText = isOpen && typeof entry.rtt === "number" ? ` · ${entry.rtt} ms` : "";
        const queueText = entry.outbox.length > 0 ? ` · ${entry.outbox.length} queued` : "";
        const roleLabel = !isHost && entry.id === hostPeerId ? " · Relay Host" : "";

        li.innerHTML = `
            <div>
                <strong>${escapeHtml(entry.username)}</strong>
                <span class="user-meta">(${escapeHtml(entry.id.slice(0, 8))}…${roleLabel}${pingText}${queueText})</span>
            </div>
            <span class="user-status ${isOpen ? "connected" : "reconnecting"}">
                ${isOpen ? "Connected" : "Reconnecting"}
            </span>
        `;
        userListEl.appendChild(li);
    }

    if (userCountEl) {
        userCountEl.textContent = String(activeCount);
    }
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function updateAggregatedPing() {
    const rtts = [];
    for (const entry of peers.values()) {
        if (entry.conn && entry.conn.open && typeof entry.rtt === "number") {
            rtts.push(entry.rtt);
        }
    }

    if (rtts.length === 0) {
        updatePingUI(playerPingEl, null);
        return;
    }

    const avg = Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length);
    updatePingUI(playerPingEl, avg);
}

function updateRoomStatus() {
    if (isHost) {
        const openCount = Array.from(peers.values()).filter(e => e.conn && e.conn.open).length;
        setStatus(`Hosting room relay (${openCount} client${openCount === 1 ? "" : "s"} connected)`);
        return;
    }

    const openCount = Array.from(peers.values()).filter(e => e.conn && e.conn.open).length;
    if (openCount > 0) {
        setStatus("Connected to room relay host");
    } else if (peers.size > 0) {
        setStatus("Relay host disconnected. Reconnecting...");
    } else if (peer && peer.id && !peer.disconnected) {
        setStatus("Connected to PeerJS Cloud");
    }
}

function updateQueueStatusUI() {
    if (!queueStatusEl) return;

    const pendingIds = new Set(globalPendingQueue.map(m => m.id));
    for (const entry of peers.values()) {
        for (const item of entry.outbox) {
            pendingIds.add(item.id);
        }
    }

    if (pendingIds.size > 0) {
        queueStatusEl.textContent = `Buffered messages waiting for delivery: ${pendingIds.size}`;
    } else if (sentMessages.size > 0) {
        queueStatusEl.textContent = "All sent messages delivered.";
    } else {
        queueStatusEl.textContent = "";
    }
}

function updatePingUI(element, ms) {
    if (!element) return;

    element.classList.remove("ping-good", "ping-medium", "ping-bad");

    if (typeof ms !== "number" || Number.isNaN(ms)) {
        element.textContent = "-- ms";
        return;
    }

    element.textContent = `${ms} ms`;

    if (ms < 80) {
        element.classList.add("ping-good");
    } else if (ms <= 180) {
        element.classList.add("ping-medium");
    } else {
        element.classList.add("ping-bad");
    }
}

// Dynamically resolves to current origin + path (e.g., GitHub Pages subpath or local IP)
function getBaseUrl() {
    return `${window.location.origin}${window.location.pathname}`;
}

function getSignalingHttpUrl() {
    const opts = (peer && peer.options) || {};
    const protocol = opts.secure === false ? "http" : "https";
    const host = opts.host || "0.peerjs.com";
    const port = opts.port ? `:${opts.port}` : "";
    const path = opts.path || "/";
    return `${protocol}://${host}${port}${path}`;
}

// ==========================================
// SERVER PING (PEERJS SIGNALING SERVER)
// ==========================================

async function measureServerPing() {
    if (destroyed) return;

    const url = `${getSignalingHttpUrl()}?_=${Date.now()}`;
    const start = performance.now();

    try {
        const response = await fetch(url, {
            method: "GET",
            cache: "no-store"
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const rtt = Math.max(0, Math.round(performance.now() - start));
        updatePingUI(serverPingEl, rtt);
    } catch (error) {
        console.warn("Server ping failed:", error);
        updatePingUI(serverPingEl, null);
    }
}

function startServerPing() {
    stopServerPing();
    measureServerPing();

    serverPingTimer = setInterval(() => {
        measureServerPing();
    }, SERVER_PING_INTERVAL);
}

function stopServerPing() {
    if (serverPingTimer) {
        clearInterval(serverPingTimer);
        serverPingTimer = null;
    }
}

// ==========================================
// INITIALIZE PEERJS
// ==========================================

function initializePeer() {
    const hasTurnServer = ICE_SERVERS.some(server => {
        const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
        return urls.some(u => typeof u === "string" && (u.startsWith("turn:") || u.startsWith("turns:")));
    });

    if (!hasTurnServer) {
        console.warn("No TURN server configured in ICE_SERVERS. Connections across different networks/mobile data may hang at ICE negotiation.");
    }

    const defaultHostId = getRoomHostId();

    if (autoJoinId) {
        // Explicit ?join=<HOST_ID> link: join directly as a Client
        startClientPeer(autoJoinId);
    } else {
        // First browser to load claims the shared Host ID; others fall back to Client
        startHostPeer(defaultHostId);
    }
}

function startHostPeer(targetHostId) {
    attemptingHostClaim = true;
    isHost = true;
    hostPeerId = targetHostId;
    destroyed = false;

    setStatus("Starting room (claiming relay host)...");

    const currentPeer = new Peer(targetHostId, {
        debug: 3,
        config: {
            iceServers: ICE_SERVERS
        }
    });
    peer = currentPeer;
    attachPeerListeners(currentPeer);
}

function startClientPeer(targetHostId) {
    attemptingHostClaim = false;
    isHost = false;
    hostPeerId = targetHostId;
    destroyed = false;

    setStatus("Connecting as client to relay host...");

    const currentPeer = new Peer({
        debug: 3,
        config: {
            iceServers: ICE_SERVERS
        }
    });
    peer = currentPeer;
    attachPeerListeners(currentPeer);
}

function attachPeerListeners(currentPeer) {
    currentPeer.on("open", id => {
        if (peer !== currentPeer) return;
        console.log("PeerJS connected:", id);

        attemptingHostClaim = false;
        signalingRetryAttempts = 0;
        myId.textContent = id;
        defaultUsername = `User-${id.slice(0, 4)}`;
        if (!usernameInput.value.trim()) {
            usernameInput.placeholder = `Nickname (default: ${defaultUsername})`;
        }

        renderUserList();
        updateRoomStatus();

        startServerPing();

        if (!isHost && hostPeerId && hostPeerId !== id && !peers.has(hostPeerId)) {
            console.log("Auto-connecting to relay host:", hostPeerId);
            remoteId.value = hostPeerId;
            connectToPlayer(hostPeerId);
            return;
        }

        // If signaling recovered and any peer P2P links are down
        if (!isHost) {
            for (const entry of peers.values()) {
                if ((!entry.conn || !entry.conn.open) && !entry.left) {
                    scheduleReconnect(entry.id);
                }
            }
        }
    });

    // Incoming connection
    currentPeer.on("connection", conn => {
        if (peer !== currentPeer) return;
        console.log("Incoming connection:", conn.peer);

        if (!isHost) {
            console.warn("Ignoring incoming connection because this peer is a client");
            conn.close();
            return;
        }

        const existing = peers.get(conn.peer);
        if (existing && existing.conn && existing.conn !== conn) {
            // Replace stale/half-open connection when a client reconnects with the same Peer ID
            const staleConn = existing.conn;
            existing.conn = null;
            existing.rtt = null;
            existing.awaitingPong = false;
            existing.unansweredPings = 0;
            clearConnectTimer(existing);
            markOutboxUnsent(existing);
            try {
                staleConn.close();
            } catch (e) {
                // ignore
            }
        }

        setupConnection(conn);
    });

    currentPeer.on("disconnected", () => {
        if (peer !== currentPeer) return;
        console.warn("PeerJS Cloud disconnected");
        setStatus("Lost PeerJS Cloud connection...");
        updatePingUI(serverPingEl, null);
        retrySignaling();
    });

    currentPeer.on("error", error => {
        if (peer !== currentPeer) return;

        // Another browser already opened first and holds the Host ID -> join as Client
        if (attemptingHostClaim && error.type === "unavailable-id") {
            console.log("Relay host already active; joining as client...");
            attemptingHostClaim = false;
            peer = null;
            try {
                currentPeer.destroy();
            } catch (e) {
                // ignore
            }
            setTimeout(() => {
                if (!destroyed) {
                    startClientPeer(hostPeerId);
                }
            }, 150);
            return;
        }

        console.error("PeerJS error:", error);
        setStatus("PeerJS error: " + error.type);

        if (error.type === "peer-unavailable") {
            const match = error.message && error.message.match(/peer\s+([^\s]+)/i);
            const unavailableId = (match && match[1]) || hostPeerId;

            if (!isHost && unavailableId && peers.has(unavailableId)) {
                const entry = peers.get(unavailableId);
                clearConnectTimer(entry);
                if (entry.conn && !entry.conn.open) {
                    entry.conn = null;
                    entry.rtt = null;
                }
                if (!entry.left) {
                    if (
                        !autoJoinId &&
                        unavailableId === getRoomHostId() &&
                        entry.reconnectAttempts >= HOST_PROMOTION_ATTEMPTS
                    ) {
                        promoteToHost(entry);
                    } else {
                        scheduleReconnect(unavailableId);
                    }
                }
                renderUserList();
            }
        }

        if (error.type === "network") {
            updatePingUI(serverPingEl, null);
            retrySignaling();
        }
    });

    currentPeer.on("close", () => {
        if (peer !== currentPeer) return;
        console.log("PeerJS instance closed");
        stopServerPing();
        updatePingUI(serverPingEl, null);
    });
}

// ==========================================
// PEERJS CLOUD RECONNECTION
// ==========================================

function retrySignaling() {
    if (signalingRetryTimer || destroyed) return;

    signalingRetryTimer = setTimeout(() => {
        signalingRetryTimer = null;

        if (destroyed) return;

        if (!peer || peer.destroyed || signalingRetryAttempts >= 3) {
            console.log("Recreating PeerJS signaling session...");
            signalingRetryAttempts = 0;
            const oldPeer = peer;
            peer = null;
            if (oldPeer && !oldPeer.destroyed) {
                try {
                    oldPeer.destroy();
                } catch (e) {
                    // ignore
                }
            }
            if (isHost) {
                startHostPeer(hostPeerId || getRoomHostId());
            } else {
                startClientPeer(hostPeerId || getRoomHostId());
            }
            return;
        }

        if (peer.disconnected) {
            signalingRetryAttempts++;
            console.log("Reconnecting to PeerJS Cloud...");
            try {
                peer.reconnect();
            } catch (error) {
                console.error("Signaling reconnect failed:", error);
            }
            if (peer.disconnected) retrySignaling();
        }
    }, 3000);
}

window.addEventListener("online", () => {
    console.log("Internet connection restored");

    measureServerPing();

    if (!peer || peer.destroyed || peer.disconnected) {
        retrySignaling();
    }

    if (!isHost) {
        for (const entry of peers.values()) {
            if ((!entry.conn || !entry.conn.open) && !entry.left) {
                scheduleReconnect(entry.id);
            }
        }
    }
});

window.addEventListener("offline", () => {
    console.warn("Internet connection lost");
    setStatus("Internet disconnected...");
    updatePingUI(serverPingEl, null);
    updatePingUI(playerPingEl, null);
    renderUserList();
});

// ==========================================
// HOST-RELAY REGISTRY & HELPERS
// ==========================================

function getOrCreatePeer(peerId, username = null) {
    let entry = peers.get(peerId);
    if (!entry) {
        entry = {
            id: peerId,
            username: sanitizeUsername(username, peerId),
            conn: null,
            hasConnectedOnce: false,
            announcedJoin: false,
            left: false,
            lastPong: Date.now(),
            unansweredPings: 0,
            awaitingPong: false,
            rtt: null,
            reconnectAttempts: 0,
            reconnectTimer: null,
            connectTimer: null,
            outbox: []
        };
        peers.set(peerId, entry);
    } else if (username) {
        entry.username = sanitizeUsername(username, peerId);
    }
    return entry;
}

function clearReconnectTimer(entry) {
    if (entry.reconnectTimer) {
        clearTimeout(entry.reconnectTimer);
        entry.reconnectTimer = null;
    }
}

function clearConnectTimer(entry) {
    if (entry.connectTimer) {
        clearTimeout(entry.connectTimer);
        entry.connectTimer = null;
    }
}

function broadcastToOpenPeers(payload, excludePeerId = null) {
    for (const entry of peers.values()) {
        if (entry.id !== excludePeerId && entry.conn && entry.conn.open) {
            try {
                entry.conn.send(payload);
            } catch (e) {
                console.warn("Broadcast failed to", entry.id, e);
            }
        }
    }
}

function buildRoomRoster() {
    const list = [
        {
            id: peer.id,
            username: getUsername(),
            role: "host",
            connected: true
        }
    ];
    for (const entry of peers.values()) {
        if (entry.left) continue;
        list.push({
            id: entry.id,
            username: entry.username,
            role: "client",
            connected: Boolean(entry.conn && entry.conn.open)
        });
    }
    return list;
}

function broadcastRoomRoster() {
    if (!isHost || !peer || !peer.id) return;
    broadcastToOpenPeers({
        type: "room-users",
        users: buildRoomRoster()
    });
}

function relayChatMessage(originPeerId, chatPayload) {
    if (!isHost) return;

    for (const entry of peers.values()) {
        if (entry.id === originPeerId || entry.left) continue;

        entry.outbox.push({
            id: chatPayload.id,
            message: chatPayload.message,
            senderId: chatPayload.senderId,
            senderName: chatPayload.senderName,
            timestamp: chatPayload.timestamp,
            sent: false
        });
        flushPeerOutbox(entry);
    }
    updateQueueStatusUI();
}

function broadcastSystemEvent(text, excludePeerId = null) {
    addSystemMessage(text);
    if (isHost) {
        broadcastToOpenPeers({ type: "system", text }, excludePeerId);
    }
}

// ==========================================
// CONNECT TO HOST / RELAY
// ==========================================

function connectToPlayer(id, isAuto = false) {
    id = id.trim();

    if (!id) return;

    if (!peer || !peer.id) {
        setStatus("PeerJS is not ready yet");
        return;
    }

    if (id === peer.id) {
        setStatus("You are already hosting this room!");
        return;
    }

    // Switching to act as a client connected to the specified host ID
    if (isHost) {
        if (peers.size > 0) {
            setStatus("Already hosting active room clients; open another browser to join as client.");
            return;
        }
        for (const entry of peers.values()) {
            if (entry.conn) {
                try {
                    entry.conn.close();
                } catch (e) {
                    // ignore
                }
            }
        }
        peers.clear();
        isHost = false;
    }
    hostPeerId = id;

    const entry = getOrCreatePeer(id);
    entry.left = false;

    if (entry.conn && entry.conn.open) {
        if (!isAuto) setStatus("Already connected to this user!");
        return;
    }

    if (entry.conn && !entry.conn.open) {
        if (!isAuto) setStatus("Connection already in progress...");
        return;
    }

    if (!isAuto) {
        entry.reconnectAttempts = 0;
        setStatus("Connecting to relay host...");
    }

    const conn = peer.connect(id, {
        reliable: true
    });

    setupConnection(conn);
}

function createNewRoom() {
    // Notify current room before switching
    broadcastToOpenPeers({
        type: "leave",
        peerId: peer ? peer.id : null
    });

    stopHeartbeat();

    for (const entry of peers.values()) {
        clearReconnectTimer(entry);
        clearConnectTimer(entry);
        if (entry.conn) {
            try {
                entry.conn.close();
            } catch (e) {
                // ignore
            }
        }
    }

    peers.clear();
    roomUsers = [];
    globalPendingQueue.length = 0;
    seenMessageIds.clear();
    sentMessages.clear();
    messages.innerHTML = "";
    remoteId.value = "";
    autoJoinId = null;
    attemptingHostClaim = false;
    signalingRetryAttempts = 0;

    const oldPeer = peer;
    peer = null;
    if (oldPeer && !oldPeer.destroyed) {
        try {
            oldPeer.destroy();
        } catch (e) {
            // ignore
        }
    }

    const newRoomKey = generateRoomKey();
    const newUrl = `${getBaseUrl()}?room=${encodeURIComponent(newRoomKey)}`;
    window.history.replaceState({}, "", newUrl);

    myId.textContent = "Connecting...";
    updatePingUI(playerPingEl, null);
    updateQueueStatusUI();
    renderUserList();
    addSystemMessage(`Created new room (key: ${newRoomKey})`);

    setTimeout(() => {
        if (!destroyed) {
            startHostPeer(getRoomHostId());
        }
    }, 100);
}

function promoteToHost(oldHostEntry) {
    console.log("Default room host unavailable; promoting this client to relay host...");

    if (oldHostEntry) {
        clearReconnectTimer(oldHostEntry);
        clearConnectTimer(oldHostEntry);
        for (const item of oldHostEntry.outbox) {
            if (!globalPendingQueue.some(q => q.id === item.id)) {
                globalPendingQueue.push({
                    id: item.id,
                    message: item.message,
                    senderId: item.senderId,
                    senderName: item.senderName,
                    timestamp: item.timestamp
                });
            }
        }
    }

    peers.clear();
    roomUsers = [];

    const oldPeer = peer;
    peer = null;
    if (oldPeer && !oldPeer.destroyed) {
        try {
            oldPeer.destroy();
        } catch (e) {
            // ignore
        }
    }

    addSystemMessage("Previous host left. Becoming the new room relay host...");
    setTimeout(() => {
        if (!destroyed) {
            startHostPeer(getRoomHostId());
        }
    }, 150);
}

function forceDisconnectAndReconnect(entry, reason) {
    if (!entry) return;

    console.warn(`Disconnecting peer ${entry.id}: ${reason}`);
    clearConnectTimer(entry);

    const oldConn = entry.conn;
    entry.conn = null;
    entry.rtt = null;
    entry.awaitingPong = false;
    entry.unansweredPings = 0;
    if (!isHost) roomUsers = [];
    markOutboxUnsent(entry);

    if (oldConn) {
        try {
            oldConn.close();
        } catch (e) {
            // ignore
        }
    }

    if (!entry.left) {
        if (entry.announcedJoin) {
            if (isHost) {
                broadcastSystemEvent(`${entry.username} lost connection (${reason}). Waiting to reconnect...`, entry.id);
            } else {
                addSystemMessage(`Disconnected (${reason}). Reconnecting to chatroom...`);
            }
        }
        entry.announcedJoin = false;
        if (!isHost) scheduleReconnect(entry.id);
    }

    if (isHost) broadcastRoomRoster();
    renderUserList();
    updateRoomStatus();
    updateAggregatedPing();
    updateQueueStatusUI();
}

// ==========================================
// CONNECTION MANAGEMENT
// ==========================================

function setupConnection(conn) {
    const entry = getOrCreatePeer(conn.peer);
    entry.left = false;
    clearConnectTimer(entry);

    if (entry.conn && entry.conn !== conn && !entry.conn.open) {
        try {
            entry.conn.close();
        } catch (e) {
            console.warn("Failed closing stale connection:", e);
        }
    }

    entry.conn = conn;
    renderUserList();

    console.log("Setting up connection:", conn.peer);

    // Prevent outgoing client connections from hanging forever in ICE checking
    if (!isHost && !conn.open) {
        entry.connectTimer = setTimeout(() => {
            entry.connectTimer = null;
            if (destroyed || entry.left || entry.conn !== conn || conn.open) return;
            console.warn("Connection attempt timed out for", entry.id);
            entry.conn = null;
            entry.rtt = null;
            try {
                conn.close();
            } catch (e) {
                // ignore
            }
            renderUserList();
            scheduleReconnect(entry.id);
        }, CONNECT_TIMEOUT);
    }

    conn.on("iceStateChanged", state => {
        console.log("ICE state:", state);

        if (entry.conn !== conn) return;

        if (state === "failed" || (state === "closed" && !conn.open)) {
            forceDisconnectAndReconnect(entry, `ICE ${state}`);
        }
    });

    conn.on("open", () => {
        console.log("P2P connection established");

        clearConnectTimer(entry);
        entry.hasConnectedOnce = true;
        entry.reconnectAttempts = 0;
        entry.lastPong = Date.now();
        entry.unansweredPings = 0;
        entry.awaitingPong = false;
        clearReconnectTimer(entry);

        // Close the QR modal automatically once connected
        closeQrModal();

        ensureHeartbeatRunning();
        sendPingToPeer(entry);

        safeSend(conn, {
            type: "hello",
            peerId: peer.id,
            username: getUsername(),
            timestamp: Date.now()
        });

        flushGlobalPendingQueue();
        flushPeerOutbox(entry);
        if (isHost) {
            broadcastRoomRoster();
        }
        updateRoomStatus();
        renderUserList();
    });

    conn.on("data", data => {
        if (!data || typeof data !== "object") return;

        // Heartbeat & P2P Ping
        if (data.type === "ping") {
            safeSend(conn, {
                type: "pong",
                sentAt: data.sentAt
            });
            return;
        }

        if (data.type === "pong") {
            entry.lastPong = Date.now();
            entry.unansweredPings = 0;
            entry.awaitingPong = false;
            if (typeof data.sentAt === "number") {
                entry.rtt = Math.max(0, Math.round(performance.now() - data.sentAt));
                updateAggregatedPing();
                renderUserList();
            }
            return;
        }

        // Handshake
        if (data.type === "hello") {
            entry.username = sanitizeUsername(data.username, entry.id);

            if (isHost) {
                if (!entry.announcedJoin) {
                    entry.announcedJoin = true;
                    broadcastSystemEvent(`${entry.username} joined the room`, entry.id);
                }
                broadcastRoomRoster();
            } else if (!entry.announcedJoin) {
                entry.announcedJoin = true;
                addSystemMessage(`Connected to relay host (${entry.username})`);
            }

            renderUserList();
            flushPeerOutbox(entry);
            return;
        }

        if (data.type === "room-users" && !isHost) {
            if (Array.isArray(data.users)) {
                roomUsers = data.users;
                renderUserList();
            }
            return;
        }

        if (data.type === "system" && !isHost) {
            if (data.text) {
                addSystemMessage(data.text);
            }
            return;
        }

        if (data.type === "username-update") {
            const oldName = entry.username;
            entry.username = sanitizeUsername(data.username, entry.id);
            if (oldName !== entry.username) {
                if (isHost) {
                    broadcastSystemEvent(`${oldName} is now known as ${entry.username}`, entry.id);
                    broadcastRoomRoster();
                } else {
                    addSystemMessage(`${oldName} is now known as ${entry.username}`);
                }
            }
            renderUserList();
            return;
        }

        if (data.type === "leave") {
            if (!isHost) {
                // Host closed/reloaded: keep host entry and outbox so client reconnects automatically
                clearConnectTimer(entry);
                roomUsers = [];
                entry.conn = null;
                entry.rtt = null;
                entry.announcedJoin = false;
                markOutboxUnsent(entry);
                addSystemMessage("Relay host went offline. Waiting to reconnect...");
                renderUserList();
                updateRoomStatus();
                updateAggregatedPing();
                scheduleReconnect(entry.id);
                return;
            }

            entry.left = true;
            clearReconnectTimer(entry);
            broadcastSystemEvent(`${entry.username} left the room`, entry.id);

            if (entry.conn) {
                try {
                    entry.conn.close();
                } catch (e) {
                    // ignore
                }
            }

            peers.delete(entry.id);
            for (const [msgId, record] of sentMessages.entries()) {
                if (!record.ackedRecipients.has(entry.id)) {
                    record.totalRecipients.delete(entry.id);
                    updateSentMessageStatus(msgId);
                }
            }
            broadcastRoomRoster();
            renderUserList();
            updateRoomStatus();
            updateAggregatedPing();
            updateQueueStatusUI();
            return;
        }

        // Delivery ACK
        if (data.type === "ack") {
            handleMessageAck(entry, data.msgId);
            return;
        }

        // Chat message
        if (data.type === "chat") {
            if (data.id) {
                safeSend(conn, {
                    type: "ack",
                    msgId: data.id
                });

                if (seenMessageIds.has(data.id)) {
                    return;
                }
                seenMessageIds.add(data.id);
            }

            const senderLabel = sanitizeUsername(data.senderName || entry.username, entry.id);
            addMessage(senderLabel, data.message, { timestamp: data.timestamp });

            // Host relays every incoming client message to all other clients
            if (isHost) {
                relayChatMessage(entry.id, {
                    id: data.id,
                    message: data.message,
                    senderId: data.senderId || entry.id,
                    senderName: senderLabel,
                    timestamp: data.timestamp
                });
            }
            return;
        }
    });

    conn.on("close", () => {
        if (entry.conn !== conn) return;

        console.warn("P2P connection closed");

        clearConnectTimer(entry);
        entry.conn = null;
        entry.rtt = null;
        if (!isHost) roomUsers = [];
        markOutboxUnsent(entry);

        if (!entry.left) {
            if (entry.announcedJoin) {
                if (isHost) {
                    broadcastSystemEvent(`${entry.username} disconnected (messages will be queued)`, entry.id);
                } else {
                    addSystemMessage("Relay host disconnected (messages will be queued)");
                }
            }
            entry.announcedJoin = false;
            if (!isHost) scheduleReconnect(entry.id);
        }

        if (isHost) broadcastRoomRoster();
        renderUserList();
        updateRoomStatus();
        updateAggregatedPing();
        updateQueueStatusUI();
    });

    conn.on("error", error => {
        console.error("DataConnection error:", error);

        if (entry.conn === conn && !conn.open) {
            clearConnectTimer(entry);
            entry.conn = null;
            entry.rtt = null;
            if (!isHost) roomUsers = [];
            markOutboxUnsent(entry);
            if (!isHost && !entry.left) {
                scheduleReconnect(entry.id);
            }
        }

        renderUserList();
        updateRoomStatus();
        updateAggregatedPing();
    });
}

// ==========================================
// MESSAGE BUFFERING & DELIVERY QUEUE
// ==========================================

function markOutboxUnsent(entry) {
    for (const item of entry.outbox) {
        item.sent = false;
        delete item.sentAt;
    }
}

function flushGlobalPendingQueue() {
    if (globalPendingQueue.length === 0) return;

    const activePeers = Array.from(peers.values()).filter(e => !e.left);
    if (activePeers.length === 0) return;

    const queued = globalPendingQueue.splice(0);
    for (const item of queued) {
        const record = sentMessages.get(item.id);
        for (const entry of activePeers) {
            if (record) record.totalRecipients.add(entry.id);
            entry.outbox.push({
                id: item.id,
                message: item.message,
                senderId: (item.senderId && item.senderId !== "pending") ? item.senderId : peer.id,
                senderName: item.senderName || getUsername(),
                timestamp: item.timestamp,
                sent: false
            });
        }
        updateSentMessageStatus(item.id);
    }

    for (const entry of activePeers) {
        flushPeerOutbox(entry);
    }
    updateQueueStatusUI();
}

function flushPeerOutbox(entry) {
    if (!entry.conn || !entry.conn.open || entry.outbox.length === 0) return;

    for (const item of entry.outbox) {
        if (item.sent) continue;

        const senderId = item.senderId && item.senderId !== "pending" ? item.senderId : peer.id;
        const ok = safeSend(entry.conn, {
            type: "chat",
            id: item.id,
            message: item.message,
            senderId,
            senderName: item.senderName || getUsername(),
            timestamp: item.timestamp
        });

        if (ok) {
            item.sent = true;
            item.sentAt = Date.now();
        } else {
            item.sent = false;
            forceDisconnectAndReconnect(entry, "Message delivery failed");
            return;
        }
    }

    renderUserList();
}

function checkMessageDeliveryTimeouts(entry) {
    if (!entry.conn || !entry.conn.open || entry.outbox.length === 0) return false;

    const now = Date.now();
    const timedOut = entry.outbox.some(
        item => item.sent && typeof item.sentAt === "number" && now - item.sentAt >= MESSAGE_ACK_TIMEOUT
    );

    if (timedOut) {
        forceDisconnectAndReconnect(entry, "Message delivery timed out (no ACK)");
        return true;
    }
    return false;
}

function handleMessageAck(entry, msgId) {
    if (!msgId) return;

    entry.outbox = entry.outbox.filter(item => item.id !== msgId);

    const record = sentMessages.get(msgId);
    if (record) {
        record.ackedRecipients.add(entry.id);
        updateSentMessageStatus(msgId);
    }

    renderUserList();
    updateQueueStatusUI();
}

function updateSentMessageStatus(msgId) {
    const record = sentMessages.get(msgId);
    if (!record || !record.statusEl) return;

    const total = record.totalRecipients.size;
    const acked = record.ackedRecipients.size;

    record.statusEl.classList.remove("queued", "delivered");

    if (total === 0) {
        record.statusEl.classList.add("queued");
        record.statusEl.textContent = "[Queued: waiting for users]";
    } else if (acked >= total) {
        record.statusEl.classList.add("delivered");
        record.statusEl.textContent = total > 1 ? `[Delivered ${acked}/${total}]` : "[Delivered]";
    } else {
        record.statusEl.classList.add("queued");
        record.statusEl.textContent = `[Buffered ${acked}/${total}]`;
    }
}

// ==========================================
// HEARTBEAT & P2P PING
// ==========================================

function sendPingToPeer(entry, fromVisibility = false) {
    if (!entry.conn || !entry.conn.open) return;

    if (!fromVisibility && entry.awaitingPong) {
        entry.unansweredPings = (entry.unansweredPings || 0) + 1;
    }

    if (entry.unansweredPings >= MAX_MISSED_PINGS) {
        forceDisconnectAndReconnect(entry, `No response to ${MAX_MISSED_PINGS} pings in a row`);
        return;
    }

    entry.awaitingPong = true;
    const ok = safeSend(entry.conn, {
        type: "ping",
        sentAt: performance.now(),
        timestamp: Date.now()
    });

    if (!ok) {
        forceDisconnectAndReconnect(entry, "Ping send failed");
    }
}

// Reset background-tab throttling grace window when user focuses a browser window again
document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    const now = Date.now();
    for (const entry of peers.values()) {
        if (entry.conn && entry.conn.open) {
            entry.lastPong = now;
            entry.unansweredPings = 0;
            entry.awaitingPong = false;
            for (const item of entry.outbox) {
                if (item.sent) item.sentAt = now;
            }
            sendPingToPeer(entry, true);
        } else if (!isHost && !entry.left) {
            scheduleReconnect(entry.id);
        }
    }
});

function ensureHeartbeatRunning() {
    if (heartbeatTimer) return;

    heartbeatTimer = setInterval(() => {
        let hasOpen = false;
        for (const entry of peers.values()) {
            if (entry.conn && entry.conn.open) {
                hasOpen = true;
                if (checkMessageDeliveryTimeouts(entry)) continue;
                sendPingToPeer(entry);
            }
        }
        if (!hasOpen && peers.size === 0) {
            stopHeartbeat();
        }
    }, HEARTBEAT_INTERVAL);
}

function stopHeartbeat() {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
}

// ==========================================
// AUTOMATIC P2P RECONNECTION
// ==========================================

function scheduleReconnect(peerId) {
    if (isHost) return; // Clients always dial the Host; Host does not dial clients
    if (destroyed) return;
    if (!peerId) return;

    const entry = peers.get(peerId);
    if (!entry || entry.left) return;

    if (entry.reconnectTimer) return;

    if (entry.conn && entry.conn.open) return;

    const delay = Math.min(
        RECONNECT_BASE_DELAY * Math.pow(2, entry.reconnectAttempts),
        RECONNECT_MAX_DELAY
    );

    entry.reconnectAttempts++;

    console.log(`Reconnect attempt to ${peerId} in ${delay}ms`);

    entry.reconnectTimer = setTimeout(() => {
        entry.reconnectTimer = null;

        if (destroyed) return;
        if (entry.left || (entry.conn && entry.conn.open)) return;

        if (!peer || peer.destroyed || peer.disconnected || !peer.id) {
            retrySignaling();
            scheduleReconnect(peerId);
            return;
        }

        console.log("Attempting P2P reconnection to", peerId);
        updateRoomStatus();

        const conn = peer.connect(peerId, {
            reliable: true
        });

        setupConnection(conn);

    }, delay);
}

// ==========================================
// QR CODE MANAGEMENT
// ==========================================

function openQrModal() {
    if (!peer || !peer.id) {
        setStatus("Peer ID not ready yet. Please wait...");
        return;
    }

    const baseUrl = getBaseUrl();
    const targetId = isHost ? peer.id : (hostPeerId || peer.id);
    const joinUrl = `${baseUrl}?join=${encodeURIComponent(targetId)}`;

    qrUrlText.textContent = joinUrl;

    // Warn if opened on localhost (external devices can't reach 'localhost')
    if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
        qrUrlText.innerHTML = `${joinUrl}<br><br><span style="color: #ff9800; font-weight: bold;">⚠️ Warning: You are visiting via 'localhost'. Other devices cannot resolve this address. Use your local Wi-Fi IP (e.g., http://192.168.1.81:8001/) or your GitHub Pages URL instead.</span>`;
    }

    // Reset previous QR code
    qrcodeElement.innerHTML = "";

    qrCodeInstance = new QRCode(qrcodeElement, {
        text: joinUrl,
        width: 220,
        height: 220,
        colorDark: "#000000",
        colorLight: "#ffffff",
        correctLevel: QRCode.CorrectLevel.M
    });

    qrModal.classList.remove("hidden");
}

function closeQrModal() {
    qrModal.classList.add("hidden");
}

showQrBtn.onclick = openQrModal;
closeQrBtn.onclick = closeQrModal;

// Close modal if background overlay is clicked
qrModal.addEventListener("click", event => {
    if (event.target === qrModal) {
        closeQrModal();
    }
});

// ==========================================
// USERNAME MANAGEMENT
// ==========================================

function applyUsername() {
    const name = getUsername();
    usernameInput.value = name;
    sessionStorage.setItem(USERNAME_STORAGE_KEY, name);

    if (isHost) {
        broadcastSystemEvent(`Host is now known as ${name}`);
        broadcastRoomRoster();
    } else {
        broadcastToOpenPeers({
            type: "username-update",
            username: name
        });
    }

    renderUserList();
    setStatus(`Nickname set to "${name}"`);
}

saveUsernameBtn.onclick = applyUsername;

usernameInput.addEventListener("keydown", event => {
    if (event.key === "Enter") {
        applyUsername();
    }
});

// ==========================================
// CHAT
// ==========================================

function sendMessage() {
    const text = messageInput.value.trim();

    if (!text) return;

    if ((!peer || !peer.id) && peers.size === 0) {
        setStatus("PeerJS is not ready yet");
        return;
    }

    const localPeerId = (peer && peer.id) || "pending";
    const msgId = `${localPeerId}-${++messageCounter}-${Date.now()}`;
    const timestamp = Date.now();
    const statusEl = addMessage(`YOU (${getUsername()})`, text, {
        timestamp,
        isSelf: true,
        initialStatus: "[Queued]"
    });

    const activeTargets = Array.from(peers.values()).filter(e => !e.left);
    const totalSet = new Set();

    if (activeTargets.length === 0) {
        globalPendingQueue.push({
            id: msgId,
            message: text,
            senderId: localPeerId,
            senderName: getUsername(),
            timestamp
        });
    } else {
        for (const entry of activeTargets) {
            totalSet.add(entry.id);
            entry.outbox.push({
                id: msgId,
                message: text,
                senderId: localPeerId,
                senderName: getUsername(),
                timestamp,
                sent: false
            });
        }
    }

    sentMessages.set(msgId, {
        totalRecipients: totalSet,
        ackedRecipients: new Set(),
        statusEl
    });

    for (const entry of activeTargets) {
        flushPeerOutbox(entry);
    }

    updateSentMessageStatus(msgId);
    updateQueueStatusUI();
    messageInput.value = "";
}

document.getElementById("send").onclick = sendMessage;

messageInput.addEventListener("keydown", event => {
    if (event.key === "Enter") {
        sendMessage();
    }
});

// ==========================================
// CONNECT & NEW ROOM BUTTONS
// ==========================================

document.getElementById("connect").onclick = () => {
    connectToPlayer(remoteId.value);
};

document.getElementById("new-room").onclick = createNewRoom;

// ==========================================
// COPY PEER ID & INVITE LINK
// ==========================================

document.getElementById("copy-id").onclick = async () => {
    if (!peer || !peer.id) return;

    try {
        await navigator.clipboard.writeText(peer.id);
        setStatus("Peer ID copied!");
    } catch (error) {
        console.error("Clipboard error:", error);
        setStatus("Could not copy Peer ID");
    }
};

document.getElementById("copy-invite").onclick = async () => {
    if (!peer || !peer.id) return;

    const targetId = isHost ? peer.id : (hostPeerId || peer.id);
    const inviteUrl = `${getBaseUrl()}?join=${encodeURIComponent(targetId)}`;
    try {
        await navigator.clipboard.writeText(inviteUrl);
        setStatus("Invite link copied! Open it in another browser to join.");
    } catch (error) {
        console.error("Clipboard error:", error);
        setStatus("Could not copy invite link");
    }
};

// ==========================================
// PAGE CLEANUP
// ==========================================

window.addEventListener("beforeunload", () => {
    destroyed = true;

    broadcastToOpenPeers({
        type: "leave",
        peerId: peer ? peer.id : null
    });

    stopHeartbeat();
    stopServerPing();

    for (const entry of peers.values()) {
        clearReconnectTimer(entry);
        clearConnectTimer(entry);
    }

    if (signalingRetryTimer) {
        clearTimeout(signalingRetryTimer);
    }

    if (peer && !peer.destroyed) {
        peer.destroy();
    }
});

// ==========================================
// START
// ==========================================

initializePeer();
