// Monitor Panel JavaScript
const API_KEY = 'redm-media-server-key-2024';

// Auto-detect server URL based on current page URL
function getDefaultServerUrl() {
    const currentHost = window.location.hostname;
    const currentPort = window.location.port || (window.location.protocol === 'https:' ? '443' : '80');

    // If accessing from localhost, use localhost
    if (currentHost === 'localhost' || currentHost === '127.0.0.1') {
        return 'http://localhost:3000';
    }

    // Otherwise, use the current hostname with port 3000
    return `${window.location.protocol}//${currentHost}:3000`;
}

function getDefaultWsUrl() {
    const currentHost = window.location.hostname;

    // If accessing from localhost, use localhost
    if (currentHost === 'localhost' || currentHost === '127.0.0.1') {
        return 'ws://localhost:3000/ws';
    }

    // Otherwise, use the current hostname with port 3000
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${wsProtocol}//${currentHost}:3000/ws`;
}

let SERVER_URL = localStorage.getItem('serverUrl') || getDefaultServerUrl();
let WS_URL = localStorage.getItem('wsUrl') || getDefaultWsUrl();
let panels = [];
let players = [];
let activeStreams = new Map();
let ws = null;
let draggedPlayer = null;

// WebRTC Configuration (loaded dynamically for firewall-free streaming)
let webrtcConfig = null;

// WebSocket streaming fallback
let wsStreamingEnabled = false;
let wsStreamingConnections = new Map(); // streamKey -> { ws, canvas, ctx }
let reconnectAttempts = 0;
let maxReconnectAttempts = 5;
let reconnectDelay = 1000; // Start with 1 second
let isConnected = false;
let panelPeerConnections = new Map(); // Store peer connections by panel ID

console.log('🚀 Monitor Loading...');
console.log('🔗 WebSocket URL:', WS_URL);

// Fetch WebRTC configuration from server
async function loadWebRTCConfig() {
    try {
        const response = await fetch(`${SERVER_URL}/api/webrtc/config`);
        if (response.ok) {
            webrtcConfig = await response.json();
            console.log('🔧 WebRTC config loaded:', {
                turnEnabled: webrtcConfig.turnEnabled,
                forceRelayOnly: webrtcConfig.forceRelayOnly,
                iceServersCount: webrtcConfig.iceServers.length
            });
            if (webrtcConfig.forceRelayOnly) {
                console.log('🛡️ Firewall-free mode: Using relay-only WebRTC connections');
            }
        } else {
            console.warn('⚠️ Failed to load WebRTC config, using defaults');
            webrtcConfig = getDefaultWebRTCConfig();
        }
    } catch (error) {
        console.warn('⚠️ Error loading WebRTC config, using defaults:', error);
        webrtcConfig = getDefaultWebRTCConfig();
    }
}

