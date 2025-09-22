const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const turn = require('node-turn');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;
const TURN_PORT = process.env.TURN_PORT || 3478;
const API_KEY = process.env.API_KEY || 'redm-media-server-key-2024';

// Built-in TURN server configuration
const turnServer = new turn({
    // TURN server listens on port 3478 (standard TURN port)
    listeningPort: TURN_PORT,
    listeningIps: ['0.0.0.0'],
    // Use a simple authentication
    credentials: {
        'redm-turn-user': 'redm-turn-pass'
    },
    // Enable debugging
    debugLevel: 'INFO',
    // Relay configuration
    relayIps: ['0.0.0.0'],
    relayPortRange: '49152-65535'
});

// Middleware
app.use(cors());
app.use(express.json());
app.use('/player', express.static(path.join(__dirname, 'public')));

// Serve monitor page specifically
app.get('/monitor', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'monitor.html'));
});

// Serve static files for monitor assets
app.use('/monitor', express.static(path.join(__dirname, 'public')));

// WebSocket server for WebRTC signaling
const wss = new WebSocket.Server({ 
    server,
    path: '/ws'
});

// Store active streams and connections
const activeStreams = new Map();
const connections = new Map();
const viewers = new Map();
let playerList = [];
let monitorConnections = new Set();
let pendingStreamRequests = new Map(); // Store pending stream requests for polling

// Stream sharing coordination
const streamSharing = new Map(); // streamKey -> { primaryViewer: clientId, sharedViewers: Set[clientId], streamObject: MediaStream }

// API authentication
const authenticateAPI = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
};

// WebSocket API key validation
const validateWSApiKey = (data) => {
    return data.apiKey === API_KEY;
};

// Health check
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'healthy',
        streams: activeStreams.size,
        connections: connections.size,
        viewers: viewers.size,
        uptime: process.uptime()
    });
});

// Create stream endpoint (kept for backward compatibility)
app.post('/api/streams/create', authenticateAPI, (req, res) => {
    const { streamId, playerId, playerName } = req.body;
    
    if (activeStreams.has(streamId)) {
        return res.status(400).json({ error: 'Stream already exists' });
    }
    
    const streamKey = uuidv4();
    const webSocketUrl = `ws://localhost:${PORT}/ws`;
    const viewerUrl = `http://localhost:${PORT}/player/viewer.html?stream=${streamKey}`;
    
    activeStreams.set(streamId, {
        streamId,
        streamKey,
        playerId,
        playerName,
        viewerUrl,
        startTime: Date.now(),
        viewerCount: 0,
        stats: {},
        streamerWs: null,
        viewerWsList: [],
        lastHeartbeat: Date.now()
    });
    
    console.log(`[Stream Created] ${streamId} - Player: ${playerName} - Key: ${streamKey}`);
    
    res.json({
        streamId,
        streamKey,
        webrtcEndpoint: `http://localhost:${PORT}/webrtc`,
        webSocketUrl,
        viewerUrl,
        stunServer: 'stun:stun.l.google.com:19302',
        hlsUrl: viewerUrl
    });
});

// Stop stream endpoint
app.post('/api/streams/:streamId/stop', authenticateAPI, (req, res) => {
    const { streamId } = req.params;
    
    if (!activeStreams.has(streamId)) {
        return res.status(404).json({ error: 'Stream not found' });
    }
    
    stopStream(streamId);
    res.json({ success: true });
});

// Get stream stats
app.get('/api/streams/:streamId/stats', authenticateAPI, (req, res) => {
    const { streamId } = req.params;
    
    if (!activeStreams.has(streamId)) {
        return res.status(404).json({ error: 'Stream not found' });
    }
    
    const stream = activeStreams.get(streamId);
    res.json({
        streamId,
        playerName: stream.playerName,
        duration: Date.now() - stream.startTime,
        viewers: stream.viewerCount,
        ...stream.stats
    });
});

// Stream heartbeat
app.post('/api/streams/:streamId/heartbeat', authenticateAPI, (req, res) => {
    const { streamId } = req.params;
    const stream = activeStreams.get(streamId);
    
    if (stream) {
        stream.lastHeartbeat = Date.now();
        stream.playerName = req.body.playerName || stream.playerName;
        stream.playerId = req.body.playerId || stream.playerId;
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Stream not found' });
    }
});

// List all streams
app.get('/api/streams', authenticateAPI, (req, res) => {
    const streams = Array.from(activeStreams.values()).map(stream => ({
        streamId: stream.streamId,
        streamKey: stream.streamKey,
        playerName: stream.playerName,
        viewerUrl: stream.viewerUrl,
        viewers: stream.viewerCount,
        duration: Date.now() - stream.startTime,
        hlsUrl: stream.viewerUrl
    }));
    
    res.json(streams);
});

// Update player list
app.post('/api/players/update', authenticateAPI, (req, res) => {
    playerList = req.body.players || [];

    // Broadcast to all monitor connections
    broadcastToMonitors({
        type: 'player-update',
        players: playerList
    });

    res.json({ success: true });
});

// Get player list
app.get('/api/players', authenticateAPI, (req, res) => {
    res.json({ 
        players: playerList,
        timestamp: Date.now()
    });
});

// Polling endpoint for RedM server to check for pending stream requests
app.get('/api/monitor/pending-requests', authenticateAPI, (req, res) => {
    const requests = Array.from(pendingStreamRequests.values());
    
    if (requests.length > 0) {
        console.log(`[Polling] Sending ${requests.length} pending stream requests to RedM server`);
        requests.forEach(req => {
            console.log(`[Polling] - Player ${req.playerId} (${req.playerName}) -> Panel ${req.panelId}`);
        });
    }
    
    // Clear the requests after sending them
    pendingStreamRequests.clear();
    
    res.json({ 
        requests: requests,
        timestamp: Date.now()
    });
});

