local activeStreams = {}
local streamStats = {}

-- Helper function for media server API calls
local function CallMediaServer(endpoint, method, data, callback)
    local url = Config.MediaServer.api_url .. endpoint
    local headers = {
        ["Content-Type"] = "application/json",
        ["X-API-Key"] = Config.MediaServer.api_key
    }
    
    PerformHttpRequest(url, function(statusCode, response, headers)
        if Config.Debug then
            print(string.format("^2[Media Server]^7 %s %s - Status: %d", method, endpoint, statusCode))
        end
        
        if callback then
            local success = statusCode == 200 or statusCode == 201
            local responseData = response and json.decode(response) or nil
            callback(success, responseData)
        end
    end, method, data and json.encode(data) or "{}", headers)
end

-- Initialize
CreateThread(function()
    Wait(5000)
    CallMediaServer("/health", "GET", nil, function(success, data)
        if success then
            print("^2[RedM Streamer]^7 Connected to media server")
        else
            print("^1[RedM Streamer]^7 Media server not available")
        end
    end)
end)

-- Start stream request (from admin or other resource)
-- In your server.lua, find the requestStream handler and make sure it includes streamKey:
local playerList = {}
CreateThread(function()
    while true do
        Wait(1000)
        
        -- Build current player list
        local players = {}
        for _, playerId in ipairs(GetPlayers()) do
            local name = GetPlayerName(playerId)
            local identifiers = GetPlayerIdentifiers(playerId)
            local ping = GetPlayerPing(playerId)
            
            table.insert(players, {
                id = playerId,
                name = name,
                ping = ping,
                identifiers = identifiers,
                streaming = activeStreams[tonumber(playerId)] ~= nil
            })
        end
        
        playerList = players
        
        -- Send to all connected monitoring panels via media server
        if #players > 0 then
            CallMediaServer("/players/update", "POST", {
                players = players,
                timestamp = os.time()
            })
        end
        
        -- Clean up dead streams
        for playerId, stream in pairs(activeStreams) do
            if not GetPlayerName(playerId) then
                -- Player disconnected, clean up stream
                print(string.format("^3[Cleanup]^7 Removing dead stream for disconnected player %d", playerId))
                
                CallMediaServer("/streams/" .. stream.streamId .. "/stop", "POST")
                activeStreams[playerId] = nil
            end
        end
    end
end)
RegisterNetEvent('redm_streamer:requestStream')
AddEventHandler('redm_streamer:requestStream', function(targetPlayerId, monitorId)
    local source = source
    
    -- Special handling for monitor panel requests
    if source == 0 or monitorId then
        source = -1 -- Monitor request
    end
    
    if not GetPlayerName(targetPlayerId) then
        if source > 0 then
            TriggerClientEvent('redm_streamer:notify', source, 'Player not found')
        end
        return
    end
    
    if activeStreams[targetPlayerId] then
        -- Stream already exists, just return the info
        local stream = activeStreams[targetPlayerId]
        
        if monitorId then
            -- Send stream info to monitor
            CallMediaServer("/monitor/assign", "POST", {
                monitorId = monitorId,
                streamId = stream.streamId,
                streamKey = stream.streamKey,
                playerName = GetPlayerName(targetPlayerId),
                playerId = targetPlayerId
            })
        end
        
        print(string.format("^2[Monitor]^7 Existing stream assigned to monitor %s", monitorId or "none"))
        return
    end
    
    local streamId = GenerateStreamId()
    
    -- Create stream on media server
    CallMediaServer("/streams/create", "POST", {
        streamId = streamId,
        playerId = targetPlayerId,
        playerName = GetPlayerName(targetPlayerId),
        expectedQuality = Config.StreamQuality,
        monitorId = monitorId
    }, function(success, data)
        if success and data then
            activeStreams[targetPlayerId] = {
                streamId = streamId,
                streamKey = data.streamKey,
                webrtcEndpoint = data.webrtcEndpoint,
                hlsUrl = data.hlsUrl or data.viewerUrl,
                startTime = os.time(),
                viewers = 0,
                monitorId = monitorId
            }
            
            -- Tell player to start streaming
            TriggerClientEvent('redm_streamer:startStream', targetPlayerId, {
                streamId = streamId,
                streamKey = data.streamKey,
                webrtcUrl = data.webrtcEndpoint or 'http://localhost:3000/webrtc',
                webSocketUrl = data.webSocketUrl or 'ws://localhost:3000/ws',
                stunServer = data.stunServer,
                turnServer = data.turnServer
            })
            
            print(string.format("^2[Monitor]^7 Stream started for player %s (ID: %s)", GetPlayerName(targetPlayerId), streamId))
        else
            print("^1[Monitor]^7 Failed to create stream")
        end
    end)
end)
-- Add this event handler for monitor-initiated stream requests
RegisterNetEvent('redm-streamer:monitorStreamRequest')
AddEventHandler('redm-streamer:monitorStreamRequest', function(data)
    local playerId = tonumber(data.playerId)
    local streamId = data.streamId
    local streamKey = data.streamKey
    local panelId = data.panelId
    
    print(string.format("[Monitor] Stream request for player %d via monitor panel %s", playerId, panelId))
    
    -- Check if player exists
    if not GetPlayerName(playerId) then
        print(string.format("[Monitor] Player %d not found", playerId))
        return
    end
    
    -- Create stream entry
    activeStreams[playerId] = {
        streamId = streamId,
        streamKey = streamKey,
        webrtcEndpoint = 'http://localhost:3000/webrtc',
        hlsUrl = string.format('http://localhost:3000/player/viewer.html?stream=%s', streamKey),
        startTime = os.time(),
        viewers = 0,
        monitorId = panelId
    }
    
    -- Tell player to start streaming
    TriggerClientEvent('redm-streamer:startStream', playerId, {
        streamId = streamId,
        streamKey = streamKey,
        webrtcUrl = 'http://localhost:3000/webrtc',
        webSocketUrl = 'ws://localhost:3000/ws',
        stunServer = 'stun:stun.l.google.com:19302'
    })
    
    print(string.format("[Monitor] Stream started for player %s (ID: %s)", GetPlayerName(playerId), streamId))
end)

