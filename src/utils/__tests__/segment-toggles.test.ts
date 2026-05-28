import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it
} from 'vitest';

import type { RenderContext } from '../../types/RenderContext';
import {
    DEFAULT_SETTINGS,
    type Settings
} from '../../types/Settings';
import type { WidgetItem } from '../../types/Widget';
import {
    preRenderAllWidgets,
    renderStatusLine
} from '../renderer';
import {
    isStatuslineDisabled,
    isTruthyEnvValue,
    isWidgetHiddenByEnv
} from '../segment-toggles';

// ---------------------------------------------------------------------------
// Env helpers — these tests mutate process.env (the render pipeline reads it
// directly) and restore the original after every test.
// ---------------------------------------------------------------------------

const TOGGLE_KEYS = [
    'CCSTATUSLINE_DISABLE',
    'CCSTATUSLINE_HIDE_MODEL',
    'CCSTATUSLINE_HIDE_CONTEXT',
    'CCSTATUSLINE_HIDE_GIT_BRANCH',
    'CCSTATUSLINE_HIDE_CUSTOM',
    'CCSTATUSLINE_HIDE_SEGMENT_9'
];

let savedEnv: Record<string, string | undefined>;

// Reflect.deleteProperty is used instead of the `delete` operator to satisfy
// the repo's @typescript-eslint/no-dynamic-delete rule (which forbids deleting
// dynamically-computed keys via the `delete` operator).
function unsetEnv(key: string): void {
    Reflect.deleteProperty(process.env, key);
}

beforeEach(() => {
    savedEnv = {};
    for (const key of TOGGLE_KEYS) {
        savedEnv[key] = process.env[key];
        unsetEnv(key);
    }
});

afterEach(() => {
    for (const key of TOGGLE_KEYS) {
        const original = savedEnv[key];
        if (original === undefined) {
            unsetEnv(key);
        } else {
            process.env[key] = original;
        }
    }
});

// ---------------------------------------------------------------------------
// Pure helper unit tests
// ---------------------------------------------------------------------------

describe('isTruthyEnvValue', () => {
    it('treats 1/true/on/yes (any case, trimmed) as enabled', () => {
        for (const v of ['1', 'true', 'TRUE', 'on', 'On', 'yes', 'YES', '  true  ']) {
            expect(isTruthyEnvValue(v)).toBe(true);
        }
    });

    it('treats everything else as disabled', () => {
        for (const v of [undefined, '', '0', 'false', 'off', 'no', 'enabled', '2', 'truthy']) {
            expect(isTruthyEnvValue(v)).toBe(false);
        }
    });
});

describe('isStatuslineDisabled', () => {
    it('is false when CCSTATUSLINE_DISABLE is unset', () => {
        expect(isStatuslineDisabled({})).toBe(false);
    });

    it('is true when CCSTATUSLINE_DISABLE is enabled', () => {
        expect(isStatuslineDisabled({ CCSTATUSLINE_DISABLE: '1' })).toBe(true);
        expect(isStatuslineDisabled({ CCSTATUSLINE_DISABLE: 'true' })).toBe(true);
    });

    it('is false when CCSTATUSLINE_DISABLE is an off-ish value', () => {
        expect(isStatuslineDisabled({ CCSTATUSLINE_DISABLE: '0' })).toBe(false);
        expect(isStatuslineDisabled({ CCSTATUSLINE_DISABLE: 'false' })).toBe(false);
    });
});

