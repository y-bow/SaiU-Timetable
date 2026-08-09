/**
 * CSV Parsers for timetable data.
 *
 * Two parser strategies:
 *   1. `grid` — the original SCDS format (day rows, time columns, (Sec N) labels)
 *   2. `list` — flat list format: Day, Time, Subject, Faculty, Room, Section
 *
 * The parser is selected dynamically per school/year from the config.
 *
 * Parsed output is normalized before it reaches the app:
 *   - consecutive sessions of one continuous class are merged into a single
 *     event (same course, faculty, room and slot continuity; a small gap
 *     between back-to-back slots is allowed),
 *   - parallel offerings of the same elective that share a slot are grouped
 *     into ONE event carrying an `offerings` array (faculty/room/section).
 *   This is fully data-driven — any elective with multiple offerings in the
 *   sheet is supported with no per-course configuration.
 */

const DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
const SECTION_REGEX = /\(Sec\s*(\d+)\)/i;

/**
 * Faculty name aliases — maps the free-text teacher names in the sheet to
 * canonical display names. Applied at parse time so every consumer (timeline,
 * search, offering keys) sees the normalized name.
 */
const FACULTY_ALIASES = [
    { match: /^dr\.?\s*k\.?\s*k\.?\s*$/i, name: 'Dr.K.K.Singh' },
];

export function normalizeFacultyName(faculty) {
    const raw = String(faculty ?? '').trim();
    if (!raw) return raw;
    let name = raw;
    for (const alias of FACULTY_ALIASES) {
        if (alias.match.test(name)) {
            name = alias.name;
            break;
        }
    }
    // Normalize a leading title to its dotted "Title." form with correct case
    // and attach it directly to the name — no space after the title, e.g.
    // "Dr. Sanjay Bang" → "Dr.Sanjay Bang", "Dr Mridula" → "Dr.Mridula".
    name = name.replace(/^(Dr|Prof|Ms|Mr|Mrs|Miss)(\.?)\s*/i, (m, title) => {
        return title.charAt(0).toUpperCase() + title.slice(1).toLowerCase() + '.';
    });
    // Every teacher is shown with the "Prof." title followed by a space:
    // "Prof. Ashok", "Prof. Dr.Sanjay Bang".
    if (!/^Prof\.\s/i.test(name)) name = `Prof. ${name}`;
    return name;
}

/**
 * Parse a CSV string into an array of class objects.
 * @param {string} text - raw CSV content
 * @param {string} [parserType='grid'] - 'grid' or 'list'
 * @param {string[]} [mandatoryCourses] - optional mandatory course names
 * @param {Array<{id: string, label: string}>} [electives] - optional elective configs
 * @param {string[]} [rooms] - optional classroom names to scan (Year 2 SCDS).
 *   When provided the grid parser inspects ONLY the cells under these room
 *   headers instead of every non-empty cell. Classes are located by their own
 *   data (section/course/faculty) wherever they currently sit.
 */
export function parseCSV(text, parserType = 'grid', mandatoryCourses = null, electives = null, rooms = null) {
    const raw = parserType === 'list'
        ? parseListCSV(text, electives)
        : parseGridCSV(text, mandatoryCourses, electives, rooms);
    return normalizeEvents(filterCourses(raw, mandatoryCourses));
}

/**
 * Keep only classes a student actually attends. Unsectioned cells are already
 * scoped to mandatory/elective matches during grid parsing; this also drops
 * sectioned cells (grid) / rows (list) whose subject is not a mandatory course
 * when a mandatory list is configured.
 */
function filterCourses(raw, mandatoryCourses) {
    if (!raw.length) return raw;
    if (!mandatoryCourses || !mandatoryCourses.length) return raw;

    // Normalize mandatory names for case-insensitive prefix matching.
    const mandatory = mandatoryCourses.map(c => c.trim().toLowerCase());
    return raw.filter(c => {
        if (c.elective) return true; // selected electives are kept as-is
        const subj = c.subject.trim().toLowerCase();
        // Skip stray single-character cells (e.g. a lone "I" left in the
        // sheet) that would otherwise match a course via reverse-prefix.
        if (subj.length < 2) return false;
        return mandatory.some(t => subj === t || subj.startsWith(t) || t.startsWith(subj));
    });
}

