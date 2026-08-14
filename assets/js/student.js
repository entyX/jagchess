import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-auth.js';
import { getFirestore, doc, getDoc, setDoc, updateDoc, addDoc, getDocs, increment, collection, query, orderBy, onSnapshot, where } from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js';

const cfg = window.FIREBASE_CONFIG;
const tabs = Array.from(document.querySelectorAll('.tab'));
const sections = Array.from(document.querySelectorAll('.section'));
const logoutBtn = document.getElementById('logout');
let currentUser = null;
let currentPoints = 0;
let currentStreak = 0;
let attCheckFn = null; // set by initStudentAttendance; called on events cache update
let statPointsEl = null;
let pointsSummaryEl = null;
let puzzleBoardRef = null;
let unsubscribeAttempts = null;
let currentUsername = '';
let currentAvatarColor = '#a67c00';

const AVATAR_COLORS = [
  '#a67c00', '#325a9a', '#207a4f', '#8e5634',
  '#5d46a6', '#a13440', '#2a8fb0', '#555f6a'
];

const getInitials = (name) => {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  return parts.length > 1
    ? (parts[0][0] + parts[1][0]).toUpperCase()
    : name.substring(0, 2).toUpperCase();
};

const renderAvatar = (el, color, name) => {
  if (!el) return;
  el.style.background = color || '#a67c00';
  el.textContent = getInitials(name);
};

const activate = (id) => {
  tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === id));
  sections.forEach(s => s.classList.toggle('active', s.id === id));
  setTimeout(() => {
    if (id === 'events' && typeof renderCalendar === 'function') renderCalendar();
    if (id === 'puzzles' && puzzleBoardRef?.resize) puzzleBoardRef.resize();
  }, 0);
};
tabs.forEach(t => t.addEventListener('click', () => activate(t.dataset.tab)));

const CHESS_TIPS = [
  'Control the center — pieces and pawns in the center dominate the board.',
  'Develop your pieces quickly. Move each piece once before moving any twice.',
  'Castle early to protect your king and connect your rooks.',
  'A knight on the rim is dim. Centralize your knights for maximum power.',
  'When ahead in material, trade pieces freely to simplify the position.',
  'Always ask: what is my opponent threatening? Look before you leap.',
  'Rooks belong on open files. Activate them by connecting and doubling.'
];
const tipEl = document.getElementById('dash-tip');
if (tipEl) tipEl.textContent = CHESS_TIPS[new Date().getDay()];

