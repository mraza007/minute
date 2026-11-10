export type SortOrder = 'newest' | 'oldest' | 'duration' | 'title'
export type StatusFilter = 'all' | 'pinned' | 'ready' | 'transcribed' | 'recording'
export type SourceFilter = 'all' | 'mic' | 'system'
export type DateFilter = 'all' | 'today' | 'week'

export interface LibraryFilters {
  sort: SortOrder
  status: StatusFilter
  source: SourceFilter
  date: DateFilter
}

export const DEFAULT_FILTERS: LibraryFilters = { sort: 'newest', status: 'all', source: 'all', date: 'all' }

export interface FilterSection<K extends keyof LibraryFilters> {
  key: K
  label: string
  options: readonly { value: LibraryFilters[K]; label: string }[]
}

export const FILTER_SECTIONS: readonly [
  FilterSection<'sort'>,
  FilterSection<'status'>,
  FilterSection<'source'>,
  FilterSection<'date'>,
] = [
  {
    key: 'sort',
    label: 'Sort',
    options: [
      { value: 'newest', label: 'Newest first' },
      { value: 'oldest', label: 'Oldest first' },
      { value: 'duration', label: 'Longest first' },
      { value: 'title', label: 'Title A–Z' },
    ],
  },
  {
    key: 'status',
    label: 'Show',
    options: [
      { value: 'all', label: 'All notes' },
      { value: 'pinned', label: 'Pinned' },
      { value: 'ready', label: 'Summarized' },
      { value: 'transcribed', label: 'Needs summary' },
      { value: 'recording', label: 'Recording' },
    ],
  },
  {
    key: 'source',
    label: 'Source',
    options: [
      { value: 'all', label: 'Any source' },
      { value: 'mic', label: 'Microphone' },
      { value: 'system', label: 'System audio' },
    ],
  },
  {
    key: 'date',
    label: 'Date',
    options: [
      { value: 'all', label: 'Any date' },
      { value: 'today', label: 'Past 24 hours' },
      { value: 'week', label: 'Last 7 days' },
    ],
  },
]

export function isFiltering(filters: LibraryFilters): boolean {
  return FILTER_SECTIONS.some(section => filters[section.key] !== DEFAULT_FILTERS[section.key])
}

/** Whether Show, Source, or Date hides any notes. Sort only reorders them. */
export function hidesNotes(filters: LibraryFilters): boolean {
  return filters.status !== 'all' || filters.source !== 'all' || filters.date !== 'all'
}

/** Every note again, in the same order. */
export function clearFilters(filters: LibraryFilters): LibraryFilters {
  return { ...DEFAULT_FILTERS, sort: filters.sort }
}
