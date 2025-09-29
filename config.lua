Config = {}

-- Media Server Configuration
Config.MediaServer = {
    -- IMPORTANT: Change 'localhost' to your server's public IP address for remote clients
    -- Example: If your server IP is 192.168.1.100, use "http://192.168.1.100:3000"
    -- For production: Use your public/external IP address

    -- WebRTC ingest endpoint
    webrtc_url = "https://192.99.60.230:3443/webrtc",  -- HTTPS for secure streaming
    -- HLS output endpoint
    hls_url = "https://192.99.60.230:3443/hls",        -- HTTPS for secure streaming
    -- API endpoint
    api_url = "https://192.99.60.230:3443/api",        -- HTTPS for secure streaming
    api_key = "redm-media-server-key-2024",

    -- Server IP for WebSocket connections (change this to your server's IP)
    server_ip = "192.99.60.230"  -- Change to your actual server IP (e.g. "192.168.1.100" or public IP)
}

-- Stream Quality Settings (optimized for quality vs performance balance)
Config.StreamQuality = {
    width = 1920,
    height = 1080,
    fps = 60,                -- 60 FPS is optimal for most viewers
    bitrate = 25000000000000       -- 25 Mbps for maximum visual clarity
}

-- Quality Presets (uncomment one to use)
Config.QualityPresets = {
    -- Ultra High Quality (requires powerful hardware)
    ultra = {
        width = 1920, height = 1080, fps = 60, bitrate = 25000000
    },

    -- High Quality (recommended for most users)
    high = {
        width = 1920, height = 1080, fps = 60, bitrate = 8000000
    },

    -- Medium Quality (good performance/quality balance)
    medium = {
        width = 1600, height = 900, fps = 45, bitrate = 5000000
    },

    -- Low Quality (best performance, lower visual quality)
    low = {
        width = 1280, height = 720, fps = 30, bitrate = 3000000
    }
}

-- Debug
Config.Debug = true