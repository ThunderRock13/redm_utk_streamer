Config = {}

-- Media Server Configuration
Config.MediaServer = {
    -- WebRTC ingest endpoint
    webrtc_url = "http://localhost:3000/webrtc",
    -- HLS output endpoint  
    hls_url = "http://localhost:3000/hls",
    -- API endpoint
    api_url = "http://localhost:3000/api",
    api_key = "redm-media-server-key-2024"
}

-- Stream Quality Settings (optimized for quality vs performance balance)
Config.StreamQuality = {
    width = 1920,
    height = 1080,
    fps = 60,                -- 60 FPS is optimal for most viewers
    bitrate = 25000000       -- 25 Mbps for maximum visual clarity
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