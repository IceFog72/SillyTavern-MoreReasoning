import {
    chat,
    eventSource,
    event_types,
    messageFormatting,
    name2,
    saveChatDebounced,
    saveSettingsDebounced,
    substituteParams,
    syncMesToSwipe,
} from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { selected_group } from '../../../group-chats.js';
import { ReasoningHandler } from '../../../reasoning.js';
import {
    DEFAULT_SETTINGS,
    PARSER_DEFAULTS,
    buildPromptInjection,
    createParserId,
    extractReasoningBlocks,
    getActiveParsers,
    getParserValidationError,
    mergeReasoningBlocks,
    normalizeMaxAdditions,
    normalizeSettings,
    selectPromptBlocks,
} from './core.js';

const MODULE_NAME = 'MoreReasoning';
const GENERATE_INTERCEPTOR_KEY = 'MoreReasoning_generateInterceptor';
const PROCESS_PATCH_FLAG = Symbol.for('SillyTavern.MoreReasoning.processPatch.v3');
const SCAN_DEBOUNCE_MS = 350;

/** @type {{settingsVersion:number, parsers:Array<any>}|null} */
let settings = null;
let initialized = false;
let scanTimer = null;

/**
 * State needed only while a `continue` generation is active. It lets custom
 * incomplete blocks continue without manufacturing native ReasoningHandler state.
 * @type {null|{type:string,messageId:number,baseClean:string,baseBlocks:Array<any>,continuingBlockIndex:number}}
 */
let generationState = null;

function clone(value) {
    return typeof structuredClone === 'function'
        ? structuredClone(value)
        : JSON.parse(JSON.stringify(value));
}

function loadSettings() {
    const raw = extension_settings?.[MODULE_NAME] ?? DEFAULT_SETTINGS;
    const normalized = normalizeSettings(raw);
    settings = normalized;
    extension_settings[MODULE_NAME] = settings;

    // Persist the schema migration once. In particular, legacy random IDs are
    // preserved rather than being rewritten from mutable tag text.
    if (JSON.stringify(raw) !== JSON.stringify(normalized)) {
        saveSettingsDebounced();
    }
}

function saveSettings() {
    if (!settings) return;
    extension_settings[MODULE_NAME] = settings;
    saveSettingsDebounced();
}

function getParser(id) {
    if (!settings || !id) return undefined;
    const exact = settings.parsers.find(parser => parser.id === id);
    if (exact) return exact;

    // Compatibility with early MoreReasoning block IDs such as `mr_think` or
    // `parser_think`. New IDs use `mr-<uuid>` and are never rewritten.
    if (String(id).startsWith('mr_') || String(id).startsWith('parser_')) {
        const legacyId = String(id).replace(/^(?:mr_|parser_)/, '');
        return settings.parsers.find(parser => parser.id === legacyId);
    }
    return undefined;
}

function getPromptEligibleParser(id) {
    const parser = getParser(id);
    if (!parser) return undefined;
    if (!parser.enabled || !parser.addToPrompts || normalizeMaxAdditions(parser.maxAdditions) <= 0) return undefined;
    if (getParserValidationError(parser, settings.parsers)) return undefined;
    return parser;
}

function cleanExtractedMessage(text) {
    // Removing a leading reasoning block commonly leaves one or more blank lines.
    // Remove only line breaks at the very start; do not globally trim user content.
    return String(text ?? '').replace(/^(?:[\t ]*\r?\n)+/, '');
}

/**
 * Parse custom tags from a message. This function never touches native reasoning
 * fields (`extra.reasoning`, duration/type, or ReasoningHandler state).
 * @param {number} messageId
 * @returns {boolean} Whether message.mes or reasoning_blocks changed
 */
