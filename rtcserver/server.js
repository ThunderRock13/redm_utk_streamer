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

// WebSocket server for WebRTC signaling
const wss = new WebSocket.Server({ 
    server,
    path: '/ws'
});

// Store active streams and connections
const activeStreams = new Map();
const connections = new Map();
const viewers = new Map();

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
        viewerWsList: []
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
    
    // Store streamer WebSocket
    stream.streamerWs = ws;
    
    ws.send(JSON.stringify({ 
        type: 'registered',
        role: 'streamer',
        streamKey 
    }));
    
    console.log(`[WS] Streamer registered for stream: ${stream.streamId}`);
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
                
                // Notify streamer
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
        // Streamer disconnected - end stream
        for (const [id, stream] of activeStreams) {
            if (stream.streamKey === connection.streamKey) {
                // Notify all viewers
                stream.viewerWsList.forEach(ws => {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: 'stream-ended' }));
                    }
                });
                
                console.log(`[WS] Streamer disconnected, ending stream: ${stream.streamId}`);
                break;
            }
        }
    }
    
    connections.delete(clientId);
}

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