local isStreaming = false
local currentStreamId = nil
local streamConfig = nil

-- Start streaming (triggered by server)
RegisterNetEvent('redm_streamer:startStream')
AddEventHandler('redm_streamer:startStream', function(config)
    if isStreaming then
        print("^1[Streamer]^7 Already streaming, stopping first")
        TriggerEvent('redm_streamer:stopStream')
        Wait(2000) -- Give time for cleanup
    end
    
    isStreaming = true
    currentStreamId = config.streamId
    streamConfig = config
    
    print(string.format("^2[Streamer]^7 Starting stream: %s", config.streamId))
    print(string.format("^2[Streamer]^7 WebSocket URL: %s", config.webSocketUrl or "Not set"))
    print(string.format("^2[Streamer]^7 Stream Key: %s", config.streamKey or "Not set"))
    
    -- Make sure NUI is ready
    Wait(1000)
    
    -- Send configuration to NUI with proper websocket URL
    local nuiMessage = {
        action = 'START_STREAM',
        streamId = config.streamId,
        streamKey = config.streamKey or config.streamId,
        webSocketUrl = config.webSocketUrl or 'ws://localhost:3000/ws',
        stunServer = config.stunServer or 'stun:stun.l.google.com:19302',
        turnServer = config.turnServer,
        quality = Config.StreamQuality
    }
    
    print("^2[Streamer]^7 Sending NUI message: " .. json.encode(nuiMessage))
    SendNUIMessage(nuiMessage)
    
    -- Show notification
    ShowNotification("~g~Stream Started~s~")
    ShowNotification("ID: " .. config.streamId)
    
    -- Update server with stream start
    TriggerServerEvent('redm_streamer:updateStats', {
        status = 'started',
        streamId = config.streamId,
        timestamp = GetGameTimer()
    })
end)

-- Stop streaming
RegisterNetEvent('redm_streamer:stopStream')
AddEventHandler('redm_streamer:stopStream', function()
    if not isStreaming then
        print("^3[Streamer]^7 Not streaming, ignoring stop request")
        return
    end
    
    print("^2[Streamer]^7 Stopping stream")
    
    -- Update server with stream stop
    if currentStreamId then
        TriggerServerEvent('redm_streamer:updateStats', {
            status = 'stopped',
            streamId = currentStreamId,
            timestamp = GetGameTimer()
        })
    end
    
    isStreaming = false
    currentStreamId = nil
    streamConfig = nil
    
    -- Tell NUI to stop
    SendNUIMessage({
        action = 'STOP_STREAM'
    })
    
    ShowNotification("~r~Stream Stopped~s~")
end)

-- Show view URL
RegisterNetEvent('redm_streamer:viewUrl')
AddEventHandler('redm_streamer:viewUrl', function(data)
    ShowNotification("~g~Stream Ready~s~")
    ShowNotification("Player: " .. data.playerName)
    ShowNotification("URL: " .. data.hlsUrl)
    print(string.format("^2[Viewer]^7 Watch at: %s", data.hlsUrl))
end)

-- Show stats
RegisterNetEvent('redm_streamer:stats')
AddEventHandler('redm_streamer:stats', function(stats)
    print("^2[Stream Stats]^7")
    print("Viewers: " .. (stats.viewers or 0))
    print("Bitrate: " .. (stats.bitrate or 0) .. " kbps")
    print("FPS: " .. (stats.fps or 0))
    print("Duration: " .. (stats.duration or 0) .. "ms")
end)

-- Notification
RegisterNetEvent('redm_streamer:notify')
AddEventHandler('redm_streamer:notify', function(message)
    ShowNotification(message)
end)

-- NUI Callbacks
RegisterNUICallback('streamStarted', function(data, cb)
    print("^2[Streamer]^7 NUI reports stream started successfully")
    print("^2[Streamer]^7 Stream Key: " .. (data.streamKey or "unknown"))
    
    -- Notify server that stream is ready
    TriggerServerEvent('redm_streamer:updateStats', {
        status = 'connected',
        streamId = data.streamId or currentStreamId,
        streamKey = data.streamKey,
        timestamp = GetGameTimer()
    })
    
    cb('ok')
end)

