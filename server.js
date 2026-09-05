import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import crypto from 'crypto';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));
app.get('/health', (_, res) => res.json({ ok: true, rooms: rooms.size }));

const rooms = new Map();
const MAX_CONNECTIONS_PER_ROOM = 20;
const MAX_ROUNDS = 99;
const DEFAULTS = { initialCoins: 10000, minBet: 100, maxBet: 5000 };
function betOptions(room) {
  const min = room.settings.minBet;
  const max = room.settings.maxBet;
  const vals = [min, Math.min(min * 5, max), Math.min(min * 10, max), Math.min(min * 50, max), max];
  return [...new Set(vals.filter(v => v >= min && v <= max))];
}

const now = () => Date.now();
const uid = () => crypto.randomUUID();
const roomCode = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
};

function makeRoom(code, hostId) {
  return {
    code,
    hostId,
    users: new Map(),
    settings: { mode: 'normal', rounds: 5, allowSpectators: true, dealerId: null, initialCoins: DEFAULTS.initialCoins, minBet: DEFAULTS.minBet, maxBet: DEFAULTS.maxBet },
    phase: 'lobby',
    round: 0,
    dealer: { hand: [], ownerId: null },
    deck: [],
    betting: new Map(),
    pendingActions: new Map(), // playerId -> { action: 'hit'|'stand'|'double'|null, ok: boolean }
    decisionNo: 0,
    timer: null,
    started: false,
    tournament: null,
    cardsRevealed: false,
    log: []
  };
}

function broadcast(room, payload, exceptId = null) {
  const msg = JSON.stringify(payload);
  for (const [id, u] of room.users) {
    if (id === exceptId) continue;
    if (u.ws && u.ws.readyState === 1) u.ws.send(msg);
  }
}

function send(user, payload) {
  if (user.ws?.readyState === 1) user.ws.send(JSON.stringify(payload));
}

function cardValue(card) {
  if (['J', 'Q', 'K'].includes(card.rank)) return 10;
  if (card.rank === 'A') return 11;
  return Number(card.rank);
}

function score(hand) {
  let total = hand.reduce((s, c) => s + cardValue(c), 0);
  let aces = hand.filter(c => c.rank === 'A').length;
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}

function isBlackjack(hand) { return hand.length === 2 && score(hand) === 21; }

