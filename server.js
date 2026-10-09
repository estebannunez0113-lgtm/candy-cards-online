'use strict';

// Candy Cards Online multiplayer server.
// Keep this file as plain UTF-8 text, not an RTF document.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT || 8080);
const ROOT = __dirname;
const MAX_PLAYERS_PER_ROOM = 2;

const rooms = new Map();
const matchmaking = [];
const players = new Map(); // WebSocket => { id, ws, data }

function send(ws, payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
    }
}

function makeCode() {
    let code;
    do {
        code = crypto.randomBytes(4).toString('hex').slice(0, 6).toUpperCase();
    } while (rooms.has(code));
    return code;
}

function cleanName(value) {
    const name = String(value || 'CandyPlayer').replace(/[<>]/g, '').trim().slice(0, 18);
    return name || 'CandyPlayer';
}

function clampNumber(value, fallback, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, number));
}

function safePlayer(raw) {
    const player = raw && typeof raw === 'object' ? raw : {};
    return {
        username: cleanName(player.username),
        card: typeof player.card === 'string' ? player.card.slice(0, 80) : 'Red Lollipop',
        pet: typeof player.pet === 'string' ? player.pet.slice(0, 80) : null,
        trophies: clampNumber(player.trophies, 0, 0, 999999)
    };
}

function getPlayerId(ws) {
    if (!ws._playerId) ws._playerId = crypto.randomUUID();
    return ws._playerId;
}

function removeFromMatchmaking(ws) {
    for (let i = matchmaking.length - 1; i >= 0; i--) {
        if (matchmaking[i].ws === ws) matchmaking.splice(i, 1);
    }
}

function findRoomFor(ws) {
    for (const room of rooms.values()) {
        if (room.players.some(player => player.ws === ws)) return room;
    }
    return null;
}

function makeRoom(code, first, second = null) {
    const room = {
        code,
        players: [],
        started: false,
        turn: 0,
        round: 0
    };

    for (const item of [first, second].filter(Boolean)) {
        // Prevent the same socket or player ID from being counted twice.
        if (room.players.some(p => p.ws === item.ws || p.id === item.id)) continue;
        room.players.push({
            id: item.id,
            ws: item.ws,
            data: item.data,
            hp: 100,
            maxHp: 100
        });
    }

    rooms.set(code, room);
    return room;
}

function roomSnapshot(room) {
    return room.players.map(player => ({
        id: player.id,
        username: player.data.username,
        card: player.data.card,
        pet: player.data.pet,
        trophies: player.data.trophies,
        hp: player.hp,
        maxHp: player.maxHp
    }));
}

function startRoomBattle(room) {
    if (!room || room.started) return;

    const uniqueConnections = new Set(room.players.map(p => p.ws));
    const uniqueIds = new Set(room.players.map(p => p.id));
    if (room.players.length !== MAX_PLAYERS_PER_ROOM ||
        uniqueConnections.size !== MAX_PLAYERS_PER_ROOM ||
        uniqueIds.size !== MAX_PLAYERS_PER_ROOM) {
        return;
    }

    room.started = true;
    room.turn = 0;
    room.round = 1;
    for (const player of room.players) {
        player.hp = 100;
        player.maxHp = 100;
    }

    const snapshot = roomSnapshot(room);
    for (const player of room.players) {
        send(player.ws, {
            type: 'multiplayer_battle_start',
            room: room.code,
            you: player.id,
            opponent: snapshot.find(other => other.id !== player.id),
            turn: room.turn,
            turnPlayerId: room.players[room.turn].id,
            state: snapshot
        });
    }

    console.log(`Battle started in room ${room.code}: ${room.players.map(p => p.data.username).join(' vs ')}`);
}

function endRoom(room, winnerId = null, reason = null) {
    if (!room || !rooms.has(room.code)) return;

    const winner = winnerId ? room.players.find(p => p.id === winnerId) : null;
    for (const player of room.players) {
        send(player.ws, {
            type: 'battle_result',
            winner: winner ? winner.data.username : null
        });
        if (reason && player.id !== winnerId) {
            send(player.ws, { type: 'opponent_left', message: reason });
        }
        players.delete(player.ws);
    }
    rooms.delete(room.code);
    console.log(`Room ${room.code} closed.`);
}

function cardDamage(action) {
    if (action === 'power') return 30;
    if (action === 'pet') return 22;
    return 20;
}

