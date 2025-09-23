local isStreaming = false
local currentStreamId = nil
local streamConfig = nil

-- WebSocket bridge for HTTPS mixed content workaround
local bridgeActive = false

-- Start streaming (triggered by server)
RegisterNetEvent('redm_streamer:startStream')
AddEventHandler('redm_streamer:startStream', function(config)
    if isStreaming then
        TriggerEvent('redm_streamer:stopStream')
        Wait(2000) -- Give time for cleanup
    end
    
    isStreaming = true
    currentStreamId = config.streamId
    streamConfig = config
    bridgeActive = false -- Bridge mode disabled by default
    
    
    -- Make sure NUI is ready
    Wait(1000)
    
    -- Send configuration to NUI (direct WebSocket mode)
    local nuiMessage = {
        action = 'START_STREAM',
        streamId = config.streamId,
        streamKey = config.streamKey or config.streamId,
        webSocketUrl = string.format('%s://%s:%s/ws', Config.Server.secure_websocket and 'wss' or 'ws', Config.Server.hostname, Config.Server.port),
        stunServer = config.stunServer or 'stun:stun.l.google.com:19302',
        turnServer = config.turnServer,
        quality = Config.StreamQuality
    }

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
        return
    end

    -- Direct WebSocket mode
    bridgeActive = false

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
end)

-- Show stats
RegisterNetEvent('redm_streamer:stats')
AddEventHandler('redm_streamer:stats', function(stats)
end)

-- Notification
RegisterNetEvent('redm_streamer:notify')
AddEventHandler('redm_streamer:notify', function(message)
    ShowNotification(message)
end)

-- NUI Callbacks
RegisterNUICallback('streamStarted', function(data, cb)
    
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
    cb('ok')
end)

-- HTTP proxy for HTTPS mixed content workaround
RegisterNUICallback('http-proxy-request', function(data, cb)
    print(string.format("^3[HTTP Proxy]^7 Received request: %s", data.endpoint))

    if data.endpoint and data.method and data.body then
        -- Make HTTP call to media server on behalf of NUI
        CallMediaServer(data.endpoint, data.method, data.body)
        print(string.format("^2[HTTP Proxy]^7 HTTP call completed: %s %s", data.method, data.endpoint))
    end

    cb('ok')
end)

-- Bridge mode NUI callbacks
RegisterNUICallback('bridgeRegister', function(data, cb)
    print("^2[Bridge]^7 NUI bridge registration called with stream key: " .. (data.streamKey or "nil"))
    if bridgeActive and streamConfig then
        print("^2[Bridge]^7 Sending bridge registration to server")
        -- Tell server to register with RTC server
        TriggerServerEvent('redm_streamer:bridgeRegister', {
            streamKey = data.streamKey,
            playerId = GetPlayerServerId(PlayerId()),
            playerName = GetPlayerName(PlayerId())
        })
    else
        print("^1[Bridge]^7 Bridge not active or no stream config")
    end
    cb('ok')
end)

RegisterNUICallback('bridgeMessage', function(data, cb)
    if bridgeActive and streamConfig then
        -- Forward message to server which will handle RTC communication
        TriggerServerEvent('redm_streamer:bridgeMessage', {
            streamKey = streamConfig.streamKey or streamConfig.streamId,
            playerId = GetPlayerServerId(PlayerId()),
            message = data.message
        })
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
    else
        ShowNotification("~r~Not streaming~s~")
    end
end, false)

-- Auto-cleanup on resource restart
AddEventHandler('onResourceStop', function(resourceName)
    if GetCurrentResourceName() == resourceName and isStreaming then
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

-- Bridge message events from server
RegisterNetEvent('redm_streamer:bridgeRegistered')
AddEventHandler('redm_streamer:bridgeRegistered', function(success)
    if bridgeActive then
        SendNUIMessage({
            action = 'BRIDGE_REGISTERED',
            success = success
        })
    end
end)

RegisterNetEvent('redm_streamer:bridgeMessage')
AddEventHandler('redm_streamer:bridgeMessage', function(message)
    if bridgeActive then
        SendNUIMessage({
            action = 'BRIDGE_MESSAGE',
            message = message
        })
    end
end)