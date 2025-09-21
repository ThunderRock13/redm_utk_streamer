// Monitor Panel JavaScript
const API_KEY = 'redm-media-server-key-2024';
let SERVER_URL = localStorage.getItem('serverUrl') || 'http://localhost:3000';
let WS_URL = localStorage.getItem('wsUrl') || 'ws://localhost:3000/ws';
let panels = [];
let players = [];
let activeStreams = new Map();
let ws = null;
let draggedPlayer = null;
let reconnectAttempts = 0;
let maxReconnectAttempts = 5;
let reconnectDelay = 1000; // Start with 1 second
let isConnected = false;
let panelPeerConnections = new Map(); // Store peer connections by panel ID

console.log('🚀 Monitor Loading...');
console.log('🔗 WebSocket URL:', WS_URL);

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    console.log('📱 DOM Ready - Initializing UI...');
    
    // Initialize video monitoring system
    window.videoMonitors = new Map();
    
    initializePanels(parseInt(localStorage.getItem('panelCount') || '4'));
    connectWebSocket();
    refreshPlayers();

    // Auto refresh players only (not reconnect)
    setInterval(refreshPlayers, 10000); // Every 10 seconds instead of 5
    setInterval(cleanupDeadStreams, 30000);
});

// WebSocket connection with better reconnection logic
function connectWebSocket() {
    // Don't reconnect if already connected
    if (isConnected && ws && ws.readyState === WebSocket.OPEN) {
        console.log('✅ Already connected, skipping reconnection');
        return;
    }
    checkAllVideos: () => {
        console.log('📊 Checking all video states:');
        activeStreams.forEach((stream, playerId) => {
            const state = window.monitorDebug.getVideoState(stream.panelId);
            console.log(`Panel ${stream.panelId} (Player ${playerId}):`, state);
        });
    }

    console.log('🔌 === WebSocket Connection Attempt ===');
    console.log('🔗 URL:', WS_URL);
    console.log('⏰ Time:', new Date().toISOString());
    
    // Close existing connection
    if (ws) {
        console.log('🔄 Closing existing WebSocket...');
        ws.onclose = null; // Prevent triggering reconnect
        ws.close();
    }

    console.log('🔨 Creating new WebSocket instance...');
    ws = new WebSocket(WS_URL);
    
    console.log('📊 WebSocket created, state:', ws.readyState);
    console.log('🔗 WebSocket URL:', ws.url);

    ws.onopen = () => {
        console.log('🎉 === WebSocket CONNECTED! ===');
        console.log('📊 Event:', event);
        console.log('📊 ReadyState:', ws.readyState);
        
        isConnected = true;
        reconnectAttempts = 0; // Reset attempts on successful connection
        reconnectDelay = 1000; // Reset delay
        updateConnectionStatus('Connected');

        // Register as monitor with API key
        const registration = {
            type: 'register-monitor',
            apiKey: API_KEY
        };
        console.log('📤 Sending registration:', registration);
        ws.send(JSON.stringify(registration));
    };

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        console.log('📨 Message received:', data.type, data);

        switch (data.type) {
            case 'registered':
                if (data.role === 'monitor') {
                    console.log('✅ Monitor registration successful!');
                    updateConnectionStatus('Registered');
                } else if (data.role === 'viewer') {
                    console.log('✅ Viewer registration successful for stream:', data.streamKey);
                    // Viewer registration successful - peer connection already set up
                }
                break;

            case 'player-update':
                console.log('👥 Players received:', data.players?.length || 0);
                players = data.players || [];
                updatePlayerList();
                break;

            case 'active-streams':
                // Handle active streams update
                break;

            case 'stream-assigned':
                console.log('🎬 Stream assigned:', data);
                handleStreamAssigned(data);
                break;

            case 'stream-ready':
                console.log('🎥 Stream ready:', data);
                break;

            case 'stream-ended':
                console.log('🛑 Stream ended:', data);
                handleStreamEnded(data);
                break;

            case 'stream-stopped':
                console.log('⏹️ Stream stopped:', data);
                handleStreamStopped(data);
                break;

            case 'offer':
                console.log('📡 Received WebRTC offer');
                handleWebRTCOffer(data);
                break;

            case 'answer':
                console.log('📡 Received WebRTC answer (unexpected for monitor)');
                break;

            case 'ice-candidate':
                console.log('📡 Received ICE candidate');
                handleWebRTCIceCandidate(data);
                break;

            case 'error':
                console.error('❌ Server error:', data.message);
                break;

            case 'ping':
                // Don't log pings, just respond
                ws.send(JSON.stringify({ type: 'pong' }));
                break;
        }
    };

    ws.onerror = (error) => {
        console.log('💥 === WebSocket ERROR ===');
        console.log('❌ Error:', error);
        console.log('📊 ReadyState:', ws.readyState);
        updateConnectionStatus('Connection Error');
    };

    ws.onclose = (event) => {
        console.log('🔌 === WebSocket CLOSED ===');
        console.log('📊 Code:', event.code);
        console.log('📊 Reason:', event.reason);
        console.log('📊 Clean:', event.wasClean);
        
        isConnected = false;
        updateConnectionStatus('Disconnected');

        // Only attempt reconnection if not manually closed
        if (event.code !== 1000 && reconnectAttempts < maxReconnectAttempts) {
            reconnectAttempts++;
            console.log(`🔄 Reconnection attempt ${reconnectAttempts}/${maxReconnectAttempts} in ${reconnectDelay}ms...`);
            
            setTimeout(() => {
                if (!isConnected) { // Double check we're still disconnected
                    connectWebSocket();
                }
            }, reconnectDelay);
            
            // Exponential backoff, max 30 seconds
            reconnectDelay = Math.min(reconnectDelay * 2, 30000);
        } else if (reconnectAttempts >= maxReconnectAttempts) {
            console.error('❌ Max reconnection attempts reached');
            updateConnectionStatus('Connection Failed');
        }
    };
}

