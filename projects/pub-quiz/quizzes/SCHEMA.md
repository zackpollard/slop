# Quiz pack format

A **pack** is one complete quiz night: metadata, an ordered list of rounds, and
an optional tie-breaker. Everything the app knows about a quiz comes from a pack,
so writing a new quiz means writing a new pack — no code changes.

There are two ways to give the app a pack:

1. **Built in** — a JavaScript module in this folder that `export default`s the
   object, registered in `js/packs.js`. This is how the quizzes that ship with
   the site work.
2. **Imported** — plain JSON, loaded through **Import a pack** on the setup
   screen (file picker, drag the JSON in, or paste it). Imported packs live in
   the browser's `localStorage` and appear alongside the built-in ones.

Both go through the same validator, so the shape below is identical either way.
The quickest way to write one is to press **Export this pack** on the setup
screen, edit the JSON, and import it back.

## Shape

```jsonc
{
  "id": "my-quiz-2026-03",        // optional, slugified; generated if missing
  "name": "The March Quiz",       // required
  "description": "Six rounds for a Tuesday.",
  "author": "Your name",
  "createdOn": "2026-03-14",
  "version": 1,
  "tags": ["pub", "general"],

  "rounds": [                     // required, at least one
    {
      "id": "general-knowledge",  // optional; derived from the name if missing
      "name": "General Knowledge",// required
      "icon": "🌍",               // optional emoji; guessed from the name if missing
      "intro": "We start gently. One point each, no conferring.",

      "questions": [              // required, at least one
        {
          "question": "Which English city is served by Ringway Airport?",
          "answer": "Manchester",
          "acceptable": ["Manchester Airport"],
          "difficulty": "easy",   // "easy" | "medium" | "hard" (default "medium")
          "topic": "Geography",
          "funFact": "It kept the Ringway name until 1975.",
          "melody": "",           // see "Name that tune" below
          "spokenQuestion": "",   // optional: what the voice says, if different
          "spokenAnswer": "",     // optional: e.g. a phonetic spelling
          "source": {
            "name": "Manchester Airport",
            "url": "https://www.manchesterairport.co.uk/"
          }
        }
      ]
    }
  ],

  "tiebreaker": {                 // optional; used when the top of the table ties
    "question": "How many miles of the Great Wall of China survive?",
    "answer": 13171,              // must be a number — closest guess wins
    "unit": "miles",
    "funFact": "The 2012 survey put the whole structure at 13,171 miles.",
    "source": { "name": "Example", "url": "https://example.org/" }
  }
}
```

### Field notes

| Field | Notes |
|---|---|
| `answer` | Keep it short and speakable. The host reads it aloud. |
| `acceptable` | Alternatives the host should also mark right — surnames, alternative spellings, abbreviations. Read out after the answer. |
| `difficulty` | Only affects the chip on screen and the mix you choose when writing. |
| `topic` | Short subject tag shown next to the question. |
| `funFact` | One sentence, read aloud on the reveal. Keep it under about 25 words. |
| `source` | Where the answer was checked. Shown on the reveal and printed on the host's answer key. Strongly recommended — a quiz is only as good as its sources. |
| `spokenQuestion` / `spokenAnswer` | Use when the written and spoken forms should differ: awkward names, symbols, numbers a synthesiser mangles. |
| `clip` | Turns the question into a "name that tune" that plays a real record — see below. |
| `melody` | Turns the question into a "name that tune" that plays a synthesised public-domain theme — see below. |

### Name that tune, with a real record

Give a question a `clip` and it plays a thirty-second preview of the actual
recording, streamed from Apple's preview service at the moment you press play:

```jsonc
"clip": {
  "source": "itunes",
  "trackId": 1488408568,
  "previewUrl": "https://audio-ssl.itunes.apple.com/.../mzaf_….m4a",
  "artist": "The Weeknd",
  "title": "Blinding Lights",
  "year": 2019,
  "storeUrl": "https://music.apple.com/gb/album/…?i=1488408568",
  "start": 0,        // optional: seconds into the preview to begin
  "seconds": 0       // optional: stop after this many seconds (0 = the lot)
}
```

Nothing is downloaded or re-hosted — the pack stores only the track's id and its
preview URL, and the audio comes from Apple when it plays. `artist`, `title` and
`year` are **only** shown after the answer is revealed; before that the player is
deliberately anonymous, because naming the track would be the answer.

Because preview URLs go stale, the player falls back to Apple's lookup API using
`trackId` and refreshes the URL by itself, so an old pack keeps working.

**Finding the numbers.** Apple's search API is free and needs no key:

```bash
curl -sS "https://itunes.apple.com/search?term=SONG+ARTIST&entity=song&limit=5&country=GB"
```

Take `trackId`, `previewUrl`, `trackName`, `artistName` and `trackViewUrl` from
the result. Check you have the *original* recording — the store is full of
karaoke versions, tribute acts and re-recordings that will not fool anybody.

Two things worth knowing when you write these questions:

- **The preview is usually the chorus.** If the chorus sings the song's title,
  do not ask "name this song" — ask which artist recorded it instead.
- **It needs the internet on the night.** The setup screen warns you when a pack
  contains streamed clips. Play one during your sound check.

To use your own audio file instead, put it beside the project and use:

```jsonc
"clip": { "source": "url", "src": "clips/my-file.mp3", "credit": "Where it came from" }
```

### Name that tune, synthesised

Set `melody` to one of the built-in public domain tunes and the question gets a
**Play the tune** button; the melody is synthesised in the browser, so there are
no audio files to host and nothing to license.

`beethoven5`, `odeToJoy`, `furElise`, `eineKleineNachtmusik`, `blueDanube`,
`williamTell`, `mountainKing`, `canonInD`, `twinkle`, `greensleeves`,
`ruleBritannia`, `swanLake`

All are pre-1900 compositions, synthesised in the browser — so they need no
files and no internet, which makes them the safe choice for a pub with no wifi.
If you add more, add them to `MELODIES` in `js/audio.js` and keep them public
domain.

## Writing a good round

- Ten questions is the usual round length, but any number works, and rounds do
  not have to be the same length.
- A mix of three easy, four medium and three hard reads well: open with an easy
  one, put the hardest at eight and nine, finish on something everyone gets.
- Every question is **read aloud**. Avoid symbols, brackets, "which of the
  following", and anything that only works written down.
- Avoid answers that go stale — current champions, record holders, "the newest".
  If you must, anchor the question with a date: "As of 2025, …".
- Check your facts against a real source and put the URL in `source`. The app
  shows it on the reveal, which settles arguments on the spot.

## Adding a pack to the site itself

1. Save it as `projects/pub-quiz/quizzes/<your-pack>.js`:

   ```js
   export default { /* the object above */ };
   ```

2. Import and register it in `projects/pub-quiz/js/packs.js`:

   ```js
   import yourPack from '../quizzes/your-pack.js';

   export const BUILT_IN_PACKS = [slopClassic01, yourPack];
   ```

That is the whole job — it shows up in the picker on the next load.
