# Install on another machine

The public installer already configures local paths, agent credentials, skills and
background services for each computer. Do not copy another host's data or service
files to start a new installation.

## Guided installation

Follow the [README installation steps](../README.md#quick-start). Choose **Host the
dashboard here** to configure a port, data folder and access method. The optional
login service uses launchd on macOS and `systemd --user` on Linux. Choose **Connect
this computer's agents** on another computer, then enter the dashboard URL and a
one-time connection code.

The CLI fills the installed skill with that computer's command path, dashboard
address and agent identity. `agentic-dashboard skills install` installs it later.
Each agent uses its own registered key; never copy the owner's key into a skill.

For a source checkout, use `bun install --frozen-lockfile`, `bun run setup`,
copy `.env.example` to `.env`, edit it, then `bun start`. See
[deploy.md](deploy.md) for Docker, reverse proxies and the standalone binary.

## Optional narration

Set `GEMINI_API_KEY` in the server's environment. No Keychain service name or macOS
account is required. The key route uses `gemini-3.8-flash` for scripts and
`gemini-3.8-flash-tts` for speech. New research, work reports, notes and social
records get read-aloud audio by default; Settings > Automatic audio or
`NARRATION_RECORD_AUTO=off` disables this.

For Vertex AI, configure Application Default Credentials and set:

```sh
NARRATION_TTS_PROVIDER=vertex
NARRATION_VERTEX_PROJECT=your-project-id
```

The Vertex script route uses `gemini-4-argon`; the key remains its second route.
`NARRATION_SCRIPT_MODEL` and `NARRATION_KEY_SCRIPT_MODEL` configure these separately.
`NARRATION_CONCURRENCY` defaults to 2; the same record never runs twice at once.

On macOS, audio uses the system `afconvert`. On other systems install `ffmpeg` on
the server's PATH for AAC/M4A encoding. If neither tool is installed, or encoding
fails, the WAV remains playable. No audio tool is required to save records.

## Optional automatic title fill

Set `AI_FILL_COMMAND` to a command that reads a prompt from stdin and prints JSON.
`AI_FILL_SOURCES` selects agent names whose saves are filled too. There is no
dependency on a particular model CLI; without the setting, title fill is off.
When a new record needs title fill, automatic audio waits until it settles.

## Confirm the installation

Save a record using your connected agent, check the successful response's
`record.id`, and read it back with the agent CLI. Check the Digest tab after an
authorized digest upload. Keep the data folder private and back it up as described
in [storage.md](storage.md).
