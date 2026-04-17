import { chat, eventSource, event_types, saveSettingsDebounced, substituteParams, messageFormatting } from '../../../../script.js';
import { power_user } from '../../../power-user.js';
import { ReasoningHandler, PromptReasoning, ReasoningType, ReasoningState } from '../../../reasoning.js';
import { trimSpaces, setDatasetProperty } from '../../../utils.js';
import { extension_settings } from '../../../extensions.js';

const MODULE_NAME = 'MoreReasoning';

const PARSER_DEFAULTS = {
    id: '', name: 'Parser', prefix: '', suffix: '', separator: '\n\n',
    maxAdditions: 1, enabled: true, autoExpand: false,
    addToPrompts: true, showHidden: true,
};

function generateUUID() {
    return 'parser_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9) + '_' + Math.random().toString(36).substr(2, 9);
}

function escapeRegex(string) {
    return string.replace(/[/\-\\^$*+?.()|[\]{}]/g, '\\$&');
}

/**
 * @typedef {object} MoreReasoningParser
 * @property {string} id - Unique identifier
 * @property {string} name - Display name
 * @property {string} prefix - Opening tag e.g. <think>
 * @property {string} suffix - Closing tag e.g. </think>
 * @property {string} separator - Separator e.g. \n\n
 * @property {number} maxAdditions - Max blocks to send to prompt
 * @property {boolean} enabled - Whether it's active
 * @property {boolean} autoExpand - Whether to auto-expand in UI
 * @property {boolean} addToPrompts - Whether to add to prompts
 * @property {boolean} showHidden - Whether to show hidden reasoning time
 */

const defaultSettings = {
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
        }
    ]
};

/** @type {typeof defaultSettings} */
let settings;

function loadSettings() {
    const extensionSettings = extension_settings?.[MODULE_NAME] || {};

    // Proper deep merge: start with defaults, then apply user overrides
    settings = { ...defaultSettings };

    // Merge parsers array instead of overwriting completely
    if (extensionSettings.parsers && Array.isArray(extensionSettings.parsers)) {
        // User saved parsers take precedence, merge with defaults
        const seenIds = new Set();
        settings.parsers = extensionSettings.parsers.map(parser => {
            let id = parser.id || generateUUID();
            if (id.startsWith('parser_') || id.startsWith('mr_')) {
                const cleanPrefix = parser.prefix?.replace(/[<>().,]/g, '').trim();
                // If it's a legacy auto-gen ID, prefer using the tag prefix for the new ID
                id = cleanPrefix || id;
            }

            // Ensure uniqueness within the current settings
            let finalId = id;
            let counter = 1;
            while (seenIds.has(finalId)) {
                finalId = `${id}_${counter++}`;
            }
            seenIds.add(finalId);

            return {
                ...PARSER_DEFAULTS,
                ...parser,
                id: finalId,
            };
        });
    } else {
        // No user parsers, use defaults with proper defaults applied
        settings.parsers = defaultSettings.parsers.map(parser => ({
            ...PARSER_DEFAULTS,
            ...parser,
        }));
    }

    console.log(`[${MODULE_NAME}] Settings loaded:`, settings);
}

function init() {
    loadSettings();
    patchReasoning();
    // Reparse the current chat on initial load
    setTimeout(reparseAllMessages, 500);
    injectUI();
}

/**
 * Injects the "More Reasoning" settings into the SillyTavern UI.
 */
function injectUI() {
    const $target = $('#reasoning_add_to_prompts').closest('.flex-container').parent();
    if (!$target.length) {
        console.error(`[${MODULE_NAME}] Could not find injection target - Settings UI will be unavailable`);
        return;
    }

    const html = `
        <div class="more-reasoning-settings-container">
            <h4 class="standoutHeader">More Reasoning Parsers</h4>
            <div id="more_reasoning_parsers_list"></div>
            <div class="more-reasoning-actions">
                <div id="more_reasoning_add_parser" class="menu_button more-reasoning-add-btn fa-solid fa-plus-circle" title="Add new parser"></div>
                <span>Add New Parser</span>
            </div>
        </div>
    `;

    $target.append(html);
    renderParsers();

    $('#more_reasoning_add_parser').on('click', () => {
        settings.parsers.push({
            id: generateUUID(),
            name: 'New Parser',
            prefix: '',
            suffix: '',
            separator: '',
            maxAdditions: 1,
            enabled: true,
            autoExpand: false,
            addToPrompts: true,
            showHidden: true,
        });
        renderParsers();
        saveSettings();
    });
}

