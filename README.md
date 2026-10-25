# Word Shake

A word-dice game for friends and family. Everyone at a table gets the same board and races the
same timer, tracing words with a finger or mouse. When time runs out, everyone sees everyone's
words and scores.

- **Tables:** start a table and share the link (or the code, like `DEHE78`). Separate groups can play at the same time.
- **Settings:** timer length (presets or custom), 4×4 or 5×5 board, shortest word (3 or 4 letters),
  whether words two players both found cancel out, and whether words are checked against the dictionary.
- **Dictionary:** made-up words are rejected while you trace (ENABLE word list, public domain).
  After each round you see the words nobody found, and anyone can tap a word to challenge it.
- **Scoring:** 3–4 letters = 1, 5 = 2, 6 = 3, 7 = 5, 8+ = 11. Qu counts as two letters.

## How it's built

A static site (GitHub Pages) plus Firebase Firestore for live, shared game state. Players are
signed in anonymously, so nobody needs an account.

| File | What it is |
| --- | --- |
| `index.html` | Page layout and styles |
| `app.js` | Game logic |
| `firebase-config.js` | Your Firebase settings (fill these in once) |
| `firestore.rules` | Database security rules to paste into Firebase |
| `words.txt` | The word list |

Until `firebase-config.js` is filled in, the game runs solo on one device, which is handy for testing.

## One-time setup: Firebase (about 10 minutes, free)

1. Go to <https://console.firebase.google.com>, sign in with a Google account, and click **Create a project**.
   Name it `word-shake`. You can turn Google Analytics off.
2. **Turn on anonymous sign-in:** in the left menu, open **Build → Authentication**, click **Get started**,
   choose **Anonymous** under Sign-in method, switch it on, and click **Save**.
3. **Create the database:** open **Build → Firestore Database**, click **Create database**, pick a location
   near you, and choose **Start in production mode**.
4. **Paste the security rules:** in Firestore, open the **Rules** tab, replace everything there with the
   contents of `firestore.rules`, and click **Publish**.
5. **Register the web app:** click the gear icon next to *Project Overview* → **Project settings**. Under
   *Your apps*, click the web icon (`</>`), name it `Word Shake`, and leave *Firebase Hosting* unchecked.
   Firebase shows a block of code containing `const firebaseConfig = { ... }`. Copy those six values into
   `firebase-config.js`.
6. **Allow your site's address:** in **Authentication → Settings → Authorized domains**, click
   **Add domain** and add `schrjacob.github.io`.

The values in `firebase-config.js` are meant to be public. The Firestore rules are what protect the data.

The free (Spark) plan allows 50,000 reads and 20,000 writes a day, which covers many family game
nights. A round with 6 players uses roughly a few hundred of each.

## Publishing on GitHub Pages

```bash
gh repo create word-shake --public --source . --push
gh api -X POST repos/schrjacob/word-shake/pages -f "source[branch]=main" -f "source[path]=/"
```

After a minute or two the game is live at <https://schrjacob.github.io/word-shake/>.
To publish changes later, commit and push; Pages updates on its own.

## Testing on your computer

```bash
python -m http.server 8780
```

Then open <http://localhost:8780>. (Opening `index.html` directly from the file system won't work,
because browsers block the script and word list from loading that way.)
To test multiplayer locally, also add `localhost` to Firebase's authorized domains (it's usually there by default).
