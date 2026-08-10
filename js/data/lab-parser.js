/**
 * Year 2 lab timetable parser (DAA Lab, FDE Lab, Emerging Tools Lab).
 *
 * The lab sheets are expected to use the SAME grid layout as the main SCDS
 * sheet: rows carry a DAY + TIME in the first two columns, class cells sit in
 * the following columns, and the next non-empty line declares the current room
 * of each column for that slot.
 *
 * A physical column is NOT a class identity. The parser scans the sheet
 * independently of specific columns:
 *   - the current room of a column is read from the room-declaration row below
 *     the class row (falls back to a room token embedded in the cell itself),
 *   - the class's own text decides what it is (course → faculty → section /
 *     offering identifier),
 *   - the cell is kept only when its subject matches the configured lab course
 *     (or one of its aliases).
 *
 * So if the university moves a lab to another column/room/slot, the next
 * successful fetch simply produces the new record — the parser finds it by its
 * own data, never by cell coordinates. A lab that disappears entirely from the
 * sheet disappears from the output (the latest successful fetch of a source is
 * the source of truth).
 *
 * Reused from the main parser where practical: parseTimeRange (time column
 * parsing) and normalizeFacultyName (display names). Everything else here is
 * deliberately self-contained so this module never needs to edit parser.js.
 */

import { parseTimeRange, normalizeFacultyName } from './parser.js?v=2026-08-10-003';

const DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];

const norm = (s) => String(s ?? '').trim().toLowerCase();

// Smallest allowed gap between consecutive sessions of one continuous class
// (same rule as the main parser's MERGE_GAP_MIN).
const MERGE_GAP_MIN = 10;

// Room-ish text that is really just a place-holder, not a named room.
const PLACEHOLDER_ROOM = /^(tba|tbd|to be announced|to be decided|room tba|n\/?a)$/i;

function splitCsvLine(line) {
    return line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/)
        .map((cell) => cell.replace(/^"|"$/g, '').trim());
}

/**
 * Room comparison key (uppercase, dashes collapsed). Mirrors the main parser's
 * room normalization so the optional `rooms` search-list matches the sheet.
 */
export function normalizeRoom(name) {
    const s = String(name ?? '').replace(/\s+/g, ' ').trim();
    if (!s || PLACEHOLDER_ROOM.test(s)) return '';
    return s.toUpperCase().replace(/\s*-\s*/g, '-');
}

/**
 * Heuristic: does this cell read like a classroom name ("AB2-203",
 * "AB1-MOOT COURT HALL") rather than a class label or a clock time?
 */
export function looksLikeRoom(cell) {
    const s = String(cell ?? '').trim();
    if (!s || PLACEHOLDER_ROOM.test(s) || /LUNCH|OPEN BLOCK/i.test(s)) return false;
    if (/^\d{1,2}\s*:\s*\d{2}\s*(AM|PM)?$/i.test(s)) return false;
    if (/^\d+\s*(AM|PM)$/i.test(s)) return false;
    const compact = s.toUpperCase().replace(/[\s.-]+/g, '');
    return compact.length >= 3 && /^[A-Z]{2,}\d/.test(compact);
}

const CLASSROOM_TOKEN_RE = /(?:AB|LB|BL|RC|LT|TC|GH|CR|H)\s*[-\s]?\d{1,2}\s*[.\-:]\s*\d{1,4}[A-Za-z]?/i;

/**
 * Pull a room token out of a free-text cell ("... - AB2-203 - ..."). Used only
 * when the room-declaration row did not provide one for the cell's column.
 */
export function findRoomToken(cell) {
    const s = String(cell ?? '');
    const direct = s.match(CLASSROOM_TOKEN_RE);
    if (direct) return direct[0].replace(/\s+/g, ' ');
    for (const token of s.split(/[\s;,]+/)) {
        const cleaned = token.replace(/^[-(]+|[\)-,]+$/g, '');
        if (looksLikeRoom(cleaned)) return cleaned;
    }
    return '';
}

// --- Cell interpretation ---------------------------------------------------

function extractSectionNumber(text) {
    const m = String(text ?? '').match(/\bsec\s*\.?\s*(\d+)/i);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Extract the source's own offering identifier ("Offering A", "Group B",
 * "Batch 1", "(C)") if the cell declares one. Returns a short label such as
 * "A" or "1", or null when the sheet uses no such label. Numeric "Sec 2"
 * markers are NOT treated as offering labels here — they stay numeric sections.
 */