-- Add WebSocket message handler for monitor requests
-- If you have a WebSocket connection to the media server, add this:
RegisterCommand('monitor-ws-handler', function()
    -- This would handle WebSocket messages from the media server
    -- Implementation depends on your WebSocket setup
end, false)

RegisterNetEvent('redm_streamer:stopStream')
AddEventHandler('redm_streamer:stopStream', function(targetPlayerId)
    local source = source
    
    -- Allow stopping by player ID
    local playerId = targetPlayerId or source
    
    if activeStreams[playerId] then
        local stream = activeStreams[playerId]
        
        -- Tell media server to stop
        CallMediaServer("/streams/" .. stream.streamId .. "/stop", "POST")
        
        -- Notify player
        TriggerClientEvent('redm_streamer:stopStream', playerId)
        
        -- Clean up
        activeStreams[playerId] = nil
        
        print(string.format("^2[Monitor]^7 Stream stopped for player %d", playerId))
    end
end)
-- Get stream stats
RegisterNetEvent('redm_streamer:getStats')
AddEventHandler('redm_streamer:getStats', function()
    local source = source
    
    if activeStreams[source] then
        CallMediaServer("/streams/" .. activeStreams[source].streamId .. "/stats", "GET", nil, 
        function(success, data)
            if success and data then
                TriggerClientEvent('redm_streamer:stats', source, data)
            end
        end)
    end
end)

-- Commands
RegisterCommand('streamplayer', function(source, args)
    local targetId = tonumber(args[1])
    
    if not targetId or not GetPlayerName(targetId) then
        if source == 0 then
            print("Usage: streamplayer <playerID>")
        else
            TriggerClientEvent('redm_streamer:notify', source, 'Usage: /streamplayer <playerID>')
        end
        return
    end
    
    TriggerEvent('redm_streamer:requestStream', targetId)
end, false)

