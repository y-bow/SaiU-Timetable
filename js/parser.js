/**
 * CSV Parsers for timetable data.
 *
 * Two parser strategies:
 *   1. `grid` — the original SCDS format (day rows, time columns, (Sec N) labels)
 *   2. `list` — flat list format: Day, Time, Subject, Faculty, Room, Section
 *
 * The parser is selected dynamically per school/year from the config.
 */

const DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
const SECTION_REGEX = /\(Sec\s*(\d+)\)/i;

/**
 * Parse a CSV string into an array of class objects.
 * @param {string} text - raw CSV content
 * @param {string} [parserType='grid'] - 'grid' or 'list'
 * @param {string[]} [mandatoryCourses] - optional mandatory course names
 * @param {Array<{id: string, label: string}>} [electives] - optional elective configs
 */
export function parseCSV(text, parserType = 'grid', mandatoryCourses = null, electives = null) {
    const raw = parserType === 'list'
        ? parseListCSV(text, electives)
        : parseGridCSV(text, mandatoryCourses, electives);
    return filterCourses(raw, mandatoryCourses);
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
        return mandatory.some(t => subj === t || subj.startsWith(t) || t.startsWith(subj));
    });
}

// ============================================================
// Grid parser (SCDS format)
// ============================================================

function parseGridCSV(text, mandatoryCourses = null, electives = null) {
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
                const subjLower = subject.trim().toLowerCase();
                if (!subjLower) continue;

                const isMandatory = !!mandatoryList &&
                    mandatoryList.some(t => matchesName(subjLower, t));
                const elective = isMandatory ? null : matchElective(subjLower);
                if (!isMandatory && !elective) continue;

                const room = findRoom(lines, i, j);
                data.push({
                    day: currentDay,
                    subject,
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
    const parts = cell.split(/\s{2,}/).map(p => p.trim()).filter(Boolean)
        .filter(p => !/^\(Sec\s*\d+\)$/i.test(p));
    let subject = (parts[0] || '').replace(/\s*\(Sec\s*\d+\)/i, '').trim();
    let faculty = parts.slice(1).join(' ');
    if (!faculty && /-\s*\S/.test(cell)) {
        const m = cell.match(/-\s*(.+)$/);
        if (m) faculty = m[1].trim();
    }
    // Unwrap a fully-parenthesized faculty name, e.g. "(Aravind)" → "Aravind".
    const unwrapped = faculty.match(/^\((.+)\)$/);
    if (unwrapped) faculty = unwrapped[1].trim();
    return { subject, faculty };
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

        const faculty = (row[3] || '').trim();
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
