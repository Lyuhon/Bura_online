let socket = null;
let myId = null;
let myName = '';
let lastState = null;
let selectedCardIds = new Set(); // выбранные для сброса карты, порядок = порядок клика
let justSubmitted = false; // true сразу после своего хода, до прихода настоящего обновления с сервера
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
    + (opts.tiny ? ' tiny' : '')
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
const savedAvatar = localStorage.getItem('bura_avatar') || '';
let myAvatar = savedAvatar;
document.getElementById('server-url').value = savedUrl;
document.getElementById('player-name').value = savedName;

// Выбор аватарки-эмодзи (по желанию) - если не выбрал, используется дефолтная иконка
document.querySelectorAll('.avatar-opt').forEach((btn) => {
  if (btn.dataset.emoji === savedAvatar) btn.classList.add('selected');
  btn.addEventListener('click', () => {
    document.querySelectorAll('.avatar-opt').forEach((b) => b.classList.remove('selected'));
    btn.classList.add('selected');
    myAvatar = btn.dataset.emoji;
    localStorage.setItem('bura_avatar', myAvatar);
  });
});

// Дефолтная аватарка - первая буква имени в кружке (зелёное кольцо у людей, золотое у ботов)

function avatarHTML(p) {
  if (p.isBot) return `<div class="avatar-circle bot-avatar">🤖</div>`;
  if (p.avatar) return `<div class="avatar-circle emoji-avatar">${p.avatar}</div>`;
  const initial = (p.name || '?').trim().charAt(0).toUpperCase() || '?';
  return `<div class="avatar-circle default-avatar">${initial}</div>`;
}

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
  socket.once('connect', () => socket.emit('create_room', { name: myName, token: myToken, avatar: myAvatar }));
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
  socket.once('connect', () => socket.emit('join_room', { code, name: myName, token: myToken, avatar: myAvatar }));
});

document.getElementById('btn-start').addEventListener('click', () => socket.emit('start_game'));
document.getElementById('btn-add-bot').addEventListener('click', () => socket.emit('add_bot'));
document.getElementById('btn-deck-36').addEventListener('click', () => socket.emit('set_deck_size', { size: 36 }));
document.getElementById('btn-deck-52').addEventListener('click', () => socket.emit('set_deck_size', { size: 52 }));
document.getElementById('btn-next-round').addEventListener('click', () => socket.emit('next_round'));
document.getElementById('btn-return-lobby').addEventListener('click', () => socket.emit('return_to_lobby'));

document.getElementById('history-toggle').addEventListener('click', () => {
  const log = document.getElementById('log');
  const chevron = document.getElementById('history-chevron');
  const willShow = log.classList.contains('hidden');
  log.classList.toggle('hidden', !willShow);
  chevron.classList.toggle('open', willShow);
});

document.getElementById('btn-reconnect').addEventListener('click', () => {
  if (socket) {
    socket.connect();
  } else {
    tryAutoResume();
  }
});

// Универсальный красивый bottom sheet вместо стандартного браузерного confirm()
function showConfirmSheet(message, onConfirm) {
  const overlay = document.getElementById('sheet-overlay');
  const sheet = document.getElementById('confirm-sheet');
  document.getElementById('sheet-message').textContent = message;

  overlay.classList.remove('hidden');
  sheet.classList.remove('hidden');
  requestAnimationFrame(() => {
    overlay.classList.add('show');
    sheet.classList.add('show');
  });

  function close() {
    overlay.classList.remove('show');
    sheet.classList.remove('show');
    setTimeout(() => {
      overlay.classList.add('hidden');
      sheet.classList.add('hidden');
    }, 300);
    confirmBtn.onclick = null;
    cancelBtn.onclick = null;
    overlay.onclick = null;
  }

  const confirmBtn = document.getElementById('sheet-confirm-btn');
  const cancelBtn = document.getElementById('sheet-cancel-btn');
  confirmBtn.onclick = () => { close(); onConfirm(); };
  cancelBtn.onclick = close;
  overlay.onclick = close;
}

// Простой toggle-sheet без подтверждения (для меню)
function toggleMenuSheet(show) {
  const overlay = document.getElementById('sheet-overlay-menu');
  const sheet = document.getElementById('menu-sheet');
  if (show) {
    overlay.classList.remove('hidden');
    sheet.classList.remove('hidden');
    requestAnimationFrame(() => { overlay.classList.add('show'); sheet.classList.add('show'); });
  } else {
    overlay.classList.remove('show');
    sheet.classList.remove('show');
    setTimeout(() => { overlay.classList.add('hidden'); sheet.classList.add('hidden'); }, 300);
  }
}

document.getElementById('btn-menu').addEventListener('click', () => toggleMenuSheet(true));
document.getElementById('menu-close-btn').addEventListener('click', () => toggleMenuSheet(false));
document.getElementById('sheet-overlay-menu').addEventListener('click', () => toggleMenuSheet(false));
document.getElementById('menu-leave-btn').addEventListener('click', () => {
  toggleMenuSheet(false);
  showConfirmSheet('Точно выйти из игры? Обратно вернуться будет нельзя.', () => {
    if (socket) socket.emit('leave_game');
    localStorage.removeItem('bura_room_code');
    if (socket) socket.disconnect();
    showScreen('connect');
  });
});

