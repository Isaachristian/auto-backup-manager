async function appRequest(path, data) {
  const response = await fetch(path, data === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  });
  if (response.status === 401) {
    location.replace('/login');
    throw new Error('Your session expired. Please sign in again.');
  }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed.');
  return result;
}
appRequest('/api/me').then(user => {
  document.querySelector('#email').textContent = user.email;
}).catch(error => { document.querySelector('#message').textContent = error.message; });
document.querySelector('#logout').addEventListener('click', async () => {
  try {
    await appRequest('/api/logout', {});
    location.replace('/login');
  } catch (error) { document.querySelector('#message').textContent = error.message; }
});
if (document.querySelector('#backups')) {
  const button = document.querySelector('#run-backup');
  const message = document.querySelector('#message');
  let refreshing = false, starting = false, manualId;
  function renderBackups(backups) {
    document.querySelector('#loading').hidden = true;
    document.querySelector('#empty').hidden = backups.length > 0;
    document.querySelector('#history').hidden = backups.length === 0;
    const rows = backups.map(backup => {
      const row = document.createElement('tr');
      const size = backup.size_bytes == null ? '—' : backup.size_bytes < 1024 * 1024
        ? `${(backup.size_bytes / 1024).toFixed(1)} KiB` : `${(backup.size_bytes / (1024 * 1024)).toFixed(1)} MiB`;
      const cells = [new Date(backup.started_at).toLocaleString(), backup.database_name, backup.status,
        size, backup.duration_seconds == null ? '—' : `${backup.duration_seconds.toFixed(1)} s`, [backup.error || backup.object_key, backup.notification_error ? `Email: ${backup.notification_error}` : ''].filter(Boolean).join(' · ') || '—'];
      cells.forEach((value, index) => {
        const cell = document.createElement('td');
        cell.textContent = value;
        if (index === 2) cell.className = 'status-cell';
        row.append(cell);
      });
      return row;
    });
    document.querySelector('#backups').replaceChildren(...rows);
    const manual = backups.find(backup => backup.id === manualId);
    if (manual && manual.status !== 'running') {
      message.textContent = manual.status === 'completed' ? `Backup #${manual.id} completed and uploaded to object storage.` : `Backup #${manual.id} failed: ${manual.error || 'See history for details.'}`;
      manualId = undefined;
    }
  }
  async function refreshBackups() {
    if (refreshing) return;
    refreshing = true;
    try {
      const [history, status, settings] = await Promise.all([appRequest('/api/backups'), appRequest('/api/schedule'), appRequest('/api/settings')]);
      renderBackups(history.backups);
      button.disabled = starting || status.running;
      button.textContent = status.running ? 'Backup in progress…' : 'Run backup now';
      const schedule = settings.schedule;
      const next = status.nextRun ? new Intl.DateTimeFormat(undefined, { timeZone: schedule.timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(status.nextRun)) : 'No run in the next 366 days';
      document.querySelector('#backup-schedule').textContent = `${status.running ? 'Backup in progress. ' : ''}${schedule.enabled ? `Next backup: ${next} (${schedule.timeZone}).` : 'Scheduled backups are disabled. You can still run a backup now.'}`;
    } catch (error) {
      document.querySelector('#loading').hidden = true;
      message.textContent = `Unable to refresh backups. ${error.message}`;
    } finally { refreshing = false; }
  }
  button.addEventListener('click', async () => {
    starting = true;
    button.disabled = true;
    message.textContent = 'Starting backup…';
    try {
      const result = await appRequest('/api/backups/run', {});
      manualId = result.id;
      message.textContent = `Backup #${manualId} started. History will update automatically.`;
    } catch (error) { message.textContent = error.message; }
    finally {
      starting = false;
      await refreshBackups();
    }
  });
  void refreshBackups();
  setInterval(() => { if (!document.hidden) void refreshBackups(); }, 5000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshBackups(); });
}
