import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-auth.js';
import { getFirestore, doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc, getDocs, increment, collection, query, orderBy, where, onSnapshot } from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js';
import { mountNewsletterMail } from './newsletter-mail.js';
import { fontSelectHTML, wireFontSelect } from './mail-fonts.js';

const cfg = window.FIREBASE_CONFIG;

const getInitials = (name) => {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
};

const tabs = Array.from(document.querySelectorAll('.tab'));
const sections = Array.from(document.querySelectorAll('.section'));
const logoutBtn = document.getElementById('logout');
const ADMIN_EMAILS = ['shaurya.sahdev7@gmail.com', '2025510@apps.nsd.org', 'northcreekchessclub@gmail.com'];
let puzzleBoardRef = null;
let currentUserEmail = '';

/* The Lichess panel is a module of its own with live subscriptions and a
   sync worker, so it is mounted when the tab is first opened rather than
   with the page — and it keeps running afterwards, which is what lets the
   synchronization carry on while an admin works on another tab. */
let lichessMounted = null;
let lichessCtx = null;

async function mountLichess() {
  if (lichessMounted || !lichessCtx) return;
  const host = document.getElementById('lichess-host');
  if (!host) return;
  try {
    const { renderLichessAdmin } = await import('./lichess-admin.js');
    host.innerHTML = '';
    lichessMounted = renderLichessAdmin(lichessCtx, host);
  } catch (e) {
    console.error(e);
    host.innerHTML = '<div class="empty-state">The Lichess panel could not be loaded.</div>';
  }
}

const activate = (id) => {
  tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === id));
  sections.forEach(s => s.classList.toggle('active', s.id === id));
  setTimeout(() => {
    if (id === 'events' && typeof renderCalendar === 'function') renderCalendar();
    if (id === 'puzzles' && puzzleBoardRef?.resize) puzzleBoardRef.resize();
    if (id === 'lichess') mountLichess();
  }, 0);
};
tabs.forEach(t => t.addEventListener('click', () => activate(t.dataset.tab)));

