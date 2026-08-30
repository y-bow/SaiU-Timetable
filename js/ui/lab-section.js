import { getStoredLabSection, setStoredLabSection, getStoredLabGroup, setStoredLabGroup } from '../services/storage.js?v=2026-08-30-010';
import { isYear2SCDS } from '../data/lab-config.js?v=2026-08-30-010';

/**
 * Lab-group selector state + UI for Year 2 SCDS.
 *
 * SCDS Year 2 splits its mandatory labs (DAA, FDE) across lab sections 1-8.
 * The student's classroom section (1-7) and their lab grouping are separate
 * ideas, but the selector offers exactly two lab-group choices:
 *
 *   "same"     — "Same section as above": the student's lab section follows
 *                their normal SCDS section (Section 3 + Same → lab section 3).
 *                This is a UI shortcut resolved at render time — it is never
 *                stored or treated as an actual timetable section number, so
 *                changing the normal section moves the lab with it.
 *   "section8" — "Section 8 — Combined Lab": the special lab grouping pulling
 *                students from across the normal sections (lab section 8). It
 *                stays on 8 regardless of the normal section because the user
 *                chose the combined group explicitly.
 *
 * Only "same" follows the normal section; the combined-lab choice is fixed.
 * Changes dispatch a `labgroupchange` event so the app re-renders.
 */

// Special lab-group values. The combined-lab section number is fixed by the
// sheet layout.
export const LAB_GROUP_SAME = 'same';
export const LAB_GROUP_SECTION8 = 'section8';
const COMBINED_LAB_SECTION = 8;

const GROUPS = [LAB_GROUP_SAME, LAB_GROUP_SECTION8];

let selected = getStoredLabGroup();

/**
 * Migrate a legacy numeric lab-section preference (1-8) to a lab group.
 * Existing users are migrated in place, never reset:
 *
 *   - old lab section 8   → "section8" (combined lab)
 *   - old lab section 1-7 → "same", whether or not it happened to equal the
 *                           normal section. Under the new model a regular lab
 *                           section always equals the classroom section, so
 *                           "same" is the only faithful non-combined choice.
 *   - no stored preference → "same" default.
 *
 * Already-migrated groups (the only two valid values) pass through untouched.
 */
export function migrateStoredLabGroup() {
    if (GROUPS.includes(selected)) return;

    const legacy = getStoredLabSection();
    if (legacy != null) {
        selected = legacy === COMBINED_LAB_SECTION ? LAB_GROUP_SECTION8 : LAB_GROUP_SAME;
        setStoredLabSection(null); // drop the legacy key once migrated
    } else {
        selected = LAB_GROUP_SAME;
    }
    setStoredLabGroup(selected);
}

export function getLabGroup() {
    return selected;
}

export function setLabGroup(group) {
    if (!GROUPS.includes(group)) return;
    if (group === selected) return;
    selected = group;
    setStoredLabGroup(group);
    window.dispatchEvent(new CustomEvent('labgroupchange', { detail: { group } }));
}

/**
 * Resolve the lab-group choice into an actual lab section number.
 *
 *   "same"     → the currently selected normal section
 *   "section8" → 8 (the combined lab)
 */
export function getResolvedLabSection(normalSection) {
    if (selected === LAB_GROUP_SECTION8) return COMBINED_LAB_SECTION;
    return normalSection;
}

/**
 * Render the lab-group radio list into `#sidebar-lab-sections` and toggle the
 * wrapper's visibility. Only SCDS Year 2 shows the selector.
 */
export function renderLabGroups(yearConfig) {
    const wrapper = document.querySelector('#sidebar-lab-section-wrapper');
    const container = document.querySelector('#sidebar-lab-sections');
    if (!wrapper || !container) return;

    const show = isYear2SCDS(yearConfig);
    wrapper.classList.toggle('hidden', !show);
    if (!show) return;

    const options = [
        { value: LAB_GROUP_SAME, label: 'Same section as above' },
        { value: LAB_GROUP_SECTION8, label: 'Section 8 \u2014 Combined Lab' },
    ];
    const sig = options.map((o) => o.value).join(',');
    if (container.dataset.sig !== sig) {
        container.innerHTML = '';
        container.dataset.sig = sig;
        for (const opt of options) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'sidebar-item' + (opt.value === selected ? ' active' : '');
            btn.dataset.group = opt.value;
            btn.setAttribute('role', 'radio');
            btn.setAttribute('aria-checked', opt.value === selected ? 'true' : 'false');
            btn.setAttribute('aria-label', opt.label);
            btn.innerHTML = `<span class="sidebar-item-radio"></span><span class="sidebar-item-label">${opt.label}</span>`;
            btn.addEventListener('click', () => setLabGroup(opt.value));
            container.appendChild(btn);
        }
    }
    for (const btn of container.children) {
        const active = btn.dataset.group === selected;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-checked', active ? 'true' : 'false');
    }
}