// Endpoint for RedM server to confirm stream was started
app.post('/api/monitor/stream-started', authenticateAPI, (req, res) => {
    const { playerId, streamId, streamKey, panelId, playerName } = req.body;
    
    console.log(`[Monitor] Stream confirmed started: ${playerName} (${streamId}) in panel ${panelId}`);
    
    // Broadcast to monitors that stream is ready
    broadcastToMonitors({
        type: 'stream-ready',
        streamId: streamId,
        streamKey: streamKey,
        playerName: playerName,
        playerId: playerId,
        panelId: panelId
    });
    
    res.json({ success: true });
});

// Endpoint to get WebRTC configuration (ICE servers, TURN settings)
app.get('/api/webrtc/config', (req, res) => {
    const turnEnabled = process.env.TURN_ENABLED !== 'false'; // Default to true now
    const forceRelayOnly = process.env.FORCE_RELAY_ONLY === 'true';

    const iceServers = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ];

    // Add built-in TURN server
    if (turnEnabled) {
        iceServers.push({
            urls: `turn:localhost:${TURN_PORT}`,
            username: 'redm-turn-user',
            credential: 'redm-turn-pass'
        });
    }

    const config = {
        iceServers: iceServers,
        iceTransportPolicy: forceRelayOnly ? 'relay' : 'all',
        turnEnabled: turnEnabled,
        forceRelayOnly: forceRelayOnly,
        iceCandidatePoolSize: 0, // Prevent ICE candidate gathering to avoid firewall prompts
        bundlePolicy: 'balanced', // Use balanced bundle policy
        rtcpMuxPolicy: 'require' // Force RTCP multiplexing to reduce port usage
    };

    console.log(`[WebRTC Config] Serving configuration: TURN=${turnEnabled}, Relay-Only=${forceRelayOnly}`);
    res.json(config);
});

// Endpoint for RedM server to notify stream ended
app.post('/api/monitor/stream-ended', authenticateAPI, (req, res) => {
    const { playerId, streamId, streamKey, reason } = req.body;
    
    console.log(`[Monitor] Stream ended: Player ${playerId}, Stream ${streamId}, Reason: ${reason}`);
    
    // Find and stop the stream
    if (activeStreams.has(streamId)) {
        stopStream(streamId);
    }
    
    // Broadcast to monitors
    broadcastToMonitors({
        type: 'stream-ended',
        streamKey: streamKey,
        streamId: streamId,
        playerId: playerId,
        reason: reason
    });
    
    res.json({ success: true });
});

// WebRTC offer endpoint (for streamer)
app.post('/webrtc/offer', async (req, res) => {
    const streamId = req.headers['x-stream-id'];
    const { offer } = req.body;
    
    if (!activeStreams.has(streamId)) {
        return res.status(404).json({ error: 'Stream not found' });
    }
    
    const stream = activeStreams.get(streamId);
    stream.pendingOffer = offer;
    
    res.json({
        success: true,
        message: 'Connect via WebSocket to complete setup',
        webSocketUrl: `ws://localhost:${PORT}/ws`
    });
    
    console.log(`[WebRTC] Offer received for stream ${streamId}`);
});

// Helper function to stop a stream
function stopStream(streamId) {
    const stream = activeStreams.get(streamId);
    if (!stream) return;

    console.log(`[Stream Stop] Stopping stream ${streamId}`);

    // Clear any timers
    if (stream.autoStopTimer) {
        clearTimeout(stream.autoStopTimer);
        stream.autoStopTimer = null;
    }

    // Close all viewer connections
    stream.viewerWsList.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'stream-ended' }));
            ws.close();
        }
    });

    // Close streamer connection
    if (stream.streamerWs && stream.streamerWs.readyState === WebSocket.OPEN) {
        stream.streamerWs.close();
    }

    // IMPORTANT: Remove the stream from activeStreams to allow restart
    activeStreams.delete(streamId);
    console.log(`[Stream Stop] ✅ Stream ${streamId} fully cleaned up and removed`);
}

// Helper function to broadcast to all monitors
function broadcastToMonitors(message) {
    connections.forEach((conn, clientId) => {
        if (conn.role === 'monitor' && conn.ws.readyState === WebSocket.OPEN) {
            conn.ws.send(JSON.stringify(message));
        }
    });
}

// WebSocket handling
wss.on('connection', (ws, req) => {
    const clientId = uuidv4();
    console.log(`[WS] Client connected: ${clientId}`);
    
    connections.set(clientId, {
        ws,
        role: null,
        streamKey: null
    });
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            handleWebSocketMessage(clientId, ws, data);
        } catch (error) {
            console.error(`[WS] Error parsing message from ${clientId}:`, error);
        }
    });
    
    ws.on('close', () => {
        console.log(`[WS] Client disconnected: ${clientId}`);
        handleDisconnect(clientId);
    });
    
    ws.on('error', (error) => {
        console.error(`[WS] Error for client ${clientId}:`, error);
    });
});

function handleWebSocketMessage(clientId, ws, data) {
    const connection = connections.get(clientId);

    switch(data.type) {
        case 'register-streamer':
            handleStreamerRegistration(clientId, ws, data);
            break;

        case 'register-viewer':
            handleViewerRegistration(clientId, ws, data);
            break;

        case 'register-monitor':
            handleMonitorRegistration(clientId, ws, data);
            break;

        // Monitor-specific messages
        case 'monitor-request-stream':
            handleMonitorStreamRequest(clientId, ws, data);
            break;

        case 'monitor-stop-stream':
            handleMonitorStopStream(clientId, ws, data);
            break;

        case 'monitor-get-players':
            handleMonitorGetPlayers(clientId, ws, data);
            break;

        case 'cleanup-stream':
            handleStreamCleanup(clientId, ws, data);
            break;

        case 'offer':
            handleOffer(clientId, data);
            break;

        case 'answer':
            handleAnswer(clientId, data);
            break;

        case 'ice-candidate':
            handleIceCandidate(clientId, data);
            break;

        case 'ping':
            ws.send(JSON.stringify({ type: 'pong' }));
            break;

        case 'pong':
            // Silently handle pong responses
            break;

        case 'stream-share-offer':
            handleStreamShareOffer(clientId, ws, data);
            break;

        case 'stream-share-answer':
            handleStreamShareAnswer(clientId, ws, data);
            break;

        case 'stream-share-ice':
            handleStreamShareIce(clientId, ws, data);
            break;

        case 'request-ws-streaming':
            handleRequestWSStreaming(clientId, ws, data);
            break;

        case 'ws-stream-frame':
            handleWSStreamFrame(clientId, ws, data);
            break;

        default:
            console.log(`[WS] Unknown message type: ${data.type}`);
    }
}