// Handle stream assignment from server
function handleStreamAssigned(data) {
    let { panelId, streamId, streamKey, playerName, playerId } = data;
    
    // Convert to numbers to avoid type issues
    panelId = parseInt(panelId);
    playerId = parseInt(playerId);
    
    console.log('🎬 Setting up stream UI for panel', panelId, 'player', playerId);
    
    if (panelId < 0 || panelId >= panels.length) {
        console.error('❌ Invalid panel ID in stream assignment:', panelId);
        return;
    }
    
    const panel = panels[panelId];
    if (!panel) {
        console.error('❌ Panel not found in stream assignment:', panelId);
        return;
    }

    // Create video element
    const video = document.createElement('video');
    video.className = 'stream-video';
    video.autoplay = true;
    video.controls = false;
    video.muted = true;
    video.playsInline = true; // Important for mobile/some browsers
    
    // Add video event listeners for debugging
    video.addEventListener('loadstart', () => console.log(`📺 Panel ${panelId}: Video load started`));
    video.addEventListener('loadeddata', () => console.log(`📺 Panel ${panelId}: Video data loaded`));
    video.addEventListener('canplay', () => console.log(`📺 Panel ${panelId}: Video can play`));
    video.addEventListener('playing', () => console.log(`📺 Panel ${panelId}: Video is playing`));
    video.addEventListener('pause', () => console.log(`📺 Panel ${panelId}: Video paused`));
    video.addEventListener('ended', () => console.log(`📺 Panel ${panelId}: Video ended`));
    video.addEventListener('error', (e) => console.error(`📺 Panel ${panelId}: Video error`, e));
    
    // Video update detection
    let lastUpdateTime = 0;
    video.addEventListener('timeupdate', () => {
        const now = Date.now();
        if (now - lastUpdateTime > 5000) { // Log every 5 seconds
            console.log(`📺 Panel ${panelId}: Video updating (time: ${video.currentTime})`);
            lastUpdateTime = now;
        }
    });

    // Create overlay
    const overlay = document.createElement('div');
    overlay.className = 'stream-overlay';
    overlay.innerHTML = `
        <div class="stream-info">
            <div class="live-dot"></div>
            <span>${playerName}</span>
        </div>
        <div class="stream-actions">
            <button class="stream-btn" onclick="toggleAudio('${playerId}')">🔊</button>
            <button class="stream-btn" onclick="fullscreenPanel(${panelId})">⛶</button>
            <button class="stream-btn" onclick="stopPlayerStream(${playerId})">✕</button>
        </div>
    `;

    // Clear panel and add video
    panel.innerHTML = '';
    panel.appendChild(video);
    panel.appendChild(overlay);
    panel.classList.add('active');

    // Set up WebRTC connection for this panel
    console.log('🔗 Setting up peer connection for panel', panelId);
    setupPeerConnectionForPanel(panelId, video, streamKey);

    // Store active stream with video monitoring
    activeStreams.set(playerId, {
        panelId: panelId,
        streamKey: streamKey,
        video: video,
        streamId: streamId,
        lastVideoUpdate: Date.now()
    });

    // Update player list
    updatePlayerStreaming(playerId, true);
    
    // Start video health monitoring for this panel
    startVideoHealthMonitoring(panelId, playerId);
    
    console.log('✅ Stream UI setup complete:', playerName, 'in panel', panelId);
}

