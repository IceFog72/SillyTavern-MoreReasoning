# MoreReasoning

A SillyTavern extension that adds **multiple independent reasoning parsers** alongside SillyTavern's native reasoning support. Define tag pairs such as `<think>...</think>`, `<plan>...</plan>`, `<reflection>...</reflection>`, or your own formats.

## Features

- Multiple independent custom reasoning parsers.
- Streaming and historical-message extraction.
- Per-parser prompt injection limits using the **most recent N blocks**.
- Per-parser Auto-Parse, Auto-Expand, Add to Prompts, and Show Hidden controls.
- Editable custom reasoning blocks in chat.
- Stable parser IDs so changing a parser name/tag does not orphan stored blocks.
- Parser validation for missing, duplicate, or overlapping prefixes.
- Swipe-safe prompt injection using SillyTavern's generation interceptor.
- Custom reasoning state is independent from SillyTavern's native `ReasoningHandler` state.

## Configuration

Open **Settings → Reasoning** and find **More Reasoning Parsers**.

| Setting | Description |
|---|---|
| **Name** | Display label for the parser. |
| **Prefix** | Opening tag, for example `<plan>`. |
| **Suffix** | Closing tag, for example `</plan>`. |
| **Separator** | Text placed after an injected reasoning block before prompt message content. |
| **Max** | Number of the most recent blocks for this parser to include in prompts. `0` disables prompt injection for that parser. |
| **Auto-Parse** | Detect and extract this parser's tags from assistant messages. |
| **Auto-Expand** | Open non-empty blocks by default in chat. |
| **Add to Prompts** | Allow stored blocks from this parser to be injected into generation prompts. |
| **Show Hidden** | Display empty/hidden blocks instead of suppressing them. |

Invalid or partially edited parsers stay saved but are disabled until their configuration becomes valid.

## Defaults

- **Thought**: `<think>...</think>`, Max `0`.
- **Plan**: `<plan>...</plan>`, Max `1`.

## Architecture

Custom blocks are stored in:

```text
message.extra.reasoning_blocks
```

The visible `message.mes` remains free of custom reasoning tags. MoreReasoning does **not** create placeholder native reasoning or overwrite SillyTavern's `extra.reasoning` fields.

Prompt injection happens through SillyTavern's `generate_interceptor` using the exact `coreChat` produced by SillyTavern. This keeps custom reasoning aligned with swipe generation, tool-call history filtering, group chats, and other core prompt preprocessing.

## Compatibility

- SillyTavern **1.18.0 or newer**.

## Development

The parsing and prompt-selection logic is isolated in `core.js` and covered by Node tests:

```bash
npm test
```

## License

GNU GPL v3. See `LICENSE`.

## Feedback

Discord: https://discord.gg/2tJcWeMjFQ

Support: https://www.patreon.com/cw/IceFog72
