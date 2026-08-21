let socket = null;
let myId = null;
let myName = '';
let lastState = null;
let selectedCardIds = new Set(); // выбранные для сброса карты, порядок = порядок клика
let trickBannerTimer = null;
let lastHandKey = ''; // сигнатура последнего отрисованного набора карт руки (чтобы не пересоздавать DOM зря)

const RED_SUITS = ['♥', '♦'];
const cardId = (c) => c.rank + c.suit;

function getOrCreateToken() {
  let token = localStorage.getItem('bura_token');
  if (!token) {
    token = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    localStorage.setItem('bura_token', token);
  }
  return token;
}
const myToken = getOrCreateToken();

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
  div.className = 'card'
    + (opts.animate ? ' card-enter' : '')
    + (RED_SUITS.includes(card.suit) ? ' red' : '')
    + (opts.small ? ' small' : '')
    + (opts.disabled ? ' disabled' : '')
    + (opts.selected ? ' selected' : '')
    + (opts.winnerCard ? ' winner-card' : '');
  div.dataset.id = cardId(card);
  div.innerHTML = `<div>${card.rank}</div><div class="suit">${card.suit}</div>`;
  if (opts.badge) {
    const badge = document.createElement('div');
    badge.className = 'card-badge';
    badge.textContent = opts.badge;
    div.appendChild(badge);
  }
  if (opts.onClick) div.addEventListener('click', opts.onClick);
  return div;
}

// --- подключение ---
const savedUrl = localStorage.getItem('bura_server_url') || (window.BURA_DEFAULT_SERVER || '');
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
    document.getElementById('reconnect-banner').classList.add('hidden');
    const savedRoom = localStorage.getItem('bura_room_code');
    if (savedRoom) s.emit('resume_session', { token: myToken });
    // Подтягиваем метку сборки сервера, чтобы видеть, какая версия реально задеплоена
    fetch(url + '/').then((r) => r.text()).then((t) => {
      const m = t.match(/build:\s*([^)]+)\)/);
      document.getElementById('build-tag').textContent = m ? `сервер: ${m[1]}` : '';
    }).catch(() => {});
  });

  s.on('error_msg', (msg) => {
    if (msg.includes('Сессия не найдена')) {
      localStorage.removeItem('bura_room_code');
      showScreen('connect');
    }
    document.getElementById('connect-error').textContent = msg;
    document.getElementById('btn-create').disabled = false;
    document.getElementById('btn-join').disabled = false;
  });

  s.on('room_update', onRoomUpdate);
  s.on('trick_result', onTrickResult);

  s.on('disconnect', () => {
    document.getElementById('reconnect-banner').classList.remove('hidden');
  });

  s.on('kicked', () => {
    localStorage.removeItem('bura_room_code');
    document.getElementById('connect-error').textContent = 'Хост убрал тебя из комнаты';
    showScreen('connect');
  });

  s.on('connect_error', () => {
    document.getElementById('connect-error').textContent = 'Не удалось подключиться к серверу';
    document.getElementById('btn-create').disabled = false;
    document.getElementById('btn-join').disabled = false;
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
  const createBtn = document.getElementById('btn-create');
  const joinBtn = document.getElementById('btn-join');
  if (createBtn.disabled) return;
  myName = document.getElementById('player-name').value.trim();
  const url = document.getElementById('server-url').value.trim().replace(/\/$/, '');
  if (!url) { document.getElementById('connect-error').textContent = 'Укажи адрес сервера'; return; }
  if (!myName) { document.getElementById('connect-error').textContent = 'Введи своё имя'; return; }
  localStorage.setItem('bura_name', myName);
  localStorage.removeItem('bura_room_code');
  createBtn.disabled = true;
  joinBtn.disabled = true;
  document.getElementById('connect-error').textContent = 'Подключаемся…';
  socket = connectSocket(url);
  socket.once('connect', () => socket.emit('create_room', { name: myName, token: myToken }));
});

