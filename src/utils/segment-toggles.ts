import type { WidgetItem } from '../types/Widget';

/**
 * Environment-variable driven statusline / segment toggles.
 *
 * These let a user disable the whole statusline or individual segments without
 * editing `settings.json`. Every toggle is OFF by default — when no relevant
 * environment variable is set, rendering is byte-identical to the configured
 * `settings.json` behavior. The reads happen at render time (not module load)
 * so the variables can be flipped per-invocation.
 *
 * A value is considered "enabled" when it case-insensitively equals one of
 * `1`, `true`, `on`, or `yes`. Anything else (including `0`, `false`, empty
 * string, or an unset variable) leaves the toggle OFF.
 */

/** Master switch — when enabled the statusline renders nothing at all. */
export const MASTER_DISABLE_ENV = 'CCSTATUSLINE_DISABLE';

/** Hides every `custom-command` segment regardless of id. */
export const HIDE_ALL_CUSTOM_ENV = 'CCSTATUSLINE_HIDE_CUSTOM';

/** Prefix for hiding one specific segment by its `id` (e.g. CCSTATUSLINE_HIDE_SEGMENT_9). */
export const HIDE_SEGMENT_BY_ID_PREFIX = 'CCSTATUSLINE_HIDE_SEGMENT_';

/**
 * Maps an environment variable name to the widget `type`s it hides.
 *
 * This is the single source of truth for the type-scoped toggles. To hide an
 * additional segment family, add an entry here — no other code needs to change.
 */
export const TYPE_TOGGLE_ENV: Record<string, readonly string[]> = {
    CCSTATUSLINE_HIDE_MODEL: ['model'],
    // The "context / tokens" usage family. Intentionally scoped to the
    // current-usage readouts (the "587.7k" style figure and the % variants).
    // `context-window` (total window size) and `context-bar` are conceptually
    // different and are NOT hidden by this toggle.
    CCSTATUSLINE_HIDE_CONTEXT: ['context-length', 'context-percentage', 'context-percentage-usable'],
    CCSTATUSLINE_HIDE_GIT_BRANCH: ['git-branch']
};

/** Returns true when the env value reads as an explicit "enabled" flag. */
export function isTruthyEnvValue(value: string | undefined): boolean {
    if (!value) {
        return false;
    }
    switch (value.trim().toLowerCase()) {
        case '1':
        case 'true':
        case 'on':
        case 'yes':
            return true;
        default:
            return false;
    }
}

/** Master short-circuit: when true, the whole statusline should render nothing. */
export function isStatuslineDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return isTruthyEnvValue(env[MASTER_DISABLE_ENV]);
}

/**
 * Decides whether a single configured widget should be suppressed by an env
 * toggle. Used by the render pipeline to blank a segment's content so the
 * existing separator-collapse logic drops its adjacent separators too.
 *
 * Resolution order (any match hides the segment):
 *   1. Per-id   — `CCSTATUSLINE_HIDE_SEGMENT_<id>` matches this item's id.
 *   2. All-custom — `CCSTATUSLINE_HIDE_CUSTOM` and the item is `custom-command`.
 *   3. Type-scoped — an entry in `TYPE_TOGGLE_ENV` lists this item's type.
 */
export function isWidgetHiddenByEnv(item: WidgetItem, env: NodeJS.ProcessEnv = process.env): boolean {
    // 1. Specific segment by id (the general, clean mechanism).
    if (item.id && isTruthyEnvValue(env[`${HIDE_SEGMENT_BY_ID_PREFIX}${item.id}`])) {
        return true;
    }

    // 2. All custom-command segments at once.
    if (item.type === 'custom-command' && isTruthyEnvValue(env[HIDE_ALL_CUSTOM_ENV])) {
        return true;
    }

    // 3. Type-scoped toggles (model / context / git-branch / ...).
    for (const [envName, types] of Object.entries(TYPE_TOGGLE_ENV)) {
        if (types.includes(item.type) && isTruthyEnvValue(env[envName])) {
            return true;
        }
    }

    return false;
}
