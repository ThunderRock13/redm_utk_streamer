// WebRTC Streaming with proper utk_render integration
let ws = null;
let pc = null;
let localStream = null;
let streamConfig = null;
let viewers = new Map();
let reconnectTimer = null;
let heartbeatTimer = null;
let isStreaming = false;
let renderStarted = false;
console.log('[Stream.js] Script loaded at', new Date().toISOString());

// Debug mode
const DEBUG = true;
function debugLog(message) {
    console.log('[Stream]', message);
    fetch(`https://${GetParentResourceName()}/debugLog`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: message })
    });
}
function log(...args) {
    if (DEBUG) {
        console.log('[Stream]', ...args);
        updateDebug('status', args.join(' '));
    }
}

function updateDebug(field, value) {
    const el = document.getElementById(field);
    if (el) el.textContent = value;
}

// Listen for messages from game
window.addEventListener('message', async (event) => {
    const data = event.data;
    
    debugLog('Received message: ' + data.action);
    
    switch(data.action) {
        case 'START_STREAM':
            debugLog('START_STREAM config: ' + JSON.stringify(data));
            await startStream(data);
            break;
        case 'STOP_STREAM':
            debugLog('STOP_STREAM received');
            stopStream();
            break;
    }
});

async function startStream(config) {
    log('Starting stream:', config.streamId);
    
    if (isStreaming) {
        log('Already streaming, stopping first');
        stopStream();
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    streamConfig = config;
    isStreaming = true;
    updateDebug('streamId', config.streamId);
    
    try {
        // Get canvas
        const canvas = document.getElementById('stream-canvas');
        if (!canvas) {
            throw new Error('Canvas element not found');
        }
        
        // Check if MainRender is available
        if (typeof MainRender === 'undefined') {
            log('MainRender not ready, waiting...');
            
            // Try to access it from the window
            if (window.MainRender) {
                window.globalThis.MainRender = window.MainRender;
            }
            
            // Wait a bit more for module to load
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            if (typeof MainRender === 'undefined') {
                throw new Error('MainRender not available - utk_render module not loaded');
            }
        }
        
        log('MainRender available, starting capture');
        
        // Start rendering to canvas
        if (!renderStarted) {
            MainRender.renderToTarget(canvas);
            renderStarted = true;
            log('Render started to canvas');
        }
        
        // Wait for rendering to stabilize
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Try different capture methods
        try {
            // Method 1: Direct canvas capture
            localStream = canvas.captureStream(30);
            log('Using canvas.captureStream');
        } catch (e1) {
            try {
                // Method 2: Mozilla prefix
                localStream = canvas.mozCaptureStream(30);
                log('Using canvas.mozCaptureStream');
            } catch (e2) {
                // Method 3: Create from MainRender if available
                if (MainRender.getStream) {
                    localStream = MainRender.getStream();
                    log('Using MainRender.getStream');
                } else {
                    throw new Error('No capture method available');
                }
            }
        }
        
        // Verify stream has tracks
        const videoTracks = localStream.getVideoTracks();
        const audioTracks = localStream.getAudioTracks();
        
        log(`Stream tracks - Video: ${videoTracks.length}, Audio: ${audioTracks.length}`);
        
        if (videoTracks.length === 0) {
            // Try to create a test pattern if no video
            createTestPattern(canvas);
            await new Promise(resolve => setTimeout(resolve, 500));
            localStream = canvas.captureStream(30);
            
            const newTracks = localStream.getVideoTracks();
            if (newTracks.length === 0) {
                throw new Error('No video track available');
            }
            log('Using test pattern as fallback');
        }
        
        // Connect to signaling server
        connectToSignalingServer(config);
        
        // Start FPS monitoring
        startFPSMonitoring(canvas);
        
    } catch (error) {
        console.error('[Stream] Error:', error);
        log('Error: ' + error.message);
        notifyError(error.message);
        stopStream();
    }
}

function createTestPattern(canvas) {
    const ctx = canvas.getContext('2d');
    let hue = 0;
    
    const animate = () => {
        if (!isStreaming) return;
        
        // Create animated test pattern
        ctx.fillStyle = `hsl(${hue}, 100%, 50%)`;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        ctx.fillStyle = 'white';
        ctx.font = '48px Arial';
        ctx.textAlign = 'center';
        ctx.fillText('RedM Stream Test Pattern', canvas.width/2, canvas.height/2);
        ctx.fillText(new Date().toLocaleTimeString(), canvas.width/2, canvas.height/2 + 60);
        
        hue = (hue + 1) % 360;
        requestAnimationFrame(animate);
    };
    
    animate();
}

function connectToSignalingServer(config) {
    const wsUrl = config.webSocketUrl || 'ws://localhost:3000/ws';
    const streamKey = config.streamKey || config.streamId;
    
    debugLog('Connecting to: ' + wsUrl + ' with key: ' + streamKey);
    
    if (ws) {
        ws.close();
    }
    
    ws = new WebSocket(wsUrl);
    
    ws.onopen = () => {
        log('WebSocket connected');
        clearReconnectTimer();
        
        // Register as streamer
        ws.send(JSON.stringify({
            type: 'register-streamer',
            streamKey: config.streamKey || config.streamId
        }));
        
        // Start heartbeat
        startHeartbeat();
    };
    
    ws.onmessage = async (event) => {
        const data = JSON.parse(event.data);
        
        switch(data.type) {
            case 'registered':
                log('Registered as streamer');
                notifyStreamStarted();
                break;
                
            case 'viewer-joined':
                await handleViewerJoined(data.viewerId);
                updateDebug('viewerCount', viewers.size);
                break;
                
            case 'viewer-left':
                handleViewerLeft(data.viewerId);
                updateDebug('viewerCount', viewers.size);
                break;
                
            case 'answer':
                await handleAnswer(data.viewerId, data.answer);
                break;
                
            case 'ice-candidate':
                await handleIceCandidate(data.viewerId, data.candidate);
                break;
                
            case 'ping':
                ws.send(JSON.stringify({ type: 'pong' }));
                break;
                
            case 'error':
                log('Server error:', data.message);
                break;
        }
    };
    
    ws.onerror = (error) => {
        log('WebSocket error');
        console.error('[Stream] WebSocket error:', error);
    };
    
    ws.onclose = () => {
        log('WebSocket closed');
        stopHeartbeat();
        
        if (isStreaming) {
            log('Unexpected disconnect, attempting reconnect...');
            scheduleReconnect();
        }
    };
}

function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
        }
    }, 10000);
}

