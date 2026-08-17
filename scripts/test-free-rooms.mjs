#!/usr/bin/env node
/**
 * Debug harness for Free Rooms feature.
 *
 * Fetches the real Google Sheet, parses it with the room-scoped parser,
 * and traces room occupancy for specific time slots.
 *
 * Usage:  node scripts/test-free-rooms.mjs
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Inline the parser functions we need (avoids browser-only imports) ──

const DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];

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
    { match: /^FBO|FOB$/i, name: 'Fundamentals of Business Organization & Management' },
    { match: /^FP$/i, name: 'Forensic Psychology' },
];

function normalizeRoom(name) {
    return String(name ?? '')
        .toUpperCase()
        .replace(/-/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function expandSubjectAlias(subject) {
    const s = String(subject ?? '').trim();
    if (!s) return s;
    for (const alias of SUBJECT_ALIASES) {
        if (alias.match.test(s)) return alias.name;
    }
    return s;
}

function extractSection(text) {
    const m = String(text ?? '').match(/Sec\s*\.?\s*(\d+)/i);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return Number.isFinite(n) && n > 0 ? n : null;
}

function stripSectionMarkers(text) {
    return String(text ?? '')
        .replace(/\s*\(Sec\s*\.?\s*\d+\)\s*/gi, ' ')
        .replace(/\s*-\s*[Ss]ec\s*\.?\s*\d+\s*-?\s*/g, ' - ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeFacultyName(faculty) {
    const raw = String(faculty ?? '').trim();
    if (!raw) return raw;
    let name = raw;
    name = name.replace(/^(Dr|Prof|Ms|Mr|Mrs|Miss)(?:\.\s*|\s+)/i, (m, title) => {
        return title.charAt(0).toUpperCase() + title.slice(1).toLowerCase() + '.';
    });
    if (!/^Prof\.\s/i.test(name)) name = `Prof. ${name}`;
    return name;
}

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
    if (!faculty && subject) {
        const words = subject.split(/\s+/);
        for (let len = words.length - 1; len >= 2; len--) {
            const prefix = words.slice(0, len).join(' ');
            if (prefix.length > 3) {
                // Simple heuristic: if the prefix looks like a course name
                faculty = words.slice(len).join(' ');
                subject = prefix;
                break;
            }
        }
    }
    return { subject, faculty: normalizeFacultyName(faculty), section };
}

function splitCSVLine(line) {
    return line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map(cell => cell.replace(/^"|"$/g, '').trim());
}

function parseTimeRange(text) {
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

// ── Parser: CURRENT (only emits sectioned/elective classes) ──

function parseGridCSVRooms_CURRENT(text, electives = null) {
    const lines = text.split(/\r?\n/);
    const data = [];
    let currentDay = null;
    const electiveList = electives && electives.length ? electives : null;

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

        for (let j = 0; j < roomRow.length; j++) {
            const roomVal = roomRow[j];
            if (!roomVal) continue;
            const roomKey = normalizeRoom(roomVal);
            if (!roomKey) continue;

            const cell = row[j];
            if (!cell) continue;

            const { subject, faculty, section } = splitClassCell(cell);
            const name = expandSubjectAlias(subject);

            // CURRENT FILTER: only sectioned or elective
            let elective = null;
            if (electiveList) {
                const nameLower = name.toLowerCase();
                for (const e of electiveList) {
                    const eName = e.label.trim().toLowerCase();
                    if (nameLower === eName || nameLower.startsWith(eName)) { elective = e.id; break; }
                }
            }
            if (section == null && !elective) continue;
            if (!name) continue;

            const roomLabel = String(roomVal).replace(/\s+/g, ' ');
            data.push({
                day: currentDay,
                subject: name,
                faculty: faculty || '',
                room: roomLabel,
                section: section ?? 1,
                startTime: times.start,
                endTime: times.end,
                _line: i + 1,
                _col: j + 1,
                _rawCell: cell,
            });
        }
    }
    return data;
}

// ── Parser: FIX (emits ALL classes with rooms) ──

