# Privacy and Network Boundaries

**Updated:** 2026-07-15

Adversaria is local-first, not network-free. Meeting audio, transcript text, and
prompts remain on the device when the default local transcription and local
meeting-model profiles are selected. The app does not silently fall back to a
cloud model.

## Connections the app can make

| Boundary | When | Data sent | Control |
|---|---|---|---|
| Formspree registration | First-run registration and queued retry | Name, email, source, app version, platform, consent timestamp/version | Required for beta registration; failure queues locally and does not block local setup |
| Hugging Face model download | User starts a local Whisper or meeting-model download | Repository/revision request and normal network metadata; no meeting or hardware inventory | Explicit setup/download action; exact revisions are pinned and meeting-model weights are verified |
| Rapid-MLX loopback service | Local summarization | Transcript/prompt over authenticated `127.0.0.1` only | App-owned; random per-launch credential; telemetry, prompt-cache persistence, KV checkpoints, and non-loopback binding are disabled |
| Update endpoint | Packaged app startup and user installation | App/update request metadata to the configured GitHub release channel | Signed beta/stable manifests; installation remains user-confirmed |
| Google/Microsoft calendar | User configures and connects an account | OAuth requests and read-only event queries | Optional, explicit, disconnectable; tokens use the OS keychain |
| Cloud summarization | User chooses BYOK/cloud and accepts its disclosure | Transcript text, prompt, model name, and request metadata to the configured HTTPS provider | Optional and explicit; never automatic fallback |
| Cloud transcription | User chooses cloud transcription | Compressed meeting audio chunks and request metadata to the configured provider | Optional and explicit; UI labels loss of local-only processing |
| Feedback email | User selects Send Feedback | The user’s composed message opens in their mail client | Nothing is sent until the user sends the email |

Local backup, meeting export, second-brain export, and redacted diagnostic export
write only to a destination the user chooses. There is no analytics SDK,
automatic crash-report upload, advertising identifier, or meeting-content
telemetry.

## Local sensitive-data lifecycle

- In-progress and pending native captures use independently encrypted,
  authenticated chunks. The recording key is separate from the SQLCipher key
  and lives in the OS keychain.
- Processing decrypts to a private temporary WAV one record at a time. Successful
  processing removes the encrypted capture and temporary plaintext; failures
  keep the encrypted asset visibly retryable.
- The meeting database is SQLCipher-encrypted by default. User-created plaintext
  backups and exports are clearly labeled and remain the user’s responsibility.
- Diagnostic logs rotate locally, redact contact fields and raw paths, and do
  not accept transcript or meeting content. Export is deliberate; upload is not
  implemented.

## Build and release boundary

Release builds require an `ADVERSARIA_FORMSPREE_ENDPOINT` matching the production
`https://formspree.io/f/...` endpoint. A packaging-smoke override exists but must
not be published. The actual public beta remains blocked until the notarized,
stapled artifact passes clean-machine acceptance.
