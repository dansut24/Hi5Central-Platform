import { useMemo, useState } from 'react'
import { CalendarDays, ChevronRight, Search, Users, X } from 'lucide-react'

const dayDate = (value, opts = { weekday: 'short', day: 'numeric', month: 'short' }) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return value || ''
  const [y, m, d] = value.split('-').map(Number)
  return new Intl.DateTimeFormat('en-GB', opts).format(new Date(y, m - 1, d))
}
const initials = (name) => String(name || '').trim().split(/\s+/).slice(0, 2).map(part => part[0]?.toUpperCase()).join('') || '–'
const safePeople = (people) => (Array.isArray(people) ? people : []).filter(person => person?.id && person.name)

export function CalendarTeamSidebar({ people, teams, selectedIds, onChange, onClose }) {
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState([])
  const allPeople = useMemo(() => safePeople(people), [people])
  const groups = useMemo(() => {
    const byTeam = new Map()
    for (const person of allPeople) {
      const team = person.team || 'Other colleagues'
      if (!byTeam.has(team)) byTeam.set(team, [])
      byTeam.get(team).push(person)
    }
    const order = [...(teams || []).map(team => team.name).filter(name => byTeam.has(name))]
    for (const team of byTeam.keys()) if (!order.includes(team)) order.push(team)
    return order.map(team => ({ team, members: byTeam.get(team).sort((a,b) => a.name.localeCompare(b.name)) }))
  }, [allPeople, teams])
  const selected = new Set(selectedIds)
  const search = query.trim().toLowerCase()
  const addTeam = (ids) => {
    const next = [...selectedIds]
    ids.forEach(id => { if (!next.includes(id)) next.push(id) })
    onChange(next)
  }
  const removeTeam = (ids) => onChange(selectedIds.filter(id => !ids.includes(id)))
  return <aside className="calendar-team-sidebar" aria-label="Team calendars">
    <header className="calendar-team-sidebar-heading">
      <span><Users size={16}/><strong>Team calendars</strong></span>
      <button type="button" title="Hide calendars sidebar" aria-label="Hide calendars sidebar" onClick={onClose}><X size={16}/></button>
    </header>
    <p>Select colleagues to see their Hi5Central schedules side by side.</p>
    <label className="calendar-team-people-search"><Search size={15}/><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a colleague" aria-label="Find a colleague" /></label>
    <div className="calendar-team-select-meta"><span>{selectedIds.length} selected</span>{selectedIds.length ? <button type="button" onClick={() => onChange([])}>Clear all</button> : null}</div>
    <div className="calendar-team-groups">
      {groups.map(({team, members}) => {
        const visible = members.filter(person => !search || [person.name, person.team, person.role].join(' ').toLowerCase().includes(search))
        if (!visible.length) return null
        const memberIds = visible.map(person => person.id)
        const allSelected = memberIds.every(id => selected.has(id))
        const isCollapsed = collapsed.includes(team) && !search
        return <section key={team} className="calendar-team-group">
          <div className="calendar-team-group-heading">
            <button type="button" aria-expanded={!isCollapsed} aria-label={isCollapsed ? 'Expand '+team : 'Collapse '+team} onClick={() => setCollapsed(prev => prev.includes(team) ? prev.filter(item => item !== team) : [...prev, team])}><ChevronRight size={14} className={isCollapsed ? '' : 'is-expanded'} /><strong>{team}</strong><small>{members.length}</small></button>
            <button type="button" className="calendar-team-select-team" title={allSelected ? 'Remove this team' : 'Add this team'} onClick={() => allSelected ? removeTeam(memberIds) : addTeam(memberIds)}>{allSelected ? 'Remove' : 'Add all'}</button>
          </div>
          {!isCollapsed ? <div className="calendar-team-member-list">{visible.map(person =>
            <label key={person.id} className={selected.has(person.id) ? 'is-selected' : ''}>
              <input type="checkbox" checked={selected.has(person.id)} onChange={event => event.target.checked ? addTeam([person.id]) : removeTeam([person.id])}/>
              <span className="calendar-team-avatar" aria-hidden="true">{person.initials || initials(person.name)}</span>
              <span className="calendar-team-member-name"><strong>{person.name}</strong><small>{person.role || team}</small></span>
            </label>)}</div> : null}
        </section>
      })}
      {!groups.length ? <p className="calendar-team-empty">No team members available.</p> : null}
      {groups.length > 0 && search && !groups.some(group => group.members.some(person => [person.name,person.team,person.role].join(' ').toLowerCase().includes(search))) ? <p className="calendar-team-empty">No matching colleagues.</p> : null}
    </div>
  </aside>
}