export function extractOfferingLabel(text) {
    const t = String(text ?? '');
    const m = t.match(/\boffering\s*[:.-]?\s*([A-Za-z0-9]+)/i)
        || t.match(/\b(?:group|batch|slot)\s*[:.-]?\s*([A-Za-z0-9]+)/i)
        || t.match(/\(\s*([A-Za-z0-9])\s*\)/i);
    return m ? m[1].toUpperCase() : null;
}

// Drop section/offering markers so the remainder can be split into subject and
// faculty ("DAA Lab - Sec 1 - Prof A" → "DAA Lab - Prof A"). Markers are
// removed together with any surrounding " - " separators, so a dashed marker
// never collapses into a stray double dash.
function cleanCellText(cell) {
    let t = String(cell ?? '');
    // " - Sec 1 - ", " - Offering A - ", " - (C) - " → " - "
    t = t.replace(/\s*-\s*(?:sec\s*\.?\s*\d+|(?:offering|group|batch|slot)\s+[a-z0-9]+|\(\s*[a-z0-9]\s*\))\s*-\s*/gi, ' - ');
    // Standalone markers used without dashes: "Offering A Vance", "(C) Vance".
    t = t.replace(/\s*(?:offering|group|batch|slot)\s+[a-z0-9]+\s*/gi, ' ');
    t = t.replace(/\s*\(\s*sec\s*\.?\s*\d+\s*\)/gi, ' ');
    t = t.replace(/\s*\(\s*[a-z0-9]\s*\)/gi, ' ');
    return t.replace(/\s+/g, ' ').trim();
}

function capsNames(s) {
    return String(s ?? '').replace(/\b\w/g, (c) => c.toUpperCase());
}

function splitSubjectFaculty(text) {
    let subject = text;
    let faculty = '';
    const dash = text.indexOf(' - ');
    if (dash >= 0) {
        subject = text.slice(0, dash).trim();
        faculty = text.slice(dash + 3).trim();
    } else {
        const parts = text.split(/\s{2,}/).map((p) => p.trim()).filter(Boolean);
        subject = parts[0] || '';
        faculty = parts.slice(1).join(' ');
    }
    return { subject, faculty: capsNames(normalizeFacultyName(faculty)) };
}

// Canonical course name when the cell subject matches the source (or an alias),
// otherwise null (→ cell ignored).
function expandSubject(rawSubject, config) {
    const s = norm(rawSubject);
    if (!s || s.length < 2) return null;
    if (s === norm(config.course)) return config.course;
    for (const re of config.subjectAliases || []) {
        if (re.test(s)) return config.course;
    }
    return null;
}

// --- Sheet scanning --------------------------------------------------------

// Section-cell entries look like "daa sec2 david", "daa sec 8 roopam",
// "ET sec1 arjun". This matches the optional subject prefix, the section
// marker, and the faculty tail.
const LIST_ENTRY_RE = /^(.*?)\s+sec\s*\.?\s*(\d+)\s*(?:[-|]\s*)?(.*)$/i;

/**
 * Parse ONE lab tab's CSV into raw lab records. The lab tabs use a simple
 * LIST layout — Day | Time | Section — unlike the main grid sheet. The day
 * column only repeats on the first row of each day (blanks inherit the
 * previous day), and interruption rows say "LUNCH BREAK".
 *
 * @param {string} csv raw CSV fetched from the lab tab
 * @param {object} config one of YEAR_2_LAB_SOURCES
 * @returns {Array<object>} raw records
 *   { day, subject, course, faculty, room, section, offering,
 *     startTime, endTime, year, school, source }
 */
export function parseLabList(csv, config) {
    const rows = String(csv ?? '').split(/\r?\n/).map(splitCsvLine);
    const records = [];
    let currentDay = null;

    for (const row of rows) {
        if (row.length < 3) continue;
        const dayCell = String(row[0] ?? '').trim();
        const timeCell = String(row[1] ?? '').trim();
        const sectionCell = String(row[2] ?? '').trim();

        const dayUpper = dayCell.toUpperCase();
        if (DAYS.includes(dayUpper)) currentDay = dayUpper.charAt(0) + dayUpper.slice(1).toLowerCase();
        if (!currentDay) continue;
        if (!timeCell || !sectionCell) continue;
        if (/LUNCH|OPEN BLOCK/i.test(sectionCell)) continue;

        const times = parseTimeRange(timeCell);
        if (!times) continue; // annotation / reference rows, not class rows

        const m = LIST_ENTRY_RE.exec(sectionCell);
        const rawSubject = m ? m[1] : sectionCell;
        const section = m ? parseInt(m[2], 10) : null;
        const rawFaculty = m ? m[3] : '';

        const canonical = expandSubject(rawSubject, config);
        if (!canonical) continue;

        records.push({
            day: currentDay,
            subject: canonical,
            course: config.course,
            faculty: capsNames(normalizeFacultyName(rawFaculty)),
            room: '',
            section: Number.isFinite(section) && section > 0 ? section : null,
            offering: null,
            startTime: times.start,
            endTime: times.end,
            year: config.year,
            school: config.school,
            source: config.source,
        });
    }
    return records;
}

