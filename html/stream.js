// RedM Streaming with Direct WebRTC Connection
// Uses WebSocket to connect directly to RTC server

let localStream = null;
let streamConfig = null;
let isStreaming = false;
let renderStarted = false;
let streamInitializationInProgress = false;

// WebRTC and WebSocket variables
let websocket = null;
let peerConnection = null;
let clientId = null;

// Debug logging
const DEBUG = true;
function debugLog(message) {
    if (DEBUG) console.log(`[Stream] ${message}`);
}

function updateDebug(field, value) {
    const el = document.getElementById(field);
    if (el) el.textContent = value;
}

// Script initialization
console.log('[NUI] Stream script loaded and initializing...');

// Listen for messages from game
window.addEventListener('message', async (event) => {
    try {
        const data = event.data;
        console.log(`[NUI] Received message:`, data.action);
        console.log(`[NUI] Full message data:`, data);

        switch(data.action) {
            case 'INIT_STREAM':
                console.log(`[NUI] Starting stream with config:`, data.config);
                try {
                    await startStream(data.config);
                } catch (error) {
                    console.error('[NUI] Error starting stream:', error);
                }
                break;
            case 'STOP_STREAM':
                console.log(`[NUI] Stopping stream`);
                try {
                    stopStream();
                } catch (error) {
                    console.error('[NUI] Error stopping stream:', error);
                }
                break;
            default:
                console.log(`[NUI] Unknown action: ${data.action}`);
        }
    } catch (error) {
        console.error('[NUI] Error processing message:', error);
    }
});

// Test if NUI is working
console.log('[NUI] Script initialization complete, waiting for messages...');

// DOM ready check
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        console.log('[NUI] DOM ready, canvas check...');
        const canvas = document.getElementById('stream-canvas');
        console.log('[NUI] Canvas element found:', !!canvas);
        if (canvas) {
            console.log('[NUI] Canvas dimensions:', canvas.width, 'x', canvas.height);
        }
    });
} else {
    console.log('[NUI] DOM already ready, canvas check...');
    const canvas = document.getElementById('stream-canvas');
    console.log('[NUI] Canvas element found:', !!canvas);
    if (canvas) {
        console.log('[NUI] Canvas dimensions:', canvas.width, 'x', canvas.height);
    }
}

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
            desynchronized: false,
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
            desynchronized: false,
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

        if (gl.getProgramParameter(program, gl.LINK_STATUS)) {
            return;
        }
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
            void main() {
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
        gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        return tex;
    }

    #createBuffers(gl) {
        const vertexBuff = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuff);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            -1, -1, 1, -1, -1, 1, 1, 1,
        ]), gl.STATIC_DRAW);

        const texBuff = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, texBuff);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            0, 1, 1, 1, 0, 0, 1, 0,
        ]), gl.STATIC_DRAW);

        return { vertexBuff, texBuff };
    }

    resize(width, height) {
        const gl = this.#gl;
        const canvas = gl.canvas;

        canvas.width = width;
        canvas.height = height;
        canvas.style.width = width + 'px';
        canvas.style.height = height + 'px';
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
        if (gl) {
            gl.clear(gl.COLOR_BUFFER_BIT);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        }
        this.#animationFrame = requestAnimationFrame(this.#render);
    };
}

// WebSocket connection management
function connectToRTCServer() {
    return new Promise((resolve, reject) => {
        console.log('[NUI] Connecting to RTC server via WebSocket...');

        // Connect to RTC server directly - use HTTP WebSocket
        const wsUrl = 'ws://192.99.60.230:3000/ws';
        console.log('[NUI] Attempting connection to:', wsUrl);
        websocket = new WebSocket(wsUrl);

        websocket.onopen = () => {
            console.log('[NUI] WebSocket connected to RTC server');

            // Register as streamer
            const registerMessage = {
                type: 'register-streamer',
                streamId: streamConfig.streamId,
                streamKey: streamConfig.streamKey || streamConfig.streamId,
                quality: streamConfig.quality
            };

            websocket.send(JSON.stringify(registerMessage));
            console.log('[NUI] Sent streamer registration details:');
            console.log('- Message type:', registerMessage.type);
            console.log('- Stream ID:', registerMessage.streamId);
            console.log('- Stream Key:', registerMessage.streamKey);
            console.log('- Quality:', JSON.stringify(registerMessage.quality));
            console.log('- Full message:', JSON.stringify(registerMessage));
            resolve();
        };

        websocket.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                console.log('[NUI] Received WebSocket message details:');
                console.log('- Message type:', data.type);
                console.log('- Raw message:', event.data);
                console.log('- Parsed data:', JSON.stringify(data));
                handleWebSocketMessage(data);
            } catch (error) {
                console.error('[NUI] Failed to parse WebSocket message:', error);
                console.error('- Raw message was:', event.data);
            }
        };

        websocket.onerror = (error) => {
            console.error('[NUI] WebSocket error details:');
            console.error('- Error type:', error.type);
            console.error('- Error target:', error.target);
            console.error('- Error message:', error.message);
            console.error('- WebSocket readyState:', error.target ? error.target.readyState : 'unknown');
            console.error('- WebSocket URL:', error.target ? error.target.url : 'unknown');
            console.error('- Full error object:', error);
            reject(error);
        };

        websocket.onclose = () => {
            console.log('[NUI] WebSocket connection closed');
            if (isStreaming) {
                console.log('[NUI] Attempting to reconnect...');
                setTimeout(() => {
                    if (isStreaming) {
                        connectToRTCServer().catch(console.error);
                    }
                }, 5000);
            }
        };
    });
}

