Config = {}

-- Server Configuration
Config.Server = {
    -- Set this to your server's external IP for remote access
    -- Use "localhost" for local testing only
    hostname = "192.99.60.230", -- Change this to your server IP
    port = "3000",
    -- Use secure WebSocket for HTTPS contexts (RedM NUI)
    secure_websocket = false -- Disabled until SSL certificates are set up
}

-- Media Server Configuration
Config.MediaServer = {
    -- WebRTC ingest endpoint
    webrtc_url = string.format("http://%s:%s/webrtc", Config.Server.hostname, Config.Server.port),
    -- HLS output endpoint
    hls_url = string.format("http://%s:%s/hls", Config.Server.hostname, Config.Server.port),
    -- API endpoint
    api_url = string.format("http://%s:%s/api", Config.Server.hostname, Config.Server.port),
    api_key = "redm-media-server-key-2024"
}

-- Stream Quality Settings
Config.StreamQuality = {
    width = 1920,
    height = 1080,
    fps = 120,
    bitrate = 2500000000
}

-- Debug
Config.Debug = true -- Temporarily enabled for troubleshooting