function renderParsers() {
    const $list = $('#more_reasoning_parsers_list');
    $list.empty();

    settings.parsers.forEach((parser, index) => {
        const itemHtml = `
            <div class="more-reasoning-parser-item" data-index="${index}">
                <div class="flex-container alignItemsBaseline">
                    <input class="mr-name text_pole flex1" type="text" value="${parser.name}" placeholder="Parser Name">
                    <div class="mr-delete menu_button fa-solid fa-trash-can" title="Delete parser"></div>
                </div>

                <div class="flex-container alignItemsBaseline">
                    <label class="checkbox_label flex1" title="Automatically parse reasoning blocks from main content.">
                        <input class="mr-enabled" type="checkbox" ${parser.enabled ? 'checked' : ''}>
                        <small>Auto-Parse</small>
                    </label>
                    <label class="checkbox_label flex1" title="Automatically expand reasoning blocks for this parser.">
                        <input class="mr-expand" type="checkbox" ${parser.autoExpand ? 'checked' : ''}>
                        <small>Auto-Expand</small>
                    </label>
                    <label class="checkbox_label flex1" title="Show reasoning time/blocks even if content is hidden.">
                        <input class="mr-show-hidden" type="checkbox" ${parser.showHidden ? 'checked' : ''}>
                        <small>Show Hidden</small>
                    </label>
                </div>

                <div class="flex-container alignItemsBaseline">
                    <label class="checkbox_label flex1" title="Add existing reasoning blocks for this parser to prompts.">
                        <input class="mr-add-to-prompts" type="checkbox" ${parser.addToPrompts ? 'checked' : ''}>
                        <small>Add to Prompts</small>
                    </label>
                    <div class="flex1 flex-container alignItemsBaseline" title="Maximum number of reasoning blocks to be added per prompt for this parser.">
                        <input class="mr-max text_pole textarea_compact widthUnset" type="number" value="${parser.maxAdditions}" min="0" max="999">
                        <small>Max</small>
                    </div>
                </div>

                <details open>
                    <summary>Formatting (${parser.name})</summary>
                    <div class="flex-container">
                        <div class="flex1" title="Inserted before the reasoning content.">
                            <small>Prefix</small>
                            <textarea class="mr-prefix text_pole textarea_compact autoSetHeight" spellcheck="false">${parser.prefix}</textarea>
                        </div>
                        <div class="flex1" title="Inserted after the reasoning content.">
                            <small>Suffix</small>
                            <textarea class="mr-suffix text_pole textarea_compact autoSetHeight" spellcheck="false">${parser.suffix}</textarea>
                        </div>
                    </div>
                    <div class="flex-container">
                        <div class="flex1" title="Inserted between the reasoning and the message content.">
                            <small>Separator</small>
                            <textarea class="mr-separator text_pole textarea_compact autoSetHeight" spellcheck="false">${parser.separator}</textarea>
                        </div>
                    </div>
                </details>
            </div>
        `;
        const $item = $(itemHtml);

        $item.find('.mr-name').on('input', function () { parser.name = $(this).val(); $item.find('summary').text(`Formatting (${parser.name})`); saveSettings(); });
        $item.find('.mr-enabled').on('change', function () { parser.enabled = $(this).prop('checked'); saveSettings(); });
        $item.find('.mr-expand').on('change', function () { parser.autoExpand = $(this).prop('checked'); saveSettings(); });
        $item.find('.mr-add-to-prompts').on('change', function () { parser.addToPrompts = $(this).prop('checked'); saveSettings(); });
        $item.find('.mr-show-hidden').on('change', function () { parser.showHidden = $(this).prop('checked'); saveSettings(); });
        $item.find('.mr-prefix').on('input', function () { parser.prefix = $(this).val(); saveSettings(); });
        $item.find('.mr-suffix').on('input', function () { parser.suffix = $(this).val(); saveSettings(); });
        $item.find('.mr-separator').on('input', function () { parser.separator = $(this).val(); saveSettings(); });
        $item.find('.mr-max').on('input', function () { parser.maxAdditions = parseInt($(this).val()) || 0; saveSettings(); });
        $item.find('.mr-delete').on('click', () => {
            if (confirm(`Delete parser "${parser.name}"?`)) {
                settings.parsers.splice(index, 1);
                renderParsers();
                saveSettings();
            }
        });

        $list.append($item);
    });
}

function saveSettings() {
    extension_settings[MODULE_NAME] = settings;
    saveSettingsDebounced();
    // Reparse the chat if settings changed (e.g. a new parser was added or ID migrated)
    reparseAllMessages();
}

/**
 * Safely find a parser by its ID, with fallback for migrated legacy IDs.
 * @param {string} id - The parser ID to find
 * @returns {MoreReasoningParser|undefined}
 */
function getParser(id) {
    if (!id) return;
    let parser = settings.parsers.find(p => p.id === id);
    // Legacy fallback: check if it's an old 'mr_' or 'parser_' prefixed ID
    if (!parser && (id.startsWith('mr_') || id.startsWith('parser_'))) {
        const cleanId = id.replace(/^(mr_|parser_)/, '');
        parser = settings.parsers.find(p => p.id === cleanId);
    }
    return parser;
}

