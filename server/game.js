// Логика карточной игры "Бура" (полная колода 52 карты, 3-4 игрока)

const SUITS = ['♠', '♥', '♦', '♣'];
// Важно: в буре 10 сильнее короля/дамы/валета, слабее только туза
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'J', 'Q', 'K', '10', 'A'];
const POINTS = {
  '2': 0, '3': 0, '4': 0, '5': 0, '6': 0, '7': 0, '8': 0, '9': 0,
  '10': 10, 'J': 2, 'Q': 3, 'K': 4, 'A': 11,
};
const WIN_SCORE = 31; // мгновенная победа в раунде при наборе этих очков
const HAND_SIZE = 4; // карт в руке у каждого игрока

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
    trick: [], // { playerId, cards: [...] }
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
  room.deck.unshift(room.trumpCard); // козырь уходит на дно, будет последней картой добора
  room.trick = [];
  room.leadIndex = (room.dealerIndex + 1) % room.players.length;
  room.turnIndex = room.leadIndex;
  room.phase = 'playing';
  room.log = [`Раздача карт. Козырь: ${room.trumpCard.rank}${room.trumpCard.suit}`];
}

function currentPlayer(room) {
  return room.players[room.turnIndex];
}

// Можно скинуть 1 или несколько карт ОДНОЙ масти за ход (любой, не обязательно в масть хода)
function isValidSubmission(room, playerId, cards) {
  if (!Array.isArray(cards) || cards.length === 0) return false;
  const player = room.players.find((p) => p.id === playerId);
  if (!player) return false;
  if (currentPlayer(room).id !== playerId) return false;
  if (room.phase !== 'playing') return false;

  const firstSuit = cards[0].suit;
  if (!cards.every((c) => c.suit === firstSuit)) return false; // все карты одной масти

  const handIds = player.hand.map(cardId);
  const seen = new Set();
  for (const c of cards) {
    const id = cardId(c);
    if (seen.has(id)) return false; // нельзя дважды скинуть одну и ту же карту
    seen.add(id);
    if (!handIds.includes(id)) return false;
  }
  return true;
}

// Убирает карты из руки, добавляет во взятку. Если взятка укомплектована всеми игроками -
// считает победителя и очки, НО НЕ добирает карты и не чистит стол (это делает finalizeTrick,
// чтобы дать время на анимацию на клиенте перед тем как взятка исчезнет).
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

function resolveTrickWinner(room) {
  const leadSuit = room.trick[0].cards[0].suit;
  let winningCard = null;
  let winnerId = null;

  for (const entry of room.trick) {
    for (const c of entry.cards) {
      if (!winningCard) {
        winningCard = c;
        winnerId = entry.playerId;
        continue;
      }
      const cIsTrump = c.suit === room.trumpSuit;
      const wIsTrump = winningCard.suit === room.trumpSuit;

      if (cIsTrump && !wIsTrump) {
        winningCard = c; winnerId = entry.playerId;
      } else if (cIsTrump && wIsTrump) {
        if (rankIndex(c.rank) > rankIndex(winningCard.rank)) { winningCard = c; winnerId = entry.playerId; }
      } else if (!cIsTrump && !wIsTrump && c.suit === leadSuit && winningCard.suit === leadSuit) {
        if (rankIndex(c.rank) > rankIndex(winningCard.rank)) { winningCard = c; winnerId = entry.playerId; }
      } else if (!cIsTrump && !wIsTrump && c.suit === leadSuit && winningCard.suit !== leadSuit) {
        winningCard = c; winnerId = entry.playerId;
      }
      // карта не в масти хода и не козырь - никогда не выигрывает
    }
  }

  const trickPoints = room.trick.reduce(
    (sum, e) => sum + e.cards.reduce((s, c) => s + POINTS[c.rank], 0), 0,
  );
  const winner = room.players.find((p) => p.id === winnerId);
  winner.score += trickPoints;
  room.log.push(`${winner.name} забирает взятку (+${trickPoints} очк.)`);

  return { winnerId, winnerName: winner.name, trickPoints, trick: room.trick };
}

// Вызывается после паузы на клиентскую анимацию: добор карт, очистка стола, проверка победы
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
  return {
    code: room.code,
    phase: room.phase,
    hostId: host ? host.id : null,
    trumpSuit: room.trumpSuit,
    trumpCard: room.trumpCard,
    trick: room.trick,
    turnPlayerId: room.players[room.turnIndex] ? room.players[room.turnIndex].id : null,
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