// Default WebRTC configuration fallback
function getDefaultWebRTCConfig() {
    return {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ],
        iceTransportPolicy: 'all',
        turnEnabled: false,
        forceRelayOnly: false
    };
}

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
    console.log('📱 DOM Ready - Initializing UI...');

    // Show auto-detected URLs if not localhost
    if (!localStorage.getItem('serverUrl') || !localStorage.getItem('wsUrl')) {
        const currentHost = window.location.hostname;
        if (currentHost !== 'localhost' && currentHost !== '127.0.0.1') {
            console.log('🌐 Auto-detected remote access from:', currentHost);
            console.log('📡 Using Server URL:', SERVER_URL);
            console.log('🔗 Using WebSocket URL:', WS_URL);
            console.log('💡 You can change these in Settings if needed');
        }
    }

    // Initialize video monitoring system
    window.videoMonitors = new Map();
    window.videoSourceChecks = new Map();

    await loadWebRTCConfig();
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
    console.log('🔌 Connecting to WebSocket...');

    // Close existing connection
    if (ws) {
        ws.onclose = null; // Prevent triggering reconnect
        ws.close();
    }

    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
        console.log('✅ WebSocket connected');

        isConnected = true;
        reconnectAttempts = 0; // Reset attempts on successful connection
        reconnectDelay = 1000; // Reset delay
        updateConnectionStatus('Connecting...');

        // Register as monitor with API key
        ws.send(JSON.stringify({
            type: 'register-monitor',
            apiKey: API_KEY
        }));
    };

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);

        switch (data.type) {
            case 'registered':
                if (data.role === 'monitor') {
                    console.log('✅ Monitor registered');
                    updateConnectionStatus('Registered');
                } else if (data.role === 'viewer') {
                    if (data.viewerType === 'primary') {
                        console.log('✅ Viewer registered as PRIMARY for stream:', data.streamKey);
                        // Primary viewer gets normal WebRTC connection
                    } else if (data.viewerType === 'shared') {
                        console.log('✅ Viewer registered as SHARED for stream:', data.streamKey, 'Primary viewer:', data.primaryViewer);
                        // Shared viewer will receive stream from primary viewer
                        handleSharedViewerSetup(data.streamKey, data.primaryViewer);
                    } else {
                        console.log('✅ Viewer registered for stream:', data.streamKey);
                    }
                }
                break;

            case 'player-update':
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
                ws.send(JSON.stringify({ type: 'pong' }));
                break;

            case 'share-stream-request':
                console.log('🤝 Share stream request for shared viewer:', data.sharedViewer);
                handleShareStreamRequest(data.sharedViewer, data.panelId);
                break;

            case 'stream-share-offer':
                console.log('🤝 Received stream share offer from:', data.sourceViewer);
                handleStreamShareOffer(data.sourceViewer, data.offer);
                break;

            case 'stream-share-answer':
                console.log('🤝 Received stream share answer from:', data.sourceViewer);
                handleStreamShareAnswer(data.sourceViewer, data.answer);
                break;

            case 'stream-share-ice':
                console.log('🤝 Received stream share ICE from:', data.sourceViewer);
                handleStreamShareIce(data.sourceViewer, data.candidate);
                break;

            case 'promoted-to-primary':
                console.log('🔄 Promoted to primary viewer for stream:', data.streamKey);
                handlePromotedToPrimary(data.streamKey);
                break;

            case 'ws-stream-frame':
                console.log('📺 Received WebSocket video frame');
                handleWebSocketVideoFrame(data.streamKey, data.frame);
                break;

            case 'fallback-to-websocket':
                console.log('⚠️ Falling back to WebSocket streaming for:', data.streamKey);
                enableWebSocketStreaming(data.streamKey, data.panelId);
                break;
        }
    };

    ws.onerror = (error) => {
        console.log('❌ WebSocket error');
        updateConnectionStatus('Connection Error');
    };

    ws.onclose = (event) => {
        console.log('🔌 WebSocket closed (code:', event.code + ')');

        isConnected = false;
        updateConnectionStatus('Disconnected');

        // Only attempt reconnection if not manually closed
        if (event.code !== 1000 && reconnectAttempts < maxReconnectAttempts) {
            reconnectAttempts++;
            console.log(`🔄 Reconnecting (${reconnectAttempts}/${maxReconnectAttempts})...`);

            setTimeout(() => {
                if (!isConnected) {
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
    let { panelId, streamId, streamKey, playerName, playerId, existing } = data;

    // Convert to numbers to avoid type issues
    panelId = parseInt(panelId);
    playerId = parseInt(playerId);

    console.log('🎬 Setting up stream UI for panel', panelId, 'player', playerId, existing ? '(existing stream)' : '(new stream)');

    if (panelId < 0 || panelId >= panels.length) {
        console.error('❌ Invalid panel ID in stream assignment:', panelId);
        return;
    }

    const panel = panels[panelId];
    if (!panel) {
        console.error('❌ Panel not found in stream assignment:', panelId);
        return;
    }

    // Panel 0 workaround: simulate panel transfer to ensure WebRTC setup works
    if (!existing && panelId === 0) {
        console.log('🔄 Panel 0 workaround: Simulating panel transfer to ensure WebRTC works');

        // Set up the stream in Panel 0 normally first
        setupStreamInPanel(panelId, streamId, streamKey, playerName, playerId, panel);

        // After 5 seconds, simulate moving the stream to trigger proper WebRTC setup
        setTimeout(() => {
            console.log('🔄 Panel 0 workaround: Triggering mock transfer to refresh WebRTC');

            // Find the active stream
            const stream = activeStreams.get(playerId);
            if (stream && stream.panelId === 0) {
                // Mark as moving to prevent full cleanup
                stream.isMoving = true;

                // Stop current setup but keep it marked as moving
                stopStreamInPanel(0);

                // Wait a moment, then re-request the same stream for Panel 0
                setTimeout(() => {
                    console.log('🔄 Panel 0 workaround: Re-requesting stream for Panel 0');

                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'monitor-request-stream',
                            apiKey: API_KEY,
                            playerId: playerId,
                            panelId: 0,
                            playerName: playerName
                        }));
                    }
                }, 1000);
            }
        }, 5000); // Wait 5 seconds for initial setup to complete

        return; // Exit early for Panel 0 workaround
    }

    // Normal setup for other panels or existing streams
    setupStreamInPanel(panelId, streamId, streamKey, playerName, playerId, panel);
}