// =========================================================================
// Non-destructive reparse.
//
// Three cases handled:
//
// 1. ALREADY PARSED (reasoning_blocks exist):
//    Previous code versions stripped tags from message.mes — they need to
//    be reconstructed so the prompt builder can see them. We rebuild
//    the tags into message.mes from the persisted reasoning_blocks data,
//    then refresh the DOM (visual hider handles hiding them in the UI).
//
// 2. UNPARSED (raw tags still in message.mes):
//    Run full process() to detect and register the blocks.
//
// 3. NEITHER:
//    Skip — nothing to do.
// =========================================================================
async function reparseAllMessages() {
    console.log(`[${MODULE_NAME}] Reparsing all messages for reasoning blocks...`);
    let processedCount = 0;

    for (let i = 0; i < chat.length; i++) {
        const message = chat[i];
        if (!message || message.is_user) continue;

        // Case 1: Already parsed — strip any legacy tags from message.mes,
        // then refresh the DOM from the stored reasoning_blocks.
        if (message.extra?.reasoning_blocks?.length) {
            _stripTagsFromMes(message);
            const handler = new ReasoningHandler();
            handler._mr_isReparsing = true;
            handler.updateDom(i);
            processedCount++;
            continue;
        }

        // Case 2: Raw tags still in message.mes — run full process()
        const hasCustomTags = settings.parsers.some(
            p => p.enabled && p.prefix && p.suffix && message.mes.includes(p.prefix),
        );
        if (hasCustomTags) {
            const handler = new ReasoningHandler();
            handler._mr_isReparsing = true;
            await handler.process(i, false);
            processedCount++;
        }
    }

    console.log(`[${MODULE_NAME}] Reparsed ${processedCount} messages`);
}

/**
 * Strips any raw custom-parser tags from message.mes.
 * Runs on chat load to clean up any residue from older extension versions
 * that may have left tags inside the message body.
 * Tags are never injected back — they live only in reasoning_blocks and
 * are added to the prompt ephemerally by the addToMessage patch.
 * @param {object} message - The chat message object
 */
function _stripTagsFromMes(message) {
    if (!message.extra?.reasoning_blocks?.length) return;

    for (const block of message.extra.reasoning_blocks) {
        const parser = getParser(block.parserId);
        if (!parser || !parser.prefix || !parser.suffix) continue;

        const fullTag = block.incomplete
            ? parser.prefix + block.content
            : parser.prefix + block.content + parser.suffix;

        if (message.mes.includes(fullTag)) {
            message.mes = message.mes.split(fullTag).join('').replace(/^\n+/, '');
        }
    }
}

