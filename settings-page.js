function fillSettings(form, settings) {
  for (const [key, value] of Object.entries(settings)) {
    const input = form.elements.namedItem(key);
    if (!input) continue;
    if (input.type === 'checkbox') input.checked = value;
    else input.value = value;
  }
  for (const hint of form.querySelectorAll('[data-secret-hint]')) {
    const key = hint.dataset.secretHint;
    const input = form.elements.namedItem(key);
    input.value = '';
    input.placeholder = settings[`${key}Configured`] ? 'Saved — leave blank to keep' : 'Not configured';
    hint.textContent = settings[`${key}Configured`] ? 'A credential is saved. Enter a new value to replace it.' : 'No credential saved.';
    form.elements.namedItem(`clear_${key}`).checked = false;
  }
}
async function showSchedule(settings) {
  const status = await appRequest('/api/schedule');
  const text = !settings.enabled ? 'Scheduled backups are disabled.' : status.nextRun
    ? `Next backup: ${new Intl.DateTimeFormat(undefined, { timeZone: settings.timeZone, dateStyle: 'full', timeStyle: 'short' }).format(new Date(status.nextRun))} (${settings.timeZone}).`
    : 'No matching run in the next 366 days. Check the cron expression.';
  document.querySelector('#schedule-status').textContent = text + (status.running ? ' A backup is currently running.' : '');
}
appRequest('/api/settings').then(async settings => {
  for (const form of document.querySelectorAll('.settings-form')) fillSettings(form, settings[form.dataset.section]);
  document.querySelector('#settings-forms').hidden = false;
  document.querySelector('#message').textContent = '';
  await showSchedule(settings.schedule);
}).catch(error => { document.querySelector('#message').textContent = `Unable to load settings. ${error.message}`; });
function formSettings(form) {
  const settings = {};
  for (const input of form.elements) {
    if (!input.name) continue;
    settings[input.name] = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
  }
  return settings;
}
async function perform(form, action) {
  if (!form.reportValidity()) return;
  const controls = [...form.querySelectorAll('button, input, select')];
  const settings = formSettings(form);
  const message = form.querySelector('.form-status');
  controls.forEach(control => { control.disabled = true; });
  message.textContent = action === 'save' ? 'Saving…' : action === 'email' ? 'Sending test email…' : 'Checking connection…';
  try {
    if (action === 'save') {
      await appRequest('/api/settings', { section: form.dataset.section, settings });
      const saved = await appRequest('/api/settings');
      fillSettings(form, saved[form.dataset.section]);
      message.textContent = 'Settings saved.';
      if (form.dataset.section === 'schedule') await showSchedule(saved.schedule);
    } else {
      const result = await appRequest(action === 'email' ? '/api/settings/test-email' : '/api/settings/check', { section: form.dataset.section, settings });
      message.textContent = result.message + ' Changes are not saved until you select Save.';
    }
  } catch (error) { message.textContent = error.message; }
  finally { controls.forEach(control => { control.disabled = false; }); }
}
for (const form of document.querySelectorAll('.settings-form')) {
  form.addEventListener('submit', event => { event.preventDefault(); void perform(form, 'save'); });
  for (const button of form.querySelectorAll('[data-check]')) button.addEventListener('click', () => { void perform(form, 'check'); });
  form.querySelector('[data-test-email]')?.addEventListener('click', () => { void perform(form, 'email'); });
}
