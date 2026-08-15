/**
 * CSV Parsers for timetable data.
 *
 * Two parser strategies:
 *   1. `grid` — the original SCDS format (day rows, time columns, (Sec N) labels)
 *   2. `list` — flat list format: Day, Time, Subject, Faculty, Room, Section
 *
 * The parser is selected dynamically per school/year from the config.
 *
 * RAW RECORDS ARE THE SOURCE OF TRUTH. Each class the sheet contains is
 * emitted as its OWN record with the slot's real start/end times. Consecutive
 * sessions of one continuous class (3:00-3:55 + 4:00-4:55) are NEVER merged
 * here — they stay two independent records so the cache, the smart change
 * detector and the live clock always see the sheet exactly as parsed. The
 * visual glue that presents them as one block happens only in the
 * display layer (js/ui/display.js), never in the parser.
 *
 * The one exception — parallel offerings of the same elective that share a
 * slot are grouped into ONE event carrying an `offerings` array
 * (faculty/room/section). This is NOT a time merge: the slot times are
 * unchanged and every offering keeps its own data, so the elective selector
 * can offer the student a choice. Fully data-driven — any elective with
 * multiple offerings in the sheet is supported with no per-course config.
 */

import { resolveCourse } from './course-normalizer.js?v=2026-08-13-005';

const DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
const SECTION_REGEX = /\(Sec\s*(\d+)\)/i;

/**
 * Canonical course id for a class subject. Known courses resolve to their
 * registry id; unknown courses get a stable folded slug so change detection
 * still has a durable identity. Ambiguous names resolve to null (never
 * guessed). Elective records carry their configured id instead — the elective
 * `id` in schools.js IS the canonical course id.
 */
function resolveCourseId(raw) {
    const res = resolveCourse(raw);
    return res ? res.canonical : null;
}

/**
 * Faculty name aliases — maps the free-text teacher names in the sheet to
 * canonical display names. Applied at parse time so every consumer (timeline,
 * search, offering keys) sees the normalized name.
 */
