// Dual Rendering WebRTC Streaming
let ws = null;
let localStream = null;
let streamConfig = null;
let viewers = new Map();
let isStreaming = false;
let renderLoop = null;

// Wait for MainRender to be available
function waitForMainRender(callback) {
    if (typeof MainRender !== 'undefined') {
        callback();
    } else {
        setTimeout(() => waitForMainRender(callback), 100);
    }
}

// Listen for messages from game
window.addEventListener('message', async (event) => {
    const data = event.data;
    
    switch(data.action) {
        case 'START_STREAM':
            waitForMainRender(() => startStream(data));
            break;
        case 'STOP_STREAM':
            stopStream();
            break;
    }
});

async function startStream(config) {
    console.log('[Stream] Starting dual render stream:', config.streamId);
    
    if (isStreaming) {
        stopStream();
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    streamConfig = config;
    isStreaming = true;
    
    try {
        const streamCanvas = document.getElementById('stream-canvas');
        const gameCanvas = document.getElementById('game-canvas');
        
        // Set canvas sizes
        streamCanvas.width = config.quality?.width || 1920;
        streamCanvas.height = config.quality?.height || 1080;
        
        gameCanvas.width = window.innerWidth;
        gameCanvas.height = window.innerHeight;
        
        // Start dual rendering
        startDualRender(streamCanvas, gameCanvas);
        
        // Wait for rendering to stabilize
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Capture stream from the stream canvas
        localStream = streamCanvas.captureStream(config.quality?.fps || 30);
        
        const videoTracks = localStream.getVideoTracks();
        console.log(`[Stream] Video tracks: ${videoTracks.length}`);
        
        if (videoTracks.length === 0) {
            throw new Error('No video track available');
        }
        
        // Connect to signaling server
        connectToSignalingServer(config);
        
    } catch (error) {
        console.error('[Stream] Error:', error);
        notifyError(error.message);
        stopStream();
    }
}

function startDualRender(streamCanvas, gameCanvas) {
    const streamCtx = streamCanvas.getContext('2d', { alpha: false });
    const gameCtx = gameCanvas.getContext('2d', { alpha: false });
    
    // Method 1: Try to use MainRender with dual output
    if (typeof MainRender !== 'undefined' && MainRender.renderToTarget) {
        console.log('[Stream] Using MainRender dual rendering');
        
        // Render to stream canvas
        MainRender.renderToTarget(streamCanvas);
        
        // Copy to game canvas in a loop to maintain game display
        renderLoop = setInterval(() => {
            if (!isStreaming) {
                clearInterval(renderLoop);
                return;
            }
            
            // Copy stream canvas to game canvas
            gameCtx.drawImage(streamCanvas, 0, 0, gameCanvas.width, gameCanvas.height);
            
            // Also try to render back to screen if possible
            if (MainRender.renderToScreen) {
                MainRender.renderToScreen();
            }
        }, 16); // ~60 FPS for game display
        
    } else {
        console.log('[Stream] MainRender not available, using test pattern');
        
        // Fallback to test pattern
        let frame = 0;
        renderLoop = setInterval(() => {
            if (!isStreaming) {
                clearInterval(renderLoop);
                return;
            }
            
            drawTestPattern(streamCtx, streamCanvas, frame++);
            // Copy to game canvas
            gameCtx.drawImage(streamCanvas, 0, 0, gameCanvas.width, gameCanvas.height);
        }, 33); // ~30 FPS
    }
}

function drawTestPattern(ctx, canvas, frame) {
    const time = Date.now() / 1000;
    const hue = (time * 30) % 360;
    
    // Gradient
    const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, `hsl(${hue}, 100%, 50%)`);
    gradient.addColorStop(1, `hsl(${(hue + 180) % 360}, 100%, 50%)`);
    
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Text
    ctx.fillStyle = 'white';
    ctx.font = '48px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('RedM Stream Active', canvas.width/2, canvas.height/2);
    ctx.fillText(`Frame: ${frame}`, canvas.width/2, canvas.height/2 + 60);
    ctx.fillText(new Date().toLocaleTimeString(), canvas.width/2, canvas.height/2 + 120);
}

function connectToSignalingServer(config) {
    const wsUrl = config.webSocketUrl || 'ws://localhost:3000/ws';
    const streamKey = config.streamKey || config.streamId;
    
    console.log('[Stream] Connecting to:', wsUrl);
    
    ws = new WebSocket(wsUrl);
    
    ws.onopen = () => {
        console.log('[Stream] WebSocket connected');
        
        ws.send(JSON.stringify({
            type: 'register-streamer',
            streamKey: streamKey
        }));
    };
    
    ws.onmessage = async (event) => {
        const data = JSON.parse(event.data);
        
        switch(data.type) {
            case 'registered':
                console.log('[Stream] Registered as streamer');
                notifyStreamStarted();
                break;
                
            case 'viewer-joined':
                await handleViewerJoined(data.viewerId);
                break;
                
            case 'viewer-left':
                handleViewerLeft(data.viewerId);
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
        }
    };
    
    ws.onerror = (error) => {
        console.error('[Stream] WebSocket error:', error);
    };
    
    ws.onclose = () => {
        console.log('[Stream] WebSocket closed');
        if (isStreaming) {
            setTimeout(() => {
                if (isStreaming && streamConfig) {
                    connectToSignalingServer(streamConfig);
                }
            }, 2000);
        }
    };
}

async function handleViewerJoined(viewerId) {
    console.log('[Stream] Viewer joined:', viewerId);
    
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
        console.log(`[Stream] Viewer ${viewerId} state:`, viewerPc.connectionState);
        
        if (viewerPc.connectionState === 'failed' || viewerPc.connectionState === 'closed') {
            viewers.delete(viewerId);
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
    console.log('[Stream] Viewer left:', viewerId);
    
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
    console.log('[Stream] Stopping dual render stream');
    isStreaming = false;
    
    // Stop render loop
    if (renderLoop) {
        clearInterval(renderLoop);
        renderLoop = null;
    }
    
    // Stop MainRender if it was rendering to target
    if (typeof MainRender !== 'undefined') {
        // Try to restore normal rendering
        if (MainRender.stop) {
            MainRender.stop();
        }
        // Try to render back to screen
        if (MainRender.renderToScreen) {
            MainRender.renderToScreen();
        }
    }
    
    // Clear canvases
    const streamCanvas = document.getElementById('stream-canvas');
    const gameCanvas = document.getElementById('game-canvas');
    if (streamCanvas) {
        const ctx = streamCanvas.getContext('2d');
        ctx.clearRect(0, 0, streamCanvas.width, streamCanvas.height);
    }
    if (gameCanvas) {
        const ctx = gameCanvas.getContext('2d');
        ctx.clearRect(0, 0, gameCanvas.width, gameCanvas.height);
    }
    
    // Close viewer connections
    viewers.forEach(pc => pc.close());
    viewers.clear();
    
    // Close WebSocket
    if (ws) {
        ws.close();
        ws = null;
    }
    
    // Stop local stream
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    
    streamConfig = null;
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

// Auto cleanup
window.addEventListener('beforeunload', () => {
    if (isStreaming) {
        stopStream();
    }
});

console.log('[Stream] Dual render script loaded');