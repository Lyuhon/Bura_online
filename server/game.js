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

function newPlayer(id, token, name, isBot = false) {
  return {
    id, token, name, hand: [], score: 0, roundsWon: 0,
    penalty: 0, penaltyDelta: 0, connected: true, isBot,
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

function addBot(room) {
  if (room.players.length >= 4) return false;
  const botNum = room.players.filter((p) => p.isBot).length + 1;
  const id = `bot-${Math.random().toString(36).slice(2)}`;
  const token = `bot-token-${Math.random().toString(36).slice(2)}`;
  room.players.push(newPlayer(id, token, `Бот ${botNum}`, true));
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
    p.score = 0;
    p.penaltyDelta = 0;
  }
  dealRoundRobin(room, room.players, HAND_SIZE);
  room.trumpCard = room.deck.pop();
  room.trumpSuit = room.trumpCard.suit;
  room.deck.unshift(room.trumpCard);
  room.trick = [];
  room.leadIndex = (room.dealerIndex + 1) % room.players.length;
  room.turnIndex = room.leadIndex;
  room.trickSize = room.players.length; // сразу после раздачи у всех есть карты
  room.phase = 'playing';
  room.log = [`Раздача карт. Козырь: ${room.trumpCard.rank}${room.trumpCard.suit}`];
}

function currentPlayer(room) {
  return room.players[room.turnIndex];
}

// Раздаёт карты ПО КРУГУ (по одной каждому за проход), пока у всех не будет
// targetSize карт или не кончится колода - так конец колоды делится честно
// между игроками, а не достаётся почти целиком одному.
function dealRoundRobin(room, players, targetSize) {
  let dealt = true;
  while (dealt && room.deck.length > 0) {
    dealt = false;
    for (const p of players) {
      if (p.hand.length < targetSize && room.deck.length > 0) {
        p.hand.push(room.deck.pop());
        dealt = true;
      }
    }
  }
}

// Сколько игроков реально участвует в текущей взятке (у кого были карты на её
// старте) - используется вместо room.players.length, т.к. под конец колоды
// добор карт неравномерный и у кого-то рука может опустеть раньше других.
function countPlayersWithCards(room) {
  return room.players.filter((p) => p.hand.length > 0).length;
}

// Следующий игрок ПО КРУГУ, у которого есть карты - пропускает тех, у кого
// рука уже пуста (иначе на них зависал бы весь стол).
function nextIndexWithCards(room, fromIndex) {
  const n = room.players.length;
  for (let i = 1; i <= n; i++) {
    const idx = (fromIndex + i) % n;
    if (room.players[idx].hand.length > 0) return idx;
  }
  return fromIndex;
}

function requiredCountFor(room, player) {
  if (room.trick.length === 0) return null;
  const leaderCount = room.trick[0].cards.length;
  return Math.min(leaderCount, player.hand.length);
}

// Сила карты для сравнения (используется и разрешением взятки, и ботами):
// козырь всегда выше любой некозырной карты; в масти хода старшая карта бьёт младшую;
// карта не в масти хода и не козырь никогда не выигрывает.
function cardStrength(card, leadSuit, trumpSuit) {
  if (card.suit === trumpSuit) return 1000 + rankIndex(card.rank);
  if (card.suit === leadSuit) return rankIndex(card.rank);
  return -1;
}

// Текущая "лучшая" карта во взятке ДО того как она укомплектована - нужно ботам,
// чтобы решить, можно ли и стоит ли пытаться перебить текущего лидера.
function currentBestCard(room) {
  if (room.trick.length === 0) return null;
  const leadSuit = room.trick[0].cards[0].suit;
  let winningCard = null;
  for (const entry of room.trick) {
    for (const c of entry.cards) {
      if (!winningCard) { winningCard = c; continue; }
      const cIsTrump = c.suit === room.trumpSuit;
      const wIsTrump = winningCard.suit === room.trumpSuit;
      if (cIsTrump && !wIsTrump) winningCard = c;
      else if (cIsTrump && wIsTrump) { if (rankIndex(c.rank) > rankIndex(winningCard.rank)) winningCard = c; }
      else if (!cIsTrump && !wIsTrump && c.suit === leadSuit && winningCard.suit === leadSuit) { if (rankIndex(c.rank) > rankIndex(winningCard.rank)) winningCard = c; }
      else if (!cIsTrump && !wIsTrump && c.suit === leadSuit && winningCard.suit !== leadSuit) winningCard = c;
    }
  }
  return winningCard;
}

// Простая эвристика для бота: если открывает - сливает мусор (масть с наименьшей
// суммой очков, не козырную по возможности); если отвечает - пытается перебить
// текущего лидера самой ДЕШЁВОЙ подходящей картой (бережёт козыри, если ходит не
// последним в этой взятке), а остальные обязательные карты добирает из мусора.
function chooseBotMove(room, player) {
  const isLeader = room.trick.length === 0;

  if (isLeader) {
    const groups = {};
    for (const c of player.hand) (groups[c.suit] = groups[c.suit] || []).push(c);
    let entries = Object.entries(groups);
    const nonTrump = entries.filter(([s]) => s !== room.trumpSuit);
    const pool = nonTrump.length ? nonTrump : entries;
    pool.sort((a, b) => {
      const pa = a[1].reduce((s, c) => s + POINTS[c.rank], 0);
      const pb = b[1].reduce((s, c) => s + POINTS[c.rank], 0);
      if (pa !== pb) return pa - pb;
      return b[1].length - a[1].length;
    });
    return pool[0][1].slice();
  }

  const required = requiredCountFor(room, player);
  const leadSuit = room.trick[0].cards[0].suit;
  const best = currentBestCard(room);
  const bestStrength = cardStrength(best, leadSuit, room.trumpSuit);
  const isLast = room.trick.length === room.players.length - 1;

  const byPoints = [...player.hand].sort((a, b) => POINTS[a.rank] - POINTS[b.rank]);
  const winners = player.hand
    .filter((c) => cardStrength(c, leadSuit, room.trumpSuit) > bestStrength)
    .sort((a, b) => cardStrength(a, leadSuit, room.trumpSuit) - cardStrength(b, leadSuit, room.trumpSuit));

  let winCard = null;
  if (isLast && winners.length) {
    winCard = winners[0];
  } else if (!isLast && winners.length) {
    const nonTrumpWinners = winners.filter((c) => c.suit !== room.trumpSuit);
    winCard = nonTrumpWinners.length ? nonTrumpWinners[0] : null;
  }

  if (winCard) {
    const rest = byPoints.filter((c) => cardId(c) !== cardId(winCard)).slice(0, required - 1);
    return [winCard, ...rest];
  }
  return byPoints.slice(0, required);
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

  if (room.trick.length === room.trickSize) {
    return resolveTrickWinner(room);
  }
  room.turnIndex = nextIndexWithCards(room, room.turnIndex);
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
  // добор начинается с победителя взятки, но идёт по кругу по одной карте -
  // честно делит "хвост" колоды, если она вот-вот закончится
  const drawOrder = [];
  for (let i = 0; i < room.players.length; i++) {
    drawOrder.push(room.players[(winnerIdx + i) % room.players.length]);
  }
  dealRoundRobin(room, drawOrder, HAND_SIZE);

  room.trick = [];
  room.phase = 'playing';

  const buraWinner = room.players.find((p) => p.score >= WIN_SCORE);
  if (buraWinner) {
    endRound(room, buraWinner, true);
    return;
  }
  if (room.players.every((p) => p.hand.length === 0)) {
    const best = room.players.reduce((a, b) => (b.score > a.score ? b : a));
    endRound(room, best, false);
    return;
  }

  // Следующим ходит победитель взятки - если у него вдруг нет карт (редкий
  // случай на исходе колоды), передаём ход дальше по кругу первому, у кого они есть
  const nextLeaderIdx = room.players[winnerIdx].hand.length > 0
    ? winnerIdx
    : nextIndexWithCards(room, winnerIdx);
  room.leadIndex = nextLeaderIdx;
  room.turnIndex = nextLeaderIdx;
  room.trickSize = countPlayersWithCards(room);
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
      isBot: p.isBot || false,
      handCount: p.hand.length,
      hand: p.id === forPlayerId ? p.hand : undefined,
    })),
  };
}

function resetToLobby(room) {
  // возвращаем всех выбывших обратно в состав, обнуляем очки/штрафы
  room.players = room.players.concat(room.eliminated);
  room.eliminated = [];
  for (const p of room.players) {
    p.score = 0;
    p.roundsWon = 0;
    p.penalty = 0;
    p.penaltyDelta = 0;
    p.hand = [];
  }
  room.phase = 'lobby';
  room.trick = [];
  room.trumpCard = null;
  room.trumpSuit = null;
  room.log = [];
  room.lastWinnerName = null;
  room.lastWinnerIsBura = null;
  room.overallWinnerName = null;
  room.dealerIndex = -1;
}

module.exports = {
  SUITS, RANKS, POINTS, WIN_SCORE, HAND_SIZE, ELIMINATION_LIMIT,
  createRoom, addPlayer, addBot, findPlayerByToken, kickPlayer, renamePlayer, resetToLobby, startRound,
  isValidSubmission, playCards, finalizeTrick, chooseBotMove, publicStateFor, cardId,
};
