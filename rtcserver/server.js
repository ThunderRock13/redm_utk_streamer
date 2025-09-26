const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const turn = require('node-turn');
require('dotenv').config();

const app = express();

// Try to create HTTPS server if SSL files exist, otherwise use HTTP
let server;
let httpsServer;
let useSSL = false;

try {
    // Check for SSL certificate files
    const sslPath = path.join(__dirname, 'ssl');
    const keyPath = path.join(sslPath, 'key.pem');
    const certPath = path.join(sslPath, 'cert.pem');

    if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
        const options = {
            key: fs.readFileSync(keyPath),
            cert: fs.readFileSync(certPath),
            // CFX-friendly SSL options
            rejectUnauthorized: false,
            requestCert: false,
            agent: false,
            secureProtocol: 'TLSv1_2_method'
        };

        httpsServer = https.createServer(options, app);
        useSSL = true;
        console.log('🔒 SSL certificates found - HTTPS enabled with CFX compatibility');
    }
} catch (error) {
    console.log('⚠️ SSL setup failed, falling back to HTTP only:', error.message);
}

// Always create HTTP server as fallback
server = http.createServer(app);
const PORT = process.env.PORT || 3000;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;
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

// Middleware with CFX-specific headers
app.use(cors({
    origin: true,
    credentials: true
}));

// Allow mixed content for CFX clients
app.use((req, res, next) => {
    res.header('Content-Security-Policy', "upgrade-insecure-requests");
    res.header('X-Content-Type-Options', 'nosniff');
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Content-Length, X-Requested-With');
    next();
});

app.use(express.json());
app.use('/player', express.static(path.join(__dirname, 'public')));

// Serve static files for monitor assets first
app.use('/assets', express.static(path.join(__dirname, 'public')));

// Serve monitor page
app.get('/monitor', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'monitor.html'));
});


// WebSocket server for WebRTC signaling (HTTP)
const wss = new WebSocket.Server({
    server,
    path: '/ws'
});

// WebSocket server for HTTPS (if SSL enabled)
let wssSecure;
if (useSSL && httpsServer) {
    wssSecure = new WebSocket.Server({
        server: httpsServer,
        path: '/ws'
    });
}

// Store active streams and connections
const activeStreams = new Map();
const connections = new Map();
const viewers = new Map();
let playerList = [];
let monitorConnections = new Set();
let pendingStreamRequests = new Map(); // Store pending stream requests for polling

// Stream sharing coordination
const streamSharing = new Map(); // streamKey -> { primaryViewer: clientId, sharedViewers: Set[clientId], streamObject: MediaStream }

// Performance optimization indexes
const streamsByPlayerId = new Map(); // playerId -> streamId for O(1) lookups
const streamsByKey = new Map(); // streamKey -> streamId for O(1) lookups

// API authentication
const authenticateAPI = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
};

// WebSocket Proxy Endpoints for CFX RedM Server Integration
const proxyConnections = new Map(); // playerId -> connection info
const proxyMessageQueues = new Map(); // playerId -> message queue

// Helper function to send messages to proxy connections
function sendMessageToProxyConnection(playerId, message) {
    const connection = proxyConnections.get(parseInt(playerId));
    if (!connection || !connection.connected) {
        console.log(`[WebSocket Proxy] Cannot send message to player ${playerId} - not connected`);
        return false;
    }

    // Add message to queue
    if (!proxyMessageQueues.has(parseInt(playerId))) {
        proxyMessageQueues.set(parseInt(playerId), []);
    }
    proxyMessageQueues.get(parseInt(playerId)).push({
        ...message,
        timestamp: Date.now()
    });

    console.log(`[WebSocket Proxy] Queued message for player ${playerId}: ${message.type}`);
    return true;
}

// Helper function to check if a stream has a proxy connection
function isProxyConnection(stream) {
    // Check if any proxy connection has this stream ID
    for (const [playerId, connection] of proxyConnections.entries()) {
        if (connection.streamId === stream.streamId || connection.streamKey === stream.streamKey) {
            return { playerId, connection };
        }
    }
    return null;
}