document.getElementById('btn-end-turn').addEventListener('click', () => {
  if (!lastState) return;
  const me = lastState.players.find((p) => p.id === myId);
  if (!me || !me.hand || selectedCardIds.size === 0) return;
  const idsInClickOrder = Array.from(selectedCardIds);
  const cards = idsInClickOrder.map((id) => me.hand.find((c) => cardId(c) === id)).filter(Boolean);
  selectedCardIds.clear();
  socket.emit('play_card', { cards });

  // Убираем сыгранные карты из руки СРАЗУ, не дожидаясь ответа сервера - если
  // это был завершающий ход во взятке, сервер намеренно тянет с ответом ради
  // анимации, и без этого карты "зависали" бы в руке ещё пару секунд
  justSubmitted = true;
  const playedIds = new Set(cards.map(cardId));
  me.hand = me.hand.filter((c) => !playedIds.has(cardId(c)));
  renderGame(lastState);
});

// --- обновление состояния ---
function onRoomUpdate(state) {
  lastState = state;
  justSubmitted = false;
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
  trickArea.querySelectorAll('.trick-group').forEach((n) => n.remove());
  const winningIds = new Set((winningCombo || []).map(cardId));
  trickArea.classList.add('has-cards');

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

  // Разлёт карт к тому, кто забрал взятку (с паузой, чтобы успеть разглядеть расклад)
  requestAnimationFrame(() => {
    const cardEls = Array.from(document.querySelectorAll('#trick-area .card'));
    if (cardEls.length === 0) return;
    const originRects = cardEls.map((el) => el.getBoundingClientRect());

    let targetEl = null;
    if (winnerId === myId) {
      targetEl = document.getElementById('my-hand');
    } else {
      targetEl = document.querySelector(`.opponent[data-player-id="${winnerId}"]`);
    }

    setTimeout(() => {
      if (!targetEl) return;
      const targetRect = targetEl.getBoundingClientRect();
      const targetX = targetRect.left + targetRect.width / 2;
      const targetY = targetRect.top + targetRect.height / 2;
      cardEls.forEach((el, i) => {
        const o = originRects[i];
        const dx = targetX - (o.left + o.width / 2);
        const dy = targetY - (o.top + o.height / 2);
        el.classList.add('flying');
        el.style.setProperty('--fly-x', `${dx}px`);
        el.style.setProperty('--fly-y', `${dy}px`);
      });
    }, 1300);
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
  const myTurn = !justSubmitted && state.turnPlayerId === myId && state.phase === 'playing';
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
  const myTurn = !justSubmitted && state.turnPlayerId === myId && state.phase === 'playing';
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
  document.getElementById('deck-count').textContent = `${state.deckCount}`;

  const trumpDiv = document.getElementById('trump-display');
  trumpDiv.innerHTML = '';
  if (state.trumpCard) trumpDiv.appendChild(cardEl(state.trumpCard, { tiny: true }));

  const watermark = document.getElementById('trick-watermark');
  if (watermark && state.trumpSuit) watermark.textContent = state.trumpSuit;

  const opp = document.getElementById('opponents');
  opp.innerHTML = '';
  state.players.filter((p) => p.id !== myId).forEach((p) => {
    const div = document.createElement('div');
    div.className = 'opponent' + (p.id === state.turnPlayerId ? ' active' : '');
    div.dataset.playerId = p.id;
    div.innerHTML = `${avatarHTML(p)}
      <div class="opponent-info">
        <div class="name">${p.name}${!p.isBot && !p.connected ? ' 💤' : ''}</div>
        <div class="meta">Очки: ${p.score} · Побед: ${p.roundsWon}</div>
        <div class="penalty-bar">Вылет: ${p.penalty}/${state.eliminationLimit}</div>
      </div>`;
    opp.appendChild(div);
  });

  const trickArea = document.getElementById('trick-area');
  if (state.phase === 'playing') {
    // очищаем всё, кроме водяного знака, и рисуем заново только если есть карты
    trickArea.querySelectorAll('.trick-group').forEach((n) => n.remove());
    trickArea.classList.toggle('has-cards', state.trick.length > 0);
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

  // карточка "чей ход" с аватаркой
  const turnCard = document.getElementById('turn-card');
  const turnAvatar = document.getElementById('turn-avatar');
  const turnTitle = document.getElementById('turn-title');
  const turnSubtitle = document.getElementById('turn-subtitle');
  if (state.phase === 'resolving') {
    turnCard.classList.add('hidden');
  } else {
    turnCard.classList.remove('hidden');
    const turnPlayer = state.players.find((pl) => pl.id === state.turnPlayerId);
    const amLeaderNow = state.trick.length === 0;
    if (state.turnPlayerId === myId) {
      const me = state.players.find((pl) => pl.id === myId);
      turnAvatar.innerHTML = me ? avatarHTML(me) : `<div class="avatar-circle default-avatar">?</div>`;
      turnTitle.textContent = 'ТВОЙ ХОД';
      turnSubtitle.textContent = amLeaderNow
        ? 'Можно выбрать несколько карт одной масти'
        : `Нужно ответить ровно ${state.requiredCount} карт${state.requiredCount === 1 ? 'ой' : 'ами'}`;
    } else if (turnPlayer) {
      turnAvatar.innerHTML = avatarHTML(turnPlayer);
      turnTitle.textContent = `Ходит: ${turnPlayer.name}`;
      turnSubtitle.textContent = amLeaderNow ? 'Выбирает, с чего зайти' : 'Обдумывает ответ';
    }
  }

  // строка счёта в одну линию: я + остальные
  const board = document.getElementById('scoreboard');
  board.innerHTML = '';
  const myPlayer = state.players.find((p) => p.id === myId);
  if (myPlayer) {
    const meName = document.createElement('div');
    meName.className = 'score-cell score-cell-me';
    meName.textContent = myPlayer.name;
    board.appendChild(meName);
    const meScore = document.createElement('div');
    meScore.className = 'score-cell';
    meScore.textContent = `Очки: ${myPlayer.score}`;
    board.appendChild(meScore);
  }
  state.players.filter((p) => p.id !== myId).forEach((p) => {
    const cell = document.createElement('div');
    cell.className = 'score-cell';
    cell.textContent = `${p.name}: ${p.score}`;
    board.appendChild(cell);
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
  const myTurn = !justSubmitted && state.turnPlayerId === myId && state.phase === 'playing';

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
  const subtitle = document.getElementById('round-end-subtitle');
  const winnerLabel = document.getElementById('round-end-winner-label');
  const winnerName = document.getElementById('round-end-winner-name');
  const scores = document.getElementById('round-end-scores');
  scores.innerHTML = '';

  const isGameOver = state.phase === 'game_over';
  if (isGameOver) {
    title.textContent = 'Игра окончена';
    subtitle.textContent = '';
    winnerLabel.textContent = 'Победитель';
    winnerName.textContent = state.overallWinnerName;
  } else {
    title.textContent = 'Раздача окончена';
    subtitle.textContent = '';
    winnerLabel.textContent = 'Победил';
    winnerName.textContent = state.lastWinnerName;
  }

  const isHost = state.hostId === myId;
  const canRename = isHost && !isGameOver && myName.trim().toLowerCase() === 'lyuhon';

  state.players
    .slice()
    .sort((a, b) => a.penalty - b.penalty)
    .forEach((p, i) => {
      const row = document.createElement('div');
      row.className = 'result-row score-row-enter';
      row.style.animationDelay = `${i * 0.12}s`;

      const left = document.createElement('div');
      left.className = 'result-left';
      left.innerHTML = avatarHTML(p);
      const nameWrap = document.createElement('div');
      const nameLine = document.createElement('div');
      nameLine.className = 'result-name';
      nameLine.textContent = p.name;
      nameWrap.appendChild(nameLine);
      if (canRename && p.id !== myId) {
        const renameBtn = document.createElement('button');
        renameBtn.className = 'rename-btn-inline';
        renameBtn.textContent = '✎';
        renameBtn.addEventListener('click', () => {
          const newN = window.prompt('Новое имя для ' + p.name, p.name);
          if (newN && newN.trim()) socket.emit('rename_player', { playerId: p.id, newName: newN.trim() });
        });
        nameLine.appendChild(renameBtn);
      }
      const sub = document.createElement('div');
      sub.className = 'result-sub';
      sub.textContent = 'раздач выиграно';
      nameWrap.appendChild(sub);
      left.appendChild(nameWrap);
      row.appendChild(left);

      const mid = document.createElement('div');
      mid.className = 'result-mid';
      mid.textContent = String(p.roundsWon);
      row.appendChild(mid);

      const right = document.createElement('div');
      right.className = 'result-right' + (p.penalty >= state.eliminationLimit - 4 ? ' warn' : ' ok');
      const deltaText = p.penaltyDelta > 0 ? `<div class="result-delta">(+${p.penaltyDelta})</div>` : '';
      right.innerHTML = `<div>${p.penalty}/${state.eliminationLimit}</div>${deltaText}`;
      row.appendChild(right);

      scores.appendChild(row);
    });

  if (state.eliminated && state.eliminated.length > 0) {
    const elimTitle = document.createElement('div');
    elimTitle.className = 'eliminated-list';
    elimTitle.textContent = 'Выбыли: ' + state.eliminated.map((p) => p.name).join(', ');
    scores.appendChild(elimTitle);
  }

  document.getElementById('btn-next-round').classList.toggle('hidden', !isHost || isGameOver);
  document.getElementById('wait-host-hint').classList.toggle('hidden', isHost || isGameOver);
  document.getElementById('btn-return-lobby').classList.toggle('hidden', !isHost);
}

tryAutoResume();
