const { chromium } = require('c:/Users/entyt/Downloads/Chess Club/node_modules/playwright');
const OUT='C:/Users/entyt/AppData/Local/Temp/claude/c--Users-entyt-Downloads-Chess-Club/698d1c48-7c9c-492f-81dc-1e09e248f990/scratchpad/';
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 800 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.route('**/firebasejs/**', r => r.abort());
  await p.goto('http://localhost:4321/admin/dashboard.html', { waitUntil: 'networkidle' });
  await p.waitForTimeout(900);
  await p.evaluate(() => {
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    document.getElementById('events').classList.add('active');
    const g = document.getElementById('calendar-grid');
    let h=''; for (let i=0;i<35;i++) h += `<div class="day-cell"><div class="day-num">${i+1}</div><div class="day-events">${i===13?'<button class="event-pill tag-tournament">Championship</button>':''}</div></div>`;
    g.innerHTML = h;
  });
  await p.waitForTimeout(400);
  // open the custom dropdown
  await p.click('#ev-tag + .jc-select-btn, .jc-select .jc-select-btn');
  await p.waitForTimeout(400);
  await p.screenshot({ path: OUT + 'fix-select.png' });
  const val = await p.evaluate(() => {
    document.querySelectorAll('.jc-select-opt')[2].click();
    return document.getElementById('ev-tag').value;
  });
  console.log('select value after choosing 3rd option:', val);

  // scroll containment: page must not scroll, .app-main must
  await p.evaluate(() => {
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    document.getElementById('news').classList.add('active');
  });
  await p.waitForTimeout(300);
  const scroll = await p.evaluate(() => {
    const m = document.querySelector('.app-main');
    m.scrollTop = 99999;
    return { bodyScrollable: document.documentElement.scrollHeight > window.innerHeight + 2, mainScrolled: m.scrollTop > 10, sidebarBottom: document.querySelector('.sidebar').getBoundingClientRect().bottom, vh: window.innerHeight };
  });
  console.log('scroll:', JSON.stringify(scroll));
  await p.screenshot({ path: OUT + 'fix-scroll.png' });

  // puzzles board frame
  await p.goto('http://localhost:4321/student/dashboard.html', { waitUntil: 'networkidle' });
  await p.waitForTimeout(600);
  await p.evaluate(() => {
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    document.getElementById('puzzles').classList.add('active');
    const b = document.getElementById('student-board');
    // fake an 8x8 board like chessboard.js renders
    let h = '<div class="board-b72b1" style="display:grid;grid-template-columns:repeat(8,1fr);width:100%;aspect-ratio:1">';
    for (let r=0;r<8;r++) for (let c=0;c<8;c++) h += `<div class="${(r+c)%2?'black-3c85d':'white-1e1d7'}" style="aspect-ratio:1"></div>`;
    b.innerHTML = h + '</div>';
  });
  await p.waitForTimeout(400);
  await p.screenshot({ path: OUT + 'fix-board.png' });
  console.log('ERRORS:', JSON.stringify(errs));
  await b.close();
})();