// Handle WebSocket connection from RedM server
app.post('/api/websocket/connect', authenticateAPI, (req, res) => {
    const { playerId, streamKey, streamId, playerName } = req.body;

    console.log(`[WebSocket Proxy] Connection request from player ${playerName} (${playerId})`);

    proxyConnections.set(playerId, {
        playerId,
        streamKey,
        streamId,
        playerName,
        connected: true,
        lastActivity: Date.now()
    });

    res.json({
        status: 'connected',
        playerId,
        streamKey,
        message: 'WebSocket proxy connection established'
    });
});

// Handle WebSocket message from RedM server
app.post('/api/websocket/message', authenticateAPI, (req, res) => {
    const { playerId, message } = req.body;
    const connection = proxyConnections.get(parseInt(playerId));

    if (!connection) {
        return res.status(404).json({ error: 'Connection not found' });
    }

    // Update last activity
    connection.lastActivity = Date.now();

    // Process the WebSocket message as if it came from a real WebSocket
    try {
        const parsedMessage = typeof message === 'string' ? JSON.parse(message) : message;

        // Handle different message types
        let response = null;

        switch (parsedMessage.type) {
            case 'register-streamer':
                // Register the streamer
                connections.set(playerId, {
                    id: playerId,
                    type: 'streamer',
                    streamKey: parsedMessage.streamKey,
                    playerName: connection.playerName,
                    proxy: true // Mark as proxy connection
                });
                response = { type: 'registered', streamKey: parsedMessage.streamKey };
                console.log(`[WebSocket Proxy] Streamer ${connection.playerName} registered via proxy`);

                // Check for existing viewers and notify them about the streamer coming online
                const streamKey = parsedMessage.streamKey;
                console.log(`[WebSocket Proxy] Checking for existing viewers for stream ${streamKey}`);
                console.log(`[WebSocket Proxy] Current viewers Map:`, Array.from(viewers.entries()));
                console.log(`[WebSocket Proxy] Current connections:`, Array.from(connections.entries()).map(([id, conn]) => ({ id, type: conn.type, streamKey: conn.streamKey, panelId: conn.panelId })));

                // Count existing viewers for this stream key
                let existingViewerCount = 0;
                for (const [viewerClientId, viewerStreamKey] of viewers.entries()) {
                    if (viewerStreamKey === streamKey) {
                        existingViewerCount++;
                        const viewerConnection = connections.get(viewerClientId);

                        const viewerJoinedMessage = {
                            type: 'viewer-joined',
                            viewerId: viewerClientId,
                            panelId: viewerConnection ? (viewerConnection.panelId || 0) : 0
                        };

                        sendMessageToProxyConnection(playerId, viewerJoinedMessage);
                        console.log(`[WebSocket Proxy] Notified proxy streamer about existing viewer ${viewerClientId} (panel ${viewerJoinedMessage.panelId})`);
                    }
                }

                if (existingViewerCount > 0) {
                    console.log(`[WebSocket Proxy] Found ${existingViewerCount} existing viewers for stream ${streamKey}`);
                } else {
                    console.log(`[WebSocket Proxy] No existing viewers found for stream ${streamKey}`);
                }
                break;

            case 'offer':
                // Handle WebRTC offer
                console.log(`[WebSocket Proxy] Received offer from ${connection.playerName}`);
                response = { type: 'offer-received' };
                break;

            case 'answer':
                // Handle WebRTC answer
                console.log(`[WebSocket Proxy] Received answer from ${connection.playerName}`);
                response = { type: 'answer-received' };
                break;

            case 'ice-candidate':
                // Handle ICE candidate
                console.log(`[WebSocket Proxy] Received ICE candidate from ${connection.playerName}`);
                response = { type: 'ice-candidate-received' };
                break;

            default:
                console.log(`[WebSocket Proxy] Unknown message type: ${parsedMessage.type}`);
                response = { type: 'unknown', message: 'Message type not recognized' };
        }

        // Get queued messages for this player
        const playerId_int = parseInt(playerId);
        const queuedMessages = proxyMessageQueues.get(playerId_int) || [];

        // Clear the queue after retrieving messages
        if (queuedMessages.length > 0) {
            proxyMessageQueues.set(playerId_int, []);
            console.log(`[WebSocket Proxy] Delivering ${queuedMessages.length} queued messages to player ${playerId}`);
        }

        res.json({
            status: 'processed',
            reply: response,
            messages: queuedMessages // Include queued messages in response
        });

    } catch (error) {
        console.error(`[WebSocket Proxy] Error processing message:`, error);
        res.status(400).json({ error: 'Invalid message format' });
    }
});

