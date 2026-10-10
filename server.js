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

function makeRoom(code, first, second = null, mode = 'battle') {
    const room = {
        code, mode: mode === 'waves' ? 'waves' : 'battle',
        players: [], started: false, turn: 0, round: 0,
        wave: 1, enemy: null
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
    if (!room || room.started || room.mode !== 'battle') return;

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

    const winner = winnerId
        ? room.players.find(player => player.id === winnerId)
        : null;

    // Send a PERSONAL result to each player. Never compare usernames:
    // two people can have the same display name (including "CandyPlayer").
    for (const player of room.players) {
        const hasWinner = Boolean(winner);
        const youWon = hasWinner ? player.id === winner.id : null;
        const result = !hasWinner ? 'ended' : (youWon ? 'win' : 'loss');

        send(player.ws, {
            type: 'battle_result',
            winner: winner ? winner.data.username : null,
            winnerId: winner ? winner.id : null,
            youWon,
            result,
            message: result === 'win'
                ? 'YOU WIN!'
                : result === 'loss'
                    ? 'YOU LOSE!'
                    : 'BATTLE ENDED'
        });

        if (reason && player.id !== winnerId) {
            send(player.ws, { type: 'opponent_left', message: reason });
        }
        players.delete(player.ws);
    }

    rooms.delete(room.code);
    console.log(`Room ${room.code} closed. Winner: ${winner ? winner.data.username : 'none'}.`);
}

function cardDamage(action) {
    if (action === 'power') return 30;
    if (action === 'pet') return 22;
    return 20;
}

function waveEnemy(wave) {
    const bosses={5:'Broccoli King',10:'Steak Titan',15:'Candy Crusher',20:'Toxic Broccoli',25:'Golden Steak',30:'Fire Candy',35:'Galaxy Beast',40:'Shadow Food',45:'Diamond Destroyer',50:'The Candy Apocalypse'};
    const normal=['Broccoli','Carrot Goblin','Angry Tomato','Cheese Beast','Cookie Monster'];
    const boss=Boolean(bosses[wave]), hp=(boss?180:65)+wave*(boss?28:18);
    return {name:bosses[wave]||normal[(wave-1)%normal.length],boss,hp,maxHp:hp};
}
function waveSnapshot(room){return {room:room.code,wave:room.wave,enemy:room.enemy,players:room.players.map(p=>({id:p.id,username:p.data.username,card:p.data.card,pet:p.data.pet,hp:p.hp,maxHp:p.maxHp}))};}
function broadcastWave(room,log=''){const state=waveSnapshot(room);for(const p of room.players)send(p.ws,{type:'multiplayer_waves_state',you:p.id,state,log});}
function startCoopWaves(room){
    if(!room||room.started||room.mode!=='waves'||room.players.length!==2)return;
    if(new Set(room.players.map(p=>p.ws)).size!==2||new Set(room.players.map(p=>p.id)).size!==2)return;
    room.started=true;room.wave=1;room.enemy=waveEnemy(1);
    for(const p of room.players){p.hp=100;p.maxHp=100;}
    const state=waveSnapshot(room);
    for(const p of room.players)send(p.ws,{type:'multiplayer_waves_start',you:p.id,state});
    console.log(`Co-op waves started in room ${room.code}: ${room.players.map(p=>p.data.username).join(' + ')}`);
}
function handleWaveAction(ws,msg){
    const room=findRoomFor(ws);
    if(!room||!room.started||room.mode!=='waves'||room.players.length!==2){send(ws,{type:'error',message:'No active co-op waves game.'});return;}
    const me=room.players.find(p=>p.ws===ws);
    if(!me){send(ws,{type:'error',message:'You are not in this room.'});return;}
    if(me.hp<=0){send(ws,{type:'error',message:'You are knocked out. Your teammate must keep fighting.'});return;}
    const action=['strike','power','pet','heal'].includes(msg.action)?msg.action:'strike';
    const damage=action==='power'?36:action==='pet'?27:20;let log='';
    if(action==='heal'){
        const ally=room.players.find(p=>p.id!==me.id);
        me.hp=Math.min(me.maxHp,me.hp+18);if(ally)ally.hp=Math.min(ally.maxHp,ally.hp+10);
        log=`${me.data.username} used a team heal!`;
    }else{
        room.enemy.hp=Math.max(0,room.enemy.hp-damage);
        log=`${me.data.username} hit ${room.enemy.name} for ${damage} damage.`;
        if(room.enemy.hp<=0){const cleared=room.wave++;room.enemy=waveEnemy(room.wave);for(const p of room.players)p.hp=Math.min(p.maxHp,p.hp+12);log+=` Wave ${cleared} cleared! Wave ${room.wave} begins!`;}
        const enemyDamage=Math.min(18,4+Math.floor(room.wave/3)+(room.enemy.boss?3:0));
        for(const p of room.players)if(p.hp>0)p.hp=Math.max(0,p.hp-enemyDamage);
    }
    broadcastWave(room,log);
    if(room.players.every(p=>p.hp<=0)){
        for(const p of room.players)send(p.ws,{type:'multiplayer_waves_result',wave:room.wave,message:`TEAM DEFEATED! YOU REACHED WAVE ${room.wave}.`});
        for(const p of room.players)players.delete(p.ws);rooms.delete(room.code);
    }
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

    if (type === 'wave_action') { handleWaveAction(ws, msg); return; }

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
        const mode = msg.mode === 'waves' ? 'waves' : 'battle';
        makeRoom(code, { id, ws, data }, null, mode);
        send(ws, { type: 'room_created', room: code, mode });
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
        const requestedMode = msg.mode === 'waves' ? 'waves' : 'battle';
        if (room.mode !== requestedMode) {
            send(ws, { type: 'error', message: room.mode === 'waves' ? 'This is a Waves Multiplayer room.' : 'This is a Battling Multiplayer room.' });
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
        if (room.mode === 'waves') startCoopWaves(room);
        else startRoomBattle(room);
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

        const mode = msg.mode === 'waves' ? 'waves' : 'battle';
        let other = null;
        const waitingCount = matchmaking.length;
        for (let i = 0; i < waitingCount; i++) {
            const candidate = matchmaking.shift();
            if (candidate.ws !== ws && candidate.mode === mode &&
                candidate.ws.readyState === WebSocket.OPEN &&
                !findRoomFor(candidate.ws) && players.has(candidate.ws)) {
                other = candidate; break;
            }
            if (candidate.ws.readyState === WebSocket.OPEN &&
                !findRoomFor(candidate.ws) && players.has(candidate.ws)) matchmaking.push(candidate);
        }

        if (!other) {
            matchmaking.push({ ws, id, data, mode });
            send(ws, { type: 'matchmaking', message: mode === 'waves' ? 'SEARCHING FOR A WAVES TEAMMATE...' : 'SEARCHING FOR PLAYER...' });
            return;
        }

        const code = makeCode();
        const room = makeRoom(code,
            { ws, id, data },
            { ws: other.ws, id: other.id, data: other.data },
            mode
        );
        send(ws, { type: 'match_found', room: code, opponent: other.data });
        send(other.ws, { type: 'match_found', room: code, opponent: data });
        console.log(`Matchmaking created room ${code}.`);
        if (room.mode === 'waves') startCoopWaves(room);
        else startRoomBattle(room);
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