function handleWebSocketMessage(data) {
    console.log(`[NUI] Handling WebSocket message: ${data.type}`);

    switch (data.type) {
        case 'registered':
        case 'registration-success':
            console.log('[NUI] Registration successful details:');
            console.log('- Client ID:', data.clientId);
            console.log('- Role:', data.role);
            console.log('- Stream Key:', data.streamKey);
            clientId = data.clientId;
            break;

        case 'viewer-joined':
            console.log('[NUI] Viewer joined details:');
            console.log('- Viewer ID:', data.viewerId);
            console.log('- Panel ID:', data.panelId);
            createPeerConnection(data.viewerId);
            break;

        case 'offer':
            console.log('[NUI] Received offer from viewer:', data.from);
            handleOffer(data.offer, data.from);
            break;

        case 'answer':
            console.log('[NUI] Received answer from viewer:', data.from);
            handleAnswer(data.answer, data.from);
            break;

        case 'ice-candidate':
            console.log('[NUI] Received ICE candidate from viewer:', data.from);
            handleIceCandidate(data.candidate, data.from);
            break;

        case 'viewer-left':
            console.log('[NUI] Viewer left:', data.viewerId);
            break;

        case 'error':
            console.error('[NUI] Server error:', data.message);
            notifyError(data.message);
            break;
    }
}

// WebRTC peer connection management
function createPeerConnection(viewerId) {
    console.log('[NUI] Creating peer connection for viewer:', viewerId);

    // Close existing peer connection if any
    if (peerConnection) {
        console.log('[NUI] Closing existing peer connection');
        peerConnection.close();
    }

    peerConnection = new RTCPeerConnection({
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ]
    });

    // Add local stream with enhanced debugging
    if (localStream) {
        console.log('[NUI] Local stream available:', localStream);
        console.log('[NUI] Local stream tracks:', localStream.getTracks().length);

        localStream.getTracks().forEach((track, index) => {
            console.log(`[NUI] Adding track ${index}: ${track.kind}, enabled: ${track.enabled}, readyState: ${track.readyState}`);
            const sender = peerConnection.addTrack(track, localStream);
            console.log('[NUI] Track sender:', sender);

            // Apply encoding parameters for video tracks
            if (track.kind === 'video') {
                const params = sender.getParameters();
                if (!params.encodings) params.encodings = [{}];

                // High quality encoding settings - aggressive quality
                const targetBitrate = Math.min(streamConfig.quality?.bitrate || 8000000, 20000000); // Increased cap to 20 Mbps
                params.encodings[0].maxBitrate = targetBitrate;
                params.encodings[0].minBitrate = Math.floor(targetBitrate * 0.9); // Maintain 90% of max bitrate for consistent quality
                params.encodings[0].startBitrate = targetBitrate; // Start at max bitrate immediately
                params.encodings[0].scaleResolutionDownBy = 1; // No downscaling
                params.encodings[0].maxFramerate = streamConfig.quality?.fps || 60;
                params.encodings[0].priority = 'high'; // High priority encoding

                sender.setParameters(params).then(() => {
                    console.log(`[NUI] Applied encoding parameters: bitrate=${params.encodings[0].maxBitrate}, fps=${params.encodings[0].maxFramerate}`);
                }).catch(err => {
                    console.warn('[NUI] Failed to set encoding parameters:', err);
                });
            }
        });

        // Verify tracks were added
        const senders = peerConnection.getSenders();
        console.log('[NUI] Peer connection senders:', senders.length);
    } else {
        console.error('[NUI] No local stream available for peer connection!');
    }

    // Handle ICE candidates
    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            console.log('[NUI] Sending ICE candidate to viewer:', viewerId);
            websocket.send(JSON.stringify({
                type: 'ice-candidate',
                candidate: event.candidate,
                to: viewerId
            }));
        } else {
            console.log('[NUI] ICE gathering complete for viewer:', viewerId);
        }
    };

    peerConnection.onconnectionstatechange = () => {
        console.log('[NUI] Peer connection state:', peerConnection.connectionState);
    };

    peerConnection.oniceconnectionstatechange = () => {
        console.log('[NUI] ICE connection state:', peerConnection.iceConnectionState);
    };

    // Create offer for viewer with specific constraints
    const offerOptions = {
        offerToReceiveAudio: false,
        offerToReceiveVideo: true
    };

    peerConnection.createOffer(offerOptions)
        .then(offer => {
            console.log('[NUI] Created offer details:');
            console.log('- SDP length:', offer.sdp.length, 'characters');
            console.log('- Offer type:', offer.type);
            console.log('- For viewer:', viewerId);
            return peerConnection.setLocalDescription(offer);
        })
        .then(() => {
            const offerMessage = {
                type: 'offer',
                offer: peerConnection.localDescription,
                to: viewerId
            };
            websocket.send(JSON.stringify(offerMessage));
            console.log('[NUI] Sent offer message details:');
            console.log('- Message type:', offerMessage.type);
            console.log('- To viewer:', offerMessage.to);
            console.log('- Offer SDP length:', offerMessage.offer.sdp.length);
        })
        .catch(error => {
            console.error('[NUI] Error creating offer details:');
            console.error('- Error message:', error.message);
            console.error('- Error name:', error.name);
            console.error('- Full error:', error);
        });
}

