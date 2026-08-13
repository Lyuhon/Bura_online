// Логика карточной игры "Бура" (52 карты, 3-4 игрока)
// Правило мультиброса: открывающий кидает N карт одной масти, каждый следующий
// обязан ответить РОВНО N картами (любых мастей, либо всеми, что остались, если их меньше).
// Победитель взятки определяется ОДИН - тот, чья карта в целом сильнее всех остальных
// (по правилам козыря/масти хода), и забирает ВСЮ взятку целиком.

const SUITS = ['♠', '♥', '♦', '♣'];
// В буре 10 сильнее короля/дамы/валета, слабее только туза
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'J', 'Q', 'K', '10', 'A'];
const POINTS = {
  '2': 0, '3': 0, '4': 0, '5': 0, '6': 0, '7': 0, '8': 0, '9': 0,
  '10': 10, 'J': 2, 'Q': 3, 'K': 4, 'A': 11,
};
const WIN_SCORE = 31; // мгновенная победа в раздаче при наборе этих очков
const HAND_SIZE = 4; // карт в руке у каждого игрока
const ELIMINATION_LIMIT = 12; // очков вылета для выбывания из игры

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

function newPlayer(id, token, name) {
  return {
    id, token, name, hand: [], score: 0, roundsWon: 0,
    penalty: 0, penaltyDelta: 0, connected: true,
  };
}

function createRoom(code, hostId, hostToken, hostName) {
  return {
    code,
    hostToken,
    players: [newPlayer(hostId, hostToken, hostName)],
    eliminated: [],
    deck: [],
    trumpSuit: null,
    trumpCard: null,
    trick: [],
    leadIndex: 0,
    turnIndex: 0,
    phase: 'lobby',
    log: [],
    dealerIndex: -1,
    cleanupTimer: null,
  };
}

function addPlayer(room, id, token, name) {
  if (room.players.length >= 4) return false;
  room.players.push(newPlayer(id, token, name));
  return true;
}

function findPlayerByToken(room, token) {
  return room.players.find((p) => p.token === token) || room.eliminated.find((p) => p.token === token);
}

function kickPlayer(room, targetPlayerId) {
  const idx = room.players.findIndex((p) => p.id === targetPlayerId);
  if (idx === -1) return null;
  const [removed] = room.players.splice(idx, 1);
  return removed;
}

function renamePlayer(room, targetPlayerId, newName) {
  const target = room.players.find((p) => p.id === targetPlayerId)
    || room.eliminated.find((p) => p.id === targetPlayerId);
  if (!target) return false;
  target.name = newName.slice(0, 16);
  return true;
}

function startRound(room) {
  room.deck = shuffle(createDeck());
  room.dealerIndex = (room.dealerIndex + 1) % room.players.length;
  for (const p of room.players) {
    p.hand = [];
    for (let i = 0; i < HAND_SIZE; i++) p.hand.push(room.deck.pop());
    p.score = 0;
    p.penaltyDelta = 0;
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

function requiredCountFor(room, player) {
  if (room.trick.length === 0) return null;
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
    const firstSuit = cards[0].suit;
    return cards.every((c) => c.suit === firstSuit);
  }
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

function resolveTrickWinner(room) {
  const leadSuit = room.trick[0].cards[0].suit;
  let winningCard = null;
  let winnerId = null;

  for (const entry of room.trick) {
    for (const c of entry.cards) {
      if (!winningCard) { winningCard = c; winnerId = entry.playerId; continue; }
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
    }
  }

  const trickPoints = room.trick.reduce(
    (sum, e) => sum + e.cards.reduce((s, c) => s + POINTS[c.rank], 0), 0,
  );
  const winner = room.players.find((p) => p.id === winnerId);
  winner.score += trickPoints;
  room.log.push(`${winner.name} забирает всю взятку (+${trickPoints} очк., сильнейшая карта ${winningCard.rank}${winningCard.suit})`);

  return { winnerId, winnerName: winner.name, trickPoints, trick: room.trick, winningCard };
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

function applyEliminationPenalties(room, roundWinnerId) {
  for (const p of room.players) {
    let delta;
    if (p.id === roundWinnerId) delta = 0;
    else if (p.score === 0) delta = 4;
    else if (p.score >= 30) delta = 2;
    else delta = 3;
    p.penalty += delta;
    p.penaltyDelta = delta;
  }

  const toEliminate = room.players.filter((p) => p.penalty >= ELIMINATION_LIMIT);
  for (const p of toEliminate) {
    room.log.push(`❌ ${p.name} выбывает из игры (${p.penalty} очков вылета)`);
    const idx = room.players.findIndex((pl) => pl.id === p.id);
    if (idx !== -1) {
      const [removed] = room.players.splice(idx, 1);
      room.eliminated.push(removed);
    }
  }

  if (room.players.length === 1) {
    room.phase = 'game_over';
    room.overallWinnerName = room.players[0].name;
    room.log.push(`🏆 Игра окончена! Победитель: ${room.overallWinnerName}`);
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
  applyEliminationPenalties(room, winner.id);
}

function publicStateFor(room, forPlayerId) {
  const host = room.players.find((p) => p.token === room.hostToken)
    || room.eliminated.find((p) => p.token === room.hostToken);
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
    overallWinnerName: room.overallWinnerName,
    eliminationLimit: ELIMINATION_LIMIT,
    eliminated: room.eliminated.map((p) => ({ name: p.name, penalty: p.penalty })),
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      score: p.score,
      roundsWon: p.roundsWon,
      penalty: p.penalty,
      penaltyDelta: p.penaltyDelta,
      connected: p.connected,
      handCount: p.hand.length,
      hand: p.id === forPlayerId ? p.hand : undefined,
    })),
  };
}

module.exports = {
  SUITS, RANKS, POINTS, WIN_SCORE, HAND_SIZE, ELIMINATION_LIMIT,
  createRoom, addPlayer, findPlayerByToken, kickPlayer, renamePlayer, startRound,
  isValidSubmission, playCards, finalizeTrick, publicStateFor, cardId,
};