// Polling endpoint for proxy connections to check for messages
app.post('/api/websocket/poll', authenticateAPI, (req, res) => {
    const { playerId } = req.body;
    const connection = proxyConnections.get(parseInt(playerId));

    if (!connection) {
        return res.status(404).json({ error: 'Connection not found' });
    }

    // Update last activity
    connection.lastActivity = Date.now();

    // Get queued messages for this player
    const playerId_int = parseInt(playerId);
    const queuedMessages = proxyMessageQueues.get(playerId_int) || [];

    // Clear the queue after retrieving messages
    if (queuedMessages.length > 0) {
        proxyMessageQueues.set(playerId_int, []);
        console.log(`[WebSocket Proxy] Poll: Delivering ${queuedMessages.length} queued messages to player ${playerId}`);
    }

    res.json({
        status: 'ok',
        messages: queuedMessages
    });
});

// Handle WebSocket disconnection from RedM server
app.post('/api/websocket/disconnect', authenticateAPI, (req, res) => {
    const { playerId, streamKey } = req.body;
    const connection = proxyConnections.get(parseInt(playerId));

    if (connection) {
        console.log(`[WebSocket Proxy] Player ${connection.playerName} disconnected`);
        proxyConnections.delete(parseInt(playerId));
        connections.delete(parseInt(playerId));
    }

    res.json({ status: 'disconnected' });
});

// Clean up inactive proxy connections
setInterval(() => {
    const now = Date.now();
    const timeout = 5 * 60 * 1000; // 5 minutes

    for (const [playerId, connection] of proxyConnections.entries()) {
        if (now - connection.lastActivity > timeout) {
            console.log(`[WebSocket Proxy] Cleaning up inactive connection for player ${connection.playerName}`);
            proxyConnections.delete(playerId);
            connections.delete(playerId);
        }
    }
}, 60000); // Check every minute