function handleMonitorRegistration(clientId, ws, data) {
    // Validate API key for monitor registration
    if (!validateWSApiKey(data)) {
        ws.send(JSON.stringify({ 
            type: 'error', 
            message: 'Invalid API key' 
        }));
        ws.close();
        return;
    }

    const connection = connections.get(clientId);
    connection.role = 'monitor';
    monitorConnections.add(clientId);
    
    ws.send(JSON.stringify({
        type: 'registered', 
        role: 'monitor'
    }));
    
    // Send current player list
    ws.send(JSON.stringify({
        type: 'player-update', 
        players: playerList
    }));
    
    // Send current active streams
    const streams = Array.from(activeStreams.values()).map(stream => ({
        streamId: stream.streamId,
        streamKey: stream.streamKey,
        playerName: stream.playerName,
        playerId: stream.playerId,
        viewers: stream.viewerCount || 0
    }));
    ws.send(JSON.stringify({
        type: 'active-streams', 
        streams: streams
    }));
    
    console.log(`[WS] Monitor registered: ${clientId}`);
}

function handleMonitorStreamRequest(clientId, ws, data) {
    // Validate API key
    if (!validateWSApiKey(data)) {
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Invalid API key'
        }));
        return;
    }

    const { playerId, panelId, playerName } = data;

    // Check if stream already exists for this player (handle string/number comparison)
    let existingStream = null;
    let existingStreamId = null;

    console.log(`[Monitor] Looking for existing stream for player ${playerId} (type: ${typeof playerId})`);

    activeStreams.forEach((stream, streamId) => {
        console.log(`[Monitor] Checking stream ${streamId}, playerId: ${stream.playerId} (type: ${typeof stream.playerId})`);
        if (stream.playerId == playerId || stream.playerId === String(playerId) || stream.playerId === Number(playerId)) {
            existingStream = stream;
            existingStreamId = streamId;
            console.log(`[Monitor] Found existing stream for player ${playerId}: ${streamId}`);
        }
    });

    if (existingStream && !existingStream.manualStop) {
        // Reuse existing stream - multiple viewers can watch the same stream
        // BUT NOT if it was manually stopped
        ws.send(JSON.stringify({
            type: 'stream-assigned',
            panelId: panelId,
            streamId: existingStreamId,
            streamKey: existingStream.streamKey,
            playerName: existingStream.playerName,
            playerId: playerId,
            existing: true // Indicate this is reusing an existing stream
        }));

        console.log(`[Monitor] Existing stream reused: ${existingStream.playerName} to panel ${panelId} (viewers: ${existingStream.viewerCount})`);
    } else {
        if (existingStream && existingStream.manualStop) {
            console.log(`[Monitor] Found manually stopped stream for player ${playerId} - cleaning up and creating fresh stream`);

            // Clean up the old manually stopped stream
            stopStream(existingStreamId);
        }

        // Create new stream request for polling
        const streamId = uuidv4();
        const streamKey = uuidv4();
        const requestId = uuidv4();

        // Store the request for RedM server to poll
        pendingStreamRequests.set(requestId, {
            playerId: playerId,
            panelId: panelId,
            playerName: playerName || `Player ${playerId}`,
            streamId: streamId,
            streamKey: streamKey,
            timestamp: Date.now()
        });

        // Create stream entry (will be activated when RedM confirms)
        activeStreams.set(streamId, {
            streamId,
            streamKey,
            playerId,
            playerName: playerName || `Player ${playerId}`,
            viewerUrl: `http://localhost:${PORT}/player/viewer.html?stream=${streamKey}`,
            startTime: Date.now(),
            viewerCount: 0,
            stats: {},
            streamerWs: null,
            viewerWsList: [],
            lastHeartbeat: Date.now(),
            monitorRequested: true,
            panelId: panelId,
            status: 'pending' // Mark as pending until confirmed
        });

        // Send assignment to monitor immediately
        ws.send(JSON.stringify({
            type: 'stream-assigned',
            panelId: panelId,
            streamId: streamId,
            streamKey: streamKey,
            playerName: playerName || `Player ${playerId}`,
            playerId: playerId,
            existing: false
        }));

        console.log(`[Monitor] New stream request queued: ${playerName} (${streamId}) for panel ${panelId}`);
        console.log(`[Monitor] Pending requests: ${pendingStreamRequests.size}`);
    }
}