function parseGridCSVRooms_FIXED(text, electives = null) {
    const lines = text.split(/\r?\n/);
    const data = [];
    let currentDay = null;
    const electiveList = electives && electives.length ? electives : null;

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

        for (let j = 0; j < roomRow.length; j++) {
            const roomVal = roomRow[j];
            if (!roomVal) continue;
            const roomKey = normalizeRoom(roomVal);
            if (!roomKey) continue;

            const cell = row[j];
            if (!cell) continue;

            const { subject, faculty, section } = splitClassCell(cell);
            const name = expandSubjectAlias(subject);
            if (!name) continue;

            // FIX: emit ALL classes regardless of section/elective status

            let elective = null;
            if (electiveList) {
                const nameLower = name.toLowerCase();
                for (const e of electiveList) {
                    const eName = e.label.trim().toLowerCase();
                    if (nameLower === eName || nameLower.startsWith(eName)) { elective = e.id; break; }
                }
            }

            const roomLabel = String(roomVal).replace(/\s+/g, ' ');
            data.push({
                day: currentDay,
                subject: name,
                faculty: faculty || '',
                room: roomLabel,
                section: section ?? 1,
                startTime: times.start,
                endTime: times.end,
                _line: i + 1,
                _col: j + 1,
                _rawCell: cell,
            });
        }
    }
    return data;
}

// ── Free Rooms logic (same as free-rooms.js) ──

function toMinutes(timeStr) {
    const [h, m] = timeStr.split(':').map(Number);
    return h * 60 + m;
}

function discoverRooms(classes) {
    const roomMap = new Map();
    for (const c of classes) {
        const room = String(c.room ?? '').trim();
        if (!room) continue;
        const key = normalizeRoom(room);
        if (!roomMap.has(key)) roomMap.set(key, room);
    }
    return roomMap;
}

function getOccupiedRooms(classes, day, startMin, endMin) {
    const occupied = new Map();
    for (const c of classes) {
        if (c.day !== day) continue;
        const cStart = toMinutes(c.startTime);
        const cEnd = toMinutes(c.endTime);
        if (cStart < endMin && cEnd > startMin) {
            const key = normalizeRoom(c.room);
            if (!occupied.has(key)) {
                occupied.set(key, {
                    room: c.room,
                    subject: c.subject,
                    faculty: c.faculty,
                    startTime: c.startTime,
                    endTime: c.endTime,
                    section: c.section,
                    _rawCell: c._rawCell,
                    _line: c._line,
                    _col: c._col,
                });
            }
        }
    }
    return occupied;
}

function minutesToClock(totalMinutes) {
    const t = totalMinutes % (24 * 60);
    const h = Math.floor(t / 60);
    const min = t % 60;
    const meridiem = h >= 12 ? 'PM' : 'AM';
    const hour12 = h % 12 === 0 ? 12 : h % 12;
    return `${hour12}:${String(min).padStart(2, '0')} ${meridiem}`;
}

// ── All known rooms from user's list ──

const ALL_KNOWN_ROOMS = [
    'AB1 - 101', 'AB1 - 102', 'AB1 - 103', 'AB1 - 104', 'AB1 - 201',
    'AB1 - Moot Court Hall',
    'AB2 - 101', 'AB2 - 201', 'AB2 - 202', 'AB2 - 203', 'AB2 - 204',
    'AB2 - 205', 'AB2 - 206', 'AB2 - 207', 'AB2 - 208', 'AB2 - 209',
    'AB2 - 210', 'AB2 - 211',
];

// ── Main ──