// Monitor video health and restart if needed
function startVideoHealthMonitoring(panelId, playerId) {
    const monitorInterval = setInterval(() => {
        const stream = activeStreams.get(playerId);
        if (!stream) {
            clearInterval(monitorInterval);
            return;
        }
        
        const video = stream.video;
        const now = Date.now();
        
        // Check if video is actually playing and updating
        if (video && video.srcObject) {
            const isPlaying = !video.paused && !video.ended && video.readyState > 2;
            
            if (!isPlaying && video.srcObject) {
                console.log(`⚠️ Panel ${panelId}: Video not playing, attempting restart`);
                video.play().catch(e => console.log(`❌ Panel ${panelId}: Play failed:`, e));
            }
            
            // Update last seen time if video dimensions are available (indicates active stream)
            if (video.videoWidth > 0 && video.videoHeight > 0) {
                stream.lastVideoUpdate = now;
            }
            
            // Check if video hasn't updated in a while
            if (now - stream.lastVideoUpdate > 10000) { // 10 seconds without update
                console.log(`⚠️ Panel ${panelId}: Video seems frozen, dimensions: ${video.videoWidth}x${video.videoHeight}`);
            }
            
        } else {
            console.log(`⚠️ Panel ${panelId}: No video source detected`);
        }
    }, 3000); // Check every 3 seconds
    
    // Store the interval for cleanup
    if (!window.videoMonitors) window.videoMonitors = new Map();
    window.videoMonitors.set(panelId, monitorInterval);
}