function handleMonitorStopStream(clientId, ws, data) {
    // Validate API key
    if (!validateWSApiKey(data)) {
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Invalid API key'
        }));
        return;
    }

    const { playerId, panelId, streamKey } = data;

    console.log(`[Monitor] Stop stream requested: Player ${playerId}, Panel ${panelId}`);

    // Find and stop the stream (handle type comparisons properly)
    let streamToStop = null;
    console.log(`[Monitor] Looking for stream to stop: player ${playerId}, streamKey: ${streamKey}`);

    activeStreams.forEach((stream, streamId) => {
        console.log(`[Monitor] Checking stream ${streamId}: playerId ${stream.playerId}, streamKey ${stream.streamKey}`);

        if (stream.playerId == playerId ||
            stream.playerId === String(playerId) ||
            stream.playerId === Number(playerId) ||
            stream.streamKey === streamKey) {
            streamToStop = { streamId, stream };
            console.log(`[Monitor] Found stream to stop: ${streamId}`);
        }
    });

    if (streamToStop) {
        const { streamId, stream } = streamToStop;

        console.log(`[Monitor] Stopping stream ${streamId} for player ${playerId}`);

        // Mark as manual stop to prevent auto-stop interference
        stream.manualStop = true;

        // Forcefully close streamer connection if it exists
        if (stream.streamerWs && stream.streamerWs.readyState === WebSocket.OPEN) {
            const forceStopMessage = {
                type: 'force-stop',
                reason: 'manual_stop',
                streamId: streamId,
                playerId: playerId
            };

            console.log(`[Monitor] Sending force-stop to streamer:`, forceStopMessage);
            stream.streamerWs.send(JSON.stringify(forceStopMessage));
            console.log(`[Monitor] ✅ Force-stop sent to streamer for stream ${streamId}`);
        } else {
            console.log(`[Monitor] ❌ Cannot send force-stop - streamer not connected`);
            console.log(`[Monitor] Streamer WS exists: ${!!stream.streamerWs}`);
            console.log(`[Monitor] Streamer WS state: ${stream.streamerWs?.readyState}`);
        }

        // Stop the stream
        console.log(`[Monitor] Calling stopStream for ${streamId}`);

        // Clear any auto-stop timers before manual stop
        if (stream.autoStopTimer) {
            console.log(`[Monitor] Clearing auto-stop timer for manual stop`);
            clearTimeout(stream.autoStopTimer);
            stream.autoStopTimer = null;
        }

        stopStream(streamId);

        // Notify monitor that stream stopped
        broadcastToMonitors({
            type: 'stream-stopped',
            panelId: panelId,
            playerId: playerId,
            streamKey: streamKey
        });

        console.log(`[Monitor] ✅ Stream stopped: player ${playerId} in panel ${panelId}`);
    } else {
        console.log(`[Monitor] ❌ No stream found to stop for player ${playerId}`);
        console.log(`[Monitor] Available streams:`, Array.from(activeStreams.keys()));
    }
}

function handleMonitorGetPlayers(clientId, ws, data) {
    // Validate API key
    if (!validateWSApiKey(data)) {
        ws.send(JSON.stringify({ 
            type: 'error', 
            message: 'Invalid API key' 
        }));
        return;
    }

    // Send current player list
    ws.send(JSON.stringify({
        type: 'player-update',
        players: playerList
    }));
}

function handleStreamerRegistration(clientId, ws, data) {
    const { streamKey } = data;

    console.log(`[WS] Streamer attempting registration with key: ${streamKey}`);
    console.log(`[WS] Available streams:`, Array.from(activeStreams.keys()));

    // Find stream by key
    let stream = null;
    let streamId = null;
    for (const [id, s] of activeStreams) {
        if (s.streamKey === streamKey) {
            stream = s;
            streamId = id;
            break;
        }
    }

    if (!stream) {
        console.log(`[WS] Stream not found for key: ${streamKey}`);
        console.log(`[WS] Active stream keys:`, Array.from(activeStreams.values()).map(s => s.streamKey));

        // Instead of rejecting, try to find if there's a pending stream for this client
        let pendingStream = null;
        pendingStreamRequests.forEach((req, reqId) => {
            if (!pendingStream) {
                console.log(`[WS] Checking pending request for player ${req.playerId} with key ${req.streamKey}`);
                pendingStream = req;
            }
        });

        if (pendingStream) {
            console.log(`[WS] Found pending stream with key ${pendingStream.streamKey}, redirecting streamer`);

            // Create the stream entry if it doesn't exist
            if (!activeStreams.has(pendingStream.streamId)) {
                activeStreams.set(pendingStream.streamId, {
                    streamId: pendingStream.streamId,
                    streamKey: pendingStream.streamKey,
                    playerId: pendingStream.playerId,
                    playerName: pendingStream.playerName,
                    viewerUrl: `http://localhost:${PORT}/player/viewer.html?stream=${pendingStream.streamKey}`,
                    startTime: Date.now(),
                    viewerCount: 0,
                    stats: {},
                    streamerWs: null,
                    viewerWsList: [],
                    lastHeartbeat: Date.now(),
                    monitorRequested: true,
                    panelId: pendingStream.panelId,
                    status: 'pending'
                });
            }

            // Update the stream key in the lookup
            stream = activeStreams.get(pendingStream.streamId);
            streamKey = pendingStream.streamKey;
            console.log(`[WS] Redirected to pending stream: ${pendingStream.streamId} with key: ${streamKey}`);
        } else {
            ws.send(JSON.stringify({
                type: 'error',
                message: `Invalid stream key: ${streamKey} - no active or pending streams found`
            }));
            return;
        }
    }
    
    // Update connection
    const connection = connections.get(clientId);
    connection.role = 'streamer';
    connection.streamKey = streamKey;
    
    // Store streamer WebSocket
    stream.streamerWs = ws;
    
    ws.send(JSON.stringify({ 
        type: 'registered',
        role: 'streamer',
        streamKey
    }));
    
    console.log(`[WS] Streamer registered for stream: ${stream.streamId}`);

    // Notify monitors that stream is ready
    broadcastToMonitors({
        type: 'stream-ready',
        streamId: stream.streamId,
        streamKey: streamKey,
        playerName: stream.playerName,
        playerId: stream.playerId
    });
}