// Dispatch to the right parser for a source: list-format lab tabs (they have
// a `sheet` tab name) vs the grid-format lab sheet fallback.
export function parseLabCSV(csv, config) {
    return config && config.sheet ? parseLabList(csv, config) : parseLabSheet(csv, config);
}

/**
 * Parse one lab sheet's CSV into raw lab records. One record per class cell.
 *
 * @param {string} csv raw CSV fetched from the lab sheet
 * @param {object} config one of YEAR_2_LAB_SOURCES
 * @returns {Array<object>} raw records
 *   { day, subject, course, faculty, room, section, offering,
 *     startTime, endTime, year, school, source }
 */
export function parseLabSheet(csv, config) {
    const rows = String(csv ?? '').split(/\r?\n/).map(splitCsvLine);
    const records = [];
    let currentDay = null;

    const targetRooms = config.rooms && config.rooms.length
        ? new Set(config.rooms.map(normalizeRoom))
        : null;

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (row.length < 3) continue;
        if (!row.some((c) => String(c ?? '').trim())) continue;

        const col0 = String(row[0] ?? '').trim();
        const col0Upper = col0.toUpperCase();

        // Header/shape rows ("Day, Time, ...") are just skipped as non-days.
        if (DAYS.includes(col0Upper)) currentDay = col0Upper.charAt(0) + col0Upper.slice(1).toLowerCase();
        if (!currentDay) continue;

        const timeText = String(row[1] ?? '').trim();
        if (!timeText || /LUNCH|OPEN BLOCK/i.test(timeText)) continue;
        const times = parseTimeRange(timeText);
        if (!times) continue; // a room-declaration or annotation row, not a class row

        // Room declaration row: the next non-empty line names the current room
        // of each column for this slot.
        let roomRow = null;
        for (let k = i + 1; k < rows.length; k++) {
            if (rows[k].some((c) => String(c ?? '').trim())) { roomRow = rows[k]; break; }
        }
        if (!roomRow) continue;

        for (let j = 2; j < row.length; j++) {
            const cell = String(row[j] ?? '').trim();
            if (!cell || /LUNCH|OPEN BLOCK/i.test(cell)) continue;

            const roomRaw = String(roomRow[j] ?? '').trim();

            // Optional search-locations list: scan only columns whose current
            // room is one of the configured rooms (same idea as the main SCDS
            // room-scoped parser).
            if (targetRooms && !targetRooms.has(normalizeRoom(roomRaw))) continue;

            const headerRoom = looksLikeRoom(roomRaw)
                ? roomRaw.replace(/\s+/g, ' ')
                : '';
            const room = String(headerRoom || findRoomToken(cell)).replace(/\s+/g, ' ').trim();

            const section = extractSectionNumber(cell);
            const offering = extractOfferingLabel(cell);
            const { subject, faculty } = splitSubjectFaculty(cleanCellText(cell));
            const canonical = expandSubject(subject, config);
            if (!canonical) continue;

            records.push({
                day: currentDay,
                subject: canonical,
                course: config.course,
                faculty: faculty || '',
                room,
                section,
                offering,
                startTime: times.start,
                endTime: times.end,
                year: config.year,
                school: config.school,
                source: config.source,
            });
        }
    }
    return records;
}

// --- App-shaped conversion -------------------------------------------------

function toMinutes(t) {
    const [h, m] = String(t ?? '0:00').split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
}

/**
 * Merge consecutive sessions of one continuous (mandatory) lab — two slot
 * halves with the same course/section/faculty/room between 0 and
 * MERGE_GAP_MIN apart become a single class, mirroring the main parser.
 */
