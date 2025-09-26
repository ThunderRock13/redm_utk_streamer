local isStreaming = false
local currentStreamId = nil
local streamConfig = nil

-- Start streaming (triggered by server)
RegisterNetEvent('redm_utk_streamer:startStream')
AddEventHandler('redm_utk_streamer:startStream', function(config)
    if isStreaming then
        TriggerEvent('redm_utk_streamer:stopStream')
        Wait(2000) -- Give time for cleanup
    end
    
    isStreaming = true
    currentStreamId = config.streamId
    streamConfig = config
    
    
    -- Make sure NUI is ready
    Wait(1000)
    
    -- Send configuration to NUI for proxy-based streaming
    local nuiMessage = {
        action = 'START_STREAM',
        streamId = config.streamId,
        streamKey = config.streamKey or config.streamId,
        useProxy = true, -- Enable event-based proxy
        stunServer = 'stun:stun.l.google.com:19302',
        quality = Config.StreamQuality
    }

    -- Debug logging
    if Config.Debug then
        print(string.format("^2[Client Debug]^7 Starting stream with proxy mode"))
        print(string.format("^2[Client Debug]^7 Stream ID: %s, Stream Key: %s", nuiMessage.streamId, nuiMessage.streamKey))
    end

    -- Initialize proxy connection
    TriggerServerEvent('redm_utk_streamer:connectWebSocket', {
        streamId = config.streamId,
        streamKey = config.streamKey or config.streamId
    })

    SendNUIMessage(nuiMessage)
    
    -- Show notification
    ShowNotification("~g~Stream Started~s~")
    ShowNotification("ID: " .. config.streamId)
    
    -- Update server with stream start
    TriggerServerEvent('redm_utk_streamer:updateStats', {
        status = 'started',
        streamId = config.streamId,
        timestamp = GetGameTimer()
    })
end)

-- Stop streaming
RegisterNetEvent('redm_utk_streamer:stopStream')
AddEventHandler('redm_utk_streamer:stopStream', function()
    if not isStreaming then
        return
    end
    
    -- Update server with stream stop
    if currentStreamId then
        TriggerServerEvent('redm_utk_streamer:updateStats', {
            status = 'stopped',
            streamId = currentStreamId,
            timestamp = GetGameTimer()
        })
    end
    
    isStreaming = false
    currentStreamId = nil
    streamConfig = nil
    
    -- Disconnect proxy
    TriggerServerEvent('redm_utk_streamer:disconnectWebSocket')

    -- Tell NUI to stop
    SendNUIMessage({
        action = 'STOP_STREAM'
    })

    ShowNotification("~r~Stream Stopped~s~")
end)

-- Show view URL
RegisterNetEvent('redm_utk_streamer:viewUrl')
AddEventHandler('redm_utk_streamer:viewUrl', function(data)
    ShowNotification("~g~Stream Ready~s~")
    ShowNotification("Player: " .. data.playerName)
    ShowNotification("URL: " .. data.hlsUrl)
end)

-- Show stats
RegisterNetEvent('redm_utk_streamer:stats')
AddEventHandler('redm_utk_streamer:stats', function(stats)
end)

-- Notification
RegisterNetEvent('redm_utk_streamer:notify')
AddEventHandler('redm_utk_streamer:notify', function(message)
    ShowNotification(message)
end)

-- NUI Callbacks
RegisterNUICallback('streamStarted', function(data, cb)

    -- Notify server that stream is ready
    TriggerServerEvent('redm_utk_streamer:updateStats', {
        status = 'connected',
        streamId = data.streamId or currentStreamId,
        streamKey = data.streamKey,
        timestamp = GetGameTimer()
    })

    cb('ok')
end)

-- Handle WebRTC data relay (CFX-native, no HTTP)
RegisterNUICallback('sendWebRTCData', function(data, cb)
    -- Relay WebRTC data (offers, answers, ICE candidates) through server events
    TriggerServerEvent('redm_utk_streamer:relayWebRTCData', {
        streamId = currentStreamId,
        streamKey = streamConfig and streamConfig.streamKey,
        messageType = data.type,
        messageData = data.data,
        viewerId = data.viewerId,
        timestamp = GetGameTimer()
    })
    cb('ok')
end)

RegisterNUICallback('streamError', function(data, cb)
    
    -- Notify server about error
    TriggerServerEvent('redm_utk_streamer:updateStats', {
        status = 'error',
        error = data.error,
        streamId = currentStreamId,
        timestamp = GetGameTimer()
    })
    
    -- Auto-stop on error
    if isStreaming then
        TriggerEvent('redm_utk_streamer:stopStream')
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
        
        TriggerServerEvent('redm_utk_streamer:updateStats', enhancedStats)
    end
    cb('ok')
end)