function parseCustomReasoning(messageId) {
    if (!settings) return false;
    const message = chat[messageId];
    if (!message || message.is_user || message.is_system) return false;

    const activeParsers = getActiveParsers(settings.parsers);
    if (!activeParsers.length) return false;

    const source = String(message.mes ?? '');
    const isContinue = generationState?.type === 'continue'
        && generationState.messageId === messageId
        && source.startsWith(generationState.baseClean);
    const hasRawPrefix = activeParsers.some(parser => source.includes(parser.prefix));
    const canContinueIncomplete = isContinue && generationState.continuingBlockIndex >= 0;
    if (!hasRawPrefix && !canContinueIncomplete) {
        return false;
    }

    message.extra ??= {};
    let parsed;
    let nextBlocks;
    let nextMes;

    if (canContinueIncomplete) {
        const baseBlock = generationState.baseBlocks[generationState.continuingBlockIndex];
        const parser = getPromptEligibleParser(baseBlock?.parserId);

        if (parser) {
            const generatedPart = source.slice(generationState.baseClean.length);
            const synthetic = `${parser.prefix}${baseBlock.content ?? ''}${generatedPart}`;
            parsed = extractReasoningBlocks(synthetic, activeParsers, substituteParams);

            if (parsed.blocks.length) {
                nextBlocks = clone(generationState.baseBlocks);
                nextBlocks.splice(generationState.continuingBlockIndex, 1, parsed.blocks[0]);
                if (parsed.blocks.length > 1) {
                    nextBlocks.push(...parsed.blocks.slice(1));
                }
                nextMes = generationState.baseClean + cleanExtractedMessage(parsed.cleanedText);
            }
        }
    }

    if (!parsed || !parsed.blocks.length) {
        parsed = extractReasoningBlocks(source, activeParsers, substituteParams);
        if (!parsed.blocks.length) return false;

        nextMes = cleanExtractedMessage(parsed.cleanedText);
        if (isContinue) {
            // The raw stream for a continue starts from the already-clean visible
            // message, so its newly parsed blocks are additions, not replacements.
            nextBlocks = [...clone(generationState.baseBlocks), ...parsed.blocks];
        } else {
            nextBlocks = mergeReasoningBlocks(
                message.extra.reasoning_blocks,
                parsed.blocks,
                parsed.parserIds,
            );
        }
    }

    const oldMes = String(message.mes ?? '');
    const oldBlocks = Array.isArray(message.extra.reasoning_blocks)
        ? message.extra.reasoning_blocks
        : [];

    message.mes = nextMes;
    message.extra.reasoning_blocks = nextBlocks;
    message.extra.mr_has_custom_blocks = nextBlocks.length > 0;

    return oldMes !== nextMes || JSON.stringify(oldBlocks) !== JSON.stringify(nextBlocks);
}

function renderMessageText(messageId) {
    const message = chat[messageId];
    const messageDom = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    const mesText = messageDom?.querySelector('.mes_text');
    if (!message || !mesText) return;

    mesText.innerHTML = messageFormatting(
        String(message.mes ?? ''),
        message.name,
        message.is_system,
        message.is_user,
        messageId,
    );
}

function getBlockDisplayContent(block) {
    return typeof block?.expandedContent === 'string'
        ? block.expandedContent
        : substituteParams(String(block?.content ?? ''));
}

