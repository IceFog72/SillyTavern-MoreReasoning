# MoreReasoning

A SillyTavern extension that expands the built-in reasoning system to support **multiple independent reasoning parsers** — for example `<think>`, `<plan>`, `<reflection>`, or any custom tag pair you define.

## What It Does

SillyTavern's native reasoning feature handles a single reasoning block per message (typically `<think>...`). MoreReasoning lets you:

- **Define multiple parsers** — each with its own prefix/suffix tags (e.g. `<think>`/`, `<plan>`/`</plan>`)
- **Control prompt injection per parser** — set how many of the most recent blocks each parser sends to the model (0 = never send, 1+ = send last N)
- **Auto-parse** — automatically detect and extract reasoning blocks from streamed or historical messages
- **Auto-expand** — choose which parsers' blocks open by default in the chat UI
- **Manage everything from the Settings panel** — add, edit, and delete parsers without touching code

## How It Works

1. **Extraction** — When a message is received (streaming or loaded from history), the extension scans for configured tag pairs and stores the content in `message.extra.reasoning_blocks`.
2. **Display** — Raw tags are hidden from the chat bubble. Each block appears as a collapsible `<details>` panel styled to match SillyTavern's native reasoning UI.
3. **Prompt filtering** — During prompt construction, blocks are kept or stripped based on each parser's "Max" setting, counting backwards from the newest message. Tags always remain in `message.mes` so the chat history stays intact.

## Configuration

Open **Settings → Reasoning** and scroll to the **More Reasoning Parsers** section.

| Setting | Description |
|---------|-------------|
| **Name** | Display label for the parser |
| **Prefix** | Opening tag (e.g. `<think>`) |
| **Suffix** | Closing tag (e.g. `</think>`) |
| **Separator** | Text inserted between reasoning and response when building prompts |
| **Max** | Number of most-recent blocks to include in prompts (0 = exclude all) |
| **Auto-Parse** | Automatically detect this parser's tags in messages |
| **Auto-Expand** | Open this parser's reasoning blocks by default |
| **Add to Prompts** | Whether this parser's blocks are eligible for prompt injection |
| **Show Hidden** | Show reasoning time/duration even when content is hidden |

Two parsers are included by default:
- **Thought** (`<think>` / `</think>`) — Max 0 (not sent to prompt)
- **Plan** (`<plan>` / `</plan>`) — Max 1 (last block sent to prompt)

## Default Parsers

```
Thought:  <think> ...  ๛  (Max: 0 — parsed but excluded from prompts)
Plan:     <plan> ... </plan>  (Max: 1 — last block included in prompts)
```

## Requirements

- SillyTavern

## License

See the repository for license details.

## Feedback

Join my Discord: [https://discord.gg/2tJcWeMjFQ](https://discord.gg/2tJcWeMjFQ)
Or find me on the official SillyTavern Discord server.

Support me:
[Patreon](https://www.patreon.com/cw/IceFog72)
