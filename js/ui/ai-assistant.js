import { isAiEnabled, askTimetableAI } from '../services/timetable-ai.js?v=2026-08-13-005';
import { trackEvent } from '../services/analytics.js?v=2026-08-13-005';

/**
 * "Ask SaiU AI" — chat panel.
 *
 * Renders an "Ask AI" launch button (mobile top bar + sidebar footer, plus the
 * teacher page's top bar) and a right-drawer chat panel. Questions are sent
 * to the n8n timetable-AI webhook with the LIVE parsed timetable (see
 * js/services/timetable-ai.js); this module only renders the response. It
 * never calculates free periods or conflicts — n8n does that.
 *
 * The whole feature is inert when isAiEnabled() is false: no DOM, no buttons,
 * no network requests, so production/GitHub Pages is completely unaffected.
 * One configuration change (flip CONFIG.AI_FEATURE_ENABLED) enables it.
 *
 * The AI-provider answer is rendered naturally; common-free-time data is
 * formatted into readable sentences ("Both SCDS Section 3 and SOAI Section 2
 * are free on Wednesday from 12:00 PM to 1:00 PM."), never raw JSON. Errors
 * are always shown as a friendly generic message.
 */

const $ = (sel) => document.querySelector(sel);

const GENERIC_ERROR = "I couldn't reach SaiU AI right now. Please try again.";

const SUGGESTED_QUESTIONS = [
    "What's my next class?",
    'When is Deep Learning?',
    'When is SCDS Section 3 free?',
    'When are SCDS 3 and SCDS 2 both free?',
    'What changed today?',
];

const TEACHER_SUGGESTED_QUESTIONS = [
    'What classes does Dr. Tamilarasi have today?',
    "When is Prof. Salim free?",
    'Where is Prof. Arjun teaching?',
    'Who teaches Deep Learning?',
];

// Live data accessors — wired in by the app (js/core/app.js) so the module
// always sends the currently parsed timetable + navigation context.
let getClasses = () => [];
let getContext = () => ({});

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

const svg = (inner, size = 16) =>
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

const SPARK_ICON = svg('<path d="M12 3l2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4z"/>', 15);
const CLOSE_ICON = svg('<path d="M18 6 6 18M6 6l12 12"/>', 18);
const SEND_ICON = svg('<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>', 16);

let panel = null;
let messagesEl = null;
let suggestionsEl = null;
let inputEl = null;
let sendBtn = null;
let focusTrapCleanup = null;
let lastFocused = null;
let pending = false;
let welcomed = false;

// ============================================================
// DOM construction
// ============================================================

function ensureDom() {
    if (panel) return;
    document.body.insertAdjacentHTML('beforeend', `
        <div id="ai-panel" class="ai-panel" role="dialog" aria-modal="true" aria-labelledby="ai-title" aria-hidden="true">
            <div class="ai-backdrop" data-ai-close></div>
            <div class="ai-sheet">
                <header class="ai-header">
                    <div class="ai-heading">
                        <h2 id="ai-title" class="ai-title"><span class="ai-spark">${SPARK_ICON}</span>SaiU AI</h2>
                        <p class="ai-subtitle">Ask anything about your timetable</p>
                    </div>
                    <button type="button" id="ai-close-btn" class="icon-btn" aria-label="Close AI assistant">${CLOSE_ICON}</button>
                </header>
                <div id="ai-messages" class="ai-messages" role="log" aria-live="polite" aria-relevant="additions"></div>
                <div id="ai-suggestions" class="ai-suggestions" aria-label="Suggested questions"></div>
                <form id="ai-form" class="ai-input-bar" novalidate>
                    <input id="ai-input" class="ai-input" type="text" placeholder="Ask about your timetable…" autocomplete="off" enterkeyhint="send" aria-label="Ask about your timetable">
                    <button type="submit" id="ai-send-btn" class="ai-send-btn" aria-label="Send question">${SEND_ICON}</button>
                </form>
            </div>
        </div>`);

    panel = $('#ai-panel');
    messagesEl = $('#ai-messages');
    suggestionsEl = $('#ai-suggestions');
    inputEl = $('#ai-input');
    sendBtn = $('#ai-send-btn');
    const closeBtn = $('#ai-close-btn');
    const backdrop = panel.querySelector('.ai-backdrop');
    const formEl = $('#ai-form');

    closeBtn.addEventListener('click', closePanel);
    backdrop.addEventListener('click', closePanel);
    formEl.addEventListener('submit', (e) => {
        e.preventDefault();
        sendQuestion(inputEl.value);
    });
    inputEl.addEventListener('input', updateSendState);
}