if (!cfg) {
  window.location.href = '/login';
} else {
  const app = initializeApp(cfg);
  const auth = getAuth(app);
  const db = getFirestore(app);

  const subscribePuzzleAttempts = (userId) => {
    if (unsubscribeAttempts) unsubscribeAttempts();
    if (!userId) return;
    const qAttempts = query(collection(db, 'puzzleAttempts'), where('userId', '==', userId));
    unsubscribeAttempts = onSnapshot(qAttempts, (snap) => {
      const map = new Map();
      snap.forEach(docu => map.set(docu.data().puzzleId, docu.data()));
      puzzleAttempts = map;
      renderPuzzleHistory();
    }, handleSnapshotError);
  };

  const showUsernameModal = () => {
    const m = document.getElementById('username-modal');
    if (m) m.hidden = false;
  };

  // ── STREAK HELPERS ────────────────────────────────────────────────────────
  const getWeekKey = (ts = Date.now()) => {
    const d = new Date(ts);
    const dow = d.getUTCDay() || 7;
    const mon = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - (dow - 1)));
    return mon.toISOString().slice(0, 10);
  };

  const prevWeekKey = (wk) => {
    const d = new Date(wk + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - 7);
    return d.toISOString().slice(0, 10);
  };

  const getStreakMultiplier = (streak) => {
    if (!streak || streak <= 1) return 1.0;
    return Math.min(1.0 + (streak - 1) * 0.2, 3.0);
  };

  const initStreakFromAttendance = async (userId) => {
    const snap = await getDocs(query(collection(db, 'attendanceResponses'), where('userId', '==', userId)));
    const weekSet = new Set();
    snap.forEach(d => { const ts = d.data().submittedAt; if (ts) weekSet.add(getWeekKey(ts)); });
    const thisWeek = getWeekKey();
    let streak = 0;
    let wk = weekSet.has(thisWeek) ? thisWeek : prevWeekKey(thisWeek);
    while (weekSet.has(wk)) { streak++; wk = prevWeekKey(wk); }
    const sorted = Array.from(weekSet).sort();
    let longest = 0, run = 0, prev = null;
    for (const w of sorted) {
      const expected = prev ? (() => { const d = new Date(prev + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 7); return d.toISOString().slice(0, 10); })() : null;
      run = expected === w ? run + 1 : 1;
      if (run > longest) longest = run;
      prev = w;
    }
    const longestStreak = Math.max(longest, streak);
    const completedWeeks = sorted.slice(-12);
    const lastWeek = sorted.length ? sorted[sorted.length - 1] : null;
    await setDoc(doc(db, 'users', userId), { currentStreak: streak, longestStreak, completedWeeks, lastAttendanceWeek: lastWeek }, { merge: true });
    return { currentStreak: streak, longestStreak, completedWeeks };
  };

  const renderStreakWidget = (streak, longest) => {
    const tile = document.getElementById('stu-streak-tile');
    if (!tile) return;
    const mult = getStreakMultiplier(streak);
    const active = streak > 0;
    tile.innerHTML = `
      <div class="stu-stk-fire${active ? ' active' : ''}">🔥</div>
      <div class="stu-stk-num">${streak}</div>
      <div class="stu-stk-label">week streak</div>
      <div class="stu-stk-mult${active ? ' active' : ''}">×${mult.toFixed(1)}</div>`;
    tile.title = `${streak}-week streak · ×${mult.toFixed(1)} point multiplier · Best: ${longest}`;
  };

  onAuthStateChanged(auth, async (user) => {
    if (!user) return window.location.href = '/login';
    currentUser = user;
    subscribePuzzleAttempts(user.uid);
    const ref = doc(db, 'users', user.uid);
    const snap = await getDoc(ref);
    const data = snap.exists() ? snap.data() : {};
    if (data.banned || data.deleted) {
      await signOut(auth);
      return window.location.href = '/login';
    }
    const role = data.role || 'student';
    if (role !== 'student') return window.location.href = '/admin/dashboard.html';
    const pts = data.points || 0;
    const username = data.username || '';
    const avatarColor = data.avatarColor || '#a67c00';
    currentPoints = pts;
    currentUsername = username;
    currentAvatarColor = avatarColor;
    initStreakFromAttendance(user.uid).then(sd => {
      currentStreak = sd.currentStreak;
      renderStreakWidget(sd.currentStreak, sd.longestStreak);
    });
    currentStreak = data.currentStreak || 0;

    if (!data.email && user.email) {
      setDoc(ref, { email: user.email }, { merge: true }).catch(() => {});
    }

    const statPoints = document.getElementById('stat-points');
    const statUsername = document.getElementById('stat-username');
    const statEmailEl = document.getElementById('stat-email');
    const pointsBalanceEl = document.getElementById('points-balance-text');
    statPointsEl = statPoints;
    pointsSummaryEl = pointsBalanceEl;
    if (statPoints) statPoints.textContent = pts;
    updateStatRank();
    const displayName = username || user.email.split('@')[0];
    if (statUsername) statUsername.textContent = displayName;
    const greetEl = document.getElementById('greet-name');
    if (greetEl) greetEl.textContent = displayName;
    if (statEmailEl) statEmailEl.textContent = user.email;
    if (pointsBalanceEl) pointsBalanceEl.textContent = `You have ${pts} points`;

    renderAvatar(document.getElementById('stu-avatar-sm'), avatarColor, username || user.email);
    initProfileTab(username, avatarColor, pts);
    if (!username) showUsernameModal();
    initStudentShop(user.uid);
    initStudentAttendance(user.uid);
  });

  const TAGS = [
    { value: 'classic', label: 'Classic' },
    { value: 'tournament', label: 'Tournament' },
    { value: 'practice', label: 'Practice' },
    { value: 'meeting', label: 'Meeting' },
    { value: 'lesson', label: 'Lesson' },
    { value: 'match', label: 'Match' }
  ];

  const calendarGrid = document.getElementById('calendar-grid');
  const calTitle = document.getElementById('cal-title');
  const calPrev = document.getElementById('cal-prev');
  const calNext = document.getElementById('cal-next');
  const eventsUpcoming = document.getElementById('events-upcoming');
  const eventsEmpty = document.getElementById('events-empty');
  const eventsRange = document.getElementById('events-range');
  const modal = document.getElementById('event-modal');
  const modalClose = document.getElementById('modal-close');
  const modalTitle = document.getElementById('modal-title');
  const modalDate = document.getElementById('modal-date');
  const modalDesc = document.getElementById('modal-desc');
  const modalTag = document.getElementById('modal-tag');

  let eventsCache = [];
  let eventsById = new Map();
  let activeMonth = new Date();
  activeMonth.setDate(1);
  activeMonth.setHours(0, 0, 0, 0);
  let modalEventId = null;

  const tagLabel = (tag) => (TAGS.find(t => t.value === tag)?.label) || 'Classic';
  const tagClass = (tag) => `tag-${tag || 'classic'}`;
  const toDateKey = (ts) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const hasTime = (event) => {
    if (event?.time) return true;
    const d = new Date(event?.date || 0);
    return d.getHours() !== 0 || d.getMinutes() !== 0;
  };
  const formatEventDate = (event) => {
    const d = new Date(event.date);
    const opts = hasTime(event) ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' };
    return d.toLocaleString(undefined, opts);
  };

  const renderCalendar = () => {
    const year = activeMonth.getFullYear();
    const month = activeMonth.getMonth();
    calTitle.textContent = activeMonth.toLocaleString(undefined, { month: 'long', year: 'numeric' });
    const firstDay = new Date(year, month, 1);
    const gridStart = new Date(firstDay);
    gridStart.setDate(firstDay.getDate() - firstDay.getDay());
    const eventsByDate = new Map();
    eventsCache.forEach((event) => {
      const key = toDateKey(event.date);
      if (!eventsByDate.has(key)) eventsByDate.set(key, []);
      eventsByDate.get(key).push(event);
    });
    const cells = [];
    for (let i = 0; i < 42; i += 1) {
      const day = new Date(gridStart);
      day.setDate(gridStart.getDate() + i);
      const dayKey = toDateKey(day.getTime());
      const dayEvents = eventsByDate.get(dayKey) || [];
      const pills = dayEvents.slice(0, 3).map((event) => (
        `<button class="event-pill ${tagClass(event.tag)}" data-id="${event.id}" title="${event.title || 'Event'}">${event.title || 'Event'}</button>`
      )).join('');
      const extraCount = dayEvents.length > 3 ? `<div class="muted">+${dayEvents.length - 3} more</div>` : '';
      const outside = day.getMonth() !== month ? 'is-outside' : '';
      cells.push(`
        <div class="day-cell ${outside}">
          <div class="day-num">${day.getDate()}</div>
          <div class="day-events">${pills}${extraCount}</div>
        </div>
      `);
    }
    calendarGrid.innerHTML = cells.join('');
  };

  const renderUpcoming = () => {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const upcoming = eventsCache.filter(ev => ev.date >= now.getTime());
    eventsRange.textContent = `From ${now.toLocaleDateString()}`;
    eventsEmpty.hidden = upcoming.length > 0;
    eventsUpcoming.innerHTML = upcoming.map((event) => `
      <div class="list-item" data-id="${event.id}">
        <strong>${event.title || 'Event'}</strong>
        <span>${formatEventDate(event)}</span>
        <span>${event.desc || ''}</span>
        <span class="tag-badge ${tagClass(event.tag)}">${tagLabel(event.tag)}</span>
      </div>
    `).join('');
    const upcomingEl = document.getElementById('stat-upcoming');
    if (upcomingEl) upcomingEl.textContent = upcoming.length;
  };

  const renderDashEvents = () => {
    const el = document.getElementById('dash-events-preview');
    const emptyEl = document.getElementById('dash-events-empty');
    if (!el) return;
    const now = new Date(); now.setHours(0, 0, 0, 0);
    const upcoming = eventsCache.filter(ev => ev.date >= now.getTime()).slice(0, 4);
    if (emptyEl) emptyEl.hidden = upcoming.length > 0;
    el.innerHTML = upcoming.map(ev => {
      const d = new Date(ev.date);
      return `
        <div class="dash-ev-row" data-id="${ev.id}" style="cursor:pointer">
          <div class="dash-ev-date">
            <div class="dash-ev-day">${d.getDate()}</div>
            <div class="dash-ev-mon">${d.toLocaleString(undefined, { month: 'short' })}</div>
          </div>
          <div class="dash-ev-info">
            <div class="dash-ev-title">${ev.title || 'Event'}</div>
            <div class="dash-ev-sub">
              <span class="dash-ev-time">${hasTime(ev) ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : 'All day'}</span>
              <span class="tag-badge ${tagClass(ev.tag)}">${tagLabel(ev.tag)}</span>
            </div>
          </div>
        </div>`;
    }).join('');
    el.querySelectorAll('[data-id]').forEach(row => {
      row.addEventListener('click', () => openModal(eventsById.get(row.dataset.id)));
    });
  };

  const openModal = (event) => {
    if (!event) return;
    modalEventId = event.id;
    modalTitle.textContent = event.title || 'Event';
    modalDate.textContent = formatEventDate(event);
    modalDesc.textContent = event.desc || 'No description yet.';
    modalTag.innerHTML = `<span class="tag-badge ${tagClass(event.tag)}">${tagLabel(event.tag)}</span>`;
    modal.hidden = false;
  };

  const closeModal = () => {
    modal.hidden = true;
    modalEventId = null;
  };

  calPrev.addEventListener('click', () => {
    activeMonth.setMonth(activeMonth.getMonth() - 1);
    renderCalendar();
  });
  calNext.addEventListener('click', () => {
    activeMonth.setMonth(activeMonth.getMonth() + 1);
    renderCalendar();
  });

  calendarGrid.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const id = btn.dataset.id;
    openModal(eventsById.get(id));
  });
  eventsUpcoming.addEventListener('click', (e) => {
    const itemEl = e.target.closest('.list-item');
    if (!itemEl) return;
    const id = itemEl.dataset.id;
    openModal(eventsById.get(id));
  });

  modalClose.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });

  const reportPuzzleStatus = (msg, type = 'info') => {
    const el = document.getElementById('student-puzzle-status');
    if (el) {
      el.textContent = msg;
      el.dataset.status = type;
    }
  };
  const handleSnapshotError = (err) => {
    console.error('Firestore snapshot error:', err);
    if (err?.code === 'permission-denied') {
      reportPuzzleStatus('Permission denied. Check Firestore rules.');
    }
  };
  const qEvents = query(collection(db, 'events'), orderBy('date', 'asc'));
  onSnapshot(qEvents, (snap) => {
    const items = [];
    snap.forEach(docu => {
      const d = docu.data();
      items.push({ id: docu.id, ...d });
    });
    eventsCache = items;
    eventsById = new Map(items.map(ev => [ev.id, ev]));
    renderCalendar();
    renderUpcoming();
    renderDashEvents();
    if (attCheckFn) attCheckFn();
  }, handleSnapshotError);

  const studentBoardEl = document.getElementById('student-board');
  const puzzleStatus = document.getElementById('student-puzzle-status');
  const puzzleReset = document.getElementById('puzzle-reset-student');
  const puzzleProgressList = document.getElementById('puzzle-progress-list');
  const puzzleHistoryList = document.getElementById('puzzle-history-list');
  const puzzleHistoryEmpty = document.getElementById('puzzle-history-empty');
  const puzzleHistoryMeta = document.getElementById('puzzle-history-meta');
  const puzzleCompleteModal = document.getElementById('puzzle-complete-modal');
  const puzzleCompletePoints = document.getElementById('puzzle-complete-points');
  const puzzleCompleteClose = document.getElementById('puzzle-complete-close');
  const puzzleCompleteOk = document.getElementById('puzzle-complete-ok');

  let puzzleBoard = null;
  let puzzleGame = null;
  let puzzlesCache = [];
  let puzzlesById = new Map();
  let puzzleAttempts = new Map();
  let currentPuzzle = null;
  let currentPuzzleId = null;
  let currentIndex = 0;
  let moveAttempts = 0;
  let isLocked = true;
  let isLatePuzzle = false;

  const setPuzzleStatus = (msg, type = 'info') => {
    if (puzzleStatus) {
      puzzleStatus.textContent = msg;
      puzzleStatus.dataset.status = type;
    }
  };

  const renderProgress = () => {
    if (!puzzleProgressList) return;
    if (!currentPuzzle) {
      puzzleProgressList.innerHTML = '<div class="empty-state">No puzzle selected.</div>';
      return;
    }
    const maxMoves = Number(currentPuzzle.maxMoves || currentPuzzle.solution?.length || 0);
    puzzleProgressList.innerHTML = `
      <div class="list-item">Progress: ${currentIndex} / ${currentPuzzle.solution?.length || 0} moves</div>
      <div class="list-item">Moves used: ${moveAttempts} / ${maxMoves}</div>
    `;
  };
  const showPuzzleCompleteModal = (awarded) => {
    if (!puzzleCompleteModal || !puzzleCompletePoints) return;
    puzzleCompleteModal.hidden = false;
    let current = 0;
    const target = Math.max(0, Number(awarded || 0));
    puzzleCompletePoints.textContent = '0';
    const step = Math.max(1, Math.ceil(target / 40));
    const tick = () => {
      current = Math.min(target, current + step);
      puzzleCompletePoints.textContent = String(current);
      if (current >= target) clearInterval(timer);
    };
    const timer = setInterval(tick, 60);
    tick();
  };
  const closePuzzleCompleteModal = () => {
    if (puzzleCompleteModal) puzzleCompleteModal.hidden = true;
  };

  const pieceImgBase = new URL('../vendor/chessboard/img/chesspieces/wikipedia/', import.meta.url).href;
  const normalizeFen = (fen, color) => {
    if (!fen) return `start ${color} - - 0 1`;
    if (fen.split(' ').length >= 2) return fen;
    return `${fen} ${color} - - 0 1`;
  };
  const buildStudentBoard = (fen, orientation) => {
    if (!studentBoardEl || !window.Chessboard) return;
    if (puzzleBoard && puzzleBoard.destroy) puzzleBoard.destroy();
    puzzleBoard = window.Chessboard(studentBoardEl, {
      draggable: true,
      position: fen || 'start',
      orientation: orientation || 'white',
      pieceTheme: (piece) => `${pieceImgBase}${piece}.png`,
      onDrop: (source, target) => {
        if (!puzzleGame || !currentPuzzle || isLocked) return 'snapback';
        const maxMoves = Number(currentPuzzle.maxMoves || currentPuzzle.solution?.length || 0);
        const playerColor = currentPuzzle.playerColor || 'w';
        const piece = puzzleGame.get?.(source);
        if (piece && piece.color !== playerColor) {
          setPuzzleStatus(`You are playing ${playerColor === 'w' ? 'White' : 'Black'}.`);
          return 'snapback';
        }
        if (puzzleGame.turn && puzzleGame.turn() !== playerColor) {
          const tokens = puzzleGame.fen().split(' ');
          tokens[1] = playerColor;
          puzzleGame = new window.Chess(tokens.join(' '));
        }
        const move = puzzleGame.move({ from: source, to: target, promotion: 'q' });
        if (!move) return 'snapback';
        moveAttempts += 1;
        const expected = currentPuzzle.solution?.[currentIndex];
        if (move.san !== expected) {
          puzzleGame.undo();
          moveAttempts -= 1;
          if (moveAttempts >= maxMoves) isLocked = true;
          setPuzzleStatus('Incorrect move.', 'error');
          renderProgress();
          return 'snapback';
        }
        currentIndex += 1;
        if (currentIndex < currentPuzzle.solution.length) {
          const opponentMove = currentPuzzle.solution[currentIndex];
          const reply = puzzleGame.move(opponentMove, { sloppy: true });
          if (reply) currentIndex += 1;
        }
        if (currentIndex >= currentPuzzle.solution.length && moveAttempts <= maxMoves) {
          isLocked = true;
          setPuzzleStatus('Correct move.', 'success');
          renderProgress();
          awardPuzzlePoints()
            .then((awarded) => showPuzzleCompleteModal(awarded))
            .catch(() => showPuzzleCompleteModal(0));
          return undefined;
        }
        if (moveAttempts >= maxMoves) isLocked = true;
        setPuzzleStatus('Correct move.', 'success');
        renderProgress();
        return undefined;
      },
      onSnapEnd: () => {
        if (puzzleGame && puzzleBoard) puzzleBoard.position(puzzleGame.fen());
      }
    });
    puzzleBoardRef = puzzleBoard;
  };

  const selectPuzzle = (puzzle, latePenalty) => {
    currentPuzzle = puzzle;
    currentPuzzleId = puzzle?.id || null;
    isLatePuzzle = latePenalty;
    currentIndex = 0;
    moveAttempts = 0;
    isLocked = false;
    if (!currentPuzzle) {
      setPuzzleStatus('Select a puzzle to start.', 'info');
      renderProgress();
      return;
    }
    const playerColor = currentPuzzle.playerColor || 'w';
    const fen = normalizeFen(currentPuzzle.fen, playerColor);
    puzzleGame = new window.Chess(fen);
    buildStudentBoard(fen, playerColor === 'b' ? 'black' : 'white');
    const label = latePenalty ? 'Late puzzle (25% points).' : 'Current puzzle.';
    setPuzzleStatus(`Playing as ${playerColor === 'b' ? 'Black' : 'White'}. ${label}`, 'info');
    renderProgress();
  };

  const awardPuzzlePoints = async () => {
    if (!currentUser || !currentPuzzle) return 0;
    try {
      const existing = puzzleAttempts.get(currentPuzzle.id);
      if (existing?.completedAt) {
        setPuzzleStatus('Correct move.', 'success');
        return 0;
      }
      const attemptId = `${currentUser.uid}_${currentPuzzle.id}`;
      const attemptRef = doc(db, 'puzzleAttempts', attemptId);
      const basePoints = Number(currentPuzzle.points || 0);
      const rawAwarded = isLatePuzzle ? Math.max(1, Math.round(basePoints * 0.25)) : basePoints;
      const awarded = rawAwarded > 0 ? Math.round(rawAwarded * getStreakMultiplier(currentStreak)) : 0;
      // Optimistically mark complete to prevent double awards.
      puzzleAttempts.set(currentPuzzle.id, { completedAt: Date.now(), scoreAwarded: awarded });
      renderPuzzleHistory();
      if (awarded > 0) {
        await setDoc(doc(db, 'users', currentUser.uid), { points: increment(awarded) }, { merge: true });
        currentPoints += awarded;
        if (statPointsEl) statPointsEl.textContent = currentPoints;
        if (pointsSummaryEl) pointsSummaryEl.textContent = `You have ${currentPoints} points`;
        const profilePtsEl = document.getElementById('profile-pts-num');
        if (profilePtsEl) profilePtsEl.textContent = currentPoints;
      }
      await setDoc(attemptRef, {
        puzzleId: currentPuzzle.id,
        userId: currentUser.uid,
        completedAt: Date.now(),
        movesUsed: moveAttempts,
        scoreAwarded: awarded,
        latePenalty: isLatePuzzle
      }, { merge: true });
      puzzleAttempts.set(currentPuzzle.id, { completedAt: Date.now(), scoreAwarded: awarded });
      renderPuzzleHistory();
      return awarded;
    } catch (err) {
      console.error('Award puzzle points failed:', err);
      return 0;
    }
  };

  const renderPuzzleHistory = () => {
    if (!puzzleHistoryList) return;
    if (puzzleHistoryMeta) puzzleHistoryMeta.textContent = `${puzzlesCache.length} puzzles`;
    if (puzzleHistoryEmpty) puzzleHistoryEmpty.hidden = puzzlesCache.length > 0;
    puzzleHistoryList.innerHTML = puzzlesCache.map((puzzle, idx) => {
      const isCurrent = idx === 0;
      const points = Number(puzzle.points || 0);
      const displayPoints = isCurrent ? points : Math.max(1, Math.round(points * 0.25));
      const badge = isCurrent ? 'Current' : 'Late (25%)';
      const completed = puzzleAttempts.has(puzzle.id);
      const statusBadge = completed ? 'Completed' : 'Not completed';
      return `
        <div class="list-item puzzle-list-item" data-id="${puzzle.id}">
          <strong>${puzzle.title || `Puzzle #${puzzlesCache.length - idx}`}</strong>
          <span class="puzzle-badge">${(puzzle.solution || []).length} moves • ${displayPoints} pts</span>
          <span class="puzzle-badge">${badge}</span>
          <span class="puzzle-badge">${statusBadge}</span>
        </div>
      `;
    }).join('');
  };

  if (studentBoardEl) {
    const ensureChessLibs = async () => {
      const loadCss = (href) => {
        if (document.querySelector(`link[href="${href}"]`)) return;
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        document.head.appendChild(link);
      };
      const loadScript = (src) => new Promise((resolve, reject) => {
        if (document.querySelector(`script[src="${src}"]`)) return resolve();
        const script = document.createElement('script');
        script.src = src;
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
      });
      const base = new URL('../vendor/', import.meta.url);
      loadCss(new URL('jquery-ui/jquery-ui.min.css', base).href);
      loadCss(new URL('chessboard/chessboard-1.0.0.min.css', base).href);
      if (!window.jQuery) await loadScript(new URL('jquery/jquery.min.js', base).href);
      if (!window.jQuery?.ui) await loadScript(new URL('jquery-ui/jquery-ui.min.js', base).href);
      if (!window.Chess) await loadScript(new URL('chess/chess.min.js', base).href);
      if (!window.Chessboard) await loadScript(new URL('chessboard/chessboard-1.0.0.min.js', base).href);
    };

    ensureChessLibs().then(() => {
      if (!window.Chess || !window.Chessboard) {
        setPuzzleStatus('Chess libraries failed to load.');
        return;
      }
      buildStudentBoard('start');

      if (puzzleReset) puzzleReset.addEventListener('click', () => {
        if (!currentPuzzle) return;
        selectPuzzle(currentPuzzle, isLatePuzzle);
      });

      if (puzzleCompleteClose) puzzleCompleteClose.addEventListener('click', closePuzzleCompleteModal);
      if (puzzleCompleteOk) puzzleCompleteOk.addEventListener('click', closePuzzleCompleteModal);

      puzzleHistoryList.addEventListener('click', (e) => {
        const itemEl = e.target.closest('.puzzle-list-item');
        if (!itemEl) return;
        const puzzle = puzzlesById.get(itemEl.dataset.id);
        if (!puzzle) return;
        const latePenalty = puzzlesCache[0]?.id !== puzzle.id;
        selectPuzzle(puzzle, latePenalty);
      });

      const qPuzzles = query(collection(db, 'puzzles'), orderBy('createdAt', 'desc'));
      onSnapshot(qPuzzles, (snap) => {
        const items = [];
        snap.forEach(docu => items.push({ id: docu.id, ...docu.data() }));
        puzzlesCache = items;
        puzzlesById = new Map(items.map(p => [p.id, p]));
        renderPuzzleHistory();
        if (items.length && (!currentPuzzleId || !puzzlesById.has(currentPuzzleId))) {
          selectPuzzle(items[0], false);
        }
        if (!items.length) {
          currentPuzzle = null;
          currentPuzzleId = null;
          setPuzzleStatus('No puzzles posted yet.');
          renderProgress();
        }
      }, handleSnapshotError);
    }).catch(() => setPuzzleStatus('Chess libraries failed to load.'));
  }

  const renderDashNews = (items) => {
    const el = document.getElementById('dash-news-preview');
    const emptyEl = document.getElementById('dash-news-empty');
    if (!el) return;
    const top = items.slice(0, 3);
    if (emptyEl) emptyEl.hidden = top.length > 0;
    el.innerHTML = top.map(it => {
      const date = it.createdAt ? new Date(it.createdAt).toLocaleDateString() : '';
      return `
        <div class="dash-news-row">
          <div class="dash-news-title">${it.title || 'Announcement'}</div>
          <div class="dash-news-date">${date}</div>
        </div>`;
    }).join('');
  };

  const newsList = document.getElementById('news-list');
  const qNews = query(collection(db, 'announcements'), orderBy('createdAt', 'desc'));
  onSnapshot(qNews, (snap) => {
    const items = [];
    snap.forEach(docu => items.push({ id: docu.id, ...docu.data() }));
    const escHtml = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    newsList.innerHTML = items.map(it => {
      const date = it.createdAt
        ? new Date(it.createdAt).toLocaleDateString(undefined, { month:'short', day:'numeric', year:'numeric' }) : '';
      return `<div class="news-card">
        <div class="news-card-header">
          <span class="news-card-date">${date}</span>
        </div>
        <div class="news-card-title">${escHtml(it.title || 'Announcement')}</div>
        <div class="news-card-body">${it.body || ''}</div>
      </div>`;
    }).join('');
    renderDashNews(items);
  }, handleSnapshotError);

  let leadersCache = [];

  const updateStatRank = () => {
    const rankEl = document.getElementById('stat-rank');
    if (!rankEl || !currentUser || !leadersCache.length) return;
    const idx = leadersCache.findIndex(it => it.id === currentUser.uid);
    rankEl.textContent = idx >= 0 ? `#${idx + 1}` : '—';
  };

  const renderDashLeaders = (items) => {
    const el = document.getElementById('dash-leaders-preview');
    const emptyEl = document.getElementById('dash-leaders-empty');
    if (!el) return;
    if (emptyEl) emptyEl.hidden = items.length > 0;
    el.innerHTML = items.slice(0, 5).map((it, i) => {
      const name = it.username || 'Student';
      return `
        <div class="dash-leader-row">
          <div class="dash-leader-rank${i < 3 ? ' top' : ''}">${i + 1}</div>
          <div class="dash-leader-name">${name}</div>
          <div class="dash-leader-pts">${it.points || 0} pts</div>
        </div>`;
    }).join('');
  };

  const renderLeaderboardTab = (items) => {
    const listEl = document.getElementById('lb-list');
    const emptyEl = document.getElementById('lb-empty');
    const subEl = document.getElementById('lb-sub');
    if (!listEl) return;
    if (emptyEl) emptyEl.hidden = items.length > 0;
    if (subEl && items.length) subEl.textContent = `${items.length} member${items.length !== 1 ? 's' : ''} ranked`;
    listEl.innerHTML = items.map((it, i) => {
      const isMe = currentUser && it.id === currentUser.uid;
      const rankClass = i === 0 ? 'lb-rank-gold' : i === 1 ? 'lb-rank-silver' : i === 2 ? 'lb-rank-bronze' : '';
      const name = it.username || 'Student';
      const color = it.avatarColor || '#a67c00';
      return `
        <div class="lb-row${isMe ? ' lb-row-me' : ''}">
          <span class="lb-col-rank ${rankClass}">${i + 1}</span>
          <span class="lb-col-player">
            <div class="lb-avatar" style="background:${color}">${getInitials(name)}</div>
            <div class="lb-player-info">
              <div class="lb-player-name">${name}${isMe ? ' <span class="lb-me-badge">You</span>' : ''}</div>
              <div class="lb-player-email">${it.email || ''}</div>
            </div>
          </span>
          <span class="lb-col-pts">${it.points || 0}</span>
        </div>`;
    }).join('');
  };

  const qLeaders = query(collection(db, 'users'), orderBy('points', 'desc'));
  onSnapshot(qLeaders, (snap) => {
    const items = [];
    snap.forEach(docu => items.push({ id: docu.id, ...docu.data() }));
    leadersCache = items;
    updateStatRank();
    renderDashLeaders(items);
    renderLeaderboardTab(items);
  }, handleSnapshotError);

  const initProfileTab = (username, avatarColor, pts) => {
    const avatarLg = document.getElementById('profile-avatar-lg');
    const usernameDisplay = document.getElementById('profile-username-display');
    const ptsNum = document.getElementById('profile-pts-num');
    const usernameInput = document.getElementById('profile-username-input');
    const palette = document.getElementById('avatar-palette');
    const saveBtn = document.getElementById('profile-save');

    if (usernameDisplay) usernameDisplay.textContent = username || '—';
    if (ptsNum) ptsNum.textContent = pts;
    if (usernameInput) usernameInput.value = username;
    renderAvatar(avatarLg, avatarColor, username);

    if (palette && !palette.dataset.initialized) {
      palette.dataset.initialized = '1';
      AVATAR_COLORS.forEach(color => {
        const swatch = document.createElement('button');
        swatch.className = 'avatar-swatch' + (color === currentAvatarColor ? ' selected' : '');
        swatch.style.background = color;
        swatch.dataset.color = color;
        swatch.title = color;
        swatch.addEventListener('click', () => {
          currentAvatarColor = color;
          palette.querySelectorAll('.avatar-swatch').forEach(s => s.classList.toggle('selected', s.dataset.color === color));
          renderAvatar(document.getElementById('profile-avatar-lg'), color, usernameInput?.value.trim() || currentUsername);
          renderAvatar(document.getElementById('stu-avatar-sm'), color, usernameInput?.value.trim() || currentUsername);
        });
        palette.appendChild(swatch);
      });
    } else if (palette) {
      palette.querySelectorAll('.avatar-swatch').forEach(s => s.classList.toggle('selected', s.dataset.color === avatarColor));
    }

    if (saveBtn && !saveBtn.dataset.bound) {
      saveBtn.dataset.bound = '1';
      saveBtn.addEventListener('click', async () => {
        if (!currentUser) return;
        const newUsername = usernameInput?.value.trim() || '';
        if (!newUsername) { saveBtn.textContent = 'Enter a username'; setTimeout(() => { saveBtn.textContent = 'Save Changes'; }, 1500); return; }
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';
        try {
          await updateDoc(doc(db, 'users', currentUser.uid), { username: newUsername, avatarColor: currentAvatarColor });
          currentUsername = newUsername;
          if (usernameDisplay) usernameDisplay.textContent = newUsername;
          renderAvatar(document.getElementById('profile-avatar-lg'), currentAvatarColor, newUsername);
          renderAvatar(document.getElementById('stu-avatar-sm'), currentAvatarColor, newUsername);
          const statUsernameEl = document.getElementById('stat-username');
          if (statUsernameEl) statUsernameEl.textContent = newUsername;
          const greetEl = document.getElementById('greet-name');
          if (greetEl) greetEl.textContent = newUsername;
          saveBtn.textContent = 'Saved!';
          setTimeout(() => { saveBtn.textContent = 'Save Changes'; }, 1500);
        } catch (err) {
          console.error('Profile save failed:', err);
          saveBtn.textContent = 'Error saving';
          setTimeout(() => { saveBtn.textContent = 'Save Changes'; }, 1500);
        }
        saveBtn.disabled = false;
      });
    }
  };

  const usernameModal = document.getElementById('username-modal');
  const usernameModalClose = document.getElementById('username-modal-close');
  const usernameModalSkip = document.getElementById('username-modal-skip');
  const usernameModalSave = document.getElementById('username-modal-save');
  const usernameModalInput = document.getElementById('username-modal-input');

  const closeUsernameModal = () => { if (usernameModal) usernameModal.hidden = true; };

  if (usernameModalClose) usernameModalClose.addEventListener('click', closeUsernameModal);
  if (usernameModalSkip) usernameModalSkip.addEventListener('click', closeUsernameModal);
  if (usernameModal) usernameModal.addEventListener('click', e => {
    if (e.target === usernameModal) closeUsernameModal();
  });

  if (usernameModalSave) usernameModalSave.addEventListener('click', async () => {
    if (!currentUser) return;
    const newUsername = usernameModalInput?.value.trim();
    if (!newUsername) {
      if (usernameModalInput) { usernameModalInput.style.borderColor = '#b00020'; setTimeout(() => { usernameModalInput.style.borderColor = ''; }, 1500); }
      return;
    }
    usernameModalSave.disabled = true;
    usernameModalSave.textContent = 'Saving…';
    try {
      await updateDoc(doc(db, 'users', currentUser.uid), { username: newUsername });
      currentUsername = newUsername;
      const statUsernameEl = document.getElementById('stat-username');
      if (statUsernameEl) statUsernameEl.textContent = newUsername;
      const greetEl = document.getElementById('greet-name');
      if (greetEl) greetEl.textContent = newUsername;
      const usernameDisplay = document.getElementById('profile-username-display');
      if (usernameDisplay) usernameDisplay.textContent = newUsername;
      const usernameInput = document.getElementById('profile-username-input');
      if (usernameInput) usernameInput.value = newUsername;
      renderAvatar(document.getElementById('stu-avatar-sm'), currentAvatarColor, newUsername);
      renderAvatar(document.getElementById('profile-avatar-lg'), currentAvatarColor, newUsername);
      closeUsernameModal();
    } catch (err) {
      console.error('Username save failed:', err);
    }
    usernameModalSave.disabled = false;
    usernameModalSave.textContent = 'Set Username';
  });

  // ── STUDENT SHOP ─────────────────────────────────────────────────────────
  let shopItemsCache = [];
  let shopInitialized = false;

  const initStudentShop = (userId) => {
    if (shopInitialized) return;
    shopInitialized = true;
    const pendingQtys = {}; // qty selected before adding to cart, per itemId

    const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

    const getCart = () => {
      try { return JSON.parse(localStorage.getItem(`jagchess_cart_${userId}`) || '[]'); }
      catch { return []; }
    };
    const saveCart = (items) => localStorage.setItem(`jagchess_cart_${userId}`, JSON.stringify(items));

    const updateCartBadge = () => {
      const badge = document.getElementById('cart-badge');
      const total = getCart().reduce((s, i) => s + (i.qty || 1), 0);
      if (badge) { badge.textContent = total; badge.hidden = total === 0; }
    };

    const renderShopGrid = () => {
      const grid = document.getElementById('shop-grid');
      const emptyEl = document.getElementById('shop-empty');
      const ptsDisplay = document.getElementById('shop-pts-display');
      if (!grid) return;
      if (ptsDisplay) ptsDisplay.textContent = `${currentPoints} pts available`;
      if (!shopItemsCache.length) {
        grid.innerHTML = ''; if (emptyEl) emptyEl.hidden = false; return;
      }
      if (emptyEl) emptyEl.hidden = true;
      const cart = getCart();
      grid.innerHTML = shopItemsCache.map(item => {
        const cartEntry = cart.find(c => c.id === item.id);
        const outOfStock = item.stock != null && item.stock <= 0;
        const maxQty = item.stock ?? 99;
        const pendingQty = pendingQtys[item.id] || 1;
        const displayQty = cartEntry ? cartEntry.qty : pendingQty;
        const canAfford = currentPoints >= item.pointCost * displayQty;
        const stockText = item.stock != null ? (outOfStock ? 'Out of stock' : `${item.stock} in stock`) : '';
        const incDisabled = cartEntry ? cartEntry.qty >= maxQty : pendingQty >= maxQty;
        const decDisabled = !cartEntry && pendingQty <= 1;

        let actionBtn;
        if (outOfStock) {
          actionBtn = `<button class="btn subtle" disabled style="opacity:0.45">Out of stock</button>`;
        } else if (cartEntry) {
          actionBtn = `<button class="btn shop-incart-btn" data-open-cart="${item.id}">In cart ✓</button>`;
        } else {
          actionBtn = `<button class="btn primary shop-add-btn" data-add-cart="${item.id}">Add to cart</button>`;
        }

        return `
          <div class="shop-card${outOfStock ? ' shop-card-oos' : ''}">
            ${item.imageBase64
              ? `<img class="shop-card-img" src="${item.imageBase64}" alt="${esc(item.name)}">`
              : `<div class="shop-card-img-placeholder">🎁</div>`}
            <div class="shop-card-body">
              <div class="shop-card-name">${esc(item.name)}</div>
              ${item.description ? `<div class="shop-card-desc">${esc(item.description)}</div>` : '<div class="shop-card-desc"></div>'}
              <div class="shop-card-price-row">
                <span class="shop-card-cost${canAfford && !outOfStock ? '' : ' low-pts'}">${item.pointCost} pts</span>
                ${stockText ? `<span style="font-size:10px;color:var(--text-2)">${stockText}</span>` : ''}
              </div>
              <div class="shop-card-actions">
                ${outOfStock ? '' : `
                <div class="qty-ctrl">
                  <button class="qty-btn" data-qty-dec="${item.id}"${decDisabled ? ' disabled' : ''}>−</button>
                  <span class="qty-num">${displayQty}</span>
                  <button class="qty-btn" data-qty-inc="${item.id}"${incDisabled ? ' disabled' : ''}>+</button>
                </div>`}
                ${actionBtn}
              </div>
            </div>
          </div>`;
      }).join('');
    };

    const renderMyOrders = (orders) => {
      const list = document.getElementById('my-orders-list');
      const emptyEl = document.getElementById('my-orders-empty');
      if (!list) return;
      if (!orders.length) { list.innerHTML = ''; if (emptyEl) emptyEl.hidden = false; return; }
      if (emptyEl) emptyEl.hidden = true;
      list.innerHTML = orders.map(order => {
        const itemNames = (order.items || []).map(i => {
          const qty = i.qty || 1;
          return esc(qty > 1 ? `${qty}× ${i.name}` : i.name);
        }).join(', ');
        const date = order.createdAt
          ? new Date(order.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
          : '';
        const noteHtml = order.status === 'verified'
          ? `<div class="my-order-note">Your item is on the way!</div>`
          : order.status === 'rejected'
          ? `<div class="my-order-note" style="color:#c52020">Order was not approved.</div>`
          : `<div class="my-order-note" style="color:var(--text-2)">Awaiting admin review.</div>`;
        return `
          <div class="my-order-row">
            <div class="my-order-info">
              <div class="my-order-name">${itemNames}</div>
              <div class="my-order-date">${date} · ${order.totalCost} pts</div>
              ${noteHtml}
            </div>
            <span class="order-pill ${order.status}">${order.status}</span>
          </div>`;
      }).join('');
    };

    const openCartModal = () => {
      const modal = document.getElementById('cart-modal');
      if (!modal) return;
      const cart = getCart();
      const wrap = document.getElementById('cart-items-wrap');
      const totalEl = document.getElementById('cart-total');
      const warning = document.getElementById('cart-pts-warning');
      const confirmBtn = document.getElementById('cart-confirm-btn');
      if (!wrap) return;
      const total = cart.reduce((s, i) => s + i.pointCost * (i.qty || 1), 0);
      if (totalEl) totalEl.textContent = `${total} pts`;
      if (!cart.length) {
        wrap.innerHTML = '<div style="text-align:center;padding:24px 0;color:var(--text-2)">Your cart is empty.</div>';
      } else {
        wrap.innerHTML = cart.map((item, idx) => {
          const shopItem = shopItemsCache.find(i => i.id === item.id);
          const imgHtml = shopItem?.imageBase64
            ? `<img src="${shopItem.imageBase64}" style="width:100%;height:100%;object-fit:cover">`
            : '🎁';
          const lineTotal = item.pointCost * (item.qty || 1);
          const maxQty = shopItem?.stock ?? 99;
          return `
            <div class="cart-item-row">
              <div class="cart-item-thumb">${imgHtml}</div>
              <span class="cart-item-name">${esc(item.name)}</span>
              <div class="qty-ctrl">
                <button class="qty-btn" data-cart-dec="${idx}">−</button>
                <span class="qty-num">${item.qty || 1}</span>
                <button class="qty-btn" data-cart-inc="${idx}"${(item.qty || 1) >= maxQty ? ' disabled' : ''}>+</button>
              </div>
              <span class="cart-item-cost">${lineTotal} pts</span>
              <button class="cart-item-remove" data-cart-remove="${idx}" title="Remove all">×</button>
            </div>`;
        }).join('');
      }
      const insufficient = !cart.length || total > currentPoints;
      if (warning) warning.hidden = !insufficient;
      if (confirmBtn) confirmBtn.disabled = insufficient;
      modal.hidden = false;
    };

    document.getElementById('cart-btn')?.addEventListener('click', openCartModal);
    ['cart-close', 'cart-cancel-btn'].forEach(id =>
      document.getElementById(id)?.addEventListener('click', () => {
        const m = document.getElementById('cart-modal');
        if (m) m.hidden = true;
      })
    );

    document.getElementById('cart-items-wrap')?.addEventListener('click', (e) => {
      const removeBtn = e.target.closest('[data-cart-remove]');
      const incBtn = e.target.closest('[data-cart-inc]');
      const decBtn = e.target.closest('[data-cart-dec]');
      const cart = getCart();
      if (removeBtn) {
        cart.splice(parseInt(removeBtn.dataset.cartRemove, 10), 1);
        saveCart(cart); updateCartBadge(); renderShopGrid(); openCartModal();
      } else if (incBtn) {
        const idx = parseInt(incBtn.dataset.cartInc, 10);
        if (cart[idx]) {
          const shopItem = shopItemsCache.find(i => i.id === cart[idx].id);
          if (cart[idx].qty < (shopItem?.stock ?? 99)) cart[idx].qty++;
          saveCart(cart); updateCartBadge(); renderShopGrid(); openCartModal();
        }
      } else if (decBtn) {
        const idx = parseInt(decBtn.dataset.cartDec, 10);
        if (cart[idx]) {
          if (cart[idx].qty <= 1) cart.splice(idx, 1); else cart[idx].qty--;
          saveCart(cart); updateCartBadge(); renderShopGrid(); openCartModal();
        }
      }
    });

    document.getElementById('shop-grid')?.addEventListener('click', (e) => {
      const addBtn = e.target.closest('[data-add-cart]');
      const openBtn = e.target.closest('[data-open-cart]');
      const incBtn = e.target.closest('[data-qty-inc]');
      const decBtn = e.target.closest('[data-qty-dec]');
      if (addBtn) {
        const itemId = addBtn.dataset.addCart;
        const item = shopItemsCache.find(i => i.id === itemId);
        if (!item) return;
        const cart = getCart();
        const existing = cart.find(c => c.id === itemId);
        const qty = pendingQtys[itemId] || 1;
        if (existing) { existing.qty += qty; } else { cart.push({ id: item.id, name: item.name, pointCost: item.pointCost, qty }); }
        delete pendingQtys[itemId];
        saveCart(cart); updateCartBadge(); renderShopGrid();
      } else if (openBtn) {
        openCartModal();
      } else if (incBtn) {
        const itemId = incBtn.dataset.qtyInc;
        const cart = getCart();
        const entry = cart.find(c => c.id === itemId);
        const shopItem = shopItemsCache.find(i => i.id === itemId);
        const maxQty = shopItem?.stock ?? 99;
        if (entry) {
          if (entry.qty < maxQty) { entry.qty++; saveCart(cart); updateCartBadge(); }
        } else {
          pendingQtys[itemId] = Math.min((pendingQtys[itemId] || 1) + 1, maxQty);
        }
        renderShopGrid();
      } else if (decBtn) {
        const itemId = decBtn.dataset.qtyDec;
        const cart = getCart();
        const idx = cart.findIndex(c => c.id === itemId);
        if (idx !== -1) {
          if (cart[idx].qty <= 1) cart.splice(idx, 1); else cart[idx].qty--;
          saveCart(cart); updateCartBadge();
        } else {
          pendingQtys[itemId] = Math.max(1, (pendingQtys[itemId] || 1) - 1);
        }
        renderShopGrid();
      }
    });

    document.getElementById('cart-confirm-btn')?.addEventListener('click', async () => {
      const cart = getCart();
      const total = cart.reduce((s, i) => s + i.pointCost * (i.qty || 1), 0);
      if (!cart.length || total > currentPoints) return;
      const btn = document.getElementById('cart-confirm-btn');
      if (btn) { btn.disabled = true; btn.textContent = 'Placing order…'; }
      await addDoc(collection(db, 'shopOrders'), {
        userId,
        userEmail: currentUser?.email || '',
        username: currentUsername || '',
        items: cart.map(i => ({ id: i.id, name: i.name, pointCost: i.pointCost, qty: i.qty || 1 })),
        totalCost: total,
        status: 'pending',
        createdAt: Date.now(),
      });
      saveCart([]);
      updateCartBadge();
      renderShopGrid();
      const modal = document.getElementById('cart-modal');
      if (modal) modal.hidden = true;
      if (btn) { btn.disabled = false; btn.textContent = 'Confirm Order'; }
    });

    onSnapshot(collection(db, 'shopItems'), snap => {
      shopItemsCache = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      renderShopGrid();
    });

    const ordersQ = query(collection(db, 'shopOrders'), where('userId', '==', userId));
    onSnapshot(ordersQ, snap => {
      const orders = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      renderMyOrders(orders);
    });

    updateCartBadge();
  };
  // ── END STUDENT SHOP ─────────────────────────────────────────────────────

  // ── STUDENT ATTENDANCE ────────────────────────────────────────────────────
  const escAtt = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const TAG_LABEL_ATT = { tournament:'Tournament', practice:'Practice', meeting:'Meeting', lesson:'Lesson', match:'Match' };

  const initStudentAttendance = (userId) => {
    let attPromptShown = false;
    let attCurrentEvent = null;
    let attFormData = null;

    const getActiveEvent = () => {
      const now = Date.now();
      return eventsCache.find(ev =>
        ev.tag && ev.tag !== 'classic' &&
        ev.date <= now &&
        now <= ev.date + (ev.durationMin || 30) * 60000
      ) || null;
    };

    const renderAttForm = async (event) => {
      const banner = document.getElementById('stu-att-banner');
      const doneEl = document.getElementById('stu-att-done');
      const formEl = document.getElementById('stu-att-form');
      const eventNameEl = document.getElementById('stu-att-event-name');

      if (banner) banner.innerHTML = `
        <div class="stu-att-banner-inner">
          <div>
            <div class="stu-att-event-title">${escAtt(event.title || 'Event')}</div>
            <div class="stu-att-event-meta">${new Date(event.date).toLocaleString(undefined, { dateStyle:'medium', timeStyle:'short' })} · ${event.durationMin || 30} min</div>
          </div>
          <span class="tag-badge tag-${event.tag}">${TAG_LABEL_ATT[event.tag] || event.tag}</span>
        </div>`;

      if (eventNameEl) eventNameEl.textContent = event.title || 'this event';

      // Check if already submitted
      const subSnap = await getDocs(query(
        collection(db, 'attendanceResponses'),
        where('userId', '==', userId),
        where('eventId', '==', event.id)
      ));
      const alreadyDone = !subSnap.empty;

      if (alreadyDone) {
        if (doneEl) doneEl.hidden = false;
        if (formEl) formEl.hidden = true;
        const donePtsEl = document.getElementById('stu-att-done-pts');
        if (donePtsEl && attFormData) donePtsEl.textContent = `${attFormData.points ?? 10} points`;
        return;
      }
      if (doneEl) doneEl.hidden = true;
      if (formEl) formEl.hidden = false;

      // Load form config (questions + points)
      const formSnap = await getDoc(doc(db, 'attendanceForms', event.id));
      attFormData = formSnap.exists() ? formSnap.data() : { points: 10, questions: [] };

      const extraQsEl = document.getElementById('stu-att-extra-qs');
      if (extraQsEl) {
        extraQsEl.innerHTML = (attFormData.questions || []).map(q => `
          <div class="stu-att-q-wrap">
            <label class="stu-att-q-label">${escAtt(q.text)}</label>
            <input class="stu-att-q-input" type="text" placeholder="Your answer…" data-q-id="${q.id}" />
          </div>`).join('');
      }

      // Show prompt modal once per session
      if (!attPromptShown) {
        attPromptShown = true;
        const promptModal = document.getElementById('att-prompt-modal');
        const promptName = document.getElementById('att-prompt-event-name');
        if (promptName) promptName.textContent = event.title || 'Event';
        if (promptModal) promptModal.hidden = false;
      }
    };

    const checkActiveEvent = async () => {
      const tab = document.getElementById('att-tab');
      const active = getActiveEvent();
      if (active) {
        if (tab) tab.hidden = false;
        if (!attCurrentEvent || attCurrentEvent.id !== active.id) {
          attCurrentEvent = active;
          renderAttForm(active);
        }
      } else {
        attCurrentEvent = null;
        if (tab) tab.hidden = true;
      }
    };

    // Register check function so events onSnapshot can trigger it
    attCheckFn = checkActiveEvent;

    // Submit attendance
    document.getElementById('stu-att-check')?.addEventListener('change', e => {
      const btn = document.getElementById('stu-att-submit');
      if (btn) btn.disabled = !e.target.checked;
    });

    document.getElementById('stu-att-submit')?.addEventListener('click', async () => {
      const btn = document.getElementById('stu-att-submit');
      if (!attCurrentEvent) return;
      if (btn) { btn.disabled = true; btn.textContent = 'Submitting…'; }

      const answers = Array.from(document.querySelectorAll('#stu-att-extra-qs [data-q-id]'))
        .map(inp => ({ questionId: inp.dataset.qId, text: inp.value.trim() }));

      await addDoc(collection(db, 'attendanceResponses'), {
        eventId: attCurrentEvent.id,
        userId,
        userEmail: currentUser?.email || '',
        username: currentUsername || '',
        answers,
        submittedAt: Date.now()
      });

      const pts = attFormData?.points ?? 10;
      const streakData = await initStreakFromAttendance(userId);
      currentStreak = streakData.currentStreak;
      const mult = getStreakMultiplier(currentStreak);
      const finalPts = Math.round(pts * mult);
      await updateDoc(doc(db, 'users', userId), { points: increment(finalPts) });
      currentPoints += finalPts;
      if (statPointsEl) statPointsEl.textContent = currentPoints;
      if (pointsSummaryEl) pointsSummaryEl.textContent = `You have ${currentPoints} points`;
      renderStreakWidget(streakData.currentStreak, streakData.longestStreak);

      const doneEl = document.getElementById('stu-att-done');
      const formEl = document.getElementById('stu-att-form');
      const donePtsEl = document.getElementById('stu-att-done-pts');
      if (doneEl) doneEl.hidden = false;
      if (formEl) formEl.hidden = true;
      if (donePtsEl) donePtsEl.textContent = mult > 1.0 ? `${finalPts} points (×${mult.toFixed(1)} streak bonus!)` : `${finalPts} points`;
    });

    // Prompt modal buttons
    document.getElementById('att-prompt-later')?.addEventListener('click', () => {
      const m = document.getElementById('att-prompt-modal');
      if (m) m.hidden = true;
    });
    document.getElementById('att-prompt-go')?.addEventListener('click', () => {
      const m = document.getElementById('att-prompt-modal');
      if (m) m.hidden = true;
      document.querySelector('.tab[data-tab="attendance"]')?.click();
    });

    // Periodic check every minute + immediate check
    setInterval(checkActiveEvent, 60000);
    checkActiveEvent();
  };
  // ── END STUDENT ATTENDANCE ────────────────────────────────────────────────

  if (logoutBtn) logoutBtn.addEventListener('click', () => signOut(auth));
}