// Extracted stream setup logic
function setupStreamInPanel(panelId, streamId, streamKey, playerName, playerId, panel) {
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

    // Video update detection (silent)
    let lastUpdateTime = 0;
    video.addEventListener('timeupdate', () => {
        const now = Date.now();
        if (now - lastUpdateTime > 5000) {
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
            <button class="stream-btn" onclick="fullscreenPanel(${panelId})">⛶</button>
            <button class="stream-btn" onclick="stopPlayerStream(${playerId})">✕</button>
        </div>
    `;

    // Clear panel and add video
    panel.innerHTML = '';
    panel.appendChild(video);
    panel.appendChild(overlay);
    panel.classList.add('active');

    // Set up WebRTC connection for this panel AFTER UI is ready
    console.log('🔗 Setting up peer connection for panel', panelId);

    // Wait a bit for UI to stabilize before setting up WebRTC
    setTimeout(() => {
        setupPeerConnectionForPanel(panelId, video, streamKey);
    }, 500);

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

// Monitor for video source when WebRTC connects but no track arrives
function startVideoSourceMonitoring(panelId, streamKey) {
    console.log(`🔍 Starting video source monitoring for panel ${panelId}`);

    let attempts = 0;
    const maxAttempts = 3;

    const sourceCheckInterval = setInterval(() => {
        attempts++;
        console.log(`🔍 Panel ${panelId}: Video source check attempt ${attempts}/${maxAttempts}`);

        const connectionInfo = panelPeerConnections.get(panelId);
        if (!connectionInfo || !connectionInfo.videoElement) {
            console.log(`❌ Panel ${panelId}: Connection info lost, stopping monitoring`);
            clearInterval(sourceCheckInterval);
            return;
        }

        const video = connectionInfo.videoElement;

        if (video.srcObject && video.videoWidth > 0 && video.videoHeight > 0) {
            console.log(`✅ Panel ${panelId}: Video source now available!`);
            clearInterval(sourceCheckInterval);
            window.videoSourceChecks.delete(panelId);
            return;
        }

        if (attempts >= maxAttempts) {
            console.log(`⚠️ Panel ${panelId}: No video source after ${maxAttempts} attempts, requesting new connection`);
            clearInterval(sourceCheckInterval);
            window.videoSourceChecks.delete(panelId);

            // Request a fresh stream connection
            retryStreamConnection(panelId, streamKey);
        }
    }, 5000); // Check every 5 seconds

    window.videoSourceChecks.set(panelId, sourceCheckInterval);
}

// Retry stream connection when video source is missing
function retryStreamConnection(panelId, streamKey) {
    console.log(`🔄 Retrying stream connection for panel ${panelId}`);

    // Find the active stream for this panel
    let playerId = null;
    activeStreams.forEach((stream, pid) => {
        if (parseInt(stream.panelId) === panelId) {
            playerId = pid;
        }
    });

    if (playerId) {
        console.log(`🔄 Found player ${playerId} for panel ${panelId}, requesting fresh connection`);

        // Clean up current connection
        stopStreamInPanel(panelId);

        // Wait a moment then request new stream
        setTimeout(() => {
            const player = players.find(p => parseInt(p.id) === playerId);
            const playerName = player ? player.name : `Player ${playerId}`;

            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'monitor-request-stream',
                    apiKey: API_KEY,
                    playerId: playerId,
                    panelId: panelId,
                    playerName: playerName
                }));
                console.log(`🔄 Requested fresh stream for player ${playerId} in panel ${panelId}`);
            }
        }, 2000);
    }
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
        iceServers: webrtcConfig ? webrtcConfig.iceServers : [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ],
        iceTransportPolicy: webrtcConfig ? webrtcConfig.iceTransportPolicy : 'all'
    });

    // Handle incoming stream
    pc.ontrack = (event) => {
        console.log('🎥 Video track received for panel', panelId);
        console.log('📊 Track details:', {
            kind: event.track.kind,
            enabled: event.track.enabled,
            readyState: event.track.readyState,
            streamCount: event.streams.length
        });

        const stream = event.streams[0];
        const tracks = stream.getTracks();
        console.log('📊 Stream tracks:', tracks.map(t => ({ kind: t.kind, enabled: t.enabled, readyState: t.readyState })));

        videoElement.srcObject = stream;

        // Clear any existing "no video source" monitoring for this panel
        if (window.videoSourceChecks && window.videoSourceChecks.has(panelId)) {
            clearInterval(window.videoSourceChecks.get(panelId));
            window.videoSourceChecks.delete(panelId);
            console.log(`🧹 Cleared video source check for panel ${panelId} - track received`);
        }

        // Immediate video configuration
        videoElement.style.display = 'block';
        videoElement.style.width = '100%';
        videoElement.style.height = '100%';
        videoElement.style.objectFit = 'contain';
        videoElement.style.backgroundColor = '#000';
        videoElement.muted = true; // Ensure muted for autoplay
        videoElement.autoplay = true;
        videoElement.playsInline = true;

        // Add comprehensive event listeners for debugging
        videoElement.addEventListener('loadstart', () => console.log(`📺 Panel ${panelId}: Load start`));
        videoElement.addEventListener('loadedmetadata', () => {
            console.log(`📺 Panel ${panelId}: Metadata loaded - ${videoElement.videoWidth}x${videoElement.videoHeight}`);
        });
        videoElement.addEventListener('loadeddata', () => {
            console.log(`📺 Panel ${panelId}: Data loaded, ready state: ${videoElement.readyState}`);
        });
        videoElement.addEventListener('canplay', () => {
            console.log(`📺 Panel ${panelId}: Can play`);
        });
        videoElement.addEventListener('playing', () => {
            console.log(`📺 Panel ${panelId}: Playing started`);
        });
        videoElement.addEventListener('waiting', () => {
            console.log(`📺 Panel ${panelId}: Waiting for data`);
        });
        videoElement.addEventListener('stalled', () => {
            console.log(`📺 Panel ${panelId}: Stalled`);
        });

        // Force immediate video playback with multiple attempts
        const attemptPlay = async (attempt = 1) => {
            try {
                console.log(`📺 Panel ${panelId}: Play attempt ${attempt} - ready state: ${videoElement.readyState}`);
                await videoElement.play();
                console.log(`✅ Video playback started for panel ${panelId} (attempt ${attempt})`);
                return true;
            } catch (error) {
                console.log(`⚠️ Video play attempt ${attempt} failed for panel ${panelId}:`, error.message);
                if (attempt < 5) {
                    // Wait and retry with increasing delays
                    setTimeout(() => attemptPlay(attempt + 1), 500 * attempt);
                } else {
                    console.log(`❌ All play attempts failed for panel ${panelId}`);
                }
                return false;
            }
        };

        // Start playing immediately
        setTimeout(() => attemptPlay(), 100);

        // Also try playing when video is loaded
        videoElement.addEventListener('loadeddata', () => {
            console.log(`📺 Panel ${panelId}: Video data loaded, attempting play`);
            setTimeout(() => attemptPlay(), 200);
        });

        videoElement.addEventListener('canplay', () => {
            console.log(`📺 Panel ${panelId}: Video can play, attempting play`);
            setTimeout(() => attemptPlay(), 100);
        });

        console.log('✅ Video stream connected and configured for panel', panelId);

        // Monitor for srcObject loss (reduced logging)
        const debugInterval = setInterval(() => {
            if (!videoElement.srcObject) {
                console.log(`❌ Panel ${panelId}: srcObject lost`);
                clearInterval(debugInterval);
            }
        }, 5000);

        // Clear debug after 30 seconds
        setTimeout(() => clearInterval(debugInterval), 30000);
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

            // Start monitoring for video tracks after connection establishes (extended delay)
            setTimeout(() => {
                if (!videoElement.srcObject) {
                    console.log(`⚠️ Panel ${panelId}: WebRTC connected but no video source after 10 seconds`);
                    startVideoSourceMonitoring(panelId, streamKey);
                }
            }, 10000); // Increased from 3 to 10 seconds

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

    // Register as viewer for this stream IMMEDIATELY (viewer registration should happen first)
    console.log('📝 Registering as viewer for panel', panelId, 'with stream key', streamKey);
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'register-viewer',
            streamKey: streamKey,
            panelId: panelId  // Include panelId so server knows which panel this is for
        }));
        console.log('✅ Viewer registration sent for panel', panelId);

        // Set up WebRTC failure detection for potential WebSocket fallback
        if (webrtcConfig && webrtcConfig.forceRelayOnly) {
            console.log('🔍 Setting up WebRTC failure detection for firewall-free mode');
            detectWebRTCFailure(streamKey, panelId);
        }
    } else {
        console.error('❌ Cannot register viewer - WebSocket not connected');
    }
}

// Handle WebRTC offer from streamer
async function handleWebRTCOffer(data) {
    const { offer, streamerId, panelId } = data;

    console.log('📡 Processing WebRTC offer from streamer', streamerId, 'for panel', panelId);

    // Find the peer connection for this specific panel
    let connectionInfo = null;

    // First try to find by panelId (most accurate)
    if (typeof panelId === 'number') {
        connectionInfo = panelPeerConnections.get(panelId);
        console.log('📡 Found peer connection by panelId', panelId);
    }

    // Fallback: find the most recently created connection that's ready
    if (!connectionInfo) {
        console.log('📡 Searching for available peer connection...');
        panelPeerConnections.forEach((info, key) => {
            if (info.pc && (info.pc.connectionState === 'new' || info.pc.connectionState === 'stable')) {
                connectionInfo = info;
                console.log('📡 Found available peer connection for panel', info.panelId);
            }
        });
    }

    // If still no connection, wait a bit and try again (race condition fix)
    if (!connectionInfo) {
        console.log('⏳ No peer connection ready yet, waiting 1 second...');
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Try again after waiting
        if (typeof panelId === 'number') {
            connectionInfo = panelPeerConnections.get(panelId);
        }

        if (!connectionInfo) {
            panelPeerConnections.forEach((info, key) => {
                if (info.pc && (info.pc.connectionState === 'new' || info.pc.connectionState === 'stable')) {
                    connectionInfo = info;
                }
            });
        }
    }

    if (!connectionInfo) {
        console.error('❌ No peer connection found for WebRTC offer after retry');
        console.log('📊 Available connections:', Array.from(panelPeerConnections.keys()));
        return;
    }

    const { pc, panelId: actualPanelId, videoElement } = connectionInfo;

    try {
        console.log('📡 Setting remote description for panel', actualPanelId);
        await pc.setRemoteDescription(new RTCSessionDescription(offer));

        console.log('📡 Creating answer for panel', actualPanelId);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        console.log('📡 Sending answer for panel', actualPanelId);
        ws.send(JSON.stringify({
            type: 'answer',
            answer: answer
        }));

        // Force video to start playing immediately after connection with multiple attempts
        const forcePlay = async (attempt = 1) => {
            if (videoElement && attempt <= 3) {
                try {
                    console.log(`📺 Attempt ${attempt}: Force starting video playback for panel ${actualPanelId}`);
                    await videoElement.play();
                    console.log(`✅ Video playing successfully on attempt ${attempt}`);
                } catch (e) {
                    console.log(`⚠️ Play attempt ${attempt} failed:`, e.message);
                    if (attempt < 3) {
                        setTimeout(() => forcePlay(attempt + 1), 1000);
                    } else {
                        console.log('❌ All play attempts failed - user interaction may be required');
                    }
                }
            }
        };

        setTimeout(() => forcePlay(), 500);

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
        console.log(`🛑 Found stream for player ${playerId}, sending stop commands`);

        // First send stop command to server to stop the actual RedM streaming
        if (ws && ws.readyState === WebSocket.OPEN) {
            console.log(`📤 Sending stream stop command to server for player ${playerId}`);

            ws.send(JSON.stringify({
                type: 'monitor-stop-stream',
                apiKey: API_KEY,
                playerId: playerId,
                panelId: stream.panelId,
                streamKey: stream.streamKey,
                reason: 'manual_stop'
            }));

            // Also send a direct cleanup command to ensure RedM stops
            ws.send(JSON.stringify({
                type: 'cleanup-stream',
                apiKey: API_KEY,
                playerId: playerId,
                streamKey: stream.streamKey,
                reason: 'manual_stop'
            }));

            console.log(`📤 Stop commands sent for player ${playerId}`);
        }

        // Then clean up the monitor panel
        stopStreamInPanel(stream.panelId);
    } else {
        console.log(`❌ No active stream found for player ${playerId}`);
    }
}

// Fullscreen specific panel
function fullscreenPanel(panelId) {
    console.log('🖥️ Fullscreen panel', panelId);

    // Convert to number in case it's a string
    panelId = parseInt(panelId);

    const panel = panels[panelId];
    if (panel) {
        // Check if already in fullscreen mode
        if (document.fullscreenElement === panel ||
            document.webkitFullscreenElement === panel ||
            document.mozFullScreenElement === panel ||
            document.msFullscreenElement === panel) {

            // Exit fullscreen
            if (document.exitFullscreen) {
                document.exitFullscreen();
            } else if (document.webkitExitFullscreen) {
                document.webkitExitFullscreen();
            } else if (document.mozCancelFullScreen) {
                document.mozCancelFullScreen();
            } else if (document.msExitFullscreen) {
                document.msExitFullscreen();
            }
            console.log('🖥️ Exiting fullscreen');
        } else {
            // Enter fullscreen
            if (panel.requestFullscreen) {
                panel.requestFullscreen();
            } else if (panel.webkitRequestFullscreen) {
                panel.webkitRequestFullscreen();
            } else if (panel.mozRequestFullScreen) {
                panel.mozRequestFullScreen();
            } else if (panel.msRequestFullscreen) {
                panel.msRequestFullscreen();
            }
            console.log('🖥️ Entering fullscreen');
        }
    } else {
        console.error('❌ Panel not found for fullscreen:', panelId);
    }
}

function updateConnectionStatus(status) {
    const statusElement = document.getElementById('connectionStatus');
    if (statusElement) {
        statusElement.textContent = status;
        statusElement.className = `connection-status ${isConnected ? 'connected' : 'disconnected'}`;
    }

    // Also check server health if disconnected
    if (!isConnected && status === 'Disconnected') {
        setTimeout(checkServerHealth, 1000);
    }
}

// Check if the media server is running
async function checkServerHealth() {
    try {
        const response = await fetch(`${SERVER_URL}/api/health`, {
            method: 'GET',
            headers: { 'x-api-key': API_KEY }
        });

        if (response.ok) {
            const health = await response.json();
            console.log('🏥 Server is healthy:', health);
            console.log('🔄 Server is running but WebSocket failed - check WebSocket URL');
        } else {
            console.error('❌ Server health check failed:', response.status);
        }
    } catch (error) {
        console.error('❌ Server not reachable:', error.message);
        console.log('💡 Make sure the media server is running on port 3000');
    }
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

    // Check if already streaming - mark as moving if changing panels
    const existingStream = activeStreams.get(playerId);
    if (existingStream) {
        console.log('⏹️ Moving existing stream for player', playerId, 'from panel', existingStream.panelId, 'to panel', panelId);

        // Mark as moving to prevent full stream stop
        existingStream.isMoving = true;
        stopStreamInPanel(existingStream.panelId);

        // Wait a bit before starting in new panel to allow cleanup
        await new Promise(resolve => setTimeout(resolve, 1000));
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

        // Send cleanup notification to server with appropriate reason
        if (ws && ws.readyState === WebSocket.OPEN && stream.streamKey) {
            const reason = stream.isMoving ? 'panel_change' : 'panel_closed';
            console.log(`🧹 Sending cleanup with reason: ${reason}`);

            ws.send(JSON.stringify({
                type: 'cleanup-stream',
                apiKey: API_KEY,
                streamKey: stream.streamKey,
                playerId: playerId,
                reason: reason
            }));
        }

        // Close peer connection using new Map
        const connectionInfo = panelPeerConnections.get(panelId);
        if (connectionInfo) {
            console.log('🔌 Closing peer connection for panel', panelId);
            try {
                connectionInfo.pc.close();
            } catch (e) {
                console.log('⚠️ Error closing peer connection:', e);
            }
            panelPeerConnections.delete(panelId);
            panelPeerConnections.delete(connectionInfo.streamKey);
        }

        // Stop video properly
        if (stream.video) {
            try {
                stream.video.pause();
                stream.video.srcObject = null;
                stream.video.load(); // Reset video element
            } catch (e) {
                console.log('⚠️ Error stopping video:', e);
            }
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

    // Re-add event listeners for drag and drop
    panel.addEventListener('dragover', handleDragOver);
    panel.addEventListener('drop', handleDrop);
    panel.addEventListener('dragleave', handleDragLeave);
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

// Stream sharing variables
let sharedConnections = new Map(); // sharedViewer -> RTCPeerConnection
let isSharedViewer = false;
let primaryViewerConnection = null;

// Stream sharing functions
function handleSharedViewerSetup(streamKey, primaryViewer) {
    console.log(`🤝 Setting up as shared viewer for stream ${streamKey} from primary ${primaryViewer}`);
    isSharedViewer = true;
    // Wait for primary viewer to initiate sharing
}

function handleShareStreamRequest(sharedViewer, panelId) {
    console.log(`🤝 Primary viewer: Creating peer connection to share stream with ${sharedViewer}`);

    // Get the current stream from our video element
    const stream = Array.from(activeStreams.values()).find(s => s.panelId !== undefined);
    if (!stream || !stream.video || !stream.video.srcObject) {
        console.error('❌ No active stream to share');
        return;
    }

    const mediaStream = stream.video.srcObject;
    console.log('🎥 Sharing stream with tracks:', mediaStream.getTracks().map(t => t.kind));

    // Create peer connection for sharing
    const pc = new RTCPeerConnection({
        iceServers: webrtcConfig ? webrtcConfig.iceServers : [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ],
        iceTransportPolicy: webrtcConfig ? webrtcConfig.iceTransportPolicy : 'all'
    });

    // Add the stream to share
    mediaStream.getTracks().forEach(track => {
        pc.addTrack(track, mediaStream);
        console.log(`🎥 Added ${track.kind} track to shared connection`);
    });

    // Handle ICE candidates
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            ws.send(JSON.stringify({
                type: 'stream-share-ice',
                targetViewer: sharedViewer,
                candidate: event.candidate
            }));
        }
    };

    // Store connection
    sharedConnections.set(sharedViewer, pc);

    // Create and send offer
    pc.createOffer().then(offer => {
        return pc.setLocalDescription(offer);
    }).then(() => {
        ws.send(JSON.stringify({
            type: 'stream-share-offer',
            targetViewer: sharedViewer,
            offer: pc.localDescription
        }));
        console.log(`🤝 Sent stream share offer to ${sharedViewer}`);
    }).catch(error => {
        console.error('❌ Error creating stream share offer:', error);
    });
}

function handleStreamShareOffer(sourceViewer, offer) {
    console.log(`🤝 Shared viewer: Received offer from primary ${sourceViewer}`);

    // Create peer connection to receive shared stream
    primaryViewerConnection = new RTCPeerConnection({
        iceServers: webrtcConfig ? webrtcConfig.iceServers : [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ],
        iceTransportPolicy: webrtcConfig ? webrtcConfig.iceTransportPolicy : 'all'
    });

    // Handle incoming stream
    primaryViewerConnection.ontrack = (event) => {
        console.log('🎥 Received shared stream from primary viewer');
        const receivedStream = event.streams[0];

        // Find the panel that's waiting for this stream
        const stream = Array.from(activeStreams.values()).find(s => !s.video.srcObject);
        if (stream) {
            stream.video.srcObject = receivedStream;
            console.log(`🎥 Applied shared stream to panel ${stream.panelId}`);
        }
    };

    // Handle ICE candidates
    primaryViewerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            ws.send(JSON.stringify({
                type: 'stream-share-ice',
                targetViewer: sourceViewer,
                candidate: event.candidate
            }));
        }
    };

    // Set remote description and create answer
    primaryViewerConnection.setRemoteDescription(offer).then(() => {
        return primaryViewerConnection.createAnswer();
    }).then(answer => {
        return primaryViewerConnection.setLocalDescription(answer);
    }).then(() => {
        ws.send(JSON.stringify({
            type: 'stream-share-answer',
            targetViewer: sourceViewer,
            answer: primaryViewerConnection.localDescription
        }));
        console.log(`🤝 Sent stream share answer to ${sourceViewer}`);
    }).catch(error => {
        console.error('❌ Error handling stream share offer:', error);
    });
}

function handleStreamShareAnswer(sourceViewer, answer) {
    console.log(`🤝 Primary viewer: Received answer from shared ${sourceViewer}`);

    const pc = sharedConnections.get(sourceViewer);
    if (pc) {
        pc.setRemoteDescription(answer).then(() => {
            console.log(`✅ Stream sharing established with ${sourceViewer}`);
        }).catch(error => {
            console.error('❌ Error setting remote description for stream share:', error);
        });
    }
}

function handleStreamShareIce(sourceViewer, candidate) {
    const pc = isSharedViewer ? primaryViewerConnection : sharedConnections.get(sourceViewer);
    if (pc) {
        pc.addIceCandidate(candidate).catch(error => {
            console.error('❌ Error adding ICE candidate for stream share:', error);
        });
    }
}

function handlePromotedToPrimary(streamKey) {
    console.log(`🔄 Promoted to primary viewer - transitioning from shared to direct WebRTC`);
    isSharedViewer = false;

    // Clean up shared connection
    if (primaryViewerConnection) {
        primaryViewerConnection.close();
        primaryViewerConnection = null;
    }

    // The stream should continue normally as we're now the primary viewer
    // Future viewers will connect to us for sharing
}

// WebSocket video streaming fallback functions
function enableWebSocketStreaming(streamKey, panelId) {
    console.log(`📺 Enabling WebSocket streaming for ${streamKey} in panel ${panelId}`);
    wsStreamingEnabled = true;

    // Find the panel and set up canvas for WebSocket streaming
    const stream = Array.from(activeStreams.values()).find(s => s.streamKey === streamKey);
    if (!stream) {
        console.error('❌ Stream not found for WebSocket fallback');
        return;
    }

    // Create a canvas element to draw frames
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = 640;
    canvas.height = 360;
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.objectFit = 'contain';

    // Replace video element with canvas
    const videoElement = stream.video;
    if (videoElement && videoElement.parentNode) {
        videoElement.parentNode.replaceChild(canvas, videoElement);
        stream.video = canvas; // Update reference
    }

    // Store connection info
    wsStreamingConnections.set(streamKey, {
        canvas: canvas,
        ctx: ctx,
        panelId: panelId
    });

    // Request WebSocket streaming from server
    ws.send(JSON.stringify({
        type: 'request-ws-streaming',
        streamKey: streamKey,
        panelId: panelId
    }));

    console.log(`✅ WebSocket streaming enabled for panel ${panelId}`);
}

function handleWebSocketVideoFrame(streamKey, frameData) {
    const connection = wsStreamingConnections.get(streamKey);
    if (!connection) {
        console.error('❌ No WebSocket streaming connection found for', streamKey);
        return;
    }

    try {
        // Decode base64 frame and draw to canvas
        const img = new Image();
        img.onload = () => {
            connection.ctx.clearRect(0, 0, connection.canvas.width, connection.canvas.height);
            connection.ctx.drawImage(img, 0, 0, connection.canvas.width, connection.canvas.height);
        };
        img.src = 'data:image/jpeg;base64,' + frameData;
    } catch (error) {
        console.error('❌ Error handling WebSocket video frame:', error);
    }
}

// Function to detect WebRTC failure and fallback to WebSocket
function detectWebRTCFailure(streamKey, panelId) {
    console.log(`🔍 Detecting WebRTC failure for ${streamKey}, considering WebSocket fallback`);

    // Wait 10 seconds for WebRTC to establish
    setTimeout(() => {
        const stream = Array.from(activeStreams.values()).find(s => s.streamKey === streamKey);
        if (stream && stream.video && !stream.video.srcObject) {
            console.log('⚠️ WebRTC failed to establish, falling back to WebSocket streaming');
            enableWebSocketStreaming(streamKey, panelId);
        }
    }, 10000);
}

console.log('🔧 Complete monitor loaded. Available debug functions:', Object.keys(window.monitorDebug));