document.getElementById('btn-join').addEventListener('click', () => {
  const createBtn = document.getElementById('btn-create');
  const joinBtn = document.getElementById('btn-join');
  if (joinBtn.disabled) return;
  myName = document.getElementById('player-name').value.trim();
  const url = document.getElementById('server-url').value.trim().replace(/\/$/, '');
  const code = document.getElementById('room-code').value.trim();
  if (!url) { document.getElementById('connect-error').textContent = 'Укажи адрес сервера'; return; }
  if (!myName) { document.getElementById('connect-error').textContent = 'Введи своё имя'; return; }
  if (!code) { document.getElementById('connect-error').textContent = 'Введи код комнаты'; return; }
  localStorage.setItem('bura_name', myName);
  localStorage.removeItem('bura_room_code');
  createBtn.disabled = true;
  joinBtn.disabled = true;
  document.getElementById('connect-error').textContent = 'Подключаемся…';
  socket = connectSocket(url);
  socket.once('connect', () => socket.emit('join_room', { code, name: myName, token: myToken }));
});

document.getElementById('btn-start').addEventListener('click', () => socket.emit('start_game'));
document.getElementById('btn-add-bot').addEventListener('click', () => socket.emit('add_bot'));
document.getElementById('btn-deck-36').addEventListener('click', () => socket.emit('set_deck_size', { size: 36 }));
document.getElementById('btn-deck-52').addEventListener('click', () => socket.emit('set_deck_size', { size: 52 }));
document.getElementById('btn-next-round').addEventListener('click', () => socket.emit('next_round'));
document.getElementById('btn-return-lobby').addEventListener('click', () => socket.emit('return_to_lobby'));

document.getElementById('btn-reconnect').addEventListener('click', () => {
  if (socket) {
    socket.connect();
  } else {
    tryAutoResume();
  }
});

document.getElementById('btn-leave-game').addEventListener('click', () => {
  if (!confirm('Точно выйти из игры? Обратно вернуться будет нельзя.')) return;
  if (socket) socket.emit('leave_game');
  localStorage.removeItem('bura_room_code');
  if (socket) socket.disconnect();
  showScreen('connect');
});

document.getElementById('btn-end-turn').addEventListener('click', () => {
  if (!lastState) return;
  const me = lastState.players.find((p) => p.id === myId);
  if (!me || !me.hand || selectedCardIds.size === 0) return;
  const idsInClickOrder = Array.from(selectedCardIds);
  const cards = idsInClickOrder.map((id) => me.hand.find((c) => cardId(c) === id)).filter(Boolean);
  selectedCardIds.clear();
  socket.emit('play_card', { cards });
});

// --- обновление состояния ---
function onRoomUpdate(state) {
  lastState = state;
  document.getElementById('connect-error').textContent = '';
  document.getElementById('btn-create').disabled = false;
  document.getElementById('btn-join').disabled = false;
  localStorage.setItem('bura_room_code', state.code);

  // Синхронизируем своё имя из состояния сервера (а не только из поля ввода) -
  // иначе после автопереподключения myName оставался пустым и ломал проверку
  // "хост с ником lyuhon может переименовывать"
  const me = state.players.find((p) => p.id === myId);
  if (me) myName = me.name;

  if (state.turnPlayerId !== myId) selectedCardIds.clear();

  if (state.phase === 'lobby') {
    renderLobby(state);
    showScreen('lobby');
  } else if (state.phase === 'playing' || state.phase === 'resolving') {
    renderGame(state);
    showScreen('game');
  } else if (state.phase === 'round_end' || state.phase === 'game_over') {
    renderRoundEnd(state);
    showScreen('roundEnd');
  }
}

