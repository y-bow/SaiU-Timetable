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

import { resolveCourse, splitLabSuffix } from './course-normalizer.js?v=2026-08-30-002';

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
    // Surya Krish is an older sheet spelling for Surya C (Financial Reporting
    // and Analysis, SOB Year 2). Normalize to the current canonical name.
    { match: /^surya\s+krish$/i, name: 'Surya C' },
    // Dr. Pankaj Jain (Digital Healthcare, SOAI Year 2). The sheet may use
    // "Pankaj", "Pankaj Jain", "dr.pankaj", or "Dr. Pankaj Jain". Fold
    // every variant onto the titled form.
    { match: /^(?:dr\.?\s*)?pankaj(?:\s+jain)?$/i, name: 'Dr.Pankaj Jain' },
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
 * @param {string[]} [rooms] - optional known classroom names (Year 2 SCDS).
 *   When provided the grid parser uses the room-declaration rows to locate
 *   classes by their current room. This list is metadata/known-room
 *   information only — it does NOT restrict which columns are parsed. Every
 *   non-empty column in the room declaration row is inspected, and any class
 *   cell with a section marker or matching elective is emitted regardless of
 *   whether its room is in this list.
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
                    displayName: c.displayName,
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

    // Canonical ids of the mandatory courses. A differently-spelled cell that
    // resolves onto a mandatory course's canonical id (e.g. "Emering Tools and
    // Applications Lab" → emerging-tools-and-applications) is still that
    // course — the canonical fallback below makes the match without ever
    // renaming the cell.
    const mandatoryCanonicals = mandatoryList
        ? new Set(mandatoryList.map(t => resolveCourse(t).canonical).filter(Boolean))
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
        const words = subject.split(/\s+/);
        if (words.length >= 3) {
            for (let len = words.length - 1; len >= 2; len--) {
                const prefix = words.slice(0, len).join(' ');
                for (const e of electiveList) {
                    const name = e.label.trim().toLowerCase();
                    if (prefix === name || prefix.startsWith(name)) return e;
                }
            }
        }
        // Canonical fallback: a differently-spelled cell that resolves onto a
        // configured elective's canonical id is that elective ("Emering Tools
        // and Applications" → emerging-tools-and-applications). Only reached
        // when label-prefix matching found nothing, so existing matches are
        // never disturbed.
        const res = resolveCourse(subject);
        if (res && res.canonical) {
            for (const e of electiveList) {
                if (e.id === res.canonical) return e;
            }
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
                const { base: baseName, isLab } = splitLabSuffix(name);
                const subjLower = baseName.trim().toLowerCase();

                let elective = null;
                if (electiveList) elective = matchElective(subjLower);

                let isMandatory = false;
                if (mandatoryList) {
                    isMandatory = !elective &&
                        (mandatoryList.some(t => matchesName(subjLower, t)) ||
                         (mandatoryCanonicals && mandatoryCanonicals.has(resolveCourse(baseName).canonical)));
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
                    ...(elective ? { elective: elective.id, displayName: elective.label } : {}),
                    ...(isLab ? { lab: true } : {}),
                });
            } else if (mandatoryList || electiveList) {
                // Unsectioned cell — parse only when it is a mandatory course
                // or a configured elective. Everything else belongs to another
                // year/program and is skipped.
                const { subject, faculty } = splitSubjectFaculty(cell);
                const name = expandSubjectAlias(subject);
                const { base: baseName, isLab } = splitLabSuffix(name);
                const subjLower = baseName.trim().toLowerCase();
                if (!subjLower) continue;

                const isMandatory = !!mandatoryList &&
                    (mandatoryList.some(t => matchesName(subjLower, t)) ||
                     (mandatoryCanonicals && mandatoryCanonicals.has(resolveCourse(baseName).canonical)));
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
                    ...(elective ? { elective: elective.id, displayName: elective.label } : {}),
                    ...(isLab ? { lab: true } : {}),
                });
            }
        }
    }
    return data;
}

// ============================================================
// Room-scoped grid parser (Year 2 SCDS Smart Timetable).
//
// Scans the ENTIRE timetable source range. The first cell directly below a
// class row names the current room of each column for that slot — a room is
// a SEARCH LOCATION, never a class identity. A class may change room and
// column freely between refreshes.
//
// The configured `rooms` array (see schools.js) is used ONLY as a metadata
// hint for known room labels — it does NOT filter which columns are parsed.
// Every non-empty column in the room declaration row is inspected, and any
// class cell with a section marker or matching elective is emitted
// regardless of whether its room is in the configured list. This ensures
// new rooms and courses added to the source timetable are automatically
// discovered without config changes.
//
// A dedup set prevents the same class from being emitted twice when the
// same physical slot is reachable through multiple room columns.
// ============================================================