function handleBattleAction(ws, msg) {
    const room = findRoomFor(ws);
    if (!room || !room.started || room.players.length !== MAX_PLAYERS_PER_ROOM) {
        send(ws, { type: 'error', message: 'No active multiplayer battle.' });
        return;
    }

    const index = room.players.findIndex(player => player.ws === ws);
    if (index < 0) {
        send(ws, { type: 'error', message: 'You are not in this room.' });
        return;
    }
    if (index !== room.turn) {
        send(ws, { type: 'error', message: 'It is not your turn.' });
        return;
    }

    const me = room.players[index];
    const opponent = room.players[index === 0 ? 1 : 0];
    const damage = cardDamage(msg.action);
    opponent.hp = Math.max(0, opponent.hp - damage);

    if (opponent.hp <= 0) {
        for (const player of room.players) {
            send(player.ws, {
                type: 'multiplayer_battle_state',
                state: roomSnapshot(room),
                turn: room.turn,
                turnPlayerId: room.players[room.turn].id,
                log: `${me.data.username} dealt ${damage} damage and won.`
            });
        }
        endRoom(room, me.id);
        return;
    }

    room.turn = room.turn === 0 ? 1 : 0;
    room.round += 1;
    for (const player of room.players) {
        send(player.ws, {
            type: 'multiplayer_battle_state',
            state: roomSnapshot(room),
            turn: room.turn,
            turnPlayerId: room.players[room.turn].id,
            log: `${me.data.username} used ${String(msg.action || 'strike').toUpperCase()} for ${damage} damage.`
        });
    }
}

function handleMessage(ws, raw) {
    let msg;
    try {
        msg = JSON.parse(raw);
    } catch {
        send(ws, { type: 'error', message: 'Invalid JSON message.' });
        return;
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
        send(ws, { type: 'error', message: 'Invalid message.' });
        return;
    }

    const type = msg.type;

    if (type === 'create_room') {
        const existingRoom = findRoomFor(ws);
        if (existingRoom) {
            send(ws, { type: 'room_created', room: existingRoom.code });
            return;
        }

        removeFromMatchmaking(ws);
        const data = safePlayer(msg.player || msg);
        const id = getPlayerId(ws);
        players.set(ws, { id, ws, data });
        const code = makeCode();
        makeRoom(code, { id, ws, data });
        send(ws, { type: 'room_created', room: code });
        console.log(`Room ${code} created by ${data.username}.`);
        return;
    }

    if (type === 'join_room') {
        const code = String(msg.room || msg.roomCode || '').trim().toUpperCase();
        const room = rooms.get(code);
        if (!room) {
            send(ws, { type: 'error', message: 'Room not found. Check the room code.' });
            return;
        }

        // Repeated join from the same connection must not fill the room.
        if (room.players.some(player => player.ws === ws)) {
            send(ws, { type: 'room_joined', room: code });
            return;
        }

        if (findRoomFor(ws)) {
            send(ws, { type: 'error', message: 'Leave your current room first.' });
            return;
        }

        const uniqueConnections = new Set(room.players.map(p => p.ws));
        const uniqueIds = new Set(room.players.map(p => p.id));
        if (room.started || uniqueConnections.size >= MAX_PLAYERS_PER_ROOM || uniqueIds.size >= MAX_PLAYERS_PER_ROOM) {
            send(ws, { type: 'error', message: 'Room is full. Try creating another room.' });
            return;
        }

        const data = safePlayer(msg.player || msg);
        const id = getPlayerId(ws);
        if (room.players.some(player => player.id === id)) {
            send(ws, { type: 'error', message: 'You are already in this room.' });
            return;
        }

        removeFromMatchmaking(ws);
        players.set(ws, { id, ws, data });
        room.players.push({ id, ws, data, hp: 100, maxHp: 100 });
        send(ws, { type: 'room_joined', room: code });

        const host = room.players.find(player => player.ws !== ws);
        if (host) send(host.ws, { type: 'opponent_joined', room: code, opponent: data });
        console.log(`${data.username} joined room ${code}. Players: ${room.players.length}/${MAX_PLAYERS_PER_ROOM}`);
        startRoomBattle(room);
        return;
    }

    if (type === 'matchmake') {
        if (findRoomFor(ws)) {
            send(ws, { type: 'error', message: 'Leave your current room before matchmaking.' });
            return;
        }

        removeFromMatchmaking(ws);
        const data = safePlayer(msg.player || msg);
        const id = getPlayerId(ws);
        players.set(ws, { id, ws, data });

        let other = null;
        while (matchmaking.length > 0) {
            const candidate = matchmaking.shift();
            if (candidate.ws !== ws &&
                candidate.ws.readyState === WebSocket.OPEN &&
                !findRoomFor(candidate.ws) &&
                players.has(candidate.ws)) {
                other = candidate;
                break;
            }
        }

        if (!other) {
            matchmaking.push({ ws, id, data });
            send(ws, { type: 'matchmaking', message: 'SEARCHING FOR PLAYER...' });
            return;
        }

        const code = makeCode();
        const room = makeRoom(code,
            { ws, id, data },
            { ws: other.ws, id: other.id, data: other.data }
        );
        send(ws, { type: 'match_found', room: code, opponent: other.data });
        send(other.ws, { type: 'match_found', room: code, opponent: data });
        console.log(`Matchmaking created room ${code}.`);
        startRoomBattle(room);
        return;
    }

    if (type === 'battle_action') {
        handleBattleAction(ws, msg);
        return;
    }

    if (type === 'leave_room') {
        removeFromMatchmaking(ws);
        const room = findRoomFor(ws);
        if (room) {
            const opponent = room.players.find(player => player.ws !== ws);
            if (opponent) send(opponent.ws, { type: 'opponent_left', message: 'Opponent left the room.' });
            endRoom(room, null);
        } else {
            players.delete(ws);
        }
        return;
    }

    send(ws, { type: 'error', message: 'Unknown message type: ' + String(type) });
}