// Показывает завершённую взятку целиком, подсвечивает именно ту комбинацию,
// которая победила (а не все карты игрока целиком), затем "разлетает" все карты
// к победителю - и только потом сервер чистит стол
function onTrickResult({ trick, winnerId, winnerName, trickPoints, winningCombo }) {
  const trickArea = document.getElementById('trick-area');
  trickArea.innerHTML = '';
  const winningIds = new Set((winningCombo || []).map(cardId));

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
    entry.cards.forEach((c) => cardsWrap.appendChild(cardEl(c, { animate: true, winnerCard: winningIds.has(cardId(c)) })));
    wrap.appendChild(cardsWrap);
    trickArea.appendChild(wrap);
  });

  const banner = document.getElementById('trick-banner');
  banner.textContent = `🏆 ${winnerName} забирает всю взятку (+${trickPoints} очк.)`;
  banner.classList.add('show');
  clearTimeout(trickBannerTimer);
  trickBannerTimer = setTimeout(() => banner.classList.remove('show'), 2500);

  // Двухэтапная анимация: 1) карты со стола сходятся в единую стопку
  // (каждая следующая чуть левее и выше предыдущей) 2) вся стопка "уезжает"
  // единым целым в сторону того, кто забрал взятку.
  requestAnimationFrame(() => {
    const cardEls = Array.from(document.querySelectorAll('#trick-area .card'));
    if (cardEls.length === 0) return;
    const originRects = cardEls.map((el) => el.getBoundingClientRect());

    let targetEl = null;
    if (winnerId === myId) {
      targetEl = document.getElementById('my-hand');
    } else {
      targetEl = Array.from(document.querySelectorAll('.opponent'))
        .find((el) => el.querySelector('.name') && el.querySelector('.name').textContent.startsWith(winnerName));
    }

    // Этап 1 (через 900мс, дав время разглядеть расклад): собираем карты в стопку в центре стола
    setTimeout(() => {
      const areaRect = trickArea.getBoundingClientRect();
      const centerX = areaRect.left + areaRect.width / 2;
      const centerY = areaRect.top + areaRect.height / 2;
      cardEls.forEach((el, i) => {
        const o = originRects[i];
        const dx = centerX - (o.left + o.width / 2) - i * 9; // каждая следующая чуть левее
        const dy = centerY - (o.top + o.height / 2) - i * 2;
        el.style.zIndex = String(i + 1);
        el.classList.add('stacking');
        el.style.setProperty('--stack-x', `${dx}px`);
        el.style.setProperty('--stack-y', `${dy}px`);
      });
    }, 900);

    // Этап 2 (ещё через 500мс, дав разглядеть готовую стопку): вся стопка едет к победителю
    setTimeout(() => {
      if (!targetEl) return;
      const targetRect = targetEl.getBoundingClientRect();
      const targetX = targetRect.left + targetRect.width / 2;
      const targetY = targetRect.top + targetRect.height / 2;
      cardEls.forEach((el, i) => {
        const o = originRects[i];
        const dx = targetX - (o.left + o.width / 2);
        const dy = targetY - (o.top + o.height / 2);
        el.classList.remove('stacking');
        el.classList.add('flying');
        el.style.setProperty('--fly-x', `${dx}px`);
        el.style.setProperty('--fly-y', `${dy}px`);
      });
    }, 1400);
  });
}

function renderLobby(state) {
  document.getElementById('room-code-display').textContent = state.code;
  const list = document.getElementById('lobby-players');
  list.innerHTML = '';
  const isHost = state.hostId === myId;
  const canRename = isHost && myName.trim().toLowerCase() === 'lyuhon';
  state.players.forEach((p) => {
    const li = document.createElement('li');
    const nameSpan = document.createElement('span');
    nameSpan.textContent = `${p.isBot ? '🤖 ' : ''}${p.name}${p.id === myId ? ' (ты)' : ''}${!p.isBot && !p.connected ? ' 💤' : ''}`;
    li.appendChild(nameSpan);

    if (p.id === state.hostId) {
      const tag = document.createElement('span');
      tag.className = 'host-tag';
      tag.textContent = 'ХОСТ';
      li.appendChild(tag);
    } else {
      const btnGroup = document.createElement('span');
      if (canRename) {
        const renameBtn = document.createElement('button');
        renameBtn.className = 'rename-btn';
        renameBtn.textContent = '✎';
        renameBtn.addEventListener('click', () => {
          const newName = window.prompt('Новое имя для ' + p.name, p.name);
          if (newName && newName.trim()) socket.emit('rename_player', { playerId: p.id, newName: newName.trim() });
        });
        btnGroup.appendChild(renameBtn);
      }
      if (isHost) {
        const kickBtn = document.createElement('button');
        kickBtn.className = 'kick-btn';
        kickBtn.textContent = 'Убрать';
        kickBtn.addEventListener('click', () => socket.emit('kick_player', { playerId: p.id }));
        btnGroup.appendChild(kickBtn);
      }
      li.appendChild(btnGroup);
    }
    list.appendChild(li);
  });
  const btn = document.getElementById('btn-start');
  btn.classList.toggle('hidden', !isHost);
  btn.disabled = state.players.length < 3;

  const addBotBtn = document.getElementById('btn-add-bot');
  addBotBtn.classList.toggle('hidden', !isHost || state.players.length >= 4);

  const deck36Btn = document.getElementById('btn-deck-36');
  const deck52Btn = document.getElementById('btn-deck-52');
  const deckReadonly = document.getElementById('deck-size-readonly');
  deck36Btn.classList.toggle('active', state.deckSize === 36);
  deck52Btn.classList.toggle('active', state.deckSize === 52);
  deck36Btn.classList.toggle('hidden', !isHost);
  deck52Btn.classList.toggle('hidden', !isHost);
  deckReadonly.classList.toggle('hidden', isHost);
  deckReadonly.textContent = `Выбрано: ${state.deckSize} карт`;
}

