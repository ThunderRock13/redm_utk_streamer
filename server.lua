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
RegisterNetEvent('redm_streamer:requestStream')
AddEventHandler('redm_streamer:requestStream', function(targetPlayerId)
    local source = source
    
    if not GetPlayerName(targetPlayerId) then
        TriggerClientEvent('redm_streamer:notify', source, 'Player not found')
        return
    end
    
    if activeStreams[targetPlayerId] then
        TriggerClientEvent('redm_streamer:notify', source, 'Player already streaming')
        return
    end
    
    local streamId = GenerateStreamId()
    
    -- Request media server to prepare for incoming stream
    CallMediaServer("/streams/create", "POST", {
        streamId = streamId,
        playerId = targetPlayerId,
        playerName = GetPlayerName(targetPlayerId),
        expectedQuality = Config.StreamQuality
    }, function(success, data)
        if success and data then
            activeStreams[targetPlayerId] = {
                streamId = streamId,
                webrtcEndpoint = data.webrtcEndpoint,
                hlsUrl = data.hlsUrl,
                startTime = os.time(),
                viewers = 0
            }
            
            -- Tell player to start streaming
            TriggerClientEvent('redm_streamer:startStream', targetPlayerId, {
                streamId = streamId,
                webrtcUrl = data.webrtcEndpoint,
                stunServer = data.stunServer,
                turnServer = data.turnServer
            })
            
            print(string.format("^2[Streamer]^7 Stream started: %s", streamId))
            print(string.format("^2[Streamer]^7 HLS URL: %s", data.hlsUrl))
            
            -- Notify requester with viewing URL
            if source ~= 0 and source ~= targetPlayerId then
                TriggerClientEvent('redm_streamer:viewUrl', source, {
                    streamId = streamId,
                    hlsUrl = data.hlsUrl,
                    playerName = GetPlayerName(targetPlayerId)
                })
            end
        else
            TriggerClientEvent('redm_streamer:notify', source, 'Failed to create stream')
        end
    end)
end)

-- Stop stream
RegisterNetEvent('redm_streamer:stopStream')
AddEventHandler('redm_streamer:stopStream', function()
    local source = source
    
    if activeStreams[source] then
        local stream = activeStreams[source]
        
        -- Tell media server to stop
        CallMediaServer("/streams/" .. stream.streamId .. "/stop", "POST")
        
        -- Clean up
        activeStreams[source] = nil
        
        -- Notify player
        TriggerClientEvent('redm_streamer:stopStream', source)
        
        print(string.format("^2[Streamer]^7 Stream stopped: %s", stream.streamId))
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

-- Player disconnect cleanup
AddEventHandler('playerDropped', function()
    local playerId = source
    if activeStreams[playerId] then
        TriggerEvent('redm_streamer:stopStream')
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