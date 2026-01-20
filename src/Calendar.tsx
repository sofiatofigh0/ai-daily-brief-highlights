import { useMemo, useState } from "react";
import "./Calendar.css";

interface CalendarProps {
  availableDates: string[]; // Array of YYYY-MM-DD dates
  selectedDate: string;
  onDateSelect: (date: string) => void;
  disabled?: boolean;
}

export default function Calendar({
  availableDates,
  selectedDate,
  onDateSelect,
  disabled = false,
}: CalendarProps) {
  const [currentMonth, setCurrentMonth] = useState(() => {
    if (selectedDate) {
      return new Date(selectedDate + "T00:00:00");
    }
    if (availableDates.length > 0) {
      return new Date(availableDates[0] + "T00:00:00");
    }
    return new Date();
  });

  const availableDatesSet = useMemo(
    () => new Set(availableDates),
    [availableDates]
  );

  const monthYear = useMemo(() => {
    return currentMonth.toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
    });
  }, [currentMonth]);

  const days = useMemo(() => {
    const year = currentMonth.getFullYear();
    const month = currentMonth.getMonth();

    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);

    const startOffset = firstDay.getDay(); // 0 = Sunday
    const daysInMonth = lastDay.getDate();

    const calendarDays: Array<{
      day: number | null;
      date: string | null;
      isAvailable: boolean;
      isSelected: boolean;
      isToday: boolean;
    }> = [];

    // Add empty cells for days before the month starts
    for (let i = 0; i < startOffset; i++) {
      calendarDays.push({
        day: null,
        date: null,
        isAvailable: false,
        isSelected: false,
        isToday: false,
      });
    }

    // Add actual days of the month
    const today = new Date().toISOString().split("T")[0];

    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(
        day
      ).padStart(2, "0")}`;

      calendarDays.push({
        day,
        date: dateStr,
        isAvailable: availableDatesSet.has(dateStr),
        isSelected: dateStr === selectedDate,
        isToday: dateStr === today,
      });
    }

    return calendarDays;
  }, [currentMonth, availableDatesSet, selectedDate]);

  const handlePrevMonth = () => {
    setCurrentMonth(
      new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1)
    );
  };

  const handleNextMonth = () => {
    setCurrentMonth(
      new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1)
    );
  };

  const handleDateClick = (date: string | null) => {
    if (!date || disabled) return;
    if (availableDatesSet.has(date)) {
      onDateSelect(date);
    }
  };

  return (
    <div className="calendar">
      <div className="calendar-header">
        <button
          className="calendar-nav-btn"
          onClick={handlePrevMonth}
          disabled={disabled}
          aria-label="Previous month"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M10 12L6 8L10 4"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <div className="calendar-month-year">{monthYear}</div>
        <button
          className="calendar-nav-btn"
          onClick={handleNextMonth}
          disabled={disabled}
          aria-label="Next month"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M6 12L10 8L6 4"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      <div className="calendar-weekdays">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => (
          <div key={day} className="calendar-weekday">
            {day}
          </div>
        ))}
      </div>

      <div className="calendar-days">
        {days.map((dayInfo, idx) => (
          <button
            key={idx}
            className={`calendar-day ${
              dayInfo.day === null ? "calendar-day-empty" : ""
            } ${dayInfo.isAvailable ? "calendar-day-available" : ""} ${
              dayInfo.isSelected ? "calendar-day-selected" : ""
            } ${dayInfo.isToday ? "calendar-day-today" : ""}`}
            onClick={() => handleDateClick(dayInfo.date)}
            disabled={disabled || !dayInfo.isAvailable}
          >
            {dayInfo.day !== null && (
              <>
                <span className="calendar-day-number">{dayInfo.day}</span>
                {dayInfo.isSelected && <span className="calendar-day-dot" />}
              </>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
