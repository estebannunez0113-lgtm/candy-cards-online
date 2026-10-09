{\rtf1\ansi\ansicpg1252\cocoartf2639
\cocoatextscaling0\cocoaplatform0{\fonttbl\f0\fswiss\fcharset0 Helvetica;}
{\colortbl;\red255\green255\blue255;}
{\*\expandedcolortbl;;}
\margl1440\margr1440\vieww11520\viewh8400\viewkind0
\pard\tx566\tx1133\tx1700\tx2267\tx2834\tx3401\tx3968\tx4535\tx5102\tx5669\tx6236\tx6803\pardirnatural\partightenfactor0

\f0\fs24 \cf0 \
'use strict';\
\
const http = require('http');\
const fs = require('fs');\
const path = require('path');\
const crypto = require('crypto');\
const WebSocket = require('ws');\
\
const PORT = Number(process.env.PORT || 8080);\
const ROOT = __dirname;\
const MAX_PLAYERS_PER_ROOM = 2;\
\
const rooms = new Map();\
const matchmaking = [];\
const players = new Map();\
\
function send(ws, payload) \{\
    if (ws && ws.readyState === WebSocket.OPEN) \{\
        ws.send(JSON.stringify(payload));\
    \}\
\}\
\
function makeCode() \{\
    let code;\
    do \{\
        code = crypto.randomBytes(4)\
            .toString('hex')\
            .slice(0, 6)\
            .toUpperCase();\
    \} while (rooms.has(code));\
\
    return code;\
\}\
\
function cleanName(value) \{\
    const name = String(value || 'CandyPlayer')\
        .replace(/[<>]/g, '')\
        .trim()\
        .slice(0, 18);\
\
    return name || 'CandyPlayer';\
\}\
\
function clampNumber(value, fallback, min, max) \{\
    const number = Number(value);\
\
    if (!Number.isFinite(number)) \{\
        return fallback;\
    \}\
\
    return Math.max(min, Math.min(max, number));\
\}\
\
function safePlayer(raw) \{\
    const p = raw || \{\};\
\
    return \{\
        username: cleanName(p.username),\
        card: typeof p.card === 'string'\
            ? p.card.slice(0, 80)\
            : 'Red Lollipop',\
        pet: typeof p.pet === 'string'\
            ? p.pet.slice(0, 80)\
            : null,\
        trophies: clampNumber(p.trophies, 0, 0, 999999)\
    \};\
\}\
\
function getPlayerId(ws) \{\
    if (!ws._playerId) \{\
        ws._playerId = crypto.randomUUID();\
    \}\
\
    return ws._playerId;\
\}\
\
function removeFromMatchmaking(ws) \{\
    for (let i = matchmaking.length - 1; i >= 0; i--) \{\
        if (matchmaking[i].ws === ws) \{\
            matchmaking.splice(i, 1);\
        \}\
    \}\
\}\
\
function findRoomFor(ws) \{\
    for (const room of rooms.values()) \{\
        if (room.players.some(player => player.ws === ws)) \{\
            return room;\
        \}\
    \}\
\
    return null;\
\}\
\
function makeRoom(code, first, second = null) \{\
    const room = \{\
        code,\
        players: [\
            \{\
                id: first.id,\
                ws: first.ws,\
                data: first.data,\
                hp: 100,\
                maxHp: 100\
            \}\
        ],\
        started: false,\
        turn: 0,\
        round: 0\
    \};\
\
    if (second) \{\
        room.players.push(\{\
            id: second.id,\
            ws: second.ws,\
            data: second.data,\
            hp: 100,\
            maxHp: 100\
        \});\
    \}\
\
    rooms.set(code, room);\
    return room;\
\}\
\
function roomSnapshot(room) \{\
    return room.players.map(player => (\{\
        id: player.id,\
        username: player.data.username,\
        card: player.data.card,\
        pet: player.data.pet,\
        trophies: player.data.trophies,\
        hp: player.hp,\
        maxHp: player.maxHp\
    \}));\
\}\
\
function startRoomBattle(room) \{\
    if (!room || room.started) \{\
        return;\
    \}\
\
    // A room must contain exactly two distinct connections.\
    const uniqueConnections = new Set(\
        room.players.map(player => player.ws)\
    );\
\
    const uniqueIds = new Set(\
        room.players.map(player => player.id)\
    );\
\
    if (\
        room.players.length !== MAX_PLAYERS_PER_ROOM ||\
        uniqueConnections.size !== MAX_PLAYERS_PER_ROOM ||\
        uniqueIds.size !== MAX_PLAYERS_PER_ROOM\
    ) \{\
        return;\
    \}\
\
    room.started = true;\
    room.turn = 0;\
    room.round = 1;\
\
    for (const player of room.players) \{\
        player.maxHp = 100;\
        player.hp = 100;\
    \}\
\
    const snapshot = roomSnapshot(room);\
\
    for (const player of room.players) \{\
        send(player.ws, \{\
            type: 'multiplayer_battle_start',\
            room: room.code,\
            you: player.id,\
            opponent: snapshot.find(other => other.id !== player.id),\
            turn: room.turn,\
            turnPlayerId: room.players[room.turn].id,\
            state: snapshot\
        \});\
    \}\
\
    console.log(\
        `Battle started in room $\{room.code\}: ` +\
        room.players.map(p => p.data.username).join(' vs ')\
    );\
\}\
\
function endRoom(room, winnerId = null) \{\
    if (!room || !rooms.has(room.code)) \{\
        return;\
    \}\
\
    const winner = winnerId\
        ? room.players.find(player => player.id === winnerId)\
        : null;\
\
    for (const player of room.players) \{\
        send(player.ws, \{\
            type: 'battle_result',\
            winner: winner ? winner.data.username : null\
        \});\
\
        players.delete(player.ws);\
    \}\
\
    rooms.delete(room.code);\
\
    console.log(`Room $\{room.code\} closed.`);\
\}\
\
function cardDamage(kind) \{\
    if (kind === 'power') return 30;\
    if (kind === 'pet') return 22;\
    return 20;\
\}\
\
function handleBattleAction(ws, msg) \{\
    const room = findRoomFor(ws);\
\
    if (!room || !room.started || room.players.length !== 2) \{\
        send(ws, \{\
            type: 'error',\
            message: 'No active multiplayer battle.'\
        \});\
        return;\
    \}\
\
    const me = room.players.find(player => player.ws === ws);\
\
    if (!me) \{\
        send(ws, \{\
            type: 'error',\
            message: 'You are not in this room.'\
        \});\
        return;\
    \}\
\
    const index = room.players.findIndex(player => player.ws === ws);\
\
    if (index !== room.turn) \{\
        send(ws, \{\
            type: 'error',\
            message: 'It is not your turn.'\
        \});\
        return;\
    \}\
\
    const opponent = room.players[index === 0 ? 1 : 0];\
    const damage = cardDamage(msg.action);\
\
    opponent.hp = Math.max(0, opponent.hp - damage);\
\
    if (opponent.hp <= 0) \{\
        for (const player of room.players) \{\
            send(player.ws, \{\
                type: 'multiplayer_battle_state',\
                state: roomSnapshot(room),\
                turn: room.turn,\
                log: `$\{me.data.username\} dealt $\{damage\} damage and won.`\
            \});\
        \}\
\
        endRoom(room, me.id);\
        return;\
    \}\
\
    room.turn = room.turn === 0 ? 1 : 0;\
    room.round += 1;\
\
    for (const player of room.players) \{\
        send(player.ws, \{\
            type: 'multiplayer_battle_state',\
            state: roomSnapshot(room),\
            turn: room.turn,\
            turnPlayerId: room.players[room.turn].id,\
            log: `$\{me.data.username\} used ` +\
                `$\{String(msg.action || 'strike').toUpperCase()\} ` +\
                `for $\{damage\} damage.`\
        \});\
    \}\
\}\
\
function handleMessage(ws, raw) \{\
    let msg;\
\
    try \{\
        msg = JSON.parse(raw);\
    \} catch \{\
        send(ws, \{\
            type: 'error',\
            message: 'Invalid JSON message.'\
        \});\
        return;\
    \}\
\
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) \{\
        send(ws, \{\
            type: 'error',\
            message: 'Invalid message.'\
        \});\
        return;\
    \}\
\
    const type = msg.type;\
\
    if (type === 'create_room') \{\
        // Do not let one connection create multiple rooms.\
        const existingRoom = findRoomFor(ws);\
\
        if (existingRoom) \{\
            send(ws, \{\
                type: 'room_created',\
                room: existingRoom.code\
            \});\
            return;\
        \}\
\
        removeFromMatchmaking(ws);\
\
        const player = safePlayer(msg.player || msg);\
        const id = getPlayerId(ws);\
\
        players.set(ws, \{\
            id,\
            ws,\
            data: player\
        \});\
\
        const code = makeCode();\
\
        makeRoom(code, \{\
            id,\
            ws,\
            data: player\
        \});\
\
        send(ws, \{\
            type: 'room_created',\
            room: code\
        \});\
\
        console.log(`Room $\{code\} created by $\{player.username\}.`);\
        return;\
    \}\
\
    if (type === 'join_room') \{\
        const code = String(msg.room || msg.roomCode || '')\
            .trim()\
            .toUpperCase();\
\
        const room = rooms.get(code);\
\
        if (!room) \{\
            send(ws, \{\
                type: 'error',\
                message: 'Room not found. Check the room code.'\
            \});\
            return;\
        \}\
\
        // Joining a room you already occupy is not a full-room error.\
        if (room.players.some(player => player.ws === ws)) \{\
            send(ws, \{\
                type: 'room_joined',\
                room: code\
            \});\
            return;\
        \}\
\
        // A connection can only participate in one room at a time.\
        const currentRoom = findRoomFor(ws);\
\
        if (currentRoom) \{\
            send(ws, \{\
                type: 'error',\
                message: 'Leave your current room first.'\
            \});\
            return;\
        \}\
\
        // Count unique connections and player IDs, not raw array entries.\
        const uniqueConnections = new Set(\
            room.players.map(player => player.ws)\
        );\
\
        const uniqueIds = new Set(\
            room.players.map(player => player.id)\
        );\
\
        if (\
            room.started ||\
            uniqueConnections.size >= MAX_PLAYERS_PER_ROOM ||\
            uniqueIds.size >= MAX_PLAYERS_PER_ROOM\
        ) \{\
            send(ws, \{\
                type: 'error',\
                message: 'Room is full. Try creating another room.'\
            \});\
            return;\
        \}\
\
        const player = safePlayer(msg.player || msg);\
        const id = getPlayerId(ws);\
\
        // Never add the same player ID twice.\
        if (room.players.some(existing => existing.id === id)) \{\
            send(ws, \{\
                type: 'error',\
                message: 'You are already in this room.'\
            \});\
            return;\
        \}\
\
        removeFromMatchmaking(ws);\
\
        players.set(ws, \{\
            id,\
            ws,\
            data: player\
        \});\
\
        room.players.push(\{\
            id,\
            ws,\
            data: player,\
            hp: 100,\
            maxHp: 100\
        \});\
\
        send(ws, \{\
            type: 'room_joined',\
            room: code\
        \});\
\
        const host = room.players.find(existing => existing.ws !== ws);\
\
        if (host) \{\
            send(host.ws, \{\
                type: 'opponent_joined',\
                room: code,\
                opponent: player\
            \});\
        \}\
\
        console.log(\
            `$\{player.username\} joined room $\{code\}. ` +\
            `Players: $\{room.players.length\}/$\{MAX_PLAYERS_PER_ROOM\}`\
        );\
\
        startRoomBattle(room);\
        return;\
    \}\
\
    if (type === 'matchmake') \{\
        const existingRoom = findRoomFor(ws);\
\
        if (existingRoom) \{\
            send(ws, \{\
                type: 'error',\
                message: 'Leave your current room before matchmaking.'\
            \});\
            return;\
        \}\
\
        removeFromMatchmaking(ws);\
\
        const player = safePlayer(msg.player || msg);\
        const id = getPlayerId(ws);\
\
        players.set(ws, \{\
            id,\
            ws,\
            data: player\
        \});\
\
        let other = null;\
\
        // Skip stale queue entries and never match a connection with itself.\
        while (matchmaking.length > 0) \{\
            const candidate = matchmaking.shift();\
\
            if (\
                candidate.ws !== ws &&\
                candidate.ws.readyState === WebSocket.OPEN &&\
                !findRoomFor(candidate.ws) &&\
                players.has(candidate.ws)\
            ) \{\
                other = candidate;\
                break;\
            \}\
        \}\
\
        if (!other) \{\
            matchmaking.push(\{\
                ws,\
                player,\
                id\
            \});\
\
            send(ws, \{\
                type: 'matchmaking',\
                message: 'SEARCHING FOR PLAYER...'\
            \});\
\
            return;\
        \}\
\
        const code = makeCode();\
\
        const room = makeRoom(\
            code,\
            \{\
                ws,\
                id,\
                data: player\
            \},\
            \{\
                ws: other.ws,\
                id: other.id,\
                data: other.player\
            \}\
        );\
\
        send(ws, \{\
            type: 'match_found',\
            room: code,\
            opponent: other.player\
        \});\
\
        send(other.ws, \{\
            type: 'match_found',\
            room: code,\
            opponent: player\
        \});\
\
        console.log(`Matchmaking created room $\{code\}.`);\
\
        startRoomBattle(room);\
        return;\
    \}\
\
    if (type === 'battle_action') \{\
        handleBattleAction(ws, msg);\
        return;\
    \}\
\
    if (type === 'leave_room') \{\
        removeFromMatchmaking(ws);\
\
        const room = findRoomFor(ws);\
\
        if (room) \{\
            const opponent = room.players.find(\
                player => player.ws !== ws\
            );\
\
            if (opponent) \{\
                send(opponent.ws, \{\
                    type: 'opponent_left',\
                    message: 'Opponent left the room.'\
                \});\
            \}\
\
            endRoom(room, null);\
        \} else \{\
            players.delete(ws);\
        \}\
\
        return;\
    \}\
\
    send(ws, \{\
        type: 'error',\
        message: 'Unknown message type: ' + String(type)\
    \});\
\}\
\
const server = http.createServer((req, res) => \{\
    const pathname = new URL(\
        req.url,\
        `http://$\{req.headers.host || 'localhost'\}`\
    ).pathname;\
\
    if (pathname === '/health') \{\
        res.writeHead(200, \{\
            'Content-Type': 'application/json; charset=utf-8',\
            'Cache-Control': 'no-store'\
        \});\
\
        res.end(JSON.stringify(\{\
            ok: true,\
            service: 'candy-cards-online',\
            maxPlayersPerRoom: MAX_PLAYERS_PER_ROOM\
        \}));\
\
        return;\
    \}\
\
    let requested;\
\
    try \{\
        requested = decodeURIComponent(pathname);\
    \} catch \{\
        res.writeHead(400);\
        res.end('Bad request');\
        return;\
    \}\
\
    if (requested === '/') \{\
        requested = '/index.html';\
    \}\
\
    const full = path.resolve(ROOT, '.' + requested);\
\
    if (full !== ROOT && !full.startsWith(ROOT + path.sep)) \{\
        res.writeHead(403);\
        res.end('Forbidden');\
        return;\
    \}\
\
    fs.readFile(full, (err, data) => \{\
        if (err) \{\
            res.writeHead(404, \{\
                'Content-Type': 'text/plain; charset=utf-8'\
            \});\
\
            res.end('Not found');\
            return;\
        \}\
\
        const ext = path.extname(full).toLowerCase();\
\
        const types = \{\
            '.html': 'text/html; charset=utf-8',\
            '.js': 'text/javascript; charset=utf-8',\
            '.css': 'text/css; charset=utf-8',\
            '.json': 'application/json; charset=utf-8',\
            '.png': 'image/png',\
            '.jpg': 'image/jpeg',\
            '.jpeg': 'image/jpeg',\
            '.svg': 'image/svg+xml',\
            '.ico': 'image/x-icon'\
        \};\
\
        res.writeHead(200, \{\
            'Content-Type': types[ext] || 'application/octet-stream',\
            'Cache-Control': ext === '.html'\
                ? 'no-store'\
                : 'public, max-age=3600'\
        \});\
\
        res.end(data);\
    \});\
\});\
\
const wss = new WebSocket.Server(\{\
    server,\
    maxPayload: 64 * 1024\
\});\
\
const heartbeat = setInterval(() => \{\
    for (const ws of wss.clients) \{\
        if (ws.isAlive === false) \{\
            ws.terminate();\
            continue;\
        \}\
\
        ws.isAlive = false;\
        ws.ping();\
    \}\
\}, 30000);\
\
wss.on('close', () => \{\
    clearInterval(heartbeat);\
\});\
\
wss.on('connection', ws => \{\
    ws.isAlive = true;\
    getPlayerId(ws);\
\
    ws.on('pong', () => \{\
        ws.isAlive = true;\
    \});\
\
    ws.on('message', data => \{\
        handleMessage(ws, data.toString());\
    \});\
\
    ws.on('error', error => \{\
        console.error('WebSocket error:', error.message);\
    \});\
\
    ws.on('close', () => \{\
        removeFromMatchmaking(ws);\
\
        const room = findRoomFor(ws);\
\
        if (room) \{\
            const opponent = room.players.find(\
                player => player.ws !== ws\
            );\
\
            if (opponent) \{\
                send(opponent.ws, \{\
                    type: 'opponent_left',\
                    message: 'Opponent disconnected.'\
                \});\
            \}\
\
            // Remove the room and clean up every participant.\
            for (const player of room.players) \{\
                players.delete(player.ws);\
            \}\
\
            rooms.delete(room.code);\
\
            console.log(`Room $\{room.code\} closed after disconnect.`);\
        \}\
\
        players.delete(ws);\
    \});\
\
    send(ws, \{\
        type: 'connected',\
        message: 'Candy Cards server connected.'\
    \});\
\});\
\
server.listen(PORT, '0.0.0.0', () => \{\
    console.log('Candy Cards Online Server');\
    console.log('-------------------------');\
    console.log(`Server running on port $\{PORT\}`);\
    console.log(`Maximum players per room: $\{MAX_PLAYERS_PER_ROOM\}`);\
    console.log(`Local: http://localhost:$\{PORT\}`);\
\});}