// Set up peer connection for a specific panel
function setupPeerConnectionForPanel(panelId, videoElement, streamKey) {
    // Convert panelId to number to avoid string/number issues
    panelId = parseInt(panelId);
    
    console.log('🔗 Setting up peer connection for panel', panelId, 'with stream key', streamKey);
    
    const pc = new RTCPeerConnection({
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ]
    });

    // Handle incoming stream
    pc.ontrack = (event) => {
        console.log('🎥 Video track received for panel', panelId);
        
        const stream = event.streams[0];
        videoElement.srcObject = stream;
        
        // Ensure video plays and updates continuously
        videoElement.play().then(() => {
            console.log('✅ Video playback started for panel', panelId);
        }).catch((error) => {
            console.log('⚠️ Video autoplay failed, trying to play manually:', error);
            // For some browsers, we might need to unmute first
            videoElement.muted = true;
            videoElement.play();
        });
        
        // Force video to be visible and update
        videoElement.style.display = 'block';
        videoElement.style.width = '100%';
        videoElement.style.height = '100%';
        videoElement.style.objectFit = 'contain';
        
        console.log('✅ Video stream connected and configured for panel', panelId);
        
        // Debug: Log video properties
        setTimeout(() => {
            console.log(`📊 Panel ${panelId} video state:`, {
                paused: videoElement.paused,
                muted: videoElement.muted,
                readyState: videoElement.readyState,
                videoWidth: videoElement.videoWidth,
                videoHeight: videoElement.videoHeight,
                srcObject: !!videoElement.srcObject
            });
        }, 1000);
    };

    pc.onicecandidate = (event) => {
        if (event.candidate && ws && ws.readyState === WebSocket.OPEN) {
            console.log('📡 Sending ICE candidate from panel', panelId);
            ws.send(JSON.stringify({
                type: 'ice-candidate',
                candidate: event.candidate
            }));
        }
    };

    pc.onconnectionstatechange = () => {
        console.log(`📡 Panel ${panelId} connection state:`, pc.connectionState);
        if (pc.connectionState === 'connected') {
            console.log(`✅ Panel ${panelId} WebRTC connection established!`);
        } else if (pc.connectionState === 'failed') {
            console.log(`❌ Panel ${panelId} WebRTC connection failed`);
        }
    };

    pc.oniceconnectionstatechange = () => {
        console.log(`📡 Panel ${panelId} ICE connection state:`, pc.iceConnectionState);
    };

    // Store peer connection with NUMERIC panelId and streamKey for lookup
    const connectionInfo = { pc, streamKey, videoElement, panelId };
    panelPeerConnections.set(panelId, connectionInfo);
    panelPeerConnections.set(streamKey, connectionInfo);
    
    console.log(`💾 Stored peer connection for panel ${panelId} and stream ${streamKey}`);

    // Register as viewer for this stream (AFTER peer connection is set up)
    console.log('📝 Registering as viewer for panel', panelId);
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'register-viewer',
            streamKey: streamKey,
            panelId: panelId  // Include panelId so server knows which panel this is for
        }));
    }
}

// Handle WebRTC offer from streamer
async function handleWebRTCOffer(data) {
    const { offer, streamerId } = data;
    
    console.log('📡 Processing WebRTC offer from streamer', streamerId);
    
    // Find the peer connection that's waiting for this offer
    // We need to match by the connection that was recently registered
    let connectionInfo = null;
    
    // Find the most recently created connection (should be the one waiting for offer)
    panelPeerConnections.forEach((info, key) => {
        if (info.pc && info.pc.connectionState === 'new') {
            connectionInfo = info;
            console.log('📡 Found waiting peer connection for panel', info.panelId);
        }
    });
    
    if (!connectionInfo) {
        console.error('❌ No peer connection found for WebRTC offer');
        console.log('📊 Available connections:', Array.from(panelPeerConnections.keys()));
        return;
    }
    
    const { pc, panelId } = connectionInfo;
    
    try {
        console.log('📡 Setting remote description for panel', panelId);
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        
        console.log('📡 Creating answer for panel', panelId);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        
        console.log('📡 Sending answer for panel', panelId);
        ws.send(JSON.stringify({
            type: 'answer',
            answer: answer
        }));
        
    } catch (error) {
        console.error('❌ Error handling WebRTC offer:', error);
    }
}

// Handle WebRTC answer (shouldn't happen for viewer, but just in case)
async function handleWebRTCAnswer(data) {
    console.log('📡 Received answer (unexpected for viewer):', data);
}