function handleViewerRegistration(clientId, ws, data) {
    const { streamKey, panelId } = data;

    // Find stream by key
    let stream = null;
    for (const [id, s] of activeStreams) {
        if (s.streamKey === streamKey) {
            stream = s;
            break;
        }
    }

    if (!stream) {
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Stream not found'
        }));
        return;
    }

    // Update connection
    const connection = connections.get(clientId);
    connection.role = 'viewer';
    connection.streamKey = streamKey;

    // Store panel ID properly (handle panelId: 0 correctly)
    if (typeof panelId === 'number') {
        connection.panelId = panelId;
        console.log(`[WS] Viewer registered for panel ${panelId}, stream: ${stream.streamId}`);
    } else {
        console.log(`[WS] Viewer registered (no panel specified), stream: ${stream.streamId}`);
    }

    // Add to viewers list
    stream.viewerWsList.push(ws);
    stream.viewerCount++;
    viewers.set(clientId, streamKey);

    // Cancel auto-stop if viewer joined
    cancelAutoStop(stream);

    // Check if this is the first viewer or if there's already a primary viewer
    let sharing = streamSharing.get(streamKey);
    if (!sharing) {
        // This is the first viewer - make them the primary
        sharing = {
            primaryViewer: clientId,
            sharedViewers: new Set(),
            streamKey: streamKey
        };
        streamSharing.set(streamKey, sharing);
    } else {
        // Check if the current primary viewer is still connected
        const primaryConnection = connections.get(sharing.primaryViewer);
        if (!primaryConnection || primaryConnection.ws.readyState !== WebSocket.OPEN) {
            // Primary viewer is disconnected - make this viewer the new primary
            console.log(`[Sharing] Primary viewer ${sharing.primaryViewer} disconnected, promoting ${clientId} to primary`);
            sharing.primaryViewer = clientId;
            sharing.sharedViewers.clear(); // Clear any shared viewers
        }
    }

    // Determine if this viewer should be primary or shared
    if (sharing.primaryViewer === clientId) {

        console.log(`[Sharing] Client ${clientId} is now primary viewer for stream ${streamKey}`);

        ws.send(JSON.stringify({
            type: 'registered',
            role: 'viewer',
            streamKey,
            viewerType: 'primary' // This viewer gets direct WebRTC
        }));

        // If streamer is connected, initiate connection for primary viewer
        console.log(`[WS] Checking if streamer is available for stream ${stream.streamId}`);
        console.log(`[WS] Streamer WS exists: ${!!stream.streamerWs}`);
        console.log(`[WS] Streamer WS ready state: ${stream.streamerWs?.readyState}`);

        if (stream.streamerWs && stream.streamerWs.readyState === WebSocket.OPEN) {
        const viewerMessage = {
            type: 'viewer-joined',
            viewerId: clientId,
            panelId: panelId  // Include panelId in viewer-joined message
        };

        console.log(`[WS] Sending viewer-joined message to streamer:`, viewerMessage);
        stream.streamerWs.send(JSON.stringify(viewerMessage));

        console.log(`[WS] ✅ Successfully notified streamer about new viewer ${clientId} for panel ${panelId}`);
    } else {
        console.log(`[WS] ❌ Cannot notify streamer - streamer not connected or WebSocket not open`);
        console.log(`[WS] Stream ID: ${stream.streamId}, Stream Key: ${stream.streamKey}`);

        // Check if this is a timing issue - maybe streamer is registering
        setTimeout(() => {
            console.log(`[WS] Retrying viewer-joined notification after 2 seconds`);
            if (stream.streamerWs && stream.streamerWs.readyState === WebSocket.OPEN) {
                const retryMessage = {
                    type: 'viewer-joined',
                    viewerId: clientId,
                    panelId: panelId
                };
                console.log(`[WS] Retry: Sending viewer-joined message:`, retryMessage);
                stream.streamerWs.send(JSON.stringify(retryMessage));
                console.log(`[WS] ✅ Retry successful for viewer ${clientId}`);
            } else {
                console.log(`[WS] ❌ Retry failed - streamer still not available`);
            }
        }, 2000);
        }
    } else {
        // This is a secondary viewer - but check if primary is still active
        const primaryConnection = connections.get(sharing.primaryViewer);
        if (!primaryConnection || primaryConnection.ws.readyState !== WebSocket.OPEN) {
            // Primary is gone, promote this viewer to primary instead
            console.log(`[Sharing] Primary viewer ${sharing.primaryViewer} inactive during registration, promoting ${clientId} to primary`);
            sharing.primaryViewer = clientId;
            sharing.sharedViewers.clear();

            ws.send(JSON.stringify({
                type: 'registered',
                role: 'viewer',
                streamKey,
                viewerType: 'primary'
            }));

            // Notify streamer if available
            if (stream.streamerWs && stream.streamerWs.readyState === WebSocket.OPEN) {
                stream.streamerWs.send(JSON.stringify({
                    type: 'viewer-joined',
                    viewerId: clientId,
                    panelId: panelId
                }));
            }
        } else {
            // This is a secondary viewer - add them to shared viewers
        sharing.sharedViewers.add(clientId);
        console.log(`[Sharing] Client ${clientId} added as shared viewer for stream ${streamKey} (Primary: ${sharing.primaryViewer})`);

        ws.send(JSON.stringify({
            type: 'registered',
            role: 'viewer',
            streamKey,
            viewerType: 'shared', // This viewer will receive shared stream
            primaryViewer: sharing.primaryViewer
        }));

        // Notify the primary viewer about the new shared viewer
        const primaryConnection = connections.get(sharing.primaryViewer);
        if (primaryConnection && primaryConnection.ws && primaryConnection.ws.readyState === WebSocket.OPEN) {
            primaryConnection.ws.send(JSON.stringify({
                type: 'share-stream-request',
                sharedViewer: clientId,
                panelId: panelId
            }));
            console.log(`[Sharing] Notified primary viewer ${sharing.primaryViewer} about new shared viewer ${clientId}`);
        }
        }
    }

    console.log(`[WS] Viewer registered for stream: ${stream.streamId} (Total viewers: ${stream.viewerCount})`);
}

function handleOffer(clientId, data) {
    const connection = connections.get(clientId);
    
    if (!connection || !connection.streamKey) {
        return;
    }
    
    // Find stream
    let stream = null;
    for (const [id, s] of activeStreams) {
        if (s.streamKey === connection.streamKey) {
            stream = s;
            break;
        }
    }
    
    if (!stream) return;
    
    // Forward offer to appropriate party
    if (connection.role === 'streamer' && data.viewerId) {
        // Find viewer and send offer
        for (const [vid, vconn] of connections) {
            if (vid === data.viewerId && vconn.role === 'viewer') {
                const offerMessage = {
                    type: 'offer',
                    offer: data.offer,
                    streamerId: clientId
                };
                
                // Include panelId if available (handle panelId: 0 correctly)
                if (typeof vconn.panelId === 'number') {
                    offerMessage.panelId = vconn.panelId;
                }
                
                console.log(`[WebRTC] Sending offer to viewer ${vid} (panel ${vconn.panelId})`);
                vconn.ws.send(JSON.stringify(offerMessage));
                break;
            }
        }
    }
}