function ensureLaunchButtons() {
    const topbar = document.querySelector('.mobile-topbar');
    if (topbar && !document.querySelector('#ai-launch-topbar')) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.id = 'ai-launch-topbar';
        btn.className = 'icon-btn ai-topbar-btn';
        btn.setAttribute('aria-label', 'Ask SaiU AI');
        btn.setAttribute('aria-haspopup', 'dialog');
        btn.innerHTML = SPARK_ICON;
        btn.addEventListener('click', openPanel);
        topbar.insertBefore(btn, document.querySelector('#refresh-btn-mobile') || null);
    }

    const footer = document.querySelector('.sidebar-footer');
    if (footer && !document.querySelector('#ai-launch-sidebar')) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.id = 'ai-launch-sidebar';
        btn.className = 'ai-launch-btn';
        btn.setAttribute('aria-haspopup', 'dialog');
        btn.innerHTML = `${SPARK_ICON}<span>Ask AI</span>`;
        btn.addEventListener('click', openPanel);
        footer.insertBefore(btn, footer.firstChild);
    }

    // Teacher page (teachers.html): a chat button in the top-right action
    // row. The whole week (all schools/years + labs, stamped with school/year
    // by teacher-fetch.js) is sent, so "What classes does Dr. X have today?"
    // works exactly like the student questions.
    const teacherTopbar = document.querySelector('.teacher-topbar');
    if (teacherTopbar && !document.querySelector('#ai-launch-teacher')) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.id = 'ai-launch-teacher';
        btn.className = 'icon-btn ai-topbar-btn';
        btn.setAttribute('aria-label', 'Ask SaiU AI');
        btn.setAttribute('aria-haspopup', 'dialog');
        btn.innerHTML = SPARK_ICON;
        btn.addEventListener('click', openPanel);
        const actions = teacherTopbar.querySelector('.teacher-topbar-actions');
        const refresh = document.querySelector('#teacher-refresh');
        if (actions && refresh && actions.contains(refresh)) {
            actions.insertBefore(btn, refresh);
        } else {
            (actions || teacherTopbar).appendChild(btn);
        }
    }
}

// ============================================================
// Open / close
// ============================================================

function openPanel() {
    if (!panel || panel.classList.contains('open')) return;
    lastFocused = document.activeElement;
    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    focusTrapCleanup = trapFocus(panel, closePanel);
    if (!welcomed) {
        welcomed = true;
        addMessage('ai', "Hi! Ask me anything about your timetable — like “When is my next class?” or “What rooms might be free?”.");
    }
    inputEl.focus();
    trackEvent('ai_assistant_opened');
}

function closePanel() {
    if (!panel || !panel.classList.contains('open')) return;
    panel.classList.remove('open');
    panel.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    if (focusTrapCleanup) {
        focusTrapCleanup();
        focusTrapCleanup = null;
    }
    if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus();
}