console.log('🔗 WebSocket proxy endpoints initialized');

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
    const serverHost = req.get('host') ? req.get('host').split(':')[0] : 'localhost';
    const webSocketUrl = `ws://${serverHost}:${PORT}/ws`;
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

    // Update performance indexes
    streamsByPlayerId.set(playerId, streamId);
    streamsByKey.set(streamKey, streamId);
    
    // Stream created
    
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

    console.log(`[API] Player list updated: ${playerList.length} players`);

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

        requests.forEach(req => {

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

// WebRTC Data Relay Endpoint (for CFX-native streaming)
app.post('/api/webrtc/relay', authenticateAPI, (req, res) => {
    const { playerId, streamKey, messageType, messageData, viewerId, timestamp } = req.body;

    console.log(`[WebRTC Relay] ${messageType} from player ${playerId} to viewer ${viewerId || 'broadcast'}`);

    // Find the stream
    let targetStream = null;
    for (const [id, stream] of activeStreams) {
        if (stream.streamKey === streamKey) {
            targetStream = stream;
            break;
        }
    }

    if (!targetStream) {
        return res.status(404).json({ error: 'Stream not found' });
    }

    let response = { status: 'relayed' };
    let forwardTo = [];

    // Handle different WebRTC message types
    switch (messageType) {
        case 'register-streamer':
            // Streamer registering via pure events
            console.log(`[WebRTC Relay] Streamer ${playerId} registered for stream ${streamKey}`);
            response.reply = { type: 'registered', streamKey: streamKey };

            // Notify existing viewers about streamer
            targetStream.viewerWsList.forEach(viewerWs => {
                if (viewerWs.readyState === WebSocket.OPEN) {
                    forwardTo.push({
                        playerId: viewerId, // This would need to be tracked
                        message: { type: 'streamer-ready', streamKey: streamKey }
                    });
                }
            });
            break;

        case 'offer':
            // Forward offer to specific viewer
            console.log(`[WebRTC Relay] Forwarding offer to viewer ${viewerId}`);
            if (viewerId) {
                forwardTo.push({
                    playerId: viewerId,
                    message: messageData
                });
            }
            break;

        case 'answer':
            // Forward answer to streamer
            console.log(`[WebRTC Relay] Forwarding answer from viewer ${playerId}`);
            forwardTo.push({
                playerId: targetStream.playerId, // Forward to streamer
                message: messageData
            });
            break;

        case 'ice-candidate':
            // Forward ICE candidate
            console.log(`[WebRTC Relay] Forwarding ICE candidate`);
            if (viewerId) {
                forwardTo.push({
                    playerId: viewerId,
                    message: messageData
                });
            } else {
                // Forward to streamer
                forwardTo.push({
                    playerId: targetStream.playerId,
                    message: messageData
                });
            }
            break;

        default:
            console.log(`[WebRTC Relay] Unknown message type: ${messageType}`);
    }

    // Include forwarding instructions
    if (forwardTo.length > 0) {
        response.forwardTo = forwardTo;
    }

    res.json(response);
});

// Endpoint to get WebRTC configuration (ICE servers, TURN settings)
app.get('/api/webrtc/config', (req, res) => {
    const turnEnabled = process.env.TURN_ENABLED !== 'false'; // Enable TURN by default
    const forceRelayOnly = process.env.FORCE_RELAY_ONLY === 'true';

    const iceServers = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' }
    ];

    // Add built-in TURN server
    if (turnEnabled) {
        // Get the server's external IP from the request or use a configured IP
        const serverHost = req.get('host').split(':')[0];
        iceServers.push({
            urls: `turn:${serverHost}:${TURN_PORT}`,
            username: 'redm-turn-user',
            credential: 'redm-turn-pass'
        });
    }

    const config = {
        iceServers: iceServers,
        iceTransportPolicy: forceRelayOnly ? 'relay' : 'all',
        turnEnabled: turnEnabled,
        forceRelayOnly: forceRelayOnly,
        iceCandidatePoolSize: 10, // Enable ICE candidate pool for better remote connectivity
        bundlePolicy: 'balanced',
        rtcpMuxPolicy: 'require',
        // Additional settings for remote connectivity
        iceConnectionTimeout: 30000, // 30 seconds timeout
        iceGatheringTimeout: 10000   // 10 seconds for gathering
    };


    res.json(config);
});

// Endpoint for RedM server to notify stream ended
app.post('/api/monitor/stream-ended', authenticateAPI, (req, res) => {
    const { playerId, streamId, streamKey, reason } = req.body;
    

    
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
        webSocketUrl: `ws://${req.get('host') ? req.get('host').split(':')[0] : 'localhost'}:${PORT}/ws`
    });
    

});

// Helper function to stop a stream
function stopStream(streamId) {
    const stream = activeStreams.get(streamId);
    if (!stream) return;



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
    if (stream) {
        // Clean up performance indexes
        streamsByPlayerId.delete(stream.playerId);
        streamsByKey.delete(stream.streamKey);
    }
    activeStreams.delete(streamId);

}

// Helper function to broadcast to all monitors
function broadcastToMonitors(message) {
    let monitorCount = 0;
    connections.forEach((conn, clientId) => {
        if (conn.role === 'monitor' && conn.ws.readyState === WebSocket.OPEN) {
            conn.ws.send(JSON.stringify(message));
            monitorCount++;
        }
    });
    console.log(`[Broadcast] Sent ${message.type} to ${monitorCount} monitors`);
}

