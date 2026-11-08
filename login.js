const $ = selector => document.querySelector(selector);
let state;
async function api(path, data) {
  const response = await fetch(path, data === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed.');
  return result;
}
async function render() {
  const status = await api('/api/status');
  state = status.state;
  if (state === 'authenticated') return location.replace('/app');
  $('#credentials').hidden = state === 'verify';
  $('#setup').hidden = state !== 'verify';
  $('#login-code').hidden = state !== 'login';
  $('#code').required = state === 'login';
  $('#password').minLength = state === 'register' ? 12 : 1;
  $('#password').autocomplete = state === 'register' ? 'new-password' : 'current-password';
  $('#title').textContent = { register: 'Create your account', verify: 'Set up two-factor authentication', login: 'Sign in' }[state];
  $('#intro').hidden = state === 'login';
  $('#intro').textContent = {
    register: 'Create the owner account to get started. Use a password of at least 12 characters.',
    verify: 'Add Auto Backup Manager to an authenticator such as Google Authenticator, Microsoft Authenticator, or 2FAS. Setup expires after 15 minutes.',
    login: 'Sign in with your email, password, and authenticator code.',
  }[state];
  $('#submit').textContent = state === 'register' ? 'Create account' : 'Sign in';
  if (state === 'verify') {
    $('#authenticator').href = status.uri;
    $('#secret').textContent = status.secret;
    $('#verify-code').focus();
  } else {
    $('#secret').textContent = '';
    $('#authenticator').removeAttribute('href');
  }
}
async function submit(event, action) {
  event.preventDefault();
  const button = event.target.querySelector('button');
  button.disabled = true;
  $('#message').textContent = '';
  try { await action(); } catch (error) { $('#message').textContent = error.message; }
  finally { button.disabled = false; }
}
$('#credentials').addEventListener('submit', event => submit(event, async () => {
  const data = Object.fromEntries(new FormData(event.target));
  if (state === 'register') {
    await api('/api/setup', data);
    $('#password').value = '';
    await render();
  } else {
    await api('/api/login', data);
    location.replace('/app');
  }
}));
$('#verify').addEventListener('submit', event => submit(event, async () => {
  await api('/api/setup/confirm', Object.fromEntries(new FormData(event.target)));
  event.target.reset();
  await render();
  $('#message').textContent = 'Account created. Wait for the next authenticator code, then log in.';
}));
render().catch(error => { $('#message').textContent = error.message; });
