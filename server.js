const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT || 8080);
const ROOT = __dirname;
const rooms = new Map();
const matchmaking = [];
const players = new Map();

function send(ws, payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
    }
}

function makeCode() {
    let code;
    do {
        code = Math.random().toString(36).slice(2, 8).toUpperCase();
    } while (rooms.has(code));
    return code;
}

function cleanName(value) {
    return String(value || 'CandyPlayer').slice(0, 18);
}

function clampNumber(value, fallback, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

function safePlayer(raw) {
    const p = raw || {};
    return {
        username: cleanName(p.username),
        card: typeof p.card === 'string' ? p.card.slice(0, 80) : 'Red Lollipop',
        pet: typeof p.pet === 'string' ? p.pet.slice(0, 80) : null,
        trophies: clampNumber(p.trophies, 0, 0, 999999)
    };
}

function removeFromMatchmaking(ws) {
    for (let i = matchmaking.length - 1; i >= 0; i--) {
        if (matchmaking[i].ws === ws) matchmaking.splice(i, 1);
    }
}

function endRoom(room, winnerId = null) {
    if (!room) return;
    for (const p of room.players) {
        send(p.ws, {
            type: 'battle_result',
            winner: winnerId ? room.players.find(x => x.id === winnerId)?.data.username : null
        });
        players.delete(p.id);
    }
    rooms.delete(room.code);
}

function roomSnapshot(room) {
    return room.players.map(p => ({
        id: p.id,
        username: p.data.username,
        card: p.data.card,
        pet: p.data.pet,
        trophies: p.data.trophies,
        hp: p.hp,
        maxHp: p.maxHp
    }));
}

function startRoomBattle(room) {
    if (!room || room.players.length !== 2 || room.started) return;
    room.started = true;
    room.turn = 0;
    room.round = 1;
    room.players[0].maxHp = 100;
    room.players[1].maxHp = 100;
    room.players[0].hp = 100;
    room.players[1].hp = 100;

    const snapshot = roomSnapshot(room);
    for (const p of room.players) {
        send(p.ws, {
            type: 'multiplayer_battle_start',
            room: room.code,
            you: p.id,
            opponent: snapshot.find(x => x.id !== p.id),
            turn: room.turn,
            turnPlayerId: room.players[room.turn]?.id || null,
            state: snapshot
        });
    }
}

function findRoomFor(ws) {
    const id = players.get(ws)?.id;
    for (const room of rooms.values()) {
        if (room.players.some(p => p.id === id)) return room;
    }
    return null;
}

function cardDamage(kind) {
    if (kind === 'power') return 30;
    if (kind === 'pet') return 22;
    return 20;
}

function handleBattleAction(ws, msg) {
    const room = findRoomFor(ws);
    if (!room || !room.started || room.players.length !== 2) {
        send(ws, { type: 'error', message: 'No active multiplayer battle.' });
        return;
    }

    const me = players.get(ws);
    const index = room.players.findIndex(p => p.id === me.id);
    if (index !== room.turn) {
        send(ws, { type: 'error', message: 'It is not your turn.' });
        return;
    }

    const other = room.players[index === 0 ? 1 : 0];
    const damage = cardDamage(msg.action);
    other.hp = Math.max(0, other.hp - damage);

    if (other.hp <= 0) {
        for (const p of room.players) {
            send(p.ws, {
                type: 'multiplayer_battle_state',
                state: roomSnapshot(room),
                turn: room.turn,
                log: `${me.data.username} dealt ${damage} damage and won.`
            });
        }
        endRoom(room, me.id);
        return;
    }

    room.turn = room.turn === 0 ? 1 : 0;
    room.round += 1;

    for (const p of room.players) {
        send(p.ws, {
            type: 'multiplayer_battle_state',
            state: roomSnapshot(room),
            turn: room.turn,
            turnPlayerId: room.players[room.turn]?.id || null,
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

    const type = msg.type;

    if (type === 'create_room') {
        const player = safePlayer(msg.player || msg);
        const id = ws._playerId || Math.random().toString(36).slice(2);
        ws._playerId = id;
        players.set(ws, { id, ws, data: player });

        const code = makeCode();
        const room = {
            code,
            players: [{ id, ws, data: player, hp: 100, maxHp: 100 }],
            started: false,
            turn: 0,
            round: 0
        };
        rooms.set(code, room);

        send(ws, { type: 'room_created', room: code });
        return;
    }

    if (type === 'join_room') {
        const code = String(msg.room || msg.roomCode || '').trim().toUpperCase();
        const room = rooms.get(code);
        if (!room) {
            send(ws, { type: 'error', message: 'Room not found.' });
            return;
        }
        if (room.players.length >= 2) {
            send(ws, { type: 'error', message: 'Room is full.' });
            return;
        }

        const player = safePlayer(msg.player || msg);
        const id = ws._playerId || Math.random().toString(36).slice(2);
        ws._playerId = id;
        players.set(ws, { id, ws, data: player });
        room.players.push({ id, ws, data: player, hp: 100, maxHp: 100 });

        send(ws, { type: 'room_joined', room: code });
        send(room.players[0].ws, { type: 'opponent_joined', room: code, opponent: player });
        startRoomBattle(room);
        return;
    }

    if (type === 'matchmake') {
        removeFromMatchmaking(ws);
        const player = safePlayer(msg.player || msg);
        const id = ws._playerId || Math.random().toString(36).slice(2);
        ws._playerId = id;
        players.set(ws, { id, ws, data: player });

        const other = matchmaking.shift();
        if (!other || other.ws.readyState !== WebSocket.OPEN) {
            matchmaking.push({ ws, player, id });
            send(ws, { type: 'matchmaking', message: 'SEARCHING FOR PLAYER...' });
            return;
        }

        const code = makeCode();
        const room = {
            code,
            players: [
                { id, ws, data: player, hp: 100, maxHp: 100 },
                { id: other.id, ws: other.ws, data: other.player, hp: 100, maxHp: 100 }
            ],
            started: false,
            turn: 0,
            round: 0
        };
        rooms.set(code, room);
        send(ws, { type: 'match_found', room: code, opponent: other.player });
        send(other.ws, { type: 'match_found', room: code, opponent: player });
        startRoomBattle(room);
        return;
    }

    if (type === 'battle_action') {
        handleBattleAction(ws, msg);
        return;
    }

    if (type === 'leave_room') {
        const room = findRoomFor(ws);
        if (room) endRoom(room, null);
        return;
    }

    send(ws, { type: 'error', message: 'Unknown message type: ' + type });
}

const server = http.createServer((req, res) => {
    if (req.url.split('?')[0] === '/health') {
        res.writeHead(200, {'Content-Type':'application/json; charset=utf-8'});
        res.end(JSON.stringify({ok:true, service:'candy-cards-online'}));
        return;
    }
    const requested = decodeURIComponent(req.url.split('?')[0]);
    let file = requested === '/' ? '/index.html' : requested;
    const normalized = path.normalize(file).replace(/^([.][.][/\\])+/, '');
    const full = path.join(ROOT, normalized);

    if (!full.startsWith(ROOT)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    fs.readFile(full, (err, data) => {
        if (err) {
            res.writeHead(404, {'Content-Type':'text/plain'});
            res.end('Not found');
            return;
        }
        const ext = path.extname(full).toLowerCase();
        const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg'};
        res.writeHead(200, {'Content-Type': types[ext] || 'application/octet-stream'});
        res.end(data);
    });
});

const wss = new WebSocket.Server({ server });

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
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', data => handleMessage(ws, data.toString()));
    ws.on('close', () => {
        removeFromMatchmaking(ws);
        const room = findRoomFor(ws);
        if (room) {
            const leaving = players.get(ws)?.id;
            const other = room.players.find(p => p.ws !== ws);
            if (other) send(other.ws, { type: 'opponent_left', message: 'Opponent disconnected.' });
            rooms.delete(room.code);
            if (leaving) players.delete(ws);
        }
    });
    send(ws, { type: 'connected', message: 'Candy Cards server connected.' });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log('🍭 Candy Cards Online Server');
    console.log('--------------------------------');
    console.log(`Server running on port ${PORT}`);
    console.log(`Local: http://localhost:${PORT}`);
    console.log('--------------------------------');
});