function renderCustomBlocks(messageId) {
    if (!settings) return;
    const message = chat[messageId];
    const messageDom = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!message || !messageDom) return;

    const blocks = Array.isArray(message.extra?.reasoning_blocks)
        ? message.extra.reasoning_blocks
        : [];
    const displayable = blocks
        .map((block, blockIndex) => ({ block, blockIndex, parser: getParser(block?.parserId) }))
        .filter(({ block, parser }) => (
            parser
            && parser.enabled
            && !getParserValidationError(parser, settings.parsers)
            && (parser.showHidden || String(block?.content ?? '').trim())
        ));

    let container = messageDom.querySelector('.more-reasoning-container');
    if (!displayable.length) {
        container?.remove();
        return;
    }

    if (!container) {
        container = document.createElement('div');
        container.className = 'more-reasoning-container';
        const mesText = messageDom.querySelector('.mes_text');
        if (mesText?.parentNode) {
            mesText.parentNode.insertBefore(container, mesText);
        } else {
            messageDom.appendChild(container);
        }
    }

    const previouslyOpen = new Set(
        [...container.querySelectorAll('.more-reasoning-details[open]')]
            .map(element => `${element.dataset.parserId}:${element.dataset.blockIndex}`),
    );
    container.replaceChildren();

    for (const { block, blockIndex, parser } of displayable) {
        const hidden = !String(block?.content ?? '').trim();
        const details = document.createElement('details');
        details.className = 'more-reasoning-details';
        details.dataset.parserId = parser.id;
        details.dataset.blockIndex = String(blockIndex);
        details.dataset.state = hidden ? 'hidden' : block.incomplete ? 'thinking' : 'done';
        const blockKey = `${parser.id}:${blockIndex}`;
        if (previouslyOpen.has(blockKey) || (parser.autoExpand && !hidden) || block.incomplete) {
            details.open = true;
        }

        const summary = document.createElement('summary');
        summary.className = 'mes_reasoning_summary flex-container';

        const headerBlock = document.createElement('div');
        headerBlock.className = 'mes_reasoning_header_block mr_mes_reasoning_header_block flex-container';

        const header = document.createElement('div');
        header.className = 'mes_reasoning_header mr_mes_reasoning_header flex-container';

        const title = document.createElement('span');
        title.className = 'mes_reasoning_header_title';
        title.textContent = hidden
            ? `${parser.name} (Hidden)`
            : block.incomplete
                ? `${parser.name} (Thinking…)`
                : parser.name;

        const arrow = document.createElement('span');
        arrow.className = 'mes_reasoning_arrow fa-solid fa-chevron-up';
        arrow.setAttribute('aria-hidden', 'true');
        header.append(title, arrow);
        headerBlock.append(header);

        const actions = document.createElement('div');
        actions.className = 'mes_reasoning_actions flex-direction-row flex-container mr_mes_reasoning_actions';
        actions.style.marginTop = '5px';

        const confirmButton = document.createElement('div');
        confirmButton.className = 'mr_mes_reasoning_edit_done mes_button edit_button fa-solid fa-check';
        confirmButton.title = 'Confirm';
        confirmButton.setAttribute('aria-label', 'Confirm reasoning edit');
        confirmButton.hidden = true;

        const cancelButton = document.createElement('div');
        cancelButton.className = 'mr_mes_reasoning_edit_cancel mes_button edit_button fa-solid fa-xmark';
        cancelButton.title = 'Cancel edit';
        cancelButton.setAttribute('aria-label', 'Cancel reasoning edit');
        cancelButton.hidden = true;

        const editButton = document.createElement('div');
        editButton.className = 'mr_mes_reasoning_edit mes_button fa-solid fa-pencil';
        editButton.title = 'Edit custom reasoning';
        editButton.setAttribute('aria-label', 'Edit custom reasoning');

        actions.append(confirmButton, cancelButton, editButton);
        summary.append(headerBlock, actions);

        const content = document.createElement('div');
        content.className = 'mr_mes_reasoning';
        if (!hidden) {
            content.innerHTML = messageFormatting(
                getBlockDisplayContent(block),
                '',
                false,
                false,
                messageId,
                {},
                true,
            );
        }

        details.append(summary, content);
        container.append(details);
    }
}

function renderAllVisibleCustomBlocks() {
    document.querySelectorAll('#chat .mes[mesid]').forEach(element => {
        const messageId = Number(element.getAttribute('mesid'));
        if (!Number.isNaN(messageId)) renderCustomBlocks(messageId);
    });
}

function scanChatForRawTags() {
    if (!settings) return;
    let changed = false;

    for (let messageId = 0; messageId < chat.length; messageId++) {
        const message = chat[messageId];
        if (!message || message.is_user || message.is_system) continue;

        if (parseCustomReasoning(messageId)) {
            changed = true;
            syncMesToSwipe(messageId);
            renderMessageText(messageId);
        }
        renderCustomBlocks(messageId);
    }

    if (changed) saveChatDebounced();
}

function scheduleChatScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scanChatForRawTags, SCAN_DEBOUNCE_MS);
}