const SUBJECT_ALIASES = [
    { match: /^ET$/i, name: 'Emering Tools and Applications' },
    // The lecture spellings ("Emerging Tools", "Emering Tools",
    // "… and Applications") all fold onto the timetable's canonical display
    // name "Emering Tools and Applications". The negative lookahead keeps a
    // " Lab" suffix out of the lecture alias, so a lab cell is never misread as
    // the lecture — the full lab alias below wins for "… and Applications Lab",
    // and any other "… Lab" spelling stays intact and is classified as a lab by
    // its suffix (splitLabSuffix in course-normalizer.js).
    { match: /^Emerging Tools(?:\s+and\s+Applications)?(?!\s+Lab\b)$/i, name: 'Emering Tools and Applications' },
    { match: /^Emering Tools(?:\s+and\s+Applications)?(?!\s+Lab\b)$/i, name: 'Emering Tools and Applications' },
    // A lab cell ("Emering Tools and Applications Lab" / "Emerging … Lab")
    // keeps the full lab name; the display layer renders it as
    // "Emering Tools and Applications [Lab]" via the lab badge.
    { match: /^(?:Emering|Emerging) Tools(?:\s+and\s+|\s*&\s*)Applications Lab\.?$/i, name: 'Emering Tools and Applications Lab' },
    { match: /^CN$/i, name: 'Computer Networks' },
    { match: /^(?:INT|INTT)\s*EMB$/i, name: 'Intelligent Embedded Systems' },
    { match: /^DL$/i, name: 'Deep Learning' },
    { match: /^TOC$/i, name: 'Theory of Computation' },
    { match: /^QML$/i, name: 'Quantum Machine Learning' },
    { match: /^CYBER$/i, name: 'Cybersecurity: Fundamental Concepts and Management' },
    { match: /^COA$/i, name: 'Computer Organization and Architecture' },
    { match: /^IFA$/i, name: 'Introduction to Financial Accounting' },
    { match: /^CT$/i, name: 'Critical Thinking' },
    { match: /^(?:FBO|FOB|Fundamentals of Business Organization and Management)$/i, name: 'Fundamentals of Business Organization & Management' },
    { match: /^(?:PFM|PIFM|Principles of Financial Management|Principles in Financial Management|Introduction to BFSI\s*(?:&|and)\s*Financial Technology|Principles of Financial Management\s*\/\s*Introduction to BFSI\s*(?:&|and)\s*Financial Technology)$/i, name: 'Principles of Financial Management' },
    { match: /^FP$/i, name: 'Forensic Psychology' },

    // SCDS Year 1 mandatory courses. Abbreviations and minor formatting
    // differences in the sheet fold onto the clean course names.
    { match: /^PIC$/i, name: 'Programming in C' },
    { match: /^Programming in C$/i, name: 'Programming in C' },
    { match: /^EFA$/i, name: 'Engineering Foundation and Application' },
    { match: /^Engineering Foundation(?:\s+and|\s*&)\s*Application$/i, name: 'Engineering Foundation and Application' },
    { match: /^AM$/i, name: 'Applied Mathematics' },
    { match: /^Applied Mathematics$/i, name: 'Applied Mathematics' },
    // "Critical Thinking" and "Frontiers of AI" aliases already exist below
    // (shared across SCDS Year 3 / SOT / SOB / SOAI).

    // SOT Year 1 Biotechnology. The sheet may spell these courses with a
    // semester tag ("Indian Constitution & Democracy - Sem1", "Frontiers of
    // AI Sem1", "Sem 1") — the alias drops the tag and folds the spelling
    // onto the clean course name, and "&"↔"and" is normalized exactly like
    // the FBO/PFM courses above.
    { match: /^Indian Constitution\s*(?:&|and)\s*Democracy(?:\s*-\s*Sem(?:ester)?\s*\.?\s*1)?$/i, name: 'Indian Constitution & Democracy' },
    { match: /^Frontiers of AI(?:\s*-?\s*Sem(?:ester)?\s*\.?\s*1)?$/i, name: 'Frontiers of AI' },

    // SAS Year 3 Neuroscience. "Cell Physiology" is the elective course; any
    // "Cell Physiology - Elective" / "Cell Physiology-Elective" dash-spaced
    // spelling left in the sheet folds onto it too. "&"↔"and" is
    // normalized exactly like the FBO/PFM courses above, so "Psychiatry and
    // Mood disorders" and "Psychiatry & Mood disorders" are the same course.
    // "Analytical Methods & Instrumentation" is the live sheet's spelling of
    // the configured "Analytical Methods" course.
    { match: /^Cell Physiology(?:\s*-?\s*Elective)?$/i, name: 'Cell Physiology' },
    { match: /^Analytical Methods(?:\s*&\s*Instrumentation)?$/i, name: 'Analytical Methods' },
    { match: /^Psychiatry\s*(?:&|and)\s*Mood\s*Disorders?$/i, name: 'Psychiatry & Mood disorders' },

    // SAS Year 2 Psychology. The sheet may use abbreviations, spacing
    // differences, "&" vs "and", or minor punctuation variants — the aliases
    // fold them onto the clean canonical names. "Community Psychology" is
    // already handled by the course normalizer (SCDS Year 3 elective).
    { match: /^Psychopathology(?:\s*(?:I{1,3}|IV|V))?$/i, name: 'Psychopathology' },
    { match: /^Psych(?:ology)?\s*(?:Behind|on)\s*(?:Social\s*)?Media$/i, name: 'Psychology Behind Social Media' },
    { match: /^(?:Intro(?:duction)?(?:\s+to)?)?\s*Cognitive\s*Neuroscience$/i, name: 'Introduction to Cognitive Neuroscience' },
    { match: /^Research\s*(?:Method(?:ology|s)?|Methods)$/i, name: 'Research Methodology' },
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
        // A multi-space run INSIDE a course name containing "/" splits at the
        // run and pushes the "/" plus the rest of the name into faculty.
        // Discard the erroneous split so the single-space fallback below can
        // recover the full name and the true teacher.
        if (faculty && /^\//.test(faculty.trim())) {
            subject = text.replace(/\s+/g, ' ').trim();
            faculty = '';
        }
    }

    // Single-space-separated teacher: when neither a dash nor a space-run
    // isolated a teacher, the trailing word(s) may be the teacher glued to the
    // course name (e.g. "Forensic Psychology Dr Mridula").  Try progressively
    // shorter prefixes of the subject to see if any is a known course — the
    // remainder is the teacher. Skipped when the remainder starts with "/":
    // the slash is part of the course name, not a teacher separator.
    if (!faculty && subject) {
        const words = subject.split(/\s+/);
        for (let len = words.length - 1; len >= 2; len--) {
            const prefix = words.slice(0, len).join(' ');
            const res = resolveCourse(prefix);
            if (res && res.matched) {
                const rest = words.slice(len).join(' ');
                if (/^\//.test(rest)) continue;
                faculty = rest;
                subject = prefix;
                break;
            }
        }
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
        const words = subject.split(/\s+/);
        if (words.length >= 3) {
            for (let len = words.length - 1; len >= 2; len--) {
                const prefix = words.slice(0, len).join(' ');
                for (const e of electiveList) {
                    const name = e.label.trim().toLowerCase();
                    if (prefix === name || prefix.startsWith(name)) return e;
                }
            }
        }
        // Canonical fallback: a differently-spelled cell that resolves onto a
        // configured elective's canonical id is that elective. Only reached
        // when label-prefix matching found nothing, so existing matches are
        // never disturbed.
        const res = resolveCourse(subject);
        if (res && res.canonical) {
            for (const e of electiveList) {
                if (e.id === res.canonical) return e;
            }
        }
        return null;
    };

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

        let roomRow = null;
        for (let k = i + 1; k < lines.length; k++) {
            if (!lines[k].trim()) continue;
            roomRow = splitCSVLine(lines[k]);
            break;
        }
        if (!roomRow) continue;

        const slotDedup = new Set();
        for (let j = 0; j < roomRow.length; j++) {
            const roomVal = roomRow[j];
            if (!roomVal) continue;
            const roomKey = normalizeRoom(roomVal);
            if (!roomKey) continue;

            const cell = row[j];
            if (!cell) continue;

            const { subject, faculty, section } = splitClassCell(cell);
            const name = expandSubjectAlias(subject);
            const { base: baseName, isLab } = splitLabSuffix(name);
            const elective = matchElective(baseName.toLowerCase());
            if (section == null && !elective) continue;
            if (!name) continue;

            const dedupKey = `${roomKey}|${name}|${faculty}|${section ?? 1}|${times.start}`;
            if (slotDedup.has(dedupKey)) continue;
            slotDedup.add(dedupKey);

            const roomLabel = String(roomVal).replace(/\s+/g, ' ');

            data.push({
                day: currentDay,
                subject: name,
                faculty: faculty || '',
                room: roomLabel,
                section: section ?? 1,
                startTime: times.start,
                endTime: times.end,
                courseId: elective ? elective.id : resolveCourseId(name),
                ...(elective ? { elective: elective.id, displayName: elective.label } : {}),
                ...(isLab ? { lab: true } : {}),
            });
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

    // A multi-space run INSIDE a course name that contains "/" (e.g.
    // "Management  /  Introduction to BFSI") splits the name at the run,
    // pushing the "/" and the rest of the course into `faculty`.  The "/" is
    // part of the course, not a subject/teacher separator.  Discard the
    // erroneous multi-space split so the single-space / known-course-prefix
    // logic below can recover the full course name and isolate the true
    // teacher.
    if (faculty && /^\//.test(faculty.trim())) {
        subject = text.replace(/\s+/g, ' ').trim();
        faculty = '';
    }

    // "Subject - Teacher" dash format (single or double spaces around the dash,
    // e.g. "Image Processing - Dr Aasy"). Used only when the multi-space split
    // above did not already isolate a teacher, or left the dash glued to the
    // subject ("Law of Insurance -                      Sanjay Bang").
    //
    // When the ENTIRE cell is a known course, the dash is part of the course
    // name, not a subject/teacher separator — "Organizational Psychology -
    // Micro Perspective" keeps its full name and no phantom teacher is
    // invented from the dash.
    if ((!faculty || faculty.trim().startsWith('-')) && /-\s*\S/.test(text) && !resolveCourse(text).matched) {
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

    // Single-space-separated teacher: when neither a space-run nor a dash
    // isolated a teacher, the trailing word(s) may be the teacher glued to the
    // course name (e.g. "Forensic Psychology Dr Mridula").  Try progressively
    // shorter prefixes of the subject to see if any is a known course — the
    // remainder is the teacher. Skipped when the WHOLE subject is already a
    // known course (e.g. "Cell Physiology - Elective"): peeling a prefix here
    // would truncate a legitimate course name and invent a phantom teacher.
    // Also skipped when the remainder starts with "/": the slash is part of
    // the course name (e.g. "Principles in Financial Management /
    // Introduction to BFSI & Financial Technology Ajit Nag"), not a teacher
    // separator.
    if (!faculty && subject && !resolveCourse(subject).matched) {
        const words = subject.split(/\s+/);
        for (let len = words.length - 1; len >= 2; len--) {
            const prefix = words.slice(0, len).join(' ');
            const res = resolveCourse(prefix);
            if (res && res.matched) {
                const rest = words.slice(len).join(' ');
                if (/^\//.test(rest)) continue;
                faculty = rest;
                subject = prefix;
                break;
            }
        }
    }

    // A space-run INSIDE a course name truncates the subject at the run and
    // pushes the tail of the name into the faculty, e.g.
    //   "Fundamentals of Business Organization  & Management  Subramaniam"
    // → subject "Fundamentals of Business Organization", faculty "& Management
    // Subramaniam". When the isolated subject is not a known course but a
    // longer prefix of the collapsed cell is, re-split on the known-course
    // boundary so the full course name survives as the subject and the true
    // teacher is isolated.
    if (faculty && subject && !resolveCourse(subject).matched) {
        const collapsed = text.replace(/\s+/g, ' ').trim();
        const words = collapsed.split(/\s+/);
        const subjectLen = subject.split(/\s+/).length;
        for (let len = words.length - 1; len >= 2; len--) {
            const prefix = words.slice(0, len).join(' ');
            const res = resolveCourse(prefix);
            if (res && res.matched && len > subjectLen) {
                const remainder = words.slice(len).join(' ');
                if (remainder) {
                    subject = prefix;
                    faculty = remainder;
                    break;
                }
            }
        }
    }

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
        // "Sem N" in parens ("(Sem 1)") is the same semester marker as the
        // dash form above; drop it too.
        .replace(/\s*\(\s*Sem(?:ester)?\s*\.?\s*\d+\s*\)\s*/gi, ' ')
        // Bare "Sem N" without dashes or parens (e.g. "Frontiers of AI
        // Sem 1 Dr Pankaj Jain") — strip the semester token entirely.
        .replace(/\bSem(?:ester)?\s*\.?\s*\d+\b/gi, ' ')
        // Shared-course qualifier used by the main sheet: "Critical Thinking
        // (SAS/SoAI/SoB/SoT/SCDS)" means the course is shared across schools —
        // the school list is not part of the course name.
        .replace(/\s*\(\s*(?:SAS|SoAI|SoB|SoT|SCDS)(?:\s*\/\s*(?:SAS|SoAI|SoB|SoT|SCDS))*\s*\)\s*/gi, ' ')
        // Whitespace-only parens ("Labour Law 2 (    )") are an empty faculty
        // placeholder, never a subject. Drop them so they don't split the cell.
        .replace(/\s*\(\s*\)\s*/g, ' ')
        .trim();
}

// ============================================================
// Room-occupancy parser — scans the ENTIRE timetable CSV without
// any school/year/section/elective filtering.
//
// For every time-slot row followed by a room-declaration row, each
// column where BOTH the class cell and the room cell are non-empty
// is recorded as an occupied room for that day + time slot.
//
// This is the data source for the Free Rooms feature, which needs
// to know about ALL classes across ALL schools/years — not just
// the ones relevant to the currently selected year config.
// ============================================================

/**
 * Parse raw CSV into a flat list of room-occupancy records.
 *
 * @param {string} text raw CSV timetable content
 * @returns {Array<{room: string, day: string, startTime: string, endTime: string}>}
 */
export function parseRoomOccupancy(text) {
    const lines = text.split(/\r?\n/);
    const data = [];
    let currentDay = null;

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

        // The next non-empty line is the room-declaration row.
        let roomRow = null;
        for (let k = i + 1; k < lines.length; k++) {
            if (!lines[k].trim()) continue;
            roomRow = splitCSVLine(lines[k]);
            break;
        }
        if (!roomRow) continue;

        for (let j = 0; j < roomRow.length; j++) {
            const roomVal = roomRow[j];
            if (!roomVal) continue;
            const roomLabel = String(roomVal).replace(/\s+/g, ' ').trim();
            if (!roomLabel) continue;

            const cell = row[j];
            if (!cell) continue;

            data.push({
                room: roomLabel,
                day: currentDay,
                startTime: times.start,
                endTime: times.end,
            });
        }
    }
    return data;
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
        // app can show them only when the student selects them. Matching uses
        // the lab-stripped base name plus a canonical fallback, so a "… Lab"
        // cell or a differently-spelled name still finds its elective.
        const { base: baseName, isLab } = splitLabSuffix(subject);
        let elective = null;
        let electiveLabel = null;
        if (electiveList) {
            const subjLower = baseName.trim().toLowerCase();
            for (const e of electiveList) {
                const name = e.label.trim().toLowerCase();
                if (subjLower === name || subjLower.startsWith(name)) {
                    elective = e.id;
                    electiveLabel = e.label;
                    break;
                }
            }
            if (!elective) {
                const res = resolveCourse(baseName);
                if (res && res.canonical) {
                    for (const e of electiveList) {
                        if (e.id === res.canonical) { elective = e.id; electiveLabel = e.label; break; }
                    }
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
            ...(elective ? { elective, displayName: electiveLabel } : {}),
            ...(isLab ? { lab: true } : {}),
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
            // A multi-space run INSIDE a course name containing "/" splits at
            // the run and pushes the "/" plus the rest of the name into
            // faculty.  Discard the erroneous split so the single-space
            // fallback below can recover the full name and the true teacher.
            if (faculty && /^\//.test(faculty.trim())) {
                subject = text.replace(/\s+/g, ' ').trim();
                faculty = '';
            }
        } else {
            // 3. Dash separation: "Subject - Teacher" (single spaces). A
            //    trailing course number ("Economics - 1") is not a teacher.
            //    When the whole cell is a known course, the dash is part of
            //    the course name ("Organizational Psychology - Micro
            //    Perspective") and must not invent a phantom teacher.
            const dash = text.match(/\s-\s(.+)$/);
            if (dash && !/^\d+$/.test(dash[1].trim()) && !resolveCourse(text).matched) {
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

    // Single-space-separated teacher: when neither a space-run, dash, nor
    // parenthesized teacher isolated a faculty, the trailing word(s) may be
    // the teacher glued to the course name.  Try progressively shorter
    // prefixes of the subject to see if any is a known course. Skipped when
    // the remainder starts with "/": the slash is part of the course name,
    // not a teacher separator.
    if (!faculty && subject) {
        const words = subject.split(/\s+/);
        for (let len = words.length - 1; len >= 2; len--) {
            const prefix = words.slice(0, len).join(' ');
            const res = resolveCourse(prefix);
            if (res && res.matched) {
                const rest = words.slice(len).join(' ');
                if (/^\//.test(rest)) continue;
                faculty = rest;
                subject = prefix;
                break;
            }
        }
    }

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
            const { isLab } = splitLabSuffix(name);
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
                ...(isLab ? { lab: true } : {}),
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
