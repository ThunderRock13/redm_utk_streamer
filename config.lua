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

-- Stream Quality Settings
Config.StreamQuality = {
    width = 1920,
    height = 1080,
    fps = 120,
    bitrate = 2500000000000
}

-- Debug
Config.Debug = true