function handleAnswer(clientId, data) {
    const connection = connections.get(clientId);
    
    if (!connection || connection.role !== 'viewer') {
        return;
    }
    
    // Find stream
    let stream = null;
    for (const [id, s] of activeStreams) {
        if (s.streamKey === connection.streamKey) {
            stream = s;
            break;
        }
    }
    
    if (!stream || !stream.streamerWs) return;
    
    const answerMessage = {
        type: 'answer',
        answer: data.answer,
        viewerId: clientId
    };
    
    // Include panelId if available (handle panelId: 0 correctly)
    if (typeof connection.panelId === 'number') {
        answerMessage.panelId = connection.panelId;
    }
    
    console.log(`[WebRTC] Sending answer from viewer ${clientId} (panel ${connection.panelId})`);
    
    // Forward answer to streamer
    stream.streamerWs.send(JSON.stringify(answerMessage));
}

function handleIceCandidate(clientId, data) {
    const connection = connections.get(clientId);
    
    if (!connection || !connection.streamKey) {
        return;
    }
    
    // Find stream
    let stream = null;
    for (const [id, s] of activeStreams) {
        if (s.streamKey === connection.streamKey) {
            stream = s;
            break;
        }
    }
    
    if (!stream) return;
    
    // Forward ICE candidate to appropriate party
    if (connection.role === 'streamer' && data.viewerId) {
        // Send to specific viewer
        for (const [vid, vconn] of connections) {
            if (vid === data.viewerId && vconn.role === 'viewer') {
                const candidateMessage = {
                    type: 'ice-candidate',
                    candidate: data.candidate,
                    from: 'streamer'
                };
                
                // Include panelId if available (handle panelId: 0 correctly)
                if (typeof vconn.panelId === 'number') {
                    candidateMessage.panelId = vconn.panelId;
                }
                
                console.log(`[WebRTC] Sending ICE candidate to viewer ${vid} (panel ${vconn.panelId})`);
                vconn.ws.send(JSON.stringify(candidateMessage));
                break;
            }
        }
    } else if (connection.role === 'viewer' && stream.streamerWs) {
        const candidateMessage = {
            type: 'ice-candidate',
            candidate: data.candidate,
            viewerId: clientId,
            from: 'viewer'
        };
        
        // Include panelId if available (handle panelId: 0 correctly)
        if (typeof connection.panelId === 'number') {
            candidateMessage.panelId = connection.panelId;
        }
        
        console.log(`[WebRTC] Sending ICE candidate from viewer ${clientId} (panel ${connection.panelId})`);
        
        // Send to streamer
        stream.streamerWs.send(JSON.stringify(candidateMessage));
    }
}

function handleStreamCleanup(clientId, ws, data) {
    // Validate API key
    if (!validateWSApiKey(data)) {
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Invalid API key'
        }));
        return;
    }

    const { streamKey, playerId, reason } = data;
    console.log(`[Cleanup] Stream cleanup requested: ${streamKey}, Player: ${playerId}, Reason: ${reason}`);

    // Find and gracefully clean the stream (handle type comparisons)
    let streamToClean = null;
    console.log(`[Cleanup] Looking for stream: player ${playerId}, streamKey: ${streamKey}`);

    activeStreams.forEach((stream, streamId) => {
        console.log(`[Cleanup] Checking stream ${streamId}: playerId ${stream.playerId}, streamKey ${stream.streamKey}`);

        if ((streamKey && stream.streamKey === streamKey) ||
            (playerId && (stream.playerId == playerId ||
                          stream.playerId === String(playerId) ||
                          stream.playerId === Number(playerId)))) {
            streamToClean = { streamId, stream };
            console.log(`[Cleanup] Found stream to clean: ${streamId}`);
        }
    });

    if (streamToClean) {
        const { streamId, stream } = streamToClean;
        console.log(`[Cleanup] Gracefully cleaning stream: ${streamId}`);

        // Only clean up the monitor connection, but keep stream active for potential reconnection
        if (reason === 'panel_closed' || reason === 'panel_change') {
            console.log(`[Cleanup] Panel change detected - keeping stream alive for reconnection`);

            // Just remove the current viewer connection but keep stream active
            stream.viewerWsList = stream.viewerWsList.filter(ws => ws !== clientId);
            stream.viewerCount = Math.max(0, stream.viewerCount - 1);

            // Don't stop the stream completely - allow for reconnection
            console.log(`[Cleanup] Stream ${streamId} remains active for reconnection`);
        } else {
            // Full cleanup for other reasons (manual_stop, etc.)
            console.log(`[Cleanup] Full cleanup for reason: ${reason}`);

            // Send force-stop to streamer before cleanup
            if (stream.streamerWs && stream.streamerWs.readyState === WebSocket.OPEN) {
                console.log(`[Cleanup] Sending force-stop to streamer for stream ${streamId}`);
                stream.streamerWs.send(JSON.stringify({
                    type: 'force-stop',
                    reason: reason || 'cleanup'
                }));
            }

            stopStream(streamId);

            // Notify monitors
            broadcastToMonitors({
                type: 'stream-ended',
                streamKey: stream.streamKey,
                streamId: streamId,
                playerId: stream.playerId,
                reason: reason || 'cleanup'
            });
        }
    }
}

