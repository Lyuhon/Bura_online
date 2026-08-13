let socket = null;
let myId = null;
let myName = '';
let lastState = null;
let selectedCardIds = new Set(); // выбранные для сброса карты (одной масти)
let trickBannerTimer = null;

const RED_SUITS = ['♥', '♦'];
const cardId = (c) => c.rank + c.suit;

// --- постоянный токен игрока (переживает сворачивание/перезагрузку страницы) ---
function getOrCreateToken() {
  let token = localStorage.getItem('bura_token');
  if (!token) {
    token = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    localStorage.setItem('bura_token', token);
  }
  return token;
}
const myToken = getOrCreateToken();

// --- элементы ---
const screens = {
  connect: document.getElementById('screen-connect'),
  lobby: document.getElementById('screen-lobby'),
  game: document.getElementById('screen-game'),
  roundEnd: document.getElementById('screen-round-end'),
};

function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.add('hidden'));
  screens[name].classList.remove('hidden');
}

function cardEl(card, opts = {}) {
  const div = document.createElement('div');
  div.className = 'card card-enter'
    + (RED_SUITS.includes(card.suit) ? ' red' : '')
    + (opts.small ? ' small' : '')
    + (opts.disabled ? ' disabled' : '')
    + (opts.selected ? ' selected' : '')
    + (opts.winnerCard ? ' winner-card' : '');
  div.innerHTML = `<div>${card.rank}</div><div class="suit">${card.suit}</div>`;
  if (opts.onClick) div.addEventListener('click', opts.onClick);
  return div;
}

// --- подключение ---
const savedUrl = localStorage.getItem('bura_server_url') || '';
const savedName = localStorage.getItem('bura_name') || '';
document.getElementById('server-url').value = savedUrl;
document.getElementById('player-name').value = savedName;

function connectSocket(url) {
  localStorage.setItem('bura_server_url', url);
  const s = io(url, {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 3000,
  });

  s.on('connect', () => {
    myId = s.id;
    const savedRoom = localStorage.getItem('bura_room_code');
    if (savedRoom) {
      s.emit('resume_session', { token: myToken });
    }
  });

  s.on('error_msg', (msg) => {
    if (msg.includes('Сессия не найдена')) {
      localStorage.removeItem('bura_room_code');
      showScreen('connect');
    }
    document.getElementById('connect-error').textContent = msg;
  });

  s.on('room_update', onRoomUpdate);
  s.on('trick_result', onTrickResult);

  s.on('kicked', () => {
    localStorage.removeItem('bura_room_code');
    document.getElementById('connect-error').textContent = 'Хост убрал тебя из комнаты';
    showScreen('connect');
  });

  s.on('connect_error', () => {
    document.getElementById('connect-error').textContent = 'Не удалось подключиться к серверу';
  });

  return s;
}

function tryAutoResume() {
  const url = savedUrl.trim().replace(/\/$/, '');
  const roomCode = localStorage.getItem('bura_room_code');
  if (!url || !roomCode) return;
  socket = connectSocket(url);
}

document.getElementById('btn-create').addEventListener('click', () => {
  myName = document.getElementById('player-name').value.trim();
  const url = document.getElementById('server-url').value.trim().replace(/\/$/, '');
  if (!url) {
    document.getElementById('connect-error').textContent = 'Укажи адрес сервера';
    return;
  }
  if (!myName) {
    document.getElementById('connect-error').textContent = 'Введи своё имя';
    return;
  }
  localStorage.setItem('bura_name', myName);
  localStorage.removeItem('bura_room_code');
  socket = connectSocket(url);
  socket.once('connect', () => {
    socket.emit('create_room', { name: myName, token: myToken });
  });
});

