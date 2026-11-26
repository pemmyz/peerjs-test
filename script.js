// ==========================================
// PeerJS Multi-User P2P Chat Room
// Mesh discovery + Custom nicknames + Buffered delivery queue + Heartbeat + QR Connect
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
const HEARTBEAT_TIMEOUT = 30000;
const SERVER_PING_INTERVAL = 10000;
const RECONNECT_BASE_DELAY = 2000;
const RECONNECT_MAX_DELAY = 15000;
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
const autoJoinId = urlParams.get("join");

// PeerJS state
let peer;
let defaultUsername = "User";

// Multi-user mesh state: Map<peerId, PeerEntry>
const peers = new Map();

// Reconnection state
let signalingRetryTimer = null;
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

// ==========================================
// UI, PING & URL HELPERS
// ==========================================

function setStatus(text) {
    status.textContent = text;
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

    // Local user row
    const selfLi = document.createElement("li");
    selfLi.className = "user-item";
    selfLi.innerHTML = `<div><strong>${escapeHtml(getUsername())}</strong> <span class="user-meta">(You${peer && peer.id ? ` · ${escapeHtml(peer.id.slice(0, 8))}…` : ""})</span></div><span class="user-status connected">Online</span>`;
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

        li.innerHTML = `
            <div>
                <strong>${escapeHtml(entry.username)}</strong>
                <span class="user-meta">(${escapeHtml(entry.id.slice(0, 8))}…${pingText}${queueText})</span>
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
    const openCount = Array.from(peers.values()).filter(e => e.conn && e.conn.open).length;
    if (openCount > 0) {
        setStatus(`Connected to ${openCount} user${openCount === 1 ? "" : "s"} in room`);
    } else if (peers.size > 0) {
        setStatus("Room disconnected. Reconnecting...");
    } else if (peer && peer.id && !peer.disconnected) {
        setStatus("Connected to PeerJS Cloud (waiting for users)");
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
    destroyed = false;

    const hasTurnServer = ICE_SERVERS.some(server => {
        const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
        return urls.some(u => typeof u === "string" && (u.startsWith("turn:") || u.startsWith("turns:")));
    });

    if (!hasTurnServer) {
        console.warn("No TURN server configured in ICE_SERVERS. Connections across different networks/mobile data may hang at ICE negotiation.");
    }

    setStatus("Connecting to PeerJS Cloud...");

    peer = new Peer({
        debug: 3, // Logs ICE candidates, SDP offers/answers, and PeerJS errors
        config: {
            iceServers: ICE_SERVERS
        }
    });

    peer.on("open", id => {
        console.log("PeerJS connected:", id);

        myId.textContent = id;
        defaultUsername = `User-${id.slice(0, 4)}`;
        if (!usernameInput.value.trim()) {
            usernameInput.placeholder = `Nickname (default: ${defaultUsername})`;
        }

        setStatus("Connected to PeerJS Cloud");
        renderUserList();

        startServerPing();

        // AUTO-CONNECT: If page was opened from QR scan or with ?join=...
        if (autoJoinId && autoJoinId !== id && !peers.has(autoJoinId)) {
            console.log("Auto-connecting to scanned peer:", autoJoinId);
            remoteId.value = autoJoinId;
            connectToPlayer(autoJoinId);
            return;
        }

        // If signaling recovered and any peer P2P links are down
        for (const entry of peers.values()) {
            if ((!entry.conn || !entry.conn.open) && !entry.left) {
                scheduleReconnect(entry.id);
            }
        }
    });

    // Incoming connection
    peer.on("connection", conn => {
        console.log("Incoming connection:", conn.peer);

        const existing = peers.get(conn.peer);
        if (existing && existing.conn && existing.conn.open) {
            conn.close();
            return;
        }

        // Glare resolution if both sides dialed simultaneously
        if (existing && existing.conn && existing.conn !== conn && !existing.conn.open) {
            if (peer.id < conn.peer) {
                conn.close();
                return;
            }
            try {
                existing.conn.close();
            } catch (e) {
                // ignore
            }
        }

        setupConnection(conn);
    });

    peer.on("disconnected", () => {
        console.warn("PeerJS Cloud disconnected");
        setStatus("Lost PeerJS Cloud connection...");
        updatePingUI(serverPingEl, null);
        retrySignaling();
    });

    peer.on("error", error => {
        console.error("PeerJS error:", error);
        setStatus("PeerJS error: " + error.type);

        if (error.type === "peer-unavailable") {
            const match = error.message && error.message.match(/peer\s+([^\s]+)/i);
            const unavailableId = match ? match[1] : null;

            if (unavailableId && peers.has(unavailableId)) {
                const entry = peers.get(unavailableId);
                if (entry.conn && !entry.conn.open) {
                    entry.conn = null;
                    entry.rtt = null;
                }
                if (!entry.left) {
                    scheduleReconnect(unavailableId);
                }
                renderUserList();
            }
        }

        if (error.type === "network") {
            updatePingUI(serverPingEl, null);
            retrySignaling();
        }
    });

    peer.on("close", () => {
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

        if (destroyed || !peer || peer.destroyed) return;

        if (peer.disconnected) {
            console.log("Reconnecting to PeerJS Cloud...");
            try {
                peer.reconnect();
            } catch (error) {
                console.error("Signaling reconnect failed:", error);
            }
        }
    }, 3000);
}

window.addEventListener("online", () => {
    console.log("Internet connection restored");

    measureServerPing();

    if (peer && peer.disconnected) {
        retrySignaling();
    }

    for (const entry of peers.values()) {
        if ((!entry.conn || !entry.conn.open) && !entry.left) {
            scheduleReconnect(entry.id);
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
// MESH PEER REGISTRY & HELPERS
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
            rtt: null,
            reconnectAttempts: 0,
            reconnectTimer: null,
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

function getConnectedPeerSummaries(excludePeerId = null) {
    const list = [];
    for (const entry of peers.values()) {
        if (entry.id !== excludePeerId && entry.conn && entry.conn.open) {
            list.push({ id: entry.id, username: entry.username });
        }
    }
    return list;
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

function handleDiscoveredPeers(peerList) {
    if (!Array.isArray(peerList) || !peer || !peer.id) return;

    for (const info of peerList) {
        if (!info || !info.id || info.id === peer.id) continue;

        const existing = peers.get(info.id);
        if (existing) {
            if (info.username) {
                existing.username = sanitizeUsername(info.username, info.id);
            }
            if (existing.conn && existing.conn.open) continue;
        }

        // Deterministic mesh initiator: lexicographically smaller Peer ID dials
        if (peer.id < info.id) {
            const entry = getOrCreatePeer(info.id, info.username);
            if (!entry.conn && !entry.left) {
                console.log("Auto-connecting to mesh peer:", info.id);
                connectToPlayer(info.id, true);
            }
        }
    }

    renderUserList();
}

// ==========================================
// CONNECT TO ROOM / PEER
// ==========================================

function connectToPlayer(id, isAuto = false) {
    id = id.trim();

    if (!id) return;

    if (!peer || !peer.id) {
        setStatus("PeerJS is not ready yet");
        return;
    }

    if (id === peer.id) {
        setStatus("You cannot connect to yourself!");
        return;
    }

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
        setStatus("Connecting to room...");
    }

    const conn = peer.connect(id, {
        reliable: true
    });

    setupConnection(conn);
}

// ==========================================
// CONNECTION MANAGEMENT
// ==========================================

function setupConnection(conn) {
    const entry = getOrCreatePeer(conn.peer);
    entry.left = false;

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

    conn.on("iceStateChanged", state => {
        console.log("ICE state:", state);

        if (state === "failed" && !conn.open) {
            console.warn("ICE negotiation failed before DataConnection opened");
            if (entry.conn === conn) {
                entry.conn = null;
                entry.rtt = null;
                markOutboxUnsent(entry);
            }
            try {
                conn.close();
            } catch (e) {
                // ignore
            }
            renderUserList();
            updateAggregatedPing();
            if (!entry.left) scheduleReconnect(entry.id);
        }
    });

    conn.on("open", () => {
        console.log("P2P connection established");

        entry.hasConnectedOnce = true;
        entry.reconnectAttempts = 0;
        entry.lastPong = Date.now();
        clearReconnectTimer(entry);

        // Close the QR modal automatically once connected
        closeQrModal();

        ensureHeartbeatRunning();
        sendPingToPeer(entry);

        conn.send({
            type: "hello",
            peerId: peer.id,
            username: getUsername(),
            peers: getConnectedPeerSummaries(conn.peer),
            timestamp: Date.now()
        });

        flushGlobalPendingQueue();
        flushPeerOutbox(entry);
        updateRoomStatus();
        renderUserList();
    });

    conn.on("data", data => {
        if (!data || typeof data !== "object") return;

        // Heartbeat & P2P Ping
        if (data.type === "ping") {
            conn.send({
                type: "pong",
                sentAt: data.sentAt
            });
            return;
        }

        if (data.type === "pong") {
            entry.lastPong = Date.now();
            if (typeof data.sentAt === "number") {
                entry.rtt = Math.max(0, Math.round(performance.now() - data.sentAt));
                updateAggregatedPing();
                renderUserList();
            }
            return;
        }

        // Handshake & mesh peer discovery
        if (data.type === "hello") {
            entry.username = sanitizeUsername(data.username, entry.id);

            if (!entry.announcedJoin) {
                entry.announcedJoin = true;
                addSystemMessage(`${entry.username} joined the room`);
            }

            handleDiscoveredPeers(data.peers);
            broadcastToOpenPeers(
                {
                    type: "peer-list",
                    peers: [{ id: entry.id, username: entry.username }]
                },
                entry.id
            );

            renderUserList();
            flushPeerOutbox(entry);
            return;
        }

        if (data.type === "peer-list") {
            handleDiscoveredPeers(data.peers);
            return;
        }

        if (data.type === "username-update") {
            const oldName = entry.username;
            entry.username = sanitizeUsername(data.username, entry.id);
            if (oldName !== entry.username) {
                addSystemMessage(`${oldName} is now known as ${entry.username}`);
            }
            renderUserList();
            return;
        }

        if (data.type === "leave") {
            entry.left = true;
            clearReconnectTimer(entry);
            addSystemMessage(`${entry.username} left the room`);

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
                conn.send({
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
            return;
        }
    });

    conn.on("close", () => {
        if (entry.conn !== conn) return;

        console.warn("P2P connection closed");

        entry.conn = null;
        entry.rtt = null;
        markOutboxUnsent(entry);

        if (!entry.left) {
            if (entry.announcedJoin) {
                addSystemMessage(`${entry.username} disconnected (messages will be queued)`);
            }
            entry.announcedJoin = false;
            scheduleReconnect(entry.id);
        }

        renderUserList();
        updateRoomStatus();
        updateAggregatedPing();
        updateQueueStatusUI();
    });

    conn.on("error", error => {
        console.error("DataConnection error:", error);

        if (entry.conn === conn && !conn.open) {
            entry.conn = null;
            entry.rtt = null;
            markOutboxUnsent(entry);
            if (!entry.left) {
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

        try {
            entry.conn.send({
                type: "chat",
                id: item.id,
                message: item.message,
                senderId: peer.id,
                senderName: getUsername(),
                timestamp: item.timestamp
            });
            item.sent = true;
        } catch (err) {
            console.warn("Failed sending queued message to", entry.id, err);
            item.sent = false;
            break;
        }
    }

    renderUserList();
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

function sendPingToPeer(entry) {
    if (!entry.conn || !entry.conn.open) return;

    const elapsed = Date.now() - entry.lastPong;

    if (elapsed > HEARTBEAT_TIMEOUT) {
        console.warn("Heartbeat timeout for peer:", entry.id);
        entry.conn.close();
        return;
    }

    entry.conn.send({
        type: "ping",
        sentAt: performance.now(),
        timestamp: Date.now()
    });
}

function ensureHeartbeatRunning() {
    if (heartbeatTimer) return;

    heartbeatTimer = setInterval(() => {
        let hasOpen = false;
        for (const entry of peers.values()) {
            if (entry.conn && entry.conn.open) {
                hasOpen = true;
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
    if (destroyed) return;
    if (!peerId || !peer || !peer.id) return;

    const entry = peers.get(peerId);
    if (!entry || entry.left) return;

    // Only enforce reconnect leadership after both peers have connected once
    // and know each other's Peer ID.
    const isLeader = peer.id < entry.id;
    if (entry.hasConnectedOnce && !isLeader) return;
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
    const joinUrl = `${baseUrl}?join=${encodeURIComponent(peer.id)}`;

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

    broadcastToOpenPeers({
        type: "username-update",
        username: name
    });

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

    if (!peer || !peer.id) {
        setStatus("PeerJS is not ready yet");
        return;
    }

    const msgId = `${peer.id}-${++messageCounter}-${Date.now()}`;
    const timestamp = Date.now();
    const statusEl = addMessage(`YOU (${getUsername()})`, text, {
        timestamp,
        isSelf: true,
        initialStatus: "[Queued]"
    });

    const activeTargets = Array.from(peers.values()).filter(e => !e.left);
    const totalSet = new Set();

    if (activeTargets.length === 0) {
        globalPendingQueue.push({ id: msgId, message: text, timestamp });
    } else {
        for (const entry of activeTargets) {
            totalSet.add(entry.id);
            entry.outbox.push({
                id: msgId,
                message: text,
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
// CONNECT BUTTON
// ==========================================

document.getElementById("connect").onclick = () => {
    connectToPlayer(remoteId.value);
};

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

    const inviteUrl = `${getBaseUrl()}?join=${encodeURIComponent(peer.id)}`;
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