async function main() {
    const SHEET_ID = '1Jk3KCLqHHzi-jxigIcPpcXZestcxb8Y0BeQLjhiezb8';
    const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=0`;

    console.log('Fetching timetable from Google Sheets...');
    let csvText;
    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        csvText = await res.text();
        console.log(`Fetched ${csvText.length} bytes\n`);
    } catch (err) {
        console.error('Failed to fetch:', err.message);
        console.log('\nFalling back to local cache if available...');
        try {
            csvText = readFileSync(resolve(__dirname, '..', 'debug-timetable.csv'), 'utf-8');
            console.log(`Loaded ${csvText.length} bytes from local cache\n`);
        } catch {
            console.error('No local cache found. Exiting.');
            process.exit(1);
        }
    }

    const electives = [
        { id: 'intelligent-embedded-systems', label: 'Intelligent Embedded Systems' },
        { id: 'emerging-tools-and-applications', label: 'Emerging Tools and Applications' },
        { id: 'fundamentals-of-business-organization-and-management', label: 'Fundamentals of Business Organization & Management' },
        { id: 'forensic-psychology', label: 'Forensic Psychology' },
    ];

    // ── Parse with CURRENT parser ──
    const currentClasses = parseGridCSVRooms_CURRENT(csvText, electives);
    console.log(`=== CURRENT PARSER: ${currentClasses.length} classes parsed ===\n`);

    // ── Parse with FIXED parser ──
    const fixedClasses = parseGridCSVRooms_FIXED(csvText, electives);
    console.log(`=== FIXED PARSER: ${fixedClasses.length} classes parsed ===\n`);

    // ── Trace specific slots ──
    const slots = [
        { label: 'Monday 9:15 AM – 10:10 AM', day: 'Monday', startMin: 9 * 60 + 15, endMin: 10 * 60 + 10 },
        { label: 'Monday 10:15 AM – 11:10 AM', day: 'Monday', startMin: 10 * 60 + 15, endMin: 11 * 60 + 10 },
        { label: 'Monday 2:00 PM – 2:55 PM', day: 'Monday', startMin: 14 * 60, endMin: 14 * 60 + 55 },
    ];

    for (const slot of slots) {
        console.log('='.repeat(80));
        console.log(`SLOT: ${slot.label}`);
        console.log('='.repeat(80));

        const currentOccupied = getOccupiedRooms(currentClasses, slot.day, slot.startMin, slot.endMin);
        const fixedOccupied = getOccupiedRooms(fixedClasses, slot.day, slot.startMin, slot.endMin);
        const currentRooms = discoverRooms(currentClasses);
        const fixedRooms = discoverRooms(fixedClasses);

        console.log(`\nRooms discovered by CURRENT parser: ${currentRooms.size}`);
        for (const [key, display] of currentRooms) {
            console.log(`  ${display}`);
        }

        console.log(`\nRooms discovered by FIXED parser: ${fixedRooms.size}`);
        for (const [key, display] of fixedRooms) {
            console.log(`  ${display}`);
        }

        // Show all known rooms with occupancy info
        console.log(`\n${'─'.repeat(80)}`);
        console.log('OCCUPANCY TABLE (all known rooms):');
        console.log(`${'─'.repeat(80)}`);
        console.log(
            'Room'.padEnd(28) +
            'Current Parser'.padEnd(18) +
            'Fixed Parser'.padEnd(18) +
            'Source Class'
        );
        console.log(`${'─'.repeat(80)}`);

        for (const room of ALL_KNOWN_ROOMS) {
            const nKey = normalizeRoom(room);
            const curOcc = currentOccupied.get(nKey);
            const fixOcc = fixedOccupied.get(nKey);
            const curStatus = curOcc ? 'OCCUPIED' : 'free';
            const fixStatus = fixOcc ? 'OCCUPIED' : 'free';
            const source = fixOcc
                ? `${fixOcc.subject} (${fixOcc.faculty}) [L${fixOcc._line}:C${fixOcc._col}]`
                : curOcc
                    ? `${curOcc.subject} (${curOcc.faculty}) [L${curOcc._line}:C${curOcc._col}]`
                    : '-';

            const mismatch = (curStatus !== fixStatus) ? ' *** MISMATCH ***' : '';
            console.log(
                `${room.padEnd(28)}${curStatus.padEnd(18)}${fixStatus.padEnd(18)}${source}${mismatch}`
            );
        }

        // Summary
        const currentFree = ALL_KNOWN_ROOMS.filter(r => !currentOccupied.has(normalizeRoom(r)));
        const fixedFree = ALL_KNOWN_ROOMS.filter(r => !fixedOccupied.has(normalizeRoom(r)));

        console.log(`\nCURRENT parser free rooms: ${currentFree.join(', ')}`);
        console.log(`FIXED parser free rooms:   ${fixedFree.join(', ')}`);

        // Rooms that CURRENT says are free but FIXED says are occupied
        const wronglyFree = fixedFree.filter(r => !currentFree.includes(r));
        if (wronglyFree.length) {
            console.log(`\n*** ROOMS CURRENTLY REPORTED AS FREE BUT ACTUALLY OCCUPIED: ${wronglyFree.join(', ')} ***`);
        }

        console.log('\n');
    }

    // ── Show Monday 9:15-10:10 in detail ──
    console.log('='.repeat(80));
    console.log('DETAILED TRACE: Monday 9:15 AM – 10:10 AM');
    console.log('='.repeat(80));

    const slot = slots[0];
    const fixedOccupied = getOccupiedRooms(fixedClasses, slot.day, slot.startMin, slot.endMin);

    console.log('\nAll rooms with classes during this slot (from FIXED parser):');
    for (const [key, info] of fixedOccupied) {
        console.log(`  ${info.room}`);
        console.log(`    Subject: ${info.subject}`);
        console.log(`    Faculty: ${info.faculty}`);
        console.log(`    Time: ${info.startTime}–${info.endTime}`);
        console.log(`    Section: ${info.section}`);
        console.log(`    Raw cell: ${info._rawCell}`);
        console.log(`    Source: line ${info._line}, col ${info._col}`);
    }

    // Show rooms NOT occupied
    const notOccupied = ALL_KNOWN_ROOMS.filter(r => !fixedOccupied.has(normalizeRoom(r)));
    console.log(`\nRooms NOT occupied (truly free): ${notOccupied.join(', ')}`);
}

main().catch(console.error);
