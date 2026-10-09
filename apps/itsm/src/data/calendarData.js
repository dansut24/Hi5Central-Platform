// Use the workstation's calendar date, not UTC (which can be tomorrow or
// yesterday near midnight in the user's timezone).
const today = new Date()
export const CALENDAR_TODAY = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`

export const calendarEventTypes = [
  'Meeting',
  'Reminder',
  'Focus time',
  'Maintenance',
  'Other',
]