document.getElementById('btn-join').addEventListener('click', () => {
  myName = document.getElementById('player-name').value.trim();
  const url = document.getElementById('server-url').value.trim().replace(/\/$/, '');
  const code = document.getElementById('room-code').value.trim().toUpperCase();
  if (!url) {
    document.getElementById('connect-error').textContent = 'Укажи адрес сервера';
    return;
  }
  if (!myName) {
    document.getElementById('connect-error').textContent = 'Введи своё имя';
    return;
  }
  if (!code) {
    document.getElementById('connect-error').textContent = 'Введи код комнаты';
    return;
  }
  localStorage.setItem('bura_name', myName);
  localStorage.removeItem('bura_room_code');
  socket = connectSocket(url);
  socket.once('connect', () => {
    socket.emit('join_room', { code, name: myName, token: myToken });
  });
});

document.getElementById('btn-start').addEventListener('click', () => {
  socket.emit('start_game');
});

document.getElementById('btn-next-round').addEventListener('click', () => {
  socket.emit('next_round');
});

document.getElementById('btn-end-turn').addEventListener('click', () => {
  if (!lastState) return;
  const me = lastState.players.find((p) => p.id === myId);
  if (!me || !me.hand || selectedCardIds.size === 0) return;
  const cards = me.hand.filter((c) => selectedCardIds.has(cardId(c)));
  selectedCardIds.clear();
  socket.emit('play_card', { cards });
});

// --- обновление состояния ---
function onRoomUpdate(state) {
  lastState = state;
  document.getElementById('connect-error').textContent = '';
  localStorage.setItem('bura_room_code', state.code);

  // сбрасываем выбор карт, если ход уже не наш или начался новый ход
  if (state.turnPlayerId !== myId) selectedCardIds.clear();

  if (state.phase === 'lobby') {
    renderLobby(state);
    showScreen('lobby');
  } else if (state.phase === 'playing' || state.phase === 'resolving') {
    renderGame(state);
    showScreen('game');
  } else if (state.phase === 'round_end') {
    renderRoundEnd(state);
    showScreen('roundEnd');
  }
}

// Показывает завершённую взятку целиком, подсвечивает победившие карты в каждой колонке,
// затем "разлетает" все карты к тому, кто забрал взятку - и только потом сервер чистит стол
function onTrickResult({ trick, winnerId, winnerName, trickPoints, columns }) {
  const trickArea = document.getElementById('trick-area');
  trickArea.innerHTML = '';

  const winningCardKeys = new Set();
  (columns || []).forEach((col) => {
    const winEntry = col.entries.find((e) => e.playerId === col.winnerId);
    if (winEntry) winningCardKeys.add(`${col.winnerId}:${col.index}`);
  });

  trick.forEach((entry) => {
    const p = lastState ? lastState.players.find((pl) => pl.id === entry.playerId) : null;
    const wrap = document.createElement('div');
    wrap.className = 'trick-group' + (entry.playerId === winnerId ? ' winner-group' : '');
    const label = document.createElement('div');
    label.className = 'trick-group-label';
    label.textContent = p ? p.name : '';
    wrap.appendChild(label);
    const cardsWrap = document.createElement('div');
    cardsWrap.className = 'trick-group-cards';
    entry.cards.forEach((c, i) => {
      const isColWinner = winningCardKeys.has(`${entry.playerId}:${i}`);
      cardsWrap.appendChild(cardEl(c, { winnerCard: isColWinner }));
    });
    wrap.appendChild(cardsWrap);
    trickArea.appendChild(wrap);
  });

  const banner = document.getElementById('trick-banner');
  banner.textContent = `🏆 ${winnerName} забирает взятку (+${trickPoints} очк.)`;
  banner.classList.add('show');
  clearTimeout(trickBannerTimer);
  trickBannerTimer = setTimeout(() => banner.classList.remove('show'), 1700);

  // Находим точку назначения (аватар победителя) и разлетаем карты к ней
  requestAnimationFrame(() => {
    let targetEl = null;
    if (winnerId === myId) {
      targetEl = document.getElementById('my-hand');
    } else {
      targetEl = Array.from(document.querySelectorAll('.opponent'))
        .find((el) => el.querySelector('.name') && el.querySelector('.name').textContent.startsWith(winnerName));
    }
    if (!targetEl) return;
    const targetRect = targetEl.getBoundingClientRect();
    const targetX = targetRect.left + targetRect.width / 2;
    const targetY = targetRect.top + targetRect.height / 2;

    setTimeout(() => {
      document.querySelectorAll('#trick-area .card').forEach((cardNode) => {
        const r = cardNode.getBoundingClientRect();
        const dx = targetX - (r.left + r.width / 2);
        const dy = targetY - (r.top + r.height / 2);
        cardNode.classList.add('flying');
        cardNode.style.setProperty('--fly-x', `${dx}px`);
        cardNode.style.setProperty('--fly-y', `${dy}px`);
      });
    }, 500); // сперва даём разглядеть, кто кого побил, потом улетает
  });
}

