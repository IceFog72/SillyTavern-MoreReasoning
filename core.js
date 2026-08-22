export const SETTINGS_VERSION = 2;

export const PARSER_DEFAULTS = Object.freeze({
    id: '',
    name: 'Parser',
    prefix: '',
    suffix: '',
    separator: '\n\n',
    maxAdditions: 1,
    enabled: true,
    autoExpand: false,
    addToPrompts: true,
    showHidden: true,
});

export const DEFAULT_SETTINGS = Object.freeze({
    settingsVersion: SETTINGS_VERSION,
    parsers: [
        {
            id: 'think',
            name: 'Thought',
            prefix: '<think>',
            suffix: '</think>',
            separator: '\n\n',
            maxAdditions: 0,
            enabled: true,
            autoExpand: false,
            addToPrompts: true,
            showHidden: true,
        },
        {
            id: 'plan',
            name: 'Plan',
            prefix: '<plan>',
            suffix: '</plan>',
            separator: '\n\n',
            maxAdditions: 1,
            enabled: true,
            autoExpand: false,
            addToPrompts: true,
            showHidden: true,
        },
    ],
});

/**
 * Create a parser identifier. IDs are deliberately opaque and immutable.
 * @returns {string}
 */
export function createParserId() {
    if (globalThis.crypto?.randomUUID) {
        return `mr-${globalThis.crypto.randomUUID()}`;
    }

    // Fallback for older WebViews. Collision resistance is sufficient for a local settings key.
    return `mr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeMaxAdditions(value) {
    const parsed = Number.parseInt(String(value ?? 0), 10);
    if (!Number.isFinite(parsed)) return 0;
    return Math.min(999, Math.max(0, parsed));
}

/**
 * Normalize settings without deriving IDs from user-editable names/tags.
 * Existing IDs are preserved to keep historical reasoning_blocks addressable.
 * @param {any} rawSettings
 * @returns {{settingsVersion:number, parsers:Array<any>}}
 */
export function normalizeSettings(rawSettings = {}) {
    const sourceParsers = Array.isArray(rawSettings?.parsers)
        ? rawSettings.parsers
        : DEFAULT_SETTINGS.parsers;

    const seenIds = new Set();
    const parsers = sourceParsers.map((source) => {
        const parser = source && typeof source === 'object' ? source : {};
        const baseId = String(parser.id ?? '').trim() || createParserId();
        let id = baseId;
        let suffix = 2;
        while (seenIds.has(id)) {
            id = `${baseId}-${suffix++}`;
        }
        seenIds.add(id);

        return {
            ...PARSER_DEFAULTS,
            ...parser,
            id,
            name: String(parser.name ?? PARSER_DEFAULTS.name),
            prefix: String(parser.prefix ?? PARSER_DEFAULTS.prefix),
            suffix: String(parser.suffix ?? PARSER_DEFAULTS.suffix),
            separator: String(parser.separator ?? PARSER_DEFAULTS.separator),
            maxAdditions: normalizeMaxAdditions(parser.maxAdditions ?? PARSER_DEFAULTS.maxAdditions),
            enabled: Boolean(parser.enabled ?? PARSER_DEFAULTS.enabled),
            autoExpand: Boolean(parser.autoExpand ?? PARSER_DEFAULTS.autoExpand),
            addToPrompts: Boolean(parser.addToPrompts ?? PARSER_DEFAULTS.addToPrompts),
            showHidden: Boolean(parser.showHidden ?? PARSER_DEFAULTS.showHidden),
        };
    });

    return {
        settingsVersion: SETTINGS_VERSION,
        parsers,
    };
}

/**
 * Return a human-readable validation error, or null if a parser is usable.
 * Invalid parsers remain persisted so partially edited settings never disappear.
 * @param {any} parser
 * @param {Array<any>} allParsers
 * @returns {string|null}
 */
export function getParserValidationError(parser, allParsers = []) {
    if (!parser || typeof parser !== 'object') return 'Invalid parser settings.';
    if (!String(parser.prefix ?? '').trim()) return 'Prefix is required.';
    if (!String(parser.suffix ?? '').trim()) return 'Suffix is required.';
    if (parser.prefix === parser.suffix) return 'Prefix and suffix must be different.';

    for (const other of allParsers) {
        if (!other || other === parser || other.id === parser.id) continue;
        if (!String(other.prefix ?? '').trim()) continue;

        if (other.prefix === parser.prefix) {
            return `Prefix duplicates parser “${other.name || other.id}”.`;
        }

        if (other.prefix.startsWith(parser.prefix) || parser.prefix.startsWith(other.prefix)) {
            return `Prefix overlaps parser “${other.name || other.id}” and is ambiguous.`;
        }
    }

    return null;
}

/**
 * @param {Array<any>} parsers
 * @returns {Array<any>}
 */
export function getActiveParsers(parsers) {
    const list = Array.isArray(parsers) ? parsers : [];
    return list.filter(parser => parser.enabled && !getParserValidationError(parser, list));
}

/**
 * Find the matching suffix for a parser, supporting nested instances of the same tag pair.
 * Different parser tags inside a block are intentionally treated as literal block content.
 * @param {string} text
 * @param {number} contentStart
 * @param {any} parser
 * @returns {number}
 */
function findMatchingSuffix(text, contentStart, parser) {
    let depth = 1;
    let cursor = contentStart;

    while (cursor <= text.length) {
        const nextOpen = text.indexOf(parser.prefix, cursor);
        const nextClose = text.indexOf(parser.suffix, cursor);
        if (nextClose === -1) return -1;

        if (nextOpen !== -1 && nextOpen < nextClose) {
            depth++;
            cursor = nextOpen + parser.prefix.length;
            continue;
        }

        depth--;
        if (depth === 0) return nextClose;
        cursor = nextClose + parser.suffix.length;
    }

    return -1;
}

/**
 * Extract outermost custom reasoning blocks from text.
 * @param {string} text
 * @param {Array<any>} parsers Active/validated parsers
 * @param {(value:string)=>string} [expand]
 * @returns {{cleanedText:string, blocks:Array<any>, parserIds:Set<string>}}
 */
export function extractReasoningBlocks(text, parsers, expand = value => value) {
    const source = String(text ?? '');
    const activeParsers = Array.isArray(parsers) ? parsers : [];
    const blocks = [];
    const parserIds = new Set();
    let cleanedText = '';
    let cursor = 0;

    while (cursor < source.length) {
        let matchPosition = -1;
        let matchedParser = null;

        for (const parser of activeParsers) {
            const position = source.indexOf(parser.prefix, cursor);
            if (position === -1) continue;
            if (matchPosition === -1 || position < matchPosition) {
                matchPosition = position;
                matchedParser = parser;
            }
        }

        if (!matchedParser) {
            cleanedText += source.slice(cursor);
            break;
        }

        cleanedText += source.slice(cursor, matchPosition);
        const contentStart = matchPosition + matchedParser.prefix.length;
        const suffixPosition = findMatchingSuffix(source, contentStart, matchedParser);
        const incomplete = suffixPosition === -1;
        const rawContent = incomplete
            ? source.slice(contentStart)
            : source.slice(contentStart, suffixPosition);

        blocks.push({
            parserId: matchedParser.id,
            content: rawContent,
            expandedContent: expand(rawContent),
            duration: 0,
            ...(incomplete ? { incomplete: true } : {}),
        });
        parserIds.add(matchedParser.id);

        cursor = incomplete
            ? source.length
            : suffixPosition + matchedParser.suffix.length;
    }

    return { cleanedText, blocks, parserIds };
}

/**
 * Replace only parser families that were present in newly parsed raw text.
 * This lets a newly-added parser parse previously visible tags without destroying
 * independent blocks that were already stored separately.
 * @param {Array<any>} existing
 * @param {Array<any>} parsed
 * @param {Set<string>} parsedParserIds
 * @returns {Array<any>}
 */
export function mergeReasoningBlocks(existing, parsed, parsedParserIds) {
    const oldBlocks = Array.isArray(existing) ? existing : [];
    const preserved = oldBlocks.filter(block => !parsedParserIds.has(block?.parserId));

    const reused = parsed.map((block, index) => {
        const oldMatch = oldBlocks.find((old, oldIndex) => (
            oldIndex === index
            && old?.parserId === block.parserId
            && old?.content === block.content
            && Boolean(old?.incomplete) === Boolean(block?.incomplete)
        ));
        if (!oldMatch) return block;
        return {
            ...block,
            expandedContent: typeof oldMatch.expandedContent === 'string'
                ? oldMatch.expandedContent
                : block.expandedContent,
        };
    });

    return [...preserved, ...reused];
}

/**
 * Choose the newest N blocks globally for every parser using the exact prompt chat.
 * Returns keys in `${messageIndex}:${blockIndex}` form.
 * @param {Array<any>} promptChat
 * @param {Array<any>} parsers
 * @param {(item:any, index:number)=>boolean} [skipMessage]
 * @returns {Set<string>}
 */
export function selectPromptBlocks(promptChat, parsers, skipMessage = () => false) {
    const active = (Array.isArray(parsers) ? parsers : []).filter(parser => (
        parser.enabled
        && parser.addToPrompts
        && normalizeMaxAdditions(parser.maxAdditions) > 0
        && !getParserValidationError(parser, parsers)
    ));
    const parserById = new Map(active.map(parser => [parser.id, parser]));
    const counts = new Map(active.map(parser => [parser.id, 0]));
    const selected = new Set();

    for (let messageIndex = promptChat.length - 1; messageIndex >= 0; messageIndex--) {
        const item = promptChat[messageIndex];
        if (!item || skipMessage(item, messageIndex)) continue;
        const blocks = Array.isArray(item.extra?.reasoning_blocks) ? item.extra.reasoning_blocks : [];

        for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex--) {
            const block = blocks[blockIndex];
            const parser = parserById.get(block?.parserId);
            if (!parser) continue;

            const count = counts.get(parser.id) ?? 0;
            if (count >= normalizeMaxAdditions(parser.maxAdditions)) continue;

            selected.add(`${messageIndex}:${blockIndex}`);
            counts.set(parser.id, count + 1);
        }
    }

    return selected;
}

/**
 * Build prompt injection text for one message while preserving block source order.
 * @param {any} item
 * @param {number} messageIndex
 * @param {Set<string>} selected
 * @param {Array<any>} parsers
 * @param {(value:string)=>string} substitute
 * @param {{type?:string,lastMessageIndex?:number}} [options]
 * @returns {string}
 */
export function buildPromptInjection(item, messageIndex, selected, parsers, substitute, options = {}) {
    const parserById = new Map((Array.isArray(parsers) ? parsers : []).map(parser => [parser.id, parser]));
    const blocks = Array.isArray(item?.extra?.reasoning_blocks) ? item.extra.reasoning_blocks : [];
    let injection = '';

    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
        if (!selected.has(`${messageIndex}:${blockIndex}`)) continue;
        const block = blocks[blockIndex];
        const parser = parserById.get(block?.parserId);
        if (!parser) continue;

        const prefix = substitute(String(parser.prefix ?? ''));
        const suffix = substitute(String(parser.suffix ?? ''));
        const separator = substitute(String(parser.separator ?? ''));
        const content = typeof block.expandedContent === 'string'
            ? block.expandedContent
            : substitute(String(block.content ?? ''));

        const isActiveContinue = Boolean(
            block.incomplete
            && options.type === 'continue'
            && messageIndex === options.lastMessageIndex,
        );

        injection += isActiveContinue
            ? `${prefix}${content}`
            : `${prefix}${content}${suffix}${separator}`;
    }

    return injection;
}