describe('isWidgetHiddenByEnv', () => {
    const item = (id: string, type: string): WidgetItem => ({ id, type });

    it('hides nothing when no toggles are set', () => {
        expect(isWidgetHiddenByEnv(item('1', 'model'), {})).toBe(false);
        expect(isWidgetHiddenByEnv(item('9', 'custom-command'), {})).toBe(false);
    });

    it('hides the model segment via CCSTATUSLINE_HIDE_MODEL', () => {
        const env = { CCSTATUSLINE_HIDE_MODEL: '1' };
        expect(isWidgetHiddenByEnv(item('1', 'model'), env)).toBe(true);
        expect(isWidgetHiddenByEnv(item('2', 'git-branch'), env)).toBe(false);
    });

    it('hides the context family via CCSTATUSLINE_HIDE_CONTEXT', () => {
        const env = { CCSTATUSLINE_HIDE_CONTEXT: 'yes' };
        expect(isWidgetHiddenByEnv(item('1', 'context-length'), env)).toBe(true);
        expect(isWidgetHiddenByEnv(item('2', 'context-percentage'), env)).toBe(true);
        expect(isWidgetHiddenByEnv(item('3', 'context-percentage-usable'), env)).toBe(true);
        // Not part of the usage family — must stay visible.
        expect(isWidgetHiddenByEnv(item('4', 'context-window'), env)).toBe(false);
        expect(isWidgetHiddenByEnv(item('5', 'context-bar'), env)).toBe(false);
    });

    it('hides the git-branch segment via CCSTATUSLINE_HIDE_GIT_BRANCH', () => {
        const env = { CCSTATUSLINE_HIDE_GIT_BRANCH: 'on' };
        expect(isWidgetHiddenByEnv(item('1', 'git-branch'), env)).toBe(true);
        expect(isWidgetHiddenByEnv(item('2', 'model'), env)).toBe(false);
    });

    it('hides ALL custom-command segments via CCSTATUSLINE_HIDE_CUSTOM', () => {
        const env = { CCSTATUSLINE_HIDE_CUSTOM: '1' };
        expect(isWidgetHiddenByEnv(item('9', 'custom-command'), env)).toBe(true);
        expect(isWidgetHiddenByEnv(item('12', 'custom-command'), env)).toBe(true);
        // Only applies to custom-command.
        expect(isWidgetHiddenByEnv(item('1', 'model'), env)).toBe(false);
    });

    it('hides a SPECIFIC segment by id via CCSTATUSLINE_HIDE_SEGMENT_<id>', () => {
        const env = { CCSTATUSLINE_HIDE_SEGMENT_9: '1' };
        expect(isWidgetHiddenByEnv(item('9', 'custom-command'), env)).toBe(true);
        // A different id of the same type is unaffected.
        expect(isWidgetHiddenByEnv(item('12', 'custom-command'), env)).toBe(false);
        // The per-id form works for any segment type, not just custom-command.
        expect(isWidgetHiddenByEnv(item('9', 'model'), { CCSTATUSLINE_HIDE_SEGMENT_9: 'true' })).toBe(true);
    });

    it('does not hide when a toggle is present but off-ish', () => {
        expect(isWidgetHiddenByEnv(item('1', 'model'), { CCSTATUSLINE_HIDE_MODEL: '0' })).toBe(false);
        expect(isWidgetHiddenByEnv(item('9', 'custom-command'), { CCSTATUSLINE_HIDE_CUSTOM: 'false' })).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// End-to-end render-pipeline tests
//
// These drive the REAL widgets through the REAL renderer in preview mode
// (no git / no shell / no disk) and assert that env toggles blank the right
// segment AND that the existing separator-collapse logic removes the dangling
// separator. This mirrors Hunter's line: Model | Context | ⎇ branch | custom.
// ---------------------------------------------------------------------------

function createSettings(overrides: Partial<Settings> = {}): Settings {
    return {
        ...DEFAULT_SETTINGS,
        ...overrides,
        powerline: {
            ...DEFAULT_SETTINGS.powerline,
            ...(overrides.powerline ?? {})
        }
    };
}

// Hunter's status line shape, separator-delimited:
//   model | context-length | git-branch | custom-command
const LINE: WidgetItem[] = [
    { id: '1', type: 'model', color: 'cyan' },
    { id: 's1', type: 'separator' },
    { id: '3', type: 'context-length', color: 'brightBlack' },
    { id: 's2', type: 'separator' },
    { id: '5', type: 'git-branch', color: 'magenta' },
    { id: 's3', type: 'separator' },
    { id: '9', type: 'custom-command', commandPath: 'truememory-widget' }
];

function renderLine(settingsOverrides: Partial<Settings> = {}): string {
    const settings = createSettings({ colorLevel: 0, ...settingsOverrides });
    // isPreview lets every widget render a deterministic placeholder with no IO.
    const context: RenderContext = { isPreview: true, terminalWidth: 200 };
    const preRendered = preRenderAllWidgets([LINE], settings, context)[0] ?? [];
    return renderStatusLine(LINE, settings, context, preRendered, []);
}

describe('segment toggles through the render pipeline', () => {
    it('renders the full line with all four segments when no toggles are set', () => {
        const out = renderLine();
        expect(out).toContain('Model: Claude');
        expect(out).toContain('Ctx: 18.6k');
        expect(out).toContain('⎇ main');
        expect(out).toContain('[cmd: truememory-widget]');
        // Three separators between four content segments.
        expect((out.match(/\|/g) ?? []).length).toBe(3);
    });

    it('default output is byte-stable across repeated renders (backward-compat snapshot)', () => {
        const first = renderLine();
        const second = renderLine();
        expect(first).toBe(second);
        expect(first).toMatchInlineSnapshot('"Model: Claude | Ctx: 18.6k | ⎇ main | [cmd: truememory-widget]"');
    });

    it('CCSTATUSLINE_HIDE_MODEL drops the model segment with no leading dangling separator', () => {
        process.env.CCSTATUSLINE_HIDE_MODEL = '1';
        const out = renderLine();
        expect(out).not.toContain('Model: Claude');
        expect(out).toContain('Ctx: 18.6k');
        expect(out).toContain('⎇ main');
        // One separator dropped (3 -> 2); no leading "| ".
        expect((out.match(/\|/g) ?? []).length).toBe(2);
        expect(out.trimStart().startsWith('|')).toBe(false);
    });

    it('CCSTATUSLINE_HIDE_CONTEXT drops the context segment and collapses its separator', () => {
        process.env.CCSTATUSLINE_HIDE_CONTEXT = '1';
        const out = renderLine();
        expect(out).not.toContain('Ctx: 18.6k');
        expect(out).toContain('Model: Claude');
        expect(out).toContain('⎇ main');
        expect((out.match(/\|/g) ?? []).length).toBe(2);
        // No doubled separator left behind where context used to be.
        expect(out).not.toMatch(/\|\s*\|/);
    });

    it('CCSTATUSLINE_HIDE_GIT_BRANCH drops the branch segment with no dangling separator', () => {
        process.env.CCSTATUSLINE_HIDE_GIT_BRANCH = '1';
        const out = renderLine();
        expect(out).not.toContain('⎇ main');
        expect(out).toContain('Model: Claude');
        expect(out).toContain('[cmd: truememory-widget]');
        expect((out.match(/\|/g) ?? []).length).toBe(2);
        expect(out).not.toMatch(/\|\s*\|/);
    });

    it('CCSTATUSLINE_HIDE_CUSTOM drops the trailing custom segment and its leading separator', () => {
        process.env.CCSTATUSLINE_HIDE_CUSTOM = '1';
        const out = renderLine();
        expect(out).not.toContain('[cmd: truememory-widget]');
        expect(out).toContain('⎇ main');
        // Trailing segment gone => trailing separator removed (3 -> 2).
        expect((out.match(/\|/g) ?? []).length).toBe(2);
        expect(out.trimEnd().endsWith('|')).toBe(false);
    });

    it('CCSTATUSLINE_HIDE_SEGMENT_9 drops the specific custom segment by id', () => {
        process.env.CCSTATUSLINE_HIDE_SEGMENT_9 = '1';
        const out = renderLine();
        expect(out).not.toContain('[cmd: truememory-widget]');
        expect(out).toContain('Model: Claude');
        expect((out.match(/\|/g) ?? []).length).toBe(2);
        expect(out.trimEnd().endsWith('|')).toBe(false);
    });

    it('hiding a middle segment never produces an empty " |  | " gap', () => {
        process.env.CCSTATUSLINE_HIDE_CONTEXT = '1';
        process.env.CCSTATUSLINE_HIDE_GIT_BRANCH = '1';
        const out = renderLine();
        // Only model + custom survive — exactly one separator between them.
        expect(out).toContain('Model: Claude');
        expect(out).toContain('[cmd: truememory-widget]');
        expect((out.match(/\|/g) ?? []).length).toBe(1);
        expect(out).not.toMatch(/\|\s*\|/);
    });

    it('hiding every segment yields an empty render (caller drops the line)', () => {
        process.env.CCSTATUSLINE_HIDE_MODEL = '1';
        process.env.CCSTATUSLINE_HIDE_CONTEXT = '1';
        process.env.CCSTATUSLINE_HIDE_GIT_BRANCH = '1';
        process.env.CCSTATUSLINE_HIDE_CUSTOM = '1';
        const out = renderLine();
        expect(out).toBe('');
    });
});
