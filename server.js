// RedM Streaming Server using utk_render
const activeStreams = new Map();

// Listen for streamplayer command from Lua
onNet("redm_streamer:createStream", (data) => {
    const { streamId, targetPlayerId, commandSource } = data;
    
    console.log(`Creating utk_render stream: ${streamId} for player ${targetPlayerId}`);
    
    // Store the stream
    activeStreams.set(streamId, {
        streamerId: targetPlayerId,
        viewers: [],
        startTime: Date.now()
    });
    
    // Tell target player to start streaming with utk_render
    emitNet("utk_render:startStreaming", targetPlayerId, {
        streamId: streamId,
        serverid: targetPlayerId
    });
    
    // Broadcast new stream to all players
    emitNet("utk_render:newStream", -1, {
        streamId: streamId,
        streamerId: targetPlayerId,
        streamerName: GetPlayerName(targetPlayerId)
    });
    
    // Notify command source of success
    if (commandSource > 0) {
        emitNet("redm_streamer:notify", commandSource, `Stream created: ${streamId}`);
    }
});

// Your existing utk_render signaling events
onNet("utk_render:sendChatMessage", (data) => {
    emitNet("utk_render:receiveChatMessage", -1, data);
});

onNet("utk_render:startStreaming", (data) => {
    emitNet("utk_render:newStream", -1, data);
});

onNet("utk_render:joinStream", (data) => {
    const stream = activeStreams.get(data.streamId);
    if (stream && !stream.viewers.includes(source)) {
        stream.viewers.push(source);
    }
    emitNet("utk_render:joinStream", -1, data);
});

onNet("utk_render:sendRTCOffer", (data) => {
    emitNet("utk_render:sendRTCOffer", data.serverid, data);
});

onNet("utk_render:sendRTCAnswer", (data) => {
    emitNet("utk_render:sendRTCAnswer", -1, data);
});

onNet("utk_render:newIceCandidateStreamer", (data) => {
    console.log("sending to " + data.serverid);
    emitNet("utk_render:newIceCandidateStreamer", data.serverid, data);
});

onNet("utk_render:newIceCandidateWatcher", (data) => {
    emitNet("utk_render:newIceCandidateWatcher", -1, data);
});

onNet("utk_render:leaveStream", (data) => {
    const stream = activeStreams.get(data.streamId);
    if (stream) {
        const index = stream.viewers.indexOf(source);
        if (index > -1) {
            stream.viewers.splice(index, 1);
        }
    }
    emitNet("utk_render:leaveStream", -1, data);
});

onNet("utk_render:stopStream", (data) => {
    activeStreams.delete(data.streamId);
    emitNet("utk_render:stopStream", -1, data);
});
