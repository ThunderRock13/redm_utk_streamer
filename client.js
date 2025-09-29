RegisterNuiCallbackType("streamStarted");
RegisterNuiCallbackType("streamError");

var SendNUIMessage = (data) => SendNuiMessage(JSON.stringify(data));
let streamActive = false;
let streamId = null;

// Simple event-based client - no WebRTC, only NUI relay

onNet("redm_utk_streamer:initStream", (config) => {
    console.log("[CLIENT] Received initStream event with config:", JSON.stringify(config));
    // This is triggered when we need to prepare the stream
    SendNUIMessage({
        action: "INIT_STREAM",
        config: config
    });
    console.log("[CLIENT] Sent INIT_STREAM message to NUI");
});

onNet("redm_utk_streamer:stopStream", () => {
    // Stop stream command from server
    SendNUIMessage({
        action: "STOP_STREAM"
    });
    streamActive = false;
    streamId = null;
});

on("__cfx_nui:streamStarted", (data, cb) => {
    cb("ok");
    streamActive = true;
    streamId = data.streamId;
    // Notify server that stream started
    TriggerServerEvent('redm_utk_streamer:streamStarted', data);
});

on("__cfx_nui:streamError", (data, cb) => {
    cb("ok");
    streamActive = false;
    streamId = null;
    // Notify server of stream error
    TriggerServerEvent('redm_utk_streamer:streamError', data);
});

// Note: streamData and videoFrame callbacks removed
// NUI now connects directly to RTC server via WebSocket