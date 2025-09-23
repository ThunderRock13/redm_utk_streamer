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

// WebRTC Configuration (for firewall-free streaming)
let webrtcConfig = null;

// WebSocket streaming fallback
let wsStreamingEnabled = false;
let wsStreamingInterval = null;

// Debug mode
const DEBUG = false;
function debugLog(message) {
    // Silent debug logging
}
function log(...args) {
    // Completely silent - no logging at all
}

// Load WebRTC configuration from server for firewall-free streaming
async function loadWebRTCConfig() {
    try {
        const response = await fetch('http://localhost:3000/api/webrtc/config');
        if (response.ok) {
            webrtcConfig = await response.json();
            // WebRTC config loaded
            // Firewall-free mode check
        } else {
            // Failed to load WebRTC config, using defaults
            webrtcConfig = getDefaultWebRTCConfig();
        }
    } catch (error) {
        // Error loading WebRTC config, using defaults
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

function updateDebug(field, value) {
    const el = document.getElementById(field);
    if (el) el.textContent = value;
}

// Listen for messages from game
window.addEventListener('message', async (event) => {
    const data = event.data;

    // Received message

    switch(data.action) {
        case 'START_STREAM':
            // START_STREAM config received
            await startStream(data);
            break;
        case 'STOP_STREAM':
            // STOP_STREAM received
            stopStream();
            break;
        case 'BRIDGE_REGISTERED':
            // Bridge registration successful
            handleBridgeRegistered(data);
            break;
        case 'BRIDGE_MESSAGE':
            // Message from bridge
            handleBridgeMessage(data.message);
            break;
    }
});

class CfxGameViewRenderer {
  #gl;
  #texture;
  #animationFrame;

  constructor(canvas) {
    const gl = canvas.getContext('webgl', {
      antialias: false,
      depth: false,
      alpha: false,
      stencil: false,
      desynchronized: true,
      powerPreference: 'high-performance',
    });

    if (!gl) {
      throw new Error('Failed to acquire webgl context for GameViewRenderer');
    }

    this.#gl = gl;

    this.#texture = this.#createTexture(gl);
    const { program, vloc, tloc } = this.#createProgram(gl);
    const { vertexBuff, texBuff } = this.#createBuffers(gl);

    gl.useProgram(program);

    gl.bindTexture(gl.TEXTURE_2D, this.#texture);

    gl.uniform1i(gl.getUniformLocation(program, "external_texture"), 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuff);
    gl.vertexAttribPointer(vloc, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(vloc);

    gl.bindBuffer(gl.ARRAY_BUFFER, texBuff);
    gl.vertexAttribPointer(tloc, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(tloc);

    this.#render();
  }

  #compileAndLinkShaders(gl, program, vs, fs) {
    gl.compileShader(vs);
    gl.compileShader(fs);

    gl.linkProgram(program);

    if (gl.getProgramParameter(program, gl.LINK_STATUS))
    {
      return;
    }

    // Link failed

    throw new Error('Failed to compile shaders');
  }

  #attachShader(gl, program, type, src) {
    const shader = gl.createShader(type);

    gl.shaderSource(shader, src);
    gl.attachShader(program, shader);

    return shader;
  }

  #createProgram(gl) {
    const program = gl.createProgram();

    const vertexShaderSrc = `
      attribute vec2 a_position;
      attribute vec2 a_texcoord;
      uniform mat3 u_matrix;
      varying vec2 textureCoordinate;
      void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
        textureCoordinate = a_texcoord;
      }
    `;

    const fragmentShaderSrc = `
    varying highp vec2 textureCoordinate;
    uniform sampler2D external_texture;
    void main()
    {
      gl_FragColor = texture2D(external_texture, textureCoordinate);
    }
    `;

    const vertexShader = this.#attachShader(gl, program, gl.VERTEX_SHADER, vertexShaderSrc);
    const fragmentShader = this.#attachShader(gl, program, gl.FRAGMENT_SHADER, fragmentShaderSrc);

    this.#compileAndLinkShaders(gl, program, vertexShader, fragmentShader);

    gl.useProgram(program);

    const vloc = gl.getAttribLocation(program, "a_position");
    const tloc = gl.getAttribLocation(program, "a_texcoord");

    return { program, vloc, tloc };
  }

  #createTexture(gl) {
    const tex = gl.createTexture();

    const texPixels = new Uint8Array([0, 0, 255, 255]);

    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, texPixels);

    gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);

    // Magic hook sequence
    gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
    gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);

    // Reset
    gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    return tex;
  }

  #createBuffers(gl) {
    const vertexBuff = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuff);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,
      1, -1,
      -1, 1,
      1, 1,
    ]), gl.STATIC_DRAW);

    const texBuff = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, texBuff);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
		0, 1,
		1, 1,
		0, 0,
		1, 0,
    ]), gl.STATIC_DRAW);

    return { vertexBuff, texBuff };
  }

  resize(width, height) {
    this.#gl.viewport(0, 0, width, height);
    this.#gl.canvas.width = width;
    this.#gl.canvas.height = height;
  }

  destroy() {
    if (this.#animationFrame) {
      cancelAnimationFrame(this.#animationFrame);
    }
    this.#texture = null;
  }

  #render = () => {
    const gl = this.#gl;
    if (gl)
    {
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    this.#animationFrame = requestAnimationFrame(this.#render);
  };
}

