import { loadTeacherIndex } from '../js/services/teacher-fetch.js';

async function main() {
    console.log('Testing loadTeacherIndex()...');
    const resIdx = await loadTeacherIndex({ useCache: false });
    if (!resIdx) {
        console.error('loadTeacherIndex returned null!');
        return;
    }
    console.log('Total teachers in index:', resIdx.order.length);

    let solTeachers = [];
    for (const key of resIdx.order) {
        const teacher = resIdx.index.get(key);
        const solCls = teacher.classes.filter(c => (c.contexts || []).some(ctx => ctx.includes('SOL')));
        if (solCls.length > 0) {
            solTeachers.push({ key, name: teacher.name, solCount: solCls.length, totalCount: teacher.classes.length });
        }
    }
    console.log('\nTeachers with SOL classes according to loadTeacherIndex():', solTeachers);
}

main().catch(err => console.error(err));
