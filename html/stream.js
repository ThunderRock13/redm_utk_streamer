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
    }
});

class CfxGameViewRenderer {
  #gl;
  #texture;
  #animationFrame;

  constructor(canvas) {
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      depth: false,
      alpha: false,
      stencil: false,
      desynchronized: false,  // Keep synchronized for consistent quality
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
      failIfMajorPerformanceCaveat: false,
      premultipliedAlpha: false,
      xrCompatible: false
    }) || canvas.getContext('webgl', {
      antialias: false,
      depth: false,
      alpha: false,
      stencil: false,
      desynchronized: false,  // Keep synchronized for consistent quality
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
      failIfMajorPerformanceCaveat: false,
      premultipliedAlpha: false,
      xrCompatible: false
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
    precision highp float;
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

    // Use nearest filtering for crisp, pixel-perfect rendering (no blur)
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
    const gl = this.#gl;
    const canvas = gl.canvas;

    // Set actual canvas size (device pixels)
    canvas.width = width;
    canvas.height = height;

    // Set display size (CSS pixels) - important for sharp rendering
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';

    // Set viewport
    gl.viewport(0, 0, width, height);
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
      // Clear buffers to prevent degradation
      gl.clear(gl.COLOR_BUFFER_BIT);

      // Draw the frame
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // Don't flush - let browser handle it naturally for smoother streaming
    }
    this.#animationFrame = requestAnimationFrame(this.#render);
  };
}