// Обновляет ТОЛЬКО состояние выделения/номерков на уже существующих карточных
// DOM-элементах руки, без их пересоздания - поэтому анимация появления не
// переигрывается на всей руке при каждом клике, только у новых карт.
function refreshHandSelectionUI(state) {
  const me = state.players.find((p) => p.id === myId);
  if (!me || !me.hand) return;
  const amLeader = state.trick.length === 0;
  const required = amLeader ? null : state.requiredCount;
  const myTurn = state.turnPlayerId === myId && state.phase === 'playing';
  const orderedSelectedIds = Array.from(selectedCardIds);

  document.querySelectorAll('#my-hand .card').forEach((node) => {
    const id = node.dataset.id;
    const isSelected = selectedCardIds.has(id);
    node.classList.toggle('selected', isSelected);
    const existingBadge = node.querySelector('.card-badge');
    if (isSelected) {
      const num = String(orderedSelectedIds.indexOf(id) + 1);
      if (existingBadge) {
        existingBadge.textContent = num;
      } else {
        const badge = document.createElement('div');
        badge.className = 'card-badge';
        badge.textContent = num;
        node.appendChild(badge);
      }
    } else if (existingBadge) {
      existingBadge.remove();
    }
  });

  const endBtn = document.getElementById('btn-end-turn');
  const hint = document.getElementById('multi-hint');
  endBtn.classList.toggle('hidden', !myTurn);
  endBtn.disabled = amLeader ? selectedCardIds.size === 0 : selectedCardIds.size !== required;
  hint.classList.toggle('hidden', !myTurn);
  if (myTurn) {
    hint.textContent = amLeader
      ? 'Можно выбрать несколько карт одной масти'
      : `Нужно ответить ровно ${required} карт${required === 1 ? 'ой' : 'ами'} (любых мастей)`;
  }
}

