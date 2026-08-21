// Логика карточной игры "Бура" (52 карты, 3-4 игрока)
// Правило мультиброса: открывающий кидает N карт одной масти, каждый следующий
// обязан ответить РОВНО N картами (любых мастей, либо всеми, что остались, если их меньше).
// Победитель взятки определяется ОДИН - тот, чья карта в целом сильнее всех остальных
// (по правилам козыря/масти хода), и забирает ВСЮ взятку целиком.

const SUITS = ['♠', '♥', '♦', '♣'];
// В буре 10 сильнее короля/дамы/валета, слабее только туза
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'J', 'Q', 'K', '10', 'A'];
const RANKS_36 = ['6', '7', '8', '9', 'J', 'Q', 'K', '10', 'A'];
const POINTS = {
  '2': 0, '3': 0, '4': 0, '5': 0, '6': 0, '7': 0, '8': 0, '9': 0,
  '10': 10, 'J': 2, 'Q': 3, 'K': 4, 'A': 11,
};
const WIN_SCORE = 31; // мгновенная победа в раздаче при наборе этих очков
const HAND_SIZE = 4; // карт в руке у каждого игрока
const ELIMINATION_LIMIT = 12; // очков вылета для выбывания из игры

function createDeck(deckSize) {
  const ranks = deckSize === 36 ? RANKS_36 : RANKS;
  const deck = [];
  for (const s of SUITS) for (const r of ranks) deck.push({ suit: s, rank: r });
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

function newPlayer(id, token, name, isBot = false, avatar = null) {
  return {
    id, token, name, avatar, hand: [], score: 0, roundsWon: 0,
    penalty: 0, penaltyDelta: 0, connected: true, isBot,
  };
}

function createRoom(code, hostId, hostToken, hostName, hostAvatar) {
  return {
    code,
    hostToken,
    players: [newPlayer(hostId, hostToken, hostName, false, hostAvatar)],
    eliminated: [],
    deck: [],
    deckSize: 52,
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

function setDeckSize(room, size) {
  if (room.phase !== 'lobby') return false;
  if (size !== 36 && size !== 52) return false;
  room.deckSize = size;
  return true;
}

function addPlayer(room, id, token, name, avatar) {
  if (room.players.length >= 4) return false;
  room.players.push(newPlayer(id, token, name, false, avatar));
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

// Игрок сам решил выйти из партии (не хост его убрал). В лобби - просто убираем.
// В процессе игры - переводим в "выбывшие" (без штрафа), чиним индекс хода/лидера
// под новый (уменьшенный) состав и уменьшаем размер текущей взятки, если она
// ещё не завершена, чтобы игра не ждала карту от того, кого уже нет за столом.
function leaveGame(room, playerId) {
  const idx = room.players.findIndex((p) => p.id === playerId);
  if (idx === -1) return false;

  const wasTurnPlayerId = room.players[room.turnIndex] ? room.players[room.turnIndex].id : null;
  const wasLeadPlayerId = room.players[room.leadIndex] ? room.players[room.leadIndex].id : null;

  const [removed] = room.players.splice(idx, 1);
  removed.hand = [];
  room.eliminated.push(removed);

  if (room.players.length === 0) {
    room.turnIndex = 0;
    room.leadIndex = 0;
    return { left: true, trickResult: null };
  }

  const newTurnIdx = room.players.findIndex((p) => p.id === wasTurnPlayerId);
  room.turnIndex = newTurnIdx !== -1 ? newTurnIdx : 0;
  const newLeadIdx = room.players.findIndex((p) => p.id === wasLeadPlayerId);
  room.leadIndex = newLeadIdx !== -1 ? newLeadIdx : 0;

  if (room.phase === 'playing' || room.phase === 'resolving') {
    if (room.trickSize > 0) room.trickSize = Math.max(0, room.trickSize - 1);
    if (room.players[room.turnIndex] && room.players[room.turnIndex].hand.length === 0) {
      room.turnIndex = nextIndexWithCards(room, room.turnIndex);
    }
    // если после ухода игрока взятка уже фактически укомплектована оставшимися - разрешаем её сразу же
    if (room.trick.length > 0 && room.trick.length >= room.trickSize) {
      const trickResult = resolveTrickWinner(room);
      return { left: true, trickResult };
    }
  }
  return { left: true, trickResult: null };
}

function startRound(room) {
  room.deck = shuffle(createDeck(room.deckSize));
  // Если полная колода (52) и играют втроём - убираем одну случайную карту ДО
  // раздачи и до выбора козыря, чтобы колода делилась поровну (52 не делится
  // на 3 без остатка). Так козырь не может случайно "исчезнуть" вместе с ней.
  if (room.deckSize === 52 && room.players.length === 3) {
    const idx = Math.floor(Math.random() * room.deck.length);
    room.deck.splice(idx, 1);
  }
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

// Бьёт ли карта x карту y (учитывая козырь): козырь бьёт любую некозырную карту;
// среди двух козырей побеждает старшая по рангу; среди двух карт одной
// некозырной масти - старшая по рангу; иначе (разные некозырные масти) - никогда не бьёт.
function beatsCard(x, y, trumpSuit) {
  const xTrump = x.suit === trumpSuit;
  const yTrump = y.suit === trumpSuit;
  if (xTrump && !yTrump) return true;
  if (xTrump && yTrump) return rankIndex(x.rank) > rankIndex(y.rank);
  if (!xTrump && yTrump) return false;
  if (x.suit !== y.suit) return false;
  return rankIndex(x.rank) > rankIndex(y.rank);
}

// Кто сейчас "держит" взятку среди уже сыгранных заходов: каждый следующий заход
// должен ПОЛНОСТЬЮ перебить текущего держателя карта-на-карту (позиция на позицию);
// если хоть одна карта не перебивает - весь заход проваливается, держатель не меняется.
function currentHolderEntry(room) {
  if (room.trick.length === 0) return null;
  let holder = room.trick[0];
  for (let t = 1; t < room.trick.length; t++) {
    const challenger = room.trick[t];
    let covers = challenger.cards.length >= holder.cards.length;
    if (covers) {
      for (let i = 0; i < holder.cards.length; i++) {
        if (!beatsCard(challenger.cards[i], holder.cards[i], room.trumpSuit)) { covers = false; break; }
      }
    }
    if (covers) holder = challenger;
  }
  return holder;
}

// Сила карты относительно конкретной позиции - нужна боту, чтобы выбирать
// САМУЮ ДЕШЁВУЮ карту, которой хватает для перебития (беречь сильные карты).
function cardStrength(card, targetSuit, trumpSuit) {
  if (card.suit === trumpSuit) return 1000 + rankIndex(card.rank);
  if (card.suit === targetSuit) return rankIndex(card.rank);
  return -1;
}

// Пытается жадно собрать из руки полный перебивающий комплект против текущего
// держателя (по позициям). Если для какой-то позиции нет подходящей карты - null.
function tryFullCover(hand, holderCards, trumpSuit) {
  const pool = hand.slice();
  const chosen = [];
  for (let i = 0; i < holderCards.length; i++) {
    let bestIdx = -1;
    for (let j = 0; j < pool.length; j++) {
      if (beatsCard(pool[j], holderCards[i], trumpSuit)) {
        if (bestIdx === -1 || cardStrength(pool[j], holderCards[i].suit, trumpSuit) < cardStrength(pool[bestIdx], holderCards[i].suit, trumpSuit)) {
          bestIdx = j;
        }
      }
    }
    if (bestIdx === -1) return null;
    chosen.push(pool[bestIdx]);
    pool.splice(bestIdx, 1);
  }
  return chosen;
}

// Простая эвристика для бота: если открывает - сливает мусор (масть с наименьшей
// суммой очков, не козырную по возможности); если отвечает - пытается СОБРАТЬ
// ПОЛНЫЙ перебивающий комплект против текущего держателя (если он последний в
// очереди хода - перебивает всегда, когда может; иначе бережёт козыри и лезет
// в бой только если может перебить чисто картами в масть без козыря).
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
  const holder = currentHolderEntry(room);
  const isLast = room.trick.length === room.trickSize - 1;
  const byPoints = [...player.hand].sort((a, b) => POINTS[a.rank] - POINTS[b.rank]);

  let cover = null;
  if (holder.cards.length === required) {
    cover = tryFullCover(player.hand, holder.cards, room.trumpSuit);
    const usesTrump = cover && cover.some((c) => c.suit === room.trumpSuit && holder.cards.every((h) => h.suit !== room.trumpSuit));
    if (cover && !isLast && usesTrump) cover = null; // не последний - не палим козырь ради необязательной победы
  }

  if (cover) return cover;
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
  const holder = currentHolderEntry(room);
  const winner = room.players.find((p) => p.id === holder.playerId)
    || room.eliminated.find((p) => p.id === holder.playerId);
  if (!winner) {
    // редкий случай: держатель взятки успел выйти из игры до её разрешения -
    // очки просто пропадают, стол очищается как обычно
    room.log.push('Взятка осталась без хозяина (игрок вышел) - очки не засчитаны');
    return { winnerId: null, winnerName: '—', trickPoints: 0, trick: room.trick, winningCombo: holder.cards };
  }

  const trickPoints = room.trick.reduce(
    (sum, e) => sum + e.cards.reduce((s, c) => s + POINTS[c.rank], 0), 0,
  );
  winner.score += trickPoints;

  const comboText = holder.cards.map((c) => `${c.rank}${c.suit}`).join(', ');
  room.log.push(`${winner.name} забирает всю взятку (+${trickPoints} очк., его комбинация [${comboText}] не была перебита)`);

  return { winnerId: winner.id, winnerName: winner.name, trickPoints, trick: room.trick, winningCombo: holder.cards };
}

function finalizeTrick(room, winnerId) {
  if (room.players.length === 0) { room.trick = []; return; }
  let winnerIdx = room.players.findIndex((p) => p.id === winnerId);
  if (winnerIdx === -1) winnerIdx = room.leadIndex < room.players.length ? room.leadIndex : 0;
  // добор начинается с победителя взятки, но идёт по кругу по одной карте -
  // честно делит "хвост" колоды, если она вот-вот закончится
  const drawOrder = [];
  for (let i = 0; i < room.players.length; i++) {
    drawOrder.push(room.players[(winnerIdx + i) % room.players.length]);
  }
  dealRoundRobin(room, drawOrder, HAND_SIZE);

  room.trick = [];
  room.phase = 'playing';

  if (room.players.every((p) => p.hand.length === 0)) {
    const best = room.players.reduce((a, b) => (b.score > a.score ? b : a));
    endRound(room, best);
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

function endRound(room, winner) {
  winner.roundsWon += 1;
  room.phase = 'round_end';
  room.log.push(`Раздача окончена (колода закончилась). ${winner.name} побеждает с ${winner.score} очками.`);
  room.lastWinnerName = winner.name;
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
    deckSize: room.deckSize,
    trumpSuit: room.trumpSuit,
    trumpCard: room.trumpCard,
    trick: room.trick,
    turnPlayerId: room.players[room.turnIndex] ? room.players[room.turnIndex].id : null,
    currentLeaderId: room.trick.length > 0 ? currentHolderEntry(room).playerId : null,
    requiredCount: me ? requiredCountFor(room, me) : null,
    deckCount: room.deck.length,
    log: room.log.slice(-14),
    lastWinnerName: room.lastWinnerName,
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
      avatar: p.avatar || null,
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
  room.overallWinnerName = null;
  room.dealerIndex = -1;
}

module.exports = {
  SUITS, RANKS, POINTS, WIN_SCORE, HAND_SIZE, ELIMINATION_LIMIT,
  createRoom, addPlayer, addBot, findPlayerByToken, kickPlayer, renamePlayer, leaveGame, resetToLobby, setDeckSize, startRound,
  isValidSubmission, playCards, finalizeTrick, chooseBotMove, currentHolderEntry, beatsCard, publicStateFor, cardId,
};
