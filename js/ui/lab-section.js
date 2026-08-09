import { getStoredLabSection, setStoredLabSection } from '../services/storage.js?v=2026-08-09-008';
import { isYear2SCDS } from '../data/lab-config.js?v=2026-08-09-008';

/**
 * Lab-section selector state + UI.
 *
 * SCDS Year 2 splits its mandatory labs (DAA, FDE) across lab sections 1-8,
 * which are INDEPENDENT of the student's classroom section (1-7). This module
 * owns the selected lab section, persists it, and renders the radio list in
 * the sidebar. Changes dispatch a `labchange` event so the app re-renders.
 */

// The lab sections the Year 2 lab tabs may key. Fixed by the sheet layout.
const LAB_SECTION_COUNT = 8;

let selected = getStoredLabSection() ?? 1;

export function getLabSection() {
    return selected;
}

export function setLabSection(section) {
    if (section === selected) return;
    selected = section;
    setStoredLabSection(section);
    window.dispatchEvent(new CustomEvent('labchange', { detail: { section } }));
}

/**
 * Render the lab-section radio list into `#sidebar-lab-sections` and toggle
 * the wrapper's visibility. Only SCDS Year 2 shows the selector.
 */
export function renderLabSections(yearConfig) {
    const wrapper = document.querySelector('#sidebar-lab-section-wrapper');
    const container = document.querySelector('#sidebar-lab-sections');
    if (!wrapper || !container) return;

    const show = isYear2SCDS(yearConfig);
    wrapper.classList.toggle('hidden', !show);
    if (!show) return;

    const labels = Array.from({ length: LAB_SECTION_COUNT }, (_, i) => i + 1);
    const sig = labels.join(',');
    if (container.dataset.sig !== sig) {
        container.innerHTML = '';
        container.dataset.sig = sig;
        for (const s of labels) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'sidebar-item';
            btn.dataset.section = s;
            btn.setAttribute('role', 'radio');
            btn.setAttribute('aria-label', `Lab Section ${s}`);
            btn.innerHTML = `<span class="sidebar-item-radio"></span><span class="sidebar-item-label">Section ${s}</span>`;
            btn.addEventListener('click', () => setLabSection(s));
            container.appendChild(btn);
        }
    }
    for (const btn of container.children) {
        const active = Number(btn.dataset.section) === selected;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-checked', active ? 'true' : 'false');
    }
}