export function CalendarPersonLane({ person, events, period, view, selectedDate, conflicts, onOpen, onRemove }) {
  // Calendar entries are already retrieved with the session's existing access.
  // Never manufacture availability, attendee access, or external Outlook data.
  const matching = useMemo(() => {
    const name = String(person.name || '').trim().toLowerCase()
    return events.filter(event => (event.personId === person.id || (!event.personId && String(event.personName || '').trim().toLowerCase() === name)) && event.date >= period.start && event.date <= period.end)
      .sort((a,b) => (a.date + 'T' + (a.start || '00:00')).localeCompare(b.date + 'T' + (b.start || '00:00')))
  }, [events,person.id,person.name,period.start,period.end])
  const days = view === 'day' ? [selectedDate] : view === 'week' ? period.days : view === 'month'
    ? [...new Set(matching.map(event => event.date).concat(selectedDate >= period.start && selectedDate <= period.end ? [selectedDate] : []))].sort()
    : [...new Set(matching.map(event => event.date))]
  const grouped = new Map()
  for (const event of matching) { const items = grouped.get(event.date) || []; items.push(event); grouped.set(event.date,items) }
  return <section className="calendar-person-lane" aria-label={person.name+' calendar'}>
    <header className="calendar-person-lane-header">
      <span className="calendar-team-avatar" aria-hidden="true">{person.initials || initials(person.name)}</span>
      <div><strong>{person.name}</strong><small>{person.team || 'Colleague'} · {matching.length} item{matching.length === 1 ? '' : 's'}</small></div>
      <button type="button" aria-label={'Remove '+person.name+' calendar'} title="Remove calendar" onClick={() => onRemove(person.id)}><X size={15}/></button>
    </header>
    <div className="calendar-person-lane-content">
      {days.length ? days.map(date => <section key={date} className={date === selectedDate ? 'is-selected-date' : ''}>
        <header><CalendarDays size={13}/><strong>{dayDate(date)}</strong>{date === selectedDate ? <small>Selected</small> : null}</header>
        {(grouped.get(date) || []).length ? grouped.get(date).map(event => {
          // Do not expose a personal sickness/absence reason in team comparison.
          const absence = event.source === 'rota' && ['Sickness','Leave','Unavailable'].includes(event.kind)
          const label = absence ? 'Unavailable' : event.title
          return <button key={event.id} type="button" className={`calendar-person-event source-${event.source}${conflicts.has(event.id) ? ' has-conflict' : ''}`} title={(event.allDay ? 'All day' : event.start || 'Time TBC') + ' · ' + label} onClick={() => { if (!absence) onOpen(event) }} disabled={absence}>
            <span className="calendar-person-event-time">{event.allDay ? 'All day' : event.start || 'TBC'}</span>
            <strong>{label}</strong>
            <small>{absence ? 'Availability' : event.sourceLabel || event.kind || 'Calendar'}</small>
          </button>
        }) : <div className="calendar-person-empty-day">Nothing scheduled</div>}
      </section>) : <div className="calendar-person-empty-range"><CalendarDays size={21}/><strong>Nothing scheduled</strong><span>No matching items for this period.</span></div>}
    </div>
  </section>
}
