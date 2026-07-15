const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCalendarEventsForDay } = require('../dist-relay/calendarAutomation.js');

test('calendário ICS seleciona eventos do dia, recorrências e exclusões', () => {
  const ics = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:single\r\nDTSTART:20260715T090000\r\nDTEND:20260715T100000\r\nSUMMARY:Reunião geral\r\nLOCATION:Sala 2\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:weekly\r\nDTSTART:20260701T140000\r\nDTEND:20260701T143000\r\nRRULE:FREQ=WEEKLY;BYDAY=WE\r\nSUMMARY:Revisão semanal\r\nEND:VEVENT\r\nEND:VCALENDAR`;
  const events = parseCalendarEventsForDay(ics, new Date(2026, 6, 15, 12));
  assert.deepEqual(events.map((event) => event.title), ['Reunião geral', 'Revisão semanal']);
  assert.equal(events[0].location, 'Sala 2');
  assert.equal(parseCalendarEventsForDay(ics, new Date(2026, 6, 16, 12)).length, 0);
});

test('calendário respeita EXDATE e eventos de dia inteiro', () => {
  const ics = `BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:daily\nDTSTART:20260714T080000\nRRULE:FREQ=DAILY\nEXDATE:20260715T080000\nSUMMARY:Não publicar hoje\nEND:VEVENT\nBEGIN:VEVENT\nUID:holiday\nDTSTART;VALUE=DATE:20260715\nDTEND;VALUE=DATE:20260716\nSUMMARY:Feriado\nEND:VEVENT\nEND:VCALENDAR`;
  const events = parseCalendarEventsForDay(ics, new Date(2026, 6, 15, 12));
  assert.equal(events.length, 1);
  assert.equal(events[0].title, 'Feriado');
  assert.equal(events[0].allDay, true);
});
