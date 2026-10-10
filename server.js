'use strict';

// Candy Cards Online multiplayer server.
// Keep this file as plain UTF-8 text, not an RTF document.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const Stripe = require('stripe');
const { Pool } = require('pg');
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const APP_BASE_URL = (process.env.APP_BASE_URL || 'https://candy-cards-online.onrender.com').replace(/\/+$/, '');
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;
const pool = process.env.DATABASE_URL ? new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 5
}) : null;

const USD_GEM_PACKAGES = Object.freeze({
    starter: { id: 'starter', name: 'Starter Gem Pack', gems: 500, amount: 99 },
    popular: { id: 'popular', name: 'Popular Gem Pack', gems: 1800, amount: 299 },
    mega: { id: 'mega', name: 'Mega Gem Pack', gems: 3500, amount: 499 },
    ultra: { id: 'ultra', name: 'Ultra Gem Pack', gems: 8000, amount: 999 },
    legendary: { id: 'legendary', name: 'Legendary Gem Pack', gems: 18000, amount: 1999 }
});
function paymentsConfigured(){return Boolean(stripe&&STRIPE_WEBHOOK_SECRET&&pool);}
let paymentSchemaPromise=null;
async function ensurePaymentSchema(){
    if(!pool)throw new Error('Paid-gem database is not configured.');
    if(!paymentSchemaPromise)paymentSchemaPromise=pool.query(`
      CREATE TABLE IF NOT EXISTS candy_paid_gem_wallets(
        player_id TEXT PRIMARY KEY, paid_gems BIGINT NOT NULL DEFAULT 0 CHECK(paid_gems>=0),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS candy_gem_purchase_orders(
        session_id TEXT PRIMARY KEY, player_id TEXT NOT NULL, package_id TEXT NOT NULL,
        gems INTEGER NOT NULL, amount_cents INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), paid_at TIMESTAMPTZ
      );
      ALTER TABLE candy_gem_purchase_orders ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;
      CREATE INDEX IF NOT EXISTS candy_gem_orders_player_idx
        ON candy_gem_purchase_orders(player_id,created_at DESC);
      CREATE TABLE IF NOT EXISTS candy_gem_subscriptions(
        stripe_subscription_id TEXT PRIMARY KEY, player_id TEXT NOT NULL, package_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS candy_gem_subscription_invoices(
        stripe_invoice_id TEXT PRIMARY KEY, stripe_subscription_id TEXT NOT NULL,
        player_id TEXT NOT NULL, gems INTEGER NOT NULL, amount_cents INTEGER NOT NULL,
        paid_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await paymentSchemaPromise;
}
function sendJson(res,status,payload){
    res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    res.end(JSON.stringify(payload));
}
function readRequestBody(req,limit=16384){
    return new Promise((resolve,reject)=>{
        const chunks=[];let length=0;let tooLarge=false;
        req.on('data',chunk=>{
            if(tooLarge)return;
            length+=chunk.length;
            if(length>limit){tooLarge=true;reject(new Error('Request body is too large.'));return;}
            chunks.push(chunk);
        });
        req.on('end',()=>{if(!tooLarge)resolve(Buffer.concat(chunks));});
        req.on('error',reject);
        req.on('aborted',()=>reject(new Error('Request was aborted.')));
    });
}
function validPlayerId(v){return typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);}
async function fulfillPaidGemCheckout(session){
    if(!pool||!session||session.mode!=='payment'||session.payment_status!=='paid'||session.currency!=='usd')return;
    const playerId=session.metadata&&session.metadata.player_id;
    const packageId=session.metadata&&session.metadata.package_id;
    const product=USD_GEM_PACKAGES[packageId];
    if(!validPlayerId(playerId)||!product)throw new Error('Invalid one-time gem purchase metadata.');
    if(Number(session.amount_total)!==product.amount)throw new Error('Payment amount does not match server catalog.');
    await ensurePaymentSchema();
    const client=await pool.connect();
    try{
        await client.query('BEGIN');
        const order=await client.query('SELECT * FROM candy_gem_purchase_orders WHERE session_id=$1 FOR UPDATE',[session.id]);
        if(!order.rows.length)throw new Error('Gem purchase order was not found.');
        const known=order.rows[0];
        if(known.player_id!==playerId||known.package_id!==product.id||Number(known.gems)!==product.gems||Number(known.amount_cents)!==product.amount)
            throw new Error('Purchase order does not match the paid checkout.');
        if(known.status!=='fulfilled'){
            await client.query('INSERT INTO candy_paid_gem_wallets(player_id,paid_gems) VALUES($1,0) ON CONFLICT(player_id) DO NOTHING',[playerId]);
            await client.query('UPDATE candy_paid_gem_wallets SET paid_gems=paid_gems+$2,updated_at=NOW() WHERE player_id=$1',[playerId,product.gems]);
            await client.query("UPDATE candy_gem_purchase_orders SET status='fulfilled',paid_at=NOW() WHERE session_id=$1",[session.id]);
        }
        await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

async function handlePaymentApi(req,res,pathname){
    if(pathname==='/api/purchase/config'&&req.method==='GET'){
        sendJson(res,200,{enabled:paymentsConfigured(),currency:'USD',packages:Object.values(USD_GEM_PACKAGES).map(p=>({id:p.id,name:p.name,gems:p.gems,priceCents:p.amount}))});return;
    }
    if(pathname==='/api/stripe/webhook'&&req.method==='POST'){
        if(!stripe||!STRIPE_WEBHOOK_SECRET||!pool){sendJson(res,503,{error:'Payment processing is not configured.'});return;}
        const raw=await readRequestBody(req,1024*1024);
        let event;
        try{event=stripe.webhooks.constructEvent(raw,req.headers['stripe-signature'],STRIPE_WEBHOOK_SECRET);}
        catch{sendJson(res,400,{error:'Invalid Stripe webhook signature.'});return;}
        if(event.type==='checkout.session.completed'||event.type==='checkout.session.async_payment_succeeded'){
            await fulfillPaidGemCheckout(event.data.object);
        }
        sendJson(res,200,{received:true});return;
    }
    if(!paymentsConfigured()){sendJson(res,503,{error:'USD checkout is not enabled yet. Payment provider and persistent database setup are required.'});return;}
    await ensurePaymentSchema();
    if(pathname==='/api/purchase/create'&&req.method==='POST'){
        const raw=await readRequestBody(req);let body;
        try{body=JSON.parse(raw.toString('utf8'));}catch{sendJson(res,400,{error:'Invalid JSON.'});return;}
        const playerId=body&&body.playerId,product=USD_GEM_PACKAGES[body&&body.packageId];
        if(!validPlayerId(playerId)||!product){sendJson(res,400,{error:'Invalid player ID or gem package.'});return;}
        const session=await stripe.checkout.sessions.create({
            mode:'payment',payment_method_types:['card'],
            line_items:[{quantity:1,price_data:{
                currency:'usd',unit_amount:product.amount,
                product_data:{name:product.name,description:product.gems.toLocaleString('en-US')+' Candy Cards gems (one-time purchase)'}
            }}],
            metadata:{player_id:playerId,package_id:product.id,gems:String(product.gems)},
            success_url:APP_BASE_URL+'/?cashgems=success&session_id={CHECKOUT_SESSION_ID}',
            cancel_url:APP_BASE_URL+'/?cashgems=cancelled'
        });
        await pool.query("INSERT INTO candy_gem_purchase_orders(session_id,player_id,package_id,gems,amount_cents,status) VALUES($1,$2,$3,$4,$5,'pending') ON CONFLICT(session_id) DO NOTHING",
            [session.id,playerId,product.id,product.gems,product.amount]);
        sendJson(res,200,{url:session.url});return;
    }
    if(pathname==='/api/paid-gems/wallet'&&req.method==='GET'){
        const playerId=new URL(req.url,'http://localhost').searchParams.get('playerId')||'';
        if(!validPlayerId(playerId)){sendJson(res,400,{error:'Invalid player ID.'});return;}
        const r=await pool.query('SELECT paid_gems FROM candy_paid_gem_wallets WHERE player_id=$1',[playerId]);
        sendJson(res,200,{paidGems:Number(r.rows[0]?.paid_gems||0)});return;
    }
    if(pathname==='/api/purchase/status'&&req.method==='GET'){
        const u=new URL(req.url,'http://localhost'),playerId=u.searchParams.get('playerId')||'',sessionId=u.searchParams.get('sessionId')||'';
        if(!validPlayerId(playerId)||!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)){sendJson(res,400,{error:'Invalid purchase lookup.'});return;}
        const r=await pool.query('SELECT gems,status FROM candy_gem_purchase_orders WHERE session_id=$1 AND player_id=$2',[sessionId,playerId]);
        if(!r.rows.length){sendJson(res,404,{status:'pending'});return;}
        const status=r.rows[0].status;
        const w=await pool.query('SELECT paid_gems FROM candy_paid_gem_wallets WHERE player_id=$1',[playerId]);
        sendJson(res,200,{status,gems:Number(r.rows[0].gems),paidGems:Number(w.rows[0]?.paid_gems||0)});return;
    }
    if(pathname==='/api/paid-gems/spend'&&req.method==='POST'){
        const raw=await readRequestBody(req);let body;
        try{body=JSON.parse(raw.toString('utf8'));}catch{sendJson(res,400,{error:'Invalid JSON.'});return;}
        const playerId=body&&body.playerId,amount=Number(body&&body.amount);
        if(!validPlayerId(playerId)||!Number.isSafeInteger(amount)||amount<1||amount>100000){sendJson(res,400,{error:'Invalid wallet request.'});return;}
        const r=await pool.query('UPDATE candy_paid_gem_wallets SET paid_gems=paid_gems-$2,updated_at=NOW() WHERE player_id=$1 AND paid_gems >= $2 RETURNING paid_gems',[playerId,amount]);
        if(!r.rows.length){sendJson(res,409,{error:'Not enough paid gems.'});return;}
        sendJson(res,200,{paidGems:Number(r.rows[0].paid_gems)});return;
    }
    sendJson(res,404,{error:'Not found.'});
}


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
    const cleanString = (value, fallback, max = 80) =>
        typeof value === 'string' ? value.slice(0, max) : fallback;
    return {
        username: cleanName(player.username),
        card: cleanString(player.card, 'Red Lollipop'),
        pet: cleanString(player.pet, null),
        trophies: clampNumber(player.trophies, 0, 0, 999999),
        playerMaxHealth: clampNumber(player.player_max_health, 100, 1, 5000),
        playerHealth: clampNumber(player.player_health, 100, 0, 5000),
        playerDamage: clampNumber(player.player_damage, 20, 1, 100000),
        playerSpeed: clampNumber(player.player_speed, 5, 0.1, 100),
        playerRange: clampNumber(player.player_attack_range, 95, 20, 600),
        skin: cleanString(player.equipped_skin, 'Classic Lollipop'),
        cosmetic: cleanString(player.equipped_cosmetic, 'None'),
        worldHeight: clampNumber(player.worldHeight, 720, 360, 1800),
        currentWave: clampNumber(player.current_wave, 1, 1, 300)
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
        wave: 1, enemy: null, enemies: [], height: 720,
        lastTickAt: Date.now(), pendingLog: ''
    };

    for (const item of [first, second].filter(Boolean)) {
        if (room.players.some(p => p.ws === item.ws || p.id === item.id)) continue;
        room.players.push({
            id: item.id,
            ws: item.ws,
            data: item.data,
            hp: 100,
            maxHp: 100
        });
    }

    if (room.players[0]?.data?.worldHeight) {
        room.height = room.players[0].data.worldHeight;
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

const WAVE_WIDTH = 1280;
const MAX_COOP_WAVES = 300;
const KNOWN_BOSSES = {
    5: 'BROCCOLI KING', 10: 'STEAK TITAN', 15: 'CANDY CRUSHER',
    20: 'TOXIC BROCCOLI', 25: 'GOLDEN STEAK', 30: 'FIRE CANDY',
    35: 'GALAXY BEAST', 40: 'SHADOW FOOD', 45: 'DIAMOND DESTROYER',
    50: 'THE CANDY APOCALYPSE'
};
const BOSS_ADJECTIVES_SERVER = ['CRYSTAL','STORM','INFERNAL','VOID','PRISMATIC','TOXIC','NEON','COSMIC','FROST','SHADOW','RADIANT','GLITCHED','THUNDER','NOVA','ETERNAL','CHAOS','DIAMOND','PHANTOM','ASTRAL','OMEGA'];
const BOSS_CREATURES_SERVER = ['BROCCOLI EMPEROR','STEAK COLOSSUS','CANDY HYDRA','SUGAR BEAST','LOLLIPOP DESTROYER','COOKIE TITAN','GUMDROP MONARCH','CHOCOLATE DRAGON','JELLY OVERLORD','CARAMEL DEVOURER','MARSHMALLOW GIANT','CANDY PHOENIX','FROST WOLF','RAINBOW GOLEM','COSMIC BEHEMOTH'];

function waveBossName(wave) {
    if (KNOWN_BOSSES[wave]) return KNOWN_BOSSES[wave];
    if (wave === MAX_COOP_WAVES) return 'THE ULTIMATE CANDY GOD';
    const i = Math.max(0, Math.floor(wave / 5) - 11);
    const adjective = BOSS_ADJECTIVES_SERVER[i % BOSS_ADJECTIVES_SERVER.length];
    const creature = BOSS_CREATURES_SERVER[Math.floor(i / BOSS_ADJECTIVES_SERVER.length) % BOSS_CREATURES_SERVER.length];
    const tier = Math.floor((wave - 1) / 50) + 1;
    return `${adjective} ${creature} — TIER ${tier}`;
}

function spawnCoopEnemy(room, type, boss = false) {
    const width = WAVE_WIDTH;
    const height = room.height || 720;
    const side = Math.floor(Math.random() * 4);
    let x, y;
    if (side === 0) { x = 50 + Math.random() * (width - 100); y = 100; }
    else if (side === 1) { x = width - 50; y = 100 + Math.random() * (height - 150); }
    else if (side === 2) { x = 50 + Math.random() * (width - 100); y = height - 50; }
    else { x = 50; y = 100 + Math.random() * (height - 150); }

    const w = room.wave;
    const e = { type, x, y, boss, alive: true, attackTimer: boss ? 0.7 : 0.2 + Math.random() * 0.8 };
    if (type === 'final_boss') {
        e.radius = 82;
        e.maxHealth = 3000 + w * 100;
        e.health = e.maxHealth;
        e.speed = 0.65 + Math.min(0.45, w / 1000);
        e.damage = 85 + Math.floor(w / 10);
    } else if (type === 'broccoli') {
        e.radius = 28;
        e.maxHealth = 35 + w * 5;
        e.health = e.maxHealth;
        e.speed = 1.2 + w * 0.025;
        e.damage = 7 + Math.floor(w / 4);
    } else {
        e.radius = 30;
        e.maxHealth = 50 + w * 7;
        e.health = e.maxHealth;
        e.speed = 0.9 + w * 0.02;
        e.damage = 10 + Math.floor(w / 3);
    }
    if (boss && type !== 'final_boss') {
        const tier = Math.max(1, Math.floor((w - 1) / 50) + 1);
        e.maxHealth *= 5 + Math.min(10, tier - 1);
        e.health = e.maxHealth;
        e.radius *= 1.55 + Math.min(0.35, tier * 0.025);
        e.speed *= Math.max(0.60, 0.75 - tier * 0.01);
        e.damage *= 2 + Math.min(3, Math.floor((tier - 1) / 2));
    }
    e.name = boss ? waveBossName(w) : (type === 'broccoli' ? 'BROCCOLI' : 'STEAK MONSTER');
    e.color = boss ? '#ffcc49' : (type === 'broccoli' ? '#32b34a' : '#b96432');
    return e;
}

function spawnCoopWave(room) {
    room.enemies = [];
    const w = room.wave;
    const count = Math.min(50, 5 + w * 2);
    if (w === MAX_COOP_WAVES) {
        room.enemies.push(spawnCoopEnemy(room, 'final_boss', true));
        for (let i = 0; i < 12; i++) room.enemies.push(spawnCoopEnemy(room, Math.random() < 0.5 ? 'broccoli' : 'steak'));
        return;
    }
    if (w % 5 === 0) {
        room.enemies.push(spawnCoopEnemy(room, Math.random() < 0.5 ? 'broccoli' : 'steak', true));
        for (let i = 0; i < Math.max(1, count - 1); i++) {
            room.enemies.push(spawnCoopEnemy(room, Math.random() < 0.5 ? 'broccoli' : 'steak'));
        }
    } else {
        for (let i = 0; i < count; i++) {
            room.enemies.push(spawnCoopEnemy(room, Math.random() < 0.5 ? 'broccoli' : 'steak'));
        }
    }
    room.enemy = room.enemies.find(e => e.boss) || room.enemies[0] || null;
}

function waveSnapshot(room) {
    return {
        room: room.code, wave: room.wave, width: WAVE_WIDTH, height: room.height,
        enemy: room.enemies.find(e => e.boss) || room.enemies[0] || null,
        enemies: room.enemies,
        players: room.players.map(p => ({
            id: p.id, username: p.data.username, card: p.data.card, pet: p.data.pet,
            trophies: p.data.trophies, hp: p.hp, maxHp: p.maxHp,
            x: p.x, y: p.y, damage: p.damage, speed: p.speed, range: p.range,
            skin: p.data.skin, cosmetic: p.data.cosmetic,
            candyEarned: p.candyEarned || 0
        }))
    };
}

function broadcastWave(room, log = '') {
    const state = waveSnapshot(room);
    for (const p of room.players) send(p.ws, { type: 'multiplayer_waves_state', you: p.id, state, log });
}

function startCoopWaves(room) {
    if (!room || room.started || room.mode !== 'waves' || room.players.length !== 2) return;
    if (new Set(room.players.map(p => p.ws)).size !== 2 || new Set(room.players.map(p => p.id)).size !== 2) return;

    room.started = true;
    room.height = clampNumber(room.players[0]?.data?.worldHeight, 720, 360, 1800);
    room.wave = clampNumber(room.players[0]?.data?.currentWave, 1, 1, MAX_COOP_WAVES);
    room.pendingLog = `CO-OP WAVE ${room.wave} STARTED!`;
    for (let i = 0; i < room.players.length; i++) {
        const p = room.players[i];
        const d = p.data;
        p.maxHp = clampNumber(d.playerMaxHealth, 100, 1, 5000);
        p.hp = d.playerHealth > 0 ? Math.min(p.maxHp, d.playerHealth) : p.maxHp;
        p.x = WAVE_WIDTH / 2 + (i === 0 ? -100 : 100);
        p.y = room.height / 2;
        p.inputX = 0; p.inputY = 0;
        p.damage = clampNumber(d.playerDamage, 20, 1, 100000);
        p.speed = clampNumber(d.playerSpeed, 5, 0.1, 100);
        p.range = clampNumber(d.playerRange, 95, 20, 600);
        p.attackReadyAt = 0;
        p.candyEarned = 0;
    }
    spawnCoopWave(room);
    room.lastTickAt = Date.now();
    const initialState = waveSnapshot(room);
    for (const p of room.players) {
        send(p.ws, { type: 'multiplayer_waves_start', you: p.id, state: initialState });
    }
    room.pendingLog = '';
    console.log(`Co-op waves started in room ${room.code}: ${room.players.map(p => p.data.username).join(' + ')}`);
}

function handleWaveAction(ws, msg) {
    const room = findRoomFor(ws);
    if (!room || !room.started || room.mode !== 'waves' || room.players.length !== 2) {
        send(ws, { type: 'error', message: 'No active co-op waves game.' });
        return;
    }
    const me = room.players.find(p => p.ws === ws);
    if (!me) { send(ws, { type: 'error', message: 'You are not in this room.' }); return; }

    if (msg.type === 'wave_move') {
        if (me.hp <= 0) { me.inputX = 0; me.inputY = 0; return; }
        let dx = clampNumber(msg.dx, 0, -1, 1);
        let dy = clampNumber(msg.dy, 0, -1, 1);
        const length = Math.hypot(dx, dy);
        if (length > 1) { dx /= length; dy /= length; }
        me.inputX = dx;
        me.inputY = dy;
        return;
    }

    if (me.hp <= 0) { send(ws, { type: 'error', message: 'You are knocked out. Your teammate must keep fighting.' }); return; }
    const now = Date.now();
    if (now < (me.attackReadyAt || 0)) return;
    me.attackReadyAt = now + 350;

    let hits = 0;
    const range = me.range || 95;
    const damage = me.damage || 20;
    for (const e of room.enemies) {
        if (!e.alive || e.health <= 0) continue;
        if (Math.hypot(e.x - me.x, e.y - me.y) > range + e.radius) continue;
        e.health = Math.max(0, e.health - damage);
        hits++;
        if (e.health <= 0) {
            e.alive = false;
            me.candyEarned = (me.candyEarned || 0) + (e.boss ? (8 + Math.floor(room.wave / 2)) : 1);
        }
    }
    const remaining = room.enemies.filter(e => e.alive && e.health > 0).length;
    broadcastWave(room, hits ? `${me.data.username} attacked! ${remaining} enemies remain.` : `${me.data.username} swung but missed.`);
}

function tickCoopWaves() {
    const now = Date.now();
    for (const room of rooms.values()) {
        if (!room.started || room.mode !== 'waves' || room.players.length !== 2) continue;
        const dt = Math.max(0, Math.min(0.12, (now - (room.lastTickAt || now)) / 1000));
        room.lastTickAt = now;
        const livePlayers = room.players.filter(p => p.hp > 0);

        for (const p of room.players) {
            if (p.hp <= 0) { p.inputX = 0; p.inputY = 0; continue; }
            const dx = p.inputX || 0, dy = p.inputY || 0;
            const len = Math.hypot(dx, dy);
            const nx = len > 1 ? dx / len : dx;
            const ny = len > 1 ? dy / len : dy;
            p.x = Math.max(50, Math.min(WAVE_WIDTH - 50, p.x + nx * p.speed * 60 * dt));
            p.y = Math.max(100, Math.min(room.height - 70, p.y + ny * p.speed * 60 * dt));
        }

        for (const e of room.enemies) {
            if (!e.alive || e.health <= 0 || livePlayers.length === 0) continue;
            let target = null, best = Infinity;
            for (const p of livePlayers) {
                const d = Math.hypot(p.x - e.x, p.y - e.y);
                if (d < best) { best = d; target = p; }
            }
            if (!target) continue;
            if (best > e.radius + 45 && best > 1) {
                e.x += ((target.x - e.x) / best) * e.speed * 60 * dt;
                e.y += ((target.y - e.y) / best) * e.speed * 60 * dt;
            }
            e.attackTimer -= dt;
            if (best < e.radius + 45 && e.attackTimer <= 0) {
                target.hp = Math.max(0, target.hp - e.damage);
                e.attackTimer = e.type === 'final_boss' ? 0.75 : 1.0;
            }
        }

        room.enemies = room.enemies.filter(e => e.alive && e.health > 0);
        if (room.enemies.length === 0) {
            if (room.wave >= MAX_COOP_WAVES) {
                const state = waveSnapshot(room);
                for (const p of room.players) {
                    send(p.ws, { type: 'multiplayer_waves_state', you: p.id, state, log: 'FINAL BOSS DEFEATED!' });
                    send(p.ws, { type: 'multiplayer_waves_result', wave: room.wave, won: true, message: 'TEAM VICTORY! YOU CLEARED ALL 300 WAVES!' });
                    players.delete(p.ws);
                }
                rooms.delete(room.code);
                continue;
            }
            const cleared = room.wave;
            room.wave++;
            for (const p of room.players) if (p.hp > 0) p.hp = Math.min(p.maxHp, p.hp + Math.floor(p.maxHp * 0.2));
            spawnCoopWave(room);
            room.pendingLog = `WAVE ${cleared} CLEARED! WAVE ${room.wave} STARTED!`;
        }

        if (room.players.every(p => p.hp <= 0)) {
            for (const p of room.players) {
                send(p.ws, { type: 'multiplayer_waves_result', wave: room.wave, won: false, message: `TEAM DEFEATED! YOU REACHED WAVE ${room.wave}.` });
                players.delete(p.ws);
            }
            rooms.delete(room.code);
            continue;
        }

        if (room.pendingLog) {
            broadcastWave(room, room.pendingLog);
            room.pendingLog = '';
        } else {
            broadcastWave(room);
        }
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

    if (type === 'wave_action' || type === 'wave_move' || type === 'wave_attack') { handleWaveAction(ws, msg); return; }

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

    if (pathname.startsWith('/api/')) {
        handlePaymentApi(req,res,pathname).catch(error=>{
            console.error('Payment API error:',error.message);
            if(!res.headersSent)sendJson(res,500,{error:'Payment request failed. No card details are stored by Candy Cards.'});
        });
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
const waveTicker = setInterval(tickCoopWaves, 80);
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

wss.on('close', () => { clearInterval(heartbeat); clearInterval(waveTicker); });
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
