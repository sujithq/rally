const dateFormatter = new Intl.DateTimeFormat('en', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
})

const longDateFormatter = new Intl.DateTimeFormat('en', {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
})

export function toDateKey(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function fromDateKey(dateKey: string) {
  const [year, month, day] = dateKey.split('-').map(Number)
  return new Date(year, month - 1, day, 12)
}

export function formatDate(dateKey: string) {
  return dateFormatter.format(fromDateKey(dateKey))
}

export function formatLongDate(dateKey: string) {
  return longDateFormatter.format(fromDateKey(dateKey))
}

export function formatTime(time: string) {
  if (!time) return 'Any time'
  const [hours, minutes] = time.split(':').map(Number)
  return new Intl.DateTimeFormat('en', {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(2020, 0, 1, hours, minutes))
}