function handleOffer(offer, from) {
    console.log('[NUI] Handling offer from:', from);

    if (!peerConnection) {
        createPeerConnection(from);
    }

    peerConnection.setRemoteDescription(new RTCSessionDescription(offer))
        .then(() => {
            return peerConnection.createAnswer();
        })
        .then(answer => {
            return peerConnection.setLocalDescription(answer);
        })
        .then(() => {
            websocket.send(JSON.stringify({
                type: 'answer',
                answer: peerConnection.localDescription,
                to: from
            }));
            console.log('[NUI] Sent answer to:', from);
        })
        .catch(error => {
            console.error('[NUI] Error handling offer:', error);
        });
}

function handleAnswer(answer, from) {
    console.log('[NUI] Handling answer from:', from);

    if (peerConnection) {
        peerConnection.setRemoteDescription(new RTCSessionDescription(answer))
            .catch(error => {
                console.error('[NUI] Error setting remote description:', error);
            });
    }
}

function handleIceCandidate(candidate, from) {
    console.log('[NUI] Handling ICE candidate from:', from);

    if (peerConnection) {
        peerConnection.addIceCandidate(new RTCIceCandidate(candidate))
            .catch(error => {
                console.error('[NUI] Error adding ICE candidate:', error);
            });
    }
}