function refreshValidationIndicators() {
    if (!settings) return;
    $('#more_reasoning_parsers_list .more-reasoning-parser-item').each(function () {
        const index = Number($(this).attr('data-index'));
        const parser = settings.parsers[index];
        const error = getParserValidationError(parser, settings.parsers);
        $(this).toggleClass('mr-parser-invalid', Boolean(error));
        $(this).find('.mr-validation').text(error ?? '');
    });
}

function renderParsers() {
    if (!settings) return;
    const $list = $('#more_reasoning_parsers_list');
    if (!$list.length) return;
    $list.empty();

    settings.parsers.forEach((parser, index) => {
        const $item = $(`
            <div class="more-reasoning-parser-item" data-index="${index}">
                <div class="flex-container alignItemsBaseline">
                    <input class="mr-name text_pole flex1" type="text" placeholder="Parser Name" aria-label="Parser name">
                    <button type="button" class="mr-delete menu_button fa-solid fa-trash-can" title="Delete parser" aria-label="Delete parser"></button>
                </div>

                <div class="flex-container alignItemsBaseline mr-parser-toggles">
                    <label class="checkbox_label flex1" title="Automatically parse reasoning blocks from main content.">
                        <input class="mr-enabled" type="checkbox">
                        <small>Auto-Parse</small>
                    </label>
                    <label class="checkbox_label flex1" title="Automatically expand reasoning blocks for this parser.">
                        <input class="mr-expand" type="checkbox">
                        <small>Auto-Expand</small>
                    </label>
                    <label class="checkbox_label flex1" title="Show empty/hidden reasoning blocks for this parser.">
                        <input class="mr-show-hidden" type="checkbox">
                        <small>Show Hidden</small>
                    </label>
                </div>

                <div class="flex-container alignItemsBaseline">
                    <label class="checkbox_label flex1" title="Add stored reasoning blocks for this parser to prompts.">
                        <input class="mr-add-to-prompts" type="checkbox">
                        <small>Add to Prompts</small>
                    </label>
                    <label class="flex1 flex-container alignItemsBaseline mr-max-label" title="Maximum number of most-recent blocks added per prompt for this parser.">
                        <input class="mr-max text_pole textarea_compact widthUnset" type="number" min="0" max="999" inputmode="numeric">
                        <small>Max</small>
                    </label>
                </div>

                <details class="mr-formatting-details" open>
                    <summary></summary>
                    <div class="flex-container">
                        <label class="flex1" title="Inserted before reasoning content.">
                            <small>Prefix</small>
                            <textarea class="mr-prefix text_pole textarea_compact autoSetHeight" spellcheck="false"></textarea>
                        </label>
                        <label class="flex1" title="Inserted after reasoning content.">
                            <small>Suffix</small>
                            <textarea class="mr-suffix text_pole textarea_compact autoSetHeight" spellcheck="false"></textarea>
                        </label>
                    </div>
                    <label class="mr-separator-label" title="Inserted between reasoning and visible message content in prompts.">
                        <small>Separator</small>
                        <textarea class="mr-separator text_pole textarea_compact autoSetHeight" spellcheck="false"></textarea>
                    </label>
                </details>
                <div class="mr-validation" role="status" aria-live="polite"></div>
            </div>
        `);

        $item.find('.mr-name').val(parser.name);
        $item.find('.mr-enabled').prop('checked', parser.enabled);
        $item.find('.mr-expand').prop('checked', parser.autoExpand);
        $item.find('.mr-show-hidden').prop('checked', parser.showHidden);
        $item.find('.mr-add-to-prompts').prop('checked', parser.addToPrompts);
        $item.find('.mr-max').val(parser.maxAdditions);
        $item.find('.mr-prefix').val(parser.prefix);
        $item.find('.mr-suffix').val(parser.suffix);
        $item.find('.mr-separator').val(parser.separator);
        $item.find('.mr-formatting-details > summary').text(`Formatting (${parser.name})`);

        $item.find('.mr-name').on('input', function () {
            parser.name = String($(this).val());
            $item.find('.mr-formatting-details > summary').text(`Formatting (${parser.name})`);
            saveSettings();
            refreshValidationIndicators();
            renderAllVisibleCustomBlocks();
        });

        $item.find('.mr-enabled').on('change', function () {
            parser.enabled = $(this).prop('checked');
            saveSettings();
            refreshValidationIndicators();
            renderAllVisibleCustomBlocks();
            scheduleChatScan();
        });

        $item.find('.mr-expand').on('change', function () {
            parser.autoExpand = $(this).prop('checked');
            saveSettings();
            renderAllVisibleCustomBlocks();
        });

        $item.find('.mr-show-hidden').on('change', function () {
            parser.showHidden = $(this).prop('checked');
            saveSettings();
            renderAllVisibleCustomBlocks();
        });

        $item.find('.mr-add-to-prompts').on('change', function () {
            parser.addToPrompts = $(this).prop('checked');
            saveSettings();
        });

        $item.find('.mr-max').on('input', function () {
            parser.maxAdditions = normalizeMaxAdditions($(this).val());
            saveSettings();
        });

        const onTagInput = () => {
            saveSettings();
            refreshValidationIndicators();
            renderAllVisibleCustomBlocks();
            scheduleChatScan();
        };

        $item.find('.mr-prefix').on('input', function () {
            parser.prefix = String($(this).val());
            onTagInput();
        });
        $item.find('.mr-suffix').on('input', function () {
            parser.suffix = String($(this).val());
            onTagInput();
        });
        $item.find('.mr-separator').on('input', function () {
            parser.separator = String($(this).val());
            saveSettings();
        });

        $item.find('.mr-delete').on('click', () => {
            if (!confirm(`Delete parser "${parser.name}"? Stored blocks are preserved but will no longer be shown or injected.`)) return;
            settings.parsers.splice(index, 1);
            saveSettings();
            renderParsers();
            renderAllVisibleCustomBlocks();
        });

        $list.append($item);
    });

    refreshValidationIndicators();
}

