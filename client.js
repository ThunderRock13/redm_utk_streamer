RegisterNuiCallbackType("streamStarted");
RegisterNuiCallbackType("streamError");
RegisterNuiCallbackType("streamStats");

var SendNUIMessage = (data) => SendNuiMessage(JSON.stringify(data));
let streamActive = false;
let streamId = null;

// Remove all UI-related code, keep only streaming logic
// No commands for UI, everything is event-based

onNet("redm_streamer:initStream", (config) => {
    // This is triggered when we need to prepare the stream
    SendNUIMessage({
        action: "INIT_STREAM",
        config: config
    });
});

on("__cfx_nui:streamStarted", (data, cb) => {
    cb("ok");
    streamActive = true;
    streamId = data.streamId;
    // Stream started
});

on("__cfx_nui:streamError", (data, cb) => {
    cb("ok");
    streamActive = false;
    streamId = null;
    // Stream error
});

on("__cfx_nui:streamStats", (data, cb) => {
    cb("ok");
    // Stats from the stream
});