function createDeck() {
  const suits = ['♠', '♥', '♦', '♣'];
  const ranks = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
  const d = [];
  for (const suit of suits) for (const rank of ranks) d.push({ rank, suit });
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function draw(room) {
  if (room.deck.length < 10) room.deck = createDeck();
  return room.deck.pop();
}

function activePlayers(room) {
  return [...room.users.values()].filter(u => u.role === 'player' && u.id !== room.settings.dealerId && u.connected);
}

function dealerUser(room) {
  return room.settings.dealerId ? room.users.get(room.settings.dealerId) : null;
}

function visibleState(room, viewer) {
  const users = [...room.users.values()].map(u => ({
    id: u.id,
    name: u.name,
    role: u.role,
    connected: u.connected,
    chips: u.chips,
    bet: room.betting.get(u.id) || 0,
    status: u.status || ''
  }));

  const isObserver = viewer.role === 'spectator';
  const dealerOwner = room.settings.dealerId && viewer.id === room.settings.dealerId;

  const players = [...room.users.values()]
    .filter(u => u.role === 'player')
    .map(u => {
      const mine = u.id === viewer.id;
      const revealAll = isObserver || ['reveal','dealer','result'].includes(room.phase);
      const pending = room.pendingActions.get(u.id) || { action: null, ok: false };
      return {
        id: u.id,
        name: u.name,
        role: u.role,
        chips: u.chips,
        bet: room.betting.get(u.id) || 0,
        status: u.status || '',
        hand: (mine || revealAll) ? u.hand : u.hand.map(() => ({ rank: '?', suit: '?' })),
        score: (mine || revealAll) ? score(u.hand) : null,
        pending: mine ? pending : { action: null, ok: false }
      };
    });

  const dealerReveal = isObserver || dealerOwner || ['reveal','dealer','result'].includes(room.phase);
  return {
    type: 'state',
    roomCode: room.code,
    hostId: room.hostId,
    settings: room.settings,
    phase: room.phase,
    round: room.round,
    maxRounds: room.settings.rounds,
    decisionNo: room.decisionNo,
    users,
    players,
    dealer: {
      ownerId: room.settings.dealerId,
      hand: dealerReveal ? room.dealer.hand : room.dealer.hand.map(() => ({ rank: '?', suit: '?' })),
      score: dealerReveal ? score(room.dealer.hand) : null,
      name: dealerUser(room)?.name || 'CPU Dealer'
    },
    myId: viewer.id,
    myRole: viewer.role,
    myHand: viewer.hand || [],
    myScore: viewer.hand ? score(viewer.hand) : null,
    pending: room.pendingActions.get(viewer.id) || { action: null, ok: false },
    betOptions: betOptions(room),
    logs: room.log.slice(-15)
  };
}

function broadcastState(room) {
  for (const u of room.users.values()) send(u, visibleState(room, u));
}

function log(room, text) {
  room.log.push({ at: now(), text });
  if (room.log.length > 50) room.log.shift();
  broadcast(room, { type: 'chat', system: true, text });
}

function resetUserHands(room) {
  for (const u of room.users.values()) {
    u.hand = [];
    u.status = '';
  }
  room.dealer.hand = [];
  room.betting.clear();
  room.pendingActions.clear();
}

function startRound(room) {
  const players = activePlayers(room).filter(u => u.chips > 0);
  if (!players.length) {
    endGame(room, '勝者なし');
    return;
  }
  room.phase = 'betting';
  room.cardsRevealed = false;
  room.round += 1;
  room.deck = createDeck();
  resetUserHands(room);
  for (const p of players) {
    room.betting.set(p.id, 0);
    p.status = 'betting';
  }
  const d = dealerUser(room);
  if (d) d.status = 'dealer';
  room.started = true;
  log(room, `ラウンド ${room.round} 開始`);
  broadcastState(room);
}

function allBet(room) {
  return activePlayers(room).filter(u => u.chips > 0).every(u => (room.betting.get(u.id) || 0) > 0);
}

function dealInitial(room) {
  room.phase = 'decision';
  room.cardsRevealed = false;
  for (const p of activePlayers(room).filter(u => u.chips > 0)) {
    p.hand = [draw(room), draw(room)];
    p.status = 'waiting';
  }
  room.dealer.hand = [draw(room), draw(room)];
  room.decisionNo = 1;
  room.pendingActions.clear();
  for (const p of activePlayers(room)) room.pendingActions.set(p.id, { action: null, ok: false });
  broadcastState(room);
  startDecisionTimer(room);
}

function applyBet(room, id, amount) {
  const p = room.users.get(id);
  if (!p || p.role !== 'player' || p.id === room.settings.dealerId || room.phase !== 'betting') return { ok:false, error:'現在はベットできません' };
  if (!Number.isInteger(amount) || amount < room.settings.minBet || amount > room.settings.maxBet) return { ok:false, error:`ベットは ${room.settings.minBet.toLocaleString()}～${room.settings.maxBet.toLocaleString()} コインです` };
  const oldBet = room.betting.get(id) || 0;
  const available = p.chips + oldBet;
  if (available < amount) return { ok:false, error:'チップ不足です' };
  p.chips = available - amount;
  room.betting.set(id, amount);
  p.status = 'bet OK';
  if (allBet(room)) dealInitial(room);
  else broadcastState(room);
  return { ok:true };
}

function validAction(room, p, action) {
  if (room.phase !== 'decision' || p.role !== 'player' || p.id === room.settings.dealerId) return false;
  if (p.status !== 'waiting') return false;
  if (!['hit','stand','double'].includes(action)) return false;
  if (action === 'double' && p.hand.length !== 2) return false;
  return true;
}

function allPlayersReady(room) {
  const players = activePlayers(room).filter(p => p.hand.length && p.status === 'waiting' && p.chips >= 0);
  return players.length > 0 && players.every(p => {
    const v = room.pendingActions.get(p.id);
    return v && v.action && v.ok;
  });
}

function startDecisionTimer(room) {
  clearTimeout(room.timer);
  room.timer = setTimeout(() => {
    if (room.phase !== 'decision') return;
    for (const p of activePlayers(room).filter(p => p.hand.length && p.status === 'waiting')) {
      const v = room.pendingActions.get(p.id) || { action: null, ok: false };
      if (!v.action) v.action = 'stand';
      v.ok = true;
      room.pendingActions.set(p.id, v);
    }
    resolveDecision(room);
  }, 15000);
}

function resolveDecision(room) {
  if (room.phase !== 'decision' || !allPlayersReady(room)) return;
  clearTimeout(room.timer);

  // The first collective confirmation reveals everyone's cards.
  // A player who chose HIT remains eligible for another collective decision.
  room.cardsRevealed = true;
  room.phase = 'reveal';
  broadcastState(room);

  const players = activePlayers(room).filter(p => p.hand.length && p.status === 'waiting');
  let needsAnotherDecision = false;
  for (const p of players) {
    const entry = room.pendingActions.get(p.id) || { action: 'stand', ok: true };
    const action = entry.action || 'stand';
    if (action === 'hit') {
      p.hand.push(draw(room));
      if (score(p.hand) > 21) p.status = 'bust';
      else {
        p.status = 'waiting';
        needsAnotherDecision = true;
      }
    } else if (action === 'double') {
      const currentBet = room.betting.get(p.id) || 0;
      if (p.hand.length === 2 && currentBet > 0 && p.chips >= currentBet) {
        room.betting.set(p.id, currentBet * 2);
        p.chips -= currentBet;
        p.hand.push(draw(room));
        p.status = score(p.hand) > 21 ? 'bust' : 'stand';
      } else {
        p.status = 'stand';
      }
    } else {
      p.status = 'stand';
    }
  }

  room.pendingActions.clear();
  room.decisionNo += 1;
  broadcastState(room);

  if (needsAnotherDecision) {
    room.cardsRevealed = false;
    room.phase = 'decision';
    for (const p of activePlayers(room)) {
      if (p.status === 'waiting' && p.hand.length) room.pendingActions.set(p.id, { action: null, ok: false });
    }
    broadcastState(room);
    startDecisionTimer(room);
    return;
  }

  dealerPhase(room);
}
function dealerPhase(room) {
  room.phase = 'dealer';
  const d = dealerUser(room);
  room.pendingActions.clear();
  if (!d) {
    // CPU gets a visible dealer turn instead of jumping straight to result.
    broadcastState(room);
    clearTimeout(room.timer);
    room.timer = setTimeout(() => cpuDealerStep(room), 900);
    return;
  }
  d.status = 'dealer';
  broadcastState(room);
}

function cpuDealerStep(room) {
  if (room.phase !== 'dealer' || dealerUser(room)) return;
  if (score(room.dealer.hand) < 17) {
    room.dealer.hand.push(draw(room));
    broadcastState(room);
    if (score(room.dealer.hand) > 21) return finishRound(room);
    room.timer = setTimeout(() => cpuDealerStep(room), 850);
  } else {
    finishRound(room);
  }
}

function applyDealerAction(room, id, action) {
  const d = dealerUser(room);
  if (!d || d.id !== id || room.phase !== 'dealer') return { ok:false, error:'ディーラー操作ではありません' };
  if (action === 'hit') room.dealer.hand.push(draw(room));
  else if (action === 'stand') room.phase = 'result';
  else return { ok:false, error:'HIT または STAND を選択してください' };
  if (score(room.dealer.hand) > 21) room.phase = 'result';
  if (room.phase === 'result') finishRound(room);
  else broadcastState(room);
  return {ok:true};
}

function settle(room) {
  const dealerScore = score(room.dealer.hand);
  const dealerBJ = isBlackjack(room.dealer.hand);
  const results = [];
  for (const p of activePlayers(room)) {
    const bet = room.betting.get(p.id) || 0;
    if (!bet || !p.hand.length) continue;
    const ps = score(p.hand);
    const pbj = isBlackjack(p.hand);
    let delta = 0;
    let payout = 0;
    let text = '';
    if (ps > 21) { delta = -bet; text = 'バースト'; }
    else if (pbj && !dealerBJ) { payout = bet * 2.5; delta = bet * 1.5; text = 'ブラックジャック！'; }
    else if (dealerScore > 21) { payout = bet * 2; delta = bet; text = 'ディーラー・バースト'; }
    else if (ps > dealerScore) { payout = bet * 2; delta = bet; text = '勝利'; }
    else if (ps < dealerScore) { delta = -bet; text = '敗北'; }
    else { payout = bet; delta = 0; text = 'プッシュ'; }
    p.chips += payout;
    p.status = text;
    results.push({ id:p.id, name:p.name, delta, chips:p.chips, text });
  }
  return results;
}

function finishRound(room) {
  clearTimeout(room.timer);
  room.phase = 'result';
  const results = settle(room);
  for (const r of results) log(room, `${r.name}: ${r.text} (${r.delta >= 0 ? '+' : ''}${r.delta})`);
  broadcast(room, { type:'roundResult', results, dealerScore:score(room.dealer.hand) });
  broadcastState(room);
  if (room.round >= room.settings.rounds) {
    setTimeout(() => endGame(room), 3500);
  } else {
    setTimeout(() => {
      const alive = activePlayers(room).filter(p => p.chips > 0);
      if (alive.length <= 1 && room.settings.mode === 'tournament') {
        endGame(room, alive[0] ? `${alive[0].name} が優勝！` : '勝者なし');
      } else {
        startRound(room);
      }
    }, 3500);
  }
}

function endGame(room, message = 'ゲーム終了') {
  clearTimeout(room.timer);
  room.phase = 'gameover';
  room.started = false;
  log(room, message);
  broadcastState(room);
}

function joinRoom(ws, data) {
  let code = String(data.roomCode || '').trim().toUpperCase();
  if (!code) {
    do code = roomCode(); while (rooms.has(code));
  }
  let room = rooms.get(code);
  if (!room) {
    const hostId = uid();
    room = makeRoom(code, hostId);
    rooms.set(code, room);
    data.userId = hostId;
  }
  if (room.users.size >= MAX_CONNECTIONS_PER_ROOM) return send({ ws }, {type:'error', error:'このルームは満員です（最大20接続）'});
  const id = data.userId || uid();
  const isSpectator = !!data.spectate;
  const user = {
    id,
    name: String(data.name || `Player${room.users.size+1}`).slice(0, 16),
    role: isSpectator ? 'spectator' : 'player',
    ws,
    connected:true,
    chips: room.settings.initialCoins,
    hand: [],
    status: ''
  };
  if (room.hostId === id && !isSpectator) user.role = 'player';
  room.users.set(id, user);
  ws.userId = id;
  ws.roomCode = room.code;
  send(user, { type:'joined', userId:id, roomCode:room.code, hostId:room.hostId });
  log(room, `${user.name} が${isSpectator ? '観戦' : '参加'}しました`);
  broadcastState(room);
}

function handle(ws, msg) {
  let data;
  try { data = JSON.parse(msg); } catch { return; }
  if (data.type === 'join') return joinRoom(ws, data);
  const room = rooms.get(ws.roomCode);
  if (!room) return send(ws, {type:'error', error:'ルームがありません'});
  const u = room.users.get(ws.userId);
  if (!u) return;

  if (data.type === 'chat') {
    const text = String(data.text || '').trim().slice(0, 120);
    if (text) broadcast(room, {type:'chat', name:u.name, text});
    return;
  }

  if (data.type === 'settings') {
    if (u.id !== room.hostId || room.phase !== 'lobby' && room.phase !== 'gameover') return send(u, {type:'error', error:'ホストのみ設定できます'});
    room.settings.mode = ['normal','continuous','tournament'].includes(data.mode) ? data.mode : room.settings.mode;
    room.settings.rounds = Math.min(MAX_ROUNDS, Math.max(1, Number(data.rounds) || 5));
    room.settings.initialCoins = Math.min(1000000, Math.max(100, Math.floor(Number(data.initialCoins) || DEFAULTS.initialCoins)));
    room.settings.minBet = Math.min(room.settings.initialCoins, Math.max(1, Math.floor(Number(data.minBet) || DEFAULTS.minBet)));
    room.settings.maxBet = Math.min(room.settings.initialCoins, Math.max(room.settings.minBet, Math.floor(Number(data.maxBet) || DEFAULTS.maxBet)));
    const requestedDealer = data.dealerId ?? data.dealer;
    if (requestedDealer === null || requestedDealer === undefined || requestedDealer === 'cpu') room.settings.dealerId = null;
    else if (room.users.has(requestedDealer) && room.users.get(requestedDealer).role === 'player') room.settings.dealerId = requestedDealer;
    broadcastState(room);
    return;
  }

  if (data.type === 'setRole') {
    if (u.id !== room.hostId || room.phase !== 'lobby' && room.phase !== 'gameover') return send(u, {type:'error', error:'ホストのみ変更できます'});
    const target = room.users.get(data.userId);
    if (!target) return;
    if (data.role === 'spectator') {
      target.role = 'spectator';
      if (room.settings.dealerId === target.id) room.settings.dealerId = null;
    } else if (data.role === 'player') target.role = 'player';
    broadcastState(room);
    return;
  }

  if (data.type === 'start') {
    if (u.id !== room.hostId) return send(u, {type:'error', error:'ホストのみ開始できます'});
    if (room.phase !== 'lobby' && room.phase !== 'gameover') return;
    if (!activePlayers(room).length) return send(u, {type:'error', error:'プレイヤーが必要です'});
    for (const p of activePlayers(room)) p.chips = room.settings.initialCoins;
    room.round = 0;
    startRound(room);
    return;
  }

  if (data.type === 'bet') {
    const r = applyBet(room, u.id, Number(data.amount));
    if (!r.ok) send(u, {type:'error', error:r.error});
    return;
  }

  if (data.type === 'action') {
    if (room.phase === 'dealer' && room.settings.dealerId === u.id) return applyDealerAction(room, u.id, data.action);
    if (!validAction(room, u, data.action)) return send(u, {type:'error', error:'今はその操作ができません'});
    const current = room.pendingActions.get(u.id) || { action: null, ok: false };
    if (current.ok) return send(u, {type:'error', error:'すでにOKしています。全員のOKを待っています'});
    current.action = data.action;
    room.pendingActions.set(u.id, current);
    broadcastState(room);
    return;
  }

  if (data.type === 'actionOk') {
    if (room.phase !== 'decision' || u.role !== 'player' || u.id === room.settings.dealerId) return send(u, {type:'error', error:'今はOKできません'});
    const current = room.pendingActions.get(u.id) || { action: null, ok: false };
    if (!current.action) return send(u, {type:'error', error:'先にHIT / STAND / DOUBLE DOWNを選んでください'});
    current.ok = true;
    room.pendingActions.set(u.id, current);
    broadcastState(room);
    if (allPlayersReady(room)) resolveDecision(room);
    return;
  }

  if (data.type === 'restart') {
    if (u.id !== room.hostId) return send(u, {type:'error', error:'ホストのみ再スタートできます'});
    room.settings.dealerId = room.settings.dealerId && room.users.has(room.settings.dealerId) ? room.settings.dealerId : null;
    for (const p of room.users.values()) { if (p.role === 'player') p.chips = room.settings.initialCoins; p.hand=[]; p.status=''; }
    startRound(room);
    return;
  }

  if (data.type === 'leave') return disconnectUser(ws);
}

function disconnectUser(ws) {
  const room = rooms.get(ws.roomCode);
  if (!room) return;
  const u = room.users.get(ws.userId);
  if (!u || !u.connected) return;
  u.connected = false;
  u.ws = null;
  if (room.hostId === u.id) {
    const next = [...room.users.values()].find(x => x.connected && x.role === 'player');
    if (next) room.hostId = next.id;
  }
  if (room.settings.dealerId === u.id) room.settings.dealerId = null;
  if (room.phase === 'betting') room.betting.delete(u.id);
  if (room.phase === 'decision') { u.status='stand'; room.pendingActions.set(u.id, {action:'stand', ok:true}); resolveDecision(room); }
  log(room, `${u.name} が退出しました`);
  broadcastState(room);
}

wss.on('connection', ws => {
  ws.on('message', msg => handle(ws, msg.toString()));
  ws.on('close', () => disconnectUser(ws));
  ws.on('error', () => disconnectUser(ws));
});

// WebSocket heartbeat.
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);
wss.on('connection', ws => ws.on('pong', () => { ws.isAlive = true; }));

server.listen(PORT, '0.0.0.0', () => console.log(`Blackjack Online listening on ${PORT}`));