function injectUI() {
    if ($('#more_reasoning_settings').length) return true;

    const $target = $('#reasoning_add_to_prompts').closest('.flex-container').parent();
    if (!$target.length) return false;

    $target.append(`
        <section id="more_reasoning_settings" class="more-reasoning-settings-container" aria-labelledby="more_reasoning_settings_title">
            <h4 id="more_reasoning_settings_title" class="standoutHeader">More Reasoning Parsers</h4>
            <div id="more_reasoning_parsers_list"></div>
            <div class="more-reasoning-actions">
                <div id="more_reasoning_add_parser" class="menu_button more-reasoning-add-btn fa-solid fa-plus-circle" title="Add new parser"></div>
                <span>Add New Parser</span>
            </div>
        </section>
    `);

    $('#more_reasoning_add_parser').on('click', () => {
        settings.parsers.push({
            ...PARSER_DEFAULTS,
            id: createParserId(),
            name: 'New Parser',
            prefix: '',
            suffix: '',
            separator: '\n\n',
        });
        saveSettings();
        renderParsers();
    });

    renderParsers();
    return true;
}

function patchReasoningProcess() {
    if (ReasoningHandler.prototype[PROCESS_PATCH_FLAG]) return;

    const originalProcess = ReasoningHandler.prototype.process;
    Object.defineProperty(ReasoningHandler.prototype, PROCESS_PATCH_FLAG, {
        value: true,
        configurable: false,
        enumerable: false,
        writable: false,
    });

    ReasoningHandler.prototype.process = async function (messageId, mesChanged, promptReasoning) {
        let customChanged = false;
        try {
            customChanged = parseCustomReasoning(Number(messageId));
        } catch (error) {
            console.error(`[${MODULE_NAME}] Failed to parse custom reasoning for message ${messageId}:`, error);
        }

        const result = await originalProcess.call(this, messageId, Boolean(mesChanged || customChanged), promptReasoning);

        if (customChanged || chat[messageId]?.extra?.reasoning_blocks?.length) {
            renderCustomBlocks(Number(messageId));
        }
        return result;
    };
}

async function handleMessageEvent(messageId) {
    const id = Number(messageId);
    if (Number.isNaN(id) || !chat[id]) return;

    const changed = parseCustomReasoning(id);
    if (changed) {
        syncMesToSwipe(id);
        saveChatDebounced();
        renderMessageText(id);
    }
    renderCustomBlocks(id);
}

