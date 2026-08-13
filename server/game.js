// Логика карточной игры "Бура" (52 карты, 3-4 игрока)
// Правило мультиброса: открывающий кидает N карт одной масти, каждый следующий
// обязан ответить РОВНО N картами (любых мастей, либо всеми, что остались, если их меньше).
// Взятка разбивается на колонки по позициям - i-я карта каждого игрока бьётся
// только против i-х карт остальных, а не против всей кучи разом.

const SUITS = ['♠', '♥', '♦', '♣'];
// В буре 10 сильнее короля/дамы/валета, слабее только туза
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'J', 'Q', 'K', '10', 'A'];
const POINTS = {
  '2': 0, '3': 0, '4': 0, '5': 0, '6': 0, '7': 0, '8': 0, '9': 0,
  '10': 10, 'J': 2, 'Q': 3, 'K': 4, 'A': 11,
};
const WIN_SCORE = 31;
const HAND_SIZE = 4;

function createDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push({ suit: s, rank: r });
  return deck;
}

function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function rankIndex(rank) {
  return RANKS.indexOf(rank);
}

function cardId(c) {
  return c.rank + c.suit;
}

function createRoom(code, hostId, hostToken, hostName) {
  return {
    code,
    hostToken,
    players: [{ id: hostId, token: hostToken, name: hostName, hand: [], score: 0, roundsWon: 0, connected: true }],
    deck: [],
    trumpSuit: null,
    trumpCard: null,
    trick: [], // { playerId, cards: [...] } в порядке хода
    leadIndex: 0,
    turnIndex: 0,
    phase: 'lobby', // lobby | playing | resolving | round_end | game_over
    log: [],
    dealerIndex: -1,
    cleanupTimer: null,
  };
}

function addPlayer(room, id, token, name) {
  if (room.players.length >= 4) return false;
  room.players.push({ id, token, name, hand: [], score: 0, roundsWon: 0, connected: true });
  return true;
}

function findPlayerByToken(room, token) {
  return room.players.find((p) => p.token === token);
}

function kickPlayer(room, targetPlayerId) {
  const idx = room.players.findIndex((p) => p.id === targetPlayerId);
  if (idx === -1) return null;
  const [removed] = room.players.splice(idx, 1);
  return removed;
}

function startRound(room) {
  room.deck = shuffle(createDeck());
  room.dealerIndex = (room.dealerIndex + 1) % room.players.length;
  for (const p of room.players) {
    p.hand = [];
    for (let i = 0; i < HAND_SIZE; i++) p.hand.push(room.deck.pop());
    p.score = 0;
  }
  room.trumpCard = room.deck.pop();
  room.trumpSuit = room.trumpCard.suit;
  room.deck.unshift(room.trumpCard);
  room.trick = [];
  room.leadIndex = (room.dealerIndex + 1) % room.players.length;
  room.turnIndex = room.leadIndex;
  room.phase = 'playing';
  room.log = [`Раздача карт. Козырь: ${room.trumpCard.rank}${room.trumpCard.suit}`];
}

function currentPlayer(room) {
  return room.players[room.turnIndex];
}

// Сколько карт обязан положить игрок прямо сейчас
function requiredCountFor(room, player) {
  if (room.trick.length === 0) return null; // он открывает - сам решает сколько (минимум 1)
  const leaderCount = room.trick[0].cards.length;
  return Math.min(leaderCount, player.hand.length);
}

function isValidSubmission(room, playerId, cards) {
  if (!Array.isArray(cards) || cards.length === 0) return false;
  const player = room.players.find((p) => p.id === playerId);
  if (!player) return false;
  if (currentPlayer(room).id !== playerId) return false;
  if (room.phase !== 'playing') return false;

  const handIds = player.hand.map(cardId);
  const seen = new Set();
  for (const c of cards) {
    const id = cardId(c);
    if (seen.has(id)) return false;
    seen.add(id);
    if (!handIds.includes(id)) return false;
  }

  const isLeader = room.trick.length === 0;
  if (isLeader) {
    // Открывающий обязан кидать одной мастью, количество - на его усмотрение
    const firstSuit = cards[0].suit;
    return cards.every((c) => c.suit === firstSuit);
  }
  // Отвечающий обязан выложить РОВНО столько же карт (или все, если их меньше) - масти любые
  const required = requiredCountFor(room, player);
  return cards.length === required;
}

function playCards(room, playerId, cards) {
  const player = room.players.find((p) => p.id === playerId);
  const ids = new Set(cards.map(cardId));
  player.hand = player.hand.filter((c) => !ids.has(cardId(c)));
  room.trick.push({ playerId, cards });

  const cardsText = cards.map((c) => `${c.rank}${c.suit}`).join(', ');
  room.log.push(`${player.name} сходил: ${cardsText}`);

  if (room.trick.length === room.players.length) {
    return resolveTrickWinner(room);
  }
  room.turnIndex = (room.turnIndex + 1) % room.players.length;
  return null;
}