// Handle ICE candidate from streamer
async function handleWebRTCIceCandidate(data) {
    const { candidate, from } = data;
    
    if (from === 'viewer') {
        // This is from another viewer, ignore
        return;
    }
    
    console.log('📡 Processing ICE candidate from streamer');
    
    // Find the peer connection that should receive this candidate
    let connectionInfo = null;
    panelPeerConnections.forEach((info, key) => {
        if (info.pc && (info.pc.connectionState === 'new' || info.pc.connectionState === 'connecting')) {
            connectionInfo = info;
            console.log('📡 Found peer connection for ICE candidate, panel', info.panelId);
        }
    });
    
    if (!connectionInfo) {
        console.error('❌ No peer connection found for ICE candidate');
        return;
    }
    
    const { pc, panelId } = connectionInfo;
    
    try {
        console.log('📡 Adding ICE candidate for panel', panelId);
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (error) {
        console.error('❌ Error adding ICE candidate for panel', panelId, error);
    }
}

// Stop specific player's stream (called by X button)
function stopPlayerStream(playerId) {
    console.log('🛑 Stopping stream for player', playerId);
    
    const stream = activeStreams.get(playerId);
    if (stream) {
        stopStreamInPanel(stream.panelId);
        
        // Also send stop command to server to stop the actual streaming
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'monitor-stop-stream',
                apiKey: API_KEY,
                playerId: playerId,
                panelId: stream.panelId,
                streamKey: stream.streamKey
            }));
        }
    }
}

// Fullscreen specific panel
function fullscreenPanel(panelId) {
    console.log('🖥️ Fullscreen panel', panelId);
    
    // Convert to number in case it's a string
    panelId = parseInt(panelId);
    
    const panel = panels[panelId];
    if (panel) {
        if (panel.requestFullscreen) {
            panel.requestFullscreen();
        } else if (panel.webkitRequestFullscreen) {
            panel.webkitRequestFullscreen();
        } else if (panel.mozRequestFullScreen) {
            panel.mozRequestFullScreen();
        } else if (panel.msRequestFullscreen) {
            panel.msRequestFullscreen();
        }
    } else {
        console.error('❌ Panel not found for fullscreen:', panelId);
    }
}

function updateConnectionStatus(status) {
    console.log('📡 Status:', status, `(${isConnected ? 'Connected' : 'Disconnected'})`);
    // You can update UI here if needed
}

// Initialize panels
function initializePanels(count) {
    console.log('🎬 Initializing', count, 'panels');
    const grid = document.getElementById('streamGrid');
    grid.innerHTML = '';
    panels = [];

    for (let i = 0; i < count; i++) {
        const panel = createPanel(i);
        grid.appendChild(panel);
        panels.push(panel);
    }
    console.log('✅ Created', count, 'panels');
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

    console.log('🎯 Drop detected: Player', playerId, '-> Panel', panelId);
    await startStreamInPanel(playerId, panelId);
    draggedPlayer = null;
}

// Start stream in panel
async function startStreamInPanel(playerId, panelId) {
    // Convert to numbers to avoid string/number comparison issues
    playerId = parseInt(playerId);
    panelId = parseInt(panelId);
    
    console.log('🎬 Starting stream: Player', playerId, 'in Panel', panelId);
    
    if (panelId < 0 || panelId >= panels.length) {
        console.error('❌ Invalid panel ID:', panelId);
        return;
    }
    
    const panel = panels[panelId];
    if (!panel) {
        console.error('❌ Panel not found:', panelId);
        return;
    }

    // Check if already streaming
    const existingStream = activeStreams.get(playerId);
    if (existingStream) {
        console.log('⏹️ Stopping existing stream for player', playerId);
        stopStreamInPanel(existingStream.panelId);
    }

    // Stop any stream currently in this panel
    console.log('⏹️ Stopping stream in panel', panelId);
    stopStreamInPanel(panelId);

    try {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            console.error('❌ WebSocket not connected');
            return;
        }

        const player = players.find(p => parseInt(p.id) === playerId);
        const playerName = player ? player.name : `Player ${playerId}`;

        // Send stream request via WebSocket
        const streamRequest = {
            type: 'monitor-request-stream',
            apiKey: API_KEY,
            playerId: playerId,
            panelId: panelId,
            playerName: playerName
        };

        console.log('📤 Sending stream request:', streamRequest);
        ws.send(JSON.stringify(streamRequest));

    } catch (error) {
        console.error('❌ Error starting stream:', error);
    }
}