function patchReasoning() {
    console.log(`[${MODULE_NAME}] Patching SillyTavern reasoning system...`);

    // =========================================================================
    // Patch finish() - suppress STREAM_REASONING_DONE when custom blocks exist
    // so TTS doesn't fire prematurely. We emit it ourselves after processing.
    // =========================================================================
    const originalFinish = ReasoningHandler.prototype.finish;
    ReasoningHandler.prototype.finish = async function (messageId) {
        if (this._mr_suppressNativeFinish && this.state === ReasoningState.Thinking) {
            // Advance state and persist, but skip the event emission
            this.state = ReasoningState.Done;
            this.updateReasoning(messageId, null, { persist: true });
            this.updateDom(messageId);
            return;
        }
        return originalFinish.call(this, messageId);
    };

    // =========================================================================
    // Patch initHandleMessage() - detect overswipes (reset: true) and clear stale blocks
    // =========================================================================
    const originalInitHandleMessage = ReasoningHandler.prototype.initHandleMessage;
    ReasoningHandler.prototype.initHandleMessage = function (messageIdOrElement, { reset = false } = {}) {
        if (reset) {
            const messageId = typeof messageIdOrElement === 'number'
                ? messageIdOrElement
                : Number(window.jQuery(messageIdOrElement).closest('.mes').attr('mesid'));

            if (!isNaN(messageId) && chat[messageId]) {
                const message = chat[messageId];
                if (message.extra) {
                    // Clear ALL reasoning-related fields to prevent carry-over/flicker during swiping.
                    delete message.extra.reasoning_blocks;
                    delete message.extra.mr_has_custom_blocks;
                    delete message.extra.reasoning;
                    delete message.extra.reasoning_type;
                    delete message.extra.reasoning_duration;
                    delete message.extra._mr_is_placeholder;
                }
            }
        }

        const result = originalInitHandleMessage.apply(this, arguments);

        // If SillyTavern didn't find its own reasoning but we have custom blocks,
        // force state to Done so updateDom doesn't skip rendering them.
        const messageId = typeof messageIdOrElement === 'number'
            ? messageIdOrElement
            : Number(window.jQuery(messageIdOrElement).closest('.mes').attr('mesid'));
        const message = chat[messageId];
        if (message?.extra?.reasoning_blocks?.length && this.state === ReasoningState.None) {
            this.state = ReasoningState.Done;
        }

        return result;
    };

    // =========================================================================
    // Patch process() - detect custom tags before native handler, manage event
    // =========================================================================
    const originalProcess = ReasoningHandler.prototype.process;
    ReasoningHandler.prototype.process = async function (messageId, mesChanged, promptReasoning) {
        const message = chat[messageId];
        if (!message || message.is_user) return;

        if (!message.extra) message.extra = {};

        const activeParsers = settings.parsers.filter(p => p.enabled && p.prefix && p.suffix);

        // Detect custom tags BEFORE the original handler runs.
        // The original handler returns early if !this.reasoning && !isHiddenReasoningModel,
        // so we must detect and prepare custom content first.
        let foundBlocks = [];
        let placeholderSet = false;

        if (activeParsers.length > 0) {
            const workingContent = message.mes;
            let cleanedMes = '';
            let i = 0;

            while (i < workingContent.length) {
                let earliestPrefix = -1;
                let matchedParser = null;

                for (const parser of activeParsers) {
                    const pos = workingContent.indexOf(parser.prefix, i);
                    if (pos !== -1 && (earliestPrefix === -1 || pos < earliestPrefix)) {
                        earliestPrefix = pos;
                        matchedParser = parser;
                    }
                }

                if (matchedParser) {
                    // Check if this tag is nested inside another parser's tags.
                    // If so, don't extract it — let the parent parser handle it.
                    let isNested = false;
                    for (const otherParser of activeParsers) {
                        if (otherParser.id === matchedParser.id) continue;
                        const otherStartPos = workingContent.lastIndexOf(otherParser.prefix, earliestPrefix);
                        if (otherStartPos !== -1) {
                            const otherSuffixPos = workingContent.indexOf(otherParser.suffix, earliestPrefix);
                            if (otherSuffixPos !== -1 && otherSuffixPos > earliestPrefix) {
                                // This tag is inside another parser's scope — skip it
                                isNested = true;
                                break;
                            }
                        }
                    }

                    if (isNested) {
                        // Skip this tag, include it in cleanedMes as raw text
                        cleanedMes += workingContent.substring(i, i + matchedParser.prefix.length);
                        i += matchedParser.prefix.length;
                        continue;
                    }

                    // Accumulate content BEFORE this tag into cleanedMes
                    cleanedMes += workingContent.substring(i, earliestPrefix);
                    const contentStart = earliestPrefix + matchedParser.prefix.length;
                    const suffixPos = workingContent.indexOf(matchedParser.suffix, contentStart);

                    if (suffixPos !== -1) {
                        const rawContent = workingContent.substring(contentStart, suffixPos);
                        foundBlocks.push({
                            parserId: matchedParser.id,
                            content: rawContent,
                            expandedContent: substituteParams(rawContent),
                            duration: 0,
                        });
                        i = suffixPos + matchedParser.suffix.length;
                    } else {
                        const rawContent = workingContent.substring(contentStart);
                        foundBlocks.push({
                            parserId: matchedParser.id,
                            content: rawContent,
                            expandedContent: substituteParams(rawContent),
                            duration: 0,
                            incomplete: true,
                        });
                        i = workingContent.length;
                    }
                } else {
                    // No more tags — accumulate remainder
                    cleanedMes += workingContent.substring(i);
                    break;
                }
            }

            // Strip custom tags from message.mes — mirrors native ST behaviour.
            // Tags remain in reasoning_blocks and are injected into the prompt
            // ephemerally at send time via the addToMessage patch.
            // message.mes is kept clean so TTS never reads raw tag markup.
            if (foundBlocks.length > 0) {
                message.mes = cleanedMes;
            }

            // If custom blocks found and no native reasoning, set a placeholder
            // so the original handler doesn't hit its early return
            if (foundBlocks.length > 0 && !this.reasoning) {
                this.reasoning = '\u200B';
                message.extra._mr_is_placeholder = true;
                placeholderSet = true;
            }
        }

        // Flag finish() to suppress STREAM_REASONING_DONE if we have custom blocks.
        // This prevents TTS from firing on empty/placeholder reasoning.
        const shouldSuppressEvent = foundBlocks.length > 0;
        if (shouldSuppressEvent) {
            this._mr_suppressNativeFinish = true;
        }

        // Call the original handler (with placeholder set if needed)
        await originalProcess.call(this, messageId, mesChanged, promptReasoning);

        // Clear the suppression flag
        if (shouldSuppressEvent) {
            this._mr_suppressNativeFinish = false;
        }

        // After the original handler, process custom blocks
        if (foundBlocks.length > 0) {
            message.extra.reasoning_blocks = foundBlocks;
            message.extra.mr_has_custom_blocks = true;

            if (!this._mr_isReparsing) {
                await eventSource.emit(event_types.STREAM_REASONING_DONE, '', 0, messageId, ReasoningState.Done);
            }
        } else {
            // Only clear blocks if we detected new raw tags to re-parse.
            // DO NOT clear blocks just because swipe IDs changed.
            // This preserves reasoning blocks across swipes without tags.

            // Clean up placeholder if no custom blocks were found in this pass,
            // but a placeholder was previously set.
            if (message.extra?._mr_is_placeholder) {
                if (message.extra?.reasoning === '\u200B') {
                    delete message.extra.reasoning;
                }
                delete message.extra._mr_is_placeholder;

                // Reset handler state and re-render to remove placeholder UI
                // Only if native reasoning isn't actually using the handler now.
                if (!this.reasoning) {
                    this.state = ReasoningState.None;
                    this.reasoning = '';
                    this.type = null;
                }
            }
        }

        this.updateDom(messageId);
    };

    // =========================================================================
    // Patch PromptReasoning.isLimitReached — keep the ST prompt-builder loop
    // alive for our custom parsers even when native reasoning is disabled.
    //
    // CRITICAL FIX: Track per-message counts to avoid stopping the loop
    // prematurely when custom blocks on newer messages fill their limits,
    // preventing native reasoning on older messages from being added.
    // =========================================================================
    const originalIsLimitReached = PromptReasoning.prototype.isLimitReached;
    PromptReasoning.prototype.isLimitReached = function () {
        // If native logic says we are not yet done, keep going
        if (!originalIsLimitReached.call(this)) {
            return false;
        }
        // Check if any of our custom parsers still need more blocks
        // Track per-parser: have we added maxAdditions blocks across messages?
        const stillNeedsMore = settings.parsers.some(parser => {
            if (!parser.enabled || !parser.addToPrompts || parser.maxAdditions <= 0) return false;
            
            // Count total blocks added for this parser
            const totalSeen = this._mr_seenTotal?.[parser.id] ?? 0;
            
            // Keep the loop alive as long as we haven't reached maxAdditions yet
            // OR until we've processed all messages
            const hasMoreMessages = this._mr_cursor < (this._mr_sequence?.length ?? 0);
            const stillNeedsBlocks = totalSeen < parser.maxAdditions;
            
            // Continue if we need more blocks AND have more messages to check
            return stillNeedsBlocks && hasMoreMessages;
        });
        // Return true (limit reached) ONLY when both native is done AND we don't need any more blocks
        return !stillNeedsMore;
    };

    // =========================================================================
    // Patch PromptReasoning.addToMessage — inject custom blocks from
    // reasoning_blocks at send time, not from message.mes.
    //
    // Architecture (mirrors native ST reasoning):
    //   message.mes  = clean text, no tags (TTS-safe)
    //   reasoning_blocks = the block data, stored separately
    //   addToMessage = builds tags from reasoning_blocks and prepends to content
    //
    //   ST loop: for (let i = coreChat.length-1; i >= 0; i--) — NEWEST FIRST.
    //   We mirror this with a cursor into chat (filtered to non-system, reversed)
    //   advancing once per addToMessage call. Counter tracks "keep last N".
    // =========================================================================
    const originalAddToMessage = PromptReasoning.prototype.addToMessage;
    PromptReasoning.prototype.addToMessage = function (content, reasoning, isPrefix, duration) {
        // Per-instance state — reset each generation (new PromptReasoning() each time)
        if (!this._mr_initialized) {
            this._mr_initialized = true;
            this._mr_seenTotal = {};  // Global counter: total blocks added per parser
            this._mr_completedCount = {};  // Track complete blocks added per parser
            settings.parsers.forEach(p => { 
                this._mr_seenTotal[p.id] = 0;
                this._mr_completedCount[p.id] = 0;
            });
            // Sequence mirrors coreChat: non-system messages, newest first
            this._mr_sequence = chat.filter(m => !m.is_system).reverse();
            this._mr_cursor = 0;
        }

        // Call original to get native reasoning (prepended to content)
        let finalContent = originalAddToMessage.call(this, content, reasoning, isPrefix, duration);

        // Advance cursor to pick up this message's reasoning_blocks.
        // isPrefix = true means the actively-streaming last message —
        // don't advance so the cursor stays in sync for future calls.
        const currentMessage = this._mr_sequence[this._mr_cursor];
        if (!currentMessage?.extra?.reasoning_blocks?.length) {
            if (!isPrefix) this._mr_cursor++;
            return finalContent;
        }

        if (!isPrefix) this._mr_cursor++;

        // Build the injection string from blocks according to parser settings
        // Track which parsers have added a complete block from THIS message
        const addedCompleteThisMessage = new Set();
        let injection = '';
        currentMessage.extra.reasoning_blocks.forEach(block => {
            const parser = getParser(block.parserId);
            if (!parser || !parser.prefix || !parser.suffix) return;
            if (!parser.enabled || !parser.addToPrompts || parser.maxAdditions <= 0) return;

            const isComplete = !block.incomplete;
            
            // Skip if this is a completed block and we've already added one complete block for this parser from this message
            if (isComplete && addedCompleteThisMessage.has(parser.id)) return;
            
            // Skip if we've already added Max complete blocks for this parser across all messages
            if (isComplete && this._mr_completedCount[parser.id] >= parser.maxAdditions) return;

            // Track total blocks added for this parser across all messages
            this._mr_seenTotal[parser.id]++;
            
            // Only add if we haven't hit the limit yet
            if (this._mr_seenTotal[parser.id] <= parser.maxAdditions) {
                const prefix = substituteParams(parser.prefix);
                const suffix = substituteParams(parser.suffix);
                const sep = substituteParams(parser.separator || '');
                // Use cached expandedContent that was frozen when block was created
                const content = block.expandedContent || substituteParams(block.content);
                injection += prefix + content + suffix + sep;
                
                // Mark this parser as having added a complete block from this message
                if (isComplete) {
                    addedCompleteThisMessage.add(parser.id);
                    this._mr_completedCount[parser.id]++;
                }
            }
        });

        if (injection) {
            // Reorganize to maintain: [native reasoning] [custom reasoning] [content]
            // Original call gives us: native_wrapped + content
            // We need to extract native_wrapped and rebuild with injection in between
            const contentIndex = finalContent.lastIndexOf(content);
            if (contentIndex !== -1) {
                const nativeWrapped = finalContent.substring(0, contentIndex);
                finalContent = nativeWrapped + injection + content;
            }
        }

        return finalContent;
    };

    // =========================================================================
    // Patch updateDom for multi-block rendering.
    //
    // Two critical corrections vs. the naive approach:
    //
    // 1. SELECTOR COLLISION: The native #checkDomElements uses
    //    querySelector('.mes_reasoning_details') which would match our custom
    //    blocks too (they share that class for styling). We give our blocks
    //    the extra class 'more-reasoning-details' and native lookup must
    //    use ':not(.more-reasoning-details)'. Since we can't change the
    //    private #checkDomElements, we ensure our container is inserted
    //    AFTER the native block, and we use the scoped selector ourselves.
    //
    // 2. FRESH-HANDLER STATE LOSS: When called from reparseAllMessages with a
    //    brand-new ReasoningHandler (state=None, reasoning=''), the native
    //    originalUpdateDom would wipe the native block clean (toggle
    //    .reasoning=false, empty content). We pre-load state from
    //    message.extra before calling originalUpdateDom so it renders
    //    correctly just like initHandleMessage would.
    // =========================================================================
    const originalUpdateDom = ReasoningHandler.prototype.updateDom;
    ReasoningHandler.prototype.updateDom = function (messageId) {
        const message = chat[messageId];
        if (!message) return;

        // Pre-load state from persisted extra when handler has no live state.
        // This happens when updateDom is called directly (e.g. from reparseAllMessages)
        // on a fresh handler instance instead of one that was used during streaming.
        if (this.state === ReasoningState.None && !this.reasoning) {
            const extra = message.extra;
            if (extra?.reasoning) {
                // Strip our own ZWS markers before loading into the handler
                const cleanReasoning = extra.reasoning.replace(/\u200B/g, '').trim();
                if (cleanReasoning) {
                    this.reasoning = cleanReasoning;
                    this.state = ReasoningState.Done;
                    this.type = extra.reasoning_type ?? null;
                    if (extra.reasoning_duration && message.gen_started) {
                        this.initialTime = new Date(message.gen_started);
                        this.startTime = this.initialTime;
                        this.endTime = new Date(this.initialTime.getTime() + extra.reasoning_duration);
                    }
                }
            } else if (extra?.reasoning_duration) {
                // Hidden reasoning model — has duration but no text
                this.state = ReasoningState.Hidden;
                this.type = extra.reasoning_type ?? null;
            }
        }

        originalUpdateDom.call(this, messageId);

        const messageDom = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
        if (!messageDom) return;

        const mesText = messageDom.querySelector('.mes_text');

        // -----------------------------------------------------------------------
        // Visual hider: strip raw tags from rendered bubble text via a
        // MutationObserver so we win the race against SillyTavern's streaming.
        // -----------------------------------------------------------------------
        const applyVisualHider = () => {
            if (!mesText || !message.extra?.reasoning_blocks?.length) return;

            let displayMes = message.mes;
            let stripped = false;

            message.extra.reasoning_blocks.forEach(block => {
                const parser = getParser(block.parserId);
                if (parser && parser.prefix && parser.suffix) {
                    const suffixToUse = block.incomplete ? '' : parser.suffix;
                    const exactString = parser.prefix + block.content + suffixToUse;
                    if (displayMes.includes(exactString)) {
                        displayMes = displayMes.split(exactString).join('');
                        stripped = true;
                    }
                }
            });

            if (stripped) {
                if (mesText._mrObserver) {
                    mesText._mrObserver.disconnect();
                    mesText._mrObserver = null;
                }
                mesText.innerHTML = messageFormatting(
                    displayMes.trim(),
                    message.name,
                    message.is_system,
                    message.is_user,
                    messageId
                );
                if (!mesText._mrObserver) {
                    mesText._mrObserver = new MutationObserver(() => applyVisualHider());
                    mesText._mrObserver.observe(mesText, { childList: true, characterData: true, subtree: true });
                }
            }
        };

        if (mesText && !mesText._mrObserver) {
            mesText._mrObserver = new MutationObserver(() => applyVisualHider());
            mesText._mrObserver.observe(mesText, { childList: true, characterData: true, subtree: true });
        }
        applyVisualHider();

        // Hide custom container if the handler was reset (e.g., during swiping animation)
        // or if it's a hidden reasoning model starting a fresh thought.
        // GUARD: Do NOT remove if we have custom reasoning blocks to show.
        if (!message.extra?.reasoning_blocks?.length && (this.state === ReasoningState.None || (this.state === ReasoningState.Thinking && !this.reasoning)) && !this._mr_isReparsing) {
            const container = messageDom.querySelector('.more-reasoning-container');
            if (container) container.remove();
            return;
        }

        if (!message?.extra?.reasoning_blocks?.length) {
            // No blocks — remove stale container if it exists
            const container = messageDom.querySelector('.more-reasoning-container');
            if (container) container.remove();
            return;
        }

        // -----------------------------------------------------------------------
        // Custom block container.
        // Use ':not(.more-reasoning-details)' to find the NATIVE block only,
        // avoiding selector collision with our own injected detail elements.
        // -----------------------------------------------------------------------
        let multiContainer = messageDom.querySelector('.more-reasoning-container');
        if (!multiContainer) {
            multiContainer = document.createElement('div');
            multiContainer.className = 'more-reasoning-container';
            // Native block selector — explicitly exclude our custom blocks
            const nativeReasoning = messageDom.querySelector('.mes_reasoning_details:not(.more-reasoning-details)');
            if (nativeReasoning) {
                // Insert AFTER the native reasoning details block
                if (nativeReasoning.nextSibling) {
                    nativeReasoning.parentNode.insertBefore(multiContainer, nativeReasoning.nextSibling);
                } else {
                    nativeReasoning.parentNode.appendChild(multiContainer);
                }
            } else if (mesText) {
                mesText.parentNode.insertBefore(multiContainer, mesText);
            } else {
                messageDom.appendChild(multiContainer);
            }
        }

        multiContainer.innerHTML = '';
        message.extra.reasoning_blocks.forEach((block, blockIndex) => {
            const parser = getParser(block.parserId);
            if (!parser) return;
            if (!parser.enabled) return; // parser disabled — don't show its blocks

            const details = document.createElement('details');
            // 'mes_reasoning_details' for ST CSS styling,
            // 'more-reasoning-details' as our own class + :not() guard above
            details.className = 'mes_reasoning_details more-reasoning-details';

            // Build a descriptive ID for CSS targeting: parser_{tag}_{messageId}_{index}
            const cleanTag = parser.prefix.replace(/[<>().,]/g, '').trim() || 'block';
            details.id = `parser_${cleanTag}_${messageId}_${blockIndex}`;

            details.dataset.parserId = parser.id; // required for editing
            if (block.incomplete) details.dataset.state = 'thinking';
            if (parser.autoExpand || block.incomplete) details.open = true;

            const headerTitle = block.incomplete ? `${parser.name} (Thinking...)` : parser.name;

            // Add custom reasoning actions with edit buttons
            details.innerHTML = `
                <summary class="mes_reasoning_summary flex-container">
                    <div class="mes_reasoning_header_block mr_mes_reasoning_header_block flex-container">
                        <div class="mes_reasoning_header mr_mes_reasoning_header flex-container">
                            <span class="mes_reasoning_header_title">${headerTitle}</span>
                            <div class="mes_reasoning_arrow fa-solid fa-chevron-up"></div>
                        </div>
                    </div>
                    <div class="mes_reasoning_actions flex-direction-row flex-container mr_mes_reasoning_actions" style="margin-top: 5px;">
                        <div class="mr_mes_reasoning_edit_done menu_button edit_button fa-solid fa-check" title="Confirm" style="display:none"></div>
                        <div class="mr_mes_reasoning_edit_cancel menu_button edit_button fa-solid fa-xmark" title="Cancel edit" style="display:none"></div>
                        <div class="mr_mes_reasoning_edit mes_button fa-solid fa-pencil" title="Edit custom reasoning"></div>
                    </div>
                </summary>
                <div class="mr_mes_reasoning">${messageFormatting(block.expandedContent || substituteParams(block.content), '', false, false, messageId, {}, true)}</div>

            `;
            multiContainer.appendChild(details);
        });

        // If all blocks were filtered (e.g. all parsers disabled), remove the
        // empty container so it doesn't leave stale CSS/layout artifacts.
        if (!multiContainer.innerHTML.trim()) {
            multiContainer.remove();
        }
    };

    // Custom block editing handlers - these need to target custom blocks only
    $(document).on('click', '.more-reasoning-details .mr_mes_reasoning_edit', function (e) {
        e.stopPropagation();
        e.preventDefault();

        const details = $(this).closest('.more-reasoning-details');
        const messageBlock = details.closest('.mes');
        const messageId = messageBlock.attr('mesid');
        const message = chat[messageId];
        const parserId = details.attr('data-parser-id');

        if (!message || !message.extra?.reasoning_blocks) return;
        const block = message.extra.reasoning_blocks.find(b => b.parserId === parserId);
        if (!block) return;

        const reasoningBlock = details.find('.mr_mes_reasoning');
        const textarea = document.createElement('textarea');
        textarea.classList.add('reasoning_edit_textarea', 'mr_reasoning_edit_textarea');
        textarea.value = block.content;
        $(textarea).insertBefore(reasoningBlock);

        if (!CSS.supports('field-sizing', 'content')) {
            const resetHeight = function () {
                textarea.style.height = '0px';
                textarea.style.height = `${textarea.scrollHeight}px`;
            };
            textarea.addEventListener('input', resetHeight);
            setTimeout(resetHeight, 0);
        }

        reasoningBlock.hide();
        details.find('.mr_mes_reasoning_edit').hide();
        details.find('.mr_mes_reasoning_edit_cancel').show();
        details.find('.mr_mes_reasoning_edit_done').show();

        textarea.focus();
    });

    $(document).on('click', '.mr_mes_reasoning_edit_cancel', function (e) {
        e.stopPropagation();
        e.preventDefault();

        const details = $(this).closest('.more-reasoning-details');
        details.find('.mr_reasoning_edit_textarea').remove();
        details.find('.mr_mes_reasoning').show();
        details.find('.mr_mes_reasoning_edit_cancel').hide();
        details.find('.mr_mes_reasoning_edit_done').hide();
        details.find('.mr_mes_reasoning_edit').show();
    });

    $(document).on('click', '.mr_mes_reasoning_edit_done', async function (e) {
        e.stopPropagation();
        e.preventDefault();

        const details = $(this).closest('.more-reasoning-details');
        const messageBlock = details.closest('.mes');
        const messageId = messageBlock.attr('mesid');
        const message = chat[messageId];
        const parserId = details.attr('data-parser-id');

        if (!message || !message.extra?.reasoning_blocks) return;
        const block = message.extra.reasoning_blocks.find(b => b.parserId === parserId);
        if (!block) return;

        const textarea = details.find('.mr_reasoning_edit_textarea');
        const newContent = String(textarea.val());

        if (block.content !== newContent) {
            block.content = newContent;
            // Native MESSAGE_UPDATED event triggers saves downstream
            await eventSource.emit(event_types.MESSAGE_UPDATED, messageId);
        }

        // Let the normal DOM update path refresh the element
        const handler = new ReasoningHandler();
        handler.updateDom(messageId);
    });

    console.log(`[${MODULE_NAME}] Patching complete.`);
}