async function startStream(config) {
    console.log('Starting stream:', config.streamId);

    if (isStreaming) {
        console.log('Already streaming, stopping first');
        stopStream();
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // Load WebRTC configuration for firewall-free streaming
    if (!webrtcConfig) {
        await loadWebRTCConfig();
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

        console.log('Canvas found:', canvas.width, 'x', canvas.height);

        let MainRender = new CfxGameViewRenderer(canvas);
        console.log('CfxGameViewRenderer initialized');

        // Wait for rendering to stabilize
        console.log('Waiting for rendering to stabilize...');
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Try different capture methods
        try {
            // Method 1: Direct canvas capture
            localStream = canvas.captureStream(30);
            // Using canvas.captureStream
        } catch (e1) {
            try {
                // Method 2: Mozilla prefix
                localStream = canvas.mozCaptureStream(30);
                // Using canvas.mozCaptureStream
            } catch (e2) {
            }
        }
        
        // Verify stream has tracks
        const videoTracks = localStream.getVideoTracks();
        const audioTracks = localStream.getAudioTracks();

        console.log(`Stream tracks - Video: ${videoTracks.length}, Audio: ${audioTracks.length}`);
        if (videoTracks.length > 0) {
            console.log('Video track details:', {
                enabled: videoTracks[0].enabled,
                readyState: videoTracks[0].readyState,
                settings: videoTracks[0].getSettings()
            });
        }
        
        if (videoTracks.length === 0) {
            // Try to create a test pattern if no video
            createTestPattern(canvas);
            await new Promise(resolve => setTimeout(resolve, 500));
            localStream = canvas.captureStream(30);

            const newTracks = localStream.getVideoTracks();
            if (newTracks.length === 0) {
                throw new Error('No video track available');
            }
            // Using test pattern as fallback
        }

        // Connect to signaling server (or use bridge mode)
        if (config.bridgeMode) {
            connectViaBridge(config);
        } else {
            connectToSignalingServer(config);
        }
        
        // Start FPS monitoring
        startFPSMonitoring(canvas);
        
    } catch (error) {
        // Stream error occurred
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
    const streamKey = config.streamKey || config.streamId;

    // Skip WebSocket entirely in HTTPS context due to mixed content issues
    if (window.location.protocol === 'https:') {
        console.log('HTTPS context detected - skipping WebSocket, using direct mode');
        useHttpPollingFallback(config);
        return;
    }

    let wsUrl = config.webSocketUrl || 'ws://localhost:3000/ws';
    console.log('Attempting to connect to WebSocket:', wsUrl);

    if (ws) {
        ws.close();
    }

    // Try WebSocket connection
    ws = new WebSocket(wsUrl);
    
    ws.onopen = () => {
        console.log('WebSocket connected');
        clearReconnectTimer();

        // Register as streamer with validation
        const streamKey = config.streamKey || config.streamId;
        console.log('Registering with stream key:', streamKey);

        sendWebSocketMessage({
            type: 'register-streamer',
            streamKey: streamKey
        });

        // Start heartbeat
        startHeartbeat();
    };
    
    ws.onmessage = async (event) => {
        const data = JSON.parse(event.data);
        console.log('WebSocket message received:', data.type);

        switch(data.type) {
            case 'registered':
                console.log('Registered as streamer');
                notifyStreamStarted();
                break;

            case 'viewer-joined':
                console.log('Viewer joined message received:', data);
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

            case 'force-stop':
                // Received force stop command
                notifyError('Stream stopped by server: ' + (data.reason || 'unknown reason'));
                stopStream();
                break;

            case 'ping':
                sendWebSocketMessage({ type: 'pong' });
                break;

            case 'error':
                // Server error

                // Handle specific error cases
                if (data.message && data.message.includes('Invalid stream key')) {
                    // Stream key rejected
                    notifyError('Invalid stream key: ' + (streamConfig?.streamKey || streamConfig?.streamId));
                    stopStream();
                }
                break;

            case 'request-ws-streaming':
                // WebSocket streaming requested
                enableWebSocketStreaming();
                break;

            case 'stop-ws-streaming':
                // Stopping WebSocket streaming
                disableWebSocketStreaming();
                break;
        }
    };
    
    ws.onerror = (error) => {
        console.error('[Stream] WebSocket error:', error);

        // If this is a mixed content error, try the HTTP fallback
        if (window.location.protocol === 'https:') {
            console.log('WebSocket failed in HTTPS context, falling back to HTTP registration');
            useHttpPollingFallback(streamConfig);
        }
    };
    
    ws.onclose = (event) => {
        // WebSocket closed
        stopHeartbeat();

        // Handle different close codes
        // Connection closed - checking codes

        // Only reconnect if it wasn't a deliberate close (code 1000)
        if (isStreaming && event.code !== 1000) {
            // Unexpected disconnect, attempting reconnect
            scheduleReconnect();
        } else if (event.code === 1000) {
            // Connection closed deliberately
            stopStream();
        }
    };
}

// Direct streaming mode for HTTPS mixed content issues
function useHttpPollingFallback(config) {
    console.log('Running in direct streaming mode (no WebSocket)');

    // Set up config for direct mode
    streamConfig = config;
    streamConfig.directMode = true;

    // Try to establish direct peer connection after stream is ready
    setTimeout(() => {
        setupDirectPeerConnection(config);
    }, 1000);

    // Start heartbeat simulation
    if (!heartbeatTimer) {
        heartbeatTimer = setInterval(() => {
            console.log('Direct mode heartbeat - stream active');
        }, 30000);
    }

    notifyStreamStarted();
}

// Setup peer connection directly without WebSocket signaling
async function setupDirectPeerConnection(config) {
    console.log('Setting up direct peer connection');

    try {
        // Create peer connection
        const pc = new RTCPeerConnection({
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:192.99.60.230:3478' }
            ]
        });

        // Add video track to peer connection
        if (localStream && localStream.getVideoTracks().length > 0) {
            localStream.getVideoTracks().forEach(track => {
                pc.addTrack(track, localStream);
                console.log('Added video track to peer connection');
            });

            // Create offer and set as local description
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            console.log('Created SDP offer for direct connection');

            // Store the peer connection for potential manual connection
            window.directPeerConnection = pc;
            window.directOffer = offer;

            console.log('Direct peer connection ready - offer available');
            console.log('SDP Offer:', offer.sdp.substring(0, 100) + '...');

            // Make connection function globally available
            window.connectDirectStream = function() {
                console.log('=== DIRECT STREAM CONNECTION INFO ===');
                console.log('Stream ID:', config.streamId || config.streamKey);
                console.log('Stream Key:', config.streamKey);
                console.log('SDP Offer:', offer.sdp);
                console.log('=== TO CONNECT FROM MONITOR ===');
                console.log('1. Open monitor in browser console');
                console.log('2. Run: window.connectToDirectStream("' + config.streamKey + '", `' + offer.sdp + '`)');
                return {
                    streamKey: config.streamKey,
                    offer: offer.sdp,
                    peerConnection: pc
                };
            };

            console.log('🎯 Call window.connectDirectStream() for connection details');
        }
    } catch (error) {
        console.error('Direct peer connection setup failed:', error);
    }
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
            // Stream stopped, canceling reconnect
            return;
        }
        
        attempts++;
        // Reconnect attempt
        
        if (attempts > maxAttempts) {
            // Max reconnect attempts reached
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
    console.log('Viewer joined:', viewerId);
    console.log('Local stream available:', !!localStream);
    console.log('Local stream tracks:', localStream ? localStream.getTracks().length : 0);

    const configuration = {
        iceServers: webrtcConfig ? webrtcConfig.iceServers : [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ],
        iceTransportPolicy: webrtcConfig ? webrtcConfig.iceTransportPolicy : 'all'
    };

    const viewerPc = new RTCPeerConnection(configuration);

    // Add tracks
    if (localStream) {
        const tracks = localStream.getTracks();
        tracks.forEach(track => {
            console.log('Adding track to peer connection:', track.kind, track.enabled);
            viewerPc.addTrack(track, localStream);
        });
        console.log('Added', tracks.length, 'tracks to peer connection');
    } else {
        console.log('ERROR: No local stream available for viewer connection');
    }
    
    // ICE candidates
    viewerPc.onicecandidate = (event) => {
        if (event.candidate) {
            sendWebSocketMessage({
                type: 'ice-candidate',
                candidate: event.candidate,
                viewerId: viewerId
            });
        }
    };
    
    // Connection state
    viewerPc.onconnectionstatechange = () => {
        // Viewer state changed
        
        if (viewerPc.connectionState === 'failed' || viewerPc.connectionState === 'closed') {
            viewers.delete(viewerId);
            updateDebug('viewerCount', viewers.size);
        }
    };
    
    viewers.set(viewerId, viewerPc);
    
    // Create offer
    try {
        // Creating offer for viewer
        const offer = await viewerPc.createOffer();
        await viewerPc.setLocalDescription(offer);

        // Offer created, sending to server
        const offerMessage = {
            type: 'offer',
            offer: offer,
            viewerId: viewerId
        };

        // Sending offer message
        sendWebSocketMessage(offerMessage);
        // Offer sent successfully

    } catch (error) {
        // Failed to create/send offer
    }
}

function handleViewerLeft(viewerId) {
    // Viewer left
    
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
            // Answer error
        }
    }
}

