import { useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { formatLongDate, toDateKey } from './date'

const weekDays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

interface CalendarPickerProps {
  selectedDates: string[]
  maxDates: number | null
  onToggle: (date: string) => void
}

function isSameMonth(left: Date, right: Date) {
  return left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth()
}

export default function CalendarPicker({ selectedDates, maxDates, onToggle }: CalendarPickerProps) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const firstAvailableMonth = new Date(today.getFullYear(), today.getMonth(), 1)
  const [visibleMonth, setVisibleMonth] = useState(firstAvailableMonth)
  const monthLabel = new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric' }).format(visibleMonth)
  const firstWeekday = (visibleMonth.getDay() + 6) % 7
  const daysInMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + 1, 0).getDate()
  const cells = Array.from({ length: 42 }, (_, index) => {
    const dayNumber = index - firstWeekday + 1
    if (dayNumber < 1 || dayNumber > daysInMonth) return null
    return new Date(visibleMonth.getFullYear(), visibleMonth.getMonth(), dayNumber)
  })
  const previousDisabled = isSameMonth(visibleMonth, firstAvailableMonth)
  const atLimit = maxDates !== null && selectedDates.length >= maxDates

  const moveMonth = (offset: number) => {
    setVisibleMonth((current) => new Date(current.getFullYear(), current.getMonth() + offset, 1))
  }

  return (
    <div className="calendar" aria-label="Date picker">
      <div className="calendar-header">
        <button
          className="icon-button"
          type="button"
          onClick={() => moveMonth(-1)}
          disabled={previousDisabled}
          aria-label="Previous month"
          title="Previous month"
        >
          <ChevronLeft size={19} />
        </button>
        <strong>{monthLabel}</strong>
        <button
          className="icon-button"
          type="button"
          onClick={() => moveMonth(1)}
          aria-label="Next month"
          title="Next month"
        >
          <ChevronRight size={19} />
        </button>
      </div>

      <div className="calendar-grid calendar-weekdays" aria-hidden="true">
        {weekDays.map((day) => <span key={day}>{day}</span>)}
      </div>
      <div className="calendar-grid calendar-days">
        {cells.map((date, index) => {
          if (!date) return <span className="calendar-empty" key={`empty-${index}`} />
          const dateKey = toDateKey(date)
          const isSelected = selectedDates.includes(dateKey)
          const isPast = date < today
          const disabled = isPast || (atLimit && !isSelected)

          return (
            <button
              className={`calendar-day${isSelected ? ' selected' : ''}${dateKey === toDateKey(today) ? ' today' : ''}`}
              type="button"
              key={dateKey}
              disabled={disabled}
              onClick={() => onToggle(dateKey)}
              aria-label={formatLongDate(dateKey)}
              aria-pressed={isSelected}
            >
              {date.getDate()}
            </button>
          )
        })}
      </div>
    </div>
  )
}