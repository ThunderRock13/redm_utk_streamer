// stream-relay.js - Capture and relay frames through game server
let isCapturing = false;
let streamId = null;
let captureInterval = null;
let frameId = 0;
let frameCount = 0;
let lastFpsTime = Date.now();
let renderer = null;
let canvas = null;
let localStream = null;

// CfxGameViewRenderer - utk_render integration
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
            preserveDrawingBuffer: true  // Important for capturing frames
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

        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            throw new Error('Failed to compile shaders');
        }
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
            varying vec2 textureCoordinate;
            void main() {
                gl_Position = vec4(a_position, 0.0, 1.0);
                textureCoordinate = a_texcoord;
            }
        `;

        const fragmentShaderSrc = `
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
        
        // Magic hook sequence for utk_render
        gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
        gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
        gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        return tex;
    }

    #createBuffers(gl) {
        const vertexBuff = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuff);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

        const texBuff = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, texBuff);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 1, 1, 1, 0, 0, 1, 0]), gl.STATIC_DRAW);

        return { vertexBuff, texBuff };
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
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        }
        this.#animationFrame = requestAnimationFrame(this.#render);
    };
}

// Listen for messages from game
window.addEventListener('message', async (event) => {
    const data = event.data;
    
    console.log('[Relay] Message received:', data.action);
    
    switch(data.action) {
        case 'START_CAPTURE':
            startCapture(data);
            break;
        case 'STOP_CAPTURE':
            stopCapture();
            break;
    }
});

async function startCapture(config) {
    if (isCapturing) {
        console.log('[Relay] Already capturing');
        return;
    }
    
    console.log('[Relay] Starting capture:', config.streamId);
    
    isCapturing = true;
    streamId = config.streamId;
    frameId = 0;
    frameCount = 0;
    
    updateDebug('status', 'Starting...');
    
    try {
        // Get canvas
        canvas = document.getElementById('stream-canvas');
        if (!canvas) {
            throw new Error('Canvas not found');
        }
        
        canvas.width = config.quality?.width || 1920;
        canvas.height = config.quality?.height || 1080;
        
        console.log('[Relay] Canvas configured:', canvas.width, 'x', canvas.height);
        
        // Initialize renderer
        renderer = new CfxGameViewRenderer(canvas);
        console.log('[Relay] Renderer initialized');
        
        // Wait for rendering to stabilize
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Create media stream for local processing
        localStream = canvas.captureStream(config.quality?.fps || 30);
        
        // Verify we have video
        const videoTracks = localStream.getVideoTracks();
        if (videoTracks.length === 0) {
            throw new Error('No video track available');
        }
        
        console.log('[Relay] Stream ready, starting frame capture');
        
        // Notify game that capture started
        fetch(`https://${GetParentResourceName()}/captureStarted`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                width: canvas.width,
                height: canvas.height,
                fps: config.quality?.fps || 30
            })
        });
        
        updateDebug('status', 'Capturing');
        
        // Start capturing frames
        startFrameCapture(config.quality?.fps || 30);
        
    } catch (error) {
        console.error('[Relay] Error starting capture:', error);
        updateDebug('status', 'Error');
        
        fetch(`https://${GetParentResourceName()}/captureError`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: error.message })
        });
        
        stopCapture();
    }
}

function startFrameCapture(targetFps) {
    const frameInterval = 1000 / targetFps;
    let lastFrameTime = Date.now();
    
    // Use requestAnimationFrame for smooth capture
    const captureFrame = () => {
        if (!isCapturing) return;
        
        const now = Date.now();
        const delta = now - lastFrameTime;
        
        if (delta >= frameInterval) {
            lastFrameTime = now;
            
            try {
                // Capture frame as base64
                canvas.toBlob((blob) => {
                    if (blob && isCapturing) {
                        const reader = new FileReader();
                        reader.onloadend = () => {
                            const base64 = reader.result;
                            
                            // Send frame to game
                            fetch(`https://${GetParentResourceName()}/frameReady`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    frame: base64,
                                    frameId: frameId++,
                                    timestamp: now
                                })
                            });
                            
                            frameCount++;
                            updateFPS();
                        };
                        reader.readAsDataURL(blob);
                    }
                }, 'image/jpeg', 0.8); // JPEG with 80% quality for smaller size
                
            } catch (error) {
                console.error('[Relay] Frame capture error:', error);
            }
        }
        
        requestAnimationFrame(captureFrame);
    };
    
    captureFrame();
}

function stopCapture() {
    console.log('[Relay] Stopping capture');
    
    isCapturing = false;
    streamId = null;
    
    if (captureInterval) {
        clearInterval(captureInterval);
        captureInterval = null;
    }
    
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    
    if (renderer) {
        renderer.destroy();
        renderer = null;
    }
    
    updateDebug('status', 'Stopped');
    updateDebug('fps', '0');
    updateDebug('frameCount', '0');
}

function updateFPS() {
    const now = Date.now();
    const elapsed = now - lastFpsTime;
    
    if (elapsed >= 1000) {
        const fps = Math.round((frameCount * 1000) / elapsed);
        updateDebug('fps', fps);
        updateDebug('frameCount', frameCount);
        
        frameCount = 0;
        lastFpsTime = now;
    }
}

function updateDebug(field, value) {
    const el = document.getElementById(field);
    if (el) el.textContent = value;
    
    // Show debug panel
    const debug = document.getElementById('debug');
    if (debug && !debug.classList.contains('active')) {
        debug.classList.add('active');
    }
}

function GetParentResourceName() {
    return window.GetParentResourceName ? window.GetParentResourceName() : 'redm_streamer';
}

console.log('[Relay] Stream relay script loaded');