// ============================================================
// Normalization: merge consecutive sessions + group parallel
// elective offerings into a single course event.
//
//   Course → Offerings → Faculty → Room → Section → Selection
//
// Both steps run at parse time, so the rest of the app only ever
// sees merged, de-duplicated timetable entries.
// ============================================================

const norm = (s) => String(s ?? '').trim().toLowerCase();

function toMinutesOfDay(t) {
    const [h, m] = String(t ?? '0:00').split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
}

/**
 * Stable identity of a single offering. Persisted as the student's choice,
 * so it must stay stable across refreshes and only change when the
 * timetable data itself changes.
 */
export function offeringKey(offering) {
    return [offering.section ?? '', norm(offering.faculty), norm(offering.room)].join('|');
}

/**
 * Merge sessions that are one continuous class into a single entry.
 *
 * Merge ONLY when all of the following hold:
 *   - same day
 *   - same section
 *   - same subject (never different courses)
 *   - same elective (or both non-elective)
 *   - same faculty (or both unknown)
 *   - same room (or both unknown)
 *   - time slots are consecutive or near-consecutive: the gap between
 *     last.endTime and c.startTime is a small break (<= MERGE_GAP_MIN),
 *     covering back-to-back slots like 3:00-3:55 + 4:00-4:55 that are one
 *     continuous class. The identical course/faculty/room requirement keeps
 *     unrelated 5-minute-apart classes from being merged.
 */
const MERGE_GAP_MIN = 10;

function mergeConsecutive(classes) {
    if (classes.length < 2) return classes;

    const dayOrder = Object.fromEntries(DAYS.map((d, i) => [norm(d), i]));
    const sorted = [...classes].sort((a, b) => {
        const da = dayOrder[norm(a.day)] ?? 0;
        const db = dayOrder[norm(b.day)] ?? 0;
        if (da !== db) return da - db;
        const t = toMinutesOfDay(a.startTime) - toMinutesOfDay(b.startTime);
        if (t !== 0) return t;
        return (a.section ?? 0) - (b.section ?? 0);
    });

    // A sheet may hold several sections interleaved (e.g. SCDS), so adjacency
    // in sorted order says nothing about two slots belonging to one class.
    // Track the last event emitted per day+section and only merge a slot with
    // the one that immediately precedes it for the SAME section/day.
    const out = [];
    const lastByKey = new Map(); // "day|section" -> last emitted event object
    for (const c of sorted) {
        const key = `${norm(c.day)}|${c.section ?? ''}`;
        const last = lastByKey.get(key);
        const gap = last ? toMinutesOfDay(c.startTime) - toMinutesOfDay(last.endTime) : NaN;
        const mergeable = last &&
            last.section === c.section &&
            (last.elective || null) === (c.elective || null) &&
            norm(last.subject) === norm(c.subject) &&
            norm(last.faculty) === norm(c.faculty) &&
            norm(last.room) === norm(c.room) &&
            gap >= 0 && gap <= MERGE_GAP_MIN;
        if (mergeable) {
            last.endTime = c.endTime;
        } else {
            out.push({ ...c });
            lastByKey.set(key, out[out.length - 1]);
        }
    }
    return out;
}

/**
 * Group parallel offerings of the same elective that share a time slot into
 * ONE course event. The offerings are kept side-by-side; a single-offering
 * elective stays a flat, backward-compatible class object.
 */
