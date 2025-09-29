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

-- Initialize and start polling for stream requests with auto-reconnection
local mediaServerConnected = false
local reconnectAttempts = 0
local maxReconnectAttempts = -1 -- Infinite attempts
local lastConnectionTime = 0
local connectionLostTime = 0
local heartbeatFailures = 0

CreateThread(function()
    Wait(5000)

    -- Send initial player list immediately on startup, don't wait for connection
    print("^2[RedM Streamer]^7 Sending initial player list...")
    CreateThread(function()
        Wait(2000) -- Small delay to let server start
        ForcePlayerListUpdate()
    end)

    local function attemptConnection()
        CallMediaServer("/health", "GET", nil, function(success, data)
            if success then
                if not mediaServerConnected then
                    print("^2[RedM Streamer]^7 Connected to media server")

                    -- If we were previously disconnected, restore player list
                    if connectionLostTime > 0 then
                        print("^2[RedM Streamer]^7 Reconnected! Restoring player list...")
                        -- Force immediate player list update
                        CreateThread(function()
                            Wait(1000) -- Give server time to be ready
                            ForcePlayerListUpdate()
                        end)
                        connectionLostTime = 0
                    end

                    mediaServerConnected = true
                    reconnectAttempts = 0
                    heartbeatFailures = 0
                    lastConnectionTime = GetGameTimer()
                end
            else
                if mediaServerConnected then
                    print("^3[RedM Streamer]^7 Lost connection to media server - attempting reconnection")
                    mediaServerConnected = false
                    connectionLostTime = GetGameTimer()
                end
                reconnectAttempts = reconnectAttempts + 1

                if reconnectAttempts <= 3 then
                    print("^1[RedM Streamer]^7 Media server not available (attempt " .. reconnectAttempts .. ")")
                elseif reconnectAttempts % 12 == 0 then -- Every minute (5s * 12 = 60s)
                    print("^1[RedM Streamer]^7 Still trying to reconnect to media server...")
                end
            end
        end)
    end

    -- Initial connection attempt
    attemptConnection()

    -- Start polling for stream requests (runs regardless of connection status)
    CreateThread(function()
        while true do
            Wait(5000) -- Poll every 5 seconds
            if mediaServerConnected then
                PollForStreamRequests()
            end
        end
    end)

    -- Enhanced connection monitoring with heartbeat
    CreateThread(function()
        while true do
            Wait(5000) -- Check every 5 seconds
            attemptConnection()

            -- Additional heartbeat check if connected
            if mediaServerConnected then
                local currentTime = GetGameTimer()
                -- If no successful connection in last 30 seconds, force reconnection
                if currentTime - lastConnectionTime > 30000 then
                    heartbeatFailures = heartbeatFailures + 1
                    if heartbeatFailures > 3 then
                        print("^3[RedM Streamer]^7 Heartbeat failed, forcing reconnection...")
                        mediaServerConnected = false
                        heartbeatFailures = 0
                    end
                end
            end
        end
    end)

    -- Connection restoration monitor
    CreateThread(function()
        while true do
            Wait(10000) -- Check every 10 seconds

            -- If we've been disconnected for more than 60 seconds, try full restoration
            if connectionLostTime > 0 and (GetGameTimer() - connectionLostTime) > 60000 then
                print("^3[RedM Streamer]^7 Attempting full connection restoration...")

                -- Clear any stuck states
                for playerId, stream in pairs(activeStreams) do
                    print("^3[RedM Streamer]^7 Cleaning up orphaned stream for player " .. playerId)
                    activeStreams[playerId] = nil
                end

                -- Force reconnection attempt
                mediaServerConnected = false
                reconnectAttempts = 0
                connectionLostTime = 0
            end
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

-- Existing playerList tracking
local playerList = {}
local lastPlayerListHash = ""

-- Force player list update (used for reconnection)
function ForcePlayerListUpdate()
    print("^2[RedM Streamer]^7 Forcing player list update...")

    -- Build current player list
    local players = {}
    local playersOnline = GetPlayers()

    for i = 1, #playersOnline do
        local playerId = playersOnline[i]
        local name = GetPlayerName(playerId)

        if name then
            table.insert(players, {
                id = playerId,
                name = name,
                ping = GetPlayerPing(playerId),
                streaming = activeStreams[tonumber(playerId)] ~= nil
            })
        end
    end

    -- Force send update regardless of hash
    playerList = players
    lastPlayerListHash = "" -- Reset hash to force update

    CallMediaServer("/players/update", "POST", {
        players = players,
        timestamp = os.time()
    }, function(success, data)
        if Config.Debug then
            print(string.format("^2[Force Player Update]^7 Sent %d players - Success: %s", #players, tostring(success)))
        end
    end)
end

CreateThread(function()
    while true do
        Wait(3000) -- More frequent: every 3 seconds for better responsiveness

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

        -- Send updates more frequently - both when changed AND periodically
        local shouldSend = false
        local currentTime = os.time()

        if simpleHash ~= lastPlayerListHash then
            shouldSend = true -- Send when changed
        elseif (currentTime % 15) == 0 then -- Also send every 15 seconds regardless
            shouldSend = true
        end

        if shouldSend then
            playerList = players
            lastPlayerListHash = simpleHash

            -- Always attempt to send, regardless of connection status
            CallMediaServer("/players/update", "POST", {
                players = players,
                timestamp = currentTime
            }, function(success, data)
                if Config.Debug then
                    print(string.format("^2[Player Update]^7 Sent %d players - Success: %s", #players, tostring(success)))
                end

                -- If successful and we weren't connected, mark as connected
                if success and not mediaServerConnected then
                    print("^2[RedM Streamer]^7 Connection restored via player update")
                    mediaServerConnected = true
                    reconnectAttempts = 0
                    heartbeatFailures = 0
                    lastConnectionTime = GetGameTimer()
                end
            end)
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
RegisterNetEvent('redm_utk_streamer:requestStream')
AddEventHandler('redm_utk_streamer:requestStream', function(targetPlayerId, monitorId)
    local source = source

    if source == 0 or monitorId then
        source = -1 -- Monitor request
    end

    if not GetPlayerName(targetPlayerId) then
        if source > 0 then
            TriggerClientEvent('redm_utk_streamer:notify', source, 'Player not found')
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

            TriggerClientEvent('redm_utk_streamer:initStream', targetPlayerId, {
                streamId = streamId,
                streamKey = data.streamKey,
                quality = Config.StreamQuality
            })

            print(string.format("^2[Monitor]^7 Stream started for player %s (ID: %s)", GetPlayerName(targetPlayerId), streamId))
        else
            print("^1[Monitor]^7 Failed to create stream")
        end
    end)
end)

-- Stop stream
RegisterNetEvent('redm_utk_streamer:stopStream')
AddEventHandler('redm_utk_streamer:stopStream', function(targetPlayerId)
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
        TriggerClientEvent('redm_utk_streamer:stopStream', playerId)

        -- Wait a bit then clean up
        SetTimeout(1000, function()
            activeStreams[playerId] = nil
        end)

        print(string.format("^2[Monitor]^7 Stream force stopped for player %d", playerId))
    end
end)

-- Get stream stats
RegisterNetEvent('redm_utk_streamer:getStats')
AddEventHandler('redm_utk_streamer:getStats', function()
    local source = source

    if activeStreams[source] then
        CallMediaServer("/streams/" .. activeStreams[source].streamId .. "/stats", "GET", nil,
        function(success, data)
            if success and data then
                TriggerClientEvent('redm_utk_streamer:stats', source, data)
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
            TriggerClientEvent('redm_utk_streamer:notify', source, 'Usage: /streamplayer <playerID>')
        end
        return
    end

    TriggerEvent('redm_utk_streamer:requestStream', targetId)
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
            TriggerClientEvent('redm_utk_streamer:notify', source, 'No active streams')
        end
    end
end, false)

-- Monitor commands
RegisterCommand('monitor', function(source, args)
    if source == 0 then
        print("^2[Monitor]^7 Open browser to: http://localhost:3000/monitor")
    else
        TriggerClientEvent('redm_utk_streamer:notify', source, 'Monitor: http://localhost:3000/monitor')
    end
end, false)

-- Reconnection command
RegisterCommand('reconnect_streamer', function(source, args)
    if source == 0 then
        print("^3[RedM Streamer]^7 Forcing reconnection to media server...")
        mediaServerConnected = false
        reconnectAttempts = 0
        connectionLostTime = 0
        heartbeatFailures = 0

        -- Force immediate reconnection attempt
        CreateThread(function()
            Wait(1000)
            ForcePlayerListUpdate()
        end)

        print("^2[RedM Streamer]^7 Reconnection initiated")
    else
        TriggerClientEvent('redm_utk_streamer:notify', source, 'Only console can use this command')
    end
end, false)

-- Status command
RegisterCommand('streamer_status', function(source, args)
    local message = string.format("^2[RedM Streamer Status]^7\nConnected: %s\nReconnect attempts: %d\nActive streams: %d\nHeartbeat failures: %d",
        tostring(mediaServerConnected), reconnectAttempts, GetTableLength(activeStreams), heartbeatFailures)

    if source == 0 then
        print(message)
    else
        TriggerClientEvent('redm_utk_streamer:notify', source, message)
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

-- Helper function to get table length
function GetTableLength(t)
    local count = 0
    for _ in pairs(t) do
        count = count + 1
    end
    return count
end

-- Handle stream events from client NUI
RegisterNetEvent('redm_utk_streamer:streamStarted')
AddEventHandler('redm_utk_streamer:streamStarted', function(data)
    local src = source
    local playerId = src

    if Config.Debug then
        print(string.format("^2[Stream Started]^7 Player %d started streaming (Direct WebRTC)", playerId))
    end

    if activeStreams[playerId] then
        local stream = activeStreams[playerId]
        stream.status = 'active'
        stream.clientConnected = true

        -- Notify media server that stream is active
        CallMediaServer("/monitor/stream-started", "POST", {
            playerId = playerId,
            streamId = stream.streamId,
            streamKey = stream.streamKey,
            panelId = stream.panelId,
            playerName = GetPlayerName(playerId),
            status = 'streaming'
        })
    end
end)

RegisterNetEvent('redm_utk_streamer:streamError')
AddEventHandler('redm_utk_streamer:streamError', function(data)
    local src = source
    local playerId = src

    print(string.format("^1[Stream Error]^7 Player %d stream error: %s", playerId, data.error or "unknown"))

    if activeStreams[playerId] then
        local stream = activeStreams[playerId]

        -- Notify media server of error
        CallMediaServer("/monitor/stream-ended", "POST", {
            playerId = playerId,
            streamId = stream.streamId,
            streamKey = stream.streamKey,
            reason = "stream_error",
            error = data.error
        })

        activeStreams[playerId] = nil
    end
end)

-- Handle stream request
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
        TriggerClientEvent('redm_utk_streamer:stopStream', playerId)

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
        startTime = os.time(),
        viewers = 0,
        panelId = panelId,
        status = 'pending',
        clientConnected = false,
        lastActivity = GetGameTimer()
    }

    -- Tell player to start streaming (client will handle capture and direct WebRTC)
    TriggerClientEvent('redm_utk_streamer:initStream', playerId, {
        streamId = streamId,
        streamKey = streamKey,
        quality = Config.StreamQuality
    })

    print(string.format("^2[Stream Request]^7 Stream initialization started for %s", GetPlayerName(playerId)))
end

print("^2[RedM Streamer]^7 Simplified server initialized")
print("^2[Direct WebRTC]^7 NUI connects directly to RTC server")