eventSource.on(event_types.APP_READY, () => {
    init();
});

async function checkAndParseMessage(messageId, forceReset = false) {
    const message = chat[messageId];
    if (!message || message.is_user) return;

    // Check if this message actually has raw tags that need parsing first
    const hasRawTags = settings.parsers.some(
        p => p.enabled && p.prefix && p.suffix && message.mes.includes(p.prefix),
    );

    // Also check if this is a fresh overswipe starting (SillyTavern sets mes to '...')
    const isNewGeneration = message.mes === '...';

    // Clear existing blocks if:
    // 1. Force reset (e.g., manually triggered refreshing), OR
    // 2. New raw tags detected (needs re-parsing), OR
    // 3. New generation starting (to clear stale blocks from copied variant)
    if ((forceReset || hasRawTags || isNewGeneration) && message.extra) {
        delete message.extra.reasoning_blocks;
        delete message.extra.mr_has_custom_blocks;
    }

    const handler = new ReasoningHandler();
    handler._mr_isReparsing = true;
    await handler.process(messageId, false);
}

// Catch messages from non-streamed inference and swipes.
eventSource.on(event_types.MESSAGE_RECEIVED, async (messageId) => {
    await checkAndParseMessage(messageId);
});

eventSource.on(event_types.MESSAGE_SWIPED, async (messageId) => {
    // DO NOT force reset here anymore.
    // If it's a new generation, checkAndParseMessage will detect '...' and clear.
    // If it's a return to an old swipe, ST core has already restored the 'extra' data,
    // and we want to preserve it rather than clearing it unconditionally.
    await checkAndParseMessage(messageId, false);
});
// Catch tags added during message edits
let _mr_handlingMessageUpdate = false;
eventSource.on(event_types.MESSAGE_UPDATED, async (messageId) => {
    // Prevent infinite loop when we emit MESSAGE_UPDATED ourselves after editing blocks
    if (_mr_handlingMessageUpdate) return;
    _mr_handlingMessageUpdate = true;
    try {
        await checkAndParseMessage(messageId);
    } finally {
        _mr_handlingMessageUpdate = false;
    }
});

// CHARACTER_MESSAGE_RENDERED for per-message DOM patching (hot path)
eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (messageId) => {
    const message = chat[messageId];
    if (!message || message.is_user) return;

    // Always force updateDom on render - fixes swipe navigation not showing blocks
    const handler = new ReasoningHandler();
    handler.updateDom(messageId);
});

// CHAT_LOADED fallback for initial parse of unprocessed messages
eventSource.on(event_types.CHAT_LOADED, () => {
    reparseAllMessages();
});

// Clean up MutationObservers on chat switch to prevent memory leaks
eventSource.on(event_types.CHAT_CHANGED, () => {
    document.querySelectorAll('.mes_text').forEach(el => {
        if (el._mrObserver) {
            el._mrObserver.disconnect();
            delete el._mrObserver;
        }
    });
});
