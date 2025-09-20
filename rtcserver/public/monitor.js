// Monitor Panel JavaScript
const API_KEY = 'redm-media-server-key-2024';
let SERVER_URL = localStorage.getItem('serverUrl') || 'http://localhost:3000';
let WS_URL = localStorage.getItem('wsUrl') || 'ws://localhost:3000/ws';
let panels = [];
let players = [];
let activeStreams = new Map();
let ws = null;
let draggedPlayer = null;

let pc = null;

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    initializePanels(parseInt(localStorage.getItem('panelCount') || '4'));
    connectWebSocket();
    refreshPlayers();

    // Auto refresh
    setInterval(refreshPlayers, 5000);
    setInterval(cleanupDeadStreams, 30000);
});

// Initialize panels
function initializePanels(count) {
    const grid = document.getElementById('streamGrid');
    grid.innerHTML = '';
    panels = [];

    for (let i = 0; i < count; i++) {
        const panel = createPanel(i);
        grid.appendChild(panel);
        panels.push(panel);
    }
}

// Create panel
function createPanel(id) {
    const panel = document.createElement('div');
    panel.className = 'stream-panel';
    panel.dataset.panelId = id;
    panel.innerHTML = `
        <div class="stream-placeholder">
            <i>📺</i>
            <p>Drag player here</p>
            <p>or double-click player</p>
        </div>
    `;

    // Drag and drop events
    panel.addEventListener('dragover', handleDragOver);
    panel.addEventListener('drop', handleDrop);
    panel.addEventListener('dragleave', handleDragLeave);

    return panel;
}

// Handle drag over
function handleDragOver(e) {
    e.preventDefault();
    e.currentTarget.classList.add('dragover');
}

// Handle drag leave
function handleDragLeave(e) {
    e.currentTarget.classList.remove('dragover');
}

// Handle drop
async function handleDrop(e) {
    e.preventDefault();
    e.currentTarget.classList.remove('dragover');

    if (!draggedPlayer) return;

    const panelId = e.currentTarget.dataset.panelId;
    const playerId = draggedPlayer.dataset.playerId;

    await startStreamInPanel(playerId, panelId);
    draggedPlayer = null;
}

// Start stream in panel
async function startStreamInPanel(playerId, panelId) {
    const panel = panels[panelId];
    if (!panel) return;

    // Check if already streaming
    const existingStream = activeStreams.get(playerId);
    if (existingStream) {
        // Move to new panel
        stopStreamInPanel(existingStream.panelId);
    }

    try {
        // Request stream from server
        const response = await fetch(`${SERVER_URL}/api/monitor/stream`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': API_KEY
            },
            body: JSON.stringify({
                playerId: playerId,
                panelId: panelId
            })
        });

        const data = await response.json();

        if (data.success) {
            // Create video element
            const video = document.createElement('video');
            video.className = 'stream-video';
            video.autoplay = true;
            video.controls = false;
            video.muted = true;

            // Create overlay
            const overlay = document.createElement('div');
            overlay.className = 'stream-overlay';
            overlay.innerHTML = `
                <div class="stream-info">
                    <div class="live-dot"></div>
                    <span>${data.playerName}</span>
                </div>
                <div class="stream-actions">
                    <button class="stream-btn" onclick="toggleAudio('${playerId}')">🔊</button>
                    <button class="stream-btn" onclick="fullscreen('${panelId}')">⛶</button>
                    <button class="stream-btn" onclick="stopStreamInPanel('${panelId}')">✕</button>
                </div>
            `;

            // Clear panel and add video
            panel.innerHTML = '';
            panel.appendChild(video);
            panel.appendChild(overlay);
            panel.classList.add('active');

            // Connect to stream
            connectToStream(video, data.streamKey);

            // Store active stream
            activeStreams.set(playerId, {
                panelId: panelId,
                streamKey: data.streamKey,
                video: video
            });

            // Update player list
            updatePlayerStreaming(playerId, true);
        }
    } catch (error) {
        console.error('Error starting stream:', error);
    }
}

