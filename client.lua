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
    
    -- Send configuration to NUI
    SendNUIMessage({
        action = 'START_STREAM',
        streamId = config.streamId,
        webrtcUrl = config.webrtcUrl,
        stunServer = config.stunServer,
        turnServer = config.turnServer,
        quality = Config.StreamQuality
    })
    
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
    print("^2[Streamer]^7 NUI reports stream started")
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