function beginGeneration(type) {
    if (type !== 'continue' || !chat.length) {
        generationState = { type: String(type ?? ''), messageId: -1, baseClean: '', baseBlocks: [], continuingBlockIndex: -1 };
        return;
    }

    const messageId = chat.length - 1;
    const message = chat[messageId];
    const baseBlocks = clone(Array.isArray(message?.extra?.reasoning_blocks) ? message.extra.reasoning_blocks : []);
    let continuingBlockIndex = -1;

    for (let i = baseBlocks.length - 1; i >= 0; i--) {
        if (baseBlocks[i]?.incomplete && getPromptEligibleParser(baseBlocks[i].parserId)) {
            continuingBlockIndex = i;
            break;
        }
    }

    generationState = {
        type: 'continue',
        messageId,
        baseClean: String(message?.mes ?? ''),
        baseBlocks,
        continuingBlockIndex,
    };
}

function endGeneration() {
    generationState = null;
}

/**
 * SillyTavern generation interceptor. It operates on the exact post-processed
 * coreChat supplied by ST, so swipes, tool-call system messages and future core
 * history filtering remain aligned automatically.
 */
globalThis[GENERATE_INTERCEPTOR_KEY] = async function (coreChat, _contextSize, _abort, type) {
    if (!settings) loadSettings();
    if (!Array.isArray(coreChat) || !coreChat.length || !settings?.parsers?.length) return;

    const skipMessage = item => Boolean(
        item?.is_user
        || item?.is_system
        || (selected_group && item?.name !== name2),
    );
    const selected = selectPromptBlocks(coreChat, settings.parsers, skipMessage);
    if (!selected.size) return;

    const lastMessageIndex = coreChat.length - 1;
    for (let messageIndex = 0; messageIndex < coreChat.length; messageIndex++) {
        const item = coreChat[messageIndex];
        if (skipMessage(item, messageIndex)) continue;

        const injection = buildPromptInjection(
            item,
            messageIndex,
            selected,
            settings.parsers,
            substituteParams,
            { type, lastMessageIndex },
        );
        if (injection) {
            // Native reasoning, if present, is already in item.mes at this point.
            // Prepending here avoids brittle reconstruction of ST's regex/file/title
            // transformed content while keeping the operation fully ephemeral.
            item.mes = injection + item.mes;
        }
    }
};

