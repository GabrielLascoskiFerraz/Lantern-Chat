import { createHash } from 'node:crypto';

export interface CalendarAutomationEvent {
  id: string;
  title: string;
  description: string;
  location: string;
  start: number;
  end: number;
  allDay: boolean;
}

interface ParsedEvent {
  uid: string;
  title: string;
  description: string;
  location: string;
  start: Date;
  end: Date;
  allDay: boolean;
  rrule: Record<string, string>;
  excludedDates: Set<string>;
}

const MAX_ICS_BYTES = 5 * 1024 * 1024;
const dateKey = (date: Date): string => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const unescapeText = (value: string): string => value.replace(/\\[nN]/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\').trim();
const parseRule = (value: string): Record<string, string> => Object.fromEntries(value.split(';').map((part) => part.split('=', 2)).filter((entry) => entry[0]));

const parseIcsDate = (value: string, params = ''): { date: Date; allDay: boolean } | null => {
  const allDay = /(?:^|;)VALUE=DATE(?:;|$)/i.test(params) || /^\d{8}$/.test(value);
  const match = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?(Z)?$/);
  if (!match) return null;
  const [, year, month, day, hour = '0', minute = '0', second = '0', utc] = match;
  const parts = [year, Number(month) - 1, day, hour, minute, second].map(Number);
  const timestamp = utc ? Date.UTC(parts[0], parts[1], parts[2], parts[3], parts[4], parts[5]) : new Date(parts[0], parts[1], parts[2], parts[3], parts[4], parts[5]).getTime();
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? { date, allDay } : null;
};

const eventOccursOn = (event: ParsedEvent, day: Date): Date | null => {
  const target = new Date(day.getFullYear(), day.getMonth(), day.getDate(), event.start.getHours(), event.start.getMinutes(), event.start.getSeconds());
  if (target < event.start || event.excludedDates.has(dateKey(target))) return null;
  if (!Object.keys(event.rrule).length) return dateKey(event.start) === dateKey(day) ? event.start : null;
  const interval = Math.max(1, Number(event.rrule.INTERVAL) || 1);
  const dayDiff = Math.floor((new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime() - new Date(event.start.getFullYear(), event.start.getMonth(), event.start.getDate()).getTime()) / 86_400_000);
  const until = event.rrule.UNTIL ? parseIcsDate(event.rrule.UNTIL)?.date : null;
  if (until && target > until) return null;
  switch ((event.rrule.FREQ || '').toUpperCase()) {
    case 'DAILY': return dayDiff >= 0 && dayDiff % interval === 0 ? target : null;
    case 'WEEKLY': {
      const weekdays = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
      const allowed = (event.rrule.BYDAY || weekdays[event.start.getDay()]).split(',').map((item) => item.slice(-2));
      return Math.floor(dayDiff / 7) % interval === 0 && allowed.includes(weekdays[target.getDay()]) ? target : null;
    }
    case 'MONTHLY': {
      const months = (target.getFullYear() - event.start.getFullYear()) * 12 + target.getMonth() - event.start.getMonth();
      return months >= 0 && months % interval === 0 && target.getDate() === event.start.getDate() ? target : null;
    }
    case 'YEARLY': return (target.getFullYear() - event.start.getFullYear()) % interval === 0 && target.getMonth() === event.start.getMonth() && target.getDate() === event.start.getDate() ? target : null;
    default: return null;
  }
};

export const parseCalendarEventsForDay = (ics: string, day = new Date()): CalendarAutomationEvent[] => {
  const lines = ics.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const events: ParsedEvent[] = [];
  let values: Record<string, { value: string; params: string }[]> | null = null;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === 'BEGIN:VEVENT') { values = {}; continue; }
    if (line === 'END:VEVENT') {
      if (values) {
        const startValue = values.DTSTART?.[0]; const parsedStart = startValue && parseIcsDate(startValue.value, startValue.params);
        if (parsedStart) {
          const endValue = values.DTEND?.[0]; const parsedEnd = endValue && parseIcsDate(endValue.value, endValue.params);
          events.push({
            uid: values.UID?.[0]?.value || createHash('sha256').update(JSON.stringify(values)).digest('hex'),
            title: unescapeText(values.SUMMARY?.[0]?.value || 'Compromisso sem título'),
            description: unescapeText(values.DESCRIPTION?.[0]?.value || ''), location: unescapeText(values.LOCATION?.[0]?.value || ''),
            start: parsedStart.date, end: parsedEnd?.date || new Date(parsedStart.date.getTime() + (parsedStart.allDay ? 86_400_000 : 3_600_000)), allDay: parsedStart.allDay,
            rrule: parseRule(values.RRULE?.[0]?.value || ''),
            excludedDates: new Set((values.EXDATE || []).flatMap((entry) => entry.value.split(',')).map((item) => parseIcsDate(item)?.date).filter((item): item is Date => Boolean(item)).map(dateKey))
          });
        }
      }
      values = null; continue;
    }
    if (!values) continue;
    const separator = line.indexOf(':'); if (separator < 1) continue;
    const left = line.slice(0, separator); const [name, ...params] = left.split(';');
    const key = name.toUpperCase(); (values[key] ||= []).push({ value: line.slice(separator + 1), params: params.join(';') });
  }
  return events.flatMap((event) => {
    const occurrence = eventOccursOn(event, day); if (!occurrence) return [];
    const duration = Math.max(0, event.end.getTime() - event.start.getTime());
    return [{ id: createHash('sha256').update(`${event.uid}\0${occurrence.toISOString()}`).digest('hex'), title: event.title, description: event.description, location: event.location, start: occurrence.getTime(), end: occurrence.getTime() + duration, allDay: event.allDay }];
  }).sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
};

export const fetchCalendarEventsForDay = async (urlValue: string, day = new Date()): Promise<CalendarAutomationEvent[]> => {
  const url = new URL(urlValue);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('O calendário deve usar uma URL HTTP ou HTTPS.');
  const response = await fetch(url, { headers: { 'user-agent': 'Lantern-Relay/1.0', accept: 'text/calendar,*/*;q=0.8' }, signal: AbortSignal.timeout(15_000) });
  if (!['http:', 'https:'].includes(new URL(response.url).protocol)) throw new Error('O calendário redirecionou para um endereço não permitido.');
  if (!response.ok) throw new Error(`O calendário respondeu com HTTP ${response.status}.`);
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_ICS_BYTES) throw new Error('O calendário excede 5 MB.');
  const ics = await response.text();
  if (Buffer.byteLength(ics, 'utf8') > MAX_ICS_BYTES) throw new Error('O calendário excede 5 MB.');
  if (!ics.includes('BEGIN:VCALENDAR')) throw new Error('O endereço não retornou um calendário ICS válido.');
  return parseCalendarEventsForDay(ics, day);
};