RegisterNUICallback('streamError', function(data, cb)
    print("^1[Streamer]^7 Stream error: " .. (data.error or "unknown"))
    
    -- Notify server about error
    TriggerServerEvent('redm_streamer:updateStats', {
        status = 'error',
        error = data.error,
        streamId = currentStreamId,
        timestamp = GetGameTimer()
    })
    
    -- Auto-stop on error
    if isStreaming then
        TriggerEvent('redm_streamer:stopStream')
    end
    
    cb('ok')
end)

RegisterNUICallback('streamStats', function(data, cb)
    -- Forward stats to server with additional info
    if isStreaming then
        local enhancedStats = data or {}
        enhancedStats.playerId = GetPlayerServerId(PlayerId())
        enhancedStats.playerName = GetPlayerName(PlayerId())
        enhancedStats.streamId = currentStreamId
        enhancedStats.timestamp = GetGameTimer()
        
        TriggerServerEvent('redm_streamer:updateStats', enhancedStats)
    end
    cb('ok')
end)

RegisterNUICallback('debugLog', function(data, cb)
    print("^3[NUI Debug]^7 " .. (data.message or ""))
    cb('ok')
end)

-- Commands
RegisterCommand('stopstream', function()
    if isStreaming then
        TriggerServerEvent('redm_streamer:stopStream')
    else
        ShowNotification("~r~Not streaming~s~")
    end
end, false)

RegisterCommand('streamstats', function()
    if isStreaming then
        TriggerServerEvent('redm_streamer:getStats')
    else
        ShowNotification("~r~Not streaming~s~")
    end
end, false)

-- Debug command to manually trigger stream (for testing)
RegisterCommand('teststream', function()
    if not isStreaming then
        local testConfig = {
            streamId = 'test_' .. GetGameTimer(),
            streamKey = 'test_key_' .. GetGameTimer(),
            webSocketUrl = 'ws://localhost:3000/ws',
            stunServer = 'stun:stun.l.google.com:19302',
            quality = Config.StreamQuality
        }
        TriggerEvent('redm_streamer:startStream', testConfig)
    else
        ShowNotification("~r~Already streaming~s~")
    end
end, false)

-- Check stream status command
RegisterCommand('streamstatus', function()
    if isStreaming then
        ShowNotification("~g~Streaming: " .. (currentStreamId or "Unknown"))
        print("^2[Stream Status]^7 Currently streaming:")
        print("Stream ID: " .. (currentStreamId or "Unknown"))
        print("Stream Key: " .. (streamConfig and streamConfig.streamKey or "Unknown"))
        print("WebSocket: " .. (streamConfig and streamConfig.webSocketUrl or "Unknown"))
    else
        ShowNotification("~r~Not streaming~s~")
        print("^3[Stream Status]^7 Not currently streaming")
    end
end, false)

-- Auto-cleanup on resource restart
AddEventHandler('onResourceStop', function(resourceName)
    if GetCurrentResourceName() == resourceName and isStreaming then
        print("^3[Cleanup]^7 Resource stopping, cleaning up stream")
        TriggerServerEvent('redm_streamer:stopStream')
    end
end)

-- Heartbeat to keep stream alive
CreateThread(function()
    while true do
        Wait(30000) -- Every 30 seconds
        
        if isStreaming and currentStreamId then
            TriggerServerEvent('redm_streamer:updateStats', {
                status = 'heartbeat',
                streamId = currentStreamId,
                timestamp = GetGameTimer(),
                uptime = GetGameTimer()
            })
        end
    end
end)

-- Helper function for notifications
function ShowNotification(text)
    local str = Citizen.InvokeNative(0xFA925AC00EB830B9, 10, "LITERAL_STRING", text, Citizen.ResultAsLong())
    Citizen.InvokeNative(0xFA233F8FE190514C, str)
    Citizen.InvokeNative(0xE9990552DEC71600)
end

-- Export functions for other resources
function StartStreamingExport(playerId)
    if playerId then
        TriggerServerEvent('redm_streamer:requestStream', playerId)
    else
        ShowNotification("~r~Invalid player ID~s~")
    end
end

function StopStreamingExport()
    if isStreaming then
        TriggerServerEvent('redm_streamer:stopStream')
    else
        ShowNotification("~r~Not streaming~s~")
    end
end

function GetStreamStatusExport()
    return {
        isStreaming = isStreaming,
        streamId = currentStreamId,
        config = streamConfig
    }
end

-- Exports
exports('startStreaming', StartStreamingExport)
exports('stopStreaming', StopStreamingExport)
exports('getStreamStatus', GetStreamStatusExport)
exports('isStreaming', function() return isStreaming end)