// Stop stream in panel
function stopStreamInPanel(panelId) {
    // Convert to number and handle panelId 0 correctly
    panelId = parseInt(panelId);
    
    console.log('⏹️ Stopping stream in panel', panelId);
    
    if (panelId < 0 || panelId >= panels.length) {
        console.error('❌ Invalid panel ID:', panelId);
        return;
    }
    
    const panel = panels[panelId];
    if (!panel) {
        console.error('❌ Panel not found:', panelId);
        return;
    }

    // Find stream in this panel
    let playerId = null;
    activeStreams.forEach((stream, pid) => {
        if (parseInt(stream.panelId) === panelId) {
            playerId = pid;
        }
    });

    if (playerId) {
        const stream = activeStreams.get(playerId);

        // Close peer connection using new Map
        const connectionInfo = panelPeerConnections.get(panelId);
        if (connectionInfo) {
            console.log('🔌 Closing peer connection for panel', panelId);
            connectionInfo.pc.close();
            panelPeerConnections.delete(panelId);
            panelPeerConnections.delete(connectionInfo.streamKey);
        }

        // Remove from map
        activeStreams.delete(playerId);

        // Update player list
        updatePlayerStreaming(playerId, false);
        
        console.log('✅ Stream stopped for player', playerId, 'in panel', panelId);
    }

    // Clean up video monitoring
    if (window.videoMonitors && window.videoMonitors.has(panelId)) {
        clearInterval(window.videoMonitors.get(panelId));
        window.videoMonitors.delete(panelId);
        console.log(`🧹 Cleaned up video monitor for panel ${panelId}`);
    }

    // Reset panel
    console.log('🔄 Resetting panel', panelId);
    panel.classList.remove('active');
    panel.innerHTML = `
        <div class="stream-placeholder">
            <i>📺</i>
            <p>Drag player here</p>
            <p>or double-click player</p>
        </div>
    `;
}

// Handle stream ended
function handleStreamEnded(data) {
    console.log('🛑 Handling stream ended:', data);
    // Remove from active streams and reset panel
    activeStreams.forEach((stream, playerId) => {
        if (stream.streamKey === data.streamKey) {
            stopStreamInPanel(stream.panelId);
        }
    });
}

// Handle stream stopped
function handleStreamStopped(data) {
    console.log('⏹️ Handling stream stopped:', data);
    if (data.panelId !== undefined) {
        stopStreamInPanel(data.panelId);
    }
}

// Refresh players
async function refreshPlayers() {
    console.log('🔄 Manual refresh requested');
    try {
        if (ws && ws.readyState === WebSocket.OPEN) {
            console.log('📤 Requesting players:', { type: 'monitor-get-players', apiKey: API_KEY });
            ws.send(JSON.stringify({
                type: 'monitor-get-players',
                apiKey: API_KEY
            }));
        }
    } catch (error) {
        console.error('❌ Error refreshing players:', error);
    }
}

// Update player list
function updatePlayerList() {
    console.log('👥 Updating player list:', players.length, 'players');
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
            console.log('🎯 Drag started for player', player.id);
            draggedPlayer = e.currentTarget;
            e.currentTarget.classList.add('dragging');
        });

        item.addEventListener('dragend', (e) => {
            console.log('🎯 Drag ended for player', player.id);
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
    
    console.log('✅ Player list updated:', players.length, 'players displayed');
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
        console.log(`🧹 Cleaned up ${deadStreams.length} dead streams`);
    }
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

// Manual refresh function
function refreshPlayers() {
    console.log('🔄 Manual refresh requested');
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'monitor-get-players',
            apiKey: API_KEY
        }));
    }
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
        isConnected = false;
    }
    setTimeout(connectWebSocket, 1000);
}