RegisterCommand('streams', function(source)
    local count = 0
    for playerId, stream in pairs(activeStreams) do
        count = count + 1
        local duration = os.time() - stream.startTime
        local message = string.format("Player: %s | Stream: %s | Duration: %ds | HLS: %s",
            GetPlayerName(playerId), stream.streamId, duration, stream.hlsUrl)
        
        if source == 0 then
            print(message)
        else
            TriggerClientEvent('chat:addMessage', source, {
                args = {'[Streams]', message}
            })
        end
    end
    
    if count == 0 then
        if source == 0 then
            print("No active streams")
        else
            TriggerClientEvent('redm_streamer:notify', source, 'No active streams')
        end
    end
end, false)

RegisterNetEvent('redm_streamer:getMonitorData')
AddEventHandler('redm_streamer:getMonitorData', function()
    local source = source
    local data = {
        players = playerList,
        streams = {}
    }
    
    for playerId, stream in pairs(activeStreams) do
        table.insert(data.streams, {
            playerId = playerId,
            playerName = GetPlayerName(playerId),
            streamId = stream.streamId,
            streamKey = stream.streamKey,
            duration = os.time() - stream.startTime,
            viewers = stream.viewers
        })
    end
    
    if source > 0 then
        TriggerClientEvent('redm_streamer:monitorData', source, data)
    else
        print(json.encode(data))
    end
end)

-- Monitor commands
RegisterCommand('monitor', function(source, args)
    if source == 0 then
        print("^2[Monitor]^7 Open browser to: http://localhost:3000/monitor")
    else
        TriggerClientEvent('redm_streamer:notify', source, 'Monitor: http://localhost:3000/monitor')
    end
end, false)

-- Clean up on player drop
AddEventHandler('playerDropped', function()
    local playerId = source
    
    -- Clean up stream if exists
    if activeStreams[playerId] then
        local stream = activeStreams[playerId]
        
        print(string.format("^3[Cleanup]^7 Player %d dropped, cleaning stream %s", playerId, stream.streamId))
        
        -- Give 10 seconds for reconnect
        SetTimeout(10000, function()
            if activeStreams[playerId] and activeStreams[playerId].streamId == stream.streamId then
                CallMediaServer("streams/" .. stream.streamId .. "/stop", "POST")
                activeStreams[playerId] = nil
                print(string.format("^3[Cleanup]^7 Stream %s cleaned after timeout", stream.streamId))
            end
        end)
    end
end)

-- Heartbeat to clean dead streams
CreateThread(function()
    while true do
        Wait(30000) -- Every 30 seconds
        
        for playerId, stream in pairs(activeStreams) do
            -- Check if player still exists
            if not GetPlayerName(playerId) then
                print(string.format("^3[Cleanup]^7 Removing orphaned stream %s", stream.streamId))
                CallMediaServer("streams/" .. stream.streamId .. "/stop", "POST")
                activeStreams[playerId] = nil
            else
                -- Update stream stats
                CallMediaServer("streams/" .. stream.streamId .. "/heartbeat", "POST", {
                    playerId = playerId,
                    playerName = GetPlayerName(playerId),
                    uptime = os.time() - stream.startTime
                })
            end
        end
    end
end)

function GenerateStreamId()
    local chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
    local streamId = ''
    for i = 1, 12 do
        local randIndex = math.random(1, #chars)
        streamId = streamId .. string.sub(chars, randIndex, randIndex)
    end
    return streamId
end

function CallMediaServer(endpoint, method, data, callback)
    local url = Config.MediaServer.api_url .. endpoint
    local headers = {
        ["Content-Type"] = "application/json",
        ["X-API-Key"] = Config.MediaServer.api_key
    }
    
    PerformHttpRequest(url, function(statusCode, response, headers)
        if Config.Debug then
            print(string.format("^2[Media Server]^7 %s %s - Status: %d", method, endpoint, statusCode))
        end
        
        if callback then
            local success = statusCode == 200 or statusCode == 201
            local responseData = response and json.decode(response) or nil
            callback(success, responseData)
        end
    end, method, data and json.encode(data) or "{}", headers)
end