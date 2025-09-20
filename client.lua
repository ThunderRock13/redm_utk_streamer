local isStreaming = false
local currentStreamId = nil
local streamConfig = nil

-- Start streaming (triggered by server)
RegisterNetEvent('redm_streamer:startStream')
AddEventHandler('redm_streamer:startStream', function(config)
    if isStreaming then
        print("^1[Streamer]^7 Already streaming")
        return
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
        webSocketUrl = 'ws://localhost:3000/ws',  -- Force correct URL
        stunServer = config.stunServer,
        turnServer = config.turnServer,
        quality = Config.StreamQuality
    }
    
    print("^2[Streamer]^7 Sending NUI message: " .. json.encode(nuiMessage))
    SendNUIMessage(nuiMessage)
    
    -- Show notification
    ShowNotification("~g~Stream Started~s~")
    ShowNotification("ID: " .. config.streamId)
end)

-- Stop streaming
RegisterNetEvent('redm_streamer:stopStream')
AddEventHandler('redm_streamer:stopStream', function()
    if not isStreaming then
        return
    end
    
    print("^2[Streamer]^7 Stopping stream")
    
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
    cb('ok')
end)

RegisterNUICallback('streamError', function(data, cb)
    print("^1[Streamer]^7 Stream error: " .. (data.error or "unknown"))
    if isStreaming then
        TriggerServerEvent('redm_streamer:stopStream')
    end
    cb('ok')
end)

RegisterNUICallback('streamStats', function(data, cb)
    -- Forward stats to server
    if isStreaming then
        TriggerServerEvent('redm_streamer:updateStats', data)
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

-- Debug command to manually trigger stream
RegisterCommand('teststream', function()
    if not isStreaming then
        -- Manually trigger with test config
        local testConfig = {
            streamId = 'test_' .. GetGameTimer(),
            streamKey = 'test_key_' .. GetGameTimer(),
            webSocketUrl = 'ws://localhost:3000/ws',
            stunServer = 'stun:stun.l.google.com:19302',
            quality = {
                width = 1920,
                height = 1080,
                fps = 30,
                bitrate = 2500000
            }
        }
        TriggerEvent('redm_streamer:startStream', testConfig)
    end
end, false)

-- Helper function for notifications
function ShowNotification(text)
    local str = Citizen.InvokeNative(0xFA925AC00EB830B9, 10, "LITERAL_STRING", text, Citizen.ResultAsLong())
    Citizen.InvokeNative(0xFA233F8FE190514C, str)
    Citizen.InvokeNative(0xE9990552DEC71600)
end

-- Export functions
function StartStreamingExport(playerId)
    TriggerServerEvent('redm_streamer:requestStream', playerId)
end

function StopStreamingExport()
    if isStreaming then
        TriggerServerEvent('redm_streamer:stopStream')
    end
end

exports('startStreaming', StartStreamingExport)
exports('stopStreaming', StopStreamingExport)