function trapFocus(container, onEscape) {
    function handler(e) {
        if (e.key === 'Escape') { e.preventDefault(); onEscape(); return; }
        if (e.key !== 'Tab') return;
        const focusable = container.querySelectorAll('button:not([disabled]), input:not([disabled])');
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey) {
            if (document.activeElement === first) { e.preventDefault(); last.focus(); }
        } else {
            if (document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
    }
    container.addEventListener('keydown', handler);
    return () => container.removeEventListener('keydown', handler);
}

// ============================================================
// Messages
// ============================================================

function scrollToBottom() {
    if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addMessage(role, contentHtml) {
    const wrap = document.createElement('div');
    wrap.className = `ai-msg ai-msg-${role}`;
    wrap.innerHTML = contentHtml;
    messagesEl.appendChild(wrap);
    scrollToBottom();
}

function showThinking() {
    const el = document.createElement('div');
    el.className = 'ai-msg ai-msg-thinking';
    el.dataset.thinking = '1';
    el.innerHTML = '<span class="ai-dots"><i></i><i></i><i></i></span>Thinking…';
    messagesEl.appendChild(el);
    scrollToBottom();
    setPending(true);
}

function removeThinking() {
    const el = messagesEl && messagesEl.querySelector('[data-thinking]');
    if (el) el.remove();
}

function setPending(value) {
    pending = !!value;
    updateSendState();
    for (const chip of suggestionsEl.querySelectorAll('.ai-chip')) chip.disabled = pending;
}

// Reflect the current state (request in flight / empty input) on the Send
// button, so duplicate submits from Enter or rapid clicks are impossible.
function updateSendState() {
    if (!sendBtn) return;
    sendBtn.disabled = pending || !inputEl.value.trim();
}

// ============================================================
// Answer formatting (renders n8n data naturally — never raw JSON)
// ============================================================

function groupsLabel(groups) {
    const labels = groups.map((g) => {
        const school = g.school ? escapeHtml(String(g.school).toUpperCase()) : null;
        const section = g.section != null ? escapeHtml(String(g.section)) : null;
        // Numeric sections show as "Section N"; string sections as-is (e.g. "BBA").
        const sectionLabel = section != null && !isNaN(g.section) ? `Section ${section}` : section;
        if (school && sectionLabel != null) return `${school} ${sectionLabel}`;
        if (school) return school;
        if (sectionLabel != null) return sectionLabel;
        return null;
    }).filter(Boolean);
    if (!labels.length) return '';
    if (labels.length === 1) return labels[0];
    if (labels.length === 2) return `Both ${labels[0]} and ${labels[1]}`;
    return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/**
 * Normalize JSON-escaped text (literal `\n`, `\t`, `\"` …) back into real
 * characters, so a double-encoded n8n response never shows raw escape
 * sequences like `\n` or `\"` in the chat. Single pass: each escape is
 * consumed exactly once, so `\\n` becomes the JSON escape `\n` (not a raw
 * newline) while a lone `\n` becomes a real newline.
 */
function unescapeJson(s) {
    return String(s ?? '').replace(/\\([\\nrt"'])/g, (m, ch) => {
        switch (ch) {
            case '\\': return '\\';
            case 'n': return '\n';
            case 'r': return '\r';
            case 't': return '\t';
            case '"': return '"';
            default: return ch;
        }
    });
}

/**
 * Pull the final AI answer out of any reasonable n8n response shape:
 *
 *   { message: '...' }                documented response
 *   { output: '...' }                 AI Agent used directly
 *   { json: { output: '...' } }       n8n wrapper convention
 *   [ { json: { output: '...' } } ]   n8n "Immediately" respond
 *
 * A message that is itself a JSON string (double-encoded) is parsed and
 * re-extracted, so raw or escaped JSON is never displayed as-is.
 */
function extractAnswer(data) {
    if (!data || typeof data !== 'object') return null;
    if (Array.isArray(data)) {
        const first = data[0];
        if (first && typeof first === 'object') {
            return extractAnswer(first.json && typeof first.json === 'object' ? first.json : first);
        }
        return null;
    }
    if (data.json && typeof data.json === 'object') return extractAnswer(data.json);
    const ans = data.message || data.output;
    if (typeof ans !== 'string' || !ans.trim()) return null;
    const text = ans.trim();
    if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
        // The message may be JSON itself (double-encoded), possibly with the
        // escapes still literal ("\n", "\""). Try it as-is and unescaped; if
        // it IS JSON but carries no message/output, never show it raw.
        for (const candidate of [text, unescapeJson(text)]) {
            try {
                const parsed = JSON.parse(candidate);
                if (parsed && typeof parsed === 'object') {
                    const nested = extractAnswer(parsed);
                    if (nested) return nested;
                }
            } catch {
                /* not valid JSON — try the next candidate */
            }
        }
        return null;
    }
    return text;
}

// Inline Markdown (bold / italic / inline code) for already-escaped text.
function inlineFormat(s) {
    return s
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*]+)\*/g, '<em>$1</em>')
        .replace(/`([^`]+)`/g, '<code>$1</code>');
}

/**
 * Minimal, safe Markdown → HTML for chat answers. The input MUST already be
 * HTML-escaped (see formatAnswer), so markdown syntax is the only thing ever
 * transformed and AI text can never inject markup. Supports headings,
 * bold/italic, inline code, bullet lists and line breaks — timetable slots
 * such as "### Section 2 Free Slots" / "• 11:15 AM – 1:00 PM" render as real
 * headings and list items.
 */
function renderMarkdown(text) {
    const lines = String(text ?? '').split(/\r?\n/);
    const out = [];
    const bullet = /^([•\-*])\s+(.*)$/;
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const heading = raw.match(/^#{1,6}\s+(.*)$/);
        if (heading) {
            out.push(`<h3>${inlineFormat(heading[1].trim())}</h3>`);
            continue;
        }
        if (bullet.test(raw)) {
            const items = [];
            while (i < lines.length && bullet.test(lines[i])) {
                const m = lines[i].match(bullet);
                items.push(`<li>${inlineFormat(m[2].trim())}</li>`);
                i++;
            }
            i--;
            out.push(`<ul>${items.join('')}</ul>`);
            continue;
        }
        if (raw.trim() === '') continue;
        out.push(`<p>${inlineFormat(raw.trim())}</p>`);
    }
    return out.join('');
}

/**
 * Turn the n8n response into a polished, human-readable answer.
 *
 * When n8n reports common free time, the periods are rendered as readable
 * ranges (one per line when several) prefixed with the resolved groups:
 *
 *     "Both SCDS Section 3 and SOAI Section 2 are free on Wednesday from
 *      12:00 PM to 1:00 PM."
 *
 * Otherwise the final answer (response.message / response.output) is rendered
 * as formatted Markdown. All text is escaped; nothing is ever shown as raw
 * or escaped JSON.
 */
function formatAnswer(data) {
    const groups = Array.isArray(data.groups) ? data.groups.filter(Boolean) : [];
    const periods = Array.isArray(data.commonFreePeriods)
        ? data.commonFreePeriods.filter((p) => p && (p.startTime || p.endTime))
        : [];
    const dayLabel = data.day ? String(data.day).charAt(0).toUpperCase() + String(data.day).slice(1).toLowerCase() : '';
    const label = groupsLabel(groups);

    if (data.hasCommonFreeTime && periods.length && label) {
        const verb = groups.length === 1 ? 'is' : 'are';
        if (periods.length === 1) {
            const p = periods[0];
            const range = [p.startTime, p.endTime].filter(Boolean).join(' to ');
            return dayLabel
                ? `${label} ${verb} free on ${dayLabel} from ${range}.`
                : `${label} ${verb} free from ${range}.`;
        }
        const lines = periods.map((p) => {
            const range = [p.startTime, p.endTime].filter(Boolean).join(' – ');
            const dur = p.durationMinutes ? ` (${p.durationMinutes} min)` : '';
            return `${range}${dur}`;
        });
        return dayLabel
            ? `${label} ${verb} free on ${dayLabel}:<br>• ${lines.join('<br>• ')}`
            : `${label} ${verb} free at:<br>• ${lines.join('<br>• ')}`;
    }

    const answer = extractAnswer(data);
    if (answer) {
        return renderMarkdown(escapeHtml(unescapeJson(answer)));
    }
    return "I couldn't find an answer to that in the timetable.";
}

// A response is usable when n8n actually answered (an extractable
// message/output, or an explicit success=true payload) — as opposed to a
// network/timeout failure.
function hasAnswer(data) {
    if (!data || typeof data !== 'object') return false;
    return extractAnswer(data) !== null || data.success === true;
}

// ============================================================
// Ask
// ============================================================

function sendQuestion(raw) {
    const question = String(raw || '').trim();
    if (!question || pending) return;
    // Clear the input only AFTER the submitted message was captured above.
    inputEl.value = '';
    updateSendState();
    addMessage('user', escapeHtml(question));
    showThinking();
    trackEvent('ai_question_asked', { question });
    askTimetableAI(question, getClasses(), getContext())
        .then((data) => {
            removeThinking();
            setPending(false);
            if (hasAnswer(data)) {
                addMessage('ai', formatAnswer(data));
            } else {
                addMessage('error', escapeHtml(GENERIC_ERROR));
                trackEvent('ai_question_failed', { question });
            }
        });
}

function renderSuggestions() {
    const isTeacherPage = typeof document !== 'undefined'
        && document.body
        && document.body.classList.contains('teacher-page');
    const questions = isTeacherPage
        ? [...TEACHER_SUGGESTED_QUESTIONS, ...SUGGESTED_QUESTIONS]
        : SUGGESTED_QUESTIONS;
    for (const q of questions) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ai-chip';
        btn.textContent = q;
        btn.addEventListener('click', () => sendQuestion(q));
        suggestionsEl.appendChild(btn);
    }
}

// ============================================================
// Init
// ============================================================

/**
 * Wire the AI assistant into the app. No-op (and renders nothing) unless the
 * feature is enabled — see js/services/timetable-ai.js isAiEnabled().
 *
 * @param {{getClasses?: () => Array<object>, getContext?: () => object}} opts
 *   Live accessors for the currently parsed timetable and navigation context.
 */
export function initAiAssistant(opts = {}) {
    if (!isAiEnabled()) return;
    getClasses = opts.getClasses || getClasses;
    getContext = opts.getContext || getContext;
    ensureDom();
    ensureLaunchButtons();
    renderSuggestions();

    // Dev-only console hook (mirrors window.testN8nWebhook). Only exists while
    // the feature is enabled (localhost/testing).
    try {
        window.testTimetableAI = (question) => askTimetableAI(question, getClasses(), getContext());
    } catch {
        // Dev wiring must never throw.
    }
}
