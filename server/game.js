// Логика карточной игры "Бура" (классический вариант, 3-4 игрока)

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const POINTS = { '6': 0, '7': 0, '8': 0, '9': 0, '10': 10, 'J': 2, 'Q': 3, 'K': 4, 'A': 11 };
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

// Создаёт новую комнату
function createRoom(code, hostId, hostToken, hostName) {
  return {
    code,
    hostToken,
    players: [{ id: hostId, token: hostToken, name: hostName, hand: [], score: 0, roundsWon: 0, connected: true }],
    deck: [],
    trumpSuit: null,
    trumpCard: null,
    trick: [], // { playerId, card }
    leadIndex: 0,
    turnIndex: 0,
    phase: 'lobby', // lobby | playing | round_end | game_over
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
  // Козырь кладём в самый низ колоды - он будет последней картой для добора
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

function isValidPlay(room, playerId, card) {
  const player = room.players.find((p) => p.id === playerId);
  if (!player) return false;
  if (currentPlayer(room).id !== playerId) return false;
  if (room.phase !== 'playing') return false;
  return player.hand.some((c) => cardId(c) === cardId(card));
}

function playCard(room, playerId, card) {
  const player = room.players.find((p) => p.id === playerId);
  player.hand = player.hand.filter((c) => cardId(c) !== cardId(card));
  room.trick.push({ playerId, card });
  room.log.push(`${player.name} сходил ${card.rank}${card.suit}`);

  if (room.trick.length === room.players.length) {
    resolveTrick(room);
  } else {
    room.turnIndex = (room.turnIndex + 1) % room.players.length;
  }
}

function resolveTrick(room) {
  const leadSuit = room.trick[0].card.suit;
  let winnerEntry = room.trick[0];

  for (const entry of room.trick.slice(1)) {
    const c = entry.card;
    const w = winnerEntry.card;
    const cIsTrump = c.suit === room.trumpSuit;
    const wIsTrump = w.suit === room.trumpSuit;

    if (cIsTrump && !wIsTrump) {
      winnerEntry = entry;
    } else if (cIsTrump && wIsTrump) {
      if (rankIndex(c.rank) > rankIndex(w.rank)) winnerEntry = entry;
    } else if (!cIsTrump && !wIsTrump && c.suit === leadSuit && w.suit === leadSuit) {
      if (rankIndex(c.rank) > rankIndex(w.rank)) winnerEntry = entry;
    }
    // карта не в масти хода и не козырь - никогда не выигрывает
  }

  const winner = room.players.find((p) => p.id === winnerEntry.playerId);
  const trickPoints = room.trick.reduce((sum, e) => sum + POINTS[e.card.rank], 0);
  winner.score += trickPoints;
  room.log.push(`${winner.name} забирает взятку (+${trickPoints} очк.)`);

  // Добор карт, начиная с победителя
  const winnerIdx = room.players.findIndex((p) => p.id === winner.id);
  for (let i = 0; i < room.players.length; i++) {
    const idx = (winnerIdx + i) % room.players.length;
    const p = room.players[idx];
    if (room.deck.length > 0) {
      p.hand.push(room.deck.pop());
    }
  }

  room.trick = [];
  room.leadIndex = winnerIdx;
  room.turnIndex = winnerIdx;

  // Проверка мгновенной победы (набрал 31+ очко)
  const buraWinner = room.players.find((p) => p.score >= WIN_SCORE);
  if (buraWinner) {
    endRound(room, buraWinner, true);
    return;
  }

  // Проверка конца раздачи (у всех пустые руки)
  if (room.players.every((p) => p.hand.length === 0)) {
    const best = room.players.reduce((a, b) => (b.score > a.score ? b : a));
    endRound(room, best, false);
  }
}

function endRound(room, winner, isBura) {
  winner.roundsWon += 1;
  room.phase = 'round_end';
  room.log.push(
    isBura ? `🔥 БУРА! ${winner.name} побеждает в раздаче с ${winner.score} очками!` : `Раздача окончена. ${winner.name} побеждает с ${winner.score} очками.`
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
    log: room.log.slice(-8),
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
  createRoom, addPlayer, findPlayerByToken, startRound, isValidPlay, playCard, publicStateFor, cardId,
};