function mergeConsecutiveLab(classes) {
    if (classes.length < 2) return classes;
    const dayOrder = Object.fromEntries(DAYS.map((d, i) => [norm(d), i]));
    const sorted = [...classes].sort((a, b) => {
        const da = dayOrder[norm(a.day)] ?? 0;
        const db = dayOrder[norm(b.day)] ?? 0;
        if (da !== db) return da - db;
        return toMinutes(a.startTime) - toMinutes(b.startTime);
    });
    const out = [];
    for (const c of sorted) {
        const last = out[out.length - 1];
        const gap = toMinutes(c.startTime) - toMinutes(last && last.endTime);
        const mergeable = last &&
            norm(last.day) === norm(c.day) &&
            norm(last.subject) === norm(c.subject) &&
            (last.section ?? null) === (c.section ?? null) &&
            norm(last.faculty) === norm(c.faculty) &&
            norm(last.room) === norm(c.room) &&
            gap >= 0 && gap <= MERGE_GAP_MIN;
        if (mergeable) last.endTime = c.endTime;
        else out.push({ ...c });
    }
    return out;
}

/**
 * Convert raw lab records into the app's timetable class shape.
 *
 * Mandatory labs (DAA, FDE) become flat class objects carrying `lab: true` and
 * the lab-section number found in the sheet. A lab cell WITHOUT any section is
 * dropped (each lab tab always keys a section, so there is nothing to show for
 * a sectionless cell). Consecutive sessions are merged into one event like the
 * main parser does.
 *
 * The Emerging Tools Lab is an elective tied to the Emerging Tools course
 * offering: each row becomes a flat class carrying `elective` + its own
 * faculty, so the app's existing offering logic only shows it once the student
 * selects the Emerging Tools elective AND the matching instructor offering.
 *
 * @param {Array<object>} records raw records from parseLabList / parseLabSheet
 * @param {object} config the lab source config
 * @returns {Array<object>} app-shaped classes (subject/faculty/day/startTime/
 *   endTime/room/section[/offerings]/[elective]/lab/source/year/school/course)
 */
export function recordsToAppClasses(records, config, ctx = {}) {
    if (config.isElective) return toFlatElectiveClasses(records, config);

    const classes = records
        .filter((r) => r.section != null)
        .map((r) => ({
            lab: true,
            day: r.day,
            subject: r.subject,
            faculty: r.faculty || '',
            room: config.fixedRoom || r.room || '',
            section: r.section,
            startTime: r.startTime,
            endTime: r.endTime,
            course: r.course,
            year: r.year,
            school: r.school,
            source: r.source,
        }));
    return mergeConsecutiveLab(classes);
}

// Flat elective classes for the Emerging Tools Lab. Each record keeps its own
// faculty/section; consecutive sessions of the same offering merge into one
// event. The app resolves the effective offering via the sidebar dropdown.
function toFlatElectiveClasses(records, config) {
    const classes = records.map((r) => ({
        lab: true,
        day: r.day,
        subject: r.subject,
        faculty: r.faculty || '',
        room: config.fixedRoom || r.room || '',
        section: r.section ?? 1,
        startTime: r.startTime,
        endTime: r.endTime,
        elective: config.electiveId,
        course: r.course,
        year: r.year,
        school: r.school,
        source: r.source,
    }));
    return mergeConsecutiveLab(classes);
}

// --- Merge ----------------------------------------------------------------

/**
 * Stable identity for one parsed class. Includes the source so the same course
 * from the main sheet and a lab sheet never collapse into one record.
 */
export function stableIdentity(c) {
    return [
        c.subject,
        c.elective ?? '',
        c.section ?? '',
        c.faculty,
        c.room,
        c.day,
        c.startTime,
        c.endTime,
        c.source ?? '',
    ].map(norm).join('|');
}

/**
 * Merge the main SCDS timetable with the parsed lab timetables into one class
 * list for the Year 2 timetable. Order of sources is preserved (main first,
 * then labs in config order). Records with an identical stable identity are
 * deduplicated (safety net — each source is replaced wholesale per fetch, so
 * within one merge the same source cannot repeat itself unless the main sheet
 * also contains the identical lab class).
 */
export function mergeTimelines(mainClasses, labClasses, opts = {}) {
    const dedupe = opts.dedupe !== false;
    const seen = new Set();
    const out = [];
    for (const c of [...(mainClasses || []), ...(labClasses || [])]) {
        if (!c) continue;
        const key = stableIdentity(c);
        if (dedupe && seen.has(key)) continue;
        seen.add(key);
        out.push(c);
    }
    return out;
}