import { useEffect, useState } from 'react'

const CHECK_INTERVAL_MS = 60_000

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/**
 * A `Date` inside the current local calendar day. Its identity changes only
 * when the day changes, so it is safe as a memo dependency for anything
 * bucketed by day (the sidebar's Today / Yesterday groups).
 *
 * A window left open overnight must notice midnight on its own (issue #44).
 * It polls instead of arming one timer for midnight because timers stop
 * while the Mac sleeps; the focus and visibility listeners cover the moment
 * the user comes back.
 */
export function useToday(): Date {
  const [today, setToday] = useState(() => new Date())

  useEffect(() => {
    const check = () => {
      setToday(prev => {
        const now = new Date()
        return sameLocalDay(prev, now) ? prev : now
      })
    }
    const timer = window.setInterval(check, CHECK_INTERVAL_MS)
    window.addEventListener('focus', check)
    document.addEventListener('visibilitychange', check)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', check)
      document.removeEventListener('visibilitychange', check)
    }
  }, [])

  return today
}
