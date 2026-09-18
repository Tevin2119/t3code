# DeepSeek

DeepSeek is a chat API, not a coding agent. T3 Code uses it for **text generation
only** — commit messages, change request titles and bodies, branch names, and
thread titles. It cannot run a thread, so it does not appear in the model picker.

DeepSeek is off by default; enable it in **Settings → Providers**.

## Set up DeepSeek

There is nothing to install. Add your key from the
[DeepSeek platform](https://platform.deepseek.com) in provider settings, or export
`DEEPSEEK_API_KEY` on the environment and leave the field empty. A key in provider
settings wins over the environment variable and is stored in plain text in settings
on that environment.

Set **Base URL** only if you route DeepSeek through an OpenAI-compatible proxy. It
defaults to `https://api.deepseek.com`.

Once the key works, choose it as the writing model in **Settings → Source Control**
under **Text generation**.

## Models

| Model               | Use                                                   |
| ------------------- | ----------------------------------------------------- |
| `deepseek-chat`     | Default. Fast, and the one that returns strict JSON.  |
| `deepseek-reasoner` | Reasoning model. Slower, and worth it only for prose. |

These are the ids the DeepSeek API accepts. Names you may have seen in other tools
— `deepseek-v4-pro`, for instance — are that tool's own aliases; T3 Code maps a
reasoning-style alias onto `deepseek-reasoner` and anything else onto
`deepseek-chat`.

## Limits

DeepSeek bills per token against your platform balance, not a subscription. If a
request fails with an insufficient balance or rate limit, T3 Code reports it and
the generated text is skipped — the commit or change request still goes through
with whatever you typed.