async function handleIceCandidate(viewerId, candidate) {
    const viewerPc = viewers.get(viewerId);
    if (viewerPc) {
        try {
            await viewerPc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (error) {
            // ICE error
        }
    }
}

function stopStream() {
    // Stopping stream
    isStreaming = false;

    // Clear timers
    clearReconnectTimer();
    stopHeartbeat();

    // Close viewer connections
    viewers.forEach(pc => {
        try {
            pc.close();
        } catch (e) {
            // Error closing peer connection
        }
    });
    viewers.clear();
    updateDebug('viewerCount', '0');

    // Close WebSocket with proper cleanup code
    if (ws) {
        try {
            // Send cleanup notification before closing
            if (streamConfig) {
                sendWebSocketMessage({
                    type: 'cleanup-stream',
                    streamKey: streamConfig.streamKey || streamConfig.streamId,
                    playerId: streamConfig.playerId,
                    reason: 'manual_stop'
                });
            }
            ws.close(1000, 'Stream stopped');
        } catch (e) {
            // Error closing WebSocket
        }
        ws = null;
    }

    // Stop MainRender
    if (renderStarted && typeof MainRender !== 'undefined' && MainRender.stop) {
        MainRender.stop();
        renderStarted = false;
    }

    // Stop local stream
    if (localStream) {
        localStream.getTracks().forEach(track => {
            try {
                track.stop();
            } catch (e) {
                // Error stopping track
            }
        });
        localStream = null;
    }

    updateDebug('status', 'Stopped');
    updateDebug('streamId', '-');
    streamConfig = null;

    // Force garbage collection by clearing canvas
    const canvas = document.getElementById('stream-canvas');
    if (canvas) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
        canvas.style.display = 'none';
    }
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

// WebSocket streaming fallback functions
function enableWebSocketStreaming() {
    // Enabling WebSocket video streaming fallback
    wsStreamingEnabled = true;

    if (wsStreamingInterval) {
        clearInterval(wsStreamingInterval);
    }

    // Start capturing and sending frames via WebSocket
    wsStreamingInterval = setInterval(() => {
        captureAndSendFrame();
    }, 100); // 10 FPS

    // WebSocket streaming enabled (10 FPS)
}

function disableWebSocketStreaming() {
    // Disabling WebSocket streaming
    wsStreamingEnabled = false;

    if (wsStreamingInterval) {
        clearInterval(wsStreamingInterval);
        wsStreamingInterval = null;
    }

    // WebSocket streaming disabled
}

function captureAndSendFrame() {
    if (!wsStreamingEnabled || !ws || ws.readyState !== WebSocket.OPEN) {
        return;
    }

    try {
        const canvas = document.getElementById('stream-canvas');
        if (!canvas) {
            return;
        }

        // Convert canvas to base64 JPEG
        const frameData = canvas.toDataURL('image/jpeg', 0.7).split(',')[1]; // Remove data:image/jpeg;base64, prefix

        // Send frame via WebSocket
        ws.send(JSON.stringify({
            type: 'ws-stream-frame',
            streamKey: streamConfig?.streamKey,
            frame: frameData
        }));

    } catch (error) {
        // Error capturing frame for WebSocket streaming
    }
}

// Auto cleanup on page unload
window.addEventListener('beforeunload', () => {
    if (isStreaming) {
        disableWebSocketStreaming();
        stopStream();
    }
});

// Bridge Mode Functions (HTTPS mixed content workaround)
function connectViaBridge(config) {
    console.log('Using bridge mode to bypass HTTPS mixed content');
    streamConfig = config;

    // The video capture is working, stream should be detectable
    // WebSocket signaling is blocked but not critical for basic streaming
    console.log('Bridge mode enabled - video streaming active without WebSocket signaling');
}

function handleBridgeRegistered(data) {
    if (data.success) {
        console.log('Bridge registered successfully');
        notifyStreamStarted();
    }
}

function handleBridgeMessage(message) {
    console.log('Bridge message received:', message.type);

    switch(message.type) {
        case 'registered':
            console.log('Registered as streamer via bridge');
            break;

        case 'viewer-joined':
            console.log('Viewer joined via bridge:', message);
            handleViewerJoined(message.viewerId);
            updateDebug('viewerCount', viewers.size);
            break;

        case 'viewer-left':
            handleViewerLeft(message.viewerId);
            updateDebug('viewerCount', viewers.size);
            break;

        case 'answer':
            handleAnswer(message.viewerId, message.answer);
            break;

        case 'ice-candidate':
            handleIceCandidate(message.viewerId, message.candidate);
            break;

        case 'force-stop':
            console.log('Force stop via bridge:', message.reason);
            notifyError('Stream stopped by server: ' + (message.reason || 'unknown reason'));
            stopStream();
            break;

        case 'error':
            console.log('Bridge error:', message.message);
            if (message.message && message.message.includes('Invalid stream key')) {
                notifyError('Invalid stream key: ' + (streamConfig?.streamKey || streamConfig?.streamId));
                stopStream();
            }
            break;
    }
}

function sendViaBridge(message) {
    // Send message to RTC server via bridge
    fetch(`https://${GetParentResourceName()}/bridgeMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            message: message
        })
    }).catch(error => {
        console.log('Bridge send error (expected):', error.message);
    });
}

// Override WebSocket send for bridge mode
function sendWebSocketMessage(message) {
    if (streamConfig && streamConfig.bridgeMode) {
        sendViaBridge(message);
    } else if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
    }
}

function GetParentResourceName() {
    return 'redm_streamer';
}

// Stream script loaded