// Разрешает взятку ПОКОЛОННО: i-я карта каждого игрока бьётся только против i-х карт
// остальных участников этой конкретной колонки. Козырь или старшая карта в масти хода
// побеждает исключительно в СВОЕЙ колонке, а не забирает всю кучу.
function resolveTrickWinner(room) {
  const leaderCount = room.trick[0].cards.length;
  const columns = [];

  for (let i = 0; i < leaderCount; i++) {
    const entries = room.trick
      .filter((e) => e.cards.length > i)
      .map((e) => ({ playerId: e.playerId, card: e.cards[i] }));
    if (entries.length === 0) continue;

    const leadSuit = room.trick[0].cards[i].suit;
    let winningCard = null;
    let winnerId = null;

    for (const en of entries) {
      const c = en.card;
      if (!winningCard) { winningCard = c; winnerId = en.playerId; continue; }
      const cIsTrump = c.suit === room.trumpSuit;
      const wIsTrump = winningCard.suit === room.trumpSuit;

      if (cIsTrump && !wIsTrump) {
        winningCard = c; winnerId = en.playerId;
      } else if (cIsTrump && wIsTrump) {
        if (rankIndex(c.rank) > rankIndex(winningCard.rank)) { winningCard = c; winnerId = en.playerId; }
      } else if (!cIsTrump && !wIsTrump && c.suit === leadSuit && winningCard.suit === leadSuit) {
        if (rankIndex(c.rank) > rankIndex(winningCard.rank)) { winningCard = c; winnerId = en.playerId; }
      } else if (!cIsTrump && !wIsTrump && c.suit === leadSuit && winningCard.suit !== leadSuit) {
        winningCard = c; winnerId = en.playerId;
      }
    }

    const points = entries.reduce((s, en) => s + POINTS[en.card.rank], 0);
    const winner = room.players.find((p) => p.id === winnerId);
    winner.score += points;
    columns.push({ index: i, entries, winnerId, winnerName: winner.name, points });
  }

  const lastCol = columns[columns.length - 1];
  const overallWinner = room.players.find((p) => p.id === lastCol.winnerId);
  const totalPoints = columns.reduce((s, c) => s + c.points, 0);

  room.log.push(`Взятка разыграна по колонкам (${columns.length}). Ведёт дальше ${overallWinner.name}.`);
  columns.forEach((c) => {
    room.log.push(`  Колонка ${c.index + 1}: забирает ${c.winnerName} (+${c.points})`);
  });

  return {
    winnerId: overallWinner.id,
    winnerName: overallWinner.name,
    trickPoints: totalPoints,
    trick: room.trick,
    columns,
  };
}

function finalizeTrick(room, winnerId) {
  const winnerIdx = room.players.findIndex((p) => p.id === winnerId);
  for (let i = 0; i < room.players.length; i++) {
    const idx = (winnerIdx + i) % room.players.length;
    const p = room.players[idx];
    while (p.hand.length < HAND_SIZE && room.deck.length > 0) {
      p.hand.push(room.deck.pop());
    }
  }

  room.trick = [];
  room.leadIndex = winnerIdx;
  room.turnIndex = winnerIdx;
  room.phase = 'playing';

  const buraWinner = room.players.find((p) => p.score >= WIN_SCORE);
  if (buraWinner) {
    endRound(room, buraWinner, true);
    return;
  }
  if (room.players.every((p) => p.hand.length === 0)) {
    const best = room.players.reduce((a, b) => (b.score > a.score ? b : a));
    endRound(room, best, false);
  }
}

function endRound(room, winner, isBura) {
  winner.roundsWon += 1;
  room.phase = 'round_end';
  room.log.push(
    isBura ? `🔥 БУРА! ${winner.name} побеждает в раздаче с ${winner.score} очками!` : `Раздача окончена. ${winner.name} побеждает с ${winner.score} очками.`,
  );
  room.lastWinnerName = winner.name;
  room.lastWinnerIsBura = isBura;
}

function publicStateFor(room, forPlayerId) {
  const host = room.players.find((p) => p.token === room.hostToken);
  const me = room.players.find((p) => p.id === forPlayerId);
  return {
    code: room.code,
    phase: room.phase,
    hostId: host ? host.id : null,
    trumpSuit: room.trumpSuit,
    trumpCard: room.trumpCard,
    trick: room.trick,
    turnPlayerId: room.players[room.turnIndex] ? room.players[room.turnIndex].id : null,
    requiredCount: me ? requiredCountFor(room, me) : null,
    deckCount: room.deck.length,
    log: room.log.slice(-14),
    lastWinnerName: room.lastWinnerName,
    lastWinnerIsBura: room.lastWinnerIsBura,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      score: p.score,
      roundsWon: p.roundsWon,
      connected: p.connected,
      handCount: p.hand.length,
      hand: p.id === forPlayerId ? p.hand : undefined,
    })),
  };
}

module.exports = {
  SUITS, RANKS, POINTS, WIN_SCORE, HAND_SIZE,
  createRoom, addPlayer, findPlayerByToken, kickPlayer, startRound,
  isValidSubmission, playCards, finalizeTrick, publicStateFor, cardId,
};