function stopHeartbeat() {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
}

function scheduleReconnect() {
    clearReconnectTimer();
    
    let attempts = 0;
    const maxAttempts = 10;
    
    const tryReconnect = () => {
        if (!isStreaming || !streamConfig) {
            log('Stream stopped, canceling reconnect');
            return;
        }
        
        attempts++;
        log(`Reconnect attempt ${attempts}/${maxAttempts}`);
        
        if (attempts > maxAttempts) {
            log('Max reconnect attempts reached');
            notifyError('Failed to reconnect to server');
            stopStream();
            return;
        }
        
        connectToSignalingServer(streamConfig);
        
        // Schedule next attempt with exponential backoff
        reconnectTimer = setTimeout(tryReconnect, Math.min(1000 * Math.pow(2, attempts), 30000));
    };
    
    reconnectTimer = setTimeout(tryReconnect, 2000);
}

function clearReconnectTimer() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
}

async function handleViewerJoined(viewerId) {
    log('Viewer joined:', viewerId);
    
    const configuration = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ]
    };
    
    const viewerPc = new RTCPeerConnection(configuration);
    
    // Add tracks
    if (localStream) {
        localStream.getTracks().forEach(track => {
            viewerPc.addTrack(track, localStream);
        });
    }
    
    // ICE candidates
    viewerPc.onicecandidate = (event) => {
        if (event.candidate && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'ice-candidate',
                candidate: event.candidate,
                viewerId: viewerId
            }));
        }
    };
    
    // Connection state
    viewerPc.onconnectionstatechange = () => {
        log(`Viewer ${viewerId} state:`, viewerPc.connectionState);
        
        if (viewerPc.connectionState === 'failed' || viewerPc.connectionState === 'closed') {
            viewers.delete(viewerId);
            updateDebug('viewerCount', viewers.size);
        }
    };
    
    viewers.set(viewerId, viewerPc);
    
    // Create offer
    try {
        const offer = await viewerPc.createOffer();
        await viewerPc.setLocalDescription(offer);
        
        ws.send(JSON.stringify({
            type: 'offer',
            offer: offer,
            viewerId: viewerId
        }));
        
    } catch (error) {
        console.error('[Stream] Offer error:', error);
    }
}

function handleViewerLeft(viewerId) {
    log('Viewer left:', viewerId);
    
    const viewerPc = viewers.get(viewerId);
    if (viewerPc) {
        viewerPc.close();
        viewers.delete(viewerId);
    }
}

async function handleAnswer(viewerId, answer) {
    const viewerPc = viewers.get(viewerId);
    if (viewerPc) {
        try {
            await viewerPc.setRemoteDescription(new RTCSessionDescription(answer));
        } catch (error) {
            console.error('[Stream] Answer error:', error);
        }
    }
}

async function handleIceCandidate(viewerId, candidate) {
    const viewerPc = viewers.get(viewerId);
    if (viewerPc) {
        try {
            await viewerPc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (error) {
            console.error('[Stream] ICE error:', error);
        }
    }
}

function stopStream() {
    log('Stopping stream');
    isStreaming = false;
    
    // Clear timers
    clearReconnectTimer();
    stopHeartbeat();
    
    // Close viewer connections
    viewers.forEach(pc => pc.close());
    viewers.clear();
    updateDebug('viewerCount', '0');
    
    // Close WebSocket
    if (ws) {
        ws.close();
        ws = null;
    }
    
    // Stop MainRender
    if (renderStarted && typeof MainRender !== 'undefined' && MainRender.stop) {
        MainRender.stop();
        renderStarted = false;
    }
    
    // Stop local stream
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    
    updateDebug('status', 'Stopped');
    updateDebug('streamId', '-');
    streamConfig = null;
}

function startFPSMonitoring(canvas) {
    let lastTime = performance.now();
    let frames = 0;
    
    const checkFPS = () => {
        if (!isStreaming) return;
        
        frames++;
        const now = performance.now();
        if (now - lastTime >= 1000) {
            updateDebug('fps', frames);
            frames = 0;
            lastTime = now;
        }
        
        requestAnimationFrame(checkFPS);
    };
    
    checkFPS();
}

// Notification functions
function notifyStreamStarted() {
    fetch(`https://${GetParentResourceName()}/streamStarted`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
            streamId: streamConfig.streamId,
            streamKey: streamConfig.streamKey || streamConfig.streamId
        })
    });
}

function notifyError(error) {
    fetch(`https://${GetParentResourceName()}/streamError`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: error })
    });
}

function GetParentResourceName() {
    return 'redm_streamer';
}

// Auto cleanup on page unload
window.addEventListener('beforeunload', () => {
    if (isStreaming) {
        stopStream();
    }
});

log('Stream script loaded');