function groupElectiveOfferings(classes) {
    if (!classes.length) return classes;

    const groups = new Map();
    for (const c of classes) {
        if (!c.elective) continue;
        const key = `${c.elective}|${c.day}|${c.startTime}|${c.endTime}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(c);
    }
    if (!groups.size) return classes;

    const out = [];
    const emitted = new Set();
    for (const c of classes) {
        if (c.elective) {
            const key = `${c.elective}|${c.day}|${c.startTime}|${c.endTime}`;
            if (emitted.has(key)) continue;
            emitted.add(key);

            const offerings = [];
            const seen = new Set();
            for (const g of groups.get(key)) {
                const off = {
                    faculty: g.faculty || '',
                    room: g.room || '',
                    section: g.section ?? 1,
                };
                const k = offeringKey(off);
                if (seen.has(k)) continue;
                seen.add(k);
                offerings.push(off);
            }

            if (offerings.length > 1) {
                out.push({
                    day: c.day,
                    subject: c.subject,
                    startTime: c.startTime,
                    endTime: c.endTime,
                    elective: c.elective,
                    offerings,
                });
            } else {
                const off = offerings[0];
                out.push({ ...c, faculty: off.faculty, room: off.room, section: off.section });
            }
        } else {
            out.push(c);
        }
    }
    return out;
}

function normalizeEvents(classes) {
    if (!classes.length) return classes;
    return groupElectiveOfferings(mergeConsecutive(classes));
}

// ============================================================
// Grid parser (SCDS format)
// ============================================================

function parseGridCSV(text, mandatoryCourses = null, electives = null, rooms = null) {
    // Year 2 SCDS uses a room-scoped scan: only the configured classroom
    // columns are inspected, and the latest sheet is the source of truth.
    if (rooms && rooms.length) return parseGridCSVRooms(text, electives, rooms);

    const lines = text.split(/\r?\n/);
    const data = [];
    let currentDay = null;

    // Normalize mandatory course names for case-insensitive prefix matching.
    const mandatoryList = mandatoryCourses
        ? mandatoryCourses.map(c => c.trim().toLowerCase())
        : null;

    // Elective configs. Matching is strict — the elective's full label must be
    // a prefix of the parsed subject (covers exact matches and suffixed names
    // like "Course II"). The reverse prefix rule used for mandatory courses is
    // deliberately avoided here, otherwise a stray one-letter cell such as "I"
    // would wrongly match "Intelligent Embedded Systems".
    const electiveList = electives && electives.length ? electives : null;

    const matchesName = (subject, name) =>
        subject === name || subject.startsWith(name) || name.startsWith(subject);

    const matchElective = (subject) => {
        if (!electiveList) return null;
        for (const e of electiveList) {
            const name = e.label.trim().toLowerCase();
            if (subject === name || subject.startsWith(name)) return e;
        }
        return null;
    };

    for (let i = 0; i < lines.length; i++) {
        if (!lines[i].trim()) continue;

        const row = splitCSVLine(lines[i]);
        if (row.length < 3) continue;

        const col0 = row[0].toUpperCase();
        if (DAYS.includes(col0)) {
            currentDay = col0.charAt(0) + col0.slice(1).toLowerCase();
        }
        if (!currentDay) continue;

        const timeText = row[1];
        if (!timeText || /LUNCH|OPEN BLOCK/i.test(timeText)) continue;
        const times = parseTimeRange(timeText);
        if (!times) continue;

        for (let j = 2; j < row.length; j++) {
            const cell = row[j];
            if (!cell) continue;

            const sectionMatch = cell.match(SECTION_REGEX);

            if (sectionMatch) {
                // Sectioned cell — always parse (existing behavior)
                const section = parseInt(sectionMatch[1], 10);
                if (!section) continue;

                const room = findRoom(lines, i, j);
                const { subject, faculty } = splitSubjectFaculty(cell);

                data.push({
                    day: currentDay,
                    subject,
                    faculty,
                    room,
                    section,
                    startTime: times.start,
                    endTime: times.end,
                });
            } else if (mandatoryList || electiveList) {
                // Unsectioned cell — parse only when it is a mandatory course
                // or a configured elective. Everything else belongs to another
                // year/program and is skipped.
                const { subject, faculty } = splitSubjectFaculty(cell);
                const name = expandSubjectAlias(subject);
                const subjLower = name.trim().toLowerCase();
                if (!subjLower) continue;

                const isMandatory = !!mandatoryList &&
                    mandatoryList.some(t => matchesName(subjLower, t));
                const elective = isMandatory ? null : matchElective(subjLower);
                if (!isMandatory && !elective) continue;

                const room = findRoom(lines, i, j);
                data.push({
                    day: currentDay,
                    subject: name,
                    faculty,
                    room,
                    section: 1,
                    startTime: times.start,
                    endTime: times.end,
                    ...(elective ? { elective: elective.id } : {}),
                });
            }
        }
    }
    return data;
}

// ============================================================
// Room-scoped grid parser (Year 2 SCDS Smart Timetable).
//
// Scans ONLY the configured SCDS classroom columns (see `rooms` on the
// scds-2 year config). The first cell directly below a class row names the
// current room of each column for that slot — a room is a SEARCH LOCATION,
// never a class identity. A class may change room and column freely between
// refreshes. Each parsed class therefore carries the room of the column it
// was found in, and section/subject/faculty read from its own cell text.
// ============================================================

const SUBJECT_ALIASES = [
    { match: /^ET$/i, name: 'Emerging Tools and Applications' },
    { match: /^CN$/i, name: 'Computer Networks' },
    { match: /^(?:INT|INTT)\s*EMB$/i, name: 'Intelligent Embedded Systems' },
    { match: /^DL$/i, name: 'Deep Learning' },
    { match: /^TOC$/i, name: 'Theory of Computation' },
    { match: /^QML$/i, name: 'Quantum Machine Learning' },
    { match: /^CYBER$/i, name: 'Cybersecurity: Fundamental Concepts and Management' },
    { match: /^COA$/i, name: 'Computer Organization and Architecture' },
];

// Normalize room names for comparison: uppercase, "AB2 - 101" -> "AB2-101".
function normalizeRoom(name) {
    return String(name ?? '')
        .toUpperCase()
        .replace(/\s*-\s*/g, '-')
        .replace(/\s+/g, ' ')
        .trim();
}

// Find the section inside a class cell: "ET - Sec 5 - Salim" / "(Sec 5)".
function extractSection(text) {
    const m = String(text ?? '').match(/Sec\s*\.?\s*(\d+)/i);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return Number.isFinite(n) && n > 0 ? n : null;
}

// Remove " - Sec 5 - " / "(Sec 5)" markers so the remainder is subject+faculty.
function stripSectionMarkers(text) {
    return String(text ?? '')
        .replace(/\s*\(Sec\s*\.?\s*\d+\)\s*/gi, ' ')
        .replace(/\s*-\s*[Ss]ec\s*\.?\s*\d+\s*-?\s*/g, ' - ')
        .replace(/\s+/g, ' ')
        .trim();
}

// Expand short subject abbreviations ("ET", "CN", "INT EMB") to full names.
function expandSubjectAlias(subject) {
    const s = String(subject ?? '').trim();
    if (!s) return s;
    for (const alias of SUBJECT_ALIASES) {
        if (alias.match.test(s)) return alias.name;
    }
    return s;
}

// Split a class cell into { subject, faculty, section }.
function splitClassCell(cell) {
    const section = extractSection(cell);
    const text = stripSectionMarkers(cell);
    let subject = text;
    let faculty = '';
    const dash = text.indexOf(' - ');
    if (dash >= 0) {
        subject = text.slice(0, dash).trim();
        faculty = text.slice(dash + 3).trim();
    } else {
        const parts = text.split(/\s{2,}/).map(p => p.trim()).filter(Boolean);
        subject = parts[0] || '';
        faculty = parts.slice(1).join(' ');
    }
    return { subject, faculty: normalizeFacultyName(faculty), section };
}

function parseGridCSVRooms(text, electives = null, rooms = null) {
    const lines = text.split(/\r?\n/);
    const data = [];
    let currentDay = null;

    const electiveList = electives && electives.length ? electives : null;
    const matchElective = (subject) => {
        if (!electiveList) return null;
        for (const e of electiveList) {
            const name = e.label.trim().toLowerCase();
            if (subject === name || subject.startsWith(name)) return e;
        }
        return null;
    };

    const targetRooms = new Set((rooms || []).map(normalizeRoom));

    for (let i = 0; i < lines.length; i++) {
        if (!lines[i].trim()) continue;

        const row = splitCSVLine(lines[i]);
        if (row.length < 3) continue;

        const col0 = row[0].toUpperCase();
        if (DAYS.includes(col0)) currentDay = col0.charAt(0) + col0.slice(1).toLowerCase();
        if (!currentDay) continue;

        const timeText = row[1];
        if (!timeText || /LUNCH|OPEN BLOCK/i.test(timeText)) continue;
        const times = parseTimeRange(timeText);
        if (!times) continue;

        // The next non-empty line under a class row declares which room each
        // column currently holds for this slot.
        let roomRow = null;
        for (let k = i + 1; k < lines.length; k++) {
            if (!lines[k].trim()) continue;
            roomRow = splitCSVLine(lines[k]);
            break;
        }
        if (!roomRow) continue;

        // Columns that currently hold one of the target rooms for this slot.
        const roomSlots = new Map(); // roomKey -> [{ col, label }]
        for (let j = 0; j < roomRow.length; j++) {
            const key = normalizeRoom(roomRow[j]);
            if (!targetRooms.has(key)) continue;
            if (!roomSlots.has(key)) roomSlots.set(key, []);
            roomSlots.get(key).push({ col: j, label: String(roomRow[j]).replace(/\s+/g, ' ') });
        }

        for (const [roomKey, slots] of roomSlots) {
            for (const slot of slots) {
                const cell = row[slot.col];
                if (!cell) continue;

                const { subject, faculty, section } = splitClassCell(cell);
                const name = expandSubjectAlias(subject);
                // Classes from other years/theory etc. carry no section, but a
                // configured elective may still be taught section-less.
                const elective = matchElective(name.toLowerCase());
                if (section == null && !elective) continue;
                if (!name) continue;

                data.push({
                    day: currentDay,
                    subject: name,
                    faculty: faculty || '',
                    room: slot.label,
                    section: section ?? 1,
                    startTime: times.start,
                    endTime: times.end,
                    ...(elective ? { elective: elective.id } : {}),
                });
                break; // one class per room per slot
            }
        }
    }
    return data;
}

function splitCSVLine(line) {
    return line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map(cell => cell.replace(/^"|"$/g, '').trim());
}

export function findRoom(lines, rowIdx, colIdx) {
    for (let k = rowIdx + 1; k < lines.length; k++) {
        if (!lines[k].trim()) continue;
        const row = splitCSVLine(lines[k]);
        const cell = row[colIdx] || '';
        if (cell && !/LUNCH|OPEN BLOCK/i.test(cell) && !/\d\s*(AM|PM)/i.test(cell)) {
            return cell.replace(/\s+/g, ' ');
        }
        break;
    }
    return '';
}

export function parseTimeRange(text) {
    const normalized = text.replace(/(\d)\.(\d)/g, '$1:$2').replace(/(\d)(AM|PM)/gi, '$1 $2');
    const m = normalized.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?\s*-\s*(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
    if (!m) return null;
    return {
        start: to24Hour(m[1], m[2], m[3]),
        end: to24Hour(m[4], m[5], m[6]),
    };
}

function to24Hour(h, min, meridiem) {
    let hour = parseInt(h, 10);
    const isPM = meridiem && meridiem.toUpperCase() === 'PM';
    if (isPM && hour !== 12) hour += 12;
    if (!isPM && hour === 12) hour = 0;
    return `${String(hour).padStart(2, '0')}:${min}`;
}

export function splitSubjectFaculty(cell) {
    const text = stripSemMarkers(cell);
    const parts = text.split(/\s{2,}/).map(p => p.trim()).filter(Boolean)
        .filter(p => !/^\(Sec\s*\d+\)$/i.test(p));
    let subject = (parts[0] || '').replace(/\s*\(Sec\s*\d+\)/i, '').trim();
    let faculty = parts.slice(1).join(' ');
    if ((!faculty || faculty.trim().startsWith('-')) && /-\s*\S/.test(text)) {
        const m = text.match(/-\s*(.+)$/);
        if (m) faculty = m[1].trim();
        subject = subject.replace(/\s*-\s*.+$/, '').trim();
    }
    // Unwrap a fully-parenthesized faculty name, e.g. "(Aravind)" → "Aravind".
    const unwrapped = faculty.match(/^\((.+)\)$/);
    if (unwrapped) faculty = unwrapped[1].trim();
    return { subject, faculty: normalizeFacultyName(faculty) };
}

/**
 * Strip semester markers used by multi-year courses, e.g. "DL - Sem 5 - Dr. KK"
 * or "MATH - Sem1 - Dr. Beaulah", leaving subject + faculty for the parser. A
 * course is tagged with the semester its class belongs to, never a section.
 */
function stripSemMarkers(text) {
    return String(text ?? '')
        .replace(/\s*-\s*Sem(?:ester)?\s*\.?\s*\d+\s*-?\s*/gi, ' - ')
        .replace(/\s+/g, ' ')
        .trim();
}

// ============================================================
// List parser (SOAI / SOB format)
// Expected columns: Day, Time, Subject, Faculty, Room, [Section]
// Time column may be a range "09:00-10:00" or "09:00 AM - 10:00 AM".
// ============================================================

function parseListCSV(text, electives = null) {
    const lines = text.split(/\r?\n/);
    const data = [];

    const electiveList = electives && electives.length ? electives : null;

    // Detect header row — skip it if the first column looks like a label.
    let startIdx = 0;
    if (lines.length && /^(day|weekday|date)/i.test(lines[0])) startIdx = 1;

    for (let i = startIdx; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        const row = splitCSVLine(lines[i]);
        if (row.length < 4) continue;

        const dayRaw = row[0].trim();
        const col0Upper = dayRaw.toUpperCase();
        const dayMatch = DAYS.includes(col0Upper);
        if (!dayMatch) continue;

        const day = col0Upper.charAt(0) + col0Upper.slice(1).toLowerCase();
        const timeText = row[1].trim();
        if (!timeText || /LUNCH|OPEN BLOCK/i.test(timeText)) continue;

        const times = parseTimeRange(timeText);
        if (!times) continue;

        const subject = (row[2] || '').trim();
        if (!subject) continue;

        const faculty = normalizeFacultyName(row[3] || '');
        const room = (row[4] || '').trim();

        // Section is optional — defaults to 1 for single-section schools.
        let section = 1;
        if (row[5]) {
            const n = parseInt(row[5], 10);
            if (Number.isFinite(n) && n > 0) section = n;
        }

        // Tag rows whose subject is one of the configured electives so the
        // app can show them only when the student selects them.
        let elective = null;
        if (electiveList) {
            const subjLower = subject.trim().toLowerCase();
            for (const e of electiveList) {
                const name = e.label.trim().toLowerCase();
                if (subjLower === name || subjLower.startsWith(name)) {
                    elective = e.id;
                    break;
                }
            }
        }

        data.push({
            day,
            subject,
            faculty,
            room,
            section,
            startTime: times.start,
            endTime: times.end,
            ...(elective ? { elective } : {}),
        });
    }
    return data;
}