async function startStream(config) {
    // Starting stream

    if (isStreaming) {
        // Already streaming, stopping first
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

        // Set canvas size based on config - ensure pixel perfect rendering
        const width = config.quality?.width || 1920;
        const height = config.quality?.height || 1080;

        // Get device pixel ratio for crisp rendering on high-DPI displays
        const devicePixelRatio = window.devicePixelRatio || 1;

        // Set actual canvas size (accounting for device pixel ratio)
        canvas.width = width * devicePixelRatio;
        canvas.height = height * devicePixelRatio;

        // Set display size (CSS pixels)
        canvas.style.width = width + 'px';
        canvas.style.height = height + 'px';

        let MainRender = new CfxGameViewRenderer(canvas);

        // Resize the renderer to match the actual canvas dimensions
        MainRender.resize(width * devicePixelRatio, height * devicePixelRatio);

        // Keep canvas hidden but available for capture
        canvas.style.visibility = 'hidden';
        canvas.style.display = 'block';

        // Wait for rendering to stabilize
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Try different capture methods - don't interfere with WebGL context
        try {
            // Method 1: Direct canvas capture - WebGL handles quality internally
            const targetFPS = Math.min(60, config.quality?.fps || 60);
            localStream = canvas.captureStream(targetFPS);
            // Using canvas.captureStream at ${targetFPS} FPS
        } catch (e1) {
            try {
                // Method 2: Mozilla prefix
                const targetFPS = Math.min(60, config.quality?.fps || 60);
                localStream = canvas.mozCaptureStream(targetFPS);
                // Using canvas.mozCaptureStream at ${targetFPS} FPS
            } catch (e2) {
            }
        }
        
        // Verify stream has tracks
        const videoTracks = localStream.getVideoTracks();
        const audioTracks = localStream.getAudioTracks();
        
        // Stream tracks checked
        
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
        
        // Connect to signaling server
        connectToSignalingServer(config);
        
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
    const wsUrl = config.webSocketUrl || 'ws://localhost:3000/ws';
    const streamKey = config.streamKey || config.streamId;
    
    // Connecting to WebSocket
    
    if (ws) {
        ws.close();
    }
    
    ws = new WebSocket(wsUrl);
    
    ws.onopen = () => {
        // WebSocket connected
        clearReconnectTimer();
        
        // Register as streamer with validation
        const streamKey = config.streamKey || config.streamId;
        // Registering with stream key

        ws.send(JSON.stringify({
            type: 'register-streamer',
            streamKey: streamKey
        }));
        
        // Start heartbeat
        startHeartbeat();
    };
    
    ws.onmessage = async (event) => {
        const data = JSON.parse(event.data);
        // WebSocket message received

        switch(data.type) {
            case 'registered':
                // Registered as streamer
                notifyStreamStarted();
                break;

            case 'viewer-joined':
                // Viewer joined
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
                ws.send(JSON.stringify({ type: 'pong' }));
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
        // WebSocket error
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
    // Viewer joined

    const configuration = {
        iceServers: webrtcConfig ? webrtcConfig.iceServers : [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ],
        iceTransportPolicy: webrtcConfig ? webrtcConfig.iceTransportPolicy : 'all',
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require',
        iceCandidatePoolSize: 0
    };

    const viewerPc = new RTCPeerConnection(configuration);

    // Add tracks with encoding parameters for better quality
    if (localStream) {
        const tracks = localStream.getTracks();
        tracks.forEach(track => {
            const sender = viewerPc.addTrack(track, localStream);

            // Apply encoding parameters for video tracks - optimized for sharpness
            if (track.kind === 'video') {
                const params = sender.getParameters();
                if (params.encodings && params.encodings.length > 0) {
                    // Maximum quality settings for crisp video
                    params.encodings[0].maxBitrate = streamConfig?.quality?.bitrate || 25000000; // 25 Mbps
                    params.encodings[0].maxFramerate = Math.min(60, streamConfig?.quality?.fps || 60);
                    params.encodings[0].scaleResolutionDownBy = 1; // No downscaling

                    // Quality-focused encoding settings
                    if (params.encodings[0].hasOwnProperty('priority')) {
                        params.encodings[0].priority = 'high';
                    }
                    if (params.encodings[0].hasOwnProperty('networkPriority')) {
                        params.encodings[0].networkPriority = 'high';
                    }

                    sender.setParameters(params).catch(err => {
                        // Failed to set encoding parameters
                    });
                }
            }
            // Adding track to peer connection
        });
        // Added tracks to peer connection
    } else {
        // ERROR: No local stream available
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
        // Viewer state changed
        
        if (viewerPc.connectionState === 'failed' || viewerPc.connectionState === 'closed') {
            viewers.delete(viewerId);
            updateDebug('viewerCount', viewers.size);
        }
    };
    
    viewers.set(viewerId, viewerPc);
    
    // Create offer with quality-focused constraints
    try {
        // Creating offer for viewer with optimal settings
        const offerOptions = {
            offerToReceiveVideo: false,
            offerToReceiveAudio: false,
            voiceActivityDetection: false,
            iceRestart: false
        };

        const offer = await viewerPc.createOffer(offerOptions);
        await viewerPc.setLocalDescription(offer);

        // Offer created, sending to server
        const offerMessage = {
            type: 'offer',
            offer: offer,
            viewerId: viewerId
        };

        // Sending offer message
        ws.send(JSON.stringify(offerMessage));
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
            if (ws.readyState === WebSocket.OPEN && streamConfig) {
                ws.send(JSON.stringify({
                    type: 'cleanup-stream',
                    streamKey: streamConfig.streamKey || streamConfig.streamId,
                    playerId: streamConfig.playerId,
                    reason: 'manual_stop'
                }));
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
        canvas.style.visibility = 'hidden';
    }
}

function startFPSMonitoring(canvas) {
    let lastTime = performance.now();
    let frames = 0;
    let performanceHistory = [];
    let qualityAdjustmentTimer = null;

    const checkFPS = () => {
        if (!isStreaming) return;

        frames++;
        const now = performance.now();
        if (now - lastTime >= 1000) {
            const currentFPS = frames;
            updateDebug('fps', currentFPS);

            // Track performance for adaptive quality
            performanceHistory.push({
                fps: currentFPS,
                timestamp: now,
                memoryUsage: performance.memory ? performance.memory.usedJSHeapSize : 0
            });

            // Keep only last 10 seconds of data
            performanceHistory = performanceHistory.filter(p => now - p.timestamp < 10000);

            // Adaptive quality adjustment (every 5 seconds)
            if (!qualityAdjustmentTimer) {
                qualityAdjustmentTimer = setTimeout(() => {
                    adjustStreamQuality(performanceHistory);
                    qualityAdjustmentTimer = null;
                }, 5000);
            }

            frames = 0;
            lastTime = now;
        }

        requestAnimationFrame(checkFPS);
    };

    checkFPS();
}

// Adaptive quality adjustment based on performance
function adjustStreamQuality(performanceData) {
    if (performanceData.length < 3 || !localStream) return;

    const avgFPS = performanceData.reduce((sum, p) => sum + p.fps, 0) / performanceData.length;
    const targetFPS = Math.min(60, streamConfig?.quality?.fps || 60);

    // If FPS is consistently low, we might need to reduce quality
    if (avgFPS < targetFPS * 0.8) {
        // Performance is suffering - could implement quality reduction here
        console.log(`[Performance] Average FPS: ${avgFPS.toFixed(1)}, Target: ${targetFPS}`);
    }
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

// Periodic memory cleanup to prevent buffer degradation (reduced frequency)
setInterval(() => {
    if (isStreaming && typeof gc !== 'undefined') {
        // Force garbage collection if available (Chrome with --js-flags="--expose-gc")
        gc();
    }
}, 120000); // Every 2 minutes

// Stream script loaded