async function startStream(config) {
    console.log(`[NUI] ========== STARTING STREAM ==========`);
    console.log(`[NUI] Stream ID: ${config?.streamId}`);
    console.log(`[NUI] Stream Key: ${config?.streamKey}`);
    debugLog('Starting stream capture');

    if (!config || !config.streamId) {
        console.error('[NUI] ERROR: Invalid config provided to startStream', config);
        return;
    }

    if (streamInitializationInProgress) {
        debugLog('Stream initialization already in progress');
        return;
    }

    if (isStreaming && streamConfig && streamConfig.streamId === config.streamId) {
        debugLog('Stream already running for this ID');
        return;
    }

    streamInitializationInProgress = true;

    try {
        if (isStreaming) {
            debugLog('Stopping existing stream');
            stopStream();
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        streamConfig = config;
        isStreaming = true;
        updateDebug('streamId', config.streamId);

        // Get canvas
        console.log(`[NUI] Looking for canvas element 'stream-canvas'`);
        const canvas = document.getElementById('stream-canvas');
        if (!canvas) {
            console.error(`[NUI] ERROR: Canvas element 'stream-canvas' not found!`);
            throw new Error('Canvas element not found');
        }
        console.log(`[NUI] Canvas found:`, canvas);

        // Set canvas size - no DPI scaling to avoid blur
        const width = config.quality?.width || 1920;
        const height = config.quality?.height || 1080;

        console.log(`[NUI] Setting canvas size: ${width}x${height}`);
        canvas.width = width;
        canvas.height = height;
        canvas.style.width = width + 'px';
        canvas.style.height = height + 'px';

        // Create renderer
        console.log(`[NUI] Creating CfxGameViewRenderer...`);
        let MainRender = new CfxGameViewRenderer(canvas);
        MainRender.resize(width, height);
        console.log(`[NUI] Renderer created and resized successfully`);

        // Keep canvas hidden but functional for WebGL rendering
        canvas.style.visibility = 'hidden';
        canvas.style.display = 'block';
        canvas.style.position = 'absolute';
        canvas.style.top = '0px';
        canvas.style.left = '0px';
        canvas.style.zIndex = '-1000';
        console.log(`[NUI] Canvas configured for background rendering`);

        // Wait for rendering to stabilize
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Capture stream at native resolution
        console.log(`[NUI] Attempting canvas.captureStream...`);
        try {
            const targetFPS = config.quality?.fps || 60;
            console.log(`[NUI] Trying captureStream at ${targetFPS} FPS`);
            localStream = canvas.captureStream(targetFPS);
            console.log(`[NUI] captureStream successful at ${targetFPS} FPS`);
        } catch (e1) {
            console.log(`[NUI] captureStream failed, trying mozCaptureStream:`, e1);
            try {
                localStream = canvas.mozCaptureStream(targetFPS);
                console.log(`[NUI] mozCaptureStream successful`);
            } catch (e2) {
                console.error(`[NUI] Both capture methods failed:`, e2);
                throw new Error('Failed to capture canvas stream');
            }
        }

        // Verify stream has tracks
        const videoTracks = localStream.getVideoTracks();
        console.log(`[NUI] Stream verification - Video tracks: ${videoTracks.length}`);

        if (videoTracks.length === 0) {
            console.log(`[NUI] No video tracks found - creating test pattern`);
            createTestPattern(canvas);
            await new Promise(resolve => setTimeout(resolve, 500));
            localStream = canvas.captureStream(30);

            const newTracks = localStream.getVideoTracks();
            console.log(`[NUI] Test pattern tracks: ${newTracks.length}`);
            if (newTracks.length === 0) {
                throw new Error('No video track available');
            }
        } else {
            console.log(`[NUI] Video tracks found successfully`);
            videoTracks.forEach((track, index) => {
                console.log(`[NUI] Track ${index}: enabled=${track.enabled}, readyState=${track.readyState}, kind=${track.kind}`);
            });
        }

        // Connect to RTC server
        await connectToRTCServer();

        // Notify that stream started
        notifyStreamStarted();

        debugLog('Stream initialization complete');

    } catch (error) {
        console.error('[NUI] Stream initialization error details:');
        console.error('- Error type:', typeof error);
        console.error('- Error message:', error.message || 'No message');
        console.error('- Error name:', error.name || 'No name');
        console.error('- Error stack:', error.stack || 'No stack');
        console.error('- Full error object:', error);
        notifyError(error.message || error.toString());
        stopStream();
    } finally {
        streamInitializationInProgress = false;
    }
}

function createTestPattern(canvas) {
    console.log(`[NUI] Creating test pattern animation`);
    const ctx = canvas.getContext('2d');
    let hue = 0;

    const animate = () => {
        if (!isStreaming) return;

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

    console.log(`[NUI] Test pattern animation started`);
    animate();
}

function stopStream() {
    debugLog('Stopping stream');
    isStreaming = false;

    // Close WebRTC connection
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }

    // Close WebSocket connection
    if (websocket) {
        websocket.close();
        websocket = null;
    }

    if (localStream) {
        localStream.getTracks().forEach(track => {
            try {
                track.stop();
            } catch (e) {
                debugLog('Error stopping track: ' + e);
            }
        });
        localStream = null;
    }


    updateDebug('status', 'Stopped');
    updateDebug('streamId', '-');
    streamConfig = null;
    clientId = null;

    // Clear canvas
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

// Notification functions
function notifyStreamStarted() {
    console.log(`[NUI] Notifying server that stream started`);
    fetch(`http://redm_utk_streamer/streamStarted`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            streamId: streamConfig.streamId,
            streamKey: streamConfig.streamKey || streamConfig.streamId,
            status: 'started'
        })
    }).then(() => {
        console.log(`[NUI] Successfully notified server of stream start`);
    }).catch(err => console.error('[NUI] Failed to notify stream started:', err));
}

function notifyError(error) {
    fetch(`http://redm_utk_streamer/streamError`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: error })
    }).catch(err => console.error('Failed to notify error:', err));
}

// Auto cleanup on page unload
window.addEventListener('beforeunload', () => {
    if (isStreaming) {
        stopStream();
    }
});

debugLog('Stream capture script loaded');