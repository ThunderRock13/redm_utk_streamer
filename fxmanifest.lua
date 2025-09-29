fx_version "bodacious"
games { 'rdr3' }
rdr3_warning 'I acknowledge that this is a prerelease build of RedM, and I am aware my resources *will* become incompatible once RedM ships.'

author 'RedM Streamer Rework'
description 'Scalable streaming platform using utk_render'
version '3.0.0'

files {
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