local activeStreams = {}
local streamStats = {}
local pendingStreamRequests = {}

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

-- Initialize and start polling for stream requests
CreateThread(function()
    Wait(5000)
    CallMediaServer("/health", "GET", nil, function(success, data)
        if success then
            print("^2[RedM Streamer]^7 Connected to media server")
            -- Start polling for stream requests
            CreateThread(function()
                while true do
                    Wait(5000) -- Poll every 5 seconds
                    PollForStreamRequests()
                end
            end)
        else
            print("^1[RedM Streamer]^7 Media server not available")
        end
    end)
end)

-- Poll for stream requests from the media server
function PollForStreamRequests()
    CallMediaServer("/monitor/pending-requests", "GET", nil, function(success, data)
        if success and data and data.requests then
            for _, request in ipairs(data.requests) do
                HandleStreamRequest(request)
            end
        end
    end)
end

-- Handle a stream request
function HandleStreamRequest(request)
    local playerId = tonumber(request.playerId)
    local streamId = request.streamId
    local streamKey = request.streamKey
    local panelId = request.panelId

    if not GetPlayerName(playerId) then
        print(string.format("^1[Stream Request]^7 Player %d not found", playerId))
        return
    end

    -- Check if already streaming - force cleanup and restart if needed
    if activeStreams[playerId] then
        print(string.format("^3[Stream Request]^7 Player %d already streaming - cleaning up for restart", playerId))

        -- Stop the existing stream first
        TriggerClientEvent('redm_streamer:stopStream', playerId)

        -- Clean up immediately to allow restart
        activeStreams[playerId] = nil

        -- Wait a moment for cleanup to complete
        Wait(500)
    end
    
    print(string.format("^2[Stream Request]^7 Starting stream for player %d (ID: %s)", playerId, streamId))
    
    -- Create stream entry
    activeStreams[playerId] = {
        streamId = streamId,
        streamKey = streamKey,
        webrtcEndpoint = 'http://localhost:3000/webrtc',
        hlsUrl = string.format('http://localhost:3000/player/viewer.html?stream=%s', streamKey),
        startTime = os.time(),
        viewers = 0,
        panelId = panelId
    }
    
    -- Tell player to start streaming
    TriggerClientEvent('redm_streamer:startStream', playerId, {
        streamId = streamId,
        streamKey = streamKey,
        webrtcUrl = 'http://localhost:3000/webrtc',
        webSocketUrl = 'ws://localhost:3000/ws',
        stunServer = 'stun:stun.l.google.com:19302'
    })
    
    -- Notify media server that stream was started
    CallMediaServer("/monitor/stream-started", "POST", {
        playerId = playerId,
        streamId = streamId,
        streamKey = streamKey,
        panelId = panelId,
        playerName = GetPlayerName(playerId)
    })
    
    print(string.format("^2[Stream Request]^7 Stream started for %s", GetPlayerName(playerId)))
end

-- Existing playerList tracking
local playerList = {}
local lastPlayerListHash = ""

CreateThread(function()
    while true do
        Wait(30000) -- Further reduced frequency: every 30 seconds

        -- Build lightweight player list - avoid expensive operations
        local players = {}
        local playersOnline = GetPlayers()

        for i = 1, #playersOnline do
            local playerId = playersOnline[i]
            local name = GetPlayerName(playerId)

            if name then -- Only include if player still exists
                table.insert(players, {
                    id = playerId,
                    name = name,
                    ping = GetPlayerPing(playerId),
                    streaming = activeStreams[tonumber(playerId)] ~= nil
                })
            end
        end

        -- Simple hash check using player count and streaming status
        local streamingStates = {}
        for _, p in ipairs(players) do
            table.insert(streamingStates, p.streaming and "1" or "0")
        end
        local simpleHash = #players .. ":" .. table.concat(streamingStates, ",")
        if simpleHash ~= lastPlayerListHash then
            playerList = players
            lastPlayerListHash = simpleHash

            -- Send minimal update
            if #players > 0 then
                CallMediaServer("/players/update", "POST", {
                    players = players,
                    timestamp = os.time()
                })
            end
        end
        
        -- Clean up dead streams
        for playerId, stream in pairs(activeStreams) do
            if not GetPlayerName(playerId) then
                print(string.format("^3[Cleanup]^7 Removing dead stream for disconnected player %d", playerId))
                
                -- Notify media server
                CallMediaServer("/monitor/stream-ended", "POST", {
                    playerId = playerId,
                    streamId = stream.streamId,
                    streamKey = stream.streamKey,
                    reason = "player_disconnected"
                })
                
                activeStreams[playerId] = nil
            end
        end
    end
end)

-- Handle manual stream requests (existing functionality)
RegisterNetEvent('redm_streamer:requestStream')
AddEventHandler('redm_streamer:requestStream', function(targetPlayerId, monitorId)
    local source = source
    
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
        local stream = activeStreams[targetPlayerId]
        if monitorId then
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

-- Stop stream
RegisterNetEvent('redm_streamer:stopStream')
AddEventHandler('redm_streamer:stopStream', function(targetPlayerId)
    local source = source
    local playerId = targetPlayerId or source

    if activeStreams[playerId] then
        local stream = activeStreams[playerId]

        -- Force notify media server multiple times to ensure cleanup
        CallMediaServer("/monitor/stream-ended", "POST", {
            playerId = playerId,
            streamId = stream.streamId,
            streamKey = stream.streamKey,
            reason = "manual_stop"
        })

        -- Also send cleanup request
        CallMediaServer("/streams/" .. stream.streamId .. "/stop", "POST", {
            playerId = playerId,
            reason = "force_stop"
        })

        -- Notify player with force stop
        TriggerClientEvent('redm_streamer:stopStream', playerId)

        -- Wait a bit then clean up
        SetTimeout(1000, function()
            activeStreams[playerId] = nil
        end)

        print(string.format("^2[Monitor]^7 Stream force stopped for player %d", playerId))
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

    if activeStreams[playerId] then
        local stream = activeStreams[playerId]

        print(string.format("^3[Cleanup]^7 Player %d dropped, immediately cleaning stream %s", playerId, stream.streamId))

        -- Immediate cleanup instead of waiting
        CallMediaServer("/monitor/stream-ended", "POST", {
            playerId = playerId,
            streamId = stream.streamId,
            streamKey = stream.streamKey,
            reason = "player_disconnected"
        })

        -- Also force cleanup via different endpoint
        CallMediaServer("/streams/" .. stream.streamId .. "/stop", "POST", {
            playerId = playerId,
            reason = "player_disconnected"
        })

        activeStreams[playerId] = nil
        print(string.format("^3[Cleanup]^7 Stream %s cleaned immediately", stream.streamId))
    end
end)

-- Heartbeat to clean dead streams
CreateThread(function()
    while true do
        Wait(30000) -- Every 30 seconds
        
        for playerId, stream in pairs(activeStreams) do
            if not GetPlayerName(playerId) then
                print(string.format("^3[Cleanup]^7 Removing orphaned stream %s", stream.streamId))
                CallMediaServer("/monitor/stream-ended", "POST", {
                    playerId = playerId,
                    streamId = stream.streamId,
                    streamKey = stream.streamKey,
                    reason = "player_not_found"
                })
                activeStreams[playerId] = nil
            else
                -- Update stream stats
                CallMediaServer("/streams/" .. stream.streamId .. "/heartbeat", "POST", {
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