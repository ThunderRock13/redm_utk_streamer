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

// Serve static files for monitor assets first
app.use('/assets', express.static(path.join(__dirname, 'public')));

// Serve monitor page
app.get('/monitor', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'monitor.html'));
});

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

// Endpoint to get WebRTC configuration (ICE servers, TURN settings)
app.get('/api/webrtc/config', (req, res) => {
    const turnEnabled = process.env.TURN_ENABLED === 'true'; // Enable TURN based on environment
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
        iceCandidatePoolSize: 0, // Prevent ICE candidate gathering to avoid firewall prompts
        bundlePolicy: 'balanced', // Use balanced bundle policy
        rtcpMuxPolicy: 'require' // Force RTCP multiplexing to reduce port usage
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
        webSocketUrl: `ws://localhost:${PORT}/ws`
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




        if (stream.streamerWs && stream.streamerWs.readyState === WebSocket.OPEN) {
        const viewerMessage = {
            type: 'viewer-joined',
            viewerId: clientId,
            panelId: panelId  // Include panelId in viewer-joined message
        };


        stream.streamerWs.send(JSON.stringify(viewerMessage));


    } else {



        // Check if this is a timing issue - maybe streamer is registering
        setTimeout(() => {

            if (stream.streamerWs && stream.streamerWs.readyState === WebSocket.OPEN) {
                const retryMessage = {
                    type: 'viewer-joined',
                    viewerId: clientId,
                    panelId: panelId
                };

                stream.streamerWs.send(JSON.stringify(retryMessage));

            } else {

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

// Start server
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Media server running on port ${PORT}`);
    console.log(`📡 Monitor: http://0.0.0.0:${PORT}/monitor`);

    // Start TURN server if enabled
    if (process.env.TURN_ENABLED === 'true') {
        try {
            turnServer.start();
            console.log(`🔄 TURN server started on port ${TURN_PORT} for remote WebRTC access`);
        } catch (error) {
            console.error('❌ Failed to start TURN server:', error);
        }
    } else {
        console.log('⚠️ TURN server disabled - WebRTC may not work for remote clients');
    }
});

// Handle shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down server...');

    // Stop TURN server if running
    if (process.env.TURN_ENABLED === 'true') {
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