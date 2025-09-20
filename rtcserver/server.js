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

// API authentication
const authenticateAPI = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
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

// Create stream endpoint
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
        hlsUrl: viewerUrl // For compatibility
    });
});

// Stop stream endpoint
app.post('/api/streams/:streamId/stop', authenticateAPI, (req, res) => {
    const { streamId } = req.params;
    
    if (!activeStreams.has(streamId)) {
        return res.status(404).json({ error: 'Stream not found' });
    }
    
    const stream = activeStreams.get(streamId);
    
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
        hlsUrl: stream.viewerUrl // For compatibility
    }));
    
    res.json(streams);
});

// Update player list
app.post('/api/players/update', authenticateAPI, (req, res) => {
    playerList = req.body.players || [];
    
    // Broadcast to all monitor connections
    connections.forEach((conn, clientId) => {
        if (conn.role === 'monitor' && conn.ws.readyState === WebSocket.OPEN) {
            conn.ws.send(JSON.stringify({
                type: 'player-update',
                players: playerList
            }));
        }
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

// Monitor stream request
// Monitor stream request
app.post('/api/monitor/stream', authenticateAPI, (req, res) => {
    const { playerId, panelId } = req.body;
    
    // Check if stream exists for this player
    let existingStream = null;
    activeStreams.forEach((stream, streamId) => {
        if (stream.playerId == playerId) {
            existingStream = stream;
        }
    });

    if (existingStream) {
        // Return existing stream
        res.json({
            success: true, 
            streamId: existingStream.streamId, 
            streamKey: existingStream.streamKey, 
            playerName: existingStream.playerName, 
            existing: true
        });
    } else {
        // Create new stream request to game server
        const streamId = require('uuid').v4();
        const streamKey = require('uuid').v4();
        const webSocketUrl = `ws://localhost:${PORT}/ws`;
        const viewerUrl = `http://localhost:${PORT}/player/viewer.html?stream=${streamKey}`;
        
        // Create stream entry
        activeStreams.set(streamId, {
            streamId,
            streamKey,
            playerId,
            playerName: `Player ${playerId}`, // This will be updated when stream starts
            viewerUrl,
            startTime: Date.now(),
            viewerCount: 0,
            stats: {},
            streamerWs: null,
            viewerWsList: [],
            lastHeartbeat: Date.now(),
            monitorRequested: true, // Mark as monitor-requested
            panelId: panelId
        });

        // Notify all Lua servers about the monitor request via HTTP callback
        // This assumes your Lua server has an HTTP endpoint listening
        const http = require('http');
        const postData = JSON.stringify({
            type: 'monitor-stream-request',
            playerId: playerId,
            streamId: streamId,
            streamKey: streamKey,
            panelId: panelId
        });

        const options = {
            hostname: 'localhost',
            port: 30120, // Your FiveM/RedM server port
            path: '/monitor-stream-request',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const luaReq = http.request(options, (luaRes) => {
            console.log(`Lua server response: ${luaRes.statusCode}`);
        });

        luaReq.on('error', (err) => {
            console.log('Could not reach Lua server directly, using alternative method');
            
            // Alternative: Broadcast via WebSocket to all connected monitor connections
            // The Lua server should be listening for these messages
            connections.forEach((conn, clientId) => {
                if (conn.role === 'monitor' && conn.ws.readyState === WebSocket.OPEN) {
                    conn.ws.send(JSON.stringify({
                        type: 'lua-stream-request',
                        playerId: playerId,
                        streamId: streamId,
                        streamKey: streamKey,
                        panelId: panelId
                    }));
                }
            });
        });

        luaReq.write(postData);
        luaReq.end();

        console.log(`Monitor: Creating new stream ${streamId} for player ${playerId}`);
        
        res.json({
            success: true,
            streamId: streamId,
            streamKey: streamKey,
            playerName: `Player ${playerId}`,
            existing: false
        });
    }
});


// Monitor assign endpoint
app.post('/api/monitor/assign', authenticateAPI, (req, res) => {
    const { monitorId, streamId, streamKey, playerName, playerId } = req.body;
    
    console.log(`[Monitor] Assigning stream ${streamId} to monitor ${monitorId}`);
    
    // Notify monitor panels
    connections.forEach((conn, clientId) => {
        if (conn.role === 'monitor' && conn.ws.readyState === WebSocket.OPEN) {
            conn.ws.send(JSON.stringify({
                type: 'stream-assigned',
                monitorId,
                streamId,
                streamKey,
                playerName,
                playerId
            }));
        }
    });
    
    res.json({ success: true });
});

// Monitor stop stream
app.post('/api/monitor/stop', authenticateAPI, (req, res) => {
    const { playerId, panelId } = req.body;
    
    console.log(`[Monitor] Stopping stream for player ${playerId} in panel ${panelId}`);
    
    // Find and mark stream for cleanup
    activeStreams.forEach((stream, streamId) => {
        if (stream.playerId == playerId) {
            stream.monitorStopped = true;
        }
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
    
    // Store the offer and wait for WebSocket connection
    const stream = activeStreams.get(streamId);
    stream.pendingOffer = offer;
    
    res.json({
        success: true,
        message: 'Connect via WebSocket to complete setup',
        webSocketUrl: `ws://localhost:${PORT}/ws`
    });
    
    console.log(`[WebRTC] Offer received for stream ${streamId}`);
});

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
    
    // Check if this is a reconnection
    const isReconnect = stream.streamerWs === null;
    
    // Store streamer WebSocket
    stream.streamerWs = ws;
    
    ws.send(JSON.stringify({ 
        type: 'registered',
        role: 'streamer',
        streamKey,
        isReconnect 
    }));
    
    if (isReconnect) {
        console.log(`[WS] Streamer reconnected for stream: ${stream.streamId}`);
        
        // Notify about existing viewers
        if (stream.viewerWsList.length > 0) {
            stream.viewerWsList.forEach((viewerWs, index) => {
                ws.send(JSON.stringify({
                    type: 'viewer-joined',
                    viewerId: `viewer_${index}`
                }));
            });
        }
    } else {
        console.log(`[WS] Streamer registered for stream: ${stream.streamId}`);
    }
}

function handleViewerRegistration(clientId, ws, data) {
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
            message: 'Stream not found' 
        }));
        return;
    }
    
    // Update connection
    const connection = connections.get(clientId);
    connection.role = 'viewer';
    connection.streamKey = streamKey;
    
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
            viewerId: clientId
        }));
    }
    
    console.log(`[WS] Viewer registered for stream: ${stream.streamId} (Total viewers: ${stream.viewerCount})`);
}

