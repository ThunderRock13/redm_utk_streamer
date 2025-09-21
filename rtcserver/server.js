const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'redm-media-server-key-2024';

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
    
    console.log(`[API] Player list updated: ${playerList.length} players`);
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
    
    activeStreams.delete(streamId);
    console.log(`[Stream Stopped] ${streamId}`);
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
    
    // Check if stream already exists for this player
    let existingStream = null;
    activeStreams.forEach((stream, streamId) => {
        if (stream.playerId == playerId) {
            existingStream = stream;
        }
    });

    if (existingStream) {
        // Return existing stream
        ws.send(JSON.stringify({
            type: 'stream-assigned',
            panelId: panelId,
            streamId: existingStream.streamId,
            streamKey: existingStream.streamKey,
            playerName: existingStream.playerName,
            playerId: playerId
        }));
        console.log(`[Monitor] Existing stream assigned: ${existingStream.playerName} to panel ${panelId}`);
    } else {
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
            playerId: playerId
        }));

        console.log(`[Monitor] Stream request queued: ${playerName} (${streamId}) for panel ${panelId}`);
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
    
    // Find and stop the stream
    let streamToStop = null;
    activeStreams.forEach((stream, streamId) => {
        if (stream.playerId == playerId || stream.streamKey === streamKey) {
            streamToStop = { streamId, stream };
        }
    });

    if (streamToStop) {
        const { streamId, stream } = streamToStop;
        
        // Stop the stream
        stopStream(streamId);

        // Notify monitor that stream stopped
        broadcastToMonitors({
            type: 'stream-stopped',
            panelId: panelId,
            playerId: playerId,
            streamKey: streamKey
        });

        console.log(`[Monitor] Stream stopped: player ${playerId} in panel ${panelId}`);
    } else {
        console.log(`[Monitor] No stream found to stop for player ${playerId}`);
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
    for (const [id, s] of activeStreams) {
        if (s.streamKey === streamKey) {
            stream = s;
            break;
        }
    }
    
    if (!stream) {
        ws.send(JSON.stringify({ 
            type: 'error', 
            message: 'Invalid stream key' 
        }));
        return;
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
    
    ws.send(JSON.stringify({ 
        type: 'registered',
        role: 'viewer',
        streamKey 
    }));
    
    // If streamer is connected, initiate connection
    if (stream.streamerWs && stream.streamerWs.readyState === WebSocket.OPEN) {
        stream.streamerWs.send(JSON.stringify({
            type: 'viewer-joined',
            viewerId: clientId,
            panelId: panelId  // Include panelId in viewer-joined message
        }));
        
        console.log(`[WS] Notified streamer about new viewer ${clientId} for panel ${panelId}`);
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

function handleDisconnect(clientId) {
    const connection = connections.get(clientId);
    
    if (!connection) return;
    
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
                break;
            }
        }
        
        viewers.delete(clientId);
    } else if (connection.role === 'streamer' && connection.streamKey) {
        // Don't immediately delete stream, mark as disconnected
        for (const [id, stream] of activeStreams) {
            if (stream.streamKey === connection.streamKey) {
                stream.streamerWs = null;
                console.log(`[WS] Streamer disconnected from stream: ${stream.streamId}`);
                
                // Notify monitors that stream ended
                broadcastToMonitors({
                    type: 'stream-ended',
                    streamKey: stream.streamKey,
                    streamId: id,
                    playerId: stream.playerId
                });
                
                // Give 30 seconds to reconnect before ending stream
                setTimeout(() => {
                    if (!stream.streamerWs) {
                        // Notify all viewers
                        stream.viewerWsList.forEach(ws => {
                            if (ws.readyState === WebSocket.OPEN) {
                                ws.send(JSON.stringify({ type: 'stream-ended' }));
                            }
                        });
                        
                        stopStream(id);
                        console.log(`[WS] Stream ended due to timeout: ${stream.streamId}`);
                    }
                }, 30000);
                
                break;
            }
        }
    } else if (connection.role === 'monitor') {
        monitorConnections.delete(clientId);
        console.log(`[WS] Monitor disconnected: ${clientId}`);
    }
    
    connections.delete(clientId);
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