RegisterNUICallback('debugLog', function(data, cb)
    cb('ok')
end)

-- Commands
RegisterCommand('stopstream', function()
    if isStreaming then
        TriggerServerEvent('redm_utk_streamer:stopStream')
    else
        ShowNotification("~r~Not streaming~s~")
    end
end, false)

RegisterCommand('streamstats', function()
    if isStreaming then
        TriggerServerEvent('redm_utk_streamer:getStats')
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
            webSocketUrl = 'ws://' .. Config.MediaServer.server_ip .. ':3000/ws',
            stunServer = 'stun:stun.l.google.com:19302',
            quality = Config.StreamQuality
        }
        TriggerEvent('redm_utk_streamer:startStream', testConfig)
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
        TriggerServerEvent('redm_utk_streamer:stopStream')
    end
end)

-- Heartbeat to keep stream alive and poll for proxy messages
CreateThread(function()
    while true do
        Wait(30000) -- Every 30 seconds

        if isStreaming and currentStreamId then
            TriggerServerEvent('redm_utk_streamer:updateStats', {
                status = 'heartbeat',
                streamId = currentStreamId,
                timestamp = GetGameTimer(),
                uptime = GetGameTimer()
            })

            -- Also poll for proxy messages
            TriggerServerEvent('redm_utk_streamer:pollProxyMessages')
        end
    end
end)

-- Helper function for notifications
function ShowNotification(text)
    local str = Citizen.InvokeNative(0xFA925AC00EB830B9, 10, "LITERAL_STRING", text, Citizen.ResultAsLong())
    Citizen.InvokeNative(0xFA233F8FE190514C, str)
    Citizen.InvokeNative(0xE9990552DEC71600)
end

-- Handle WebRTC replies from server
RegisterNetEvent('redm_utk_streamer:webRTCReply')
AddEventHandler('redm_utk_streamer:webRTCReply', function(replyData)
    -- Forward WebRTC reply to NUI
    SendNUIMessage({
        action = 'WEBRTC_REPLY',
        data = replyData
    })
end)

-- Handle WebRTC messages from other clients
RegisterNetEvent('redm_utk_streamer:webRTCMessage')
AddEventHandler('redm_utk_streamer:webRTCMessage', function(messageData)
    -- Forward WebRTC message to NUI
    SendNUIMessage({
        action = 'WEBRTC_MESSAGE',
        data = messageData
    })
end)

-- Export functions for other resources
function StartStreamingExport(playerId)
    if playerId then
        TriggerServerEvent('redm_utk_streamer:requestStream', playerId)
    else
        ShowNotification("~r~Invalid player ID~s~")
    end
end

function StopStreamingExport()
    if isStreaming then
        TriggerServerEvent('redm_utk_streamer:stopStream')
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

-- WebSocket Proxy Event Handlers

-- Proxy connected successfully
RegisterNetEvent('redm_utk_streamer:webSocketConnected')
AddEventHandler('redm_utk_streamer:webSocketConnected', function(data)
    if Config.Debug then
        print("^2[Client Debug]^7 WebSocket proxy connected successfully")
    end

    -- Notify NUI that proxy is connected
    SendNUIMessage({
        action = 'PROXY_CONNECTED',
        data = data
    })
end)

-- Proxy connection error
RegisterNetEvent('redm_utk_streamer:webSocketError')
AddEventHandler('redm_utk_streamer:webSocketError', function(error)
    if Config.Debug then
        print("^1[Client Debug]^7 WebSocket proxy error: " .. (error.message or "unknown"))
    end

    -- Notify NUI of error
    SendNUIMessage({
        action = 'PROXY_ERROR',
        error = error
    })
end)

-- Message from WebRTC server via proxy
RegisterNetEvent('redm_utk_streamer:webSocketMessage')
AddEventHandler('redm_utk_streamer:webSocketMessage', function(message)
    if Config.Debug then
        print("^2[Client Debug]^7 Received message via proxy")
    end

    -- Forward to NUI
    SendNUIMessage({
        action = 'PROXY_MESSAGE',
        message = message
    })
end)

-- NUI Callback for sending messages via proxy
RegisterNUICallback('sendProxyMessage', function(data, cb)
    if Config.Debug then
        print("^2[Client Debug]^7 Sending message via proxy: " .. (data.type or "unknown"))
    end

    TriggerServerEvent('redm_utk_streamer:sendWebSocketMessage', data)
    cb('ok')
end)

-- Exports
exports('startStreaming', StartStreamingExport)
exports('stopStreaming', StopStreamingExport)
exports('getStreamStatus', GetStreamStatusExport)
exports('isStreaming', function() return isStreaming end)