const server = http.createServer((req, res) => {
    let pathname;
    try {
        pathname = decodeURIComponent(new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname);
    } catch {
        res.writeHead(400);
        res.end('Bad request');
        return;
    }

    if (pathname === '/health') {
        res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store'
        });
        res.end(JSON.stringify({ ok: true, service: 'candy-cards-online', maxPlayersPerRoom: MAX_PLAYERS_PER_ROOM }));
        return;
    }

    const requested = pathname === '/' ? '/index.html' : pathname;
    const full = path.resolve(ROOT, '.' + requested);
    if (full !== ROOT && !full.startsWith(ROOT + path.sep)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    fs.readFile(full, (error, content) => {
        if (error) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Not found');
            return;
        }
        const ext = path.extname(full).toLowerCase();
        const types = {
            '.html': 'text/html; charset=utf-8',
            '.js': 'text/javascript; charset=utf-8',
            '.css': 'text/css; charset=utf-8',
            '.json': 'application/json; charset=utf-8',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.svg': 'image/svg+xml',
            '.ico': 'image/x-icon'
        };
        res.writeHead(200, {
            'Content-Type': types[ext] || 'application/octet-stream',
            'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=3600'
        });
        res.end(content);
    });
});

const wss = new WebSocket.Server({ server, maxPayload: 64 * 1024 });
const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
        if (ws.isAlive === false) {
            ws.terminate();
            continue;
        }
        ws.isAlive = false;
        ws.ping();
    }
}, 30000);

wss.on('close', () => clearInterval(heartbeat));
wss.on('connection', ws => {
    ws.isAlive = true;
    getPlayerId(ws);
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', data => handleMessage(ws, data.toString()));
    ws.on('error', error => console.error('WebSocket error:', error.message));
    ws.on('close', () => {
        removeFromMatchmaking(ws);
        const room = findRoomFor(ws);
        if (room) {
            const opponent = room.players.find(player => player.ws !== ws);
            if (opponent) send(opponent.ws, { type: 'opponent_left', message: 'Opponent disconnected.' });
            // Remove every participant and close the disconnected room cleanly.
            for (const player of room.players) players.delete(player.ws);
            rooms.delete(room.code);
            console.log(`Room ${room.code} closed after disconnect.`);
        }
        players.delete(ws);
    });
    send(ws, { type: 'connected', message: 'Candy Cards server connected.' });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log('Candy Cards Online Server');
    console.log('-------------------------');
    console.log(`Server running on port ${PORT}`);
    console.log(`Maximum players per room: ${MAX_PLAYERS_PER_ROOM}`);
    console.log(`Local: http://localhost:${PORT}`);
});
