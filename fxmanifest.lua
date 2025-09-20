fx_version "cerulean"
games { 'rdr3' }
rdr3_warning 'I acknowledge that this is a prerelease build of RedM, and I am aware my resources *will* become incompatible once RedM ships.'

author 'RedM Streamer Rework'
description 'Scalable streaming platform using utk_render'
version '3.0.0'

-- Include all the utk_render module files
files {
    "module/*.js",
    "module/animation/tracks/*.js",
    "module/animation/*.js",
    "module/audio/*js",
    "module/cameras/*.js",
    "module/core/*.js",
    "module/extras/core/*.js",
    "module/extras/curves/*.js",
    "module/extras/objects/*.js",
    "module/extras/*.js",
    "module/geometries/*.js",
    "module/helpers/*.js",
    "module/lights/*.js",
    "module/loaders/*.js",
    "module/materials/*.js",
    "module/math/interpolants/*.js",
    "module/math/*.js",
    "module/objects/*.js",
    "module/renderers/shaders/*.js",
    "module/renderers/shaders/ShaderChunk/*.js",
    "module/renderers/shaders/ShaderLib/*.js",
    "module/renderers/webgl/*.js",
    "module/renderers/webxr/*.js",
    "module/renderers/webvr/*.js",
    "module/renderers/*.js",
    "module/scenes/*.js",
    "module/textures/*.js",
    "script.js",
    "html/stream.html",
    "html/stream.js"
}

shared_scripts {
    "config.lua"
}

client_scripts {
    "invokeNative.lua",
    "client.js",
    "client.lua"
}

server_scripts {
    "server.js",
    "server.lua"
}

ui_page "html/stream.html"

exports {
    "requestScreenshot",
    "CellFrontCamActivate",
    "startStreaming",
    "stopStreaming"
}

lua54 'yes'