function init() {
    if (initialized) return;
    initialized = true;

    loadSettings();
    patchReasoningProcess();

    if (!injectUI()) {
        // APP_READY should normally have the target. A short observer makes the
        // settings panel robust to delayed/rebuilt settings DOM without polling.
        const observer = new MutationObserver(() => {
            if (injectUI()) observer.disconnect();
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    scanChatForRawTags();
    renderAllVisibleCustomBlocks();
    console.info(`[${MODULE_NAME}] Initialized with ${settings.parsers.length} parser(s).`);
}

$(document).on('click', '.more-reasoning-details .mr_mes_reasoning_edit', function (event) {
    event.preventDefault();
    event.stopPropagation();

    const details = $(this).closest('.more-reasoning-details');
    const messageId = Number(details.closest('.mes').attr('mesid'));
    const blockIndex = Number(details.attr('data-block-index'));
    const parserId = details.attr('data-parser-id');
    const block = chat[messageId]?.extra?.reasoning_blocks?.[blockIndex];
    if (!block || block.parserId !== parserId || details.find('.mr_reasoning_edit_textarea').length) return;

    const textarea = document.createElement('textarea');
    textarea.className = 'reasoning_edit_textarea mr_reasoning_edit_textarea';
    textarea.value = String(block.content ?? '');
    details.find('.mr_mes_reasoning').before(textarea);
    details.find('.mr_mes_reasoning').hide();
    details.find('.mr_mes_reasoning_edit').prop('hidden', true);
    details.find('.mr_mes_reasoning_edit_done, .mr_mes_reasoning_edit_cancel').prop('hidden', false);
    details.prop('open', true);

    if (!CSS.supports('field-sizing', 'content')) {
        const resetHeight = () => {
            textarea.style.height = '0px';
            textarea.style.height = `${textarea.scrollHeight}px`;
        };
        textarea.addEventListener('input', resetHeight);
        requestAnimationFrame(resetHeight);
    }
    textarea.focus();
});

$(document).on('click', '.more-reasoning-details .mr_mes_reasoning_edit_cancel', function (event) {
    event.preventDefault();
    event.stopPropagation();
    const details = $(this).closest('.more-reasoning-details');
    details.find('.mr_reasoning_edit_textarea').remove();
    details.find('.mr_mes_reasoning').show();
    details.find('.mr_mes_reasoning_edit').prop('hidden', false);
    details.find('.mr_mes_reasoning_edit_done, .mr_mes_reasoning_edit_cancel').prop('hidden', true);
});

$(document).on('click', '.more-reasoning-details .mr_mes_reasoning_edit_done', async function (event) {
    event.preventDefault();
    event.stopPropagation();

    const details = $(this).closest('.more-reasoning-details');
    const messageId = Number(details.closest('.mes').attr('mesid'));
    const blockIndex = Number(details.attr('data-block-index'));
    const parserId = details.attr('data-parser-id');
    const message = chat[messageId];
    const block = message?.extra?.reasoning_blocks?.[blockIndex];
    if (!message || !block || block.parserId !== parserId) return;

    const newContent = String(details.find('.mr_reasoning_edit_textarea').val() ?? '');
    if (block.content !== newContent) {
        block.content = newContent;
        block.expandedContent = substituteParams(newContent);
        syncMesToSwipe(messageId);
        saveChatDebounced();
        await eventSource.emit(event_types.MESSAGE_UPDATED, messageId);
    }
    renderCustomBlocks(messageId);
});

// Prevent action buttons inside <summary> from toggling the details element.
$(document).on('click', '.mr_mes_reasoning_actions > *', event => event.stopPropagation());

// SillyTavern also handles clicks on .mes_reasoning_header. Because our custom
// blocks reuse that native class for styling, explicitly own the interaction
// here so custom <details> always expand/collapse reliably.
$(document).on('click', '.more-reasoning-details .mes_reasoning_header', function (event) {
    event.preventDefault();
    event.stopPropagation();

    const details = $(this).closest('.more-reasoning-details');
    if (!details.length) return;

    details.prop('open', !details.prop('open'));
});

eventSource.on(event_types.APP_READY, init);
eventSource.on(event_types.CHAT_LOADED, () => {
    if (!settings) return;
    scanChatForRawTags();
    renderAllVisibleCustomBlocks();
});
eventSource.on(event_types.MORE_MESSAGES_LOADED, () => renderAllVisibleCustomBlocks());
eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, messageId => renderCustomBlocks(Number(messageId)));
eventSource.on(event_types.MESSAGE_RECEIVED, messageId => handleMessageEvent(messageId));
eventSource.on(event_types.MESSAGE_UPDATED, messageId => handleMessageEvent(messageId));
eventSource.on(event_types.MESSAGE_SWIPED, async messageId => {
    const id = Number(messageId);
    const message = chat[id];
    if (!message) return;

    // Overswipe regeneration creates an empty slot past the stored swipe array.
    // ST leaves the old swipe's extra object in place until generation begins,
    // so clear custom blocks here to prevent stale UI/state carry-over.
    if (typeof message.swipe_id === 'number'
        && Array.isArray(message.swipes)
        && message.swipe_id >= message.swipes.length) {
        if (message.extra) {
            delete message.extra.reasoning_blocks;
            delete message.extra.mr_has_custom_blocks;
        }
        renderCustomBlocks(id);
        return;
    }

    await handleMessageEvent(id);
});
eventSource.on(event_types.GENERATION_STARTED, type => beginGeneration(type));
eventSource.on(event_types.GENERATION_ENDED, endGeneration);
eventSource.on(event_types.GENERATION_STOPPED, endGeneration);
eventSource.on(event_types.CHAT_CHANGED, () => {
    clearTimeout(scanTimer);
    generationState = null;
});