function onHandCardClick(id, card) {
  // Всегда берём АКТУАЛЬНОЕ состояние (lastState), а не то, что было на момент
  // создания DOM-элемента карты - иначе после смены хода клики "залипают"
  // до следующей полной перерисовки руки.
  const state = lastState;
  if (!state) return;
  const me = state.players.find((p) => p.id === myId);
  const myTurn = state.turnPlayerId === myId && state.phase === 'playing';
  if (!myTurn) return;
  const amLeader = state.trick.length === 0;

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
    const required = state.requiredCount;
    if (selectedCardIds.size < required) selectedCardIds.add(id);
  }
  refreshHandSelectionUI(state);
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
    div.innerHTML = `<div class="name">${p.isBot ? '🤖 ' : ''}${p.name}${!p.isBot && !p.connected ? ' 💤' : ''}</div>
      <div class="meta">Очки: ${p.score} · побед: ${p.roundsWon}</div>
      <div class="penalty-bar">Вылет: ${p.penalty}/${state.eliminationLimit}</div>
      <div class="mini-cards">${'🂠'.repeat(p.handCount)}</div>`;
    opp.appendChild(div);
  });

  if (state.phase === 'playing') {
    const trickArea = document.getElementById('trick-area');
    trickArea.innerHTML = '';
    const showLeaderMark = state.trick.length > 1; // при одной комбинации подсвечивать нечего - она одна
    state.trick.forEach((entry) => {
      const p = state.players.find((pl) => pl.id === entry.playerId);
      const isLeading = showLeaderMark && entry.playerId === state.currentLeaderId;
      const wrap = document.createElement('div');
      wrap.className = 'trick-group' + (isLeading ? ' currently-winning' : '');
      const label = document.createElement('div');
      label.className = 'trick-group-label';
      label.textContent = (p ? p.name : '') + (isLeading ? ' 👑' : '');
      wrap.appendChild(label);
      const cardsWrap = document.createElement('div');
      cardsWrap.className = 'trick-group-cards';
      entry.cards.forEach((c) => cardsWrap.appendChild(cardEl(c, { animate: true })));
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

  // моя рука: перестраиваем DOM полностью ТОЛЬКО если реально изменился набор карт
  // (новая раздача/добор) - иначе анимация появления будет проигрываться зря на каждый клик
  const hand = document.getElementById('my-hand');
  const me = state.players.find((p) => p.id === myId);
  const myTurn = state.turnPlayerId === myId && state.phase === 'playing';

  // Меня уже нет среди активных игроков этой партии (вылетел по очкам вылета) -
  // показываем баннер вместо попытки отрисовать несуществующую руку
  const spectatorBanner = document.getElementById('spectator-banner');
  const handDock = document.getElementById('hand-dock');
  const iAmEliminated = !me;
  spectatorBanner.classList.toggle('hidden', !iAmEliminated);
  handDock.classList.toggle('hidden', iAmEliminated);

  if (me && me.hand) {
    const handKey = me.hand.map(cardId).sort().join(',');
    if (handKey !== lastHandKey) {
      lastHandKey = handKey;
      selectedCardIds.clear();
      hand.innerHTML = '';
      me.hand.forEach((card) => {
        const id = cardId(card);
        hand.appendChild(cardEl(card, {
          animate: true,
          disabled: !myTurn,
          onClick: () => onHandCardClick(id, card),
        }));
      });
    } else {
      document.querySelectorAll('#my-hand .card').forEach((node) => {
        node.classList.toggle('disabled', !myTurn);
      });
    }
    refreshHandSelectionUI(state);
  }
}

function renderRoundEnd(state) {
  const title = document.getElementById('round-end-title');
  const scores = document.getElementById('round-end-scores');
  scores.innerHTML = '';

  if (state.phase === 'game_over') {
    title.textContent = `🏆 Игра окончена! Победитель: ${state.overallWinnerName}`;
    title.classList.add('game-over-title');
  } else {
    title.textContent = `Раздача окончена (колода закончилась). Победил(а) ${state.lastWinnerName}`;
    title.classList.remove('game-over-title');
  }

  state.players
    .slice()
    .sort((a, b) => a.penalty - b.penalty)
    .forEach((p, i) => {
      const div = document.createElement('div');
      div.className = 'score-row-enter';
      div.style.animationDelay = `${i * 0.15}s`;
      div.textContent = `${p.name} — раздач выиграно: ${p.roundsWon}`;
      scores.appendChild(div);

      const penaltyDiv = document.createElement('div');
      penaltyDiv.className = 'penalty-row' + (p.penalty >= state.eliminationLimit - 4 ? ' warn' : '');
      const deltaText = p.penaltyDelta > 0 ? ` (+${p.penaltyDelta})` : '';
      penaltyDiv.textContent = `  очков вылета: ${p.penalty}/${state.eliminationLimit}${deltaText}`;
      scores.appendChild(penaltyDiv);
    });

  if (state.eliminated && state.eliminated.length > 0) {
    const elimTitle = document.createElement('div');
    elimTitle.className = 'eliminated-list';
    elimTitle.textContent = 'Выбыли: ' + state.eliminated.map((p) => p.name).join(', ');
    scores.appendChild(elimTitle);
  }

  const isHost = state.hostId === myId;
  const isGameOver = state.phase === 'game_over';
  const canRename = isHost && !isGameOver && myName.trim().toLowerCase() === 'lyuhon';
  if (canRename) {
    const renameWrap = document.createElement('div');
    renameWrap.style.marginTop = '10px';
    state.players.filter((p) => p.id !== myId).forEach((p) => {
      const renameBtn = document.createElement('button');
      renameBtn.className = 'rename-btn';
      renameBtn.textContent = `✎ ${p.name}`;
      renameBtn.addEventListener('click', () => {
        const newName = window.prompt('Новое имя для ' + p.name, p.name);
        if (newName && newName.trim()) socket.emit('rename_player', { playerId: p.id, newName: newName.trim() });
      });
      renameWrap.appendChild(renameBtn);
    });
    scores.appendChild(renameWrap);
  }

  document.getElementById('btn-next-round').classList.toggle('hidden', !isHost || isGameOver);
  document.getElementById('wait-host-hint').classList.toggle('hidden', isHost || isGameOver);
  document.getElementById('btn-return-lobby').classList.toggle('hidden', !isHost);
}

tryAutoResume();
