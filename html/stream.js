// html/stream.js - Updated for WebSocket-based WebRTC
let ws = null;
let pc = null;
let localStream = null;
let streamConfig = null;
let viewers = new Map();

// Listen for messages from game
window.addEventListener('message', async (event) => {
    const data = event.data;
    
    switch(data.action) {
        case 'START_STREAM':
            await startStream(data);
            break;
        case 'STOP_STREAM':
            stopStream();
            break;
    }
});

async function startStream(config) {
    console.log('[Stream] Starting stream:', config.streamId);
    streamConfig = config;
    
    try {
        // Get the canvas element
        const canvas = document.getElementById('stream-canvas');
        
        // Start rendering game to canvas using utk_render
        if (typeof MainRender !== 'undefined') {
            console.log('[Stream] Using MainRender to capture game');
            MainRender.renderToTarget(canvas);
            
            // Wait for rendering to stabilize
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Capture stream from canvas
            localStream = canvas.captureStream(config.quality.fps || 30);
            
            // Verify we have video track
            const videoTracks = localStream.getVideoTracks();
            if (videoTracks.length === 0) {
                throw new Error('No video track available from canvas');
            }
            
            console.log('[Stream] Got video track:', videoTracks[0].label);
            
            // Connect to WebSocket signaling server
            connectToSignalingServer(config);
            
        } else {
            throw new Error('MainRender not available - utk_render module not loaded');
        }
        
    } catch (error) {
        console.error('[Stream] Error starting stream:', error);
        notifyError(error.message);
    }
}

function connectToSignalingServer(config) {
    const wsUrl = config.webSocketUrl || 'ws://localhost:3000/ws';
    console.log('[Stream] Connecting to WebSocket:', wsUrl);
    
    ws = new WebSocket(wsUrl);
    
    ws.onopen = () => {
        console.log('[Stream] WebSocket connected');
        
        // Register as streamer
        ws.send(JSON.stringify({
            type: 'register-streamer',
            streamKey: config.streamKey || config.streamId
        }));
    };
    
    ws.onmessage = async (event) => {
        const data = JSON.parse(event.data);
        console.log('[Stream] WS Message:', data.type);
        
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
        notifyError('WebSocket connection error');
    };
    
    ws.onclose = () => {
        console.log('[Stream] WebSocket disconnected');
        stopStream();
    };
}

async function handleViewerJoined(viewerId) {
    console.log('[Stream] Viewer joined:', viewerId);
    
    // Create peer connection for this viewer
    const configuration = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ]
    };
    
    const viewerPc = new RTCPeerConnection(configuration);
    
    // Add local stream tracks
    if (localStream) {
        localStream.getTracks().forEach(track => {
            viewerPc.addTrack(track, localStream);
            console.log('[Stream] Added track to viewer PC:', track.kind);
        });
    }
    
    // Handle ICE candidates
    viewerPc.onicecandidate = (event) => {
        if (event.candidate && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'ice-candidate',
                candidate: event.candidate,
                viewerId: viewerId
            }));
        }
    };
    
    // Monitor connection state
    viewerPc.onconnectionstatechange = () => {
        console.log(`[Stream] Viewer ${viewerId} connection state:`, viewerPc.connectionState);
        
        if (viewerPc.connectionState === 'failed' || viewerPc.connectionState === 'closed') {
            viewers.delete(viewerId);
        }
    };
    
    // Store viewer connection
    viewers.set(viewerId, viewerPc);
    
    // Create and send offer
    try {
        const offer = await viewerPc.createOffer({
            offerToReceiveAudio: false,
            offerToReceiveVideo: false
        });
        
        await viewerPc.setLocalDescription(offer);
        
        ws.send(JSON.stringify({
            type: 'offer',
            offer: offer,
            viewerId: viewerId
        }));
        
        console.log('[Stream] Sent offer to viewer:', viewerId);
        
    } catch (error) {
        console.error('[Stream] Error creating offer:', error);
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
    console.log('[Stream] Received answer from viewer:', viewerId);
    
    const viewerPc = viewers.get(viewerId);
    if (viewerPc) {
        try {
            await viewerPc.setRemoteDescription(new RTCSessionDescription(answer));
            console.log('[Stream] Set remote description for viewer:', viewerId);
        } catch (error) {
            console.error('[Stream] Error setting remote description:', error);
        }
    }
}

async function handleIceCandidate(viewerId, candidate) {
    const viewerPc = viewers.get(viewerId);
    if (viewerPc) {
        try {
            await viewerPc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (error) {
            console.error('[Stream] Error adding ICE candidate:', error);
        }
    }
}

function stopStream() {
    console.log('[Stream] Stopping stream');
    
    // Close all viewer connections
    viewers.forEach((pc, viewerId) => {
        pc.close();
    });
    viewers.clear();
    
    // Close WebSocket
    if (ws) {
        ws.close();
        ws = null;
    }
    
    // Stop main render
    if (typeof MainRender !== 'undefined' && MainRender.stop) {
        MainRender.stop();
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