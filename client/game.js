let socket = null;
let myId = null;
let myName = '';
let lastState = null;

const RED_SUITS = ['♥', '♦'];

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
  div.className = 'card' + (RED_SUITS.includes(card.suit) ? ' red' : '') + (opts.small ? ' small' : '') + (opts.disabled ? ' disabled' : '');
  div.innerHTML = `<div>${card.rank}</div><div class="suit">${card.suit}</div>`;
  if (opts.onClick) div.addEventListener('click', opts.onClick);
  return div;
}

// --- подключение ---
const savedUrl = localStorage.getItem('bura_server_url') || '';
const savedName = localStorage.getItem('bura_name') || '';
document.getElementById('server-url').value = savedUrl;
document.getElementById('player-name').value = savedName;

function connectSocket() {
  const url = document.getElementById('server-url').value.trim().replace(/\/$/, '');
  if (!url) {
    document.getElementById('connect-error').textContent = 'Укажи адрес сервера';
    return null;
  }
  localStorage.setItem('bura_server_url', url);
  const s = io(url, { transports: ['websocket', 'polling'] });
  s.on('connect', () => { myId = s.id; });
  s.on('error_msg', (msg) => {
    document.getElementById('connect-error').textContent = msg;
  });
  s.on('room_update', onRoomUpdate);
  s.on('connect_error', () => {
    document.getElementById('connect-error').textContent = 'Не удалось подключиться к серверу';
  });
  return s;
}

document.getElementById('btn-create').addEventListener('click', () => {
  myName = document.getElementById('player-name').value.trim() || 'Игрок';
  localStorage.setItem('bura_name', myName);
  socket = connectSocket();
  if (!socket) return;
  socket.on('connect', () => {
    myId = socket.id;
    socket.emit('create_room', { name: myName });
  });
});

document.getElementById('btn-join').addEventListener('click', () => {
  myName = document.getElementById('player-name').value.trim() || 'Игрок';
  const code = document.getElementById('room-code').value.trim().toUpperCase();
  if (!code) {
    document.getElementById('connect-error').textContent = 'Введи код комнаты';
    return;
  }
  localStorage.setItem('bura_name', myName);
  socket = connectSocket();
  if (!socket) return;
  socket.on('connect', () => {
    myId = socket.id;
    socket.emit('join_room', { code, name: myName });
  });
});

document.getElementById('btn-start').addEventListener('click', () => {
  socket.emit('start_game');
});

document.getElementById('btn-next-round').addEventListener('click', () => {
  socket.emit('next_round');
});

// --- обновление состояния ---
function onRoomUpdate(state) {
  lastState = state;
  document.getElementById('connect-error').textContent = '';

  if (state.phase === 'lobby') {
    renderLobby(state);
    showScreen('lobby');
  } else if (state.phase === 'playing') {
    renderGame(state);
    showScreen('game');
  } else if (state.phase === 'round_end') {
    renderRoundEnd(state);
    showScreen('roundEnd');
  }
}

function renderLobby(state) {
  document.getElementById('room-code-display').textContent = state.code;
  const list = document.getElementById('lobby-players');
  list.innerHTML = '';
  state.players.forEach((p) => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${p.name}${p.id === myId ? ' (ты)' : ''}</span>` +
      (p.id === state.hostId ? '<span class="host-tag">ХОСТ</span>' : '');
    list.appendChild(li);
  });
  const isHost = state.hostId === myId;
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

  // соперники
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

  // взятка
  const trickArea = document.getElementById('trick-area');
  trickArea.innerHTML = '';
  state.trick.forEach((entry) => {
    const p = state.players.find((pl) => pl.id === entry.playerId);
    const wrap = document.createElement('div');
    wrap.style.textAlign = 'center';
    const label = document.createElement('div');
    label.style.fontSize = '0.7rem';
    label.style.color = '#b9d4c6';
    label.textContent = p ? p.name : '';
    wrap.appendChild(label);
    wrap.appendChild(cardEl(entry.card));
    trickArea.appendChild(wrap);
  });

  // баннер хода
  const banner = document.getElementById('turn-banner');
  if (state.turnPlayerId === myId) {
    banner.textContent = '🎴 Твой ход!';
  } else {
    const p = state.players.find((pl) => pl.id === state.turnPlayerId);
    banner.textContent = p ? `Ходит: ${p.name}` : '';
  }

  // счёт
  const board = document.getElementById('scoreboard');
  board.innerHTML = '';
  state.players.forEach((p) => {
    const div = document.createElement('div');
    div.textContent = `${p.name}: ${p.score}`;
    board.appendChild(div);
  });

  // лог
  const log = document.getElementById('log');
  log.innerHTML = '';
  state.log.forEach((line) => {
    const d = document.createElement('div');
    d.textContent = line;
    log.appendChild(d);
  });
  log.scrollTop = log.scrollHeight;

  // моя рука
  const hand = document.getElementById('my-hand');
  hand.innerHTML = '';
  const me = state.players.find((p) => p.id === myId);
  const myTurn = state.turnPlayerId === myId;
  if (me && me.hand) {
    me.hand.forEach((card) => {
      hand.appendChild(cardEl(card, {
        disabled: !myTurn,
        onClick: () => {
          if (!myTurn) return;
          socket.emit('play_card', { card });
        },
      }));
    });
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
    .forEach((p) => {
      const div = document.createElement('div');
      div.textContent = `${p.name} — раздач выиграно: ${p.roundsWon}`;
      scores.appendChild(div);
    });

  const isHost = state.hostId === myId;
  document.getElementById('btn-next-round').classList.toggle('hidden', !isHost);
  document.getElementById('wait-host-hint').classList.toggle('hidden', isHost);
}
