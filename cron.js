const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
export function parseCron(expression) {
  if (typeof expression !== 'string' || expression.length > 100) throw new Error('Enter a five-field cron expression.');
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('Use five cron fields: minute hour day month weekday.');
  return fields.map((field, index) => {
    const [min, max] = ranges[index];
    const values = new Set();
    for (const part of field.split(',')) {
      const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
      if (!match) throw new Error('Cron supports numbers, *, lists, ranges, and steps.');
      const step = match[2] === undefined ? 1 : Number(match[2]);
      const pieces = match[1].split('-').map(Number);
      const start = match[1] === '*' ? min : pieces[0];
      const end = match[1] === '*' ? max : pieces[1] ?? (match[2] ? max : start);
      if (start < min || end > max || start > end || step < 1 || step > max - min + 1) throw new Error(`Cron field ${index + 1} is out of range.`);
      for (let value = start; value <= end; value += step) values.add(index === 4 && value === 7 ? 0 : value);
    }
    return { values, wildcard: field.startsWith('*') };
  });
}
export function clock(timeZone) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' });
  } catch { throw new Error('Enter a valid IANA timezone, such as America/Chicago.'); }
}
export function localTime(date, formatter) {
  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  return { minute: +parts.minute, hour: +parts.hour, day: +parts.day, month: +parts.month,
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday),
    key: `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}` };
}
export function matchesCron(fields, local) {
  const [minute, hour, day, month, weekday] = fields;
  const dom = day.values.has(local.day), dow = weekday.values.has(local.weekday);
  const dayMatches = day.wildcard || weekday.wildcard ? dom && dow : dom || dow;
  return minute.values.has(local.minute) && hour.values.has(local.hour) && month.values.has(local.month) && dayMatches;
}
export function nextRun(expression, timeZone, after = new Date()) {
  const fields = parseCron(expression), formatter = clock(timeZone);
  let candidate = Math.floor(after.getTime() / 60000) * 60000 + 60000;
  const end = candidate + 366 * 86400000;
  while (candidate < end) {
    const date = new Date(candidate), local = localTime(date, formatter);
    if (matchesCron(fields, local)) return date.toISOString();
    let minutes = 1;
    // Skip minutes that cannot match; timezone transitions still get evaluated.
    while (minutes < 60 && !fields[0].values.has((local.minute + minutes) % 60)) minutes++;
    candidate += minutes * 60000;
  }
  return null;
}