function handleMonitorRegistration(clientId, ws, data) {
    const connection = connections.get(clientId);
    connection.role = 'monitor';
    monitorConnections.add(clientId);
    
    ws.send(JSON.stringify({type: 'registered', role: 'monitor'}));
    
    // Send current player list
    ws.send(JSON.stringify({type: 'player-update', players: playerList}));
    
    // Send current active streams
    const streams = Array.from(activeStreams.values()).map(stream => ({
        streamId: stream.streamId,
        streamKey: stream.streamKey,
        playerName: stream.playerName,
        playerId: stream.playerId,
        viewers: stream.viewerCount || 0
    }));
    ws.send(JSON.stringify({type: 'active-streams', streams: streams}));
    
    console.log(`[WS] Monitor registered: ${clientId}`);
    
    // Handle monitor-initiated stream requests
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'lua-stream-request') {
                // Forward to Lua server via your preferred method
                console.log(`[Monitor] Forwarding stream request for player ${data.playerId}`);
                // You can trigger the Lua event here if you have a bridge
            }
        } catch (error) {
            console.error(`[WS] Error parsing monitor message:`, error);
        }
    });
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
                vconn.ws.send(JSON.stringify({
                    type: 'offer',
                    offer: data.offer,
                    streamerId: clientId
                }));
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
    
    // Forward answer to streamer
    stream.streamerWs.send(JSON.stringify({
        type: 'answer',
        answer: data.answer,
        viewerId: clientId
    }));
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
                vconn.ws.send(JSON.stringify({
                    type: 'ice-candidate',
                    candidate: data.candidate,
                    from: 'streamer'
                }));
                break;
            }
        }
    } else if (connection.role === 'viewer' && stream.streamerWs) {
        // Send to streamer
        stream.streamerWs.send(JSON.stringify({
            type: 'ice-candidate',
            candidate: data.candidate,
            viewerId: clientId,
            from: 'viewer'
        }));
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
                        viewerId: clientId
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
                
                // Give 30 seconds to reconnect before ending stream
                setTimeout(() => {
                    if (!stream.streamerWs) {
                        // Notify all viewers
                        stream.viewerWsList.forEach(ws => {
                            if (ws.readyState === WebSocket.OPEN) {
                                ws.send(JSON.stringify({ type: 'stream-ended' }));
                            }
                        });
                        
                        activeStreams.delete(id);
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
            
            // Notify viewers
            stream.viewerWsList?.forEach(ws => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'stream-ended' }));
                }
            });
            
            // Remove stream
            activeStreams.delete(streamId);
        }
        
        // Check if monitor stopped it
        if (stream.monitorStopped) {
            console.log(`[Cleanup] Removing monitor-stopped stream: ${streamId}`);
            activeStreams.delete(streamId);
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