fetch('/api/me').then(async response => {
  if (!response.ok) return location.replace('/login');
  document.querySelector('#email').textContent = (await response.json()).email;
}).catch(() => { document.querySelector('#message').textContent = 'Unable to load your account. Refresh to try again.'; });
document.querySelector('#logout').addEventListener('click', async () => {
  try {
    const response = await fetch('/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!response.ok) throw new Error();
    location.replace('/login');
  } catch { document.querySelector('#message').textContent = 'Unable to log out. Please try again.'; }
});
