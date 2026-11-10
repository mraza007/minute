// Demo timestamps are computed from "now", so captures taken at different
// times of day would differ ("Today, 21:35" against "Today, 09:02") and the
// visual baselines would drift. The harness clock starts at a fixed local
// instant and then advances with real time, so polling loops still finish.
// Must be the first import in main.tsx: demoData.ts reads the clock when it loads.

const RealDate = Date
const HARNESS_START = new RealDate(2026, 10, 10, 10, 31, 0).getTime()
const realStart = RealDate.now()
const harnessNow = () => HARNESS_START + (RealDate.now() - realStart)

class HarnessDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(harnessNow())
    else super(...(args as [string | number | Date]))
  }

  static now(): number {
    return harnessNow()
  }
}

globalThis.Date = HarnessDate as DateConstructor
