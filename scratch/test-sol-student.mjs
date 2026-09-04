import { buildYearMap } from '../js/data/schools.js';
import { parseCSV } from '../js/data/parser.js';

async function main() {
    const yearMap = buildYearMap();
    const solYear = yearMap.get('sol-3');
    console.log('SOL Year 3 config:', solYear.year);

    const sheetId = '1Jk3KCLqHHzi-jxigIcPpcXZestcxb8Y0BeQLjhiezb8';
    const url = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=0`;
    const res = await fetch(url);
    const text = await res.text();

    const mandatoryCourses = solYear.year.mandatoryCourses;
    const electives = solYear.year.electives;

    const classes = parseCSV(text, 'grid', mandatoryCourses, electives, null);
    console.log('\n--- STUDENT TIMETABLE CLASSES RETURNED FOR SOL YEAR 3 ---');
    console.log('Total classes:', classes.length);
    classes.forEach(c => {
        console.log(`- ${c.day} ${c.startTime}-${c.endTime} | "${c.subject}" | Faculty: "${c.faculty}" | Room: "${c.room}"`);
    });
}

main().catch(err => console.error(err));