// Connect to stream via WebRTC
async function connectToStream(videoElement, streamKey) {
    // Create peer connection
    pc = new RTCPeerConnection({
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' }
        ]
    });

    // Handle incoming stream
    pc.ontrack = (event) => {
        videoElement.srcObject = event.streams[0];
    };

    // Connect via WebSocket
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'register-viewer',
            streamKey: streamKey
        }));
    }

    // Store connection
    videoElement.peerConnection = pc;
}

// Stop stream in panel
function stopStreamInPanel(panelId) {
    const panel = panels[panelId];
    if (!panel) return;

    // Find stream in this panel
    let playerId = null;
    activeStreams.forEach((stream, pid) => {
        if (stream.panelId == panelId) {
            playerId = pid;
        }
    });

    if (playerId) {
        const stream = activeStreams.get(playerId);

        // Close peer connection
        if (stream.video && stream.video.peerConnection) {
            stream.video.peerConnection.close();
        }

        // Remove from map
        activeStreams.delete(playerId);

        // Update player list
        updatePlayerStreaming(playerId, false);

        // Notify server
        fetch(`${SERVER_URL}/api/monitor/stop`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': API_KEY
            },
            body: JSON.stringify({
                playerId: playerId,
                panelId: panelId
            })
        });
    }

    // Reset panel
    panel.classList.remove('active');
    panel.innerHTML = `
        <div class="stream-placeholder">
            <i>📺</i>
            <p>Drag player here</p>
            <p>or double-click player</p>
        </div>
    `;
}

// Refresh players
async function refreshPlayers() {
    try {
        const response = await fetch(`${SERVER_URL}/api/players`, {
            headers: {
                'X-API-Key': API_KEY
            }
        });

        const data = await response.json();
        players = data.players || [];
        updatePlayerList();

    } catch (error) {
        console.error('Error refreshing players:', error);
    }
}

// Update player list
function updatePlayerList() {
    const list = document.getElementById('playerList');
    const count = document.getElementById('playerCount');

    count.textContent = players.length;
    list.innerHTML = '';

    players.forEach(player => {
        const item = document.createElement('div');
        item.className = 'player-item';
        item.dataset.playerId = player.id;
        item.draggable = true;

        if (activeStreams.has(player.id.toString())) {
            item.classList.add('streaming');
        }

        item.innerHTML = `
            <div class="player-name">
                ${player.name}
                ${activeStreams.has(player.id.toString()) ? '<span class="streaming-badge">LIVE</span>' : ''}
            </div>
            <div class="player-info">
                <span>ID: ${player.id}</span>
                <span>Ping: ${player.ping}ms</span>
            </div>
        `;

        // Drag events
        item.addEventListener('dragstart', (e) => {
            draggedPlayer = e.currentTarget;
            e.currentTarget.classList.add('dragging');
        });

        item.addEventListener('dragend', (e) => {
            e.currentTarget.classList.remove('dragging');
        });

        // Double click
        item.addEventListener('dblclick', async (e) => {
            const playerId = e.currentTarget.dataset.playerId;
            const emptyPanel = panels.find((p, idx) => !isPanelActive(idx));
            if (emptyPanel) {
                const panelId = emptyPanel.dataset.panelId;
                await startStreamInPanel(playerId, panelId);
            }
        });

        list.appendChild(item);
    });
}

// Check if panel is active
function isPanelActive(panelId) {
    let active = false;
    activeStreams.forEach(stream => {
        if (stream.panelId == panelId) {
            active = true;
        }
    });
    return active;
}

// Update player streaming status
function updatePlayerStreaming(playerId, streaming) {
    const playerItem = document.querySelector(`[data-player-id="${playerId}"]`);
    if (playerItem) {
        if (streaming) {
            playerItem.classList.add('streaming');
        } else {
            playerItem.classList.remove('streaming');
        }
    }
}

// Clean up dead streams
async function cleanupDeadStreams() {
    const deadStreams = [];

    activeStreams.forEach((stream, playerId) => {
        const player = players.find(p => p.id == playerId);
        if (!player) {
            deadStreams.push(playerId);
        }
    });

    deadStreams.forEach(playerId => {
        const stream = activeStreams.get(playerId);
        if (stream) {
            stopStreamInPanel(stream.panelId);
        }
    });

    if (deadStreams.length > 0) {
        console.log(`Cleaned up ${deadStreams.length} dead streams`);
    }
}

