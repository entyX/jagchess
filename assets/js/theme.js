const key = 'theme';
const root = document.documentElement;
const btn = document.getElementById('theme-toggle');
const initial = localStorage.getItem(key) || 'light';
root.setAttribute('data-theme', initial);
if (btn) {
  btn.addEventListener('click', () => {
    const next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    root.setAttribute('data-theme', next);
    localStorage.setItem(key, next);
  });
}

/* For menus that offer the switch themselves rather than a toggle button. */
export function toggleTheme() {
  const next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  root.setAttribute('data-theme', next);
  localStorage.setItem(key, next);
  return next;
}

export const currentTheme = () => root.getAttribute('data-theme') || 'light';