function handleDisconnect(clientId) {
    const connection = connections.get(clientId);

    if (!connection) return;

    // Clean up stream sharing if this was a viewer
    if (connection.role === 'viewer') {
        cleanupViewerSharing(clientId);
    }

    if (connection.role === 'viewer' && connection.streamKey) {
        // Find and update stream
        for (const [id, stream] of activeStreams) {
            if (stream.streamKey === connection.streamKey) {
                stream.viewerCount = Math.max(0, stream.viewerCount - 1);
                stream.viewerWsList = stream.viewerWsList.filter(ws => ws !== connection.ws);

                // Notify streamer if still connected
                if (stream.streamerWs && stream.streamerWs.readyState === WebSocket.OPEN) {
                    stream.streamerWs.send(JSON.stringify({
                        type: 'viewer-left',
                        viewerId: clientId,
                        panelId: connection.panelId
                    }));
                }

                console.log(`[WS] Viewer left stream: ${stream.streamId} (Remaining: ${stream.viewerCount})`);

                // Schedule auto-stop if no viewers remain
                if (stream.viewerCount === 0) {
                    console.log(`[AutoStop] No viewers remaining for stream ${id}, scheduling auto-stop`);
                    scheduleAutoStop(id, stream);
                } else {
                    console.log(`[AutoStop] Still ${stream.viewerCount} viewers remaining for stream ${id}`);
                }

                break;
            }
        }

        viewers.delete(clientId);
    } else if (connection.role === 'streamer' && connection.streamKey) {
        // Immediately clean up streamer disconnections
        for (const [id, stream] of activeStreams) {
            if (stream.streamKey === connection.streamKey) {
                console.log(`[WS] Streamer disconnected from stream: ${stream.streamId} - immediate cleanup`);

                // Notify monitors that stream ended
                broadcastToMonitors({
                    type: 'stream-ended',
                    streamKey: stream.streamKey,
                    streamId: id,
                    playerId: stream.playerId,
                    reason: 'streamer_disconnected'
                });

                // Notify all viewers immediately
                stream.viewerWsList.forEach(ws => {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: 'stream-ended' }));
                    }
                });

                // Stop stream immediately (no grace period)
                stopStream(id);
                break;
            }
        }
    } else if (connection.role === 'monitor') {
        monitorConnections.delete(clientId);
        console.log(`[WS] Monitor disconnected: ${clientId}`);
    }

    connections.delete(clientId);
}

// Schedule auto-stop when no viewers remain
function scheduleAutoStop(streamId, stream) {
    // Don't auto-stop if stream is being manually managed
    if (stream.manualStop) {
        console.log(`[AutoStop] Skipping auto-stop for stream ${streamId} - manual stop in progress`);
        return;
    }

    console.log(`[AutoStop] Scheduling auto-stop for stream ${streamId} in 5 seconds (no viewers)`);

    // Clear any existing auto-stop timer
    if (stream.autoStopTimer) {
        clearTimeout(stream.autoStopTimer);
    }

    stream.autoStopTimer = setTimeout(() => {
        // Double-check viewer count and manual stop status
        if (stream.viewerCount === 0 && activeStreams.has(streamId) && !stream.manualStop) {
            console.log(`[AutoStop] Auto-stopping stream ${streamId} (no viewers for 5 seconds)`);

            // Send force-stop to streamer
            if (stream.streamerWs && stream.streamerWs.readyState === WebSocket.OPEN) {
                console.log(`[AutoStop] Sending force-stop to RedM for stream ${streamId}`);
                stream.streamerWs.send(JSON.stringify({
                    type: 'force-stop',
                    reason: 'no_viewers',
                    streamId: streamId
                }));
            }

            // Stop the stream
            stopStream(streamId);

            // Notify monitors
            broadcastToMonitors({
                type: 'stream-ended',
                streamKey: stream.streamKey,
                streamId: streamId,
                playerId: stream.playerId,
                reason: 'no_viewers'
            });
        } else {
            console.log(`[AutoStop] Canceling auto-stop for stream ${streamId} - conditions changed`);
            console.log(`[AutoStop] Viewer count: ${stream.viewerCount}, Manual stop: ${stream.manualStop}`);
        }
    }, 5000); // 5 seconds delay
}

// Cancel auto-stop when viewer joins
function cancelAutoStop(stream) {
    if (stream.autoStopTimer) {
        console.log(`[AutoStop] Canceling auto-stop timer (viewer joined)`);
        clearTimeout(stream.autoStopTimer);
        stream.autoStopTimer = null;
    }
}

// Clean up dead streams periodically
setInterval(() => {
    const now = Date.now();
    const timeout = 60000; // 1 minute timeout

    activeStreams.forEach((stream, streamId) => {
        // Check heartbeat timeout
        if (stream.lastHeartbeat && (now - stream.lastHeartbeat > timeout)) {
            console.log(`[Cleanup] Removing inactive stream: ${streamId}`);

            // Notify monitors
            broadcastToMonitors({
                type: 'stream-ended',
                streamKey: stream.streamKey,
                streamId: streamId,
                playerId: stream.playerId
            });

            stopStream(streamId);
        }
    });
}, 30000);

// Create public directory if it doesn't exist
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
    console.log(`[Setup] Created directory: ${publicDir}`);
}

// Stream sharing handlers
function handleStreamShareOffer(clientId, ws, data) {
    const { targetViewer, offer } = data;
    console.log(`[Sharing] Relaying stream share offer from ${clientId} to ${targetViewer}`);

    const targetConnection = connections.get(targetViewer);
    if (targetConnection && targetConnection.ws && targetConnection.ws.readyState === WebSocket.OPEN) {
        targetConnection.ws.send(JSON.stringify({
            type: 'stream-share-offer',
            sourceViewer: clientId,
            offer: offer
        }));
        console.log(`[Sharing] Stream share offer relayed to ${targetViewer}`);
    } else {
        console.log(`[Sharing] Target viewer ${targetViewer} not available for stream share`);
    }
}