// WebSocket handling
wss.on('connection', (ws, req) => {
    const clientId = uuidv4();

    
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
            // Message parsing error
        }
    });
    
    ws.on('close', () => {

        handleDisconnect(clientId);
    });
    
    ws.on('error', (error) => {
        // WebSocket error
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

    console.log(`[Monitor] Monitor registered: ${clientId}`);

    ws.send(JSON.stringify({
        type: 'registered',
        role: 'monitor'
    }));

    // Send current player list
    console.log(`[Monitor] Sending ${playerList.length} players to monitor`);
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



    activeStreams.forEach((stream, streamId) => {

        if (stream.playerId == playerId || stream.playerId === String(playerId) || stream.playerId === Number(playerId)) {
            existingStream = stream;
            existingStreamId = streamId;

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


    } else {
        if (existingStream && existingStream.manualStop) {


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



    // Find and stop the stream (handle type comparisons properly)
    let streamToStop = null;


    activeStreams.forEach((stream, streamId) => {


        if (stream.playerId == playerId ||
            stream.playerId === String(playerId) ||
            stream.playerId === Number(playerId) ||
            stream.streamKey === streamKey) {
            streamToStop = { streamId, stream };

        }
    });

    if (streamToStop) {
        const { streamId, stream } = streamToStop;



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


            stream.streamerWs.send(JSON.stringify(forceStopMessage));

        } else {



        }

        // Stop the stream


        // Clear any auto-stop timers before manual stop
        if (stream.autoStopTimer) {

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


    } else {


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



        // Instead of rejecting, try to find if there's a pending stream for this client
        let pendingStream = null;
        pendingStreamRequests.forEach((req, reqId) => {
            if (!pendingStream) {

                pendingStream = req;
            }
        });

        if (pendingStream) {


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

    } else {

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

            sharing.primaryViewer = clientId;
            sharing.sharedViewers.clear(); // Clear any shared viewers
        }
    }

    // Determine if this viewer should be primary or shared
    if (sharing.primaryViewer === clientId) {



        ws.send(JSON.stringify({
            type: 'registered',
            role: 'viewer',
            streamKey,
            viewerType: 'primary' // This viewer gets direct WebRTC
        }));

        // If streamer is connected, initiate connection for primary viewer




        // Check if streamer is connected via WebSocket or proxy
        const proxyInfo = isProxyConnection(stream);

        if (stream.streamerWs && stream.streamerWs.readyState === WebSocket.OPEN) {
            // Direct WebSocket connection
            const viewerMessage = {
                type: 'viewer-joined',
                viewerId: clientId,
                panelId: panelId
            };
            stream.streamerWs.send(JSON.stringify(viewerMessage));
            console.log(`[WebSocket] Sent viewer-joined to streamer via WebSocket`);
        } else if (proxyInfo) {
            // Proxy connection - queue the message
            const viewerMessage = {
                type: 'viewer-joined',
                viewerId: clientId,
                panelId: panelId
            };
            sendMessageToProxyConnection(proxyInfo.playerId, viewerMessage);
            console.log(`[WebSocket Proxy] Sent viewer-joined to streamer via proxy`);
        } else {

        // Check if this is a timing issue - maybe streamer is registering
        setTimeout(() => {
            const retryProxyInfo = isProxyConnection(stream);

            if (stream.streamerWs && stream.streamerWs.readyState === WebSocket.OPEN) {
                const retryMessage = {
                    type: 'viewer-joined',
                    viewerId: clientId,
                    panelId: panelId
                };
                stream.streamerWs.send(JSON.stringify(retryMessage));
                console.log(`[WebSocket] Retry - sent viewer-joined to streamer via WebSocket`);
            } else if (retryProxyInfo) {
                const retryMessage = {
                    type: 'viewer-joined',
                    viewerId: clientId,
                    panelId: panelId
                };
                sendMessageToProxyConnection(retryProxyInfo.playerId, retryMessage);
                console.log(`[WebSocket Proxy] Retry - sent viewer-joined to streamer via proxy`);
            } else {
                console.log(`[WebSocket] Retry - streamer still not available`);
            }
        }, 2000);
        }
    } else {
        // This is a secondary viewer - but check if primary is still active
        const primaryConnection = connections.get(sharing.primaryViewer);
        if (!primaryConnection || primaryConnection.ws.readyState !== WebSocket.OPEN) {
            // Primary is gone, promote this viewer to primary instead

            sharing.primaryViewer = clientId;
            sharing.sharedViewers.clear();

            ws.send(JSON.stringify({
                type: 'registered',
                role: 'viewer',
                streamKey,
                viewerType: 'primary'
            }));

            // Notify streamer if available
            const secondaryProxyInfo = isProxyConnection(stream);

            if (stream.streamerWs && stream.streamerWs.readyState === WebSocket.OPEN) {
                stream.streamerWs.send(JSON.stringify({
                    type: 'viewer-joined',
                    viewerId: clientId,
                    panelId: panelId
                }));
                console.log(`[WebSocket] Sent viewer-joined to secondary viewer via WebSocket`);
            } else if (secondaryProxyInfo) {
                sendMessageToProxyConnection(secondaryProxyInfo.playerId, {
                    type: 'viewer-joined',
                    viewerId: clientId,
                    panelId: panelId
                });
                console.log(`[WebSocket Proxy] Sent viewer-joined to secondary viewer via proxy`);
            }
        } else {
            // This is a secondary viewer - add them to shared viewers
        sharing.sharedViewers.add(clientId);


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

        }
        }
    }


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


    // Find and gracefully clean the stream (handle type comparisons)
    let streamToClean = null;


    activeStreams.forEach((stream, streamId) => {


        if ((streamKey && stream.streamKey === streamKey) ||
            (playerId && (stream.playerId == playerId ||
                          stream.playerId === String(playerId) ||
                          stream.playerId === Number(playerId)))) {
            streamToClean = { streamId, stream };

        }
    });

    if (streamToClean) {
        const { streamId, stream } = streamToClean;


        // Only clean up the monitor connection, but keep stream active for potential reconnection
        if (reason === 'panel_closed' || reason === 'panel_change') {


            // Just remove the current viewer connection but keep stream active
            stream.viewerWsList = stream.viewerWsList.filter(ws => ws !== clientId);
            stream.viewerCount = Math.max(0, stream.viewerCount - 1);

            // Don't stop the stream completely - allow for reconnection

        } else {
            // Full cleanup for other reasons (manual_stop, etc.)


            // Send force-stop to streamer before cleanup
            if (stream.streamerWs && stream.streamerWs.readyState === WebSocket.OPEN) {

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



                // Schedule auto-stop if no viewers remain
                if (stream.viewerCount === 0) {

                    scheduleAutoStop(id, stream);
                } else {

                }

                break;
            }
        }

        viewers.delete(clientId);
    } else if (connection.role === 'streamer' && connection.streamKey) {
        // Immediately clean up streamer disconnections
        for (const [id, stream] of activeStreams) {
            if (stream.streamKey === connection.streamKey) {


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

    }

    connections.delete(clientId);
}

// Schedule auto-stop when no viewers remain
function scheduleAutoStop(streamId, stream) {
    // Don't auto-stop if stream is being manually managed
    if (stream.manualStop) {

        return;
    }



    // Clear any existing auto-stop timer
    if (stream.autoStopTimer) {
        clearTimeout(stream.autoStopTimer);
    }

    stream.autoStopTimer = setTimeout(() => {
        // Double-check viewer count and manual stop status
        if (stream.viewerCount === 0 && activeStreams.has(streamId) && !stream.manualStop) {


            // Send force-stop to streamer
            if (stream.streamerWs && stream.streamerWs.readyState === WebSocket.OPEN) {

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


        }
    }, 5000); // 5 seconds delay
}

// Cancel auto-stop when viewer joins
function cancelAutoStop(stream) {
    if (stream.autoStopTimer) {

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

}

// Stream sharing handlers
function handleStreamShareOffer(clientId, ws, data) {
    const { targetViewer, offer } = data;


    const targetConnection = connections.get(targetViewer);
    if (targetConnection && targetConnection.ws && targetConnection.ws.readyState === WebSocket.OPEN) {
        targetConnection.ws.send(JSON.stringify({
            type: 'stream-share-offer',
            sourceViewer: clientId,
            offer: offer
        }));

    } else {

    }
}

function handleStreamShareAnswer(clientId, ws, data) {
    const { targetViewer, answer } = data;


    const targetConnection = connections.get(targetViewer);
    if (targetConnection && targetConnection.ws && targetConnection.ws.readyState === WebSocket.OPEN) {
        targetConnection.ws.send(JSON.stringify({
            type: 'stream-share-answer',
            sourceViewer: clientId,
            answer: answer
        }));

    } else {

    }
}

function handleStreamShareIce(clientId, ws, data) {
    const { targetViewer, candidate } = data;


    const targetConnection = connections.get(targetViewer);
    if (targetConnection && targetConnection.ws && targetConnection.ws.readyState === WebSocket.OPEN) {
        targetConnection.ws.send(JSON.stringify({
            type: 'stream-share-ice',
            sourceViewer: clientId,
            candidate: candidate
        }));

    } else {

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

            }
        } else if (sharing.sharedViewers.has(clientId)) {
            // Shared viewer disconnected
            sharing.sharedViewers.delete(clientId);

        }
    }
}

// WebSocket streaming fallback handlers
function handleRequestWSStreaming(clientId, ws, data) {
    const { streamKey, panelId } = data;


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

    // Notify the streamer to start WebSocket streaming
    if (stream.streamerWs && stream.streamerWs.readyState === WebSocket.OPEN) {
        stream.streamerWs.send(JSON.stringify({
            type: 'request-ws-streaming',
            streamKey: streamKey
        }));

    } else {

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

// Start servers
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 HTTP server running on port ${PORT}`);
    console.log(`📡 Monitor: http://0.0.0.0:${PORT}/monitor`);
});

// Start HTTPS server if SSL is available
if (useSSL && httpsServer) {
    httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
        console.log(`🔒 HTTPS server running on port ${HTTPS_PORT}`);
        console.log(`🛡️ Secure Monitor: https://0.0.0.0:${HTTPS_PORT}/monitor`);
    });

    // Handle HTTPS WebSocket connections with the same logic as HTTP
    if (wssSecure) {
        wssSecure.on('connection', (ws, req) => {
            const clientId = uuidv4();
            console.log(`🔒 Secure WebSocket client connected: ${clientId}`);

            connections.set(clientId, {
                ws: ws,
                role: null,
                streamKey: null,
                lastPing: Date.now()
            });

            // Handle the connection using the existing WebSocket message handler
            ws.on('message', (message) => {
                try {
                    const data = JSON.parse(message);
                    handleWebSocketMessage(clientId, ws, data);
                } catch (error) {
                    // Message parsing error
                }
            });

            ws.on('close', () => {
                console.log(`🔒 Secure WebSocket client disconnected: ${clientId}`);
                handleDisconnect(clientId);
            });

            ws.on('error', (error) => {
                console.error(`🔒 Secure WebSocket error for ${clientId}:`, error);
                handleDisconnect(clientId);
            });
        });
    }
}

// Start TURN server by default for better remote connectivity
const enableTurn = process.env.TURN_ENABLED !== 'false'; // Default to true
if (enableTurn) {
    try {
        turnServer.start();
        console.log(`🔄 TURN server started on port ${TURN_PORT} for remote WebRTC access`);
    } catch (error) {
        console.error('❌ Failed to start TURN server:', error);
        console.log('⚠️ WebRTC may not work for remote clients without TURN server');
    }
} else {
    console.log('⚠️ TURN server disabled - WebRTC may not work for remote clients');
}

// SSL certificate generation hint
if (!useSSL) {
    console.log('💡 To enable HTTPS/WSS (needed for CFX NUI):');
    console.log('   Run: node generate-ssl.js');
    console.log('   Then restart the server');
}

// Handle shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down server...');

    // Stop TURN server if running
    const enableTurn = process.env.TURN_ENABLED !== 'false';
    if (enableTurn) {
        try {
            turnServer.stop();
            console.log('🔄 TURN server stopped');
        } catch (error) {
            console.error('❌ Error stopping TURN server:', error);
        }
    }

    // Close all WebSocket connections
    wss.clients.forEach(ws => {
        ws.close();
    });

    wss.close(() => {
        console.log('📡 WebSocket server stopped');
        server.close(() => {
            console.log('🚀 HTTP server stopped');
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