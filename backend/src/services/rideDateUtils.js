function getRepeatDates({ date, repeat }) {
  const dates = [];
  const firstDate = new Date(`${date}T00:00:00.000Z`);
  const lastDate = repeat ? new Date(`${repeat.until}T00:00:00.000Z`) : firstDate;
  const weekdays = new Set(repeat?.weekdays ?? []);

  for (let current = new Date(firstDate); current <= lastDate; current.setUTCDate(current.getUTCDate() + 1)) {
    const weekday = current.getUTCDay() || 7;
    if (!repeat || weekdays.has(weekday)) dates.push(current.toISOString().slice(0, 10));
  }

  return dates;
}

module.exports = { getRepeatDates };