function handleStreamShareAnswer(clientId, ws, data) {
    const { targetViewer, answer } = data;
    console.log(`[Sharing] Relaying stream share answer from ${clientId} to ${targetViewer}`);

    const targetConnection = connections.get(targetViewer);
    if (targetConnection && targetConnection.ws && targetConnection.ws.readyState === WebSocket.OPEN) {
        targetConnection.ws.send(JSON.stringify({
            type: 'stream-share-answer',
            sourceViewer: clientId,
            answer: answer
        }));
        console.log(`[Sharing] Stream share answer relayed to ${targetViewer}`);
    } else {
        console.log(`[Sharing] Target viewer ${targetViewer} not available for stream share answer`);
    }
}

function handleStreamShareIce(clientId, ws, data) {
    const { targetViewer, candidate } = data;
    console.log(`[Sharing] Relaying ICE candidate from ${clientId} to ${targetViewer}`);

    const targetConnection = connections.get(targetViewer);
    if (targetConnection && targetConnection.ws && targetConnection.ws.readyState === WebSocket.OPEN) {
        targetConnection.ws.send(JSON.stringify({
            type: 'stream-share-ice',
            sourceViewer: clientId,
            candidate: candidate
        }));
        console.log(`[Sharing] ICE candidate relayed to ${targetViewer}`);
    } else {
        console.log(`[Sharing] Target viewer ${targetViewer} not available for ICE candidate`);
    }
}

// Cleanup sharing when viewer disconnects
function cleanupViewerSharing(clientId) {
    for (const [streamKey, sharing] of streamSharing.entries()) {
        if (sharing.primaryViewer === clientId) {
            // Primary viewer disconnected - promote a shared viewer
            if (sharing.sharedViewers.size > 0) {
                const newPrimary = sharing.sharedViewers.values().next().value;
                sharing.sharedViewers.delete(newPrimary);
                sharing.primaryViewer = newPrimary;

                console.log(`[Sharing] Promoted ${newPrimary} to primary viewer for stream ${streamKey}`);

                // Notify the new primary viewer
                const newPrimaryConnection = connections.get(newPrimary);
                if (newPrimaryConnection && newPrimaryConnection.ws) {
                    newPrimaryConnection.ws.send(JSON.stringify({
                        type: 'promoted-to-primary',
                        streamKey: streamKey
                    }));
                }
            } else {
                // No shared viewers left - remove sharing entry
                streamSharing.delete(streamKey);
                console.log(`[Sharing] Removed sharing entry for stream ${streamKey} - no viewers left`);
            }
        } else if (sharing.sharedViewers.has(clientId)) {
            // Shared viewer disconnected
            sharing.sharedViewers.delete(clientId);
            console.log(`[Sharing] Removed shared viewer ${clientId} from stream ${streamKey}`);
        }
    }
}

// WebSocket streaming fallback handlers
function handleRequestWSStreaming(clientId, ws, data) {
    const { streamKey, panelId } = data;
    console.log(`[WS-Streaming] Monitor requesting WebSocket streaming for ${streamKey} in panel ${panelId}`);

    // Find the stream
    let stream = null;
    for (const [id, s] of activeStreams) {
        if (s.streamKey === streamKey) {
            stream = s;
            break;
        }
    }

    if (!stream) {
        console.log(`[WS-Streaming] Stream not found: ${streamKey}`);
        return;
    }

    // Notify the streamer to start WebSocket streaming
    if (stream.streamerWs && stream.streamerWs.readyState === WebSocket.OPEN) {
        stream.streamerWs.send(JSON.stringify({
            type: 'request-ws-streaming',
            streamKey: streamKey
        }));
        console.log(`[WS-Streaming] Requested WebSocket streaming from streamer for ${streamKey}`);
    } else {
        console.log(`[WS-Streaming] Streamer not available for WebSocket streaming request`);
    }
}

function handleWSStreamFrame(clientId, ws, data) {
    const { streamKey, frame } = data;

    // Find the stream
    let stream = null;
    for (const [id, s] of activeStreams) {
        if (s.streamKey === streamKey) {
            stream = s;
            break;
        }
    }

    if (!stream) {
        return;
    }

    // Relay frame to all viewers of this stream
    stream.viewerWsList.forEach(viewerWs => {
        if (viewerWs && viewerWs.readyState === WebSocket.OPEN) {
            viewerWs.send(JSON.stringify({
                type: 'ws-stream-frame',
                streamKey: streamKey,
                frame: frame
            }));
        }
    });
}

// Start server
server.listen(PORT, '0.0.0.0', () => {
    console.log(`=====================================`);
    console.log(`[Media Server] Running on port ${PORT}`);
    console.log(`[Media Server] WebSocket: ws://localhost:${PORT}/ws`);
    console.log(`[Media Server] API: http://localhost:${PORT}/api`);
    console.log(`[Media Server] Health: http://localhost:${PORT}/api/health`);
    console.log(`[Media Server] Player: http://localhost:${PORT}/player/`);
    console.log(`[Media Server] Monitor: http://localhost:${PORT}/monitor`);
    console.log(`[Media Server] API Key: ${API_KEY}`);

    // Start built-in TURN server
    try {
        turnServer.start();
        console.log(`[TURN Server] Built-in TURN server running on port ${TURN_PORT}`);
        console.log(`[TURN Server] TURN URL: turn:localhost:${TURN_PORT}`);
        console.log(`[TURN Server] Username: redm-turn-user`);
        console.log(`[TURN Server] 🛡️ Firewall-free WebRTC enabled!`);
    } catch (error) {
        console.error(`[TURN Server] Failed to start TURN server:`, error);
        console.log(`[TURN Server] Continuing without TURN relay...`);
    }

    console.log(`=====================================`);
});

// Handle shutdown
process.on('SIGINT', () => {
    console.log('\n[Shutdown] Closing server...');
    
    // Close all WebSocket connections
    wss.clients.forEach(ws => {
        ws.close();
    });
    
    wss.close(() => {
        console.log('[Shutdown] WebSocket server closed');
        server.close(() => {
            console.log('[Shutdown] HTTP server closed');
            process.exit(0);
        });
    });
});

// Keep alive
setInterval(() => {
    wss.clients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
        }
    });
}, 30000);