async function handleOffer(offer) {
    if (!pc) 
    {
        setupPeerConnection();
    }

    try {
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        ws.send(JSON.stringify({
            type: 'answer',
            answer: answer
        }));
    } catch (error) {
        console.error('Error handling offer:', error);
    }
}

function disconnect() {
    if (ws) {
        ws.close();
        ws = null;
    }

    if (pc) {
        pc.close();
        pc = null;
    }

    if (statsInterval) {
        clearInterval(statsInterval);
        statsInterval = null;
    }

    const remoteVideo = document.getElementById('remoteVideo');
    remoteVideo.srcObject = null;

    document.getElementById('videoContainer').classList.remove('active');
    document.getElementById('connectBtn').disabled = false;
    document.getElementById('disconnectBtn').disabled = true;
    document.getElementById('stats').classList.remove('active');

    currentStreamKey = null;
}


// WebSocket connection
function connectWebSocket() {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
        console.log('Monitor WebSocket connected');

        ws.send(JSON.stringify({
            type: 'register-viewer',
            streamKey: streamKey
        }));
    };

    ws.onmessage = async (event) => {
        const data = JSON.parse(event.data);
        console.log('WS Message:', data.type);


        switch (data.type) {
            case 'registered':
                updateStatus('Connected to stream, waiting for video...', 'info');
                document.getElementById('streamIdDisplay').textContent = streamKey;
                setupPeerConnection();
                break;
            case 'offer':
                await handleOffer(data.offer);
                break;
            case 'ice-candidate':
                if (pc) {
                    try {
                        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
                    } catch (error) {
                        console.error('Error adding ICE candidate:', error);
                    }
                }
                break;
            case 'stream-ended':
                updateStatus('Stream has ended', 'error');
                disconnect();
                break;
            case 'error':
                updateStatus(data.message, 'error');
                disconnect();
                break;
            case 'ping':
                ws.send(JSON.stringify({ type: 'pong' }));
                break;
        }


        switch (data.type) {
            case 'player-update':
                players = data.players;
                updatePlayerList();
                break;

            case 'stream-started':
                // Handle stream started event
                break;

            case 'stream-stopped':
                // Handle stream stopped event
                break;
        }
    };

    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
    };

    ws.onclose = () => {
        console.log('WebSocket disconnected, reconnecting...');
        setTimeout(connectWebSocket, 5000);
    };
}

// Panel controls
function addPanel() {
    const grid = document.getElementById('streamGrid');
    const id = panels.length;
    const panel = createPanel(id);
    grid.appendChild(panel);
    panels.push(panel);
}

function removePanel() {
    if (panels.length > 1) {
        const lastPanel = panels.pop();
        const panelId = lastPanel.dataset.panelId;
        stopStreamInPanel(panelId);
        lastPanel.remove();
    }
}

function stopAllStreams() {
    activeStreams.forEach((stream, playerId) => {
        stopStreamInPanel(stream.panelId);
    });
}

// Settings
function openSettings() {
    document.getElementById('settingsModal').classList.add('active');
    document.getElementById('panelCount').value = panels.length;
    document.getElementById('serverUrl').value = SERVER_URL;
    document.getElementById('wsUrl').value = WS_URL;
}

function closeSettings() {
    document.getElementById('settingsModal').classList.remove('active');
}

function saveSettings() {
    const count = parseInt(document.getElementById('panelCount').value);
    const serverUrl = document.getElementById('serverUrl').value;
    const wsUrl = document.getElementById('wsUrl').value;

    localStorage.setItem('panelCount', count);
    localStorage.setItem('serverUrl', serverUrl);
    localStorage.setItem('wsUrl', wsUrl);

    SERVER_URL = serverUrl;
    WS_URL = wsUrl;

    initializePanels(count);
    closeSettings();

    // Reconnect WebSocket
    if (ws) {
        ws.close();
    }
    connectWebSocket();
}

// Utility functions
function toggleAudio(playerId) {
    const stream = activeStreams.get(playerId);
    if (stream && stream.video) {
        stream.video.muted = !stream.video.muted;
    }
}

function fullscreen(panelId) {
    const panel = panels[panelId];
    if (panel && panel.requestFullscreen) {
        panel.requestFullscreen();
    }
}