const FACULTY_ALIASES = [
    { match: /^dr\.?\s*k\.?\s*k\.?\s*$/i, name: 'Dr.K.K.Singh' },
    // The sheet spells this teacher inconsistently ("Dr. Tamil" in most cells,
    // "Dr. Tamilarasi" in a few), and often adds a "mam" honorific. Normalize
    // every variant to the canonical full name so the timetable displays one
    // consistent teacher across all sections/days.
    { match: /^(?:dr\.?\s*)?(?:tamilarasiarasi|tamilarasi|tamil(?:\s*arasi)?)\s*(?:mam|ma'?am|madam)?\s*$/i, name: 'Dr.Tamilarasi' },
    // Same teacher written with and without a title in different cells
    // ("Law of Contracts 2 ( Sanjay Bang )" vs "Contitutional Law 2 ... Dr.
    // Sanjay Bang"; "Community Psychology  Mridula" vs "Forensic Psychology ...
    // Dr Mridula"). Fold both spellings onto the titled form so the teacher
    // timetable shows ONE consistent teacher instead of two near-duplicates.
    { match: /^sanjay\s+bang$/i, name: 'Dr.Sanjay Bang' },
    { match: /^mridula$/i, name: 'Dr.Mridula' },
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
    // The title MUST be followed by a dot or whitespace ("Dr." / "Dr "): a
    // plain name that merely STARTS with the letters of a title ("Mridula",
    // "Profane") is left untouched instead of being mangled into "Mr.idula".
    name = name.replace(/^(Dr|Prof|Ms|Mr|Mrs|Miss)(?:\.\s*|\s+)/i, (m, title) => {
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
    return groupElectiveOfferings(filterCourses(raw, mandatoryCourses));
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
// Normalization: group parallel elective offerings into a single
// course event.
//
//   Course → Offerings → Faculty → Room → Section → Selection
//
// Time-adjacent classes are deliberately NOT merged here — that is a display
// concern (js/ui/display.js). This step only groups same-slot offerings, so
// the rest of the app sees one event per elective slot with its choices kept
// side-by-side.
// ============================================================

const norm = (s) => String(s ?? '').trim().toLowerCase();

/**
 * Stable identity of a single offering. Persisted as the student's choice,
 * so it must stay stable across refreshes and only change when the
 * timetable data itself changes.
 */
export function offeringKey(offering) {
    return [offering.section ?? '', norm(offering.faculty), norm(offering.room)].join('|');
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
                    courseId: c.courseId,
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
                // Sectioned cell — parse when it belongs to this year: a
                // mandatory course or a configured elective. With no course
                // config (raw grid parsing) every sectioned cell is kept.
                // Aliases are expanded and electives tagged so a sectioned
                // elective is only shown once the student selects it.
                const section = parseInt(sectionMatch[1], 10);
                if (!section) continue;

                const room = findRoom(lines, i, j);
                const { subject, faculty } = splitSubjectFaculty(cell);
                const name = expandSubjectAlias(subject);
                const subjLower = name.trim().toLowerCase();

                let elective = null;
                if (electiveList) elective = matchElective(subjLower);

                let isMandatory = false;
                if (mandatoryList) {
                    isMandatory = !elective && mandatoryList.some(t => matchesName(subjLower, t));
                }

                if ((mandatoryList || electiveList) && !isMandatory && !elective) continue;

                data.push({
                    day: currentDay,
                    subject: name,
                    faculty,
                    room,
                    section,
                    startTime: times.start,
                    endTime: times.end,
                    courseId: elective ? elective.id : resolveCourseId(name),
                    ...(elective ? { elective: elective.id } : {}),
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
                    courseId: elective ? elective.id : resolveCourseId(name),
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
    { match: /^Emerging Tools\b/i, name: 'Emerging Tools and Applications' },
    { match: /^CN$/i, name: 'Computer Networks' },
    { match: /^(?:INT|INTT)\s*EMB$/i, name: 'Intelligent Embedded Systems' },
    { match: /^DL$/i, name: 'Deep Learning' },
    { match: /^TOC$/i, name: 'Theory of Computation' },
    { match: /^QML$/i, name: 'Quantum Machine Learning' },
    { match: /^CYBER$/i, name: 'Cybersecurity: Fundamental Concepts and Management' },
    { match: /^COA$/i, name: 'Computer Organization and Architecture' },
    { match: /^IFA$/i, name: 'Introduction to Financial Accounting' },
    { match: /^CT$/i, name: 'Critical Thinking' },
];

// Normalize room names for comparison: uppercase, hyphens equivalent to
// spaces ("AB2 - 101" -> "AB2 101", "AB1-COMPUTER LAB" -> "AB1 COMPUTER LAB").
function normalizeRoom(name) {
    return String(name ?? '')
        .toUpperCase()
        .replace(/-/g, ' ')
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
                    courseId: elective ? elective.id : resolveCourseId(name),
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
    // Strip semester/section markers WITHOUT collapsing the whitespace that
    // separates subject from faculty. SOAI/SOB cells rely on a run of spaces
    // as the subject/faculty separator ("Differential Equations         ArunKumar");
    // collapsing it early (the old strip) glued the teacher into the subject.
    const text = stripClassMarkers(cell);

    const parts = text.split(/\s{2,}/).map(p => p.trim()).filter(Boolean)
        .filter(p => !/^\(Sec\s*\d+\)$/i.test(p));
    let subject = (parts[0] || '').replace(/\s*\(Sec\s*\d+\)/i, '').trim();
    let faculty = parts.slice(1).join(' ');

    // "Subject - Teacher" dash format (single or double spaces around the dash,
    // e.g. "Image Processing - Dr Aasy"). Used only when the multi-space split
    // above did not already isolate a teacher, or left the dash glued to the
    // subject ("Law of Insurance -                      Sanjay Bang").
    if ((!faculty || faculty.trim().startsWith('-')) && /-\s*\S/.test(text)) {
        const m = text.match(/\s*-\s*(.+)$/);
        if (m) faculty = m[1].trim();
        subject = subject.replace(/\s*-\s*.+$/, '').trim();
    }
    // A multi-space cell with the dash glued to the subject leaves a trailing
    // dash, e.g. "Law of Insurance -" — drop it, the teacher is isolated.
    subject = subject.replace(/\s*-\s*$/, '').trim();

    // Unwrap a fully-parenthesized faculty name, e.g. "(Aravind)" → "Aravind".
    const unwrapped = faculty.match(/^\((.+)\)$/);
    if (unwrapped) faculty = unwrapped[1].trim();

    // Defensive: a marker strip can leave a stray leading dash on the faculty
    // (e.g. "ET - (Sec 5) - Salim"). A dash is never part of a name.
    faculty = faculty.replace(/^-\s*/, '').trim();

    return { subject, faculty: normalizeFacultyName(faculty) };
}

/**
 * Strip semester/section markers used by multi-year or multi-section courses,
 * e.g. "DL - Sem 5 - Dr. KK", "INTT EMB - Sec 1 - Dr. Ashok" or "(Sec 5)".
 *
 * The whitespace run that separates subject from faculty in SOAI/SOB cells is
 * deliberately PRESERVED: collapsing it here (as the old strip did) destroyed
 * "Differential Equations         ArunKumar" before splitSubjectFaculty could
 * use the spacing as the subject/faculty separator.
 */
function stripClassMarkers(text) {
    return String(text ?? '')
        .replace(/\s*-\s*Sem(?:ester)?\s*\.?\s*\d+\s*-?\s*/gi, ' - ')
        .replace(/\s*-\s*[Ss]ec\s*\.?\s*\d+\s*-?\s*/gi, ' - ')
        .replace(/\s*\(Sec\s*\.?\s*\d+\)\s*/gi, ' ')
        // Whitespace-only parens ("Labour Law 2 (    )") are an empty faculty
        // placeholder, never a subject. Drop them so they don't split the cell.
        .replace(/\s*\(\s*\)\s*/g, ' ')
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
            courseId: elective || resolveCourseId(subject),
            ...(elective ? { elective } : {}),
        });
    }
    return data;
}

// ============================================================
// Teacher-centric raw grid parser.
//
// This is the SOURCE of the teacher timetable. It parses the ENTIRE shared
// grid sheet and emits a class record for EVERY cell that contains a teacher
// name — regardless of whether the course is recognized by any student course
// config. A class belongs to a teacher's timetable because the teacher's name
// appears in the source cell for that class, never because the course is known
// elsewhere. This is deliberately the inverse of the student parsers, which
// start from the course list and filter the sheet down.
//
//     raw timetable rows/cells → identify teacher → extract the class record
//
// - Day/time come from the row header; the room comes from the room-declaration
//   row directly below the class row (same convention as the grid parser).
// - The class's own text decides subject, section and teacher.
// - Cells with no teacher are skipped (there is nothing to index), cells whose
//   trailing token is a course number ("Economics - 1", "Psychology-1") are
//   NOT treated as teachers, and cells with multiple teachers stay a single
//   record whose faculty the teacher index later splits per teacher.
// - Each record carries `_hasSection` (whether the cell declared an explicit
//   "Sec N") and `_line`/`_col` (source location) for context stamping and the
//   teacher page's ?debug diagnostics.
// ============================================================

/**
 * Split a raw class cell into { subject, faculty, section, hasSection }.
 *
 * Handles the source formats observed across the shared sheet:
 *   - "Subject - Sec 4 - Teacher"    dash + section marker
 *   - "Subject - Sem 5 - Teacher"    dash + semester marker
 *   - "Subject                  Teacher"   multi-space separation
 *   - "Subject - 1    Teacher"      course-number suffix, multi-space
 *   - "Subject ( Teacher )"          parenthesized teacher
 *   - "Subject - Teacher"            single dash, single name
 *   - "Subject (    )"               empty faculty placeholder → no teacher
 *
 * Course-number suffixes ("Economics - 1", "Psychology-1") are never teachers:
 * a purely numeric trailing token is not a name and yields no faculty.
 */
function splitTeacherCell(cell) {
    const raw = String(cell ?? '');
    const section = extractSection(raw);
    const hasSection = section != null;

    // Remove "(Sec N)", " - Sec N - ", " - Sem N - " markers and empty parens.
    let text = stripClassMarkers(raw);

    let subject = text;
    let faculty = '';

    // 1. Parenthesized teacher: "Subject (Teacher)" / "Subject ( Teacher )".
    const paren = text.match(/\(\s*([A-Za-z][A-Za-z .,'-]*?)\s*\)\s*$/);
    if (paren) {
        subject = text.slice(0, paren.index).replace(/\s+/g, ' ').trim();
        faculty = paren[1].trim();
    } else {
        // 2. Multi-space separation: split at the LAST run of 2+ spaces so a
        //    course name that itself contains double-space padding
        //    ("Fundamentals of Business Organization  & Management
        //    Subramaniam") keeps its full subject ("... Organization &
        //    Management") and isolates the teacher, and a course-number suffix
        //    stays glued to the subject ("Psychopathology  II     Dr. Jemima"
        //    → subject "Psychopathology II", teacher "Dr. Jemima").
        let last = null;
        const re = /\s{2,}/g;
        let m;
        while ((m = re.exec(text)) !== null) last = m;
        if (last) {
            subject = text.slice(0, last.index).replace(/\s+/g, ' ').trim();
            faculty = text.slice(last.index + last[0].length).trim();
        } else {
            // 3. Dash separation: "Subject - Teacher" (single spaces). A
            //    trailing course number ("Economics - 1") is not a teacher.
            const dash = text.match(/\s-\s(.+)$/);
            if (dash && !/^\d+$/.test(dash[1].trim())) {
                subject = text.slice(0, dash.index).replace(/\s+/g, ' ').trim();
                faculty = dash[1].trim();
            } else {
                subject = text.replace(/\s+/g, ' ').trim();
            }
        }
    }

    // A dash glued to the front of a multi-space faculty ("- Dr. Angel"), and
    // a dash left glued to the subject ("Law of Insurance -  Sanjay Bang").
    faculty = faculty.replace(/^-\s*/, '').trim();
    subject = subject.replace(/\s*-\s*$/, '').trim();

    return { subject, faculty: normalizeFacultyName(faculty), section, hasSection };
}

/**
 * Parse the whole shared grid sheet into teacher-centric class records.
 *
 * @param {string} text raw CSV of the main timetable sheet
 * @returns {Array<object>} every cell that names a teacher, as a class record
 *   { day, subject, faculty, room, section, startTime, endTime, courseId,
 *     _hasSection, _line, _col }. `section` defaults to 1 (as the student
 *   parsers do for unsectioned cells) while `_hasSection` records whether an
 *   explicit "Sec N" was present.
 */
export function parseTeacherGrid(text) {
    const lines = text.split(/\r?\n/);
    const data = [];
    let currentDay = null;

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

            const { subject, faculty, section, hasSection } = splitTeacherCell(cell);
            if (!subject || subject.length < 2) continue;
            if (!faculty) {
                // A class cell with no teacher — nothing to index. Logged as a
                // warning only in diagnostics mode so an admin can spot cells
                // whose teacher the sheet did not name.
                teacherDiagLog(`[TEACHER PARSER WARNING] ${currentDay} ${times.start}-${times.end} line ${i + 1} col ${j + 1}: "${cell}" — no teacher parsed`);
                continue;
            }

            const name = expandSubjectAlias(subject);
            const record = {
                day: currentDay,
                subject: name,
                faculty,
                room: findRoom(lines, i, j),
                section: section ?? 1,
                startTime: times.start,
                endTime: times.end,
                courseId: resolveCourseId(name),
                _hasSection: !!hasSection,
                _line: i + 1,
                _col: j + 1,
            };
            data.push(record);
            teacherDiagLog(
                `[TEACHER PARSER] cell "${cell}" → raw faculty "${faculty}" · course "${name}" · ` +
                `${currentDay} ${times.start}-${times.end} · room "${record.room}" · sec ${record.section} · ` +
                `src line ${i + 1} col ${j + 1}`
            );
        }
    }
    return data;
}

// ---------------------------------------------------------------------------
// Development-only teacher parser diagnostics. Off by default — normal
// operation never logs. Enable from a dev console via
// enableTeacherParserDiagnostics(true) (or a ?debug harness) to see every
// parsed teacher occurrence and every cell the parser could not attribute.
// ---------------------------------------------------------------------------

let TEACHER_DIAG = false;

/** Toggle verbose [TEACHER PARSER] diagnostics (dev only). */
export function enableTeacherParserDiagnostics(enabled = true) {
    TEACHER_DIAG = !!enabled;
}

function teacherDiagLog(message) {
    if (!TEACHER_DIAG) return;
    try {
        if (typeof console !== 'undefined' && console.log) console.log(message);
    } catch { /* logging must never throw */ }
}