function renderLobby(state) {
  document.getElementById('room-code-display').textContent = state.code;
  const list = document.getElementById('lobby-players');
  list.innerHTML = '';
  const isHost = state.hostId === myId;
  state.players.forEach((p) => {
    const li = document.createElement('li');
    const nameSpan = document.createElement('span');
    nameSpan.textContent = `${p.name}${p.id === myId ? ' (ты)' : ''}${p.connected ? '' : ' 💤'}`;
    li.appendChild(nameSpan);

    if (p.id === state.hostId) {
      const tag = document.createElement('span');
      tag.className = 'host-tag';
      tag.textContent = 'ХОСТ';
      li.appendChild(tag);
    } else if (isHost) {
      const kickBtn = document.createElement('button');
      kickBtn.className = 'kick-btn';
      kickBtn.textContent = 'Убрать';
      kickBtn.addEventListener('click', () => {
        socket.emit('kick_player', { playerId: p.id });
      });
      li.appendChild(kickBtn);
    }
    list.appendChild(li);
  });
  const btn = document.getElementById('btn-start');
  btn.classList.toggle('hidden', !isHost);
  btn.disabled = state.players.length < 3;
}

function renderGame(state) {
  document.getElementById('room-tag').textContent = `Комната ${state.code}`;
  document.getElementById('deck-count').textContent = `В колоде: ${state.deckCount}`;

  const trumpDiv = document.getElementById('trump-display');
  trumpDiv.innerHTML = 'Козырь: ';
  if (state.trumpCard) trumpDiv.appendChild(cardEl(state.trumpCard, { small: true }));

  const opp = document.getElementById('opponents');
  opp.innerHTML = '';
  state.players.filter((p) => p.id !== myId).forEach((p) => {
    const div = document.createElement('div');
    div.className = 'opponent' + (p.id === state.turnPlayerId ? ' active' : '');
    div.innerHTML = `<div class="name">${p.name}${p.connected ? '' : ' 💤'}</div>
      <div class="meta">Очки: ${p.score} · побед: ${p.roundsWon}</div>
      <div class="mini-cards">${'🂠'.repeat(p.handCount)}</div>`;
    opp.appendChild(div);
  });

  // Обычный вид стола (пока взятка не завершена целиком - трик_result рисует финальный кадр сам)
  if (state.phase === 'playing') {
    const trickArea = document.getElementById('trick-area');
    trickArea.innerHTML = '';
    state.trick.forEach((entry) => {
      const p = state.players.find((pl) => pl.id === entry.playerId);
      const wrap = document.createElement('div');
      wrap.className = 'trick-group';
      const label = document.createElement('div');
      label.className = 'trick-group-label';
      label.textContent = p ? p.name : '';
      wrap.appendChild(label);
      const cardsWrap = document.createElement('div');
      cardsWrap.className = 'trick-group-cards';
      entry.cards.forEach((c) => cardsWrap.appendChild(cardEl(c)));
      wrap.appendChild(cardsWrap);
      trickArea.appendChild(wrap);
    });
  }

  const banner = document.getElementById('turn-banner');
  if (state.phase === 'resolving') {
    banner.textContent = '';
  } else if (state.turnPlayerId === myId) {
    banner.textContent = '🎴 Твой ход! Можно выбрать несколько карт одной масти';
  } else {
    const p = state.players.find((pl) => pl.id === state.turnPlayerId);
    banner.textContent = p ? `Ходит: ${p.name}` : '';
  }

  const board = document.getElementById('scoreboard');
  board.innerHTML = '';
  state.players.forEach((p) => {
    const div = document.createElement('div');
    div.textContent = `${p.name}: ${p.score}`;
    board.appendChild(div);
  });

  const log = document.getElementById('log');
  log.innerHTML = '';
  state.log.forEach((line) => {
    const d = document.createElement('div');
    d.textContent = line;
    log.appendChild(d);
  });
  log.scrollTop = log.scrollHeight;

  // моя рука - выбор нескольких карт одной масти + кнопка "Закончить ход"
  const hand = document.getElementById('my-hand');
  hand.innerHTML = '';
  const me = state.players.find((p) => p.id === myId);
  const myTurn = state.turnPlayerId === myId && state.phase === 'playing';
  const endBtn = document.getElementById('btn-end-turn');
  const hint = document.getElementById('multi-hint');

  if (me && me.hand) {
    const amLeader = state.trick.length === 0;
    const required = amLeader ? null : state.requiredCount;
    me.hand.forEach((card) => {
      const id = cardId(card);
      hand.appendChild(cardEl(card, {
        disabled: !myTurn,
        selected: selectedCardIds.has(id),
        onClick: () => {
          if (!myTurn) return;
          if (selectedCardIds.has(id)) {
            selectedCardIds.delete(id);
          } else if (amLeader) {
            if (selectedCardIds.size === 0) {
              selectedCardIds.add(id);
            } else {
              const firstSelected = me.hand.find((c) => selectedCardIds.has(cardId(c)));
              if (firstSelected && firstSelected.suit !== card.suit) selectedCardIds.clear();
              selectedCardIds.add(id);
            }
          } else {
            // отвечающий: масти любые, но не больше требуемого количества
            if (selectedCardIds.size < required) selectedCardIds.add(id);
          }
          renderGame(state);
        },
      }));
    });

    endBtn.classList.toggle('hidden', !myTurn);
    endBtn.disabled = amLeader ? selectedCardIds.size === 0 : selectedCardIds.size !== required;
    hint.classList.toggle('hidden', !myTurn);
    if (myTurn) {
      hint.textContent = amLeader
        ? 'Можно выбрать несколько карт одной масти'
        : `Нужно ответить ровно ${required} карт${required === 1 ? 'ой' : 'ами'} (любых мастей)`;
    }
  }
}

function renderRoundEnd(state) {
  const title = document.getElementById('round-end-title');
  title.textContent = state.lastWinnerIsBura ? `🔥 БУРА! Победил(а) ${state.lastWinnerName}` : `Раздача окончена. Победил(а) ${state.lastWinnerName}`;

  const scores = document.getElementById('round-end-scores');
  scores.innerHTML = '';
  state.players
    .slice()
    .sort((a, b) => b.roundsWon - a.roundsWon)
    .forEach((p, i) => {
      const div = document.createElement('div');
      div.textContent = `${p.name} — раздач выиграно: ${p.roundsWon}`;
      div.className = 'score-row-enter';
      div.style.animationDelay = `${i * 0.15}s`;
      scores.appendChild(div);
    });

  const isHost = state.hostId === myId;
  document.getElementById('btn-next-round').classList.toggle('hidden', !isHost);
  document.getElementById('wait-host-hint').classList.toggle('hidden', isHost);
}

tryAutoResume();