if (!cfg) {
  window.location.href = '/login';
} else {
  const app = initializeApp(cfg);
  const auth = getAuth(app);
  const db = getFirestore(app);

  onAuthStateChanged(auth, async (user) => {
    if (!user) return window.location.href = '/login';
    const ref = doc(db, 'users', user.uid);
    const snap = await getDoc(ref);
    const snapData = snap.exists() ? snap.data() : {};
    if (snapData.banned || snapData.deleted) {
      await signOut(auth);
      return window.location.href = '/login';
    }
    /* let Analytics know who this is, so returning visits register */
    window.jagIdentify?.(user.uid);
    const email = (user?.email || '').trim().toLowerCase();
    currentUserEmail = email;
    const isAdminEmail = ADMIN_EMAILS.includes(email);
    let role = snapData.role || 'student';
    if (isAdminEmail && role !== 'admin') {
      role = 'admin';
      await setDoc(ref, { role: 'admin', promotedAt: Date.now() }, { merge: true });
    }
    if (role !== 'admin') return window.location.href = '/student/dashboard.html';

    // sidebar identity + greeting
    const displayName = snapData.username || (user.email || '').split('@')[0] || 'Administrator';
    const nameEl = document.getElementById('adm-user-name');
    const mailEl = document.getElementById('adm-user-email');
    const avaEl = document.getElementById('adm-user-avatar');
    const greetEl = document.getElementById('greet-name');
    if (nameEl) nameEl.textContent = displayName;
    if (mailEl) mailEl.textContent = user.email || '';
    if (avaEl) {
      avaEl.textContent = getInitials(displayName);
      if (snapData.avatarColor) avaEl.style.background = snapData.avatarColor;
    }
    if (greetEl) greetEl.textContent = displayName;

    /* The lichess modules take the same ctx shape the club and hub pages
       hand around; outside a club, clubId is null and the teams are the
       site's own. */
    lichessCtx = {
      clubId: null,
      club: { name: 'JagChess', blocks: [] },
      user,
      member: { ...snapData, username: displayName, uid: user.uid },
      isAdmin: true,
      globalOnly: true,
      page: 'lichess'
    };

    activate('dashboard');
  });

  const countStudents = document.getElementById('count-students');
  const countEvents = document.getElementById('count-events');
  const countNews = document.getElementById('count-news');

  const reportPuzzleStatus = (msg) => {
    const el = document.getElementById('admin-puzzle-status');
    if (el) el.textContent = msg;
  };
  const handleSnapshotError = (err) => {
    console.error('Firestore snapshot error:', err);
    if (err?.code === 'permission-denied') {
      reportPuzzleStatus('Permission denied. Check Firestore rules.');
    }
  };
  const qUsers = query(collection(db, 'users'));
  onSnapshot(qUsers, (snap) => {
    const studentCount = snap.docs.filter(d => {
      const data = d.data();
      return !data.deleted && (data.role || 'student') === 'student';
    }).length;
    if (countStudents) countStudents.textContent = studentCount;
  }, handleSnapshotError);
  const qNews = query(collection(db, 'announcements'));
  onSnapshot(qNews, (snap) => { countNews.textContent = snap.size; }, handleSnapshotError);

  const TAGS = [
    { value: 'classic', label: 'Classic' },
    { value: 'tournament', label: 'Tournament' },
    { value: 'practice', label: 'Practice' },
    { value: 'meeting', label: 'Meeting' },
    { value: 'lesson', label: 'Lesson' },
    { value: 'match', label: 'Match' }
  ];

  const evTitle = document.getElementById('ev-title');
  const evDate = document.getElementById('ev-date');
  const evTime = document.getElementById('ev-time');
  const evDesc = document.getElementById('ev-desc');
  const evTag = document.getElementById('ev-tag');
  const evDurVal = document.getElementById('ev-dur-val');
  const addEventBtn = document.getElementById('add-event');
  const cancelEditBtn = document.getElementById('cancel-edit');
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
  const modalEdit = document.getElementById('modal-edit');
  const modalDelete = document.getElementById('modal-delete');
  const modalActions = document.getElementById('modal-actions');

  let eventsCache = [];
  let eventsById = new Map();
  let dashNewsCache = [];
  let dashLeadersCache = [];
  let allUsersCache = [];
  let usersFilter = 'all';
  let activeMonth = new Date();
  activeMonth.setDate(1);
  activeMonth.setHours(0, 0, 0, 0);
  let editingId = null;
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

  const renderDashEvents = () => {
    const el = document.getElementById('dash-events-list');
    if (!el) return;
    const now = Date.now();
    const upcoming = eventsCache.filter(e => e.date >= now).slice(0, 4);
    if (!upcoming.length) { el.innerHTML = '<div class="empty-state">No upcoming events.</div>'; return; }
    el.innerHTML = upcoming.map(ev => {
      const d = new Date(ev.date);
      const day = d.getDate();
      const mon = d.toLocaleString(undefined, { month: 'short' }).toUpperCase();
      return `<div class="dash-ev-row">
        <div class="dash-ev-date">
          <span class="dash-ev-day">${day}</span>
          <span class="dash-ev-mon">${mon}</span>
        </div>
        <div class="dash-ev-info">
          <div class="dash-ev-title">${ev.title || 'Event'}</div>
          <div class="dash-ev-sub">
            <span class="tag-badge ${tagClass(ev.tag)}">${tagLabel(ev.tag)}</span>
            ${ev.time ? `<span class="dash-ev-time">${ev.time}</span>` : ''}
          </div>
        </div>
      </div>`;
    }).join('');
  };

  const renderDashLeaders = () => {
    const el = document.getElementById('dash-leaders-list');
    if (!el) return;
    if (!dashLeadersCache.length) { el.innerHTML = '<div class="empty-state">No entries yet.</div>'; return; }
    el.innerHTML = dashLeadersCache.slice(0, 5).map((it, i) =>
      `<div class="dash-leader-row">
        <span class="dash-leader-rank${i < 3 ? ' top' : ''}">${i + 1}</span>
        <span class="dash-leader-name">${it.username || 'Student'}</span>
        <span class="dash-leader-pts">${it.points || 0} pts</span>
      </div>`
    ).join('');
  };

  const renderDashNews = () => {
    const el = document.getElementById('dash-news-list');
    if (!el) return;
    if (!dashNewsCache.length) { el.innerHTML = '<div class="empty-state">No announcements yet.</div>'; return; }
    el.innerHTML = dashNewsCache.slice(0, 3).map(it => {
      const date = it.createdAt
        ? new Date(it.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
        : '';
      return `<div class="dash-news-row">
        <span class="dash-news-title">${it.title || 'Announcement'}</span>
        <span class="dash-news-date">${date}</span>
      </div>`;
    }).join('');
  };

  const clearForm = () => {
    editingId = null;
    evTitle.value = '';
    evDate.value = '';
    evTime.value = '';
    evDesc.value = '';
    evTag.value = 'classic';
    if (evDurVal) evDurVal.value = '30';
    addEventBtn.textContent = 'Add Event';
    cancelEditBtn.hidden = true;
  };

  const startEdit = (event) => {
    editingId = event.id;
    evTitle.value = event.title || '';
    evDesc.value = event.desc || '';
    evTag.value = event.tag || 'classic';
    const d = new Date(event.date);
    evDate.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    evTime.value = event.time || '';
    if (evDurVal) evDurVal.value = event.durationMin != null ? event.durationMin : '30';
    addEventBtn.textContent = 'Save Changes';
    cancelEditBtn.hidden = false;
    activate('events');
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
    const shown = upcoming.slice(0, 4);
    eventsUpcoming.innerHTML = shown.map((event) => `
      <div class="list-item" data-id="${event.id}">
        <strong>${event.title || 'Event'}</strong>
        <span>${formatEventDate(event)}</span>
        <span>${event.desc || ''}</span>
        <span class="tag-badge ${tagClass(event.tag)}">${tagLabel(event.tag)}</span>
        <div class="list-actions">
          <button class="btn subtle" data-action="edit">Edit</button>
          <button class="btn subtle danger" data-action="delete">Delete</button>
        </div>
      </div>
    `).join('');
    const showAllBtn = document.getElementById('show-all-events-btn');
    if (showAllBtn) {
      if (upcoming.length > 4) {
        showAllBtn.hidden = false;
        showAllBtn.textContent = `View all (${upcoming.length})`;
      } else {
        showAllBtn.hidden = true;
      }
    }
  };

  const openModal = (event) => {
    if (!event) return;
    modalEventId = event.id;
    modalTitle.textContent = event.title || 'Event';
    modalDate.textContent = formatEventDate(event);
    modalDesc.textContent = event.desc || 'No description yet.';
    modalTag.innerHTML = `<span class="tag-badge ${tagClass(event.tag)}">${tagLabel(event.tag)}</span>`;
    modalActions.hidden = false;
    modal.hidden = false;
  };

  const closeModal = () => {
    modal.hidden = true;
    modalEventId = null;
  };

  const allEventsModal = document.getElementById('all-events-modal');
  const allEventsList = document.getElementById('all-events-list');
  const openAllEventsModal = () => {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const upcoming = eventsCache.filter(ev => ev.date >= now.getTime());
    if (allEventsList) {
      allEventsList.innerHTML = upcoming.length
        ? upcoming.map(ev => `
          <div class="list-item">
            <strong>${ev.title || 'Event'}</strong>
            <span>${formatEventDate(ev)}</span>
            <span class="tag-badge ${tagClass(ev.tag)}">${tagLabel(ev.tag)}</span>
          </div>`).join('')
        : '<div class="empty-state">No upcoming events.</div>';
    }
    if (allEventsModal) allEventsModal.hidden = false;
  };
  document.getElementById('all-events-close')?.addEventListener('click', () => { if (allEventsModal) allEventsModal.hidden = true; });
  allEventsModal?.addEventListener('click', e => { if (e.target === allEventsModal) allEventsModal.hidden = true; });
  document.getElementById('show-all-events-btn')?.addEventListener('click', openAllEventsModal);

  addEventBtn.addEventListener('click', async () => {
    const title = evTitle.value.trim();
    const dateValue = evDate.value;
    if (!title || !dateValue || !evTime.value) return;
    const timeValue = evTime.value || '00:00';
    const dateStr = new Date(`${dateValue}T${timeValue}`);
    const rawDur = evDurVal ? parseFloat(evDurVal.value) : NaN;
    const durationMin = !isNaN(rawDur) && rawDur > 0 ? rawDur : 30;
    const payload = {
      title,
      desc: evDesc.value.trim(),
      date: dateStr.getTime(),
      time: evTime.value.trim(),
      tag: evTag.value,
      durationMin,
      updatedAt: Date.now()
    };
    if (editingId) {
      await updateDoc(doc(db, 'events', editingId), payload);
    } else {
      payload.createdAt = Date.now();
      await addDoc(collection(db, 'events'), payload);
    }
    clearForm();
  });
  cancelEditBtn.addEventListener('click', () => clearForm());

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

  eventsUpcoming.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    const itemEl = e.target.closest('.list-item');
    if (!itemEl) return;
    const id = itemEl.dataset.id;
    const event = eventsById.get(id);
    if (!event) return;
    if (btn && btn.dataset.action === 'delete') {
      await deleteDoc(doc(db, 'events', id));
      if (modalEventId === id) closeModal();
      return;
    }
    if (btn && btn.dataset.action === 'edit') {
      startEdit(event);
      return;
    }
    openModal(event);
  });

  modalClose.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });
  modalEdit.addEventListener('click', () => {
    if (!modalEventId) return;
    const event = eventsById.get(modalEventId);
    if (event) startEdit(event);
    closeModal();
  });
  modalDelete.addEventListener('click', async () => {
    if (!modalEventId) return;
    await deleteDoc(doc(db, 'events', modalEventId));
    closeModal();
  });

  const qEvents = query(collection(db, 'events'), orderBy('date', 'asc'));
  onSnapshot(qEvents, (snap) => {
    const items = [];
    snap.forEach(docu => items.push({ id: docu.id, ...docu.data() }));
    eventsCache = items;
    eventsById = new Map(items.map(ev => [ev.id, ev]));
    countEvents.textContent = items.length;
    renderCalendar();
    renderUpcoming();
    renderDashEvents();
    populateAttEventDropdown();
  }, handleSnapshotError);

  const adminBoardEl = document.getElementById('admin-board');
  const puzzleStatus = document.getElementById('admin-puzzle-status');
  const puzzleClear = document.getElementById('puzzle-clear');
  const puzzleSetStart = document.getElementById('puzzle-set-start');
  const puzzleReset = document.getElementById('puzzle-reset');
  const puzzleAddMove = document.getElementById('puzzle-add-move');
  const puzzleUndo = document.getElementById('puzzle-undo');
  const puzzleSequenceList = document.getElementById('puzzle-sequence-list');
  const puzzleTitle = document.getElementById('puzzle-title');
  const puzzleDesc = document.getElementById('puzzle-desc');
  const puzzleMaxMoves = document.getElementById('puzzle-max-moves');
  const puzzlePoints = document.getElementById('puzzle-points');
  const puzzleColor = document.getElementById('puzzle-color');
  const puzzlePublish = document.getElementById('puzzle-publish');
  const puzzleCancelEdit = document.getElementById('puzzle-cancel-edit');
  const adminPuzzleList = document.getElementById('admin-puzzle-list');

  let puzzleBoard = null;
  let puzzleGame = null;
  let puzzleStartFen = '';
  let puzzleSolution = [];
  let puzzlePendingMove = null;
  let puzzleEditingId = null;
  let puzzlesCache = [];
  let puzzlesById = new Map();

  const setPuzzleStatus = (msg) => {
    if (puzzleStatus) puzzleStatus.textContent = msg;
  };

  const renderPuzzleSequence = () => {
    if (!puzzleSequenceList) return;
    if (!puzzleSolution.length) {
      puzzleSequenceList.innerHTML = '<div class="empty-state">No moves added yet.</div>';
      return;
    }
    puzzleSequenceList.innerHTML = puzzleSolution.map((move, idx) => (
      `<div class="list-item"><strong>Move ${idx + 1}</strong><span>${move}</span></div>`
    )).join('');
  };

  const pieceImgBase = new URL('../vendor/chessboard/img/chesspieces/wikipedia/', import.meta.url).href;
  const buildFen = (position, turn) => `${position} ${turn} - - 0 1`;
  const isValidFen = (fen) => {
    try {
      const test = new window.Chess();
      if (!test.load || !test.load(fen)) return false;
      const board = test.board();
      let whiteKings = 0;
      let blackKings = 0;
      board.flat().forEach((piece) => {
        if (piece?.type === 'k') {
          if (piece.color === 'w') whiteKings += 1;
          if (piece.color === 'b') blackKings += 1;
        }
      });
      return whiteKings === 1 && blackKings === 1;
    } catch {
      return false;
    }
  };
  const buildBoard = ({ sparePieces, position, orientation }) => {
    if (!adminBoardEl || !window.Chessboard) return;
    if (puzzleBoard && puzzleBoard.destroy) puzzleBoard.destroy();
    puzzleBoard = window.Chessboard(adminBoardEl, {
      draggable: true,
      dropOffBoard: sparePieces ? 'trash' : 'snapback',
      sparePieces,
      position: position || 'start',
      orientation: orientation || 'white',
      pieceTheme: (piece) => `${pieceImgBase}${piece}.png`,
      onDragStart: (source, piece) => {
        if (sparePieces) return;
        if (!puzzleGame) return false;
        return undefined;
      },
      onDrop: (source, target) => {
        if (sparePieces || !puzzleGame) return undefined;
        if (puzzlePendingMove) {
          setPuzzleStatus('Click "Add Correct Move" before making another move.');
          return 'snapback';
        }
        const preFen = puzzleBoard?.fen ? puzzleBoard.fen() : null;
        const piece = puzzleGame.get?.(source);
        const pieceColor = piece?.color || piece?.color?.toLowerCase?.();
        const turn = pieceColor || puzzleGame.turn?.() || 'w';
        if (preFen && turn) {
          const syncFen = buildFen(preFen, turn);
          if (isValidFen(syncFen)) puzzleGame = new window.Chess(syncFen);
        }
        const move = puzzleGame.move({ from: source, to: target, promotion: 'q' });
        if (!move) return 'snapback';
        puzzlePendingMove = move.san;
        setPuzzleStatus(`Pending: ${move.san}. Click "Add Correct Move".`);
        return undefined;
      },
      onSnapEnd: () => {
        if (puzzleGame && puzzleBoard) puzzleBoard.position(puzzleGame.fen());
      }
    });
    puzzleBoardRef = puzzleBoard;
  };

  const resetPuzzleEditor = () => {
    puzzleStartFen = '';
    puzzleSolution = [];
    puzzlePendingMove = null;
    puzzleGame = null;
    puzzleEditingId = null;
    puzzleTitle.value = '';
    puzzleDesc.value = '';
    puzzleMaxMoves.value = '';
    puzzlePoints.value = '';
    if (puzzleColor) puzzleColor.value = 'w';
    puzzlePublish.textContent = 'Publish Puzzle';
    puzzleCancelEdit.hidden = true;
    buildBoard({ sparePieces: true, position: 'start', orientation: 'white' });
    if (puzzleBoard?.clear) puzzleBoard.clear();
    if (puzzleBoardRef?.clear) puzzleBoardRef.clear();
    renderPuzzleSequence();
    setPuzzleStatus('Set the starting position.');
  };

  const loadPuzzleForEdit = (puzzle) => {
    puzzleEditingId = puzzle.id;
    puzzleStartFen = puzzle.fen || 'start';
    puzzleSolution = Array.isArray(puzzle.solution) ? [...puzzle.solution] : [];
    puzzlePendingMove = null;
    puzzleGame = new window.Chess(puzzleStartFen);
    puzzleSolution.forEach((move) => {
      puzzleGame.move(move, { sloppy: true });
    });
    buildBoard({ sparePieces: false, position: puzzleGame.fen() });
    puzzleTitle.value = puzzle.title || '';
    puzzleDesc.value = puzzle.description || '';
    puzzleMaxMoves.value = puzzle.maxMoves || '';
    puzzlePoints.value = puzzle.points || '';
    if (puzzleColor) puzzleColor.value = puzzle.playerColor || 'w';
    puzzlePublish.textContent = 'Save Puzzle';
    puzzleCancelEdit.hidden = false;
    renderPuzzleSequence();
    setPuzzleStatus('Editing puzzle. Add moves to extend the solution.');
    activate('puzzles');
  };

  const PUZZLE_LIST_MAX = 5;

  const renderAdminPuzzleList = () => {
    if (!adminPuzzleList) return;
    if (!puzzlesCache.length) {
      adminPuzzleList.innerHTML = '<div class="empty-state">No puzzles yet.</div>';
      return;
    }
    const visible = puzzlesCache.slice(0, PUZZLE_LIST_MAX);
    adminPuzzleList.innerHTML = visible.map((puzzle, index) => `
      <div class="list-item puzzle-list-item" data-id="${puzzle.id}">
        <strong>${puzzle.title || `Puzzle #${puzzlesCache.length - index}`}</strong>
        <span class="puzzle-badge">${(puzzle.solution || []).length} moves • ${puzzle.points || 0} pts</span>
        <span class="puzzle-badge">${(puzzle.playerColor || 'w') === 'b' ? 'Play Black' : 'Play White'}</span>
        <div class="list-actions">
          <button class="btn subtle" data-action="edit">Edit</button>
          <button class="btn subtle danger" data-action="delete">Delete</button>
        </div>
      </div>
    `).join('');
    if (puzzlesCache.length > PUZZLE_LIST_MAX) {
      adminPuzzleList.innerHTML += `<button class="btn subtle puzzle-view-all-btn" style="width:100%;margin-top:6px">View all ${puzzlesCache.length} puzzles →</button>`;
    }
  };

  const renderPuzzleAllModal = () => {
    const list = document.getElementById('puzzle-all-list');
    if (!list) return;
    if (!puzzlesCache.length) {
      list.innerHTML = '<div class="empty-state">No puzzles yet.</div>';
      return;
    }
    list.innerHTML = puzzlesCache.map((puzzle, index) => `
      <div class="list-item puzzle-list-item" data-id="${puzzle.id}">
        <div class="puzzle-all-info">
          <strong>${puzzle.title || `Puzzle #${puzzlesCache.length - index}`}</strong>
          ${puzzle.description ? `<span class="puzzle-all-desc">${puzzle.description}</span>` : ''}
          <span class="puzzle-badge">${(puzzle.solution || []).length} moves • ${puzzle.points || 0} pts • ${(puzzle.playerColor || 'w') === 'b' ? 'Play Black' : 'Play White'}</span>
        </div>
        <div class="list-actions">
          <button class="btn subtle" data-action="edit">Edit</button>
          <button class="btn subtle danger" data-action="delete">Delete</button>
        </div>
      </div>
    `).join('');
  };

  if (adminBoardEl) {
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
      resetPuzzleEditor();

      if (puzzleClear) puzzleClear.addEventListener('click', () => resetPuzzleEditor());

      if (puzzleSetStart) puzzleSetStart.addEventListener('click', () => {
        if (!puzzleBoard) return;
        const position = puzzleBoard.fen();
        const turn = puzzleColor?.value || 'w';
        const nextFen = buildFen(position, turn);
        if (!isValidFen(nextFen)) {
          setPuzzleStatus('Invalid position. Make sure both kings are on the board.');
          return;
        }
        puzzleStartFen = nextFen;
        puzzleGame = new window.Chess(puzzleStartFen);
        puzzleSolution = [];
        puzzlePendingMove = null;
        buildBoard({
          sparePieces: false,
          position: puzzleStartFen,
          orientation: turn === 'b' ? 'black' : 'white'
        });
        renderPuzzleSequence();
        setPuzzleStatus('Start position set. Make a move and click "Add Correct Move".');
      });

      if (puzzleReset) puzzleReset.addEventListener('click', () => {
        if (!puzzleStartFen) return;
        puzzleGame = new window.Chess(puzzleStartFen);
        puzzlePendingMove = null;
        puzzleSolution = [];
        buildBoard({
          sparePieces: false,
          position: puzzleStartFen,
          orientation: (puzzleColor?.value || 'w') === 'b' ? 'black' : 'white'
        });
        renderPuzzleSequence();
        setPuzzleStatus('Reset to start position.');
      });

      if (puzzleAddMove) puzzleAddMove.addEventListener('click', () => {
        if (!puzzlePendingMove) {
          setPuzzleStatus('Make a move on the board first.');
          return;
        }
        puzzleSolution.push(puzzlePendingMove);
        puzzlePendingMove = null;
        renderPuzzleSequence();
        setPuzzleStatus(`Move ${puzzleSolution.length} added.`);
      });

      if (puzzleUndo) puzzleUndo.addEventListener('click', () => {
        if (!puzzleGame) return;
        if (puzzlePendingMove) {
          puzzleGame.undo();
          puzzlePendingMove = null;
          puzzleBoard.position(puzzleGame.fen());
          setPuzzleStatus('Pending move removed.');
          return;
        }
        if (!puzzleSolution.length) return;
        puzzleGame.undo();
        puzzleSolution.pop();
        puzzleBoard.position(puzzleGame.fen());
        renderPuzzleSequence();
        setPuzzleStatus('Last move removed.');
      });

      if (puzzlePublish) puzzlePublish.addEventListener('click', async () => {
        const title = puzzleTitle.value.trim();
        if (!puzzleStartFen) {
          setPuzzleStatus('Set a starting position first.');
          return;
        }
        if (!puzzleSolution.length) {
          setPuzzleStatus('Add at least one correct move.');
          return;
        }
        const maxMovesValue = Number(puzzleMaxMoves.value || puzzleSolution.length);
        const pointsValue = Number(puzzlePoints.value || 10);
        if (!maxMovesValue || !pointsValue) {
          setPuzzleStatus('Enter max moves and points.');
          return;
        }
        const payload = {
          title,
          description: puzzleDesc.value.trim(),
          fen: puzzleStartFen,
          solution: puzzleSolution,
          maxMoves: maxMovesValue,
          points: pointsValue,
          playerColor: puzzleColor?.value || 'w',
          updatedAt: Date.now()
        };
        if (puzzleEditingId) {
          await updateDoc(doc(db, 'puzzles', puzzleEditingId), payload);
          setPuzzleStatus('Puzzle updated.');
        } else {
          payload.createdAt = Date.now();
          await addDoc(collection(db, 'puzzles'), payload);
          setPuzzleStatus('Puzzle published.');
        }
        resetPuzzleEditor();
      });

      if (puzzleCancelEdit) puzzleCancelEdit.addEventListener('click', () => resetPuzzleEditor());

      // ── IMPORT TOOLBAR ────────────────────────────────────────────────────
      document.getElementById('pip-fen-load')?.addEventListener('click', () => {
        const fenStr = document.getElementById('pip-fen-input')?.value.trim();
        if (!fenStr) return;
        if (!isValidFen(fenStr)) { setPuzzleStatus('Invalid FEN — check the string and try again.'); return; }
        buildBoard({ sparePieces: true, position: fenStr, orientation: (puzzleColor?.value || 'w') === 'b' ? 'black' : 'white' });
        setPuzzleStatus('FEN loaded. Adjust if needed, then click "Set as Start".');
      });

      // ── ALL PUZZLES MODAL ────────────────────────────────────────────────
      document.getElementById('puzzle-all-list')?.addEventListener('click', async (e) => {
        const btn = e.target.closest('button');
        const itemEl = e.target.closest('.puzzle-list-item');
        if (!btn || !itemEl) return;
        const id = itemEl.dataset.id;
        const puzzle = puzzlesById.get(id);
        if (!puzzle) return;
        if (btn.dataset.action === 'delete') {
          await deleteDoc(doc(db, 'puzzles', id));
          if (puzzleEditingId === id) resetPuzzleEditor();
          renderPuzzleAllModal();
          if (!puzzlesCache.length) document.getElementById('puzzle-all-modal').hidden = true;
        }
        if (btn.dataset.action === 'edit') {
          document.getElementById('puzzle-all-modal').hidden = true;
          loadPuzzleForEdit(puzzle);
        }
      });

      document.getElementById('puzzle-all-close')?.addEventListener('click', () => {
        document.getElementById('puzzle-all-modal').hidden = true;
      });
      document.getElementById('puzzle-all-modal')?.addEventListener('click', (e) => {
        if (e.target === document.getElementById('puzzle-all-modal')) {
          document.getElementById('puzzle-all-modal').hidden = true;
        }
      });
      if (puzzleColor) puzzleColor.addEventListener('change', () => {
        const position = puzzleStartFen ? puzzleStartFen.split(' ')[0] : puzzleBoard?.fen();
        const turn = puzzleColor.value || 'w';
        if (position) {
          const nextFen = buildFen(position, turn);
          if (!isValidFen(nextFen)) {
            setPuzzleStatus('Invalid position. Make sure both kings are on the board.');
            return;
          }
          puzzleStartFen = nextFen;
          puzzleGame = new window.Chess(puzzleStartFen);
          puzzlePendingMove = null;
          puzzleSolution = [];
          buildBoard({
            sparePieces: false,
            position: puzzleStartFen,
            orientation: turn === 'b' ? 'black' : 'white'
          });
          renderPuzzleSequence();
          setPuzzleStatus('Color changed. Resetting move list.');
        } else {
          buildBoard({ sparePieces: true, position: 'start', orientation: turn === 'b' ? 'black' : 'white' });
        }
      });

      if (adminPuzzleList) adminPuzzleList.addEventListener('click', async (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        if (btn.classList.contains('puzzle-view-all-btn')) {
          renderPuzzleAllModal();
          document.getElementById('puzzle-all-modal').hidden = false;
          return;
        }
        const itemEl = e.target.closest('.puzzle-list-item');
        if (!itemEl) return;
        const id = itemEl.dataset.id;
        const puzzle = puzzlesById.get(id);
        if (!puzzle) return;
        if (btn.dataset.action === 'delete') {
          await deleteDoc(doc(db, 'puzzles', id));
          if (puzzleEditingId === id) resetPuzzleEditor();
        }
        if (btn.dataset.action === 'edit') {
          loadPuzzleForEdit(puzzle);
        }
      });

      const qPuzzles = query(collection(db, 'puzzles'), orderBy('createdAt', 'desc'));
      onSnapshot(qPuzzles, (snap) => {
        const items = [];
        snap.forEach(docu => items.push({ id: docu.id, ...docu.data() }));
        puzzlesCache = items;
        puzzlesById = new Map(items.map(p => [p.id, p]));
        renderAdminPuzzleList();
        const cpEl = document.getElementById('count-puzzles');
        if (cpEl) cpEl.textContent = items.length;
      }, handleSnapshotError);
    }).catch(() => setPuzzleStatus('Chess libraries failed to load.'));
  }

  const newsTitle = document.getElementById('news-title');
  const newsEditor = document.getElementById('news-body-editor');
  const newsPost = document.getElementById('news-post');
  const newsList = document.getElementById('news-list');

  const rteToolbar = document.getElementById('rte-toolbar');
  if (rteToolbar && newsEditor) {
    let rteRange = null;

    // selectionchange is the most reliable way to track editor selection —
    // it fires before any dropdown or color picker steals focus.
    document.addEventListener('selectionchange', () => {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && newsEditor.contains(sel.anchorNode)) {
        rteRange = sel.getRangeAt(0).cloneRange();
      }
    });

    const restoreRange = () => {
      const r = rteRange; // snapshot before focus() might overwrite it
      newsEditor.focus();
      if (!r) return;
      try {
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
      } catch (_) {}
    };

    // Keep editor focus for all toolbar controls except the color and size inputs
    rteToolbar.addEventListener('mousedown', e => {
      if (!e.target.closest('input[type="color"]') && !e.target.closest('input[type="number"]')
          && !e.target.closest('select') && !e.target.closest('label.rte-color-wrap')) {
        e.preventDefault();
      }
    });

    // Regular command buttons
    rteToolbar.addEventListener('click', e => {
      const btn = e.target.closest('.rte-btn[data-cmd]');
      if (btn) {
        restoreRange();
        document.execCommand(btn.dataset.cmd, false, null);
        newsEditor.focus();
      }
    });

    /* The face the message is written in. Its markup is built here rather
       than sitting in the page, so the list of fonts lives in one file for
       both newsletter editors. */
    const fontSlot = document.getElementById('rte-font-slot');
    if (fontSlot) {
      fontSlot.innerHTML = fontSelectHTML('rte-font');
      wireFontSelect(document.getElementById('rte-font'), newsEditor, restoreRange);
    }

    // Font size stepper
    const rteSizeInput = document.getElementById('rte-size-input');
    const applyFontSize = (px) => {
      // Restore cursor collapsed to end — never touch existing text
      newsEditor.focus();
      if (rteRange) {
        const sel = window.getSelection();
        const r = rteRange.cloneRange();
        r.collapse(false);
        sel.removeAllRanges();
        sel.addRange(r);
      }
      // insertHTML works inside <li> where execCommand fontSize is unreliable
      const uid = `rtefsz${Date.now()}`;
      document.execCommand('insertHTML', false,
        `<span id="${uid}" style="font-size:${px}px">​</span>`);
      const span = newsEditor.querySelector(`#${uid}`);
      if (!span) return;
      span.removeAttribute('id');
      const sel = window.getSelection();
      const r = document.createRange();
      const txt = span.firstChild;
      r.setStart(txt || span, txt ? txt.length : 0);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
      rteRange = r.cloneRange();
    };
    document.getElementById('rte-size-dec')?.addEventListener('click', () => {
      const v = Math.max(8, (parseInt(rteSizeInput.value) || 14) - 1);
      rteSizeInput.value = v;
      applyFontSize(v);
    });
    document.getElementById('rte-size-inc')?.addEventListener('click', () => {
      const v = Math.min(72, (parseInt(rteSizeInput.value) || 14) + 1);
      rteSizeInput.value = v;
      applyFontSize(v);
    });
    rteSizeInput?.addEventListener('change', () => {
      const v = Math.min(72, Math.max(8, parseInt(rteSizeInput.value) || 14));
      rteSizeInput.value = v;
      applyFontSize(v);
    });

    // Backspace on empty bullet → exit list rather than merging with previous item
    newsEditor.addEventListener('keydown', e => {
      if (e.key !== 'Backspace') return;
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount || !sel.getRangeAt(0).collapsed) return;
      const node = sel.getRangeAt(0).startContainer;
      const li = (node.nodeType === 3 ? node.parentElement : node)?.closest('li');
      if (!li || li.textContent.trim() !== '') return;
      e.preventDefault();
      document.execCommand('outdent', false, null);
    });

    // Link — if text selected: prompt URL only; otherwise prompt text + URL
    document.getElementById('rte-link-btn')?.addEventListener('click', () => {
      restoreRange();
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) {
        const url = prompt('Enter URL:');
        if (url) document.execCommand('createLink', false, url);
      } else {
        const text = prompt('Display text:');
        if (!text) { newsEditor.focus(); return; }
        const url = prompt('Enter URL:');
        if (url) document.execCommand('insertHTML', false, `<a href="${url}">${text}</a>`);
      }
      newsEditor.focus();
    });

    // Image — open file picker
    const rteImageFile = document.getElementById('rte-image-file');
    document.getElementById('rte-image-btn')?.addEventListener('click', () => {
      rteImageFile?.click();
    });
    rteImageFile?.addEventListener('change', e => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = ev => {
        restoreRange();
        document.execCommand('insertImage', false, ev.target.result);
        newsEditor.focus();
      };
      reader.readAsDataURL(file);
      e.target.value = '';
    });

    // Paste images from clipboard
    newsEditor.addEventListener('paste', e => {
      const items = e.clipboardData?.items || [];
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const reader = new FileReader();
          reader.onload = ev => document.execCommand('insertImage', false, ev.target.result);
          reader.readAsDataURL(item.getAsFile());
          return;
        }
      }
    });

    // Emoji picker
    const EMOJI_CATS = [
      { id: 'smileys', icon: '😊', label: 'Smileys', emojis: ['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊','😇','🥰','😍','🤩','😘','😗','😚','😙','🥲','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','🤐','🤨','😐','😑','😶','😏','😒','🙄','😬','🤥','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🤧','🥵','🥶','🥴','😵','🤯','🤠','🥳','🥸','😎','🤓','🧐','😕','😟','🙁','☹️','😮','😯','😲','😳','🥺','😦','😧','😨','😰','😥','😢','😭','😱','😖','😣','😞','😓','😩','😫','🥱','😤','😡','😠','🤬','😈','👿','💀','☠️','💩','🤡','👹','👺','👻','👽','👾','🤖'] },
      { id: 'people', icon: '👋', label: 'People', emojis: ['👋','🤚','🖐','✋','🖖','👌','🤌','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','👇','☝️','👍','👎','✊','👊','🤛','🤜','👏','🙌','👐','🤲','🤝','🙏','💪','🦵','🦶','👂','👃','👀','👅','👶','🧒','👦','👧','🧑','👱','👨','🧔','👩','🧓','👴','👵','🙍','🙎','🙅','🙆','💁','🙋','🧏','🙇','🤦','🤷','💃','🕺','👫','👬','👭','💑','👪'] },
      { id: 'nature', icon: '🌿', label: 'Nature', emojis: ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🐔','🐧','🐦','🦆','🦅','🦉','🦇','🐺','🐗','🐴','🦄','🐝','🦋','🐌','🐞','🐜','🐢','🐍','🦎','🐙','🦑','🦐','🦀','🐡','🐠','🐟','🐬','🐳','🐋','🦈','🐊','🐘','🦛','🐪','🦒','🐃','🐄','🐎','🐖','🐑','🐐','🦌','🐕','🐈','🐓','🦃','🦚','🦜','🦢','🕊','🐇','🦝','🦦','🐿','🌵','🎄','🌲','🌳','🌴','🌱','🌿','☘️','🍀','🍃','🍂','🍁','🍄','🌾','💐','🌷','🌹','🥀','🌺','🌸','🌼','🌻','🌞','🌝','🌙','🌟','⭐','🌈','⚡','❄️','🌊','🌀'] },
      { id: 'food', icon: '🍕', label: 'Food', emojis: ['🍎','🍊','🍋','🍇','🍓','🫐','🍑','🍒','🍍','🥭','🍌','🍉','🍏','🍐','🥝','🍅','🥑','🍆','🥦','🥬','🥒','🌶','🧄','🧅','🥔','🌽','🍞','🥐','🥖','🧀','🥚','🍳','🧇','🥞','🍔','🍟','🌭','🍕','🌮','🌯','🥙','🧆','🥗','🍲','🍜','🍝','🍛','🍣','🍱','🥟','🍤','🍙','🍚','🍘','🥮','🧁','🍰','🎂','🍮','🍭','🍬','🍫','🍿','🍩','🍪','🧃','🥤','🧋','☕','🍵','🍺','🍻','🥂','🍷','🥃','🍸','🍹'] },
      { id: 'activities', icon: '⚽', label: 'Activities', emojis: ['⚽','🏀','🏈','⚾','🥎','🎾','🏐','🏉','🎱','🏓','🏸','⛳','🎣','🤿','🎽','🎿','🛷','🥌','🎯','🎮','🎰','🎲','♟','🎭','🎨','🎬','🎤','🎧','🎼','🎹','🥁','🎷','🎺','🎸','🎻','🏆','🥇','🥈','🥉','🏅','🎖','🏵','🎗','🎫','🎟','🎪','🎠','🎡','🎢','🎆','🎇','🧨','✨','🎉','🎊','🎋','🎀','🎁'] },
      { id: 'objects', icon: '💡', label: 'Objects', emojis: ['⌚','📱','💻','⌨️','🖥','🖨','🖱','💾','💿','📷','📸','📹','🎥','📞','☎️','📺','📻','⏱','⏰','⌛','📡','🔋','🔌','💡','🔦','🕯','💰','💳','📈','📉','📊','📋','📌','📍','📎','📏','📐','✂️','🔒','🔓','🔑','🗝','🔨','⚒','🛠','🔧','🔩','⚙️','⚖️','🔗','🧲','🧰','🧪','🧬','🔬','🔭','💊','🩺','🩹','📦','📝','📄','📚','📖','🔖','🏷','🪙','💴','💵','💶','💷'] },
      { id: 'symbols', icon: '❤️', label: 'Symbols', emojis: ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❤️‍🔥','💕','💞','💓','💗','💖','💘','💝','💟','☮️','✝️','☪️','✡️','☯️','🛐','♈','♉','♊','♋','♌','♍','♎','♏','♐','♑','♒','♓','⛎','💯','✅','❌','⭕','🛑','⛔','📛','🚫','💢','🔅','🔆','📶','🔴','🟠','🟡','🟢','🔵','🟣','⚫','⚪','🟤','🟥','🟧','🟨','🟩','🟦','🟪','⬛','⬜','🔺','🔻','🔷','🔶','🔹','🔸','▶️','⏸','⏹','⏩','⏪','➡️','⬅️','⬆️','⬇️','↩️','↪️','🔀','🔁','🔄','➕','➖','➗','✖️','♾','™️','©️','®️','🎵','🎶','💤','🔔','🔕','🔈','🔉','🔊'] },
    ];
    let emojiPicker = null;
    let currentEmojiCat = 'smileys';

    const buildEmojiPicker = () => {
      const picker = document.createElement('div');
      picker.className = 'rte-emoji-picker';
      picker.hidden = true;
      document.body.appendChild(picker);

      const searchWrap = document.createElement('div');
      searchWrap.className = 'rte-emoji-search';
      const searchInput = document.createElement('input');
      searchInput.type = 'text';
      searchInput.placeholder = 'Search emoji…';
      searchWrap.appendChild(searchInput);
      picker.appendChild(searchWrap);

      const catsEl = document.createElement('div');
      catsEl.className = 'rte-emoji-cats';
      EMOJI_CATS.forEach(cat => {
        const btn = document.createElement('button');
        btn.className = 'rte-emoji-cat' + (cat.id === currentEmojiCat ? ' active' : '');
        btn.textContent = cat.icon;
        btn.title = cat.label;
        btn.dataset.cat = cat.id;
        catsEl.appendChild(btn);
      });
      picker.appendChild(catsEl);

      const grid = document.createElement('div');
      grid.className = 'rte-emoji-grid';
      picker.appendChild(grid);

      const populateGrid = (catId, query = '') => {
        let emojis;
        if (query) {
          emojis = EMOJI_CATS.flatMap(c => c.emojis);
        } else {
          emojis = EMOJI_CATS.find(c => c.id === catId)?.emojis || [];
        }
        grid.innerHTML = emojis.map(e =>
          `<button class="rte-emoji-item" data-emoji="${e}">${e}</button>`
        ).join('');
      };
      populateGrid(currentEmojiCat);

      catsEl.addEventListener('click', e => {
        const btn = e.target.closest('.rte-emoji-cat');
        if (!btn) return;
        currentEmojiCat = btn.dataset.cat;
        catsEl.querySelectorAll('.rte-emoji-cat').forEach(b =>
          b.classList.toggle('active', b === btn)
        );
        searchInput.value = '';
        populateGrid(currentEmojiCat);
      });

      searchInput.addEventListener('input', () => {
        populateGrid(currentEmojiCat, searchInput.value.trim());
      });

      grid.addEventListener('click', e => {
        const btn = e.target.closest('.rte-emoji-item');
        if (!btn) return;
        restoreRange();
        document.execCommand('insertText', false, btn.dataset.emoji);
        newsEditor.focus();
        picker.hidden = true;
      });

      // Prevent picker interaction from stealing editor focus
      picker.addEventListener('mousedown', e => {
        if (!e.target.closest('input')) e.preventDefault();
      });

      return picker;
    };

    document.getElementById('rte-emoji-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!emojiPicker) emojiPicker = buildEmojiPicker();
      if (!emojiPicker.hidden) { emojiPicker.hidden = true; return; }
      const rect = e.currentTarget.getBoundingClientRect();
      emojiPicker.style.top = `${rect.bottom + 4}px`;
      emojiPicker.style.left = `${Math.min(rect.left, window.innerWidth - 296)}px`;
      emojiPicker.hidden = false;
    });

    document.addEventListener('click', e => {
      if (emojiPicker && !emojiPicker.hidden &&
          !e.target.closest('#rte-emoji-btn') && !e.target.closest('.rte-emoji-picker')) {
        emojiPicker.hidden = true;
      }
    });

    // Color picker — works on selection or at cursor for future typing
    const rteColorInput = document.getElementById('rte-color');
    const rteColorIndicator = document.getElementById('rte-color-indicator');
    rteColorInput?.addEventListener('input', e => {
      const color = e.target.value;
      restoreRange();
      document.execCommand('foreColor', false, color);
      if (rteColorIndicator) rteColorIndicator.style.borderBottomColor = color;
      newsEditor.focus();
    });
  }

  let newsCache = [];
  let newsEditingId = null;

  const escHtml = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  // ── Newsletter email ──────────────────────────────────────────────────────
  //  Shared component; see assets/js/newsletter-mail.js. The roster it offers
  //  here is the global users collection.

  const mailField = mountNewsletterMail(document.getElementById('news-mail-field'), {
    getPeople: () => (allUsersCache || []).map(u => ({
      email: u.email,
      name: u.username,
      role: u.role || 'student',
      avatarColor: u.avatarColor,
      deleted: u.deleted,
      banned: u.banned,
    })),
    getMe: () => currentUserEmail,
    getClubName: () => 'JagChess',
    /* An address on the site rather than a data URL: there is no club here
       to have a badge, and a mail client fetches a remote image happily. */
    getClubLogo: () => location.origin + '/assets/img/jagchess-mark.png',
    addAllLabel: 'Add all JagChess club students',
  });

  // ── End newsletter email ──────────────────────────────────────────────────

  const clearNewsForm = () => {
    newsEditingId = null;
    newsTitle.value = '';
    if (newsEditor) newsEditor.innerHTML = '';
    newsPost.textContent = 'Publish';
    const cancelBtn = document.getElementById('news-cancel-edit');
    if (cancelBtn) cancelBtn.hidden = true;
    const rteWrap = newsEditor?.closest('.rte-wrap');
    if (rteWrap) rteWrap.classList.remove('news-post-editing');
    mailField.reset();
  };

  newsPost.addEventListener('click', async () => {
    const title = newsTitle.value.trim();
    const body = newsEditor?.innerHTML.trim() || '';
    if (!title && !body) return;

    const emailing = mailField.enabled;
    // Commit anything typed into the recipient box but never chipped.
    if (emailing) mailField.flush();

    if (emailing && !mailField.recipients.length) {
      mailField.status('Add at least one recipient, or switch off "Email this to students".', 'warn');
      return;
    }

    newsPost.disabled = true;
    newsPost.textContent = emailing ? 'Sending…' : 'Publishing…';

    try {
      if (newsEditingId) {
        await updateDoc(doc(db, 'announcements', newsEditingId), { title, body, updatedAt: Date.now() });
      } else {
        await addDoc(collection(db, 'announcements'), { title, body, createdAt: Date.now() });
      }

      if (emailing) {
        // The post is already saved, so a mail failure leaves the form up with
        // the recipient list intact rather than losing the announcement.
        const result = await mailField.send(title || 'New announcement from JagChess', body);
        clearNewsForm();
        mailField.status(`Posted and emailed to ${result.sent} recipient${result.sent === 1 ? '' : 's'}.`, 'ok');
      } else {
        clearNewsForm();
      }
    } catch (err) {
      console.error('Newsletter send failed:', err);
      mailField.status(`Posted, but the email did not go out — ${err.message}`, 'error');
    } finally {
      newsPost.disabled = false;
      newsPost.textContent = newsEditingId ? 'Publish Edit' : 'Publish';
    }
  });

  document.getElementById('news-cancel-edit')?.addEventListener('click', clearNewsForm);

  onSnapshot(qNews, (snap) => {
    const items = [];
    snap.forEach(docu => items.push({ id: docu.id, ...docu.data() }));
    dashNewsCache = items;
    newsCache = items;
    newsList.innerHTML = items.map(it => {
      const date = it.createdAt
        ? new Date(it.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
        : '';
      return `<div class="news-card" data-id="${it.id}">
        <div class="news-card-header">
          <span class="news-card-date">${date}</span>
          <div class="news-card-actions">
            <button class="btn subtle" data-action="edit-news">Edit</button>
            <button class="btn subtle danger" data-action="delete-news">Delete</button>
          </div>
        </div>
        <div class="news-card-title">${escHtml(it.title || 'Announcement')}</div>
        <div class="news-card-body">${it.body || ''}</div>
      </div>`;
    }).join('');
    renderDashNews();
  });

  newsList.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const itemEl = e.target.closest('[data-id]');
    const id = itemEl?.dataset?.id;
    if (!id) return;
    if (btn.dataset.action === 'delete-news') {
      await deleteDoc(doc(db, 'announcements', id));
      if (newsEditingId === id) clearNewsForm();
    } else if (btn.dataset.action === 'edit-news') {
      const item = newsCache.find(i => i.id === id);
      if (!item) return;
      newsEditingId = id;
      newsTitle.value = item.title || '';
      if (newsEditor) newsEditor.innerHTML = item.body || '';
      newsPost.textContent = 'Publish Edit';
      const cancelBtn = document.getElementById('news-cancel-edit');
      if (cancelBtn) cancelBtn.hidden = false;
      const rteWrap = newsEditor?.closest('.rte-wrap');
      if (rteWrap) rteWrap.classList.add('news-post-editing');
      newsTitle.closest('.tile')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });

  document.getElementById('dashboard')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-activate]');
    if (btn) activate(btn.dataset.activate);
  });

  const renderUsersTab = () => {
    const el = document.getElementById('users-list');
    const metaEl = document.getElementById('users-meta');
    if (!el) return;
    const baseFiltered = usersFilter === 'all'
      ? allUsersCache
      : allUsersCache.filter(u => (u.role || 'student') === usersFilter);
    const filtered = baseFiltered.filter(u => !u.deleted);
    if (metaEl) metaEl.textContent = `${filtered.length} user${filtered.length !== 1 ? 's' : ''} · sorted by points`;
    if (!filtered.length) {
      el.innerHTML = '<div class="empty-state" style="padding:20px 24px">No users found.</div>';
      return;
    }
    el.innerHTML = filtered.map((u, i) => {
      const pts = u.points || 0;
      const role = u.role || 'student';
      const uid = u.id;
      const username = u.username || '—';
      const email = u.email || '—';
      const uidDisplay = uid.slice(0, 14) + '…';
      const avatarColor = u.avatarColor || '#a67c00';
      const initials = getInitials(u.username || u.email || '?');
      return `<div class="user-row" data-uid="${uid}">
        <span class="user-rank${i < 3 ? ' top' : ''}">${i + 1}</span>
        <div class="user-avatar-circle" style="background:${avatarColor}" aria-hidden="true">${initials}</div>
        <div class="user-info">
          <span class="user-uid">${username}</span>
          <span class="user-role${role === 'admin' ? ' admin' : ''}">${email}</span>
          <span class="user-uid-tiny">${uidDisplay}</span>
        </div>
        <div class="user-pts-col">
          <span class="user-pts-num">${pts.toLocaleString()}</span>
          <span class="user-pts-label">pts</span>
        </div>
        <button class="user-edit-btn" data-uid="${uid}">•••</button>
      </div>`;
    }).join('');
  };

  const qAllUsers = query(collection(db, 'users'));
  onSnapshot(qAllUsers, (snap) => {
    const items = [];
    snap.forEach(docu => items.push({ id: docu.id, ...docu.data() }));
    items.sort((a, b) => (b.points || 0) - (a.points || 0));
    allUsersCache = items;
    dashLeadersCache = items;
    renderDashLeaders();
    renderUsersTab();
    mailField.refresh();   // names/avatars resolve once the roster is in
  }, handleSnapshotError);

  document.getElementById('users')?.addEventListener('click', e => {
    const filterBtn = e.target.closest('.filter-btn');
    if (filterBtn) {
      usersFilter = filterBtn.dataset.filter;
      document.querySelectorAll('.filter-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.filter === usersFilter)
      );
      renderUsersTab();
      return;
    }
    const editBtn = e.target.closest('.user-edit-btn');
    if (editBtn) {
      openManageModal(editBtn.dataset.uid);
    }
  });

  // ── USER MANAGE MODAL ──────────────────────────────

  let manageUid = null;

  const openManageModal = (uid) => {
    const user = allUsersCache.find(u => u.id === uid);
    if (!user) return;
    manageUid = uid;

    const avatarEl = document.getElementById('manage-avatar');
    if (avatarEl) {
      avatarEl.textContent = getInitials(user.username || user.email || '?');
      avatarEl.style.background = user.avatarColor || '#a67c00';
    }
    const unameEl = document.getElementById('manage-username');
    if (unameEl) unameEl.textContent = user.username || '—';
    const emailEl = document.getElementById('manage-email');
    if (emailEl) emailEl.textContent = user.email || '';
    const ptsInput = document.getElementById('manage-pts-input');
    if (ptsInput) ptsInput.value = user.points || 0;

    const isAdmin = (user.role || 'student') === 'admin';
    const deleteBtn = document.getElementById('manage-delete-btn');

    if (deleteBtn) {
      deleteBtn.style.display = isAdmin ? 'none' : '';
      deleteBtn.disabled = false;
      deleteBtn.className = 'btn danger';
    }
    const adminDeleteBtn = document.getElementById('manage-admin-delete-btn');
    if (adminDeleteBtn) {
      adminDeleteBtn.style.display = isAdmin ? '' : 'none';
    }

    document.getElementById('user-manage-modal').hidden = false;
  };

  const closeManageModal = () => {
    const m = document.getElementById('user-manage-modal');
    if (m) m.hidden = true;
    manageUid = null;
  };

  document.getElementById('user-manage-close')?.addEventListener('click', closeManageModal);
  document.getElementById('user-manage-modal')?.addEventListener('click', e => {
    if (e.target === document.getElementById('user-manage-modal')) closeManageModal();
  });

  document.getElementById('manage-pts-save')?.addEventListener('click', async () => {
    if (!manageUid) return;
    const pts = Number(document.getElementById('manage-pts-input').value);
    if (isNaN(pts) || pts < 0) return;
    await setDoc(doc(db, 'users', manageUid), { points: pts }, { merge: true });
    const saveBtn = document.getElementById('manage-pts-save');
    if (saveBtn) { saveBtn.textContent = 'Saved!'; setTimeout(() => { saveBtn.textContent = 'Save Points'; }, 1400); }
  });

  document.getElementById('manage-delete-btn')?.addEventListener('click', async () => {
    if (!manageUid) return;
    const user = allUsersCache.find(u => u.id === manageUid);
    if ((user?.role || 'student') === 'admin') return;
    const name = user?.username || user?.email || manageUid;
    if (!confirm(`Permanently delete account for "${name}"?\n\nThis will erase all their data and cannot be undone.`)) return;

    const uid = manageUid;
    closeManageModal();

    // Delete all puzzle attempts by this user
    const attQ = query(collection(db, 'puzzleAttempts'), where('userId', '==', uid));
    const attSnap = await getDocs(attQ);
    await Promise.all(attSnap.docs.map(d => deleteDoc(doc(db, 'puzzleAttempts', d.id))));

    // Replace user doc with a tombstone so we can show the right message on login
    await setDoc(doc(db, 'users', uid), {
      deleted: true,
      deletedAt: Date.now()
    });
  });

  document.getElementById('manage-admin-delete-btn')?.addEventListener('click', async () => {
    if (!manageUid) return;
    const user = allUsersCache.find(u => u.id === manageUid);
    const name = user?.username || user?.email || manageUid;
    if (!confirm(`Delete admin account for "${name}" and ALL their data?\n\nThis cannot be undone.`)) return;
    const uid = manageUid;
    closeManageModal();
    const deleteFromCollection = async (col, field) => {
      const snap = await getDocs(query(collection(db, col), where(field, '==', uid)));
      await Promise.all(snap.docs.map(d => deleteDoc(doc(db, col, d.id))));
    };
    await Promise.all([
      deleteFromCollection('puzzleAttempts', 'userId'),
      deleteFromCollection('shopOrders', 'userId'),
      deleteFromCollection('attendanceResponses', 'userId'),
    ]);
    await setDoc(doc(db, 'users', uid), { deleted: true, deletedAt: Date.now() });
  });

  // ── ADMIN SHOP ────────────────────────────────────────────────────────────
  const compressImage = (file, maxDim = 320, quality = 0.72) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = ev => {
      const img = new Image();
      img.onload = () => {
        let { width: w, height: h } = img;
        if (w > h && w > maxDim) { h = Math.round(h * maxDim / w); w = maxDim; }
        else if (h >= w && h > maxDim) { w = Math.round(w * maxDim / h); h = maxDim; }
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject;
      img.src = ev.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

  let shopItemsAdminCache = [];
  let shopOrdersAdminCache = [];
  let shopOrdersAdminFilter = 'pending';
  let shopImgBase64Admin = null;
  let shopEditingId = null;

  const SVG_UPLOAD_INNER = `
    <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.5">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
    </svg>
    <div style="font-size:11px;margin-top:6px;opacity:0.6">Click to upload image</div>`;

  const shopImgPicker = document.getElementById('shop-img-picker');
  const shopImgFile = document.getElementById('shop-img-file');
  const shopImgInner = document.getElementById('shop-img-inner');
  const shopItemNameEl = document.getElementById('shop-item-name');
  const shopItemDescEl = document.getElementById('shop-item-desc');
  const shopItemQtyEl = document.getElementById('shop-item-qty');
  const shopItemCostEl = document.getElementById('shop-item-cost');
  const shopItemAddBtn = document.getElementById('shop-item-add');

  const resetShopModal = () => {
    shopEditingId = null;
    if (shopItemNameEl) shopItemNameEl.value = '';
    if (shopItemDescEl) shopItemDescEl.value = '';
    if (shopItemQtyEl) shopItemQtyEl.value = '';
    if (shopItemCostEl) shopItemCostEl.value = '';
    shopImgBase64Admin = null;
    const titleEl = document.getElementById('shop-modal-title');
    if (titleEl) titleEl.textContent = 'Add Shop Item';
    if (shopItemAddBtn) shopItemAddBtn.textContent = 'Add Item';
    if (shopImgInner) shopImgInner.innerHTML = SVG_UPLOAD_INNER;
  };
  const shopItemsGrid = document.getElementById('shop-items-grid');
  const shopItemsEmpty = document.getElementById('shop-items-empty');
  const shopOrdersList = document.getElementById('shop-orders-list');
  const shopOrdersEmpty = document.getElementById('shop-orders-empty');

  if (shopImgPicker && shopImgFile) {
    shopImgPicker.addEventListener('click', () => shopImgFile.click());
    shopImgFile.addEventListener('change', async () => {
      const file = shopImgFile.files[0];
      if (!file) return;
      shopImgBase64Admin = await compressImage(file);
      if (shopImgInner) shopImgInner.innerHTML = `<img src="${shopImgBase64Admin}" style="width:100%;height:100%;object-fit:cover;display:block;border-radius:4px">`;
    });
  }

  shopItemAddBtn?.addEventListener('click', async () => {
    const name = shopItemNameEl?.value.trim();
    const cost = parseInt(shopItemCostEl?.value, 10);
    if (!name || !cost || cost < 1) return;
    const rawStock = shopItemQtyEl?.value.trim();
    const stock = rawStock !== '' ? parseInt(rawStock, 10) : null;
    shopItemAddBtn.disabled = true;
    shopItemAddBtn.textContent = shopEditingId ? 'Saving…' : 'Adding…';
    const payload = {
      name,
      description: shopItemDescEl?.value.trim() || '',
      pointCost: cost,
      stock: (stock !== null && !isNaN(stock)) ? stock : null,
      imageBase64: shopImgBase64Admin || null,
    };
    if (shopEditingId) {
      await updateDoc(doc(db, 'shopItems', shopEditingId), payload);
    } else {
      await addDoc(collection(db, 'shopItems'), { ...payload, available: true, createdAt: Date.now() });
    }
    shopItemAddBtn.disabled = false;
    resetShopModal();
    document.getElementById('shop-add-modal').hidden = true;
  });

  const shopAddCardHtml = `
    <div class="shop-add-card" id="shop-add-card-btn">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
      </svg>
      <span class="shop-add-card-label">Add item</span>
    </div>`;

  const renderShopItemsAdmin = () => {
    if (!shopItemsGrid) return;
    if (shopItemsEmpty) shopItemsEmpty.hidden = true;
    shopItemsGrid.innerHTML = shopAddCardHtml + shopItemsAdminCache.map(item => {
      const qtyLabel = item.stock != null
        ? `<div style="font-size:10px;color:var(--text-2);margin-top:2px">${item.stock} in stock</div>`
        : `<div style="font-size:10px;color:var(--text-2);margin-top:2px">Unlimited</div>`;
      return `
        <div class="shop-item-card">
          ${item.imageBase64
            ? `<img class="shop-item-thumb" src="${item.imageBase64}" alt="">`
            : `<div class="shop-item-thumb-placeholder">🎁</div>`}
          <div class="shop-item-meta">
            <div class="shop-item-meta-name" title="${escHtml(item.name)}">${escHtml(item.name)}</div>
            <div class="shop-item-meta-cost">${item.pointCost} pts</div>
            ${qtyLabel}
            <div style="display:flex;gap:4px;margin-top:8px">
              <button class="btn subtle" style="flex:1;font-size:11px" data-edit-item="${item.id}">Edit</button>
              <button class="btn subtle danger" style="flex:1;font-size:11px" data-del-item="${item.id}">Remove</button>
            </div>
          </div>
        </div>`;
    }).join('');
  };

  shopItemsGrid?.addEventListener('click', async (e) => {
    if (e.target.closest('#shop-add-card-btn')) {
      resetShopModal();
      document.getElementById('shop-add-modal').hidden = false;
      return;
    }
    const editBtn = e.target.closest('[data-edit-item]');
    if (editBtn) {
      const item = shopItemsAdminCache.find(i => i.id === editBtn.dataset.editItem);
      if (!item) return;
      shopEditingId = item.id;
      if (shopItemNameEl) shopItemNameEl.value = item.name || '';
      if (shopItemDescEl) shopItemDescEl.value = item.description || '';
      if (shopItemQtyEl) shopItemQtyEl.value = item.stock ?? '';
      if (shopItemCostEl) shopItemCostEl.value = item.pointCost || '';
      shopImgBase64Admin = item.imageBase64 || null;
      const titleEl = document.getElementById('shop-modal-title');
      if (titleEl) titleEl.textContent = 'Edit Item';
      if (shopItemAddBtn) shopItemAddBtn.textContent = 'Save Changes';
      if (shopImgInner) shopImgInner.innerHTML = item.imageBase64
        ? `<img src="${item.imageBase64}" style="width:100%;height:100%;object-fit:cover;display:block;border-radius:4px">`
        : SVG_UPLOAD_INNER;
      document.getElementById('shop-add-modal').hidden = false;
      return;
    }
    const delBtn = e.target.closest('[data-del-item]');
    if (delBtn && confirm('Remove this item from the shop?'))
      await deleteDoc(doc(db, 'shopItems', delBtn.dataset.delItem));
  });

  document.getElementById('shop-add-close')?.addEventListener('click', () => {
    resetShopModal();
    document.getElementById('shop-add-modal').hidden = true;
  });

  const renderShopOrdersAdmin = () => {
    if (!shopOrdersList) return;
    const filtered = shopOrdersAdminFilter === 'all'
      ? shopOrdersAdminCache
      : shopOrdersAdminCache.filter(o => o.status === shopOrdersAdminFilter);
    if (!filtered.length) {
      shopOrdersList.innerHTML = '';
      if (shopOrdersEmpty) shopOrdersEmpty.hidden = false;
      return;
    }
    if (shopOrdersEmpty) shopOrdersEmpty.hidden = true;
    shopOrdersList.innerHTML = filtered.map(order => {
      const itemNames = (order.items || []).map(i => escHtml((i.qty > 1 ? `${i.qty}× ` : '') + i.name)).join(', ');
      const date = order.createdAt
        ? new Date(order.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
        : '';
      const actionHtml = order.status === 'pending' ? `
        <div class="order-actions">
          <button class="btn primary" style="font-size:12px;padding:5px 12px" data-verify-order="${order.id}">Verify</button>
          <button class="btn subtle danger" style="font-size:12px;padding:5px 12px" data-reject-order="${order.id}">Reject</button>
        </div>` : '';
      return `
        <div class="order-row">
          <div>
            <div class="order-user-name">${escHtml(order.username || order.userEmail || 'Student')}</div>
            <div class="order-items-list">${itemNames}</div>
            <div class="order-meta-row" style="margin-top:5px">
              <span class="order-cost-pill">${order.totalCost} pts</span>
              <span class="muted" style="font-size:11px">${date}</span>
            </div>
          </div>
          <span class="order-status-pill ${order.status}">${order.status}</span>
          ${actionHtml}
        </div>`;
    }).join('');
  };

  document.querySelectorAll('.shop-orders-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.shop-orders-filter').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      shopOrdersAdminFilter = btn.dataset.filter;
      renderShopOrdersAdmin();
    });
  });

  shopOrdersList?.addEventListener('click', async (e) => {
    const verifyBtn = e.target.closest('[data-verify-order]');
    const rejectBtn = e.target.closest('[data-reject-order]');
    if (verifyBtn) {
      const order = shopOrdersAdminCache.find(o => o.id === verifyBtn.dataset.verifyOrder);
      if (!order) return;
      verifyBtn.disabled = true; verifyBtn.textContent = '…';
      await updateDoc(doc(db, 'users', order.userId), { points: increment(-order.totalCost) });
      await Promise.all((order.items || []).map(item => {
        const shopItem = shopItemsAdminCache.find(s => s.id === item.id);
        if (shopItem?.stock != null && shopItem.stock > 0)
          return updateDoc(doc(db, 'shopItems', item.id), { stock: increment(-(item.qty || 1)) });
      }).filter(Boolean));
      await updateDoc(doc(db, 'shopOrders', verifyBtn.dataset.verifyOrder), { status: 'verified', verifiedAt: Date.now() });
    } else if (rejectBtn) {
      rejectBtn.disabled = true; rejectBtn.textContent = '…';
      await updateDoc(doc(db, 'shopOrders', rejectBtn.dataset.rejectOrder), { status: 'rejected', rejectedAt: Date.now() });
    }
  });

  onSnapshot(collection(db, 'shopItems'), snap => {
    shopItemsAdminCache = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    renderShopItemsAdmin();
  });

  onSnapshot(query(collection(db, 'shopOrders'), orderBy('createdAt', 'desc')), snap => {
    shopOrdersAdminCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderShopOrdersAdmin();
  });
  // ── END ADMIN SHOP ────────────────────────────────────────────────────────

  // ── ADMIN ATTENDANCE ──────────────────────────────────────────────────────
  const escAtt = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  let attSelectedEventId = null;
  let attQuestionsLocal = [];

  const attEventSelect    = document.getElementById('att-event-select');
  const attSetupBody      = document.getElementById('att-setup-body');
  const attPointsInput    = document.getElementById('att-points-input');
  const attQList          = document.getElementById('att-questions-list');
  const attSaveBtn        = document.getElementById('att-save-form-btn');
  const attAddQBtn        = document.getElementById('att-add-q-btn');
  const attNoEventMsg     = document.getElementById('att-no-event-msg');
  const attResponsesBody  = document.getElementById('att-responses-body');
  const attRespBadge      = document.getElementById('att-resp-badge');
  const attRespList       = document.getElementById('att-resp-list');
  const attRespEmpty      = document.getElementById('att-resp-empty');
  const attRespTitle      = document.getElementById('att-resp-title');
  const attRespDate       = document.getElementById('att-resp-date');

  const populateAttEventDropdown = () => {
    if (!attEventSelect) return;
    const cur = attSelectedEventId;
    attEventSelect.innerHTML = '<option value="">— Select an event —</option>' +
      [...eventsCache].sort((a, b) => b.date - a.date).map(ev =>
        `<option value="${ev.id}"${ev.id === cur ? ' selected' : ''}>${attEscOpt(ev.title || 'Event')} — ${new Date(ev.date).toLocaleDateString()}</option>`
      ).join('');
  };
  const attEscOpt = s => String(s).replace(/"/g,'&quot;').replace(/</g,'&lt;');

  const renderAttQuestionsAdmin = () => {
    if (!attQList) return;
    if (!attQuestionsLocal.length) {
      attQList.innerHTML = '<p style="font-size:12px;color:var(--text-2);margin:10px 0 6px">No extra questions yet. Click "+ Add" to add one.</p>';
      return;
    }
    attQList.innerHTML = attQuestionsLocal.map((q, i) => `
      <div class="adm-att-q-row">
        <input class="adm-att-q-input" type="text" value="${attEscOpt(q.text)}" placeholder="Question text…" data-q-edit="${i}" />
        <button class="adm-att-q-del" data-q-del="${i}" title="Remove">×</button>
      </div>`).join('');
  };

  const loadAttResponses = async (eventId) => {
    const snap = await getDocs(query(collection(db, 'attendanceResponses'), where('eventId', '==', eventId)));
    const responses = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.submittedAt || 0) - (b.submittedAt || 0));
    const memberCount = allUsersCache.filter(u => !u.deleted && u.role !== 'admin').length;
    if (attRespBadge) attRespBadge.textContent = `${responses.length} / ${memberCount || '?'} submitted`;
    if (attRespEmpty) attRespEmpty.hidden = responses.length > 0;
    if (!attRespList) return;
    if (!responses.length) { attRespList.innerHTML = ''; return; }
    const formSnap = await getDoc(doc(db, 'attendanceForms', eventId));
    const questions = formSnap.exists() ? (formSnap.data().questions || []) : [];
    attRespList.innerHTML = responses.map(r => {
      const answersHtml = questions.map(q => {
        const ans = (r.answers || []).find(a => a.questionId === q.id);
        return `<div class="adm-att-answer">
          <span class="adm-att-q-label">${escAtt(q.text)}</span>
          <span class="adm-att-a-text">${escAtt(ans?.text || '—')}</span>
        </div>`;
      }).join('');
      const time = r.submittedAt ? new Date(r.submittedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
      return `<div class="adm-att-resp-row">
        <div class="adm-att-resp-user">
          <span class="adm-att-resp-name">${escAtt(r.username || r.userEmail || 'User')}</span>
          <span class="adm-att-resp-time">${time}</span>
        </div>
        ${answersHtml}
      </div>`;
    }).join('');
  };

  const loadAttForm = async (eventId) => {
    const show = !!eventId;
    if (attSetupBody) attSetupBody.hidden = !show;
    if (attNoEventMsg) attNoEventMsg.hidden = show;
    if (attResponsesBody) attResponsesBody.hidden = !show;
    if (!show) return;
    const formSnap = await getDoc(doc(db, 'attendanceForms', eventId));
    if (formSnap.exists()) {
      const d = formSnap.data();
      if (attPointsInput) attPointsInput.value = d.points ?? 10;
      attQuestionsLocal = (d.questions || []).map(q => ({ ...q }));
    } else {
      if (attPointsInput) attPointsInput.value = '10';
      attQuestionsLocal = [];
    }
    renderAttQuestionsAdmin();
    const ev = eventsCache.find(e => e.id === eventId);
    if (attRespTitle) attRespTitle.textContent = ev?.title || 'Event';
    if (attRespDate) attRespDate.textContent = ev
      ? new Date(ev.date).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
      : '';
    loadAttResponses(eventId);
  };

  attEventSelect?.addEventListener('change', () => {
    attSelectedEventId = attEventSelect.value || null;
    loadAttForm(attSelectedEventId);
  });

  attAddQBtn?.addEventListener('click', () => {
    attQuestionsLocal.push({ id: `q_${Date.now()}`, text: '' });
    renderAttQuestionsAdmin();
    const inputs = attQList?.querySelectorAll('.adm-att-q-input');
    if (inputs?.length) inputs[inputs.length - 1].focus();
  });

  attQList?.addEventListener('input', e => {
    const idx = e.target.dataset.qEdit;
    if (idx != null) attQuestionsLocal[parseInt(idx)].text = e.target.value;
  });

  attQList?.addEventListener('click', e => {
    const btn = e.target.closest('[data-q-del]');
    if (!btn) return;
    attQuestionsLocal.splice(parseInt(btn.dataset.qDel), 1);
    renderAttQuestionsAdmin();
  });

  attSaveBtn?.addEventListener('click', async () => {
    if (!attSelectedEventId) return;
    attSaveBtn.disabled = true; attSaveBtn.textContent = 'Saving…';
    await setDoc(doc(db, 'attendanceForms', attSelectedEventId), {
      eventId: attSelectedEventId,
      points: parseFloat(attPointsInput?.value) || 10,
      questions: attQuestionsLocal.filter(q => q.text.trim()),
      updatedAt: Date.now()
    });
    attSaveBtn.disabled = false; attSaveBtn.textContent = 'Saved ✓';
    setTimeout(() => { if (attSaveBtn) attSaveBtn.textContent = 'Save Form'; }, 2000);
  });

  tabs.forEach(t => {
    if (t.dataset.tab === 'attendance') {
      t.addEventListener('click', () => {
        populateAttEventDropdown();
        if (attSelectedEventId) loadAttResponses(attSelectedEventId);
      });
    }
  });
  // ── END ADMIN ATTENDANCE ───────────────────────────────────────────────────

  if (logoutBtn) logoutBtn.addEventListener('click', () => signOut(auth));
}