// Utility functions
function toggleAudio(playerId) {
    playerId = parseInt(playerId);
    const stream = activeStreams.get(playerId);
    if (stream && stream.video) {
        stream.video.muted = !stream.video.muted;
        console.log('🔊 Audio toggled for player', playerId, 'muted:', stream.video.muted);
        
        // Update button text/icon if needed
        const button = document.querySelector(`button[onclick="toggleAudio('${playerId}')"]`);
        if (button) {
            button.textContent = stream.video.muted ? '🔊' : '🔇';
        }
    } else {
        console.error('❌ No stream found for audio toggle, player:', playerId);
    }
}

// Debug functions for console
window.monitorDebug = {
    connectWebSocket,
    refreshPlayers,
    showActiveStreams: () => console.log('Active streams:', Array.from(activeStreams.entries())),
    showPlayers: () => console.log('Players:', players),
    showPeerConnections: () => console.log('Peer connections:', Array.from(panelPeerConnections.entries())),
    getConnectionState: () => ({ isConnected, wsState: ws?.readyState, reconnectAttempts }),
    testWebRTC: (panelId) => {
        panelId = parseInt(panelId);
        const connectionInfo = panelPeerConnections.get(panelId);
        if (connectionInfo) {
            console.log(`Panel ${panelId} WebRTC state:`, connectionInfo.pc.connectionState);
            console.log(`Panel ${panelId} ICE state:`, connectionInfo.pc.iceConnectionState);
            console.log(`Panel ${panelId} Stream key:`, connectionInfo.streamKey);
        } else {
            console.log(`No peer connection found for panel ${panelId}`);
            console.log('Available panels:', Array.from(panelPeerConnections.keys()));
        }
    },
    forceStreamToPanel: (playerId, panelId) => {
        console.log(`🧪 Force testing stream ${playerId} to panel ${panelId}`);
        startStreamInPanel(playerId, panelId);
    },
    restartVideo: (panelId) => {
        panelId = parseInt(panelId);
        const stream = Array.from(activeStreams.values()).find(s => s.panelId === panelId);
        if (stream && stream.video) {
            console.log(`🔄 Restarting video for panel ${panelId}`);
            const video = stream.video;
            video.load(); // Reload the video element
            video.play().catch(e => console.log('Play failed:', e));
        } else {
            console.log(`❌ No video found for panel ${panelId}`);
        }
    },
    getVideoState: (panelId) => {
        panelId = parseInt(panelId);
        const stream = Array.from(activeStreams.values()).find(s => s.panelId === panelId);
        if (stream && stream.video) {
            const video = stream.video;
            return {
                panelId,
                paused: video.paused,
                ended: video.ended,
                muted: video.muted,
                readyState: video.readyState,
                videoWidth: video.videoWidth,
                videoHeight: video.videoHeight,
                currentTime: video.currentTime,
                duration: video.duration,
                srcObject: !!video.srcObject,
                lastUpdate: stream.lastVideoUpdate
            };
        }
        return null;
    },
    forceVideoPlay: (panelId) => {
        panelId = parseInt(panelId);
        const stream = Array.from(activeStreams.values()).find(s => s.panelId === panelId);
        if (stream && stream.video) {
            const video = stream.video;
            console.log(`▶️ Force playing video for panel ${panelId}`);
            video.muted = true; // Ensure muted for autoplay
            video.play().then(() => {
                console.log(`✅ Video playing for panel ${panelId}`);
            }).catch(e => {
                console.error(`❌ Failed to play video for panel ${panelId}:`, e);
            });
        }
    }
};

console.log('🔧 Complete monitor loaded. Available debug functions:', Object.keys(window.monitorDebug));