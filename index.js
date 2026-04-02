import { chat, eventSource, event_types, saveSettingsDebounced, substituteParams, messageFormatting } from '../../../../script.js';
import { power_user } from '../../../power-user.js';
import { ReasoningHandler, PromptReasoning, ReasoningType, ReasoningState } from '../../../reasoning.js';
import { trimSpaces, setDatasetProperty } from '../../../utils.js';
import { extension_settings } from '../../../extensions.js';

const MODULE_NAME = 'MoreReasoning';

// =========================================================================
// Bug #7: Neutral parser defaults (not tied to any specific parser)
// =========================================================================
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
    settings = Object.assign({}, defaultSettings, extensionSettings);

    // Bug #7: Use neutral PARSER_DEFAULTS instead of defaultSettings.parsers[0]
    if (settings.parsers) {
        settings.parsers = settings.parsers.map(parser => ({
            ...PARSER_DEFAULTS,
            ...parser,
            id: parser.id || generateUUID(),
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
    if (!$target.length) return;

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
    // Reparse the chat if settings changed (e.g. a new parser was added)
    reparseAllMessages();
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
    for (let i = 0; i < chat.length; i++) {
        const message = chat[i];
        if (!message || message.is_user) continue;

        // Case 1: Already parsed — strip any legacy tags from message.mes,
        // then refresh the DOM from the stored reasoning_blocks.
        if (message.extra?.reasoning_blocks?.length) {
            _stripTagsFromMes(message);
            const handler = new ReasoningHandler();
            handler.updateDom(i);
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
        }
    }
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
        const parser = settings.parsers.find(p => p.id === block.parserId);
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
                    // Accumulate content BEFORE this tag into cleanedMes
                    cleanedMes += workingContent.substring(i, earliestPrefix);
                    const contentStart = earliestPrefix + matchedParser.prefix.length;
                    const suffixPos = workingContent.indexOf(matchedParser.suffix, contentStart);

                    if (suffixPos !== -1) {
                        foundBlocks.push({
                            parserId: matchedParser.id,
                            content: workingContent.substring(contentStart, suffixPos),
                            duration: 0,
                        });
                        i = suffixPos + matchedParser.suffix.length;
                    } else {
                        foundBlocks.push({
                            parserId: matchedParser.id,
                            content: workingContent.substring(contentStart),
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
            // Bug #6: Use dedicated property instead of ZWS fingerprint
            message.extra.mr_has_custom_blocks = true;

            // Bug #3: Only emit STREAM_REASONING_DONE during live streaming,
            // not during re-parses (which would flood TTS subscribers)
            if (!this._mr_isReparsing) {
                await eventSource.emit(event_types.STREAM_REASONING_DONE, '', 0, messageId, ReasoningState.Done);
            }
        } else {
            delete message.extra.reasoning_blocks;
            delete message.extra.mr_has_custom_blocks;

            // Clean up placeholder if no custom blocks were found
            if (placeholderSet) {
                if (message.extra.reasoning === '\u200B') {
                    delete message.extra.reasoning;
                }
                // Reset handler state and re-render to remove placeholder UI
                this.state = ReasoningState.None;
                this.reasoning = '';
                this.type = null;
            }
        }

        this.updateDom(messageId);
    };

    // =========================================================================
    // Patch PromptReasoning.isLimitReached — keep the ST prompt-builder loop
    // alive for our custom parsers even when native reasoning is disabled.
    // =========================================================================
    const originalIsLimitReached = PromptReasoning.prototype.isLimitReached;
    PromptReasoning.prototype.isLimitReached = function () {
        if (!originalIsLimitReached.call(this)) {
            return false;
        }
        const stillNeedsMore = settings.parsers.some(parser => {
            if (!parser.enabled || !parser.addToPrompts || parser.maxAdditions <= 0) return false;
            const seen = this._mr_seen?.[parser.id] ?? 0;
            return seen < parser.maxAdditions;
        });
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
            this._mr_seen = {};
            settings.parsers.forEach(p => { this._mr_seen[p.id] = 0; });
            // Sequence mirrors coreChat: non-system messages, newest first
            this._mr_sequence = chat.filter(m => !m.is_system).reverse();
            this._mr_cursor = 0;
        }

        // Call original first — native reasoning handled untouched
        let finalContent = originalAddToMessage.call(this, content, reasoning, isPrefix, duration);

        // Advance cursor to pick up this message's reasoning_blocks.
        // isPrefix = true means the actively-streaming last message —
        // don't advance so the cursor stays in sync for future calls.
        const currentMessage = this._mr_sequence[this._mr_cursor];
        if (!isPrefix) this._mr_cursor++;

        if (!currentMessage?.extra?.reasoning_blocks?.length) return finalContent;

        // Build the injection string from blocks according to parser settings
        let injection = '';
        currentMessage.extra.reasoning_blocks.forEach(block => {
            const parser = settings.parsers.find(p => p.id === block.parserId);
            if (!parser || !parser.prefix || !parser.suffix) return;
            if (!parser.enabled || !parser.addToPrompts || parser.maxAdditions <= 0) return;

            // Newest-first counter: keep first maxAdditions occurrences
            this._mr_seen[parser.id]++;
            if (this._mr_seen[parser.id] <= parser.maxAdditions) {
                const sep = substituteParams(parser.separator || '');
                injection += parser.prefix + block.content + parser.suffix + sep;
            }
        });

        if (injection) {
            finalContent = injection + finalContent;
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
                const parser = settings.parsers.find(p => p.id === block.parserId);
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
                if (mesText._mrObserver) mesText._mrObserver.disconnect();
                mesText.innerHTML = messageFormatting(
                    displayMes.trim(),
                    message.name,
                    message.is_system,
                    message.is_user,
                    messageId
                );
                if (mesText._mrObserver) {
                    mesText._mrObserver.observe(mesText, { childList: true, characterData: true, subtree: true });
                }
            }
        };

        if (mesText && !mesText._mrObserver) {
            mesText._mrObserver = new MutationObserver(() => applyVisualHider());
            mesText._mrObserver.observe(mesText, { childList: true, characterData: true, subtree: true });
        }
        applyVisualHider();

        if (!message?.extra?.reasoning_blocks?.length) return;

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
        message.extra.reasoning_blocks.forEach(block => {
            const parser = settings.parsers.find(p => p.id === block.parserId);
            if (!parser) return;
            if (!parser.enabled) return; // parser disabled — don't show its blocks

            const details = document.createElement('details');
            // 'mes_reasoning_details' for ST CSS styling,
            // 'more-reasoning-details' as our own class + :not() guard above
            details.className = 'mes_reasoning_details more-reasoning-details';
            if (block.incomplete) details.dataset.state = 'thinking';
            if (parser.autoExpand || block.incomplete) details.open = true;

            const headerTitle = block.incomplete ? `${parser.name} (Thinking...)` : parser.name;
            details.innerHTML = `
                <summary class="mes_reasoning_summary flex-container">
                    <div class="mes_reasoning_header_block flex-container">
                        <div class="mes_reasoning_header flex-container">
                            <span class="mes_reasoning_header_title">${headerTitle}</span>
                            <div class="mes_reasoning_arrow fa-solid fa-chevron-up"></div>
                        </div>
                    </div>
                </summary>
                <div class="mes_reasoning">${messageFormatting(block.content, '', false, false, messageId, {}, true)}</div>
            `;
            multiContainer.appendChild(details);
        });

        // If all blocks were filtered (e.g. all parsers disabled), remove the
        // empty container so it doesn't leave stale CSS/layout artifacts.
        if (!multiContainer.innerHTML.trim()) {
            multiContainer.remove();
        }
    };

    console.log(`[${MODULE_NAME}] Patching complete.`);
}

eventSource.on(event_types.APP_READY, () => {
    init();
});

// Bug #4: CHARACTER_MESSAGE_RENDERED for per-message DOM patching (hot path)
eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (messageId) => {
    const message = chat[messageId];
    if (!message || message.is_user) return;
    if (message.extra?.reasoning_blocks?.length) {
        const handler = new ReasoningHandler();
        handler.updateDom(messageId);
    }
});

// Bug #4: CHAT_LOADED fallback for initial parse of unprocessed messages
eventSource.on(event_types.CHAT_LOADED, () => {
    setTimeout(reparseAllMessages, 1000);
});

// Bug #5: Clean up MutationObservers on chat switch to prevent memory leaks
eventSource.on(event_types.CHAT_CHANGED, () => {
    document.querySelectorAll('.mes_text').forEach(el => {
        if (el._mrObserver) {
            el._mrObserver.disconnect();
            delete el._mrObserver;
        }
    });
});
